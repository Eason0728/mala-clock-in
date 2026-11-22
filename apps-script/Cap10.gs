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
   - 2026-11-23 Eason 新定義（取代 11/14「班別有輸入休息的分鐘數，也要自動扣除」）：
     「當日出勤滿十小時是有打卡的時數＋假單時數＋出差。如果班表是像央廚或總部有固定休息一小時不列入打卡就要扣除，其餘門市單位則不扣除班表的休息時間。」
     ①其他店不再扣班表休息（capDed_ 拿掉）；②加上這一天**已核准**的請假單、出差單（requests 分頁，本店工號＋別家店同名在職）；
     ③有時段的單跟打卡時段、跟前面已算過的單重疊的部分不重複算，本店的單再扣不打卡休息時段，最多算單上時數；只填時數的單照時數全算；
     ④「滿 10」含剛好 10 小時。
     ⑤即時收卡、擋上班卡只算「有時段」的單（2026-11-23 主管確認）：只填時數、沒有時段的單不知道跟打卡重不重疊，
       不計入即時收卡、也不會因此擋上班卡，只進事後的通知與清單。
       上班中才核准的單不當場收卡（CAP_LIVE_LATE_OK，預設可改、待主管決定）。
       當天還沒有任何打卡時數的人，不會因為假單被擋上班卡；假單本身就 ≥ 10 小時（資料異常，例如同一趟出差兩家店各核一次）不拿來即時收卡；
       同一筆假兩個管道各建一張且時段相同＝重疊部分只算一次。
     ⑥同一段上班只會有一張系統下班卡：寫之前看這段上班（最後一張上班卡之後）有沒有別處寫好的系統卡或本人的下班卡，有就不寫（capWrite_）。
     設計與試算：~/加盟名單平台/_brain_out/cap10-newdef/design.md
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
var CAP_LEAVE_CACHE_S = 60;      // 申請表（已核准的請假、出差）快取秒數
// 這段上班開始之後才核准的單，算不算進即時收卡（預設 false＝不算、只進事後通知；待主管決定，true＝從核准那一刻起算、可能當場收卡）
var CAP_LIVE_LATE_OK = false;

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

/** 卡＋現在 → {segs, open, lastSys}：段落（完整段、缺卡用班表補的段、補不出來的孤單卡 lone）、正在上班那張上班卡、最後一張系統卡。
 *  （2026-11-23 從 capJudge_ 拆出來，判斷與試算共用；內容與拆之前逐行相同。） */
function capSegs_(evs, nowMs, fill) {
  var list = capCounted_(evs).filter(function (e) { return e.ms <= nowMs; });
  var lastSys = null;
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
  return { segs: segs, open: open, lastSys: lastSys };
}

/** 卡＋現在 → 判斷結果：
 *  {lock:true, sys, until}            11 小時內有系統卡（sys＝系統卡時間）
 *  {due:{at, store}}                   正在上班那段已經滿 10 小時（at＝剛好滿 10 小時那一刻；store＝那段在哪家店）
 *  {open:{in, store}, reach}           正在上班、還沒滿（reach＝幾點會滿）
 *  {open:null}                         沒在上班
 *  每種都帶 today_ms＝今天已完成的出勤（打卡＋算數的假單）、today_punch_ms＝其中打卡的部分（顯示、擋上班卡的前提用）。
 *  fill(kind, ev)：缺卡用班表補（'in'→回結束 ms、'out'→回開始 ms，補不出來回 null）。
 *  brk：本店不打卡休息時段 {s, e}（沒有就 null），本店的段落扣掉。
 *  leaves：已核准的請假、出差（capLeaveItems_ 的結果；沒有給 [] 或省略），先經 capLiveLeaves_ 篩（見檔頭⑤）。
 *  due.at＝剛好滿 10 小時那一刻（打卡＋算數的假一起算）；due.in＝這段上班的上班卡時間（capWrite_ 判斷「同一段」用）。 */
