// 考勤副本推送門鈴（2026-11-20，第 1 階段 S2；設計 dzy-mini-playbook docs/clock-to-mini/phase1-design.md 2.3–2.8、9 節 V2）
// 1. 預設關：沒設 DUTY_PUSH_URL 時 dutyFeedNote_／duty_changes 的回傳、暫存區、對每個假服務的呼叫，跟 origin/main 版逐字逐次相同
//    （唯一多出來的是「讀一次 DUTY_PUSH_URL 屬性」）。
// 2. 只計數模式不連外；熔斷、mini 叫停、每日上限、唯讀／dry_run／失敗不推。
// 3. 內容不含員編、姓名、body 任何欄位；簽章用 Node crypto／openssl 重算。
// 4. duty_changes digest／ping／back／push_setup／push_cfg（遠端開關：網址寫死、沒金鑰最多只計數）；新增行的服務用法 ⊆ 九店已部署檔；新增行零試算表寫入。
// 名字、金鑰一律假的；不連網路。
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'apps-script/DutyFeed.gs'), 'utf8');
const BASE = process.env.DUTY_PUSH_BASE || '50a80bc^1';   // PR #181 合併前的 main（b85fbdd）：門鈴關時「只多讀 DUTY_PUSH_URL」以它為準；PR #181 之後的補強另見 duty-push-live.test.js
function gitShow(ref, f) {
  try { return execFileSync('git', ['show', ref + ':' + f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); }
  catch (e) { return null; }
}
const OLD = gitShow(BASE, 'apps-script/DutyFeed.gs');
assert.ok(OLD, '讀不到 ' + BASE + ' 版的 DutyFeed.gs（要在 git repo 裡跑、要先 fetch）');

let n = 0, nFail = 0;
function ok(name, fn) {
  try { fn(); n++; console.log('✓ ' + name); }
  catch (e) { nFail++; console.log('✗ ' + name + '\n    ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n    ')); }
}

const T0 = Date.parse('2026-11-10T10:00:00+08:00');
const KEY = '0123456789abcdef0123456789abcdef';
const URL_ = 'https://gw.example.test/store/svc/duty-push';
const signed = (b) => (b > 127 ? b - 256 : b);
const J = (x) => JSON.parse(JSON.stringify(x));
const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });

/**
 * 只載 DutyFeed.gs 一支，其他檔的函式用假的；每一次碰到 Google 服務都記一行 log（用來逐次比對新舊版）。
 * o: props, now, fetch(url,opt,h)→回應物件或丟錯, reqRows, hub（光復：有 lineHubStores_）, lockOk
 */
