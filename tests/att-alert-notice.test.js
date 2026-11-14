/* 行政群一次性公告（notice，2026-11-14 Eason：滿 10 小時收卡店長說明「不要考勤異常那句」）。
 * notice 自成一則、不加標題與結尾、放最前面；不被之後的批次取代；其他列照原本版面。用真函式跑，內容假的。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const m = make({ now: T('2026-11-14T18:00:00'), props: { ATT_ALERT_SVC_KEY: 'SVC' } });
m.run(R('apps-script/AttAlert.gs'));
const sb = m.sb;
const enq = (o) => sb.handleAttAlertEnqueue(Object.assign({ svcKey: 'SVC', run_date: '2026-11-14' }, o));
const rows = () => sb.attAlertReadRows_(sb.attAlertSheet_());

check('N01', '錯金鑰擋', enq({ svcKey: 'X', batch_id: 'n1', notice: ['a'] }).error, 'unauthorized');
check('N02', 'notice 不是字串陣列 → bad_input', enq({ batch_id: 'n1', notice: 'abc' }).error, 'bad_input');
check('N03', '只有 notice 也算有內容、寫成 notice 列', [enq({ batch_id: 'n1', seq: 5, notice: ['▍標題一', '第一點', '第二點', '▍標題二', '第三點'] }).ok, rows().map((r) => r.section + ':' + r.status)],
  [true, ['notice:pending', 'notice:pending', 'notice:pending', 'notice:pending', 'notice:pending']]);
const msgs = sb.attAlertCompose_(rows(), {});
check('N04', '帶出：一則、沒有「考勤異常」標題與結尾', msgs, ['▍標題一\n・第一點\n・第二點\n\n▍標題二\n・第三點']);
enq({ batch_id: 'daily-1', seq: 9, state: [{ store: '', lines: ['測試一 本期空白 2 天'] }] });
check('N05', '之後的考勤批次不會把公告取代掉', rows().filter((r) => r.section === 'notice').map((r) => r.status), ['pending', 'pending', 'pending', 'pending', 'pending']);
const both = sb.attAlertCompose_(rows(), {});
check('N06', '兩種都有：公告在第一則，第二則是原本的考勤異常（有標題）', [both.length, both[0].indexOf('【考勤異常】'), both[1].indexOf('【考勤異常】') === 0], [2, -1, true]);
check('N07', '公告列不會被當成沒印出（不記 truncated）', sb.attAlertHiddenIds_(rows().filter((r) => r.section === 'notice'), both, {}), []);
done();
