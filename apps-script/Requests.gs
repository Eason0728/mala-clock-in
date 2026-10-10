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
// ⚠ 只能往後加欄（2026-10-09 加 comp）：上線前建的 requests 分頁只有前 18 欄，寫入時 reqHeads_ 會自動補表頭
var REQ_HEADERS_ = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours',
                    'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp'];
var REQ_COMP_LEAVE_ = '補休';   // 補休（2026-10-09）：不在 Code.gs LEAVE_TYPES 白名單裡，請假申請另外放行
var REQ_KINDS_ = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡' };
var REQ_MISS_DAYS = 7;          // 忘打卡只能申請 7 天內（含今天）
var REQ_LEAVE_PAST_DAYS = 31;   // 請假可補申請到 31 天前
var REQ_FUTURE_DAYS = 90;       // 請假／加班最遠申請到 90 天後
var REQ_LIST_DAYS = 60;         // 「我的申請」看 60 天
var REQ_REASON_MAX = 100;
var REQ_TRIP_PLACE_MAX = 40;    // 出差地點上限（2026-10-09 Eason）
var REQ_BATCH_MAX = 30;         // 主管批次核准一次最多幾筆
/* 要附證明的假別（2026-10-10 Eason：病假、婚假、喪假、產假相關一定要附證明）。
   可以先送出（看醫生前就得請假），但沒附就不能核准；同仁在「我的申請」補附（req_attach）。
   名稱要與 Code.gs LEAVE_TYPES 一字不差（tests/leave-proof.test.js 會比對）。 */
var REQ_PROOF_TYPES_ = ['病假', '住院傷病假', '公傷病假', '婚假',
  '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）', '喪假（曾祖父母・兄弟姊妹）', '喪假',
  '產假（分娩）', '產假', '流產假（妊娠3個月以上）', '流產假（妊娠2～未滿3個月）', '流產假（妊娠未滿2個月）',
  '產檢假', '陪產檢及陪產假', '安胎休養假'];
var REQ_ATTACH_RE_ = /^[A-Za-z0-9_-]{10,80}$/;
function reqProofType_(r) { return String(r.kind) === 'leave' && REQ_PROOF_TYPES_.indexOf(String(r.leave_type || '')) >= 0; }
/** 這筆還缺證明（要附、還沒附）→ 不能核准 */
function reqNeedsProof_(r) { return reqProofType_(r) && !r.attach_id; }

/* ── 工具 ── */
function reqSheet_(ss, create) {
  var sh = ss.getSheetByName(REQ_SHEET_);
  if (!sh && create) {
    sh = ss.insertSheet(REQ_SHEET_);
    sh.getRange(1, 1, 1, REQ_HEADERS_.length).setValues([REQ_HEADERS_]);
    sh.getRange('A:' + reqColLetter_(REQ_HEADERS_.length)).setNumberFormat('@');   // 日期、時間存成文字，避免 Sheets 自動轉成日期物件（2026-07-15 那個坑）
  }
  return sh;
}
function reqColLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
/** 實際表頭；缺 REQ_HEADERS_ 的欄（舊分頁沒有 comp）就補在最後面（只補表頭、舊列留空＝當作加班費）。 */
function reqHeads_(sh) {
  var last = sh.getLastColumn();
  var heads = last ? sh.getRange(1, 1, 1, last).getValues()[0].map(String) : [];
  var missing = REQ_HEADERS_.filter(function (h) { return heads.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, heads.length + 1, 1, missing.length).setValues([missing]);
    for (var i = 0; i < missing.length; i++) { var L = reqColLetter_(heads.length + 1 + i); sh.getRange(L + ':' + L).setNumberFormat('@'); }
    heads = heads.concat(missing);
  }
  return heads;
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
           reject_reason: String(r.reject_reason || ''), comp: r.kind === 'ot' ? (String(r.comp || '') === 'comp' ? 'comp' : 'pay') : '',
           proof_required: reqProofType_(r), need_proof: reqNeedsProof_(r) };
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
  if (r.kind === 'ot') return md + ' 加班 ' + r.start + '–' + r.end + '（' + Number(r.hours) + ' 小時）' + (String(r.comp || '') === 'comp' ? '（換補休）' : '');
  if (r.kind === 'trip') {
    var place = reqTripPlace_(r.reason);
    return md + ' 出差' + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時' + (place ? '（地點：' + place + '）' : '');
  }
  var parts = [];
  if (r.miss_type === 'in' || r.miss_type === 'both') parts.push('上班 ' + r.start);
  if (r.miss_type === 'out' || r.miss_type === 'both') parts.push('下班 ' + r.end);
  return md + ' 忘打卡補登（' + parts.join('、') + '）';
}

