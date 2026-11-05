// 單日 10 小時／兩班間隔 11 小時（2026-11-01；11-02 由 12 改 11，Rest.gs）：判斷規則、跨店、總開關、handleClock 寫 rejected_rest。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const rest = fs.readFileSync(ROOT + '/apps-script/Rest.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const T = (s) => Date.parse(s + '+08:00');
const iso = (ms) => new Date(ms + 8 * 3600000).toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
function fmt(d, tz, p) {
  const x = new Date(d.getTime() + 8 * 3600000), z = (v) => ('0' + v).slice(-2);
  return p.replace('yyyy', x.getUTCFullYear()).replace('MM', z(x.getUTCMonth() + 1)).replace('dd', z(x.getUTCDate()))
    .replace('HH', z(x.getUTCHours())).replace('mm', z(x.getUTCMinutes())).replace('M/d', (x.getUTCMonth() + 1) + '/' + x.getUTCDate());
}
const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
function sheet(values) {
  return { values, getLastRow: () => values.length, getLastColumn: () => values[0].length,
    getDataRange: () => ({ getValues: () => values.map(r => r.slice()) }),
    getRange: (r, c, nr, nc) => ({ getValues: () => values.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)),
      setValue: () => {}, setValues: () => {} }),
    appendRow: (row) => values.push(row) };
}
function book(id, roster, evs) {
  const sh = { roster: sheet([['emp_id', 'name', 'key', 'active', 'device_id'], ...roster]),
    events: sheet([EH, ...evs.map(e => [iso(T(e[0])), e[1], e[2], 24.78, 121.01, 5, true, 'D1', true, e[3] || 'ok', 10])]) };
  return { getId: () => id, getSheetByName: (n) => sh[n], sh };
}
function make(opts) {
  const props = { REST_RULE_ON: opts.on === false ? '' : '1' }, cache = {}, opened = [];
  const sb = { Date, String, Number, Math, JSON, isNaN, isFinite, parseFloat, Logger: { log: () => {} },
    CONFIG: { ALTERNATION_LOOKBACK_HOURS: 12, STORE_LAT: 24.78, STORE_LNG: 121.01, RADIUS_M: 50 },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k], setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    checkAdmin: (b) => b.admin_key === 'ADM',
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    SpreadsheetApp: { openById: (id) => { opened.push(id); const b = opts.peers[id]; if (!b) throw new Error('沒權限'); return b; } },
    Utilities: { formatDate: fmt }, REST_PEERS_: Object.keys(opts.peers || {}).map((id, i) => ({ code: 'p' + i, ss: id })).concat([{ code: 'self', ss: 'SELF' }]),
    ACCURACY_CREDIT_CAP_M: 30, LOW_ACCURACY_M: 50, ROSTER_HEADERS: ['emp_id', 'name', 'key', 'active', 'device_id', 'device_bound_at'],
    EVENTS_HEADERS: EH, haversineM: () => 5, SAME_TYPE_LOCK_MIN: 10 };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(sb.__now); } static now() { return sb.__now; } };
  sb.__now = opts.now;
  vm.createContext(sb);
  vm.runInContext(['readSheetAsObjects', 'readEventsSince', 'normCellTs', 'lastCountedEvent', 'clockMarkKey_', 'clockLastWithMark_', 'clockMarkPut_', 'clockMarkRestore_', 'empIdColText_', 'findRosterByKey', 'handleClock'].map(f => extract(code, f)).join('\n') + '\nvar EMPID_TEXT_DONE_ = {};\n' + rest, sb);
  const self = opts.self;
  sb.getSS = () => self;
  sb.nowTaipeiIso = () => iso(sb.__now);
  return { sb, cache, opened };
}
const ME = ['E01', '王 小明', 'K1', 'TRUE', 'D1'];
const judge = (evs, now, peers) => {
  const self = book('SELF', [ME], evs);
  const m = make({ now: T(now), self, peers: peers || {} });
  return m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王 小明' });
};

