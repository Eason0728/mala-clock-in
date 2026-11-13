// 測試用沙盒（2026-11-10 挑錯時寫的，2026-11-11 搬進 repo）：整檔載入 apps-script/*.gs 的真函式，只把 Google 服務換成記憶體版。
// 不連網路、不讀任何金鑰；時鐘可控（台北時間）。名冊、打卡一律假資料。
// 用法：const { make, T, check, show, done } = require('./helpers/gs-sandbox');
//   const m = make({ now: T('2026-11-10T09:00:00'), self: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE' }], events: [['2026-11-09T09:00:00', 'E01', 'in']] } });
//   m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
//   check('編號', '說明', 實際, 預期); ... done();   // done() 有任何一項不符就以非零結束（run-all.js 靠這個判斷）
// 金鑰都是假的：管理 ADM、值班主管 MK、營運系統代管 AK；LINE token 'TOK_U1' → userId 'U1'。
// ⚠ 這裡的假試算表不模擬 Google 試算表的自動轉型（'2026-11-09' 變 Date）；要測那類用 tests/helpers/sheets-like.js。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const ROOT = process.env.GS_ROOT || path.join(__dirname, '..', '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const T = (s) => Date.parse(s + '+08:00');
const z = (v) => ('0' + v).slice(-2);
function taipei(ms) { const x = new Date(ms + 8 * 3600000); return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() }; }
function fmt(d, tz, p) {
  const t = taipei(d.getTime());
  return String(p).replace("yyyy-MM-dd'T'HH:mm:ssXXX", `${t.y}-${z(t.M)}-${z(t.d)}T${z(t.H)}:${z(t.m)}:${z(t.s)}+08:00`)
    .replace('yyyyMMdd-HHmmss', `${t.y}${z(t.M)}${z(t.d)}-${z(t.H)}${z(t.m)}${z(t.s)}`)
    .replace('yyyyMMdd', `${t.y}${z(t.M)}${z(t.d)}`)
    .replace('yyyy-MM-dd', `${t.y}-${z(t.M)}-${z(t.d)}`).replace('yyyy-MM', `${t.y}-${z(t.M)}`)
    .replace('HH:mm:ss', `${z(t.H)}:${z(t.m)}:${z(t.s)}`)
    .replace('HH:mm', `${z(t.H)}:${z(t.m)}`).replace('M/d', `${t.M}/${t.d}`);
}
const iso = (ms) => fmt(new Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");

function sheet(values, id) {
  const v = values.map((r) => r.slice());
  const sh = {
    values: v, fmtLog: [],
    getSheetId: () => id || 1, getName: () => String(id || ''),
    getLastRow: () => { let n = v.length; while (n > 0 && (v[n - 1] || []).every((c) => c === '' || c === undefined || c === null)) n--; return n; },
    getLastColumn: () => Math.max.apply(null, v.map((r) => r.length).concat([0])),
    getMaxColumns: () => Math.max(sh.getLastColumn(), 26), getMaxRows: () => Math.max(v.length, 1000),
    insertColumnAfter: () => {},
    getDataRange: () => ({ getValues: () => v.map((r) => { const w = sh.getLastColumn(); const o = r.slice(); while (o.length < w) o.push(''); return o; }) }),
    getRange: (a, c, nr, nc) => {
      if (typeof a === 'string') return { setNumberFormat: () => {}, getValues: () => [[]] };
      const r = a;
      const rng = {
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = v[r - 1 + i] || []; const o = []; for (let j = 0; j < (nc || 1); j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
        setValue: (x) => { while (v.length < r) v.push([]); (v[r - 1] = v[r - 1] || [])[c - 1] = x; return rng; },
        setValues: (xs) => { xs.forEach((row, i) => { while (v.length < r + i) v.push([]); row.forEach((x, k) => { (v[r - 1 + i] = v[r - 1 + i] || [])[c - 1 + k] = x; }); }); return rng; },
        setNumberFormat: () => rng, setFontWeight: () => rng, setBackground: () => rng, setFontColor: () => rng,
      };
      return rng;
    },
    appendRow: (row) => { v.push(row.slice()); },
    deleteRow: (n) => { v.splice(n - 1, 1); },
    clear: () => { v.length = 0; },
    setFrozenRows: () => {}, setColumnWidth: () => {},
  };
  return sh;
}
function book(id, sheets) {
  const sh = {}; let n = 0;
  Object.keys(sheets).forEach((k) => { if (sheets[k]) sh[k] = sheet(sheets[k], ++n); });
  return { sh, getId: () => id, getSheetByName: (nm) => sh[nm] || null, insertSheet: (nm) => { sh[nm] = sheet([], ++n); return sh[nm]; } };
}
const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const RH = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at', 'line_ok_at'];
const rosterRow = (o) => RH.map((h) => (o[h] === undefined ? '' : o[h]));
// 事件簡寫：[ts(台北字串或毫秒), emp, type, status?, device?]
const evRow = (e) => [typeof e[0] === 'number' ? iso(e[0]) : (/\+08:00$/.test(e[0]) ? e[0] : e[0] + '+08:00'), e[1], e[2], 24.7840945, 121.0157448, 5, true, e[4] || 'D1', true, e[3] || 'ok', 10];

function storeBook(id, s) {
  s = s || {};
  return book(id, {
    roster: [RH].concat((s.roster || []).map(rosterRow)),
    events: [EH.concat(s.mirror ? ['mirror_src'] : [])].concat((s.events || []).map(evRow)),
    managers: [['name', 'key', 'active', 'allow_acting', 'emp_id']].concat(s.managers || [['值班主管', 'MK', 'true', '', ''], ['營運系統代管', 'AK', 'true', 'true', '']]),
    approved: [['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason']].concat(s.approved || []),
    notices: [['id', 'text', 'active', 'ends_on', 'created_at', 'created_by']],
    leave: [['日期', '姓名', '假別', '時數']].concat(s.leave || []),
  });
}

/** opts: now(ms), self:{roster,events,approved,leave,managers}, peers:{id:{...}}, props（指令碼屬性）, config（蓋 CONFIG）, hub／payroll／digest（加載 LineHub／Payroll／AttDigest）, lineUsers, hubStores, fetch(fn) */
function make(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sb = {
    console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, RangeError, isNaN, isFinite, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, unescape, escape, Boolean, Symbol, Map, Set, Promise,
    Logger: { log: () => {} }, __now: opts.now || T('2026-11-10T10:00:00'), __fetches: [],
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
  sb.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  sb.ContentService = { createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'JSON', TEXT: 'TEXT' } };
  const signed = (b) => (b > 127 ? b - 256 : b);
  sb.Utilities = {
    formatDate: fmt, getUuid: () => crypto.randomUUID(), sleep: () => {},
    computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(v)).digest()).map(signed),
    computeDigest: (alg, v) => Array.from(crypto.createHash(alg === 'MD5' ? 'md5' : 'sha256').update(String(v)).digest()).map(signed),
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
    base64Encode: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64'),
    base64EncodeWebSafe: (b) => Buffer.from(Array.isArray(b) ? b.map((x) => x & 255) : String(b)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, mime, name) => ({ getContentType: () => mime, getBytes: () => bytes, name }),
  };
  const users = opts.lineUsers || { TOK_U1: { sub: 'U1' }, TOK_U2: { sub: 'U2' }, TOK_U3: { sub: 'U3' }, TOK_U4: { sub: 'U4' } };
  const self = storeBook('SELF', opts.self);
  const peers = {};
  Object.keys(opts.peers || {}).forEach((id) => { peers[id] = storeBook(id, opts.peers[id]); });
  sb.UrlFetchApp = { fetch: (url, o) => {
    sb.__fetches.push({ url, o });
    if (opts.fetch) { const r = opts.fetch(url, o, sb); if (r !== undefined) return { getResponseCode: () => 200, getContentText: () => (typeof r === 'string' ? r : JSON.stringify(r)) }; }
    const u = users[o && o.payload && o.payload.id_token];
    const body = u ? JSON.stringify({ sub: u.sub, aud: u.aud || '2011292256', exp: u.exp || Math.floor(sb.__now / 1000) + 3600 }) : '{"error":"invalid"}';
    return { getResponseCode: () => (u ? 200 : 400), getContentText: () => body };
  } };
  sb.SpreadsheetApp = { openById: (id) => { if (id === 'SELF') return self; if (peers[id]) return peers[id]; throw new Error('沒權限：' + id); }, flush: () => {} };
  vm.createContext(sb);
  const files = ['apps-script/Code.gs', 'apps-script/Liff.gs', 'apps-script/Rest.gs', 'apps-script/Requests.gs', 'apps-script/DutyFeed.gs'];
  if (opts.hub) files.push('apps-script/LineHub.gs');
  if (opts.payroll) files.push('apps-script/Payroll.gs');
  if (opts.digest) files.push('apps-script/AttDigest.gs');
  files.forEach((f) => vm.runInContext(R(f), sb, { filename: f }));
  // CONFIG 是頂層 const：在同一個 context 裡改值（座標用光復實際座標、半徑 20）
  const cfg = Object.assign({ SPREADSHEET_ID: 'SELF', STORE_LAT: 24.7840945, STORE_LNG: 121.0157448, RADIUS_M: 20, ADMIN_KEY: 'ADM',
    NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '', PAYROLL_API: '', PAYROLL_STORE: '' }, opts.config || {});
  vm.runInContext('Object.assign(CONFIG, ' + JSON.stringify(cfg) + ');', sb);
  sb.REST_PEERS_ = Object.keys(peers).map((id, i) => ({ code: 'p' + i, ss: id })).concat([{ code: 'self', ss: 'SELF' }]);
  if (opts.hubStores) sb.LINE_HUB_STORES_CONFIG = opts.hubStores;
  const run = (code) => vm.runInContext(code, sb);
  return { sb, self, peers, props, run, cache,
    setNow: (v) => { sb.__now = typeof v === 'number' ? v : T(v); },
    advance: (ms) => { sb.__now += ms; },
    events: (bk) => (bk || self).sh.events.values.slice(1).map((r) => ({ ts: r[0], emp_id: r[1], type: r[2], distance_m: r[5], within_range: r[6], device_id: r[7], device_match: r[8], status: r[9], accuracy_m: r[10] })),
    roster: (bk) => (bk || self).sh.roster.values.slice(1).map((r) => { const o = {}; RH.forEach((h, i) => { o[h] = r[i]; }); return o; }),
    approved: (bk) => (bk || self).sh.approved.values.slice(1),
  };
}

