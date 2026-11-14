/**
 * 考勤副本變動通知＋版本（2026-11-14 Eason 開工，營運系統 docs/duty-replica-b）。
 *
 * Mac mini 營運系統存一份考勤副本，主管開考勤管理直接讀 mini、照副本核定。這裡負責兩件事：
 * 1. 記變動：doPost 每做完一個「可能改到考勤資料」的動作（打卡、送單、核准、核定、改名冊…），
 *    在 Google 暫存區（CacheService）記一筆「什麼動作、哪幾天、哪個人」。mini 每 30 秒用 duty_changes 來拿，只重讀那幾天。
 *    暫存區偶爾會被清掉或兩筆同時寫撞掉一筆：mini 另外每 30 分鐘整批對帳兜底，這裡不追求一筆不漏。
 *    只寫暫存區、不寫試算表、不連外：打卡多花的時間是幾十毫秒。
 * 2. 版本：mgr_day 帶 with_ver:true 時，每位同仁多一格 ver＝那天打卡、請假登記、核定、申請單算出來的摘要碼。
 *    mgr_approve 帶 base_ver 時先重算一次，跟主管看到的不一樣就退回（error stale_ver），不照舊資料核定。
 *    不帶 base_ver（舊 manager.html、門市舊入口）照原本流程，完全不受影響。
 */

var DUTY_FEED_BUCKET_MS_ = 10000;          // 10 秒一格
var DUTY_FEED_SLOTS_ = 8;                  // 每格 8 個位置隨機挑一個寫：同時兩筆寫同一個位置才會撞掉
var DUTY_FEED_TTL_S_ = 21600;              // 暫存區最多放 6 小時（CacheService 上限）
var DUTY_FEED_MAX_BACK_MS_ = 15 * 60000;   // duty_changes 最多往回找 15 分鐘；更早的請 mini 整批對帳
var DUTY_FEED_PREFIX_ = 'dfeed_';

/* 只讀、不會改到考勤資料的動作：不記變動（其餘一律記，寧可多讀不可漏） */
var DUTY_FEED_READS_ = {
  whoami: 1, my_recent: 1, get_roster: 1, get_events: 1, recent_hires: 1,
  mgr_day: 1, mgr_pending_devices: 1, mgr_pending_approvals: 1, mgr_notices: 1, mgr_roster: 1,
  att_digest_data: 1, liff_whoami: 1, liff_my_recent: 1, liff_status: 1, export_tables: 1,
  req_info: 1, mgr_req_pending: 1, mgr_req_day: 1, mgr_req_month: 1, approve_strict_preview: 1, mgr_approve_check: 1,
  mgr_line_binds: 1, mgr_qr_token: 1, line_hub_status: 1, line_hub_attach_get: 1, line_probe: 1,
  relay_snapshot: 1, punch_timing_get: 1, line_hub_req_quota: 1, line_hub_sched: 1, sched_day_roster: 1,
  svc_roster: 1, svc_payroll_names: 1, duty_changes: 1, line_hub_react_check: 1, line_punch_timing: 1
};
/* 薪資模組只讀的動作很多，名稱都是 payroll_ 開頭；會改考勤的只有這幾個（其他 payroll_ 開頭的不記） */
var DUTY_FEED_PAYROLL_WRITES_ = { payroll_leave_event_set: 1, payroll_ot_month_sync: 1, payroll_holiday_sync: 1, payroll_migrate_store: 1 };

function dutyFeedIsRead_(action) {
  var a = String(action || '');
  if (DUTY_FEED_READS_[a]) return true;
  if (a.indexOf('payroll_') === 0 && !DUTY_FEED_PAYROLL_WRITES_[a]) return true;
  return false;
}

