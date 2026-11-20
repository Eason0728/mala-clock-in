// 門鈴測試共用的假 Apps Script 環境（從 tests/duty-push.test.js 的 harness 原樣抄出，2026-11-20 live-prep 給 duty-push-live.test.js 用）。
// 只載 DutyFeed.gs 一支，其他檔的函式用假的；每一次碰到 Google 服務都記一行 log（用來逐次比對新舊版）。
// 這不是測試檔（run-all 只跑 *.test.js）。
'use strict';
const vm = require('vm'), crypto = require('crypto'), assert = require('assert');
const T0 = Date.parse('2026-11-10T10:00:00+08:00');
const signed = (b) => (b > 127 ? b - 256 : b);
const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
/**
 * 只載 DutyFeed.gs 一支，其他檔的函式用假的；每一次碰到 Google 服務都記一行 log（用來逐次比對新舊版）。
 * o: props, now, fetch(url,opt,h)→回應物件或丟錯, reqRows, hub（光復：有 lineHubStores_）, lockOk
 */
function harness(src, o) {
  o = o || {};
  const log = [], fetches = [], logs = [];
  const props = Object.assign({}, o.props || {});
  const cache = {};
  let uuidN = 0, rnd = 0;
  const h = { log, fetches, logs, props, cache, now: o.now || T0 };
  const sb = {
    console, JSON, String, Number, Object, Array, RegExp, Error, TypeError, isNaN, isFinite, parseInt, parseFloat, Boolean,
    Math: Object.assign(Object.create(Math), { random: () => ((rnd++ * 5) % 8 + 0.5) / 8 }),
  };
  sb.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(h.now); } static now() { return h.now; } };
  sb.PropertiesService = { getScriptProperties: () => { log.push('Props.getScriptProperties'); return {
    getProperty: (k) => { log.push('Props.getProperty:' + k); return props[k] === undefined ? null : props[k]; },
    setProperty: (k, v) => { log.push('Props.setProperty:' + k); props[k] = String(v); },
    getProperties: () => { log.push('Props.getProperties'); return Object.assign({}, props); },   // 2026-11-20 props-once：正式推送一次讀完
    deleteProperty: () => { log.push('Props.deleteProperty'); throw new Error('不該刪'); },
  }; } };
  sb.CacheService = { getScriptCache: () => { log.push('Cache.getScriptCache'); return {
    get: (k) => { log.push('Cache.get:' + k); const e = cache[k]; return e && e.exp > h.now ? e.v : null; },
    put: (k, v, ttl) => { log.push('Cache.put:' + k + ':' + ttl); cache[k] = { v: String(v), exp: h.now + ttl * 1000 }; },
    getAll: (ks) => { log.push('Cache.getAll:' + ks.length); const r = {}; ks.forEach((k) => { const e = cache[k]; if (e && e.exp > h.now) r[k] = e.v; }); return r; },
    putAll: () => { log.push('Cache.putAll'); throw new Error('不該用'); },
    remove: () => { log.push('Cache.remove'); throw new Error('不該用'); },
  }; } };
  sb.UrlFetchApp = { fetch: (url, opt) => {
    log.push('UrlFetch.fetch'); fetches.push({ url, opt });
    if (o.fetch) return o.fetch(url, opt, h);
    return resp(200, '{"ok":true}');
  } };
  sb.Utilities = {
    getUuid: () => { log.push('Utilities.getUuid'); const s = ('0000000' + (uuidN++)).slice(-8); return s + '-1111-2222-3333-444455556666'; },
    computeHmacSha256Signature: (v, k) => { log.push('Utilities.computeHmacSha256Signature'); return Array.from(crypto.createHmac('sha256', String(k)).update(String(v)).digest()).map(signed); },
    computeDigest: (alg, v) => { log.push('Utilities.computeDigest'); return Array.from(crypto.createHash(alg === 'MD5' ? 'md5' : 'sha256').update(String(v)).digest()).map(signed); },
    base64EncodeWebSafe: (b) => { log.push('Utilities.base64EncodeWebSafe'); return Buffer.from(b.map((x) => x & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); },
    DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  };
  sb.LockService = { getScriptLock: () => { log.push('Lock.getScriptLock'); return {
    tryLock: () => { log.push('Lock.tryLock'); return o.lockOk !== false; }, releaseLock: () => { log.push('Lock.releaseLock'); } }; } };
  // 2026-11-20 live-prep：正式推送前會 SpreadsheetApp.flush()（只准這一個；其餘一律丟錯）
  sb.SpreadsheetApp = new Proxy({}, { get: (t, k) => { log.push('SpreadsheetApp.' + String(k)); if (k === 'flush') return () => { if (o.flushMs) h.now += o.flushMs; if (o.flushThrows) throw new Error('flush 失敗'); }; throw new Error('不該用 SpreadsheetApp'); } });
  sb.Logger = { log: (...a) => { logs.push(a.map(String).join(' ')); } };
  const mgSheet = { name: 'managers' };
  const ss = { getSheetByName: (nm) => { log.push('ss.getSheetByName:' + nm); return nm === 'managers' ? mgSheet : null; } };
  sb.getSS = () => { log.push('getSS'); return ss; };
  sb.readSheetAsObjects = (sh) => { log.push('readSheetAsObjects:' + sh.name);
    return { headers: ['name', 'key', 'active', 'allow_acting', 'emp_id'], rows: [{ name: '假主管', key: 'AK', active: 'true', allow_acting: 'true', emp_id: '', __rowIndex: 2 }] }; };
  sb.findManagerByKey = (rows, key) => (String(key == null ? '' : key).trim() ? rows.filter((r) => String(r.key) === String(key) && String(r.active).toLowerCase() === 'true')[0] : undefined);
  sb.reqRows_ = () => { log.push('reqRows_'); return o.reqRows || []; };
  sb.checkAdmin = (b) => b.admin_key === 'ADM';
  if (o.hub) {
    sb.lineHubStores_ = () => [{ code: '', name: '小辛辣 新竹光復' }, { code: 'mztjs', name: '墨竹亭 金山' }, { code: 'mztmc', name: '墨竹亭 美村' }];
    sb.LINE_HUB_STAFF_CODE_MAP = { '': 'gf', mztjs: 'mztjs', mztmc: 'mztmc' };
  }
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'DutyFeed.gs' });
  h.sb = sb;
  h.advance = (ms) => { h.now += ms; };
  /** 一次寫入：回傳值要原封不動、不能丟例外 */
  h.write = (body, res) => {
    const before = JSON.stringify(res);
    const r = sb.dutyFeedNote_(body, res);
    assert.strictEqual(r, undefined);
    assert.strictEqual(JSON.stringify(res), before, '回應物件被改了');
    return res;
  };
  h.changes = (extra) => sb.handleDutyChanges_(Object.assign({ action: 'duty_changes', mgr_key: 'AK', since: h.now - 60000 }, extra || {}));
  h.stats = () => { const day = new Date(h.now + 8 * 3600000).toISOString().slice(0, 10); const e = cache['dpush_st_' + day]; return e ? JSON.parse(e.v) : null; };
  return h;
}
module.exports = { harness, resp, T0 };
