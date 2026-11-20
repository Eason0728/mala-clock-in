/* 申請送出／取消先走 Mac mini（2026-11-21）：req-line.js 的 sendReq。
 * 載入真的 req-line.js（檔尾多掛測試用出口），用假的 E.post／假時鐘測：
 *  (a) 開關關：只打 Google、body 逐字相同（同一個物件、沒有 req_id）、不打 mini
 *  (b) 開關開＋mini 回 src:'mini'：不打 Google，直接用 mini 的 data（含 data.ok===false 的規則拒絕）
 *  (c) 開關開＋mini 3 秒沒回：3 秒多一點改送 Google，body.req_id 跟送 mini 的同一個，沒有 shadow_note
 *  (d) mini 回 mini_off＋shadow：改送 Google，Google 回來後送 shadow_note，g 只有 ok／error／message
 *  (e) mini 回 HTTP 錯誤／非 JSON／其他 ok:false：改送 Google，不送 shadow_note
 *  另：req_id 格式、取消也一樣、本機網址參數 ?submit_mini=1 只在 localhost 有效、E.MINI_REQ_API 空就不開、呼叫點接對。
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
    const c = load({ flag: true, post: () => Promise.resolve({ ok: true, src: 'mini', data: d }) });
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
    const c = load({ flag: true, post: () => Promise.resolve({ ok: true, src: 'mini', data: d }) });
    assert.deepStrictEqual(J(await c.T.sendReq('submit', GURL, mkBody())), d);
    assert.strictEqual(gCalls(c).length, 0); assert.strictEqual(c.beacons.length, 0);
  });
  await ok('(b) 取消：op 是 cancel、body＝{id}', async () => {
    const c = load({ flag: true, post: () => Promise.resolve({ ok: true, src: 'mini', data: { ok: true } }) });
    await c.T.sendReq('cancel', GURL, { action: 'req_cancel', id_token: 'TOK', id: 'R1' });
    assert.strictEqual(c.calls[0].body.op, 'cancel'); assert.deepStrictEqual(J(c.calls[0].body.body), { id: 'R1' });
  });
  await ok('取消改送 Google 時不帶 req_id（g-line.md 只定義 req_submit 的單號）', async () => {
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve({ ok: false, error: 'mini_off' }) : Promise.resolve(G_OK) });
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
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve({ ok: false, error: 'mini_off', shadow: true }) : Promise.resolve(gRes) });
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
    const c = load({ flag: true, post: (url) => url === MINI ? Promise.resolve({ ok: false, error: 'mini_off', shadow: true })
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
      () => Promise.resolve({ ok: false, error: 'mini_off' }),            // 沒帶 shadow:true 不算影子
      () => Promise.resolve({ ok: true, src: 'mini' }),                   // 沒 data
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
    const c = load({ flag: true, post: () => Promise.resolve({ ok: true, src: 'mini', data: { ok: true } }) });
    await c.T.sendReq('submit', GURL, mkBody()); await c.T.sendReq('submit', GURL, mkBody());
    assert.notStrictEqual(c.calls[0].body.req_id, c.calls[1].body.req_id);
  });
  await ok('呼叫點：送出與取消都走 sendReq，body 內容沒改', () => {
    assert(/return sendReq\('submit', E\.storeApi\(storeDef\(\)\), body\);/.test(src));
    assert(/sendReq\('cancel', E\.storeApi\(storeDef\(\)\), \{ action: 'req_cancel', id_token: liff\.getIDToken\(\), id: r\.id \}\)/.test(src));
    assert(/body\.action = 'req_submit'; body\.id_token = liff\.getIDToken\(\);/.test(src));
    assert.strictEqual((src.match(/E\.post\(E\.storeApi\(storeDef\(\)\), body\)/g) || []).length, 0);
  });

  console.log('\n通過 ' + n + ' 條，失敗 0');
})().catch((e) => { console.error(e); process.exit(1); });
