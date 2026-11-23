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
// 測試世界只有 1～3 家店：把「REST_PEERS_ 至少 9 家」的門檻換成 1（門檻本身的測試在十三、S10 用原值）
const CAP_SRC_REAL = R('apps-script/Cap10.gs');
const CAP_SRC = CAP_SRC_REAL.replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;');
if (CAP_SRC === CAP_SRC_REAL) throw new Error('找不到 CAP_SINGLE_STORES');
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
  m.run(CAP_SRC);
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
  m.run(CAP_SRC);
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
  m.run(CAP_SRC);
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
  // 審查第二輪第 4 條：內層缺欄／型別錯
  ['K30★', '當天班表格缺 t', (c) => edit(c, (o) => { delete o.rows[0].cells[19].t; })],
  ['K31★', 'shifts[0] 是 null', (c) => edit(c, (o) => { o.shifts[0] = null; })],
  ['K32★', '班表格 t 是數字', (c) => edit(c, (o) => { o.rows[0].cells[19].t = 1; })],
  ['K33★', '班表格 s 是物件', (c) => edit(c, (o) => { o.rows[0].cells[19].s = { x: 1 }; })],
  ['K34★', '班次 start 是陣列', (c) => edit(c, (o) => { o.shifts[0].start = ['09:00']; })],
  ['K35★', '班次 segs 不是陣列', (c) => edit(c, (o) => { o.shifts[0].segs = 'x'; })],
  ['K36★', '班次 segs 元素是 null', (c) => edit(c, (o) => { o.shifts[0].segs = [null]; })],
  ['K37★', 'shifts 元素是字串', (c) => edit(c, (o) => { o.shifts.push('A'); })],
  ['K38★', '列的 emp_id 是數字', (c) => edit(c, (o) => { o.rows[0].emp_id = 1; })],
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

/* ════ 十二、第三次驗收（verify-231b dbg4）：A 店對不到工號（unsure）時按上班 ════
 * 規則：對不到工號＝判不了＝照舊收卡。A 店按上班（LINE、liff_clock、舊 clock）→ 系統卡寫在 A 店、滿 10 那一刻（19:00）、擋下這次上班並鎖；
 *   之後 B 店掃描、兩店開頁、再按上班／下班都不多寫，兩店頁面都鎖在 19:00。開頁（auto）照舊不鎖不提示；B 店照舊代記時 B 寫了卡、A 讀到就鎖。
 * 兩家店各跑自己的程式（A 視角、B 視角兩個沙盒），每一步後把兩店 events 同步（syncQ），模擬兩邊各自讀寫同一份試算表。
 * 對不到工號的兩種來源：A 店讀 B 店名冊丟例外（單一工號 B07）、同名兩人同一秒上班（B07、B08 都排同一班）。
 * B 店班表：09–18（B 判寬限、不會代記）、09–21（滿 10 時刻早於下班 → B 照舊代記）。 */
console.log('\n════ 十二、第三次驗收：對不到工號時按上班照舊收卡（兩店同步模擬）════');
/** A 店在 capGraceWho_ 裡讀 B 店名冊／打卡列時丟例外（名冊快取也當沒有） */
function hookWho(m, kind) {
  const orig = m.sb.capGraceWho_; let inWho = false;
  m.sb.capGraceWho_ = function () { inWho = true; try { return orig.apply(this, arguments); } finally { inWho = false; } };
  const sh = m.peers.SS_B.sh[kind];
  ['getDataRange', 'getRange', 'getLastRow'].forEach((fn) => { const o = sh[fn]; if (o) sh[fn] = function () { if (inWho) throw new Error('讀取失敗'); return o.apply(this, arguments); }; });
  const c = m.sb.CacheService.getScriptCache();
  m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { get: (k) => (inWho && /^rpr:/.test(k) ? null : c.get(k)) }) };
}
const cpRows = (dst, src) => { dst.length = 0; src.forEach((r) => dst.push(r.slice())); };
function pairQ(opt) {
  const W = { A: worldQ('A', opt), B: worldQ('B', opt) };
  if (opt.hook) hookWho(W.A, opt.hook);
  return W;
}
function syncQ(W, from) {
  const aA = W.A.self.sh.events.values, aB = W.B.peers.SS_A.sh.events.values, bA = W.A.peers.SS_B.sh.events.values, bB = W.B.self.sh.events.values;
  if (from === 'A') { cpRows(aB, aA); cpRows(bB, bA); } else { cpRows(aA, aB); cpRows(bA, bB); }
}
const setNowQ = (W, t) => { W.A.setNow(t); W.B.setNow(t); };
const cardsQ = (W) => W.A.self.sh.events.values.filter(isSys).map((r) => 'A' + String(r[0]).slice(11, 16) + r[1])
  .concat(W.B.self.sh.events.values.filter(isSys).map((r) => 'B' + String(r[0]).slice(11, 16) + r[1]));
