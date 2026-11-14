/* 行政群「本期加班補休」（comp，2026-11-14 Eason：班表截止前 15／10／5 天，跟考勤異常不同則）。
 * comp 自成一則、不加考勤異常標題；送 comp 不會取代當天還沒帶出的考勤異常、也不改 ATT_RUN（09:30 保底照常）；
 * 新的 comp 只取代舊的 comp；考勤批不取代 comp。用真函式跑，內容假的。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const m = make({ now: T('2026-11-18T09:00:00'), props: { ATT_ALERT_SVC_KEY: 'SVC' } });
m.run(R('apps-script/AttAlert.gs'));
const sb = m.sb;
const enq = (o) => sb.handleAttAlertEnqueue(Object.assign({ svcKey: 'SVC', run_date: '2026-11-18' }, o));
const rows = () => sb.attAlertReadRows_(sb.attAlertSheet_());
const prop = (k) => sb.PropertiesService.getScriptProperties().getProperty(k);
const pend = (sec) => rows().filter((r) => r.section === sec).map((r) => r.status);

check('C01', 'comp 不是字串陣列 → bad_input', enq({ batch_id: 'c0', comp: [1] }).error, 'bad_input');
enq({ batch_id: 'daily-1', seq: 5, state: [{ store: '', lines: ['測試一 本期空白 2 天'] }] });
check('C02', '考勤批照常設 ATT_RUN＝received', prop('ATT_RUN_2026-11-18'), 'received');
sb.PropertiesService.getScriptProperties().deleteProperty('ATT_RUN_2026-11-18');
const lines = ['【加班補休】本期班表 11/01～11/28', '截止前 10 天（統計到 11/17）', '▍小辛辣光復', '・甲君　加班 2、補休 8，欠 6 小時', '※ 欠的請在 11/28 前調整排班。'];
check('C03', '只有 comp 的批次寫成 comp 列', [enq({ batch_id: 'comp-1', seq: 9, comp: lines }).ok, pend('comp')], [true, ['pending', 'pending', 'pending', 'pending', 'pending']]);
check('C04', '送 comp 不會取代當天還沒帶出的考勤異常（seq 比較大也一樣）', pend('state'), ['pending']);
check('C05', '送 comp 不改 ATT_RUN（09:30 保底照常判斷 mini 今天有沒有送考勤）', prop('ATT_RUN_2026-11-18'), null);
const msgs = sb.attAlertCompose_(rows(), {});
check('C06', '帶出：comp 一則在前、考勤異常一則在後', [msgs.length, msgs[0], msgs[1].indexOf('【考勤異常】') === 0],
  [2, '【加班補休】本期班表 11/01～11/28\n截止前 10 天（統計到 11/17）\n\n▍小辛辣光復\n・甲君　加班 2、補休 8，欠 6 小時\n\n※ 欠的請在 11/28 前調整排班。', true]);
check('C07', 'comp 列不會被當成沒印出', sb.attAlertHiddenIds_(rows().filter((r) => r.section === 'comp'), msgs, {}), []);
enq({ batch_id: 'daily-2', seq: 20, state: [{ store: '', lines: ['測試二'] }] });
check('C08', '之後的考勤批不會取代 comp', pend('comp'), ['pending', 'pending', 'pending', 'pending', 'pending']);
check('C09', '考勤批照常取代舊考勤', pend('state'), ['superseded', 'pending']);
enq({ batch_id: 'comp-2', seq: 3, comp: ['【加班補休】新的'] });
check('C10', '新的 comp 批取代舊的 comp（不看 seq）', pend('comp'), ['superseded', 'superseded', 'superseded', 'superseded', 'superseded', 'pending']);
check('C11', '只有 comp 時一則、內容是新的', sb.attAlertCompose_(rows().filter((r) => r.section === 'comp' && r.status === 'pending'), {}), ['【加班補休】新的']);
check('C12', '同一批重送回 dup、不改 ATT_RUN', [enq({ batch_id: 'comp-2', seq: 3, comp: ['【加班補休】新的'] }).dup, prop('ATT_RUN_2026-11-18')], [true, 'received']);
// notice 也是旁支批次：不再取代考勤異常（原本會，2026-11-14 skill 有記這個坑）
enq({ batch_id: 'notice-1', seq: 99, notice: ['公告'] });
check('C13', 'notice 批也不取代考勤異常', pend('state'), ['superseded', 'pending']);
done();
