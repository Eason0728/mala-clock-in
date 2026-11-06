// 核定工時綁定申請單（2026-11-06 Eason）：超過 8 小時要有加班單、少卡要有忘打卡單，沒有就整天送不出；
// 超過 7 天同仁補不了 → 店長在管理系統代開（mgr_req_proxy），代開的單只有總監層級（營運系統代轉時帶 director_ok）能審。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function extractConst(src, name) {
  const i = src.indexOf('const ' + name + ' = ['); const j = src.indexOf('];', i);
  return src.slice(i, j + 2).replace('const ', 'var ');
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function sheet(name, rows) {
  const data = rows ? rows.map((r) => r.slice()) : [];
  return {
    name, data,
    getRange(r, c, nr, nc) {
      return {
        setValues(v) { v.forEach((row, i) => row.forEach((x, k) => { (data[r - 1 + i] = data[r - 1 + i] || [])[c - 1 + k] = x; })); },
        setValue(x) { (data[r - 1] = data[r - 1] || [])[c - 1] = x; },
        getValues() { return [data[r - 1].slice(c - 1, c - 1 + (nc || 1))]; },
        setNumberFormat() {},
      };
    },
    appendRow(row) { data.push(row.slice()); },
    getLastColumn() { return data[0] ? data[0].length : 0; },
  };
}
function makeEnv(now) {
  const sheets = {
    managers: sheet('managers', [['name', 'key', 'active', 'allow_acting'], ['測試主管', 'MK', 'true', ''], ['門市營運系統', 'SYS', 'true', 'TRUE']]),
    roster: sheet('roster', [['emp_id', 'name', 'active'], ['E01', '測試一', 'true'], ['E02', '測試二', 'true']]),
  };
  const props = {};
  let nowIso = now || '2026-11-20T16:00:00+08:00';
  let rnd = 0;
  const seqMath = Object.assign(Object.create(Math), { random: () => (rnd++ % 1296) / 1296 });
  const sb = {
    console, Date, JSON, Math: seqMath, String, Number, isNaN, isFinite, parseInt, Object, Array, RegExp,
    CONFIG: {},
    getSS: () => ({ getSheetByName: (nm) => sheets[nm] || null, insertSheet: (nm) => (sheets[nm] = sheet(nm)) }),
    readSheetAsObjects: (sh) => {
      const h = sh.data[0] || [];
      return { headers: h, rows: sh.data.slice(1).map((r, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; }); return o; }) };
    },
    normCellDate: (v) => String(v), normCellTs: (v) => String(v),
    nowTaipeiIso: () => nowIso, todayTaipeiStr: () => nowIso.slice(0, 10),
    liffEvents_: () => sb.__events,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  };
  sb.__events = [];
  vm.createContext(sb);
  vm.runInContext([extractConst(codeSrc, 'LEAVE_TYPES'), extract(codeSrc, 'findManagerByKey'), extract(codeSrc, 'actingName_'), extract(codeSrc, 'sheetSafeText_'),
                   extract(codeSrc, 'findRosterByEmpId'), extract(codeSrc, 'gapExplainedByBreak'),
                   fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8')].join('\n'), sb);
  sb.__sheets = sheets; sb.__props = props;
  return sb;
}
const D = '2026-11-10';
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const P = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const S = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
const BRK = { startMs: ms('12:00'), endMs: ms('13:00') };
// 直接往 requests 分頁塞已核准／審核中的單
function addReq(sb, r) {
  const ss = sb.getSS();
  const sh = sb.reqSheet_(ss, true);
  const row = Object.assign({ id: 'x' + Math.random(), created_at: '2026-11-10T20:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
  sh.appendRow(sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
}

/* ── 少幾張卡 ── */
const sb0 = makeEnv();
ok('打卡完整一段＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [S('08:55', '17:05')], null), 0));
ok('央廚中午休息帶：兩段核定、一段打卡＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('08:00', '12:00'), P('13:00', '17:00')], [S('07:58', '17:02')], BRK), 0));
ok('沒有休息帶的店中間休息沒打＝2 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '21:00')], null), 2));
ok('拆段核定（間隔 0）＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00'), P('17:00', '19:00')], [S('09:00', '19:00')], null), 0));
ok('只有上班卡＝1 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [S('08:55', null)], null), 1));
ok('完全沒打卡＝2 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [], null), 2));
ok('兩段各自打卡＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '14:00'), S('17:00', '21:00')], null), 0));
ok('第二段只有下班卡＝1 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '14:00'), S(null, '21:00')], null), 1));

/* ── 核定檢查 ── */
ok('8 小時整、打卡完整＝放行', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [S('09:00', '17:00')], null), null);
});
ok('9.5 小時沒加班單＝擋，訊息講缺 1.5 小時', () => {
  const sb = makeEnv();
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.strictEqual(r.error, 'need_request');
  assert.ok(/1\.5 小時要有加班單/.test(r.message), r.message);
  assert.strictEqual(r.need.ot_hours, 1.5);
});
ok('加班單 1 小時不夠蓋 1.5 小時＝擋；再一張 0.5 小時就放行', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', start: '17:00', end: '18:00', hours: 1 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null).error, 'need_request');
  addReq(sb, { kind: 'ot', start: '18:00', end: '18:30', hours: 0.5 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null), null);
});
ok('審核中的加班單不算，訊息提醒先去審核', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', start: '17:00', end: '18:30', hours: 1.5, status: 'pending' });
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(/1 張申請還在審核中/.test(r.message), r.message);
});
ok('別人的單、別天的單不算', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', hours: 2, emp_id: 'E02' });
  addReq(sb, { kind: 'ot', hours: 2, date: '2026-11-11' });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null).error, 'need_request');
});
ok('少下班卡：有已核准的忘打卡（補下班）就放行', () => {
  const sb = makeEnv();
  const args = [sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [S('09:00', null)], null];
  assert.ok(/少了 1 張打卡/.test(sb.reqBindCheck_(...args).message));
  addReq(sb, { kind: 'miss', miss_type: 'out', end: '17:00' });
  assert.strictEqual(sb.reqBindCheck_(...args), null);
});
ok('中間休息沒打 2 張：補休息單（算 2 張）就放行', () => {
  const sb = makeEnv();
  const args = [sb.getSS(), 'E01', D, 7, [P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '21:00')], null];
  assert.strictEqual(sb.reqBindCheck_(...args).need.miss_cards, 2);
  addReq(sb, { kind: 'miss', miss_type: 'break', start: '17:00', end: '14:00' });
  assert.strictEqual(sb.reqBindCheck_(...args), null);
});
ok('那天有已核准的出差單：缺卡不擋（超時仍要加班單）', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'trip', leave_type: '出差', hours: 4 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [], null), null);
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9, [P('09:00', '18:00')], [], null).error, 'need_request');
});
ok('超時＋缺卡兩個問題一起講', () => {
  const sb = makeEnv();
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 10, [P('09:00', '19:00')], [S('09:00', null)], null);
  assert.ok(/加班單/.test(r.message) && /忘打卡單/.test(r.message), r.message);
});
ok('整天請假（沒有時段）不看', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 0, [], [], null), null);
});
ok('上線日以前的日子不擋；REQ_BIND_FROM 可改、off 整個關掉', () => {
  const sb = makeEnv();
  const a = (d) => sb.reqBindCheck_(sb.getSS(), 'E01', d, 9, [P('09:00', '18:00')], [], null);
  assert.strictEqual(a('2026-11-05'), null);
  assert.strictEqual(a('2026-11-06').error, 'need_request');
  sb.__props.REQ_BIND_FROM = '2026-12-01';
  assert.strictEqual(a('2026-11-10'), null);
  sb.__props.REQ_BIND_FROM = 'off';
  assert.strictEqual(a('2026-12-10'), null);
});

