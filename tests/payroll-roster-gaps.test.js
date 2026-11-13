/**
 * 薪酬挑錯第 2 項補洞（名單）：
 *  (a) 月中離職、已停用、離職日在本月的人：跨店支援自動帶入照樣帶（跟計算名單同一個判斷）。
 *  (b) 在職天數 0 卻產生列的人 → 回應多帶 zero_ratio_with_data（emp_id、name、hours），payroll_calc 與 payroll_month 都帶，沒有就不帶；
 *      payroll.html 提醒區紅字。
 *  (c) not_in_payroll 看月結：這個月的月結（草稿或鎖定）已經有這個人的列 → 不列入提醒。
 *  (d) 損益估算端點的名單跟 payroll_calc 同一個判斷（在職，或已停用但離職日在這個月）。
 *  (e) payroll.html costAudit「主檔有公司負擔、但本月沒有結算結果」：整月不在職的人不列。
 *  (f) 在職天數 0、這個月是特休折算月（att.annual.payout_ym＝本月且有時數）→ 照修改前產生列。
 * 全部虛構同仁（只用代號），金額照規則手算寫死。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp, ptEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const STORES = [
  { code: 'SSLGF', name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' },
  { code: 'CF', name: '乙廚（虛構）', clock_ss_id: 'ck-cf', emp_prefix: '', active: 'true', support_group: '*' },
];
const fresh = (master, more) => Object.assign({
  master: master,
  holiday: [{ ym: '2026-10', red_days: 8, note: '', dates: '', store: '' }, { ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }],
  config: [], run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  store: STORES.map(x => Object.assign({}, x)),
}, more || {});
const clock = (over, cf) => ({
  SSLGF: Object.assign({ roster: [], approved: [], events: [], leave: [], requests: [] }, over || {}),
  CF: Object.assign({ roster: [], approved: [], events: [], leave: [], requests: [] }, cf || {}),
});
function env(data, clk, today) {
  const s = load({ data: data, clock: clk || clock(), today: today || '2026-11-10', props: { PNL_KEY: 'k' } });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __TODAY.slice(0, 7); };
    checkPnlKey_ = function () { return null; }; pnlEstimateSheetsReady_ = function () { return true; };`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const row = (res, id) => ((res && res.results) || []).find(x => String(x.emp_id) === id) || null;
const ids = (res) => ((res && res.results) || []).map(x => String(x.emp_id)).sort();
const money = (r) => r ? [r.gross, r.deduction, r.net] : null;
const lines = (r) => r ? [].concat(r.earn.map(i => ['+', i.item_key, i.qty, i.rate, i.amount]), r.ded.map(i => ['-', i.item_key, i.qty, i.rate, i.amount])) : null;
const amt = (r, key) => { const x = r ? [].concat(r.earn, r.ded).find(i => i.item_key === key) : null; return x ? x.amount : 0; };
const inRow = (ym, emp, o) => Object.assign({ ym: ym, emp_id: emp, store: ST, hours: 0, extra_ot: 0, deduct_days: 0, support: '[]', hours_manual: '' }, o || {});
const ap = (date, emp, h) => ({ date: date, emp_id: emp, name: 'x', periods: '09:00-17:00', approved_hours: h, status_text: '正常', manager_name: 'x', entered_at: date + 'T20:00:00+08:00' });

const E01 = () => ftEmp({ emp_id: 'E01', name: '代號甲', health_ins: 470 });
const E10 = (o) => ftEmp(Object.assign({ emp_id: 'E10', name: '代號戊', health_ins: 470, pension: 1800, hire_date: '2026-11-05' }, o || {}));
const E01_OCT = [39000, 470, 38530];   // 整月在職、184 小時：30000＋3000＋3000＋3000＝39000；健保 470；實付 38530

/* ══ (a) 月中離職、已停用：跨店支援自動帶入照樣帶 ══ */
{
  // a-1 純函式 paySupportAutoCore_
  const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
  const a = GS.indexOf('function payR0'), b = GS.indexOf('/* ═══════════════════ Handlers');
  const e = {};
  new Function('exports', 'function pad2(n){return ("0"+n).slice(-2)}\n' + GS.slice(a, b) + '\nexports.core=paySupportAutoCore_;')(e);
  const coreStores = [{ code: 'SSLGF', clock_ss_id: '', support_group: 'sxl' }, { code: 'CF', clock_ss_id: 'ck-cf', support_group: '*' }];
  const X = (acct, id) => ({ emp_no: '1', pay_store: 'SSLGF', acct_store: acct, emp_id: id, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
  const AP = (h) => ({ approved_hours: h, status_text: '正常', periods: '', manager_name: '' });
  const APPROVED = { CF: { '2026-11-03': { C1: AP(8) }, '2026-11-04': { C1: AP(8) }, '2026-12-02': { C1: AP(8) } } };
  const d = (m) => ({ stores: coreStores, master: [m], xmap: [X('SSLGF', 'A'), X('CF', 'C1')],
    approvedMap: c => APPROVED[c] || {}, events: () => [], tsDate: s => String(s).slice(0, 10), today: '2026-12-31', days: false });
  const hrs = (auto) => auto && auto.byEmp.A ? auto.byEmp.A.stores.map(x => [x.code, x.hours]) : null;
  eq(hrs(e.core('2026-11', 'SSLGF', d({ emp_id: 'A', store: 'SSLGF', active: 'true', leave_date: '2026-11-08' }))), [['CF', 16]], 'a1 主檔在職、離職日 11/08：11 月帶入乙廚 16 小時');
  eq(hrs(e.core('2026-11', 'SSLGF', d({ emp_id: 'A', store: 'SSLGF', active: 'false', leave_date: '2026-11-08' }))), [['CF', 16]], 'a1 已停用、離職日 11/08：11 月照樣帶入乙廚 16 小時');
  eq(hrs(e.core('2026-12', 'SSLGF', d({ emp_id: 'A', store: 'SSLGF', active: 'false', leave_date: '2026-11-08' }))), null, 'a1 已停用、離職日 11/08：12 月不帶入（其他月份行為不變）');
  eq(hrs(e.core('2026-11', 'SSLGF', d({ emp_id: 'A', store: 'SSLGF', active: 'false', leave_date: '' }))), null, 'a1 已停用、沒有離職日：11 月不帶入（行為不變）');
  eq(hrs(e.core('2026-12', 'SSLGF', d({ emp_id: 'A', store: 'SSLGF', active: 'true', leave_date: '' }))), [['CF', 8]], 'a1 在職者 12 月帶入 8 小時（行為不變）');

  // a-2 整條 handlePayrollCalc：計時 P20（時薪 200、11/08 離職），本店手動工時 40 小時，乙廚核定 11/03、11/04 各 8 小時
  //     實付＝本店 40×200＝8000 ＋ 支援 16×200＝3200 ＝ 11200
  const P20 = (o) => ptEmp(Object.assign({ emp_id: 'P20', name: '代號子', hire_date: '2026-09-01', leave_date: '2026-11-08' }, o || {}));
  const xmap = [
    { emp_no: 'D20', pay_store: 'SSLGF', acct_store: 'SSLGF', emp_id: 'P20', not_support: 'false', state: 'confirmed', synced_at: '2026-11-05T09:00:00+08:00' },
    { emp_no: 'D20', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'C20', not_support: 'false', state: 'confirmed', synced_at: '2026-11-05T09:00:00+08:00' }];
  const run = (m) => {
    const s = env(fresh([E01(), m], { xmap: xmap, input: [inRow('2026-11', 'P20', { hours: 40 })] }),
      clock({}, { approved: [ap('2026-11-03', 'C20', 8), ap('2026-11-04', 'C20', 8)] }));
    const calc = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
    const mon = s.post('handlePayrollMonth', { ym: '2026-11', store: ST });
    return { calc: calc, mon: mon };
  };
  const A = run(P20()), B = run(P20({ active: 'false' }));
  const rA = row(A.calc, 'P20'), rB = row(B.calc, 'P20');
  eq([rA && rA.support_hours, rA && rA.net], [16, 11200], 'a2 主檔在職：支援 16 小時、實付 11200（40×200＋16×200）');
  eq([rB && rB.support_hours, rB && rB.net], [16, 11200], 'a2 已停用、離職日在本月：支援 16 小時、實付 11200');
  eq({ m: money(rB), l: lines(rB) }, { m: money(rA), l: lines(rA) }, 'a2 兩種主檔狀態：金額與逐項明細完全相同');
  const supOf = (m) => (((m.inputs || {}).P20 || {}).support || []).map(x => [x.code, x.hours]);
  eq(supOf(B.mon), supOf(A.mon), 'a3 payroll_month 工時分頁帶出的支援列，兩種主檔狀態相同');
  eq(supOf(B.mon), [['CF', 16]], 'a3 已停用、離職日在本月：工時分頁有乙廚 16 小時');
  eq(row(B.mon.run, 'P20') && row(B.mon.run, 'P20').net, 11200, 'a3 payroll_month 帶出的月結：P20 實付 11200');
}

/* ══ (b) 在職天數 0 卻有列 → zero_ratio_with_data ══ */
{
  const s = env(fresh([E01(), E10()], { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'E10', { hours: 16 })] }));
  const WANT = [{ emp_id: 'E10', name: '代號戊', hours: 16 }];
  const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(money(row(r, 'E10')), [3840, 2270, 1570], 'b1 E10（11/05 到職）10 月有 16 小時 → 照舊算：應發 3840、扣款 2270、實付 1570');
  eq(r.zero_ratio_with_data, WANT, 'b2 payroll_calc 帶 zero_ratio_with_data＝E10 16 小時（只有 emp_id、name、hours）');
  const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq(m.zero_ratio_with_data, WANT, 'b3 payroll_month 也帶同一份 zero_ratio_with_data');
  const dry = s.post('handlePayrollCalc', { ym: '2026-10', store: ST, dry_run: true });
  eq(dry.zero_ratio_with_data, WANT, 'b3 唯讀試算也帶');
  eq(money(row(r, 'E01')), E01_OCT, 'b4 整月在職 E01 數字不變');
  // 鎖定後再開：照樣帶
  s.__DATA.run.forEach(x => { if (x.ym === '2026-10') x.status = 'final'; });
  eq(s.post('handlePayrollMonth', { ym: '2026-10', store: ST }).zero_ratio_with_data, WANT, 'b5 鎖定後 payroll_month 照樣帶');

  // 只有獎金（沒有時數）：hours 0
  const s2 = env(fresh([E01(), E10()], { input: [inRow('2026-10', 'E01', { hours: 184 })],
    bonus: [{ ym: '2026-10', store: ST, emp_id: 'E10', bonus_type: 'sales', label: '業績', amount: 1000 }] }));
  const r2 = s2.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(r2.zero_ratio_with_data, [{ emp_id: 'E10', name: '代號戊', hours: 0 }], 'b6 只有獎金 1000：列入，hours 0');

  // 沒有這種人 → 不帶
  const s3 = env(fresh([E01(), E10()], { input: [inRow('2026-10', 'E01', { hours: 184 })] }));
  const r3 = s3.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const m3 = s3.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq(['zero_ratio_with_data' in r3, 'zero_ratio_with_data' in m3], [false, false], 'b7 沒有這種人：payroll_calc、payroll_month 都不帶 zero_ratio_with_data');
  // 月中到職（在職天數不是 0）不列：E10 在 11 月（11/05 到職）
  const s4 = env(fresh([E01(), E10()], { input: [inRow('2026-11', 'E10', { hours: 16 })] }));
  const r4 = s4.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq([!!row(r4, 'E10'), 'zero_ratio_with_data' in r4], [true, false], 'b8 月中到職的人（在職天數不是 0）有列、不列入提醒');
}

