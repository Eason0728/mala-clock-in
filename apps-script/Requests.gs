/**
 * 加班請假／忘打卡申請＋主管 QR 打卡備案（2026-10-09 Eason 定案，規格見 mala-clock-liff docs/requests-spec.md）
 *
 * 五家店整檔共用（同 Liff.gs）：同仁從 LINE 打卡頁送申請 → 存這家店的 requests 分頁 → 值班主管在核定頁審。
 * 核准只是「預填當天核定」，主管送出核定才算數；打卡紀錄（events）一律不改。
 * 忘打卡：只能申請 7 天內、補登後仍算一次忘刷卡（不改全勤規則）。
 * 結果不推播（推播要花額度）：同仁在「我的申請」看，或下一次打卡成功時畫面告知（reqUnseenNotes_）。
 * 程式碼.js 不動；動作掛在 Liff.gs 的 LIFF_HANDLERS。
 */

var REQ_SHEET_ = 'requests';
var REQ_HEADERS_ = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours',
                    'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at'];
var REQ_KINDS_ = { leave: '請假', ot: '加班', miss: '忘打卡' };
var REQ_MISS_DAYS = 7;          // 忘打卡只能申請 7 天內（含今天）
var REQ_LEAVE_PAST_DAYS = 31;   // 請假可補申請到 31 天前
var REQ_FUTURE_DAYS = 90;       // 請假／加班最遠申請到 90 天後
var REQ_LIST_DAYS = 60;         // 「我的申請」看 60 天
var REQ_REASON_MAX = 100;

