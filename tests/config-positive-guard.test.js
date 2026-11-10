/**
 * 薪酬挑錯第 3 項：參數清空存成 0（Eason 2026-11-11 確認）。
 *  規則：每日基本工時、事假費率分母（天／時）、遲到費率分母（天／時）、餐費補助門檻這六個參數，
 *        不是正數（0、負數、空白、非數字）沒有意義 → 引擎一律用預設 8／30／8／30／8／6。
 *  後端：handlePayrollConfigSet 收到這六個鍵的非正數值 → 整批不存，
 *        回 {ok:false,error:'bad_value',message:'「欄位中文名」要填大於 0 的數字，這次沒有儲存'}。
 *  前端：payroll.html 的 saveCfg 送出前先檢查同樣六個鍵並 toast，不送出。
 *  金額欄（attend_deduct_per_day、pt_attend_plus…）的 0 仍是合法值，不可以擋。
 *  全部虛構同仁（代號 E01），期望值照規則手算寫死。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF', YM = '2026-10';
const snap = (o) => JSON.stringify(o);
const LABEL = { daily_hours: '每日基本工時', leave_div_days: '事假費率分母（天）', leave_div_hours: '事假費率分母（時）',
  late_div_days: '遲到費率分母（天）', late_div_hours: '遲到費率分母（時）', meal_min_hours: '餐費補助門檻' };
const MSG = (ks) => ks.map(k => '「' + LABEL[k] + '」').join('、') + '要填大於 0 的數字，這次沒有儲存';
const BAD = [['0', '0'], ['負數 -5', '-5'], ['空白', ''], ['非數字 abc', 'abc']];

function env(config, clock, master) {
  const d = { master: master || [ftEmp()], holiday: [{ ym: YM, red_days: 8, note: '', dates: '', store: '' }], config: config || [],
    run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
    store: [{ code: ST, name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }] };
  const ck = {}; ck[ST] = Object.assign({ roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }], approved: [], events: [], leave: [], requests: [] }, clock || {});
  const s = load({ data: d, clock: ck, today: '2026-11-10' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const cfgRow = (key, value, store) => ({ key, value, note: '', store: store || '' });
const rowOf = (res, id) => (res.results || []).find(x => String(x.emp_id) === id) || {};

/* ══ 一、引擎：試算表裡已經躺著非正數（舊資料）→ 用預設值算 ══
   E01（虛構正職）：底薪 30000＋職能 3000＋夜間 3000，全勤上限 3000，勞健保 0。
   2026-10：31 天、紅字 8 天 → 基本工時 (31−8)×8＝184H。上班 176H＋事假 8H（抵不足）＝184H → 沒有加班、沒有不足。
   全勤 3000−請假 1 天×100＝2900；事假時薪 (30000+3000+3000+0+3000)÷30÷8＝162.5 → 取整 163，8H＝1304。
   應發 30000+3000+3000+2900＝38900；實付 38900−1304＝37596。 */
const IN = { E01: { hours: 176, personal_h: 8, deduct_days: 1 } };
const calcNet = (config) => {
  const s = env(config);
  const r = s.post('handlePayrollCalc', { ym: YM, store: ST, inputs: IN });
  const e = rowOf(r, 'E01');
  return [e.base_hours, e.gross, e.net];
};
eq(calcNet([]), [184, 38900, 37596], 'S0 沒有任何參數列（全部預設）：基本工時 184、應發 38900、實付 37596');
['daily_hours', 'leave_div_days', 'leave_div_hours'].forEach(k => {
  BAD.forEach(([nm, v]) => {
    eq(calcNet([cfgRow(k, v)]), [184, 38900, 37596], `E1 集團預設「${LABEL[k]}」存成${nm} → 照預設算，實付 37596`);
  });
  eq(calcNet([cfgRow(k, '0', ST)]), [184, 38900, 37596], `E1 本店專屬「${LABEL[k]}」存成 0 → 照預設算，實付 37596`);
});
// 正數照設定值算（不是一律預設）：每日 7H → 基本 (31−8)×7＝161H；上班 176＋事假 8−161＝23H 加班×240＝5520；應發 38900+5520＝44420；實付 44420−1304＝43116
eq(calcNet([cfgRow('daily_hours', '7')]), [161, 44420, 43116], 'E2 每日基本工時 7（正數）照 7 算：基本 161、實付 43116');
// 金額欄的 0 是合法值：每日倒扣 0 → 全勤 3000 不扣；應發 39000；實付 39000−1304＝37696
eq(calcNet([cfgRow('attend_deduct_per_day', '0')]), [184, 39000, 37696], 'E3 每日倒扣（元）＝0 是合法值：全勤不扣，實付 37696');

