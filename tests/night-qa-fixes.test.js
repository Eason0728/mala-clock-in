// 夜間 QA（第二輪）修正：中-1、中-3、低-1、低-2、低-3、低-5、低-6、低-7。測試資料一律假名，不連網。
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const SRC_DIR = path.join(__dirname, '..', 'apps-script');
const read = (f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const deny = (w) => function () { throw new Error('禁止連線：' + w); };
const deq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function fakeSheet(rows, headersIn) {
  const H = headersIn || [...new Set(rows.flatMap((o) => Object.keys(o)))];
  const grid = () => [H].concat(rows.map((o) => H.map((h) => (h in o ? o[h] : ''))));
  const sh = {
    rows, H,
    getLastRow: () => rows.length + 1, getLastColumn: () => H.length, getMaxColumns: () => H.length,
    getDataRange: () => ({ getValues: () => grid() }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => grid().slice(r - 1, r - 1 + (nr || 1)).map((row) => row.slice(c - 1, c - 1 + (nc || 1))),
      setValue: (v) => { if (r === 1) { H[c - 1] = v; return; } rows[r - 2][H[c - 1]] = v; },
      setValues: (vals) => { vals.forEach((row, k) => { if (!rows[r - 2 + k]) rows[r - 2 + k] = {}; row.forEach((v, j) => { rows[r - 2 + k][H[c - 1 + j]] = v; }); }); },
      setNumberFormat: function () { return this; },
    }),
    appendRow: (vals) => { const o = {}; vals.forEach((v, i) => { o[H[i]] = v; }); rows.push(o); },
  };
  return sh;
}
const fakeSS = (sheets) => ({ getSheetByName: (nm) => sheets[nm] || null, getId: () => 'SS_LOCAL' });
function sandbox(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cm = {};
  const cache = { m: cm, get: (k) => (k in cm ? cm[k] : null), put: (k, v) => { cm[k] = String(v); }, remove: (k) => { delete cm[k]; }, removeAll: (ks) => ks.forEach((k) => delete cm[k]) };
  const logs = [];
  const sb = {
    console, JSON, Math, String, Number, Boolean, Array, Object, Date, RegExp, Error, isNaN, isFinite, parseInt, parseFloat,
    UrlFetchApp: { fetch: deny('UrlFetchApp.fetch') }, fetch: deny('fetch'), require: deny('require'),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => cache },
    LockService: opts.lockService || { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {}, openById: (id) => { if (opts.openById) return opts.openById(id); throw new Error('openById 未設定：' + id); } },
    Utilities: {
      formatDate: (d, tz, fmt) => { const t = new Date(d.getTime() + 8 * 3600000); const p = (x) => ('0' + x).slice(-2);
        return fmt.replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1)).replace('dd', p(t.getUTCDate())).replace('HH', p(t.getUTCHours())).replace('mm', p(t.getUTCMinutes())); },
      computeHmacSha256Signature: (m, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(m)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, base64Decode: () => [],
    },
    ScriptApp: { getProjectTriggers: () => [] }, DriveApp: {}, Logger: { log: (m) => { logs.push(String(m)); } },
    CONFIG: Object.assign({ LINE_CHANNEL_ID: '0000000000', ADMIN_KEY: 'ADMIN_TEST' }, opts.config || {}),
  };
  Object.assign(sb, opts.globals || {});
  const ctx = vm.createContext(sb);
  (opts.files || []).forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
  (opts.snippets || []).forEach((s) => vm.runInContext(s, ctx));
  return { ctx, props, cache, logs, run: (code) => vm.runInContext(code, ctx), def: (nm, fn) => { ctx[nm] = fn; } };
}
const CODE = read('Code.gs');

