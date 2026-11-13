/**
 * 薪酬挑錯第 2 項：不在職的人不進薪資；月中離職的人停用後，離職當月那一列還在（Eason 2026-11-11 確認）。
 *  規則：
 *   ① 薪資名單＝主檔「在職」，或「已停用但離職日（leave_date）落在這個月」。
 *   ② 這個月在職天數 0（payRatio＝0），而且沒有任何時數、支援、請假、自訂加扣、獎金 → 不產生列。
 *      在職天數 0 卻有時數（或上述任何一項）→ 照舊計算。
 *   ③ 主檔已停用、離職日不在這個月、這個月卻有核定時數或手動工時 → 不進薪資，回應多帶 not_in_payroll
 *      （只有 emp_id、name、hours）；payroll_calc 與 payroll_month 都帶；沒有這種人就不帶這個欄位。
 *   ④ 整月在職的人數字不變。
 *  全部虛構同仁（只用代號），金額照規則手算寫死。
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
const fresh = (master, more) => Object.assign({
  master: master,
  holiday: [{ ym: '2026-10', red_days: 8, note: '', dates: '', store: '' }, { ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }],
  config: [], run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  store: [{ code: 'SSLGF', name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
}, more || {});
const clock = (over) => ({ SSLGF: Object.assign({ roster: [], approved: [], events: [], leave: [], requests: [] }, over || {}) });
function env(data, clk) {
  const s = load({ data: data, clock: clk || clock(), today: '2026-11-10' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __TODAY.slice(0, 7); };`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const row = (res, id) => (res.results || []).find(x => String(x.emp_id) === id) || null;
const ids = (res) => (res.results || []).map(x => String(x.emp_id)).sort();
const money = (r) => r ? [r.gross, r.deduction, r.net] : null;
const lines = (r) => r ? [].concat(r.earn.map(i => ['+', i.item_key, i.qty, i.rate, i.amount]), r.ded.map(i => ['-', i.item_key, i.qty, i.rate, i.amount])) : null;
const inRow = (ym, emp, o) => Object.assign({ ym: ym, emp_id: emp, store: ST, hours: 0, extra_ot: 0, deduct_days: 0, support: '[]', hours_manual: '' }, o || {});

// 虛構主檔
const E01 = () => ftEmp({ emp_id: 'E01', name: '代號甲', health_ins: 470 });                                            // 整月在職
const E09 = (o) => ftEmp(Object.assign({ emp_id: 'E09', name: '代號丁', health_ins: 470, leave_date: '2026-10-20' }, o || {}));   // 10/20 離職
const E10 = (o) => ftEmp(Object.assign({ emp_id: 'E10', name: '代號戊', health_ins: 470, pension: 1800, hire_date: '2026-11-05' }, o || {}));   // 11/05 才到職
const P09 = (o) => ptEmp(Object.assign({ emp_id: 'P09', name: '代號己', hire_date: '2026-09-01', leave_date: '2026-10-20' }, o || {}));   // 計時，10/20 離職
// 整月在職 E01、10 月 184 小時（＝基本工時 (31−8)×8）：底薪 30000＋全勤 3000＋職能 3000＋夜間 3000＝39000；健保 470；實付 38530
const E01_OCT = [39000, 470, 38530];

/* ── A. 還沒到職的人（11/05 到職）不出現在 10 月 ── */
{
  const s = env(fresh([E01(), E10()], { input: [inRow('2026-10', 'E01', { hours: 184 })] }));
  const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(r.ok, true, 'A0 10 月試算成功');
  eq(row(r, 'E10'), null, 'A1 11/05 才到職、10 月沒有任何時數與加扣項 → 10 月沒有這一列');
  eq(ids(r), ['E01'], 'A1 10 月薪資只有整月在職的 E01');
  eq(money(row(r, 'E01')), E01_OCT, 'A2 整月在職 E01：應發 39000、扣款 470、實付 38530');
  eq(s.__DATA.run.map(x => String(x.emp_id)), ['E01'], 'A3 寫進月結表的也只有 E01');
  eq(s.__DATA.item.filter(x => String(x.emp_id) === 'E10').length, 0, 'A3 明細表沒有 E10 的列');
  eq('not_in_payroll' in r, false, 'A4 沒有「停用卻有時數」的人 → 回應不帶 not_in_payroll');
  const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq('not_in_payroll' in m, false, 'A4 payroll_month 也不帶 not_in_payroll');
  eq((m.run.results || []).map(x => String(x.emp_id)), ['E01'], 'A5 payroll_month 帶出的月結只有 E01');
}