// 遲到每分鐘費率（2026-10 起含全勤上限）：(30000+3000+3000+0+3000)÷30÷8÷60＝39000÷14400
{
  const s = env([]);
  const want = 39000 / 30 / 8 / 60;
  const near = (cfg) => { let x; try { x = s.call('payLateBaseFT', ftEmp(), YM, cfg); } catch (e) { x = String(e.message); } return typeof x === 'number' && Math.abs(x - want) < 1e-9 ? 'ok' : x; };
  eq(near({ late_div_days: 30, late_div_hours: 8 }), 'ok', 'L0 遲到分母 30／8：每分鐘 39000÷14400');
  [0, -30, '', 'abc', undefined, null].forEach(v => {
    eq(near({ late_div_days: v, late_div_hours: 8 }), 'ok', `L1 遲到分母（天）＝${JSON.stringify(v)} → 用 30`);
    eq(near({ late_div_days: 30, late_div_hours: v }), 'ok', `L1 遲到分母（時）＝${JSON.stringify(v)} → 用 8`);
  });
  // 正數照設定值：分母 25／8 → 39000÷25÷8÷60＝3.25
  let x25; try { x25 = s.call('payLateBaseFT', ftEmp(), YM, { late_div_days: 25, late_div_hours: 8 }); } catch (e) { x25 = String(e.message); }
  eq(x25, 3.25, 'L2 遲到分母（天）＝25（正數）照 25 算：每分鐘 3.25');
  // 假別額度換算用的每日工時
  [0, -8, '', 'abc'].forEach(v => {
    let h; try { h = s.call('payLeaveDayHours', { daily_hours: v }); } catch (e) { h = String(e.message); }
    eq(h, 8, `D1 payLeaveDayHours：每日工時＝${JSON.stringify(v)} → 8`);
  });
}

// 餐費補助門檻：E01 餐費 80／天。10 天滿 8H、3 天只上 3H、2 天整天請假（核定 0H）→ 門檻 6H：滿 6H 的只有 10 天 → 10 天×80＝800
{
  const AP = (d, h) => ({ date: YM + '-' + ('0' + d).slice(-2), emp_id: 'E01', name: '測試甲', periods: h ? '10:00-' + (10 + h) + ':00' : '',
    approved_hours: h, status_text: h ? '正常' : '全天請假', manager_name: '值班主管', entered_at: YM + '-' + ('0' + d).slice(-2) + 'T23:00:00+08:00' });
  const approved = [];
  for (let i = 1; i <= 10; i++) approved.push(AP(i, 8));
  [11, 12, 13].forEach(d => approved.push(AP(d, 3)));
  [14, 15].forEach(d => approved.push(AP(d, 0)));
  const meal = (config) => {
    const s = env(config, { approved }, [ftEmp({ meal_allow: 80 })]);
    const c = s.post('handlePayrollCalc', { ym: YM, store: ST, inputs: { E01: { meal_on: true } } });
    const m = (rowOf(c, 'E01').earn || []).find(i => i.item_key === 'meal_sub');
    return m ? [m.qty, m.amount] : [0, 0];
  };
  eq(meal([]), [10, 800], 'M0 餐費門檻預設 6H：10 天×80＝800');
  BAD.forEach(([nm, v]) => eq(meal([cfgRow('meal_min_hours', v)]), [10, 800], `M1 餐費門檻存成${nm} → 照 6H 算：10 天×80＝800`));
  // 正數照設定值：門檻 3H → 滿 3H 的 13 天×80＝1040
  eq(meal([cfgRow('meal_min_hours', '3')]), [13, 1040], 'M2 餐費門檻 3（正數）照 3 算：13 天×80＝1040');
}

