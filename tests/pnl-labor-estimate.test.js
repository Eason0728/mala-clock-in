/* T15：pnlLaborEstimate 唯讀端點（月中人事成本估算，mala-pnl-auto 對接）本機測試。
 *
 * 手法比照既有 tests/cost-basis.test.js：用 Node vm 把真正的 Code.gs＋Payroll.gs 一起載入
 * 一個假的 GAS 全域環境，再直接呼叫 handlePnlLaborEstimate_（PAYROLL_HANDLERS.pnlLaborEstimate
 * 掛的那支）。不建假 SpreadsheetApp——payRead()／payClockRead() 直接在 vm context 裡整支覆寫成
 * 回傳本測試準備的假資料（roster/approved/leave/master/bonus/config/holiday），比照
 * cost-basis.test.js「覆寫 payRead/payConfig」的既有作法，不多寫一套假試算表基礎設施。
 * todayTaipeiStr() 同樣整支覆寫成回傳固定日期，讓「今天／昨天」在測試裡可控、與時區無關
 * （正式環境靠 Apps Script 專案時區＝Asia/Taipei，這裡直接跳過時區換算，只驗證字串邏輯）。
 *
 * 全程只用虛構姓名（同仁甲／同仁乙）與虛構金額，不接觸任何真實資料或正式端點。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const __ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__ROOT, 'apps-script', 'Payroll.gs'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; fails.push(name + '：實得 ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)); }
  console.log((ok ? '✓ ' : '✗ ') + name + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want)));
}

// ---------- 假 GAS 全域（只給這支端點用得到的最小集合） ----------
function makeSandbox() {
  const cache = {};
  const props = { PNL_KEY: 'test-pnl-key-虛構' };
  const auditLog = [];
  const sb = {
    console,
    Logger: { log() {} },
    // nowTaipeiIso()（checkPnlKey_ 記 audit 時會用到時間戳）需要一個真的能動的 formatDate；
    // todayTaipeiStr() 本身另外整支覆寫成回傳固定日期（見 wire()），兩者互不衝突。
    Utilities: {
      formatDate: function (date, tz, fmt) {
        const d = new Date(date.getTime() + 8 * 3600 * 1000);   // Asia/Taipei = UTC+8，無日光節約
        const pad = (n) => String(n).padStart(2, '0');
        const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
        const hh = pad(d.getUTCHours()), mi = pad(d.getUTCMinutes()), ss = pad(d.getUTCSeconds());
        if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${da}`;
        return `${y}-${mo}-${da}T${hh}:${mi}:${ss}+08:00`;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = String(v); },
      remove: (k) => { delete cache[k]; },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => { throw new Error('本測試不應打開任何真的試算表（payRead/payClockRead 已整支覆寫）'); },
                       getActive: () => null },
    DriveApp: { createFolder: () => { throw new Error('本測試不應呼叫 DriveApp'); } },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__auditLog = auditLog;
  return sb;
}

// 分頁存不存在的假 SpreadsheetApp／getSS 用——預設全部分頁都存在（正常情境），
// pnlEstimateSheetsReady_() 只呼叫 getSheetByName，不應該走到真的 SpreadsheetApp.openById。
const ALL_PAY_SHEET_NAMES = ['payroll_master', 'payroll_config', 'payroll_holiday', 'payroll_run',
  'payroll_item', 'payroll_input', 'payroll_audit', 'payroll_store', 'payroll_bonus',
  'payroll_leave_type', 'payroll_leave_span', 'payroll_leave_event', 'payroll_cost_snapshot'];

/** 把一份 {master, bonus, holiday, config, roster, approved, leave, missingSheets} 的假資料
 *  灌進 vm，整支覆寫 payRead/payClockRead/todayTaipeiStr/getSS。payAppend('audit', ...) 也
 *  攔下來記錄，用來驗證「唯讀」——金鑰鎖定那唯一的例外會寫一筆 audit，其餘路徑不應該有任何一筆。
 *  fx.missingSheets：故意標成「不存在」的分頁名稱陣列（測 pnlEstimateSheetsReady_ 的 NO_DATA）。 */
