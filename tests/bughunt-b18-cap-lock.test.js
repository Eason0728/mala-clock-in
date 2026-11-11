/* B18（2026-11-10 挑錯）：生理假一年 3 次、家庭照顧假一年 7 天，用完就不能再申請（2026-11-10 定）。
 * 額度鎖有三個洞：
 *   ① 已核准、但那幾天主管還沒核定的假，不算已用（額度的「已用」只看核定後的請假登記，鎖又只扣審核中的單）——
 *      3 張生理假都核准了，第 4 張照樣送得出去。
 *   ② 年底請明年的假，被今年剩下的額度擋住（今年用完，明年 1 月的假送不出去）。
 *   ③ 今年還沒有任何一天核定過的人，額度表裡沒有這個假別，等於不設上限。
 * 修正：已核准而那天還沒核定的單一起扣；請的是別的年度就拿整年的上限來算；查不到額度時用法定上限（只擋「光是申請就超過整年上限」）。
 * 用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
/** 一個店：quota＝光復算出來的額度表（null＝查不到）；sent＝已經在申請表裡的請假單 [日期, 假別, 時數, 狀態]；leave＝已核定的請假登記 [日期, 假別, 時數] */
function world(now, quota, sent, leave) {
  const m = make({ now: T(now), self: { roster: [ME], events: [], leave: (leave || []).map((l) => [l[0], '測試一', l[1], l[2]]) } });
  m.sb.lineHubReqQuota_ = () => ({ quota: quota || [] });
  (sent || []).forEach((s, i) => {
    const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: s[1], date: s[0], hours: s[2], reason: '測試' });
    if (!r.ok) throw new Error('準備資料失敗：' + JSON.stringify(r));
    if (s[3] === 'approved') { const d = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' }); if (!d.ok) throw new Error('核准失敗：' + JSON.stringify(d)); }
  });
  return m;
}
const ask = (m, type, date, hours) => { const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: type, date: date, hours: hours, reason: '測試' }); return r.ok ? 'ok' : r.error + '｜' + r.message; };
const NOW = '2026-11-10T10:00:00';
const PER = (remain) => [{ name: '生理假', cap_h: 24, remain_h: remain }];
const FAM = (remain) => [{ name: '家庭照顧假', cap_h: 56, remain_h: remain }];

console.log('════ 一、已核准、那天還沒核定的假，也要算進已用 ════');
let m = world(NOW, PER(24), [['2026-11-12', '生理假', 8, 'approved'], ['2026-11-13', '生理假', 8, 'approved'], ['2026-11-16', '生理假', 8, 'approved']]);
check('B18-01', '生理假：3 張都核准了（那幾天還沒核定，額度還顯示剩 24 小時）→ 第 4 張擋', ask(m, '生理假', '2026-11-17', 8), 'quota_exhausted｜生理假今年 3 次已經用完（含審核中、已核准），不能再申請');
m = world(NOW, PER(24), [['2026-11-12', '生理假', 8, 'approved'], ['2026-11-13', '生理假', 8, 'approved']]);
check('B18-02', '生理假：核准 2 張 → 第 3 張可以送', ask(m, '生理假', '2026-11-17', 8), 'ok');
m = world(NOW, FAM(56), [1, 2, 3, 4, 5, 6, 7].map((i) => ['2026-11-' + (10 + i), '家庭照顧假', 8, 'approved']));
check('B18-03', '家庭照顧假：已核准 7 天（都還沒核定）→ 第 8 天擋', ask(m, '家庭照顧假', '2026-11-25', 8), 'quota_exhausted｜家庭照顧假今年 7 天只剩 0 小時（含審核中、已核准），這次超過了，不能送出');
// 已核准而且那天已經核定（記進請假登記）的，額度表已經扣過，不能再扣一次
m = world(NOW, PER(8), [['2026-11-03', '生理假', 8, 'approved'], ['2026-11-04', '生理假', 8, 'approved']], [['2026-11-03', '生理假', 8], ['2026-11-04', '生理假', 8]]);
check('B18-04', '生理假：2 張已核准而且都核定過了（額度剩 8 小時＝還有 1 次）→ 第 3 張可以送（不重複扣）', ask(m, '生理假', '2026-11-17', 8), 'ok');
m = world(NOW, PER(8), [['2026-11-03', '生理假', 8, 'approved'], ['2026-11-04', '生理假', 8, 'approved'], ['2026-11-12', '生理假', 8, 'approved']], [['2026-11-03', '生理假', 8], ['2026-11-04', '生理假', 8]]);
check('B18-05', '同上，再加 1 張已核准但還沒核定 → 第 4 張擋', ask(m, '生理假', '2026-11-17', 8).split('｜')[0], 'quota_exhausted');

