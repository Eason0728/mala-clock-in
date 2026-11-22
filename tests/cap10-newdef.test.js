/* 滿 10 小時新定義（2026-11-23 Eason）：當日出勤＝打卡時數＋已核准假單時數＋已核准出差；央廚／總部扣固定不打卡休息，其餘門市不扣班表休息。
 * 設計與試算：~/加盟名單平台/_brain_out/cap10-newdef/design.md（測試對照在 §10；「★」＝改動前 60d1338 會紅的那幾條，驗收擋項的迴歸）。
 * 即時收卡、擋上班卡只算「有時段」的單（主管 2026-11-23 確認）；上班中才核准的不當場收（CAP_LIVE_LATE_OK＝false，預設、待主管決定）。
 * 用真函式跑（Code／Liff／Rest／Requests／DutyFeed＋Cap10；09:00 通知抽 Payroll.gs 的 payDayLoadOver_）。名字、工號一律假的。 */
'use strict';
const vm = require('vm');
const { make, T, at, check, done, R } = require('./helpers/gs-sandbox');
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
  if (opt.live) Object.keys(opt.live).forEach((k) => { m.sb[k] = opt.live[k]; });   // 切換另一種做法（CAP_LIVE_LATE_OK）
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
// 申請單簡寫：[kind, date, start, end, hours, status, decided_at, leave_type]
function reqs(m, bk, list, emp) {
  const sh = bk.getSheetByName('requests') || bk.insertSheet('requests');
  if (!sh.values.length) sh.appendRow(RQH);
  list.forEach((r) => sh.appendRow(['r' + sh.values.length, '', emp, '', r[0], r[1], r[7] || (r[0] === 'trip' ? '出差' : '特休假'), r[2], r[3], r[4], '', '', '', r[5] || 'approved', r[6] === undefined ? EARLY : r[6]]));
  Object.keys(m.cache).forEach((k) => { if (/^caplv1:/.test(k)) delete m.cache[k]; });   // 申請表快取 60 秒：改了申請表就清掉
}
const setStatus = (m, st) => { const sh = m.self.getSheetByName('requests'); sh.values.slice(1).forEach((r) => { r[13] = st; }); Object.keys(m.cache).forEach((k) => { if (/^caplv1:/.test(k)) delete m.cache[k]; }); };
const punch = (m, type) => m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: type, confirm_same: true }, HERE));
const status = (m) => m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
const sysRows = (m) => m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0);
const sysAt = (m, t) => { m.setNow(t); return status(m).cap.sys_hm; };
const lockedAt = (m, t) => { m.setNow(t); return status(m).cap.locked; };
const evRaw = (ts, type, extra) => Object.assign(['2026-11-20T' + ts + ':00+08:00', 'E01', type, '', '', '', '', 'D1', '', 'ok', ''], extra || {});

