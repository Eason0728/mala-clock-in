/* 上午整段沒到改算遲到（2026-11-26 主管「央廚這類『休息前整段沒到』改判遲到。都照推薦」；設計 _brain_out/late-first-block/design.md、確認頁 10 題全取推薦）。
 *
 * 規則白話：被不打卡休息帶（央廚 12–13、總部 14–15）切開的班，休息帶前面那段整段沒有打卡、第一張卡是休息帶當中或之後才打的上班卡 →
 *   不再當缺卡（要 2 張忘打卡單），改記遲到；遲到分鐘＝核定時段裡、第一張上班卡之前的分鐘數（休息不算）。核定時數照時段，薪資照既有「遲到不計薪」扣。
 *   2026-11-01 起的日子才套（寫死、沒有開關；原定 12/1，2026-11-26 主管改 11/1）；前導段有已核准忘打卡單、出差、打卡未入帳＝照舊；已核定的不回頭改（含每天 05:00 重算）。
 *
 * 手算對照（央廚，班 08:00–17:00、休 12–13，核定 08–12、13–17；示意時薪 200 元）：
 *   12:47 到 → 遲到 240（08–12 整段 240，12:00–12:47 在休息帶不算）｜13:20 → 240＋20＝260｜13:45 → 285｜11:30 → 210（不變）｜16:00 → 240＋180＝420
 *   總部 09–18 休 14–15、15:10 到 → 300＋10＝310｜只打 12:47 上班卡 → 遲到 240、下班忘刷卡（要 1 張單；改之前 3 張）
 *   薪資：計時 8 小時 × 200＝1,600，遲到 240 分 × 200 ÷ 60＝800 → 實發 800（＝4 小時，不多發、不重複扣）
 *
 * 用真函式（gs-sandbox 整檔載入 Code.gs＋Requests.gs）；改版前的版本用 git show（LATE_LEAD_BASE，預設 f21cc25＝這次改動前的 origin/main）。
 * 共用案例檔 fixtures/late-lead-cases-v1.json 與 mala-store-ops test/fixtures/late-lead-cases-v1.json 必須逐字相同（營運系統那邊跑同一份算預填）。
 * 名字、工號一律假的。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const { make, T, check, show, done, ROOT } = require('./helpers/gs-sandbox');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'late-lead-cases-v1.json'), 'utf8'));
const CUTOVER = make({}).run('REQ_LATE_LEAD_CUTOVER_');      // 換版時間（Requests.gs 一處定義；測試一律從這裡推，改期只改程式那一行）
const ME = { emp_id: 'CF15', name: '測試甲', key: 'K1', device_id: 'D1', active: 'TRUE' };
const P = (list) => list.map((p) => ({ start: p.start, end: p.end }));
const lateSum = (st) => String(st || '').split('、').reduce((a, n) => { const g = /^遲到(\d+)分/.exec(n); return a + (g ? Number(g[1]) : 0); }, 0);

function env(c, opt) {
  opt = opt || {};
  const D = c.date, evs = [];
  (c.punches || []).forEach((s) => { if (s.in) evs.push([D + 'T' + s.in + ':00', 'CF15', 'in']); if (s.out) evs.push([D + 'T' + s.out + ':00', 'CF15', 'out']); });
  (opt.extraEvents || []).forEach((e) => evs.push(e));
  const m = make({ now: T(opt.now || '2026-12-10T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01', REQ_BIND_FROM: '2026-10-01' },   // 綁單起算提前到 10/1（正式預設 11/1）：生效日改 11/1 後，「生效日前要跟主線一樣要 2 張忘打卡單」只能拿 10 月的日子對照
    config: c.brk && c.brk.start ? { NO_PUNCH_BREAK_START: c.brk.start, NO_PUNCH_BREAK_END: c.brk.end } : {},
    self: { roster: [ME], events: evs, approved: opt.approved || [] } });
  const sh = m.sb.reqSheet_(m.self, true);
  (c.reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: D + 'T08:00:00+08:00', emp_id: 'CF15', name: '測試甲', date: D, status: 'approved' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
function approve(m, c, extra) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: c.date, emp_id: 'CF15', periods: P(c.periods), leaves: c.leaves || [] }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', hours: r.approved_hours, status: r.status_text || '', miss: r.need ? r.need.miss_cards : 0, over: r.need ? r.need.over_min : 0, rules: (r.probs || []).map((p) => p.rule).join(',') };
}
/** 直接算核定狀態（被擋的日子也看得到），lateLead 照這一版核定時的判斷 */
function statusOf(m, c) {
  const sb = m.sb, D = c.date;
  const pms = P(c.periods).map((p) => { const s = sb.hmToMs(D, p.start); let e = sb.hmToMs(D, p.end); if (e <= s) e += 86400000; return { start: p.start, end: p.end, startMs: s, endMs: e }; });
  const ev = sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const segs = sb.dayPunchSegments(ev, 'CF15', D).segments.map((s) => ({ in: s.in, out: s.out, inMs: s.in ? sb.hmToMs(D, s.in) : null, outMs: s.out ? sb.hmToMs(D, s.out) : null }));
  const bw = sb.noPunchBreakWindow(D);
  const rows = sb.reqRows_(m.self);
  let lead = sb.reqLateLeadOn_(rows, 'CF15', D, pms, segs, bw);
  // 第六輪不變式（同 handleMgrApprove）：新規則讓缺卡／核定比打卡多判不過、主線判得過＝照主線
  if (lead && typeof sb.reqLateLeadKeep_ === 'function' && !sb.reqLateLeadKeep_(D, pms, segs, bw, sb.lateLeadDayRows_(rows, 'CF15', D), '')) lead = false;
  return { lead, status: sb.computeApprovalStatus(pms, segs, false, false, bw, false, lead) };
}

