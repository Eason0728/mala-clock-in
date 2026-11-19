/**
 * 考勤副本變動通知＋版本（2026-11-14 Eason 開工，營運系統 docs/duty-replica-b）。
 *
 * Mac mini 營運系統存一份考勤副本，主管開考勤管理直接讀 mini、照副本核定。這裡負責兩件事：
 * 1. 記變動：doPost 每做完一個「可能改到考勤資料」的動作（打卡、送單、核准、核定、改名冊…），
 *    在 Google 暫存區（CacheService）記一筆「什麼動作、哪幾天、哪個人」。mini 每 30 秒用 duty_changes 來拿，只重讀那幾天。
 *    暫存區偶爾會被清掉或兩筆同時寫撞掉一筆：mini 另外每 30 分鐘整批對帳兜底，這裡不追求一筆不漏。
 *    只寫暫存區、不寫試算表、不連外：打卡多花的時間是幾十毫秒（連外只在設了第 3 點的門鈴、而且不是只計數模式時）。
 * 2. 版本：mgr_day 帶 with_ver:true 時，每位同仁多一格 ver＝那天打卡、請假登記、核定、申請單算出來的摘要碼。
 *    mgr_approve 帶 base_ver 時先重算一次，跟主管看到的不一樣就退回（error stale_ver），不照舊資料核定。
 *    不帶 base_ver（舊 manager.html、門市舊入口）照原本流程，完全不受影響。
 * 3. 推送門鈴（2026-11-20，第 1 階段 S2；設計 dzy-mini-playbook docs/clock-to-mini/phase1-design.md 2.3–2.8）：
 *    記完變動後，順手按一下 Mac mini 的門鈴（只說「哪家店、什麼動作、哪幾天、編號」，不帶員編、不帶任何內容），
 *    mini 收到再回頭用 duty_changes 拿。**預設關**：指令碼屬性 DUTY_PUSH_URL 沒設＝跟沒有這段完全一樣（只多讀那一個屬性）。
 *    DUTY_PUSH_DRY＝1＝只計數不連外。寫入絕不能因為門鈴失敗、變慢：見 dutyPushSend_ 上方的規則。
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
  att_digest_data: 1, liff_whoami: 1, liff_my_recent: 1, liff_status: 1, export_tables: 1, sheet_stats: 1,
  req_info: 1, mgr_req_pending: 1, mgr_req_day: 1, mgr_req_month: 1, approve_strict_preview: 1, mgr_approve_check: 1, peer_day_digest: 1,
  mgr_line_binds: 1, mgr_qr_token: 1, line_hub_status: 1, line_hub_attach_get: 1, line_probe: 1,
  relay_snapshot: 1, relay_pull: 1, relay_mode: 1, punch_timing_get: 1, line_hub_req_quota: 1, line_hub_pay_lock: 1, line_hub_sched: 1, sched_day_roster: 1,
  svc_roster: 1, svc_payroll_names: 1, duty_changes: 1, line_hub_react_check: 1, line_punch_timing: 1,
  line_hub_req_init: 1, line_hub_warm: 1   // 2026-11-18：申請頁開頁資料、mini 先建對照表都只讀（原本 init 每開一次頁就讓 mini 重讀光復當天考勤）
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
    dutyPushNote_(body, res, rec);   // 先寫暫存區、再按門鈴（門鈴丟了，mini 下次問 duty_changes 照樣拿得到）
  } catch (e) { /* 記變動失敗不影響打卡與核定；mini 的整批對帳會補 */ }
}

