/* 薪資頁後續小修（2026-11-23，fix/payroll-html-followups）——不開瀏覽器的部分；實際按按鈕的版本在 tests/ui/pay-html-followups-e2e.py。
 *   ①表單是哪個店月的：attForeign／ATT_KEY 只在讀取成功時換；loadMonth 讀取失敗不改 ATT_KEY、finally 一律 attGuardUi
 *   ②「儲存工時 ●」：已是未存狀態再編輯也補圓點；按鈕停用中不動字；attBtnIdle 依 ATT_DIRTY
 *   ③待辦 17（5A）：鎖定被擋走 lockBlockedBox；加句只給三種；只有「知道了」能關
 *   ⑤讀取失敗後重新載入成功：先問 payroll_status，mixed／查不到照擋，草稿／已鎖／沒資料／舊後端才解開
 *   ⑥同一類的其他資料（驗收補）：獎金、主檔、參數、假別設定、事件日、門市表——資料是別店（月）的或沒讀到就不送（後端都是整份取代） */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
let done6 = Promise.resolve();
const ok = (c, n, extra) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra))); };
function fnSrc(name) {   // 頂層函式原文（配對大括號）
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(H);
  if (!m) return '';
  let d = 0, j = H.indexOf('{', m.index);
  for (; j < H.length; j++) { if (H[j] === '{') d++; else if (H[j] === '}' && --d === 0) break; }
  return H.slice(m.index, j + 1);
}

