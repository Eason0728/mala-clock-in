// Google 試算表轉型保真測試（2026-11-03，分支 test/sheets-fidelity）
//
// 既有測試把儲存格當純字串，真的試算表會把 '2026-07-14' 轉成 Date、'11:00' 轉成 1899-12-30 的時間、'8' 轉成數字、
// 'false' 轉成布林——過去兩次真的出事（2026-07-15 approved.date、2026-08-23 roster.shift_in）mock 都測不出來。
// 這裡用 tests/helpers/sheets-like.js（照 Sheets 規則轉型的假試算表，規則與出處見該檔檔頭）把真函式的寫→讀跑一遍：
//   ok(name, fn)    ＝ 行為正確，當迴歸守門；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 已確認「真函式在 Sheets 轉型後行為錯」的問題，寫的是「應該要」的行為，目前會失敗。
//                     只印出、不擋 run-all；修好後會變成 ✓，再把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束。
// 名字一律用假名；不含任何金鑰、試算表 ID。只在本機跑，不碰任何正式網址。
'use strict';
process.env.TZ = 'Asia/Taipei';   // ⚠ 要在任何 Date 使用之前：normShiftTime／payDateStr 用 getHours()/getDate()，要跟正式專案的時區一致
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const SL = require('./helpers/sheets-like');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { code: R('apps-script/Code.gs'), liff: R('apps-script/Liff.gs'), rest: R('apps-script/Rest.gs'), req: R('apps-script/Requests.gs'),
              pay: R('apps-script/Payroll.gs'), sched: R('apps-script/SchedPub.gs'), hub: R('apps-script/LineHub.gs') };

let nOk = 0, nKnownOpen = 0, nKnownFixed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e.stack || e).split('\n').slice(0, 2).join(' | ')); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已修好，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待修] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};
/** vm 裡建的陣列／物件原型與主程式不同，deepStrictEqual 會說「結構相同但不是同一個參照」→ 一律轉 JSON 比 */
const eq = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}

/* ── 時間（台北）── */
const T = (s) => Date.parse(s + '+08:00');
const z = (v) => ('0' + v).slice(-2);
function taipei(ms) { const x = new Date(ms + 8 * 3600000); return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() }; }
function formatDate(d, tz, pattern) {
  const t = taipei(d.getTime());
  const tok = { yyyy: t.y, MM: z(t.M), dd: z(t.d), HH: z(t.H), mm: z(t.m), ss: z(t.s), XXX: '+08:00', M: t.M, d: t.d, H: t.H };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|XXX|M|d|H/g, (m, q) => (q !== undefined ? q : String(tok[m])));
}
const iso = (ms) => formatDate(new Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");

/** 沙盒：整檔載入 Code.gs／Liff.gs／Rest.gs／Requests.gs／Payroll.gs／SchedPub.gs／LineHub.gs，
 *  試算表換成 sheets-like（在 vm 的 Date realm 建 Date）。可控時鐘 sb.__now、有 TTL 的快取、假 LINE 驗證（TOK_<uid> → uid）。 */
function make(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sb = {
    console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, unescape, escape,
    Logger: { log: () => {} }, __now: opts.now || T('2026-07-14T10:00:00'), __fetches: [],
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
  sb.UrlFetchApp = { fetch: (url, o) => {
    sb.__fetches.push({ url, o });
    const u = users[o && o.payload && o.payload.id_token];
    const body = u ? JSON.stringify({ sub: u.sub, aud: u.aud || '2011292256', exp: u.exp || Math.floor(sb.__now / 1000) + 3600 }) : '{"error":"invalid"}';
    return { getResponseCode: () => (u ? 200 : 400), getContentText: () => body };
  } };
  sb.ScriptApp = { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => { const c = { timeBased: () => c, atHour: () => c, everyDays: () => c, everyHours: () => c, nearMinute: () => c, create: () => ({}) }; return c; } };
  sb.ContentService = { MimeType: { JSON: 'JSON' }, createTextOutput: (s) => ({ setMimeType: () => s }) };
  sb.DriveApp = { getFolderById: () => { throw new Error('沙盒沒有雲端硬碟'); }, getFileById: () => { throw new Error('沙盒沒有雲端硬碟'); } };
  vm.createContext(sb);
  // 新分頁放寬到 40 欄：payroll_master 有 27 欄，真的 Sheets 新分頁只有 26 欄會丟例外（正式試算表顯然已擴欄，這裡只測型別）
  const ss = SL.createSpreadsheet({ id: 'SELF', DateCtor: sb.Date, now: () => sb.__now, defaultMaxCols: opts.maxCols || 40 });
  sb.SpreadsheetApp = { openById: () => ss, getActive: () => ss, getActiveSpreadsheet: () => ss, flush: () => {} };
  ['code', 'liff', 'rest', 'req', 'pay', 'sched', 'hub'].forEach((k) => vm.runInContext(SRC[k], sb, { filename: k + '.gs' }));
  // Code.gs 的 const（CONFIG、ROSTER_HEADERS…）在 vm 裡是全域「詞法」綁定，不會掛在 sb 上，要用 c(name) 進去拿
  const c = (name) => vm.runInContext(name, sb);
  vm.runInContext("Object.assign(CONFIG, { STORE_LAT: 24.78, STORE_LNG: 121.01, RADIUS_M: 20, ADMIN_KEY: 'ADM', DEFAULT_SHIFT_IN: '', DEFAULT_SHIFT_OUT: '', PAYROLL_API: '', PAYROLL_STORE: '' })", sb);
  sb.LINE_HUB_STORES_CONFIG = [{ code: '', name: '光復', ss_id: 'SELF' }, { code: 'mztjs', name: '金山', ss_id: 'SS_mztjs' }];
  sb.setup();   // 真的 setup()：roster／events／leave／approved／notes／managers／notices 表頭
  ss.getSheetByName('managers').appendRow(['值班主管', 'MK', 'true']);   // 像人打進去：'true' 會變布林
  const rows = (n) => sb.readSheetAsObjects(ss.getSheetByName(n)).rows;
  return { sb, ss, props, rows, c, sheet: (n) => ss.getSheetByName(n), setNow: (v) => { sb.__now = T(v); },
           isVmDate: (v) => vm.runInContext('(function (v) { return v instanceof Date; })', sb)(v) };
}
const HERE = { lat: 24.78, lng: 121.01, accuracy: 5 };
/** 用真的 mgr_add_employee 開一位同仁（名冊 appendRow＋created_at 鎖文字），回 {emp_id, key} */
function hire(m, name) { const r = m.sb.handleMgrAddEmployeeUnlocked_({ mgr_key: 'MK', name: name || '測試一' }); assert.ok(r.ok, JSON.stringify(r)); return r; }
const punch = (m, key, type, extra) => m.sb.handleClock(Object.assign({ key, type, device_id: 'D1' }, HERE, extra || {}));
const describe = (sh, r, c) => { const d = sh.describe(r, c); return (d.raw ? d.raw.k : 'empty') + (d.fmt ? '(' + d.fmt + ')' : ''); };

/* ════════════════════════════════════════════════════════════════════════
   0. 假 Sheet 自我驗證（規則本身＋兩個歷史 bug 的舊寫法能不能重現）
   ════════════════════════════════════════════════════════════════════════ */
console.log('━━ 0. 假試算表本身：轉型規則、在 vm realm 建 Date、歷史 bug 重現 ━━');
ok("'2026-07-14' 寫進去讀回是 vm realm 的 Date＝台北 2026-07-14 00:00（UTC 07-13 16:00），formatDate 回得到 yyyy-MM-dd", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['2026-07-14', '2026/7/4', '2026-13-45']);
  const v = sh.getRange(1, 1, 1, 3).getValues()[0];
  assert.strictEqual(m.isVmDate(v[0]), true, 'instanceof vm Date');
  assert.strictEqual(v[0].getTime(), Date.UTC(2026, 6, 13, 16));
  assert.strictEqual(m.sb.normCellDate(v[0]), '2026-07-14');
  assert.strictEqual(m.sb.normCellDate(v[1]), '2026-07-04');
  assert.strictEqual(v[2], '2026-13-45', '不存在的日期維持文字');
});
ok("'11:00'／'09:00' 讀回是 1899-12-30 的時間 Date（String 開頭 \"Sat Dec 30 1899\"），getHours 在台北時區＝11／9", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['11:00', '09:00', '9:00', '1:30 PM', '11:00:30', '09:00-13:00', '09:00-13:00,14:00-18:00', '25:00']);
  const v = sh.getRange(1, 1, 1, 8).getValues()[0];
  assert.ok(/^Sat Dec 30 1899 11:00:00/.test(String(v[0])), String(v[0]));
  assert.strictEqual(v[0].getHours() * 60 + v[0].getMinutes(), 11 * 60);
  assert.strictEqual(v[1].getHours(), 9, '前導零只是顯示，值還是 9 點');
  assert.strictEqual(v[2].getHours(), 9);
  assert.strictEqual(v[3].getHours(), 13);
  assert.strictEqual(v[4].getSeconds(), 30);
  assert.strictEqual(v[5], '09:00-13:00', '時段字串不轉');
  assert.strictEqual(v[6], '09:00-13:00,14:00-18:00');
  assert.strictEqual(m.isVmDate(v[7]), true, "'25:00' 當時間長度（推定）");
});
ok("數字：'8'→8、'0.5'→0.5、'00123'→123（前導零掉了）、'0912345678'→912345678、'1e3'→1000、'2026'→2026；'1,000'／'50%'／' 12 ' 為推定", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['8', '0.5', '00123', '0912345678', '1e3', '2026', '1,000', '50%', ' 12 ', '-5', '+123', '3.', '.5', 'E01', '1e3x']);
  const v = sh.getRange(1, 1, 1, 15).getValues()[0];
  eq(v.slice(0, 13), [8, 0.5, 123, 912345678, 1000, 2026, 1000, 0.5, 12, -5, 123, 3, 0.5]);
  assert.strictEqual(v[13], 'E01'); assert.strictEqual(v[14], '1e3x');
});
ok("布林：'TRUE'／'true'／'False' 都變布林（不分大小寫）；'FALSE '（尾端空白）維持文字（推定）", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['TRUE', 'true', 'False', 'FALSE ', 'yes']);
  eq(sh.getRange(1, 1, 1, 5).getValues()[0], [true, true, false, 'FALSE ', 'yes']);
});
ok("ISO 8601 含 T 的時間戳（+08:00／Z／無時區）維持文字；'yyyy-MM-dd HH:mm:ss'（空白）變日期時間；'2026-08' 變 8/1 的日期（正式環境觀察）", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['2026-07-14T09:00:00+08:00', '2026-07-14T09:00:00Z', '2026-07-14T09:00:00', '2026-07-14 09:00:00', '2026/07/14 9:00', '2026-08']);
  const v = sh.getRange(1, 1, 1, 6).getValues()[0];
  eq(v.slice(0, 3), ['2026-07-14T09:00:00+08:00', '2026-07-14T09:00:00Z', '2026-07-14T09:00:00']);
  assert.strictEqual(m.sb.normCellTs(v[3]), '2026-07-14T09:00:00+08:00');
  assert.strictEqual(m.sb.normCellTs(v[4]), '2026-07-14T09:00:00+08:00');
  assert.strictEqual(m.sb.normCellDate(v[5]), '2026-08-01');
});
ok("純文字格式 '@'：寫入前先設 → 字串原樣；寫入後才設 → 值已是序號（'11:00'→0.4583…、'2026-07-14'→46217）（推定）", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.getRange(1, 1, 1, 3).setNumberFormat('@').setValues([['2026-07-14', '11:00', '00123']]);
  eq(sh.getRange(1, 1, 1, 3).getValues()[0], ['2026-07-14', '11:00', '00123']);
  sh.getRange(2, 1, 1, 2).setValues([['2026-07-14', '11:00']]);
  sh.getRange(2, 1, 1, 2).setNumberFormat('@');
  const v = sh.getRange(2, 1, 1, 2).getValues()[0];
  assert.strictEqual(v[0], 46217); assert.ok(Math.abs(v[1] - 11 / 24) < 1e-9, String(v[1]));
  sh.getRange('C:C').setNumberFormat('@'); sh.appendRow(['x', 'y', '2026-07-14']);   // 整欄鎖文字：之後 appendRow 也維持文字
  assert.strictEqual(sh.getRange(3, 3).getValue(), '2026-07-14');
});
ok("'=' 開頭變公式（記在 sheet.formulas）、前面有空白的 '   =SUM' 是文字、開頭單引號會被拿掉", () => {
  const m = make(); const sh = m.ss.insertSheet('t');
  sh.appendRow(['=SUM(1,2)', '   =SUM(1,2)', "'2026-07-14", '＝IMPORTDATA(x)']);
  assert.strictEqual(sh.formulas.length, 1);
  eq(sh.getRange(1, 2, 1, 3).getValues()[0], ['   =SUM(1,2)', '2026-07-14', '＝IMPORTDATA(x)']);
});
ok('格線：getRange 超出 getMaxRows／getMaxColumns 丟例外、appendRow 自動長列、getLastRow 只算有內容的列、deleteRow 會把格式一起往上搬、同名 insertSheet 丟例外', () => {
  const m = make({ maxCols: 26 }); const sh = m.ss.insertSheet('t');
  assert.throws(() => sh.getRange(1001, 1), /invalid/);
  assert.throws(() => sh.getRange(1, 27), /invalid/);
  for (let i = 0; i < 1001; i++) sh.appendRow(['r' + i]);
  assert.strictEqual(sh.getLastRow(), 1001); assert.strictEqual(sh.getMaxRows(), 1001);
  sh.getRange(5, 2).setValue(''); assert.strictEqual(sh.getLastColumn(), 1, "寫 '' ＝清空，不算有內容");
  sh.getRange(3, 1).setNumberFormat('@'); sh.deleteRow(2);
  sh.getRange(2, 1).setValue('2026-07-14'); assert.strictEqual(sh.getRange(2, 1).getValue(), '2026-07-14', '原第 3 列的 @ 搬到第 2 列');
  assert.throws(() => m.ss.insertSheet('t'), /already exists/);
  assert.strictEqual(m.ss.getSheetByName('roster').getLastRow(), 1, 'setup() 只有表頭');
});

