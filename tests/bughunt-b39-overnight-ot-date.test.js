/* B39（2026-11-10 挑錯）：跨夜班的加班發生在凌晨。加班單的日期如果填凌晨那一天，上班那天核定時算「已核准 0 小時」被擋，
 * 凌晨那天又因為「沒超過 8 小時卻有加班單」被要求作廢——兩天都核不過。（下班打卡後的加班提示本來就帶上班那一天。）
 * 修正：送加班單時，這段時間如果落在前一天上班的跨夜班裡，請同仁把日期改選上班那一天。核定與薪資怎麼算單不動。
 * 用真函式跑，名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const res = (r) => (r.ok ? 'ok' : r.error + '｜' + r.message);
const D = '2026-11-12', N = '2026-11-13';
function world(events, now) { return make({ now: T(now || '2026-11-13T10:00:00'), self: { roster: [ME], events: events || [] } }); }
function submit(m, body) { m.advance(1000); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', kind: 'ot', reason: '結帳' }, body)); }
const NIGHT = [[D + 'T17:00:00', 'E01', 'in'], [N + 'T02:00:00', 'E01', 'out']];

check('B39-01', '11/12 17:00–隔天 02:00 的跨夜班：加班 01:00–02:00 日期填凌晨那天（11/13）→ 請改選上班那一天',
  res(submit(world(NIGHT), { date: N, start: '01:00', end: '02:00' })), 'bad_date｜01:00–02:00 在 11/12 上班的跨夜班裡（11/12 17:00 上班、隔天 02:00 下班），加班單的日期請選上班那一天（11/12）');
check('B39-02', '日期填上班那一天（11/12）→ 收', res(submit(world(NIGHT), { date: D, start: '01:00', end: '02:00' })), 'ok');
check('B39-03', '跨過午夜的加班 23:30–02:00、日期填上班那一天 → 收', res(submit(world(NIGHT), { date: D, start: '23:30', end: '02:00' })), 'ok');
check('B39-04', '日期填凌晨那天、時段 00:00–02:00 → 請改選上班那一天', res(submit(world(NIGHT), { date: N, start: '00:00', end: '02:00' })).split('｜')[0], 'bad_date');
// 對照：凌晨那天自己的班（跨夜班下班之後才開始的時段）照收
const NEXT = NIGHT.concat([[N + 'T09:00:00', 'E01', 'in'], [N + 'T19:00:00', 'E01', 'out']]);
check('B39-10', '對照：11/13 自己的班 09:00–19:00，加班 17:00–19:00 日期填 11/13 → 收', res(submit(world(NEXT, '2026-11-13T20:00:00'), { date: N, start: '17:00', end: '19:00' })), 'ok');
check('B39-11', '對照：前一天不是跨夜班（17:00–23:00），11/13 填 01:00–02:00 → 不擋', res(submit(world([[D + 'T17:00:00', 'E01', 'in'], [D + 'T23:00:00', 'E01', 'out']]), { date: N, start: '01:00', end: '02:00' })), 'ok');
check('B39-12', '對照：前一天跨夜班 02:00 下班，11/13 填 02:00–03:00（下班之後）→ 不擋', res(submit(world(NIGHT), { date: N, start: '02:00', end: '03:00' })), 'ok');
check('B39-13', '對照：預先申請（未來的日子，還沒有打卡）→ 不擋', res(submit(world([], '2026-11-10T10:00:00'), { date: N, start: '01:00', end: '02:00' })), 'ok');
{
  // 獨立審查補：連續兩晚跨夜班，第二晚的凌晨加班單日期照規定填上班那天（11/12）→ 要收（下班後的加班提示給的也是這一天）
  const TWO = [['2026-11-11T17:00:00', 'E01', 'in'], [D + 'T02:00:00', 'E01', 'out'], [D + 'T17:00:00', 'E01', 'in'], [N + 'T02:30:00', 'E01', 'out']];
  check('B39-30', '連兩晚夜班：11/12 那一班的加班 01:00–02:30、日期填 11/12 → 收', res(submit(world(TWO), { date: D, start: '01:00', end: '02:30' })), 'ok');
  check('B39-31', '同上 00:30–02:30 → 收', res(submit(world(TWO), { date: D, start: '00:30', end: '02:30' })), 'ok');
  check('B39-32', '連兩晚夜班：日期填成凌晨那天（11/13）→ 照樣請改選 11/12', res(submit(world(TWO), { date: N, start: '01:00', end: '02:30' })).split('｜')[0], 'bad_date');
  // 跨夜班的下班卡是用忘打卡申請補的 → 一樣要擋
  const m = world([[D + 'T17:00:00', 'E01', 'in']]);
  const miss = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'miss', date: D, miss_type: 'out', end: '02:00', reason: '忘記按' });
  check('B39-33', '下班卡 02:00 是用忘打卡申請補的（審核中）：加班單日期填凌晨那天 → 一樣請改選上班那一天', [miss.ok, res(submit(m, { date: N, start: '01:00', end: '02:00' })).split('｜')[0]], [true, 'bad_date']);
}
{
  // 店長代開同一套
  const m = world(NIGHT, '2026-12-05T10:00:00');   // 2026-11-14 起 11/28 以前 11 月的日子同仁自己能補、不給代開，改到 12/5 才是「超過 4 天」
  m.advance(1000);
  const r = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E01', kind: 'ot', date: N, start: '01:00', end: '02:00', reason: '代開' });
  check('B39-20', '店長代開：日期填凌晨那天 → 一樣請改選上班那一天', res(r).split('｜')[0], 'bad_date');
}
done();
