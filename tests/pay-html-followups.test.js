/* 薪資頁後續小修（2026-11-23，fix/payroll-html-followups）——不開瀏覽器的部分；實際按按鈕的版本在 tests/ui/pay-html-followups-e2e.py。
 *   ①表單是哪個店月的：attForeign／ATT_KEY 只在讀取成功時換；loadMonth 讀取失敗不改 ATT_KEY、finally 一律 attGuardUi
 *   ②「儲存工時 ●」：已是未存狀態再編輯也補圓點；按鈕停用中不動字；attBtnIdle 依 ATT_DIRTY
 *   ③待辦 17（5A）：鎖定被擋走 lockBlockedBox；加句只給三種；只有「知道了」能關
 *   ⑤讀取失敗後重新載入成功：先問 payroll_status，mixed／查不到照擋，草稿／已鎖／沒資料／舊後端才解開 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
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
  const iFail = lm.indexOf('if(!r.ok){'), iOk = lm.indexOf("ATT_KEY=STORE+'|'+ym();");
  ok(/function attForeign\(\)\{ return ATT_KEY!==STORE\+'\|'\+ym\(\); \}/.test(H), 'attForeign()＝ATT_KEY 跟畫面上的店月不同');
  ok(iFail > 0 && iOk > iFail && lm.slice(iFail, lm.indexOf('return false;', iFail)).indexOf('ATT_KEY') < 0, 'loadMonth：讀取失敗那段不改 ATT_KEY；讀取成功（換掉 ATT 之後）才設成這個店月');
  ok(/finally \{[^}]*attGuardUi\(\); \}/.test(lm), 'loadMonth：finally 一律 attGuardUi()（失敗時收起表單、成功時打開）');
  ok(/^\s*if\(attForeign\(\)\)\{ toast\(ATT_FOREIGN_MSG,true\); return; \}/m.test(fnSrc('saveAtt').split('\n')[1]), 'saveAtt：第一行就擋 attForeign()');
  ok(/^\s*if\(attForeign\(\)\)\{ toast\(ATT_FOREIGN_MSG,true\); return; \}/m.test(fnSrc('supDecide').split('\n')[1]), 'supDecide：第一行就擋 attForeign()');
  ok(/ATT_KEY=r\.ok\?STORE\+'\|'\+ym\(\):'';/.test(fnSrc('loadAtt')), 'loadAtt：讀失敗 ATT_KEY 空白');
  ok(/#p-att\.att-foreign \.card,#p-att\.att-foreign #supWarn\{display:none\}/.test(H), 'CSS：表單不是這個店月的 → 出勤分頁的卡片與支援提醒收起來');
  // attGuardUi 實跑（假 DOM）
  const els = {};
  const mk = (id) => ({ id, style: {}, className: '', textContent: '', classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } } });
  els['p-att'] = Object.assign(mk('p-att'), { firstChild: null, insertBefore(el) { els[el.id] = el; } });
  const ctx = { STORE: 'S', ym: () => '2026-10', ATT_KEY: 'S|2026-11', ATT_FOREIGN_MSG: '（提示）', $: (id) => els[id] || null, document: { createElement: () => mk('') } };
  vm.createContext(ctx); vm.runInContext(fnSrc('attForeign') + '\n' + fnSrc('attGuardUi'), ctx);
  ctx.attGuardUi();
  ok(els['p-att'].classList.contains('att-foreign') && els.attForeign && els.attForeign.textContent === '（提示）' && els.attForeign.style.display === '', 'attGuardUi：表單是 11 月的、畫面在 10 月 → 收起來＋提示');
  ctx.ATT_KEY = 'S|2026-10'; ctx.attGuardUi();
  ok(!els['p-att'].classList.contains('att-foreign') && els.attForeign.style.display === 'none', 'attGuardUi：讀取成功（ATT_KEY＝10 月）→ 打開、提示收掉');
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
