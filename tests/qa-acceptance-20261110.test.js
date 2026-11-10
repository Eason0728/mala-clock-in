// 驗收測試（2026-11-10 QA 驗收時加）：正常 3 組＋異常 3 組，一律走真的入口 doPost → 真函式，試算表用 tests/helpers/sheets-like.js。
// 跑法：node tests/qa-acceptance-20261110.test.js（run-all.js 會自動帶到）
//   ok(name, fn)    ＝ 目前規則下該成立的行為；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 驗收時查到「和預期不一樣」的地方，寫的是預期的結果，目前會失敗；只印出、不擋 run-all。
//                     修好或確認後把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束。
// 名字一律假名；不含金鑰、試算表 ID；只在本機跑，不碰任何正式網址。
'use strict';
process.env.TZ = 'Asia/Taipei';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const SL = require('./helpers/sheets-like');
const ROOT = path.join(__dirname, '..');
const SRC = ['Code.gs', 'Liff.gs', 'Rest.gs', 'Requests.gs'].map((f) => [f, fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')]);

let nOk = 0, failed = 0, nKnownOpen = 0, nKnownFixed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e.stack || e).split('\n').slice(0, 2).join(' | ')); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已不成立，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待處理] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};

/* ── 時間（台北）與沙盒 ── */
const T = (s) => Date.parse(s + '+08:00');
const z = (v) => ('0' + v).slice(-2);
function formatDate(d, tz, pattern) {
  const x = new Date(d.getTime() + 8 * 3600000);
  const tok = { yyyy: x.getUTCFullYear(), MM: z(x.getUTCMonth() + 1), dd: z(x.getUTCDate()), HH: z(x.getUTCHours()), mm: z(x.getUTCMinutes()), ss: z(x.getUTCSeconds()), XXX: '+08:00', M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours() };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|XXX|M|d|H/g, (m, q) => (q !== undefined ? q : String(tok[m])));
}
function make(now, props) {
  props = Object.assign({}, props || {});
  const cache = {};
  const sb = { console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseFloat, parseInt, Logger: { log: () => {} }, __now: T(now) };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(sb.__now); } static now() { return sb.__now; } };
  sb.CacheService = { getScriptCache: () => ({
    get: (k) => { const e = cache[k]; if (!e) return null; if (e.exp <= sb.__now) { delete cache[k]; return null; } return e.v; },
    put: (k, v, ttl) => { cache[k] = { v: String(v), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; },
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
  };
  sb.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 400, getContentText: () => '{"error":"invalid"}' }) };
  sb.ScriptApp = { getProjectTriggers: () => [], deleteTrigger: () => {} };
  sb.ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: (s) => ({ setMimeType: () => s }) };
  vm.createContext(sb);
  const ss = SL.createSpreadsheet({ id: 'SELF', DateCtor: sb.Date, now: () => sb.__now, defaultMaxCols: 40 });
  sb.SpreadsheetApp = { openById: () => ss, getActive: () => ss, getActiveSpreadsheet: () => ss, flush: () => {} };
  SRC.forEach(([f, src]) => vm.runInContext(src, sb, { filename: f }));
  const c = (name) => vm.runInContext(name, sb);
  vm.runInContext("Object.assign(CONFIG, { STORE_LAT: 24.7840945, STORE_LNG: 121.0157448, RADIUS_M: 20, ADMIN_KEY: 'ADM', DEFAULT_SHIFT_IN: '', DEFAULT_SHIFT_OUT: '', NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '', PAYROLL_API: '', PAYROLL_STORE: '' })", sb);
  sb.setup();
  ss.getSheetByName('managers').appendRow(['值班主管', 'MK', 'true']);
  const m = { sb, ss, c, sheet: (n) => ss.getSheetByName(n), setNow: (v) => { sb.__now = T(v); },
    rows: (n) => sb.readSheetAsObjects(ss.getSheetByName(n)).rows,
    isDate: (v) => vm.runInContext('(function (v) { return v instanceof Date; })', sb)(v) };
  /** 走真的入口 doPost（Liff.gs／Requests.gs 掛上去、會蓋掉同名動作的處理函式也在內） */
  m.api = (body) => JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(body) } }));
  /** 名冊加一位在職同仁（像人在試算表打字） */
  m.addEmp = (emp_id, name, key) => { const H = c('ROSTER_HEADERS'); ss.getSheetByName('roster').appendRow(H.map((h) => ({ emp_id, name, key, active: 'true' }[h] || ''))); };
  /** 門市正北 d 公尺打一張卡（沿經線走，距離剛好 d） */
  m.punch = (t, key, type, o) => { o = o || {}; m.setNow(t);
    const b = { action: 'clock', key, type, device_id: o.dev || 'DEV-' + key, lat: c('CONFIG.STORE_LAT') + (o.d === undefined ? 3 : o.d) / (Math.PI * 6371000 / 180), lng: c('CONFIG.STORE_LNG') };
    if (o.acc !== null) b.accuracy = o.acc === undefined ? 5 : o.acc;
    return m.api(b); };
  m.approve = (t, emp, date, periods, extra) => { m.setNow(t);
    return m.api(Object.assign({ action: 'mgr_approve', mgr_key: 'MK', date, emp_id: emp, periods: periods.map((p) => ({ start: p[0], end: p[1] })), leaves: [] }, extra || {})); };
  m.day = (date, emp) => m.api({ action: 'mgr_day', mgr_key: 'MK', date }).employees.filter((e) => e.emp_id === emp)[0];
  /** 重算月表後讀回：sum[姓名]＝彙總列、det[姓名][日期]＝明細列 */
  m.month = (ym) => { sb.rebuildMonth(ym); const sh = ss.getSheetByName(ym); const v = sh.getRange(1, 1, sh.getLastRow(), 6).getValues(); const hdr = v.findIndex((r) => r[0] === '日期');
    const sum = {}; v.slice(1, hdr).forEach((r) => { if (r[0] !== '') sum[r[0]] = { ref: r[1], appr: r[2], abnormal: r[3] }; });
    const det = {}; let who = null;
    v.slice(hdr + 1).forEach((r) => { if (r[0] === '' || r[0] === '小計') return; if (m.isDate(r[0])) (det[who] = det[who] || {})[sb.normCellDate(r[0])] = { seg: r[2], ref: r[3], appr: r[4], status: r[5] }; else who = r[0]; });
    return { sum, det }; };
  return m;
}
const D = '2026-11-09';

