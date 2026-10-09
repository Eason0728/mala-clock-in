// 方案 C（2026-10-08）：LINE 打卡畫面直接打各店後端 —— Liff.gs 的 liff_status／liff_punch／export_tables。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const SRC = [fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'),
             extract(codeSrc, 'lastCountedEvent'), extract(codeSrc, 'normShiftTime'), extract(codeSrc, 'todayTaipeiStr')].join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const iso = (minAgo) => new Date(NOW - minAgo * 60000 + 8 * 3600000).toISOString().replace(/\.\d+Z$/, '+08:00');

function make(opts) {
  opts = opts || {};
  const clockCalls = [], cache = {}, writes = [];
  const sheets = opts.sheets || {};
  const sheet = (name) => sheets[name] ? { rows: sheets[name], appendRow: () => writes.push(name), getRange: () => { writes.push(name); return { setValue() {}, setValues() {} }; } } : null;
  const clock = { now: NOW };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12, ADMIN_KEY: 'ADM' },
    UrlFetchApp: { fetch: (url, o) => {
      const t = o.payload.id_token; const good = String(t).indexOf('TOK_') === 0;
      return { getResponseCode: () => good ? 200 : 400, getContentText: () => JSON.stringify(good ? { sub: t.slice(4), aud: '2011292256' } : {}) };
    } },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) },
    getSS: () => ({ getSheetByName: sheet }),
    readSheetAsObjects: (sh) => ({ rows: sh.rows.map((r, i) => Object.assign({ __rowIndex: i + 2 }, r)) }),
    normCellTs: (v) => v,
    checkAdmin: (b) => b.admin_key === (opts.adminKey === undefined ? 'ADM' : opts.adminKey),   // 與 Code.gs checkAdmin 同：比對 CONFIG.ADMIN_KEY
    handleClock: (b) => { clockCalls.push(b); if (opts.onClock) opts.onClock(); return opts.clockReply ? opts.clockReply(b) : { ok: true, status: 'ok', ts: iso(0) }; },
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, computeDigest: (a, t) => [...require('crypto').createHash('md5').update(t).digest()], base64Encode: (b) => Buffer.from(b).toString('base64'), formatDate: (d, tz, f) => {
      const s = new Date(d.getTime() + 8 * 3600000).toISOString();
      return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19) + '+08:00';
    } },
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  return { sb, clockCalls, cache, writes, clock, H: sb.LIFF_HANDLERS };
}
const R = (extra) => Object.assign({ emp_id: 'E1', name: '甲', key: 'k1', active: 'true', line_user_id: 'U1', device_id: 'DEV-SAFARI', shift_in: '09:00', shift_out: '18:00' }, extra || {});
const EV = (minAgo, type, status, emp) => ({ emp_id: emp || 'E1', ts: iso(minAgo), type, status: status || 'ok' });
const J = (x) => JSON.parse(JSON.stringify(x));

// ── liff_status ──
ok('status：沒綁定 → not_bound（畫面改問光復走綁定）', () => {
  const { H } = make({ sheets: { roster: [R({ line_user_id: '' })], events: [] } });
  assert.deepStrictEqual(J(H.liff_status({ id_token: 'TOK_U1' })), { ok: false, error: 'not_bound' });
});
ok('status：假 token → invalid_id_token', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] } });
  assert.strictEqual(H.liff_status({ id_token: 'bad' }).error, 'invalid_id_token');
});
ok('status：一個 LINE 綁兩位在職 → line_identity_conflict', () => {
  const { H } = make({ sheets: { roster: [R(), R({ emp_id: 'E2', key: 'k2' })], events: [] } });
  assert.strictEqual(H.liff_status({ id_token: 'TOK_U1' }).error, 'line_identity_conflict');
});
ok('status：姓名、班別、今天的卡、guard（上班 3 分鐘前 → 擋上班、下班鎖到 7 分鐘後）', () => {
  const { H } = make({ sheets: { roster: [R()], events: [EV(3, 'in'), EV(2, 'in', 'rejected_duplicate'), EV(5, 'in', 'ok', 'E9'), EV(60 * 24, 'out')] } });
  const r = J(H.liff_status({ id_token: 'TOK_U1' }));
  assert.strictEqual(r.status, 'ready'); assert.strictEqual(r.name, '甲');
  assert.strictEqual(r.shift_in, '09:00'); assert.strictEqual(r.shift_out, '18:00');
  assert.deepStrictEqual(r.today.map(t => t.type + t.status), ['inok', 'inrejected_duplicate']);
  assert.strictEqual(r.guard.blocked, 'in');
  assert.strictEqual(r.guard.lock.out, NOW - 3 * 60000 + 10 * 60000);
  assert.strictEqual(r.guard.now, NOW);
  assert.ok(!('key' in r) && JSON.stringify(r).indexOf('k1') < 0, '不可回傳打卡金鑰');
});
ok('status：每分鐘 30 次節流', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] } });
  for (let i = 0; i < 30; i++) assert.ok(H.liff_status({ id_token: 'TOK_U1' }).ok);
  assert.strictEqual(H.liff_status({ id_token: 'TOK_U1' }).error, 'too_many');
});

