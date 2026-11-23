/* 滿 10 小時收卡：班表寬限（2026-11-24 主管定案「做系統主動代記」「可以，照算忘刷」；Cap10.gs capSchedEnd_／capGraceLate_／capCheck_ mode）
 *
 * 規則白話版：
 *   1. 開關：指令碼屬性 REST_CAP_ON 恰為 '2'＝收卡開著＋這條規則；'1'＝跟改版前一樣；其他值＝收卡關著（跟改版前一樣）。
 *   2. 只管「系統主動代記」：定時掃描、開打卡頁時，如果「滿 10 小時那一刻（第一個滿 10 的 15 分刻度）」比當天班表最後一段下班
 *      晚「超過」30 分鐘 → 不寫系統卡、不鎖（當成忘刷下班）。剛好 30 分照舊代記。
 *   3. 本人按下班：照舊——系統卡寫在滿 10 那一刻、回 cap_locked。
 *   4. 本人按上班、前一段開著已滿 10、又符合第 2 點 → 不寫、放行；不符合照舊（寫卡、擋）。舊連結、liff_clock 同一支。
 *   5. 班表：那段所在的那家店、那家店的工號（2026-11-23 起別家店也判，見「十、」）、那段上班卡那天（落在前一天跨夜段裡＝前一天）；
 *      只認上班格 W；分段取最後一段；跨午夜照實際結束。讀不到／沒排／例假／休息日／請假／
 *      國定假日／讀取失敗／上班卡比班表下班還晚 → 照舊代記。
 *   6. 取整、央廚總部固定休息、假單：照 38d0340。
 *
 * 手算對照（★＝38d0340 會紅：舊版一律代記／擋）：
 *   S1★ 09:00–18:00、08:55 上班（取整 09:00）→ 滿 10＝19:00，晚 60 分 → 掃描、開頁不寫；20:10 自己按下班 → 系統卡 19:00、cap_locked。
 *   S2★ 14:00–23:00、14:00 上班、沒下班 → 滿 10＝隔天 00:00，晚 60 → 不寫；隔天 05:30 按上班（還在 16 小時內）→ 放行、沒有系統卡。
 *   S3  兩段 09:00–13:00＋18:00–22:00、09:00–13:00 打卡、晚上 15:45／16:00／16:30／16:45 上班 → 滿 10＝21:45／22:00／22:30／22:45
 *       → 晚 −15／0／30／45 分 → 代記／代記／代記／★不代記。
 *   S4  央廚 08:00–17:00（扣 12–13）：07:55 上班 → 08:00 起扣 1 小時 → 19:00，晚 120 ★不代記；06:30 上班 → 17:30，晚 30 → 代記。
 *   S5  跨午夜 15:00–00:30：15:00 上班 → 隔天 01:00，晚 30 → 代記；15:15 → 01:15，晚 45 ★不代記。
 *       兩段 10:00–14:00＋20:00–02:00、10:00–14:00 打卡、20:00 上班 → 隔天 02:00，晚 0 → 代記。
 *   S6  沒班表、例假 R、休息日 H（有班別）、整天請假 L、L 有班別、讀取失敗、上班卡晚於班表下班（09–13 班、14:00 上班）→ 全部照舊 19:00／00:00 代記。
 *   S7  請假讓滿 10 提早：09:00–18:00、已核准特休 06:00–07:00（1 小時）、08:55 上班 → 18:00 滿 10，晚 0 → 代記；沒有假 → 19:00 ★不代記。
 *   S8  開關 '1'＝改版前（19:00 代記）；'3'＝收卡關著（不寫、不擋）。
 *   9 筆實例（2026-11 系統收卡，時間取新規則刻度）見「九、」。 */
'use strict';
const { make, T, at, check, done, R } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-20', D2 = '2026-11-21';
const HERE = Object.assign({ accuracy: 10 }, at(3));
const CF = { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' };
const HQ = { NO_PUNCH_BREAK_START: '14:00', NO_PUNCH_BREAK_END: '15:00' };
const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at'];

/** cell：第 19 格（11/20）的格子；c20：第 20 格（11/21）。shift 可省（沒有班別） */
const schedOf = (shifts, cell, c20) => ({ start: '2026-11-01', shifts: shifts, rows: [{ emp_id: 'E01', name: '測試一',
  cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? cell : i === 20 && c20 ? c20 : { t: 'R' })) }] });
const one = (start, end, extra) => schedOf([Object.assign({ id: 'A', name: '班', start: start, end: end }, extra || {})], { t: 'W', s: 'A' });
const two = (a, b) => schedOf([{ id: 'A', name: '兩段', start: a[0], end: b[1], segs: [{ start: a[0], end: a[1] }, { start: b[0], end: b[1] }] }], { t: 'W', s: 'A' });

function world(now, events, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props: Object.assign({ REQ_BIND_FROM: 'off', REST_CAP_ON: '2' }, opt.props || {}),
    self: { roster: [ME], events: (events || []).map((e) => [e[0].length <= 8 ? D + 'T' + e[0] : e[0], 'E01', e[1]]) }, config: opt.config });
  m.run(R('apps-script/Cap10.gs'));
  if (opt.sched !== undefined) {   // 光復就是自己（gf）：班表放在自己試算表的 sched_pub
    m.sb.REST_PEERS_ = (m.sb.REST_PEERS_ || []).filter((p) => p.ss !== 'SELF').concat([{ code: 'gf', ss: 'SELF' }]);
    const sh = m.self.insertSheet('sched_pub');
    sh.appendRow(['store', 'period', 'seq', 'data', 'last_op', 'updated_at']);
    if (opt.sched) sh.appendRow(['', 'T01', 1, typeof opt.sched === 'string' ? opt.sched : JSON.stringify(opt.sched), 'op', '']);
  }
  if (opt.reqs) {
    const sh = m.self.insertSheet('requests');
    sh.appendRow(RQH);
    opt.reqs.forEach((r) => sh.appendRow(['r' + sh.values.length, '', 'E01', '', 'leave', r[0], '特休假', r[1], r[2], r[3], '', '', '', 'approved', '2026-11-19T20:00:00+08:00']));
  }
  return m;
}
const punch = (m, type) => m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: type, confirm_same: true }, HERE));
const status = (m) => m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
const sysRows = (m) => m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0);
const sysHm = (m) => sysRows(m).map((r) => String(r[0]).slice(5, 16).replace('T', ' '));
const oldClock = (m, type) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: 'K1', type: type, device_id: 'D1' }, HERE)) } }).text);
/** 掃描＋開頁之後：[系統卡, 開頁 locked, grace_hm] */
const autoAt = (m, t) => { m.setNow(t); m.sb.capSweep(); const s = status(m); return [sysHm(m), !!s.cap.locked, s.cap.grace_hm || null]; };

