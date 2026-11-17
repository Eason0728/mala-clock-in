// 核定前檢查加快 A（2026-11-15）：別家店摘要 peer_day_digest＋只檢查帶 peer_given，結果要跟 Google 自己開別家店一模一樣。harness 抄 ft8h.test.js。
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
    roster: sheet('roster', [['emp_id', 'name', 'active', 'line_user_id'], ['E01', '測試一', 'true', 'U1'], ['E02', '測試二', 'true', '']]),
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
const D2 = '2026-11-20';
const P2 = (a, b) => ({ startMs: ms(a, D2), endMs: ms(b, D2) });
const S2 = (a, b) => ({ inMs: a ? ms(a, D2) : null, outMs: b ? ms(b, D2) : null });
const R2 = (o) => Object.assign({ date: D2 }, o);
const chk = (sb, h, ps, ss, opt, d) => sb.reqBindCheck_(sb.getSS(), 'E01', d || D2, h, ps, ss, null, opt);
const FT = (o) => Object.assign({ sched_ft: true, sched_day: 'W', name: '測試一', peer: { worked: false, pending: false, work: 0, leave: 0, ot: 0, names: [] } }, o);
const two = [P2('09:00', '13:00'), P2('18:00', '21:30')], twoS = [S2('09:00', '13:00'), S2('18:00', '21:30')];