function dutyFeedDate_(v) {
  var s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** 從請求內文與回應找出這次動到哪幾天、哪個人 */
function dutyFeedDates_(body, res) {
  var out = {};
  var add = function (v) { var d = dutyFeedDate_(v); if (d) out[d] = 1; };
  add(body && body.date);
  if (body && Array.isArray(body.dates)) body.dates.forEach(add);
  if (body && body.request && typeof body.request === 'object') { add(body.request.date); add(body.request.end_date); }
  if (res && typeof res === 'object') {
    add(res.date);
    if (res.request && typeof res.request === 'object') add(res.request.date);
    if (res.item && typeof res.item === 'object') add(res.item.date);
  }
  return Object.keys(out);
}

/** 用申請單 id 找日期與同仁（核准／退回／作廢只帶 id）。讀不到就算了，mini 會重讀待審清單與今天。 */
function dutyFeedReqLookup_(body) {
  var ids = [];
  if (body && body.id != null && body.id !== '') ids.push(String(body.id));
  if (body && Array.isArray(body.ids)) body.ids.forEach(function (x) { if (x != null && x !== '') ids.push(String(x)); });
  if (body && Array.isArray(body.items)) body.items.forEach(function (x) { if (x && x.id != null) ids.push(String(x.id)); });
  if (!ids.length || typeof reqRows_ !== 'function') return [];
  var want = {}; ids.forEach(function (x) { want[x] = 1; });
  try {
    return reqRows_(getSS()).filter(function (r) { return want[String(r.id)]; })
      .map(function (r) { return { d: dutyFeedDate_(r.date), e: String(r.emp_id || '') }; });
  } catch (e) { return []; }
}

/** doPost 每個動作做完呼叫：只記成功的寫入。任何錯誤都吞掉，不影響原本的回應。 */
function dutyFeedNote_(body, res) {
  try {
    var action = String((body && body.action) || '');
    if (!action || dutyFeedIsRead_(action) || (body && body.dry_run === true)) return;   // 只檢查不寫入的不算變動
    if (!res || res.ok === false) return;
    // 同仁從 LINE 送的申請（req_submit）內文只有 id_token、沒有 emp_id：從回應的 request 拿（2026-11-14，副本對帳只差 ver 的就是這種）
    var resEmp = res && res.request && typeof res.request === 'object' ? res.request.emp_id : '';
    var rec = { t: Date.now(), a: action, d: dutyFeedDates_(body, res), e: String((body && body.emp_id) || (res && res.emp_id) || resEmp || ''),
                n: Utilities.getUuid().slice(0, 8) };
    if (/^mgr_req_|^req_/.test(action) && !rec.d.length) {
      var hits = dutyFeedReqLookup_(body);
      hits.forEach(function (h) { if (h.d && rec.d.indexOf(h.d) < 0) rec.d.push(h.d); });
      if (!rec.e && hits.length === 1) rec.e = hits[0].e;
    }
    var bucket = Math.floor(rec.t / DUTY_FEED_BUCKET_MS_);
    var key = DUTY_FEED_PREFIX_ + bucket + '_' + Math.floor(Math.random() * DUTY_FEED_SLOTS_);
    var cache = CacheService.getScriptCache();
    var cur = cache.get(key), list = [];
    if (cur) { try { list = JSON.parse(cur); } catch (e) { list = []; } }
    if (!Array.isArray(list)) list = [];
    list.push(rec);
    cache.put(key, JSON.stringify(list), DUTY_FEED_TTL_S_);
  } catch (e) { /* 記變動失敗不影響打卡與核定；mini 的整批對帳會補 */ }
}

/**
 * {action:'duty_changes', mgr_key, since:毫秒} → {ok, now, changes:[{t,a,d,e,n}], reset}
 * reset:true＝since 太舊（超過 15 分鐘）或沒給，mini 要整批對帳，這次只回最近 15 分鐘。
 */
function handleDutyChanges_(body) {
  var sh = getSS().getSheetByName('managers');
  if (!sh || !findManagerByKey(readSheetAsObjects(sh).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };
  var now = Date.now();
  var since = Number(body.since);
  var reset = false;
  if (!isFinite(since) || since <= 0 || now - since > DUTY_FEED_MAX_BACK_MS_) { since = now - DUTY_FEED_MAX_BACK_MS_; reset = true; }
  var from = Math.floor(since / DUTY_FEED_BUCKET_MS_), to = Math.floor(now / DUTY_FEED_BUCKET_MS_);
  var keys = [];
  for (var b = from; b <= to; b++) for (var s = 0; s < DUTY_FEED_SLOTS_; s++) keys.push(DUTY_FEED_PREFIX_ + b + '_' + s);
  var cache = CacheService.getScriptCache(), changes = [];
  for (var i = 0; i < keys.length; i += 100) {
    var got = cache.getAll(keys.slice(i, i + 100));
    Object.keys(got).forEach(function (k) {
      var list;
      try { list = JSON.parse(got[k]); } catch (e) { return; }
      if (!Array.isArray(list)) return;
      list.forEach(function (r) { if (r && Number(r.t) >= since) changes.push(r); });
    });
  }
  changes.sort(function (a, b) { return a.t - b.t; });
  return { ok: true, now: now, since: since, reset: reset, changes: changes };
}

/* ── 版本 ── */

/** 一位同仁一天的版本：打卡段、未入帳嘗試、重複卡、請假登記、核定、名冊狀態、那天的申請單。
 *  不含 reference（參考時數會隨「今天」變，不代表資料有變動）。 */
function dutyVerOf_(emp, reqList) {
  var pick = {
    s: emp.segments || [], at: emp.attempts || 0, dg: emp.dup_groups || [], lv: emp.leaves || [],
    ap: emp.approved || null, nl: !!emp.no_line, fs: !!emp.first_support,
    si: emp.shift_in || '', so: emp.shift_out || '',
    rq: (reqList || []).map(function (r) {
      var o = {}; Object.keys(r).sort().forEach(function (k) { o[k] = r[k] instanceof Date ? r[k].toISOString() : r[k]; }); return o;
    }).sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; })
  };
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(pick), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

/** mgr_day 的結果加上每人 ver（只在 with_ver:true 時呼叫） */
function dutyAttachVer_(res, date) {
  if (!res || res.ok !== true || !Array.isArray(res.employees)) return res;
  var byEmp = {};
  try {
    if (typeof reqRows_ === 'function') {
      reqRows_(getSS()).forEach(function (r) {
        if (dutyFeedDate_(r.date) !== date) return;
        var k = String(r.emp_id || '');
        (byEmp[k] = byEmp[k] || []).push(r);
      });
    }
  } catch (e) { return res; }   // 申請單讀不到：不給 ver（mini 就不會讓主管依副本核定）
  res.employees.forEach(function (emp) { emp.ver = dutyVerOf_(emp, byEmp[String(emp.emp_id)] || []); });
  res.with_ver = true;
  return res;
}

var DUTY_STALE_MSG_ = '你打開之後，這位同仁這天的資料有變動（補了打卡、申請單有變化，或別人已經核定），請看過最新的再核定一次';

/** mgr_approve 帶 base_ver：重算現在的版本，對不上就退回。回 null＝可以照常核定。 */
function dutyVerGuard_(body) {
  if (!body || typeof body.base_ver !== 'string' || !body.base_ver) return null;
  var date = dutyFeedDate_(body.date), emp = String(body.emp_id == null ? '' : body.emp_id);
  if (!date || !emp) return null;   // 格式錯讓原本的檢查回錯
  var r = handleMgrDay({ mgr_key: body.mgr_key, date: date, with_ver: true });
  if (!r || r.ok !== true) return null;   // 讀不到就交給原本流程（它會自己回 unauthorized 等）
  var cur = null;
  (r.employees || []).forEach(function (e) { if (String(e.emp_id) === emp) cur = e; });
  if (!cur || !cur.ver) return null;
  if (cur.ver === body.base_ver) return null;
  return { ok: false, error: 'stale_ver', message: DUTY_STALE_MSG_, cur_ver: cur.ver };
}
