/* B24（2026-11-10 挑錯；2026-11-11 Eason 定：A 後端擋下，請主管改時段）：
 * 主管核定工時時，送來的時段彼此重疊（例如 09:00-13:00 與 12:00-13:00，或同一段填了兩次），後端照收，
 * 重疊的那一小時算兩次，核定時數就比實際多。
 * 修正：時段兩兩之間只要有重疊（含完全相同、含跨夜）就擋下、不寫入核定，回一句白話請主管改；
 *       剛好相接（前一段 13:00 結束、下一段 13:00 開始）不算重疊。
 * 用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const D = '2026-11-07';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
function approve(periods, extra) {
  const m = make({ now: T('2026-11-10T21:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']] } });
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods) }, extra || {}));
  return { ok: r.ok, error: r.error || '', message: r.message || '', hours: r.approved_hours === undefined ? null : r.approved_hours, 寫入列數: m.approved().length };
}
const blocked = (x) => [x.ok, x.error, x.寫入列數];

console.log('════ 一、時段重疊 → 擋下、不寫入 ════');
let r = approve('09:00-13:00,12:00-13:00');
check('B24-01', '09:00-13:00 與 12:00-13:00（重疊 1 小時）→ 擋下、核定表沒有新增', blocked(r), [false, 'bad_periods', 0]);
check('B24-02', '訊息講得出是哪兩段、要怎麼辦', r.message, '核定時段有重疊：09:00-13:00 和 12:00-13:00，請改成不重疊的時段');
r = approve('09:00-13:00,09:00-13:00');
check('B24-03', '同一段填了兩次 → 擋下', blocked(r), [false, 'bad_periods', 0]);
check('B24-04', '同一段填兩次的訊息', r.message, '核定時段有重疊：09:00-13:00 和 09:00-13:00，請改成不重疊的時段');
r = approve('14:00-18:00,09:00-15:00');
check('B24-05', '順序顛倒填（後面那段比較早）也擋', blocked(r), [false, 'bad_periods', 0]);
r = approve('09:00-18:00,12:00-13:00');
check('B24-06', '一段完全包在另一段裡面 → 擋下', blocked(r), [false, 'bad_periods', 0]);
r = approve('09:00-12:00,13:00-17:00,16:30-18:00');
check('B24-07', '三段裡第二、三段重疊 → 擋下，訊息指出這兩段', [blocked(r), r.message], [[false, 'bad_periods', 0], '核定時段有重疊：13:00-17:00 和 16:30-18:00，請改成不重疊的時段']);

console.log('\n════ 二、跨夜時段 ════');
r = approve('22:00-02:00,23:00-01:00');
check('B24-10', '22:00-02:00（跨夜）與 23:00-01:00（跨夜）→ 擋下', blocked(r), [false, 'bad_periods', 0]);
r = approve('17:00-23:00,22:00-02:00');
check('B24-11', '17:00-23:00 與 22:00-02:00（跨夜）→ 擋下', blocked(r), [false, 'bad_periods', 0]);
r = approve('11:00-14:00,17:00-02:00');
check('B24-12', '11:00-14:00 與 17:00-02:00（跨夜、不重疊）→ 照收，12 小時', [r.ok, r.hours, r.寫入列數], [true, 12, 1]);
r = approve('17:00-22:00,22:00-02:00');
check('B24-13', '17:00-22:00 與 22:00-02:00（剛好相接、後段跨夜）→ 照收，9 小時', [r.ok, r.hours, r.寫入列數], [true, 9, 1]);

console.log('\n════ 三、不該擋的照舊收 ════');
r = approve('09:00-13:00,13:00-18:00');
check('B24-20', '09:00-13:00 與 13:00-18:00（剛好相接）→ 照收，9 小時', [r.ok, r.hours, r.寫入列數], [true, 9, 1]);
r = approve('09:00-13:00,14:00-18:00');
check('B24-21', '一般兩頭班 09:00-13:00、14:00-18:00 → 照收，8 小時', [r.ok, r.hours, r.寫入列數], [true, 8, 1]);
r = approve('14:00-18:00,09:00-13:00');
check('B24-22', '兩段不重疊但順序顛倒填 → 照收，8 小時', [r.ok, r.hours, r.寫入列數], [true, 8, 1]);
r = approve('09:00-18:00');
check('B24-23', '只有一段 → 照收', [r.ok, r.hours, r.寫入列數], [true, 9, 1]);

console.log('\n════ 四、其他檢查的順序不變 ════');
r = approve('09:00-09:00,09:00-13:00');
check('B24-30', '起訖一樣的那段先被原本的檢查擋下（訊息是原本那句）', [r.ok, r.error, r.message], [false, 'bad_periods', '上班時段 09:00–09:00 開始和結束一樣，請確認']);
r = approve('09:00-13:00,12:00-25:00');
check('B24-31', '時間格式不對照舊先擋（沒有訊息）', [r.ok, r.error, r.message], [false, 'bad_periods', '']);
done();