/**
 * {action:'duty_changes', mgr_key, since:毫秒} → {ok, now, changes:[{t,a,d,e,n}], reset}
 * reset:true＝since 太舊（超過 15 分鐘）或沒給，mini 要整批對帳，這次只回最近 15 分鐘。
 * 選填（2026-11-20，第 1 階段；不帶時回應與之前逐字相同）：
 *   back:'long'      往回找 75 分鐘（每小時那一次補問用）
 *   digest:true      多回 digest：各分頁「每天一個雜湊＋列數」（只回雜湊與列數，不回內容；managers／roster 的金鑰欄不算進雜湊）
 *   ping:'<nonce>'   回應前先按一次門鈴 {ping}，回應多 ping:'<結果>'（端到端確認 Google 推得到 mini）
 *   push_stats:true  只要門鈴統計
 *   以上任一個有帶 → 回應多 push:{…}（門鈴統計）。
 *   push_setup:{key, store} 一次性設門鈴金鑰（另要 admin_key；已設過就回 already_set；回應不回金鑰）。
 *   push_cfg:{url_on, dry}  遠端開關門鈴（另要 admin_key；網址寫死、真的連外要先有金鑰；見 dutyPushCfgSet_）。
 *   push_setup 與 push_cfg 同時帶 → bad_input。
 */
function handleDutyChanges_(body) {
  var ss = getSS(), sh = ss.getSheetByName('managers');
  var mg = sh ? readSheetAsObjects(sh) : null;
  if (!mg || !findManagerByKey(mg.rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };
  if (body.push_setup !== undefined && body.push_cfg !== undefined) return { ok: false, error: 'bad_input' };   // 一次只做一件
  if (body.push_setup !== undefined) return dutyPushSetup_(body);
  if (body.push_cfg !== undefined) return dutyPushCfgSet_(body);
  var x = dutyChangesExtras_(body);   // 沒帶任何新參數＝null，下面每一步都跟之前一樣
  var now = Date.now();
  var since = Number(body.since);
  var reset = false;
  var maxBack = x && x.long ? DUTY_FEED_LONG_BACK_MS_ : DUTY_FEED_MAX_BACK_MS_;
  if (!isFinite(since) || since <= 0 || now - since > maxBack) { since = now - maxBack; reset = true; }
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
  var out = { ok: true, now: now, since: since, reset: reset, changes: changes };
  if (!x) return out;
  if (x.ping) out.ping = dutyPushPing_(x.ping);
  if (x.digest) {
    try { out.digest = dutyDigest_(ss, mg, now); } catch (e) { out.digest = { error: 'digest_failed' }; }
  }
  try { out.push = dutyPushStats_(); } catch (e) { out.push = { error: 'stats_failed' }; }
  return out;
}

/** duty_changes 的新參數；一個都沒帶（或格式不對）回 null。 */
function dutyChangesExtras_(body) {
  var x = { long: body.back === 'long', digest: body.digest === true, stats: body.push_stats === true,
            ping: typeof body.ping === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.ping) ? body.ping : '' };
  return (x.long || x.digest || x.stats || x.ping) ? x : null;
}

/* ══ 推送門鈴（2026-11-20，第 1 階段 S2）══
 * 指令碼屬性（全部沒設＝完全不推、不計數）：
 *   DUTY_PUSH_URL    門鈴網址（https://dzy-gw…/store/svc/duty-push）。沒設＝整段不做事，連其他屬性都不讀。
 *   DUTY_PUSH_DRY    '1'＝只計數（記「本來會推幾次」），不呼叫 UrlFetchApp。第一輪上線只用這個模式量推送量。
 *   DUTY_PUSH_KEY    簽章金鑰（每店一把，mini 用 duty_changes push_setup 一次寫入；不回、不記錄）。
 *   DUTY_PUSH_STORE  這家店在 mini 的店代碼（gf、mztjs…），跟金鑰一起寫入。
 * 退回：刪 DUTY_PUSH_URL（或 mini 用 duty_changes push_cfg:{url_on:false, dry:true} 把它設成空白）＝立即不推；mini 回 {ok:true, off:true}＝這家店停推 1 小時。
 */
var DUTY_FEED_LONG_BACK_MS_ = 75 * 60000;   // back:'long'：往回 75 分鐘（暫存區本來就放 6 小時）
var DUTY_PUSH_TIMEOUT_S_ = 3;               // UrlFetch 最多等 3 秒
var DUTY_PUSH_FAIL_OFF_S_ = 60;             // 失敗（逾時、非 2xx、回的不是 JSON）→ 60 秒內這家店不推
var DUTY_PUSH_REMOTE_OFF_S_ = 3600;         // mini 回 off:true → 1 小時內不推
var DUTY_PUSH_DAY_CAP_ = 1500;              // 單店每天最多真的連外 1,500 次（防 UrlFetch 額度被吃光、LINE 驗證跟著掛）
var DUTY_PUSH_PING_DAY_CAP_ = 40;           // ping（duty_changes 帶 ping 時往外連的那一次）另計：單店每天最多 40 次。設計是每小時 1 次、一天 22 次，留餘裕；
                                            // 九店共用同一帳號「往外連線 2 萬次/天」，mini 端出錯狂打 ping 時不能靠一般寫入的 1,500 次額度擋，所以獨立、更保守
