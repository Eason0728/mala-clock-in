/* 滿 10 小時「打卡前後 15 分鐘緩衝」（2026-11-23 主管定 A；設計 ~/加盟名單平台/_brain_out/cap10-newdef/buffer15.md）
 *
 * 規則白話版：
 *   1. 每張卡先捨秒；上班卡往後進位、下班卡往前捨去到 :00／:15／:30／:45，再相減（取整後 ≤ 0＝0）。跟核定頁「參考 X 小時」同一支（Code.gs approvedHoursOfShift）。
 *   2. 正在上班那段，「下班」用現在往前捨去。
 *   3. 央廚、總部：取整後的區間再扣跟固定休息重疊的部分；其他門市不扣班表休息。
 *   4. 加上已核准、有時段的請假／出差（時段照單上，不取整）；跟打卡重疊用「取整後真正算進去的區間」扣，沒算進去的零頭不拿來扣假。
 *   5. 合計（含剛好 10）≥ 10 小時 → 收卡；系統卡寫在第一個滿 10 的 15 分刻度上。不需要班表。
 *   6. 「你今天已經上班 X 小時」的 X＝取整後打卡時數，小數兩位。
 *
 * 手算對照（★＝改動前 da9d510 會紅）：
 *   G1★ 真實案例 08:56:17–14:32:46、17:25:58 上班：09:00–14:30＝5.5；17:30 起還差 4.5 → 22:00:00（原始秒數 21:49:29）。21:49:29 下班＝9.75、不收。
 *   G2★ 兩段 09:07–13:52、16:38 上班：09:15–13:45＝4.5；16:45 起還差 5.5 → 22:15（原始 21:53）。
 *   G3★ 三段 07:58–11:02、12:14–15:46、17:01 上班：3＋3.5；17:15 起還差 3.5 → 20:45（原始 20:43）。
 *   G4★ 跨夜 15:08 上班：15:15 起 10 小時 → 隔天 01:15（原始 01:08）。
 *   G5  刻度上 09:00:00 上班 → 19:00:00；09:00:59 上班（捨秒）→ 19:00；09:15:00 → 19:15。
 *   G7★ 有時段假夾中間：08:52–12:07（09:00–12:00＝3）＋假 12:00–14:00（2）＋13:50 上班（14:00 起）→ 19:00（原始 18:43:…）。
 *   G8★ 央廚休息 12–13：07:46 上班 → 08:00 起、扣 1 小時 → 19:00（原始 18:46）；12:40 上班（12:45，扣 12:45–13:00）→ 23:00。
 *   G9★ 顯示：08:56:17–14:32:46（5.5）＋15:00–19:46（4.75）＝10.25 → 「已經上班 10.25 小時」（原本顯示原始 10.4）。 */
'use strict';
const vm = require('vm');
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-20', D2 = '2026-11-21';
const HERE = { lat: 24.7840945, lng: 121.0157448, accuracy: 10 };
const CF = { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' };
const HQ = { NO_PUNCH_BREAK_START: '14:00', NO_PUNCH_BREAK_END: '15:00' };
const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at'];
const EARLY = '2026-11-19T20:00:00+08:00';

function world(now, events, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props: Object.assign({ REQ_BIND_FROM: 'off', REST_CAP_ON: '1' }, opt.props || {}),
    self: { roster: [ME], events: events || [] }, peers: opt.peers, config: opt.config });
  m.run(R('apps-script/Cap10.gs'));
  if (opt.live) Object.keys(opt.live).forEach((k) => { m.sb[k] = opt.live[k]; });
  if (opt.reqs) {
    const sh = m.self.insertSheet('requests');
    sh.appendRow(RQH);
    opt.reqs.forEach((r) => sh.appendRow(['r' + sh.values.length, '', 'E01', '', r[0], r[1], r[0] === 'trip' ? '出差' : '特休假', r[2], r[3], r[4], '', '', '', 'approved', r[5] === undefined ? EARLY : r[5]]));
  }
  return m;
}
const ev = (hms, type, d) => [(d || D) + 'T' + hms, 'E01', type];
const punch = (m, type) => m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: type, confirm_same: true }, HERE));
const status = (m) => m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
const sysRows = (m) => m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0);
const sysAt = (m, t) => { m.setNow(t); return status(m).cap.sys_hm || null; };
const lockedAt = (m, t) => { m.setNow(t); return !!status(m).cap.locked; };
const refHours = (m, date) => {
  const day = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_day', mgr_key: 'MK', date: date || D }) } }).text);
  const e = (day.employees || []).filter((p) => p.emp_id === 'E01')[0] || {};
  return e.reference;
};
const REAL = [ev('08:56:17', 'in'), ev('14:32:46', 'out'), ev('17:25:58', 'in')];