/* ── 工具 ── */
function reqSheet_(ss, create) {
  var sh = ss.getSheetByName(REQ_SHEET_);
  if (!sh && create) {
    sh = ss.insertSheet(REQ_SHEET_);
    sh.getRange(1, 1, 1, REQ_HEADERS_.length).setValues([REQ_HEADERS_]);
    sh.getRange('A:R').setNumberFormat('@');   // 日期、時間存成文字，避免 Sheets 自動轉成日期物件（2026-07-15 那個坑）
  }
  return sh;
}
function reqRows_(ss) {
  var sh = reqSheet_(ss, false);
  if (!sh) return [];
  return readSheetAsObjects(sh).rows.map(function (r) {
    r.date = normCellDate(r.date); r.created_at = String(normCellTs(r.created_at) || '');
    r.start = reqHm_(r.start); r.end = reqHm_(r.end);
    return r;
  });
}
/** 'HH:MM'（容忍 Sheets 轉成 Date 或 '9:00'）；不合法回 ''。 */
function reqHm_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', 'HH:mm');
  var m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m) return '';
  var h = +m[1], mi = +m[2];
  return (h <= 23 && mi <= 59) ? ('0' + h).slice(-2) + ':' + m[2] : '';
}
function reqMin_(hm) { var m = /^(\d{2}):(\d{2})$/.exec(hm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
/** 時段長度（小時，兩位小數）；end ≤ start 視為跨夜到隔天（同後端核定）。 */
function reqSpanHours_(start, end) {
  var s = reqMin_(start), e = reqMin_(end);
  if (s === null || e === null) return null;
  if (e <= s) e += 1440;
  return Math.round((e - s) / 60 * 100) / 100;
}
function reqDayDiff_(a, b) {   // 日期字串 a − b 的天數
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000);
}
function reqClean_(v, max) { return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function reqPublic_(r) {
  return { id: String(r.id), created_at: String(r.created_at), emp_id: String(r.emp_id), name: String(r.name), kind: String(r.kind),
           date: String(r.date), leave_type: String(r.leave_type || ''), start: r.start, end: r.end,
           hours: r.hours === '' || r.hours === null || r.hours === undefined ? null : Number(r.hours),
           miss_type: String(r.miss_type || ''), reason: String(r.reason || ''), has_attach: !!r.attach_id,
           status: String(r.status), decided_at: String(normCellTs(r.decided_at) || ''), decided_by: String(r.decided_by || ''),
           reject_reason: String(r.reject_reason || '') };
}
function reqSetCells_(sh, rowIndex, patch) {
  var heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  Object.keys(patch).forEach(function (k) {
    var c = heads.indexOf(k);
    if (c >= 0) sh.getRange(rowIndex, c + 1).setValue(patch[k]);
  });
}
/** 一句話描述一筆申請（主管頁、我的申請、打卡後告知共用）。 */
function reqSummary_(r) {
  var md = parseInt(String(r.date).slice(5, 7), 10) + '/' + parseInt(String(r.date).slice(8, 10), 10);
  if (r.kind === 'leave') return md + ' ' + r.leave_type + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時';
  if (r.kind === 'ot') return md + ' 加班 ' + r.start + '–' + r.end + '（' + Number(r.hours) + ' 小時）';
  var parts = [];
  if (r.miss_type === 'in' || r.miss_type === 'both') parts.push('上班 ' + r.start);
  if (r.miss_type === 'out' || r.miss_type === 'both') parts.push('下班 ' + r.end);
  return md + ' 忘打卡補登（' + parts.join('、') + '）';
}

/* ── 那一天的打卡：算數的卡與缺哪張（忘打卡用）──
   跨夜班要跨天一起配對（審查 #2）：上班卡後 16 小時內的下班卡算同一段（同 pairShifts／liffMissedDetail_ 的配對視窗），
   段落歸「上班卡那天」；沒配到上班卡的凌晨（≤06:00）下班卡歸前一天。所以 D 晚上上班、D+1 01:00 下班＝D 正常、D+1 不缺卡。 */
var REQ_PAIR_MS = 16 * 3600000;
var REQ_EARLY_OUT_HM = '06:00';
function reqPunchObj_(e) {
  var ts = String(e.ts);
  return { type: String(e.type), hm: ts.slice(11, 16), status: String(e.status), date: ts.slice(0, 10), t: new Date(ts).getTime(),
           distance_m: e.distance_m === '' || e.distance_m === undefined ? null : Number(e.distance_m),
           accuracy_m: e.accuracy_m === '' || e.accuracy_m === undefined ? null : Number(e.accuracy_m) };
}
function reqPrevDate_(d) { var x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - 86400000); return x.toISOString().slice(0, 10); }
function reqNextDate_(d) { var x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + 86400000); return x.toISOString().slice(0, 10); }
/** 這人前後三天的算數卡配對 → 歸到 date 那天的 {punches:畫面顯示用, missing:{options, open_in, lone_out, lone_out_next}} */
function reqDayInfo_(events, empId, date) {
  var lo = reqPrevDate_(date), hi = reqNextDate_(date);
  var all = events.filter(function (e) {
    var d = String(e.ts).slice(0, 10);
    return String(e.emp_id) === String(empId) && d >= lo && d <= hi;
  }).map(reqPunchObj_).filter(function (p) { return !isNaN(p.t); }).sort(function (a, b) { return a.t - b.t; });
  var counted = all.filter(function (p) { return p.status.indexOf('rejected_') !== 0; });
  var segs = [], openIns = [], loneOuts = [], open = null;
  counted.forEach(function (p) {
    if (p.type === 'in') { if (open) openIns.push(open); open = p; return; }
    if (open && p.t - open.t <= REQ_PAIR_MS) { segs.push({ inp: open, outp: p }); open = null; return; }
    if (open) { openIns.push(open); open = null; }
    loneOuts.push(p);
  });
  if (open) openIns.push(open);
  var dayOf = function (p) { return p.type === 'out' && p.hm <= REQ_EARLY_OUT_HM ? reqPrevDate_(p.date) : p.date; };
  var mineIns = openIns.filter(function (p) { return p.date === date; });
  var mineOuts = loneOuts.filter(function (p) { return dayOf(p) === date; });
  var mineSegs = segs.filter(function (x) { return x.inp.date === date; });
  // 顯示：那天的所有卡（含被擋的），加上歸到那天的隔天凌晨下班卡（標 +1）
  var show = all.filter(function (p) { return p.date === date; });
  all.forEach(function (p) {
    if (p.date === hi && (mineSegs.some(function (x) { return x.outp === p; }) || mineOuts.indexOf(p) >= 0)) show.push(p);
  });
  var punches = show.map(function (p) {
    return { type: p.type, hm: p.hm + (p.date !== date ? '(+1)' : ''), status: p.status, distance_m: p.distance_m, accuracy_m: p.accuracy_m };
  });
  var opts = [];
  if (!mineSegs.length && !mineIns.length && !mineOuts.length) opts = ['both'];
  else { if (mineOuts.length) opts.push('in'); if (mineIns.length) opts.push('out'); }
  var lo1 = mineOuts[0], oi = mineIns[mineIns.length - 1];
  return { punches: punches, missing: { options: opts, open_in: oi ? oi.hm : null,
           lone_out: lo1 ? lo1.hm : null, lone_out_next: !!(lo1 && lo1.date !== date) } };
}
function reqDayPunches_(events, empId, date) { return reqDayInfo_(events, empId, date).punches; }

