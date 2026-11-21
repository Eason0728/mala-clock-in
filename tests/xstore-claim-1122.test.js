/* 跨店請款 N4（2026-11-22 Eason 定案 D1–D7）：休息日／例假／國定假日／選舉日的加成也向被支援單位請款，
 * 超過 8 小時那段照平日現行吸收規則（有上限）、8 小時以內照兩邊時數比例（PAY_XCLAIM_SHARE）；補休抵掉的不請。
 * 只動請款與 D5 加班單檢查，任何人的應發扣款不可以變（V2 由這支的「有沒有跨店資料同一人逐欄相同」＋engine-diff 守）。
 * 全部虛構姓名與金額。加班時薪（月工資÷240）＝200、計時時薪＝200。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const H = require('./helpers/payroll-vm.js');
let p = 0, f = 0;
const chk = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w), ok = a === b; ok ? p++ : f++; if (!ok || process.env.V) console.log((ok ? '✓ ' : '✗ ') + n + ': ' + a + (ok ? '' : ' ← 應為 ' + b)); };
const J = (x) => JSON.parse(JSON.stringify(x));
const r2 = (x) => Math.round(x * 100) / 100;

const S = H.load({ today: '2026-12-05' });
const LT = S.call('payLeaveTypes', 'MZTGF');
const YM = '2026-11';
const STORE_BY = { MZTGF: { code: 'MZTGF', name: '墨光' }, MZTJS: { code: 'MZTJS', name: '金山' }, MZTLZL: { code: 'MZTLZL', name: '六張犁' }, MZTMC: { code: 'MZTMC', name: '美村' } };
const ftE = () => H.ftEmp({ store: 'MZTGF', base: 40000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 6000, ot_rate: 200 });   // 月工資 48,000（含伙食 2,000）→ 加班時薪 200
const ptE = () => H.ptEmp({ store: 'MZTGF', wage: 200 });
const hm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const CELL = { W: { t: 'W' }, H: { t: 'H' }, R: { t: 'R' }, L: { t: 'L', l: '特' }, G: { t: 'L', l: '國' } };

/** days:[{date, cell:'W'|'H'|'R'|'L'|'G', hol, elec, home, homeS, sups:[{code,h,s}]}]；回 { e, att }（S2＝要用的引擎，預設新版） */
function build(o, S2) {
  const E = S2 || S;
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
  const support = xEntry.stores.map((s) => ({ code: s.code, store: s.name, hours: s.hours, rate: o.ft ? 200 : 200, amount: '', auto: true }));
  const supH = support.reduce((a, s) => a + s.hours, 0);
  const homeSum = r2(Object.keys(col.day_h).reduce((a, k) => a + col.day_h[k], 0));
  const daily = E.call('payDailyFor_', e, YM, col, xEntry, sched, hol, '', supH, elec);
  const att = H.baseAtt({ hours: homeSum, support, daily, leaves: o.comp ? { comp: o.comp } : {},
    holiday_h: r2(hol.reduce((a, d) => a + (col.day_h[d] || 0), 0)) });
  att.sup_hol = E.call('paySupportHolDouble_', support, xEntry, hol, STORE_BY, '');
  if (elec.length) { att.elec_h = E.call('payElecOwnH_', col, elec); att.sup_elec = E.call('paySupportHolDouble_', support, xEntry, elec, STORE_BY, ''); }
  if (xEntry.stores.length) {
    if (vm.runInContext('typeof payOtCrossDays_', E) === 'function') att.ot_xdays = E.call('payOtCrossDays_', col, xEntry);
    att.ot_cross = E.call('payOtCrossNeed_', col, xEntry);
  }
  att.ot_own_h = col.day_h; att.ot_forms = { ot: o.formsHome || {}, trip: {} };
  att.ot_forms_x = {}; Object.keys(by).forEach((k) => { att.ot_forms_x[k] = { 'id:7': { ot: (o.formsSup || {})[k] || {} } }; });
  att.ot_name = e.name;
  return { e, att, xEntry, col };
}
const calc = (b, E) => J((E || S).call('payCalcOne', b.e, YM, b.att, H.cfg, 4, LT));
/** 每家支援店請款＝支援時數×200＋加成（後端 pnlSupXAdd_） */
function claims(o) {
  const b = build(o), r = calc(b), out = {};
  b.att.support.forEach((x) => { out[x.code] = r2(x.hours * 200 + S.call('pnlSupXAdd_', r, x, 200).add); });
  return { claims: out, r };
}
const D = '2026-11-10';   // 週二
const D2 = '2026-11-11';

