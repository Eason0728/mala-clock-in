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
                    'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp',
                    'voided_at', 'voided_by', 'void_reason',   // 作廢已核准的申請（2026-10-26）：decided_* 保留原核准紀錄
                    'proxy_by'];   // 主管代開（2026-11-06）：代開人姓名；有值＝只有總監層級能審
var REQ_COMP_LEAVE_ = '補休';   // 補休（2026-10-09）：不在 Code.gs LEAVE_TYPES 白名單裡，請假申請另外放行
var REQ_KINDS_ = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡' };
var REQ_MISS_DAYS = 7;          // 忘打卡只能申請 7 天內（含今天）
var REQ_LEAVE_PAST_DAYS = 7;    // 請假／加班／出差可補申請到 7 天前（2026-11-05 Eason：原本 31 天）
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
/* 病假（2026-11-06 Eason 照人資作業辦法）：今年（同一個日曆年）累計滿 3 天才要附證明——今年第 3 個請病假的日子起要附，
   前兩天不用。「天」＝不同的日期（半天也算一天）；算審核中＋已核准（退回、取消、作廢的不算）；只看這家店的申請表。
   其他 15 種要證明的假別不變（一律要附）。reqRows_ 讀表時就幫每筆病假標好 __sick_n（今年第幾天）。 */
var REQ_SICK_TYPE_ = '病假';
var REQ_SICK_PROOF_DAYS = 1;   // 2026-11-08 Eason（3-6）：每張病假都要附
var REQ_SICK_LIVE_ = { pending: 1, approved: 1 };
/** 這個人今年（date 那年）審核中／已核准的病假日期（不重複、排序；不含 exceptId 那筆）。 */
function reqSickDates_(rows, empId, date, exceptId) {
  var yr = String(date || '').slice(0, 4), seen = {};
  (rows || []).forEach(function (x) {
    if (String(x.emp_id) !== String(empId) || String(x.kind) !== 'leave' || String(x.leave_type || '') !== REQ_SICK_TYPE_) return;
    if (!REQ_SICK_LIVE_[String(x.status)] || (exceptId && String(x.id) === String(exceptId))) return;
    var d = String(x.date || '').slice(0, 10);
    if (d.slice(0, 4) === yr) seen[d] = 1;
  });
  return Object.keys(seen).sort();
}
/** 這筆病假是今年第幾天：今年比它早的病假日期數＋1（同一天兩張都算同一天）。 */
function reqSickNth_(rows, r) {
  var d = String(r.date || '').slice(0, 10);
  return reqSickDates_(rows, r.emp_id, d, r.id).filter(function (x) { return x < d; }).length + 1;
}
/* 只提醒、不擋（2026-11-06 Eason，人資作業辦法）：同仁送單與主管審核時黃字。
   事假應前一天請（送出那天＞＝請假那天）；出差應前一週填（送出到出差不到 7 天）；本月事假第 3 次起、或本月事假合計超過 3 天（8 小時一天）。
   忘打卡：本月第幾次（同一人、同一個月、審核中＋已核准的忘打卡申請，依日期排；一張申請算一次）。 */
var REQ_PERSONAL_TYPE_ = '事假';
var REQ_PERSONAL_WARN_N = 3;      // 本月第 3 次起
var REQ_PERSONAL_WARN_DAYS = 3;   // 本月合計超過 3 天
var REQ_TRIP_MAX_H = 8;           // 每次出差工作時間上限（出勤規範 5-1）
var REQ_TRIP_AHEAD_DAYS = 7;      // 出差應前一週填
/** 同一人、同月、同類（match）、審核中＋已核准的申請裡，r 排第幾（日期、送出時間先後；r 自己不在 rows 裡也能算）。回 {n, hours}（hours＝那個月全部的時數）。 */
function reqMonthNth_(rows, r, match) {
  var ym = String(r.date || '').slice(0, 7), d = String(r.date || '').slice(0, 10), c = String(r.created_at || ''), n = 1, hrs = Number(r.hours) || 0;
  (rows || []).forEach(function (x) {
    if (String(x.id) === String(r.id) || String(x.emp_id) !== String(r.emp_id) || !match(x) || !REQ_SICK_LIVE_[String(x.status)]) return;
    var xd = String(x.date || '').slice(0, 10);
    if (xd.slice(0, 7) !== ym) return;
    hrs += Number(x.hours) || 0;
    if (xd < d || (xd === d && String(x.created_at || '') < c)) n++;
  });
  return { n: n, hours: hrs };
}
function reqIsPersonal_(x) { return String(x.kind) === 'leave' && String(x.leave_type || '') === REQ_PERSONAL_TYPE_; }
function reqIsMiss_(x) { return String(x.kind) === 'miss'; }
/** 這張忘打卡單的日子是本月第幾天忘刷（同一天多張算同一天，依日期先後；審核中與已核准都算）（2026-11-10 Eason：同薪資「同一天只算 1 次」） */
function reqMissDayNth_(rows, r) {
  var ym = String(r.date || '').slice(0, 7), d = String(r.date || '').slice(0, 10), days = {};
  days[d] = true;
  (rows || []).forEach(function (x) {
    if (String(x.emp_id) !== String(r.emp_id) || !reqIsMiss_(x) || !REQ_SICK_LIVE_[String(x.status)]) return;
    var xd = String(x.date || '').slice(0, 10);
    if (xd.slice(0, 7) === ym && xd <= d) days[xd] = true;
  });
  return Object.keys(days).length;
}
/** 一筆申請標上 __sick_n（病假今年第幾天）、__miss_n（本月第幾次忘打卡）、__pl（本月事假 {n, hours}）。rows＝同一店的申請（可不含 r）。 */
function reqMarkOne_(rows, r) {
  if (String(r.kind) === 'leave' && String(r.leave_type || '') === REQ_SICK_TYPE_) r.__sick_n = reqSickNth_(rows, r);
  if (reqIsMiss_(r)) r.__miss_n = reqMissDayNth_(rows, r);
  if (reqIsPersonal_(r)) r.__pl = reqMonthNth_(rows, r, reqIsPersonal_);
  return r;
}
function reqSickMark_(rows) {
  rows.forEach(function (r) { reqMarkOne_(rows, r); });
  return rows;
}
/** 黃字提醒（不擋）：字串陣列。r 要先經 reqMarkOne_。 */
function reqWarns_(r) {
  var out = [], made = String(r.created_at || '').slice(0, 10), d = String(r.date || '').slice(0, 10);
  if (reqIsPersonal_(r)) {
    if (made && d && made >= d) out.push('事假應在前一天請（這張是' + (made === d ? '當天' : '事後') + '才送）');
    var pl = r.__pl;
    if (pl && pl.n >= REQ_PERSONAL_WARN_N) out.push('本月第 ' + pl.n + ' 次事假');
    if (pl && pl.hours > REQ_PERSONAL_WARN_DAYS * 8) out.push('本月事假合計 ' + (Math.round(pl.hours / 8 * 10) / 10) + ' 天，超過 ' + REQ_PERSONAL_WARN_DAYS + ' 天');
  }
  if (String(r.kind) === 'trip' && made && d) {
    var ahead = reqDayDiff_(d, made);
    if (ahead < REQ_TRIP_AHEAD_DAYS) out.push('出差應在一週前填（' + (ahead > 0 ? '只提前 ' + ahead + ' 天' : ahead === 0 ? '當天才填' : '事後才填') + '）');
  }
  return out;
}
function reqProofType_(r) {
  if (String(r.kind) !== 'leave' || REQ_PROOF_TYPES_.indexOf(String(r.leave_type || '')) < 0) return false;
  if (String(r.leave_type) === REQ_SICK_TYPE_) return !(r.__sick_n > 0) || r.__sick_n >= REQ_SICK_PROOF_DAYS;   // 沒標到（不該發生）＝照舊要附
  return true;
}
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
  return reqSickMark_(readSheetAsObjects(sh).rows.map(function (r) {
    r.date = normCellDate(r.date); r.created_at = String(normCellTs(r.created_at) || '');
    r.start = reqHm_(r.start); r.end = reqHm_(r.end);
    return r;
  }));
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
/** 兩個時段有沒有重疊（end ≤ start＝跨夜到隔天）；任一邊沒有完整時段回 null。 */
function reqOverlap_(s1, e1, s2, e2) {
  var a = reqMin_(s1), b = reqMin_(e1), c = reqMin_(s2), d = reqMin_(e2);
  if (a === null || b === null || c === null || d === null) return null;
  if (b <= a) b += 1440;
  if (d <= c) d += 1440;
  // 2026-11-11（B29）：其中一段跨夜到隔天凌晨時，另一段寫的凌晨時間（例：22:00–01:00 與 00:00–02:00）也要當成同一個凌晨來比，
  // 不然凌晨那一小時會被當成不重疊、兩張都收。兩段都沒跨夜時，往後挪一天一定碰不到，結果和原本一樣。
  return (a < d && c < b) || (a < d + 1440 && c + 1440 < b) || (a + 1440 < d && c < b + 1440);
}
/** 同一天、同一類的兩筆申請是不是「同一件事」（給已核准的重複檢查用，2026-11-03）：
 *  加班＝時段重疊；請假／出差＝同假別且時段重疊（任一筆只填時數、沒有時段＝當成同一件）；
 *  忘打卡＝補同一張卡（任一筆是「兩張都補」也算），補中間休息＝休息時段重疊。 */
function reqSameThing_(kind, a, b) {
  if (kind === 'miss') {
    if (a.miss_type === 'break' || b.miss_type === 'break') {
      return a.miss_type === b.miss_type && reqOverlap_(a.end, a.start, b.end, b.start) !== false;   // break：end＝休息開始、start＝回來
    }
    // 2026-11-11（B02）：兩段班一天可能漏兩張同型的卡，不能只看類型。同一張卡＝類型、時間都一樣，
    // 或兩張整段的時間重疊。「這張卡已經有人補了」由 reqValidate_ 把已送出的申請當成虛擬卡來擋。
    if (a.miss_type !== b.miss_type) return false;
    if (a.miss_type === 'both') return reqOverlap_(a.start, a.end, b.start, b.end) !== false;
    return String(a.start || '') === String(b.start || '') && String(a.end || '') === String(b.end || '');
  }
  if ((kind === 'leave' || kind === 'trip') && String(a.leave_type || '') !== String(b.leave_type || '')) return false;
  return reqOverlap_(a.start, a.end, b.start, b.end) !== false;
}
function reqDupLabel_(r) {
  if (r.kind === 'miss') return r.miss_type === 'break' ? '補中間休息 ' + r.end + '–' + r.start : '補' + ({ in: '上班卡', out: '下班卡', both: '上下班卡' }[r.miss_type] || '卡');
  var t = r.start && r.end ? r.start + '–' + r.end : (r.hours ? r.hours + ' 小時' : '');
  return (r.kind === 'ot' ? '' : (r.leave_type || '') + ' ') + t;
}
function reqDayDiff_(a, b) {   // 日期字串 a − b 的天數
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000);
}
/** 寫進試算表前的文字防護（2026-10-29 審查）：= + - @ 開頭的字串 Sheets 會當公式跑（例如原因欄填 =IMPORTDATA(...) 就能把名冊送出去）。
 *  第一個字換成全形（＝＋－＠），同仁看得懂、讀回來也不會變；數字、空值照舊。寫入點（appendRow／reqSetCells_）都要過這關。
 *  attach_id 例外：雲端硬碟檔案 ID 可能是 - 開頭，換掉就找不到檔案；它已經過 REQ_ATTACH_RE_，只有英數 _ -，不會是公式。 */
var REQ_SHEET_WIDE_ = { '=': '＝', '+': '＋', '-': '－', '@': '＠' };
function reqSheetText_(v, key) {
  if (typeof v !== 'string' || key === 'attach_id') return v;
  var m = /^(\s*)([=+\-@])/.exec(v);
  return m ? m[1] + REQ_SHEET_WIDE_[m[2]] + v.slice(m[0].length) : v;
}
/** 請假／出差「只一段」的時段檢查（2026-10-30 審查）：起訖一樣原本算成 24 小時、照扣特休；比照加班上限 12 小時。
 *  跨夜（22:00–02:00）照舊算 4 小時。回 {hours} 或 {error, message}。 */
