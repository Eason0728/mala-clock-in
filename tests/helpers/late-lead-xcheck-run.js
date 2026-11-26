// 上午整段沒到改算遲到（2026-11-26 第四輪）前後端一致性對照的打卡端那半：營運系統預填出來的時段送進這一版（GS_ROOT）的核定檢查。
// 不是測試本身（run-all 只跑 *.test.js）；tests/late-lead-xcheck.test.js 呼叫。輸入 LATE_XCHECK_IN＝JSON 檔（陣列），輸出 stdout JSON。
// 每筆：now（送出核定的時刻，沒給＝2026-12-20 10:00）、openAt（第八輪：卡片開啟時刻＝營運系統算預填的「現在」；有給就先在這個時刻跑一次檢查，回 okOpen）、date、brk {start,end}、punches [{in,out}]、reqs [已核准申請]、leaves [{type,hours}]（核定時一起登記的假）、periods [{start,end}]（營運系統預填）、late_min、sched_spans（班表）
// 回：ok、error、rules（被擋的規則）、st（核定狀態；被擋的日子也照核定算法直接算）、trig（這一版核定會不會套新規則；改版前＝null）、
//   okOpen（開卡時刻那次檢查過不過；沒給 openAt＝null）、wOpen／wNow（開卡／送出時刻同仁是不是還在上班：最後一張是沒配對的上班卡、16 小時內）。只用假資料、不連網路。
'use strict';
const fs = require('fs');
const { make, T } = require('./gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };

function one(c) {
  const D = c.date, evs = [];
  (c.punches || []).forEach((s) => { if (s.in) evs.push([D + 'T' + s.in + ':00', 'E01', 'in']); if (s.out) evs.push([D + 'T' + s.out + ':00', 'E01', 'out']); });
  const m = make({ now: T(c.now || '2026-12-20T10:00:00'),      // now：核定時刻（第七輪：可以落在上班中）
    props: { REQ_STRICT_FROM: '2026-11-01', REQ_BIND_FROM: '2026-10-01' },
    config: { NO_PUNCH_BREAK_START: c.brk.start, NO_PUNCH_BREAK_END: c.brk.end }, self: { roster: [ME], events: evs } });
  const sh = m.sb.reqSheet_(m.self, true);
  (c.reqs || []).forEach((r, k) => {
    const row = Object.assign({ id: 'R' + k, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved', decided_at: D + 'T09:00:00+08:00' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  const sb = m.sb;
  const body = () => ({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', date: D, emp_id: 'E01', periods: c.periods, leaves: c.leaves || [], late_min: c.late_min == null ? '' : c.late_min,
    sched_day: 'W', sched_spans: c.sched_spans || [], sched_ft: false, sched_support: false, dry_run: true, diff_reason: '測試' });
  const evNow = () => sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const workingAt = (ms) => !!sb.workingInHm_(sb.dayPunchSegments(evNow(), 'E01', D), ms);
  let okOpen = null, wOpen = null;
  if (c.openAt) {      // 第八輪：卡片開啟時刻先檢查一次（＝卡片上的「檢查」結果），再到送出時刻
    m.setNow(T(c.openAt)); wOpen = workingAt(T(c.openAt));
    try { okOpen = !!sb.handleMgrApprove(body()).ok; } catch (e) { okOpen = false; }
    m.setNow(T(c.now || '2026-12-20T10:00:00'));
  }
  const wNow = workingAt(T(c.now || '2026-12-20T10:00:00'));
  let r;
  try {
    r = sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', date: D, emp_id: 'E01', periods: c.periods, leaves: c.leaves || [], late_min: c.late_min == null ? '' : c.late_min,
      sched_day: 'W', sched_spans: c.sched_spans || [], sched_ft: false, sched_support: false, dry_run: true, diff_reason: '測試' });
  } catch (e) { return { ok: false, error: 'throw:' + String(e.message).slice(0, 80) }; }
  // 核定狀態（同 handleMgrApprove：出差、打卡未入帳不套；被擋的日子也算得出來）
  const pms = c.periods.map((p) => { const s = sb.hmToMs(D, p.start); let e = sb.hmToMs(D, p.end); if (e <= s) e += 86400000; return { start: p.start, end: p.end, startMs: s, endMs: e }; });
  const ev = sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const punch = sb.dayPunchSegments(ev, 'E01', D);
  const segs = punch.segments.map((s) => ({ in: s.in, out: s.out, inMs: s.in ? sb.hmToMs(D, s.in) : null, outMs: s.out ? sb.hmToMs(D, s.out) : null }));
  sb.markWorkingSeg_(punch, D, segs);      // 同 handleMgrApprove：還在上班那張卡（第八輪方案 B：上班中＝不套）
  const bw = sb.noPunchBreakWindow(D);
  const hasTrip = (c.leaves || []).some((x) => x.type === '出差');
  const rows = sb.reqRows_(m.self);
  const llSegs = typeof sb.reqLateLeadSegs_ === 'function' ? sb.reqLateLeadSegs_(segs) : segs;      // 第九輪：新規則那條路徑不看上班中（同 handleMgrApprove）
  let trig = typeof sb.reqLateLeadOn_ === 'function' ? (!hasTrip && sb.reqLateLeadOn_(rows, 'E01', D, pms, llSegs, bw)) : null;
  if (trig && typeof sb.reqLateLeadOpen_ === 'function' && sb.reqLateLeadOpen_(segs, sb.lateLeadDayRows_(rows, 'E01', D), D)) trig = false;      // 第九輪：還沒下班＝照主線
  // 第六輪不變式：新規則判不過、主線判得過＝照主線（reqLateLeadKeep_）；核定過了就看回應的 late_lead（含綁單保險換回主線的那種）
  if (trig && typeof sb.reqLateLeadKeep_ === 'function' && !sb.reqLateLeadKeep_(D, pms, llSegs, bw, sb.lateLeadDayRows_(rows, 'E01', D), '')) trig = false;      // 第十輪：遲到欄當空白判（同 handleMgrApprove）
  if (r.ok && typeof r.late_lead === 'boolean') trig = r.late_lead;
  const st = sb.applyManualLate(sb.computeApprovalStatus(pms, trig === true ? llSegs : segs, false, hasTrip, bw, false, trig === true), c.late_min == null ? '' : c.late_min);      // 被擋的日子也算得出來
  return { ok: !!r.ok, error: r.error || '', rules: (r.probs || []).map((p) => p.rule).join(','), st: r.ok ? r.status_text : st, trig, okOpen, wOpen, wNow };
}
if (require.main === module) process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.env.LATE_XCHECK_IN, 'utf8')).map(one)));
module.exports = { one };