// ───────── 中-3 ─────────
{
  const mk = (rosterRows, tables) => {
    const rosterSheet = fakeSheet(rosterRows, ['emp_id', 'name', 'active']);
    const srcSS = fakeSS(Object.assign({ roster: rosterSheet, events: fakeSheet([], ['emp_id', 'ts']), approved: fakeSheet([], ['date', 'emp_id', 'name', 'hours', 'entered_at']) }, tables));
    const sb = sandbox({ files: ['Mirror.gs'], openById: () => srcSS });
    sb.def('normCellTs', (v) => String(v)); sb.def('normCellDate', (v) => String(v));
    return sb;
  };
  const tgt = fakeSS({});
  ok('中-3 來源名冊有非前綴工號的同名列 → 該姓名剔除（leave 不抄），警告寫進 plan.warnings；只影響同名的人', () => {
    const sb = mk(
      [{ emp_id: 'HQ-01', name: '甲假名', active: true }, { emp_id: 'CF02', name: '甲假名', active: true }, { emp_id: 'HQ-02', name: '乙假名', active: true }],
      { leave: fakeSheet([
        { 日期: '2026-11-03', 姓名: '甲假名', 假別: '特休', 時數: 8 },
        { 日期: '2026-11-05', 姓名: '乙假名', 假別: '事假', 時數: 4 },
      ], ['日期', '姓名', '假別', '時數']) });
    const plan = sb.run('mirrorPlan_')([{ code: 'cf', ss_id: 'X', emp_prefix: 'HQ-' }], tgt);
    const added = plan.tables.leave.add.cf.map((r) => r.join('|'));
    assert.strictEqual(added.length, 1, JSON.stringify(added));
    assert(added[0].indexOf('乙假名') >= 0);
    assert(plan.warnings.some((w) => w.indexOf('甲假名') >= 0), JSON.stringify(plan.warnings));
  });
  ok('中-3 approved 工號空白＋同名衝突 → 不抄；有 HQ- 工號的列照抄', () => {
    const sb = mk(
      [{ emp_id: 'HQ-01', name: '甲假名', active: true }, { emp_id: 'CF02', name: '甲假名', active: true }],
      { approved: fakeSheet([
        { date: '2026-11-03', emp_id: 'HQ-01', name: '甲假名', hours: 8, entered_at: 'x' },
        { date: '2026-11-05', emp_id: '', name: '甲假名', hours: 8, entered_at: 'x' },
      ], ['date', 'emp_id', 'name', 'hours', 'entered_at']) });
    const plan = sb.run('mirrorPlan_')([{ code: 'cf', ss_id: 'X', emp_prefix: 'HQ-' }], tgt);
    const added = plan.tables.approved.add.cf;
    deq(added.map((r) => r[0]), ['2026-11-03']);
  });
  ok('中-3 沒有同名衝突時行為不變（空工號列靠姓名抄、無警告）', () => {
    const sb = mk([{ emp_id: 'HQ-01', name: '甲假名', active: true }, { emp_id: 'CF02', name: '丙假名', active: true }],
      { leave: fakeSheet([{ 日期: '2026-11-03', 姓名: '甲假名', 假別: '特休', 時數: 8 }], ['日期', '姓名', '假別', '時數']) });
    const plan = sb.run('mirrorPlan_')([{ code: 'cf', ss_id: 'X', emp_prefix: 'HQ-' }], tgt);
    assert.strictEqual(plan.tables.leave.add.cf.length, 1);
    assert(!plan.warnings.some((w) => w.indexOf('同名') >= 0));
  });
}

