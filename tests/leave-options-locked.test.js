/* payroll_leave_options 多回 locked（2026-11-13，營運系統「人資退回給店長重核」，Eason 鎖月 A）：
 * 這家店這個月薪資已「鎖定本月」（payroll_run status=final）→ true；沒有 → false；讀不到 payroll_run → 不給這欄。 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');
const sb = { console, SpreadsheetApp: {}, Utilities: {}, Logger: { log() {} }, PropertiesService: {}, LockService: {} };
vm.createContext(sb); vm.runInContext(P, sb);
vm.runInContext(`
  __RUN = [];
  __RUN_FAIL = false;
  checkAdmin   = function(){ return true; };
  payRead      = function(k){
    if (k === 'run') { if (__RUN_FAIL) throw new Error('讀不到'); return __RUN; }
    return k === 'master' ? [{ emp_id:'E01', name:'測試員', store:'SSLGF', active:'true', is_full_time:'true', hire_date:'' }] : []; };
  payClockRead = function(){ return []; };
  payConfig     = function(){ return { daily_hours:8 }; };
  payLeaveEventMap = function(){ return {}; };
  nowTaipeiIso  = function(){ return '2026-11-13T10:00:00+08:00'; };
`, sb);
const call = (b) => vm.runInContext('handlePayrollLeaveOptions', sb)(b);
let p = 0, f = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };
const st = vm.runInContext("payStore('')", sb);
vm.runInContext(`__RUN = [{ ym: '2026-10', store: '${st}', status: 'final' }, { ym: '2026-11', store: '${st}', status: 'draft' }, { ym: '2026-09', store: 'OTHER', status: 'final' }];`, sb);
chk('鎖定的月份 → locked true', call({ admin_key: 'K', store: '', ym: '2026-10' }).locked, true);
chk('草稿的月份 → locked false', call({ admin_key: 'K', store: '', ym: '2026-11' }).locked, false);
chk('別店鎖定不算 → locked false', call({ admin_key: 'K', store: '', ym: '2026-09' }).locked, false);
chk('其他欄位照舊', Object.keys(call({ admin_key: 'K', store: '', ym: '2026-10' })).filter((k) => k !== 'locked').sort(), ['day_hours', 'events', 'ok', 'quotas', 'rule_parental', 'store', 'types', 'ym']);
vm.runInContext('__RUN_FAIL = true;', sb);
const r = call({ admin_key: 'K', store: '', ym: '2026-10' });
chk('讀不到 payroll_run → 照常回、不給 locked', [r.ok, 'locked' in r], [true, false]);
console.log(`\n${p} 通過，${f} 失敗`);
if (f) process.exit(1);