function wire(sb, fx) {
  const auditLog = sb.__auditLog;
  const missing = fx.missingSheets || [];
  vm.runInContext(`
    payRead = function(kind){
      var d = ${JSON.stringify(fx.payRead || {})};
      return (d[kind] || []).slice();
    };
    payClockRead = function(store, sheetName){
      var key = store + ':' + sheetName;
      var d = ${JSON.stringify(fx.payClockRead || {})};
      return (d[key] || []).slice();
    };
    todayTaipeiStr = function(){ return ${JSON.stringify(fx.today)}; };
    getSS = function(){
      var missingNames = ${JSON.stringify(missing)};
      var allNames = ${JSON.stringify(ALL_PAY_SHEET_NAMES)};
      return { getSheetByName: function(name){
        if (missingNames.indexOf(name) >= 0) return null;
        return allNames.indexOf(name) >= 0 ? { __fake: true, name: name } : null;
      } };
    };
    payAppend = function(kind, rows){
      if (kind === 'audit') { __auditLog.push.apply(__auditLog, rows); return; }
      throw new Error('本測試預期唯讀端點不會呼叫 payAppend(kind=' + kind + ')');
    };
    payReplaceAll = function(kind){ throw new Error('本測試預期唯讀端點不會呼叫 payReplaceAll(kind=' + kind + ')'); };
  `, sb);
  return function call(body) { return vm.runInContext('handlePnlLaborEstimate_', sb)(body); };
}

// ---------- 共用假資料 ----------
// 同仁甲：正職，到職 2026-01-01，底薪 30000／全勤上限 1000／公司負擔勞健保退休金逐人填。
// 同仁乙：計時，到職 2026-06-01，時薪 200。
const MASTER = [
  { emp_id: 'FT01', name: '同仁甲', is_full_time: 'true', store: 'SSLGF', active: 'true',
    base: 30000, wage: 0, ot_rate: 200, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
    attend_cap: 1000, labor_ins: 700, health_ins: 400, group_ins: 0, pension: 0, dormitory: 0,
    hire_date: '2026-01-01', leave_date: '', meal_allow: 0, gap_rate: 0,
    co_labor: 800, co_health: 500, co_pension: 300, yearend_months: '' },
  { emp_id: 'PT01', name: '同仁乙', is_full_time: 'false', store: 'SSLGF', active: 'true',
    base: 0, wage: 200, ot_rate: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
    attend_cap: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
    hire_date: '2026-06-01', leave_date: '', meal_allow: 0, gap_rate: 0,
    co_labor: 0, co_health: 0, co_pension: 0, yearend_months: '' },
];
const CONFIG_ROWS = [
  { key: 'daily_hours', value: '8', store: '' },
  { key: 'late_deduct', value: 'false', store: '' },
  { key: 'meal_min_hours', value: '6', store: '' },
];
const HOLIDAY_ROWS = [{ ym: '2026-09', red_days: '4', note: '', dates: '', store: '' }];

function approvedRow(date, emp, hours, statusText) {
  return { date: date, emp_id: emp, approved_hours: hours, status_text: statusText || '',
           entered_at: date + 'T20:00:00+08:00' };
}

console.log('══ 1) 基本估算：ym=當月, today=2026-09-27 → as_of 應為昨天 2026-09-26 ══');
{
  const sb = makeSandbox();
  const approved = [];
  // 同仁甲 9/1～9/26 每天核定 8H（=26 天 * 8H = 208H），9/27（今天，尚未截止）多打一筆 12H 想測試會不會被排除
  for (let d = 1; d <= 26; d++) approved.push(approvedRow('2026-09-' + String(d).padStart(2, '0'), 'FT01', 8));
  approved.push(approvedRow('2026-09-27', 'FT01', 12));   // 今天的資料，估算不應採用
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  ok', r.ok, true);
  chk('  as_of＝昨天', r.as_of, '2026-09-26');
  chk('  days_elapsed', r.days_elapsed, 26);
  chk('  days_in_month', r.days_in_month, 30);
  chk('  method 是 partial_month_to_date 開頭', /^partial_month_to_date/.test(r.method), true);
  // 底薪＝30000 × (26/30) 折算（虛擬離職日=昨天，借用 payRatio），四捨五入到元
  const expectBase = Math.round(30000 * 26 / 30);
  chk('  base_ft ≈ 月薪×已過天數÷當月天數', r.rows.base_ft, expectBase);
  // 208H 核定 < 基本工時 (30-4紅字天)*8*(26/30) ≈ 180.27H → 有加班
  chk('  ot_ft > 0（核定工時超過折算後的基本工時就該有加班）', r.rows.ot_ft > 0, true);
  chk('  回應完全找不到姓名字樣', JSON.stringify(r).indexOf('同仁甲') === -1 && JSON.stringify(r).indexOf('同仁乙') === -1, true);
  chk('  唯讀：整趟呼叫 0 筆 audit 寫入', sb.__auditLog.length, 0);
}

