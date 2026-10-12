// LINE 按打卡少做重複的事（2026-10-12 ①～④）：用真的 Code.gs＋Liff.gs＋Requests.gs 跑一次 liff_punch，
// 數每張分頁被讀幾次；驗身分快取；各步驟毫秒數有回傳。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const NOW = Date.parse('2026-10-12T21:30:00+08:00');
const iso = (ms) => new Date(ms + 8 * 3600000).toISOString().replace(/\.\d{3}Z$/, '+08:00');

function fakeSheet(name, values, log) {
  const sh = {
    name, values,
    getLastRow: () => values.length, getLastColumn: () => (values[0] || []).length,
    getDataRange: () => ({ getValues: () => { log.push(name + ':全部'); return values.map(r => r.slice()); } }),
    getRange: (r, c, nr, nc) => {
      if (typeof r === 'string') return { setNumberFormat() {} };
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: () => { if (r > 1) log.push(name + ':' + nr + '列'); return values.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)); },
        setValues: (v) => { v.forEach((row, i) => { values[r - 1 + i] = values[r - 1 + i] || []; row.forEach((x, j) => { values[r - 1 + i][c - 1 + j] = x; }); }); },
        setValue: (x) => { values[r - 1] = values[r - 1] || []; values[r - 1][c - 1] = x; },
        setNumberFormat() {},
      };
    },
    appendRow: (row) => { values.push(row); log.push(name + ':寫入'); },
  };
  return sh;
}
function env(opts) {
  opts = opts || {};
  const log = [], fetches = [], cache = {};
  const RH = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'line_user_id', 'line_bound_at', 'removed_at', 'removed_by'];
  const roster = [RH, ['E1', '測試一', 'k1', 'DEV1', '2026-10-01T09:00:00+08:00', 'true', '', '', '', '', 'U1', '', '', ''],
                      ['E2', '測試二', 'k2', 'DEV2', '2026-10-01T09:00:00+08:00', 'true', '', '', '', '', 'U2', '', '', '']];
  const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
  const events = [EH];
  for (let d = 6; d >= 0; d--) {
    const day = Date.parse('2026-10-12T00:00:00+08:00') - d * 86400000;
    [[9, 'in'], [17, 'out']].forEach(([h, t]) => { if (day + h * 3600000 < NOW - 3600000) events.push([iso(day + h * 3600000), 'E1', t, 24, 121, 3, true, 'DEV1', true, 'ok', 10]); });
  }
  const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp'];
  const requests = [RQH, ['R1', '2026-10-10T10:00:00+08:00', 'E1', '測試一', 'leave', '2026-10-11', '事假', '', '', 4, '', '', '', 'approved', '2026-10-10T12:00:00+08:00', '主管', '', '', '']];
  const sheets = {};
  [['roster', roster], ['events', events], ['requests', requests]].forEach(([k, v]) => { sheets[k] = fakeSheet(k, v, log); });
  const ss = { getSheetByName: (nm) => sheets[nm] || null, insertSheet: (nm) => (sheets[nm] = fakeSheet(nm, [], log)) };
  class FD extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FD, JSON, Math, String, Number, Object, Array, isNaN, isFinite, parseInt, parseFloat, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, flush() {} },
    UrlFetchApp: { fetch: (url, o) => { fetches.push(o.payload.id_token);
      const t = String(o.payload.id_token), good = t.indexOf('TOK_') === 0;
      return { getResponseCode: () => good ? 200 : 400,
               getContentText: () => JSON.stringify(good ? { sub: t.slice(4).split('#')[0], aud: '2011292256', exp: Math.floor(NOW / 1000) + (opts.expIn || 3600) } : {}) }; } },
    CacheService: { getScriptCache: () => opts.brokenCache ? { get() { throw new Error('壞了'); }, put() { throw new Error('壞了'); }, remove() {} }
      : { get: (k) => cache[k] || null, put: (k, v, ttl) => { cache[k] = v; cache['ttl:' + k] = ttl; }, remove: (k) => { delete cache[k]; } } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    Utilities: { DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (a, t) => [...crypto.createHash(a === 'sha256' ? 'sha256' : 'md5').update(String(t)).digest()],
      base64Encode: (b) => Buffer.from(b).toString('base64'), base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64'),
      formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString();
        if (f === 'yyyy-MM-dd') return s.slice(0, 10); if (f === 'yyyy-MM') return s.slice(0, 7); if (f === 'HH:mm') return s.slice(11, 16); return s.slice(0, 19) + '+08:00'; } },
    Logger: { log() {} },
  };
  vm.createContext(sb);
  vm.runInContext(['Code.gs', 'Liff.gs', 'Requests.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n'), sb);
  vm.runInContext("CONFIG.LINE_CHANNEL_ID = '2011292256'; CONFIG.STORE_LAT = 24; CONFIG.STORE_LNG = 121; CONFIG.RADIUS_M = 50;", sb);   // CONFIG 是 const，不在 sb 上
  return { sb, log, fetches, cache, sheets };
}
const reads = (log, name) => log.filter(x => x.indexOf(name + ':') === 0 && x !== name + ':寫入').length;

