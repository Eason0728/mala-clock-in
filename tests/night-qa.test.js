// 深夜全面品質審查（2026-11-04，分支 qa/night-1104）：用 tests/helpers/sheets-like.js（照 Sheets 轉型規則的假試算表）
// 整檔載入 apps-script/*.gs 真函式，拿全新假資料（測試○、假工號）實跑「規格 vs 程式」的差異。
//   ok(name, fn)    ＝ 行為正確（推翻候選問題、或當迴歸守門）；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 已確認的問題，寫的是「應該要」的行為，目前會失敗。只印出、不擋 run-all；
//                     修好後它會變成 ✓，再把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束。
// 名字一律用假名；不含任何金鑰、試算表 ID；不連任何外部系統（UrlFetchApp 全部是假的）。
'use strict';
process.env.TZ = 'Asia/Taipei';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const SL = require('./helpers/sheets-like');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { code: R('apps-script/Code.gs'), liff: R('apps-script/Liff.gs'), rest: R('apps-script/Rest.gs'), req: R('apps-script/Requests.gs'),
              pay: R('apps-script/Payroll.gs'), schedpub: R('apps-script/SchedPub.gs'), sched: R('apps-script/Sched.gs'), hub: R('apps-script/LineHub.gs'),
              svc: R('apps-script/SvcStaff.gs'), mirror: R('apps-script/Mirror.gs') };

let nOk = 0, nKnownOpen = 0, nKnownFixed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e.stack || e).split('\n').slice(0, 2).join(' | ')); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已修好，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待修] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};
const eq = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

/* ── 時間（台北）── */
const T = (s) => Date.parse(s + '+08:00');
const z = (v) => ('0' + v).slice(-2);
function taipei(ms) { const x = new Date(ms + 8 * 3600000); return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() }; }
function formatDate(d, tz, pattern) {
  const t = taipei(d.getTime());
  const tok = { yyyy: t.y, MM: z(t.M), dd: z(t.d), HH: z(t.H), mm: z(t.m), ss: z(t.s), XXX: '+08:00', M: t.M, d: t.d, H: t.H };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|XXX|M|d|H/g, (m, q) => (q !== undefined ? q : String(tok[m])));
}

