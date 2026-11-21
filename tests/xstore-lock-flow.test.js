/* 跨店請款 r7（Codex 第四次）鎖月流程隨機對照：正式版（XFLOW_BASE，預設 1ab5655）vs 本版，同一份資料、同一串操作。
 * 流程：算草稿 → 隨機做一件事（什麼都不做／停用某人（離職日空白）／改離職日（月中或上個月）／清除本月手動工時／改指定金額／別家核定時數改了）
 *       → 一半重算、一半不重算 → 鎖月（畫面送同一份假快照）。
 * 檢查：(i) 正式版鎖得下去 → 本版也鎖得下去；(ii) 兩邊都鎖下去時，定案的薪資列（run，ot_info 去掉請款／加班單檢查鍵）與明細（item）逐列相同；
 *       (iii) 本版快照請款合計＝被定案草稿列各自存的 ot_info.xsup 加總；(iv) 快照裡每位同仁的請款逐筆＝他被定案那列草稿存的 xsup（同一次計算）。
 * 世界（假 Apps Script＋假試算表）沿用 election-day-emp.test.js 的 world()；全部虛構。XFLOW_N 可調（預設 2,000；驗收跑 10,000）。 */
'use strict';
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const N = parseInt(process.env.XFLOW_N || '2000', 10);   // run-all 用 2,000（約 15 秒）；上線前驗收跑 XFLOW_N=10000
const BASE = process.env.XFLOW_BASE || '1ab5655';
let p = 0, f = 0;
const chk = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w), ok = a === b; ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + a + (ok ? '' : ' ← 應為 ' + b)); };
const T = fs.readFileSync(path.join(__dirname, 'election-day-emp.test.js'), 'utf8');
const mod = { exports: {} };
new Function('require', 'module', '__dirname', T.slice(0, T.indexOf('const BASE_REF')).replace("'use strict';", '') + '\nmodule.exports = { world };')(require, mod, __dirname);
const world = mod.exports.world;
let baseSrc = null;
try { baseSrc = execFileSync('git', ['show', BASE + ':apps-script/Payroll.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) {}
if (!baseSrc) { console.log('✗ 讀不到基準 ' + BASE); console.log('\n❌ 鎖月流程對照：0 過、1 失敗'); process.exit(1); }

let seed = 7101122;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const q = (mx) => Math.round(rnd() * mx * 2) / 2;
const Wc = { t: 'W', s: 'A' }, Hc = { t: 'H' };
const AP = (h) => ({ approved_hours: h, status_text: '正常', periods: '', manager_name: '' });

function scenario() {
  const n = 1 + Math.floor(rnd() * 4), X = [], ap = {}, xmap = [], input = [];
  for (let i = 0; i < n; i++) {
    const ft = rnd() < 0.5, h = rnd() < 0.8 ? q(8) : 8 + q(3), ot = h > 8 && rnd() < 0.7 ? h - 8 : 0;
    const more = { cells: { '2026-11-10': pick([Wc, Hc]) }, hours: rnd() < 0.6 ? { '2026-11-10': q(8) } : {} };
    X.push(['x' + i, '假人' + i, ft, pick([Wc, Wc, Hc]), h, ot, more]);
    const emp = 'E' + (i + 1), acct = 'H' + (i + 1);
    let autoH = 0;
    if (rnd() < 0.6) {
      xmap.push({ emp_no: String(i + 1), pay_store: 'SSLGF', acct_store: 'SSLGF', emp_id: emp, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' },
                { emp_no: String(i + 1), pay_store: 'SSLGF', acct_store: 'SSLHQ', emp_id: acct, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
      ['2026-11-10', '2026-11-28'].forEach((d) => { if (rnd() < 0.6) { const hh = q(6); if (hh > 0) { ((ap[d] = ap[d] || {}))[acct] = AP(hh); autoH += hh; } } });
    }
    if (rnd() < 0.4) input.push({ ym: '2026-11', emp_id: emp, store: 'SSLGF', hours: 0, extra_ot: 0, deduct_days: 0,
      support: JSON.stringify([{ code: 'SSLHQ', store: '支援店', hours: Math.max(1, autoH || q(8)), rate: 200, amount: rnd() < 0.4 ? 1000 + Math.floor(rnd() * 3000) : '', keep: true, auto_h: autoH }]), hours_manual: '' });
  }
  return { X, ap, xmap, input, hol: rnd() < 0.3 ? '2026-11-10' : '' };
}
function mkW(sc, gs) {
  const w = world({ only: [], extra: sc.X, hol: sc.hol, gs });
  w.DB.store.push({ code: 'SSLHQ', name: '支援店', clock_ss_id: 'ck-hq', active: 'true', support_group: 'sxl' });
  w.DB.xmap = JSON.parse(JSON.stringify(sc.xmap)); w.DB.input = JSON.parse(JSON.stringify(sc.input));
  w.sb.__AP = { SSLHQ: JSON.parse(JSON.stringify(sc.ap)) };
  w.F('(function(){ payXsupData_ = function(withDays){ return { xmap: payRead("xmap"), stores: payRead("store"), master: payRead("master"), approvedMap: function(c){ return globalThis.__AP[c] || {}; }, events: function(){ return []; }, tsDate: function(s){ return String(s).slice(0,10); }, today: "2026-12-01", days: !!withDays }; }; })')();
  return w;
}
const FREE = ['xr', 'xclaim', 'cross_ot', 'ot_form_missing', 'xsup'];
const normRun = (rows) => rows.map((r) => {
  const o = Object.assign({}, r); delete o.run_at;
  let oi = null; try { oi = o.ot_info ? JSON.parse(o.ot_info) : null; } catch (e) { oi = o.ot_info; }
  if (oi && typeof oi === 'object') { FREE.forEach((k) => delete oi[k]); if (!Object.keys(oi).length) oi = null; }
  o.ot_info = oi ? JSON.stringify(oi) : '';
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
});
const normItem = (rows) => rows.map((r) => JSON.stringify(Object.keys(r).sort().filter((k) => k !== 'run_at').map((k) => [k, r[k]])));
const r2 = (x) => Math.round(x * 100) / 100;

const V = { stricter: 0, runDiff: 0, itemDiff: 0, sumDiff: 0, perEmp: 0 }, C = { both: 0, baseOk: 0, newOk: 0, newOnly: 0, claimBlock: 0, ops: {}, recalc: 0, withSup: 0, keptOut: 0 };
const ex = {};
const t0 = Date.now();
for (let it = 0; it < N; it++) {
  const sc = scenario();
  const A = mkW(sc, baseSrc), B = mkW(sc, undefined);
  const calc = (w) => w.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', inputs: {} });
  const ca = calc(A), cb = calc(B);
  if (!ca.ok || !cb.ok) continue;
  const op = pick(['none', 'deact', 'leave', 'clear', 'amount', 'auto']); C.ops[op] = (C.ops[op] || 0) + 1;
  const victim = 'E' + (1 + Math.floor(rnd() * sc.X.length)), lv = rnd() < 0.5 ? '2026-11-15' : '2026-10-31', amt = 500 + Math.floor(rnd() * 4000), autoH = q(6);
  [A, B].forEach((w) => {
    if (op === 'deact') w.DB.master.forEach((m) => { if (m.emp_id === victim) { m.active = 'false'; m.leave_date = ''; } });
    if (op === 'leave') w.DB.master.forEach((m) => { if (m.emp_id === victim) { m.leave_date = lv; if (lv < '2026-11-01') m.active = 'false'; } });
    if (op === 'clear') w.DB.input = [];
    if (op === 'amount') w.DB.input.forEach((r) => { const s = JSON.parse(r.support); s.forEach((x) => { x.amount = amt; }); r.support = JSON.stringify(s); });
    if (op === 'auto') { const d = w.sb.__AP.SSLHQ['2026-11-28'] = w.sb.__AP.SSLHQ['2026-11-28'] || {}; d['H' + victim.slice(1)] = AP(autoH); }
  });
  if (rnd() < 0.5) { C.recalc++; calc(A); calc(B); }
  const body = { admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true, cost_snapshot: { total: 1, support: {}, detail: { v: 1, co_auto: {}, emp: [], sup: [] } } };
  const la = A.F('handlePayrollFinalize')(JSON.parse(JSON.stringify(body))), lb = B.F('handlePayrollFinalize')(JSON.parse(JSON.stringify(body)));
  if (la.ok) C.baseOk++;
  if (lb.ok) C.newOk++;
  let lbF = lb;
  if (la.ok && !lb.ok) {
    /* 本版多擋只允許一種：重算名單裡的人，草稿存的請款（xsup／xclaim／cross_ot）跟這次重算不同（改了支援列沒重算，r7 設計，既有句子）。
       確認真的是這種，然後照前端的反應「重新計算 → 再鎖」，要鎖得下去。其他原因的多擋＝違反。 */
    const dry = B.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', dry_run: true, inputs: {} });
    const sig = (oi) => B.F('payXclaimSig_')('2026-11', oi);
    const byId = {}; B.DB.run.forEach((r) => { byId[r.emp_id] = r; });
    const claimDiff = lb.error === 'stale_run' && !(lb.list || []).length && (dry.results || []).some((r) => byId[r.emp_id] && sig(byId[r.emp_id].ot_info) !== sig(r.ot_info));
    if (claimDiff) { C.claimBlock++; calc(B); lbF = B.F('handlePayrollFinalize')(JSON.parse(JSON.stringify(body))); if (!lbF.ok) { V.stricter++; if (!ex.stricter) ex.stricter = { op, again: lbF.error }; } }
    else { V.stricter++; if (!ex.stricter) ex.stricter = { op, la: la.error, lb: [lb.error, String(lb.message).slice(0, 120)] }; }
  }
  if (!la.ok && lb.ok) C.newOnly++;
  if (!(la.ok && lbF.ok)) continue;
  C.both++;
  if (JSON.stringify(normRun(A.DB.run)) !== JSON.stringify(normRun(B.DB.run))) { V.runDiff++; if (!ex.run) ex.run = { op, a: normRun(A.DB.run), b: normRun(B.DB.run) }; }
  if (JSON.stringify(normItem(A.DB.item)) !== JSON.stringify(normItem(B.DB.item))) { V.itemDiff++; if (!ex.item) ex.item = { op }; }
  const snap = JSON.parse(((B.DB.cost_snapshot || [])[0] || {}).detail_json || 'null') || { sup: [] };
  const xsBy = {}; let xsSum = 0;
  B.DB.run.forEach((r) => { const oi = r.ot_info ? JSON.parse(r.ot_info) : {}; xsBy[r.emp_id] = oi.xsup || []; xsSum += (oi.xsup || []).reduce((t, x) => t + x.amount, 0); });
  if (Object.values(xsBy).some((a) => a.length)) C.withSup++;
  if (op === 'deact' || (op === 'leave' && lv < '2026-11-01')) C.keptOut++;
  if (Math.abs((snap.sup || []).reduce((t, x) => t + x.amount, 0) - xsSum) > 0.005) { V.sumDiff++; if (!ex.sum) ex.sum = { op, snap: snap.sup, xsBy }; }
  const snapBy = {}; (snap.sup || []).forEach((x) => { (snapBy[x.emp_id] = snapBy[x.emp_id] || []).push(x); });
  if (Object.keys(xsBy).some((id) => JSON.stringify(snapBy[id] || []) !== JSON.stringify(xsBy[id]))) { V.perEmp++; if (!ex.per) ex.per = { op, snapBy, xsBy }; }
}
console.log('基準 ' + BASE + '；' + N + ' 組（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）；' + JSON.stringify(C));
chk('(i) 正式版鎖得下去、本版鎖不下去（扣掉「草稿存的請款跟重算不同 → 要求重算、重算後鎖得下去」那種設計上的擋），違反', V.stricter, 0);
chk('(ii) 兩邊都鎖下去：定案的薪資列（ot_info 去掉請款／加班單檢查鍵）逐列相同，不符', V.runDiff, 0);
chk('(ii) 兩邊都鎖下去：定案的薪資明細（item）逐列相同，不符', V.itemDiff, 0);
chk('(iii) 本版快照請款合計＝被定案草稿列存的 xsup 加總，不符', V.sumDiff, 0);
chk('(iv) 快照裡每位同仁的請款逐筆＝他被定案那列草稿存的 xsup，不符', V.perEmp, 0);
chk('涵蓋：兩邊都鎖下去的組數、有請款的、停用或上個月離職後照草稿定案的、六種操作都出現', [C.both * 5 >= N, C.withSup * 8 >= N, C.keptOut * 40 >= N, Object.keys(C.ops).length], [true, true, true, 6]);
Object.keys(ex).forEach((k) => console.log('  例 ' + k + '：' + JSON.stringify(ex[k]).slice(0, 1200)));
console.log('\n' + (f ? '❌' : '✅') + ' 鎖月流程對照：' + p + ' 過、' + f + ' 失敗');
process.exit(f ? 1 : 0);
