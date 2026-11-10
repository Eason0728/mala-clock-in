/* B30、B31（2026-11-10 挑錯，申請單兩項）。用真函式跑，名字一律假名。
 * （B29「同一天有一張在審，另一張就送不出去」沒有改：既有規則是「同日同類只能一筆審核中」，要改規則等 Eason 定。）
 * B30：離職同仁（名冊停用、LINE 還綁著）最後一天需要補單：本人送不了、店長代開要等超過 7 天、核定又被擋。
 *      改成名冊已停用的同仁，今天和過去的日子店長可以直接代開（同「沒綁 LINE」的同仁）。
 * B31：「按錯上下班」後補的卡和按錯的卡同一分鐘時送不出去——B02 的修正已一併解掉，這裡留一個守門測試。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const res = (r) => (r.ok ? 'ok' : r.error);
function world(now, events, roster) { return make({ now: T(now), self: { roster: roster || [ME], events: events || [] } }); }
function submit(m, body) { m.advance(1000); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1' }, body)); }

console.log('\n════ B30：離職同仁最後一天的單，店長當下可以代開 ════');
{
  const D = '2026-11-12';
  const run = (now) => {
    const m = world(now, [[D + 'T09:00:00', 'E01', 'in'], [D + 'T19:00:00', 'E01', 'out']]);
    m.advance(1000);
    const off = m.sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E01', active: false });
    m.advance(1000);
    const px = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E01', kind: 'ot', date: D, start: '17:00', end: '19:00', reason: '最後一天結帳' });
    const rows = m.sb.reqRows_(m.self);
    return [res(off), res(px), rows.length ? String(rows[rows.length - 1].proxy_by || '') : null];
  };
  check('B30-01', '離職後第 1 天：店長代開加班單 → 開得出，單上記代開人', run('2026-11-13T10:00:00'), ['ok', 'ok', '店長甲']);
  check('B30-02', '離職後第 7 天 → 開得出', run('2026-11-19T10:00:00'), ['ok', 'ok', '店長甲']);
  check('B30-03', '離職後第 8 天（本來就可以）→ 開得出', run('2026-11-20T10:00:00'), ['ok', 'ok', '店長甲']);
  // 對照：在職、有綁 LINE 的同仁，7 天內照舊請本人自己送
  const m = world('2026-11-13T10:00:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T19:00:00', 'E01', 'out']]);
  const px = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E01', kind: 'ot', date: D, start: '17:00', end: '19:00', reason: '代開' });
  check('B30-04', '對照：在職又有綁 LINE，7 天內 → 照舊 not_old', res(px), 'not_old');
  // 離職同仁未來的日子不能代開
  const m2 = world('2026-11-13T10:00:00');
  m2.sb.handleMgrSetActive({ mgr_key: 'MK', emp_id: 'E01', active: false });
  const px2 = m2.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E01', kind: 'leave', date: '2026-11-15', leave_type: '事假', hours: 8, reason: '代開' });
  check('B30-05', '離職同仁、未來的日子 → 不能代開', res(px2), 'not_old');
}

console.log('\n════ B31：按錯上下班後，補的卡和按錯的卡同一分鐘 ════');
{
  const D = '2026-11-09', NOW = '2026-11-10T10:00:00';
  const m = world(NOW, [[D + 'T10:00:00', 'E01', 'in'], [D + 'T14:00:00', 'E01', 'out'], [D + 'T17:00:00', 'E01', 'in'], [D + 'T21:00:20', 'E01', 'in']]);
  check('B31-01', '21:00 下班按成上班 → 補下班卡 21:00 收得下去', res(submit(m, { kind: 'miss', date: D, miss_type: 'out', end: '21:00', reason: '按錯上下班' })), 'ok');
  const n = world(NOW, [[D + 'T10:00:00', 'E01', 'in'], [D + 'T14:00:00', 'E01', 'out'], [D + 'T17:00:10', 'E01', 'out'], [D + 'T21:00:00', 'E01', 'out']]);
  check('B31-02', '17:00 上班按成下班 → 補上班卡 17:00 收得下去', res(submit(n, { kind: 'miss', date: D, miss_type: 'in', start: '17:00', reason: '按錯上下班' })), 'ok');
}
done();
