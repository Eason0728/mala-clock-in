/**
 * 薪酬挑錯第 8 項：10 月鎖定前也要用最新資料重算比對（Eason 2026-11-11 確認）。
 *  規則：
 *   ① 鎖定前「用最新資料重算、和草稿比」的起始月份＝2026-10（原本 2026-11）。
 *      2026-10 的草稿算完之後主檔改過、沒重算就按鎖定 → 不鎖，回 stale_run 與差異名單。
 *   ② 2026-10 草稿和現在重算的結果相同 → 照常鎖定。
 *   ③ 2026-09 以前的月份不比對（照舊直接鎖）。
 *   ④ 2026-11 照舊會擋。
 *   ⑤ 只改這一個判斷：payOtDailyOn（逐日加班的開關）仍是 2026-11 起；補休抵不掉、加班單、班表、未核定
 *      那四道檢查仍只屬於 2026-11 起。
 *   ⑥ 解鎖不比對。
 *  全部虛構同仁（只用代號），金額照規則手算寫死：
 *   正職整月在職、時數＝基本工時：底薪 30000＋全勤 3000＋職能 3000＋夜間 3000＝應發 39000；健保 470；實付 38530。
 *   底薪改成 32000 之後：應發 41000；健保 470；實付 40530。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const E01 = (o) => ftEmp(Object.assign({ emp_id: 'E01', name: '代號甲', health_ins: 470 }, o || {}));
const E02 = (o) => ftEmp(Object.assign({ emp_id: 'E02', name: '代號乙', health_ins: 470 }, o || {}));
const inRow = (ym, emp, o) => Object.assign({ ym: ym, emp_id: emp, store: ST, hours: 0, extra_ot: 0, deduct_days: 0, support: '[]', hours_manual: '' }, o || {});
// 紅字天數：9 月 30 天−8＝22 天×8＝176H；10 月 31 天−8＝23 天×8＝184H；11 月 30 天−10＝20 天×8＝160H
const fresh = (master, input) => ({
  master: master,
  holiday: [{ ym: '2026-09', red_days: 8, note: '', dates: '', store: '' }, { ym: '2026-10', red_days: 8, note: '', dates: '', store: '' },
            { ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }],
  config: [], run: [], item: [], input: input || [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  store: [{ code: 'SSLGF', name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
});
const clock = () => ({ SSLGF: { roster: [], approved: [], events: [], leave: [], requests: [] } });
function env(data, today) {
  const s = load({ data: data, clock: clock(), today: today || '2026-11-10' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __TODAY.slice(0, 7); };`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const runOf = (s, ym, id) => (s.__DATA.run || []).filter(x => String(x.ym) === ym && String(x.emp_id) === id).map(x => [Number(x.gross), Number(x.deduction), Number(x.net), String(x.status)]);
const setBase = (s, id, v) => s.__DATA.master.forEach(x => { if (String(x.emp_id) === id) x.base = v; });
const audits = (s, ym) => (s.__DATA.audit || []).filter(x => String(x.ym) === ym).map(x => x.action);

/* ── A. 2026-10：草稿算完後主檔改薪、沒重算就鎖 → 擋下 ── */
{
  const s = env(fresh([E01()], [inRow('2026-10', 'E01', { hours: 184 })]));
  const c = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(c.ok, true, 'A0 10 月試算成功');
  eq(runOf(s, '2026-10', 'E01'), [[39000, 470, 38530, 'draft']], 'A0 草稿：應發 39000、扣款 470、實付 38530');
  setBase(s, 'E01', 32000);
  const f = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA' });
  eq([f.ok, f.error], [false, 'stale_run'], 'A1 10 月主檔改過沒重算就鎖定 → 不鎖，回 stale_run');
  eq(f.list, [{ name: '代號甲', old_net: 38530, new_net: 40530, money: true }], 'A2 差異名單：代號甲 實付 38530 → 40530');
  eq(String(f.message || '').indexOf('代號甲：實付 38530 → 40530') >= 0, true, 'A3 訊息寫出「代號甲：實付 38530 → 40530」');
  eq(runOf(s, '2026-10', 'E01'), [[39000, 470, 38530, 'draft']], 'A4 月結表仍是草稿，數字沒被改');
  eq(audits(s, '2026-10'), [], 'A5 沒有寫鎖定稽核');
  // 重新計算之後再鎖 → 成功，鎖下去的是新數字
  const c2 = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(c2.ok, true, 'A6 重新計算成功');
  const f2 = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA' });
  eq(f2.ok, true, 'A7 重新計算後再鎖定 → 成功');
  eq(runOf(s, '2026-10', 'E01'), [[41000, 470, 40530, 'final']], 'A8 鎖下去的是新數字：應發 41000、扣款 470、實付 40530');
  eq(audits(s, '2026-10'), ['lock'], 'A9 寫了一筆鎖定稽核');
}

