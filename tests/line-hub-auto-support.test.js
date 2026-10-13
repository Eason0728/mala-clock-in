// 7A 首次跨店自動加入（LineHub.gs lineHubAutoSupport_，spec §4.4 / task F1）。測試資料一律假名。
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const LH = fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const SRC = [fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), LH, extract(codeSrc, 'lastCountedEvent'), extract(codeSrc, 'normShiftTime')].join('\n');
const STORES = require(ROOT + '/tools/stores.json');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const iso = (minAgo) => new Date(NOW - minAgo * 60000 + 8 * 3600000).toISOString().replace('Z', '+08:00');
const HUB_URL = 'https://mini.test/platform/svc/auto-support';

function make(opts) {
  const storeCalls = [], hubCalls = [], cache = {};
  const props = Object.assign({}, opts.props || {});
  const sheets = opts.sheets;
  const fakeSheet = (rows) => { const H = [...new Set(rows.flatMap(o => Object.keys(o)))];
    return { rows, getLastRow: () => rows.length + 1, getLastColumn: () => H.length,
             getRange: (r, c, nr) => ({ getValues: () => r === 1 ? [H] : rows.slice(r - 2, r - 2 + nr).map(o => H.map(h => o[h])) }) }; };
  const ssOf = (code) => ({ getSheetByName: (nm) => (sheets[code] && sheets[code][nm]) ? fakeSheet(sheets[code][nm]) : null });
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12 },
    LINE_HUB_STORES_CONFIG: STORES.map(s => ({ code: s.code, name: s.name, api: 'https://' + (s.code || 'gf') + '/exec', ss_id: 'SS_' + s.code, lat: s.lat, lng: s.lng, radius_m: s.radius_m })),
    LINE_HUB_BOT_TOKEN: 'BOT',
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.indexOf('api.line.me/oauth2') >= 0) {
          const t = o.payload.id_token; const good = t.indexOf('TOK_') === 0;
          return { getResponseCode: () => good ? 200 : 400, getContentText: () => JSON.stringify(good ? { sub: t.slice(4), aud: '2011292256' } : {}) };
        }
        if (url === HUB_URL) {
          const body = JSON.parse(o.payload); hubCalls.push({ url, body, opts: o });
          if (opts.hubThrow) throw new Error('連不上');
          const rep = opts.hubReply ? opts.hubReply(body) : { ok: true, emp_id: 'J1' };
          return { getContentText: () => typeof rep === 'string' ? rep : JSON.stringify(rep) };
        }
        if (url.indexOf('/v2/bot/info') >= 0) return { getContentText: () => JSON.stringify({ userId: 'BOTU' }) };
        const body = JSON.parse(o.payload); storeCalls.push({ url, body });
        return { getContentText: () => JSON.stringify(storeReply(body)) };
      },
    },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; }, removeAll: (ks) => ks.forEach(k => { delete cache[k]; }) }) },
    getSS: () => ssOf(''),
    SpreadsheetApp: { openById: (id) => ssOf(id.replace('SS_', '')) },
    readSheetAsObjects: (sh) => ({ rows: sh.rows.map(r => Object.assign({}, r)) }),
    normCellTs: (v) => v,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map(b => (b > 127 ? b - 256 : b)),   // GAS 的 byte 是有號數
      formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10); return f === 'yyyyMMdd' ? x.replace(/-/g, '') : x; },
    },
  };
  function storeReply(p) {
    if (p.action === 'liff_bind') {   // 模擬店端綁定：把金鑰對到的列寫上 line_user_id
      const row = Object.values(sheets).flatMap(s => s.roster || []).find(r => r.key === p.key);
      if (row) { row.line_user_id = 'U1'; return { ok: true }; }
      return { ok: false, error: 'bad_key' };
    }
    return { ok: true, status: 'ok', ts: iso(0) };
  }
  vm.createContext(sb); vm.runInContext(SRC, sb);
  sb.LIFF_HANDLERS.liff_bind = (p) => { storeCalls.push({ url: 'local', body: p }); return storeReply(p); };
  sb.LIFF_HANDLERS.liff_clock = (p) => { storeCalls.push({ url: 'local', body: p }); return { ok: true, status: 'ok', ts: iso(0) }; };
  return { sb, storeCalls, hubCalls, cache };
}
const hq = STORES.find(s => s.code === 'hq'), js = STORES.find(s => s.code === 'mztjs'), cf = STORES.find(s => s.code === 'cf');
const P = { STAFF_HUB_URL: HUB_URL, STAFF_HUB_KEY: 'TEST-HUB-KEY-0123456789' };
const R = (x) => Object.assign({ emp_id: 'H01', name: '測試甲', key: 'kH', active: 'true', line_user_id: 'U1', device_id: 'DEV' }, x || {});
const punch = (m, store) => m.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: (store || js).lat, lng: (store || js).lng, accuracy: 10 });
// 預設情境：測試甲 U1 只綁在總部；人在金山；金山名冊沒有他。mini 回 ok 時代為建列（模擬 svc_add）。
function scene(extra) {
  const sheets = { hq: { roster: [R()], events: [] }, mztjs: { roster: [], events: [] } };
  const o = Object.assign({ sheets, props: P }, extra || {});
  if (!o.hubReply) o.hubReply = () => { sheets.mztjs.roster.push({ emp_id: 'J1', name: '測試甲', key: 'kJ', active: 'true', line_user_id: '', created_by: 'LINE 自動（首次支援）' }); return { ok: true, emp_id: 'J1' }; };
  return make(o);
}
const NOT_BOUND = (r) => assert.strictEqual(r.result.code, 'not_bound');

