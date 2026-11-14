/* 期限欄看起來空白、其實藏了非數字（2026-11-14）。
 * 起因：值班核定對沒設期限的喪假跳「有期限規定，但還沒登記事件日」——假別表期限格看起來是空的，
 * 但只要格子裡有空格、「—」這類非數字，舊讀法 payNum() 會變成 0＝「期限 0 天」。
 * 這支守：讀、存、payLeaveWindow、manager.html／payroll.html 的前端判斷都把它當「沒設期限」。 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const P = fs.readFileSync(ROOT + '/apps-script/Payroll.gs', 'utf8');

const sb = { console, SpreadsheetApp: {}, Utilities: {}, Logger: { log() {} }, PropertiesService: {}, LockService: {} };
vm.createContext(sb); vm.runInContext(P, sb);
vm.runInContext(`
  payRead = function(k){ return (globalThis.__S[k]||[]).map(function(r){var c={};for(var i in r)c[i]=r[i];return c;}); };
  payReplaceAll = function(k, rows){ globalThis.__S[k] = rows; };
  payAppend = function(){}; checkAdmin = function(){ return true; }; nowTaipeiIso = function(){ return 'T'; };
`, sb);
const call = (f, ...a) => vm.runInContext(f, sb)(...a);

let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

// 1. payWinNum_ 本身
chk('空白 → null', call('payWinNum_', ''), null);
chk('一個空格 → null', call('payWinNum_', ' '), null);
chk('「—」→ null', call('payWinNum_', '—'), null);
chk('字串 null → null', call('payWinNum_', 'null'), null);
chk('0 天期限 → null', call('payWinNum_', 0), null);
chk('負數 → null', call('payWinNum_', -3), null);
chk('90 → 90', call('payWinNum_', 90), 90);
chk('字串 " 90 " → 90', call('payWinNum_', ' 90 '), 90);
chk('事件前 0 天（allowZero）→ 0', call('payWinNum_', 0, true), 0);

// 2. 從試算表讀：喪假期限格藏空格／「—」／0，婚假正常
const base = call('payLeaveTypes', 'MZTGF').map(t => {
  const o = {}; for (const k in t) o[k] = t[k] == null ? '' : t[k]; o.store = ''; o.active = 'true'; return o; });
const row = c => base.find(x => x.code === c);
row('funeral6').window_days = ' ';
row('funeral8').window_days = '—'; row('funeral8').window_max = 'null';
row('funeral3').window_days = 0;
sb.__S = { leave_type: base };
const got = call('payLeaveTypes', 'MZTGF'), g = c => got.find(x => x.code === c);
chk('喪假（祖父母…）期限讀成 null', g('funeral6').window_days, null);
chk('喪假（父母…）期限與可延至讀成 null', [g('funeral8').window_days, g('funeral8').window_max], [null, null]);
chk('喪假（曾祖父母…）期限 0 讀成 null', g('funeral3').window_days, null);
chk('婚假期限照舊', [g('marriage').window_before, g('marriage').window_days, g('marriage').window_max], [10, 90, 365]);

// 3. 後端期限檢查：沒設期限＝不需要事件日
chk('payLeaveWindow 喪假＝沒有期限', call('payLeaveWindow', g('funeral6'), '').has, false);
chk('payLeaveWindow 期限 0（舊資料直接進來）＝沒有期限', call('payLeaveWindow', { window_days: 0 }, '').has, false);
chk('payLeaveWindow 婚假沒事件日＝要登記', call('payLeaveWindow', g('marriage'), '').need_event, true);

// 4. 存檔順手清乾淨
const res = call('handlePayrollLeaveTypeSet', { admin_key: 'x', store: '', types: base });
chk('存檔成功', !!res.ok, true);
const saved = sb.__S.leave_type, sv = c => saved.find(x => x.code === c);
chk('存回去的喪假期限格是真正空白', [sv('funeral6').window_days, sv('funeral8').window_days, sv('funeral8').window_max, sv('funeral3').window_days], ['', '', '', '']);
chk('存回去的婚假期限照舊', [sv('marriage').window_before, sv('marriage').window_days, sv('marriage').window_max], [10, 90, 365]);

// 5. 值班核定頁（manager.html）的 windowCheck：抽出本體實跑
const M = fs.readFileSync(ROOT + '/manager.html', 'utf8');
const a = M.indexOf('  function shiftDay('), b = M.indexOf('\n  }\n', M.indexOf('  function windowCheck(')) + 4;
if (a < 0 || b < 4) { console.log('✗ manager.html 找不到 shiftDay／windowCheck'); process.exit(1); }
const ctx = { LEAVE_OPTS: { events: {} } }; vm.createContext(ctx);
vm.runInContext(M.slice(a, b) + '\nthis.windowCheck = windowCheck;', ctx);
const wc = d => JSON.stringify(ctx.windowCheck(d, 'E1', '2026-11-03'));
chk('manager 喪假期限 null 不提示', wc({ name: '喪假', code: 'funeral6', window_days: null }), '{"ok":true}');
chk('manager 期限 0 不提示', wc({ name: '喪假', code: 'funeral6', window_days: 0 }), '{"ok":true}');
chk('manager 期限 " " 不提示', wc({ name: '喪假', code: 'funeral6', window_days: ' ' }), '{"ok":true}');
chk('manager 婚假沒事件日仍提示', ctx.windowCheck({ name: '婚假', code: 'marriage', window_days: 90 }, 'E1', '2026-11-03').note ? 1 : 0, 1);

// 6. 薪資頁「假別事件日」下拉只列真的有期限的假
const PH = fs.readFileSync(ROOT + '/payroll.html', 'utf8');
const line = PH.split('\n').find(l => l.startsWith('function leaveTypesWithWindow('));
const c2 = { LT_LIST: [{ code: 'marriage', window_days: 90 }, { code: 'funeral6', window_days: ' ' }, { code: 'funeral3', window_days: 0 }, { code: 'sick', window_days: null }] };
vm.createContext(c2); vm.runInContext(line + '\nthis.r = leaveTypesWithWindow().map(t=>t.code);', c2);
chk('事件日下拉只有婚假', c2.r, ['marriage']);

console.log(`\n${f ? '❌ 有失敗' : '✅ 期限欄空白判斷全部正確'} (${p}/${p + f})`);
process.exit(f ? 1 : 0);