const pageQ = (m) => { const c = status(m).cap || {}; return c.locked ? 'LOCK' + c.sys_hm : c.grace_hm ? 'grace' + c.grace_hm : 'free'; };
const IN_ENTRY = [
  ['LINE', (m) => { const r = punch(m, 'in'); return r.ok ? 'ok' : r.status; }],
  ['liff_clock', (m) => { const r = m.sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: 'in' }, HERE)); return r.ok ? 'ok' : r.error + (/系統在 19:00 幫你記了下班卡/.test(r.reason || '') ? ':19:00' : ''); }],
  ['舊 clock', (m) => { const j = oldClock(m, 'in'); return j.status + (j.rest ? ':' + j.rest.code : ''); }],
];
const IN_WANT = { LINE: 'cap_locked', liff_clock: 'guard_blocked:19:00', '舊 clock': 'rejected_rest:cap10' };
const twinEv = [[D + 'T09:00:00', 'B07', 'in'], [D + 'T09:00:00', 'B08', 'in']];
const UNS = [
  ['名冊丟例外', { hook: 'roster' }],
  ['同名同秒', { bEvents: twinEv }],
];
const BS = [['B 判寬限（09–18）', 'A', false], ['B 照舊代記（09–21）', 'X', true]];
const shiftsU = shiftsQ.concat([{ id: 'X', name: '長長', start: '09:00', end: '21:00' }]);
const schedU = (sid) => ({ start: '2026-11-01', shifts: shiftsU, rows: ['B07', 'B08'].map((id) => ({ emp_id: id, name: '測試一',
  cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: sid } : { t: 'R' })) })) });
let un = 0;
{
  const c = (fn) => corrupt(fn);
  check('K22★', '快取資料塊 rows 改成 null → 當壞快取重讀（照寬限）', c((cc) => edit(cc, (o) => { o.rows = null; })), [1, 1, '19:00', false, [], 0]);
  const m = world(D + 'T19:10:00', [['08:55:00', 'in']], { sched: { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], rows: 'x' } });
  check('K23', 'sched_pub 那期 rows 本身不是陣列（資料壞）→ 照舊代記（不會每次重讀）', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
}
{
  // 發布資料本身內層怪（格沒有 t、班次有 null、segs 不是陣列、start 是物件）：正規化後快取合格 → 第二次 0 次重讀；判斷照舊代記（同原本讀不到）
  const odd = [
    ['K40', '那格沒有 t', { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], rows: [{ emp_id: 'E01', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { s: 'A' } : { t: 'R' })) }] }],
    ['K41', 'shifts 第一個是 null（班別 A 在第二個；原本讀到 null 丟錯＝照舊）', { start: '2026-11-01', shifts: [null, { id: 'A', name: '班', start: '09:00', end: '18:00' }], rows: [{ emp_id: 'E01', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) }] }],
    ['K42', 'segs 不是陣列', { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: '09:00', end: '18:00', segs: 'x' }], rows: [{ emp_id: 'E01', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) }] }],
    ['K43', 'start 是物件', { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: { h: 9 }, end: '18:00' }], rows: [{ emp_id: 'E01', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) }] }],
  ];
  odd.forEach(([id, label, sc, want]) => {
    const m = world(D + 'T19:00:00', [['08:55:00', 'in']], { sched: sc });
    let reads = 0;
    const sh = m.self.sh.sched_pub, gdr = sh.getDataRange;
    sh.getDataRange = function () { reads++; return gdr.apply(this, arguments); };
    m.sb.capGraceSched_('', 'T01');
    const r1 = reads;
    m.sb.capGraceSched_('', 'T01');
    const late = m.sb.capGraceLate_('E01', T(D + 'T08:55:00'), T(D + 'T19:00:00'));
    check(id, '發布資料本身' + label + '：快取合格（第二次讀 0 次）、判斷照舊（讀不到）', [r1, reads - r1, late], [1, 0, false]);
  });
}