/* ── B. 月中離職（10/20）：主檔還在職 → 10 月有列；11 月（整月不在職、沒有時數）沒有列 ── */
let E09_ACTIVE_OCT = null;
{
  const s = env(fresh([E01(), E09()], { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'E09', { hours: 120 })] }));
  const oct = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const r9 = row(oct, 'E09');
  eq(!!r9, true, 'B1 E09（10/20 離職、主檔在職）10 月有列');
  eq(r9 && Math.round(r9.ratio * 30), 20, 'B1 E09 10 月在職 20 天（金額比例 20/30）');
  eq(r9 && r9.total_hours, 120, 'B1 E09 10 月核定時數 120');
  E09_ACTIVE_OCT = { money: money(r9), lines: lines(r9), ratio: r9 && r9.ratio };
  eq(money(row(oct, 'E01')), E01_OCT, 'B2 整月在職 E01 數字不變');
  const nov = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq(nov.ok, true, 'B3 11 月試算成功');
  eq(row(nov, 'E09'), null, 'B3 E09 上個月已離職、主檔還沒停用、11 月沒有時數 → 11 月沒有這一列');
  eq(ids(nov), ['E01'], 'B3 11 月薪資只有 E01');
}

/* ── C. 月中離職（10/20）先停用再算 10 月：那一列還在，數字和停用前逐項相同；沒有提醒清單 ── */
{
  const s = env(fresh([E01(), E09({ active: 'false' })], { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'E09', { hours: 120 })] }));
  const oct = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const r9 = row(oct, 'E09');
  eq(!!r9, true, 'C1 E09 已停用、離職日 10/20 落在 10 月 → 10 月有列');
  eq({ money: money(r9), lines: lines(r9), ratio: r9 && r9.ratio }, E09_ACTIVE_OCT, 'C1 金額、比例、逐項明細和「主檔還在職時」完全相同');
  eq(money(row(oct, 'E01')), E01_OCT, 'C2 整月在職 E01 數字不變');
  eq('not_in_payroll' in oct, false, 'C3 離職日在本月的人不列入 not_in_payroll');
  const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq((m.run.results || []).map(x => String(x.emp_id)).sort(), ['E01', 'E09'], 'C4 payroll_month 帶出的月結有 E01、E09');
  eq('not_in_payroll' in m, false, 'C4 payroll_month 不帶 not_in_payroll');
  // 同一份資料算 11 月：已停用、離職日不在 11 月、11 月沒有時數 → 沒有列、也不提醒
  const nov = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq([ids(nov), 'not_in_payroll' in nov], [['E01'], false], 'C5 11 月：E09 沒有列、不提醒');
}

/* ── D. 計時同仁月中離職、已停用：離職當月照時數發（100 小時 × 時薪 200＝20000） ── */
{
  const s = env(fresh([E01(), P09({ active: 'false' })], { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'P09', { hours: 100 })] }));
  const oct = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(money(row(oct, 'P09')), [20000, 0, 20000], 'D1 計時 P09（已停用、10/20 離職）10 月：100H×200＝20000');
}

