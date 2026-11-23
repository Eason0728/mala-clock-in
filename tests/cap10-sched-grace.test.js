/* 滿 10 小時收卡：班表寬限（2026-11-24 主管定案「做系統主動代記」「可以，照算忘刷」；Cap10.gs capSchedEnd_／capGraceLate_／capCheck_ mode）
 *
 * 規則白話版：
 *   1. 開關：指令碼屬性 REST_CAP_ON 恰為 '2'＝收卡開著＋這條規則；'1'＝跟改版前一樣；其他值＝收卡關著（跟改版前一樣）。
 *   2. 只管「系統主動代記」：定時掃描、開打卡頁時，如果「滿 10 小時那一刻（第一個滿 10 的 15 分刻度）」比當天班表最後一段下班
 *      晚「超過」30 分鐘 → 不寫系統卡、不鎖（當成忘刷下班）。剛好 30 分照舊代記。
 *   3. 本人按下班：照舊——系統卡寫在滿 10 那一刻、回 cap_locked。
 *   4. 本人按上班、前一段開著已滿 10、又符合第 2 點 → 不寫、放行；不符合照舊（寫卡、擋）。舊連結、liff_clock 同一支。
 *   5. 班表：本店、同一個工號、那段上班卡那天；只認上班格 W；分段取最後一段；跨午夜照實際結束。讀不到／沒排／例假／休息日／請假／
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
  m.sb.capSchedPub_ = () => { throw new Error('讀取失敗'); };
  check('G50', '讀班表丟錯 → 照舊代記', autoAt(m, D + 'T19:10:00'), [['11-20 19:00'], true, null]);
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

done();