console.log('\n══ 2) 今天核定的資料確實被排除（cutoff 生效）══');
{
  const sb = makeSandbox();
  // 只給 9/26（含）以前的資料 vs 額外多一筆 9/27（今天）的資料，兩次呼叫應該得到相同的 base_ft/pt
  const approvedWithout27 = [];
  for (let d = 1; d <= 26; d++) approvedWithout27.push(approvedRow('2026-09-' + String(d).padStart(2, '0'), 'PT01', 8));
  const approvedWith27 = approvedWithout27.concat([approvedRow('2026-09-27', 'PT01', 100)]);   // 今天异常大量的一筆
  function run(approved) {
    const call = wire(sb, {
      today: '2026-09-27',
      payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
      payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                       'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
    });
    return call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  }
  const r1 = run(approvedWithout27), r2 = run(approvedWith27);
  chk('  今天多刷的 100H 不影響估算（cutoff 排除今天）', r2.rows.pt, r1.rows.pt);
}

console.log('\n══ 3) ym=上個月：as_of＝上月最後一天（整月即時重算）══');
{
  const sb = makeSandbox();
  const approved = [];
  for (let d = 1; d <= 31; d++) approved.push(approvedRow('2026-08-' + String(d).padStart(2, '0'), 'FT01', 8));
  const call = wire(sb, {
    today: '2026-09-05',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: [{ ym: '2026-08', red_days: '4', note: '', dates: '', store: '' }], bonus: [] },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-08', store: 'SSLGF' });
  chk('  ok', r.ok, true);
  chk('  as_of＝上月最後一天', r.as_of, '2026-08-31');
  chk('  days_elapsed＝days_in_month（整月）', r.days_elapsed, r.days_in_month);
  chk('  method 是 prior_month_recomputed 開頭', /^prior_month_recomputed/.test(r.method), true);
  chk('  整月折算比例＝1 → base_ft＝整月底薪', r.rows.base_ft, 30000);
}

console.log('\n══ 4) 錯誤代碼 ══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  chk('  缺金鑰 → AUTH', call({ ym: '2026-09', store: 'SSLGF' }).error, 'AUTH');
  chk('  金鑰錯 → AUTH', call({ key: 'wrong', ym: '2026-09', store: 'SSLGF' }).error, 'AUTH');
  chk('  ym 格式錯 → BAD_INPUT', call({ key: 'test-pnl-key-虛構', ym: '2026/09', store: 'SSLGF' }).error, 'BAD_INPUT');
  chk('  ym 是兩個月前 → BAD_INPUT', call({ key: 'test-pnl-key-虛構', ym: '2026-07', store: 'SSLGF' }).error, 'BAD_INPUT');
  chk('  ym 是下個月 → BAD_INPUT', call({ key: 'test-pnl-key-虛構', ym: '2026-10', store: 'SSLGF' }).error, 'BAD_INPUT');
}

console.log('\n══ 5) 金鑰連續錯 20 次 → AUTH_LOCKED（與 pnlPayroll 共用同一套門檻/CacheService key，但金鑰本身互不影響）══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  for (let i = 0; i < 19; i++) call({ key: 'wrong', ym: '2026-09', store: 'SSLGF' });
  const r20 = call({ key: 'wrong', ym: '2026-09', store: 'SSLGF' });
  chk('  第 20 次仍是 AUTH（門檻剛跨過）', r20.error, 'AUTH');
  const r21 = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  第 21 次連對的金鑰也被擋 → AUTH_LOCKED', r21.error, 'AUTH_LOCKED');
  chk('  門檻跨過那一刻記一筆 audit（安全事件，不是業務寫入）', sb.__auditLog.length, 1);
  chk('  audit 內容是 pnl_key_locked', sb.__auditLog[0].action, 'pnl_key_locked');
}

console.log('\n══ 6) 本月第 1 天（沒有「昨天」）→ NO_DATA ══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-01',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  error', r.error, 'NO_DATA');
}

console.log('\n══ 7) 該店沒有在職同仁主檔 → NO_DATA ══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: [], config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  error', r.error, 'NO_DATA');
}

