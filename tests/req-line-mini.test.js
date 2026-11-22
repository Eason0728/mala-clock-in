/* 申請送出／取消先走 Mac mini（2026-11-21）：req-line.js 的 sendReq。
 * 載入真的 req-line.js（檔尾多掛測試用出口），用假的 E.post／假時鐘測：
 *  (a) 開關關：只打 Google、body 逐字相同（同一個物件、沒有 req_id）、不打 mini
 *  (b) 開關開＋mini 回 src:'mini'：不打 Google，直接用 mini 的 data（含 data.ok===false 的規則拒絕）
 *  (c) 開關開＋mini 3 秒沒回：3 秒多一點改送 Google，body.req_id 跟送 mini 的同一個，沒有 shadow_note
 *  (d) mini 回 mini_off＋shadow：改送 Google，Google 回來後送 shadow_note，g 只有 ok／error／message
 *  (e) mini 回 HTTP 錯誤／非 JSON／其他 ok:false：改送 Google，不送 shadow_note
 *  另：req_id 格式、取消也一樣、本機網址參數 ?submit_mini=1 只在 localhost 有效、E.MINI_REQ_API 空就不開、呼叫點接對。
 * 2026-11-23：假 mini 的回應改成營運系統真的形狀（外層 { ok:true, data:<line-req 的回傳> }，見下方 WRAP 的出處），
 *   原本的假 mini 少包這一層，測不出「mini 收下了、手機還再送 Google」的毛病；另補 mini_busy／資料還在更新／off／outer ok:false 等各種回應。
 * 跑法：node tests/req-line-mini.test.js（不用瀏覽器）。 */
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'req-line.js'), 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const MINI = 'https://mini.test/store/api/line-req', GURL = 'https://g.test/exec';
let n = 0;
const J = (x) => JSON.parse(JSON.stringify(x));

/** 建一個載入 req-line.js 的沙盒。opts: {flag, host, search, mini, post(url, body, ms)→Promise}。fake timers 用真的 setTimeout（測試只等 3 秒）。 */
function load(opts) {
  const code = opts.flag === undefined ? src : src.replace('var SUBMIT_MINI = false;', 'var SUBMIT_MINI = ' + opts.flag + ';');
  assert(code !== src || opts.flag === undefined, '找不到 var SUBMIT_MINI = false;');
  const calls = [], beacons = [];
  const E = { MINI_REQ_API: opts.mini === undefined ? MINI : opts.mini,
    post: function (url, body, ms) { calls.push({ url, body, ms, narg: arguments.length }); return opts.post(url, body, ms, calls.length); } };
  const sb = { window: {}, document: {}, console, Promise, setTimeout, clearTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
    URLSearchParams, Blob: function (parts) { this.text = parts.join(''); },
    navigator: { sendBeacon: function (u, b) { beacons.push({ url: u, body: JSON.parse(b.text) }); return true; } },
    fetch: function () { return Promise.resolve(); },
    location: { hostname: opts.host || 'example.github.io', search: opts.search || '' } };
  vm.createContext(sb);
  vm.runInContext(code.replace(TAIL, TAIL + ' window.__t = { sendReq: sendReq, setE: function (e) { E = e; }, submitMiniOn: submitMiniOn };'), sb, { filename: 'req-line.js' });
  sb.window.__t.setE(E);
  return { T: sb.window.__t, calls, beacons, E };
}
const miniCalls = (c) => c.calls.filter((x) => x.url === MINI);
const gCalls = (c) => c.calls.filter((x) => x.url === GURL);
const G_OK = { ok: true, summary: 'G 回的', request: { id: 'R1' } };
/* 營運系統真實回應形狀（mala-store-ops origin/main 5aca8ca，正式機 ~/dzy-store 9813353 同；2026-11-23 讀）：
 *  路由 POST /line-req → lineReq.handle(body)（server/index.js:292）；成功一律包 { ok:true, data }（server/index.js:411）；
 *  handle 回傳＝lineSubmit（server/proxy/duty.js:2392–2458）：
 *    收下 { ok:true, src:'mini', data:<Google 形狀> }（:2458）、規則不准 { ok:true, src:'mini', data:{ok:false,…} }（:2424）、
 *    取消那張單還在寫回 { ok:true, src:'mini', data:{ ok:false, error:'mini_syncing', message } }（:2421、:2453）、
 *    同單號重送 { ok:true, src:'mini', data:{ ok:true, dup:true } }（:2418）、
 *    店不是 mini 模式 { ok:false, error:'mini_off' }（:2393、:2410、:2416）、影子 { ok:false, error:'mini_off', shadow:true }（:2414）、
 *    引擎不在／資料太舊 { ok:false, error:'mini_busy' }（proxy/duty.js:2422、server/line-req.js:237）、
 *    server/line-req.js:229、:234：LINE 申請功能關掉 { ok:false, error:'off' }、店網址認不得 { ok:false, error:'unknown_store' }。
 *  伺服器自己的錯誤（ApiError／例外）不經 data：{ ok:false, error, message }（server/index.js:414–415，HTTP 4xx／5xx 但內容是 JSON）。 */
