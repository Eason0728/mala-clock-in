/* T15 防漂移測試（2026-09-27 審查加）：直接從 payroll.html 抽出 costTotals()／costStable()／
 * allocGapHours()（前端「人事成本分類」正本），與後端 apps-script/Payroll.gs 的
 * pnlEstimateClassify_()（同一份規則正本的後端 port）用同一組輸入跑一次，逐鍵比對。
 *
 * 目的：pnlEstimateClassify_ 是 costTotals()/costStable() 的「逐字 port」，兩邊各自維護
 * 一份原始碼——只要有一邊改了口徑（例如新增一個 item_key 分類、改變公式），另一邊沒跟著改，
 * 這支測試就會紅。不像 tools/pnl-labor-estimate-august-compare.js 那樣「模擬定案路徑」
 * （那支比較的是同一支後端函式跑兩次），這支比的是**前端原始碼 vs 後端原始碼**，是真正的
 * 防漂移防線。
 *
 * 全程使用虛構姓名（同仁甲／同仁乙／同仁丙）與虛構金額。
 * 用法：node tests/pnl-labor-estimate-anti-drift.test.js
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const __ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__ROOT, 'payroll.html'), 'utf8');

let pass = 0, fail = 0;
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? '✓ ' : '✗ ') + name + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want)));
}

// ---------- 共用假資料（同仁甲＝正職含請假／同仁乙＝正職含餐費手動覆蓋／同仁丙＝計時含支援） ----------
const MASTER = [
  { emp_id: 'FT01', name: '同仁甲', is_full_time: 'true', store: 'SSLGF', active: 'true',
    base: 32000, wage: 0, ot_rate: 210, skill_allow: 500, night_allow: 0, mgr_allow: 2000, editor_allow: 0,
    attend_cap: 1200, labor_ins: 750, health_ins: 420, group_ins: 100, pension: 0, dormitory: 3000,
    hire_date: '2025-01-01', leave_date: '', meal_allow: 80, gap_rate: 180,
    co_labor: 900, co_health: 520, co_pension: 320, yearend_months: '' },
  { emp_id: 'FT02', name: '同仁乙', is_full_time: 'true', store: 'SSLGF', active: 'true',
    base: 29000, wage: 0, ot_rate: 195, skill_allow: 0, night_allow: 300, mgr_allow: 0, editor_allow: 300,
    attend_cap: 1000, labor_ins: 700, health_ins: 400, group_ins: 0, pension: 0, dormitory: 0,
    hire_date: '2026-01-15', leave_date: '', meal_allow: 80, gap_rate: 0,
    co_labor: 800, co_health: 480, co_pension: 300, yearend_months: '' },
  // 2026-09-27 第二輪審查加：同仁丙補上 labor_ins／dormitory，讓 ins_pt_deduct／
  // dorm_pt_deduct（計時的自付額／宿舍代扣）也非零——原本兩個鍵一直是 0，測不到
  // costTotals() 裡「計時自付額/宿舍」那兩段有沒有漂移。
  { emp_id: 'PT01', name: '同仁丙', is_full_time: 'false', store: 'SSLGF', active: 'true',
    base: 0, wage: 210, ot_rate: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
    attend_cap: 0, labor_ins: 50, health_ins: 0, group_ins: 0, pension: 0, dormitory: 500,
    hire_date: '2026-03-01', leave_date: '', meal_allow: 0, gap_rate: 0,
    co_labor: 0, co_health: 0, co_pension: 0, yearend_months: '' },
];
const CFG = { daily_hours: 8, late_deduct: false, meal_min_hours: 6, co_owner: 1500, co_group: 600, yearend_months: 1 };
const YM = '2026-08', RED_DAYS = 4;

function n(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }

// ATT：emp_id -> payCalcOne 要的 att 輸入（不透過 payCollect，直接手刻，跟前端「工時分頁」
// 帶進 costTotals() 的資料形狀一致：RESULTS 之外還要有 ATT[emp_id].support）。
const ATT = {
  // 2026-09-27 第二輪審查加：bonuses 補 sales／project 兩類，讓 bonus_sales／bonus_proj
  // 也非零（原本只有 perf 一類）。
  FT01: { hours: 190, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0,
    annual_h: 8, deduct_days: 0, support: [], full_attend: false, work_days: 20, wage_override: 0,
    dorm_override: '', meal_on: true, holiday_h: 0, custom_add_label: '', custom_add_amt: 0,
    custom_ded_label: '', custom_ded_amt: 0,
    bonuses: [{ bonus_type: 'perf', label: '績效獎金', amount: 1500 },
              { bonus_type: 'sales', label: '業績獎金', amount: 800 },
              { bonus_type: 'project', label: '專案獎金', amount: 600 }],
    leaves: { annual: 8 }, leave_usage: {}, annual: null, forget_punch: 0, forget_day: 0, late_min: 0, early_min: 0, attend_void: false },
  // 2026-09-27 第二輪審查加：hours 從 176 拉到 230（超過基本工時 216H＝(31-4)×8），
  // 讓 ot_ft（正職加班）也非零——原本 FT01／FT02 兩人都是工時不足（倒扣），沒有一個人
  // 真的觸發加班那個分支。editor_allow（小編津貼）也補上非零值，讓 other（其他津貼，
  // costTotals() 裡沒對到專屬科目、落進 else 分支的項目）非零。
  FT02: { hours: 230, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0,
    annual_h: 0, deduct_days: 0, support: [], full_attend: false, work_days: 22, wage_override: 0,
    dorm_override: '', meal_on: true, holiday_h: 0, custom_add_label: '', custom_add_amt: 0,
    custom_ded_label: '', custom_ded_amt: 0, bonuses: [], leaves: {}, leave_usage: {}, annual: null,
    forget_punch: 0, forget_day: 0, late_min: 0, early_min: 0, attend_void: false },
  PT01: { hours: 190, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0,
    annual_h: 0, deduct_days: 0, support: [{ store: 'MZTJS', hours: 8, rate: 190, amount: '' }],
    full_attend: true, work_days: 0, wage_override: 220, dorm_override: '', meal_on: false, holiday_h: 0,
    custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0, bonuses: [],
    leaves: {}, leave_usage: {}, annual: null, forget_punch: 0, forget_day: 0, late_min: 0, early_min: 0, attend_void: false },
};

// ---------- 後端：真的 payCalcOne（Payroll.gs 正本）＋ pnlEstimateClassify_（Payroll.gs 正本）----------
const sbBack = { console, Logger: { log() {} },
  Utilities: { formatDate: () => { throw new Error('本測試不需要用到 Utilities.formatDate'); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  SpreadsheetApp: { openById: () => { throw new Error('本測試不應打開任何試算表'); } } };
vm.createContext(sbBack);
vm.runInContext(C + '\n' + P, sbBack);
const backPayCalcOne = vm.runInContext('payCalcOne', sbBack);
const backClassify = vm.runInContext('pnlEstimateClassify_', sbBack);
const backLeaveTypes = vm.runInContext('payLeaveTypes', sbBack);

const LTYPES = backLeaveTypes('SSLGF');
const backResults = MASTER.map((e) => backPayCalcOne(e, YM, ATT[e.emp_id], CFG, RED_DAYS, LTYPES));
const backSnap = backClassify(backResults, MASTER, ATT, CFG);

// ---------- 前端：從 payroll.html 逐字抽出 costTotals/costStable/allocGapHours ----------
const START = 'const COST_REDUCE_EXTRA=';
const END = 'function renderCost(){';
const ai = HTML.indexOf(START), bi = HTML.indexOf(END);
if (ai === -1 || bi === -1) throw new Error('抽不到 payroll.html 的 costTotals/costStable 區塊——payroll.html 的結構可能變了，先確認 START/END 標記還在');
const frontSlice = HTML.slice(ai, bi);

const sbFront = { console };
vm.createContext(sbFront);
vm.runInContext(`
  const n=${n.toString()};
  const r2=v=>Math.round(v*100)/100;
  ${frontSlice}
`, sbFront);

// costTotals()/costStable() 讀的是全域 RESULTS/MASTER/ATT/CFG，不是參數——比照 payroll.html
// 前端執行時的做法，跑之前先把這次的假資料掛上去。RESULTS 的形狀要跟 payCalcOne 輸出一致
// （emp_id/name/is_full_time/ratio/earn/ded/base_hours/total_hours），直接重用後端算出來的
// backResults，確保前後端吃的是「同一份 payCalcOne 輸出」，只比對「分類/彙總」這段邏輯本身。
vm.runInContext(`
  RESULTS = ${JSON.stringify(backResults)};
  MASTER = ${JSON.stringify(MASTER)};
  ATT = ${JSON.stringify(ATT)};
  CFG = ${JSON.stringify(CFG)};
`, sbFront);
const frontSnap = vm.runInContext('costStable(costTotals())', sbFront);

// ---------- 逐鍵比對 ----------
console.log('══ 前端 costStable(costTotals()) vs 後端 pnlEstimateClassify_ ══');
const allKeys = new Set([...Object.keys(frontSnap), ...Object.keys(backSnap)]);
allKeys.forEach((k) => {
  if (k === 'support') { chk('  ' + k, backSnap[k], frontSnap[k]); return; }
  chk('  ' + k, backSnap[k], frontSnap[k]);
});

// 順便驗證兩邊都不是「剛好全部是 0」才比對成功（不然分類邏輯整段沒跑到也會逐鍵相同）
chk('  total 兩邊都 > 0（不是兩邊都沒跑到任何資料）', frontSnap.total > 0 && backSnap.total > 0, true);
chk('  base_ft 小於兩位正職整月底薪加總（同仁甲工時不足有被扣，證明真的跑到 reduceFT 那段）',
  backSnap.base_ft < 32000 + 29000, true);

// 2026-09-27 第二輪審查加：原本 ot_ft/other/ins_pt_deduct/dorm_pt_deduct/bonus_sales/
// bonus_proj 這六個鍵剛好都是 0，逐鍵比對「0===0」測不出兩邊的公式是否真的一致（分支
// 根本沒跑到）。上面的假資料已經刻意讓這六個鍵都非零，這裡逐一斷言，確保比對有真的覆蓋到。
['ot_ft', 'other', 'ins_pt_deduct', 'dorm_pt_deduct', 'bonus_sales', 'bonus_proj'].forEach((k) => {
  chk('  ' + k + ' 兩邊都非零（不是巧合的 0===0）', backSnap[k] !== 0 && frontSnap[k] !== 0, true);
});

console.log(`\n${fail ? '❌ 有失敗（前端/後端「人事成本分類」口徑已經漂移，兩邊都要看 mala-payroll skill「人事成本分類」那節一起改）' : '✅ 前端/後端人事成本分類口徑完全一致'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
