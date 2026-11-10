/* 2026-11-09 複審後修的四件事：計時國定假日跨店支援加倍、鎖定前重算、半日生理假看次數、同名請假 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const H = require('./helpers/payroll-vm.js');
let p = 0, f = 0; const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };
const dates = []; for (let d = 1; d <= 30; d++) dates.push('2026-11-' + ('0' + d).slice(-2));
const schedW = {}; dates.forEach((d) => { schedW[d] = { t: 'W' }; });
const STORES = [{ code: 'SSLGF', name: '光復', active: 'true', support_group: 'sxl', emp_prefix: '' }, { code: 'SSLMC', name: '美村', active: 'true', support_group: 'sxl', emp_prefix: '' }];

/* ── 計時國定假日跨店支援 ── */
{
  const S = H.load({ today: '2026-11-20' }), T = S.call('payLeaveTypes', 'SSLGF');
  const D = '2026-11-12', e = H.ptEmp();
  const entry = { stores: [{ code: 'SSLMC', name: '美村', hours: 10, days: [{ date: D, hours: 8 }, { date: '2026-11-13', hours: 2 }] }] };
  const storeBy = { SSLGF: STORES[0], SSLMC: STORES[1] };
  const sup = [{ code: 'SSLMC', store: '美村', hours: 10, rate: 200, amount: '', auto: true }];
  const hol = S.call('paySupportHolDouble_', sup, entry, [D], storeBy);
  chk('只取國定假日那天的支援時數與費率', JSON.parse(JSON.stringify(hol)), [{ code: 'SSLMC', name: '美村', hours: 8, rate: 200 }]);
  chk('沒有對應支援列（跨品牌剔除）不加倍', JSON.parse(JSON.stringify(S.call('paySupportHolDouble_', [], entry, [D], storeBy))), []);
  chk('損益估算只算到 as_of', JSON.parse(JSON.stringify(S.call('paySupportHolDouble_', sup, entry, [D], storeBy, '2026-11-11'))), []);
  const daily = S.call('payDailyFor_', e, '2026-11', { day_h: {}, day_leave: {} }, entry, schedW, [D], '2026-11-19', 10);
  const r = S.call('payCalcOne', e, '2026-11', H.baseAtt({ support: sup, daily, sup_hol: hol }), H.cfg, 4, T);
  chk('國定假日支援 8H＋平日 2H，時薪 200', [r.gross, H.item(r, 'holiday_double'), H.item(r, 'cross_store')], [3600, 1600, 2000]);
  const r2 = S.call('payCalcOne', e, '2026-11', H.baseAtt({ hours: 8, holiday_h: 8, daily: S.call('payDailyFor_', e, '2026-11', { day_h: { [D]: 8 }, day_leave: {} }, null, schedW, [D], '2026-11-19', 0) }), H.cfg, 4, T);
  chk('本店國定假日照舊用有效時薪加倍（含年資 +10）', [r2.gross, H.item(r2, 'holiday_double')], [3360, 1680]);
}

/* ── 半日生理假看次數 ── */
{
  const mk = (rows) => H.load({ today: '2026-11-30', clock: { SSLGF: { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }], approved: [], events: [], leave: rows } } });
  const row = (d, h) => ({ '日期': d, '姓名': '測試甲', '假別': '生理假', '時數': h });
  const S = mk([row('2026-11-24', 4), row('2026-11-03', 4), row('2026-11-10', 4), row('2026-11-17', 4)]);
  const T = S.call('payLeaveTypes', 'SSLGF');
  const c = S.call('payCollect', '2026-11', 6, 'SSLGF', []).E01;
  chk('payCollect 依日期留下每次時數', [c.menstrual_h, Array.from(c.menstrual_times)], [16, [4, 4, 4, 4]]);
  const e = H.ftEmp();
  const amt = (times, h, before) => S.call('payCalcOne', e, '2026-11', H.baseAtt({ menstrual_h: h, leaves: { menstrual: h }, menstrual_times: times, leave_usage: { menstrual: { used_before_days: before } } }), H.cfg, 4, T);
  const rate = amt(null, 8, 3).leave_rate, half = Math.round(rate * 0.5);
  const d = (r) => H.item(r, 'menstrual_leave');
  chk('同月 4 個半天：第 4 次轉病假半薪', d(amt([4, 4, 4, 4], 16, 0)), 4 * half);
  chk('之前 2 次、本月 4H＋8H：第 4 次 8H', d(amt([4, 8], 12, 2)), 8 * half);
  chk('3 次內不扣', d(amt([4, 4, 4], 12, 0)), 0);
  chk('跨月第 4 次（照舊）', d(amt([4], 4, 3)), 4 * half);
  chk('手動改過時數，維持原算法', d(amt([4, 4, 4, 4], 8, 0)), 0);
  chk('沒有逐筆資料，維持原算法', d(amt(null, 16, 0)), 0);
  const S10 = S.call('payCollect', '2026-10', 6, 'SSLGF', []);
  chk('2026-10 不多欄位', Object.keys(S10).length, 0);
}

