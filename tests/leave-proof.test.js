// 請假證明（2026-10-10 Eason：病假、婚假、喪假、產假相關一定要附證明；可先送出，沒附不能核准，同仁補附）
// 測 Requests.gs：清單與 Code.gs 假別一致、need_proof 旗標、單筆／批次核准擋下、req_attach 補附、req_info 帶清單。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const liffSrc = fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const sb = { console, Date, JSON, Math, String, Number, isNaN, parseInt, Object, Array, RegExp };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8'), sb);
const LEAVE_TYPES = vm.runInContext(codeSrc.slice(codeSrc.indexOf('const LEAVE_TYPES = ['), codeSrc.indexOf('];', codeSrc.indexOf('const LEAVE_TYPES = [')) + 2) + ' LEAVE_TYPES', vm.createContext({}));
const PROOF = vm.runInContext('REQ_PROOF_TYPES_', sb);
const J = (x) => JSON.parse(JSON.stringify(x));

// ── 假的試算表與身分 ──
let rows = [], me = { emp_id: 'E01', name: '測試一' };
const mk = (o) => Object.assign({ id: 'r' + (rows.length + 1), created_at: '2026-10-10T09:00:00+08:00', emp_id: 'E01', name: '測試一', kind: 'leave',
  date: '2026-10-12', leave_type: '病假', start: '', end: '', hours: 8, miss_type: '', reason: '', attach_id: '', status: 'pending',
  decided_at: '', decided_by: '', reject_reason: '', seen_at: '', comp: '' }, o);
Object.assign(sb, {
  LEAVE_TYPES,
  normCellTs: (v) => String(v || ''), nowTaipeiIso: () => '2026-10-10T10:00:00+08:00', todayTaipeiStr: () => '2026-10-10',
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  getSS: () => ({}), reqSheet_: () => ({}),
  reqRows_: () => rows.map((r, i) => Object.assign(r, { __rowIndex: i + 2 })),
  reqSetCells_: (sh, idx, patch) => Object.assign(rows[idx - 2], patch),
  reqStaff_: (b) => (b.id_token === 'good' ? { me, ss: {} } : { error: 'invalid_id_token' }),
  reqMgr_: (b) => (b.mgr_key === 'mk' ? { name: '主管甲' } : null),
  liffEvents_: () => [],
});

ok('證明清單 16 種，每一種都在 Code.gs 假別表裡（名稱一字不差）', () => {
  assert.strictEqual(PROOF.length, 16);
  PROOF.forEach((t) => assert.ok(LEAVE_TYPES.indexOf(t) >= 0, t + ' 不在 LEAVE_TYPES'));
});
ok('病、婚、喪、產相關都在；生理假、特休、事假、家庭照顧、天災、公假、謀職、育嬰不在', () => {
  ['病假', '住院傷病假', '公傷病假', '婚假', '喪假', '喪假（父母・配偶）', '產假（分娩）', '產檢假', '陪產檢及陪產假', '安胎休養假', '流產假（妊娠未滿2個月）']
    .forEach((t) => assert.ok(PROOF.indexOf(t) >= 0, t));
  ['生理假', '特休假', '事假', '家庭照顧假', '天災假', '公假', '謀職假', '育嬰假', '補休'].forEach((t) => assert.ok(PROOF.indexOf(t) < 0, t));
});
ok('need_proof：要附沒附才是 true；加班不算', () => {
  const p = (o) => J(sb.reqPublic_(mk(o)));
  assert.deepStrictEqual([p({}).proof_required, p({}).need_proof], [true, true]);
  assert.deepStrictEqual([p({ attach_id: 'abcdefghij12' }).need_proof, p({ attach_id: 'abcdefghij12' }).has_attach], [false, true]);
  assert.deepStrictEqual([p({ leave_type: '事假' }).proof_required, p({ leave_type: '事假' }).need_proof], [false, false]);
  assert.strictEqual(p({ kind: 'ot', leave_type: '' }).need_proof, false);
});
ok('單筆核准：沒附證明擋下（need_proof），資料不變；退回照樣可以', () => {
  rows = [mk({})]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const r = J(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'approve' }));
  assert.deepStrictEqual([r.ok, r.error], [false, 'need_proof']);
  assert.ok(/病假要附證明/.test(r.message));
  assert.strictEqual(rows[0].status, 'pending');
  const x = J(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'reject', reason: '請補證明再送' }));
  assert.deepStrictEqual([x.ok, rows[0].status], [true, 'rejected']);
});
ok('單筆核准：有附就能核准；不用附的假別照舊', () => {
  rows = [mk({ attach_id: 'abcdefghij12' }), mk({ leave_type: '事假' })]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'approve' }).ok, true);
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r2', decision: 'approve' }).ok, true);
});
ok('批次核准：沒附證明的略過並說原因，其他照核准', () => {
  rows = [mk({}), mk({ leave_type: '事假' }), mk({ leave_type: '喪假', attach_id: 'abcdefghij12' })]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const r = J(sb.handleMgrReqDecideBatch_({ mgr_key: 'mk', ids: ['r1', 'r2', 'r3'], decision: 'approve' }));
  assert.deepStrictEqual(r.done, ['r2', 'r3']);
  assert.deepStrictEqual(r.skipped, [{ id: 'r1', reason: '病假還沒附證明' }]);
  assert.deepStrictEqual(rows.map((x) => x.status), ['pending', 'approved', 'approved']);
});
ok('補附：自己的審核中請假 → 寫入 attach_id、need_proof 變 false，之後可以核准', () => {
  rows = [mk({})]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const r = J(sb.handleReqAttach_({ id_token: 'good', id: 'r1', attach_id: 'att_0123456789' }));
  assert.deepStrictEqual([r.ok, r.request.need_proof, rows[0].attach_id], [true, false, 'att_0123456789']);
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'approve' }).ok, true);
});
ok('補附：別人的、已處理的、不是請假的、附件 ID 不對的、假 token 都擋', () => {
  rows = [mk({ emp_id: 'E02' }), mk({ status: 'approved', attach_id: '' }), mk({ kind: 'ot', leave_type: '' }), mk({})]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const a = (id, aid, tok) => J(sb.handleReqAttach_({ id_token: tok || 'good', id, attach_id: aid || 'att_0123456789' }));
  assert.strictEqual(a('r1').error, 'not_found');
  assert.strictEqual(a('r2').error, 'not_pending');
  assert.strictEqual(a('r3').error, 'not_leave');
  assert.strictEqual(a('r4', 'x').error, 'bad_attach');
  assert.strictEqual(a('r4', '../../etc/passwd').error, 'bad_attach');
  assert.strictEqual(a('r4', null, 'bad').error, 'invalid_id_token');
  assert.strictEqual(rows[3].attach_id, '');
});
ok('req_info 帶 proof_types（申請頁用它判斷要不要提醒附證明）', () => {
  rows = []; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const r = J(sb.handleReqInfo_({ id_token: 'good' }));
  assert.deepStrictEqual(r.proof_types, J(PROOF));
});
ok('Liff.gs 掛了 req_attach', () => assert.ok(/req_attach: function \(b\) \{ return handleReqAttach_\(b\); \}/.test(liffSrc)));

console.log('\n' + n + ' 項全過');