/* ══ 二、後端 handlePayrollConfigSet：六個鍵的非正數整批不存 ══ */
{
  const seed = () => [cfgRow('daily_hours', '8'), cfgRow('co_group', '1170'), cfgRow('co_group', '900', 'CF')];
  Object.keys(LABEL).forEach(k => {
    [0, -1, '', 'abc', '0', ' ', null].forEach(v => {
      const s = env(seed()); const c0 = snap(s.__DATA.config);
      const cfg = {}; cfg[k] = v;
      const r = s.post('handlePayrollConfigSet', { config: cfg, store: ST, keys: true });
      eq([r.ok, r.error, r.message, snap(s.__DATA.config) === c0], [false, 'bad_value', MSG([k]), true],
        `H1 單項儲存「${LABEL[k]}」＝${JSON.stringify(v)} → bad_value、參數表沒動`);
    });
  });
  // 同一批裡有一個不合格 → 整批不存（合格的那個也不存）
  let s = env(seed()), c0 = snap(s.__DATA.config);
  let r = s.post('handlePayrollConfigSet', { config: { co_group: 1234, daily_hours: 0 }, store: '', keys: true });
  eq([r.ok, r.error, r.message, snap(s.__DATA.config) === c0], [false, 'bad_value', MSG(['daily_hours']), true], 'H2 一批兩項、其中每日工時＝0 → 整批不存（團險也沒改）');
  // 兩個都不合格 → 訊息兩個都列
  r = s.post('handlePayrollConfigSet', { config: { leave_div_days: 0, meal_min_hours: -1 }, store: '', keys: true });
  eq([r.ok, r.error, r.message, snap(s.__DATA.config) === c0], [false, 'bad_value', MSG(['leave_div_days', 'meal_min_hours']), true], 'H3 兩項都不合格 → 訊息兩項都列、參數表沒動');
  // 不帶 keys（整批覆寫）一樣擋
  r = s.post('handlePayrollConfigSet', { config: { daily_hours: 8, late_div_hours: 0, co_group: 1 }, store: '' });
  eq([r.ok, r.error, r.message, snap(s.__DATA.config) === c0], [false, 'bad_value', MSG(['late_div_hours']), true], 'H4 整批覆寫模式、遲到分母（時）＝0 → 整批不存');
  // 正數照舊可存（數字或字串）
  s = env(seed());
  r = s.post('handlePayrollConfigSet', { config: { daily_hours: 7.5, meal_min_hours: '4' }, store: '', keys: true });
  const val = (k, st) => (s.__DATA.config.filter(x => x.key === k && String(x.store || '') === (st || ''))[0] || {}).value;
  eq([r.ok, val('daily_hours'), val('meal_min_hours'), val('co_group')], [true, '7.5', '4', '1170'], 'H5 每日工時 7.5、餐費門檻 "4" → 存進去，其他鍵保留');
  // 金額欄的 0 不可以擋
  r = s.post('handlePayrollConfigSet', { config: { attend_deduct_per_day: 0, pt_attend_plus: 0, pt_tenure_plus: 0, attend_void_forget: 0, co_group: 0 }, store: ST, keys: true });
  eq([r.ok, val('attend_deduct_per_day', ST), val('pt_attend_plus', ST), val('pt_tenure_plus', ST), val('attend_void_forget', ST), val('co_group', ST)],
    [true, '0', '0', '0', '0', '0'], 'H6 金額欄（每日倒扣、滿勤加給、年資加給、忘刷門檻、團險）填 0 → 照存');
}