console.log('════ 一、共用案例檔（營運系統預填的時段送打卡端） ════');
check('F00', '案例檔版本 1、至少 19 個案例', [CASES.version, CASES.cases.length >= 19], [1, true]);
check('F01', '生效日：案例檔 effective_from＝Requests.gs REQ_LATE_LEAD_FROM_＝2026-11-01（營運系統 LATE_LEAD_FROM 那邊測試釘同一個值）', [CASES.effective_from, make({}).run('REQ_LATE_LEAD_FROM_')], ['2026-11-01', '2026-11-01']);
for (const c of CASES.cases) {
  const m = env(c);
  const so = statusOf(m, c);
  const r = approve(m, c, { dry_run: true });
  check(c.id + 'a', c.desc + '：只檢查 ' + (c.ok ? '過' : '擋' + (c.error ? '（' + c.error + '）' : '')) + '、忘打卡單 ' + c.need_miss + ' 張', [r.ok, r.miss].concat(c.error ? [r.error] : []), [c.ok, c.need_miss].concat(c.error ? [c.error] : []));
  if (c.error === 'need_diff_reason') {
    const r2 = approve(env(c), c, { dry_run: true, diff_reason: '上班卡：休息時間就到' });
    check(c.id + 'd', c.desc + '：選了原因 → 過、狀態「' + c.status + '」', [r2.ok, r2.status, lateSum(r2.status)], [true, c.status, c.late]);
  }
  check(c.id + 'b', c.desc + '：狀態「' + c.status + '」、新規則' + (c.lead ? '有' : '沒') + '套', [so.status, so.lead], [c.status, c.lead]);
  if (c.ok) check(c.id + 'c', c.desc + '：核定回的狀態一樣、遲到分鐘＝營運系統預填的 ' + c.late, [r.status, lateSum(r.status)], [c.status, c.late]);
}

console.log('\n════ 二、主管自己填遲到分鐘（第 4 題：照主管填的；填得比系統少，免掉的那段要有單） ════');
const CF15 = CASES.cases.find((c) => c.id === 'L01');
let r = approve(env(CF15), CF15, { dry_run: true, late_min: '240' });
check('M1', '填 240 → 「遲到240分(認定)」、可以核定', [r.ok, r.status], [true, '遲到240分(認定)']);
r = approve(env(CF15), CF15, { dry_run: true, late_min: '0' });
check('M2', '填 0 → 被擋「核定比打卡多 240 分鐘」（上午 4 小時要有單）', [r.ok, r.rules, r.over], [false, 'over_credit', 240]);
r = approve(env(CF15), CF15, { dry_run: true, late_min: '200' });
check('M3', '填 200 → 免掉的 40 分要有單（核定比打卡多 40 分）', [r.ok, r.over], [false, 40]);
r = approve(env(Object.assign({}, CF15, { date: '2026-10-29' })), Object.assign({}, CF15, { date: '2026-10-29' }), { dry_run: true, late_min: '240' });
check('M4', '生效日前填 240 → 跟改之前一樣仍要 2 張忘打卡單', [r.ok, r.miss], [false, 2]);

console.log('\n════ 三、真的核定（不是只檢查）：寫進 approved 的那一列 ════');
{
  const m = env(CF15);
  const w = approve(m, CF15, {});
  const row = m.approved().slice(-1)[0];
  check('W1', '核定成功、approved 寫 08:00-12:00,13:00-17:00、8 小時、遲到240分', [w.ok, row[3], row[4], row[5]], [true, '08:00-12:00,13:00-17:00', 8, '遲到240分']);
}

console.log('\n════ 四、正職也一樣（第 3 題 A）：營運系統帶正職、班表上班日 → 8 小時不用假單 ════');
{
  const m = env(CF15);
  const w = approve(m, CF15, { dry_run: true, mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: [{ start: '08:00', end: '17:00', break_min: 60 }], sched_ft: true, sched_support: false });
  check('FT1', '正職 12:47 到 → 核定 8 小時、遲到240分、不用請假', [w.ok, w.hours, w.status], [true, 8, '遲到240分']);
  const m2 = env(CF15);
  const w2 = m2.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', date: CF15.date, emp_id: 'CF15', periods: [{ start: '13:00', end: '17:00' }], sched_day: 'W', sched_spans: [{ start: '08:00', end: '17:00', break_min: 60 }], sched_ft: true, sched_support: false, dry_run: true });
  check('FT2', '主管照舊改 13–17：正職照舊要 4 小時假單（沒變）', [w2.ok, (w2.probs || []).some((p) => /^ft8/.test(p.rule))], [false, true]);
}

console.log('\n════ 五、加班單（第 8 題照現行）：12:47–19:00＋已核准加班 17–19 → 核 10 小時、遲到 240 ════');
{
  const c = Object.assign({}, CF15, { punches: [{ in: '12:47', out: '19:00' }], reqs: [{ kind: 'ot', start: '17:00', end: '19:00', hours: 2 }], periods: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '19:00' }] });
  const w = approve(env(c), c, { dry_run: true });
  check('OT1', '核定 10 小時、遲到240分、加班單 2 小時照現行對得上', [w.ok, w.hours, w.status], [true, 10, '遲到240分']);
}

