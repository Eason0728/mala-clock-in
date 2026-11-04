/* 薪酬頁「操作紀錄」分頁（2026-11-04）：選單、面板、呼叫形狀、Excel 公式防護。純靜態檢查＋抽函式實跑，全部虛構資料。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n); };

ok('選單有 data-p="oplog" 按鈕', /<button data-p="oplog">/.test(H));
ok('有 p-oplog 面板', /<section class="panel" id="p-oplog">/.test(H));
ok('data-p 符合管理系統 nav 規則 ^[a-z]{1,12}$', /^[a-z]{1,12}$/.test('oplog'));
ok('切到分頁時載入', /b\.dataset\.p==='oplog'\) loadOplog\(\)/.test(H));
ok('呼叫 payroll_audit_get 並明講 store 空白（不被補成目前門市）', /post\('payroll_audit_get',month\?\{ym:month,store:''\}:\{store:''\}/.test(H));

// 抽純函式實跑：動作名稱、Excel 儲存格防公式
const grab = (re) => { const m = re.exec(H); if (!m) throw new Error('抽不到 ' + re); return m[0]; };
const code = [grab(/const OPLOG_ACT=\{[\s\S]*?\};/), grab(/const oplogActName=.*?;/), grab(/const oplogCell=.*?;\n/)].join('\n');
const sb = {}; vm.createContext(sb); vm.runInContext(code + '\nthis.act=oplogActName; this.cell=oplogCell;', sb);
ok('lock → 薪資定案、unlock → 解鎖', sb.act('lock') === '薪資定案' && sb.act('unlock') === '解鎖');
ok('不認得的動作原樣顯示', sb.act('zzz') === 'zzz');
ok('Excel 儲存格：= + - @ 開頭補單引號', ['=1+1', '+A1', '-B2', '@SUM(1)'].every(t => sb.cell(t) === "'" + t));
ok('Excel 儲存格：一般文字、空值不動', sb.cell('補登特休') === '補登特休' && sb.cell(null) === '');
ok('表格渲染都過 esc（操作人、原因）', /esc\(x\.operator\)/.test(H) && /esc\(x\.reason\)/.test(H));

console.log(`\n${fail ? '❌' : '✅'} ${pass} 項通過${fail ? '，' + fail + ' 項失敗' : ''}`);
process.exit(fail ? 1 : 0);
