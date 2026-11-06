// 舊值班核定頁 12/1 停用後換掉舊主管鑰匙（2026-11-06）：mgr_retire_keys。
// 守：管理金鑰才可用、預設只列不寫、apply 一定要點名、只換 active＋非 allow_acting 的列、只換 key 不動 active、
// 回傳不含任何金鑰、近 14 天核定筆數照 manager_name 算。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-12-01T09:00:00+08:00');

function make() {
  const headers = ['name', 'key', 'active', 'allow_acting', 'emp_id'];
  const mgr = [
    ['鍾仕新', 'OLDKEY1', true, '', 'MZTGF04'],
    ['營運系統代管', 'ACTKEY', 'TRUE', 'TRUE', ''],
    ['已停用主管', 'OLDKEY2', 'FALSE', '', ''],
    ['門市營運系統', 'OLDKEY3', 'TRUE', 'false', ''],
    ['', '', '', '', ''],
  ];
  const approved = [
    { entered_at: '2026-11-30T21:00:00+08:00', manager_name: '鍾仕新' },
    { entered_at: '2026-11-29T21:00:00+08:00', manager_name: '鍾仕新' },
    { entered_at: '2026-11-01T21:00:00+08:00', manager_name: '鍾仕新' },   // 超過 14 天
    { entered_at: '2026-11-30T21:00:00+08:00', manager_name: '鍾仕新（DZY008）' },
  ];
  const writes = [];
  let flushed = 0, locked = 0;
  const sheets = { managers: { name: 'managers', getRange: (r, c) => ({ setValue: (v) => { writes.push({ r, c, v }); mgr[r - 2][c - 1] = v; } }) },
                   approved: { name: 'approved' } };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array,
    CONFIG: { ADMIN_KEY: 'ADM' },
    checkAdmin: (b) => b.admin_key === 'ADM',
    getSS: () => ({ getSheetByName: (nm) => sheets[nm] || null }),
    readSheetAsObjects: (sh) => sh.name === 'managers'
      ? { headers, rows: mgr.map((row, i) => { const o = {}; headers.forEach((h, j) => { o[h] = row[j]; }); o.__rowIndex = i + 2; return o; }) }
      : { headers: [], rows: approved.map(r => Object.assign({}, r)) },
    normCellTs: (v) => String(v),
    genKey: (len) => 'x'.repeat(len),
    LockService: { getScriptLock: () => ({ tryLock: () => { locked++; return true; }, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => { flushed++; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), sb);
  const call = (b) => JSON.parse(JSON.stringify(sb.LIFF_HANDLERS.mgr_retire_keys(Object.assign({ action: 'mgr_retire_keys' }, b))));
  return { call, mgr, writes, stat: () => ({ flushed, locked }) };
}

ok('已掛進 LIFF_HANDLERS', () => { assert.strictEqual(typeof make().call, 'function'); });
ok('沒帶或帶錯管理金鑰 → unauthorized，不寫入', () => {
  const t = make();
  assert.strictEqual(t.call({}).error, 'unauthorized');
  assert.strictEqual(t.call({ admin_key: 'x', apply: true, names: ['鍾仕新'] }).error, 'unauthorized');
  assert.strictEqual(t.writes.length, 0);
});
ok('預設只列名單：active 且非 allow_acting 的列，帶近 14 天核定筆數；不寫入、不拿鎖', () => {
  const t = make();
  const r = t.call({ admin_key: 'ADM' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.apply, false);
  assert.deepStrictEqual(r.candidates, [
    { row: 2, name: '鍾仕新', emp_id: 'MZTGF04', recent_approved: 2 },
    { row: 5, name: '門市營運系統', emp_id: '', recent_approved: 0 },
  ]);
  assert.strictEqual(r.acting_rows_kept, 1);
  assert.strictEqual(t.writes.length, 0); assert.strictEqual(t.stat().locked, 0);
});
ok('apply 沒點名 → names_required，不寫入', () => {
  const t = make();
  assert.strictEqual(t.call({ admin_key: 'ADM', apply: true }).error, 'names_required');
  assert.strictEqual(t.call({ admin_key: 'ADM', apply: true, names: [] }).error, 'names_required');
  assert.strictEqual(t.writes.length, 0);
});
ok('apply 只換點名的列的 key，active 不動；代管列與已停用列不動；回 not_found', () => {
  const t = make();
  const r = t.call({ admin_key: 'ADM', apply: true, names: ['鍾仕新', '營運系統代管', '查無此人'] });
  assert.deepStrictEqual(r.rotated, ['鍾仕新']);
  assert.deepStrictEqual(r.not_found, ['營運系統代管', '查無此人']);
  assert.deepStrictEqual(t.writes, [{ r: 2, c: 2, v: 'retired-' + 'x'.repeat(40) }]);
  assert.strictEqual(t.mgr[0][2], true);          // active 原樣
  assert.strictEqual(t.mgr[1][1], 'ACTKEY');      // 代管那把不動
  assert.strictEqual(t.mgr[2][1], 'OLDKEY2');     // 已停用列不動
  assert.strictEqual(t.mgr[3][1], 'OLDKEY3');     // 沒點名不動
  assert.strictEqual(t.stat().flushed, 1);
});
ok('回傳不含任何金鑰（新舊都不回）', () => {
  const t = make();
  const s = JSON.stringify(t.call({ admin_key: 'ADM' })) + JSON.stringify(t.call({ admin_key: 'ADM', apply: true, names: ['鍾仕新'] }));
  ['OLDKEY1', 'ACTKEY', 'OLDKEY2', 'OLDKEY3', 'retired-', '"key"'].forEach(k => assert.ok(s.indexOf(k) < 0, k));
});
ok('換過的列再跑一次只列名單時仍在名單（key 已是亂碼），再 apply 會再換一次也無害', () => {
  const t = make();
  t.call({ admin_key: 'ADM', apply: true, names: ['鍾仕新'] });
  const r = t.call({ admin_key: 'ADM' });
  assert.strictEqual(r.candidates[0].name, '鍾仕新');
});

console.log(`\n✅ mgr_retire_keys 全部通過 (${n}/${n})`);
