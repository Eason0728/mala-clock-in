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
  'payroll_attendance_export', 'payroll_attach_get'];
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

/* opts.realAdmin：不 stub checkAdmin，改用 Code.gs 真的 checkAdmin（比對 CONFIG.ADMIN_KEY，這裡設成假金鑰 FAKE_KEY）
   opts.openById：自訂 SpreadsheetApp.openById（測打卡試算表開不起來） */
const FAKE_KEY = 'fake-admin-key-for-test';
function makeCtx(opts) {
  opts = opts || {};
  const logs = [];
  const sb = { console, Logger: { log(m) { logs.push(String(m)); } },
    SpreadsheetApp: { openById: opts.openById || (() => null), getActive: () => null },
    Utilities: { formatDate: () => '2026-10-29T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return { text: t }; } }) } };
  sb.__logs = logs;
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__DB = SEED();
  sb.__FAKE_KEY = FAKE_KEY;
  vm.runInContext((opts.realAdmin ? 'CONFIG.ADMIN_KEY = __FAKE_KEY;' : 'checkAdmin = function(){ return true; };') + `
    payRead = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll = function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(JSON.parse(JSON.stringify(rows || []))); };
    payInvalidate = function(){}; ensurePayrollSheets = function(){};
  `, sb);
  return sb;
}
let pass = 0, fail = 0;
/* 每次呼叫用全新資料。handler 丟例外＝測試失敗（不再當作「已放行」；假資料不足要補假資料，不是吞掉） */
function call(action, body, opts) {
  const sb = makeCtx(opts);
  sb.__body = JSON.parse(JSON.stringify(body));
  sb.__action = action;
  try { return vm.runInContext('PAYROLL_HANDLERS[__action](__body)', sb); }
  catch (e) { fail++; console.log('✗ ' + action + ' 丟例外：' + String(e && e.stack || e)); return { threw: String(e && e.message) }; }
}
const forbidden = r => !!r && r.error === 'scope_forbidden';
/* 放行的斷言要證明 handler 真的跑完：ok === true，或該 handler 在這份假資料下「應有的業務錯誤」（不是 scope 錯誤） */
const passed = (r, bizErr) => !!r && !r.threw && (bizErr ? (r.ok === false && r.error === bizErr) : r.ok === true);
/* 放行時各 action 的預期（假資料下）：沒列＝ok:true */
const IN_SCOPE_BIZ = { payroll_calc: 'no_holiday', payroll_finalize: 'reason_required', payroll_attach_get: 'not_found' };   // 看證明：假資料沒有申請表，放行後由 handler 回 not_found

const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`); };
const L = ['CF'];

console.log('══ crossStore：L 外的門市一律擋，L 內照常 ══');
ALL.filter(a => a !== 'payroll_store_get').forEach(a => {
  chk(a + ' 帶 SSLGF 被擋', forbidden(call(a, { store: 'SSLGF', scope: L, ym: '2026-10', master: [], config: { a: 1 }, stores: [] })), true);
});
ALL.filter(a => !ADMIN_ONLY.includes(a) && a !== 'payroll_store_get' && a !== 'payroll_bootstrap').forEach(a => {
  const r = call(a, { store: 'CF', scope: L, ym: '2026-10', master: [], config: { a: 1 }, stores: [], inputs: {}, events: [], bonuses: [] });
  chk(a + ' 帶 CF 放行且 handler 跑完（' + (IN_SCOPE_BIZ[a] || 'ok:true') + '）', passed(r, IN_SCOPE_BIZ[a]), true);
  if (!IN_SCOPE_BIZ[a] && 'store' in r) chk(a + ' 回應 store＝CF', r.store, 'CF');
});
chk('payroll_store_get 有範圍放行（ok:true）', passed(call('payroll_store_get', { scope: L })), true);

console.log('\n══ adminOnly：集團功能對有限 scope 一律擋 ══');
ADMIN_ONLY.forEach(a => chk(a + ' 帶 CF 仍被擋', forbidden(call(a, { store: 'CF', scope: L, ym: '2026-10', stores: [] })), true));

console.log('\n══ groupDefault：空白 store＝集團預設，要擋 ══');
chk('config_set 空 store', forbidden(call('payroll_config_set', { store: '', scope: L, config: { a: 1 } })), true);
chk('leave_type_set 空 store', forbidden(call('payroll_leave_type_set', { store: '', scope: L, types: [] })), true);

console.log('\n══ masterMove：換店要兩家都在名單內 ══');
chk('把人換到 L 外被擋', forbidden(call('payroll_master_set', { store: 'CF', scope: ['CF'], master: [{ emp_id: 'X1', store: 'SSLGF' }] })), true);
{ const m = callDb('payroll_master_set', { store: 'CF', scope: ['CF', 'SSLGF'], master: [{ emp_id: 'X1', store: 'SSLGF' }] });
  chk('兩家都在 L 內放行（ok:true，X1 寫進 SSLGF）', [m.r.ok, m.db.master.filter(x => x.emp_id === 'X1').map(x => x.store)], [true, ['SSLGF']]); }

console.log('\n══ noStore：沒帶 store＝預設光復，不在 L 就擋 ══');
chk('payroll_month 無 store', forbidden(call('payroll_month', { scope: L, ym: '2026-10' })), true);

console.log('\n══ caseNorm：大小寫與前後空白 ══');
{ const r = call('payroll_master_get', { store: 'cf', scope: L });
  chk("store 'cf' 放行（ok:true、store CF、主檔是 CF 的人）", [r.ok, r.store, (r.master || []).map(m => m.emp_id)], [true, 'CF', ['T002']]); }
{ const r = call('payroll_master_get', { store: 'CF', scope: ['cf'] });
  chk("scope ['cf'] 對 CF 放行（ok:true）", [r.ok, r.store], [true, 'CF']); }
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

/* 回傳 handler 結果＋呼叫後的假資料庫；seed 可改初始資料 */
function callDb(action, body, seed, opts) {
  const sb = makeCtx(opts);
  if (seed) seed(sb.__DB);
  sb.__body = JSON.parse(JSON.stringify(body));
  sb.__action = action;
  let r;
  try { r = vm.runInContext('PAYROLL_HANDLERS[__action](__body)', sb); }
  catch (e) { fail++; console.log('✗ ' + action + ' 丟例外：' + String(e && e.stack || e)); r = { threw: String(e && e.message) }; }
  return { r, db: sb.__DB, logs: sb.__logs };
}
const empOut = r => forbidden(r) && r.detail === 'emp_out_of_scope';

console.log('\n══ empScope（final review I2）：工時／假別事件日只能寫負責門市主檔裡的人 ══');
chk('input_set 本店人 T002 放行（ok:true、寫入 1 筆）', [call('payroll_input_set', { store: 'CF', scope: L, ym: '2026-10', inputs: { T002: { hours: 8 } } })].map(r => [r.ok, r.count])[0], [true, 1]);
chk('input_set 夾帶別店人 T001 → emp_out_of_scope', empOut(call('payroll_input_set', { store: 'CF', scope: L, ym: '2026-10', inputs: { T002: {}, T001: { annual_h: 80 } } })), true);
chk('input_set 主檔沒有的編號 → emp_out_of_scope', empOut(call('payroll_input_set', { store: 'CF', scope: L, ym: '2026-10', inputs: { NOPE9: { hours: 1 } } })), true);
chk('input_set 兩家都負責 → T001 放行（ok:true）', passed(call('payroll_input_set', { store: 'CF', scope: ['CF', 'SSLGF'], ym: '2026-10', inputs: { T001: {} } })), true);
chk('input_set 被擋時沒有寫入', callDb('payroll_input_set', { store: 'CF', scope: L, ym: '2026-10', inputs: { T001: { annual_h: 80 } } }).db.input, []);
chk('input_set 清除（inputs:{}）放行（ok:true）', passed(call('payroll_input_set', { store: 'CF', scope: L, ym: '2026-10', inputs: {} })), true);
chk("input_set scope '*' 不檢查員工（ok:true）", passed(call('payroll_input_set', { store: 'CF', scope: '*', ym: '2026-10', inputs: { T001: {} } })), true);
const ev = (emp) => ({ emp_id: emp, code: 'marriage', event_date: '2026-10-01' });
chk('leave_event_set 本店人放行（ok:true、saved 1）', [call('payroll_leave_event_set', { store: 'CF', scope: L, events: [ev('T002')] })].map(r => [r.ok, r.saved])[0], [true, 1]);
chk('leave_event_set 別店人 → emp_out_of_scope', empOut(call('payroll_leave_event_set', { store: 'CF', scope: L, events: [ev('T002'), ev('T001')] })), true);
chk('leave_event_set 主檔沒有的編號 → emp_out_of_scope', empOut(call('payroll_leave_event_set', { store: 'CF', scope: L, events: [ev(' X77 ')] })), true);
chk('leave_event_set 空白編號列（handler 本來就丟掉）不擋（ok:true、saved 0）', [call('payroll_leave_event_set', { store: 'CF', scope: L, events: [ev('')] })].map(r => [r.ok, r.saved])[0], [true, 0]);
chk('master_set 新加別店主檔裡的人 → emp_out_of_scope', empOut(call('payroll_master_set', { store: 'CF', scope: L, master: [{ emp_id: 'T002', store: 'CF' }, { emp_id: 'T001', store: 'CF' }] })), true);
chk('master_set 新加只出現在別店工時的人 → emp_out_of_scope', empOut(callDb('payroll_master_set', { store: 'CF', scope: L, master: [{ emp_id: 'T077', store: 'CF' }] },
  db => { db.input.push({ ym: '2026-09', emp_id: 'T077', store: 'SSLGF' }); }).r), true);
chk('master_set 全新編號放行（ok:true、count 2）', [call('payroll_master_set', { store: 'CF', scope: L, master: [{ emp_id: 'T002', store: 'CF' }, { emp_id: 'N001', store: 'CF' }] })].map(r => [r.ok, r.count])[0], [true, 2]);
chk('master_set 本店已有的人（別店也出現過）照常放行（ok:true）', passed(callDb('payroll_master_set', { store: 'CF', scope: L, master: [{ emp_id: 'T002', store: 'CF' }] },
  db => { db.input.push({ ym: '2026-09', emp_id: 'T002', store: 'SSLGF' }); }).r), true);
chk('master_set 新加負責範圍內另一家的人放行（ok:true）', passed(call('payroll_master_set', { store: 'CF', scope: ['CF', 'SSLGF'], master: [{ emp_id: 'T001', store: 'CF' }] })), true);
chk("master_set scope '*' 不檢查（ok:true）", passed(call('payroll_master_set', { store: 'CF', scope: '*', master: [{ emp_id: 'T001', store: 'CF' }] })), true);

console.log('\n══ storeNorm（final review I3）：有範圍時 store 先正規化再交給 handler ══');
{
  const a = callDb('payroll_input_set', { store: ' cf ', scope: L, ym: '2026-10', inputs: { T002: { hours: 3 } } });
  chk("input_set store ' cf ' 寫在 CF", [a.r.ok, a.r.store, a.db.input.map(x => x.store)], [true, 'CF', ['CF']]);
  const b = callDb('payroll_master_set', { store: ' cf ', scope: L, master: [{ emp_id: 'T002', name: '測試乙', store: ' cf ' }] });
  chk("master_set store ' cf ' 覆寫 CF 原列（不重複）", [b.r.ok, b.db.master.filter(m => m.emp_id === 'T002').map(m => m.store)], [true, ['CF']]);
  const c = callDb('payroll_master_set', { store: 'CF', scope: L, master: [{ emp_id: 'T002', store: 'cf' }] });
  chk("master_set 列 store 'cf' 正規化成 CF", c.db.master.filter(m => m.emp_id === 'T002').map(m => m.store), ['CF']);
  const d = callDb('payroll_leave_event_set', { store: 'cf', scope: L, events: [ev('T002')] });
  chk("leave_event_set store 'cf' 寫在 CF", d.db.leave_event.map(x => x.store), ['CF']);
}

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


console.log('\n══ authFirst（fix2-1）：帶 scope 但沒有／錯的管理金鑰 → unauthorized，守門不先讀主檔／工時（不能拿來探員工編號） ══');
{
  const R = { realAdmin: true };
  const probe = { scope: ['CF'], ym: '2026-10' };
  const cases = [
    ['payroll_input_set', Object.assign({ store: 'CF', inputs: { T001: { hours: 1 } } }, probe)],
    ['payroll_master_set', Object.assign({ store: 'CF', master: [{ emp_id: 'T001', store: 'CF' }] }, probe)],
    ['payroll_month', Object.assign({ store: 'SSLGF' }, probe)],
  ];
  cases.forEach(([a, b]) => {
    const r = call(a, b, R);
    chk(a + ' 沒金鑰＋scope → unauthorized（不是 scope_forbidden、不帶 emp_ids）', r, { ok: false, error: 'unauthorized' });
    const w = call(a, Object.assign({ admin_key: 'wrong-key' }, b), R);
    chk(a + ' 錯金鑰＋scope → unauthorized', w, { ok: false, error: 'unauthorized' });
  });
  /* 沒金鑰時守門根本不能讀主檔／工時 */
  { const sb = makeCtx(R); let reads = 0;
    vm.runInContext('var __pr = payRead; payRead = function(k){ globalThis.__reads = (globalThis.__reads||0) + 1; return __pr(k); };', sb);
    sb.__body = { store: 'CF', scope: ['CF'], ym: '2026-10', inputs: { T001: {} } }; sb.__action = 'payroll_input_set';
    vm.runInContext('PAYROLL_HANDLERS[__action](__body)', sb); reads = sb.__reads || 0;
    chk('沒金鑰時守門沒讀任何薪資表', reads, 0); }
  /* 對的金鑰 → 原本行為 */
  chk('對金鑰 input_set 夾帶別店人 → emp_out_of_scope', [call('payroll_input_set', Object.assign({ admin_key: FAKE_KEY }, cases[0][1]), R)].map(r => [r.error, r.detail, r.emp_ids])[0], ['scope_forbidden', 'emp_out_of_scope', ['T001']]);
  chk('對金鑰 master_set 借別店人編號 → emp_out_of_scope', [call('payroll_master_set', Object.assign({ admin_key: FAKE_KEY }, cases[1][1]), R)].map(r => [r.error, r.detail])[0], ['scope_forbidden', 'emp_out_of_scope']);
  chk('對金鑰 payroll_month SSLGF → scope_forbidden', call('payroll_month', Object.assign({ admin_key: FAKE_KEY }, cases[2][1]), R).error, 'scope_forbidden');
  chk('對金鑰 payroll_month CF → ok:true', passed(call('payroll_month', { admin_key: FAKE_KEY, store: 'CF', scope: ['CF'], ym: '2026-10' }, R)), true);
  chk('對金鑰 input_set 本店人 → ok:true', passed(call('payroll_input_set', { admin_key: FAKE_KEY, store: 'CF', scope: ['CF'], ym: '2026-10', inputs: { T002: { hours: 1 } } }, R)), true);
  chk("沒 scope 欄位、沒金鑰 → handler 自己回 unauthorized（舊路不變）", call('payroll_month', { store: 'CF', ym: '2026-10' }, R), { ok: false, error: 'unauthorized' });
  chk("scope '*' 沒金鑰 → unauthorized", call('payroll_month', { store: 'CF', ym: '2026-10', scope: '*' }, R), { ok: false, error: 'unauthorized' });
}

console.log('\n══ bootstrapAdminOnly（fix2-3）：有範圍時「從打卡名冊建立」一律擋（會把整個打卡名冊寫進主檔） ══');
{
  const b = callDb('payroll_bootstrap', { store: 'CF', scope: ['CF'] });
  chk('bootstrap scope [CF] 對 CF → scope_forbidden／admin_only', [b.r.ok, b.r.error, b.r.detail], [false, 'scope_forbidden', 'admin_only']);
  chk('bootstrap 被擋時主檔沒變', b.db.master.length, 2);
  chk('bootstrap scope [] → scope_forbidden', call('payroll_bootstrap', { store: 'CF', scope: [] }).error, 'scope_forbidden');
  const st = call('payroll_bootstrap', { store: 'CF', scope: '*' });
  chk("bootstrap scope '*' 照常（ok:true、added 是數字、names 是陣列）", [st.ok, typeof st.added, Array.isArray(st.names)], [true, 'number', true]);
}

console.log('\n══ bonusEmp（fix2-4）：獎金每個 emp_id 都要在負責門市主檔 ══');
{
  const bn = (emp, amt) => ({ emp_id: emp, bonus_type: 'project', label: '專案', amount: amt == null ? 500 : amt });
  const a = call('payroll_bonus_set', { store: 'CF', scope: L, ym: '2026-10', bonuses: [bn('T002')] });
  chk('bonus_set 本店人放行（ok:true、count 1）', [a.ok, a.count], [true, 1]);
  const b = callDb('payroll_bonus_set', { store: 'CF', scope: L, ym: '2026-10', bonuses: [bn('T002'), bn('T001')] });
  chk('bonus_set 夾帶別店人 T001 → emp_out_of_scope', [b.r.error, b.r.detail, b.r.emp_ids], ['scope_forbidden', 'emp_out_of_scope', ['T001']]);
  chk('bonus_set 被擋時沒有寫入', b.db.bonus, []);
  chk('bonus_set 主檔沒有的編號（含前後空白）→ emp_out_of_scope', call('payroll_bonus_set', { store: 'CF', scope: L, ym: '2026-10', bonuses: [bn(' NOPE ')] }).emp_ids, ['NOPE']);
  chk('bonus_set 金額 0 的別店列也擋（每個 emp_id 都檢查）', call('payroll_bonus_set', { store: 'CF', scope: L, ym: '2026-10', bonuses: [bn('T001', 0)] }).detail, 'emp_out_of_scope');
  chk('bonus_set 空白編號列略過（ok:true、count 0）', [call('payroll_bonus_set', { store: 'CF', scope: L, ym: '2026-10', bonuses: [bn('')] })].map(r => [r.ok, r.count])[0], [true, 0]);
  chk('bonus_set 兩家都負責 → T001 放行', passed(call('payroll_bonus_set', { store: 'CF', scope: ['CF', 'SSLGF'], ym: '2026-10', bonuses: [bn('T001')] })), true);
  chk("bonus_set scope '*' 不檢查", passed(call('payroll_bonus_set', { store: 'CF', scope: '*', ym: '2026-10', bonuses: [bn('T001')] })), true);
}

console.log('\n══ clockSsMsg（fix2-5）：打卡試算表開不起來時，錯誤不帶試算表 ID（只寫門市＋請找系統管理者） ══');
{
  const sb = makeCtx({ openById: (id) => { throw new Error('Exception: 找不到試算表 ' + id); } });
  sb.__req = JSON.stringify({ action: 'payroll_punch', store: 'CF', ym: '2026-10', admin_key: 'x' });
  const out = vm.runInContext('doPost({ postData: { contents: __req } })', sb);
  const j = JSON.parse(out.text);
  chk('doPost 回 server_error', [j.ok, j.error], [false, 'server_error']);
  chk('detail 不含 clock_ss_id', String(j.detail).includes('fake-sheet-2'), false);
  chk('detail 有門市與「請找系統管理者檢查門市設定」', /CF/.test(j.detail) && j.detail.includes('請找系統管理者檢查門市設定'), true);
  chk('試算表 ID 只寫進 Logger', sb.__logs.some(l => l.includes('fake-sheet-2')), true);
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
