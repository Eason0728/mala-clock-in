/**
 * payroll.html 嵌在集團管理系統（2026-10-19）：嵌入模式不帶金鑰、只收父頁＋管理系統 origin 的回覆、targetOrigin 寫死。
 * 用 vm 跑 payroll.html 裡那段程式（從字面定位抽出），不另寫一份邏輯。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.log('FAIL: ' + m); } };

const a = html.indexOf('const LOCAL_HOST=');
const b = html.indexOf("if(EMBED) window.parent.postMessage({type:'dzy-payroll-ready'");
ok(a > 0 && b > a, '找得到嵌入模式程式段');
const seg = html.slice(a, html.indexOf('\n', b) + 1);

function load({ hostname, search, framed, referrer }) {
  const sent = [], listeners = [];
  const parent = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
  const win = { addEventListener: (t, f) => { if (t === 'message') listeners.push(f); } };
  win.parent = framed ? parent : win;
  const ctx = {
    location: { hostname, search }, document: { referrer: referrer || '' }, URL, URLSearchParams, setTimeout, clearTimeout, Date,
    window: win, ADMIN_KEY: new URLSearchParams(search).get('k') || ''
  };
  vm.createContext(ctx);
  vm.runInContext(seg + '\n;this.__x={EMBED,DZY_ORIGIN,bridgeCall};', ctx);
  return { x: ctx.__x, sent, listeners, parent };
}

{
  const t = load({ hostname: 'eason0728.github.io', search: '?embed=dzy', framed: true });
  ok(t.x.EMBED === true && t.x.DZY_ORIGIN === 'https://dzy.mozhuting.com', '正式＋被框＋embed=dzy → 嵌入模式、管理系統 origin 寫死');
  ok(t.sent[0] && t.sent[0].msg.type === 'dzy-payroll-ready' && t.sent[0].origin === 'https://dzy.mozhuting.com', '載好送 ready，targetOrigin 寫死');
  const p = t.x.bridgeCall('payroll_month', { store: 'CF' });
  const call = t.sent[1];
  ok(call && call.msg.type === 'dzy-payroll-call' && call.msg.action === 'payroll_month' && call.origin === 'https://dzy.mozhuting.com' && !('admin_key' in call.msg.body), '呼叫送給父頁、不含金鑰');
  const fire = (e) => t.listeners.forEach((f) => f(e));
  fire({ source: t.parent, origin: 'https://evil.example', data: { type: 'dzy-payroll-result', v: 1, id: call.msg.id, result: { ok: true, evil: 1 } } });
  fire({ source: {}, origin: 'https://dzy.mozhuting.com', data: { type: 'dzy-payroll-result', v: 1, id: call.msg.id, result: { ok: true, evil: 2 } } });
  fire({ source: t.parent, origin: 'https://dzy.mozhuting.com', data: { type: 'dzy-payroll-result', v: 1, id: call.msg.id, result: { ok: true, master: [] } } });
  p.then((r) => {
    ok(r && r.ok === true && !('evil' in r) && Array.isArray(r.master), '只收父頁＋管理系統 origin 的回覆（別的 origin、別的視窗一律忽略）');
    done();
  });
}
function done() {
  const k = load({ hostname: 'eason0728.github.io', search: '?k=abc&embed=dzy', framed: true });
  ok(k.x.EMBED === false && k.sent.length === 0, '網址帶 ?k=（舊連結）→ 照舊直連，不進嵌入模式');
  const nf = load({ hostname: 'eason0728.github.io', search: '?embed=dzy', framed: false });
  ok(nf.x.EMBED === false, '沒被框起來 → 不進嵌入模式');
  const dev = load({ hostname: 'localhost', search: '?embed=dzy', framed: true, referrer: 'http://localhost:8777/#/payroll' });
  ok(dev.x.DZY_ORIGIN === 'http://localhost:8777', '本機：管理系統 origin 取自 referrer');
  const dev2 = load({ hostname: 'localhost', search: '?embed=dzy', framed: true, referrer: 'https://evil.example/' });
  ok(dev2.x.DZY_ORIGIN === 'http://localhost:8777', '本機：referrer 不是本機就用預設，不信外站');
  ok(/if\(!EMBED&&!ADMIN_KEY&&!LOCAL_HOST\)/.test(html), '沒金鑰又沒嵌入（正式）→ 顯示「已搬進管理系統」說明');
  console.log((fail ? 'FAIL ' : '全部通過 ') + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
}