// ───────── 低-1 ─────────
{
  const mkLock = (acquire) => { const st = { waits: [], released: 0 };
    return { st, svc: { getScriptLock: () => ({ tryLock: () => acquire, waitLock: (ms) => { st.waits.push(ms); if (!acquire) throw new Error('timeout'); }, releaseLock: () => { st.released++; } }) } }; };
  const build = (acquire, lateApproved) => {
    const L = mkLock(acquire); const calls = [];
    const sb = sandbox({ lockService: L.svc, snippets: ['dailyMonthlyRebuild', 'handleRebuildMonth', 'refreshCurrentMonth'].map((f) => extract(CODE, f)) });
    sb.def('recheckPendingApprovalStatuses', () => { calls.push('recheck'); return { checked: 0, fixed: 0 }; });
    sb.def('rebuildMonth', (ym) => { calls.push('rebuild:' + ym); return 3; });
    sb.def('prevMonthLateApproved_', () => !!lateApproved);   // 2026-11-13 驗收 F5
    sb.def('currentYmTaipei', () => '2026-11'); sb.def('prevYm', () => '2026-10'); sb.def('todayTaipeiStr', () => '2026-11-10');
    sb.def('checkAdmin', () => true); sb.def('isMonthRefreshQuietHour', () => false); sb.def('nowTaipeiIso', () => '2026-11-10T10:00:00+08:00');
    return { sb, L, calls };
  };
  ok('低-1 dailyMonthlyRebuild 取 script lock（waitLock 30 秒），做完放鎖', () => {
    const t = build(true); t.sb.run('dailyMonthlyRebuild')();
    deq(t.L.st.waits, [30000]); assert.strictEqual(t.L.st.released, 1);
    deq(t.calls, ['recheck', 'rebuild:2026-11']);
  });
  ok('F5 dailyMonthlyRebuild 4 號以後有上月晚核定 → 連上月一起重算', () => {
    const t = build(true, true); t.sb.run('dailyMonthlyRebuild')();
    deq(t.calls, ['recheck', 'rebuild:2026-11', 'rebuild:2026-10']);
  });
  ok('低-1 dailyMonthlyRebuild 等不到鎖 → 記 Logger 後跳過，不重算、不丟例外', () => {
    const t = build(false); t.sb.run('dailyMonthlyRebuild')();
    deq(t.calls, []); assert(t.sb.logs.length >= 1);
  });
  ok('低-1 handleRebuildMonth 取同一把鎖；成功回 ok，等不到回 { ok:false, error:"busy" }', () => {
    const a = build(true); const r = a.sb.run('handleRebuildMonth')({ ym: '2026-11' });
    assert.strictEqual(r.ok, true); deq(a.L.st.waits, [30000]); assert.strictEqual(a.L.st.released, 1);
    const b = build(false); const r2 = b.sb.run('handleRebuildMonth')({ ym: '2026-11' });
    deq(r2, { ok: false, error: 'busy' }); deq(b.calls, []);
  });
  ok('低-1 refreshCurrentMonth 的 tryLock(0) 維持不變', () => {
    assert(/tryLock\(0\)/.test(extract(CODE, 'refreshCurrentMonth')));
  });
}

// ───────── 低-2 ─────────
{
  const HEAD = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'];
  const rows = [{ emp_id: 'E01', name: '假名一', key: 'k1', device_id: '', device_bound_at: '', active: true }];
  const sb = sandbox({ snippets: ['handleSyncRoster', 'readSheetAsObjects', 'findRosterByEmpId', 'stripRowIndex', 'sheetSafeText_', 'checkAdmin'].map((f) => extract(CODE, f)), globals: { ROSTER_HEADERS: HEAD } });
  sb.def('getSS', () => fakeSS({ roster: fakeSheet(rows, HEAD.slice()) })); sb.def('rosterLockTextCols_', () => {}); sb.def('genKey', () => 'NEWKEY');
  const sync = (emp) => sb.run('handleSyncRoster')({ admin_key: 'ADMIN_TEST', employees: [emp] });
  ok('低-2 既有列 active:"false"／"FALSE" → 停用', () => {
    sync({ emp_id: 'E01', name: '假名一', active: 'false' }); assert.strictEqual(rows[0].active, false);
    rows[0].active = true; sync({ emp_id: 'E01', name: '假名一', active: 'FALSE' }); assert.strictEqual(rows[0].active, false);
  });
  ok('低-2 active:"true"／true → 在職；沒帶 active 保留原值', () => {
    sync({ emp_id: 'E01', name: '假名一', active: 'true' }); assert.strictEqual(rows[0].active, true);
    sync({ emp_id: 'E01', name: '假名一', active: false }); assert.strictEqual(rows[0].active, false);
    sync({ emp_id: 'E01', name: '假名一', active: true }); assert.strictEqual(rows[0].active, true);
    sync({ emp_id: 'E01', name: '假名一' }); assert.strictEqual(rows[0].active, true);
  });
  ok('低-2 新增列 active:"false" → 以停用新增；沒帶 active → 在職', () => {
    sync({ emp_id: 'E02', name: '假名二', active: 'false' });
    assert.strictEqual(rows.filter((r) => r.emp_id === 'E02')[0].active, false);
    sync({ emp_id: 'E03', name: '假名三' });
    assert.strictEqual(rows.filter((r) => r.emp_id === 'E03')[0].active, true);
  });
}