/* ══ 三、前端 payroll.html 的 saveCfg：送出前先擋 ══ */
const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const a = html.indexOf('let CFG_DIRTY='), b = html.indexOf('\n/* ═════ 紅字天數');
const co = html.match(/const CO_MANUAL=\[[^\n]*\n/)[0];
const front = html.slice(a, b).replace(/function renderCfg\(\)\{[\s\S]*?\n\}\n/, '');
function mkFront(postRes) {
  const el = (checked) => ({ checked, textContent: '' });
  const ctx = { POSTS: [], toasts: [], STORE: 'CF', CFGSRC: {}, RESULTS: [],
    CFG: { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, meal_min_hours: 6, payday: 10, attend_deduct_per_day: 100, pt_attend_plus: 10, co_group: 1170 },
    els: { cfgOwn: el(false), attOwn: el(false), ptOwn: el(false), coOwn: el(false) },
    n: v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; },
    renderCfg: () => {}, saveFX: async (btn, l, fn) => fn() };
  ctx.$ = id => ctx.els[id] || null;
  ctx.toast = (t, bad) => ctx.toasts.push([t, !!bad]);
  ctx.post = async (act, body) => { ctx.POSTS.push({ act, body }); return postRes || { ok: true }; };
  vm.createContext(ctx);
  vm.runInContext(co + front, ctx);
  return ctx;
}
(async () => {
  // 數字欄清空：input 的 onchange 是 cfgEdit(k, n(this.value))，n('')＝0
  for (const [k, raw] of [['daily_hours', ''], ['leave_div_days', '0'], ['leave_div_hours', '-8'], ['meal_min_hours', '']]) {
    const ctx = mkFront();
    vm.runInContext(`cfgEdit(${JSON.stringify(k)},n(${JSON.stringify(raw)}))`, ctx);
    await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
    eq([ctx.POSTS.length, ctx.toasts], [0, [[MSG([k]), true]]], `F1 基本參數卡「${LABEL[k]}」填 ${JSON.stringify(raw)} 按儲存 → 不送出、紅色提示`);
  }
  {
    const ctx = mkFront();
    vm.runInContext("cfgEdit('daily_hours',n(''));cfgEdit('payday',15);cfgEdit('meal_min_hours',n('0'))", ctx);
    await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
    eq([ctx.POSTS.length, ctx.toasts], [0, [[MSG(['daily_hours', 'meal_min_hours']), true]]], 'F2 同一張卡兩項不合格＋一項合格 → 整張不送出、兩項都點名');
    // 改回正數之後可以存
    vm.runInContext("cfgEdit('daily_hours',8);cfgEdit('meal_min_hours',6)", ctx);
    await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
    eq([ctx.POSTS.length, ctx.POSTS[0] && ctx.POSTS[0].body.config], [1, { daily_hours: 8, payday: 15, meal_min_hours: 6 }], 'F3 改回正數 → 送出三項');
  }
  {
    const ctx = mkFront();
    vm.runInContext("cfgEdit('attend_deduct_per_day',n(''));cfgEdit('pt_attend_plus',n('0'))", ctx);
    await vm.runInContext("saveCfg(null,'儲存全勤參數','att')", ctx);
    await vm.runInContext("saveCfg(null,'儲存','pt')", ctx);
    eq(ctx.POSTS.map(p => p.body.config), [{ attend_deduct_per_day: 0 }, { pt_attend_plus: 0 }], 'F4 金額欄（每日倒扣、滿勤加給）填 0 → 照樣送出');
    eq(ctx.toasts.filter(t => t[1]).length, 0, 'F4 沒有紅色提示');
  }
  {
    // 後端回 bad_value 時，畫面顯示後端的中文訊息（不是只有代碼）
    const ctx = mkFront({ ok: false, error: 'bad_value', message: MSG(['daily_hours']) });
    vm.runInContext("cfgEdit('payday',15)", ctx);
    await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
    eq(ctx.toasts, [['儲存失敗：' + MSG(['daily_hours']), true]], 'F5 後端回失敗 → 提示帶後端訊息');
  }
  console.log(`\nconfig-positive-guard: ${pass} 通過, ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('✗ 測試本身丟出例外：' + (e && e.stack || e)); process.exit(1); });