/* ════ 十三、方案甲：只給「姓名只在本店名冊在職」的同仁（2026-11-23 主管定案「排除跨店的人」）════
 * 規則：姓名（去空白）在兩家以上門市名冊在職（active＝true）→ 不論開關、不論哪家店、哪個入口，整段照 38d0340；
 *   別家店名冊讀不到、或讀到 0 位在職 → 判不了 → 照舊；正在上班那段在別家店 → 照舊。只在本店 → 走同店寬限（跨夜、班表快取、grace_hm）。
 * 手算：S1 同店兩位同名（E01、E02 都 08:55 上班、都排 09–18）→ 兩人都還是「只在一家」→ 19:05 開頁都 grace 19:00、掃描不寫；E01 按下班只寫 E01 的 19:00，E02 不受影響。
 *       S2 別家店有同名但停用 → 只在一家 → grace。S3 別家店同名（名字中間有空白）在職 → 多店 → 照舊 19:00 代記。
 *       S4 別家店名冊是空的（讀取成功、0 位在職）→ 那家店沒人 → grace（2026-11-23 大腦更正）。S5 別家店名冊讀取丟例外 → 照舊。S6 別家店沒有 roster 分頁 → 照舊。
 *       S7 名冊快取：第一次判斷每家別家店讀 1 次，10 分鐘內 0 次，過了再讀。S8 沒晚超過 30 分（09–19 班）→ 不讀任何別家店名冊。 */
