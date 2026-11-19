/* 待核定提醒多吃選填 ym（2026-11-19 Eason，考勤驗收 11-10 不符 5：月初看不到上個月沒核定的天）。用真函式跑，名字一律假名。
 * 規則：mgr_pending_approvals 不帶 ym＝照舊（台北本月，結果不變）；ym＝本月＝同上；ym＝上個月＝那個月有上班、主管還沒核定的天
 *       （同一套算法，含已核准假單那天沒核定、不算本店支援的人照舊不列）；其他月份回 bad_ym。Code.gs 不動，掛在 Liff.gs LIFF_HANDLERS → Requests.gs。
 * 「每月 1～5 號才問上個月」由營運系統決定（mala-store-ops server/proxy/duty.js prevYmEarly），打卡端只管回那個月。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const R = [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'FALSE' }];   // E02 已離職：漏核的日子一樣要列
const EV = [
  ['2026-11-28T09:00:00', 'E01', 'in'], ['2026-11-28T17:00:00', 'E01', 'out'],   // 已核定
  ['2026-11-30T09:00:00', 'E01', 'in'], ['2026-11-30T17:00:00', 'E01', 'out'],   // 沒核定
  ['2026-11-29T10:00:00', 'E02', 'in'], ['2026-11-29T15:00:00', 'E02', 'out'],   // 沒核定（離職的人）
  ['2026-12-01T09:00:00', 'E01', 'in'], ['2026-12-01T17:00:00', 'E01', 'out'],   // 本月、還沒核定
];
const APPROVED = [['2026-11-28', 'E01', '測試一', '09:00-17:00', 8, '正常', '值班主管', '2026-11-29T10:00:00+08:00']];
const W = (now) => make({ now: T(now), self: { roster: R, events: EV, approved: APPROVED } });
const pend = (m, body) => m.sb.LIFF_HANDLERS.mgr_pending_approvals(Object.assign({ mgr_key: 'MK' }, body || {}));
const brief = (r) => (r.ok ? { ym: r.ym, items: r.items.map((x) => x.emp_id + '@' + x.date + (x.from_request ? '(假單)' : '')) } : { ok: false, error: r.error });
const viaPost = (m, body) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'mgr_pending_approvals', mgr_key: 'MK' }, body || {})) } }).text);

{
  const m = W('2026-12-02T10:00:00');
  check('Y1', '不帶 ym（舊呼叫）：本月、內容跟改之前同一條路（Code.gs handleMgrPendingApprovals＋已核准申請）', brief(pend(m)), { ym: '2026-12', items: ['E01@2026-12-01'] });
  check('Y2', 'ym 空字串／null 也當舊呼叫', [brief(pend(m, { ym: '' })), brief(pend(m, { ym: null }))], [{ ym: '2026-12', items: ['E01@2026-12-01'] }, { ym: '2026-12', items: ['E01@2026-12-01'] }]);
  check('Y3', 'ym＝本月：跟不帶一模一樣', JSON.stringify(pend(m, { ym: '2026-12' })) === JSON.stringify(pend(m)), true);
  check('Y4', 'ym＝上個月：那個月有上班沒核定的天（已核定的 11/28 不列、離職的 E02 照列）', brief(pend(m, { ym: '2026-11' })), { ym: '2026-11', items: ['E02@2026-11-29', 'E01@2026-11-30'] });
  check('Y5', '其他月份：bad_ym（兩個月前、下個月、格式錯）', ['2026-10', '2027-01', '2026-13', '202611', 11].map((ym) => pend(m, { ym }).error), ['bad_ym', 'bad_ym', 'bad_ym', 'bad_ym', 'bad_ym']);
  check('Y6', '主管金鑰錯：照舊 unauthorized（上個月那條也驗）', [pend(m, { mgr_key: 'XX' }).error, pend(m, { mgr_key: 'XX', ym: '2026-11' }).error], ['unauthorized', 'unauthorized']);
  check('Y7', '走 doPost（Code.gs 併 LIFF_HANDLERS）：ym 有傳到', brief(viaPost(m, { ym: '2026-11' })).items, ['E02@2026-11-29', 'E01@2026-11-30']);
}
{
  // 跨年：1 月問 12 月
  const m = make({ now: T('2027-01-03T10:00:00'), self: { roster: R, events: [['2026-12-31T09:00:00', 'E01', 'in'], ['2026-12-31T17:00:00', 'E01', 'out']] } });
  check('Y8', '跨年：1/3 問 2026-12', brief(pend(m, { ym: '2026-12' })), { ym: '2026-12', items: ['E01@2026-12-31'] });
  check('Y9', '1/3 不帶 ym：本月 0 筆（改之前就是這樣，所以營運系統月初要另外問）', brief(pend(m)), { ym: '2027-01', items: [] });
}
{
  // 已核准的整天假單、那天沒核定：上個月那份也補（同本月的 reqPendingApprovalsPlus_ 規則）
  const m = W('2026-12-01T10:00:00');
  const s = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '人資主管（DZY020）', emp_id: 'E01', kind: 'leave', date: '2026-11-27', leave_type: '事假', hours: 8, reason: '補請假' });
  const ok = s.ok ? m.sb.handleMgrReqDecide_({ mgr_key: 'AK', acting_name: '總監（DZY099）', director_ok: true, id: s.request.id, decision: 'approve' }) : s;
  if (ok.ok) check('Y10', '上個月已核准整天假單、那天沒核定：一起列（標假單）', brief(pend(m, { ym: '2026-11' })).items, ['E01@2026-11-27(假單)', 'E02@2026-11-29', 'E01@2026-11-30']);
  else check('Y10', '（前置：代開假單要成功）', ok.error || ok, 'ok');
}
done();