console.log('\n════ 二、年底請明年的假，看的是明年的額度 ════');
m = world('2026-12-20T10:00:00', PER(0), []);
check('B18-10', '12/20 請 2027-01-05 的生理假（今年 3 次用完）→ 可以送', ask(m, '生理假', '2027-01-05', 8), 'ok');
check('B18-11', '同一個人 12/20 請今年 12/28 的生理假 → 擋', ask(m, '生理假', '2026-12-28', 8).split('｜')[0], 'quota_exhausted');
m = world('2026-12-20T10:00:00', PER(0), [['2027-01-05', '生理假', 8, 'approved'], ['2027-01-06', '生理假', 8, 'pending'], ['2027-01-07', '生理假', 8, 'pending']]);
check('B18-12', '明年的已經送了 3 張 → 明年的第 4 張擋，訊息寫 2027 年', ask(m, '生理假', '2027-01-08', 8), 'quota_exhausted｜生理假 2027 年 3 次已經用完（含審核中、已核准），不能再申請');

console.log('\n════ 三、額度表查不到這個假別（今年還沒有任何一天核定過）：用法定上限 ════');
m = world(NOW, [], [['2026-11-12', '生理假', 8, 'pending'], ['2026-11-13', '生理假', 8, 'approved'], ['2026-11-16', '生理假', 8, 'pending']]);
check('B18-20', '生理假：額度表沒有這一項，已送 3 張 → 第 4 張擋', ask(m, '生理假', '2026-11-17', 8).split('｜')[0], 'quota_exhausted');
m = world(NOW, [], [['2026-11-12', '生理假', 8, 'pending']]);
check('B18-21', '生理假：額度表沒有這一項，已送 1 張 → 第 2 張可以送', ask(m, '生理假', '2026-11-17', 8), 'ok');
const FIVE = [12, 13, 16, 17, 18].map((d) => ['2026-11-' + d, '家庭照顧假', 8, 'approved']);   // 已核准 5 天＝40 小時
check('B18-22', '家庭照顧假：查不到額度，已核准 40 小時 → 再請 16 小時（兩天）可以、第 8 天擋',
  [ask(world(NOW, null, FIVE), '家庭照顧假', '2026-11-20', 8), ask(world(NOW, null, FIVE.concat([['2026-11-19', '家庭照顧假', 8, 'approved']])), '家庭照顧假', '2026-11-20', 8),
   ask(world(NOW, null, FIVE.concat([['2026-11-19', '家庭照顧假', 8, 'approved'], ['2026-11-23', '家庭照顧假', 8, 'pending']])), '家庭照顧假', '2026-11-24', 8).split('｜')[0]], ['ok', 'ok', 'quota_exhausted']);

console.log('\n════ 四、原本就有的照舊 ════');
m = world(NOW, PER(8), [['2026-11-12', '生理假', 8, 'pending']]);
check('B18-30', '生理假剩 1 次、已有 1 張審核中 → 擋', ask(m, '生理假', '2026-11-17', 8).split('｜')[0], 'quota_exhausted');
m = world(NOW, FAM(8), []);
check('B18-31', '家庭照顧假剩 8 小時：請 8 小時可以、請 9 小時擋', [ask(m, '家庭照顧假', '2026-11-20', 8), ask(world(NOW, FAM(8), []), '家庭照顧假', '2026-11-20', 9).split('｜')[0]], ['ok', 'quota_exhausted']);
m = world(NOW, [{ name: '事假', cap_h: 112, remain_h: 0 }], []);
check('B18-32', '事假不在這條規則', ask(m, '事假', '2026-11-20', 8), 'ok');
done();
