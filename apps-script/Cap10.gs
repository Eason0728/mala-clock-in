/* ══ 單日滿 10 小時：系統收卡並鎖住（2026-11-14 Eason 開工確認 A＋D；第 3 題「系統代打卡不算忘刷」，其他照推薦）══
   開工確認頁：https://claude.ai/artifact/38BQP8Q9Wg3VQzieX18o1Z
   - 同一天（段落歸上班卡那天，跨夜算開始那天）打卡累計滿 10 小時還沒下班 → 系統在「剛好滿 10 小時那一刻」寫一張下班卡
     （type out、status ok、device_id system、source system_cap），從那張卡起 11 小時內上班、下班都不能打。
   - 累計＝完整段（16 小時內配成對）＋正在上班那段＋「缺一張卡」用班表補出來的段。補不出來的孤單卡不算時數（寧可少算、不誤鎖）。
     班表補：孤單上班卡找開始時間差 2 小時內的班表時段、用它的結束；孤單下班卡找結束時間差 2 小時內的、用它的開始。只補本店的卡。
   - 跨店：照 Rest.gs 讀別家店同名在職同仁的打卡（restPeerEvents_）。正在上班那段在別家店＝那家店寫卡，這裡只擋。
   - 系統卡 status ok：配對、月表照常把那段收在第 10 小時，不算下班忘刷卡（Eason 第 3 題）。
   - 寫卡時機：①每 15 分鐘觸發器 capSweep（cap_set 開時才建）②同仁開打卡頁或按打卡的當下，所以觸發器晚一點也不會讓人多打。
   - 當天已經打滿 10 小時（自己打了下班卡）也不能再打上班卡。
   - 央廚、總部中午休息不打卡（CONFIG.NO_PUNCH_BREAK_START／END）：本店的段落扣掉休息時段再算，跟核定比對打卡時數同一套（2026-11-14 試算抓到：不扣的話做 9 小時就被收卡）。
   - 其他店：班表上那天的班別有設休息分鐘，就扣掉（2026-11-14 Eason「班別有輸入休息的分鐘數，也要自動扣除」）。
     分段班（例 12:00–22:00 中間休 2 小時）的休息＝段與段之間的時間＋各段自己的休息分鐘。
     休息有打卡（中間下班再上班）的部分不重扣：扣＝班表休息 − 當天打卡中間的空檔，最少 0。
     例：班別休息 30 分，同仁休息沒打卡 → 扣 30 分；休息有打下班、上班空了 30 分 → 不再扣。
   - 總開關：指令碼屬性 REST_CAP_ON 恰為 '1'。任何一步出錯一律不擋、不寫（不能讓打卡因為這道檢查壞掉）。
   九店整檔共用；動作掛在 Liff.gs LIFF_HANDLERS，不改各店 程式碼.js。 */
var CAP_H = 10;
var CAP_LOCK_H = 11;             // 跟兩班間隔 REST_GAP_H 同一個時間（Eason 第 4 題）
var CAP_PAIR_H = 16;             // 同 REST_PAIR_H
var CAP_LOOKBACK_H = 40;         // 同 REST_LOOKBACK_H
var CAP_SCHED_TOL_MIN = 120;     // 孤單卡跟班表時段差 2 小時內才拿班表補
var CAP_SRC = 'system_cap';
var CAP_SWEEP_FN = 'capSweep';
var CAP_SWEEP_MIN = 15;
var CAP_SCHED_BASE = '2026-11-01';   // 同 SchedPub.gs SCHED_PUB_BASE（營運系統期別：每期 28 天）
var CAP_SCHED_CACHE_S = 300;

function capOn_() {
  try { return PropertiesService.getScriptProperties().getProperty('REST_CAP_ON') === '1'; } catch (e) { return false; }
}
function capMs_(ts) { var t = new Date(String(ts)).getTime(); return isNaN(t) ? NaN : t; }
function capDay_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'yyyy-MM-dd'); }
function capHm_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'HH:mm'); }
function capMd_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'M/d'); }
function capIso_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"); }