ok('按上班：名冊、打卡表、申請表各只讀一次，寫入一筆', () => {
  const e = env();
  const r = e.sb.liffPunchVerified_('in', { id_token: 'TOK_U1', lat: 24, lng: 121, accuracy: 5 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(reads(e.log, 'roster'), 1, e.log.join(' '));
  assert.strictEqual(reads(e.log, 'events'), 1, e.log.join(' '));
  assert.strictEqual(reads(e.log, 'requests'), 1, e.log.join(' '));
  assert.strictEqual(e.log.filter(x => x === 'events:寫入').length, 1);
  assert.ok(r.req_notes.length === 1 && r.req_notes[0].indexOf('✓ 主管已核准') === 0, JSON.stringify(r.req_notes));   // 申請結果告知照常
});
ok('按下班：同樣各讀一次（超時提示與結果告知共用申請表）', () => {
  const e = env();
  e.sb.liffPunchVerified_('in', { id_token: 'TOK_U1', lat: 24, lng: 121, accuracy: 5 });
  e.log.length = 0;
  e.sb.Date.now = () => NOW + 11 * 60000;   // 過了 10 分鐘鎖
  const r = e.sb.liffPunchVerified_('out', { id_token: 'TOK_U1#2', lat: 24, lng: 121, accuracy: 5 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  ['roster', 'events', 'requests'].forEach(nm => assert.strictEqual(reads(e.log, nm), 1, nm + ' ' + e.log.join(' ')));
});
ok('回傳各步驟毫秒數（驗身分／讀名冊／讀打卡表／寫入／事後提醒）', () => {
  const r = env().sb.liffPunchVerified_('in', { id_token: 'TOK_U1', lat: 24, lng: 121, accuracy: 5 });
  assert.strictEqual(JSON.stringify(Object.keys(r.steps)), JSON.stringify(['verify', 'roster', 'read', 'write', 'extra']));
  Object.values(r.steps).forEach(v => assert.ok(typeof v === 'number' && v >= 0));
});
ok('失敗（不在範圍）也回步驟毫秒數', () => {
  const r = env().sb.liffPunchVerified_('in', { id_token: 'TOK_U1', lat: 25, lng: 122, accuracy: 5 });
  assert.strictEqual(r.ok, false); assert.ok(r.steps && 'write' in r.steps, JSON.stringify(r));
});
ok('驗身分：同一張 token 第二次不再問 LINE；不同 token 會問', () => {
  const e = env();
  assert.strictEqual(e.sb.verifyLineIdToken_('TOK_U1'), 'U1');
  assert.strictEqual(e.sb.verifyLineIdToken_('TOK_U1'), 'U1');
  assert.strictEqual(e.fetches.length, 1);
  assert.strictEqual(e.sb.verifyLineIdToken_('TOK_U2'), 'U2'); assert.strictEqual(e.fetches.length, 2);
});
ok('驗身分：快取最多 10 分鐘；token 快到期只留到到期前 30 秒；剩不到 35 秒不快取', () => {
  let e = env(); e.sb.verifyLineIdToken_('TOK_U1'); assert.ok(Object.keys(e.cache).some(k => k.indexOf('ttl:lidt:') === 0 && e.cache[k] === 600));
  e = env({ expIn: 100 }); e.sb.verifyLineIdToken_('TOK_U1'); assert.ok(Object.keys(e.cache).some(k => k.indexOf('ttl:lidt:') === 0 && e.cache[k] === 70));
  e = env({ expIn: 20 }); e.sb.verifyLineIdToken_('TOK_U1'); e.sb.verifyLineIdToken_('TOK_U1'); assert.strictEqual(e.fetches.length, 2);
});
ok('驗身分：假 token 不快取（每次都問、都擋）', () => {
  const e = env(); assert.strictEqual(e.sb.verifyLineIdToken_('bad'), null); assert.strictEqual(e.sb.verifyLineIdToken_('bad'), null); assert.strictEqual(e.fetches.length, 2);
});
ok('驗身分：快取壞了照常問 LINE，打卡不受影響', () => {
  const e = env({ brokenCache: true });
  assert.strictEqual(e.sb.verifyLineIdToken_('TOK_U1'), 'U1');
});
ok('快取鍵是 token 的雜湊，不存 token 原文', () => {
  const e = env(); e.sb.verifyLineIdToken_('TOK_U1');
  assert.ok(!Object.keys(e.cache).some(k => k.indexOf('TOK_U1') >= 0));
});
console.log('\n✅ 打卡少做重複的事 ' + n + ' 項通過');