console.log('━━ 正常 3 組 ━━');
ok('正常 1｜需求的例子 11:02–14:31＋17:05–21:44：參考時數 7.5（主管頁、同仁頁、月表都一樣）', () => {
  const m = make(D + 'T07:00:00'); m.addEmp('E01', '測試一', 'K1');
  [['11:02:10', 'in'], ['14:31:50', 'out'], ['17:05:05', 'in'], ['21:44:59', 'out']].forEach(([t, ty]) => assert.strictEqual(m.punch(D + 'T' + t, 'K1', ty).status, 'ok'));
  m.setNow(D + 'T21:50:00');
  assert.strictEqual(m.day(D, 'E01').reference, 7.5);
  assert.strictEqual(m.api({ action: 'whoami', key: 'K1', device_id: 'DEV-K1' }).today_hours.reference, 7.5);
  m.setNow('2026-11-10T10:00:00'); const mo = m.month('2026-11');
  assert.strictEqual(mo.det['測試一'][D].ref, 7.5); assert.strictEqual(mo.sum['測試一'].ref, 7.5);
  assert.strictEqual(mo.det['測試一'][D].seg, '11:02–14:31、17:05–21:44');
});
let stdRef = null;
ok('正常 2｜標準答案那筆打卡（08:46／13:48／13:48／17:30）核定 09:00–13:30＋14:00–17:30：核定 8、狀態正常、月表異常 0', () => {
  const m = make(D + 'T07:00:00'); m.addEmp('DZY041', '測試同仁', 'K1');
  [['08:46:12', 'in'], ['13:48:05', 'out'], ['13:48:40', 'in'], ['17:30:20', 'out']].forEach(([t, ty]) => assert.strictEqual(m.punch(D + 'T' + t, 'K1', ty, { d: 6, acc: 12 }).status, 'ok'));
  const a = m.approve(D + 'T17:40:00', 'DZY041', D, [['09:00', '13:30'], ['14:00', '17:30']], { late_min: '' });
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.strictEqual(a.approved_hours, 8); assert.strictEqual(a.status_text, '正常'); assert.ok(!/遲到/.test(a.status_text));
  m.setNow('2026-11-10T21:30:00'); const mo = m.month('2026-11');
  assert.strictEqual(mo.sum['測試同仁'].abnormal, 0); assert.strictEqual(mo.sum['測試同仁'].appr, 8);
  stdRef = mo.det['測試同仁'][D].ref;
  // 照需求 5 的規則：08:46→09:00、13:48→13:45＝4.75；13:48→14:00、17:30→17:30＝3.5；合計 8.25
  assert.strictEqual(stdRef, 8.25);
  assert.strictEqual(m.day(D, 'DZY041').reference, 8.25);
});
ok('正常 3｜跨夜班 22:03–隔天 01:07：歸上班那天、班段寫 (+1)、參考 2.75；核定 22:00–01:00＝3 小時', () => {
  const m = make('2026-11-08T20:00:00'); m.addEmp('E01', '測試一', 'K1');
  m.punch('2026-11-08T22:03:10', 'K1', 'in'); m.punch('2026-11-09T01:07:20', 'K1', 'out'); m.setNow('2026-11-09T01:10:00');
  const d8 = m.day('2026-11-08', 'E01');
  assert.strictEqual(JSON.stringify(d8.segments), JSON.stringify([{ in: '22:03', out: '01:07', cross: true }]));
  assert.strictEqual(d8.reference, 2.75);
  assert.strictEqual(m.day('2026-11-09', 'E01').segments.length, 0, '隔天不能再出現一次');
  const a = m.approve('2026-11-09T01:15:00', 'E01', '2026-11-08', [['22:00', '01:00']]);
  assert.strictEqual(a.ok, true, JSON.stringify(a)); assert.strictEqual(a.approved_hours, 3);
  m.setNow('2026-11-10T10:00:00'); const mo = m.month('2026-11');
  assert.strictEqual(mo.det['測試一']['2026-11-08'].seg, '22:03–01:07(+1)');
  assert.strictEqual(mo.det['測試一']['2026-11-09'], undefined);
});

