/* 加班費新算法：逐日判斷（Eason 2026-11-06 定案，2026-11 薪資起）
 * 規格 ~/Desktop/Claude/系統/打卡/加班費新算法_規格草案_20261106.md；期望值全部手算（寫在每條旁邊）。
 * 第一段：引擎純函式（payR0～Handlers 切片）；第二段：整條鏈（Code.gs＋Payroll.gs＋SchedPub.gs 真函式，假資料）
 *   ‧班表怎麼對到人（本店／emp_prefix／在別家打卡由那家發布）
 *   ‧handlePayrollCalc 寫出的明細、提醒（ot_info）
 *   ‧班表查不到不能鎖定（sched_missing），補發布後可以鎖 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want)));
};

/* ════════ 一、引擎 ════════ */
const a = GS.indexOf('function payR0'), b = GS.indexOf('/* ═══════════════════ Handlers');
const E = {};
new Function('exports', 'function pad2(n){return ("0"+n).slice(-2)}\n' + GS.slice(a, b) +
  '\nexports.payCalcOne=payCalcOne;exports.payOtDayBreak=payOtDayBreak;exports.payOtDailySum=payOtDailySum;exports.payOtKindOf=payOtKindOf;exports.payIsOtKey=payIsOtKey;')(E);
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5,
  late_deduct: 'true', late_div_days: 30, late_div_hours: 8 };