/* 歷史 bug 1：2026-07-15（commit f399cca）approved.date 被轉成 Date，buildLatestApprovedMap 用 tsDateStr 切 10 字對不上。
   舊寫法取自 `git show f399cca^:apps-script/Code.gs`（下面內嵌；有 git 時順便核對內嵌版與當年原文一致）。 */
const OLD_BUILD_LATEST = `function buildLatestApprovedMap_old(approvedRecords) {
  const map = {};
  approvedRecords.forEach(function (r) {
    const d = tsDateStr(r.date);
    const emp = String(r.emp_id);
    if (!map[d]) map[d] = {};
    const existing = map[d][emp];
    if (!existing || String(r.entered_at) > String(existing.entered_at)) {
      map[d][emp] = r;
    }
  });
  return map;
}`;
function gitShow(ref) { try { return execFileSync('git', ['show', ref], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } }
ok('歷史 bug 2026-07-15 重現：舊版 buildLatestApprovedMap（tsDateStr）拿到假 Sheet 讀回的 Date 後，核定紀錄「寫得進去、查不回來」；現版查得到', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T20:00:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }] });
  assert.ok(r.ok, JSON.stringify(r));
  const approved = m.rows('approved');
  assert.strictEqual(m.isVmDate(approved[0].date), true, '假 Sheet 把 date 轉成了 Date');
  const old = gitShow('f399cca^:apps-script/Code.gs');
  if (old) assert.strictEqual(extract(old, 'buildLatestApprovedMap').replace('buildLatestApprovedMap', 'buildLatestApprovedMap_old'), OLD_BUILD_LATEST, '內嵌的舊寫法要與 git 歷史一字不差');
  vm.runInContext(OLD_BUILD_LATEST, m.sb);
  const oldMap = m.sb.buildLatestApprovedMap_old(approved);
  assert.strictEqual(oldMap['2026-07-14'], undefined, '舊寫法：用 2026-07-14 查不到');
  assert.ok(Object.keys(oldMap)[0].indexOf('Tue Jul 14') === 0, '舊寫法的 key 是 ' + Object.keys(oldMap)[0]);
  const newMap = m.sb.buildLatestApprovedMap(approved);
  assert.strictEqual(newMap['2026-07-14'][e.emp_id].approved_hours, 9, '現版（normCellDate）查得到');
});
/* 歷史 bug 2：2026-08-23（commit 7712e29）roster.shift_in '11:00' 讀回 Date，原始值直接丟給 <input type="time"> 整個不顯示。
   舊寫法＝沒有 normShiftTime、直接 String(r.shift_in)。 */