/* ── 同名請假 ── */
{
  const roster = [{ emp_id: 'E01', name: '測試同名', active: 'false', removed_at: '2026-11-10' }, { emp_id: 'E02', name: '測試同名', active: 'true', removed_at: '' }, { emp_id: 'E03', name: '測試單名', active: 'false', removed_at: '2026-10-01' }];
  const master = [{ emp_id: 'E01', name: '測試同名', store: 'SSLGF', hire_date: '2024-01-01', leave_date: '2026-11-10', active: 'false' }, { emp_id: 'E02', name: '測試同名', store: 'SSLGF', hire_date: '2026-11-11', leave_date: '', active: 'true' }];
  const leave = (d, n) => ({ '日期': d, '姓名': n || '測試同名', '假別': '事假', '時數': 8 });
  const run = (ros, rows) => { const S = H.load({ today: '2026-11-30', data: { master, store: STORES }, clock: { SSLGF: { roster: ros, approved: [], events: [], leave: rows } } }); return [S, S.call('payCollect', '2026-11', 6, 'SSLGF', [])]; };
  const who = (o) => Object.keys(o).sort().map((k) => [k, o[k].personal_h]);
  chk('11/05 歸離職的舊人', who(run(roster, [leave('2026-11-05')])[1]), [['E01', 8]]);
  chk('順序對調結果相同', who(run(roster.slice().reverse(), [leave('2026-11-05')])[1]), [['E01', 8]]);
  chk('11/20 歸新人', who(run(roster, [leave('2026-11-20')])[1]), [['E02', 8]]);
  const [S0, o0] = run(roster.slice(2), [leave('2026-11-05', '測試單名')]);
  chk('沒有同名：已停用的人照舊算得到，也不多讀主檔', [who(o0), S0.__COUNT['payRead:master'] || 0], [[['E03', 8]], 0]);
  const two = [{ emp_id: 'E01', name: '測試同名', active: 'true', removed_at: '' }, { emp_id: 'E02', name: '測試同名', active: 'true', removed_at: '' }];
  const S2 = H.load({ today: '2026-11-30', data: { master: [], store: STORES }, clock: { SSLGF: { roster: two, approved: [], events: [], leave: [leave('2026-11-05')] } } });
  chk('兩位都在職：維持最後一筆，標紅', JSON.parse(JSON.stringify(S2.call('payLeaveSameName_', 'SSLGF', '2026-11'))), [{ name: '測試同名', emp_ids: ['E01', 'E02'], rows: 1, to: ['E02'] }]);
  const [S1] = run(roster, [leave('2026-11-05'), leave('2026-10-05')]);
  chk('畫面只列本月有請假的同名', JSON.parse(JSON.stringify(S1.call('payLeaveSameName_', 'SSLGF', '2026-11'))), [{ name: '測試同名', emp_ids: ['E01', 'E02'], rows: 1, to: ['E01'] }]);
  chk('沒有同名不列', JSON.parse(JSON.stringify(run(roster.slice(2), [leave('2026-11-05', '測試單名')])[0].call('payLeaveSameName_', 'SSLGF', '2026-11'))), []);
  const S3 = run(roster, [leave('2026-05-05'), leave('2026-11-20')])[0], T3 = S3.call('payLeaveTypes', 'SSLGF');
  chk('累計額度：新人不算舊人的假', S3.call('payLeaveUsedBefore', '2026-12', 'SSLGF', T3, H.cfg, [master[1]]).E02.personal.used_before_days, 1);
  const sm = S3.call('payAttendanceBuild', '2026-11', roster, [], [], [leave('2026-11-05')], '', [], 'SSLGF');
  chk('出勤紀錄表跟著歸舊人', Array.from(sm.employees).filter((x) => x.days.some((y) => y.leave && y.leave.length)).map((x) => x.emp_id), ['E01']);
}

