// 2026-11-02 Eason：LINE 打卡成功的機器人回覆卡片帶出還沒簽的公告（LineHub.gs；規格在佈告欄 repo docs/punch-remind.md）
// 佈告欄 Mac mini 每 5 分鐘送 line_hub_bulletin_put（{lineHash: {n, titles}}）存 CacheService；webhook「打卡」只讀這包。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const crypto = require('crypto');
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(walk); } })(o); return out; };
const buttons = (card) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'button') out.push(x.action); Object.values(x).forEach(walk); } })((card.contents && card.contents.footer) || {}); return out; };
// 佈告欄端的算法（js/logic.js LINE_HASH_PREFIX＋auth.lineHash）：兩邊必須算出同一串
const bulletinHash = (uid) => crypto.createHash('sha256').update('dzyb-line:' + uid, 'utf8').digest('hex');
const KEY = 'k'.repeat(40);

function make(opts) {
  opts = opts || {};
  const store = {}, props = { BULLETIN_PUSH_KEY: opts.key === undefined ? KEY : opts.key };
  const cache = {
    get: (k) => (k in store ? store[k] : null), put: (k, v) => { store[k] = String(v); }, remove: (k) => { delete store[k]; },
    removeAll: (ks) => ks.forEach((k) => delete store[k]),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
    putAll: (o) => { Object.keys(o).forEach((k) => { store[k] = String(o[k]); }); }
  };
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, isNaN, encodeURIComponent, unescape,
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      // Apps Script 回帶號 byte（-128～127）
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      formatDate: () => '2026-11-02'
    }
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  return { sb, store };
}
const NOW = () => new Date().toISOString();
const body = (map, extra) => Object.assign({ action: 'line_hub_bulletin_put', key: KEY, at: NOW(), v: 1, map }, extra || {});

ok('雜湊與佈告欄同一個算法', () => {
  const { sb } = make();
  assert.strictEqual(sb.lineHubSha256Hex_('dzyb-line:Uabc123'), bulletinHash('Uabc123'));
  assert.strictEqual(sb.lineHubSha256Hex_('中文 😀'), crypto.createHash('sha256').update('中文 😀', 'utf8').digest('hex'));
});

ok('掛在 LINE_HUB_HANDLERS', () => {
  const { sb } = make();
  assert.strictEqual(typeof sb.LINE_HUB_HANDLERS.line_hub_bulletin_put, 'function');
});

ok('金鑰錯／沒設／太短一律 unauthorized、不寫快取', () => {
  for (const [k, sent] of [[KEY, 'wrong'], [null, KEY], ['short', 'short'], ['', '']]) {
    const { sb, store } = make({ key: k });
    const r = sb.handleLineHubBulletinPut_(body({}, { key: sent }));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'unauthorized' });
    assert.deepStrictEqual(Object.keys(store), []);
  }
});

ok('格式不對 bad_input、不寫快取', () => {
  const h = bulletinHash('U1');
  const bads = [
    body([]), body(null), body({}, { v: 2 }), body({}, { at: 'not-a-date' }),
    body({ notahash: { n: 1, titles: ['a'] } }),
    body({ [h]: { n: 0, titles: [] } }), body({ [h]: { n: 'x', titles: ['a'] } }), body({ [h]: { n: 1, titles: 'a' } }),
    body({ [h]: { n: 1, titles: [1] } })
  ];
  bads.forEach((b, i) => {
    const { sb, store } = make();
    const r = sb.handleLineHubBulletinPut_(b);
    assert.strictEqual(r.error, 'bad_input', '第 ' + i + ' 個');
    assert.deepStrictEqual(Object.keys(store), []);
  });
});

ok('標題超過 40 字以碼點截斷，不留半個 emoji', () => {
  const { sb } = make();
  sb.handleLineHubBulletinPut_(body({ [bulletinHash('Ue')]: { n: 1, titles: ['😀'.repeat(50)] } }));
  const t = sb.lineHubBulletinFor_('Ue').titles[0];
  assert.strictEqual(Array.from(t).length, 40);
  assert.ok(Array.from(t).every((c) => c === '😀'));
});

ok('太大 too_big', () => {
  const { sb, store } = make();
  const map = {};
  for (let i = 0; i < 800; i++) map[bulletinHash('U' + i)] = { n: 3, titles: ['很長的公告標題甲乙丙丁戊己庚辛壬癸一二三四五六七八九十', '第二則很長的標題甲乙丙丁戊己庚辛', '第三則'] };
  assert.strictEqual(sb.handleLineHubBulletinPut_(body(map)).error, 'too_big');
  assert.deepStrictEqual(Object.keys(store), []);
});

ok('寫入後查得到；查不到的人 null；空 map 清掉舊的', () => {
  const { sb } = make();
  const r = sb.handleLineHubBulletinPut_(body({ [bulletinHash('U1')]: { n: 2, titles: ['十一月排班', '全部都要簽'] } }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, people: 1 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.lineHubBulletinFor_('U1'))), { n: 2, titles: ['十一月排班', '全部都要簽'] });
  assert.strictEqual(sb.lineHubBulletinFor_('U2'), null);
  sb.handleLineHubBulletinPut_(body({}));
  assert.strictEqual(sb.lineHubBulletinFor_('U1'), null);
});