// ───────── 低-3 ─────────
{
  const sb = sandbox({ files: ['SchedPub.gs'] });
  const clean = sb.run('schedPubClean_');
  const cells = (c, k) => Array.from({ length: k || 28 }, () => c);
  const body = {
    start: '2026-11-01', days: 28,
    shifts: [{ id: 'A', name: 'x'.repeat(2000), start: '15:00', end: '23:30', break_min: 30 }],
    rows: [
      { emp_id: 'E01', name: '假名一', cells: cells({ t: 'W', s: 'A' }) },
      { name: '沒工號', cells: cells({ t: 'W', s: 'A' }) },
      { emp_id: '', name: '空工號', cells: cells({ t: 'W', s: 'A' }) },
      { emp_id: 'E02', name: '假名二', cells: [{ t: 'ZZZ', l: 'abcdefgh' }, { t: 'L', l: '特休特休特休' }, { t: 'R' }, { t: 'H' }, { t: 'W', s: 'A' }, { t: '', l: '' }] },
    ],
  };
  const out = clean(body);
  ok('低-3 班別名截 20 字', () => { assert.strictEqual(out.shifts[0].name.length, 20); });
  ok('低-3 缺 emp_id（含空字串）的列略過，不存成 "undefined"；其他列保留，不整份退件', () => {
    assert(out, '不應整份退件');
    deq(out.rows.map((r) => r.emp_id), ['E01', 'E02']);
  });
  ok('低-3 cell.t 不在 R/H/W/L 的格子清成空格（位置不動）；cell.l 截 4 字', () => {
    const r = out.rows[1].cells;
    assert.strictEqual(r.length, 6, '格子是依日期的位置陣列，長度與位置不能變');
    deq(r.map((c) => c.t), ['', 'L', 'R', 'H', 'W', '']);   // 'ZZZ' 被清成空格
    assert.strictEqual(r[0].l, undefined);
    assert.strictEqual(r[1].l, '特休特休');
  });
  ok('低-3 合法資料不受影響（站別、備註等原有行為）', () => {
    assert.strictEqual(out.rows[0].cells.length, 28); assert.strictEqual(out.rows[0].cells[0].t, 'W'); assert.strictEqual(out.rows[0].cells[0].s, 'A');
  });
}

