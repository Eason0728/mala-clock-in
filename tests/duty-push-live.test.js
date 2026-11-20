// 門鈴開真推送前補強（2026-11-20，feat/duty-push-live-prep；S3 審查「真推送前必做」②④⑤＋flush）
// 1. 門鈴關、只計數：跟目前九店線上版（a9fac60＝PR #181，main 50a80bc）逐字逐次相同——回傳值、暫存區、每一次服務呼叫；
//    唯一差別是 push_stats 回報的 cap 數字（1500→800）。
// 2. 正式推送、回應快：跟 a9fac60 只差四種呼叫（讀 DUTY_PUSH_TUNE、getAll 多一個鍵、flush、寫慢計數），送出的內容逐字相同。
// 3. 回應慢也熔斷：一次 ≥2.5 秒馬上停 10 分鐘；連 3 次 ≥1.5 秒停 10 分鐘；快又成功才歸零；半開；可用 DUTY_PUSH_TUNE 調。
// 4. flush：只在真的要連外、不是 ping 時；在暫存區寫完之後、連外之前；flush 出錯照樣按門鈴、寫入照常返回。
// 5. 每日上限預設 800、可調（最多 1,500）；九店兩倍仍 ≤ 2 萬的 80%。
// 名字、金鑰一律假的；不連網路。
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const { execFileSync } = require('child_process');
const { harness, resp, T0 } = require('./helpers/duty-push-harness');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script/DutyFeed.gs'), 'utf8');
const LIVE_REF = process.env.DUTY_PUSH_LIVE_REF || '50a80bc';   // 九店線上版＝a9fac60（PR #181 合併點）
let OLD = null;
try { OLD = execFileSync('git', ['show', LIVE_REF + ':apps-script/DutyFeed.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { OLD = null; }
assert.ok(OLD, '讀不到 ' + LIVE_REF + ' 版的 DutyFeed.gs（要在 git repo 裡跑）');
assert.strictEqual(require('crypto').createHash('sha1').update(OLD).digest('hex'), '353800f51e70ef004ee55a240faca7932bdea4f0', 'LIVE_REF 不是九店線上那一版');

let n = 0, nFail = 0;
function ok(name, fn) {
  try { fn(); n++; console.log('✓ ' + name); }
  catch (e) { nFail++; console.log('✗ ' + name + '\n    ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n    ')); }
}

const KEY = '0123456789abcdef0123456789abcdef';
const URL_ = 'https://gw.example.test/store/svc/duty-push';
const FIXED = 'https://dzy-gw.dingzhaoyuan888.workers.dev/store/svc/duty-push';
const LIVE = { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs' };
const DRY = { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1', DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs' };
const W = { action: 'mgr_approve', mgr_key: 'AK', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] };
const C = { action: 'clock', emp_id: 'E01' };
/** fetch 假回應：花 ms 毫秒、回 code／text */
const took = (ms, code, text) => (u, o, hh) => { hh.now += ms; return resp(code || 200, text === undefined ? '{"ok":true}' : text); };
const seq = (list) => { let i = 0; return (u, o, hh) => list[Math.min(i++, list.length - 1)](u, o, hh); };
const J = (x) => JSON.parse(JSON.stringify(x));
const stats = (h) => h.changes({ push_stats: true }).push;
const slowSt = (h) => { const e = h.cache.dpush_slow; return e && e.exp > h.now ? JSON.parse(e.v) : null; };

/* ══ 1. 門鈴關、只計數：跟九店線上版逐字逐次相同 ══ */
function scenario(h) {
  const out = [];
  const req = { action: 'duty_changes', mgr_key: 'AK' };
  for (let i = 0; i < 6; i++) { h.write(i % 2 ? C : W, { ok: true, emp_id: 'E01' }); h.advance(3000); }
  h.write({ action: 'mgr_day', date: '2026-11-09' }, { ok: true });
  h.write(Object.assign({}, W, { dry_run: true }), { ok: true });
  h.write(W, { ok: false });
  h.write({ action: 'payroll_ot_month_sync' }, { ok: true });
  h.write({ action: 'sched_publish' }, { ok: true });
  out.push(h.changes({ since: T0 - 1000 }));
  out.push(h.changes({ push_stats: true }));
  out.push(h.changes({ ping: 'nonce_ABC_123' }));
  out.push(h.changes({ back: 'long', push_stats: true }));
  for (let i = 0; i < 45; i++) out.push(h.changes({ ping: 'nonce_ABC_' + String(100 + i) }).ping);   // 碰到 ping 每天 40 次
  out.push(h.sb.handleDutyChanges_(Object.assign({}, req, { admin_key: 'ADM', push_cfg: { url_on: true, dry: true } })));
  for (let i = 0; i < 3; i++) h.write(W, { ok: true });
  out.push(h.changes({ push_stats: true }));
  out.push(h.sb.handleDutyChanges_(Object.assign({}, req, { admin_key: 'ADM', push_cfg: { url_on: false, dry: true } })));
  for (let i = 0; i < 3; i++) h.write(W, { ok: true });
  out.push(h.changes({ push_stats: true }));
  out.push(h.sb.handleDutyChanges_(Object.assign({}, req, { admin_key: 'ADM', push_cfg: { url_on: true, dry: false } })));   // 沒金鑰的店 need_key／有金鑰的店會開到 live（中間不寫入、不讀統計）
  out.push(h.sb.handleDutyChanges_(Object.assign({}, req, { admin_key: 'ADM', push_cfg: { url_on: false, dry: true } })));    // 馬上關回去
  h.now = Date.parse('2026-11-11T00:00:05+08:00');   // 換日
  out.push(h.changes({ push_stats: true }));
  return out;
}
function runBoth(props) {
  const a = harness(OLD, { props }), b = harness(SRC, { props });
  const oa = JSON.stringify(scenario(a)).replace(/"cap":1500/g, '"cap":800'), ob = JSON.stringify(scenario(b));
  return { a, b, oa, ob };
}
const CASES = {
  '門鈴關（屬性都沒設）': {},
  '門鈴關（網址空白、金鑰店代碼都在）': { DUTY_PUSH_URL: '', DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs', DUTY_PUSH_TUNE: '{"cap":1}' },
  '只計數（沒金鑰）': { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' },
  '只計數（金鑰店代碼都在、TUNE 也設了）': Object.assign({ DUTY_PUSH_TUNE: '{"cap":1,"slow_ms":300}' }, DRY),
};
Object.keys(CASES).forEach((name) => ok(name + '：回傳值、暫存區、服務呼叫序列跟九店線上版（a9fac60）逐字逐次相同（只差 push_stats.cap 1500→800）', () => {
  const { a, b, oa, ob } = runBoth(CASES[name]);
  assert.strictEqual(ob, oa, '回傳值不同');
  assert.strictEqual(JSON.stringify(b.cache), JSON.stringify(a.cache), '暫存區內容不同');
  // 最後一步可能把網址開成 live（有金鑰那幾種），但之後沒有寫入 → 仍不會連外
  assert.deepStrictEqual(b.log, a.log, '服務呼叫序列不同');
  assert.strictEqual(b.fetches.length, 0); assert.strictEqual(a.fetches.length, 0);
  assert.deepStrictEqual(b.props, a.props, '屬性最後狀態不同');
  assert.ok(!b.log.some((l) => /DUTY_PUSH_TUNE|dpush_slow|SpreadsheetApp/.test(l)), '關／只計數不該讀 TUNE、慢計數或 flush');
}));

ok('比對本身抓得到差異：把新版的只計數改壞（多讀一個屬性）→ 序列就不同', () => {
  const broken = SRC.replace("var cfg = { url: url, dry:", "props.getProperty('X'); var cfg = { url: url, dry:");
  assert.notStrictEqual(broken, SRC);
  const a = harness(OLD, { props: DRY }), b = harness(broken, { props: DRY });
  scenario(a); scenario(b);
  assert.notDeepStrictEqual(b.log, a.log);
});

/* ══ 2. 正式推送、回應快：跟線上版只差四種呼叫 ══ */
ok('正式推送、回應快（200 毫秒）：跟 a9fac60 只差「讀 DUTY_PUSH_TUNE、getAll 多一鍵、flush、重讀＋寫慢計數」；送出的內容、回傳值、暫存區（慢計數除外）逐字相同', () => {
  const run = (src) => {
    const h = harness(src, { props: LIVE, fetch: took(200) });
    for (let i = 0; i < 8; i++) { h.write(i % 2 ? C : W, { ok: true }); h.advance(5000); }
    const out = [h.changes({ ping: 'nonce_ABC_123' }), h.changes({ since: T0 - 1 })];
    return { h, out };
  };
  const A = run(OLD), B = run(SRC);
  assert.deepStrictEqual(B.h.fetches.map((f) => f.opt.payload), A.h.fetches.map((f) => f.opt.payload));
  assert.deepStrictEqual(B.h.fetches.map((f) => JSON.stringify(f.opt)), A.h.fetches.map((f) => JSON.stringify(f.opt)));
  // push_stats：正式推送多回 slow／flush_*、cap 1500→800；其餘欄位逐字相同
  const outB = J(B.out).map((o) => { if (o.push) { assert.ok(o.push.slow && 'flush_p50ms' in o.push); delete o.push.slow; delete o.push.flush_samples; delete o.push.flush_p50ms; delete o.push.flush_max_ms; delete o.push.flush_err; } return o; });
  assert.strictEqual(JSON.stringify(outB), JSON.stringify(A.out).replace(/"cap":1500/g, '"cap":800'));
  const cb = Object.assign({}, B.h.cache); delete cb.dpush_slow;
  assert.strictEqual(JSON.stringify(cb), JSON.stringify(A.h.cache));
  const norm = (log) => log.filter((l) => l !== 'Props.getProperty:DUTY_PUSH_TUNE' && l !== 'SpreadsheetApp.flush' && l !== 'Cache.put:dpush_slow:21600' && l !== 'Cache.get:dpush_slow')
    .map((l) => l.replace(/^Cache\.getAll:(\d+)$/, 'Cache.getAll:*'));
  assert.deepStrictEqual(norm(B.h.log), norm(A.h.log));
  assert.strictEqual(B.h.log.filter((l) => l === 'SpreadsheetApp.flush').length, 8, '8 筆寫入各 flush 一次（ping 不 flush）');
  assert.strictEqual(B.h.log.filter((l) => l === 'Cache.put:dpush_slow:21600').length, 9, '每次真的連外（8 寫入＋1 ping）寫一次慢計數');
});

/* ══ 3. 回應慢也熔斷 ══ */
ok('一次 ≥2.5 秒（2.6 秒、回 ok）→ 馬上停推 10 分鐘（off.why=slow）；期間 0 次連外、寫入照常返回；期滿後同仁寫入仍不連外，等 mini 的 ping 又快又成功才恢復', () => {
  const h = harness(SRC, { props: LIVE, fetch: seq([took(2600), took(200), took(200)]) });
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 1);
  const p = stats(h);
  assert.deepStrictEqual([p.ok, p.fail, p.off.why, p.slow.trips], [1, 0, 'slow', 1]);
  for (let i = 0; i < 59; i++) { h.advance(10000); h.write(C, { ok: true }); }   // 590 秒內 59 筆
  assert.strictEqual(h.fetches.length, 1);
  assert.strictEqual(stats(h).skip_off, 59);
  h.advance(12600); h.write(C, { ok: true });   // 距離停推開始 > 600 秒
  assert.strictEqual(h.fetches.length, 1, '停推期滿也不拿同仁寫入當探針');
  assert.strictEqual(stats(h).slow.need_ping, true);
  assert.ok(!h.log.slice(-30).includes('SpreadsheetApp.flush'), '等 ping 時不 flush');
  assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'ok');   // mini 帶來的 ping
  assert.strictEqual(h.fetches.length, 2);
  assert.deepStrictEqual([slowSt(h).n, slowSt(h).np], [0, false], 'ping 快又成功 → 解除');
  h.write(C, { ok: true });
  assert.strictEqual(h.fetches.length, 3, '恢復後寫入照推');
});

ok('連續 3 次 ≥1.5 秒（1.6 秒）→ 第 3 次後停推 10 分鐘；2 次慢＋1 次快 → 不停、歸零', () => {
  const h = harness(SRC, { props: LIVE, fetch: seq([took(1600), took(1600), took(300), took(1600), took(1600), took(1600), took(200)]) });
  for (let i = 0; i < 3; i++) { h.write(W, { ok: true }); h.advance(1000); }
  assert.strictEqual(h.fetches.length, 3); assert.strictEqual(stats(h).off, null); assert.strictEqual(slowSt(h).n, 0);
  h.write(W, { ok: true }); h.advance(1000); h.write(W, { ok: true }); h.advance(1000);
  assert.strictEqual(stats(h).off, null); assert.strictEqual(slowSt(h).n, 2);
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 6);
  const p = stats(h);
  assert.deepStrictEqual([p.off.why, p.slow.trips, p.slow.n, p.slow.need_ping], ['slow', 1, 2, true], '停推後計數停在差一次就跳（半開）、等 ping');
  h.advance(30000); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 6);
});