console.log('\n════ 六、lateLeadOf_ 邊界 ════');
{
  const m = env(CF15), sb = m.sb, D = '2026-12-03';
  const per = (...xs) => xs.map(([a, b]) => ({ startMs: sb.hmToMs(D, a), endMs: sb.hmToMs(D, b) }));
  const seg = (a, b) => ({ inMs: a ? sb.hmToMs(D, a) : null, outMs: b ? sb.hmToMs(D, b) : null });
  const bw = sb.noPunchBreakWindow(D);
  const LL = (p, s, w) => { const x = sb.lateLeadOf_(p, s, w === undefined ? bw : w); return x ? [x.lead.length, x.rest.length, x.leadMin] : null; };
  check('E1', '08–12、13–17，12:47–17:00 → 前導 1 段 240 分', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')]), [1, 1, 240]);
  check('E2', '空檔比休息帶長（08–11、14–17）→ 不適用', LL(per(['08:00', '11:00'], ['14:00', '17:00']), [seg('14:00', '17:00')]), null);
  check('E3', '剛好相接（08–12、12–17）沒有空檔 → 不適用', LL(per(['08:00', '12:00'], ['12:00', '17:00']), [seg('12:47', '17:00')]), null);
  check('E4', '第一張是單張下班卡（不知道幾點到）→ 不適用', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg(null, '17:00')]), null);
  check('E5', '同一分鐘有下班卡和上班卡 → 不適用（偏保守）', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg(null, '12:47'), seg('12:47', '17:00')]), null);
  check('E6', '只有一段核定 → 不適用', LL(per(['08:00', '17:00']), [seg('12:47', '17:00')]), null);
  check('E7', '這家店沒有休息帶 → 不適用', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')], null), null);
  check('E8', '17:30 才到（所有核定段都結束了）→ 不適用', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('17:30', '18:00')]), null);
  check('E9', '11:30 到（上午那段有卡）→ 不適用', LL(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('11:30', '17:00')]), null);
  check('E10', '前導兩段（08–10、10–12）→ 前導 2 段、合計 240', LL(per(['08:00', '10:00'], ['10:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')]), [2, 1, 240]);
  // 其餘段兩段以上：段號沿用原始時段（第三段起）
  const st = sb.computeApprovalStatus(per(['08:00', '10:00'], ['10:00', '12:00'], ['13:00', '15:00'], ['15:30', '17:00']).map((p, i) => Object.assign(p, { start: 'x' + i })), [seg('12:47', '15:00')], false, false, bw, false, true);
  check('E11', '四段核定、前導兩段、第四段整段沒打 → 段號照原始時段寫「第四段」', st, '遲到240分、第四段上班無打卡、第四段下班無打卡');
  const st2 = sb.computeApprovalStatus(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')], true, false, bw, false, true);
  check('E12', '打卡未入帳（legacy）→ 不套、照舊', st2, '打卡未入帳，主管補登');
  const st3 = sb.computeApprovalStatus(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')], false, true, bw, false, true);
  check('E13', '出差 → 不套、照舊', st3, '出差');
  check('E14', '沒帶 lateLead＝改之前', sb.computeApprovalStatus(per(['08:00', '12:00'], ['13:00', '17:00']), [seg('12:47', '17:00')], false, false, bw, false), '第一段上班無打卡、第一段下班無打卡');
  check('E15', '生效日 2026-11-01（10/31 不套、11/1 起套、11/25 套）', [sb.reqLateLeadDay_('2026-10-31'), sb.reqLateLeadDay_('2026-11-01'), sb.reqLateLeadDay_('2026-11-25'), sb.reqLateLeadDay_('bad')], [false, true, true, false]);
  check('E16', '沒有指令碼屬性開關（寫死日期，mini 看得到同一個值）', /reqProp_\(['"]REQ_LATE_LEAD/.test(fs.readFileSync(path.join(ROOT, 'apps-script', 'Requests.gs'), 'utf8')), false);
}

console.log('\n════ 七、每天 05:00 重算（第 5 題 A：已核定的一筆都不動） ════');
{
  const rec = (c, st, now, extraEvents) => {
    // 核定時間＝換版時間（REQ_LATE_LEAD_CUTOVER_）本身＝換版後核定的列（第三輪之二；換版前核定的見七之三）
    const m = env(c, { now, extraEvents, approved: [[c.date, 'CF15', '測試甲', c.periods.map((p) => p.start + '-' + p.end).join(','), 8, st, '值班主管', CUTOVER, '', '']] });
    const out = m.sb.recheckPendingApprovalStatuses();
    return { fixed: out.fixed, last: m.approved().slice(-1)[0][5] };
  };
  check('R1', '12/3 用忘打卡單核過的「第一段上班無打卡、第一段下班無打卡」→ 不改（不會被改成遲到240分）',
    rec(Object.assign({}, CF15, { reqs: [{ kind: 'miss', miss_type: 'both', start: '08:00', end: '12:00' }] }), '第一段上班無打卡、第一段下班無打卡', '2026-12-05T05:00:00'),
    { fixed: 0, last: '第一段上班無打卡、第一段下班無打卡' });
  check('R1b', '同上、忘打卡單後來被作廢也不改（看原狀態）',
    rec(CF15, '第一段上班無打卡、第一段下班無打卡', '2026-12-05T05:00:00'), { fixed: 0, last: '第一段上班無打卡、第一段下班無打卡' });
  const c4 = CASES.cases.find((c) => c.id === 'L10');
  check('R2', '「遲到240分、上班中」過了 16 小時沒打下班卡 → 「遲到240分、下班忘刷卡」', rec(c4, '遲到240分、上班中', '2026-12-05T05:00:00'), { fixed: 1, last: '遲到240分、下班忘刷卡' });
  check('R3', '「遲到240分、下班忘刷卡」之後補到下班卡（待核准裝置被核准）→ 「遲到240分」', rec(c4, '遲到240分、下班忘刷卡', '2026-12-05T05:00:00', [['2026-12-03T17:00:00', 'CF15', 'out']]), { fixed: 1, last: '遲到240分' });
  check('R4', '「打卡未入帳，主管補登」後來卡都入帳 → 照舊判法（跟改之前一樣「第一段…」），不改成遲到',
    rec(CF15, '打卡未入帳，主管補登', '2026-12-05T05:00:00'), { fixed: 1, last: '第一段上班無打卡、第一段下班無打卡' });
  const c11 = Object.assign({}, CF15, { date: '2026-10-29' });
  check('R5', '生效日前（10/29）「第一段上班無打卡、第一段下班無打卡」→ 不改（跟改之前一樣）', rec(c11, '第一段上班無打卡、第一段下班無打卡', '2026-11-05T05:00:00'), { fixed: 0, last: '第一段上班無打卡、第一段下班無打卡' });
  check('R6', '主管認定的遲到「遲到240分(認定)、上班中」→ 認定保留、改「下班忘刷卡」', rec(c4, '遲到240分(認定)、上班中', '2026-12-05T05:00:00'), { fixed: 1, last: '下班忘刷卡、遲到240分(認定)' });
  // 亂數對照查到的：前導段有已核准忘打卡單、單張上班卡被舊判法併進同一塊（09–12、13–18、12:18 上班沒下班）→ 原狀態沒有「第一段」
  const cB2 = { date: '2026-12-03', brk: CF15.brk, punches: [{ in: '12:18', out: null }], reqs: [{ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }], periods: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }], leaves: [] };
  const so = statusOf(env(cB2), cB2);
  check('R7a', '前導段有忘打卡單（上班 09:00）→ 核定不套，狀態照舊判法', so, { lead: false, status: '遲到198分、下班忘刷卡' });
  check('R7b', '同一筆夜裡重算 → 不改（原狀態 198 分＝舊判法、不是新規則的 180）', rec(cB2, '遲到198分、下班忘刷卡', '2026-12-05T05:00:00'), { fixed: 0, last: '遲到198分、下班忘刷卡' });
  // 驗收第 5 項 (a)：12/1 換版前用舊程式核定（沒有忘打卡單）、休息中打的卡被舊判法併成一塊 → 夜裡不改成 180
  const cA = Object.assign({}, cB2, { reqs: [] });
  check('R8a', '(a) 舊程式核定「遲到198分、下班忘刷卡」（09–12／13–18、12:18 只有上班卡）→ 夜裡不改', rec(cA, '遲到198分、下班忘刷卡', '2026-12-05T05:00:00'), { fixed: 0, last: '遲到198分、下班忘刷卡' });
  check('R8b', '(a) 同上、之後補到 18:00 下班卡 → 跟 main 的重算一樣（照舊判法「第一段上班無打卡、第一段下班無打卡」，不改成遲到180）',
    rec(cA, '遲到198分、下班忘刷卡', '2026-12-05T05:00:00', [['2026-12-03T18:00:00', 'CF15', 'out']]), { fixed: 1, last: '第一段上班無打卡、第一段下班無打卡' });
  check('R8c', '(a) 新規則核定的「遲到180分、下班忘刷卡」補到下班卡 → 「遲到180分」', rec(cA, '遲到180分、下班忘刷卡', '2026-12-05T05:00:00', [['2026-12-03T18:00:00', 'CF15', 'out']]), { fixed: 1, last: '遲到180分' });
  // 驗收第 5 項 (b)：新規則核定後，上午才補了已核准忘打卡單。
  //   2026-11-26 第三輪改：夜裡重算跟核定用同一個判斷（reqLateLeadOn_，看現在的申請表，同出差看現在的出差單）→ 照忘打卡單（舊判法）＝主管現在重新核定的結果（R9b），
  //   也＝主線重算這一列的結果（主線重算本來就只用舊判法）。第二輪「夜裡不改」那條拿掉：它要靠不讀申請表，結果擋項 1 那類（核定當下就有忘打卡單）分不出來。
  const cBb = Object.assign({}, cA, { punches: [{ in: '12:47', out: null }], reqs: [{ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }] });
  check('R9a', '【已知行為，大腦 11/26 接受】(b) 換版後新規則核定「遲到180分、下班忘刷卡」，事後補了上午的忘打卡單 → 夜裡照忘打卡單（確認頁第 4 題表「上午有已核准的忘打卡單 → 照忘打卡單」；舊判法 227＝R9b 重新核定＝主線重算）', rec(cBb, '遲到180分、下班忘刷卡', '2026-12-05T05:00:00'), { fixed: 1, last: '遲到227分、下班忘刷卡' });
  check('R9b', '(b) 主管重新核定（帶這張忘打卡單）→ 照舊判法「遲到227分、下班忘刷卡」（main 對這種卡的既有結果）', statusOf(env(cBb), cBb), { lead: false, status: '遲到227分、下班忘刷卡' });
  console.log('\n── 休息帶設定長度 0、反向、缺一邊：一律不套（驗收第 3 項）──');
  for (const [k, bs, be] of [['B1', '12:00', '12:00'], ['B2', '13:00', '12:00'], ['B3', '12:00', ''], ['B4', '', '13:00']]) {
    const c = Object.assign({}, CF15, { brk: { start: bs, end: be } });
    const m = make({ now: T('2026-12-10T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01' }, config: { NO_PUNCH_BREAK_START: bs, NO_PUNCH_BREAK_END: be },
      self: { roster: [ME], events: [[c.date + 'T12:47:00', 'CF15', 'in'], [c.date + 'T17:00:00', 'CF15', 'out']] } });
    const sb = m.sb, D = c.date;
    const pms = P(c.periods).map((p) => ({ start: p.start, end: p.end, startMs: sb.hmToMs(D, p.start), endMs: sb.hmToMs(D, p.end) }));
    const segs = [{ inMs: sb.hmToMs(D, '12:47'), outMs: sb.hmToMs(D, '17:00') }];
    const bw = sb.noPunchBreakWindow(D);
    check(k, '休息帶 ' + (bs || '空') + '–' + (be || '空') + '：核定不套、重算不套、lateLeadOf_ 不給前導段、狀態＝不帶 lateLead（main）',
      [sb.reqLateLeadOn_(sb.reqRows_(m.self), 'CF15', D, pms, segs, bw), sb.lateLeadRecheck_(D, '下班忘刷卡', pms, segs), sb.lateLeadOf_(pms, segs, bw), sb.computeApprovalStatus(pms, segs, false, false, bw, false, sb.reqLateLeadOn_(sb.reqRows_(m.self), 'CF15', D, pms, segs, bw)) === sb.computeApprovalStatus(pms, segs, false, false, bw, false)],
      [false, 'off', null, true]);
  }
  check('B5', 'noPunchBreakWindow 12:00–12:00 照舊是跨夜 24 小時（給別的呼叫端的既有行為沒改）', (() => { const m = make({ config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '12:00' } }); const w = m.sb.noPunchBreakWindow('2026-12-03'); return (w.endMs - w.startMs) / 3600000; })(), 24);
}

// 改版前的版本（主線）：git show 到暫存資料夾，七之二、八、八之二共用，八之二跑完刪掉
const BASE = process.env.LATE_LEAD_BASE || 'f21cc25';
let base = null;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'late-lead-base-'));
  fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
  ['Code.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));
} catch (e) { base = null; show('X0', '跳過：拿不到改版前的版本 ' + BASE, String(e.message).split('\n')[0]); }
/** 整段流程（核定 → 之後補卡 → 05:00 重算；helpers/late-lead-flow.js）在 root 那一版跑；list 不給＝亂數流程語料 */
const flowRun = (root, list) => {
  const env = Object.assign({}, process.env, { GS_ROOT: root });
  let tmp = null;
  if (list) { tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'late-flow-')), 'in.json'); fs.writeFileSync(tmp, JSON.stringify(list)); env.LATE_FLOW_IN = tmp; } else delete env.LATE_FLOW_IN;
  try { return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'late-lead-flow.js')], { env, encoding: 'utf8', maxBuffer: 512 << 20 })); }
  finally { if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
};

