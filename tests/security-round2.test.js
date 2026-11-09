/**
 * 資安第二輪修補（2026-11-10）：薪資單比對店別、定案寫入鎖、門市範圍、管理金鑰、新金鑰亂數。
 * 全部用假資料。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m); } };
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const KEY = 'test-admin-key';

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}

/* ── 查自己薪資用哪一筆主檔 ── */
function pick(master, me, st) {
  const s = load({ data: { master } });
  s.__me = me; s.__st = st;
  return vm.runInContext('payMineMaster_(__me, __st)', s);
}
const A1 = { emp_id: 'E1', name: '甲', store: 'SSLGF' }, B1 = { emp_id: 'E1', name: '乙', store: 'MZTJS' };
ok(pick([B1, A1], { emp_id: 'E1', name: '甲' }, 'SSLGF').name === '甲', '別店同編號排前面：仍拿到本店主檔');
ok(pick([B1], { emp_id: 'E1', name: '甲' }, 'SSLGF') === undefined, '別店同編號不同人：不拿別人的主檔');
ok(pick([B1], { emp_id: 'E1', name: '乙' }, 'SSLHQ').store === 'MZTJS', '跨店同仁（同編號同姓名）：查得到主檔');
ok(pick([], { emp_id: 'E9', name: '丙' }, 'SSLGF') === undefined, '沒有主檔：回空');
ok(pick([{ emp_id: 'E1', name: '', store: 'MZTJS' }], { emp_id: 'E1', name: '' }, 'SSLGF') === undefined, '姓名空白不算同名');