/* ══ (c) not_in_payroll 看月結 ══ */
{
  const E07 = (o) => ftEmp(Object.assign({ emp_id: 'E07', name: '代號辛', health_ins: 470 }, o || {}));
  const mk = () => env(fresh([E01(), E07()], { input: [inRow('2026-10', 'E01', { hours: 184 })] }),
    clock({ approved: [ap('2026-10-03', 'E07', 8), ap('2026-10-04', 'E07', 4)] }));
  const deact = (s) => s.__DATA.master.forEach(x => { if (x.emp_id === 'E07') x.active = 'false'; });
  // c-1 已鎖定：當時在職有領薪，之後被停用（沒填離職日）
  {
    const s = mk();
    const calc = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
    eq(ids(calc), ['E01', 'E07'], 'c0 10 月試算：E01、E07 都有列');
    s.__DATA.run.forEach(x => { if (x.ym === '2026-10') x.status = 'final'; });
    deact(s);
    const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
    eq([m.run.status, ids(m.run)], ['final', ['E01', 'E07']], 'c1 鎖定月份的月結仍有 E07');
    eq('not_in_payroll' in m, false, 'c1 已鎖定月份、月結裡有 E07 的列 → 不誤報「沒有算進薪資」');
  }
  // c-2 草稿：月結裡還有他的列 → 不列；重算後列不見了 → 列入
  {
    const s = mk();
    s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
    deact(s);
    const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
    eq([m.run.status, ids(m.run), 'not_in_payroll' in m], ['draft', ['E01', 'E07'], false], 'c2 草稿月結裡還有 E07 的列 → 不列入提醒');
    const WANT = [{ emp_id: 'E07', name: '代號辛', hours: 12 }];
    const re = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
    eq([ids(re), re.not_in_payroll], [['E01'], WANT], 'c3 重算後 E07 沒有列 → payroll_calc 列入 not_in_payroll（12 小時）');
    eq(s.post('handlePayrollMonth', { ym: '2026-10', store: ST }).not_in_payroll, WANT, 'c3 之後 payroll_month 也列入');
  }
}