/** 沙盒：整檔載入所有 .gs，試算表換成 sheets-like。可控時鐘 sb.__now、有 TTL 的快取、假 LINE 驗證（TOK_<uid> → uid）、假鎖。 */
function make(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sb = {
    console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, unescape, escape,
    Logger: { log: () => {} }, __now: opts.now || T('2026-11-04T10:00:00'), __fetches: [],
  };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(sb.__now); } static now() { return sb.__now; } };
  sb.CacheService = { getScriptCache: () => ({
    get: (k) => { const e = cache[k]; if (!e) return null; if (e.exp <= sb.__now) { delete cache[k]; return null; } return e.v; },
    put: (k, v, ttl) => { cache[k] = { v: String(v), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; },
    putAll: (m, ttl) => { Object.keys(m).forEach((k) => { cache[k] = { v: String(m[k]), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; }); },
    getAll: (ks) => { const o = {}; ks.forEach((k) => { const e = cache[k]; if (e && e.exp > sb.__now) o[k] = e.v; }); return o; },
    remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach((k) => { delete cache[k]; }),
  }) };
  sb.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) };
  sb.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true }) };
  const signed = (b) => (b > 127 ? b - 256 : b);
  sb.Utilities = {
    formatDate, getUuid: () => crypto.randomUUID(), sleep: () => {},
    computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()).map(signed),
    computeDigest: (alg, v) => Array.from(crypto.createHash(alg === 'MD5' ? 'md5' : 'sha256').update(String(v)).digest()).map(signed),
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
    base64Encode: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64'),
    base64EncodeWebSafe: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ getContentType: () => mime, getBytes: () => bytes, name }),
  };
  const users = opts.lineUsers || { TOK_U1: { sub: 'U1' }, TOK_U2: { sub: 'U2' } };
  sb.UrlFetchApp = { fetch: (url, o) => {   // 一律不連外：只認假 id_token，其他全部回錯
    sb.__fetches.push({ url, o });
    const u = users[o && o.payload && o.payload.id_token];
    const body = u ? JSON.stringify({ sub: u.sub, aud: u.aud || '2011292256', exp: u.exp || Math.floor(sb.__now / 1000) + 3600 }) : '{"error":"invalid"}';
    return { getResponseCode: () => (u ? 200 : 400), getContentText: () => body };
  } };
  sb.ScriptApp = { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => { const c = { timeBased: () => c, atHour: () => c, everyDays: () => c, everyHours: () => c, nearMinute: () => c, create: () => ({}) }; return c; } };
  sb.ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: (s) => ({ setMimeType: () => s }) };
  sb.DriveApp = { getFolderById: () => { throw new Error('沙盒沒有雲端硬碟'); }, getFileById: () => { throw new Error('沙盒沒有雲端硬碟'); } };
  vm.createContext(sb);
  const ss = SL.createSpreadsheet({ id: 'SELF', DateCtor: sb.Date, now: () => sb.__now, defaultMaxCols: opts.maxCols || 40 });
  sb.SpreadsheetApp = { openById: () => ss, getActive: () => ss, getActiveSpreadsheet: () => ss, flush: () => {} };
  ['code', 'liff', 'rest', 'req', 'pay', 'schedpub', 'sched', 'hub', 'svc', 'mirror'].forEach((k) => vm.runInContext(SRC[k], sb, { filename: k + '.gs' }));
  const c = (name) => vm.runInContext(name, sb);
  vm.runInContext("Object.assign(CONFIG, { STORE_LAT: 24.78, STORE_LNG: 121.01, RADIUS_M: 20, ADMIN_KEY: 'ADM', DEFAULT_SHIFT_IN: '', DEFAULT_SHIFT_OUT: '', PAYROLL_API: '', PAYROLL_STORE: '' })", sb);
  sb.LINE_HUB_STORES_CONFIG = [{ code: '', name: '光復', ss_id: 'SELF' }];
  sb.setup();
  ss.getSheetByName('managers').appendRow(['值班主管', 'MK', 'true']);
  const rows = (n) => sb.readSheetAsObjects(ss.getSheetByName(n)).rows;
  return { sb, ss, props, rows, c, sheet: (n) => ss.getSheetByName(n), setNow: (v) => { sb.__now = T(v); } };
}
const HERE = { lat: 24.78, lng: 121.01, accuracy: 5 };
function hire(m, name) { const r = m.sb.handleMgrAddEmployeeUnlocked_({ mgr_key: 'MK', name: name || '測試一' }); assert.ok(r.ok, JSON.stringify(r)); return r; }
const punch = (m, key, type, extra) => m.sb.handleClock(Object.assign({ key, type, device_id: 'D1' }, HERE, extra || {}));
/** 綁 LINE：直接寫名冊 line_user_id（liff_bind 本身另有測試） */
function bindLine(m, empId, uid) {
  const sh = m.sheet('roster'); const rr = m.rows('roster').filter((r) => String(r.emp_id) === empId)[0];
  const H = m.c('ROSTER_HEADERS');
  sh.getRange(rr.__rowIndex, H.indexOf('line_user_id') + 1).setValue(uid);
  sh.getRange(rr.__rowIndex, H.indexOf('line_bound_at') + 1).setValue(m.sb.nowTaipeiIso());
}
const sub = (m, b, tok) => m.sb.handleReqSubmit_(Object.assign({ id_token: tok || 'TOK_U1' }, b));

/* ════════════════════════════════════════════════════════════════════════
   1. 薪資：儲存工時後，五個舊欄位以外的假別消失
   ════════════════════════════════════════════════════════════════════════ */
