/* 薪資影子唯讀匯出 payroll_shadow_export（P4-1 Google 端，2026-11-22）
 * 用途：Mac mini 每天凌晨拉薪資資料做影子試算（只比對、不切換）。契約 dzy-mini-playbook docs/clock-to-mini/contracts/p-line-payshadow.md。
 * 守的事：
 *   1. 權限：只有總管理金鑰過；錯金鑰、沒金鑰、主管金鑰 → unauthorized（逐字、不洩漏任何東西、一張分頁都不讀）；
 *      帶門市範圍 → scope_forbidden（跟同層的 payroll_get 同結果）。走 doPost 真的分派。
 *   2. 白名單：每列欄位＝白名單（分頁上多出來的欄、名單外的欄、身分證／銀行帳號假欄一律不出現）；名單外的分頁不出現；
 *      w1 跟 mini 端 payshadow-whitelist.js（mala-clock-mini 8f8c017）逐字相同。
 *   3. 唯讀：分頁內容、指令碼屬性、觸發器清單前後完全相同；沒有任何寫入類呼叫（建分頁、寫格子、取鎖、寫快取）；
 *      分頁不存在不建分頁；草稿過期也不重算（對照組：同情境 payroll_month 會重算寫回）；靜態檢查程式裡沒有寫入類呼叫。
 *   4. 月份：本月往前 3 個月內才收；空月份回空陣列；整月一次回齊、不重不漏；超過上限回 too_many_rows、不截斷。
 *   5. 形狀：契約 4.2 的鍵；值只有字串／數字／布林／null；日期轉台北 YYYY-MM-DD；mini 端 checkExport 吃得下。
 *   6. 轉換：custom_add_more 只留金額（算出來的加薪金額不變）、留停 child 換代號（育嬰額度分組不變）。
 *   7. 選舉假名單 hol_emp（2026-11-23）：只出 ym、date、store、emp_id；name／note／updated_at 不出；只回 ym 那個月；分頁不存在＝空陣列；匯出列與原列算出的選舉日相同。
 * 假資料全部虛構（姓名「測試甲」、身分證／帳號是明顯的假字串），不碰正式試算表。
 * PAY_GS_OVERRIDE＝改用別份 Payroll.gs（只給變異測試用）。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const GS = process.env.PAY_GS_OVERRIDE ? fs.readFileSync(process.env.PAY_GS_OVERRIDE, 'utf8') : rd('Payroll.gs');
const C = rd('Code.gs'), DF = rd('DutyFeed.gs');
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + String(JSON.stringify(got)).slice(0, 300) + (ok ? '' : ' ← 應為 ' + String(JSON.stringify(want)).slice(0, 300))); };
const ADMIN = 'TEST-ADMIN-KEY-0000';

/* mini 端 checkExport（mala-clock-mini origin/main 8f8c017 mini/payshadow-whitelist.js，逐字抄；只把 WHITELIST 改成參數，好拿來檢查 w2） */
const MINI_W1 = {
  master: ['emp_id', 'is_full_time', 'wage', 'base', 'ot_rate',
    'skill_allow', 'night_allow', 'mgr_allow', 'editor_allow', 'attend_cap', 'meal_allow',
    'labor_ins', 'health_ins', 'group_ins', 'pension', 'co_labor', 'co_health', 'co_pension',
    'dormitory', 'hire_date', 'leave_date', 'store'],
  config: ['key', 'value', 'store'],
  holiday: ['ym', 'red_days', 'dates', 'store'],
  store: ['code', 'name', 'emp_prefix', 'active', 'sort', 'support_group'],
  run: ['ym', 'emp_id', 'store', 'is_full_time', 'ratio', 'total_hours', 'base_hours', 'surplus_hours',
    'ot_paid_hours', 'support_hours', 'support_auto_h', 'gross', 'deduction', 'net', 'as_of'],
  item: ['ym', 'emp_id', 'store', 'item_type', 'item_key', 'qty', 'rate', 'amount', 'source'],
};
function miniCheckExport(resp, ym, WHITELIST, WHITELIST_VERSION) {
  const FORMAT = 'payshadow-v1', TABLES = Object.keys(WHITELIST);
  if (!resp || typeof resp !== 'object') return { ok: false, code: 'bad_response' };
  if (resp.format !== FORMAT) return { ok: false, code: 'bad_format' };
  if (resp.whitelist_version !== WHITELIST_VERSION) return { ok: false, code: 'whitelist_version_mismatch' };
  if (resp.ym !== ym) return { ok: false, code: 'ym_mismatch' };
  const t = resp.tables;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok: false, code: 'no_tables' };
  for (const name of Object.keys(t)) {
    if (!Object.prototype.hasOwnProperty.call(WHITELIST, name)) return { ok: false, code: 'non_whitelisted_table', table: name };
  }
  const counts = {};
  for (const name of TABLES) {
    const rows = t[name];
    if (!Array.isArray(rows)) return { ok: false, code: 'missing_table', table: name };
    const allow = new Set(WHITELIST[name]);
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, code: 'bad_row', table: name };
      for (const col of Object.keys(r)) {
        if (!allow.has(col)) return { ok: false, code: 'non_whitelisted_column', table: name, column: col };
        const v = r[col];
        if (v !== null && typeof v === 'object') return { ok: false, code: 'nested_value', table: name, column: col };
      }
    }
    counts[name] = rows.length;
  }
  if (counts.master === 0) return { ok: false, code: 'empty_master', table: 'master' };
  return { ok: true, counts };
}

/* ── 假試算表：所有寫入類方法都記一筆（用 Proxy 抓，沒列在「讀」名單的方法一律算寫入） ── */
const SHEET_READS = new Set(['getName', 'getSheetId', 'getDataRange', 'getLastRow', 'getLastColumn', 'getMaxRows', 'getMaxColumns', 'getFrozenRows']);
const RANGE_READS = new Set(['getValues', 'getDisplayValues', 'getNumRows', 'getNumColumns', 'getValue']);
function book(sheets) {
  const w = { sheets, writes: [], reads: 0, opens: 0, props: { SOME_PROP: 'v' }, triggers: [{ fn: 'payAsOfDaily' }] };
  /* getRange(列, 欄, 列數, 欄數)：取那一塊（跟真的一樣，超出表的格子補 ''）；w.cells 累計取值格數、w.gets 記每次取值的範圍（擋項三的測試用）。
     range 上除了讀以外的方法一律算寫入。getLastColumn＝最寬那一列的欄數；只有 [[]] 的分頁＝0 列 0 欄。 */
  w.cells = 0; w.gets = [];
  const width = (name) => sheets[name].reduce((m, r) => Math.max(m, r.length), 0);
  const lastRow = (name) => (width(name) ? sheets[name].length : 0);
  const rangeOf = (name, box) => new Proxy({}, { get: (_, m) => RANGE_READS.has(m)
    ? () => {
      if (m !== 'getValues') return 0;
      const b = box || [1, 1, lastRow(name), width(name)];
      if (w.beforeGet) w.beforeGet(name, b);   // 測試用：模擬兩次讀取之間儲存格被改
      w.cells += b[2] * b[3]; w.gets.push(name + '@' + b.join(','));
      const out = [];
      for (let i = 0; i < b[2]; i++) { const src = sheets[name][b[0] - 1 + i] || []; const row = []; for (let j = 0; j < b[3]; j++) { const v = src[b[1] - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
      return out;
    }
    : (...a) => { w.writes.push(name + '.range.' + String(m)); return rangeOf(name, box); } });
  const sheetOf = (name) => new Proxy({}, { get: (_, m) => {
    if (m === 'getDataRange') return () => rangeOf(name);
    if (m === 'getRange') return (r, c, nr, nc) => rangeOf(name, [r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc]);
    if (m === 'getName') return () => name;
    if (m === 'getSheetId') return () => Object.keys(sheets).indexOf(name);
    if (m === 'getLastRow') return () => lastRow(name);
    if (m === 'getLastColumn') return () => width(name);
    if (SHEET_READS.has(m)) return () => sheets[name].length;
    return (...a) => { w.writes.push(name + '.' + String(m)); return undefined; };
  } });
  w.ss = new Proxy({}, { get: (_, m) => {
    if (m === 'getSheetByName') return (n) => { w.reads++; return Object.prototype.hasOwnProperty.call(sheets, n) ? sheetOf(n) : null; };
    if (m === 'getId') return () => 'FAKE';
    return (...a) => { w.writes.push('ss.' + String(m)); if (m === 'insertSheet') { sheets[a[0]] = [[]]; return sheetOf(a[0]); } };
  } });
  return w;
}
const snapOf = (w) => JSON.stringify({ s: w.sheets, p: w.props, t: w.triggers }, (k, v) => v);

/* ── 一個世界：真的 Code.gs＋Payroll.gs＋DutyFeed.gs，假的 Google 服務 ── */
function world(sheets, today) {
  const w = book(sheets);
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => { w.opens++; return w.ss; }, getActive: () => w.ss, flush() {} },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? (today || '2026-11-22') : (today || '2026-11-22') + 'T05:20:00+08:00'),
                 getUuid: () => '00000000-0000-0000-0000-000000000000' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (w.props[k] === undefined ? null : w.props[k]), getProperties: () => Object.assign({}, w.props),
      setProperty: (k, v) => { w.writes.push('props.set'); w.props[k] = v; }, setProperties: () => { w.writes.push('props.setAll'); },
      deleteProperty: (k) => { w.writes.push('props.delete'); delete w.props[k]; } }) },
    ScriptApp: { getProjectTriggers: () => w.triggers.slice(), newTrigger: () => { w.writes.push('trigger.new'); throw new Error('不准建觸發器'); },
      deleteTrigger: () => { w.writes.push('trigger.delete'); } },
    LockService: { getScriptLock: () => { w.writes.push('lock'); return { tryLock: () => true, waitLock() {}, releaseLock() {} }; },
      getDocumentLock: () => { w.writes.push('lock'); return { tryLock: () => true, waitLock() {}, releaseLock() {} }; } },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => { w.writes.push('cache.put'); }, remove: () => { w.writes.push('cache.remove'); } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + GS + '\n' + DF, sb);
  vm.runInContext("CONFIG.ADMIN_KEY = '" + ADMIN + "'; CONFIG.SPREADSHEET_ID = 'FAKE';", sb);
  const F = (n) => vm.runInContext(n, sb);
  const post = (body) => JSON.parse(F('doPost')({ postData: { contents: JSON.stringify(body) } }).s);
  return Object.assign(w, { sb, F, post });
}