ok("歷史 bug 2026-08-23 重現：名冊 shift_in 填 '11:00' 讀回是 Date，舊寫法 String() 得到 \"Sat Dec 30 1899 11:00:00…\"（不是 HH:mm）；現版 normShiftTime 回 '11:00'", () => {
  const m = make(); hire(m);
  const sh = m.sheet('roster'), c = m.c('ROSTER_HEADERS').indexOf('shift_in') + 1;
  sh.getRange(2, c).setValue('11:00');   // 像 Eason 直接在名冊打字
  const v = m.rows('roster')[0].shift_in;
  assert.strictEqual(m.isVmDate(v), true);
  assert.ok(!/^\d{2}:\d{2}$/.test(String(v)) && /^Sat Dec 30 1899 11:00:00/.test(String(v)), String(v));
  assert.strictEqual(m.sb.normShiftTime(v), '11:00');
});
/* 歷史 bug 3：2026-08-23（commit 074ed30）payroll_leave_type.count_meal_day 存 'false' 被轉成布林 FALSE，
   舊寫法 String(r.x || '') 把 false 吃成 ''→ 判成 true → 出差又給餐費。舊寫法取自 git show 074ed30^:apps-script/Payroll.gs。 */
ok("歷史 bug 2026-08-23 重現（布林陷阱）：leave_type 寫 'false' 讀回布林 false，舊寫法 String(r.count_meal_day || '') 判成 true；現版 payLeaveTypes 回 false", () => {
  const m = make();
  const r = m.sb.handlePayrollLeaveTypeSet({ admin_key: 'ADM', store: '', types: [
    { code: 'trip', name: '出差', pay_ratio: 1, count_absent: false, offset_shortfall: false, count_meal_day: false, active: true, sort: 10, attend_effect: 'none' },
    { code: 'sick', name: '病假', pay_ratio: 0.5, count_absent: true, offset_shortfall: true, count_meal_day: true, active: true, sort: 20 }] });
  assert.ok(r.ok, JSON.stringify(r));
  const raw = m.sb.payRead('leave_type').filter((x) => x.code === 'trip')[0];
  assert.strictEqual(raw.count_meal_day, false, '假 Sheet 把 \'false\' 轉成布林');
  const old = gitShow('074ed30^:apps-script/Payroll.gs');
  if (old) assert.ok(old.indexOf("(String(r.count_meal_day || '').toLowerCase() === 'false') ? false : true") >= 0, 'git 歷史裡找得到舊寫法');
  const oldVal = (String(raw.count_meal_day || '').toLowerCase() === 'false') ? false : true;
  assert.strictEqual(oldVal, true, '舊寫法判錯成 true（重現）');
  assert.strictEqual(m.sb.payLeaveTypes('SSLGF').filter((t) => t.code === 'trip')[0].count_meal_day, false, '現版正確');
});

