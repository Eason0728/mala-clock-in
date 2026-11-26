/**
 * 加班請假／忘打卡申請＋主管 QR 打卡備案（2026-10-09 Eason 定案，規格見 mala-clock-liff docs/requests-spec.md）
 *
 * 五家店整檔共用（同 Liff.gs）：同仁從 LINE 打卡頁送申請 → 存這家店的 requests 分頁 → 值班主管在核定頁審。
 * 核准只是「預填當天核定」，主管送出核定才算數；打卡紀錄（events）一律不改。
 * 忘打卡：只能申請 4 天內（2026-11-14 由 7 改 4；T01 不限，見 reqPastLimit_）、補登後仍算一次忘刷卡（不改全勤規則）。
 * 結果不推播（推播要花額度）：同仁在「我的申請」看，或下一次打卡成功時畫面告知（reqUnseenNotes_）。
 * 程式碼.js 不動；動作掛在 Liff.gs 的 LIFF_HANDLERS。
 */

var REQ_SHEET_ = 'requests';
// ⚠ 只能往後加欄（2026-10-09 加 comp）：上線前建的 requests 分頁只有前 18 欄，寫入時 reqHeads_ 會自動補表頭
var REQ_HEADERS_ = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours',
                    'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp',
                    'voided_at', 'voided_by', 'void_reason',   // 作廢已核准的申請（2026-10-26）：decided_* 保留原核准紀錄
                    'proxy_by',    // 主管代開（2026-11-06）：代開人姓名；有值＝只有總監層級能審
                    'grp'];        // 一次填兩段（2026-11-18）：同一次送出的兩張單同一個值；舊列、一張的單空白
var REQ_COMP_LEAVE_ = '補休';   // 補休（2026-10-09）：不在 Code.gs LEAVE_TYPES 白名單裡，請假申請另外放行
var REQ_KINDS_ = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡' };
var REQ_MISS_DAYS = 4;          // 忘打卡只能申請 4 天內（含今天；2026-11-14 Eason 由 7 改 4，T01 一樣不限）
var REQ_LEAVE_PAST_DAYS = 4;    // 請假（含補休）／加班／出差可補申請到 4 天前，超過由店長代開（2026-11-14 Eason：原本 7 天，11-05 前是 31 天）
/* T01（11/1–11/28）先不限幾天前（2026-11-14 Eason）：今天還在 11/28（含）以前，11/1 起的日子都能自己補申請；
   11/29（T02 第一天）起一律只能補到 4 天前，T01 的日子也一樣。忘打卡同一套（2026-11-14 Eason 追加），天數看 REQ_MISS_DAYS。 */
var REQ_PAST_OPEN_FROM_ = '2026-11-01';
var REQ_PAST_OPEN_TO_ = '2026-11-28';
/** 請假／加班／出差（base 省略）、忘打卡（base＝REQ_MISS_DAYS）最多能補申請到幾天前（date、today 都是台北日期字串）。 */
function reqPastLimit_(date, today, base) {
  var b = base == null ? REQ_LEAVE_PAST_DAYS : base;
  if (today <= REQ_PAST_OPEN_TO_ && date >= REQ_PAST_OPEN_FROM_) return Math.max(b, reqDayDiff_(today, REQ_PAST_OPEN_FROM_));
  return b;
}
/** 請假／加班／出差的日期超出範圍 → 錯誤物件；可以回 null。label：請假／加班／出差 */
function reqPastCheck_(label, date, today, proxy) {
  var diff = reqDayDiff_(date, today);
  if (diff > REQ_FUTURE_DAYS) return { error: 'bad_date', message: label + '最遠只能申請到 ' + REQ_FUTURE_DAYS + ' 天後' };
  if (!proxy && diff < -reqPastLimit_(date, today)) return { error: 'too_old', message: '超過 ' + REQ_LEAVE_PAST_DAYS + ' 天不能自己申請' + label + '，請店長代開' };
  return null;
}
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
   事假應前一天請（送出那天＞＝請假那天）；出差應前一週填（送出到出差不到 7 天）；本月事假合計超過 3 天（8 小時一天）。
   「本月第 3 次事假」的提醒 2026-11-18 Eason 拿掉（N4：「事假不需要本月第幾次提醒」；只動提醒，不動任何計算）。
   忘打卡：本月第幾次（同一人、同一個月、審核中＋已核准的忘打卡申請，依日期排；一張申請算一次）。 */
var REQ_PERSONAL_TYPE_ = '事假';
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
    var pl = r.__pl;   // 本月第幾次的提醒 2026-11-18 拿掉（N4），只留合計天數
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
    // 格線欄數不夠就先補欄（2026-11-18 加 grp 欄時補的防護；正式分頁預設 26 欄，平常用不到）
    var needCols = heads.length + missing.length;
    if (typeof sh.getMaxColumns === 'function' && typeof sh.insertColumnsAfter === 'function' && sh.getMaxColumns() < needCols) {
      sh.insertColumnsAfter(sh.getMaxColumns(), needCols - sh.getMaxColumns());
    }
    sh.getRange(1, heads.length + 1, 1, missing.length).setValues([missing]);
    for (var i = 0; i < missing.length; i++) { var L = reqColLetter_(heads.length + 1 + i); sh.getRange(L + ':' + L).setNumberFormat('@'); }
    heads = heads.concat(missing);
  }
  return heads;
}
function reqRows_(ss) {
  var tR = Date.now();
  try { return reqRowsRaw_(ss); } finally { if (typeof chkT_ === 'function') chkT_('req_rows', Date.now() - tR); }
}
function reqRowsRaw_(ss) {
  var sh = reqSheet_(ss, false);
  if (!sh) return [];
  return reqSegMark_(reqSickMark_(readSheetAsObjects(sh).rows.map(function (r) {
    r.date = normCellDate(r.date); r.created_at = String(normCellTs(r.created_at) || '');
    r.start = reqHm_(r.start); r.end = reqHm_(r.end);
    return r;
  })));
}
/** 一次填多段：同一個 grp 的單依表上先後標 __seg（1、2…最多 4）；寫入時已照時間排好，所以表上先後＝時間先後。沒有 grp 的不標。 */
function reqSegMark_(rows) {
  var n = {};
  rows.forEach(function (r) {
    var g = String(r.grp == null ? '' : r.grp).trim();
    if (!g) return;
    n[g] = (n[g] || 0) + 1;
    r.__seg = n[g];
  });
  return rows;
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
           proxy_by: String(r.proxy_by || ''),
           group: String(r.grp == null ? '' : r.grp), seg: r.__seg || null };   // 一次填兩段（2026-11-18）：同一次送出的兩張 group 一樣、seg＝第幾段
}
function reqSetCells_(sh, rowIndex, patch) {
  var heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  Object.keys(patch).forEach(function (k) {
    var c = heads.indexOf(k);
    if (c >= 0) sh.getRange(rowIndex, c + 1).setValue(reqSheetText_(patch[k], k));
  });
}
/** 一句話描述一筆申請（主管頁、我的申請、打卡後告知共用）。 */
function reqSummary_(r) { return reqSummaryBase_(r) + (r.proxy_by ? '（' + reqProxyName_(r.proxy_by) + '代開）' : ''); }
/** 代開人顯示名（2026-11-14 Eason：代開一律顯示姓名，不顯示職稱）：proxy_by 存「姓名（工號）」，只取姓名。 */
function reqProxyName_(by) { return String(by || '').replace(/（[^（）]*）\s*$/, '').trim() || '主管'; }
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

/* ── 簽名寫回的同仁身分（2026-11-21 方案 A，Eason 定案；契約 docs/contract-writeback.md 第 10 節）──
   mini 驗過 LINE 身分、規則判可以之後，用 mini 的簽名寫回 req_submit／req_cancel（DutyFeed.gs dutyLineWbRun_）。
   wbWho 只有那支包裝在「簽名對＋在職主管金鑰對」之後才傳進來（第二個參數；doPost 路由只傳一個參數）。
   其他（沒帶簽名、或 google 模式下簽名不合格＝當沒帶的 DUTY_LINE_PASS_）一律照舊用 id_token 認人。 */
function reqWhoOf_(body, wbWho) { return wbWho && wbWho.me ? wbWho : reqStaff_(body); }
/** 簽名綁住的工號 → 名冊在職且唯一的那列；那列沒綁 LINE＝not_bound；那個 LINE 綁了兩位在職＝line_identity_conflict（同 liffRosterByLine_）。
 *  帶了 id_token 而且驗得過：必須是同一個 LINE 帳號，不是＝line_emp_mismatch；驗不過（過期）＝當沒帶（tokenless）。 */
function reqWbWho_(body) {
  var ss = getSS(), sh = ss.getSheetByName('roster');
  if (!sh) return { error: 'no_roster' };
  var rows = readSheetAsObjects(sh).rows, emp = String(body.emp_id == null ? '' : body.emp_id);
  var isOn = function (r) { return String(r.active).toLowerCase() === 'true'; };
  var mine = emp ? rows.filter(function (r) { return String(r.emp_id) === emp && isOn(r); }) : [];
  if (mine.length > 1) return { error: 'line_identity_conflict' };
  if (!mine.length || !mine[0].line_user_id) return { error: 'not_bound' };
  var uid = String(mine[0].line_user_id);
  if (rows.filter(function (r) { return r.line_user_id && String(r.line_user_id) === uid && isOn(r); }).length > 1) return { error: 'line_identity_conflict' };
  var tokenless = true;
  if (body.id_token) {
    var tu = null;
    try { tu = verifyLineIdToken_(body.id_token); } catch (e) { tu = null; }
    if (tu && String(tu) !== uid) return { error: 'line_emp_mismatch' };
    if (tu) tokenless = false;
  }
  return { userId: uid, me: mine[0], ss: ss, tokenless: tokenless, wb: true };
}
/** 沒有 token、這家店不是光復（本人額度表要拿 LINE 身分問光復）：生理假、家庭照顧假、病假（年度用完規則開著）不自動寫，
 *  回 need_line_token，營運系統照現行列衝突 line_token_lost 人工處理（Eason 定案題 2＝A）。其他假別、光復店＝null（照常判）。 */
function reqNeedLineToken_(r, who) {
  if (!who || !who.tokenless || typeof lineHubReqQuota_ === 'function' || !r || String(r.kind) !== 'leave') return null;
  if (REQ_CAP_LOCK_TYPES_.indexOf(String(r.leave_type)) === -1 && !reqMensApplies_(r) && !reqSickApplies_(r)) return null;
  return { ok: false, error: 'need_line_token', message: '這張假單要用同仁本人的 LINE 登入確認額度，登入憑證已不在，請人工處理' };
}
/** 到職滿六個月那天：有 token 或光復店＝照舊（LINE 身分）；沒有 token 的別家店＝主管核准時用的同一支（payroll_annual_from） */
function reqAnnualFromWho_(who, body) {
  if (who && who.tokenless && typeof lineHubReqQuota_ !== 'function') return reqAnnualFromByMgr_(who.me.emp_id, body.mgr_key);
  return reqAnnualFromLine_(who, body);
}
/** 簽名寫回、沒有 token、別家店的特休（Eason 2026-11-21 定案「比照鎖月」）：用主管金鑰問光復 payroll_annual_from。
 *  問到了（ok:true 且 annual_from 是字串）＝照舊判斷（空字串＝光復明確回這個人沒有到職日資料／不適用＝不擋；日期＝滿半年那天）；
 *  問不到（連不上、逾時、ok 不是 true、沒給 annual_from、給的不是日期）＝'retry'＝呼叫端回 busy 稍後重送、不寫入、不留記號。
 *  只有這條簽名路用；主管核准／代開仍用 reqAnnualFromEmp_（查不到＝不擋，不動）。 */
function reqAnnualFromByMgr_(empId, mgrKey) {
  try {
    var j = reqPayPost_({ action: 'payroll_annual_from', store: CONFIG.PAYROLL_STORE || '', mgr_key: String(mgrKey || ''), emp_id: String(empId) });
    if (!j || j.ok !== true || typeof j.annual_from !== 'string') return 'retry';
    if (j.annual_from !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(j.annual_from)) return 'retry';
    return j.annual_from;
  } catch (e) { return 'retry'; }
}
/** 沒有 token 時的鎖月（簽名寫回才會用）：用主管金鑰問光復 payroll_leave_options {lock_only:true}（光復同一個 payMonthLocked_）。
 *  回 true／false；這家店本來就不問光復（光復自己、沒填 PAYROLL_API／PAYROLL_STORE）＝undefined（照舊）；
 *  問不到（連不上、回錯誤、沒給 locked、回的不是問的那家店那個月）＝'retry'＝回 busy 稍後重送（Eason 定案題 3）。
 *  結果跟 reqPayLockRemote_ 共用 60 秒暫存（同一個判斷）。 */
function reqPayLockByMgr_(date, mgrKey) {
  if (typeof payMonthLocked_ === 'function') return undefined;
  var api = String(CONFIG.PAYROLL_API || '').trim(), st = String(CONFIG.PAYROLL_STORE || '').trim(), ym = String(date || '').slice(0, 7);
  if (!api || !st || !/^\d{4}-\d{2}$/.test(ym)) return undefined;
  var cache = null, ck = 'rqpl:' + st + ':' + ym;
  try {
    cache = CacheService.getScriptCache();
    var hit = cache.get(ck);
    if (hit === '1') return true;
    if (hit === '0') return false;
  } catch (e) { cache = null; }
  try {
    var resp = UrlFetchApp.fetch(api, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true, followRedirects: true,
      payload: JSON.stringify({ action: 'payroll_leave_options', store: st, mgr_key: String(mgrKey || ''), ym: ym, lock_only: true }) });
    var j = JSON.parse(resp.getContentText());
    if (!j || j.ok !== true || typeof j.locked !== 'boolean') return 'retry';
    if (String(j.ym) !== ym || String(j.store).toUpperCase() !== st.toUpperCase()) return 'retry';
    if (cache) { try { cache.put(ck, j.locked ? '1' : '0', REQ_PAY_LOCK_TTL_); } catch (e) { /* 記不了就下次再問 */ } }
    return j.locked;
  } catch (e) { return 'retry'; }
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
  reqSeg2Info_(out);   // 一次填兩段（2026-11-18）：這家店開了哪幾種、上限；舊頁面不認得這幾欄＝照舊一張一張送
  // 生理假新規則、病假年度用完（2026-11-18）：開關狀態＋「已核准、那天還沒核定」的病假時數與生理假日子（申請頁選假別時先提示，口徑同送單檢查）
  out.mens_rules = reqMensOn_(); out.sick_used_up = reqSickOn_();
  if (!dayOnly) out.leave_live = reqLeaveLiveOk_(all, who, today);
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
    var pastErr = reqPastCheck_('請假', date, today, proxy);
    if (pastErr) return pastErr;
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
    var pastErr = reqPastCheck_('加班', date, today, proxy);
    if (pastErr) return pastErr;
    row.start = reqHm_(b.start); row.end = reqHm_(b.end);
    if (!row.start || !row.end) return { error: 'bad_time', message: '請填加班時段' };
    row.hours = reqSpanHours_(row.start, row.end);
    // 單張上限：同仁自己送、店長代開都是 10 小時（2026-11-18 Eason N1；原本都是 12）。分兩個常數，之後要分開調不用改程式
    var otMax = proxy ? REQ_OT_PROXY_MAX_H : REQ_OT_MAX_H;
    if (row.hours > otMax) return { error: 'bad_time', message: '加班時段超過 ' + otMax + ' 小時，請確認時間' };
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
    var pastErr = reqPastCheck_('出差', date, today, proxy);
    if (pastErr) return pastErr;
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
    if (!proxy && diff < -reqPastLimit_(date, today, REQ_MISS_DAYS)) return { error: 'too_old', message: '超過 ' + REQ_MISS_DAYS + ' 天不能自己申請，請店長代開' };
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

/** 薪資鎖月後不可以再動（2026-11-15）：這個日期在已鎖定的月份 → { ok:false, error:'pay_locked', message }；沒鎖或不知道 → null。
 *  判斷在 Code.gs payLockedBlock_；staff＝true 用給同仁看的說法；ss＝手上已打開的本店試算表（帶了就不多開一次）。 */
function reqPayLock_(date, staff, ss) { return typeof payLockedBlock_ === 'function' ? payLockedBlock_(date, staff, ss) : null; }

/* 其他店同仁從 LINE 送鎖定月的申請也要擋（Eason 2026-11-16 回「要補」）。
   薪資模組只掛在光復，其他店的 payLockedFor_ 一律回「不知道」；主管動作有營運系統先擋，同仁從 LINE 申請頁送單不經營運系統。
   所以沒掛薪資模組、CONFIG.PAYROLL_API 與 PAYROLL_STORE 都有填的店，只在同仁送申請（handleReqSubmit_）這一條路問光復
   line_hub_pay_lock（LineHub.gs）：帶同仁自己的 LINE id_token，不帶任何金鑰。主管的路徑不走這裡（核定速度不能變慢）。
   「看哪家店」＝這個後端自己的 CONFIG.PAYROLL_STORE（跟主管動作同一個算法）。
   結果記 60 秒（鍵含店碼與月份；只記明確的鎖了／沒鎖），所以鎖定或解鎖後最多 60 秒才跟上。
   回 true／false；光復回 too_many（同仁自己問太多次）回 'retry'＝這張先不收、請他一分鐘後再送；其他問不到（連不上、逾時、回的不是 JSON、光復回錯誤或不給 locked）＝undefined＝不擋、不丟錯。光復自己（有薪資模組）一律回 undefined、不打網路。 */
var REQ_PAY_LOCK_TTL_ = 60;
function reqPayLockRemote_(date, idToken) {
  try {
    if (typeof payMonthLocked_ === 'function') return undefined;   // 光復：照舊讀自己的 payroll_run（reqPayLock_）
    var api = String(CONFIG.PAYROLL_API || '').trim(), st = String(CONFIG.PAYROLL_STORE || '').trim(), ym = String(date || '').slice(0, 7);
    if (!api || !st || !idToken || !/^\d{4}-\d{2}$/.test(ym)) return undefined;
    var cache = null, ck = 'rqpl:' + st + ':' + ym;
    try {
      cache = CacheService.getScriptCache();
      var hit = cache.get(ck);
      if (hit === '1') return true;
      if (hit === '0') return false;
    } catch (e) { cache = null; }
    var resp = UrlFetchApp.fetch(api, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true, followRedirects: true,
      payload: JSON.stringify({ action: 'line_hub_pay_lock', id_token: String(idToken), store: st, ym: ym }) });
    var j = JSON.parse(resp.getContentText());
    // 光復說「這位同仁一分鐘內問太多次」：額度是算在他自己的 LINE 帳號上，正常送單碰不到（一張單最多問一次）。
    // 這種不能當成不知道——不然先把自己的額度洗完再送，鎖定月的單就寫得進去（2026-11-16 複驗）。回 'retry'，請他等一下再送。
    if (j && j.ok === false && j.error === 'too_many') return 'retry';
    if (!j || j.ok !== true || typeof j.locked !== 'boolean') return undefined;
    if (String(j.ym) !== ym || String(j.store).toUpperCase() !== st.toUpperCase()) return undefined;   // 回的不是問的那家店那個月＝不算數
    if (cache) { try { cache.put(ck, j.locked ? '1' : '0', REQ_PAY_LOCK_TTL_); } catch (e) { /* 記不了就下次再問 */ } }
    return j.locked;
  } catch (e) { return undefined; }
}

/** {action:'req_submit', id_token, kind, date, leave_type?, start?, end?, hours?, miss_type?, reason?, attach_id?}
 *  wbWho（2026-11-21 方案 A，契約 docs/contract-writeback.md 第 10 節）：只有 DutyFeed.gs dutyLineWbRun_ 驗過簽名＋主管金鑰後才會傳，
 *  doPost 的路由（Liff.gs）只傳一個參數，外部請求帶什麼欄位都進不了這個參數。 */
