// LINE 打卡快速通道（2026-10-16，~/mala-clock-relay spec v2 §3）：relay_snapshot 給 Mac mini 讀名冊對照與近 48 小時打卡，
// mini 只拿來「預判」這張卡會不會成功，不寫任何東西。守：只認指令碼屬性 RELAY_KEY（未設＝關）、只回必要欄位
// （不含金鑰、裝置碼、座標）、events 只回 48 小時內、已掛進 LIFF_HANDLERS。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-10-16T10:00:00+08:00');
const iso = (hAgo) => new Date(NOW - hAgo * 3600000 + 8 * 3600000).toISOString().replace(/\.\d+Z$/, '+08:00');

function make(opts) {
  opts = opts || {};
  const props = 'relayKey' in opts ? { RELAY_KEY: opts.relayKey } : { RELAY_KEY: 'RK-test-0123456789' };
  const roster = [
    { emp_id: 'T01', name: '測試一', key: 'SECRET1', active: true, device_id: 'dev1', line_user_id: 'Uaaa', line_bound_at: 'x', shift_in: '09:00' },
    { emp_id: 'T02', name: '測試二', key: 'SECRET2', active: 'FALSE', device_id: '', line_user_id: '', line_bound_at: '' },
    { emp_id: '', name: '', key: '', active: '', line_user_id: '' },   // 空白列（試算表常見）
    { name: '缺工號' },
  ];
  const events = [
    { ts: iso(50), emp_id: 'T01', type: 'in', lat: 24.1, lng: 121.1, distance_m: 3, within_range: true, device_id: 'line:Uaaa', device_match: true, status: 'ok', accuracy_m: 9 },
    { ts: iso(30), emp_id: 'T01', type: 'out', lat: 24.1, lng: 121.1, distance_m: 3, within_range: true, device_id: 'line:Uaaa', device_match: true, status: 'ok', accuracy_m: 9 },
    { ts: iso(1), emp_id: 'T01', type: 'in', lat: 24.1, lng: 121.1, distance_m: 900, within_range: false, device_id: 'line:Uaaa', device_match: true, status: 'rejected_out_of_range', accuracy_m: 9 },
  ];
  const sinceSeen = [];
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12, ADMIN_KEY: 'ADM' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    getSS: () => ({ getSheetByName: (nm) => (nm === 'roster' || nm === 'events') ? { name: nm } : null }),
    readSheetAsObjects: (sh) => ({ headers: [], rows: (sh.name === 'roster' ? roster : events).map(r => Object.assign({}, r)) }),
    readEventsSince: (sh, sinceMs) => { sinceSeen.push(sinceMs); return { headers: ['ts'], rows: events.map(r => Object.assign({}, r)) }; },
    normCellTs: (v) => String(v),
    Utilities: { computeHmacSha256Signature: (msg, key) => Array.from(require('crypto').createHmac('sha256', key).update(msg).digest()).map(b => b > 127 ? b - 256 : b) },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), sb);
  return { sb, sinceSeen, call: (b) => sb.LIFF_HANDLERS.relay_snapshot(Object.assign({ action: 'relay_snapshot' }, b)) };
}

ok('已掛進 LIFF_HANDLERS', () => {
  assert.strictEqual(typeof make().sb.LIFF_HANDLERS.relay_snapshot, 'function');
});
ok('金鑰不符 → unauthorized，不讀任何表', () => {
  const t = make();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.call({ relay_key: 'wrong' }))), { ok: false, error: 'unauthorized' });
  assert.strictEqual(t.sinceSeen.length, 0);
});
ok('沒帶金鑰 → unauthorized', () => {
  assert.strictEqual(make().call({}).error, 'unauthorized');
});
ok('指令碼屬性沒設 RELAY_KEY（＝功能關閉）→ 任何金鑰都 unauthorized，連空字串也不行', () => {
  const t = make({ relayKey: undefined });
  assert.strictEqual(t.call({ relay_key: '' }).error, 'unauthorized');
  assert.strictEqual(t.call({ relay_key: 'undefined' }).error, 'unauthorized');
  const t2 = make({ relayKey: '' });
  assert.strictEqual(t2.call({ relay_key: '' }).error, 'unauthorized');
});
ok('太短的 RELAY_KEY 視為沒設（避免設成好猜的值）', () => {
  const t = make({ relayKey: 'abc' });
  assert.strictEqual(t.call({ relay_key: 'abc' }).error, 'unauthorized');
});
const hmacHex = (msg) => require('crypto').createHmac('sha256', 'RK-test-0123456789').update(msg).digest('hex');
ok('成功：名冊只回 emp_id／name／active／line_uid_h，active 一律布林；沒工號的列不回（審查 P1 #3）', () => {
  const r = make().call({ relay_key: 'RK-test-0123456789' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.roster)), [
    { emp_id: 'T01', name: '測試一', active: true, line_uid_h: hmacHex('Uaaa') },
    { emp_id: 'T02', name: '測試二', active: false, line_uid_h: '' },
  ]);
});
ok('LINE 帳號只回 HMAC-SHA256(RELAY_KEY, line_user_id) 小寫十六進位，原文不回（審查 P1 #4）', () => {
  const s = JSON.stringify(make().call({ relay_key: 'RK-test-0123456789' }));
  assert.ok(s.indexOf('Uaaa') < 0 && s.indexOf('line_user_id') < 0);
  assert.ok(/"line_uid_h":"[0-9a-f]{64}"/.test(s));
});
ok('成功：events 只回 ts／emp_id／type／status，48 小時外的不回', () => {
  const r = make().call({ relay_key: 'RK-test-0123456789' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.events)), [
    { ts: iso(30), emp_id: 'T01', type: 'out', status: 'ok' },
    { ts: iso(1), emp_id: 'T01', type: 'in', status: 'rejected_out_of_range' },
  ]);
});
ok('輸出整包不含金鑰、裝置碼、座標', () => {
  const s = JSON.stringify(make().call({ relay_key: 'RK-test-0123456789' }));
  ['SECRET1', 'SECRET2', 'dev1', 'line:Uaaa', '24.1', '121.1', 'distance_m', 'device', 'lat', 'lng', 'key"'].forEach(w => assert.ok(s.indexOf(w) < 0, '不該出現 ' + w));
});
ok('events 只讀尾端（readEventsSince，從 48 小時＋1 小時前開始）', () => {
  const t = make(); t.call({ relay_key: 'RK-test-0123456789' });
  assert.deepStrictEqual(t.sinceSeen, [NOW - 49 * 3600000]);
});
ok('回 now（台北時間字串），mini 拿來判斷副本新不新', () => {
  const r = make().call({ relay_key: 'RK-test-0123456789' });
  assert.strictEqual(r.now, '2026-10-16T10:00:00+08:00');
});

