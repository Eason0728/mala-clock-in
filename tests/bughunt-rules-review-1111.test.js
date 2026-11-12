/* 2026-11-11 規則修正的獨立審查補修（低嚴重度兩項）。用真函式跑，名字一律假名。
 * ① B34：上班卡帶秒數、離滿 16 小時不到 1 分鐘時，畫面說「上班中」、核定卻說少一張卡 → 兩邊只用同一個判斷。
 * ② B33：跨夜下班後手滑按到上班（被擋成 rejected_too_soon），考勤異常提醒不可以多出一天「上班卡全被擋」。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = { lat: 24.7840945, lng: 121.0157448, accuracy: 5 };
{
  // 11/10 18:00:50 上班，現在 11/11 10:00:30（距離 15 小時 59 分 40 秒，還在 16 小時內）
  const m = make({ now: T('2026-11-11T10:00:30'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: [['2026-11-10T09:00:00', 'E01', 'in'], ['2026-11-10T13:00:00', 'E01', 'out'], ['2026-11-10T18:00:50', 'E01', 'in']] } });
  m.sb.PropertiesService.getScriptProperties().setProperty('REQ_BIND_FROM', '2026-11-01');
  const recent = m.sb.buildRecentDays(m.sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = m.sb.normCellTs(e.ts); return e; }), 'E01', '2026-11-11', {});
  const d = recent.filter((x) => x.date === '2026-11-10')[0];
  const ap = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-10', emp_id: 'E01', periods: [{ start: '09:00', end: '13:00' }, { start: '18:00', end: '21:00' }] });
  check('RV-01', '距離 16 小時還差 20 秒：同仁頁「上班中」、核定也不擋（不說少一張卡）', [d && d.notes.indexOf('上班中') >= 0, ap.error === 'need_request'], [true, false], JSON.stringify(ap).slice(0, 200));
}
{
  const m = make({ now: T('2026-11-06T17:00:00'), digest: true, self: { roster: [ME], events: [] } });
  const clock = (type) => m.sb.handleClock(Object.assign({ key: 'K1', type: type, device_id: 'D1' }, HERE));
  const a = clock('in');
  m.setNow('2026-11-07T01:00:00'); const b = clock('out');
  m.setNow('2026-11-07T01:00:15'); const c = clock('in');
  m.setNow('2026-11-07T12:00:00');
  const dg = m.sb.handleAttDigestData({ mgr_key: 'MK', store: 'gf', from: '2026-11-06', to: '2026-11-07', since: '2026-11-01T00:00:00+08:00', until: '2026-11-07T12:00:00+08:00' });
  const days = (dg.days || []).map((x) => x.date + (x.punch_blocked ? ' 被擋' : ''));
  check('RV-10', '跨夜下班後 15 秒按到上班（被擋）→ 考勤提醒不多出 11/7 那一天', [a.status, b.status, c.status, days], ['ok', 'ok', 'rejected_too_soon', ['2026-11-06']]);
}
done();
