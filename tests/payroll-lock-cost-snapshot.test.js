/**
 * 薪資挑錯第 7 項（Eason 2026-11-13 選 A）：月份鎖定後，成本分類頁／儀表板／集團總覽要讀鎖定當下的快照。
 *  修前：公司負擔（勞保／健保／退休金／負責人／團險）、年終提列、跨店請款都用「目前的主檔與參數」即時算，
 *        鎖定後改主檔，已鎖定月份的這些數字會跟著變；損益端點 pnlPayroll 讀快照不會變 → 同一個月兩邊不一致。
 *  規則：
 *   ① 鎖定時快照要涵蓋成本分類頁／儀表板／集團總覽用到的全部欄位（逐人公司負擔、年終提列、差額費率、跨店請款明細）。
 *   ② 已鎖定且有快照 → 三個畫面讀快照，改主檔、改參數都不變。
 *   ③ 未鎖定月份 → 照舊即時算（改主檔會變）。
 *   ④ 已鎖定但沒有快照的舊月份 → 照舊即時算，並標「即時值（鎖定時沒有快照）」。
 *   ⑤ 不動任何 run 列金額（gross／deduction／net）；損益端點回的欄位不變（不外流逐人明細）。
 *   ⑥ 解鎖 → 快照清掉；再鎖定 → 用當下的主檔重寫。
 *  全部虛構同仁（只用代號），期望值照規則手算寫死：
 *   E01 正職整月在職：主檔公司負擔 勞保 2000、健保 1500、退休金 1800；年終 2 個月；差額費率 300。
 *     年終提列 ＝（本薪 30000＋職能 3000＋夜間 3000＋店長 0＋全勤上限 3000）× 2 ÷ 12 ＝ 6500。
 *     跨店支援（手填）乙店 10H × 250，金額欄空白；差額費率 300 只用在「基本工時 − 本店核定」的缺口上。
 *   參數：負責人勞健保 500、團險 300。
 *   公司負擔合計 ＝ 2000＋1500＋1800＋500＋300 ＝ 6100。
 *   改主檔：勞保 9999、健保 8888、退休金 7777、年終 5 個月、差額費率 999；改參數：負責人 4444、團險 3333。
 *     即時值：公司負擔 ＝ 9999＋8888＋7777＋4444＋3333 ＝ 34441；年終 ＝ 39000 × 5 ÷ 12 ＝ 16250。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const E01 = () => ftEmp({ emp_id: 'E01', name: '代號甲', health_ins: 470,
  co_labor: 2000, co_health: 1500, co_pension: 1800, yearend_months: 2, gap_rate: 300 });
const SUP = JSON.stringify([{ store: '乙店', hours: 10, rate: 250, amount: '' }]);
const inRow = (ym, o) => Object.assign({ ym: ym, emp_id: 'E01', store: ST, hours: 0, extra_ot: 0, deduct_days: 0, support: SUP, hours_manual: '' }, o || {});
const fresh = () => ({
  master: [E01()],
  holiday: [{ ym: '2026-08', red_days: 10, note: '', dates: '', store: '' }, { ym: '2026-09', red_days: 8, note: '', dates: '', store: '' },
            { ym: '2026-10', red_days: 8, note: '', dates: '', store: '' }],
  config: [{ key: 'co_owner', value: 500, note: '', store: '' }, { key: 'co_group', value: 300, note: '', store: ST }],
  run: [], item: [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  // 8 月 31−10＝21 天×8＝168H；9 月 30−8＝22 天×8＝176H；10 月 31−8＝23 天×8＝184H。都比基本工時少 4H，讓差額費率派得上用場。
  input: [inRow('2026-08', { hours: 164 }), inRow('2026-09', { hours: 172 }), inRow('2026-10', { hours: 180 })],
  store: [{ code: ST, name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
});
function env() {
  const s = load({ data: fresh(), clock: { SSLGF: { roster: [], approved: [], events: [], leave: [], requests: [] } }, today: '2026-11-10',
    props: { PNL_KEY: 'pnl-key' } });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __TODAY.slice(0, 7); };
    payStoreList = function () { return __DATA.store; };
    CacheService = { getScriptCache: function () { return { get: function () { return null; }, put: function () {}, remove: function () {} }; } };
    // 快照分頁的唯讀讀取（正式機走 getSheetByName、分頁不存在回空）換成記憶體假表
    payCostSnapRows_ = function () { return (__DATA.cost_snapshot || []).map(function (r) { return Object.assign({}, r); }); };`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const runMoney = (s, ym) => (s.__DATA.run || []).filter(x => String(x.ym) === ym).map(x => [Number(x.gross), Number(x.deduction), Number(x.net), String(x.status)]);
const changeMaster = (s) => {
  s.__DATA.master.forEach(x => { x.co_labor = 9999; x.co_health = 8888; x.co_pension = 7777; x.yearend_months = 5; x.gap_rate = 999; });
  s.__DATA.config = [{ key: 'co_owner', value: 4444, note: '', store: '' }, { key: 'co_group', value: 3333, note: '', store: ST }];
};

// ── 前端：從 payroll.html 原文抽 allocGapHours／costTotals／costRows／costStable，不另寫一份 ──
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const a0 = HTML.indexOf('const COST_REDUCE_EXTRA'), b0 = HTML.indexOf('function renderCost(){', a0);
const escLine = (HTML.match(/const esc=s=>[\s\S]*?;\n/) || [''])[0];
const SRC = escLine + HTML.slice(a0, b0);
/** 用 payroll_month 的回應建一個前端畫面（等同使用者切到這個月） */
function front(m) {
  const ctx = { console, MASTER: m.master, CFG: m.config, ATT: m.inputs, RESULTS: (m.run || {}).results || [],
    STATUS: (m.run || {}).status || 'draft', COST_SNAP: (m.run || {}).cost_snap || null,
    n: v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; }, r2: v => Math.round(v * 100) / 100,
    nf: v => String(Math.round(v)) };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\nglobalThis.__f={costTotals:costTotals,costRows:costRows,costStable:costStable,costDetail:costDetail};', ctx);
  ctx.rows = () => JSON.parse(JSON.stringify(ctx.__f.costRows(ctx.__f.costTotals())));
  // 等同 toggleLock() 鎖定時送的那份：costStable() ＋ detail
  ctx.snap = () => { const g = ctx.__f.costTotals(); return JSON.parse(JSON.stringify(Object.assign(ctx.__f.costStable(g), { detail: ctx.__f.costDetail(g) }))); };
  return ctx;
}
const val = (rows, label) => { const r = rows.find(x => String(x[0]).indexOf(label) === 0 || String(x[1]).indexOf(label) === 0); return r ? (r.length === 3 ? r[2] : r[1]) : null; };
const pick = (rows) => ({
  co_labor: val(rows, '公司負擔勞保'), co_health: val(rows, '公司負擔健保'), co_pension: val(rows, '公司負擔退休金'),
  co_owner: val(rows, '負責人勞健保'), co_group: val(rows, '團險'), yearend: val(rows, '年終獎金提列／正職'),
  sup: rows.filter(x => String(x[0]).indexOf('→') > 0).map(x => [x[0], x[1]]), supTotal: val(rows, '請款小計'),
  total: val(rows, '人事總成本'), live: rows.some(x => String(x[1] || x[0]).indexOf('即時值（鎖定時沒有快照）') >= 0) });