console.log('\nrelay-snapshot: ' + n + ' 項通過');

// ── relay_setup（2026-10-16，P5）：一次性設定 RELAY_KEY 並取回（連同 QR_SECRET），給 Mac mini 的設定檔用。
// 守：只認管理金鑰；RELAY_KEY 已設（≥16 字）就拒絕、不回任何金鑰；產生的金鑰 ≥32 字；設好後 relay_snapshot 用得了。
function makeSetup(opts) {
  opts = opts || {};
  const props = Object.assign({}, opts.props || {});
  let uuidN = 0;
  const sb = {
    console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array,
    CONFIG: { ADMIN_KEY: 'ADM-test' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    Utilities: { getUuid: () => '11111111-2222-3333-4444-' + String(++uuidN).padStart(12, '0') },
    checkAdmin: (b) => b.admin_key === (opts.adminKey === undefined ? 'ADM-test' : opts.adminKey),
    LockService: { getScriptLock: () => ({ tryLock: () => opts.lockOk !== false, releaseLock: () => {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), sb);
  return { sb, props, call: (b) => sb.LIFF_HANDLERS.relay_setup(Object.assign({ action: 'relay_setup' }, b)) };
}
ok('relay_setup：已掛進 LIFF_HANDLERS', () => { assert.strictEqual(typeof makeSetup().sb.LIFF_HANDLERS.relay_setup, 'function'); });
ok('relay_setup：管理金鑰不對 → unauthorized，不設任何東西', () => {
  const t = makeSetup(); assert.strictEqual(t.call({ admin_key: 'x' }).error, 'unauthorized'); assert.ok(!('RELAY_KEY' in t.props));
});
ok('relay_setup：第一次 → 設好並只回 relay_key（≥32 字、無連字號），不回 QR_SECRET', () => {
  const t = makeSetup({ props: { QR_SECRET: 'qr-existing' } }); const r = t.call({ admin_key: 'ADM-test' });
  assert.strictEqual(r.ok, true); assert.ok(/^[0-9a-f]{32,}$/.test(r.relay_key), r.relay_key);
  assert.strictEqual(t.props.RELAY_KEY, r.relay_key);
  assert.ok(JSON.stringify(r).indexOf('qr') < 0, '不該回任何 QR 欄位');
});
ok('relay_setup：ADMIN_KEY 留空時，空字串管理金鑰也不過', () => {
  const t = makeSetup({ adminKey: '' }); assert.strictEqual(t.call({ admin_key: '' }).error, 'unauthorized'); assert.ok(!('RELAY_KEY' in t.props));
});
ok('relay_setup：搶不到鎖 → busy，不設', () => {
  const t = makeSetup({ lockOk: false }); assert.strictEqual(t.call({ admin_key: 'ADM-test' }).error, 'busy'); assert.ok(!('RELAY_KEY' in t.props));
});
ok('relay_setup：已設過 → already_set，不回金鑰、不改值（只能用一次）', () => {
  const t = makeSetup({ props: { RELAY_KEY: 'existing-key-0123456789' } }); const r = t.call({ admin_key: 'ADM-test' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'already_set' });
  assert.strictEqual(t.props.RELAY_KEY, 'existing-key-0123456789');
});
ok('relay_setup：舊值太短（<16，等於沒開）→ 視為沒設，可以重設', () => {
  const t = makeSetup({ props: { RELAY_KEY: 'short' } }); const r = t.call({ admin_key: 'ADM-test' });
  assert.strictEqual(r.ok, true); assert.notStrictEqual(t.props.RELAY_KEY, 'short');
});
console.log('relay-setup：完成');
