// 2026-11-06 Eason：LINE 打卡成功的機器人回覆卡片提醒還沒開通管理系統的同仁（LineHub.gs）
// 管理系統 Mac mini 每 15 分鐘送 line_hub_dzy_remind_put（{line_h: {e, s}}，用每日同步的服務金鑰）存 CacheService；webhook「打卡」只讀這包。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const crypto = require('crypto');
const SRC = ['Liff.gs', 'SvcStaff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(walk); } })(o); return out; };
const buttons = (card) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'button') out.push(x.action); Object.values(x).forEach(walk); } })((card.contents && card.contents.footer) || {}); return out; };
const MAPKEY = 'm'.repeat(64), SVC = 's'.repeat(40);
// 管理系統那邊的 line_h：各店 svc_roster 用 HMAC-SHA256(LINE_MAP_KEY, userId)（mini jobs.js 也用 node crypto 驗 line_probe）
const lineH = (uid) => crypto.createHmac('sha256', MAPKEY).update(uid, 'utf8').digest('hex');

function make(opts) {
  opts = opts || {};
  const store = {}, props = { STAFF_SVC_KEY: opts.svc === undefined ? SVC : opts.svc, LINE_MAP_KEY: opts.mapKey === undefined ? MAPKEY : opts.mapKey };
  const cache = {
    get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = String(v); }, remove: (k) => { delete store[k]; },
    removeAll: (ks) => ks.forEach((k) => delete store[k]),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
    putAll: (o) => { Object.keys(o).forEach((k) => { store[k] = String(o[k]); }); }
  };
  const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));   // Apps Script 回帶號 byte
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, isNaN, encodeURIComponent, unescape,
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => signed(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (msg, key) => signed(crypto.createHmac('sha256', key).update(String(msg), 'utf8').digest()),
      formatDate: () => '2026-11-06'
    }
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  return { sb, store };
}
const NOW = () => new Date().toISOString();
const body = (map, extra) => Object.assign({ action: 'line_hub_dzy_remind_put', svc_key: SVC, v: 1, at: NOW(), map }, extra || {});
const punch = (extra) => Object.assign({ ok: true, type: 'in', ts: '2026-11-06T08:52:10+08:00', store_name: '墨竹亭新竹金山', greeting: '早安' }, extra || {});

ok('雜湊與管理系統 line_h 同一個算法（SvcStaff.gs svcLineHash_）', () => {
  const { sb } = make();
  assert.strictEqual(sb.svcLineHash_('Uabc123', MAPKEY), lineH('Uabc123'));
});

ok('收包：金鑰錯、版本錯、格式錯一律不收', () => {
  const { sb, store } = make();
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body({}, { svc_key: 'x'.repeat(40) })).error, 'unauthorized');
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body({}, { v: 2 })).error, 'bad_version');
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body([], {})).error, 'bad_input');
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body({ [lineH('U1')]: { e: '王小明', s: 'open' } })).error, 'bad_input', '編號不是 DZY');
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body({ [lineH('U1')]: { e: 'DZY001', s: 'active' } })).error, 'bad_input', '狀態只收 open/wait');
  assert.strictEqual(sb.handleLineHubDzyRemindPut_(body({ ABC: { e: 'DZY001', s: 'open' } })).error, 'bad_input', '鍵要是 64 碼 hex');
  assert.ok(!('lhd:v1' in store), '壞包不寫快取');
  assert.strictEqual(make({ svc: '' }).sb.handleLineHubDzyRemindPut_(body({})).error, 'unauthorized', '沒設 STAFF_SVC_KEY＝全拒');
});

ok('收包後查得到；開通後（下一包沒有他）就查不到', () => {
  const { sb } = make();
  const r = sb.handleLineHubDzyRemindPut_(body({ [lineH('U1')]: { e: 'DZY023', s: 'open' }, [lineH('U2')]: { e: 'DZY024', s: 'wait' } }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, people: 2 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.lineHubDzyRemindFor_('U1'))), { e: 'DZY023', s: 'open' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.lineHubDzyRemindFor_('U2'))), { e: 'DZY024', s: 'wait' });
  assert.strictEqual(sb.lineHubDzyRemindFor_('U9'), null, '不在名單＝已開通或對不上');
  sb.handleLineHubDzyRemindPut_(body({ [lineH('U2')]: { e: 'DZY024', s: 'wait' } }));
  assert.strictEqual(sb.lineHubDzyRemindFor_('U1'), null, '開通後下一包沒有他 → 不再提醒');
});