// ── liff_punch ──
ok('punch：成功 → 呼叫 handleClock 帶本人 key、名冊裝置碼、座標；回 ts 與問候語', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [] } });
  const r = J(H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 24.1, lng: 121.2, accuracy: 12 }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.type, 'in'); assert.strictEqual(r.ts, iso(0));
  assert.ok(r.greeting.indexOf('早安') === 0, r.greeting);
  assert.deepStrictEqual(J(clockCalls), [{ key: 'k1', type: 'in', lat: 24.1, lng: 121.2, accuracy: 12, device_id: 'DEV-SAFARI' }]);
});
ok('punch：名冊沒綁裝置 → device_id 用 line:<userId>', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R({ device_id: '' })], events: [] } });
  H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 });
  assert.strictEqual(clockCalls[0].device_id, 'line:U1');
  assert.strictEqual(clockCalls[0].accuracy, null);
});
ok('punch：同型擋（伺服器端，不信前端）且不呼叫 handleClock', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(120, 'in')] } });
  const r = H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 });
  assert.strictEqual(r.ok, false); assert.ok(/已經打過上班卡/.test(r.reason), r.reason);
  assert.strictEqual(clockCalls.length, 0);
});
ok('punch：上班後 10 分鐘內按下班 → 擋，說還剩幾分鐘', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(3, 'in')] } });
  const r = H.liff_punch({ id_token: 'TOK_U1', type: 'out', lat: 1, lng: 2 });
  assert.strictEqual(r.ok, false); assert.ok(/7 分鐘內不能打下班卡/.test(r.reason), r.reason);
  assert.strictEqual(clockCalls.length, 0);
});
ok('punch：下班後 10 分鐘內按上班 → 擋（雙向鎖）', () => {
  const { H } = make({ sheets: { roster: [R()], events: [EV(240, 'in'), EV(1, 'out')] } });
  assert.ok(/不能打上班卡/.test(H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }).reason));
});
ok('punch：10 分鐘後可以打另一型', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(11, 'in')] } });
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'out', lat: 1, lng: 2 }).ok, true);
  assert.strictEqual(clockCalls.length, 1);
});
ok('punch：被擋的卡不算數（rejected_* 不觸發防呆）', () => {
  const { H } = make({ sheets: { roster: [R()], events: [EV(2, 'in', 'rejected_out_of_range')] } });
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }).ok, true);
});
ok('punch：店家判定超出範圍 → 白話原因', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] }, clockReply: () => ({ ok: true, status: 'rejected_out_of_range', ts: iso(0) }) });
  const r = H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, '店家判定你不在範圍內'); assert.strictEqual(r.status, 'rejected_out_of_range');
});
ok('punch：新裝置待核准 → 白話原因', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] }, clockReply: () => ({ ok: true, status: 'pending_device_approval' }) });
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }).reason, '這支手機還沒被核准');
});
ok('punch：type 不合法 / 假 token / 沒綁定', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R({ line_user_id: '' })], events: [] } });
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'x' }).error, 'bad_type');
  assert.strictEqual(H.liff_punch({ id_token: 'nope', type: 'in' }).error, 'invalid_id_token');
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'in' }).error, 'not_bound');
  assert.strictEqual(clockCalls.length, 0);
});
ok('punch：每分鐘 10 次節流', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] }, clockReply: () => ({ ok: true, status: 'rejected_out_of_range' }) });
  for (let i = 0; i < 10; i++) assert.ok(!H.liff_punch({ id_token: 'TOK_U1', type: 'in' }).error);
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'in' }).error, 'too_many');
});