console.log('════ 擋項 1：只填時數的單不進即時收卡（主管 11/23 確認）、當天沒打卡不擋、重複的單 ════');
{
  const m = world(D + 'T11:05:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 8]] });
  check('B1a★', '整天假 8 小時（只填時數）又來上班：不算進即時收卡 → 11:05 不收、下班卡照收', [status(m).cap.locked, sysRows(m).length], [false, 0]);
  check('B1a2', '只算打卡：19:00 才收', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T09:00:00', [], { reqs: [['leave', D, '', '', 8], ['trip', D, '', '', 8]] });
  const s = status(m);
  check('B1b★', '已核准假 8＋出差 8（只填時數）、今天還沒打卡 → 上班卡不擋', [s.cap.in_block, s.cap.locked], [false, false]);
  check('B1b2', '打上班卡成功', punch(m, 'in').ok, true);
  m.setNow(D + 'T09:10:00');
  check('B1b3', '上班 10 分鐘後沒被收', [status(m).cap.locked, sysRows(m).length], [false, 0]);
}
{
  const m = world(D + 'T17:30:00', [], { reqs: [['trip', D, '00:00', '08:00', 8], ['trip', D, '08:00', '16:00', 8]] });
  check('B1c★', '有時段的出差兩張共 16 小時、今天還沒打卡 → 上班卡不擋', status(m).cap.in_block, false);
  punch(m, 'in');
  m.setNow(D + 'T17:35:00');
  check('B1c2', '假單本身 ≥ 10 小時＝資料異常、不拿來即時收卡：17:30 上班後不會馬上被收', [status(m).cap.locked, sysRows(m).length], [false, 0]);
}
{
  const m = world(D + 'T15:00:00', [[D + 'T10:00:00', 'E01', 'in']], { reqs: [['leave', D, '', '', 4, 'approved', EARLY, '事假'], ['leave', D, '', '', 4, 'approved', EARLY, '事假']] });
  check('B1d★', '同一筆假 LINE 申請＋店長代開各一張（只填時數 4 小時）：不算進即時收卡，更不會算成 8 → 15:00 沒鎖（算成 8 會 12:00 收）', status(m).cap.locked, false);
  check('B1d2', '照打卡 20:00 收', sysAt(m, D + 'T20:00:00'), '20:00');
}
{
  const m = world(D + 'T15:59:00', [[D + 'T10:00:00', 'E01', 'in']], { reqs: [['leave', D, '06:00', '10:00', 4], ['leave', D, '06:00', '10:00', 4]] });
  check('B1d4', '有時段的同一筆假重複兩張（同時段）只算一次：15:59 還沒滿', status(m).cap.locked, false);
  check('B1d5', '16:00 收卡', sysAt(m, D + 'T16:00:00'), '16:00');
}

console.log('\n════ 第 5 點：滿 10 那一刻（有時段、上班前就核准的單） ════');
{
  const m = world(D + 'T19:59:00', [[D + 'T14:00:00', 'E01', 'in']], { reqs: [['leave', D, '08:00', '12:00', 4]] });
  check('N01', '先請假後上班：上午 08–12 請假 4 小時、14:00 上班 → 19:59 還沒滿', status(m).cap.locked, false);
  check('N01b', '20:00 收卡（6＋4）', sysAt(m, D + 'T20:00:00'), '20:00');
}
{
  const m = world(D + 'T13:59:00', [[D + 'T08:00:00', 'E01', 'in']], { reqs: [['leave', D, '14:00', '18:00', 4]] });
  check('N02', '先上班後請假（假單上班前就核准）：08:00 上班、14–18 請假 → 13:59 還沒滿', status(m).cap.locked, false);
  check('N02b', '14:00 滿 10（6＋4）→ 14:05 開頁寫 14:00 的系統卡', sysAt(m, D + 'T14:05:00'), '14:00');
}

console.log('\n════ 第 6 項：上班中才核准的單（預設：不當場收卡，只進事後通知） ════');
{
  const m = world(D + 'T17:35:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '06:00', '09:00', 3, 'approved', D + 'T17:30:00+08:00']] });
  check('L1★', '09:00 上班、17:30 才核准早上 3 小時假 → 預設不當場收卡（17:35 沒鎖）', status(m).cap.locked, false);
  check('L1b', '照打卡 19:00 收', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T17:35:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '06:00', '09:00', 3, 'approved', D + 'T17:30:00+08:00']], live: { CAP_LIVE_LATE_OK: true } });
  check('L2', '切換另一種做法（CAP_LIVE_LATE_OK＝true）：從核准那一刻算 → 17:30 收卡（不往回記到 16:00）', status(m).cap.sys_hm, '17:30');
}
{
  const m = world(D + 'T19:59:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T14:00:00', 'E01', 'in']],
    { reqs: [['leave', D, '12:00', '14:00', 2, 'approved', D + 'T13:00:00+08:00']] });
  check('L3', '午休中（第二段上班前）核准的單＝第二段開始前就核准，照算：4＋2，14:00 上班 → 17:59 前沒滿、18:00 收', [lockedAt(m, D + 'T17:59:00'), sysAt(m, D + 'T18:00:00')], [false, '18:00']);
}
{
  const m = world(D + 'T19:10:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('N14', '收卡在先（19:00）', status(m).cap.sys_hm, '19:00');
  m.setNow(D + 'T19:30:00');
  reqs(m, m.self, [['leave', D, '06:00', '09:00', 3, 'approved', D + 'T19:30:00+08:00']], 'E01');
  check('N14b', '收卡後才核准假單 → 不重寫、不改時間（仍 19:00、系統卡 1 張）', [status(m).cap.sys_hm, sysRows(m).length], ['19:00', 1]);
}
{
  const m = world(D + 'T18:10:00', [[D + 'T10:00:00', 'E01', 'in']], { reqs: [['leave', D, '08:00', '10:00', 2]] });
  check('N14c', '08–10 請假＋10:00 上班 → 18:00 收卡', status(m).cap.sys_hm, '18:00');
  setStatus(m, 'voided');
  m.setNow(D + 'T18:30:00');
  check('N14d', '收卡後假單被作廢 → 系統卡不收回（仍鎖、仍 18:00、1 張；預設：不回復）', [status(m).cap.locked, status(m).cap.sys_hm, sysRows(m).length], [true, '18:00', 1]);
}

console.log('\n════ 第 1 點：假單、出差跟打卡重疊不重複算 ════');
{
  const m = world(D + 'T18:59:00', [[D + 'T09:00:00', 'E01', 'in']], { reqs: [['leave', D, '13:00', '17:00', 4]] });
  check('N03', '請 13–17 的假但人一直打卡在場：重疊不算兩次 → 18:59 還沒滿（不扣重疊會 15:00 就收）', status(m).cap.locked, false);
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
  const m = world(D + 'T16:59:00', [[D + 'T10:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, peerReqs: { PEER1: { emp: 'P9', rows: [['leave', D, '06:00', '09:00', 3]] } } });
  check('N09', '假單掛在別家店（同名在職）也算：別家 06–09 假＋本店 10:00 上班 → 16:59 還沒滿', status(m).cap.locked, false);
  check('N09b', '17:00 收卡', sysAt(m, D + 'T17:00:00'), '17:00');
}
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測試一', key: 'PK', active: 'TRUE' }], events: [[D + 'T07:00:00', 'P9', 'in'], [D + 'T10:00:00', 'P9', 'out']] };
  const m = world(D + 'T17:59:00', [[D + 'T12:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, reqs: [['leave', D, '10:00', '11:00', 1]] });
  check('N10', '跨店加總：別家打卡 07–10（3）＋本店假 10–11（1）＋本店 12:00 上班 → 17:59 還沒滿', status(m).cap.locked, false);
  check('N10b', '18:00 收卡', sysAt(m, D + 'T18:00:00'), '18:00');
}
{
  const PEER = { roster: [{ emp_id: 'P9', name: '別人', key: 'PK', active: 'TRUE' }], events: [] };
  const m = world(D + 'T12:00:00', [[D + 'T10:00:00', 'E01', 'in']], { peers: { PEER1: PEER }, peerReqs: { PEER1: { emp: 'P9', rows: [['leave', D, '', '', 8]] } } });
  check('N09c', '別家店不同名的人的假不算', m.sb.capLeavesFor_(m.self, ME, T(D + 'T12:00:00')).length, 0);
}

console.log('\n════ 滿 10 含剛好 10、已核准才算、擋上班卡要先有打卡 ════');
{
  const m = world(D + 'T17:59:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T14:00:00', 'E01', 'in']], { reqs: [['leave', D, '12:00', '14:00', 2]] });
  check('N11', '4＋假 2＋14:00 上班 → 17:59 還沒滿', status(m).cap.locked, false);
  check('N11b', '剛好 10 小時（18:00:00）就收', sysAt(m, D + 'T18:00:00'), '18:00');
}
{
  const m = world(D + 'T19:30:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']],
    { reqs: [['leave', D, '17:00', '19:00', 2]] });
  const s = status(m);
  check('N11c', '打卡 8＋假 2＝剛好 10 → 擋上班卡（in_block）', s.cap.in_block, true);
  check('N11d★', '擋上班卡那句的「已經上班 X 小時」顯示實際打卡 8（不是含假的 10；第 4 項）', m.sb.capCheck_(m.self, ME, T(D + 'T19:30:00'), null).reason, '你今天已經上班 8 小時（一天最多 10 小時）');
}
{
  const m = world(D + 'T19:30:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']],
    { reqs: [['leave', D, '17:00', '18:45', 1.75]] });
  check('N11e', '打卡 8＋假 1.75＝9.75 → 不擋上班卡', status(m).cap.in_block, false);
}
{
  const m = world(D + 'T20:00:00', [[D + 'T14:00:00', 'E01', 'in']],
    { reqs: [['leave', D, '08:00', '12:00', 4, 'pending'], ['leave', D, '08:00', '12:00', 4, 'rejected'], ['trip', D, '08:00', '12:00', 4, 'cancelled'], ['leave', D, '08:00', '12:00', 4, 'voided']] });
  check('N12', '審核中／退回／取消／作廢的單都不算', [m.sb.capLeavesFor_(m.self, ME, T(D + 'T20:00:00')).length, status(m).cap.locked], [0, false]);
  check('N12b', '只算打卡：14:00 上班 → 隔天 00:00 才收', sysAt(m, D2 + 'T00:00:00'), '00:00');
}
{
  const m = world(D + 'T18:00:00', [[D + 'T14:00:00', 'E01', 'in']], { reqs: [['ot', D, '08:00', '12:00', 4], ['miss', D, '', '', '', 'approved']] });
  check('N12c', '加班單、忘打卡單不算假單', m.sb.capLeavesFor_(m.self, ME, T(D + 'T18:00:00')).length, 0);
}

