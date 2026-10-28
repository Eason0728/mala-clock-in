/* 薪資後端 scope 守門與回應裁切（body.scope：沒欄位／'*'／門市代碼陣列）
 * 管理系統（平台）負責門市權限，薪資後端依 body.scope 擋「不在名單內的門市」並裁掉回應裡的其他門市。
 * 全部使用虛構門市與員工資料。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

/* 代轉白名單（平台 PROXY_READ_ACTIONS.payroll ＋ PROXY_WRITE_ACTIONS.payroll），共 23 支 */
const READ_ACTIONS = ['payroll_month', 'payroll_get', 'payroll_group', 'payroll_trend', 'payroll_inputs', 'payroll_punch',
  'payroll_master_get', 'payroll_store_get', 'payroll_leave_type_get', 'payroll_leave_event_get', 'payroll_leave_options',
  'payroll_attendance_export'];
const WRITE_ACTIONS = ['payroll_calc', 'payroll_finalize', 'payroll_bootstrap', 'payroll_master_set', 'payroll_config_set',
  'payroll_holiday_sync', 'payroll_input_set', 'payroll_bonus_set', 'payroll_store_set', 'payroll_leave_type_set',
  'payroll_leave_event_set'];
const ALL = READ_ACTIONS.concat(WRITE_ACTIONS);
const ADMIN_ONLY = ['payroll_group', 'payroll_store_set', 'payroll_holiday_sync', 'payroll_get'];

const SEED = () => ({
  store: [
    { code: 'SSLGF', name: '甲店', active: 'true', clock_ss_id: 'fake-sheet-1' },
    { code: 'CF', name: '乙廚', active: 'true', clock_ss_id: 'fake-sheet-2' },
    { code: 'ZZ', name: '丙店', active: 'true', clock_ss_id: 'fake-sheet-3' },
  ],
  master: [
    { emp_id: 'T001', name: '測試甲', store: 'SSLGF' },
    { emp_id: 'T002', name: '測試乙', store: 'CF' },
  ],
  config: [], holiday: [], run: [], item: [], input: [], audit: [], bonus: [],
  leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [],
});

function makeCtx() {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-10-29T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__DB = SEED();
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll = function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(){}; payInvalidate = function(){}; ensurePayrollSheets = function(){};
  `, sb);
  return sb;
}
/* 每次呼叫用全新資料；handler 內部丟例外（假資料不足）也當作「已放行到 handler」 */
function call(action, body) {
  const sb = makeCtx();
  sb.__body = JSON.parse(JSON.stringify(body));
  sb.__action = action;
  try { return vm.runInContext('PAYROLL_HANDLERS[__action](__body)', sb); }
  catch (e) { return { threw: String(e && e.message) }; }
}
const forbidden = r => !!r && r.error === 'scope_forbidden';

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`); };
const L = ['CF'];

console.log('══ crossStore：L 外的門市一律擋，L 內照常 ══');
ALL.filter(a => a !== 'payroll_store_get').forEach(a => {
  chk(a + ' 帶 SSLGF 被擋', forbidden(call(a, { store: 'SSLGF', scope: L, ym: '2026-10', master: [], config: { a: 1 }, stores: [] })), true);
});
ALL.filter(a => !ADMIN_ONLY.includes(a) && a !== 'payroll_store_get').forEach(a => {
  chk(a + ' 帶 CF 不是 scope_forbidden', forbidden(call(a, { store: 'CF', scope: L, ym: '2026-10', master: [], config: { a: 1 }, stores: [], inputs: {}, events: [] })), false);
});

console.log('\n══ adminOnly：集團功能對有限 scope 一律擋 ══');
ADMIN_ONLY.forEach(a => chk(a + ' 帶 CF 仍被擋', forbidden(call(a, { store: 'CF', scope: L, ym: '2026-10', stores: [] })), true));

console.log('\n══ groupDefault：空白 store＝集團預設，要擋 ══');
chk('config_set 空 store', forbidden(call('payroll_config_set', { store: '', scope: L, config: { a: 1 } })), true);
chk('leave_type_set 空 store', forbidden(call('payroll_leave_type_set', { store: '', scope: L, types: [] })), true);