function world() {
  const sb = makeEnv();
  const mk = (rows) => sheet('x', rows);
  const books = {
    A: { roster: mk([['emp_id', 'name', 'active'], ['A1', '測試一', 'true'], ['A2', '別人', 'true']]),
         events: mk([['ts', 'emp_id', 'type', 'status', 'mirror_src'], [D2 + 'T09:00:00+08:00', 'A1', 'in', 'ok', ''], [D2 + 'T13:00:00+08:00', 'A1', 'out', 'ok', '']]),
         approved: mk([['date', 'emp_id', 'approved_hours', 'entered_at', 'mirror_src'], [D2, 'A1', 4, 'x', '']]),
         requests: [{ emp_id: 'A1', date: D2, status: 'approved', kind: 'leave', hours: 1 }, { emp_id: 'A1', date: D2, status: 'approved', kind: 'ot', hours: 0.5 }] },
    B: { roster: mk([['emp_id', 'name', 'active'], ['B1', '測試一', 'true']]),      // 有卡沒核定
         events: mk([['ts', 'emp_id', 'type', 'status', 'mirror_src'], [D2 + 'T18:00:00+08:00', 'B1', 'in', 'ok', '']]),
         approved: mk([['date', 'emp_id', 'approved_hours', 'entered_at', 'mirror_src']]), requests: [] },
    H: { roster: mk([['emp_id', 'name', 'active'], ['H1', '測試一', 'true']]),      // 只有鏡像列：不算
         events: mk([['ts', 'emp_id', 'type', 'status', 'mirror_src'], [D2 + 'T09:00:00+08:00', 'H1', 'in', 'ok', 'CF']]),
         approved: mk([['date', 'emp_id', 'approved_hours', 'entered_at', 'mirror_src'], [D2, 'H1', 8, 'x', 'CF']]), requests: [{ emp_id: 'H1', date: D2, status: 'approved', kind: 'ot', hours: 2, mirror_src: 'CF' }] },
    X: { roster: mk([['emp_id', 'name', 'active'], ['X1', '測試一', 'false']]), events: mk([['ts']]), approved: mk([['date']]), requests: [] },   // 離職的同名：不開
    D: { roster: mk([['emp_id', 'name', 'active'], ['D1', '測試一', 'true'], ['D2', '測試一', 'true']]), events: mk([['ts']]), approved: mk([['date']]), requests: [] },   // 同一家兩位同名：分不出，不算
    E: { roster: mk([['emp_id', 'name', 'active'], ['E9', '測試一', 'true']]),      // 跨夜班凌晨的下班卡不算；只有一張 10:00 下班卡（忘打上班）算
         events: mk([['ts', 'emp_id', 'type', 'status', 'mirror_src'], [D2 + 'T02:00:00+08:00', 'E9', 'out', 'ok', ''], [D2 + 'T10:00:00+08:00', 'E9', 'out', 'ok', '']]),
         approved: mk([['date', 'emp_id', 'approved_hours', 'entered_at', 'mirror_src']]), requests: [] },
    F: { roster: mk([['emp_id', 'name', 'active'], ['F9', '測試一', 'true']]),      // 只有凌晨的下班卡：不算
         events: mk([['ts', 'emp_id', 'type', 'status', 'mirror_src'], [D2 + 'T02:00:00+08:00', 'F9', 'out', 'ok', '']]),
         approved: mk([['date', 'emp_id', 'approved_hours', 'entered_at', 'mirror_src']]), requests: [] },
  };
  const opened = [];
  sb.REST_PEERS_ = ['A', 'B', 'H', 'X', 'D', 'E', 'F', 'SELF'].map((c) => ({ code: c, ss: 'ss-' + c }));
  sb.restName_ = (x) => String(x || '').trim();
  sb.CacheService = { getScriptCache: () => ({ get: () => null, put() {} }) };
  sb.getSS = () => ({ getId: () => 'ss-SELF', getSheetByName: () => null });
  sb.SpreadsheetApp = { openById: (id) => { const c = id.slice(3); opened.push(c); const b = books[c]; return { id: c, getSheetByName: (n) => b[n] || null }; } };
  sb.readEventsSince = (sh) => sb.readSheetAsObjects(sh);
  sb.buildLatestApprovedMap = (rows) => { const m = {}; rows.forEach((r) => { (m[r.date] = m[r.date] || {})[r.emp_id] = r; }); return m; };
  sb.reqRows_ = (ss) => books[ss.id].requests;
  return { sb, books, opened };
}
const dig = (sb, books, code) => { const b = books[code]; return sb.reqPeerDigest_({ id: code, getSheetByName: (n) => b[n] || null }, D2); };
const giveAll = (sb, books, codes) => { const g = {}; codes.forEach((c) => { g[c] = { date: D2, people: JSON.parse(JSON.stringify(dig(sb, books, c))) }; }); return g; };
const strip = (o) => { if (!o || typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(strip); const x = {}; Object.keys(o).forEach((k) => { if (k === 'fs' && o[k] === null) return; if (k === 'by') return; x[k] = strip(o[k]); }); return x; };   // fs／by 是 2026-11-18 新加的，另有測試
const same = (a, b, m) => assert.strictEqual(JSON.stringify(strip(a)), JSON.stringify(strip(b)), m);
const CODES = ['A', 'B', 'H', 'X', 'D', 'E', 'F'];

ok('摘要：同名兩位、離職、只有鏡像列、只有凌晨下班卡的人不放；放進去的是本店原始數字', () => {
  const { sb, books } = world();
  same(Object.keys(dig(sb, books, 'D')), []);
  same(Object.keys(dig(sb, books, 'X')), []);
  same(Object.keys(dig(sb, books, 'H')), []);
  same(Object.keys(dig(sb, books, 'F')), []);
  same(dig(sb, books, 'A')['測試一'], { w: true, r: 1, work: 4, lv: 1, ot: 0.5 });
  same(dig(sb, books, 'B')['測試一'], { w: true, r: 0, work: 0, lv: 0, ot: 0 });
  same(dig(sb, books, 'E')['測試一'], { w: true, r: 0, work: 0, lv: 0, ot: 0 });
});
ok('只檢查帶齊全部別家摘要：結果跟自己開別家店一模一樣，而且一家都沒開', () => {
  const a = world();
  const base = a.sb.reqPeerDay_('測試一', D2);
  const b = world(), given = giveAll(b.sb, b.books, CODES);
  b.opened.length = 0;
  b.sb.READ_MEMO_ = {}; b.sb.REQ_PEER_GIVEN_ = b.sb.reqPeerGivenParse_(given, D2);
  const r = b.sb.reqPeerDay_('測試一', D2);
  assert.strictEqual(JSON.stringify(r), JSON.stringify(base));
  same(b.opened, []);
  const f = b.sb.reqPeerDay_('測試一', D2, true);      // 重找（fresh）也用帶來的
  assert.strictEqual(JSON.stringify(f), JSON.stringify(base));
  same(b.opened, []);
});
ok('只帶一部分：帶了的店不開、沒帶的店照舊自己開，加總一樣', () => {
  const a = world(); const base = a.sb.reqPeerDay_('測試一', D2);
  const b = world(), given = giveAll(b.sb, b.books, ['A', 'H', 'D']);
  b.opened.length = 0;
  b.sb.READ_MEMO_ = {}; b.sb.REQ_PEER_GIVEN_ = b.sb.reqPeerGivenParse_(given, D2);
  const r = b.sb.reqPeerDay_('測試一', D2);
  assert.strictEqual(JSON.stringify(r.names.slice().sort()), JSON.stringify(base.names.slice().sort()));
  ['worked', 'pending', 'failed', 'work', 'leave', 'ot'].forEach((k) => assert.strictEqual(r[k], base[k], k));
  assert.ok(!b.opened.includes('A') && !b.opened.includes('H') && !b.opened.includes('D'));
  assert.ok(b.opened.includes('B') && b.opened.includes('E'));
});
ok('不採用：日期不同、不在只檢查一批（READ_MEMO_ 關著＝真正送出核定）、格式不對', () => {
  const b = world(), given = giveAll(b.sb, b.books, CODES);
  b.sb.READ_MEMO_ = {}; b.sb.REQ_PEER_GIVEN_ = b.sb.reqPeerGivenParse_(given, '2026-11-21');
  assert.strictEqual(b.sb.REQ_PEER_GIVEN_, null, '摘要日期跟這批不同＝整份不收');
  b.sb.REQ_PEER_GIVEN_ = b.sb.reqPeerGivenParse_(given, D2); b.sb.READ_MEMO_ = null;
  b.opened.length = 0; b.sb.reqPeerDay_('測試一', D2);
  assert.ok(b.opened.length > 0, '送出核定照舊自己開別家');
  assert.strictEqual(b.sb.reqPeerGivenParse_([1, 2], D2), null);
  assert.strictEqual(b.sb.reqPeerGivenParse_({ A: { date: D2, people: [] } }, D2), null);
  const g = b.sb.reqPeerGivenParse_({ A: { date: D2, people: { '測試一': { w: 'yes', r: '2', work: '4', lv: null, ot: 'x' } } } }, D2);
  same(JSON.parse(JSON.stringify(g.by.A['測試一'])), { w: false, r: 2, work: 4, lv: 0, ot: 0 });
});
ok('peer_day_digest：沒有主管金鑰擋下、日期格式不對擋下', () => {
  const { sb } = world();
  sb.reqMgr_ = () => null;
  assert.strictEqual(sb.handlePeerDayDigest_({ date: D2 }).error, 'unauthorized');
  sb.reqMgr_ = () => ({ name: 'x' });
  assert.strictEqual(sb.handlePeerDayDigest_({ date: '11/20' }).error, 'bad_date');
});
ok('reqMgrApproveCheck_ 結束後一定清掉帶來的摘要', () => {
  const { sb } = world();
  sb.reqMgrApproveHome_ = () => { assert.ok(sb.REQ_PEER_GIVEN_ && sb.REQ_PEER_GIVEN_.by.A); return { ok: true }; };
  const r = sb.reqMgrApproveCheck_({ date: D2, items: [{ emp_id: 'E01' }], peer_given: { A: { date: D2, people: {} } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sb.REQ_PEER_GIVEN_, null);
  assert.strictEqual(sb.READ_MEMO_, null);
});
console.log('全部 ' + n + ' 項通過');