/* ── 同仁：身分 ── */
function reqStaff_(body) {
  if (liffSiteThrottled_()) return { error: 'too_many' };
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { error: 'invalid_id_token' };
  if (liffThrottled_('rq', userId, 30, 60)) return { error: 'too_many' };
  var found = liffRosterByLine_(userId);
  if (found.error) return { error: found.error };
  return { userId: userId, me: found.roster, ss: found.ss };
}

/** {action:'req_info', id_token, date?} → {ok, name, today, requests:[…], day?:{date, punches, missing}} */
function handleReqInfo_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var today = todayTaipeiStr();
  var mine = reqRows_(who.ss).filter(function (r) {
    return String(r.emp_id) === String(who.me.emp_id) && reqDayDiff_(today, String(r.created_at).slice(0, 10) || r.date) <= REQ_LIST_DAYS;
  }).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).map(reqPublic_);
  var out = { ok: true, name: String(who.me.name), emp_id: String(who.me.emp_id), today: today, requests: mine,
              miss_days: REQ_MISS_DAYS, leave_types: LEAVE_TYPES.filter(function (t) { return t !== '出差'; }) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) {
    var di = reqDayInfo_(liffEvents_(who.ss), who.me.emp_id, String(body.date));
    out.day = { date: String(body.date), punches: di.punches, missing: di.missing };
  }
  return out;
}