console.log('\n══ masterMove：換店要兩家都在名單內 ══');
chk('把人換到 L 外被擋', forbidden(call('payroll_master_set', { store: 'CF', scope: ['CF'], master: [{ emp_id: 'X1', store: 'SSLGF' }] })), true);
chk('兩家都在 L 內放行', forbidden(call('payroll_master_set', { store: 'CF', scope: ['CF', 'SSLGF'], master: [{ emp_id: 'X1', store: 'SSLGF' }] })), false);

console.log('\n══ noStore：沒帶 store＝預設光復，不在 L 就擋 ══');
chk('payroll_month 無 store', forbidden(call('payroll_month', { scope: L, ym: '2026-10' })), true);

console.log('\n══ caseNorm：大小寫與前後空白 ══');
chk("store 'cf' 放行", forbidden(call('payroll_master_get', { store: 'cf', scope: L })), false);
chk("scope ['cf'] 對 CF 放行", forbidden(call('payroll_master_get', { store: 'CF', scope: ['cf'] })), false);
chk("store 'sslgf' 對 ['CF'] 仍被擋", forbidden(call('payroll_master_get', { store: 'sslgf', scope: L })), true);

console.log('\n══ scopeShape：其他形狀回 scope_bad ══');
['["CF"]', {}, [1], 'all', null, [''], [['CF']]].forEach(s => {
  const r = call('payroll_master_get', { store: 'CF', scope: s });
  chk('scope=' + JSON.stringify(s), r.error, 'scope_bad');
});

console.log('\n══ trim：stores 只留 L、不含 clock_ss_id ══');
['payroll_master_get', 'payroll_month', 'payroll_store_get'].forEach(a => {
  const r = call(a, { store: 'CF', scope: L, ym: '2026-10' });
  const st = r.stores || [];
  chk(a + ' stores 只剩 CF（且有東西）', [st.length > 0, st.every(s => s.code === 'CF')], [true, true]);
  chk(a + ' 無 clock_ss_id', st.every(s => !('clock_ss_id' in s)), true);
  if (a === 'payroll_master_get') chk('master_get scope', r.scope, ['CF']);
});

console.log('\n══ emptyScope：scope:[] ══');
chk('master_get 回空殼', call('payroll_master_get', { store: 'CF', scope: [] }),
  { ok: true, stores: [], master: [], config: {}, scope: [] });
chk('payroll_month 被擋', forbidden(call('payroll_month', { store: 'CF', scope: [], ym: '2026-10' })), true);
chk('payroll_store_get 回空清單', call('payroll_store_get', { scope: [] }).stores, []);

console.log("\n══ starIdentical：scope '*' 與沒有 scope 欄位，回應逐欄相同 ══");
ALL.forEach(a => {
  const b = { store: 'CF', ym: '2026-10', master: [{ emp_id: 'T9', store: 'CF' }], config: { daily_hours: 8 },
    stores: [{ code: 'CF', name: '乙廚' }], inputs: {}, events: [], types: [], bonuses: [] };
  const none = call(a, b), star = call(a, Object.assign({ scope: '*' }, b));
  if (a === 'payroll_master_get') { const sc = [star.scope, none.scope]; delete star.scope; delete none.scope;
    chk('master_get 除 scope 欄外相同（兩者 scope 皆為 *）', [JSON.stringify(star) === JSON.stringify(none), sc], [true, ['*', '*']]); }
  else chk(a + ' 相同', JSON.stringify(star), JSON.stringify(none));
});
{
  const r = call('payroll_master_get', { store: 'CF', scope: '*' });
  chk('星號 master_get 保留 clock_ss_id 與三家門市', [r.stores.length, r.stores.every(s => 'clock_ss_id' in s), r.scope], [3, true, '*']);
  const n = call('payroll_master_get', { store: 'CF' });
  chk('無欄位 master_get scope 填 *', n.scope, '*');
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
