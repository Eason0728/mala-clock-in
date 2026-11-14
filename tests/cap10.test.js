/* 單日滿 10 小時：系統收卡並鎖住（2026-11-14 Eason 開工確認 A＋D；Cap10.gs）。
 * 用真函式跑（Code／Liff／Rest／Requests／Cap10）。名字一律假名。 */
'use strict';
const { make, T, at, check, done, R } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const OTHER = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
const D = '2026-11-20';
const HERE = Object.assign({ accuracy: 10 }, at(3));

function world(now, events, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props: Object.assign({ REQ_BIND_FROM: 'off', REST_CAP_ON: '1' }, opt.props || {}),
    self: { roster: [ME, OTHER], events: events || [] }, peers: opt.peers, config: opt.config });
  const trig = [];
  m.sb.ScriptApp = { getProjectTriggers: () => trig.slice(),
    deleteTrigger: (t) => { trig.splice(trig.indexOf(t), 1); },
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { trig.push({ getHandlerFunction: () => fn }); } }) }) }) };
  m.run(R('apps-script/Cap10.gs'));
  if (opt.sched) {   // 光復就是自己（gf）：班表放在自己試算表的 sched_pub
    m.sb.REST_PEERS_ = (m.sb.REST_PEERS_ || []).filter((p) => p.ss !== 'SELF').concat([{ code: 'gf', ss: 'SELF' }]);
    const sh = m.self.insertSheet('sched_pub');
    sh.appendRow(['store', 'period', 'seq', 'data', 'last_op', 'updated_at']);
    sh.appendRow(['', 'T01', 1, JSON.stringify(opt.sched), 'op', '']);
  }
  return m;
}
const punch = (m, type, tok) => m.sb.handleLiffPunch_(Object.assign({ id_token: tok || 'TOK_U1', type: type, confirm_same: true }, HERE));
const status = (m, tok) => m.sb.handleLiffStatus_({ id_token: tok || 'TOK_U1' });
const sysRows = (m) => m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0);
const evs = (m) => m.events().map((e) => String(e.ts).slice(5, 16).replace('T', ' ') + ' ' + e.type + ' ' + e.status);

console.log('════ 一、開關 ════');
{
  const m = world(D + 'T19:30:00', [[D + 'T09:00:00', 'E01', 'in']], { props: { REST_CAP_ON: '' } });
  check('C01', '開關關著：滿 10.5 小時照樣能打下班卡、不寫系統卡', [punch(m, 'out').ok, sysRows(m).length], [true, 0]);
  const s = status(m);
  check('C02', '開關關著：開頁 cap 都是 false', s.cap, { locked: false, in_block: false });
}
{
  const m = world(D + 'T09:00:00');
  check('C03', 'cap_set 錯金鑰 → unauthorized', m.sb.handleCapSet_({ admin_key: 'X', on: true }).error, 'unauthorized');
  m.props.REST_CAP_ON = undefined; delete m.props.REST_CAP_ON;
  const a = m.sb.handleCapSet_({ admin_key: 'ADM', on: true });
  const b = m.sb.handleCapSet_({ admin_key: 'ADM', on: true });
  check('C04', '開兩次：開關打開、觸發器只有一支', [a.on, b.on, b.trigger], [true, true, 1]);
  const c = m.sb.handleCapSet_({ admin_key: 'ADM', on: false });
  check('C05', '關掉：開關關、觸發器刪掉', [c.on, c.trigger], [false, 0]);
}

