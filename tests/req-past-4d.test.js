// 2026-11-14 Eason：請假（含補休）／加班／出差補申請期限 7 天 → 4 天，超過由店長代開；
// T01（11/1–11/28）先不限：今天在 11/28（含）以前，11/1 起的日子都能自己補；11/29 起一律 4 天（T01 的日子也一樣）。忘打卡維持 7 天。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function grabVar(name) { const m = src.match(new RegExp('var ' + name + ' = [^;]+;')); if (!m) throw new Error('找不到 ' + name); return m[0]; }
const sb = {};
vm.createContext(sb);
vm.runInContext(['REQ_LEAVE_PAST_DAYS', 'REQ_FUTURE_DAYS', 'REQ_MISS_DAYS', 'REQ_PAST_OPEN_FROM_', 'REQ_PAST_OPEN_TO_'].map(grabVar).join('\n') + '\n' +
  ['reqDayDiff_', 'reqPastLimit_', 'reqPastCheck_'].map(grab).join('\n'), sb);

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const chk = (date, today, proxy) => sb.reqPastCheck_('請假', date, today, !!proxy);

ok('常數：4 天、T01 11/1–11/28、忘打卡也 4 天', () => {
  assert.strictEqual(vm.runInContext('REQ_LEAVE_PAST_DAYS', sb), 4);
  assert.strictEqual(vm.runInContext('REQ_PAST_OPEN_FROM_', sb), '2026-11-01');
  assert.strictEqual(vm.runInContext('REQ_PAST_OPEN_TO_', sb), '2026-11-28');
  assert.strictEqual(vm.runInContext('REQ_MISS_DAYS', sb), 4);
});
ok('11/14：11/1 起都能自己補（含 13 天前）；10/31 以前照 4 天擋', () => {
  assert.strictEqual(chk('2026-11-01', '2026-11-14'), null);
  assert.strictEqual(chk('2026-11-07', '2026-11-14'), null);
  assert.strictEqual(chk('2026-10-31', '2026-11-14').error, 'too_old');
});
ok('11/28（T01 最後一天）：11/1 仍可', () => {
  assert.strictEqual(chk('2026-11-01', '2026-11-28'), null);
  assert.strictEqual(sb.reqPastLimit_('2026-11-01', '2026-11-28'), 27);
});
ok('11/29（T02 第一天）起 4 天：11/25 可、11/24 擋（T01 的日子也擋）', () => {
  assert.strictEqual(chk('2026-11-25', '2026-11-29'), null);
  const e = chk('2026-11-24', '2026-11-29');
  assert.strictEqual(e.error, 'too_old');
  assert.strictEqual(e.message, '超過 4 天不能自己申請請假，請店長代開');
  assert.strictEqual(chk('2026-11-01', '2026-11-29').error, 'too_old');
});
ok('12/10：12/6 可、12/5 擋；代開（proxy）不看幾天前', () => {
  assert.strictEqual(chk('2026-12-06', '2026-12-10'), null);
  assert.strictEqual(chk('2026-12-05', '2026-12-10').error, 'too_old');
  assert.strictEqual(chk('2026-12-05', '2026-12-10', true), null);
});
ok('未來最遠 90 天，代開也一樣', () => {
  assert.strictEqual(chk('2027-03-10', '2026-12-10'), null);
  const e = chk('2027-03-11', '2026-12-10', true);
  assert.strictEqual(e.error, 'bad_date');
  assert.strictEqual(e.message, '請假最遠只能申請到 90 天後');
});
ok('代開的「幾天內請同仁自己申請」門檻跟著同一支：11/14 的 11/3＝13 天內；12/10 的 12/5＝超過 4 天', () => {
  assert(sb.reqDayDiff_('2026-11-03', '2026-11-14') >= -sb.reqPastLimit_('2026-11-03', '2026-11-14'));
  assert(sb.reqDayDiff_('2026-12-05', '2026-12-10') < -sb.reqPastLimit_('2026-12-05', '2026-12-10'));
});
ok('忘打卡同一套（2026-11-14 追加）：11/14 補 11/1 可、11/29 起 4 天（11/25 可、11/24 擋）、12/10 補 12/6 可 12/5 擋', () => {
  const M = vm.runInContext('REQ_MISS_DAYS', sb);
  const can = (d, t) => sb.reqDayDiff_(d, t) >= -sb.reqPastLimit_(d, t, M);
  assert.deepStrictEqual([can('2026-11-01', '2026-11-14'), can('2026-10-31', '2026-11-14'), can('2026-11-01', '2026-11-28')], [true, false, true]);
  assert.deepStrictEqual([can('2026-11-25', '2026-11-29'), can('2026-11-24', '2026-11-29')], [true, false]);
  assert.deepStrictEqual([can('2026-12-06', '2026-12-10'), can('2026-12-05', '2026-12-10')], [true, false]);
});
console.log('\n' + n + ' 項全部通過');