/* ── E. 已停用、離職日不在本月、本月卻有時數 → 不進薪資，列入 not_in_payroll ── */
{
  const master = [E01(),
    ftEmp({ emp_id: 'E08', name: '代號庚', active: 'false', leave_date: '' }),            // 停用、沒填離職日、10 月手動工時 50
    ftEmp({ emp_id: 'E07', name: '代號辛', active: 'false', leave_date: '2026-09-30' }),  // 停用、離職日在 9 月、10 月打卡核定 12
    ftEmp({ emp_id: 'E06', name: '代號壬', active: 'false', leave_date: '' }),            // 停用、10 月沒有時數 → 不提醒
    ftEmp({ emp_id: 'X01', name: '代號癸', active: 'false', leave_date: '', store: 'CF' })];   // 別店停用的人不列
  const clk = clock({ approved: [
    { date: '2026-10-03', emp_id: 'E07', name: '代號辛', periods: '09:00-17:00', approved_hours: 8, status_text: '正常', manager_name: 'x', entered_at: '2026-10-03T20:00:00+08:00' },
    { date: '2026-10-04', emp_id: 'E07', name: '代號辛', periods: '09:00-13:00', approved_hours: 4, status_text: '正常', manager_name: 'x', entered_at: '2026-10-04T20:00:00+08:00' }] });
  const s = env(fresh(master, { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'E08', { hours: 50 })] }), clk);
  const WANT = [{ emp_id: 'E07', name: '代號辛', hours: 12 }, { emp_id: 'E08', name: '代號庚', hours: 50 }];
  const byId = (a) => (a || []).slice().sort((x, y) => String(x.emp_id) < String(y.emp_id) ? -1 : 1);
  const oct = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(ids(oct), ['E01'], 'E1 停用且離職日不在本月的人不進薪資');
  eq(byId(oct.not_in_payroll), WANT, 'E2 payroll_calc 的 not_in_payroll＝E07 12 小時、E08 50 小時（只有 emp_id、name、hours）');
  const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq(byId(m.not_in_payroll), WANT, 'E3 payroll_month 也帶出同一份 not_in_payroll');
  eq(money(row(oct, 'E01')), E01_OCT, 'E4 整月在職 E01 數字不變');
  // 11 月沒有人有時數 → 不帶
  const nov = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq('not_in_payroll' in nov, false, 'E5 11 月沒有停用卻有時數的人 → 不帶 not_in_payroll');
}

/* ── F. 在職天數 0 但有時數／支援／請假／自訂加扣／獎金 → 照舊產生列 ── */
{
  const one = (label, data, want) => {
    const s = env(fresh([E01(), E10()], Object.assign({}, data, { input: [inRow('2026-10', 'E01', { hours: 184 })].concat(data.input || []) })));
    const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
    eq(!!row(r, 'E10'), true, label + ' → 有列');
    eq(row(r, 'E10') && row(r, 'E10').ratio, 0, label + '：在職比例 0');
    if (want) eq(money(row(r, 'E10')), want, label + '：應發／扣款／實付');
    eq(money(row(r, 'E01')), E01_OCT, label + '：整月在職 E01 數字不變');
  };
  // 16 小時 × 加班費率 240＝3840（在職天數 0 → 基本工時 0、底薪與津貼 0）；健保 470＋退休金 1800＝2270；實付 1570
  one('F1 只有時數 16H', { input: [inRow('2026-10', 'E10', { hours: 16 })] }, [3840, 2270, 1570]);
  one('F2 只有獎金 1000', { bonus: [{ ym: '2026-10', store: ST, emp_id: 'E10', bonus_type: 'sales', label: '業績', amount: 1000 }] }, [1000, 2270, -1270]);
  one('F3 只有自訂加薪 500', { input: [inRow('2026-10', 'E10', { custom_add_label: '補發', custom_add_amt: 500 })] }, [500, 2270, -1770]);
  one('F4 只有自訂扣款 300', { input: [inRow('2026-10', 'E10', { custom_ded_label: '代扣', custom_ded_amt: 300 })] }, [0, 2570, -2570]);
  one('F5 只有支援 8H', { input: [inRow('2026-10', 'E10', { support: JSON.stringify([{ store: '乙店', hours: 8, rate: 210, amount: '' }]) })] });
  one('F6 只有請假（事假 8H）', { input: [inRow('2026-10', 'E10', { personal_h: 8 })] });
  one('F7 只有手動明細（補發 800）', { item: [{ ym: '2026-10', emp_id: 'E10', item_type: 'earning', item_key: 'manual_x', item_label: '補發', qty: '', rate: '', amount: 800, source: 'manual', memo: '', store: ST }] }, [800, 2270, -1470]);
  // 重算時用未存檔的影本帶時數（override）也算有時數
  const s = env(fresh([E01(), E10()], { input: [inRow('2026-10', 'E01', { hours: 184 })] }));
  const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST, inputs: { E10: { hours: 16 } } });
  eq(money(row(r, 'E10')), [3840, 2270, 1570], 'F8 未存檔影本帶 16H → 有列，應發 3840、扣款 2270、實付 1570');
}

