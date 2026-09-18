/* 頁面上每個按鈕／欄位呼叫的函式都必須存在（2026-09-19 補）
 *
 * 事故：2026-09-18 改紅字天數時，整段取代 payroll.html「紅字天數」到「薪資單」兩個標記之間的程式，
 * 把剛好夾在中間、與紅字天數無關的 saveCfg 一起刪掉 → 參數設定四顆儲存按鈕全部報錯
 * （saveCfg is not defined）。語法檢查、25 支測試全都抓不到，因為那是按下去才會執行的程式。
 *
 * 做法：掃每個頁面所有 on*="…" 裡呼叫的函式名（含 JS 字串裡動態產生的按鈕），
 * 逐一確認同一個檔案裡有定義。瀏覽器內建的名字列在 BUILTIN。
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const BUILTIN = new Set(['if', 'for', 'while', 'switch', 'return', 'try', 'catch', 'function', 'typeof', 'new',
  'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'parseInt', 'parseFloat', 'isNaN',
  'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout', 'encodeURIComponent', 'decodeURIComponent',
  'fetch', 'open', 'print', 'event', 'history', 'location']);

const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
let pass = 0, fail = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const called = new Set();
  for (const m of src.matchAll(/\son[a-z]+="([^"]*)"/g)) {
    for (const c of m[1].matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(c[2]);
  }
  const missing = [...called].filter(name => !BUILTIN.has(name) && !new RegExp(
    `(function\\s+${name.replace(/\$/g, '\\$')}\\b|(const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=|[\\s;,]${name.replace(/\$/g, '\\$')}\\s*=\\s*(async\\s*)?(function|\\())`
  ).test(src));
  const ok = missing.length === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${f}：按鈕呼叫 ${called.size} 個函式${ok ? '，全部都有定義' : '，找不到：' + missing.join('、')}`);
}

/* 點名：參數設定四顆儲存按鈕 */
const P = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const saves = (P.match(/onclick="saveCfg\(this,/g) || []).length;
const ok2 = saves === 4 && /async function saveCfg\(/.test(P);
ok2 ? pass++ : fail++;
console.log(`${ok2 ? '✓' : '✗'} payroll.html：參數設定 ${saves} 顆儲存按鈕都接到 saveCfg`);

console.log(`\n${fail ? '❌ 有失敗' : '✅ 頁面按鈕呼叫的函式都存在'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