/** 驗證一筆申請，回 {row} 或 {error, message}。now＝台北日期字串（測試可注入）。 */
function reqValidate_(b, me, events, today, existing) {
  var kind = String(b.kind || '');
  if (!REQ_KINDS_[kind]) return { error: 'bad_kind', message: '申請類別不對' };
  var date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'bad_date', message: '請選日期' };
  var diff = reqDayDiff_(date, today);
  var reason = reqClean_(b.reason, REQ_REASON_MAX);
  var row = { kind: kind, date: date, leave_type: '', start: '', end: '', hours: '', miss_type: '', reason: reason };

  if (kind === 'leave') {
    if (diff < -REQ_LEAVE_PAST_DAYS || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '請假只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    var lt = reqClean_(b.leave_type, 30);
    if (!lt || lt === '出差' || LEAVE_TYPES.indexOf(lt) < 0) return { error: 'bad_leave_type', message: '請選假別' };
    row.leave_type = lt;
    if (b.start || b.end) {
      row.start = reqHm_(b.start); row.end = reqHm_(b.end);
      if (!row.start || !row.end) return { error: 'bad_time', message: '請填完整的請假時段' };
      row.hours = reqSpanHours_(row.start, row.end);
    } else {
      var h = Number(b.hours);
      if (!isFinite(h) || h <= 0 || h > 24) return { error: 'bad_hours', message: '請填請假時數' };
      row.hours = Math.round(h * 4) / 4;
    }
  } else if (kind === 'ot') {
    if (diff < -REQ_LEAVE_PAST_DAYS || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '加班只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    row.start = reqHm_(b.start); row.end = reqHm_(b.end);
    if (!row.start || !row.end) return { error: 'bad_time', message: '請填加班時段' };
    row.hours = reqSpanHours_(row.start, row.end);
    if (row.hours > 12) return { error: 'bad_time', message: '加班時段超過 12 小時，請確認時間' };
    if (!reason) return { error: 'need_reason', message: '加班要寫原因' };
  } else {   // miss
    if (diff > 0) return { error: 'bad_date', message: '不能補登還沒到的日期' };
    if (diff < -REQ_MISS_DAYS) return { error: 'too_old', message: '超過 ' + REQ_MISS_DAYS + ' 天不能申請，請找值班主管直接核定' };
    var mt = String(b.miss_type || '');
    var info = reqDayInfo_(events, me.emp_id, date).missing;
    if (!info.options.length) return { error: 'not_missing', message: '這天的上班卡和下班卡都有打成功，不用補登；時間記錯請直接跟值班主管說' };
    if (info.options.indexOf(mt) < 0) return { error: 'not_missing', message: mt === 'in' ? '這天的上班卡有打成功，不用補登' : mt === 'out' ? '這天的下班卡有打成功，不用補登' : '請選要補哪一張卡' };
    row.miss_type = mt;
    if (mt === 'in' || mt === 'both') { row.start = reqHm_(b.start); if (!row.start) return { error: 'bad_time', message: '請填實際上班時間' }; }
    if (mt === 'out' || mt === 'both') { row.end = reqHm_(b.end); if (!row.end) return { error: 'bad_time', message: '請填實際下班時間' }; }
    // 時間要合理（跨夜：補的下班時間早於上班卡、且在凌晨 06:00 前＝隔天凌晨下班）
    var outNext = false;
    if (mt === 'out' && info.open_in && reqMin_(row.end) <= reqMin_(info.open_in)) {
      if (row.end > REQ_EARLY_OUT_HM) return { error: 'bad_time', message: '補的下班時間 ' + row.end + ' 比當天上班卡 ' + info.open_in + ' 還早' };
      outNext = true;
    }
    if (mt === 'in' && info.lone_out && !info.lone_out_next && reqMin_(row.start) >= reqMin_(info.lone_out.slice(0, 5))) {
      return { error: 'bad_time', message: '補的上班時間 ' + row.start + ' 比當天下班卡 ' + info.lone_out + ' 還晚' };
    }
    if (mt === 'both') {
      if (reqMin_(row.start) === reqMin_(row.end)) return { error: 'bad_time', message: '上班和下班時間一樣，請確認' };
      if (reqMin_(row.end) < reqMin_(row.start)) outNext = true;
    }
    if (diff === 0) {   // 今天：不能補還沒到的時間；跨夜的下班＝明天，還沒到（審查 #3）
      var nowMin = reqMin_(nowTaipeiIso().slice(11, 16));
      if (outNext || (row.end && reqMin_(row.end) > nowMin) || (row.start && reqMin_(row.start) > nowMin)) {
        return { error: 'bad_time', message: '不能補登還沒到的時間' };
      }
    }
    if (!reason) return { error: 'need_reason', message: '請選原因' };
  }
  // 同一天同一類（忘打卡再加同一張卡）不能有兩筆審核中的
  var dup = existing.filter(function (r) {
    return String(r.emp_id) === String(me.emp_id) && r.status === 'pending' && r.kind === kind && r.date === date
        && (kind !== 'miss' || r.miss_type === row.miss_type || r.miss_type === 'both' || row.miss_type === 'both');
  })[0];
  if (dup) return { error: 'duplicate', message: '這天已經有一筆審核中的' + REQ_KINDS_[kind] + '申請，要改請先取消那一筆' };
  return { row: row };
}

/** {action:'req_submit', id_token, kind, date, leave_type?, start?, end?, hours?, miss_type?, reason?, attach_id?} */
function handleReqSubmit_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請幾秒後再送一次' };
  try {
    var v = reqValidate_(body, who.me, liffEvents_(who.ss), todayTaipeiStr(), reqRows_(who.ss));
    if (v.error) return { ok: false, error: v.error, message: v.message };
    var r = v.row;
    r.id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    r.created_at = nowTaipeiIso(); r.emp_id = String(who.me.emp_id); r.name = String(who.me.name);
    r.attach_id = /^[A-Za-z0-9_-]{10,80}$/.test(String(body.attach_id || '')) ? String(body.attach_id) : '';
    r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    var sh = reqSheet_(who.ss, true);
    sh.appendRow(REQ_HEADERS_.map(function (h) { return r[h] === undefined ? '' : r[h]; }));
    return { ok: true, request: reqPublic_(r), summary: reqSummary_(r) };
  } finally { lock.releaseLock(); }
}