/* ── 純判斷 ── */

/** 打卡列 → 算數的卡（非 rejected_*、in/out），依時間排。store：''＝本店，別家店是店代碼。 */
function capCounted_(evs) {
  return (evs || []).filter(function (e) {
    return (e.type === 'in' || e.type === 'out') && String(e.status || '').indexOf('rejected_') !== 0 && !isNaN(capMs_(e.ts));
  }).map(function (e) {
    return { ms: capMs_(e.ts), type: String(e.type), store: String(e.store || ''), source: String(e.source || '') };
  }).sort(function (a, b) { return a.ms - b.ms; });
}
/** 段落 [a, b] 跟每天的不打卡休息時段（brk＝{s:'12:00', e:'13:00'}）重疊幾毫秒 */
function capBreakMs_(a, b, brk) {
  if (!brk || !brk.s || !brk.e || !(b > a)) return 0;
  var sum = 0, d = capDay_(a - 86400000), stop = capDay_(b);
  for (var i = 0; i < 4 && d <= stop; i++) {
    var s = capMs_(d + 'T' + brk.s + ':00+08:00'), e = capMs_(d + 'T' + brk.e + ':00+08:00');
    if (!isNaN(s) && !isNaN(e) && e > s) sum += Math.max(0, Math.min(b, e) - Math.max(a, s));
    d = capDay_(capMs_(d + 'T12:00:00+08:00') + 86400000);
  }
  return sum;
}
function capSegMs_(s, brk) { return (s.out - s.in) - (s.store ? 0 : capBreakMs_(s.in, s.out, brk)); }
function capFillIn_(ev, nextMs, fill) {
  var end = fill ? fill('in', ev) : null;
  if (end && end > ev.ms) return { in: ev.ms, out: Math.min(end, nextMs), filled: true, store: ev.store };
  return { in: ev.ms, out: ev.ms, lone: true, store: ev.store };
}
function capFillOut_(ev, prevMs, fill) {
  var start = fill ? fill('out', ev) : null;
  if (start && start < ev.ms) return { in: Math.max(start, prevMs), out: ev.ms, filled: true, store: ev.store };
  return { in: ev.ms, out: ev.ms, lone: true, store: ev.store };
}

/** 卡＋現在 → 判斷結果：
 *  {lock:true, sys, until}            11 小時內有系統卡（sys＝系統卡時間）
 *  {due:{at, store}}                   正在上班那段已經滿 10 小時（at＝剛好滿 10 小時那一刻；store＝那段在哪家店）
 *  {open:{in, store}, reach}           正在上班、還沒滿（reach＝幾點會滿）
 *  {open:null}                         沒在上班
 *  每種都帶 today_ms＝今天（現在的日期）已完成的段加總，打上班卡時用。
 *  fill(kind, ev)：缺卡用班表補（'in'→回結束 ms、'out'→回開始 ms，補不出來回 null）。
 *  brk：本店不打卡休息時段 {s, e}（沒有就 null），本店的段落扣掉。 */