/* ── Code.gs 掛鉤位置 ── */
ok('handleMgrApprove 在寫入核定前呼叫 reqBindCheck_，舊 Requests 沒有就跳過', () => {
  const fn = extract(codeSrc, 'handleMgrApprove');
  const i = fn.indexOf("typeof reqBindCheck_ === 'function'"), j = fn.indexOf('appendApprovedRow_(');
  assert.ok(i > 0 && j > i, '掛鉤要在 appendApprovedRow_ 之前');
  assert.ok(/reqBindCheck_\(ss, String\(body\.emp_id\), date, approvedHours, periods, punchWithMs, noPunchBreakWindow\(date\)\)/.test(fn));
});

/* ── 主管代開 ── */
const ACT = { mgr_key: 'SYS', acting_name: '林店長（S1）' };
const proxyBody = (o) => Object.assign({ action: 'mgr_req_proxy', emp_id: 'E01', kind: 'ot', date: '2026-11-10', start: '18:00', end: '19:30', reason: '盤點' }, ACT, o);
ok('代開只能用營運系統個人帳號（本店主管鑰匙不行）', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ mgr_key: 'MK', acting_name: undefined })).error, 'acting_only');
});
ok('7 天內不能代開；超過 90 天也不行', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ date: '2026-11-13' })).error, 'not_old');
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ date: '2026-08-01' })).error, 'too_old');
});
ok('只限加班、忘打卡', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ kind: 'leave' })).error, 'bad_kind');
});
ok('代開成功：審核中、記代開人、摘要標主管代開', () => {
  const sb = makeEnv();
  const r = sb.handleMgrReqProxy_(proxyBody());
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.request.status, 'pending');
  assert.strictEqual(r.request.proxy_by, '林店長（S1）');
  assert.ok(/（主管代開）$/.test(r.summary), r.summary);
});
ok('忘打卡代開照樣檢查那天真的缺卡', () => {
  const sb = makeEnv();
  sb.__events = [{ ts: '2026-11-10T09:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }];
  const bad = sb.handleMgrReqProxy_(proxyBody({ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }));
  assert.strictEqual(bad.error, 'not_missing');
  const good = sb.handleMgrReqProxy_(proxyBody({ kind: 'miss', miss_type: 'out', start: '', end: '17:00' }));
  assert.ok(good.ok, JSON.stringify(good));
});
ok('代開的單：本店主管、沒有 director_ok、代開人自己都不能審；總監層級可以', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody()).request.id;
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id, decision: 'approve' }).error, 'director_review');
  assert.strictEqual(sb.handleMgrReqDecide_(Object.assign({ id, decision: 'approve' }, ACT)).error, 'director_review');
  assert.strictEqual(sb.handleMgrReqDecide_(Object.assign({ id, decision: 'approve', director_ok: true }, ACT)).error, 'self_proxy');
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: 'true' }).error, 'director_review', '字串 true 不算');
  const r = sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.ok(r.ok && r.status === 'approved', JSON.stringify(r));
});
ok('待審清單：代開的單標 upper／director', () => {
  const sb = makeEnv();
  sb.handleMgrReqProxy_(proxyBody());
  const it = sb.handleMgrReqPending_({ mgr_key: 'MK' }).items[0];
  assert.strictEqual(it.upper, true);
  assert.strictEqual(it.upper_kind, 'director');
});
ok('批次核准跳過代開的單；作廢也要總監層級', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody()).request.id;
  const b = sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [id], decision: 'approve' });
  assert.strictEqual(b.done.length, 0);
  assert.ok(/總監層級/.test(b.skipped[0].reason));
  sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.strictEqual(sb.handleMgrReqVoid_({ mgr_key: 'MK', id, reason: '錯' }).error, 'director_review');
  assert.ok(sb.handleMgrReqVoid_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, reason: '錯', director_ok: true }).ok);
});
ok('代開核准後，那天核定就過得了加班那關', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody({ start: '17:00', end: '18:30' })).request.id;
  sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null), null);
});
ok('同仁自己送的單不受影響（照舊本店主管審）', () => {
  const sb = makeEnv();
  addReq(sb, { id: 'own1', kind: 'ot', hours: 1, status: 'pending' });
  assert.ok(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'own1', decision: 'approve' }).ok);
});
console.log('req-bind: ' + n + ' 項全過');
