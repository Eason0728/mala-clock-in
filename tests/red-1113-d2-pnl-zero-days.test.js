/**
 * 1113 紅燈 d2（Eason 2026-11-13 選 A）：損益人事成本估算（pnlLaborEstimate）跳過「在職 0 天、又沒有任何資料」的人
 * （打卡核定時數、請假、支援、加扣項、獎金、特休折算都沒有；同 payroll_calc 不產生列的判斷 payMonthActivity_），
 * 不再多算公司負擔健保（co_health 不乘在職比例，0 天的人原本整筆算進去）。有資料的照舊。
 * 今天 2026-11-10、估 11 月（到 11/09）。全部虛構同仁。
 */
'use strict';
const vm = require('vm');
const { load, ftEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const ST = 'SSLGF';
const ap = (date, emp, h) => ({ date, emp_id: emp, name: 'x', periods: '09:00-17:00', approved_hours: h, status_text: '正常', manager_name: 'x', entered_at: date + 'T20:00:00+08:00' });
function est(master, approved, leave, bonus) {
  const data = { master, holiday: [{ ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }], config: [], run: [], item: [], input: [], bonus: bonus || [], audit: [],
    leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [], store: [{ code: ST, name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true' }] };
  const s = load({ data, clock: { SSLGF: { roster: [], approved: approved || [], events: [], leave: leave || [], requests: [] } }, today: '2026-11-10', props: { PNL_KEY: 'k' } });
  vm.runInContext('checkPnlKey_ = function () { return null; }; pnlEstimateSheetsReady_ = function () { return true; };', s);
  return JSON.parse(JSON.stringify(s.call('handlePnlLaborEstimate_', { key: 'k', ym: '2026-11', store: ST })));
}
const E01 = ftEmp({ emp_id: 'E01', name: '代號甲', co_health: 1000, hire_date: '2021-01-01' });
const NEW = (o) => ftEmp(Object.assign({ emp_id: 'E12', name: '代號寅', co_health: 600, hire_date: '2026-11-20' }, o || {}));   // 11/20 才到職：估到 11/09 在職 0 天

{
  const base = est([E01], [ap('2026-11-02', 'E01', 8)]);
  const withNew = est([E01, NEW()], [ap('2026-11-02', 'E01', 8)]);
  eq(base.rows.co_health, 1000, 'd2-0 前提：只有 E01 時公司負擔健保 1000');
  eq(withNew.rows.co_health, 1000, 'd2-1 加一位 11/20 才到職、沒有任何資料的人 → 公司負擔健保仍是 1000（不多算 600）');
  eq(withNew.total, base.total, 'd2-2 合計也跟沒有他時一樣');
}
{
  // 有資料（核定時數）照舊算進去
  const r = est([E01, NEW()], [ap('2026-11-02', 'E01', 8), ap('2026-11-05', 'E12', 4)]);
  eq(r.rows.co_health, 1600, 'd2-3 反例：在職 0 天但有核定時數 → 照舊算（1000＋600）');
}
{
  // 有獎金也算有資料（請假日期在到職日前，薪資本來就不認，所以用獎金驗「有其他資料照舊」）
  const r = est([E01, NEW()], [ap('2026-11-02', 'E01', 8)], [], [{ ym: '2026-11', emp_id: 'E12', store: ST, bonus_type: 'sales', label: '業績', amount: 500, updated_at: '2026-11-05' }]);
  eq(r.rows.co_health, 1600, 'd2-4 反例：在職 0 天但有獎金 → 照舊算');
}
{
  // 已到職（有在職天數）但沒資料 → 照舊（只跳過在職 0 天的）
  const r = est([E01, NEW({ hire_date: '2026-11-03' })], [ap('2026-11-02', 'E01', 8)]);
  eq(r.rows.co_health, 1600, 'd2-5 反例：11/03 到職、在職天數大於 0、沒資料 → 照舊算');
}
console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