const LIVE_NOTE = '即時值（鎖定時沒有快照）';

/* ── A. 10 月：鎖定（帶快照）→ 改主檔與參數 → 成本分類頁數字不變 ── */
const s = env();
eq(s.post('handlePayrollCalc', { ym: '2026-10', store: ST }).ok, true, 'A0 10 月試算成功');
const m0 = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
const F0 = front(m0), before = pick(F0.rows());
eq([before.co_labor, before.co_health, before.co_pension, before.co_owner, before.co_group], [2000, 1500, 1800, 500, 300],
  'A1 鎖定前成本分類：公司負擔 勞保 2000／健保 1500／退休金 1800／負責人 500／團險 300');
eq(before.yearend, 6500, 'A2 鎖定前年終提列 6500');
eq(before.supTotal, 4 * 300 + 6 * 250, 'A3 鎖定前跨店請款：缺口 4H×300＋6H×250＝2700');
eq(before.live, false, 'A4 草稿月份不標「即時值」');
const snap = F0.snap();
eq(!!(snap.detail && snap.detail.emp && snap.detail.sup), true, 'A5 快照帶逐人明細（detail.emp）與跨店請款明細（detail.sup）');
eq(snap.detail && snap.detail.emp, [{ emp_id: 'E01', ft: true, ratio: 1, co_labor: 2000, co_health: 1500, co_pension: 1800, yearend_months: 2, yearend: 6500, gap_rate: 300 }],
  'A6 逐人快照：E01 勞保 2000、健保 1500、退休金 1800、年終 2 個月＝6500、差額費率 300');
