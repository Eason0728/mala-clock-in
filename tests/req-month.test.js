// 申請單彙整列印：mgr_req_month 整月讀取（2026-11-02，Requests.gs）。測試姓名一律假名。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'apps-script');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

function FakeSheet(name, headers, rows) { this.name = name; this.data = [headers.slice()].concat((rows || []).map(r => r.slice())); }
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data.reduce((m, r) => Math.max(m, r.length), 0); };
FakeSheet.prototype.getDataRange = function () {
  const w = this.getLastColumn(), self = this;
  return { getValues: () => self.data.map(r => { const c = r.slice(); while (c.length < w) c.push(''); return c; }) };
};
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const self = this; nr = nr || 1; nc = nc || 1;
  return {
    getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (self.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
    setValue(v) { this.setValues([[v]]); },
    setValues(vv) { for (let i = 0; i < vv.length; i++) { while (self.data.length < r + i) self.data.push([]); for (let j = 0; j < vv[i].length; j++) { const row = self.data[r - 1 + i]; while (row.length < c + j - 1) row.push(''); row[c - 1 + j] = vv[i][j]; } } },
    setNumberFormat() { return this; },
  };
};

const ROSTER_H = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at'];
const EVENT_H = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const REQ_H = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp', 'voided_at', 'voided_by', 'void_reason'];
const ros = (id, name, active) => [id, name, 'k' + id, '', '', active === undefined ? true : active, '', '', '', '', '', '', '', ''];

function makeEnv(o) {
  o = o || {};
  const sheets = {};
  const add = (n, h, rows) => (sheets[n] = new FakeSheet(n, h, rows));
  const props = { STAFF_SVC_KEY: 'TESTSVCKEY-abc123' };
  if (!o.off) props.REQ_UPPER_ON = '1';   // 總開關：既有測試都在開著的狀態下跑
  const lock = { waitLock() {}, tryLock() { return true; }, releaseLock() {} };
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => add(n, [], []) };
  const sb = {
    console, Logger: { log() {} }, Date, Math, JSON, String, Number, Object, Array, isNaN, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty(k, v) { props[k] = v; }, deleteProperty(k) { delete props[k]; } }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({ get() { return null; }, put() {}, remove() {} }) },
    Utilities: { getUuid: () => 'u', formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString();
      return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19).replace(/^(.{10})T/, f.indexOf("'T'") >= 0 ? '$1T' : '$1 ') + (f.indexOf('XXX') >= 0 ? '+08:00' : ''); } },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  };
  vm.createContext(sb);
  vm.runInContext(read('Code.gs'), sb);
  vm.runInContext(read('Requests.gs'), sb);
  vm.runInContext(read('SvcStaff.gs'), sb);
  vm.runInContext('liffEvents_ = function () { return []; };', sb);
  add('roster', ROSTER_H, o.roster || []);
  add('events', EVENT_H, []);
  add('managers', o.mgrHeaders || ['name', 'key', 'active', 'allow_acting'], o.managers || []);
  add('requests', REQ_H, o.reqs || []);
  if (o.props) Object.assign(props, o.props);
  add('leave', ['日期', '姓名', '假別', '時數'], o.leaves || []);
  const J = x => JSON.parse(JSON.stringify(x));
  const fn = (name, body) => J(vm.runInContext('(function(b){return ' + name + '(b);})', sb)(body));
  const raw = (name, body) => vm.runInContext('(function(b){return ' + name + '(b);})', sb)(body);
  return { sb, sheets, props, fn, raw };
}
// id, created_at, emp, name, kind, date, leave_type, start, end, hours, miss_type, reason, attach_id, status, voided...
const rq = (id, emp, name, date, st, o) => { o = o || {};
  return [id, o.created || '2026-10-01T09:00:00+08:00', emp, name, o.kind || 'leave', date, o.type === undefined ? '事假' : o.type,
    o.start || '', o.end || '', o.hours === undefined ? 8 : o.hours, o.miss || '', o.reason || '', o.attach || '', st || 'approved',
    '', '', '', '', o.comp || '', '', '', '']; };
const M = { mgr_key: 'MK', ym: '2026-10' };
const OPS = { mgr_key: 'OPS', ym: '2026-10', acting_name: '測試代理' };
let n = 0; const ok = (name, f) => { f(); n++; console.log('✓ ' + name); };
const base = (o) => makeEnv(Object.assign({
  off: true,
  roster: [ros('E01', '測試一'), ros('E02', '測試二'), ros('E03', '測試 三'), ros('E04', '同名'), ros('E05', '同名')],
  managers: [['測試店長', 'MK', 'true', ''], ['營運系統', 'OPS', 'true', 'TRUE']],
}, o || {}));

