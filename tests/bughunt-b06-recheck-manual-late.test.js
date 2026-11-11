/* B06（2026-11-10 挑錯）：主管在同仁還沒打下班卡時先核定，並在遲到分鐘欄填了數字（0 或 N）。
 * 同仁之後打了下班卡。每日 05:00 的重算看到狀態帶「主管認定」就整筆跳過，
 * 結果「下班忘刷卡」永遠留在狀態上，月表多算 1 天異常（那天其實沒有漏卡）。
 * 修正：重算打卡比對的部分，再把主管認定的遲到（N 分或不計遲到）原樣套回去。主管的認定不會被洗掉。
 * 用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = { lat: 24.7840945, lng: 121.0157448, accuracy: 5 };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const D = '2026-11-07';
function monthAbn(m) {
  const sb = m.sb;
  const ev = sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const built = sb.buildMonthlySheet('2026-11', sb.readSheetAsObjects(m.self.sh.roster).rows, ev, [], sb.todayTaipeiStr(), sb.readSheetAsObjects(m.self.sh.approved).rows);
  return built.rows.filter((r) => r[0] === '測試一' && typeof r[1] === 'number')[0][3];
}
/** 11/7 inAt 上班 → 20:00 主管先核定 09:00-17:00（可帶遲到分鐘）→ 20:30 同仁打下班卡 → 11/8 05:00 每日重算 */
function scenario(inAt, lateMin) {
  const m = make({ now: T(D + 'T' + inAt + ':00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: [] } }), sb = m.sb;
  sb.handleClock(Object.assign({ key: 'K1', type: 'in', device_id: 'D1' }, HERE));
  m.setNow(D + 'T20:00:00');
  const body = { mgr_key: 'MK', date: D, emp_id: 'E01', periods: P('09:00-17:00') };
  if (lateMin !== undefined) body.late_min = lateMin;
  const a = sb.handleMgrApprove(body);
  m.setNow(D + 'T20:30:00');
  sb.handleClock(Object.assign({ key: 'K1', type: 'out', device_id: 'D1' }, HERE));
  m.setNow('2026-11-08T05:00:00');
  const r = sb.recheckPendingApprovalStatuses();
  const rows = m.approved(), last = rows[rows.length - 1];
  return { m: m, 核定當下: a.status_text, 重算: JSON.parse(JSON.stringify(r)), 重算後: last[5], 核定人欄: last[6], 異常天數: monthAbn(m) };
}

console.log('════ 一、主管填過遲到分鐘的日子，之後補上的下班卡要讓「下班忘刷卡」消失 ════');
let s = scenario('09:00');
check('B06-01', '對照（遲到欄留空）：重算後「正常」、異常 0 天', [s.重算後, s.異常天數], ['正常', 0]);
s = scenario('09:00', 0);
show('B06-02', '遲到欄填 0：核定當下', s.核定當下);
check('B06-03', '遲到欄填 0：重算後只剩「主管認定不計遲到」、異常 0 天', [s.重算後, s.異常天數], ['主管認定不計遲到', 0]);
check('B06-04', '重算補的那一列有註記系統重算', /（系統重算）$/.test(s.核定人欄), true);
s = scenario('09:00', 5);
check('B06-05', '遲到欄填 5：重算後只剩「遲到5分(認定)」', s.重算後, '遲到5分(認定)');

console.log('\n════ 二、主管的認定不會被重算洗掉 ════');
s = scenario('09:20', 5);
check('B06-10', '同仁 09:20 才到（系統會算遲到 20 分），主管認定 5 分：重算後仍是 5 分', s.重算後, '遲到5分(認定)');
s = scenario('09:20', 0);
check('B06-11', '同仁 09:20 才到，主管認定不算遲到：重算後仍不算遲到', s.重算後, '主管認定不計遲到');
{
  // 整天沒打卡、主管認定遲到 5 分：之後也沒有補卡 → 重算不改這一筆
  const m = make({ now: T('2026-11-07T23:00:00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: [] } }), sb = m.sb;
  const a = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P('17:30-22:00'), late_min: '5' });
  m.setNow('2026-11-08T05:00:00');
  const r = JSON.parse(JSON.stringify(sb.recheckPendingApprovalStatuses()));
  const rows = m.approved();
  check('B06-12', '沒補卡的日子：重算不寫新的一列、狀態不變', [a.status_text, r.fixed, rows.length, rows[rows.length - 1][5]], ['該段無打卡、遲到5分(認定)', 0, 1, '該段無打卡、遲到5分(認定)']);
}
{
  // 回填工具（backfill_missing_groups）照舊不自動改主管認定過的日子
  const m = make({ now: T('2026-11-08T10:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [ME], events: [[D + 'T10:00:00', 'E01', 'in'], [D + 'T20:00:00', 'E01', 'out']],
      approved: [[D, 'E01', '測試一', '10:00-14:00,16:00-20:00', 8, '遲到5分(認定)', '值班主管', D + 'T21:00:00+08:00', '', '']] } });
  const r = JSON.parse(JSON.stringify(m.sb.backfillMissingPunchGroups(D, D, false)));
  show('B06-13', '回填工具（只看不寫）對主管認定過的日子', { hits: (r.hits || []).length, skipped: (r.skipped || []).map((x) => x.reason) });
  check('B06-14', '回填工具把它列在「不自動改」', [(r.hits || []).length, (r.skipped || []).map((x) => x.reason)], [0, ['主管手動認定，不自動改']]);
}
done();