console.log('\n════ 七之二、Codex 第一輪擋項 1：核定當下照忘打卡單判的列，之後補到下班卡 → 夜裡重算＝主線（' + BASE + '）的重算 ════');
if (base) {
  // 12/1 央廚（休 12–13）、核定 09–12／13–18、上午有已核准的整段忘打卡單；人還在上班時核定，18:00 打下班卡，隔天 05:00 重算
  const one = (name, inHm, late) => ({ name, date: '2026-12-01', brk: { start: '12:00', end: '13:00' }, periods: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
    reqs: [{ kind: 'miss', miss_type: 'both', start: '09:00', end: '12:00' }], late_min: late, before: [[inHm, 'in']], approveAt: '2026-12-01T14:00:00', after: [['18:00', 'out']], recheckAt: '2026-12-02T05:00:00' });
  const L = [one('a', '12:18', '198'), one('b', '12:00', ''),
    Object.assign(one('c', '12:00', ''), { reqs: [{ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }] }),          // 只有上班那張忘打卡單（in）
    Object.assign(one('d', '12:30', '0'), { reqs: [{ kind: 'miss', miss_type: 'both', start: '09:00', end: '12:00' }] })];  // 主管填 0（認定不計遲到）
  const A = flowRun(base, L), B = flowRun(ROOT, L);
  const pickR = (r) => ({ ap: r.ap.ok ? r.ap.st : 'blocked:' + r.ap.error, after: r.st });
  check('R10a', '(a) 上午有已核准整段忘打卡單、12:18 上班、上班中核定填遲到 198 → 補到下班卡後重算＝主線「第一段上班無打卡、第一段下班無打卡、遲到198分(認定)」',
    pickR(B[0]), pickR(A[0]));
  check('R10a2', '(a) 主線結果本身（釘住數字）', pickR(A[0]), { ap: '上班中、遲到198分(認定)', after: '第一段上班無打卡、第一段下班無打卡、遲到198分(認定)' });
  check('R10b', '(b) 同一張單、12:00 上班、遲到欄空白（舊判法 180＝新規則 180）→ 重算＝主線「第一段上班無打卡、第一段下班無打卡」', pickR(B[1]), pickR(A[1]));
  check('R10b2', '(b) 主線結果本身（釘住數字）', pickR(A[1]), { ap: '遲到180分、上班中', after: '第一段上班無打卡、第一段下班無打卡' });
  check('R10c', '只有上班那張忘打卡單（in 09:00）、12:00 上班 → 重算＝主線', pickR(B[2]), pickR(A[2]));
  check('R10d', '整段忘打卡單＋主管填 0 → 核定與重算＝主線', pickR(B[3]), pickR(A[3]));
}