ok('半開：停推期滿後探針（ping）還是慢（1.6 秒）→ 馬上再停 10 分鐘；之後 ping 快又成功 → 恢復，又要連 3 次慢才停', () => {
  const h = harness(SRC, { props: LIVE, fetch: seq([took(2600), took(1600), took(200), took(1600), took(1600), took(1600), took(200)]) });
  h.write(W, { ok: true });                                  // 第 1 次：2.6 秒 → 停
  h.advance(601000); h.write(W, { ok: true });               // 期滿：寫入不連外（等 ping）
  assert.strictEqual(h.fetches.length, 1);
  h.changes({ ping: 'nonce_ABC_123' });                      // 第 2 次（ping）：1.6 秒 → 半開狀態下一次就再停
  assert.deepStrictEqual([h.fetches.length, stats(h).off.why, stats(h).slow.trips, stats(h).slow.need_ping], [2, 'slow', 2, true]);
  h.advance(601000); h.changes({ ping: 'nonce_ABC_124' });   // 第 3 次（ping）：快 → 解除、歸零
  assert.deepStrictEqual([slowSt(h).n, slowSt(h).np], [0, false]);
  h.write(W, { ok: true }); h.write(W, { ok: true });       // 寫入慢兩次：還不停
  assert.strictEqual(stats(h).off, null);
  h.write(W, { ok: true });                                  // 第三次慢 → 停
  assert.strictEqual(h.fetches.length, 6);
  assert.strictEqual(stats(h).off.why, 'slow');
  h.advance(601000); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 6, '又要等 ping');
});

