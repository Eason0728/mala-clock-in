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
/* 2026-09-03 起時薪拆成三列（基本／滿勤加給／年資加給），同仁的薪資單才看得到組成。
   有效時薪＝三列 rate 相加；沒有加給的那一列不會出現。 */
const PT_WAGE_KEYS = ['hourly_wage', 'pt_attend_plus', 'pt_tenure_plus'];
const runOf = (emp, cfg, fa, ym) =>
  calc(emp, ym || '2026-08', att(fa), Object.assign({}, BASE_CFG, cfg || {}), 8, null);
const rateSum = r => PT_WAGE_KEYS.reduce((a, k) => {
  const x = r.earn.find(i => i.item_key === k); return a + (x ? Number(x.rate) || 0 : 0); }, 0);
/** 回傳實際生效時薪（三列相加） */
const rateOf = (emp, cfg, fa, ym) => {
  const r = runOf(emp, cfg, fa, ym);
  return r.earn.some(i => i.item_key === 'hourly_wage') ? rateSum(r) : null;
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

console.log('\n══ 4b) ⚠ 門檻 0／空值要當「沒設定」用預設 6（2026-08-24 實際事故）══');
/* 光復的 pt_tenure_months 被存成 0（設定頁欄位清空時 n('')===0），
   門檻 0 ＝「到職當天就算年資已滿」→ 全體計時同仁被誤加 10 元。
   金額欄的 0 是合法值（不給加給），但**門檻的 0 沒有合理語意**，必須擋。 */
chk('  門檻 0 → 用預設 6：新人 2026-03-01 在 2026-05 不給',
    rateOf(pt('2026-03-01'), { pt_tenure_months: 0 }, false, '2026-05'), 200);
chk('  門檻 0 → 老鳥照樣給（不是全部關掉）',
    rateOf(pt('2024-01-01'), { pt_tenure_months: 0 }, false, '2026-05'), 210);
chk('  門檻空字串 → 用預設 6',
    rateOf(pt('2026-03-01'), { pt_tenure_months: '' }, false, '2026-05'), 200);
chk('  門檻負數 → 用預設 6',
    rateOf(pt('2026-03-01'), { pt_tenure_months: -3 }, false, '2026-05'), 200);
chk('  門檻 0 但到職滿 6 個月 → 2026-10 給',
    rateOf(pt('2026-03-01'), { pt_tenure_months: 0 }, false, '2026-10'), 210);
chk('  ⚠ 金額欄的 0 仍是合法值（不可被這條防護誤傷）',
    rateOf(pt('2024-01-01'), { pt_tenure_plus: 0 }, false, '2026-05'), 200);

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

console.log('\n══ 7) 前端「時薪組成」不可用差額反推（2026-08-24 修的真實 bug）══');
{
  /* 事故：A 君 2026-03-01 到職，2026-05 的薪資計算頁把她標成「年資10」——
     她那時到職才兩個月。原因是顯示邏輯「看到差 10 又沒勾全勤就推斷是年資加給」，
     而 run 是計算當下的快照，之後有人改了工時分頁沒重算，差額就對不上真實組成。
     正解：滿勤看勾選、年資照規則算，兩者加總對得上才標明細，對不上只說「含加給」。*/
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  chk('  不再有「差額反推年資」的寫法', /diff-\(fa\?10:0\)>=10/.test(HTML), false);
  chk('  年資改用規則函式判斷', /ptTenurePlus\(m\)/.test(HTML), true);
  chk('  滿勤改用參數而非寫死 10', /ptAttendPlus\(\)/.test(HTML), true);
  chk('  組成對不上時退回「加給」不亂猜', /\+加給\$\{nf\(diff\)\}/.test(HTML), true);
  chk('  年資函式用「該月1號 > 到職+N月」與後端同規則', /h\.getMonth\(\)\+months/.test(HTML), true);
  /* 2026-09-03 拆列後踩過的迴歸：管理頁的「實際生效時薪」若只讀 hourly_wage 那一格，
     拿到的是基本時薪，等於把 08-24「勾了加給卻只看到基本時薪」那個修正打回原形。 */
  chk('  有效時薪＝三列 rate 相加（不可只讀 hourly_wage）',
      /wRate\('hourly_wage'\)\+wRate\('pt_attend_plus'\)\+wRate\('pt_tenure_plus'\)/.test(HTML), true);
  chk('  組成優先讀拆出來的加給列、舊月份才退回規則重算',
      /wRate\('pt_attend_plus'\)\|\|/.test(HTML) && /wRate\('pt_tenure_plus'\)\|\|/.test(HTML), true);
}

/* ═════ 時薪拆三列（2026-09-03 Eason：同仁薪資單要看得到組成）═════
   守三件事：①基本列的 rate 是**基本時薪**不是有效時薪 ②沒有的加給不出現那一列
   ③三列金額相加 ＝ 拆列前的「時數 × 有效時薪」，一元都不能差（run 的 gross 不可因為拆列而動）*/
console.log('\n══ 6) 薪資單的時薪組成拆列 ══');
{
  const line = (r, k) => r.earn.find(i => i.item_key === k) || null;
  const amt = (r, k) => { const x = line(r, k); return x ? x.amount : 0; };

  // 老鳥（早就滿年資）＋勾全勤且符合條件 → 200 基本 ＋10 滿勤 ＋10 年資
  const rBoth = runOf(pt('2024-01-01'), {}, true);
  chk('  基本列 rate＝基本時薪 200（不是有效時薪）', line(rBoth, 'hourly_wage').rate, 200);
  chk('  滿勤加給獨立一列 rate 10', line(rBoth, 'pt_attend_plus').rate, 10);
  chk('  年資加給獨立一列 rate 10', line(rBoth, 'pt_tenure_plus').rate, 10);
  chk('  三列 qty 都是同一份時數 100H',
      PT_WAGE_KEYS.map(k => line(rBoth, k).qty), [100, 100, 100]);
  chk('  三列金額相加＝100H×220', amt(rBoth,'hourly_wage')+amt(rBoth,'pt_attend_plus')+amt(rBoth,'pt_tenure_plus'), 22000);

  // 新人沒年資、沒勾全勤 → 只有基本那一列
  const rNone = runOf(pt('2026-08-01'), {}, false, '2026-08');
  chk('  沒有加給時不出現滿勤列', line(rNone, 'pt_attend_plus'), null);
  chk('  沒有加給時不出現年資列', line(rNone, 'pt_tenure_plus'), null);
  chk('  只有基本列、金額＝100H×200', amt(rNone, 'hourly_wage'), 20000);

  /* 四捨五入守恆：時數帶小數、加給是奇數金額時，各列分別 payR0 會差一元。
     基本列＝總額扣掉加給列，所以無論如何相加都要等於「時數 × 有效時薪」。 */
  const oddAtt = Object.assign(att(true), { hours: 100.5 });
  const rOdd = calc(pt('2024-01-01'), '2026-08', oddAtt,
                    Object.assign({}, BASE_CFG, { pt_attend_plus: 7, pt_tenure_plus: 3 }), 8, null);
  const sumOdd = PT_WAGE_KEYS.reduce((a2, k) => a2 + amt(rOdd, k), 0);
  chk('  小數時數＋奇數加給：三列相加＝Math.round(100.5×210)', sumOdd, Math.round(100.5 * 210));
  chk('  gross 也等於同一個數', rOdd.gross, Math.round(100.5 * 210));
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 計時加給參數化全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
