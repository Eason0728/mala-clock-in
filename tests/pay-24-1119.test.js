/**
 * 11/10 薪酬驗收 24 項的改程式 5 項（Eason 2026-11-19 照推薦）：F11、F12、F17、F18、F21。
 * 規則白話版與手算對照寫在每一區開頭；期望值照規則手算寫死，不從程式反推。全部虛構同仁（代號），不含真實姓名與薪資。
 *
 * F11 半額假別扣款（病假、生理假、任何 0 < 給薪比例 < 1 的假）：
 *   扣款＝round(時數 × 扣款時薪 × (1 − 給薪比例))；扣款時薪本身仍是整數（需求 7：(底薪＋職能＋夜間＋店長＋全勤上限)÷30÷8 四捨五入）。
 *   不先把「半額時薪」取整。程式從 2026-11 薪資起已是這樣（薪酬挑錯第 10 項，PAY_LEAVE_RAW_FROM）；
 *   2026-10 以前維持舊算法是 Eason 2026-11-11 的決定（tests/round-late-annual-leave.test.js 守），本檔不改那條。
 *   手算：扣款時薪 163（39000÷240＝162.5→163）
 *     ① 病假 8H：8×163×0.5＝652　② 病假 6.25H：6.25×163×0.5＝509.375→509　③ 病假 1H：81.5→82
 *     ④ 病假 3H：244.5→245　⑤ 生理假（3 次內全薪那條之外的半薪情況）用同一公式
 * F12 特休未休折算：時薪不取整，只有最後金額四捨五入。2026-11 起正職時薪＝月工資÷30÷每日工時（月工資含伙食 2000）。
 *   手算：月工資 35000（底薪 26000＋職能 3000＋夜間 1000＋全勤 3000＋伙食 2000）、每日 8H
 *     ① 剩 3H：3×35000÷240＝437.5→438　② 剩 1H：145.8333→146　③ 剩 7H：1020.83→1021
 *     ④ 剩 24H：3500（整除）　⑤ 剩 0.5H：72.92→73
 * F17 紅字天數那格空白：不能當 0 天。計算擋下，回 red_days_blank（不是數字回 red_days_bad），訊息說哪個月、哪一列、怎麼補；填 0 照算。
 *   手算（2026-10，31 天，每日 8H，整月在職，核定 160H，ot_rate 240）
 *     ① 空白→擋下、不寫月結　② 只有空格→擋下　③「abc」→擋下（red_days_bad）
 *     ④ 0 → baseH 248、倒扣 (248−160)×240＝21120　⑤ 11 → baseH 160、倒扣 0　⑥ 全形「１１」→ baseH 160
 *     ⑦ 本店專屬列空白、集團列 11 → 用本店那列 → 擋下，訊息寫「本店專屬」　⑧ 2026-11 空白也擋
 * F18 主檔金額欄：存主檔時 "28,000"、全形「２８０００」「２８，０００」轉成數字 28000；轉不了的擋下（bad_amount），訊息寫「編號 欄位名」，不帶原文。
 *   計算端 payNum 讀到同樣的字串也轉對：
 *     ① "28,000"→28000　② "２８０００"→28000　③ "２８，０００"→28000　④ "1,234.5"→1234.5　⑤ "－５００"→−500
 *     ⑥ "1,5"（不是千分位）→ 照舊 1　⑦ "abc"→0　⑧ ""→0　⑨ 數字 28000→28000
 *   payCalcOne 主檔底薪 "28,000"／"２８０００"、時數 160、紅字 11（2026-10）→ 底薪 28000。
 * F21 鎖定重送：已經是 final 的月份再送 lock → 回 ok、already:true，不再寫第二筆 lock 稽核、不動快照。
 *   前端鎖定請求網路失敗／回應壞掉不自動重送；改成重新讀該月狀態：已鎖→顯示已鎖；仍是草稿→說沒鎖成功、請再按一次。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp, ptEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const ROOT = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const E = {};
{ const a = GS.indexOf('function payR0'), b = GS.indexOf('/* ═══════════════════ Handlers');
  new Function('exports', "function pad2(n){return ('0'+n).slice(-2)}\n" + GS.slice(a, b) +
    '\nexports.payCalcOne=payCalcOne;exports.payNum=payNum;')(E); }
const item = (r, k) => { const x = [].concat(r.earn, r.ded).find(i => i.item_key === k); return x ? x.amount : null; };
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100 };
const LT = [
  { code: 'personal', name: '事假', pay_ratio: 0, cap_days: null, cap_basis: '', over_ratio: 0, tenure_months: null, under_ratio: 0 },
  { code: 'sick', name: '病假', pay_ratio: 0.5, cap_days: 30, cap_basis: 'year', over_ratio: 0, tenure_months: null, under_ratio: 0 },
];
const T01 = { emp_id: 'T01', name: '代號甲', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000, mgr_allow: 0,
  attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
  hire_date: '2021-01-01', leave_date: '', meal_allow: 0, active: 'true' };
const att = (o) => Object.assign({ hours: 160, extra_ot: 0, deduct_days: 0, support: [], annual: null }, o || {});

/* ══ F11 半額假別：先乘後四捨五入（2026-11 起） ══ */
console.log('── F11 半額假別扣款＝round(時數×扣款時薪×(1−給薪比例))');
[[8, 652], [6.25, 509], [1, 82], [3, 245]].forEach(([h, want]) => {
  const r = E.payCalcOne(T01, '2026-11', att({ sick_h: h, leaves: { sick: h } }), cfg, 10, LT);
  eq(item(r, 'sick_leave'), want, `F11 2026-11 病假 ${h}H、扣款時薪 163 → ${want}`);
});
{ const r = E.payCalcOne(T01, '2026-11', att({ sick_h: 8, leaves: { sick: 8 } }), cfg, 10, LT);
  eq(r.leave_rate, 163, 'F11 扣款時薪本身仍取整數 163（需求 7）'); }