console.log('\n════ 七之三、換版時間（REQ_LATE_LEAD_CUTOVER_＝' + CUTOVER + '；第三輪之二）：換版前核定的列夜裡一律＝主線重算 ════');
if (base) {
  const cutMs = Date.parse(CUTOVER);
  check('C0', '換版時間是合法的時間、晚於生效日（Requests.gs 一處定義）', [Number.isFinite(cutMs), cutMs > Date.parse(make({}).run('REQ_LATE_LEAD_FROM_') + 'T00:00:00+08:00')], [true, true]);
  // A．12:00 整到＋下班忘刷卡、之後才補到下班卡；B．主管填遲到＋單張上班卡、之後才補到下班卡（第三輪回報的兩類）
  const resid = (name, inHm, late, st0) => ({ name, date: '2026-11-20', brk: { start: '12:00', end: '13:00' }, periods: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
    reqs: [{ kind: 'miss', miss_type: 'out', start: '', end: '18:00' }], late_min: late, st0, before: [[inHm, 'in']], approveAt: '2026-11-21T10:00:00', after: [['18:00', 'out']], recheckAt: '2026-11-28T05:00:00' });
  const RA = resid('A', '12:00', '', '遲到180分、下班忘刷卡'), RB = resid('B', '12:18', '198', '下班忘刷卡、遲到198分(認定)');
  const L = [Object.assign({}, RA, { cut: 'before' }), Object.assign({}, RB, { cut: 'before' }), Object.assign({}, RA, { cut: 'after' }), Object.assign({}, RB, { cut: 'after' })];
  const A0 = flowRun(base, L), B0 = flowRun(ROOT, L);
  check('C1', 'A 類、換版前核定 → 夜裡重算＝主線（「第一段上班無打卡、第一段下班無打卡」）', B0[0].st, A0[0].st);
  check('C2', 'B 類、換版前核定 → 夜裡重算＝主線（保留兩條忘刷、遲到198分(認定)）', B0[1].st, A0[1].st);
  check('C3', 'A／B 類、換版後才核定（主管換版後自己送出）→ 照新規則（第三輪的結果）', [B0[2].st, B0[3].st], ['遲到180分', '遲到198分(認定)']);
  // 用真的常數：核定時間＝換版前 1 秒／剛好換版時間／讀不到；最後一列是系統重算列時看它前面那筆主管核定列
  const rowAt = (st, at, mgr) => [RA.date, 'CF15', '測試甲', '09:00-12:00,13:00-18:00', 8, st, mgr || '值班主管', at, '', ''];
  const recAt = (rows) => {
    const c = { date: RA.date, brk: RA.brk, punches: [{ in: '12:00', out: '18:00' }], reqs: [], periods: RA.periods };
    const m = env(c, { now: '2026-11-28T05:00:00', approved: rows });
    m.sb.recheckPendingApprovalStatuses();
    return m.approved().slice(-1)[0][5];
  };
  const { iso } = require('./helpers/gs-sandbox');
  check('C4', '核定時間＝換版時間前 1 秒 → 照舊判法（主線）', recAt([rowAt('遲到180分、下班忘刷卡', iso(cutMs - 1000))]), '第一段上班無打卡、第一段下班無打卡');
  check('C5', '核定時間＝剛好換版時間 → 照新規則', recAt([rowAt('遲到180分、下班忘刷卡', CUTOVER)]), '遲到180分');
  check('C6', '核定時間讀不到（空白、亂碼）→ 照舊判法（保守）', [recAt([rowAt('遲到180分、下班忘刷卡', '')]), recAt([rowAt('遲到180分、下班忘刷卡', '不是時間')])], ['第一段上班無打卡、第一段下班無打卡', '第一段上班無打卡、第一段下班無打卡']);
  check('C7', '換版前主管核定、換版後系統重算寫過一列（最後一列是系統重算列）→ 看主管核定那筆＝照舊判法',
    recAt([rowAt('遲到180分、上班中', iso(cutMs - 3600000)), rowAt('遲到180分、下班忘刷卡', iso(cutMs + 3600000), '值班主管（系統重算）')]), '第一段上班無打卡、第一段下班無打卡');
  check('C8', '換版前核定、換版後主管自己重新送出（新的主管核定列）→ 照新規則',
    recAt([rowAt('遲到180分、下班忘刷卡', iso(cutMs - 3600000)), rowAt('遲到180分、下班忘刷卡', iso(cutMs + 3600000))]), '遲到180分');
  check('C9', '測試沒有寫死換版日期（只從 REQ_LATE_LEAD_CUTOVER_ 推）', new RegExp('2026-11-' + '30T01').test(fs.readFileSync(__filename, 'utf8') + fs.readFileSync(path.join(__dirname, 'helpers', 'late-lead-corpus.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'helpers', 'late-lead-flow.js'), 'utf8')), false);
}

console.log('\n════ 七之四、不變式（第六輪，Codex 第三輪；主管選維持範圍）：主線核得了的，新版也核得了 ════');
{
  // Codex 第三輪：08–17 沒填休息、12:30–12:45（休息帶內完整一進一出）、13:11–17:00、事假 13:10–14:10，送主線預填 08–12／13:00–13:10／14:10–17:00
  const k = { date: '2026-12-03', brk: CF15.brk, punches: [{ in: '12:30', out: '12:45' }, { in: '13:11', out: '17:00' }], reqs: [{ kind: 'leave', leave_type: '事假', start: '13:10', end: '14:10', hours: 1 }],
    leaves: [{ type: '事假', hours: 1 }], periods: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '13:10' }, { start: '14:10', end: '17:00' }] };
  const r1 = env(k).sb.handleMgrApprove({ mgr_key: 'MK', date: k.date, emp_id: 'CF15', periods: P(k.periods), leaves: k.leaves, dry_run: true, diff_reason: '上班卡：休息時間就到' });
  check('K1', 'Codex 第三輪：新規則會讓 13:00–13:10 配不到卡、主線判得過 → 這份照主線、核得了（狀態＝主線）', [r1.ok, r1.status_text, r1.late_lead], [true, '遲到270分、早退25分', false]);
  const r2 = env(CF15).sb.handleMgrApprove({ mgr_key: 'MK', date: CF15.date, emp_id: 'CF15', periods: P(CF15.periods), leaves: [], dry_run: true });
  check('K2', '基本情況 12:47–17:00：主線要 2 張忘打卡單、新規則判得過 → 套新規則、遲到 240', [r2.ok, r2.status_text, r2.late_lead], [true, '遲到240分', true]);
  const c4 = CASES.cases.find((c) => c.id === 'L10');
  const r3 = env(c4).sb.handleMgrApprove({ mgr_key: 'MK', date: c4.date, emp_id: 'CF15', periods: P(c4.periods), leaves: [], dry_run: true });
  check('K3', '12:47 只有上班卡、沒有單：新規則、主線都判不過 → 回新規則的訊息（要 1 張，不是主線的 3 張）', [r3.ok, r3.need && r3.need.miss_cards], [false, 1]);
  // 每天重算：同一份照主線核定的列，重算用同一個判斷 → 仍照主線（核定時間在換版後）
  const m = env(k, { now: '2026-12-05T05:00:00', approved: [[k.date, 'CF15', '測試甲', k.periods.map((p) => p.start + '-' + p.end).join(','), 7, '遲到270分、下班忘刷卡', '值班主管', CUTOVER, '', '']] });
  m.sb.recheckPendingApprovalStatuses();
  check('K4', '照主線核定的列（換版後核定）夜裡重算：不變式判斷用現在的打卡與申請再判一次＝照主線（主線重算的結果）', m.approved().slice(-1)[0][5], '遲到270分、早退25分');
}

console.log('\n════ 八、亂數對照：改版前（' + BASE + '）vs 這一版 ════');
{
  if (base) {
    const run = (root) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'late-lead-corpus.js')], { env: Object.assign({}, process.env, { GS_ROOT: root }), encoding: 'utf8', maxBuffer: 256 << 20 }));
    const a = run(base), b = run(ROOT);
    const J = JSON.stringify;
    let nt = 0, t = 0, diffNT = [], mainDiff = [], rec01 = [], recOld = [], recOldBad = [], recOldFilter = 0, idem = [], inv = [], trigOk = 0;
    const FILTER = /該段無打卡|打卡未入帳|第|忘刷卡|上班中/;      // recheckPendingApprovalStatuses 會重算的原狀態
    a.forEach((x, i) => {
      const y = b[i];
      if (J(x.sc) !== J(y.sc)) throw new Error('兩版情境不同 #' + i);
      if (x.stMain !== y.stMain) mainDiff.push(i);
      if (J(x.rec.slice(0, 2)) !== J(y.rec.slice(0, 2))) rec01.push(i);
      if (x.rec[2] !== y.rec[2]) {
        recOld.push(i);
        if (!y.trig || /第一段上班無打卡|打卡未入帳/.test(x.stMain)) recOldBad.push(i);
        if (FILTER.test(x.stMain)) recOldFilter++;
      }
      if (!y.trig) { nt++; if (J(x.dry) !== J(y.dry) || x.st !== y.st || x.rec[3] !== y.rec[3]) diffNT.push(i); }
      else {
        t++;
        if (y.rec[3] !== y.st) idem.push(i);
        const v = y.inv;
        if (v.newLate !== v.leadMin + v.restLate || v.lateNotes !== Math.max(1, v.restLateNotes) || v.hasFirst) inv.push(i);
        if (y.dry.ok) trigOk++;
      }
    });
    show('X1', '情境數：不觸發 / 觸發 / 觸發且只檢查過', [nt, t, trigOk]);
    check('X2', '不觸發的情境至少 500 組、觸發的至少 100 組（語料有涵蓋到）', [nt >= 500, t >= 100], [true, true]);
    check('X3', '不觸發的情境：只檢查回應（擋不擋、張數、分鐘、狀態）、核定狀態、夜裡重算 與改版前逐筆相同', diffNT.slice(0, 5), []);
    check('X4', '不帶 lateLead 的核定狀態：全部情境（含觸發的）與改版前逐字相同', mainDiff.slice(0, 5), []);
    check('X5', '夜裡重算「第一段上班無打卡…」「打卡未入帳，主管補登」：全部情境與改版前相同（一筆都不改判）', rec01.slice(0, 5), []);
    check('X6', '觸發的情境：夜裡重算這一版自己寫的狀態 → 不變', idem.slice(0, 5), []);
    check('X7', '觸發的情境：遲到分鐘＝前導段＋其餘段的遲到、沒有多一筆遲到、沒有「第一段」', inv.slice(0, 5), []);
    check('X8', '舊版會寫的狀態（換版前用舊程式核定的列）拿給新版夜裡重算：全部情境跟改版前的重算逐字相同（含休息中打卡被併成一塊那類）', recOld.slice(0, 5), []);
    const recOldAfter = []; a.forEach((x, i) => { if (x.rec[2] !== b[i].rec[4]) recOldAfter.push(i); });
    check('X8b', '（換版時間設錯的安全網）舊版會寫的狀態、核定時間卻在換版後：照第三輪那套也跟改版前的重算逐字相同', recOldAfter.slice(0, 5), []);
    show('X9', '（對照）上一項不同的筆數／其中觸發又沒有「第一段、未入帳」的', [recOld.length, recOldBad.length, recOldFilter]);
  }
}

