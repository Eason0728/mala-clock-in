/* payroll_leave_options 的身分驗證：管理金鑰與值班主管金鑰「二擇一」都要能過。
 *
 * 這支的存在理由：2026-08-27 薪資頁工時分頁加了「假別額度」，用的是管理金鑰；
 * 而這支 handler 原本只認值班主管金鑰（它本來只給核定頁的假別下拉用）。
 * 兩條路任何一條被改掉，症狀都是「畫面靜靜顯示未授權」而不是報錯——
 * 值班核定頁那條斷了更嚴重：主管會看不到額度、照樣核定，超額的假就這樣進系統。 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');

const sb = { console, SpreadsheetApp: {}, Utilities: {}, Logger: { log() {} },
             PropertiesService: {}, LockService: {} };
vm.createContext(sb); vm.runInContext(P, sb);

// 假試算表：master 一人、managers 一位在職主管；leave 用空的（本測只驗身分，不驗數字）
vm.runInContext(`
  __ADMIN_OK = false;
  checkAdmin   = function(){ return globalThis.__ADMIN_OK; };
  payRead      = function(k){ return k === 'master'
      ? [{ emp_id:'E01', name:'測試員', store:'SSLGF', active:'true', is_full_time:'true', hire_date:'' }] : []; };
  payClockRead = function(st, sheet){ return sheet === 'managers'
      ? [{ key:'MGRKEY', name:'值班主管', active:'true' }] : []; };
  payConfig     = function(){ return { daily_hours:8 }; };
  payLeaveEventMap = function(){ return {}; };
  nowTaipeiIso  = function(){ return '2026-08-27T10:00:00+08:00'; };
`, sb);
const call = (f, ...a) => vm.runInContext(f, sb)(...a);
const setAdmin = v => vm.runInContext('__ADMIN_OK = ' + (v ? 'true' : 'false'), sb);

let p = 0, f = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

console.log('══ 管理金鑰（薪資頁「假別額度」）══');
setAdmin(true);
const a = call('handlePayrollLeaveOptions', { admin_key: 'ADMINKEY', store: '', ym: '2026-08' });
chk('管理金鑰可通過', a.ok, true);
chk('有回假別清單', Array.isArray(a.types) && a.types.length > 0, true);
chk('有回每人額度', Object.keys(a.quotas || {}), ['E01']);
chk('沒帶 mgr_key 也不擋', a.error === undefined, true);

console.log('\n══ 值班主管金鑰（核定頁假別下拉）══');
setAdmin(false);
const b = call('handlePayrollLeaveOptions', { mgr_key: 'MGRKEY', store: '', ym: '2026-08' });
chk('主管金鑰可通過', b.ok, true);
chk('有回每人額度', Object.keys(b.quotas || {}), ['E01']);

console.log('\n══ 兩把都沒有／都不對 ══');
chk('金鑰全空 → unauthorized', call('handlePayrollLeaveOptions', { store: '' }).error, 'unauthorized');
chk('主管金鑰錯 → unauthorized',
    call('handlePayrollLeaveOptions', { mgr_key: '亂打的', store: '' }).error, 'unauthorized');

console.log('\n══ 停用的主管不得放行 ══');
vm.runInContext(`payClockRead = function(st, sheet){ return sheet === 'managers'
    ? [{ key:'MGRKEY', name:'已停用主管', active:'false' }] : []; };`, sb);
chk('active=false → unauthorized',
    call('handlePayrollLeaveOptions', { mgr_key: 'MGRKEY', store: '' }).error, 'unauthorized');

console.log(f ? `\n❌ ${f} 項失敗（通過 ${p}）` : `\n✅ 假別額度身分驗證全部正確 (${p}/${p})`);
process.exit(f ? 1 : 0);