const WRAP = (inner) => ({ ok: true, data: inner });
const M_TAKEN = (data) => WRAP({ ok: true, src: 'mini', data });
const M_OFF = WRAP({ ok: false, error: 'mini_off' });
const M_OFF_SHADOW = WRAP({ ok: false, error: 'mini_off', shadow: true });
const M_BUSY = WRAP({ ok: false, error: 'mini_busy' });
const M_SYNCING = WRAP({ ok: true, src: 'mini', data: { ok: false, error: 'mini_syncing', message: '資料還在更新，請稍後再試一次' } });
const mkBody = () => ({ action: 'req_submit', id_token: 'TOK', kind: 'leave', date: '2026-11-25', hours: 8 });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };

(async () => {
  await ok('預設開關是 false（上線檔案）；沒設 ?submit_mini 也不開', () => {
    assert(/var SUBMIT_MINI = false;/.test(src));
    assert.strictEqual(load({ post: () => Promise.resolve(G_OK) }).T.submitMiniOn(), false);
  });

  await ok('(a) 開關關：送出只打 Google、body 是原物件（沒有 req_id）、不打 mini、不給逾時參數', async () => {
    const c = load({ post: () => Promise.resolve(G_OK) }), body = mkBody(), before = JSON.stringify(body);
    const r = await c.T.sendReq('submit', GURL, body);
    assert.strictEqual(c.calls.length, 1); assert.strictEqual(c.calls[0].url, GURL);
    assert.strictEqual(c.calls[0].body, body, '同一個物件');
    assert.strictEqual(c.calls[0].narg, 2, '跟以前一樣 E.post(url, body) 兩個參數');
    assert.strictEqual(JSON.stringify(body), before); assert.strictEqual('req_id' in body, false);
    assert.strictEqual(r, G_OK); assert.strictEqual(c.beacons.length, 0);
  });
  await ok('(a) 開關關：取消一樣只打 Google；Google 失敗照舊丟出去', async () => {
    const c = load({ post: () => Promise.reject(new Error('boom')) });
    await assert.rejects(() => c.T.sendReq('cancel', GURL, { action: 'req_cancel', id_token: 'TOK', id: 'R1' }), /boom/);
    assert.strictEqual(c.calls.length, 1); assert.strictEqual('req_id' in c.calls[0].body, false);
  });
  await ok('開關關：就算網址帶 ?submit_mini=1，非 localhost 也不開；localhost 才開', () => {
    const p = () => Promise.resolve(G_OK);
    assert.strictEqual(load({ host: 'example.github.io', search: '?submit_mini=1', post: p }).T.submitMiniOn(), false);
    assert.strictEqual(load({ host: 'localhost', search: '?submit_mini=1', post: p }).T.submitMiniOn(), true);
    assert.strictEqual(load({ host: '127.0.0.1', search: '?submit_mini=1', post: p }).T.submitMiniOn(), true);
    assert.strictEqual(load({ host: 'localhost', search: '?submit_mini=0', post: p }).T.submitMiniOn(), false);
    assert.strictEqual(load({ host: 'localhost', search: '', post: p }).T.submitMiniOn(), false);
  });
  await ok('開關開但 E.MINI_REQ_API 空 → 不開，照舊只打 Google', async () => {
    const c = load({ flag: true, mini: '', post: () => Promise.resolve(G_OK) });
    assert.strictEqual(c.T.submitMiniOn(), false);
    await c.T.sendReq('submit', GURL, mkBody());
    assert.strictEqual(c.calls.length, 1); assert.strictEqual(c.calls[0].url, GURL);
  });

  await ok('(b) 開關開＋mini 回 src:mini：不打 Google；mini 收到的內容符合契約（沒 action／id_token）', async () => {
    const d = { ok: true, summary: 'mini 回的', request: { id: 'R9' } };
    const c = load({ flag: true, post: () => Promise.resolve(M_TAKEN(d)) });
    const r = await c.T.sendReq('submit', GURL, mkBody());
    assert.deepStrictEqual(J(r), d); assert.strictEqual(gCalls(c).length, 0); assert.strictEqual(c.calls.length, 1);
    const m = c.calls[0];
    assert.strictEqual(m.ms, 3000);
    assert.deepStrictEqual(Object.keys(m.body).sort(), ['body', 'id_token', 'op', 'req_id', 'url']);
    assert.strictEqual(m.body.op, 'submit'); assert.strictEqual(m.body.url, GURL); assert.strictEqual(m.body.id_token, 'TOK');
    assert.deepStrictEqual(J(m.body.body), { kind: 'leave', date: '2026-11-25', hours: 8 });
    assert(/^r[0-9a-f]{16}$/.test(m.body.req_id), 'req_id 格式（g-line.md 4.1：r＋16 碼十六進位） ' + m.body.req_id);
    assert.strictEqual(c.beacons.length, 0);
  });
  await ok('(b) mini 回 data.ok===false（規則拒絕）：照樣當 Google 回應用，不再送 Google', async () => {
    const d = { ok: false, error: 'over_limit', message: '超過上限' };
    const c = load({ flag: true, post: () => Promise.resolve(M_TAKEN(d)) });
    assert.deepStrictEqual(J(await c.T.sendReq('submit', GURL, mkBody())), d);
    assert.strictEqual(gCalls(c).length, 0); assert.strictEqual(c.beacons.length, 0);
  });
  await ok('(b) 取消：op 是 cancel、body＝{id}', async () => {
    const c = load({ flag: true, post: () => Promise.resolve(M_TAKEN({ ok: true })) });
    await c.T.sendReq('cancel', GURL, { action: 'req_cancel', id_token: 'TOK', id: 'R1' });
    assert.strictEqual(c.calls[0].body.op, 'cancel'); assert.deepStrictEqual(J(c.calls[0].body.body), { id: 'R1' });
  });
  await ok('取消改送 Google 時不帶 req_id（g-line.md 只定義 req_submit 的單號）', async () => {
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve(M_OFF) : Promise.resolve(G_OK) });
    await c.T.sendReq('cancel', GURL, { action: 'req_cancel', id_token: 'TOK', id: 'R1' });
    assert.strictEqual(gCalls(c).length, 1); assert.strictEqual(gCalls(c)[0].body.req_id, undefined);
  });

  await ok('(c) 開關開＋mini 3 秒沒回：3 秒多一點改送 Google，req_id 同一個，沒有 shadow_note', async () => {
    const c = load({ flag: true, post: (url) => url === MINI ? new Promise(() => {}) : Promise.resolve(G_OK) });
    const t0 = Date.now(), r = await c.T.sendReq('submit', GURL, mkBody()), dt = Date.now() - t0;
    assert(dt >= 2950 && dt < 3600, '耗時 ' + dt);
    assert.strictEqual(r, G_OK); assert.strictEqual(c.calls.length, 2);
    const g = gCalls(c)[0].body;
    assert.strictEqual(g.req_id, miniCalls(c)[0].body.req_id);
    assert.deepStrictEqual(J(g), Object.assign(mkBody(), { req_id: g.req_id }), 'Google body＝原 body＋req_id，其餘不變');
    await tick(20); assert.strictEqual(c.beacons.length, 0);
  });

  await ok('(d) mini 回 mini_off＋shadow：改送 Google，回來後送 shadow_note，g 只有 ok／error／message', async () => {
    const gRes = { ok: false, error: 'over_limit', message: '超過上限', summary: 'x', request: { id: 'zz' } };
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve(M_OFF_SHADOW) : Promise.resolve(gRes) });
    const r = await c.T.sendReq('submit', GURL, mkBody());
    assert.strictEqual(r, gRes);
    assert.strictEqual(gCalls(c)[0].body.req_id, miniCalls(c)[0].body.req_id);
    assert.strictEqual(c.beacons.length, 1);
    const s = c.beacons[0].body;
    assert.strictEqual(c.beacons[0].url, MINI);
    assert.deepStrictEqual(Object.keys(s).sort(), ['g', 'id_token', 'op', 'req_id', 'url']);
    assert.strictEqual(s.op, 'shadow_note'); assert.strictEqual(s.url, GURL); assert.strictEqual(s.id_token, 'TOK'); assert.strictEqual(s.req_id, gCalls(c)[0].body.req_id);
    assert.deepStrictEqual(Object.keys(s.g).sort(), ['error', 'message', 'ok']);
    assert.deepStrictEqual(J(s.g), { ok: false, error: 'over_limit', message: '超過上限' });
  });
  await ok('(d) shadow_note 在 Google 回來之後才送；Google 成功 g.ok＝true', async () => {
    let release, order = [];
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve(M_OFF_SHADOW)
      : new Promise((res) => { release = () => res(G_OK); }) });
    const p = c.T.sendReq('submit', GURL, mkBody()).then((r) => { order.push('done'); return r; });
    await tick(30); assert.strictEqual(c.beacons.length, 0, 'Google 還沒回，不送');
    release(); await p;
    assert.strictEqual(c.beacons.length, 1); assert.strictEqual(c.beacons[0].body.g.ok, true);
  });

  await ok('(e) mini HTTP 錯誤／非 JSON／其他 ok:false → 改送 Google，不送 shadow_note', async () => {
    const cases = [
      () => Promise.reject(new Error('HTTP 502')),
      () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      () => Promise.resolve({ ok: false, error: 'bad_request' }),
      () => Promise.resolve(M_OFF),                                       // 沒帶 shadow:true 不算影子
      () => Promise.resolve(WRAP({ ok: true, src: 'mini' })),            // 裡面沒 data
      () => Promise.resolve(null),
    ];
    for (const mk of cases) {
      const c = load({ flag: true, post: (url) => url === MINI ? mk() : Promise.resolve(G_OK) });
      assert.strictEqual(await c.T.sendReq('submit', GURL, mkBody()), G_OK);
      assert.strictEqual(gCalls(c).length, 1); assert.strictEqual(gCalls(c)[0].body.req_id, miniCalls(c)[0].body.req_id);
      await tick(10); assert.strictEqual(c.beacons.length, 0);
    }
  });
  await ok('(e) mini 失敗、Google 也失敗 → 照舊丟錯給呼叫端（顯示「連線失敗」）', async () => {
    const c = load({ flag: true, post: (url) => Promise.reject(new Error(url === MINI ? 'mini' : 'google')) });
    await assert.rejects(() => c.T.sendReq('submit', GURL, mkBody()), /google/);
  });

  await ok('每次呼叫的 req_id 都不一樣', async () => {
    const c = load({ flag: true, post: () => Promise.resolve(M_TAKEN({ ok: true })) });
    await c.T.sendReq('submit', GURL, mkBody()); await c.T.sendReq('submit', GURL, mkBody());
    assert.notStrictEqual(c.calls[0].body.req_id, c.calls[1].body.req_id);
  });
  await ok('呼叫點：送出與取消都走 sendReq，body 內容沒改', () => {
    assert(/return sendReq\('submit', E\.storeApi\(storeDef\(\)\), body\);/.test(src));
    assert(/sendReq\('cancel', E\.storeApi\(storeDef\(\)\), \{ action: 'req_cancel', id_token: liff\.getIDToken\(\), id: r\.id \}\)/.test(src));
    assert(/body\.action = 'req_submit'; body\.id_token = liff\.getIDToken\(\);/.test(src));
    assert.strictEqual((src.match(/E\.post\(E\.storeApi\(storeDef\(\)\), body\)/g) || []).length, 0);
  });

  /* ───────── 2026-11-23 補：營運系統真實回應形狀（外層 { ok, data }）下，每一種回應該不該改送 Google ───────── */
  const sendBoth = async (flagOpts, op, miniReply) => {
    const c = load(Object.assign({ flag: true, post: (url) => url === MINI ? miniReply() : Promise.resolve(G_OK) }, flagOpts || {}));
    const body = op === 'cancel' ? { action: 'req_cancel', id_token: 'TOK', id: 'R1' } : mkBody();
    const t0 = Date.now(), r = await c.T.sendReq(op, GURL, body);
    await tick(10);
    return { c, r, dt: Date.now() - t0, body };
  };
  await ok('真形狀：mini 收下 { ok:true, data:{ ok:true, src:mini, data } } → 用 mini 的 data、Google 0 次（送出、取消都是）', async () => {
    for (const op of ['submit', 'cancel']) {
      const d = { ok: true, summary: 'mini 回的', request: { id: 'R9' } };
      const { c, r } = await sendBoth(null, op, () => Promise.resolve(M_TAKEN(d)));
      assert.deepStrictEqual(J(r), d, op); assert.strictEqual(gCalls(c).length, 0, op + ' Google 次數'); assert.strictEqual(miniCalls(c).length, 1); assert.strictEqual(c.beacons.length, 0);
    }
  });
  await ok('真形狀：mini 規則不准 { ok:true, data:{ ok:true, src:mini, data:{ ok:false, … } } } → 把拒絕原因給畫面、Google 0 次', async () => {
    const d = { ok: false, error: 'over_limit', message: '超過上限' };
    const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve(M_TAKEN(d)));
    assert.deepStrictEqual(J(r), d); assert.strictEqual(gCalls(c).length, 0);
  });
  await ok('真形狀：mini 說資料還在更新（mini_syncing，在 src:mini 底下）→ 畫面拿到那句話、Google 0 次（不能改送 Google，會搶在主管那筆前面）', async () => {
    const { c, r } = await sendBoth(null, 'cancel', () => Promise.resolve(M_SYNCING));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'mini_syncing'); assert.strictEqual(r.message, '資料還在更新，請稍後再試一次');
    assert.strictEqual(gCalls(c).length, 0); assert.strictEqual(c.beacons.length, 0);
  });
  await ok('真形狀：同單號重送 { ok:true, dup:true } → 照樣當 mini 收下、Google 0 次', async () => {
    const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve(M_TAKEN({ ok: true, dup: true })));
    assert.deepStrictEqual(J(r), { ok: true, dup: true }); assert.strictEqual(gCalls(c).length, 0);
  });
  await ok('真形狀：mini_off（該店不是 mini 模式）→ 改送 Google 1 次、同一個 req_id、不送 shadow_note（送出）；取消不帶 req_id', async () => {
    const a = await sendBoth(null, 'submit', () => Promise.resolve(M_OFF));
    assert.strictEqual(a.r, G_OK); assert.strictEqual(gCalls(a.c).length, 1); assert.strictEqual(gCalls(a.c)[0].body.req_id, miniCalls(a.c)[0].body.req_id); assert.strictEqual(a.c.beacons.length, 0);
    const b = await sendBoth(null, 'cancel', () => Promise.resolve(M_OFF));
    assert.strictEqual(b.r, G_OK); assert.strictEqual(gCalls(b.c).length, 1); assert.strictEqual(gCalls(b.c)[0].body.req_id, undefined); assert.strictEqual(b.c.beacons.length, 0);
  });
  await ok('真形狀：mini_off＋shadow:true（影子店）→ 改送 Google 1 次、之後送 shadow_note 1 筆（只在這一種）', async () => {
    for (const op of ['submit', 'cancel']) {
      const { c } = await sendBoth(null, op, () => Promise.resolve(M_OFF_SHADOW));
      assert.strictEqual(gCalls(c).length, 1, op); assert.strictEqual(c.beacons.length, 1, op);
      assert.strictEqual(c.beacons[0].body.op, 'shadow_note'); assert.deepStrictEqual(J(c.beacons[0].body.g), { ok: true, error: '', message: '' });
    }
  });
  await ok('真形狀：mini_busy（引擎不在／資料太舊）→ 改送 Google 1 次、不送 shadow_note、立刻（不等 3 秒）', async () => {
    for (const op of ['submit', 'cancel']) {
      const { c, r, dt } = await sendBoth(null, op, () => Promise.resolve(M_BUSY));
      assert.strictEqual(r, G_OK); assert.strictEqual(gCalls(c).length, 1, op); assert.strictEqual(c.beacons.length, 0); assert(dt < 500, '耗時 ' + dt);
    }
  });
  await ok('真形狀：LINE 申請功能關掉（off）、店網址認不得（unknown_store）、bad_input → 改送 Google 1 次', async () => {
    for (const e of ['off', 'unknown_store', 'bad_input']) {
      const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve(WRAP({ ok: false, error: e })));
      assert.strictEqual(r, G_OK, e); assert.strictEqual(gCalls(c).length, 1, e); assert.strictEqual(c.beacons.length, 0, e);
    }
  });
  await ok('真形狀：外層 ok:false（伺服器錯誤 500／ApiError，內容是 JSON）→ 改送 Google 1 次', async () => {
    for (const rep of [{ ok: false, error: 'SERVER_ERROR', message: '系統發生錯誤，請稍後再試' }, { ok: false, error: 'CONFLICT', message: 'x', reason: 'duty_syncing', retry_ms: 2000 }]) {
      const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve(rep));
      assert.strictEqual(r, G_OK); assert.strictEqual(gCalls(c).length, 1); assert.strictEqual(c.beacons.length, 0);
    }
  });
  await ok('真形狀：外層 ok:true 但 data 不是物件／缺 → 改送 Google 1 次', async () => {
    for (const rep of [{ ok: true }, { ok: true, data: null }, { ok: true, data: 'x' }, { ok: true, data: [] }, WRAP({ ok: true, src: 'mini', data: 'x' }), WRAP({ ok: true, src: 'other', data: { ok: true } })]) {
      const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve(rep));
      assert.strictEqual(r, G_OK, JSON.stringify(rep)); assert.strictEqual(gCalls(c).length, 1, JSON.stringify(rep));
    }
  });
  await ok('沒包外層的舊形狀（只有測試假 mini 才會回）不再被當成收下：改送 Google', async () => {
    const { c, r } = await sendBoth(null, 'submit', () => Promise.resolve({ ok: true, src: 'mini', data: { ok: true, summary: '舊形狀' } }));
    assert.strictEqual(r, G_OK); assert.strictEqual(gCalls(c).length, 1);
  });
  await ok('真形狀：網路錯誤（fetch 丟錯）／回應不是 JSON（JSON.parse 丟錯）→ 改送 Google 1 次，同一個 req_id、不送 shadow_note', async () => {
    for (const mk of [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')), () => Promise.reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))]) {
      const { c, r } = await sendBoth(null, 'submit', mk);
      assert.strictEqual(r, G_OK); assert.strictEqual(gCalls(c).length, 1); assert.strictEqual(gCalls(c)[0].body.req_id, miniCalls(c)[0].body.req_id); assert.strictEqual(c.beacons.length, 0);
    }
  });
  await ok('真形狀：3 秒沒回 → 約 3 秒後改送 Google 1 次；mini 晚到的收下回應不會再影響結果（Google 仍只 1 次）', async () => {
    let lateRes; const late = new Promise((res) => { lateRes = res; });
    const { c, r, dt } = await sendBoth(null, 'submit', () => late);
    assert(dt >= 2950 && dt < 3600, '耗時 ' + dt); assert.strictEqual(r, G_OK); assert.strictEqual(gCalls(c).length, 1);
    lateRes(M_TAKEN({ ok: true, summary: '晚到' })); await tick(30);
    assert.strictEqual(gCalls(c).length, 1, '晚到的回應不再觸發任何請求'); assert.strictEqual(c.beacons.length, 0);
  });
  await ok('真形狀：Google 也失敗 → 照舊丟錯；收下時 Google 就算壞也不影響（不會被打）', async () => {
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve(M_TAKEN({ ok: true, summary: 'ok' })) : Promise.reject(new Error('google')) });
    assert.strictEqual((await c.T.sendReq('submit', GURL, mkBody())).summary, 'ok'); assert.strictEqual(gCalls(c).length, 0);
  });

  await ok('開關關（預設）＋網址沒帶參數：送出／取消各只發一個 E.post(url, body)——同網址、同一個 body 物件、兩個參數、不碰 mini、沒有 beacon／fetch；連送兩次順序不變', async () => {
    for (const reply of [() => Promise.resolve(G_OK), () => Promise.resolve(M_TAKEN({ ok: true, summary: '不該用到' })), () => Promise.reject(new Error('boom'))]) {
      const c = load({ post: (url) => url === GURL ? reply() : Promise.resolve(G_OK) });
      const b1 = mkBody(), b2 = { action: 'req_cancel', id_token: 'TOK', id: 'R1' }, snap1 = JSON.stringify(b1), snap2 = JSON.stringify(b2);
      await Promise.resolve(c.T.sendReq('submit', GURL, b1)).catch(() => {});
      await Promise.resolve(c.T.sendReq('cancel', GURL, b2)).catch(() => {});
      await tick(10);
      assert.strictEqual(c.calls.length, 2);
      assert.deepStrictEqual(c.calls.map((x) => [x.url, x.narg]), [[GURL, 2], [GURL, 2]]);
      assert.strictEqual(c.calls[0].body, b1); assert.strictEqual(c.calls[1].body, b2);
      assert.strictEqual(JSON.stringify(b1), snap1); assert.strictEqual(JSON.stringify(b2), snap2);
      assert.strictEqual(c.beacons.length, 0);
    }
  });
  await ok('開關關：程式裡「關著就第一行直接 E.post」那一行沒變、SUBMIT_MINI 預設 false', () => {
    assert(/function sendReq\(op, url, body\) \{\n    if \(!submitMiniOn\(\)\) return E\.post\(url, body\);\n/.test(src));
    assert(/\n  var SUBMIT_MINI = false;\n/.test(src));
  });

  console.log('\n通過 ' + n + ' 條，失敗 0');
})().catch((e) => { console.error(e); process.exit(1); });