console.log('\n════ 八之二、亂數流程對照（2026-11-26 第三輪）：核定當下有已核准忘打卡單／主管認定／兩者都有／都沒有 × 核定後才補卡 → 05:00 重算 ════');
if (base) {
  // 這一版的核定都當成換版後（cut: 'after'）；主線那份同一組情境（主線不看換版時間）
  const corpusOf = (cut) => JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(__dirname, 'helpers', 'late-lead-flow.js')) + ').corpus(Number(process.env.LATE_FLOW_N) || 3000, Number(process.env.LATE_FLOW_SEED) || 20261126)))'], { encoding: 'utf8', maxBuffer: 256 << 20 })).map((sc) => Object.assign(sc, { cut }));
  const a = flowRun(base, corpusOf('after')), b = flowRun(ROOT, corpusOf('after'));
  const FILTER = /該段無打卡|打卡未入帳|第|忘刷卡|上班中/;      // recheckPendingApprovalStatuses 會重算的原狀態
  const J = JSON.stringify;
  const cnt = { nt: 0, ntOk: 0, t: 0, tOk: 0, cls: {} }, y1 = [], y2 = [];
  b.forEach((y, i) => {
    const x = a[i];
    if (J(x.sc) !== J(y.sc)) throw new Error('兩版流程情境不同 #' + i);
    if (y.ap.ok) cnt.cls[y.sc.cls] = (cnt.cls[y.sc.cls] || 0) + 1;
    // 第六輪：核定當下的選擇（含不變式 reqLateLeadKeep_）＝y.trig；重算時的選擇用現在的打卡與申請再判一次＝y.trigNow（＝主管現在重新核定會得到的選擇）。
    //   核定時不套的：核定回應＝主線；重算時也不套的：重算後的狀態＝主線。重算時會套的（例 人還在上班時核定、之後打了下班卡）：重算後＝現在重新核定的狀態
    if (!y.trig) { cnt.nt++; if (y.ap.ok) cnt.ntOk++; if (J(x.ap) !== J(y.ap) || (!y.trigNow && y.ap.ok && (x.st !== y.st || x.fixed !== y.fixed))) y1.push(i); }
    else { cnt.t++; if (y.ap.ok) cnt.tOk++; }
    // 重算後只能是兩種之一：主管現在重新核定會得到的狀態（fresh），或核定當下照主線的那一列照主線重算（＝主線重算的結果）；沒進重算名單的維持原狀
    if (y.ap.ok && !(y.st === y.fresh || (y.st === y.ap.st && !FILTER.test(y.ap.st)) || (!y.trig && y.st === x.st))) y2.push(i);
    if (y.ap.ok && y.trig !== y.trigNow) cnt.flip = (cnt.flip || 0) + 1;
  });
  show('Y0', '流程數：核定不套新規則（含被擋）／其中核定成功／核定套新規則／其中核定成功；核定成功的各類（none 都沒有、form 忘打卡單、manual 主管認定、both 兩者）', [cnt.nt, cnt.ntOk, cnt.t, cnt.tOk, cnt.cls]);
  check('Y1a', '三類都有涵蓋到（核定成功的 form、manual、both 各至少 50 組；不套的成功至少 300、套的成功至少 100）',
    [['form', 'manual', 'both'].every((k) => (cnt.cls[k] || 0) >= 50), cnt.ntOk >= 300, cnt.tOk >= 100], [true, true, true]);
  check('Y1', '核定當下不套新規則的（忘打卡單、生效日前、不是那種打卡、新規則會被擋而主線不會…）：核定回應＝主線；重算時也不套的，05:00 重算後的狀態、改了幾筆＝主線', y1.slice(0, 5).map((i) => [i, a[i].st, b[i].st]), []);
  check('Y2', '05:00 重算後＝主管現在重新核定的狀態，或核定當下照主線的列＝主線重算的結果（沒進重算名單的維持原狀）', y2.slice(0, 5).map((i) => [i, b[i].ap.st, b[i].st, b[i].fresh]), []);
  // 換版當下：主線（舊程式）核定、日期在生效日以後的列，拿給這一版夜裡重算。
  // 已知例外（未修，回報大腦：靠換版時間解）：核定時還在上班（「上班中」）而且「主管填了遲到」或「第一張卡剛好是休息開始那一分鐘」——舊程式寫的狀態跟新規則一字不差，又沒有單可看。
  const okRows = a.filter((x) => x.ap.ok);
  // Y3：換版前用舊程式核定的列（核定時間早於換版時間）→ 這一版夜裡重算一律照舊判法＝主線，要 0 差異（第三輪之二；第三輪是 17 筆）
  const c = flowRun(ROOT, okRows.map((x) => Object.assign({}, x.sc, { st0: x.ap.st, cut: 'before' })));
  const diff = []; c.forEach((y, k) => { if (y.st !== okRows[k].st || y.fixed !== okRows[k].fixed) diff.push(k); });
  show('Y3', '（換版前核定）舊程式核定的列筆數（日期都在生效日以後或 10 月）／其中核定時還在上班的／主管填遲到的', [okRows.length, okRows.filter((x) => /上班中/.test(x.ap.st)).length, okRows.filter((x) => x.sc.late_min !== '').length]);
  check('Y3b', '（換版前核定）舊程式核定的列拿給這一版重算：跟主線重算逐筆相同（狀態、改了幾筆）', diff.slice(0, 5).map((k) => [okRows[k].sc, okRows[k].ap.st, okRows[k].st, c[k].st]), []);
  // Y3c：同一批舊程式狀態、但核定時間被當成換版後（換版時間設錯才會發生）＝第三輪的做法：只剩兩類已知例外
  const c2 = flowRun(ROOT, okRows.map((x) => Object.assign({}, x.sc, { st0: x.ap.st, cut: 'after' })));
  const known = (x) => /上班中/.test(x.ap.st) && (x.sc.late_min !== '' || (x.sc.brk && x.sc.before[0][0] === x.sc.brk.start));
  const diff2 = [], unknown = [];
  c2.forEach((y, k) => { if (y.st !== okRows[k].st) { diff2.push(k); if (!known(okRows[k])) unknown.push(k); } });
  show('Y3c', '（換版時間設錯的對照）同一批當成換版後核定：跟主線不同的筆數／其中屬已知例外的', [diff2.length, diff2.length - unknown.length]);
  check('Y3d', '（換版時間設錯的對照）跟主線不同的全部屬已知例外（上班中核定＋主管填遲到，或 12:00 整到）', unknown.slice(0, 5).map((k) => [okRows[k].sc, okRows[k].ap.st, okRows[k].st, c2[k].st]), []);
}
if (base) fs.rmSync(base, { recursive: true, force: true });