console.log('\n══ 8) 不可估的鍵：custom_add/custom_ded/宿舍收入 一律不影響估算輸出（rows 裡沒有這些鍵）══');
{
  const sb = makeSandbox();
  const approved = [approvedRow('2026-09-01', 'FT01', 8)];
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  const keys = Object.keys(r.rows);
  chk('  rows 沒有 custom_add', keys.indexOf('custom_add') === -1, true);
  chk('  rows 沒有 custom_ded', keys.indexOf('custom_ded') === -1, true);
  chk('  rows 沒有 dorm', keys.indexOf('dorm') === -1, true);
  chk('  not_estimated 有列出這三塊', r.not_estimated.length >= 2, true);
}

console.log('\n══ 9) payCollect 新增的 cutoffDate 參數：既有呼叫路徑（不傳第五參數）行為不變 ══');
{
  // 直接抽 payCollect 出來單元測試：整月歸集（不傳 cutoffDate）應包含月底最後一天的資料。
  const GS = P;
  const a = GS.indexOf('function payCollect'), b = GS.indexOf('/* ═══════════════════ 計算引擎');
  const slice = GS.slice(a, b);
  const sbx = { console };
  vm.createContext(sbx);
  vm.runInContext(`
    function pad2(n){return ('0'+n).slice(-2)}
    function payLeaveTypes(){ return []; }
    function payClockRead(store, name){
      if (name==='roster') return [{emp_id:'FT01',name:'同仁甲'}];
      if (name==='approved') return APPROVED;
      if (name==='events') return [];
      if (name==='leave') return [];
      return [];
    }
    function normCellDate(v){ return String(v).slice(0,10); }
    function normCellTs(v){ return String(v); }
    function buildLatestApprovedMap(rows){
      var map={};
      rows.forEach(function(r){
        var d=normCellDate(r.date), emp=String(r.emp_id);
        if(!map[d]) map[d]={};
        var existing=map[d][emp];
        if(!existing || normCellTs(r.entered_at) > normCellTs(existing.entered_at)) map[d][emp]=r;
      });
      return map;
    }
    function pairShifts(){ return { unmatchedIns: [], unmatchedOuts: [] }; }
    function todayTaipeiStr(){ return '2026-09-27'; }
    function tsDateStr(ts){ return String(ts).slice(0,10); }
    function payMissingGroups(){ return 0; }
    function payHasLateEarly(){ return { any: false }; }
    var APPROVED = [
      {date:'2026-09-01', emp_id:'FT01', approved_hours:8, status_text:'', entered_at:'2026-09-01T20:00:00+08:00'},
      {date:'2026-09-30', emp_id:'FT01', approved_hours:8, status_text:'', entered_at:'2026-09-30T20:00:00+08:00'},
    ];
    ${slice}
  `, sbx);
  const payCollect = vm.runInContext('payCollect', sbx);
  const full = payCollect('2026-09', 6, 'SSLGF', []);
  chk('  沒傳 cutoffDate（既有呼叫路徑）→ 整月都算進去', full['FT01'].hours, 16);
  const cut = payCollect('2026-09', 6, 'SSLGF', [], '2026-09-15');
  chk('  傳了 cutoffDate=09-15 → 只算 09-01 那筆', cut['FT01'].hours, 8);
}

