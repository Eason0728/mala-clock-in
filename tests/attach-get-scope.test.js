// 光復 line_hub_attach_get：只給這把鑰匙在待審清單看得到的申請附件（2026-10-29 審查）。測試姓名一律假名。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8');

function env(pendItems) {
  const calls = [];
  const sheet = rows => ({ rows });
  const ss = { getSheetByName: n => ({ name: n }) };
  const sb = {
    console, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, isNaN,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'REQ_ATTACH_FOLDER' ? 'FOLDER' : null) }) },
    DriveApp: { getFileById: id => ({ getParents: () => { let d = false; return { hasNext: () => !d, next: () => { d = true; return { getId: () => 'FOLDER' }; } }; },
      getBlob: () => ({ getContentType: () => 'image/png', getBytes: () => [1, 2] }) }) },
    Utilities: { base64Encode: () => 'AQI=' },
    SpreadsheetApp: { openById: () => ss },
  };
  vm.createContext(sb);
  vm.runInContext(read('LineHub.gs'), sb);
  sb.__pend = pendItems; sb.__calls = calls;
  vm.runInContext(`
    lineHubThrottled_ = function () { return false; };
    lineHubStores_ = function () { return [{ code: 'cf', name: '測試央廚', ss_id: 'X', api: 'https://example.invalid' }]; };
    getSS = function () { return null; };
    findManagerByKey = function (rows, k) { return k === 'MK' || k === 'OPS' ? { name: 'm' } : null; };
    readSheetAsObjects = function (sh) { return { rows: sh.name === 'requests' ? [{ attach_id: 'A1', emp_id: 'E02' }, { attach_id: 'A2', emp_id: 'E03' }] : [] }; };
    lineHubCallStore_ = function (st, p) { __calls.push(p); return __pend === null ? null : { ok: true, items: __pend }; };
  `, sb);
  return { get: b => JSON.parse(JSON.stringify(vm.runInContext('handleLineHubAttachGet_', sb)(b))), calls };
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

ok('待審清單有這個附件 → 給檔', () => {
  const e = env([{ id: 'r1', emp_id: 'E02', attach_id: 'A1' }]);
  const r = e.get({ store: 'cf', mgr_key: 'MK', attach_id: 'A1' });
  assert.strictEqual(r.ok, true); assert.strictEqual(e.calls[0].action, 'mgr_req_pending'); assert.strictEqual(e.calls[0].mgr_key, 'MK');
});
ok('附件掛在申請上、但這把鑰匙的待審清單看不到（不算支援的人）→ not_found', () => {
  const e = env([{ id: 'r1', emp_id: 'E02', attach_id: 'A1' }]);
  assert.strictEqual(e.get({ store: 'cf', mgr_key: 'MK', attach_id: 'A2' }).error, 'not_found');
});
ok('管理系統代核：acting_name 一起帶給店家', () => {
  const e = env([{ id: 'r2', emp_id: 'E03', attach_id: 'A2' }]);
  assert.strictEqual(e.get({ store: 'cf', mgr_key: 'OPS', acting_name: '人資主管', attach_id: 'A2' }).ok, true);
  assert.strictEqual(e.calls[0].acting_name, '人資主管');
});
ok('讀不到待審清單 → busy，不給檔', () => {
  assert.strictEqual(env(null).get({ store: 'cf', mgr_key: 'MK', attach_id: 'A1' }).error, 'busy');
});
ok('鑰匙錯 → unauthorized，不問店家', () => {
  const e = env([]); assert.strictEqual(e.get({ store: 'cf', mgr_key: 'BAD', attach_id: 'A1' }).error, 'unauthorized'); assert.strictEqual(e.calls.length, 0);
});
console.log('\n' + n + ' 項通過');
