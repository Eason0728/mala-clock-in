// 把 Code.gs＋Payroll.gs＋Requests.gs 整份載進 vm，資料層換成記憶體假表（只放假資料）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'apps-script');
const C = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(ROOT, 'Payroll.gs'), 'utf8');
const R = fs.readFileSync(path.join(ROOT, 'Requests.gs'), 'utf8');

function load(opt) {
  opt = opt || {};
  const props = opt.props || {};
  const DATA = opt.data || {};      // payRead(kind) → DATA[kind]
  const CLOCK = opt.clock || {};    // payClockRead(store, sheet) → CLOCK[store][sheet]
  const sandbox = {
    console,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d, tz, f) => { const p = n => ('0' + n).slice(-2); const t = new Date(d.getTime() + 8 * 3600000);
      return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()); } },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    __DATA: DATA, __CLOCK: CLOCK, __TODAY: opt.today || '2026-11-09',
    __COUNT: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(C + '\n' + P + '\n' + R, sandbox, { filename: 'clock.gs' });
  vm.runInContext(`
    payRead = function(kind){ __COUNT['payRead:'+kind]=(__COUNT['payRead:'+kind]||0)+1; return (__DATA[kind]||[]).map(function(r){return Object.assign({},r)}); };
    payReplaceAll = function(kind, rows){ __DATA[kind]=rows.map(function(r){return Object.assign({},r)}); };
    payAppend = function(kind, rows){ __DATA[kind]=(__DATA[kind]||[]).concat(rows); };
    payWriteLocked_ = function(kinds, fn){ fn(); return true; };
    payClockRead = function(store, sheet){ __COUNT['clock:'+sheet]=(__COUNT['clock:'+sheet]||0)+1; return ((__CLOCK[store]||{})[sheet]||[]).map(function(r){return Object.assign({},r)}); };
    payHasClock = function(){ return true; };
    payEmpStoresMap = function(){ return {}; };
    todayTaipeiStr = function(){ return __TODAY; };
    nowTaipeiIso = function(){ return __TODAY+'T09:00:00+08:00'; };
    payYesterday_ = function(){ var d=new Date(__TODAY+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); };
    schedPubLoad_ = function(){ return {}; };
  `, sandbox);
  sandbox.call = (fn, ...a) => vm.runInContext(fn, sandbox)(...a);
  sandbox.VmDate = vm.runInContext('Date', sandbox);
  return sandbox;
}
// 一位正職的假主檔（假姓名）
function ftEmp(over) {
  return Object.assign({ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: 30000, skill_allow: 3000, night_allow: 3000,
    mgr_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0,
    dormitory: 0, hire_date: '2021-01-01', leave_date: '', meal_allow: 0, active: 'true', store: 'SSLGF' }, over || {});
}
function ptEmp(over) {
  return Object.assign(ftEmp({ emp_id: 'P01', name: '測試丙', is_full_time: 'false', base: 0, skill_allow: 0, night_allow: 0, attend_cap: 0, wage: 200 }), over || {});
}
const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5, late_div_days: 30, late_div_hours: 8 };
function baseAtt(over) {
  return Object.assign({ hours: 0, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 0, deduct_days: 0,
    support: [], bonuses: [], annual: null, leave_usage: {}, leaves: {}, forget_punch: 0, forget_day: 0, late_min: 0, early_min: 0, attend_void: false,
    full_attend: false, work_days: 0, wage_override: 0, dorm_override: '', meal_on: false, holiday_h: 0 }, over || {});
}
function item(r, key) { const x = [].concat(r.earn, r.ded).find(i => i.item_key === key); return x ? x.amount : 0; }
function items(r) { return [].concat(r.earn.map(i => ['+', i.item_key, i.qty, i.amount]), r.ded.map(i => ['-', i.item_key, i.qty, i.amount])); }
module.exports = { load, ftEmp, ptEmp, cfg, baseAtt, item, items };