console.log('\n════ 十、到達時間逐點（共用案例檔 grid）：班表寫一段或兩段 × 打卡端，結果逐點相同（驗收第 2 項） ════');
{
  const G = CASES.grid;
  let bad = [], n = 0;
  for (const pt of G.points) {
    const res = G.plans.map((plan) => {
      const c = { date: G.date, brk: G.brk, punches: [{ in: pt.t, out: G.out }], reqs: [], leaves: [], periods: G.periods };
      const extra = { dry_run: true, mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: plan, sched_ft: false, sched_support: false };
      const r = approve(env(c), c, extra), so = statusOf(env(c), c);
      const r2 = pt.need_reason ? approve(env(c), c, Object.assign({ diff_reason: '上班卡：休息時間就到' }, extra)) : r;
      return JSON.stringify({ ok: r.ok, error: r.error, status: so.status, lead: so.lead, ok2: r2.ok, st2: r2.status });
    });
    n++;
    const want = JSON.stringify({ ok: !pt.need_reason, error: pt.need_reason ? 'need_diff_reason' : '', status: '遲到' + pt.late + '分', lead: true, ok2: true, st2: '遲到' + pt.late + '分' });
    if (res[0] !== res[1] || res[0] !== want) bad.push(pt.t + ' ' + res.join(' | '));
  }
  check('G1', '12:00–13:10 每 5 分 ' + n + ' 點：兩種班表寫法打卡端結果相同、遲到＝案例、12:30 以前照 11/16 規則要選原因（選了就過）', bad, []);
}