/* ── V3：手算 H1–H14（design.md ★1）── */
const HC = [
  ['H1 平日 原10＋A1（正職）', { ft: true, days: [{ date: D, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }, { MZTJS: 289.78 }],
  ['H2 平日 原6＋A4', { ft: true, days: [{ date: D, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 1020 }] }] }, { MZTJS: 936 }],
  ['H3 平日 原7＋A2＋B1.5', { ft: true, days: [{ date: D, home: 7, sups: [{ code: 'MZTJS', h: 2, s: 900 }, { code: 'MZTLZL', h: 1.5, s: 1100 }] }] }, { MZTJS: 562.4, MZTLZL: 300 }],
  ['H4 平日 原5＋A2＋B2（B 後上）', { ft: true, days: [{ date: D, home: 5, sups: [{ code: 'MZTJS', h: 2, s: 840 }, { code: 'MZTLZL', h: 2, s: 1020 }] }] }, { MZTJS: 400, MZTLZL: 468 }],
  ['H5 平日 A4.5＋B4（原0）', { ft: true, days: [{ date: D2, home: 8, sups: [] }, { date: D, home: 0, sups: [{ code: 'MZTJS', h: 4.5, s: 600 }, { code: 'MZTLZL', h: 4, s: 900 }] }] }, { MZTJS: 934, MZTLZL: 800 }],
  ['H6 休息日 原4＋A4', { ft: true, days: [{ date: D, cell: 'H', home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }, { MZTJS: 1270 }],
  ['H7 休息日 原5＋A5', { ft: true, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] }, { MZTJS: 2020.5 }],
  ['H7b 同上＋當月補休 2h（這天是最早的加班）', { ft: true, comp: 2, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] }, { MZTJS: 1969.5 }],
  ['H8 國定假日 A8（原0，正職）', { ft: true, days: [{ date: D2, home: 8 }, { date: D, hol: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] }, { MZTJS: 3200 }],
  ['H8p 國定假日 A8（原0，計時）', { ft: false, days: [{ date: D2, home: 6 }, { date: D, hol: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] }, { MZTJS: 3200 }],
  ['H9 國定假日 原4＋A6', { ft: true, days: [{ date: D, hol: true, home: 4, sups: [{ code: 'MZTJS', h: 6, s: 840 }] }] }, { MZTJS: 2136 }],
  ['H10 例假 原4＋A4（正職）', { ft: true, days: [{ date: D, cell: 'R', home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }, { MZTJS: 1600 }],
  ['H10p 例假 原4＋A4（計時）', { ft: false, days: [{ date: D, cell: 'R', home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }, { MZTJS: 1600 }],
  ['H11 平日 原10＋A1（計時）', { ft: false, days: [{ date: D, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }, { MZTJS: 289.78 }],
  ['H12 選舉日 A8（原0，正職）', { ft: true, days: [{ date: D2, home: 8 }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] }, { MZTJS: 3200 }],
  ['H12p 選舉日 A8（原0，計時）', { ft: false, days: [{ date: D2, home: 6 }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] }, { MZTJS: 3200 }],
  ['H13 休息日 原10＋A1（上限有作用）', { ft: true, days: [{ date: D, cell: 'H', home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }, { MZTJS: 534 }],
  ['H14 國定假日 原10＋A1（上限有作用）', { ft: true, days: [{ date: D, hol: true, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }, { MZTJS: 289.78 }],
];
HC.forEach(([n, o, want]) => chk('V3 ' + n, claims(o).claims, want));

/* D3 兩種比例（PAY_XCLAIM_SHARE）：休息日原 5＋支援 5 */
{
  const b = build({ ft: true, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] }), r = calc(b);
  const xd = b.att.ot_xdays, otS = S.call('payOtDailySum', Object.assign({}, b.att.daily, { comp_h: 0 }));
  const w8 = J(S.call('payOtCrossClaim_', otS, xd, b.att.ot_cross, true, [], [], YM, 'w8'));
  const tot = J(S.call('payOtCrossClaim_', otS, xd, b.att.ot_cross, true, [], [], YM, 'total'));
  chk('D3 w8：r43 0.75、r53 2.25、r83 2（支援 3/8）', [w8[0].r43, w8[0].r53, w8[0].r83], [0.75, 2.25, 2]);
  chk('D3 total：r43 1、r53 3、r83 2（支援 5/10）', [tot[0].r43, tot[0].r53, tot[0].r83], [1, 3, 2]);
  chk('D3 w8 請款 2,020.5／total 請款 2,138', [r2(1000 + (0.75 * 0.34 + 2.25 * 0.67 + 2 * 1.67) * 200), r2(1000 + (1 * 0.34 + 3 * 0.67 + 2 * 1.67) * 200)], [2020.5, 2138]);
  chk('D3 預設＝w8（引擎輸出同 w8）', r.ot_info.xclaim, w8);
}

/* Eason 的四個例子（吸收規則維持現行，D1） */
{
  const need = (home, sups) => {
    const col = { day_h: { [D]: home } };
    const x = { stores: sups.map((s) => ({ code: s.code, name: s.code, acct: '7', days: [{ date: D, periods: hm(s.s) + '-' + hm(s.s + s.h * 60), hours: s.h }] })) };
    return J(S.call('payOtCrossNeed_', col, x))[D].map((y) => (y.home ? '原' : y.code) + y.need);
  };
  chk('V3 原6＋支援4 → 支援 2', need(6, [{ code: 'A', h: 4, s: 900 }]), ['A2']);
  chk('V3 原10＋支援1 → 原 2、支援 1', need(10, [{ code: 'A', h: 1, s: 1260 }]), ['原2', 'A1']);
  chk('V3 A4.5＋B4 → A 0.5', need(0, [{ code: 'A', h: 4.5, s: 600 }, { code: 'B', h: 4, s: 900 }]), ['A0.5']);
  chk('V3 原5＋A2＋B2（B 後上）→ B 1', need(5, [{ code: 'A', h: 2, s: 840 }, { code: 'B', h: 2, s: 1020 }]), ['B1']);
  const tie = J(S.call('payOtCrossDays_', { day_h: { [D]: 7 } }, { stores: ['MZTLZL', 'MZTJS'].map((c) => ({ code: c, name: c, acct: '7', days: [{ date: D, periods: '15:00-17:00', hours: 2 }] })) }))[D];
  chk('D7 一樣長、一樣早 → 門市代碼小的（MZTJS）', [tie.abs.code, tie.at_sup], ['MZTJS', 2]);
}

/* ── V2（常駐版）：同一人有沒有跨店請款資料，應發扣款逐欄相同；隨機 3000 組（20,000 組舊版 vs 新版的對拆在 PR 說明的 scratch 腳本） ── */
let seed = 20261122;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const q = () => Math.round(rnd() * 44) / 4;   // 0–11 小時、15 分一格
function randomCase() {
  const ft = rnd() < 0.6, days = [];
  const nd = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < nd; i++) {
    const date = '2026-11-' + String(3 + i * 4).padStart(2, '0');
    const k = pick(['W', 'W', 'H', 'R', 'L', 'G', 'HOL', 'ELEC']);
    const day = { date, cell: k === 'HOL' || k === 'ELEC' ? 'W' : k, hol: k === 'HOL', elec: k === 'ELEC', home: rnd() < 0.2 ? 0 : q(), sups: [] };
    const ns = Math.floor(rnd() * 4);
    ['MZTJS', 'MZTLZL', 'MZTMC'].slice(0, ns).forEach((c, j) => day.sups.push({ code: c, h: q(), s: 360 + Math.floor(rnd() * 60) * 15 + j }));
    days.push(day);
  }
  return { ft, days, comp: ft && rnd() < 0.4 ? Math.round(rnd() * 24) / 4 : 0 };
}
{
  let n = 0, diff = 0, withClaim = 0;
  for (let i = 0; i < 3000; i++) {
    const o = randomCase(), b = build(o), r = calc(b);
    const a2 = Object.assign({}, b.att); delete a2.ot_xdays; delete a2.ot_cross; delete a2.ot_forms_x;
    const r0 = J(S.call('payCalcOne', b.e, YM, a2, H.cfg, 4, LT));
    n++;
    if (JSON.stringify([r.earn, r.ded, r.gross, r.deduction, r.net]) !== JSON.stringify([r0.earn, r0.ded, r0.gross, r0.deduction, r0.net])) diff++;
    if (r.ot_info && r.ot_info.xclaim) withClaim++;
  }
  chk('V2 有沒有跨店資料，應發扣款逐欄相同（3000 組）', diff, 0);
  chk('V2 隨機情境真的有產生請款（不是空比對）', withClaim > 1000, true);
}

/* ── V7 選舉日 ── */
{
  const ftc = claims({ ft: true, comp: 40, days: [{ date: D, elec: true, home: 6, sups: [{ code: 'MZTJS', h: 6, s: 900 }] }] });
  // 合計 12：超過 4 → A 吸收 4（f＝1）h43 2、h53 2；加發 min(12,8)×(A 6−4＝2)/(2＋6)＝2 → (0.68＋1.34＋2)×200＝804；補休 40h 抵不到選舉日
  chk('V7 正職選舉日：超過 8 照請（補休抵不到）＋加發按比例', ftc.claims, { MZTJS: r2(1200 + (2 * 0.34 + 2 * 0.67 + 2) * 200) });
  chk('V7 正職選舉日明細照舊（選舉日出勤 8h，不因請款改變）', H.item(ftc.r, 'ot_hol'), 1600);
  const pt = claims({ ft: false, days: [{ date: D2, home: 6 }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] });
  chk('V7 計時選舉日：hx＝sup_elec 8（不重複算成 16）', pt.r.ot_info.xclaim.map((x) => x.hx), [8]);
  const both = claims({ ft: false, days: [{ date: '2026-11-03', hol: true, home: 0, sups: [{ code: 'MZTJS', h: 5, s: 600 }] }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 3, s: 600 }] }, { date: D2, home: 6 }] });
  chk('V7 計時國定＋選舉日同一家：hx＝5＋3', both.r.ot_info.xclaim.map((x) => x.hx), [8]);
}

/* ── V5 月份閘 ── */
{
  const b = build({ ft: true, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] });
  const r10 = J(S.call('payCalcOne', b.e, '2026-10', b.att, H.cfg, 4, LT));
  chk('V5 2026-10：沒有 xr、沒有 xclaim', [!!(r10.ot_info || {}).xr, !!(r10.ot_info || {}).xclaim], [false, false]);
  chk('V5 payOtCrossClaim_ 2026-10 回空', J(S.call('payOtCrossClaim_', {}, b.att.ot_xdays, b.att.ot_cross, true, [], [], '2026-10')), []);
  const nob = build({ ft: true, days: [{ date: D, home: 9 }] });
  chk('V1 沒有跨店支援的人：ot_info 沒有 xr／xclaim（逐欄不變）', ['xr', 'xclaim'].map((k) => k in (calc(nob).ot_info || {})), [false, false]);
}

/* ── V4／V5 前端 costTotals vs 後端 pnlEstimateClassify_（2026-11 跨店，含舊 ot_info 與新 ot_info 混合）── */
{
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  const ai = HTML.indexOf('const COST_REDUCE_EXTRA='), bi = HTML.indexOf('function renderCost(){');
  const sbF = { console };
  vm.createContext(sbF);
  vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x};const r2=v=>Math.round(v*100)/100;const ym=()=>"2026-11";' + HTML.slice(ai, bi), sbF);
  const cases = [
    { ft: true, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }, { date: D2, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] },
    { ft: false, days: [{ date: D, hol: true, home: 4, sups: [{ code: 'MZTLZL', h: 6, s: 840 }] }, { date: D2, cell: 'R', home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] },
  ];
  const results = [], master = [], att = {};
  cases.forEach((o, i) => {
    const b = build(o); b.e.emp_id = 'X' + i; b.e.name = '同仁' + i;
    const r = calc(b); results.push(r); master.push(b.e); att[b.e.emp_id] = { support: b.att.support };
  });
  // 一位「已鎖定、沒有快照」的舊 ot_info（沒有 xr）：前後端都要照舊公式
  const old = J(results[0]); old.emp_id = 'X9'; old.name = '同仁9'; delete old.ot_info.xr; delete old.ot_info.xclaim;
  results.push(old); master.push(Object.assign({}, master[0], { emp_id: 'X9', name: '同仁9' })); att.X9 = att.X0;
  const back = J(S.call('pnlEstimateClassify_', results, master, att, H.cfg, YM));
  vm.runInContext('RESULTS=' + JSON.stringify(results) + ';MASTER=' + JSON.stringify(master) + ';ATT=' + JSON.stringify(att) + ';CFG=' + JSON.stringify(H.cfg) + ';STATUS="draft";COST_SNAP=null;', sbF);
  const front = J(vm.runInContext('costStable(costTotals())', sbF));
  chk('V4 前端 costStable vs 後端 pnlEstimateClassify_ 逐鍵相同', front, back);
  chk('V4 請款確實含新加成（金山 > 舊公式）', back.support['金山'] > 2 * (5 * 200) + 200, true);
  const sup9 = J(vm.runInContext('costTotals().sup.filter(x=>x.emp_id==="X9")', sbF));
  const oldAdd = (results[0].ot_info.cross_ot || []).reduce((a, c) => a + (c.h43 * 0.34 + c.h53 * 0.67) * 200, 0);
  chk('V5 已鎖沒快照（ot_info 沒 xr）：照舊公式', r2(sup9.reduce((a, x) => a + x.amount, 0)), r2(6 * 200 + oldAdd));
  // 已鎖定有快照：讀快照，新程式碰不到
  vm.runInContext('STATUS="final";COST_SNAP={support:{"金山":123},detail:{sup:[{emp_id:"X0",store:"金山",hours:6,rate:200,amount:123}]}};', sbF);
  chk('V5 已鎖有快照：請款＝快照金額', J(vm.runInContext('costTotals().sup.map(x=>x.amount)', sbF)), [123]);
  vm.runInContext('STATUS="draft";COST_SNAP=null;', sbF);
  chk('a9 快照逐筆明細帶被支援門市代碼', J(vm.runInContext('costDetail(costTotals()).sup.map(x=>x.code)', sbF)).sort(), ['MZTJS', 'MZTJS', 'MZTJS', 'MZTLZL']);
}

/* ── V6 D5：薪資加班單檢查 vs 打卡端現行要求（Requests.gs reqFt8Split_／reqStrictOtNeed_）同一組輸入 ── */
{
  const R = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8');
  const ex = (name) => { const i = R.indexOf('function ' + name + '('); let d = 0, j = R.indexOf('{', i); for (; j < R.length; j++) { if (R[j] === '{') d++; else if (R[j] === '}' && --d === 0) { j++; break; } } return R.slice(i, j); };
  const cx = { REQ_FT8_H: 8, REQ_BIND_OT_BASE_H: 8 }; vm.createContext(cx);
  ['reqFt8Split_', 'reqStrictOtNeed_'].forEach((n) => vm.runInContext(ex(n), cx));
  /** 打卡端：每家店要的加班單時數（假設個人帳號核定、別家都已核定：reqFt8_ 跨店那段會跑） */
  function reqNeed(o, d) {
    const out = {}, cell = CELL[d.cell || 'W'];
    const crossOn = o.ft && cell.t === 'W' && !d.homeless;
    const peers = d.sups.filter((s) => s.h > 0);
    const P = (list) => ({ worked: true, pending: false, failed: false, by: Object.fromEntries(list.map((x) => [x.code, { work: x.h, ot: 0, fs: x.s }])), names: list.map((x) => x.code) });
    if (d.home > 0) out[''] = crossOn && peers.length ? cx.reqFt8Split_(d.home, {}, P(peers), false).here : cx.reqStrictOtNeed_(d.home, cell.t).need;
    peers.forEach((s) => {
      const others = peers.filter((y) => y !== s).concat(d.home > 0 ? [{ code: 'HOME', h: d.home, s: d.homeS || 540 }] : []);
      out[s.code] = crossOn ? cx.reqFt8Split_(s.h, { sched_home: 'HOME', own_fs: s.s }, P(others), true).here : cx.reqStrictOtNeed_(s.h, '').need;
    });
    return out;
  }
  function payNeed(o) {
    const b = build(o), m = J(S.call('payOtFormCheck_', b.att, { ft: o.ft })).missing, out = {};
    m.forEach((x) => { out[x.store || ''] = x.need; });
    return out;
  }
  const norm = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v > 0.25).map(([k, v]) => [k, r2(v)]).sort());
  const one = (o) => norm(payNeed(o));
  const DT = '2026-11-20';
  chk('V6 休息日 原5＋A5（正職）：只要原單位 5（以前還要 A 2）', one({ ft: true, days: [{ date: DT, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] }), { '': 5 });
  chk('V6 國定假日假那格 原4＋A6：都不要', one({ ft: true, days: [{ date: DT, cell: 'G', hol: true, home: 4, sups: [{ code: 'MZTJS', h: 6, s: 840 }] }] }), {});
  chk('V6 計時 原6＋A4：都不要（以前要 A 2）', one({ ft: false, days: [{ date: DT, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }), {});
  chk('V6 計時 原10＋A1：原 2', one({ ft: false, days: [{ date: DT, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }), { '': 2 });
  chk('V6 正職平日 原10＋A1：原 2、A 1（照舊擋）', one({ ft: true, days: [{ date: DT, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }), { '': 2, MZTJS: 1 });
  chk('V6 正職平日 原6＋A4：A 2（照舊擋）', one({ ft: true, days: [{ date: DT, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }), { MZTJS: 2 });
  chk('V6 正職國定假日出勤（班表 W）原4＋A6：照跨店拆 A 2（打卡端那天 sched_ft＝true）', one({ ft: true, days: [{ date: DT, hol: true, home: 4, sups: [{ code: 'MZTJS', h: 6, s: 840 }] }] }), { MZTJS: 2 });
  // 沒帶 opt（舊呼叫端）＝照舊
  { const b = build({ ft: false, days: [{ date: DT, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] });
    chk('V6 沒帶 opt 照舊（計時 原6＋A4 仍要 A 2）', J(S.call('payOtFormCheck_', b.att)).missing.map((x) => [x.store, x.need]), [['MZTJS', 2]]); }
  // 隨機 3000 組逐案一致（只比單一天；fs 都不同，避開打卡端沒有的「代碼小」並列規則）
  let bad = 0, n = 0, nonEmpty = 0; const ex1 = [];
  for (let i = 0; i < 3000; i++) {
    const o = randomCase(); const d = o.days[0]; d.date = DT; o.days = [d];
    if (d.elec) { d.elec = false; }   // 選舉日那格是 W：打卡端一樣跨店拆，薪資也一樣（上面已測），這裡省略
    const a = norm(payNeed(o)), b = norm(reqNeed(o, d));
    n++; if (Object.keys(b).length) nonEmpty++;
    if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; if (ex1.length < 3) ex1.push({ o: d, pay: a, req: b, ft: o.ft }); }
  }
  chk('V6 隨機 ' + n + ' 組：薪資要的單＝打卡端要的單', bad, 0);
  if (bad) console.log(JSON.stringify(ex1));
  chk('V6 隨機情境有要單的不是少數', nonEmpty > 500, true);
}

/* ── a11 損益端點：被支援門市的他店支援人力成本（xsup_cost）── */
{
  const mk = (rows) => H.load({ today: '2026-12-05', data: rows });
  const det = (sup) => JSON.stringify({ v: 1, co_auto: {}, emp: [], sup });
  const data = {
    run: [{ ym: '2026-11', store: 'MZTGF', status: 'final' }, { ym: '2026-11', store: 'HQ', status: 'final' }, { ym: '2026-11', store: 'MZTJS', status: 'draft' },
          { ym: '2026-10', store: 'MZTGF', status: 'final' }, { ym: '2026-10', store: 'HQ', status: 'final' }],
    cost_snapshot: [
      { ym: '2026-11', store: 'MZTGF', support_json: '{}', total: 1, detail_json: det([]) },
      { ym: '2026-11', store: 'HQ', support_json: '{}', total: 1, detail_json: det([{ emp_id: 'a', store: '墨光', code: 'MZTGF', amount: 1000.5 }, { emp_id: 'b', store: '金山', code: 'MZTJS', amount: 99 }, { emp_id: 'c', store: '墨光', code: 'MZTGF', amount: 200 }]) },
      { ym: '2026-10', store: 'MZTGF', support_json: '{}', total: 1, detail_json: det([]) },
      { ym: '2026-10', store: 'HQ', support_json: '{}', total: 1, detail_json: det([{ emp_id: 'a', store: '墨光', amount: 500 }]) },
    ] };
  const W = mk(data);
  vm.runInContext('checkPnlKey_=function(){return null}; payCostSnapRows_=function(){return payRead("cost_snapshot")};', W);
  const n11 = J(W.call('handlePnlPayroll_', { key: 'k', ym: '2026-11', store: 'MZTGF' }));
  chk('a11 2026-11 墨光：總部請墨光的合計 1,200.5（金山那筆不算）', n11.rows.xsup_cost, 1200.5);
  chk('a11 回應頂層欄位不變', Object.keys(n11).sort(), ['ok', 'rows', 'store', 'support', 'total', 'ym']);
  const n10 = J(W.call('handlePnlPayroll_', { key: 'k', ym: '2026-10', store: 'MZTGF' }));
  chk('a11 2026-10：rows 沒有 xsup_cost（逐欄不變）', 'xsup_cost' in n10.rows, false);
  chk('a11 快照白名單保留 code', J(W.call('paySnapDetailSanitize_', { sup: [{ emp_id: 'a', store: '墨光', code: 'mztgf', amount: 1 }] })).sup[0].code, 'MZTGF');
}

console.log('\n' + (f ? '❌' : '✅') + ' 跨店請款 N4：' + p + ' 過、' + f + ' 失敗');
process.exit(f ? 1 : 0);