console.log('\n════ 十三、方案甲：只在一家名冊才給寬限 ════');
const ME2 = { emp_id: 'E02', name: '測試一', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
/** 本店＝光復（gf）＋別家店 peers（{SS_P: {roster:[…]}}）；班表 sched 放本店 sched_pub（rows 依 opt.rows） */
function worldS(now, opt) {
  const m = make({ now: T(now), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: opt.cap || '2' },
    self: { roster: opt.roster || [ME], events: (opt.events || [['08:55:00', 'E01', 'in']]).map((e) => [D + 'T' + e[0], e[1], e[2]]) }, peers: opt.peers || {} });
  m.run(CAP_SRC);
  m.sb.REST_PEERS_ = Object.keys(opt.peers || {}).map((id, i) => ({ code: 'p' + i, ss: id })).concat([{ code: 'gf', ss: 'SELF' }]);
  const sh = m.self.insertSheet('sched_pub');
  sh.appendRow(SP_HEAD);
  const shifts = [{ id: 'A', name: '班', start: '09:00', end: opt.end || '18:00' }];
  sh.appendRow(['', 'T01', 1, JSON.stringify({ start: '2026-11-01', shifts, rows: (opt.emps || ['E01']).map((id) => ({ emp_id: id, name: '測試一',
    cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) })) }), 'op', '']);
  return m;
}
const OTHER = { emp_id: 'P01', name: '別人', key: 'KP', device_id: 'DP', active: 'TRUE' };
const st2 = (m, tok) => { const c = m.sb.handleLiffStatus_({ id_token: tok || 'TOK_U1' }).cap; return c.locked ? 'LOCK' + c.sys_hm : c.grace_hm ? 'grace' + c.grace_hm : 'free'; };
{
  const m = worldS(D + 'T19:05:00', { roster: [ME, ME2], emps: ['E01', 'E02'], events: [['08:55:00', 'E01', 'in'], ['08:55:00', 'E02', 'in']], peers: { SS_P: { roster: [OTHER] } } });
  const a = [st2(m, 'TOK_U1'), st2(m, 'TOK_U2')];
  m.sb.capSweep();
  const swept = sysHm(m);
  m.setNow(D + 'T19:30:00');
  const r = punch(m, 'out');
  const sysIds = m.self.sh.events.values.filter((x) => x.indexOf('system_cap') >= 0).map((x) => String(x[0]).slice(11, 16) + ' ' + x[1]);
  check('S1★', '同店兩位同名（E01、E02）：兩人都還是只在一家 → 開頁都 grace 19:00、掃描不寫；E01 按下班只寫 E01 19:00、E02 照樣 grace',
    [a, swept, r.status, sysIds, st2(m, 'TOK_U2')], [['grace19:00', 'grace19:00'], [], 'cap_locked', ['19:00 E01'], 'grace19:00']);
}
const SCASE = [
  ['S2★', '別家店有同名但停用 → 只在一家 → grace', { peers: { SS_P: { roster: [OTHER, { emp_id: 'P02', name: '測試一', key: 'KQ', device_id: 'DQ', active: 'FALSE' }] } } }, 'grace19:00'],
  ['S3', '別家店同名（名字中間有空白）在職 → 多店 → 照舊 19:00 代記', { peers: { SS_P: { roster: [OTHER, { emp_id: 'P02', name: '測試 一', key: 'KQ', device_id: 'DQ', active: 'TRUE' }] } } }, 'LOCK19:00'],
  ['S3b', '別家店同名、active 寫 true（小寫）→ 也算在職（同打卡端條件）→ 照舊', { peers: { SS_P: { roster: [OTHER, { emp_id: 'P02', name: '測試一', key: 'KQ', device_id: 'DQ', active: 'true' }] } } }, 'LOCK19:00'],
  ['S4★', '別家店名冊是空的（只有表頭；讀取成功、那家店沒人）→ 不影響 → grace', { peers: { SS_P: { roster: [] } } }, 'grace19:00'],
  ['S4b★', '別家店名冊只有停用的人（0 位在職＝那家店沒人）→ grace', { peers: { SS_P: { roster: [Object.assign({}, OTHER, { active: 'FALSE' })] } } }, 'grace19:00'],
  ['S2b', '三家店（另兩家都有人、都沒有這個姓名）→ 只在一家 → grace', { peers: { SS_P: { roster: [OTHER] }, SS_Q: { roster: [Object.assign({}, OTHER, { emp_id: 'Q01' })] } } }, 'grace19:00'],
  ['S3c', '三家店、第二家有同名在職 → 照舊', { peers: { SS_P: { roster: [OTHER] }, SS_Q: { roster: [{ emp_id: 'Q02', name: '測試一', key: 'KQ', device_id: 'DQ', active: 'TRUE' }] } } }, 'LOCK19:00'],
];
SCASE.forEach(([id, label, opt, want]) => { const m = worldS(D + 'T19:05:00', opt); check(id, label, st2(m), want); });
{
  const m = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER] } } });
  m.peers.SS_P.sh.roster.getDataRange = () => { throw new Error('讀取失敗'); };
  check('S5', '別家店名冊讀取丟例外 → 照舊 19:00 代記', st2(m), 'LOCK19:00');
  const m2 = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER] } } });
  delete m2.peers.SS_P.sh.roster;
  check('S6', '別家店沒有 roster 分頁 → 照舊', st2(m2), 'LOCK19:00');
  const m3 = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER] } } });
  m3.sb.REST_PEERS_.push({ code: 'zz', ss: 'SS_NOPE' });
  check('S6b', 'REST_PEERS_ 有一家打不開（沒權限）→ 照舊', st2(m3), 'LOCK19:00');
}
{
  const m = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER] }, SS_Q: { roster: [Object.assign({}, OTHER, { emp_id: 'Q01' })] } } });
  const cnt = { SS_P: 0, SS_Q: 0 };
  ['SS_P', 'SS_Q'].forEach((id) => { const sh = m.peers[id].sh.roster, g = sh.getDataRange; sh.getDataRange = function () { cnt[id]++; return g.apply(this, arguments); }; });
  const reads = () => cnt.SS_P + cnt.SS_Q;
  m.sb.capGraceSingle_(ME); const r1 = reads();
  m.sb.capGraceSingle_(ME); const r2 = reads() - r1;
  m.setNow(D + 'T19:16:00'); m.sb.capGraceSingle_(ME); const r3 = reads() - r1 - r2;
  check('S7', '別家店名冊快取 10 分鐘：第一次每家讀 1 次（共 2）、馬上再判 0 次、11 分鐘後再讀 2 次', [r1, r2, r3], [2, 0, 2]);
  const m2 = worldS(D + 'T19:05:00', { end: '19:00', peers: { SS_P: { roster: [OTHER] } } });
  let n2 = 0; const sh2 = m2.peers.SS_P.sh.roster, g2 = sh2.getDataRange; sh2.getDataRange = function () { n2++; return g2.apply(this, arguments); };
  m2.sb.capSweep(); const s = st2(m2);
  // restPeerEvents_ 本來就會讀別家店名冊（rpr: 快取 6 小時）——這裡只數寬限多讀的：先把 rpr: 快取放好
  check('S8', '沒晚超過 30 分（09–19 班、滿 10＝19:00）→ 照舊代記，寬限不讀別家店名冊（只剩 restPeerEvents_ 原本那 1 次）', [s, n2], ['LOCK19:00', 1]);
  const m3 = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER] } } });
  check('S9', '名字空白（掃描時名冊找不到這個工號）→ 照舊', m3.sb.capGraceSingle_({ emp_id: 'E01', name: '' }), false);
}

/* 多店名冊者：兩家店各跑自己的程式（新版）與 38d0340，逐步比對。新版的開關 '2' 對應 38d0340 的 '1'（38d0340 把 '2' 當成關）。
 * A＝光復（E01 測試一），B＝mzt（B07 測試一，名冊另有 opt.bExtra）。每一步：回應、兩店 events 都要一樣。 */
