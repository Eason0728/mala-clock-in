/* 生理假額度用「次」顯示（2026-11-18 Eason；跟 LINE 申請頁同一個口徑）：打卡頁「我的假別額度」（clock.html 母版→各店頁）、
 * 同仁專屬連結 my.html、LINE 機器人「假別額度」文字版與卡片。其他假別照舊用小時。舊薪資沒有 used_n＝用時數÷8。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const { make, T } = require('./helpers/gs-sandbox');
const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const MQ = { name: '生理假', cap_days: 3, cap_h: 24, used_days: 2, used_h: 16, remain_h: 8, remain_days: 1, basis: 'calendar', used_n: 2, dates: ['2026-07-02', '2026-08-05'] };
const MQ_OLD = { name: '生理假', cap_days: 3, cap_h: 24, used_days: 3, used_h: 24, remain_h: 0, remain_days: 0, basis: 'calendar', blocked: true };
const SICK = { name: '病假', cap_days: 30, cap_h: 240, used_days: 1, used_h: 8, remain_h: 232, remain_days: 29, basis: 'calendar' };
const strip = (h) => String(h).replace(/<[^>]+>/g, '');
function grab(file, startSig, endSig) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const a = src.indexOf(startSig), b = src.indexOf(endSig, a);
  if (a < 0 || b < 0) throw new Error(file + ' 找不到 ' + startSig);
  return src.slice(a, b);
}
ok('打卡頁母版 clock.html：生理假「2 次｜剩 1 次 / 上限 3 次」＋一天算一次；病假照舊小時；舊後端用時數換算＝已用完', () => {
  const sb = { payEsc: (s) => String(s) }; vm.createContext(sb);
  vm.runInContext(grab('clock.html', 'function payLeaveCard(list)', '  function renderPay(j)'), sb);
  const t = strip(sb.payLeaveCard([MQ, SICK]));
  assert.ok(t.indexOf('生理假一天算一次、每月一次2 次1 次/ 上限 3 次') >= 0, t);
  assert.ok(t.indexOf('病假8 H232 H/ 上限 240 H') >= 0, t);
  assert.ok(strip(sb.payLeaveCard([MQ_OLD])).indexOf('3 次已用完') >= 0);
});
ok('各店打卡頁（build-store-pages 產生）帶到同一段', () => {
  ['clock-cf.html', 'clock-hq.html', 'clock-mztgf.html', 'clock-mztjs.html', 'clock-mztlzl.html', 'clock-mztmc.html', 'clock-mztrg.html', 'clock-mztwx.html'].forEach((f) => {
    assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf("q.name === '生理假' ? Math.round((Number(q.used_h) || 0) / 8)") >= 0, f + ' 沒有重新產生');
  });
});
ok('同仁專屬連結 my.html：同一個顯示', () => {
  const sb = { esc: (s) => String(s), r1: (v) => Math.round((Number(v) || 0) * 10) / 10 }; vm.createContext(sb);
  vm.runInContext(grab('my.html', 'function leaveCard(list){', '\nfunction ', ) .replace(/\nfunction $/, ''), sb);
  const t = strip(sb.leaveCard([MQ, SICK]));
  assert.ok(t.indexOf('生理假一天算一次、每月一次2 次1 次/ 上限 3 次') >= 0, t);
  assert.ok(t.indexOf('病假8 H232 H/ 上限 240 H') >= 0, t);
});
ok('LINE 機器人「假別額度」：文字版與卡片都用次；病假照舊小時', () => {
  const m = make({ now: T('2026-11-18T10:00:00'), hub: true, self: { roster: [] } });
  m.sb.lineHubPayslipFor_ = () => ({ ok: true, annual: null, comp: null, leave_quota: [MQ, SICK] });
  const txt = m.sb.lineHubLeaveText_('U1');
  assert.ok(txt.indexOf('・生理假：已請 2 次｜剩 1 次／上限 3 次（一天算一次、每月一次）') >= 0, txt);
  assert.ok(txt.indexOf('・病假：8H｜232H／上限 240H') >= 0, txt);
  const card = JSON.stringify(m.sb.lineHubLeaveCard_('U1'));
  assert.ok(card.indexOf('剩 1 次') >= 0 && card.indexOf('已請 2 次・上限 3 次・一天算一次、每月一次') >= 0, card.slice(0, 300));
  m.sb.lineHubPayslipFor_ = () => ({ ok: true, annual: null, comp: null, leave_quota: [MQ_OLD] });
  assert.ok(m.sb.lineHubLeaveText_('U1').indexOf('・生理假：已請 3 次｜已用完') >= 0, '舊薪資（沒有 used_n）用時數換算');
});
console.log(n + ' 項全過');
