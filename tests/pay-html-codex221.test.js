/* 薪資頁 PR #221 交叉審查（Codex）補強三項（2026-11-23，fix/payroll-html-followups）——不開瀏覽器，抓出 payroll.html 的函式原文丟進 vm 實跑。
 *   ①首次讀主檔失敗（boot 提早 return）：出勤／獎金卡片要收起來（attGuardUi）；clearAtt 在表單從沒讀到、別的店月、月資料還在讀時不可送出
 *   ②晚到的舊回應：假別設定、事件日、主檔重讀（syncWrite）回應回來時發出當下的門市已不是現在的 → 整個丟掉，不改清單也不改旗標
 *      其他讀取（loadMonth 的月資料／出勤／獎金／主檔／參數、boot 的主檔）本來就有保護，這裡用靜態斷言鎖住
 *   ③月資料還在讀（LOAD_INFLIGHT）：toggleLock、使用者按的 doCalc、clearAtt 不送；沒有讀取在進行時照舊
 *   ④（第二輪審查）程式自己發出的重算（存獎金、setMode、鎖月 stale_run）遇到月資料正在讀：等讀取結束再算，不可默默丟掉；等的期間店月變了就不算
 * 用法：node tests/pay-html-codex221.test.js（結束碼 0＝全過） */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const H = fs.readFileSync(path.join(process.env.PAY_HTML_ROOT || path.join(__dirname, '..'), 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n, extra) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra))); };
function fnSrc(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(H);
  if (!m) return '';
  let d = 0, j = H.indexOf('{', m.index);
  for (; j < H.length; j++) { if (H[j] === '{') d++; else if (H[j] === '}' && --d === 0) break; }
  return H.slice(m.index, j + 1);
}
const defer = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };
const tick = () => new Promise(r => setImmediate(r));

