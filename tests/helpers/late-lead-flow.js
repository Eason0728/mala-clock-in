// 上午整段沒到改算遲到（2026-11-26 第三輪，Codex 第一輪擋項 1）：「核定當下 → 之後補到卡 → 05:00 重算」整段流程，
// 同一組情境在 GS_ROOT 那一版跑（tests/late-first-block.test.js 拿改版前 f21cc25 與這一版各跑一次逐筆比）。不是測試本身（run-all 只跑 *.test.js）。
// 輸入：環境變數 LATE_FLOW_IN＝情境 JSON 檔路徑（陣列）；沒給就跑亂數流程語料（LATE_FLOW_N 組，預設 3000；種子 LATE_FLOW_SEED，預設 20261126）。
// 輸出：stdout 印 JSON 陣列。只用假資料（工號 E01、假金鑰 MK），不連網路。
// 情境欄位：date、brk {start,end}|null、periods [{start,end}]、reqs [申請單]、late_min、
//   before [[HH:MM, 'in'|'out']]（核定前就有的卡）、approveAt（核定時間 'YYYY-MM-DDTHH:MM:SS'）、
//   st0（有給＝不跑核定，直接放一列舊程式寫的狀態，模擬換版前核定的列）、cut（'after'｜'before'：核定在換版時間之後／之前，見 flow 開頭）、after [[HH:MM, 'in'|'out']]（核定後才打／才入帳的卡）、recheckAt（重算時間）、voidAfter（核定後把申請單都作廢，可省略）
'use strict';
const fs = require('fs');
const { make, T, iso } = require('./gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const nextDay = (d) => { const x = new Date(Date.parse(d + 'T00:00:00Z') + 86400000); return x.toISOString().slice(0, 10); };

function flow(sc) {
  const D = sc.date, D1 = nextDay(D);
  const ts = (hm) => { const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)); return (m >= 1440 ? D1 + 'T' + String(Math.floor((m - 1440) / 60)).padStart(2, '0') + hm.slice(2) : D + 'T' + hm) + ':00'; };
  const m = make({ now: T(sc.approveAt), props: { REQ_STRICT_FROM: '2026-11-01' },
    config: sc.brk ? { NO_PUNCH_BREAK_START: sc.brk.start, NO_PUNCH_BREAK_END: sc.brk.end } : {},
    self: { roster: [ME], events: (sc.before || []).map((e) => [ts(e[0]), 'E01', e[1]]) } });
  // 換版時間（第三輪之二）：cut 'after'＝這次核定在換版後（沙盒的換版時間設成核定前一分鐘）、'before'＝在換版前（設成核定後一分鐘）；沒給＝照程式的常數
  if (sc.cut === 'after' || sc.cut === 'before') m.run('REQ_LATE_LEAD_CUTOVER_ = ' + JSON.stringify(iso(T(sc.approveAt) + (sc.cut === 'after' ? -60000 : 60000))) + ';');
  const sh = m.sb.reqSheet_(m.self, true);
  (sc.reqs || []).forEach((r, k) => {
    const row = Object.assign({ id: 'R' + k, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved', decided_at: D + 'T09:00:00+08:00' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  const trig = statusNow(m, sc, false).trig;
  let ap;
  if (sc.st0 != null) {
    // 換版前用舊程式核定的列（st0＝舊程式寫的狀態）：不跑核定，直接放一列進 approved，看這一版夜裡怎麼重算
    m.self.sh.approved.values.push([D, 'E01', '測試一', sc.periods.map((p) => p.start + '-' + p.end).join(','), 0, sc.st0, '值班主管', sc.approveAt + '+08:00', '', '測試']);
    ap = { ok: true, error: '', st: sc.st0, rules: '' };
  } else try {
    const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: sc.periods, leaves: sc.leaves || [], late_min: sc.late_min == null ? '' : sc.late_min, diff_reason: '測試' });
    ap = { ok: !!r.ok, error: r.error || '', st: r.status_text || '', rules: (r.probs || []).map((p) => p.rule).join(',') };
  } catch (e) { ap = { ok: false, error: 'throw:' + String(e.message) }; }
  if (!ap.ok) return { ap, trig };
  // 核定後才打的卡（同一天的成功卡，直接加進 events，跟 gs-sandbox evRow 同格式）
  (sc.after || []).forEach((e) => { m.self.sh.events.values.push([ts(e[0]) + '+08:00', 'E01', e[1], 24.7840945, 121.0157448, 5, true, 'D1', true, 'ok', 10]); });
  if (sc.voidAfter) {
    const si = m.sb.reqHeads_(sh).indexOf('status');
    sh.values.slice(1).forEach((row) => { row[si] = 'voided'; });
  }
  m.setNow(sc.recheckAt);
  let rc;
  try { rc = m.sb.recheckPendingApprovalStatuses(); } catch (e) { return { ap, trig, throw: String(e.message) }; }
  const last = m.approved().slice(-1)[0];
  // 主管現在重新核定會得到的狀態（同一組時段、同一個遲到欄）。第八輪（Codex 第四輪殘餘風險）：走正式核定的 dry_run（含綁單被擋時換回主線的那道保險），
  //   不再自己拼；被擋（重新核定也送不出）時 freshOk＝false，fresh 退回拼出來的狀態（只供對照，不能當「重新核定的結果」）
  const fresh = statusNow(m, sc, true);
  let fr = null;
  try { fr = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: sc.periods, leaves: sc.leaves || [], late_min: sc.late_min == null ? '' : sc.late_min, diff_reason: '測試', dry_run: true }); } catch (e) { fr = null; }
  const freshOk = !!(fr && fr.ok);
  return { ap, trig, fixed: rc.fixed, st: last[5], fresh: freshOk ? fr.status_text : fresh.st, freshOk, trigNow: freshOk && typeof fr.late_lead === 'boolean' ? fr.late_lead : fresh.trig };
}
/** 用沙盒現在的時間與資料算核定狀態（同 handleMgrApprove 的算法，不跑綁單）；trig＝這一版核定會不會套新規則（改版前沒有這個函式＝null） */
function statusNow(m, sc, manual) {
  const sb = m.sb, D = sc.date, D1 = nextDay(D);
  const pms = sc.periods.map((p) => { const s = sb.hmToMs(D, p.start); let e = sb.hmToMs(D, p.end); if (e <= s) e += 86400000; return { start: p.start, end: p.end, startMs: s, endMs: e }; });
  const ev = sb.readSheetAsObjects(m.self.getSheetByName('events')).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const punch = sb.dayPunchSegments(ev, 'E01', D);
  const segs = punch.segments.map((s) => ({ in: s.in, out: s.out, inMs: s.in ? sb.hmToMs(D, s.in) : null, outMs: s.out ? sb.hmToMs(s.cross ? D1 : D, s.out) : null }));
  sb.markWorkingSeg_(punch, D, segs);
  const bw = sb.noPunchBreakWindow(D);
  const rows = sb.reqRows_(m.self);
  let trig = typeof sb.reqLateLeadOn_ === 'function' ? sb.reqLateLeadOn_(rows, 'E01', D, pms, segs, bw) : null;
  // 第六輪不變式：新規則判不過、主線判得過＝照主線（同 handleMgrApprove／每天重算的 reqLateLeadKeep_）
  if (trig && typeof sb.reqLateLeadKeep_ === 'function' && !sb.reqLateLeadKeep_(D, pms, segs, bw, sb.lateLeadDayRows_(rows, 'E01', D), sc.late_min == null ? '' : sc.late_min)) trig = false;
  let st = sb.computeApprovalStatus(pms, segs, false, false, bw, false, trig === true);
  if (manual) st = sb.applyManualLate(st, sc.late_min == null ? '' : sc.late_min);
  return { st, trig };
}