/* ── 假資料：每張薪資分頁都多塞名單外的欄與假的敏感值（SECRET／假身分證／假帳號），回應裡一個都不准出現 ── */
const PS = (() => { const sb = {}; vm.createContext(sb); vm.runInContext(C + '\n' + GS + '\nglobalThis.__S = PAY_SHEETS; globalThis.__N = PAY_SHEET_NAME;', sb); return { S: sb.__S, N: sb.__N }; })();
const D = (iso) => new Date(iso);   // 試算表把純日期存成 Date（台北 00:00＝前一天 16:00Z）
function tab(kind, rows, extraCols) {
  const cols = PS.S[kind].concat(extraCols || []);
  return [cols].concat(rows.map((r) => cols.map((c) => (r[c] === undefined ? '' : r[c]))));
}
const SECRET_RE = /SECRET|X000000000|BANK-000|測試甲|測試乙|測試丙|選舉丁/;
function baseSheets(opt) {
  opt = opt || {};
  const people = [['E1', '測試甲', 'true'], ['E2', '測試乙', 'false'], ['E3', '測試丙', 'true']];
  const s = {};
  s[PS.N.master] = tab('master', people.map(([id, nm, ft], i) => ({ emp_id: id, name: nm, is_full_time: ft, wage: ft === 'true' ? 0 : 200, base: ft === 'true' ? 34000 : 0,
    ot_rate: 0, skill_allow: 0, night_allow: 0, mgr_allow: 1000, editor_allow: 0, attend_cap: 2000, labor_ins: 700, health_ins: 500, group_ins: 0, pension: 0,
    dormitory: 0, hire_date: D('2023-07-02T16:00:00Z'), leave_date: '', active: true, updated_at: 'SECRET-UPDATED', meal_allow: 2000, store: i === 2 ? 'CF' : 'SSLGF',
    gap_rate: 0.1, co_labor: 1500, co_health: 1200, co_pension: 2000, yearend_months: 1, id_no: 'X000000000', bank_account: 'BANK-000-TEST' })), ['id_no', 'bank_account']);
  s[PS.N.config] = tab('config', [{ key: 'daily_hours', value: 8, note: 'SECRET-NOTE', store: '' }, { key: 'late_deduct', value: 'true', note: 'SECRET-NOTE', store: 'CF' }]);
  s[PS.N.holiday] = tab('holiday', [{ ym: '2026-11', red_days: 9, note: 'SECRET-NOTE', dates: '2026-11-12', store: '' },
    { ym: '2026-10', red_days: 10, note: 'SECRET-NOTE', dates: '2026-10-10', store: '' }]);
  s[PS.N.store] = tab('store', [{ code: 'SSLGF', name: '測試店一', clock_ss_id: 'SECRET-SSID', dzy_node: 'SECRET-NODE', emp_prefix: 'E', active: true, sort: 1, brand: 'SECRET-BRAND', support_group: 'sxl' },
    { code: 'CF', name: '測試店二', clock_ss_id: 'SECRET-SSID', dzy_node: 'SECRET-NODE', emp_prefix: 'C', active: true, sort: 2, brand: 'SECRET-BRAND', support_group: 'sxl' }]);
  const run = [];
  ['2026-11', '2026-10'].forEach((ym) => people.forEach(([id, nm, ft], i) => run.push({ ym, emp_id: id, name: nm, is_full_time: ft, ratio: 1, total_hours: 176, base_hours: 160,
    surplus_hours: 16, ot_paid_hours: 2, gross: 40000 + i, deduction: 1200, net: 38800 + i, status: ym === '2026-10' ? 'final' : 'draft', run_at: '2026-11-21T06:10:00+08:00',
    support_hours: 0, store: i === 2 ? 'CF' : 'SSLGF', support_auto_h: 0, ot_info: '{"SECRET":1}', as_of: ym === '2026-11' ? '2026-11-21' : '', elec_fp: 'SECRET-FP' })));
  s[PS.N.run] = tab('run', run);
  const item = [];
  ['2026-11', '2026-10'].forEach((ym) => people.forEach(([id], i) => ['base', 'meal', 'labor_ins'].forEach((k, j) => item.push({ ym, emp_id: id, item_type: j < 2 ? 'earn' : 'ded',
    item_key: k, item_label: 'SECRET-LABEL', qty: '', rate: '', amount: 1000 * (j + 1), source: 'calc', memo: 'SECRET-MEMO', store: i === 2 ? 'CF' : 'SSLGF' }))));
  s[PS.N.item] = tab('item', item);
  s[PS.N.input] = tab('input', [
    { ym: '2026-11', emp_id: 'E1', hours: 0, sick_h: 8, menstrual_h: 0, support: '[{"code":"CF","store":"測試店二","hours":4,"rate":200,"amount":"","auto":true}]',
      updated_at: 'SECRET-UPDATED', custom_add_label: 'SECRET-LABEL', custom_add_amt: 300, custom_ded_label: 'SECRET-LABEL', custom_ded_amt: 100, store: 'SSLGF',
      custom_add_more: '[{"label":"SECRET-LABEL-A","amt":500},{"label":"SECRET-LABEL-B","amt":"1,200"},null]', hours_manual: '1' },
    { ym: '2026-11', emp_id: 'E2', custom_add_more: 'SECRET-LABEL{壞掉', store: 'SSLGF' },
    { ym: '2026-10', emp_id: 'E2', custom_add_more: '{"label":"SECRET-LABEL"}', store: 'SSLGF' },
    { ym: '2025-01', emp_id: 'E1', annual_h: 8, custom_add_more: '', store: 'SSLGF' },
    { ym: '2024-12', emp_id: 'E1', annual_h: 16, store: 'SSLGF' },      // 早於「去年 1 月」→ 不回
    { ym: 'SECRET-bad', emp_id: 'E1', store: 'SSLGF' },                  // 月份格式不對 → 不回（計算也認不得）
  ]);
  s[PS.N.bonus] = tab('bonus', [{ ym: '2026-11', store: 'SSLGF', emp_id: 'E1', bonus_type: 'perf', label: 'SECRET-LABEL', amount: 3000, memo: 'SECRET-MEMO', updated_at: 'SECRET-UPDATED' },
    { ym: '2026-10', store: 'SSLGF', emp_id: 'E1', bonus_type: 'sales', label: 'SECRET-LABEL', amount: 1000, memo: 'SECRET-MEMO', updated_at: 'x' }]);
  s[PS.N.leave_type] = tab('leave_type', [{ code: 'sick', name: '病假', pay_ratio: 0.5, count_absent: true, cap_days: 30, cap_basis: 'year', active: true, sort: 1, note: 'SECRET-NOTE', store: '' }]);
  s[PS.N.leave_span] = tab('leave_span', [
    { emp_id: 'E1', name: '測試甲', store: 'SSLGF', code: 'parental', child: 'SECRET-CHILD-B', unit: 'month', start: D('2026-01-31T16:00:00Z'), end: '2026-04-30', months: 3, days: '', memo: 'SECRET-MEMO', updated_at: 'x' },
    { emp_id: 'E1', name: '測試甲', store: 'SSLGF', code: 'parental', child: 'SECRET-CHILD-A', unit: 'month', start: '2025-01-01', end: '2025-06-30', months: 6, days: '', memo: 'SECRET-MEMO', updated_at: 'x' },
    { emp_id: 'E1', name: '測試甲', store: 'SSLGF', code: 'parental', child: ' SECRET-CHILD-A ', unit: 'day', start: '2025-08-01', end: '2025-08-10', months: '', days: 10, memo: '', updated_at: 'x' },
    { emp_id: 'E1', name: '測試甲', store: 'SSLGF', code: 'parental', child: '', unit: 'day', start: '2025-09-01', end: '2025-09-05', months: '', days: 5, memo: '', updated_at: 'x' },
    { emp_id: 'E2', name: '測試乙', store: 'SSLGF', code: 'parental', child: 'SECRET-CHILD-A', unit: 'month', start: '2026-03-01', end: '2026-05-31', months: 3, days: '', memo: '', updated_at: 'x' },
  ]);
  s[PS.N.leave_event] = tab('leave_event', [{ emp_id: 'E1', name: '測試甲', store: 'SSLGF', code: 'marriage', event_date: '2026-10-01', memo: 'SECRET-MEMO', updated_at: 'x' }]);
  s[PS.N.xmap] = tab('xmap', [{ emp_no: 'D001', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'C9', not_support: '', synced_at: 'SECRET-SYNC', state: 'active', acct_only: '' }]);
  s[PS.N.audit] = tab('audit', [{ ts: 'x', ym: '2026-11', action: 'lock', operator: 'SECRET-OP', reason: 'SECRET-REASON', store: 'SSLGF' }]);
  s[PS.N.cost_snapshot] = tab('cost_snapshot', [{ ym: '2026-11', store: 'SSLGF', detail_json: '{"SECRET":1}' }]);
  /* 選舉假名單：姓名用「選舉丁」、備註 SECRET-NOTE、updated_at SECRET-UPD——回應裡一個都不准出現（只出 ym、date、store、emp_id） */
  s[PS.N.hol_emp] = tab('hol_emp', [
    { ym: '2026-11', date: '2026-11-28', store: 'SSLGF', emp_id: 'E1', name: '選舉丁', note: 'SECRET-NOTE', updated_at: 'SECRET-UPD' },
    { ym: '2026-11', date: D('2026-11-27T16:00:00Z'), store: 'CF', emp_id: 'E3', name: '選舉丁', note: 'SECRET-NOTE', updated_at: 'SECRET-UPD' },   // 日期儲存格被轉成 Date
    { ym: '2026-10', date: '2026-10-10', store: 'SSLGF', emp_id: 'E2', name: '選舉丁', note: 'SECRET-NOTE', updated_at: 'SECRET-UPD' },        // 別的月份
  ]);
  if (opt.mut) opt.mut(s);
  return s;
}
const ask = (w, extra) => w.post(Object.assign({ action: 'payroll_shadow_export', admin_key: ADMIN, ym: '2026-11', whitelist_version: 'w2' }, extra || {}));
const W2 = (w) => JSON.parse(w.F('JSON.stringify(PAY_SHADOW_W2_)'));
const W1 = (w) => JSON.parse(w.F('JSON.stringify(PAY_SHADOW_W1_)'));

console.log('══ 0) 有登記：分派表、只限總管理清單 ══');
{
  const w = world(baseSheets());
  chk('  PAYROLL_HANDLERS 有 payroll_shadow_export', w.F("typeof PAYROLL_HANDLERS.payroll_shadow_export"), 'function');
  chk('  列在 PAY_SCOPE_ADMIN_ONLY（帶門市範圍一律擋）', w.F("PAY_SCOPE_ADMIN_ONLY.indexOf('payroll_shadow_export') >= 0"), true);
  chk('  DutyFeed 當唯讀（不記變動）', w.F("dutyFeedIsRead_('payroll_shadow_export')"), true);
}

console.log('══ 1) 權限 ══');
{
  const cls = (r) => (r && r.ok ? 'ok' : String(r && r.error)) + (r && r.detail ? ':' + r.detail : '');
  const cases = [
    ['總管理金鑰', { admin_key: ADMIN }, 'ok'],
    ['錯金鑰', { admin_key: 'WRONG' }, 'unauthorized'],
    ['沒有金鑰', { admin_key: undefined }, 'unauthorized'],
    ['空字串金鑰', { admin_key: '' }, 'unauthorized'],
    ['主管金鑰（mgr_key，沒有 admin_key）', { admin_key: undefined, mgr_key: 'MGR-KEY-TEST' }, 'unauthorized'],
    ['總管理金鑰＋門市範圍 [SSLGF]', { scope: ['SSLGF'] }, 'scope_forbidden:集團功能，限系統管理者'],
    ['總管理金鑰＋空範圍 []', { scope: [] }, 'scope_forbidden:集團功能，限系統管理者'],
    ['總管理金鑰＋範圍形狀錯', { scope: 'SSLGF' }, 'scope_bad:scope 必須是 * 或門市代碼陣列'],
    ['錯金鑰＋門市範圍', { admin_key: 'WRONG', scope: ['SSLGF'] }, 'unauthorized'],
    ['總管理金鑰＋scope *（＝不限門市的系統管理者）', { scope: '*' }, 'ok'],
  ];
  for (const [lab, b, want] of cases) {
    const w = world(baseSheets());
    const before = snapOf(w);
    const r = ask(w, b);
    chk('  ' + lab + ' → ' + want, cls(r), want);
    if (want !== 'ok') {
      chk('    拒絕時沒有 tables、沒讀任何分頁、沒有寫入、資料不變', ['tables' in r, w.reads, w.writes, snapOf(w) === before], [false, 0, [], true]);
      /* 跟同層的 payroll_get（只限總管理的唯讀動作）同一種拒絕 */
      const g = world(baseSheets()).post(Object.assign({ action: 'payroll_get', admin_key: ADMIN, ym: '2026-11' }, b));
      chk('    跟 payroll_get 同一種拒絕', cls(r), cls(g));
    }
  }
  const w = world(baseSheets());
  chk('  錯金鑰回應逐字＝{ok:false,error:unauthorized}（不回月份、分頁、筆數）', ask(w, { admin_key: 'WRONG' }), { ok: false, error: 'unauthorized' });
  chk('  錯金鑰＋壞月份＋壞版本 → 還是 unauthorized（先驗金鑰）', ask(w, { admin_key: 'WRONG', ym: 'SECRET', whitelist_version: 'zz' }), { ok: false, error: 'unauthorized' });
  chk('  金鑰設定是空的（範本值沒換）→ 空字串金鑰也不過', (() => { const x = world(baseSheets()); x.F("CONFIG.ADMIN_KEY = ''"); return ask(x, { admin_key: '' }); })(), { ok: false, error: 'unauthorized' });
}

