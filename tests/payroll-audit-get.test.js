/* 薪酬管理「操作紀錄」唯讀端點 payroll_audit_get（2026-11-04）
 * 用 vm 載入真的 Code.gs＋Payroll.gs，只替換試算表讀寫；全部使用虛構門市與人名。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

const AUDIT = [
  { ts: '2026-10-05T11:40:00+08:00', ym: '2026-09', action: 'lock', operator: '人資甲（DZY900）（管理系統）', reason: '', store: 'CF' },
  { ts: '2026-11-03T10:12:00+08:00', ym: '2026-10', action: 'lock', operator: '人資甲（DZY900）（管理系統）', reason: '', store: 'SSLGF' },
  { ts: '2026-11-04T14:05:00+08:00', ym: '2026-10', action: 'unlock', operator: '人資甲（DZY900）（管理系統）', reason: '補登特休', store: 'SSLGF' },
  { ts: '2026-11-02T09:00:00+08:00', ym: '', action: 'holiday_sync', operator: 'auto', reason: '同步', store: '' },
  { ts: '2026-11-04T14:05:00+08:00', ym: '2026-10', action: 'lock', operator: 'Eason', reason: '', store: 'SSLGF' },   // 同秒：後寫的排前面
];

function run(body, rows, realAdmin) {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush() {}, openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-11-04T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return { text: t }; } }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__rows = JSON.parse(JSON.stringify(rows || AUDIT));
  sb.__body = JSON.parse(JSON.stringify(body));
  sb.__KEY = 'fake-admin-key';
  vm.runInContext((realAdmin ? 'CONFIG.ADMIN_KEY = __KEY;' : 'checkAdmin = function(){ return true; };') + `
    payRead = function(kind){ return kind === 'audit' ? JSON.parse(JSON.stringify(__rows)) : []; };
    payAppend = function(){ throw new Error('唯讀端點不該寫入'); };
    payReplaceAll = function(){ throw new Error('唯讀端點不該寫入'); };
    ensurePayrollSheets = function(){}; payInvalidate = function(){};`, sb);
  return JSON.parse(JSON.stringify(vm.runInContext('PAYROLL_HANDLERS.payroll_audit_get(__body)', sb)));
}

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`); };

let r = run({});
chk('不帶條件：全部 5 筆、新到舊、同秒後寫的在前', [r.ok, r.total, r.truncated, r.items.map(x => x.operator.slice(0, 3))], [true, 5, false, ['Eas', '人資甲', '人資甲', 'aut', '人資甲']]);
chk('欄位只有 ts／ym／action／operator／reason／store', Object.keys(r.items[0]), ['ts', 'ym', 'action', 'operator', 'reason', 'store']);
chk('operator 原樣回', r.items[1].operator, '人資甲（DZY900）（管理系統）');
chk('解鎖原因有帶', r.items[1].reason, '補登特休');

r = run({ ym: '2026-10' });
chk('ym 篩選：只剩 2026-10 的 3 筆', [r.total, r.items.map(x => x.action)], [3, ['lock', 'unlock', 'lock']]);
chk('ym 格式錯 → bad_ym', run({ ym: '2026-13' }).error, 'bad_ym');
chk('store 篩選（大小寫、空白不拘）', run({ store: ' cf ' }).items.map(x => x.store), ['CF']);
chk('limit 只取最新 2 筆、truncated＝true', (x => [x.items.length, x.total, x.truncated])(run({ limit: 2 })), [2, 5, true]);
chk('limit 亂填 → 當最大值', run({ limit: 'abc' }).items.length, 5);

console.log('\n══ 範圍 scope ══');
r = run({ scope: ['CF'] });
chk('scope=[CF]：只看到 CF，全域列（store 空白）看不到', [r.total, r.items.map(x => x.store)], [1, ['CF']]);
chk('scope=[CF,SSLGF]：4 筆、沒有全域列', [run({ scope: ['CF', 'SSLGF'] }).total, run({ scope: ['cf', 'sslgf'] }).items.some(x => x.store === '')], [4, false]);
chk('scope=[]：什麼都看不到', run({ scope: [] }).total, 0);
chk('scope=* ：全部含全域列', run({ scope: '*' }).total, 5);
chk('scope=[CF] 指定範圍外的 SSLGF → scope_forbidden（守門）', (() => {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush() {}, openById: () => null, getActive: () => null },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return { text: t }; } }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
  sb.__rows = JSON.parse(JSON.stringify(AUDIT));
  vm.runInContext(`checkAdmin = function(){ return true; }; payRead = function(){ return JSON.parse(JSON.stringify(__rows)); }; ensurePayrollSheets = function(){}; payInvalidate = function(){};`, sb);
  const g = (b) => { sb.__b = b; return JSON.parse(JSON.stringify(vm.runInContext('PAYROLL_HANDLERS.payroll_audit_get(__b)', sb))); };
  return [g({ scope: ['CF'], store: 'SSLGF' }).error, g({ scope: ['CF'], store: 'CF' }).total, g({ scope: ['CF'] }).total];
})(), ['scope_forbidden', 1, 1]);
chk('scope 格式錯 → scope_bad', (() => {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { flush() {}, openById: () => null, getActive: () => null },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return { text: t }; } }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
  vm.runInContext(`checkAdmin = function(){ return true; }; payRead = function(){ return []; }; ensurePayrollSheets = function(){}; payInvalidate = function(){};`, sb);
  return JSON.parse(JSON.stringify(vm.runInContext('PAYROLL_HANDLERS.payroll_audit_get({scope:"CF"})', sb))).error;
})(), 'scope_bad');

console.log('\n══ 驗證 ══');
chk('金鑰錯 → unauthorized', run({ admin_key: 'wrong' }, null, true).error, 'unauthorized');
chk('金鑰對 → ok', run({ admin_key: 'fake-admin-key' }, null, true).ok, true);
chk('ts 被 Sheets 轉成 Date 物件也能排序', (() => {
  const rows = [{ ts: new Date('2026-11-01T01:00:00Z'), ym: '', action: 'a', operator: 'x', reason: '', store: 'CF' },
                { ts: '2026-11-03T01:00:00+08:00', ym: '', action: 'b', operator: 'x', reason: '', store: 'CF' }];
  return run({}, rows).items.map(x => x.action);
})(), ['b', 'a']);

console.log(`\n${fail ? '❌' : '✅'} ${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