// ── 問候語：同一個 ts 一定同一句（打卡畫面與聊天室卡片各算一次）──
ok('greeting：同 ts 同一句、時段正確、不同秒數會換句', () => {
  const { sb } = make();
  const a = sb.liffGreeting_('in', '2026-10-08T08:15:03+08:00');
  assert.strictEqual(a, sb.liffGreeting_('in', '2026-10-08T08:15:03+08:00'));
  assert.ok(a.indexOf('早安') === 0);
  assert.ok(sb.LIFF_GREETINGS.out.evening.indexOf(sb.liffGreeting_('out', '2026-10-08T22:01:00+08:00')) >= 0);
  assert.ok(sb.LIFF_GREETINGS.in.afternoon.indexOf(sb.liffGreeting_('in', '2026-10-08T12:00:00+08:00')) >= 0);
  const seen = new Set(); for (let s = 0; s < 10; s++) seen.add(sb.liffGreeting_('in', '2026-10-08T08:15:0' + s + '+08:00'));
  assert.strictEqual(seen.size, 3);
  assert.strictEqual(sb.liffGreeting_('in', ''), '');
});
ok('greeting：字句與 clock.html CLOCK_GREETINGS 同一份', () => {
  const { sb } = make();
  const html = fs.readFileSync(ROOT + '/clock.html', 'utf8');
  ['in', 'out'].forEach(t => ['morning', 'afternoon', 'evening'].forEach(p => sb.LIFF_GREETINGS[t][p].forEach(s => assert.ok(html.indexOf(s) >= 0, '網頁版沒有：' + s))));
});

// ── export_tables ──
ok('export：錯金鑰 → unauthorized', () => {
  const { H } = make({ sheets: { roster: [R()], events: [] } });
  assert.deepStrictEqual(J(H.export_tables({ admin_key: 'x' })), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(J(H.export_tables({})), { ok: false, error: 'unauthorized' });
});
ok('export：四張表都有；roster 去掉 key／device_id／line_user_id；不寫入；日期轉台北時間字串', () => {
  const d = new Date(Date.parse('2026-10-07T16:00:00Z'));
  const { H, writes } = make({ sheets: { roster: [R()], events: [EV(3, 'in')], approved: [{ date: d, emp_id: 'E1', hours: 8 }], leave: [] } });
  const r = J(H.export_tables({ admin_key: 'ADM' }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.tables).sort(), ['approved', 'events', 'leave', 'roster']);
  assert.deepStrictEqual(Object.keys(r.tables.roster[0]).sort(), ['active', 'emp_id', 'name', 'shift_in', 'shift_out']);
  assert.ok(JSON.stringify(r).indexOf('k1') < 0 && JSON.stringify(r).indexOf('DEV-SAFARI') < 0 && JSON.stringify(r).indexOf('"U1"') < 0);
  assert.strictEqual(r.tables.approved[0].date, '2026-10-08T00:00:00+08:00');
  assert.ok(!('__rowIndex' in r.tables.events[0]));
  assert.strictEqual(writes.length, 0);
});
ok('export：沒有的表回空陣列', () => {
  const { H } = make({ sheets: { roster: [], events: [] } });
  const r = H.export_tables({ admin_key: 'ADM' });
  assert.deepStrictEqual(J(r.tables.leave), []); assert.deepStrictEqual(J(r.tables.approved), []);
});

// ── 舊動作沒被改壞 ──
ok('舊 liff_clock：沒被擋時換成本人 key 呼叫 handleClock', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(30, 'in')] } });
  H.liff_clock({ id_token: 'TOK_U1', type: 'out', device_id: 'D' });
  assert.deepStrictEqual(J(clockCalls), [{ type: 'out', device_id: 'D', key: 'k1' }]);
});
ok('Codex#5 舊 liff_clock 也擋 10 分鐘鎖：上班 1 分鐘後打下班 → 不呼叫 handleClock', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(1, 'in')] } });
  const r = H.liff_clock({ id_token: 'TOK_U1', type: 'out', device_id: 'D' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'guard_blocked'); assert.strictEqual(clockCalls.length, 0);
});
ok('Codex#5 舊 liff_clock 也擋同型：剛打過上班再打上班 → 擋', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [EV(30, 'in')] } });
  const r = H.liff_clock({ id_token: 'TOK_U1', type: 'in', device_id: 'D' });
  assert.strictEqual(r.error, 'guard_blocked'); assert.strictEqual(clockCalls.length, 0);
});
ok('Codex#5 舊 liff_clock 擋 in／out 以外的 type', () => {
  const { H, clockCalls } = make({ sheets: { roster: [R()], events: [] } });
  assert.strictEqual(H.liff_clock({ id_token: 'TOK_U1', type: 'xx' }).error, 'bad_type'); assert.strictEqual(clockCalls.length, 0);
});

