/* 薪資頁 PR #221 第四輪：讀取與寫入互斥（2026-11-23，fix/payroll-rw-mutex，疊在 fix/payroll-html-followups 上）——不開瀏覽器，抓 payroll.html 的函式原文丟進 vm 實跑。
 *   規則一：寫入開始時若有讀取在途（月資料／假別／事件日／開頁載入）→ 不送、提示「讀取中…」
 *   規則二：寫入的 post 在途時不開始新的讀取（月資料、假別、事件日、背景同步）：先排隊，寫入結束後一定會發
 *   「誰等誰」：讀取等寫入（只等 WRITING 歸零）；寫入從不等讀取（遇到讀取直接拒絕）；doCalcAfterLoad 等讀取（在寫入的 post 結束之後才等）→ 無循環
 *   A 規則一矩陣　B 規則二（含第四輪兩個擋項的重現）　C 寫入失敗不重讀、解鎖重讀　D 不卡死（失敗、逾時、切月切店、並行寫入）　E 正常情況請求序列與 61362ce 相同
 * 用法：node tests/pay-rw-mutex.test.js（結束碼 0＝全過；沒跑到最後＝3） */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const H = fs.readFileSync(path.join(process.env.PAY_HTML_ROOT || ROOT, 'payroll.html'), 'utf8');