console.log('══ 2) 白名單 ══');
{
  const w = world(baseSheets());
  const r = ask(w);
  const wl = W2(w);
  chk('  w2 成功', [r.ok, r.format, r.whitelist_version, r.ym], [true, 'payshadow-v1', 'w2', '2026-11']);
  chk('  分頁集合＝w2 白名單的分頁（沒有 leave_event、audit、cost_snapshot）', Object.keys(r.tables), Object.keys(wl));
  chk('  w2 沒有 leave_event、audit、cost_snapshot 這三張', ['leave_event', 'audit', 'cost_snapshot'].filter((k) => k in r.tables), []);
  let extra = [];
  for (const t of Object.keys(r.tables)) r.tables[t].forEach((row) => Object.keys(row).forEach((k) => { if (wl[t].indexOf(k) < 0) extra.push(t + '.' + k); }));
  chk('  每列欄位 ⊆ 白名單（名單外的欄 0 個）', extra, []);
  chk('  欄位齊全的列：鍵＝白名單、順序也一樣（master 第 1 列）', Object.keys(r.tables.master[0]), wl.master);
  chk('  敏感假值（身分證、銀行帳號、SECRET 標記的 label／memo／note／ot_info／打卡試算表 ID）一個都沒出現', SECRET_RE.test(JSON.stringify(r).replace(/測試甲|測試乙|測試丙/g, '')), false);
  chk('  w2 主檔有 name（Eason 11/21 同意）', r.tables.master.map((m) => m.name), ['測試甲', '測試乙', '測試丙']);
  chk('  身分證、銀行帳號欄名不在任何一列', /id_no|bank_account/.test(JSON.stringify(r.tables)), false);
  /* 分頁上又多一個新欄（例：日後有人手加「手機」欄）→ 照樣不帶出去 */
  const w3 = world(baseSheets({ mut: (s) => { const t = s[PS.N.master]; t[0].push('phone_new'); for (let i = 1; i < t.length; i++) t[i].push('SECRET-PHONE'); } }));
  const r3 = ask(w3);
  chk('  主檔多一個名單外的新欄 → 回應裡沒有這欄、也沒有值', [r3.ok, /phone_new|SECRET-PHONE/.test(JSON.stringify(r3))], [true, false]);
  /* w1：跟 mini 端目前的白名單逐字相同 */
  const r1 = ask(w, { whitelist_version: 'w1' });
  chk('  Payroll.gs 的 w1＝mini 端 payshadow-whitelist.js（8f8c017）逐字相同', W1(w), MINI_W1);
  chk('  w1 只回 6 張表、沒有姓名', [Object.keys(r1.tables), /測試甲|"name":"測試/.test(JSON.stringify(r1.tables.master))], [Object.keys(MINI_W1), false]);
  chk('  w2＝w1＋契約第 3 節建議同意的（主檔 name、active；leave_type、input、bonus、leave_span、xmap）＋選舉假名單 hol_emp（11/23）',
    [wl.master.slice(MINI_W1.master.length), Object.keys(wl).filter((k) => !MINI_W1[k])], [['name', 'active'], ['leave_type', 'input', 'bonus', 'leave_span', 'xmap', 'hol_emp']]);
  chk('  w2 的 hol_emp 只有 ym、date、store、emp_id（不抄 name／note／updated_at）', wl.hol_emp, ['ym', 'date', 'store', 'emp_id']);
  chk('  w2 的 input 不抄兩個 label、bonus 不抄 label／memo、leave_span 不抄 name／memo',
    [wl.input.filter((c) => /label|updated_at/.test(c)), wl.bonus.filter((c) => /label|memo|updated_at/.test(c)), wl.leave_span.filter((c) => /name|memo|updated_at/.test(c))], [[], [], []]);
  chk('  版本號不認得 → whitelist_version_mismatch', ask(w, { whitelist_version: 'w3' }), { ok: false, error: 'whitelist_version_mismatch' });
  chk('  沒帶版本號 → whitelist_version_mismatch', ask(w, { whitelist_version: undefined }), { ok: false, error: 'whitelist_version_mismatch' });
  chk('  版本號是物件原型上的名字（constructor）→ 不認', ask(w, { whitelist_version: 'constructor' }), { ok: false, error: 'whitelist_version_mismatch' });
}

console.log('══ 3) 唯讀 ══');
{
  for (const [lab, extra, mut] of [['w2 成功', {}], ['w1 成功', { whitelist_version: 'w1' }], ['空月份', { ym: '2026-09' }],
    ['選填分頁都不存在', {}, (s) => { ['leave_type', 'input', 'bonus', 'leave_span', 'xmap', 'item', 'config', 'holiday', 'hol_emp'].forEach((k) => delete s[PS.N[k]]); }],
    ['選舉假名單分頁不存在', {}, (s) => { delete s[PS.N.hol_emp]; }], ['選舉假名單只有表頭', {}, (s) => { s[PS.N.hol_emp].length = 1; }],
    ['run 分頁不存在（no_sheet）', {}, (s) => { delete s[PS.N.run]; }], ['壞月份', { ym: '2026-13' }], ['筆數超過', {}, (s) => { const t = s[PS.N.run]; for (let i = 0; i < 2001; i++) t.push(t[1].slice()); }]]) {
    const w = world(baseSheets({ mut }));
    const before = snapOf(w), sheetNames = Object.keys(w.sheets).join(',');
    const r = ask(w, extra);
    chk('  ' + lab + '（' + (r.ok ? 'ok' : r.error) + '）：分頁內容、指令碼屬性、觸發器清單前後相同', snapOf(w) === before, true);
    chk('  ' + lab + '：寫入類呼叫 0 次（建分頁／寫格子／取鎖／寫快取／寫屬性／觸發器）、分頁清單不變', [w.writes, Object.keys(w.sheets).join(',') === sheetNames], [[], true]);
  }
  /* 靜態檢查：匯出那一段程式（handler＋小工具）裡沒有任何寫入類、會建分頁、會重算的呼叫；呼叫到的外部函式只限唯讀的那幾支 */
  const start = GS.indexOf('薪資影子唯讀匯出 payroll_shadow_export（P4-1');
  const block = start >= 0 ? GS.slice(GS.indexOf('const PAY_SHADOW_FORMAT_', start)) : '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const BAD = /setValue|setValues|appendRow|insertSheet|deleteRow|clear\(|setFormula|setNumberFormat|paySheet\(|payRead\(|payReplace|payAppend|payWrite|PropertiesService|LockService|CacheService|ScriptApp|handlePayrollCalc|handlePayrollMonth|payCollect|payCalcOne|payInvalidate|UrlFetchApp|MailApp|GmailApp|DriveApp/;
  chk('  找得到匯出那一段程式', block.length > 1000, true);
  chk('  靜態：沒有寫入類／建分頁／重算／其他服務的呼叫', (code.match(BAD) || [null])[0], null);
  const own = new Set((code.match(/function\s+([A-Za-z_$][\w$]*)/g) || []).map((s) => s.replace(/function\s+/, '')));
  const KW = new Set(['if', 'for', 'while', 'function', 'return', 'catch', 'switch', 'typeof']);
  const BUILTIN = new Set(['String', 'Number', 'Object', 'Array', 'JSON', 'isFinite', 'Boolean', 'Date', 'isNaN']);
  const called = new Set();
  code.replace(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g, (m, id) => { if (!KW.has(id) && !BUILTIN.has(id) && !own.has(id)) called.add(id); return m; });
  chk('  靜態：呼叫到的外部函式只有這幾支唯讀的', [...called].sort(), ['checkAdmin', 'getSS', 'nowTaipeiIso', 'payNum', 'payTaipeiYmd_', 'todayTaipeiStr']);   // r2 起不再用整張讀的 readSheetAsObjects（擋項三）
}

console.log('══ 4) 月份、空月份、不存在的分頁 ══');
{
  const w = world(baseSheets());
  const ok = (r) => (r.ok ? 'ok' : r.error);
  chk('  本月 2026-11、往前 3 個月 2026-08 → 收', [ok(ask(w, { ym: '2026-11' })), ok(ask(w, { ym: '2026-08' }))], ['ok', 'ok']);
  chk('  2026-07（往前 4 個月）、2026-12（未來）→ bad_ym', [ok(ask(w, { ym: '2026-07' })), ok(ask(w, { ym: '2026-12' }))], ['bad_ym', 'bad_ym']);
  chk('  格式不對（2026-1、2026-13、2026-11-01、空白、沒帶）→ bad_ym',
    ['2026-1', '2026-13', '2026-11-01', '', undefined, ' 2026-11'].map((ym) => ok(ask(w, { ym }))), Array(6).fill('bad_ym'));
  const wy = world(baseSheets(), '2027-01-05');
  chk('  跨年：今天 2027-01-05 → 2026-10 收、2026-09 不收', [ok(ask(wy, { ym: '2026-10' })), ok(ask(wy, { ym: '2026-09' }))], ['ok', 'bad_ym']);
  const e = ask(w, { ym: '2026-09' });
  chk('  空月份 2026-09：ok、run／item／holiday／bonus 都是空陣列、counts 明寫 0、整張的表照回',
    [e.ok, e.tables.run, e.tables.item, e.tables.holiday, e.tables.bonus, e.counts.run, e.counts.item, e.counts.master, e.counts.store], [true, [], [], [], [], 0, 0, 3, 2]);
  const r = ask(w);
  chk('  2026-11：run／item／holiday／bonus 只回這個月', [r.tables.run.length, r.tables.item.length, r.tables.holiday.map((x) => x.ym), r.tables.bonus.length, r.tables.run.every((x) => x.ym === '2026-11')], [3, 9, ['2026-11'], 1, true]);
  chk('  手填工時只回 ym 往前 12 個月到 ym（主管 11/23 方案 b）：2026-10、2026-11（2025-01、2024-12、格式不對的不回）', r.tables.input.map((x) => x.ym).sort(), ['2026-10', '2026-11', '2026-11']);
  chk('  主檔、參數、門市、假別、留停、打卡對照整張回', [r.counts.master, r.counts.config, r.counts.store, r.counts.leave_type, r.counts.leave_span, r.counts.xmap], [3, 2, 2, 1, 5, 1]);
  for (const k of ['master', 'store', 'run']) {
    const wm = world(baseSheets({ mut: (s) => { delete s[PS.N[k]]; } }));
    const rm = ask(wm);
    chk('  ' + k + ' 分頁不存在 → no_sheet、不建分頁', [rm, wm.writes], [{ ok: false, error: 'no_sheet', table: k }, []]);
  }
  const wo = world(baseSheets({ mut: (s) => { delete s[PS.N.leave_type]; delete s[PS.N.item]; } }));
  const ro = ask(wo);
  chk('  選填分頁（leave_type、item）不存在 → 空陣列、不建分頁', [ro.ok, ro.tables.leave_type, ro.tables.item, wo.writes], [true, [], [], []]);
  /* 讀不到（開試算表或讀格子丟例外）→ read_failed，不回細節、不當成「沒有資料」 */
  const wt = world(baseSheets()); wt.sb.SpreadsheetApp.openById = () => { throw new Error('Service Spreadsheets timed out SECRET'); };
  chk('  開試算表丟例外 → read_failed（不回例外原文）', ask(wt), { ok: false, error: 'read_failed' });
  const wg = world(baseSheets()); const ss0 = wg.ss; let n = 0;
  wg.sb.SpreadsheetApp.openById = () => new Proxy({}, { get: (_, m) => (m === 'getSheetByName' ? (nm) => { if (++n === 4) throw new Error('SECRET'); return ss0.getSheetByName(nm); } : ss0[m]) });
  chk('  讀到一半丟例外 → read_failed（不回半套）', ask(wg), { ok: false, error: 'read_failed' });
}

console.log('══ 5) 一次回齊、不重不漏；超過上限不截斷 ══');
{
  /* 契約沒有分批：一次回整月（分批的話兩次請求中間有人存檔，拼起來就不是同一個時間點）。這裡用大量列證明整月一次回齊、不重不漏。 */
  const N = 1500;
  const w = world(baseSheets({ mut: (s) => { const t = s[PS.N.item]; const h = t[0]; for (let i = 0; i < N; i++) { const row = h.map(() => ''); row[h.indexOf('ym')] = '2026-11'; row[h.indexOf('emp_id')] = 'P' + i; row[h.indexOf('item_key')] = 'k' + i; row[h.indexOf('amount')] = i; t.push(row); } } }));
  const src = w.sheets[PS.N.item].slice(1).filter((x) => x[0] === '2026-11').map((x) => x[1] + '|' + x[3]);
  const r = ask(w);
  const got = r.tables.item.map((x) => x.emp_id + '|' + x.item_key);
  chk('  2026-11 item ' + src.length + ' 列：回應列數＝來源、counts 相同', [got.length, r.counts.item], [src.length, src.length]);
  chk('  不重：鍵全部不同', new Set(got).size, got.length);
  chk('  不漏、順序照分頁：逐列相同', JSON.stringify(got) === JSON.stringify(src), true);
  chk('  金額逐列相同（數字原樣）', r.tables.item.filter((x) => /^P/.test(x.emp_id)).every((x, i) => x.amount === i), true);
  /* 上限：剛好 2,000 列 run 過；2,001 列回 too_many_rows、沒有 tables（不截斷送出） */
  const mk = (n) => world(baseSheets({ mut: (s) => { const t = s[PS.N.run]; const h = t[0]; t.length = 1; for (let i = 0; i < n; i++) { const row = h.map(() => ''); row[0] = '2026-11'; row[1] = 'P' + i; t.push(row); } } }));
  const a = ask(mk(2000)), b = ask(mk(2001));
  chk('  run 剛好 2,000 列 → ok、2,000 列', [a.ok, a.counts && a.counts.run], [true, 2000]);
  chk('  run 2,001 列 → too_many_rows、不回 tables', b, { ok: false, error: 'too_many_rows', table: 'run', limit: 'rows' });
  chk('  上限照契約 4.2b：master／config／store／run 2,000、item 60,000', JSON.parse(w.F("JSON.stringify(['master','config','store','run','item'].map(function(k){return PAY_SHADOW_TABLES_[k].max;}))")), [2000, 2000, 2000, 2000, 60000]);
}

console.log('══ 6) 回應形狀與值 ══');
{
  const w = world(baseSheets());
  const r = ask(w);
  chk('  頂層鍵＝ok、format、whitelist_version、ym、generated_at、counts、flags、tables', Object.keys(r), ['ok', 'format', 'whitelist_version', 'ym', 'generated_at', 'counts', 'flags', 'tables']);
  chk('  generated_at 是台北時間 ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(r.generated_at), true);
  chk('  counts＝每張表的列數', Object.keys(r.tables).every((t) => r.counts[t] === r.tables[t].length), true);
  let bad = [];
  for (const t of Object.keys(r.tables)) r.tables[t].forEach((row) => Object.keys(row).forEach((k) => { const v = row[k]; if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) bad.push(t + '.' + k); }));
  chk('  值只有字串／數字／布林／null', bad, []);
  chk('  日期儲存格 → 台北 YYYY-MM-DD（到職日 Date 2023-07-02T16:00Z → 2023-07-03）', r.tables.master[0].hire_date, '2023-07-03');
  chk('  留停起日 Date 2026-01-31T16:00Z → 2026-02-01', r.tables.leave_span[0].start, '2026-02-01');
  chk('  布林、數字原樣（active true、base 34000、空白格＝空字串）', [r.tables.master[0].active, r.tables.master[0].base, r.tables.master[0].leave_date], [true, 34000, '']);
  /* 分頁表頭少一欄（舊表）→ 那一欄不放鍵（跟這邊讀到 undefined 一樣），其他照常 */
  const wl = world(baseSheets({ mut: (s) => { const t = s[PS.N.store]; const i = t[0].indexOf('support_group'); t.forEach((row) => row.splice(i, 1)); } }));
  const rl = ask(wl);
  chk('  門市分頁沒有 support_group 欄 → 每列不放這個鍵', [rl.ok, rl.tables.store.every((x) => !('support_group' in x)), Object.keys(rl.tables.store[0]).length], [true, true, 5]);
  /* mini 端 checkExport（8f8c017 的解析邏輯）吃得下 */
  const r1 = ask(w, { whitelist_version: 'w1' });
  chk('  mini 端 checkExport（w1，現在已合併的那版）→ ok、筆數對', miniCheckExport(r1, '2026-11', MINI_W1, 'w1'), { ok: true, counts: { master: 3, config: 2, holiday: 1, store: 2, run: 3, item: 9 } });
  chk('  同一套 checkExport 換成 w2 白名單 → ok（mini 端換 w2 只要改白名單常數）', miniCheckExport(r, '2026-11', W2(w), 'w2').ok, true);
  chk('  mini 端還是 w1 時收到 w2 回應 → 整月拒收（不會默默收下多的欄）', miniCheckExport(r, '2026-11', MINI_W1, 'w1').code, 'whitelist_version_mismatch');
  chk('  空月份 mini 端照收（run 0 筆）', miniCheckExport(ask(w, { ym: '2026-09', whitelist_version: 'w1' }), '2026-09', MINI_W1, 'w1').ok, true);
}

console.log('══ 7) 轉換：自訂加薪只留金額、留停子女換代號（算出來的結果不變） ══');
{
  const w = world(baseSheets());
  const r = ask(w);
  const inp = (emp, ym) => r.tables.input.find((x) => x.emp_id === emp && x.ym === ym) || {};   // 找不到＝空物件（讓下面逐條判紅，不在這裡丟例外）
  chk('  custom_add_more 只留金額（千分位照 payNum 轉、null 照留）', inp('E1', '2026-11').custom_add_more, '[{"amt":500},{"amt":1200},null]');
  const sumOf = (s) => { let a = []; try { a = JSON.parse(s); } catch (e) { return 'parse_error'; } if (!Array.isArray(a)) return 'not_array'; return a.reduce((t, x) => t + (x && w.F('payNum')(x.amt) ? w.F('payNum')(x.amt) : 0), 0); };
  const orig = w.sheets[PS.N.input][1][PS.S.input.indexOf('custom_add_more')];
  chk('  這邊的算法（x && payNum(x.amt)）算出的加薪合計跟原值一樣：1700', [sumOf(orig), sumOf(inp('E1', '2026-11').custom_add_more)], [1700, 1700]);
  chk('  原值解析不了 → 照樣解析不了（不帶原文）', [sumOf(inp('E2', '2026-11').custom_add_more), inp('E2', '2026-11').custom_add_more], ['parse_error', '!']);
  /* 2026-10 那列在請求 2026-11 時是「早期月份」、不出 custom_add_more（方案 b）→ 改請求 2026-10 來看 */
  const r10 = ask(w, { ym: '2026-10' }), inp10 = (emp) => r10.tables.input.find((x) => x.emp_id === emp && x.ym === '2026-10') || {};
  chk('  原值不是陣列 → 照樣不是陣列（請求 2026-10）', [sumOf(inp10('E2').custom_add_more), inp10('E2').custom_add_more], ['not_array', '{}']);
  const wb0 = world(baseSheets({ mut: (s) => { const t = s[PS.N.input]; t.forEach((r, i) => { if (i && r[0] === '2025-01') r[0] = '2026-09'; }); } }));
  chk('  空白照原樣（請求 2026-09）', (ask(wb0, { ym: '2026-09' }).tables.input.find((x) => x.ym === '2026-09') || {}).custom_add_more, '');
  chk('  support（跨店支援 JSON）逐欄挑（鍵照計算會讀的順序，值不變）', inp('E1', '2026-11').support, '[{"store":"測試店二","code":"CF","hours":4,"rate":200,"amount":"","auto":true}]');
  const sp = r.tables.leave_span;
  chk('  留停子女代號：同一人依原值排序 A→c1、B→c2（前後空白算同一個）、空白照空白、別人自己從 c1 起', sp.map((x) => x.emp_id + ':' + x.child), ['E1:c2', 'E1:c1', 'E1:c1', 'E1:', 'E2:c1']);
  /* 育嬰額度（payParentalUsage）用原值與代號各算一次：每個子女的用量一樣（名稱不同、數字相同） */
  const origSpans = w.sheets[PS.N.leave_span].slice(1).map((row) => { const o = {}; w.sheets[PS.N.leave_span][0].forEach((h, i) => { o[h] = row[i]; }); return o; });
  const use = (spans) => JSON.parse(JSON.stringify(w.F('payParentalUsage')('E1', spans, [], 8))).children.map((c) => [c.month_used, c.day_used, c.short_count]).sort();
  chk('  payParentalUsage：原值與代號算出每個子女的用量相同', use(sp), use(origSpans));
}

console.log('══ 7b) 選舉假名單 hol_emp（2026-11-23 主管同意：只出 ym、date、store、emp_id） ══');
{
  const ids = (rows) => rows.map((x) => x.ym + '|' + x.date + '|' + x.store + '|' + x.emp_id);
  const w = world(baseSheets());
  const r = ask(w);
  chk('  有名單：2026-11 回兩列（兩家店都回，總管理金鑰＝全部門市）、別月份 2026-10 那列不回', [r.ok, ids(r.tables.hol_emp), r.counts.hol_emp],
    [true, ['2026-11|2026-11-28|SSLGF|E1', '2026-11|2026-11-28|CF|E3'], 2]);
  chk('  每列的鍵逐字＝ym、date、store、emp_id', r.tables.hol_emp.map((x) => Object.keys(x)), [['ym', 'date', 'store', 'emp_id'], ['ym', 'date', 'store', 'emp_id']]);
  const js = JSON.stringify(r);
  chk('  name、note、updated_at 三欄一定不出現（鍵與值：選舉丁、SECRET-NOTE、SECRET-UPD）',
    [r.tables.hol_emp.some((x) => 'name' in x || 'note' in x || 'updated_at' in x), /選舉丁|SECRET-NOTE|SECRET-UPD/.test(js)], [false, false]);
  /* 分頁上多出別的欄（例如有人手加「身分證」）也不出 */
  const wx = world(baseSheets({ mut: (s) => { const t = s[PS.N.hol_emp]; t[0].push('id_no'); for (let i = 1; i < t.length; i++) t[i].push('X000000000'); } }));
  const rx = ask(wx);
  chk('  名單分頁多一個名單外的欄 → 不出現', [rx.ok, /id_no|X000000000/.test(JSON.stringify(rx.tables.hol_emp))], [true, false]);
  chk('  日期儲存格被轉成 Date（台北 2026-11-28 00:00）→ 回 2026-11-28', r.tables.hol_emp[1].date, '2026-11-28');
  const ro = ask(w, { ym: '2026-10' });
  chk('  要 2026-10 → 只回 2026-10 那列', ids(ro.tables.hol_emp), ['2026-10|2026-10-10|SSLGF|E2']);
  chk('  空月份 2026-09 → 空陣列、counts 0', [ask(w, { ym: '2026-09' }).tables.hol_emp, ask(w, { ym: '2026-09' }).counts.hol_emp], [[], 0]);
  const we = world(baseSheets({ mut: (s) => { s[PS.N.hol_emp].length = 1; } }));
  const re = ask(we);
  chk('  空名單（只有表頭）→ ok、空陣列、其他表照回、不寫', [re.ok, re.tables.hol_emp, re.counts.master, we.writes], [true, [], 3, []]);
  const wn = world(baseSheets({ mut: (s) => { delete s[PS.N.hol_emp]; } }));
  const rn = ask(wn);
  chk('  分頁不存在 → ok、空陣列（不是 no_sheet）、不建分頁、分頁清單不變',
    [rn.ok, rn.error, rn.tables && rn.tables.hol_emp, wn.writes, PS.N.hol_emp in wn.sheets], [true, undefined, [], [], false]);
  chk('  need＝false、month＝ym', JSON.parse(w.F('JSON.stringify(PAY_SHADOW_TABLES_.hol_emp)')), { month: 'ym', need: false, max: 5000 });
  chk('  w1 不回 hol_emp（mini 端現行版本不變）', 'hol_emp' in ask(w, { whitelist_version: 'w1' }).tables, false);
  /* 門市範圍：這支只限不限門市的總管理金鑰；帶範圍（含空範圍）一律擋，拿不到任何一家店的名單 */
  for (const [lab, sc] of [['空範圍 []', []], ['只有 SSLGF', ['SSLGF']], ['只有 CF', ['CF']]]) {
    const ws = world(baseSheets());
    const rs = ask(ws, { scope: sc });
    chk('  帶門市範圍 ' + lab + ' → scope_forbidden、沒有 tables、一張分頁都沒讀', [rs.error, 'tables' in rs, ws.reads], ['scope_forbidden', false, 0]);
  }
  /* 匯出的四欄足夠：用這邊的計算函式（payElecDates_）拿原列與匯出列各算一次，每家店、每個人、每個月結果相同 */
  /* 原列的 Date 要換成 vm 裡的 Date（payElecYmd_ 用 instanceof 判斷；測試檔與 vm 是兩個 realm，正式環境只有一個） */
  const vmDate = w.F('(function (t) { return new Date(t); })');
  const rawOf = (ws) => { const t = ws.sheets[PS.N.hol_emp]; return t.slice(1).map((row) => { const o = {}; t[0].forEach((h, i) => { o[h] = row[i] instanceof Date ? vmDate(row[i].getTime()) : row[i]; }); return o; }); };
  const elec = (rows, ym, st, id) => JSON.parse(JSON.stringify(w.F('payElecDates_')(rows, ym, st, id)));
  const exp = { '2026-11': r.tables.hol_emp, '2026-10': ro.tables.hol_emp };
  const diff = [];
  for (const ym of ['2026-11', '2026-10']) for (const st of ['SSLGF', 'CF']) for (const id of ['E1', 'E2', 'E3']) {
    const a = elec(rawOf(w), ym, st, id), b = elec(exp[ym], ym, st, id);
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(ym + st + id);
  }
  chk('  payElecDates_：原列 vs 匯出列 2 個月 × 2 店 × 3 人結果相同', diff, []);
  chk('  前提：有人真的被算到選舉日（E1@SSLGF、E3@CF 11/28；E2@SSLGF 10/10）',
    [elec(r.tables.hol_emp, '2026-11', 'SSLGF', 'E1'), elec(r.tables.hol_emp, '2026-11', 'CF', 'E3'), elec(ro.tables.hol_emp, '2026-10', 'SSLGF', 'E2'), elec(r.tables.hol_emp, '2026-11', 'SSLGF', 'E3')],
    [['2026-11-28'], ['2026-11-28'], ['2026-10-10'], []]);
  chk('  mini 端 checkExport（w2 白名單）吃得下含 hol_emp 的回應', miniCheckExport(r, '2026-11', W2(w), 'w2').ok, true);
}

console.log('══ 8) 草稿過期也不重算、不寫回（對照組 payroll_month 會） ══');
{
  /* 借 election-day-emp.test.js 的 world()（真的 handlePayrollCalc 算出草稿），選舉假名單改過＝草稿過期：payroll_month 會自動重算寫回。
     匯出只讀格子：回的就是那份過期草稿，寫入 0 次、假資料庫前後逐字相同。 */
  const T = fs.readFileSync(path.join(__dirname, 'election-day-emp.test.js'), 'utf8');
  const cut = T.indexOf('const BASE_REF');
  const mod = { exports: {} };
  new Function('require', 'module', '__dirname', T.slice(0, cut).replace("'use strict';", '') + '\nmodule.exports = { world };')(require, mod, __dirname);
  const ew = mod.exports.world;
  const fake = (w) => {
    const names = JSON.parse(vm.runInContext('JSON.stringify(PAY_SHEET_NAME)', w.sb)), heads = JSON.parse(vm.runInContext('JSON.stringify(PAY_SHEETS)', w.sb));
    const kindOf = (nm) => Object.keys(names).find((k) => names[k] === nm);
    const c = { insert: 0, mut: 0 };
    const this_vals = (k) => { const cols = heads[k].slice(); (w.DB[k] || []).forEach((r) => Object.keys(r).forEach((x) => { if (cols.indexOf(x) < 0) cols.push(x); }));
      return [cols].concat((w.DB[k] || []).map((r) => cols.map((x) => (r[x] === undefined || r[x] === null ? '' : r[x])))); };
    w.sb.SpreadsheetApp.openById = () => ({
      getSheetByName: (nm) => { const k = kindOf(nm); if (!k || !(k in w.DB)) return null;
        return { getDataRange: () => ({ getValues: () => { const cols = heads[k].slice(); (w.DB[k] || []).forEach((r) => Object.keys(r).forEach((x) => { if (cols.indexOf(x) < 0) cols.push(x); }));
          return [cols].concat((w.DB[k] || []).map((r) => cols.map((x) => (r[x] === undefined || r[x] === null ? '' : r[x])))); } }),
          /* getRange 本身不算寫入（r2 起匯出用 getRange(...).getValues() 有上限地讀）；setValues／setNumberFormat 才算 */
          getRange: (r0, c0, nr, nc) => ({ getValues: () => { const all = this_vals(k); const o = []; for (let i = 0; i < (nr || 1); i++) { const src = all[r0 - 1 + i] || []; const row = []; for (let j = 0; j < (nc || 1); j++) row.push(src[c0 - 1 + j] === undefined ? '' : src[c0 - 1 + j]); o.push(row); } return o; },
            setValues() { c.mut++; }, setNumberFormat() { c.mut++; } }),
          getLastRow: () => this_vals(k).length, getLastColumn: () => this_vals(k)[0].length,
          getSheetId: () => 1, getName: () => nm, setFrozenRows() { c.mut++; }, getMaxRows: () => 1000 }; },
      insertSheet: () => { c.insert++; return null; },
    });
    vm.runInContext(`(function(){ const R = payReplaceAll, A = payAppend, M = handlePayrollCalc;
      globalThis.__W = { write: 0, calc: 0 };
      payReplaceAll = function(k, rows){ globalThis.__W.write++; return R(k, rows); };
      payAppend = function(k, rows){ globalThis.__W.write++; return A(k, rows); };
      handlePayrollCalc = function(b){ globalThis.__W.calc++; return M(b); };
      checkAdmin = function(b){ return !!b && (b.admin_key === 'good' || b.admin_key === 'x'); };
      todayTaipeiStr = function(){ return '2026-11-30'; }; })();`, w.sb);
    return c;
  };
  const mk = () => { const w = ew({ elec: ['a'] }); w.calc(); w.DB.hol_emp.push(Object.assign({}, w.DB.hol_emp[0], { emp_id: 'E2', name: '乙君' })); return w; };
  const w = mk(); const c = fake(w);
  const before = JSON.stringify(w.DB);
  const draft = w.DB.run.map((x) => x.emp_id + ':' + x.net + ':' + x.gross);
  const H = (act) => vm.runInContext('PAYROLL_HANDLERS', w.sb)[act];
  const r = H('payroll_shadow_export')({ action: 'payroll_shadow_export', admin_key: 'good', ym: '2026-11', whitelist_version: 'w2' });
  chk('  前提：草稿確實過期（payroll_status 回 elec_stale true）', H('payroll_status')({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' }).elec_stale, true);
  chk('  匯出 ok、回的就是那份過期草稿（逐人 net／gross 相同）', [r.ok, r.ok && r.tables.run.map((x) => x.emp_id + ':' + x.net + ':' + x.gross)], [true, draft]);
  chk('  寫表 0 次、重算 0 次、建分頁 0 次、寫格子 0 次', [w.sb.__W.write, w.sb.__W.calc, c.insert, c.mut], [0, 0, 0, 0]);
  chk('  假資料庫前後逐字相同', JSON.stringify(w.DB) === before, true);
  const wm = mk(); fake(wm); const bm = JSON.stringify(wm.DB);
  vm.runInContext('PAYROLL_HANDLERS', wm.sb).payroll_month({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' });
  chk('  對照組：同情境 payroll_month 會重算（重算 ≥1、寫表 ≥1、資料庫有變）', [wm.sb.__W.calc >= 1, wm.sb.__W.write >= 1, JSON.stringify(wm.DB) !== bm], [true, true, true]);
}

console.log('══ 9) Codex 217 r1 修正：支援內層逐欄挑、參數鍵白名單、run 帶 status／run_at、讀取有上限 ══');
{
  const col = (k, c) => PS.S[k].indexOf(c);
  /* ── 擋項二：support 內層物件逐欄挑 ── */
  const supRows = (s) => { const t = s[PS.N.input];
    const add = (ym, emp, sup) => { const r = PS.S.input.map(() => ''); r[col('input', 'ym')] = ym; r[col('input', 'emp_id')] = emp; r[col('input', 'store')] = 'SSLGF'; r[col('input', 'support')] = sup; t.push(r); };
    add('2026-11', 'S1', '[{"hours":1,"phone":"TEST-PHONE","store":"測試店二","rate":180,"memo":"SECRET-MEMO","nested":{"a":"SECRET-N"},"keep":"true","auto_h":2,"cross":true,"amount":[9]}]');
    add('2026-11', 'S2', 'SECRET-PHONE{壞掉');
    add('2026-11', 'S3', '{"phone":"SECRET-PHONE"}');
    add('2026-11', 'S4', '[1,"SECRET-PHONE",null,[2]]');
    add('2026-11', 'S5', '');
  };
  const ws = world(baseSheets({ mut: supRows }));
  const rs = ask(ws);
  const sup = (emp) => (rs.tables.input.find((x) => x.emp_id === emp) || {}).support;
  chk('  support 內層只留計算會讀的鍵（store、code、hours、rate、amount、auto、keep、auto_h、cross）；電話、memo、巢狀值不出',
    JSON.parse(sup('S1')), [{ store: '測試店二', hours: 1, rate: 180, keep: 'true', auto_h: 2, cross: true }]);
  chk('  回應裡沒有 TEST-PHONE／SECRET-PHONE／SECRET-MEMO／SECRET-N', /TEST-PHONE|SECRET-PHONE|SECRET-MEMO|SECRET-N/.test(JSON.stringify(rs)), false);
  chk('  解析不了 → \'!\'、不是陣列 → \'{}\'、元素不是物件 → null、空白照原樣', [sup('S2'), sup('S3'), sup('S4'), sup('S5')], ['!', '{}', '[null,null,null,null]', '']);
  chk('  flags.input_support_bad＝2（S2、S3）', (rs.flags || {}).input_support_bad, 2);
  chk('  解析不了／不是陣列，計算端照樣是 support_error（JSON.parse 丟例外／不是陣列）',
    [(() => { try { JSON.parse('!'); return 'parsed'; } catch (e) { return 'error'; } })(), Array.isArray(JSON.parse('{}'))], ['error', false]);
  /* 掃一遍：所有匯出的字串值裡「看起來像 JSON」（[ 或 { 開頭）的只會出現在 input.support、input.custom_add_more */
  const jsonish = [];
  for (const t of Object.keys(rs.tables)) rs.tables[t].forEach((row) => Object.keys(row).forEach((k) => { const v = row[k]; if (typeof v === 'string' && /^\s*[\[{]/.test(v)) jsonish.push(t + '.' + k); }));
  chk('  像 JSON 的值只出現在 input.support、input.custom_add_more', [...new Set(jsonish)].sort(), ['input.custom_add_more', 'input.support']);
  chk('  計算端讀 support 內層的鍵都在挑選清單裡（paySupportStrip_ 存檔白名單＋auto、cross）',
    ['store', 'code', 'hours', 'rate', 'amount', 'auto', 'keep', 'auto_h', 'cross'].every((k) => JSON.parse(ws.F("typeof PAY_SHADOW_SUPPORT_KEYS_ === 'undefined' ? '[]' : JSON.stringify(PAY_SHADOW_SUPPORT_KEYS_)")).indexOf(k) >= 0)
      && /const o = \{ store: s\.store == null \? '' : s\.store, hours: s\.hours, rate: s\.rate, amount: s\.amount == null \? '' : s\.amount \};/.test(GS), true);

  /* ── 參數鍵白名單 ── */
  const wc = world(baseSheets({ mut: (s) => { const t = s[PS.N.config];
    t.push(['svc_token', 'SECRET-TOKEN', '', '']); t.push(['ot_meal_fixed', 120, 'SECRET-NOTE', 'CF']); t.push([' daily_hours', 9, '', '']); } }));
  const rc = ask(wc), rc1 = ask(wc, { whitelist_version: 'w1' });
  chk('  參數只出計算會讀的鍵（daily_hours、late_deduct、ot_meal_fixed）；未知鍵與前後多空白的鍵不出', rc.tables.config.map((x) => x.key), ['daily_hours', 'late_deduct', 'ot_meal_fixed']);
  chk('  w1 一樣篩、flags.config_keys_dropped＝2、回應沒有 SECRET-TOKEN', [rc1.tables.config.map((x) => x.key), (rc.flags || {}).config_keys_dropped, /SECRET-TOKEN/.test(JSON.stringify(rc) + JSON.stringify(rc1))],
    [['daily_hours', 'late_deduct', 'ot_meal_fixed'], 2, false]);
  /* 計算端用到的參數鍵（cfg.X、(cfg || {}).X、payCfgNum／payCfgPos_(cfg, 'X')）全部在白名單裡 */
  const used = new Set();
  GS.replace(/\(cfg \|\| \{\}\)\.([a-z][a-z_0-9]+)|\b[a-zA-Z]*[cC]fg[A-Za-z]*\.([a-z][a-z_0-9]+)|payCfg[A-Za-z_]*\([^,()]+, *'([a-z_0-9]+)'/g, (m, a, b, c) => { used.add(a || b || c); return m; });
  const allow = JSON.parse(wc.F("typeof PAY_SHADOW_CONFIG_KEYS_ === 'undefined' ? '{}' : JSON.stringify(PAY_SHADOW_CONFIG_KEYS_)"));
  chk('  計算端讀的參數鍵都在 PAY_SHADOW_CONFIG_KEYS_（' + used.size + ' 個）', [...used].filter((k) => !allow[k]), []);

  /* ── run 帶 status、run_at（w2）；w1 不變 ── */
  const wr = world(baseSheets({ mut: (s) => { s[PS.N.run][1][col('run', 'run_at')] = D('2026-11-20T22:10:05Z'); } }));
  const rr = ask(wr), rr1 = ask(wr, { whitelist_version: 'w1' });
  chk('  w2 run 有 status、run_at；日期時間儲存格轉台北 ISO（不只留日期）', [rr.tables && rr.tables.run[0].status, rr.tables.run[0].run_at, rr.tables.run[1].run_at], ['draft', '2026-11-21T06:10:05+08:00', '2026-11-21T06:10:00+08:00']);
  chk('  w1 run 沒有 status、run_at（跟 mini 目前的 w1 相同）', ['status', 'run_at'].filter((k) => k in rr1.tables.run[0]), []);
  chk('  w2 回應 mini 的檢查邏輯吃得下（拿 PAY_SHADOW_W2_ 當 mini 的 w2）', miniCheckExport(rr, '2026-11', W2(wr), 'w2').ok, true);

  /* ── 擋項三：讀取有上限 ── */
  const big = (k, n, ymv) => (s) => { const t = s[k]; const proto = t[1].slice(); for (let i = 0; i < n; i++) { const r = proto.slice(); if (ymv) r[t[0].indexOf('ym')] = typeof ymv === 'function' ? ymv(i) : ymv; t.push(r); } };
  const wm = world(baseSheets({ mut: big(PS.N.master, 2000) }));
  const rm = ask(wm);
  chk('  主檔 2,001 列 → too_many_rows（limit rows）、一格都沒取值、只查了 1 張分頁（後面 11 張不查）', [rm, wm.cells, wm.reads], [{ ok: false, error: 'too_many_rows', table: 'master', limit: 'rows' }, 0, 1]);
  const wk = world(baseSheets({ mut: (s) => { const t = s[PS.N.master]; for (let i = t[0].length; i < 61; i++) t.forEach((r, j) => r.push(j ? 'x' : 'pad' + i)); } }));
  chk('  主檔 61 欄 → too_many_rows（limit cols）、一格都沒取值', [ask(wk), wk.cells], [{ ok: false, error: 'too_many_rows', table: 'master', limit: 'cols' }, 0]);
  const wi = world(baseSheets({ mut: (s) => { const t = s[PS.N.input]; const r = t[0].map(() => ''); r[t[0].indexOf('ym')] = '2020-01'; for (let i = 0; i < 200001; i++) t.push(r); } }));
  chk('  手填工時 20 萬零 5 列（第 8 張表）→ too_many_rows、全部 12 張一格都沒取值', [ask(wi), wi.cells], [{ ok: false, error: 'too_many_rows', table: 'input', limit: 'rows' }, 0]);
  const wb = world(baseSheets({ mut: big(PS.N.bonus, 20000, '2026-11') }));
  const rb = ask(wb);
  chk('  獎金這個月 20,001 列 → too_many_rows；只取了獎金的表頭與月份欄、後面的表（留停、打卡對照、選舉假）一格都沒讀',
    [rb, wb.gets.filter((g) => g.startsWith(PS.N.bonus)).length, wb.gets.some((g) => /payroll_leave_span|payroll_xmap|payroll_hol_emp/.test(g))], [{ ok: false, error: 'too_many_rows', table: 'bonus', limit: 'rows' }, 2, false]);
  /* 月份篩選縮小取值範圍：item 前面塞 30,000 列舊月份，這個月的 9 列在最後 → 只取表頭＋月份欄＋最後 9 列的欄段 */
  const wo = world(baseSheets({ mut: (s) => { const t = s[PS.N.item]; const cur = t.slice(1).filter((r) => r[t[0].indexOf('ym')] === '2026-11'); const old = t.slice(1).filter((r) => r[t[0].indexOf('ym')] !== '2026-11');
    t.length = 1; for (let i = 0; i < 30000; i++) t.push(old[i % old.length].slice()); cur.forEach((r) => t.push(r)); } }));
  const ro = ask(wo), ig = wo.gets.filter((g) => g.startsWith(PS.N.item + '@'));
  const itemCells = ig.reduce((a, g) => { const b = g.split('@')[1].split(',').map(Number); return a + b[2] * b[3]; }, 0);
  chk('  item 3 萬列舊月份＋9 列本月 → 回 9 列；item 取值＝表頭 1 列＋月份欄 30,009 格＋9 列（格數遠小於整張）',
    [ro.ok && ro.counts.item, ig.length, ig[2] && ig[2].split('@')[1].split(',').slice(0, 1)[0] === '30002', itemCells < 30009 + 200, itemCells < 30010 * PS.S.item.length / 2], [9, 3, true, true, true]);
  /* 累計格數預算：手填工時 12 萬列、第一列與最後一列是本月、中間都是舊月份 → 列段 12 萬列 × 欄段 > 300 萬格 → 不取那一段就停 */
  const wg = world(baseSheets({ mut: (s) => { const t = s[PS.N.input]; const blank = t[0].map(() => ''); const yi = t[0].indexOf('ym');
    const a = blank.slice(); a[yi] = '2026-11'; const o = blank.slice(); o[yi] = '2020-01'; t.length = 1; t.push(a); for (let i = 0; i < 120000; i++) t.push(o); t.push(a.slice()); } }));
  const rg = ask(wg);
  chk('  列段超過累計 300 萬格 → too_many_rows（limit cells）、那一段沒取值（取值總格數 < 20 萬）', [rg, wg.cells < 200000], [{ ok: false, error: 'too_many_rows', table: 'input', limit: 'cells' }, true]);
  chk('  靜態：匯出那段不再呼叫 readSheetAsObjects／getDataRange（整張讀）', /readSheetAsObjects\(|getDataRange\(/.test(GS.slice(GS.indexOf('function handlePayrollShadowExport'), GS.indexOf('function payShadowYmOk_'))), false);

  /* ── 不改的兩點（附反證）：year2 收 '2026-00'、Date 型 ym 照原值輸出——都跟計算端同一套判斷 ── */
  /* 主管 11/23 方案 b 之後：匯出改用嚴格月份（01–12），跟計算端（只驗兩位數）刻意不同——差異寫在 PAY_SHADOW_INPUT_BACK_ 的註解 */
  chk('  計算端月份判斷仍只驗兩位數；匯出 win13 改嚴格 01–12（刻意不同，註解有寫）', [GS.indexOf("!/^\\d{4}-\\d{2}$/.test(m) || m.slice(0, 4) !== year || m >= ym") >= 0, GS.indexOf("if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(m)) return false;") >= 0], [true, true]);
}

console.log('══ 10) 手填工時範圍（主管 11/23 方案 b）：13 個月、早期月份不出金額、裁切後照樣算得一樣 ══');
{
  const IN = PS.S.input;
  const EARLY = ['ym', 'emp_id', 'store', 'hours_manual', 'personal_h', 'sick_h', 'menstrual_h', 'disaster_h', 'annual_h'];   // r3：support 不出（9 欄）
  const AMT = ['wage_override', 'dorm_override', 'custom_add_amt', 'custom_ded_amt', 'custom_add_more', 'extra_ot', 'hours', 'deduct_days', 'full_attend', 'work_days', 'meal_on', 'holiday_h'];
  const mkIn = (rows) => (s) => { s[PS.N.input] = tab('input', rows); };
  const full = (ym, emp, extra) => Object.assign({ ym, emp_id: emp, store: 'SSLGF', hours: 160, extra_ot: 3, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 0,
    holiday_h: 0, deduct_days: 0, full_attend: 1, work_days: 22, wage_override: 210, dorm_override: 1500, meal_on: 1, custom_add_label: 'SECRET-LABEL', custom_add_amt: 777,
    custom_ded_label: 'SECRET-LABEL', custom_ded_amt: 333, hours_manual: '1', custom_add_more: '[{"label":"SECRET-LABEL","amt":99}]',
    support: '[{"store":"測試店二","hours":2,"rate":200,"phone":"SECRET-PHONE"}]', updated_at: 'SECRET-UPDATED' }, extra || {});
  const months = []; for (let y = 2024; y <= 2027; y++) for (let m = 1; m <= 12; m++) months.push(y + '-' + String(m).padStart(2, '0'));
  const inRange = (lo, hi) => months.filter((m) => !(m < lo) && !(m > hi));
  const rows = inRange('2025-06', '2026-12').map((m) => full(m, 'E1')).concat([full('2026-00', 'E1'), full('2026-13', 'E1'), full(' 2026-05 ', 'E1')]);
  const w = world(baseSheets({ mut: mkIn(rows) }));
  const r = ask(w);
  const got = r.tables.input.map((x) => x.ym);
  const clean = got.filter((m) => m.trim() === m).sort();
  chk('  請求 2026-11 → 只回 2025-11～2026-11（13 個月，含剛好 12 個月前的 2025-11）', [clean[0], clean.slice(-1)[0], clean.length, got.length], ['2025-11', '2026-11', 13, 13]);
  chk('  2025-10 以前、2026-12（請求月之後）、2026-00、2026-13 都不出；前後空白的 " 2026-05 "（計算端逐字比、本來就不算）也不出、計入 flags.rows_ym_nonstandard',
    [clean.some((m) => !(m > '2025-10')), got.indexOf('2026-12') >= 0, got.indexOf('2026-00') >= 0, got.indexOf('2026-13') >= 0, got.some((m) => /\s/.test(m)), (r.flags || {}).rows_ym_nonstandard], [false, false, false, false, false, 1]);
  const cur = r.tables.input.find((x) => x.ym === '2026-11'), old = r.tables.input.filter((x) => x.ym.trim() !== '2026-11');
  chk('  請求月那一列照 w2 全出（含金額欄）', [Object.keys(cur).sort().join(), cur.custom_add_amt, cur.wage_override, cur.custom_add_more], [W2(w).input.filter((c) => IN.indexOf(c) >= 0).sort().join(), 777, 210, '[{"amt":99}]']);
  chk('  早期月份的列只有：工號、門市、月份、hours_manual、五個假別時數（9 欄，沒有 support）', [...new Set(old.map((x) => Object.keys(x).sort().join()))], [EARLY.slice().sort().join()]);
  chk('  早期月份沒有任何金額類欄（加扣金額、覆寫金額、自訂加薪…）', old.some((x) => AMT.some((c) => c in x)), false);
  chk('  早期月份沒有 support；整列序列化後不含 rate、amount、加扣金額、覆寫金額類鍵名；回應沒有 SECRET-PHONE',
    [old.some((x) => 'support' in x), old.some((x) => /rate|amount|amt|_override|custom_|extra_ot/.test(JSON.stringify(x))), /SECRET-PHONE/.test(JSON.stringify(r))], [false, false, false]);
  const wy = world(baseSheets({ mut: mkIn(inRange('2025-10', '2027-02').map((m) => full(m, 'E1'))) }), '2027-01-05');
  const gy = ask(wy, { ym: '2027-01' }).tables.input.map((x) => x.ym).sort();
  chk('  跨年：請求 2027-01 → 2026-01～2027-01（2025-12 不出、2027-02 不出）', [gy[0], gy.slice(-1)[0], gy.length], ['2026-01', '2027-01', 13]);
  const r10 = ask(w, { ym: '2026-10' }), g10 = r10.tables.input.map((x) => x.ym).filter((m) => m.trim() === m).sort();
  const after = r10.tables.input.find((x) => x.ym === '2026-11') || {};
  chk('  請求 2026-10、本月 2026-11 → 2025-10～2026-11（請求月之後到本月也出），2026-12（預先填的）不出', [g10[0], g10.slice(-1)[0], g10.indexOf('2026-12') >= 0], ['2025-10', '2026-11', false]);
  chk('  請求 2026-10：非請求月的列（含之後的 2026-11）序列化後不含 rate、amount、support',
    [r10.tables.input.filter((x) => x.ym !== '2026-10').some((x) => /rate|amount|support/.test(JSON.stringify(x)))], [false]);
  chk('  請求月之後（2026-11）的列只有那 9 欄、沒有金額；請求月 2026-10 那列照 w2 全出',
    [Object.keys(after).sort().join(), AMT.some((c) => c in after), (r10.tables.input.find((x) => x.ym === '2026-10') || {}).custom_add_amt], [EARLY.slice().sort().join(), false, 777]);
  chk('  請求 2026-11（＝本月）→ 沒有之後的列', clean.filter((m) => m > '2026-11'), []);
  const gy12 = ask(wy, { ym: '2026-12' }).tables.input, gy12m = gy12.map((x) => x.ym).sort();
  chk('  跨年：本月 2027-01、請求 2026-12 → 2025-12～2027-01；2027-01 那列只有 9 欄；2027-02 不出',
    [gy12m[0], gy12m.slice(-1)[0], gy12m.length, Object.keys(gy12.find((x) => x.ym === '2027-01') || {}).sort().join()], ['2025-12', '2027-01', 14, EARLY.slice().sort().join()]);

  /* ── 夠不夠算：同一份資料，「完整手填表」與「只給匯出內容」跑請求月的 payLeaveUsedBefore（曆年上限）與 payAnnualInfo（週年制特休），結果要一樣 ── */
  const P = [
    ['A1', '年初到職', '2025-01-02', ''],
    ['B2', '年中到職', '2023-06-20', ''],
    ['C3', '跨年週年期、本月屆滿折算（settle 期從 ym−12 月中開始）', '2020-11-15', ''],
    ['D4', '當年已請滿病假、事假上限', '2019-03-10', ''],
    ['F5', '離職當月、週年日還沒到（改用上一期，從 ym−12 開始）', '2021-11-20', '2026-11-10'],
    ['G6', '週年日是 1 號（期別剛好整月切）', '2022-12-01', ''],
    ['H7', '10 月屆滿折算（回頭重算 2026-10 時要用到 11 月的 annual_h）', '2019-10-20', ''],
    ['J8', '9 月屆滿折算（回頭重算 2026-09）', '2018-09-25', ''],
  ];
  const engine = (sheets, ym, today) => {
    const x = world(sheets, today);
    vm.runInContext('payClockRead = function () { return []; }; payLeaveDupNames_ = function () { return {}; };', x.sb);
    const master = JSON.parse(vm.runInContext("JSON.stringify(payRead('master').filter(function (m) { return payStore(m.store) === 'SSLGF'; }))", x.sb));
    const LT = [{ code: 'sick', cap_days: 30, cap_basis: 'calendar' }, { code: 'personal', cap_days: 14, cap_basis: 'calendar' },
      { code: 'menstrual', cap_days: 3, cap_basis: 'calendar', merge_into: 'sick' }, { code: 'disaster', cap_days: 5, cap_basis: 'calendar' }];
    const cfg = x.F('payConfig')('SSLGF');
    return JSON.stringify({ used: x.F('payLeaveUsedBefore')(ym, 'SSLGF', LT, cfg, master), annual: x.F('payAnnualInfo')(ym, 'SSLGF') });
  };
  const peopleSheets = (inputRows) => baseSheets({ mut: (s) => {
    s[PS.N.master] = tab('master', P.map(([id, nm, hire, left]) => ({ emp_id: id, name: '人' + id, is_full_time: 'true', base: 34000, hire_date: hire, leave_date: left, active: true, store: 'SSLGF', labor_ins: 700 })));
    s[PS.N.input] = tab('input', inputRows);
  } });
  const hrs = (m, i) => { const k = (Number(m.slice(5, 7)) * 7 + i * 3) % 11; return { annual_h: k % 3 ? 8 : 4, sick_h: k * 2, personal_h: k % 4 ? 8 : 0, menstrual_h: k % 2 ? 8 : 0, disaster_h: k === 5 ? 8 : 0 }; };
  const allRows = [];
  inRange('2024-01', '2027-01').forEach((m) => P.forEach(([id], i) => {
    const h = hrs(m, i);
    if (id === 'D4' && m.slice(0, 4) === '2026') { h.sick_h = 80; h.personal_h = 24; }   // 2026 年每月病假 10 天、事假 3 天 → 早就超過上限
    allRows.push(full(m, id, h));
  }));
  for (const [ym, today] of [['2026-11', '2026-11-22'], ['2026-10', '2026-11-22'], ['2026-09', '2026-11-22'], ['2027-01', '2027-01-05']]) {
    const fullSheets = peopleSheets(allRows.filter((x) => !(x.ym > today.slice(0, 7))));   // 正式表不會有「今天以後」的月份
    const exp = world(fullSheets, today).post({ action: 'payroll_shadow_export', admin_key: ADMIN, ym, whitelist_version: 'w2' });
    const cut = peopleSheets((exp.tables || {}).input || []);   // mini 拿到的＝匯出內容（含請求月之後到本月、只有 10 欄的列）
    const a = engine(fullSheets, ym, today), b = engine(cut, ym, today);
    const A = JSON.parse(a);
    chk('  ' + ym + (ym === today.slice(0, 7) ? '（本月）' : '（過去月份；完整表裡本月已有 annual_h）') + '：完整手填表 vs 只給匯出內容 → 曆年上限已用、週年制特休（額度、已用、剩餘、折算）逐人相同（8 種人）', a === b, true);
    if (ym !== today.slice(0, 7)) {
      /* 反證：拿掉請求月之後到本月的列（8571a64 的做法）→ 週年制特休已用／剩餘不同，所以這幾列是必要的；而且只差在 annual 那邊 */
      const noAfter = peopleSheets(((exp.tables || {}).input || []).filter((x) => !(x.ym > ym)));
      const B = JSON.parse(engine(noAfter, ym, today)), diff = [];
      Object.keys(A.used).forEach((k) => { if (JSON.stringify(A.used[k]) !== JSON.stringify(B.used[k])) diff.push('used.' + k); });
      Object.keys(A.annual).forEach((k) => { if (JSON.stringify(A.annual[k]) !== JSON.stringify(B.annual[k])) diff.push('annual.' + k); });
      chk('    反證：不給請求月之後的列 → 週年制特休不同、曆年上限相同', [diff.length > 0, diff.every((d) => /^annual\./.test(d))], [true, true]);
      const settler = ym === '2026-10' ? 'H7' : 'J8';
      chk('    前提：' + settler + ' 在 ' + ym + ' 屆滿折算（payout_h 有值）', !!A.annual[settler] && A.annual[settler].payout_h !== undefined, true);
    }
    if (ym === '2026-11') {
      chk('    前提：C3 本月屆滿折算、F5 離職改用上一期、D4 病假早已超過上限、A1 年初到職有特休',
        [!!A.annual.C3 && A.annual.C3.payout_h !== undefined, A.annual.F5 && A.annual.F5.ps, A.used.D4.sick.used_before_days > 30, !!A.annual.A1 && A.annual.A1.days > 0], [true, '2025-11-20', true, true]);
      /* 反證：只給 12 個月（不含 2025-11）就算不一樣 → 13 個月是必要的 */
      const cut12 = peopleSheets(((exp.tables || {}).input || []).filter((x) => !(x.ym > ym) && !(x.ym < '2025-12')));
      chk('    反證：少給剛好 12 個月前的 2025-11 → 週年制結果不同（C3 或 F5）', engine(cut12, ym, today) !== a, true);
    }
  }
}

console.log('══ 11) Codex 217 r2 修正：讀取中月份被改、必要表頭、月份正規化、非請求月不帶金額全面掃描 ══');
{
  const col = (k, c) => PS.S[k].indexOf(c);
  /* ── 新擋項一：月份欄篩過之後、第二次讀列段前那一格被改掉 ── */
  const wc = world(baseSheets());
  let n = 0;
  wc.beforeGet = (name, b) => {
    if (b[3] === 1 || b[0] === 1) return;   // 表頭、月份欄那兩次不動；第二次讀列段前才改
    const t = wc.sheets[name];
    if (name === PS.N.input) t.forEach((r, i) => { if (i && r[col('input', 'emp_id')] === 'E2' && r[col('input', 'ym')] === '2026-10') { r[col('input', 'ym')] = '2026-12'; n++; } });
    if (name === PS.N.run) t.forEach((r, i) => { if (i && r[col('run', 'emp_id')] === 'E1' && r[col('run', 'ym')] === '2026-11') { r[col('run', 'ym')] = '2026-10'; n++; } });
    if (name === PS.N.bonus) t.forEach((r, i) => { if (i && r[col('bonus', 'ym')] === '2026-11') { r[col('bonus', 'ym')] = '2024-01'; n++; } });
  };
  const rc = ask(wc);
  chk('  第二次讀到的月份已不在範圍（input 改成 2026-12、run 改成 2026-10、bonus 改成 2024-01）→ 那幾列不出、flags.rows_changed_during_read＝3',
    [n, rc.ok, rc.tables.input.some((x) => x.ym === '2026-12' || x.emp_id === 'E2' && x.ym === '2026-10'), rc.tables.run.some((x) => x.emp_id === 'E1'), rc.tables.bonus.length, (rc.flags || {}).rows_changed_during_read],
    [3, true, false, false, 0, 3]);
  /* 範圍內換月份（請求 2026-10 時 2026-10 那列被改成 2026-11）→ 照實際讀到的月份出、而且變成非請求月 9 欄 */
  const wd = world(baseSheets());
  wd.beforeGet = (name, b) => { if (name !== PS.N.input || b[3] === 1 || b[0] === 1) return; wd.sheets[name].forEach((r, i) => { if (i && r[col('input', 'ym')] === '2026-10') r[col('input', 'ym')] = '2026-11'; }); };
  const rd = ask(wd, { ym: '2026-10' });
  const e2 = rd.tables.input.filter((x) => x.emp_id === 'E2');
  chk('  範圍內換月份 → 照實際讀到的 2026-11 出、欄位依它不是請求月只出 9 欄（沒有 custom_add_more）', [e2.map((x) => x.ym).sort(), e2.some((x) => 'custom_add_more' in x), (rd.flags || {}).rows_changed_during_read], [['2026-11', '2026-11'], false, 0]);

  /* ── 新擋項二：必要表頭 ── */
  const ren = (k, from, to) => (s) => { const h = s[PS.N[k]][0]; h[h.indexOf(from)] = to; };
  chk('  run 沒有 ym 表頭 → bad_header、missing [ym]', ask(world(baseSheets({ mut: ren('run', 'ym', 'ym_old') }))), { ok: false, error: 'bad_header', table: 'run', missing: ['ym'] });
  chk('  主檔沒有 emp_id 表頭 → bad_header、missing [emp_id]', ask(world(baseSheets({ mut: ren('master', 'emp_id', 'EMP') }))), { ok: false, error: 'bad_header', table: 'master', missing: ['emp_id'] });
  const one = (s) => { s[PS.N.run] = [['renamed_col'], ['SECRET-VAL']]; };
  chk('  w1：run 只有一個改名的表頭＋一筆資料（Codex 重現）→ bad_header、不回 [{}]', ask(world(baseSheets({ mut: one })), { whitelist_version: 'w1' }), { ok: false, error: 'bad_header', table: 'run', missing: ['ym', 'emp_id'] });
  chk('  選填分頁（hol_emp）只有表頭、但表頭不對 → 也是 bad_header（不回空陣列冒充沒資料）', ask(world(baseSheets({ mut: (s) => { s[PS.N.hol_emp] = [['x', 'y']]; } }))), { ok: false, error: 'bad_header', table: 'hol_emp', missing: ['ym', 'emp_id'] });
  const rn = ask(world(baseSheets()));
  chk('  正常匯出：任何一張表都沒有空物件列', Object.keys(rn.tables).filter((t) => rn.tables[t].some((x) => !Object.keys(x).length)), []);

  /* ── 殘餘風險：月份正規化 ── */
  const wn = world(baseSheets({ mut: (s) => {
    const h = s[PS.N.hol_emp]; h[1][col('hol_emp', 'ym')] = ' 2026-11 '; h[2][col('hol_emp', 'ym')] = D('2026-10-31T16:00:00Z');
    const r = s[PS.N.run]; r[1][col('run', 'ym')] = ' 2026-11 ';
    const it = s[PS.N.input]; it[1][col('input', 'ym')] = D('2026-10-31T16:00:00Z');
  } }));
  const rr = ask(wn);
  const yms = []; Object.keys(rr.tables).forEach((t) => rr.tables[t].forEach((x) => { if ('ym' in x) yms.push(x.ym); }));
  chk('  所有表輸出的 ym 都是 YYYY-MM（沒有空白、沒有完整日期）', yms.filter((m) => !/^\d{4}-\d{2}$/.test(m)), []);
  chk('  hol_emp（計算端用 payYmStr_ 正規化）→ 空白、Date 都轉成 2026-11 照出', rr.tables.hol_emp.map((x) => x.ym), ['2026-11', '2026-11']);
  chk('  run、input（計算端逐字比，這種列本來就不算）→ 不出、計入 flags.rows_ym_nonstandard＝2', [rr.tables.run.length, rr.tables.input.filter((x) => x.emp_id === 'E1' && x.ym === '2026-11').length, (rr.flags || {}).rows_ym_nonstandard], [2, 0, 2]);
  chk('  請求月那一列的其他欄位不受影響（E2 2026-11 照全欄位出）', Object.keys(rr.tables.input.find((x) => x.emp_id === 'E2' && x.ym === '2026-11') || {}).length > 9, true);

  /* ── 全面掃描：非請求月不帶金額 ──
     每張表的每個「金額類」欄都塞 987654（時數、旗標、鍵欄用別的值），請求 2026-10、本月 2026-11。
     已核定本來就含金額的：master（底薪、津貼、勞健保…）、run（gross／deduction／net）、item（rate／amount）、bonus（amount）、config（參數 value）、
     以及 input「請求月那一列」。其他表、input 的非請求月列一個都不能有。 */
  const M = 987654;
  const MONEY = {
    master: ['wage', 'base', 'ot_rate', 'skill_allow', 'night_allow', 'mgr_allow', 'editor_allow', 'attend_cap', 'meal_allow', 'labor_ins', 'health_ins', 'group_ins', 'pension', 'co_labor', 'co_health', 'co_pension', 'dormitory', 'gap_rate'],
    config: ['value'], run: ['gross', 'deduction', 'net'], item: ['rate', 'amount'], bonus: ['amount'],
    input: PS.S.input.filter((c) => ['ym', 'emp_id', 'store', 'hours_manual', 'personal_h', 'sick_h', 'menstrual_h', 'disaster_h', 'annual_h', 'support', 'custom_add_more', 'updated_at', 'custom_add_label', 'custom_ded_label'].indexOf(c) < 0),
  };
  const wm = world(baseSheets({ mut: (s) => {
    Object.keys(MONEY).forEach((k) => { const t = s[PS.N[k]]; for (let i = 1; i < t.length; i++) MONEY[k].forEach((c) => { const j = t[0].indexOf(c); if (j >= 0) t[i][j] = M; }); });
    const t = s[PS.N.input];
    for (let i = 1; i < t.length; i++) { t[i][col('input', 'support')] = '[{"store":"測試店二","hours":8,"rate":' + M + ',"amount":' + M + '}]'; t[i][col('input', 'custom_add_more')] = '[{"amt":' + M + '}]'; }
    const add = (ym) => { const r = t[1].slice(); r[col('input', 'ym')] = ym; r[col('input', 'emp_id')] = 'EX'; t.push(r); };
    ['2025-10', '2026-03', '2026-09', '2026-11'].forEach(add);   // 早於與晚於請求月
  } }));
  const rm = ask(wm, { ym: '2026-10' });
  const has = (x) => JSON.stringify(x).indexOf(String(M)) >= 0;
  const where = Object.keys(rm.tables).filter((t) => t !== 'input' && rm.tables[t].some(has)).sort();
  const inpReq = rm.tables.input.filter((x) => x.ym === '2026-10'), inpOther = rm.tables.input.filter((x) => x.ym !== '2026-10');
  chk('  含 987654 的表＝已核定含金額的 bonus、config、item、master、run（其他表沒有）', where, ['bonus', 'config', 'item', 'master', 'run']);
  chk('  input 請求月的列有金額（' + inpReq.length + ' 列）', inpReq.length > 0 && inpReq.every(has), true);
  chk('  input 非請求月的列（' + inpOther.length + ' 列：2025-10、2026-03、2026-09、2026-11）一個 987654 都沒有、也沒有 rate／amount 鍵名',
    [inpOther.map((x) => x.ym).filter((m) => ['2025-10', '2026-03', '2026-09', '2026-11'].indexOf(m) >= 0).length >= 4, inpOther.some(has), inpOther.some((x) => /rate|amount|amt/.test(JSON.stringify(x)))], [true, false, false]);
}

console.log('\n' + (fail ? '❌' : '✅') + ' payroll-shadow-export：' + pass + ' 過、' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
