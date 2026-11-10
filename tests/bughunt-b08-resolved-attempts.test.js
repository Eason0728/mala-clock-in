/* B08（2026-11-10 挑錯）：當天只要有任何一筆「沒成功」的打卡，核定狀態就整天改寫成「打卡未入帳，主管補登」，
 * 不再看單張卡——連按被擋（前一張其實已經成功）、定位飄掉被擋後重按成功，也算在內。
 * 結果：09:10 才到、忘打下班的人，多按一下就從「遲到10分、下班忘刷卡」變成「打卡未入帳，主管補登」，遲到分鐘不見。
 * 修正：只有「真的沒入帳」才算——連按被擋不算；被擋之後 10 分鐘內同一種卡重按成功也不算。
 * 用真函式跑。名字一律假名。 */
'use strict';
const path = require('path');
const { make, T, check, show, done, ROOT } = require('./helpers/gs-sandbox');
const PV = require(path.join(ROOT, 'tests/helpers/payroll-vm.js'));
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-07';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const ev = (hms, type, st) => [D + 'T' + hms, 'E01', type, st];
function run(events, periods) {
  const m = make({ now: T('2026-11-10T21:00:00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: events } }), sb = m.sb;
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods || '09:00-18:00') });
  const day = sb.handleMgrDay({ mgr_key: 'MK', date: D }).employees.filter((e) => e.emp_id === 'E01')[0];
  const apRows = sb.readSheetAsObjects(m.self.sh.approved).rows;
  const ps = PV.load({ today: '2026-11-10', clock: { SSLGF: { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }],
    events: m.events().map((e) => ({ ts: e.ts, emp_id: e.emp_id, type: e.type, status: e.status })),
    approved: apRows.map((a) => ({ date: a.date, emp_id: a.emp_id, name: a.name, periods: a.periods, approved_hours: a.approved_hours, status_text: a.status_text, manager_name: a.manager_name, entered_at: a.entered_at })),
    leave: [], requests: [] } }, data: { master: [PV.ftEmp()] } });
  const c = JSON.parse(JSON.stringify(ps.call('payCollect', '2026-11', 6, 'SSLGF', [], null))).E01 || {};
  return { m: m, 狀態: r.status_text, 主管頁嘗試次數: day.attempts, 薪資遲到分鐘: c.late_min || 0, 薪資忘刷天數: c.forget_day || 0 };
}
const pick = (x) => [x.狀態, x.薪資遲到分鐘, x.薪資忘刷天數];

console.log('════ 一、連按被擋、被擋後重按成功：不算「打卡未入帳」════');
const base = run([ev('09:10:00', 'in')]);
check('B08-01', '對照：只有 09:10 上班卡（忘打下班）→ 遲到10分、下班忘刷卡；薪資遲到 10 分、忘刷 1 天', pick(base), ['遲到10分、下班忘刷卡', 10, 1]);
let r = run([ev('09:10:00', 'in'), ev('09:10:04', 'in', 'rejected_duplicate')]);
check('B08-02', '同上＋09:10:04 連按一次被擋 → 和對照一樣', pick(r), pick(base));
check('B08-03', '主管頁照舊列出那一筆被擋的嘗試（1 次）', r.主管頁嘗試次數, 1);
r = run([ev('09:08:00', 'in', 'rejected_out_of_range'), ev('09:10:00', 'in')]);
check('B08-04', '09:08 定位飄掉被擋、09:10 重按成功 → 和對照一樣', pick(r), pick(base));
r = run([ev('09:00:00', 'in'), ev('18:00:00', 'out', 'rejected_out_of_range'), ev('18:03:00', 'out')]);
check('B08-05', '下班卡 18:00 被擋、18:03 重按成功（完整一段）→ 正常', r.狀態, '正常');

console.log('\n════ 二、真的沒入帳的照舊寫「打卡未入帳，主管補登」（不冤枉人）════');
r = run([ev('09:10:00', 'in'), ev('18:00:00', 'out', 'rejected_out_of_range')]);
check('B08-10', '上班卡成功、下班卡被擋而且沒有再按成功 → 打卡未入帳，主管補登', r.狀態, '打卡未入帳，主管補登');
r = run([ev('09:00:00', 'in', 'rejected_out_of_range'), ev('18:00:00', 'out', 'rejected_out_of_range')]);
check('B08-11', '兩張都被擋（沒有任何成功的卡）→ 打卡未入帳，主管補登', r.狀態, '打卡未入帳，主管補登');
r = run([ev('09:08:00', 'in', 'rejected_out_of_range'), ev('09:30:00', 'in')]);
check('B08-12', '09:08 被擋、隔了 22 分鐘才按成功（超過 10 分鐘）→ 照舊交給主管認定', r.狀態, '打卡未入帳，主管補登');
r = run([ev('09:10:00', 'in'), ev('18:00:00', 'out', 'pending_device_approval')]);
check('B08-13', '下班卡是新手機待核准（還沒入帳）→ 打卡未入帳，主管補登', r.狀態, '打卡未入帳，主管補登');

console.log('\n════ 三、每日重算用同一個口徑 ════');
{
  const m = make({ now: T('2026-11-08T05:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [ME], events: [ev('09:10:00', 'in'), ev('09:10:04', 'in', 'rejected_duplicate'), ev('18:00:00', 'out')],
      approved: [[D, 'E01', '測試一', '09:00-18:00', 9, '打卡未入帳，主管補登', '值班主管', D + 'T20:00:00+08:00', '', '']] } });
  m.sb.recheckPendingApprovalStatuses();
  const rows = m.approved();
  check('B08-20', '舊紀錄「打卡未入帳，主管補登」（只是連按被擋、卡其實齊了）→ 重算後 遲到10分', rows[rows.length - 1][5], '遲到10分');
}
{
  const m = make({ now: T('2026-11-08T05:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [ME], events: [ev('09:10:00', 'in'), ev('09:10:04', 'in', 'rejected_duplicate')],
      approved: [[D, 'E01', '測試一', '09:00-18:00', 9, '打卡未入帳，主管補登', '值班主管', D + 'T20:00:00+08:00', '', '']] } });
  m.sb.recheckPendingApprovalStatuses();
  const rows = m.approved();
  check('B08-21', '舊紀錄「打卡未入帳，主管補登」（只有上班卡＋連按被擋）→ 重算後 遲到10分、下班忘刷卡', rows[rows.length - 1][5], '遲到10分、下班忘刷卡');
}
done();