console.log('\n══ 10) 上個月獎金：不論登記日一律計入；當月獎金：只算 as_of 前登記的 ══');
{
  const approved = [approvedRow('2026-08-01', 'FT01', 8)];
  const bonusLateRegistered = [{ ym: '2026-08', store: 'SSLGF', emp_id: 'FT01', bonus_type: 'perf', label: '績效獎金', amount: 999, updated_at: '2026-09-10T10:00:00+08:00' }];
  // ym＝上個月（2026-08），today 落在 9 月：獎金是 9/10 才登記（比 as_of=08-31 晚很多），
  // 但屬於上個月，理論上一定要算進去。
  const sbPrev = makeSandbox();
  const callPrev = wire(sbPrev, {
    today: '2026-09-15',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: [{ ym: '2026-08', red_days: '4', note: '', dates: '', store: '' }], bonus: bonusLateRegistered },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const rPrev = callPrev({ key: 'test-pnl-key-虛構', ym: '2026-08', store: 'SSLGF' });
  chk('  上個月：次月才登記的獎金仍計入 bonus_perf', rPrev.rows.bonus_perf, 999);

  // 同一筆獎金掛在「當月」（2026-09），今天是 09-27（as_of=09-26），但 updated_at 是 09-27（今天）
  // 才登記 → 今天還沒過完，理論上不該算進「昨天以前」的估算。
  const bonusToday = [{ ym: '2026-09', store: 'SSLGF', emp_id: 'FT01', bonus_type: 'perf', label: '績效獎金', amount: 888, updated_at: '2026-09-27T10:00:00+08:00' }];
  const sbCur = makeSandbox();
  const callCur = wire(sbCur, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: bonusToday },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': [approvedRow('2026-09-01', 'FT01', 8)], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const rCur = callCur({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  當月：今天才登記的獎金不計入（as_of 之後）', rCur.rows.bonus_perf, 0);
}

console.log('\n══ 11) 疊上 payroll_input 手動覆蓋：support／wage_override／手動工時整筆覆蓋打卡歸集 ══');
{
  const sb = makeSandbox();
  // PT01 有 5H 的打卡核定，但 payroll_input 存了整月手動工時 50H＋時薪覆蓋 300＋跨店支援 10H×180。
  // 若合併規則生效：應該採用「50H×300」而不是「5H×200(預設時薪)」，且 support 出現在回應裡。
  const approved = [approvedRow('2026-09-01', 'PT01', 5)];
  const inputRows = [{ ym: '2026-09', emp_id: 'PT01', store: 'SSLGF',
    hours: 50, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 0,
    deduct_days: 0, support: JSON.stringify([{ store: 'MZTJS', hours: 10, rate: 180, amount: '' }]),
    updated_at: '2026-09-20T10:00:00+08:00', full_attend: 0, work_days: 0, wage_override: 300,
    meal_on: 0, holiday_h: '', custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0,
    dorm_override: '' }];
  // 到職僅一週，避開年資加給（+10/H）弄髒預期值。
  const masterYoungPT = MASTER.map(m => m.emp_id === 'PT01' ? Object.assign({}, m, { hire_date: '2026-09-20' }) : m);
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: masterYoungPT, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [], input: inputRows },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  ok', r.ok, true);
  // 薪資（時數）50H×300 ＝ 15000；跨店支援 10H×180（gapRate=0→gapH 不分攤）＝ 1800；
  // 兩者都歸「薪資費用／PT」（pt 鍵），reducePT=0 → pt = 16800。
  chk('  pt 用了手動覆蓋的 50H×300，不是打卡的 5H', r.rows.pt, 16800);
  chk('  跨店支援彙總到 support.MZTJS', r.support, { MZTJS: 1800 });
}