function harness(src, o) {
  o = o || {};
  const log = [], fetches = [], logs = [];
  const props = Object.assign({}, o.props || {});
  const cache = {};
  let uuidN = 0, rnd = 0;
  const h = { log, fetches, logs, props, cache, now: o.now || T0 };
  const sb = {
    console, JSON, String, Number, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Boolean,
    Math: Object.assign(Object.create(Math), { random: () => ((rnd++ * 5) % 8 + 0.5) / 8 }),
  };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(h.now); } static now() { return h.now; } };
  sb.PropertiesService = { getScriptProperties: () => { log.push('Props.getScriptProperties'); return {
    getProperty: (k) => { log.push('Props.getProperty:' + k); return props[k] === undefined ? null : props[k]; },
    setProperty: (k, v) => { log.push('Props.setProperty:' + k); props[k] = String(v); },
    getProperties: () => { log.push('Props.getProperties'); return Object.assign({}, props); },   // 2026-11-20 props-once：正式推送一次讀完
    deleteProperty: () => { log.push('Props.deleteProperty'); throw new Error('不該刪'); },
  }; } };
  sb.CacheService = { getScriptCache: () => { log.push('Cache.getScriptCache'); return {
    get: (k) => { log.push('Cache.get:' + k); const e = cache[k]; return e && e.exp > h.now ? e.v : null; },
    put: (k, v, ttl) => { log.push('Cache.put:' + k + ':' + ttl); cache[k] = { v: String(v), exp: h.now + ttl * 1000 }; },
    getAll: (ks) => { log.push('Cache.getAll:' + ks.length); const r = {}; ks.forEach((k) => { const e = cache[k]; if (e && e.exp > h.now) r[k] = e.v; }); return r; },
    putAll: () => { log.push('Cache.putAll'); throw new Error('不該用'); },
    remove: () => { log.push('Cache.remove'); throw new Error('不該用'); },
  }; } };
  sb.UrlFetchApp = { fetch: (url, opt) => {
    log.push('UrlFetch.fetch'); fetches.push({ url, opt });
    if (o.fetch) return o.fetch(url, opt, h);
    return resp(200, '{"ok":true}');
  } };
  sb.Utilities = {
    getUuid: () => { log.push('Utilities.getUuid'); const s = ('0000000' + (uuidN++)).slice(-8); return s + '-1111-2222-3333-444455556666'; },
    computeHmacSha256Signature: (v, k) => { log.push('Utilities.computeHmacSha256Signature'); return Array.from(crypto.createHmac('sha256', String(k)).update(String(v)).digest()).map(signed); },
    computeDigest: (alg, v) => { log.push('Utilities.computeDigest'); return Array.from(crypto.createHash(alg === 'MD5' ? 'md5' : 'sha256').update(String(v)).digest()).map(signed); },
    base64EncodeWebSafe: (b) => { log.push('Utilities.base64EncodeWebSafe'); return Buffer.from(b.map((x) => x & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); },
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  };
  sb.LockService = { getScriptLock: () => { log.push('Lock.getScriptLock'); return {
    tryLock: () => { log.push('Lock.tryLock'); return o.lockOk !== false; }, releaseLock: () => { log.push('Lock.releaseLock'); } }; } };
  // 2026-11-20 live-prep：正式推送前會 SpreadsheetApp.flush()（只准這一個；其餘一律丟錯）
  sb.SpreadsheetApp = new Proxy({}, { get: (t, k) => { log.push('SpreadsheetApp.' + String(k)); if (k === 'flush') return () => { if (o.flushMs) h.now += o.flushMs; if (o.flushThrows) throw new Error('flush 失敗'); }; throw new Error('不該用 SpreadsheetApp'); } });
  sb.Logger = { log: (...a) => { logs.push(a.map(String).join(' ')); } };
  const mgSheet = { name: 'managers' };
  const ss = { getSheetByName: (nm) => { log.push('ss.getSheetByName:' + nm); return nm === 'managers' ? mgSheet : null; } };
  sb.getSS = () => { log.push('getSS'); return ss; };
  sb.readSheetAsObjects = (sh) => { log.push('readSheetAsObjects:' + sh.name);
    return { headers: ['name', 'key', 'active', 'allow_acting', 'emp_id'], rows: [{ name: '假主管', key: 'AK', active: 'true', allow_acting: 'true', emp_id: '', __rowIndex: 2 }] }; };
  sb.findManagerByKey = (rows, key) => (String(key == null ? '' : key).trim() ? rows.filter((r) => String(r.key) === String(key) && String(r.active).toLowerCase() === 'true')[0] : undefined);
  sb.reqRows_ = () => { log.push('reqRows_'); return o.reqRows || []; };
  sb.checkAdmin = (b) => b.admin_key === 'ADM';
  if (o.hub) {
    sb.lineHubStores_ = () => [{ code: '', name: '小辛辣 新竹光復' }, { code: 'mztjs', name: '墨竹亭 金山' }, { code: 'mztmc', name: '墨竹亭 美村' }];
    sb.LINE_HUB_STAFF_CODE_MAP = { '': 'gf', mztjs: 'mztjs', mztmc: 'mztmc' };
  }
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'DutyFeed.gs' });
  h.sb = sb;
  h.advance = (ms) => { h.now += ms; };
  /** 一次寫入：回傳值要原封不動、不能丟例外 */
  h.write = (body, res) => {
    const before = JSON.stringify(res);
    const r = sb.dutyFeedNote_(body, res);
    assert.strictEqual(r, undefined);
    assert.strictEqual(JSON.stringify(res), before, '回應物件被改了');
    return res;
  };
  h.changes = (extra) => sb.handleDutyChanges_(Object.assign({ action: 'duty_changes', mgr_key: 'AK', since: h.now - 60000 }, extra || {}));
  h.stats = () => { const day = new Date(h.now + 8 * 3600000).toISOString().slice(0, 10); const e = cache['dpush_st_' + day]; return e ? JSON.parse(e.v) : null; };
  return h;
}
const W = { action: 'mgr_approve', mgr_key: 'AK', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] };
const LIVE = { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs' };

/* ══ 1. 預設關＝跟 origin/main 逐字逐次相同 ══ */
// 同一套動作分別丟給舊版、新版：回傳值、暫存區內容、服務呼叫序列都要一樣；新版只多「讀 DUTY_PUSH_URL」一組（每筆有記到的寫入一次）
function scenario(h) {
  const out = [];
  const reqRows = [{ id: 'r1', date: '2026-11-08', emp_id: 'E02' }];
  h.write(W, { ok: true });
  h.write({ action: 'mgr_day', mgr_key: 'AK', date: '2026-11-09' }, { ok: true, employees: [] });          // 唯讀
  h.write(Object.assign({}, W, { dry_run: true }), { ok: true });                                          // 只檢查
  h.write(W, { ok: false, error: 'stale_ver' });                                                          // 失敗
  h.write({ action: 'req_submit', id_token: 'x' }, { ok: true, request: { emp_id: 'E01', date: '2026-11-09' } });
  h.advance(10000);
  h.write({ action: 'mgr_req_decide', mgr_key: 'AK', id: 'r1' }, { ok: true });                            // 用 id 回查日期
  h.write({ action: 'payroll_leave_options' }, { ok: true });                                             // 薪資唯讀
  h.write({ action: 'payroll_ot_month_sync', admin_key: 'x' }, { ok: true });
  h.write({ action: 'mgr_set_active', emp_id: 'E02', active: false }, { ok: true, emp_id: 'E02', cascade: { ok: true, stopped: [{ store_name: '墨竹亭 金山' }] } });
  h.write({ action: '' }, { ok: true });
  h.write(null, null);
  h.write({ action: 'relay_append' }, { ok: true });
  h.advance(5000);
  out.push(h.changes({ since: T0 - 1000 }));
  out.push(h.changes({ since: undefined }));
  out.push(h.changes({ since: h.now - 16 * 60000 }));
  out.push(h.changes({ since: String(T0) }));
  out.push(h.changes({ mgr_key: 'NOPE' }));
  out.push(h.changes({ mgr_key: '' }));
  // 參數長得像、但不是新參數的正確格式 → 當作沒帶
  out.push(h.changes({ since: T0, digest: 'yes', back: 'short', ping: 'x', push_stats: 1, foo: 1 }));
  out.push(h.changes({ since: T0, ping: 'has space in it' }));
  return { out, reqRows };
}
function runScenario(src, props) {
  const h = harness(src, { props, reqRows: [{ id: 'r1', date: '2026-11-08', emp_id: 'E02' }] });
  const r = scenario(h);
  return { h, out: JSON.stringify(r.out), cache: JSON.stringify(h.cache) };
}
function stripUrlRead(log) {
  const outL = []; let extra = 0;
  for (let i = 0; i < log.length; i++) {
    if (log[i] === 'Props.getScriptProperties' && log[i + 1] === 'Props.getProperty:DUTY_PUSH_URL') { extra++; i++; continue; }
    outL.push(log[i]);
  }
  return { log: outL, extra };
}

ok('沒設 DUTY_PUSH_URL：回傳值、暫存區、服務呼叫序列跟 origin/main 逐字逐次相同（只多讀 DUTY_PUSH_URL，每筆記到的寫入一次）', () => {
  const a = runScenario(OLD, {}), b = runScenario(SRC, {});
  assert.strictEqual(b.out, a.out);
  assert.strictEqual(b.cache, a.cache);
  const s = stripUrlRead(b.h.log);
  assert.deepStrictEqual(s.log, a.h.log);
  // 記到的寫入：mgr_approve、req_submit、mgr_req_decide、payroll_ot_month_sync、mgr_set_active、relay_append ＝ 6 筆
  assert.strictEqual(s.extra, 6);
  assert.strictEqual(b.h.fetches.length, 0);
  assert.ok(!b.h.log.some((l) => /^UrlFetch|^Lock\.|^Props\.setProperty|^SpreadsheetApp/.test(l)));
});

ok('沒設 DUTY_PUSH_URL、但其他門鈴屬性都在：還是只讀 DUTY_PUSH_URL 一個屬性、0 次連外、結果跟 origin/main 相同', () => {
  const props = { DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs', DUTY_PUSH_DRY: '0' };
  const a = runScenario(OLD, props), b = runScenario(SRC, props);
  assert.strictEqual(b.out, a.out); assert.strictEqual(b.cache, a.cache);
  assert.deepStrictEqual(stripUrlRead(b.h.log).log, a.h.log);
  assert.ok(!b.h.log.some((l) => /DUTY_PUSH_(KEY|STORE|DRY)/.test(l)));
  assert.strictEqual(b.h.fetches.length, 0);
});

ok('DUTY_PUSH_URL 是空白字串：當作沒設', () => {
  const h = harness(SRC, { props: { DUTY_PUSH_URL: '   ', DUTY_PUSH_KEY: KEY } });
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 0); assert.strictEqual(h.stats(), null);
});

ok('duty_changes 不帶新參數：回應 key 集合＝舊版 {ok,now,since,reset,changes}', () => {
  const h = harness(SRC, { props: LIVE });
  h.write(W, { ok: true });
  assert.deepStrictEqual(Object.keys(h.changes()), ['ok', 'now', 'since', 'reset', 'changes']);
});

/* ══ 2. 只計數 ══ */
ok('DUTY_PUSH_DRY=1：UrlFetch 0 次、只計數有加；不讀金鑰；唯讀／dry_run／失敗不計', () => {
  const h = harness(SRC, { props: { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' } });
  h.write(W, { ok: true });
  h.write({ action: 'clock', emp_id: 'E01' }, { ok: true, status: 'ok' });
  h.write({ action: 'mgr_day', date: '2026-11-09' }, { ok: true });
  h.write(Object.assign({}, W, { dry_run: true }), { ok: true });
  h.write(W, { ok: false });
  h.write({ action: 'payroll_ot_month_sync' }, { ok: true });
  assert.strictEqual(h.fetches.length, 0);
  assert.ok(!h.log.some((l) => /UrlFetch|DUTY_PUSH_KEY|DUTY_PUSH_STORE|computeHmac/.test(l)));
  const st = h.stats();
  assert.deepStrictEqual([st.dry, st.sent, st.ok, st.fail, st.with_to], [3, 0, 0, 0, 1]);
  const p = h.changes({ push_stats: true }).push;
  assert.deepStrictEqual([p.on, p.mode, p.dry, p.sent, p.key_set, p.cap], [true, 'dry', 3, 0, false, 800]);   // live-prep：預設上限 1,500→800
});

ok('只計數模式：1,500 次以上照樣計數（量真實推送量），一樣不連外', () => {
  const h = harness(SRC, { props: { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' } });
  for (let i = 0; i < 1600; i++) h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 0); assert.strictEqual(h.stats().dry, 1600); assert.strictEqual(h.stats().skip_cap, 0);
});

/* ══ 3. 正式推送：內容、簽章、選項 ══ */
const MARK = { emp_id: 'MARKEMP01', name: 'MARKNAME王小明', acting_name: 'MARKACT店長', note: 'MARKNOTE', key: 'MARKROSTERKEY', id_token: 'MARKTOKEN', reason: 'MARKREASON' };
ok('推送內容只有 {v,s,t,n,a,d,to?,sig}：不含員編、姓名、body／res 任何欄位、不含金鑰；選項 timeoutSeconds≤3、不跟轉址、muteHttpExceptions', () => {
  const h = harness(SRC, { props: LIVE });
  const body = Object.assign({}, W, MARK, { mgr_key: 'MARKMGRKEY', admin_key: 'MARKADMIN' });
  h.write(body, { ok: true, emp_id: 'MARKEMP01', name: 'MARKNAME王小明', request: { emp_id: 'MARKEMP02', reason: 'MARKRES' } });
  assert.strictEqual(h.fetches.length, 1);
  const f = h.fetches[0], p = JSON.parse(f.opt.payload);
  assert.strictEqual(f.url, URL_);
  assert.deepStrictEqual(Object.keys(p), ['v', 's', 't', 'n', 'a', 'd', 'sig']);
  assert.ok(Object.keys(p).every((k) => ['v', 's', 't', 'n', 'a', 'd', 'to', 'ping', 'sig'].indexOf(k) >= 0));
  assert.deepStrictEqual([p.v, p.s, p.t, p.a, p.d], [1, 'mztjs', T0, 'mgr_approve', ['2026-11-09']]);
  assert.ok(/^[0-9a-f]{8}$/.test(p.n));
  assert.ok(!/MARK|E01|AK/.test(f.opt.payload), '推送內容帶到了 body／res 的值：' + f.opt.payload);
  assert.ok(f.opt.payload.indexOf(KEY) < 0);
  assert.deepStrictEqual([f.opt.method, f.opt.contentType, f.opt.muteHttpExceptions, f.opt.followRedirects], ['post', 'application/json', true, false]);
  assert.ok(typeof f.opt.timeoutSeconds === 'number' && f.opt.timeoutSeconds > 0 && f.opt.timeoutSeconds <= 3);
  // 編號 n 跟 duty_changes 拿到的那一筆一樣（mini 用來判斷「這筆先收過門鈴」）
  assert.strictEqual(h.changes().changes[0].n, p.n);
});

ok('簽章：Node crypto 重算一致；固定金鑰＋固定內容 → 固定 hex（openssl 手算對照）', () => {
  const h = harness(SRC, { props: LIVE });
  // 手算：printf '%s' '1|mztjs|1762740000000|abcd1234|mgr_approve|2026-11-09,2026-11-10||' | openssl dgst -sha256 -hmac 0123456789abcdef0123456789abcdef
  const fixed = { v: 1, s: 'mztjs', t: 1762740000000, n: 'abcd1234', a: 'mgr_approve', d: ['2026-11-09', '2026-11-10'] };
  assert.strictEqual(h.sb.dutyPushSign_(fixed, KEY), 'ff6bc9261be06d3128cb458b709045dbfec0f611c2ec9626db52033a8e9b976d');
  const withTo = { v: 1, s: 'gf', t: 1762740000000, n: 'abcd1234', a: 'mgr_set_active', d: ['2026-11-09'], to: ['mztjs', 'mztmc'] };
  assert.strictEqual(h.sb.dutyPushSign_(withTo, KEY), crypto.createHmac('sha256', KEY).update('1|gf|1762740000000|abcd1234|mgr_set_active|2026-11-09|mztjs,mztmc|').digest('hex'));
  assert.strictEqual(h.sb.dutyPushSign_(withTo, KEY), '77127bafa7d223bd3c9ba344403e91ee412a63d15532cc01f22355dae9066d60');
  h.write(W, { ok: true });
  const p = JSON.parse(h.fetches[0].opt.payload);
  const msg = [p.v, p.s, p.t, p.n, p.a, p.d.join(','), (p.to || []).join(','), p.ping || ''].join('|');
  assert.strictEqual(p.sig, crypto.createHmac('sha256', KEY).update(msg).digest('hex'));
});

ok('成功一次：統計 sent／ok／耗時都有；不熔斷、下一筆照推', () => {
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => { hh.now += 420; return resp(200, '{"ok":true}'); } });
  h.write(W, { ok: true }); h.write(W, { ok: true });
  const st = h.stats();
  assert.deepStrictEqual([st.sent, st.ok, st.fail, st.ms], [2, 2, 0, [420, 420]]);
  const p = h.changes({ push_stats: true }).push;
  assert.deepStrictEqual([p.mode, p.key_set, p.p50ms, p.p95ms, p.max_ms, p.samples, p.off], ['live', true, 420, 420, 420, 2, null]);
  assert.ok(JSON.stringify(p).indexOf(KEY) < 0 && JSON.stringify(p).indexOf(URL_) < 0);
});

/* ══ 4. 失敗：丟例外、逾時、500、非 JSON、轉址 → 寫入不受影響，60 秒內不再推 ══ */
const FAILS = {
  '丟例外': () => { throw new Error('DNS error MARKSECRET'); },
  '逾時（等了 3 秒後丟錯）': (u, o, hh) => { hh.now += 3000; throw new Error('Timeout: ' + u); },
  '回 500': () => resp(500, '{"ok":false}'),
  '回非 JSON': () => resp(200, '<html>Cloudflare error</html>'),
  '回 JSON 但 ok 不是 true': () => resp(200, '{"ok":false,"error":"sig"}'),
  '轉址 302': () => resp(302, ''),
  '回應物件本身壞掉': () => ({ getResponseCode: () => { throw new Error('boom'); } }),
};
Object.keys(FAILS).forEach((name) => ok('推送' + name + '：dutyFeedNote_ 正常返回、暫存區那筆仍在、熔斷 60 秒（期間 0 次連外）、61 秒後再試', () => {
  const h = harness(SRC, { props: LIVE, fetch: FAILS[name] });
  const res = { ok: true, ts: 'x' };
  h.write(W, res);
  assert.strictEqual(h.fetches.length, 1);
  assert.strictEqual(h.changes({ since: T0 - 1 }).changes.length, 1, '暫存區那筆不見了');
  const st = h.stats();
  assert.deepStrictEqual([st.sent, st.fail, st.ok], [1, 1, 0]);
  const p = h.changes({ push_stats: true }).push;
  const slowCase = name.indexOf('逾時') === 0;   // live-prep：等了 3 秒（≥ 2.5 秒）＝慢熔斷，停 10 分鐘（比失敗的 60 秒久，取久的）
  assert.strictEqual(p.off.why, slowCase ? 'slow' : 'fail');
  for (let i = 0; i < 5; i++) { h.advance(10000); h.write(W, { ok: true }); }   // 50 秒內 5 筆
  assert.strictEqual(h.fetches.length, 1, '熔斷期間還在連外');
  assert.strictEqual(h.stats().skip_off, 5);
  h.advance(11000);   // 距離失敗 61 秒（逾時那筆另外多 3 秒，所以多等一點）
  if (slowCase) {   // live-prep：因慢停推後不拿同仁寫入當探針，要等 mini 的 ping
    h.advance(3000); h.write(W, { ok: true }); assert.strictEqual(h.fetches.length, 1, '慢熔斷 10 分鐘內還在連外');
    h.advance(600000); h.write(W, { ok: true }); assert.strictEqual(h.fetches.length, 1, '停推期滿、還沒等到 ping，寫入不該連外');
    h.changes({ ping: 'nonce_ABC_123' });   // ping 才會去試
  } else h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 2, '熔斷過了應該再試');
  assert.ok(h.logs.every((l) => l.indexOf('MARKSECRET') < 0));
}));

ok('順序鎖定：按門鈴（UrlFetch）當下，暫存區已經有那一筆（先寫暫存區、再按門鈴；對調就紅）', () => {
  let seen = null;
  const h = harness(SRC, { props: LIVE, fetch: (u, o, hh) => {
    const pn = JSON.parse(o.payload).n;
    const ns = [];
    Object.keys(hh.cache).forEach((k) => { if (hh.cache[k].exp > hh.now) JSON.parse(hh.cache[k].v).forEach((r) => ns.push(r.n)); });
    seen = { pn, inCache: ns.indexOf(pn) >= 0 };
    return resp(200, '{"ok":true}');
  } });
  h.write(W, { ok: true });
  assert.ok(seen, '沒有按門鈴');
  assert.strictEqual(seen.inCache, true, '按門鈴當下暫存區還沒有這一筆（順序被對調了）');
  // 門鈴丟錯時暫存區那筆也在（mini 下次問 duty_changes 照樣拿得到）
  const h2 = harness(SRC, { props: LIVE, fetch: () => { throw new Error('boom'); } });
  h2.write(W, { ok: true });
  assert.strictEqual(h2.changes({ since: T0 - 1 }).changes.length, 1);
});

ok('mini 回 204（關了收門鈴）：算成功、不熔斷', () => {
  const h = harness(SRC, { props: LIVE, fetch: () => resp(204, '') });
  h.write(W, { ok: true }); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 2); assert.strictEqual(h.stats().ok, 2);
});

ok('mini 回 {ok:true, off:true}：之後 1 小時內 0 次連外，1 小時後再試', () => {
  let n0 = 0;
  const h = harness(SRC, { props: LIVE, fetch: () => (n0++ === 0 ? resp(200, '{"ok":true,"off":true}') : resp(200, '{"ok":true}')) });
  h.write(W, { ok: true });
  for (let i = 0; i < 59; i++) { h.advance(60000); h.write(W, { ok: true }); }
  assert.strictEqual(h.fetches.length, 1);
  assert.deepStrictEqual([h.stats().remote_off, h.stats().skip_off], [1, 59]);
  assert.strictEqual(h.changes({ push_stats: true }).push.off.why, 'remote');
  h.advance(61000); h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 2);
});

ok('每日上限（live-prep 起預設 800）：第 801 次不連外（記 skip_cap）；隔天（台北）重新計', () => {
  const h = harness(SRC, { props: LIVE });
  for (let i = 0; i < 800; i++) h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 800);
  h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 800);
  assert.deepStrictEqual([h.stats().sent, h.stats().skip_cap], [800, 1]);
  assert.strictEqual(h.stats().ms.length, 100, '耗時只留最近 100 次');
  h.now = Date.parse('2026-11-11T00:00:05+08:00');
  h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 801);
});

