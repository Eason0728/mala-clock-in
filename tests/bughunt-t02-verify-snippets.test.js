/* T02（2026-11-10 挑錯）：部署前檢查 tools/verify-store-backends.py 會逐店比對「必須有的函式、動作、精確片段」。
 * 2026-11-10 改版後，其中一個片段在 repo 的 Code.gs 已經不存在，結果線上九家店全部報 ✗——檢查本身過期，等於沒有檢查。
 * 這支守的是：檢查工具列的每一項，repo 自己的 apps-script/Code.gs 都要找得到（找不到＝工具過期，不是店有問題）。 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const tool = fs.readFileSync(path.join(ROOT, 'tools/verify-store-backends.py'), 'utf8');
const code = fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8');
let fail = 0;
const chk = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : ' ' + extra)); };

// Python 字串清單：ACTIONS = [...]、FUNCS = [...]
function pyList(name) {
  const m = new RegExp('^' + name + ' = \\[([\\s\\S]*?)\\]', 'm').exec(tool);
  if (!m) throw new Error('找不到 ' + name);
  return (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}
// EXACT = { '說明': "片段" 或 '片段', ... }
function pyExact() {
  const m = /^EXACT = \{([\s\S]*?)^\}/m.exec(tool);
  if (!m) throw new Error('找不到 EXACT');
  const out = [];
  m[1].split('\n').forEach((line) => {
    const x = /^\s*'([^']+)':\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(line);
    if (x) out.push([x[1], (x[2] !== undefined ? x[2] : x[3]).replace(/\\(['"\\])/g, '$1')]);
  });
  return out;
}
const actions = pyList('ACTIONS'), funcs = pyList('FUNCS'), exact = pyExact();
chk('讀得到檢查清單（動作 ' + actions.length + '、函式 ' + funcs.length + '、片段 ' + exact.length + '）', actions.length >= 10 && funcs.length >= 10 && exact.length >= 10);
const missA = actions.filter((a) => !new RegExp('^\\s*' + a + ':', 'm').test(code));
const missF = funcs.filter((f) => code.indexOf('function ' + f) === -1);
const missE = exact.filter((e) => code.indexOf(e[1]) === -1).map((e) => e[0]);
chk('檢查工具列的每個動作，repo 的 Code.gs 都有', missA.length === 0, '缺：' + missA.join('、'));
chk('檢查工具列的每個函式，repo 的 Code.gs 都有', missF.length === 0, '缺：' + missF.join('、'));
chk('檢查工具列的每個精確片段，repo 的 Code.gs 都有', missE.length === 0, '缺：' + missE.join('、'));
// B01 的修正也要列入檢查，否則哪一家沒套到不會被發現
chk('檢查工具有列 B01 的函式 breakBlocksFor_', funcs.indexOf('breakBlocksFor_') !== -1);
chk('檢查工具有列「核定狀態改用 breakBlocksFor_」的片段', exact.some((e) => e[1].indexOf('breakBlocksFor_(sortedP, punchSegments') !== -1));
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