var DUTY_PUSH_PING_PREFIX_ = 'dpush_ping_'; // ping 當天次數（CacheService 另一個 key，後面接台北日期）
var DUTY_PUSH_MS_KEEP_ = 100;               // 統計保留最近 100 次耗時
var DUTY_PUSH_OFF_KEY_ = 'dpush_off';
var DUTY_PUSH_ST_PREFIX_ = 'dpush_st_';
/* 光復直接寫到「不知道是哪幾家」的動作 → to:['*']（mini 把九家的清單類都標成要重讀）。
 * payroll_ot_month_sync：寫每家店的 ot_month 分頁（Payroll.gs payOtMonthSync_）；其他幾個影響哪家店拿不準，一律當全部。 */
var DUTY_PUSH_TO_ALL_ = { payroll_ot_month_sync: 1, payroll_holiday_sync: 1, payroll_migrate_store: 1, payroll_leave_event_set: 1,
                          sched_publish: 1, sched_unpublish: 1 };

/** 讀門鈴設定：沒設網址回 null（只讀了 DUTY_PUSH_URL 這一個屬性）。只計數模式不讀金鑰。 */
function dutyPushCfg_() {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('DUTY_PUSH_URL') || '').trim();
  if (!url) return null;
  var cfg = { url: url, dry: String(props.getProperty('DUTY_PUSH_DRY') || '').trim() === '1', key: '', store: '' };
  if (!cfg.dry) {
    cfg.key = String(props.getProperty('DUTY_PUSH_KEY') || '');
    cfg.store = String(props.getProperty('DUTY_PUSH_STORE') || '').trim();
  }
  return cfg;
}

function dutyPushDay_(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }   // 台北日期

function dutyPushHex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b < 0 ? b + 256 : b) & 255).toString(16)).slice(-2); }).join('');
}

/** 簽章 = HMAC-SHA256(金鑰, v|s|t|n|a|d 以逗號接|to 以逗號接|ping)，小寫十六進位。 */
function dutyPushSign_(p, key) {
  var msg = [p.v, p.s, p.t, p.n, p.a, (p.d || []).join(','), (p.to || []).join(','), p.ping || ''].join('|');
  return dutyPushHex_(Utilities.computeHmacSha256Signature(msg, key));
}

/** 光復直接開別家店試算表寫入的動作，要告訴 mini 是哪幾家（to）。其他店的寫入都在自己的執行裡，回 null。
 *  確認過：設離職連帶停用（mgr_set_active／svc_set_active 的 cascade、line_hub_left）＝ LineHub.gs lineHubLeftCascade_ 寫別家名冊。
 *  對不上店代碼、任何意外 → ['*']。 */
function dutyPushTo_(action, body, res) {
  if (DUTY_PUSH_TO_ALL_[action]) return ['*'];
  if (typeof lineHubStores_ !== 'function') return null;   // 只有光復（掛 LineHub.gs）會直接寫別家店
  var src = null;
  if (action === 'line_hub_left') src = res;
  else if ((action === 'mgr_set_active' || action === 'svc_set_active') && res && res.cascade && typeof res.cascade === 'object') src = res.cascade;
  if (!src) return null;
  try {
    var names = [];
    if (Array.isArray(src.stopped)) src.stopped.forEach(function (x) { names.push(x && x.store_name); });
    if (Array.isArray(src.failed)) src.failed.forEach(function (x) { names.push(x); });   // 讀到一半出錯的店也可能已寫了幾格
    if (!names.length) return null;
    var map = typeof LINE_HUB_STAFF_CODE_MAP !== 'undefined' ? LINE_HUB_STAFF_CODE_MAP : null;
    if (!map) return ['*'];
    var stores = lineHubStores_(), out = [];
    for (var i = 0; i < names.length; i++) {
      var st = stores.filter(function (s) { return String(s.name) === String(names[i]); })[0];
      var code = st ? map[String(st.code)] : undefined;
      if (!code) return ['*'];
      if (out.indexOf(code) < 0) out.push(code);
    }
    return out.sort();
  } catch (e) { return ['*']; }
}

