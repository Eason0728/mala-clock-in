/* 出勤核定舊問題 2（2026-11-21，Codex 20261121-rules-ab 問題 2 的規則甲關著那半）：只交重現＋設計，修法等 Eason 決定（會讓某些人的工時不同）。
 * 班表 09:00–11:00、11:10–15:00（兩段只隔 10 分）；卡 09:00 上、11:00 下、11:10 上、15:00 下（完全照班表）。
 * 營運系統 core-calc.js 的 15 分對齊（snapIn 取 bounds 裡「第一個」差 15 分內的邊界，不是最近的、也不分上班／下班）把 11:10 上班卡吸到 11:00（前一段的結束），
 * 預填成一段 09:00–15:00 送來（營運系統那半：mala-store-ops test/server/core-calc-gap-codex.test.js Q2）。
 * 打卡端收到 09:00–15:00：核 6 小時（多算 10 分沒上班、也不在班表的時間；比打卡多 10 分 < 30 分門檻，照收），
 *   狀態只拿重疊最大的那段打卡（11:10–15:00）比 → 「遲到130分、有多出的打卡段」（薪資 payCollect 照「遲到」開頭扣 130 分、算全勤）。
 * 下面記的是「現況」（全部會過）：K2a 是錯的那條，等 Eason 選了做法才改成正確預期。K2b 是選項 A（前端不併）送來時打卡端的結果。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const D = '2026-11-20';
const SP2 = [{ start: '09:00', end: '11:00' }, { start: '11:10', end: '15:00' }];
const EV2 = [['09:00', 'in'], ['11:00', 'out'], ['11:10', 'in'], ['15:00', 'out']];
function approve(periods, acting) {
  const m = make({ now: T('2026-11-21T21:00:00'), props: { REQ_STRICT_FROM: '2026-11-01' },
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: EV2.map((e) => [D + 'T' + e[0] + ':00', 'E01', e[1]]) } });
  const extra = acting ? { mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: SP2 } : {};
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods), dry_run: true }, extra));
  return [!!r.ok, r.approved_hours, r.status_text];
}
check('K2a', '現況（錯）：營運系統併成 09:00–15:00 送來 → 6 小時、「遲到130分、有多出的打卡段」（個人帳號）', approve('09:00-15:00', true), [true, 6, '遲到130分、有多出的打卡段']);
check('K2a-s', '現況（錯）：門市共用登入同樣', approve('09:00-15:00', false), [true, 6, '遲到130分、有多出的打卡段']);
check('K2b', '選項 A（前端不併）送 09:00–11:00、11:10–15:00 → 5.83 小時、正常（打卡端不用改）', approve('09:00-11:00,11:10-15:00', true), [true, 5.83, '正常']);
done();
