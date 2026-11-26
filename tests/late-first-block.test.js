/* 上午整段沒到改算遲到（2026-11-26 主管「央廚這類『休息前整段沒到』改判遲到。都照推薦」；設計 _brain_out/late-first-block/design.md、確認頁 10 題全取推薦）。
 *
 * 規則白話：被不打卡休息帶（央廚 12–13、總部 14–15）切開的班，休息帶前面那段整段沒有打卡、第一張卡是休息帶當中或之後才打的上班卡 →
 *   不再當缺卡（要 2 張忘打卡單），改記遲到；遲到分鐘＝核定時段裡、第一張上班卡之前的分鐘數（休息不算）。核定時數照時段，薪資照既有「遲到不計薪」扣。
 *   2026-12-01 起的日子才套（寫死、沒有開關）；前導段有已核准忘打卡單、出差、打卡未入帳＝照舊；已核定的不回頭改（含每天 05:00 重算）。
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
const ME = { emp_id: 'CF15', name: '測試甲', key: 'K1', device_id: 'D1', active: 'TRUE' };
const P = (list) => list.map((p) => ({ start: p.start, end: p.end }));
const lateSum = (st) => String(st || '').split('、').reduce((a, n) => { const g = /^遲到(\d+)分/.exec(n); return a + (g ? Number(g[1]) : 0); }, 0);

function env(c, opt) {
  opt = opt || {};
  const D = c.date, evs = [];
  (c.punches || []).forEach((s) => { if (s.in) evs.push([D + 'T' + s.in + ':00', 'CF15', 'in']); if (s.out) evs.push([D + 'T' + s.out + ':00', 'CF15', 'out']); });
  (opt.extraEvents || []).forEach((e) => evs.push(e));
  const m = make({ now: T(opt.now || '2026-12-10T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01' },
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
  const lead = sb.reqLateLeadOn_(sb.reqRows_(m.self), 'CF15', D, pms, segs, bw);
  return { lead, status: sb.computeApprovalStatus(pms, segs, false, false, bw, false, lead) };
}

console.log('════ 一、共用案例檔（營運系統預填的時段送打卡端） ════');
check('F00', '案例檔版本 1、至少 19 個案例', [CASES.version, CASES.cases.length >= 19], [1, true]);
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
r = approve(env(Object.assign({}, CF15, { date: '2026-11-25' })), Object.assign({}, CF15, { date: '2026-11-25' }), { dry_run: true, late_min: '240' });
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
  check('E15', '生效日 2026-12-01（11/30 不套、12/1 起套）', [sb.reqLateLeadDay_('2026-11-30'), sb.reqLateLeadDay_('2026-12-01'), sb.reqLateLeadDay_('bad')], [false, true, false]);
  check('E16', '沒有指令碼屬性開關（寫死日期，mini 看得到同一個值）', /reqProp_\(['"]REQ_LATE_LEAD/.test(fs.readFileSync(path.join(ROOT, 'apps-script', 'Requests.gs'), 'utf8')), false);
}

console.log('\n════ 七、每天 05:00 重算（第 5 題 A：已核定的一筆都不動） ════');
{
  const rec = (c, st, now, extraEvents) => {
    const m = env(c, { now, extraEvents, approved: [[c.date, 'CF15', '測試甲', c.periods.map((p) => p.start + '-' + p.end).join(','), 8, st, '值班主管', c.date + 'T20:00:00+08:00', '', '']] });
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
  const c11 = Object.assign({}, CF15, { date: '2026-11-25' });
  check('R5', '生效日前（11/25）「第一段上班無打卡、第一段下班無打卡」→ 不改（跟改之前一樣）', rec(c11, '第一段上班無打卡、第一段下班無打卡', '2026-11-27T05:00:00'), { fixed: 0, last: '第一段上班無打卡、第一段下班無打卡' });
  check('R6', '主管認定的遲到「遲到240分(認定)、上班中」→ 認定保留、改「下班忘刷卡」', rec(c4, '遲到240分(認定)、上班中', '2026-12-05T05:00:00'), { fixed: 1, last: '下班忘刷卡、遲到240分(認定)' });
  // 亂數對照查到的：前導段有已核准忘打卡單、單張上班卡被舊判法併進同一塊（09–12、13–18、12:18 上班沒下班）→ 原狀態沒有「第一段」
  const cB2 = { date: '2026-12-03', brk: CF15.brk, punches: [{ in: '12:18', out: null }], reqs: [{ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }], periods: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }], leaves: [] };
  const so = statusOf(env(cB2), cB2);
  check('R7a', '前導段有忘打卡單（上班 09:00）→ 核定不套，狀態照舊判法', so, { lead: false, status: '遲到198分、下班忘刷卡' });
  check('R7b', '同一筆夜裡重算 → 不改（重算也看忘打卡單）', rec(cB2, '遲到198分、下班忘刷卡', '2026-12-05T05:00:00'), { fixed: 0, last: '遲到198分、下班忘刷卡' });
}

console.log('\n════ 八、亂數對照：改版前（' + (process.env.LATE_LEAD_BASE || 'f21cc25') + '）vs 這一版 ════');
{
  const BASE = process.env.LATE_LEAD_BASE || 'f21cc25';
  let base = null;
  try {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'late-lead-base-'));
    fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
    ['Code.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));
  } catch (e) { base = null; show('X0', '跳過：拿不到改版前的版本 ' + BASE, String(e.message).split('\n')[0]); }
  if (base) {
    const run = (root) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'late-lead-corpus.js')], { env: Object.assign({}, process.env, { GS_ROOT: root }), encoding: 'utf8', maxBuffer: 256 << 20 }));
    const a = run(base), b = run(ROOT);
    fs.rmSync(base, { recursive: true, force: true });
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
    check('X8', '舊版核定的狀態被新版重算改判：只會發生在「觸發、原狀態沒有第一段／未入帳」（舊判法把休息中的卡併進同一塊）', recOldBad.slice(0, 5), []);
    show('X9', '上一項的筆數（全部／會進每晚重算名單的）——只有換版前用舊程式核定、日期在 12/1 以後的列會碰到，上線包要先唯讀列出', [recOld.length, recOldFilter]);
  }
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