console.log('━━ 異常 3 組 ━━');
ok('異常 1｜定位：170 公尺 ±2000 判超出範圍且不入帳；剛好 20 公尺算範圍內、20.1 公尺被擋；121 公尺 ±2000 也被擋', () => {
  const m = make(D + 'T08:00:00'); ['E01', 'E02', 'E03', 'E04'].forEach((e, i) => m.addEmp(e, '測試' + (i + 1), 'K' + (i + 1)));
  const far = m.punch(D + 'T09:00:00', 'K1', 'in', { d: 170, acc: 2000 });
  assert.strictEqual(far.status, 'rejected_out_of_range'); assert.strictEqual(far.within_range, false); assert.strictEqual(far.low_accuracy, true);
  assert.strictEqual(m.day(D, 'E01').segments.length, 0, '被擋的卡不能算進打卡段'); assert.strictEqual(m.day(D, 'E01').attempts, 1);
  assert.strictEqual(m.punch(D + 'T09:00:00', 'K2', 'in', { d: 20, acc: 0 }).status, 'ok');
  assert.strictEqual(m.punch(D + 'T09:00:00', 'K3', 'in', { d: 20.1, acc: 0 }).status, 'rejected_out_of_range');
  assert.strictEqual(m.punch(D + 'T09:00:00', 'K4', 'in', { d: 121, acc: 2000 }).status, 'rejected_out_of_range');
});
ok('異常 2｜10 分鐘內連打兩次上班：第二張 rejected_duplicate、不算數，當天仍只有 09:00–18:00 一段', () => {
  const m = make(D + 'T08:00:00'); m.addEmp('E01', '測試一', 'K1');
  assert.strictEqual(m.punch(D + 'T09:00:00', 'K1', 'in').status, 'ok');
  const dup = m.punch(D + 'T09:05:00', 'K1', 'in');
  assert.strictEqual(dup.status, 'rejected_duplicate'); assert.strictEqual(dup.last_type, 'in');
  assert.strictEqual(m.punch(D + 'T18:00:00', 'K1', 'out').status, 'ok');
  const d = m.day(D, 'E01');
  assert.strictEqual(JSON.stringify(d.segments), JSON.stringify([{ in: '09:00', out: '18:00', cross: false }]));
  assert.strictEqual(d.reference, 9);
});
ok('異常 3｜只有上班卡沒有下班卡：當天顯示「上班中」不算異常；隔天參考留白、標「下班忘刷卡」、月表異常 1 天', () => {
  const m = make('2026-11-10T08:00:00'); m.addEmp('E01', '測試一', 'K1');
  m.punch('2026-11-10T09:00:00', 'K1', 'in');
  m.setNow('2026-11-10T12:00:00'); let mo = m.month('2026-11');
  assert.strictEqual(mo.det['測試一']['2026-11-10'].status, '上班中'); assert.strictEqual(mo.sum['測試一'].abnormal, 0);
  m.setNow('2026-11-11T12:00:00'); mo = m.month('2026-11');
  assert.strictEqual(mo.det['測試一']['2026-11-10'].status, '下班忘刷卡'); assert.strictEqual(mo.det['測試一']['2026-11-10'].ref, '');
  assert.strictEqual(mo.sum['測試一'].abnormal, 1);
  assert.strictEqual(m.day('2026-11-10', 'E01').reference, null, '主管頁那天的參考時數要留白');
});