function dutyPushStParse_(raw, day) {
  var st = { d: day, sent: 0, ok: 0, remote_off: 0, fail: 0, dry: 0, skip_off: 0, skip_cap: 0, skip_ping_cap: 0, skip_cfg: 0, with_to: 0, ms: [] };
  if (!raw) return st;
  var j;
  try { j = JSON.parse(raw); } catch (e) { return st; }
  if (!j || j.d !== day) return st;
  Object.keys(st).forEach(function (k) {
    if (k === 'd') return;
    if (k === 'ms') { if (Array.isArray(j.ms)) st.ms = j.ms.filter(function (v) { return typeof v === 'number' && isFinite(v); }).slice(-DUTY_PUSH_MS_KEEP_); return; }
    if (typeof j[k] === 'number' && isFinite(j[k])) st[k] = j[k];
  });
  return st;
}

/**
 * 按一次門鈴。回結果：ok／remote_off／fail（有連外）、dry（只計數）、skip_off（熔斷中）、skip_cap（今天滿了）、skip_cfg（金鑰、店代碼、網址不齊）。
 * 硬性規則（寫入絕不能因 mini 卡住）：
 *  1. 呼叫端整段 try/catch；先寫暫存區再按門鈴。
 *  2. timeoutSeconds:3、muteHttpExceptions、followRedirects:false（轉址＝失敗）。
 *  3. 失敗 → 60 秒熔斷（CacheService dpush_off）；4. mini 回 off:true → 停 1 小時。
 *  5. 單店每天真的連外最多 1,500 次（計數不是原子，誤差可接受）。只計數模式不受上限、也不連外。
 *  6. ping 另有每天 40 次的獨立上限（skip_ping_cap，不連外）；仍受熔斷管，也算進上面 1,500 次。只計數模式照樣套用，量得到的就是正式會推的次數。
 */
