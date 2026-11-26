// 上午整段沒到改算遲到（2026-11-26）的亂數對照語料：同一組亂數情境在 GS_ROOT 那一版跑，印 JSON。
// tests/late-first-block.test.js 用改版前（git show）與這一版各跑一次逐筆比。不是測試本身（run-all 只跑 *.test.js）。
// 只用假資料：工號 E01、假金鑰 MK；不連網路。情境數 LATE_LEAD_N（預設 3000）、種子 LATE_LEAD_SEED（預設 20261126）。
'use strict';
const { make, T } = require('./gs-sandbox');
const N = Number(process.env.LATE_LEAD_N) || 3000;
let seed = Number(process.env.LATE_LEAD_SEED) || 20261126;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };

function scenario() {
  const brk = pick([[720, 780], [720, 780], [840, 900], null]);
  const date = rnd() < 0.3 ? '2026-10-27' : pick(['2026-11-04', '2026-11-25', '2026-12-04']);      // 生效日 2026-11-01（原定 12/1）：10 月＝生效日前
  const S = pick([420, 480, 540, 600]);
  const bs = brk ? brk[0] : 720, be = brk ? brk[1] : 780;
  const E = Math.min(1290, be + pick([180, 240, 300, 360]));
  let per;
  const t = rnd();
  if (t < 0.45) per = [[S, bs], [be, E]];
  else if (t < 0.6) per = [[S, E]];
  else if (t < 0.68) per = [[S, bs - 30], [be + 60, E]];
  else if (t < 0.73) per = [[S, bs], [bs, E]];
  else if (t < 0.83) per = [[S, bs], [be, be + 120], [be + 150, E]];
  else { const a = ri(7, 12) * 60, b = a + ri(2, 5) * 60, c = b + ri(0, 3) * 60, d = Math.min(1320, c + ri(1, 5) * 60); per = c > b ? [[a, b], [c, d]] : [[a, d]]; }
  per = per.filter((p) => p[1] > p[0]);
  // 打卡：一半的情境第一張卡落在休息帶前後（容易觸發）
  const segs = [];
  const nSeg = pick([0, 1, 1, 1, 2, 2, 3]);
  let cur = rnd() < 0.5 ? ri(bs - 30, Math.min(E - 20, be + 200)) : ri(360, 900);
  for (let i = 0; i < nSeg && cur < 1380; i++) {
    const a = cur, b = Math.min(1410, a + ri(10, 480));
    const r = rnd();
    segs.push(r < 0.1 ? [null, b] : r < 0.2 ? [a, null] : [a, b]);
    cur = b + ri(5, 120);
  }
  const reqs = [], leaves = [];
  const q = rnd();
  if (q < 0.08) reqs.push({ kind: 'miss', miss_type: 'both', start: hm(per[0][0]), end: hm(per[0][1]) });
  else if (q < 0.13) reqs.push({ kind: 'miss', miss_type: 'in', start: hm(per[0][0]), end: '' });
  else if (q < 0.18) reqs.push({ kind: 'miss', miss_type: 'out', start: '', end: hm(per[per.length - 1][1]) });
  else if (q < 0.26 && per.length > 1) { reqs.push({ kind: 'leave', leave_type: '事假', start: hm(per[0][0]), end: hm(per[0][1]), hours: (per[0][1] - per[0][0]) / 60 }); leaves.push({ type: '事假', hours: (per[0][1] - per[0][0]) / 60 }); }
  else if (q < 0.32) reqs.push({ kind: 'ot', start: hm(E), end: hm(E + 60), hours: 1 });
  const lm = rnd();
  const late_min = lm < 0.8 ? '' : lm < 0.9 ? '0' : String(pick([30, 240, 285]));
  const usePer = rnd() < 0.15 && per.length > 1 ? per.slice(1) : per;      // 主管只核後面幾段（繞法）
  return { brk, date, per: usePer, segs, reqs, leaves, late_min };
}