/* ── G. 全店都是整月在職：回應欄位與改版前相同（不多 not_in_payroll） ── */
{
  const s = env(fresh([E01(), ptEmp({ emp_id: 'P01', name: '代號丙', hire_date: '2026-09-01' })], { input: [inRow('2026-10', 'E01', { hours: 184 }), inRow('2026-10', 'P01', { hours: 100 })] }));
  const r = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(Object.keys(r).sort(), ['collected', 'config', 'ok', 'red_days', 'results', 'store', 'ym'], 'G1 payroll_calc 回應欄位不變');
  eq([money(row(r, 'E01')), money(row(r, 'P01'))], [E01_OCT, [20000, 0, 20000]], 'G2 E01 38530、P01 100H×200＝20000');
}

/* ── H. 前端 payroll.html：提醒區紅字列出「停用卻有時數」的人 ── */
{
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  const fnSrc = (name) => {
    const m = new RegExp('\\n(async function|function) ' + name + '\\(').exec(HTML);
    if (!m) throw new Error('找不到 ' + name);
    const start = m.index + 1, rest = HTML.slice(start + 10);
    const nx = /\n(async function |function |\/\* ═|let |const )/.exec(rest);
    return HTML.slice(start, start + 10 + nx.index);
  };
  const render = (notIn) => {
    const box = { innerHTML: '' };
    const ctx = { console, $: () => box, ROSTER_MISS: [], SAME_NAME: [], RESULTS: [], OT_PERIOD: {}, OT_MONTH_CAP: 54, NOT_IN_PAY: notIn, ZERO_RATIO: [], LEAVE_MM: [],   // LEAVE_MM：1113 紅燈 a1 起多讀的清單；ZERO_RATIO：renderOtInfo 2026-11-11 起多讀的清單（補洞 b），這裡給空的
      esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      r2: (v) => Math.round(v * 100) / 100 };
    vm.createContext(ctx);
    vm.runInContext(fnSrc('renderOtInfo') + '\nrenderOtInfo({});', ctx);
    return box.innerHTML;
  };
  eq(/let NOT_IN_PAY=\[\]/.test(HTML), true, 'H0 payroll.html 有 NOT_IN_PAY 這個清單變數');
  eq(/NOT_IN_PAY=r\.not_in_payroll\|\|\[\]/.test(fnSrc('loadMonth')), true, 'H0 loadMonth 讀 payroll_month 的 not_in_payroll');
  eq(/NOT_IN_PAY=r\.not_in_payroll\|\|\[\]/.test(fnSrc('doCalc')), true, 'H0 doCalc 讀 payroll_calc 的 not_in_payroll');
  const html = render([{ emp_id: 'E08', name: '代號庚<b>', hours: 50 }, { emp_id: 'E07', name: '代號辛', hours: 12.5 }]);
  eq(html.indexOf('本月有 50 小時，但主檔已取消在職、離職日沒填或早於這個月，沒有算進薪資。這個月還有上班的話，請到員工設定填正確的離職日') >= 0, true, 'H1 列出 E08：本月有 50 小時…沒有算進薪資。月中離職請到員工設定填離職日');
  eq(html.indexOf('本月有 12.5 小時，但主檔已取消在職、離職日沒填或早於這個月，沒有算進薪資。這個月還有上班的話，請到員工設定填正確的離職日') >= 0, true, 'H1 列出 E07：本月有 12.5 小時…');
  eq((html.match(/class="bad"/g) || []).length >= 2, true, 'H2 兩列都是紅字（class="bad"）');
  eq([html.indexOf('代號庚&lt;b&gt;') >= 0, html.indexOf('代號庚<b>') >= 0], [true, false], 'H3 姓名經過 esc()');
  eq(render([]), '', 'H4 沒有這種人、也沒有其他提醒 → 提醒區空白');
}

console.log(`\n小計：通過 ${pass}、失敗 ${fail}`);
process.exit(fail ? 1 : 0);