ok('昨天 22:40 下班、今天 09:00 打上班 → 擋，09:40 以後才能打', () => {
  const r = judge([['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T22:40:00', 'E01', 'out']], '2026-11-02T09:00:00');
  assert.strictEqual(r.code, 'gap');
  assert.strictEqual(r.until, T('2026-11-02T09:40:00'));
  assert.ok(r.reason.includes('11/1 22:40') && r.reason.includes('09:40') && r.reason.includes('11 小時'), r.reason);
});
ok('昨天 22:00 下班、今天 09:05 → 可以打（剛好過 11 小時也可以，08:59 擋）', () => {
  const ev = [['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T22:00:00', 'E01', 'out']];
  assert.strictEqual(judge(ev, '2026-11-02T09:05:00'), null);
  assert.strictEqual(judge(ev, '2026-11-02T09:00:00'), null);
  assert.strictEqual(judge(ev, '2026-11-02T08:59:00').code, 'gap');
  assert.strictEqual(judge(ev, '2026-11-02T10:00:00'), null);   // 舊規則（12 小時）會擋到 10:00，現在放行
});
ok('二段班：11:00–14:00 下班、17:00 回來打上班 → 不看間隔，可以打', () => {
  assert.strictEqual(judge([['2026-11-02T11:00:00', 'E01', 'in'], ['2026-11-02T14:00:00', 'E01', 'out']], '2026-11-02T17:00:00'), null);
});
ok('當天已打卡滿 10 小時再打上班 → 2026-11-06 起不擋、只提醒（REST_LAST_WARN_ 有 cap）；9.5 小時沒有提醒', () => {
  const evs = [['2026-11-02T08:00:00', 'E01', 'in'], ['2026-11-02T13:00:00', 'E01', 'out'],
    ['2026-11-02T14:00:00', 'E01', 'in'], ['2026-11-02T19:00:00', 'E01', 'out']];
  const self = book('SELF', [ME], evs);
  const m = make({ now: T('2026-11-02T20:00:00'), self, peers: {} });
  assert.strictEqual(m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王 小明' }), null);
  const w = vm.runInContext('REST_LAST_WARN_', m.sb);
  assert.strictEqual(w.code, 'cap'); assert.strictEqual(w.warn, true); assert.ok(w.reason.includes('10 小時'), w.reason);
  const st = m.sb.restStatus_(self, { emp_id: 'E01', name: '王 小明' });
  assert.strictEqual(st.blocked, false); assert.strictEqual(st.warn.code, 'cap');
  // handleClock 照收（寫 ok，不寫 rejected_rest）
  const r = m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.78, lng: 121.01, device_id: 'D1' });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(judge([['2026-11-02T08:00:00', 'E01', 'in'], ['2026-11-02T17:30:00', 'E01', 'out']], '2026-11-02T18:00:00'), null);
  const self2 = book('SELF', [ME], [['2026-11-02T08:00:00', 'E01', 'in'], ['2026-11-02T17:30:00', 'E01', 'out']]);
  const m2 = make({ now: T('2026-11-02T18:00:00'), self: self2, peers: {} });
  assert.strictEqual(JSON.stringify(m2.sb.restStatus_(self2, { emp_id: 'E01', name: '王 小明' })), '{"blocked":false}');
});
ok('跨夜班 22:00–02:00 歸前一天：同一天 10:00 打上班 → 距離 02:00 不到 11 小時，擋到 13:00', () => {
  const r = judge([['2026-11-01T22:00:00', 'E01', 'in'], ['2026-11-02T02:00:00', 'E01', 'out']], '2026-11-02T10:00:00');
  assert.strictEqual(r.code, 'gap'); assert.strictEqual(r.until, T('2026-11-02T13:00:00'));
  assert.ok(r.reason.includes('今天 02:00'), r.reason);
});
ok('忘了打下班卡（只有上班卡）→ 算不出間隔，不擋', () => {
  assert.strictEqual(judge([['2026-11-01T17:00:00', 'E01', 'in']], '2026-11-02T08:00:00'), null);
});
ok('被擋下的卡（rejected_*）不算；別人的卡不算', () => {
  assert.strictEqual(judge([['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T23:00:00', 'E01', 'out', 'rejected_out_of_range'],
    ['2026-11-01T11:00:00', 'E02', 'in'], ['2026-11-01T23:30:00', 'E02', 'out']], '2026-11-02T09:00:00'), null);
});
ok('跨店：金山 23:00 下班（姓名去空白相同）、隔天 09:00 光復打上班 → 擋到 10:00；別家同名停用的不算', () => {
  const js = book('JS', [['M05', '王小明', 'x', 'TRUE', '']], [['2026-11-01T15:00:00', 'M05', 'in'], ['2026-11-01T23:00:00', 'M05', 'out']]);
  const r = judge([], '2026-11-02T09:00:00', { JS: js });
  assert.strictEqual(r.code, 'gap'); assert.strictEqual(r.until, T('2026-11-02T10:00:00'));
  const off = book('JS', [['M05', '王小明', 'x', 'FALSE', '']], [['2026-11-01T15:00:00', 'M05', 'in'], ['2026-11-01T23:00:00', 'M05', 'out']]);
  assert.strictEqual(judge([], '2026-11-02T09:00:00', { JS: off }), null);
});
ok('跨店：別家店名冊快取起來，第二次只開有同名的店；讀不到的店跳過、不擋', () => {
  const js = book('JS', [['M05', '王小明', 'x', 'TRUE', '']], []);
  const other = book('MC', [['X1', '別人', 'x', 'TRUE', '']], []);
  const self = book('SELF', [ME], []);
  const m = make({ now: T('2026-11-02T09:00:00'), self, peers: { JS: js, MC: other } });
  m.sb.REST_PEERS_.push({ code: 'bad', ss: 'NOPE' });
  assert.strictEqual(m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王小明' }), null);
  const first = m.opened.length; m.opened.length = 0;
  m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王小明' });
  assert.deepStrictEqual(Array.from(m.opened), ['JS', 'NOPE'], '快取後只開金山（讀 events）和讀不到的那家');
  assert.ok(first >= 3);
});
ok('總開關關著（REST_RULE_ON 不是 1）→ 一律不擋', () => {
  const self = book('SELF', [ME], [['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T23:40:00', 'E01', 'out']]);
  const m = make({ now: T('2026-11-02T10:00:00'), self, peers: {}, on: false });
  assert.strictEqual(m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王 小明' }), null);
});
ok('handleClock：上班卡被擋 → 寫一列 rejected_rest、回 rest；下班卡照收', () => {
  const self = book('SELF', [ME], [['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T23:40:00', 'E01', 'out']]);
  const m = make({ now: T('2026-11-02T10:00:00'), self, peers: {} });
  const r = m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.78, lng: 121.01, device_id: 'D1' });
  assert.strictEqual(r.status, 'rejected_rest'); assert.strictEqual(r.rest.code, 'gap');
  const rows = self.sh.events.values; assert.strictEqual(rows[rows.length - 1][9], 'rejected_rest');
  // 被擋的那張不算數：時間到了再打就過
  m.sb.__now = T('2026-11-02T10:41:00');
  assert.strictEqual(m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.78, lng: 121.01, device_id: 'D1' }).status, 'ok');
  m.sb.__now = T('2026-11-02T22:00:00');
  assert.strictEqual(m.sb.handleClock({ key: 'K1', type: 'out', lat: 24.78, lng: 121.01, device_id: 'D1' }).status, 'ok');
});
ok('handleClock：10 分鐘內重複上班卡照舊回 rejected_duplicate（不先講休息不足）', () => {
  const self = book('SELF', [ME], [['2026-11-02T09:00:00', 'E01', 'in']]);
  const m = make({ now: T('2026-11-02T09:05:00'), self, peers: {} });
  assert.strictEqual(m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.78, lng: 121.01, device_id: 'D1' }).status, 'rejected_duplicate');
});
ok('handleClock：超過 10 分鐘的同型上班卡照收（2026-11-02）；前一張沒下班卡，休息規則不誤擋', () => {
  const self = book('SELF', [ME], [['2026-11-02T08:49:00', 'E01', 'in']]);
  const m = make({ now: T('2026-11-02T18:00:00'), self, peers: {} });
  assert.strictEqual(m.sb.handleClock({ key: 'K1', type: 'in', lat: 24.78, lng: 121.01, device_id: 'D1' }).status, 'ok');
});
ok('restStatus_：被擋回 blocked＋until；沒擋回 blocked:false', () => {
  const self = book('SELF', [ME], [['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T23:40:00', 'E01', 'out']]);
  const m = make({ now: T('2026-11-02T10:00:00'), self, peers: {} });
  const s = m.sb.restStatus_(self, { emp_id: 'E01', name: '王 小明' });
  assert.strictEqual(s.blocked, true); assert.strictEqual(s.until, T('2026-11-02T10:40:00'));
  m.sb.__now = T('2026-11-02T11:00:00');
  assert.strictEqual(m.sb.restStatus_(self, { emp_id: 'E01', name: '王 小明' }).blocked, false);
});
ok('rest_rule_set：管理金鑰才能開關；不帶 on 只查；開了才擋', () => {
  const self = book('SELF', [ME], [['2026-11-01T11:00:00', 'E01', 'in'], ['2026-11-01T23:40:00', 'E01', 'out']]);
  const m = make({ now: T('2026-11-02T10:00:00'), self, peers: {}, on: false });
  assert.strictEqual(m.sb.handleRestRuleSet_({ admin_key: '', on: true }).error, 'unauthorized');
  assert.strictEqual(m.sb.handleRestRuleSet_({ admin_key: 'bad', on: true }).error, 'unauthorized');
  assert.strictEqual(m.sb.handleRestRuleSet_({ admin_key: 'ADM' }).on, false);
  assert.strictEqual(m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王 小明' }), null);
  assert.strictEqual(m.sb.handleRestRuleSet_({ admin_key: 'ADM', on: true }).on, true);
  assert.strictEqual(m.sb.restCheckIn_(self, { emp_id: 'E01', name: '王 小明' }).code, 'gap');
  assert.strictEqual(m.sb.handleRestRuleSet_({ admin_key: 'ADM', on: false }).on, false);
});
ok('每日超時檢查：各店前一天核定超過 10 小時的人（同一天多筆取最新；總部鏡像同一人只列一次；剛好 10 小時不列）', () => {
  const pay = fs.readFileSync(ROOT + '/apps-script/Payroll.gs', 'utf8');
  const sb = { Date, String, Number, Math, JSON, isNaN, PAY_DAY_MAX_H: 10 };
  vm.createContext(sb);
  vm.runInContext(['buildLatestApprovedMap', 'normCellDate', 'normCellTs'].map(f => extract(code, f)).join('\n') + '\n' + extract(pay, 'payRestOverList_'), sb);
  const A = {
    CF: [{ date: '2026-11-01', emp_id: 'CF03', name: '張 三', approved_hours: 11, periods: '07:00-18:00', entered_at: '2026-11-01T20:00:00+08:00' },
         { date: '2026-11-01', emp_id: 'CF04', name: '李四', approved_hours: 12, periods: '07:00-19:00', entered_at: '2026-11-01T20:00:00+08:00' },
         { date: '2026-11-01', emp_id: 'CF04', name: '李四', approved_hours: 9, periods: '07:00-16:00', entered_at: '2026-11-01T21:00:00+08:00' },
         { date: '2026-11-01', emp_id: 'HQ-01', name: '吳五', approved_hours: 10.5, periods: '08:00-18:30', entered_at: '2026-11-01T20:00:00+08:00' },
         { date: '2026-11-01', emp_id: 'CF05', name: '陳六', approved_hours: 10, periods: '08:00-18:00', entered_at: '2026-11-01T20:00:00+08:00' },
         { date: '2026-10-31', emp_id: 'CF03', name: '張 三', approved_hours: 13, periods: '', entered_at: '2026-10-31T20:00:00+08:00' }],
    HQ: [{ date: '2026-11-01', emp_id: 'HQ-01', name: '吳五', approved_hours: 10.5, periods: '08:00-18:30', entered_at: '2026-11-01T20:00:00+08:00' }],
    MZTJS: [] };
  Object.assign(sb, { payStoreList: () => [{ code: 'CF', name: '央廚' }, { code: 'HQ', name: '總部' }, { code: 'MZTJS', name: '金山' }, { code: 'X', name: '沒打卡' }],
    payHasClock: (c) => c !== 'X', payClockRead: (c) => A[c], payStore: (c) => c, payNum: (v) => Number(v) || 0 });
  const r = Array.from(sb.payRestOverList_('2026-11-01')).map(x => x.store + ':' + x.name + ':' + x.hours);
  assert.deepStrictEqual(r, ['CF:張 三:11', 'CF:吳五:10.5']);
});
console.log(`\n${n} 項全部通過`);