function capJudge_(evs, nowMs, fill, brk, leaves) {
  var g = capSegs_(evs, nowMs, fill), segs = g.segs, open = g.open, lastSys = g.lastSys, out = { today_ms: 0, today_punch_ms: 0 };
  var today = capDay_(nowMs), need = CAP_H * 3600000;
  var td = capDayMs_(segs, null, nowMs, today, brk, capLiveLeaves_(leaves, today, null, brk));
  out.today_ms = td.total; out.today_punch_ms = td.punch;
  if (lastSys && nowMs < lastSys.ms + CAP_LOCK_H * 3600000) {
    out.lock = true; out.sys = lastSys.ms; out.until = lastSys.ms + CAP_LOCK_H * 3600000;
    return out;
  }
  if (!open) { out.open = null; return out; }
  var day = capDay_(open.ms), o = { ms: open.ms, store: open.store }, lv = capLiveLeaves_(leaves, day, open.ms, brk);
  var tot = function (t) { return capDayMs_(segs, o, t, day, brk, lv).total; };
  var jumps = lv.filter(function (l) { return l.dec > open.ms; }).map(function (l) { return l.dec; });
  var reach = capReach_(tot, open.ms, jumps);
  if (tot(nowMs) >= need) {
    out.due = { at: (reach !== null && reach <= nowMs) ? reach : nowMs, in: open.ms, store: open.store };
    return out;
  }
  out.open = { in: open.ms, store: open.store }; out.reach = reach;
  return out;
}

/** 即時收卡、擋上班卡要算的單（檔頭⑤）：那天、有時段的單（只填時數的不算，主管 2026-11-23 確認）；
 *  openMs（正在上班那段的上班卡時間，沒有給 null）之後才核准的看 CAP_LIVE_LATE_OK；
 *  剩下的單本身（不看打卡）就 ≥ 10 小時＝資料異常（重複核定之類），一張都不拿來即時收卡（少算＝不誤收）。 */
function capLiveLeaves_(leaves, day, openMs, brk) {
  var l = (leaves || []).filter(function (x) {
    if (!x || x.day !== day) return false;
    if (x.a === null || x.b === null) return false;
    if (openMs !== null && x.dec > openMs && !CAP_LIVE_LATE_OK) return false;
    return true;
  });
  if (l.length && capLeaveMs_(l, day, [], brk, Infinity) >= CAP_H * 3600000) return [];
  return l;
}

/** 第一個「當日出勤 ≥ 10 小時」的時刻。tot 隨時間只增不減：平常每毫秒最多增 1 毫秒（碰到不打卡休息、假單時段重疊會停著不增），
 *  只有在假單核准那一刻（jumps）會一下子跳上去。所以往後跳「還差多少」不會跳過頭——中間碰到核准時刻就先停在那裡再算。
 *  80 次還沒到回 null（不收卡，下次再算）。 */
function capReach_(tot, from, jumps) {
  var need = CAP_H * 3600000, t = from;
  for (var i = 0; i < 80; i++) {
    var v = tot(t);
    if (v >= need) return t;
    var nt = t + (need - v), j = null;
    (jumps || []).forEach(function (d) { if (d > t && d <= nt && (j === null || d < j)) j = d; });
    t = j !== null ? j : nt;
  }
  return null;
}

/** 某一天到 t 為止的出勤（2026-11-23 新定義）→ {punch, leave, total}（毫秒）。
 *  segs＝已完成的段（孤單卡不算），open＝正在上班那段 {ms, store}（算到 t；沒有給 null）。
 *  punch：本店的段扣不打卡休息時段（央廚、總部），其他店不扣班表休息；leave：capLeaveMs_。 */
function capDayMs_(segs, open, t, day, brk, leaves) {
  var punch = 0, work = [];
  segs.forEach(function (s) {
    if (s.lone || s.out > t || capDay_(s.in) !== day) return;
    punch += capSegMs_(s, brk); work.push([s.in, s.out]);
  });
  if (open && t > open.ms && capDay_(open.ms) === day) {
    var o = { in: open.ms, out: t, store: open.store };
    punch += capSegMs_(o, brk); work.push([o.in, o.out]);
  }
  var leave = capLeaveMs_(leaves, day, work, brk, t);
  return { punch: punch, leave: leave, total: punch + leave };
}

/* ── 已核准的請假、出差（2026-11-23）── */

/** 區間 [[a,b],…] → 照開始排、相接或重疊的合併 */
function capUnion_(list) {
  var l = list.filter(function (x) { return x[1] > x[0]; }).sort(function (p, q) { return p[0] - q[0]; }), out = [];
  l.forEach(function (x) {
    var last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  });
  return out;
}
/** [a,b] 扣掉 used（已合併）之後剩下的區間 */
function capMinus_(a, b, used) {
  var out = [], cur = a;
  used.forEach(function (u) {
    if (u[1] <= cur || u[0] >= b) return;
    if (u[0] > cur) out.push([cur, Math.min(u[0], b)]);
    cur = Math.max(cur, u[1]);
  });
  if (cur < b) out.push([cur, b]);
  return out;
}
/** 某一天、到 t 為止已核准（dec ≤ t）的請假、出差算多少毫秒。work＝那天的打卡區間（正在上班那段算到 t）。
 *  有時段的單（照開始時間先後）：時段扣掉打卡區間、扣掉前面已算過的單（重疊不重複算，同一筆假重複建單也只算一次）；
 *  本店的單（store ''）再扣不打卡休息時段；最多算單上時數。只填時數的單不在這裡算（capLiveLeaves_ 已排除；傳進來就略過）。 */