console.log('━━ 1. 薪資 Payroll.gs ━━');
function payFixture() {
  const m = make({ now: T('2026-11-04T10:00:00') });
  const e = hire(m, '測試甲');
  assert.ok(m.sb.handlePayrollHolidaySet({ admin_key: 'ADM', store: '', holidays: [{ ym: '2026-11', red_days: 9, note: '', dates: '' }] }).ok);
  m.sb.handlePayrollMasterSet({ admin_key: 'ADM', store: 'SSLGF', master: [{ emp_id: e.emp_id, name: '測試甲', is_full_time: 'true', base: 36000, ot_rate: 150, attend_cap: 2000, hire_date: '2025-01-01', active: 'true', store: 'SSLGF' }] });
  for (let d = 3; d <= 10; d++) {
    m.setNow('2026-11-' + z(d) + 'T20:00:00');
    const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-' + z(d), emp_id: e.emp_id, periods: [{ start: '10:00', end: '18:00' }],
      leaves: d === 10 ? [{ type: '家庭照顧假', hours: 8 }] : (d === 9 ? [{ type: '婚假', hours: 16 }] : []) });
    assert.ok(r.ok, JSON.stringify(r));
  }
  m.setNow('2026-11-15T10:00:00');
  return { m, e };
}
ok('儲存工時（payroll_input_set 原樣回存 payroll_inputs）後再重算：家庭照顧假扣款與婚假抵不足時數都還在、實付不變', () => {
  const { m, e } = payFixture();
  const before = m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' });
  assert.ok(before.ok, JSON.stringify(before));
  const b0 = before.results.filter((r) => r.emp_id === e.emp_id)[0];
  const dedB = b0.ded.map((x) => x.item_key + '=' + x.amount).join('|');
  assert.ok(/family_leave=/.test(dedB), '前提：存檔前有家庭照顧假扣款 ' + dedB);
  const inp = m.sb.handlePayrollInputs({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' }).inputs;
  assert.ok(m.sb.handlePayrollInputSet({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', inputs: inp }).ok);
  const after = m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', force: true });
  const a0 = after.results.filter((r) => r.emp_id === e.emp_id)[0];
  const dedA = a0.ded.map((x) => x.item_key + '=' + x.amount).join('|');
  assert.strictEqual(dedA, dedB, '存檔後扣項變了：' + dedA + '（存檔前 ' + dedB + '）');
  assert.strictEqual(a0.net, b0.net, '實付變了 ' + a0.net + ' vs ' + b0.net);
});
ok('月底到職年資：到職 2025-08-31，2026-02 月特休額度應與 payTenurePlus 同口徑（2/28 視為滿 6 個月）', () => {
  const m = make();
  const q = m.sb.payAnnualQuota('2025-08-31', '2026-02');
  const tm = m.sb.payTenureMonths('2025-08-31', '2026-02');
  assert.strictEqual(tm, 6, 'payTenureMonths 回 ' + tm);
  assert.ok(q.days > 0, '2026-02 特休額度 ' + JSON.stringify(q));
});
ok('對照：同一人 2026-03 的 payAnnualQuota 週年期起日已算到 2026-02-28（兩套算法自相矛盾的證據）', () => {
  const m = make();
  assert.strictEqual(m.sb.payAnnualQuota('2025-08-31', '2026-03').ps, '2026-02-28');
});
ok('已鎖定（final）的月份：payroll_item_upsert 應拒絕寫入', () => {
  const { m, e } = payFixture();
  assert.ok(m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' }).ok);
  assert.ok(m.sb.handlePayrollFinalize({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', lock: true }).ok);
  const up = m.sb.handlePayrollItemUpsert({ admin_key: 'ADM', item: { ym: '2026-11', emp_id: e.emp_id, item_type: 'earning', item_key: 'x', item_label: '測試加項', amount: 99999, store: 'SSLGF' } });
  assert.strictEqual(up.ok, false, '鎖定後 upsert 仍 ok：' + JSON.stringify(up));
});
ok('已鎖定（final）的月份：payroll_calc 帶 force:true 不應跳過鎖定直接重算', () => {
  const { m } = payFixture();
  assert.ok(m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' }).ok);
  assert.ok(m.sb.handlePayrollFinalize({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', lock: true }).ok);
  const r = m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', force: true });
  assert.strictEqual(r.ok, false, 'force 跳過鎖定：' + JSON.stringify(r).slice(0, 120));
});
KNOWN('兩店同時重算（各自先讀全表再整批覆寫）：先寫入那一店的 run 不應被後寫的洗掉', () => {
  const { m, e } = payFixture();
  const f = hire(m, '測試乙');
  m.sb.handlePayrollMasterSet({ admin_key: 'ADM', store: 'MDCF', master: [{ emp_id: f.emp_id, name: '測試乙', is_full_time: 'true', base: 30000, ot_rate: 150, attend_cap: 2000, hire_date: '2025-01-01', active: 'true', store: 'MDCF' }] });
  // 交錯：A 店讀完 run 表（快取）→ B 店讀完 → A 寫 → B 寫
  const sb = m.sb;
  const real = sb.payReplaceAll, queue = [];
  sb.payReplaceAll = (k, rows) => { queue.push([k, rows]); };   // 先排隊，模擬兩個請求各自讀到的舊快照
  const a = sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' });
  const qa = queue.splice(0);
  sb.PAY_READ_CACHE = {}; vm.runInContext('PAY_READ_CACHE = {}', sb);
  const b = sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'MDCF' });
  const qb = queue.splice(0);
  assert.ok(a.ok && b.ok, JSON.stringify([a.ok, b.ok]));
  qa.forEach((x) => real(x[0], x[1])); qb.forEach((x) => real(x[0], x[1]));
  vm.runInContext('PAY_READ_CACHE = {}', sb);
  const runs = m.sb.payRead('run').map((r) => r.store + ':' + r.emp_id);
  assert.ok(runs.indexOf('SSLGF:' + e.emp_id) >= 0, '光復的 run 被央廚洗掉：' + JSON.stringify(runs));
  assert.ok(runs.indexOf('MDCF:' + f.emp_id) >= 0, JSON.stringify(runs));
});

/* ════════════════════════════════════════════════════════════════════════
   2. 打卡核心／值班核定 Code.gs
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 2. 打卡核心／值班核定 Code.gs ━━');
KNOWN("純數字工號 '0007'（sync_roster 同步進來）：打卡 events／核定 approved 的 emp_id 應維持文字，同仁頁本月合計才對得到", () => {
  const m = make({ now: T('2026-11-04T09:00:00') });
  assert.ok(m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: '0007', name: '測試七', active: true }] }).ok);
  const key = m.rows('roster')[0].key;
  assert.strictEqual(punch(m, key, 'in').status, 'ok');
  m.setNow('2026-11-04T18:00:00'); assert.strictEqual(punch(m, key, 'out').status, 'ok');
  assert.strictEqual(String(m.rows('events')[0].emp_id), '0007', 'events.emp_id 讀回 ' + JSON.stringify(m.rows('events')[0].emp_id));
  m.setNow('2026-11-04T20:00:00');
  const ap = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-04', emp_id: '0007', periods: [{ start: '09:00', end: '18:00' }] });
  assert.ok(ap.ok, JSON.stringify(ap));
  const my = m.sb.handleMyRecent({ key });
  assert.strictEqual(my.month_totals.current.hours, 9, '本月合計 ' + JSON.stringify(my.month_totals));
});
ok('值班核定：不應接受未來日期（今天 11/4 核定 11/30 09:00–21:00）', () => {
  const m = make({ now: T('2026-11-04T10:00:00') });
  const e = hire(m);
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-30', emp_id: e.emp_id, periods: [{ start: '09:00', end: '21:00' }] });
  assert.strictEqual(r.ok, false, '未來日期核定成功：' + JSON.stringify(r));
});
ok('整天請假（periods 空、有假別）的未來日期照收（主管可能預先記特休）；有上班時段才擋，錯誤碼 future_date', () => {
  const m = make({ now: T('2026-11-04T10:00:00') });
  const e = hire(m);
  const r1 = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-30', emp_id: e.emp_id, periods: [{ start: '09:00', end: '21:00' }] });
  assert.strictEqual(r1.error, 'future_date', JSON.stringify(r1));
  const r2 = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-30', emp_id: e.emp_id, periods: [], leaves: [{ type: '特休假', hours: 8 }] });
  assert.ok(r2.ok, JSON.stringify(r2));
  const r3 = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-04', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }] });   // 今天照收
  assert.ok(r3.ok, JSON.stringify(r3));
});
ok('推翻候選：replaceLeaveRows 自己重讀 leaveRowsOf（第 4 參數不用），兩位主管接連核定不同人不會刪錯請假列', () => {
  const m = make({ now: T('2026-11-04T20:00:00') });
  const a = hire(m, '測試甲'), b = hire(m, '測試乙');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-04', emp_id: a.emp_id, periods: [], leaves: [{ type: '病假', hours: 8 }] });
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-04', emp_id: b.emp_id, periods: [], leaves: [{ type: '事假', hours: 8 }] });
  const sb = m.sb, ss = m.ss;
  const rowsA = sb.leaveRowsOf(ss, '2026-11-04', '測試甲'), rowsB = sb.leaveRowsOf(ss, '2026-11-04', '測試乙');
  // A 先把甲的病假改成 4H（刪舊列＋新增）；B 再用它「核定前」讀到的列號刪乙的列
  sb.replaceLeaveRows(ss, '2026-11-04', '測試甲', [{ type: '病假', hours: 4 }], rowsA);
  sb.replaceLeaveRows(ss, '2026-11-04', '測試乙', [{ type: '事假', hours: 4 }], rowsB);
  const lv = m.rows('leave').map((r) => r['姓名'] + ':' + r['假別'] + ':' + r['時數']).sort();
  eq(lv, ['測試乙:事假:4', '測試甲:病假:4'], '請假表變成 ' + JSON.stringify(lv));
});
ok('名冊同步 sync_roster：呼叫端沒帶 active 欄位時，既有在職同仁不應被停用', () => {
  const m = make();
  const e = hire(m, '測試甲');
  assert.strictEqual(m.rows('roster')[0].active, true);
  assert.ok(m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: e.emp_id, name: '測試甲' }] }).ok);
  assert.strictEqual(m.rows('roster')[0].active, true, '沒帶 active 就被停用');
});
ok('名冊同步 sync_roster：同名在職的另一個工號不應被加進名冊（薪資／請假用姓名對人會混）', () => {
  const m = make();
  hire(m, '測試甲');
  m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: 'Z999', name: '測試甲', active: true }] });
  const same = m.rows('roster').filter((r) => String(r.name) === '測試甲' && r.active === true);
  assert.strictEqual(same.length, 1, '名冊有 ' + same.length + ' 個在職的測試甲');
});
ok('對照：svc_add 擋同名在職（同一件事兩條路徑規則不一致）', () => {
  const m = make({ props: { SVC_STAFF_KEY: 'SVCK' } });
  hire(m, '測試甲');
  const r = m.sb.SVC_STAFF_HANDLERS.svc_add({ svcKey: 'SVCK', name: '測試甲', op_id: 'op1', by: '測試' });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

/* ════════════════════════════════════════════════════════════════════════
   3. 總部鏡像：events 底部堆了舊的鏡像列 → readEventsSince 提早停
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 3. 鏡像 Mirror.gs × readEventsSince ━━');
ok('events 最底下有 320 列幾個月前的鏡像列時，自家同仁 5 分鐘前的上班卡仍應被讀到（同型 10 分鐘鎖要擋下第二張上班卡）', () => {
  // （2026-11-04 夜間 QA 第三批）原本拿「隔 11 小時再打上班卡」當判準，但同型鎖只有 10 分鐘、休息規則預設關著，那樣寫本來就會 ok；
  //  改用同型 10 分鐘鎖當判準，鏡像列擠掉自家卡時它會漏擋（修前 ok、修後 rejected_duplicate）。
  const m = make({ now: T('2026-11-03T22:00:00') });
  const e = hire(m, '測試甲');
  assert.strictEqual(punch(m, e.key, 'in').status, 'ok');
  const sh = m.sheet('events');
  sh.getRange(1, m.c('EVENTS_HEADERS').length + 1).setValue('mirror_src');   // Mirror.gs 首次鏡像時在最右邊加的欄
  const iso = (ms) => formatDate(new m.sb.Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  for (let i = 0; i < 320; i++) sh.appendRow([iso(T('2026-08-01T09:00:00') + i * 3600000), 'MZ' + i, 'in', '', '', '', '', '', '', 'ok', '', 'mztjs']);
  m.setNow('2026-11-03T22:05:00');
  const r = punch(m, e.key, 'in');
  assert.strictEqual(r.status, 'rejected_duplicate', JSON.stringify(r));
});

/* ════════════════════════════════════════════════════════════════════════
   4. LINE 申請 Requests.gs／Liff.gs
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 4. LINE 申請 Requests.gs／Liff.gs ━━');
function lineFixture(now, events) {
  const m = make({ now: T(now) });
  const e = hire(m, '測試甲');
  bindLine(m, e.emp_id, 'U1');
  (events || []).forEach((ev) => { m.setNow(ev[0]); assert.strictEqual(punch(m, e.key, ev[1]).status, 'ok', ev.join(' ')); });
  m.setNow(now);
  return { m, e };
}
ok('忘打卡：昨天 22:00 上班、現在凌晨 00:30 補「下班 03:00(+1)」＝還沒到的時間，應回 bad_time', () => {
  const { m } = lineFixture('2026-11-04T00:30:00', [['2026-11-03T22:00:00', 'in']]);
  const r = sub(m, { kind: 'miss', date: '2026-11-03', miss_type: 'out', end: '03:00', reason: '忘記按' });
  assert.strictEqual(r.error, 'bad_time', JSON.stringify(r));
});
ok('對照：同情境補「下班 00:10(+1)」（已過）照常收件', () => {
  const { m } = lineFixture('2026-11-04T00:30:00', [['2026-11-03T22:00:00', 'in']]);
  const r = sub(m, { kind: 'miss', date: '2026-11-03', miss_type: 'out', end: '00:10', reason: '忘記按' });
  assert.ok(r.ok, JSON.stringify(r));
});
ok('凌晨 01:00 只打了下班卡：提醒卡片「申請補登」帶的日期應是前一天（跟 reqDayInfo_ 把 ≤06:00 孤兒下班卡歸前一天一致）', () => {
  const { m, e } = lineFixture('2026-11-04T01:05:00', [['2026-11-04T01:00:00', 'out']]);
  const sb = m.sb, ev = sb.liffEvents_(m.ss);
  const d = sb.liffMissedDetail_([], e.emp_id, 'out', '2026-11-04T01:00:00+08:00');
  const optToday = sb.reqDayInfo_(ev, e.emp_id, '2026-11-04').missing.options, optPrev = sb.reqDayInfo_(ev, e.emp_id, '2026-11-03').missing.options;
  eq(optPrev, ['in']); eq(optToday, ['both']);
  assert.strictEqual(d.date, '2026-11-03', '卡片帶的 date=' + d.date + '，但那天的補登選項是 ' + JSON.stringify(optToday));
});
ok('「我的申請」：8/1 送出 10/20 的特休，10/5 仍是 pending，清單應看得到（才有取消入口）', () => {
  const { m } = lineFixture('2026-08-01T10:00:00');
  const r = sub(m, { kind: 'leave', date: '2026-10-20', leave_type: '特休假', hours: 8 });
  assert.ok(r.ok, JSON.stringify(r));
  m.setNow('2026-10-05T10:00:00');
  const info = m.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  assert.strictEqual(info.requests.length, 1, '清單筆數 ' + info.requests.length);
});
ok('對照：同一筆直接打 req_cancel 仍能取消（只是畫面沒入口）', () => {
  const { m } = lineFixture('2026-08-01T10:00:00');
  const r = sub(m, { kind: 'leave', date: '2026-10-20', leave_type: '特休假', hours: 8 });
  m.setNow('2026-10-05T10:00:00');
  assert.ok(m.sb.handleReqCancel_({ id_token: 'TOK_U1', id: r.request.id }).ok);
});
KNOWN('只請一段但沒選時間（前端 mode=span 送 start:"" end:""）：錯誤碼應指向「請選時間」而不是 bad_hours「請填請假時數」', () => {
  const { m } = lineFixture('2026-11-04T10:00:00');
  const r = sub(m, { kind: 'leave', date: '2026-11-05', leave_type: '事假', start: '', end: '' });
  assert.notStrictEqual(r.error, 'bad_hours', JSON.stringify(r));
});
ok('同日第二段不重疊加班：第一筆 pending 時回 duplicate（規則：同日同類只能一筆審核中）', () => {
  const { m } = lineFixture('2026-11-04T10:00:00');
  sub(m, { kind: 'ot', date: '2026-11-05', start: '18:00', end: '19:00', reason: '盤點' });
  assert.strictEqual(sub(m, { kind: 'ot', date: '2026-11-05', start: '21:00', end: '22:00', reason: '盤點' }).error, 'duplicate');
});

/* ════════════════════════════════════════════════════════════════════════
   5. 班表 Sched.gs／SchedPub.gs
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 5. 班表 Sched.gs／SchedPub.gs ━━');
const PUB = (m, over) => m.sb.handleSchedPublish_(Object.assign({ svcKey: 'PK', v: 1, store: '', period: 'T01', seq: 1, op_id: 'op-1', start: '2026-11-01', days: 28,
  shifts: [{ id: 'A', name: '早班', start: '10:00', end: '18:00', break_min: 60 }],
  rows: [{ emp_id: 'E01', name: '測試甲', cells: Array.from({ length: 28 }, (_, i) => (i % 7 === 6 ? { t: 'R' } : { t: 'W', s: 'A' })) }] }, over || {}));
ok('sched_day_roster：節流應在驗金鑰之後；沒帶金鑰狂打 60 次不應讓持有金鑰的訂貨小幫手拿到 too_many', () => {
  const m = make({ props: { SCHED_READ_KEY: 'RK', SCHED_STORE_FROM: '2026-11-01' } });
  for (let i = 0; i < 60; i++) m.sb.handleSchedDayRoster_({ key: 'wrong', date: '2026-11-04' });
  const r = m.sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-04' });
  assert.notStrictEqual(r.error, 'too_many', JSON.stringify(r));
});
ok('sched_publish：班別沒帶 start／end 應回 bad_input，而不是把 "undefined" 寫進表、LINE 班表顯示 NaN 時數', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'PK', SCHED_STORE_FROM: '2026-11-01' } });
  const r = PUB(m, { shifts: [{ id: 'A', name: '早班' }] });
  assert.strictEqual(r.ok, false, '發布成功：' + JSON.stringify(r));
});
ok('班別 start／end 不是 HH:MM（"9:00"、空字串）一律 bad_input，且沒寫進 sched_pub', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'PK', SCHED_STORE_FROM: '2026-11-01' } });
  ['9:00', '', null].forEach((bad) => {
    const r = PUB(m, { shifts: [{ id: 'A', name: '早班', start: bad, end: '18:00' }] });
    assert.strictEqual(r.error, 'bad_input', JSON.stringify(r));
  });
  eq(Object.keys(m.sb.schedPubLoad_()), []);
});
ok('LINE 查班表：這一期已發布、但本人（新進）不在 rows 裡 → 應回 no_schedule，而不是 not_locked「還在排」', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'PK', SCHED_STORE_FROM: '2026-11-01' }, now: T('2026-11-04T10:00:00') });
  const e = hire(m, '測試乙'); bindLine(m, e.emp_id, 'U1');
  assert.ok(PUB(m, { rows: [{ emp_id: 'E09', name: '別人', cells: Array.from({ length: 28 }, () => ({ t: 'W', s: 'A' })) }] }).ok);   // 發布的 rows 沒有本人
  const r = m.sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' });
  assert.notStrictEqual(r.status, 'not_locked', JSON.stringify(r));
});
ok('對照：本人在 rows 裡 → ready、11/1 早班 7 小時', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'PK', SCHED_STORE_FROM: '2026-11-01' }, now: T('2026-11-04T10:00:00') });
  const e = hire(m, '測試甲'); bindLine(m, e.emp_id, 'U1');
  assert.ok(PUB(m, { rows: [{ emp_id: e.emp_id, name: '測試甲', cells: Array.from({ length: 28 }, (_, i) => (i % 7 === 6 ? { t: 'R' } : { t: 'W', s: 'A' })) }] }).ok);
  const r = m.sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' });
  assert.strictEqual(r.status, 'ready', JSON.stringify(r).slice(0, 200));
  assert.strictEqual(r.days[0].hours, 7);
});

/* ════════════════════════════════════════════════════════════════════════
   6. 修正後的補充驗證（2026-11-04 夜間 QA 第三批）
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 6. 修正後補充 ━━');
ok('鏡像：350 筆鏡像列堆在底部時，自家同仁 23:00 的下班卡仍讀得到（readEventsSince 不拿鏡像列當「停」的依據）', () => {
  const m = make({ now: T('2026-11-03T09:00:00') });
  const e = hire(m, '測試甲');
  assert.strictEqual(punch(m, e.key, 'in').status, 'ok');
  m.setNow('2026-11-03T23:00:00'); assert.strictEqual(punch(m, e.key, 'out').status, 'ok');
  const sh = m.sheet('events');
  sh.getRange(1, m.c('EVENTS_HEADERS').length + 1).setValue('mirror_src');   // Mirror.gs 首次鏡像時在最右邊加的欄
  const iso = (ms) => formatDate(new m.sb.Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  for (let i = 0; i < 350; i++) sh.appendRow([iso(T('2026-08-01T09:00:00') + i * 3600000), 'MZ' + i, 'in', '', '', '', '', '', '', 'ok', '', 'mztjs']);
  m.setNow('2026-11-04T00:30:00');
  const got = m.sb.readEventsSince(sh, T('2026-11-03T00:00:00')).rows;
  const mine = got.filter((r) => String(r.emp_id) === e.emp_id);
  assert.strictEqual(mine.length, 2, '自家卡讀到 ' + mine.length + ' 張');
  assert.ok(got.some((r) => String(r.emp_id) === 'MZ349'), '鏡像列本身仍要讀進結果（核定與薪資要用）');
});
ok('sync_roster：同名在職的新工號略過並回 skipped；沒帶 active 的新增列一律在職；已停用者同名可加', () => {
  const m = make();
  hire(m, '測試甲');
  const r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: 'Z999', name: '測試甲' }, { emp_id: 'Z998', name: '測試丙' }] });
  assert.ok(r.ok, JSON.stringify(r));
  eq(r.skipped, [{ emp_id: 'Z999', reason: 'duplicate_name' }]);
  const z98 = m.rows('roster').filter((x) => String(x.emp_id) === 'Z998')[0];
  assert.strictEqual(z98.active, true);
  assert.strictEqual(m.rows('roster').filter((x) => String(x.emp_id) === 'Z999').length, 0);
});
ok('已定案月份 payroll_calc 不帶 force 仍回 locked；帶 force 回 finalized，run 不變 draft', () => {
  const { m } = payFixture();
  assert.ok(m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' }).ok);
  assert.ok(m.sb.handlePayrollFinalize({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', lock: true }).ok);
  assert.strictEqual(m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF' }).error, 'locked');
  assert.strictEqual(m.sb.handlePayrollCalc({ admin_key: 'ADM', ym: '2026-11', store: 'SSLGF', force: true }).error, 'finalized');
  assert.strictEqual(m.sb.payRead('run')[0].status, 'final');
});
ok('特休年資：月底到職補滿 6 個月與其他到職日對照（1/15、8/1、2/28、2/29、12/31 結果不變）', () => {
  const m = make();
  const tm = (h, ym) => m.sb.payTenureMonths(h, ym);
  assert.strictEqual(tm('2025-08-31', '2026-02'), 6);
  assert.strictEqual(m.sb.payAnnualQuota('2025-08-31', '2026-02').days, 3);
  assert.strictEqual(tm('2025-08-31', '2026-01'), 5);
  assert.strictEqual(tm('2025-01-15', '2025-07'), 6);
  assert.strictEqual(tm('2025-08-01', '2026-01'), 5);
  assert.strictEqual(tm('2025-08-01', '2026-02'), 6);
  assert.strictEqual(tm('2025-02-28', '2025-08'), 6);
  assert.strictEqual(tm('2024-02-29', '2024-08'), 6);
  assert.strictEqual(tm('2025-12-31', '2026-06'), 6);
  assert.strictEqual(tm('2025-12-31', '2026-05'), 5);
  assert.strictEqual(m.sb.payAnnualQuota('2025-01-15', '2025-07').days, 3);
  assert.strictEqual(m.sb.payAnnualQuota('2025-08-01', '2026-02').days, 3);
  assert.strictEqual(m.sb.payAnnualQuota('2025-08-01', '2026-01').days, 0);
});
ok('忘打卡補昨天跨夜下班：現在 00:30、補 03:00(+1) 擋；補 00:10 收（對照已在上方）', () => {
  const { m } = lineFixture('2026-11-04T00:30:00', [['2026-11-03T22:00:00', 'in']]);
  assert.strictEqual(sub(m, { kind: 'miss', date: '2026-11-03', miss_type: 'out', end: '03:00', reason: '忘記按' }).error, 'bad_time');
});
ok('「我的申請」：超過 60 天但仍審核中、請假日還沒到的單保留；已核准／已過日期的舊單不保留', () => {
  const { m } = lineFixture('2026-08-01T10:00:00');
  const r = sub(m, { kind: 'leave', date: '2026-10-20', leave_type: '特休假', hours: 8 });
  const r2 = sub(m, { kind: 'leave', date: '2026-08-20', leave_type: '特休假', hours: 8 });
  assert.ok(r.ok && r2.ok);
  m.setNow('2026-10-25T10:00:00');   // 距 8/1 已 85 天
  let ids = m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).requests.map((x) => x.id);
  eq(ids, []);
  m.setNow('2026-10-05T10:00:00');
  ids = m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).requests.map((x) => x.id);
  eq(ids, [r.request.id]);
});
ok('LINE 查班表：已發布但本人 28 格全空 → no_schedule；完全沒發布 → not_locked', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'PK', SCHED_STORE_FROM: '2026-11-01' }, now: T('2026-11-04T10:00:00') });
  const e = hire(m, '測試甲'); bindLine(m, e.emp_id, 'U1');
  assert.strictEqual(m.sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' }).status, 'not_locked');
  assert.ok(PUB(m, { rows: [{ emp_id: e.emp_id, name: '測試甲', cells: Array.from({ length: 28 }, () => ({ t: '' })) }] }).ok);
  assert.strictEqual(m.sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' }).status, 'no_schedule');
});
ok('sched_day_roster：錯金鑰另有 60/分節流；正確金鑰不受影響，全站上限 300', () => {
  const m = make({ props: { SCHED_READ_KEY: 'RK', SCHED_STORE_FROM: '2026-11-01' } });
  for (let i = 0; i < 61; i++) m.sb.handleSchedDayRoster_({ key: 'wrong', date: '2026-11-04' });
  assert.strictEqual(m.sb.handleSchedDayRoster_({ key: 'wrong', date: '2026-11-04' }).error, 'too_many');
  for (let i = 0; i < 300; i++) assert.ok(m.sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-04' }).ok, '第 ' + i + ' 次');
  assert.strictEqual(m.sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-04' }).error, 'too_many');
});

console.log('\n━━ 結果 ━━');
console.log('ok ' + nOk + '；KNOWN 待修 ' + nKnownOpen + '；KNOWN 已修好 ' + nKnownFixed + '；失敗 ' + failed);
if (failed || (process.env.ADV_STRICT && nKnownOpen)) process.exit(1);