ok('慢又失敗（1.6 秒後回 500）：算失敗（停 60 秒）也算一次慢；連 3 次就改停 10 分鐘', () => {
  const h = harness(SRC, { props: LIVE, fetch: took(1600, 500, '') });
  h.write(W, { ok: true });
  assert.deepStrictEqual([stats(h).off.why, slowSt(h).n], ['fail', 1]);
  h.advance(61000); h.write(W, { ok: true });
  h.advance(61000); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 3);
  assert.deepStrictEqual([stats(h).off.why, stats(h).slow.trips, stats(h).fail], ['slow', 1, 3]);
  h.advance(61000); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 3, '慢熔斷 10 分鐘，60 秒後不該再試');
  assert.strictEqual(slowSt(h).np, true);
});

ok('快但失敗（100 毫秒回 502）：只走失敗熔斷 60 秒，不動慢計數；回 204、off:true 照舊不算慢', () => {
  const h = harness(SRC, { props: LIVE, fetch: seq([took(1600), took(100, 502, ''), took(200, 204, '')]) });
  h.write(W, { ok: true });
  assert.strictEqual(slowSt(h).n, 1);
  h.advance(1000); h.write(W, { ok: true });
  assert.deepStrictEqual([slowSt(h).n, stats(h).off.why], [1, 'fail']);
  h.advance(61000); h.write(W, { ok: true });
  assert.deepStrictEqual([slowSt(h).n, stats(h).off], [0, null], '204＝成功，快 → 歸零');
});

