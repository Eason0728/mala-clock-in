// 不到場加綁主店（LineHub.gs lineHubBindHomeAuto_，2026-11-27）測試用的假 Apps Script 環境（不是測試）。
// 一律假名、假工號。LINE 身分：id_token 'TOK_<uid>' 才算驗過。
// 店端 liff_bind 照 Liff.gs liffBindLocked_ 的規則模擬（一支 LINE 一個在職列、目標已綁別人擋、同一組回 already），
// 紀錄類型用真的 liffBindFromStore_ 組 bind_name@…（跟店端同一支）。
// LINE_BIND_HOME_SRC（環境變數）可換 LineHub.gs 來源（變異測試、等價測試用）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const STORES = require(ROOT + '/tools/stores.json');
const NOW = Date.parse('2026-11-27T10:00:00+08:00');
const isoAgo = (days) => new Date(NOW - days * 86400000 + 8 * 3600000).toISOString().replace('Z', '+08:00');

function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}

// 薪資門市表（假）：總部三個名單單位 HQ／SSLHQ／MZTHQ 共用總部打卡表；光復 clock_ss_id 空白＝本系統試算表
function payStores(over) {
  const base = [
    { code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', active: 'true', brand: 'sxl' },
    { code: 'MZTJS', name: '墨竹亭金山', clock_ss_id: 'SS_mztjs', active: 'true', brand: 'mzt' },
    { code: 'MZTGF', name: '墨竹亭光復', clock_ss_id: 'SS_mztgf', active: 'true', brand: 'mzt' },
    { code: 'MZTLZL', name: '墨竹亭六張犁', clock_ss_id: 'SS_mztlzl', active: 'true', brand: 'mzt' },
    { code: 'HQ', name: '鼎兆元總部', clock_ss_id: 'SS_hq', active: 'true', brand: '' },
    { code: 'SSLHQ', name: '小辛辣品牌辦公室', clock_ss_id: 'SS_hq', active: 'true', brand: '' },
    { code: 'MZTHQ', name: '墨竹亭品牌辦公室', clock_ss_id: 'SS_hq', active: 'true', brand: '' },
    { code: 'CF', name: '央廚', clock_ss_id: 'SS_cf', active: 'true', brand: '' },
  ];
  return over ? over(base) : base;
}
const X = (emp_no, pay_store, acct_store, emp_id, extra) => Object.assign({ emp_no, pay_store, acct_store, emp_id, not_support: 'false',
  synced_at: isoAgo(1), state: 'confirmed', acct_only: '' }, extra || {});

/**
 * opts：
 *   sheets：{ 店代碼: { roster:[…], liff_bind_log:[…], events:[…] } }
 *   props：指令碼屬性
 *   xmap：payroll_xmap 列（undefined＝沒有這個分頁）；xmapThrow：讀的時候丟例外
 *   payStores：薪資門市表
 *   src：LineHub.gs 原始碼（預設工作目錄的；或 LINE_BIND_HOME_SRC）
 *   bindReply：(payload, defaultReply) => 回覆（模擬店端失敗）
 *   dutyMgrs：{ 店代碼: { emp_id: true } }（reqLocalDutyMgrs_）
 */
function make(opts) {
  opts = opts || {};
  const sheets = opts.sheets || {};
  const props = Object.assign({}, opts.props || {});
  const trace = [];            // 對外動作的順序紀錄（等價測試比這個）
  const cache = {}, pushes = [], storeCalls = [];
  const counters = { payRead: 0, payStoreList: 0, roster: 0, props: {} };
  const fakeSheet = (rows, nm) => {
    const H = [...new Set(rows.flatMap(o => Object.keys(o)))];
    return { __rows: rows, __name: nm, getLastRow: () => rows.length + 1, getLastColumn: () => Math.max(1, H.length),
      getRange: (r, c, nr) => ({ getValues: () => r === 1 ? [H] : rows.slice(r - 2, r - 2 + nr).map(o => H.map(h => o[h])) }) };
  };
  const ssOf = (code) => ({
    getId: () => 'SS_' + code,
    getSheetByName: (nm) => {
      trace.push('sheet:' + code + ':' + nm);
      if (code === '' && nm === 'payroll_xmap') return opts.xmap === undefined ? null : fakeSheet(opts.xmap, nm);
      return (sheets[code] && sheets[code][nm]) ? fakeSheet(sheets[code][nm], nm) : null;
    } });
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const LH = opts.src || (process.env.LINE_BIND_HOME_SRC ? fs.readFileSync(process.env.LINE_BIND_HOME_SRC, 'utf8') : fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8'));
  const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
  const SRC = [opts.liffSrc || fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), LH, extract(codeSrc, 'lastCountedEvent'), extract(codeSrc, 'normShiftTime')].join('\n');
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, Object, Array, RegExp, isNaN, isFinite, parseInt,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12 },
    LINE_HUB_STORES_CONFIG: STORES.map(s => ({ code: s.code, name: s.name, api: 'https://' + (s.code || 'gf') + '/exec', ss_id: s.code ? 'SS_' + s.code : '', lat: s.lat, lng: s.lng, radius_m: s.radius_m })),
    LINE_HUB_BOT_TOKEN: 'BOT',
    PAY_SHEET_NAME: { xmap: 'payroll_xmap', store: 'payroll_store' },
    PAY_DEFAULT_STORE: 'SSLGF',
    LEAVE_TYPES: ['特休假', '事假', '病假'],
    Logger: { log: (m) => trace.push('log:' + m) },
    spreadsheetId: () => 'SS_',
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => { trace.push('prop:' + k); counters.props[k] = (counters.props[k] || 0) + 1; return k in props ? props[k] : null; } }) },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.indexOf('api.line.me/oauth2') >= 0) {
          const t = String(o.payload.id_token || ''); const good = t.indexOf('TOK_') === 0;
          return { getResponseCode: () => good ? 200 : 400, getContentText: () => JSON.stringify(good ? { sub: t.slice(4), aud: '2011292256' } : {}) };
        }
        if (url.indexOf('api.line.me/v2/bot/message/push') >= 0) {
          const b = JSON.parse(o.payload); pushes.push(b); trace.push('push:' + b.to);
          return { getResponseCode: () => 200, getContentText: () => '{}' };
        }
        const body = JSON.parse(o.payload);
        const code = (STORES.find(s => 'https://' + (s.code || 'gf') + '/exec' === url) || {}).code;
        storeCalls.push({ code, body }); trace.push('store:' + code + ':' + body.action + ':' + JSON.stringify(body));
        return { getContentText: () => JSON.stringify(storeReply(code, body)) };
      },
    },
    CacheService: { getScriptCache: () => ({
      put: (k, v) => { trace.push('cput:' + k + '=' + v); cache[k] = String(v); },
      get: (k) => { trace.push('cget:' + k); return k in cache ? cache[k] : null; },
      putAll: (kv) => Object.keys(kv).forEach(k => { trace.push('cput:' + k); cache[k] = kv[k]; }),
      getAll: (ks) => { const o = {}; ks.forEach(k => { if (k in cache) o[k] = cache[k]; }); return o; },
      remove: (k) => { trace.push('crm:' + k); delete cache[k]; },
      removeAll: (ks) => ks.forEach(k => { trace.push('crm:' + k); delete cache[k]; }) }) },
    getSS: () => ssOf(''),
    SpreadsheetApp: { openById: (id) => ssOf(String(id).replace('SS_', '')) },
    readSheetAsObjects: (sh) => ({ rows: sh.__rows.map((r, i) => Object.assign({ __rowIndex: i + 2 }, r)) }),
    normCellTs: (v) => v,
    payRead: (kind) => {
      counters.payRead++; trace.push('payRead:' + kind);
      if (kind !== 'xmap') throw new Error('test: 沒預期讀 ' + kind);
      if (opts.xmapThrow) throw new Error('讀不到');
      return (opts.xmap || []).map(r => Object.assign({}, r));
    },
    payStoreList: () => { counters.payStoreList++; trace.push('payStoreList'); return (opts.payStores || payStores()).filter(s => String(s.active).toLowerCase() !== 'false').map(s => Object.assign({}, s)); },
    payLeaveTypes: () => [],
    Utilities: {
      formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyyMMdd' ? x.slice(0, 10).replace(/-/g, '') : x.slice(0, 10); },
    },
  };
  function storeReply(code, p) {
    if (p.action === 'liff_bind') {
      const uid = String(p.id_token || '').indexOf('TOK_') === 0 ? String(p.id_token).slice(4) : null;
      if (!uid) return { ok: false, error: 'invalid_id_token' };
      const rows = (sheets[code] && sheets[code].roster) || [];
      const target = rows.find(r => String(r.key) === String(p.key) && String(r.active).toLowerCase() === 'true');
      let rep;
      if (!target) rep = { ok: false, error: 'invalid_key' };
      else if (rows.some(r => r !== target && String(r.line_user_id || '') === uid)) rep = { ok: false, error: 'line_account_in_use' };
      else if (target.line_user_id && String(target.line_user_id) !== uid) rep = { ok: false, error: 'already_bound_other_user' };
      else if (String(target.line_user_id) === uid) rep = { ok: true, name: target.name, emp_id: target.emp_id, already: true };
      else rep = null;
      if (opts.bindReply) { const r2 = opts.bindReply(p, rep); if (r2) return r2; }
      if (rep) return rep;
      target.line_user_id = uid;
      let type = p.via === 'name' ? 'bind_name' : p.via === 'auto' ? 'bind_auto' : 'bind';
      if (type === 'bind_name') { const f = sb.liffBindFromStore_(p.via_store); if (f) type += '@' + f; }
      sheets[code] = sheets[code] || {}; (sheets[code].liff_bind_log = sheets[code].liff_bind_log || []).push({ ts: isoAgo(0), emp_id: target.emp_id, name: target.name, line_user_id: uid, type });
      return { ok: true, name: target.name, emp_id: target.emp_id };
    }
    return { ok: false, error: 'unknown_action' };
  }
  vm.createContext(sb); vm.runInContext(SRC, sb);
  // 光復本機（店代碼 ''）照 lineHubCallStore_ 直接呼叫 LIFF_HANDLERS
  sb.LIFF_HANDLERS.liff_bind = (p) => { storeCalls.push({ code: '', body: p }); trace.push('store::liff_bind:' + JSON.stringify(p)); return storeReply('', p); };
  const rosterRead = sb.lineHubRoster_;
  sb.lineHubRoster_ = (st) => { counters.roster++; trace.push('roster:' + st.code); if (opts.rosterThrow && opts.rosterThrow(st)) throw new Error('讀不到'); return rosterRead(st); };
  sb.lineHubPayPick_ = () => null;   // 申請頁的假別／額度不在本案範圍
  sb.reqLocalDutyMgrs_ = (ss) => ({ emps: (opts.dutyMgrs || {})[String(ss.getId()).replace('SS_', '')] || {} });
  return { sb, sheets, props, cache, trace, pushes, storeCalls, counters };
}

const R = (emp_id, name, extra) => Object.assign({ emp_id, name, key: 'k' + emp_id, active: 'true', line_user_id: '', src_store: '' }, extra || {});
const init = (m, tok, extra) => m.sb.handleLineHubReqInit_(Object.assign({ id_token: tok || 'TOK_U1', lite: true }, extra || {}));
const codes = (res) => (res && res.stores ? JSON.parse(JSON.stringify(res.stores.map(s => s.code))) : null);

module.exports = { make, R, X, init, codes, payStores, isoAgo, NOW, STORES, extract, ROOT };
