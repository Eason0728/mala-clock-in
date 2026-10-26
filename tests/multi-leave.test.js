// 一天多種假別（2026-10-26）：真的 Code.gs（mgr_approve／mgr_day／replaceLeaveRows）跑在假試算表上。
// 釘住：①新版核定頁送 leaves[] 可以一天寫多列 ②出差時數加進核定、其他假別不加 ③同假別重複、超過上限擋
// ④只送 leave_type 的舊呼叫端（營運系統）遇到多種假別的那天被擋、什麼都不寫 ⑤mgr_day 回 leaves＋舊欄位取第一列
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function sheet(rows) {
  const data = rows.map((r) => r.slice());
  return {
    data,
    getDataRange() { return { getValues: () => data.map((r) => r.slice()) }; },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(i) { data.splice(i - 1, 1); },
    getLastRow() { return data.length; },
    getLastColumn() { return data[0] ? data[0].length : 0; },
    getRange() { return { setValues() {}, setNumberFormat() {}, getValues: () => [[]] }; },
  };
}
function env(leaveRows) {
  const sheets = {
    managers: sheet([['name', 'key', 'active'], ['測試主管', 'MK', 'true']]),
    roster: sheet([['emp_id', 'name', 'key', 'active'], ['E01', '測試一', 'k1', 'true'], ['E02', '測試二', 'k2', 'true']]),
    events: sheet([['ts', 'emp_id', 'type', 'status']]),
    approved: sheet([['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at']]),
    leave: sheet([['日期', '姓名', '假別', '時數']].concat(leaveRows || [])),
  };
  const sb = { console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array, RegExp, Error };
  vm.createContext(sb);
  vm.runInContext(code, sb);
  sb.getSS = () => ({ getSheetByName: (k) => sheets[k] || null });
  sb.nowTaipeiIso = () => '2026-10-26T21:00:00+08:00';
  sb.todayTaipeiStr = () => '2026-10-26';
  sb.leaveTypeAllowedByPayroll = (t) => t === '天災假';   // 白名單外的只放行天災假
  sb.__s = sheets;
  return sb;
}
const D = '2026-10-23';
const rowsOf = (sb, nm) => sb.__s.leave.data.slice(1).filter((r) => r[0] === D && r[1] === nm).map((r) => r[2] + ':' + r[3]);
const appr = (sb) => sb.__s.approved.data[sb.__s.approved.data.length - 1];