const runBefore = runMoney(s, '2026-10');
const f = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA', cost_snapshot: snap });
eq(f.ok, true, 'A7 鎖定成功');
eq(!!f.cost_snap, true, 'A8 鎖定回應帶回存好的快照（前端不用重整就能改讀快照）');
eq(runMoney(s, '2026-10').map(x => x.slice(0, 3)), runBefore.map(x => x.slice(0, 3)), 'A9 鎖定不動 run 列金額');
const trend0 = s.post('handlePayrollTrend', { ym: '2026-10', store: ST, months: 3 });
const group0 = s.post('handlePayrollGroup', { ym: '2026-10' });
changeMaster(s);
const m1 = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
eq((m1.run || {}).status, 'final', 'A10 10 月仍是已鎖定');
eq(!!(m1.run && m1.run.cost_snap), true, 'A11 payroll_month 對已鎖定月份回 run.cost_snap');
const after = pick(front(m1).rows());
eq(after, before, 'A12 改主檔（勞保／健保／退休金／年終月數／差額費率）與參數（負責人／團險）後，已鎖定月份成本分類逐列不變');
eq(runMoney(s, '2026-10'), runBefore.map(x => x.slice(0, 3).concat(['final'])), 'A13 改主檔後 run 列 gross／deduction／net 不動');

/* ── B. 儀表板／集團總覽：已鎖定有快照的月份讀快照 ── */
const trend1 = s.post('handlePayrollTrend', { ym: '2026-10', store: ST, months: 3 });
const t10 = (t) => (t.months || []).find(x => x.ym === '2026-10') || {};
eq(t10(trend0).company - t10(trend0).ins_self, 6100, 'B1 儀表板鎖定當下公司負擔＝6100');
eq([t10(trend1).company, t10(trend1).total_cost, t10(trend1).salary_cost], [t10(trend0).company, t10(trend0).total_cost, t10(trend0).salary_cost],
  'B2 改主檔後儀表板 10 月公司負擔／人事總成本／薪資費用不變');
eq(t10(trend1).cost_src, 'snapshot', 'B3 儀表板 10 月標示讀快照（cost_src＝snapshot）');
const group1 = s.post('handlePayrollGroup', { ym: '2026-10' });
const g10 = (g) => (g.rows || []).find(x => x.store === ST) || {};
eq([g10(group1).company, g10(group1).total_cost], [g10(group0).company, g10(group0).total_cost], 'B4 改主檔後集團總覽 10 月公司負擔／人事總成本不變');
eq(g10(group1).cost_src, 'snapshot', 'B5 集團總覽 10 月標示讀快照');
eq([group1.sum.company, group1.sum.total_cost], [group0.sum.company, group0.sum.total_cost], 'B6 集團總覽合計不變');

/* ── C. 未鎖定月份（9 月草稿）：照舊即時算，改主檔會變 ── */
{
  const s2 = env();
  s2.post('handlePayrollCalc', { ym: '2026-09', store: ST });
  const p0 = pick(front(s2.post('handlePayrollMonth', { ym: '2026-09', store: ST })).rows());
  const tr0 = t10({ months: s2.post('handlePayrollTrend', { ym: '2026-09', store: ST, months: 1 }).months.map(x => Object.assign(x, { ym: '2026-10' })) });
  changeMaster(s2);
  const m = s2.post('handlePayrollMonth', { ym: '2026-09', store: ST });
  eq(!!(m.run && m.run.cost_snap), false, 'C1 草稿月份不回 cost_snap');
  const p1 = pick(front(m).rows());
  eq([p0.co_labor, p1.co_labor, p1.co_owner, p1.co_group, p1.yearend], [2000, 9999, 4444, 3333, 16250], 'C2 9 月草稿改主檔後成本分類跟著變（勞保 9999、負責人 4444、團險 3333、年終 16250）');
  eq(p1.supTotal, 4 * 999 + 6 * 250, 'C3 9 月草稿跨店請款用新差額費率：4H×999＋6H×250＝5496');
  eq(p1.live, false, 'C4 草稿月份不標「即時值」');
  const tr1 = s2.post('handlePayrollTrend', { ym: '2026-09', store: ST, months: 1 }).months[0];
  eq(tr1.company - tr1.ins_self, 34441, 'C5 9 月草稿儀表板公司負擔改用新主檔＝34441');
  eq(tr1.cost_src, undefined, 'C6 草稿月份儀表板回應沒有 cost_src（形狀不變）');
  eq(tr0.company - tr0.ins_self, 6100, 'C7 （對照）改主檔前 9 月公司負擔 6100');
  const gr = s2.post('handlePayrollGroup', { ym: '2026-09' }).rows.find(x => x.store === ST);
  eq([gr.company - gr.ins_self, gr.cost_src], [34441, undefined], 'C8 9 月草稿集團總覽公司負擔 34441、沒有 cost_src');
}