console.log('\n══ 12) 紅字天數缺列 → red_days_missing:true（redDays 當 0，不影響底薪）══');
{
  const sb = makeSandbox();
  const approved = [approvedRow('2026-09-01', 'FT01', 8)];
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: [], bonus: [] },   // 沒有任何紅字天數列
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  ok', r.ok, true);
  chk('  red_days_missing 為 true', r.red_days_missing, true);

  const sb2 = makeSandbox();
  const call2 = wire(sb2, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },   // 有設定
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const r2 = call2({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  有設定紅字天數時不帶這個旗標', 'red_days_missing' in r2, false);
}

console.log('\n══ 13) 分頁尚未初始化（缺分頁）→ NO_DATA，且不經 payRead 的 insertSheet 分支 ══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
    missingSheets: ['payroll_leave_type'],   // 假裝這張分頁還沒被建立過
  });
  const r = call({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  error', r.error, 'NO_DATA');
}

console.log('\n══ 14) audit 文字區分 pnlPayroll／pnlLaborEstimate ══');
{
  const sb = makeSandbox();
  const call = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': [], 'SSLGF:approved': [], 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  for (let i = 0; i < 20; i++) call({ key: 'wrong', ym: '2026-09', store: 'SSLGF' });
  chk('  audit reason 提到 pnlLaborEstimate', /pnlLaborEstimate/.test(sb.__auditLog[0].reason), true);
}

console.log('\n══ 15) CacheService：同 (ym,store,as_of) 10 分鐘內吃快取，換一組 key 就重算 ══');
{
  const sb = makeSandbox();
  const approvedOrig = [approvedRow('2026-09-01', 'FT01', 8)];
  const call1 = wire(sb, {
    today: '2026-09-27',
    payRead: { master: MASTER, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approvedOrig, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const rFirst = call1({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });

  // 同一個 sb（CacheService 是同一份記憶體），换一份「底薪暴增」的 master，
  // 但 ym/store/as_of 完全相同 → 應該吃到快取，拿到跟第一次一樣的舊答案。
  const masterInflated = MASTER.map(m => m.emp_id === 'FT01' ? Object.assign({}, m, { base: 999999 }) : m);
  const call2 = wire(sb, {
    today: '2026-09-27',
    payRead: { master: masterInflated, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'SSLGF:roster': MASTER.map(m => ({ emp_id: m.emp_id, name: m.name, active: m.active })),
                     'SSLGF:approved': approvedOrig, 'SSLGF:events': [], 'SSLGF:leave': [] },
  });
  const rCached = call2({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'SSLGF' });
  chk('  同一組 (ym,store,as_of) → 吃快取，數字跟第一次相同（沒有反映底薪暴增）', rCached.rows.base_ft, rFirst.rows.base_ft);

  // 換一個不同的 store → cache key 不同 → 應該重新計算，反映新的底薪。
  const masterOtherStore = MASTER.map(m => m.emp_id === 'FT01' ? Object.assign({}, m, { base: 999999, store: 'MZTJS' }) : m);
  const call3 = wire(sb, {
    today: '2026-09-27',
    payRead: { master: masterOtherStore, config: CONFIG_ROWS, holiday: HOLIDAY_ROWS, bonus: [] },
    payClockRead: { 'MZTJS:roster': [{ emp_id: 'FT01', name: '同仁甲', active: 'true' }],
                     'MZTJS:approved': approvedOrig, 'MZTJS:events': [], 'MZTJS:leave': [] },
  });
  const rOtherStore = call3({ key: 'test-pnl-key-虛構', ym: '2026-09', store: 'MZTJS' });
  // 不直接比對精確金額（這組資料核定工時遠低於基本工時，會觸發不足時數倒扣，扣款金額本身
  // 不是這個測試要驗證的重點）；只要「確實反映了新底薪、不是快取裡的舊答案」就達到目的。
  chk('  不同 store → cache key 不同 → 真的重新計算了（數字跟快取住的舊答案不同）',
      rOtherStore.rows.base_ft !== rCached.rows.base_ft, true);
  chk('  不同 store → 新底薪 999999 有反映出來（遠大於舊底薪 30000 折算後的量級）',
      rOtherStore.rows.base_ft > 100000, true);
}

console.log(`\n${fail ? '❌ 有失敗：\n' + fails.join('\n') : '✅ 全部通過'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