console.log('══ ① 出勤表單是哪個店月的 ══');
{
  const lm = fnSrc('loadMonth');
  const iFail = lm.indexOf('if(!r.ok){'), iOk = lm.indexOf("ATT_KEY=BONUS_KEY=STORE+'|'+ym();");
  ok(/function attForeign\(\)\{ return ATT_KEY!==STORE\+'\|'\+ym\(\); \}/.test(H), 'attForeign()＝ATT_KEY 跟畫面上的店月不同');
  ok(iFail > 0 && iOk > iFail && lm.slice(iFail, lm.indexOf('return false;', iFail)).indexOf('ATT_KEY') < 0, 'loadMonth：讀取失敗那段不改 ATT_KEY；讀取成功（換掉 ATT 之後）才設成這個店月');
  ok(/finally \{[^}]*attGuardUi\(\); \}/.test(lm), 'loadMonth：finally 一律 attGuardUi()（失敗時收起表單、成功時打開）');
  ok(/^\s*if\(dataStop\(attForeign\(\),ATT_FOREIGN_MSG\)\) return;/.test(fnSrc('saveAtt').split('\n')[1]), 'saveAtt：第一行就擋 attForeign()');
  ok(/^\s*if\(dataStop\(attForeign\(\),ATT_FOREIGN_MSG\)\) return;/.test(fnSrc('supDecide').split('\n')[1]), 'supDecide：第一行就擋 attForeign()');
  ok(H.indexOf("const ATT_FOREIGN_MSG='這個月的出勤資料沒有讀取成功，為了避免存錯月份，先不能修改或儲存工時。請重新整理頁面後再操作。';   // Eason 2026-11-23 核可") >= 0, '出勤被擋的字句＝核可原文、註解寫核可');
  ok(H.indexOf("const SAVE_UNSURE_MSG='這個月的資料沒有讀取成功，為了避免存錯月份或門市，先不能儲存。請重新整理頁面後再操作。';") >= 0, '非工時類儲存被擋的字句＝主管核可新句（一字不差）');
  ok(H.indexOf("const MON_UNSURE_MSG='這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出';") >= 0, '匯出被擋的字句＝舊句、一字不改');
  ok((H.match(/dataStop\([^\n]*MON_UNSURE_MSG/g) || []).length === 0 && (H.match(/dataStop\([^\n]*SAVE_UNSURE_MSG/g) || []).length === 7, '所有 dataStop 儲存路徑（獎金、主檔、參數×2、假別設定、事件日、門市表）都用新句、沒有一處還用舊句');
  ok(/function monUnsureStop\(\)\{ if\(!monUnsure\(\)\) return false; toast\(MON_UNSURE_MSG,true\); return true; \}/.test(H) && /guardPanel\('p-bonus','bonusForeign',bonusForeign\(\),SAVE_UNSURE_MSG\)/.test(H), '匯出／列印仍用舊句；獎金分頁提示用新句');
  ok(/ATT_KEY=r\.ok\?STORE\+'\|'\+ym\(\):'';/.test(fnSrc('loadAtt')), 'loadAtt：讀失敗 ATT_KEY 空白');
  ok(/\.panel\.pay-foreign \.card,#p-att\.pay-foreign #supWarn\{display:none\}/.test(H), 'CSS：資料不是這個店月的 → 該分頁的卡片（出勤另含支援提醒）收起來');
  // attGuardUi 實跑（假 DOM）
  const els = {};
  const mk = (id) => ({ id, style: {}, className: '', textContent: '', classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } } });
  els['p-att'] = Object.assign(mk('p-att'), { firstChild: null, insertBefore(el) { els[el.id] = el; } });
  els['p-bonus'] = Object.assign(mk('p-bonus'), { firstChild: null, insertBefore(el) { els[el.id] = el; } });
  const ctx = { STORE: 'S', ym: () => '2026-10', ATT_KEY: 'S|2026-11', BONUS_KEY: 'S|2026-11', ATT_FOREIGN_MSG: '（提示）', MON_UNSURE_MSG: '（匯出舊句）', SAVE_UNSURE_MSG: '（沒讀到）', $: (id) => els[id] || null, document: { createElement: () => mk('') } };
  vm.createContext(ctx); vm.runInContext(['attForeign', 'bonusForeign', 'guardPanel', 'attGuardUi'].map(fnSrc).join('\n'), ctx);
  ctx.attGuardUi();
  ok(els['p-att'].classList.contains('pay-foreign') && els.attForeign && els.attForeign.textContent === '（提示）' && els.attForeign.style.display === '', 'attGuardUi：表單是 11 月的、畫面在 10 月 → 出勤收起來＋核可那句');
  ok(els['p-bonus'].classList.contains('pay-foreign') && els.bonusForeign && els.bonusForeign.textContent === '（沒讀到）', 'attGuardUi：獎金也是 11 月的 → 獎金分頁收起來＋用 SAVE_UNSURE_MSG（不是匯出那句）');
  ctx.ATT_KEY = ctx.BONUS_KEY = 'S|2026-10'; ctx.attGuardUi();
  ok(!els['p-att'].classList.contains('pay-foreign') && els.attForeign.style.display === 'none' && !els['p-bonus'].classList.contains('pay-foreign') && els.bonusForeign.style.display === 'none', 'attGuardUi：讀取成功（10 月）→ 兩個分頁打開、提示收掉');
}

