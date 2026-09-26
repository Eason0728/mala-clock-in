#!/usr/bin/env node
/* T15：pnlLaborEstimate 與「定案數字」的 8 月比對腳本。
 *
 * ⚠ 為什麼不是拿正式的 2026-08 鎖定快照來比對：這次改動的鐵律是「不准打正式端點、不准碰任何
 * 試算表」，而正式的 payroll_cost_snapshot／payroll_master 都在真的試算表裡、含真實姓名與薪資，
 * 不能複製到這個 public repo 的 PR 裡（也不能連線去讀）。所以這支腳本改用「同一份虛構整月資料，
 * 分別跑兩條路徑」的方式做等價比對：
 *
 *   路徑 A（模擬『鎖定本月』當下會算出的定案數字）：直接用**完整月份、不截止**的 payInputsBase
 *          （不傳 cutoffDate）＋原始員工物件（不套虛擬離職日）呼叫 payCalcOne——這就是
 *          handlePayrollCalc（它自己也是呼叫 payInputsBase，不是直接呼叫 payCollect）／
 *          costTotals()／costStable() 背後的同一條路徑（T14 已證明 costStable() 與
 *          costTotals() 的算法完全一致，這裡不重複證那段，只借用同一套 payCalcOne
 *          呼叫方式代表「定案數字」）。
 *   路徑 B（pnlLaborEstimate 的估算）：呼叫 handlePnlLaborEstimate_({ym:'2026-08', ...})，
 *          today 設在 9 月（ym=上個月），此時 as_of＝2026-08-31（整月），
 *          daysElapsed＝daysInMonth——這是估算端點對「已經整月過完」的月份會自然收斂到的情況。
 *
 * 兩條路徑理論上必須**逐鍵完全相同**：路徑 B 的虛擬離職日在 asOf＝月底時，
 * payRatio 算出的比例與「整月在職、不折算」完全一樣（P=1，或員工本來的到職/離職折算值，
 * 不受虛擬值影響，因為虛擬值一定 >= 月底所以不會比原始值更早生效）；cutoffDate＝月底也等於
 * 沒有排除任何一天；兩條路徑都經過同一個 payInputsBase，疊上 payroll_input 手動覆蓋的規則
 * 也完全相同。這支腳本就是要實測「確實逐鍵相同」，做為「已上線後、8 月真的鎖定時，
 * 用 pnlLaborEstimate 重算應該跟 pnlPayroll 讀到的定案快照對得起來」這件事的替代驗證
 * （docs/pnl-labor-estimate.md 有記錄這個侷限與正式上線後 Eason 可以怎麼補做一次真的對比）。
 *
 * 2026-09-27 審查加：INPUT_ROWS 刻意準備了一組非零的 payroll_input 手動覆蓋（同仁丙的
 * 支援請款／全勤勾選／手動工時＋時薪覆蓋；同仁乙的餐費補助勾選），確保 A、B 兩條路徑都
 * 真的走過「疊上手動覆蓋」那段邏輯再比對（`meal`／`support` 兩個輸出鍵都非零），
 * 不是兩邊都剛好沒有手動覆蓋資料、比對就失去意義。
 *
 * 全程使用虛構姓名（同仁甲／同仁乙／同仁丙）與虛構金額。
 * 用法：node tools/pnl-labor-estimate-august-compare.js
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const __ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Payroll.gs'), 'utf8');

function pad(n) { return String(n).padStart(2, '0'); }

function makeSandbox() {
  const cache = {};
  const props = { PNL_KEY: 'test-pnl-key-虛構' };
  const sb = {
    console, Logger: { log() {} },
    Utilities: {
      formatDate: function (date, tz, fmt) {
        const d = new Date(date.getTime() + 8 * 3600 * 1000);
        const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
        const hh = pad(d.getUTCHours()), mi = pad(d.getUTCMinutes()), ss = pad(d.getUTCSeconds());
        if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${da}`;
        return `${y}-${mo}-${da}T${hh}:${mi}:${ss}+08:00`;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => { throw new Error('不應打開真的試算表'); }, getActive: () => null },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  return sb;
}

// ---------- 虛構整月（2026-08，31 天）資料：三位同仁，含加班／請假／獎金／跨店支援 ----------
const MASTER = [
  { emp_id: 'FT01', name: '同仁甲', is_full_time: 'true', store: 'SSLGF', active: 'true',
    base: 32000, wage: 0, ot_rate: 210, skill_allow: 500, night_allow: 0, mgr_allow: 2000, editor_allow: 0,
    attend_cap: 1200, labor_ins: 750, health_ins: 420, group_ins: 100, pension: 0, dormitory: 3000,
    hire_date: '2025-01-01', leave_date: '', meal_allow: 80, gap_rate: 180,
    co_labor: 900, co_health: 520, co_pension: 320, yearend_months: '' },
  { emp_id: 'FT02', name: '同仁乙', is_full_time: 'true', store: 'SSLGF', active: 'true',
    base: 29000, wage: 0, ot_rate: 195, skill_allow: 0, night_allow: 300, mgr_allow: 0, editor_allow: 0,
    attend_cap: 1000, labor_ins: 700, health_ins: 400, group_ins: 0, pension: 0, dormitory: 0,
    hire_date: '2026-08-10', leave_date: '', meal_allow: 80, gap_rate: 0,   // 8/10 月中到職，測折算
    co_labor: 800, co_health: 480, co_pension: 300, yearend_months: '' },
  { emp_id: 'PT01', name: '同仁丙', is_full_time: 'false', store: 'SSLGF', active: 'true',
    base: 0, wage: 210, ot_rate: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
    attend_cap: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
    hire_date: '2026-03-01', leave_date: '', meal_allow: 0, gap_rate: 0,
    co_labor: 0, co_health: 0, co_pension: 0, yearend_months: '' },
];
const CONFIG_ROWS = [
  { key: 'daily_hours', value: '8', store: '' },
  { key: 'late_deduct', value: 'false', store: '' },
  { key: 'meal_min_hours', value: '6', store: '' },
  { key: 'co_owner', value: '1500', store: '' },
  { key: 'co_group', value: '600', store: '' },
];
const HOLIDAY_ROWS = [{ ym: '2026-08', red_days: '4', note: '', dates: '', store: '' }];
const BONUS_ROWS = [{ ym: '2026-08', store: 'SSLGF', emp_id: 'FT01', bonus_type: 'perf', label: '績效獎金', amount: 1500, memo: '', updated_at: '2026-08-20T10:00:00+08:00' }];

function approvedRow(date, emp, hours) {
  return { date, emp_id: emp, approved_hours: hours, status_text: '', entered_at: date + 'T20:00:00+08:00' };
}
const APPROVED = [];
for (let d = 1; d <= 31; d++) {
  const day = '2026-08-' + pad(d);
  APPROVED.push(approvedRow(day, 'FT01', 8.5));   // 同仁甲整月每天 8.5H（含加班）
  if (d >= 10) APPROVED.push(approvedRow(day, 'FT02', 8));   // 同仁乙 8/10 到職起每天 8H
  APPROVED.push(approvedRow(day, 'PT01', 6));   // 同仁丙整月每天 6H
}
const LEAVE_ROWS = [{ '日期': '2026-08-15', '姓名': '同仁甲', '假別': '特休', '時數': 8 }];
const ROSTER = MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active }));

// payroll_input 手動覆蓋（2026-09-27 審查加）：涵蓋「支援／餐費／全勤／手動工時」四類，
// 確保 A、B 兩條路徑都會真的走到 payInputsBase 的合併邏輯（而不是兩邊都剛好沒有手動覆蓋、
// 比對變得沒有意義）。
const INPUT_ROWS = [
  // 同仁丙（PT01）：手動覆蓋整月工時（打卡本來是 31 天×6H=186H，改成 190H）＋時薪覆蓋 220＋
  // 開全勤勾選＋一筆跨店支援 8H×190（gap_rate=0，不分攤，直接 8×190=1520）。
  { ym: '2026-08', emp_id: 'PT01', store: 'SSLGF', hours: 190, extra_ot: 0, personal_h: 0, sick_h: 0,
    menstrual_h: 0, disaster_h: 0, annual_h: 0, deduct_days: 0,
    support: JSON.stringify([{ store: 'MZTJS', hours: 8, rate: 190, amount: '' }]),
    updated_at: '2026-08-25T10:00:00+08:00', full_attend: 1, work_days: 0, wage_override: 220,
    meal_on: 0, holiday_h: '', custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0,
    dorm_override: '' },
  // 同仁乙（FT02）：勾選餐費補助（meal_on）。手動工時故意填成與打卡歸集完全相同的值
  // （8/10 到職起每天 8H，22 天×8H=176H；她整月沒有請假，work_days 用同樣天數），
  // 這樣「手動工時整筆覆蓋」這件事本身不會順帶改變加班/請假的計算結果，方便單獨驗證
  // meal_on 這個非時數欄有沒有被疊上去。
  { ym: '2026-08', emp_id: 'FT02', store: 'SSLGF', hours: 176, extra_ot: 0, personal_h: 0, sick_h: 0,
    menstrual_h: 0, disaster_h: 0, annual_h: 0, deduct_days: 0, support: '',
    updated_at: '2026-08-25T10:00:00+08:00', full_attend: 0, work_days: 22, wage_override: 0,
    meal_on: 1, holiday_h: '', custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0,
    dorm_override: '' },
];

const ALL_PAY_SHEET_NAMES = ['payroll_master', 'payroll_config', 'payroll_holiday', 'payroll_run',
  'payroll_item', 'payroll_input', 'payroll_audit', 'payroll_store', 'payroll_bonus',
  'payroll_leave_type', 'payroll_leave_span', 'payroll_leave_event', 'payroll_cost_snapshot'];

function wireRead(sb) {
  vm.runInContext(`
    payRead = function(kind){
      var d = ${JSON.stringify({ master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: BONUS_ROWS, input: INPUT_ROWS })};
      return (d[kind] || []).slice();
    };
    payClockRead = function(store, sheetName){
      var key = store + ':' + sheetName;
      var d = ${JSON.stringify({ 'SSLGF:roster': ROSTER, 'SSLGF:approved': APPROVED, 'SSLGF:events': [], 'SSLGF:leave': LEAVE_ROWS })};
      return (d[key] || []).slice();
    };
    getSS = function(){
      var allNames = ${JSON.stringify(ALL_PAY_SHEET_NAMES)};
      return { getSheetByName: function(name){ return allNames.indexOf(name) >= 0 ? { __fake: true, name: name } : null; } };
    };
    payAppend = function(){};
    payReplaceAll = function(){ throw new Error('比對腳本不應寫入'); };
  `, sb);
}

// ---------- 路徑 A：模擬「鎖定當下」的定案數字（整月、不截止、原始員工物件） ----------
const sbA = makeSandbox();
wireRead(sbA);
vm.runInContext(`todayTaipeiStr = function(){ return '2026-08-31'; };`, sbA);
const resultA = vm.runInContext(`
  (function(){
    var st = 'SSLGF', ym = '2026-08';
    var holRow = payHolidayRow(ym, st), holDates = payHolidayDates(holRow), redDays = payNum(holRow.red_days);
    var cfg = payConfig(st);
    var master = payRead('master').filter(function(m){ return String(m.active).toLowerCase()==='true' && payStore(m.store)===st; });
    var att = payInputsBase(ym, st);   // 不傳 cutoffDate＝整月；跟 handlePayrollCalc 一樣疊上 payroll_input 手動覆蓋，模擬定案當下
    var bonusBy = {};
    payRead('bonus').forEach(function(b){ if(String(b.ym)!==ym || payStore(b.store)!==st) return;
      (bonusBy[b.emp_id]=bonusBy[b.emp_id]||[]).push({bonus_type:b.bonus_type,label:b.label,amount:payNum(b.amount)}); });
    var LTYPES = payLeaveTypes(st);
    var USAGE = payLeaveUsedBefore(ym, st, LTYPES, cfg, master);
    var ANNUAL = payAnnualInfo(ym, st);
    var results = master.map(function(e){
      var c = att[String(e.emp_id)] || {};
      var a = { hours:payNum(c.hours), extra_ot:payNum(c.extra_ot), personal_h:payNum(c.personal_h), sick_h:payNum(c.sick_h),
        menstrual_h:payNum(c.menstrual_h), disaster_h:payNum(c.disaster_h), annual_h:payNum(c.annual_h), deduct_days:payNum(c.deduct_days),
        support:c.support||[], full_attend:payBool(c.full_attend), work_days:payNum(c.work_days), wage_override:payNum(c.wage_override),
        dorm_override:'', meal_on:payBool(c.meal_on), holiday_h:payNum(c.holiday_h), custom_add_label:'', custom_add_amt:0,
        custom_ded_label:'', custom_ded_amt:0, bonuses:bonusBy[String(e.emp_id)]||[], leaves:c.leaves||{},
        leave_usage:USAGE[String(e.emp_id)]||{}, annual:ANNUAL[String(e.emp_id)]||null,
        forget_punch:payNum(c.forget_punch), forget_day:payNum(c.forget_day), late_min:payNum(c.late_min),
        early_min:payNum(c.early_min), attend_void:!!c.attend_void };
      return payCalcOne(e, ym, a, cfg, redDays, LTYPES);   // 原始 e，不套虛擬離職日
    });
    return JSON.stringify(pnlEstimateClassify_(results, master, att, cfg));
  })()
`, sbA);
const snapA = JSON.parse(resultA);

// ---------- 路徑 B：pnlLaborEstimate（ym=上個月＝2026-08，today 落在 9 月）----------
const sbB = makeSandbox();
wireRead(sbB);
vm.runInContext(`todayTaipeiStr = function(){ return '2026-09-05'; };`, sbB);
const respB = vm.runInContext('handlePnlLaborEstimate_', sbB)({ key: 'test-pnl-key-虛構', ym: '2026-08', store: 'SSLGF' });

// ---------- 逐鍵比對 ----------
console.log('路徑 A（模擬定案數字，整月不截止）：', JSON.stringify(snapA, null, 0));
console.log('路徑 B（pnlLaborEstimate，as_of=' + respB.as_of + '，days_elapsed=' + respB.days_elapsed + '/' + respB.days_in_month + '）：',
  JSON.stringify(respB.rows, null, 0));
console.log('B.support：', JSON.stringify(respB.support), '｜B.total：', respB.total);

let diffCount = 0;
const allKeys = new Set([...Object.keys(snapA), ...Object.keys(respB.rows || {})]);
allKeys.forEach((k) => {
  if (k === 'support' || k === 'total') return;
  const a = snapA[k], b = (respB.rows || {})[k];
  if (a === undefined && b === undefined) return;
  const ok = a === b;
  if (!ok) diffCount++;
  console.log((ok ? '✓' : '✗') + ' ' + k + '：A=' + a + '　B=' + b + (ok ? '' : '　← 不一致'));
});
const totalOk = snapA.total === respB.total;
console.log((totalOk ? '✓' : '✗') + ' total：A=' + snapA.total + '　B=' + respB.total);
if (!totalOk) diffCount++;
const supOk = JSON.stringify(snapA.support) === JSON.stringify(respB.support);
console.log((supOk ? '✓' : '✗') + ' support：A=' + JSON.stringify(snapA.support) + '　B=' + JSON.stringify(respB.support));
if (!supOk) diffCount++;

// 2026-09-27 審查加：不只逐鍵相同，還要真的驗證「有 saved input 的兩個科目確實非零」——
// 不然萬一 payInputsBase 沒接進去，A、B 兩邊剛好都是 0 也會「逐鍵相同」，卻沒測到重點。
if (!(snapA.meal > 0 && respB.rows.meal > 0)) { console.log('✗ meal 應該兩邊都 > 0（同仁乙的餐費補助勾選）才算真的測到 saved input'); diffCount++; }
else console.log('✓ meal 兩邊都 > 0（同仁乙的 meal_on 手動覆蓋有生效）：' + snapA.meal);
if (!(snapA.support.MZTJS > 0 && respB.support.MZTJS > 0)) { console.log('✗ support.MZTJS 應該兩邊都 > 0（同仁丙的跨店支援）才算真的測到 saved input'); diffCount++; }
else console.log('✓ support.MZTJS 兩邊都 > 0（同仁丙的支援/全勤/手動工時覆蓋有生效）：' + snapA.support.MZTJS);

console.log('\n' + (diffCount ? `❌ 有 ${diffCount} 個鍵不一致` : '✅ 整月情境下，pnlLaborEstimate 與定案路徑逐鍵完全相同，且 saved input（支援/餐費/全勤/手動工時）確實生效'));
process.exit(diffCount ? 1 : 0);