function handleReqSubmit_(body, wbWho) {
  if (!wbWho && body && typeof body === 'object' && typeof dutyLineWbRun_ === 'function' && dutyWbHas_(body)) return dutyLineWbRun_(body, 'req_submit', handleReqSubmit_);
  var who = reqWhoOf_(body, wbWho);
  if (who.error) return { ok: false, error: who.error };
  // 申請單號（2026-11-21 P3-3，契約 docs/contract-writeback.md 第 4 節）：手機帶 req_id＝送 mini 與改送 Google 同一個號碼，同號只寫一次。沒帶＝跟以前一樣
  var reqId = reqSubmitIdOf_(body);
  if (reqId === null) return { ok: false, error: 'bad_req_id', message: '申請單號格式不對' };
  // 2026-11-21 驗收 P4：同號已寫過就先回 dup（在鎖月、額度等檢查之前）：mini 補送已寫過的單，月份剛好鎖了也要拿到 dup、不是 pay_locked。
  // 這裡不拿鎖、只讀：找到＝一定寫過；找不到照原流程，鎖內還會再查一次。
  if (reqId) { var preDup = reqSubmitDup_(reqId, reqRows_(who.ss), who); if (preDup) return preDup; }
  // 薪資鎖月後不可以再動（2026-11-15，Code.gs payLockedBlock_）：那個月的申請送不了
  var payLock = reqIsDate_(String(body.date || '')) ? reqPayLock_(String(body.date), true, who.ss) : null;
  if (payLock) return payLock;
  // 其他店（沒掛薪資模組）：問光復這家店這個月鎖了沒（2026-11-16）。類別、日期格式對了才問；問不到＝不擋
  if (Object.prototype.hasOwnProperty.call(REQ_KINDS_, String(body.kind || '')) && reqIsDate_(String(body.date || ''))) {
    // 簽名寫回、沒有 token：改用主管金鑰問光復同一個鎖月判斷（lock_only）；查不到回 busy 讓隊伍稍後重送（Eason 定案題 3，不可查不到就不擋）
    var remoteLock = who.tokenless ? reqPayLockByMgr_(String(body.date), body.mgr_key) : reqPayLockRemote_(String(body.date), body.id_token);
    if (remoteLock === true) return { ok: false, error: 'pay_locked', message: payLockedStaffMsg_(String(body.date)) };
    if (remoteLock === 'retry') return { ok: false, error: 'busy', message: '系統忙碌，請一分鐘後再送一次' };
  }
  // 一次填兩段（2026-11-18）：segments 兩段走 reqSubmitSegs_；只有一段＝照原本一張的流程（跟沒帶 segments 一模一樣）
  var segP = reqSegsOf_(body, false);
  if (segP && segP.error) return reqSegFail_(segP);
  if (segP && segP.single) { body = segP.single; segP = null; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請幾秒後再送一次' };
  try {
    var existing = reqRows_(who.ss);
    var dupR = reqId ? reqSubmitDup_(reqId, existing, who) : null;   // 同一把鎖內查：這個單號寫過就回原本那張，不再寫
    if (dupR) return dupR;
    if (segP) return reqSubmitSegs_(body, segP, who, existing, reqId);
    var v = reqValidate_(body, who.me, liffEvents_(who.ss), todayTaipeiStr(), existing);
    if (v.error) return { ok: false, error: v.error, message: v.message };
    var r = v.row;
    var needTok = reqNeedLineToken_(r, who);   // 簽名寫回、沒有 token：要本人額度表的假別不自動寫（2026-11-21 Eason 定案題 2）
    if (needTok) return needTok;
    // 補休（2026-11-01 改每月加減結算）：可以先休後補、不看餘額；只擋計時同仁（和薪資同專案的店〔光復〕查得到主檔才擋，其他店靠 LINE 申請頁與主管）
    if (r.kind === 'leave' && r.leave_type === REQ_COMP_LEAVE_ && reqCompAllowed_(who.me) === false) {
      return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
    }
    if (reqIsAnnual_(r)) {
      var anFrom = reqAnnualFromWho_(who, body);
      if (anFrom === 'retry') return { ok: false, error: 'busy', message: '系統忙碌，請一分鐘後再送一次' };   // 簽名路問不到滿半年那天：比照鎖月回 busy（不寫、不留記號）
      var anMsg = reqAnnualBlockMsg_(r, anFrom);
      if (anMsg) return { ok: false, error: 'annual_not_eligible', message: anMsg };
    }
    var mensErr = reqMensSubmitCheck_(r, existing, who, body);   // 生理假新規則（2026-11-18）：計時、第 4 次、每月一次、一天 8 小時；病假年度用完
    if (mensErr) return mensErr;
    var capMsg = reqCapLocked_(r, existing, who, body, { today: todayTaipeiStr(), recorded: reqLeaveRecorded_(who.ss, who.me.name, r) });
    if (capMsg) return { ok: false, error: 'quota_exhausted', message: capMsg };
    r.id = reqId || ('r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36));
    r.created_at = nowTaipeiIso(); r.emp_id = String(who.me.emp_id); r.name = String(who.me.name);
    r.attach_id = REQ_ATTACH_RE_.test(String(body.attach_id || '')) ? String(body.attach_id) : '';
    r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    reqMarkOne_(existing, r);   // 今年第幾天病假（滿 3 天才要證明）、本月第幾次忘打卡／事假（黃字提醒）
    var sh = reqSheet_(who.ss, true);
    sh.appendRow(reqHeads_(sh).map(function (h) { return r[h] === undefined ? '' : reqSheetText_(r[h], h); }));   // 照實際表頭寫（舊分頁沒有 comp 欄會先補）
    return { ok: true, request: reqPublic_(r), summary: reqSummary_(r) };
  } finally {
    if (reqId) { try { SpreadsheetApp.flush(); } catch (e) {} }   // 有單號：放鎖前寫進去，下一個查同號的一定看得到
    lock.releaseLock();
  }
}

/* ── 申請單號 req_id（2026-11-21 P3-3）──
   格式同打卡單號（RelayG.gs RELAYG_REQ_RE_）。單張的申請編號就用 req_id；一次多段第 n 段用 req_id_n。
   查試算表本身（不是暫存記號），所以沒有時間限制：mini 停機一天後回來再送，同號還是只算一張。 */
var REQ_SUBMIT_ID_RE_ = /^r[0-9a-f]{16}$/;
/** '' ＝沒帶；null＝帶了但格式不對；其他＝單號 */
function reqSubmitIdOf_(body) {
  var v = body ? body.req_id : undefined;
  if (v === undefined || v === null || v === '') return '';
  v = String(v);
  return REQ_SUBMIT_ID_RE_.test(v) ? v : null;
}
function reqSubmitSegNo_(id, reqId) { var n = Number(String(id).slice(reqId.length + 1)); return isFinite(n) ? n : 0; }
/** 這個單號寫過了 → 回原本那張（或那幾張）現在的樣子＋dup:true；不是這位同仁的 → req_id_taken；沒寫過 → null */
function reqSubmitDup_(reqId, existing, who) {
  var hits = (existing || []).filter(function (x) { var id = String(x.id); return id === reqId || id.indexOf(reqId + '_') === 0; });
  if (!hits.length) return null;
  var me = String(who.me.emp_id);
  if (hits.some(function (x) { return String(x.emp_id) !== me; })) return { ok: false, error: 'req_id_taken', message: '申請單號重複，請重新送出' };
  if (hits.length === 1 && String(hits[0].id) === reqId) return { ok: true, request: reqPublic_(hits[0]), summary: reqSummary_(hits[0]), dup: true };
  hits.sort(function (a, b) { return reqSubmitSegNo_(a.id, reqId) - reqSubmitSegNo_(b.id, reqId); });
  return { ok: true, request: reqPublic_(hits[0]), requests: hits.map(reqPublic_), summary: reqSummarySegs_(hits), group: String(hits[0].grp || ''), dup: true };
}

/* ── 一次填兩段（2026-11-18 Eason；設計：一次填兩段第 2 版＋最終決定 N1–N5，docs/decisions/0002）──
   同一天兩段加班／請假／出差一次送出 → 拆成兩張普通的單（同一個 grp、同一個 created_at），各自照現有規則檢查（reqValidate_）。
   第二段檢查時把第一段當成一張審核中的單一起比（＝分兩次送時第二張看到的樣子）。兩段都過才用一次 setValues 寫兩列；
   任一段沒過一列都不寫，訊息開頭標「第一段：」「第二段：」（兩段共用的欄位錯了不標）。
   核定、薪資規則完全不動：寫進去的兩列跟同仁分兩次送一模一樣，只多 grp 欄。
   開關：指令碼屬性 REQ_SEG2_KINDS（逗號分隔：ot、leave、trip；沒設或空白＝全關＝跟以前一樣），req_info 回 seg2_kinds 給申請頁看。
   不開放：忘打卡；請假、出差的「整天／只填時數」；（生理假 2026-11-18 起開放：送單端改成一天算一次、兩段合計 8 小時；
   緊急開關 REQ_MENS_RULES=off 時照舊不開放）；
   店長代開的請假、出差（N3，代開本來就只填時數）。
   2026-11-21 加班一次最多四段（Eason）：上限依類別設（REQ_SEG_MAX_N_：加班 4、請假 2、出差 2）；各段兩兩比對（重疊、接在一起都擋）；
   加班合計上限照舊 10 小時（同仁、代開都是）。寫入格式不變：每段一列、同一個 grp、__seg 依時間先後編號；請假、出差仍最多兩段。 */
var REQ_OT_MAX_H = 10;          // 同仁自己送的加班：單張上限，也是兩段合計上限（N1；原本單張 12）
var REQ_OT_PROXY_MAX_H = 10;    // 店長代開的加班：單張與兩段合計上限（N1 更正，2026-11-18 Eason：「代開也是 10 小時」；原本 12）
var REQ_SEG2_TOTAL_MAX_H_ = { leave: 8, trip: 8 };   // 請假、出差兩段合計上限（N2）；單段上限照舊（請假 12、出差 8）
var REQ_SEG2_KINDS_OK_ = { ot: 1, leave: 1, trip: 1 };
var REQ_SEG2_NO_TYPES_ = ['生理假'];   // 生理假新規則關掉（REQ_MENS_RULES=off）時才用這份
function reqSeg2NoTypes_() { return reqMensOn_() ? [] : REQ_SEG2_NO_TYPES_.slice(); }
var REQ_SEG_LABEL_ = ['第一段', '第二段', '第三段', '第四段'];
var REQ_SEG_MAX_N_ = { ot: 4, leave: 2, trip: 2 };   // 一次最多幾段（依類別；2026-11-21 加班 2→4，請假、出差維持 2）
var REQ_SEG_NUM_ = ['', '一', '兩', '三', '四'];
function reqSegNum_(n) { return REQ_SEG_NUM_[n] || String(n); }
/** 超過上限的白話訊息（照類別） */
function reqSegTooMany_(kind) {
  return kind === 'ot' ? '加班一次最多填' + reqSegNum_(REQ_SEG_MAX_N_.ot) + '段時間' : '請假、出差一次最多填' + reqSegNum_(REQ_SEG_MAX_N_[kind] || 2) + '段時間';
}
var REQ_EARLY_SEG_MIN_ = 6 * 60;   // 排先後：06:00 前開始的段當成跨過午夜的那一段（同「凌晨 06:00 前的下班卡歸前一天」）
function reqHasOwn_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
/** 這家店開放兩段的類別（照 REQ_SEG2_KINDS，只認 ot／leave／trip，去重、照寫的順序） */
function reqSeg2Kinds_() {
  var raw = '';
  try { raw = String(reqProp_('REQ_SEG2_KINDS') || ''); } catch (e) { raw = ''; }
  var out = [];
  raw.split(/[\s,，、]+/).forEach(function (k) {
    k = String(k || '').trim().toLowerCase();
    if (k && reqHasOwn_(REQ_SEG2_KINDS_OK_, k) && out.indexOf(k) < 0) out.push(k);
  });
  return out;
}
/** 多段合計上限（小時） */
function reqSeg2MaxH_(kind, proxy) { return kind === 'ot' ? (proxy ? REQ_OT_PROXY_MAX_H : REQ_OT_MAX_H) : REQ_SEG2_TOTAL_MAX_H_[kind]; }
/** req_info 多回的欄位（申請頁用來決定要不要出現「＋ 加一段」、最多幾段、合計上限） */
function reqSeg2Info_(out) {
  var kinds = reqSeg2Kinds_();
  out.seg2_kinds = kinds;
  out.seg2_max_h = { ot: REQ_OT_MAX_H, leave: REQ_SEG2_TOTAL_MAX_H_.leave, trip: REQ_SEG2_TOTAL_MAX_H_.trip };
  out.seg2_no_types = reqSeg2NoTypes_();
  out.ot_max_h = REQ_OT_MAX_H;
  out.ot_segments_max = kinds.indexOf('ot') < 0 ? 1 : REQ_SEG_MAX_N_.ot;   // 申請頁依這個決定加班能「＋加一段」到第幾段（舊頁面只認 2 以上＝出現一顆「加第二段」）
  return out;
}
/** 兩段是不是接在一起（一段的結束＝另一段的開始，含跨夜）；reqOverlap_ 把接在一起當成不重疊，多段時要另外擋 */
function reqSegTouch_(s1, e1, s2, e2) {
  var a = reqMin_(s1), b = reqMin_(e1), c = reqMin_(s2), d = reqMin_(e2);
  if (a === null || b === null || c === null || d === null) return false;
  if (b <= a) b += 1440;
  if (d <= c) d += 1440;
  return [0, 1440, -1440].some(function (k) { return b === c + k || d + k === a; });
}
function reqRound2_(h) { return Math.round(h * 100) / 100; }
/** body.segments → null（沒帶：照原本一張的流程）｜{single: 換成一張的 body}（只有一段）｜{segs:[{start,end,hours,i}]（照輸入順序）, total, max}｜{error, message, seg?}
 *  只看格式與各段互相比對（兩兩比），不讀表。段數上限依類別（REQ_SEG_MAX_N_：加班 4、請假、出差 2）。 */
function reqSegsOf_(body, proxy) {
  if (!body || body.segments === undefined || body.segments === null) return null;
  var list = body.segments;
  var kind = String(body.kind || ''), okKind = reqHasOwn_(REQ_SEG2_KINDS_OK_, kind);
  var maxN = okKind ? (REQ_SEG_MAX_N_[kind] || 2) : 2;   // 不是加班、請假、出差的單（忘打卡）：多於兩段一律擋
  if (!Array.isArray(list) || list.length < 1) return { error: 'bad_segments', message: '時段格式不對，請重新填' };
  if (list.length > maxN) return { error: 'bad_segments', message: okKind ? reqSegTooMany_(kind) : '只有加班、請假、出差可以分段填時間' };
  for (var j = 0; j < list.length; j++) if (!list[j] || typeof list[j] !== 'object' || Array.isArray(list[j])) return { error: 'bad_segments', message: '時段格式不對，請重新填' };
  if (list.length === 1) {
    var one = {};
    Object.keys(body).forEach(function (k) { if (k !== 'segments') one[k] = body[k]; });
    one.start = list[0].start; one.end = list[0].end;
    return { single: one };
  }
  if (!okKind) return { error: 'bad_segments', message: '只有加班、請假、出差可以分段填時間' };
  if (proxy && kind !== 'ot') return { error: 'bad_segments', message: '代開請假、出差不分段，請照現在填時數' };
  if (reqSeg2Kinds_().indexOf(kind) < 0) return { error: 'seg2_off', message: '這家店還沒開放一次填兩段，請一段一段分開送' };
  if (kind === 'leave' && reqSeg2NoTypes_().indexOf(reqClean_(body.leave_type, 30)) >= 0) return { error: 'seg2_type', message: reqClean_(body.leave_type, 30) + '一天只算一次，不能分兩段，請填成一段' };
  var what = REQ_KINDS_[kind], segs = [], n = list.length;
  for (var i = 0; i < n; i++) {
    var s = reqHm_(list[i].start), e = reqHm_(list[i].end);
    if (!s || !e) return { error: 'bad_time', seg: i + 1, message: REQ_SEG_LABEL_[i] + '：請填完整的' + what + '時段' };
    if (s === e) return { error: 'bad_time', seg: i + 1, message: REQ_SEG_LABEL_[i] + '：開始和結束時間一樣，請確認' };
    segs.push({ start: s, end: e, hours: reqSpanHours_(s, e), i: i });
  }
  // 兩兩比：任何兩段重疊或接在一起都擋（兩段時訊息跟以前一樣；三、四段時指出是第幾段跟第幾段）
  var txt = segs.map(function (x) { return x.start + '–' + x.end; });
  for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
    var A = segs[a], B = segs[b], pair = n === 2 ? txt.join('、') : txt[a] + '、' + txt[b], who = n === 2 ? '兩段' : REQ_SEG_LABEL_[a] + '和' + REQ_SEG_LABEL_[b];
    if (reqOverlap_(A.start, A.end, B.start, B.end) === true) return { error: 'seg_overlap', message: who + '時間重疊（' + pair + '），請確認時間' };
    if (reqSegTouch_(A.start, A.end, B.start, B.end)) return { error: 'seg_touch', message: who + '時間接在一起（' + pair + '），請直接填成一段' };
  }
  var total = reqRound2_(segs.reduce(function (t, x) { return t + x.hours; }, 0)), max = reqSeg2MaxH_(kind, proxy);
  if (total > max + 0.001) return { error: 'seg_total', message: reqSegNum_(n) + '段合計 ' + total + ' 小時，超過' + what + '一天上限 ' + max + ' 小時' };
  return { segs: segs, total: total, max: max };
}
/* 兩段共用的欄位錯了（假別、原因、地點、日期太早／太晚）不標第幾段；跟時段有關的才標 */
var REQ_SEG_SHARED_ERR_ = { bad_kind: 1, bad_leave_type: 1, need_reason: 1, need_place: 1, bad_place: 1, too_old: 1 };
function reqSegErr_(i, v) {
  var shared = reqHasOwn_(REQ_SEG_SHARED_ERR_, v.error) || (v.error === 'bad_date' && String(v.message || '').indexOf('跨夜班') < 0);
  return { error: v.error, seg: shared ? null : i + 1, message: (shared ? '' : REQ_SEG_LABEL_[i] + '：') + v.message };
}
function reqSegFail_(v) { var o = { ok: false, error: v.error, message: v.message }; if (v.seg) o.seg = v.seg; return o; }
/** 逐段跑 reqValidate_（後面的段把前面的段當成審核中的單）→ {rows:[第一段…最多第四段]（照輸入順序）}｜{error, message, seg} */
function reqSegsValidate_(body, segP, me, events, today, existing, proxy) {
  var seen = (existing || []).slice(), rows = [];
  for (var i = 0; i < segP.segs.length; i++) {
    var b = {};
    Object.keys(body).forEach(function (k) { if (k !== 'segments' && k !== 'hours') b[k] = body[k]; });
    b.start = segP.segs[i].start; b.end = segP.segs[i].end;
    var v = reqValidate_(b, me, events, today, seen, proxy);
    if (v.error) return reqSegErr_(i, v);
    rows.push(v.row);
    var pseudo = { id: '__seg' + i, emp_id: String(me.emp_id), status: 'pending', created_at: '' };
    Object.keys(v.row).forEach(function (k) { pseudo[k] = v.row[k]; });
    seen.push(pseudo);
  }
  return { rows: rows };
}
/** 同仁送多段（handleReqSubmit_ 在鎖裡呼叫）：補休、特休、額度只檢查一次（同一個人、同一天、同一個假別；額度用各段合計比＝分兩次送的結果） */
function reqSubmitSegs_(body, segP, who, existing, reqId) {
  var today = todayTaipeiStr();
  var sv = reqSegsValidate_(body, segP, who.me, liffEvents_(who.ss), today, existing, false);
  if (sv.error) return reqSegFail_(sv);
  var r0 = sv.rows[0];
  var needTok = reqNeedLineToken_(r0, who);   // 簽名寫回、沒有 token：要本人額度表的假別不自動寫（2026-11-21 Eason 定案題 2）
  if (needTok) return needTok;
  if (r0.kind === 'leave' && r0.leave_type === REQ_COMP_LEAVE_ && reqCompAllowed_(who.me) === false) {
    return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
  }
  if (reqIsAnnual_(r0)) {
    var anFrom = reqAnnualFromWho_(who, body);
    if (anFrom === 'retry') return { ok: false, error: 'busy', message: '系統忙碌，請一分鐘後再送一次' };   // 同上（多段）
    var anMsg = reqAnnualBlockMsg_(r0, anFrom);
    if (anMsg) return { ok: false, error: 'annual_not_eligible', message: anMsg };
  }
  var both = {};
  Object.keys(r0).forEach(function (k) { both[k] = r0[k]; });
  both.hours = segP.total;
  var mensErr = reqMensSubmitCheck_(both, existing, who, body);   // 兩段同一天＝一次，時數用兩段合計
  if (mensErr) return mensErr;
  var capMsg = reqCapLocked_(both, existing, who, body, { today: today, recorded: reqLeaveRecorded_(who.ss, who.me.name, r0) });
  if (capMsg) return { ok: false, error: 'quota_exhausted', message: capMsg };
  var aid = REQ_ATTACH_RE_.test(String(body.attach_id || '')) ? String(body.attach_id) : '';   // 證明附一次，兩列寫同一個
  return reqSaveSegs_(who.ss, sv.rows, existing, { emp_id: String(who.me.emp_id), name: String(who.me.name), attach_id: aid, req_id: reqId || '' });
}
/** 照時間先後排（06:00 前開始的段排在後面＝跨過午夜那段；都在 06:00 前就照開始時間） */
function reqSegSort_(rows) {
  var key = function (r) { var m = reqMin_(r.start); return m < REQ_EARLY_SEG_MIN_ ? m + 1440 : m; };
  return rows.slice().sort(function (a, b) { return key(a) - key(b); });
}
function reqNewId_(taken) {
  var id;
  do { id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); } while (taken[id]);
  taken[id] = true;
  return id;
}
/** 各段都過了才寫：同一個 grp、同一個 created_at，照時間先後排，一次 setValues 寫好幾列。
 *  base：{emp_id, name, attach_id, proxy_by?}。回 {ok, request（第一段，舊欄位）, requests:[各段], summary, group}。 */
function reqSaveSegs_(ss, rows, existing, base) {
  var now = nowTaipeiIso(), taken = {};
  (existing || []).forEach(function (x) { taken[String(x.id)] = true; });
  var gid = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  var seen = (existing || []).slice();
  rows = reqSegSort_(rows);
  rows.forEach(function (r, i) {
    r.id = base.req_id ? base.req_id + '_' + (i + 1) : reqNewId_(taken);   // 帶申請單號（P3-3）：第 n 段＝單號_n
    r.created_at = now; r.emp_id = String(base.emp_id); r.name = String(base.name);
    r.attach_id = base.attach_id || '';
    r.status = 'pending'; r.decided_at = ''; r.decided_by = ''; r.reject_reason = ''; r.seen_at = '';
    if (base.proxy_by) r.proxy_by = base.proxy_by;
    r.grp = gid; r.__seg = i + 1;
    reqMarkOne_(seen, r);   // 後面的段把前面的段算進去（病假今年第幾天：同一天算同一天）
    seen.push(r);
  });
  var sh = reqSheet_(ss, true), heads = reqHeads_(sh);
  reqAppendRows_(sh, rows.map(function (r) { return heads.map(function (h) { return r[h] === undefined ? '' : reqSheetText_(r[h], h); }); }));
  return { ok: true, request: reqPublic_(rows[0]), requests: rows.map(reqPublic_), summary: reqSummarySegs_(rows), group: gid };
}
/** 一次寫好幾列（一個範圍一次 setValues；格線列數不夠先補列，appendRow 本來會自己長列） */
function reqAppendRows_(sh, vals) {
  if (!vals.length) return;
  var start = sh.getLastRow() + 1, need = start + vals.length - 1;
  if (typeof sh.getMaxRows === 'function' && typeof sh.insertRowsAfter === 'function' && sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(start, 1, vals.length, vals[0].length).setValues(vals);
}
/** 多段送出的摘要：「11/15 加班兩段 11:00–14:00、17:00–21:00（共 7 小時）」（三段、四段同寫法） */
function reqSummarySegs_(rows) {
  var r = rows[0], md = parseInt(String(r.date).slice(5, 7), 10) + '/' + parseInt(String(r.date).slice(8, 10), 10);
  var times = rows.map(function (x) { return x.start + '–' + x.end; }).join('、');
  var tot = reqRound2_(rows.reduce(function (a, x) { return a + (Number(x.hours) || 0); }, 0));
  var s;
  var nw = reqSegNum_(rows.length);
  if (r.kind === 'ot') s = md + ' 加班' + nw + '段 ' + times + '（共 ' + tot + ' 小時）';
  else if (r.kind === 'leave') s = md + ' ' + r.leave_type + nw + '段 ' + times + '（共 ' + tot + ' 小時）';
  else { var place = reqTripPlace_(r.reason); s = md + ' 出差' + nw + '段 ' + times + '（共 ' + tot + ' 小時' + (place ? '，地點：' + place : '') + '）'; }
  return s + (r.proxy_by ? '（' + reqProxyName_(r.proxy_by) + '代開）' : '');
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
/** 同仁自己的額度表＋是不是正職（光復同專案直接算；別店打光復 line_hub_req_quota，帶同一個 LINE 身分）。
 *  回 {quota:[]|null, ft:true|false|null}；查不到＝null（不擋）。舊光復沒有 ft 欄＝null。 */
function reqQuotaFetch_(who, body) {
  try {
    if (typeof lineHubReqQuota_ === 'function') {
      var q = lineHubReqQuota_(who.userId) || {};
      return { quota: q.quota || null, ft: q.ft === true || q.ft === false ? q.ft : null };
    }
    var resp = UrlFetchApp.fetch(CONFIG.PAYROLL_API || REQ_HUB_API_DEFAULT_, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'line_hub_req_quota', id_token: body.id_token }) });
    var j = JSON.parse(resp.getContentText());
    return j && j.ok ? { quota: j.quota, ft: j.ft === true || j.ft === false ? j.ft : null } : { quota: null, ft: null };
  } catch (e) { return { quota: null, ft: null }; }
}
function reqCapLocked_(r, existing, who, body, opt) {
  if (r.kind !== 'leave' || REQ_CAP_LOCK_TYPES_.indexOf(String(r.leave_type)) === -1) return '';
  if (reqMensApplies_(r)) return '';   // 生理假新規則開著：改走 reqMensBlock_（一天算一次）
  opt = opt || {};
  var quota = reqQuotaFetch_(who, body).quota;
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

/* ── 生理假新規則（2026-11-18 Eason；設計 scratchpad menstrual/design.md＋decisions.md）──
   ① 一天算一次：同一個人、同一天，不管幾張單、幾段、幾小時都只算 1 次（時數空白的登記也算 1 次）。
   ② 一天合計最多 8 小時：那天登記的生理假時數（和已核准的單取大的）＋審核中的單＋這張，超過就擋。
   ③ 一年（曆年，依請假日期）3 次：第 4 次直接擋，請改辦理病假。
   ④ 每月 1 次：同一個月已經有一天生理假（不同日期），再送就擋。
   ⑤ 計時人員不適用：薪資主檔是計時（is_full_time 不是 true）就擋；主檔查不到（沒有薪資主檔的店、還沒建檔）＝不知道，不擋。
   已用的日子＝(A) 薪資額度表的 dates（跨月、手動工時月份是「yyyy-MM#k」代號）∪ (B) 本店請假登記的生理假日子
            ∪ (C) 還在跑的單：審核中；已核准而那天還沒核定。已核准、那天核定過卻沒有記生理假（核定成別的假）＝不算。
   不算：退回、本人取消、作廢（作廢會把那天的核定打回，登記也跟著拿掉）。
   緊急開關：指令碼屬性 REQ_MENS_RULES 設 off＝整條退回 2026-11-10 的做法（reqCapLocked_ 一張算一次、生理假不開放兩段、核定不擋 8 小時）。 */
var REQ_MENS_TYPE_ = '生理假';
var REQ_MENS_YEAR_N_ = 3;
var REQ_MENS_DAY_H_ = 8;
function reqMensOn_() {
  try { return String(reqProp_('REQ_MENS_RULES') || '').trim().toLowerCase() !== 'off'; } catch (e) { return true; }
}
function reqMensApplies_(r) { return !!r && String(r.kind) === 'leave' && String(r.leave_type) === REQ_MENS_TYPE_ && reqMensOn_(); }
function reqMd_(d) { return parseInt(String(d).slice(5, 7), 10) + '/' + parseInt(String(d).slice(8, 10), 10); }
/** 本店請假登記裡這個人某假別（預設生理假）的日子 → { 'yyyy-MM-dd': 時數（空白＝0） }；讀不到回 {}。 */
function reqMensLeaveDays_(ss, name, type) {
  var out = {}, want = type || REQ_MENS_TYPE_;
  try {
    var sh = ss.getSheetByName('leave');
    if (!sh) return out;
    var nm = String(name || '').trim();
    readSheetAsObjects(sh).rows.forEach(function (l) {
      if (String(l['姓名'] || '').trim() !== nm || String(l['假別'] || '').trim() !== want) return;
      var d = typeof normCellDate === 'function' ? normCellDate(l['日期']) : String(l['日期']).slice(0, 10);
      out[d] = (out[d] || 0) + (Number(l['時數']) || 0);
    });
  } catch (e) { return {}; }
  return out;
}
/** 生理假新規則＋病假年度用完（送單、兩段、代開共用）。src()：晚一點才查額度（只有生理假、病假才查）。有錯回 {ok:false, error, message}，沒事回 null */
function reqLeaveRulesCheck_(r, existing, me, ss, src) {
  var mens = reqMensApplies_(r), sick = reqSickApplies_(r);
  if (!mens && !sick) return null;
  var q = src();
  var amap = null;
  try { amap = reqApprovedMap_(ss); } catch (e) { amap = null; }   // 讀不到核定＝當成那天還沒核定（已核准的單照算已用，跟原本一樣保守）
  var opt = { today: todayTaipeiStr(), recorded: reqMensLeaveDays_(ss, me.name, String(r.leave_type)), approvedMap: amap };
  var v = mens ? reqMensBlock_(r, existing, String(me.emp_id), q, opt) : reqSickUsedUpBlock_(r, existing, String(me.emp_id), q, opt);
  return v ? { ok: false, error: v.error, message: v.message } : null;
}
/** 同仁送單（含兩段） */
function reqMensSubmitCheck_(r, existing, who, body) {
  return reqLeaveRulesCheck_(r, existing, who.me, who.ss, function () { return reqQuotaFetch_(who, body); });
}
/** 主管代開用：用工號查額度與是不是正職。光復（同專案）直接讀薪資；別店用主管金鑰打 payroll_leave_options。查不到＝{quota:null, ft:null}。
 *  正職／計時：主檔 is_full_time 空白、雙店主檔說法不一＝null（不擋）。 */
function reqQuotaForEmp_(me, mgrKey) {
  try {
    if (typeof payMyLeaveQuota === 'function' && typeof payRead === 'function') {
      return { quota: payMyLeaveQuota(String(me.emp_id), String(me.name), todayTaipeiStr().slice(0, 7), CONFIG.PAYROLL_STORE || ''),
               ft: typeof payFtOfMe_ === 'function' ? payFtOfMe_(me, CONFIG.PAYROLL_STORE || '') : null };
    }
    var j = reqPayPost_({ action: 'payroll_leave_options', store: CONFIG.PAYROLL_STORE || '', mgr_key: String(mgrKey || '') });
    var q = j && j.ok && j.quotas ? j.quotas[String(me.emp_id)] : null;
    if (!q) return { quota: null, ft: null };
    var list = [], m = q.menstrual, sk = q.sick;
    if (m) list.push({ name: REQ_MENS_TYPE_, cap_days: m.cap_days, cap_h: m.cap_h, remain_h: m.remain_h, used_h: m.used_h, used_n: m.used_n, dates: m.dates });
    if (sk) list.push({ name: REQ_SICK_TYPE_, cap_days: sk.cap_days, cap_h: sk.cap_h, remain_h: sk.remain_h, used_h: sk.used_h });
    return { quota: list, ft: m && (m.ft === true || m.ft === false) ? m.ft : null };
  } catch (e) { return { quota: null, ft: null }; }
}
/* ── 病假年度用完改請事假（2026-11-18 Eason 選 A）──
   病假今年的額度（30 天）剩 0 才擋（同仁送單、主管代開），請改請事假；剩的不夠這張單時不擋，照現行（超過的部分薪資無薪）。不改病假給薪計算。
   已用＝薪資額度表（同仁看到的那份，同月以手動為準）＋還沒算進去的單（跟生理假同一個口徑）：審核中的；已核准而那天還沒核定的。
   已核准、那天核定過卻沒記病假（核定成別的假）＝不算；那天本店已記病假＝額度表已經算了，不重複扣。
   查不到額度（沒有薪資主檔的店、還沒建檔、光復暫時問不到）＝判斷不出來＝不擋。請的是別的年度＝不擋。
   開關：指令碼屬性 REQ_SICK_USED_UP 設 off＝不擋（預設開）。 */
var REQ_SICK_TYPE_ = '病假';
function reqSickOn_() {
  try { return String(reqProp_('REQ_SICK_USED_UP') || '').trim().toLowerCase() !== 'off'; } catch (e) { return true; }
}
function reqSickApplies_(r) { return !!r && String(r.kind) === 'leave' && String(r.leave_type) === REQ_SICK_TYPE_ && reqSickOn_(); }
/** 申請頁事前提示用：今年（今天的年份）已核准、還沒算進薪資額度表的病假時數與生理假日子（審核中的申請頁自己從 requests 算）。
 *  口徑同 reqSickUsedUpBlock_／reqMensBlock_：那天本店已記那個假別＝額度表算過了；那天核定過卻沒記（核定成別的假）＝不算。
 *  沒有已核准的病假／生理假單就不讀請假登記與核定表。回 {sick_ok_h, mens_ok_dates:[]}。 */
function reqLeaveLiveOk_(all, who, today) {
  var out = { sick_ok_h: 0, mens_ok_dates: [] }, yr = String(today).slice(0, 4), empId = String(who.me.emp_id);
  var oks = (all || []).filter(function (x) {
    return String(x.emp_id) === empId && String(x.kind) === 'leave' && String(x.status) === 'approved' && String(x.date || '').slice(0, 4) === yr &&
      (String(x.leave_type) === REQ_SICK_TYPE_ || String(x.leave_type) === REQ_MENS_TYPE_);
  });
  if (!oks.length) return out;
  var rec = {}, amap = null;
  rec[REQ_SICK_TYPE_] = reqMensLeaveDays_(who.ss, who.me.name, REQ_SICK_TYPE_);
  rec[REQ_MENS_TYPE_] = reqMensLeaveDays_(who.ss, who.me.name, REQ_MENS_TYPE_);
  try { amap = reqApprovedMap_(who.ss); } catch (e) { amap = null; }
  oks.forEach(function (x) {
    var t = String(x.leave_type), d = String(x.date).slice(0, 10);
    if (d in rec[t]) return;                                       // 已記進請假登記＝額度表算過了
    if (amap && amap[d] && amap[d][empId]) return;                 // 那天核定成別的假
    if (t === REQ_SICK_TYPE_) out.sick_ok_h += Number(x.hours) || 0;
    else if (out.mens_ok_dates.indexOf(d) < 0) out.mens_ok_dates.push(d);
  });
  out.sick_ok_h = Math.round(out.sick_ok_h * 100) / 100;
  out.mens_ok_dates.sort();
  return out;
}
function reqSickUsedUpBlock_(r, existing, empId, src, opt) {
  if (!reqSickApplies_(r)) return null;
  src = src || {}; opt = opt || {};
  var d = String(r.date || '').slice(0, 10), yr = d.slice(0, 4);
  if (yr !== String(opt.today || d).slice(0, 4)) return null;
  var q = (src.quota || []).filter(function (x) { return String(x.name) === REQ_SICK_TYPE_; })[0];
  if (!q || q.remain_h == null || q.remain_h === '' || !isFinite(Number(q.remain_h))) return null;
  var recorded = opt.recorded || {}, amap = opt.approvedMap || null, liveH = 0;
  (existing || []).forEach(function (x) {
    if (String(x.emp_id) !== String(empId) || String(x.kind) !== 'leave' || String(x.leave_type) !== REQ_SICK_TYPE_) return;
    var xd = String(x.date || '').slice(0, 10), st = String(x.status);
    if (xd.slice(0, 4) !== yr) return;
    if (st === 'pending') { liveH += Number(x.hours) || 0; return; }
    if (st !== 'approved' || (xd in recorded)) return;
    if (amap && amap[xd] && amap[xd][String(empId)]) return;   // 那天核定成別的假
    liveH += Number(x.hours) || 0;
  });
  if (Number(q.remain_h) - liveH > 0.001) return null;
  var capD = q.cap_days != null && q.cap_days !== '' ? Number(q.cap_days) : 30;
  return { error: 'sick_used_up', message: '今年病假額度已用完（' + capD + ' 天' + (liveH > 0.001 ? '，含審核中或已核准還沒核定的病假單' : '') + '），請改請事假' };
}
/** 判斷一張生理假（r：date、hours）。src：{quota, ft}；opt：{today, recorded:{日期:時數}, approvedMap}。
 *  回 null（可以送）或 {error, message}。純函式（不讀表），送單、兩段、代開共用。 */
function reqMensBlock_(r, existing, empId, src, opt) {
  if (!reqMensApplies_(r)) return null;
  src = src || {}; opt = opt || {};
  var d = String(r.date || '').slice(0, 10), yr = d.slice(0, 4), ym = d.slice(0, 7);
  var thisYr = String(opt.today || d).slice(0, 4), yrText = yr === thisYr ? '今年' : ' ' + yr + ' 年';
  if (src.ft === false) return { error: 'menstrual_pt', message: '計時人員不適用生理假，請改請病假或事假' };
  var recorded = opt.recorded || {}, amap = opt.approvedMap || null;
  var days = {};   // 日期（或 yyyy-MM#k）→ 說明（'' 已登記／'審核中'／'已核准'）
  var add = function (k, tag) { if (!(k in days) || days[k] === '審核中') days[k] = tag; };
  // (A) 薪資額度表
  var q = (src.quota || []).filter(function (x) { return String(x.name) === REQ_MENS_TYPE_; })[0];
  if (q && Array.isArray(q.dates)) q.dates.forEach(function (k) { add(String(k), ''); });
  // (B) 本店請假登記
  Object.keys(recorded).forEach(function (k) { add(k, ''); });
  // (C) 還在跑的單
  var dayLiveH = 0, dayOkH = 0;
  (existing || []).forEach(function (x) {
    if (String(x.emp_id) !== String(empId) || String(x.kind) !== 'leave' || String(x.leave_type) !== REQ_MENS_TYPE_) return;
    var xd = String(x.date || '').slice(0, 10), st = String(x.status);
    if (st === 'pending') { add(xd, '審核中'); if (xd === d) dayLiveH += Number(x.hours) || 0; return; }
    if (st !== 'approved') return;
    var cored = !!(amap && amap[xd] && amap[xd][String(empId)]);
    if (cored && !(xd in recorded)) return;   // 那天核定成別的假：不佔次數
    add(xd, (xd in recorded) ? '' : '已核准');
    if (xd === d) dayOkH += Number(x.hours) || 0;
  });
  // 舊薪資（還沒有 dates）：額度表只有剩餘時數，已用次數裡扣掉本店已登記的，剩下的當成「日期不明」
  if (q && !Array.isArray(q.dates) && yr === thisYr && q.cap_h != null && q.remain_h != null) {
    var n0 = Math.round((Number(q.cap_h) - Number(q.remain_h)) / REQ_MENS_DAY_H_);
    var nRec = Object.keys(recorded).filter(function (k) { return k.slice(0, 4) === thisYr; }).length;
    for (var i = 1; i <= n0 - nRec; i++) add('?#' + i, '');
  }
  var label = function (k) {
    if (k.charAt(0) === '?') return '';
    var t = k.indexOf('#') > 0 ? parseInt(k.slice(5, 7), 10) + ' 月' : reqMd_(k);
    return t + (days[k] ? ' ' + days[k] : '');
  };
  if (!(d in days)) {
    var inYr = Object.keys(days).filter(function (k) { return k.slice(0, 4) === yr || (k.charAt(0) === '?' && yr === thisYr); }).sort();
    if (inYr.length >= REQ_MENS_YEAR_N_) {
      var shown = inYr.map(label).filter(function (t) { return t; });
      return { error: 'quota_exhausted', message: '生理假' + yrText + '已請 ' + inYr.length + ' 次' + (shown.length ? '（' + shown.join('、') + '）' : '') + '，這次是第 ' + (inYr.length + 1) + ' 次，已超過年度三次上限，請改辦理病假' };
    }
    var inMon = Object.keys(days).filter(function (k) { return k.slice(0, 7) === ym; }).sort();
    if (inMon.length) return { error: 'menstrual_month', message: '生理假每月一次，這個月已請過（' + inMon.map(label).join('、') + '）' };
  }
  var hrs = Number(r.hours) || 0;
  var before = Math.max(recorded[d] || 0, dayOkH) + dayLiveH;
  if (before + hrs > REQ_MENS_DAY_H_ + 0.001) {
    var room = Math.max(0, Math.round((REQ_MENS_DAY_H_ - before) * 100) / 100);
    return { error: 'menstrual_over_8', message: before > 0.001
      ? '生理假一天最多 ' + REQ_MENS_DAY_H_ + ' 小時，' + reqMd_(d) + ' 已請 ' + (Math.round(before * 100) / 100) + ' 小時，' + (room > 0 ? '這次最多 ' + room + ' 小時' : '不能再請')
      : '生理假一天最多 ' + REQ_MENS_DAY_H_ + ' 小時，這次 ' + hrs + ' 小時超過了' };
  }
  return null;
}

/** 能不能請補休（正職才行）：和薪資同專案（光復）才查得到 → true／false；查不到／出錯回 null＝不擋（交給申請頁與主管）。 */
function reqCompAllowed_(me) {
  try {
    if (typeof payIsFt !== 'function' || typeof payRead !== 'function') return null;
    var m = payRead('master').filter(function (x) { return String(x.emp_id) === String(me.emp_id); })[0];
    return m ? payIsFt(m) : null;
  } catch (e) { return null; }
}

/* 到職未滿六個月不能請特休（1113 紅燈 d3，Eason 2026-11-13 選 B）：同仁送單、主管代開、主管核准都擋。
   「滿六個月那天」＝薪資的 payAnnualFirstPs_（到職日讀薪資主檔）；查不到到職日就不擋（照舊）。
   和薪資同專案（光復）直接讀主檔；別家店：同仁送單打光復 line_hub_req_quota（LINE 身分），主管端打 payroll_annual_from（主管金鑰）。 */
var REQ_ANNUAL_TYPE_ = '特休假';
function reqIsAnnual_(r) { return !!r && String(r.kind) === 'leave' && String(r.leave_type || '') === REQ_ANNUAL_TYPE_; }
function reqAnnualMsg_(from) { return '到職滿六個月（' + from + '）起才能請特休，這之前請改請事假或補休'; }
/** 這張單日期早於可以請特休的日子 → 錯誤訊息；否則 ''。 */
function reqAnnualBlockMsg_(r, from) {
  return (reqIsAnnual_(r) && reqIsDate_(String(from || '')) && String(r.date).slice(0, 10) < from) ? reqAnnualMsg_(from) : '';
}
function reqPayPost_(payload) {
  var resp = UrlFetchApp.fetch(CONFIG.PAYROLL_API || REQ_HUB_API_DEFAULT_, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true, payload: JSON.stringify(payload) });
  return JSON.parse(resp.getContentText());
}
/** 同仁送單：用 LINE 身分查（同額度表那一支）。查不到回 ''。 */
function reqAnnualFromLine_(who, body) {
  try {
    if (typeof lineHubReqQuota_ === 'function') return String((lineHubReqQuota_(who.userId) || {}).annual_from || '');
    var j = reqPayPost_({ action: 'line_hub_req_quota', id_token: body.id_token });
    return j && j.ok ? String(j.annual_from || '') : '';
  } catch (e) { return ''; }
}
/** 主管代開、核准：用工號查（和薪資同專案直接讀主檔；別家店用主管金鑰打 payroll_annual_from）。查不到回 ''。 */
function reqAnnualFromEmp_(empId, mgrKey) {
  try {
    if (typeof payAnnualFromOf_ === 'function' && typeof payRead === 'function') return String(payAnnualFromOf_(CONFIG.PAYROLL_STORE || '', empId) || '');
    var j = reqPayPost_({ action: 'payroll_annual_from', store: CONFIG.PAYROLL_STORE || '', mgr_key: String(mgrKey || ''), emp_id: String(empId) });
    return j && j.ok ? String(j.annual_from || '') : '';
  } catch (e) { return ''; }
}

