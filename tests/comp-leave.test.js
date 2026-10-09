/* 補休（2026-10-09 Eason 定案，規格 ~/Desktop/Claude/補休制度_規格_20261009.md）
 *  ①只有正職能換 ②1:1 小時 ③6 個月到期（最後可休日＝加班日＋6 個月－1 天）
 *  ④每月最多換到當月加班時數（從加班費扣，不會造成不足倒扣）⑤只認已定案月份的存入
 *  ⑥先換的先用；到期沒休完在「最後可休日所在月份」照加班費率折算；離職當月全部折算
 *  ⑦補休假比照特休：全薪、不扣全勤、算進不足時數抵扣
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
  '\nObject.assign(exports,{payCalcOne,payCompExpireDay,payCompSimulate,payCompBalanceFromSim,payCompExpireHours,payCompAllocate,payCompMemo,payCompParseBank,payLeaveTypes,payWithCompType});')(E);
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
const FT = { emp_id: 'A', name: '正職', is_full_time: 'true', base: 30000, skill_allow: 0, night_allow: 0, mgr_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2020-01-01', leave_date: '', meal_allow: 0, active: 'true' };
const PT = Object.assign({}, FT, { emp_id: 'B', name: '計時', is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 200 });
// 2026-10：31 天、紅字 11 天 → 基本 160H
const att0 = (o) => Object.assign({ hours: 0, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {},
  late_min: 0, personal_h: 0, sick_h: 0, annual_h: 0, menstrual_h: 0, disaster_h: 0 }, o);
const calc = (e, o, ym) => E.payCalcOne(e, ym || '2026-10', att0(o), cfg, 11);
const it = (r, k) => [].concat(r.earn, r.ded).find((i) => i.item_key === k);

console.log('══ 1) 到期日定義 ══');
chk('加班 2026-10-11 → 最後可休日 2027-04-10', E.payCompExpireDay('2026-10-11'), '2027-04-10');
chk('加班 2026-08-31 → 2027-02-28 往前一天＝2027-02-27', E.payCompExpireDay('2026-08-31'), '2027-02-27');
chk('加班 2026-12-31 → 沒有 6/31 用 6/30，往前一天＝2027-06-29', E.payCompExpireDay('2026-12-31'), '2027-06-29');
chk('加班 2026-07-01 → 2026-12-31', E.payCompExpireDay('2026-07-01'), '2026-12-31');

console.log('\n══ 2) payCalcOne：沒有補休＝與不帶 comp 完全相同 ══');
const base165 = calc(FT, { hours: 165 });
chk('不帶 comp：加班 5H、加班費 1200', [base165.ot_paid_hours, it(base165, 'overtime').amount], [5, 1200]);
chk('comp:null 與不帶完全相同（整份回傳）', JSON.stringify(calc(FT, { hours: 165, comp: null })), JSON.stringify(base165));
chk('沒有補休時回傳不多欄位', ['comp_bank_h' in base165, 'comp_expire_h' in base165], [false, false]);

console.log('\n══ 3) 換補休 ≤ 當月加班 ══');
let r = calc(FT, { hours: 165, comp: { req_h: 3, lots: [{ id: 'rA', date: '2026-10-11', h: 3 }], expire_h: 0 } });
chk('加班費只付 2H＝480', [r.ot_paid_hours, it(r, 'overtime').qty, it(r, 'overtime').amount], [2, 2, 480]);
chk('本月換補休 3H、0 元、memo 記申請', [it(r, 'comp_bank').item_label, it(r, 'comp_bank').qty, it(r, 'comp_bank').amount, it(r, 'comp_bank').memo],
    ['本月換補休', 3, 0, 'rA@2026-10-11=3']);
chk('應發少 720（3H×240）、沒有不足倒扣', [base165.gross - r.gross, it(r, 'shortfall_hours')], [720, undefined]);
chk('回傳 comp_bank_h 3', r.comp_bank_h, 3);

console.log('\n══ 4) 申請 > 當月加班：只換到加班時數，註明 ══');
r = calc(FT, { hours: 165, comp: { req_h: 8, lots: [{ id: 'rA', date: '2026-10-11', h: 3 }, { id: 'rB', date: '2026-10-25', h: 5 }], expire_h: 0 } });
chk('換 5H、沒有加班費列、沒有倒扣', [it(r, 'comp_bank').qty, it(r, 'overtime'), it(r, 'shortfall_hours')], [5, undefined, undefined]);
chk('標示「申請 8，當月加班只有 5」', it(r, 'comp_bank').item_label, '本月換補休（申請 8 小時，當月加班只有 5 小時）');
chk('先換的先入帳：rA 3、rB 2', it(r, 'comp_bank').memo, 'rA@2026-10-11=3;rB@2026-10-25=2');
r = calc(FT, { hours: 150, comp: { req_h: 4, lots: [{ id: 'rA', date: '2026-10-11', h: 4 }], expire_h: 0 } });
chk('當月不足（150H）：換 0H、照記並註明；倒扣 10H 與沒申請時相同',
    [it(r, 'comp_bank').qty, it(r, 'comp_bank').item_label, it(r, 'shortfall_hours').qty, r.gross === calc(FT, { hours: 150 }).gross],
    [0, '本月換補休（申請 4 小時，當月加班只有 0 小時）', 10, true]);

console.log('\n══ 5) 計時同仁：換補休一律忽略（當加班費／照時薪）══');
const pt0 = calc(PT, { hours: 120 });
const pt1 = calc(PT, { hours: 120, comp: { req_h: 5, lots: [{ id: 'x', date: '2026-10-11', h: 5 }], expire_h: 0 } });
chk('計時：沒有 comp_bank 列、金額與沒申請相同', [it(pt1, 'comp_bank'), pt1.gross, pt1.net], [undefined, pt0.gross, pt0.net]);

console.log('\n══ 6) 到期折算與離職結清（引擎）══');
r = calc(FT, { hours: 160, comp: { req_h: 0, lots: [], expire_h: 2.5 } });
chk('補休到期折算 2.5H × 240 ＝ 600', [it(r, 'comp_expire').item_label, it(r, 'comp_expire').qty, it(r, 'comp_expire').rate, it(r, 'comp_expire').amount],
    ['補休到期折算', 2.5, 240, 600]);
r = calc(FT, { hours: 165, comp: { req_h: 3, lots: [{ id: 'rA', date: '2026-10-11', h: 3 }], expire_h: 6, final_month: true } });
chk('離職當月：本月申請不換（加班 5H 照付）、剩下 6H 結清',
    [it(r, 'overtime').qty, it(r, 'comp_bank'), it(r, 'comp_expire').item_label, it(r, 'comp_expire').amount],
    [5, undefined, '補休到期折算（離職結清）', 1440]);

console.log('\n══ 7) 先換的先用、先到期（payCompSimulate）══');
const lots = [{ id: 'a', date: '2026-10-11', h: 3, expire: '2027-04-10' }, { id: 'b', date: '2026-11-05', h: 4, expire: '2027-05-04' }];
let sim = E.payCompSimulate(lots, [{ date: '2026-12-01', h: 5 }]);
chk('休 5H：先扣 a 的 3、再扣 b 的 2', sim.lots.map((l) => [l.id, l.left]), [['a', 0], ['b', 2]]);
chk('2027-05 到期 2H、2027-04 沒有', [E.payCompExpireHours(sim, '2027-05', false), E.payCompExpireHours(sim, '2027-04', false)], [2, 0]);
sim = E.payCompSimulate(lots, [{ date: '2026-11-01', h: 4 }]);
chk('11/01 休 4H：b 還沒存入（加班日 11/05）→ 只扣得到 a 的 3，1H 記 overdraw', [sim.lots.map((l) => l.left), sim.overdraw_h], [[0, 4], 1]);
sim = E.payCompSimulate(lots, [{ date: '2027-04-20', h: 2 }]);
chk('a 過期後才休：扣 b 不扣 a；a 剩 3 在 2027-04 折算', [sim.lots.map((l) => l.left), E.payCompExpireHours(sim, '2027-04', false)], [[3, 2], 3]);
chk('2027-04-15 的餘額＝b 的 2（a 已過期）、最早到期 2027-05-04', E.payCompBalanceFromSim(sim, '2027-04-15'), { balance_h: 2, earliest_expiry: '2027-05-04' });
chk('離職月 2027-03：還沒過期的全部結清 3＋2', E.payCompExpireHours(sim, '2027-03', true), 5);
chk('memo 讀回（含到期日）', E.payCompParseBank('rA@2026-10-11=3;rB@2026-10-25=2', '2026-10', 5).map((l) => [l.id, l.h, l.expire]),
    [['rA', 3, '2027-04-10'], ['rB', 2, '2027-04-24']]);
chk('memo 讀不懂 → 整筆當該月 1 號（到期只會更早）', E.payCompParseBank('亂改', '2026-10', 5).map((l) => [l.date, l.h, l.expire]), [['2026-10-01', 5, '2027-03-31']]);

console.log('\n══ 8) 假別表：沒有補休列就補內建（全薪、不扣全勤、抵不足）；表上停用就尊重 ══');
const T = E.payLeaveTypes('');
const ct = T.filter((t) => t.name === '補休')[0];
chk('內建預設有補休、排最後', [!!ct, T[T.length - 1].name], [true, '補休']);
chk('補休比照特休', [ct.code, ct.pay_ratio, ct.count_absent, ct.offset_shortfall], ['comp', 1, false, true]);
chk('表上已有補休列 → 不重複補', E.payWithCompType([{ code: 'x1', name: '補休' }]).length, 1);

/* ── 整條鏈：handlePayrollCalc（requests → 定案 → 休補休 → 到期折算）── */
function ctx(DB, CLOCK) {
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return (globalThis.__C[sheet] || []).slice(); };
    payRead      = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return globalThis.__TODAY || '2026-10-09'; };
  `, sb);
  return sb;
}
const days = (ym, n, h) => Array.from({ length: n }, (_, i) => ({ date: ym + '-' + ('0' + (i + 1)).slice(-2), emp_id: 'E01', name: '甲君',
  approved_hours: h, status_text: '正常', entered_at: ym + '-01T20:00:00+08:00', manager_name: '主管' }));
const DB = {
  master: [Object.assign({}, FT, { emp_id: 'E01', name: '甲君', store: 'SSLGF' }),
           Object.assign({}, PT, { emp_id: 'E02', name: '乙君', store: 'SSLGF' })],
  run: [], item: [], input: [], config: [], bonus: [], leave_type: [],
  holiday: [{ ym: '2026-10', store: 'SSLGF', red_days: 11 }, { ym: '2027-03', store: 'SSLGF', red_days: 8 },
            { ym: '2027-04', store: 'SSLGF', red_days: 9 }],
};
const CLOCK = {
  roster: [{ emp_id: 'E01', name: '甲君', active: true }, { emp_id: 'E02', name: '乙君', active: true }],
  events: [], leave: [],
  approved: days('2026-10', 20, 8.25).concat(days('2026-10', 10, 8).map((x) => Object.assign(x, { emp_id: 'E02', name: '乙君' }))),
  requests: [
    { id: 'rA', kind: 'ot', date: '2026-10-11', hours: 3, status: 'approved', emp_id: 'E01', comp: 'comp' },
    { id: 'rB', kind: 'ot', date: '2026-10-20', hours: 1, status: 'approved', emp_id: 'E01', comp: 'comp' },
    { id: 'rC', kind: 'ot', date: '2026-10-21', hours: 2, status: 'approved', emp_id: 'E01', comp: 'pay' },
    { id: 'rD', kind: 'ot', date: '2026-10-22', hours: 2, status: 'pending', emp_id: 'E01', comp: 'comp' },     // 沒核准不算
    { id: 'rE', kind: 'ot', date: '2026-09-30', hours: 2, status: 'approved', emp_id: 'E01', comp: 'comp' },    // 別月不算
    { id: 'rF', kind: 'ot', date: '2026-10-11', hours: 5, status: 'approved', emp_id: 'E02', comp: 'comp' },    // 計時不換
  ],
};
let sb = ctx(DB, CLOCK);
const run = (ym) => vm.runInContext('handlePayrollCalc', sb)({ admin_key: 'x', ym, store: 'SSLGF', inputs: {} });
console.log('\n══ 9) 整條鏈：2026-10 結算 ══');
let R = run('2026-10');
let e1 = R.results.find((x) => x.emp_id === 'E01'), e2 = R.results.find((x) => x.emp_id === 'E02');
chk('甲君 165H－160＝加班 5；換補休 rA3＋rB1＝4 → 加班費只付 1H', [e1.ot_paid_hours, it(e1, 'overtime').qty, it(e1, 'comp_bank').qty], [1, 1, 4]);
const itemRow = DB.item.find((i) => i.emp_id === 'E01' && i.item_key === 'comp_bank');
chk('item 存 comp_bank（qty 4、0 元、memo 追得到申請）', [itemRow.qty, itemRow.amount, itemRow.memo], [4, 0, 'rA@2026-10-11=3;rB@2026-10-20=1']);
chk('其他 item 的 memo 照舊是空字串', DB.item.filter((i) => i.item_key !== 'comp_bank').every((i) => i.memo === ''), true);
chk('計時乙君：申請換補休也沒有 comp_bank', it(e2, 'comp_bank'), undefined);

console.log('\n══ 10) 只認定案月份 ══');
let st = vm.runInContext('payCompStatus', sb)(vm.runInContext('payCompBook', sb)(), DB.master[0], 'SSLGF', '2026-11-01');
chk('10 月還是草稿 → 餘額 0', st.balance_h, 0);
DB.run.forEach((x) => { x.status = 'final'; });
sb = ctx(DB, CLOCK);
st = vm.runInContext('payCompStatus', sb)(vm.runInContext('payCompBook', sb)(), DB.master[0], 'SSLGF', '2026-11-01');
chk('定案後 → 餘額 4、最早 2027-04-10 到期、正職 allowed', [st.balance_h, st.earliest_expiry, st.allowed], [4, '2027-04-10', true]);
const st2 = vm.runInContext('payCompStatus', sb)(vm.runInContext('payCompBook', sb)(), DB.master[1], 'SSLGF', '2026-11-01');
chk('計時乙君 allowed false', [st2.allowed, st2.balance_h], [false, 0]);

console.log('\n══ 11) 休補休（leave 分頁假別「補休」）：比照特休、扣最早那批 ══');
CLOCK.leave = [{ '日期': '2026-12-05', '姓名': '甲君', '假別': '補休', '時數': 1 }];
sb = ctx(DB, CLOCK);
st = vm.runInContext('payCompStatus', sb)(vm.runInContext('payCompBook', sb)(), DB.master[0], 'SSLGF', '2026-12-31');
chk('休 1H 後餘額 3', st.balance_h, 3);
// 補休那天的歸集：不扣錢、不算缺勤、抵不足
const col = vm.runInContext('payCollect', sb)('2026-12', 6, 'SSLGF', []).E01;
chk('payCollect：補休歸到 comp、不算缺勤天', [col.leaves.comp, col.deduct_days], [1, 0]);
const T2 = vm.runInContext('payLeaveTypes', sb)('SSLGF');
const rr = vm.runInContext('payCalcOne', sb)(DB.master[0], '2026-12', att0({ hours: 151, leaves: { comp: 1 } }), cfg, 8, T2);   // 12 月 31−8＝23 天＝184H
chk('補休抵不足（151＋1，倒扣 32 不是 33）、沒有扣款列', [it(rr, 'shortfall_hours').qty, rr.ded.some((x) => /comp/.test(x.item_key))], [32, false]);

console.log('\n══ 12) 到期折算：最後可休日所在月份 ══');
R = run('2027-03');
e1 = R.results.find((x) => x.emp_id === 'E01');
chk('2027-03 沒有到期的', it(e1, 'comp_expire'), undefined);
R = run('2027-04');
e1 = R.results.find((x) => x.emp_id === 'E01');
// rA 3H（4/10 到期）休掉 1 → 剩 2；rB 1H（4/19 到期）→ 4 月共 3H × 240
chk('2027-04：rA 剩 2＋rB 1＝3H × 240＝720', [it(e1, 'comp_expire').qty, it(e1, 'comp_expire').amount], [3, 720]);
chk('計時乙君不受影響', it(R.results.find((x) => x.emp_id === 'E02'), 'comp_expire'), undefined);

console.log('\n══ 13) 離職：主檔填離職日的那個月全部結清 ══');
DB.master[0].leave_date = '2027-03-15';
sb = ctx(DB, CLOCK);
R = run('2027-03');
e1 = R.results.find((x) => x.emp_id === 'E01');
chk('2027-03 離職：剩 3H 全部結清（標離職結清）', [it(e1, 'comp_expire').qty, it(e1, 'comp_expire').item_label], [3, '補休到期折算（離職結清）']);
DB.master[0].leave_date = '';

console.log('\n══ 14) payroll_leave_options／payMyPayslipFor_ 帶補休 ══');
sb = ctx(DB, CLOCK); sb.__TODAY = '2026-12-31';
vm.runInContext('todayTaipeiStr = function(){ return "2026-12-31"; };', sb);
const lo = vm.runInContext('handlePayrollLeaveOptions', sb)({ admin_key: 'x', store: 'SSLGF', ym: '2026-12' });
chk('值班核定頁：補休在假別裡、甲君剩 3H、乙君反灰', [lo.types.some((t) => t.name === '補休'), lo.quotas.E01.comp.balance_h, lo.quotas.E01.comp.blocked, lo.quotas.E02.comp.blocked],
    [true, 3, false, true]);
const slip = vm.runInContext('payMyPayslipFor_', sb)({ emp_id: 'E01', name: '甲君' }, 'SSLGF', '2026-10');
chk('薪資單回 comp（餘額 3、最早 2027-04-10）', [slip.comp.balance_h, slip.comp.earliest_expiry, slip.comp.history], [3, '2027-04-10', true]);
chk('假別額度清單不重複列補休', (slip.leave_quota || []).some((q) => q.name === '補休'), false);

console.log('\n══ 15) 假別表有資料時：沒補休列就補；補休列停用就不補 ══');
DB.leave_type = [{ code: 'personal', name: '事假', active: 'true', pay_ratio: 0, sort: 10 }];
sb = ctx(DB, CLOCK);
chk('表上只有事假 → 補上內建補休', vm.runInContext('payLeaveTypes', sb)('SSLGF').map((t) => t.name), ['事假', '補休']);
DB.leave_type.push({ code: 'comp', name: '補休', active: 'false', sort: 20 });
sb = ctx(DB, CLOCK);
chk('表上補休停用 → 尊重設定、不補', vm.runInContext('payLeaveTypes', sb)('SSLGF').map((t) => t.name), ['事假']);
DB.leave_type = [];

console.log('\n' + (fail ? `❌ ${fail} 項失敗` : `✅ 補休全部正確 (${pass}/${pass})`));
process.exit(fail ? 1 : 0);
