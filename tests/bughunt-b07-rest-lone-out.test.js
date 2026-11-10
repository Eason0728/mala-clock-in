/* B07（2026-11-10 挑錯）：兩班間隔不到 11 小時要擋上班卡。規格（2026-11-01）的例外只有一種：
 * 「上一段忘了打下班卡＝算不出間隔，不擋」。但程式連「上一段忘了打上班卡、只有下班卡」也不算一段，
 * 明明知道幾點下班，隔天早上卻不擋（例：昨晚 22:00 下班卡、今天 06:00 上班，只隔 8 小時）。
 * 修正：前面沒有上班卡的下班卡，算班距時當成那一段的結束（時數算 0，不進單日 10 小時）。
 * 用真函式跑，休息規則開著（REST_RULE_ON=1）。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = { lat: 24.7840945, lng: 121.0157448, accuracy: 5 };
const Y = '2026-11-09', TD = '2026-11-10';
function clockIn(now, events, props) {
  const m = make({ now: T(now), props: props === undefined ? { REST_RULE_ON: '1' } : props, self: { roster: [ME], events: events } });
  const r = m.sb.handleClock(Object.assign({ key: 'K1', type: 'in', device_id: 'D1' }, HERE));
  return { m: m, status: r.status };
}
const ev = (d, hm, type, st) => [d + 'T' + hm + ':00', 'E01', type, st];

console.log('════ 一、昨晚只有下班卡（上班卡忘了打）：隔天照樣看 11 小時 ════');
check('B07-01', '昨天 09:00–18:00 一段，晚上又只有 22:00 下班卡；今天 06:00 打上班（只隔 8 小時）→ 擋',
  clockIn(TD + 'T06:00:00', [ev(Y, '09:00', 'in'), ev(Y, '18:00', 'out'), ev(Y, '22:00', 'out')]).status, 'rejected_rest');
check('B07-02', '昨天整天只有一張 22:00 下班卡；今天 08:59:59 → 擋', clockIn(TD + 'T08:59:59', [ev(Y, '22:00', 'out')]).status, 'rejected_rest');
check('B07-03', '同上；今天 09:00:00（剛好 11 小時）→ 放行', clockIn(TD + 'T09:00:00', [ev(Y, '22:00', 'out')]).status, 'ok');
check('B07-04', '跨夜：今天凌晨 01:00 只有下班卡（昨晚的班忘了打上班）；今天 09:00 → 擋', clockIn(TD + 'T09:00:00', [ev(TD, '01:00', 'out')]).status, 'rejected_rest');
check('B07-05', '同上；今天 12:00（滿 11 小時）→ 放行', clockIn(TD + 'T12:00:00', [ev(TD, '01:00', 'out')]).status, 'ok');
{
  const m = make({ now: T(TD + 'T06:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [ev(Y, '22:00', 'out')] } });
  const st = m.sb.restStatus_(m.self, m.sb.readSheetAsObjects(m.self.sh.roster).rows[0]);
  check('B07-06', 'LINE 打卡頁開頁就看得到被擋與原因（逐字）', [st.blocked, st.reason], [true, '你 11/9 22:00 下班，兩班要隔 11 小時，09:00 以後才能打上班卡']);
}

console.log('\n════ 二、不該被擋的照舊不擋 ════');
check('B07-10', '規格的例外：昨天 13:00 上班、沒打下班卡（算不出間隔）；今天 05:00 → 不擋', clockIn(TD + 'T05:00:00', [ev(Y, '13:00', 'in')]).status, 'ok');
check('B07-11', '同一天的第二段不看間隔：今天 14:00 只有下班卡（早上忘了打上班），17:00 再上班 → 不擋', clockIn(TD + 'T17:00:00', [ev(TD, '14:00', 'out')]).status, 'ok');
check('B07-12', '被擋掉的下班卡（連按）不算：昨晚 22:00 的下班卡是 rejected_duplicate；今天 06:00 → 不擋', clockIn(TD + 'T06:00:00', [ev(Y, '22:00', 'out', 'rejected_duplicate')]).status, 'ok');
check('B07-13', '休息規則沒開（指令碼屬性沒設）：昨晚 22:00 下班卡、今天 06:00 → 不擋', clockIn(TD + 'T06:00:00', [ev(Y, '22:00', 'out')], {}).status, 'ok');
check('B07-14', '正常的一段照舊：昨天 13:00–22:00；今天 08:59:59 擋、09:00:00 放行',
  [clockIn(TD + 'T08:59:59', [ev(Y, '13:00', 'in'), ev(Y, '22:00', 'out')]).status, clockIn(TD + 'T09:00:00', [ev(Y, '13:00', 'in'), ev(Y, '22:00', 'out')]).status], ['rejected_rest', 'ok']);
{
  // 只有下班卡的那段不知道幾點上班，時數算 0：不會讓「今天已滿 10 小時」的提醒提早出現
  const m = make({ now: T(TD + 'T17:00:00'), props: { REST_RULE_ON: '1' }, self: { roster: [ME], events: [ev(TD, '06:00', 'in'), ev(TD, '15:00', 'out'), ev(TD, '16:30', 'out')] } });
  const st = m.sb.restStatus_(m.self, m.sb.readSheetAsObjects(m.self.sh.roster).rows[0]);
  check('B07-15', '今天 06:00–15:00（9 小時）＋一張 16:30 的孤單下班卡：17:00 開頁不擋、也沒有滿 10 小時的提醒', [st.blocked, st.warn === undefined], [false, true]);
}
done();