function worldM(view, opt, src, cap) {
  const aSpec = { roster: [ME], events: opt.aEvents || [] }, bSpec = { roster: [B07R].concat(opt.bExtra || []), events: opt.bEvents || [] };
  const m = make({ now: T(D + 'T19:00:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: cap }, self: view === 'A' ? aSpec : bSpec, peers: view === 'A' ? { SS_B: bSpec } : { SS_A: aSpec } });
  m.run(src);
  m.sb.REST_PEERS_ = view === 'A' ? [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }] : [{ code: 'mzt', ss: 'SELF' }, { code: 'gf', ss: 'SS_A' }];
  const sh = (view === 'A' ? m.self : m.peers.SS_A).insertSheet('sched_pub');
  sh.appendRow(SP_HEAD);
  (opt.sched || []).forEach((x) => sh.appendRow([x[0], 'T01', 1, JSON.stringify(x[1]), 'op', '']));
  return m;
}
const OLDSRC = require('child_process').execFileSync('git', ['-C', require('path').join(__dirname, '..'), 'show', '38d0340:apps-script/Cap10.gs'], { encoding: 'utf8' });
const mapOld = (c) => (c === '2' ? '1' : c);
function pairM(opt, src, capA, capB) { return { A: worldM('A', opt, src, capA), B: worldM('B', opt, src, capB) }; }
function syncM(W, from) {
  if (from === 'A') { cpRows(W.B.peers.SS_A.sh.events.values, W.A.self.sh.events.values); cpRows(W.B.self.sh.events.values, W.A.peers.SS_B.sh.events.values); }
  else { cpRows(W.A.self.sh.events.values, W.B.peers.SS_A.sh.events.values); cpRows(W.A.peers.SS_B.sh.events.values, W.B.self.sh.events.values); }
}
const OPSM = ['A_status', 'A_sweep', 'A_in_line', 'A_out_line', 'A_in_lclock', 'A_out_lclock', 'A_in_old', 'A_out_old', 'B_status', 'B_sweep', 'B_in_line', 'B_out_line'];
function opM(W, op) {
  const m = op[0] === 'A' ? W.A : W.B, sb = m.sb, ty = /_in_/.test(op) ? 'in' : 'out';
  const tok = 'TOK_U1';
  let r;
  if (op.endsWith('status')) r = sb.handleLiffStatus_({ id_token: tok });
  else if (op.endsWith('sweep')) { sb.capSweep(); r = null; }
  else if (op.endsWith('_line')) r = sb.handleLiffPunch_(Object.assign({ id_token: tok, type: ty, confirm_same: true }, HERE));
  else if (op.endsWith('_lclock')) r = sb.handleLiffClockGuarded_(Object.assign({ id_token: tok, type: ty }, HERE));
  else r = JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: op[0] === 'A' ? 'K1' : 'KB', type: ty, device_id: op[0] === 'A' ? 'D1' : 'DB' }, HERE)) } }).text);
  syncM(W, op[0]);
  return JSON.stringify(r);
}
/** 新版（capA, capB）與 38d0340（對應開關）跑同一串動作；回第一個不一樣的步驟或 null */
function cmpM(opt, capA, capB, steps) {
  const N = pairM(opt, CAP_SRC, capA, capB), O = pairM(opt, OLDSRC, mapOld(capA), mapOld(capB));
  for (let i = 0; i < steps.length; i++) {
    const [t, op] = steps[i];
    [N.A, N.B, O.A, O.B].forEach((m) => m.setNow(t));
    const rn = opM(N, op), ro = opM(O, op);
    const en = JSON.stringify([N.A.self.sh.events.values, N.B.self.sh.events.values]), eo = JSON.stringify([O.A.self.sh.events.values, O.B.self.sh.events.values]);
    if (rn !== ro || en !== eo) return { i, op, t: iso(t).slice(11, 16), rn: rn.slice(0, 200), ro: ro.slice(0, 200) };
  }
  return null;
}
const schB = (emp, end) => ['mzt', schedFor(emp, [{ id: 'A', name: '班', start: '09:00', end: end }], { t: 'W', s: 'A' })];
const schA = (end) => ['', schedFor('E01', [{ id: 'A', name: '班', start: '09:00', end: end }], { t: 'W', s: 'A' })];
const tt = (hm) => T(D + 'T' + hm + ':00');
{
  // 審查第二輪三條的重現：多店者 → 跟 38d0340 一樣
  const r1 = cmpM({ bEvents: [[D + 'T09:00:00', 'B07', 'in']], sched: [schB('B07', '18:00')] }, '2', '2',
    [[tt('19:30'), 'A_in_line'], [tt('20:30'), 'B_sweep'], [tt('20:31'), 'A_status'], [tt('22:30'), 'B_sweep'], [tt('22:30'), 'A_sweep'], [tt('22:31'), 'A_status'], [tt('22:31'), 'B_status'], [tt('22:32'), 'A_out_line']]);
  check('R1', '審查第二輪第 1 條（B 09–18、09:00 在 B 上班、19:30 到 A 按上班…22:30 在 A 按下班）：多店者每一步都跟 38d0340 一樣', r1, null);
  const r2a = cmpM({ bEvents: [[D + 'T09:00:00', 'B07', 'in']], sched: [schB('B07', '18:00')] }, '1', '2',
    [[tt('19:00'), 'A_status'], [tt('19:00'), 'B_status'], [tt('19:05'), 'B_sweep'], [tt('20:00'), 'A_status'], [tt('20:00'), 'B_status'], [tt('20:10'), 'A_out_line']]);
  const r2b = cmpM({ bEvents: [[D + 'T09:00:00', 'B07', 'in']], sched: [schB('B07', '18:00')] }, '2', '1',
    [[tt('19:00'), 'A_status'], [tt('19:00'), 'B_status'], [tt('19:10'), 'A_out_line'], [tt('19:15'), 'B_sweep'], [tt('19:20'), 'B_status']]);
  check('R2', "審查第二輪第 2 條（逐店開啟：A '1'／B '2' 與反過來）：多店者兩種組合每一步都跟 38d0340 一樣", [r2a, r2b], [null, null]);
  const B08S = { emp_id: 'B08', name: '測試一', key: 'KB8', device_id: 'DB8', active: 'TRUE' };
  const sched3 = ['mzt', { start: '2026-11-01', shifts: [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'C', name: '晚', start: '10:00', end: '20:00' }],
    rows: [['B07', 'A'], ['B08', 'C']].map(([id, sid]) => ({ emp_id: id, name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: sid } : { t: 'R' })) })) }];
  const r3 = cmpM({ bExtra: [B08S], bEvents: [[D + 'T09:00:00', 'B07', 'in'], [D + 'T08:45:00', 'B08', 'in']], sched: [sched3] }, '2', '2',
    [[tt('19:10'), 'A_status'], [tt('19:10'), 'A_out_line'], [tt('19:15'), 'B_sweep'], [tt('19:16'), 'B_status']]);
  check('R3', '審查第二輪第 3 條（同名 B07／B08、上班差 15 分、B07 在 A 按下班）：多店者每一步都跟 38d0340 一樣（A 不再寫卡、B 照舊）', r3, null);
}
{
  // 多店者隨機：段在 B／段在 A／兩邊都有、班表會晚／不會晚／沒發布、四種開關組合 × 隨機動作
  let seedM = 20261123;
  const rndM = () => { seedM = (seedM * 1103515245 + 12345) % 2147483648; return seedM / 2147483648; };
  const pk = (xs) => xs[Math.floor(rndM() * xs.length)];
  let same = 0; const bad = [];
  for (let k = 0; k < 160; k++) {
    const where = pk(['B', 'A', 'both']);
    const opt = {
      aEvents: where === 'A' ? [[D + 'T08:55:00', 'E01', 'in']] : where === 'both' ? [[D + 'T07:00:00', 'E01', 'in'], [D + 'T09:00:00', 'E01', 'out']] : [],
      bEvents: where === 'A' ? [] : [[D + 'T' + pk(['09:00', '10:00', '11:30']) + ':00', 'B07', 'in']],
      sched: [pk([schB('B07', '18:00'), schB('B07', '21:00'), null]), pk([schA('18:00'), schA('21:00'), null])].filter(Boolean),
    };
    const caps = pk([['2', '2'], ['1', '2'], ['2', '1'], ['1', '1'], ['2', undefined]]);
    let t = tt('18:5' + Math.floor(rndM() * 9)); const steps = [];
    for (let i = 0, n = 2 + Math.floor(rndM() * 5); i < n; i++) { steps.push([t, pk(OPSM)]); t += (1 + Math.floor(rndM() * 50)) * 60000; }
    const r = cmpM(opt, caps[0], caps[1], steps);
    if (r) bad.push([k, where, caps, r]); else same++;
  }
  check('R4', '多店名冊者隨機 160 串（段在 B／A／兩店都有、班表會晚／不會晚／沒發布、A／B 開關四種組合、12 種動作）：每一步回應與兩店 events 都跟 38d0340 一樣', [same, bad.slice(0, 2)], [160, []]);
}
{
  // 單店者在兩店世界：只在 A 名冊（B 名冊只有別人）→ A 開關 '2' 照寬限；B 的開關不影響
  const optS = { aEvents: [[D + 'T08:55:00', 'E01', 'in']], sched: [schA('18:00')] };
  const mk = (capA, capB) => {
    const aSpec = { roster: [ME], events: optS.aEvents }, bSpec = { roster: [Object.assign({}, OTHER, { emp_id: 'B09' })], events: [] };
    const m = make({ now: T(D + 'T19:05:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: capA }, self: aSpec, peers: { SS_B: bSpec } });
    m.run(CAP_SRC);
    m.sb.REST_PEERS_ = [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }];
    const sh = m.self.insertSheet('sched_pub'); sh.appendRow(SP_HEAD); sh.appendRow(['', 'T01', 1, JSON.stringify(schA('18:00')[1]), 'op', '']);
    return m;
  };
  check('R5', "單店者（只在 A 名冊）：A '2' → grace 19:00；A '1' → 照舊鎖（B 店開關不相干）", [st2(mk('2', '1')), st2(mk('1', '2'))], ['grace19:00', 'LOCK19:00']);
}
{
  /* 九家店世界（REST_PEERS_ 九家、門檻用原值 9）：2026-11-23 大腦更正——別家店名冊讀取成功但 0 位在職＝那家店沒人（瑞光、文心目前就是），不影響寬限；
   * 讀取失敗（打不開、沒有 roster 分頁、丟例外）＝判不了＝照舊；失敗不快取。 */
  const nine = (mod) => {
    const peers = {};
    for (let i = 1; i <= 8; i++) peers['SS_' + i] = { roster: i === 7 || i === 8 ? [] : [Object.assign({}, OTHER, { emp_id: 'P' + i })] };   // 第 7、8 家空名冊
    const m = make({ now: T(D + 'T19:05:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: '2' }, self: { roster: [ME], events: [[D + 'T08:55:00', 'E01', 'in']] }, peers });
    m.run(CAP_SRC_REAL);
    m.sb.REST_PEERS_ = Object.keys(peers).map((id, i) => ({ code: 'p' + i, ss: id })).concat([{ code: 'gf', ss: 'SELF' }]);
    const sh = m.self.insertSheet('sched_pub'); sh.appendRow(SP_HEAD); sh.appendRow(['', 'T01', 1, JSON.stringify(schedFor('E01', [{ id: 'A', name: '班', start: '09:00', end: '18:00' }], { t: 'W', s: 'A' })), 'op', '']);
    if (mod) mod(m);
    return m;
  };
  const boom = (m, id) => { m.peers[id].sh.roster.getDataRange = () => { throw new Error('讀取失敗'); }; };
  check('S11★', '九家店、兩家空名冊、其餘正常、沒有同名 → 只在一家 → grace 19:00', st2(nine()), 'grace19:00');
  check('S12', '九家店、一家讀取丟例外 → 照舊', st2(nine((m) => boom(m, 'SS_3'))), 'LOCK19:00');
  check('S12b', '九家店、一家沒有 roster 分頁 → 照舊', st2(nine((m) => { delete m.peers.SS_4.sh.roster; })), 'LOCK19:00');
  check('S12c', '九家店、空名冊＋另一家丟例外 → 照舊', st2(nine((m) => boom(m, 'SS_8'))), 'LOCK19:00');
  check('S12d', '九家店、自己這家店的名冊讀取丟例外（開頁本身用快取以外的路徑）→ 寬限判斷照舊', nine((m) => {
    const sh = m.self.sh.roster, g = sh.getDataRange; let n = 0;
    sh.getDataRange = function () { n++; if (m.__boomSelf) throw new Error('讀取失敗'); return g.apply(this, arguments); };
    m.__boomSelf = true;
  }).sb.capGraceSingle_(ME), false);
  check('S12e', '九家店、另一家有同名在職 → 照舊', st2(nine((m) => { m.peers.SS_2.sh.roster.values.push(['P22', '測試一', 'k', 'd', '', 'TRUE']); })), 'LOCK19:00');
  check('S10', 'REST_PEERS_ 只有 8 家（少列一家）→ 清單不齊 → 照舊', st2(nine((m) => { m.sb.REST_PEERS_ = m.sb.REST_PEERS_.filter((p) => p.ss !== 'SS_5'); })), 'LOCK19:00');
  check('S10b', 'REST_PEERS_ 同一家列兩次（湊成 10 列但只有 9 家）→ 照算 9 家 → grace', st2(nine((m) => { m.sb.REST_PEERS_.push({ code: 'dup', ss: 'SS_1' }); })), 'grace19:00');
  check('S10c', 'REST_PEERS_ 沒有本店（文心現在的清單就是少列自己）→ 照舊', st2(nine((m) => { m.sb.REST_PEERS_ = m.sb.REST_PEERS_.filter((p) => p.ss !== 'SELF').concat([{ code: 'x9', ss: 'SS_9' }]); m.peers.SS_9 = m.peers.SS_1; })), 'LOCK19:00');
  {
    const m = nine((mm) => boom(mm, 'SS_3'));
    const r1 = m.sb.capGraceSingle_(ME);
    m.peers.SS_3.sh.roster.getDataRange = function () { return { getValues: () => m.peers.SS_3.sh.roster.values.map((r) => r.slice()) }; };
    const r2 = m.sb.capGraceSingle_(ME);
    check('S13', '讀取失敗不快取：第一次失敗 → 照舊；那家店恢復後下一次就重讀、判單店（不用等 10 分鐘）', [r1, r2], [false, true]);
  }
}
{
  /* S14（#232 驗收第 1 點）：名冊快取內容不對就重讀。別家店 SS_P 其實有同名在職（多店）→ 正確答案是照舊。
   * 暖快取後把 cgs: 那一鍵改壞（[]、[{a:1}]、舊格式字串陣列、n 不符、店別不符、元素空字串、版本不對）→ 一律重讀 → 仍判多店、照舊；
   * 真的 0 人（{n:0, names:[]}）是合法快取。 */
  const twinPeer = { SS_P: { roster: [OTHER, { emp_id: 'P02', name: '測試一', key: 'KQ', device_id: 'DQ', active: 'TRUE' }] } };
  const keyP = 'cgs:' + 'SS_P'.slice(-12);
  const bad = [
    ['空陣列 []', '[]'], ['元素不是字串 [{"a":1}]', '[{"a":1}]'], ['舊格式字串陣列', '["別人"]'],
    ['n 跟 names 不符', JSON.stringify({ v: 1, store: 'SS_P', n: 2, names: ['別人'] })],
    ['店別不符', JSON.stringify({ v: 1, store: 'SS_X', n: 1, names: ['別人'] })],
    ['元素是空字串', JSON.stringify({ v: 1, store: 'SS_P', n: 1, names: [''] })],
    ['版本不對', JSON.stringify({ v: 2, store: 'SS_P', n: 1, names: ['別人'] })],
    ['合法格式但被改成 0 人', JSON.stringify({ v: 1, store: 'SS_P', n: 0, names: [] })],
  ];
  const got = bad.map(([label, val]) => {
    const m = worldS(D + 'T19:05:00', { peers: twinPeer });
    let reads = 0; const sh = m.peers.SS_P.sh.roster, g = sh.getDataRange; sh.getDataRange = function () { reads++; return g.apply(this, arguments); };
    m.sb.capGraceSingle_(ME);
    const r0 = reads;
    m.cache[keyP] = { v: val, exp: Infinity };
    const single = m.sb.capGraceSingle_(ME);
    return label + ':' + (reads - r0) + ':' + single;
  });
  // 最後一種「合法格式、0 人」本身是合法快取（瑞光、文心真的 0 人時就是這個值），所以不重讀——被人改成這樣不在防範範圍（跟 #231 驗收判為不擋的「格式合法的竄改」同類）
  check('S14★', '名冊快取內容不對（7 種）→ 重讀 1 次、仍判多店（false）；合法格式的 0 人不重讀',
    got, bad.map(([label], i) => label + ':' + (i < 7 ? 1 : 0) + ':' + (i < 7 ? false : true)));
  const m = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [] } } });
  m.sb.capGraceSingle_(ME);
  check('S14b', '真的 0 人的店：快取存 {v:1, store, n:0, names:[]}，下一次不重讀', JSON.parse(m.cache[keyP].v), { v: 1, store: 'SS_P', n: 0, names: [] });
  const m2 = worldS(D + 'T19:05:00', { peers: { SS_P: { roster: [OTHER, { emp_id: 'P03', name: '', key: 'KZ', device_id: 'DZ', active: 'TRUE' }] } } });
  m2.sb.capGraceSingle_(ME);
  check('S14c', '名冊有一列名字空白：不放進清單（快取元素都是非空字串）', JSON.parse(m2.cache[keyP].v).names, ['別人']);
}

done();
