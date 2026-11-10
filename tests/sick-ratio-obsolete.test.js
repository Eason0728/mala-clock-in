/**
 * 薪酬挑錯第 11 項：參數「病假占事假比例」（sick_ratio）下架（Eason 2026-11-11 確認）。
 *  現況：2026-08-23 起病假的給薪比例改讀假別表，整支 Payroll.gs 沒有任何地方再讀 sick_ratio；
 *        參數設定頁卻還有這一欄，改了沒有任何作用。
 *  規則：①後端預設參數表 PAY_CONFIG_DEFAULT 沒有 sick_ratio ②薪資頁參數卡的四張清單都沒有 sick_ratio
 *        ③前端 CFG_OBSOLETE 有 sick_ratio（存檔時不會送出這個鍵），原本的 shortfall_deduct 仍在
 *        ④引擎算病假不看這個參數：帶 0.5／1／0／不帶，扣款都一樣。
 *  全部虛構同仁（代號 E01），期望值照規則手算寫死。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp, baseAtt, item, cfg } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const gs = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const s = load({ data: {} });

/* ① 後端：除了預設參數表 PAY_CONFIG_DEFAULT 那一列，整支 Payroll.gs 的程式碼（扣掉註解）沒有任何地方讀它。
   ⚠ 規則①「預設參數表也拿掉這一列」這次沒有做、這裡也不驗：tests/support-auto-regression.test.js 拿 origin/main 的
     payroll_month 回應整份比對，拿掉那一列回應的 config／config_src 會少一個鍵、那支測試會紅。等 Eason 決定（見 commit 說明）。 */
const keys = JSON.parse(vm.runInContext('JSON.stringify(PAY_CONFIG_DEFAULT.map(function(d){return d[0]}))', s));
['daily_hours', 'leave_div_days', 'leave_div_hours', 'payday', 'meal_min_hours'].forEach(k =>
  eq(keys.indexOf(k) >= 0, true, `G1 ${k} 仍在預設參數表`));
const gsCode = gs.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
eq((gsCode.match(/sick_ratio/g) || []).length <= 1 && gsCode.split('\n').filter(l => /sick_ratio/.test(l)).every(l => /^\s*\['sick_ratio', 0\.5, '[^']*'\],\s*$/.test(l)), true,
  'G2 Payroll.gs 的程式碼（不含註解）除了預設參數表那一列，沒有任何地方出現 sick_ratio');

/* ②③ 前端參數卡 */
const a = html.indexOf('const CF=['), b = html.indexOf('\nfunction renderCfg(');
eq(a > 0 && b > a, true, 'H0 找得到參數卡清單宣告');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(a, b) + '\nthis.OUT={CF:CF,CF_ATTEND:CF_ATTEND,CF_ATTEND_SELECT:CF_ATTEND_SELECT,CF_ATTEND_TEXT:CF_ATTEND_TEXT,CF_PT:CF_PT,CFG_OBSOLETE:CFG_OBSOLETE};', ctx);
const O = JSON.parse(JSON.stringify(ctx.OUT));
eq(O.CF.map(x => x[0]), ['daily_hours', 'leave_div_days', 'leave_div_hours', 'payday', 'meal_min_hours', 'yearend_months'],
  'H1 基本參數卡的欄位：每日工時、事假分母（天／時）、發薪日、餐費門檻、年終月數（沒有病假占事假比例）');
['CF_ATTEND', 'CF_ATTEND_SELECT', 'CF_ATTEND_TEXT', 'CF_PT'].forEach(nm =>
  eq(O[nm].some(x => x[0] === 'sick_ratio'), false, `H2 ${nm} 沒有 sick_ratio`));
eq(O.CFG_OBSOLETE, ['shortfall_deduct', 'sick_ratio'], 'H3 CFG_OBSOLETE＝shortfall_deduct、sick_ratio');
eq(/病假占事假比例/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'H4 薪資頁（不含註解）沒有「病假占事假比例」這幾個字');

/* ④ 引擎不看這個參數。
   E01（虛構正職）：底薪 30000＋職能 3000＋夜間 3000＋全勤上限 3000 → 請假時薪 39000÷30÷8＝162.5 → 取整 163。
   2026-10（改版前算法）：病假半薪，半價時薪 163×0.5＝81.5 → 取整 82；8H × 82 ＝ 656。 */
const sick = (c) => item(s.call('payCalcOne', ftEmp(), '2026-10', baseAtt({ hours: 176, sick_h: 8, deduct_days: 1 }), c, 8), 'sick_leave');
const noKey = Object.assign({}, cfg); delete noKey.sick_ratio;
eq(sick(noKey), 656, 'E1 cfg 不帶 sick_ratio：病假 8H 扣 656');
[0.5, 1, 0].forEach(v => eq(sick(Object.assign({}, noKey, { sick_ratio: v })), 656, `E2 cfg 帶 sick_ratio＝${v}：病假 8H 一樣扣 656`));

console.log(`\n${fail ? '❌ 有失敗' : '✅ 全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