/** {action:'req_cancel', id_token, id} → 只能取消自己的、還在審核中的。 */
function handleReqCancel_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var lock = LockService.getScriptLock();   // 與主管審核同一把鎖，鎖內重讀狀態，避免「剛核准就被取消蓋掉」（審查 #4）
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var sh = reqSheet_(who.ss, false);
    var r = reqRows_(who.ss).filter(function (x) { return String(x.id) === String(body.id) && String(x.emp_id) === String(who.me.emp_id); })[0];
    if (!sh || !r) return { ok: false, error: 'not_found', message: '找不到這筆申請' };
    if (r.status !== 'pending') return { ok: false, error: 'not_pending', message: '主管已經處理過這筆，不能取消；要改請找主管' };
    reqSetCells_(sh, r.__rowIndex, { status: 'cancelled', decided_at: nowTaipeiIso(), decided_by: '本人取消' });
    return { ok: true };
  } finally { lock.releaseLock(); }
}

/** 打卡成功時順便告知：主管處理過、同仁還沒看過的結果（看過就標 seen_at，只告知一次）。 */
function reqUnseenNotes_(ss, empId) {
  var sh = reqSheet_(ss, false);
  if (!sh) return [];
  var now = nowTaipeiIso(), notes = [];
  reqRows_(ss).forEach(function (r) {
    if (String(r.emp_id) !== String(empId) || r.seen_at || (r.status !== 'approved' && r.status !== 'rejected')) return;
    notes.push(r.status === 'approved' ? '✓ 主管已核准：' + reqSummary_(r)
                                       : '✕ 申請被退回：' + reqSummary_(r) + (r.reject_reason ? '（' + r.reject_reason + '）' : ''));
    reqSetCells_(sh, r.__rowIndex, { seen_at: now });
  });
  return notes;
}

/* ── 主管 ── */
function reqMgr_(body) {
  var sh = getSS().getSheetByName('managers');
  return sh ? findManagerByKey(readSheetAsObjects(sh).rows, body.mgr_key) : null;
}

/** {action:'mgr_req_pending', mgr_key} → {ok, items:[{…申請, punches:[那天的打卡]}]}（最舊的在前） */
function handleMgrReqPending_(body) {
  if (!reqMgr_(body)) return { ok: false, error: 'unauthorized' };
  var ss = getSS(), rows = reqRows_(ss).filter(function (r) { return r.status === 'pending'; });
  if (!rows.length) return { ok: true, items: [] };
  var events = liffEvents_(ss);
  var items = rows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).map(function (r) {
    var o = reqPublic_(r);
    o.summary = reqSummary_(r);
    o.attach_id = String(r.attach_id || '');   // 主管看附件用（經光復 line_hub_attach_get，會再核對主管金鑰）
    if (reqDayDiff_(r.date, todayTaipeiStr()) <= 0) o.punches = reqDayPunches_(events, r.emp_id, r.date);   // 還沒到的日期沒有打卡可看，不顯示「沒有任何打卡」
    return o;
  });
  return { ok: true, items: items };
}