console.log('════ 一、單段班：掃描、開頁不代記；本人按下班照舊收在 10 小時 ════');
{
  const m = world(D + 'T18:59:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  check('G01', '18:59 還沒滿：不寫、不鎖', autoAt(m, D + 'T18:59:00'), [[], false, null]);
  check('G02★', '19:00 掃描＋開頁：滿 10＝19:00、晚 60 分 → 不寫、不鎖、grace_hm 19:00', autoAt(m, D + 'T19:00:00'), [[], false, '19:00']);
  check('G03★', '19:05、20:05 再掃：一樣不寫', [autoAt(m, D + 'T19:05:00')[0], autoAt(m, D + 'T20:05:00')[0]], [[], []]);
  m.setNow(D + 'T20:10:00');
  const r = punch(m, 'out');
  check('G04', '20:10 自己按下班 → 系統卡 19:00、cap_locked、本人那張不收', [r.ok, r.status, sysHm(m), m.events().filter((e) => e.type === 'out').length], [false, 'cap_locked', ['11-20 19:00'], 1]);
  check('G05', '之後開頁：鎖、sys_hm 19:00', [status(m).cap.locked, status(m).cap.sys_hm], [true, '19:00']);
}
{
  const m = world(D + 'T20:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  const j = oldClock(m, 'out');
  check('G06', '舊連結按下班：照舊寫 19:00、rejected_rest cap10', [j.status, j.rest && j.rest.code, sysHm(m)], ['rejected_rest', 'cap10', ['11-20 19:00']]);
}
{
  const m = world(D2 + 'T08:50:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  check('G07', '隔天 08:50（已過 16 小時）按上班 → 放行、不寫前一天的系統卡', [punch(m, 'in').ok, sysRows(m).length], [true, 0]);
}

console.log('\n════ 二、本人按上班（前一段還在 16 小時內）════');
{
  const m = world(D2 + 'T05:30:00', [['14:00:00', 'in']], { sched: one('14:00', '23:00') });
  const s = status(m);
  check('G10★', '14:00–23:00、14:00 上班：隔天 05:30 開頁 → 滿 10＝00:00 晚 60 → 不鎖、grace_hm 00:00', [s.cap.locked, s.cap.grace_hm, sysRows(m).length], [false, '00:00', 0]);
  const r = punch(m, 'in');
  check('G11★', '隔天 05:30 按上班 → 放行（寫進一張上班卡）、不寫系統卡', [r.ok, m.events().filter((e) => e.type === 'in' && e.status === 'ok').length, sysRows(m).length], [true, 2, 0]);
}
{
  const m = world(D2 + 'T05:30:00', [['14:00:00', 'in']], { sched: one('14:00', '23:00') });
  const j = oldClock(m, 'in');
  check('G12★', '舊連結按上班：放行、不寫', [j.status, sysRows(m).length], ['ok', 0]);
}
{
  const m = world(D2 + 'T05:30:00', [['14:00:00', 'in']], { sched: one('14:00', '23:00') });
  const j = m.sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: 'in' }, HERE));
  check('G13★', '舊 liff_clock 按上班：放行、不寫', [j.ok, sysRows(m).length], [true, 0]);
}
{
  const m = world(D + 'T22:10:00', [['09:00:00', 'in'], ['13:00:00', 'out'], ['15:45:00', 'in']], { sched: two(['09:00', '13:00'], ['18:00', '22:00']) });
  const r = punch(m, 'in');
  check('G14', '不符合（滿 10＝21:45 早於 22:00）按上班 → 照舊寫 21:45、cap_locked', [r.status, sysHm(m)], ['cap_locked', ['11-20 21:45']]);
}

console.log('\n════ 三、兩段班：「超過 30 分」的邊界 ════');
[['15:45:00', '21:45', true], ['16:00:00', '22:00', true], ['16:30:00', '22:30', true], ['16:45:00', '22:45', false]].forEach(([inT, hm, write], i) => {
  const m = world(D + 'T23:30:00', [['09:00:00', 'in'], ['13:00:00', 'out'], [inT, 'in']], { sched: two(['09:00', '13:00'], ['18:00', '22:00']) });
  m.sb.capSweep();
  const s = status(m);
  check('G2' + i + (write ? '' : '★'), '09–13＋18–22、晚上 ' + inT.slice(0, 5) + ' 上班 → 滿 10＝' + hm + (write ? ' 代記' : ' 晚 45 分不代記'),
    [sysHm(m), s.cap.locked, s.cap.grace_hm || null], write ? [['11-20 ' + hm], true, null] : [[], false, hm]);
});

console.log('\n════ 四、央廚固定休息、跨午夜 ════');
{
  const m = world(D + 'T19:10:00', [['07:55:00', 'in']], { sched: one('08:00', '17:00'), config: CF });
  check('G30★', '央廚 08–17（扣 12–13）、07:55 上班 → 19:00 滿 10、晚 120 → 不代記', autoAt(m, D + 'T19:10:00'), [[], false, '19:00']);
}
{
  const m = world(D + 'T17:40:00', [['06:30:00', 'in']], { sched: one('08:00', '17:00'), config: CF });
  check('G31', '央廚 06:30 上班 → 17:30 滿 10、晚 30 → 代記', autoAt(m, D + 'T17:40:00'), [['11-20 17:30'], true, null]);
}
{
  const m = world(D2 + 'T01:05:00', [['15:00:00', 'in']], { sched: one('15:00', '00:30') });
  check('G32', '跨午夜 15:00–00:30、15:00 上班 → 隔天 01:00、晚 30 → 代記', autoAt(m, D2 + 'T01:05:00'), [['11-21 01:00'], true, null]);
}
{
  const m = world(D2 + 'T01:20:00', [['15:15:00', 'in']], { sched: one('15:00', '00:30') });
  check('G33★', '跨午夜 15:15 上班 → 隔天 01:15、晚 45 → 不代記', autoAt(m, D2 + 'T01:20:00'), [[], false, '01:15']);
}
{
  const m = world(D2 + 'T02:05:00', [['10:00:00', 'in'], ['14:00:00', 'out'], ['20:00:00', 'in']], { sched: two(['10:00', '14:00'], ['20:00', '02:00']) });
  check('G34', '兩段 10–14＋20–02（跨午夜）、20:00 上班 → 隔天 02:00、晚 0 → 代記', autoAt(m, D2 + 'T02:05:00'), [['11-21 02:00'], true, null]);
}
{
  const s3 = schedOf([{ id: 'A', name: '三段', start: '07:00', end: '01:00', segs: [{ start: '07:00', end: '11:00' }, { start: '16:00', end: '20:00' }, { start: '00:00', end: '01:00' }] }], { t: 'W', s: 'A' });
  const m = world(D + 'T22:40:00', [['07:00:00', 'in'], ['11:00:00', 'out'], ['16:30:00', 'in']], { sched: s3 });
  check('G35', '三段、第三段過了午夜才開始（00:00–01:00 算隔天）→ 下班＝隔天 01:00；滿 10＝22:30 → 代記', autoAt(m, D + 'T22:40:00'), [['11-20 22:30'], true, null]);
}