ok('mini 回 off:true（停 1 小時）同時又慢：取比較久的 1 小時', () => {
  const h = harness(SRC, { props: LIVE, fetch: took(2600, 200, '{"ok":true,"off":true}') });
  h.write(W, { ok: true });
  const p = stats(h);
  assert.strictEqual(p.off.why, 'remote');
  assert.strictEqual(p.off.until - h.now, 3600000);
  assert.strictEqual(p.slow.trips, 1);
});

ok('逾時（等了 3 秒後丟錯）＝慢：停 10 分鐘（不是失敗的 60 秒）', () => {
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => { hh.now += 3000; throw new Error('Timeout'); } });
  h.write(W, { ok: true });
  const p = stats(h);
  assert.deepStrictEqual([p.fail, p.off.why, p.off.until - h.now], [1, 'slow', 600000]);
});

ok('ping 慢也算（mini 慢就是慢）；ping 不 flush', () => {
  const h = harness(SRC, { props: LIVE, fetch: took(2600) });
  assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'ok');
  assert.strictEqual(stats(h).off.why, 'slow');
  assert.ok(!h.log.includes('SpreadsheetApp.flush'));
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 1);
});

ok('最壞情況：mini 持續每次卡 3 秒、每 10 秒一筆寫入、mini 每 20 分鐘 ping 一次、連續 2 小時 → 同仁只有第一筆多等 3 秒，之後全由 ping 探測', () => {
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => { hh.now += 3000; throw new Error('Timeout'); } });
  const end = h.now + 2 * 3600000;
  let waited = 0, writes = 0, nextPing = h.now + 20 * 60000, pings = 0;
  while (h.now < end) {
    const t = h.now; h.write(C, { ok: true }); waited += h.now - t; writes++;
    if (h.now >= nextPing) { h.changes({ ping: 'nonce_ABC_' + (100 + pings) }); pings++; nextPing += 20 * 60000; }
    h.advance(10000);
  }
  const wfetch = h.fetches.filter((f) => JSON.parse(f.opt.payload).a !== 'ping').length;
  assert.strictEqual(wfetch, 1, '同仁寫入連外 ' + wfetch + ' 次');
  assert.ok(waited <= 3000, '同仁多等 ' + waited + ' 毫秒');
  console.log('    （2 小時 ' + writes + ' 筆寫入：寫入連外 ' + wfetch + ' 次、ping 連外 ' + (h.fetches.length - wfetch) + ' 次，同仁合計多等 ' + waited / 1000 + ' 秒）');
});