/* ── 鎖定前重算 ── */
{
  const master = [H.ftEmp()];
  const run0 = (o) => Object.assign({ ym: '2026-11', emp_id: 'E01', name: '測試甲', gross: 30000, deduction: 0, net: 30000, status: 'draft', store: 'SSLGF', ot_info: '{}' }, o || {});
  const mk = (runs, res) => {
    const S = H.load({ today: '2026-12-02', data: { master, store: STORES, run: runs, item: [], audit: [] } });
    vm.runInContext(`checkAdmin=function(){return true}; payCompNegatives=function(){return []}; paySchedMissingAll_=function(){return []}; handlePayrollCalc=function(b){__LAST=b; return ${JSON.stringify(res)}};`, S);
    return S;
  };
  const go = (S, b) => JSON.parse(JSON.stringify(S.call('handlePayrollFinalize', Object.assign({ ym: '2026-11', store: 'SSLGF', lock: true }, b || {}))));
  const same = { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 30000, deduction: 0, net: 30000, ot_info: {} }] };
  let S = mk([run0()], same), r = go(S, { inputs: { E01: { hours: 1 } } });
  chk('相同就照常鎖定', [r.ok, r.status, S.__DATA.run[0].status], [true, 'final', 'final']);
  chk('鎖定前重算用畫面的工時、唯讀', [S.__LAST.dry_run, S.__LAST.inputs.E01.hours], [true, 1]);
  S = mk([run0()], { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 40000, deduction: 0, net: 40000, ot_info: {} }] }); r = go(S);
  chk('金額變了不鎖、草稿不動', [r.ok, r.error, r.list[0].old_net, r.list[0].new_net, S.__DATA.run[0].status, S.__DATA.run[0].gross], [false, 'stale_run', 30000, 40000, 'draft', 30000]);
  S = mk([run0()], { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 30000, deduction: 0, net: 30000, ot_info: { ot_form_missing: [{ date: '2026-11-12', need: 2, have: 0 }] } }] }); r = go(S);
  chk('加班單檢查結果變了也不鎖', [r.error, S.__DATA.run[0].status], ['stale_run', 'draft']);
  S = mk([run0()], { ok: true, results: [] }); r = go(S);
  chk('草稿有、主檔已改離職的人不擋', [r.ok, r.status], [true, 'final']);
  S = mk([run0()], { ok: false, error: 'no_holiday' }); r = go(S);
  chk('重算失敗不鎖', [r.error, S.__DATA.run[0].status], ['recheck_failed', 'draft']);
  /* 薪酬挑錯第 8 項（Eason 2026-11-11 確認）：比對起始月份由 2026-11 改成 2026-10；2026-09 以前仍不比。
     原本這裡是「2026-10 以前不比：[true,'final']」，同一組輸入改放到 2026-09。 */
  S = mk([run0({ ym: '2026-10' })], { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 1, deduction: 0, net: 1, ot_info: {} }] }); r = go(S, { ym: '2026-10' });
  chk('2026-10 也要比：金額變了不鎖、草稿不動', [r.ok, r.error, S.__DATA.run[0].status], [false, 'stale_run', 'draft']);
  S = mk([run0({ ym: '2026-09' })], { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 1, deduction: 0, net: 1, ot_info: {} }] }); r = go(S, { ym: '2026-09' });
  chk('2026-09 以前不比', [r.ok, r.status], [true, 'final']);
  S = mk([run0({ status: 'final' })], { ok: true, results: [{ emp_id: 'E01', name: '測試甲', gross: 1, deduction: 0, net: 1, ot_info: {} }] }); r = go(S, { lock: false, reason: '測試' });
  chk('解鎖不比', [r.ok, r.status], [true, 'draft']);

  /* 前端：stale_run 自動重算，不改狀態 */
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  const a = HTML.indexOf('async function toggleLock()'), b = HTML.indexOf('/* ═════ 工時 ═════ */');
  const log = [];
  const ctx = { STATUS: 'draft', RESULTS: [], ATT_DIRTY: false, CALC_INPUTS: () => ({}), $: () => null, ym: () => '2026-11', vClear() {}, renderRun() {}, toast() {}, setInterval: () => 1, clearInterval() {}, console, prompt: () => '',
    alert: (m) => log.push('alert:' + m.split('\n')[0]), doCalc: async () => log.push('doCalc'), post: async () => ({ ok: false, error: 'stale_run', message: '試算後資料有改過\n測試甲：實付 1 → 2' }), costStable() {}, costTotals() {} };
  vm.createContext(ctx); vm.runInContext(HTML.slice(a, b), ctx);
  ctx.toggleLock().then(() => {
    chk('畫面先說明再自動重算', log, ['alert:試算後資料有改過', 'doCalc']);
    chk('狀態仍是草稿', ctx.STATUS, 'draft');
    console.log(f ? `\n❌ 失敗 ${f}` : `\n✅ 全部通過 (${p}/${p})`); process.exit(f ? 1 : 0);
  });
}