// 每天重算的原狀態：這兩種不管新舊、什麼情境都必須重算成一樣（用忘打卡單核的、打卡未入帳時核的）；另外再拿「改版前會寫的狀態」與「這一版會寫的狀態」各重算一次
const ST0 = ['第一段上班無打卡、第一段下班無打卡', '打卡未入帳，主管補登'];
const out = [];
for (let i = 0; i < N; i++) {
  const sc = scenario();
  const D = sc.date, D1 = D.slice(0, 8) + String(Number(D.slice(8)) + 1).padStart(2, '0');
  const events = [];
  sc.segs.forEach((s) => {
    const ts = (m) => (m >= 1440 ? D1 + 'T' + hm(m - 1440) : D + 'T' + hm(m)) + ':00';
    if (s[0] != null) events.push([ts(s[0]), 'E01', 'in']);
    if (s[1] != null) events.push([ts(s[1]), 'E01', 'out']);
  });
  const m = make({ now: T('2026-12-20T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01' },
    config: sc.brk ? { NO_PUNCH_BREAK_START: hm(sc.brk[0]), NO_PUNCH_BREAK_END: hm(sc.brk[1]) } : {},
    self: { roster: [ME], events } });
  const sh = m.sb.reqSheet_(m.self, true);
  sc.reqs.forEach((r, k) => {
    const row = Object.assign({ id: 'R' + k, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  const periods = sc.per.map((p) => ({ start: hm(p[0]), end: hm(p[1]) }));
  let dry;
  try {
    const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods, leaves: sc.leaves, late_min: sc.late_min, dry_run: true, diff_reason: '測試' });
    dry = { ok: r.ok, error: r.error || '', h: r.approved_hours, st: r.status_text || '', need: r.need || null, rules: (r.probs || []).map((p) => p.rule) };
  } catch (e) { dry = { throw: String(e.message) }; }
  // 直接算核定狀態（被擋的日子也看得到狀態）＋這一版的觸發判斷
  const sb = m.sb;
  const pms = periods.map((p) => { const s = sb.hmToMs(D, p.start); let e = sb.hmToMs(D, p.end); if (e <= s) e += 86400000; return { start: p.start, end: p.end, startMs: s, endMs: e }; });
  const evRows = sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const punch = sb.dayPunchSegments(evRows, 'E01', D);
  const segMs = punch.segments.map((s) => ({ in: s.in, out: s.out, inMs: s.in ? sb.hmToMs(D, s.in) : null, outMs: s.out ? sb.hmToMs(s.cross ? D1 : D, s.out) : null }));
  const bw = sb.noPunchBreakWindow(D);
  const hasNew = typeof sb.reqLateLeadOn_ === 'function';
  const trig = hasNew ? sb.reqLateLeadOn_(sb.reqRows_(m.self), 'E01', D, pms, segMs, bw) : null;
  const st = sb.computeApprovalStatus(pms, segMs, false, false, bw, false, trig === true);
  let inv = null;
  if (trig) {
    const ll = sb.lateLeadOf_(pms, segMs, bw);
    const restSt = sb.computeApprovalStatus(ll.rest, segMs, false, false, bw, false);
    const sum = (x) => String(x).split('、').reduce((a, n) => { const g = /^遲到(\d+)分$/.exec(n); return a + (g ? Number(g[1]) : 0); }, 0);
    const nLate = (x) => String(x).split('、').filter((n) => /^遲到/.test(n)).length;
    inv = { leadMin: ll.leadMin, restLate: sum(restSt), newLate: sum(st), lateNotes: nLate(st), restLateNotes: nLate(restSt), hasFirst: /第一段/.test(st) };
  }
  // 每天重算：同一筆核定換幾種原狀態
  const rosterRows = sb.readSheetAsObjects(m.self.getSheetByName('roster')).rows;
  const stMain = sb.computeApprovalStatus(pms, segMs, false, false, bw, false);      // 不帶 lateLead＝改版前的判法（新版也要跟改版前逐字相同）
  const rec = ST0.concat([stMain, st]).map((s0) => {
    try { return sb.recomputeApprovalStatusOf(m.self, evRows, rosterRows, D, 'E01', { periods: periods.map((p) => p.start + '-' + p.end).join(','), status_text: s0, name: '測試一' }).newStatusText; }
    catch (e) { return 'throw:' + e.message; }
  });
  out.push({ i, sc, dry, st, stMain, trig, inv, rec });
}
process.stdout.write(JSON.stringify(out));
