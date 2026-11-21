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
  const support = xEntry.stores.map((s) => ({ code: s.code, store: s.name, hours: (o.supPaid && o.supPaid[s.code] != null) ? o.supPaid[s.code] : s.hours, rate: 200, amount: '', auto: true }));
  const supH = support.reduce((a, s) => a + s.hours, 0);
  const homeSum = r2(Object.keys(col.day_h).reduce((a, k) => a + col.day_h[k], 0));
  const daily = E.call('payDailyFor_', e, YM, col, xEntry, sched, hol, '', supH, elec);
  const att = H.baseAtt({ hours: homeSum, support, daily, leaves: o.comp ? { comp: o.comp } : {},
    holiday_h: r2(hol.reduce((a, d) => a + (col.day_h[d] || 0), 0)) });
  att.sup_hol = E.call('paySupportHolDouble_', support, xEntry, hol, STORE_BY, '');
  if (elec.length) {
    att.elec_h = E.call('payElecOwnH_', col, elec);
    att.sup_elec = vm.runInContext('typeof paySupportElecDouble_', E) === 'function'   // #209 改版（Codex B2）：國定假日先用掉採計支援時數，選舉日只拿剩下的
      ? E.call('paySupportElecDouble_', support, xEntry, hol, elec, STORE_BY, '') : E.call('paySupportHolDouble_', support, xEntry, elec, STORE_BY, '');
  }
  if (o.hours != null) att.hours = o.hours;
  if (o.holManual) att.elec_hol_manual = true;
  if (xEntry.stores.length) {
    if (vm.runInContext('typeof payOtCrossDays_', E) === 'function') att.ot_xdays = E.call('payOtCrossDays_', col, xEntry);
    att.ot_cross = E.call('payOtCrossNeed_', col, xEntry);
    att.ot_cross_legacy = E.call('payOtCrossNeed_', col, xEntry, true);   // 同 handlePayrollCalc（r5；正式版的函式沒有第三個參數＝照它自己的順序）
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
  const xa = J(S.call('pnlSupXAddAll_', r, b.att.support, b.att.support.map(() => 200)));
  b.att.support.forEach((x, i) => { out[x.code] = r2((out[x.code] || 0) + x.hours * 200 + xa[i].add); });
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

/* ── #209 改版後：計時假日加倍的請款 hx 一律用「實際有加發的時數」（不可超過同仁領到的） ── */
{
  const paidOf = (r, name) => r2(r.earn.filter((x) => x.item_key === 'holiday_double' && x.item_label.indexOf('（支援' + name + '）') >= 0).reduce((a, x) => a + x.qty, 0));
  const hxOf = (r, code) => ((r.ot_info.xclaim || []).find((x) => x.code === code) || { hx: 0 }).hx;
  // elec_warn hol_manual：國定假日時數被手改過 → 本店與支援都不自動加發（#209 定版、主管 11/22 確認 PAY_ELEC_MANUAL_STOPS_SUP）→ 請款也不可以有 hx
  //   （r2 rebase 前 payOtCrossClaim_ 直接讀 att.sup_elec，這裡會請 hx 4＝同仁沒領到的錢也請款）
  const m = claims({ ft: false, holManual: true, days: [{ date: D2, home: 6 }, { date: D, elec: true, home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] });
  chk('elec_warn hol_manual：提醒原因', m.r.ot_info.elec_warn && m.r.ot_info.elec_warn.reason, 'hol_manual');
  chk('elec_warn hol_manual：本店、支援選舉日都沒加發（holiday_double 0、支援 0）→ 請款 hx 0', [H.item(m.r, 'holiday_double'), paidOf(m.r, '金山'), hxOf(m.r, 'MZTJS')], [0, 0, 0]);
  chk('elec_warn hol_manual：請款＝只有支援時數 4×200（沒有任何加成）', m.claims, { MZTJS: 800 });
  // 手填衝突、當天只在支援店（本店 0）：同樣不請
  const m0 = claims({ ft: false, holManual: true, days: [{ date: D2, home: 6 }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] });
  chk('elec_warn hol_manual（只在支援店 8h）：支援沒加發、請款 1600（只有時數）', [paidOf(m0.r, '金山'), hxOf(m0.r, 'MZTJS'), m0.claims.MZTJS], [0, 0, 1600]);
  // 翻轉點 PAY_ELEC_MANUAL_STOPS_SUP＝false → 支援照發 4、請款 hx 也是 4（兩邊永遠同一份 payElecSupPaid_）
  vm.runInContext('PAY_ELEC_MANUAL_STOPS_SUP = false', S);
  const mF = claims({ ft: false, holManual: true, days: [{ date: D2, home: 6 }, { date: D, elec: true, home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] });
  vm.runInContext('PAY_ELEC_MANUAL_STOPS_SUP = true', S);
  chk('翻轉點 false：支援加發 4＝請款 hx 4', [paidOf(mF.r, '金山'), hxOf(mF.r, 'MZTJS')], [4, 4]);
  // elec_warn cap：總時數被手動調低 → 本店只發剩下的；支援店那段不受影響
  const c = claims({ ft: false, hours: 2, days: [{ date: D, elec: true, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] });
  chk('elec_warn cap：提醒原因、本店只發 2', [c.r.ot_info.elec_warn && c.r.ot_info.elec_warn.reason, c.r.ot_info.elec_warn && c.r.ot_info.elec_warn.paid], ['cap', 2]);
  chk('elec_warn cap：支援店加發 4＝請款 hx 4（本店那段本來就不請）', [paidOf(c.r, '金山'), hxOf(c.r, 'MZTJS')], [4, 4]);
  // 採計支援時數不夠（支援列只算 5h，實際國定 4＋選舉日 4）：國定先用 4、選舉日只剩 1 → 請 5，不是 8
  const sh = claims({ ft: false, supPaid: { MZTJS: 5 }, days: [{ date: '2026-11-03', hol: true, home: 0, sups: [{ code: 'MZTJS', h: 4, s: 600 }] }, { date: D, elec: true, home: 0, sups: [{ code: 'MZTJS', h: 4, s: 600 }] }, { date: D2, home: 6 }] });
  chk('支援採計 5h：國定 4＋選舉日 1＝加發 5＝請款 hx 5', [paidOf(sh.r, '金山'), hxOf(sh.r, 'MZTJS')], [5, 5]);
  // 隨機計時情境：每家店 hx ＝ 例假那幾天在那家的時數 ＋ 實際發的「（支援○○）」加倍時數
  let bad = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const o = randomCase(); if (o.ft) continue;
    if (rnd() < 0.3) o.holManual = true;
    if (rnd() < 0.3) o.hours = Math.round(rnd() * 20) / 2;
    const b = build(o), r = calc(b); n++;
    const rdo = {}; o.days.forEach((d) => { if (d.cell === 'R' && !d.hol && !d.elec) d.sups.forEach((s) => { if (s.h > 0) rdo[s.code] = r2((rdo[s.code] || 0) + s.h); }); });
    b.att.support.forEach((x) => { if (r2(hxOf(r, x.code)) !== r2((rdo[x.code] || 0) + paidOf(r, x.store))) bad++; });
  }
  chk('計時隨機 ' + n + ' 組：請款 hx＝例假支援時數＋實際發的支援加倍時數', bad, 0);
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
  vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x};const r2=v=>Math.round(v*100)/100;const ym=()=>"2026-11";const esc=v=>String(v);const nf=v=>String(v);' + HTML.slice(ai, bi), sbF);
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
  // 「沒有門市代碼」提醒：舊快照（detail.sup 沒有 code 欄）不提醒；新快照只算 code 欄存在但是空的；草稿手填沒代碼要算
  vm.runInContext('STATUS="final";COST_SNAP={support:{"金山":100,"六張犁":50},detail:{sup:[{emp_id:"X0",store:"金山",hours:6,rate:200,amount:100},{emp_id:"X1",store:"六張犁",hours:2,rate:200,amount:50}]}};', sbF);
  chk('提醒：舊快照（沒有 code 欄）→ 0', vm.runInContext('supNoCodeN(costTotals())', sbF), 0);
  vm.runInContext('COST_SNAP={support:{"金山":100,"手填店":50},detail:{sup:[{emp_id:"X0",store:"金山",code:"MZTJS",hours:6,rate:200,amount:100},{emp_id:"X1",store:"手填店",code:"",hours:2,rate:200,amount:50}]}};', sbF);
  chk('提醒：新快照混合（一筆有代碼、一筆空）→ 1', vm.runInContext('supNoCodeN(costTotals())', sbF), 1);
  vm.runInContext('STATUS="draft";COST_SNAP=null;ATT.X0={support:ATT.X0.support.concat([{store:"手填店",hours:3,rate:200,amount:""}])};', sbF);
  chk('提醒：草稿手填沒代碼 → 1', vm.runInContext('supNoCodeN(costTotals())', sbF), 1);
  chk('提醒：草稿手填沒代碼 → 請款區多一列提醒', vm.runInContext('costRows(costTotals()).some(r=>r[0]==="h"&&/沒有門市代碼/.test(r[1]))', sbF), true);
  vm.runInContext('ATT.X0={support:ATT.X0.support.filter(x=>x.code)};', sbF);
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
  // r3（Codex 擋項 4）：國定假日＋班表休息日 H 重疊（薪資國定假日清單優先＝正式版不擋），D5 不可以多擋
  chk('V6 國定＋班表 H 重疊 原4＋A4（正職、都沒單）：不擋', one({ ft: true, days: [{ date: DT, cell: 'H', hol: true, home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }), {});
  chk('V6 國定＋班表 H 重疊 原4＋A4（計時）：不擋', one({ ft: false, days: [{ date: DT, cell: 'H', hol: true, home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }), {});
  chk('V6 國定＋班表 R 重疊 原6＋A3（正職）：只擋超過 8 那段（A 吸收 1，同正式版）', one({ ft: true, days: [{ date: DT, cell: 'R', hol: true, home: 6, sups: [{ code: 'MZTJS', h: 3, s: 900 }] }] }), { MZTJS: 1 });
  chk('V6 國定＋班表 H 重疊 只在支援店 A 10（正職）：正式版要 A 2', one({ ft: true, days: [{ date: DT, cell: 'H', hol: true, home: 0, sups: [{ code: 'MZTJS', h: 10, s: 600 }] }] }), { MZTJS: 2 });
  chk('V6 國定＋班表 H 重疊 原10＋A1（正職）：原 2（正式版另要 A 1；D5 支援店自己沒超過 8 不要＝放寬）', one({ ft: true, days: [{ date: DT, cell: 'H', hol: true, home: 10, sups: [{ code: 'MZTJS', h: 1, s: 1260 }] }] }), { '': 2 });
  chk('V6 國定＋班表 H 重疊 原4＋A4 本店有 4 小時單：不擋', (() => { const b = build({ ft: true, formsHome: { [DT]: 4 }, days: [{ date: DT, cell: 'H', hol: true, home: 4, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] }); return J(S.call('payOtFormCheck_', b.att, { ft: true })).missing; })(), []);
  chk('V6 兩家支援都超過 8（計時 原0、A 9 B 9.5，B 後上）：B 1.5（正式版要 B 9.5＋原 1；打卡端還要 A 1，薪資不要＝不比正式版嚴）', one({ ft: false, days: [{ date: DT, home: 0, sups: [{ code: 'MZTJS', h: 9, s: 600 }, { code: 'MZTLZL', h: 9.5, s: 700 }] }] }), { MZTLZL: 1.5 });
  // 沒帶 opt（舊呼叫端）＝照舊
  { const b = build({ ft: false, days: [{ date: DT, home: 6, sups: [{ code: 'MZTJS', h: 4, s: 900 }] }] });
    chk('V6 沒帶 opt 照舊（計時 原6＋A4 仍要 A 2）', J(S.call('payOtFormCheck_', b.att)).missing.map((x) => [x.store, x.need]), [['MZTJS', 2]]); }
  // 隨機 3000 組逐案一致（只比單一天；fs 都不同，避開打卡端沒有的「代碼小」並列規則）
  let bad = 0, n = 0, nonEmpty = 0, same = 0; const ex1 = [];
  for (let i = 0; i < 3000; i++) {
    const o = randomCase(); const d = o.days[0]; d.date = DT; o.days = [d];
    if (d.elec) { d.elec = false; }   // 選舉日那格是 W：打卡端一樣跨店拆，薪資也一樣（上面已測），這裡省略
    const a = norm(payNeed(o)), b = norm(reqNeed(o, d));
    const bo = build(o), old = {}; J(S.call('payOtFormCheck_', bo.att)).missing.forEach((x) => { old[x.store || ''] = x.need; });
    const on = norm(old);
    n++; if (Object.keys(b).length) nonEmpty++;
    if (JSON.stringify(a) === JSON.stringify(b)) same++;
    // r3（Codex 擋項 4）：D5 只放寬——每家要的單不可以多於打卡端，也不可以多於正式版規則
    if (Object.keys(a).some((k) => a[k] > (b[k] || 0) + 0.005 || a[k] > (on[k] || 0) + 0.005)) { bad++; if (ex1.length < 3) ex1.push({ o: d, pay: a, req: b, old: on, ft: o.ft }); }
  }
  chk('V6 隨機 ' + n + ' 組：薪資要的單 ≤ 打卡端、≤ 正式版規則（D5 只放寬）', bad, 0);
  chk('V6 隨機：大多數跟打卡端完全一樣（剩下的是兩家支援都超過 8 小時、正式版只要吸收那家）', same > n * 0.9, true);
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
  chk('a11 回應頂層欄位：多 xsup_pending（r3 SHOULD-FIX a），其餘不變', Object.keys(n11).sort(), ['ok', 'rows', 'store', 'support', 'total', 'xsup_pending', 'ym']);
  chk('r3-a xsup_pending＝同月還沒鎖的別家（金山草稿）', n11.xsup_pending, ['MZTJS']);
  const n10 = J(W.call('handlePnlPayroll_', { key: 'k', ym: '2026-10', store: 'MZTGF' }));
  chk('a11 2026-10：rows 沒有 xsup_cost（逐欄不變）', 'xsup_cost' in n10.rows, false);
  chk('r3-a 2026-10：沒有 xsup_pending（逐欄不變）', 'xsup_pending' in n10, false);
  chk('a11 快照白名單保留 code', J(W.call('paySnapDetailSanitize_', { sup: [{ emp_id: 'a', store: '墨光', code: 'mztgf', amount: 1 }] })).sup[0].code, 'MZTGF');
}

/* ── r3（Codex 2026-11-22 擋項 1、2、3、5、6）── */
{
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  const ai = HTML.indexOf('const COST_REDUCE_EXTRA='), bi = HTML.indexOf('function renderCost(){');
  const sbF = { console };
  vm.createContext(sbF);
  vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x};const r2=v=>Math.round(v*100)/100;const ym=()=>"2026-11";const esc=v=>String(v);const nf=v=>String(v);' + HTML.slice(ai, bi), sbF);
  const RD = { ft: true, days: [{ date: D, cell: 'H', home: 5, sups: [{ code: 'MZTJS', h: 5, s: 900 }] }] };   // 休息日 原5＋A5 → 2,020.5
  /** rows：支援列（覆蓋 build 的自動列）；回 { front:{supTotal, rows}, back:{請款合計}, text:[請款明細文字] } */
  function cost(o, rows) {
    const b = build(o); b.e.emp_id = 'Y1'; b.e.name = '同仁Y'; const r = calc(b);
    const att = { Y1: { support: rows } };
    vm.runInContext('RESULTS=' + JSON.stringify([r]) + ';MASTER=' + JSON.stringify([b.e]) + ';ATT=' + JSON.stringify(att) + ';CFG=' + JSON.stringify(H.cfg) + ';STATUS="draft";COST_SNAP=null;', sbF);
    const g = J(vm.runInContext('(function(){const g=costTotals();return {supTotal:g.supTotal,sup:g.sup};})()', sbF));
    const back = J(S.call('pnlEstimateClassify_', [r], [b.e], att, H.cfg, YM));
    const backTot = r2(Object.values(back.support || {}).reduce((a, v) => a + v, 0));
    const text = J(vm.runInContext('costRows(costTotals()).filter(x=>/→/.test(String(x[0]))).map(x=>[x[0],Math.round(x[1]*100)/100])', sbF));
    const detail = J(vm.runInContext('costDetail(costTotals())', sbF));
    return { r, b, front: r2(g.supTotal), back: backTot, sup: g.sup, text, detail, att };
  }
  const row = (code, store, hours, amount) => ({ code, store, hours, rate: 200, amount: amount == null ? '' : amount, auto: false });
  // 擋項 1：同一人同一店拆成好幾筆 → 加成只入帳一次
  const one = cost(RD, [row('MZTJS', '金山', 5)]);
  chk('r3-1 一筆 5h：前端＝後端＝2,020.5', [one.front, one.back], [2020.5, 2020.5]);
  const two = cost(RD, [row('MZTJS', '金山', 2), row('MZTJS', '金山', 3)]);
  chk('r3-1 同店拆 2＋3：前端＝後端＝2,020.5（修正前 3,041）', [two.front, two.back], [2020.5, 2020.5]);
  const three = cost(RD, [row('MZTJS', '金山', 1), row('MZTJS', '金山', 1), row('MZTJS', '金山', 3)]);
  chk('r3-1 同店拆 1＋1＋3：2,020.5', [three.front, three.back], [2020.5, 2020.5]);
  const mix = cost(RD, [Object.assign(row('MZTJS', '金山', 3), { auto: true }), row('MZTJS', '金山', 2)]);
  chk('r3-1 自動帶入 3＋手填 2（同店）：2,020.5，加成在第一筆', [mix.front, mix.back, mix.sup.map((x) => r2(x.otAdd))], [2020.5, 2020.5, [1020.5, 0]]);
  const sameName = cost(RD, [row('MZTJS', '金山', 5), row('MZTLZL', '金山', 1)]);
  chk('r3-1 兩邊都有代碼只比代碼：同名不同代碼那筆不加', [sameName.front, sameName.back, sameName.sup.map((x) => r2(x.otAdd))], [2220.5, 2220.5, [1020.5, 0]]);
  const noCode = cost(RD, [row('', '金山', 5)]);
  chk('r3-1 手填沒有代碼：照店名對到（同正式版）', [noCode.front, noCode.back], [2020.5, 2020.5]);
  // 擋項 2：金額指定＝整筆以填的為準，不另加加成（既有語意，不改）；前端、後端（月中估算同一支）、快照一致
  const fx = cost(RD, [row('MZTJS', '金山', 5, 1600)]);
  chk('r3-2 只有指定金額 1,600：請款＝1,600（不加不重複），前端＝後端', [fx.front, fx.back], [1600, 1600]);
  chk('r3-2 快照逐筆＝1,600、fixed、沒有加成', fx.detail.sup.map((x) => [x.amount, x.fixed, x.otAdd]), [[1600, true, 0]]);
  chk('r3-2 明細文字「（金額指定）」不帶加成', fx.text.map((x) => /金額指定/.test(x[0]) && !/加成/.test(x[0])), [true]);
  const fx2 = cost(RD, [row('MZTJS', '金山', 2, 1600), row('MZTJS', '金山', 3)]);
  chk('r3-2 同店 指定 1,600＋一般 3h：1,600＋600＋加成 1,020.5（加成給沒指定那筆、只一次）', [fx2.front, fx2.back], [3220.5, 3220.5]);
  // 擋項 5：鎖定後（快照）明細與草稿逐字相同；舊快照（沒有 otH／otAdd）照正式版讀法
  const draftText = two.text;
  const snapDet = J(S.call('paySnapDetailSanitize_', two.detail));
  vm.runInContext('RESULTS=' + JSON.stringify([two.r]) + ';ATT=' + JSON.stringify(two.att) + ';STATUS="final";COST_SNAP={support:{"金山":2020.5},detail:' + JSON.stringify(snapDet) + '};', sbF);
  const lockText = J(vm.runInContext('costRows(costTotals()).filter(x=>/→/.test(String(x[0]))).map(x=>[x[0],Math.round(x[1]*100)/100])', sbF));
  chk('r3-5 鎖定前後請款明細（含「＋加班／假日加成」）逐字相同（匯出共用 costRows）', lockText, draftText);
  chk('r3-5 草稿明細確實有加成文字', draftText.some((x) => /假日加成/.test(x[0])), true);
  const oldDet = J(snapDet); oldDet.sup.forEach((x) => { delete x.otH; delete x.otAdd; });
  vm.runInContext('COST_SNAP={support:{"金山":2020.5},detail:' + JSON.stringify(oldDet) + '};', sbF);
  chk('r3-5 舊快照（沒有 otH／otAdd）：照正式版讀法、不顯示加成', J(vm.runInContext('costRows(costTotals()).filter(x=>/→/.test(String(x[0]))).map(x=>x[0])', sbF)).every((t) => !/加成/.test(t)), true);
  chk('r3-5 白名單：舊前端沒送 otH／otAdd → 快照不帶這兩欄', 'otH' in J(S.call('paySnapDetailSanitize_', { sup: [{ emp_id: 'a', store: 'x', code: 'MZTJS', amount: 1 }] })).sup[0], false);
  vm.runInContext('STATUS="draft";COST_SNAP=null;', sbF);
  // 擋項 6：逐筆截斷前就做門市彙總，損益用彙總
  const many = []; for (let i = 0; i < 600; i++) many.push({ emp_id: 'e' + i, store: i % 2 ? '墨光' : '金山', code: i % 2 ? 'MZTGF' : 'MZTJS', amount: 10 });
  const sd = J(S.call('paySnapDetailSanitize_', { sup: many }));
  chk('r3-6 600 筆：逐筆留 500、彙總用全部 600 筆（墨光 3,000、金山 3,000）', [sd.sup.length, sd.sup_code], [500, { MZTJS: 3000, MZTGF: 3000 }]);
  const W6 = H.load({ today: '2026-12-05', data: { run: [{ ym: '2026-11', store: 'MZTGF', status: 'final' }, { ym: '2026-11', store: 'HQ', status: 'final' }],
    cost_snapshot: [{ ym: '2026-11', store: 'MZTGF', support_json: '{}', total: 1, detail_json: '{}' }, { ym: '2026-11', store: 'HQ', support_json: '{}', total: 1, detail_json: JSON.stringify(sd) }] } });
  vm.runInContext('checkPnlKey_=function(){return null}; payCostSnapRows_=function(){return payRead("cost_snapshot")};', W6);
  chk('r3-6 損益 xsup_cost 用彙總（第 501 筆以後也算到）', J(W6.call('handlePnlPayroll_', { key: 'k', ym: '2026-11', store: 'MZTGF' })).rows.xsup_cost, 3000);
  chk('r3-6 舊快照（逐筆沒有 code 欄）不產生彙總', 'sup_code' in J(S.call('paySnapDetailSanitize_', { sup: [{ emp_id: 'a', store: 'x', amount: 1 }] })), false);
  // 擋項 3：請款摘要／指紋 前後端逐字相同、2026-10 與沒有跨店的人是空的
  const rs = [two.r, J(calc(build({ ft: true, days: [{ date: D, home: 9 }] })))]; rs[1].emp_id = 'Y2';
  const rsStr = J(rs); rsStr.forEach((r) => { r.ot_info = JSON.stringify(r.ot_info); });   // 草稿表存的是 JSON 字串
  chk('r3-3 前端 xclaimFp＝後端 payXclaimFp_（物件／字串兩種 ot_info）', [vm.runInContext('xclaimFp("2026-11",' + JSON.stringify(rs) + ')', sbF), vm.runInContext('xclaimFp("2026-11",' + JSON.stringify(rsStr) + ')', sbF)], [S.call('payXclaimFp_', '2026-11', rs), S.call('payXclaimFp_', '2026-11', rs)]);
  chk('r3-3 2026-10：摘要空的（鎖月行為同正式版）', S.call('payXclaimSig_', '2026-10', two.r.ot_info), '');
  chk('r3-3 沒有跨店的人：摘要空的', S.call('payXclaimSig_', '2026-11', rs[1].ot_info), '');
  chk('r3-3 只差 xr／xclaim（上線前舊草稿）：摘要不同', S.call('payXclaimSig_', '2026-11', Object.assign({}, two.r.ot_info, { xr: undefined, xclaim: undefined })) !== S.call('payXclaimSig_', '2026-11', two.r.ot_info), true);
  // 兩天互換支援店（休息日 A／平日 B → 休息日 B／平日 A）：每店總時數、實領都一樣，請款摘要不同
  const sw1 = calc(build({ ft: true, days: [{ date: D, cell: 'H', home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }, { date: D2, home: 0, sups: [{ code: 'MZTLZL', h: 8, s: 600 }] }] }));
  const sw2 = calc(build({ ft: true, days: [{ date: D, cell: 'H', home: 0, sups: [{ code: 'MZTLZL', h: 8, s: 600 }] }, { date: D2, home: 0, sups: [{ code: 'MZTJS', h: 8, s: 600 }] }] }));
  chk('r3-3 兩天互換支援店：實領相同、請款摘要不同', [sw1.net === sw2.net, S.call('payXclaimSig_', '2026-11', sw1.ot_info) !== S.call('payXclaimSig_', '2026-11', sw2.ot_info)], [true, true]);
  // r4-1：同店同時有「沒代碼」與「有代碼」的列 → 加成給有代碼那筆（快照門市彙總 sup_code 只收有代碼的列，損益才不少算）
  const supCodeOf = (c) => J(S.call('paySnapDetailSanitize_', c.detail)).sup_code || {};
  const codedSum = (c) => r2(c.sup.filter((x) => String(x.code || '').trim()).reduce((a, x) => a + x.amount, 0));
  const nc1 = cost(RD, [row('', '金山', 2), Object.assign(row('MZTJS', '金山', 3), { auto: true })]);
  chk('r4-1 沒代碼在前＋自動帶入有代碼：合計 2,020.5 不變、加成在有代碼那筆、sup_code 1,620.5＝有代碼部分（修正前 600）', [nc1.front, nc1.back, nc1.sup.map((x) => r2(x.otAdd)), supCodeOf(nc1), codedSum(nc1)], [2020.5, 2020.5, [0, 1020.5], { MZTJS: 1620.5 }, 1620.5]);
  const nc2 = cost(RD, [Object.assign(row('MZTJS', '金山', 3), { auto: true }), row('', '金山', 2)]);
  chk('r4-1 有代碼在前＋沒代碼在後：一樣', [nc2.front, nc2.back, supCodeOf(nc2), codedSum(nc2)], [2020.5, 2020.5, { MZTJS: 1620.5 }, 1620.5]);
  const nc3 = cost(RD, [row('MZTJS', '金山', 2), row('MZTJS', '金山', 3)]);
  chk('r4-1 兩筆都有代碼：sup_code＝合計 2,020.5', [nc3.front, supCodeOf(nc3)], [2020.5, { MZTJS: 2020.5 }]);
  const nc4 = cost(RD, [row('', '金山', 2), row('', '金山', 3)]);
  chk('r4-1 兩筆都沒代碼：合計 2,020.5（照店名）、沒有門市彙總', [nc4.front, nc4.back, supCodeOf(nc4)], [2020.5, 2020.5, {}]);
  // r4-2：快照一格字數上限（Google 試算表一格 5 萬字；payReplaceAll 先清整張再寫）
  {
    const long = []; for (let i = 0; i < 400; i++) long.push({ emp_id: 'EMP' + String(i).padStart(5, '0'), ft: true, store: '某某某某某某某某支援門市' + (i % 7), code: i % 2 ? 'MZTGF' : 'MZTJS', hours: 12.25, rate: 213.33, gapH: 0, gapRate: 0, otH: 3.75, otAdd: 1234.56, amount: 3851.11, fixed: false });
    const emp = []; for (let i = 0; i < 60; i++) emp.push({ emp_id: 'E' + i, ft: true, ratio: 1, co_labor: 1000, co_health: 800, co_pension: 1500, yearend_months: 1, yearend: 3000, gap_rate: 0 });
    const others = [{ ym: '2026-10', store: 'MZTGF', support_json: '{}', total: 1, detail_json: '{}' }, { ym: '2026-11', store: 'HQ', support_json: '{}', total: 2, detail_json: '{}' }];
    const W = H.load({ today: '2026-12-05', data: { cost_snapshot: J(others) } });
    const fullLen = JSON.stringify(J(W.call('paySnapDetailSanitize_', { sup: long, emp }))).length;
    W.call('pnlSnapshotUpsert_', '2026-11', 'MZTGF', { total: 99, support: { '墨光': 1 }, detail: { co_auto: {}, emp, sup: long } });
    const rows = J(vm.runInContext('__DATA.cost_snapshot', W));
    const maxCell = Math.max(...rows.map((r) => Math.max(...Object.values(r).map((v) => String(v == null ? '' : v).length))));
    const mine = rows.find((r) => r.ym === '2026-11' && r.store === 'MZTGF'), d = JSON.parse(mine.detail_json);
    chk('r4-2 400 筆支援列（未截前 ' + fullLen + ' 字）：寫入的每一格 ≤ 45,000 字', [fullLen > 50000, maxCell <= 45000], [true, true]);
    chk('r4-2 其他月份／其他店的快照列都還在', rows.filter((r) => r !== mine).map((r) => r.ym + r.store).sort(), ['2026-10MZTGF', '2026-11HQ']);
    chk('r4-2 sup_code 用全部 400 筆（各 200 筆 × 3,851.11）、留截斷旗標、逐筆少於 400', [d.sup_code, d.sup_trunc, d.sup.length < 400 && d.sup.length > 100], [{ MZTJS: r2(200 * 3851.11), MZTGF: r2(200 * 3851.11) }, 400, true]);
    const W2 = H.load({ today: '2026-12-05', data: { cost_snapshot: J(others) } });
    vm.runInContext('payRead = (function(o){ return function(k){ if (k === "cost_snapshot") throw new Error("讀表失敗"); return o(k); }; })(payRead);', W2);
    let threw = false; try { W2.call('pnlSnapshotUpsert_', '2026-11', 'MZTGF', { total: 1, support: {}, detail: null }); } catch (e) { threw = true; }
    chk('r4-2 讀不到現有快照：不寫（丟出去給鎖定流程記稽核），別店別月的快照還在', [threw, J(vm.runInContext('__DATA.cost_snapshot', W2)).length], [true, 2]);
    // 畫面：逐筆被截過 → 改用門市合計（既有顯示，不加新字），合計不少
    vm.runInContext('RESULTS=[];STATUS="final";COST_SNAP={support:{"金山":770222,"墨光":770222},detail:' + JSON.stringify(d) + '};', sbF);
    chk('r4-2 鎖定畫面：逐筆被截過 → 用門市合計列、請款合計＝1,540,444', J(vm.runInContext('(function(){const g=costTotals();return [g.sup.every(x=>x.storeOnly),g.supTotal];})()', sbF)), [true, 1540444]);
    vm.runInContext('STATUS="draft";COST_SNAP=null;', sbF);
  }
  // r5-1：鎖月存的請款由後端產生（paySupClaimRows_＋paySnapWithSup_），正常流程跟畫面算的逐欄相同 → 鎖後快照＝畫面＝重算（5,000 組）
  {
    let bad = 0, n5 = 0; const ex5 = [];
    for (let i = 0; i < 5000; i++) {
      const o = randomCase(); const b = build(o); if (!b.att.support.length) continue;
      b.e.emp_id = 'Z1'; b.e.name = '同仁Z';
      if (rnd() < 0.3) { const x = b.att.support[0]; b.att.support.splice(1, 0, Object.assign({}, x, { hours: 1, auto: false })); }   // 同店多一筆
      if (rnd() < 0.15) b.att.support[0].amount = 1234;   // 指定金額
      if (rnd() < 0.15) b.att.support.push({ store: '手填店', hours: 2, rate: 200, amount: '' });   // 沒代碼
      const r = calc(b), att = { Z1: { support: b.att.support } };
      vm.runInContext('RESULTS=' + JSON.stringify([r]) + ';MASTER=' + JSON.stringify([b.e]) + ';ATT=' + JSON.stringify(att) + ';CFG=' + JSON.stringify(H.cfg) + ';STATUS="draft";COST_SNAP=null;', sbF);
      const front = J(vm.runInContext('(function(){const g=costTotals();return {support:costStable(g).support,sup:costDetail(g).sup};})()', sbF));
      const rows = J(S.call('paySupClaimRows_', YM, [r], [b.e], { Z1: b.att.support }, H.cfg));
      const snap = J(S.call('paySnapWithSup_', { total: 1 }, rows));
      n5++;
      if (JSON.stringify(front.support) !== JSON.stringify(snap.support) || JSON.stringify(front.sup) !== JSON.stringify(snap.detail.sup)) { bad++; if (ex5.length < 2) ex5.push({ front, snap }); }
    }
    chk('r5-1 正常流程 ' + n5 + ' 組：後端產生的請款快照（門市合計、逐筆）＝畫面算的，逐欄相同', bad, 0);
    if (bad) console.log(JSON.stringify(ex5).slice(0, 1500));
  }
  // r5-2：門市代碼大小寫、前後空白混用
  {
    const W = H.load({ today: '2026-12-05', data: { run: [{ ym: '2026-11', store: 'a01', status: 'final' }, { ym: '2026-11', store: 'B02', status: 'final' }, { ym: '2026-11', store: ' c03 ', status: 'draft' }],
      cost_snapshot: [{ ym: '2026-11', store: 'a01', support_json: '{}', total: 1, detail_json: '{}' },
        { ym: '2026-11', store: 'B02', support_json: '{}', total: 1, detail_json: JSON.stringify(J(S.call('paySnapDetailSanitize_', { sup: [{ emp_id: 'x', store: 'A店', code: ' a01 ', amount: 2000 }] }))) }] } });
    vm.runInContext('checkPnlKey_=function(){return null}; payCostSnapRows_=function(){return payRead("cost_snapshot")};', W);
    const q = (st) => { const o = J(W.call('handlePnlPayroll_', { key: 'k', ym: '2026-11', store: st })); return [o.rows.xsup_cost, o.xsup_pending]; };
    chk('r5-2 快照寫入時代碼正規化成大寫（" a01 " → A01）', Object.keys(JSON.parse(J(vm.runInContext('__DATA.cost_snapshot', W))[1].detail_json).sup_code), ['A01']);
    chk('r5-2 用小寫 a01 查：找得到 B02 請 A01 的 2,000；還沒鎖的 c03 列進 pending', q('a01'), [2000, [' c03 ']]);
    const W2 = H.load({ today: '2026-12-05', data: { run: [{ ym: '2026-11', store: 'A01', status: 'final' }, { ym: '2026-11', store: 'B02', status: 'final' }],
      cost_snapshot: [{ ym: '2026-11', store: 'A01', support_json: '{}', total: 1, detail_json: '{}' }, { ym: '2026-11', store: 'B02', support_json: '{}', total: 1, detail_json: JSON.stringify({ v: 1, sup: [], sup_code: { a01: 500 } }) }] } });
    vm.runInContext('checkPnlKey_=function(){return null}; payCostSnapRows_=function(){return payRead("cost_snapshot")};', W2);
    chk('r5-2 既有資料相容：彙總鍵是小寫 a01、用大寫 A01 查也對得到', J(W2.call('handlePnlPayroll_', { key: 'k', ym: '2026-11', store: 'A01' })).rows.xsup_cost, 500);
    const rr = calc(build(RD)); rr.ot_info.xclaim[0].code = ' mztjs ';
    chk('r5-2 請款列比對：引擎代碼 " mztjs "、支援列 "MZTJS" 也算同一家', r2(J(S.call('pnlSupXAddAll_', rr, [{ code: 'MZTJS', store: 'X', hours: 5 }], [200]))[0].add), 1020.5);
  }
  // r5-C：同支援群組、這個月連草稿都沒有的店也列進 xsup_pending（停用、別群組、沒有群組不列）
  {
    const W = H.load({ today: '2026-12-05', data: { run: [{ ym: '2026-11', store: 'MZTGF', status: 'final' }, { ym: '2026-11', store: 'HQ', status: 'final' }],
      store: [{ code: 'MZTGF', support_group: 'mzt', active: 'true' }, { code: 'HQ', support_group: '*', active: 'true' }, { code: 'MZTJS', support_group: 'mzt', active: 'true' },
              { code: 'MZTOLD', support_group: 'mzt', active: 'false' }, { code: 'SSLGF', support_group: 'sxl', active: 'true' }, { code: 'NOGRP', support_group: '', active: 'true' }],
      cost_snapshot: [{ ym: '2026-11', store: 'MZTGF', support_json: '{}', total: 1, detail_json: '{}' }, { ym: '2026-11', store: 'HQ', support_json: '{}', total: 1, detail_json: '{}' }] } });
    vm.runInContext('checkPnlKey_=function(){return null}; payCostSnapRows_=function(){return payRead("cost_snapshot")};', W);
    chk('r5-C 墨光：同群組沒草稿的金山列進 pending（停用的、小辛辣、沒群組的不列）', J(W.call('handlePnlPayroll_', { key: 'k', ym: '2026-11', store: 'MZTGF' })).xsup_pending, ['MZTJS']);
  }
  // r5-3（Codex 擋項 3）：正職上班日 本店 2＋B 4＋A 4（同時開始、帶入順序 B、A），只有 B 有 2 小時單 → 正式版放行、新版也要放行
  {
    const DX = '2026-11-12';   // 加班單檢查 11/11 起算
    const b = build({ ft: true, formsSup: { MZTLZL: { [DX]: 2 } }, days: [{ date: DX, home: 2, sups: [{ code: 'MZTLZL', h: 4, s: 600 }, { code: 'MZTJS', h: 4, s: 600 }] }] });
    const b0 = build({ ft: true, days: [{ date: DX, home: 2, sups: [{ code: 'MZTLZL', h: 4, s: 600 }, { code: 'MZTJS', h: 4, s: 600 }] }] });
    chk('r5-3 對照：都沒有單時照正式版要 B 2（兩邊缺在不同店 → 用正式版那筆，不會整天都不要單）', J(S.call('payOtFormCheck_', b0.att, { ft: true })).missing.map((x) => [x.store, x.need]), [['MZTLZL', 2]]);
    chk('r5-3 同分（時數、開始都一樣）帶入順序 B、A、只有 B 有單：不擋（正式版取先遇到的 B）', J(S.call('payOtFormCheck_', b.att, { ft: true })).missing, []);
    chk('r5-3 請款照定案取代碼小的 A（這個不變）', b.att.ot_xdays[DX].abs.code, 'MZTJS');
  }
  // r5-4（殘餘 4）：同店只有「有代碼的指定金額列」＋「沒代碼的一般列」→ 加成給沒代碼那列，提醒的 N 有算到它
  {
    const c = cost(RD, [row('MZTJS', '金山', 3, 1600), row('', '金山', 2)]);
    vm.runInContext('RESULTS=' + JSON.stringify([c.r]) + ';ATT=' + JSON.stringify(c.att) + ';STATUS="draft";COST_SNAP=null;', sbF);
    chk('r5-4 加成給沒代碼的一般列、提醒「有 1 筆支援列沒有門市代碼…」', [c.sup.map((x) => r2(x.otAdd)), vm.runInContext('supNoCodeN(costTotals())', sbF), vm.runInContext('costRows(costTotals()).some(r=>r[0]==="h"&&/^有 1 筆支援列沒有門市代碼/.test(r[1]))', sbF)], [[0, 1020.5], 1, true]);
  }
  // r5-5（殘餘 5）：逐筆被截斷時，畫面請款合計用快照的 sup_total（不受 support_json 50 個門市名稱上限影響）
  {
    const many = []; for (let i = 0; i < 60; i++) many.push({ emp_id: 'e' + i, store: '門市' + i, code: 'C' + i, amount: 100 });
    const sd = J(S.call('paySnapDetailSanitize_', { sup: many }));
    const sp = J(S.call('pnlSanitizeSupport_', Object.fromEntries(many.map((x) => [x.store, x.amount]))));
    chk('r5-5 support_json 只留 50 個門市（既有上限）、sup_total 用全部 60 筆', [Object.keys(sp).length, sd.sup_total], [50, 6000]);
    const d = Object.assign({}, sd, { sup_trunc: 60, sup: sd.sup.slice(0, 10) });
    vm.runInContext('RESULTS=[];STATUS="final";COST_SNAP={support:' + JSON.stringify(sp) + ',detail:' + JSON.stringify(d) + '};', sbF);
    chk('r5-5 截斷後畫面請款合計＝6,000（不是 support_json 的 5,000）', vm.runInContext('costTotals().supTotal', sbF), 6000);
    vm.runInContext('STATUS="draft";COST_SNAP=null;', sbF);
  }
  // r5-B：一天本店＋三家支援店（休息日、平日），各店分攤 ≥ 0、合計＝當天同仁實際多拿的加成
  {
    const days = (cell) => [{ date: D, cell, home: 3, sups: [{ code: 'MZTJS', h: 4, s: 600 }, { code: 'MZTLZL', h: 3.5, s: 700 }, { code: 'MZTMC', h: 2.5, s: 800 }] }];
    [['H', '休息日'], ['W', '平日']].forEach(([cell, nm]) => {
      const b = build({ ft: true, days: days(cell) }), r = calc(b), xc = r.ot_info.xclaim || [];
      const otS = S.call('payOtDailySum', Object.assign({}, b.att.daily, { comp_h: 0 }));
      const bd = otS.day_break[D], left = (otS.ot_left || {})[D] || { w43: 0, w53: 0 };
      const paid = cell === 'H' ? bd.r43 * 0.34 + bd.r53 * 0.67 + bd.r83 * 1.67 : left.w43 * 0.34 + left.w53 * 0.67;
      const sh = J(S.call('payXclaimShare_', b.att.ot_xdays[D]));
      const mh = (c) => c.h43 * 0.34 + c.h53 * 0.67 + c.r43 * 0.34 + c.r53 * 0.67 + c.r83 * 1.67 + c.d8 + c.hx;
      const claimed = xc.reduce((a, c) => a + mh(c), 0);
      const fields = xc.every((c) => ['h43', 'h53', 'r43', 'r53', 'r83', 'd8', 'hx'].every((k) => c[k] >= 0));
      chk('r5-B ' + nm + ' 本店 3＋三家支援（4、3.5、2.5）：比例都 ≥ 0、加總 1、各段 ≥ 0、請款 ≤ 實際多拿', [Object.values(sh).every((v) => v >= 0), r2(Object.values(sh).reduce((a, v) => a + v, 0)), fields, claimed <= paid + 0.03], [true, 1, true, true]);
    });
    const b3 = build({ ft: true, days: [{ date: D, cell: 'H', home: 0.5, sups: [{ code: 'MZTJS', h: 4, s: 600 }, { code: 'MZTLZL', h: 4, s: 700 }, { code: 'MZTMC', h: 4, s: 800 }] }] });
    const sh3 = J(S.call('payXclaimShare_', b3.att.ot_xdays[D]));
    chk('r5-B 休息日 本店 0.5＋三家各 4（原單位分到的超過 8 比它自己的時數多）：沒有負數、加總 1', [Object.values(sh3).every((v) => v >= 0), r2(Object.values(sh3).reduce((a, v) => a + v, 0))], [true, 1]);
  }
  // 同一份資料連算 10,000 組，摘要逐字相同（不會因浮點數讓月份鎖不了）
  let diffSig = 0;
  for (let i = 0; i < 10000; i++) {
    const o = randomCase(); const b1 = build(o), b2 = build(o);
    const x1 = S.call('payXclaimSig_', '2026-11', J(calc(b1)).ot_info), x2 = S.call('payXclaimSig_', '2026-11', JSON.stringify(J(calc(b2)).ot_info));
    if (x1 !== x2) diffSig++;
  }
  chk('r3-3 同一份資料連算兩次（含存成 JSON 字串再讀）1 萬組：請款摘要逐字相同', diffSig, 0);
}

console.log('\n' + (f ? '❌' : '✅') + ' 跨店請款 N4：' + p + ' 過、' + f + ' 失敗');
process.exit(f ? 1 : 0);
