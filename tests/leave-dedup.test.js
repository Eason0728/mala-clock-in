/* 「本月之前已請幾天假」同月以手動為準（2026-11-18 Eason「假別重複要修」；診斷 scratchpad menstrual/diag-leave-used-before.md）
 *  修正前：payLeaveUsedBefore 把「儲存工時」存下的手動列跟 leave 分頁兩邊都加，按過儲存工時的月份病假、事假、生理假都算兩次；
 *         手動列只比工號、不比門市。
 *  修正後（PAY_LEAVE_DEDUP_FROM＝2026-11 起的計算月份）：只取本店手動列；本店某月有手動列（「僅 support」列除外）＝那個月本店 leave 列不算。
 *  另守：生理假一列超過 8 小時在薪資端每天只算 1 次（逐日加班關掉時也一樣，2026-11-18 驗收缺口 b）。
 *  名字一律假名，資料全部虛構。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + n + '：' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

/** before：'old'＝把起算月推到 9999（＝修正前的算法） */
function ctx(DB, CLOCK, mode) {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
  vm.runInContext("PAY_OT_DAILY_FROM = '2099-01'; PAY_RULES3_FROM = '2099-01';", sb);   // 跟這件無關、要班表的新算法先關（menstrual_times 也要照給：缺口 b）
  if (mode === 'old') vm.runInContext("PAY_LEAVE_DEDUP_FROM = '9999-12';", sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ var b = globalThis.__C[store] || globalThis.__C.SSLGF; return JSON.parse(JSON.stringify((b || {})[sheet] || [])); };
    payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return '2027-01-15'; };
    payEmpStoresMap = function(){ return globalThis.__EMPST || {}; };
  `, sb);
  return sb;
}
const call = (sb, fn, ...a) => JSON.parse(JSON.stringify(vm.runInContext(fn, sb)(...a)));
const EMP = (id, name, o) => Object.assign({ emp_id: id, name, store: 'SSLGF', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000,
  mgr_allow: 0, editor_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2019-01-01', leave_date: '', meal_allow: 0, active: 'true' }, o);
const L = (d, n, t, h) => ({ '日期': d, '姓名': n, '假別': t, '時數': h });
const IN = (ym, emp, o) => Object.assign({ ym, emp_id: emp, store: 'SSLGF', hours: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0 }, o);
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100 };
const T = (sb) => call(sb, 'payLeaveTypes', '');
const ub = (sb, ym, master) => call(sb, 'payLeaveUsedBefore', ym, 'SSLGF', T(sb), cfg, master);
function calcItem(sb, emp, ym, att, key) {
  const a = Object.assign({ hours: 160, extra_ot: 0, support: [], bonuses: [], annual: null, personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0,
    deduct_days: 0, full_attend: true, work_days: 20 }, att);
  const r = vm.runInContext('payCalcOne', sb)(emp, ym, a, cfg, 4, T(sb));
  const it = (r.ded || []).find((i) => i.item_key === key);
  return it ? it.amount : 0;
}

/* ── 診斷例一、例二（重現腳本那組） ── */
const A = EMP('E01', '張三'), B = EMP('E02', '李四');
const leave1 = [L('2026-07-02', '張三', '生理假', 8), L('2026-09-03', '張三', '生理假', 4), L('2026-09-10', '張三', '病假', 8), L('2026-09-11', '張三', '病假', 8)];
for (let m = 1; m <= 6; m++) for (let d = 1; d <= 4; d++) leave1.push(L(`2026-0${m}-0${d}`, '李四', '病假', 8));
for (let d = 1; d <= 4; d++) leave1.push(L(`2026-09-1${d}`, '李四', '病假', 8));
const db1 = () => ({ master: [A, B], input: [IN('2026-09', 'E01', { menstrual_h: 4, sick_h: 16 }), IN('2026-09', 'E02', { sick_h: 32 })] });
const cl1 = { SSLGF: { leave: leave1 } };
const sNew = ctx(db1(), cl1), sOld = ctx(db1(), cl1, 'old');
const uN = ub(sNew, '2026-11', [A, B]), uO = ub(sOld, '2026-11', [A, B]);
chk('T1 張三 11 月之前：生理假 2 次、病假 2 天（修正前 3／4）', [uN.E01.menstrual.used_before_days, uN.E01.sick.used_before_days, uO.E01.menstrual.used_before_days, uO.E01.sick.used_before_days], [2, 2, 3, 4]);
const mens = (sb, u) => calcItem(sb, A, '2026-11', { menstrual_h: 8, leaves: { menstrual: 8 }, menstrual_times: [8], leave_usage: u.E01 }, 'menstrual_leave');
chk('T1 張三 11/5 生理假 8H：修正後扣 0（第 3 次）、修正前扣 652（第 4 次）', [mens(sNew, uN), mens(sOld, uO)], [0, 652]);
chk('T2 李四病假已用：修正後 28 天、修正前 32 天', [uN.E02.sick.used_before_days, uO.E02.sick.used_before_days], [28, 32]);
const sick = (sb, u) => calcItem(sb, B, '2026-11', { sick_h: 16, leaves: { sick: 16 }, leave_usage: u.E02 }, 'sick_leave');
chk('T2 李四 11 月病假 16H：修正後扣 1304、修正前 2608', [sick(sNew, uN), sick(sOld, uO)], [1304, 2608]);
const u10N = ub(sNew, '2026-10', [A, B]), u10O = ub(sOld, '2026-10', [A, B]);
chk('T3 起算月之前（2026-10 計算）跟修正前完全相同', u10N, u10O);
chk('T3 數字照舊重複（3／4／32）', [u10N.E01.menstrual.used_before_days, u10N.E01.sick.used_before_days, u10N.E02.sick.used_before_days], [3, 4, 32]);

/* ── T4 打卡上線前的手動月份（沒有 leave 列）：照算 ── */
{
  const db = { master: [A], input: [IN('2026-06', 'E01', { sick_h: 16, personal_h: 12 })] };
  const sN = ctx(db, { SSLGF: { leave: [] } }), sO = ctx(JSON.parse(JSON.stringify(db)), { SSLGF: { leave: [] } }, 'old');
  chk('T4 手動 6 月病假 16H、事假 12H（沒有 leave 列）：修正前後都是 2 天／1.5 天', [ub(sN, '2026-11', [A]).E01.sick.used_before_days, ub(sN, '2026-11', [A]).E01.personal.used_before_days, ub(sO, '2026-11', [A]).E01.sick.used_before_days], [2, 1.5, 2]);
}
/* ── T5 別家店同工號的手動列：修正後不算 ── */
{
  const db = { master: [A], input: [IN('2026-05', 'E01', { store: 'CF', sick_h: 24 }), IN('2026-05', 'E01', { store: '', sick_h: 8 })] };
  const sN = ctx(db, { SSLGF: { leave: [] } }), sO = ctx(JSON.parse(JSON.stringify(db)), { SSLGF: { leave: [] } }, 'old');
  chk('T5 央廚同工號的手動列 3 天：修正後不算（只剩本店 1 天；舊列門市空白＝光復）、修正前算進來（4 天）', [ub(sN, '2026-11', [A]).E01.sick.used_before_days, ub(sO, '2026-11', [A]).E01.sick.used_before_days], [1, 4]);
}
/* ── 「僅 support」手動列（hours_manual='0'）不蓋本店假別 ── */
{
  const db = { master: [A], input: [IN('2026-11', 'E01', { hours_manual: '0', support: '[{"store":"CF","hours":5}]' })] };
  const cl = { SSLGF: { leave: [L('2026-11-10', '張三', '病假', 8), L('2026-11-11', '張三', '病假', 8)] } };
  const sN = ctx(db, cl);
  chk('僅 support 列：11 月 leave 病假 2 天照算（12 月計算）', ub(sN, '2026-12', [A]).E01.sick.used_before_days, 2);
  const flat = call(sN, 'payLeaveFlatRows', 'SSLGF', T(sN), { '張三': 'E01' }).filter((x) => x.code === 'sick').length;
  chk('僅 support 列：同仁額度（payLeaveFlatRows）也不略過那個月的 leave 列', flat, 2);
}
/* ── T6 隨機資料：計薪的「本月之前」＝同仁額度表同一個口徑 ── */
{
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const names = ['甲', '乙', '丙', '丁'], master = names.map((n, i) => EMP('R0' + i, n));
  const leave = [], input = [];
  const TYPES = ['病假', '事假', '生理假', '家庭照顧假'];
  for (let m = 1; m <= 11; m++) names.forEach((n, i) => {
    const ym = '2026-' + ('0' + m).slice(-2);
    const k = Math.floor(rnd() * 4);
    for (let d = 1; d <= k; d++) leave.push(L(ym + '-' + ('0' + (d * 3)).slice(-2), n, TYPES[Math.floor(rnd() * 4)], [2, 4, 8, 6][Math.floor(rnd() * 4)]));
    const r = rnd();
    if (r < 0.25) input.push(IN(ym, 'R0' + i, { sick_h: Math.floor(rnd() * 3) * 8, personal_h: Math.floor(rnd() * 3) * 4, menstrual_h: Math.floor(rnd() * 2) * 4 }));
    else if (r < 0.32) input.push(IN(ym, 'R0' + i, { hours_manual: '0' }));
    else if (r < 0.38) input.push(IN(ym, 'R0' + i, { store: 'CF', sick_h: 16 }));
  });
  const sb = ctx({ master, input }, { SSLGF: { leave } });
  const nameMap = {}; master.forEach((e) => { nameMap[e.name] = e.emp_id; });
  const flat = call(sb, 'payLeaveFlatRows', 'SSLGF', T(sb), nameMap);
  let same = 0, diff = [];
  ['2026-11', '2026-12'].forEach((ym) => {
    const u = ub(sb, ym, master);
    master.forEach((e) => {
      const q = call(sb, 'payLeaveUsage', e.emp_id, ym, T(sb), cfg, null, flat.filter((x) => x.emp_id === e.emp_id && x.date < ym + '-01'), []);
      ['sick', 'personal', 'menstrual', 'family'].forEach((c) => {
        const a = u[e.emp_id][c].used_before_days, b = q[c].used_days;
        if (Math.abs(a - b) < 0.011) same++; else diff.push([ym, e.emp_id, c, a, b]);
      });
    });
  });
  chk('T6 隨機 4 人 11 個月（含手動列、僅 support 列、別店同工號列）：11、12 月四種假的「本月之前」＝額度表，' + same + ' 格', diff, []);
}

/* ── 驗收員算過的例子：月薪 32000（handlePayrollCalc 整條鏈） ── */
function runCalc(mode, emp, leave, input, ym) {
  const DB = { master: [emp], run: [], item: [], config: [], leave_type: [], holiday: [{ ym, store: 'SSLGF', red_days: 8 }], bonus: [], input };
  const approved = [], events = [];
  const nd = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  for (let d = 1; d <= nd; d++) { const date = ym + '-' + ('0' + d).slice(-2); if (d % 7 === 0 || d % 7 === 3) continue; approved.push({ date, emp_id: emp.emp_id, name: emp.name, approved_hours: 8, status_text: '正常', entered_at: date + 'T22:00:00+08:00', manager_name: '主管' }); }
  const sb = ctx(DB, { SSLGF: { roster: [{ emp_id: emp.emp_id, name: emp.name, active: true }], approved, events, leave, requests: [] } }, mode);
  const r = vm.runInContext('handlePayrollCalc', sb)({ admin_key: 'x', ym, store: 'SSLGF' });
  const res = (r.results || []).find((x) => x.emp_id === emp.emp_id) || {};
  const it = (res.ded || []).find((i) => i.item_key === 'menstrual_leave');
  return it ? it.amount : 0;
}
{
  const E = EMP('V01', '驗收甲', { base: 32000, skill_allow: 0, night_allow: 0, attend_cap: 0 });
  const lv = [L('2026-07-02', '驗收甲', '生理假', 8), L('2026-09-03', '驗收甲', '生理假', 4), L('2026-11-05', '驗收甲', '生理假', 8)];
  const inp = () => [IN('2026-09', 'V01', { hours: 160, menstrual_h: 4 })];
  chk('驗收例：月薪 32000，7/2 8h、9/3 4h（9 月按過儲存工時）、11/5 8h → 修正後扣 0（第 3 次）、修正前扣 532', [runCalc(undefined, E, lv, inp(), '2026-11'), runCalc('old', E, lv, inp(), '2026-11')], [0, 532]);
  const lv2 = [L('2026-07-02', '驗收甲', '生理假', 8), L('2026-09-03', '驗收甲', '生理假', 4), L('2026-12-03', '驗收甲', '生理假', 12)];
  chk('缺口 b：之前 2 次、12/3 一列 12h → 每天只算 1 次＝第 3 次，扣 0（原本 1.5 次扣 266）', runCalc(undefined, E, lv2, [], '2026-12'), 0);
}
console.log(`\n${fail ? '❌ 有失敗' : '✅ 假別同月去重全部正確'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