function capLeaveMs_(leaves, day, work, brk, t) {
  var list = (leaves || []).filter(function (l) { return l && l.day === day && l.ms > 0 && !(l.dec > t); });
  if (!list.length) return 0;
  list.sort(function (p, q) { return (p.a === null ? Infinity : p.a) - (q.a === null ? Infinity : q.a); });
  var used = capUnion_(work.slice()), sum = 0;
  list.forEach(function (l) {
    if (l.a === null || l.b === null) return;
    var len = 0;
    capMinus_(l.a, l.b, used).forEach(function (f) { len += (f[1] - f[0]) - (l.store ? 0 : capBreakMs_(f[0], f[1], brk)); });
    sum += Math.min(l.ms, Math.max(0, len));
    used = capUnion_(used.concat([[l.a, l.b]]));
  });
  return sum;
}
/** 'HH:MM'（或 Sheets 轉成的日期物件）→ 當天第幾分鐘；不合法回 null */
function capHmMin_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') v = Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
  var m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return (+m[1]) * 60 + (+m[2]);
}
/** 申請表的列 → 已核准的請假、出差 [{day, a, b, ms, store, kind, dec}]（給 capJudge_）。
 *  只收：status＝approved、kind＝leave／trip、工號在 ids 裡、日期在 days 裡、時數 > 0。
 *  a／b＝時段起訖毫秒（結束 ≤ 開始＝跨夜到隔天，同核定）；只填時數的單 a＝b＝null。store：''＝本店，別家店是店代碼。
 *  dec＝核准時間（decided_at）毫秒；沒有或讀不懂＝nowMs（當成現在才知道，不往回算）。 */
