// 上午整段沒到改算遲到（2026-11-26 第四輪）前後端一致性對照的打卡端那半：營運系統預填出來的時段送進這一版（GS_ROOT）的核定檢查。
// 不是測試本身（run-all 只跑 *.test.js）；tests/late-lead-xcheck.test.js 呼叫。輸入 LATE_XCHECK_IN＝JSON 檔（陣列），輸出 stdout JSON。
// 每筆：date、brk {start,end}、punches [{in,out}]、reqs [已核准申請]、leaves [{type,hours}]（核定時一起登記的假）、periods [{start,end}]（營運系統預填）、late_min、sched_spans（班表）
// 回：ok、error、rules（被擋的規則）、st（核定狀態；被擋的日子也照核定算法直接算）、trig（這一版核定會不會套新規則；改版前＝null）。只用假資料、不連網路。
'use strict';
const fs = require('fs');
const { make, T } = require('./gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };

function one(c) {
  const D = c.date, evs = [];
  (c.punches || []).forEach((s) => { if (s.in) evs.push([D + 'T' + s.in + ':00', 'E01', 'in']); if (s.out) evs.push([D + 'T' + s.out + ':00', 'E01', 'out']); });
  const m = make({ now: T('2026-12-20T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01', REQ_BIND_FROM: '2026-10-01' },
    config: { NO_PUNCH_BREAK_START: c.brk.start, NO_PUNCH_BREAK_END: c.brk.end }, self: { roster: [ME], events: evs } });
  const sh = m.sb.reqSheet_(m.self, true);
  (c.reqs || []).forEach((r, k) => {
    const row = Object.assign({ id: 'R' + k, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved', decided_at: D + 'T09:00:00+08:00' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  const sb = m.sb;
  let r;
  try {
    r = sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', date: D, emp_id: 'E01', periods: c.periods, leaves: c.leaves || [], late_min: c.late_min == null ? '' : c.late_min,
      sched_day: 'W', sched_spans: c.sched_spans || [], sched_ft: false, sched_support: false, dry_run: true, diff_reason: '測試' });
  } catch (e) { return { ok: false, error: 'throw:' + String(e.message).slice(0, 80) }; }
  // 核定狀態（同 handleMgrApprove：出差、打卡未入帳不套；被擋的日子也算得出來）
  const pms = c.periods.map((p) => { const s = sb.hmToMs(D, p.start); let e = sb.hmToMs(D, p.end); if (e <= s) e += 86400000; return { start: p.start, end: p.end, startMs: s, endMs: e }; });
  const ev = sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const segs = sb.dayPunchSegments(ev, 'E01', D).segments.map((s) => ({ in: s.in, out: s.out, inMs: s.in ? sb.hmToMs(D, s.in) : null, outMs: s.out ? sb.hmToMs(D, s.out) : null }));
  const bw = sb.noPunchBreakWindow(D);
  const hasTrip = (c.leaves || []).some((x) => x.type === '出差');
  const trig = typeof sb.reqLateLeadOn_ === 'function' ? (!hasTrip && sb.reqLateLeadOn_(sb.reqRows_(m.self), 'E01', D, pms, segs, bw)) : null;
  const st = sb.applyManualLate(sb.computeApprovalStatus(pms, segs, false, hasTrip, bw, false, trig === true), c.late_min == null ? '' : c.late_min);
  return { ok: !!r.ok, error: r.error || '', rules: (r.probs || []).map((p) => p.rule).join(','), st: r.ok ? r.status_text : st, trig };
}
if (require.main === module) process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.env.LATE_XCHECK_IN, 'utf8')).map(one)));
module.exports = { one };
