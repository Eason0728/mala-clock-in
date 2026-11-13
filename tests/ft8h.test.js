// 正職上班日滿 8 小時＋跨店加班算被支援那家（2026-11-13 Eason）。harness 抄 req-bind.test.js。
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

ok('11/5 那張卡：正職上班日 7.5 小時沒有假單＝擋，說還差 0.5', () => {
  const sb = makeEnv();
  const r = chk(sb, 7.5, two, twoS, FT({}));
  assert.strictEqual(r.error, 'need_request');
  assert.ok(/正職上班日要滿 8 小時（上班 7\.5＋出差 0＋假單 0＝7\.5 小時），還差 0\.5 小時/.test(r.message), r.message);
  assert.strictEqual(r.need.leave_hours, 0.5);
});
ok('補休 0.5 已核准、核定登記補休 0.5＝放行', () => {
  const sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '補休', hours: 0.5 }));
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({ leaves: [{ type: '補休', hours: 0.5 }] })), null);
});
ok('任何假別都算（事假 0.5）', () => {
  const sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '事假', hours: 0.5 }));
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({ leaves: [{ type: '事假', hours: 0.5 }] })), null);
});
ok('差 15 分補 0.5 小時假：合計 8.25 放行', () => {
  const sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '補休', hours: 0.5 }));
  assert.strictEqual(chk(sb, 7.75, [P2('09:00', '16:45')], [S2('09:00', '16:45')], FT({ leaves: [{ type: '補休', hours: 0.5 }] })), null);
});
ok('出差算進核定時數：上班 4＋出差 4＝放行', () => {
  const sb = makeEnv(); addReq(sb, R2({ kind: 'trip', hours: 4 }));
  assert.strictEqual(chk(sb, 8, [P2('09:00', '13:00')], [S2('09:00', '13:00')], FT({ leaves: [{ type: '出差', hours: 4 }], trip_hours: 4 })), null);
});
ok('整天請假 8 小時＝放行；整天請假 4 小時＝擋', () => {
  let sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '特休', hours: 8 }));
  assert.strictEqual(chk(sb, 0, [], [], FT({ leaves: [{ type: '特休', hours: 8 }] })), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '特休', hours: 4 }));
  assert.ok(/還差 4 小時/.test(chk(sb, 0, [], [], FT({ leaves: [{ type: '特休', hours: 4 }] })).message));
});
ok('計時、沒帶正職＝不檢查；sched_day 空白（支援帳號）照 sched_ft', () => {
  const sb = makeEnv();
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({ sched_ft: false })), null);
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({ sched_ft: undefined })), null);
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({ sched_ft: 'true' })), null);
  assert.ok(/還差 0\.5/.test(chk(sb, 7.5, two, twoS, FT({ sched_day: '' })).message), '班表空白：營運系統說正職出勤日（支援帳號看原單位）就檢查');
});
ok('休息日、例假：照舊規則（全算加班），不套滿 8', () => {
  const sb = makeEnv();
  assert.ok(!/滿 8 小時/.test(chk(sb, 4, [P2('10:00', '14:00')], [S2('10:00', '14:00')], FT({ sched_day: 'H' })).message));
});
ok('REQ_FT8_FROM：預設 11/1 起；11/1 以前不擋；設 off 整條關', () => {
  const D3 = '2026-10-31', p3 = [{ startMs: ms('09:00', D3), endMs: ms('13:00', D3) }], s3 = [{ inMs: ms('09:00', D3), outMs: ms('13:00', D3) }];
  const sb = makeEnv();
  assert.strictEqual(sb.reqFt8From_(), '2026-11-01');
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D3, 4, p3, s3, null, FT({})), null);
  sb.__props.REQ_FT8_FROM = 'off';
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({})), null);
  sb.__props.REQ_FT8_FROM = '2026-11-21';
  assert.strictEqual(chk(sb, 7.5, two, twoS, FT({})), null);
});
ok('11/1–11/10（加嚴前）也擋；只登記補休沒有已核准的單＝不算', () => {
  const D4 = '2026-11-05', p4 = [{ startMs: ms('09:00', D4), endMs: ms('16:30', D4) }], s4 = [{ inMs: ms('09:00', D4), outMs: ms('16:30', D4) }];
  let sb = makeEnv();
  assert.ok(/還差 0\.5 小時/.test(sb.reqBindCheck_(sb.getSS(), 'E01', D4, 7.5, p4, s4, null, FT({ leaves: [{ type: '補休', hours: 0.5 }] })).message));
  sb = makeEnv(); addReq(sb, { date: D4, kind: 'leave', leave_type: '補休', hours: 0.5 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D4, 7.5, p4, s4, null, FT({})), null);
});
ok('審核中的假單不算', () => {
  const sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '補休', hours: 0.5, status: 'pending' }));
  assert.ok(/還差 0\.5 小時/.test(chk(sb, 7.5, two, twoS, FT({ leaves: [{ type: '補休', hours: 0.5 }] })).message));
});
ok('別家當天有打卡、還沒核定＝先放行', () => {
  const sb = makeEnv();
  assert.strictEqual(chk(sb, 4, [P2('09:00', '13:00')], [S2('09:00', '13:00')], FT({ peer: { worked: true, pending: true, work: 0, leave: 0, ot: 0, names: ['mztlzl'] } })), null);
});
ok('別家已核定：相加滿 8 放行、不滿擋並寫店名', () => {
  const sb = makeEnv();
  assert.strictEqual(chk(sb, 4, [P2('09:00', '13:00')], [S2('09:00', '13:00')], FT({ peer: { worked: true, pending: false, work: 4, leave: 0, ot: 0, names: ['mztlzl'] } })), null);
  const r = chk(sb, 3, [P2('09:00', '12:00')], [S2('09:00', '12:00')], FT({ peer: { worked: true, pending: false, work: 4, leave: 0, ot: 0, names: ['mztlzl'] } }));
  assert.ok(/這家 3＋墨竹亭台北六張犁 4＝7 小時，還差 1 小時/.test(r.message), r.message);
});
ok('加班算被支援那家：這家是支援帳號、兩家上班合計 10 → 這家要 2 小時加班單；班表內不擋', () => {
  let sb = makeEnv();
  const peer = { worked: true, pending: false, work: 6, leave: 0, ot: 0, names: ['gf'] };
  const ps = [P2('17:00', '21:00')], ss = [S2('17:00', '21:00')];
  const r = chk(sb, 4, ps, ss, FT({ sched_support: true, peer, sched_spans: [{ start: '17:00', end: '21:00' }] }));
  assert.ok(/兩家上班合計 10 小時，超過 8 的部分要在這家（被支援）開 2 小時加班單/.test(r.message), r.message);
  assert.ok(!/班表內是正常上班/.test(r.message), '被支援那家：加班單在支援的班表內不擋');
  assert.strictEqual(r.need.ot_hours, 2);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '19:00', end: '21:00', hours: 2 }));
  assert.strictEqual(chk(sb, 4, ps, ss, FT({ sched_support: true, peer, sched_spans: [{ start: '17:00', end: '21:00' }] })), null);
});
ok('審查 1：被支援那家只上 1 小時、兩家合計 11 → 這家只要 1 小時加班單（不卡死），其餘 2 小時在原單位', () => {
  let sb = makeEnv();
  const ps = [P2('17:00', '18:00')], ss = [S2('17:00', '18:00')];
  const peer = { worked: true, pending: false, work: 10, leave: 0, ot: 0, names: ['gf'] };
  let r = chk(sb, 1, ps, ss, FT({ sched_support: true, peer }));
  assert.ok(/開 1 小時加班單/.test(r.message), r.message);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:00', end: '18:00', hours: 1 }));
  assert.strictEqual(chk(sb, 1, ps, ss, FT({ sched_support: true, peer })), null);
  // 原單位後核：10＋1，被支援那家已核准 1 小時 → 原單位要 2 小時
  sb = makeEnv();
  const hp = [P2('08:00', '18:00')], hs = [S2('08:00', '18:00')];
  r = chk(sb, 10, hp, hs, FT({ sched_support: false, peer: { worked: true, pending: false, work: 1, leave: 0, ot: 1, names: ['mztlzl'] } }));
  assert.ok(/超過 8 小時的 2 小時要有加班單/.test(r.message), r.message);      // 原單位自己超過 8 的部分照單店規則
  assert.ok(!/要在被支援的/.test(r.message), '被支援那家的 1 小時已核准');
});
ok('加班算被支援那家：這家是原單位、上 9 小時 → 自己超過 8 的 1 小時照單店規則，另外看被支援那家', () => {
  const sb = makeEnv();
  const ps = [P2('08:00', '17:00')], ss = [S2('08:00', '17:00')];
  assert.ok(/超過 8 小時的 1 小時要有加班單/.test(chk(sb, 9, ps, ss, FT({ sched_support: false, peer: { worked: true, pending: true, work: 0, leave: 0, ot: 0, names: ['mztlzl'] } })).message), '審查 3：被支援那家還沒核定，原單位自己超過 8 的 1 小時照樣要單');
  const r = chk(sb, 9, ps, ss, FT({ sched_support: false, peer: { worked: true, pending: false, work: 2, leave: 0, ot: 1, names: ['mztlzl'] } }));
  assert.ok(/兩家上班合計 11 小時，超過 8 的 2 小時要在被支援的 墨竹亭台北六張犁 開加班單（那邊已核准 1 小時）/.test(r.message), r.message);
  assert.ok(/超過 8 小時的 1 小時要有加班單/.test(r.message), r.message);
});
ok('審查 6：兩家合計加班只算上班、不算假（原單位 5＋假 3、支援 3 → 剛好 8，不用加班單）', () => {
  const sb = makeEnv();
  assert.strictEqual(chk(sb, 3, [P2('17:00', '20:00')], [S2('17:00', '20:00')], FT({ sched_support: true, peer: { worked: true, pending: false, work: 5, leave: 3, ot: 0, names: ['gf'] } })), null);
});
ok('不知道是不是支援帳號：加班照舊（超過 8 那家開），滿 8 照相加', () => {
  const sb = makeEnv();
  const r = chk(sb, 9, [P2('08:00', '17:00')], [S2('08:00', '17:00')], FT({ peer: { worked: true, pending: false, work: 2, leave: 0, ot: 0, names: ['gf'] } }));
  assert.ok(/超過 8 小時的 1 小時要有加班單/.test(r.message), r.message);
});
ok('審查 5：假單送在原單位、這天只在支援那家上 4 小時 → 相加滿 8 放行', () => {
  const sb = makeEnv();
  assert.strictEqual(chk(sb, 4, [P2('09:00', '13:00')], [S2('09:00', '13:00')], FT({ peer: { worked: false, pending: false, work: 0, leave: 4, ot: 0, names: ['gf'] } })), null);
});
ok('審查 4、11：11/1–11/10 整天請假（沒時段）只有 4 小時假單也擋；REQ_BIND_FROM=off 時滿 8 小時照樣檢查、舊規則不跑', () => {
  const D4 = '2026-11-05';
  let sb = makeEnv(); addReq(sb, { date: D4, kind: 'leave', leave_type: '特休', hours: 4 });
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D4, 0, [], [], null, FT({ leaves: [{ type: '特休', hours: 4 }] }));
  assert.ok(/還差 4 小時/.test(r.message), JSON.stringify(r));
  sb = makeEnv(); sb.__props.REQ_BIND_FROM = 'off';
  const r2 = chk(sb, 9.5, [P2('08:00', '17:30')], [S2('08:00', '17:30')], FT({}));
  assert.strictEqual(r2, null, '滿 8 了、舊的超過 8 小時要加班單規則跟著綁單關掉');
  assert.ok(/還差 0\.5/.test(chk(sb, 7.5, two, twoS, FT({})).message));
});
ok('reqPeerDay_：只開名冊有同名在職的店；跳過鏡像列、只認這天的上班卡；已核定算上班、已核准假單與加班另計；有卡沒核定＝pending', () => {
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
  const r = sb.reqPeerDay_('測試一', D2);
  assert.strictEqual(JSON.stringify(r), JSON.stringify({ worked: true, pending: true, failed: false, work: 4, leave: 1, ot: 0.5, names: ["A", "B", "E"] }));
  assert.ok(!opened.includes('SELF'));
});
ok('審查 1：別家讀不到 → 滿 8 小時先放行，但加班照單店規則（10 小時沒加班單照擋）', () => {
  const sb = makeEnv();
  const failed = { worked: false, pending: false, failed: true, work: 0, leave: 0, ot: 0, names: [] };
  assert.strictEqual(chk(sb, 4, [P2('09:00', '13:00')], [S2('09:00', '13:00')], FT({ peer: failed })), null);
  const r = chk(sb, 10, [P2('08:00', '18:00')], [S2('08:00', '18:00')], FT({ sched_support: true, peer: failed }));
  assert.ok(/超過 8 小時的 2 小時要有加班單/.test(r.message), r.message);
});
ok('審查 4：跨店加班單開太多也擋（支援那家應有 2、開了 3；原單位不超過 8 卻開了加班單）', () => {
  let sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '18:00', end: '21:00', hours: 3 }));
  let r = chk(sb, 4, [P2('17:00', '21:00')], [S2('17:00', '21:00')], FT({ sched_support: true, peer: { worked: true, pending: false, work: 6, leave: 0, ot: 0, names: ['gf'] } }));
  assert.ok(/應有的加班是 2 小時，已核准的加班單 3 小時太多/.test(r.message), r.message);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '13:00', end: '15:00', hours: 2 }));
  r = chk(sb, 6, [P2('09:00', '15:00')], [S2('09:00', '15:00')], FT({ sched_support: false, peer: { worked: true, pending: false, work: 4, leave: 0, ot: 0, names: ['mztlzl'] } }));
  assert.ok(/應有的加班是 0 小時/.test(r.message) && /要在被支援的 墨竹亭台北六張犁 開加班單/.test(r.message), r.message);
});
ok('核定預覽回 ft8_gap（撤銷試算用）', () => {
  const sb = makeEnv();
  const r = chk(sb, 7.5, two, twoS, FT({ preview: true }));
  assert.strictEqual(r.ft8_gap, 0.5);
  assert.ok(r.probs.some((p) => p.rule === 'ft8'));
});
ok('ft8_revoke：只看營運系統給的候選；試算只讀；apply 搬不滿 8 小時沒假單的，有補休單、不是候選的不動', () => {
  const sb = makeEnv('2026-11-13T10:00:00+08:00');
  const DA = '2026-11-03', DB = '2026-11-12';
  addReq(sb, { emp_id: 'E02', name: '測試二', date: DA, kind: 'leave', leave_type: '補休', hours: 0.5 });
  const sheets = sb.__sheets;
  const H = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'mirror_src'];
  sheets.approved = sheet('approved', [H,
    [DA, 'E01', '測試一', '09:00-16:30', 7.5, '正常', '店長', '2026-11-03T22:00:00+08:00'],   // 候選、沒假單：撤
    [DA, 'E02', '測試二', '09:00-16:30', 7.5, '正常', '店長', '2026-11-03T22:00:00+08:00'],   // 候選、有補休 0.5：不動
    [DB, 'E01', '測試一', '09:00-13:00', 4, '正常', '店長', '2026-11-12T22:00:00+08:00'],     // 候選、11/12（加嚴後）也看：撤
    [DB, 'E02', '測試二', '09:00-13:00', 4, '正常', '店長', '2026-11-12T22:00:00+08:00']]);   // 不是候選（計時）：不動
  const sh = sheets.approved;
  sh.getDataRange = () => ({ getValues: () => sh.data.map((r) => r.slice()) });
  sh.deleteRow = (r) => { sh.data.splice(r - 1, 1); };
  sheets.events = sheet('events', [['ts']]); sheets.leave = sheet('leave', [['日期', '姓名', '假別', '時數']]);
  Object.assign(sb, {
    checkAdmin: (b) => b.admin_key === 'AK',
    buildLatestApprovedMap: (rows) => { const m = {}; rows.forEach((r) => { const c = (m[r.date] = m[r.date] || {}); if (!c[r.emp_id] || r.entered_at >= c[r.emp_id].entered_at) c[r.emp_id] = r; }); return m; },
    dupIgnoreSet_: () => ({}), dropDupIgnored_: (e) => e, noPunchBreakWindow: () => null, addDaysStr: (d) => d,
    parsePeriodsStr: (x) => String(x).split(',').map((y) => ({ start: y.split('-')[0], end: y.split('-')[1] })),
    dayPunchSegments: (e, emp, d, x) => ({ segments: [{ in: '09:00', out: d === DA ? '16:30' : '13:00' }] }),
    SpreadsheetApp: { flush() {} },
  });
  const items = [{ emp_id: 'E01', date: DA }, { emp_id: 'E02', date: DA }, { emp_id: 'E01', date: DB, support: false }];
  assert.strictEqual(sb.handleFt8Revoke_({ admin_key: 'x', items }).error, 'unauthorized');
  assert.strictEqual(sb.handleFt8Revoke_({ admin_key: 'AK', items: [{ emp_id: 'E01', date: '2026-10-31' }] }).error, 'bad_items');
  const before = JSON.stringify(sh.data);
  const pv = sb.handleFt8Revoke_({ admin_key: 'AK', items });
  assert.strictEqual(pv.scanned, 3);
  assert.strictEqual(JSON.stringify(pv.items.map((x) => x.date + ' ' + x.emp_id)), JSON.stringify([DA + ' E01', DB + ' E01']));
  assert.ok(/還差 0\.5 小時/.test(pv.items[0].probs[0]), pv.items[0].probs[0]);
  assert.strictEqual(JSON.stringify(sh.data), before);
  const ap = sb.handleFt8Revoke_({ admin_key: 'AK', items, apply: true });
  assert.strictEqual(ap.moved, 2);
  assert.strictEqual(JSON.stringify(sh.data.slice(1).map((r) => r[0] + ' ' + r[1])), JSON.stringify([DA + ' E02', DB + ' E02']));
  assert.strictEqual(sheets.approved_revoked.data.length, 3);
  assert.strictEqual(sb.handleFt8Revoke_({ admin_key: 'AK', items, apply: true }).moved, 0);
  sb.__props.REQ_FT8_FROM = 'off';
  assert.strictEqual(sb.handleFt8Revoke_({ admin_key: 'AK', items }).error, 'ft8_off');
});
console.log('全部 ' + n + ' 項通過');
