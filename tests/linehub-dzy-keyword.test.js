// 光復 LineHub：文字「重設密碼」→ 回 Flex 按鈕卡片（LIFF ?m=reset）；「開通管理系統」已取消、不觸發；屬性未設回「這個功能準備中」；絕不用 push。
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
const SRC = [fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8'),
  extract(codeSrc, 'lastCountedEvent'), extract(codeSrc, 'normShiftTime')].join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function make(props) {
  const urls = [], replies = [], cache = {};
  const sb = {
    console, JSON, Math, String, Number, Date, isNaN, isFinite, parseInt, Object, Array,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12 },
    LINE_HUB_STORES_CONFIG: [], LINE_HUB_BOT_TOKEN: 'BOT', LINE_HUB_BOT_USER_ID: 'BOTU',
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    UrlFetchApp: { fetch: (url, o) => {
      urls.push(url);
      if (url.indexOf('/message/reply') >= 0) replies.push(JSON.parse(o.payload));
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    } },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) },
    getSS: () => ({ getSheetByName: () => null }),
    readSheetAsObjects: () => ({ rows: [] }), normCellTs: (v) => v,
    Utilities: { formatDate: () => '2026-10-25' },
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  const say = (text) => sb.handleLineWebhook_({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text } }] });
  return { say, urls, replies };
}
const flatUris = (m) => { const o = []; (function w(x) { if (Array.isArray(x)) x.forEach(w); else if (x && typeof x === 'object') { if (x.type === 'uri') o.push(x.uri); Object.values(x).forEach(w); } })(m); return o; };
const LIFF = 'https://liff.line.me/2000000000-AbCdEfGh';

ok('「重設密碼」→ 一張 flex 卡片，按鈕 uri＝DZY_LINE_LIFF_URL?m=reset', () => {
  const { say, replies } = make({ DZY_LINE_LIFF_URL: LIFF });
  say('重設密碼');
  assert.strictEqual(replies.length, 1);
  const m = replies[0].messages;
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].type, 'flex');
  assert.deepStrictEqual(flatUris(m[0]), [LIFF + '?m=reset']);
});
ok('「開通管理系統」不再觸發卡片（沒有任何回覆）', () => {
  const { say, replies } = make({ DZY_LINE_LIFF_URL: LIFF });
  say('開通管理系統');
  assert.strictEqual(replies.length, 0);
});
ok('前後空白 trim 後相等也算；多一個字（例如「重設密碼嗎」）不觸發', () => {
  const a = make({ DZY_LINE_LIFF_URL: LIFF });
  a.say('  重設密碼\n'); assert.strictEqual(a.replies.length, 1);
  const b = make({ DZY_LINE_LIFF_URL: LIFF });
  b.say('重設密碼嗎'); b.say('我要開通管理系統'); b.say('開通');
  assert.strictEqual(b.replies.length, 0);
});
ok('DZY_LINE_LIFF_URL 未設（或空白）→ 回文字「這個功能準備中」，沒有按鈕', () => {
  [{}, { DZY_LINE_LIFF_URL: '' }, { DZY_LINE_LIFF_URL: '   ' }].forEach((p) => {
    const { say, replies } = make(p);
    say('重設密碼');
    assert.strictEqual(replies.length, 1);
    replies.forEach((r) => { assert.deepStrictEqual(r.messages, [{ type: 'text', text: '這個功能準備中' }]); });
  });
});
ok('網址已帶 ? 時用 & 接 m 參數', () => {
  const { say, replies } = make({ DZY_LINE_LIFF_URL: 'https://example.test/liff?x=1' });
  say('重設密碼');
  assert.deepStrictEqual(flatUris(replies[0].messages[0]), ['https://example.test/liff?x=1&m=reset']);
});
ok('完全不呼叫 push／multicast／broadcast（只有 reply，加上 loading 動畫）', () => {
  const { say, urls } = make({ DZY_LINE_LIFF_URL: LIFF });
  say('重設密碼'); say('');
  assert.ok(urls.length > 0);
  urls.forEach((u) => assert.ok(!/\/message\/(push|multicast|broadcast|narrowcast)/.test(u), '不該呼叫 ' + u));
  assert.ok(urls.some((u) => u.indexOf('/message/reply') >= 0));
  const src = fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8');
  const fn = extract(src, 'lineHubDzyCard_');
  assert.ok(!/push|UrlFetchApp/.test(fn), 'lineHubDzyCard_ 本身不碰網路');
});
console.log('\nlinehub-dzy-keyword: ' + n + ' 項通過');