console.log('\n════ 第 2 點：跨日、跨夜、日期格式 ════');
{
  const m = world(D + 'T23:59:00', [[D + 'T16:00:00', 'E01', 'in']], { reqs: [['leave', D, '08:00', '10:00', 2]] });
  check('N19', '跨夜班：11/20 16:00 上班＋11/20 的假 2 小時 → 23:59 還沒滿', status(m).cap.locked, false);
  check('N19b', '11/21 00:00 收卡（段落歸上班那天、用那天的假）', sysAt(m, D2 + 'T00:00:00'), '00:00');
}
{
  const m = world(D2 + 'T01:59:00', [[D + 'T16:00:00', 'E01', 'in']], { reqs: [['leave', D2, '08:00', '12:00', 4]] });
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
{
  const m = world(D + 'T19:00:00', [[D + 'T13:00:00', 'E01', 'in']], { reqs: [['leave', D, '08:00', '12:00', 4, 'approved', '']] });
  const lv = m.sb.capLeavesFor_(m.self, ME, T(D + 'T19:00:00'))[0];
  check('N20c', '核准時間空白（不該發生）＝當成現在才知道：dec＝現在 → 也就是上班中才核准，預設不當場收', [lv.dec, status(m).cap.locked], [T(D + 'T19:00:00'), false]);
}

console.log('\n════ 第 6 點：換版當下（舊規則還沒收、新規則已經超過） ════');
{
  const LONG = { id: 'L', name: '長班', start: '11:00', end: '21:30', break_min: 30 };
  const sched = { start: '2026-11-01', shifts: [LONG], rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'L' } : { t: 'R' })) }] };
  const m = world(D + 'T21:25:00', [[D + 'T11:00:00', 'E01', 'in']], { sched });
  check('N16', '11:00 上班、班別休息 30 分沒打卡：舊規則 21:30 才收；21:25 換上新版 → 系統卡往回記 21:00（換版要挑沒人上班的時段）', status(m).cap.sys_hm, '21:00');
}