/* ══ (d) 損益估算端點：名單跟 payroll_calc 同一個判斷 ══ */
{
  // 今天 2026-11-10、估 10 月（整月）。計時 P01 在職 10 月核定 5 天×8＝40 小時 → 8000；
  // 計時 P09 已停用、離職日 10/20，10 月核定 10 天×8＝80 小時 → 16000。計時薪資合計 24000。
  const P01 = ptEmp({ emp_id: 'P01', name: '代號丙', hire_date: '2026-09-01' });
  const P09 = (o) => ptEmp(Object.assign({ emp_id: 'P09', name: '代號己', hire_date: '2026-09-01', leave_date: '2026-10-20' }, o || {}));
  const P08 = ptEmp({ emp_id: 'P08', name: '代號庚', hire_date: '2026-09-01', leave_date: '', active: 'false' });   // 停用、沒有離職日 → 不進名單
  const days = (emp, from, n) => Array.from({ length: n }, (_, i) => ap('2026-10-' + String(from + i).padStart(2, '0'), emp, 8));
  const est = (p9) => {
    const s = env(fresh([P01, p9, P08]), clock({ approved: days('P01', 1, 5).concat(days('P09', 5, 10), days('P08', 1, 3)) }));
    return s.call('handlePnlLaborEstimate_', { key: 'k', ym: '2026-10', store: ST });
  };
  const act = est(P09()), off = est(P09({ active: 'false' }));
  eq([act.ok, act.rows && act.rows.pt], [true, 24000], 'd1 P09 主檔在職：計時薪資估算 24000（8000＋16000）');
  eq([off.ok, off.rows && off.rows.pt], [true, 24000], 'd2 P09 已停用、離職日 10/20：估算照樣含他，24000');
  eq(JSON.stringify(off.rows) === JSON.stringify(act.rows) && off.total === act.total, true, 'd3 兩種主檔狀態，估算各列與合計完全相同');
  // 對照 payroll_calc：同一份資料的計時實付合計也是 24000
  const s = env(fresh([P01, P09({ active: 'false' }), P08]), clock({ approved: days('P01', 1, 5).concat(days('P09', 5, 10), days('P08', 1, 3)) }));
  const calc = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq([ids(calc), calc.results.reduce((t, r) => t + r.net, 0)], [['P01', 'P09'], 24000], 'd4 payroll_calc 同一份資料：P01、P09 兩列，實付合計 24000');
}

