/* 薪酬挑錯第 4 項＋第 10 項（Eason 2026-11-11 確認）：兩個「太早取整」的位置，2026-11 薪資起改成最後才四捨五入。
 *
 *   第 4 項　特休未休折算：金額＝時數 × 沒有取整的時薪，最後才四捨五入；薪資單 rate 欄照舊顯示取到小數 2 位的值。
 *   第 10 項　請假扣款：金額＝時數 × 整數扣款時薪 ×（1 − 給薪比例），最後才四捨五入；
 *            逾上限那一段同理用 over_ratio；rate 欄顯示沒有取整的單價（例 81.5）。
 *            全薪假不產生列、「該扣卻扣到 0 的照印」兩個行為保留。扣款時薪照現行含全勤上限。
 *   兩項都只從 2026-11 起；2026-10 以前逐欄不變。
 *
 * 期望值全部照規則手算寫死（算式寫在每一條旁邊），不從程式反推。同仁全部虛構，只用代號。 */
const fs = require('fs');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const GS = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');
const a = GS.indexOf('function payR0'), b = GS.indexOf('/* ═══════════════════ Handlers');
const E = {};
new Function('exports', "function pad2(n){return ('0'+n).slice(-2)}\n" + GS.slice(a, b) + '\nexports.payCalcOne=payCalcOne;')(E);

let pass = 0, fail = 0;
const chk = (n, g, w) => {
  const ok = g === w; ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 規則要 ' + JSON.stringify(w)));
};

const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100 };
/* 假別表自己給，不吃內建預設（期望值才不會跟著預設表漂） */
const LT = [
  { code: 'personal', name: '事假', pay_ratio: 0, cap_days: null, cap_basis: '', over_ratio: 0, tenure_months: null, under_ratio: 0 },
  { code: 'sick', name: '病假', pay_ratio: 0.5, cap_days: 30, cap_basis: 'year', over_ratio: 0, tenure_months: null, under_ratio: 0 },
  { code: 'official', name: '公假', pay_ratio: 1, cap_days: null, cap_basis: '', over_ratio: 0, tenure_months: null, under_ratio: 0 },
  { code: 'p80', name: '八成薪假', pay_ratio: 0.8, cap_days: null, cap_basis: '', over_ratio: 0, tenure_months: null, under_ratio: 0 },
];
/* T01：正職，底薪 30,000＋職能 3,000＋夜間 3,000＋全勤上限 3,000＝39,000
 *   請假扣款時薪＝39,000 ÷30 ÷8＝162.5 → 四捨五入 163（整數，含全勤上限）
 *   2026-11 月工資＝39,000＋伙食 2,000＝41,000；特休折算時薪＝41,000 ÷30 ÷8＝170.8333…（顯示 170.83） */
