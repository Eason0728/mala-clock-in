// 薪酬計算驗收測試（2026-11-10 QA 驗收時加）：正常 3 組＋異常 3 組。
// 跑法：node tests/qa-payroll-20261110.test.js（run-all.js 會自動帶到）
//   ok(name, fn)    ＝ 目前程式的規則下該成立的行為；失敗會讓本檔非零結束。
//   KNOWN(name, fn) ＝ 驗收時查到的壞資料漏洞，寫的是「該有的結果」，目前會失敗；只印出、不擋 run-all。
//                     修好後把 KNOWN 改成 ok。設 ADV_STRICT=1 時 KNOWN 失敗也非零結束。
// 跑的是 apps-script/Payroll.gs 本身（引擎切片＋ helpers/payroll-vm.js 的整條後端鏈），不另寫公式。
// 期望值全部照規則手算寫死（算式寫在各組註解），不從程式反推。
// 名字、金額一律假資料（不放任何同仁的真實薪資）；不含金鑰、試算表 ID；只在本機跑。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/payroll-vm.js');

/* ── 引擎切片（同 tests/engine-diff.js 的切法）── */
const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const E = {};
new Function('exports', "function pad2(n){return ('0'+n).slice(-2)}\n" +
  GS.slice(GS.indexOf('function payR0'), GS.indexOf('/* ═══════════════════ Handlers')) +
  '\nexports.payCalcOne=payCalcOne;exports.payLeaveTypes=payLeaveTypes;exports.payTenurePlus=payTenurePlus;')(E);
const LT = E.payLeaveTypes('');   // 內建假別表：事假 0、病假 0.5、天災假 0、特休 1