/** 出差單的地點、事由存在 reason 欄：'地點：<地點>；事由：<事由>'（沿用既有欄位，不加欄）。 */
function reqTripReason_(place, why) { return '地點：' + place + '；事由：' + why; }
function reqTripPlace_(reason) { var m = /^地點：(.*?)；事由：/.exec(String(reason || '')); return m ? m[1] : ''; }

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
              miss_days: REQ_MISS_DAYS, leave_types: LEAVE_TYPES.filter(function (t) { return t !== '出差'; }),
              proof_types: REQ_PROOF_TYPES_.slice() };
  if (reqIsDate_(body.date)) {
    var di = reqDayInfo_(liffEvents_(who.ss), who.me.emp_id, String(body.date));
    out.day = { date: String(body.date), punches: di.punches, missing: di.missing };
  }
  return out;
}

/** yyyy-MM-dd 而且是真的存在的日子（2026-10-10 Codex 審查 #13：只看外形會收 2026-11-31，範圍判斷當 12/1、表裡卻寫 11/31）。 */
function reqIsDate_(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 驗證一筆申請，回 {row} 或 {error, message}。now＝台北日期字串（測試可注入）。 */
function reqValidate_(b, me, events, today, existing) {
  var kind = String(b.kind || '');
  if (!REQ_KINDS_[kind]) return { error: 'bad_kind', message: '申請類別不對' };
  var date = String(b.date || '');
  if (!reqIsDate_(date)) return { error: 'bad_date', message: '請選日期' };
  var diff = reqDayDiff_(date, today);
  var reason = reqClean_(b.reason, REQ_REASON_MAX);
  var row = { kind: kind, date: date, leave_type: '', start: '', end: '', hours: '', miss_type: '', reason: reason, comp: '' };

  if (kind === 'leave') {
    if (diff < -REQ_LEAVE_PAST_DAYS || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '請假只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    var lt = reqClean_(b.leave_type, 30);
    if (!lt || lt === '出差' || (LEAVE_TYPES.indexOf(lt) < 0 && lt !== REQ_COMP_LEAVE_)) return { error: 'bad_leave_type', message: '請選假別' };
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
    // 補休（2026-10-09）：加班費／換補休（預設加班費）。店家後端不知道誰是正職——計時同仁就算送了 comp，薪資也一律當加班費。
    row.comp = String(b.comp || '') === 'comp' ? 'comp' : 'pay';
  } else if (kind === 'trip') {
    // 出差（2026-10-09）：存成 leave_type＝出差；核准後核定頁預填「出差」＋時數（出差時數與上班時段相加，整天出差可以沒有時段）
    if (diff < -REQ_LEAVE_PAST_DAYS || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '出差只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    row.leave_type = '出差';
    if (b.start || b.end) {
      row.start = reqHm_(b.start); row.end = reqHm_(b.end);
      if (!row.start || !row.end) return { error: 'bad_time', message: '請填完整的出差時段' };
      row.hours = reqSpanHours_(row.start, row.end);
    } else {
      var th = Number(b.hours);
      if (!isFinite(th) || th <= 0 || th > 24) return { error: 'bad_hours', message: '請填出差時數' };
      row.hours = Math.round(th * 4) / 4;
    }
    var place = reqClean_(b.place, 200).replace(/；/g, '，');
    if (!place) return { error: 'need_place', message: '請填出差地點' };
    if (place.length > REQ_TRIP_PLACE_MAX) return { error: 'bad_place', message: '地點最多 ' + REQ_TRIP_PLACE_MAX + ' 個字' };
    var why = reqClean_(b.why, REQ_REASON_MAX);
    if (!why) return { error: 'need_reason', message: '請填出差事由' };
    row.reason = reqTripReason_(place, why);
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
    // 補休餘額：只有和薪資同一個專案的店（光復）查得到，盡量擋；其他店靠 LINE 申請頁（光復算餘額）與值班主管核定時再擋一次
    if (r.kind === 'leave' && r.leave_type === REQ_COMP_LEAVE_) {
      var cb = reqCompBalance_(who.me);
      if (cb && !cb.allowed) return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
      if (cb && Number(r.hours) > cb.balance_h) return { ok: false, error: 'comp_not_enough', message: '補休餘額只剩 ' + cb.balance_h + ' 小時，不夠請 ' + Number(r.hours) + ' 小時' };
    }
    r.id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    r.created_at = nowTaipeiIso(); r.emp_id = String(who.me.emp_id); r.name = String(who.me.name);
    r.attach_id = REQ_ATTACH_RE_.test(String(body.attach_id || '')) ? String(body.attach_id) : '';
    r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    var sh = reqSheet_(who.ss, true);
    sh.appendRow(reqHeads_(sh).map(function (h) { return r[h] === undefined ? '' : r[h]; }));   // 照實際表頭寫（舊分頁沒有 comp 欄會先補）
    return { ok: true, request: reqPublic_(r), summary: reqSummary_(r) };
  } finally { lock.releaseLock(); }
}

/** 補休餘額（盡量擋）：和薪資同專案（光復）才查得到 → {allowed, balance_h}；查不到／出錯回 null＝不擋（交給申請頁與主管）。 */
function reqCompBalance_(me) {
  try {
    if (typeof payCompStatus !== 'function' || typeof payRead !== 'function') return null;
    var m = payRead('master').filter(function (x) { return String(x.emp_id) === String(me.emp_id); })[0];
    if (!m) return null;
    return payCompStatus(payCompBook(), m, m.store, payCompToday());
  } catch (e) { return null; }
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

/** {action:'req_attach', id_token, id, attach_id} → 補附證明：只能補自己的、審核中的請假（附件先傳光復 line_hub_attach_put 拿 ID）。
 *  已經有附件的也可以換一張（主管看最新的）。與主管審核同一把鎖。 */
function handleReqAttach_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var aid = String(body.attach_id || '');
  if (!REQ_ATTACH_RE_.test(aid)) return { ok: false, error: 'bad_attach', message: '附件沒有上傳成功，請再試一次' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var sh = reqSheet_(who.ss, false);
    var r = reqRows_(who.ss).filter(function (x) { return String(x.id) === String(body.id) && String(x.emp_id) === String(who.me.emp_id); })[0];
    if (!sh || !r) return { ok: false, error: 'not_found', message: '找不到這筆申請' };
    if (r.kind !== 'leave') return { ok: false, error: 'not_leave', message: '只有請假可以補附證明' };
    if (r.status !== 'pending') return { ok: false, error: 'not_pending', message: '主管已經處理過這筆，不能再補附' };
    reqSetCells_(sh, r.__rowIndex, { attach_id: aid });
    r.attach_id = aid;
    return { ok: true, request: reqPublic_(r) };
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
    if (decision === 'approve' && reqNeedsProof_(r)) return { ok: false, error: 'need_proof', message: r.leave_type + '要附證明，同仁補上後才能核准（退回不受影響）' };
    reqSetCells_(sh, r.__rowIndex, { status: decision === 'approve' ? 'approved' : 'rejected', decided_at: nowTaipeiIso(),
                                     decided_by: String(mgr.name), reject_reason: decision === 'reject' ? reason : '' });
    return { ok: true, id: String(r.id), status: decision === 'approve' ? 'approved' : 'rejected' };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_decide_batch', mgr_key, ids:[…], decision:'approve'} → {ok, done:[ids], skipped:[{id, reason}]}
 *  批次只能核准（2026-10-09 Eason）：退回要寫理由，一筆一筆退。一把鎖、鎖內重讀，不是審核中的就略過並說明原因。 */
function handleMgrReqDecideBatch_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  if (String(body.decision || '') !== 'approve') return { ok: false, error: 'bad_decision', message: '批次只能核准；退回請一筆一筆處理' };
  var ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  ids = ids.filter(function (x, i) { return x && ids.indexOf(x) === i; });
  if (!ids.length) return { ok: false, error: 'no_ids', message: '請先勾選要核准的申請' };
  if (ids.length > REQ_BATCH_MAX) return { ok: false, error: 'too_many_ids', message: '一次最多核准 ' + REQ_BATCH_MAX + ' 筆' };
  var ss = getSS(), sh = reqSheet_(ss, false);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var byId = {};
    reqRows_(ss).forEach(function (x) { byId[String(x.id)] = x; });
    var now = nowTaipeiIso(), done = [], skipped = [];
    ids.forEach(function (id) {
      var r = byId[id];
      if (!sh || !r) { skipped.push({ id: id, reason: '找不到這筆申請' }); return; }
      if (r.status !== 'pending') { skipped.push({ id: id, reason: r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了' }); return; }
      if (reqNeedsProof_(r)) { skipped.push({ id: id, reason: r.leave_type + '還沒附證明' }); return; }
      reqSetCells_(sh, r.__rowIndex, { status: 'approved', decided_at: now, decided_by: String(mgr.name), reject_reason: '' });
      done.push(id);
    });
    return { ok: true, done: done, skipped: skipped };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_day', mgr_key, date} → {ok, by_emp:{emp_id:[已核准的申請…]}}（核定頁預填用） */
function handleMgrReqDay_(body) {
  if (!reqMgr_(body)) return { ok: false, error: 'unauthorized' };
  var date = String(body.date || '');
  if (!reqIsDate_(date)) return { ok: false, error: 'bad_date' };
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

/* ── 下班打卡後提示申請加班（2026-10-09 Eason）──
   當天出勤超過 8 小時（全部門市一律 8 小時，先不看班表）、這天還沒有審核中／已核准的加班申請 → 打卡畫面多一顆「申請加班」，預填時段。
   「那天」＝這張下班卡配到的上班卡那天（跨夜班歸上班那天，同 reqDayInfo_ 的 16 小時配對）；那天所有完整的上班→下班段加總（含這一段）。
   預填：end＝這次下班時間；start＝end 往前推（總時數−8）＝剛好滿 8 小時的時刻，往前取整到 :00／:15／:30／:45。
   events 要含這次這張下班卡。回 {date, hours, start, end} 或 null。 */
var REQ_OT_HINT_H = 8;
function reqOtHint_(events, empId, outTs, rows) {
  var outMs = new Date(String(outTs)).getTime();
  if (isNaN(outMs)) return null;
  var counted = events.filter(function (e) {
    return String(e.emp_id) === String(empId) && String(e.status).indexOf('rejected_') !== 0;
  }).map(reqPunchObj_).filter(function (p) { return !isNaN(p.t) && p.t <= outMs && p.t >= outMs - 3 * REQ_PAIR_MS; })
    .sort(function (a, b) { return a.t - b.t; });
  var segs = [], open = null;
  counted.forEach(function (p) {
    if (p.type === 'in') { open = p; return; }
    if (open && p.t - open.t <= REQ_PAIR_MS) segs.push({ inp: open, outp: p });
    open = null;
  });
  var mine = segs.filter(function (x) { return x.outp.t === outMs; })[0];
  if (!mine) return null;
  var date = mine.inp.date, ms = 0;
  segs.forEach(function (x) { if (x.inp.date === date) ms += x.outp.t - x.inp.t; });
  var hours = Math.round(ms / 36000) / 100;
  if (hours <= REQ_OT_HINT_H) return null;
  var has = (rows || []).some(function (r) {
    return String(r.emp_id) === String(empId) && r.kind === 'ot' && r.date === date && (r.status === 'pending' || r.status === 'approved');
  });
  if (has) return null;
  var end = String(outTs).slice(11, 16);
  var startMin = reqMin_(end) - (ms - REQ_OT_HINT_H * 3600000) / 60000;
  startMin = ((Math.floor(startMin / 15) * 15) % 1440 + 1440) % 1440;
  var start = ('0' + Math.floor(startMin / 60)).slice(-2) + ':' + ('0' + (startMin % 60)).slice(-2);
  return { date: date, hours: hours, start: start, end: end };
}

/* ── 本月待核定提醒：補上「已核准的申請、那天還沒核定」（2026-10-10 Codex 審查）──
   原本 mgr_pending_approvals 只看有打卡的日子；整天請假／整天出差核准後當天沒有卡，主管不核定那天就不會進薪資，也不會被提醒。
   包在 Code.gs handleMgrPendingApprovals 外面（LIFF_HANDLERS 會覆蓋同名動作），各店程式碼.js 不用改。加班申請不算（加班一定有卡）。 */
function reqPendingApprovalsPlus_(body) {
  var r = handleMgrPendingApprovals(body);
  if (!r || !r.ok) return r;
  try {
    var ss = getSS();
    var ash = ss.getSheetByName('approved');
    var approvedMap = buildLatestApprovedMap(ash ? readSheetAsObjects(ash).rows : []);
    var have = {};
    r.items.forEach(function (x) { have[x.date + '|' + x.emp_id] = true; });
    reqRows_(ss).forEach(function (q) {
      var d = String(q.date || ''), id = String(q.emp_id || '');
      if (q.status !== 'approved' || q.kind === 'ot' || !d || !id) return;
      if (d.slice(0, 7) !== r.ym || d >= r.today || have[d + '|' + id]) return;
      if ((approvedMap[d] || {})[id]) return;
      have[d + '|' + id] = true;
      r.items.push({ date: d, emp_id: id, name: String(q.name || id), from_request: true });
    });
    r.items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
  } catch (e) { /* 讀申請失敗不影響原本的提醒 */ }
  return r;
}
