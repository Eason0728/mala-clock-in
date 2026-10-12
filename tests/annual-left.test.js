/* payroll_annual_left：門市營運系統「自動排班」班表名字下方的剩餘特休（2026-10-12 Eason）。
 * 驗：管理金鑰／值班主管金鑰二擇一、停用主管擋、金鑰錯擋；數字直接取 payAnnualInfo（與薪資頁、薪資單同一支），
 * 小時換天數（÷8、一位小數），計時同仁 null。 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');

const sb = { console, SpreadsheetApp: {}, Utilities: {}, Logger: { log() {} }, PropertiesService: {}, LockService: {} };
vm.createContext(sb); vm.runInContext(P, sb);
vm.runInContext(`
  __ADMIN_OK = false; __ASKED = null;
  checkAdmin   = function(){ return globalThis.__ADMIN_OK; };
  payClockRead = function(st, sheet){ return sheet === 'managers' ? [{ key:'MGRKEY', name:'值班主管', active:'true' }] : []; };
  nowTaipeiIso = function(){ return '2026-10-12T10:00:00+08:00'; };
  payAnnualInfo = function(ym, st){ __ASKED = [ym, st];
    return { E01: { days: 7, quota_h: 56, used_h: 12, left_h: 44, ps: '2026-03-01', pe: '2027-03-01', payout_ym: '2027-02' },
             E02: { days: 3, quota_h: 24, used_h: 2.5, left_h: 21.5, ps: '2026-05-01', pe: '2026-11-01', payout_ym: '2026-10' },
             P01: null }; };
`, sb);
const call = (f, ...a) => vm.runInContext(f, sb)(...a);
const setAdmin = v => vm.runInContext('__ADMIN_OK = ' + (v ? 'true' : 'false'), sb);

let p = 0, f = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

console.log('══ 值班主管金鑰（營運系統代呼叫）══');
const a = call('handlePayrollAnnualLeft', { mgr_key: 'MGRKEY', store: 'SSLGF' });
chk('主管金鑰可通過', a.ok, true);
chk('預設本月', vm.runInContext('__ASKED', sb)[0], '2026-10');
chk('44 小時＝5.5 天', a.annual.E01.left_days, 5.5);
chk('21.5 小時＝2.7 天（一位小數）', a.annual.E02.left_days, 2.7);
chk('原始小時與週年期一起回', [a.annual.E01.left_h, a.annual.E01.pe], [44, '2027-03-01']);
chk('計時同仁 null', a.annual.P01, null);
chk('指定月份', (call('handlePayrollAnnualLeft', { mgr_key: 'MGRKEY', store: 'SSLGF', ym: '2026-11' }), vm.runInContext('__ASKED', sb)[0]), '2026-11');

console.log('\n══ 管理金鑰 ══');
setAdmin(true);
chk('管理金鑰可通過、不用主管金鑰', call('handlePayrollAnnualLeft', { admin_key: 'X', store: 'SSLGF' }).ok, true);
setAdmin(false);

console.log('\n══ 擋 ══');
chk('金鑰全空', call('handlePayrollAnnualLeft', { store: 'SSLGF' }).error, 'unauthorized');
chk('主管金鑰錯', call('handlePayrollAnnualLeft', { mgr_key: '亂打的', store: 'SSLGF' }).error, 'unauthorized');
vm.runInContext(`payClockRead = function(st, sheet){ return sheet === 'managers' ? [{ key:'MGRKEY', active:'false' }] : []; };`, sb);
chk('停用主管', call('handlePayrollAnnualLeft', { mgr_key: 'MGRKEY', store: 'SSLGF' }).error, 'unauthorized');
chk('假別下拉那支照樣擋停用主管（共用驗證沒改壞）', call('handlePayrollLeaveOptions', { mgr_key: 'MGRKEY', store: 'SSLGF' }).error, 'unauthorized');
chk('有掛進 PAYROLL_HANDLERS', typeof vm.runInContext('PAYROLL_HANDLERS.payroll_annual_left', sb), 'function');

console.log(f ? `\n❌ ${f} 項失敗（通過 ${p}）` : `\n✅ 剩餘特休端點全部正確 (${p}/${p})`);
process.exit(f ? 1 : 0);