// ── 階段 1 審查（mala-clock-mini#1）修正 ──
ok('審查#1 export：events.device_id 不備份（沒綁裝置時是 line:<LINE 帳號>）', () => {
  const { H } = make({ sheets: { roster: [], events: [Object.assign(EV(3, 'in'), { device_id: 'line:Uabc' })] } });
  const r = J(H.export_tables({ admin_key: 'ADM' }));
  assert.ok(!('device_id' in r.tables.events[0])); assert.ok(JSON.stringify(r).indexOf('Uabc') < 0);
});
ok('審查#2 節流是固定窗：被擋後下一分鐘就解，不會因為持續慢慢按而永遠擋住', () => {
  const { H, clock } = make({ sheets: { roster: [R()], events: [] } });
  for (let i = 0; i < 31; i++) H.liff_status({ id_token: 'TOK_U1' });
  assert.strictEqual(H.liff_status({ id_token: 'TOK_U1' }).error, 'too_many');
  clock.now = NOW + 50000; assert.strictEqual(H.liff_status({ id_token: 'TOK_U1' }).error, 'too_many');
  clock.now = NOW + 61000; assert.strictEqual(H.liff_status({ id_token: 'TOK_U1' }).ok, true);
});
ok('審查#3 全站節流在驗身分之前：每分鐘 600 次後連 LINE 都不打', () => {
  let verifies = 0;
  const { H, sb } = make({ sheets: { roster: [R()], events: [] } });
  const orig = sb.UrlFetchApp.fetch; sb.UrlFetchApp.fetch = (u, o) => { verifies++; return orig(u, o); };
  for (let i = 0; i < 600; i++) H.liff_status({ id_token: 'TOK_X' + i });
  const before = verifies;
  assert.strictEqual(H.liff_punch({ id_token: 'TOK_U1', type: 'in' }).error, 'too_many');
  assert.strictEqual(verifies, before);
});
ok('審查#7 上一筆處理中 → 第二筆不進場；處理完會清掉標記', () => {
  let inner = null;
  const env = make({ sheets: { roster: [R()], events: [] }, onClock: () => { inner = env.H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }); } });
  const r = env.H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 });
  assert.strictEqual(r.ok, true); assert.strictEqual(inner.reason, '上一筆還在處理中');
  assert.strictEqual(env.clockCalls.length, 1);
  assert.ok(!Object.keys(env.cache).some(k => k.indexOf('lfp:') === 0), '標記要清掉');
});
ok('審查#10 第一筆還在驗 LINE 身分時，第二筆就被擋（標記在驗身分之前）', () => {
  let inner = null, fired = false;
  const env = make({ sheets: { roster: [R()], events: [] } });
  const orig = env.sb.UrlFetchApp.fetch;
  env.sb.UrlFetchApp.fetch = (u, o) => { if (!fired) { fired = true; inner = env.H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }); } return orig(u, o); };
  assert.strictEqual(env.H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }).ok, true);
  assert.strictEqual(inner.reason, '上一筆還在處理中'); assert.strictEqual(env.clockCalls.length, 1);
});
ok('審查#10 handleClock 丟例外也會清標記；擋下（防呆）也清', () => {
  const env = make({ sheets: { roster: [R()], events: [] }, onClock: () => { throw new Error('boom'); } });
  assert.throws(() => env.H.liff_punch({ id_token: 'TOK_U1', type: 'in', lat: 1, lng: 2 }));
  assert.ok(!Object.keys(env.cache).some(k => k.indexOf('lfp:') === 0));
  const e2 = make({ sheets: { roster: [R()], events: [EV(60, 'in')] } });
  e2.H.liff_punch({ id_token: 'TOK_U1', type: 'in' });
  assert.ok(!Object.keys(e2.cache).some(k => k.indexOf('lfp:') === 0));
});
ok('審查#9 CONFIG.ADMIN_KEY 漏設時，空金鑰也不能匯出', () => {
  const { H } = make({ adminKey: '', sheets: { roster: [R()], events: [] } });
  assert.strictEqual(H.export_tables({}).error, 'unauthorized');
  assert.strictEqual(H.export_tables({ admin_key: '' }).error, 'unauthorized');
});

console.log('\n✅ LINE 直打店家後端 全部正確 (' + n + '/' + n + ')');