let nOk = 0, failed = 0, nKnownOpen = 0, nKnownFixed = 0;
const ok = (name, fn) => { try { fn(); nOk++; console.log('✓ ' + name); } catch (e) { failed++; console.log('✗ ' + name + '\n    ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); } };
const KNOWN = (name, fn) => {
  try { fn(); nKnownFixed++; console.log('✓ [KNOWN 已不成立，可改成 ok] ' + name); }
  catch (e) { nKnownOpen++; console.log('✗ [KNOWN 待處理] ' + name + '\n    ' + String(e.message || e).split('\n')[0]); }
};
const eq = (got, want, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), want, msg);

/* ── 假資料 ── */
const CFG = { daily_hours: 8, attend_deduct_per_day: 100, late_deduct: 'true', late_deduct_from: '', late_div_days: 30, late_div_hours: 8,
  attend_void_forget: 0, attend_deduct_basis: 'all', attend_forget_unit: 'punch', attend_void_late_min: 0, attend_void_early_min: 0,
  leave_div_days: 30, leave_div_hours: 8, sick_ratio: 0.5, pt_attend_min_hours: 100, pt_attend_plus: 10, pt_tenure_plus: 10, pt_tenure_months: 6, meal_min_hours: 6 };
// 正職甲：底薪 30000＋職能 3000＋夜間 3000＋全勤上限 3000；加班費率 240；勞保 758、健保 470、宿舍 2000
const FT = (o) => Object.assign({ emp_id: 'T01', name: '測試甲', is_full_time: true, base: 30000, skill_allow: 3000, night_allow: 3000, mgr_allow: 0, editor_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 758, health_ins: 470, group_ins: 0, pension: 0, dormitory: 2000, meal_allow: 80,
  hire_date: '2021-10-01', leave_date: '', active: true, store: 'SSLGF' }, o || {});
// 計時乙：時薪 210、2026-03-01 到職（9/1 滿 6 個月 → 10 月起有年資加給）、勞保 277
const PT = (o) => Object.assign({ emp_id: 'T02', name: '測試乙', is_full_time: false, base: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
  attend_cap: 0, ot_rate: 0, wage: 210, labor_ins: 277, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, meal_allow: 0,
  hire_date: '2026-03-01', leave_date: '', active: true, store: 'SSLGF' }, o || {});
const ATT = (o) => Object.assign({ hours: 0, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 0, deduct_days: 0, support: [],
  bonuses: [], annual: null, leave_usage: {}, leaves: {}, forget_punch: 0, forget_day: 0, late_min: 0, early_min: 0, attend_void: false,
  full_attend: false, work_days: 0, wage_override: 0, dorm_override: '', meal_on: false, holiday_h: 0 }, o || {});
const amt = (r, key) => [].concat(r.earn, r.ded).filter((x) => x.item_key === key).reduce((a, x) => a + x.amount, 0);
const has = (r, key) => [].concat(r.earn, r.ded).some((x) => x.item_key === key);
const tot = (r) => [r.gross, r.deduction, r.net];
const p2 = (n) => ('0' + n).slice(-2);
const NOV = []; for (let d = 1; d <= 30; d++) NOV.push('2026-11-' + p2(d));
// 2026-11 起的逐日資料（形狀同 payDailyFor_）：預設每天都是上班日
const daily = (dayH, schedOver, hol) => { const sched = {}; NOV.forEach((d) => { sched[d] = { t: 'W', s: 'A' }; }); Object.assign(sched, schedOver || {});
  const h = {}; (hol || []).forEach((d) => { h[d] = true; }); return { dates: NOV, sched: sched, day_h: dayH, day_leave: {}, hol: h, until: '2026-11-30', manual_sup_h: 0 }; };

/* ── 整條後端鏈（假試算表）── */
const STORES = [{ code: 'SSLGF', name: '光復', active: 'true', support_group: 'sxl', emp_prefix: '', has_clock: 'true', clock_ss_id: '' }];
const HOL = [{ ym: '2026-10', red_days: 11, dates: '2026-10-09, 2026-10-26', store: '' }, { ym: '2026-11', red_days: 9, dates: '', store: '' }];
const appr = (date, h, periods) => ({ date: date, emp_id: 'T01', name: '測試甲', periods: periods || '09:00-17:00', approved_hours: h, status_text: '正常', manager_name: '主管', entered_at: date + 'T21:00:00+08:00' });
const lv = (date, type, h) => ({ '日期': date, '姓名': '測試甲', '假別': type, '時數': h });
const rq = (date, h) => ({ kind: 'ot', status: 'approved', name: '測試甲', emp_id: 'T01', date: date, hours: h });
const clockOf = (o) => Object.assign({ roster: [{ emp_id: 'T01', name: '測試甲', active: 'true' }], approved: [], events: [], leave: [], requests: [] }, o || {});
function env(o) {
  o = o || {};
  const S = H.load({ today: o.today || '2026-12-05', data: Object.assign({ master: [FT()], holiday: HOL, store: STORES, run: [], item: [], audit: [], cost_snapshot: [] }, o.data || {}), clock: { SSLGF: clockOf(o.clock) } });
  vm.runInContext("CONFIG.ADMIN_KEY='K';", S);
  return S;
}
const calc = (S, ym, extra) => S.call('handlePayrollCalc', Object.assign({ admin_key: 'K', ym: ym, store: 'SSLGF', dry_run: true }, extra || {}));

console.log('━━ 正常 3 組 ━━');
ok('正常 1｜正職有加班＋跨店支援：10 月整月加總；同一人 11 月逐日（例假加發一日、時數不足不倒扣）', () => {
  // 2026-10：baseH＝(31−11)×8＝160；淨＝250＋(57＋12.5)−160＝159.5；加班費 159.5×240＝38280（支援併入、用自己的費率，沒有獨立的支援項）
  // 應發 30000＋38280＋3000＋3000＋3000＝77280；扣 758＋2000＋470＝3228；實付 74052
  const r = E.payCalcOne(FT(), '2026-10', ATT({ hours: 250, support: [{ store: '別店一', hours: 57, rate: 240, amount: '' }, { store: '別店二', hours: 12.5, rate: 240, amount: '' }] }), CFG, 11, LT);
  eq([r.base_hours, r.surplus_hours, r.ot_paid_hours, r.support_hours], [160, 159.5, 159.5, 69.5]);
  eq([amt(r, 'overtime'), amt(r, 'attend_bonus'), has(r, 'cross_store'), has(r, 'shortfall_hours')], [38280, 3000, false, false]);
  eq(tot(r), [77280, 3228, 74052]);
  // 2026-11：11/03 上班日 10H、11/08 例假 8H，整月只有 18H（baseH 168）。
  // 月工資 M＝30000＋3000＋3000＋0＋0＋3000＋伙食 2000＝41000；例假加發一日＝41000÷30＝1366.67→1367；11 月起沒有不足倒扣
  const n = E.payCalcOne(FT(), '2026-11', ATT({ hours: 18, daily: daily({ '2026-11-03': 10, '2026-11-08': 8 }, { '2026-11-08': { t: 'R' } }) }), CFG, 9, LT);
  eq([n.base_hours, amt(n, 'ot_rdo'), has(n, 'shortfall_hours'), has(n, 'overtime'), n.ot_info.ot_h], [168, 1367, false, false, 2]);
  eq(n.gross - amt(n, 'ot_w43'), 30000 + 1367 + 3000 + 3000 + 3000);   // 平日加班那一項的倍率另案確認，這裡不綁
  assert.ok(/^績效獎金/.test(n.earn.find((x) => x.item_key === 'attend_bonus').item_label), '11 月起全勤獎金改名績效獎金');
});
ok('正常 2｜正職有請假（10 月）：事假全額、病假半額、全勤每天扣 100、扣款時薪取整；天災假全額扣但不扣全勤；特休不扣', () => {
  // 正職丙：底薪 31000＋職能 2000＋全勤上限 3000 → 扣款時薪 36000÷30÷8＝150
  // 核定 136＋事假 16＋病假 8−160＝0 → 沒有加班也沒有不足；全勤 3000−3×100＝2700
  // 事假 16×150＝2400；病假 8×75＝600；應發 31000＋2700＋2000＝35700；扣 2400＋600＋758＋470＝4228；實付 31472
  const e = FT({ emp_id: 'T03', name: '測試丙', base: 31000, skill_allow: 2000, night_allow: 0, ot_rate: 220, dormitory: 0 });
  const r = E.payCalcOne(e, '2026-10', ATT({ hours: 136, personal_h: 16, sick_h: 8, leaves: { personal: 16, sick: 8 }, deduct_days: 3 }), CFG, 11, LT);
  eq([r.leave_rate, amt(r, 'personal_leave'), amt(r, 'sick_leave'), amt(r, 'attend_bonus'), has(r, 'overtime'), has(r, 'shortfall_hours')], [150, 2400, 600, 2700, false, false]);
  eq(tot(r), [35700, 4228, 31472]);
  // 天災假（整條鏈，從 leave 分頁進來）：正職甲扣款時薪 39000÷240＝162.5→163；8×163＝1304；全勤仍 3000
  const x = calc(env({ clock: { leave: [lv('2026-10-13', '天災假', 8)] } }), '2026-10').results[0];
  eq([amt(x, 'disaster_leave'), amt(x, 'attend_bonus')], [1304, 3000]);
  // 特休 8H：沒有扣款項，扣項只剩勞保＋宿舍＋健保
  const a = E.payCalcOne(FT(), '2026-10', ATT({ hours: 152, annual_h: 8, leaves: { annual: 8 } }), CFG, 11, LT);
  eq([has(a, 'annual_leave'), a.deduction], [false, 3228]);
});
ok('正常 3｜計時滿 6 個月：3/1 到職 9 月沒有、10 月起有年資加給；滿勤加給；跨店支援獨立加項；11 月光復照舊', () => {
  eq([E.payTenurePlus(PT(), '2026-09', CFG), E.payTenurePlus(PT(), '2026-10', CFG)], [0, 10]);
  // 2026-09：100×210＝21000
  eq(tot(E.payCalcOne(PT(), '2026-09', ATT({ hours: 100 }), CFG, 10, LT)), [21000, 277, 20723]);
  // 2026-10：96.5×(210＋10)＝21230；年資列 96.5×10＝965；基本列＝21230−965＝20265
  const r = E.payCalcOne(PT(), '2026-10', ATT({ hours: 96.5 }), CFG, 11, LT);
  eq([amt(r, 'hourly_wage'), amt(r, 'pt_tenure_plus'), has(r, 'pt_attend_plus')], [20265, 965, false]);
  eq(tot(r), [21230, 277, 20953]);
  // 勾滿勤＋120H＋缺勤 0：120×(210＋10＋10)＝27600；支援 20H×205＝4100 獨立一項
  const f = E.payCalcOne(PT(), '2026-10', ATT({ hours: 120, full_attend: true, support: [{ store: '別店一', hours: 20, rate: 205, amount: '' }] }), CFG, 11, LT);
  eq([amt(f, 'hourly_wage'), amt(f, 'pt_attend_plus'), amt(f, 'pt_tenure_plus'), amt(f, 'cross_store'), f.gross], [25200, 1200, 1200, 4100, 31700]);
  // 2026-11（光復、每天都沒超過 8H）：金額與 10 月相同
  eq(tot(E.payCalcOne(PT(), '2026-11', ATT({ hours: 96.5, daily: daily({}) }), CFG, 9, LT)), [21230, 277, 20953]);
});

console.log('━━ 異常 3 組 ━━');
ok('異常 1｜月中到職／離職與二月：baseH 用實際天數比例，金額 2026-10 起用在職天數÷30', () => {
  // 10/12 到職（在職 20 天）、核定 104H：baseH＝160×20÷31＝103.23；淨 0.77→0.77×240＝184.8→185
  // 底薪 30000×20÷30＝20000；全勤、職能、夜間各 2000；勞保 758×2/3＝505.33→505；宿舍 2000×2/3＝1333.33→1333；健保不折算 470
  const r = E.payCalcOne(FT({ hire_date: '2026-10-12' }), '2026-10', ATT({ hours: 104 }), CFG, 11, LT);
  eq([r.base_hours, amt(r, 'base_salary'), amt(r, 'overtime'), amt(r, 'attend_bonus'), amt(r, 'labor_ins'), amt(r, 'dormitory'), amt(r, 'health_ins')], [103.23, 20000, 185, 2000, 505, 1333, 470]);
  eq(tot(r), [26185, 2308, 23877]);
  // 2027-02 整月：不因為只有 28 天而折算
  eq([amt(E.payCalcOne(FT(), '2027-02', ATT({ hours: 160 }), CFG, 8, LT), 'base_salary')], [30000]);
  // 2026-02（改 30 天之前的月份）2/14 離職：baseH＝(28−8)×8×14÷28＝80；底薪 30000×14÷28＝15000
  const f = E.payCalcOne(FT({ leave_date: '2026-02-14' }), '2026-02', ATT({ hours: 80 }), CFG, 8, LT);
  eq([f.base_hours, amt(f, 'base_salary')], [80, 15000]);
});
ok('異常 2｜壞資料不當掉：字串型數字、欄位全空白、時數 0、時數 400', () => {
  const att = () => ATT({ hours: 170, sick_h: 8, leaves: { sick: 8 }, deduct_days: 1 });
  const a = E.payCalcOne(FT(), '2026-10', att(), CFG, 11, LT);
  const b = E.payCalcOne(FT({ base: '30000', skill_allow: '3000', night_allow: '3000', attend_cap: '3000', ot_rate: '240', labor_ins: '758', health_ins: '470', dormitory: '2000', is_full_time: 'true' }), '2026-10', att(), CFG, 11, LT);
  eq([b.earn, b.ded], JSON.parse(JSON.stringify([a.earn, a.ded])), '主檔金額是字串時要與數字版逐項相同');
  // 畫面送來的工時是字串（整條鏈會先轉數字）：170＋20−160＝30 → 30×240＝7200；全勤 3000−100＝2900
  const x = calc(env(), '2026-10', { inputs: { T01: { hours: '170', support: [{ store: '別店一', hours: '20', rate: '210', amount: '' }], deduct_days: '1' } } }).results[0];
  eq([x.ot_paid_hours, amt(x, 'overtime'), amt(x, 'attend_bonus')], [30, 7200, 2900]);
  // 金額欄與到職日全空白：全部當 0，不出現 NaN
  const z = E.payCalcOne(FT({ base: '', skill_allow: '', night_allow: '', attend_cap: '', ot_rate: '', labor_ins: '', health_ins: '', dormitory: '', meal_allow: '', hire_date: '' }), '2026-10', ATT({ hours: 170 }), CFG, 11, LT);
  eq(tot(z), [0, 0, 0]);
  // 時數 0：10 月正職倒扣 160×240＝38400，實付 39000−3228−38400＝−2628；計時 0 元、扣勞保 277
  const h0 = E.payCalcOne(FT(), '2026-10', ATT({ hours: 0 }), CFG, 11, LT);
  eq([amt(h0, 'shortfall_hours'), h0.net], [38400, -2628]);
  eq(tot(E.payCalcOne(PT(), '2026-10', ATT({ hours: 0 }), CFG, 11, LT)), [0, 277, -277]);
  // 時數 400：(400−160)×240＝57600，沒有上限；應發 39000＋57600＝96600
  const h400 = E.payCalcOne(FT(), '2026-10', ATT({ hours: 400 }), CFG, 11, LT);
  eq([h400.ot_paid_hours, amt(h400, 'overtime')].concat(tot(h400)), [240, 57600, 96600, 3228, 93372]);
});
ok('異常 3｜鎖定：補休帳為負不能鎖、剛好 0 可以鎖、鎖定後不能重算；跨月最後一天的跨夜班歸上班那天', () => {
  // 11 月：核准加班 2H、補休 8H → 帳 −6 → 擋下、狀態不變、不寫稽核
  let S = env({ clock: { approved: [appr('2026-11-03', 10, '09:00-19:00')], leave: [lv('2026-11-10', '補休', 8)], requests: [rq('2026-11-03', 2)] } });
  S.call('handlePayrollCalc', { admin_key: 'K', ym: '2026-11', store: 'SSLGF' });
  let f = S.call('handlePayrollFinalize', { admin_key: 'K', ym: '2026-11', lock: true, store: 'SSLGF', operator: 'QA' });
  eq([f.ok, f.error, S.__DATA.run[0].status, S.__DATA.audit.length], [false, 'comp_negative', 'draft', 0]);
  // 10 月：核准加班 8H、補休 8H → 帳 0 → 鎖得起來；鎖定後一般重算回 locked、帶 force 回 finalized
  S = env({ data: { run: [{ ym: '2026-10', emp_id: 'T01', store: 'SSLGF', status: 'draft', name: '測試甲' }] }, clock: { requests: [rq('2026-10-05', 8)], leave: [lv('2026-10-12', '補休', 8)] } });
  // 2026-11-09 起鎖定前會重算比對（stale_run）：草稿要先算過、數字一致才鎖得起來
  S.call('handlePayrollCalc', { admin_key: 'K', ym: '2026-10', store: 'SSLGF' });
  f = S.call('handlePayrollFinalize', { admin_key: 'K', ym: '2026-10', lock: true, store: 'SSLGF', operator: 'QA' });
  eq([f.ok, S.__DATA.run[0].status, S.__DATA.audit.map((a) => a.action)], [true, 'final', ['lock']]);
  eq([S.call('handlePayrollCalc', { admin_key: 'K', ym: '2026-10', store: 'SSLGF' }).error, S.call('handlePayrollCalc', { admin_key: 'K', ym: '2026-10', store: 'SSLGF', force: true }).error, S.__DATA.run[0].status], ['locked', 'finalized', 'final']);
  // 10/31 22:00 上班、11/01 01:00 下班，核定列記在 10/31：3H 全部算 10 月
  S = env({ clock: { approved: [appr('2026-10-31', 3, '22:00-01:00')], events: [{ ts: '2026-10-31T22:03:10+08:00', emp_id: 'T01', type: 'in', status: 'ok' }, { ts: '2026-11-01T01:07:20+08:00', emp_id: 'T01', type: 'out', status: 'ok' }] } });
  const o = S.call('payCollect', '2026-10', 6, 'SSLGF', []).T01, n = S.call('payCollect', '2026-11', 6, 'SSLGF', []).T01;
  eq([o.hours, o.forget_punch, n ? n.hours : 0], [3, 0, 0]);
});

console.log('━━ 驗收時查到的壞資料漏洞（2026-11-13 確認都已修好，改成 ok）━━');
ok('重算 10 月時，主檔裡 11/05 才到職的人不該出現在 10 月薪資（目前會列入，健保照扣，實付 −470）', () => {
  const S = env({ data: { master: [FT(), FT({ emp_id: 'T04', name: '測試丁', hire_date: '2026-11-05' })] } });
  const ids = calc(S, '2026-10').results.map((x) => x.emp_id + ':' + x.net);
  assert.ok(!ids.some((x) => /^T04:/.test(x)), '目前回傳＝' + ids.join('、'));
});
ok('參數「事假費率分母（天）」被存成 0 時，扣款不該變成無限大（比照年資門檻：0 當成沒設定、用預設 30 → 8×163＝1304）', () => {
  const r = E.payCalcOne(FT(), '2026-10', ATT({ hours: 152, personal_h: 8, leaves: { personal: 8 }, deduct_days: 1 }), Object.assign({}, CFG, { leave_div_days: 0 }), 11, LT);
  assert.strictEqual(amt(r, 'personal_leave'), 1304, '目前事假扣款＝' + amt(r, 'personal_leave') + '、實付＝' + r.net);
});
ok('已鎖定的月份不該還能「儲存工時」（目前照樣寫入；解鎖重算時會用到）', () => {
  const S = env({ data: { run: [{ ym: '2026-10', emp_id: 'T01', store: 'SSLGF', status: 'final', name: '測試甲' }] } });
  const r = S.call('handlePayrollInputSet', { admin_key: 'K', ym: '2026-10', store: 'SSLGF', inputs: { T01: { hours: 999 } } });
  assert.strictEqual(r.ok, false, '目前回傳 ok＝' + r.ok + '、寫入 ' + (S.__DATA.input || []).length + ' 列');
});

console.log('\n共 ' + (nOk + failed) + ' 組：通過 ' + nOk + '、失敗 ' + failed + '；等處理 ' + nKnownOpen + ' 件' + (nKnownFixed ? '（另有 ' + nKnownFixed + ' 件已不成立，可改成 ok）' : ''));
if (failed || (process.env.ADV_STRICT === '1' && nKnownOpen)) process.exit(1);
