// v2：全部在 LINE 聊天室完成（LineHub.gs 的 line_quick_clock 與 webhook）。
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
             extract(codeSrc, 'lastCountedEvent')].join('\n');
const core = require(ROOT + '/clock-line-core.js');
const STORES = require(ROOT + '/tools/stores.json');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const iso = (minAgo) => new Date(NOW - minAgo * 60000 + 8 * 3600000).toISOString().replace('Z', '+08:00');

function make(opts) {
  const replies = [], storeCalls = [], cache = {};
  const sheets = opts.sheets;   // {code: {roster:[], events:[], approved:[]}}
  const ssOf = (code) => ({ getSheetByName: (n) => (sheets[code] && sheets[code][n]) ? { rows: sheets[code][n] } : null });
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12 },
    LINE_HUB_STORES_CONFIG: STORES.map(s => ({ code: s.code, name: s.name, api: 'https://' + (s.code || 'gf') + '/exec', ss_id: 'SS_' + s.code, lat: s.lat, lng: s.lng, radius_m: s.radius_m })),
    LINE_HUB_BOT_TOKEN: 'BOT',
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.indexOf('api.line.me/oauth2') >= 0) {
          const t = o.payload.id_token; const good = t.indexOf('TOK_') === 0;
          return { getResponseCode: () => good ? 200 : 400, getContentText: () => JSON.stringify(good ? { sub: t.slice(4), aud: '2011292256' } : {}) };
        }
        if (url.indexOf('/message/reply') >= 0) { replies.push(JSON.parse(o.payload)); return { getContentText: () => '{}' }; }
        if (url.indexOf('/v2/bot/info') >= 0) return { getContentText: () => JSON.stringify({ userId: 'BOTU' }) };
        storeCalls.push({ url, body: JSON.parse(o.payload) });
        return { getContentText: () => JSON.stringify(opts.storeReply ? opts.storeReply(url, JSON.parse(o.payload)) : { ok: true, status: 'ok', ts: iso(0) }) };
      },
    },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) },
    getSS: () => ssOf(''),
    SpreadsheetApp: { openById: (id) => ssOf(id.replace('SS_', '')) },
    readSheetAsObjects: (sh) => ({ rows: sh.rows.map(r => Object.assign({}, r)) }),
    normCellTs: (v) => v,
    Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) },
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  sb.LIFF_HANDLERS.liff_clock = (p) => { storeCalls.push({ url: 'local', body: p }); return opts.storeReply ? opts.storeReply('local', p) : { ok: true, status: 'ok', ts: iso(0) }; };
  return { sb, replies, storeCalls, cache };
}
const hq = STORES.find(s => s.code === 'hq'), js = STORES.find(s => s.code === 'mztjs');
const R = (extra) => Object.assign({ emp_id: 'H01', name: '甲', key: 'kH', active: 'true', line_user_id: 'U1', device_id: 'DEV-SAFARI' }, extra || {});

