#!/usr/bin/env node
/* 本機假後端的「鎖定前檢查」（1113 紅燈 d4，Eason 2026-11-13 選 A）：直接跑正式版 apps-script 的 handlePayrollFinalize，
 * 七道檢查（stale_run／comp_negative／comp_over／ot_form_missing／sched_missing／unapproved／leave_mismatch）與訊息和正式版一字不差。
 * mock/payroll_mock_handlers.py 的 h_finalize 在鎖定時呼叫這支：stdin 收一包 JSON、stdout 回 {gate: 錯誤物件 | null}。
 *
 * 輸入：{ body:{ym, store, lock:true, inputs?}, today:'yyyy-MM-dd', payroll:{master, run, holiday, config, item, input, store, …},
 *        clock:{events, approved, requests, leave（中文欄名：日期／姓名／假別／時數）, roster, managers}, sched_pub:{…}, stale:[…] }
 *  - 資料層換成記憶體（只讀不寫）：payRead→payroll、payClockRead→clock（本機只有一家店）、schedPubLoad_→sched_pub。
 *  - stale_run 的比對對象是 mock 自己的簡化算薪（不是 payCalcOne），所以差異名單由 Python 算好帶進來（stale），
 *    payLockStale_ 換成回這份名單；訊息與擋法仍走正式版。
 *  - 寫入那段（payWriteLocked_）不執行：檢查全過時正式版會回 no_run（本來就沒寫），這裡回 gate:null，由 mock 自己改狀態。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', 'apps-script');
const FILES = ['Code.gs', 'Payroll.gs', 'Requests.gs', 'SchedPub.gs'];

function gate(input) {
  const today = String(input.today || '');
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); const t = new Date(d.getTime() + 8 * 3600000);
      return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()); } },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    __IN: input, __TODAY: today,
  };
  vm.createContext(sb);
  vm.runInContext(FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'), sb, { filename: 'gate.gs' });
  vm.runInContext(`
    payRead = function (k) { return ((__IN.payroll || {})[k] || []).map(function (r) { return Object.assign({}, r); }); };
    payClockRead = function (st, sh) { return ((__IN.clock || {})[sh] || []).map(function (r) { return Object.assign({}, r); }); };
    payHasClock = function () { return true; };
    payStoreRow = function (c) { return ((__IN.payroll || {}).store || []).filter(function (x) { return payStore(x.code) === payStore(c); })[0] || { code: c, emp_prefix: '' }; };
    payEmpStoresMap = function () { return {}; };
    payHolidaySync = function () {};
    checkAdmin = function () { return true; };
    todayTaipeiStr = function () { return __TODAY; };
    nowTaipeiIso = function () { return __TODAY + 'T09:00:00+08:00'; };
    payYesterday_ = function () { var d = new Date(__TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    schedPubLoad_ = function () { return JSON.parse(JSON.stringify(__IN.sched_pub || {})); };
    payLockStale_ = function () { return { list: (__IN.stale || []).slice() }; };
    payWriteLocked_ = function () { return true; };   // 不寫：只要檢查結果
    payAppend = function () {}; payReplaceAll = function () {}; payInvalidate = function () {};
  `, sb);
  const body = Object.assign({}, input.body || {}, { lock: true, admin_key: 'mock' });
  delete body.cost_snapshot;
  const r = JSON.parse(JSON.stringify(vm.runInContext('handlePayrollFinalize', sb)(body)));
  if (r.ok || r.error === 'no_run') return null;   // 七道都過（沒寫入，所以正式版回 no_run）
  return r;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let out;
    try { out = { gate: gate(JSON.parse(raw || '{}')) }; }
    catch (e) { out = { error: String((e && e.message) || e) }; }
    process.stdout.write(JSON.stringify(out));
  });
}
module.exports = { gate };