const T01 = { emp_id: 'T01', name: '測試甲', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000, mgr_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2021-01-01', leave_date: '', meal_allow: 0, active: 'true' };
/* T02：同 T01 但底薪 30,100 → 合計 39,100；10 月折算時薪＝39,100 ÷240＝162.9166… → 顯示／計算都用 162.92（舊算法） */
const T02 = Object.assign({}, T01, { emp_id: 'T02', name: '測試乙', base: 30100 });
/* T03：計時，底薪 0 → 請假扣款時薪 0 */
const T03 = { emp_id: 'T03', name: '測試丙', is_full_time: 'false', base: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0,
  attend_cap: 0, ot_rate: 0, wage: 200, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2025-01-01', leave_date: '', meal_allow: 0, active: 'true' };

function calc(emp, ym, extra) {
  const att = Object.assign({ hours: 160, extra_ot: 0, deduct_days: 0, support: [], annual: null }, extra || {});
  return E.payCalcOne(emp, ym, att, cfg, 8, LT);
}
const row = (r, list, key) => (r[list] || []).find(function (x) { return x.item_key === key; }) || null;
const annual = (ym, h) => ({ annual: { days: 14, quota_h: 112, used_h: 112 - h, left_h: h, payout_ym: ym } });

/* ───────── 第 4 項：特休未休折算 ───────── */
console.log('── 第 4 項　特休未休折算（2026-11 起：時薪不先取整）');
{ // 56H：41,000 ÷30 ÷8 ×56 ＝ 9,566.67 → 9,567（先取 170.83 再乘是 9,566.48 → 9,566）
  const x = row(calc(T01, '2026-11', annual('2026-11', 56)), 'earn', 'annual_payout');
  chk('2026-11 T01 折算 56H 金額', x && x.amount, 9567);
  chk('2026-11 T01 折算 56H rate 欄照舊 2 位', x && x.rate, 170.83);
  chk('2026-11 T01 折算 56H qty', x && x.qty, 56);
}
{ // 104H：41,000 ÷30 ÷8 ×104 ＝ 17,766.67 → 17,767（先取整是 17,766.32 → 17,766）
  const x = row(calc(T01, '2026-11', annual('2026-11', 104)), 'earn', 'annual_payout');
  chk('2026-11 T01 折算 104H 金額', x && x.amount, 17767);
}
{ // 40H：41,000 ÷30 ÷8 ×40 ＝ 6,833.33 → 6,833（兩種算法相同，對照組）
  const x = row(calc(T01, '2026-11', annual('2026-11', 40)), 'earn', 'annual_payout');
  chk('2026-11 T01 折算 40H 金額（對照）', x && x.amount, 6833);
}
{ // 2026-12 也是新算法：同 56H → 9,567
  const x = row(calc(T01, '2026-12', annual('2026-12', 56)), 'earn', 'annual_payout');
  chk('2026-12 T01 折算 56H 金額', x && x.amount, 9567);
}
console.log('── 第 4 項　2026-10 以前不變（舊算法：162.92 × 時數）');
{ // 10 月：39,100 ÷240 ＝162.9166… → 162.92；162.92 ×56 ＝ 9,123.52 → 9,124（維持現行，不改成 9,123）
  const x = row(calc(T02, '2026-10', annual('2026-10', 56)), 'earn', 'annual_payout');
  chk('2026-10 T02 折算 56H 金額維持 9,124', x && x.amount, 9124);
  chk('2026-10 T02 折算 56H rate 欄 162.92', x && x.rate, 162.92);
}
{ // 9 月：同上
  const x = row(calc(T02, '2026-09', annual('2026-09', 56)), 'earn', 'annual_payout');
  chk('2026-09 T02 折算 56H 金額維持 9,124', x && x.amount, 9124);
}

/* ───────── 第 10 項：請假扣款 ───────── */
console.log('── 第 10 項　請假扣款（2026-11 起：最後才四捨五入）');
{ // 病假 8H：8 ×163 ×(1−0.5) ＝ 652；單價 163 ×0.5 ＝ 81.5（先取整是 8 ×82 ＝ 656）
  const r = calc(T01, '2026-11', { sick_h: 8 }); const x = row(r, 'ded', 'sick_leave');
  chk('2026-11 病假 8H 金額', x && x.amount, 652);
  chk('2026-11 病假 8H rate 欄', x && x.rate, 81.5);
  chk('2026-11 病假 8H qty', x && x.qty, 8);
  chk('2026-11 病假 8H 名稱', x && x.item_label, '病假');
  chk('2026-11 leave_rate 仍是整數 163', r.leave_rate, 163);
}
{ // 病假 7.5H：7.5 ×163 ×0.5 ＝ 611.25 → 611（先取整是 615）
  const x = row(calc(T01, '2026-11', { sick_h: 7.5 }), 'ded', 'sick_leave');
  chk('2026-11 病假 7.5H 金額', x && x.amount, 611);
}
{ // 病假 5.25H：5.25 ×163 ×0.5 ＝ 427.875 → 428（先取整是 430.5 → 431）
  const x = row(calc(T01, '2026-11', { sick_h: 5.25 }), 'ded', 'sick_leave');
  chk('2026-11 病假 5.25H 金額', x && x.amount, 428);
}
{ // 事假 8H（無薪）：8 ×163 ×(1−0) ＝ 1,304；單價 163（兩種算法相同，對照組；扣款時薪含全勤上限）
  const x = row(calc(T01, '2026-11', { personal_h: 8 }), 'ded', 'personal_leave');
  chk('2026-11 事假 8H 金額（對照）', x && x.amount, 1304);
  chk('2026-11 事假 8H rate 欄', x && x.rate, 163);
  chk('2026-11 事假 8H 名稱', x && x.item_label, '事假(無薪)');
}
{ // 病假 16H、本月之前已用 29 日（上限 30 日）：上限內 8H ×163 ×0.5 ＝ 652；逾上限 8H ×163 ×(1−0) ＝ 1,304；合計 1,956
  //   （先取整是 8 ×82 ＋ 8 ×163 ＝ 1,960）；含逾上限的列 rate 欄維持空白
  const x = row(calc(T01, '2026-11', { sick_h: 16, leave_usage: { sick: { used_before_days: 29 } } }), 'ded', 'sick_leave');
  chk('2026-11 病假 16H 含逾上限 金額', x && x.amount, 1956);
  chk('2026-11 病假 16H 含逾上限 rate 欄', x && x.rate, null);
  chk('2026-11 病假 16H 含逾上限 名稱', x && x.item_label, '病假（含逾上限 1 日）');
}
{ // 八成薪假 7H：7 ×163 ×(1−0.8) ＝ 228.2 → 228；單價 163 ×0.2 ＝ 32.6（先取整是 7 ×33 ＝ 231）
  const x = row(calc(T01, '2026-11', { leaves: { p80: 7 } }), 'ded', 'p80_leave');
  chk('2026-11 八成薪假 7H 金額', x && x.amount, 228);
  chk('2026-11 八成薪假 7H rate 欄', x && x.rate, 32.6);
}
{ // 八成薪假 2.5H：2.5 ×163 ×0.2 ＝ 81.5 → 四捨五入 82（剛好 .5 要進位，不能被浮點誤差吃成 81）
  const x = row(calc(T01, '2026-11', { leaves: { p80: 2.5 } }), 'ded', 'p80_leave');
  chk('2026-11 八成薪假 2.5H 金額（.5 進位）', x && x.amount, 82);
}
{ // 全薪假（公假 8H）：不產生扣款列
  const r = calc(T01, '2026-11', { leaves: { official: 8 } });
  chk('2026-11 公假 8H 不產生列', row(r, 'ded', 'official_leave'), null);
}
{ // 計時、底薪 0：扣款時薪 0 → 事假 8H 金額 0，但這一列照印
  const x = row(calc(T03, '2026-11', { hours: 80, personal_h: 8 }), 'ded', 'personal_leave');
  chk('2026-11 計時事假 8H 這一列照印', !!x, true);
  chk('2026-11 計時事假 8H 金額 0', x && x.amount, 0);
  chk('2026-11 計時事假 8H rate 欄 0', x && x.rate, 0);
  chk('2026-11 計時事假 8H qty', x && x.qty, 8);
}
console.log('── 第 10 項　2026-10 以前不變（舊算法：半價時薪先取整 82）');
{ // 10 月病假 8H：8 ×82 ＝ 656、單價 82
  const x = row(calc(T01, '2026-10', { sick_h: 8 }), 'ded', 'sick_leave');
  chk('2026-10 病假 8H 金額維持 656', x && x.amount, 656);
  chk('2026-10 病假 8H rate 欄維持 82', x && x.rate, 82);
}
{ // 10 月病假 7.5H：7.5 ×82 ＝ 615
  const x = row(calc(T01, '2026-10', { sick_h: 7.5 }), 'ded', 'sick_leave');
  chk('2026-10 病假 7.5H 金額維持 615', x && x.amount, 615);
}
{ // 10 月病假 16H、已用 29 日：8 ×82 ＋ 8 ×163 ＝ 1,960
  const x = row(calc(T01, '2026-10', { sick_h: 16, leave_usage: { sick: { used_before_days: 29 } } }), 'ded', 'sick_leave');
  chk('2026-10 病假 16H 含逾上限 金額維持 1,960', x && x.amount, 1960);
}
{ // 10 月八成薪假 7H：7 ×33 ＝ 231、單價 33
  const x = row(calc(T01, '2026-10', { leaves: { p80: 7 } }), 'ded', 'p80_leave');
  chk('2026-10 八成薪假 7H 金額維持 231', x && x.amount, 231);
  chk('2026-10 八成薪假 7H rate 欄維持 33', x && x.rate, 33);
}
{ // 9 月病假 8H：656
  const x = row(calc(T01, '2026-09', { sick_h: 8 }), 'ded', 'sick_leave');
  chk('2026-09 病假 8H 金額維持 656', x && x.amount, 656);
}

console.log('\n' + (fail ? '❌ 有失敗' : '✅ 全部通過') + ' (' + pass + '/' + (pass + fail) + ')');
process.exit(fail ? 1 : 0);
