/* 打卡頁「開頁只問 mini」每店開關（clock-line.html ST_ONLY_MINI）的上線設定檢查（2026-11-23）。
 * 開關的 key 是 STORES 的店碼（小辛辣光復＝空字串 ""），寫錯店碼＝那家店沒開、或開到別家，畫面上看不出來，所以用測試鎖住：
 *  (1) ST_ONLY_MINI 每個 key 都是 STORES 裡真的店碼；
 *  (2) 開的剛好是七家 mini 核定店（小辛辣光復、央廚、總部、墨竹亭金山／光復／六張犁／美村），瑞光 mztrg、文心 mztwx 不開；
 *  (3) 七家的值都是 EXPECT（這一版要上的值），用頁面自己的 stOnlyMini() 算（非本機網址、沒有 ?st_only）。
 * 跑法：node tests/st-only-mini-switch.test.js（不用瀏覽器）。 */
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'clock-line.html'), 'utf8');

const EXPECT = true;   // 這一版七家店的值："cmp"（試跑比對）或 true（只問 mini）
const SEVEN = ['', 'cf', 'hq', 'mztjs', 'mztgf', 'mztlzl', 'mztmc'];
const OFF = ['mztrg', 'mztwx'];

function cut(startRe, endRe) {
  const a = html.search(startRe);
  assert(a >= 0, '找不到 ' + startRe);
  const rest = html.slice(a), b = rest.search(endRe);
  assert(b >= 0, '找不到結尾 ' + endRe);
  return rest.slice(0, b);
}
// 開關＋判斷函式（var ST_ONLY_MINI … function stOnlyMini(){…}）與 STORES 區塊，照原文在沙盒裡跑
const sw = cut(/  var ST_ONLY_MINI = /, /  \/\* STORES:BEGIN/);
const stores = cut(/  var STORES = \[/, /  \/\* STORES:END \*\//);
const sb = { isLocalHost: false, qs: function () { return null; } };
vm.createContext(sb);
vm.runInContext(sw + '\n' + stores + '\nthis.__t = { ST_ONLY_MINI: ST_ONLY_MINI, STORES: STORES, stOnlyMini: stOnlyMini };', sb, { filename: 'clock-line.html' });
const T = sb.__t;
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const codes = T.STORES.map((s) => s.code);
ok('STORES 有九家、小辛辣光復的店碼是空字串', () => {
  assert.strictEqual(codes.length, 9);
  assert(codes.indexOf('') >= 0);
  SEVEN.concat(OFF).forEach((c) => assert(codes.indexOf(c) >= 0, '店碼不在 STORES：' + JSON.stringify(c)));
});
ok('ST_ONLY_MINI 每個 key 都是 STORES 裡的店碼（沒有拼錯、沒有 "gf"、沒有 "*"）', () => {
  Object.keys(T.ST_ONLY_MINI).forEach((k) => assert(codes.indexOf(k) >= 0, '不是店碼：' + JSON.stringify(k)));
});
ok('開的剛好是七家 mini 核定店', () => {
  assert.deepStrictEqual(Object.keys(T.ST_ONLY_MINI).sort(), SEVEN.slice().sort());
});
ok('七家店用頁面的 stOnlyMini() 算出來都是 ' + JSON.stringify(EXPECT), () => {
  T.STORES.filter((s) => SEVEN.indexOf(s.code) >= 0).forEach((s) => assert.strictEqual(T.stOnlyMini(s), EXPECT, s.name));
});
ok('瑞光、文心維持 false（＝現在：同時問 mini 與 Google）', () => {
  T.STORES.filter((s) => OFF.indexOf(s.code) >= 0).forEach((s) => assert.strictEqual(T.stOnlyMini(s), false, s.name));
});
console.log(n + ' 項通過');