function capJudge_(evs, nowMs, fill, brk) {
  var list = capCounted_(evs).filter(function (e) { return e.ms <= nowMs; });
  var out = { today_ms: 0 }, lastSys = null;
  list.forEach(function (e) { if (e.source === CAP_SRC) lastSys = e; });
  var segs = [], open = null, prev = -Infinity;
  list.forEach(function (e) {
    if (e.type === 'in') {
      if (open) segs.push(capFillIn_(open, e.ms, fill));   // 上一張上班卡沒打下班
      open = e;
    } else if (open && e.ms - open.ms <= CAP_PAIR_H * 3600000) {
      segs.push({ in: open.ms, out: e.ms, store: open.store }); open = null;
    } else {
      if (open) { segs.push(capFillIn_(open, e.ms, fill)); open = null; }
      segs.push(capFillOut_(e, prev, fill));                // 前面沒有上班卡
    }
    prev = e.ms;
  });
  if (open && nowMs - open.ms > CAP_PAIR_H * 3600000) { segs.push(capFillIn_(open, nowMs, fill)); open = null; }
  var sb = (!brk && fill && fill.schedBrk) ? fill.schedBrk : null;   // 沒有不打卡休息時段的店才看班表休息分鐘（央廚、總部不重扣）
  var today = capDay_(nowMs);
  var todays = segs.filter(function (s) { return !s.lone && capDay_(s.in) === today; });
  out.today_ms = todays.reduce(function (a, s) { return a + capSegMs_(s, brk); }, 0) - capDed_(todays, null, today, sb);
  if (lastSys && nowMs < lastSys.ms + CAP_LOCK_H * 3600000) {
    out.lock = true; out.sys = lastSys.ms; out.until = lastSys.ms + CAP_LOCK_H * 3600000;
    return out;
  }
  if (!open) { out.open = null; return out; }
  var day = capDay_(open.ms);
  var daySegs = segs.filter(function (s) { return !s.lone && s.out <= open.ms && capDay_(s.in) === day; });
  var done = daySegs.reduce(function (a, s) { return a + capSegMs_(s, brk); }, 0) - capDed_(daySegs, open.ms, day, sb);
  var need = Math.max(0, CAP_H * 3600000 - done), reach = open.ms + need;
  if (!open.store && brk) for (var k = 0; k < 4; k++) {   // 正在上班那段碰到休息時段：往後延（延了可能又碰到下一天的，最多算 4 次）
    var r2 = open.ms + need + capBreakMs_(open.ms, reach, brk);
    if (r2 === reach) break;
    reach = r2;
  }
  if (nowMs >= reach) { out.due = { at: reach, store: open.store }; return out; }
  out.open = { in: open.ms, store: open.store }; out.reach = reach;
  return out;
}

/** 班表休息要扣多少毫秒：segs＝那天已完成的段，openIn＝正在上班那段的上班時間（沒有給 null）。
 *  打卡中間的空檔當成已經休息過了，扣＝班表休息 − 空檔（最少 0）。 */
function capDed_(segs, openIn, day, sb) {
  if (!sb) return 0;
  var info = sb(day);
  if (!info || !(info.b > 0)) return 0;
  var list = segs.slice().sort(function (a, b) { return a.in - b.in; }), gaps = 0;
  for (var i = 1; i < list.length; i++) gaps += Math.max(0, list[i].in - list[i - 1].out);
  if (openIn !== null && list.length) gaps += Math.max(0, openIn - list[list.length - 1].out);
  return Math.max(0, info.b - gaps);
}

/* ── 班表（營運系統發布在光復試算表 sched_pub；只有光復部署 SchedPub.gs，這裡自己讀）── */