/* 亂數流程語料（第三輪擴充）：核定當下有已核准忘打卡單／有主管認定／兩者都有／都沒有，各約四分之一；
 * 核定時多半還在上班（之後正常打下班卡、或沒打＝16 小時後變下班忘刷卡）、或休息中打了短短一段再回來，少數下班後才核定。 */
function corpus(n, seed) {
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)], ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const hm = (x) => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
  const out = [];
  for (let i = 0; i < n; i++) {
    const brk = pick([[720, 780], [720, 780], [720, 780], [840, 900], null]);
    const bs = brk ? brk[0] : 720, be = brk ? brk[1] : 780;
    const date = rnd() < 0.15 ? '2026-10-27' : pick(['2026-11-03', '2026-11-25', '2026-12-03']);      // 生效日 2026-11-01：10 月＝生效日前；11 月＝換版前舊程式已核定的那段
    const S = pick([420, 480, 540, 600]), E = Math.min(1290, be + pick([180, 240, 300]));
    const t = rnd();
    const per = (t < 0.7 ? [[S, bs], [be, E]] : t < 0.8 ? [[S, bs - 60], [be + 60, E]] : t < 0.9 ? [[S, bs], [be, be + 120], [be + 150, E]] : [[S, E]]).filter((p) => p[1] > p[0]);
    // 第一張卡：多半在休息帶當中或之後（容易觸發）；少數在上午那段裡（不觸發）
    const t1 = rnd() < 0.85 ? pick([bs, bs + ri(1, 59), be, be + ri(1, 120)]) : ri(S, bs - 1);
    const before = [[hm(t1), 'in']], after = [];
    let approveAt = t1 + ri(10, 120);
    const tOut = Math.min(1380, Math.max(t1 + 30, E + pick([-30, 0, 0, 15])));
    const shape = rnd();
    if (shape < 0.45) after.push([hm(tOut), 'out']);                                     // 還在上班時核定，之後正常打下班卡
    else if (shape < 0.6) { /* 還在上班時核定，之後沒打下班卡（16 小時後重算＝下班忘刷卡） */ }
    else if (shape < 0.75) {                                                              // 休息中打了短短一段、休息後再回來（第三輪擋項 2 那類）
      const o = Math.min(t1 + ri(5, 40), be - 1);
      if (o > t1) { const back = Math.max(o + 5, be + ri(0, 20)); before.push([hm(o), 'out']); before.push([hm(back), 'in']); approveAt = back + 10; }
      after.push([hm(tOut), 'out']);
    } else { before.push([hm(tOut), 'out']); approveAt = tOut + ri(10, 60); }           // 下班後才核定（之後沒有新卡）
    const cls = pick(['none', 'form', 'manual', 'both']);
    const reqs = [];
    if (cls === 'form' || cls === 'both') reqs.push(pick([{ kind: 'miss', miss_type: 'both', start: hm(per[0][0]), end: hm(per[0][1]) }, { kind: 'miss', miss_type: 'in', start: hm(per[0][0]), end: '' }]));
    if (rnd() < 0.15) reqs.push({ kind: 'miss', miss_type: 'out', start: '', end: hm(per[per.length - 1][1]) });
    const leadMin = brk && per.length > 1 ? per.filter((p) => p[1] <= t1).reduce((a, p) => a + p[1] - p[0], 0) : 0;
    const late_min = cls === 'manual' || cls === 'both' ? String(pick([leadMin, leadMin + ri(0, 60), Math.max(0, t1 - per[0][0]), 240, 198])) : '';
    const D1 = nextDay(date);
    const at = (x) => (x >= 1440 ? D1 + 'T' + hm(x - 1440) : date + 'T' + hm(x)) + ':00';
    out.push({ i, cls, date, brk: brk ? { start: hm(bs), end: hm(be) } : null, periods: per.map((p) => ({ start: hm(p[0]), end: hm(p[1]) })), reqs, late_min,
      before, approveAt: at(Math.min(approveAt, 1430)), after, recheckAt: nextDay(D1) + 'T05:00:00' });
  }
  return out;
}

if (require.main === module) {
  const list = process.env.LATE_FLOW_IN ? JSON.parse(fs.readFileSync(process.env.LATE_FLOW_IN, 'utf8'))
    : corpus(Number(process.env.LATE_FLOW_N) || 3000, Number(process.env.LATE_FLOW_SEED) || 20261126);
  process.stdout.write(JSON.stringify(list.map((sc) => Object.assign({ sc }, flow(sc)))));
}
module.exports = { flow, corpus };