/* ── D. 已鎖定但沒有快照的舊月份（8 月）：即時值＋標記 ── */
{
  const s3 = env();
  s3.post('handlePayrollCalc', { ym: '2026-08', store: ST });
  eq(s3.post('handlePayrollFinalize', { ym: '2026-08', store: ST, lock: true, operator: 'QA' }).ok, true, 'D0 8 月鎖定（沒帶快照＝本功能上線前鎖的月份）');
  changeMaster(s3);
  const m = s3.post('handlePayrollMonth', { ym: '2026-08', store: ST });
  eq([(m.run || {}).status, !!(m.run && m.run.cost_snap)], ['final', false], 'D1 8 月已鎖定、沒有快照');
  const p = pick(front(m).rows());
  eq([p.co_labor, p.yearend, p.live], [9999, 16250, true], 'D2 成本分類回即時值（勞保 9999、年終 16250），並標「' + LIVE_NOTE + '」');
  const tr = s3.post('handlePayrollTrend', { ym: '2026-08', store: ST, months: 1 }).months[0];
  eq([tr.company - tr.ins_self, tr.cost_src], [34441, 'live'], 'D3 儀表板 8 月即時值 34441，cost_src＝live（畫面標即時值）');
  const gr = s3.post('handlePayrollGroup', { ym: '2026-08' }).rows.find(x => x.store === ST);
  eq([gr.company - gr.ins_self, gr.cost_src], [34441, 'live'], 'D4 集團總覽 8 月即時值 34441，cost_src＝live');
  eq((s3.__DATA.cost_snapshot || []).length, 0, 'D5 不回填舊月份快照');
}

/* ── E. 解鎖 → 快照清掉、回即時；再鎖定 → 用當下主檔重寫 ── */
{
  const u = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: false, reason: '測試解鎖', operator: 'QA' });
  eq(u.ok, true, 'E1 解鎖成功');
  const m = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  eq([(m.run || {}).status, !!(m.run && m.run.cost_snap)], ['draft', false], 'E2 解鎖後是草稿、沒有快照');
  const p = pick(front(m).rows());
  eq([p.co_labor, p.yearend, p.live], [9999, 16250, false], 'E3 解鎖後成本分類照草稿即時算（新主檔）、不標即時值');
  s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  const m2 = s.post('handlePayrollMonth', { ym: '2026-10', store: ST });
  const f2 = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA', cost_snapshot: front(m2).snap() });
  eq(f2.ok, true, 'E4 再鎖定成功');
  // 鎖完之後再把主檔改回去，快照應該是「再鎖定當下」的 9999 那組
  s.__DATA.master.forEach(x => { x.co_labor = 1; x.yearend_months = 1; });
  const p2 = pick(front(s.post('handlePayrollMonth', { ym: '2026-10', store: ST })).rows());
  eq([p2.co_labor, p2.co_owner, p2.yearend, p2.live], [9999, 4444, 16250, false], 'E5 再鎖定的快照是重寫後的值（勞保 9999、負責人 4444、年終 16250），之後改主檔不變');
  eq(s.__DATA.cost_snapshot.filter(x => x.ym === '2026-10').length, 1, 'E6 同月份快照只留一筆');
}

/* ── F. 損益端點與分頁欄位 ── */
{
  const cols = vm.runInContext('PAY_SHEETS.cost_snapshot', s);
  eq(cols.slice(0, 27), ['ym','store','base_ft','ot_ft','attend_ft','allow_ft','mgr','meal','other','pt',
    'bonus_sales','bonus_perf','bonus_proj','ins_ft_deduct','dorm_ft_deduct','ins_pt_deduct','dorm_pt_deduct',
    'co_labor','co_health','co_pension','co_owner','co_group','ins_self','yearend','support_json','total','updated_at'],
    'F1 快照分頁既有 27 欄順序不動');
  eq(cols.slice(27), ['detail_json'], 'F2 新欄位 detail_json 接在最後');
  const pnl = s.post('handlePnlPayroll_', { key: 'pnl-key', ym: '2026-10', store: ST });
  eq(pnl.ok, true, 'F3 損益端點照常讀得到');
  eq(Object.keys(pnl).sort(), ['ok', 'rows', 'store', 'support', 'total', 'ym'], 'F4 損益端點回應欄位不變（不外流逐人明細）');
  eq(pnl.rows.co_labor, 9999, 'F5 損益端點與成本分類頁同一份快照（勞保 9999）');
}

console.log('\n小計：通過 ' + pass + '、失敗 ' + fail);
process.exit(fail ? 1 : 0);
