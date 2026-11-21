/* 跨店請款 #210 兩個不變量（2026-11-22 r2，接到選舉假上線版 1ab5655 之後）：
 *   I1 實領不變：同一組輸入，上線版（XINV_BASE，預設 1ab5655）與本分支的 payCalcOne 逐欄相同——
 *      應發、扣款、實領、每一個薪資項目（名稱／時數／單價／金額）、其餘回應欄位；
 *      只允許請款／加班單檢查欄位不同：ot_info.xr、ot_info.xclaim、ot_info.cross_ot、ot_info.ot_form_missing。
 *   I2 請款不超過實際加發：用「加成倍數時數」比（請款時薪 × 倍數時數＝請款加成金額）——
 *      a. 逐日：同一天所有支援店請的加成合計 ≤ 同仁那天實際多拿的加成（平日＝補休抵完剩的 1.34／1.67 段；
 *         休息日＝補休抵完剩的前 2 小時＋3–8＋9 起；例假／國定假日／選舉日＝超過 8 那段＋正職加發）；
 *      b. 計時國定假日／選舉日的支援加倍：每家店請的 hx ≤ 薪資單上「國定假日加倍（支援○○）」「選舉日出勤（支援○○）」實際發的時數；
 *      c. 每家店整月：請款倍數時數 ≤ 它有出勤那幾天同仁實際多拿的加成＋b 的實發時數；
 *      d. 對帳：引擎 ot_info.xclaim 整月＝逐日拆開算的合計（確認 a 檢查的就是實際用的那份）。
 * 隨機 XINV_N 組（預設 20,000），全部虛構。加班時薪＝計時時薪＝支援列費率＝200。
 * 用法：node tests/xstore-claim-invariant.test.js；XINV_N=50000 XINV_BASE=<commit> 可換。 */
'use strict';
const vm = require('vm'), path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers/payroll-vm.js');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.XINV_BASE || '1ab5655';
const N = parseInt(process.env.XINV_N || '20000', 10);
let p = 0, f = 0;
const chk = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w), ok = a === b; ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + a + (ok ? '' : ' ← 應為 ' + b)); };
const J = (x) => JSON.parse(JSON.stringify(x));
const r2 = (x) => Math.round(x * 100) / 100;