console.log('\n════ 二、一段班：滿 10 小時系統收卡 ════');
{
  const m = world(D + 'T18:59:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('C10', '18:59 還沒滿：開頁沒鎖', status(m).cap.locked, false);
  check('C11', '18:59 開頁不會寫系統卡', sysRows(m).length, 0);
  m.setNow(D + 'T19:04:00');
  const s = status(m);
  check('C12', '19:04 開頁：上下班都鎖、時間 19:00、隔天 06:00 解鎖', [s.cap.locked, s.cap.sys_hm, s.cap.hint], [true, '19:00', '11/21 06:00 以後才能再打卡']);
  check('C13', '系統卡寫在剛好 19:00:00，source＝system_cap，裝置 system', sysRows(m).map((r) => [String(r[0]).slice(11, 19), r[2], r[7], r[9]]), [['19:00:00', 'out', 'system', 'ok']]);
  check('C14', 'events 表頭補了 source 欄', m.self.sh.events.values[0].slice(-1), ['source']);
  check('C15', '今天紀錄標「系統代打」', s.today.map((e) => [e.type, e.hm, e.sys]), [['in', '09:00', false], ['out', '19:00', true]]);
  status(m);
  check('C16', '再開一次頁：不重寫系統卡', sysRows(m).length, 1);
  const p = punch(m, 'out');
  check('C17', '19:04 按下班 → 不收（cap_locked），不多寫列', [p.ok, p.status, m.events().length], [false, 'cap_locked', 2]);
  check('C18', '原因講清楚', [p.reason, p.hint], ['今天已滿 10 小時，系統在 19:00 幫你記了下班卡', '11/21 06:00 以後才能再打卡']);
  m.setNow('2026-11-21T05:59:00');
  check('C19', '隔天 05:59 打上班 → 還鎖著', punch(m, 'in').status, 'cap_locked');
  m.setNow('2026-11-21T06:00:00');
  check('C20', '隔天 06:00 打上班 → 收', punch(m, 'in').ok, true);
}
{
  // 同仁在觸發器還沒跑之前自己按下班：照樣在 19:00 收卡，這次按的不收
  const m = world(D + 'T19:02:00', [[D + 'T09:00:00', 'E01', 'in']]);
  const p = punch(m, 'out');
  check('C21', '19:02 自己按下班（系統還沒收卡）→ 先寫 19:00 系統卡、這張不收', [p.status, evs(m)], ['cap_locked', ['11-20 09:00 in ok', '11-20 19:00 out ok']]);
}
{
  const m = world(D + 'T18:30:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('C22', '18:30 正常下班 → 收、沒有系統卡', [punch(m, 'out').ok, sysRows(m).length], [true, 0]);
}

console.log('\n════ 三、兩段班、自己打滿 10 小時 ════');
{
  const m = world(D + 'T22:59:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T13:00:00', 'E01', 'out'], [D + 'T17:00:00', 'E01', 'in']]);
  check('C30', '09–13＋17:00 起：22:59 還沒滿', status(m).cap.locked, false);
  m.setNow(D + 'T23:01:00');
  check('C31', '23:01 → 系統卡在 23:00', status(m).cap.sys_hm, '23:00');
}
{
  const m = world(D + 'T20:00:00', [[D + 'T08:00:00', 'E01', 'in'], [D + 'T18:30:00', 'E01', 'out']]);
  const s = status(m);
  check('C32', '自己打了 08:00–18:30（10.5 小時）→ 只鎖上班、不鎖下班、沒寫系統卡', [s.cap.locked, s.cap.in_block, sysRows(m).length], [false, true, 0]);
  check('C33', '20:00 打上班 → 不收', [punch(m, 'in').status, m.events().length], ['cap_locked', 2]);
}

console.log('\n════ 四、忘刷卡：孤單卡不算、用班表補 ════');
{
  // 09:00 上班、忘打下班、17:00 又打上班（班表也沒有）→ 09:00 那張不算，從 17:00 算
  const m = world(D + 'T23:30:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'in']]);
  check('C40', '沒班表：孤單上班卡不算時數，23:30 不鎖', status(m).cap.locked, false);
  m.setNow('2026-11-21T03:01:00');
  check('C41', '從 17:00 算滿 10 小時＝隔天 03:00', status(m).cap.sys_hm, '03:00');
}
{
  const SCHED = { start: '2026-11-01', shifts: [{ id: 'A', name: '兩段', start: '09:00', end: '22:00', segs: [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '22:00' }] }],
    rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) }] };
  const m = world(D + 'T22:59:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'in']], { sched: SCHED });
  check('C42', '有班表 09–13、17–22：09:00 孤單上班卡補到 13:00（4 小時），22:59 還沒滿', status(m).cap.locked, false);
  m.setNow(D + 'T23:00:30');
  check('C43', '4＋6＝10 → 23:00 收卡', status(m).cap.sys_hm, '23:00');
}
{
  const SCHED = { start: '2026-11-01', shifts: [{ id: 'B', name: '早班', start: '08:00', end: '12:00' }],
    rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'B' } : { t: 'R' })) }] };
  const m = world(D + 'T18:59:00', [[D + 'T12:00:00', 'E01', 'out'], [D + 'T13:00:00', 'E01', 'in']], { sched: SCHED });
  check('C44', '忘打上班、12:00 下班：班表 08:00 開始補 4 小時，13:00 上班 → 18:59 還沒滿', status(m).cap.locked, false);
  m.setNow(D + 'T19:00:00');
  check('C45', '4＋6＝10 → 19:00 收卡', status(m).cap.sys_hm, '19:00');
}
{
  const SCHED = { start: '2026-11-01', shifts: [{ id: 'C', name: '晚班', start: '17:00', end: '22:00' }],
    rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'C' } : { t: 'R' })) }] };
  const m = world(D + 'T23:30:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'in']], { sched: SCHED });
  check('C46', '班表時段跟孤單卡差超過 2 小時（09:00 vs 17:00）→ 不補、不鎖', status(m).cap.locked, false);
}