{
  const s = load({ data: {
    master: [B1, A1], input: [], leave_type: [], leave_event: [], leave_span: [], config: [], holiday: [], store: [],
    run: [{ ym: '2026-09', emp_id: 'E1', store: 'MZTJS', status: 'final', net: 99999, gross: 99999, name: '乙' },
          { ym: '2026-09', emp_id: 'E1', store: 'SSLGF', status: 'final', net: 111, gross: 111, name: '甲' }],
    item: [],
  } });
  s.__me = { emp_id: 'E1', name: '甲', active: 'true' };
  const r = vm.runInContext(`payMyPayslipFor_(__me, 'SSLGF', '2026-09')`, s);
  ok(JSON.stringify(r).indexOf('99999') === -1, '查薪資單：看不到別店同編號的人的金額');
}
const hub = read('apps-script/LineHub.gs');
ok(!/payRead\('master'\)\.filter\(function \(m\) \{ return String\(m\.emp_id\) === String\(pick\.me\.emp_id\)/.test(hub), 'LINE 薪資卡不再只比編號');
ok((hub.match(/payMineMaster_\(pick\.me, pick\.store\)/g) || []).length === 3, 'LINE 三條路徑（薪資卡、月份、補休）都用同一套比對');

/* ── 定案的寫入鎖 ── */
const pay = read('apps-script/Payroll.gs');
{
  const src = fnSrc(pay, 'handlePayrollFinalize');
  const lockAt = src.indexOf("payWriteLocked_(['run', 'audit', 'cost_snapshot']");
  const endAt = src.indexOf('})) return PAY_BUSY_;', lockAt);
  ok(lockAt > 0 && endAt > lockAt, '定案有鎖住 run／audit／cost_snapshot');
  const inside = src.slice(lockAt, endAt);
  for (const t of ["payAppend('audit'", 'pnlSnapshotUpsert_(', 'pnlSnapshotRemove_(']) ok(inside.includes(t), '在鎖內：' + t);
  ok(src.indexOf("payAppend('audit'", endAt) === -1 && src.indexOf('pnlSnapshot', endAt) === -1, '鎖外沒有殘留寫入');
}
function finEnv(extra) {
  const s = load({ data: Object.assign({
    run: [{ ym: '2026-09', emp_id: 'E1', store: 'SSLGF', status: 'draft', name: '甲' }], audit: [], cost_snapshot: [] }, extra || {}) });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  return s;
}
{
  const s = finEnv();
  const r = s.call('handlePayrollFinalize', { admin_key: KEY, ym: '2026-09', lock: true, store: 'SSLGF', cost_snapshot: { total: 100 } });
  ok(r.ok === true && r.count === 1, '鎖定成功');
  ok(s.__DATA.run[0].status === 'final', '狀態變 final');
  ok(s.__DATA.audit.length === 1 && s.__DATA.audit[0].action === 'lock', '寫一筆稽核');
  ok(s.__DATA.cost_snapshot.length === 1 && Number(s.__DATA.cost_snapshot[0].total) === 100, '寫一筆損益快照');
  const u = s.call('handlePayrollFinalize', { admin_key: KEY, ym: '2026-09', lock: false, store: 'SSLGF', reason: '更正' });
  ok(u.ok === true && s.__DATA.cost_snapshot.length === 0, '解鎖清掉舊快照');
  ok(s.__DATA.audit.length === 2 && s.__DATA.audit[1].action === 'unlock', '解鎖有稽核');
}
{
  const s = finEnv();
  vm.runInContext('payWriteLocked_ = function(){ return false; };', s);
  const r = s.call('handlePayrollFinalize', { admin_key: KEY, ym: '2026-09', lock: true, store: 'SSLGF', cost_snapshot: { total: 1 } });
  ok(r.ok === false && r.error === 'busy', '搶不到鎖：回忙碌');
  ok(s.__DATA.audit.length === 0 && s.__DATA.cost_snapshot.length === 0, '搶不到鎖：稽核和快照都沒寫');
}
{
  const s = finEnv({ run: [] });
  const r = s.call('handlePayrollFinalize', { admin_key: KEY, ym: '2026-09', lock: true, store: 'SSLGF' });
  ok(r.ok === false && r.error === 'no_run' && s.__DATA.audit.length === 0, '沒有月結資料：不寫稽核');
}

/* ── 門市範圍 ── */
{
  const s = load({ data: {} });
  const list = vm.runInContext('PAY_SCOPE_ADMIN_ONLY', s);
  for (const a of ['payroll_migrate_store', 'payroll_item_upsert', 'payroll_leave_span_set']) ok(list.indexOf(a) >= 0, '有門市範圍時拒絕：' + a);
}

/* ── 管理金鑰與新金鑰 ── */
function adminCheck(cfg, sent) {
  const s = load({ data: {} });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(cfg)};`, s);
  s.__b = { admin_key: sent };
  return vm.runInContext('checkAdmin(__b)', s);
}
ok(adminCheck(KEY, KEY) === true, '正確金鑰通過');
ok(adminCheck(KEY, 'wrong') === false, '錯誤金鑰拒絕');
ok(adminCheck('', '') === false, '金鑰空白：送空字串也拒絕');

const code = read('apps-script/Code.gs');
{
  const src = fnSrc(code, 'genKey');
  ok(src.length > 0 && !src.includes('Math.random'), 'genKey 不用 Math.random');
  let seq = 0;
  const box = { Utilities: {
    DigestAlgorithm: { SHA_256: 'x' },
    getUuid: () => 'u' + (seq++),
    computeDigest: (a, s) => Array.from(require('crypto').createHash('sha256').update(s).digest()).map(b => b > 127 ? b - 256 : b),
  } };
  vm.createContext(box);
  vm.runInContext(src, box);
  const k20 = vm.runInContext('genKey()', box), k40 = vm.runInContext('genKey(40)', box), k90 = vm.runInContext('genKey(90)', box);
  ok(k20.length === 20 && /^[A-Za-z0-9]+$/.test(k20), '預設 20 碼英數');
  ok(k40.length === 40 && k90.length === 90, '指定長度正確（含超過一輪雜湊）');
  ok(k20 !== vm.runInContext('genKey()', box), '兩次結果不同');
  const b2 = { Utilities: { DigestAlgorithm: { SHA_256: 'x' }, getUuid: () => 'u', computeDigest: () => Array(32).fill(-1).map((v, i) => i < 31 ? -1 : 0) } };
  vm.createContext(b2); vm.runInContext(src, b2);
  ok(vm.runInContext('genKey(5)', b2) === 'AAAAA', '248 以上的位元組會捨棄');
}

const verify = read('tools/verify-store-backends.py');
ok(/'hq-clock-in':\s*\('14:00', '15:00'\)/.test(verify), '檢查工具的總部休息帶與現行設定一致');

/* ── 空白金鑰 ── */
{
  const s = load({ data: {} });
  const rows = [{ key: '', active: 'true', emp_id: 'E1' }, { key: 'K', active: 'true', emp_id: 'E2' }];
  s.__rows = rows;
  for (const k of ['', '  ', null, undefined]) {
    s.__k = k;
    ok(vm.runInContext('findRosterByKey(__rows, __k)', s) === undefined, '名冊空白金鑰不算身分：' + JSON.stringify(k));
    ok(vm.runInContext('findManagerByKey(__rows, __k)', s) === undefined, '店長空白金鑰不算身分：' + JSON.stringify(k));
  }
  s.__k = 'K';
  ok(vm.runInContext('findRosterByKey(__rows, __k)', s).emp_id === 'E2', '正確金鑰仍找得到人');
}

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