console.log('━━ 驗收時查到、等確認的兩件事（不擋 run-all）━━');
KNOWN('標準答案寫「參考時數 7.75」：同一筆打卡照需求 5 的規則算出來是 8.25（見正常 2）', () => {
  assert.strictEqual(stdRef, 7.75, '程式=' + stdRef + '、標準答案=7.75');
});
KNOWN('店長把 17:55 那張認定為重複打卡之後，月表不該再標「下班忘刷卡」、異常天數要是 0（主管頁與同仁頁都已經是 17:26–21:00 一段）', () => {
  const m = make(D + 'T08:00:00'); m.addEmp('E01', '測試一', 'K1');
  m.punch(D + 'T17:26:00', 'K1', 'in'); m.punch(D + 'T17:55:00', 'K1', 'in'); m.punch(D + 'T21:00:00', 'K1', 'out');
  const a = m.approve(D + 'T21:10:00', 'E01', D, [['17:30', '21:00']], { dup_ignore: [D + 'T17:55:00+08:00'] });
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.strictEqual(JSON.stringify(m.day(D, 'E01').segments), JSON.stringify([{ in: '17:26', out: '21:00', cross: false }]));
  m.setNow('2026-11-10T10:00:00'); const mo = m.month('2026-11');
  const got = mo.det['測試一'][D].seg + '｜' + mo.det['測試一'][D].status + '｜異常 ' + mo.sum['測試一'].abnormal;
  assert.strictEqual(got, '17:26–21:00｜主管認定重複打卡（17:55）｜異常 0', '月表=' + got);
});

console.log('\n共 ' + (nOk + failed) + ' 組：通過 ' + nOk + '、失敗 ' + failed + '；等確認 ' + nKnownOpen + ' 件' + (nKnownFixed ? '（另有 ' + nKnownFixed + ' 件已不成立，可改成 ok）' : ''));
if (failed || (process.env.ADV_STRICT === '1' && nKnownOpen)) process.exit(1);