ok('唯讀動作、dry_run:true、res.ok===false、沒有回應：不推、不計數', () => {
  const h = harness(SRC, { props: LIVE });
  h.write({ action: 'mgr_day', date: '2026-11-09' }, { ok: true });
  h.write({ action: 'duty_changes' }, { ok: true });
  h.write({ action: 'mgr_approve_check', date: '2026-11-09' }, { ok: true });
  h.write({ action: 'payroll_leave_options' }, { ok: true });
  h.write(Object.assign({}, W, { dry_run: true }), { ok: true });
  h.write(W, { ok: false, error: 'unauthorized' });
  h.write(W, null);
  assert.strictEqual(h.fetches.length, 0); assert.strictEqual(h.stats(), null);
});

ok('金鑰、店代碼、網址不齊：不連外、記 skip_cfg', () => {
  [{ DUTY_PUSH_URL: URL_, DUTY_PUSH_STORE: 'mztjs' }, { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: 'short', DUTY_PUSH_STORE: 'mztjs' },
   { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: KEY }, { DUTY_PUSH_URL: 'http://plain.example.test/x', DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs' },
   { DUTY_PUSH_URL: URL_, DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'MZT JS' }].forEach((props) => {
    const h = harness(SRC, { props });
    h.write(W, { ok: true });
    assert.strictEqual(h.fetches.length, 0, JSON.stringify(props)); assert.strictEqual(h.stats().skip_cfg, 1);
  });
});

ok('CacheService／Properties 整個壞掉：寫入照常返回、不丟例外', () => {
  const h = harness(SRC, { props: LIVE });
  let calls = 0;
  h.sb.PropertiesService = { getScriptProperties: () => { calls++; throw new Error('Properties 掛了'); } };
  h.write(W, { ok: true });
  assert.strictEqual(calls, 1);
  const h2 = harness(SRC, { props: LIVE });
  const real = h2.sb.CacheService.getScriptCache;
  let k = 0;
  h2.sb.CacheService = { getScriptCache: () => { if (k++ === 0) return real(); throw new Error('Cache 掛了'); } };   // 暫存區寫得進去、門鈴那段的 cache 壞掉
  h2.write(W, { ok: true });
  assert.strictEqual(h2.fetches.length, 0);
});

/* ══ 5. 光復跨店寫入的 to ══ */
ok('光復設離職連帶停用（cascade.stopped／failed）→ to＝那幾家的 mini 店代碼；對不上 → ["*"]；薪資、排班發布 → ["*"]', () => {
  const h = harness(SRC, { props: Object.assign({}, LIVE, { DUTY_PUSH_STORE: 'gf' }), hub: true });
  const last = () => JSON.parse(h.fetches[h.fetches.length - 1].opt.payload);
  h.write({ action: 'mgr_set_active', emp_id: 'E02' }, { ok: true, emp_id: 'E02', cascade: { ok: true, stopped: [{ store_name: '墨竹亭 美村', emp_id: 'X', name: 'MARKNAME' }, { store_name: '墨竹亭 金山' }], failed: [] } });
  assert.deepStrictEqual(last().to, ['mztjs', 'mztmc']);
  assert.ok(h.fetches[0].opt.payload.indexOf('MARKNAME') < 0);
  h.write({ action: 'svc_set_active', emp_id: 'E02' }, { ok: true, cascade: { ok: false, stopped: [], failed: ['墨竹亭 金山'] } });
  assert.deepStrictEqual(last().to, ['mztjs']);
  h.write({ action: 'line_hub_left', emp_id: 'E02' }, { ok: true, stopped: [{ store_name: '小辛辣 新竹光復' }], failed: [] });
  assert.deepStrictEqual(last().to, ['gf']);
  h.write({ action: 'mgr_set_active', emp_id: 'E02' }, { ok: true, cascade: { ok: true, stopped: [{ store_name: '不在清單的店' }] } });
  assert.deepStrictEqual(last().to, ['*']);
  ['payroll_ot_month_sync', 'payroll_holiday_sync', 'payroll_migrate_store', 'payroll_leave_event_set', 'sched_publish', 'sched_unpublish'].forEach((a) => {
    h.write({ action: a }, { ok: true }); assert.deepStrictEqual(last().to, ['*'], a);
  });
  h.write({ action: 'mgr_set_active', emp_id: 'E02' }, { ok: true, emp_id: 'E02' });   // 沒有連帶 → 沒有 to
  assert.strictEqual(last().to, undefined);
  h.write({ action: 'line_quick_clock' }, { ok: true, result: { store_name: '墨竹亭 金山' } });   // 跨店打卡由那家店自己的 doPost 記（lineHubCallStore_）
  assert.strictEqual(last().to, undefined);
  const p = last(); const msg = [p.v, p.s, p.t, p.n, p.a, p.d.join(','), (p.to || []).join(','), ''].join('|');
  assert.strictEqual(p.sig, crypto.createHmac('sha256', KEY).update(msg).digest('hex'));
});

ok('其他店（沒有 LineHub）設離職、回應帶光復回來的 cascade：不帶 to（真正寫別家的是光復，光復自己會推）', () => {
  const h = harness(SRC, { props: LIVE });
  h.write({ action: 'mgr_set_active', emp_id: 'E02' }, { ok: true, cascade: { ok: true, stopped: [{ store_name: '墨竹亭 美村' }] } });
  assert.strictEqual(JSON.parse(h.fetches[0].opt.payload).to, undefined);
});

/* ══ 6. duty_changes：back、ping、push_stats ══ */
ok("back:'long'：往回 75 分鐘；不帶照舊 15 分鐘", () => {
  const h = harness(SRC, { props: {} });
  h.write(W, { ok: true });
  h.advance(40 * 60000);
  const plain = h.changes({ since: T0 - 1000 });
  assert.deepStrictEqual([plain.reset, plain.changes.length, plain.since], [true, 0, h.now - 15 * 60000]);
  const long = h.changes({ since: T0 - 1000, back: 'long' });
  assert.deepStrictEqual([long.reset, long.changes.length, long.since], [false, 1, T0 - 1000]);
  assert.deepStrictEqual(J(long.push), { on: false });
  const old = h.changes({ since: h.now - 80 * 60000, back: 'long' });
  assert.deepStrictEqual([old.reset, old.since, old.changes.length], [true, h.now - 75 * 60000, 1]);
  // 剛好 75 分鐘＝451 格（頭尾都算）× 8 個位置＝3,608 把鑰匙，每 100 把一次 getAll → 36 次滿的＋1 次 8 把
  const nGet = h.log.length; h.changes({ since: h.now - 75 * 60000, back: 'long' });
  const gets = h.log.slice(nGet).filter((l) => /^Cache\.getAll:/.test(l));
  assert.deepStrictEqual([gets.length, gets.filter((l) => l === 'Cache.getAll:100').length, gets[gets.length - 1]], [37, 36, 'Cache.getAll:8']);
});

ok('ping：沒設網址回 disabled；只計數回 dry（0 次連外）；正式推一筆 {a:"ping", ping, sig}，簽章含 ping', () => {
  const h0 = harness(SRC, { props: {} });
  const r0 = h0.changes({ ping: 'nonce_ABC_123' });
  assert.deepStrictEqual(J([r0.ping, r0.push]), ['disabled', { on: false }]);
  const h1 = harness(SRC, { props: { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' } });
  assert.strictEqual(h1.changes({ ping: 'nonce_ABC_123' }).ping, 'dry'); assert.strictEqual(h1.fetches.length, 0);
  const h2 = harness(SRC, { props: LIVE });
  const r2 = h2.changes({ ping: 'nonce_ABC_123' });
  assert.strictEqual(r2.ping, 'ok'); assert.strictEqual(h2.fetches.length, 1);
  const p = JSON.parse(h2.fetches[0].opt.payload);
  assert.deepStrictEqual([p.a, p.ping, p.d, p.s], ['ping', 'nonce_ABC_123', [], 'mztjs']);
  assert.deepStrictEqual(Object.keys(p), ['v', 's', 't', 'n', 'a', 'd', 'ping', 'sig']);
  assert.strictEqual(p.sig, crypto.createHmac('sha256', KEY).update([1, 'mztjs', p.t, p.n, 'ping', '', '', 'nonce_ABC_123'].join('|')).digest('hex'));
  assert.strictEqual(r2.push.sent, 1);
  // 未授權不推
  const h3 = harness(SRC, { props: LIVE });
  assert.strictEqual(h3.changes({ mgr_key: 'NOPE', ping: 'nonce_ABC_123' }).error, 'unauthorized'); assert.strictEqual(h3.fetches.length, 0);
  // 熔斷中 → skip_off
  const h4 = harness(SRC, { props: LIVE, fetch: () => resp(500, '') });
  h4.write(W, { ok: true });
  assert.strictEqual(h4.changes({ ping: 'nonce_ABC_123' }).ping, 'skip_off');
});

/* ══ 6b. ping 另設每日上限（每店每天 40 次）══ */
ok('讀取類請求（mgr_day、duty_changes 不帶新參數、liff_status、relay_pull）：PropertiesService／CacheService 呼叫跟 origin/main 逐次相同，新增屬性讀取＝0 次', () => {
  const reads = [
    { action: 'mgr_day', mgr_key: 'AK', date: '2026-11-09' }, { action: 'duty_changes', mgr_key: 'AK', since: T0 }, { action: 'liff_status' }, { action: 'relay_pull', mgr_key: 'AK' },
  ];
  [LIVE, {}, { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' }].forEach((props) => {
    const a = harness(OLD, { props }), b = harness(SRC, { props });
    reads.forEach((body) => { a.write(body, { ok: true }); b.write(body, { ok: true }); });
    assert.deepStrictEqual(b.log, a.log);
    assert.strictEqual(b.log.filter((l) => /^Props\./.test(l)).length, 0, '讀取類請求不該讀任何屬性');
    assert.strictEqual(b.log.filter((l) => /^Cache\./.test(l)).length, 0);
    // duty_changes 本身（不帶新參數）：整段呼叫序列也跟舊版相同
    const a2 = harness(OLD, { props }), b2 = harness(SRC, { props });
    assert.strictEqual(JSON.stringify(b2.changes({ since: T0 - 1000 })), JSON.stringify(a2.changes({ since: T0 - 1000 })));
    assert.deepStrictEqual(b2.log, a2.log);
    assert.ok(!b2.log.some((l) => /DUTY_PUSH|dpush_/.test(l)));
    assert.strictEqual(b.fetches.length + b2.fetches.length, 0);
  });
});

ok('ping 每天 40 次：第 41 次不連外（回 skip_ping_cap、統計記一筆）；隔天（台北）重新算', () => {
  assert.strictEqual(harness(SRC, { props: {} }).sb.DUTY_PUSH_PING_DAY_CAP_, 40);
  const h = harness(SRC, { props: LIVE });
  for (let i = 0; i < 40; i++) assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'ok');
  assert.strictEqual(h.fetches.length, 40);
  const r = h.changes({ ping: 'nonce_ABC_123' });
  assert.strictEqual(r.ping, 'skip_ping_cap'); assert.strictEqual(h.fetches.length, 40);
  assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'skip_ping_cap'); assert.strictEqual(h.fetches.length, 40);
  assert.deepStrictEqual([r.push.sent, r.push.ok, r.push.skip_ping_cap, r.push.skip_cap, r.push.ping_cap], [40, 40, 1, 0, 40]);
  assert.strictEqual(h.changes({ push_stats: true }).push.skip_ping_cap, 2);
  h.now = Date.parse('2026-11-11T00:00:05+08:00');
  assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'ok'); assert.strictEqual(h.fetches.length, 41);
  assert.deepStrictEqual([h.stats().sent, h.stats().skip_ping_cap], [1, 0]);
});

ok('ping 超過上限不影響一般寫入的推送；一般寫入照舊受每日上限（live-prep 起 800）；ping 仍受熔斷管', () => {
  const h = harness(SRC, { props: LIVE });
  for (let i = 0; i < 41; i++) h.changes({ ping: 'nonce_ABC_123' });
  assert.strictEqual(h.fetches.length, 40);
  h.write(W, { ok: true }); h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 42);
  assert.deepStrictEqual(J(JSON.parse(h.fetches[41].opt.payload).a), 'clock');
  assert.deepStrictEqual([h.stats().sent, h.stats().ok, h.stats().skip_ping_cap, h.stats().skip_cap], [42, 42, 1, 0]);
  // 一般寫入的上限 800（含前面 40 次 ping 與 2 次寫入）
  for (let i = 0; i < 758; i++) h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 800);
  h.write({ action: 'clock' }, { ok: true });
  assert.deepStrictEqual([h.fetches.length, h.stats().skip_cap], [800, 1]);
  // ping 還沒滿 40 次、但熔斷中 → skip_off，不算進 ping 次數
  const g = harness(SRC, { props: LIVE, fetch: () => resp(500, '') });
  g.write(W, { ok: true });
  assert.strictEqual(g.changes({ ping: 'nonce_ABC_123' }).ping, 'skip_off');
  assert.strictEqual(g.cache['dpush_ping_2026-11-10'], undefined);
  // 只計數模式也套 ping 上限（量到的就是正式會推的次數），一般寫入不受影響
  const d = harness(SRC, { props: { DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' } });
  for (let i = 0; i < 41; i++) d.changes({ ping: 'nonce_ABC_123' });
  d.write(W, { ok: true });
  assert.deepStrictEqual([d.fetches.length, d.stats().dry, d.stats().skip_ping_cap], [0, 41, 1]);
});

/* ══ 7. 一次性設門鈴金鑰（push_setup）══ */
const NEWKEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
ok('push_setup：沒管理金鑰、主管金鑰錯、格式錯 → 拒絕不寫；第一次寫入（不回金鑰）；第二次 already_set；回應與 log 都沒有金鑰', () => {
  const h = harness(SRC, { props: {} });
  const call = (extra) => h.sb.handleDutyChanges_(Object.assign({ action: 'duty_changes', mgr_key: 'AK', push_setup: { key: NEWKEY, store: 'mztjs' } }, extra));
  const outs = [];
  outs.push(call({})); outs.push(call({ admin_key: 'WRONG' })); outs.push(call({ admin_key: 'ADM', mgr_key: 'NOPE' }));
  assert.deepStrictEqual(outs.map((r) => r.error), ['unauthorized', 'unauthorized', 'unauthorized']);
  [{ key: 'short', store: 'mztjs' }, { key: NEWKEY, store: 'MZT JS' }, { key: NEWKEY }, null, 'x', { key: NEWKEY + '<script>', store: 'gf' }].forEach((ps) => {
    const r = call({ admin_key: 'ADM', push_setup: ps }); outs.push(r); assert.strictEqual(r.error, 'bad_input', JSON.stringify(ps));
  });
  assert.strictEqual(h.props.DUTY_PUSH_KEY, undefined);
  const r1 = call({ admin_key: 'ADM' }); outs.push(r1);
  assert.deepStrictEqual(J(r1), { ok: true, push_setup: 'set', store: 'mztjs' });
  assert.deepStrictEqual([h.props.DUTY_PUSH_KEY, h.props.DUTY_PUSH_STORE], [NEWKEY, 'mztjs']);
  const r2 = call({ admin_key: 'ADM', push_setup: { key: 'f'.repeat(64), store: 'gf' } }); outs.push(r2);
  assert.deepStrictEqual(J(r2), { ok: false, error: 'already_set' });
  assert.deepStrictEqual([h.props.DUTY_PUSH_KEY, h.props.DUTY_PUSH_STORE], [NEWKEY, 'mztjs']);
  const all = JSON.stringify(outs) + h.logs.join('\n') + h.log.join('\n');
  assert.ok(all.indexOf(NEWKEY) < 0 && all.indexOf('f'.repeat(64)) < 0);
  assert.strictEqual(h.log.filter((l) => /^Props\.setProperty/.test(l)).length, 2);
  // 鎖拿不到 → busy、不寫
  const hb = harness(SRC, { props: {}, lockOk: false });
  assert.strictEqual(hb.sb.handleDutyChanges_({ action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_setup: { key: NEWKEY, store: 'gf' } }).error, 'busy');
  assert.strictEqual(hb.props.DUTY_PUSH_KEY, undefined);
  // push_setup 走讀取（不記變動、不按門鈴）
  assert.strictEqual(h.sb.dutyFeedIsRead_('duty_changes'), true);
});

/* ══ 7b. 遠端開關門鈴（push_cfg）：主管金鑰＋管理金鑰都外洩也做不了壞事 ══ */
const FIXED = 'https://dzy-gw.dingzhaoyuan888.workers.dev/store/svc/duty-push';   // 設計 2.4（dzy-mini-playbook phase1-design.md 113 行）
const cfgCall = (h, cfg, extra) => h.sb.handleDutyChanges_(Object.assign({ action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_cfg: cfg }, extra || {}));
const setCount = (h) => h.log.filter((l) => /^Props\.setProperty/.test(l)).length;
const KEYED = { DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'mztjs' };

ok('push_cfg 未授權：沒管理金鑰／管理金鑰空白（含空白字元）／管理金鑰錯／主管金鑰錯或沒帶 → unauthorized，零屬性寫入、零屬性讀取、零連外', () => {
  const start = Object.assign({ DUTY_PUSH_URL: '', DUTY_PUSH_DRY: '1' }, KEYED);
  const h = harness(SRC, { props: start });
  const on = { url_on: true, dry: false };
  const rs = [
    cfgCall(h, on, { admin_key: undefined }), cfgCall(h, on, { admin_key: '' }), cfgCall(h, on, { admin_key: '   ' }), cfgCall(h, on, { admin_key: null }),
    cfgCall(h, on, { admin_key: 'WRONG' }), cfgCall(h, on, { mgr_key: 'NOPE' }), cfgCall(h, on, { mgr_key: '' }), cfgCall(h, on, { mgr_key: undefined }),
  ];
  assert.deepStrictEqual(rs.map((r) => J(r)), rs.map(() => ({ ok: false, error: 'unauthorized' })));
  assert.deepStrictEqual(h.props, start);
  assert.strictEqual(setCount(h), 0);
  assert.ok(!h.log.some((l) => /^Props\.|^Lock\.|^UrlFetch/.test(l)), h.log.join(','));
});

ok('push_cfg 格式錯（不是物件、陣列、缺欄位、不是布林）、跟 push_setup 同時帶 → bad_input，零屬性寫入', () => {
  const h = harness(SRC, { props: { DUTY_PUSH_DRY: '1' } });
  [null, 'on', 1, true, [], [true, true], {}, { url_on: true }, { dry: true }, { url_on: 'true', dry: true }, { url_on: true, dry: 1 }, { url_on: 1, dry: 0 }]
    .forEach((c) => assert.strictEqual(cfgCall(h, c).error, 'bad_input', JSON.stringify(c)));
  const both = cfgCall(h, { url_on: true, dry: true }, { push_setup: { key: NEWKEY, store: 'gf' } });
  assert.strictEqual(both.error, 'bad_input');
  assert.deepStrictEqual(h.props, { DUTY_PUSH_DRY: '1' });
  assert.strictEqual(setCount(h), 0);
});

ok('呼叫端塞網址（push_cfg.url／最外層 url／DUTY_PUSH_URL 欄位）一律無效：寫入的永遠是寫死的常數；回應不含任何網址', () => {
  const evil = 'https://evil.example/steal';
  const h = harness(SRC, { props: {} });
  const r = cfgCall(h, { url_on: true, dry: true, url: evil, URL: evil, DUTY_PUSH_URL: evil, href: evil }, { url: evil, DUTY_PUSH_URL: evil, push_url: evil });
  assert.deepStrictEqual(J(r), { ok: true, push_cfg: { url_on: true, dry: true, key_set: false, store: '' } });
  assert.strictEqual(h.props.DUTY_PUSH_URL, FIXED);
  assert.strictEqual(h.sb.DUTY_PUSH_FIXED_URL_, FIXED);
  assert.ok(JSON.stringify(r).indexOf('http') < 0);
  // 之前已被手動設成別的網址 → url_on:true 也會蓋回常數
  const h2 = harness(SRC, { props: Object.assign({ DUTY_PUSH_URL: evil, DUTY_PUSH_DRY: '1' }, KEYED) });
  cfgCall(h2, { url_on: true, dry: false, url: evil });
  assert.strictEqual(h2.props.DUTY_PUSH_URL, FIXED);
  h2.write(W, { ok: true });
  assert.deepStrictEqual(h2.fetches.map((f) => f.url), [FIXED]);
});

ok('url_on:true＋dry:true（只計數）：沒金鑰也成功；之後寫入只計數、0 次連外；ping 回 dry；push_stats mode dry', () => {
  const h = harness(SRC, { props: {} });
  const r = cfgCall(h, { url_on: true, dry: true });
  assert.deepStrictEqual(J(r), { ok: true, push_cfg: { url_on: true, dry: true, key_set: false, store: '' } });
  assert.deepStrictEqual(h.props, { DUTY_PUSH_DRY: '1', DUTY_PUSH_URL: FIXED });
  assert.strictEqual(setCount(h), 2);
  h.write(W, { ok: true }); h.write({ action: 'clock' }, { ok: true });
  assert.strictEqual(h.fetches.length, 0);
  assert.strictEqual(h.stats().dry, 2);
  assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'dry');
  const p = h.changes({ push_stats: true }).push;
  assert.deepStrictEqual([p.on, p.mode, p.key_set], [true, 'dry', false]);
  assert.strictEqual(h.fetches.length, 0);
  assert.ok(!h.log.some((l) => /^UrlFetch|computeHmac/.test(l)));
});

ok('聯鎖：url_on:true＋dry:false 在沒金鑰、金鑰太短、沒店代碼、店代碼格式錯時 → need_key，屬性一格都不動、零寫入、之後寫入照樣只計數', () => {
  const base = { DUTY_PUSH_URL: FIXED, DUTY_PUSH_DRY: '1' };
  [{}, { DUTY_PUSH_KEY: 'short', DUTY_PUSH_STORE: 'mztjs' }, { DUTY_PUSH_KEY: KEY }, { DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: '' },
   { DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: 'MZT JS' }, { DUTY_PUSH_STORE: 'mztjs' }].forEach((extra) => {
    [base, { DUTY_PUSH_URL: '', DUTY_PUSH_DRY: '0' }, {}].forEach((b) => {
      const start = Object.assign({}, b, extra);
      const h = harness(SRC, { props: start });
      const r = cfgCall(h, { url_on: true, dry: false });
      assert.deepStrictEqual(J(r), { ok: false, error: 'need_key' }, JSON.stringify(start));
      assert.deepStrictEqual(h.props, start);
      assert.strictEqual(setCount(h), 0);
      h.write(W, { ok: true });
      assert.strictEqual(h.fetches.length, 0, JSON.stringify(start));
    });
  });
});

ok('有金鑰＋店代碼：url_on:true＋dry:false 成功（DRY=0、網址＝常數）；之後寫入真的推到常數網址、用原金鑰簽；回應不含金鑰', () => {
  const h = harness(SRC, { props: Object.assign({}, KEYED) });
  const r = cfgCall(h, { url_on: true, dry: false });
  assert.deepStrictEqual(J(r), { ok: true, push_cfg: { url_on: true, dry: false, key_set: true, store: 'mztjs' } });
  assert.deepStrictEqual(h.props, Object.assign({ DUTY_PUSH_DRY: '0', DUTY_PUSH_URL: FIXED }, KEYED));
  h.write(W, { ok: true });
  assert.strictEqual(h.fetches.length, 1);
  assert.strictEqual(h.fetches[0].url, FIXED);
  const p = JSON.parse(h.fetches[0].opt.payload);
  assert.strictEqual(p.sig, crypto.createHmac('sha256', KEY).update([p.v, p.s, p.t, p.n, p.a, p.d.join(','), '', ''].join('|')).digest('hex'));
  assert.ok(JSON.stringify(r).indexOf(KEY) < 0);
  // 開、改成只計數、關都不碰金鑰與店代碼
  cfgCall(h, { url_on: true, dry: true }); cfgCall(h, { url_on: false, dry: true });
  assert.deepStrictEqual([h.props.DUTY_PUSH_KEY, h.props.DUTY_PUSH_STORE], [KEY, 'mztjs']);
  assert.ok(!h.log.some((l) => /^Props\.setProperty:DUTY_PUSH_(KEY|STORE)/.test(l)));
});

ok('url_on:false（遠端關閉）：網址設成空字串；之後寫入 0 連外、不計數，每次寫入只多「讀 DUTY_PUSH_URL」1 次（跟 origin/main 只差這一次）；push_stats on:false', () => {
  [Object.assign({ DUTY_PUSH_URL: FIXED, DUTY_PUSH_DRY: '0' }, KEYED), { DUTY_PUSH_URL: FIXED, DUTY_PUSH_DRY: '1' }, {}].forEach((start) => {
    [true, false].forEach((dry) => {
      const h = harness(SRC, { props: start });
      const r = cfgCall(h, { url_on: false, dry });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(J(r.push_cfg), { url_on: false, dry, key_set: !!start.DUTY_PUSH_KEY, store: start.DUTY_PUSH_STORE || '' });
      assert.strictEqual(h.props.DUTY_PUSH_URL, '');
      assert.strictEqual(h.props.DUTY_PUSH_DRY, dry ? '1' : '0');
      const stBefore = JSON.stringify(h.stats());
      const old = harness(OLD, { props: h.props });
      for (let i = 0; i < 3; i++) {
        const n0 = h.log.length, o0 = old.log.length;
        h.write(W, { ok: true }); old.write(W, { ok: true });
        const s = stripUrlRead(h.log.slice(n0));
        assert.strictEqual(s.extra, 1);
        assert.deepStrictEqual(s.log, old.log.slice(o0));
        assert.strictEqual(h.log.slice(n0).filter((l) => /^Props\.getProperty/.test(l)).length, 1);
      }
      assert.strictEqual(h.fetches.length, 0);
      assert.strictEqual(JSON.stringify(h.stats()), stBefore);
      assert.deepStrictEqual(J(h.changes({ push_stats: true }).push), { on: false });
      assert.strictEqual(h.changes({ ping: 'nonce_ABC_123' }).ping, 'disabled');
      assert.strictEqual(h.fetches.length, 0);
    });
  });
});

ok('可重複呼叫、寫入順序：關＝先清網址再寫 DRY；開＝先寫 DRY 再寫網址；只 setProperty 這兩格、從不 deleteProperty', () => {
  const h = harness(SRC, { props: Object.assign({}, KEYED) });
  const seq = [];
  const run = (c) => { const n0 = h.log.length; const r = cfgCall(h, c); seq.push(h.log.slice(n0).filter((l) => /^Props\.setProperty/.test(l))); return J(r); };
  const a = run({ url_on: true, dry: true }), b = run({ url_on: true, dry: true });
  assert.deepStrictEqual(a, b);
  run({ url_on: true, dry: false }); run({ url_on: false, dry: true }); run({ url_on: false, dry: true }); run({ url_on: true, dry: true });
  const ON = ['Props.setProperty:DUTY_PUSH_DRY', 'Props.setProperty:DUTY_PUSH_URL'], OFF = ['Props.setProperty:DUTY_PUSH_URL', 'Props.setProperty:DUTY_PUSH_DRY'];
  assert.deepStrictEqual(seq, [ON, ON, ON, OFF, OFF, ON]);
  assert.deepStrictEqual(h.props, Object.assign({ DUTY_PUSH_DRY: '1', DUTY_PUSH_URL: FIXED }, KEYED));
  assert.ok(!h.log.some((l) => /deleteProperty|getProperties/.test(l)));
  // 每次都在鎖裡寫、而且有放鎖
  assert.strictEqual(h.log.filter((l) => l === 'Lock.tryLock').length, 6);
  assert.strictEqual(h.log.filter((l) => l === 'Lock.releaseLock').length, 6);
  // 鎖拿不到 → busy、不寫
  const hb = harness(SRC, { props: {}, lockOk: false });
  assert.deepStrictEqual(J(cfgCall(hb, { url_on: true, dry: true })), { ok: false, error: 'busy' });
  assert.deepStrictEqual(hb.props, {}); assert.strictEqual(setCount(hb), 0);
});

ok('push_cfg 本身不記變動、不按門鈴；回應與 log 全文不含金鑰記號值；回應 key 只有 ok／push_cfg（url_on、dry、key_set、store）', () => {
  const SECRET = 'MARKPUSHKEY_' + 'z'.repeat(40);
  const h = harness(SRC, { props: { DUTY_PUSH_KEY: SECRET, DUTY_PUSH_STORE: 'mztjs', DUTY_PUSH_URL: FIXED, DUTY_PUSH_DRY: '0' } });
  const outs = [cfgCall(h, { url_on: true, dry: false }), cfgCall(h, { url_on: true, dry: true }), cfgCall(h, { url_on: false, dry: true }),
                cfgCall(h, { url_on: true, dry: false }, { admin_key: 'WRONG' }), cfgCall(h, 'x')];
  assert.strictEqual(h.fetches.length, 0);
  assert.ok(!h.log.some((l) => /^Cache\.put/.test(l)), '設定本身不該寫暫存區（不記變動、不計數）');
  const all = JSON.stringify(outs) + h.logs.join('\n') + h.log.join('\n');
  assert.ok(all.indexOf(SECRET) < 0 && all.indexOf('MARKPUSHKEY') < 0);
  outs.filter((r) => r.ok).forEach((r) => {
    assert.deepStrictEqual(Object.keys(r), ['ok', 'push_cfg']);
    assert.deepStrictEqual(Object.keys(r.push_cfg), ['url_on', 'dry', 'key_set', 'store']);
  });
});

ok('沒帶 push_cfg：duty_changes 回應 key 集合與服務呼叫序列跟 origin/main 相同（push_cfg:undefined 也一樣）', () => {
  [{}, LIVE, { DUTY_PUSH_URL: FIXED, DUTY_PUSH_DRY: '1' }].forEach((props) => {
    const a = harness(OLD, { props }), b = harness(SRC, { props }), c = harness(SRC, { props });
    const ra = a.changes({ since: T0 - 1000 }), rb = b.changes({ since: T0 - 1000 }), rc = c.changes({ since: T0 - 1000, push_cfg: undefined });
    assert.deepStrictEqual(Object.keys(rb), ['ok', 'now', 'since', 'reset', 'changes']);
    assert.strictEqual(JSON.stringify(rb), JSON.stringify(ra)); assert.strictEqual(JSON.stringify(rc), JSON.stringify(ra));
    assert.deepStrictEqual(b.log, a.log); assert.deepStrictEqual(c.log, a.log);
  });
});

/* ══ 8. 走真 doPost（gs-sandbox 載入 Code／Liff／Rest／Requests／DutyFeed）══ */
const { make } = require('./helpers/gs-sandbox');
const post = (m, b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
function snapSheets(bk) { const o = {}; Object.keys(bk.sh).forEach((k) => { o[k] = JSON.stringify(bk.sh[k].values); }); return JSON.stringify(o); }
function world(props, fetchFn) {
  const m = make({ now: Date.parse('2026-11-10T10:00:00+08:00'), props: Object.assign({ REQ_CARD_REASON_FROM: 'off' }, props || {}),
    fetch: fetchFn, self: {
      roster: [{ emp_id: 'E01', name: 'MARKNAME一', key: 'MARKRKEY1', active: 'TRUE', line_user_id: 'MARKLINE1' }, { emp_id: 'E02', name: 'MARKNAME二', key: 'MARKRKEY2', active: 'TRUE' }],
      events: [['2026-11-09T09:00:00', 'E01', 'in'], ['2026-11-09T17:00:00', 'E01', 'out'], ['2026-11-08T10:00:00', 'E02', 'in', 'ok', 'MARKDEV'], ['2026-09-30T10:00:00', 'E02', 'in']],
      approved: [['2026-11-08', 'E02', 'MARKNAME二', '[{"start":"10:00","end":"18:00"}]', 8, 'MARKSTATUS', 'MARKMGR', '2026-11-08T20:00:00+08:00', '', '']],
      leave: [['2026-11-07', 'MARKNAME一', '特休', 8]],
    } });
  let u = 0; m.sb.Utilities.getUuid = () => ('0000000' + (u++)).slice(-8) + '-1111-2222-3333-444455556666';
  const rq = m.self.insertSheet('requests');
  // 待審單是 E02 的（2026-11-20 起核定的人那天有待審單會被擋 pending_request；這張只用來驗推送不帶申請內容）
  rq.values.push(['id', 'date', 'emp_id', 'type', 'reason', 'status'], ['r1', '2026-11-09', 'E02', 'leave', 'MARKREQREASON', 'pending']);
  return m;
}
const APPROVE = { action: 'mgr_approve', mgr_key: 'AK', acting_name: 'MARKACT（DZY001）', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] };

ok('doPost 端到端：正式推送開著時，核定的回應與沒開時完全一樣；推送內容不含姓名、員編、金鑰；試算表內容一樣', () => {
  const pushes = [];
  const fetchFn = (url, o) => { if (url === URL_) { pushes.push(o); return { ok: true }; } return undefined; };
  const a = world({}), b = world(LIVE, fetchFn);
  const ra = post(a, APPROVE), rb = post(b, APPROVE);
  assert.strictEqual(JSON.stringify(rb), JSON.stringify(ra));
  assert.strictEqual(ra.ok, true);
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(a.sb.__fetches.length, 0);
  const txt = pushes[0].payload;
  assert.ok(!/MARK|E01|"AK"/.test(txt), txt);
  assert.strictEqual(snapSheets(b.self), snapSheets(a.self));
  // 唯讀 doPost 不推
  post(b, { action: 'mgr_day', mgr_key: 'AK', date: '2026-11-09' });
  assert.strictEqual(pushes.length, 1);
});

ok('doPost 端到端：只計數模式下核定 → 0 次連外、dry 計數 1；push_stats 回 mode dry', () => {
  const m = world({ DUTY_PUSH_URL: URL_, DUTY_PUSH_DRY: '1' });
  assert.strictEqual(post(m, APPROVE).ok, true);
  assert.strictEqual(m.sb.__fetches.length, 0);
  const p = post(m, { action: 'duty_changes', mgr_key: 'AK', since: m.sb.Date.now() - 60000, push_stats: true }).push;
  assert.deepStrictEqual([p.on, p.mode, p.dry, p.sent], [true, 'dry', 1, 0]);
});

ok('digest:true：每分頁每天一個 16 碼雜湊＋列數；範圍上個月 1 號～今天；回應全文沒有任何儲存格記號值；不寫試算表', () => {
  const m = world({});
  const before = snapSheets(m.self);
  const r = post(m, { action: 'duty_changes', mgr_key: 'AK', since: m.sb.Date.now() - 60000, digest: true });
  const d = r.digest;
  assert.deepStrictEqual([d.from, d.to], ['2026-10-01', '2026-11-10']);
  assert.deepStrictEqual(Object.keys(d), ['from', 'to', 'events', 'approved', 'leave', 'requests', 'roster', 'managers']);
  assert.deepStrictEqual(Object.keys(d.events.days), ['2026-11-08', '2026-11-09']);   // 9/30 在範圍外
  assert.strictEqual(d.events.rows, 4);
  assert.deepStrictEqual([Object.keys(d.approved.days), Object.keys(d.leave.days), Object.keys(d.requests.days)], [['2026-11-08'], ['2026-11-07'], ['2026-11-09']]);
  assert.deepStrictEqual([d.roster.rows, d.managers.rows], [2, 2]);
  [d.events.days['2026-11-09'], d.roster.all, d.managers.all].forEach((x) => assert.ok(/^[A-Za-z0-9_-]{16}$/.test(x)));
  const txt = JSON.stringify(r);
  assert.ok(!/MARK|特休|E01|E02|"AK"|"MK"|10:00|2026-11-08T/.test(txt.replace(/"2026-11-0\d"/g, '')), txt);
  assert.deepStrictEqual(r.push, { on: false });
  assert.strictEqual(snapSheets(m.self), before);
});

ok('digest：managers／roster 的金鑰欄改了 → 雜湊不變；其他欄改了 → 變；某天打卡變了只有那天的雜湊變', () => {
  const m = world({});
  const dg = () => post(m, { action: 'duty_changes', mgr_key: 'AK', since: m.sb.Date.now() - 60000, digest: true }).digest;
  const d0 = dg();
  m.self.sh.managers.values[1][1] = 'MK-ROTATED';                    // 值班主管換鑰匙（AK 那列不動，才驗得過）
  m.self.sh.roster.values[1][2] = 'MARKRKEY1-NEW';                   // 同仁金鑰
  const d1 = dg();
  assert.deepStrictEqual([d1.managers.all, d1.roster.all], [d0.managers.all, d0.roster.all]);
  m.self.sh.managers.values[1][0] = '值班主管改名';
  m.self.sh.roster.values[2][12] = 'MARKLINE2';                      // E02 綁了 LINE
  const d2 = dg();
  assert.notStrictEqual(d2.managers.all, d0.managers.all); assert.notStrictEqual(d2.roster.all, d0.roster.all);
  m.self.sh.events.values.push(['2026-11-09T12:00:00+08:00', 'E02', 'out', 24.78, 121.01, 5, true, 'D1', true, 'ok', 10]);
  const d3 = dg();
  assert.notStrictEqual(d3.events.days['2026-11-09'], d0.events.days['2026-11-09']);
  assert.strictEqual(d3.events.days['2026-11-08'], d0.events.days['2026-11-08']);
  assert.strictEqual(d3.events.rows, d0.events.rows + 1);
  m.self.sh.events.values[4][2] = 'out';                             // 範圍外（9/30）改了：每天的雜湊都不變
  const d4 = dg();
  assert.deepStrictEqual(d4.events.days, d3.events.days);
  // 日期是 Date 物件（試算表自動轉型）也歸到台北那一天
  m.self.sh.approved.values[1][0] = new m.sb.Date('2026-11-08T00:00:00+08:00');   // 同一個執行環境的 Date（正式環境儲存格的 Date 也是）
  assert.deepStrictEqual(Object.keys(dg().approved.days), ['2026-11-08']);
});

ok('digest：分頁不見、沒有日期欄 → 只回 missing／error，不丟例外、其他分頁照算', () => {
  const m = world({});
  delete m.self.sh.leave;
  m.self.sh.requests.values[0][1] = '日子';
  const d = post(m, { action: 'duty_changes', mgr_key: 'AK', since: m.sb.Date.now() - 60000, digest: true }).digest;
  assert.deepStrictEqual(d.leave, { rows: 0, missing: true });
  assert.deepStrictEqual(d.requests, { rows: 1, error: 'no_date_col' });
  assert.ok(d.events.days['2026-11-09']);
});

ok('doPost 端到端：push_setup 走真 checkAdmin（ADM）；回應不含金鑰；之後正式推送用這把金鑰簽', () => {
  const pushes = [];
  const m = world({ DUTY_PUSH_URL: URL_ }, (url, o) => { if (url === URL_) { pushes.push(o); return { ok: true }; } return undefined; });
  const logs = []; m.sb.Logger.log = (...a) => logs.push(a.join(' '));
  const r0 = post(m, { action: 'duty_changes', mgr_key: 'AK', push_setup: { key: NEWKEY, store: 'mztjs' } });
  const r1 = post(m, { action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_setup: { key: NEWKEY, store: 'mztjs' } });
  const r2 = post(m, { action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_setup: { key: 'e'.repeat(64), store: 'gf' } });
  assert.deepStrictEqual([r0.error, r1.push_setup, r2.error], ['unauthorized', 'set', 'already_set']);
  assert.ok((JSON.stringify([r0, r1, r2]) + logs.join('')).indexOf(NEWKEY) < 0);
  assert.strictEqual(pushes.length, 0, '設金鑰本身不該按門鈴');
  post(m, APPROVE);
  assert.strictEqual(pushes.length, 1);
  const p = JSON.parse(pushes[0].payload);
  assert.strictEqual(p.s, 'mztjs');
  assert.strictEqual(p.sig, crypto.createHmac('sha256', NEWKEY).update([p.v, p.s, p.t, p.n, p.a, p.d.join(','), '', ''].join('|')).digest('hex'));
});

ok('doPost 端到端：push_cfg 走真 checkAdmin；ADMIN_KEY 沒設時空白對空白也拒絕；只計數可開、真的連外要先 push_setup；之後核定推到常數網址', () => {
  const pushes = [];
  const m = world({}, (url, o) => { if (url === FIXED) { pushes.push(o); return { ok: true }; } return undefined; });
  const C = (extra) => post(m, Object.assign({ action: 'duty_changes', mgr_key: 'AK', push_cfg: { url_on: true, dry: false } }, extra));
  assert.deepStrictEqual([C({}).error, C({ admin_key: '' }).error, C({ admin_key: 'WRONG' }).error], ['unauthorized', 'unauthorized', 'unauthorized']);
  assert.strictEqual(C({ admin_key: 'ADM' }).error, 'need_key');
  assert.strictEqual(m.props.DUTY_PUSH_URL, undefined);
  assert.strictEqual(C({ admin_key: 'ADM', push_cfg: { url_on: true, dry: true, url: 'https://evil.example' } }).push_cfg.dry, true);
  assert.deepStrictEqual([m.props.DUTY_PUSH_URL, m.props.DUTY_PUSH_DRY], [FIXED, '1']);
  post(m, APPROVE);
  assert.strictEqual(pushes.length + m.sb.__fetches.length, 0);
  post(m, { action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_setup: { key: NEWKEY, store: 'mztjs' } });
  const r = C({ admin_key: 'ADM' });
  assert.deepStrictEqual(r, { ok: true, push_cfg: { url_on: true, dry: false, key_set: true, store: 'mztjs' } });
  post(m, APPROVE);
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(m.sb.__fetches[m.sb.__fetches.length - 1].url, FIXED);
  assert.strictEqual(post(m, { action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', push_cfg: { url_on: false, dry: true } }).ok, true);
  post(m, APPROVE);
  assert.strictEqual(pushes.length, 1, '遠端關閉後不該再推');
  // ADMIN_KEY 沒設（空白）：admin_key 空白也不能過
  const m2 = make({ now: Date.parse('2026-11-10T10:00:00+08:00'), config: { ADMIN_KEY: '' }, self: { roster: [], events: [], approved: [], leave: [] } });
  assert.strictEqual(post(m2, { action: 'duty_changes', mgr_key: 'AK', admin_key: '', push_cfg: { url_on: true, dry: true } }).error, 'unauthorized');
  assert.strictEqual(m2.props.DUTY_PUSH_URL, undefined);
});

/* ══ 9. 原始碼檢查：授權範圍不變、零試算表寫入 ══ */
const SVC = '(?:[A-Z][A-Za-z]*(?:App|Service|Services)|Utilities|Session|Logger|Browser|Maps|Jdbc|XmlService|Charts|Drive|Gmail|Calendar|Sheets|Docs|Slides|People|Tasks|AdminDirectory|YouTube|Analytics|BigQuery|Console)';
const CHAIN_RE = new RegExp('\\b' + SVC + '\\b(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*(?:\\s*\\([^()]*\\))?)*', 'g');
const norm = (c) => { let s = c.replace(/\s+/g, ''), prev; do { prev = s; s = s.replace(/\([^()]*\)/g, ''); } while (s !== prev); return s; };
const chains = (text) => (text.match(CHAIN_RE) || []).map(norm);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const addedLines = () => {
  const diff = execFileSync('git', ['diff', '-U0', BASE, '--', 'apps-script/DutyFeed.gs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  return diff.split('\n').filter((l) => l[0] === '+' && l.indexOf('+++') !== 0).map((l) => l.slice(1));
};
// 九店都部署的檔（mala-gas 每家店都有：程式碼／Liff／Requests／Rest／DutyFeed／Cap10／RelayG／SvcStaff／AttDigest／AttAlert）
const NINE = ['Code.gs', 'Liff.gs', 'Requests.gs', 'Rest.gs', 'DutyFeed.gs', 'Cap10.gs', 'RelayG.gs', 'SvcStaff.gs', 'AttDigest.gs', 'AttAlert.gs'];
const OLD_NINE = NINE.map((f) => ({ f, src: gitShow(BASE, 'apps-script/' + f) || '' }));

ok('比對規則本身抓得到服務鏈與新服務', () => {
  assert.deepStrictEqual(chains('x = PropertiesService.getScriptProperties().getProperty("A");'), ['PropertiesService.getScriptProperties.getProperty']);
  assert.deepStrictEqual(chains('UrlFetchApp.fetch(u, { a: JSON.stringify(p) }); DriveApp.getFiles(); LockService . getScriptLock()'), ['UrlFetchApp.fetch', 'DriveApp.getFiles', 'LockService.getScriptLock']);
});

ok('授權範圍不變：DutyFeed.gs 新增行用到的每一個「服務.方法鏈」，origin/main 九店部署檔裡都已經在用（逐條列出出處）', () => {
  // 決定授權的是「服務.第一個成員」（列舉再多一段，例 Utilities.Charset.UTF_8）；服務回傳物件上的方法（.getAll、.getResponseCode…）由下一項檢查
  const svcKey = (c) => { const seg = c.split('.'); return seg.slice(0, seg[1] && /^[A-Z]/.test(seg[1]) ? 3 : 2).join('.'); };
  const added = stripComments(addedLines().join('\n'));
  const used = Array.from(new Set(chains(added).map(svcKey))).sort();
  assert.ok(used.length > 0);
  const where = {};
  const bad = used.filter((c) => {
    const hit = OLD_NINE.filter((o) => chains(stripComments(o.src)).map(svcKey).indexOf(c) >= 0).map((o) => o.f);
    where[c] = hit;
    return !hit.length;
  });
  console.log('    新增行的服務用法與 origin/main 出處：\n' + used.map((c) => '      ' + c + ' ← ' + where[c].join('、')).join('\n'));
  assert.deepStrictEqual(bad, [], 'origin/main 九店檔都沒在用：' + bad);
  // 服務名稱只能是這幾個（UrlFetchApp 已在九店 程式碼.js／Liff.js 用、授權範圍不變；其餘四個不需授權）
  const names = Array.from(new Set(used.map((c) => c.split('.')[0]))).sort();
  // live-prep 起多 SpreadsheetApp（只有 .flush，九店 程式碼.js／Liff.js 早就在用）
  assert.deepStrictEqual(names.filter((x) => ['CacheService', 'LockService', 'PropertiesService', 'SpreadsheetApp', 'UrlFetchApp', 'Utilities'].indexOf(x) < 0), []);
  assert.deepStrictEqual(used.filter((c) => c.indexOf('SpreadsheetApp') === 0), ['SpreadsheetApp.flush']);
  // 特別記下：HMAC 在 origin/main 的 Liff.gs（九店都有）已在用
  assert.ok(where['Utilities.computeHmacSha256Signature'].indexOf('Liff.gs') >= 0);
  // 整個新檔的服務名稱集合 ⊆ 舊 DutyFeed.gs ∪ 九店檔
  const oldNames = new Set(); OLD_NINE.forEach((o) => chains(stripComments(o.src)).forEach((c) => oldNames.add(c.split('.')[0])));
  assert.deepStrictEqual(Array.from(new Set(chains(stripComments(SRC)).map((c) => c.split('.')[0]))).filter((x) => !oldNames.has(x)), []);
});

ok('新增行呼叫的每一個 .方法( 名稱，origin/main 九店部署檔裡都出現過（服務物件上的方法不會是新的）', () => {
  const added = stripComments(addedLines().join('\n'));
  const own = new Set((SRC.match(/function\s+([A-Za-z_$][\w$]*)/g) || []).map((s) => s.replace(/function\s+/, '')));
  const oldText = OLD_NINE.map((o) => o.src).join('\n');
  const methods = Array.from(new Set((added.match(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g) || []).map((s) => s.replace(/[.\s(]/g, '')))).filter((m) => !own.has(m));
  const bad = methods.filter((m) => oldText.indexOf('.' + m + '(') < 0);
  assert.deepStrictEqual(bad, []);
});

ok('新增行零試算表寫入：沒有 setValue／setValues／appendRow／insertSheet／deleteRow／clear 等；setProperty 只在 dutyPushSetup_（2 次）與 dutyPushCfgSet_（URL、DRY 各 2 次，鍵名寫死）', () => {
  const lines = addedLines();
  const bad = lines.filter((l) => /setValue|setValues|appendRow|insertSheet|insertRow|deleteRow|deleteSheet|clearContents|\.clear\(|setFormula|setNumberFormat|deleteProperty|setProperties|deleteAllProperties|getUserProperties|getDocumentProperties|newBlob|DriveApp|MailApp|GmailApp/.test(l));
  assert.deepStrictEqual(bad, []);
  // live-prep：SpreadsheetApp.flush() 只准一處，在 dutyPushSend_ 的「不是 ping」那一段（只在真的要連外時）
  // （新增行是片段、註解區塊不完整，所以用整支去掉註解後來數）
  const sendBody = stripComments(SRC.slice(SRC.indexOf('function dutyPushSend_'), SRC.indexOf('/** dutyFeedNote_ 記完一筆寫入後呼叫')));
  assert.ok(/if \(!isPing\) \{[^}]*SpreadsheetApp\.flush\(\)/.test(sendBody), 'flush 要在 dutyPushSend_ 的 if (!isPing) 裡');
  assert.strictEqual((stripComments(SRC).match(/SpreadsheetApp\./g) || []).length, 1, '整支只准用 SpreadsheetApp.flush 一次');
  const sp = lines.filter((l) => /setProperty\(/.test(l));
  assert.strictEqual(sp.length, 6);
  const body = SRC.slice(SRC.indexOf('function dutyPushSetup_'), SRC.indexOf('/**', SRC.indexOf('function dutyPushSetup_')));
  assert.strictEqual((body.match(/setProperty\(/g) || []).length, 2);
  // push_cfg：只寫 DUTY_PUSH_URL（值只能是常數或空字串）與 DUTY_PUSH_DRY（'1'／'0'）；不讀呼叫端任何網址欄位
  const cb = stripComments(SRC.slice(SRC.indexOf('function dutyPushCfgSet_'), SRC.indexOf('/* ── 每小時指紋')));
  const sets = cb.match(/setProperty\([^)]*\)/g) || [];
  assert.deepStrictEqual(sets.slice().sort(), ["setProperty('DUTY_PUSH_DRY', dry ? '1' : '0')", "setProperty('DUTY_PUSH_DRY', dry ? '1' : '0')",
    "setProperty('DUTY_PUSH_URL', '')", "setProperty('DUTY_PUSH_URL', DUTY_PUSH_FIXED_URL_)"]);
  assert.ok(!/\bc\.(?!url_on\b|dry\b)\w+|body\.(?!admin_key\b|push_cfg\b)\w+/.test(cb), '只准讀 c.url_on、c.dry、body.admin_key、body.push_cfg');
  assert.strictEqual((stripComments(SRC).match(/DUTY_PUSH_FIXED_URL_\s*=/g) || []).length, 1, '常數只能在一個地方賦值');
  assert.strictEqual((stripComments(SRC).match(/UrlFetchApp\.fetch/g) || []).length, 1, 'UrlFetchApp 只在 dutyPushSend_ 用一次');
});

ok('門鈴那幾個 PR（#181–#184）沒動 DutyFeed.gs 以外的程式檔（apps-script 底下只有 DutyFeed.gs 有差異）', () => {
  // 比對範圍到 #184 合併點（510ded9）為止：之後合併的 #179（Requests.gs，考勤異常「連絡不上」）不是門鈴的改動，不算在這裡
  const END = process.env.DUTY_PUSH_END || '510ded9';
  const files = execFileSync('git', ['diff', '--name-only', BASE + '..' + END, '--', 'apps-script'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.deepStrictEqual(files, ['apps-script/DutyFeed.gs']);
});

console.log('\nduty-push：' + n + ' 項通過、' + nFail + ' 項失敗');
if (nFail) process.exit(1);