function capSchedPeriod_(d) {
  var ms = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)), base = Date.UTC(2026, 10, 1);
  var k = Math.round((ms - base) / 86400000);
  if (k < 0) return null;
  var n = Math.floor(k / 28) + 1;
  return { p: 'T' + ('0' + n).slice(-Math.max(2, String(n).length)), idx: k % 28 };
}
/** 這家店在 REST_PEERS_ 的代碼（光復＝'gf'）與光復試算表 ID。 */
function capSelf_() {
  var peers = (typeof REST_PEERS_ === 'undefined') ? [] : REST_PEERS_, selfId = '', code = null, gf = null;
  try { selfId = getSS().getId(); } catch (e) { selfId = ''; }
  peers.forEach(function (p) { if (p.ss === selfId) code = p.code; if (p.code === 'gf') gf = p.ss; });
  return { code: code, gfSs: gf, isGf: code === 'gf' };
}
/** sched_pub 全部（{ 'store|period': data }）；讀不到回 null。快取 5 分鐘（太大就不快取）。 */
function capSchedPub_() {
  var cache = CacheService.getScriptCache(), ck = 'capsched:v1';
  try { var hit = cache.get(ck); if (hit) return JSON.parse(hit); } catch (e) {}
  var me = capSelf_(), ss = null;
  try { ss = me.isGf ? getSS() : (me.gfSs ? SpreadsheetApp.openById(me.gfSs) : null); } catch (e) { ss = null; }
  if (!ss) return null;
  var sh = ss.getSheetByName('sched_pub'), out = {};
  if (!sh) return out;
  var vals = sh.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    var d = String(vals[r][3] || '');
    if (!d) continue;
    try { out[String(vals[r][0]) + '|' + String(vals[r][1])] = JSON.parse(d); } catch (e) {}
  }
  try { var s = JSON.stringify(out); if (s.length < 90000) cache.put(ck, s, CAP_SCHED_CACHE_S); } catch (e) {}
  return out;
}
/** 這個人某天在本店班表上的上班時段 [[startMs, endMs]]（跨夜的結束 +1 天）；沒排、讀不到回 []。 */
function capSchedSegs_(pub, storeAlias, empId, d) {
  var pi = capSchedPeriod_(d);
  if (!pub || !pi) return [];
  var data = pub[storeAlias + '|' + pi.p];
  if (!data || !data.rows) return [];
  var row = null;
  data.rows.forEach(function (r) { if (String(r.emp_id) === String(empId)) row = r; });
  var sh = capSchedShiftOf_(data, row, pi.idx);
  if (!sh) return [];
  var parts = sh.segs ? sh.segs.map(function (x) { return [x.start, x.end]; }) : [[sh.start, sh.end]];
  var base = capMs_(d + 'T00:00:00+08:00'), out = [];
  parts.forEach(function (x) {
    var a = +String(x[0]).slice(0, 2) * 60 + +String(x[0]).slice(3, 5), b = +String(x[1]).slice(0, 2) * 60 + +String(x[1]).slice(3, 5);
    if (isNaN(a) || isNaN(b)) return;
    if (b <= a) b += 1440;
    out.push([base + a * 60000, base + b * 60000]);
  });
  return out;
}
function capSchedShiftOf_(data, row, idx) {
  var cell = row && row.cells ? row.cells[idx] : null;
  if (!cell || !cell.s) return null;
  var sh = null;
  (data.shifts || []).forEach(function (x) { if (x.id === cell.s) sh = x; });
  return sh && sh.start && sh.end ? sh : null;
}
/** 這個人某天本店班別的休息：{b: 休息毫秒}；沒排班或沒有休息回 null。
 *  分段班：段與段之間的時間＋各段 break_min（營運系統分段班的 break_min 就是段間空檔）；沒分段：break_min。 */
function capSchedBreak_(pub, storeAlias, empId, d) {
  var pi = capSchedPeriod_(d);
  if (!pub || !pi) return null;
  var data = pub[storeAlias + '|' + pi.p];
  if (!data || !data.rows) return null;
  var row = null;
  data.rows.forEach(function (r) { if (String(r.emp_id) === String(empId)) row = r; });
  var sh = capSchedShiftOf_(data, row, pi.idx);
  if (!sh) return null;
  var hm = function (t) { return +String(t).slice(0, 2) * 60 + +String(t).slice(3, 5); };
  var b = 0, g = 0;
  if (sh.segs && sh.segs.length) {
    sh.segs.forEach(function (x, i) {
      b += Math.max(0, Number(x.break_min) || 0);
      if (i) { var gap = hm(x.start) - hm(sh.segs[i - 1].end); if (gap < 0) gap += 1440; g += gap; }
    });
  } else b = Math.max(0, Number(sh.break_min) || 0);
  b += g;
  return b > 0 ? { b: b * 60000 } : null;
}
/** fill(kind, ev) 給 capJudge_：只補本店的卡（ev.store ''）；班表第一次用到才讀。
 *  fill.schedBrk(day)：本店班表那天的休息（capSchedBreak_）。 */