(async () => {
  /* ═════ ① 首次讀主檔失敗 ═════ */
  console.log('══ ① 首次讀主檔失敗後：卡片收起來、清除工時不送 ══');
  {
    const log = { guard: 0, toasts: [] };
    const ctx = { EMBED: true, ADMIN_KEY: 'k', LOCAL_HOST: false, STORE: 'S', ym: () => '2026-11', LOAD_SEQ: 0, RES_GEN: {}, VGEN: 0, DASH_PREFETCH: null, SCOPE: '*', MASTER: ['舊'],
      post: async () => ({ ok: false, error: 'timeout' }), toast: (t) => log.toasts.push(t), attGuardUi: () => { log.guard++; }, localStorage: { setItem() {} }, pickScopedStore: () => null };
    vm.createContext(ctx); vm.runInContext(fnSrc('boot'), ctx);
    await ctx.boot();
    ok(log.toasts.indexOf('讀取主檔失敗') >= 0 && log.guard === 1 && ctx.MASTER[0] === '舊', 'boot：主檔讀取失敗 → 提早 return 之前呼叫 attGuardUi（出勤／獎金卡片收起來），不套用資料', log);
  }
  {
    const mk = (over) => {
      const log = { posts: [], confirms: 0, toasts: [], loads: 0 };
      const ctx = Object.assign({ STATUS: 'draft', ATT_KEY: 'S|2026-11', STORE: 'S', ym: () => '2026-11', LOAD_INFLIGHT: null, ATT_FOREIGN_MSG: 'F', ATT: {},
        confirm: () => { log.confirms++; return true; }, toast: (t) => log.toasts.push(t), post: async (a) => { log.posts.push(a); return { ok: true }; }, loadMonth: async () => { log.loads++; } }, over);
      vm.createContext(ctx);
      vm.runInContext(['attForeign', 'dataStop', 'loadingStop', 'clearAtt'].map(fnSrc).join('\n'), ctx);
      return { ctx, log };
    };
    for (const [lab, over, want] of [
      ['對照：表單是這個店月的、沒有讀取在進行 → 確認後照送', {}, true],
      ['開頁就讀取失敗（ATT_KEY 空白）', { ATT_KEY: '' }, false],
      ['表單是上個月的（切月份讀取失敗）', { ATT_KEY: 'S|2026-10' }, false],
      ['表單是別家店的（切門市讀取失敗）', { ATT_KEY: 'X|2026-11' }, false],
      ['月資料還在讀（鍵盤 Tab＋Enter）', { LOAD_INFLIGHT: { seq: 2, key: 'S|2026-11' } }, false],
    ]) {
      const t = mk(over); await t.ctx.clearAtt();
      const sent = t.log.posts.indexOf('payroll_input_set') >= 0;
      ok(sent === want && (want || (t.log.confirms === 0 && t.log.toasts.length === 1)), 'clearAtt：' + lab + (want ? ' → 送 payroll_input_set' : ' → 不問、不送、提示一次'), t.log);
    }
    const t = mk({ ATT_KEY: '', LOAD_INFLIGHT: { seq: 1, key: 'x' } }); await t.ctx.clearAtt();
    ok(t.log.toasts[0] === '讀取中…', 'clearAtt：讀取中提示沿用既有「讀取中…」', t.log.toasts);
  }

  /* ═════ ② 晚到的舊回應 ═════ */
  console.log('══ ② 晚到的舊回應不可蓋掉新的 ══');
  {
    const mk = () => {
      const q = [];   // 依序發出的讀取（每個都是 deferred）
      const ctx = { STORE: '', LT_LIST: ['初值'], LT_ST: '', LT_IS_DEFAULT: false, LEV_LIST: ['初值'], LEV_ST: '', ONCE: {}, rendered: 0,
        $: () => null, renderLeaveTypes() { ctx.rendered++; }, renderLeaveEvents() { ctx.rendered++; }, applyScopeUi() {},
        post: (a) => { const d = defer(); q.push({ a, st: ctx.STORE, d }); return d.p; } };
      vm.createContext(ctx);
      vm.runInContext(['onceFor', 'loadLeaveTypes', 'loadLeaveTypes1', 'loadLeaveEvents', 'loadLeaveEvents1'].map(fnSrc).join('\n') + '\nvar ONCE={};', ctx);
      return { ctx, q };
    };
    for (const [name, call, listKey, stKey, action, mkResp] of [
      ['假別設定', c => c.loadLeaveTypes(), 'LT_LIST', 'LT_ST', 'payroll_leave_type_get', (v) => ({ ok: true, types: [v] })],
      ['事件日', c => c.loadLeaveEvents(), 'LEV_LIST', 'LEV_ST', 'payroll_leave_event_get', (v) => ({ ok: true, events: [v] })],
    ]) {
      for (const order of ['舊的比新的晚回來', '舊的先回來']) {
        const { ctx, q } = mk();
        ctx.STORE = '';                       // 開頁時店碼還沒定下來
        const p1 = call(ctx);                 // 第一批（開頁 renderCfg）
        ctx.STORE = 'SSLGF';                  // loadMonth 採用正式店碼
        const p2 = call(ctx);                 // 第二批
        ok(q.length === 2 && q[0].a === action && q[1].a === action, name + '：兩批都發出（店碼不同，onceFor 不合併）', q.length);
        const first = order === '舊的比新的晚回來' ? [1, 0] : [0, 1];
        for (const i of first) { q[i].d.res(mkResp(i === 0 ? '舊(空店碼)' : '新(SSLGF)')); await tick(); await tick(); }
        await Promise.all([p1, p2]);
        ok(ctx[stKey] === 'SSLGF' && ctx[listKey][0] === '新(SSLGF)', name + '：' + order + ' → 旗標＝SSLGF、清單是新的那一份（同店儲存不被誤擋）', { st: ctx[stKey], list: ctx[listKey] });
      }
      // 切店：A 的讀取比 B 晚回來 → 整個丟掉
      const { ctx, q } = mk();
      ctx.STORE = 'A'; const pa = call(ctx);
      ctx.STORE = 'B'; ctx[stKey] = ''; ctx[listKey] = []; const pb = call(ctx);
      q[1].d.res(mkResp('B的')); await tick(); await tick();
      const rendered = ctx.rendered; q[0].d.res(mkResp('A的')); await tick(); await tick(); await Promise.all([pa, pb]);
      ok(ctx[stKey] === 'B' && ctx[listKey][0] === 'B的' && ctx.rendered === rendered, name + '：切店 A→B，A 的回應最後才到 → 不改清單、不改旗標、不重畫', { st: ctx[stKey], list: ctx[listKey], rendered: ctx.rendered - rendered });
    }
  }
  {
    // 名冊同步寫入後重讀主檔（syncWrite）：等重讀時切了店 → 不把這家店的主檔換進現在這家店的畫面（MASTER_ST 會誤放行儲存）
    const log = { posts: [], toasts: [], renders: 0 };
    const g2 = defer(); let n = 0;
    const ctx = { SYNC_BUSY: false, STORE: 'A', MASTER: ['A舊'], MASTER_ST: 'A', syncCurStore: () => String(ctx.STORE).toUpperCase(), syncStoreGuard: () => true,
      renderEmp() { log.renders++; }, renderAtt() {}, vClear() {}, renderStaffSync() {}, toast: (t) => log.toasts.push(t),
      post: (a) => { log.posts.push(a); if (a === 'payroll_master_get') return ++n === 1 ? Promise.resolve({ ok: true, master: [{ e: 1 }] }) : g2.p; return Promise.resolve({ ok: true }); } };
    vm.createContext(ctx); vm.runInContext(fnSrc('syncWrite'), ctx);
    const p = ctx.syncWrite(null, '標籤', 'A', (rows) => { rows.push({ e: 2 }); return '已處理'; });
    await tick(); await tick(); await tick();
    ctx.STORE = 'B'; ctx.MASTER = ['B的主檔']; ctx.MASTER_ST = 'B';   // 使用者切到 B，loadMonth 已換上 B 的主檔
    g2.res({ ok: true, master: [{ e: 'A新' }] }); await p;
    ok(ctx.MASTER[0] === 'B的主檔' && ctx.MASTER_ST === 'B' && log.renders === 0 && log.posts.filter(a => a === 'payroll_master_set').length === 1, 'syncWrite：寫入後重讀主檔時切到別家店 → A 店的主檔不蓋掉 B 店畫面', { MASTER: ctx.MASTER, log });
  }
  console.log('── 其他讀取的保護（靜態鎖住）──');
  ok(H.indexOf("if(seq!==LOAD_SEQ||STORE+'|'+ym()!==reqKey) return true;") >= 0 && /const seq=\(pre&&preSeq\)\?preSeq:\+\+LOAD_SEQ;/.test(H), 'loadMonth（月資料／出勤 ATT／獎金／主檔／參數／門市表）：回應回來時序號或店月變了就整個不套用');
  ok(/const st=STORE;[^\n]*\n  const r=await post\('payroll_leave_type_get'\);[^\n]*\n  if\(!r\|\|!r\.ok\) return;\n  if\(STORE!==st\) return;/.test(H), 'loadLeaveTypes1：發出時記店、回來時不同就丟');
  ok(/const r=await post\('payroll_leave_event_get'\);\n  if\(r&&r\.ok\)\{ if\(STORE!==st\) return;/.test(H), 'loadLeaveEvents1：發出時記店、回來時不同就丟');
  ok(/const usedStore=STORE;/.test(H) && /MASTER_ST=CFG_ST=mStore;/.test(H) && /STORE_LIST=m\.stores;STORES_OK=true/.test(H), 'boot 的主檔／參數：門市下拉在套用前是空的（使用者切不了店），旗標用發出時的店 mStore');
  ok(!/\bloadAtt\(\)/.test(H.replace(/async function loadAtt\(\)/, '')), 'loadAtt 沒有任何呼叫端（死碼；若日後有人接上要補「發出時店月」檢查）');

  /* ═════ ③ 讀取進行中不可鎖定／重算 ═════ */
  console.log('══ ③ 月資料還在讀：鍵盤也不能鎖定、解鎖、重算 ══');
  {
    const mk = (over) => {
      const log = { posts: [], prompts: 0, toasts: [], alerts: 0 };
      const ctx = Object.assign({ STATUS: 'final', ASOF: null, RESULTS: [], STORE: 'S', ym: () => '2026-10', LOAD_INFLIGHT: null, MON_UNSURE: {}, ELEC_PEND: {}, LOCK_BUSY: false, ATT_DIRTY: false, RES_GEN: {},
        $: () => null, toast: (t) => log.toasts.push(t), prompt: () => { log.prompts++; return '測試原因'; }, alert: () => { log.alerts++; }, confirm: () => true,
        setBusy() {}, supCrossBlock: () => false, CALC_INPUTS: () => ({}), elecBtns() {}, costTotals() { return {}; }, costStable() { return {}; }, costDetail() { return {}; },
        post: async (a) => { log.posts.push(a); return { ok: false, error: 'x', message: 'x' }; } }, over);
      vm.createContext(ctx);
      vm.runInContext(['elecPending', 'monUnsure', 'monBlocked', 'loadingStop', 'toggleLock', 'doCalc'].map(fnSrc).join('\n'), ctx);
      return { ctx, log };
    };
    const run = async (fn, c) => { try { await fn(c); } catch (e) { /* 回應之後的畫面更新缺 helper：不影響「有沒有送出」的判斷 */ } };
    // 切月份（11→10），10 月的月資料還沒回來，畫面上仍是 11 月的狀態
    for (const [lab, st] of [['已鎖定（解鎖）', 'final'], ['草稿（鎖定）', 'draft']]) {
      const t = mk({ STATUS: st, RESULTS: st === 'draft' ? [{ emp_id: 'E1' }] : [], LOAD_INFLIGHT: { seq: 3, key: 'S|2026-10' } });
      await run(c => c.toggleLock(), t.ctx);
      ok(t.log.posts.length === 0 && t.log.prompts === 0 && t.log.toasts[0] === '讀取中…', 'toggleLock：切月份、讀取未回、' + lab + ' → 沒有送出任何請求、不跳解鎖原因框、提示「讀取中…」', t.log);
    }
    {
      const t = mk({ LOAD_INFLIGHT: { seq: 3, key: 'S|2026-10' } });
      await run(c => c.doCalc(), t.ctx);
      ok(t.log.posts.length === 0 && t.log.toasts[0] === '讀取中…', 'doCalc()（使用者按重新計算）：讀取未回 → 不送', t.log);
    }
    {
      const t = mk({ LOAD_INFLIGHT: { seq: 3, key: 'S|2026-10' } });
      await run(c => c.doCalc(7), t.ctx); await run(c => c.doCalc(undefined, true), t.ctx);
      ok(t.log.posts.filter(a => a === 'payroll_calc').length === 2, 'doCalc 帶 pendSeq／inputsSaved（存檔後的重算）不受影響：自己處理在途的讀取，照送', t.log);
    }
    // 對照：沒有讀取在進行 → 行為不變
    {
      const t = mk({ STATUS: 'final' });
      await run(c => c.toggleLock(), t.ctx);
      ok(t.log.prompts === 1 && t.log.posts.indexOf('payroll_finalize') >= 0, '對照：沒有讀取在進行、已鎖定 → 解鎖照走（問原因、送 payroll_finalize）', t.log);
      const t2 = mk({ STATUS: 'draft' });
      await run(c => c.toggleLock(), t2.ctx);
      ok(t2.log.posts.indexOf('payroll_finalize') >= 0, '對照：沒有讀取在進行、草稿 → 鎖定照送 payroll_finalize', t2.log);
      const t3 = mk({});
      await run(c => c.doCalc(), t3.ctx);
      ok(t3.log.posts.indexOf('payroll_calc') >= 0, '對照：沒有讀取在進行 → 重新計算照送 payroll_calc', t3.log);
    }
    ok(/async function toggleLock\(\)\{\n  if\(loadingStop\(\)\) return;/.test(H), 'toggleLock 第一行就看 loadingStop（在 monBlocked 與任何 prompt 之前）');
    ok(/function loadingStop\(\)\{ if\(!LOAD_INFLIGHT\) return false; toast\('讀取中…',true\); return true; \}/.test(H), 'loadingStop 只用既有字串「讀取中…」');
  }

  /* ═════ ④ 程式自動發出的重算遇到讀取中：等讀取結束再算 ═════ */
  console.log('══ ④ 存獎金／setMode／鎖月 stale_run 遇到背景讀取：讀取結束後補算 ══');
  {
    const flushM = /if\(!LOAD_INFLIGHT&&LOAD_WAITERS\.length\)\{ const w=LOAD_WAITERS; LOAD_WAITERS=\[\]; w\.forEach\(f=>f\(\)\); \}/.exec(fnSrc('loadMonth'));
    ok(!!flushM, 'loadMonth 的 finally 清掉 LOAD_INFLIGHT 後會喚醒等待中的自動重算（LOAD_WAITERS）');
    const FLUSH = flushM ? flushM[0] : '';
    const SAVED = '獎金已儲存（1 筆）';
    const mk = (over) => {
      const log = { posts: [], toasts: [], alerts: 0 };
      const fin = defer();
      const ctx = Object.assign({ STORE: 'S', _ym: '2026-10', ym: () => ctx._ym, STATUS: 'draft', ASOF: null, RESULTS: [{ amt: 100 }], LOAD_INFLIGHT: null, LOAD_WAITERS: [], MON_UNSURE: {}, ELEC_PEND: {}, LOCK_BUSY: false, ATT_DIRTY: false, RES_GEN: {},
        SAVE_UNSURE_MSG: 'U', BACK: { bonus: 0 }, BONUS_KEY: 'S|2026-10', CFG_ST: 'S', CFG: {}, BONUS: [{ emp_id: 'E1', amount: 500 }], COST_SNAP: null, NOT_IN_PAY: [], ZERO_RATIO: [], LEAVE_MM: [], ELEC_STALE: false,
        $: () => null, toast: (t) => log.toasts.push(t), prompt: () => '原因', alert: () => { log.alerts++; }, confirm: () => true, setBusy() {}, supCrossBlock: () => false, CALC_INPUTS: () => ({}), elecBtns() {},
        vClear() {}, renderRun() {}, renderSlipSel() {}, renderCfg() {}, asofFromCalc() {}, loadMonth: async () => true, costTotals() { return {}; }, costStable() { return {}; }, costDetail() { return {}; }, lockBlockedBox() {},
        post: async (a) => { log.posts.push(a + '@' + ctx.STORE + '|' + ctx._ym);
          if (a === 'payroll_bonus_set') { ctx.BACK.bonus = 500; return { ok: true, count: 1 }; }
          if (a === 'payroll_config_set') return { ok: true, config: {} };
          if (a === 'payroll_calc') return { ok: true, results: [{ amt: 100 + ctx.BACK.bonus }] };
          if (a === 'payroll_finalize') return fin.p;
          return { ok: false }; } }, over);
      vm.createContext(ctx);
      vm.runInContext(['saveBonus', 'saveFX', 'dataStop', 'bonusForeign', 'setMode', 'loadingStop', 'doCalcAfterLoad', 'doCalc', 'elecPending', 'monUnsure', 'monBlocked', 'toggleLock'].map(fnSrc).join('\n'), ctx);
      // 背景讀取（開頁後的打卡對照同步）：開始＝LOAD_INFLIGHT 有值；結束＝套回「寫入前」的舊草稿、清旗標、喚醒等待的重算（喚醒那段用 payroll.html 原文）
      const bg = () => { const d = defer(); ctx.LOAD_INFLIGHT = { seq: 9, key: ctx.STORE + '|' + ctx._ym };
        d.p.then(() => { ctx.RESULTS = [{ amt: 100 }]; vm.runInContext('LOAD_INFLIGHT=null;' + FLUSH, ctx); }); return d; };
      return { ctx, log, fin, bg };
    };
    const calcs = (log) => log.posts.filter(x => x.indexOf('payroll_calc') === 0);
    const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
    const run = (f) => f().catch(() => {});

    // (a) 開頁背景同步進行中存獎金
    { const t = mk({}); const b = t.bg(); const p = t.ctx.saveBonus(null); await settle();
      const before = calcs(t.log).length, savedEarly = t.log.toasts.indexOf(SAVED) >= 0;
      b.res(); await p; await settle();
      ok(before === 0 && !savedEarly && calcs(t.log).length === 1 && t.ctx.RESULTS[0].amt === 600 && t.log.toasts.indexOf(SAVED) >= 0, '(a) 背景讀取進行中存獎金：讀取結束後才送 payroll_calc 一次、畫面金額含新獎金（600，不是舊草稿的 100）；讀完才顯示「獎金已儲存」', { before, savedEarly, posts: t.log.posts, res: t.ctx.RESULTS }); }
    // (b) 同情境 setMode（目前全檔唯一會在存參數後重算的路徑；saveCfg 本來就不重算）
    { const t = mk({}); t.ctx.BACK.bonus = 500; const b = t.bg(); await t.ctx.setMode('daily_hours', 8); await settle();
      const before = calcs(t.log).length; b.res(); await settle();
      ok(before === 0 && calcs(t.log).length === 1 && t.ctx.RESULTS[0].amt === 600, '(b) 背景讀取進行中改設定（setMode）：讀取結束後補送 payroll_calc、畫面是重算後的金額', { before, posts: t.log.posts, res: t.ctx.RESULTS }); }
    // (c) 鎖月收到 stale_run 時有讀取在跑
    { const t = mk({}); t.ctx.BACK.bonus = 500; const p = run(() => t.ctx.toggleLock()); await settle();
      const b = t.bg(); t.fin.res({ ok: false, error: 'stale_run', message: '試算後資料有改過' }); await settle();
      const before = calcs(t.log).length; b.res(); await p; await settle();
      ok(t.log.alerts === 1 && before === 0 && calcs(t.log).length === 1 && t.ctx.RESULTS[0].amt === 600, '(c) 鎖月回 stale_run、背景讀取在跑：說明對話框照跳，讀取結束後補送 payroll_calc、畫面是重算後的金額', { alerts: t.log.alerts, before, posts: t.log.posts, res: t.ctx.RESULTS }); }
    // (d) 等待期間使用者切了月份／門市 → 不補算、不送任何請求到新的店月
    for (const [lab, sw] of [['切月份', c => { c._ym = '2026-09'; }], ['切門市', c => { c.STORE = 'X'; }]]) {
      for (const [nm, start] of [['存獎金', (t) => t.ctx.saveBonus(null)], ['setMode', (t) => t.ctx.setMode('daily_hours', 8)]]) {
        const t = mk({}); const b = t.bg(); const p = start(t); await settle();
        const k = t.log.posts.length; sw(t.ctx); b.res(); await run(() => p); await settle();
        ok(t.log.posts.length === k && calcs(t.log).length === 0, '(d) ' + nm + '：等讀取時' + lab + ' → 不補算、不送任何請求（新店月沒有被拿去算）', t.log.posts);
      }
      const t = mk({}); const p = run(() => t.ctx.toggleLock()); await settle(); const b = t.bg(); t.fin.res({ ok: false, error: 'stale_run', message: 'm' }); await settle();
      const k = t.log.posts.length; sw(t.ctx); b.res(); await p; await settle();
      ok(t.log.posts.length === k && calcs(t.log).length === 0, '(d) stale_run 補算：等讀取時' + lab + ' → 不補算、不送任何請求', t.log.posts);
    }
    // (e) 沒有讀取在跑：三處照改版前（立刻送一次 payroll_calc）
    { const t = mk({}); await t.ctx.saveBonus(null);
      ok(calcs(t.log).length === 1 && t.ctx.RESULTS[0].amt === 600 && t.log.toasts.indexOf(SAVED) >= 0, '(e) 沒有讀取在跑：存獎金 → 立刻重算一次、畫面含新獎金', t.log.posts); }
    { const t = mk({}); await t.ctx.setMode('daily_hours', 8); await settle();
      ok(calcs(t.log).length === 1, '(e) 沒有讀取在跑：setMode → 立刻重算一次', t.log.posts); }
    { const t = mk({}); const p = run(() => t.ctx.toggleLock()); await settle(); t.fin.res({ ok: false, error: 'stale_run', message: 'm' }); await p; await settle();
      ok(t.log.alerts === 1 && calcs(t.log).length === 1, '(e) 沒有讀取在跑：stale_run → 對話框後立刻重算一次', t.log); }
    // 使用者直接按的重算：讀取中照舊不送（3c4004a 的行為）
    { const t = mk({}); t.bg(); await run(() => t.ctx.doCalc()); ok(calcs(t.log).length === 0 && t.log.toasts[0] === '讀取中…', '使用者按的 doCalc()：讀取中照舊不送、提示「讀取中…」', t.log); }
    ok(!/await doCalc\(\);|[^A-Za-z]doCalc\(\)\}/.test(H.replace(/onclick="doCalc\(\)"/, '')), '程式自己發出的無參數 doCalc() 全部改走 doCalcAfterLoad（只剩按鈕的 onclick）');
  }

  console.log('\n小計：通過 ' + pass + '、失敗 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