/** {action:'req_cancel', id_token, id} → 只能取消自己的、還在審核中的。wbWho 同 handleReqSubmit_（只有簽名包裝會傳）。 */
function handleReqCancel_(body, wbWho) {
  if (!wbWho && body && typeof body === 'object' && typeof dutyLineWbRun_ === 'function' && dutyWbHas_(body)) return dutyLineWbRun_(body, 'req_cancel', handleReqCancel_);
  var who = reqWhoOf_(body, wbWho);
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
// 總開關，預設關（沒設、空白、0、其他字＝關）。'1' 或 'true'（不分大小寫、前後空白不計）＝開
// （2026-11-15 考勤挑錯 B6：原本只有恰好 '1' 才開，寫成 true 以為開了、其實值班主管還是核得了自己的單）
function reqUpperOn_() {
  var v = String(PropertiesService.getScriptProperties().getProperty('REQ_UPPER_ON') || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}
/** 這把值班主管鑰匙對不到名冊上的人（總開關開著、主管列沒填 emp_id、姓名在在職名冊找不到）：
 *  認不出哪一張是他本人的申請，所以加班、請假、出差一律不給這把鑰匙核准／退回／作廢（忘打卡單不在這條）。
 *  營運系統專用列（allow_acting）不是人，不看。（2026-11-15 考勤挑錯 B6：原本姓名對不上就等於沒有保護） */
var REQ_KEY_BLIND_MSG_ = '這把主管鑰匙對不到名冊上的人，無法確認是不是本人的申請；加班、請假、出差請在管理系統（人資部門 → 考勤管理 → 申請審核）審核，或請系統管理者在 managers 分頁替這一列補上 emp_id';
function reqKeyBlind_(mgr, ss) {
  if (!mgr || reqTrue_(mgr.allow_acting) || !reqUpperOn_()) return false;
  if (String(mgr.emp_id == null ? '' : mgr.emp_id).trim()) return false;
  var nk = reqNameKey_(mgr.name), rsh = ss.getSheetByName('roster');
  var rows = rsh ? readSheetAsObjects(rsh).rows : [];
  return !rows.some(function (r) { return reqTrue_(r.active) && String(r.emp_id) !== '' && nk && reqNameKey_(r.name) === nk; });
}
/* 部門同仁在門市打卡的申請由部門主管審（2026-10-29 Eason 選 1）：部門同仁在門市上班＝支援，
   工時照舊由門市值班主管核；請假、加班、忘打卡、出差申請一律由部門主管在管理系統審，值班核定頁不能核准／退回／作廢。
   名單＝Script Property REQ_DEPT_EMPS（JSON 陣列的本店 emp_id），由 svc_set_upper 的 dept_emp_ids 寫入。
   不看 REQ_UPPER_ON：名單非空就生效；緊急關＝刪掉 REQ_DEPT_EMPS。 */
var REQ_DEPT_MSG_ = '這是支援同仁的申請（在本店上班算支援），請由他原單位的主管在管理系統（人資部門 → 考勤管理 → 申請審核）審核';
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
/** mgr_approve：不算支援的人擋掉（管理系統代核照常）
 *  2026-11-21 P3-3：外面包 dutyAuthRun_（DutyFeed.gs：DUTY_AUTH＝mini 只收簽名寫回、同一個寫回單號只寫一次）；開關全空＝跟以前一樣。 */
function reqMgrApproveHome_(body) {
  return typeof dutyAuthRun_ === 'function' ? dutyAuthRun_(body, 'mgr_approve', reqMgrApproveHomeRaw_) : reqMgrApproveHomeRaw_(body);
}
/** cfg（dutyAuthCfg_）.strict（DUTY_VER_STRICT 或 DUTY_AUTH=mini）：讀不到版本就擋（舊缺口 1）＋寫入前在 #195 那把鎖內再比一次版本
 *  （舊缺口 2，Code.gs handleMgrApprove 讀 REQ_APPROVE_VER_LOCK_）。沒給或沒開＝以前的流程。只檢查（dry_run）不受影響。 */
function reqMgrApproveHomeRaw_(body, cfg) {
  var strict = !!(cfg && cfg.strict) && !(body && body.dry_run === true);
  var prev = REQ_APPROVE_VER_LOCK_;
  REQ_APPROVE_VER_LOCK_ = strict;
  try { return reqMgrApproveHomeIn_(body, cfg); }
  finally { REQ_APPROVE_VER_LOCK_ = prev; }
}
var REQ_APPROVE_VER_LOCK_ = false;   // 每次請求是獨立執行，預設 false
function reqMgrApproveHomeIn_(body, cfg) {
  // 依副本核定（2026-11-14，DutyFeed.gs）：帶 base_ver 的先比版本，主管看到的不是最新的就退回
  var stale = typeof dutyVerGuard_ === 'function' ? dutyVerGuard_(body, !!(cfg && cfg.strict)) : null;
  if (stale) return stale;
  var hide = reqHomeHide_(body);
  if (hide && reqInList_(hide, String(body.emp_id == null ? '' : body.emp_id))) return { ok: false, error: 'home_review', message: hide[REQ_ALL_] ? REQ_LIST_BAD_MSG_ : REQ_HOME_MSG_ };
  return handleMgrApprove(body);
}
/** {action:'mgr_approve_check', mgr_key, acting_name, date, items:[{emp_id, periods, leaves, late_min, diff_reason, dup_ignore, sched_*}]}
 *  → {ok, date, results:[{emp_id, ok, error, message, approved_hours, status_text}]}（2026-11-14 考勤管理好上手第 1 項）
 *  一次替一天的多位同仁用「送出核定」同一套檢查試算（mgr_approve dry_run），只讀不寫、不記變動。最多 40 人。 */
var REQ_CHECK_MAX_ = 40;
function reqMgrApproveCheck_(body) {
  var items = Array.isArray(body && body.items) ? body.items : null;
  if (!items) return { ok: false, error: 'bad_items' };
  if (items.length > REQ_CHECK_MAX_) return { ok: false, error: 'too_many', message: '一次最多試算 ' + REQ_CHECK_MAX_ + ' 人' };
  var base = {};
  ['mgr_key', 'acting_name', 'date'].forEach(function (k) { if (body[k] !== undefined) base[k] = body[k]; });
  READ_MEMO_ = {};      // 這一批共用讀過的表（Code.gs readSheetAsObjects）；結束一定關掉
  REQ_PEER_GIVEN_ = reqPeerGivenParse_(body.peer_given, String(body.date || ''));   // Mac mini 帶來的別家店摘要（2026-11-15）；結束一定關掉
  if (typeof chkT_ === 'function') CHECK_T_ = {}; var tAll = Date.now(), perEmp = [], timing = null;      // 分段計時（2026-11-14）
  try {
  var results = items.map(function (it) {
    var tE = Date.now();
    try {
    if (!it || typeof it !== 'object') return { ok: false, error: 'bad_item' };
    var b = {};
    Object.keys(it).forEach(function (k) { if (k !== 'mgr_key' && k !== 'acting_name' && k !== 'date' && k !== 'base_ver' && k !== 'action') b[k] = it[k]; });
    Object.keys(base).forEach(function (k) { b[k] = base[k]; });
    b.action = 'mgr_approve'; b.dry_run = true;
    var r;
    try { r = reqMgrApproveHome_(b); } catch (e) { r = { ok: false, error: 'server_error', message: String(e && e.message || e) }; }
    if (r && r.error === 'unauthorized') return { emp_id: String(it.emp_id == null ? '' : it.emp_id), ok: false, error: 'unauthorized' };
    var out = { emp_id: String(it.emp_id == null ? '' : it.emp_id), ok: !!(r && r.ok) };
    ['error', 'message', 'approved_hours', 'status_text', 'need', 'diff_min', 'probs', 'need_doc', 'hint'].forEach(function (k) { if (r && r[k] !== undefined) out[k] = r[k]; });      // probs／need_doc／hint：營運系統逐條顯示要補的單（2026-11-14）
    return out;
    } finally { perEmp.push(Date.now() - tE); }
  });
  } finally {
    READ_MEMO_ = null; REQ_PEER_GIVEN_ = null;
    var parts = {}; Object.keys((typeof CHECK_T_ !== 'undefined' && CHECK_T_) || {}).forEach(function (k) { parts[k] = CHECK_T_[k]; });
    timing = { total_ms: Date.now() - tAll, n: items.length, per_emp_ms: perEmp, parts: parts };
    if (typeof CHECK_T_ !== 'undefined') CHECK_T_ = null;
  }
  if (results.length && results.every(function (x) { return x.error === 'unauthorized'; })) return { ok: false, error: 'unauthorized' };
  return { ok: true, date: String(body.date || ''), results: results, timing: timing };
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
  // 補單核准後打回（2026-11-26 第 5 題 A）：開關開著時，現在核准會打回那天的單標 day_approved:true（跟核准時同一個判斷）；
  //   開關關著不讀、不加（回應跟以前一樣）；讀不到就不標，不影響清單
  var reopenOn = reqReopenOn_(), reopenMemo = { reqs: all }, todayR = todayTaipeiStr();
  var items = rows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).map(function (r) {
    var o = reqPublic_(r);
    o.summary = reqSummary_(r);
    var why = r.proxy_by ? 'director' : reqUpperWhy_(r.emp_id, ss, upc);
    o.upper = !!why;   // 值班主管本人／部門同仁的申請：送上層審，這把鑰匙不能處理；主管代開＝總監層級審
    if (why) o.upper_kind = why;
    o.attach_id = String(r.attach_id || '');   // 主管看附件用（經光復 line_hub_attach_get，會再核對主管金鑰）
    if (reqDayDiff_(r.date, todayTaipeiStr()) <= 0) o.punches = reqDayPunches_(events, r.emp_id, r.date);   // 還沒到的日期沒有打卡可看，不顯示「沒有任何打卡」
    if (reopenOn && reqAffectsDay_(r) && String(r.date || '').slice(0, 10) <= todayR) {
      try { if (reqReopenJudge_(ss, r, reopenMemo).act === 'reopen') o.day_approved = true; } catch (e) {}
    }
    return o;
  });
  return { ok: true, items: items };
}

/* 核准請假／出差單時那天已經核定過（1113 紅燈 a2，Eason 2026-11-13 選 A）：請假登記（leave 分頁）只在主管送出核定時寫，
   假單晚於核定才核准，薪資就看不到這個假。照常核准，回應多帶提醒，請主管把那天重新核定一次。
   加班、忘打卡不寫請假登記，不提醒。approvedMap 用 buildLatestApprovedMap（同一天同一人最新一筆）。 */
var REQ_DAY_WARN_ = 'already_approved_day';
function reqAffectsLeave_(r) { return String(r.kind) === 'leave' || String(r.kind) === 'trip'; }
function reqApprovedMap_(ss) {
  var ash = ss.getSheetByName('approved');
  return buildLatestApprovedMap(ash ? readSheetAsObjects(ash).rows : []);
}
function reqDayApproved_(approvedMap, r) {
  var d = String(r.date || '').slice(0, 10);
  return !!(reqAffectsDay_(r) && approvedMap[d] && approvedMap[d][String(r.emp_id)]);
}
/** 核准後那天的核定要重看的申請（2026-11-15 考勤挑錯 B5）：請假、出差（假別要寫進薪資），加上加班單——
 *  那天已經核定後才核准的加班單沒算進核定時數；先核准再核定會被綁單檢查擋，順序反過來原本沒有任何提醒。 */
function reqAffectsDay_(r) { return reqAffectsLeave_(r) || String(r.kind) === 'ot'; }
function reqDayWarnMsgOf_(r, dates) {
  if (String(r.kind) !== 'ot') return reqDayWarnMsg_(dates);
  return dates.map(function (d) { return (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)); }).join('、') + ' 已經核定過，請重新核定一次，這張加班單才會算進核定時數';
}
function reqDayWarnMsg_(dates) {
  return dates.map(function (d) { return (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)); }).join('、') + ' 已經核定過，請重新核定一次，假別才會寫進薪資';
}

/* ── 核定之後才核准的補單：自動把那天打回待核定（2026-11-26 主管「照推薦」1A 2A 3A 4A 5A 6A 7A 8A 9A；
   設計 ~/加盟名單平台/_brain_out/reapprove-after-slip/design.md）──
   主管核准請假、出差、加班單（1A）時，開單這家店的那一天已經有主管核定（不算總部鏡像列），而且那天的核定還沒包含這張單（2A），
   就照「作廢打回」同一套（reqRevokeFinal_）把那位同仁那一天的核定與假別登記搬到留底分頁，那天回到待核定，單子照常核准。
   打回失敗＝單子也不核准（請再按一次），不會出現「單核准了、那天卻沒打回」的半套。
   開關：指令碼屬性 REQ_REOPEN_ON，去頭尾空白後剛好是 '1' 才打回；沒設、空白、0、true、打錯字＝照今天只提醒（回應與寫入逐位元組相同）。
   mini 核定引擎看得到這個屬性（RelayG.gs RELAYG_PROPS_），兩邊判斷一樣。 */
var REQ_REOPEN_PROP_ = 'REQ_REOPEN_ON';
var REQ_REOPEN_FAIL_MSG_ = '這天的核定沒有打回成功，這張還沒核准，請再按一次';      // 真的去打回、搬資料時出錯（逐句表第 7 句）
var REQ_REOPEN_READ_MSG_ = '這天的核定讀不到，這張還沒核准，請再按一次';      // 判斷時就讀不到核定資料、還沒開始打回（主管 2026-11-26 定案新句）；錯誤碼同 revoke_failed
function reqReopenOn_() {
  var v = null;
  try { v = reqProp_(REQ_REOPEN_PROP_); } catch (e) { v = null; }
  return String(v == null ? '' : v).trim() === '1';
}
/** 鎖月狀態確定「沒鎖」才打回（2026-11-26 補單打回驗收第 2 項，大腦裁定保守解讀第 7 題）：讀不到鎖月＝照常核准、不打回、照今天的提醒。
 *  本店讀得到（光復有薪資模組）＝看本店：沒鎖才打回；其他店打卡端讀不到鎖月 → 看營運系統代轉時帶的 pay_unlocked（它先向光復問過、確定沒鎖的月份 ['YYYY-MM'…]）。
 *  已鎖的月份核准本身就被 reqPayLock_ 擋下，走不到這裡。直接打 Google 的舊值班核定頁不帶 pay_unlocked＝光復以外的店不打回。 */
function reqReopenLockOk_(r, body, ss) {
  var d = String(r.date || '').slice(0, 10), lk;
  try { lk = typeof payLockedFor_ === 'function' ? payLockedFor_(d, ss) : undefined; } catch (e) { lk = undefined; }
  if (lk === false) return true;
  if (lk === true) return false;
  var ok = body && Array.isArray(body.pay_unlocked) ? body.pay_unlocked.map(String) : [];
  return ok.indexOf(d.slice(0, 7)) >= 0;
}
function reqMD_(d) { return (+String(d).slice(5, 7)) + '/' + (+String(d).slice(8, 10)); }
function reqReopenMsg_(d) { return reqMD_(d) + ' 原本已核定，已打回待核定，請重新核定這天'; }
function reqDayOkMsg_(d) { return reqMD_(d) + ' 的核定已經包含這張單，不用重新核定'; }
/** 判斷用的表（approved、leave）：批次共用一份 memo（批次開頭在鎖內讀；打回過的人日另外記，不再判） */
function reqReopenRows_(ss, memo, nm) {
  if (memo && memo[nm]) return memo[nm];
  var sh = ss.getSheetByName(nm), rows = sh ? readSheetAsObjects(sh).rows : [];
  if (memo) memo[nm] = rows;
  return rows;
}
/** 這人這天在這家店自己的核定（mirror_src 空白），依 entered_at 取最新一筆；沒有回 null。同 buildLatestApprovedMap 的 >=（同一秒取後寫的） */
function reqDayOwnLatest_(rows, emp, date) {
  var best = null;
  rows.forEach(function (x) {
    if (normCellDate(x.date) !== date || String(x.emp_id) !== emp || String(x.mirror_src || '').trim()) return;
    if (!best || normCellTs(x.entered_at) >= normCellTs(best.entered_at)) best = x;
  });
  return best;
}
/** 核定已經包含這張單嗎（2A）——跟核定時的檢查同一個口徑（2026-11-26 獨立審查第 1 項）：把這張單當成已核准，
 *  請假／出差＝這人這天這個假別「所有已核准單的時數合計」等於核定裡登記的合計（直接用 reqStrictLeaveProbs_，差 > 0.005 小時算不同）；
 *  加班＝這天所有已核准加班單（含這張）每張都落在核定時段內、前後可差 15 分（reqStrictSlotOk_），而且加班單時數合計跟核定應有的加班時數相符
 *  （reqStrictOtNeed_，打卡端不知道班表＝當一般日；不足、多超過 15 分、核定沒超過 8 小時卻有加班單，都算不包含）。
 *  以前只找「同假別同時數的任一列」，第二張同樣時數的單會重複用到第一張的登記（審查重現：出差 09–11 已核定登記 2 小時，再補 14–16 會被當成已包含）。
 *  核定沒有時段（整天請假、出差）或時段讀不懂＝加班單不包含；拿不準一律不包含（照樣打回）。登記只看本店的（總部鏡像列 mirror_src 不算）。
 *  memo（選填）：reqs＝申請列（批次、待審清單共用一份）、okIds＝這一批已核准的單號。 */
function reqDayOkSlips_(ss, r, memo) {
  var date = String(r.date || '').slice(0, 10), emp = String(r.emp_id), id = String(r.id);
  var reqs = memo && memo.reqs ? memo.reqs : reqRows_(ss), okIds = (memo && memo.okIds) || {};
  return reqs.filter(function (x) {
    return String(x.emp_id) === emp && String(x.date).slice(0, 10) === date && String(x.id) !== id && (x.status === 'approved' || okIds[String(x.id)]);
  }).concat([r]);
}
function reqDayCovers_(ss, r, latest, memo) {
  var date = String(r.date || '').slice(0, 10), kind = String(r.kind);
  var slips = reqDayOkSlips_(ss, r, memo);
  if (kind === 'ot') {
    var ps = [], bad = false;
    parsePeriodsStr(String(latest.periods == null ? '' : latest.periods)).forEach(function (p) {
      var a = reqMin_(String(p.start || '').trim()), b = reqMin_(String(p.end || '').trim());
      if (a === null || b === null) { bad = true; return; }
      var s = reqHmMs_(date, String(p.start).trim()), e = reqHmMs_(date, String(p.end).trim());
      if (e <= s) e += 86400000;
      ps.push({ startMs: s, endMs: e });
    });
    if (bad || !ps.length) return false;
    var merged = reqStrictMerged_(ps), ots = slips.filter(function (x) { return x.kind === 'ot'; });
    if (!ots.every(function (x) { return reqStrictSlotOk_(date, String(x.start), String(x.end), merged); })) return false;
    var have = ots.reduce(function (t, x) { return t + (Number(x.hours) || 0); }, 0);
    var need = reqStrictOtNeed_(latest.approved_hours, '').need;      // 同 reqBindCheck_ 規則 2（一般日）
    return need > 0.005 && have + 0.005 >= need && have <= need + REQ_STRICT_TOL_MIN / 60 + 0.005;
  }
  var name = reqFinalName_(ss, r);
  if (!name || !reqLeaveOwner_(ss, String(r.emp_id), name)) return false;
  var typeOf = function (x) { return x.kind === 'trip' ? '出差' : String(x.leave_type); };      // 同 reqStrictLeaveProbs_ 的假別寫法
  var type = typeOf(r);
  if (!String(type).trim()) return false;
  var oks = slips.filter(function (x) { return (x.kind === 'leave' || x.kind === 'trip') && typeOf(x) === type; });
  var leaves = reqReopenRows_(ss, memo, 'leave').filter(function (x) {
    return normCellDate(x['日期']) === date && String(x['姓名'] || '').trim() === name && !String(x.mirror_src || '').trim() && String(x['假別']) === type;
  }).map(function (x) { return { type: String(x['假別']), hours: x['時數'] }; });
  if (!leaves.length) return false;
  return reqStrictLeaveProbs_(oks, leaves).length === 0;
}
/** 開關開著、種類是請假／出差／加班時才叫。回 {act}：'reopen'＝要打回；'covered'＝核定已包含；'old_warn'＝只有總部鏡像核定（照今天提醒）；'none'＝那天沒有核定 */
function reqReopenJudge_(ss, r, memo) {
  var date = String(r.date || '').slice(0, 10), emp = String(r.emp_id);
  var rows = reqReopenRows_(ss, memo, 'approved');
  var latest = reqDayOwnLatest_(rows, emp, date);
  if (latest) return { act: reqDayCovers_(ss, r, latest, memo) ? 'covered' : 'reopen' };
  var any = rows.some(function (x) { return normCellDate(x.date) === date && String(x.emp_id) === emp; });
  return { act: any ? 'old_warn' : 'none' };
}
/** 打回（同作廢打回 reqRevokeFinal_，多回原核定摘要 before）。丟例外＝呼叫端回 revoke_failed、單子不核准 */
function reqReopenDay_(ss, r, actor, group) {
  var list = group && group.length ? group : [r];      // 批次整組打回：留底理由列出這一組每一張（2026-11-26 審查第二輪）
  return reqRevokeFinal_(ss, String(r.emp_id), reqFinalName_(ss, r), String(r.date || '').slice(0, 10),
    '核准申請 ' + list.map(function (x) { return String(x.id); }).join('、') + '（' + actor + '）後打回：' + list.map(reqSummary_).join('；'), { detail: true });
}
/** 打回後回應多帶的欄（只有開關開著、真的打回時才有；開關關著回應不變） */
function reqReopenOut_(o, r, dd, revoked) {
  o.warn = REQ_DAY_WARN_; o.warn_dates = [dd]; o.message = reqReopenMsg_(dd);
  o.reopened = true; o.revoked = revoked;
  o.date = dd; o.emp_id = String(r.emp_id); o.kind = String(r.kind); o.summary = reqSummary_(r);
  return o;
}