console.log('\n════ 擋項 2：同一段上班只會有一張系統卡、系統卡不會記在本人下班卡之後 ════');
{
  // 另一邊（mini 或舊版）已經寫了 21:30 的系統卡，但這次判斷讀到的列還沒有它（同步慢一步）→ 寫之前重讀，看到同段已有系統卡就不寫
  const m = world(D + 'T21:40:00', [[D + 'T11:00:00', 'E01', 'in']]);
  const stale = m.sb.readEventsSince(m.self.getSheetByName('events'), T(D + 'T00:00:00')).rows.slice();
  m.self.sh.events.values[0].push('source');
  m.self.sh.events.values.push(evRaw('21:30', 'out', { 11: 'system_cap' }));
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T21:40:00'), stale);
  check('W1★', '同段已有別處寫的系統卡（差 30 分，舊版只看前後 1 分鐘會再寫一張）→ 不寫第二張、照那張鎖', [sysRows(m).length, st.locked, m.sb.capHm_(st.sys)], [1, true, '21:30']);
}
{
  // mini 收了本人 21:05 的下班卡、剛同步進來；這次判斷讀到的列還沒有它 → 不寫系統卡、不鎖
  const m = world(D + 'T21:10:00', [[D + 'T11:00:00', 'E01', 'in']]);
  const stale = m.sb.readEventsSince(m.self.getSheetByName('events'), T(D + 'T00:00:00')).rows.slice();
  m.self.sh.events.values.push(evRaw('21:05', 'out'));
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T21:10:00'), stale);
  check('W2★', '同段已有本人下班卡（21:05）→ 不補 21:00 的系統卡（不會「系統卡之後又有本人下班卡」）、不鎖', [sysRows(m).length, st.locked], [0, false]);
}
{
  const m = world(D + 'T21:40:00', [[D + 'T11:00:00', 'E01', 'in']]);
  m.self.sh.events.values[0].push('source');
  m.self.sh.events.values.push(evRaw('21:30', 'out', { 11: 'system_cap' }));
  const st = status(m);
  check('W3', '換版中間（mini 舊規則先寫 21:30、Google 新規則算 21:00）：讀得到那張就鎖在那張、不再寫', [sysRows(m).length, st.cap.sys_hm], [1, '21:30']);
}
{
  const m = world(D + 'T21:40:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in']]);
  const stale = m.sb.readEventsSince(m.self.getSheetByName('events'), T(D + 'T00:00:00')).rows.slice();
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T21:40:00'), stale);
  check('W4', '上一段的本人下班卡（12:00，在這段上班卡 13:00 之前）不影響這段照常收卡（20:00）', [sysRows(m).length, m.sb.capHm_(st.sys)], [1, '20:00']);
}
{
  const m = world(D + 'T21:40:00', [[D + 'T11:00:00', 'E01', 'in']]);
  m.self.sh.events.values[0].push('source');
  m.self.sh.events.values.push(evRaw('21:00', 'out', { 11: 'system_cap' }));
  check('W5', '舊呼叫（沒給上班卡時間）＝照舊前後 1 分鐘：21:00:30 不寫、21:30 寫', [m.sb.capWrite_(m.self, 'E01', T(D + 'T21:00:30')).sys !== undefined, !!m.sb.capWrite_(m.self, 'E01', T(D + 'T21:30:00')).at], [true, true]);
}