/* ════════════════════════════════════════════════════════════════════════
   1. events：handleClock 寫、readEventsSince／liffEvents_／lastCountedEvent／pairShifts 讀
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 1. events ━━');
ok('handleClock 寫一列：ts（ISO 含 +08:00）維持文字、lat/lng/distance 數字、within_range/device_match 布林、accuracy 數字；讀回 lastCountedEvent／liffGuard_ 正常', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T09:00:00');
  const r = punch(m, e.key, 'in'); assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  const sh = m.sheet('events');
  eq(sh.typeMap()[1], 'ttt' + 'nnn' + 'b' + 't' + 'b' + 't' + 'n', sh.typeMap()[1]);
  const row = m.sb.readEventsSince(sh, m.sb.__now - 3600000).rows[0];
  assert.strictEqual(row.ts, '2026-07-14T09:00:00+08:00'); assert.strictEqual(typeof row.ts, 'string');
  assert.strictEqual(row.within_range, true); assert.strictEqual(row.distance_m, 0); assert.strictEqual(row.accuracy_m, 5);
  eq(m.sb.lastCountedEvent([row], e.emp_id), { ts: '2026-07-14T09:00:00+08:00', type: 'in' });
  const g = m.sb.liffGuard_(m.sb.liffEvents_(m.ss), e.emp_id);
  assert.strictEqual(g.last.hm, '09:00'); assert.strictEqual(g.blocked, 'in');
  m.setNow('2026-07-14T09:05:00');
  assert.strictEqual(punch(m, e.key, 'in').status, 'rejected_duplicate', '10 分鐘內同型被擋');
});
ok('上班＋下班兩張卡讀回：pairShifts／dayPunchSegments／handleMgrDay／handleMyRecent 的 HH:mm 與日期都對', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-14T18:00:00'); punch(m, e.key, 'out');
  const evs = m.sb.liffEvents_(m.ss);
  const p = m.sb.pairShifts(evs);
  assert.strictEqual(p.shifts.length, 1); assert.strictEqual(p.unmatchedIns.length, 0);
  assert.strictEqual(m.sb.tsHm(p.shifts[0].in_ts) + '-' + m.sb.tsHm(p.shifts[0].out_ts), '09:00-18:00');
  const seg = m.sb.dayPunchSegments(evs, e.emp_id, '2026-07-14');
  assert.strictEqual(JSON.stringify(Array.from(seg.segments, (s) => s.in + '-' + s.out)), JSON.stringify(['09:00-18:00']));
  assert.strictEqual(seg.reference, 9);
  const day = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' });
  assert.strictEqual(day.employees[0].segments[0].in, '09:00'); assert.strictEqual(day.employees[0].reference, 9);
  const my = m.sb.handleMyRecent({ key: e.key, device_id: 'D1' });
  assert.strictEqual(my.days[0].date, '2026-07-14'); assert.strictEqual(my.days[0].segments[0].out, '18:00');
  const ge = m.sb.handleGetEvents({ admin_key: 'ADM', from: '2026-07-14', to: '2026-07-14' });
  assert.strictEqual(ge.events.length, 2); assert.strictEqual(typeof ge.events[0].ts, 'string');
});
ok('換手機：新裝置打卡→pending_device_approval；主管核准後讀回 within_range（布林 true）翻成 ok、device_match 寫 true、名冊改綁、重算該月月表', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-14T18:00:00');
  assert.strictEqual(punch(m, e.key, 'out', { device_id: 'D2' }).status, 'pending_device_approval');
  const r = m.sb.handleMgrDeviceDecision({ mgr_key: 'MK', emp_id: e.emp_id, device_id: 'D2', approve: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.changed, 1); eq(r.rebuilt, ['2026-07']);
  const ev = m.rows('events')[1];
  assert.strictEqual(ev.status, 'ok'); assert.strictEqual(ev.device_match, true); assert.strictEqual(ev.within_range, true);
  assert.strictEqual(m.rows('roster')[0].device_id, 'D2'); assert.strictEqual(m.rows('roster')[0].device_bound_at, '2026-07-14T18:00:00+08:00');
  assert.ok(m.sheet('2026-07').getLastRow() > 0, '月表重算有寫出來');
});
ok('手機沒回報定位誤差：accuracy_m 寫空字串、讀回是空格（不是 0），回應 accuracy_m=null', () => {
  const m = make(); const e = hire(m);
  const r = punch(m, e.key, 'in', { accuracy: undefined });
  assert.strictEqual(r.accuracy_m, null);
  assert.strictEqual(m.rows('events')[0].accuracy_m, '');
});
ok('Requests.gs reqDayInfo_／reqOtHint_ 與 Rest.gs restCheckIn_ 讀同一份 events（ISO 字串）正常：16 小時配對、超過 8 小時提示加班', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-14T18:30:00'); punch(m, e.key, 'out');
  const evs = m.sb.liffEvents_(m.ss);
  const di = m.sb.reqDayInfo_(evs, e.emp_id, '2026-07-14');
  eq(di.missing.options, ['break']); assert.strictEqual(di.punches.length, 2);
  const hint = m.sb.reqOtHint_(evs, e.emp_id, '2026-07-14T18:30:00+08:00', []);
  assert.strictEqual(hint.hours, 9.5); assert.strictEqual(hint.end, '18:30');
  m.props.REST_RULE_ON = '1';
  m.setNow('2026-07-16T14:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-16T23:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-17T08:00:00');
  const rb = m.sb.restCheckIn_(m.ss, m.rows('roster')[0]);
  assert.ok(rb && rb.code === 'gap', '隔天 9 小時後再上班：兩班間隔不足 11 小時要擋 ' + JSON.stringify(rb));
  assert.strictEqual(punch(m, e.key, 'in').status, 'rejected_rest');
});

/* ════════════════════════════════════════════════════════════════════════
   2. approved：handleMgrApprove 寫、buildLatestApprovedMap／mgr_day／my_recent／薪資 讀
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 2. approved ━━');
ok("handleMgrApprove 寫一列：date 變 Date、periods '09:00-13:00,14:00-18:00' 維持文字、approved_hours 數字、entered_at 維持文字；mgr_day／my_recent／month_totals／薪資都讀得回來", () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in'); m.setNow('2026-07-14T13:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-14T14:00:00'); punch(m, e.key, 'in'); m.setNow('2026-07-14T18:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-14T20:00:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] });
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.approved_hours, 8);
  const sh = m.sheet('approved');
  assert.strictEqual(sh.typeMap()[1], 'dtttnttt', sh.typeMap()[1]);
  const row = m.rows('approved')[0];
  assert.strictEqual(row.periods, '09:00-13:00,14:00-18:00'); assert.strictEqual(row.approved_hours, 8); assert.strictEqual(row.entered_at, '2026-07-14T20:00:00+08:00');
  const day = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' });
  eq(JSON.parse(JSON.stringify(day.employees[0].approved.periods)), [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }]);
  assert.strictEqual(day.employees[0].approved.approved_hours, 8);
  const my = m.sb.handleMyRecent({ key: e.key, device_id: 'D1' });
  assert.strictEqual(my.days[0].approved, 8); assert.strictEqual(my.days[0].approved_status, '正常');
  assert.strictEqual(my.month_totals.this_month === undefined ? JSON.stringify(my.month_totals).indexOf('8') >= 0 : true, true);
  assert.strictEqual(m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id].hours, 8);
  assert.strictEqual(m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id].work_days, 1);
  const pp = m.sb.handlePayrollPunch({ admin_key: 'ADM', ym: '2026-07', store: 'SSLGF' });
  assert.strictEqual(pp.rows[0].approved_hours, 8); assert.strictEqual(pp.rows[0].periods, '09:00-13:00,14:00-18:00'); assert.strictEqual(pp.summary[0].hours, 8);
});
ok('同一天核定兩次：entered_at（文字）比大小取最新；整天請假核定 0 小時讀回是 0 不是「待核定」', () => {
  const m = make(); const e = hire(m); hire(m, '測試二');
  m.setNow('2026-07-14T20:00:00');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }] });
  m.setNow('2026-07-14T21:00:00');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '17:00' }] });
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: 'E02', periods: [], leaves: [{ type: '事假', hours: 8 }] });
  const map = m.sb.buildLatestApprovedMap(m.rows('approved'));
  assert.strictEqual(map['2026-07-14'][e.emp_id].approved_hours, 8);
  assert.strictEqual(map['2026-07-14'].E02.approved_hours, 0); assert.strictEqual(map['2026-07-14'].E02.status_text, '全天請假');
  const e2 = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' }).employees.filter((x) => x.emp_id === 'E02')[0];
  assert.strictEqual(e2.approved.approved_hours, 0); assert.strictEqual(e2.approved.status_text, '全天請假'); eq(e2.approved.periods, []);
  assert.strictEqual(m.sb.handleMyRecent({ key: m.rows('roster')[1].key, device_id: 'D1' }).month_totals.current.hours, 0);
});

/* ════════════════════════════════════════════════════════════════════════
   3. leave：replaceLeaveRows 寫（經 handleMgrApprove）、讀回時數與日期
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 3. leave ━━');
ok('核定夾帶請假註記：leave 分頁 日期變 Date、時數變數字；mgr_day／payCollect／出勤紀錄匯出都讀得到；重新核定會刪舊列（deleteRow）再寫', () => {
  const m = make(); const e = hire(m);
  m.setNow('2026-07-14T20:00:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '15:00' }], leaves: [{ type: '病假', hours: 2 }, { type: '事假', hours: '' }] });
  assert.ok(r.ok, JSON.stringify(r));
  const sh = m.sheet('leave');
  eq(sh.typeMap().slice(1), ['dttn', 'dtt.']);
  assert.strictEqual(m.rows('leave')[0]['時數'], 2); assert.strictEqual(m.rows('leave')[1]['時數'], '');
  const day = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' });
  eq(JSON.parse(JSON.stringify(day.employees[0].leaves)), [{ type: '病假', hours: 2 }, { type: '事假', hours: '' }]);
  const c = m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id];
  assert.strictEqual(c.sick_h, 2); assert.strictEqual(c.leaves.sick, 2); assert.strictEqual(c.personal_h, 0); assert.strictEqual(c.deduct_days, 1);
  const ex = m.sb.handlePayrollAttendanceExport({ admin_key: 'ADM', store: 'SSLGF', ym: '2026-07' });
  const d14 = ex.employees[0].days[13];
  assert.strictEqual(d14.date, '2026-07-14'); assert.strictEqual(d14.leave_hours, 2); assert.strictEqual(d14.approved_hours, 6);
  assert.strictEqual(m.sb.leaveRowsOf(m.ss, '2026-07-14', '測試一').length, 2, 'leaveRowsOf 用 normCellDate 對得到 Date');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '15:00' }], leaves: [{ type: '特休假', hours: 3 }] });
  eq(m.rows('leave').map((x) => x['假別'] + ':' + x['時數']), ['特休假:3']);
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }], leaves: [] });
  assert.strictEqual(m.rows('leave').length, 0, '改回無＝清掉');
});

/* ════════════════════════════════════════════════════════════════════════
   4. requests：Requests.gs 寫 date／start／end／hours／created_at／attach_id，reqRows_ 讀回、重複檢查、核定頁預填
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 4. requests ━━');
function bindLine(m, key) { const r = m.sb.handleLiffBind_({ key, id_token: 'TOK_U1' }); assert.ok(r.ok, JSON.stringify(r)); return r; }
ok("req_submit 建的 requests 分頁 A:V 先鎖文字：date／start／end／hours／created_at／attach_id 全是文字；reqRows_ 讀回 date 'yyyy-MM-dd'、start 'HH:mm'、hours 數字；重送同一筆→duplicate；核准後 mgr_req_day 預填得到", () => {
  const m = make(); const e = hire(m); bindLine(m, e.key);
  m.setNow('2026-07-14T21:00:00');
  const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: '2026-07-14', start: '18:00', end: '20:30', reason: '補貨' });
  assert.ok(r.ok, JSON.stringify(r));
  const sh = m.sheet('requests');
  assert.strictEqual(sh.typeMap()[1].slice(0, 14), 'tttttt.ttn.t.t', sh.typeMap()[1]);   // hours 是程式給的數字（鎖文字不改型別，推定）；空欄＝.
  assert.strictEqual(describe(sh, 2, 6), 'text(@)', 'date'); assert.strictEqual(describe(sh, 2, 8), 'text(@)', 'start'); assert.strictEqual(describe(sh, 2, 2), 'text(@)', 'created_at');
  const row = m.sb.reqRows_(m.ss)[0];
  assert.strictEqual(row.date, '2026-07-14'); assert.strictEqual(row.start, '18:00'); assert.strictEqual(row.end, '20:30'); assert.strictEqual(row.hours, 2.5);
  assert.strictEqual(row.created_at, '2026-07-14T21:00:00+08:00'); assert.strictEqual(row.status, 'pending');
  const dup = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: '2026-07-14', start: '18:00', end: '20:30', reason: '補貨' });
  assert.strictEqual(dup.error, 'duplicate');
  const dec = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' });
  assert.ok(dec.ok, JSON.stringify(dec));
  const day = m.sb.handleMgrReqDay_({ mgr_key: 'MK', date: '2026-07-14' });
  const o = day.by_emp[e.emp_id][0];
  assert.strictEqual(o.start + '-' + o.end, '18:00-20:30'); assert.strictEqual(o.hours, 2.5); assert.strictEqual(o.status, 'approved');
  assert.ok(/^2026-07-14T21:00:00\+08:00$/.test(o.decided_at), o.decided_at);
  const dup2 = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: '2026-07-14', start: '19:00', end: '21:00', reason: '補貨' });
  assert.strictEqual(dup2.error, 'duplicate', '已核准的同一件事（時段重疊）也擋：reqSameThing_ 用讀回的 start/end 比');
  const mon = m.sb.handleMgrReqMonth_({ mgr_key: 'MK', ym: '2026-07' });
  assert.strictEqual(mon.items.length, 1); assert.strictEqual(mon.items[0].hours, 2.5);
});
ok('requests 分頁是人手建的（沒鎖文字）：date／start／end 被轉成 Date、hours 變數字，reqRows_（normCellDate／reqHm_）照樣讀對、重複檢查與預填不受影響', () => {
  const m = make(); const e = hire(m); bindLine(m, e.key);
  const sh = m.ss.insertSheet('requests'); sh.getRange(1, 1, 1, m.c('REQ_HEADERS_').length).setValues([m.c('REQ_HEADERS_')]);
  m.setNow('2026-07-14T21:00:00');
  const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', date: '2026-07-20', leave_type: '事假', start: '09:00', end: '12:00', reason: '家裡有事' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(sh.typeMap()[1].slice(0, 10), 'tttttdtddn', sh.typeMap()[1]);
  const row = m.sb.reqRows_(m.ss)[0];
  assert.strictEqual(row.date, '2026-07-20'); assert.strictEqual(row.start, '09:00'); assert.strictEqual(row.end, '12:00'); assert.strictEqual(row.hours, 3);
  assert.strictEqual(m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', date: '2026-07-20', leave_type: '事假', hours: 8, reason: 'x' }).error, 'duplicate');
  m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' });
  const o = m.sb.handleMgrReqDay_({ mgr_key: 'MK', date: '2026-07-20' }).by_emp[e.emp_id][0];
  assert.strictEqual(o.leave_type + ' ' + o.start + '-' + o.end + ' ' + o.hours, '事假 09:00-12:00 3');
  const a = m.sb.handleReqAttach_({ id_token: 'TOK_U1', id: r.request.id, attach_id: '1AbCdEfGhIjKlMnOp-_234567' });
  assert.strictEqual(a.error, 'not_pending', '核准後不能再補附（流程正確）');
});
ok('忘打卡申請「中間休息」核准後，payCollect 讀 requests（date 經 normCellDate）把兩張卡只算一次忘刷', () => {
  const m = make(); const e = hire(m); bindLine(m, e.key);
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-14T18:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-14T18:10:00');
  const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'miss', date: '2026-07-14', miss_type: 'break', end: '12:00', start: '13:00', reason: '忘了' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' }).ok);
  m.setNow('2026-07-14T20:00:00');
  const ap = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }] });
  assert.ok(/第一段下班無打卡/.test(ap.status_text) && /第二段上班無打卡/.test(ap.status_text), ap.status_text);
  const c = m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id];
  assert.strictEqual(c.forget_punch, 1); assert.strictEqual(c.forget_day, 1);
});

/* ════════════════════════════════════════════════════════════════════════
   5. roster：shift_in／shift_out、created_at、removed_at、line_bound_at、line_ok_at、key／emp_id 純數字
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 5. roster ━━');
ok('mgr_add_employee：created_at 鎖文字、active 布林、key（英數 20 碼）文字；打第一張卡綁裝置 device_bound_at 維持文字；recent_hires／mgr_roster 讀得回', () => {
  const m = make(); m.setNow('2026-07-14T10:00:00'); const e = hire(m);
  const sh = m.sheet('roster'), H = m.c('ROSTER_HEADERS');
  assert.strictEqual(describe(sh, 2, H.indexOf('created_at') + 1), 'text(@)');
  assert.strictEqual(describe(sh, 2, H.indexOf('active') + 1), 'bool');
  assert.ok(/^[A-Za-z0-9]{20}$/.test(e.key) && /^text/.test(describe(sh, 2, H.indexOf('key') + 1)));   // 2026-11-04 起 key 欄整欄鎖 '@'（text(@)）
  assert.strictEqual(punch(m, e.key, 'in').status, 'ok');
  assert.strictEqual(m.rows('roster')[0].device_bound_at, '2026-07-14T10:00:00+08:00');
  assert.strictEqual(m.rows('roster')[0].device_id, 'D1');
  const rh = m.sb.handleRecentHires({ admin_key: 'ADM', days: 7 });
  assert.strictEqual(rh.hires[0].created_at, '2026-07-14T10:00:00+08:00');
  assert.strictEqual(m.sb.handleMgrRoster({ mgr_key: 'MK' }).roster[0].removed_at, '');
});
ok('mgr_set_active 離職：removed_at 鎖文字、active 變 false 布林；mgr_roster／打卡 invalid_key；恢復在職後又能打', () => {
  const m = make(); const e = hire(m); m.setNow('2026-07-20T10:00:00');
  assert.ok(m.sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: e.emp_id, active: false }).ok);
  const row = m.rows('roster')[0];
  assert.strictEqual(row.active, false); assert.strictEqual(row.removed_at, '2026-07-20T10:00:00+08:00'); assert.strictEqual(row.removed_by, '值班主管');
  assert.strictEqual(m.sb.handleMgrRoster({ mgr_key: 'MK' }).roster[0].removed_at, '2026-07-20T10:00:00+08:00');
  assert.strictEqual(punch(m, e.key, 'in').error, 'invalid_key');
  assert.ok(m.sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: e.emp_id, active: true }).ok);
  assert.strictEqual(m.rows('roster')[0].removed_at, ''); assert.strictEqual(punch(m, e.key, 'in').status, 'ok');
});
ok('liff_bind：line_user_id 文字、line_bound_at 鎖文字；LINE 打卡成功寫 line_ok_at（鎖文字）；liffRosterByLine_ 找得到人、liff_bind_log 的 ts 維持文字', () => {
  const m = make(); const e = hire(m); m.setNow('2026-07-14T10:00:00');
  bindLine(m, e.key);
  const sh = m.sheet('roster'), H = m.c('ROSTER_HEADERS');
  assert.strictEqual(describe(sh, 2, H.indexOf('line_bound_at') + 1), 'text(@)');
  assert.strictEqual(m.rows('roster')[0].line_bound_at, '2026-07-14T10:00:00+08:00');
  assert.strictEqual(m.sb.liffRosterByLine_('U1').roster.emp_id, e.emp_id);
  const r = m.sb.handleLiffPunch_({ id_token: 'TOK_U1', type: 'in', lat: 24.78, lng: 121.01, accuracy: 5 });
  assert.ok(r.ok, JSON.stringify(r));
  const c = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].indexOf('line_ok_at') + 1;
  assert.ok(c > 0, '表頭補了 line_ok_at'); assert.strictEqual(describe(sh, 2, c), 'text(@)');
  assert.strictEqual(sh.getRange(2, c).getValue(), '2026-07-14T10:00:00+08:00');
  assert.strictEqual(m.rows('liff_bind_log')[0].ts, '2026-07-14T10:00:00+08:00');
});
ok("名冊 shift_in 由人直接打 '11:00'（讀回 Date）：mgr_day 預填 '11:00'（2026-08-23 的修法持續有效）", () => {
  const m = make(); hire(m);
  const sh = m.sheet('roster'), H = m.c('ROSTER_HEADERS');
  sh.getRange(2, H.indexOf('shift_in') + 1).setValue('11:00'); sh.getRange(2, H.indexOf('shift_out') + 1).setValue('20:00');
  const emp = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' }).employees[0];
  assert.strictEqual(emp.shift_in + '-' + emp.shift_out, '11:00-20:00');
});
ok("set_shifts 第一次執行：先 setValue('11:00') 再把整欄設 '@' → 值已被轉成時間序號 0.4583（推定規則 15），normShiftTime 認不得 → mgr_day 預填空白（應為 '11:00'）", () => {
  const m = make(); const e = hire(m);
  const r = m.sb.handleSetShifts({ admin_key: 'ADM', shifts: [{ emp_id: e.emp_id, shift_in: '11:00', shift_out: '20:00' }] });
  assert.ok(r.ok, JSON.stringify(r));
  const emp = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' }).employees[0];
  assert.strictEqual(emp.shift_in + '-' + emp.shift_out, '11:00-20:00', '讀回的格子內容：' + JSON.stringify(m.rows('roster')[0].shift_in));
});
ok("set_shifts 第二次執行（欄位已是 '@'）：寫入維持文字，mgr_day 預填正確", () => {
  const m = make(); const e = hire(m);
  m.sb.handleSetShifts({ admin_key: 'ADM', shifts: [{ emp_id: e.emp_id, shift_in: '11:00', shift_out: '20:00' }] });
  m.sb.handleSetShifts({ admin_key: 'ADM', shifts: [{ emp_id: e.emp_id, shift_in: '11:00', shift_out: '20:00' }] });
  const emp = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-14' }).employees[0];
  assert.strictEqual(emp.shift_in + '-' + emp.shift_out, '11:00-20:00');
});

/* ════════════════════════════════════════════════════════════════════════
   6. notices（ends_on 日期）
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 6. notices ━━');
ok("mgr_add_notice：ends_on '2026-07-20' 變 Date、active 布林、created_at 文字；activeNotices 含當天顯示、隔天下架；mgr_notices 回 'yyyy-MM-dd'；下架後不顯示", () => {
  const m = make(); m.setNow('2026-07-14T10:00:00');
  const r = m.sb.handleMgrAddNotice({ mgr_key: 'MK', text: '明天盤點，請提早到', ends_on: '2026-07-20' });
  assert.ok(r.ok, JSON.stringify(r));
  const sh = m.sheet('notices');
  assert.strictEqual(sh.typeMap()[1], 'ttbdtt', sh.typeMap()[1]);
  assert.strictEqual(m.sb.activeNotices(m.ss, '2026-07-20').length, 1);
  assert.strictEqual(m.sb.activeNotices(m.ss, '2026-07-21').length, 0);
  const list = m.sb.handleMgrNotices({ mgr_key: 'MK' }).notices[0];
  assert.strictEqual(list.ends_on, '2026-07-20'); assert.strictEqual(list.expired, false); assert.strictEqual(list.created_at, '2026-07-14T10:00:00+08:00');
  assert.ok(m.sb.handleMgrSetNoticeActive({ mgr_key: 'MK', id: r.id, active: false }).ok);
  assert.strictEqual(m.sb.activeNotices(m.ss, '2026-07-14').length, 0);
  assert.strictEqual(m.sb.handleMgrNotices({ mgr_key: 'MK' }).notices[0].active, false);
});
ok("公告內容若剛好是數字樣式（例：'0800'）：notices.text 沒鎖文字，Sheets 轉成數字 800，打卡頁輪播顯示 '800'（應原樣 '0800'）", () => {
  const m = make();
  const r = m.sb.handleMgrAddNotice({ mgr_key: 'MK', text: '0800', ends_on: '' });
  assert.ok(r.ok);
  assert.strictEqual(m.sb.activeNotices(m.ss, '2026-07-14')[0].text, '0800');
});

/* ════════════════════════════════════════════════════════════════════════
   7. sched_pub（SchedPub.gs payload 存讀）
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 7. sched_pub ━━');
ok("sched_publish：整列先鎖 '@' 再寫，store 空字串、period 'T01'、seq、data JSON、updated_at 都讀得回；同 op_id 冪等、小 seq→stale、unpublish 留墓碑、再發布只有一列", () => {
  const m = make({ props: { SCHED_SVC_KEY: 'SK' } }); hire(m);
  const cells = []; for (let i = 0; i < 28; i++) cells.push(i % 7 === 6 ? { t: 'R' } : { t: 'W', s: 'A' });
  const base = { svcKey: 'SK', v: 1, store: '', period: 'T01', start: '2026-11-01', days: 28,
                 shifts: [{ id: 'A', name: 'A班', start: '11:00', end: '20:00', break_min: 60 }], rows: [{ emp_id: 'E01', name: '測試一', cells }] };
  eq(m.sb.handleSchedPublish_(Object.assign({ seq: 1, op_id: 'op-1' }, base)), { ok: true, seq: 1 });
  const sh = m.sheet('sched_pub');
  assert.strictEqual(sh.typeMap()[1], '.tnttt', sh.typeMap()[1]);   // store 空字串＝空格；seq 是程式給的數字；其餘全文字
  assert.strictEqual(sh.getRange(2, 1).getValue(), ''); assert.strictEqual(sh.getRange(2, 2).getValue(), 'T01');
  eq(m.sb.handleSchedPublish_(Object.assign({ seq: 1, op_id: 'op-1' }, base)), { ok: true, seq: 1 }, '同 op_id 重送＝回上次結果');
  assert.strictEqual(m.sb.handleSchedPublish_(Object.assign({ seq: 1, op_id: 'op-2' }, base)).error, 'stale');
  const pub = m.sb.schedPubLoad_();
  assert.strictEqual(pub['|T01'].rows[0].cells[0].s, 'A'); assert.strictEqual(pub['|T01'].start, '2026-11-01');
  const days = m.sb.schedPubDaysFor_(pub, [{ st: { code: '' }, row: { emp_id: 'E01' } }], ['2026-11-01', '2026-11-07']);
  assert.strictEqual(days['2026-11-01'].hours, 8); assert.strictEqual(days['2026-11-07'].label, '例假');
  eq(m.sb.handleSchedUnpublish_({ svcKey: 'SK', v: 1, store: '', period: 'T01', seq: 2, op_id: 'op-3' }), { ok: true, seq: 2 });
  eq(m.sb.schedPubReadSheet_(null, false), {}, '墓碑：data 空，不列');
  eq(m.sb.handleSchedPublish_(Object.assign({ seq: 3, op_id: 'op-4' }, base)), { ok: true, seq: 3 });
  assert.strictEqual(sh.getLastRow(), 2, '一店一期只有一列');
  assert.strictEqual(m.sb.schedPubReadSheet_(null, false)['|T01'].rows.length, 1);
});

/* ════════════════════════════════════════════════════════════════════════
   8. punch_timing（LineHub.gs 寫、punch_timing_get 讀）
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 8. punch_timing ━━');
ok("line_punch_timing 寫一列（ts 文字、store 空字串、毫秒數字、refix/qr 布林）；punch_timing_get 依日期讀回、型別不變", () => {
  const m = make(); const e = hire(m); bindLine(m, e.key); m.setNow('2026-07-14T21:30:00');
  m.sb.lineHubMine_ = (uid) => (uid === 'U1' ? [{ st: { code: '' }, row: { emp_id: e.emp_id, name: '測試一' } }] : []);
  const r = m.sb.handleLinePunchTiming_({ id_token: 'TOK_U1', store: '', type: 'out', outcome: 'ok', status: 'ok', total_ms: 2345.6, geo_ms: 0, server_ms: 2100, refix: false, qr: true, accuracy_m: 12.4,
                                          steps: { verify: 150, roster: 320, read: 210, write: 1800, extra: 40 }, req_id: 'r0123456789abcdef', route: 'predicted', predict: 'ok', predict_ms: 900 });
  eq(r, { ok: true });
  const sh = m.sheet('punch_timing');
  assert.strictEqual(sh.typeMap()[1], 't.tttt' + 'nnn' + 'bb' + 'n' + 'nnnnn' + 'ttt' + 'n', sh.typeMap()[1]);   // store 空字串＝空格
  assert.strictEqual(sh.getRange(2, 2).getValue(), '', '光復店代碼空字串');
  const got = m.sb.handlePunchTimingGet_({ admin_key: 'ADM', from: '2026-07-14', to: '2026-07-14' });
  assert.strictEqual(got.rows.length, 1);
  const o = got.rows[0];
  assert.strictEqual(o.ts, '2026-07-14T21:30:00+08:00'); assert.strictEqual(o.store, ''); assert.strictEqual(o.emp_id, e.emp_id);
  assert.strictEqual(o.total_ms, 2346); assert.strictEqual(o.refix, false); assert.strictEqual(o.qr, true); assert.strictEqual(o.accuracy_m, 12);
  assert.strictEqual(o.srv_write_ms, 1800); assert.strictEqual(o.req_id, 'r0123456789abcdef'); assert.strictEqual(o.predict_ms, 900);
  assert.strictEqual(m.sb.handlePunchTimingGet_({ admin_key: 'ADM', from: '2026-07-15', to: '2026-07-15' }).rows.length, 0);
});

/* ════════════════════════════════════════════════════════════════════════
   9. qr_punch（主管 QR 打卡：reqQrLog_ 寫）
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 9. qr_punch ━━');
ok('主管 QR 打卡（mgr_qr_token → liff_punch 帶 qr）：events 用店家座標寫 ok，qr_punch 多一列 ts 文字／工號／型別／出示的主管', () => {
  const m = make(); const e = hire(m); bindLine(m, e.key); m.setNow('2026-07-14T10:00:00');
  const tk = m.sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'gk' });
  assert.ok(tk.ok, JSON.stringify(tk));
  m.sb.__now += 5000;
  const r = m.sb.handleLiffPunch_({ id_token: 'TOK_U1', type: 'in', qr: tk.token });
  assert.ok(r.ok && r.via_qr, JSON.stringify(r));
  const ev = m.rows('events')[0];
  assert.strictEqual(ev.status, 'ok'); assert.strictEqual(ev.lat, 24.78); assert.strictEqual(ev.distance_m, 0);
  const q = m.rows('qr_punch')[0];
  assert.strictEqual(q.ts, '2026-07-14T10:00:05+08:00'); assert.strictEqual(q.emp_id, e.emp_id); assert.strictEqual(q.type, 'in'); assert.strictEqual(q.qr_manager, '值班主管');
  assert.strictEqual(m.sheet('qr_punch').typeMap()[1], 'tttt');
});

/* ════════════════════════════════════════════════════════════════════════
   10. Payroll.gs：讀打卡分頁的範圍（payCollect／payAttendanceBuild／payroll_punch）＋薪資自己的分頁
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 10. Payroll ━━');
function monthFixture() {
  const m = make(); const e = hire(m); hire(m, '測試二');
  // 7/14 正常一天＋病假 2H；7/15 上班忘打下班；7/16 遲到 5 分核定
  m.setNow('2026-07-14T09:00:00'); punch(m, e.key, 'in'); m.setNow('2026-07-14T18:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-14T20:00:00');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-14', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }], leaves: [{ type: '病假', hours: 2 }] });
  m.setNow('2026-07-15T09:00:00'); punch(m, e.key, 'in');
  m.setNow('2026-07-16T09:05:00'); punch(m, e.key, 'in'); m.setNow('2026-07-16T18:00:00'); punch(m, e.key, 'out');
  m.setNow('2026-07-16T20:00:00');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-07-16', emp_id: e.emp_id, periods: [{ start: '09:00', end: '18:00' }] });
  m.setNow('2026-07-20T10:00:00');
  return { m, e };
}
ok('payCollect 吃真寫入的 approved／leave／events：核定 18H、病假 2H、忘刷 1 次、遲到 5 分、缺勤 3 天、餐費出勤 2 天', () => {
  const { m, e } = monthFixture();
  const c = m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id];
  assert.strictEqual(c.hours, 18); assert.strictEqual(c.sick_h, 2); assert.strictEqual(c.forget_punch, 1); assert.strictEqual(c.forget_day, 1);
  assert.strictEqual(c.late_min, 5); assert.strictEqual(c.deduct_days, 3); assert.strictEqual(c.work_days, 2);
});
ok('payAttendanceBuild（出勤紀錄匯出）：逐日 segments／approved_hours／status_text／leave 都對，忘刷那天 approved null、pending_days 1', () => {
  const { m, e } = monthFixture();
  const ex = m.sb.handlePayrollAttendanceExport({ admin_key: 'ADM', store: 'SSLGF', ym: '2026-07' });
  const me = ex.employees.filter((x) => x.emp_id === e.emp_id)[0];
  const d14 = me.days[13], d15 = me.days[14], d16 = me.days[15];
  eq(JSON.parse(JSON.stringify(d14.segments)), [{ in: '09:00', out: '18:00', cross: false }]);
  assert.strictEqual(d14.approved_hours, 9); assert.strictEqual(d14.leave_hours, 2); assert.strictEqual(d14.leave[0].type, '病假');
  assert.strictEqual(d15.approved_hours, null); assert.strictEqual(d15.segments[0].out, null);
  assert.strictEqual(d16.status_text, '遲到5分');
  eq(me.totals, { approved_hours: 18, leave_hours: 2, work_days: 2, pending_days: 1 });
});
ok('handlePayrollPunch：rows 的打卡時間 HH:mm、核定時數；summary 的 hours／leave_h／miss／late 與 payCollect 同口徑', () => {
  const { m, e } = monthFixture();
  const pp = m.sb.handlePayrollPunch({ admin_key: 'ADM', ym: '2026-07', store: 'SSLGF' });
  const r14 = pp.rows.filter((r) => r.date === '2026-07-14' && r.emp_id === e.emp_id)[0];
  eq(r14.punches.map((p) => p.time + p.type), ['09:00in', '18:00out']); assert.strictEqual(r14.approved_hours, 9);
  const s = pp.summary.filter((x) => x.emp_id === e.emp_id)[0];
  assert.strictEqual(s.hours, 18); assert.strictEqual(s.leave_h, 2); assert.strictEqual(s.miss, 1); assert.strictEqual(s.late, 1);
});
ok("薪資自己的分頁：holiday.ym／dates、master.hire_date／leave_date 先鎖文字（payForceTextCols）→ 單一日期 '2026-10-10' 讀回文字；is_full_time 'true' 變布林但 payIsFt 認得", () => {
  const m = make();
  assert.ok(m.sb.handlePayrollHolidaySet({ admin_key: 'ADM', store: '', holidays: [{ ym: '2026-10', red_days: 9, note: '', dates: '2026-10-10' }] }).ok);
  const hol = m.sb.payHolidayRow('2026-10', 'SSLGF');
  assert.strictEqual(hol.ym, '2026-10'); eq(m.sb.payHolidayDates(hol), ['2026-10-10']);
  assert.strictEqual(m.sheet('payroll_holiday').typeMap()[1], 'tn.t.', m.sheet('payroll_holiday').typeMap()[1]);   // ym 文字、red_days 數字、note 空、dates 文字、store 空
  assert.ok(m.sb.handlePayrollMasterSet({ admin_key: 'ADM', store: 'SSLGF', master: [{ emp_id: 'E01', name: '測試一', is_full_time: 'true', base: 30000, wage: 0, hire_date: '2021-01-01', leave_date: '', active: 'true' }] }).ok);
  const ms = m.sb.payRead('master')[0];
  assert.strictEqual(ms.hire_date, '2021-01-01'); assert.strictEqual(ms.is_full_time, true); assert.strictEqual(m.sb.payIsFt(ms), true);
  assert.strictEqual(m.sb.payDateStr(ms.hire_date), '2021-01-01'); assert.strictEqual(m.sb.payAnnualQuota(ms.hire_date, '2026-07').days, 15);
  assert.strictEqual(ms.updated_at, m.sb.nowTaipeiIso());
});
ok("payroll_config：late_deduct 'true' 變布林，payBool 認得；數字參數照樣是數字", () => {
  const m = make();
  assert.ok(m.sb.handlePayrollConfigSet({ admin_key: 'ADM', store: '', config: { late_deduct: 'true', meal_min_hours: 6, attend_deduct_basis: 'leave' } }).ok);
  const cfg = m.sb.payConfig('SSLGF');
  assert.strictEqual(m.sb.payBool(cfg.late_deduct), true); assert.strictEqual(cfg.meal_min_hours, 6); assert.strictEqual(cfg.attend_deduct_basis, 'leave');
});
ok("payroll_config 的 late_deduct_from 存 '2026-10'：value 欄沒鎖文字 → Sheets 轉成日期（Payroll.gs 自己註解的正式環境觀察）→ payConfig 讀到 Date 字串，應為 '2026-10'", () => {
  const m = make();
  assert.ok(m.sb.handlePayrollConfigSet({ admin_key: 'ADM', store: '', config: { late_deduct: 'true', late_deduct_from: '2026-10' } }).ok);
  assert.strictEqual(m.sb.payConfig('SSLGF').late_deduct_from, '2026-10', '讀到的是：' + m.sb.payConfig('SSLGF').late_deduct_from);
});
ok("（後果）late_deduct_from='2026-10' 後，2026-10／2026-11 的遲到分鐘應扣款（late_deduct 項目）；因 '2026-10' < 'Thu Oct 01 2026…' 比對失真，遲到不計薪整個失效", () => {
  const m = make();
  m.sb.handlePayrollConfigSet({ admin_key: 'ADM', store: '', config: { late_deduct: 'true', late_deduct_from: '2026-10' } });
  const emp = { emp_id: 'E01', name: '測試一', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000, mgr_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0,
                labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-01-01', leave_date: '', meal_allow: 0, active: 'true' };
  const att = { hours: 176, extra_ot: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 30, early_min: 0, forget_punch: 0, forget_day: 0, deduct_days: 1, work_days: 22, leaves: {} };
  ['2026-10', '2026-11'].forEach((ym) => {
    const r = m.sb.payCalcOne(emp, ym, att, m.sb.payConfig('SSLGF'), 4, m.sb.payLeaveTypes('SSLGF'));
    const late = r.ded.filter((x) => x.item_key === 'late_deduct')[0];
    assert.ok(late && late.amount > 0, ym + ' 沒有扣遲到：' + JSON.stringify(r.ded.map((x) => x.item_key)));
  });
});
ok("（對照）late_deduct_from 留空或改成不會被轉型的寫法時，遲到 30 分照扣", () => {
  const m = make();
  m.sb.handlePayrollConfigSet({ admin_key: 'ADM', store: '', config: { late_deduct: 'true', late_deduct_from: '' } });
  const emp = { emp_id: 'E01', name: '測試一', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000, mgr_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0,
                labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-01-01', leave_date: '', meal_allow: 0, active: 'true' };
  const att = { hours: 176, extra_ot: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 30, early_min: 0, forget_punch: 0, forget_day: 0, deduct_days: 1, work_days: 22, leaves: {} };
  const r = m.sb.payCalcOne(emp, '2026-10', att, m.sb.payConfig('SSLGF'), 4, m.sb.payLeaveTypes('SSLGF'));
  const late = r.ded.filter((x) => x.item_key === 'late_deduct')[0];
  assert.ok(late && late.amount === Math.round((30000 + 3000 + 3000) / 30 / 8 / 60 * 30), JSON.stringify(late));
});

/* ════════════════════════════════════════════════════════════════════════
   11. 月表往返：rebuildMonth 寫出的日期在試算表變 Date，人工備註要收得回來
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 11. 月表／notes 往返 ━━');
ok('rebuildMonth 兩次：第 7 欄手打的備註（對應的日期格已是 Date）被收進 notes 分頁（日期也變 Date）、重算後放回同一列', () => {
  const { m, e } = monthFixture();
  assert.ok(m.sb.rebuildMonth('2026-07') > 0);
  const sh = m.sheet('2026-07');
  const col = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  let row = 0; for (let i = 0; i < col.length; i++) { if (m.sb.normCellDate(col[i][0]) === '2026-07-15' && m.isVmDate(col[i][0])) { row = i + 1; break; } }
  assert.ok(row > 0, '月表的日期格是 Date');
  sh.getRange(row, m.c('MONTH_NOTE_COL')).setValue('忘打下班卡，店長確認 18:00');
  m.sb.rebuildMonth('2026-07');
  const notes = m.rows('notes')[0];
  assert.strictEqual(m.isVmDate(notes['日期']), true); assert.strictEqual(m.sb.normCellDate(notes['日期']), '2026-07-15');
  assert.strictEqual(notes['姓名'], '測試一'); assert.strictEqual(notes['備註'], '忘打下班卡，店長確認 18:00');
  assert.strictEqual(sh.getRange(row, m.c('MONTH_NOTE_COL')).getValue(), '忘打下班卡，店長確認 18:00', '重算後備註回到同一列');
  eq(m.sb.readMonthNotesMap(m.ss), { '2026-07-15||測試一': '忘打下班卡，店長確認 18:00' });
  void e;
});

/* ════════════════════════════════════════════════════════════════════════
   12. 條件性問題：系統自己不會這樣寫，但人工在試算表輸入、或呼叫端送純數字時會發生
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 12. 條件性（要有人手動輸入或呼叫端送純數字才會發生）━━');
ok("events.ts 被人手動貼成 '2026-07-15 09:00:00'（空白分隔→Date）：核定頁看得到那張卡，但 payCollect 的忘刷卡用原始 ts 切字串（tsDateStr），這天的忘刷算不到（應為 1）", () => {
  const m = make(); const e = hire(m);
  m.ss.getSheetByName('events').appendRow(['2026-07-15 09:00:00', e.emp_id, 'in', 24.78, 121.01, 0, true, 'D1', true, 'ok', 5]);
  m.setNow('2026-07-20T10:00:00');
  const day = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-07-15' });
  assert.strictEqual(day.employees[0].segments[0].in, '09:00', '核定頁（有 normCellTs）看得到');
  assert.strictEqual(m.sb.handleMyRecent({ key: e.key, device_id: 'D1' }).days[0].notes[0], '下班忘刷卡', '打卡頁也看得到');
  const c = m.sb.payCollect('2026-07', 6, 'SSLGF', [])[e.emp_id] || {};
  assert.strictEqual(c.forget_punch || 0, 1, '薪資忘刷次數＝' + (c.forget_punch || 0));
});
ok("同上，handlePayrollPunch 總表的 miss（忘刷日數）也漏算（rows 用 normCellTs、summary 的 markMiss 用原始 ts，同一支函式兩種口徑）", () => {
  const m = make(); const e = hire(m);
  m.ss.getSheetByName('events').appendRow(['2026-07-15 09:00:00', e.emp_id, 'in', 24.78, 121.01, 0, true, 'D1', true, 'ok', 5]);
  m.setNow('2026-07-20T10:00:00');
  const pp = m.sb.handlePayrollPunch({ admin_key: 'ADM', ym: '2026-07', store: 'SSLGF' });
  assert.strictEqual(pp.rows[0].punches[0].time, '09:00', 'rows 讀得到');
  assert.strictEqual(pp.summary.filter((x) => x.emp_id === e.emp_id)[0].miss, 1);
});
ok("sync_roster 送純數字工號（'0007'）：appendRow 存成數字 7，第二次同步 findRosterByEmpId('0007') 對不到 → 每次同步多一列（應只有一列）", () => {
  const m = make();
  m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: '0007', name: '測試七', active: true }] });
  m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: '0007', name: '測試七', active: true }] });
  assert.strictEqual(m.rows('roster').length, 1, '名冊列數＝' + m.rows('roster').length + '，emp_id 讀回＝' + JSON.stringify(m.rows('roster')[0].emp_id));
});
ok("名冊 key 由人手填純數字／前導零（'00123'）：存成數字 123，同仁連結帶 k=00123 → findRosterByKey 對不到 → invalid_key（應能打卡）", () => {
  const m = make();
  m.ss.getSheetByName('roster').appendRow(['E09', '測試九', '00123', '', '', 'TRUE']);
  const r = punch(m, '00123', 'in');
  assert.strictEqual(r.status, 'ok', JSON.stringify(r) + '；名冊 key 讀回＝' + JSON.stringify(m.rows('roster')[0].key));
});
ok("（對照）系統自己產生的 key（genKey 英數 20 碼）與工號（E01／CF01 這種有英文前綴）不會被轉型", () => {
  const m = make(); const e = hire(m);
  m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: 'CF01', name: '央廚一', active: true }] });
  m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: 'CF01', name: '央廚一', active: false }] });
  assert.strictEqual(m.rows('roster').length, 2); assert.strictEqual(m.rows('roster')[1].active, false);
  assert.strictEqual(punch(m, e.key, 'in').status, 'ok');
});

console.log(`\n${failed ? '❌' : '✅'} ok ${nOk}（失敗 ${failed}）｜KNOWN 待修 ${nKnownOpen}｜KNOWN 已修好 ${nKnownFixed}`);
process.exit(failed || (process.env.ADV_STRICT === '1' && nKnownOpen) ? 1 : 0);