/** {action:'mgr_req_decide', mgr_key, id, decision:'approve'|'reject', reason?} */
function handleMgrReqDecide_(body, viaAuth) {
  // 2026-11-21 P3-3：先過 dutyAuthRun_（DutyFeed.gs：DUTY_AUTH＝mini 只收簽名寫回、同一個寫回單號只寫一次；開關全空＝直接回來照原本流程）
  if (!viaAuth && typeof dutyAuthRun_ === 'function') return dutyAuthRun_(body, 'mgr_req_decide', handleMgrReqDecide_);
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
    var payLock = reqPayLock_(String(r.date || ''), false, ss);   // 薪資鎖月後不可以再動（2026-11-15）：看申請單的日期，核准、退回都擋
    if (payLock) return payLock;
    var pb = reqProxyBlock_(r, mgr, body, actor);
    if (pb) return pb;
    var why = (r.proxy_by || reqMgrActing_(mgr, body)) ? '' : reqUpperWhy_(r.emp_id, ss);
    if (why) return { ok: false, error: 'upper_review', message: reqUpperMsg_(why) };
    if (!r.proxy_by && !reqIsMiss_(r) && reqKeyBlind_(mgr, ss)) return { ok: false, error: 'upper_review', message: REQ_KEY_BLIND_MSG_ };
    if (decision === 'approve' && reqNeedsProof_(r)) return { ok: false, error: 'need_proof', message: r.leave_type + '要附證明，同仁補上後才能核准（退回不受影響）' };
    if (decision === 'approve' && reqIsAnnual_(r)) {   // 1113 紅燈 d3：核准時再查一次（送單時可能查不到到職日）
      var anMsgD = reqAnnualBlockMsg_(r, reqAnnualFromEmp_(r.emp_id, body.mgr_key));
      if (anMsgD) return { ok: false, error: 'annual_not_eligible', message: anMsgD };
    }
    // 補單核准後打回（2026-11-26，開關 REQ_REOPEN_ON）：先判、要打回就先打回，打回失敗單子也不核准；開關關著整段不跑
    var rj = null;
    if (decision === 'approve' && reqAffectsDay_(r) && reqReopenOn_() && reqReopenLockOk_(r, body, ss)) {
      var judged = false;
      try {
        rj = reqReopenJudge_(ss, r, {});
        judged = true;
        if (rj.act === 'reopen') rj.revoked = reqReopenDay_(ss, r, actor);
      } catch (errR) { console.log('mgr_req_decide 打回核定失敗：' + errR); return { ok: false, error: 'revoke_failed', message: judged ? REQ_REOPEN_FAIL_MSG_ : REQ_REOPEN_READ_MSG_ }; }
    }
    reqSetCells_(sh, r.__rowIndex, { status: decision === 'approve' ? 'approved' : 'rejected', decided_at: nowTaipeiIso(),
                                     decided_by: actor, reject_reason: decision === 'reject' ? reason : '' });
    var out = { ok: true, id: String(r.id), status: decision === 'approve' ? 'approved' : 'rejected' };
    if (rj) {
      var dR = String(r.date || '').slice(0, 10);
      if (rj.act === 'reopen') reqReopenOut_(out, r, dR, rj.revoked);
      else if (rj.act === 'covered') { out.day_ok = true; out.message = reqDayOkMsg_(dR); }
      else if (rj.act === 'old_warn') { out.warn = REQ_DAY_WARN_; out.warn_dates = [dR]; out.message = reqDayWarnMsgOf_(r, [dR]); }
      return out;
    }
    if (decision === 'approve' && reqAffectsDay_(r)) {
      var dd = String(r.date || '').slice(0, 10);
      try { if (reqDayApproved_(reqApprovedMap_(ss), r)) { out.warn = REQ_DAY_WARN_; out.warn_dates = [dd]; out.message = reqDayWarnMsgOf_(r, [dd]); } }
      catch (e) {}   // 讀不到核定紀錄不影響核准
    }
    return out;
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_void', mgr_key, id, reason} → 作廢一筆已核准的申請（2026-10-26 Eason 選）。
 *  起因：同仁改申請（例：整天出差 8h 改成出差 4h＋天災假 4h）時舊單已核准，沒人能撤，核定頁會一直帶出舊單。
 *  只改申請的狀態；那天若已經送過核定，核定紀錄不動——要改時數請主管重新核定那天。 */
function handleMgrReqVoid_(body, viaAuth) {
  // 2026-11-21 P3-3：先過 dutyAuthRun_（DutyFeed.gs：DUTY_AUTH＝mini 只收簽名寫回、同一個寫回單號只寫一次；開關全空＝直接回來照原本流程）
  if (!viaAuth && typeof dutyAuthRun_ === 'function') return dutyAuthRun_(body, 'mgr_req_void', handleMgrReqVoid_);
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
    var payLock = reqPayLock_(String(r.date || ''), false, ss);   // 薪資鎖月後不可以再動（2026-11-15）：原本只有營運系統擋，打卡端也擋
    if (payLock) return payLock;
    var pb = reqProxyBlock_(r, mgr, body, actor);
    if (pb) return pb;
    var why = (r.proxy_by || reqMgrActing_(mgr, body)) ? '' : reqUpperWhy_(r.emp_id, ss);
    if (why) return { ok: false, error: 'upper_review', message: reqUpperMsg_(why) };
    if (!r.proxy_by && !reqIsMiss_(r) && reqKeyBlind_(mgr, ss)) return { ok: false, error: 'upper_review', message: REQ_KEY_BLIND_MSG_ };
    // 那天的核定一起打回待核定（2026-11-14 Eason 1A 2A）：工時核定＋假別紀錄搬到留底分頁，搬完才標作廢；搬的時候出錯＝單子不作廢、請主管再按一次
    var revoked;
    try { revoked = reqRevokeFinal_(ss, String(r.emp_id), reqFinalName_(ss, r), String(r.date), '作廢申請 ' + String(r.id) + '（' + actor + '）：' + reason); }
    catch (err) { console.log('mgr_req_void 打回核定失敗：' + err); return { ok: false, error: 'revoke_failed', message: '這天的核定沒有打回成功，申請也還沒作廢，請再按一次' }; }
    reqHeads_(sh);   // 舊分頁沒有 voided_* 欄，先補表頭
    reqSetCells_(sh, r.__rowIndex, { status: 'voided', voided_at: nowTaipeiIso(), voided_by: actor, void_reason: reason });
    return { ok: true, id: String(r.id), status: 'voided', date: String(r.date), revoked: revoked };
  } finally { lock.releaseLock(); }
}

/* ── 作廢申請時，那天的核定一起打回待核定（2026-11-14 Eason：1A 整天打回、2A 四種單都算、3A 鎖月由營運系統擋、4A 舊資料先只讀列清單）──
   工時核定（approved，總部鏡像列 mirror_src 不動）→ approved_revoked；假別紀錄（leave，薪資讀這份）→ leave_revoked。
   兩邊都留底、可復原；那天回到待核定，主管照實際重新核定。那天沒有核定＝什麼都不搬（跟以前一樣只作廢）。 */
var REQ_LEAVE_REVOKE_SHEET_ = 'leave_revoked';
/** 假別紀錄用姓名對（leave 分頁沒有工號）：以名冊為準，查不到才用申請單上的姓名。 */
function reqFinalName_(ss, r) {
  var rsh = ss.getSheetByName('roster');
  var ros = rsh ? findRosterByEmpId(readSheetAsObjects(rsh).rows, String(r.emp_id)) : null;
  return String((ros && ros.name) || r.name || '').trim();
}
/** 只看：這天這個人在 approved／leave 分頁有幾列（不含總部鏡像列）。 */
function reqFinalCount_(ss, emp, name, date) {
  var a = 0, l = 0, ash = ss.getSheetByName('approved'), lsh = ss.getSheetByName('leave');
  if (ash) readSheetAsObjects(ash).rows.forEach(function (x) { if (normCellDate(x.date) === date && String(x.emp_id) === emp && !String(x.mirror_src || '').trim()) a++; });
  if (lsh && name) readSheetAsObjects(lsh).rows.forEach(function (x) { if (normCellDate(x['日期']) === date && String(x['姓名'] || '').trim() === name) l++; });
  return { approved: a, leave: l };
}
/** 把一張分頁裡符合 match 的列搬到留底分頁（先寫留底、再由下往上刪）。回搬了幾列。 */
function reqMoveRows_(ss, sh, bakName, extraHead, match, extraVals) {
  if (!sh) return 0;
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return 0;
  var head = vals[0], drop = [];
  for (var i = 1; i < vals.length; i++) {
    if (!match(vals[i], head)) continue;
    var keep = vals[i].slice(0, head.length); while (keep.length < head.length) keep.push('');
    drop.push({ row: i + 1, vals: keep });
  }
  if (!drop.length) return 0;
  var bak = ss.getSheetByName(bakName);
  if (!bak) { bak = ss.insertSheet(bakName); bak.appendRow(head.concat(extraHead)); }
  drop.forEach(function (d) { bak.appendRow(d.vals.concat(extraVals)); });
  SpreadsheetApp.flush();
  for (var j = drop.length - 1; j >= 0; j--) sh.deleteRow(drop[j].row);   // 由下往上刪，列號不會跑掉
  SpreadsheetApp.flush();
  return drop.length;
}
/** 打回某人某天的核定。why＝留底理由。回 {approved, leave}＝各搬了幾列。 */
/** 這個姓名的假別紀錄算不算這個編號的：名冊裡同名（去頭尾空白後完全相同）的最後一位就是；名冊裡沒有這個姓名＝照舊當他的 */
function reqLeaveOwner_(ss, emp, name) {
  var rsh = ss.getSheetByName('roster'), owner = null;
  (rsh ? readSheetAsObjects(rsh).rows : []).forEach(function (r) {
    var k = String(r.name == null ? '' : r.name).trim(), id = String(r.emp_id == null ? '' : r.emp_id);
    if (k && id && k === name) owner = id;
  });
  return owner === null || owner === String(emp);
}
/* 打回要嘛整天做完、要嘛什麼都沒變（2026-11-26 補單打回驗收第 1 項）：以前先搬核定、再搬假別登記，第二步出錯會留下
   「核定列已搬走、假別登記還在原處」——再按一次時那天看起來沒核定，單子直接核准，舊假別登記留著（重核又會再寫一筆）。
   現在：先讀好兩張表要搬的列（不寫）→ 寫留底（核定、假別）→ 刪原列（核定、假別，各自由下往上）；任何一步丟例外，
   就把已經做的倒回去（剛刪的原列照原順序補回表尾、剛寫的留底列刪掉）再丟出去，呼叫端回 revoke_failed、單子不核准／不作廢；
   再按一次會從頭完整做一次。正常情況的寫入結果跟以前逐格相同（只是先寫兩邊的留底、再刪兩邊的原列）。
   表頭只在新建留底分頁時寫（同以前）；這次新建的分頁倒回時整張刪掉。 */
function reqMovePlan_(sh, bakName, extraHead, match, extraVals) {
  if (!sh) return null;
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return null;
  var head = vals[0], drop = [];
  for (var i = 1; i < vals.length; i++) {
    if (!match(vals[i], head)) continue;
    var keep = vals[i].slice(0, head.length); while (keep.length < head.length) keep.push('');
    drop.push({ row: i + 1, vals: keep });
  }
  return { sh: sh, bakName: bakName, head: head, extraHead: extraHead, extraVals: extraVals, drop: drop };
}
function reqMoveApply_(ss, plans) {
  var undo = [];
  if (!plans.some(function (p) { return p && p.drop.length; })) return plans.map(function () { return 0; });   // 沒有要搬的＝什麼都不寫（同以前）
  try {
    plans.forEach(function (p) {
      if (!p || !p.drop.length) return;
      // 表頭只在「這次新建分頁」時寫（跟以前一樣；已存在的分頁不論空不空都不補表頭，2026-11-26 獨立審查第 3 項）。
      //   倒回：這次新建的分頁整張刪掉（不留原本不存在的空分頁）；原本就在的分頁只刪這次追加的列
      var bak = ss.getSheetByName(p.bakName), base = 0;
      if (!bak) {
        bak = ss.insertSheet(p.bakName);
        undo.push(function () { if (typeof ss.deleteSheet === 'function') ss.deleteSheet(bak); else for (var r = bak.getLastRow(); r > 0; r--) bak.deleteRow(r); });
        bak.appendRow(p.head.concat(p.extraHead));
      } else {
        base = bak.getLastRow();
        undo.push(function () { for (var r = bak.getLastRow(); r > base; r--) bak.deleteRow(r); });
      }
      p.drop.forEach(function (d) { bak.appendRow(d.vals.concat(p.extraVals)); });
    });
    SpreadsheetApp.flush();
    plans.forEach(function (p) {
      if (!p || !p.drop.length) return;
      var gone = [];
      undo.push(function () { for (var i = gone.length - 1; i >= 0; i--) p.sh.appendRow(gone[i]); });   // 刪的時候由下往上，補回時倒過來＝原本的先後
      for (var j = p.drop.length - 1; j >= 0; j--) { p.sh.deleteRow(p.drop[j].row); gone.push(p.drop[j].vals); }
    });
    SpreadsheetApp.flush();
  } catch (e) {
    for (var u = undo.length - 1; u >= 0; u--) { try { undo[u](); } catch (e2) { console.log('打回倒回失敗：' + e2); } }
    try { SpreadsheetApp.flush(); } catch (e3) {}
    throw e;
  }
  return plans.map(function (p) { return p ? p.drop.length : 0; });
}
function reqRevokeFinal_(ss, emp, name, date, why, opt) {
  var now = nowTaipeiIso();
  var detail = !!(opt && opt.detail);   // 補單打回（2026-11-26）才帶 opt.detail；作廢不帶＝回應跟以前一樣
  // 假別紀錄只有姓名、沒有編號：同名的人照薪資的算法（Payroll.gs nameToEmp）算給名冊最後一位同名的人。
  // 作廢的不是那一位＝這些假別紀錄不是他的，不搬（2026-11-15 考勤挑錯 B14：原本作廢甲的單會把同名乙那天的假別搬走）
  if (name && !reqLeaveOwner_(ss, emp, name)) name = '';
  var pa = reqMovePlan_(ss.getSheetByName('approved'), BIND_REVOKE_SHEET_, ['revoked_at', 'revoke_reason'], function (row, h) {
    var im = h.indexOf('mirror_src');
    return normCellDate(row[h.indexOf('date')]) === date && String(row[h.indexOf('emp_id')]) === emp && !(im >= 0 && String(row[im] || '').trim());
  }, [now, why]);
  var pl = !name ? null : reqMovePlan_(ss.getSheetByName('leave'), REQ_LEAVE_REVOKE_SHEET_, ['emp_id', 'revoked_at', 'revoke_reason'], function (row, h) {
    var im = h.indexOf('mirror_src');      // 總部從央廚抄來的假別登記（Mirror.gs 加 mirror_src）跟鏡像核定一樣不動（2026-11-26 獨立審查第 2 項）
    return normCellDate(row[h.indexOf('日期')]) === date && String(row[h.indexOf('姓名')] || '').trim() === name && !(im >= 0 && String(row[im] || '').trim());
  }, [emp, now, why]);
  var n = reqMoveApply_(ss, [pa, pl]);
  if (!detail) return { approved: n[0], leave: n[1] };
  var objs = function (p) { return !p ? [] : p.drop.map(function (d) { var o = {}; p.head.forEach(function (k, c) { o[k] = d.vals[c]; }); return o; }); };
  var apRows = objs(pa), lvRows = objs(pl);
  // before＝被搬走的最新一筆核定摘要（第 3 題 A 的說明行用）；沒有搬到核定列＝null
  var last = null;
  apRows.forEach(function (x) { if (!last || normCellTs(x.entered_at) >= normCellTs(last.entered_at)) last = x; });
  var num = function (v) { return v === '' || v === null || v === undefined || !isFinite(Number(v)) ? '' : Number(v); };
  var before = last ? { periods: String(last.periods == null ? '' : last.periods), approved_hours: num(last.approved_hours), status_text: String(last.status_text == null ? '' : last.status_text),
    manager_name: String(last.manager_name == null ? '' : last.manager_name), entered_at: String(normCellTs(last.entered_at) || ''),
    leaves: lvRows.map(function (x) { return { type: String(x['假別'] == null ? '' : x['假別']).trim(), hours: num(x['時數']) }; }) } : null;
  return { approved: n[0], leave: n[1], before: before };
}

/* ── 舊資料：申請已作廢或核定被打回，假別紀錄還留著（2026-11-14 Eason 4A：先只讀列清單，確認後才清）──
   {action:'final_orphan_scan', admin_key, from, to, apply?, keys?:['日期|工號',…]}
   列出 from～to 每一個「有假別紀錄或工時核定」的人日，標兩種問題：
     voided＝那天有作廢的申請，而且作廢時間晚於現有核定（核定是用作廢前的單算的）；
     orphan_leave＝有假別紀錄、但沒有工時核定（例：11/13 bind_revoke 只搬了工時核定）。
   apply:true 只處理 keys 指定的人日（整天打回，同作廢）。 */
function finalOrphanScan_(ss, from, to) {
  var reqs = reqRows_(ss);
  var rsh = ss.getSheetByName('roster'), roster = rsh ? readSheetAsObjects(rsh).rows : [];
  var empByName = {};
  roster.forEach(function (x) { var nm = String(x.name || '').trim(); if (nm && !(nm in empByName)) empByName[nm] = String(x.emp_id); });
  var ash = ss.getSheetByName('approved'), lsh = ss.getSheetByName('leave');
  var days = {};
  var day = function (date, emp, name) { var k = date + '|' + emp; return days[k] = days[k] || { date: date, emp_id: emp, name: name, approved_at: '', leaves: [], voided: [] }; };
  (ash ? readSheetAsObjects(ash).rows : []).forEach(function (x) {
    var d = normCellDate(x.date); if (d < from || d > to) return;
    var o = day(d, String(x.emp_id), String(x.name || '').trim());
    // 總部鏡像列（mirror_src，從央廚等原店抄來）：原店有核定＝這天有核定，假別也是照規則一起抄的，不算孤兒（2026-11-14 吳佳宜誤報）。
    //   鏡像的核定時間是抄寫時間、作廢的單在原店，所以不拿來比「作廢晚於核定」
    if (String(x.mirror_src || '').trim()) { o.has_approved = true; o.mirror = true; return; }
    var t = String(normCellTs(x.entered_at) || '');
    if (t > o.approved_at) o.approved_at = t; o.has_approved = true;
  });
  (lsh ? readSheetAsObjects(lsh).rows : []).forEach(function (x) {
    var d = normCellDate(x['日期']); if (d < from || d > to) return;
    var nm = String(x['姓名'] || '').trim(), emp = empByName[nm] || '';
    day(d, emp || ('?' + nm), nm).leaves.push({ type: String(x['假別'] || ''), hours: x['時數'] === '' ? '' : Number(x['時數']) });
  });
  reqs.forEach(function (r) {
    if (r.status !== 'voided') return;
    var o = days[String(r.date) + '|' + String(r.emp_id)]; if (!o) return;
    o.voided.push({ id: String(r.id), kind: String(r.kind), summary: reqSummary_(r), voided_at: String(normCellTs(r.voided_at) || ''), voided_by: String(r.voided_by || '') });
  });
  var items = [];
  Object.keys(days).sort().forEach(function (k) {
    var o = days[k], probs = [];
    if (o.voided.some(function (v) { return !o.has_approved || (o.approved_at && v.voided_at > o.approved_at); }) && (o.has_approved || o.leaves.length)) probs.push('voided');
    if (o.leaves.length && !o.has_approved) probs.push('orphan_leave');
    if (!probs.length) return;
    items.push({ key: k, date: o.date, emp_id: o.emp_id, name: o.name, has_approved: !!o.has_approved, approved_at: o.approved_at, leaves: o.leaves, voided: o.voided, probs: probs });
  });
  return items;
}
function handleFinalOrphanScan_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var from = String(body.from || ''), to = String(body.to || '');
  if (!reqIsDate_(from) || !reqIsDate_(to) || from > to) return { ok: false, error: 'bad_date' };
  var ss = getSS();
  if (body.apply !== true) return { ok: true, apply: false, from: from, to: to, items: finalOrphanScan_(ss, from, to) };
  var keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
  if (!keys.length) return { ok: false, error: 'no_keys', message: 'apply 要帶 keys（看過試算清單後指定要清的人日）' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'busy' };
  try {
    var miniBlock = reqMiniApplyBlock_('舊資料清理');   // 2026-11-21：店切 mini 後不套用（見 reqMiniApplyBlock_）；只預覽不擋
    if (miniBlock) return miniBlock;
    var items = finalOrphanScan_(ss, from, to), byKey = {}, done = [], skipped = [];
    items.forEach(function (it) { byKey[it.key] = it; });
    keys.forEach(function (k) {
      var it = byKey[k];
      if (!it || /^\?/.test(it.emp_id)) { skipped.push({ key: k, reason: it ? '姓名對不到名冊' : '不在這次清單裡（可能已經處理過）' }); return; }
      var payLock = reqPayLock_(it.date, false, ss);   // 薪資鎖月後不可以再動（2026-11-15）：鎖定月的人日略過，要清先到薪資頁解鎖
      if (payLock) { skipped.push({ key: k, reason: payLock.message, error: payLock.error }); return; }
      var r = reqRevokeFinal_(ss, it.emp_id, it.name, it.date, '舊資料清理（' + it.probs.join('、') + '）');
      done.push({ key: k, moved: r });
    });
    return { ok: true, apply: true, from: from, to: to, done: done, skipped: skipped };
  } finally { lock.releaseLock(); }
}

/** {action:'mgr_req_decide_batch', mgr_key, ids:[…], decision:'approve'} → {ok, done:[ids], skipped:[{id, reason}]}
 *  批次只能核准（2026-10-09 Eason）：退回要寫理由，一筆一筆退。一把鎖、鎖內重讀，不是審核中的就略過並說明原因。 */
function handleMgrReqDecideBatch_(body, viaAuth) {
  // 2026-11-21 P3-3：先過 dutyAuthRun_（DutyFeed.gs：DUTY_AUTH＝mini 只收簽名寫回、同一個寫回單號只寫一次；開關全空＝直接回來照原本流程）
  if (!viaAuth && typeof dutyAuthRun_ === 'function') return dutyAuthRun_(body, 'mgr_req_decide_batch', handleMgrReqDecideBatch_);
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
    var now = nowTaipeiIso(), done = [], skipped = [], warnItems = [], apMap = null, annualFromBy = {};
    var reopenOn = null, reopenMemo = { reqs: Object.keys(byId).map(function (k) { return byId[k]; }) }, dayOkItems = [], oks = [];   // 補單核准後打回（2026-11-26）；okIds＝這一批已核准的（申請列是批次開頭讀的）
    var upc = reqMgrActing_(mgr, body) ? null : reqUpperCache_(ss);
    var blind = reqKeyBlind_(mgr, ss);   // 這把鑰匙對不到名冊上的人：加班、請假、出差不給核（2026-11-15）
    ids.forEach(function (id) {
      var r = byId[id];
      if (!sh || !r) { skipped.push({ id: id, reason: '找不到這筆申請' }); return; }
      if (r.status !== 'pending') { skipped.push({ id: id, reason: r.status === 'cancelled' ? '同仁已經取消這筆申請' : '這筆已經處理過了' }); return; }
      var payLock = reqPayLock_(String(r.date || ''), false, ss);   // 薪資鎖月後不可以再動（2026-11-15）：鎖定月的那幾筆略過、其他照做
      if (payLock) { skipped.push({ id: id, reason: payLock.message, error: payLock.error }); return; }
      var pb = reqProxyBlock_(r, mgr, body, actor);
      if (pb) { skipped.push({ id: id, reason: pb.error === 'self_proxy' ? '你代開的申請，要由別的總監層級主管核准' : '主管代開的申請，由總監層級審核' }); return; }
      var why = (upc && !r.proxy_by) ? reqUpperWhy_(r.emp_id, ss, upc) : '';
      if (why) { skipped.push({ id: id, reason: why === 'mgr' ? '值班主管本人的申請，送上層審核' : '支援同仁的申請，由原單位主管審核' }); return; }
      if (blind && !r.proxy_by && !reqIsMiss_(r)) { skipped.push({ id: id, reason: '這把主管鑰匙對不到名冊上的人，請在管理系統審核' }); return; }
      if (reqNeedsProof_(r)) { skipped.push({ id: id, reason: r.leave_type + '還沒附證明' }); return; }
      if (reqIsAnnual_(r)) {   // 1113 紅燈 d3：同一人只查一次
        var ek = String(r.emp_id);
        if (!(ek in annualFromBy)) annualFromBy[ek] = reqAnnualFromEmp_(r.emp_id, body.mgr_key);
        var anMsgB = reqAnnualBlockMsg_(r, annualFromBy[ek]);
        if (anMsgB) { skipped.push({ id: id, reason: anMsgB }); return; }
      }
      oks.push({ id: id, r: r });
    });
    // 補單核准後打回（2026-11-26，開關 REQ_REOPEN_ON；獨立審查第二輪）：先決定每個「同人同日」這一組實際會核准的單（上面各自檢查都過的），
    //   再用「原本已核准的＋這一組全部」一次判斷——每個人日只判一次、只打回一次，組內每張的結果一致（整組已包含＝都進 day_ok_items；整組要打回＝都標打回）。
    //   打回失敗＝整組都不核准（進 skipped）。開關關著、或沒有請假／出差／加班單＝整段不跑，下面照原本逐筆寫入與提醒。
    var grp = {}, order = [];
    oks.forEach(function (it) {
      if (!reqAffectsDay_(it.r)) return;
      if (reopenOn === null) reopenOn = reqReopenOn_();
      if (!reopenOn || !reqReopenLockOk_(it.r, body, ss)) return;      // 鎖月讀不到＝這筆照今天的提醒
      var k = String(it.r.date || '').slice(0, 10) + '|' + String(it.r.emp_id);
      if (!grp[k]) { grp[k] = { items: [], act: null }; order.push(k); }
      grp[k].items.push(it); it.g = grp[k];
    });
    var failIds = {};
    order.forEach(function (k) {
      var g = grp[k], first = g.items[0].r, judgedG = false;
      try {
        var memoG = { reqs: reopenMemo.reqs, okIds: {} };
        if (reopenMemo.approved) memoG.approved = reopenMemo.approved;
        if (reopenMemo.leave) memoG.leave = reopenMemo.leave;
        g.items.forEach(function (it) { memoG.okIds[String(it.id)] = true; });      // 這一組全部當成已核准
        var rows = reqReopenRows_(ss, memoG, 'approved');
        reopenMemo.approved = memoG.approved; reopenMemo.leave = memoG.leave;
        var date = k.slice(0, 10), emp = k.slice(11), latest = reqDayOwnLatest_(rows, emp, date);
        if (latest) g.act = g.items.every(function (it) { return reqDayCovers_(ss, it.r, latest, memoG); }) ? 'covered' : 'reopen';
        else g.act = rows.some(function (x) { return normCellDate(x.date) === date && String(x.emp_id) === emp; }) ? 'old_warn' : 'none';
        judgedG = true;
        if (g.act === 'reopen') g.revoked = reqReopenDay_(ss, first, actor, g.items.map(function (it) { return it.r; }));
      } catch (errB) {
        console.log('mgr_req_decide_batch 打回核定失敗：' + errB);
        g.items.forEach(function (it) { failIds[it.id] = true; skipped.push({ id: it.id, reason: judgedG ? REQ_REOPEN_FAIL_MSG_ : REQ_REOPEN_READ_MSG_ }); });
      }
    });
    oks.forEach(function (it) {
      var id = it.id, r = it.r;
      if (failIds[id]) return;
      reqSetCells_(sh, r.__rowIndex, { status: 'approved', decided_at: now, decided_by: actor, reject_reason: '' });
      done.push(id);
      if (it.g) {
        var dB = String(r.date || '').slice(0, 10);
        if (it.g.act === 'reopen') warnItems.push(reqReopenOut_({ id: id }, r, dB, it.g.revoked));
        else if (it.g.act === 'covered') dayOkItems.push({ id: id, day_ok: true, message: reqDayOkMsg_(dB) });   // 另列，舊畫面只看 warn_items＝跟今天一樣安靜
        else if (it.g.act === 'old_warn') warnItems.push({ id: id, warn: REQ_DAY_WARN_, warn_dates: [dB], message: reqDayWarnMsgOf_(r, [dB]) });
        return;
      }
      if (reqAffectsDay_(r)) {
        try { if (!apMap) apMap = reqApprovedMap_(ss); } catch (e) { apMap = {}; }
        if (reqDayApproved_(apMap, r)) {
          var dd = String(r.date || '').slice(0, 10);
          warnItems.push({ id: id, warn: REQ_DAY_WARN_, warn_dates: [dd], message: reqDayWarnMsgOf_(r, [dd]) });
        }
      }
    });
    var outB = { ok: true, done: done, skipped: skipped };
    if (warnItems.length) outB.warn_items = warnItems;   // 只列有提醒的那幾筆；沒有就不帶（回應形狀同改版前）
    if (dayOkItems.length) outB.day_ok_items = dayOkItems;   // 核定已包含這張單（開關開著才可能有）
    return outB;
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
      if (r.proxy_by) why = 'director';   // 主管代開的單：總監層級審，同 mgr_req_pending／mgr_req_day（2026-11-15 考勤挑錯 B19：月彙整原本沒標）
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
   2026-11-11（B16）：核定加嚴生效的日子（REQ_STRICT_FROM，預設 2026-11-01 起），時數改用和主管頁「參考時數」一樣的算法
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
  if (reqSameActor_(actor, r.proxy_by)) return { ok: false, error: 'self_proxy', message: '這筆是你代開的，要由別的總監層級主管審核' };
  return null;
}
/** 兩個「核定人／代開人」字樣是不是同一個人（2026-11-15 考勤挑錯 B3）：營運系統代轉的字樣是「姓名（編號）」，
 *  兩邊都有結尾的括號編號就比編號（姓名在管理系統改了也認得出是同一人；同名不同編號是不同人）；有一邊沒有編號才比整串（去空白）。 */