ok('月份邊界：9/30、11/1 不列，10/1、10/31 列；跨夜單看開始日', () => {
  const e = base({ reqs: [
    rq('a', 'E01', '測試一', '2026-09-30'), rq('b', 'E01', '測試一', '2026-10-01'),
    rq('c', 'E01', '測試一', '2026-10-31', 'approved', { kind: 'ot', start: '22:00', end: '02:00', hours: 4, type: '' }),
    rq('d', 'E01', '測試一', '2026-11-01')],
    leaves: [['2026-09-30', '測試一', '事假', 8], ['2026-10-01', '測試一', '事假', 8], ['2026-10-31', '測試一', '特休', 4], ['2026-11-01', '測試一', '事假', 8]] });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ym, '2026-10');
  assert.deepStrictEqual(r.items.map(x => x.id), ['b', 'c']);
  assert.deepStrictEqual(r.leaves.map(x => x.date), ['2026-10-01', '2026-10-31']);
  const nov = e.fn('handleMgrReqMonth_', { mgr_key: 'MK', ym: '2026-11' });
  assert.deepStrictEqual(nov.items.map(x => x.id), ['d']);
});
ok('五種狀態都回，排序 date→created_at', () => {
  const e = base({ reqs: ['pending', 'approved', 'rejected', 'cancelled', 'voided'].map((s, i) =>
    rq('s' + i, 'E02', '測試二', '2026-10-05', s, { created: '2026-10-0' + (5 - i) + 'T08:00:00+08:00' })) });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.items.map(x => x.status), ['voided', 'cancelled', 'rejected', 'approved', 'pending']);
});
ok('型別嚴格：has_attach／upper 布林、hours 數字或 null、不回 attach_id／comp', () => {
  const e = base({ reqs: [rq('x', 'E01', '測試一', '2026-10-03', 'approved', { attach: 'ATT1234567890', comp: '補休' }),
    rq('y', 'E01', '測試一', '2026-10-04', 'approved', { kind: 'miss', hours: '', miss: 'in', start: '9:00', type: '' })],
    leaves: [['2026-10-03', '測試一', '病假', '']] });
  const r = e.raw('handleMgrReqMonth_', M);
  const x = r.items[0], y = r.items[1];
  assert.strictEqual(x.has_attach, true); assert.strictEqual(y.has_attach, false);
  assert.strictEqual(x.upper, false); assert.strictEqual(x.upper_kind, '');
  assert.strictEqual(x.hours, 8); assert.strictEqual(y.hours, null);
  assert.strictEqual(y.start, '09:00');
  assert(!('attach_id' in x)); assert(!('comp' in x));
  assert.strictEqual(typeof r.leaves[0].hours, 'number'); assert.strictEqual(r.leaves[0].hours, 0);
  assert.strictEqual(typeof r.unmatched, 'number');
});
ok('leave 姓名對員編照薪資：去頭尾空白完全相同、同名算最後一位；中間空白不同＝對不到；id 穩定且不重複', () => {
  const e = base({ leaves: [['2026-10-02', '測試三', '特休', 8], ['2026-10-02', '同名', '事假', 4], ['2026-10-03', '路人', '事假', 2], ['2026-10-04', ' 測試二 ', '出差', 8],
    ['2026-10-05', '測試 三', '事假', 1], ['2026-10-05', '測試 三', '事假', 2]] });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.leaves.map(x => x.emp_id), ['', 'E05', '', 'E02', 'E03', 'E03']);
  assert.strictEqual(r.unmatched, 2);
  assert.strictEqual(r.leaves[3].name, '測試二');
  assert.strictEqual(r.leaves[0].id, 'L|2026-10-02|測試三|特休');
  assert.deepStrictEqual(r.leaves.slice(4).map(x => x.id), ['L|2026-10-05|測試 三|事假', 'L|2026-10-05|測試 三|事假|2']);
});
ok('手填日期 2026-10-5 補零並算進當月；斜線日期同薪資不算', () => {
  const r = base({ leaves: [['2026-10-5', '測試一', '事假', 8], ['2026/10/06', '測試一', '事假', 8]] }).fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.leaves.map(x => x.date), ['2026-10-05']);
});
ok('申請列 emp_id 空白：不回（不讓整月讀取因一列壞資料失敗）', () => {
  const r = base({ reqs: [rq('ok1', 'E01', '測試一', '2026-10-05'), rq('bad', '', '無名', '2026-10-05')] }).fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.items.map(x => x.id), ['ok1']);
});
ok('Sheets 日期物件正常化（leave 與 requests）', () => {
  const d = new Date('2026-10-09T00:00:00+08:00');
  const e = base({ reqs: [rq('dd', 'E01', '測試一', d)], leaves: [[d, '測試一', '事假', 8]] });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.strictEqual(r.items[0].date, '2026-10-09'); assert.strictEqual(r.leaves[0].date, '2026-10-09');
});
ok('home：本店主管兩邊都看不到，營運系統帶 acting 看得到', () => {
  const o = { props: { REQ_HOME_EMPS: '["E02"]' },
    reqs: [rq('h1', 'E02', '測試二', '2026-10-06', 'pending'), rq('h2', 'E01', '測試一', '2026-10-06')],
    leaves: [['2026-10-06', '測試二', '事假', 8], ['2026-10-06', '測試一', '事假', 8]] };
  const r = base(o).fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.items.map(x => x.id), ['h2']); assert.deepStrictEqual(r.leaves.map(x => x.emp_id), ['E01']);
  const a = base(o).fn('handleMgrReqMonth_', OPS);
  assert.deepStrictEqual(a.items.map(x => x.id).sort(), ['h1', 'h2']); assert.strictEqual(a.leaves.length, 2);
  assert.strictEqual(a.items.find(x => x.id === 'h1').upper, false, '帶 acting 同 mgr_req_day：不算 upper');
  assert.strictEqual(a.items.find(x => x.id === 'h1').upper_kind, '');
});
ok('home 同時是本店值班主管：仍然藏（home 優先）', () => {
  const o = { off: false, props: { REQ_HOME_EMPS: '["E02"]' }, managers: [['測試二', 'MK', 'true', '']],
    reqs: [rq('h1', 'E02', '測試二', '2026-10-06')], leaves: [['2026-10-06', '測試二', '事假', 8]] };
  const r = base(o).fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual([r.items.length, r.leaves.length], [0, 0]);
});
ok('home 與別人同名：核定列整組藏，不會以別人或對不到的身分露出', () => {
  const o = { props: { REQ_HOME_EMPS: '["E04"]' }, leaves: [['2026-10-06', '同名', '病假', 8]] };
  const r = base(o).fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual([r.leaves.length, r.unmatched], [0, 0]);
  assert.deepStrictEqual(base(o).fn('handleMgrReqMonth_', OPS).leaves.map(x => x.emp_id), ['E05']);
});
ok('home 名單讀壞（*）：本店主管全部看不到有員編的，對不到的照列', () => {
  const r = base({ props: { REQ_HOME_EMPS: 'not json' }, reqs: [rq('z', 'E01', '測試一', '2026-10-07')],
    leaves: [['2026-10-07', '測試一', '事假', 8], ['2026-10-07', '路人', '事假', 8]] }).fn('handleMgrReqMonth_', M);
  assert.strictEqual(r.items.length, 0); assert.deepStrictEqual(r.leaves.map(x => x.name), ['路人']);
});
ok('acting_name 但鑰匙不是營運系統：不放行 home', () => {
  const r = base({ props: { REQ_HOME_EMPS: '["E02"]' }, reqs: [rq('h1', 'E02', '測試二', '2026-10-06')] })
    .fn('handleMgrReqMonth_', Object.assign({ acting_name: '冒名' }, M));
  assert.strictEqual(r.items.length, 0);
});
ok('沒有 requests／leave 分頁回空陣列', () => {
  const e = base();
  delete e.sheets.requests; delete e.sheets.leave;
  const x = e.fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual([x.ok, x.items, x.leaves, x.unmatched], [true, [], [], 0]);
});
ok('bad_ym 與 unauthorized', () => {
  const e = base();
  ['2026-13', '2026-1', '', '2026-10-01', '2026-00'].forEach(ym => assert.strictEqual(e.fn('handleMgrReqMonth_', { mgr_key: 'MK', ym }).error, 'bad_ym'));
  assert.strictEqual(e.fn('handleMgrReqMonth_', { mgr_key: 'NOPE', ym: '2026-10' }).error, 'unauthorized');
});
ok('值班主管本人的單照列並標 upper', () => {
  const e = base({ off: false, managers: [['測試一', 'MK', 'true', '']], reqs: [rq('u', 'E01', '測試一', '2026-10-08')] });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.strictEqual(r.items[0].upper, true); assert.strictEqual(r.items[0].upper_kind, 'mgr');
});
ok('LIFF_HANDLERS 有掛 mgr_req_month', () => {
  const src = read('Liff.gs');
  assert(/mgr_req_month: function \(b\) \{ return handleMgrReqMonth_\(b\); \}/.test(src));
});
console.log('\n' + n + ' 項通過');