function dutyPushSend_(p, cfg) {
  var now = Date.now(), day = dutyPushDay_(now), stKey = DUTY_PUSH_ST_PREFIX_ + day;
  var cache = CacheService.getScriptCache();
  var isPing = p.a === 'ping', pingKey = DUTY_PUSH_PING_PREFIX_ + day;
  var got = cache.getAll(isPing ? [DUTY_PUSH_OFF_KEY_, stKey, pingKey] : [DUTY_PUSH_OFF_KEY_, stKey]) || {};   // 一般寫入的快取讀取跟以前一樣，不多讀 ping 計數
  var st = dutyPushStParse_(got[stKey], day), off = null, outcome = '', offPut = null;
  var pingN = isPing ? Number(got[pingKey]) : 0;
  if (!isFinite(pingN) || pingN < 0) pingN = 0;
  try { off = got[DUTY_PUSH_OFF_KEY_] ? JSON.parse(got[DUTY_PUSH_OFF_KEY_]) : null; } catch (e) { off = null; }
  if (off && Number(off.until) > now) outcome = 'skip_off';
  else if (isPing && pingN >= DUTY_PUSH_PING_DAY_CAP_) outcome = 'skip_ping_cap';
  else if (cfg.dry) outcome = 'dry';
  else if (st.sent >= DUTY_PUSH_DAY_CAP_) outcome = 'skip_cap';
  else if (!/^https:\/\//.test(cfg.url) || cfg.key.length < 32 || !/^[a-z0-9]{2,16}$/.test(cfg.store)) outcome = 'skip_cfg';
  else {
    p.s = cfg.store;
    p.sig = dutyPushSign_(p, cfg.key);
    st.sent++;
    var t0 = Date.now(), code = -1, txt = '';
    try {
      var resp = UrlFetchApp.fetch(cfg.url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(p),
                                              muteHttpExceptions: true, followRedirects: false, timeoutSeconds: DUTY_PUSH_TIMEOUT_S_ });
      code = Number(resp.getResponseCode());
      if (code >= 200 && code < 300 && code !== 204) txt = String(resp.getContentText() || '');
    } catch (e) { code = -1; }
    st.ms.push(Date.now() - t0);
    if (st.ms.length > DUTY_PUSH_MS_KEEP_) st.ms = st.ms.slice(-DUTY_PUSH_MS_KEEP_);
    var j = null;
    if (txt) { try { j = JSON.parse(txt); } catch (e) { j = null; } }
    if (code === 204 || (j && typeof j === 'object' && j.ok === true)) {   // 204＝mini 關了收門鈴（DUTY_PUSH_ON=0），不算失敗
      outcome = j && j.off === true ? 'remote_off' : 'ok';
      if (outcome === 'remote_off') offPut = { why: 'remote', s: DUTY_PUSH_REMOTE_OFF_S_ };
    } else {
      outcome = 'fail';
      offPut = { why: 'fail', s: DUTY_PUSH_FAIL_OFF_S_ };
    }
  }
  st[outcome] = (st[outcome] || 0) + 1;
  if (p.to && (outcome === 'ok' || outcome === 'remote_off' || outcome === 'fail' || outcome === 'dry')) st.with_to++;
  if (offPut) cache.put(DUTY_PUSH_OFF_KEY_, JSON.stringify({ until: Date.now() + offPut.s * 1000, why: offPut.why }), offPut.s);
  cache.put(stKey, JSON.stringify(st), DUTY_FEED_TTL_S_);
  if (isPing && (outcome === 'ok' || outcome === 'remote_off' || outcome === 'fail' || outcome === 'dry')) cache.put(pingKey, String(pingN + 1), DUTY_FEED_TTL_S_);   // 只算真的連外（或只計數）的那幾次
  return outcome;
}

/** dutyFeedNote_ 記完一筆寫入後呼叫：內容只有 {v,s,t,n,a,d,to?,sig}（不帶員編 e、不帶 body 任何欄位）。 */
function dutyPushNote_(body, res, rec) {
  try {
    var cfg = dutyPushCfg_();
    if (!cfg) return;   // 預設關：只讀了 DUTY_PUSH_URL 一個屬性
    var p = { v: 1, s: '', t: rec.t, n: rec.n, a: rec.a, d: rec.d.slice() };
    var to = dutyPushTo_(rec.a, body, res);
    if (to && to.length) p.to = to;
    dutyPushSend_(p, cfg);
  } catch (e) { /* 門鈴失敗不影響寫入；mini 每小時補問會補 */ }
}

/** duty_changes ping：回應前先按一次門鈴 {ping}。回結果字串；沒設網址回 'disabled'。 */
function dutyPushPing_(nonce) {
  try {
    var cfg = dutyPushCfg_();
    if (!cfg) return 'disabled';
    return dutyPushSend_({ v: 1, s: '', t: Date.now(), n: String(Utilities.getUuid()).slice(0, 8), a: 'ping', d: [], ping: nonce }, cfg);
  } catch (e) { return 'error'; }
}

