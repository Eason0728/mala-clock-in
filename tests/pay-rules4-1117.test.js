/* 2026-11-17 Eason 三項更正（2026-11 薪資起）：
 * ①出差餐費：六個地點不給；其他地點那天固定 100（正職計時都給、不再另算餐費補助）；沒有申請單＝不給、列提醒
 * ②同品牌支援門市的遲到、早退、忘刷併進績效獎金（缺勤天數、歸零門檻、計時滿勤加給）
 * ③跨店請款（前端 costTotals）另在 tests/cost-basis.test.js
 * 全部虛構門市與同仁。 */
const fs = require('fs'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const P = fs.readFileSync(ROOT + '/apps-script/Payroll.gs', 'utf8');
const C = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const sb = { console, SpreadsheetApp: { flush: () => {}, getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => { const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
sb.__CLOCK = {}; sb.__TAB = {};
vm.runInContext(`payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};
  payRead=function(n){return (globalThis.__TAB[n]||[]).map(function(r){return Object.assign({},r);});};`, sb);
const call = (fn, ...a) => vm.runInContext(fn, sb)(...a);
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

// ───────── ① 出差地點判斷 ─────────
['總部辦公室', '新竹光復', '新竹金山', '台北六張犁', '台北瑞光', '台中美村', '墨竹亭 金山店', ' 鼎兆元總部 ', ''].forEach(function (x) {
  chk('不給餐費的地點：「' + x + '」', call('payTripNoMealPlace_', x), true);
});
['台北車站廠商', '高雄展場', '新竹竹北工廠'].forEach(function (x) { chk('其他地點：' + x, call('payTripNoMealPlace_', x), false); });
chk('申請單地點解析', call('payTripPlaceOf_', '地點：高雄展場；事由：看展'), '高雄展場');
chk('不是出差格式＝空', call('payTripPlaceOf_', '隨便寫'), '');

// ───────── ① payCollect ─────────
const CL = sb.__CLOCK;
CL.roster = [{ emp_id: 'E01', name: '測試一', active: true, key: 'k' }];
CL.events = [];
const ap = (d, h, st) => ({ date: d, name: '測試一', emp_id: 'E01', approved_hours: h, status_text: st || '正常', entered_at: 'x', manager_name: 'M' });
const lv = (d, h) => ({ '日期': d, '姓名': '測試一', '假別': '出差', '時數': h });
const rq = (d, place, status, emp) => ({ kind: 'trip', emp_id: emp || 'E01', date: d, status: status || 'approved', reason: '地點：' + place + '；事由：測試' });
function setMonth(ym) {
  const D = n => ym + '-' + ('0' + n).slice(-2);
  CL.approved = [ap(D(2), 8, '出差'), ap(D(3), 8, '出差'), ap(D(4), 8, '出差'), ap(D(5), 10), ap(D(6), 10), ap(D(9), 8), ap(D(10), 8, '出差')];
  CL.leave = [lv(D(2), 8), lv(D(3), 8), lv(D(4), 8), lv(D(5), 1.5), lv(D(6), 1.5), lv(D(10), 8)];
  CL.requests = [rq(D(2), '高雄展場'), rq(D(3), '新竹金山'), /* D4 沒有申請單 */ rq(D(5), '台北車站廠商'), rq(D(6), '台中美村'),
    rq(D(10), '高雄展場', 'rejected'), rq(D(10), '高雄展場', 'approved', 'E99')];
}
setMonth('2026-11');
let c = call('payCollect', '2026-11', 6, 'CF', [])['E01'];
// 11/2 其他地點整天＝出差餐費；11/3 六個地點＝不給；11/4 沒單＝不給＋提醒；
// 11/5 其他地點＋打卡 8.5H＝出差餐費（那天不再算餐費補助）；11/6 六個地點＋打卡 8.5H＝照舊算餐費補助；11/9 一般上班；11/10 申請被退回／別人的單＝沒單
chk('出差餐費天數（其他地點 11/2、11/5）', c.trip_meal_days, 2);
chk('餐費補助天數（11/6、11/9；11/5 改領出差餐費不重複）', c.work_days, 2);
chk('沒有申請單的出差日列提醒', c.trip_noform, ['2026-11-04', '2026-11-10']);
chk('暫存欄位不外露', [c._tripNo, c._trip], [undefined, undefined]);
setMonth('2026-10');
c = call('payCollect', '2026-10', 6, 'CF', [])['E01'];
chk('2026-10 以前照舊：沒有出差餐費欄位、餐費補助天數 3（10/5、10/6、10/9）', [c.trip_meal_days, c.trip_noform, c.abs_dates, c.work_days], [undefined, undefined, undefined, 3]);

// ───────── ① payCalcOne ─────────
const cfg = Object.assign({}, vm.runInContext('(function(){var o={};PAY_CONFIG_DEFAULT.forEach(function(d){o[d[0]]=d[1]});return o})()', sb));
const FT = { emp_id: 'A', store: 'SSLGF', is_full_time: true, base: 33000, night_allow: 3000, attend_cap: 3000, ot_rate: 240, meal_allow: 80, hire_date: '2019-01-01' };
const PT = { emp_id: 'B', store: 'SSLGF', is_full_time: false, wage: 200, hire_date: '2026-10-01' };
const run = (e, ym, att, cf) => call('payCalcOne', e, ym, Object.assign({ hours: 160, deduct_days: 0, late_min: 0, early_min: 0, support: [], bonuses: [], leave_usage: {} }, att), Object.assign({}, cfg, cf || {}), 4, []);
const it = (r, k) => { const x = [].concat(r.earn, r.ded).find(i => i.item_key === k); return x ? [x.qty, x.rate, x.amount] : null; };
chk('正職：出差餐費 2 天 × 100（不用勾餐費補助）', it(run(FT, '2026-11', { trip_meal_days: 2 }), 'trip_meal'), [2, 100, 200]);
chk('正職：有勾餐費補助時兩項並列', [it(run(FT, '2026-11', { trip_meal_days: 2, meal_on: true, work_days: 20 }), 'meal_sub'), it(run(FT, '2026-11', { trip_meal_days: 2, meal_on: true, work_days: 20 }), 'trip_meal')], [[20, 80, 1600], [2, 100, 200]]);
chk('計時也給', it(run(PT, '2026-11', { trip_meal_days: 1, hours: 50 }), 'trip_meal'), [1, 100, 100]);
chk('0 天不出現這一列', it(run(FT, '2026-11', { trip_meal_days: 0 }), 'trip_meal'), null);
chk('2026-10 不給（就算有欄位）', it(run(FT, '2026-10', { trip_meal_days: 2 }), 'trip_meal'), null);
{ const a = run(FT, '2026-11', {}), b = run(FT, '2026-11', { trip_meal_days: 2 });
  chk('實付只多 200', b.net - a.net, 200); }

// ───────── ② 支援門市併績效：core 帶日期 ─────────
const STORES = [{ code: 'SSLGF', clock_ss_id: '', support_group: 'sxl' }, { code: 'SSLHQ', clock_ss_id: 'ck-hq', support_group: 'sxl' },
  { code: 'MZTJS', clock_ss_id: 'ck-js', support_group: 'mzt' }];
const M = (id, st) => ({ emp_id: id, store: st, active: 'true' });
const X = (no, acct, id) => ({ emp_no: no, pay_store: 'SSLGF', acct_store: acct, emp_id: id, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
const AP = (h, st) => ({ approved_hours: h, status_text: st, periods: '', manager_name: '' });
const APPROVED = { SSLGF: {}, SSLHQ: {
  '2026-11-03': { H1: AP(8, '遲到6分') }, '2026-11-04': { H1: AP(8, '第一段下班無打卡') }, '2026-11-05': { H1: AP(8, '該段無打卡') },
  '2026-11-06': { H1: AP(8, '正常') }, '2026-11-07': { H1: AP(8, '主管認定不計遲到') }, '2026-11-08': { H1: AP(4, '早退12分') } },
  MZTJS: { '2026-11-03': { J1: AP(6, '遲到20分') } } };
const d = { stores: STORES, master: [M('A', 'SSLGF')], xmap: [X('1', 'SSLGF', 'A'), X('1', 'SSLHQ', 'H1'), X('1', 'MZTJS', 'J1')],
  approvedMap: c => APPROVED[c] || {}, events: () => [], tsDate: s => String(s).slice(0, 10), today: '2026-11-30', days: false };
const auto = call('paySupportAutoCore_', '2026-11', 'SSLGF', d);
const row = auto.byEmp.A.stores[0];
chk('支援門市列帶缺勤日（遲到 11/3、忘刷 11/4、整段沒打 11/5、早退 11/8；認定不計遲到不算）', row.abs_dates, ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-08']);
chk('忘刷日與張數', [row.forget_dates, row.forget_cards], [['2026-11-04', '2026-11-05'], 3]);
chk('跨品牌（金山）不帶入＝不併績效', auto.byEmp.A.stores.length, 1);

// payXsupPerf_：同一天本店已算過不重複
const perf = (cc, lo) => call('payXsupPerf_', auto.byEmp.A, cc, lo);
chk('小辛辣（每天倒扣）：本店沒缺勤 → 多 4 天、忘刷多 2 天 3 張', perf({ abs_dates: [], forget_dates: [] }, false), { deduct_days: 4, forget_day: 2, forget_punch: 3 });
chk('本店 11/3 也遲到、11/4 也忘刷 → 同一天不重複', perf({ abs_dates: ['2026-11-03', '2026-11-04'], forget_dates: ['2026-11-04'] }, false), { deduct_days: 2, forget_day: 1, forget_punch: 3 });
chk('非小辛辣（只算請假日）：缺勤天數不加，忘刷照併', perf({ abs_dates: [], forget_dates: [] }, true), { deduct_days: 0, forget_day: 2, forget_punch: 3 });
chk('沒有支援＝全 0', call('payXsupPerf_', undefined, {}, false), { deduct_days: 0, forget_day: 0, forget_punch: 0 });

// ───────── ② payCalcOne：績效 ─────────
const bonus = r => { const x = r.earn.find(i => i.item_key === 'attend_bonus'); return x ? [x.item_label, x.amount] : null; };
chk('小辛辣：本店 1 天＋支援門市 2 天 → 3000 − 300', bonus(run(FT, '2026-11', { deduct_days: 1, xsup_deduct_days: 2 })), ['績效獎金', 2700]);
chk('沒有支援欄位＝跟改版前一樣', bonus(run(FT, '2026-11', { deduct_days: 1 })), ['績效獎金', 2900]);
chk('2026-10 不併（照舊只看本店）', bonus(run(FT, '2026-10', { deduct_days: 1, xsup_deduct_days: 2 }))[1], 2900);
const CFE = Object.assign({}, FT, { store: 'CF' });
const cfCfg = { attend_void_forget: 3, attend_void_late_min: 11, attend_deduct_basis: 'leave' };
chk('非小辛辣：本店遲到 6 分＋支援門市 6 分＝12 分 → 整筆歸零', bonus(run(CFE, '2026-11', { late_min: 6, xsup_late_min: 6 }, cfCfg)), ['績效獎金（遲到累計12分）', 0]);
chk('非小辛辣：只有本店 6 分 → 不歸零', bonus(run(CFE, '2026-11', { late_min: 6 }, cfCfg))[1], 3000);
chk('非小辛辣：本店忘刷 1 天＋支援門市 2 天 → 歸零', bonus(run(CFE, '2026-11', { forget_day: 1, xsup_forget_day: 2 }, cfCfg)), ['績效獎金（忘刷3天）', 0]);
chk('非小辛辣：支援門市忘刷 2 天 → 不歸零', bonus(run(CFE, '2026-11', { xsup_forget_day: 2 }, cfCfg))[1], 3000);
// 遲到扣款不可因為併績效而重複加
{ const r = run(FT, '2026-11', { late_min: 6, xsup_late_min: 10 });
  chk('遲到扣款仍是 6＋10＝16 分（不重複加）', it(r, 'late_deduct')[0], 16); }
// 計時滿勤加給（小辛辣）：支援門市有缺勤就不符合
const PT2 = Object.assign({}, PT, { hire_date: '2026-09-01' });
const plus = r => !!r.earn.find(i => i.item_key === 'pt_attend_plus');
chk('計時滿勤加給：本店＋支援都沒缺勤 → 有', plus(run(PT2, '2026-11', { hours: 120, full_attend: true })), true);
chk('計時滿勤加給：支援門市缺勤 1 天 → 沒有', plus(run(PT2, '2026-11', { hours: 120, full_attend: true, xsup_deduct_days: 1 })), false);

// ───────── ③ 跨店請款時薪（前端 supClaimRate＝後端 pnlSupClaimRate_）─────────
{
  const H = fs.readFileSync(ROOT + '/payroll.html', 'utf8');
  const i = H.indexOf('const SUP_CLAIM_FROM='), j = H.indexOf('function costTotals(){');
  const fr = {}; vm.createContext(fr);
  vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x;};' + H.slice(i, j) + ';this.f=supClaimRate;', fr);
  const front = fr.f, back = vm.runInContext('pnlSupClaimRate_', sb);
  const mFT = { base: 33000, skill_allow: 1000, night_allow: 3000, mgr_allow: 0, editor_allow: 0, attend_cap: 3000 };
  const rFT = { is_full_time: true, earn: [] };
  const rPT = { is_full_time: false, earn: [{ item_key: 'hourly_wage', rate: 200 }, { item_key: 'pt_attend_plus', rate: 10 }, { item_key: 'pt_tenure_plus', rate: 10 }, { item_key: 'holiday_double', rate: 220 }] };
  chk('正職：(33,000＋1,000＋3,000＋3,000＋伙食費 2,000)÷240＝175', [front('2026-11', rFT, mFT, {}), back('2026-11', rFT, mFT, {})], [175, 175]);
  chk('正職：伙食費參數改 0 也照用', front('2026-11', rFT, mFT, { ot_meal_fixed: 0 }), 40000 / 240);
  chk('計時：200＋滿勤 10＋年資 10＝220（國定假日加倍那列不算）', [front('2026-11', rPT, {}, {}), back('2026-11', rPT, {}, {})], [220, 220]);
  chk('2026-10 以前回 null（照舊兩段式）', [front('2026-10', rFT, mFT, {}), back('2026-10', rFT, mFT, {})], [null, null]);
}

console.log(`\n${p} 過、${f} 失敗`);
if (f) process.exit(1);