console.log('════ 取整共用核定參考時數那一支（釘住：Cap10 ＝ Code.gs approvedHoursOfShift ＝ Requests.gs reqGridMs_ ＝ 試算 buffer-sim up15/dn15）════');
{
  const m = world(D + 'T09:00:00', []);
  const MIN = 60000, Q = 15 * MIN;
  const up15 = (ms) => Math.ceil(Math.floor(ms / MIN) / 15) * Q, dn15 = (ms) => Math.floor(Math.floor(ms / MIN) / 15) * Q;   // 同 gen/buffer-sim.js
  let seed = 20261123; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const base = T(D + 'T00:00:00');
  const edge = [0, 1000, 59000, 60000, 14 * MIN, 14 * MIN + 59000, Q, Q + 1000, 15 * Q - 1, 4 * Q];
  let bad = [], n = 0;
  for (let i = 0; i < 4000; i++) {
    const a = base + Math.floor(rnd() * 30 * 3600) * 1000 + (i < 100 ? edge[i % edge.length] : 0);
    const b = a + Math.floor(rnd() * 14 * 3600) * 1000 + edge[i % edge.length];
    const iso = (x) => new Date(x).toISOString();
    const v1 = m.sb.capGridMs_(a, b), v2 = Math.round(m.sb.approvedHoursOfShift(iso(a), iso(b)) * 3600000), v3 = m.sb.reqGridMs_(a, b), v4 = Math.max(0, dn15(b) - up15(a));
    const gi = m.sb.capGridIn_(a), go = m.sb.capGridOut_(b);
    n++;
    if (v1 !== v2 || v1 !== v3 || v1 !== v4 || gi !== up15(a) || go !== dn15(b)) bad.push([iso(a), iso(b), v1, v2, v3, v4]);
  }
  check('K1', '4000 組（含捨秒、剛好刻度、差 1 秒）：四邊結果一樣、取整後的上班／下班時刻也一樣', [n, bad.slice(0, 3)], [4000, []]);
  check('K2', 'approvedHoursOfShift 註解的例子 11:02–14:31＋17:05–21:44＝7.5', (m.sb.capGridMs_(T(D + 'T11:02:00'), T(D + 'T14:31:00')) + m.sb.capGridMs_(T(D + 'T17:05:00'), T(D + 'T21:44:00'))) / 3600000, 7.5);
  check('K3', '取整後 ≤ 0 算 0：09:01–09:14', m.sb.capGridMs_(T(D + 'T09:01:00'), T(D + 'T09:14:59')), 0);
  const save = m.sb.approvedHoursOfShift; m.sb.approvedHoursOfShift = undefined;
  let threw = false; try { m.sb.capGridMs_(1, 2); } catch (e) { threw = true; }
  m.sb.approvedHoursOfShift = save;
  check('K4', '沒有 approvedHoursOfShift（不該發生）→ 丟錯（capCheck_ 接住＝不擋不寫），不會偷偷改用別的算法', threw, true);
}

console.log('\n════ 真實案例（buffer15.md：支援帳號 11/20）════');
{
  const m = world(D + 'T21:49:29', REAL);
  check('G1★', '21:49:29（原始秒數剛好 10:00:00）還沒收', status(m).cap.locked, false);
  check('G1b★', '21:59:59 仍沒收（取整 9.75）', lockedAt(m, D + 'T21:59:59'), false);
  check('G1c★', '22:00:00 收、系統卡 22:00', sysAt(m, D + 'T22:00:00'), '22:00');
  check('G1d', '只有一張系統卡', sysRows(m).length, 1);
  check('G1e', '核定參考時數 5.5＋4.5＝10', refHours(m), 10);
}
{
  const m = world(D + 'T21:49:29', REAL);
  check('G1f★', '21:49:29 按下班 → 照收（不被收卡）', punch(m, 'out').ok, true);
  check('G1g', '沒有系統卡；核定參考時數 9.75', [sysRows(m).length, refHours(m)], [0, 9.75]);
  m.setNow(T(D + 'T22:30:00'));
  check('G1h', '下班後不鎖、也不擋（9.75 沒滿）', [status(m).cap.locked, status(m).cap.in_block], [false, false]);
}