console.log('\n════ 四之二、中午不打卡的休息時段（央廚、總部） ════');
{
  const m = world(D + 'T18:59:00', [[D + 'T08:00:00', 'E01', 'in']], { config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' } });
  check('C47', '央廚 08:00 上班、中午 12–13 不打卡：18:59 只做了 9 小時多，不鎖', status(m).cap.locked, false);
  m.setNow(D + 'T19:00:00');
  check('C48', '扣掉休息 1 小時 → 19:00 才收卡', status(m).cap.sys_hm, '19:00');
}
{
  const m = world(D + 'T20:00:00', [[D + 'T07:00:00', 'E01', 'in'], [D + 'T18:30:00', 'E01', 'out']], { config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' } });
  check('C49', '自己打 07:00–18:30（扣休息 10.5 小時）→ 擋上班卡', status(m).cap.in_block, true);
}

console.log('\n════ 五、跨店 ════');
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測 試一', key: 'PK', active: 'TRUE' }], events: [[D + 'T07:00:00', 'P9', 'in'], [D + 'T11:00:00', 'P9', 'out']] };
  const m = world(D + 'T18:59:00', [[D + 'T13:00:00', 'E01', 'in']], { peers: { PEER1: PEER } });
  check('C50', '別家店 07–11（4 小時）＋本店 13:00 起：18:59 還沒滿', status(m).cap.locked, false);
  m.setNow(D + 'T19:00:00');
  check('C51', '19:00 收卡（跨店加總，姓名去空白對人）', status(m).cap.sys_hm, '19:00');
}
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測試一', key: 'PK', active: 'TRUE' }], events: [[D + 'T09:00:00', 'P9', 'in']] };
  const m = world(D + 'T19:05:00', [], { peers: { PEER1: PEER } });
  const s = status(m);
  check('C52', '正在別家店上班滿 10 小時：本店不寫卡、但鎖住', [s.cap.locked, sysRows(m).length], [true, 0]);
  check('C53', '在本店打上班 → 不收', punch(m, 'in').status, 'cap_locked');
}

console.log('\n════ 六、觸發器、舊連結、考勤管理 ════');
{
  const m = world(D + 'T19:10:00', [[D + 'T09:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E02', 'in']]);
  m.sb.capSweep();
  check('C60', '觸發器：只幫滿 10 小時的人寫卡（測試一 19:00），測試二不寫', sysRows(m).map((r) => [r[1], String(r[0]).slice(11, 16)]), [['E01', '19:00']]);
  m.sb.capSweep();
  check('C61', '觸發器再跑一次不重寫', sysRows(m).length, 1);
  const r = m.sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: 'K1', type: 'out', device_id: 'D1' }, HERE)) } });
  const j = JSON.parse(r.text);
  check('C62', '舊連結 clock 動作 → rejected_rest＋原因', [j.status, j.rest && j.rest.code, j.rest && j.rest.reason], ['rejected_rest', 'cap10', '今天已滿 10 小時，系統在 19:00 幫你記了下班卡']);
  const k = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: 'K2', type: 'out', device_id: 'D2' }, HERE)) } }).text);
  check('C63', '舊連結：沒滿的人照常打', k.status, 'ok');
  const day = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_day', mgr_key: 'MK', date: D }) } }).text);
  const e1 = (day.employees || []).filter((p) => p.emp_id === 'E01')[0] || {};
  check('C64', 'mgr_day：測試一帶 cap_sys 19:00，參考時數 10', [e1.cap_sys, e1.reference], [['19:00'], 10]);
  check('C65', 'mgr_day：系統卡把那段收成 09:00–19:00（不算下班忘刷卡）', (e1.segments || []).map((s) => [s.in, s.out]), [['09:00', '19:00']]);
}
done();