function capLeaveItems_(rows, ids, store, days, nowMs) {
  var out = [];
  (rows || []).forEach(function (r) {
    if (!r || String(r.status) !== 'approved') return;
    var kind = String(r.kind);
    if ((kind !== 'leave' && kind !== 'trip') || ids.indexOf(String(r.emp_id)) < 0) return;
    var d = (typeof normCellDate === 'function') ? normCellDate(r.date) : String(r.date || '').slice(0, 10);
    if (days.indexOf(d) < 0) return;
    var h = Number(r.hours);
    if (r.hours === '' || r.hours === null || !isFinite(h) || h <= 0) return;
    var s = capHmMin_(r.start), e = capHmMin_(r.end), a = null, b = null;
    if (s !== null && e !== null && s !== e) {
      if (e <= s) e += 1440;
      var base = capMs_(d + 'T00:00:00+08:00');
      if (!isNaN(base)) { a = base + s * 60000; b = base + e * 60000; }
    }
    var dec = capMs_((typeof normCellTs === 'function') ? normCellTs(r.decided_at) : r.decided_at);
    out.push({ day: d, a: a, b: b, ms: Math.round(h * 3600000), store: store, kind: kind, type: String(r.leave_type || ''), dec: isNaN(dec) ? (nowMs || Date.now()) : dec });
  });
  return out;
}
/** 一家店申請表裡、某幾天已核准的請假與出差（精簡列，快取 CAP_LEAVE_CACHE_S 秒）。沒有 requests 分頁（mini 擋卡引擎）回 []。 */
function capReqRows_(ss, days) {
  var cache = CacheService.getScriptCache(), ck = 'caplv1:' + String(ss.getId()).slice(-12) + ':' + days.join(',');
  try { var hit = cache.get(ck); if (hit) return JSON.parse(hit); } catch (e) {}
  var sh = ss.getSheetByName('requests'), out = [];
  if (!sh) return out;
  readSheetAsObjects(sh).rows.forEach(function (r) {
    if (String(r.status) !== 'approved' || (String(r.kind) !== 'leave' && String(r.kind) !== 'trip')) return;
    var d = (typeof normCellDate === 'function') ? normCellDate(r.date) : String(r.date || '').slice(0, 10);
    if (days.indexOf(d) < 0) return;
    var hm = function (v) { var m = capHmMin_(v); return m === null ? '' : ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); };
    out.push({ emp_id: String(r.emp_id), kind: String(r.kind), leave_type: String(r.leave_type || ''), status: 'approved', date: d, start: hm(r.start), end: hm(r.end), hours: r.hours,
               decided_at: (typeof normCellTs === 'function') ? normCellTs(r.decided_at) : String(r.decided_at || '') });
  });
  try { cache.put(ck, JSON.stringify(out), CAP_LEAVE_CACHE_S); } catch (e) {}
  return out;
}
/** 這個人昨天、今天已核准的請假與出差：本店（工號）＋別家店同名在職（同 restPeerEvents_ 的名冊快取）。出錯回 []（少算＝不誤收）。 */
function capLeavesFor_(ss, me, nowMs) {
  var days = [capDay_(nowMs - 86400000), capDay_(nowMs)], out = [];
  try { out = capLeaveItems_(capReqRows_(ss, days), [String(me.emp_id)], '', days, nowMs); } catch (e) { Logger.log('CAP 讀本店申請失敗（不算）：' + e); }
  var nm = (typeof restName_ === 'function') ? restName_(me.name) : '';
  if (!nm || typeof REST_PEERS_ === 'undefined' || !REST_PEERS_.length) return out;
  var selfId = '';
  try { selfId = ss.getId(); } catch (e) { selfId = ''; }
  var cache = CacheService.getScriptCache();
  REST_PEERS_.forEach(function (p) {
    if (!p || !p.ss || p.ss === selfId) return;
    try {
      var pss = null, ck = 'rpr:' + p.ss.slice(-12), hit = cache.get(ck), roster = hit ? JSON.parse(hit) : null;
      if (!roster) {   // 同 restPeerEvents_：名冊快取 6 小時、格式 [[姓名去空白, 工號]]
        pss = SpreadsheetApp.openById(p.ss);
        roster = readSheetAsObjects(pss.getSheetByName('roster')).rows
          .filter(function (r) { return String(r.active).toLowerCase() === 'true'; })
          .map(function (r) { return [restName_(r.name), String(r.emp_id)]; });
        try { cache.put(ck, JSON.stringify(roster), REST_PEER_CACHE_S); } catch (e) {}
      }
      var ids = roster.filter(function (r) { return r[0] === nm; }).map(function (r) { return r[1]; });
      if (!ids.length) return;
      pss = pss || SpreadsheetApp.openById(p.ss);
      out = out.concat(capLeaveItems_(capReqRows_(pss, days), ids, p.code, days, nowMs));
    } catch (e) { Logger.log('CAP 讀別家店 ' + p.code + ' 申請失敗（不算）：' + e); }
  });
  return out;
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
/** fill(kind, ev) 給 capJudge_：只補本店的卡（ev.store ''）；班表第一次用到才讀。
 *  （2026-11-23 起不再扣班表休息分鐘，原本的 fill.schedBrk／capSchedBreak_ 拿掉。） */
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

/** 本店 events（已讀好的列，或 null＝自己讀）＋別家店（已讀好的 restPeerEvents_ 結果，或省略＝自己讀）→ 這個人的卡 */
function capEventsFor_(ss, me, nowMs, ownRows, peerEvs) {
  var since = nowMs - CAP_LOOKBACK_H * 3600000;
  var rows = ownRows || readEventsSince(ss.getSheetByName('events'), since).rows;
  // 總部從央廚抄來的鏡像列（mirror_src 有值）是別家店的卡的複本，不算（不然同一段班算兩次）
  var mine = rows.filter(function (e) { return String(e.emp_id) === String(me.emp_id) && !String(e.mirror_src || ''); }).map(function (e) {
    return { ts: normCellTs(e.ts), type: String(e.type), status: String(e.status), source: String(e.source || ''), store: '' };
  });
  var peers = (peerEvs || ((typeof restPeerEvents_ === 'function') ? restPeerEvents_(me.name, since) : [])).filter(function (e) { return !e.mirror; });
  return mine.concat(peers);
}

/** 打卡頁提醒（Rest.gs restCheckIn_）用：這個人今天已完成的出勤（新定義，跟收卡同一支 capJudge_ 算）→ {total, punch}（毫秒）。
 *  Rest.gs 只在 REST_CAP_ON 開著時叫（關著＝提醒跟改版前一樣）；出錯回 null（Rest.gs 退回原本的打卡加總）。 */
function capTodayMs_(ss, me, nowMs, ownRows, peerEvs) {
  try {
    var r = capJudge_(capEventsFor_(ss, me, nowMs, ownRows, peerEvs), nowMs, capMakeFill_(me.emp_id), capBreak_(), capLeavesFor_(ss, me, nowMs));
    return { total: r.today_ms, punch: r.today_punch_ms };
  } catch (e) { Logger.log('CAP 今日出勤計算失敗（提醒改用打卡加總）：' + e); return null; }
}

/** 寫系統下班卡（剛好滿 10 小時那一刻）。回 {at}＝這次有寫；{sys}＝這段上班已經有系統卡（別處寫的，回那張的時間）；
 *  {closed:true}＝這段上班已經有本人的下班卡（剛同步進來）；false＝拿不到鎖。
 *  inMs＝這段上班的上班卡時間（2026-11-23）：上班卡之後已有任何算數的下班卡（系統或本人、不論幾點）就不寫——
 *  同一段上班不會有兩張系統卡（mini 與 Google 各算一張、規則版本不同時間差超過 1 分鐘也一樣），也不會系統卡記在本人下班卡之後。
 *  沒給 inMs（舊呼叫）＝照舊：前後 1 分鐘內已有系統卡才不寫。 */
function capWrite_(ss, empId, atMs, inMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false;
  try {
    var sh = ss.getSheetByName('events');
    var seg = typeof inMs === 'number' && isFinite(inMs) && inMs < atMs;
    var read = readEventsSince(sh, Math.min(atMs - 3600000, seg ? inMs : Infinity));
    var sys = null, closed = false;
    read.rows.forEach(function (e) {
      if (String(e.emp_id) !== String(empId) || String(e.type) !== 'out' || String(e.status || '').indexOf('rejected_') === 0 || String(e.mirror_src || '')) return;
      var ms = capMs_(normCellTs(e.ts)), isSys = String(e.source || '') === CAP_SRC;
      if (isNaN(ms)) return;
      if (seg ? ms > inMs : (isSys && Math.abs(ms - atMs) <= 60000)) {
        if (isSys) sys = (sys === null || ms < sys) ? ms : sys;
        else closed = true;
      }
    });
    if (sys !== null) return { sys: sys };
    if (closed) return { closed: true };
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
    return { at: atMs };
  } finally { lock.releaseLock(); }
}

/** 這個人現在的狀態（必要時順便寫系統卡）→ null（開關關著或出錯）或
 *  {locked, sys, until, in_block, today_h, reason, hint}。locked＝上下班都不能打；in_block＝只擋上班卡。 */
function capCheck_(ss, me, nowMs, ownRows) {
  if (!capOn_()) return null;
  try {
    var now = nowMs || Date.now();
    var r = capJudge_(capEventsFor_(ss, me, now, ownRows), now, capMakeFill_(me.emp_id), capBreak_(), capLeavesFor_(ss, me, now));
    // today_h 是畫面上「你今天已經上班 X 小時」的 X：顯示實際打卡時數（判斷用 today_ms＝含假單的新定義）
    var st = { locked: false, in_block: false, today_h: Math.round(r.today_punch_ms / 360000) / 10 };
    var sys = null;
    if (r.lock) sys = r.sys;
    else if (r.due) {
      sys = r.due.at;
      if (!r.due.store) {   // 正在上班那段在別家店：那家店寫，這裡只擋
        var w = capWrite_(ss, me.emp_id, r.due.at, r.due.in);
        if (w && w.closed) return st;          // 這段上班已經有本人的下班卡（判斷之後才同步進來）：不收、不鎖
        if (w && w.sys) sys = w.sys;           // 這段上班已經有別處寫的系統卡：照那一張
      }
    }
    if (sys !== null) {
      var until = sys + CAP_LOCK_H * 3600000;
      st.locked = true; st.sys = sys; st.until = until;
      st.reason = '今天已滿 ' + CAP_H + ' 小時，系統在 ' + (capDay_(sys) === capDay_(now) ? '' : capMd_(sys) + ' ') + capHm_(sys) + ' 幫你記了下班卡';
      st.hint = (capDay_(until) === capDay_(now) ? '' : capMd_(until) + ' ') + capHm_(until) + ' 以後才能再打卡';
      return st;
    }
    if (!r.open && r.today_ms >= CAP_H * 3600000 && r.today_punch_ms > 0) {   // 今天還沒有任何打卡時數＝不會因為假單擋上班卡
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