// 緯度方向位移 N 公尺的座標（光復）
const M_PER_DEG_LAT = 6371000 * Math.PI / 180;
const at = (meters) => ({ lat: 24.7840945 + meters / M_PER_DEG_LAT, lng: 121.0157448 });

let nPass = 0, nFail = 0; const rows = [];
function check(id, desc, actual, expected, note) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected), okk = a === e;
  if (okk) nPass++; else nFail++;
  rows.push({ id, desc, actual: a, expected: e, ok: okk, note: note || '' });
  console.log((okk ? '✓ ' : '✗ ') + id + ' ' + desc + '\n    實際=' + a + (okk ? '' : '\n    預期=' + e) + (note ? '\n    註：' + note : ''));
  return okk;
}
function show(id, desc, actual) { console.log('• ' + id + ' ' + desc + '\n    實際=' + JSON.stringify(actual)); rows.push({ id, desc, actual: JSON.stringify(actual), expected: '', ok: null }); }
function summary() { console.log('\n── 小計：相符 ' + nPass + '、不符 ' + nFail + ' ──'); return { nPass, nFail, rows }; }

/** 測試檔最後叫一次：印小計，有不符就以非零結束 */
function done() { const r = summary(); if (r.nFail) process.exit(1); return r; }

module.exports = { make, T, iso, fmt, at, check, show, summary, done, EH, RH, ROOT, R, M_PER_DEG_LAT };