/** 門鈴統計（給 mini 看）：成功、失敗、跳過、只計數次數、近 100 次耗時。只回個數與布林，不回網址、金鑰。 */
function dutyPushStats_() {
  var cfg = dutyPushCfg_();
  if (!cfg) return { on: false };
  var now = Date.now(), day = dutyPushDay_(now);
  var got = CacheService.getScriptCache().getAll([DUTY_PUSH_OFF_KEY_, DUTY_PUSH_ST_PREFIX_ + day]) || {};
  var st = dutyPushStParse_(got[DUTY_PUSH_ST_PREFIX_ + day], day), off = null;
  try { off = got[DUTY_PUSH_OFF_KEY_] ? JSON.parse(got[DUTY_PUSH_OFF_KEY_]) : null; } catch (e) { off = null; }
  var ms = st.ms.slice().sort(function (a, b) { return a - b; });
  var q = function (f) { return ms.length ? ms[Math.max(0, Math.ceil(f * ms.length) - 1)] : null; };
  var keySet = cfg.dry ? String(PropertiesService.getScriptProperties().getProperty('DUTY_PUSH_KEY') || '').length >= 32 : cfg.key.length >= 32;
  return { on: true, mode: cfg.dry ? 'dry' : 'live', day: day, cap: DUTY_PUSH_DAY_CAP_, ping_cap: DUTY_PUSH_PING_DAY_CAP_, key_set: keySet,
           sent: st.sent, ok: st.ok, remote_off: st.remote_off, fail: st.fail, dry: st.dry,
           skip_off: st.skip_off, skip_cap: st.skip_cap, skip_ping_cap: st.skip_ping_cap, skip_cfg: st.skip_cfg, with_to: st.with_to,
           samples: ms.length, p50ms: q(0.5), p95ms: q(0.95), max_ms: ms.length ? ms[ms.length - 1] : null,
           off: off && Number(off.until) > now ? { why: String(off.why || ''), until: Number(off.until) } : null };
}

/** duty_changes push_setup：一次性寫入門鈴金鑰與店代碼（比照 relay_setup）。金鑰由 mini 產生；這裡不回、不記錄。 */
function dutyPushSetup_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var s = body.push_setup;
  if (!s || typeof s !== 'object' || typeof s.key !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(s.key)
      || typeof s.store !== 'string' || !/^[a-z0-9]{2,16}$/.test(s.store)) return { ok: false, error: 'bad_input' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'busy' };
  try {   // 鎖內重讀：兩次同時呼叫只有一次會真的設
    var props = PropertiesService.getScriptProperties();
    if (String(props.getProperty('DUTY_PUSH_KEY') || '')) return { ok: false, error: 'already_set' };
    props.setProperty('DUTY_PUSH_STORE', s.store);
    props.setProperty('DUTY_PUSH_KEY', s.key);
    return { ok: true, push_setup: 'set', store: s.store };
  } finally {
    lock.releaseLock();
  }
}

/**
 * duty_changes push_cfg:{url_on, dry}：mini 遠端開關門鈴（2026-11-20 Eason：「你直接幫我設定」，不用進九個編輯器）。
 * 設計成「主管金鑰＋管理金鑰都外洩也做不了壞事」：
 *  1. 網址不由呼叫端給：url_on:true 寫死成 DUTY_PUSH_FIXED_URL_，url_on:false 寫空字串（dutyPushCfg_ 把空白當沒設＝不推、不計數）。
 *     push_cfg 裡其他欄位（url 等）一律忽略。
 *  2. 聯鎖：url_on:true＋dry:false（真的連外）要 DUTY_PUSH_KEY、DUTY_PUSH_STORE 都已設好（跟 dutyPushSend_ 的 skip_cfg 同一套標準），
 *     否則 need_key、屬性不動 → 沒金鑰時最多只能開到「只計數」。
 *  3. 只 setProperty DUTY_PUSH_URL、DUTY_PUSH_DRY 兩個；不刪、不碰金鑰與店代碼。回應只回狀態布林與店代碼。
 * 可重複呼叫（{url_on:false, dry:true}＝遠端關閉）。寫入順序：關＝先清網址；開＝先寫 DRY 再寫網址（中途不會出現「網址開、還是舊的非只計數」）。
 */
var DUTY_PUSH_FIXED_URL_ = 'https://dzy-gw.dingzhaoyuan888.workers.dev/store/svc/duty-push';   // 設計 2.4