console.log('\n════ 已知行為：22:00–22:14 按下班 → 寫 22:00 系統卡、本人那張下班卡不收（主管已知）════');
{
  const m = world(D + 'T22:07:00', REAL);
  const r = punch(m, 'out');
  check('W15a', '22:07 按下班：被擋（cap_locked），原因寫系統 22:00 記了下班卡', [r.ok, r.status, r.reason], [false, 'cap_locked', '今天出勤（含已核准請假、出差）已滿 10 小時，系統在 22:00 幫你記了下班卡']);
  check('W15b', '只有一張卡：系統卡 22:00（沒有 22:07 的本人下班卡）', [sysRows(m).length, m.self.sh.events.values.filter((x) => x[2] === 'out').length], [1, 2]);
  check('W15c', '核定參考時數仍是 10（不是 10.0x，也沒有多一段）', refHours(m), 10);
  m.setNow(T(D + 'T22:14:59'));
  check('W15d', '再按一次（22:14:59）也只擋、不多寫', [punch(m, 'out').status, sysRows(m).length], ['cap_locked', 1]);
  m.setNow(T(D + 'T22:16:00'));
  m.sb.capSweep();
  const w = m.sb.capWrite_(m.self, 'E01', T(D + 'T22:00:00'), T(D + 'T17:25:58'));
  check('W15e', '觸發器再跑、另一邊（mini）再寫一次：都照那張 22:00、不寫第二張', [sysRows(m).length, w && w.sys], [1, T(D + 'T22:00:00')]);
}
{
  const m = world(D + 'T21:59:59', REAL);
  check('W15f', '21:59:59 按下班 → 照收（本人卡），沒有系統卡', [punch(m, 'out').ok, sysRows(m).length], [true, 0]);
}

console.log('\n════ 兩段、三段、跨夜、剛好在刻度、只打上班卡 ════');
{
  const m = world(D + 'T22:14:00', [ev('09:07:00', 'in'), ev('13:52:00', 'out'), ev('16:38:00', 'in')]);
  check('G2★', '兩段 09:07–13:52、16:38 上班：22:14 還沒（原始 21:53 就會收）', status(m).cap.locked, false);
  check('G2b', '22:15 收', sysAt(m, D + 'T22:15:00'), '22:15');
}
{
  const m = world(D + 'T20:44:00', [ev('07:58:00', 'in'), ev('11:02:00', 'out'), ev('12:14:00', 'in'), ev('15:46:00', 'out'), ev('17:01:00', 'in')]);
  check('G3★', '三段 3＋3.5、17:01 上班：20:44 還沒', status(m).cap.locked, false);
  check('G3b', '20:45 收', sysAt(m, D + 'T20:45:00'), '20:45');
}
{
  const m = world(D2 + 'T01:14:00', [ev('15:08:00', 'in')]);
  check('G4★', '跨夜 15:08 上班：隔天 01:14 還沒（原始 01:08 會收）', status(m).cap.locked, false);
  m.setNow(T(D2 + 'T01:20:00'));
  const s = status(m).cap;
  check('G4b', '01:20 開頁 → 系統卡記 01:15（跨夜，歸上班那天）', [s.locked, s.sys_hm, sysRows(m).length, sysRows(m)[0][0]], [true, '01:15', 1, '2026-11-21T01:15:00+08:00']);
}
{
  const m = world(D + 'T18:59:59', [ev('09:00:00', 'in')]);
  check('G5', '09:00:00 上班（刻度上）：18:59:59 沒收、19:00:00 收', [status(m).cap.locked, sysAt(m, D + 'T19:00:00')], [false, '19:00']);
}
{
  const m = world(D + 'T19:00:30', [ev('09:00:59', 'in')]);
  check('G5b', '09:00:59 上班（先捨秒＝09:00）→ 19:00（不是 19:00:59）', status(m).cap.sys_hm, '19:00');
}
{
  const m = world(D + 'T19:14:59', [ev('09:15:00', 'in')]);
  check('G5c', '09:15:00 上班 → 19:14:59 沒收、19:15 收', [status(m).cap.locked, sysAt(m, D + 'T19:15:00')], [false, '19:15']);
}
{
  const m = world(D + 'T20:00:00', [ev('08:00:00', 'in'), ev('14:30:59', 'out'), ev('15:00:00', 'in')]);
  check('G5d', '下班 14:30:59（捨秒＝14:30，刻度上不動）＋15:00 上班 → 08:00–14:30＝6.5，18:30 收', status(m).cap.sys_hm, '18:30');
}
{
  const m = world(D + 'T18:59:59', [ev('08:56:17', 'in')]);
  const s = status(m).cap;
  check('G6', '只打上班卡 08:56:17、還沒下班：18:59:59 沒收、沒擋、今天已完成時數 0', [s.locked, s.in_block, sysRows(m).length], [false, false, 0]);
  check('G6b', '19:00 收（09:00 起 10 小時）', sysAt(m, D + 'T19:00:00'), '19:00');
}