/** {action:'mgr_req_decide', mgr_key, id, decision:'approve'|'reject', reason?} */
function handleMgrReqDecide_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var decision = String(body.decision || '');
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'bad_decision' };
  var reason = reqClean_(body.reason, REQ_REASON_MAX);
  if (decision === 'reject' && !reason) return { ok: false, error: 'need_reason', message: '退回要寫理由' };
  var ss = getSS(), sh = reqSheet_(ss, false);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var r = reqRows_(ss).filter(function (x) { return String(x.id) === String(body.id); })[0];
    if (!sh || !r) return { ok: false, error: 'not_found', message: '找不到這筆申請' };
    if (r.status !== 'pending') return { ok: false, error: 'not_pending', message: r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了' };
    reqSetCells_(sh, r.__rowIndex, { status: decision === 'approve' ? 'approved' : 'rejected', decided_at: nowTaipeiIso(),
                                     decided_by: String(mgr.name), reject_reason: decision === 'reject' ? reason : '' });
    return { ok: true, id: String(r.id), status: decision === 'approve' ? 'approved' : 'rejected' };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_day', mgr_key, date} → {ok, by_emp:{emp_id:[已核准的申請…]}}（核定頁預填用） */
function handleMgrReqDay_(body) {
  if (!reqMgr_(body)) return { ok: false, error: 'unauthorized' };
  var date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  var by = {};
  reqRows_(getSS()).forEach(function (r) {
    if (r.date !== date || r.status !== 'approved') return;
    var o = reqPublic_(r); o.summary = reqSummary_(r);
    (by[String(r.emp_id)] = by[String(r.emp_id)] || []).push(o);
  });
  return { ok: true, date: date, by_emp: by };
}

/* ── 主管手機出示的動態 QR（定位抓不準時的備案）── */
var REQ_QR_WINDOW_MS = 30000;
var REQ_QR_ACCEPT = 3;   // 接受目前窗與前兩窗（最長 90 秒，掃描、開頁要時間）
/** 這家店在 QR 字串裡的代碼：指令碼屬性 QR_STORE（主管頁第一次產生 QR 時依網址 ?s= 寫入；光復＝gk）。 */
function reqStoreTagFromSheet_() {
  return PropertiesService.getScriptProperties().getProperty('QR_STORE') || 'gk';
}
function reqQrSecret_() {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('QR_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('QR_SECRET', s); }
  return s;
}
function reqQrSig_(tag, win, mgrIdx) {
  var raw = Utilities.computeHmacSha256Signature(tag + '|' + win + '|' + mgrIdx, reqQrSecret_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '').slice(0, 16);
}
/** {action:'mgr_qr_token', mgr_key, store?} → {ok, token, expires_in}（主管頁每 30 秒來拿一次） */
function handleMgrQrToken_(body) {
  var sh = getSS().getSheetByName('managers');
  var rows = sh ? readSheetAsObjects(sh).rows : [];
  var mgr = findManagerByKey(rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var p = PropertiesService.getScriptProperties();
  var tag = /^[a-z]{2,8}$/.test(String(body.store || '')) ? String(body.store) : 'gk';
  if (p.getProperty('QR_STORE') !== tag) p.setProperty('QR_STORE', tag);
  var idx = mgr.__rowIndex || 0, now = Date.now(), win = Math.floor(now / REQ_QR_WINDOW_MS);
  return { ok: true, token: tag + '~' + win + '~' + idx + '~' + reqQrSig_(tag, win, idx),
           expires_in: REQ_QR_WINDOW_MS - (now % REQ_QR_WINDOW_MS), manager: String(mgr.name) };
}
/** 驗 QR 字串：{ok, mgr} 或 {ok:false, reason}。nowMs 可注入（測試）。 */
function reqQrVerify_(token, nowMs) {
  var m = /^([a-z]{2,8})~(\d+)~(\d+)~([A-Za-z0-9_-]{16})$/.exec(String(token || ''));
  if (!m) return { ok: false, reason: 'QR 碼看不懂，請主管重新顯示' };
  if (m[1] !== reqStoreTagFromSheet_()) return { ok: false, reason: '這不是這家店的 QR 碼' };
  var cur = Math.floor((nowMs || Date.now()) / REQ_QR_WINDOW_MS), win = +m[2];
  if (win > cur || cur - win >= REQ_QR_ACCEPT) return { ok: false, reason: 'QR 碼已過期，請主管重新顯示後再掃一次' };
  if (reqQrSig_(m[1], win, +m[3]) !== m[4]) return { ok: false, reason: 'QR 碼不正確，請主管重新顯示' };
  var sh = getSS().getSheetByName('managers'), name = '';
  if (sh) readSheetAsObjects(sh).rows.forEach(function (r) { if (r.__rowIndex === +m[3] && String(r.active).toLowerCase() === 'true') name = String(r.name); });
  if (!name) return { ok: false, reason: '出示 QR 的主管帳號已停用' };
  return { ok: true, mgr: name };
}
var REQ_QR_LOG_SHEET_ = 'qr_punch';
function reqQrLog_(ss, ts, empId, type, mgrName) {
  var sh = ss.getSheetByName(REQ_QR_LOG_SHEET_);
  if (!sh) { sh = ss.insertSheet(REQ_QR_LOG_SHEET_); sh.getRange(1, 1, 1, 4).setValues([['ts', 'emp_id', 'type', 'qr_manager']]); }
  sh.appendRow([ts, empId, type, mgrName]);
}