console.log('\n════ 五、讀不到班表 → 照舊代記 ════');
const FALL = [
  ['G40', '沒有 sched_pub 分頁', { sched: undefined }],
  ['G41', 'sched_pub 沒有這一期', { sched: null }],
  ['G42', '例假 R', { sched: schedOf([{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'R' }) }],
  ['G43', '休息日 H 有排班別（休息日出勤）', { sched: schedOf([{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'H', s: 'A' }) }],
  ['G44', '整天請假 L（特休）', { sched: schedOf([{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'L', l: '特' }) }],
  ['G45', '國定假日 L 國', { sched: schedOf([{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'L', l: '國' }) }],
  ['G46', 'L 但有班別（半天假）', { sched: schedOf([{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'L', s: 'A', l: '事' }) }],
  ['G47', '班表裡沒有這個工號', { sched: { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], rows: [] } }],
  ['G48', 'sched_pub 那格不是 JSON', { sched: '{壞掉' }],
  ['G49', '班別時間格式怪（9點）', { sched: one('9點', '18:00') }],
];
FALL.forEach(([id, label, opt]) => {
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], opt);
  check(id, label + ' → 19:00 照舊代記', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
});
{
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  // 2026-11-23 審查第一輪：寬限改讀 capGraceSched_（店＋期快取），丟錯的位置改在讀 sched_pub 那一步（兩條讀法都會碰到）
  m.self.sh.sched_pub.getDataRange = () => { throw new Error('讀取失敗'); };
  check('G50', '讀班表丟錯 → 照舊代記', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
}
{
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  m.sb.capGraceSched_ = () => { throw new Error('讀取失敗'); };
  check('G50b', '寬限讀班表那支丟錯 → 照舊代記', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
}
{
  const m = world(D2 + 'T00:10:00', [['14:00:00', 'in']], { sched: one('09:00', '13:00') });
  check('G51', '上班卡（14:00）比那天班表下班（13:00）還晚 → 不是這個班、照舊代記', autoAt(m, D2 + 'T00:10:00'), [['11-21 00:00'], true, null]);
}
{
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  m.sb.REST_PEERS_ = [];   // 本店不在跨店清單（認不出自己是哪家）
  check('G52', '認不出本店代碼 → 照舊代記', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
}

console.log('\n════ 六、請假讓滿 10 提早（取整、假單照 38d0340）════');
{
  const m = world(D + 'T18:05:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00'), reqs: [[D, '06:00', '07:00', 1]] });
  check('G60', '特休 06–07＋08:55 上班 → 18:00 滿 10、晚 0 → 代記', autoAt(m, D + 'T18:05:00'), [['11-20 18:00'], true, null]);
}
{
  const m = world(D + 'T19:05:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  check('G61★', '同樣沒有假 → 19:00、晚 60 → 不代記', autoAt(m, D + 'T19:05:00'), [[], false, '19:00']);
}
{
  const m = world(D + 'T22:05:00', [['08:56:17', 'in'], ['14:32:46', 'out'], ['17:25:58', 'in']], { sched: two(['09:00', '13:00'], ['18:00', '22:00']) });
  check('G62', '取整照舊：08:56:17–14:32:46、17:25:58 → 22:00（原始 21:49:29）、晚 0 → 代記', autoAt(m, D + 'T22:05:00'), [['11-20 22:00'], true, null]);
}

console.log('\n════ 七、開關 ════');
{
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00'), props: { REST_CAP_ON: '1' } });
  check('G70', "REST_CAP_ON='1'：跟改版前一樣 19:00 代記", autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
}
{
  const m = world(D2 + 'T05:30:00', [['14:00:00', 'in']], { sched: one('14:00', '23:00'), props: { REST_CAP_ON: '1' } });
  const r = punch(m, 'in');
  check('G71', "REST_CAP_ON='1'：隔天 05:30 按上班 → 照舊寫 00:00、cap_locked", [r.status, sysHm(m)], ['cap_locked', ['11-21 00:00']]);
}
['3', 'on', '', ' 2', '2 '].forEach((v, i) => {
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00'), props: { REST_CAP_ON: v } });
  check('G7' + (2 + i), "REST_CAP_ON='" + v + "'：收卡關著（同改版前）→ 不寫、不擋", [autoAt(m, D + 'T19:10:00'), punch(m, 'out').ok], [[[], false, null], true]);
});
{
  const m = world(D + 'T09:00:00', [], { props: { REST_CAP_ON: undefined } });
  const trig = [];
  m.sb.ScriptApp = { getProjectTriggers: () => trig.slice(), deleteTrigger: (t) => { trig.splice(trig.indexOf(t), 1); },
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { trig.push({ getHandlerFunction: () => fn }); } }) }) }) };
  delete m.props.REST_CAP_ON;
  const q = (b) => m.sb.handleCapSet_(Object.assign({ admin_key: 'ADM' }, b));
  check('G80', '收卡關著時只帶 grace:true → 不會打開收卡', [q({ grace: true }), m.props.REST_CAP_ON], [{ ok: true, on: false, trigger: 0, grace: false }, undefined]);
  check('G81', "on:true（沒帶 grace）→ 跟改版前一樣寫 '1'、回應沒有 grace 欄", [q({ on: true }), m.props.REST_CAP_ON], [{ ok: true, on: true, trigger: 1 }, '1']);
  check('G82', "grace:true → '2'、觸發器不動", [q({ grace: true }), m.props.REST_CAP_ON], [{ ok: true, on: true, trigger: 1, grace: true }, '2']);
  check('G83', '只查 → 回 grace:true', q({}), { ok: true, on: true, trigger: 1, grace: true });
  check('G84', "grace:false → '1'", [q({ grace: false }), m.props.REST_CAP_ON], [{ ok: true, on: true, trigger: 1, grace: false }, '1']);
  check('G85', "on:true＋grace:true → '2'、觸發器一支", [q({ on: true, grace: true }), m.props.REST_CAP_ON], [{ ok: true, on: true, trigger: 1, grace: true }, '2']);
  check('G86', "on:true 沒帶 grace → 回到 '1'（重開收卡會把寬限關掉，上線清單有寫）", [q({ on: true }).grace, m.props.REST_CAP_ON], [undefined, '1']);
  check('G87', '錯金鑰 → unauthorized', m.sb.handleCapSet_({ admin_key: 'X', grace: true }).error, 'unauthorized');
}

console.log('\n════ 八、capSchedEnd_ 直接算 ════');
{
  const m = world(D + 'T09:00:00', [], { sched: two(['09:00', '13:00'], ['18:00', '22:00']) });
  const hm = (ms) => (ms === null ? null : new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' '));
  check('G90', '兩段取最後一段 22:00', hm(m.sb.capSchedEnd_('E01', T(D + 'T09:00:00'))), '11-20 22:00');
  check('G91', '別的工號 → null', m.sb.capSchedEnd_('E99', T(D + 'T09:00:00')), null);
  check('G92', '上班卡在下班之後 → null', m.sb.capSchedEnd_('E01', T(D + 'T22:00:00')), null);
  check('G93', '剛好 30 分不算「超過」、30 分 1 秒算', [m.sb.capGraceLate_('E01', T(D + 'T09:00:00'), T(D + 'T22:30:00')), m.sb.capGraceLate_('E01', T(D + 'T09:00:00'), T(D + 'T22:30:01'))], [false, true]);
}