ok('資料超過 30 分鐘不提醒；at 壞掉、JSON 壞掉都不提醒', () => {
  const { sb, store } = make();
  sb.handleLineHubBulletinPut_(body({ [bulletinHash('U1')]: { n: 1, titles: ['a'] } }, { at: new Date(Date.now() - 31 * 60e3).toISOString() }));
  assert.strictEqual(sb.lineHubBulletinFor_('U1'), null);
  sb.handleLineHubBulletinPut_(body({ [bulletinHash('U1')]: { n: 1, titles: ['a'] } }, { at: new Date(Date.now() - 29 * 60e3).toISOString() }));
  assert.ok(sb.lineHubBulletinFor_('U1'));
  store['lhb:at'] = 'garbage'; assert.strictEqual(sb.lineHubBulletinFor_('U1'), null);
  store['lhb:at'] = NOW(); store['lhb:v1'] = '{壞掉'; assert.strictEqual(sb.lineHubBulletinFor_('U1'), null);
  // CacheService 本身丟錯也不能讓回覆壞掉
  sb.CacheService.getScriptCache = () => { throw new Error('cache down'); };
  assert.strictEqual(sb.lineHubBulletinFor_('U1'), null);
});

const PUNCH = { ok: true, type: 'out', ts: '2026-11-02T21:32:00+08:00', store_name: '墨竹亭 新竹金山', greeting: '辛苦了，回家路上小心！' };
ok('卡片：段落、最多 3 則、還有 N 則、按鈕；段落在問候語之前', () => {
  const { sb } = make();
  const card = sb.lineHubPunchCard_(Object.assign({}, PUNCH, { bulletin: { n: 5, titles: ['甲公告', '乙公告', '丙公告'] } }));
  const t = texts(card);
  const i = t.indexOf('📢 還沒簽的公告');
  assert.ok(i >= 0);
  assert.deepStrictEqual(t.slice(i + 1, i + 6), ['・甲公告', '・乙公告', '・丙公告', '還有 2 則', '公告在管理系統的公告專區']);
  assert.ok(t.indexOf(PUNCH.greeting) > i);
  const btn = buttons(card);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(btn)), [{ type: 'uri', label: '請到公告專區閱讀並簽名', uri: 'https://dzy.mozhuting.com/#/bulletin' }]);
});

ok('卡片：n 等於列出的則數時不寫「還有」', () => {
  const { sb } = make();
  const t = texts(sb.lineHubPunchCard_(Object.assign({}, PUNCH, { bulletin: { n: 1, titles: ['只有一則'] } })));
  assert.ok(t.includes('・只有一則'));
  assert.ok(!t.some((x) => /^還有/.test(x)));
});

ok('卡片：沒有 bulletin 時與原本逐字相同；失敗卡片不帶', () => {
  const { sb } = make();
  const a = JSON.stringify(sb.lineHubPunchCard_(Object.assign({}, PUNCH)));
  const b = JSON.stringify(sb.lineHubPunchCard_(Object.assign({}, PUNCH, { bulletin: null })));
  assert.strictEqual(a, b);
  assert.ok(!/還沒簽的公告|公告專區閱讀並簽名|公告在管理系統/.test(a));
  const f = JSON.stringify(sb.lineHubPunchCard_({ ok: false, type: 'in', reason: '超出範圍', bulletin: { n: 1, titles: ['x'] } }));
  assert.ok(!/還沒簽的公告|公告專區閱讀並簽名|公告在管理系統/.test(f));
});

ok('webhook「打卡」把 bulletin 帶進卡片；文字版 lineHubPunchText_ 不帶標題', () => {
  const { sb } = make();
  sb.handleLineHubBulletinPut_(body({ [bulletinHash('Uw')]: { n: 1, titles: ['打卡要看到的公告'] } }));
  const replies = [];
  sb.lineHubBotUserId_ = () => 'BOT';
  sb.lineHubThrottled_ = () => false;
  sb.lineHubLoading_ = () => {};
  sb.lineHubTakeStash_ = () => null;
  sb.lineHubLatestPunch_ = () => Object.assign({}, PUNCH);
  sb.lineHubAnnualNote_ = () => '';
  sb.lineHubReply_ = (tok, msgs) => replies.push(msgs);
  sb.handleLineWebhook_({ destination: 'BOT', events: [{ type: 'message', replyToken: 'R', source: { type: 'user', userId: 'Uw' }, message: { type: 'text', text: '打卡' } }] });
  assert.strictEqual(replies.length, 1);
  assert.ok(texts(replies[0]).includes('・打卡要看到的公告'));
  assert.ok(!/打卡要看到的公告/.test(sb.lineHubPunchText_(Object.assign({}, PUNCH, { bulletin: { n: 1, titles: ['打卡要看到的公告'] } }))));
});

console.log(n + ' 項通過');
