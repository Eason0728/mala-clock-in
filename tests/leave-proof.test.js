// 請假證明（2026-10-10 Eason：病假、婚假、喪假、產假相關一定要附證明；可先送出，沒附不能核准，同仁補附）
// 2026-11-06：病假改成今年累計滿 3 天（第 3 個日子起）才要附，其他 15 種不變。
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
vm.runInContext(codeSrc.match(/function actingName_\([\s\S]*?\n\}\n/)[0], sb);   // Requests.gs 寫審核人時呼叫（Code.gs）
vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8'), sb);
const LEAVE_TYPES = vm.runInContext(codeSrc.slice(codeSrc.indexOf('const LEAVE_TYPES = ['), codeSrc.indexOf('];', codeSrc.indexOf('const LEAVE_TYPES = [')) + 2) + ' LEAVE_TYPES', vm.createContext({}));
const PROOF = vm.runInContext('REQ_PROOF_TYPES_', sb);
const J = (x) => JSON.parse(JSON.stringify(x));

// ── 假的試算表與身分 ──
let rows = [], me = { emp_id: 'E01', name: '測試一' };
const mk = (o) => Object.assign({ id: 'r' + (rows.length + 1), created_at: '2026-10-10T09:00:00+08:00', emp_id: 'E01', name: '測試一', kind: 'leave',
  date: '2026-10-12', leave_type: '婚假', start: '', end: '', hours: 8, miss_type: '', reason: '', attach_id: '', status: 'pending',
  decided_at: '', decided_by: '', reject_reason: '', seen_at: '', comp: '' }, o);
Object.assign(sb, {
  LEAVE_TYPES,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },   // REQ_UPPER_ON 未設＝關
  normCellTs: (v) => String(v || ''), nowTaipeiIso: () => '2026-10-10T10:00:00+08:00', todayTaipeiStr: () => '2026-10-10',
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  getSS: () => ({ getSheetByName: () => null }), reqSheet_: () => ({}),
  reqRows_: () => sb.reqSickMark_(rows.map((r, i) => Object.assign(r, { __rowIndex: i + 2 }))),   // 同正式版：讀表時標病假第幾天
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
  assert.ok(/婚假要附證明/.test(r.message));
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
  assert.deepStrictEqual(r.skipped, [{ id: 'r1', reason: '婚假還沒附證明' }]);
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
// 2026-11-08（3-6）正式值改 1＝每張都要附；下面三題把門檻設回 3，守住「第幾天」的機制，最後一題驗正式值
ok('正式值：每張病假都要附', () => { assert.strictEqual(sb.REQ_SICK_PROOF_DAYS, 1); assert.strictEqual(sb.reqNeedsProof_({ kind: 'leave', leave_type: '病假', __sick_n: 1 }), true); });
sb.REQ_SICK_PROOF_DAYS = 3;
ok('病假：今年第 1、2 天不用附證明，第 3 天起要附；同一天兩張算同一天；退回、取消、作廢的不算；跨年重算', () => {
  const sick = (date, o) => mk(Object.assign({ leave_type: '病假', date }, o || {}));
  rows = [sick('2026-03-02'), sick('2026-03-02', { hours: 4 }), sick('2026-05-10'), sick('2026-06-01'),
          sick('2026-07-01', { status: 'rejected' }), sick('2026-07-02', { status: 'cancelled' }), sick('2026-07-03', { status: 'voided' }),
          sick('2026-08-01'), sick('2027-01-05'), sick('2026-09-01', { emp_id: 'E02' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const pub = sb.reqRows_().map((r) => J(sb.reqPublic_(r)));
  assert.deepStrictEqual(pub.map((x) => x.sick_n), [1, 1, 2, 3, 4, 4, 4, 4, 1, 1]);
  assert.deepStrictEqual(pub.map((x) => x.need_proof), [false, false, false, true, true, true, true, true, false, false]);
  // 婚假等其他 15 種：第 1 天就要附
  rows = [mk({ leave_type: '婚假' })]; rows[0].id = 'r1';
  assert.strictEqual(J(sb.reqPublic_(sb.reqRows_()[0])).need_proof, true);
});
ok('病假：前兩天沒附證明可以直接核准（單筆、批次）；第 3 天沒附擋下', () => {
  const sick = (date) => mk({ leave_type: '病假', date });
  rows = [sick('2026-10-01'), sick('2026-10-05'), sick('2026-10-12')]; rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'mk', id: 'r1', decision: 'approve' }).ok, true);
  const b = J(sb.handleMgrReqDecideBatch_({ mgr_key: 'mk', ids: ['r2', 'r3'], decision: 'approve' }));
  assert.deepStrictEqual(b.done, ['r2']);
  assert.deepStrictEqual(b.skipped, [{ id: 'r3', reason: '病假還沒附證明' }]);
});
ok('病假：送出那一刻就算好第幾天（回傳 need_proof），req_info 帶今年病假日期給申請頁', () => {
  rows = [mk({ leave_type: '病假', date: '2026-10-01', status: 'approved' }), mk({ leave_type: '病假', date: '2026-10-03' })];
  rows.forEach((r, i) => { r.id = 'r' + (i + 1); });
  const info = J(sb.handleReqInfo_({ id_token: 'good' }));
  assert.deepStrictEqual([info.sick_proof_days, info.sick_dates], [3, ['2026-10-01', '2026-10-03']]);
  assert.strictEqual(sb.reqSickNth_(rows, { emp_id: 'E01', date: '2026-10-09' }), 3);
  assert.strictEqual(sb.reqSickNth_(rows, { emp_id: 'E01', date: '2026-10-02' }), 2);
});
ok('Liff.gs 掛了 req_attach', () => assert.ok(/req_attach: function \(b\) \{ return handleReqAttach_\(b\); \}/.test(liffSrc)));

console.log('\n' + n + ' 項全過');