let pass = 0, fail = 0, finished = false;
process.on('exit', () => { if (!finished) { console.error('✗ 測試沒有跑到最後（有 Promise 永遠沒完成）'); process.exitCode = 3; } });
const ok = (c, n, extra) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra))); };
function fnSrcFrom(T, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(T);
  if (!m) return '';
  let d = 0, j = T.indexOf('{', m.index);
  for (; j < T.length; j++) { if (T[j] === '{') d++; else if (T[j] === '}' && --d === 0) break; }
  return T.slice(m.index, j + 1);
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const defer = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { await sleep(15); };
const noop = () => {};

const FN = ['readBusy', 'loadingStop', 'wpost', 'wakeWriteWaiters', 'writeIdle', 'writeFence', 'doCalcAfterLoad', 'doCalc', 'loadMonth', 'monUnsure', 'elecPending', 'monBlocked', 'dataStop', 'bonusForeign', 'attForeign', 'saveFX',
  'saveBonus', 'saveMaster', 'saveCfg', 'setMode', 'saveStores', 'saveAtt', 'clearAtt', 'toggleLock', 'syncWrite', 'syncXmap', 'syncHol', 'onceFor', 'loadLeaveTypes', 'loadLeaveTypes1', 'loadLeaveEvents', 'loadLeaveEvents1', 'saveLeaveTypes', 'resetLeaveTypes', 'saveLeaveEvents'];

/* 假後端＋假畫面。hold：這些動作先不回，等 release；failWrites：寫入回 ok:false；holdMonth：月資料讀取先不回（回應內容是「發出當下」的後端）。 */
function mk(Htxt, opt) {
  opt = opt || {};
  const log = { posts: [], bodies: {}, toasts: [], loads: 0 };
  const SRV = { bonus: [{ emp_id: 'A', amount: 100 }, { emp_id: 'B', amount: 200 }], master: [{ emp_id: 'A', base: 1 }, { emp_id: 'B', base: 2 }], cfg: { daily_hours: 8, meal: 5 }, stores: [{ code: 'S', name: 'S店' }, { code: 'T', name: 'T店' }], att: { A: { hours: 8 }, B: { hours: 9 } } };
  const pending = {}, hold = new Set(opt.hold || []);
  const monResp = (S, ym) => ({ ok: true, ym, store: ctx.STORE, inputs: clone(S.att), bonuses: clone(S.bonus), master: clone(S.master), config: clone(S.cfg), stores: clone(S.stores), annual: {}, has_clock: true });
  const commit = (a, body) => {
    if (a === 'payroll_bonus_set') SRV.bonus = clone(body.bonuses);
    if (a === 'payroll_master_set') SRV.master = clone(body.master);
    if (a === 'payroll_config_set') Object.assign(SRV.cfg, clone(body.config));
    if (a === 'payroll_store_set') SRV.stores = clone(body.stores);
    if (a === 'payroll_input_set') SRV.att = clone(body.inputs);
  };
  const ctx = { STORE: 'S', _ym: '2026-10', ym: () => ctx._ym, RES_GEN: {}, LOAD_SEQ: 0, LOAD_INFLIGHT: null, LOAD_WAITERS: [], VGEN: 0, DASH_PREFETCH: null, MON_UNSURE: {}, ELEC_PEND: {}, HOLEMP: [], HOLEMP_OTHER: [], ELEC_DAYS: null, ELEC_KEY: '', ELEC_STALE: false,
    WRITING: 0, WRITE_WAITERS: [], BOOT_BUSY: 0, setTimeout, setInterval, clearInterval, XSYNC_MAX_MS: 6 * 3600 * 1000, HOL_SYNCING: null, ONCE: {},
    OT_PERIOD: {}, HAS_CLOCK: true, SAME_NAME: [], NOT_IN_PAY: [], ZERO_RATIO: [], LEAVE_MM: [], ANNUAL: {}, SUPA: null, SUP_OPEN: {}, ROSTER_MISS: [], ATT_DIRTY: false, CFGSRC: {}, QUOTA: null, QUOTA_KEY: '', RESULTS: [], STATUS: 'draft', ASOF: null, COST_SNAP: null,
    STORES_OK: true, LOCK_BUSY: false, XSUP_FROM: '2026-11', SYNC_BUSY: false, LT_VER: 0, LEV_VER: 0, LT_IS_DEFAULT: false,
    ATT: clone(SRV.att), BONUS: clone(SRV.bonus), MASTER: clone(SRV.master), CFG: clone(SRV.cfg), STORE_LIST: clone(SRV.stores), CFG_DIRTY: { daily_hours: 8 }, CFG_OBSOLETE: [], CFG_POS: {}, CFG_CARDS: { cfg: { own: 'cfgOwn', scope: 'cfgScope', keys: () => ['daily_hours', 'meal'] } },
    ATT_KEY: 'S|2026-10', BONUS_KEY: 'S|2026-10', MASTER_ST: 'S', CFG_ST: 'S', LT_LIST: [{ code: 'a', name: '事假' }], LT_ST: 'S', LEV_LIST: [{ emp_id: 'E1', code: 'c', event_date: '2026-10-01' }], LEV_ST: 'S', SAVE_UNSURE_MSG: 'U', ATT_FOREIGN_MSG: 'F',
    $: () => ({ disabled: false, style: {}, classList: { add: noop, remove: noop, contains: () => false }, textContent: '', checked: false }), toast: (t) => log.toasts.push(t), alert: noop, confirm: () => true, prompt: () => '原因', supCrossBlock: () => false, scopeLimited: () => false, attSendable: () => true, attBtnIdle: noop, CALC_INPUTS: () => ({}),
    syncStoreGuard: () => true, syncCurStore: () => 'S', renderStaffSync: noop, renderAtt: noop, renderLeaveTypes: noop, renderLeaveEvents: noop, applyScopeUi: noop, renderHol: noop,
    setBusy: noop, vClear: noop, elecBtns: noop, renderElec: noop, showLoadError: noop, renderStoreSel: noop, hideLoadError: noop, showClockMode: noop, clearAttDirty: () => { ctx.ATT_DIRTY = false; }, closeQuota: noop, renderEmp: noop,
    loadStaffSync: noop, applyHol: noop, renderCfg: noop, renderRun: noop, renderSlipSel: noop, renderBonus: noop, loadPunch: noop, loadDash: noop, monMixedRecheck: async () => {}, attGuardUi: noop, asofFromCalc: noop, costTotals() { return {}; }, costStable() { return {}; }, costDetail() { return {}; }, lockBlockedBox: noop,
    document: { querySelector: () => ({ classList: { contains: () => false } }) },
    post: (a, body) => {
      log.posts.push(a); (log.bodies[a] = log.bodies[a] || []).push(Object.assign({ _ym: ctx._ym, _store: ctx.STORE }, clone(body || {})));
      if (a === 'payroll_month') { const snap = monResp(SRV, ctx._ym); if (opt.holdMonth) { const d = defer(); (pending[a] = pending[a] || []).push({ d, snap }); return d.p.then(() => clone(snap)); } if (opt.failMonth) return Promise.resolve(opt.failMonth); return Promise.resolve(clone(snap)); }
      if (a === 'payroll_calc') return Promise.resolve({ ok: true, results: [{ amt: 100 + (SRV.bonus[0].amount - 100) }] });
      if (a === 'payroll_finalize') return Promise.resolve(opt.finalizeResp || { ok: true, status: STATUS_AFTER() });
      if (a === 'payroll_xmap_get') return Promise.resolve({ ok: true, synced_at: new Date().toISOString() });
      if (a === 'payroll_holiday_sync') return Promise.resolve({ ok: true, holidays: [], changed: ['2026-10'], names: {} });
      if (a === 'payroll_leave_type_get') { const snap = clone(ctx.LT_LIST); return Promise.resolve({ ok: true, types: snap }); }
      if (a === 'payroll_leave_event_get') return Promise.resolve({ ok: true, events: clone(ctx.LEV_LIST) });
      if (/_set$/.test(a) || a === 'payroll_support_decide' || a === 'payroll_bootstrap') {
        const done = () => { if (opt.failWrites) return { ok: false, error: 'x', message: 'x' }; commit(a, body); return { ok: true, count: 1, config: clone(SRV.cfg), names: [], added: 0 }; };
        if (hold.has(a)) { const d = defer(); (pending[a] = pending[a] || []).push({ d }); return d.p.then(done); }
        return Promise.resolve(done()); }
      if (a === 'payroll_master_get') return Promise.resolve({ ok: true, master: clone(SRV.master) });
      return Promise.resolve({ ok: true }); } };
  const STATUS_AFTER = () => (ctx.STATUS === 'final' ? 'draft' : 'final');
  vm.createContext(ctx);
  vm.runInContext(FN.map(n => fnSrcFrom(Htxt, n)).join('\n'), ctx);
  const release = (a, i) => { const q = (pending[a] || []).filter(x => !x.done); const t = i == null ? q : [q[i]]; t.forEach(x => { x.done = true; x.d.res(); }); };
  return { ctx, log, SRV, pending, hold, release };
}
const counts = (log, a) => log.posts.filter(x => x === a).length;

(async () => {
  /* ═════ A 規則一：讀取在途時，每一種寫入都不送 ═════ */
  console.log('══ A 規則一：讀取在途（月資料／假別／事件日／開頁載入）時每種寫入都不送、提示「讀取中…」 ══');
  const WRITERS = [['saveAtt', c => c.saveAtt()], ['clearAtt', c => c.clearAtt()], ['saveBonus', c => c.saveBonus(null)], ['saveMaster', c => c.saveMaster(null)], ['saveCfg', c => c.saveCfg(null, '儲存', 'cfg')], ['setMode', c => c.setMode('daily_hours', 8)],
    ['saveLeaveTypes', c => c.saveLeaveTypes(null)], ['resetLeaveTypes', c => c.resetLeaveTypes()], ['saveLeaveEvents', c => c.saveLeaveEvents(null)], ['saveStores', c => c.saveStores(null)], ['toggleLock', c => c.toggleLock()],
    ['syncWrite（名冊同步）', c => c.syncWrite(null, '標籤', 'S', () => 'm')]];
  const GUARD_ONLY = [['saveElec', 'saveElec', c => c.saveElec({})], ['supDecide', 'supDecide', c => c.supDecide('E1', 'S', 'auto', 1, null)], ['bootstrapFromRoster', 'bootstrapFromRoster', c => c.bootstrapFromRoster()]];
  const READS = [['月資料讀取（LOAD_INFLIGHT）', c => { c.LOAD_INFLIGHT = { seq: 3, key: 'S|2026-10' }; }], ['假別讀取（ONCE.lt）', c => { c.ONCE.lt = {}; }], ['事件日讀取（ONCE.lev）', c => { c.ONCE.lev = {}; }], ['開頁載入（BOOT_BUSY）', c => { c.BOOT_BUSY = 1; }]];
  for (const [wn, call] of WRITERS) {
    for (const [rn, setRead] of READS) {
      const t = mk(H); setRead(t.ctx);
      await Promise.resolve(call(t.ctx)).catch(() => {});
      const writes = t.log.posts.filter(a => /_set$|finalize|support_decide|bootstrap|payroll_calc/.test(a));
      ok(writes.length === 0 && t.log.toasts.length === 1 && t.log.toasts[0] === '讀取中…', 'A ' + wn + '：' + rn + ' → 不送、提示「讀取中…」', { posts: t.log.posts, toasts: t.log.toasts });
    }
  }
  for (const [wn, name, call] of GUARD_ONLY) {   // 這三支依賴太多畫面元素：只驗「第一件事就是看讀取中」，之後的程式碼碰都沒碰
    for (const [rn, setRead] of READS) {
      const ctx = { LOAD_INFLIGHT: null, BOOT_BUSY: 0, ONCE: {}, toast: (t) => ctx.toasts.push(t), toasts: [], posts: [], post: (a) => { ctx.posts.push(a); return Promise.resolve({ ok: true }); } };
      ctx.wpost = ctx.post; vm.createContext(ctx); vm.runInContext(['readBusy', 'loadingStop', name].map(n => fnSrcFrom(H, n)).join('\n'), ctx); setRead(ctx);
      await Promise.resolve(call(ctx)).catch(() => {});
      ok(ctx.posts.length === 0 && ctx.toasts.length === 1 && ctx.toasts[0] === '讀取中…', 'A ' + wn + '：' + rn + ' → 不送、提示「讀取中…」', { posts: ctx.posts, toasts: ctx.toasts });
    }
  }
  { // 沒有讀取在途：使用者按的重算也照舊送（對照）；讀取中不送（3c4004a 行為）
    const t = mk(H); await t.ctx.doCalc(); ok(counts(t.log, 'payroll_calc') === 1, 'A 對照：沒有讀取在途 → 使用者按重新計算照送');
    const t2 = mk(H); t2.ctx.LOAD_INFLIGHT = { seq: 1, key: 'S|2026-10' }; await t2.ctx.doCalc(); ok(counts(t2.log, 'payroll_calc') === 0 && t2.log.toasts[0] === '讀取中…', 'A 使用者按的重新計算：讀取中照舊不送'); }

  /* ═════ B 規則二：寫入在途時不開始新的讀取 ═════ */
  console.log('══ B 規則二：寫入在途時讀取排隊，寫入結束後一定會發；第四輪兩個擋項 ══');
  { // B1 第四輪擋項一：背景月讀取遇到存獎金。讀取排隊到寫入提交之後才發 → 讀到的是含新獎金的資料，套回畫面不會是舊清單；第二次儲存含第一次的新值
    const t = mk(H, { hold: ['payroll_bonus_set'] });
    t.ctx.BONUS[0].amount = 150; const sb = t.ctx.saveBonus(null); await settle();
    const lm = t.ctx.loadMonth();   // 開頁後的打卡對照同步等背景讀取
    await settle();
    const early = counts(t.log, 'payroll_month'), inflight = !!t.ctx.LOAD_INFLIGHT;
    t.release('payroll_bonus_set'); await sb; await lm; await settle();
    ok(early === 0 && inflight, 'B1 寫入在途：背景月讀取沒有發出（排隊中，畫面顯示讀取中）', { early, inflight });
    const seq = t.log.posts.filter(a => a === 'payroll_bonus_set' || a === 'payroll_month' || a === 'payroll_calc').join(',');
    ok(seq === 'payroll_bonus_set,payroll_month,payroll_calc' && t.ctx.BONUS[0].amount === 150, 'B1 寫入結束後才發讀取、讀完才重算：順序＝存獎金 → 月資料 → 重算；畫面獎金仍含剛存的 150（不是寫入前的 100）', { seq, bonus: t.ctx.BONUS });
    t.hold.clear(); t.ctx.BONUS[1].amount = 250; await t.ctx.saveBonus(null); await settle();
    const sent = t.log.bodies.payroll_bonus_set[1];
    ok(sent.bonuses[0].amount === 150 && sent.bonuses[1].amount === 250, 'B1 第二次儲存（只改乙）送出內容含甲的新值 150（不是「甲的舊金額＋乙的新金額」）', sent);
  }
  { // B2 假別／事件日讀取也排隊
    const t = mk(H, { hold: ['payroll_master_set'] });
    t.ctx.MASTER[0].base = 9; const sm = t.ctx.saveMaster(null); await settle();
    t.ctx.loadLeaveTypes(); t.ctx.loadLeaveEvents(); await settle();
    const early = counts(t.log, 'payroll_leave_type_get') + counts(t.log, 'payroll_leave_event_get');
    t.release('payroll_master_set'); await sm; await settle();
    ok(early === 0 && counts(t.log, 'payroll_leave_type_get') === 1 && counts(t.log, 'payroll_leave_event_get') === 1, 'B2 寫入在途：假別、事件日讀取排隊；寫入結束後各發一次', { early, posts: t.log.posts }); }
  { // B3 背景同步（打卡對照）開始前先等寫入
    const t = mk(H, { hold: ['payroll_bonus_set'] });
    const sb = t.ctx.saveBonus(null); await settle(); const sx = t.ctx.syncXmap(); await settle();
    const early = counts(t.log, 'payroll_xmap_get'); t.release('payroll_bonus_set'); await sb; await sx; await settle();
    ok(early === 0 && counts(t.log, 'payroll_xmap_get') === 1, 'B3 打卡對照背景同步：寫入在途不開始，寫入結束後確實發出', { early, posts: t.log.posts }); }
  { // B4 第四輪擋項二（選舉假／寫入途中紅字同步）：紅字同步等寫入結束；有未存工時就不重載（不蓋掉）；沒有就照舊重載
    for (const [lab, dirty, wantLoad] of [['有未存工時', true, 0], ['沒有未存工時（對照）', false, 1]]) {
      const t = mk(H, { hold: ['payroll_master_set'] }); let loads = 0; t.ctx.loadMonth = async () => { loads++; return true; }; t.ctx.ATT_DIRTY = dirty;
      const sb = t.ctx.saveMaster(null); await settle(); const sh = t.ctx.syncHol(); await settle();
      const early = counts(t.log, 'payroll_holiday_sync'); t.release('payroll_master_set'); await sb; await sh; await settle();
      ok(early === 0 && counts(t.log, 'payroll_holiday_sync') === 1 && loads === wantLoad, 'B4 紅字同步（' + lab + '）：寫入在途時不開始；寫入結束後才發；背景重載 ' + wantLoad + ' 次', { early, loads, posts: t.log.posts });
    } }
  { // B5 第二道防線仍在：寫入柵欄（直接呼叫，模擬漏網的寫入）讓在途的舊讀取作廢並重讀；doCalcAfterLoad 等讀取結束、店月變了就不算
    const t = mk(H, { holdMonth: true });
    const lm = t.ctx.loadMonth(); await settle(); t.ctx.writeFence('S|2026-10'); t.release('payroll_month', 0); await settle();
    ok(counts(t.log, 'payroll_month') === 2, 'B5 柵欄：在途的讀取遇到世代變了 → 丟掉並重讀一次', t.log.posts); t.release('payroll_month'); await lm; await settle();
    const t2 = mk(H, { holdMonth: true }); const lm2 = t2.ctx.loadMonth(); await settle();
    const dc = t2.ctx.doCalcAfterLoad('S|2026-10'); await settle(); const early = counts(t2.log, 'payroll_calc'); t2.release('payroll_month'); await lm2; await dc; await settle();
    ok(early === 0 && counts(t2.log, 'payroll_calc') === 1, 'B5 doCalcAfterLoad：等讀取結束才算（算一次）');
    const t3 = mk(H, { holdMonth: true }); const lm3 = t3.ctx.loadMonth(); await settle(); const dc3 = t3.ctx.doCalcAfterLoad('S|2026-10'); await settle(); t3.ctx._ym = '2026-09'; t3.release('payroll_month'); await lm3; await dc3; await settle();
    ok(counts(t3.log, 'payroll_calc') === 0, 'B5 doCalcAfterLoad：等的期間店月變了 → 不算、不送請求'); }

  /* ═════ C 寫入失敗不重讀；解鎖成功重讀 ═════ */
  console.log('══ C 寫入失敗不重讀、輸入不被蓋；解鎖成功補重讀 ══');
  for (const [name, setup, call] of [
    ['獎金', c => { c.BONUS[0].amount = 150; }, c => c.saveBonus(null)], ['主檔', c => { c.MASTER[0].base = 9; }, c => c.saveMaster(null)], ['參數', c => { c.CFG.daily_hours = 7; c.CFG_DIRTY = { daily_hours: 7 }; }, c => c.saveCfg(null, '儲存', 'cfg')],
    ['門市表', c => { c.STORE_LIST[0].name = '新'; }, c => c.saveStores(null)], ['出勤工時', c => { c.ATT.A.hours = 12; c.ATT_DIRTY = true; }, c => c.saveAtt()]]) {
    const t = mk(H, { failWrites: true }); setup(t.ctx); await call(t.ctx); await settle();
    const live = { 獎金: t.ctx.BONUS[0].amount === 150, 主檔: t.ctx.MASTER[0].base === 9, 參數: t.ctx.CFG.daily_hours === 7, 門市表: t.ctx.STORE_LIST[0].name === '新', 出勤工時: t.ctx.ATT.A.hours === 12 }[name];
    ok(counts(t.log, 'payroll_month') === 0 && counts(t.log, 'payroll_calc') === 0 && live, 'C ' + name + '：寫入失敗 → 不重讀、不重算，使用者還沒存成功的輸入還在畫面上', { posts: t.log.posts }); }
  { // 寫入失敗時背景讀取已排隊：只發它自己那一次（不因柵欄多讀）
    const t = mk(H, { hold: ['payroll_bonus_set'], failWrites: true });
    t.ctx.BONUS[0].amount = 150; const sb = t.ctx.saveBonus(null); await settle(); const lm = t.ctx.loadMonth(); await settle(); t.release('payroll_bonus_set'); await sb; await lm; await settle();
    ok(counts(t.log, 'payroll_month') === 1, 'C 寫入失敗＋背景讀取排隊：只發排隊的那一次月讀取（沒有柵欄多出來的重讀）', t.log.posts); }
  { // 解鎖成功補重讀；鎖定成功原本就重讀
    const t = mk(H); t.ctx.STATUS = 'final'; await t.ctx.toggleLock(); await settle();
    ok(t.log.posts.filter(a => /finalize|payroll_month/.test(a)).join(',') === 'payroll_finalize,payroll_month', 'C 解鎖成功 → 補重讀這個月（以後端為準）', t.log.posts);
    const t2 = mk(H); await t2.ctx.toggleLock(); await settle();
    ok(t2.log.posts.filter(a => /finalize|payroll_month/.test(a)).join(',') === 'payroll_finalize,payroll_month', 'C 鎖定成功 → 重讀（原本就有，對照）', t2.log.posts); }

  /* ═════ D 不卡死 ═════ */
  console.log('══ D 互斥下連續操作不卡死：寫入失敗、讀取失敗、讀取逾時、切月份切門市、並行寫入 ══');
  { // D1 寫入失敗（回 ok:false、或 post 丟例外）：WRITING 歸零，排隊的讀取照發
    for (const [lab, opt] of [['回 ok:false', { failWrites: true, hold: ['payroll_bonus_set'] }], ['post 丟例外', { hold: ['payroll_bonus_set'] }]]) {
      const t = mk(H, opt); if (lab === 'post 丟例外') { const orig = t.ctx.post; t.ctx.post = (a, b) => a === 'payroll_bonus_set' ? Promise.reject(new Error('boom')) : orig(a, b); }
      const sb = t.ctx.saveBonus(null).catch(() => {}); await settle(); const lm = t.ctx.loadMonth(); await settle();
      if (lab !== 'post 丟例外') t.release('payroll_bonus_set'); await sb; await lm; await settle();
      ok(t.ctx.WRITING === 0 && t.ctx.LOAD_INFLIGHT === null && counts(t.log, 'payroll_month') === 1, 'D1 寫入失敗（' + lab + '）：WRITING 歸零、排隊的讀取照發、讀完旗標清掉', { writing: t.ctx.WRITING, inflight: t.ctx.LOAD_INFLIGHT, posts: t.log.posts });
      const again = mk(H); await again.ctx.saveBonus(null); ok(counts(again.log, 'payroll_bonus_set') === 1, 'D1 之後再按儲存可以送（沒有卡住）'); } }
  { // D2 讀取失敗／逾時：旗標清掉，之後寫入照送
    for (const [lab, fm] of [['讀取失敗', { ok: false, error: 'server_error', message: '讀取失敗（測試）' }], ['讀取逾時', { ok: false, error: 'timeout', message: '等候逾時' }]]) {
      const t = mk(H, { failMonth: fm }); await t.ctx.loadMonth(); await settle();
      ok(t.ctx.LOAD_INFLIGHT === null && !t.ctx.readBusy(), 'D2 ' + lab + '：讀取旗標清掉、不再算讀取中');
      t.ctx.ATT_KEY = 'S|2026-10'; t.ctx.BONUS_KEY = 'S|2026-10'; t.ctx.BONUS[0].amount = 150; await t.ctx.saveBonus(null); await settle();
      ok(counts(t.log, 'payroll_bonus_set') === 1, 'D2 ' + lab + ' 之後：儲存不被擋（互斥沒有卡死）', t.log.posts); } }
  { // D3 切月份／切門市：排隊中的讀取被新的取代，只發新店月的那一次
    for (const [lab, sw] of [['切月份', c => { c._ym = '2026-09'; }], ['切門市', c => { c.STORE = 'X'; }]]) {
      const t = mk(H, { hold: ['payroll_bonus_set'] }); const sb = t.ctx.saveBonus(null); await settle();
      const l1 = t.ctx.loadMonth(); await settle(); sw(t.ctx); const l2 = t.ctx.loadMonth(); await settle();
      t.release('payroll_bonus_set'); await sb; await l1; await l2; await settle();
      const b = (t.log.bodies.payroll_month || []);
      ok(b.length === 1 && b[0]._ym === t.ctx._ym && b[0]._store === t.ctx.STORE && t.ctx.LOAD_INFLIGHT === null && t.ctx.WRITING === 0, 'D3 排隊期間' + lab + '：舊的排隊讀取作廢，只對新店月發一次月讀取，沒有卡住', { b: b.map(x => [x._store, x._ym]), cur: [t.ctx.STORE, t.ctx._ym] }); } }
  { // D4 兩個寫入並行（規則一只擋讀取）：讀取等兩個都結束
    const t = mk(H, { hold: ['payroll_bonus_set', 'payroll_master_set'] });
    const a = t.ctx.saveBonus(null); await settle(); const b = t.ctx.saveMaster(null); await settle(); const lm = t.ctx.loadMonth(); await settle();
    t.release('payroll_bonus_set'); await settle(); const mid = counts(t.log, 'payroll_month'); t.release('payroll_master_set'); await a; await b; await lm; await settle();
    ok(mid === 0 && counts(t.log, 'payroll_month') >= 1 && t.ctx.WRITING === 0, 'D4 兩個寫入並行：第一個結束時讀取仍在排隊，兩個都結束後才發', { mid, posts: t.log.posts }); }
  { // D5 讀取排隊（LOAD_INFLIGHT 已標）時，新的寫入被拒、不會再增加寫入；寫入結束後讀取發出、讀完可再存
    const t = mk(H, { hold: ['payroll_bonus_set'] }); const sb = t.ctx.saveBonus(null); await settle(); const lm = t.ctx.loadMonth(); await settle();
    t.ctx.toasts = t.log.toasts.length = 0; await t.ctx.saveMaster(null); const refused = counts(t.log, 'payroll_master_set') === 0 && t.log.toasts[0] === '讀取中…';
    t.release('payroll_bonus_set'); await sb; await lm; await settle(); await t.ctx.saveMaster(null); await settle();
    ok(refused && counts(t.log, 'payroll_master_set') === 1, 'D5 讀取排隊中按儲存 → 讀取中…、不送；讀完再按 → 送出', t.log.posts); }
  { // D6 開頁載入（BOOT_BUSY）期間不能存；boot 結束後恢復（包含 boot 丟例外）
    const t = mk(H); t.ctx.BOOT_BUSY = 1; await t.ctx.saveMaster(null); const refused = counts(t.log, 'payroll_master_set') === 0; t.ctx.BOOT_BUSY = 0; await t.ctx.saveMaster(null);
    ok(refused && counts(t.log, 'payroll_master_set') === 1, 'D6 開頁載入中不送、載入結束後恢復');
    const ctx = { BOOT_BUSY: 0, bootRun: async () => { throw new Error('boom'); } }; vm.createContext(ctx); vm.runInContext(fnSrcFrom(H, 'boot'), ctx);
    await ctx.boot().catch(() => {}); ok(ctx.BOOT_BUSY === 0, 'D6 boot 丟例外：BOOT_BUSY 也會歸零'); }

  /* ═════ E 正常情況（沒有讀取在途）：請求序列與 61362ce 相同 ═════ */
  console.log('══ E 正常情況請求序列與 61362ce 相同 ══');
  let OLD = null; try { OLD = cp.execSync('git show 61362ce:payroll.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (e) { OLD = null; }
  if (!OLD) { console.log('（找不到 61362ce：略過 E，這不算通過；請在有完整 git 歷史的環境跑）'); fail++; }
  else {
    const scen = [['存獎金', c => { c.BONUS[0].amount = 150; return c.saveBonus(null); }], ['存主檔', c => { c.MASTER[0].base = 9; return c.saveMaster(null); }], ['存參數', c => { c.CFG.daily_hours = 7; c.CFG_DIRTY = { daily_hours: 7 }; return c.saveCfg(null, '儲存', 'cfg'); }],
      ['改模式 setMode', c => c.setMode('daily_hours', 8)], ['存門市表', c => { c.STORE_LIST[0].name = '新'; return c.saveStores(null); }], ['存工時', c => { c.ATT.A.hours = 12; c.ATT_DIRTY = true; return c.saveAtt(); }],
      ['清除工時', c => c.clearAtt()], ['鎖定', c => c.toggleLock()], ['存假別設定', c => { c.LT_LIST[0].name = '新事假'; return c.saveLeaveTypes(null); }], ['存事件日', c => { c.LEV_LIST[0].memo = 'm'; return c.saveLeaveEvents(null); }],
      ['使用者按重新計算', c => c.doCalc()], ['名冊同步寫入', c => c.syncWrite(null, '標籤', 'S', (rows) => { rows[0].base = 5; return '已處理'; })]];
    for (const [name, run] of scen) {
      const seqs = [];
      for (const T of [OLD, H]) { const t = mk(T); await Promise.resolve(run(t.ctx)).catch(() => {}); await settle(); seqs.push(t.log.posts.join(',')); }
      ok(seqs[0] === seqs[1], 'E ' + name + '：請求序列與 61362ce 相同', seqs);
    }
    // 對照：解鎖是這一輪刻意多一次重讀
    const u = []; for (const T of [OLD, H]) { const t = mk(T); t.ctx.STATUS = 'final'; await t.ctx.toggleLock(); await settle(); u.push(t.log.posts.filter(a => /finalize|payroll_month/.test(a)).join(',')); }
    ok(u[0] === 'payroll_finalize' && u[1] === 'payroll_finalize,payroll_month', 'E 解鎖：61362ce 只送一個 payroll_finalize，現在多一次重讀（本輪刻意）', u);
  }

  finished = true; process.exitCode = 0;
  console.log('\n小計：通過 ' + pass + '、失敗 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
