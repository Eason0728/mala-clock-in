// svc_roster 新增 line_h／line_kid／line_bound_at／line_ok_at（LINE 登入管理系統用）。原始 line_user_id 絕不回。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const SRC = path.join(__dirname, '..', 'apps-script');
const CODE = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8');
const SVC = fs.readFileSync(path.join(SRC, 'SvcStaff.gs'), 'utf8');
const REQ = fs.readFileSync(path.join(SRC, 'Requests.gs'), 'utf8');   // svc_roster 用到 reqLocalDutyMgrs_（部署時同專案全域）
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'line-h-vector.json'), 'utf8'));

function FakeSheet(headers, rows) { this.data = [headers.slice()].concat(rows.map(r => r.slice())); }
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data.reduce((m, r) => Math.max(m, r.length), 0); };
FakeSheet.prototype.getDataRange = function () { const w = this.getLastColumn(), s = this; return { getValues: () => s.data.map(r => { const c = r.slice(); while (c.length < w) c.push(''); return c; }) }; };
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const s = this; nr = nr || 1; nc = nc || 1;
  return { getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (s.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; },
    setValue() {}, setValues() {}, setNumberFormat() { return this; } };
};

const H = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at', 'line_ok_at'];
const EH = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const rows = () => [
  ['E01', '測試甲', 'KEYJIA0000000000AAAA', 'DEV-JIA', '', true, '', '', '', '', '', '', VEC.uid, '2026-10-20T09:00:00+08:00', '2026-10-21T09:00:00+08:00'],
  ['E02', '測試乙', 'KEYYI00000000000BBBB', '', '', true, '', '', '', '', '', '', '', '', ''],
];

// 假的 Utilities.computeHmacSha256Signature：用 node crypto 真算，回有號 byte 陣列（模擬 GAS）
const fakeHmac = (value, key) => [...crypto.createHmac('sha256', key).update(value, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b));

function env(props, roster) {
  const sheets = { roster: new FakeSheet(H, roster || rows()), events: new FakeSheet(EH, []) };
  const ss = { getSheetByName: n => sheets[n] || null };
  const all = Object.assign({ STAFF_SVC_KEY: 'TESTSVCKEY-abc123' }, props);
  const sb = {
    console, Logger: { log() {} }, Date, Math, JSON, String, Number, Object, Array, isNaN, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in all ? all[k] : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get() { return null; }, put() {}, remove() {} }) },
    Utilities: { computeHmacSha256Signature: fakeHmac,
      formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19) + '+08:00'; } },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  };
  vm.createContext(sb); vm.runInContext(CODE, sb); vm.runInContext(REQ, sb); vm.runInContext(SVC, sb);
  const call = () => JSON.parse(JSON.stringify(vm.runInContext('(function(b){return SVC_STAFF_HANDLERS.svc_roster(b);})', sb)({ action: 'svc_roster', v: 1, svc_key: all.STAFF_SVC_KEY })));
  return { call, sb };
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

ok('fixture 向量與 node crypto 一致（測試本身的前提）', () => {
  assert.strictEqual(crypto.createHmac('sha256', VEC.key).update(VEC.uid).digest('hex'), VEC.line_h);
  assert.ok(fakeHmac(VEC.uid, VEC.key).some(b => b < 0), '假 Utilities 要回有號 byte 才像 GAS');
});
ok('已綁：line_h 與 fixture 一致；line_kid／line_bound_at／line_ok_at 帶出', () => {
  const r = env({ LINE_MAP_KEY: VEC.key, LINE_MAP_KID: 'k1' }).call();
  assert.strictEqual(r.ok, true);
  const a = r.rows.find(x => x.emp_id === 'E01');
  assert.strictEqual(a.line_h, VEC.line_h);
  assert.strictEqual(a.line_kid, 'k1');
  assert.strictEqual(a.line_bound_at, '2026-10-20T09:00:00+08:00');
  assert.strictEqual(a.line_ok_at, '2026-10-21T09:00:00+08:00');
  assert.strictEqual(a.line_bound, true);
});
ok('未綁：四欄皆空字串', () => {
  const r = env({ LINE_MAP_KEY: VEC.key, LINE_MAP_KID: 'k1' }).call();
  const b = r.rows.find(x => x.emp_id === 'E02');
  ['line_h', 'line_kid', 'line_bound_at', 'line_ok_at'].forEach(k => assert.strictEqual(b[k], '', k));
  assert.strictEqual(b.line_bound, false);
});
ok('LINE_MAP_KEY 未設：line_h 空字串（其餘照帶）；LINE_MAP_KID 未設：空字串', () => {
  const r = env({}).call();
  const a = r.rows.find(x => x.emp_id === 'E01');
  assert.strictEqual(a.line_h, '');
  assert.strictEqual(a.line_kid, '');
  assert.strictEqual(a.line_bound_at, '2026-10-20T09:00:00+08:00');
  assert.strictEqual(a.line_ok_at, '2026-10-21T09:00:00+08:00');
});
ok('回應 JSON 不含原始 uid、不含 line_user_id 欄名、不含金鑰', () => {
  [env({ LINE_MAP_KEY: VEC.key, LINE_MAP_KID: 'k1' }).call(), env({}).call()].forEach(r => {
    const s = JSON.stringify(r);
    assert.ok(!s.includes(VEC.uid), '洩漏 uid');
    assert.ok(!s.includes('line_user_id'));
    assert.ok(!s.includes(VEC.key), '洩漏 LINE_MAP_KEY');
    assert.ok(!s.includes('KEYJIA'));
  });
});
ok('舊表沒有 line_ok_at 欄也不報錯（四欄仍在、line_ok_at 空）', () => {
  const e = env({ LINE_MAP_KEY: VEC.key }, rows().map(r => r.slice(0, 14)));
  const sh = vm.runInContext("SpreadsheetApp.openById('x').getSheetByName('roster')", e.sb);
  sh.data[0] = sh.data[0].slice(0, 14);   // 表頭也拿掉 line_ok_at
  const r = e.call();
  assert.strictEqual(r.rows[0].line_h, VEC.line_h);
  assert.strictEqual(r.rows[0].line_ok_at, '');
});
ok('Date 型態的時間格（Sheets 轉成 Date）→ 台北 ISO 字串', () => {
  const rr = rows();
  const e = env({ LINE_MAP_KEY: VEC.key }, rr);
  // README 坑 2：Date 要用 vm context 內的，否則 instanceof Date 失敗
  const d = vm.runInContext("new Date('2026-10-21T09:00:00+08:00')", e.sb);
  const sh = vm.runInContext("SpreadsheetApp.openById('x').getSheetByName('roster')", e.sb);
  sh.data[1][14] = d;
  assert.strictEqual(e.call().rows[0].line_ok_at, '2026-10-21T09:00:00+08:00');
});
ok('最上層 line_probe＝HMAC(key,"dzy-line-probe")、line_kid；未設金鑰皆空', () => {
  const r = env({ LINE_MAP_KEY: VEC.key, LINE_MAP_KID: 'k1' }).call();
  assert.strictEqual(r.line_probe, crypto.createHmac('sha256', VEC.key).update('dzy-line-probe', 'utf8').digest('hex'));
  assert.strictEqual(r.line_kid, 'k1');
  assert.ok(!JSON.stringify(r).includes(VEC.key), '洩漏金鑰');
  const e = env({}).call();
  assert.strictEqual(e.line_probe, '');
  assert.strictEqual(e.line_kid, '');
});
console.log('\nsvc-roster-line: ' + n + ' 項通過');