function reqSpanCheck_(start, end, what) {
  if (start === end) return { error: 'bad_time', message: what + '的開始和結束時間一樣，請確認' };
  var hrs = reqSpanHours_(start, end);
  if (hrs > 12) return { error: 'bad_time', message: what + '時段超過 12 小時，請確認時間；一整天請選「整天」填時數' };
  return { hours: hrs };
}
function reqClean_(v, max) { return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function reqPublic_(r) {
  return { id: String(r.id), created_at: String(r.created_at), emp_id: String(r.emp_id), name: String(r.name), kind: String(r.kind),
           date: String(r.date), leave_type: String(r.leave_type || ''), start: r.start, end: r.end,
           hours: r.hours === '' || r.hours === null || r.hours === undefined ? null : Number(r.hours),
           miss_type: String(r.miss_type || ''), reason: String(r.reason || ''), has_attach: !!r.attach_id,
           status: String(r.status), decided_at: String(normCellTs(r.decided_at) || ''), decided_by: String(r.decided_by || ''),
           reject_reason: String(r.reject_reason || ''),
           proof_required: reqProofType_(r), need_proof: reqNeedsProof_(r), sick_n: r.__sick_n || null,
           miss_n: r.__miss_n || null, warns: reqWarns_(r),
           voided_at: String(normCellTs(r.voided_at) || ''), voided_by: String(r.voided_by || ''), void_reason: String(r.void_reason || ''),
           proxy_by: String(r.proxy_by || '') };
}
function reqSetCells_(sh, rowIndex, patch) {
  var heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  Object.keys(patch).forEach(function (k) {
    var c = heads.indexOf(k);
    if (c >= 0) sh.getRange(rowIndex, c + 1).setValue(reqSheetText_(patch[k], k));
  });
}
/** 一句話描述一筆申請（主管頁、我的申請、打卡後告知共用）。 */
function reqSummary_(r) { return reqSummaryBase_(r) + (r.proxy_by ? '（主管代開）' : ''); }
function reqSummaryBase_(r) {
  var md = parseInt(String(r.date).slice(5, 7), 10) + '/' + parseInt(String(r.date).slice(8, 10), 10);
  if (r.kind === 'leave') return md + ' ' + r.leave_type + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時';
  if (r.kind === 'ot') return md + ' 加班 ' + r.start + '–' + r.end + '（' + Number(r.hours) + ' 小時）';
  if (r.kind === 'trip') {
    var place = reqTripPlace_(r.reason);
    return md + ' 出差' + (r.start ? ' ' + r.start + '–' + r.end : ' 整天') + ' ' + Number(r.hours) + ' 小時' + (place ? '（地點：' + place + '）' : '');
  }
  if (r.miss_type === 'break') return md + ' 忘打卡補登（中間休息：下班 ' + r.end + '、回來上班 ' + r.start + '）';
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
           virtual: e.__virtual === true,
           distance_m: e.distance_m === '' || e.distance_m === undefined ? null : Number(e.distance_m),
           accuracy_m: e.accuracy_m === '' || e.accuracy_m === undefined ? null : Number(e.accuracy_m) };
}
function reqPrevDate_(d) { var x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - 86400000); return x.toISOString().slice(0, 10); }
function reqNextDate_(d) { var x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + 86400000); return x.toISOString().slice(0, 10); }
/** 這人已送出（審核中或已核准）的忘打卡申請 → 當成已經補上的卡（虛擬卡，2026-11-11 B02）。
 *  只給「那天還缺哪張卡」用：兩段班一天漏好幾張時，補了一張之後才看得出還缺哪一張；畫面上的當天紀錄不列這些。
 *  in＝上班卡；out＝下班卡（凌晨 06:00 前、而且當天有比它晚的上班卡＝隔天凌晨）；both＝上班＋下班（下班早於上班＝隔天）；
 *  break＝休息開始的下班卡＋回來的上班卡。同一分鐘時下班卡排在上班卡前面（上班卡記在那一分鐘的最後一秒）。 */
function reqMissVirtual_(rows, events, empId, date) {
  var lo = reqPrevDate_(date), hi = reqNextDate_(date), out = [];
  var card = function (d, hm, type) { out.push({ ts: d + 'T' + hm + (type === 'in' ? ':59' : ':00') + '+08:00', emp_id: empId, type: type, status: 'ok', __virtual: true }); };
  (rows || []).forEach(function (r) {
    if (String(r.emp_id) !== String(empId) || r.kind !== 'miss' || (r.status !== 'pending' && r.status !== 'approved')) return;
    var d = String(r.date).slice(0, 10);
    if (d < lo || d > hi) return;
    var st = reqHm_(r.start), en = reqHm_(r.end), mt = String(r.miss_type || '');
    if (mt === 'in' && st) card(d, st, 'in');
    if (mt === 'out' && en) {
      var next = en <= REQ_EARLY_OUT_HM && events.some(function (e) {
        var ts = String(e.ts);
        return String(e.emp_id) === String(empId) && String(e.type) === 'in' && String(e.status).indexOf('rejected_') !== 0
            && ts.slice(0, 10) === d && ts.slice(11, 16) >= en;
      });
      card(next ? reqNextDate_(d) : d, en, 'out');
    }
    if (mt === 'both' && st && en) { card(d, st, 'in'); card(reqMin_(en) < reqMin_(st) ? reqNextDate_(d) : d, en, 'out'); }
    if (mt === 'break' && st && en) { card(d, en, 'out'); card(reqMin_(st) < reqMin_(en) ? reqNextDate_(d) : d, st, 'in'); }
  });
  return out;
}
/** 這人前後三天的算數卡配對 → 歸到 date 那天的 {punches:畫面顯示用, missing:{options, open_in, lone_out, lone_out_next, open_ins, lone_outs, spans}}
 *  virtual（選填）：reqMissVirtual_ 的虛擬卡，一起配對、但不列在 punches。 */
function reqDayInfo_(events, empId, date, virtual) {
  var lo = reqPrevDate_(date), hi = reqNextDate_(date);
  var all = events.filter(function (e) {
    var d = String(e.ts).slice(0, 10);
    return String(e.emp_id) === String(empId) && d >= lo && d <= hi;
  }).concat(virtual || []).map(reqPunchObj_).filter(function (p) { return !isNaN(p.t); })
    .sort(function (a, b) { return a.t - b.t || (a.type === b.type ? 0 : a.type === 'out' ? -1 : 1); });
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
  var show = all.filter(function (p) { return p.date === date && !p.virtual; });
  all.forEach(function (p) {
    if (p.date === hi && !p.virtual && (mineSegs.some(function (x) { return x.outp === p; }) || mineOuts.indexOf(p) >= 0)) show.push(p);
  });
  var punches = show.map(function (p) {
    return { type: p.type, hm: p.hm + (p.date !== date ? '(+1)' : ''), status: p.status, distance_m: p.distance_m, accuracy_m: p.accuracy_m };
  });
  var opts = [];
  if (!mineSegs.length && !mineIns.length && !mineOuts.length) opts = ['both'];
  else { if (mineOuts.length) opts.push('in'); if (mineIns.length) opts.push('out'); }
  // 中間休息沒打卡（2026-11-02 Eason）：那天有上班卡（整段，或還在上班中）就能補「下班＋回來上班」一組
  var vmark = function (sp, v) { if (v) sp.virtual = true; return sp; };   // 真的卡維持原本三個欄位；申請換來的段才多 virtual:true
  var spans = mineSegs.map(function (x) { return vmark({ in: x.inp.hm, out: x.outp.hm, out_next: x.outp.date !== date }, x.inp.virtual && x.outp.virtual); })
    .concat(mineIns.map(function (p) { return vmark({ in: p.hm, out: null, out_next: false }, p.virtual); }));
  if (spans.length) opts.push('break');
  // 另一段班整段沒打（2026-11-10 Eason）：當天打卡都是完整的段時，也能補一整段上班＋下班（不能和已打的段重疊）
  if (mineSegs.length && !mineIns.length && !mineOuts.length) opts.push('both');
  var lo1 = mineOuts[0], oi = mineIns[mineIns.length - 1];
  return { punches: punches, missing: { options: opts, open_in: oi ? oi.hm : null,
           lone_out: lo1 ? lo1.hm : null, lone_out_next: !!(lo1 && lo1.date !== date), spans: spans,
           open_ins: mineIns.map(function (p) { return p.hm; }),
           lone_outs: mineOuts.map(function (p) { return { hm: p.hm, next: p.date !== date }; }) } };
}
function reqDayPunches_(events, empId, date) { return reqDayInfo_(events, empId, date).punches; }

/** 中間休息：休息開始 out、回來上班 inn 要落在某一段班裡（上班卡之後、下班卡之前），而且 out 早於 inn。
 *  用「從上班卡起算幾分鐘」比，跨夜班也對。回 {span, next}（next＝回來時間在隔天）或 {error, message}。 */
function reqBreakSpan_(spans, out, inn) {
  var rel = function (hm, base) { return (reqMin_(hm) - reqMin_(base) + 1440) % 1440; };
  // 2026-11-11（B37）：只有上班卡、還沒下班的那一段，休息要在上班卡之後的 16 小時內（REQ_PAIR_MS，同打卡配對的上限）。
  // 原本當成 24 小時，比上班卡還早的時間（09:00 對 10:00 上班）繞一圈也算「在這段班裡」。
  var OPEN = REQ_PAIR_MS / 60000;
  for (var i = spans.length - 1; i >= 0; i--) {
    var sp = spans[i], a = rel(out, sp.in), b = rel(inn, sp.in), len = sp.out ? rel(sp.out, sp.in) || 1440 : OPEN;
    if (a > 0 && b > a && b < len) return { span: sp, next: reqMin_(sp.in) + b >= 1440 };
  }
  if (spans.length === 1) {
    var s0 = spans[0], a0 = rel(out, s0.in), b0 = rel(inn, s0.in), l0 = s0.out ? rel(s0.out, s0.in) || 1440 : OPEN;
    if (a0 > 0 && a0 < l0 && b0 > 0 && b0 < l0) return { error: 'bad_time', message: '回來上班時間要比休息開始晚' };
    return { error: 'bad_time', message: '休息時間要在 ' + s0.in + (s0.out ? ' 上班到 ' + s0.out + ' 下班之間' : ' 上班之後') };
  }
  return { error: 'bad_time', message: '休息時間要在當天其中一段班之內（上班卡之後、下班卡之前）' };
}

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

/** {action:'req_info', id_token, date?, day_only?, apply_miss?} → {ok, name, today, requests:[…], day?:{date, punches, missing}}
 *  day_only（2026-10-28，忘打卡自動選店）：申請頁選好日期後同時問每家已綁定的店「那天有沒有卡」，
 *  只要 day、不讀申請表（回 requests:[]、day_only:true）。舊後端不認得這個參數＝照舊整包回，前端一樣能用。
 *  有 date 時 events 只讀尾端（date 前一天 00:00 起，reqDayInfo_ 只看前後一天），不整張讀。 */
function handleReqInfo_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var today = todayTaipeiStr();
  var dayOnly = body.day_only === true && reqIsDate_(body.date);
  var all = dayOnly ? [] : reqRows_(who.ss);
  var mine = all.filter(function (r) {
    if (String(r.emp_id) !== String(who.me.emp_id)) return false;
    if (reqDayDiff_(today, String(r.created_at).slice(0, 10) || r.date) <= REQ_LIST_DAYS) return true;
    // （2026-11-04 夜間 QA）提前請假的單：審核中、請假日期還沒過的，超過 60 天也要看得到（才有取消入口）
    return r.status === 'pending' && String(r.date).slice(0, 10) >= today;
  }).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).map(reqPublic_);
  var out = { ok: true, name: String(who.me.name), emp_id: String(who.me.emp_id), today: today, requests: mine,
              miss_days: REQ_MISS_DAYS, leave_types: LEAVE_TYPES.filter(function (t) { return t !== '出差'; }),
              proof_types: REQ_PROOF_TYPES_.slice(),
              // 病假滿 3 天才要附證明（2026-11-06）：給申請頁算「選的那天是今年第幾天」；舊頁面不認得這兩欄＝照舊當病假一定要附
              sick_proof_days: REQ_SICK_PROOF_DAYS, sick_dates: reqSickDates_(all, who.me.emp_id, today) };
  if (dayOnly) out.day_only = true;
  if (reqIsDate_(body.date)) {
    // 已送出的忘打卡申請算已經補上的卡（2026-11-11 B02），申請頁才看得到「還能補另一張／另一段」。
    // day_only 照舊不讀申請表（查各店那天有沒有卡要快）；申請頁多帶 apply_miss:true 時才讀，只用來算缺哪張，requests 仍回空。
    var dEv = liffEvents_(who.ss, reqDaySince_(String(body.date)));
    var vRows = dayOnly ? (body.apply_miss === true ? reqRows_(who.ss) : null) : all;
    var di = reqDayInfo_(dEv, who.me.emp_id, String(body.date), vRows ? reqMissVirtual_(vRows, dEv, who.me.emp_id, String(body.date)) : []);
    out.day = { date: String(body.date), punches: di.punches, missing: di.missing };
  }
  return out;
}

/** reqDayInfo_ 要的 events 範圍起點：date 前一天台北 00:00 再早 1 小時（台灣沒有夏令時間）。 */
function reqDaySince_(date) {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - 86400000 - 8 * 3600000 - 3600000;
}