console.log('══ ② 儲存工時 ● ══');
{
  const btn = { disabled: false, textContent: '儲存工時', title: '', classList: { add() {}, remove() {} } };
  const ctx = { ATT_DIRTY: false, $: () => btn };
  vm.createContext(ctx); vm.runInContext(fnSrc('markAttDirty') + '\n' + fnSrc('attBtnIdle'), ctx);
  ctx.markAttDirty();
  ok(ctx.ATT_DIRTY && btn.textContent === '儲存工時 ●', '第一次編輯 → ●');
  btn.textContent = '儲存工時'; ctx.markAttDirty();   // 模擬改版前「存檔失敗把字改回去」之後再編輯
  ok(btn.textContent === '儲存工時 ●', '已經是未存狀態、按鈕字被改回「儲存工時」→ 再編輯圓點回來（改版前不回來）');
  btn.disabled = true; btn.textContent = '存取中…'; ctx.markAttDirty();
  ok(btn.textContent === '存取中…', '按鈕停用中（存取中…）→ 不動字');
  ctx.attBtnIdle(btn);
  ok(!btn.disabled && btn.textContent === '儲存工時 ●' && btn.title === '有尚未儲存的變更', 'attBtnIdle：還有未存 → 可按、帶圓點');
  ctx.ATT_DIRTY = false; ctx.attBtnIdle(btn);
  ok(btn.textContent === '儲存工時' && btn.title === '', 'attBtnIdle：沒有未存 → 不帶圓點');
  const sa = fnSrc('saveAtt');
  ok(/if\(!r\.ok\)\{attBtnIdle\(b\);toast\('儲存失敗：'/.test(sa) && /setTimeout\(\(\)=>attBtnIdle\(b\),1800\)/.test(sa), 'saveAtt：存檔失敗與存好 1.8 秒後都走 attBtnIdle');
}

console.log('══ ③ 待辦 17（5A）鎖定被擋的視窗 ══');
{
  const tl = fnSrc('toggleLock'), bx = fnSrc('lockBlockedBox');
  ok(/else if\(lock&&r\.message\) lockBlockedBox\(r\.error,r\.message\);/.test(tl) && !/else if\(lock&&r\.message\) toast\(/.test(tl), 'toggleLock：被擋的說明改走 lockBlockedBox（不再是 2.6 秒的紅字）');
  ok(/const LOCK_SHOT_ERR=\{g_rows_conflict:1,g_rows_fp:1,g_rows_missing:1\};/.test(H), '加「請把這個畫面截圖傳給資訊部。」只給衝突、對不上、還沒回報三種');
  ok(/'請把這個畫面截圖傳給資訊部。'/.test(bx) && />知道了<\/button>/.test(bx), '視窗：加句逐字、按鈕「知道了」');
  ok(!/Escape|keydown/.test(bx) && !/mask\.addEventListener\('click'/.test(bx) && /#lockBlockedOk'\)\.onclick=\(\)=>mask\.remove\(\)/.test(bx), '只有「知道了」能關（沒有 Esc、按外圍關閉）');
  ok(/\.textContent=String\(msg\|\|''\)/.test(bx), '後端字句用 textContent 放（不當 HTML）');
}

console.log('══ ⑥ 同一類的其他資料：別店（月）的或沒讀到就不送 ══');
{
  const lm = fnSrc('loadMonth'), iFail = lm.indexOf('if(!r.ok){'), failPart = lm.slice(iFail, lm.indexOf('return false;', iFail));
  ok(!/BONUS_KEY|MASTER_ST|CFG_ST|LT_ST|LEV_ST/.test(failPart), 'loadMonth 讀取失敗那段不改任何資料記號（只有另外讀到門市表時記 STORES_OK）');
  ok(/ATT_KEY=BONUS_KEY=STORE\+'\|'\+ym\(\);/.test(lm) && /MASTER=r\.master;MASTER_ST=STORE;/.test(lm) && /CFG=r\.config;CFG_DIRTY=\{\};CFG_ST=STORE/.test(lm), 'loadMonth 讀取成功：獎金、主檔、參數記成這個店（月）');
  ok(/LT_LIST=\[\]; LT_ST=''; loadLeaveTypes\(\); LEV_LIST=\[\]; LEV_ST=''; loadLeaveEvents\(\);/.test(lm), '換店重讀假別設定／事件日：先清空並標成還沒讀到（讀失敗不會存空白）');
  ok(/const st=STORE;[\s\S]*LT_ST=st;/.test(fnSrc('loadLeaveTypes1')) && /const st=STORE;[\s\S]*LEV_ST=st;/.test(fnSrc('loadLeaveEvents1')), '假別設定／事件日讀取成功才記門市（用發出時的門市）');
  ok(/MASTER_ST=CFG_ST=mStore;/.test(fnSrc('boot')) && /mStore=STORE; \}/.test(fnSrc('boot')), '開頁：主檔／參數記成實際讀的那家店');
  // 實跑：每支存檔在「資料是別店（月）的／沒讀到」時不送，對照組照送
  const FN = ['dataStop', 'bonusForeign', 'saveFX', 'saveBonus', 'saveMaster', 'saveCfg', 'setMode', 'saveLeaveTypes', 'saveLeaveEvents', 'saveStores'];
  const mk = (over) => {
    const log = { posts: [], toasts: [] };
    const btn = { disabled: false, textContent: '', classList: { add() {}, remove() {} }, checked: false };
    const ctx = Object.assign({ console, setTimeout: () => 0, STORE: 'S', ym: () => '2026-10', LOAD_INFLIGHT: null, MON_UNSURE_MSG: 'M', SAVE_UNSURE_MSG: 'U', STATUS: 'draft', RESULTS: [],
      BONUS_KEY: 'S|2026-10', MASTER_ST: 'S', CFG_ST: 'S', LT_ST: 'S', LEV_ST: 'S', STORES_OK: true,
      BONUS: [{ emp_id: 'E1', amount: 1 }], MASTER: [{ emp_id: 'E1' }], CFG: { daily_hours: 8 }, CFG_DIRTY: { daily_hours: 8 }, CFG_OBSOLETE: [], CFGSRC: {}, CFG_POS: {},
      CFG_CARDS: { cfg: { own: 'x', scope: 'y', keys: () => ['daily_hours'] } }, LT_LIST: [{ name: '事假', code: 'personal' }], LEV_LIST: [{ emp_id: 'E1', code: 'c', event_date: '2026-10-01' }], STORE_LIST: [{ code: 'S' }],
      $: () => btn, toast: (t, bad) => log.toasts.push(t), doCalc: async () => {}, renderEmp() {}, renderCfg() {}, renderStoreSel() {}, loadLeaveTypes: async () => {}, loadLeaveEvents: async () => {},
      post: async (a) => { log.posts.push(a); return { ok: true, count: 1, config: {} }; } }, over);
    vm.createContext(ctx);
    vm.runInContext(FN.map(fnSrc).join('\n'), ctx);
    return { ctx, log, btn };
  };
  const cases = [
    ['saveBonus', c => c.saveBonus(null), 'payroll_bonus_set', [['獎金是上個月讀來的', { BONUS_KEY: 'S|2026-09' }], ['獎金是別家店的', { BONUS_KEY: 'X|2026-10' }], ['開頁就沒讀到（空白）', { BONUS_KEY: '' }]]],
    ['saveMaster', c => c.saveMaster(null), 'payroll_master_set', [['主檔是別家店的（切店讀取失敗）', { MASTER_ST: 'X' }], ['開頁主檔沒讀到（空白）', { MASTER_ST: '' }]]],
    ['saveCfg', c => c.saveCfg(null, '儲存', 'cfg'), 'payroll_config_set', [['參數是別家店的', { CFG_ST: 'X' }], ['開頁參數沒讀到', { CFG_ST: '' }]]],
    ['setMode', c => c.setMode('daily_hours', 8), 'payroll_config_set', [['參數是別家店的（整份送出）', { CFG_ST: 'X' }]]],
    ['saveLeaveTypes', c => c.saveLeaveTypes(null), 'payroll_leave_type_set', [['假別設定是別家店的', { LT_ST: 'X' }], ['假別設定沒讀到（空白）', { LT_ST: '' }]]],
    ['saveLeaveEvents', c => c.saveLeaveEvents(null), 'payroll_leave_event_set', [['事件日是別家店的', { LEV_ST: 'X' }], ['事件日沒讀到（空白）', { LEV_ST: '' }]]],
    ['saveStores', c => c.saveStores(null), 'payroll_store_set', [['門市表沒讀到（空白＝會清光門市表）', { STORES_OK: false, STORE_LIST: [] }]]],
  ];
  done6 = (async () => {
    for (const [name, call, act, bad] of cases) {
      let t = mk({}); await call(t.ctx);
      ok(t.log.posts.indexOf(act) >= 0, name + ' 對照：資料是這家店（這個月）的 → 照送 ' + act, t.log);
      for (const [lab, over] of bad) {
        t = mk(over); await call(t.ctx);
        ok(t.log.posts.indexOf(act) < 0 && t.log.toasts[0] === 'U', name + '：' + lab + ' → 不送、提示用 SAVE_UNSURE_MSG（U，不是匯出的 M）', t.log);
      }
    }
    const t = mk({ BONUS_KEY: 'S|2026-09', LOAD_INFLIGHT: { seq: 1 } }); await t.ctx.saveBonus(null);
    ok(t.log.posts.length === 0 && t.log.toasts[0] === '讀取中…', '月資料還在讀 → 不送、提示沿用月份列的「讀取中…」', t.log);
  })();
}

console.log('══ ⑤ 讀取失敗後重新載入成功：先確認不是一半鎖定 ══');
{
  const lm = fnSrc('loadMonth');
  ok(/const wasUnsure=monUnsure\(\);/.test(lm) && /if\(!wasUnsure\) delete MON_UNSURE\[reqKey\];/.test(lm) && /if\(wasUnsure\) await monMixedRecheck\(reqKey,seq\);/.test(lm), 'loadMonth：旗標原本在 → 不直接解開，先 monMixedRecheck');
  const run = async (st, opt) => {
    opt = opt || {};
    const log = { posts: [], toasts: [], btns: 0 };
    const ctx = { STORE: 'S', ym: () => opt.ym || '2026-11', LOAD_SEQ: opt.seq || 1, MON_UNSURE: { 'S|2026-11': 1 }, MON_UNSURE_MSG: 'U', toast: (m, bad) => log.toasts.push(m), elecBtns: () => log.btns++,
      post: async (a, b, o) => { log.posts.push([a, b, o]); return st; } };
    vm.createContext(ctx); vm.runInContext(H.match(/const MON_MIXED_MSG='[^']+';/)[0] + '\n' + fnSrc('monMixedRecheck') + '\nthis.f=monMixedRecheck;this.M=MON_MIXED_MSG;', ctx);
    await ctx.f('S|2026-11', 1);
    return { unsure: !!ctx.MON_UNSURE['S|2026-11'], log, M: ctx.M };
  };
  (async () => {
    await done6;
    const S = (status) => ({ ok: true, ym: '2026-11', store: 'S', status, rows: 4 });
    let r = await run(S('mixed'));
    ok(r.unsure && r.log.toasts[0] === r.M && r.log.posts[0][0] === 'payroll_status' && r.log.posts[0][1].ym === '2026-11' && r.log.posts[0][1].store === 'S' && r.log.posts[0][2].noRetry, 'payroll_status 回 mixed → 照擋、提示沿用鎖定那一句（改版前這裡直接解開）', r);
    ok(r.M === '這個月有一部分已鎖定、一部分還是草稿，請重新整理頁面看狀態；重新整理後還是這樣請找資訊部' && H.indexOf("toast('" + r.M + "',true)") > 0, 'mixed 提示＝toggleLock 既有那一句（逐字）');
    for (const s of ['draft', 'final', 'none']) { r = await run(S(s)); ok(!r.unsure && !r.log.toasts.length && r.log.btns === 1, 'payroll_status 回 ' + s + ' → 解開、按鈕狀態重算', r); }
    for (const [lab, st] of [['逾時', { ok: false, error: 'timeout' }], ['status_read_failed', { ok: false, error: 'status_read_failed' }], ['系統忙碌', { ok: false, error: '系統忙碌，請稍後再試' }], ['回別的月份', { ok: true, ym: '2026-10', status: 'draft' }], ['沒有回應', null]]) {
      r = await run(st); ok(r.unsure && r.log.toasts[0] === 'U', '查不到（' + lab + '）→ 照擋、提示「剛才沒有讀取成功」那一句', r);
    }
    for (const [lab, st] of [['舊後端 unknown_action', { ok: false, error: 'unknown_action' }], ['代轉未放行 FORBIDDEN', { ok: false, error: 'FORBIDDEN' }], ['代轉未放行 沒有權限', { ok: false, error: '沒有權限' }]]) {
      r = await run(st); ok(!r.unsure, lab + ' → 沒辦法查，照舊解開（同改版前）', r);
    }
    r = await run(S('draft'), { seq: 2 });
    ok(r.unsure, '等回應時又開始新的載入（序號變了）→ 不動旗標，交給新的那次', r);
    r = await run(S('mixed'), { ym: '2026-10' });
    ok(r.unsure && !r.log.toasts.length, '畫面已切到別的月份 → 旗標照擋、不跳提示', r);
    console.log(fail ? `\n❌ ${pass} 過、${fail} 失敗` : `\n✅ ${pass} 過、0 失敗`);
    process.exit(fail ? 1 : 0);
  })();
}
