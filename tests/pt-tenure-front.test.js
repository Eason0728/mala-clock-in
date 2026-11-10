/**
 * 薪酬挑錯第 14 項：薪資頁的 ptTenurePlus（計時年資加給，只用在時薪組成的說明文字）
 * 到期日改成月底不溢位，跟後端 payTenurePlus（2026-11-04 已改 payAddMonthsClamp_）同一個算法（Eason 2026-11-11 確認）。
 *  規則：任職滿 N 個月（預設 6）那天「之後的次月」起加給（預設 +10）；該月 1 號晚於滿期日才算。
 *        滿期日那個月沒有到職的那一日（8/31 到職 → 2 月沒有 31 日）就用該月最後一天（民法 §121）。
 *  修前：前端用 new Date(年, 月+N, 日) 會溢位到下個月 1～3 號，月底到職的人比後端晚一個月才標年資加給。
 *  全部虛構同仁（只有到職日），期望值照規則手算寫死；另外逐月跟後端 payTenurePlus 比對。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const a = html.indexOf('function ptTenurePlus(m){'), b = html.indexOf('\nfunction renderRun(', a);
eq(a > 0 && b > a, true, '找得到 payroll.html 的 ptTenurePlus');
const ctx = { CFG: {}, YM: '2026-01' };
vm.createContext(ctx);
vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x};const ym=()=>YM;\n' + html.slice(a, b) + '\nthis.ptTenurePlus=ptTenurePlus;', ctx);
const front = (hire, ym, cfg) => { ctx.CFG = cfg || {}; ctx.YM = ym; return ctx.ptTenurePlus({ hire_date: hire }); };
const s = load({ data: {} });
const back = (hire, ym, cfg) => s.call('payTenurePlus', { hire_date: hire }, ym, cfg || {});

/* 手算（門檻 6 個月、加給 10）：[到職日, 滿期日, 還沒有加給的最後一個月, 開始有加給的第一個月] */
const CASES = [
  ['2025-08-29', '2026-02-28（2 月沒有 29 日）', '2026-02', '2026-03'],
  ['2025-08-30', '2026-02-28（2 月沒有 30 日）', '2026-02', '2026-03'],
  ['2025-08-31', '2026-02-28（2 月沒有 31 日）', '2026-02', '2026-03'],
  ['2025-03-31', '2025-09-30（9 月沒有 31 日）', '2025-09', '2025-10'],
  ['2025-05-31', '2025-11-30（11 月沒有 31 日）', '2025-11', '2025-12'],
  ['2025-04-15', '2025-10-15', '2025-10', '2025-11'],
  ['2025-05-01', '2025-11-01（11/1 當天不晚於滿期日）', '2025-11', '2025-12'],
  ['2027-08-31', '2028-02-29（閏年）', '2028-02', '2028-03'],
];
CASES.forEach(([hire, due, last0, first10]) => {
  eq([front(hire, last0), front(hire, first10)], [0, 10], `前端 ${hire} 到職：滿期 ${due} → ${last0} 沒有、${first10} 起 +10`);
  eq([back(hire, last0), back(hire, first10)], [0, 10], `後端 ${hire} 到職：滿期 ${due} → ${last0} 沒有、${first10} 起 +10`);
});

/* 逐月比對：每個到職日，從到職當月起連續 14 個月，前端與後端每個月都要一樣 */
const addYm = (ym, k) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + k; return (y + Math.floor(m / 12)) + '-' + ('0' + (m % 12 + 1)).slice(-2); };
CASES.forEach(([hire]) => {
  const f = [], bk = [];
  for (let k = 0; k < 14; k++) { const ym = addYm(hire.slice(0, 7), k); f.push(front(hire, ym)); bk.push(back(hire, ym)); }
  eq(f, bk, `逐月 14 個月 ${hire} 到職：前端＝後端`);
});

/* 門市自訂門檻與金額：3 個月、+15。11/30 到職 → 滿期 2/28（2026 年 2 月沒有 30 日）→ 2026-02 沒有、2026-03 起 +15 */
const C3 = { pt_tenure_months: 3, pt_tenure_plus: 15 };
eq([front('2025-11-30', '2026-02', C3), front('2025-11-30', '2026-03', C3)], [0, 15], '前端 門檻 3 個月、+15：11/30 到職 → 2026-02 沒有、2026-03 起 +15');
eq([back('2025-11-30', '2026-02', C3), back('2025-11-30', '2026-03', C3)], [0, 15], '後端 門檻 3 個月、+15：11/30 到職 → 2026-02 沒有、2026-03 起 +15');
/* 原有的防護不變：門檻 0 視為 6；金額 0＝不給；到職日空白＝0 */
eq(front('2025-08-31', '2026-03', { pt_tenure_months: 0 }), 10, '前端 門檻 0 視為 6 個月：8/31 到職，2026-03 有 +10');
eq(front('2025-08-31', '2026-03', { pt_tenure_plus: 0 }), 0, '前端 金額 0＝不給');
eq(front('', '2026-03'), 0, '前端 到職日空白＝0');

console.log(`\n${fail ? '❌ 有失敗' : '✅ 全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
