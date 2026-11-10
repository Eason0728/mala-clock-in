/* 2026-11-10 Eason 定案的兩項薪資規則：
 *  ① 正職同一個 28 天週期有排「國定假日假」，原本的國定假日當天上班不給雙薪（payHolMoved_）
 *  ② 整段沒打卡（核定狀態「該段無打卡」）算忘刷，同一天只算 1 天；「打卡未入帳，主管補登」不算（2026-11 起） */
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = path.join(__dirname, '..', 'apps-script');
const src = ['Code.gs', 'Payroll.gs', 'SchedPub.gs'].map(f => fs.readFileSync(path.join(R, f), 'utf8')).join('\n');
const sb = { console, SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => { const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) }, CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) } };
vm.createContext(sb); vm.runInContext(src, sb);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};payStoreRow=function(){return {code:"SSLGF",emp_prefix:""};};payHolidayRow=function(){return null;};', sb);
const CLOCK = sb.__CLOCK = {};
const call = (fn, ...a) => vm.runInContext(fn, sb)(...a);
const J = (x) => JSON.parse(JSON.stringify(x));
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

console.log('══ ① 國定假日調移 ══');
// T02＝2026-11-29～12-26；12/25 是第 26 天（index 26）
const cells = (marks) => { const c = Array.from({ length: 28 }, () => ({ t: 'W', s: 'A' })); Object.keys(marks).forEach(i => { c[i] = marks[i]; }); return c; };
const pub = (rows) => vm.runInContext('(function(x){ schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(x)); }; })', sb)({ '|T02': { rows } });
const M = [{ emp_id: 'E01', name: '測試一', is_full_time: true }, { emp_id: 'E02', name: '測試二', is_full_time: false }];
const GUO = { t: 'L', l: '國' };
pub([{ emp_id: 'E01', name: '測試一', cells: cells({ 19: GUO }) }, { emp_id: 'E02', name: '測試二', cells: cells({ 19: GUO }) }]);
chk('正職同期 12/18 排國定假日假、12/25 上班 → 12/25 不給雙薪', J(call('payHolMoved_', '2026-12', 'SSLGF', M, ['2026-12-25'], call('paySchedIndex_'))), { E01: { '2026-12-25': true } });
pub([{ emp_id: 'E01', name: '測試一', cells: cells({}) }]);
chk('沒排國定假日假 → 照給雙薪', J(call('payHolMoved_', '2026-12', 'SSLGF', M, ['2026-12-25'], call('paySchedIndex_'))), {});
pub([{ emp_id: 'E01', name: '測試一', cells: cells({ 26: GUO }) }]);
chk('國定假日假就排在 12/25 當天 → 不另外抵', J(call('payHolMoved_', '2026-12', 'SSLGF', M, ['2026-12-25'], call('paySchedIndex_'))), {});
pub([{ emp_id: 'E01', name: '測試一', cells: cells({ 5: GUO }) }]);
chk('一期兩個國定假日只排一天 → 日期早的不給雙薪', J(call('payHolMoved_', '2026-12', 'SSLGF', M, ['2026-12-10', '2026-12-25'], call('paySchedIndex_'))), { E01: { '2026-12-10': true } });
chk('排除後的國定假日清單', J(call('payHolKeep_', ['2026-12-10', '2026-12-25'], { '2026-12-10': true })), ['2026-12-25']);
const sum = (hol) => J(call('payOtDailySum', { dates: ['2026-12-25'], sched: { '2026-12-25': { t: 'W', s: 'A' } }, day_h: { '2026-12-25': 8 }, day_leave: {}, hol, until: '' }));
chk('調移後 12/25 上班 8 小時：沒有國定假日加發', [sum({ '2026-12-25': true }).hol_h, sum({}).hol_h], [8, 0]);

console.log('\n══ ② 整段沒打卡算忘刷 ══');
function collect(ym, rows) {
  CLOCK.roster = [{ emp_id: 'E01', name: '測試一', active: true, key: 'k' }];
  CLOCK.events = []; CLOCK.leave = []; CLOCK.requests = [];
  CLOCK.approved = rows.map(([d, st]) => ({ date: d, name: '測試一', emp_id: 'E01', approved_hours: 8, status_text: st, entered_at: 'x', manager_name: 'M' }));
  return call('payCollect', ym, 6, 'SSLGF', [])['E01'] || {};
}
let c = collect('2026-11', [['2026-11-03', '該段無打卡'], ['2026-11-05', '遲到3分、該段無打卡'], ['2026-11-06', '打卡未入帳，主管補登'], ['2026-11-07', '主管說該段無打卡']]);
chk('11 月：兩天整段沒打卡 → 忘刷 2 天', c.forget_day, 2);
chk('11 月：缺勤天數也算進去（小辛辣每天扣）', c.deduct_days, 2);
c = collect('2026-10', [['2026-10-03', '該段無打卡']]);
chk('10 月以前不動', c.forget_day, 0);

console.log(`\n${p} 項通過、${f} 項失敗`);
process.exit(f ? 1 : 0);
