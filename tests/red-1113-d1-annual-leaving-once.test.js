/**
 * 1113 紅燈 d1（Eason 2026-11-13 選 A）：離職當月的特休折算照發，但更早的已鎖定薪資（run 狀態 final 的那個月、item 分頁 annual_payout）
 * 已經發過「同一個特休年度」的折算，這個月就不再發。
 * 例：到職 2024-05-01、離職日 2026-11-01（特休年度 2026-05-01 起）：10 月已鎖定且已含折算 → 11 月不發；10 月沒發 → 11 月照發。
 * 全部虛構同仁，金額照規則手算：月工資 39,000（30000＋3000＋3000＋全勤 3000）＋伙食 2,000＝41,000 ÷30 ÷8 ＝170.833… × 80 小時 ＝ 13,667。
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
const E = () => ftEmp({ emp_id: 'E05', name: '代號戊', hire_date: '2024-05-01', leave_date: '2026-11-01', active: 'false' });
function env(run, item) {
  const data = { master: [E()], holiday: [{ ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }], config: [], run: run || [], item: item || [], input: [], bonus: [],
    audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [], store: [{ code: ST, name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true' }] };
  const s = load({ data, clock: { SSLGF: { roster: [], approved: [], events: [], leave: [], requests: [] } }, today: '2026-12-02' });
  vm.runInContext('CONFIG.ADMIN_KEY = "k";', s);
  return s;
}
const RUN = (ym, status) => ({ ym, emp_id: 'E05', name: '代號戊', store: ST, status, net: 1 });
const PAYOUT = (ym, amt) => ({ ym, emp_id: 'E05', item_type: 'earning', item_key: 'annual_payout', item_label: '特休未休折算', qty: 80, rate: 170.83, amount: amt, source: 'auto', memo: '', store: ST });
const payoutOf = (s) => {
  const r = JSON.parse(JSON.stringify(s.call('handlePayrollCalc', { admin_key: 'k', ym: '2026-11', store: ST })));
  const row = (r.results || []).find((x) => x.emp_id === 'E05');
  const it = row ? row.earn.find((i) => i.item_key === 'annual_payout') : null;
  return it ? it.amount : 0;
};
const info = (s) => JSON.parse(JSON.stringify(s.call('payAnnualInfo', '2026-11', ST))).E05;

{
  const s = env([RUN('2026-10', 'final')], [PAYOUT('2026-10', 13667)]);
  eq(payoutOf(s), 0, 'd1-1 10 月已鎖定且已含折算 13,667 → 11 月不再發');
  eq([info(s).payout_ym, info(s).payout_h, info(s).payout_paid_ym], ['2026-11', 0, '2026-10'], 'd1-2 payAnnualInfo 標出已在 10 月發過（payout_h 0、payout_paid_ym）');
}
{
  const s = env([RUN('2026-10', 'final')], []);
  eq(payoutOf(s), 13667, 'd1-3 10 月鎖定但沒發折算 → 11 月照發 13,667');
}
{
  const s = env([], []);
  eq(payoutOf(s), 13667, 'd1-4 沒有更早的薪資 → 11 月照發 13,667');
}
{
  const s = env([RUN('2026-10', 'draft')], [PAYOUT('2026-10', 13667)]);
  eq(payoutOf(s), 13667, 'd1-5 反例：10 月只是草稿（沒鎖定）→ 不算發過，11 月照發');
}
{
  const s = env([RUN('2026-04', 'final')], [PAYOUT('2026-04', 9000)]);
  eq(payoutOf(s), 13667, 'd1-6 反例：2026-04 鎖定的是上一個特休年度（2025-05～2026-04）的折算 → 不算這次，11 月照發');
}
{
  const s = env([RUN('2026-10', 'final'), { ym: '2026-10', emp_id: 'E99', name: '別人', store: ST, status: 'final' }], [Object.assign(PAYOUT('2026-10', 5000), { emp_id: 'E99' })]);
  eq(payoutOf(s), 13667, 'd1-7 反例：10 月發折算的是別人 → 照發');
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
