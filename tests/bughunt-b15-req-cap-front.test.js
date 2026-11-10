/* B15（2026-11-10 挑錯）：申請頁（req-line.js）請家庭照顧假，時數超過今年剩下的額度時，
 * 送出前的檢查用到一個只在別的函式裡宣告的小工具（r1）→ 程式當場出錯（r1 is not defined）。
 * 出錯的位置在「送出中」的忙碌旗標已經立起來之後，旗標沒有放掉：畫面停在「送出中…」、按鈕一直是灰的，只能關掉重開。
 * 修正：r1 搬到整個檔案共用的位置；送出按鈕組資料那一步就算出錯，也會放掉旗標、把原因顯示出來。
 * 做法：整檔載入真的 req-line.js（只在檔尾多掛一個測試用的出口），用最小的假畫面元件觸發按鈕。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'req-line.js'), 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const hooked = src.replace(TAIL, TAIL + ' window.__t = { capLocked: capLocked, submitBtn: submitBtn, st: st, setE: function (e) { E = e; } };');

/* 最小的假畫面元件：只記錄子元素、文字、事件 */
function el(tag) {
  const e = { tag: tag, children: [], attrs: {}, listeners: {}, textContent: '', disabled: false,
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, fn) { this.listeners[ev] = fn; } };
  Object.defineProperty(e, 'innerHTML', { set() { e.children = []; }, get() { return ''; } });
  return e;
}
const textOf = (e) => (e.textContent || '') + (e.children || []).map(textOf).join('');
const sb = { window: {}, document: { createElement: el, createTextNode: (t) => ({ textContent: String(t), children: [] }) },
  console, Promise, setTimeout, clearTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
  liff: { getIDToken: () => 'TOK', isInClient: () => false }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
sb.window.window = sb.window;
vm.createContext(sb);
vm.runInContext(hooked, sb, { filename: 'req-line.js' });
const t = sb.window.__t;

let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     實際=' + JSON.stringify(got) + '\n     預期=' + JSON.stringify(want))); };
const tryCall = (fn) => { try { return fn(); } catch (e) { return '出錯：' + e.message; } };

/* ── 一、額度檢查本身 ── */
t.st.init = { quota: [{ name: '家庭照顧假', cap_h: 56, remain_h: 8 }, { name: '生理假', cap_h: 24, remain_h: 0 }] };
chk('家庭照顧假剩 8 小時、請 9 小時 → 回一句話（不是程式出錯）', tryCall(() => t.capLocked('家庭照顧假', 9)), '家庭照顧假今年 7 天只剩 8 小時，這次超過了，不能送出');
chk('家庭照顧假剩 8 小時、請 8 小時 → 可以送', tryCall(() => t.capLocked('家庭照顧假', 8)), '');
t.st.init = { quota: [{ name: '家庭照顧假', cap_h: 56, remain_h: 3.75 }] };
chk('剩 3.75 小時、請 4 小時 → 訊息裡的時數取到小數一位', tryCall(() => t.capLocked('家庭照顧假', 4)), '家庭照顧假今年 7 天只剩 3.8 小時，這次超過了，不能送出');
t.st.init = { quota: [{ name: '生理假', cap_h: 24, remain_h: 0 }] };
chk('生理假用完 → 回一句話', tryCall(() => t.capLocked('生理假', 8)), '生理假今年 3 次已經用完，不能再申請');
chk('事假不在這條規則', tryCall(() => t.capLocked('事假', 8)), '');

/* ── 二、送出按鈕：組資料那一步就算出錯，也要放掉忙碌旗標 ── */
(async () => {
  const out = el('div');
  let posted = 0;
  t.setE({ post: () => { posted++; return Promise.resolve({ ok: true, summary: 'x' }); }, storeApi: () => 'x' });
  t.st.busy = false;
  const btn = t.submitBtn(out, function () { throw new Error('組資料時出錯'); }, function () {});
  const r = tryCall(() => btn.listeners.click());
  await new Promise((res) => setTimeout(res, 20));
  chk('按送出、組資料那一步出錯：不會把錯誤丟出去', typeof r === 'string' && r.indexOf('出錯') === 0 ? r : 'ok', 'ok');
  chk('忙碌旗標有放掉、按鈕可以再按', [t.st.busy, btn.disabled], [false, false]);
  chk('畫面上看得到原因、沒有停在「送出中…」', [textOf(out).indexOf('組資料時出錯') >= 0, textOf(out).indexOf('送出中') >= 0], [true, false]);
  chk('沒有送出任何請求', posted, 0);
  // 對照：組資料回的是被拒絕的 Promise（原本就有處理）
  t.st.busy = false;
  const out2 = el('div');
  const btn2 = t.submitBtn(out2, function () { return Promise.reject(new Error('請選原因')); }, function () {});
  btn2.listeners.click();
  await new Promise((res) => setTimeout(res, 20));
  chk('對照：組資料回「請選原因」→ 旗標放掉、畫面顯示原因', [t.st.busy, btn2.disabled, textOf(out2).indexOf('請選原因') >= 0], [false, false, true]);
  if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
  console.log('全部通過');
})();
