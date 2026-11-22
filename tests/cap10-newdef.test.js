/* 滿 10 小時新定義（2026-11-23 Eason）：當日出勤＝打卡時數＋已核准假單時數＋已核准出差；央廚／總部扣固定不打卡休息，其餘門市不扣班表休息。
 * 設計與試算：~/加盟名單平台/_brain_out/cap10-newdef/design.md（每條測試編號後面括號＝對應設計第幾點／§）。
 * 用真函式跑（Code／Liff／Rest／Requests／DutyFeed＋Cap10；09:00 通知抽 Payroll.gs 的 payDayLoadOver_）。名字、工號一律假的。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { make, T, at, check, done, R, ROOT } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-20', D2 = '2026-11-21';
const HERE = Object.assign({ accuracy: 10 }, at(3));
const CF = { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' };
const HQ = { NO_PUNCH_BREAK_START: '14:00', NO_PUNCH_BREAK_END: '15:00' };
const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at'];
const EARLY = '2026-11-19T20:00:00+08:00';   // 預設前一天晚上就核准

function world(now, events, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props: Object.assign({ REQ_BIND_FROM: 'off', REST_CAP_ON: '1' }, opt.props || {}),
    self: { roster: [ME], events: events || [] }, peers: opt.peers, config: opt.config });
  m.run(R('apps-script/Cap10.gs'));
  if (opt.sched) {
    m.sb.REST_PEERS_ = (m.sb.REST_PEERS_ || []).filter((p) => p.ss !== 'SELF').concat([{ code: 'gf', ss: 'SELF' }]);
    const sh = m.self.insertSheet('sched_pub');
    sh.appendRow(['store', 'period', 'seq', 'data', 'last_op', 'updated_at']);
    sh.appendRow(['', 'T01', 1, JSON.stringify(opt.sched), 'op', '']);
  }
  if (opt.reqs) reqs(m, m.self, opt.reqs, 'E01');
  Object.keys(opt.peerReqs || {}).forEach((id) => reqs(m, m.peers[id], opt.peerReqs[id].rows, opt.peerReqs[id].emp));
  return m;
}
// 申請單簡寫：[kind, date, start, end, hours, status, decided_at]
function reqs(m, bk, list, emp) {
  const sh = bk.getSheetByName('requests') || bk.insertSheet('requests');
  if (!sh.values.length) sh.appendRow(RQH);
  list.forEach((r, i) => sh.appendRow(['r' + sh.values.length, '', emp, '', r[0], r[1], r[0] === 'trip' ? '出差' : '特休假', r[2], r[3], r[4], '', '', '', r[5] || 'approved', r[6] === undefined ? EARLY : r[6]]));
  Object.keys(m.cache).forEach((k) => { if (/^caplv1:/.test(k)) delete m.cache[k]; });   // 申請表快取 60 秒：改了申請表就清掉
}
const setStatus = (m, st) => { const sh = m.self.getSheetByName('requests'); sh.values.slice(1).forEach((r) => { r[13] = st; }); Object.keys(m.cache).forEach((k) => { if (/^caplv1:/.test(k)) delete m.cache[k]; }); };
const punch = (m, type) => m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: type, confirm_same: true }, HERE));
const status = (m) => m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
const sysRows = (m) => m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0);
const sysAt = (m, t) => { m.setNow(t); return status(m).cap.sys_hm; };
const lockedAt = (m, t) => { m.setNow(t); return status(m).cap.locked; };

console.log('════ 第 5 點：滿 10 那一刻（請假、出差加進來） ════');
{
  const m = world(D + 'T19:59:00', [[D + 'T14:00:00', 'E01', 'in']], { reqs: [['leave', D, '08:00', '12:00', 4]] });
  check('N01', '先請假後上班（§5 例）：上午 08–12 請假 4 小時、14:00 上班 → 19:59 還沒滿', status(m).cap.locked, false);
  check('N01b', '20:00 收卡（6＋4）', sysAt(m, D + 'T20:00:00'), '20:00');
}
{
  const m = world(D + 'T13:59:00', [[D + 'T08:00:00', 'E01', 'in']], { reqs: [['leave', D, '14:00', '18:00', 4]] });
  check('N02', '先上班後請假（假單已先核准）：08:00 上班、14–18 請假 → 13:59 還沒滿', status(m).cap.locked, false);
  check('N02b', '14:00 滿 10（6＋4）→ 14:05 開頁寫 14:00 的系統卡（請假開始那一刻）', sysAt(m, D + 'T14:05:00'), '14:00');
}
{
  const m = world(D + 'T17:00:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('N15', '假單晚核准（§5）：09:00 上班、17:00 還沒滿', status(m).cap.locked, false);
  m.setNow(D + 'T17:35:00');
  reqs(m, m.self, [['leave', D, '', '', 4, 'approved', D + 'T17:30:00+08:00']], 'E01');
  check('N15b', '17:30 才核准 4 小時假（打卡 8.5＋4 → 已超過）：系統卡記在核准那一刻 17:30，不往回記到 15:00（不把核准前已上的班抹掉）', status(m).cap.sys_hm, '17:30');
}
{
  const m = world(D + 'T16:00:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 2, 'approved', D + 'T15:00:00+08:00']] });
  check('N15c', '15:00 核准 2 小時假（核准時打卡 6＋2＝8，還沒滿）→ 16:00 還沒滿', status(m).cap.locked, false);
  check('N15d', '17:00 收卡（8＋2；核准之後照常往下算）', sysAt(m, D + 'T17:00:00'), '17:00');
}
{
  const m = world(D + 'T19:10:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('N14', '收卡在先（19:00）', status(m).cap.sys_hm, '19:00');
  m.setNow(D + 'T19:30:00');
  reqs(m, m.self, [['leave', D, '', '', 3]], 'E01');
  check('N14b', '收卡後才核准假單 → 不重寫、不改時間（仍 19:00、系統卡 1 張）', [status(m).cap.sys_hm, sysRows(m).length], ['19:00', 1]);
}
{
  const m = world(D + 'T18:10:00', [[D + 'T10:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 2]] });
  check('N14c', '只填時數的假 2 小時＋10:00 上班 → 18:00 收卡', status(m).cap.sys_hm, '18:00');
  setStatus(m, 'voided');
  m.setNow(D + 'T18:30:00');
  check('N14d', '收卡後假單被作廢 → 系統卡不收回（仍鎖、仍 18:00、1 張；設計預設：不回復）', [status(m).cap.locked, status(m).cap.sys_hm, sysRows(m).length], [true, '18:00', 1]);
}
{
  const m = world(D + 'T17:59:00', [[D + 'T10:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 2]] });
  check('N05', '只填時數的假（§2）照時數全算：10:00 上班＋2 小時 → 17:59 還沒滿', status(m).cap.locked, false);
  check('N05b', '18:00 收卡', sysAt(m, D + 'T18:00:00'), '18:00');
}

console.log('\n════ 第 1 點：假單、出差跟打卡重疊不重複算 ════');
{
  const m = world(D + 'T18:59:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '13:00', '17:00', 4]] });
  check('N03', '請 13–17 的假但人一直打卡在場：重疊不算兩次 → 18:59 還沒滿（不重疊扣的話 15:00 就會被收）', status(m).cap.locked, false);
  check('N03b', '19:00 收卡（跟沒請假一樣）', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T19:59:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T11:00:00', 'E01', 'out'], [D + 'T15:00:00', 'E01', 'in']],
    { reqs: [['trip', D, '10:00', '14:00', 4]] });
  check('N04', '出差 10–14 與打卡 09–11 重疊 1 小時：2＋3，15:00 上班 → 19:59 還沒滿', status(m).cap.locked, false);
  check('N04b', '20:00 收卡', sysAt(m, D + 'T20:00:00'), '20:00');
}
{
  const m = world(D + 'T18:59:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T13:00:00', 'E01', 'out'], [D + 'T16:00:00', 'E01', 'in']],
    { reqs: [['leave', D, '13:00', '15:00', 2], ['trip', D, '14:00', '16:00', 2]] });
  check('N22', '請假 13–15 與出差 14–16 互相重疊 1 小時：只算 3 小時；4＋3，16:00 上班 → 18:59 還沒滿', status(m).cap.locked, false);
  check('N22b', '19:00 收卡', sysAt(m, D + 'T19:00:00'), '19:00');
}

console.log('\n════ 第 4 點：央廚／總部扣固定不打卡休息（打卡與本店有時段的假都扣） ════');
{
  const m = world(D + 'T18:59:00', [[D + 'T13:00:00', 'E01', 'in']], { config: CF, reqs: [['leave', D, '08:00', '13:00', 5]] });
  check('N07', '央廚請 08–13 的假（單上 5 小時，含中午 12–13 休息）只算 4 小時，13:00 上班 → 18:59 還沒滿', status(m).cap.locked, false);
  check('N07b', '19:00 收卡（4＋6）', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T18:59:00', [[D + 'T08:00:00', 'E01', 'in']], { config: HQ, reqs: [['leave', D, '16:00', '18:00', 2]] });
  check('N08', '總部 08:00 上班、14–15 不打卡休息、16–18 請假但人在：休息不算、重疊不算 → 18:59 還沒滿', status(m).cap.locked, false);
  check('N08b', '19:00 收卡', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T20:00:00', [[D + 'T07:30:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { config: CF });
  check('N23', '央廚自己打 07:30–18:00（扣休息＝9.5 小時）→ 不擋上班卡（門市同樣打卡＝10.5 會擋，見 cap10 C78）', status(m).cap.in_block, false);
}

console.log('\n════ 第 3 點：跨店（姓名去空白對人） ════');
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測 試一', key: 'PK', active: 'TRUE' }], events: [] };
  const m = world(D + 'T16:59:00', [[D + 'T10:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, peerReqs: { PEER1: { emp: 'P9', rows: [['leave', D, '', '', 3]] } } });
  check('N09', '假單掛在別家店（同名在職）也算：別家 3 小時假＋本店 10:00 上班 → 16:59 還沒滿', status(m).cap.locked, false);
  check('N09b', '17:00 收卡', sysAt(m, D + 'T17:00:00'), '17:00');
}
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測試一', key: 'PK', active: 'TRUE' }], events: [[D + 'T07:00:00', 'P9', 'in'], [D + 'T10:00:00', 'P9', 'out']] };
  const m = world(D + 'T17:59:00', [[D + 'T12:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, reqs: [['leave', D, '', '', 1]] });
  check('N10', '跨店加總：別家打卡 07–10（3）＋本店假 1＋本店 12:00 上班 → 17:59 還沒滿', status(m).cap.locked, false);
  check('N10b', '18:00 收卡', sysAt(m, D + 'T18:00:00'), '18:00');
}
{
  const PEER = { roster: [{ emp_id: 'P9', name: '別人', key: 'PK', active: 'TRUE' }], events: [] };
  const m = world(D + 'T12:00:00', [[D + 'T10:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, peerReqs: { PEER1: { emp: 'P9', rows: [['leave', D, '', '', 8]] } } });
  check('N09c', '別家店不同名的人的假不算', m.sb.capLeavesFor_(m.self, ME, T(D + 'T12:00:00')).length, 0);
}

console.log('\n════ 滿 10 含剛好 10、已核准才算 ════');
{
  const m = world(D + 'T17:59:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T14:00:00', 'E01', 'in']], { reqs: [['leave', D, '12:00', '14:00', 2]] });
  check('N11', '4＋假 2＋14:00 上班 → 17:59 還沒滿', status(m).cap.locked, false);
  check('N11b', '剛好 10 小時（18:00:00）就收', sysAt(m, D + 'T18:00:00'), '18:00');
}
{
  const m = world(D + 'T19:30:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']],
    { reqs: [['leave', D, '17:00', '19:00', 2]] });
  check('N11c', '打卡 8＋假 2＝剛好 10 → 擋上班卡（in_block）', status(m).cap.in_block, true);
  const r = punch(m, 'in');
  check('N11d', '再打上班卡 → 不收（cap_locked 那一類的擋）', r.ok === false || /reject|cap/.test(String(r.status || r.error)), true);
}
{
  const m = world(D + 'T19:30:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']],
    { reqs: [['leave', D, '', '', 1.75]] });
  check('N11e', '打卡 8＋假 1.75＝9.75 → 不擋上班卡', status(m).cap.in_block, false);
}
{
  const m = world(D + 'T20:00:00', [[D + 'T14:00:00', 'E01', 'in']],
    { reqs: [['leave', D, '08:00', '12:00', 4, 'pending'], ['leave', D, '', '', 4, 'rejected'], ['trip', D, '', '', 4, 'cancelled'], ['leave', D, '', '', 4, 'voided']] });
  check('N12', '審核中／退回／取消／作廢的單都不算（§預設 ②）', [m.sb.capLeavesFor_(m.self, ME, T(D + 'T20:00:00')).length, status(m).cap.locked], [0, false]);
  check('N12b', '只算打卡：14:00 上班 → 隔天 00:00 才收', sysAt(m, D2 + 'T00:00:00'), '00:00');
}
{
  const m = world(D + 'T18:00:00', [[D + 'T14:00:00', 'E01', 'in']], { reqs: [['ot', D, '08:00', '12:00', 4], ['miss', D, '', '', '', 'approved']] });
  check('N12c', '加班單、忘打卡單不算假單', m.sb.capLeavesFor_(m.self, ME, T(D + 'T18:00:00')).length, 0);
}

console.log('\n════ 第 2 點：跨日、跨夜、日期格式 ════');
{
  const m = world(D + 'T23:59:00', [[D + 'T16:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 2]] });
  check('N19', '跨夜班：11/20 16:00 上班＋11/20 的假 2 小時 → 23:59 還沒滿', status(m).cap.locked, false);
  check('N19b', '11/21 00:00 收卡（段落歸上班那天、用那天的假）', sysAt(m, D2 + 'T00:00:00'), '00:00');
}
{
  const m = world(D2 + 'T01:59:00', [[D + 'T16:00:00', 'E01', 'in']], { reqs: [['leave', D2, '', '', 4]] });
  check('N19c', '11/21 的假不算進 11/20 上班的那段：01:59 還沒滿', status(m).cap.locked, false);
  check('N19d', '02:00 收卡（10 小時，只算打卡）', sysAt(m, D2 + 'T02:00:00'), '02:00');
}
{
  const m = world(D + 'T21:30:00', [[D + 'T13:00:00', 'E01', 'in'], [D + 'T21:00:00', 'E01', 'out']], { reqs: [['leave', D, '22:00', '02:00', 4]] });
  check('N21', '跨夜的假（22:00–02:00 記在 11/20）整段算 11/20：打卡 8＋假 4 → 擋上班卡', status(m).cap.in_block, true);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T13:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 4]] });
  const sh = m.self.getSheetByName('requests');
  sh.values[1][7] = new Date(T(D + 'T08:00:00')); sh.values[1][8] = new Date(T(D + 'T12:00:00'));   // Sheets 把時間轉成日期物件
  Object.keys(m.cache).forEach((k) => { if (/^caplv1:/.test(k)) delete m.cache[k]; });
  const lv = m.sb.capLeavesFor_(m.self, ME, T(D + 'T19:00:00'))[0];
  check('N20', '時段被轉成日期物件也讀得懂（08:00–12:00、4 小時、核准時間照讀）', [lv.a === T(D + 'T08:00:00'), lv.b === T(D + 'T12:00:00'), lv.ms, lv.dec === Date.parse(EARLY)], [true, true, 4 * 3600000, true]);
  check('N20b', '4＋13:00 上班 → 19:00 收卡', status(m).cap.sys_hm, '19:00');
}

console.log('\n════ 第 6 點：換版當下（舊規則還沒收、新規則已經超過） ════');
{
  const LONG = { id: 'L', name: '長班', start: '11:00', end: '21:30', break_min: 30 };
  const sched = { start: '2026-11-01', shifts: [LONG], rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'L' } : { t: 'R' })) }] };
  const m = world(D + 'T21:25:00', [[D + 'T11:00:00', 'E01', 'in']], { sched });
  check('N16', '11:00 上班、班別休息 30 分沒打卡：舊規則 21:30 才收；21:25 換上新版第一次檢查 → 系統卡往回記在 21:00（21:00–21:25 的班會被抹掉）＝換版要挑沒人在上班的時段（設計第 6 點）', status(m).cap.sys_hm, '21:00');
}

{
  const m = world(D + 'T19:00:00', [[D + 'T13:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 4, 'approved', '']] });
  const lv = m.sb.capLeavesFor_(m.self, ME, T(D + 'T19:00:00'))[0];
  check('N20c', '核准時間空白（不該發生）＝當成現在才知道：dec＝現在，不往回算', lv.dec, T(D + 'T19:00:00'));
}

console.log('\n════ 第 7 點：mini 擋卡引擎沒有 requests 分頁 ════');
{
  const m = world(D + 'T19:00:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('N17', '沒有 requests 分頁：讀假單回 []、不出錯，照打卡收（19:00）', [m.sb.capLeavesFor_(m.self, ME, T(D + 'T19:00:00')).length, status(m).cap.sys_hm], [0, '19:00']);
}

console.log('\n════ 開關 REST_CAP_ON（保護同仁的機制：行為跟改版前一樣） ════');
['', '0', 'true', '1 ', 'on'].forEach((v, i) => {
  const m = world(D + 'T13:00:00', [[D + 'T09:00:00', 'E01', 'in']], { props: { REST_CAP_ON: v }, reqs: [['leave', D, '', '', 8]] });
  check('N13' + 'abcde'[i], 'REST_CAP_ON＝' + JSON.stringify(v) + '（不是剛好 "1"）：打卡 4＋假 8 也完全不收卡、下班卡照收', [status(m).cap.locked, punch(m, 'out').ok, sysRows(m).length], [false, true, 0]);
});
{
  const m = world(D + 'T13:00:00', [[D + 'T09:00:00', 'E01', 'in']], { props: { REST_CAP_ON: '1' }, reqs: [['leave', D, '', '', 8]] });
  check('N13f', 'REST_CAP_ON＝"1"：同一個人（前一天就核准 8 小時假）11:00 就滿（2＋8）→ 13:00 開頁寫 11:00 的系統卡', status(m).cap.sys_hm, '11:00');
}

console.log('\n════ 第 8 點：打卡頁提醒（Rest.gs）跟收卡用同一支算 ════');
const restWarn = (m) => { const s = m.sb.restStatus_(m.self, ME); return s.warn ? s.warn.code : (s.blocked ? 'blocked:' + s.code : null); };
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:30:00', 'E01', 'out']], { config: CF, props: { REST_RULE_ON: '1', REST_CAP_ON: '' } });
  check('N18', '央廚 08:00–18:30（打卡 10.5、扣中午休息＝9.5）→ 再打上班卡不跳 10 小時提醒（舊版照打卡加總會跳）', restWarn(m), null);
}
{
  const m = world(D + 'T18:00:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '' }, reqs: [['leave', D, '', '', 2]] });
  check('N18b', '門市打卡 8＋已核准假 2 → 再打上班卡跳 10 小時提醒（舊版 8 小時不跳）', restWarn(m), 'cap');
  const r = m.sb.restStatus_(m.self, ME);
  check('N18c', '提醒照收、不擋（blocked false）', r.blocked, false);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T13:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '' } });
  const ev = m.self.sh.events;
  ev.values[0].push('mirror_src');
  ev.values.splice(1, 0, ['2026-11-20T08:00:00+08:00', 'E01', 'in', '', '', '', '', 'D1', '', 'ok', '', 'CF'], ['2026-11-20T13:00:00+08:00', 'E01', 'out', '', '', '', '', 'D1', '', 'ok', '', 'CF']);
  check('N18d', '總部鏡像列（mirror_src）不算：真的只有 13–18（5 小時）→ 不跳提醒（舊版把鏡像 08–13 也加進去＝10 會跳）', restWarn(m), null);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '' } });
  m.sb.capTodayMs_ = () => { throw new Error('壞掉'); };
  check('N18e', 'Cap10 算失敗 → 提醒退回原本的打卡加總（10 小時照樣提醒），不擋打卡', restWarn(m), 'cap');
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { config: CF, props: { REST_RULE_ON: '1', REST_CAP_ON: '1' } });
  const st = status(m);
  check('N18f', '同一個人：收卡算的今日時數＝提醒算的（9 小時，同一支 capJudge_）', [st.cap.in_block, Math.round(m.sb.capTodayMs_(m.self, ME, T(D + 'T19:00:00'), null) / 360000) / 10], [false, 9]);
}

console.log('\n════ 09:00 通知匣（Payroll.gs payDayLoadOver_）════');
{
  const code = R('apps-script/Code.gs'), pay = R('apps-script/Payroll.gs');
  const extract = (src, name) => { const i = src.search(new RegExp('\\nfunction ' + name + '\\(')); let j = src.indexOf('{', i), dep = 0, k = j; for (; k < src.length; k++) { if (src[k] === '{') dep++; else if (src[k] === '}') { dep--; if (!dep) break; } } return src.slice(i, k + 1); };
  const sb = { Date, String, Number, Math, JSON, isNaN, isFinite, Object, Array, PAY_DAY_MAX_H: 10, payNum: (v) => Number(v) || 0 };
  vm.createContext(sb);
  vm.runInContext(['buildLatestApprovedMap', 'normCellDate', 'normCellTs'].map((f) => extract(code, f)).join('\n') + '\n' + extract(pay, 'payDayLoadOver_'), sb);
  const ap = (emp, name, h, periods, extra) => Object.assign({ date: D, emp_id: emp, name, approved_hours: h, periods: periods || '', entered_at: D + 'T22:00:00+08:00' }, extra || {});
  const lv = (name, type, h, extra) => Object.assign({ '日期': D, '姓名': name, '假別': type, '時數': h }, extra || {});
  const run = (stores) => Array.from(sb.payDayLoadOver_(D, stores)).map((x) => [x.store, x.name, x.hours, x.approved_h, x.leave_h, x.periods]);
  check('P1', '核定 8＋特休 2＝剛好 10 → 列（含剛好 10）', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王一', 8, '09:00-17:00')], leave: [lv('王一', '特休假', 2)] }]), [['A', '王一', 10, 8, 2, '09:00-17:00']]);
  check('P2', '出差已在核定時數裡（核定 10＝上班 8＋出差 2），leave 分頁的出差那列不重算 → 10 不是 12', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王一', 10, '09:00-17:00')], leave: [lv('王一', '出差', 2)] }]), [['A', '王一', 10, 10, 0, '09:00-17:00']]);
  check('P3', '9.99 不列；7.33＋2.67（浮點）＝10 列', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王一', 9.99), ap('A2', '李二', 7.33)], leave: [lv('李二', '病假', 2.67)] }]).map((x) => x[1]), ['李二']);
  check('P4', '跨店同名加總：甲 6＋乙 4 → 一筆，店＝核定多的甲，時段兩家都列', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王 一', 6, '09:00-15:00')], leave: [] }, { store: 'B', store_name: '乙店', approved: [ap('B7', '王一', 4, '17:00-21:00')], leave: [] }]),
    [['A', '王 一', 10, 10, 0, '甲店 09:00-15:00；乙店 17:00-21:00']]);
  check('P5', '總部鏡像列（approved、leave 的 mirror_src）不算：央廚 8＋鏡像 8＋鏡像假 2 → 不列', run([{ store: 'CF', store_name: '央廚', approved: [ap('HQ-01', '吳五', 8)], leave: [] }, { store: 'HQ', store_name: '總部', approved: [ap('HQ-01', '吳五', 8, '', { mirror_src: 'CF' })], leave: [lv('吳五', '特休假', 2, { mirror_src: 'CF' })] }]), []);
  check('P6', '只有請假、那天沒有核定的人不列；時數空白的假不算', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王一', 9)], leave: [lv('陳六', '特休假', 12), lv('王一', '事假', '')] }]), []);
  check('P7', '同一天多筆核定取最新（舊 11 新 9）＋假 1 → 10 列', run([{ store: 'A', store_name: '甲店', approved: [ap('A1', '王一', 11, '', { entered_at: D + 'T20:00:00+08:00' }), ap('A1', '王一', 9, '', { entered_at: D + 'T21:00:00+08:00' })], leave: [lv('王一', '補休', 1)] }]).map((x) => x[2]), [10]);
}
done();