ok('整天：出差 4＋天災假 4 → 核定 4 小時、狀態出差、leave 兩列', () => {
  const sb = env([[D, '測試一', '出差', 8]]);   // 舊的 8 小時出差會被取代
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [],
    leaves: [{ type: '出差', hours: 4 }, { type: '天災假', hours: 4 }] });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.approved_hours, 4); assert.strictEqual(r.status_text, '出差');
  assert.deepStrictEqual(rowsOf(sb, '測試一'), ['出差:4', '天災假:4']);
  assert.strictEqual(appr(sb)[4], 4);
  assert.strictEqual(r.leave_type, '出差'); assert.strictEqual(r.leaves.length, 2);
});
ok('有上班時段：上班 4＋出差 2＋事假 2 → 核定 6（事假不加）', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '13:00' }],
    leaves: [{ type: '出差', hours: 2 }, { type: '事假', hours: 2 }] });
  assert(r.ok, JSON.stringify(r)); assert.strictEqual(r.approved_hours, 6);
  assert.deepStrictEqual(rowsOf(sb, '測試一'), ['出差:2', '事假:2']);
});
ok('整天兩種假別都不是出差 → 核定 0、全天請假', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '病假', hours: 4 }, { type: '事假', hours: 4 }] });
  assert(r.ok); assert.strictEqual(r.approved_hours, 0); assert.strictEqual(r.status_text, '全天請假');
});
ok('整天有出差但沒填出差時數 → trip_needs_hours，不寫入', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '出差', hours: '' }, { type: '天災假', hours: 4 }] });
  assert.strictEqual(r.error, 'trip_needs_hours'); assert.deepStrictEqual(rowsOf(sb, '測試一'), []); assert.strictEqual(sb.__s.approved.data.length, 1);
});
ok('同假別兩次、超過 4 種、負時數、未放行假別都擋', () => {
  const sb = env();
  const base = { mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] };
  assert.strictEqual(sb.handleMgrApprove(Object.assign({ leaves: [{ type: '事假', hours: 1 }, { type: '事假', hours: 2 }] }, base)).error, 'dup_leave_type');
  assert.strictEqual(sb.handleMgrApprove(Object.assign({ leaves: [1, 2, 3, 4, 5].map(() => ({ type: '事假', hours: 1 })) }, base)).error, 'too_many_leaves');
  assert.strictEqual(sb.handleMgrApprove(Object.assign({ leaves: [{ type: '事假', hours: -1 }] }, base)).error, 'bad_leave_hours');
  assert.strictEqual(sb.handleMgrApprove(Object.assign({ leaves: [{ type: '亂寫假', hours: 1 }] }, base)).error, 'bad_leave_type');
  assert.strictEqual(sb.__s.approved.data.length, 1);
});
ok('送空清單＝清掉那天所有假別；別人的、別天的不動', () => {
  const sb = env([[D, '測試一', '出差', 4], [D, '測試一', '天災假', 4], [D, '測試二', '事假', 8], ['2026-10-24', '測試一', '事假', 8]]);
  assert(sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], leaves: [] }).ok);
  assert.deepStrictEqual(rowsOf(sb, '測試一'), []);
  assert.strictEqual(sb.__s.leave.data.length, 3);   // 表頭＋測試二＋10/24
});
ok('舊呼叫端（只送 leave_type）：那天只有一種或沒有 → 照舊取代成一列', () => {
  const sb = env([[D, '測試一', '事假', 8]]);
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leave_type: '病假', leave_hours: 8 });
  assert(r.ok, JSON.stringify(r)); assert.deepStrictEqual(rowsOf(sb, '測試一'), ['病假:8']);
  const r2 = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leave_type: '出差', leave_hours: 6 });
  assert.strictEqual(r2.approved_hours, 6); assert.strictEqual(r2.status_text, '出差');
});
ok('舊呼叫端遇到多種假別的那天 → multi_leave_day，核定與假別都不寫', () => {
  const sb = env([[D, '測試一', '出差', 4], [D, '測試一', '天災假', 4]]);
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], leave_type: '出差', leave_hours: 4 });
  assert.strictEqual(r.error, 'multi_leave_day'); assert(/值班核定頁/.test(r.message));
  assert.deepStrictEqual(rowsOf(sb, '測試一'), ['出差:4', '天災假:4']); assert.strictEqual(sb.__s.approved.data.length, 1);
});
ok('mgr_day：回 leaves 全部，舊欄位 leave_type／leave_hours 取第一列', () => {
  const sb = env([[D, '測試一', '出差', 4], [D, '測試一', '天災假', 4]]);
  const fn = Object.keys(sb).find((k) => /^handleMgrDay$|^handleManagerDay$/.test(k)) || 'handleMgrDay';
  const r = sb[fn]({ mgr_key: 'MK', date: D });
  assert(r.ok, JSON.stringify(r));
  const e = r.employees.find((x) => x.emp_id === 'E01');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.leaves)), [{ type: '出差', hours: 4 }, { type: '天災假', hours: 4 }]);
  assert.strictEqual(e.leave_type, '出差'); assert.strictEqual(e.leave_hours, 4);
  const e2 = r.employees.find((x) => x.emp_id === 'E02');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e2.leaves)), []); assert.strictEqual(e2.leave_type, '');
});
console.log(`\n${n} 項全部通過`);
