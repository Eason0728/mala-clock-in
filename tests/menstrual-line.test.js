/* LINE 申請頁（req-line.js）生理假新規則（2026-11-18）：額度用「次」顯示、送出前先擋（計時、8 小時、第 4 次、每月一次）、
 * 後端緊急開關 off（req_info.seg2_no_types 帶生理假）時回到原本的「剩 0 小時就擋」；生理假可以加第二段。
 * 做法同 bughunt-b15：整檔載入真的 req-line.js，檔尾多掛測試出口。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'req-line.js'), 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const hooked = src.replace(TAIL, TAIL + ' window.__t = { capLocked: capLocked, quotaText: quotaText, seg2Ok: seg2Ok, st: st };');
const sb = { window: {}, document: { createElement: () => ({}), createTextNode: () => ({}) }, console, Promise, setTimeout, clearTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, liff: { getIDToken: () => 'TOK', isInClient: () => false }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
sb.window.window = sb.window;
vm.createContext(sb); vm.runInContext(hooked, sb, { filename: 'req-line.js' });
const t = sb.window.__t;
const yr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 4);   // 頁面的「今年」
const Q = (dates) => ({ name: '生理假', cap_days: 3, cap_h: 24, remain_h: 24 - dates.length * 8, used_h: dates.length * 8, used_n: dates.length, dates: dates, unit: 'times' });
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const PHRASE = '已超過年度三次上限，請改辦理病假';
ok('額度用「次」顯示：剩 1 次／3 次已用完；舊後端（只有小時）換算成次', () => {
  t.st.init = { quota: [Q([yr + '-07-02', yr + '-08-05'])] };
  assert.strictEqual(t.quotaText('生理假'), '剩 1 次（每年 3 次、每月一次，一天不管請幾小時都算一次，最多 8 小時）');
  t.st.init = { quota: [Q([yr + '-07-02', yr + '-08-05', yr + '-09-03'])] };
  assert.ok(/^3 次已用完/.test(t.quotaText('生理假')));
  t.st.init = { quota: [{ name: '生理假', cap_days: 3, cap_h: 24, remain_h: 16, used_h: 8 }] };
  assert.ok(/^剩 2 次/.test(t.quotaText('生理假')));
  t.st.init = { quota: [{ name: '事假', cap_days: 14, cap_h: 112, remain_h: 100, basis: 'calendar' }] };
  assert.strictEqual(t.quotaText('事假'), '剩 100 小時（上限 112）', '其他假別照舊用小時');
});
ok('送出前：第 4 次擋（訊息含「' + PHRASE + '」）、同一天不加次數、每月一次擋、8 小時、計時', () => {
  t.st.info = { requests: [] };
  t.st.init = { quota: [Q([yr + '-07-02', yr + '-08-05', yr + '-09-03'])] };
  assert.ok(t.capLocked('生理假', 8, yr + '-11-20').indexOf(PHRASE) >= 0);
  assert.strictEqual(t.capLocked('生理假', 4, yr + '-09-03'), '', '同一天（已用過的那天）不加次數');
  t.st.init = { quota: [Q([yr + '-11-03'])] };
  assert.strictEqual(t.capLocked('生理假', 8, yr + '-11-20'), '生理假每月一次，這個月已請過（11/3）');
  t.st.init = { quota: [Q([])] };
  t.st.info = { requests: [{ kind: 'leave', leave_type: '生理假', date: yr + '-11-05', status: 'pending' }, { kind: 'leave', leave_type: '生理假', date: yr + '-10-05', status: 'cancelled' }] };
  assert.strictEqual(t.capLocked('生理假', 8, yr + '-11-20'), '生理假每月一次，這個月已請過（11/5）', '審核中的單也算這個月');
  assert.strictEqual(t.capLocked('生理假', 8, yr + '-10-20'), '', '取消的不算');
  assert.strictEqual(t.capLocked('生理假', 8.5, yr + '-12-20'), '生理假一天最多 8 小時，這次 8.5 小時超過了');
  t.st.init = { quota: [Q([])], ft: false };
  assert.strictEqual(t.capLocked('生理假', 4, yr + '-12-20'), '計時人員不適用生理假，請改請病假或事假');
});
ok('後端關掉新規則（seg2_no_types 帶生理假）→ 原本的檢查與兩段不開放', () => {
  t.st.init = { quota: [{ name: '生理假', cap_h: 24, remain_h: 0 }] };
  t.st.info = { seg2_kinds: ['leave'], seg2_no_types: ['生理假'], requests: [] };
  assert.strictEqual(t.capLocked('生理假', 8, yr + '-11-20'), '生理假今年 3 次已經用完，不能再申請');
  assert.strictEqual(t.capLocked('生理假', 12, yr + '-11-20'), '生理假今年 3 次已經用完，不能再申請');
  assert.strictEqual(t.seg2Ok('leave', '生理假'), false);
  t.st.info = { seg2_kinds: ['leave'], seg2_no_types: [], requests: [] };
  assert.strictEqual(t.seg2Ok('leave', '生理假'), true, '新後端：生理假可以加第二段');
});
console.log(n + ' 項全過');
