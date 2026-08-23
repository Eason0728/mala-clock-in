/* 計時時薪加給改為門市可覆寫參數（2026-08-24）：
 *   有效時薪 ＝ 基本時薪 ＋ 滿勤加給(pt_attend_plus，勾選才給) ＋ 年資加給(pt_tenure_plus，滿 pt_tenure_months 的次月起)
 * 重點：①未設定時沿用舊行為（各 +10、門檻 6 個月）②**0 是合法值**（該店不給），不可被當成「沒設定」
 *      ③各店可不同 ④年資門檻可調 ⑤正職完全不受影響 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const a = P.indexOf('function payR0'), b = P.indexOf('/* ═══════════════════ Handlers');
const sb = { console };
vm.createContext(sb);
vm.runInContext("function pad2(n){return ('0'+n).slice(-2)}\n" + P.slice(a, b), sb);
const calc = vm.runInContext('payCalcOne', sb);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

const BASE_CFG = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
// 計時同仁：基本時薪 200、到職 2024-01-01（早就滿半年）
const pt = (hire) => ({ emp_id: 'P1', name: '計時甲', is_full_time: 'false', wage: 200, base: 0,
  skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 0, ot_rate: 0, labor_ins: 0, health_ins: 0,
  group_ins: 0, pension: 0, dormitory: 0, hire_date: hire, leave_date: '', meal_allow: 0, active: 'true' });
const att = (fa) => ({ hours: 100, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null,
  leave_usage: {}, work_days: 0, full_attend: fa });
/** 回傳實際生效時薪（hourly_wage 那列的單價） */
const rateOf = (emp, cfg, fa, ym) => {
  const r = calc(emp, ym || '2026-08', att(fa), Object.assign({}, BASE_CFG, cfg || {}), 8, null);
  const l = r.earn.find(i => i.item_key === 'hourly_wage');
  return l ? l.rate : null;
};

console.log('══ 1) 未設定參數＝沿用改版前行為（各 +10、門檻 6 個月）══');
chk('  老鳥沒勾全勤：200+年資10', rateOf(pt('2024-01-01'), {}, false), 210);
chk('  老鳥勾全勤：200+滿勤10+年資10', rateOf(pt('2024-01-01'), {}, true), 220);
chk('  新人沒勾：200（年資未滿）', rateOf(pt('2026-08-01'), {}, false), 200);
chk('  新人勾全勤：200+滿勤10', rateOf(pt('2026-08-01'), {}, true), 210);

console.log('\n══ 2) 0 是合法值——該店不給加給（不可被當成「沒設定」而 fallback 到 10）══');
chk('  滿勤加給設 0：勾了也不加', rateOf(pt('2024-01-01'), { pt_attend_plus: 0 }, true), 210);
chk('  年資加給設 0：老鳥也不加', rateOf(pt('2024-01-01'), { pt_tenure_plus: 0 }, false), 200);
chk('  兩個都設 0：就是基本時薪', rateOf(pt('2024-01-01'), { pt_attend_plus: 0, pt_tenure_plus: 0 }, true), 200);
chk('  字串 "0" 也要當 0（試算表讀回可能是字串）',
    rateOf(pt('2024-01-01'), { pt_attend_plus: '0', pt_tenure_plus: '0' }, true), 200);

console.log('\n══ 3) 各店可不同（金額自訂）══');
chk('  某店滿勤+15、年資+20', rateOf(pt('2024-01-01'), { pt_attend_plus: 15, pt_tenure_plus: 20 }, true), 235);
chk('  只給年資+5、不給滿勤', rateOf(pt('2024-01-01'), { pt_attend_plus: 0, pt_tenure_plus: 5 }, true), 205);

console.log('\n══ 4) 年資門檻可調（判定看「該月 1 號 > 到職+N 月」）══');
// 到職 2026-03-01：門檻 6 → 2026-09-01 屆滿 → 10 月起；門檻 3 → 2026-06-01 屆滿 → 7 月起
chk('  門檻6：2026-09 還不給', rateOf(pt('2026-03-01'), {}, false, '2026-09'), 200);
chk('  門檻6：2026-10 開始給', rateOf(pt('2026-03-01'), {}, false, '2026-10'), 210);
chk('  門檻3：2026-06 還不給', rateOf(pt('2026-03-01'), { pt_tenure_months: 3 }, false, '2026-06'), 200);
chk('  門檻3：2026-07 開始給', rateOf(pt('2026-03-01'), { pt_tenure_months: 3 }, false, '2026-07'), 210);
chk('  門檻12：2026-10 不給', rateOf(pt('2026-03-01'), { pt_tenure_months: 12 }, false, '2026-10'), 200);

console.log('\n══ 5) 到職日沒填＝不給年資加給（不可因此壞掉）══');
chk('  空到職日', rateOf(pt(''), {}, false), 200);
chk('  空到職日＋勾全勤', rateOf(pt(''), {}, true), 210);

console.log('\n══ 6) 正職完全不受影響 ══');
{
  const ft = { emp_id: 'F1', name: '正職甲', is_full_time: 'true', base: 30000, wage: 0, skill_allow: 0,
    night_allow: 0, mgr_allow: 0, attend_cap: 0, ot_rate: 240, labor_ins: 0, health_ins: 0, group_ins: 0,
    pension: 0, dormitory: 0, hire_date: '2024-01-01', leave_date: '', meal_allow: 0, active: 'true' };
  const r1 = calc(ft, '2026-08', att(true), BASE_CFG, 8, null);
  const r2 = calc(ft, '2026-08', att(true), Object.assign({}, BASE_CFG,
    { pt_attend_plus: 99, pt_tenure_plus: 99 }), 8, null);
  chk('  改計時加給參數不影響正職金額', [r1.gross, r1.net], [r2.gross, r2.net]);
  chk('  正職沒有時薪列', r1.earn.some(i => i.item_key === 'hourly_wage'), false);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 計時加給參數化全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