/** yyyy-MM-dd 而且是真的存在的日子（2026-10-10 Codex 審查 #13：只看外形會收 2026-11-31，範圍判斷當 12/1、表裡卻寫 11/31）。 */
function reqIsDate_(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 驗證一筆申請，回 {row} 或 {error, message}。now＝台北日期字串（測試可注入）。 */
function reqValidate_(b, me, events, today, existing, proxy) {   // proxy：主管代開，不看「幾天前」的期限（呼叫端自己限）
  var kind = String(b.kind || '');
  // 2026-11-11（B37）：只認表上自己有的類別（constructor、toString 這類字在物件上本來就查得到東西，原本會被當成合法類別收下）
  if (!Object.prototype.hasOwnProperty.call(REQ_KINDS_, kind)) return { error: 'bad_kind', message: '申請類別不對' };
  var date = String(b.date || '');
  if (!reqIsDate_(date)) return { error: 'bad_date', message: '請選日期' };
  var diff = reqDayDiff_(date, today);
  var reason = reqClean_(b.reason, REQ_REASON_MAX);
  var row = { kind: kind, date: date, leave_type: '', start: '', end: '', hours: '', miss_type: '', reason: reason, comp: '' };

  if (kind === 'leave') {
    if ((!proxy && diff < -REQ_LEAVE_PAST_DAYS) || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '請假只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    var lt = reqClean_(b.leave_type, 30);
    if (!lt || lt === '出差' || (LEAVE_TYPES.indexOf(lt) < 0 && lt !== REQ_COMP_LEAVE_ && !(proxy && typeof leaveTypeAllowedByPayroll === 'function' && leaveTypeAllowedByPayroll(lt, b.mgr_key)))) return { error: 'bad_leave_type', message: '請選假別' };
    row.leave_type = lt;
    if (b.start || b.end) {
      row.start = reqHm_(b.start); row.end = reqHm_(b.end);
      if (!row.start || !row.end) return { error: 'bad_time', message: '請填完整的請假時段' };
      var lsp = reqSpanCheck_(row.start, row.end, '請假');
      if (lsp.error) return lsp;
      row.hours = lsp.hours;
    } else {
      var h = Math.round(Number(b.hours) * 4) / 4;   // 先取到 0.25 再檢查：0.1 小時原本會變成 0 小時的假（2026-10-30 審查）
      if (!isFinite(h) || h <= 0 || h > 24) return { error: 'bad_hours', message: '請填請假時數（最少 0.25 小時）' };
      row.hours = h;
    }
  } else if (kind === 'ot') {
    if ((!proxy && diff < -REQ_LEAVE_PAST_DAYS) || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '加班只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    row.start = reqHm_(b.start); row.end = reqHm_(b.end);
    if (!row.start || !row.end) return { error: 'bad_time', message: '請填加班時段' };
    row.hours = reqSpanHours_(row.start, row.end);
    if (row.hours > 12) return { error: 'bad_time', message: '加班時段超過 12 小時，請確認時間' };
    /* 2026-11-11（B39）：跨夜班的加班在凌晨。日期填凌晨那一天的話，上班那天核定時找不到這張單、凌晨那天又多一張要作廢的單，
       兩天都核不過。這段時間如果落在「前一天上班、跨到今天才下班」的班裡，請同仁把日期改選上班那一天
       （下班打卡後的加班提示本來就帶上班那一天）。核定與薪資怎麼算單不動。 */
    // 獨立審查補：①已送出的忘打卡單當成卡一起看（跨夜班的下班卡可能是補的）；
    // ②這一天自己也有跨夜班或還在上班中（連續兩晚夜班）→ 凌晨那段是這一天那一班的，照收。
    var prevDate = reqPrevDate_(date), otStartMin = reqMin_(row.start);
    var spansOf = function (d) { return (reqDayInfo_(events, me.emp_id, d, reqMissVirtual_(existing, events, me.emp_id, d)).missing || {}).spans || []; };
    var ownNight = spansOf(date).some(function (sp) { return !sp.out || sp.out_next; });
    var nightSpan = ownNight ? null : spansOf(prevDate).filter(function (sp) {
      return sp.out && sp.out_next && otStartMin < reqMin_(sp.out);
    })[0];
    if (nightSpan) {
      var pmd = (+prevDate.slice(5, 7)) + '/' + (+prevDate.slice(8, 10));
      return { error: 'bad_date', message: row.start + '–' + row.end + ' 在 ' + pmd + ' 上班的跨夜班裡（' + pmd + ' ' + nightSpan.in + ' 上班、隔天 ' + nightSpan.out + ' 下班），加班單的日期請選上班那一天（' + pmd + '）' };
    }
    if (!reason) return { error: 'need_reason', message: '加班要寫原因' };
    // 補休（2026-11-01 改每月加減結算）：加班不再分「加班費／換補休」，核准的加班都算進當月補休帳；comp 欄留空（舊列的值不再使用）
  } else if (kind === 'trip') {
    // 出差（2026-10-09）：存成 leave_type＝出差；核准後核定頁預填「出差」＋時數（出差時數與上班時段相加，整天出差可以沒有時段）
    if ((!proxy && diff < -REQ_LEAVE_PAST_DAYS) || diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: '出差只能申請 ' + REQ_LEAVE_PAST_DAYS + ' 天前到 ' + REQ_FUTURE_DAYS + ' 天後' };
    row.leave_type = '出差';
    if (b.start || b.end) {
      row.start = reqHm_(b.start); row.end = reqHm_(b.end);
      if (!row.start || !row.end) return { error: 'bad_time', message: '請填完整的出差時段' };
      var tsp = reqSpanCheck_(row.start, row.end, '出差');
      if (tsp.error) return tsp;
      row.hours = tsp.hours;
    } else {
      var th = Math.round(Number(b.hours) * 4) / 4;
      if (!isFinite(th) || th <= 0 || th > 24) return { error: 'bad_hours', message: '請填出差時數（最少 0.25 小時）' };
      row.hours = th;
    }
    if (Number(row.hours) > REQ_TRIP_MAX_H) return { error: 'bad_hours', message: '每次出差工作時間上限 ' + REQ_TRIP_MAX_H + ' 小時，請確認時數' };   // 5-1
    var place = reqClean_(b.place, 200).replace(/；/g, '，');
    if (!place) return { error: 'need_place', message: '請填出差地點' };
    if (place.length > REQ_TRIP_PLACE_MAX) return { error: 'bad_place', message: '地點最多 ' + REQ_TRIP_PLACE_MAX + ' 個字' };
    var why = reqClean_(b.why, REQ_REASON_MAX);
    if (!why) return { error: 'need_reason', message: '請填出差事由' };
    row.reason = reqTripReason_(place, why);
  } else {   // miss
    if (diff > 0) return { error: 'bad_date', message: '不能補登還沒到的日期' };
    if (!proxy && diff < -REQ_MISS_DAYS) return { error: 'too_old', message: '超過 ' + REQ_MISS_DAYS + ' 天不能自己申請，請店長代開' };
    var mt = String(b.miss_type || '');
    // 已送出（審核中、已核准）的忘打卡申請當成已經補上的卡（2026-11-11 B02）：兩段班一天漏好幾張時才補得齊，
    // 同一張卡也不會被補兩次。info0＝只看真的打卡（分辨「卡本來就在」和「已經有人申請補這張」，兩種訊息不一樣）。
    var virt = reqMissVirtual_(existing, events, me.emp_id, date);
    var info0 = reqDayInfo_(events, me.emp_id, date).missing;
    var info = virt.length ? reqDayInfo_(events, me.emp_id, date, virt).missing : info0;
    var dupMsg = '這天已經有忘打卡申請在補這張卡（審核中或已核准），不用再送；要改請先取消那一筆，已核准的請找你的主管作廢';
    if (!info.options.length) {
      if (info0.options.length) return { error: 'duplicate', message: dupMsg };
      return { error: 'not_missing', message: '這天的上班卡和下班卡都有打成功，不用補登；時間記錯請直接跟打卡門市的店長說' };
    }
    if (info.options.indexOf(mt) < 0) {
      if (info0.options.indexOf(mt) >= 0) return { error: 'duplicate', message: dupMsg };
      return { error: 'not_missing', message: mt === 'in' ? '這天的上班卡有打成功，不用補登' : mt === 'out' ? '這天的下班卡有打成功，不用補登' : '請選要補哪一張卡' };
    }
    row.miss_type = mt;
    if (mt === 'break') {
      // start＝回來上班（補的上班卡）、end＝休息開始（補的下班卡），與 in／out 用同兩欄
      row.end = reqHm_(b.end); if (!row.end) return { error: 'bad_time', message: '請填休息開始（下班）時間' };
      row.start = reqHm_(b.start); if (!row.start) return { error: 'bad_time', message: '請填回來上班時間' };
      var bk = reqBreakSpan_(info.spans, row.end, row.start);
      if (bk.error) {
        // 真的卡配得上、只是那段時間已經被送出的忘打卡申請佔掉＝重複申請（訊息在下面的重複檢查給），不是時間填錯
        var bk0 = virt.length ? reqBreakSpan_(info0.spans, row.end, row.start) : bk;
        if (bk0.error) return bk;
        bk = bk0; row.__taken = true;
      }
      if (diff === 0 && (bk.next || reqMin_(row.start) > reqMin_(nowTaipeiIso().slice(11, 16)))) return { error: 'bad_time', message: '不能補登還沒到的時間' };
      if (!reason) return { error: 'need_reason', message: '請選原因' };
    } else {
    if (mt === 'in' || mt === 'both') { row.start = reqHm_(b.start); if (!row.start) return { error: 'bad_time', message: '請填實際上班時間' }; }
    if (mt === 'out' || mt === 'both') { row.end = reqHm_(b.end); if (!row.end) return { error: 'bad_time', message: '請填實際下班時間' }; }
    // 時間要合理（跨夜：補的下班時間早於上班卡、且在凌晨 06:00 前＝隔天凌晨下班）
    // 一天有兩張以上沒配對的卡時（兩段班都漏下班、或都漏上班，2026-11-11 B02），要補的那張配的是：
    // 下班卡 → 補的時間之前最近的那張上班卡；上班卡 → 補的時間之後最近的那張下班卡。只有一張時和原本一樣。
    var outNext = false;
    var pairIn = info.open_in, pairOut = info.lone_out, pairOutNext = info.lone_out_next;
    if (mt === 'out') {
      (info.open_ins || []).forEach(function (hm) { if (reqMin_(hm) < reqMin_(row.end)) pairIn = hm; });
    }
    if (mt === 'in') {
      var po = (info.lone_outs || []).filter(function (x) { return x.next || reqMin_(x.hm) > reqMin_(row.start); })[0];
      if (po) { pairOut = po.hm; pairOutNext = po.next; }
      else if ((info.lone_outs || []).length) { var pl = info.lone_outs[info.lone_outs.length - 1]; pairOut = pl.hm; pairOutNext = pl.next; }
    }
    if (mt === 'out' && pairIn && reqMin_(row.end) <= reqMin_(pairIn)) {
      if (row.end > REQ_EARLY_OUT_HM) return { error: 'bad_time', message: '補的下班時間 ' + row.end + ' 比當天上班卡 ' + pairIn + ' 還早' };
      outNext = true;
    }
    if (mt === 'in' && pairOut && !pairOutNext && reqMin_(row.start) >= reqMin_(pairOut.slice(0, 5))) {
      return { error: 'bad_time', message: '補的上班時間 ' + row.start + ' 比當天下班卡 ' + pairOut + ' 還晚' };
    }
    if (mt === 'both') {
      if (reqMin_(row.start) === reqMin_(row.end)) return { error: 'bad_time', message: '上班和下班時間一樣，請確認' };
      if (reqMin_(row.end) < reqMin_(row.start)) outNext = true;
      var nb = reqMin_(row.start), ne = reqMin_(row.end) + (outNext ? 1440 : 0);
      var hit = (info.spans || []).filter(function (x) {
        if (!x.out) return false;
        var a = reqMin_(x.in), z = reqMin_(x.out) + (x.out_next ? 1440 : 0);
        return nb < z && a < ne;
      })[0];
      // 重疊的是已送出的申請換來的段＝重複申請：訊息交給下面的重複檢查（審核中／已核准各有原本的字句）
      if (hit && hit.virtual) row.__taken = true;
      else if (hit) return { error: 'bad_time', message: '補的時間和當天已打的卡（' + hit.in + '–' + hit.out + '）重疊；中間休息沒打請選「中間休息沒打卡」' };
    }
    // 補完以後這一段班不能超過配對窗 16 小時（2026-11-03 對抗驗證 #7）：那天只有隔天 01:00 的下班卡時，
    // 補上班 02:00 原本也收，核定頁預填 02:00–01:00(+1)＝23 小時。超過 16 小時打卡也配不成一段。
    var spanIn = null, spanOut = null;
    if (mt === 'in' && pairOut) { spanIn = reqMin_(row.start); spanOut = reqMin_(pairOut.slice(0, 5)) + (pairOutNext ? 1440 : 0); }
    if (mt === 'out' && pairIn) { spanIn = reqMin_(String(pairIn).slice(0, 5)); spanOut = reqMin_(row.end) + (outNext ? 1440 : 0); }
    if (mt === 'both') { spanIn = reqMin_(row.start); spanOut = reqMin_(row.end) + (outNext ? 1440 : 0); }
    if (spanIn !== null && spanOut !== null && spanOut - spanIn > REQ_PAIR_MS / 60000) {
      return { error: 'bad_time', message: '補完上班到下班超過 16 小時（' + Math.round((spanOut - spanIn) / 6) / 10 + ' 小時），請確認時間；真的這麼長請直接跟打卡門市的店長說' };
    }
    if (diff === 0) {   // 今天：不能補還沒到的時間；跨夜的下班＝明天，還沒到（審查 #3）
      var nowMin = reqMin_(nowTaipeiIso().slice(11, 16));
      if (outNext || (row.end && reqMin_(row.end) > nowMin) || (row.start && reqMin_(row.start) > nowMin)) {
        return { error: 'bad_time', message: '不能補登還沒到的時間' };
      }
    }
    // （2026-11-04 夜間 QA）補「昨天」的跨夜下班（outNext）＝今天凌晨的某個時刻，那個時刻還沒到也不能補。
    if (diff === -1 && outNext && row.end && reqMin_(row.end) > reqMin_(nowTaipeiIso().slice(11, 16))) {
      return { error: 'bad_time', message: '不能補登還沒到的時間' };
    }
    // 補上去以後，沒配對的卡要剛好少一張（單張）或不變（整段）；否則補的時間和當天其他的卡配不起來（2026-11-11 B02）
    if (!row.__taken && (mt === 'in' || mt === 'out' || mt === 'both')) {
      var mine = { emp_id: me.emp_id, kind: 'miss', status: 'pending', date: date, miss_type: mt, start: row.start, end: row.end };
      var after = reqDayInfo_(events, me.emp_id, date, virt.concat(reqMissVirtual_([mine], events, me.emp_id, date))).missing;
      var loose = function (x) { return (x.open_ins || []).length + (x.lone_outs || []).length; };
      if (loose(after) !== loose(info) - (mt === 'both' ? 0 : 1)) {
        return { error: 'bad_time', message: '補的時間和當天其他的卡配不起來，請確認時間（一天漏好幾張時，請一張一張照時間補）' };
      }
    }
    if (!reason) return { error: 'need_reason', message: '請選原因' };
    }
  }
  // 同一天同一類不能有兩筆「撞在一起」的審核中申請。
  // 2026-11-11 Eason 定（B29）：請假／加班／出差改看時段——兩張都有開始、結束時間而且不重疊就可以同時在審
  // （例：上午病假還在等證明，下午的事假照樣能送；同一天兩段加班）。時段重疊、或任一張只填時數沒有時段，照舊擋，不分假別。
  // 忘打卡：同一張卡才算（2026-11-11 B02；已有人補的卡在上面就擋掉了）。
  var dup = existing.filter(function (r) {
    return String(r.emp_id) === String(me.emp_id) && r.status === 'pending' && r.kind === kind && r.date === date
        && (kind === 'miss' ? reqSameThing_('miss', r, row) : reqOverlap_(r.start, r.end, row.start, row.end) !== false);
  })[0];
  if (dup) return { error: 'duplicate', message: '這天已經有一筆審核中的' + REQ_KINDS_[kind] + '申請，要改請先取消那一筆' };
  // 已核准的也要擋「同一件事」（2026-11-03 對抗驗證 #4）：原本只看審核中，核准後再送一模一樣的一筆、主管批次核准就算兩次
  // （補休帳加班時數翻倍）。同一天不同時段的加班、不同假別照收（一天多種假別 2026-10-26 起支援）。
  var dupOk = existing.filter(function (r) {
    return String(r.emp_id) === String(me.emp_id) && r.status === 'approved' && r.kind === kind && r.date === date && reqSameThing_(kind, r, row);
  })[0];
  if (dupOk) return { error: 'duplicate', message: '這天已經有一筆核准的' + REQ_KINDS_[kind] + '申請（' + reqDupLabel_(dupOk) + '），不用再送；要改請找你的主管作廢那一筆' };
  if (row.__taken) return { error: 'duplicate', message: '這段時間已經有忘打卡申請在補了（審核中或已核准），不用再送；要改請先取消那一筆，已核准的請找你的主管作廢' };
  return { row: row };
}

/** {action:'req_submit', id_token, kind, date, leave_type?, start?, end?, hours?, miss_type?, reason?, attach_id?} */
function handleReqSubmit_(body) {
  var who = reqStaff_(body);
  if (who.error) return { ok: false, error: who.error };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請幾秒後再送一次' };
  try {
    var existing = reqRows_(who.ss);
    var v = reqValidate_(body, who.me, liffEvents_(who.ss), todayTaipeiStr(), existing);
    if (v.error) return { ok: false, error: v.error, message: v.message };
    var r = v.row;
    // 補休（2026-11-01 改每月加減結算）：可以先休後補、不看餘額；只擋計時同仁（和薪資同專案的店〔光復〕查得到主檔才擋，其他店靠 LINE 申請頁與主管）
    if (r.kind === 'leave' && r.leave_type === REQ_COMP_LEAVE_ && reqCompAllowed_(who.me) === false) {
      return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
    }
    var capMsg = reqCapLocked_(r, existing, who, body, { today: todayTaipeiStr(), recorded: reqLeaveRecorded_(who.ss, who.me.name, r) });
    if (capMsg) return { ok: false, error: 'quota_exhausted', message: capMsg };
    r.id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    r.created_at = nowTaipeiIso(); r.emp_id = String(who.me.emp_id); r.name = String(who.me.name);
    r.attach_id = REQ_ATTACH_RE_.test(String(body.attach_id || '')) ? String(body.attach_id) : '';
    r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    reqMarkOne_(existing, r);   // 今年第幾天病假（滿 3 天才要證明）、本月第幾次忘打卡／事假（黃字提醒）
    var sh = reqSheet_(who.ss, true);
    sh.appendRow(reqHeads_(sh).map(function (h) { return r[h] === undefined ? '' : reqSheetText_(r[h], h); }));   // 照實際表頭寫（舊分頁沒有 comp 欄會先補）
    return { ok: true, request: reqPublic_(r), summary: reqSummary_(r) };
  } finally { lock.releaseLock(); }
}

/** 生理假一年 3 次、家庭照顧假一年 7 天，用完就不能再申請（2026-11-10 Eason）。審核中的同假別一起扣。
 *  額度來自光復的薪資（同專案直接算；別店打光復 line_hub_req_quota，帶同一個 LINE 身分）。
 *  2026-11-11（B18）補三件事：
 *   ① 已核准、但那天主管還沒核定的單也要扣——額度的「已用」只看核定後的請假登記，原本只扣審核中的，
 *      3 張都核准之後第 4 張照樣送得出去。那天已經核定過的（opt.recorded）額度已經扣了，不重複扣。
 *   ② 請的是別的年度（年底請明年的假）：今年剩多少不相干，拿整年的上限來算（原本被今年的餘額擋住）。
 *   ③ 查不到額度（今年還沒有任何一天核定過，額度表就沒有這個假別；或光復暫時問不到）：用法定上限當整年的額度，
 *      只擋「光是申請就超過整年上限」的。原本查不到就完全不擋。
 *  opt：{ today:'yyyy-MM-dd', recorded:{ 'yyyy-MM-dd': true } }，沒帶＝當成同一年、沒有已核定的日子（舊呼叫端照舊）。 */
var REQ_CAP_LOCK_TYPES_ = ['生理假', '家庭照顧假'];
var REQ_CAP_YEAR_H_ = { '生理假': 24, '家庭照顧假': 56 };   // 一年 3 次（一次算 8 小時）／7 天
/** 這個人這個假別已經核定（記進請假登記）的日子 → { 'yyyy-MM-dd': true }；只在兩種有上限的假別才讀表，讀不到回 {}。 */
function reqLeaveRecorded_(ss, name, r) {
  var out = {};
  if (!r || r.kind !== 'leave' || REQ_CAP_LOCK_TYPES_.indexOf(String(r.leave_type)) === -1) return out;
  try {
    var sh = ss.getSheetByName('leave');
    if (!sh) return out;
    var nm = String(name || '').trim();
    readSheetAsObjects(sh).rows.forEach(function (l) {
      if (String(l['姓名'] || '').trim() !== nm || String(l['假別'] || '').trim() !== String(r.leave_type)) return;
      out[typeof normCellDate === 'function' ? normCellDate(l['日期']) : String(l['日期']).slice(0, 10)] = true;
    });
  } catch (e) { return {}; }
  return out;
}
var REQ_HUB_API_DEFAULT_ = 'https://script.google.com/macros/s/AKfycbxE4DTz847y0bPvLd4mD_9vBFTe3npmVVYKU1CYgeFcUpAuL4vLIA3rySXSR-2qujdJ0A/exec';
function reqCapLocked_(r, existing, who, body, opt) {
  if (r.kind !== 'leave' || REQ_CAP_LOCK_TYPES_.indexOf(String(r.leave_type)) === -1) return '';
  opt = opt || {};
  var quota = null;
  try {
    if (typeof lineHubReqQuota_ === 'function') quota = (lineHubReqQuota_(who.userId) || {}).quota || null;
    else {
      var resp = UrlFetchApp.fetch(CONFIG.PAYROLL_API || REQ_HUB_API_DEFAULT_, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
        payload: JSON.stringify({ action: 'line_hub_req_quota', id_token: body.id_token }) });
      var j = JSON.parse(resp.getContentText());
      quota = j && j.ok ? j.quota : null;
    }
  } catch (e) { quota = null; }
  var q = (quota || []).filter(function (x) { return String(x.name) === String(r.leave_type); })[0];
  var yr = String(r.date).slice(0, 4), thisYr = String(opt.today || r.date).slice(0, 4), recorded = opt.recorded || {};
  var known = !!q && q.remain_h != null;
  // 這一年可以用的額度：同一年＝額度表的剩餘；別的年度、或查不到額度＝整年的上限
  var base = (known && yr === thisYr) ? Number(q.remain_h) : (known && q.cap_h != null ? Number(q.cap_h) : REQ_CAP_YEAR_H_[String(r.leave_type)]);
  if (!isFinite(base)) return '';
  // 還沒算進「已用」的單：審核中的，加上已核准而那天還沒核定的
  var live = (existing || []).filter(function (x) {
    if (String(x.emp_id) !== String(who.me.emp_id) || String(x.kind) !== 'leave' || String(x.leave_type) !== String(r.leave_type)) return false;
    if (String(x.date || '').slice(0, 4) !== yr) return false;
    return String(x.status) === 'pending' || (String(x.status) === 'approved' && !recorded[String(x.date).slice(0, 10)]);
  });
  var hasOk = live.some(function (x) { return String(x.status) === 'approved'; });
  var yrText = yr === thisYr ? '今年' : ' ' + yr + ' 年', incl = hasOk || yr !== thisYr || !known ? '（含審核中、已核准）' : '（含審核中）';
  if (r.leave_type === '生理假') {
    var left = base - live.length * 8;   // 生理假看次數：一次算 8 小時（同薪資）
    return left <= 0.001 ? '生理假' + yrText + ' 3 次已經用完' + incl + '，不能再申請' : '';
  }
  var liveH = live.reduce(function (t, x) { return t + (Number(x.hours) || 0); }, 0);
  var room = base - liveH;
  return Number(r.hours) > room + 0.001 ? '家庭照顧假' + yrText + ' 7 天只剩 ' + Math.max(0, Math.round(room * 10) / 10) + ' 小時' + incl + '，這次超過了，不能送出' : '';
}

/** 能不能請補休（正職才行）：和薪資同專案（光復）才查得到 → true／false；查不到／出錯回 null＝不擋（交給申請頁與主管）。 */
function reqCompAllowed_(me) {
  try {
    if (typeof payIsFt !== 'function' || typeof payRead !== 'function') return null;
    var m = payRead('master').filter(function (x) { return String(x.emp_id) === String(me.emp_id); })[0];
    return m ? payIsFt(m) : null;
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
function reqUnseenNotes_(ss, empId, rows) {   // rows：已讀好的申請表（選填，2026-10-12 打卡時與超時提示共用）
  var sh = reqSheet_(ss, false);
  if (!sh) return [];
  var now = nowTaipeiIso(), notes = [];
  (rows || reqRows_(ss)).forEach(function (r) {
    if (String(r.emp_id) !== String(empId) || r.seen_at || (r.status !== 'approved' && r.status !== 'rejected')) return;
    notes.push(r.status === 'approved' ? '✓ 主管已核准：' + reqSummary_(r)
                                       : '✕ 申請被退回：' + reqSummary_(r) + (r.reject_reason ? '（' + r.reject_reason + '）' : ''));
    reqSetCells_(sh, r.__rowIndex, { seen_at: now });
  });
  return notes;
}

/* ── 值班主管本人的申請改由上層審（2026-10-28 Eason 照推薦，規格 req-upper）──
   值班主管＝managers 分頁 active=TRUE 且 allow_acting 不是 TRUE 的列（營運系統專用列不是人）。
   對應到人：先看可選欄 emp_id；沒有就用姓名（去所有空白）比對 roster 在職同名。
   跨店名單（REQ_UPPER_EMPS，管理系統每日同步）：在別家店也拿主管鑰匙的人，在本店的 emp_id。 */
var REQ_UPPER_MSG_ = '這是值班主管本人的申請，請由上層主管在管理系統（人資部門 → 考勤管理 → 申請審核）審核';
function reqTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }
function reqNameKey_(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
/** 本店值班主管 → { emps: {emp_id:true}, warn: [{name, reason:'same_name'|'no_match'}] } */
function reqLocalDutyMgrs_(ss) {
  var emps = {}, warn = [];
  var msh = ss.getSheetByName('managers');
  if (!msh) return { emps: emps, warn: warn };
  var mgrs = readSheetAsObjects(msh).rows.filter(function (m) { return reqTrue_(m.active) && !reqTrue_(m.allow_acting); });
  if (!mgrs.length) return { emps: emps, warn: warn };
  var rsh = ss.getSheetByName('roster');
  var roster = rsh ? readSheetAsObjects(rsh).rows.filter(function (r) { return reqTrue_(r.active) && String(r.emp_id) !== ''; }) : [];
  mgrs.forEach(function (m) {
    var eid = String(m.emp_id == null ? '' : m.emp_id).trim();
    if (eid) { emps[eid] = true; return; }
    var nk = reqNameKey_(m.name);
    var hit = nk ? roster.filter(function (r) { return reqNameKey_(r.name) === nk; }) : [];
    if (hit.length === 0) { warn.push({ name: String(m.name || ''), reason: 'no_match' }); return; }
    if (hit.length > 1) warn.push({ name: String(m.name || ''), reason: 'same_name' });
    hit.forEach(function (r) { emps[String(r.emp_id)] = true; });
  });
  return { emps: emps, warn: warn };
}
/** 跨店名單：Script Property REQ_UPPER_EMPS（JSON 陣列的 emp_id 字串）；讀壞＝空 */
function reqUpperExtra_() {
  var out = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('REQ_UPPER_EMPS');
    var arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) arr.forEach(function (x) { if (typeof x === 'string' && x) out[x] = true; });
  } catch (e) {}
  return out;
}
/** emp_id 是不是值班主管（本店判斷 ∪ 跨店名單）。cache 可傳入 {local, extra} 避免批次重讀 */
function reqUpperOn_() { return PropertiesService.getScriptProperties().getProperty('REQ_UPPER_ON') === '1'; }   // 總開關，預設關：只有恰好 '1' 才開
/* 部門同仁在門市打卡的申請由部門主管審（2026-10-29 Eason 選 1）：部門同仁在門市上班＝支援，
   工時照舊由門市值班主管核；請假、加班、忘打卡、出差申請一律由部門主管在管理系統審，值班核定頁不能核准／退回／作廢。
   名單＝Script Property REQ_DEPT_EMPS（JSON 陣列的本店 emp_id），由 svc_set_upper 的 dept_emp_ids 寫入。
   不看 REQ_UPPER_ON：名單非空就生效；緊急關＝刪掉 REQ_DEPT_EMPS。 */
var REQ_DEPT_MSG_ = '這是部門同仁的申請（在本店上班算支援），請由部門主管在管理系統（人資部門 → 考勤管理 → 申請審核）審核';
/** 保護名單（JSON 陣列的 emp_id）。讀壞時不當空名單（2026-10-29 審查：不能靜默放行）：
 *  先退回上一份讀成功的快照（<name>_LAST）；連快照都沒有 → {'*':true}＝全部人都當在名單上（本店主管全擋，管理系統照常）。 */
var REQ_ALL_ = '*';
function reqParseList_(raw) {
  var arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('not_array');
  var out = {};
  arr.forEach(function (x) { if (typeof x === 'string' && x) out[x] = true; });
  return out;
}
function reqEmpListProp_(name) {
  var props = PropertiesService.getScriptProperties(), raw = null;
  try {
    raw = props.getProperty(name);
    if (!raw) return {};
    var out = reqParseList_(raw);
    try { if (props.getProperty(name + '_LAST') !== raw) props.setProperty(name + '_LAST', raw); } catch (e2) {}
    return out;
  } catch (e) {
    try { var last = props.getProperty(name + '_LAST'); if (last) return reqParseList_(last); } catch (e3) {}
    var all = {}; all[REQ_ALL_] = true; return all;
  }
}
function reqInList_(map, id) { return !!(map && (map[REQ_ALL_] || map[id])); }
function reqDeptEmps_() { return reqEmpListProp_('REQ_DEPT_EMPS'); }
/* 不算本店支援的人（2026-10-29 Eason：財務部一位同仁固定在央廚上班，不算支援、薪水算總部）：
   工時與申請都由所屬部門在管理系統核（管理系統 allow_acting＋acting_name 放行），本店值班核定頁看不到、核不了。
   名單＝Script Property REQ_HOME_EMPS（JSON 陣列的本店 emp_id），手動設；緊急關＝刪屬性。申請部分自動算進部門同仁。 */
var REQ_LIST_BAD_MSG_ = '本店的部門同仁名單讀不到，暫時不能在這裡核定，請通知系統管理者（指令碼屬性 REQ_HOME_EMPS／REQ_DEPT_EMPS）';
var REQ_HOME_MSG_ = '這位同仁在本店上班不算支援，工時由所屬部門在管理系統（人資部門 → 考勤管理）核定';
function reqHomeEmps_() { return reqEmpListProp_('REQ_HOME_EMPS'); }
/** 本店值班主管（非管理系統）要看不到的人：{emp_id:true}；管理系統代核時回 null */
function reqHomeHide_(body) {
  var sh = getSS().getSheetByName('managers');
  var mgr = sh ? findManagerByKey(readSheetAsObjects(sh).rows, body.mgr_key) : null;
  if (!mgr || reqMgrActing_(mgr, body)) return null;
  var h = reqHomeEmps_();
  return Object.keys(h).length ? h : null;   // 可能含 '*'（名單讀壞）：用 reqInList_ 判斷
}
/** mgr_day：拿掉不算支援的人（管理系統代核照常） */
function reqMgrDayHome_(body) {
  var r = handleMgrDay(body), hide = (r && r.ok) ? reqHomeHide_(body) : null;
  if (hide && Array.isArray(r.employees)) r.employees = r.employees.filter(function (e) { return !reqInList_(hide, String(e.emp_id)); });
  return r;
}
/** mgr_approve：不算支援的人擋掉（管理系統代核照常） */
function reqMgrApproveHome_(body) {
  var hide = reqHomeHide_(body);
  if (hide && reqInList_(hide, String(body.emp_id == null ? '' : body.emp_id))) return { ok: false, error: 'home_review', message: hide[REQ_ALL_] ? REQ_LIST_BAD_MSG_ : REQ_HOME_MSG_ };
  return handleMgrApprove(body);
}
/** 為什麼這筆申請不能由本店值班主管處理：'mgr'＝值班主管本人、'dept'＝部門同仁、''＝可以處理 */
function reqUpperWhy_(empId, ss, cache) {
  var c = cache || reqUpperCache_(ss || getSS());
  var id = String(empId == null ? '' : empId);
  if (!id) return '';
  if (c.local[id] || c.extra[id]) return 'mgr';
  if (c.home && reqInList_(c.home, id)) return 'home';
  return (c.dept && reqInList_(c.dept, id)) ? 'dept' : '';
}
function reqIsUpper_(empId, ss, cache) { return !!reqUpperWhy_(empId, ss, cache); }
function reqUpperMsg_(why) { return why === 'home' ? REQ_HOME_REQ_MSG_ : why === 'dept' ? REQ_DEPT_MSG_ : REQ_UPPER_MSG_; }
var REQ_HOME_REQ_MSG_ = '這位同仁在本店上班不算支援，申請由所屬部門在管理系統（人資部門 → 考勤管理 → 申請審核）審核';
function reqUpperCache_(ss) {
  var on = reqUpperOn_();   // 值班主管那份看總開關；部門同仁名單不看（見上）
  return { local: on ? reqLocalDutyMgrs_(ss).emps : {}, extra: on ? reqUpperExtra_() : {}, dept: reqDeptEmps_(), home: reqHomeEmps_() };
}
/** 這把主管鑰匙是不是營運系統專用（allow_acting＝TRUE）：是就放行，營運系統依管理系統名單把關 */
/** 放行條件：主管列 allow_acting＝TRUE 且帶了合法 acting_name（trim 後非空、≤40 字，同 actingName_）。
 *  營運系統「門市帳號登入（舊路）」雖用同一把鑰匙但不帶 acting_name、不依人過濾，一律不放行。 */
function reqMgrActing_(mgr, body) {
  if (!reqTrue_(mgr && mgr.allow_acting)) return false;
  var v = body ? body.acting_name : undefined;
  return typeof v === 'string' && v.trim() !== '' && actingName_(body, mgr) !== null;
}

/* ── 主管 ── */
function reqMgr_(body) {
  var sh = getSS().getSheetByName('managers');
  return sh ? findManagerByKey(readSheetAsObjects(sh).rows, body.mgr_key) : null;
}

/** {action:'mgr_req_pending', mgr_key} → {ok, items:[{…申請, punches:[那天的打卡]}]}（最舊的在前） */
function handleMgrReqPending_(body) {
  if (!reqMgr_(body)) return { ok: false, error: 'unauthorized' };
  var ss = getSS(), all = reqRows_(ss), rows = all.filter(function (r) { return r.status === 'pending'; });
  if (!rows.length) return { ok: true, items: [] };
  var events = liffEvents_(ss), upc = reqUpperCache_(ss);
  var hideHome = !reqMgrActing_(reqMgr_(body), body);   // 不算支援的人：本店主管連申請都看不到（2026-10-29）
  if (hideHome) rows = rows.filter(function (r) { return reqUpperWhy_(r.emp_id, ss, upc) !== 'home'; });
  var items = rows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).map(function (r) {
    var o = reqPublic_(r);
    o.summary = reqSummary_(r);
    var why = r.proxy_by ? 'director' : reqUpperWhy_(r.emp_id, ss, upc);
    o.upper = !!why;   // 值班主管本人／部門同仁的申請：送上層審，這把鑰匙不能處理；主管代開＝總監層級審
    if (why) o.upper_kind = why;
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
  var actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };
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
    var pb = reqProxyBlock_(r, mgr, body, actor);
    if (pb) return pb;
    var why = (r.proxy_by || reqMgrActing_(mgr, body)) ? '' : reqUpperWhy_(r.emp_id, ss);
    if (why) return { ok: false, error: 'upper_review', message: reqUpperMsg_(why) };
    if (decision === 'approve' && reqNeedsProof_(r)) return { ok: false, error: 'need_proof', message: r.leave_type + '要附證明，同仁補上後才能核准（退回不受影響）' };
    reqSetCells_(sh, r.__rowIndex, { status: decision === 'approve' ? 'approved' : 'rejected', decided_at: nowTaipeiIso(),
                                     decided_by: actor, reject_reason: decision === 'reject' ? reason : '' });
    return { ok: true, id: String(r.id), status: decision === 'approve' ? 'approved' : 'rejected' };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_void', mgr_key, id, reason} → 作廢一筆已核准的申請（2026-10-26 Eason 選）。
 *  起因：同仁改申請（例：整天出差 8h 改成出差 4h＋天災假 4h）時舊單已核准，沒人能撤，核定頁會一直帶出舊單。
 *  只改申請的狀態；那天若已經送過核定，核定紀錄不動——要改時數請主管重新核定那天。 */
function handleMgrReqVoid_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };
  var reason = reqClean_(body.reason, REQ_REASON_MAX);
  if (!reason) return { ok: false, error: 'need_reason', message: '作廢要寫理由' };
  var ss = getSS(), sh = reqSheet_(ss, false);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var r = reqRows_(ss).filter(function (x) { return String(x.id) === String(body.id); })[0];
    if (!sh || !r) return { ok: false, error: 'not_found', message: '找不到這筆申請' };
    if (r.status !== 'approved') return { ok: false, error: 'not_approved',
      message: r.status === 'voided' ? '這筆已經作廢了' : r.status === 'pending' ? '這筆還在審核中，請用退回' : '只有已核准的申請可以作廢' };
    var pb = reqProxyBlock_(r, mgr, body, actor);
    if (pb) return pb;
    var why = (r.proxy_by || reqMgrActing_(mgr, body)) ? '' : reqUpperWhy_(r.emp_id, ss);
    if (why) return { ok: false, error: 'upper_review', message: reqUpperMsg_(why) };
    reqHeads_(sh);   // 舊分頁沒有 voided_* 欄，先補表頭
    reqSetCells_(sh, r.__rowIndex, { status: 'voided', voided_at: nowTaipeiIso(), voided_by: actor, void_reason: reason });
    return { ok: true, id: String(r.id), status: 'voided' };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_decide_batch', mgr_key, ids:[…], decision:'approve'} → {ok, done:[ids], skipped:[{id, reason}]}
 *  批次只能核准（2026-10-09 Eason）：退回要寫理由，一筆一筆退。一把鎖、鎖內重讀，不是審核中的就略過並說明原因。 */
function handleMgrReqDecideBatch_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };
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
    var upc = reqMgrActing_(mgr, body) ? null : reqUpperCache_(ss);
    ids.forEach(function (id) {
      var r = byId[id];
      if (!sh || !r) { skipped.push({ id: id, reason: '找不到這筆申請' }); return; }
      if (r.status !== 'pending') { skipped.push({ id: id, reason: r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了' }); return; }
      var pb = reqProxyBlock_(r, mgr, body, actor);
      if (pb) { skipped.push({ id: id, reason: pb.error === 'self_proxy' ? '你代開的申請，要由別的總監層級主管核准' : '主管代開的申請，由總監層級審核' }); return; }
      var why = (upc && !r.proxy_by) ? reqUpperWhy_(r.emp_id, ss, upc) : '';
      if (why) { skipped.push({ id: id, reason: why === 'mgr' ? '值班主管本人的申請，送上層審核' : '部門同仁的申請，由部門主管審核' }); return; }
      if (reqNeedsProof_(r)) { skipped.push({ id: id, reason: r.leave_type + '還沒附證明' }); return; }
      reqSetCells_(sh, r.__rowIndex, { status: 'approved', decided_at: now, decided_by: actor, reject_reason: '' });
      done.push(id);
    });
    return { ok: true, done: done, skipped: skipped };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_day', mgr_key, date} → {ok, by_emp:{emp_id:[已核准的申請…]}}（核定頁預填用） */
function handleMgrReqDay_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var date = String(body.date || '');
  if (!reqIsDate_(date)) return { ok: false, error: 'bad_date' };
  var by = {}, ss = getSS(), upc = reqMgrActing_(mgr, body) ? null : reqUpperCache_(ss);
  reqRows_(ss).forEach(function (r) {
    if (r.date !== date || r.status !== 'approved') return;
    var why = upc ? reqUpperWhy_(r.emp_id, ss, upc) : '';
    if (why === 'home') return;   // 不算支援的人：本店主管看不到（2026-10-29）
    if (r.proxy_by) why = 'director';
    var o = reqPublic_(r); o.summary = reqSummary_(r);
    o.attach_id = String(r.attach_id || '');   // 核定工時看已核准申請的證明（2026-10-30；經光復 line_hub_attach_get 帶 date，會再核對主管金鑰）
    o.upper = !!why;   // 值班主管本人／部門同仁的申請：作廢也要上層處理
    if (why) o.upper_kind = why;
    (by[String(r.emp_id)] = by[String(r.emp_id)] || []).push(o);
  });
  return { ok: true, date: date, by_emp: by };
}

/** {action:'mgr_req_month', mgr_key, ym:'YYYY-MM', acting_name?} → {ok, ym, items, leaves, unmatched}（申請單彙整列印，2026-11-02）
 *  純讀。items＝該月（依 date＝開始日）全部狀態的申請；leaves＝leave 分頁該月的核定結果（薪資讀這份），姓名對 roster 照薪資規則，對不到 emp_id＝''。
 *  不算本店支援的人（home）：不帶 acting 時兩邊都不列。不回 attach_id、comp。型別：has_attach／upper 布林、hours 數字或 null（leaves 一律數字，空白＝0 同薪資）。 */
function handleMgrReqMonth_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var ym = String(body.ym || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return { ok: false, error: 'bad_ym' };
  var ss = getSS(), upc = reqUpperCache_(ss), acting = reqMgrActing_(mgr, body);
  // 'YYYY-M-D' 補零（手填的 leave 日期；薪資照前 7 字算進當月，這裡跟它一樣，對帳鍵也才對得上）
  var pad = function (d) { var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(d || '').trim()); return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : String(d || ''); };
  var inMonth = function (d) { return String(d || '').slice(0, 7) === ym; };
  // 不算本店支援的人：直接看 home 名單（優先於 reqUpperWhy_ 的值班主管本人，2026-11-02 審查）；帶 acting 的營運系統鑰匙照列
  var isHome = function (id) { return !acting && !!upc.home && reqInList_(upc.home, String(id == null ? '' : id)); };
  var cmp = function (x, y) { return x < y ? -1 : x > y ? 1 : 0; };
  var items = reqRows_(ss).filter(function (r) { return String(r.emp_id == null ? '' : r.emp_id) !== '' && inMonth(r.date) && !isHome(r.emp_id); })
    .sort(function (a, b) { return cmp(a.date, b.date) || cmp(a.created_at, b.created_at); })
    .map(function (r) {
      var o = reqPublic_(r), why = acting ? '' : reqUpperWhy_(r.emp_id, ss, upc);   // 帶 acting 時同 mgr_req_day：不算 upper
      o.summary = reqSummary_(r); o.upper = !!why; o.upper_kind = why || '';
      return o;
    });
  // 姓名→員編照薪資（Payroll.gs payCollect 的 nameToEmp）：去頭尾空白後完全相同、同名算給名冊最後一位——核定時數才跟薪資對得起來。
  // 同名的人裡只要有 home，本店主管就整組看不到（避免 home 的假別掛到別人名下被看到）
  var rsh = ss.getSheetByName('roster'), byName = {}, homeName = {};
  (rsh ? readSheetAsObjects(rsh).rows : []).forEach(function (r) {
    var k = String(r.name == null ? '' : r.name).trim(), id = String(r.emp_id == null ? '' : r.emp_id);
    if (!k || !id) return;
    byName[k] = id;
    if (isHome(id)) homeName[k] = true;
  });
  var lsh = ss.getSheetByName('leave'), leaves = [], unmatched = 0, seen = {};
  (lsh ? readSheetAsObjects(lsh).rows : []).forEach(function (r) {
    var date = pad(normCellDate(r['日期']));
    if (!inMonth(date)) return;
    var name = String(r['姓名'] == null ? '' : r['姓名']).trim();
    var type = String(r['假別'] == null ? '' : r['假別']).trim();
    if (Object.prototype.hasOwnProperty.call(homeName, name)) return;
    var emp = Object.prototype.hasOwnProperty.call(byName, name) ? byName[name] : '';
    if (!emp) unmatched++;
    var id = 'L|' + date + '|' + name + '|' + type;
    seen[id] = (seen[id] || 0) + 1;
    if (seen[id] > 1) id += '|' + seen[id];   // 同日同人同假別兩列（手填）：加序號，id 不重複
    leaves.push({ id: id, emp_id: emp, name: name, date: date, type: type, hours: Number(r['時數']) || 0 });
  });
  leaves.sort(function (a, b) { return cmp(a.date, b.date); });
  return { ok: true, ym: ym, items: items, leaves: leaves, unmatched: unmatched, log: reqAuditLog_(ss, ym, items, isHome) };
}

/* ── 核定紀錄（2026-11-04）：把「誰在什麼時候核了什麼」整理成一筆一列，給管理系統的「核定紀錄」分頁。
 *  來源（都是既有資料，不另外寫帳）：
 *   hours＝approved 分頁（只追加不覆蓋，每次重核都是一列；系統重算的名字尾巴有「（系統重算）」）
 *   req  ＝requests 分頁每一列的 created_at／decided_*／voided_*（核准後才能作廢，decided_* 不會被蓋掉）
 *   device＝device_log 分頁（裝置核准／拒絕，2026-11-04 起才開始記）
 *  每筆 {at, kind, action, emp_id, name, date, ref, by, system, detail}；ref 相同＝同一件事（看歷史用）。
 *  只含該月（依工作日期）的列；不算本店支援的人（isHome）照 mgr_req_month 的規則不列。 */
var REQ_AUDIT_DEVICE_SHEET_ = 'device_log';
var REQ_AUDIT_DEVICE_HEADS_ = ['at', 'emp_id', 'name', 'approve', 'by'];
function reqAuditLog_(ss, ym, items, isHome) {
  var log = [], mark = (typeof RECHECK_MARK === 'string' ? RECHECK_MARK : '（系統重算）');
  var ash = ss.getSheetByName('approved');
  if (ash) readSheetAsObjects(ash).rows.forEach(function (r) {
    var date = normCellDate(r.date), emp = String(r.emp_id == null ? '' : r.emp_id);
    if (!emp || date.slice(0, 7) !== ym || isHome(emp)) return;
    var by = String(r.manager_name || ''), sys = by.length >= mark.length && by.slice(-mark.length) === mark;
    log.push({ at: String(normCellTs(r.entered_at) || ''), kind: 'hours', action: sys ? 'recheck' : 'hours', emp_id: emp, name: String(r.name || ''),
               date: date, ref: 'H|' + date + '|' + emp, by: sys ? by.slice(0, -mark.length) : by, system: sys,
               detail: { hours: Number(r.approved_hours) || 0, status: String(r.status_text || ''), periods: String(r.periods || ''), diff_reason: String(r.diff_reason || '') } });
  });
  // 同一天同一人：最早那筆是「核定」，之後的人工核定是「重核」（系統重算維持 recheck）
  var firstSeen = {};
  log.slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; }).forEach(function (e) {
    if (e.action !== 'hours') return;
    if (firstSeen[e.ref]) e.action = 'rehours'; else firstSeen[e.ref] = true;
  });
  items.forEach(function (r) {
    var base = { kind: 'req', emp_id: r.emp_id, name: r.name, date: r.date, ref: 'R|' + r.id, system: false };
    var add = function (o) { log.push(Object.assign({}, base, o)); };
    add({ at: r.created_at, action: 'submit', by: r.name, detail: { summary: r.summary } });
    if (r.status === 'approved' || r.status === 'voided') add({ at: r.decided_at, action: 'approve', by: r.decided_by, detail: { summary: r.summary } });
    else if (r.status === 'rejected') add({ at: r.decided_at, action: 'reject', by: r.decided_by, detail: { summary: r.summary, reason: r.reject_reason } });
    else if (r.status === 'cancelled') add({ at: r.decided_at, action: 'cancel', by: r.decided_by || '本人取消', detail: { summary: r.summary } });
    if (r.status === 'voided') add({ at: r.voided_at, action: 'void', by: r.voided_by, detail: { summary: r.summary, reason: r.void_reason } });
  });
  var dsh = ss.getSheetByName(REQ_AUDIT_DEVICE_SHEET_);
  if (dsh) readSheetAsObjects(dsh).rows.forEach(function (r) {
    var at = String(normCellTs(r.at) || ''), emp = String(r.emp_id == null ? '' : r.emp_id);
    if (!emp || at.slice(0, 7) !== ym || isHome(emp)) return;
    log.push({ at: at, kind: 'device', action: String(r.approve).toLowerCase() === 'true' ? 'device_ok' : 'device_no', emp_id: emp, name: String(r.name || ''),
               date: at.slice(0, 10), ref: 'D|' + emp + '|' + at, by: String(r.by || ''), system: false, detail: {} });
  });
  return log.filter(function (e) { return e.at; }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
}
/** 裝置核准／拒絕成功後記一列（失敗不影響核准本身）。分頁不存在就建。 */
function reqAuditDeviceLog_(empId, approve, actor) {
  try {
    var ss = getSS(), sh = ss.getSheetByName(REQ_AUDIT_DEVICE_SHEET_);
    if (!sh) { sh = ss.insertSheet(REQ_AUDIT_DEVICE_SHEET_); sh.getRange(1, 1, 1, REQ_AUDIT_DEVICE_HEADS_.length).setValues([REQ_AUDIT_DEVICE_HEADS_]); }
    var ros = findRosterByEmpId(readSheetAsObjects(ss.getSheetByName('roster')).rows, empId);
    var nm = ros ? String(ros.name || '') : '';
    sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setValues([[nowTaipeiIso(), String(empId), sheetSafeText_(nm), approve ? 'TRUE' : 'FALSE', sheetSafeText_(String(actor || ''))]]);
  } catch (err) { /* 記不進去不影響裝置核准 */ }
}
/** 覆蓋 Code.gs mgr_device_decision（Liff.gs LIFF_HANDLERS 掛載）：照原本核准，成功就記一列。 */
function reqDeviceDecisionLogged_(body) {
  var res = handleMgrDeviceDecision(body);
  if (res && res.ok) reqAuditDeviceLog_(body.emp_id, !!body.approve, res.manager_name);
  return res;
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
   events 要含這次這張下班卡。回 {date, hours, start, end} 或 null。
   2026-11-11（B16）：核定加嚴生效的日子（REQ_STRICT_FROM，預設 2026-11-11 起），時數改用和主管頁「參考時數」一樣的算法
   （每段上班進位、下班捨去到 15 分鐘），end 也捨去到 15 分鐘。原本用實際分秒加總，早到晚走各 5 分鐘、甚至多 18 秒都會提示；
   同仁照提示送了加班單，主管照參考時數核定 8 小時，就被加嚴規則「請先把加班單作廢」擋住。生效以前的日子、加嚴關掉時照舊。 */
var REQ_OT_HINT_H = 8;
/** 一段班在 15 分鐘刻度上的長度（毫秒）：上班捨秒後進位、下班捨秒後捨去——同 Code.gs approvedHoursOfShift */
function reqGridMs_(inMs, outMs) {
  var a = Math.ceil(Math.floor(inMs / 60000) / 15) * 15, b = Math.floor(Math.floor(outMs / 60000) / 15) * 15;
  return Math.max(0, b - a) * 60000;
}
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
  var strictFrom = reqStrictFrom_(), grid = !!(strictFrom && date >= strictFrom);
  segs.forEach(function (x) { if (x.inp.date === date) ms += grid ? reqGridMs_(x.inp.t, x.outp.t) : x.outp.t - x.inp.t; });
  var hours = Math.round(ms / 36000) / 100;
  if (hours <= REQ_OT_HINT_H) return null;
  var has = (rows || []).some(function (r) {
    return String(r.emp_id) === String(empId) && r.kind === 'ot' && r.date === date && (r.status === 'pending' || r.status === 'approved');
  });
  if (has) return null;
  var end = String(outTs).slice(11, 16);
  if (grid) { var em = Math.floor(reqMin_(end) / 15) * 15; end = ('0' + Math.floor(em / 60)).slice(-2) + ':' + ('0' + (em % 60)).slice(-2); }
  var startMin = reqMin_(end) - (ms - REQ_OT_HINT_H * 3600000) / 60000;
  startMin = ((Math.floor(startMin / 15) * 15) % 1440 + 1440) % 1440;
  var start = ('0' + Math.floor(startMin / 60)).slice(-2) + ':' + ('0' + (startMin % 60)).slice(-2);
  return { date: date, hours: hours, start: start, end: end };
}

/* ── 主管代開申請（2026-11-06 Eason）──
   核定工時綁定申請單後，同仁超過 7 天沒補加班／忘打卡單，那天就永遠核不了。出口：店長在管理系統（考勤管理）
   替同仁代開，只限超過 7 天、只限加班與忘打卡；代開的單一律送總監層級（墨竹亭各店＝品牌總監、央廚＝廚藝總監、
   小辛辣＝品牌總監、總部＝人資主管）審核。誰是總監層級由營運系統判斷，打卡端只認營運系統代轉時加上的 director_ok。 */
var REQ_PROXY_PAST_DAYS = 90;   // 代開最遠到 90 天前
var REQ_PROXY_MSG_ = '這是主管代開的申請，要由總監層級（品牌總監／廚藝總監；總部是人資主管）在管理系統（人資部門 → 考勤管理 → 申請審核）審核';
/** 代開的申請能不能由這次呼叫處理：不行回錯誤物件，可以回 null；不是代開的申請一律 null */
function reqProxyBlock_(r, mgr, body, actor) {
  if (!String(r.proxy_by || '')) return null;
  if (!reqMgrActing_(mgr, body) || body.director_ok !== true) return { ok: false, error: 'director_review', message: REQ_PROXY_MSG_ };
  if (reqNameKey_(actor) === reqNameKey_(r.proxy_by)) return { ok: false, error: 'self_proxy', message: '這筆是你代開的，要由別的總監層級主管審核' };
  return null;
}
/** {action:'mgr_req_proxy', mgr_key, acting_name, emp_id, kind:'ot'|'miss'|'leave'|'trip', date, start?, end?, miss_type?, leave_type?, hours?, place?, why?, reason} */
/** 名冊這一列沒有綁 LINE（line_user_id 空白）；找不到人回 false。 */
function reqNoLine_(rosterRow) { return !!rosterRow && !String(rosterRow.line_user_id || '').trim(); }

function handleMgrReqProxy_(body) {
  var mgr = reqMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  if (!reqMgrActing_(mgr, body)) return { ok: false, error: 'acting_only', message: '代開申請請到管理系統（人資部門 → 考勤管理）用個人帳號操作' };
  var actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };
  var kind = String(body.kind || '');
  if (kind !== 'ot' && kind !== 'miss' && kind !== 'leave' && kind !== 'trip') return { ok: false, error: 'bad_kind', message: '代開只限加班、忘打卡、請假或出差' };
  if (kind === 'leave' && !reqClean_(body.reason, REQ_REASON_MAX)) return { ok: false, error: 'need_reason', message: '代開要寫原因' };
  var date = String(body.date || ''), today = todayTaipeiStr();
  if (!reqIsDate_(date)) return { ok: false, error: 'bad_date', message: '請選日期' };
  var diff = reqDayDiff_(date, today), limit = kind === 'miss' ? REQ_MISS_DAYS : REQ_LEAVE_PAST_DAYS;
  if (diff < -REQ_PROXY_PAST_DAYS) return { ok: false, error: 'too_old', message: '代開最多到 ' + REQ_PROXY_PAST_DAYS + ' 天前' };
  var ss = getSS();
  var me = findRosterByEmpId(readSheetAsObjects(ss.getSheetByName('roster')).rows, body.emp_id);
  if (!me) return { ok: false, error: 'invalid_emp_id', message: '找不到這位同仁' };
  /* 7 天內同仁自己用 LINE 申請；沒綁 LINE 的人送不了單，今天和過去的日子可以由主管代開（2026-11-09 Eason）。 */
  /* 2026-11-11（B30）：名冊已停用（離職）的同仁也一樣——LINE 雖然還綁著，本人已經送不了單，
     原本要等超過 7 天店長才能代開，這幾天核定又被「缺單」擋住。 */
  if (diff >= -limit && !(diff <= 0 && (reqNoLine_(me) || !reqTrue_(me.active)))) return { ok: false, error: 'not_old', message: limit + ' 天內請同仁自己在 LINE「加班請假」申請；超過 ' + limit + ' 天或同仁沒綁 LINE 才能由主管代開' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var existing = reqRows_(ss);
    var v = reqValidate_(body, me, liffEvents_(ss, reqDaySince_(date)), today, existing, true);
    if (v.error) return { ok: false, error: v.error, message: v.message };
    var r = v.row;
    // 2026-11-11（B37）：補休只有正職可以請——本人送會擋，代開也照擋（查不到薪資主檔的店照舊不擋）
    if (r.kind === 'leave' && r.leave_type === REQ_COMP_LEAVE_ && reqCompAllowed_(me) === false) {
      return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
    }
    r.id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    r.created_at = nowTaipeiIso(); r.emp_id = String(me.emp_id); r.name = String(me.name);
    r.attach_id = ''; r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    r.proxy_by = actor;
    reqMarkOne_(existing, r);
    var sh = reqSheet_(ss, true);
    sh.appendRow(reqHeads_(sh).map(function (h) { return r[h] === undefined ? '' : reqSheetText_(r[h], h); }));
    return { ok: true, request: reqPublic_(r), summary: reqSummary_(r) };
  } finally { lock.releaseLock(); }
}