ok('DUTY_PUSH_TUNE：自訂門檻生效；格式錯／超出範圍的欄位用預設；hard_ms 不低於 slow_ms；cap 最多 1,500', () => {
  const t = (raw) => JSON.parse(JSON.stringify(harness(SRC, {}).sb.dutyPushTune_(raw)));
  const D = { slow_ms: 1500, slow_n: 3, hard_ms: 2500, slow_off_s: 600, cap: 800 };
  assert.deepStrictEqual(t(null), D);
  assert.deepStrictEqual(t('not json'), D);
  assert.deepStrictEqual(t('[1,2]'), D);
  assert.deepStrictEqual(t('{"slow_ms":500,"slow_n":2,"hard_ms":1000,"slow_off_s":120,"cap":5}'), { slow_ms: 500, slow_n: 2, hard_ms: 1000, slow_off_s: 120, cap: 5 });
  assert.deepStrictEqual(t('{"slow_ms":100,"slow_n":0,"hard_ms":99999,"slow_off_s":10,"cap":1501}'), D);
  assert.deepStrictEqual(t('{"slow_ms":2000.5,"cap":"900"}'), D);
  assert.deepStrictEqual(t('{"slow_ms":3000}'), Object.assign({}, D, { slow_ms: 3000, hard_ms: 3000 }));
  assert.deepStrictEqual(t('{"cap":1500}').cap, 1500);
  // 實際生效
  const h = harness(SRC, { props: Object.assign({ DUTY_PUSH_TUNE: '{"slow_ms":500,"slow_n":2,"slow_off_s":120,"cap":5}' }, LIVE), fetch: took(600) });
  h.write(W, { ok: true }); h.write(W, { ok: true });
  const p = stats(h);
  assert.deepStrictEqual([p.off.why, p.off.until - h.now, p.cap, p.slow.slow_ms, p.slow.slow_n, p.slow.off_s], ['slow', 120000, 5, 500, 2, 120]);
});