/* ══ F12 特休折算：時薪不取整，只最後四捨五入（2026-11 起） ══ */
console.log('── F12 特休未休折算');
{ const T = Object.assign({}, T01, { base: 26000, night_allow: 1000 });   // 月工資 26000+3000+1000+3000+2000＝35000
  [[3, 438], [1, 146], [7, 1021], [24, 3500], [0.5, 73]].forEach(([h, want]) => {
    const r = E.payCalcOne(T, '2026-11', att({ annual: { days: 14, quota_h: 112, used_h: 112 - h, left_h: h, payout_ym: '2026-11' } }), cfg, 10, LT);
    eq(item(r, 'annual_payout'), want, `F12 2026-11 月工資 35000、剩 ${h}H → ${want}`);
  }); }

/* ══ F18 payNum 讀千分位與全形 ══ */
console.log('── F18 payNum');
[['28,000', 28000], ['２８０００', 28000], ['２８，０００', 28000], ['1,234.5', 1234.5], ['－５００', -500],
 [' 28,000 ', 28000], ['1,5', 1], ['abc', 0], ['', 0], [28000, 28000], [null, 0], ['12.5', 12.5], ['8H', 8]].forEach(([v, want]) => {
  eq(E.payNum(v), want, `F18 payNum(${JSON.stringify(v)}) → ${want}`);
});
{ const a = E.payCalcOne(Object.assign({}, T01, { base: '28,000' }), '2026-10', att(), cfg, 11, LT);
  eq(item(a, 'base_salary'), 28000, 'F18 C8d 主檔底薪 "28,000" → 底薪 28000');
  const b = E.payCalcOne(Object.assign({}, T01, { base: '２８０００' }), '2026-10', att(), cfg, 11, LT);
  eq(item(b, 'base_salary'), 28000, 'F18 C8e 主檔底薪 "２８０００" → 底薪 28000'); }
{ const fn = new Function(HTML.match(/const n=v=>[^\n]*/)[0].replace(/^const n=/, 'return ') + ';')();
  eq([fn('28,000'), fn('２８０００'), fn('1,5'), fn('abc'), fn(12)], [28000, 28000, 1, 0, 12], 'F18 薪資頁 n() 同一套讀法'); }