function capMakeFill_(empId) {
  var me = null, pub;
  var fn = function (kind, ev) {
    try {
      if (ev.store) return null;
      if (pub === undefined) { me = capSelf_(); pub = me.code ? capSchedPub_() : null; }
      if (!pub || !me || !me.code) return null;
      var alias = me.code === 'gf' ? '' : me.code;
      var d = (kind === 'out' && capHm_(ev.ms) <= '06:00') ? capDay_(ev.ms - 86400000) : capDay_(ev.ms);
      var segs = capSchedSegs_(pub, alias, empId, d), tol = CAP_SCHED_TOL_MIN * 60000, best = null;
      segs.forEach(function (s) {
        var diff = Math.abs((kind === 'in' ? s[0] : s[1]) - ev.ms);
        if (diff <= tol && (!best || diff < best.diff)) best = { diff: diff, v: kind === 'in' ? s[1] : s[0] };
      });
      return best ? best.v : null;
    } catch (e) { return null; }
  };
  fn.schedBrk = function (day) {
    try {
      if (pub === undefined) { me = capSelf_(); pub = me.code ? capSchedPub_() : null; }
      if (!pub || !me || !me.code) return null;
      return capSchedBreak_(pub, me.code === 'gf' ? '' : me.code, empId, day);
    } catch (e) { return null; }
  };
  return fn;
}

/* ── 讀寫 ── */

/** 本店不打卡休息時段（央廚 12:00–13:00、總部 14:00–15:00；其他店空白＝null） */
function capBreak_() {
  try {
    var s = String(CONFIG.NO_PUNCH_BREAK_START || ''), e = String(CONFIG.NO_PUNCH_BREAK_END || '');
    return /^\d\d:\d\d$/.test(s) && /^\d\d:\d\d$/.test(e) && e > s ? { s: s, e: e } : null;
  } catch (x) { return null; }
}

/** 本店 events（已讀好的列，或 null＝自己讀）＋別家店 → 這個人的卡 */
function capEventsFor_(ss, me, nowMs, ownRows) {
  var since = nowMs - CAP_LOOKBACK_H * 3600000;
  var rows = ownRows || readEventsSince(ss.getSheetByName('events'), since).rows;
  // 總部從央廚抄來的鏡像列（mirror_src 有值）是別家店的卡的複本，不算（不然同一段班算兩次）
  var mine = rows.filter(function (e) { return String(e.emp_id) === String(me.emp_id) && !String(e.mirror_src || ''); }).map(function (e) {
    return { ts: normCellTs(e.ts), type: String(e.type), status: String(e.status), source: String(e.source || ''), store: '' };
  });
  var peers = ((typeof restPeerEvents_ === 'function') ? restPeerEvents_(me.name, since) : []).filter(function (e) { return !e.mirror; });
  return mine.concat(peers);
}

/** 寫系統下班卡（剛好滿 10 小時那一刻）。同一人前後 1 分鐘內已有系統卡就不重寫。回 true＝這次有寫。 */
function capWrite_(ss, empId, atMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false;
  try {
    var sh = ss.getSheetByName('events');
    var read = readEventsSince(sh, atMs - 3600000);
    var dup = read.rows.some(function (e) {
      return String(e.emp_id) === String(empId) && String(e.source || '') === CAP_SRC && Math.abs(capMs_(normCellTs(e.ts)) - atMs) <= 60000;
    });
    if (dup) return false;
    var heads = read.headers.slice();
    if (heads.indexOf('source') < 0) {   // 舊表沒有 source 欄：補在最後（readSheetAsObjects 照表頭取值，舊程式不受影響）
      heads.push('source');
      sh.getRange(1, heads.length).setValue('source');
    }
    var val = { ts: capIso_(atMs), emp_id: empId, type: 'out', lat: '', lng: '', distance_m: '', within_range: '',
                device_id: 'system', device_match: '', status: 'ok', accuracy_m: '', source: CAP_SRC };
    if (typeof empIdColText_ === 'function') { try { empIdColText_(sh); } catch (e) {} }
    sh.appendRow(heads.map(function (h) { return val.hasOwnProperty(h) ? val[h] : ''; }));
    SpreadsheetApp.flush();
    return true;
  } finally { lock.releaseLock(); }
}