console.log('\n════ 九、2026-11 已發生的 9 筆系統收卡套新規則（時間取新規則的 15 分刻度；班表照主管提供）════');
// [編號, 說明, 事件, 班表, 現在, 設定, 預期系統卡（空＝不代記）]
const NINE = [
  ['N1', '11/15 墨竹亭光復：10–19、滿 10＝21:30（晚 150）→ 有班表就不代記', [['11:30:00', 'in']], one('10:00', '19:00'), D + 'T21:40:00', null, []],
  ['N1b', '　同上、但墨竹亭光復 T01 實際已取消發布（讀不到）→ 照舊代記', [['11:30:00', 'in']], null, D + 'T21:40:00', null, ['11-20 21:30']],
  ['N2', '11/15 六張犁：09–18、滿 10＝20:00（晚 120）→ 不代記', [['10:00:00', 'in']], one('09:00', '18:00'), D + 'T20:10:00', null, []],
  ['N3', '11/16 央廚：08–17（扣 12–13）、滿 10＝19:00（晚 120）→ 不代記', [['08:00:00', 'in']], one('08:00', '17:00'), D + 'T19:10:00', CF, []],
  ['N4', '11/16 總部：10–19（扣 14–15）、滿 10＝21:00（晚 120）→ 不代記', [['10:00:00', 'in']], one('10:00', '19:00'), D + 'T21:10:00', HQ, []],
  ['N5', '11/17 金山：10–14＋16:30–20:30、滿 10＝20:45（晚 15）→ 代記', [['10:45:00', 'in']], two(['10:00', '14:00'], ['16:30', '20:30']), D + 'T20:50:00', null, ['11-20 20:45']],
  ['N5b', '　同上、取整後 21:00（晚 30，剛好）→ 代記', [['11:00:00', 'in']], two(['10:00', '14:00'], ['16:30', '20:30']), D + 'T21:05:00', null, ['11-20 21:00']],
  ['N5c', '　金山實際沒發布班表（讀不到）→ 照舊代記', [['10:45:00', 'in']], null, D + 'T20:50:00', null, ['11-20 20:45']],
  ['N6', '11/19 六張犁：09–13＋18–22、滿 10＝20:00（早於下班）→ 代記', [['10:00:00', 'in']], two(['09:00', '13:00'], ['18:00', '22:00']), D + 'T20:10:00', null, ['11-20 20:00']],
  ['N7', '11/19 央廚：08–17、滿 10＝21:30（晚 270）→ 不代記', [['10:30:00', 'in']], one('08:00', '17:00'), D + 'T21:40:00', CF, []],
  ['N8', '11/20 六張犁：09–13＋18–22、08:56:17–14:32:46、17:25:58 → 22:00（晚 0）→ 代記', [['08:56:17', 'in'], ['14:32:46', 'out'], ['17:25:58', 'in']], two(['09:00', '13:00'], ['18:00', '22:00']), D + 'T22:05:00', null, ['11-20 22:00']],
  ['N9', '11/22 墨竹亭光復：11:30–15:30＋16:30–20:30、滿 10＝22:45（晚 135）→ 不代記', [['12:45:00', 'in']], two(['11:30', '15:30'], ['16:30', '20:30']), D + 'T22:50:00', null, []],
  ['N9b', '　同上、T01 實際已取消發布（讀不到）→ 照舊代記', [['12:45:00', 'in']], null, D + 'T22:50:00', null, ['11-20 22:45']],
];
NINE.forEach(([id, label, evs, sched, now, cfg, want]) => {
  const m = world(now, evs, { sched: sched, config: cfg || undefined });
  const got = autoAt(m, now);
  check(id + (want.length ? '' : '★'), label, got[0], want);
});

/* ════ 十、獨立審查第一輪（codex-231-r1）三條擋項 ════
 * X 跨店：同仁在 B 店（代碼 mzt、B 店工號 B07）支援，09:00 在 B 店刷上班；19:00 從 A 店（光復＝自己）開頁或按上班。
 *   規則：用「那一段所在門市」的班表（sched_pub 的 mzt 列）＋B 店名冊同名在職的工號判斷；讀不到 B 店那一期、B 店名冊對不到人 → 照舊（鎖、sys_hm）。
 *   手算：X1 B 店 09–18、滿 10＝19:00、晚 60 → 不鎖、grace_hm 19:00、兩店都沒有系統卡。X2 B 店沒發布（A 店自己有 E01 09–18）→ 不拿 A 店的、照舊鎖 19:00。
 *         X3 B 店班表上的工號是 E01（A 店工號）、B 店名冊是 B07 → 對不到 → 照舊鎖。X4 19:30 在 A 店按上班 → 放行、不寫。X5 開關 '1' → 照舊鎖。
 *         X6 B 店 09:00–18:30 → 晚 30（剛好）→ 照舊鎖。
 * Y 凌晨才刷進跨夜班：11/20 排 18:00–隔日 02:00（11/21 例假 R）。
 *   規則：上班卡落在「前一天班表最後一段跨過午夜、且上班卡早於那段下班」→ 用前一天那段的下班；否則用當天班表（同改前）。
 *   手算：Y1 11/21 00:05 上班（取整 00:15）→ 滿 10＝10:15、比 02:00 晚 8 小時 15 分 → 不代記。Y2 03:00 才刷（已過 02:00）→ 用 11/21（R）→ 照舊 13:00 代記。
 *         Y3 前一天 09–18（沒跨夜）、00:05 上班 → 用 11/21（R）→ 照舊 10:15。Y4 01:30 上班、11/21 另有 09–18 → 用前一天 02:00 → 滿 10＝11:30 晚 570 → 不代記。
 *         Y5 前一天 15:00–24:00（剛好到午夜不算跨夜）→ 用 11/21（R）→ 照舊。
 * Z 快取：整份 sched_pub 很大（> 90,000 字）時，寬限判斷只在第一次讀表，之後 5 分鐘內用「店＋期」的快取（太大分塊）；快取寫不進去 → 同一次執行只讀一次。 */
console.log('\n════ 十、審查第一輪：跨店、凌晨跨夜班、班表快取 ════');
const SP_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];
const schedFor = (emp, shifts, cell, c20) => ({ start: '2026-11-01', shifts: shifts, rows: [{ emp_id: emp, name: '測試一',
  cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? cell : i === 20 && c20 ? c20 : { t: 'R' })) }] });