{
  // mini 看不到申請表、收下了上班卡（打卡 8＋上班前核准的假 2＝已滿 10）→ Google 這邊補收：只寫一張、記在那張上班卡的時間
  const m = world(D + 'T19:40:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out'], [D + 'T19:30:00', 'E01', 'in']],
    { reqs: [['leave', D, '17:00', '19:00', 2]] });
  m.sb.capSweep(); m.sb.capSweep();
  check('W6', 'mini 收下的上班卡（今天已滿 10）→ 觸發器補一張系統卡、記 19:30（上班那一刻），跑兩次也只有一張', sysRows(m).map((r) => String(r[0]).slice(11, 16)), ['19:30']);
}

console.log('\n════ 第 7 點：mini 擋卡引擎沒有 requests 分頁 ════');
{
  const m = world(D + 'T19:00:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('N17', '沒有 requests 分頁：讀假單回 []、不出錯，照打卡收（19:00）', [m.sb.capLeavesFor_(m.self, ME, T(D + 'T19:00:00')).length, status(m).cap.sys_hm], [0, '19:00']);
}

console.log('\n════ 開關 REST_CAP_ON（保護同仁的機制：行為跟改版前一樣） ════');
['', '0', 'true', '1 ', 'on'].forEach((v, i) => {
  const m = world(D + 'T13:00:00', [[D + 'T09:00:00', 'E01', 'in']], { props: { REST_CAP_ON: v }, reqs: [['leave', D, '00:00', '08:00', 8]] });
  check('N13' + 'abcde'[i], 'REST_CAP_ON＝' + JSON.stringify(v) + '（不是剛好 "1"）：打卡 4＋假 8 也完全不收卡、下班卡照收', [status(m).cap.locked, punch(m, 'out').ok, sysRows(m).length], [false, true, 0]);
});
{
  const m = world(D + 'T13:00:00', [[D + 'T09:00:00', 'E01', 'in']], { props: { REST_CAP_ON: '1' }, reqs: [['leave', D, '00:00', '08:00', 8]] });
  check('N13f', 'REST_CAP_ON＝"1"：同一個人（前一天就核准 00–08 假）11:00 就滿（2＋8）→ 13:00 開頁寫 11:00 的系統卡', status(m).cap.sys_hm, '11:00');
}

console.log('\n════ 第 8 點、第 3／4 項：打卡頁提醒（Rest.gs） ════');
const restWarn = (m) => { const s = m.sb.restStatus_(m.self, ME); return s.warn ? s.warn.code : (s.blocked ? 'blocked:' + s.code : null); };
const restReason = (m) => { const s = m.sb.restStatus_(m.self, ME); return s.warn ? s.warn.reason : null; };
{
  const m = world(D + 'T15:00:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T13:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '' }, reqs: [['leave', D, '00:00', '06:00', 6]] });
  check('R1★', '收卡開關沒開、提醒開著：打卡 4＋假 6 → 跟改版前一樣不提醒（不會冒出「已經上班 10 小時」）', restWarn(m), null);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:30:00', 'E01', 'out']], { config: CF, props: { REST_RULE_ON: '1', REST_CAP_ON: '' } });
  check('R2★', '收卡開關沒開：央廚 08:00–18:30 照改版前的打卡加總（10.5）提醒、字也一樣', restReason(m), '你今天已經上班 10.5 小時（一天最多 10 小時）');
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:30:00', 'E01', 'out']], { config: CF, props: { REST_RULE_ON: '1', REST_CAP_ON: '1' } });
  check('N18', '收卡開關開著：央廚 08:00–18:30（扣中午休息＝9.5）→ 不提醒', restWarn(m), null);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '1' }, reqs: [['leave', D, '17:00', '19:00', 2]] });
  check('N18b', '收卡開關開著：門市打卡 8＋假 2 → 提醒', restWarn(m), 'cap');
  check('N18c★', '提醒那句的 X 顯示實際打卡 8（判斷用含假的 10；第 4 項）', restReason(m), '你今天已經上班 8 小時（一天最多 10 小時）');
}
{
  const m = world(D + 'T19:00:00', [[D + 'T13:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '1' } });
  const ev = m.self.sh.events;
  ev.values[0].push('mirror_src');
  ev.values.splice(1, 0, ['2026-11-20T08:00:00+08:00', 'E01', 'in', '', '', '', '', 'D1', '', 'ok', '', 'CF'], ['2026-11-20T13:00:00+08:00', 'E01', 'out', '', '', '', '', 'D1', '', 'ok', '', 'CF']);
  check('N18d', '總部鏡像列（mirror_src）不算：真的只有 13–18（5 小時）→ 不提醒', restWarn(m), null);
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { props: { REST_RULE_ON: '1', REST_CAP_ON: '1' } });
  m.sb.capTodayMs_ = () => { throw new Error('壞掉'); };
  check('N18e', 'Cap10 算失敗 → 提醒退回原本的打卡加總（10 小時照樣提醒），不擋打卡', restWarn(m), 'cap');
}
{
  const m = world(D + 'T19:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']], { config: CF, props: { REST_RULE_ON: '1', REST_CAP_ON: '1' } });
  const st = status(m), d = m.sb.capTodayMs_(m.self, ME, T(D + 'T19:00:00'), null);
  check('N18f', '同一個人：收卡算的今日時數＝提醒算的（9 小時，同一支 capJudge_）', [st.cap.in_block, d.total / 3600000, d.punch / 3600000], [false, 9, 9]);
}

console.log('\n════ 09:00 通知匣（Payroll.gs payDayLoadOver_；事後：只填時數的假照算）════');
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