let baseSrc = null;
try { baseSrc = execFileSync('git', ['show', BASE + ':apps-script/Payroll.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) {}
if (!baseSrc) { console.log('✗ 讀不到基準 ' + BASE + ' 的 Payroll.gs'); console.log('\n❌ 跨店請款不變量：0 過、1 失敗'); process.exit(1); }
const S = H.load({ today: '2026-12-05' });
const S0 = H.load({ today: '2026-12-05', payrollSrc: baseSrc });
vm.runInContext('var __XC = null; (function(){ var o = payOtCrossClaim_; payOtCrossClaim_ = function(){ __XC = Array.prototype.slice.call(arguments); return o.apply(this, arguments); }; globalThis.__XC_ORIG = o; })();', S);
const LT = S.call('payLeaveTypes', 'MZTGF'), LT0 = S0.call('payLeaveTypes', 'MZTGF');
const YM = '2026-11';
const ELEC_LABEL = vm.runInContext('PAY_ELEC_LABEL', S);
const STORE_BY = { MZTGF: { code: 'MZTGF', name: '墨光' }, MZTJS: { code: 'MZTJS', name: '金山' }, MZTLZL: { code: 'MZTLZL', name: '六張犁' }, MZTMC: { code: 'MZTMC', name: '美村' } };
const ftE = () => H.ftEmp({ store: 'MZTGF', base: 40000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 6000, ot_rate: 200 });   // 月工資 48,000 → 加班時薪 200
const ptE = () => H.ptEmp({ store: 'MZTGF', wage: 200 });
const hm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const CELL = { W: { t: 'W' }, H: { t: 'H' }, R: { t: 'R' }, L: { t: 'L', l: '特' }, G: { t: 'L', l: '國' } };

/** 同 xstore-claim-1122.test.js build：E＝要用的引擎（兩版各自組，不共用中間結果） */
function build(o, E) {
  const e = o.ft ? ftE() : ptE();
  const col = { day_h: {}, day_leave: {} }, sched = {}, hol = [], elec = [], by = {};
  o.days.forEach((d) => {
    if (d.home > 0) col.day_h[d.date] = d.home;
    sched[d.date] = CELL[d.cell || 'W'];
    if (d.hol) hol.push(d.date);
    if (d.elec) elec.push(d.date);
    (d.sups || []).forEach((s) => {
      if (!(s.h > 0)) return;
      const st = by[s.code] = by[s.code] || { code: s.code, name: STORE_BY[s.code].name, acct: '7', hours: 0, days: [] };
      st.hours = r2(st.hours + s.h);
      st.days.push({ date: d.date, periods: hm(s.s) + '-' + hm(s.s + Math.round(s.h * 60)), hours: s.h });
    });
  });
  const xEntry = { stores: Object.keys(by).map((k) => by[k]) };
  const support = xEntry.stores.map((s) => ({ code: s.code, store: s.name, hours: (o.supPaid && o.supPaid[s.code] != null) ? Math.min(o.supPaid[s.code], s.hours) : s.hours, rate: 200, amount: '', auto: true }));
  const supH = support.reduce((a, s) => a + s.hours, 0);
  const homeSum = r2(Object.keys(col.day_h).reduce((a, k) => a + col.day_h[k], 0));
  const daily = E.call('payDailyFor_', e, YM, col, xEntry, sched, hol, '', supH, elec);
  const att = H.baseAtt({ hours: homeSum, support, daily, leaves: o.comp ? { comp: o.comp } : {},
    holiday_h: r2(hol.reduce((a, d) => a + (col.day_h[d] || 0), 0)) });
  att.sup_hol = E.call('paySupportHolDouble_', support, xEntry, hol, STORE_BY, '');
  if (elec.length) {
    att.elec_h = E.call('payElecOwnH_', col, elec);
    att.sup_elec = E.call('paySupportElecDouble_', support, xEntry, hol, elec, STORE_BY, '');
  }
  if (o.hours != null) att.hours = o.hours;
  if (o.holManual) att.elec_hol_manual = true;
  if (xEntry.stores.length) {
    if (vm.runInContext('typeof payOtCrossDays_', E) === 'function') att.ot_xdays = E.call('payOtCrossDays_', col, xEntry);
    att.ot_cross = E.call('payOtCrossNeed_', col, xEntry);
  }
  att.ot_own_h = col.day_h; att.ot_forms = { ot: {}, trip: {} };
  att.ot_forms_x = {}; Object.keys(by).forEach((k) => { att.ot_forms_x[k] = { 'id:7': { ot: {} } }; });
  att.ot_name = e.name;
  return { e, att, xEntry };
}

let seed = 1122 * 2026 + 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const q = () => Math.round(rnd() * 48) / 4;   // 0–12 小時、15 分一格
function randomCase() {
  const ft = rnd() < 0.55, days = [];
  const nd = 1 + Math.floor(rnd() * 8);
  let day = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < nd && day <= 30; i++, day += 1 + Math.floor(rnd() * 4)) {
    const date = '2026-11-' + String(day).padStart(2, '0');
    const k = pick(['W', 'W', 'W', 'H', 'H', 'R', 'L', 'G', 'HOL', 'ELEC', 'ELEC']);
    const d = { date, cell: k === 'HOL' || k === 'ELEC' ? 'W' : k, hol: k === 'HOL', elec: k === 'ELEC', home: rnd() < 0.25 ? 0 : q(), sups: [] };
    const ns = rnd() < 0.25 ? 0 : 1 + Math.floor(rnd() * 3);
    const s0 = 360 + Math.floor(rnd() * 48) * 15;
    ['MZTJS', 'MZTLZL', 'MZTMC'].slice(0, ns).forEach((c, j) => d.sups.push({ code: c, h: rnd() < 0.1 ? 0 : q(), s: rnd() < 0.2 ? s0 : 360 + Math.floor(rnd() * 60) * 15 + j }));   // 兩成同時開始（D7 並列）
    days.push(d);
  }
  const o = { ft, days, comp: ft && rnd() < 0.4 ? Math.round(rnd() * 40) / 4 : 0 };
  if (!ft && days.some((d) => d.elec) && rnd() < 0.3) o.holManual = true;   // 計時手填國定假日時數≠打卡 → 選舉日本店與支援都不自動發
  if (!ft && rnd() < 0.2) o.hours = Math.round(rnd() * 40) / 2;              // 總時數被手調低
  if (rnd() < 0.2) { o.supPaid = {}; ['MZTJS', 'MZTLZL', 'MZTMC'].forEach((c) => { if (rnd() < 0.5) o.supPaid[c] = Math.round(rnd() * 32) / 4; }); }   // 採計支援時數少於逐日
  return o;
}

const ALLOW = ['xr', 'xclaim', 'cross_ot', 'ot_form_missing'];
const strip = (r) => { const o = J(r); if (o.ot_info) ALLOW.forEach((k) => delete o.ot_info[k]); return JSON.stringify(o); };
const mh = (c) => (c.h43 || 0) * 0.34 + (c.h53 || 0) * 0.67 + (c.r43 || 0) * 0.34 + (c.r53 || 0) * 0.67 + (c.r83 || 0) * 1.67 + (c.d8 || 0) + (c.hx || 0);
/** 同仁某天實際多拿的加成（倍數時數），從薪資自己算薪用的 otS（同一份 S 餵 payOtDailyItems）取 */
function paidDay(otS, d, ft) {
  const b = (otS.day_break || {})[d];
  if (!b) return 0;
  if (b.kind === 'W') { const l = (otS.ot_left || {})[d] || { w43: 0, w53: 0 }; return l.w43 * 0.34 + l.w53 * 0.67; }
  if (b.kind === 'H') { const r43 = (otS.r43_left || {})[d] !== undefined ? otS.r43_left[d] : b.r43; return r43 * 0.34 + b.r53 * 0.67 + b.r83 * 1.67; }
  const over = b.w43 * 0.34 + b.w53 * 0.67;
  if (b.kind === 'R') return over + (ft ? 8 : b.h);
  if (b.kind === 'HOL') return over + (ft ? Math.min(b.h, 8) : 0);   // 計時國定／選舉日加倍另外對薪資單（I2b）
  return 0;
}
const supPaidQty = (r, name) => r.earn.filter((x) => x.item_key === 'holiday_double' && (x.item_label === '國定假日加倍（支援' + name + '）' || x.item_label === ELEC_LABEL + '（支援' + name + '）')).reduce((a, x) => a + x.qty, 0);

const t0 = Date.now();
const V = { pay: 0, day: 0, sup: 0, store: 0, recon: 0, slipDay: 0 };
const C = { cases: 0, cross: 0, claim: 0, kindH: 0, kindR: 0, kindHOL: 0, kindELEC: 0, stopped: 0, tie: 0, multi: 0, comp: 0, ptSupDouble: 0, capped: 0 };
const ex = {};
const note = (k, o) => { if (!ex[k]) ex[k] = o; };
for (let i = 0; i < N; i++) {
  const o = randomCase();
  const b = build(o, S), b0 = build(o, S0);
  vm.runInContext('__XC = null', S);
  const r = J(S.call('payCalcOne', b.e, YM, b.att, H.cfg, 4, LT));
  const r0 = J(S0.call('payCalcOne', b0.e, YM, b0.att, H.cfg, 4, LT0));
  C.cases++;
  if (strip(r) !== strip(r0)) { V.pay++; note('pay', { o, a: strip(r).slice(0, 400), b: strip(r0).slice(0, 400) }); }
  if (!b.xEntry.stores.length) continue;
  C.cross++;
  const xc = vm.runInContext('__XC', S);
  if (!xc) continue;
  const [otS, xdays, cross, ft, supHol, supElec] = xc;
  const orig = vm.runInContext('__XC_ORIG', S);
  const claimM = r.ot_info.xclaim || [];
  if (claimM.length) C.claim++;
  if (o.comp > 0 && otS.comp_used_h > 0) C.comp++;
  if (o.holManual && (supElec || []).some((x) => x.stopped)) C.stopped++;
  if (supHol.some((x) => x.hours > 0) || (supElec || []).some((x) => x.hours > 0)) C.ptSupDouble += ft ? 0 : 1;
  if ((supElec || []).some((x) => x.want > x.hours + 0.005 && !x.stopped)) C.capped++;
  // 逐日拆開
  const perStore = {}, perStoreAllowed = {};
  const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };
  Object.keys(xdays).sort().forEach((d) => {
    const x = xdays[d];
    if (x.sups.length > 1) C.multi++;
    if (x.sups.length > 1 && x.abs && x.sups.filter((s) => Math.abs(s.h - x.abs.h) <= 0.005 && s.fs === x.abs.fs).length > 1) C.tie++;
    const one = {}; one[d] = x;
    const cr1 = {}; if (cross[d]) cr1[d] = cross[d];
    const cl = J(orig(otS, one, cr1, ft, [], [], YM));
    const kd = (otS.day_break[d] || {}).kind;
    if (cl.length) { if (kd === 'H') C.kindH++; if (kd === 'R') C.kindR++; if (kd === 'HOL') (otS.day_break[d].elec ? C.kindELEC++ : C.kindHOL++); }
    const sum = cl.reduce((a, c) => a + mh(c), 0), paid = paidDay(otS, d, ft);
    if (sum > paid + 0.03) { V.day++; note('day', { o, d, sum, paid, cl }); }
    cl.forEach((c) => { add(perStore, c.code, mh(c)); });
    x.sups.forEach((s) => { if (s.h > 0) add(perStoreAllowed, s.code, paid); });
  });
  // 計時國定假日／選舉日支援加倍
  const supPart = J(orig(otS, {}, {}, ft, supHol, supElec, YM));
  supPart.forEach((c) => {
    const name = (b.att.support.find((s) => s.code === c.code) || {}).store || c.name;
    const q2 = supPaidQty(r, name);
    if (c.hx > q2 + 0.005) { V.sup++; note('sup', { o, c, q2 }); }
    add(perStore, c.code, mh(c)); add(perStoreAllowed, c.code, q2);
  });
  // 每家整月、對帳
  claimM.forEach((c) => {
    const m = mh(c);
    if (m > (perStoreAllowed[c.code] || 0) + 0.05) { V.store++; note('store', { o, c, allowed: perStoreAllowed[c.code] }); }
    if (Math.abs(m - (perStore[c.code] || 0)) > 0.05) { V.recon++; note('recon', { o, c, sum: perStore[c.code] }); }
  });
  Object.keys(perStore).forEach((k) => { if (perStore[k] > 0.05 && !claimM.some((c) => c.code === k)) { V.recon++; note('recon', { o, k, sum: perStore[k] }); } });
  // 薪資單對帳：逐日 paidDay 合計＝薪資單加班類項目的加成（確認 I2a 的「實際多拿」就是薪資單發的）
  const slip = (k) => r.earn.filter((x) => x.item_key === k).reduce((a, x) => a + x.qty, 0);
  const totalPaid = Object.keys(otS.day_break).reduce((a, d) => a + paidDay(otS, d, ft), 0);
  const slipPrem = slip('ot_w43') * 0.34 + slip('ot_w53') * 0.67 + (otS.r43 * 0.34 + otS.r53 * 0.67 + otS.r83 * 1.67) + (ft ? slip('ot_rdo') * 8 + slip('ot_hol') : slip('ot_rdo_h'));
  if (Math.abs(totalPaid - slipPrem) > 0.05) { V.slipDay++; note('slip', { o, totalPaid, slipPrem }); }
}
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('基準 ' + BASE + '；隨機 ' + N + ' 組（' + sec + ' 秒）；涵蓋 ' + JSON.stringify(C));
chk('I1 實領不變：應發／扣款／實領／每個薪資項目與其餘欄位逐欄相同（只允許 ' + ALLOW.join('、') + ' 不同），違反', V.pay, 0);
chk('I2a 逐日：各支援店請的加成合計 ≤ 同仁那天實際多拿的加成，違反', V.day, 0);
chk('I2b 計時國定假日／選舉日：每家店 hx ≤ 薪資單實發的支援加倍時數，違反', V.sup, 0);
chk('I2c 每家店整月：請款倍數時數 ≤ 有出勤那幾天實際多拿的加成＋實發支援加倍，違反', V.store, 0);
chk('I2d 對帳：引擎 xclaim 整月＝逐日拆開合計，不符', V.recon, 0);
chk('I2e 對帳：逐日「實際多拿」合計＝薪資單加班類項目，不符', V.slipDay, 0);
chk('涵蓋：有跨店、有請款、休息日／例假／國定／選舉日都有出現請款、手填停發、並列、多支援、補休抵', [C.cross > N * 0.5, C.claim > N * 0.4, C.kindH > N / 20, C.kindR > N / 20, C.kindHOL > N / 20, C.kindELEC > N / 20, C.stopped > N / 40, C.tie > N / 400, C.multi > N / 2, C.comp > N / 40], [true, true, true, true, true, true, true, true, true, true]);
Object.keys(ex).forEach((k) => console.log('  例 ' + k + '：' + JSON.stringify(ex[k]).slice(0, 900)));
console.log('\n' + (f ? '❌' : '✅') + ' 跨店請款不變量：' + p + ' 過、' + f + ' 失敗');
process.exit(f ? 1 : 0);