/** A 店＝光復（自己，代碼 gf）、B 店＝SS_B（代碼 mzt）。opt.b：B 店 sched_pub 資料（null＝沒有）；opt.a：A 店（E01）資料；opt.bEvents */
function worldX(now, opt) {
  const m = make({ now: T(now), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: opt.cap === undefined ? '2' : opt.cap },
    self: { roster: [ME], events: opt.aEvents || [] },
    peers: { SS_B: { roster: [{ emp_id: 'B07', name: '測試 一', key: 'KB', device_id: 'DB', active: 'TRUE' }], events: opt.bEvents || [[D + 'T09:00:00', 'B07', 'in']] } } });
  m.run(R('apps-script/Cap10.gs'));
  m.sb.REST_PEERS_ = [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }];
  const sh = m.self.insertSheet('sched_pub');
  sh.appendRow(SP_HEAD);
  if (opt.a) sh.appendRow(['', 'T01', 1, JSON.stringify(opt.a), 'op', '']);
  if (opt.b) sh.appendRow(['mzt', 'T01', 1, JSON.stringify(opt.b), 'op', '']);
  return m;
}
const bSys = (m) => m.peers.SS_B.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0).length;
const sOf = (m) => { const s = status(m).cap; return [!!s.locked, s.grace_hm || null, s.sys_hm || null, sysRows(m).length, bSys(m)]; };
const B918 = schedFor('B07', [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'W', s: 'A' });
check('X1★', '跨店：B 店 09–18（B 店工號 B07）、19:00 從 A 店開頁 → 不鎖、grace_hm 19:00、兩店都沒有系統卡',
  sOf(worldX(D + 'T19:00:00', { b: B918 })), [false, '19:00', null, 0, 0]);
check('X2', '跨店：B 店沒發布（A 店自己有 E01 09–18 也不拿來用）→ 照舊鎖、sys_hm 19:00',
  sOf(worldX(D + 'T19:00:00', { a: schedFor('E01', [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'W', s: 'A' }) })), [true, null, '19:00', 0, 0]);
check('X3', '跨店：B 店班表上寫的是 A 店工號 E01（B 店名冊是 B07）→ 對不到人 → 照舊鎖',
  sOf(worldX(D + 'T19:00:00', { b: schedFor('E01', [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'W', s: 'A' }) })), [true, null, '19:00', 0, 0]);
{
  const m = worldX(D + 'T19:30:00', { b: B918 });
  const r = punch(m, 'in');
  check('X4★', '跨店：19:30 在 A 店按上班 → 放行（A 店一張上班卡）、兩店都不寫系統卡', [r.ok, m.events().filter((e) => e.type === 'in').length, sysRows(m).length, bSys(m)], [true, 1, 0, 0]);
}
check('X5', "跨店：開關 '1' → 跟 38d0340 一樣鎖、sys_hm 19:00", sOf(worldX(D + 'T19:00:00', { b: B918, cap: '1' })), [true, null, '19:00', 0, 0]);
check('X6', '跨店：B 店 09:00–18:30 → 滿 10 晚 30（剛好）→ 照舊鎖',
  sOf(worldX(D + 'T19:00:00', { b: schedFor('B07', [{ id: 'A', name: '班', start: '09:00', end: '18:30' }], { t: 'W', s: 'A' }) })), [true, null, '19:00', 0, 0]);
{
  const m = worldX(D + 'T19:00:00', { b: B918 });
  check('X7', 'capSchedEnd_ 直接算：B 店那段 → 11-20 18:00；名字對不到 → unsure',
    [new Date(m.sb.capSchedEnd_('E01', T(D + 'T09:00:00'), 'mzt', '測試一') + 8 * 3600000).toISOString().slice(5, 16), m.sb.capSchedEnd_('E01', T(D + 'T09:00:00'), 'mzt', '別人')],
    ['11-20T18:00', 'unsure']);   // 2026-11-23 第二輪：別家店對不到人＝unsure（不鎖不提示），不是 null（照舊）
}

{
  // X8：跨店＋凌晨跨夜班情境，開關不是 '2' 時（'1'、沒設、'0'、'3'、' 2'、數字 2）與 38d0340 的 Cap10.gs 逐步比對：每一步回應＋A、B 兩店 events＋屬性
  const OLD = require('child_process').execFileSync('git', ['-C', require('path').join(__dirname, '..'), 'show', '38d0340:apps-script/Cap10.gs'], { encoding: 'utf8' });
  const NIGHT_X = schedOf([{ id: 'N', name: '夜', start: '18:00', end: '02:00' }], { t: 'W', s: 'N' });
  const OPS = ['status', 'sweep', 'punch_in', 'punch_out', 'lclock_in', 'lclock_out', 'old_in', 'old_out'];
  const runOp = (m, op) => {
    const post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
    if (op === 'status') return m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
    if (op === 'sweep') { m.sb.capSweep(); return null; }
    if (op.startsWith('punch_')) return m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: op.slice(6), confirm_same: true }, HERE));
    if (op.startsWith('lclock_')) return m.sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: op.slice(7) }, HERE));
    return post(Object.assign({ action: 'clock', key: 'K1', type: op.slice(4), device_id: 'D1' }, HERE));
  };
  const scen = [
    { name: '跨店 B 09–18', mk: (cap, src) => { const m = worldX(D + 'T19:00:00', { b: B918, cap: cap }); if (src) m.run(src); m.sb.REST_PEERS_ = [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }]; return m; }, times: ['T19:00:00', 'T19:30:00', 'T20:10:00'].map((x) => D + x) },
    { name: '跨店 B 沒發布', mk: (cap, src) => { const m = worldX(D + 'T19:00:00', { cap: cap }); if (src) m.run(src); m.sb.REST_PEERS_ = [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }]; return m; }, times: ['T19:00:00', 'T19:30:00'].map((x) => D + x) },
    { name: '凌晨跨夜班', mk: (cap, src) => { const m = world(D2 + 'T10:15:00', [[D2 + 'T00:05:00', 'in']], { sched: NIGHT_X, props: { REST_CAP_ON: cap } }); if (src) m.run(src); return m; }, times: ['T10:15:00', 'T10:40:00', 'T11:20:00'].map((x) => D2 + x) },
  ];
  let same = 0, diff = [];
  ['1', null, '0', '3', ' 2', 2].forEach((cap) => scen.forEach((sc) => OPS.forEach((op0) => {
    const a = sc.mk(cap, OLD), b = sc.mk(cap, null);
    if (cap === null) { delete a.props.REST_CAP_ON; delete b.props.REST_CAP_ON; }
    let ok = true;
    sc.times.forEach((t, i) => {
      const op = i === 0 ? op0 : OPS[(OPS.indexOf(op0) + i * 3) % OPS.length];
      a.setNow(t); b.setNow(t);
      const ra = JSON.stringify(runOp(a, op)), rb = JSON.stringify(runOp(b, op));
      const ta = JSON.stringify([a.self.sh.events.values, a.peers.SS_B ? a.peers.SS_B.sh.events.values : null, a.props]), tb = JSON.stringify([b.self.sh.events.values, b.peers.SS_B ? b.peers.SS_B.sh.events.values : null, b.props]);
      if (ok && (ra !== rb || ta !== tb)) { ok = false; diff.push([String(cap), sc.name, op, t, ra.slice(0, 160), rb.slice(0, 160)]); }
    });
    if (ok) same++;
  })));
  check('X8', "跨店／凌晨跨夜班：開關 '1'、沒設、'0'、'3'、' 2'、數字 2 × 3 種情境 × 8 種起手動作（開頁、掃描、LINE 上下班、liff_clock 上下班、舊連結上下班）與 38d0340 逐步相同",
    [same, diff.slice(0, 2)], [6 * 3 * 8, []]);
}
const NIGHT = schedOf([{ id: 'N', name: '夜', start: '18:00', end: '02:00' }], { t: 'W', s: 'N' });
{
  const m = world(D2 + 'T10:15:00', [[D2 + 'T00:05:00', 'in']], { sched: NIGHT });
  check('Y1★', '11/20 18:00–02:00、11/21 例假；11/21 00:05 上班、10:15 掃描＋開頁 → 用 11/20 那段 02:00、晚 8 小時 15 分 → 不代記',
    autoAt(m, D2 + 'T10:15:00'), [[], false, '10:15']);
}
{
  const m = world(D2 + 'T13:05:00', [[D2 + 'T03:00:00', 'in']], { sched: NIGHT });
  check('Y2', '03:00 才刷（已過前一天那段的 02:00）→ 用 11/21（例假）→ 照舊 13:00 代記', autoAt(m, D2 + 'T13:05:00'), [['11-21 13:00'], true, null]);
}
{
  const m = world(D2 + 'T10:20:00', [[D2 + 'T00:05:00', 'in']], { sched: one('09:00', '18:00') });
  check('Y3', '前一天 09–18（沒跨夜）、00:05 上班 → 用 11/21（例假）→ 照舊 10:15 代記', autoAt(m, D2 + 'T10:20:00'), [['11-21 10:15'], true, null]);
}
{
  const sc = schedOf([{ id: 'N', name: '夜', start: '18:00', end: '02:00' }, { id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'W', s: 'N' }, { t: 'W', s: 'A' });
  const m = world(D2 + 'T11:35:00', [[D2 + 'T01:30:00', 'in']], { sched: sc });
  check('Y4★', '01:30 上班、11/21 另有 09–18 → 上班卡落在前一天跨夜段 → 用 02:00、滿 10＝11:30 → 不代記', autoAt(m, D2 + 'T11:35:00'), [[], false, '11:30']);
}
{
  const m = world(D2 + 'T10:20:00', [[D2 + 'T00:05:00', 'in']], { sched: one('15:00', '24:00') });
  check('Y5', '前一天 15:00–24:00（剛好到午夜不算跨夜）→ 用 11/21（例假）→ 照舊 10:15 代記', autoAt(m, D2 + 'T10:20:00'), [['11-21 10:15'], true, null]);
}
{
  const m = world(D2 + 'T10:15:00', [], { sched: NIGHT });
  const hm = (ms) => (ms === null ? null : new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' '));
  check('Y6', 'capSchedEnd_ 直接算：11/21 00:05 → 11-21 02:00；02:00 整 → null（用 11/21 例假）；11/20 18:00 → 11-21 02:00',
    [hm(m.sb.capSchedEnd_('E01', T(D2 + 'T00:05:00'))), hm(m.sb.capSchedEnd_('E01', T(D2 + 'T02:00:00'))), hm(m.sb.capSchedEnd_('E01', T(D + 'T18:00:00')))],
    ['11-21 02:00', null, '11-21 02:00']);
}