// 月工資＝30000＋2000（職能）＋3000（績效上限）＋2000（伙食費）＝37,000；加班時薪 37000/240＝154.1667；一日工資 37000/30＝1233.33
const FT = { emp_id: 'A', name: '正職', is_full_time: true, base: 30000, skill_allow: 2000, night_allow: 0, mgr_allow: 0, editor_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2019-01-01', leave_date: '', meal_allow: 0, active: 'true' };
const PT = Object.assign({}, FT, { emp_id: 'B', name: '計時', is_full_time: false, base: 0, skill_allow: 0, attend_cap: 0, wage: 200, hire_date: '2026-10-01' });
const ATT = (o) => Object.assign({ hours: 0, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 0,
  early_min: 0, personal_h: 0, sick_h: 0, annual_h: 0, menstrual_h: 0, disaster_h: 0 }, o);
const DAYS = (n) => Array.from({ length: n }, (_, i) => '2026-11-' + ('0' + (i + 1)).slice(-2));
const W = { t: 'W', s: 'A' }, H = { t: 'H' }, Hs = { t: 'H', s: 'A' }, R = { t: 'R' };
const it = (r, k) => [].concat(r.earn, r.ded).find((i) => i.item_key === k);

console.log('══ 1) 一天怎麼拆 ══');
chk('上班日 10.5H → 前 2H 4/3、0.5H 5/3', E.payOtDayBreak('W', 10.5), { w43: 2, w53: 0.5, r43: 0, r53: 0, r83: 0, day: 0 });
chk('上班日剛好 8H → 沒有加班', E.payOtDayBreak('W', 8), { w43: 0, w53: 0, r43: 0, r53: 0, r83: 0, day: 0 });
chk('休息日 11H → 2／6／3', E.payOtDayBreak('H', 11), { w43: 0, w53: 0, r43: 2, r53: 6, r83: 3, day: 0 });
chk('休息日 1.5H → 全在前 2H', E.payOtDayBreak('H', 1.5), { w43: 0, w53: 0, r43: 1.5, r53: 0, r83: 0, day: 0 });
chk('例假 9H → 加發一日＋超過的 1H 照平日', E.payOtDayBreak('R', 9), { w43: 1, w53: 0, r43: 0, r53: 0, r83: 0, day: 1 });
chk('國定假日 4H → 加發一日', E.payOtDayBreak('HOL', 4), { w43: 0, w53: 0, r43: 0, r53: 0, r83: 0, day: 1 });
chk('例假沒上班 → 什麼都沒有', E.payOtDayBreak('R', 0).day, 0);
chk('班表「國」（請假格 l=國）＝國定假日', E.payOtKindOf({ t: 'L', l: '國' }, false), 'HOL');
chk('薪資節日清單優先於班表休息日', E.payOtKindOf(H, true), 'HOL');
chk('請假格（特休）照上班日判斷', E.payOtKindOf({ t: 'L', l: '特' }, false), 'W');
chk('加班類明細判斷：overtime／ot_*', ['overtime', 'ot_w43', 'ot_rest', 'pt_annual', 'hourly_wage'].map(E.payIsOtKey), [true, true, true, false, false]);

console.log('\n══ 2) 正職：逐日加總與金額 ══');
// 11/1 例假沒上班、11/2 上班 10H、11/3 上班 8H、11/4 休息日上班 9H、11/5 排班沒來、11/6 例假上班 4H、11/10 國定假日上班 8H、其他休息日
const sched = {}; DAYS(30).forEach((d) => { sched[d] = H; });
Object.assign(sched, { '2026-11-01': R, '2026-11-02': W, '2026-11-03': W, '2026-11-04': Hs, '2026-11-05': W, '2026-11-06': R, '2026-11-10': W });
delete sched['2026-11-29']; delete sched['2026-11-30'];   // 下一期還沒發布
const dayH = { '2026-11-02': 10, '2026-11-03': 8, '2026-11-04': 9, '2026-11-06': 4, '2026-11-10': 8 };
const daily = { dates: DAYS(30), sched, day_h: dayH, day_leave: {}, hol: { '2026-11-10': true }, until: '2026-11-20', manual_sup_h: 0 };
let r = E.payCalcOne(FT, '2026-11', ATT({ hours: 39, daily }), cfg, 9);
chk('平日 1.34：11/2 超過 2H → 2 × 206.58 ＝ 413', [it(r, 'ot_w43').qty, it(r, 'ot_w43').rate, it(r, 'ot_w43').amount], [2, 206.58, 413]);
chk('沒有平日 5/3', it(r, 'ot_w53'), undefined);
chk('休息日 9H：(2×1.34＋6×1.67＋1×2.67)×154.1667 → 2370', [it(r, 'ot_rest').qty, it(r, 'ot_rest').amount], [9, 2370]);
chk('休息日明細說明各段時數', it(r, 'ot_rest').memo, '前2H×1.34 2H、3–8H×1.67 6H、9H起×2.67 1H');
chk('例假出勤 1 天 × 1233.33 ＝ 1233', [it(r, 'ot_rdo').qty, it(r, 'ot_rdo').amount], [1, 1233]);
chk('國定假日出勤 8H × 154.17 ＝ 1233（6-3 改按上班時數）', [it(r, 'ot_hol').qty, it(r, 'ot_hol').amount], [8, 1233]);
chk('不再有整月「加班」與「不足時數」', [it(r, 'overtime'), it(r, 'shortfall_hours')], [undefined, undefined]);
chk('本月加班時數＝平日 2＋休息日 9＝11', [r.ot_paid_hours, r.ot_info.ot_h, r.ot_info.over_cap], [11, 11, false]);
chk('班表查不到：11/29、11/30', r.ot_info.missing, ['2026-11-29', '2026-11-30']);
chk('有排班沒核定也沒請假：11/5', r.ot_info.no_show, ['2026-11-05']);
chk('例假出勤日、國定假日出勤日', [r.ot_info.rdo, r.ot_info.hol], [['2026-11-06'], ['2026-11-10']]);
chk('實付＝底薪 30000＋職能 2000＋績效 3000＋411＋2364＋1233＋1233', r.gross, 30000 + 2000 + 3000 + 413 + 2370 + 1233 + 1233);
chk('2026-11 起「全勤獎金」改名「績效獎金」', it(r, 'attend_bonus').item_label, '績效獎金');

r = E.payCalcOne(FT, '2026-11', ATT({ hours: 20, daily: Object.assign({}, daily, { day_h: { '2026-11-02': 9 } }) }), cfg, 9);
chk('整月只上 20H 也不倒扣（Eason 2026-11-06）', [it(r, 'shortfall_hours'), r.deduction], [undefined, 0]);

r = E.payCalcOne(FT, '2026-11', ATT({ hours: 39, daily, leaves: { comp: 3 } }), cfg, 9);
chk('補休 3H：依日期先扣平日的 2H、再扣休息日前 2H 的 1H', [it(r, 'ot_w43'), it(r, 'ot_rest').qty, r.ot_info.comp_h], [undefined, 8, 3]);
chk('  休息日剩 (1×1.34＋6×1.67＋1×2.67)×154.1667 → 2163', it(r, 'ot_rest').amount, 2163);

const busy = {}; DAYS(28).forEach((d) => { busy[d] = 11; });   // 每天 11H、都是上班日 → 每天 3H 加班 × 28 天＝84H
const allW = {}; DAYS(30).forEach((d) => { allW[d] = W; });
r = E.payCalcOne(FT, '2026-11', ATT({ hours: 308, daily: { dates: DAYS(30), sched: allW, day_h: busy, day_leave: {}, hol: {}, until: '2026-11-30' } }), cfg, 9);
chk('每天 11H × 28 天：平日 4/3 56H、5/3 28H、超過 54H 標紅', [it(r, 'ot_w43').qty, it(r, 'ot_w53').qty, r.ot_info.ot_h, r.ot_info.over_cap], [56, 28, 84, true]);
chk('  1.67：28 × 257.46 → 7209', it(r, 'ot_w53').amount, 7209);
chk('  11/29、11/30 排班沒核定 → 提醒 2 天', r.ot_info.no_show, ['2026-11-29', '2026-11-30']);

r = E.payCalcOne(FT, '2026-11', ATT({ hours: 8, extra_ot: 1.5, daily: Object.assign({}, daily, { day_h: {} }) }), cfg, 9);
chk('舊的「逐日加班」手填欄照平日前 2H 給：1.5 × 206.58 → 310', it(r, 'ot_w43').amount, 310);

console.log('\n══ 3) 計時：只加加成 ══');
r = E.payCalcOne(PT, '2026-11', ATT({ hours: 23, daily: { dates: DAYS(30), sched, day_h: { '2026-11-02': 10, '2026-11-04': 3, '2026-11-06': 4, '2026-11-03': 6 }, day_leave: {}, hol: {}, until: '2026-11-03' } }), cfg, 9);
chk('時數本身照時薪：23 × 200', it(r, 'hourly_wage').amount, 4600);
chk('平日超過 2H：+0.34 × 2 → 136', [it(r, 'ot_w43').item_label, it(r, 'ot_w43').amount], ['平日加班加成（0.34）', 136]);
chk('休息日 3H：(2×0.34＋1×0.67)×200 → 270', it(r, 'ot_rest').amount, 270);
chk('例假 4H：加倍 4 × 200＝800', [it(r, 'ot_rdo_h').qty, it(r, 'ot_rdo_h').amount], [4, 800]);
chk('計時不加發「一日」', it(r, 'ot_rdo'), undefined);
r = E.payCalcOne(PT, '2026-11', ATT({ hours: 10, annual_h: 8, leaves: { annual: 8 }, daily: { dates: [], sched: {}, day_h: {}, day_leave: {}, hol: {} } }), cfg, 9);
chk('計時請特休 8H：照有效時薪給 1600（E2）', [it(r, 'pt_annual').qty, it(r, 'pt_annual').amount], [8, 1600]);

console.log('\n══ 4) 2026-11 一起改的四件事 ══');
r = E.payCalcOne(FT, '2026-11', ATT({ hours: 160, early_min: 10, late_min: 5, daily: { dates: [], sched: {}, day_h: {}, day_leave: {}, hol: {} } }), cfg, 9);
chk('早退比照遲到按分鐘扣：(30000＋2000＋全勤3000)/30/8/60 × 10＝24.31 → 24（B4；2026-10 起基數含全勤）', [it(r, 'early_deduct').qty, it(r, 'early_deduct').amount], [10, 24]);
chk('遲到照舊同費率：× 5 ＝ 12.15 → 12', it(r, 'late_deduct').amount, 12);
r = E.payCalcOne(FT, '2026-10', ATT({ hours: 160, early_min: 10 }), cfg, 10);
chk('2026-10 早退不扣、仍叫全勤獎金、有整月加班口徑', [it(r, 'early_deduct'), it(r, 'attend_bonus').item_label], [undefined, '全勤獎金']);
const annual = { payout_ym: '2026-11', left_h: 16 };
r = E.payCalcOne(FT, '2026-11', ATT({ hours: 160, annual, daily: { dates: [], sched: {}, day_h: {}, day_leave: {}, hol: {} } }), cfg, 9);
chk('特休未休折算改月工資÷30：37000/30/8＝154.17 × 16＝2466.72 → 2467（E3）', [it(r, 'annual_payout').rate, it(r, 'annual_payout').amount], [154.17, 2467]);
r = E.payCalcOne(FT, '2026-10', ATT({ hours: 160, annual: { payout_ym: '2026-10', left_h: 16 } }), cfg, 10);
chk('2026-10 照舊：(30000＋2000＋3000)/30/8＝145.83 × 16＝2333', it(r, 'annual_payout').amount, 2333);
r = E.payCalcOne(FT, '2026-11', ATT({ hours: 170 }), cfg, 9);
chk('2026-11 但沒有逐日資料的呼叫端（舊測試、單元工具）→ 照舊整月口徑', it(r, 'overtime').qty, 2);

/* ════════ 二、整條鏈 ════════ */
console.log('\n══ 5) 整條鏈：班表對人、計算、鎖定 ══');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const SP = fs.readFileSync(path.join(ROOT, 'apps-script', 'SchedPub.gs'), 'utf8');
const cells = (m) => DAYS(28).map((d) => m[d] || { t: 'H' });
const PUB = {
  '|T01': { start: '2026-11-01', shifts: [{ id: 'A', name: 'A班', start: '10:00', end: '19:00', break_min: 60 }],
    rows: [{ emp_id: 'E01', name: '甲君', cells: cells({ '2026-11-01': R, '2026-11-02': W, '2026-11-03': W, '2026-11-04': Hs, '2026-11-05': W, '2026-11-06': R }) }] },
  'cf|T01': { start: '2026-11-01', shifts: [], rows: [{ emp_id: 'HQ-01', name: '乙君', cells: cells({}) }, { emp_id: 'CF14', name: '丙君', cells: cells({}) }] },
};
const DB = {
  master: [{ emp_id: 'E01', name: '甲君', store: 'SSLGF', is_full_time: 'true', base: 30000, skill_allow: 2000, night_allow: 0, mgr_allow: 0, editor_allow: 0,
    attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2020-01-01', leave_date: '', meal_allow: 0, active: 'true' }],
  run: [], item: [], config: [], leave_type: [], bonus: [], input: [], xmap: [], audit: [],
  holiday: [{ ym: '2026-11', store: '', red_days: 9, dates: '' }],
  store: [{ code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', active: true, support_group: 'sxl' }, { code: 'CF', name: '央廚', clock_ss_id: 'X', emp_prefix: 'CF', active: true }],
};
const CLOCK = {
  roster: [{ emp_id: 'E01', name: '甲君', active: true }],
  approved: [['2026-11-02', 10, '10:00-21:00'], ['2026-11-03', 8, '10:00-19:00'], ['2026-11-04', 9, '10:00-20:00'], ['2026-11-06', 4, '10:00-14:00']]
    .map(([date, h, p]) => ({ date, emp_id: 'E01', name: '甲君', approved_hours: h, periods: p, status_text: '正常', entered_at: date + 'T22:00:00+08:00', manager_name: '主管' })),
  events: [], leave: [], requests: [],
};
const sb = { console, Logger: { log() {} },
  SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
  Utilities: { formatDate: () => '2026-11-20' },   // payYesterday_：之後的日子還沒到
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb);
vm.runInContext(C + '\n' + GS + '\n' + SP, sb);
sb.__C = CLOCK; sb.__DB = DB; sb.__PUB = PUB;
vm.runInContext(`
  payClockRead = function(store, sheet){ return JSON.parse(JSON.stringify(globalThis.__C[sheet] || [])); };
  payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
  payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
  payAppend = function(){}; payInvalidate = function(){}; pnlSnapshotRemove_ = function(){};
  checkAdmin = function(){ return true; };
  todayTaipeiStr = function(){ return '2026-11-21'; };
  schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(globalThis.__PUB)); };
`, sb);
const F = (n) => vm.runInContext(n, sb);

const sm = F('paySchedMonth_')('2026-11', 'HQ', [{ emp_id: 'HQ-01', name: '乙君' }, { emp_id: 'HQ-02', name: '別人' }]);
chk('總部薪資、央廚打卡的人：到別家找到「工號＋姓名」都對的列', Object.keys(sm['HQ-01']).length, 28);
chk('  工號對但姓名不對（撞號）→ 不採用', Object.keys(sm['HQ-02']).length, 0);
const sp = F('paySchedMonth_')('2026-11', 'CF', [{ emp_id: 'CFCF14', name: '丙君' }]);
chk('主檔工號＝emp_prefix＋打卡工號（CFCF14 → CF14）', Object.keys(sp['CFCF14']).length, 28);
chk('光復的店別是空字串（|T01）', F('paySchedCode_')('SSLGF') + '|' + F('paySchedCode_')('MZTJS'), '|mztjs');

let res = F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
const r1 = res.results[0], li = (k) => [].concat(r1.earn, r1.ded).find((i) => i.item_key === k);
chk('計算成功', res.ok, true);
chk('平日 1.34 2H＝413、休息日 9H＝2370、例假 1 天＝1233', [li('ot_w43').amount, li('ot_rest').amount, li('ot_rdo').amount], [413, 2370, 1233]);
chk('沒有不足倒扣（整月只上 31H）', li('shortfall_hours'), undefined);
chk('提醒：11/5 排班沒來、11/29–30 班表查不到', [r1.ot_info.no_show, r1.ot_info.missing], [['2026-11-05'], ['2026-11-29', '2026-11-30']]);
const runRow = DB.run.find((x) => x.emp_id === 'E01');
chk('run 存 ot_info（JSON），payroll_month 讀回來還原', F('payRunItemsToResult')(runRow, DB.item.filter((x) => x.emp_id === 'E01')).ot_info.ot_h, 11);
chk('run 的 ot_paid_hours＝本月加班時數 11', runRow.ot_paid_hours, 11);

let lk = F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
chk('班表查不到 → 不能鎖定（sched_missing）', [lk.ok, lk.error, lk.list[0].days], [false, 'sched_missing', 2]);
chk('  訊息講清楚是誰、哪幾天', lk.message.split('\n')[1], '甲君：2 天查不到（11-29～11-30）');
chk('  沒鎖上', DB.run[0].status, 'draft');
PUB['|T02'] = { start: '2026-11-29', shifts: [], rows: [{ emp_id: 'E01', name: '甲君', cells: Array(28).fill({ t: 'H' }) }] };
lk = F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
chk('下一期也發布了 → 可以鎖定', [lk.ok, DB.run[0].status], [true, 'final']);
F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: false, reason: '測試' });
DB.holiday.push({ ym: '2026-10', store: '', red_days: 10, dates: '' });
lk = F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-10', store: 'SSLGF' });
chk('2026-10 照舊：沒有 ot_info、鎖定不看班表', [lk.results[0].ot_info, F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-10', store: 'SSLGF', lock: true }).ok], [undefined, true]);

console.log('\n══ 5b) 唯讀並列試算 payroll_ot_preview ══');
{
  const runsBefore = JSON.stringify(DB.run), itemsBefore = JSON.stringify(DB.item);
  vm.runInContext("PAY_OT_DAILY_FROM = '2026-12'", sb);   // 第一次部署時的設定：11 月還不生效
  const pv = F('handlePayrollOtPreview')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  chk('回新舊兩份', [pv.ok, pv.old.length, pv.new.length], [true, 1, 1]);
  chk('舊算法：整月 31H 不足 160 → 有不足倒扣、沒有逐日明細', [pv.old[0].items.some((x) => x[0] === 'shortfall_hours'), pv.old[0].items.some((x) => /^ot_/.test(x[0]))], [true, false]);
  chk('新算法：逐日明細與 calc 相同（休息日 2370）', pv.new[0].items.find((x) => x[0] === 'ot_rest')[4], 2370);
  chk('完全沒有寫入 run／item', JSON.stringify(DB.run) === runsBefore && JSON.stringify(DB.item) === itemsBefore, true);
  chk('算完把開關關回去（生效月份與強制旗標都還原）', vm.runInContext('PAY_OT_DAILY_FROM + "|" + PAY_OT_FORCE_', sb), '2026-12|false');
  vm.runInContext("PAY_OT_DAILY_FROM = '2026-11'", sb);
}

console.log('\n══ 5c) 主檔工號對不到打卡名冊 → 提醒（2026-11-06）══');
{
  const miss = F('payRosterMismatch_');
  vm.runInContext("payHasClock = function(){ return true; }", sb);
  CLOCK.roster = [{ emp_id: 'E01', name: '甲君', active: true }, { emp_id: 'E11', name: '丁君', active: true }, { emp_id: 'CF14', name: '丙君', active: true }];
  const M = [{ emp_id: 'E01', name: '甲君', store: 'SSLGF', active: 'true' }, { emp_id: 'E10', name: '丁君', store: 'SSLGF', active: 'true' },
             { emp_id: 'E12', name: '新人', store: 'SSLGF', active: 'true' }, { emp_id: 'E13', name: '離職', store: 'SSLGF', active: 'false' }];
  chk('E10 對不到、名冊同名是 E11；E12 名冊沒有同名；停用的不列；對得上的不列', miss('SSLGF', M),
      [{ emp_id: 'E10', name: '丁君', roster_ids: ['E11'] }, { emp_id: 'E12', name: '新人', roster_ids: [] }]);
  chk('emp_prefix：主檔 CFCF14 對名冊 CF14 算對得上', miss('CF', [{ emp_id: 'CFCF14', name: '丙君', store: 'CF', active: 'true' }]), []);
  vm.runInContext("payHasClock = function(){ return false; }", sb);
  chk('沒有打卡的店不檢查', miss('SSLGF', M), []);
  vm.runInContext("payHasClock = function(){ return true; }", sb);
  const pm = F('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  chk('payroll_month 帶 roster_mismatch', (pm.roster_mismatch || []).map((x) => x.emp_id), []);
  DB.master.push({ emp_id: 'E10', name: '丁君', store: 'SSLGF', is_full_time: 'true', base: 30000, active: 'true', hire_date: '2026-10-12' });
  chk('  主檔多一位對不到的 → 列出來', F('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' }).roster_mismatch.map((x) => x.emp_id + '→' + x.roster_ids.join()), ['E10→E11']);
  DB.master.pop();
}

console.log('\n══ 墨竹亭開放補休（2026-11-14 Eason：2026-11 薪資起抵加班）══');
{
  const d2 = { dates: ['2026-11-02'], sched: { '2026-11-02': W }, day_h: { '2026-11-02': 10 }, day_leave: {}, hol: {}, until: '2026-11-30' };
  const MZT = Object.assign({}, FT, { store: 'MZTJS' }), SSL = Object.assign({}, FT, { store: 'SSLGF' });
  const rm = E.payCalcOne(MZT, '2026-11', ATT({ hours: 10, leaves: { comp: 2 }, daily: d2 }), cfg, 9);
  const rs = E.payCalcOne(SSL, '2026-11', ATT({ hours: 10, leaves: { comp: 2 }, daily: d2 }), cfg, 9);
  chk('墨竹亭 11 月：平日超過 2H、補休 2H → 抵掉，沒有加班、沒有抵不掉', [it(rm, 'ot_w43'), rm.ot_info.comp_h, rm.ot_info.comp_over_h], [undefined, 2, 0]);
  chk('  跟小辛辣同一套（加班、應發一樣）', [rm.gross, rm.ot_info.comp_h], [rs.gross, rs.ot_info.comp_h]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
  chk('  10 月以前墨竹亭照舊不抵（comp_off 帶月份條件）', /comp_off: \/\^MZT\/\.test\(String\(e\.store \|\| ''\)\) && String\(ym\) < PAY_MZT_COMP_FROM/.test(src) && /var PAY_MZT_COMP_FROM = '2026-11';/.test(src), true);
}

console.log('\n' + (fail ? '❌ ' + fail + ' 項失敗（' + pass + '/' + (pass + fail) + '）' : '✅ 加班逐日判斷全部通過（' + pass + ' 項）'));
process.exit(fail ? 1 : 0);