/** 這個人現在的狀態（必要時順便寫系統卡）→ null（開關關著或出錯）或
 *  {locked, sys, until, in_block, today_h, reason, hint}。locked＝上下班都不能打；in_block＝只擋上班卡。 */
function capCheck_(ss, me, nowMs, ownRows) {
  if (!capOn_()) return null;
  try {
    var now = nowMs || Date.now();
    var r = capJudge_(capEventsFor_(ss, me, now, ownRows), now, capMakeFill_(me.emp_id), capBreak_());
    var st = { locked: false, in_block: false, today_h: Math.round(r.today_ms / 360000) / 10 };
    var sys = null;
    if (r.lock) sys = r.sys;
    else if (r.due) {
      if (!r.due.store) capWrite_(ss, me.emp_id, r.due.at);   // 正在上班那段在別家店：那家店寫，這裡只擋
      sys = r.due.at;
    }
    if (sys !== null) {
      var until = sys + CAP_LOCK_H * 3600000;
      st.locked = true; st.sys = sys; st.until = until;
      st.reason = '今天已滿 ' + CAP_H + ' 小時，系統在 ' + (capDay_(sys) === capDay_(now) ? '' : capMd_(sys) + ' ') + capHm_(sys) + ' 幫你記了下班卡';
      st.hint = (capDay_(until) === capDay_(now) ? '' : capMd_(until) + ' ') + capHm_(until) + ' 以後才能再打卡';
      return st;
    }
    if (!r.open && r.today_ms >= CAP_H * 3600000) {
      st.in_block = true;
      st.reason = '你今天已經上班 ' + st.today_h + ' 小時（一天最多 ' + CAP_H + ' 小時）';
      st.hint = '今天不能再打上班卡';
    }
    return st;
  } catch (e) { Logger.log('CAP 檢查失敗（不擋）：' + e); return null; }
}

/** 打卡前的檢查：擋＝{reason, hint, until}，放行＝null。 */
function capBlock_(ss, me, type, ownRows) {
  var st = capCheck_(ss, me, Date.now(), ownRows);
  if (!st) return null;
  if (st.locked) return { reason: st.reason, hint: st.hint, until: st.until };
  if (type === 'in' && st.in_block) return { reason: st.reason, hint: st.hint, until: null };
  return null;
}

/** liff_status 用：{locked, in_block, reason, hint, until, sys_hm} 或 {locked:false}。 */
function capStatusFor_(ss, me, ownRows) {
  var st = capCheck_(ss, me, Date.now(), ownRows);
  if (!st || (!st.locked && !st.in_block)) return { locked: false, in_block: false };
  return { locked: st.locked, in_block: st.in_block, reason: st.reason, hint: st.hint, until: st.until || null,
           sys_hm: st.sys ? capHm_(st.sys) : null };
}

/** 舊連結 clock.html 的 clock 動作（Liff.gs LIFF_HANDLERS 覆蓋）：擋下回跟 handleClock 被休息規則擋一樣的形狀，不寫列。 */
function capClockWrapped_(body) {
  try {
    if (capOn_() && (body.type === 'in' || body.type === 'out')) {
      var ss = getSS(), me = findRosterByKey(readSheetAsObjects(ss.getSheetByName('roster')).rows, body.key);
      if (me && String(me.active).toLowerCase() === 'true') {
        var b = capBlock_(ss, me, body.type, null);
        if (b) return { ok: true, status: 'rejected_rest', name: me.name, type: body.type,
                        rest: { code: 'cap10', reason: b.reason, hint: b.hint, until: b.until } };
      }
    }
  } catch (e) { Logger.log('CAP 舊連結檢查失敗（不擋）：' + e); }
  return handleClock(body);
}