/** 班表很大：本店（光復）E01 09–18 一列＋其他 n 家店、每家 per 人 */
function bigWorld(now, n, per, selfPer) {
  const m = world(now, [['08:55:00', 'in']], { sched: undefined });
  m.sb.REST_PEERS_ = [{ code: 'gf', ss: 'SELF' }];
  const sh = m.self.insertSheet('sched_pub');
  sh.appendRow(SP_HEAD);
  const mk = (emp0, cnt, lastE01) => ({ start: '2026-11-01', shifts: [{ id: 'A', name: '早班', start: '09:00', end: '18:00' }, { id: 'B', name: '晚班', start: '14:00', end: '23:00' }],
    stations: [{ id: 's1', name: '內場' }],
    rows: Array.from({ length: cnt }, (_, k) => ({ emp_id: (lastE01 && k === cnt - 1) ? 'E01' : emp0 + k, name: '同仁名字' + k,
      cells: Array.from({ length: 28 }, (_, i) => (i % 7 === 6 ? { t: 'R' } : { t: 'W', s: i % 2 ? 'A' : 'B', st: 's1' })) })) });
  sh.appendRow(['', 'T01', 1, JSON.stringify(mk('G', selfPer || 1, true)), 'op', '']);
  for (let i = 0; i < n; i++) sh.appendRow(['st' + i, 'T01', 1, JSON.stringify(mk('S' + i + '_', per)), 'op', '']);
  // 照 Google 的單鍵上限：值超過 100KB（UTF-8）就丟錯
  const c = m.sb.CacheService.getScriptCache(), put = c.put, putAll = c.putAll;
  const tooBig = (v) => Buffer.byteLength(String(v), 'utf8') > 100 * 1024;
  m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, {
    put: (k, v, t) => { if (tooBig(v)) throw new Error('Argument too large: value'); return put(k, v, t); },
    putAll: (o, t) => { Object.keys(o).forEach((k) => { if (tooBig(o[k])) throw new Error('Argument too large: value'); }); return putAll(o, t); } }) };
  let reads = 0;
  const gdr = sh.getDataRange;
  sh.getDataRange = function () { reads++; return gdr.apply(this, arguments); };
  return { m, reads: () => reads, size: () => sh.values.slice(1).reduce((s, r) => s + String(r[3]).length, 0) };
}
{
  const w = bigWorld(D + 'T19:00:00', 12, 30);
  const s1 = status(w.m).cap, r1 = w.reads();
  w.m.setNow(D + 'T19:01:00');
  const s2 = status(w.m).cap, r2 = w.reads() - r1;
  w.m.setNow(D + 'T19:02:00'); w.m.sb.capSweep();
  const r3 = w.reads() - r1 - r2;
  check('Z1★', '整份班表 ' + (w.size() > 90000 ? '> 90,000 字' : '（太小，測試寫錯）') + '：19:00 開頁讀 1 次、19:01 再開頁讀 0 次、19:02 掃描讀 0 次，結果都是 grace_hm 19:00',
    [w.size() > 90000, r1, r2, r3, s1.grace_hm, s2.grace_hm, sysRows(w.m).length], [true, 1, 0, 0, '19:00', '19:00', 0]);
  w.m.setNow(D + 'T19:06:00');
  const s4 = status(w.m).cap;
  check('Z2', '快取 5 分鐘到期後（19:06）才再讀 1 次', [w.reads() - r1 - r2 - r3, s4.grace_hm], [1, '19:00']);
}
{
  const w = bigWorld(D + 'T19:00:00', 0, 0, 400);   // 本店一期就 400 人（E01 在最後）：單鍵放不下 → 分塊
  const s1 = status(w.m).cap, r1 = w.reads();
  w.m.setNow(D + 'T19:01:00');
  const s2 = status(w.m).cap;
  check('Z3', '單一店＋期就超過單鍵上限（' + (w.size() > 102400 ? '> 100KB' : '太小') + '）→ 分塊快取：第二次開頁讀 0 次、E01（最後一塊）照樣判到',
    [w.size() > 102400, r1, w.reads() - r1, s1.grace_hm, s2.grace_hm], [true, 1, 0, '19:00', '19:00']);
}
{
  const w = bigWorld(D + 'T19:00:00', 12, 30);
  const c = w.m.sb.CacheService.getScriptCache();
  w.m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { put: () => { throw new Error('快取壞了'); }, putAll: () => { throw new Error('快取壞了'); } }) };
  // 同一次執行（掃描）裡判三個人：快取完全寫不進去 → 同次執行記住，只讀 1 次
  w.m.self.sh.roster.appendRow(['E02', '測試二', 'K2', 'D2', '', 'TRUE']);
  w.m.self.sh.roster.appendRow(['E03', '測試三', 'K3', 'D3', '', 'TRUE']);
  w.m.self.sh.events.appendRow([D + 'T08:55:00+08:00', 'E02', 'in', 24.7840945, 121.0157448, 5, true, 'D2', true, 'ok', 10]);
  w.m.self.sh.events.appendRow([D + 'T08:55:00+08:00', 'E03', 'in', 24.7840945, 121.0157448, 5, true, 'D3', true, 'ok', 10]);
  w.m.sb.capSweep();
  check('Z4', '快取寫不進去：同一次掃描判 3 個人只讀 1 次', w.reads(), 1);
}

