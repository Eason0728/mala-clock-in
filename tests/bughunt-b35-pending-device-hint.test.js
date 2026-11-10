/* B35（2026-11-10 挑錯）：舊連結用新手機打的卡是「待核准」。申請頁把它當成有打，核定卻當成沒打：
 * 主管核定被擋「少了 2 張打卡，要有忘打卡單，請同仁在 LINE 補申請」，同仁照做又被申請頁說「有打成功」。
 * 真正的出路是主管先核准裝置（卡就變成有效），但訊息沒有講。
 * 修正：核定因為少卡被擋、而那天有待核准裝置的卡時，訊息多一句請主管先核准新手機。判斷本身不動。
 * 用真函式跑，名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-12';
const approve = (m) => m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
{
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in', 'pending_device_approval', 'NEWPHONE'], [D + 'T17:00:00', 'E01', 'out', 'pending_device_approval', 'NEWPHONE']] } });
  const r = approve(m);
  check('B35-01', '兩張都是待核准的卡 → 照舊擋（少 2 張）', [r.ok, r.error, r.need && r.need.miss_cards], [false, 'need_request', 2]);
  check('B35-02', '訊息講清楚：有 2 張新手機待核准的卡，請先核准裝置', /這天有 2 張新手機待核准的打卡，請先到「待核准裝置」核准這支手機，再回來核定（核准後就不用補忘打卡單）/.test(String(r.message)), true);
}
{
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out', 'pending_device_approval', 'NEWPHONE']] } });
  const r = approve(m);
  check('B35-03', '只有下班卡待核准 → 擋（少 1 張），訊息講 1 張', [r.error, r.need && r.need.miss_cards, /這天有 1 張新手機待核准的打卡/.test(String(r.message))], ['need_request', 1, true]);
}
{
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in']] } });
  const r = approve(m);
  check('B35-04', '對照：真的少一張卡（沒有待核准的卡）→ 訊息照舊，不提裝置', [r.error, /待核准/.test(String(r.message)), /請同仁在 LINE「加班請假」補申請/.test(String(r.message))], ['need_request', false, true]);
}
{
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']] } });
  check('B35-05', '對照：卡都齊 → 核定送得出', approve(m).ok, true);
}
{
  // 別人的待核准卡、別天的待核准卡不算
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME, { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' }],
    events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T09:01:00', 'E02', 'in', 'pending_device_approval', 'X'], ['2026-11-11T09:00:00', 'E01', 'in', 'pending_device_approval', 'X']] } });
  const r = approve(m);
  check('B35-06', '別人的、別天的待核准卡不算 → 訊息不提裝置', [r.error, /待核准/.test(String(r.message))], ['need_request', false]);
}
done();