/* ══ 4. flush ══ */
ok('正式推送：flush 恰好一次，在暫存區寫完之後、連外之前；耗時記在 flush_*，不算進連外耗時', () => {
  const h = harness(SRC, { props: LIVE, flushMs: 40, fetch: took(300) });
  h.write(W, { ok: true });
  const iFeed = h.log.findIndex((l) => /^Cache\.put:dfeed_/.test(l));
  const iFl = h.log.indexOf('SpreadsheetApp.flush'), iF = h.log.indexOf('UrlFetch.fetch');
  assert.ok(iFeed >= 0 && iFeed < iFl && iFl < iF, '順序要是 暫存區 → flush → 連外');
  assert.strictEqual(h.log.filter((l) => l === 'SpreadsheetApp.flush').length, 1);
  const p = stats(h);
  assert.deepStrictEqual([p.flush_samples, p.flush_p50ms, p.flush_max_ms, p.p50ms], [1, 40, 40, 300]);
});

ok('不 flush 的情況：門鈴關、只計數、熔斷中、上限滿、設定不齊、唯讀／dry_run／失敗的動作、ping', () => {
  const none = (h) => assert.ok(!h.log.includes('SpreadsheetApp.flush'), h.log.filter((l) => /Spread/.test(l)).join());
  let h = harness(SRC, {}); h.write(W, { ok: true }); none(h);
  h = harness(SRC, { props: DRY }); h.write(W, { ok: true }); h.changes({ ping: 'nonce_ABC_123' }); none(h);
  h = harness(SRC, { props: LIVE, fetch: took(100, 500, '') }); h.write(W, { ok: true });
  const before = h.log.filter((l) => l === 'SpreadsheetApp.flush').length; h.write(W, { ok: true });
  assert.strictEqual(h.log.filter((l) => l === 'SpreadsheetApp.flush').length, before, '熔斷中不 flush');
  h = harness(SRC, { props: Object.assign({ DUTY_PUSH_TUNE: '{"cap":0}' }, LIVE) }); h.write(W, { ok: true }); none(h);
  assert.strictEqual(h.stats().skip_cap, 1);
  h = harness(SRC, { props: { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: 'short', DUTY_PUSH_STORE: 'mztjs' } }); h.write(W, { ok: true }); none(h);
  assert.strictEqual(h.stats().skip_cfg, 1);
  h = harness(SRC, { props: LIVE });
  h.write({ action: 'mgr_day', date: '2026-11-09' }, { ok: true }); h.write(Object.assign({}, W, { dry_run: true }), { ok: true }); h.write(W, { ok: false });
  h.changes({ ping: 'nonce_ABC_123' }); none(h);
  assert.strictEqual(h.fetches.length, 1, '只有 ping 連外');
});

ok('flush 丟錯：這一筆不按門鈴（寫入照常返回、回應物件不變）、記 flush_err；不動 sent／慢計數；下一筆 flush 好了照推', () => {
  let bad = true;
  const h = harness(SRC, { props: LIVE });
  h.sb.SpreadsheetApp = { flush: () => { h.log.push('SpreadsheetApp.flush'); if (bad) throw new Error('flush 失敗'); } };
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 0);
  const p = stats(h);
  assert.deepStrictEqual([p.flush_err, p.sent, p.slow.n, p.slow.need_ping, p.off], [1, 0, 0, false, null]);
  bad = false; h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 1);
  assert.deepStrictEqual([stats(h).flush_err, stats(h).ok], [1, 1]);
});