/* ════ 十一、第二輪驗收（verify-231b）兩條擋項 ════
 * Q 同名兩個工號：B 店（代碼 mzt）名冊有同名在職的 B07、B08；B07 在 B 店 11/20 09:00 上班；19:10。
 *   規則：A 店判別家店那段時，同名不只一個 → 讀 B 店打卡列，找上班卡時間剛好是那一段的工號（B07），用他的班表——跟 B 店自己用本人工號判的一樣。
 *   還是分不出（兩人同一秒都有上班卡）→ A 店不鎖、不回 grace_hm（B 店自己決定寫不寫；寫了 A 店下次讀到卡才鎖）＝不會「沒卡卻鎖」。
 *   手算：Q1 B07 09–18／B08 10–20（下班不同）→ B07 滿 10＝19:00、晚 60 → A 頁、B 頁都不鎖、grace_hm 19:00；A 店按上班放行；B 店掃描不寫。
 *         Q2 兩人都 09–18（下班相同）→ 同 Q1。Q3 B07 09–19／B08 10–20 → B07 晚 0 → 照舊：A 頁鎖（sys 19:00、卡由 B 店寫＝跟 38d0340 一樣）、B 店掃描寫卡。
 *         Q4 兩人同一秒 09:00 上班（分不出）→ A 頁不鎖不提示、A 按上班放行；B 頁（B07）grace 19:00；B 店掃描 B07 不寫、B08 照舊寫。
 *         Q5 同 Q4 但 B 店沒發布 → A 頁先不鎖（還沒卡）、B 掃描寫卡 → A 頁讀到卡才鎖。
 *         Q6 別家店那段、本人在 A 店按下班：那家店判寬限（不會寫）→ A 店不回 cap_locked（放行）；那家店沒發布 → 照舊 cap_locked。
 * K 快取內容壞：暖快取後把資料塊／目錄改壞 → 一律重讀 sched_pub 一次（並重寫快取，下一次 0 次），結果照寬限（grace_hm 19:00、掃描不寫）；
 *   重讀本身丟錯、或重讀發現真的沒發布 → 照舊代記。 */
console.log('\n════ 十一、第二輪驗收：同名兩工號、快取內容壞 ════');
const B07R = { emp_id: 'B07', name: '測試一', key: 'KB', device_id: 'DB', active: 'TRUE', line_user_id: 'U1' };
const B08R = { emp_id: 'B08', name: '測試 一', key: 'KB8', device_id: 'DB8', active: 'TRUE' };
const shiftsQ = [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'C', name: '晚', start: '10:00', end: '20:00' }, { id: 'E', name: '長', start: '09:00', end: '19:00' }];
const schedQ = (s7, s8) => ({ start: '2026-11-01', shifts: shiftsQ, rows: [['B07', s7], ['B08', s8]].map(([id, sid]) => ({ emp_id: id, name: '測試一',
  cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: sid } : { t: 'R' })) })) });
/** view 'A'：自己＝光復（gf，E01），B 店是 SS_B；view 'B'：自己＝B 店（mzt，B07／B08），光復是 SS_A（sched_pub 在光復）。 */
function worldQ(view, opt) {
  const bEvents = opt.bEvents || [[D + 'T09:00:00', 'B07', 'in']];
  const aSpec = { roster: [ME], events: opt.aEvents || [] }, bSpec = { roster: [B07R, B08R], events: bEvents };
  const m = make({ now: T(opt.now || D + 'T19:10:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: opt.cap || '2' },
    self: view === 'A' ? aSpec : bSpec, peers: view === 'A' ? { SS_B: bSpec } : { SS_A: aSpec } });
  m.run(R('apps-script/Cap10.gs'));
  m.sb.REST_PEERS_ = view === 'A' ? [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }] : [{ code: 'mzt', ss: 'SELF' }, { code: 'gf', ss: 'SS_A' }];
  const gfBook = view === 'A' ? m.self : m.peers.SS_A;
  const sh = gfBook.insertSheet('sched_pub');
  sh.appendRow(SP_HEAD);
  if (opt.b) sh.appendRow(['mzt', 'T01', 1, JSON.stringify(opt.b), 'op', '']);
  m.bBook = view === 'A' ? m.peers.SS_B : m.self;
  return m;
}
const isSys = (r) => r.indexOf('system_cap') >= 0;
const bSysQ = (m) => m.bBook.sh.events.values.filter(isSys).map((r) => String(r[0]).slice(11, 16) + ' ' + r[1]);
/** 四個角度：A 頁、B 頁、A 店按上班、B 店掃描後 B 店的系統卡 */
function fourQ(opt) {
  const sA = worldQ('A', opt), sB = worldQ('B', opt), pA = worldQ('A', opt), wB = worldQ('B', opt);
  const ca = status(sA).cap, cb = status(sB).cap, r = punch(pA, 'in');
  wB.sb.capSweep();
  return { aPage: [!!ca.locked, ca.grace_hm || null, ca.sys_hm || null], bPage: [!!cb.locked, cb.grace_hm || null, cb.sys_hm || null],
    aIn: [r.ok, r.status || null], bSweep: bSysQ(wB), sysAnywhere: bSysQ(sA).length + bSysQ(pA).length };
}
{
  const q = fourQ({ b: schedQ('A', 'C') });
  check('Q1★', '同名兩工號、下班不同（B07 09–18／B08 10–20）：A 頁＝B 頁＝不鎖、grace_hm 19:00；A 店按上班放行；B 店掃描不寫', q,
    { aPage: [false, '19:00', null], bPage: [false, '19:00', null], aIn: [true, null], bSweep: [], sysAnywhere: 0 });
}
{
  const q = fourQ({ b: schedQ('A', 'A') });
  check('Q2', '同名兩工號、下班相同（都 09–18）：四個角度同 Q1', q,
    { aPage: [false, '19:00', null], bPage: [false, '19:00', null], aIn: [true, null], bSweep: [], sysAnywhere: 0 });
}
{
  const q = fourQ({ b: schedQ('E', 'C') });
  check('Q3', '同名兩工號、B07 09–19（晚 0 → 照舊）：A 頁、B 頁都鎖 sys 19:00；A 按上班擋；B 店掃描寫 19:00 B07', q,
    { aPage: [true, null, '19:00'], bPage: [true, null, '19:00'], aIn: [false, 'cap_locked'], bSweep: ['19:00 B07'], sysAnywhere: 0 });
}
{
  const ev = [[D + 'T09:00:00', 'B07', 'in'], [D + 'T09:00:00', 'B08', 'in']];
  const q = fourQ({ b: schedQ('A', 'C'), bEvents: ev });
  check('Q4★', '同名兩人同一秒上班（A 店分不出）：A 頁不鎖不提示；A 按上班放行；B 頁（B07）grace 19:00；B 店掃描 B07 不寫、B08（10–20）照舊寫', q,
    { aPage: [false, null, null], bPage: [false, '19:00', null], aIn: [true, null], bSweep: ['19:00 B08'], sysAnywhere: 0 });
}
{
  const ev = [[D + 'T09:00:00', 'B07', 'in'], [D + 'T09:00:00', 'B08', 'in']];
  const m = worldQ('A', { bEvents: ev });   // B 店沒發布
  const s1 = status(m).cap;
  const wB = worldQ('B', { bEvents: ev }); wB.sb.capSweep();
  m.bBook.sh.events.values[0] = wB.bBook.sh.events.values[0].slice();   // 表頭多了 source 欄（capWrite_ 補的）
  wB.bBook.sh.events.values.filter(isSys).forEach((r) => m.bBook.sh.events.values.push(r));   // B 店掃描寫的卡＝A 店讀得到的 B 店打卡列
  const s2 = status(m).cap;
  check('Q5★', '同 Q4 但 B 店沒發布：A 頁先不鎖（還沒有卡）；B 店掃描寫卡後 A 頁讀到卡才鎖、sys 19:00',
    [[!!s1.locked, s1.grace_hm || null, s1.sys_hm || null], bSysQ(wB), [!!s2.locked, s2.sys_hm || null]], [[false, null, null], ['19:00 B07', '19:00 B08'], [true, '19:00']]);
}
{
  const m = worldQ('A', { b: schedQ('A', 'C') });
  const r = punch(m, 'out');
  const m2 = worldQ('A', {});
  const r2 = punch(m2, 'out');
  check('Q6★', '別家店那段、本人在 A 店按下班：那家店判寬限（不會寫）→ 不回 cap_locked、放行；那家店沒發布 → 照舊 cap_locked',
    [[r.ok, r.status || null], [r2.ok, r2.status || null], sysRows(m).length + sysRows(m2).length], [[true, null], [false, 'cap_locked'], 0]);
}
{
  const m = worldQ('A', { b: schedQ('A', 'C'), cap: '1' });
  const c = status(m).cap;
  check('Q7', "開關 '1'：同名兩工號跟 38d0340 一樣 A 頁鎖 sys 19:00", [!!c.locked, c.sys_hm], [true, '19:00']);
}

