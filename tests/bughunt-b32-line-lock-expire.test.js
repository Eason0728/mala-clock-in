/* B32（2026-11-10 挑錯）：LINE 打卡頁（clock-line.html）打完卡 10 分鐘內兩顆都鎖，之後兩顆都能按（按同一顆先跳確認框）。
 * 但畫面如果是在那 10 分鐘內打開的（或就是在這頁打的卡），時間到了只有另一顆解開，同一型那顆一直是灰的——
 * 開頁時後端給的 guard.blocked（＝同型）畫面一直留著。後端這時是收的。
 * 修正：有鎖定時間（guard.lock）的時候，鍵能不能按只看時間到了沒；blocked 只在沒有鎖定時間的舊格式才用。
 * 做法：從真的 clock-line.html 取出 refreshButtons 來跑。
 * 2026-11-20：refreshButtons 結尾會呼叫 applyPunchHint（打卡防呆 B：依上一筆提示按鍵），
 * 所以 PUNCH_GUARD 區塊（pgLastLabel／pgNextType 等）和 applyPunchHint 也從真檔取出、一起放進沙盒。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'clock-line.html'), 'utf8');
function extract(name) {
  const a = SRC.indexOf('  function ' + name + '(');
  if (a < 0) throw new Error('clock-line.html 找不到 ' + name);
  let i = SRC.indexOf('{', a), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
  return SRC.slice(a, i + 1);
}
function extractGuardBlock() {   // PUNCH_GUARD:BEGIN … PUNCH_GUARD:END（純函式，clock.html 與 clock-line.html 一字不差）
  const a = SRC.indexOf('PUNCH_GUARD:BEGIN'), b = SRC.indexOf('PUNCH_GUARD:END');
  if (a < 0 || b < 0) throw new Error('clock-line.html 找不到 PUNCH_GUARD 區塊');
  return SRC.slice(a, SRC.lastIndexOf('/*', b));   // 起頭少了 /*（呼叫端補）、結尾去掉 END 那行的 /*
}
let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     實際=' + JSON.stringify(got) + '\n     預期=' + JSON.stringify(want))); };

const T0 = Date.parse('2026-11-10T08:55:00+08:00');   // 08:55 打上班卡
function buttons(nowMs, guard) {
  const cl = () => ({ toggle() {} });
  const els = { btnIn: { disabled: false, textContent: '', classList: cl() }, btnOut: { disabled: false, textContent: '', classList: cl() }, msg: { textContent: '' }, pgLast: { hidden: true, textContent: '' } };
  class FD extends Date { constructor(...a) { if (a.length) super(...a); else super(nowMs); } static now() { return nowMs; } }
  const sb = { Date: FD, Math, String, $: (id) => els[id], status: { status: 'ready', guard: guard, rest: null }, busy: false, clockSkew: 0,
    restBlocked: () => false, capBlocked: () => false, hmOf: (x) => String(x), say: () => {} };
  vm.createContext(sb);
  vm.runInContext('/*' + extractGuardBlock() + '\n' + extract('applyPunchHint') + '\n' + extract('refreshButtons') + '\nrefreshButtons();', sb);
  return [els.btnIn.disabled, els.btnIn.textContent, els.btnOut.disabled, els.btnOut.textContent];
}
const G = { blocked: 'in', lock: { in: T0 + 600000, out: T0 + 600000 }, last: { type: 'in', hm: '08:55' } };   // 開頁時（鎖定中）後端給的

chk('09:00（鎖定中）：兩顆都鎖，顯示還有幾分鐘', buttons(T0 + 5 * 60000, G), [true, '上班（5 分後）', true, '下班（5 分後）']);
chk('09:04:59（還差 1 秒）：兩顆都鎖', buttons(T0 + 600000 - 1000, G).filter((x, i) => i % 2 === 0), [true, true]);
chk('09:05（剛滿 10 分鐘，畫面沒重開）：兩顆都能按', buttons(T0 + 600000, G), [false, '上班', false, '下班']);
chk('12:00（3 小時後，畫面沒重開）：兩顆都能按', buttons(T0 + 3 * 3600000, G), [false, '上班', false, '下班']);
chk('在這頁打的卡（就地鎖鍵的寫法相同）：滿 10 分鐘後兩顆都能按', buttons(T0 + 600000 + 1, { blocked: 'in', lock: { in: T0 + 600000, out: T0 + 600000 }, last: { type: 'in', hm: '08:55' }, now: T0 }), [false, '上班', false, '下班']);
chk('過了 10 分鐘才開頁（後端給 blocked:null）：兩顆都能按', buttons(T0 + 20 * 60000, { blocked: null, lock: { in: T0 + 600000, out: T0 + 600000 }, last: { type: 'in', hm: '08:55' } }), [false, '上班', false, '下班']);
chk('舊格式（只有 blocked、沒有鎖定時間）：照舊鎖同型那顆', buttons(T0 + 3 * 3600000, { blocked: 'in', last: { type: 'in', hm: '08:55' } }), [true, '上班', false, '下班']);
chk('今天還沒打卡：兩顆都能按', buttons(T0, { blocked: null, lock: {}, last: null }), [false, '上班', false, '下班']);
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
