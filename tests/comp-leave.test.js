/* 補休：每月加減結算（2026-11-01 Eason 改制，取代 2026-10-09 的存入＋6 個月到期）
 *  ①只有正職能請 ②本月核准加班（正）− 本月補休（負）＝補休帳，不跨月、沒有到期 ③可以先休後補、不設上限
 *  ④補休不算出勤時數（不抵不足），月底淨加班照加班費率發 ⑤補休帳是負的不能鎖定本月
 *  ⑥20、25 號檢查：有負數 → 通知匣＋私訊該店值班主管
 * 期望值全部手算寫死，不從程式反推。 */
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

/* ── 引擎切片（payR0～Handlers，與 payroll_mock.js 同一刀）── */
const a = P.indexOf('function payR0'), b = P.indexOf('/* ═══════════════════ Handlers');
const E = {};
new Function('exports', 'function pad2(n){return ("0"+n).slice(-2)}\n' + P.slice(a, b) +
  '\nObject.assign(exports,{payCalcOne,payCompMonthCalc,payCompDefaultType,payLeaveTypes});')(E);
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
const FT = { emp_id: 'A', name: '正職', is_full_time: 'true', base: 30000, skill_allow: 0, night_allow: 0, mgr_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2020-01-01', leave_date: '', meal_allow: 0, active: 'true' };
const PT = Object.assign({}, FT, { emp_id: 'B', name: '計時', is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 200 });
// 2026-10：31 天、紅字 11 天 → 基本 160H；2026-09：30 天、紅字 10 天 → 160H
const att0 = (o) => Object.assign({ hours: 0, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {},
  late_min: 0, personal_h: 0, sick_h: 0, annual_h: 0, menstrual_h: 0, disaster_h: 0 }, o);
const LT = E.payLeaveTypes('');
const calc = (e, o, ym, red) => E.payCalcOne(e, ym || '2026-10', att0(o), cfg, red === undefined ? 11 : red, LT);
const it = (r, k) => [].concat(r.earn, r.ded).find((i) => i.item_key === k);

console.log('══ 1) 補休帳（純計算）══');
let m = E.payCompMonthCalc([{ date: '2026-10-03', h: 3 }, { date: '2026-10-09', h: 2.5 }], [{ date: '2026-10-05', h: 4 }], []);
chk('加班 3＋2.5、補休 4 → 剩 1.5', [m.ot_h, m.used_h, m.balance_h], [5.5, 4, 1.5]);
m = E.payCompMonthCalc([], [], [{ date: '2026-10-05', h: 8 }]);
chk('沒有加班、先休 8（審核中）→ 欠 8（負的）', m.balance_h, -8);
m = E.payCompMonthCalc([{ date: '2026-10-01', h: 4 }], [{ date: '2026-10-05', h: 8 }], [{ date: '2026-10-05', h: 8 }, { date: '2026-10-06', h: 2 }]);
chk('同一天 leave 與申請都有 → 取較大的不重算（8＋2＝10）', [m.used_h, m.balance_h], [10, -6]);
m = E.payCompMonthCalc([], [{ date: '2026-10-05', h: 4 }], [{ date: '2026-10-05', h: 8 }]);
chk('申請 8、主管只核定 4 進 leave → 取 8（還沒改單前照申請算，寧可提早看到負數）', m.used_h, 8);

console.log('\n══ 2) payCalcOne：補休不抵不足、從加班扣 ══');
chk('內建補休假別：不抵不足、全薪、不算缺勤', (() => { const t = E.payCompDefaultType(); return [t.offset_shortfall, t.pay_ratio, t.count_absent]; })(), [false, 1, false]);
let r = calc(FT, { hours: 160, leaves: { comp: 8 } });
chk('上 160（含加班 8）＋補休 8 → 加班 0、沒有倒扣（加班剛好抵掉補休）', [r.ot_paid_hours, it(r, 'overtime'), it(r, 'shortfall_hours')], [0, undefined, undefined]);
r = calc(FT, { hours: 164, leaves: { comp: 8 } });
chk('上 164＋補休 8 → 剩 4H 照加班費 960', [r.ot_paid_hours, it(r, 'overtime').amount], [4, 960]);
r = calc(FT, { hours: 152, leaves: { comp: 8 } });
chk('上 152＋補休 8、沒加班 → 不足 8H（月底不會到這步：負的不能鎖定）', it(r, 'shortfall_hours').qty, 8);
r = calc(FT, { hours: 152, leaves: { comp: 8 } }, '2026-09', 10);
chk('2026-09（改制前）照舊：補休抵不足，沒有倒扣', it(r, 'shortfall_hours'), undefined);
r = calc(FT, { hours: 160, leaves: { comp: 8 }, comp: { req_h: 4, lots: [{ id: 'x', date: '2026-10-03', h: 4 }], expire_h: 3 } });
chk('舊制 att.comp 就算帶進來也不再產生「本月換補休／補休到期折算」', [it(r, 'comp_bank'), it(r, 'comp_expire'), 'comp_bank_h' in r], [undefined, undefined, false]);
r = calc(FT, { hours: 160, leaves: { comp: 8 } });
const LT2 = LT.map((t) => (t.code === 'comp' ? Object.assign({}, t, { offset_shortfall: true }) : t));
const r2 = E.payCalcOne(FT, '2026-10', att0({ hours: 160, leaves: { comp: 8 } }), cfg, 11, LT2);
chk('假別表的補休列勾了「可抵不足」也一樣不抵（正式表 2026-11-01 時是勾的）', [r2.ot_paid_hours, r2.gross], [r.ot_paid_hours, r.gross]);
chk('補休日不扣錢、不扣全勤', [r.ded.some((x) => /comp/.test(x.item_key)), it(r, 'attend_bonus').amount], [false, 3000]);

/* ── 整條鏈：讀 requests／leave → 補休帳 → 鎖定、核定頁額度、20／25 號檢查 ── */
function ctx(DB, CLOCK, extra) {
  const sb = Object.assign({
    console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }, sleep() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'NOTIFY_INBOX_TOKEN' ? 'TOK' : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  }, extra || {});
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return (globalThis.__C[sheet] || []).slice(); };
    payRead      = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return globalThis.__TODAY || '2026-10-20'; };
  `, sb);
  return sb;
}
const DB = {
  master: [Object.assign({}, FT, { emp_id: 'E01', name: '甲君', store: 'SSLGF' }),
           Object.assign({}, PT, { emp_id: 'E02', name: '乙君', store: 'SSLGF' }),
           Object.assign({}, FT, { emp_id: 'E03', name: '丙君', store: 'SSLGF' })],
  /* 薪酬挑錯第 8 項（Eason 2026-11-11 確認）：2026-10 起鎖定前會先用最新資料重算、跟草稿比（payLockStale_）。
     這支不放替身，讓真的重算比對跑：10 月的草稿列帶手算的金額，下面補 10 月的紅字天數（11 天）。
     2026-10 基本時數＝(31−11)×8＝160H；三位都沒有打卡紀錄（時數 0）；全勤每日倒扣 100、加班／不足費率 240（主檔 ot_rate）。
     ・E01 甲君（正職，底薪 30000、全勤上限 3000）：10/05 補休 8H（不抵不足、不扣錢）、10/06 事假 8H（抵不足）。
         不足 160−0−8＝152H×240＝36480；事假 8H×請假時薪（33000÷30÷8＝137.5→138）＝1104；全勤 3000−100×1 天＝2900。
         應發 30000＋2900＝32900、應扣 36480＋1104＝37584、實付 −4684。
     ・E02 乙君（計時 200、0 小時）：0／0／0。
     ・E03 丙君（正職，同主檔）：沒有假。應發 30000＋3000＝33000、應扣 160×240＝38400、實付 −5400。
     核准加班申請只進補休帳，不改這三個金額（第 4 段補核准 7H 之後一樣比對得過）。 */
  run: [{ ym: '2026-10', emp_id: 'E01', name: '甲君', store: 'SSLGF', status: 'draft', gross: 32900, deduction: 37584, net: -4684 },
        { ym: '2026-09', emp_id: 'E01', store: 'SSLGF', status: 'draft' },
        { ym: '2026-10', emp_id: 'E02', name: '乙君', store: 'SSLGF', status: 'draft', gross: 0, deduction: 0, net: 0 },
        { ym: '2026-10', emp_id: 'E03', name: '丙君', store: 'SSLGF', status: 'draft', gross: 33000, deduction: 38400, net: -5400 }],
  item: [], input: [], config: [], bonus: [], leave_type: [],
  holiday: [{ ym: '2026-10', red_days: 11, note: '', dates: '', store: '' }],
};
let rid = 0;
const RQ = (o) => Object.assign({ id: 'r' + (++rid), emp_id: 'E01', name: '甲君', kind: 'ot', date: '2026-10-03', hours: 2, status: 'approved' }, o);
const CLOCK = {
  roster: [{ emp_id: 'E01', name: '甲君', active: true, line_user_id: 'U_E01' }, { emp_id: 'E02', name: '乙君', active: true },
           { emp_id: 'E03', name: '丙君', active: 'TRUE', line_user_id: 'U_MGR' }],
  managers: [{ name: '丙 君', active: 'TRUE', key: 'k' }, { name: '門市營運系統', active: 'TRUE', allow_acting: 'TRUE', key: 'k2' }],
  leave: [{ '日期': '2026-10-05', '姓名': '甲君', '假別': '補休', '時數': 8 }, { '日期': '2026-09-28', '姓名': '甲君', '假別': '補休', '時數': 8 },
          { '日期': '2026-10-06', '姓名': '甲君', '假別': '事假', '時數': 8 }],
  requests: [RQ({}), RQ({ date: '2026-10-09', hours: 3, comp: 'pay' }), RQ({ date: '2026-10-10', hours: 4, status: 'pending' }),
             RQ({ date: '2026-09-30', hours: 5 }), RQ({ emp_id: 'E09', name: '別人', hours: 9 }),
             RQ({ kind: 'leave', leave_type: '補休', date: '2026-10-12', hours: 4, status: 'pending' }),
             RQ({ kind: 'leave', leave_type: '補休', date: '2026-10-13', hours: 4, status: 'rejected' }),
             RQ({ kind: 'leave', leave_type: '補休', date: '2026-10-05', hours: 8, status: 'approved' })],
};
let sb = ctx(DB, CLOCK);
console.log('\n══ 3) 補休帳讀資料 ══');
let st = vm.runInContext('payCompMonthBook', sb)('2026-10').forEmp(DB.master[0], 'SSLGF');
chk('甲君 10 月：加班 2＋3（審核中、9 月、別人不算）；補休 8（leave＝申請同天不重算）＋4（審核中）＝12；欠 7',
    [st.allowed, st.ot_h, st.used_h, st.balance_h, st.ym], [true, 5, 12, -7, '2026-10']);
chk('計時乙君 allowed false', vm.runInContext('payCompMonthBook', sb)('2026-10').forEmp(DB.master[1], 'SSLGF').allowed, false);
chk('負數名單只有甲君（計時、沒有補休的不列）', vm.runInContext('payCompNegatives', sb)('2026-10', 'SSLGF').map((x) => [x.emp_id, x.balance_h]), [['E01', -7]]);

console.log('\n══ 4) 鎖定：補休帳是負的擋下，解鎖不擋，改制前月份不擋 ══');
const fin = (o) => vm.runInContext('handlePayrollFinalize', sb)(Object.assign({ admin_key: 'x', ym: '2026-10', store: 'SSLGF', lock: true }, o));
let f = fin({});
chk('負的 → comp_negative、列出名單、run 沒被改', [f.ok, f.error, f.list.length, DB.run[0].status], [false, 'comp_negative', 1, 'draft']);
chk('訊息寫出誰欠幾小時', /甲君：加班 5 − 補休 12 ＝ -7 小時/.test(f.message), true);
chk('解鎖不擋', fin({ lock: false, reason: '測試' }).ok, true);
chk('2026-09（改制前）不檢查', fin({ ym: '2026-09' }).ok, true);
CLOCK.requests.push(RQ({ date: '2026-10-20', hours: 7 }));
sb = ctx(DB, CLOCK);
f = vm.runInContext('handlePayrollFinalize', sb)({ admin_key: 'x', ym: '2026-10', store: 'SSLGF', lock: true });
chk('補核准 7H 加班 → 剛好 0，可以鎖定', [f.ok, DB.run[0].status], [true, 'final']);
CLOCK.requests.pop(); DB.run[0].status = 'draft';

console.log('\n══ 5) 值班核定頁額度：只擋計時，負的照樣能選 ══');
sb = ctx(DB, CLOCK);
const lo = vm.runInContext('handlePayrollLeaveOptions', sb)({ admin_key: 'x', store: 'SSLGF', ym: '2026-10' });
const q1 = lo.quotas.E01.comp, q2 = lo.quotas.E02.comp;
chk('甲君：comp、本月帳 −7、不反灰', [q1.comp, q1.monthly, q1.balance_h, q1.blocked], [true, true, -7, false]);
chk('乙君（計時）反灰', [q2.allowed, q2.blocked], [false, true]);

console.log('\n══ 6) 20／25 號補休提醒已停用（Eason 2026-11-22：小幫手已在群組定期整理提醒，不個別提醒主管）══');
/* 同一份有負數的資料（甲君 −7）：以前 20 號會寫通知匣＋私訊值班主管；現在任何一天都 0 次通知匣、0 次 LINE push */
const calls = [];
const fetchStub = { fetch: (url, o) => { calls.push({ url, body: JSON.parse(o.payload) }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, added: true }) }; } };
sb = ctx(DB, CLOCK, { UrlFetchApp: fetchStub, LINE_HUB_BOT_TOKEN: 'BOT' });
chk('對照：這份資料 10 月確實有補休為負的人（鎖月規則照舊看得到）', vm.runInContext('payCompCheckAll_', sb)('2026-10').map((x) => x.store), ['SSLGF']);
for (const d of ['2026-10-19', '2026-10-20', '2026-10-25', '2026-11-20', '2026-11-25']) {
  sb.__TODAY = d; calls.length = 0;
  let threw = false, ret;
  try { ret = vm.runInContext('payCompCheckDaily', sb)(); } catch (e) { threw = true; }
  const push = calls.filter((c) => /line\.me/.test(c.url)).length, inbox = calls.filter((c) => !/line\.me/.test(c.url)).length;
  chk(d + '：payCompCheckDaily 還在、不拋例外、通知匣 0 次、LINE push 0 次', [typeof vm.runInContext('payCompCheckDaily', sb), threw, ret, inbox, push], ['function', false, undefined, 0, 0]);
}
chk('檢查＋通知、私訊值班主管兩支已刪（沒有其他呼叫者）', [vm.runInContext('typeof payCompCheckRun_', sb), vm.runInContext('typeof payCompPushManagers_', sb), vm.runInContext('typeof PAY_COMP_CHECK_DAYS', sb)], ['undefined', 'undefined', 'undefined']);
chk('通知匣 payInboxNotify_ 還在（每日重算失敗、月加班同步、單日超過 10 小時在用）', vm.runInContext('typeof payInboxNotify_', sb), 'function');

console.log('\n══ 7) payroll_comp_trigger_setup 只刪不建 ══');
function triggerWorld(handlers, adminOk) {
  const T = handlers.map((h, i) => ({ id: i, h, getHandlerFunction() { return this.h; } }));
  const log = { created: 0, deleted: [] };
  const builder = () => { const b = { timeBased: () => b, everyDays: () => b, atHour: () => b, inTimezone: () => b, everyHours: () => b, create: () => { log.created++; } }; return b; };
  const ScriptApp = { getProjectTriggers: () => T.slice(), deleteTrigger: (t) => { const k = T.indexOf(t); if (k >= 0) { T.splice(k, 1); log.deleted.push(t.h); } }, newTrigger: () => builder() };
  const w = ctx(DB, CLOCK, { ScriptApp, UrlFetchApp: fetchStub });
  vm.runInContext('checkAdmin = function(b){ return !!b && b.admin_key === "good"; }', w);
  return { w, T, log, fn: vm.runInContext('PAYROLL_HANDLERS', w).payroll_comp_trigger_setup };
}
{
  const { T, log, fn } = triggerWorld(['payAsOfDaily', 'payCompCheckDaily', 'payRestOverDaily', 'payCompCheckDaily', 'payOtMonthDaily']);
  const before = T.filter((t) => t.h !== 'payCompCheckDaily').map((t) => t.id);
  const r = fn({ admin_key: 'good' });
  chk('刪掉 2 個 payCompCheckDaily、沒有新建任何觸發器', [r.ok, r.removed, log.created, log.deleted], [true, 2, 0, ['payCompCheckDaily', 'payCompCheckDaily']]);
  chk('回剩下的 handler：payAsOfDaily、payRestOverDaily 等原封不動（同一個觸發器物件、順序不變）', [r.triggers, T.map((t) => t.id)], [['payAsOfDaily', 'payRestOverDaily', 'payOtMonthDaily'], before]);
  const r2 = fn({ admin_key: 'good' });
  chk('再呼叫一次：removed 0、仍不新建', [r2.ok, r2.removed, log.created, r2.triggers.length], [true, 0, 0, 3]);
}
{
  const { T, log, fn } = triggerWorld(['payCompCheckDaily', 'payRestOverDaily']);
  const r = fn({ admin_key: 'bad' });
  chk('金鑰錯 → unauthorized、觸發器一個都沒動', [r, log.deleted.length, log.created, T.length], [{ ok: false, error: 'unauthorized' }, 0, 0, 2]);
  chk('只限系統管理者（PAY_SCOPE_ADMIN_ONLY 照舊列著）', triggerWorld([]).w && vm.runInContext("PAY_SCOPE_ADMIN_ONLY.indexOf('payroll_comp_trigger_setup') >= 0", triggerWorld([]).w), true);
}

console.log(fail ? `\n❌ ${fail} 項不對` : `\n✅ 補休每月結算全部正確 (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