/** 暖快取後改壞再開頁：[第一次讀幾次, 第二次讀幾次, grace_hm, 鎖, 掃描後系統卡, 掃描讀幾次] */
function corrupt(fn) {
  const m = world(D + 'T19:00:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  let reads = 0;
  const sh = m.self.sh.sched_pub, gdr = sh.getDataRange;
  sh.getDataRange = function () { reads++; return gdr.apply(this, arguments); };
  status(m);
  const r0 = reads;
  fn(m.cache);
  m.setNow(D + 'T19:01:00');
  const s = status(m).cap, r1 = reads - r0;
  m.sb.capSweep();
  const r2 = reads - r0 - r1;
  return [r0, r1, s.grace_hm || null, !!s.locked, sysHm(m), r2];
}
const CI = 'capgr1:i', C0 = 'capgr1:d:|T01:0';
const setv = (c, k, v) => { if (c[k]) c[k].v = v; else c[k] = { v: v, exp: Infinity }; };
const edit = (c, f) => { const o = JSON.parse(c[C0].v); f(o); setv(c, C0, JSON.stringify(o)); };
const KASES = [
  ['K1★', '資料塊改成 {壞', (c) => setv(c, C0, '{壞')],
  ['K2★', '資料塊改成 null', (c) => setv(c, C0, 'null')],
  ['K3★', '資料塊改成 {}', (c) => setv(c, C0, '{}')],
  ['K4★', '目錄改成 []', (c) => setv(c, CI, '[]')],
  ['K5', '目錄說 2 塊（第 2 塊不存在）', (c) => setv(c, CI, JSON.stringify({ v: 1, k: { '|T01': 2 } }))],
  ['K6★', '資料塊是別期的（k 不對）', (c) => edit(c, (o) => { o.k = 'mzt|T01'; })],
  ['K7★', '資料塊 rows 不是陣列', (c) => edit(c, (o) => { o.rows = 'x'; })],
  ['K8★', '資料塊某列 cells 不是陣列', (c) => edit(c, (o) => { o.rows[0].cells = {}; })],
  ['K9★', '資料塊編號 i 不對', (c) => edit(c, (o) => { o.i = 3; })],
  ['K10★', '資料塊 shifts 不見', (c) => edit(c, (o) => { delete o.shifts; })],
  ['K11', '目錄 JSON 壞', (c) => setv(c, CI, '{壞')],
  ['K12', '目錄 null', (c) => setv(c, CI, 'null')],
  ['K13★', '目錄塊數是字串 "1"', (c) => setv(c, CI, JSON.stringify({ v: 1, k: { '|T01': '1' } }))],
  ['K14★', '目錄是舊格式（沒有 v，直接 {店|期: 塊數}）', (c) => setv(c, CI, JSON.stringify({ '|T01': 1 }))],
  ['K15', '資料塊空字串', (c) => setv(c, C0, '')],
  ['K16★', '資料塊是數字 0', (c) => setv(c, C0, '0')],
  ['K17★', '資料塊某列是 null', (c) => edit(c, (o) => { o.rows[0] = null; })],
];
KASES.forEach(([id, label, fn]) => {
  check(id, '快取' + label + ' → 重讀 1 次、照寬限（grace_hm 19:00、不鎖、掃描不寫）、重寫後掃描 0 次', corrupt(fn), [1, 1, '19:00', false, [], 0]);
});
{
  const m = world(D + 'T19:00:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  status(m);
  setv(m.cache, C0, '{壞');
  m.self.sh.sched_pub.getDataRange = () => { throw new Error('讀取失敗'); };
  check('K20', '快取壞＋重讀 sched_pub 本身丟錯 → 照舊代記（19:00、鎖）', autoAt(m, D + 'T19:01:00'), [['11-20 19:00'], true, null]);
}
{
  const m = world(D + 'T19:00:00', [['08:55:00', 'in']], { sched: one('09:00', '18:00') });
  status(m);
  m.self.sh.sched_pub.values.length = 1;   // 取消發布（表裡沒有這期）
  setv(m.cache, C0, '{壞');
  check('K21', '快取壞＋重讀發現真的沒發布 → 照舊代記', autoAt(m, D + 'T19:01:00'), [['11-20 19:00'], true, null]);
}

done();
