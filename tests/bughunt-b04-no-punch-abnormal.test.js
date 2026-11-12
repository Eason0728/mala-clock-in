/* B04（2026-11-10 挑錯；2026-11-11 Eason 定：A）：整天完全沒打卡、主管補核定的那天，月表也要算異常 1 天（跟薪資一致）。
 * 修正前：核定狀態「該段無打卡」的日子，月表異常天數 0；薪資歸集（2026-11 起）算忘刷 1 天，兩邊對不起來。
 * 生效日比照薪資：2026-11-01 起的日子才算，10 月以前的月表不變。
 * 「出差」「整天請假」「主管認定不計遲到」「正常」「打卡未入帳，主管補登」都不算。
 * 用真函式跑（整檔載入 apps-script/*.gs）。名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));

/** 某天的打卡＋主管核定 → 核定狀態、月表異常天數、那一列有沒有標紅 */
function run(date, events, periods, opt) {
  opt = opt || {};
  const ym = date.slice(0, 7);
  const m = make({ now: T(opt.now || (ym + '-20T21:00:00')), props: { REQ_BIND_FROM: 'off' },   // 只看狀態與統計；「要忘打卡單」那道另外測
    self: { roster: [ME], events: events, leave: opt.leave || [] } }), sb = m.sb;
  const r = periods === null
    ? sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: date, emp_id: 'E01', periods: [] }, opt.body || {}))
    : sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: date, emp_id: 'E01', periods: P(periods) }, opt.body || {}));
  const ev = sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const leaves = sb.readSheetAsObjects(m.self.sh.leave).rows.map((l) => ({ date: sb.normCellDate(l['日期']), name: l['姓名'], type: l['假別'], hours: l['時數'] }));
  const built = sb.buildMonthlySheet(ym, sb.readSheetAsObjects(m.self.sh.roster).rows, ev, leaves, sb.todayTaipeiStr(), sb.readSheetAsObjects(m.self.sh.approved).rows);
  const sum = built.rows.filter((x) => x[0] === '測試一' && typeof x[1] === 'number')[0];
  const rowNo = built.rows.findIndex((x) => x[0] === date) + 1;
  return { ok: r.ok, 狀態: r.status_text, 異常天數: sum[3], 標紅: built.abnormalNoteRows.indexOf(rowNo) !== -1 };
}

console.log('════ 一、11 月起：整天沒打卡、主管補核定 → 月表異常 1 天 ════');
let r = run('2026-11-07', [], '09:00-17:00');
check('B04-01', '11/7 沒有任何打卡，主管核 09:00-17:00 → 狀態', r.狀態, '該段無打卡');
check('B04-02', '同上 → 月表異常天數', r.異常天數, 1);
check('B04-03', '同上 → 那一列標紅字（和異常天數看同一份資料）', r.標紅, true);
r = run('2026-11-07', [], '09:00-13:00,14:00-18:00');
check('B04-04', '11/7 沒有任何打卡，主管核兩段 → 狀態', r.狀態, '該段無打卡');
check('B04-05', '同上 → 月表異常天數（兩段都沒打也只算 1 天）', r.異常天數, 1);
r = run('2026-11-01', [], '09:00-17:00');
check('B04-06', '11/1（生效第一天）整天沒打卡 → 異常 1 天', r.異常天數, 1);
r = run('2026-11-07', [['2026-11-07T09:00:00', 'E01', 'in'], ['2026-11-07T13:00:00', 'E01', 'out']], '09:00-13:00,14:00-18:00');
check('B04-07', '對照：兩段班第二段整段沒打（原本就算）→ 異常 1 天', [r.狀態, r.異常天數], ['第二段上班無打卡、第二段下班無打卡', 1]);

console.log('\n════ 二、10 月以前的日子不變 ════');
r = run('2026-10-07', [], '09:00-17:00');
check('B04-10', '10/7 整天沒打卡、主管補核定 → 狀態一樣是該段無打卡', r.狀態, '該段無打卡');
check('B04-11', '同上 → 月表異常天數照舊 0（10 月以前的月表不因此改變）', r.異常天數, 0);
check('B04-12', '同上 → 不標紅', r.標紅, false);
r = run('2026-10-31', [], '09:00-17:00');
check('B04-13', '10/31（生效前一天）→ 0', r.異常天數, 0);

console.log('\n════ 三、不該算進去的 ════');
r = run('2026-11-07', [], '09:00-17:00', { leave: [['2026-11-07', '測試一', '出差', 8]], body: { leaves: [{ type: '出差', hours: 8 }] } });
check('B04-20', '出差日整天沒打卡 → 狀態不是該段無打卡、異常 0', [r.狀態.indexOf('該段無打卡') === -1, r.異常天數], [true, 0]);
r = run('2026-11-07', [], null, { body: { leaves: [{ type: '特休假', hours: 8 }] } });
check('B04-21', '整天請特休（沒有核定時段）→ 異常 0', r.異常天數, 0);
r = run('2026-11-07', [['2026-11-07T09:00:00', 'E01', 'in'], ['2026-11-07T17:00:00', 'E01', 'out']], '09:00-17:00');
check('B04-22', '正常上下班 → 異常 0', [r.狀態, r.異常天數], ['正常', 0]);
r = run('2026-11-07', [['2026-11-07T09:05:00', 'E01', 'in'], ['2026-11-07T17:00:00', 'E01', 'out']], '09:00-17:00', { body: { late_min: 0 } });
check('B04-23', '主管認定不計遲到 → 異常 0', [r.狀態, r.異常天數], ['主管認定不計遲到', 0]);
r = run('2026-11-07', [['2026-11-07T09:00:00', 'E01', 'in', 'rejected_out_of_range'], ['2026-11-07T17:00:00', 'E01', 'out', 'rejected_out_of_range']], '09:00-17:00');
check('B04-24', '有打但被擋（打卡未入帳，主管補登）→ 不是沒打卡，異常 0（薪資也不算）', [r.狀態.indexOf('該段無打卡') === -1, r.異常天數], [true, 0]);
{
  // 純函式直接驗：字樣要整項相等才算，「主管說該段無打卡」這類不算
  const sb = make({}).sb;
  const built = sb.buildMonthlySheet('2026-11', [{ emp_id: 'E01', name: '測試一', active: 'true' }], [], [], '2026-11-20',
    [{ date: '2026-11-07', emp_id: 'E01', name: '測試一', periods: '09:00-17:00', approved_hours: 8, status_text: '主管說該段無打卡', manager_name: 'x', entered_at: '2026-11-08T10:00:00+08:00' }]);
  check('B04-25', '狀態只是「含有」該段無打卡的其他字樣 → 不算', built.rows[1][3], 0);
}
done();
