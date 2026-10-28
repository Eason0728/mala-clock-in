/**
 * payroll.html 依「負責門市範圍（SCOPE）」調整畫面（2026-10-29）。
 * 從 payroll.html 抽函式用 vm 實跑，不另寫一份邏輯。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.log('FAIL: ' + m); } };

function fn(name) {   // 抽出 function name(...) {...}（含 async）
  const re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(html); if (!m) return '';
  let i = html.indexOf('{', m.index), d = 0, j = i;
  for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (!d) break; } }
  return html.slice(m.index, j + 1);
}
const names = ['scopeLimited', 'pickScopedStore', 'applyScopeUi', 'boot'];
const src = names.map(fn);
ok(src.every(Boolean), '找得到 scopeLimited／pickScopedStore／applyScopeUi／boot');
const ownIds = (/const SCOPE_OWN_IDS=(\[[^\]]*\])/.exec(html) || [])[1] || '[]';

function mkEl() { return { style: {}, checked: false, disabled: false, innerHTML: '', textContent: '' }; }
function load({ EMBED, SCOPE, master, perCall }) {
  const els = {}, calls = [];
  const $ = id => els[id] || (els[id] = mkEl());
  ['cfgOwn', 'attOwn', 'ptOwn', 'coOwn', 'ltOwn', 'storeCard', 'holSync', 'nav'].forEach($);
  const mainEl = mkEl(), groupBtn = mkEl();
  const ctx = {
    $, calls, els, mainEl, groupBtn, toasts: [], syncHolN: 0,
    document: { querySelector: q => q === 'main' ? mainEl : (q.includes('data-p="group"') ? groupBtn : null) },
    localStorage: { setItem() {}, getItem() { return ''; } },
    ym: () => '2026-10', ADMIN_KEY: '', LOCAL_HOST: false, CFG_DIRTY: {},
  };
  ctx.toast = (t) => ctx.toasts.push(t);
  ctx.post = async (action, body, opt) => {
    calls.push({ action, store: ctx.STORE, body });
    if (perCall && perCall[action]) { const r = perCall[action](ctx.STORE); if (r) return r; }
    if (action === 'payroll_master_get') return master;
    return { ok: true };
  };
  ['applyHol', 'renderEmp', 'renderCfg', 'renderStoreSel', 'loadMonth'].forEach(n => ctx[n] = () => {});
  ctx.syncHol = () => { ctx.syncHolN++; };
  vm.createContext(ctx);
  vm.runInContext(`let EMBED=${EMBED}; let SCOPE=${JSON.stringify(SCOPE)}; let STORE='SSLGF'; let STORE_LIST=[]; let MASTER, CFG, DASH_PREFETCH;
    const SCOPE_OWN_IDS=${ownIds};\n` + src.join('\n') +
    `\nthis.set=(k,v)=>{ if(k==='SCOPE')SCOPE=v; if(k==='EMBED')EMBED=v; if(k==='STORE')STORE=v; };
     this.get=()=>({SCOPE,STORE});
     Object.defineProperty(this,'STORE',{get:()=>STORE});
     this.api={scopeLimited,pickScopedStore,applyScopeUi,boot};`, ctx);
  return ctx;
}

(async () => {
  // staleStore
  const a = load({ EMBED: true, SCOPE: '*' }).api;
  ok(a.pickScopedStore([{ code: 'CF' }, { code: 'MZTJS' }], 'SSLGF') === 'CF', 'staleStore：不在清單 → 清單第一家');
  ok(a.pickScopedStore([{ code: 'CF' }], 'CF') === 'CF', 'staleStore：在清單內 → 維持');
  ok(a.pickScopedStore([], 'CF') === '', 'staleStore：空清單 → 空字串');

  // limitedFlag
  let t = load({ EMBED: true, SCOPE: ['CF'] });
  ok(t.api.scopeLimited() === true, 'limitedFlag：EMBED＋陣列 → true');
  t.set('SCOPE', '*'); ok(t.api.scopeLimited() === false, 'limitedFlag：SCOPE=* → false');
  t = load({ EMBED: false, SCOPE: ['CF'] });
  ok(t.api.scopeLimited() === false, 'limitedFlag：非嵌入 → false');

  // ownLocked ＋ 藏集團功能
  t = load({ EMBED: true, SCOPE: ['CF'] }); t.api.applyScopeUi();
  ok(['cfgOwn', 'attOwn', 'ptOwn', 'coOwn', 'ltOwn'].every(id => t.els[id].checked === true && t.els[id].disabled === true), 'ownLocked：五個勾選框勾選＋鎖住');
  ok(t.groupBtn.style.display === 'none' && t.els.storeCard.style.display === 'none' && t.els.holSync.style.display === 'none', '藏集團總覽鈕、門市設定區、紅字同步區');
  t = load({ EMBED: true, SCOPE: '*' }); t.api.applyScopeUi();
  ok(!t.els.cfgOwn.disabled && !t.groupBtn.style.display && !t.els.storeCard.style.display, "SCOPE='*'：畫面不動");

  // emptyMsg
  t = load({ EMBED: true, SCOPE: [] }); t.api.applyScopeUi();
  ok(t.mainEl.innerHTML.includes('尚未指派負責門市，請洽系統管理者'), 'emptyMsg：空名單顯示說明');

  // noHolSync（字串＋實跑）
  ok(/if\s*\(!scopeLimited\(\)\)\s*syncHol\(/.test(fn('boot')), 'noHolSync：boot 內有 if(!scopeLimited()) syncHol(');
  t = load({ EMBED: true, SCOPE: '*', master: { ok: true, scope: ['CF'], stores: [{ code: 'CF' }], master: [], config: {} } });
  await t.api.boot();
  ok(t.syncHolN === 0 && !t.calls.some(c => c.action === 'payroll_holiday_sync'), 'noHolSync：有範圍限制時 boot 不呼叫 syncHol');
  t = load({ EMBED: true, SCOPE: '*', master: { ok: true, scope: '*', stores: [{ code: 'SSLGF' }], master: [], config: {} } });
  await t.api.boot();
  ok(t.syncHolN === 1, "SCOPE='*'：boot 照舊呼叫 syncHol");
  t = load({ EMBED: false, SCOPE: '*', master: { ok: true, stores: [{ code: 'SSLGF' }], master: [], config: {} } });
  t.ADMIN_KEY = 'x'; vm.runInContext("1", t);
  await t.api.boot();
  ok(t.syncHolN === 1 && t.get().SCOPE === '*', '非嵌入：照舊呼叫 syncHol，SCOPE 維持 *');

  // 空名單：boot 停止
  t = load({ EMBED: true, SCOPE: '*', master: { ok: true, scope: [], stores: [], master: [], config: {} } });
  await t.api.boot();
  ok(t.calls.map(c => c.action).join() === 'payroll_master_get,payroll_month,payroll_trend' && t.syncHolN === 0 && t.mainEl.innerHTML.includes('尚未指派'), '空名單：只有開頁三支平行呼叫，之後停住並顯示說明');

  // 範圍內但記住的門市在範圍外：改選第一家並重載 month／trend
  t = load({ EMBED: true, SCOPE: '*', master: { ok: true, scope: ['CF', 'MZTJS'], stores: [{ code: 'CF' }, { code: 'MZTJS' }], master: [], config: {} } });
  await t.api.boot();
  const mons = t.calls.filter(c => c.action === 'payroll_month');
  ok(t.get().STORE === 'CF' && mons.length === 2 && mons[0].store === 'SSLGF' && mons[1].store === 'CF', '記住的門市在範圍外：改選 CF 並重載 payroll_month');
  ok(t.calls.filter(c => c.action === 'payroll_trend').length === 2 && t.toasts.length === 0, '同上：trend 也重載，且沒有錯誤提示');

  // master_get 被擋（記住的門市在範圍外）：用 store_get 挑一家再重打
  t = load({ EMBED: true, SCOPE: '*', master: { ok: true, scope: ['CF'], stores: [{ code: 'CF' }], master: [], config: {} },
    perCall: { payroll_master_get: (st) => st === 'SSLGF' ? { ok: false, error: 'scope_forbidden' } : null,
               payroll_store_get: () => ({ ok: true, stores: [{ code: 'CF' }] }) } });
  await t.api.boot();
  ok(t.get().STORE === 'CF' && t.get().SCOPE.join() === 'CF' && t.toasts.length === 0, 'master_get 被擋：改用 store_get 挑 CF 重打，成功且無錯誤提示');

  // post 對 scope_forbidden 的提示
  const postSrc = fn('post');
  ok(/scope_forbidden[\s\S]{0,120}這家門市不在你的負責範圍/.test(postSrc), 'post：scope_forbidden → 「這家門市不在你的負責範圍」');
  ok(/emp_out_of_scope[\s\S]{0,160}不在你負責門市的薪資主檔/.test(postSrc), 'post：emp_out_of_scope → 說明是哪些編號不在負責門市主檔');
  ok(/if\(b\.dataset\.p==='group'&&!scopeLimited\(\)\) loadGroup/.test(html) && /on&&on\.dataset\.p==='group'&&!scopeLimited\(\)/.test(html), '切店與 nav 點擊不觸發 loadGroup（有限制時）');

  // saveAttScoped（final review I2 配套）：有範圍時只送本店主檔的人（工時表含只打卡、未建主檔或別店的編號，後端會 emp_out_of_scope）
  {
    const saveSrc = fn('saveAtt');
    ok(!!saveSrc, '找得到 saveAtt');
    const run = async (embed, scope) => {
      const sent = [];
      const c = { $: () => ({ classList: { add() {}, remove() {} }, style: {} }), toast() {}, ym: () => '2026-10', doCalc: async () => {}, setTimeout() {},
        post: async (a, b) => { sent.push({ a, b }); return { ok: true, count: 0 }; } };
      vm.createContext(c);
      vm.runInContext(`let EMBED=${embed}; let SCOPE=${JSON.stringify(scope)}; let ATT_DIRTY=true;
        let MASTER=[{emp_id:'T002',name:'測試乙'},{emp_id:3,name:'數字編號'}];
        let ATT={T002:{hours:8},'3':{hours:1},PUNCH9:{hours:5},T001:{hours:2}};
        ${fn('scopeLimited')}\n${saveSrc}\nthis.go=saveAtt;`, c);
      await c.go();
      return sent.filter(x => x.a === 'payroll_input_set').map(x => Object.keys(x.b.inputs).sort().join());
    };
    ok((await run(true, ['CF'])).join('|') === '3,T002', 'saveAttScoped：有範圍 → 只送主檔的 T002 與 3');
    ok((await run(true, '*')).join('|') === '3,PUNCH9,T001,T002', "saveAttScoped：SCOPE='*' → 照舊全送");
    ok((await run(false, ['CF'])).join('|') === '3,PUNCH9,T001,T002', 'saveAttScoped：非嵌入 → 照舊全送');
  }

  console.log((fail ? 'FAIL ' : '全部通過 ') + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