/* ── B. 2026-10：草稿和現在重算相同 → 照常鎖定；10 月不套 2026-11 起的檢查 ── */
{
  const s = env(fresh([E01()], [inRow('2026-10', 'E01', { hours: 184 })]));
  s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const f = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA' });
  eq([f.ok, f.error], [true, undefined], 'B1 10 月草稿沒過期 → 鎖定成功（班表是空的也不擋：班表檢查只屬於 2026-11 起）');
  eq(runOf(s, '2026-10', 'E01'), [[39000, 470, 38530, 'final']], 'B2 鎖定的數字：39000／470／38530');
  // 解鎖不比對：主檔改了，解鎖照樣成功
  setBase(s, 'E01', 32000);
  const u = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: false, reason: '測試解鎖', operator: 'QA' });
  eq([u.ok, u.error], [true, undefined], 'B3 解鎖不比對：主檔改過，解鎖仍成功');
  eq(runOf(s, '2026-10', 'E01'), [[39000, 470, 38530, 'draft']], 'B4 解鎖後回到草稿，數字不動');
}

/* ── C. 2026-10：草稿算完後主檔多了一位在職同仁 → 擋下（草稿沒有這個人） ── */
{
  const s = env(fresh([E01()], [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'E02', { hours: 184 })]));
  s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  s.__DATA.master.push(E02());
  const f = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA' });
  eq([f.ok, f.error], [false, 'stale_run'], 'C1 10 月草稿少一個人 → 不鎖，回 stale_run');
  eq(f.list, [{ name: '代號乙', is_new: true, new_net: 38530 }], 'C2 差異名單：代號乙 草稿沒有這個人、現值實付 38530');
  eq(runOf(s, '2026-10', 'E01'), [[39000, 470, 38530, 'draft']], 'C3 月結表仍是草稿');
}

/* ── D. 2026-09：不比對，照舊直接鎖 ── */
{
  const s = env(fresh([E01()], [inRow('2026-09', 'E01', { hours: 176 })]));
  const c = s.post('handlePayrollCalc', { ym: '2026-09', store: ST });
  eq(c.ok, true, 'D0 9 月試算成功');
  eq(runOf(s, '2026-09', 'E01'), [[39000, 470, 38530, 'draft']], 'D0 9 月草稿：39000／470／38530');
  setBase(s, 'E01', 32000);
  const f = s.post('handlePayrollFinalize', { ym: '2026-09', store: ST, lock: true, operator: 'QA' });
  eq([f.ok, f.error], [true, undefined], 'D1 9 月主檔改過沒重算就鎖定 → 照舊鎖定成功（2026-09 以前不比對）');
  eq(runOf(s, '2026-09', 'E01'), [[39000, 470, 38530, 'final']], 'D2 9 月鎖下去的是原草稿 39000／470／38530');
}

/* ── E. 2026-11：照舊會擋 ── */
{
  const s = env(fresh([E01()], [inRow('2026-11', 'E01', { hours: 160, hours_manual: '1' })]), '2026-12-05');
  const c = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq(c.ok, true, 'E0 11 月試算成功');
  setBase(s, 'E01', 32000);
  const f = s.post('handlePayrollFinalize', { ym: '2026-11', store: ST, lock: true, operator: 'QA' });
  eq([f.ok, f.error], [false, 'stale_run'], 'E1 11 月主檔改過沒重算就鎖定 → 照舊回 stale_run');
  eq(runOf(s, '2026-11', 'E01').map(x => x[3]), ['draft'], 'E2 11 月月結表仍是草稿');
}

/* ── F. 只改這一個判斷 ── */
{
  const s = env(fresh([E01()]));
  eq(vm.runInContext('typeof PAY_LOCK_RECHECK_FROM === "undefined" ? null : PAY_LOCK_RECHECK_FROM', s), '2026-10', 'F1 常數 PAY_LOCK_RECHECK_FROM＝2026-10');
  eq(vm.runInContext('PAY_OT_DAILY_FROM', s), '2026-11', 'F2 逐日加班起始月 PAY_OT_DAILY_FROM 仍是 2026-11');
  eq([s.call('payOtDailyOn', '2026-10'), s.call('payOtDailyOn', '2026-11')], [false, true], 'F3 payOtDailyOn：2026-10 關、2026-11 開（沒有被動到）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
  const a = src.indexOf('function handlePayrollFinalize(body)'), b = src.indexOf('\nfunction ', a + 10);
  const body = src.slice(a, b);
  eq((body.match(/if \(lock && payOtDailyOn\(ym\)\)/g) || []).length, 4, 'F4 handlePayrollFinalize 裡仍用 payOtDailyOn 的檢查剩 4 道（補休抵不掉、加班單、班表、未核定）');
  eq((body.match(/payLockStale_\(/g) || []).length, 1, 'F5 payLockStale_ 只在一處呼叫');
  // 常數要放在引擎純函式區（function payR0 到 Handlers 之間）
  const p0 = src.indexOf('function payR0'), p1 = src.indexOf('/* ═══════════════════ Handlers'), pc = src.indexOf('var PAY_LOCK_RECHECK_FROM');
  eq(pc > p0 && pc < p1, true, 'F6 常數宣告在「function payR0」到「Handlers」之間');
}

console.log('\n小計：通過 ' + pass + '、失敗 ' + fail);
process.exit(fail ? 1 : 0);
