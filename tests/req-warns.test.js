// 請假提醒（只提醒不擋）與「本月第 N 次忘打卡」（2026-11-06 Eason，人資作業辦法）：Requests.gs reqWarns_／reqMarkOne_。
// 事假應前一天請、出差應前一週填、本月事假第 3 次起／合計超過 3 天 → warns；忘打卡 → miss_n。送單與主管審核都照收。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const sb = { console, Date, JSON, Math, String, Number, isNaN, parseInt, Object, Array, RegExp };
vm.createContext(sb);
vm.runInContext(codeSrc.match(/function actingName_\([\s\S]*?\n\}\n/)[0], sb);
vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8'), sb);
const J = (x) => JSON.parse(JSON.stringify(x));
let rows = [];
const mk = (o) => Object.assign({ id: 'r' + (rows.length + 1), created_at: '2026-10-01T09:00:00+08:00', emp_id: 'E01', name: '測試一', kind: 'leave',
  date: '2026-10-12', leave_type: '事假', start: '', end: '', hours: 8, miss_type: '', reason: '', attach_id: '', status: 'pending',
  decided_at: '', decided_by: '', reject_reason: '', seen_at: '', comp: '' }, o);
Object.assign(sb, {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  normCellTs: (v) => String(v || ''), nowTaipeiIso: () => '2026-10-10T10:00:00+08:00', todayTaipeiStr: () => '2026-10-10',
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  getSS: () => ({ getSheetByName: () => null }), reqSheet_: () => ({}),
  reqRows_: () => sb.reqSickMark_(rows.map((r, i) => Object.assign(r, { __rowIndex: i + 2 }))),
  reqSetCells_: (sh, idx, patch) => Object.assign(rows[idx - 2], patch),
  reqMgr_: (b) => (b.mgr_key === 'mk' ? { name: '主管甲' } : null),
  liffEvents_: () => [], reqUpperCache_: () => ({}), reqUpperWhy_: () => '', reqMgrActing_: () => false, reqDayPunches_: () => [],
});
const pub = () => sb.reqRows_().map((r) => J(sb.reqPublic_(r)));

ok('事假：前一天以前送 → 沒提醒；當天送、事後送 → 「事假應在前一天請」', () => {
  rows = [mk({ date: '2026-10-12', created_at: '2026-10-11T20:00:00+08:00' }), mk({ date: '2026-10-12', created_at: '2026-10-12T08:00:00+08:00', emp_id: 'E02' }),
          mk({ date: '2026-10-12', created_at: '2026-10-14T08:00:00+08:00', emp_id: 'E03' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.deepStrictEqual(pub().map((x) => x.warns), [[], ['事假應在前一天請（這張是當天才送）'], ['事假應在前一天請（這張是事後才送）']]);
});
ok('事假：本月第 3 次起提醒（依日期排；退回、取消、作廢不算；別的月份、別人不算）', () => {
  rows = [mk({ date: '2026-10-03' }), mk({ date: '2026-10-20', hours: 4 }), mk({ date: '2026-10-05', status: 'rejected' }),
          mk({ date: '2026-10-08', hours: 4 }), mk({ date: '2026-09-30', created_at: '2026-09-01T09:00:00+08:00' }), mk({ date: '2026-10-09', emp_id: 'E02' }), mk({ date: '2026-10-25', status: 'cancelled' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const p = pub();
  assert.deepStrictEqual(p[0].warns, []);
  assert.deepStrictEqual(p[3].warns, []);                       // 10/08 第 2 次
  assert.deepStrictEqual(p[1].warns, ['本月第 3 次事假']);         // 10/20 第 3 次；合計 8+4+4=16 小時＝2 天
  assert.deepStrictEqual(p[4].warns, []);                       // 9 月
  assert.deepStrictEqual(p[5].warns, []);                       // 別人
});
ok('事假：本月合計超過 3 天（8 小時一天）提醒，兩次也會', () => {
  rows = [mk({ date: '2026-10-03', hours: 16 }), mk({ date: '2026-10-20', hours: 10 })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.deepStrictEqual(pub()[1].warns, ['本月事假合計 3.3 天，超過 3 天']);
});
ok('出差：一週前填沒提醒；6 天前、當天、事後提醒', () => {
  const t = (date, made) => mk({ kind: 'trip', leave_type: '出差', date, created_at: made + 'T09:00:00+08:00' });
  rows = [t('2026-10-20', '2026-10-13'), t('2026-10-20', '2026-10-14'), t('2026-10-20', '2026-10-20'), t('2026-10-20', '2026-10-22')];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.deepStrictEqual(pub().map((x) => x.warns), [[], ['出差應在一週前填（只提前 6 天）'], ['出差應在一週前填（當天才填）'], ['出差應在一週前填（事後才填）']]);
});
ok('提醒不擋：有提醒的事假照樣核准（單筆、批次）', () => {
  rows = [mk({ date: '2026-10-12', created_at: '2026-10-12T08:00:00+08:00' }), mk({ date: '2026-10-13', created_at: '2026-10-13T08:00:00+08:00' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'approve' }).ok, true);
  assert.deepStrictEqual(J(sb.handleMgrReqDecideBatch_({ mgr_key: 'mk', ids: ['r2'], decision: 'approve' })).done, ['r2']);
});
ok('忘打卡：本月第幾次（依日期、同日看送出先後；退回不算；跨月重算）', () => {
  const m = (date, made, o) => mk(Object.assign({ kind: 'miss', leave_type: '', miss_type: 'out', date, created_at: made }, o || {}));
  rows = [m('2026-10-02', '2026-10-02T23:00'), m('2026-10-09', '2026-10-09T23:00'), m('2026-10-05', '2026-10-05T23:00', { status: 'rejected' }),
          m('2026-10-09', '2026-10-09T22:00', { miss_type: 'in' }), m('2026-11-01', '2026-11-01T22:00'), m('2026-10-20', '2026-10-20T22:00', { status: 'approved' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.deepStrictEqual(pub().map((x) => x.miss_n), [1, 3, 2, 2, 1, 4]);
  assert.deepStrictEqual(pub()[0].warns, []);   // 忘打卡不放 warns（主管頁另外顯示第 N 次）
});
ok('主管待審清單帶 warns 與 miss_n', () => {
  rows = [mk({ date: '2026-10-12', created_at: '2026-10-12T08:00:00+08:00' }), mk({ kind: 'miss', leave_type: '', miss_type: 'out', date: '2026-10-09' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const it = J(sb.handleMgrReqPending_({ mgr_key: 'mk' })).items;
  const by = {}; it.forEach((x) => { by[x.kind] = [x.warns, x.miss_n]; });
  assert.deepStrictEqual(by, { leave: [['事假應在前一天請（這張是當天才送）'], null], miss: [[], 1] });
});
console.log('\n' + n + ' 項全過');