/* ── 核定工時綁定申請單（2026-11-06 Eason）──
   主管送出核定（有上班時段）時：①核定合計超過 8 小時，超出的時數要有已核准的加班單蓋到；
   ②核定的每一段上班卡、下班卡都要有（含中間休息沒打、打卡被擋），少幾張就要有幾張已核准的忘打卡單（補休息＝2 張），
   那天有已核准的出差單不看缺卡。審核中的單不算。不符合＝整天送不出（Eason 選）。
   不算缺卡：央廚中午休息帶、主管拆段核定（間隔 0）、主管認定的重複打卡（Code.gs 先拿掉再傳進來）。
   從 REQ_BIND_FROM（指令碼屬性，預設上線當天）起的日子才擋；屬性設 off＝整個關掉。由 Code.gs handleMgrApprove 呼叫。 */
var REQ_BIND_FROM_DEFAULT_ = '2026-11-06';
var REQ_BIND_OT_BASE_H = 8;
var REQ_BIND_NEAR_MS = 4 * 3600000;   // 沒配到完整打卡段的時段：前後 4 小時內的單張卡算那段的
function reqBindFrom_() {
  var v = '';
  try { v = String(PropertiesService.getScriptProperties().getProperty('REQ_BIND_FROM') || ''); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_BIND_FROM_DEFAULT_;
}
/** 核定時段少了幾張打卡。periods：[{startMs,endMs}]；segs：[{inMs,outMs}]（null＝沒有那張） */
/** 程式碼.js 還沒有 loneCardsForPeriods_ 時的舊算法：每段取前後 4 小時內第一張單獨的卡 */
function reqLoneFallback_(periods, full, segs) {
  var used = [], out = {};
  periods.forEach(function (p, pi) {
    if (full.some(function (s) { return Math.min(p.endMs, s.outMs) - Math.max(p.startMs, s.inMs) > 0; })) return;
    segs.forEach(function (s, si) {
      if (out[pi] || used[si] || (s.inMs == null) === (s.outMs == null)) return;
      var t = s.inMs != null ? s.inMs : s.outMs;
      if (t >= p.startMs - REQ_BIND_NEAR_MS && t <= p.endMs + REQ_BIND_NEAR_MS) { out[pi] = s; used[si] = true; }
    });
  });
  return out;
}
function reqBindMissCards_(periods, segs, breakWindow) {
  // 規定不打卡的休息帶（央廚）隔開的兩段當成同一段算，否則只漏一張卡會被算成 3 張（2026-11-10，與薪資一致）
  // 午休照樣打卡的同仁不併（2026-11-11 B01）：和核定狀態共用 Code.gs breakBlocksFor_，狀態寫幾張、這裡就要幾張單；
  // 程式碼.js 還沒有那支函式的店照舊一律併。
  if (breakWindow && typeof breakBlocksFor_ === 'function') {
    periods = breakBlocksFor_(periods, segs, breakWindow).map(function (b) { return { startMs: b.startMs, endMs: b.endMs }; });
  } else if (breakWindow && typeof gapExplainedByBreak === 'function') {
    periods = periods.slice().sort(function (a, b) { return a.startMs - b.startMs; }).reduce(function (acc, p) {
      var last = acc[acc.length - 1];
      if (last && p.startMs > last.endMs && gapExplainedByBreak(last.endMs, p.startMs, breakWindow)) {
        acc[acc.length - 1] = { startMs: last.startMs, endMs: Math.max(last.endMs, p.endMs) };
      } else acc.push({ startMs: p.startMs, endMs: p.endMs });
      return acc;
    }, []);
  }
  var full = segs.filter(function (s) { return s.inMs != null && s.outMs != null; });
  var ordered = periods.map(function (p) {
    var best = -1, bestOv = 0;
    full.forEach(function (s, i) { var ov = Math.min(p.endMs, s.outMs) - Math.max(p.startMs, s.inMs); if (ov > bestOv) { bestOv = ov; best = i; } });
    return { p: p, idx: best };
  });
  // 單張卡歸哪一段：和核定狀態同一套（Code.gs loneCardsForPeriods_，2026-11-10）；有一張就只缺一張
  var loneOf = typeof loneCardsForPeriods_ === 'function' ? loneCardsForPeriods_(periods, full, segs) : reqLoneFallback_(periods, full, segs);
  var n = 0;
  ordered.forEach(function (o, pi) { if (o.idx === -1) n += loneOf[pi] ? 1 : 2; });
  ordered.sort(function (a, b) { return a.p.startMs - b.p.startMs; });
  // 兩段之間有空檔（不是休息帶、也不是拆段的 0 間隔）卻配到同一條打卡段＝中間休息的下班卡、上班卡都沒打
  var maxEnd = null, prevIdx = -1;
  ordered.forEach(function (o) {
    if (maxEnd !== null && o.p.startMs > maxEnd && o.idx !== -1 && o.idx === prevIdx
        && !(typeof gapExplainedByBreak === 'function' && gapExplainedByBreak(maxEnd, o.p.startMs, breakWindow))) n += 2;
    if (maxEnd === null || o.p.endMs > maxEnd) maxEnd = o.p.endMs;
    prevIdx = o.idx;
  });
  return n;
}
/** 人還在上班（2026-11-11 B03）：那天最後一張卡是沒配對的上班卡，下班卡還沒到打的時候，不能算少一張——
 *  同仁此刻也補不了這張單。做法：把那張上班卡當成「打到現在」的一段再去算。之後打了下班卡，每日重算會把狀態改回來。
 *  2026-11-11（B34，Eason 定）：不再看日期（原本只認今天、跨夜班到隔天 06:00 前），改成「上班卡之後 16 小時內都算上班中」，
 *  和同仁頁、主管頁、月表同一口徑。是不是還在上班由 Code.gs markWorkingSeg_ 判斷好標在打卡段上（working:true＝
 *  這個人最後一張卡、而且還在 16 小時內）；沒有標的一律不算。 */
function reqWorkingSegs_(segs, date) {
  if (!segs || !segs.length) return segs;
  var nowIso = nowTaipeiIso();
  var at = function (x) { return x.inMs != null ? x.inMs : x.outMs; };
  var last = segs.reduce(function (a, x) { return a === null || at(x) >= at(a) ? x : a; }, null);
  if (!last || last.inMs == null || last.outMs != null) return segs;   // 最後一張不是沒配對的上班卡
  if (!last.working) return segs;                                       // 後面還有別的卡，或已經超過 16 小時
  var nowMs = new Date(nowIso).getTime();
  // 16 小時只由 working（Code.gs markWorkingSeg_，用含秒的打卡時間）判一次；這裡不再用捨到分鐘的 inMs 重判，
  // 否則滿 16 小時前不到 1 分鐘，畫面說上班中、核定卻說少一張卡（獨立審查補）
  return segs.map(function (x) {
    return x === last ? { in: x.in, out: null, inMs: x.inMs, outMs: Math.max(nowMs, x.inMs + 60000) } : x;
  });
}
function reqBindFmt_(h) { return String(Math.round(h * 100) / 100); }
/* ── 核定加嚴（2026-11-08 Eason 定案；REQ_STRICT_FROM 預設 2026-11-11 起的日子才算，指令碼屬性設 off＝只關加嚴；REQ_BIND_FROM 設 off＝全部關）──
   規則 1：已核准加班單的時段要落在核定時段內，前後可差 15 分鐘（那天有出差時數不比時段：加班可能在出差那段）。
   規則 2：加班單時數不可少於應有加班時數；多 15 分鐘內算相符。應有＝一般日核定超過 8 小時的部分；班表休息日／例假＝當天核定全部；班表查不到照一般日。
           一般日核定沒超過 8 小時卻有已核准加班單＝擋，要先作廢。
   規則 3：核定登記的假別、時數要和已核准假單（含出差單）一樣；登記了沒單、有單沒登記都擋。整天請假也看。
   規則 4：核定和打卡（完整打卡的日子，扣掉不打卡休息帶）差 30 分鐘以上要填原因，原因存 approved 的 diff_reason。 */
var REQ_STRICT_FROM_DEFAULT_ = '2026-11-11';
var REQ_STRICT_TOL_MIN = 15;
var REQ_STRICT_DIFF_MIN = 30;
var REQ_DIFF_REASON_MAX = 100;
function reqStrictFrom_() {
  var v = '';
  try { v = String(PropertiesService.getScriptProperties().getProperty('REQ_STRICT_FROM') || ''); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_STRICT_FROM_DEFAULT_;
}
function reqCleanDiffReason_(v) { return sheetSafeText_(reqClean_(v, REQ_DIFF_REASON_MAX)); }
function reqHmMs_(date, hm) { return Date.parse(date + 'T' + hm + ':00+08:00'); }
/** 應有加班時數；schedDay：H＝休息日、R＝例假，其他（含空白＝查不到）照一般日 */
function reqStrictOtNeed_(hours, schedDay) {
  var rest = schedDay === 'H' || schedDay === 'R';
  var need = rest ? Number(hours) : Math.max(Number(hours) - REQ_BIND_OT_BASE_H, 0);
  return { rest: rest, need: Math.round(need * 100) / 100 };
}
/** 把核定時段併成連續區間（中間空檔在容差內算連著） */
function reqStrictMerged_(periods) {
  var tol = REQ_STRICT_TOL_MIN * 60000, out = [];
  periods.slice().sort(function (a, b) { return a.startMs - b.startMs; }).forEach(function (p) {
    var last = out[out.length - 1];
    if (last && p.startMs <= last.e + tol) last.e = Math.max(last.e, p.endMs);
    else out.push({ s: p.startMs, e: p.endMs });
  });
  return out;
}
/** 加班單時段在核定時段內？跨夜班的凌晨加班單（日期算前一天）也試隔天 */
function reqStrictSlotOk_(date, start, end, merged) {
  var a = reqMin_(start), b = reqMin_(end);
  if (a == null || b == null) return false;
  var s = reqHmMs_(date, start), e = reqHmMs_(date, end), tol = REQ_STRICT_TOL_MIN * 60000;
  if (e <= s) e += 86400000;
  var fit = function (x, y) { return merged.some(function (m) { return x >= m.s - tol && y <= m.e + tol; }); };
  return fit(s, e) || fit(s + 86400000, e + 86400000);
}
/** 加班單有幾分鐘落在班表上班時段內；跨夜的加班單也試隔天。 */
function reqOtInSchedMin_(start, end, spans) {
  var a = reqMin_(start), b = reqMin_(end);
  if (a === null || b === null) return 0;
  if (b <= a) b += 1440;
  var best = 0;
  [0, 1440].forEach(function (shift) {
    var sum = 0;
    spans.forEach(function (x) {
      var s = reqMin_(String(x.start)), e = reqMin_(String(x.end));
      if (s === null || e === null) return;
      if (e <= s) e += 1440;
      sum += Math.max(0, Math.min(b + shift, e) - Math.max(a + shift, s));
    });
    if (sum > best) best = sum;
  });
  return best;
}
/** 核定和打卡相差幾分鐘；有缺卡（比不出來）回 null */
function reqPunchDiffMin_(periods, segs, breakWindow) {
  if (!periods.length || !segs.length || segs.some(function (s) { return s.inMs == null || s.outMs == null; })) return null;
  var core = periods.reduce(function (a, p) { return a + p.endMs - p.startMs; }, 0);
  var punch = segs.reduce(function (a, s) {
    var ov = breakWindow ? Math.max(0, Math.min(s.outMs, breakWindow.endMs) - Math.max(s.inMs, breakWindow.startMs)) : 0;
    return a + s.outMs - s.inMs - ov;
  }, 0);
  return Math.round(Math.abs(core - punch) / 60000);
}
/** 核定登記的假 vs 已核准假單（含出差單）；回不符的字句陣列 */
function reqStrictLeaveProbs_(okRows, leaves) {
  var sum = function (list) { var o = {}; list.forEach(function (x) { o[x.t] = (o[x.t] || 0) + (Number(x.h) || 0); }); return o; };
  var have = sum((leaves || []).map(function (x) { return { t: String(x.type), h: x.hours }; }));
  var reqd = sum(okRows.filter(function (r) { return r.kind === 'leave' || r.kind === 'trip'; })
    .map(function (r) { return { t: r.kind === 'trip' ? '出差' : String(r.leave_type), h: r.hours }; }));
  var out = [];
  Object.keys(have).forEach(function (t) {
    if (!(t in reqd)) out.push('登記了' + t + ' ' + reqBindFmt_(have[t]) + ' 小時，但沒有已核准的' + (t === '出差' ? '出差單' : '假單'));
    else if (Math.abs(have[t] - reqd[t]) > 0.005) out.push(t + '核定登記 ' + reqBindFmt_(have[t]) + ' 小時，已核准的單是 ' + reqBindFmt_(reqd[t]) + ' 小時');
  });
  Object.keys(reqd).forEach(function (t) { if (!(t in have)) out.push('有已核准的' + t + ' ' + reqBindFmt_(reqd[t]) + ' 小時，核定沒有登記'); });
  return out;
}
/** 別家店這天有沒有這個人的成功打卡。跨店同日合計超過 8 小時時，加班單開在做到超過 8 小時的那家店（Eason 2026-11-09），那家店當天可能自己沒滿 8 小時。讀不到算沒有。 */
function reqPeerWorked_(name, date) {
  if (typeof restPeerEvents_ !== 'function' || !name) return false;
  var dayStart = new Date(date + 'T00:00:00+08:00').getTime();
  return restPeerEvents_(name, dayStart).some(function (e) {
    var ms = new Date(String(e.ts)).getTime();
    return e.status === 'ok' && ms >= dayStart && ms < dayStart + 86400000;
  });
}
/** 不能核定回 {ok:false, error:'need_request'|'need_diff_reason', message, ...}；可以回 null。
 *  opt：leaves、trip_hours、sched_day（H／R／W／空白）、diff_reason、acting（考勤管理個人帳號）；rows／force_strict／preview 給只讀試算用。 */
function reqBindCheck_(ss, empId, date, approvedHours, periods, segs, breakWindow, opt) {
  opt = opt || {};
  periods = periods || [];
  var from = reqBindFrom_(), strictFrom = reqStrictFrom_();
  var bindOn = !!(from && date >= from && periods.length);
  var strict = !!opt.force_strict || !!(from && strictFrom && date >= strictFrom);
  if (!bindOn && !strict) return null;
  var rows = (opt.rows || reqRows_(ss)).filter(function (r) { return String(r.emp_id) === String(empId) && String(r.date) === date; });
  var ok = rows.filter(function (r) { return r.status === 'approved'; });
  var pend = rows.filter(function (r) { return r.status === 'pending' && (r.kind === 'ot' || r.kind === 'miss' || r.kind === 'trip' || (strict && r.kind === 'leave')); });
  var otRows = ok.filter(function (r) { return r.kind === 'ot'; });
  var otHave = otRows.reduce(function (a, r) { return a + (Number(r.hours) || 0); }, 0);
  var otNeed = Math.round((Number(approvedHours) - REQ_BIND_OT_BASE_H) * 100) / 100;
  var probs = [], add = function (rule, text) { probs.push({ rule: rule, text: text }); };
  var otBad = false;
  if (strict) {
    var ot = reqStrictOtNeed_(approvedHours, String(opt.sched_day || ''));
    otNeed = ot.need;
    var label = ot.rest ? '這天班表是休息日或例假，核定的 ' + reqBindFmt_(otNeed) + ' 小時都算加班，要有加班單'
                        : '超過 ' + REQ_BIND_OT_BASE_H + ' 小時的 ' + reqBindFmt_(otNeed) + ' 小時要有加班單';
    var schedKnown = opt.acting !== false;   // 舊值班核定頁拿不到班表，不知道是不是休息日，不判「加班單太多」；營運系統讀不到班表仍當一般日
    var peerSeen = null, peerDay = function () { if (peerSeen === null) peerSeen = reqPeerWorked_(String((otRows[0] || {}).name || ''), date); return peerSeen; };   // 只在要擋的時候才讀別家店
    var voidIt = schedKnown && otHave > 0.005 && otNeed <= 0.005 && !peerDay();
    if (voidIt) add('ot_void', '核定沒有超過 ' + REQ_BIND_OT_BASE_H + ' 小時，卻有 ' + reqBindFmt_(otHave) + ' 小時的已核准加班單，請先把加班單作廢');
    else if (otNeed > 0.005 && otHave + 0.005 < otNeed) { otBad = true; add('ot_hours', label + '（已核准 ' + reqBindFmt_(otHave) + ' 小時）'); }
    else if (schedKnown && otNeed > 0.005 && otHave > otNeed + REQ_STRICT_TOL_MIN / 60 + 0.005 && !peerDay()) add('ot_hours', '加班單 ' + reqBindFmt_(otHave) + ' 小時比應有的 ' + reqBindFmt_(otNeed) + ' 小時多超過 ' + REQ_STRICT_TOL_MIN + ' 分鐘');
    if (!voidIt && !(Number(opt.trip_hours) > 0)) {
      var merged = reqStrictMerged_(periods);
      otRows.forEach(function (r) {
        if (!reqStrictSlotOk_(date, String(r.start), String(r.end), merged)) add('ot_slot', '加班單 ' + r.start + '–' + r.end + ' 不在核定時段內（前後可差 ' + REQ_STRICT_TOL_MIN + ' 分鐘）');
      });
      /* 班表內是正常上班，不能算加班事實（Eason 2026-11-09）。班表時段由營運系統帶入，休息日、例假整天都算加班不比；沒帶＝不檢查。 */
      var spans = ot.rest || !Array.isArray(opt.sched_spans) ? [] : opt.sched_spans;
      if (spans.length) otRows.forEach(function (r) {
        var inMin = reqOtInSchedMin_(String(r.start), String(r.end), spans);
        if (inMin > REQ_STRICT_TOL_MIN && !peerDay()) add('ot_in_sched', '加班單 ' + r.start + '–' + r.end + ' 有 ' + inMin + ' 分鐘在班表上班時段內（' + spans.map(function (x) { return x.start + '–' + x.end; }).join('、') + '），班表內是正常上班，不能算加班，請改成實際加班的時段');
      });
    }
  } else if (otNeed > 0.005 && otHave + 0.005 < otNeed) {
    otBad = true;
    add('ot_hours', '超過 ' + REQ_BIND_OT_BASE_H + ' 小時的 ' + reqBindFmt_(otNeed) + ' 小時要有加班單（已核准 ' + reqBindFmt_(otHave) + ' 小時）');
  }
  var miss = bindOn ? reqBindMissCards_(periods, reqWorkingSegs_(segs, date), breakWindow) : 0;
  var missHave = ok.reduce(function (a, r) { return a + (r.kind !== 'miss' ? 0 : (r.miss_type === 'break' || r.miss_type === 'both') ? 2 : 1); }, 0);
  var tripOk = ok.some(function (r) { return r.kind === 'trip'; });
  // 出差日：當天有打卡、湊不成完整一段就算忘刷，要忘打卡單；整天沒打卡、或打卡都成段（另一段是出差）不算（2026-11-10 Eason）
  var loneCard = (segs || []).some(function (s) { return (s.inMs == null) !== (s.outMs == null); });   // 有上班沒下班、有下班沒上班
  var missBad = bindOn && !(tripOk && !loneCard) && miss > missHave;   // 出差日只有「湊不成完整一段的卡」才要忘打卡單
  if (missBad) add('miss', '少了 ' + miss + ' 張打卡，要有忘打卡單（已核准 ' + missHave + ' 張）');
  if (strict) reqStrictLeaveProbs_(ok, opt.leaves).forEach(function (t) { add('leave', t); });
  var diffMin = strict ? reqPunchDiffMin_(periods, segs, breakWindow) : null;
  if (opt.preview) return { probs: probs, diff_min: diffMin, ot_have: otHave, ot_need: otNeed };
  if (probs.length) {
    var noLine = false;
    try { noLine = reqNoLine_(findRosterByEmpId(readSheetAsObjects(ss.getSheetByName('roster')).rows, empId)); } catch (e) {}   // 只在要擋的時候才讀名冊；讀不到照一般字句
    var hint = pend.length ? '這天有 ' + pend.length + ' 張申請還在審核中，請先到「申請審核」處理再送。' + (noLine ? '這位同仁沒綁 LINE，還缺別張單可以繼續代開。' : '')
      : noLine ? '這位同仁沒綁 LINE，請店長在考勤管理「代開申請」，送總監層級審核。'
      : '請同仁在 LINE「加班請假」補申請；超過 7 天請店長在考勤管理「代開申請」，送總監層級審核。';
    // 2026-11-11（B35）：少卡、而那天有新手機待核准的卡（舊連結才會有）——出路是先核准裝置，不是補忘打卡單
    // 待核准的張數補得齊缺的張數才說「不用補」；補不齊就講核准後還少幾張，補申請的指引照留（獨立審查補）
    if (missBad && opt.pending_device > 0) {
      var stillMiss = miss - missHave - opt.pending_device;
      hint = '這天有 ' + opt.pending_device + ' 張新手機待核准的打卡，請先到「待核准裝置」核准這支手機' +
        (stillMiss > 0 ? '；核准後還少 ' + stillMiss + ' 張，' + hint
          : '，再回來核定（核准後就不用補忘打卡單）。' + (otBad || pend.length ? hint : ''));
    }
    return { ok: false, error: 'need_request', message: '這天還不能核定：' + probs.map(function (p) { return p.text; }).join('；') + '。' + hint,
             need: { ot_hours: otBad ? otNeed : 0, ot_have: otHave, miss_cards: missBad ? miss : 0, miss_have: missHave, pending: pend.length } };
  }
  if (diffMin != null && diffMin >= REQ_STRICT_DIFF_MIN && !reqCleanDiffReason_(opt.diff_reason)) {
    return { ok: false, error: 'need_diff_reason', diff_min: diffMin,
             message: '核定和打卡差 ' + diffMin + ' 分鐘，要填原因才能送出。' + (opt.acting === false ? '舊的值班核定頁不能填原因，請到管理系統「考勤管理」核定。' : '') };
  }
  return null;
}

/** {action:'approve_strict_preview', admin_key, from, to}：用核定加嚴的同一支判斷試算已存在的核定，只讀不寫（班表在 Mac mini，這裡一律當查不到＝一般日）。 */
function handleApproveStrictPreview_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var from = String(body.from || ''), to = String(body.to || '');
  if (!reqIsDate_(from) || !reqIsDate_(to) || from > to) return { ok: false, error: 'bad_date' };
  var ss = getSS(), rows = reqRows_(ss), items = [], scanned = 0;
  var approvedMap = buildLatestApprovedMap(readSheetAsObjects(ss.getSheetByName('approved')).rows);
  var events = dropDupIgnored_(readSheetAsObjects(ss.getSheetByName('events')).rows, dupIgnoreSet_(approvedMap));
  var lsh = ss.getSheetByName('leave');
  var leaveRows = lsh ? readSheetAsObjects(lsh).rows : [];
  Object.keys(approvedMap).forEach(function (date) {
    if (date < from || date > to) return;
    Object.keys(approvedMap[date]).forEach(function (emp) {
      var rec = approvedMap[date][emp], name = String(rec.name || '').trim();
      var leaves = leaveRows.filter(function (r) { return normCellDate(r['日期']) === date && String(r['姓名'] || '').trim() === name; })
        .map(function (r) { return { type: String(r['假別'] || ''), hours: r['時數'] === '' ? '' : Number(r['時數']) }; });
      var trip = leaves.reduce(function (a, x) { return a + (x.type === '出差' ? Number(x.hours) || 0 : 0); }, 0);
      var periods = parsePeriodsStr(rec.periods).map(function (p) {
        var s = reqHmMs_(date, p.start), e = reqHmMs_(date, p.end);
        return { startMs: s, endMs: e <= s ? e + 86400000 : e };
      });
      var punchDay = periods.length ? dayPunchSegments(events, emp, date) : null;
      var segs = punchDay ? punchDay.segments.map(function (x) {
        return { inMs: x.in ? reqHmMs_(date, x.in) : null, outMs: x.out ? reqHmMs_(x.cross ? addDaysStr(date, 1) : date, x.out) : null };
      }) : [];
      if (punchDay && typeof markWorkingSeg_ === 'function') markWorkingSeg_(punchDay, date, segs);   // B34：還在上班的那張不算少一張
      scanned++;
      var r = reqBindCheck_(ss, emp, date, Number(rec.approved_hours) || 0, periods, segs, noPunchBreakWindow(date),
        { leaves: leaves, trip_hours: trip, rows: rows, force_strict: true, preview: true });
      if (r && (r.probs.length || (r.diff_min != null && r.diff_min >= REQ_STRICT_DIFF_MIN))) {
        items.push({ date: date, emp_id: emp, name: name, hours: Number(rec.approved_hours) || 0, leaves: leaves, probs: r.probs, diff_min: r.diff_min, ot_have: r.ot_have, ot_need: r.ot_need });
      }
    });
  });
  items.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { ok: true, from: from, to: to, scanned: scanned, items: items };
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
  var hide = reqHomeHide_(body);   // 不算支援的人不提醒本店主管（2026-10-29）
  if (hide) r.items = r.items.filter(function (x) { return !hide[String(x.emp_id)]; });
  return r;
}