/** 觸發器：每 15 分鐘掃一次正在上班的人，滿 10 小時就寫系統卡（開打卡頁、按打卡時也會寫，這裡補沒再碰手機的人）。 */
function capSweep() {
  if (!capOn_()) return;
  try {
    var ss = getSS(), now = Date.now();
    var rows = readEventsSince(ss.getSheetByName('events'), now - CAP_LOOKBACK_H * 3600000).rows;
    var last = {};
    rows.forEach(function (e) {
      if ((e.type !== 'in' && e.type !== 'out') || String(e.status).indexOf('rejected_') === 0 || String(e.mirror_src || '')) return;
      var ms = capMs_(normCellTs(e.ts));
      if (isNaN(ms)) return;
      var k = String(e.emp_id);
      if (!last[k] || ms >= last[k].ms) last[k] = { ms: ms, type: String(e.type) };
    });
    var cand = Object.keys(last).filter(function (k) { return last[k].type === 'in' && now - last[k].ms <= CAP_PAIR_H * 3600000; });
    if (!cand.length) return;
    var roster = readSheetAsObjects(ss.getSheetByName('roster')).rows;
    cand.forEach(function (id) {
      var me = null;
      roster.forEach(function (r) { if (String(r.emp_id) === id) me = r; });
      if (!me) me = { emp_id: id, name: '' };
      capCheck_(ss, me, now, rows);
    });
  } catch (e) { Logger.log('CAP 掃描失敗：' + e); }
}

/** {action:'cap_set', admin_key, on?:true|false} → 開／關這家店的滿 10 小時收卡（指令碼屬性 REST_CAP_ON＋觸發器 capSweep）。
 *  不帶 on＝只查。管理金鑰空字串一律擋。 */
function handleCapSet_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var props = PropertiesService.getScriptProperties();
  if (body.on === true || body.on === false) {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === CAP_SWEEP_FN) ScriptApp.deleteTrigger(t); });
    if (body.on) {
      props.setProperty('REST_CAP_ON', '1');
      ScriptApp.newTrigger(CAP_SWEEP_FN).timeBased().everyMinutes(CAP_SWEEP_MIN).create();
    } else props.deleteProperty('REST_CAP_ON');
  }
  var n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === CAP_SWEEP_FN; }).length;
  return { ok: true, on: capOn_(), trigger: n };
}

/** mgr_day 回應加上系統卡：每人 cap_sys＝['19:00']（那天 00:00 到隔天 06:00 的系統卡），考勤管理拿來標示。 */
function capAnnotateDay_(body, res) {
  try {
    if (!res || !res.ok || !res.employees || !body.date) return res;
    var from = capMs_(body.date + 'T00:00:00+08:00'), to = from + 30 * 3600000;
    if (isNaN(from)) return res;
    var sh = getSS().getSheetByName('events');
    if (sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].indexOf('source') < 0) return res;   // 從沒寫過系統卡（沒有 source 欄）：不多讀
    var rows = readEventsSince(sh, from).rows, by = {};
    rows.forEach(function (e) {
      if (String(e.source || '') !== CAP_SRC) return;
      var ms = capMs_(normCellTs(e.ts));
      if (isNaN(ms) || ms < from || ms >= to) return;
      (by[String(e.emp_id)] = by[String(e.emp_id)] || []).push(capHm_(ms));
    });
    res.employees.forEach(function (p) { if (by[String(p.emp_id)]) p.cap_sys = by[String(p.emp_id)]; });
  } catch (e) { Logger.log('CAP mgr_day 標示失敗：' + e); }
  return res;
}
