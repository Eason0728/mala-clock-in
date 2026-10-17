// 實際核定人 acting_name（2026-10-18，營運系統改個人帳號）：只有 allow_acting＝TRUE 的主管鑰匙才採用，格式不合整筆拒絕。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ROOT = __dirname + '/..';
const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const reqs = fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8');
const liff = fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const sb = { String }; vm.createContext(sb);
vm.runInContext(code.match(/function actingName_\([\s\S]*?\n\}\n/)[0], sb);
const A = sb.actingName_;
const SVC = { name: '營運系統代管', allow_acting: 'TRUE' }, OLD = { name: '王主管', allow_acting: '' };

ok('沒有 allow_acting 的舊主管鑰匙：帶什麼都照舊回主管名字（不能冒名）', () => {
  assert.strictEqual(A({ acting_name: '陳小明（DZY023）' }, OLD), '王主管');
  assert.strictEqual(A({ acting_name: 12345 }, OLD), '王主管');
  assert.strictEqual(A({}, { name: '王主管' }), '王主管');
});
ok('allow_acting＝TRUE（大小寫不拘）：採用 acting_name，去頭尾空白', () => {
  assert.strictEqual(A({ acting_name: ' 陳小明（DZY023） ' }, SVC), '陳小明（DZY023）');
  assert.strictEqual(A({ acting_name: '林督導（DZY051）' }, { name: 'x', allow_acting: 'true' }), '林督導（DZY051）');
});
ok('allow_acting＝TRUE 但沒帶 acting_name（門市帳號舊路）：回主管名字', () => {
  assert.strictEqual(A({}, SVC), '營運系統代管');
  assert.strictEqual(A({ acting_name: '' }, SVC), '營運系統代管');
  assert.strictEqual(A({ acting_name: null }, SVC), '營運系統代管');
});
ok('allow_acting＝TRUE 且格式不合：回 null（呼叫端整筆拒絕）', () => {
  assert.strictEqual(A({ acting_name: 123 }, SVC), null);
  assert.strictEqual(A({ acting_name: '   ' }, SVC), null);
  assert.strictEqual(A({ acting_name: 'x'.repeat(41) }, SVC), null);
  assert.strictEqual(A({ acting_name: 'x'.repeat(40) }, SVC), 'x'.repeat(40));
});

function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '('); assert(i >= 0, '找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const SITES = [[code, 'handleMgrAddEmployeeUnlocked_'], [code, 'handleMgrSetActive'], [code, 'handleMgrApprove'], [code, 'handleMgrAddNotice'],
  [code, 'handleMgrDeviceDecision'], [reqs, 'handleMgrReqDecide_'], [reqs, 'handleMgrReqDecideBatch_'], [liff, 'handleMgrLineUnbind_']];
ok('八個寫入點都經 actingName_、格式不合回 bad_acting_name、不再直接寫主管名字', () => {
  SITES.forEach(([src, name]) => {
    const b = fnBody(src, name);
    assert(/actor = actingName_\(body, (auth\.)?mgr\);/.test(b), name + ' 沒呼叫 actingName_');
    assert(/if \(actor === null\) return \{ ok: false, error: 'bad_acting_name'/.test(b), name + ' 沒擋格式不合');
    const writes = b.split('\n').filter((l) => /(created_by|removed_by|decided_by|manager_name|unbind_by|appendRow)/.test(l) && /mgr\.name/.test(l));
    assert.deepStrictEqual(writes, [], name + ' 還有直接寫 mgr.name：' + writes.join(' | '));
  });
});
console.log(`\n✅ acting-name ${n} 項通過`);
