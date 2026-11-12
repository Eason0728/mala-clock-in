/* B03（2026-11-10 挑錯）：同仁還在上班（今天的上班卡還沒配到下班卡）時，主管核定當天被擋：
 * 「少了 1 張打卡，要有忘打卡單」。但人還在上班，這張單同仁此刻也送不出去（不能補登還沒到的時間）。
 * 需求 9：今天沒配對的上班卡＝上班中，隔天才算忘刷；2026-07-31 定的是「不擋核定、只提醒請同仁打卡」。
 * 修正：算「少幾張卡」時，還在上班的那張下班卡不算少（今天；跨夜班到隔天凌晨 06:00 前）。
 * 2026-11-11 Eason 定（B34）：改成「上班卡之後 16 小時內都算上班中」，不再看今天／06:00（B03-14 的預期值跟著改）。
 * 用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const TODAY = '2026-11-10', YDAY = '2026-11-09';
function approve(now, events, date, periods, props) {
  const m = make({ now: T(now), props: props || {}, self: { roster: [ME], events: events } });
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: date, emp_id: 'E01', periods: P(periods) });
  const n = /少了 (\d+) 張打卡/.exec(String(r.message || ''));
  return { m: m, 結果: r.ok ? 'ok' : r.error + (n ? '：少 ' + n[1] + ' 張' : ''), 狀態: r.status_text };
}
const ev = (d, hm, type) => [d + 'T' + hm + ':00', 'E01', type];

console.log('════ 一、人還在上班：核定送得出 ════');
let r = approve(TODAY + 'T16:00:00', [ev(TODAY, '09:00', 'in')], TODAY, '09:00-17:00');
check('B03-01', '今天 09:00 上班、還沒下班，16:00 核定今天 09:00-17:00 → 送得出', r.結果, 'ok');
r = approve(TODAY + 'T16:00:00', [ev(TODAY, '09:00', 'in'), ev(TODAY, '12:00', 'out'), ev(TODAY, '13:00', 'in')], TODAY, '09:00-12:00,13:00-17:00');
check('B03-02', '兩段班、第二段還在上班 → 送得出', r.結果, 'ok');
r = approve(TODAY + 'T00:30:00', [ev(YDAY, '22:00', 'in')], YDAY, '22:00-02:00');
check('B03-03', '跨夜班：昨天 22:00 上班，今天 00:30 還在上班，核定昨天 22:00-02:00 → 送得出', r.結果, 'ok');

console.log('\n════ 二、不是「還在上班」的缺卡照樣要單 ════');
r = approve(TODAY + 'T10:00:00', [ev(YDAY, '09:00', 'in')], YDAY, '09:00-17:00');
check('B03-10', '昨天只有上班卡（已經隔天 10:00）→ 少 1 張', r.結果, 'need_request：少 1 張');
r = approve(TODAY + 'T16:00:00', [ev(TODAY, '09:00', 'in')], TODAY, '09:00-13:00,14:00-18:00');
check('B03-11', '今天只有一張 09:00 上班卡、主管核兩段（中間休息沒打）→ 休息那兩張仍然要單', r.結果, 'need_request：少 2 張');
r = approve(TODAY + 'T16:00:00', [ev(TODAY, '12:00', 'out')], TODAY, '09:00-12:00');
check('B03-12', '今天只有下班卡（上班卡漏了）→ 少 1 張', r.結果, 'need_request：少 1 張');
r = approve(TODAY + 'T16:00:00', [ev(TODAY, '09:00', 'in'), ev(TODAY, '13:00', 'out'), ev(TODAY, '14:00', 'out')], TODAY, '09:00-13:00');
check('B03-13', '今天的上班卡後面已經有下班卡（不是上班中）→ 照原本的算法', r.結果, 'ok');
// 依據「2026-11-11 Eason 定：B34＝上班卡之後 16 小時內都算上班中」改預期值：原本寫「隔天 07:00（過了 06:00）→ 少 1 張」，
// 新規則不看 06:00、只看 16 小時；07:00 是上班後 9 小時，還算上班中、不擋。滿 16 小時（隔天 14:00 以後）才算少 1 張。
r = approve(TODAY + 'T07:00:00', [ev(YDAY, '22:00', 'in')], YDAY, '22:00-02:00');
check('B03-14', '跨夜班：隔天 07:00（上班後 9 小時，還在 16 小時內）還沒有下班卡 → 送得出', r.結果, 'ok');
r = approve(TODAY + 'T14:30:00', [ev(YDAY, '22:00', 'in')], YDAY, '22:00-02:00');
check('B03-14b', '跨夜班：隔天 14:30（超過 16 小時）還沒有下班卡 → 少 1 張', r.結果, 'need_request：少 1 張');
r = approve(TODAY + 'T16:00:00', [], TODAY, '09:00-17:00');
check('B03-15', '今天完全沒打卡 → 少 2 張', r.結果, 'need_request：少 2 張');

console.log('\n════ 三、之後打了下班卡，隔天 05:00 的重算會把狀態改回正常 ════');
{
  const a = approve(TODAY + 'T16:00:00', [ev(TODAY, '09:00', 'in')], TODAY, '09:00-17:00');
  const m = a.m, sb = m.sb;
  show('B03-20', '核定當下的狀態', a.狀態);
  m.setNow(TODAY + 'T17:02:00');
  sb.handleClock({ key: 'K1', type: 'out', device_id: 'D1', lat: 24.7840945, lng: 121.0157448, accuracy: 5 });
  m.setNow('2026-11-11T05:00:00');
  sb.recheckPendingApprovalStatuses();
  const rows = m.approved();
  check('B03-21', '同仁 17:02 打了下班卡；隔天 05:00 重算後的狀態', rows[rows.length - 1][5], '正常');
}
done();
