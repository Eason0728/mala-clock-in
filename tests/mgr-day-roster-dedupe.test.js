'use strict';
// handleMgrDay 名冊手動加列漏填員編／複製列重複員編：不列空員編、同員編只列一次（2026-11-04 考勤 QA）
//   營運系統個人登入遇到空員編會整店擋下（已在營運系統放寬）、重複員編會畫兩張卡；這裡在源頭擋。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
function sheet(rows) {
  const data = rows.map((r) => r.slice());
  return {
    getDataRange() { return { getValues: () => data.map((r) => r.slice()) }; },
    getLastRow() { return data.length; }, getLastColumn() { return data[0] ? data[0].length : 0; },
    getRange() { return { setValues() {}, setNumberFormat() {}, getValues: () => [[]] }; },
  };
}
function day(rosterRows) {
  const sheets = {
    managers: sheet([['name', 'key', 'active'], ['測試主管', 'MK', 'true']]),
    roster: sheet([['emp_id', 'name', 'key', 'active']].concat(rosterRows)),
    events: sheet([['ts', 'emp_id', 'type', 'status']]),
    approved: sheet([['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at']]),
    leave: sheet([['日期', '姓名', '假別', '時數']]),
  };
  const sb = { console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array, RegExp, Error };
  vm.createContext(sb);
  vm.runInContext(code, sb);
  sb.getSS = () => ({ getSheetByName: (k) => sheets[k] || null });
  sb.nowTaipeiIso = () => '2026-10-26T21:00:00+08:00';
  sb.todayTaipeiStr = () => '2026-10-26';
  sb.leaveTypeAllowedByPayroll = () => false;
  const r = sb.handleMgrDay({ mgr_key: 'MK', date: '2026-10-26' });
  return JSON.parse(JSON.stringify(r.employees.map((e) => e.emp_id + ":" + e.name)));
}
assert.deepStrictEqual(day([['E01', '測試一', 'k1', 'true'], ['E01', '測試一（重複列）', 'k9', 'true'], ['E02', '測試二', 'k2', 'true']]),
  ['E01:測試一', 'E02:測試二'], '重複員編只列第一列');
assert.deepStrictEqual(day([['E01', '測試一', 'k1', 'true'], ['', '沒編號', 'k9', 'true'], ['  ', '空白', 'k8', 'true']]),
  ['E01:測試一'], '空員編不列');
console.log('✓ mgr_day 名冊去空員編、去重複員編');