ok('成立：mini 恰好呼叫一次（op_id 照契約）→ liff_bind → liff_clock，回覆加「第一次支援」那句', () => {
  const m = scene();
  const r = punch(m);
  assert.strictEqual(m.hubCalls.length, 1);
  const b = m.hubCalls[0].body;
  const sha12 = crypto.createHash('sha256').update('U1').digest('hex').slice(0, 12);
  assert.deepStrictEqual(Object.keys(b).sort(), ['hub_key', 'op_id', 'src_emp_id', 'src_store', 'store_code']);
  assert.strictEqual(b.hub_key, P.STAFF_HUB_KEY); assert.strictEqual(b.store_code, 'mztjs');
  assert.strictEqual(b.src_store, 'hq'); assert.strictEqual(b.src_emp_id, 'H01');
  assert.strictEqual(b.op_id, 'hub:mztjs:' + sha12 + ':20261008');
  assert(/^hub:(gf|mztjs|mztgf|mztlzl|hq|cf):[0-9a-f]{12}:\d{8}$/.test(b.op_id));
  assert.deepStrictEqual(m.storeCalls.map(c => c.body.action), ['liff_bind', 'liff_clock']);
  assert.strictEqual(m.storeCalls[0].body.key, 'kJ');
  assert.strictEqual(r.result.ok, true);
  assert(/已幫你加入「墨竹亭 新竹金山」名冊，第一次支援請跟值班主管說一聲/.test(r.text), r.text);
});
ok('成立之後同一個人再打卡（已綁定）→ 不再呼叫 mini、沒有「第一次支援」那句', () => {
  const m = scene(); punch(m);
  m.storeCalls.length = 0; m.cache = {};
  const r = punch(m);
  assert.strictEqual(m.hubCalls.length, 1, '仍然只有第一次那一通');
  assert(!/第一次支援/.test(r.text));
});
ok('未設屬性（兩個都沒設／只設一個）→ 完全不呼叫 mini，回原本 not_bound', () => {
  [{}, { STAFF_HUB_URL: HUB_URL }, { STAFF_HUB_KEY: 'K' }].forEach(props => {
    const m = scene({ props }); const r = punch(m);
    assert.strictEqual(m.hubCalls.length, 0); NOT_BOUND(r); assert.strictEqual(m.storeCalls.length, 0);
    assert(/輸入你的全名/.test(r.text));
  });
});
ok('條件不成立（各一）→ 不呼叫 mini，走回原流程', () => {
  // (a) B 店已有同名在職、未綁 → 原本的 suggest_name 流程
  let m = scene(); m.sb.__x = 0;
  const a = make({ props: P, sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J9', key: 'kJ9', line_user_id: '' })] } } });
  let r = punch(a); assert.strictEqual(a.hubCalls.length, 0); NOT_BOUND(r); assert.strictEqual(r.result.suggest_name, '測試甲');
  // (b) B 店已有同名在職、已被別的 LINE 綁
  const b = make({ props: P, sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J9', line_user_id: 'U_OTHER' })] } } });
  r = punch(b); assert.strictEqual(b.hubCalls.length, 0); NOT_BOUND(r);
  // (c) 這個 LINE 在別家沒有任何綁定
  const c = make({ props: P, sheets: { hq: { roster: [R({ line_user_id: '' })] }, mztjs: { roster: [] } } });
  r = punch(c); assert.strictEqual(c.hubCalls.length, 0); NOT_BOUND(r);
  // (d) 別家的綁定已離職（不在職）
  const d = make({ props: P, sheets: { hq: { roster: [R({ active: 'false' })] }, mztjs: { roster: [] } } });
  r = punch(d); assert.strictEqual(d.hubCalls.length, 0); NOT_BOUND(r);
  // (e) 在別家「不只一家」綁定（不是恰好一家）
  const e = make({ props: P, sheets: { hq: { roster: [R()] }, cf: { roster: [R({ emp_id: 'C01', key: 'kC' })] }, mztjs: { roster: [] } } });
  r = punch(e); assert.strictEqual(e.hubCalls.length, 0); NOT_BOUND(r);
  // (f) 姓名不唯一（同一個 LINE 在別家綁了兩個不同名字）
  const f = make({ props: P, sheets: { hq: { roster: [R(), R({ emp_id: 'H02', name: '測試乙', key: 'kH2' })] }, mztjs: { roster: [] } } });
  r = punch(f); assert.strictEqual(f.hubCalls.length, 0); NOT_BOUND(r);
  // (g) 定位分不出是哪一家／不在任何店 → 不是「唯一命中 B 店」
  const g = scene(); const out = g.sb.handleLineQuickClock_({ id_token: 'TOK_U1', lat: 0, lng: 0, accuracy: 10 });
  assert.strictEqual(g.hubCalls.length, 0); assert.strictEqual(out.result.code, 'out_of_range');
  // (h) 這個 LINE 在 B 店已綁定 → 正常打卡，不問 mini
  const h = make({ props: P, sheets: { hq: { roster: [R()] }, mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ' })], events: [] } } });
  r = punch(h); assert.strictEqual(h.hubCalls.length, 0); assert.strictEqual(r.result.ok, true);
  // (i) 查詢類入口（line_hub_status 走 lineHubResolve_ 但不帶 autoSupport）不得觸發
  const i = scene(); const st = i.sb.lineHubResolve_('U1', { lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(i.hubCalls.length, 0); assert.strictEqual(st.fail.code, 'not_bound');
});
ok('mini 不通／denied／回壞資料／ok 但綁不起來 → 回原本「名冊上沒有你」訊息，不打卡', () => {
  [{ hubReply: () => ({ ok: false, error: 'not_confirmed' }) }, { hubThrow: true }, { hubReply: () => '<html>502</html>' },
   { hubReply: () => ({ ok: false }) }, { hubReply: () => ({}) }, { hubReply: () => ({ ok: 'true' }) },
   { hubReply: () => ({ ok: true, emp_id: 'J1' }) /* mini 說 ok 但名冊沒出現這個人 → bind 不成立 */ }].forEach((o, k) => {
    const m = scene(o); const r = punch(m);
    assert.strictEqual(m.hubCalls.length, 1, '情況 ' + k + ' 有呼叫一次');
    NOT_BOUND(r); assert(/名冊上沒有你/.test(r.text), r.text);
    assert(!m.storeCalls.some(c => c.body.action === 'liff_clock'), '不得打卡');
    assert(!/第一次支援/.test(r.text));
  });
});
ok('store_code 對照表：光復（空字串）→ gf，其餘同名；涵蓋 stores.json 全部店且只用契約的六個', () => {
  const { sb } = make({ sheets: {} });
  const map = vm.runInContext('LINE_HUB_STAFF_CODE_MAP', sb);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map)), { '': 'gf', mztjs: 'mztjs', mztgf: 'mztgf', mztlzl: 'mztlzl', hq: 'hq', cf: 'cf' });
  STORES.forEach(s => assert(map[s.code] !== undefined, s.code));
  assert.deepStrictEqual(Object.values(map).sort(), ['cf', 'gf', 'hq', 'mztgf', 'mztjs', 'mztlzl']);
});
ok('光復端從光復店出發也能用 gf（B 店＝光復、home＝金山）', () => {
  const sheets = { '': { roster: [], events: [] }, mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ' })] } };
  const gf = STORES.find(s => s.code === '');
  const m = make({ props: P, sheets, hubReply: () => { sheets[''].roster.push({ emp_id: 'E01', name: '測試甲', key: 'kE', active: 'true', line_user_id: '', created_by: 'LINE 自動（首次支援）' }); return { ok: true }; } });
  const r = punch(m, gf);
  assert.strictEqual(m.hubCalls[0].body.store_code, 'gf'); assert.strictEqual(m.hubCalls[0].body.src_store, 'mztjs');
  assert(/^hub:gf:/.test(m.hubCalls[0].body.op_id)); assert.strictEqual(r.result.ok, true);
});
ok('光復專案的 LINE 相關檔案裡不得出現 STAFF_SVC_KEY（只持 HUB 金鑰）', () => {
  ['LineHub.gs', 'LineHubConfig.example.gs', 'Liff.gs', 'Code.gs'].forEach(f =>
    assert(!/STAFF_SVC_KEY/.test(fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')), f));
  assert(/STAFF_HUB_KEY/.test(LH) && /STAFF_HUB_URL/.test(LH));
});
console.log(`\n✅ ${n} 項通過`);
