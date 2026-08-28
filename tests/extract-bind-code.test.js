/* 2026-08-28：LIFF 綁定畫面「啟用碼」輸入框改為也接受整條網址。
 *
 * 背景：店長在核定頁按「建立帳號」後拿到的是一整條網址
 * （https://eason0728.github.io/mala-clock-in/clock.html?k=Ab3xY7mK...），
 * 但他多半會把整條網址傳給同仁。同仁若要沿用舊流程只貼「啟用碼」，
 * 得自己從網址裡剪出 ?k= 後面那段——手機上很痛苦，於是大家都回頭問店長。
 *
 * extractBindCode() 就是要讓兩種貼法都能用：整條網址自動抽出 ?k= 的值，
 * 純金鑰原樣使用。這支測試直接從 clock.html 原始碼裡切出這支函式的真實本體
 * （不是重寫一份行為相同的替身）丟進 vm 執行，避免「測試測的是我以為它做的事，
 * 不是它真的做的事」這種假陽性。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// 用配對大括號取出 function 本體，跟 tests/liff-key-mode-isolation.test.js 的做法一致：
// 不依賴周圍註解文字，只依賴函式簽名與大括號結構。
function extractFunctionSource(src, fnName) {
  const needle = 'function ' + fnName + '(';
  const startIdx = src.indexOf(needle);
  if (startIdx === -1) throw new Error('clock.html 裡找不到 function ' + fnName + '() ——結構可能已經改了');
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('function ' + fnName + '() 大括號沒有配對成功，抓取範圍有誤');
  return src.slice(startIdx, i);
}

const clockSrc = fs.readFileSync(path.join(ROOT, 'clock.html'), 'utf8');
const extractBindCodeSrc = extractFunctionSource(clockSrc, 'extractBindCode');

function callExtractBindCode(input) {
  const sandbox = { input: input, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(extractBindCodeSrc + '\nresult = extractBindCode(input);', sandbox);
  return sandbox.result;
}

console.log('══ extractBindCode()：從 clock.html 切出真實函式本體丟進 vm 執行 ══');

const cases = [
  {
    name: '整條網址 → 抽出金鑰',
    input: 'https://eason0728.github.io/mala-clock-in/clock.html?k=Ab3xY7mK',
    expect: 'Ab3xY7mK',
  },
  {
    name: '網址含多個參數（k 在前）→ 抽對 k',
    input: 'https://eason0728.github.io/mala-clock-in/clock.html?k=abc&s=cf',
    expect: 'abc',
  },
  {
    name: '網址含多個參數（k 在後）→ 抽對 k',
    input: 'https://eason0728.github.io/mala-clock-in/clock.html?s=cf&k=abc',
    expect: 'abc',
  },
  {
    name: '純金鑰 → 原樣回傳',
    input: 'Ab3xY7mK',
    expect: 'Ab3xY7mK',
  },
  {
    name: '前後有空白 → trim 掉',
    input: '   Ab3xY7mK   ',
    expect: 'Ab3xY7mK',
  },
  {
    name: '空字串 → 回空字串',
    input: '',
    expect: '',
  },
  {
    name: 'null → 回空字串',
    input: null,
    expect: '',
  },
  {
    name: 'undefined → 回空字串',
    input: undefined,
    expect: '',
  },
  {
    name: '只有空白 → 回空字串',
    input: '   ',
    expect: '',
  },
  {
    name: '金鑰含 URL 編碼字元 → 正確解碼',
    // %2B → '+'，%2F → '/'：金鑰若剛好含這類字元，貼整條網址時會被瀏覽器/LINE 編碼過。
    input: 'https://eason0728.github.io/mala-clock-in/clock.html?k=Ab%2B3xY%2F7mK',
    expect: 'Ab+3xY/7mK',
  },
  {
    name: '網址參數前後有空白 → trim 整體，抽出的值不受影響',
    input: '  https://eason0728.github.io/mala-clock-in/clock.html?k=Ab3xY7mK  ',
    expect: 'Ab3xY7mK',
  },
];

let failCount = 0;
cases.forEach(function (c) {
  const actual = callExtractBindCode(c.input);
  try {
    assert.strictEqual(actual, c.expect);
    console.log('  ✓ ' + c.name + ' → ' + JSON.stringify(actual));
  } catch (e) {
    failCount++;
    console.error('  ✗ ' + c.name + '：預期 ' + JSON.stringify(c.expect) + '，實際 ' + JSON.stringify(actual));
  }
});

if (failCount > 0) {
  console.error('\n❌ extract-bind-code：' + failCount + ' 項失敗');
  process.exitCode = 1;
} else {
  console.log('\n✅ extract-bind-code 全部通過');
}