function dutyPushCfgSet_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var c = body.push_cfg;
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.url_on !== 'boolean' || typeof c.dry !== 'boolean') return { ok: false, error: 'bad_input' };
  var urlOn = c.url_on === true, dry = c.dry === true;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, error: 'busy' };
  try {
    var props = PropertiesService.getScriptProperties();
    var keySet = String(props.getProperty('DUTY_PUSH_KEY') || '').length >= 32;
    var store = String(props.getProperty('DUTY_PUSH_STORE') || '').trim();
    var storeOk = /^[a-z0-9]{2,16}$/.test(store);
    if (urlOn && !dry && !(keySet && storeOk)) return { ok: false, error: 'need_key' };
    if (!urlOn) {
      props.setProperty('DUTY_PUSH_URL', '');
      props.setProperty('DUTY_PUSH_DRY', dry ? '1' : '0');
    } else {
      props.setProperty('DUTY_PUSH_DRY', dry ? '1' : '0');
      props.setProperty('DUTY_PUSH_URL', DUTY_PUSH_FIXED_URL_);
    }
    return { ok: true, push_cfg: { url_on: urlOn, dry: dry, key_set: keySet, store: storeOk ? store : '' } };
  } finally {
    lock.releaseLock();
  }
}

/* ── 每小時指紋（digest:true）：只回雜湊與列數 ── */
var DUTY_DIGEST_SECRET_COLS_ = { key: 1 };   // managers 的主管金鑰、roster 的同仁金鑰不算進雜湊

function dutyHash16_(x) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(x), Utilities.Charset.UTF_8)).slice(0, 16);
}
function dutyDigestCell_(v) { return v instanceof Date ? v.toISOString() : v; }

/** 有日期欄的分頁：範圍內每天一個雜湊（表頭也算進去）；rows＝整張的資料列數。 */
function dutyDigestDays_(ss, name, dateCol, from, to) {
  try {
    var sh = ss.getSheetByName(name);
    if (!sh) return { rows: 0, missing: true };
    var values = sh.getDataRange().getValues();
    var head = (values[0] || []).map(dutyDigestCell_), col = head.indexOf(dateCol), by = {};
    if (col < 0) return { rows: Math.max(0, values.length - 1), error: 'no_date_col' };
    for (var r = 1; r < values.length; r++) {
      var c = values[r][col];
      var d = c instanceof Date ? normCellDate(c) : String(c == null ? '' : c).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < from || d > to) continue;
      (by[d] = by[d] || []).push(values[r].map(dutyDigestCell_));
    }
    var days = {};
    Object.keys(by).sort().forEach(function (d) { days[d] = dutyHash16_([head, by[d]]); });
    return { rows: Math.max(0, values.length - 1), days: days };
  } catch (e) { return { error: 'read_failed' }; }
}

/** 沒有日期欄的分頁：整張一個雜湊（金鑰欄拿掉）。 */
function dutyDigestAll_(head, rows) {
  var keep = [];
  head.forEach(function (h, i) { if (!DUTY_DIGEST_SECRET_COLS_[String(h).trim().toLowerCase()]) keep.push(i); });
  var pick = function (row) { return keep.map(function (i) { return dutyDigestCell_(row[i]); }); };
  return { rows: rows.length, all: dutyHash16_([pick(head), rows.map(pick)]) };
}

/** digest:true：範圍＝上個月 1 號～今天（同副本範圍）。 */
function dutyDigest_(ss, mg, nowMs) {
  var today = dutyPushDay_(nowMs), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y--; }
  var from = y + '-' + ('0' + m).slice(-2) + '-01';
  var out = { from: from, to: today };
  out.events = dutyDigestDays_(ss, 'events', 'ts', from, today);
  out.approved = dutyDigestDays_(ss, 'approved', 'date', from, today);
  out.leave = dutyDigestDays_(ss, 'leave', '日期', from, today);
  out.requests = dutyDigestDays_(ss, typeof REQ_SHEET_ !== 'undefined' ? REQ_SHEET_ : 'requests', 'date', from, today);
  try {
    var rs = ss.getSheetByName('roster');
    if (!rs) out.roster = { rows: 0, missing: true };
    else { var rv = rs.getDataRange().getValues(); out.roster = dutyDigestAll_(rv[0] || [], rv.slice(1)); }
  } catch (e) { out.roster = { error: 'read_failed' }; }
  try {   // managers 剛才驗金鑰時已讀過（readSheetAsObjects），不再讀一次
    var mh = mg.headers || [];
    out.managers = dutyDigestAll_(mh, mg.rows.map(function (o) { return mh.map(function (h) { return o[h]; }); }));
  } catch (e) { out.managers = { error: 'read_failed' }; }
  return out;
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