ok('挑店規則：後端 lineHubPickStore_ 與前端 pickStore 在 4000 個點結果完全一致', () => {
  const { sb } = make({ sheets: {} });
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) {
    const base = STORES[i % STORES.length];
    const fix = { lat: base.lat + (rnd() - 0.5) * 0.006, lng: base.lng + (rnd() - 0.5) * 0.006, accuracy_m: Math.floor(rnd() * 150) };
    const a = core.pickStore(fix, STORES), b = sb.lineHubPickStore_(fix, STORES);
    assert.strictEqual(b.status, a.status, JSON.stringify(fix));
    if (a.status === 'ok') assert.strictEqual(b.store.code, a.store.code);
  }
});
ok('沒有上一張卡 → 記成上班，打到挑出那家店，裝置碼沿用名冊已綁的', () => {
  const { sb, storeCalls, cache } = make({ sheets: { hq: { roster: [R()], events: [] } } });
  const r = sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(r.result.ok, true); assert.strictEqual(r.result.type, 'in');
  assert.strictEqual(storeCalls[0].url, 'https://hq/exec'); assert.strictEqual(storeCalls[0].body.type, 'in');
  assert.strictEqual(storeCalls[0].body.device_id, 'DEV-SAFARI');
  assert(/上班打卡成功/.test(r.text) && /鼎兆元 總部/.test(r.text));
  assert(cache['lhq:U1'], '結果要暫存給 webhook');
});
ok('上一張是 30 分鐘前的上班卡 → 這次記成下班', () => {
  const { sb, storeCalls } = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(30), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  const r = sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(storeCalls[0].body.type, 'out'); assert(/下班打卡成功/.test(r.text));
});
ok('上一張是 5 分鐘前 → 10 分鐘鎖擋下、不送打卡，說明幾分鐘後能打', () => {
  const { sb, storeCalls } = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(5), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  const r = sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(storeCalls.length, 0); assert.strictEqual(r.result.ok, false);
  assert(/5 分鐘內不能再打/.test(r.text), r.text);
});
ok('被擋下的卡不算上一張（rejected_*）；超過 16 小時的也不算 → 記成上班', () => {
  const { sb, storeCalls } = make({ sheets: { hq: { roster: [R()], events: [
    { ts: iso(1000), emp_id: 'H01', type: 'in', status: 'ok' }, { ts: iso(3), emp_id: 'H01', type: 'in', status: 'rejected_out_of_range' }] } } });
  sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(storeCalls[0].body.type, 'in');
});
ok('站在金山、只綁了總部、金山名冊有同名未綁 → 不靜默自動綁：回 not_bound＋suggest_name，不送任何請求', () => {
  const { sb, storeCalls } = make({ sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ', line_user_id: '', device_id: '' })], events: [] } } });
  const r = sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(storeCalls.length, 0);
  assert.strictEqual(r.result.code, 'not_bound'); assert.strictEqual(r.result.suggest_name, '甲');
});
ok('line_bind_name via=auto（本人按「是我」）→ liff_bind 帶 via auto；同一帳號 10 分鐘內第 6 次 → too_many', () => {
  const { sb, storeCalls } = make({ sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ', line_user_id: '' })] } } });
  assert.strictEqual(sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', via: 'auto', lat: js.lat, lng: js.lng, accuracy: 10 }).ok, true);
  assert.strictEqual(storeCalls[0].body.via, 'auto');
  for (let i = 0; i < 4; i++) sb.handleLineBindName_({ id_token: 'TOK_U1', name: '丙', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(sb.handleLineBindName_({ id_token: 'TOK_U1', name: '丙', lat: js.lat, lng: js.lng, accuracy: 10 }).error, 'too_many');
});
ok('長班：14 小時前的上班卡、之後沒下班卡 → 這次記下班；17 小時前 → 視為忘打下班，記上班', () => {
  let m = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(14 * 60), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(m.storeCalls[0].body.type, 'out');
  m = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(17 * 60), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(m.storeCalls[0].body.type, 'in');
});
ok('站在金山、金山名冊沒有同名（或已被別人綁） → code=not_bound、不送打卡，提示輸入全名', () => {
  const a = make({ sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J1', name: '乙', line_user_id: '' })] } } });
  const r = a.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(a.storeCalls.length, 0); assert.strictEqual(r.result.code, 'not_bound'); assert(/輸入你的全名/.test(r.text));
  const b = make({ sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J1', line_user_id: 'U_OTHER' })] } } });
  assert.strictEqual(b.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: js.lat, lng: js.lng, accuracy: 10 }).result.code, 'not_bound');
  assert.strictEqual(b.storeCalls.length, 0);
});
ok('line_bind_name：人在店裡＋名冊有這個全名（忽略空白）＋還沒被綁 → 以該列金鑰呼叫那家店的 liff_bind（via=name）', () => {
  const { sb, storeCalls } = make({ sheets: { mztjs: { roster: [R({ emp_id: 'J1', name: '陳 小明', key: 'kJ', line_user_id: '' })] } } });
  const r = sb.handleLineBindName_({ id_token: 'TOK_U1', name: ' 陳小明　', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.store_name, '墨竹亭 新竹金山');
  assert.deepStrictEqual(Object.assign({}, storeCalls[0].body), { action: 'liff_bind', id_token: 'TOK_U1', key: 'kJ', via: 'name' });
  assert(!/kJ/.test(JSON.stringify(r)), '回應不可含金鑰');
});
ok('line_bind_name：人不在店裡 → not_at_store；名冊沒有 → name_not_found；已被別人綁 → name_taken；同名兩位 → name_conflict；全都不送綁定', () => {
  const sheetsJ = (rows) => ({ mztjs: { roster: rows } });
  let m = make({ sheets: sheetsJ([R({ emp_id: 'J1', line_user_id: '' })]) });
  assert.strictEqual(m.sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', lat: 25.03, lng: 121.56, accuracy: 10 }).error, 'not_at_store');
  assert.strictEqual(m.sb.handleLineBindName_({ id_token: 'TOK_U1', name: '丙', lat: js.lat, lng: js.lng, accuracy: 10 }).error, 'name_not_found');
  m = make({ sheets: sheetsJ([R({ emp_id: 'J1', line_user_id: 'U_OTHER' })]) });
  assert.strictEqual(m.sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', lat: js.lat, lng: js.lng, accuracy: 10 }).error, 'name_taken');
  m = make({ sheets: sheetsJ([R({ emp_id: 'J1', line_user_id: '' }), R({ emp_id: 'J2', line_user_id: '' })]) });
  assert.strictEqual(m.sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', lat: js.lat, lng: js.lng, accuracy: 10 }).error, 'name_conflict');
  assert.strictEqual(m.storeCalls.length, 0);
  m = make({ sheets: sheetsJ([R({ emp_id: 'J1', line_user_id: '', active: 'false' })]) });
  assert.strictEqual(m.sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', lat: js.lat, lng: js.lng, accuracy: 10 }).error, 'name_not_found', '離職的不算');
});
ok('定位分不出店（中間點、誤差 60）／不在任何店 → 失敗原因＋怎麼辦', () => {
  const { sb } = make({ sheets: {} });
  const mid = { lat: (hq.lat + js.lat) / 2, lng: (hq.lng + js.lng) / 2 };
  assert(/分不出你在哪一家店/.test(sb.handleLineQuickClock_({ id_token: 'TOK_U1', ...mid, accuracy: 60 }).text));
  const far = sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: 25.03, lng: 121.56, accuracy: 10 }).text;
  assert(/不在任何打卡地點範圍內/.test(far) && /怎麼辦/.test(far));
});
ok('店家回超出範圍／新裝置 → 中文原因；沒回應 → 提醒先看出勤紀錄再重打', () => {
  const a = make({ sheets: { hq: { roster: [R()], events: [] } }, storeReply: () => ({ ok: true, status: 'rejected_out_of_range' }) });
  assert(/不在範圍內/.test(a.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 }).text));
  const b = make({ sheets: { hq: { roster: [R()], events: [] } }, storeReply: () => { throw new Error('x'); } });
  b.sb.UrlFetchApp.fetch = ((orig) => (u, o) => { if (u === 'https://hq/exec') return { getContentText: () => '<html>' }; return orig(u, o); })(b.sb.UrlFetchApp.fetch);
  assert(/不確定這筆有沒有進去/.test(b.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 }).text));
});
ok('token 無效 → invalid_id_token，不暫存', () => {
  const { sb, cache } = make({ sheets: {} });
  assert.strictEqual(sb.handleLineQuickClock_({ id_token: 'bad', lat: hq.lat, lng: hq.lng }).error, 'invalid_id_token');
  assert.strictEqual(Object.keys(cache).length, 0);
});
const ev = (text, uid, extra) => Object.assign({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'user', userId: uid || 'U1' }, message: { type: 'text', text } }] }, extra || {});
ok('webhook「打卡」：有暫存 → 回結果並清掉暫存；沒有 → 提醒要按選單', () => {
  const { sb, replies, cache } = make({ sheets: { hq: { roster: [R()], events: [] } } });
  sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  sb.handleLineWebhook_(ev('打卡'));
  assert(/上班打卡成功/.test(replies[0].messages[0].text)); assert.strictEqual(replies[0].replyToken, 'RT');
  assert(!cache['lhq:U1']);
  sb.handleLineWebhook_(ev('打卡'));
  assert(/請按下方選單/.test(replies[1].messages[0].text));
});
ok('webhook：沒綁定的人查出勤 → 教他先按打卡綁定；加班／請假申請 → 準備中', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R({ line_user_id: '' })] } } });
  sb.handleLineWebhook_(ev('出勤紀錄', 'U9')); assert(/還沒綁定/.test(replies[0].messages[0].text));
  sb.handleLineWebhook_(ev('請假申請')); assert(/準備中/.test(replies[1].messages[0].text));
});
ok('webhook：其他文字、貼圖、驗證用的空 events 都不回、不出錯', () => {
  const { sb, replies } = make({ sheets: {} });
  sb.handleLineWebhook_(ev('你好')); sb.handleLineWebhook_({ events: [] });
  sb.handleLineWebhook_({ events: [{ type: 'message', replyToken: 'RT', source: { userId: 'U1' }, message: { type: 'sticker' } }] });
  assert.strictEqual(replies.length, 0);
});
ok('webhook fail-closed：沒帶 destination、或查不到本帳號 userId → 一律不處理（不吃暫存、不回覆）', () => {
  const { sb, replies, cache } = make({ sheets: { hq: { roster: [R()], events: [] } } });
  sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  sb.handleLineWebhook_({ events: ev('打卡').events });
  assert.strictEqual(replies.length, 0); assert(cache['lhq:U1'], '暫存不可被偽造請求吃掉');
  const m2 = make({ sheets: {} }); m2.sb.LINE_HUB_BOT_TOKEN = '';
  m2.sb.handleLineWebhook_(ev('請假申請')); assert.strictEqual(m2.replies.length, 0);
});
ok('line_bind_name 的 via 由伺服器判斷：前端送 auto 但別家店沒有同名綁定 → 記成 name', () => {
  const { sb, storeCalls } = make({ sheets: { mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ', line_user_id: '' })] } } });
  sb.handleLineBindName_({ id_token: 'TOK_U1', name: '甲', via: 'auto', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(storeCalls[0].body.via, 'name');
});
ok('webhook：群組裡打「薪資明細」不回；destination 不是本帳號不回；同一人一分鐘超過 20 則不回', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R()] } } });
  sb.handleLineWebhook_({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'group', groupId: 'G', userId: 'U1' }, message: { type: 'text', text: '薪資明細' } }] });
  sb.handleLineWebhook_(ev('請假申請', 'U1', { destination: 'OTHER' }));
  assert.strictEqual(replies.length, 0);
  for (let i = 0; i < 25; i++) sb.handleLineWebhook_(ev('請假申請'));
  assert.strictEqual(replies.length, 20);
});
console.log(`\n${n} 項全部通過`);
