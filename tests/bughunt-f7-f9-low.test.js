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
  const props = Object.assign({ REQ_BIND_FROM: 'off' }, opts.props || {});   // 這支測薪資：核定綁定申請單（2026-11-06）另由 req-bind.test.js 測
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
  // 2026-11 起鎖定前會檢查「每天都在已發布班表上查得到」；這支測的是鎖定本身，班表檢查由 ot-daily.test.js 守
  if (!opts.schedCheck) sb.paySchedMissingAll_ = () => [];
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


// ===== 2026-11-13 打卡驗收 F7、F9（低嚴重度，見 ~/Desktop/Claude/系統/打卡/報告/驗收QA_20261110/驗收報告.md）=====
ok('F7 sync_roster 把既有工號改名成另一位在職同仁的名字 → 略過回 duplicate_name，名字不變', () => {
  const m = make();
  const a = hire(m, '測試甲'); const b = hire(m, '測試乙');
  const r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: b.emp_id, name: '測試甲' }] });
  assert.ok(r.ok, JSON.stringify(r));
  eq(r.skipped, [{ emp_id: String(b.emp_id), reason: 'duplicate_name' }]);
  const rowB = m.rows('roster').filter((x) => String(x.emp_id) === String(b.emp_id))[0];
  assert.strictEqual(rowB.name, '測試乙');
  assert.ok(a.emp_id);
});
ok('F7 改回自己原本的名字、或同名那位已離職 → 照常更新', () => {
  const m = make();
  const a = hire(m, '測試甲'); const b = hire(m, '測試乙');
  let r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: a.emp_id, name: '測試甲' }] });
  eq(r.skipped || [], []);
  r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: a.emp_id, name: '測試甲', active: false }, { emp_id: b.emp_id, name: '測試甲' }] });
  eq(r.skipped || [], []);
  assert.strictEqual(m.rows('roster').filter((x) => String(x.emp_id) === String(b.emp_id))[0].name, '測試甲');
});
ok('F7 同一批把甲改名成丙、乙改名成甲（互換）→ 照順序判斷，乙不撞名', () => {
  const m = make();
  const a = hire(m, '測試甲'); const b = hire(m, '測試乙');
  const r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: a.emp_id, name: '測試丙' }, { emp_id: b.emp_id, name: '測試甲' }] });
  eq(r.skipped || [], []);
});
ok('F9 月表狀態欄：忘刷註記與核定帶回的狀態同一句時只出現一次', () => {
  const m = make();
  const roster = [{ emp_id: 'E01', name: '測試一', active: 'true' }];
  const events = [{ ts: '2026-10-06T09:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }];
  const appr = [{ date: '2026-10-06', emp_id: 'E01', approved_hours: 8, status_text: '下班忘刷卡', entered_at: '2026-10-07T10:00:00+08:00' }];
  const out = m.sb.buildMonthlySheet('2026-10', roster, events, [], '2026-11-13', appr);
  const row = out.rows.filter((r) => r[0] === '2026-10-06')[0];
  assert.ok(row, '找不到 10/06 那列');
  assert.strictEqual(row[5], '下班忘刷卡');
});
ok('F9 不同的註記照舊都列出、順序不變', () => {
  const m = make();
  const roster = [{ emp_id: 'E01', name: '測試一', active: 'true' }];
  const events = [{ ts: '2026-10-06T09:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }];
  const appr = [{ date: '2026-10-06', emp_id: 'E01', approved_hours: 8, status_text: '遲到5分', entered_at: '2026-10-07T10:00:00+08:00' }];
  const row = m.sb.buildMonthlySheet('2026-10', roster, events, [], '2026-11-13', appr).rows.filter((r) => r[0] === '2026-10-06')[0];
  assert.strictEqual(row[5], '下班忘刷卡、遲到5分');
});

console.log(`\n${nOk} 過、${failed} 失敗`);
if (failed) process.exit(1);
