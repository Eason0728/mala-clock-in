/* 手動工時沒有欄位的假別（家庭照顧假、住院傷病假…）在有手動列的月份照 leave 列算（Eason 2026-11-18 選 A）
 *  手動工時（payroll_input）只有五個假別欄：personal_h、sick_h、menstrual_h、annual_h、disaster_h（Payroll.gs schema input、PAY_INPUT_LEAVE_FIELDS）。
 *  上一版（0b80fb1）同月以手動為準時把那個月 leave 列整批略過，家庭照顧假等沒有欄位的就變成 0；改成只略過有欄位的假別。
 *  計薪 payLeaveUsedBefore 與同仁額度 payLeaveFlatRows 同一套；起算月（PAY_LEAVE_DEDUP_FROM）之前照舊。假名、虛構資料。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const NEW = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const git = (h) => { try { return cp.execFileSync('git', ['-C', ROOT, 'show', h + ':apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };
const PREV = git('0b80fb1'), PROD = git('02296c0');   // 上一版分支（整批略過）、改版前（＝正式機的算法，兩邊都加）
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + n + '：' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };
function ctx(P, DB, CL) {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
  sb.__C = CL; sb.__DB = DB;
  vm.runInContext(`payClockRead = function(st, sh){ var b = globalThis.__C[payStore(st)] || {}; return JSON.parse(JSON.stringify(b[sh] || [])); };
    payRead = function(k){ return JSON.parse(JSON.stringify(globalThis.__DB[k] || [])); }; payEmpStoresMap = function(){ return {}; };`, sb);
  return sb;
}
const call = (sb, fn, ...a) => JSON.parse(JSON.stringify(vm.runInContext(fn, sb)(...a)));
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100 };
const L = (d, n, t, h) => ({ '日期': d, '姓名': n, '假別': t, '時數': h });
const IN = (ym, emp, st, o) => Object.assign({ ym, emp_id: emp, store: st, hours: 160, personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0 }, o);
const EMP = (id, name, st, o) => Object.assign({ emp_id: id, name, store: st, is_full_time: 'true', base: 30000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 3000, ot_rate: 200,
  wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2019-01-01', leave_date: '', meal_allow: 0, active: 'true' }, o);
const usedOf = (P, DB, CL, ym, emp, st) => { const sb = ctx(P, DB, CL); return call(sb, 'payLeaveUsedBefore', ym, st, call(sb, 'payLeaveTypes', ''), cfg, [emp])[emp.emp_id]; };
const quotaOf = (P, DB, CL, ym, emp, st) => { const sb = ctx(P, DB, CL); const T = call(sb, 'payLeaveTypes', ''); const nm = {}; nm[emp.name] = emp.emp_id;
  const flat = call(sb, 'payLeaveFlatRows', st, T, nm, null, ym).filter((x) => x.date < ym + '-01'); return call(sb, 'payLeaveUsage', emp.emp_id, ym, T, cfg, null, flat, []); };

/* ── 驗收員的例子：9 月手動事假 8h、同月家庭照顧假 16h ── */
const A = EMP('E01', '張三', 'SSLGF');
const DB1 = { master: [A], input: [IN('2026-09', 'E01', 'SSLGF', { personal_h: 8 })] };
const CL1 = { SSLGF: { leave: [L('2026-09-04', '張三', '事假', 8), L('2026-09-10', '張三', '家庭照顧假', 8), L('2026-09-11', '張三', '家庭照顧假', 8), L('2026-09-20', '張三', '住院傷病假', 8)] } };
const u = usedOf(NEW, DB1, CL1, '2026-11', A, 'SSLGF');
chk('例：9 月手動事假 8h＋同月家庭照顧假 16h → 家照 2 天（上一版 0）、事假 1 天（以手動為準、不重複）、住院傷病假 1 天', [u.family.used_before_days, u.personal.used_before_days, u.sick_hosp.used_before_days], [2, 1, 1]);
if (PREV) { const p = usedOf(PREV, DB1, CL1, '2026-11', A, 'SSLGF'); chk('對照：上一版（0b80fb1）家照、住院傷病假被整批略過', [p.family.used_before_days, p.sick_hosp.used_before_days], [0, 0]); }
if (PROD) { const p = usedOf(PROD, DB1, CL1, '2026-11', A, 'SSLGF'); chk('對照：改版前（正式機）家照 2 天（沒去重所以有算到）、事假 2 天（重複）', [p.family.used_before_days, p.personal.used_before_days], [2, 2]); }
const q = quotaOf(NEW, DB1, CL1, '2026-11', A, 'SSLGF');
chk('同仁額度（payLeaveFlatRows）同一口徑：家照 2、事假 1、住院 1', [q.family.used_days, q.personal.used_days, q.sick_hosp.used_days], [2, 1, 1]);
/* ── 手動有欄位的假別仍以手動為準 ── */
{
  const DB = { master: [A], input: [IN('2026-09', 'E01', 'SSLGF', { sick_h: 24, menstrual_h: 4 })] };
  const CL = { SSLGF: { leave: [L('2026-09-02', '張三', '病假', 8), L('2026-09-05', '張三', '生理假', 4)] } };
  const x = usedOf(NEW, DB, CL, '2026-11', A, 'SSLGF'), y = quotaOf(NEW, DB, CL, '2026-11', A, 'SSLGF');
  chk('手動有欄位（病假 24h、生理假 4h）：以手動為準＝病假 3 天、生理假 1 次；額度表相同', [x.sick.used_before_days, x.menstrual.used_before_days, y.sick.used_days, y.menstrual.used_days], [3, 1, 3, 1]);
}
/* ── 沒有手動列的月份不變 ── */
{
  const DB = { master: [A], input: [] };
  const CL = { SSLGF: { leave: [L('2026-08-03', '張三', '家庭照顧假', 8), L('2026-08-04', '張三', '病假', 4)] } };
  chk('沒有手動列的月份：新版＝改版前', usedOf(NEW, DB, CL, '2026-11', A, 'SSLGF'), PROD ? usedOf(PROD, DB, CL, '2026-11', A, 'SSLGF') : usedOf(NEW, DB, CL, '2026-11', A, 'SSLGF'));
}
/* ── 跨年：去年手動月份的家照不算進今年 ── */
{
  const DB = { master: [A], input: [IN('2025-12', 'E01', 'SSLGF', { personal_h: 8 }), IN('2027-01', 'E01', 'SSLGF', { personal_h: 8 })] };
  const CL = { SSLGF: { leave: [L('2025-12-10', '張三', '家庭照顧假', 16), L('2027-01-10', '張三', '家庭照顧假', 8)] } };
  chk('跨年：2026-11 計算不含 2025-12；2027-02 計算只含 2027-01 的家照 1 天', [usedOf(NEW, DB, CL, '2026-11', A, 'SSLGF').family.used_before_days, usedOf(NEW, DB, CL, '2027-02', A, 'SSLGF').family.used_before_days], [0, 1]);
}
/* ── 起算月之前（2026-10 計算）＝上一版＝改版前 ── */
if (PROD) chk('2026-10 計算：跟改版前完全相同', usedOf(NEW, DB1, CL1, '2026-10', A, 'SSLGF'), usedOf(PROD, DB1, CL1, '2026-10', A, 'SSLGF'));

