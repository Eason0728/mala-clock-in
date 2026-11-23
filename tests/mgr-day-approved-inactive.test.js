/* 離職（名冊停用）同仁，離職日以前「已核定」的日子要繼續出現在當天的核定清單（mgr_day）。
 * 背景（2026-11-22）：墨竹亭六張犁 11/6 有一筆整天請假核定 0 小時（11/14 核定），名冊 11/16 停用後，11/6 清單就沒有她；
 * 總部有同仁 3 天核定 8 小時的出差日也一樣看不到。原因：mgr_day 只列「名冊在職」＋「當天有打卡事件」的人，
 * 停用者在「沒打卡但有核定」的日子兩邊都不沾。修正：當天 approved 分頁有核定列的人也補進清單（補在最後、不重複）。
 * 用真函式（沙盒載入 apps-script/*.gs）。名字一律假名。
 * 拿舊版對照：GS_ROOT=<放舊版 apps-script 的資料夾> node tests/mgr-day-approved-inactive.test.js（A1、A2 應該紅）。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const row = (o) => Object.assign({ key: 'K', device_id: 'D', line_user_id: 'U' }, o);
const D = '2026-11-06', OTHER = '2026-11-05';
const roster = [
  row({ emp_id: 'E01', name: '在職甲', active: 'TRUE' }),
  row({ emp_id: 'E02', name: '離職乙', active: 'FALSE', removed_at: '2026-11-16T10:00:00+08:00', removed_by: '人資' }),   // 全天請假 0 小時（有核定、沒打卡）
  row({ emp_id: 'E03', name: '離職丙', active: 'FALSE', removed_at: '2026-11-16T10:00:00+08:00', removed_by: '人資' }),   // 出差 8 小時（有核定、沒打卡）
  row({ emp_id: 'E04', name: '離職丁', active: 'FALSE', removed_at: '2026-11-16T10:00:00+08:00', removed_by: '人資' }),   // 沒打卡、沒核定
  row({ emp_id: 'E05', name: '離職戊', active: 'FALSE', removed_at: '2026-11-16T10:00:00+08:00', removed_by: '人資' }),   // 有打卡、也有核定
  row({ emp_id: 'E06', name: '離職己', active: 'FALSE', removed_at: '2026-11-16T10:00:00+08:00', removed_by: '人資' }),   // 核定已打回（列在 approved_revoked，不在 approved）
  row({ emp_id: 'E07', name: '在職庚', active: 'TRUE' }),
];
// approved 列：[日期, 工號, 姓名, 時段, 核定時數, 狀態, 主管, 核定時間, dup_ignore, diff_reason]
const ap = (date, emp, name, periods, h, at) => [date, emp, name, periods, h, '正常', '值班主管', at || (date + 'T18:00:00+08:00'), '', ''];
const approved = [
  ap(D, 'E02', '離職乙', '', 1, '2026-11-14T10:00:00+08:00'),   // 先核 1 小時，後來更正成 0
  ap(D, 'E02', '離職乙', '', 0, '2026-11-14T10:05:00+08:00'),                 // 同一人同一天兩筆：只能出現一次
  ap(D, 'E03', '離職丙', '09:00-17:00', 8),
  ap(D, 'E05', '離職戊', '09:00-17:00', 8),
  ap(D, 'E07', '在職庚', '09:00-17:00', 8),
  ap(D, 'E09', '名冊沒有的人', '09:00-12:00', 3),                              // 名冊完全沒有這個人：用核定列上的姓名
  ap(OTHER, 'E04', '離職丁', '09:00-17:00', 8),                               // 別天的核定不能讓 E04 出現在 11/6
];
const events = [[D + 'T09:00:00', 'E05', 'in'], [D + 'T17:00:00', 'E05', 'out'], [D + 'T08:55:00', 'E01', 'in'], [D + 'T17:05:00', 'E01', 'out']];
const leave = [[D, '離職乙', '事假', 8]];   // 請假 0 小時的那天，假別登記也要跟著帶出
const m = make({ now: T('2026-11-22T10:00:00'), self: { roster, events, approved, leave } });
// 核定被打回：留底分頁 approved_revoked（Requests.gs reqRevokeFinal_ 搬過去的列），approved 本表沒有這一列
const rev = m.self.insertSheet('approved_revoked');
rev.appendRow(['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason', 'revoked_at', 'revoke_reason']);
rev.appendRow(ap(D, 'E06', '離職己', '09:00-17:00', 8).concat(['2026-11-14T12:00:00+08:00', '作廢申請 r1']));

const day = (date) => { const r = m.sb.handleMgrDay({ mgr_key: 'MK', date: date }); const o = {}; r.employees.forEach((e) => { o[e.emp_id] = e; }); return { r: r, by: o, ids: r.employees.map((e) => e.emp_id) }; };
const d6 = day(D);

check('A1', '名冊停用、沒打卡、核定 0 小時（全天請假）→ 出現在清單且帶核定內容與假別', !!d6.by.E02 && d6.by.E02.approved && [d6.by.E02.name, d6.by.E02.approved.approved_hours, d6.by.E02.approved.manager_name, d6.by.E02.segments.length, d6.by.E02.reference, d6.by.E02.leave_type, d6.by.E02.leave_hours], ['離職乙', 0, '值班主管', 0, null, '事假', 8]);
check('A2', '名冊停用、沒打卡、核定 8 小時 → 出現，核定時段與時數都在', !!d6.by.E03 && d6.by.E03.approved && [d6.by.E03.name, d6.by.E03.approved.approved_hours, d6.by.E03.approved.periods], ['離職丙', 8, [{ start: '09:00', end: '17:00' }]]);
check('A3', '名冊停用、沒打卡、沒有核定（別天才有）→ 不出現', [d6.ids.indexOf('E04') >= 0, d6.ids.indexOf('E06') >= 0], [false, false]);
check('A4', '名冊停用、當天有打卡又有核定 → 只出現一次，打卡段與核定都在', [d6.ids.filter((x) => x === 'E05').length, d6.by.E05.segments.length, d6.by.E05.approved.approved_hours], [1, 1, 8]);
check('A5', '同一人同一天兩筆核定 → 只出現一次，取最新一筆', [d6.ids.filter((x) => x === 'E02').length, (d6.by.E02 || { approved: {} }).approved.approved_hours], [1, 0]);
check('A6', '核定已打回（列在 approved_revoked、不在 approved）→ 不因此被補進來', d6.ids.indexOf('E06'), -1);
check('A7', '名冊完全沒有的人有核定 → 出現，姓名用核定列上的', [d6.by.E09 && d6.by.E09.name, d6.by.E09 && d6.by.E09.approved.approved_hours], ['名冊沒有的人', 3]);
// 順序：有打卡的在前（E05 08:55 之後 09:00），在職沒打卡的依名冊順序（E07），停用者補最後（工號排序）：E02、E03、E09
check('A8', '清單順序：有打卡的在前、在職沒打卡的依名冊、停用有核定的補在最後', d6.ids, ['E01', 'E05', 'E07', 'E02', 'E03', 'E09']);
// 在職同仁的列不變：和只有在職兩人時的內容逐位元組相同
const act = (e) => JSON.stringify(e);
const evAct = events.filter((e) => e[1] === 'E01');   // 沒有停用者時，E05 的卡也不存在
const base = make({ now: T('2026-11-22T10:00:00'), self: { roster: roster.filter((r) => r.active === 'TRUE'), events: evAct, approved: approved.filter((a) => a[1] === 'E07'), leave } });
const bd = base.sb.handleMgrDay({ mgr_key: 'MK', date: D });
check('A9', '在職同仁（E01、E07）的列與順序，跟名冊裡沒有任何停用者時逐位元組相同', [act(d6.r.employees.filter((e) => e.emp_id === 'E01' || e.emp_id === 'E07')), d6.ids.filter((x) => x === 'E01' || x === 'E07')], [act(bd.employees), ['E01', 'E07']]);
// 沒有任何停用者有核定的日子：整份輸出（含欄位順序）只看在職者，跟停用者不存在時一樣
const o5 = day(OTHER);
check('A10', '別天（只有停用者 E04 有核定）→ 在職兩人照列，停用者 E04 補在最後', o5.ids, ['E01', 'E07', 'E04']);
const o4 = day('2026-11-04');
check('A11', '沒有任何人有核定的日子 → 只有在職者，輸出同沒有停用者', [act(o4.r), o4.ids], [act(make({ now: T('2026-11-22T10:00:00'), self: { roster: roster.filter((r) => r.active === 'TRUE'), events: evAct, approved: [], leave } }).sb.handleMgrDay({ mgr_key: 'MK', date: '2026-11-04' })), ['E01', 'E07']]);
// 欄位來源：停用者用名冊那一列的個人班別（沒填＝全店預設）；驗證補進來的列欄位集合跟名冊補進來的（有打卡的停用者 E05）一樣
check('A12', '補進來的列欄位集合與「停用但有打卡」的列相同（前端拿到同樣形狀）', Object.keys(d6.by.E02 || {}).sort(), Object.keys(d6.by.E05).filter((k) => k !== 'dup_groups').sort());
// 請求經營運系統那層（Liff.gs mgr_day 覆寫：REQ_HOME_EMPS 隱藏名單）也照常濾：設了隱藏名單的人，補進來的列一樣被濾掉
const m2 = make({ now: T('2026-11-22T10:00:00'), self: { roster, events, approved, leave }, props: { REQ_HOME_EMPS: JSON.stringify(['E03']) } });
const r2 = m2.sb.reqMgrDayHome_({ mgr_key: 'MK', date: D });
check('A13', '值班核定頁隱藏名單（REQ_HOME_EMPS）照樣生效：被隱藏的停用者不會因補進來而露出', r2.employees.map((e) => e.emp_id), ['E01', 'E05', 'E07', 'E02', 'E09']);
done();