function reqActorSub_(s) { var m = /（([^（）]+)）$/.exec(String(s == null ? '' : s).trim()); return m ? m[1].trim() : ''; }
function reqSameActor_(a, b) {
  var sa = reqActorSub_(a), sb = reqActorSub_(b);
  if (sa && sb) return sa === sb;
  return reqNameKey_(a) === reqNameKey_(b);
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
  var diff = reqDayDiff_(date, today), limit = reqPastLimit_(date, today, kind === 'miss' ? REQ_MISS_DAYS : null);
  if (diff < -REQ_PROXY_PAST_DAYS) return { ok: false, error: 'too_old', message: '代開最多到 ' + REQ_PROXY_PAST_DAYS + ' 天前' };
  var ss = getSS();
  var payLock = reqPayLock_(date, false, ss);   // 薪資鎖月後不可以再動（2026-11-15）
  if (payLock) return payLock;
  if (typeof body.emp_id !== 'string' && typeof body.emp_id !== 'number') return { ok: false, error: 'invalid_emp_id', message: '找不到這位同仁' };   // 員編只收文字或數字（2026-11-16）
  var me = findRosterByEmpId(readSheetAsObjects(ss.getSheetByName('roster')).rows, body.emp_id);
  if (!me) return { ok: false, error: 'invalid_emp_id', message: '找不到這位同仁' };
  /* 7 天內同仁自己用 LINE 申請；沒綁 LINE 的人送不了單，今天和過去的日子可以由主管代開（2026-11-09 Eason）。 */
  /* 2026-11-11（B30）：名冊已停用（離職）的同仁也一樣——LINE 雖然還綁著，本人已經送不了單，
     原本要等超過 7 天店長才能代開，這幾天核定又被「缺單」擋住。 */
  if (diff >= -limit && !(diff <= 0 && (reqNoLine_(me) || !reqTrue_(me.active)))) return { ok: false, error: 'not_old', message: limit > (kind === 'miss' ? REQ_MISS_DAYS : REQ_LEAVE_PAST_DAYS) ? '11/28 以前，11 月的請假、加班、出差、忘打卡請同仁自己在 LINE「加班請假」申請；同仁沒綁 LINE 才能由主管代開' : limit + ' 天內請同仁自己在 LINE「加班請假」申請；超過 ' + limit + ' 天或同仁沒綁 LINE 才能由主管代開' };
  // 代開兩段（2026-11-18）：只有加班（N3），上限單張與合計都是 REQ_OT_PROXY_MAX_H（N1 更正：10 小時）
  var segP = reqSegsOf_(body, true);
  if (segP && segP.error) return reqSegFail_(segP);
  if (segP && segP.single) { body = segP.single; segP = null; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '系統忙碌，請再按一次' };
  try {
    var existing = reqRows_(ss);
    if (segP) {
      var sp = reqSegsValidate_(body, segP, me, liffEvents_(ss, reqDaySince_(date)), today, existing, true);
      if (sp.error) return reqSegFail_(sp);
      return reqSaveSegs_(ss, sp.rows, existing, { emp_id: String(me.emp_id), name: String(me.name), attach_id: '', proxy_by: actor });
    }
    var v = reqValidate_(body, me, liffEvents_(ss, reqDaySince_(date)), today, existing, true);
    if (v.error) return { ok: false, error: v.error, message: v.message };
    var r = v.row;
    // 2026-11-11（B37）：補休只有正職可以請——本人送會擋，代開也照擋（查不到薪資主檔的店照舊不擋）
    if (r.kind === 'leave' && r.leave_type === REQ_COMP_LEAVE_ && reqCompAllowed_(me) === false) {
      return { ok: false, error: 'comp_not_allowed', message: '補休只有正職可以請' };
    }
    if (reqIsAnnual_(r)) {   // 1113 紅燈 d3：代開也擋未滿六個月的特休
      var anMsgP = reqAnnualBlockMsg_(r, reqAnnualFromEmp_(me.emp_id, body.mgr_key));
      if (anMsgP) return { ok: false, error: 'annual_not_eligible', message: anMsgP };
    }
    // 生理假新規則（2026-11-18）：代開也檢查（計時、第 4 次、每月一次、一天 8 小時）
    var mensP = reqLeaveRulesCheck_(r, existing, me, ss, function () { return reqQuotaForEmp_(me, body.mgr_key); });   // 病假年度用完也在這裡
    if (mensP) return mensP;
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
var REQ_BIND_FROM_DEFAULT_ = '2026-11-01';   // 2026-11-13 Eason：11/1–11/5 也要有單（原 2026-11-06）
var REQ_BIND_OT_BASE_H = 8;
var REQ_BIND_NEAR_MS = 4 * 3600000;   // 沒配到完整打卡段的時段：前後 4 小時內的單張卡算那段的
function reqBindFrom_() {
  var v = '';
  try { v = String(reqProp_('REQ_BIND_FROM') || ''); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_BIND_FROM_DEFAULT_;
}
/** 核定時段少了幾張打卡。periods：[{startMs,endMs}]；segs：[{inMs,outMs}]（null＝沒有那張） */
/** 程式碼.js 還沒有 loneCardsForPeriods_ 時的舊算法：每段取前後 4 小時內第一張單獨的卡 */
/* 核定時段跟已核准加班單之間沒接上的空檔（同一段打卡從核定時段一路打到加班單，中間那段沒核定）→ 白話提示（2026-11-18 驗收 A）。
   例：「加班單（21:00–21:45）跟上班時段（到 20:30）中間有 30 分鐘沒接上：請把加班單改成從 20:30 開始，或把上班時段接到加班單開始」 */
function reqOtGapHints_(date, otRows, periods, segs) {
  var ps = (periods || []).filter(function (p) { return p && p.startMs != null && p.endMs != null; }).slice().sort(function (a, b) { return a.startMs - b.startMs; });
  var full = (segs || []).filter(function (s) { return s && s.inMs != null && s.outMs != null; });
  var cover = function (a, b) { return full.some(function (s) { return s.inMs <= a && s.outMs >= b; }); };
  var inside = function (a, b) { return ps.some(function (p) { return p.startMs < b && p.endMs > a; }); };
  var out = [];
  (otRows || []).forEach(function (r) {
    var a = reqHm_(r.start), b = reqHm_(r.end);
    if (!a || !b) return;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    [0, 86400000].forEach(function (d) {
      var os = s + d, oe = e + d;
      var before = ps.filter(function (p) { return p.endMs < os; }).pop();
      if (before && cover(before.endMs, os) && !inside(before.endMs, os)) {
        out.push('加班單（' + a + '–' + b + '）跟上班時段（到 ' + reqOtPunchHm_(before.endMs) + '）中間有 ' + Math.round((os - before.endMs) / 60000) + ' 分鐘沒接上：請把加班單改成從 ' + reqOtPunchHm_(before.endMs) + ' 開始，或把上班時段接到加班單開始');
      }
      var after = ps.filter(function (p) { return p.startMs > oe; })[0];
      if (after && cover(oe, after.startMs) && !inside(oe, after.startMs)) {
        out.push('加班單（' + a + '–' + b + '）跟上班時段（' + reqOtPunchHm_(after.startMs) + ' 起）中間有 ' + Math.round((after.startMs - oe) / 60000) + ' 分鐘沒接上：請把加班單改成到 ' + reqOtPunchHm_(after.startMs) + '，或把上班時段從加班單結束接起');
      }
    });
  });
  return out;
}
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
/* ── 核定加嚴（2026-11-08 Eason 定案；REQ_STRICT_FROM 預設 2026-11-01 起的日子才算，指令碼屬性設 off＝只關加嚴；REQ_BIND_FROM 設 off＝全部關）──
   規則 1：已核准加班單的時段要落在核定時段內，前後可差 15 分鐘（那天有出差時數不比時段：加班可能在出差那段）。
   規則 2：加班單時數不可少於應有加班時數；多 15 分鐘內算相符。應有＝一般日核定超過 8 小時的部分；班表休息日／例假＝當天核定全部；班表查不到照一般日。
           一般日核定沒超過 8 小時卻有已核准加班單＝擋，要先作廢。
   規則 3：核定登記的假別、時數要和已核准假單（含出差單）一樣；登記了沒單、有單沒登記都擋。整天請假也看。
   規則 4：核定和打卡（完整打卡的日子，扣掉不打卡休息帶）差 30 分鐘以上要填原因，原因存 approved 的 diff_reason。 */
var REQ_STRICT_FROM_DEFAULT_ = '2026-11-01';   // 2026-11-17 Eason：加嚴往前套到 11/1（原 2026-11-11；休假日出勤整天要加班單）
var REQ_STRICT_TOL_MIN = 15;
var REQ_STRICT_DIFF_MIN = 30;
var REQ_DIFF_REASON_MAX = 100;
function reqStrictFrom_() {
  var v = '';
  try { v = String(reqProp_('REQ_STRICT_FROM') || ''); } catch (e) {}
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
/** 加班單落在每段班表內各幾分鐘（取跨夜試隔天後總和最大的那種算法），回 [分鐘…] 與 spans 對齊。 */
function reqOtInSchedBySpan_(start, end, spans) {
  var a = reqMin_(start), b = reqMin_(end), none = spans.map(function () { return 0; });
  if (a === null || b === null) return none;
  if (b <= a) b += 1440;
  var best = none, bestSum = 0;
  [0, 1440].forEach(function (shift) {
    var arr = spans.map(function (x) {
      var s = reqMin_(String(x.start)), e = reqMin_(String(x.end));
      if (s === null || e === null) return 0;
      if (e <= s) e += 1440;
      return Math.max(0, Math.min(b + shift, e) - Math.max(a + shift, s));
    });
    var sum = arr.reduce(function (x, y) { return x + y; }, 0);
    if (sum > bestSum) { best = arr; bestSum = sum; }
  });
  return best;
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
/** 核定比打卡多幾分鐘（2026-11-14 Eason「打卡＋單＝核定時數」，營運系統 docs/punch-plus-req/）：
 *  核定時段裡沒有打卡涵蓋的分鐘（扣掉不打卡休息帶），但「第一段開頭到第一張上班卡」不算——那是遲到，打卡端照標「遲到 N 分」、薪資照扣。
 *  早到、晚走（打卡比核定多）一律不算，不用寫原因。打卡不完整（缺卡）回 null，交給忘打卡單那條。 */
/** 打卡段＋已核准忘打卡單補的卡（2026-11-15）。segs：[{inMs, outMs}]（缺卡＝null）；okRows：那天已核准的申請。
 *  both＝補一整段（start–end）；in／out＝補第一個缺上班／下班的段；break＝中間休息沒打卡（end＝出去、start＝回來，同 core-calc）。
 *  補不上（時間格式錯、找不到缺的段）就略過。回新的陣列，不動原本的 segs。 */
function reqSegsWithMiss_(segs, okRows, date) {
  var ms = function (hm) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Date.parse(date + 'T' + ('0' + m[1]).slice(-2) + ':' + m[2] + ':00+08:00') : null; };
  var out = (segs || []).map(function (x) { return { inMs: x.inMs == null ? null : x.inMs, outMs: x.outMs == null ? null : x.outMs }; });
  (okRows || []).filter(function (r) { return r.kind === 'miss'; }).forEach(function (r) {
    var a = ms(r.start), b = ms(r.end), t = String(r.miss_type || '');
    if (t === 'both' && a != null && b != null) out.push({ inMs: a, outMs: b > a ? b : b + 86400000 });
    else if (t === 'in' && a != null) { var si = out.filter(function (x) { return x.inMs == null; })[0]; if (si) si.inMs = a; }
    else if (t === 'out' && b != null) { var so = out.filter(function (x) { return x.outMs == null; })[0]; if (so) so.outMs = (so.inMs != null && b <= so.inMs) ? b + 86400000 : b; }
    else if (t === 'break' && a != null && b != null) {   // end＝出去（b）、start＝回來（a）
      var sb = out.filter(function (x) { return x.inMs != null && x.outMs != null && x.inMs < b && x.outMs > a; })[0];
      if (sb) { out.push({ inMs: a, outMs: sb.outMs }); sb.outMs = b; }
    }
  });
  return out;
}
/* 已核准、有填起訖的假單／出差單的結束時間（ms；跨夜試前一天／隔天，同 reqLeaveOverlapProbs_）：「該回來上班」的時間點（2026-11-18 Eason 選 B）。
   營運系統核定會從這裡起算（中間請假晚回來＝遲到），reqOverCreditMin_ 把這段當遲到、不當沒打卡的多核工時。 */
function reqLeaveBackMs_(date, okRows) {
  var out = [];
  (okRows || []).forEach(function (r) {
    if (r.kind !== 'leave' && r.kind !== 'trip') return;
    var a = reqHm_(r.start), b = reqHm_(r.end);
    if (!a || !b || a === b) return;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    out.push(e, e - 86400000, e + 86400000);
  });
  return out;
}
/* 已核准、有填起訖的假單／出差單的開始時間（ms；同上試前一天／隔天）：「該下班」的時間點（2026-11-18 Eason「請假前提早離開一律記早退」）。
   營運系統核定會算到這裡（請假前提早走＝早退），reqOverCreditMin_ 把實際下班卡到這裡當早退、不當多核工時。 */
function reqLeaveStartMs_(date, okRows) {
  var out = [];
  (okRows || []).forEach(function (r) {
    if (r.kind !== 'leave' && r.kind !== 'trip') return;
    var a = reqHm_(r.start), b = reqHm_(r.end);
    if (!a || !b || a === b) return;
    var s = reqHmMs_(date, a);
    out.push(s, s - 86400000, s + 86400000);
  });
  return out;
}
/* 多段班中間那幾段的結束時間（後面還有一段班；當天最後一段的結束不算）：2026-11-18 Eason「二段班各段結尾早走一律記早退」——
   營運系統核定會算到那段班表結束，reqOverCreditMin_ 把最後一張下班卡到那裡當早退。沒帶班表＝空。 */
function reqSchedMidEndMs_(date, spans) {
  var list = (Array.isArray(spans) ? spans : []).map(function (x) {
    var a = reqHm_(x && x.start), b = reqHm_(x && x.end);
    if (!a || !b) return null;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    return { s: s, e: e };
  }).filter(function (x) { return x; }).sort(function (x, y) { return x.s - y.s; });
  var out = [];
  list.slice(0, -1).forEach(function (x) { out.push(x.e, x.e - 86400000, x.e + 86400000); });
  return out;
}
/* 班表每一段的開始時間（ms；營運系統帶的 sched_spans，跨夜試前一天／隔天）：2026-11-18 Eason「沒有請假的二段班第二段晚到，記成遲到」——
   營運系統核定會從那段班表開始算，reqOverCreditMin_ 把那段開頭到實際上班卡當遲到（同第一段開頭）。沒帶班表（舊值班頁）＝空，跟改之前一樣。 */
function reqSchedStartMs_(date, spans) {
  var out = [];
  (Array.isArray(spans) ? spans : []).forEach(function (x) {
    var a = reqHm_(x && x.start);
    if (!a) return;
    var s = reqHmMs_(date, a);
    out.push(s, s - 86400000, s + 86400000);
  });
  return out;
}
/* ── 還有待審的申請單就不能核定（2026-11-20 Eason 第 13 題 A：打卡後端也擋）──
   營運系統畫面（web/modules/duty/pend-gate.js pendingFor）與營運系統伺服器（新版前端核定）早就擋；這裡是打卡端最後一道，
   舊值班核定頁、直接打 mgr_approve（含 dry_run 只檢查）也擋。規則同畫面：requests 裡這個人、這一天、status＝pending 的每一張都算
   （加班、請假、忘打卡、出差不分種類；本人自己送的、要上層審的也算——這位主管審不了，仍是待審）。由 Code.gs handleMgrApprove 呼叫。
   指令碼屬性 REQ_PEND_BLOCK＝off（off／false／0／關，不分大小寫）關掉（退回用，不用改程式）；填了認不得的值照預設「擋」、記一筆 log。字句同畫面 PEND_BLOCK_MSG。 */
var REQ_PEND_BLOCK_MSG_ = '這天還有待審的申請，請先審單（審完才能核定）';
/* 開關屬性的讀法（2026-11-20 複審：填錯值要偏安全）：不分大小寫、前後空白不算。
   回 'off'（off／false／0／no／關）、'on'（on／true／1／yes／開）、''（沒設）、或原值（其他＝認不得，呼叫端自己決定：放寬規則的 REQ_GAP_LATE_FROM 當關、保護性的 REQ_PEND_BLOCK 照擋）。 */
var REQ_SWITCH_OFF_ = ['off', 'false', '0', 'no', '關'], REQ_SWITCH_ON_ = ['on', 'true', '1', 'yes', '開'];
function reqSwitchRead_(key) {
  var raw = '';
  try { raw = String(reqProp_(key) || ''); } catch (e) {}
  var v = raw.trim().toLowerCase();
  if (!v) return '';
  if (REQ_SWITCH_OFF_.indexOf(v) >= 0) return 'off';
  if (REQ_SWITCH_ON_.indexOf(v) >= 0) return 'on';
  return v;
}
function reqSwitchBad_(key) { try { console.warn('指令碼屬性 ' + key + ' 的值認不得，當成「關」處理（請改成 off 或刪掉這個屬性）'); } catch (e) {} }      // 不印值
function reqPendBlockOn_() {
  // 保護性檢查：只有明確的關閉字（off／false／0／no／關）才關；認不得的值照預設「擋」並記一筆 log（2026-11-20 第三輪：被誤關＝少擋）
  var v = reqSwitchRead_('REQ_PEND_BLOCK');
  if (v === 'off') return false;
  if (v !== '' && v !== 'on') { try { console.warn('指令碼屬性 REQ_PEND_BLOCK 的值認不得，照預設「擋」處理（要關請填 off）'); } catch (e) {} }      // 不印值
  return true;
}
/** rows：申請表（reqRows_）；回 null＝可以核定，否則回要擋的回應（pending＝幾張審核中） */
function reqPendBlock_(rows, empId, date) {
  if (!reqPendBlockOn_()) return null;
  var n = (rows || []).filter(function (r) {
    return String(r.emp_id) === String(empId) && String(r.date).slice(0, 10) === String(date) && String(r.status) === 'pending';
  }).length;
  return n ? { ok: false, error: 'pending_request', message: REQ_PEND_BLOCK_MSG_, pending: n } : null;
}

/* ── 二段班中途離開又回來，比照遲到記（2026-11-20 Eason 第 11 題 B；例 班表 16:00–20:00，16:03 走、17:24 回 → 遲到 81 分）──
   營運系統核定會把那段空檔一起核進去（跟開頭晚到「核定留班表」一樣），Code.gs computeApprovalStatus（gapLate）照記「遲到N分」、薪資照扣；
   這裡讓「核定比打卡多」把那段空檔當遲到、不當沒打卡的多核工時。只認：
     ① 上線日（REQ_GAP_LATE_FROM）起的日子——之前的日子核定、重新核定、每天重算都照舊（不回溯）；
     ② 營運系統個人帳號代轉帶來的班表（sched_spans）：空檔整個落在同一段班表裡；預設只有當天班表兩段以上（二段班）才算（REQ_GAP_LATE_SCOPE＝all 單段班也算）；
     ③ 空檔兩邊都是打卡（或已核准忘打卡單補的卡），整個被同一段核定時段蓋住。
   不算（照改之前，空檔照樣是「核定比打卡多」）：空檔碰到不打卡休息帶、碰到已核准有時段的假單／出差單（走請假那幾條）、
   是已核准「中間休息」忘打卡單補出來的休息。
   班別休息（break_min）那段班的第一個空檔是休息：二段班時只算滿休息分鐘、超過的部分記遲到（2026-11-20 Eason 第 3 題 B，例 休 30、出去 50 → 20 分遲到）；單段班照 11/17（超過的照實扣）。
   沒有新增任何金額規則：空檔只是進了既有的遲到分鐘。 */
var REQ_GAP_LATE_FROM_DEFAULT_ = null;  // 2026-11-21 延後生效（Codex 交叉驗證 4 個已重現問題）：不再寫死上線日（原本 '2026-11-22'）＝沒設屬性就關、認不得也關。
                                     // 要開只能設指令碼屬性 REQ_GAP_LATE_FROM＝日期；⚠ 營運系統 web/modules/duty/core-calc.js 的 GAP_LATE_FROM 要同一天、兩邊一起開
var REQ_GAP_LATE_SCOPE_DEFAULT_ = 'multi';  // multi＝只有二段班（當天班表兩段以上）；all＝單段班也算。指令碼屬性 REQ_GAP_LATE_SCOPE 優先
function reqGapLateFrom_() {
  var v = reqSwitchRead_('REQ_GAP_LATE_FROM');
  if (v === 'off') return null;
  if (reqIsDate_(v)) return v;
  if (v !== '') { reqSwitchBad_('REQ_GAP_LATE_FROM'); return null; }      // 不是日期也不是關（含 on）＝認不得 → 關（2026-11-20 複審：原本退回程式預設＝開）
  return REQ_GAP_LATE_FROM_DEFAULT_ && reqIsDate_(REQ_GAP_LATE_FROM_DEFAULT_) ? REQ_GAP_LATE_FROM_DEFAULT_ : null;
}
/** 這一天的核定狀態要不要把中途離開的空檔記成遲到（Code.gs computeApprovalStatus 的 gapLate；核定當下與每天重算同一個判斷） */
function reqGapLateOn_(date) { var f = reqGapLateFrom_(); return !!(f && reqIsDate_(String(date)) && String(date) >= f); }
/** 營運系統帶的班表 → 依時間排、剛好相接（14:00 接 14:00）或重疊的併成一段（同營運系統 core-calc 的 merge）：[{s, e, bm}] */
function reqGapLateSpanList_(date, spans) {
  var list = (Array.isArray(spans) ? spans : []).map(function (x) {
    var a = reqHm_(x && x.start), b = reqHm_(x && x.end);
    if (!a || !b || a === b) return null;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    return { s: s, e: e, bm: Math.max(0, Math.round(Number(x.break_min) || 0)), rest: false };
  }).filter(function (x) { return x; }).sort(function (x, y) { return x.s - y.s; });
  var out = [];
  list.forEach(function (x) { var l = out[out.length - 1]; if (l && x.s <= l.e) { l.e = Math.max(l.e, x.e); l.bm = l.bm || x.bm; } else out.push(x); });
  return out;
}
/** 這一天核定要不要套中途離開比照遲到（Code.gs handleMgrApprove 決定 computeApprovalStatus 的 gapLate）：上線日起、有營運系統班表、
 *  範圍內（預設當天班表兩段以上）。單段班、門市登入／舊值班頁（沒有班表）＝false＝狀態跟 main 完全一樣（2026-11-20 複審）。 */
function reqGapLateDay_(date, spans) {
  if (!reqGapLateOn_(date)) return false;
  var n = reqGapLateSpanList_(date, spans).length;
  return reqGapLateScope_() === 'all' ? n >= 1 : n >= 2;
}
function reqGapLateScope_() {
  var v = '';
  try { v = String(reqProp_('REQ_GAP_LATE_SCOPE') || ''); } catch (e) {}
  return v === 'all' || v === 'multi' ? v : REQ_GAP_LATE_SCOPE_DEFAULT_;
}
/** 中途離開又回來、被核定蓋住的空檔合計（ms），算進「核定比打卡多」的遲到。不適用回 0。
 *  periods：[{startMs,endMs}]；segs：打卡＋已核准忘打卡單補的卡（reqSegsWithMiss_）；spans：營運系統帶的班表 [{start,end,break_min}]；okRows：這天已核准的申請 */
function reqGapLateMs_(date, periods, segs, spans, breakWindow, okRows) {
  if (!reqGapLateOn_(date)) return 0;
  var sp = reqGapLateSpanList_(date, spans);      // 剛好相接的兩段併成一段（同營運系統），併完只剩一段＝單段班
  if (!sp.length || (reqGapLateScope_() === 'multi' && sp.length < 2)) return 0;
  var full = (segs || []).filter(function (s) { return s && s.inMs != null && s.outMs != null && s.outMs > s.inMs; })
    .slice().sort(function (a, b) { return a.inMs - b.inMs; });
  if (full.length < 2) return 0;
  // 這天打卡之間的空檔（全部的段照時間先後）
  var gaps = [], maxOut = full[0].outMs;
  full.slice(1).forEach(function (s) { if (s.inMs > maxOut) gaps.push({ a: maxOut, b: s.inMs }); if (s.outMs > maxOut) maxOut = s.outMs; });
  // 已核准、有時段的假單／出差單，與「中間休息」忘打卡單（end＝出去、start＝回來）：空檔碰到就不算（跨夜試前一天／隔天）
  var skip = [];
  (okRows || []).forEach(function (r) {
    var a = reqHm_(r.start), b = reqHm_(r.end), s, e;
    if (!a || !b || a === b) return;
    if (r.kind === 'leave' || r.kind === 'trip') { s = reqHmMs_(date, a); e = reqHmMs_(date, b); }
    else if (r.kind === 'miss' && String(r.miss_type || '') === 'break') { s = reqHmMs_(date, b); e = reqHmMs_(date, a); }
    else return;
    if (e <= s) e += 86400000;
    [-86400000, 0, 86400000].forEach(function (k) { skip.push({ s: s + k, e: e + k }); });
  });
  var touch = function (g) {
    if (breakWindow && breakWindow.startMs < g.b && breakWindow.endMs > g.a) return true;
    return skip.some(function (x) { return x.s < g.b && x.e > g.a; });
  };
  var total = 0;
  gaps.forEach(function (g) {
    var s = sp.filter(function (x) { return x.s < g.a && g.b < x.e; })[0];      // 空檔整個在同一段班裡（同營運系統 core-calc：開頭、結尾剛好貼著班表邊界的不算）
    if (!s) return;
    var covered = function (a, b) { return (periods || []).some(function (p) { return p.startMs <= a && b <= p.endMs; }); };
    if (s.bm > 0 && !s.rest) {
      // 班別休息：那段班的第一個空檔是休息。2026-11-20 Eason 第 3 題 B：二段班時休息只算滿班別休息分鐘，超過的部分（核定蓋住的話）記遲到；
      // 單段班照 11/17（超過的照實扣、核定蓋住＝核定比打卡多）。碰到休息帶／假單／中間休息忘打卡單照 11/17
      s.rest = true;
      var a2 = g.a + s.bm * 60000;
      if (sp.length >= 2 && g.b > a2 && !touch(g) && covered(a2, g.b)) total += g.b - a2;
      return;
    }
    if (touch(g)) return;
    if (!covered(g.a, g.b)) return;
    total += g.b - g.a;
  });
  return total;
}
function reqOverCreditMin_(periods, segs, breakWindow, lateGiven, backs, starts, gapMs) {
  if (!periods.length || !segs.length || segs.some(function (s) { return s.inMs == null || s.outMs == null; })) return null;
  var ps = periods.slice().sort(function (a, b) { return a.startMs - b.startMs; });
  var ss = segs.slice().sort(function (a, b) { return a.inMs - b.inMs; });
  var inBreak = function (a, b) { return breakWindow ? Math.max(0, Math.min(b, breakWindow.endMs) - Math.max(a, breakWindow.startMs)) : 0; };
  var over = 0;
  ps.forEach(function (p) {
    var cov = ss.reduce(function (acc, s) { return acc + Math.max(0, Math.min(p.endMs, s.outMs) - Math.max(p.startMs, s.inMs)); }, 0);
    var covBreak = ss.reduce(function (acc, s) { var a = Math.max(p.startMs, s.inMs), b = Math.min(p.endMs, s.outMs); return acc + (b > a ? inBreak(a, b) : 0); }, 0);
    over += (p.endMs - p.startMs - inBreak(p.startMs, p.endMs)) - (cov - covBreak);
  });
  var late = Math.max(0, Math.min(ss[0].inMs, ps[0].endMs) - ps[0].startMs);
  late -= inBreak(ps[0].startMs, ps[0].startMs + late);
  // 2026-11-18 Eason（選 B）：第二段以後的核定時段，開頭剛好是已核准假單／出差單的結束（中間只隔不打卡休息帶也算）→ 從那裡到實際回來那張上班卡＝遲到（同第一段開頭），
  // 不算沒打卡的多核工時。那段開頭已有打卡蓋到、或那段裡沒有上班卡＝不適用。沒帶 backs（沒有這種單）＝跟改之前一樣
  (backs || []).length && ps.slice(1).forEach(function (p) {
    if (!backs.some(function (e) { return e <= p.startMs && (p.startMs - e) - inBreak(e, p.startMs) <= 0; })) return;
    if (ss.some(function (s) { return s.inMs <= p.startMs && s.outMs > p.startMs; })) return;
    var ins = ss.filter(function (s) { return s.inMs > p.startMs && s.inMs < p.endMs; }).map(function (s) { return s.inMs; });
    if (!ins.length) return;
    var first = Math.min.apply(null, ins);
    late += (first - p.startMs) - inBreak(p.startMs, first);
  });
  // 2026-11-20 Eason 第 11 題 B：中途離開又回來、被核定蓋住的空檔＝遲到（reqGapLateMs_ 算好帶進來；沒帶＝跟改之前一樣）。主管填遲到分鐘時合計受下面同一個上限
  if (Number(gapMs) > 0) late += Number(gapMs);
  // 2026-11-15（考勤挑錯 B1）：主管有填遲到分鐘（0＝認定不計遲到、N＝認定遲到 N 分）時，只有他認的那 N 分鐘算遲到（薪資照扣）；
  // 被免掉的遲到分鐘＝沒打卡卻要算的時間，照樣要有單。原本整段都當遲到扣掉，只打 5 分鐘卡、遲到填 0 就核得出 8 小時。沒填＝系統照實標遲到，不變。
  if (lateGiven != null) late = Math.min(late, Math.max(0, lateGiven) * 60000);
  // 2026-11-18 Eason「請假前提早離開一律記早退」：核定時段結尾剛好是已核准假單／出差單的開始（中間只隔不打卡休息帶也算），那個時間沒有打卡蓋到
  // → 從那段裡最後一張下班卡到結尾＝早退（Code.gs computeApprovalStatus 照記「早退N分」），不算沒打卡的多核工時。沒帶 starts＝跟改之前一樣
  var early = 0;
  if ((starts || []).length) ps.forEach(function (p) {
    if (!starts.some(function (t) { return t >= p.endMs && (t - p.endMs) - inBreak(p.endMs, t) <= 0; })) return;
    if (ss.some(function (s) { return s.inMs < p.endMs && s.outMs >= p.endMs; })) return;
    var outs = ss.filter(function (s) { return s.outMs > p.startMs && s.outMs < p.endMs; }).map(function (s) { return s.outMs; });
    if (!outs.length) return;
    var last = Math.max.apply(null, outs);
    early += (p.endMs - last) - inBreak(last, p.endMs);
  });
  return Math.max(0, Math.round((over - late - early) / 60000));
}
/* ── 有沒配對的卡時「核定比打卡多」也要算（2026-11-21 出勤核定舊問題 1，Codex 20261121-rules-ab 問題 1）──
   reqOverCreditMin_ 遇到缺卡回 null、原意是交給忘打卡單那條（reqBindMissCards_），但那條只認「整段沒配到完整打卡段的核定時段」裡的單張卡：
   核定時段只要碰到一小段完整打卡（例 12:58–13:03），同一段裡的單張卡（14:00 上班、缺下班）就沒人管，主管填卡差原因就核成完整工時、狀態「早退237分」。
   做法（套既有規則，不是新規則：11/14「打卡＋單＝核定時數」、11/16「缺單照擋，寫原因不能代替補單」）：忘打卡單那條沒擋到時，
   改用「完整打卡段＋已核准忘打卡單補的卡」照算，沒配對的單張卡不當證據；還在上班的那張上班卡（B34，markWorkingSeg_ 標的 working）當成一直在上班（不擋，同 B03）。
   開關 REQ_LONE_OVER：保護性檢查——只有明確的關閉字（off／false／0／no／關）才關（退回舊行為）；沒設、認不得照擋。 */
function reqLoneOverOn_() {
  var v = reqSwitchRead_('REQ_LONE_OVER');
  if (v === 'off') return false;
  if (v !== '' && v !== 'on') { try { console.warn('指令碼屬性 REQ_LONE_OVER 的值認不得，照預設「擋」處理（要關請填 off）'); } catch (e) {} }      // 不印值
  return true;
}
/** segsMiss（reqSegsWithMiss_ 的結果，前 rawSegs.length 筆跟 rawSegs 同順序）→ 只留完整的段；還在上班的上班卡延到 16 小時後 */
function reqOverSegsKnown_(segsMiss, rawSegs) {
  return (segsMiss || []).map(function (s, i) {
    if (s.inMs != null && s.outMs != null) return s;
    var raw = (rawSegs || [])[i];
    if (raw && raw.working && s.inMs != null && s.outMs == null) return { inMs: s.inMs, outMs: s.inMs + REQ_PAIR_MS };
    return null;
  }).filter(function (s) { return s; });
}
/** 主管填的遲到分鐘（同 Code.gs applyManualLate 的讀法）：沒填、不是數字、負數＝null（沒有認定）；否則四捨五入的分鐘數 */
function reqLateGiven_(v) {
  var raw = String(v == null ? '' : v).trim();
  if (raw === '') return null;
  var n = Number(raw);
  return isFinite(n) && n >= 0 ? Math.round(n) : null;
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
/* 核定上班時段 vs 已核准、有填起訖的假單／出差單（2026-11-18 Eason 第 6 題）：同一段不能同時算上班和請假，任何重疊（容許 0 分鐘）都擋；
   剛好相接（假 09:00–11:00、上班 11:00 起）不算。leave 分頁沒有時段，只能比 requests 列的 start／end；沒填時段的單不比。
   跨夜：單上只有時鐘時間，同 reqStrictSlotOk_ 也試前一天／隔天（班表 22:00–06:00、事假 05:00–06:00＝隔天早上）。回不符的字句陣列。 */
function reqLeaveOverlapProbs_(date, okRows, periods) {
  var ps = (periods || []).filter(function (p) { return p && p.startMs != null && p.endMs != null && p.endMs > p.startMs; });
  var out = reqLeavePairProbs_(date, okRows);
  if (!ps.length) return out;
  (okRows || []).forEach(function (r) {
    if (r.kind !== 'leave' && r.kind !== 'trip') return;
    var a = reqHm_(r.start), b = reqHm_(r.end);
    if (!a || !b || a === b) return;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    var best = 0, hit = [];
    [0, -86400000, 86400000].forEach(function (d) {
      var tot = 0, h = [];
      ps.forEach(function (p) { var m = Math.min(p.endMs, e + d) - Math.max(p.startMs, s + d); if (m > 0) { tot += m; h.push(p); } });
      if (tot > best) { best = tot; hit = h; }
    });
    if (!(best > 0)) return;
    var what = r.kind === 'trip' ? '出差' : String(r.leave_type || '假');
    out.push('核定上班 ' + hit.map(function (p) { return reqOtPunchHm_(p.startMs) + '–' + reqOtPunchHm_(p.endMs); }).join('、') + ' 跟已核准的' + what + ' ' + a + '–' + b +
      ' 重疊 ' + Math.round(best / 60000) + ' 分鐘，同一段不能同時算上班和' + (r.kind === 'trip' ? '出差' : '請假') + '，請把上班時段改到' + (r.kind === 'trip' ? '出差單' : '假單') + '以外（要算上班就先作廢那張單）');
  });
  return out;
}
/* 同一天兩張已核准、有時段的假單／出差單互相重疊（2026-11-18 驗收）：登記的時數加總會把重疊那段算兩次（營運系統預填用聯集）→ 擋，請作廢或改其中一張。剛好相接不算。 */
function reqLeavePairProbs_(date, okRows) {
  var list = [];
  (okRows || []).forEach(function (r) {
    if (r.kind !== 'leave' && r.kind !== 'trip') return;
    var a = reqHm_(r.start), b = reqHm_(r.end);
    if (!a || !b || a === b) return;
    var s = reqHmMs_(date, a), e = reqHmMs_(date, b);
    if (e <= s) e += 86400000;
    list.push({ s: s, e: e, a: a, b: b, what: r.kind === 'trip' ? '出差' : String(r.leave_type || '假') });
  });
  var out = [];
  for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
    var m = Math.min(list[i].e, list[j].e) - Math.max(list[i].s, list[j].s);
    if (m > 0) out.push('已核准的' + list[i].what + ' ' + list[i].a + '–' + list[i].b + ' 跟' + list[j].what + ' ' + list[j].a + '–' + list[j].b + ' 時段重疊 ' + Math.round(m / 60000) + ' 分鐘，同一段不能請兩次，請作廢或改其中一張');
  }
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
/* ── 正職上班日滿 8 小時（2026-11-13 Eason 定案，REQ_FT8_FROM 預設 2026-11-01，指令碼屬性設 off＝整條關掉）──
   正職、班表上班日（W）：核定上班＋出差＋已核准假單（任何假別，含補休；看申請單，不看登記）≥ 8 小時，不滿就不能核定。
   正職且出勤日（sched_ft；支援帳號看原單位）、是不是支援帳號（sched_support）由營運系統伺服器讀排班與管理系統身分帶入，只有營運系統個人帳號代轉才採信；
   沒帶（舊值班核定頁、讀不到排班、央廚沒勾正職計時）＝這條不檢查。
   同一天兩家店（Eason 第 5 題＋D）：別家當天有打卡、還沒核定 → 先放行；別家已核定 → 兩家（上班＋出差＋假單）相加要滿 8。
   別家還沒核定（沒打卡）、只有已核准假單 → 這家＋假單相加要滿 8。別家沒核定也沒打卡、有已核准出差單 → 當成那家已核定出差那麼多小時
   （2026-11-23 Eason 定案＋同日複審後大腦裁示：滿 8 合計、超過 8 要加班單、跨店加班歸屬都跟那家已核定時一樣，不隨核定先後而變；
   原本「原單位只有出差單＋別單位支援有打卡」會兩邊互卡；別家已核定就用核定時數、不再加出差單，見 reqPeerAdd_）。
   加班算在被支援那家：知道這家是支援帳號（sched_support true）→ 加班單要有「兩家合計超過 8」那麼多；
   這家是原單位（false）→ 這家不用開加班單，改看被支援那家已核准的加班單夠不夠。 */
var REQ_FT8_FROM_DEFAULT_ = '2026-11-01';
var REQ_FT8_H = 8;
var REQ_FT8_STORE_NAMES_ = { gf: '小辛辣新竹光復', mztjs: '墨竹亭新竹金山', mztgf: '墨竹亭新竹光復', mztlzl: '墨竹亭台北六張犁', mztmc: '墨竹亭台中美村',
  mztrg: '墨竹亭內湖瑞光', mztwx: '墨竹亭台中文心', hq: '總部', cf: '中央廚房' };
function reqFt8StoreNames_(codes) { return codes.map(function (c) { return REQ_FT8_STORE_NAMES_[c] || c; }).join('、') || '別家店'; }
function reqFt8From_() {
  var v = '';
  try { v = String(reqProp_('REQ_FT8_FROM') || ''); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_FT8_FROM_DEFAULT_;
}
/** 別家店這個人這天：worked（有成功上班卡或已核定）、pending（有上班卡但還沒核定）、work（已核定上班＋出差）、leave（已核准假單）、ot（已核准加班單）、names（店代碼）；
 *  別家沒核定、沒打卡、有已核准出差單時才多 trip（時數，已算進 work）、tnames（店代碼）兩欄，by 那家多 trip（2026-11-23 Eason 定案）。
 *  REST_PEERS_ 依姓名對在職同仁（名冊用打卡快速通道同一份 6 小時快取；fresh＝不用快取）。只開名冊有同名在職同仁的店。
 *  鏡像列（mirror_src，總部從央廚抄來的）一律不看。讀不到的店當作還沒核定（先放行），不誤擋。（2026-11-13 審查修正） */
function reqPeerRoster_(p, fresh) {
  var memo = typeof READ_MEMO_ !== 'undefined' ? READ_MEMO_ : null, mk = 'rpr:' + p.ss;      // 只檢查一批：同一家店只問一次快取／打開一次（每人每家問一次，2026-11-14 加速）
  if (memo && !fresh && memo[mk]) return memo[mk];
  var cache = CacheService.getScriptCache(), ck = 'rpr:' + p.ss.slice(-12), hit = fresh ? null : cache.get(ck);
  if (hit) { var hr = { roster: JSON.parse(hit), ss: null }; if (memo) memo[mk] = hr; return hr; }
  var ss = SpreadsheetApp.openById(p.ss);
  var roster = readSheetAsObjects(ss.getSheetByName('roster')).rows
    .filter(function (r) { return String(r.active).toLowerCase() === 'true'; })
    .map(function (r) { return [restName_(r.name), String(r.emp_id)]; });
  try { cache.put(ck, JSON.stringify(roster), typeof REST_PEER_CACHE_S === 'undefined' ? 21600 : REST_PEER_CACHE_S); } catch (e) {}
  var out = { roster: roster, ss: ss };
  if (memo && !fresh) memo[mk] = out;
  return out;
}
/* 同一單位才相加（2026-11-18 Eason）：墨竹亭和總部同一單位、總部和小辛辣同一單位、小辛辣和墨竹亭不同單位。
   央廚、總部跟誰都算同一單位（同薪資門市表 support_group：CF／HQ＝*）。認不出的代碼當同一單位（照舊相加）。 */
function reqUnitOf_(code) {
  var c = String(code || '').toLowerCase();
  if (c === 'hq' || c === 'cf') return '*';
  if (c === 'gf') return 'sxl';
  if (/^mzt/.test(c)) return 'mzt';
  return '*';
}
function reqSameUnit_(a, b) { var x = reqUnitOf_(a), y = reqUnitOf_(b); return x === '*' || y === '*' || x === y; }
function reqSelfCode_(selfId) {
  if (!selfId || typeof REST_PEERS_ === 'undefined') return '';
  for (var i = 0; i < REST_PEERS_.length; i++) if (REST_PEERS_[i] && REST_PEERS_[i].ss === selfId) return String(REST_PEERS_[i].code || '');
  return '';
}
var REQ_PEER_MEMO_ = {};   // 同一次執行內共用（撤銷掃描、一次核定），Apps Script 每次執行都是新的
function reqPeerDay_(name, date, fresh) {
  var tP = Date.now();
  try { return reqPeerDayRaw_(name, date, fresh); } finally { if (typeof chkT_ === 'function') chkT_('peer', Date.now() - tP); }
}
function reqPeerDayRaw_(name, date, fresh) {
  var mk = name + '|' + date + (fresh ? '|f' : '');
  if (REQ_PEER_MEMO_[mk]) return REQ_PEER_MEMO_[mk];
  // 只檢查（一批，READ_MEMO_ 開著）才用 10 分鐘暫存（2026-11-14 Eason：量出光復正職每人 7～9.6 秒花在這裡）；
  // 真正送出核定、撤銷試算、fresh 重找一律重查別家店，不用暫存。讀不到別家（failed）的結果不存。
  var given = reqPeerGivenFor_(date);   // Mac mini 帶來的別家店摘要（只檢查一批才有；2026-11-15 核定前檢查加快 A）
  var useC = !given && !fresh && typeof READ_MEMO_ !== 'undefined' && !!READ_MEMO_, ck = 'rpd2:' + date + '|' + String(name).slice(0, 80), cache = null;
  if (useC) {
    try { cache = CacheService.getScriptCache(); var hit = cache.get(ck); if (hit) { REQ_PEER_MEMO_[mk] = JSON.parse(hit); return REQ_PEER_MEMO_[mk]; } } catch (e) { cache = null; }
  }
  var out = REQ_PEER_MEMO_[mk] = { worked: false, pending: false, failed: false, work: 0, leave: 0, ot: 0, names: [], by: {} };
  if (typeof REST_PEERS_ === 'undefined' || !REST_PEERS_.length || !name || typeof restName_ !== 'function') return out;
  var nm = restName_(name), selfId = '';
  try { selfId = getSS().getId(); } catch (e) {}
  var dayStart = Date.parse(date + 'T00:00:00+08:00'), dayEnd = dayStart + 86400000;
  var selfCode = reqSelfCode_(selfId);
  REST_PEERS_.forEach(function (p) {
    if (!p || !p.ss || p.ss === selfId) return;
    if (selfCode && !reqSameUnit_(selfCode, p.code)) return;   // 不同單位（小辛辣↔墨竹亭）不相加（2026-11-18 Eason）
    if (given && Object.prototype.hasOwnProperty.call(given, p.code)) {   // 這家的摘要 Mac mini 帶來了：不開這家的試算表
      if (typeof chkT_ === 'function') chkT_('peer_given', 1);
      var g = Object.prototype.hasOwnProperty.call(given[p.code], nm) ? given[p.code][nm] : null;
      if (g) reqPeerAdd_(out, p.code, g);
      return;
    }
    try {
      var rs = reqPeerRoster_(p, fresh);
      var ids = rs.roster.filter(function (r) { return r[0] === nm; }).map(function (r) { return r[1]; });
      if (ids.length !== 1) return;   // 沒有、或同一家有兩位同名（分不出是不是同一個人）都不算（2026-11-13 審查 5）
      var pm = typeof READ_MEMO_ !== 'undefined' ? READ_MEMO_ : null;
      var ss = rs.ss || (pm && pm['ss:' + p.ss]) || SpreadsheetApp.openById(p.ss);
      if (pm) { pm['ss:' + p.ss] = ss; rs.ss = ss; }
      var c = reqPeerOne_(ids, date, readEventsSince(ss.getSheetByName('events'), dayStart).rows,
        buildLatestApprovedMap(readSheetAsObjects(ss.getSheetByName('approved')).rows.filter(reqPeerMine_))[date] || {}, reqRows_(ss));
      if (c) reqPeerAdd_(out, p.code, c);
    } catch (e) { out.failed = true; Logger.log('滿 8 小時讀別家店 ' + p.code + ' 失敗（滿 8 小時先放行、加班照單店規則）：' + e); }
  });
  ['work', 'leave', 'ot'].forEach(function (k) { out[k] = Math.round(out[k] * 100) / 100; });
  if (out.trip) out.trip = Math.round(out.trip * 100) / 100;   // 別家還沒核定的已核准出差單（2026-11-23，見 reqPeerAdd_）；沒有就沒有這欄
  if (useC && cache && !out.failed) { try { cache.put(ck, JSON.stringify(out), typeof REQ_PEER_CACHE_S_ === 'undefined' ? 600 : REQ_PEER_CACHE_S_); } catch (e) { /* 暫存不進去只是下次慢一點 */ } }
  return out;
}
var REQ_PEER_CACHE_S_ = 600;   // 只檢查用的跨店暫存秒數（10 分鐘）
function reqPeerMine_(r) { return !String(r.mirror_src || '').trim(); }   // 不算總部鏡像列
/** 一家店、一位同仁（ids 只有一個員編）這天的情形：{w:有沒有算數的卡, r:幾筆已核定, work:核定時數合計, lv:已核准假單時數, ot:已核准加班時數}；都沒有回 null。
 *  這家還沒核定（r＝0）又有已核准出差單時多一欄 tp（出差單時數；2026-11-23 Eason 定案，見 reqPeerAdd_）；沒有就沒有這欄、回傳跟以前逐字相同。
 *  reqPeerDayRaw_（Google 自己開別家）與 reqPeerDigest_（別家自己算好給 Mac mini）共用，兩條路算法一模一樣。 */
function reqPeerOne_(ids, date, events, day, reqs) {
  var dayStart = Date.parse(date + 'T00:00:00+08:00'), dayEnd = dayStart + 86400000;
  // 這天在別家上班：上班卡打在這天，或忘了打上班卡、只有 06:00 以後的下班卡（跨夜班隔天凌晨的下班卡不算，2026-11-13 審查 8、9）
  var worked = events.some(function (e) {
    var t = new Date(String(normCellTs(e.ts))).getTime();
    return ids.indexOf(String(e.emp_id)) >= 0 && reqPeerMine_(e) && e.status === 'ok' && t < dayEnd && (String(e.type) === 'in' ? t >= dayStart : t >= dayStart + 6 * 3600000);
  });
  var recs = ids.map(function (id) { return day[id]; }).filter(Boolean);
  var lv = 0, ot = 0, work = 0, tp = 0;
  reqs.forEach(function (r) {
    if (ids.indexOf(String(r.emp_id)) < 0 || String(r.date) !== date || r.status !== 'approved' || !reqPeerMine_(r)) return;
    if (r.kind === 'ot') ot += Number(r.hours) || 0;
    else if (r.kind === 'leave') lv += Number(r.hours) || 0;
    else if (r.kind === 'trip') tp += Number(r.hours) || 0;   // 只認已核准（待審、退回、作廢、本人取消都不算）
  });
  if (recs.length) tp = 0;   // 這家已核定：核定時數已含登記的出差，不再另加出差單
  if (!worked && !recs.length && !lv && !tp) return null;
  var fs = null;
  recs.forEach(function (r) {
    work += Number(r.approved_hours) || 0;
    var m = /(\d{1,2}):(\d{2})/.exec(String(r.periods || ''));
    if (m) { var v = Number(m[1]) * 60 + Number(m[2]); if (fs === null || v < fs) fs = v; }
  });
  var res = { w: worked, r: recs.length, work: work, lv: lv, ot: ot, fs: fs };   // fs：這家核定最早的開始（分鐘），支援兩家時數一樣算後上班那家（2026-11-18）
  if (tp > 0) res.tp = tp;
  return res;
}
/* 別家還沒核定時，算它已核准的出差單（2026-11-23 Eason 定案）：別家這天沒核定、也沒打卡，只有已核准出差單（可另有假單）
   ＝當成那家已核定出差 tp 小時（主管原則「出差等同打卡」）：進 by[code].work、out.work、設 worked，所以「滿 8 小時」合計、
   超過 8 要加班單、跨店加班歸屬（reqFt8Split_）、ot_void 都跟那家已核定時一樣，不隨哪家先核而變（2026-11-23 複審擋項後大腦裁示）。
   不是 pending（不走「別家有卡還沒核定＝先放行」）。店代碼另記 out.tnames、時數 out.trip（訊息寫「◯◯出差單」），只有出差單的店不列在 names。
   別家已核定（c.r > 0）＝用核定時數（本來就含登記的出差），不再加；別家有卡還沒核定＝照舊先放行，不看出差單。
   出差單之後作廢不打回別家已核定的那天（維持只打回開單那家）。沒有出差單時這支跟以前逐字相同。 */
function reqPeerAdd_(out, code, c) {
  var tp = c.r > 0 || c.w ? 0 : Number(c.tp) || 0;
  if (tp > 0) { out.trip = (out.trip || 0) + tp; (out.tnames = out.tnames || []).push(code); }
  if (!(tp > 0) || Number(c.lv)) out.names.push(code);
  if (!out.by) out.by = {};
  out.by[code] = { work: c.r > 0 ? Math.round((Number(c.work) || 0) * 100) / 100 : tp, ot: Number(c.ot) || 0, pending: !(c.r > 0) && !!c.w, fs: c.fs == null || c.fs === '' || !isFinite(Number(c.fs)) ? null : Number(c.fs) };
  if (tp > 0) out.by[code].trip = tp;
  out.leave += Number(c.lv) || 0; out.ot += Number(c.ot) || 0;
  if (c.r > 0) { out.worked = true; out.work += Number(c.work) || 0; }
  else if (tp > 0) { out.worked = true; out.work += tp; }
  else if (c.w) { out.worked = true; out.pending = true; }
}
/* ── 別家店摘要由 Mac mini 帶來（2026-11-15 Eason「核定前檢查加快」A）──
   原本只檢查時每位正職要一家家打開別家店的試算表（平均 5 秒）。改成：每家店自己算好「這天每位同仁在本店的情形」（peer_day_digest），
   Mac mini 收著（有變動就重拿），只檢查時一起送來（peer_given：{店代碼: {日期, people}}）；有帶的店不再開，沒帶的店照舊自己開。
   只在只檢查一批（reqMgrApproveCheck_）採用；真正送出核定、撤銷試算一律照舊自己開別家店，不信任何帶來的資料。 */
var REQ_PEER_GIVEN_ = null;   // {date, by:{店代碼: people}}；reqMgrApproveCheck_ 期間才有值
function reqPeerGivenFor_(date) {
  var g = typeof REQ_PEER_GIVEN_ !== 'undefined' ? REQ_PEER_GIVEN_ : null;
  if (!g || g.date !== date || typeof READ_MEMO_ === 'undefined' || !READ_MEMO_) return null;
  return g.by;
}
function reqPeerGivenParse_(raw, date) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var by = {}, n = 0;
  Object.keys(raw).slice(0, 20).forEach(function (code) {
    var d = raw[code];
    if (!d || typeof d !== 'object' || d.date !== date || !d.people || typeof d.people !== 'object' || Array.isArray(d.people)) return;
    var people = {};
    Object.keys(d.people).slice(0, 500).forEach(function (nm) {
      var c = d.people[nm];
      if (!c || typeof c !== 'object') return;
      people[nm] = { w: c.w === true, r: Math.max(0, Math.floor(Number(c.r) || 0)), work: Number(c.work) || 0, lv: Number(c.lv) || 0, ot: Number(c.ot) || 0, fs: c.fs == null || c.fs === '' || !isFinite(Number(c.fs)) ? null : Number(c.fs) };
      if (Number(c.tp) > 0 && isFinite(Number(c.tp))) people[nm].tp = Number(c.tp);   // 別家還沒核定的已核准出差單（2026-11-23）；沒有就不加這欄
    });
    by[String(code)] = people; n++;
  });
  return n ? { date: date, by: by } : null;
}
/** {action:'peer_day_digest', mgr_key, date} → {ok, date, people:{名字（去空白）: {w, r, work, lv, ot}}}
 *  本店這天每位在職同仁的情形（同 reqPeerOne_）；名冊同名兩位以上的不放（分不出是誰，跟自己開別家時一樣不算）。唯讀。 */
function handlePeerDayDigest_(body) {
  if (!reqMgr_(body)) return { ok: false, error: 'unauthorized' };
  var date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  return { ok: true, date: date, people: reqPeerDigest_(getSS(), date) };
}
function reqPeerDigest_(ss, date) {
  var byName = {};
  readSheetAsObjects(ss.getSheetByName('roster')).rows.forEach(function (r) {
    if (String(r.active).toLowerCase() !== 'true') return;
    var nm = restName_(r.name);
    (byName[nm] = byName[nm] || []).push(String(r.emp_id));
  });
  var dayStart = Date.parse(date + 'T00:00:00+08:00');
  var events = readEventsSince(ss.getSheetByName('events'), dayStart).rows;
  var day = buildLatestApprovedMap(readSheetAsObjects(ss.getSheetByName('approved')).rows.filter(reqPeerMine_))[date] || {};
  var reqs = reqRows_(ss), people = {};
  Object.keys(byName).forEach(function (nm) {
    if (byName[nm].length !== 1) return;
    var c = reqPeerOne_(byName[nm], date, events, day, reqs);
    if (c) people[nm] = c;
  });
  return people;
}
/** 回 null（不適用）或 {probs:[{rule,text}], drop:[規則], otNeed, gap}。opt.peer 可直接給（測試用），沒給才讀別家店。
 *  sched_ft＝營運系統判斷「正職、這天是出勤日」（支援帳號看原單位的身分與班表）；這家班表是休息日／例假（H／R）照舊規則全算加班，不套。 */
function reqFt8_(date, approvedHours, otHave, opt, okRows) {
  var from = reqFt8From_(), sd = String(opt.sched_day || '');
  if (!from || date < from || opt.sched_ft !== true || sd === 'H' || sd === 'R') return null;
  // 假單時數看已核准的假單（11/11 以前核定時沒比對登記和單，不能只信登記的）；出差已經在核定時數裡
  var leaveH = Math.round((okRows || []).reduce(function (a, r) { return a + (r.kind === 'leave' ? Number(r.hours) || 0 : 0); }, 0) * 100) / 100;
  var trip = Number(opt.trip_hours) || 0, ownWork = Math.round(Number(approvedHours) * 100) / 100;
  var work = Math.round((ownWork - trip) * 100) / 100;
  var own = Math.round((ownWork + leaveH) * 100) / 100;
  var support = opt.sched_support === true, home = opt.sched_support === false;
  var out = { probs: [], drop: [], otNeed: 0, gap: 0 };
  var peer = opt.peer || null;
  var getPeer = function (fresh) { if (!peer || fresh) peer = reqPeerDay_(opt.name, date, fresh); return peer; };
  var f = reqBindFmt_, r2 = function (x) { return Math.round(x * 100) / 100; };
  if (own < REQ_FT8_H - 0.005) {
    var pr = getPeer();
    var tOnly = function (p) { return !!p.trip && !Object.keys(p.by || {}).some(function (k) { return !p.by[k].trip; }); };   // 別家只有「只有出差單」的店
    if ((!pr.worked || tOnly(pr)) && !pr.leave && !pr.failed && !opt.peer && !opt.preview) pr = getPeer(true);   // 擋之前不用快取再找一次（當天剛加的支援帳號）；撤銷試算不做（太慢）；別家只有出差單也照樣重找
    if (pr.failed) { /* 別家讀不到：滿 8 小時先放行 */ }
    else if (!pr.worked && !pr.leave) {
      out.gap = r2(REQ_FT8_H - own);
      out.probs.push({ rule: 'ft8', text: '正職上班日要滿 ' + REQ_FT8_H + ' 小時（上班 ' + f(work) + '＋出差 ' + f(trip) + '＋假單 ' + f(leaveH) + '＝' + f(own) +
        ' 小時），還差 ' + f(out.gap) + ' 小時，要有已核准的假單或補休單' });
    } else if (!pr.pending) {
      var ptp = Number(pr.trip) || 0;   // 別家還沒核定的已核准出差單（2026-11-23 Eason 定案，見 reqPeerAdd_；已算在 pr.work 裡）
      var comb = r2(own + pr.work + pr.leave);
      if (comb < REQ_FT8_H - 0.005) {
        out.gap = r2(REQ_FT8_H - comb);
        out.probs.push({ rule: 'ft8', text: '正職上班日要滿 ' + REQ_FT8_H + ' 小時：這家 ' + f(own) +
          ((pr.names || []).length || !ptp ? '＋' + reqFt8StoreNames_(pr.names) + ' ' + f(r2(pr.work - ptp + pr.leave)) : '') +
          (ptp ? '＋' + reqFt8StoreNames_(pr.tnames || []) + '出差單 ' + f(ptp) : '') +
          '＝' + f(comb) + ' 小時，還差 ' + f(out.gap) + ' 小時，要有已核准的假單或補休單' });
      }
    }
  }
  // 跨店加班歸屬（2026-11-18 Eason 改，取代 11-13）：同一天在原單位和支援單位都有上班（同一單位才相加，見 reqSameUnit_），
  //   兩家合計超過 8 小時的加班算支援單位，不分誰先上後上；支援單位最多吸收它自己上班的時數，超過的留在原單位（確認頁第 1 題 B）。
  //   支援兩家以上：只在支援單位之間比，時數較長的那家吸收；一樣長算後上班（核定最早開始較晚）的那家（第 2 題 A）。
  //   原單位：營運系統帶 sched_home（原單位的打卡店代碼）；這家是原單位（sched_support=false）＝自己。沒帶＝別家都當原單位（只有一家支援時結果一樣）。
  // 別家讀不到（failed）＝照單店規則，不拿掉任何加班檢查（2026-11-13 審查 1、3、4）
  if (support || home) {
    var p2 = getPeer(), tol = REQ_STRICT_TOL_MIN / 60 + 0.005;
    var tx = Number(p2.trip) > 0 ? '（含' + reqFt8StoreNames_(p2.tnames || []) + '出差單 ' + f(Number(p2.trip)) + ' 小時）' : '';   // 合計裡有別家還沒核定的出差單（2026-11-23）
    if (p2.worked && !p2.failed) {
      if (support) out.drop = ['ot_hours', 'ot_void', 'ot_in_sched'];
      else out.drop = ['ot_void'];      // 原單位：別家還沒核定前照單店規則；都核定了改下面看
      if (!p2.pending) {
        var x = reqFt8Split_(ownWork, opt, p2, support);
        out.cross = x;
        var hereNeed = x.here;
        if (home) out.drop = ['ot_void', 'ot_hours'];
        if (hereNeed > 0.005 && otHave + 0.005 < hereNeed) {
          out.otNeed = hereNeed;
          out.probs.push({ rule: 'ot_hours', text: '兩家上班合計 ' + f(x.comb) + ' 小時' + tx + '，超過 ' + REQ_FT8_H + ' 的部分要在這家' + (support ? '（被支援）' : '（原單位）') + '開 ' + f(hereNeed) + ' 小時加班單（已核准 ' + f(otHave) + ' 小時）' +
            (x.atSup > 0.005 && !x.selfAbs ? '；另外 ' + f(x.atSup) + ' 小時算在 ' + reqFt8StoreNames_([x.abs]) : '') });
        }
        if (otHave > hereNeed + tol) out.probs.push({ rule: 'ot_hours', text: '兩家上班合計 ' + f(x.comb) + ' 小時' + tx + '，這家應有的加班是 ' + f(hereNeed) + ' 小時，已核准的加班單 ' + f(otHave) + ' 小時太多，請作廢或改單' +
          (x.atSup > 0.005 && !x.selfAbs ? '（' + f(x.atSup) + ' 小時加班要開在 ' + reqFt8StoreNames_([x.abs]) + '）' : '') });
        if (!x.selfAbs && x.atSup > 0.005 && x.absOt + 0.005 < x.atSup) {
          out.probs.push({ rule: 'ot_peer', text: '兩家上班合計 ' + f(x.comb) + ' 小時' + tx + '，超過 ' + REQ_FT8_H + ' 的 ' + f(x.atSup) + ' 小時要在被支援的 ' + reqFt8StoreNames_([x.abs]) +
            ' 開加班單（那邊已核准 ' + f(x.absOt) + ' 小時）' });
        }
      }
    }
  }
  return out;
}
/** 跨店加班怎麼分（純函式，reqFt8_ 用）：ownWork＝這家核定（含出差）；opt.sched_home＝原單位代碼、opt.own_fs＝這家核定最早開始（分鐘）；
 *  p2.by＝別家每店 {work, ot, fs}；support＝這家是支援帳號。
 *  回 {comb 合計, need 超過 8, abs 吸收的支援店代碼（'' ＝這家）, selfAbs, atSup 支援店吸收, atHome 原單位, here 這家要開, absOt 吸收那家已核准加班}。 */
function reqFt8Split_(ownWork, opt, p2, support) {
  var r2 = function (x) { return Math.round(x * 100) / 100; };
  var by = (p2 && p2.by) || {}, codes = Object.keys(by);
  var comb = r2(ownWork + codes.reduce(function (a, c) { return a + (Number(by[c].work) || 0); }, 0));
  if (!codes.length) comb = r2(ownWork + (Number(p2 && p2.work) || 0));
  var need = Math.max(0, r2(comb - REQ_FT8_H));
  var homeCode = support ? String(opt.sched_home || '') : '';
  var sups = [];
  if (support) sups.push({ code: '', work: ownWork, fs: opt.own_fs == null ? null : Number(opt.own_fs), ot: 0 });
  codes.forEach(function (c) {
    if (support && (!homeCode || c === homeCode)) return;      // 支援帳號：原單位不比；沒帶原單位＝別家都當原單位（同 11-13）
    sups.push({ code: c, work: Number(by[c].work) || 0, fs: by[c].fs == null ? null : Number(by[c].fs), ot: Number(by[c].ot) || 0 });
  });
  if (!codes.length && !support) sups.push({ code: (p2 && p2.names && p2.names[0]) || '', work: Number(p2 && p2.work) || 0, fs: null, ot: Number(p2 && p2.ot) || 0 });
  var abs = null;
  sups.forEach(function (x) {
    if (!(x.work > 0)) return;
    if (!abs || x.work > abs.work + 0.005) { abs = x; return; }
    if (Math.abs(x.work - abs.work) <= 0.005 && x.fs != null && (abs.fs == null || x.fs > abs.fs)) abs = x;   // 一樣長：後上班那家
  });
  var atSup = abs ? r2(Math.min(need, abs.work)) : 0, atHome = r2(need - atSup);
  var selfAbs = !!abs && abs.code === '';
  var here = selfAbs ? atSup : (support ? 0 : atHome);
  return { comb: comb, need: need, abs: abs ? abs.code : '', selfAbs: selfAbs, atSup: atSup, atHome: atHome, here: r2(here), absOt: abs ? abs.ot : 0 };
}
/** 不能核定回 {ok:false, error:'need_request'|'need_diff_reason', message, ...}；可以回 null。
 *  opt：leaves、trip_hours、sched_day（H／R／W／空白）、diff_reason、acting（考勤管理個人帳號）；rows／force_strict／preview 給只讀試算用。 */
/* ── 加班單要有打卡佐證（2026-11-14 Eason：「加班單要綁定打卡紀錄，沒有打卡紀錄則無法核定當天出勤」）──
   每張已核准加班單的時段要整段落在當天某一段打卡裡（上班卡到下班卡），前後可差 REQ_STRICT_TOL_MIN 分鐘。
   算打卡的：這家店成功的卡（店長認定的重複卡已拿掉）＋已核准忘打卡單補的卡（審核中不算）；
   這家店沒蓋到時，再看同一天別家店的打卡（同名在職，同 Rest 跨店讀法）；讀不到別家＝當作沒打卡。
   出差日（有已核准出差單或核定登記出差時數）不看。開關：指令碼屬性 REQ_OT_PUNCH_FROM（預設 2026-11-15，off＝關）。 */
var REQ_OT_PUNCH_FROM_DEFAULT_ = '2026-11-15';
function reqOtPunchFrom_() {
  var v = '';
  try { v = String(reqProp_('REQ_OT_PUNCH_FROM') || '').trim(); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_OT_PUNCH_FROM_DEFAULT_;
}
function reqOtPunchHm_(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(11, 16); }
/** 卡（{t, type}）依時間配成段：上班卡接下一張下班卡（16 小時內）；回合併後的區間 [{s, e}]（相隔 15 分內併成一段） */
function reqOtPunchPair_(cards) {
  var tol = REQ_STRICT_TOL_MIN * 60000, out = [], open = null;
  cards.slice().sort(function (a, b) { return a.t - b.t || (a.type === b.type ? 0 : a.type === 'out' ? -1 : 1); }).forEach(function (c) {
    if (c.type === 'in') { open = c.t; return; }
    if (open != null && c.t >= open && c.t - open <= REQ_PAIR_MS) out.push({ s: open, e: c.t });
    open = null;
  });
  var merged = [];
  out.sort(function (a, b) { return a.s - b.s; }).forEach(function (x) {
    var last = merged[merged.length - 1];
    if (last && x.s <= last.e + tol) last.e = Math.max(last.e, x.e); else merged.push({ s: x.s, e: x.e });
  });
  return merged;
}
/** 這家店的卡：打卡段（inMs／outMs）＋已核准忘打卡單補的卡 */
function reqOtPunchCards_(date, segs, okRows) {
  var cards = [];
  (segs || []).forEach(function (x) {
    if (x.inMs != null) cards.push({ t: x.inMs, type: 'in' });
    if (x.outMs != null) cards.push({ t: x.outMs, type: 'out' });
  });
  var D = 86400000, virt = [];
  (okRows || []).forEach(function (r) {
    if (r.kind !== 'miss' || r.status !== 'approved') return;
    var st = reqHm_(r.start), en = reqHm_(r.end), mt = String(r.miss_type || '');
    if (mt === 'in' && st) virt.push({ t: reqHmMs_(date, st), type: 'in' });
    if (mt === 'out' && en) virt.push({ t: reqHmMs_(date, en), type: 'out', early: en <= REQ_EARLY_OUT_HM });
    if (mt === 'both' && st && en) { virt.push({ t: reqHmMs_(date, st), type: 'in' }); virt.push({ t: reqHmMs_(date, en) + (reqMin_(en) < reqMin_(st) ? D : 0), type: 'out' }); }
    if (mt === 'break' && st && en) { virt.push({ t: reqHmMs_(date, en), type: 'out' }); virt.push({ t: reqHmMs_(date, st) + (reqMin_(st) < reqMin_(en) ? D : 0), type: 'in' }); }
  });
  // 凌晨（06:00 前）補的下班卡：那天有比它晚的上班卡＝是跨夜班的下班，算隔天（同 reqMissVirtual_）
  var all = cards.concat(virt);
  virt.forEach(function (c) {
    if (c.early && all.some(function (o) { return o.type === 'in' && o.t > c.t; })) c.t += D;
  });
  return cards.concat(virt.map(function (c) { return { t: c.t, type: c.type }; }));
}
function reqOtPunchFits_(date, start, end, ivs) {
  var s = reqHmMs_(date, start), e = reqHmMs_(date, end), tol = REQ_STRICT_TOL_MIN * 60000;
  if (isNaN(s) || isNaN(e)) return false;
  if (e <= s) e += 86400000;
  var fit = function (x, y) { return ivs.some(function (m) { return x >= m.s - tol && y <= m.e + tol; }); };
  return fit(s, e) || fit(s + 86400000, e + 86400000);
}
/** 回 [{rule:'ot_punch', text}]。peerCards（測試用）＝別家店的卡 [{ts, type, status, store}]，沒帶就讀 restPeerEvents_ */
function reqOtPunchProbs_(date, otRows, segs, okRows, name, peerCards) {
  var ivs = reqOtPunchPair_(reqOtPunchCards_(date, segs, okRows));
  var peer = null, peerIvs = function () {
    if (peer) return peer;
    var ev = peerCards;
    if (!ev) {
      ev = [];
      try { if (typeof restPeerEvents_ === 'function' && name) ev = restPeerEvents_(name, new Date(date + 'T00:00:00+08:00').getTime()); } catch (e) { ev = []; }
    }
    var by = {};
    ev.forEach(function (x) {
      if (String(x.status) !== 'ok') return;
      var t = new Date(String(x.ts)).getTime();
      if (isNaN(t)) return;
      (by[x.store] = by[x.store] || []).push({ t: t, type: String(x.type) });
    });
    peer = [];
    Object.keys(by).forEach(function (k) { peer = peer.concat(reqOtPunchPair_(by[k])); });
    return peer;
  };
  var shown = (segs || []).filter(function (x) { return x.inMs != null || x.outMs != null; }).map(function (x) {
    return (x.inMs != null ? reqOtPunchHm_(x.inMs) : '？') + '–' + (x.outMs != null ? reqOtPunchHm_(x.outMs) : '？');
  });
  var missN = (okRows || []).filter(function (r) { return r.kind === 'miss' && r.status === 'approved'; }).length;
  var probs = [];
  otRows.forEach(function (r) {
    var a = String(r.start), b = String(r.end);
    if (reqOtPunchFits_(date, a, b, ivs)) return;
    if (reqOtPunchFits_(date, a, b, peerIvs())) return;
    probs.push({ rule: 'ot_punch', text: '加班單 ' + a + '–' + b + ' 沒有打卡紀錄（' + (shown.length ? '當天打卡：' + shown.join('、') : '當天沒有打卡') +
      (missN ? '，另有已核准忘打卡單 ' + missN + ' 張' : '') + '），請先補忘打卡單、店長核准後再核定，或把加班單改成有打卡的時段' });
  });
  return probs;
}
function reqBindCheck_(ss, empId, date, approvedHours, periods, segs, breakWindow, opt) {
  opt = opt || {};
  periods = periods || [];
  var from = reqBindFrom_(), strictFrom = reqStrictFrom_();
  var bindOn = !!(from && date >= from && periods.length);
  var strict = !!opt.force_strict || !!(from && strictFrom && date >= strictFrom);
  var ft8On = !!(reqFt8From_() && date >= reqFt8From_() && opt.sched_ft === true);   // 滿 8 小時不跟綁單／加嚴的開關走（2026-11-13 審查 4、11）
  var otPunchOn = !!opt.force_ot_punch || !!(from && reqOtPunchFrom_() && date >= reqOtPunchFrom_());   // REQ_BIND_FROM off＝全關，這條也關
  if (!bindOn && !strict && !ft8On && !otPunchOn) return null;
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
      // 班表那段排了休息（break_min）卻沒休息改上班：那段可以開等長的加班單（Eason 2026-11-14）。休息分鐘由同一段內的加班單依序共用
      var brkLeft = spans.map(function (x) { return Math.max(0, Math.round(Number(x.break_min) || 0)); });
      if (spans.length) otRows.forEach(function (r) {
        var by = reqOtInSchedBySpan_(String(r.start), String(r.end), spans);
        var inMin = by.reduce(function (a, m, i) { var use = Math.min(m, brkLeft[i]); brkLeft[i] -= use; return a + m - use; }, 0);
        if (inMin > REQ_STRICT_TOL_MIN && !peerDay()) add('ot_in_sched', '加班單 ' + r.start + '–' + r.end + ' 有 ' + inMin + ' 分鐘在班表上班時段內（' + spans.map(function (x) { return x.start + '–' + x.end + (Number(x.break_min) > 0 ? '，含休息 ' + Math.round(Number(x.break_min)) + ' 分' : ''); }).join('、') + '），班表內是正常上班，不能算加班（沒休息的時間可以開，最多到班表排的休息分鐘），請改成實際加班的時段');
      });
    }
  } else if (bindOn && otNeed > 0.005 && otHave + 0.005 < otNeed) {   // bindOn：只有滿 8 小時開著時（綁單關或沒時段）不跑舊規則
    otBad = true;
    add('ot_hours', '超過 ' + REQ_BIND_OT_BASE_H + ' 小時的 ' + reqBindFmt_(otNeed) + ' 小時要有加班單（已核准 ' + reqBindFmt_(otHave) + ' 小時）');
  }
  // 加班單要有打卡佐證（2026-11-14 Eason）：每張已核准加班單的時段要落在當天的打卡段裡（前後可差 15 分）；出差日不看
  if (otPunchOn && otRows.length && !(Number(opt.trip_hours) > 0) && !ok.some(function (r) { return r.kind === 'trip'; })) {
    reqOtPunchProbs_(date, otRows, reqWorkingSegs_(segs || [], date) || [], ok, String(opt.name || (otRows[0] || {}).name || ''), opt.peer_cards).forEach(function (p) { add(p.rule, p.text); });
  }
  var miss = bindOn ? reqBindMissCards_(periods, reqWorkingSegs_(segs, date), breakWindow) : 0;
  var missHave = ok.reduce(function (a, r) { return a + (r.kind !== 'miss' ? 0 : (r.miss_type === 'break' || r.miss_type === 'both') ? 2 : 1); }, 0);
  var tripOk = ok.some(function (r) { return r.kind === 'trip'; });
  // 出差日：當天有打卡、湊不成完整一段就算忘刷，要忘打卡單；整天沒打卡、或打卡都成段（另一段是出差）不算（2026-11-10 Eason）
  var loneCard = (segs || []).some(function (s) { return (s.inMs == null) !== (s.outMs == null); });   // 有上班沒下班、有下班沒上班
  var missBad = bindOn && !(tripOk && !loneCard) && miss > missHave;   // 出差日只有「湊不成完整一段的卡」才要忘打卡單
  // 2026-11-18 驗收 A：缺的卡其實是「核定時段跟已核准加班單之間沒接上」（同一段打卡中間沒核定）→ 白話講怎麼改，不叫人開忘打卡單；真的少打卡照舊
  var otGaps = missBad ? reqOtGapHints_(date, otRows, periods, reqWorkingSegs_(segs, date) || []) : [];
  if (missBad && otGaps.length && miss - missHave <= 2 * otGaps.length) { otGaps.forEach(function (t) { add('ot_gap', t); }); missBad = false; }
  else if (missBad) add('miss', '少了 ' + miss + ' 張打卡，要有忘打卡單（已核准 ' + missHave + ' 張）');
  if (strict) reqStrictLeaveProbs_(ok, opt.leaves).forEach(function (t) { add('leave', t); });
  if (strict) reqLeaveOverlapProbs_(date, ok, periods).forEach(function (t) { add('leave_overlap', t); });   // 2026-11-18 Eason：核定上班不能跟已核准假單／出差單時段重疊
  // 正職上班日滿 8 小時＋跨店加班算被支援那家（2026-11-13 Eason，見 reqFt8_ 檔頭）
  var ft8 = reqFt8_(date, approvedHours, otHave, opt, ok);
  if (ft8) {
    if (ft8.drop.length) { probs = probs.filter(function (p) { return ft8.drop.indexOf(p.rule) < 0; }); if (!ft8.otNeed) otBad = false; }   // 跨店：加班單照兩家合計重算（下面）
    if (ft8.otNeed) { otBad = true; otNeed = ft8.otNeed; }
    ft8.probs.forEach(function (p) { add(p.rule, p.text); });
  }
  var diffMin = strict ? reqPunchDiffMin_(periods, segs, breakWindow) : null;
  // 2026-11-14 Eason「打卡＋單＝核定時數」：不再「差 30 分鐘寫原因」，只看核定比打卡多（沒打卡卻要算的時間），要有單；早到晚走不算、不用原因
  // 已核准的忘打卡單補的卡算「有打卡」（2026-11-15 Eason：游家輝 11/11 忘打卡單補 18:30–20:15 仍被算成整段沒打卡；
  // 同營運系統 core-calc.js 的「打卡＋單」）。只用在這條「核定比打卡多」，其他檢查照舊看真的卡
  var segsMiss = strict ? reqSegsWithMiss_(segs || [], ok, date) : null;
  var overMin = strict ? reqOverCreditMin_(periods, segsMiss, breakWindow, reqLateGiven_(opt.late_min), reqLeaveBackMs_(date, ok).concat(reqSchedStartMs_(date, opt.sched_spans)), reqLeaveStartMs_(date, ok).concat(reqSchedMidEndMs_(date, opt.sched_spans)),
    reqGapLateMs_(date, periods, segsMiss, opt.sched_spans, breakWindow, ok)) : null;   // 2026-11-18：中間假單結束後晚回來算遲到（backs）；2026-11-20：二段班中途離開的空檔算遲到（最後一個參數）
  // 2026-11-21 舊問題 1：有沒配對的卡、忘打卡單那條又沒擋到 → 用完整打卡段（＋已核准忘打卡單補的卡）照算，不再整個跳過（見 reqLoneOverOn_ 檔頭）
  if (strict && overMin == null && !(bindOn && miss > missHave) && periods.length && reqLoneOverOn_()) {
    var segsKnown = reqOverSegsKnown_(segsMiss, segs);
    if (segsKnown.length) overMin = reqOverCreditMin_(periods, segsKnown, breakWindow, reqLateGiven_(opt.late_min), reqLeaveBackMs_(date, ok).concat(reqSchedStartMs_(date, opt.sched_spans)), reqLeaveStartMs_(date, ok).concat(reqSchedMidEndMs_(date, opt.sched_spans)),
      reqGapLateMs_(date, periods, segsKnown, opt.sched_spans, breakWindow, ok));
  }
  if (overMin != null && overMin >= REQ_STRICT_DIFF_MIN) add('over_credit', '核定比打卡多 ' + overMin + ' 分鐘（沒有打卡的時間要有忘打卡單、假單或補休單）');
  if (opt.preview) return { probs: probs, diff_min: diffMin, over_min: overMin, ot_have: otHave, ot_need: otNeed, ft8_gap: ft8 ? ft8.gap : 0 };
  if (probs.length) {
    var noLine = false;
    try { noLine = reqNoLine_(findRosterByEmpId(readSheetAsObjects(ss.getSheetByName('roster')).rows, empId)); } catch (e) {}   // 只在要擋的時候才讀名冊；讀不到照一般字句
    // 真的缺單（缺加班單、缺忘打卡單、正職不足、核定比打卡多）才請同仁補申請；其他（加班單時段不對、假別對不上…）是要調時段或處理那張單（2026-11-14）
    var needDoc = otBad || missBad || probs.some(function (p) { return /^ft8/.test(p.rule) || p.rule === 'over_credit'; });
    var hint = pend.length ? '這天有 ' + pend.length + ' 張申請還在審核中，請先到「申請審核」處理再送。' + (noLine ? '這位同仁沒綁 LINE，還缺別張單可以繼續代開。' : '')
      : !needDoc ? '請照上面調整核定時段，或處理那張單。'
      : noLine ? '這位同仁沒綁 LINE，請店長在考勤管理「代開申請」，送總監層級審核。'
      : '請同仁在 LINE「加班請假」補申請；超過 4 天（11/28 以前 11 月的日子不限）請店長在考勤管理「代開申請」，送總監層級審核。';
    // 2026-11-11（B35）：少卡、而那天有新手機待核准的卡（舊連結才會有）——出路是先核准裝置，不是補忘打卡單
    // 待核准的張數補得齊缺的張數才說「不用補」；補不齊就講核准後還少幾張，補申請的指引照留（獨立審查補）
    if (missBad && opt.pending_device > 0) {
      var stillMiss = miss - missHave - opt.pending_device;
      hint = '這天有 ' + opt.pending_device + ' 張新手機待核准的打卡，請先到「待核准裝置」核准這支手機' +
        (stillMiss > 0 ? '；核准後還少 ' + stillMiss + ' 張，' + hint
          : '，再回來核定（核准後就不用補忘打卡單）。' + (otBad || pend.length ? hint : ''));
    }
    return { ok: false, error: 'need_request', message: '這天還不能核定：' + probs.map(function (p) { return p.text; }).join('；') + '。' + hint,
             need: { ot_hours: otBad ? otNeed : 0, ot_have: otHave, miss_cards: missBad ? miss : 0, miss_have: missHave, pending: pend.length, leave_hours: ft8 ? ft8.gap : 0, over_min: overMin || 0 },
             probs: probs.map(function (p) { return { rule: p.rule, text: p.text }; }), need_doc: !!needDoc, hint: hint };      // 營運系統逐條顯示用（2026-11-14）
  }
  // 每一張打卡跟核定時間差超過 30 分鐘要寫原因（2026-11-16 Eason；REQ_CARD_REASON_FROM 預設 2026-11-17 起的日子，off＝關）。
  // 取代 11/14「不再寫原因」：缺單照上面擋（寫原因不能代替補單），單都齊了才看這條。原因存 approved 的 diff_reason
  var cardFrom = reqCardReasonFrom_();
  if (from && cardFrom && date >= cardFrom && periods.length) {
    var cards = reqCardDiffs_(periods, segs || [], reqLateGiven_(opt.late_min));
    if (cards.length && !reqCleanDiffReason_(opt.diff_reason)) {
      return { ok: false, error: 'need_diff_reason', cards: cards, diff_min: cards.reduce(function (a, c) { return Math.max(a, c.min); }, 0),
               message: '核定和打卡差超過 ' + REQ_CARD_DIFF_MIN + ' 分鐘：' + cards.map(function (c) { return (c.side === 'in' ? '上班卡 ' : '下班卡 ') + c.card + '（核定 ' + c.core + '，差 ' + c.min + ' 分）'; }).join('、') +
                 '，每張卡要選原因才能送出。' + (opt.acting === false ? '舊的值班核定頁不能填原因，請到管理系統「考勤管理」核定。' : '') };
    }
  }
  return null;
}
/* ── 每張卡跟核定時間比（2026-11-16 Eason：「每一次打卡時間跟核定時間相差超過 30 分鐘以上，都需要填寫原因」；剛好 30 分不用，第 7 題 B）──
   一段打卡（上班卡到下班卡）對到跟它重疊的核定時段：上班卡比最早那段的開始、下班卡比最晚那段的結束（央廚、總部中午不打卡的休息帶自然跨過去）。
   這段打卡完全沒被核定（例：早到那段整段不算）：上班卡比最近的核定開始、下班卡比最近的核定結束。只有單邊的卡（缺卡）只比有的那邊。
   遲到：核定從班表開始（標遲到扣薪），上班卡跟核定差超過 30 分一樣要原因（Eason：「是卡核定時間比對打卡紀錄，不是比對班表」）。 */
var REQ_CARD_REASON_FROM_DEFAULT_ = '2026-11-01';   // 2026-11-18 Eason「卡差 30 分起算日維持 11/1」（原本 11/17）；指令碼屬性 REQ_CARD_REASON_FROM 有設值仍優先
var REQ_CARD_DIFF_MIN = 30;
function reqCardReasonFrom_() {
  var v = '';
  try { v = String(reqProp_('REQ_CARD_REASON_FROM') || ''); } catch (e) {}
  if (v === 'off') return null;
  return reqIsDate_(v) ? v : REQ_CARD_REASON_FROM_DEFAULT_;
}
/* 2026-11-18 Eason「遲到超過 30 分鐘要選原因」拿掉（大腦解讀，整條規則保留）：已經記成遲到／早退的那段差額不用再選原因——
   上班卡晚於對到的核定開始（computeApprovalStatus 照記「遲到N分」）、下班卡早於對到的核定結束（照記「早退N分」）不算卡差；
   主管自己填遲到分鐘（lateGiven）時，只有他認的分鐘算已涵蓋（依卡片順序用掉），沒涵蓋的部分超過 30 分仍要原因。
   仍然要原因：上班卡比核定早很多（早到不認列）、下班卡比核定晚很多（多打的不認列）、那段打卡完全沒被核定（沒有遲到早退可記）。 */
function reqCardDiffs_(periods, segs, lateGiven) {
  var ps = (periods || []).filter(function (p) { return p && p.startMs != null && p.endMs != null && p.endMs > p.startMs; });
  if (!ps.length) return [];
  var hm = function (t) { var d = new Date(t + 8 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); };      // 台北時間（不靠 Utilities，測試沙盒也能跑）
  var near = function (t, key) { return ps.reduce(function (a, p) { return a == null || Math.abs(p[key] - t) < Math.abs(a - t) ? p[key] : a; }, null); };
  var out = [], lateLeft = lateGiven == null ? null : Math.max(0, Number(lateGiven) || 0);
  (segs || []).forEach(function (s) {
    if (!s) return;
    var a = s.inMs, b = s.outMs, st = null, en = null;
    if (a != null && b != null) {
      var ov = ps.filter(function (p) { return Math.min(b, p.endMs) > Math.max(a, p.startMs); });
      if (ov.length) { st = Math.min.apply(null, ov.map(function (p) { return p.startMs; })); en = Math.max.apply(null, ov.map(function (p) { return p.endMs; })); }
    }
    if (a != null) {
      var cs = st != null ? st : near(a, 'startMs'), d1 = Math.round(Math.abs(a - cs) / 60000), left1 = d1;
      if (st != null && a > cs) { var cov = lateLeft == null ? d1 : Math.min(d1, lateLeft); if (lateLeft != null) lateLeft -= cov; left1 = d1 - cov; }      // 晚到＝記成遲到的部分不算
      if (left1 > REQ_CARD_DIFF_MIN) out.push({ side: 'in', card: hm(a), core: hm(cs), min: d1 });
    }
    if (b != null) {
      var ce = en != null ? en : near(b, 'endMs'), d2 = Math.round(Math.abs(b - ce) / 60000);
      if (!(en != null && b < ce) && d2 > REQ_CARD_DIFF_MIN) out.push({ side: 'out', card: hm(b), core: hm(ce), min: d2 });      // 早走＝記成早退，不算
    }
  });
  return out;
}

/* ── 已核定但缺單的日子打回待核定（2026-11-13 Eason：11/1–11/5 也要有單，已核定的要重新核定）──
   {action:'bind_revoke', admin_key, from, to, apply?}
   用核定綁單的同一支判斷（reqBindCheck_，不套核定加嚴）找出「超過 8 小時沒有已核准加班單」或「少卡沒有已核准忘打卡單」的已核定日。
   apply 沒帶＝只讀試算；apply:true＝把那幾天 approved 的列整批搬到 approved_revoked 分頁（留底、可復原），那天回到待核定。
   只收 REQ_STRICT_FROM 之前的日子（加嚴之後送出時本來就擋）。請假分頁不動，主管重送核定時照常取代。總部的鏡像列（mirror_src 有值）不看。 */
var BIND_REVOKE_SHEET_ = 'approved_revoked';
function bindRevokeScan_(ss, from, to, cand) {
  var rows = reqRows_(ss), items = [];
  var approvedMap = buildLatestApprovedMap(readSheetAsObjects(ss.getSheetByName('approved')).rows);
  var events = dropDupIgnored_(readSheetAsObjects(ss.getSheetByName('events')).rows, dupIgnoreSet_(approvedMap));
  var lsh = ss.getSheetByName('leave');
  var leaveRows = lsh ? readSheetAsObjects(lsh).rows : [];
  var scanned = 0;
  Object.keys(approvedMap).forEach(function (date) {
    if (date < from || date > to) return;
    Object.keys(approvedMap[date]).forEach(function (emp) {
      var cd = cand ? cand[date + '|' + emp] : null;
      if (cand && !cd) return;   // 滿 8 小時：只看營運系統給的候選（正職、班表上班日）
      var rec = approvedMap[date][emp], name = String(rec.name || '').trim();
      if (String(rec.mirror_src || '').trim()) return;   // 總部從別店抄來的鏡像列：申請單不抄、隔天又會抄回來，看原店就好
      var periods = parsePeriodsStr(rec.periods).map(function (p) {
        var st = reqHmMs_(date, p.start), en = reqHmMs_(date, p.end);
        return { startMs: st, endMs: en <= st ? en + 86400000 : en };
      });
      if (!periods.length && !cand) return;   // 整天請假／整天出差沒有時段，綁單本來就不看（滿 8 小時要看：整天只請 4 小時假也算不滿）
      var leaves = leaveRows.filter(function (r) { return normCellDate(r['日期']) === date && String(r['姓名'] || '').trim() === name; })
        .map(function (r) { return { type: String(r['假別'] || ''), hours: r['時數'] === '' ? '' : Number(r['時數']) }; });
      var trip = leaves.reduce(function (a, x) { return a + (x.type === '出差' ? Number(x.hours) || 0 : 0); }, 0);
      var punchDay = dayPunchSegments(events, emp, date);
      var segs = punchDay ? punchDay.segments.map(function (x) {
        return { inMs: x.in ? reqHmMs_(date, x.in) : null, outMs: x.out ? reqHmMs_(x.cross ? addDaysStr(date, 1) : date, x.out) : null };
      }) : [];
      if (punchDay && typeof markWorkingSeg_ === 'function') markWorkingSeg_(punchDay, date, segs);
      scanned++;
      var r = reqBindCheck_(ss, emp, date, Number(rec.approved_hours) || 0, periods, segs, noPunchBreakWindow(date),
        cand ? { leaves: leaves, trip_hours: trip, rows: rows, preview: true, name: name, sched_ft: true, sched_day: 'W', sched_support: typeof cd.support === 'boolean' ? cd.support : null }
             : { leaves: leaves, trip_hours: trip, rows: rows, preview: true });
      var probs = r ? r.probs.filter(function (p) { return cand ? p.rule === 'ft8' : (p.rule === 'ot_hours' || p.rule === 'miss'); }) : [];
      if (probs.length) items.push({ date: date, emp_id: emp, name: name, hours: Number(rec.approved_hours) || 0,
        periods: String(rec.periods || ''), manager_name: String(rec.manager_name || ''), probs: probs.map(function (p) { return p.text; }) });
    });
  });
  items.sort(function (a, b) { return (a.date + '|' + a.emp_id).localeCompare(b.date + '|' + b.emp_id); });
  return { scanned: scanned, items: items };
}
/* 滿 8 小時撤銷（2026-11-13 Eason 第 4、6 題）：{action:'ft8_revoke', admin_key, items:[{emp_id, date, support?}], apply?}
   items＝營運系統依排班算出的「正職、班表上班日」候選（打卡端不知道誰是正職）；用 reqBindCheck_ 預覽只挑 ft8 不滿的，
   apply 照 bind_revoke 把 approved 列搬到 approved_revoked 留底，那天回待核定。沒有 strict_range 限制（規則上線前核定的都要看）。 */
function handleFt8Revoke_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!reqFt8From_()) return { ok: false, error: 'ft8_off', message: '滿 8 小時已關閉（REQ_FT8_FROM=off）' };
  if (!Array.isArray(body.items) || body.items.length > 5000) return { ok: false, error: 'bad_items' };
  var cand = {}, from = '9999-12-31', to = '0000-01-01';
  for (var i = 0; i < body.items.length; i++) {
    var it = body.items[i] || {}, d = String(it.date || ''), e = (typeof it.emp_id === 'string' || typeof it.emp_id === 'number') ? String(it.emp_id || '') : '';   // 員編只收文字或數字（2026-11-16）
    if (!reqIsDate_(d) || !e || d < reqFt8From_()) return { ok: false, error: 'bad_items', message: '第 ' + (i + 1) + ' 筆日期或員編不對' };
    cand[d + '|' + e] = { support: typeof it.support === 'boolean' ? it.support : null };
    if (d < from) from = d; if (d > to) to = d;
  }
  if (!body.items.length) return { ok: true, apply: body.apply === true, scanned: 0, items: [], moved: 0 };
  return bindRevokeRun_(from, to, cand, body.apply === true);
}
function handleBindRevoke_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var from = String(body.from || ''), to = String(body.to || '');
  if (!reqIsDate_(from) || !reqIsDate_(to) || from > to) return { ok: false, error: 'bad_date' };
  var bindFrom = reqBindFrom_(), strictFrom = reqStrictFrom_();
  if (!bindFrom) return { ok: false, error: 'bind_off', message: '核定綁單已關閉（REQ_BIND_FROM=off）' };
  if (from < bindFrom) return { ok: false, error: 'before_bind', message: '起日早於核定綁單起算日 ' + bindFrom };
  if (strictFrom && to >= strictFrom) return { ok: false, error: 'strict_range', message: '只收 ' + strictFrom + ' 以前的日子（之後送出時本來就擋）' };
  return bindRevokeRun_(from, to, null, body.apply === true);
}
/* 店切 mini 核定後不在 Google 直接套用撤銷（2026-11-21 大腦定案；bind_revoke、ft8_revoke 的 apply:true）：
   切 mini 後核定正本在 mini，Google 這邊把已核定日搬走會讓兩邊不一致。只預覽（apply 沒帶／false）不擋。
   保護性檢查，三種情況擋、一種放：
   - DUTY_AUTH＝mini／on → moved_to_mini（要做先用 auth_cfg 把該店切回 google）。
   - DUTY_AUTH 填了認不得的值 → auth_unknown（核定照 P1 留在 Google，但撤銷這種搬資料的動作先不做，值改正再做）。
   - 讀不到指令碼屬性 → auth_unknown（不知道是不是 mini，先不搬）。
   - 沒設、空、google／off／shadow → 放行，跟原本一模一樣。
   舊 DutyFeed.gs 沒有 dutyAuthCfgOf_（沒有 mini 模式）→ 放行。在 bindRevokeRun_ 拿到指令碼鎖之後查，跟 auth_cfg 切換互斥。
   2026-11-21 補洞（gate-holes）：同一套判斷也擋 final_orphan_scan（舊資料清理）、backfill_missing_groups（少刷回填，Code.gs）的套用；
   what＝訊息裡的動作名稱（撤銷的訊息逐字不變）。契約 docs/contract-writeback.md 第 11 節。 */
function reqMiniApplyBlock_(what) {
  if (typeof dutyAuthCfgOf_ !== 'function') return null;
  var all;
  try { all = PropertiesService.getScriptProperties().getProperties() || {}; }
  catch (e) { return { ok: false, error: 'auth_unknown', message: '讀不到核定模式設定，先不套用' + what + '，請稍後再試（只預覽照常可用）' }; }
  var m = dutyAuthCfgOf_(all);
  if (m.mini) return { ok: false, error: 'moved_to_mini', message: '這家店的核定已移到 mini，Google 端不能直接套用' + what + '；要做請先把該店切回 google（auth_cfg）。只預覽照常可用' };
  if (m.unknown) return { ok: false, error: 'auth_unknown', message: '指令碼屬性 DUTY_AUTH 的值認不得，先不套用' + what + '；請用 auth_cfg 改正後再做（只預覽照常可用）' };
  return null;
}
function reqRevokeMiniBlock_() { return reqMiniApplyBlock_('撤銷'); }
/* 薪資鎖月後不可以再動（2026-11-15）：管理金鑰的打回工具（bind_revoke、ft8_revoke）也不搬鎖定月的核定。
   試算：鎖定月的那幾筆照樣列出、標 pay_locked:true；apply：只搬沒鎖的，鎖定月的列在回應的 pay_locked（帶 message），要搬先到薪資頁解鎖。 */
function bindRevokeRun_(from, to, cand, apply) {
  var ss = getSS();
  var isLocked = function (it) { return typeof payLockedFor_ === 'function' && payLockedFor_(it.date, ss) === true; };
  if (!apply) {
    var pv = bindRevokeScan_(ss, from, to, cand);
    pv.items.forEach(function (it) { if (isLocked(it)) it.pay_locked = true; });
    return { ok: true, apply: false, from: from, to: to, scanned: pv.scanned, items: pv.items };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'busy' };
  try {
    var miniBlock = reqRevokeMiniBlock_();   // 2026-11-21：店切 mini 後不套用（見 reqRevokeMiniBlock_）
    if (miniBlock) return miniBlock;
    var scan = bindRevokeScan_(ss, from, to, cand);   // 鎖內重算，避免剛好有人重送核定
    var lockedItems = scan.items.filter(isLocked);
    if (lockedItems.length) {
      scan.items = scan.items.filter(function (it) { return !isLocked(it); });
      var lockedOut = { pay_locked: lockedItems.map(function (it) { return { date: it.date, emp_id: it.emp_id, name: it.name }; }), message: payLockedMgrMsg_(lockedItems[0].date) };
      if (!scan.items.length) return Object.assign({ ok: true, apply: true, from: from, to: to, scanned: scan.scanned, items: [], moved: 0 }, lockedOut);
    }
    if (!scan.items.length) return { ok: true, apply: true, from: from, to: to, scanned: scan.scanned, items: [], moved: 0 };
    var hit = {};
    scan.items.forEach(function (it) { hit[it.date + '|' + it.emp_id] = it; });
    var sh = ss.getSheetByName('approved');
    var vals = sh.getDataRange().getValues(), head = vals[0];
    var iDate = head.indexOf('date'), iEmp = head.indexOf('emp_id');
    if (iDate < 0 || iEmp < 0) return { ok: false, error: 'bad_sheet' };
    var bak = ss.getSheetByName(BIND_REVOKE_SHEET_);
    if (!bak) { bak = ss.insertSheet(BIND_REVOKE_SHEET_); bak.appendRow(head.concat(['revoked_at', 'revoke_reason'])); }
    var now = nowTaipeiIso(), drop = [];
    for (var i = vals.length - 1; i >= 1; i--) {
      var it = hit[normCellDate(vals[i][iDate]) + '|' + String(vals[i][iEmp])];
      if (!it) continue;
      var keep = vals[i].slice(0, head.length); while (keep.length < head.length) keep.push('');   // 留底欄位對齊表頭
      drop.push({ row: i + 1, vals: keep, reason: it.probs.join('；') });
    }
    drop.slice().reverse().forEach(function (d) { bak.appendRow(d.vals.concat([now, d.reason])); });
    SpreadsheetApp.flush();
    drop.forEach(function (d) { sh.deleteRow(d.row); });   // 由下往上刪，列號不會跑掉
    SpreadsheetApp.flush();
    return Object.assign({ ok: true, apply: true, from: from, to: to, scanned: scan.scanned, items: scan.items, moved: drop.length }, lockedOut || {});
  } finally { lock.releaseLock(); }
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
        { leaves: leaves, trip_hours: trip, rows: rows, force_strict: true, force_ot_punch: true, name: name, preview: true });
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
/* ── 指定月份的待核定（2026-11-19 Eason，考勤驗收 11-10 不符 5：月初看不到上個月沒核定的天）──
   mgr_pending_approvals 多吃一個選填參數 ym（'YYYY-MM'）：
   ‧不帶 ym（或空字串）＝照舊：直接走 Code.gs handleMgrPendingApprovals（台北本月），結果一個字都不變；
   ‧ym＝本月＝同上；ym＝上個月＝下面 reqPendingApprovalsMonth_（照 handleMgrPendingApprovals 同一套算法，只把月份換成 ym）；
   ‧其他月份回 bad_ym。營運系統每月 1～5 號帶上個月來問（首頁「11 月還有 N 天沒核定」、核定頁黃框）。
   Code.gs（各店 程式碼.js）不動：這裡用到的都是 Code.gs 既有的函式。 */
var REQ_PENDING_YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function reqPendingApprovalsMonth_(body, ym) {
  var ss = getSS();
  var mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  if (!findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };
  var today = todayTaipeiStr();
  var rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  var eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  var approvedSheet = ss.getSheetByName('approved');
  var approvedMap = buildLatestApprovedMap(approvedSheet ? readSheetAsObjects(approvedSheet).rows : []);
  var empIds = {};   // 那個月 events 出現過的所有 emp_id（含停用／離職，同 handleMgrPendingApprovals）
  eventRows.forEach(function (e) { if (tsDateStr(e.ts).slice(0, 7) === ym) empIds[String(e.emp_id)] = true; });
  var items = [];
  Object.keys(empIds).forEach(function (empId) {
    var roster = findRosterByEmpId(rosterRows, empId);
    var name = roster ? String(roster.name) : empId;
    monthPendingApprovalDates(eventRows, approvedMap, empId, ym, today).forEach(function (d) { items.push({ date: d, emp_id: empId, name: name }); });
  });
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return { ok: true, ym: ym, today: today, items: items };
}

function reqPendingApprovalsPlus_(body) {
  var r;
  var wantYm = body && body.ym !== undefined && body.ym !== null && body.ym !== '' ? String(body.ym) : '';
  if (wantYm) {
    var curYm = currentYmTaipei();
    if (!REQ_PENDING_YM_RE.test(wantYm) || (wantYm !== curYm && wantYm !== prevYm(curYm))) return { ok: false, error: 'bad_ym', message: '待核定提醒只看本月或上個月' };
    r = wantYm === curYm ? handleMgrPendingApprovals(body) : reqPendingApprovalsMonth_(body, wantYm);
  } else {
    r = handleMgrPendingApprovals(body);   // 舊呼叫：原樣
  }
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
  if (hide) r.items = r.items.filter(function (x) { return !reqInList_(hide, String(x.emp_id)); });   // reqInList_：名單讀壞（'*'）時全部不列，同 mgr_day（2026-11-15 考勤挑錯 B19）
  return r;
}

/** 指令碼屬性：只檢查一批（READ_MEMO_ 開著）時每個鍵只讀一次（每人讀 7 次，2026-11-14 加速）；其他時候照舊每次讀 */
function reqProp_(k) {
  var memo = typeof READ_MEMO_ !== 'undefined' ? READ_MEMO_ : null, mk = 'prop:' + k;
  if (memo && Object.prototype.hasOwnProperty.call(memo, mk)) return memo[mk];
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (memo) memo[mk] = v;
  return v;
}
/* ══ duty_changes auth_cfg：營運系統 ops/duty-auth.sh 遠端切核定模式（2026-11-21 P3-3；放 Requests.gs：九店 D2 只換 DutyFeed.js＋Requests.js，DutyFeed.gs 的寫屬性處數有測試釘住；契約 docs/contract-writeback.md 第 5 節）══
 * {action:'duty_changes', mgr_key, admin_key, auth_cfg:{mode, ver_strict?, ts, sig}} 或 {…, auth_cfg:{get:true}}（只讀現況）
 * 驗證（比 push_cfg 多一層）：
 *  1. 主管金鑰（handleDutyChanges_ 已驗）＋管理金鑰 admin_key（checkAdmin），同 push_cfg。
 *  2. 這家店已設門鈴金鑰（DUTY_PUSH_KEY）時，還要 mini 的簽名：sig＝HMAC-SHA256(DUTY_PUSH_KEY, 'cfg|2|店|mode|ver_strict(0/1/-)|ts|nonce')，
 *     ts 只收 ±2 分鐘；nonce（一次性單號，/^[A-Za-z0-9_-]{8,64}$/）用過就不收（暫存區 10 分鐘＋DUTY_AUTH_LOG 裡的 n 兩處查；
 *     2026-11-21 驗收 P2：原本 ±10 分鐘內可重放）。三把金鑰都要有才改得動。沒設門鈴金鑰的店只能設 google（＝現行，也不可能切 mini）。
 * 只寫白名單兩個屬性：DUTY_AUTH（mini→'mini'、google→''）、DUTY_VER_STRICT（ver_strict:true→'1'、false→''；沒帶＝不動）。
 * 值只認 mode＝DutyFeed.gs DUTY_AUTH_MODES_ 那張表（google／off／shadow＝google，mini／on＝mini）；其他任何值＝bad_input，屬性一個都不動（維持原值）。
 * 切 mini 要門鈴金鑰與店代碼都設好（need_key），同 push_cfg 的聯鎖。
 * 紀錄：每次寫入記一筆到 Apps Script 執行紀錄（console.log）＋指令碼屬性 DUTY_AUTH_LOG（最近 20 筆 {at, by, mode, ver_strict, from}；
 *   by＝主管名單上的名字＋代核姓名，不含金鑰）。回應只回模式與開關（不回金鑰、不回其他屬性）。 */
var DUTY_AUTH_LOG_MAX_ = 20;
var DUTY_CFG_SKEW_MS_ = 2 * 60000;          // 設定簽名時間 ±2 分鐘
var DUTY_CFG_NONCE_RE_ = /^[A-Za-z0-9_-]{8,64}$/;
var DUTY_CFG_NONCE_TTL_S_ = 600;            // 用過的 nonce 在暫存區留 10 分鐘（＞時間窗兩倍）；DUTY_AUTH_LOG 也記
function dutyAuthNow_(all) {
  var m = dutyAuthCfgOf_(all);
  var o = { mode: m.mini ? 'mini' : 'google', ver_strict: dutyOnVal_(all.DUTY_VER_STRICT) };
  if (m.unknown) o.unknown_value = true;   // DUTY_AUTH 被手動填了認不得的值（照 google 處理）
  return o;
}
function dutyAuthCfgMsg_(store, mode, vs, ts, nonce) {
  return ['cfg', '2', store, mode, vs === true ? '1' : vs === false ? '0' : '-', String(ts), String(nonce)].join('|');
}
function dutyAuthLogOf_(raw) {
  var log = [];
  try { log = JSON.parse(String(raw || '[]')); } catch (e) { log = []; }
  return Array.isArray(log) ? log : [];
}
function dutyAuthCfgSet_(body, mg) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var c = body.auth_cfg;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, error: 'bad_input' };
  var props = PropertiesService.getScriptProperties();
  if (c.get === true) {
    var all0 = props.getProperties() || {};
    return { ok: true, auth_cfg: dutyAuthNow_(all0), log: dutyAuthLogOf_(all0.DUTY_AUTH_LOG) };
  }
  var raw = typeof c.mode === 'string' ? c.mode.trim().toLowerCase() : '';
  var mode = raw && Object.prototype.hasOwnProperty.call(DUTY_AUTH_MODES_, raw) ? DUTY_AUTH_MODES_[raw] : '';
  if (!mode || (c.ver_strict !== undefined && typeof c.ver_strict !== 'boolean')) {
    return { ok: false, error: 'bad_input', message: 'mode 只能是 google／mini（或 off、shadow、on）；ver_strict 只能是 true／false' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'busy' };
  try {
    var all = props.getProperties() || {};
    var key = String(all.DUTY_PUSH_KEY || ''), store = String(all.DUTY_PUSH_STORE || '').trim();
    var keySet = key.length >= 32 && /^[a-z0-9]{2,16}$/.test(store);
    if (mode === 'mini' && !keySet) return { ok: false, error: 'need_key', message: '這家店還沒設好門鈴金鑰與店代碼，不能切 mini' };
    var nonce = '';
    if (keySet) {
      var ts = c.ts, sig = String(c.sig == null ? '' : c.sig);
      nonce = String(c.nonce == null ? '' : c.nonce);
      if (typeof ts !== 'number' || !isFinite(ts) || !DUTY_WB_SIG_RE_.test(sig) || !DUTY_CFG_NONCE_RE_.test(nonce)) return { ok: false, error: 'bad_sig', message: '要帶 mini 的設定簽名與一次性單號' };
      if (Math.abs(Date.now() - ts) > DUTY_CFG_SKEW_MS_) return { ok: false, error: 'wb_ts', message: '設定簽名時間超過 2 分鐘', now: Date.now() };
      if (!dutyWbSame_(dutyWbSign_(dutyAuthCfgMsg_(store, raw, c.ver_strict, ts, nonce), key), sig)) return { ok: false, error: 'bad_sig', message: '設定簽名不對' };
      var cache = CacheService.getScriptCache(), nk = 'dcfg:' + nonce;
      var seen = false;
      try { seen = !!cache.get(nk); } catch (e) { seen = false; }
      if (!seen) seen = dutyAuthLogOf_(all.DUTY_AUTH_LOG).some(function (x) { return x && x.n === nonce; });
      if (seen) return { ok: false, error: 'replay', message: '這個設定請求已經用過，請重新簽一次' };
      try { cache.put(nk, '1', DUTY_CFG_NONCE_TTL_S_); } catch (e) {}
    }
    var before = dutyAuthNow_(all);
    props.setProperty('DUTY_AUTH', mode === 'mini' ? 'mini' : '');
    if (typeof c.ver_strict === 'boolean') props.setProperty('DUTY_VER_STRICT', c.ver_strict ? '1' : '');
    var after = dutyAuthNow_(props.getProperties() || {});
    var mgr = mg ? findManagerByKey(mg.rows, body.mgr_key) : null;
    var by = String((mgr && mgr.name) || '') + (body.acting_name ? '／' + String(body.acting_name).slice(0, 40) : '');
    var rec = { at: nowTaipeiIso(), by: by, mode: after.mode, ver_strict: after.ver_strict, from: before.mode };
    if (nonce) rec.n = nonce;
    var log = dutyAuthLogOf_(all.DUTY_AUTH_LOG);
    log.push(rec);
    props.setProperty('DUTY_AUTH_LOG', JSON.stringify(log.slice(-DUTY_AUTH_LOG_MAX_)));
    try { console.log('DUTY_AUTH 設定：' + JSON.stringify(rec)); } catch (e) {}
    return { ok: true, auth_cfg: after, changed: before.mode !== after.mode || before.ver_strict !== after.ver_strict };
  } finally {
    lock.releaseLock();
  }
}