console.log('\n════ 有時段的假夾在中間、央廚／總部固定休息 ════');
{
  const m = world(D + 'T18:59:00', [ev('08:52:00', 'in'), ev('12:07:00', 'out'), ev('13:50:00', 'in')], { reqs: [['leave', D, '12:00', '14:00', 2]] });
  check('G7★', '08:52–12:07（3）＋假 12–14（2，不被打卡零頭吃掉）＋13:50 上班（14:00 起）：18:59 沒收', status(m).cap.locked, false);
  check('G7b', '19:00 收（3＋2＋5）', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T19:30:00', [ev('08:00:00', 'in'), ev('12:00:00', 'out'), ev('13:00:00', 'in'), ev('17:00:00', 'out')], { reqs: [['leave', D, '17:00', '19:00', 2]] });
  check('G7c', '有時段的假緊接在下班後（17:00–19:00）：8＋2＝10 → 擋上班卡、X＝8', [status(m).cap.in_block, m.sb.capCheck_(m.self, ME, T(D + 'T19:30:00'), null).today_h], [true, 8]);
}
{
  const m = world(D + 'T18:59:00', [ev('07:46:00', 'in')], { config: CF });
  check('G8★', '央廚 07:46 上班（08:00 起）扣 12–13：18:59 沒收（原始 18:46 就收）', status(m).cap.locked, false);
  check('G8b', '19:00 收', sysAt(m, D + 'T19:00:00'), '19:00');
}
{
  const m = world(D + 'T22:59:00', [ev('12:40:00', 'in')], { config: CF });
  check('G8c', '央廚 12:40 上班（12:45；12:45–13:00 在休息裡）→ 22:59 沒收、23:00 收', [status(m).cap.locked, sysAt(m, D + 'T23:00:00')], [false, '23:00']);
}
{
  const m = world(D + 'T23:29:00', [ev('12:20:00', 'in'), ev('14:40:00', 'out'), ev('14:50:00', 'in')], { config: HQ });
  check('G8d', '總部 12:20–14:40（12:30–14:30 扣 14–15 重疊 0.5＝1.5）＋14:50 上班（15:00 起）→ 23:29 沒收、23:30 收', [status(m).cap.locked, sysAt(m, D + 'T23:30:00')], [false, '23:30']);
}
{
  const m = world(D + 'T19:00:00', [ev('08:00:00', 'in'), ev('18:30:00', 'out')], { config: CF });
  check('G8e', '休息帶在刻度上：扣「取整後區間的重疊」＝扣「原始重疊再取整」（央廚 08:00–18:30＝9.5 不擋）', [status(m).cap.in_block, m.sb.capCheck_(m.self, ME, T(D + 'T19:00:00'), null).today_h], [false, 9.5]);
}

console.log('\n════ 跨店（真實案例那筆就是支援帳號）════');
{
  const PEER = { roster: [{ emp_id: 'P9', name: '測試一', key: 'PK', active: 'TRUE' }], events: [[D + 'T08:56:17', 'P9', 'in'], [D + 'T14:32:46', 'P9', 'out']] };
  const m = world(D + 'T21:59:00', [ev('17:25:58', 'in')], { peers: { PEER1: PEER } });
  check('G10', '別家店 08:56:17–14:32:46（5.5）＋本店 17:25:58 上班：21:59 沒收、22:00 收', [status(m).cap.locked, sysAt(m, D + 'T22:00:00')], [false, '22:00']);
}

console.log('\n════ 階梯上找第一個刻度（capReach_）════');
{
  const m = world(D + 'T09:00:00', []);
  const step = (from, v0) => (t) => v0 + Math.max(0, m.sb.capGridMs_(from, t));
  const from = T(D + 'T17:25:58');
  check('Q1', '真實案例：前段 5.5、17:25:58 上班 → 22:00:00（不是 21:55:58 或跳過 22:00）', m.sb.capReach_(step(from, 5.5 * 3600000), from, []), T(D + 'T22:00:00'));
  check('Q2', '還差 0：從上班那一刻就滿', m.sb.capReach_(step(from, 10 * 3600000), from, []), from);
  const jump = T(D + 'T15:07:30'), f2 = T(D + 'T09:00:00');
  const tot = (t) => m.sb.capGridMs_(f2, t) + (t >= jump ? 4 * 3600000 : 0);
  check('Q3', '中途核准（另一種做法才會有）在 15:07:30 加 4 小時 → 停在核准那一刻，不跳過', m.sb.capReach_(tot, f2, [jump]), jump);
}
{
  const m = world(D + 'T15:10:00', [ev('09:00:00', 'in')], { reqs: [['leave', D, '05:00', '09:00', 4, '2026-11-20T15:07:30+08:00']], live: { CAP_LIVE_LATE_OK: true } });
  check('Q4', '另一種做法（上班中核准也算）：6 小時打卡＋15:07:30 核准的 4 小時假 → 系統卡記在 15:07', status(m).cap.sys_hm, '15:07');
}
{
  const m = world(D + 'T15:10:00', [ev('09:00:00', 'in')], { reqs: [['leave', D, '05:00', '09:00', 4, '2026-11-20T15:07:30+08:00']] });
  check('Q5', '預設（上班中才核准的不當場收）：同上不收', status(m).cap.locked, false);
}

console.log('\n════ 「你今天已經上班 X 小時」顯示取整後的時數（第 8 點）════');
{
  const evs = [ev('08:56:17', 'in'), ev('14:32:46', 'out'), ev('15:00:00', 'in'), ev('19:46:00', 'out')];
  const m = world(D + 'T20:00:00', evs, { props: { REST_RULE_ON: '1' } });
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T20:00:00'), null);
  check('G9★', '5.5＋4.75＝10.25：擋上班卡、X＝10.25（原本顯示原始 10.4）', [st.in_block, st.today_h, st.reason], [true, 10.25, '你今天已經上班 10.25 小時，已滿 10 小時']);
  const rs = m.sb.restStatus_(m.self, ME);
  check('G9b★', '打卡頁提醒（Rest.gs，收卡開關開著）同一句、同一個數', rs.warn && rs.warn.reason, '你今天已經上班 10.25 小時，已滿 10 小時');
}
{
  const evs = [ev('08:56:17', 'in'), ev('14:32:46', 'out'), ev('15:00:00', 'in'), ev('19:40:00', 'out')];
  const m = world(D + 'T20:00:00', evs, { props: { REST_RULE_ON: '1' } });
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T20:00:00'), null);
  check('G9c★', '5.5＋4.5＝取整 10、原始 10.27：擋上班卡 X＝10', [st.in_block, st.today_h], [true, 10]);
}
{
  const evs = [ev('08:56:17', 'in'), ev('14:32:46', 'out'), ev('15:03:00', 'in'), ev('19:40:00', 'out')];
  const m = world(D + 'T20:00:00', evs, { props: { REST_RULE_ON: '1' } });
  const st = m.sb.capCheck_(m.self, ME, T(D + 'T20:00:00'), null);
  check('G9d★', '原始 10.23、取整 5.5＋4.25＝9.75 → 不擋、提醒也不出（以前會擋）', [st.in_block, m.sb.restStatus_(m.self, ME).warn || null], [false, null]);
}

console.log('\n════ 開關 REST_CAP_ON 關著：跟主線一樣（不收、提醒照原始打卡加總、字一字不差）════');
{
  const m = world(D + 'T22:30:00', REAL, { props: { REST_CAP_ON: '' } });
  check('S1', '關著：真實案例 22:30 不收、下班卡照收、沒有系統卡', [status(m).cap.locked, punch(m, 'out').ok, sysRows(m).length], [false, true, 0]);
  check('S2', '關著：capCheck_ 回 null（打卡不經過新算法）', m.sb.capCheck_(m.self, ME, T(D + 'T22:31:00'), null), null);
}
{
  const evs = [ev('08:56:17', 'in'), ev('14:32:46', 'out'), ev('15:00:00', 'in'), ev('19:46:00', 'out')];
  const m = world(D + 'T20:00:00', evs, { props: { REST_RULE_ON: '1', REST_CAP_ON: '' } });
  const rs = m.sb.restStatus_(m.self, ME);
  check('S3', '關著：提醒照原始打卡 10.37 → 顯示 10.4、舊字（跟主線一樣）', rs.warn && rs.warn.reason, '你今天已經上班 10.4 小時（一天最多 10 小時）');
}

console.log('\n════ 09:00 通知匣的字（第 9 點；不受 REST_CAP_ON 控制）════');
{
  const pay = R('apps-script/Payroll.gs');
  const extract = (src, name) => { const i = src.search(new RegExp('\\nfunction ' + name + '\\(')); let j = src.indexOf('{', i), dep = 0, k = j; for (; k < src.length; k++) { if (src[k] === '{') dep++; else if (src[k] === '}') { dep--; if (!dep) break; } } return src.slice(i, k + 1); };
  const sent = [];
  const sb = { String, Number, Math, JSON, Object, Array, PAY_DAY_MAX_H: 10,
    payInboxNotify_: (title, text, key) => { sent.push({ title, text, key }); return true; },
    payRestOverList_: () => [
      { store: 'A', store_name: '甲店', emp_id: 'A1', name: '王一', hours: 10, approved_h: 8, leave_h: 2, periods: '09:00-17:00' },
      { store: 'A', store_name: '甲店', emp_id: 'A2', name: '李二', hours: 10.25, approved_h: 10.25, leave_h: 0, periods: '甲店 09:00-15:00；乙店 17:00-21:15' },
      { store: 'B', store_name: '乙店', emp_id: 'B3', name: '陳三', hours: 10, approved_h: 10, leave_h: 0, periods: '' }] };
  vm.createContext(sb);
  vm.runInContext(['payRestOverRun_', 'payRestOverLine_', 'payRestOverText_'].map((f) => extract(pay, f)).join('\n'), sb);
  const r = sb.payRestOverRun_('2026-11-22');
  check('P9a', '標題「M/D 當日出勤滿 10 小時：N 人」', sent[0] && sent[0].title, '11/22 當日出勤滿 10 小時：3 人');
  check('P9b', '每人「X 小時（核定 a＋請假 b；時段）」；沒有時段就不留「；」', sent[0] && sent[0].text.split('\n').slice(1, 6),
    ['【甲店】', '王一 10 小時（核定 8＋請假 2；09:00-17:00）', '李二 10.25 小時（核定 10.25＋請假 0；甲店 09:00-15:00；乙店 17:00-21:15）', '【乙店】', '陳三 10 小時（核定 10＋請假 0）']);
  check('P9c', '第一行、最後一句（建議字，待主管看）', [sent[0].text.split('\n')[0], sent[0].text.split('\n').slice(-1)[0], sent[0].key],
    ['11/22 各店當日出勤（核定＋已核准請假）滿一天 10 小時（照實核定、已照付）：', '請提醒店長排班與下班時間控制在未滿 10 小時（含請假）。', 'restover-2026-11-22']);
  check('P9d', '回傳不變（list、inbox）', [r.list.length, r.inbox], [3, true]);
  check('P9e', '09:00 這條不看 REST_CAP_ON（關收卡開關退不回，要退版）', /REST_CAP_ON|capOn_/.test(extract(pay, 'payRestOverRun_') + extract(pay, 'payRestOverList_') + extract(pay, 'payDayLoadOver_')), false);
}

console.log('\n════ 正式程式 ＝ 試算 buffer-sim.js 的 A（11/1–11/22 重放 33 次／17 人的依據）；跟 #223 比只有「假單碰到取整零頭」會早 ════');
/* buffer15.md 的 33／17 是用 gen/buffer-sim.js 的 A（把 capDayMs_、capReach_ 換掉，二分找第一秒）在 #223 真程式上跑出來的。
 * 這裡不讀任何正式資料：用亂數造的出勤日，把三種算法放在同一套模擬（觸發器每 15 分＋下一張卡那一刻）比：
 *   mine＝本分支真程式；simA＝buffer-sim.js 的 A（逐字照抄那兩支替換函式）；base＝#223（原始秒數、舊 capReach_）。
 * 預期：沒有假單 → mine 與 simA 每一刻完全一樣（逐毫秒），也不會比 base 早 1 分鐘以上（早不到 1 分＝上班卡先捨秒，buffer15.md 算「同時」）；
 *   有時段的假 → 差別只在「假單時段碰到打卡取整的零頭」（mine 用取整後真正算進去的區間扣假單，simA 用原始秒數扣），每張卡最多差 15 分，
 *   這種日子 mine 可能比 base 早（例：央廚休息帶裡、別家店的假單蓋到打卡零頭）。
 *   11/1–11/22 會收的 48 筆（trial.csv，A 的 33 筆是其中一部分）當天都沒有任何假單、出差，所以重放結果＝simA＝33／17。 */
{
  const MIN = 60000, Q = 15 * MIN;
  const up15 = (ms) => Math.ceil(Math.floor(ms / MIN) / 15) * Q, dn15 = (ms) => Math.floor(Math.floor(ms / MIN) / 15) * Q;
  const mk = () => { const m = make({ now: T(D + 'T09:00:00'), props: { REST_CAP_ON: '1' }, self: { roster: [ME], events: [] } }); m.run(R('apps-script/Cap10.gs')); return m.sb; };
  const mine = mk(), simA = mk(), base = mk();
  // ── buffer-sim.js ctxOf('A') 逐字（變數名改成 sb＝simA）──
  {
    const sb = simA, brkMs = sb.capBreakMs_;
    const segLen = (s, brk) => { let a = up15(s.in), b = dn15(s.out); if (b <= a) return 0; return (b - a) - (s.store ? 0 : brkMs(a, b, brk)); };
    sb.capDayMs_ = function (segs, open, t, d, brk, leaves) {
      let punch = 0; const work = [];
      segs.forEach((s) => { if (s.lone || s.out > t || sb.capDay_(s.in) !== d) return; punch += segLen(s, brk, false); work.push([s.in, s.out]); });
      if (open && t > open.ms && sb.capDay_(open.ms) === d) { const o = { in: open.ms, out: t, store: open.store }; punch += segLen(o, brk, true); work.push([o.in, o.out]); }
      const leave = sb.capLeaveMs_(leaves, d, work, brk, t);
      return { punch, leave, total: punch + leave };
    };
    sb.capReach_ = function (tot, from) {
      const need = sb.CAP_H * 3600000; let lo = from, hi = from + 20 * 3600000;
      if (tot(hi) < need) return null;
      if (tot(lo) >= need) return lo;
      while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (mid <= lo) break; if (tot(mid) >= need) hi = mid; else lo = mid; }
      return hi;
    };
  }
  // ── #223（da9d510）：原始秒數、舊 capReach_ ──
  base.capSegSpan_ = (s, brk) => ({ a: s.in, b: s.out, ms: (s.out - s.in) - (s.store ? 0 : base.capBreakMs_(s.in, s.out, brk)) });
  base.capReach_ = function (tot, from, jumps) {
    const need = base.CAP_H * 3600000; let t = from;
    for (let i = 0; i < 80; i++) { const v = tot(t); if (v >= need) return t; const nt = t + (need - v); let j = null; (jumps || []).forEach((d) => { if (d > t && d <= nt && (j === null || d < j)) j = d; }); t = j !== null ? j : nt; }
    return null;
  };
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const day0 = T(D + 'T00:00:00');
  const iso = (ms) => new Date(ms).toISOString();
  function genDay(withLeave) {
    const evs = []; let t = day0 + (6 * 3600 + Math.floor(rnd() * 8 * 3600)) * 1000;
    const nSeg = 1 + Math.floor(rnd() * 3), openLast = rnd() < 0.8;
    for (let i = 0; i < nSeg; i++) {
      const store = rnd() < 0.15 ? 'p0' : '';
      evs.push({ ts: iso(t), type: 'in', status: 'ok', source: '', store });
      if (i === nSeg - 1 && openLast) break;
      t += (1 + rnd() * 6) * 3600000 + Math.floor(rnd() * 60) * 1000;
      evs.push({ ts: iso(t), type: 'out', status: 'ok', source: '', store });
      t += (0.2 + rnd() * 3) * 3600000 + Math.floor(rnd() * 60) * 1000;
    }
    const brk = pick([null, null, { s: '12:00', e: '13:00' }, { s: '14:00', e: '15:00' }]);
    const leaves = [];
    if (withLeave) {
      const k = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < k; i++) {
        const a = day0 + Math.floor((5 * 60 + rnd() * 15 * 60) / 5) * 5 * MIN, len = (1 + Math.floor(rnd() * 16)) * Q;
        leaves.push({ day: D, a, b: a + len, ms: rnd() < 0.3 ? len - Q : len, store: rnd() < 0.2 ? 'p0' : '', kind: 'leave', type: '特休假', dec: T(D + 'T00:00:00') - 3600000 });
      }
    }
    return { evs, brk, leaves, openIn: openLast ? Date.parse(evs[evs.length - 1].ts) : null };
  }
  // 已下班的日子比「今天已完成的出勤」（擋上班卡用）；還在上班的日子比第一張系統卡時間。
  function firstDue(sb, g) {
    if (g.openIn === null) return { done: sb.capJudge_(g.evs, day0 + 23 * 3600000, null, g.brk, g.leaves).today_ms };
    const end = g.openIn + 16 * 3600000;
    for (let t = Math.ceil((g.openIn + 1) / Q) * Q; t <= end; t += Q) {
      const r = sb.capJudge_(g.evs, t, null, g.brk, g.leaves);
      if (r.due) return { at: r.due.at };
    }
    return { at: null };
  }
  // 「比較早」＝早收（at 較小或對方不收）或已下班時數較多；早不到 1 分鐘算同時（上班卡先捨秒，同 buffer15.md 的計法）
  const cmp = (x, y) => {
    if ('done' in x) return x.done > y.done ? -1 : x.done < y.done ? 1 : 0;
    if (x.at === y.at) return 0;
    if (x.at === null) return 1;
    if (y.at === null) return -1;
    return y.at - x.at >= 60000 ? -1 : x.at - y.at >= 60000 ? 1 : 0;
  };
  // 這天有沒有假單時段碰到打卡取整的零頭（任何一張卡前後 15 分內）
  const near = (g) => g.leaves.some((l) => g.evs.some((e) => { const x = Date.parse(e.ts); return l.a < x + Q && l.b > x - Q; }));
  const run = (withLeave, n) => {
    const out = { n: 0, same: 0, exact: 0, mineEarlier: 0, mineLater: 0, beforeBase: 0, subMin: 0, sample: null };
    for (let i = 0; i < n; i++) {
      const g = genDay(withLeave), a = firstDue(mine, g), b = firstDue(simA, g), c = firstDue(base, g);
      out.n++;
      if (JSON.stringify(a) === JSON.stringify(b)) out.exact++;
      const k = cmp(a, b), nz = near(g), big = (x, y) => (typeof x.at === 'number' && typeof y.at === 'number' ? Math.abs(x.at - y.at) : 0) > Q * g.evs.length + MIN;   // 每張卡的零頭最多 15 分
      if (k === 0) out.same++; else if (k < 0) out.mineEarlier++; else out.mineLater++;
      if (k !== 0 && (!nz || big(a, b)) && !out.sample) out.sample = { g, a, b };   // 跟試算 A 不同，只能是「假單碰到取整零頭」，而且差不到 15 分
      const kb = cmp(a, c);
      if (kb < 0) { out.beforeBase++; if ((!nz || big(a, c)) && !out.bsample) out.bsample = { g, a, c }; }
      if (kb === 0 && typeof a.at === 'number' && typeof c.at === 'number' && a.at < c.at) out.subMin++;
    }
    return out;
  };
  const noLv = run(false, 1500), lv = run(true, 1500);
  check('E1', '沒有假單（含兩段、三段、跨店、央廚／總部休息、還在上班／已下班）1500 天：正式程式每一筆都＝試算 A（逐毫秒）', [noLv.n, noLv.exact], [1500, 1500]);
  check('E2', '有時段的假 1500 天：跟試算 A 不一樣的，全部是「假單時段碰到打卡取整的零頭」的日子，而且差不超過「每張卡 15 分」（正式程式用取整後的區間扣假單，試算 A 用原始秒數）', lv.sample && JSON.stringify(lv.sample).slice(0, 300), null);
  check('E3', '比 #223（原始秒數）早 1 分鐘以上的：沒有假單 0 天；有假單的只在「假單碰到取整零頭」、差不超過每張卡 15 分', [noLv.beforeBase, lv.bsample && JSON.stringify(lv.bsample).slice(0, 300)], [0, null]);
  console.log('    （參考）有假單那組：與試算 A 同時 ' + lv.same + '、早 ' + lv.mineEarlier + '、晚 ' + lv.mineLater + '；比 #223 早 1 分以上 ' + lv.beforeBase + '；比 #223 早不到 1 分鐘（上班卡捨秒）：無假單 ' + noLv.subMin + '、有假單 ' + lv.subMin);
}
done();