/* ══ (f) 在職天數 0、本月是特休折算月 → 照修改前產生列 ══ */
{
  // E11：到職 2024-11-01（滿 1 年未滿 2 年 → 特休 7 天＝56 小時），週年期 2025-11-01～2026-10-31 → 折算月 2026-10。
  // 主檔還在職、離職日 2026-09-30 → 10 月在職天數 0，沒有時數、沒有加扣項。
  // 折算＝(30000＋3000＋3000＋3000)÷30÷8＝162.5 × 56＝9100；健保 470；實付 8630。
  const E11 = ftEmp({ emp_id: 'E11', name: '代號丑', health_ins: 470, hire_date: '2024-11-01', leave_date: '2026-09-30' });
  const s = env(fresh([E01(), E11], { input: [inRow('2026-10', 'E01', { hours: 184 })] }));
  const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const r11 = row(r, 'E11');
  eq(!!r11, true, 'f1 在職天數 0、10 月是特休折算月 → 有列（那筆折算不消失）');
  eq([r11 && r11.ratio, amt(r11, 'annual_payout')], [0, 9100], 'f2 在職比例 0、特休未休折算 56 小時×162.5＝9100');
  eq(money(r11), [9100, 470, 8630], 'f3 應發 9100、扣款 470、實付 8630');
  eq(r.zero_ratio_with_data, [{ emp_id: 'E11', name: '代號丑', hours: 0 }], 'f4 這個人也列入在職天數 0 的提醒');
  // 不是折算月（11 月）、沒有時數 → 沒有列
  const nov = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq(row(nov, 'E11'), null, 'f5 11 月不是折算月、沒有時數 → 沒有列');
  eq(money(row(r, 'E01')), E01_OCT, 'f6 整月在職 E01 數字不變');
}

