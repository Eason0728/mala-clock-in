/* 2026-11-10 Eason 定案的四項薪資規則（＋忘刷「第幾天」）：
 *  ① 補休帳和薪資同一套：加班日是休息日只算前 2 小時、例假與國定假日不算（2026-11 起；查不到班表全算）
 *  ② 鎖定時擋「有打卡但還沒核定」（unapproved）
 *  ③ 休息日、例假的加班單比照考勤：當天全部核定時數都要有單
 *  ④ 支援店記的假只提醒（ot_info.support_leave），薪資不扣
 *  ⑤ 出勤紀錄表 miss_n＝本月第幾「天」忘打卡（同一天多張算同一天）
 * 期望值全部手算寫死，不從程式反推。 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..', 'apps-script');
const src = ['Code.gs', 'Payroll.gs', 'SchedPub.gs'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n');
const sb = { console, SpreadsheetApp: { flush() {}, getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => { const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) }, CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) } };
vm.createContext(sb); vm.runInContext(src, sb);
const CLOCK = sb.__CLOCK = {}, DB = sb.__DB = { master: [], holiday: [], run: [], store: [] };
vm.runInContext(`payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};
  payRead=function(k){return (globalThis.__DB[k]||[]).slice();};
  payStoreRow=function(){return {code:"SSLGF",emp_prefix:""};};
  payHolidayRow=function(ym){return globalThis.__DB.holiday.filter(function(h){return h.ym===ym;})[0]||null;};
  payEmpStoresMap=function(){return {};};
  payYesterday_=function(){return globalThis.__YESTERDAY||"2026-11-20";};
  checkAdmin=function(){return true;};`, sb);
const call = (fn, ...a) => vm.runInContext(fn, sb)(...a);
const J = (x) => JSON.parse(JSON.stringify(x));
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

// 班表：2026-11 屬 T01（11/01～11/28），cells[i]＝11/(i+1)
const cells = (marks) => { const c = Array.from({ length: 28 }, () => ({ t: 'W', s: 'A' })); Object.keys(marks).forEach(i => { c[i] = marks[i]; }); return c; };
const pub = (rows) => vm.runInContext('(function(x){ schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(x)); }; })', sb)({ '|T01': { rows } });
const E01 = { emp_id: 'E01', name: '甲君', is_full_time: true, active: true, store: 'SSLGF', hire_date: '2020-01-01' };
const GUO = { t: 'L', l: '國' };

console.log('══ ① 補休帳：休息日前 2 小時、例假與國定假日不算 ══');
let m = J(call('payCompMonthCalc', [{ date: '2026-11-03', h: 5 }], [], [], { '2026-11-03': 'H' }));
chk('純函式：休息日 5 小時 → 只算 2', m.ot_h, 2);
m = J(call('payCompMonthCalc', [{ date: '2026-11-03', h: 1 }, { date: '2026-11-03', h: 4 }], [], [], { '2026-11-03': 'H' }));
chk('純函式：同一個休息日兩張單 1＋4 → 合計 5 再取前 2 ＝ 2（不是 1＋2）', m.ot_h, 2);
m = J(call('payCompMonthCalc', [{ date: '2026-11-03', h: 1.5 }], [], [], { '2026-11-03': 'H' }));
chk('純函式：休息日 1.5 小時（不到 2）→ 1.5', m.ot_h, 1.5);
m = J(call('payCompMonthCalc', [{ date: 'a', h: 3 }, { date: 'b', h: 4 }, { date: 'c', h: 2 }], [], [], { a: 'R', b: 'HOL', c: 'W' }));
chk('純函式：例假 3、國定假日 4 不算；上班日 2 全算', m.ot_h, 2);
m = J(call('payCompMonthCalc', [{ date: 'a', h: 3 }, { date: 'b', h: 4 }], [], [], { a: '' }));
chk('純函式：日別空字串（班表一格查不到）或沒列的日子 → 全算', m.ot_h, 7);
m = J(call('payCompMonthCalc', [{ date: '2026-11-03', h: 5 }], [{ date: '2026-11-09', h: 3 }], []));
chk('純函式：沒帶日別（舊呼叫端）→ 全算 5，餘額 2', [m.ot_h, m.balance_h], [5, 2]);

// 整條鏈：requests／leave → payCompMonthBook
const RQ = (date, hours, o) => Object.assign({ emp_id: 'E01', name: '甲君', kind: 'ot', date, hours, status: 'approved' }, o || {});
DB.master = [E01];
CLOCK.leave = [{ '日期': '2026-11-09', '姓名': '甲君', '假別': '補休', '時數': 3 }];
CLOCK.requests = [RQ('2026-11-03', 1), RQ('2026-11-03', 4),   // 11/03 休息日 5 → 2
  RQ('2026-11-04', 3),                                          // 11/04 例假 → 0
  RQ('2026-11-06', 3),                                        // 11/06 上班日 → 3
  RQ('2026-11-08', 2),                                          // 11/08 班表那格空白（查不到）→ 全算 2
  RQ('2026-11-10', 6),                                          // 11/10 薪資節日清單的國定假日 → 0
  RQ('2026-11-12', 9, { status: 'pending' })];                  // 審核中不算
DB.holiday = [{ ym: '2026-11', store: '', dates: '2026-11-10' }];
pub([{ emp_id: 'E01', name: '甲君', cells: cells({ 2: { t: 'H' }, 3: { t: 'R' }, 7: { t: '' } }) }]);
let st = J(call('payCompMonthBook', '2026-11').forEmp(E01, 'SSLGF'));
chk('2026-11 補休帳：2＋0＋3＋2＋0 ＝ 7；補休 3；餘額 4', [st.ot_h, st.used_h, st.balance_h], [7, 3, 4]);
pub([]);
st = J(call('payCompMonthBook', '2026-11').forEmp(E01, 'SSLGF'));
chk('班表完全查不到 → 平日照舊全算，節日清單的國定假日仍不算（5＋3＋3＋2 ＝ 13，同薪資）', st.ot_h, 13);
CLOCK.requests = [RQ('2026-11-05', 4), RQ('2026-11-06', 3)];
DB.holiday = [{ ym: '2026-11', store: '', dates: '2026-11-05' }];
pub([{ emp_id: 'E01', name: '甲君', cells: cells({ 4: GUO }) }]);
st = J(call('payCompMonthBook', '2026-11').forEmp(E01, 'SSLGF'));
chk('國定假日 11/05（班表「國」）4 小時不算；11/06 上班日 3 小時 → 3', st.ot_h, 3);
CLOCK.requests = [RQ('2026-11-05', 4), RQ('2026-11-10', 6)];
DB.holiday = [{ ym: '2026-11', store: '', dates: '2026-11-10' }];
pub([{ emp_id: 'E01', name: '甲君', cells: cells({ 4: GUO }) }]);
st = J(call('payCompMonthBook', '2026-11').forEmp(E01, 'SSLGF'));
chk('國定假日調移：同期 11/05 排了「國」→ 11/10 當一般上班日全算 6；11/05 的「國」格 4 小時不算 → 6', st.ot_h, 6);
CLOCK.requests = [RQ('2026-10-03', 5), RQ('2026-10-04', 3)];
CLOCK.leave = [];
pub([{ emp_id: 'E01', name: '甲君', cells: cells({ 2: { t: 'H' }, 3: { t: 'R' } }) }]);
st = J(call('payCompMonthBook', '2026-10').forEmp(E01, 'SSLGF'));
chk('反例：2026-10 以前的月份不變（全算 5＋3 ＝ 8）', st.ot_h, 8);

console.log('\n══ ② 鎖定：有打卡但還沒核定 ══');
const ev = (emp, ts, type, status) => ({ emp_id: emp, ts, type, status: status || 'ok' });
const ap = (emp, date) => ({ date, emp_id: emp, name: '甲君', approved_hours: 8, status_text: '', entered_at: '2026-11-20T10:00:00+08:00' });
DB.master = [E01, { emp_id: 'E02', name: '乙君', is_full_time: true, active: true, store: 'SSLGF', hire_date: '2020-01-01' },
  { emp_id: 'E03', name: '丙君', is_full_time: true, active: 'false', store: 'SSLGF', hire_date: '2020-01-01' }];
CLOCK.events = [
  ev('E01', '2026-11-02T09:00:00+08:00', 'in'), ev('E01', '2026-11-02T18:00:00+08:00', 'out'),   // 11/02 已核定
  ev('E01', '2026-11-03T09:00:00+08:00', 'in'), ev('E01', '2026-11-03T18:00:00+08:00', 'out'),   // 11/03 沒核定 → 列
  ev('E01', '2026-11-04T22:00:00+08:00', 'in'), ev('E01', '2026-11-05T02:00:00+08:00', 'out'),   // 跨夜班，核定在 11/04 → 不列、11/05 凌晨的下班卡不算另一天
  ev('E01', '2026-11-06T09:00:00+08:00', 'in', 'rejected_outside'),                              // 被擋的卡不算
  ev('E01', '2026-11-20T09:00:00+08:00', 'in'),                                                  // 今天（昨天＝11/19）之後 → 不列
  ev('E02', '2026-11-03T09:00:00+08:00', 'in'),                                                  // 乙君 11/03 只有上班卡沒核定 → 列
  ev('E02', '2026-11-07T20:00:00+08:00', 'out'),                                                 // 乙君 11/07 只有下班卡（忘打上班）沒核定 → 列
  ev('E03', '2026-11-03T09:00:00+08:00', 'in'),                                                  // 離職（不在職）不列
  ev('E01', '2026-10-30T09:00:00+08:00', 'in'),                                                  // 別的月份不列
];
CLOCK.approved = [ap('E01', '2026-11-02'), ap('E01', '2026-11-04')];
sb.__YESTERDAY = '2026-11-19';
let un = J(call('payUnapprovedAll_', '2026-11', 'SSLGF'));
chk('列出：甲君 11/03、乙君 11/03、乙君 11/07（依日期、工號）', un, [
  { emp_id: 'E01', name: '甲君', date: '2026-11-03' }, { emp_id: 'E02', name: '乙君', date: '2026-11-03' }, { emp_id: 'E02', name: '乙君', date: '2026-11-07' }]);
CLOCK.approved = CLOCK.approved.concat([ap('E01', '2026-11-03'), ap('E02', '2026-11-03'), ap('E02', '2026-11-07')]);
chk('反例：全部都有核定紀錄 → 空', J(call('payUnapprovedAll_', '2026-11', 'SSLGF')), []);
CLOCK.approved = [ap('E01', '2026-11-02'), ap('E01', '2026-11-04')];
// 核定日期被 Sheets 轉成 Date 物件也要認得
const d03 = vm.runInContext('new Date(2026, 10, 3)', sb);   // 要在沙盒裡建，instanceof Date 才認得
CLOCK.approved = CLOCK.approved.concat([Object.assign(ap('E01', ''), { date: d03 })]);
chk('核定日期是 Date 物件（Sheets 轉的）→ 一樣認得，甲君 11/03 不再列', J(call('payUnapprovedAll_', '2026-11', 'SSLGF')).map(x => x.name + x.date.slice(5)), ['乙君11-03', '乙君11-07']);

// 鎖定流程：unapproved 被擋；解鎖不擋；2026-10 不檢查
vm.runInContext(`payLockStale_=function(){return {list:[]};};payCompNegatives=function(){return [];};paySchedMissingAll_=function(){return [];};payAppend=function(){};payReplaceAll=function(){};payInvalidate=function(){};`, sb);
CLOCK.approved = [ap('E01', '2026-11-02'), ap('E01', '2026-11-04')];
const fin = (o) => call('handlePayrollFinalize', Object.assign({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true }, o));
let r = J(fin({}));
chk('鎖定 2026-11 → unapproved，名單 3 筆', [r.ok, r.error, r.list.length], [false, 'unapproved', 3]);
chk('訊息是白話：還有 3 天有打卡但沒核定：11/3 甲君、11/3 乙君、11/7 乙君', /還有 3 天有打卡但沒核定.*11\/3 甲君、11\/3 乙君、11\/7 乙君/.test(r.message), true);
r = J(fin({ lock: false, reason: '測試' }));
chk('解鎖不擋', r.error === 'unapproved', false);
r = J(fin({ ym: '2026-10' }));
chk('反例：2026-10（逐日加班之前）不檢查', r.error === 'unapproved', false);
CLOCK.approved = CLOCK.approved.concat([ap('E01', '2026-11-03'), ap('E02', '2026-11-03'), ap('E02', '2026-11-07')]);
r = J(fin({}));
chk('反例：核定齊了 → 不再被 unapproved 擋', r.error === 'unapproved', false);

console.log('\n══ ③ 加班單：休息日、例假當天全部時數都要有單 ══');
const chkForm = (kind, h, formH, extra) => {
  const d = '2026-11-14';
  const att = Object.assign({ ot_own_h: { [d]: h }, ot_forms: { ot: formH == null ? {} : { [d]: formH }, trip: {} },
    daily: { sched: { [d]: kind ? { t: kind, s: 'A' } : null }, hol: {} } }, extra || {});
  return J(call('payOtFormCheck_', att).missing);
};
chk('休息日出勤 5 小時、單只有 2 → 缺（需要 5，有 2）', chkForm('H', 5, 2), [{ date: '2026-11-14', need: 5, have: 2 }]);
chk('反例：休息日 5 小時、單 5 小時 → 不缺', chkForm('H', 5, 5), []);
chk('休息日只出勤 3 小時（沒超過 8）、沒單 → 缺 3（以前不缺）', chkForm('H', 3, null), [{ date: '2026-11-14', need: 3, have: 0 }]);
chk('例假出勤 4 小時、沒單 → 缺 4', chkForm('R', 4, null), [{ date: '2026-11-14', need: 4, have: 0 }]);
chk('反例：上班日 9 小時、沒單 → 照舊只缺超過 8 的 1 小時', chkForm('W', 9, null), [{ date: '2026-11-14', need: 1, have: 0 }]);
chk('反例：上班日 8 小時 → 不缺（不用單）', chkForm('W', 8, null), []);
chk('反例：班表查不到（當上班日）8.5 小時、單 0.5 → 不缺', chkForm(null, 8.5, 0.5), []);
chk('國定假日（節日清單）10 小時、沒單 → 照舊缺 2', (() => {
  const d = '2026-11-14';
  return J(call('payOtFormCheck_', { ot_own_h: { [d]: 10 }, ot_forms: { ot: {}, trip: {} }, daily: { sched: { [d]: { t: 'W' } }, hol: { [d]: true } } }).missing);
})(), [{ date: '2026-11-14', need: 2, have: 0 }]);
chk('反例：11/11 之前的休息日不查', (() => {
  const d = '2026-11-10';
  return J(call('payOtFormCheck_', { ot_own_h: { [d]: 5 }, ot_forms: { ot: {}, trip: {} }, daily: { sched: { [d]: { t: 'H' } }, hol: {} } }).missing);
})(), []);
chk('跨店當天本店是休息日：本店 5 小時整天都要單（Fable 審查）', (() => {
  const d = '2026-11-14';
  return J(call('payOtFormCheck_', { ot_own_h: { [d]: 5 }, ot_forms: { ot: {}, trip: {} }, daily: { sched: { [d]: { t: 'H' } }, hol: {} },
    ot_cross: { [d]: [{ home: true, need: 1 }] } }).missing);
})(), [{ date: '2026-11-14', need: 5, have: 0 }]);

console.log('\n══ ④ 支援店記的假：只提醒、不扣錢 ══');
const entry = { stores: [{ code: 'SSLMC', name: '美村', days: [{ date: '2026-11-05', hours: 8 }, { date: '2026-11-12', hours: 0 }] }] };
const LV = [{ '日期': '2026-11-05', '姓名': '甲君', '假別': '事假', '時數': 4 },   // 支援當天 → 列
  { '日期': '2026-11-06', '姓名': '甲君', '假別': '病假', '時數': 8 },             // 不是支援日 → 不列
  { '日期': '2026-11-05', '姓名': '別人', '假別': '事假', '時數': 8 },             // 別人 → 不列
  { '日期': '2026-12-05', '姓名': '甲君', '假別': '事假', '時數': 8 },             // 別的月份 → 不列
  { '日期': new Date(2026, 10, 12), '姓名': '甲君', '假別': '特休', '時數': 8 }];   // 11/12 支援時數 0（不算支援日）→ 不列
chk('列出 11/05 美村事假 4 小時', J(call('paySupportLeaveList_', entry, '甲君', { SSLMC: LV }, '2026-11')),
  [{ date: '2026-11-05', store: 'SSLMC', store_name: '美村', type: '事假', hours: 4 }]);
chk('反例：支援店 leave 讀不到（null）→ 略過', J(call('paySupportLeaveList_', entry, '甲君', { SSLMC: null }, '2026-11')), []);
chk('反例：沒有支援店 → 空', J(call('paySupportLeaveList_', { stores: [] }, '甲君', { SSLMC: LV }, '2026-11')), []);

// 進 payCalcOne：ot_info.support_leave 有帶、而且薪資沒有因此扣款
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
const FT = Object.assign({}, E01, { is_full_time: 'true', base: 30000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0,
  labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, leave_date: '', meal_allow: 0 });
const LT = call('payLeaveTypes', '');
const att = (sl) => {
  const a = { hours: 160, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 0, personal_h: 0, sick_h: 0, annual_h: 0, menstrual_h: 0, disaster_h: 0 };
  a.daily = call('payDailyFor_', FT, '2026-11', { day_h: {}, day_leave: {} }, null, {}, [], '2026-11-19', 0);
  if (sl) a.support_leave = sl;
  return a;
};
const calc = (a) => J(call('payCalcOne', FT, '2026-11', a, cfg, 9, LT));
const base = calc(att(null)), withSl = calc(att([{ date: '2026-11-05', store: 'SSLMC', store_name: '美村', type: '事假', hours: 4 }]));
chk('payCalcOne：ot_info.support_leave 帶出、實付與沒有支援假時完全一樣', [withSl.ot_info.support_leave.length, withSl.net === base.net, withSl.ded.length === base.ded.length], [1, true, true]);
chk('反例：沒有支援假 → ot_info 沒有 support_leave 欄', 'support_leave' in base.ot_info, false);

console.log('\n══ ⑤ 出勤紀錄表 miss_n＝本月第幾「天」忘打卡 ══');
const mq = (date, created, o) => Object.assign({ emp_id: 'E01', kind: 'miss', status: 'approved', date, created_at: created }, o || {});
vm.runInContext(`todayTaipeiStr=function(){return "2026-11-20";};`, sb);
const build = (reqs) => call('payAttendanceBuild', '2026-11', [{ emp_id: 'E01', name: '甲君', active: true }], [], [], [], '', reqs, 'SSLGF');
const days = (reqs) => { const r = build(reqs); const e = r.employees[0]; const o = {}; e.days.forEach(x => { if (x.miss_n) o[x.date.slice(8)] = x.miss_n; }); return o; };
chk('三個不同的日子 → 1、2、3', days([mq('2026-11-03', 'a'), mq('2026-11-05', 'b'), mq('2026-11-09', 'c')]), { '03': 1, '05': 2, '09': 3 });
chk('同一天兩張只算同一天：11/03 兩張、11/05、11/09 → 1、2、3（不是 1、2、3、4）', days([mq('2026-11-03', 'a'), mq('2026-11-03', 'b'), mq('2026-11-05', 'c'), mq('2026-11-09', 'd')]), { '03': 1, '05': 2, '09': 3 });
chk('同一天三張 + 另一天 → 同天同號碼，下一天是 2（第 3 天起才標）', days([mq('2026-11-03', 'a'), mq('2026-11-03', 'b'), mq('2026-11-03', 'c'), mq('2026-11-04', 'd')]), { '03': 1, '04': 2 });
chk('反例：退回的不算、別月份不算、後送的早日期仍依日期先後編號', days([mq('2026-11-09', 'a'), mq('2026-11-03', 'b'), mq('2026-11-05', 'c', { status: 'rejected' }), mq('2026-10-30', 'd')]), { '03': 1, '09': 2 });

console.log(`\n${p} 項通過、${f} 項失敗`);
process.exit(f ? 1 : 0);
