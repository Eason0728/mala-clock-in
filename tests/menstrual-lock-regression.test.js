/* 生理假「一天算一次」＋假別同月去重 鎖月保護（2026-11-18）：已鎖月份（2026-11 之前）的薪資必須逐人逐項不變。
 *
 * 做法（照 design.md 第 3.8 節的 6–10 月對照法，用假資料）：同一份資料分別餵
 *   ①改版前的 Payroll.gs（git 02296c0＝feat/seg2-line 分支點）②現在的 Payroll.gs，
 * 都跑 handlePayrollCalc（payCollect → payInputsBase → payLeaveUsedBefore → payCalcOne → 寫 run／item），逐人比對。
 *   · 2026-06～2026-10：每個人、每一項都要相同（含刻意放了 12 小時生理假列、時數空白生理假列、手動工時的人）。
 *   · 2026-11、12：只有「本月之前有超過 8 小時或空白時數的生理假列」的人可以不同；其他人一律相同。
 *   · 對照：E08（9 月一列 12 小時）11 月確實變了（舊版算第 4 次扣半薪、新版是第 3 次不扣）——證明比對有在比。
 * 沒有 git 時跳過並說明，不算失敗。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = '02296c0';
let OLD;
try { OLD = cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { console.log('⚠ 取不到 git 基準 ' + BASE + '，跳過回歸比對'); process.exit(0); }
const NEW = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
function ctx(P, DB, CLOCK) {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  // 跟生理假無關、需要班表等資料的新算法：兩版一起推遠（兩邊同一套，不影響比對）；生理假的兩個起算月保留原值
  vm.runInContext("PAY_OT_DAILY_FROM = '2099-01'; PAY_RULES3_FROM = '2099-01'; if (typeof PAY_ANNUAL_SETTLE_FROM !== 'undefined') PAY_ANNUAL_SETTLE_FROM = '2099-01';", sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return payStore(store) === 'SSLGF' ? JSON.parse(JSON.stringify(globalThis.__C[sheet] || [])) : []; };   // 別家店（例：E01 在央廚有手動列）的打卡表是空的
    payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return '2027-01-15'; };
  `, sb);
  return sb;
}
const EMP = (id, name, o) => Object.assign({ emp_id: id, name, store: 'SSLGF', is_full_time: 'true', base: 30000, skill_allow: 3000,
  night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 758, health_ins: 470,
  group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-03-10', leave_date: '', meal_allow: 80, active: 'true' }, o);
const master = [EMP('E01', '甲君', {}), EMP('E02', '乙君', { base: 32000 }),
  EMP('E03', '丙君', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 205, skill_allow: 0 }),
  EMP('E08', '戊君', {}), EMP('E10', '己君', {}), EMP('E11', '庚君', {}), EMP('E12', '辛君', {})];
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];
const approved = [], events = [], leave = [];
const LV = ['事假', '病假', '生理假', '特休假', '家庭照顧假'];
master.forEach((e, ei) => MONTHS.forEach((ym, mi) => {
  const nd = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  for (let d = 1; d <= nd; d++) {
    const date = ym + '-' + ('0' + d).slice(-2);
    if ((d + ei) % 7 === 0 || (d + ei) % 7 === 3) continue;
    const k = (d * 7 + ei * 3 + mi) % 11;
    approved.push({ date, emp_id: e.emp_id, name: e.name, approved_hours: [8, 8.5, 9, 7.5, 8, 10, 8.25, 6, 8, 8.75, 4][k], status_text: '正常', entered_at: date + 'T22:00:00+08:00', manager_name: '主管' });
    events.push({ emp_id: e.emp_id, ts: date + 'T10:00:00+08:00', type: 'in', status: 'ok' }, { emp_id: e.emp_id, ts: date + 'T19:00:00+08:00', type: 'out', status: 'ok' });
    if ((e.emp_id === 'E01' || e.emp_id === 'E02' || e.emp_id === 'E03') && (k === 6 || k === 10)) leave.push({ '日期': date, '姓名': e.name, '假別': LV[(d + ei + mi) % LV.length], '時數': k === 6 ? 4 : 8 });
  }
}));
// 邊界的人：E08 7/2 8H、9/3 一列 12H（舊算 2 次、新算 1 次）、11/5 8H；E10 7/2 8H、10/1 時數空白（舊 0 次、新 1 次）、12/3 8H
leave.push({ '日期': '2026-07-02', '姓名': '戊君', '假別': '生理假', '時數': 8 }, { '日期': '2026-09-03', '姓名': '戊君', '假別': '生理假', '時數': 12 },
  { '日期': '2026-11-05', '姓名': '戊君', '假別': '生理假', '時數': 8 },
  { '日期': '2026-07-02', '姓名': '己君', '假別': '生理假', '時數': 8 }, { '日期': '2026-10-01', '姓名': '己君', '假別': '生理假', '時數': '' },
  { '日期': '2026-12-03', '姓名': '己君', '假別': '生理假', '時數': 8 });
// E11（假別同月去重的對照）：1–6 月每月病假 4 天＋9 月 4 天，9 月按過儲存工時（手動列 sick_h 32）→ 舊版算 32 天、新版 28 天
for (let m = 1; m <= 6; m++) for (let d = 1; d <= 4; d++) leave.push({ '日期': '2026-0' + m + '-0' + d, '姓名': '庚君', '假別': '病假', '時數': 8 });
for (let d = 1; d <= 4; d++) leave.push({ '日期': '2026-09-1' + d, '姓名': '庚君', '假別': '病假', '時數': 8 });
leave.push({ '日期': '2026-11-16', '姓名': '庚君', '假別': '病假', '時數': 8 }, { '日期': '2026-11-17', '姓名': '庚君', '假別': '病假', '時數': 8 });
// E12：9 月按過儲存工時（手動事假 8h），同月 leave 有事假 8h、家庭照顧假 16h、住院傷病假 8h；7 月（沒手動列）家照 8h
leave.push({ '日期': '2026-09-04', '姓名': '辛君', '假別': '事假', '時數': 8 }, { '日期': '2026-09-10', '姓名': '辛君', '假別': '家庭照顧假', '時數': 8 },
  { '日期': '2026-09-11', '姓名': '辛君', '假別': '家庭照顧假', '時數': 8 }, { '日期': '2026-09-15', '姓名': '辛君', '假別': '住院傷病假', '時數': 8 },
  { '日期': '2026-07-08', '姓名': '辛君', '假別': '家庭照顧假', '時數': 8 }, { '日期': '2026-11-12', '姓名': '辛君', '假別': '家庭照顧假', '時數': 8 });
const EDGE = { E08: 1, E10: 1, E11: 1 };   // E12 不在這裡：家照、住院傷病假照 leave 算＝跟改版前一樣，11、12 月也要逐項相同
const CLOCK = { roster: master.map((e) => ({ emp_id: e.emp_id, name: e.name, active: true })), approved, events, leave, requests: [] };
const freshDB = () => ({ master: JSON.parse(JSON.stringify(master)), run: [], item: [], config: [], leave_type: [],
  holiday: MONTHS.map((ym) => ({ ym, store: 'SSLGF', red_days: 8 })), bonus: [],
  input: [{ ym: '2026-06', emp_id: 'E02', store: 'SSLGF', hours: 176, extra_ot: 0, personal_h: 8, sick_h: 4, menstrual_h: 8, disaster_h: 0, annual_h: 0,
            deduct_days: 1, support: '[]', full_attend: 0, work_days: 22, wage_override: 0, meal_on: 1, holiday_h: 0 },
          // 9 月按過儲存工時的人（手動列＝工時分頁顯示的歸集值）、別家店同工號的手動列、「僅 support」列
          { ym: '2026-09', emp_id: 'E11', store: 'SSLGF', hours: 160, sick_h: 32, personal_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0, deduct_days: 4, support: '[]', full_attend: 0, work_days: 18, meal_on: 1, holiday_h: 0 },
          { ym: '2026-09', emp_id: 'E12', store: 'SSLGF', hours: 160, sick_h: 0, personal_h: 8, menstrual_h: 0, annual_h: 0, disaster_h: 0, deduct_days: 1, support: '[]', full_attend: 0, work_days: 20, meal_on: 1, holiday_h: 0 },
          { ym: '2026-08', emp_id: 'E01', store: 'CF', hours: 100, sick_h: 40, personal_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0, support: '[]' },
          { ym: '2026-10', emp_id: 'E02', store: 'SSLGF', hours_manual: '0', hours: 0, sick_h: 0, personal_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0, support: '[]' }] });
let pass = 0, fail = 0, lockedCompared = 0, laterCompared = 0;
const chk = (n, cond, detail) => { cond ? pass++ : fail++; if (!cond || detail) console.log((cond ? '✓ ' : '✗ ') + n + (detail ? '：' + detail : '')); };
const DB_OLD = freshDB(), DB_NEW = freshDB();
const sOld = ctx(OLD, DB_OLD, CLOCK), sNew = ctx(NEW, DB_NEW, CLOCK);
let e08Nov = null, e11Nov = null;
MONTHS.forEach((ym) => {
  const A = vm.runInContext('handlePayrollCalc', sOld)({ admin_key: 'x', ym, store: 'SSLGF' });
  const B = vm.runInContext('handlePayrollCalc', sNew)({ admin_key: 'x', ym, store: 'SSLGF' });
  chk(ym + ' 兩版都算得出來', A.ok && B.ok, A.ok && B.ok ? '' : JSON.stringify([A.error, B.error]));
  A.results.forEach((ra) => {
    const rb = B.results.find((x) => x.emp_id === ra.emp_id);
    const same = JSON.stringify(ra) === JSON.stringify(rb);
    if (ym === '2026-11' && ra.emp_id === 'E08') e08Nov = { old: ra.net, nw: rb.net, same };
    if (ym === '2026-11' && ra.emp_id === 'E11') e11Nov = { old: ra.net, nw: rb.net, same };
    if (ym < '2026-11') { lockedCompared++; chk(ym + ' ' + ra.emp_id + ' 逐項相同（鎖月）', same, same ? '' : '\n  舊 ' + JSON.stringify(ra).slice(0, 300) + '\n  新 ' + JSON.stringify(rb).slice(0, 300)); }
    else if (!EDGE[ra.emp_id]) { laterCompared++; chk(ym + ' ' + ra.emp_id + ' 逐項相同（沒有邊界生理假列）', same); }
  });
  DB_OLD.run.forEach((r) => { if (r.ym === ym) r.status = 'final'; });
  DB_NEW.run.forEach((r) => { if (r.ym === ym) r.status = 'final'; });
});
chk('對照：E08 11 月確實不同（舊版把 9/3 的 12H 算 2 次 → 11/5 變第 4 次扣半薪；新版第 3 次不扣）', e08Nov && !e08Nov.same && e08Nov.nw > e08Nov.old,
  e08Nov ? '舊 net ' + e08Nov.old + ' → 新 net ' + e08Nov.nw : '沒算到');
chk('對照：E11 11 月確實不同（舊版 9 月病假算兩次＝已用 32 天，11 月 16H 全無薪；新版 28 天，16H 半薪）', e11Nov && !e11Nov.same && e11Nov.nw > e11Nov.old,
  e11Nov ? '舊 net ' + e11Nov.old + ' → 新 net ' + e11Nov.nw : '沒算到');
console.log(`\n鎖月（2026-06～10）比對 ${lockedCompared} 人月、11～12 月一般人比對 ${laterCompared} 人月`);
console.log(fail ? `❌ ${fail} 項不一致` : `✅ 已鎖月份逐人逐項相同 (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