/* ── 連帶門檻：非小辛辣「家庭照顧假超過 7 天取消績效」（payFamilyOverVoid_） ── */
{
  const B = EMP('CF09', '李四', 'CF');
  const lv = [];
  ['2026-03-02', '2026-03-03', '2026-04-06', '2026-04-07'].forEach((d) => lv.push(L(d, '李四', '家庭照顧假', 8)));   // 沒有手動列的月份 4 天
  lv.push(L('2026-09-10', '李四', '家庭照顧假', 8), L('2026-09-11', '李四', '家庭照顧假', 8));                       // 9 月 2 天，9 月按過儲存工時
  const DB = { master: [B], input: [IN('2026-09', 'CF09', 'CF', { personal_h: 0 })] }, CL = { CF: { leave: lv } };
  const bonus = (P) => {
    const sb = ctx(P, DB, CL), T = call(sb, 'payLeaveTypes', '');
    const before = call(sb, 'payLeaveUsedBefore', '2026-11', 'CF', T, cfg, [B]).CF09;
    const att = { hours: 168, extra_ot: 0, support: [], bonuses: [], annual: null, personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0,
      deduct_days: 0, full_attend: true, work_days: 21, leaves: { family: 16 }, leave_usage: before };
    const r = vm.runInContext('payCalcOne', sb)(B, '2026-11', att, cfg, 8, T);
    const it = (r.earn || []).find((i) => i.item_key === 'attend_bonus');
    return [before.family.used_before_days, it ? it.amount : null, it ? it.item_label : ''];
  };
  const now = bonus(NEW);
  chk('門檻例（央廚，非小辛辣）：今年家照 4 天＋9 月 2 天（9 月有手動列），11 月再請 2 天＝8 天 > 7 → 績效取消', now, [6, 0, '績效獎金（家庭照顧假超過 7 天）']);
  if (PREV) chk('對照：上一版只算到 4 天 → 4＋2＝6 天，績效照發 3000（少算）', bonus(PREV), [4, 3000, '績效獎金']);
  if (PROD) chk('對照：改版前（正式機）也算 6 天 → 績效取消（這條在正式機的結果沒有變）', bonus(PROD).slice(0, 2), [6, 0]);
}
console.log(`\n${fail ? '❌ 有失敗' : '✅ 沒有手動欄位的假別照 leave 算'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