console.log('\n════ 十之二、休息中打了短短一段再回來（共用案例檔 grid_brk_punch；2026-11-26 第三輪、Codex 第一輪擋項 2）：班表三種寫法 × 打卡端 ════');
{
  const G = CASES.grid_brk_punch;
  const bad = [];
  for (const pt of G.points) {
    const res = G.plans.map((plan) => {
      const c = { date: G.date, brk: G.brk, punches: [{ in: pt.seg[0], out: pt.seg[1] }, { in: pt.back, out: G.out }], reqs: [], leaves: [], periods: G.periods };
      const extra = { dry_run: true, mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: plan, sched_ft: false, sched_support: false };
      const r = approve(env(c), c, extra), so = statusOf(env(c), c);
      const r2 = approve(env(c), c, Object.assign({ diff_reason: '上班卡：休息時間就到' }, extra));
      return JSON.stringify({ ok: r.ok, error: r.error, miss: r.miss, status: so.status, lead: so.lead, ok2: r2.ok, st2: r2.status, h2: r2.hours });
    });
    const want = JSON.stringify({ ok: !pt.need_reason, error: pt.need_reason ? 'need_diff_reason' : '', miss: 0, status: pt.status, lead: true, ok2: true, st2: pt.status, h2: 8 });
    if (res.some((x) => x !== want)) bad.push(pt.seg.join('–') + ' 回 ' + pt.back + ' ' + res.join(' | '));
  }
  check('G2', G.points.length + ' 點 × 班表一段休 60／一段沒填休息／兩段：打卡端核定狀態、遲到、缺卡張數、要不要選原因、選了原因後 8 小時＝案例（營運系統那邊同一份驗預填）', bad, []);
  check('G3', '共用案例檔 sha256（mala-store-ops test/server/late-lead.test.js 釘同一個值；兩份逐字相同）',
    require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures', 'late-lead-cases-v1.json'))).digest('hex'),
    '2ecfdbea7df4e821c8c7748d65662920626e51768ba411a4524a0ad121551e76');
}

console.log('\n════ 九、薪資：遲到 240 分流進薪資、計時不多發不重複扣 ════');
{
  const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), PG = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
  const sb = { console, SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + PG, sb);
  vm.runInContext('payClockRead=function(s,sh){return (globalThis.__C[sh]||[]);};', sb);
  sb.__C = { roster: [{ emp_id: 'CF15', name: '測試甲', active: true, key: 'k' }], leave: [],
    events: [{ emp_id: 'CF15', ts: '2026-12-03T12:47:00+08:00', type: 'in', status: 'ok' }, { emp_id: 'CF15', ts: '2026-12-03T17:00:00+08:00', type: 'out', status: 'ok' }],
    approved: [{ date: '2026-12-03', name: '測試甲', emp_id: 'CF15', approved_hours: 8, status_text: '遲到240分', entered_at: 'x', manager_name: 'M', periods: '08:00-12:00,13:00-17:00' }] };
  const col = vm.runInContext('payCollect', sb)('2026-12', 1, 'CF', [])['CF15'];
  check('PAY1', 'payCollect 讀「遲到240分」→ 遲到 240 分、時數 8', [col.late_min, col.hours], [240, 8]);
  const calc = vm.runInContext('payCalcOne', sb);
  const PT = { emp_id: 'CF15', name: '測試甲', is_full_time: 'false', base: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 0, ot_rate: 0, wage: 200,
    labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2026-11-01', leave_date: '', meal_allow: 0, active: 'true' };
  const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, late_deduct: 'true', late_deduct_from: '2026-10', late_div_days: 30, late_div_hours: 8 };
  const g = (res, k) => { const x = [].concat(res.earn, res.ded).find((i) => i.item_key === k); return x ? x.amount : 0; };
  const res = calc(PT, '2026-12', { hours: 8, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 240 }, cfg, 1);
  check('PAY2', '計時時薪 200、核定 8 小時、遲到 240 分 → 時薪 1,600、遲到不計薪 800（實發這兩項＝800＝4 小時）', [g(res, 'hourly_wage'), g(res, 'late_deduct'), g(res, 'hourly_wage') - g(res, 'late_deduct')], [1600, 800, 800]);
  const res2 = calc(PT, '2026-12', { hours: 4, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 0 }, cfg, 1);
  check('PAY3', '對照：主管手改 13–17（4 小時、沒有遲到）＝800，跟改後一樣', g(res2, 'hourly_wage') - g(res2, 'late_deduct'), 800);
  const res3 = calc(PT, '2026-12', { hours: 8, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, late_min: 240 }, Object.assign({}, cfg, { late_deduct: 'false' }), 1);
  check('PAY4', '⚠ 反證：遲到不計薪沒開 → 會多發成 1,600（所以上線前一定要確認央廚、總部這格）', g(res3, 'hourly_wage') - g(res3, 'late_deduct'), 1600);
}

done();
