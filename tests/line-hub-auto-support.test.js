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
      computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', String(k)).update(String(v)).digest()).map(b => (b > 127 ? b - 256 : b)),
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
  if (!o.hubReply) o.hubReply = () => { sheets.mztjs.roster.push({ emp_id: 'J1', name: '測試甲（平台姓名）', key: 'kJ', active: 'true', line_user_id: '', created_by: 'LINE 自動（首次支援）' }); return { ok: true, emp_id: 'J1' }; };
  return Object.assign(make(o), { sheets });
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
  assert(/^hub:(gf|mztjs|mztgf|mztlzl|mztmc|mztrg|mztwx|hq|cf):[0-9a-f]{12}:\d{8}$/.test(b.op_id));
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
ok('#26 綁定靠 mini 回的 emp_id 與該列 key，不靠姓名（平台姓名與 home 不同也綁得上；綁的是 mini 指的那一列）', () => {
  const sheets = { hq: { roster: [R()], events: [] }, mztjs: { roster: [{ emp_id: 'J7', name: '測試丙', key: 'kOLD', active: 'true', line_user_id: 'U_OTHER' }], events: [] } };
  const m = make({ props: P, sheets, hubReply: () => { sheets.mztjs.roster.push({ emp_id: 'J8', name: '完全不同的平台姓名', key: 'kNEW', active: 'true', line_user_id: '', created_by: 'LINE 自動（首次支援）' }); return { ok: true, emp_id: 'J8' }; } });
  const r = punch(m);
  assert.strictEqual(m.hubCalls.length, 1);
  assert.strictEqual(m.storeCalls[0].body.action, 'liff_bind'); assert.strictEqual(m.storeCalls[0].body.key, 'kNEW');
  assert.strictEqual(r.result.ok, true);
});
ok('#26 mini 回 ok 但沒給 emp_id／給的列不存在／已離職／已綁別人 → 不綁、不打卡', () => {
  [{ ok: true }, { ok: true, emp_id: 'NOPE' }, { ok: true, emp_id: 'J1', _row: { active: 'false' } }, { ok: true, emp_id: 'J1', _row: { line_user_id: 'U_X' } }].forEach((rep, k) => {
    const sheets = { hq: { roster: [R()], events: [] }, mztjs: { roster: [], events: [] } };
    const m = make({ props: P, sheets, hubReply: () => { sheets.mztjs.roster.push(Object.assign({ emp_id: 'J1', name: '測試甲', key: 'kJ', active: 'true', line_user_id: '' }, rep._row)); return { ok: rep.ok, emp_id: rep.emp_id }; } });
    const r = punch(m);
    assert(!m.storeCalls.some(c => c.body.action === 'liff_bind' || c.body.action === 'liff_clock'), '情況 ' + k);
    NOT_BOUND(r);
  });
});
ok('#27 B 店名冊有任何列（含離職）已綁這個 LINE → 不問 mini，回原訊息', () => {
  const m = make({ props: P, sheets: { hq: { roster: [R()], events: [] }, mztjs: { roster: [{ emp_id: 'J1', name: '測試甲', key: 'kJ', active: 'false', line_user_id: 'U1' }], events: [] } } });
  const r = punch(m); assert.strictEqual(m.hubCalls.length, 0); NOT_BOUND(r);
  assert.strictEqual(m.storeCalls.length, 0);
});
ok('G10 不採用 lineHubMine_ 快取：來源列已離職／已改綁別的 LINE → 不問 mini', () => {
  [{ active: 'false' }, { line_user_id: 'U_NEW' }].forEach((chg, k) => {
    const m = scene();
    assert.strictEqual(m.sb.lineHubMine_('U1').length, 1, '先把快取養起來');
    Object.assign(m.sheets.hq.roster[0], chg);   // 快取仍說「已綁」，但來源列實際已變
    const r = punch(m);
    assert.strictEqual(m.hubCalls.length, 0, '情況 ' + k); NOT_BOUND(r);
  });
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
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map)), { '': 'gf', mztjs: 'mztjs', mztgf: 'mztgf', mztlzl: 'mztlzl', mztmc: 'mztmc', mztrg: 'mztrg', mztwx: 'mztwx', hq: 'hq', cf: 'cf' });
  STORES.forEach(s => assert(map[s.code] !== undefined, s.code));
  assert.deepStrictEqual(Object.values(map).sort(), ['cf', 'gf', 'hq', 'mztgf', 'mztjs', 'mztlzl', 'mztmc', 'mztrg', 'mztwx']);
});
ok('光復端從光復店出發也能用 gf（B 店＝光復、home＝央廚）', () => {
  const sheets = { '': { roster: [], events: [] }, cf: { roster: [R({ emp_id: 'C1', key: 'kC' })] } };
  const gf = STORES.find(s => s.code === '');
  const m = make({ props: P, sheets, hubReply: () => { sheets[''].roster.push({ emp_id: 'E01', name: '測試甲（平台姓名）', key: 'kE', active: 'true', line_user_id: '', created_by: 'LINE 自動（首次支援）' }); return { ok: true, emp_id: 'E01' }; } });
  const r = punch(m, gf);
  assert.strictEqual(m.hubCalls[0].body.store_code, 'gf'); assert.strictEqual(m.hubCalls[0].body.src_store, 'cf');
  assert(/^hub:gf:/.test(m.hubCalls[0].body.op_id)); assert.strictEqual(r.result.ok, true);
});
// 禁止跨品牌（2026-11-06 Eason）：小辛辣 ↔ 墨竹亭不能互相自動加入；央廚、總部兩邊都可以
ok('跨品牌：墨竹亭同仁在小辛辣光復 → 不呼叫 mini、回 cross_brand「你是墨竹亭的同仁」', () => {
  const sheets = { '': { roster: [], events: [] }, mztjs: { roster: [R({ emp_id: 'J1', key: 'kJ' })] } };
  const gf = STORES.find(s => s.code === '');
  const m = make({ props: P, sheets });
  const r = punch(m, gf);
  assert.strictEqual(m.hubCalls.length, 0); assert.strictEqual(r.result.code, 'cross_brand');
  assert(/你是墨竹亭的同仁，不能在「小辛辣 新竹光復」打卡/.test(r.result.reason), r.result.reason);
});
ok('跨品牌：小辛辣同仁在墨竹亭金山 → 擋；就算沒開 7A（沒設屬性）也講清楚原因', () => {
  const sheets = { '': { roster: [R({ emp_id: 'E01', key: 'kE' })], events: [] }, mztjs: { roster: [], events: [] } };
  const m = make({ props: {}, sheets });
  const r = punch(m, js);
  assert.strictEqual(m.hubCalls.length, 0); assert.strictEqual(r.result.code, 'cross_brand');
  assert(/你是小辛辣的同仁/.test(r.result.reason), r.result.reason);
});
ok('品牌：光復 sxl、mzt 開頭 mzt、央廚與總部不屬於任何品牌（兩邊都可以）', () => {
  const { sb } = make({ sheets: {} });
  const B = (code) => sb.lineHubBrand_({ code, ss_id: 'SS_' + code });
  assert.deepStrictEqual(['', 'mztjs', 'mztgf', 'mztwx', 'cf', 'hq'].map(B), ['sxl', 'mzt', 'mzt', 'mzt', '', '']);
  assert.strictEqual(sb.lineHubCrossBrand_({ code: 'cf' }, { code: '' }), false);
  assert.strictEqual(sb.lineHubCrossBrand_({ code: 'mztjs' }, { code: 'mztgf' }), false);
  assert.strictEqual(sb.lineHubCrossBrand_({ code: 'mztjs' }, { code: '' }), true);
});
ok('品牌：薪資門市表的 brand 欄優先（用打卡試算表 ID 對 clock_ss_id）；沒填才看店代碼', () => {
  const { sb } = make({ sheets: {} });
  sb.payStoreList = () => [{ code: 'MZTWX', clock_ss_id: 'SS_mztwx', brand: 'sxl' }, { code: 'MZTJS', clock_ss_id: 'SS_mztjs', brand: '' }];
  assert.strictEqual(sb.lineHubBrand_({ code: 'mztwx', ss_id: 'SS_mztwx' }), 'sxl');
  assert.strictEqual(sb.lineHubBrand_({ code: 'mztjs', ss_id: 'SS_mztjs' }), 'mzt');
});
ok('光復專案的 LINE 相關檔案裡不得出現 STAFF_SVC_KEY（只持 HUB 金鑰）', () => {
  ['LineHub.gs', 'LineHubConfig.example.gs', 'Liff.gs', 'Code.gs'].forEach(f =>
    assert(!/STAFF_SVC_KEY/.test(fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')), f));
  assert(/STAFF_HUB_KEY/.test(LH) && /STAFF_HUB_URL/.test(LH));
});

/* ── 2026-11-06 跨單位第一次綁定（lineHubBindElsewhere_）── */
const bind = (m, extra, store) => m.sb.handleLineBindName_(Object.assign({ id_token: 'TOK_U1', name: '測試 甲', lat: (store || js).lat, lng: (store || js).lng, accuracy: 10 }, extra || {}));
ok('沒綁過 LINE、名字在總部：先回 confirm_home（不綁、不問 mini）；本人確認後綁總部那列→7A 加入金山', () => {
  const m = scene(); m.sheets.hq.roster[0].line_user_id = '';
  const a = bind(m);
  assert.strictEqual(a.error, 'confirm_home'); assert.strictEqual(a.confirm, 'hq|H01');
  assert.strictEqual(a.home_store_name, '鼎兆元 總部'); assert.strictEqual(a.name, '測試甲'); assert.strictEqual(a.store_name, '墨竹亭 新竹金山');
  assert.strictEqual(m.storeCalls.length, 0); assert.strictEqual(m.hubCalls.length, 0);
  const b = bind(m, { confirm_home: 'hq|H01' });
  assert.strictEqual(b.ok, true, JSON.stringify(b)); assert.strictEqual(b.first_support, true);
  assert.deepStrictEqual(m.storeCalls.map(c => [c.url, c.body.action, c.body.key, c.body.via]),
    [['https://hq/exec', 'liff_bind', 'kH', 'name'], ['https://mztjs/exec', 'liff_bind', 'kJ', 'auto']]);
  assert.strictEqual(m.hubCalls.length, 1); assert.strictEqual(m.hubCalls[0].body.src_store, 'hq');
});
ok('確認碼不對（或被竄改成別人）→ 仍只回 confirm_home，不綁', () => {
  const m = scene(); m.sheets.hq.roster[0].line_user_id = '';
  ['hq|H99', 'cf|H01', 'x'].forEach(t => { const r = bind(m, { confirm_home: t }); assert.strictEqual(r.error, 'confirm_home'); });
  assert.strictEqual(m.storeCalls.length, 0); assert.strictEqual(m.hubCalls.length, 0);
});
ok('已在總部綁定同名 → 不用確認，直接 7A 加入', () => {
  const m = scene(); const r = bind(m);
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(r.first_support, true);
  assert.deepStrictEqual(m.storeCalls.map(c => c.body.action), ['liff_bind']);
  assert.strictEqual(m.hubCalls.length, 1);
});
ok('兩個單位都有同名在職 → name_conflict，不綁', () => {
  const m = make({ props: P, sheets: { hq: { roster: [R({ line_user_id: '' })] }, cf: { roster: [R({ emp_id: 'C01', key: 'kC', line_user_id: '' })] }, mztjs: { roster: [] } } });
  const r = bind(m); assert.strictEqual(r.error, 'name_conflict'); assert.strictEqual(m.storeCalls.length, 0);
});
ok('各單位都沒有 → name_not_found，請主管到管理系統建檔', () => {
  const all = {}; STORES.forEach(st => { all[st.code] = { roster: [] }; });
  const m = make({ props: P, sheets: all });
  const r = bind(m); assert.strictEqual(r.error, 'name_not_found'); assert(/管理系統/.test(r.message), r.message);
  // 有一家名冊讀不到、其他都沒有 → 請稍後再試（不能說「公司沒有你」）
  const m2 = make({ props: P, sheets: all }); const open0 = m2.sb.SpreadsheetApp.openById;
  m2.sb.SpreadsheetApp = { openById: (id) => { if (id === 'SS_cf') throw new Error('連不上'); return open0(id); } };
  assert.strictEqual(bind(m2).error, 'unreachable');
});
ok('原單位那列已綁別的 LINE → name_taken，不綁', () => {
  const m = make({ props: P, sheets: { hq: { roster: [R({ line_user_id: 'U_OTHER' })] }, mztjs: { roster: [] } } });
  const r = bind(m); assert.strictEqual(r.error, 'name_taken'); assert.strictEqual(m.storeCalls.length, 0);
});
ok('跨品牌：小辛辣光復的人在墨竹亭金山 → cross_brand，不綁', () => {
  const m = make({ props: P, sheets: { '': { roster: [R({ emp_id: 'E01', key: 'kE', line_user_id: '' })] }, mztjs: { roster: [] } } });
  const r = bind(m); assert.strictEqual(r.error, 'cross_brand'); assert(/你是小辛辣的同仁/.test(r.message));
  assert.strictEqual(m.storeCalls.length, 0); assert.strictEqual(m.hubCalls.length, 0);
});
ok('確認後原單位綁好、但管理系統不讓加入 → support_failed（訊息講清楚已綁原單位）', () => {
  const m = scene({ hubReply: () => ({ ok: false, error: 'not_confirmed' }) }); m.sheets.hq.roster[0].line_user_id = '';
  const r = bind(m, { confirm_home: 'hq|H01' });
  assert.strictEqual(r.error, 'support_failed'); assert.strictEqual(r.home_bound, true);
  assert(/已綁定你在「鼎兆元 總部」/.test(r.message), r.message);
  assert.strictEqual(m.sheets.hq.roster[0].line_user_id, 'U1');
});
ok('開頁（line_hub_status）：已在總部綁定、金山名冊沒有 → 綁定框帶出名字與原單位，不自動加入', () => {
  const m = scene();
  const r = m.sb.handleLineHubStatus_({ id_token: 'TOK_U1', lat: js.lat, lng: js.lng, accuracy: 10 });
  assert.strictEqual(r.result.code, 'not_bound'); assert.strictEqual(r.result.suggest_name, '測試甲');
  assert.strictEqual(r.result.support_from, '鼎兆元 總部'); assert.strictEqual(m.hubCalls.length, 0);
});
/* ── 2026-11-10 綁定碼（LINE_BIND_CODE_ON）── */
const ON = Object.assign({ LINE_BIND_CODE_ON: '1' }, P);
const atHome = (m, extra) => bind(m, Object.assign({ name: '測試 乙' }, extra || {}));
const homeScene = (props) => {
  const sheets = { hq: { roster: [] }, mztjs: { roster: [{ emp_id: 'J2', name: '測試乙', key: 'kJ2', active: 'true', line_user_id: '' }] } };
  return Object.assign(make({ sheets, props }), { sheets });
};
const code = (m, key, ago) => m.sb.lineBindCode_(key, m.sb.lineBindYmd_(ago || 0));
ok('綁定碼：開關沒開，流程完全照舊', () => {
  const m = homeScene(P); const r = atHome(m);
  assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(m.storeCalls[0].body.key, 'kJ2');
});
ok('綁定碼：開關打開、沒帶碼 → 不綁，回 bind_code_required', () => {
  const m = homeScene(ON); const r = atHome(m);
  assert.strictEqual(r.error, 'bind_code_required'); assert.strictEqual(m.storeCalls.length, 0);
  assert.strictEqual(m.sheets.mztjs.roster[0].line_user_id, '');
});
ok('綁定碼：別人的碼或亂猜 → bind_code_wrong，不綁', () => {
  const m = homeScene(ON);
  [code(m, 'kOther'), '000000', 'abcdef', '12345'].forEach(c => {
    m.cache && Object.keys(m.cache).forEach(k => delete m.cache[k]);
    const r = atHome(m, { bind_code: c }); assert.strictEqual(r.error, 'bind_code_wrong', c + JSON.stringify(r));
  });
  assert.strictEqual(m.storeCalls.length, 0);
});
ok('綁定碼：今天和昨天的碼可用，前天的不行', () => {
  [[0, true], [1, true], [2, false]].forEach(([ago, good]) => {
    const m = homeScene(ON); const r = atHome(m, { bind_code: code(m, 'kJ2', ago) });
    assert.strictEqual(r.ok === true, good, ago + JSON.stringify(r));
  });
});
ok('綁定碼：同名已綁在別店的人也要碼（同名不代表同一人）', () => {
  const sheets = { hq: { roster: [R({ name: '測試乙' })] }, mztjs: { roster: [{ emp_id: 'J2', name: '測試乙', key: 'kJ2', active: 'true', line_user_id: '' }] } };
  const m = Object.assign(make({ sheets, props: ON }), { sheets });
  assert.strictEqual(atHome(m).error, 'bind_code_required');
  assert.strictEqual(m.sheets.mztjs.roster[0].line_user_id, '');
  const r = atHome(m, { bind_code: code(m, 'kJ2') }); assert.strictEqual(r.ok, true, JSON.stringify(r));
});
ok('綁定碼：名字在別單位時，沒帶碼也不回確認資訊', () => {
  const m = scene({ props: ON }); m.sheets.hq.roster[0].line_user_id = '';
  const a = bind(m); assert.strictEqual(a.error, 'bind_code_required');
  const b = bind(m, { bind_code: code(m, 'kH') }); assert.strictEqual(b.error, 'confirm_home');
  const c = bind(m, { bind_code: code(m, 'kH'), confirm_home: 'hq|H01' }); assert.strictEqual(c.ok, true, JSON.stringify(c));
});
ok('店長產生綁定碼：要主管金鑰、停用與已綁定不給碼、不回金鑰', () => {
  const logged = [];
  const sheets = { '': { managers: [{ name: '店長', key: 'MK', active: 'true' }], roster: [
    { emp_id: 'A', name: '未綁', key: 'kA', active: 'true', line_user_id: '' },
    { emp_id: 'B', name: '已綁', key: 'kB', active: 'true', line_user_id: 'U9' },
    { emp_id: 'C', name: '停用', key: 'kC', active: 'false', line_user_id: '' }] } };
  const m = make({ sheets, props: P });
  m.sb.findManagerByKey = (rows, k) => rows.filter(r => r.key === k)[0];
  m.sb.actingName_ = (b, mgr) => mgr.name;
  m.sb.logLiffBind_ = (...a) => logged.push(a);
  const call = (b) => m.sb.handleMgrBindCode_(Object.assign({ mgr_key: 'MK' }, b));
  assert.strictEqual(m.sb.handleMgrBindCode_({ mgr_key: 'x', emp_id: 'A' }).error, 'unauthorized');
  const a = call({ emp_id: 'A' }); assert.strictEqual(a.code, code(m, 'kA')); assert(/^\d{6}$/.test(a.code)); assert(!JSON.stringify(a).includes('kA'));
  assert.deepStrictEqual(logged[0].slice(0, 2).concat(logged[0][3]), ['A', '未綁', 'code_issued']);
  assert.strictEqual(call({ emp_id: 'B' }).already, true); assert.strictEqual(call({ emp_id: 'B' }).code, undefined);
  assert.strictEqual(call({ emp_id: 'C' }).error, 'inactive'); assert.strictEqual(call({ emp_id: 'Z' }).error, 'not_found');
});
ok('綁定碼畫面：平常藏著，後端要求才顯示', () => {
  const h = fs.readFileSync(ROOT + '/clock-line.html', 'utf8');
  assert(/id="bindCode"[^>]*hidden/.test(h)); assert(/bind_code: \$\('bindCode'\)\.value\.trim\(\)/.test(h));
  assert(/bind_code_required/.test(h));
});

// ── 2026-11-12 串接驗收（四系統 DZY900 整月實跑）抓到：跨品牌只在「恰好綁一家」且「這家店沒同名」時才擋 ──
ok('串接 A1：已綁光復＋央廚兩家的小辛辣同仁到墨竹亭金山打卡 → cross_brand（原本回 not_bound）', () => {
  const sheets = { '': { roster: [R({ emp_id: 'E01', key: 'kE' })], events: [] }, cf: { roster: [R({ emp_id: 'C1', key: 'kC' })], events: [] }, mztjs: { roster: [], events: [] } };
  const m = make({ props: P, sheets });
  const r = punch(m, js);
  assert.strictEqual(r.result.code, 'cross_brand', JSON.stringify(r.result));
  assert(/你是小辛辣的同仁/.test(r.result.reason), r.result.reason);
  assert.strictEqual(m.hubCalls.length, 0); assert.strictEqual(m.storeCalls.length, 0);
});
ok('串接 A2：墨竹亭金山名冊剛好有同名未綁的人，小辛辣同仁打卡與輸入全名綁定都要擋 cross_brand（原本綁得起來、打得進去）', () => {
  const sheets = { '': { roster: [R({ emp_id: 'E01', key: 'kE' })], events: [] }, mztjs: { roster: [R({ emp_id: 'J9', key: 'kJ9', line_user_id: '' })], events: [] } };
  const m = make({ props: P, sheets });
  const r = punch(m, js);
  assert.strictEqual(r.result.code, 'cross_brand', JSON.stringify(r.result));
  const b = bind(m);
  assert.strictEqual(b.error, 'cross_brand', JSON.stringify(b));
  assert.strictEqual(m.sheets === undefined ? sheets.mztjs.roster[0].line_user_id : sheets.mztjs.roster[0].line_user_id, '', '金山那列不能被綁走');
  assert.strictEqual(m.storeCalls.length, 0);
});
ok('串接 A3：已綁光復＋央廚，到金山（名冊沒他）輸入全名 → cross_brand（原本回 name_conflict 還請主管「協助加入」）', () => {
  const sheets = { '': { roster: [R({ emp_id: 'E01', key: 'kE' })], events: [] }, cf: { roster: [R({ emp_id: 'C1', key: 'kC' })], events: [] }, mztjs: { roster: [], events: [] } };
  const m = make({ props: P, sheets });
  const b = bind(m);
  assert.strictEqual(b.error, 'cross_brand', JSON.stringify(b));
  assert.strictEqual(m.hubCalls.length, 0);
});
ok('串接 A4：綁央廚＋總部（不屬任何品牌）的人到金山 → 不擋跨品牌，照舊走 not_bound／7A', () => {
  const sheets = { cf: { roster: [R({ emp_id: 'C1', key: 'kC' })], events: [] }, hq: { roster: [R()], events: [] }, mztjs: { roster: [], events: [] } };
  const m = make({ props: {}, sheets });
  const r = punch(m, js);
  assert.notStrictEqual(r.result.code, 'cross_brand', JSON.stringify(r.result));
});
console.log(`\n✅ ${n} 項通過`);