ok('停推只延長不縮短：連外期間別的執行寫了 600 秒的停推，這筆快速失敗（60 秒）不蓋掉；停推快取一律存 6 小時', () => {
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => {
    hh.cache.dpush_off = { v: JSON.stringify({ until: hh.now + 600000, why: 'slow' }), exp: hh.now + 21600000 };
    hh.now += 100; return resp(502, '');
  } });
  h.write(W, { ok: true });
  const off = JSON.parse(h.cache.dpush_off.v);
  assert.strictEqual(off.why, 'slow'); assert.ok(off.until - h.now > 590000);
  const g = harness(SRC, { props: LIVE, fetch: took(100, 500, '') });
  g.write(W, { ok: true });
  assert.ok(g.log.includes('Cache.put:dpush_off:21600'));
  assert.strictEqual(JSON.parse(g.cache.dpush_off.v).until - g.now, 60000, '靠 until 判斷，不靠快取存活時間');
});

ok('慢計數連外後重讀：連外期間別的執行已把店設成「等 ping」，這筆快速失敗不會把慢計數／等 ping 清掉；這筆快又成功也不會（只有 ping 能解除）', () => {
  const day = new Date(T0 + 8 * 3600000).toISOString().slice(0, 10);
  const set = (hh) => { hh.cache.dpush_slow = { v: JSON.stringify({ n: 2, np: true, d: day, trips: 1, fe: 0, fl: [] }), exp: hh.now + 21600000 }; };
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => { set(hh); hh.now += 100; return resp(502, ''); } });
  h.write(W, { ok: true });
  assert.deepStrictEqual([slowSt(h).n, slowSt(h).np, slowSt(h).trips], [2, true, 1]);
  const g = harness(SRC, { props: LIVE, fetch: (u, o, hh) => { set(hh); hh.now += 100; return resp(200, '{"ok":true}'); } });
  g.write(W, { ok: true });
  assert.deepStrictEqual([slowSt(g).n, slowSt(g).np], [2, true]);
});

/* ══ 5. 每日上限 ══ */
ok('每日上限預設 800：九店兩倍 9×800×2＝14,400 ≤ 2 萬×80%＝16,000；只計數不受上限；push_stats 回有效上限', () => {
  const h = harness(SRC, {});
  assert.strictEqual(h.sb.DUTY_PUSH_DAY_CAP_, 800);
  assert.ok(9 * h.sb.DUTY_PUSH_DAY_CAP_ * 2 <= 20000 * 0.8);
  assert.ok(9 * h.sb.DUTY_PUSH_CAP_MAX_ <= 20000 * 0.8, '就算九店都調到最大 1,500，不計重複也 ≤ 80%');
  const d = harness(SRC, { props: DRY });
  for (let i = 0; i < 900; i++) d.write(C, { ok: true });
  assert.deepStrictEqual([d.fetches.length, d.stats().dry, d.stats().skip_cap, stats(d).cap], [0, 900, 0, 800]);
  const l = harness(SRC, { props: Object.assign({ DUTY_PUSH_TUNE: '{"cap":1200}' }, LIVE) });
  for (let i = 0; i < 1201; i++) l.write(C, { ok: true });
  assert.deepStrictEqual([l.fetches.length, l.stats().skip_cap, stats(l).cap], [1200, 1, 1200]);
});

ok('push_stats 正式推送多回 slow／flush_*（只有個數與門檻），不含網址、金鑰；只計數不多回', () => {
  const h = harness(SRC, { props: LIVE, fetch: took(1600) });
  h.write(W, { ok: true });
  const p = stats(h);
  assert.deepStrictEqual(Object.keys(p.slow), ['n', 'need_ping', 'trips', 'slow_ms', 'slow_n', 'hard_ms', 'off_s']);
  assert.ok('flush_p50ms' in p && 'flush_max_ms' in p && 'flush_samples' in p && 'flush_err' in p);
  const txt = JSON.stringify(p);
  assert.ok(txt.indexOf(KEY) < 0 && txt.indexOf('gw.example') < 0 && txt.indexOf(FIXED) < 0);
  const d = harness(SRC, { props: DRY }); d.write(W, { ok: true });
  const q = stats(d);
  assert.ok(!('slow' in q) && !('flush_p50ms' in q) && !('flush_err' in q));
});

console.log('\nduty-push-live：' + n + ' 項通過、' + nFail + ' 項失敗');
if (nFail) process.exit(1);
