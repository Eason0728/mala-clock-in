// v2：全部在 LINE 聊天室完成（LineHub.gs 的 line_quick_clock 與 webhook）。
const assert = require('assert');
// 回覆可能是文字或卡片（Flex）：把卡片裡所有 text 串起來比對
function msgText(m) { if (!m) return ''; if (m.type === 'text') return m.text; const out = []; (function w(x) { if (Array.isArray(x)) x.forEach(w); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(w); } })(m.contents); return out.join('\n'); }

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
const core = require(ROOT + '/clock-line-core.js');
const STORES = require(ROOT + '/tools/stores.json');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const iso = (minAgo) => new Date(NOW - minAgo * 60000 + 8 * 3600000).toISOString().replace('Z', '+08:00');

function make(opts) {
  const replies = [], storeCalls = [], cache = {};
  const sheets = opts.sheets;   // {code: {roster:[], events:[], approved:[]}}
  // 假工作表：readSheetAsObjects 用 rows；lineHubTailRows_ 用 getLastRow／getRange（表頭＝所有列的欄位聯集）
  const fakeSheet = (rows) => { const H = [...new Set(rows.flatMap(o => Object.keys(o)))];
    return { rows, getLastRow: () => rows.length + 1, getLastColumn: () => H.length,
             getRange: (r, c, nr) => ({ getValues: () => r === 1 ? [H] : rows.slice(r - 2, r - 2 + nr).map(o => H.map(h => o[h])) }) }; };
  const ssOf = (code) => ({ getSheetByName: (n) => {
    if (opts.brokenEvents && opts.brokenEvents.indexOf(code) >= 0 && n === 'events') throw new Error('試算表忙碌');
    return (sheets[code] && sheets[code][n]) ? fakeSheet(sheets[code][n]) : null; } });
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
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach(k => { delete cache[k]; }) }) },
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
  assert(/上班打卡成功/.test(msgText(replies[0].messages[0]))); assert.strictEqual(replies[0].replyToken, 'RT');
  assert(!cache['lhq:U1']);
  sb.handleLineWebhook_(ev('打卡'));
  assert(/請按下方選單/.test(msgText(replies[1].messages[0])));
});
ok('webhook：沒綁定的人查出勤 → 教他先按打卡綁定；請假申請 → 申請頁卡片（開 LIFF view=req&tab=leave）', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R({ line_user_id: '' })] } } });
  sb.handleLineWebhook_(ev('出勤紀錄', 'U9')); assert(/還沒綁定/.test(msgText(replies[0].messages[0])));
  sb.handleLineWebhook_(ev('請假申請'));
  const a = replies[1].messages[0].contents.footer.contents[0].action;
  assert.strictEqual(a.type, 'uri'); assert(/view=req&tab=leave$/.test(a.uri), a.uri);
});
ok('webhook：2026-10-09 新選單——加班請假 → 申請頁卡片、出勤班表 → 班表卡片；佈告欄 → 卡片附開網頁按鈕；舊字句「假別額度」仍可打字查', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R({ line_user_id: '' })] } } });
  sb.handleLineWebhook_(ev('加班請假')); assert(/view=req/.test(JSON.stringify(replies[0].messages[0])));
  sb.handleLineWebhook_(ev('出勤班表')); assert(/view=sched/.test(replies[1].messages[0].contents.footer.contents[0].action.uri));   // 2026-10-10 接排班系統
  sb.handleLineWebhook_(ev('佈告欄'));
  const card = replies[2].messages[0];
  const btn = card.contents.footer.contents[0].action;
  assert.strictEqual(btn.type, 'uri'); assert(/^https:\/\//.test(btn.uri));
  sb.handleLineWebhook_(ev('假別額度', 'U9')); assert.strictEqual(replies.length, 4);
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
ok('手選上班／下班：已經打過上班卡又按上班 → 擋；30 分鐘前上班、按下班 → 送 out', () => {
  let m = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(30), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  let r = m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', type: 'in', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(m.storeCalls.length, 0); assert(/已經打過上班卡/.test(r.text), r.text);
  r = m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', type: 'out', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(m.storeCalls[0].body.type, 'out');
});
ok('手選：5 分鐘前上班、按下班 → 10 分鐘鎖擋下；沒有任何卡、按下班 → 照送（真的忘打上班卡的人要打得進去）', () => {
  let m = make({ sheets: { hq: { roster: [R()], events: [{ ts: iso(5), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  assert(/分鐘內不能打下班卡/.test(m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', type: 'out', lat: hq.lat, lng: hq.lng, accuracy: 10 }).text));
  assert.strictEqual(m.storeCalls.length, 0);
  m = make({ sheets: { hq: { roster: [R()], events: [] } } });
  m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', type: 'out', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(m.storeCalls[0].body.type, 'out');
});
ok('line_hub_status：回姓名、店家座標、班別、今天的卡、防呆狀態；不在範圍 → fail＋最近的店', () => {
  const m = make({ sheets: { hq: { roster: [R({ shift_in: '08:00', shift_out: '17:00' })], events: [{ ts: iso(30), emp_id: 'H01', type: 'in', status: 'ok' }] } } });
  const r = m.sb.handleLineHubStatus_({ id_token: 'TOK_U1', lat: hq.lat, lng: hq.lng, accuracy: 10 });
  assert.strictEqual(r.status, 'ready'); assert.strictEqual(r.name, '甲'); assert.strictEqual(r.store.code, 'hq');
  assert.strictEqual(r.shift_in, '08:00'); assert.strictEqual(r.today.length, 1); assert.strictEqual(r.guard.blocked, 'in');
  assert(!/kH|DEV-SAFARI/.test(JSON.stringify(r)), '不可回金鑰或裝置碼');
  const f = m.sb.handleLineHubStatus_({ id_token: 'TOK_U1', lat: 25.03, lng: 121.56, accuracy: 10 });
  assert.strictEqual(f.status, 'fail'); assert.strictEqual(f.result.code, 'out_of_range'); assert(f.result.nearest.name);
});
// 方案 C：打卡畫面直接打店家，光復沒有暫存 → webhook 查已綁定各店最近 5 分鐘最新一筆成功的卡
ok('webhook「打卡」沒暫存：查已綁定各店 5 分鐘內最新一筆成功的卡；問候語與 liffGreeting_ 同一句', () => {
  const ts = iso(2);
  const { sb, replies } = make({ sheets: {
    hq: { roster: [R()], events: [{ emp_id: 'H01', ts: iso(4), type: 'in', status: 'ok' }, { emp_id: 'H01', ts: iso(1), type: 'out', status: 'rejected_out_of_range' }, { emp_id: 'H99', ts: iso(0), type: 'out', status: 'ok' }] },
    mztjs: { roster: [R({ emp_id: 'J01', key: 'kJ' })], events: [{ emp_id: 'J01', ts, type: 'out', status: 'ok' }] } } });
  sb.handleLineWebhook_(ev('打卡'));
  const t = msgText(replies[0].messages[0]);
  assert(/下班打卡成功/.test(t), t); assert(t.indexOf(js.name) >= 0, t); assert(t.indexOf(ts.slice(11, 16)) >= 0, t);
  assert(t.indexOf(sb.liffGreeting_('out', ts)) >= 0, '問候語要與打卡畫面同一句');
});
ok('webhook「打卡」沒暫存：最新一筆超過 5 分鐘、或只有被擋的卡 → 提醒要按選單', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R()], events: [{ emp_id: 'H01', ts: iso(6), type: 'in', status: 'ok' }, { emp_id: 'H01', ts: iso(1), type: 'in', status: 'rejected_duplicate' }] } } });
  sb.handleLineWebhook_(ev('打卡'));
  assert(/請按下方選單/.test(msgText(replies[0].messages[0])));
});
ok('webhook「打卡」沒暫存：只讀 events 尾端（超過 200 列時最前面的不讀）', () => {
  const old = Array.from({ length: 300 }, (_, i) => ({ emp_id: 'H01', ts: iso(1), type: 'in', status: i === 0 ? 'ok' : 'rejected_duplicate' }));
  const { sb, replies } = make({ sheets: { hq: { roster: [R()], events: old } } });
  sb.handleLineWebhook_(ev('打卡'));
  assert(/請按下方選單/.test(msgText(replies[0].messages[0])), '第 1 列在尾端 200 列之外，不該被讀到');
});
ok('webhook「打卡」沒暫存：有店讀不到、又沒找到 → 說「暫時查不到、畫面成功就是成功」，不說「直接打字不會記錄」', () => {
  const { sb, replies } = make({ brokenEvents: ['mztjs'], sheets: { hq: { roster: [R()], events: [] }, mztjs: { roster: [R({ emp_id: 'J01', key: 'kJ' })], events: [] } } });
  sb.handleLineWebhook_(ev('打卡'));
  const t = msgText(replies[0].messages[0]);
  assert(/暫時查不到/.test(t) && !/直接打字/.test(t), t);
});
ok('webhook「打卡」沒暫存：某店試算表整份打不開（openById 丟錯）→ 也說「暫時查不到」（審查 #9）', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R()], events: [] }, mztjs: { roster: [R({ emp_id: 'J01', key: 'kJ' })], events: [] } } });
  const orig = sb.SpreadsheetApp.openById;
  sb.SpreadsheetApp.openById = (id) => { if (id === 'SS_mztjs') throw new Error('忙碌'); return orig(id); };
  sb.handleLineWebhook_(ev('打卡'));
  const t = msgText(replies[0].messages[0]);
  assert(/暫時查不到/.test(t) && !/直接打字/.test(t), t);
});
ok('打卡求助：只打「打卡求助」→ 目錄卡（每類一顆按鈕，按下送「打卡求助：類別」）', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R()], events: [] } } });
  sb.handleLineWebhook_(ev('打卡求助'));
  const card = replies[0].messages[0];
  assert.strictEqual(card.type, 'flex');
  const btns = card.contents.footer.contents.map(b => b.action);
  assert.strictEqual(btns.length, sb.LINE_HUB_HELP_ORDER.length);
  btns.forEach(a => { assert.strictEqual(a.type, 'message'); assert(/^打卡求助：/.test(a.text)); assert(a.label.length <= 20, a.label); });
  assert(JSON.stringify(card).length < 28000);
});
ok('打卡求助：指定類別 → 那類的步驟卡；不認得的類別 → 目錄；沒綁定的人也能看', () => {
  const { sb, replies } = make({ sheets: { hq: { roster: [R({ line_user_id: '' })], events: [] } } });
  sb.handleLineWebhook_(ev('打卡求助：定位不準', 'U9'));
  const t = msgText(replies[0].messages[0]);
  assert(/定位不準/.test(t) && /Wi‑Fi 偏移/.test(t) && /舊的專屬打卡連結/.test(t), t);
  sb.handleLineWebhook_(ev('打卡求助：亂打', 'U9'));
  assert(/選一個最像你遇到的狀況/.test(msgText(replies[1].messages[0])));
});
ok('打卡求助：打卡畫面用到的每個類別，機器人都有對應的步驟卡（兩邊名稱一致）', () => {
  const { sb } = make({ sheets: {} });
  const html = fs.readFileSync(ROOT + '/clock-line.html', 'utf8');
  const keys = new Set();
  // 只看「offerHelp(…)」那幾行與 var hk 對照表裡的字串：這些全部都是類別名稱
  html.split('\n').filter(l => /offerHelp\(|var hk = /.test(l) && !/function offerHelp/.test(l))
    .map(l => l.indexOf('offerHelp(') >= 0 ? l.slice(l.lastIndexOf('offerHelp(')) : l)   // 同一行前面的 say(...) 字句不算
    .forEach(l => (l.match(/'([^']+)'/g) || []).forEach(m => keys.add(m.slice(1, -1))));
  assert(keys.size >= 6, [...keys].join(','));
  keys.forEach(k => assert(sb.LINE_HUB_HELP[k], '機器人沒有「' + k + '」的步驟卡'));
  sb.LINE_HUB_HELP_ORDER.forEach(k => assert(sb.LINE_HUB_HELP[k]));
});
ok('速度：「你綁了哪幾家店」記 5 分鐘——第二次查不再開各店試算表；綁定成功會清掉；有店讀不到不記', () => {
  const env = make({ sheets: { hq: { roster: [R()], events: [] }, mztjs: { roster: [], events: [] } } });
  let opens = 0; const orig = env.sb.SpreadsheetApp.openById;
  env.sb.SpreadsheetApp.openById = (id) => { opens++; return orig(id); };
  assert.strictEqual(env.sb.lineHubMine_('U1').length, 1);
  const first = opens;
  assert.strictEqual(env.sb.lineHubMine_('U1').length, 1);
  assert.strictEqual(opens, first, '第二次不該再開試算表');
  assert.strictEqual(env.sb.lineHubMine_('U1')[0].row.emp_id, 'H01');
  assert(!/kH|DEV-SAFARI/.test(env.cache['lhm:U1']), '快取不可記金鑰或裝置碼');
  env.sb.lineHubForget_('U1');
  env.sb.lineHubMine_('U1'); assert(opens > first, '清掉後要重查');
  const e2 = make({ brokenEvents: [], sheets: { hq: { roster: [R()], events: [] } } });
  const o2 = e2.sb.SpreadsheetApp.openById; e2.sb.SpreadsheetApp.openById = (id) => { if (id === 'SS_cf') throw new Error('忙'); return o2(id); };
  e2.sb.lineHubMine_('U1'); assert(!e2.cache['lhm:U1'], '有店讀不到時不記');
});
ok('速度：選單指令先顯示「輸入中」動畫；閒聊不顯示', () => {
  const env = make({ sheets: { hq: { roster: [R()], events: [] } } });
  const loads = []; const orig = env.sb.UrlFetchApp.fetch;
  env.sb.UrlFetchApp.fetch = (u, o) => { if (u.indexOf('/chat/loading/start') >= 0) { loads.push(JSON.parse(o.payload)); return { getResponseCode: () => 202, getContentText: () => '{}' }; } return orig(u, o); };
  env.sb.handleLineWebhook_(ev('出勤紀錄'));
  env.sb.handleLineWebhook_(ev('你好'));
  assert.strictEqual(loads.length, 1); assert.strictEqual(loads[0].chatId, 'U1');
});
console.log(`\n${n} 項全部通過`);
