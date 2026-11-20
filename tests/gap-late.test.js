/* 二段班中途離開又回來，比照遲到記（2026-11-20 Eason 第 11 題 B；Requests.gs reqGapLateMs_、Code.gs computeApprovalStatus gapLate）。
 * 規則白話：同一段班表裡打下班卡離開、又打上班卡回來，中間空檔被核定蓋住 → 空檔照「遲到」記（跟開頭晚到同一套：沒寬限、照實際分鐘、薪資照扣），
 *   不當「核定比打卡多」。只在上線日（REQ_GAP_LATE_FROM）起的日子、營運系統帶班表時、預設只有二段班（班表兩段以上）。
 * 手算預期（日期 2026-11-20，班表 11:00–14:00／16:00–20:00）：
 *   G1  卡 10:58–14:00、15:58–16:03、17:24–20:00，核定 11–14、16–20 → 7 小時、遲到 81（17:24−16:03）、不擋
 *   G1o 同上但沒設屬性（程式預設上線日 11/22，這天在之前）→ 擋「核定比打卡多 81 分鐘」（＝改之前）；G1p 程式預設＝2026-11-22
 *   G1d 上線日 11/21（這天在上線前）→ 照舊擋 81
 *   G2  單段班 16–20、卡 15:58–16:03、17:24–20:00、核定 16–20：預設 multi → 擋 81；REQ_GAP_LATE_SCOPE=all → 4 小時、遲到 81
 *   G3  舊值班頁（沒帶班表）→ 擋 81
 *   G4  第二段開頭也晚到：卡 16:10–16:30、17:00–20:00，核定 16–20 → 遲到 40（10＋30）
 *   G5  主管填遲到 0 → 空檔被免掉＝沒打卡的多核工時 → 擋 81
 *   G6  第二段班設休息 30 分：卡 16:00–17:00、17:30–18:30、19:10–20:00；核定 16–17、17:30–20:00 → 遲到 40（18:30–19:10；17:00–17:30 是休息）
 *       核定 16–20 蓋過休息 → 休息 30 分不當遲到 → 擋「核定比打卡多 30 分鐘」
 *   G7  空檔碰到已核准事假 16:30–17:00 → 不走這條（reqGapLateMs_＝0），照請假規則：核定 16–16:30、17–20 → 遲到 10
 *   G8  空檔碰到不打卡休息帶 12–13 → 0；G9 「中間休息」忘打卡單補出來的空檔 → 0
 *   R1–R6 班別休息超過（第二段休 30，17:00 出去）：17:50 回＝遲到20｜17:30 回＝正常｜17:20 回＝正常（休息照扣滿 30）｜再加 18:30–19:10 中途離開＝遲到60｜18:10 回＝遲到40、關著＝擋 40｜單段班照 11/17
 *   G10 狀態字串：沒開＝遲到84分、有多出的打卡段（改之前）；開＝遲到81分；薪資解析 81 分
 * 名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const D = '2026-11-20';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const ON = { REQ_STRICT_FROM: '2026-11-01', REQ_GAP_LATE_FROM: '2026-11-20' };
function env(evs, opt) {
  opt = opt || {};
  const m = make({ now: T('2026-11-21T21:00:00'), props: Object.assign({}, opt.props === undefined ? ON : opt.props),
    config: opt.config || { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: evs.map((e) => [D + 'T' + e[0] + ':00', 'E01', e[1]]) } });
  const sh = m.sb.reqSheet_(m.self, true);
  (opt.reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
const TWO = [{ start: '11:00', end: '14:00' }, { start: '16:00', end: '20:00' }];
const ACT = (o) => Object.assign({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: TWO }, o || {});
function approve(m, periods, extra) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods) }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', hours: r.approved_hours === undefined ? null : r.approved_hours, status: r.status_text || '', message: r.message || '' };
}
const DAY81 = [['10:58', 'in'], ['14:00', 'out'], ['15:58', 'in'], ['16:03', 'out'], ['17:24', 'in'], ['20:00', 'out']];

console.log('════ 一、81 分鐘的例子（二段班第二段 16:00–20:00）════');
let m = env(DAY81);
let r = approve(m, '11:00-14:00,16:00-20:00', ACT({ dry_run: true }));
check('G1d0', '只檢查：過、狀態遲到81分', [r.ok, r.status], [true, '遲到81分']);
r = approve(m, '11:00-14:00,16:00-20:00', ACT());
check('G1', '核定 11–14、16–20 → 7 小時、遲到81分、不擋', [r.ok, r.hours, r.status], [true, 7, '遲到81分']);
m = env(DAY81, { props: { REQ_STRICT_FROM: '2026-11-01' } });
r = approve(m, '11:00-14:00,16:00-20:00', ACT());
check('G1o', '沒設屬性＝用程式預設上線日 11/22，這天 11/20 在之前 → 照改之前擋「核定比打卡多 81 分鐘」', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);
check('G1p', '程式預設上線日＝2026-11-22（Eason：九店部署完成隔天起算；要跟營運系統 core-calc.js GAP_LATE_FROM 同一天）：11/21 否、11/22 是', [m.sb.reqGapLateFrom_(), m.sb.reqGapLateOn_('2026-11-21'), m.sb.reqGapLateOn_('2026-11-22')], ['2026-11-22', false, true]);
m = env(DAY81, { props: { REQ_STRICT_FROM: '2026-11-01', REQ_GAP_LATE_FROM: '2026-11-21' } });
r = approve(m, '11:00-14:00,16:00-20:00', ACT());
check('G1d', '上線日 11/21、這天 11/20 在上線前 → 照舊擋 81（不回溯）', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);
m = env(DAY81, { props: Object.assign({}, ON, { REQ_GAP_LATE_FROM: 'off' }) });
r = approve(m, '11:00-14:00,16:00-20:00', ACT());
check('G1x', 'REQ_GAP_LATE_FROM=off → 關（退回用）', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);

console.log('\n════ 二、單段班、舊值班頁 ════');
const ONE = [['15:58', 'in'], ['16:03', 'out'], ['17:24', 'in'], ['20:00', 'out']];
m = env(ONE);
r = approve(m, '16:00-20:00', ACT({ sched_spans: [{ start: '16:00', end: '20:00' }] }));
check('G2', '單段班 16–20（預設只算二段班）→ 擋 81', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);
m = env(ONE, { props: Object.assign({}, ON, { REQ_GAP_LATE_SCOPE: 'all' }) });
r = approve(m, '16:00-20:00', ACT({ sched_spans: [{ start: '16:00', end: '20:00' }] }));
check('G2a', 'REQ_GAP_LATE_SCOPE=all → 單段班也算：4 小時、遲到81分', [r.ok, r.hours, r.status], [true, 4, '遲到81分']);
m = env(DAY81);
r = approve(m, '11:00-14:00,16:00-20:00');
check('G3', '舊值班頁（沒帶班表）→ 擋 81', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);

console.log('\n════ 三、開頭也晚到、主管填遲到 ════');
m = env([['11:00', 'in'], ['14:00', 'out'], ['16:10', 'in'], ['16:30', 'out'], ['17:00', 'in'], ['20:00', 'out']]);
r = approve(m, '11:00-14:00,16:00-20:00', ACT());
check('G4', '16:10 到、16:30 走、17:00 回 → 遲到40分（10＋30）', [r.ok, r.hours, r.status], [true, 7, '遲到40分']);
m = env(DAY81);
r = approve(m, '11:00-14:00,16:00-20:00', ACT({ late_min: '0' }));
check('G5', '主管填遲到 0：空檔被免掉＝沒打卡卻要算 → 擋 81（同開頭遲到填 0 的規則）', [r.ok, /核定比打卡多 81 分鐘/.test(r.message)], [false, true]);
m = env(DAY81);
r = approve(m, '11:00-14:00,16:00-20:00', ACT({ late_min: '81' }));
check('G5b', '主管填遲到 81 → 過、狀態遲到81分(認定)', [r.ok, r.status], [true, '遲到81分(認定)']);

console.log('\n════ 四、班別休息、請假、休息帶、中間休息忘打卡單 ════');
const BRKD = [['11:00', 'in'], ['14:00', 'out'], ['16:00', 'in'], ['17:00', 'out'], ['17:30', 'in'], ['18:30', 'out'], ['19:10', 'in'], ['20:00', 'out']];
const SP_B = [{ start: '11:00', end: '14:00' }, { start: '16:00', end: '20:00', break_min: 30 }];
m = env(BRKD);
r = approve(m, '11:00-14:00,16:00-17:00,17:30-20:00', ACT({ sched_spans: SP_B }));
check('G6', '班別休息 30：17:00–17:30 是休息、18:30–19:10 記遲到40分', [r.ok, r.hours, r.status], [true, 6.5, '遲到40分']);
m = env(BRKD);
r = approve(m, '11:00-14:00,16:00-20:00', ACT({ sched_spans: SP_B }));
check('G6b', '核定蓋過休息 → 休息 30 分不當遲到 → 擋「核定比打卡多 30 分鐘」', [r.ok, /核定比打卡多 30 分鐘/.test(r.message)], [false, true]);
const LVR = [{ kind: 'leave', leave_type: '事假', start: '16:30', end: '17:00', hours: 0.5 }];
m = env([['11:00', 'in'], ['14:00', 'out'], ['16:00', 'in'], ['16:30', 'out'], ['17:10', 'in'], ['20:00', 'out']], { reqs: LVR });
r = approve(m, '11:00-14:00,16:00-16:30,17:00-20:00', ACT({ leaves: [{ type: '事假', hours: 0.5 }] }));
check('G7', '空檔碰到已核准事假 16:30–17:00 → 照請假規則：遲到10分（假單結束到回來）', [r.ok, r.hours, r.status], [true, 6.5, '遲到10分']);
{
  const mm = (hm) => T(D + 'T' + hm + ':00');
  const ps = [{ startMs: mm('11:00'), endMs: mm('14:00') }, { startMs: mm('16:00'), endMs: mm('20:00') }];
  const ss = [{ inMs: mm('11:00'), outMs: mm('14:00') }, { inMs: mm('16:00'), outMs: mm('16:30') }, { inMs: mm('17:10'), outMs: mm('20:00') }];
  const ok = [{ kind: 'leave', start: '16:30', end: '17:00' }];
  check('G7f', '函式層：碰到假單＝0；沒有假單＝40 分', [m.sb.reqGapLateMs_(D, ps, ss, TWO, null, ok), m.sb.reqGapLateMs_(D, ps, ss, TWO, null, []) / 60000], [0, 40]);
  const bw = { startMs: mm('16:20'), endMs: mm('16:40') };
  check('G8', '函式層：空檔碰到不打卡休息帶 → 0（照改之前）', m.sb.reqGapLateMs_(D, ps, ss, TWO, bw, []), 0);
  const brk = [{ kind: 'miss', miss_type: 'break', start: '17:10', end: '16:30' }];
  check('G9', '函式層：已核准「中間休息」忘打卡單（16:30 出去、17:10 回來）補出來的空檔 → 0', m.sb.reqGapLateMs_(D, ps, ss, TWO, null, brk), 0);
  const ps2 = [{ startMs: mm('11:00'), endMs: mm('14:00') }, { startMs: mm('16:00'), endMs: mm('16:30') }, { startMs: mm('17:10'), endMs: mm('20:00') }];
  check('G9b', '函式層：核定沒蓋住空檔（拆兩段核）→ 0', m.sb.reqGapLateMs_(D, ps2, ss, TWO, null, []), 0);
  const ss3 = [{ inMs: mm('11:00'), outMs: mm('13:30') }, { inMs: mm('16:30'), outMs: mm('20:00') }];
  check('G9c', '函式層：空檔跨兩段班表之間（13:30 走、16:30 回）→ 0（走結尾早退／開頭遲到那幾條）', m.sb.reqGapLateMs_(D, [{ startMs: mm('11:00'), endMs: mm('20:00') }], ss3, TWO, null, []), 0);
  check('G9d', '函式層：日期在上線日前 → 0', m.sb.reqGapLateMs_('2026-11-19', ps, ss, TWO, null, []), 0);
}

console.log('\n════ 五、狀態字串（computeApprovalStatus）與薪資解析 ════');
{
  const mm = (hm) => T(D + 'T' + hm + ':00');
  const ps = [{ startMs: mm('16:00'), endMs: mm('20:00') }];
  const ss = [{ in: '15:58', out: '16:03', inMs: mm('15:58'), outMs: mm('16:03') }, { in: '17:24', out: '20:00', inMs: mm('17:24'), outMs: mm('20:00') }];
  check('G10a', '沒開（改之前）：只比重疊最大那段 → 遲到84分、有多出的打卡段', m.sb.computeApprovalStatus(ps, ss, false, false, null), '遲到84分、有多出的打卡段');
  check('G10b', '開：遲到81分', m.sb.computeApprovalStatus(ps, ss, false, false, null, true), '遲到81分');
  const ss2 = [{ inMs: mm('09:00'), outMs: mm('15:00') }, { inMs: mm('15:20'), outMs: mm('17:30') }];
  const p2 = [{ startMs: mm('09:00'), endMs: mm('18:00') }];
  check('G10c', '09–18 打卡 09–15、15:20–17:30：沒開＝早退180分、有多出的打卡段；開＝遲到20分、早退30分', [m.sb.computeApprovalStatus(p2, ss2, false, false, null), m.sb.computeApprovalStatus(p2, ss2, false, false, null, true)], ['早退180分、有多出的打卡段', '遲到20分、早退30分']);
  const bw = { startMs: mm('12:00'), endMs: mm('13:00') };
  const ss3 = [{ inMs: mm('09:00'), outMs: mm('11:40') }, { inMs: mm('13:10'), outMs: mm('18:00') }];
  check('G10d', '空檔 11:40–13:10 跨休息帶 12–13（核定一整段 09–18）：休息帶 60 分不算 → 遲到30分', m.sb.computeApprovalStatus(p2, ss3, false, false, bw, true), '遲到30分');
  check('G10e', '出差日（legacy）照舊不套', m.sb.computeApprovalStatus(ps, ss, false, true, null, true), m.sb.computeApprovalStatus(ps, ss, false, true, null));
  const pm = make({ now: T('2026-11-21T21:00:00'), payroll: true, self: { roster: [ME], events: [] } });
  check('G10f', '薪資照舊解析：遲到81分 → late 81（扣款與全勤走既有遲到）', pm.sb.payLateEarlyMin_('遲到81分'), { late: 81, early: 0 });
  check('G10g', 'reqGapLateOn_：11/19 否、11/20 是（上線日 11/20）', [m.sb.reqGapLateOn_('2026-11-19'), m.sb.reqGapLateOn_('2026-11-20')], [false, true]);
}

console.log('\n════ 六、每天重算不回溯 ════');
{
  // 上線前核定、狀態「下班忘刷卡」這類會被每天重算的；上線日之後的日子才用新算法
  const evs = [['15:58', 'in'], ['16:03', 'out'], ['17:24', 'in'], ['20:00', 'out']];
  const mk = (from) => make({ now: T('2026-11-21T21:00:00'), props: { REQ_GAP_LATE_FROM: from }, config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: evs.map((e) => [D + 'T' + e[0] + ':00', 'E01', e[1]]) } });
  const rec = { periods: '16:00-20:00', status_text: '該段無打卡', name: '測試一' };
  const a = mk('2026-11-21'), b = mk('2026-11-20');
  const ra = a.sb.recomputeApprovalStatusOf(a.self, a.sb.readSheetAsObjects(a.self.getSheetByName('events')).rows.map((e) => { e.ts = a.sb.normCellTs(e.ts); return e; }), [ME], D, 'E01', rec);
  const rb = b.sb.recomputeApprovalStatusOf(b.self, b.sb.readSheetAsObjects(b.self.getSheetByName('events')).rows.map((e) => { e.ts = b.sb.normCellTs(e.ts); return e; }), [ME], D, 'E01', rec);
  check('G11', '每天重算：上線日 11/21 → 11/20 照舊（遲到84分、有多出的打卡段）；上線日 11/20 → 遲到81分', [ra.newStatusText, rb.newStatusText], ['遲到84分、有多出的打卡段', '遲到81分']);
}
console.log('\n════ 七、班別休息超過的部分（2026-11-20 Eason 第 3 題 B，只限二段班）════');
{
  // 班表 11:00–14:00／16:00–20:00（第二段排休息 30 分）；營運系統預填：休息從出去那張卡起扣滿 30 分，超過的核定蓋過、記遲到
  const SPB = [{ start: '11:00', end: '14:00' }, { start: '16:00', end: '20:00', break_min: 30 }];
  const day = (o, b, more) => [['11:00', 'in'], ['14:00', 'out'], ['16:00', 'in'], [o, 'out'], [b, 'in']].concat(more || [['20:00', 'out']]);
  for (const [id, back, label, st] of [['R1', '17:50', '出去 50 分（超過 20）→ 遲到20分', '遲到20分'], ['R2', '17:30', '剛好 30 分 → 正常', '正常'], ['R3', '17:20', '20 分就回來（沒超過，休息照扣滿 30）→ 正常', '正常']]) {
    const mm = env(day('17:00', back));
    const rr = approve(mm, '11:00-14:00,16:00-17:00,17:30-20:00', ACT({ sched_spans: SPB }));
    check(id, label + '；核定 6.5 小時', [rr.ok, rr.hours, rr.status], [true, 6.5, st]);
  }
  let mm = env(day('17:00', '17:50', [['18:30', 'out'], ['19:10', 'in'], ['20:00', 'out']]));
  let rr = approve(mm, '11:00-14:00,16:00-17:00,17:30-20:00', ACT({ sched_spans: SPB }));
  check('R4', '同一天休息超過 20＋後面中途離開 40（18:30–19:10）→ 遲到60分（合計）、6.5 小時、不擋', [rr.ok, rr.hours, rr.status], [true, 6.5, '遲到60分']);
  mm = env(day('17:00', '18:10'));
  rr = approve(mm, '11:00-14:00,16:00-17:00,17:30-20:00', ACT({ sched_spans: SPB }));
  check('R5', '出去 70 分（超過 40）→ 核定比打卡多不擋、遲到40分', [rr.ok, rr.hours, rr.status], [true, 6.5, '遲到40分']);
  mm = env(day('17:00', '18:10'), { props: { REQ_STRICT_FROM: '2026-11-01' } });
  rr = approve(mm, '11:00-14:00,16:00-17:00,17:30-20:00', ACT({ sched_spans: SPB }));
  check('R5o', '整條關著 → 照 11/17：超過的 40 分是核定比打卡多、擋', [rr.ok, /核定比打卡多 40 分鐘/.test(rr.message)], [false, true]);
  const mms = (hm) => T(D + 'T' + hm + ':00');
  const ps1 = [{ startMs: mms('16:00'), endMs: mms('17:00') }, { startMs: mms('17:30'), endMs: mms('20:00') }];
  const ss1 = [{ inMs: mms('16:00'), outMs: mms('17:00') }, { inMs: mms('18:10'), outMs: mms('20:00') }];
  check('R6', '函式層：單段班（16–20 休 30）就算 REQ_GAP_LATE_SCOPE=all 也照 11/17 → 0',
    env([], { props: Object.assign({}, ON, { REQ_GAP_LATE_SCOPE: 'all' }) }).sb.reqGapLateMs_(D, ps1, ss1, [{ start: '16:00', end: '20:00', break_min: 30 }], null, []), 0);
  const on = env([]);
  check('R6b', '函式層（開著）：二段班 → 40 分；碰到已核准假單 → 0', [on.sb.reqGapLateMs_(D, ps1, ss1, SPB, null, []) / 60000, on.sb.reqGapLateMs_(D, ps1, ss1, SPB, null, [{ kind: 'leave', start: '17:00', end: '18:00' }])], [40, 0]);
}
done();