// ───────── 低-5、低-7（mgr_set_active）、低-7（解綁）、低-5（svc_set_active）─────────
{
  const U = 'Uxx_fake_line_user_9';
  const HEAD = ['emp_id', 'name', 'key', 'active', 'line_user_id', 'removed_at', 'removed_by'];
  const make = (acquire) => {
    const rows = [
      { emp_id: 'E01', name: '舊名字', key: 'k1', active: false, line_user_id: U, removed_at: 'x', removed_by: '店長假名' },
      { emp_id: 'E07', name: '假名復職', key: 'k7', active: true, line_user_id: U },
      { emp_id: 'E08', name: '離職乙', key: 'k8', active: false, line_user_id: 'Uxx_other' },
      { emp_id: 'E09', name: '在職丙', key: 'k9', active: true, line_user_id: 'Uxx_third' },
    ];
    const st = { tries: [], released: 0, forgot: [] };
    const sb = sandbox({
      files: ['Liff.gs'],
      lockService: { getScriptLock: () => ({ tryLock: (ms) => { st.tries.push(ms); return acquire !== false; }, waitLock: (ms) => { if (acquire === false) throw new Error('timeout'); }, releaseLock: () => { st.released++; } }) },
      snippets: ['handleMgrSetActive', 'readSheetAsObjects', 'findRosterByEmpId', 'setRosterCell', 'nowTaipeiIso'].map((f) => extract(CODE, f))
        .concat([extract(read('SvcStaff.gs'), 'handleSvcSetActive_')]),
    });
    sb.def('getSS', () => fakeSS({ roster: fakeSheet(rows, HEAD.slice()), managers: fakeSheet([{ name: '店長假名', key: 'MK', active: true }]) }));
    sb.def('findManagerByKey', (rs, k) => rs.filter((r) => r.key === k)[0] || null);
    sb.def('actingName_', () => '店長假名'); sb.def('ensureRosterHeaders', () => {});
    sb.def('lineHubForget_', (u) => { st.forgot.push(u); });
    sb.def('liffClearLineOkCache_', () => {}); sb.def('logLiffBind_', () => {});
    sb.def('SVC_BY_MAX', 40); sb.def('svcAuth_', () => null); sb.def('svcEnsureHeaders_', () => {});
    sb.def('svcIsTrue_', (v) => v === true || String(v).toLowerCase() === 'true');
    sb.def('svcFormulaLike_', () => false);
    sb.def('svcFail_', (e, m) => ({ ok: false, error: e, message: m }));
    return { sb, rows, st };
  };
  const set = (t, emp, active) => t.sb.run('handleMgrSetActive')({ mgr_key: 'MK', emp_id: emp, active: active });
  ok('低-5 恢復在職：line_user_id 已被另一個在職列使用 → line_identity_conflict，不改 active', () => {
    const t = make(true); const r = set(t, 'E01', true);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'line_identity_conflict');
    assert.strictEqual(r.message, '這位同仁的 LINE 已綁在另一個在職帳號，請先解除其中一個綁定');
    assert.strictEqual(t.rows[0].active, false);
  });
  ok('低-5 恢復在職：LINE 沒衝突（或沒綁）→ 照常成功', () => {
    const t = make(true); const r = set(t, 'E08', true);
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(t.rows[2].active, true);
  });
  ok('低-5 handleMgrSetActive 用 script lock（tryLock 10 秒）；拿不到回 busy 且不改資料；拿到會放鎖', () => {
    const a = make(true); set(a, 'E08', true);
    deq(a.st.tries, [10000]); assert.strictEqual(a.st.released, 1);
    const b = make(false); const r = set(b, 'E08', true);
    assert.strictEqual(r.error, 'busy'); assert.strictEqual(b.rows[2].active, false);
  });
  ok('低-5 對應版 handleSvcSetActive_ 同樣擋 line_identity_conflict', () => {
    const t = make(true);
    const r = t.sb.run('handleSvcSetActive_')({ emp_id: 'E01', op_id: 'op1', active: true, by: '人資' });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'line_identity_conflict'); assert.strictEqual(t.rows[0].active, false);
    const r2 = t.sb.run('handleSvcSetActive_')({ emp_id: 'E08', op_id: 'op2', active: true, by: '人資' });
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  });
  ok('低-7 handleMgrSetActive 寫入成功後忘掉該 LINE 的 lhm 快取；沒變更／失敗時不動', () => {
    const t = make(true); set(t, 'E08', true);
    deq(t.st.forgot, ['Uxx_other']);
    const f = make(true); set(f, 'E01', true); deq(f.st.forgot, []);
    const ncg = make(true); set(ncg, 'E09', true); deq(ncg.st.forgot, []);   // unchanged
    const off = make(true); const r = set(off, 'E09', false); assert.strictEqual(r.ok, true); deq(off.st.forgot, ['Uxx_third']);
  });
  ok('低-7 沒有 lineHubForget_（店端部署）時不丟例外', () => {
    const t = make(true); t.sb.ctx.lineHubForget_ = undefined;
    assert.strictEqual(set(t, 'E08', true).ok, true);
  });
  ok('低-7 handleMgrLineUnbind_ 解綁成功後 lineHubForget_(原 uid)', () => {
    const t = make(true); t.sb.def('liffMgr_', () => ({ name: '店長假名' }));
    const r = t.sb.run('handleMgrLineUnbind_')({ mgr_key: 'MK', emp_id: 'E09' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(t.rows[3].line_user_id, ''); deq(t.st.forgot, ['Uxx_third']);
    const r2 = t.sb.run('handleMgrLineUnbind_')({ mgr_key: 'MK', emp_id: 'E09' });   // 已解綁
    assert.strictEqual(r2.already, true); deq(t.st.forgot, ['Uxx_third']);
  });
}

console.log(n + ' 項通過');