/* ══ 前端 payroll.html ══ */
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const fnSrc = (name) => {
  const m = new RegExp('\\n(async function|function) ' + name + '\\(').exec(HTML);
  if (!m) throw new Error('找不到 ' + name);
  const start = m.index + 1, rest = HTML.slice(start + 10);
  const nx = /\n(async function |function |\/\* ═|\/\* 計時加給|let |const )/.exec(rest);
  return HTML.slice(start, start + 10 + nx.index);
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/* (b) 提醒區紅字 */
{
  const render = (zero) => {
    const box = { innerHTML: '' };
    const ctx = { console, $: () => box, ROSTER_MISS: [], SAME_NAME: [], RESULTS: [], OT_PERIOD: {}, OT_MONTH_CAP: 54, NOT_IN_PAY: [], ZERO_RATIO: zero, LEAVE_MM: [],
      esc: esc, r2: (v) => Math.round(v * 100) / 100 };
    vm.createContext(ctx);
    vm.runInContext(fnSrc('renderOtInfo') + '\nrenderOtInfo({});', ctx);
    return box.innerHTML;
  };
  eq(/let ZERO_RATIO=\[\]/.test(HTML), true, 'h0 payroll.html 有 ZERO_RATIO 這個清單變數');
  eq(/ZERO_RATIO=r\.zero_ratio_with_data\|\|\[\]/.test(fnSrc('loadMonth')), true, 'h0 loadMonth 讀 payroll_month 的 zero_ratio_with_data');
  eq(/ZERO_RATIO=r\.zero_ratio_with_data\|\|\[\]/.test(fnSrc('doCalc')), true, 'h0 doCalc 讀 payroll_calc 的 zero_ratio_with_data');
  eq(/ZERO_RATIO=r\.zero_ratio_with_data\|\|\[\]/.test(fnSrc('autoCalc')), true, 'h0 autoCalc 讀 payroll_calc 的 zero_ratio_with_data');
  const html = render([{ emp_id: 'E10', name: '代號戊<b>', hours: 16 }, { emp_id: 'E12', name: '代號寅', hours: 12.5 }]);
  eq(html.indexOf('本月在職天數是 0（到職日或離職日不在這個月），卻有 16 小時／加扣項，請確認主檔的到職日、離職日') >= 0, true, 'h1 列出 E10：本月在職天數是 0…卻有 16 小時／加扣項，請確認主檔的到職日、離職日');
  eq(html.indexOf('卻有 12.5 小時／加扣項，請確認主檔的到職日、離職日') >= 0, true, 'h1 列出 E12：12.5 小時');
  eq((html.match(/<li class="bad">/g) || []).length, 2, 'h2 兩列都是紅字（li class="bad"）');
  eq([html.indexOf('代號戊&lt;b&gt;') >= 0, html.indexOf('代號戊<b>') >= 0], [true, false], 'h3 姓名經過 esc()');
  eq(render([]), '', 'h4 沒有這種人、也沒有其他提醒 → 提醒區空白');
}
/* (e) costAudit：整月不在職的人不列 */
{
  const audit = (MASTER, RESULTS) => {
    const box = { innerHTML: '', style: {} };
    const ctx = { console, $: () => box, toast: () => {}, MASTER: MASTER, RESULTS: RESULTS, STORE: 'SSLGF', ym: () => '2026-10',
      costTotals: () => ({ reduceBy: {}, reduceFT: 0, reducePT: 0 }), costRows: () => [], esc: esc,
      n: (v) => Number(v) || 0, nf: (v) => String(Math.round(Number(v) || 0)) };
    vm.createContext(ctx);
    vm.runInContext(fnSrc('costAudit') + '\ncostAudit();', ctx);
    return box.innerHTML;
  };
  const M = (id, name, o) => Object.assign({ emp_id: id, name: name, active: 'true', hire_date: '2021-01-01', leave_date: '', co_labor: 1000, co_pension: 500, co_health: 500 }, o || {});
  const RES = [{ emp_id: 'E01', name: '代號甲', total_hours: 184, gross: 39000, deduction: 470, net: 38530, earn: [], ded: [] }];
  const html = audit([M('E01', '代號甲'), M('E02', '代號乙'), M('E10', '代號戊', { hire_date: '2026-11-05' }), M('E13', '代號卯', { hire_date: '2026-10-31' })], RES);
  eq(html.indexOf('主檔有公司負擔、但本月沒有結算結果') >= 0, true, 'e1 整月在職卻沒有結算結果的人（E02）照樣提醒');
  eq(html.indexOf('代號乙 2000') >= 0, true, 'e1 提醒列出 E02 與公司負擔 2000');
  eq(html.indexOf('代號卯 2000') >= 0, true, 'e2 月底當天到職（10/31）的人算本月在職，照樣提醒');
  eq(html.indexOf('代號戊') >= 0, false, 'e3 到職日在月底之後（11/05）的人不列');
  const html2 = audit([M('E01', '代號甲'), M('E10', '代號戊', { hire_date: '2026-11-05' }), M('E14', '代號辰', { leave_date: '2026-09-30' })], RES);
  eq(html2.indexOf('主檔有公司負擔、但本月沒有結算結果') >= 0, false, 'e4 只有整月不在職的人（到職在月底之後／離職在月初之前）沒有結算結果 → 不出這條提醒');
}

console.log(`\n小計：通過 ${pass}、失敗 ${fail}`);
process.exit(fail ? 1 : 0);
