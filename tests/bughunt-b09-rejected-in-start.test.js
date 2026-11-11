/* B09（2026-11-10 挑錯）：被擋的重複上班卡（rejected_duplicate）前面沒有成功的上班卡時，
 * 配對把它當成一段班的起點——一張不算數的卡變出假的「下班忘刷卡」（薪資忘刷多 1 天），或和後面的下班卡配成完整一段。
 * 會遇到的情況：新手機待核准的上班卡後來被拒、同一秒兩筆上班卡同時到（被擋的那筆先寫進表）。
 * 2026-11-02 起同一種卡只在 10 分鐘內擋，被擋的重複卡一定是連按，不再代表「換了一段班」。
 * 修正：前面沒有開著的上班卡時，被擋的重複上班卡一律忽略。（前面有開著的上班卡、相隔 60 分鐘以上才換段的舊規則不動，
 * 那只會出現在 2026-11-02 以前的資料。）用真函式跑。名字一律假名。 */
'use strict';
const path = require('path');
const { make, T, check, show, done, ROOT } = require('./helpers/gs-sandbox');
const PV = require(path.join(ROOT, 'tests/helpers/payroll-vm.js'));
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-07';
const ev = (hms, type, st) => [D + 'T' + hms, 'E01', type, st];
function look(events) {
  const m = make({ now: T('2026-11-10T21:00:00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: events } }), sb = m.sb;
  const rows = sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const day = sb.dayPunchSegments(rows, 'E01', D);
  const built = sb.buildMonthlySheet('2026-11', sb.readSheetAsObjects(m.self.sh.roster).rows, rows, [], sb.todayTaipeiStr(), []);
  const sum = built.rows.filter((r) => r[0] === '測試一' && typeof r[1] === 'number')[0];
  const ps = PV.load({ today: '2026-11-10', clock: { SSLGF: { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }],
    events: m.events().map((e) => ({ ts: e.ts, emp_id: e.emp_id, type: e.type, status: e.status })), approved: [], leave: [], requests: [] } }, data: { master: [PV.ftEmp()] } });
  const c = JSON.parse(JSON.stringify(ps.call('payCollect', '2026-11', 6, 'SSLGF', [], null))).E01 || {};
  return { m: m, 打卡段: day.segments.map((s) => (s.in || '？') + '–' + (s.out || '？')), 參考時數: sb.dayReferenceHours_(day, D, sb.todayTaipeiStr()),
           月表異常天數: sum ? sum[3] : 0, 薪資忘刷次數: c.forget_punch || 0 };
}

console.log('════ 一、被擋的重複上班卡，前面沒有成功的上班卡：不當成一段的起點 ════');
let r = look([ev('09:00:00', 'in', 'rejected_device'), ev('09:00:05', 'in', 'rejected_duplicate')]);
check('B09-01', '新手機的上班卡後來被拒＋5 秒後連按被擋（沒有任何一張算數的卡）→ 沒有打卡段、異常 0、薪資忘刷 0', [r.打卡段, r.月表異常天數, r.薪資忘刷次數], [[], 0, 0]);
r = look([ev('09:00:00', 'in', 'rejected_duplicate'), ev('09:00:00', 'in'), ev('17:30:00', 'out')]);
check('B09-02', '同一秒兩筆上班卡、被擋的那筆先寫進表 → 只有 09:00–17:30 一段、參考 8.5、異常 0、薪資忘刷 0', [r.打卡段, r.參考時數, r.月表異常天數, r.薪資忘刷次數], [['09:00–17:30'], 8.5, 0, 0]);
r = look([ev('09:00:00', 'in', 'rejected_device'), ev('09:03:00', 'in', 'rejected_duplicate'), ev('17:00:00', 'out')]);
check('B09-03', '新手機的上班卡被拒、09:03 連按被擋、17:00 下班成功 → 被擋的卡不會和下班卡配成一段（只有 ？–17:00）', r.打卡段, ['？–17:00']);
{
  const ap = r.m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
  check('B09-04', '這天核定的狀態：上班那張沒入帳，寫「打卡未入帳，主管補登」', ap.status_text, '打卡未入帳，主管補登');
}

console.log('\n════ 二、原本就對的照舊 ════');
r = look([ev('09:00:00', 'in'), ev('09:00:04', 'in', 'rejected_duplicate'), ev('17:30:00', 'out')]);
check('B09-10', '上班成功後 4 秒連按被擋 → 09:00–17:30 一段', r.打卡段, ['09:00–17:30']);
r = look([ev('09:00:00', 'in'), ev('17:59:00', 'in', 'rejected_duplicate'), ev('18:00:00', 'out')]);
check('B09-11', '要下班卻按到上班（被擋）、1 分鐘內改按下班 → 09:00–18:00 一段', r.打卡段, ['09:00–18:00']);
r = look([ev('11:02:00', 'in'), ev('17:05:00', 'in', 'rejected_duplicate'), ev('21:44:00', 'out')]);
check('B09-12', '舊資料的規則不動：上班卡之後隔 60 分鐘以上又一張被擋的上班卡 → 前一段沒下班、後一段從被擋那張起算', r.打卡段, ['11:02–？', '17:05–21:44']);
done();