/* ══ 處理器層的共用環境 ══ */
const KEY = 'test-admin-key', ST = 'SSLGF';
const E01 = (o) => ftEmp(Object.assign({ emp_id: 'E01', name: '代號甲', health_ins: 470 }, o || {}));
const inRow = (ym, emp, o) => Object.assign({ ym: ym, emp_id: emp, store: ST, hours: 0, extra_ot: 0, deduct_days: 0, support: '[]', hours_manual: '' }, o || {});
const fresh = (master, input, holiday) => ({
  master: master, holiday: holiday,
  config: [], run: [], item: [], input: input || [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  store: [{ code: 'SSLGF', name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
});
const clock = () => ({ SSLGF: { roster: [], approved: [], events: [], leave: [], requests: [] } });
function env(data, today) {
  const s = load({ data: data, clock: clock(), today: today || '2026-11-19' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __TODAY.slice(0, 7); }; payHolidaySync = function () { return {}; };`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const hol = (ym, red, store) => ({ ym: ym, red_days: red, note: '', dates: '', store: store || '' });

/* ══ F17 紅字天數空白 ══ */
console.log('── F17 紅字天數空白不能當 0');
function calcOct(holiday, ym) {
  ym = ym || '2026-10';
  const s = env(fresh([E01()], [inRow(ym, 'E01', { hours: 160 })], holiday), ym === '2026-11' ? '2026-12-02' : '2026-11-19');
  const r = s.post('handlePayrollCalc', { ym: ym, store: ST });
  return { r: r, runs: (s.__DATA.run || []).length };
}
{ const x = calcOct([hol('2026-10', '')]);
  eq([x.r.ok, x.r.error, x.runs], [false, 'red_days_blank', 0], 'F17-1 紅字天數空白 → 擋下、不寫月結');
  eq(/2026-10/.test(x.r.message || '') && /紅字天數/.test(x.r.message || '') && /填 0/.test(x.r.message || ''), true, 'F17-1 訊息寫出月份、紅字天數、沒有紅字填 0');
  const y = calcOct([hol('2026-10', '   ')]);
  eq([y.r.ok, y.r.error], [false, 'red_days_blank'], 'F17-2 只有空格 → 擋下');
  const z = calcOct([hol('2026-10', 'abc')]);
  eq([z.r.ok, z.r.error, z.runs], [false, 'red_days_bad', 0], 'F17-3 不是數字 → 擋下（red_days_bad）');
  const nul = calcOct([hol('2026-10', null)]);
  eq([nul.r.ok, nul.r.error], [false, 'red_days_blank'], 'F17-3b 讀回 null → 擋下');
}
{ const x = calcOct([hol('2026-10', 0)]);
  const r0 = x.r.results && x.r.results[0];
  eq([x.r.ok, r0 && r0.base_hours, r0 && item(r0, 'shortfall_hours')], [true, 248, 21120], 'F17-4 填 0 是合法值：baseH 248、倒扣 21120');
  const x0s = calcOct([hol('2026-10', '0')]);
  eq([x0s.r.ok, x0s.r.results && x0s.r.results[0].base_hours], [true, 248], 'F17-4b 文字 "0" 也是合法值');
  const y = calcOct([hol('2026-10', 11)]);
  eq([y.r.ok, y.r.results[0].base_hours, item(y.r.results[0], 'shortfall_hours')], [true, 160, null], 'F17-5 11 天：baseH 160、沒有倒扣');
  const z = calcOct([hol('2026-10', '１１')]);
  eq([z.r.ok, z.r.results && z.r.results[0].base_hours], [true, 160], 'F17-6 全形「１１」→ baseH 160');
}
{ const x = calcOct([hol('2026-10', 11), hol('2026-10', '', ST)]);
  eq([x.r.ok, x.r.error, /本店專屬/.test(x.r.message || '')], [false, 'red_days_blank', true], 'F17-7 本店專屬列空白（集團列有值）→ 用本店那列 → 擋下，訊息寫本店專屬');
  const y = calcOct([hol('2026-11', '')], '2026-11');
  eq([y.r.ok, y.r.error], [false, 'red_days_blank'], 'F17-8 2026-11 空白也擋');
}
{ const s = env(fresh([E01()], [], []));
  const chk = (v) => { try { return JSON.parse(JSON.stringify(s.call('payRedDaysCheck_', hol('2026-10', v), '2026-10'))); } catch (e) { return { threw: String(e.message) }; } };
  eq(chk('').ok, false, 'F17-9 payRedDaysCheck_ 空白不合格（損益估算共用）');
  eq(chk('８'), { ok: true, value: 8 }, 'F17-9 全形 ８ → 8');
  eq(/payRedDaysCheck_\(holRow/.test(GS.slice(GS.indexOf('function handlePnlLaborEstimate_'))), true, 'F17-10 損益估算也用同一個檢查（空白＝red_days_missing）');
  // 同步：本月以後的集團列空白，要被人事行政總處的值補上（不然 0 紅字的月份會一直擋）
  const dif = GS.slice(GS.indexOf('const differs = function (r, w)'), GS.indexOf('const differs = function (r, w)') + 300);
  eq(/payRedDaysCheck_/.test(dif), true, 'F17-11 紅字天數同步把空白當成「不一樣」（本月以後會被補上）');
}
{ // 畫面看得到原因：doCalc 對 red_days_* 用對話框講清楚；紅字天數表把空白標紅
  const d = HTML.slice(HTML.indexOf('async function doCalc('), HTML.indexOf('/* ═════ 月結 ═════ */'));
  eq(/red_days_blank/.test(d) && /alert\(/.test(d), true, 'F17-12 重新計算被紅字天數擋下 → 對話框顯示原因');
  const h = HTML.slice(HTML.indexOf('function applyHol('), HTML.indexOf('function holDateList('));
  eq(/空白/.test(HTML.slice(HTML.indexOf('function renderHol()'), HTML.indexOf('function holSyncHtml('))) && !/HOL\[k\]=n\(h\.red_days\)/.test(h), true, 'F17-13 紅字天數表：空白不再顯示成 0，標「空白」');
}

/* ══ F18 存主檔 ══ */
console.log('── F18 存主檔金額欄');
function saveMaster(rows) {
  const s = env(fresh([E01()], [], [hol('2026-10', 11)]));
  let r; try { r = s.post('handlePayrollMasterSet', { store: ST, master: rows }); } catch (e) { r = { threw: String(e.message) }; }
  return { r: r, m: s.__DATA.master };
}
{ const a = saveMaster([E01({ base: '28,000', skill_allow: '３０００', night_allow: '３，０００', labor_ins: ' 758 ', yearend_months: '', gap_rate: '' })]);
  eq(a.r.ok, true, 'F18-M1 千分位、全形、全形逗號、頭尾空白都轉得了 → 可存');
  const m = a.m[0];
  eq([m.base, m.skill_allow, m.night_allow, m.labor_ins, m.yearend_months, m.gap_rate], [28000, 3000, 3000, 758, '', ''], 'F18-M1 存進去的是數字；空白照舊空白');
  const b = saveMaster([E01({ base: 30000 }), ptEmp({ emp_id: 'P02', name: '代號乙', wage: '２００' })]);
  eq([b.r.ok, b.m.find(x => x.emp_id === 'P02').wage], [true, 200], 'F18-M2 計時時薪「２００」→ 200');
  const c = saveMaster([E01({ base: 30000 }), ftEmp({ emp_id: 'E02', name: '代號乙', base: '二萬八', attend_cap: 'abc' })]);
  eq([c.r.ok, c.r.error], [false, 'bad_amount'], 'F18-M3 轉不了的非數字 → 整批不存（bad_amount）');
  eq(c.r.cells, ['E02 底薪', 'E02 績效獎金上限'], 'F18-M3 說哪一位哪一欄');
  eq(/二萬八|abc/.test(c.r.message || ''), false, 'F18-M3 訊息不帶使用者填的原文');
  eq([c.m.length, c.m[0].emp_id, c.m[0].base], [1, 'E01', 30000], 'F18-M3 擋下時主檔沒動');
  const d = saveMaster([E01({ base: '28000元' })]);
  eq([d.r.ok, d.r.cells], [false, ['E01 底薪']], 'F18-M4 「28000元」也擋（存檔要乾淨的數字）');
  const e = saveMaster([E01({ base: '28,00' })]);
  eq([e.r.ok, e.r.cells], [false, ['E01 底薪']], 'F18-M5 逗號位置不對（28,00）→ 擋');
  const f = saveMaster([E01({ base: -500, health_ins: '0' })]);
  eq([f.r.ok, f.m[0].base, f.m[0].health_ins], [true, -500, 0], 'F18-M6 負數、文字 "0" 照存（只管讀不讀得懂）');
}

/* ══ F21 鎖定重送 ══ */
console.log('── F21 已鎖定再送鎖定');
{ const s = env(fresh([E01()], [inRow('2026-10', 'E01', { hours: 160 })], [hol('2026-10', 11)]));
  const c = s.post('handlePayrollCalc', { ym: '2026-10', store: ST });
  eq(c.ok, true, 'F21-0 10 月試算成功');
  const a = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA', cost_snapshot: { total: 1 } });
  eq([a.ok, a.status, a.already], [true, 'final', undefined], 'F21-1 第一次鎖定：成功');
  const snap1 = JSON.stringify(s.__DATA.cost_snapshot);
  const b = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true, operator: 'QA' });
  eq([b.ok, b.status, b.already], [true, 'final', true], 'F21-2 再送一次鎖定：回 ok、already:true');
  eq((s.__DATA.audit || []).filter(x => x.ym === '2026-10').map(x => x.action), ['lock'], 'F21-3 稽核只有一筆 lock');
  eq(JSON.stringify(s.__DATA.cost_snapshot), snap1, 'F21-4 重送沒帶快照也不會把第一次的快照清掉');
  eq(s.__DATA.run.map(r => r.status), ['final'], 'F21-5 月結仍是 final');
  const u = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: false, reason: '測試', operator: 'QA' });
  eq([u.ok, u.status], [true, 'draft'], 'F21-6 解鎖照常');
  const u2 = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: false, reason: '測試', operator: 'QA' });
  eq([u2.ok, (s.__DATA.audit || []).filter(x => x.ym === '2026-10').map(x => x.action)], [true, ['lock', 'unlock', 'unlock']], 'F21-7 解鎖不在這次範圍（照舊每次都記）');
}

/* ══ F21 前端：鎖定失敗不重送，改重讀狀態 ══ */
function front(fetchPlan, monthStatus) {
  const a = HTML.indexOf('async function post('), b = HTML.indexOf('async function bootstrapFromRoster');
  const c = HTML.indexOf('async function toggleLock()'), d = HTML.indexOf('/* ═════ 工時 ═════ */');
  const log = { fetch: [], toast: [], loadMonth: 0 };
  const ctx = {
    EMBED: false, API: 'https://example.invalid/exec', ADMIN_KEY: 'k', STORE: 'SSLGF', location: { pathname: '/' }, JSON, console,
    ASOF: null, STATUS: 'draft', RESULTS: [], COST_SNAP: null, ELEC_PEND: {}, MON_UNSURE: {}, LOCK_BUSY: false, elecBtns() {}, /* 選舉假：店月名單存檔待確認（Codex 第五次） */ CALC_INPUTS: () => ({}), $: () => null, ym: () => '2026-10',
    vClear() {}, renderRun() {}, setInterval: () => 1, clearInterval() {}, prompt: () => '', alert() {}, doCalc: async () => {},
    costStable() { return {}; }, costTotals() { return {}; }, costDetail() { return []; },
    toast: (m, bad) => log.toast.push((bad ? '!' : '') + m),
    fetch: async (url, opt) => {
      const body = JSON.parse(opt.body); log.fetch.push(body.action);
      const step = fetchPlan[body.action] ? fetchPlan[body.action].shift() : null;
      if (step === 'net') throw new Error('network');
      if (step === 'html') return { text: async () => '<html>Google</html>' };
      if (body.action === 'payroll_month') return { text: async () => JSON.stringify({ ok: true, run: { status: monthStatus, results: [] } }) };
      if (body.action === 'payroll_status') return { text: async () => JSON.stringify(step || { ok: true, ym: body.ym, store: body.store, status: monthStatus, rows: 1, run_at: '', elec_stale: false }) };   // 唯讀狀態查詢（待辦 10）
      return { text: async () => JSON.stringify(step || { ok: true }) };
    },
  };
  ctx.loadMonth = async (pre) => { log.loadMonth++; const r = await (pre || ctx.post('payroll_month', { ym: '2026-10', inputs: {} })); if (!r || !r.ok) return false; ctx.STATUS = r && r.run ? r.run.status : 'draft'; return true; };
  vm.createContext(ctx); vm.runInContext(HTML.slice(a, b) + '\n' + HTML.slice(c, d), ctx);
  // 鎖定的擋用 monBlocked()（＝elecPending()||monUnsure()，2026-11-22 #212 後續 PR）：把 payroll.html 的這三支原樣放進模擬環境
  vm.runInContext(HTML.match(/^function (?:elecPending|monBlocked|monUnsure)\(\)\{.*\}.*$/gm).join('\n'), ctx);
  return { ctx, log };
}
(async () => {
  console.log('── F21 前端');
  { const { ctx, log } = front({ payroll_finalize: ['net'] }, 'final');
    await ctx.toggleLock();
    eq(log.fetch, ['payroll_finalize', 'payroll_status', 'payroll_month'], 'F21-F1 鎖定斷線：不重送鎖定，先用唯讀 payroll_status 確認（已鎖才重新載入該月）');
    eq([ctx.STATUS, log.loadMonth], ['final', 1], 'F21-F1 伺服器其實已鎖 → 畫面改成已鎖定（重新載入該月）');
    eq(log.toast.some(t => /已鎖定/.test(t) && !/^!/.test(t)), true, 'F21-F1 提示已鎖定');
  }
  { const { ctx, log } = front({ payroll_finalize: ['net'] }, 'draft');
    await ctx.toggleLock();
    eq(log.fetch, ['payroll_finalize', 'payroll_status'], 'F21-F2 斷線且伺服器沒鎖：也只送一次鎖定，確認只用唯讀 payroll_status（不打會自動重算的 payroll_month）');
    eq([ctx.STATUS, log.loadMonth], ['draft', 0], 'F21-F2 畫面維持草稿');
    eq(log.toast.some(t => /^!/.test(t) && /沒有鎖定/.test(t) && /再按一次/.test(t)), true, 'F21-F2 說清楚沒有鎖定、請再按一次');
  }
  { const { ctx, log } = front({ payroll_finalize: ['html'] }, 'final');
    await ctx.toggleLock();
    eq(log.fetch, ['payroll_finalize', 'payroll_status', 'payroll_month'], 'F21-F3 回應壞掉（Google HTML 頁）：鎖定也不重送');
    eq(ctx.STATUS, 'final', 'F21-F3 重讀後顯示已鎖定');
  }
  { const { ctx, log } = front({ payroll_finalize: ['net'], payroll_status: ['net'] }, 'final');
    await ctx.toggleLock();
    eq(ctx.STATUS, 'draft', 'F21-F4 連狀態都讀不到：畫面不亂改');
    eq(log.toast.some(t => /^!/.test(t) && /重新整理/.test(t)), true, 'F21-F4 請人重新整理頁面看狀態');
  }
  /* 待辦 10：後端或管理系統代轉還是舊版（payroll_status 回 unknown_action／被擋）→ 照舊用 payroll_month 確認 */
  { const { ctx, log } = front({ payroll_finalize: ['net'], payroll_status: [{ ok: false, error: 'unknown_action' }] }, 'final');
    await ctx.toggleLock();
    eq([log.fetch, ctx.STATUS, log.loadMonth], [['payroll_finalize', 'payroll_status', 'payroll_month'], 'final', 1], 'F21-F7 舊後端沒有 payroll_status：退回 payroll_month 確認（行為同改版前）');
  }
  { const { ctx, log } = front({ payroll_finalize: ['net'], payroll_status: [{ ok: false, error: 'unknown_action' }] }, 'draft');
    await ctx.toggleLock();
    eq([log.fetch, ctx.STATUS], [['payroll_finalize', 'payroll_status', 'payroll_month'], 'draft'], 'F21-F8 舊後端、伺服器沒鎖：退回 payroll_month，畫面維持草稿');
    eq(log.toast.some(t => /^!/.test(t) && /沒有鎖定/.test(t)), true, 'F21-F8 說清楚沒有鎖定');
  }
  /* payroll_status 回 mixed／none：各自一句（字句草稿，2026-11-22），draft 維持原句 */
  for (const [stv, re, lab] of [['mixed', /一部分已鎖定、一部分還是草稿.*找資訊部/, 'F21-F10'], ['none', /還沒有計算結果，沒有鎖定成功/, 'F21-F11']]) {
    const { ctx, log } = front({ payroll_finalize: ['net'], payroll_status: [{ ok: true, ym: '2026-10', store: 'SSLGF', status: stv, rows: 0, run_at: '', elec_stale: false }] }, 'final');
    await ctx.toggleLock();
    eq([log.fetch, log.loadMonth, log.toast.some(t => /^!/.test(t) && re.test(t)), log.toast.some(t => /仍是草稿/.test(t))], [['payroll_finalize', 'payroll_status'], 0, true, false], lab + ' payroll_status 回 ' + stv + '：專屬提示、不說「仍是草稿」、不重讀');
  }
  /* Codex 第六次 13b：鎖定成功、重讀失敗 → 提示要重新整理確認（不只說「已鎖定」） */
  { const { ctx, log } = front({ payroll_finalize: [{ ok: true, status: 'final' }], payroll_month: ['net', 'net'] }, 'final');
    await ctx.toggleLock();
    eq(log.toast.some(t => /^!/.test(t) && /重新讀取這個月失敗/.test(t) && /再匯出/.test(t)), true, 'F21-F9 鎖定成功但重讀失敗：紅字提示重新整理、確認金額後再匯出');
  }
  { const { ctx, log } = front({ payroll_finalize: [{ ok: true, status: 'final', already: true }] }, 'final');
    await ctx.toggleLock();
    eq([ctx.STATUS, log.loadMonth], ['final', 1], 'F21-F5 後端回 already（先前已鎖）→ 重新載入該月（帶回鎖定快照）');
  }
  { const { ctx, log } = front({ payroll_calc: ['net'] }, 'draft');
    const r = await ctx.post('payroll_calc', {});
    eq([log.fetch, r.error], [['payroll_calc', 'payroll_calc'], undefined], 'F21-F6 其他動作照舊斷線重試一次（只有鎖定不重送）');
  }
  console.log(fail ? `\n❌ 失敗 ${fail}（通過 ${pass}）` : `\n✅ 全部通過 (${pass}/${pass})`);
  process.exit(fail ? 1 : 0);
})();
