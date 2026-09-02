/* 手動工時的月份，打卡算出來的遲到／忘刷不可以被歸零（2026-09-03 修）
 *
 * 事故：payInputsBase 對有手動列的同仁是「整筆取代」，而 payroll_input 的 schema
 * 沒有 late_min／early_min／forget_punch／forget_day／attend_void 這幾欄
 * → 全部讀成 0/false。handlePayrollCalc 的 collected 就是 payInputsBase，
 * 所以只要那個月按過一次「儲存工時」，**遲到不計薪與門檻歸零就整個失效**。
 * 實例：光復 2026-08 打卡有遲到（3／3／8 分），薪資明細 late_deduct 卻是 0 筆。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want)));
};

// 打卡側：E01 兩天遲到（5分＋3分），另一天只有上班卡沒有下班卡（忘刷）
const CLOCK = {
  roster: [{ emp_id: 'E01', name: '甲君', active: true }],
  leave: [],
  approved: [
    { date: '2026-08-05', emp_id: 'E01', name: '甲君', approved_hours: 8, status_text: '遲到5分', periods: '10:00-19:00' },
    { date: '2026-08-06', emp_id: 'E01', name: '甲君', approved_hours: 8, status_text: '遲到3分、早退2分', periods: '10:00-19:00' },
  ],
  events: [{ emp_id: 'E01', ts: '2026-08-07T10:00:00+08:00', type: 'in', status: 'ok', within_range: true }],
};

function ctx(inputRows) {
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__C = CLOCK;
  sb.__DB = { input: inputRows || [], config: [], holiday: [{ ym: '2026-08', store: 'SSLGF', red_days: 4 }], leave_type: [] };
  vm.runInContext(`
    payClockRead = function(store, sheet){ return (globalThis.__C[sheet] || []).slice(); };
    payRead      = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(){}; payInvalidate = function(){};
  `, sb);
  return sb;
}
const base = (sb) => vm.runInContext('payInputsBase', sb)('2026-08', 'SSLGF').E01;

console.log('══ 對照組：沒有手動列（純歸集）══');
const auto = base(ctx([]));
chk('遲到 5+3 分', auto.late_min, 8);
chk('早退 2 分', auto.early_min, 2);
chk('忘刷 1 次', auto.forget_punch, 1);
chk('時數 16H', auto.hours, 16);

console.log('\n══ 有手動列：時數手動優先、遲到／忘刷仍照打卡 ══');
const MANUAL = [{ ym: '2026-08', emp_id: 'E01', store: 'SSLGF', hours: 100, deduct_days: 3, support: '[]' }];
const man = base(ctx(MANUAL));
chk('時數用手動的 100H', man.hours, 100);
chk('缺勤天數用手動的 3', man.deduct_days, 3);
chk('遲到仍是 8 分（修好前是 0）', man.late_min, 8);
chk('早退仍是 2 分', man.early_min, 2);
chk('忘刷仍是 1 次', man.forget_punch, 1);
chk('attend_void 仍是布林', typeof man.attend_void, 'boolean');

console.log('\n══ 端對端：手動月份也要扣到遲到（計時，有效時薪 200）══');
const sb = ctx(MANUAL);
sb.__DB.master = [{ emp_id: 'E01', name: '甲君', store: 'SSLGF', active: 'true', is_full_time: '', wage: 200, hire_date: '2026-07-01' }];
sb.__DB.run = []; sb.__DB.item = []; sb.__DB.bonus = [];
vm.runInContext('checkAdmin = function(){ return true; };', sb);
const r2 = vm.runInContext('handlePayrollCalc', sb)({ admin_key: 'x', ym: '2026-08', store: 'SSLGF', inputs: {} });
if (!r2.ok) console.log('  handlePayrollCalc 回傳:', JSON.stringify(r2));
const res = (r2.results || [])[0] || {};
const late = (res.ded || []).filter((d) => d.item_key === 'late_deduct')[0];
chk('有 late_deduct 這一筆', !!late, true);
chk('分鐘數 8', late && late.qty, 8);
chk('金額＝200÷60×8', late && late.amount, Math.round(200 / 60 * 8));

console.log('\n' + (fail ? '✗ ' : '✓ ') + `通過 ${pass}／失敗 ${fail}`);
process.exit(fail ? 1 : 0);