ok('資料超過 3 小時沒更新、或 LINE_MAP_KEY 沒設 → 不提醒', () => {
  const a = make();
  a.sb.handleLineHubDzyRemindPut_(body({ [lineH('U1')]: { e: 'DZY023', s: 'open' } }, { at: new Date(Date.now() - 3.1 * 3600e3).toISOString() }));
  assert.strictEqual(a.sb.lineHubDzyRemindFor_('U1'), null);
  const b = make({ mapKey: '' });
  b.sb.handleLineHubDzyRemindPut_(body({ [lineH('U1')]: { e: 'DZY023', s: 'open' } }));
  assert.strictEqual(b.sb.lineHubDzyRemindFor_('U1'), null);
  const c = make(); c.store['lhd:v1'] = '{壞'; c.store['lhd:at'] = NOW();
  assert.strictEqual(c.sb.lineHubDzyRemindFor_('U1'), null, '快取壞掉不丟錯');
});

ok('卡片：還沒開通 → 一段說明＋「開通管理系統」按鈕連到第一次使用', () => {
  const { sb } = make();
  const card = sb.lineHubPunchCard_(punch({ dzy: { e: 'DZY023', s: 'open' } }));
  const t = texts(card).join('\n');
  assert.ok(t.includes('🔑 管理系統帳號還沒開通') && t.includes('DZY023') && t.includes('第一次使用'), t);
  const bs = buttons(card);
  assert.strictEqual(bs.length, 1);
  assert.strictEqual(bs[0].uri, 'https://dzy.mozhuting.com/#/claim');
  assert.ok(Array.from(bs[0].label).length <= 10, '按鈕字數窄螢幕放得下');
  assert.ok(t.indexOf('管理系統帳號還沒開通') < t.indexOf('早安'), '提醒在問候語前面');
});

ok('卡片：等審核 → 只說明、不給按鈕；兩種提醒與未簽公告可同時出現', () => {
  const { sb } = make();
  const w = sb.lineHubPunchCard_(punch({ dzy: { e: 'DZY024', s: 'wait' } }));
  assert.ok(texts(w).join('\n').includes('等店長或主管審核'));
  assert.strictEqual(buttons(w).length, 0);
  const both = sb.lineHubPunchCard_(punch({ dzy: { e: 'DZY023', s: 'open' }, bulletin: { n: 1, titles: ['十一月公告'] } }));
  assert.deepStrictEqual(buttons(both).map((b) => b.uri), ['https://dzy.mozhuting.com/#/claim', 'https://dzy.mozhuting.com/#/bulletin']);
});

ok('沒有提醒時卡片跟舊版逐字相同；打卡失敗卡片不提醒', () => {
  const { sb } = make();
  assert.strictEqual(JSON.stringify(sb.lineHubPunchCard_(punch({ dzy: null }))), JSON.stringify(sb.lineHubPunchCard_(punch())));
  const f = sb.lineHubPunchCard_({ ok: false, type: 'in', reason: '不在範圍內', dzy: { e: 'DZY023', s: 'open' } });
  assert.ok(!texts(f).join('\n').includes('管理系統'));
});

ok('webhook「打卡」成功時查提醒（程式有接上）', () => {
  const src = fs.readFileSync(__dirname + '/../apps-script/LineHub.gs', 'utf8');
  assert.ok(/r\.dzy = lineHubDzyRemindFor_\(userId\)/.test(src));
  assert.ok(/line_hub_dzy_remind_put: function \(b\) \{ return handleLineHubDzyRemindPut_\(b\); \}/.test(src));
});

console.log('\n全部通過 ' + n + ' 項');
