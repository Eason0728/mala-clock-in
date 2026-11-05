// 連續工作 4 小時要休 30 分（2026-11-06 Eason）：manager.html contBreakWarn（核定頁黃字、不擋）。
// 營運系統 calc.js 同一套規則（那邊有自己的測試）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
function extract(name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const sb = {}; vm.createContext(sb);
vm.runInContext(src.match(/var CONT_MAX_MIN = .*?;/)[0] + '\n' + ['hhmmToMin', 'contBreakWarn', 'contBreakText'].map(extract).join('\n'), sb);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const W = (...ps) => JSON.parse(JSON.stringify(sb.contBreakWarn(ps.map(([start, end]) => ({ start, end })))));

ok('剛好 4 小時不提醒；4.5 小時一段提醒', () => {
  assert.strictEqual(W(['08:00', '12:00']), null);
  assert.deepStrictEqual(W(['08:00', '12:30']), { start: '08:00', end: '12:30', h: 4.5 });
});
ok('中間休滿 30 分不提醒；休不到 30 分當接著上', () => {
  assert.strictEqual(W(['08:00', '12:00'], ['12:30', '16:30']), null);
  assert.deepStrictEqual(W(['08:00', '12:00'], ['12:20', '15:00']), { start: '08:00', end: '15:00', h: 7 });
});
ok('時段順序亂填也照時間排；第二塊才超過也抓得到', () => {
  assert.deepStrictEqual(W(['13:00', '18:00'], ['08:00', '12:00']), { start: '13:00', end: '18:00', h: 5 });
});
ok('跨夜 22:00–03:00 算 5 小時；空白列略過', () => {
  assert.deepStrictEqual(W(['22:00', '03:00']), { start: '22:00', end: '03:00', h: 5 });
  assert.strictEqual(W(['', ''], ['09:00', '12:00']), null);
});
ok('提醒字句', () => {
  assert.strictEqual(sb.contBreakText({ start: '08:00', end: '12:30', h: 4.5 }), '連續上班 4.5 小時沒休息 30 分鐘（08:00–12:30；每 4 小時要休 30 分，提醒不擋）');
});
console.log('\n' + n + ' 項全過');
