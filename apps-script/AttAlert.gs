/**
 * 考勤異常候補提醒 Phase 4（2026-11-07）：寄放、群組綁定、帶出、09:30 保底。
 * 規格：mala-store-ops docs/att-alert/spec.md（§8.1–8.5、8.8–8.11、8.13 優先於 §4）。
 *
 * 只有光復這套部署會啟用；九個打卡專案都會帶到這個檔，沒設 ATT_ALERT_SVC_KEY 的店完全無害：
 *   att_alert_start／att_alert_enqueue 回 not_enabled、webhook 掛勾回 false、保底函式直接 return。
 *
 * 只寫一個新分頁 att_alert_queue（一筆事件一列），絕不碰其他分頁。小狀態放指令碼屬性：
 *   ATT_ALERT_SVC_KEY  mini 呼叫用的金鑰（Eason 自己設；沒設＝這店沒啟用）
 *   ATT_GROUP_ID       綁定的行政群組
 *   ATT_BIND_CODE      一次性綁定碼 JSON {code, exp, fails}（30 分鐘；碼錯累計 5 次就刪）
 *   ATT_JOIN_LAST      最近 5 筆被拉進群組的記錄 JSON [{groupId, at}]（綁定要求發話群在其中且該筆 join 在 30 分鐘內）
 *   ATT_RUN_<日期>     當天狀態機 running／received／empty／guarded
 *   ATT_BATCH_<批次>   已收過的批次（冪等）
 *   ATT_EVT_<事件 id>  已處理過的 webhook 事件（保留 1 天）
 *   ATT_HAS_PENDING    '1'＝佇列可能有 pending 列；沒設時綁定群的訊息完全不讀試算表
 *   ATT_VERDICT_<事件 id>  帶出結果寫回拿不到鎖時暫存 {eventId, verdict, at}，保底觸發器補寫
 *   ATT_OUTBOX         要送通知匣的通知 JSON 陣列 [{title,text,key}]（key 去重、上限 20、文字截 200 字）；
 *                      webhook 路徑不打通知匣，保底觸發器每 5 分鐘送，ok===true&&added===true 才移除
 *   ATT_ARCHIVE_LAST   最近一次佇列封存的日期
 *   NOTIFY_INBOX_URL／NOTIFY_INBOX_TOKEN  通知匣（Eason 自己貼）
 *
 * 佇列封存：保底觸發器每天一次，把 delivered／superseded／unknown／truncated 且建立超過 7 天的列「刪除」
 * （不搬分頁）；enqueue／帶出只處理非終態（pending／inflight）列，分頁不會一直長大。
 *
 * ⚠ 已知限制：Apps Script 讀不到 X-Line-Signature，整個打卡 webhook 只靠 destination 比對（既有限制，不是這個檔新增的）。
 *   群組綁定靠：一次性碼（30 分鐘、碼錯 5 次即失效）＋發話群必須就是剛 join 的那個群（ATT_JOIN_LAST）＋
 *   綁定成功／被踢出都送通知匣（含群組 ID 末 6 碼），降低被偽造事件綁走的風險。
 *
 * 訊息版面（attAlertRenderMessage_）是 mini 端 server/att-digest-rules.js renderMessage 的逐行移植，
 * 同一份資料必須產生一樣的字串（tests/att-alert.test.js 把 mini 的輸出寫死在測試裡比對）。
 */
var ATT_ALERT_SHEET = 'att_alert_queue';
var ATT_ALERT_HEADERS = ['id', 'run_date', 'batch_id', 'seq', 'section', 'store', 'line', 'status', 'created_at', 'inflight_at', 'delivered_at', 'webhook_event_id'];
var ATT_ALERT_LINE_LIMIT = 5000;      // LINE 單則字數上限
var ATT_ALERT_MAX_MESSAGES = 5;
var ATT_ALERT_RECENT_DAYS = 3;        // 最近幾天的 daily 依日期分段
var ATT_ALERT_INFLIGHT_MS = 10 * 60 * 1000;
var ATT_ALERT_BIND_TTL_MS = 30 * 60 * 1000;
var ATT_ALERT_EVT_TTL_MS = 24 * 60 * 60 * 1000;
var ATT_ALERT_KEEP_DAYS = 40;         // ATT_BATCH_／ATT_RUN_ 指令碼屬性保留天數
var ATT_ALERT_MAX_ROWS = 3000;        // 單批上限
var ATT_ALERT_GUARD_TEXT = '今天考勤資料查不到，請到考勤管理查看';
var ATT_ALERT_GUARD_HM = '09:30';
var ATT_ALERT_LOOSE = ['state', 'sched', 'failed', 'notes', 'guard'];   // 新批次寫入時，舊的 pending 改 superseded
var ATT_ALERT_SECTIONS = ['daily', 'state', 'sched', 'failed', 'notes', 'guard'];

var ATT_ALERT_STORE_LABEL = { gf: '小辛辣光復', cf: '央廚', hq: '總部', mztjs: '墨竹亭金山', mztgf: '墨竹亭光復', mztlzl: '墨竹亭六張犁', mztmc: '墨竹亭台中美村' };

// ───────────────────────── 小工具 ─────────────────────────
function attAlertProps_() { return PropertiesService.getScriptProperties(); }
function attAlertNow_() { return new Date(); }
function attAlertDateStr_(d) { return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd'); }
function attAlertHm_(d) { return Utilities.formatDate(d, 'Asia/Taipei', 'HH:mm'); }
function attAlertIso_(d) { return Utilities.formatDate(d, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function attAlertValidDate_(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var t = Date.parse(d + 'T00:00:00Z');
  return isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}
/** run_date 合法：格式正確且不晚於台北今天（嚴格，不收明天）。不要求「是今天」——mini 跨日會原樣重送前一天未確認的批次（P3-13） */
function attAlertRunDateOk_(d) {
  return attAlertValidDate_(d) && d <= attAlertDateStr_(attAlertNow_());
}
function attAlertAddDays_(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function attAlertWeekday_(d) { return new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay(); }
function attAlertMmdd_(d) { return d.slice(5, 7) + '/' + d.slice(8, 10); }
/** 儲存格 → 字串（Date 物件轉台北日期時間；null → ''）。不用 instanceof（跨 realm 會判 false） */
function attAlertCell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return attAlertIso_(v);
  return String(v);
}
function attAlertEnabled_() { return !!attAlertProps_().getProperty('ATT_ALERT_SVC_KEY'); }
/** 通過回 null；否則回要給呼叫端的錯誤物件。沒設金鑰＝這店沒啟用（九店都帶這個檔，只有光復設金鑰） */
function attAlertAuth_(b) {
  var key = attAlertProps_().getProperty('ATT_ALERT_SVC_KEY');
  if (!key) return { ok: false, error: 'not_enabled' };
  if (typeof b.svcKey !== 'string' || b.svcKey !== key) return { ok: false, error: 'unauthorized' };
  return null;
}

// ───────────────────────── 分頁 ─────────────────────────
function attAlertSheet_() {
  var ss = getSS();
  var sh = ss.getSheetByName(ATT_ALERT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ATT_ALERT_SHEET);
    sh.getRange(1, 1, 1, ATT_ALERT_HEADERS.length).setNumberFormat('@').setValues([ATT_ALERT_HEADERS]);
  }
  return sh;
}
/** 讀整張佇列 → [{row（試算表列號）, id, run_date, ..., webhook_event_id}] */
function attAlertReadRows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, ATT_ALERT_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var o = { row: i + 2 };
    for (var c = 0; c < ATT_ALERT_HEADERS.length; c++) o[ATT_ALERT_HEADERS[c]] = attAlertCell_(vals[i][c]);
    if (!o.id) continue;
    out.push(o);
  }
  return out;
}
/** 狀態相關欄（status..webhook_event_id＝第 8–12 欄）寫回；相鄰的列合成一次 setValues */
function attAlertWriteStatus_(sh, changed) {
  var list = changed.slice().sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < list.length) {
    var j = i;
    while (j + 1 < list.length && list[j + 1].row === list[j].row + 1) j++;
    var block = [];
    for (var k = i; k <= j; k++) block.push([list[k].status, list[k].created_at, list[k].inflight_at, list[k].delivered_at, list[k].webhook_event_id]);
    sh.getRange(list[i].row, 8, block.length, 5).setNumberFormat('@').setValues(block);
    i = j + 1;
  }
}
function attAlertAppend_(sh, matrix) {
  if (!matrix.length) return;
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var need = start + matrix.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(start, 1, matrix.length, ATT_ALERT_HEADERS.length).setNumberFormat('@').setValues(matrix);
}

// ───────────────────────── att_alert_start ─────────────────────────
function handleAttAlertStart(b) {
  var bad = attAlertAuth_(b || {});
  if (bad) return bad;
  if (!attAlertRunDateOk_(b.run_date)) return { ok: false, error: 'bad_input' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    var p = attAlertProps_(), k = 'ATT_RUN_' + b.run_date, cur = p.getProperty(k);
    if (cur !== 'received' && cur !== 'empty' && cur !== 'guarded') p.setProperty(k, 'running');
    return { ok: true };
  } finally { lock.releaseLock(); }
}

// ───────────────────────── att_alert_enqueue ─────────────────────────
function attAlertStrList_(x) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return null;
  var out = [];
  for (var i = 0; i < x.length; i++) {
    if (typeof x[i] !== 'string') return null;
    if (x[i] !== '') out.push(x[i].slice(0, ATT_ALERT_LINE_LIMIT));
  }
  return out;
}
/** [{store, lines}] → [[store, line]…]；形狀不對回 null */
function attAlertEntries_(x) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return null;
  var out = [];
  for (var i = 0; i < x.length; i++) {
    var e = x[i];
    if (!e || typeof e.store !== 'string') return null;
    var lines = attAlertStrList_(e.lines);
    if (lines === null) return null;
    for (var j = 0; j < lines.length; j++) out.push([e.store, lines[j]]);
  }
  return out;
}
function handleAttAlertEnqueue(b) {
  b = b || {};
  var bad = attAlertAuth_(b);
  if (bad) return bad;
  if (!attAlertRunDateOk_(b.run_date) || typeof b.batch_id !== 'string' || !/^[0-9A-Za-z-]{1,64}$/.test(b.batch_id)) return { ok: false, error: 'bad_input' };
  var empty = b.empty === true;
  var spec = []; // [section, store, line]
  if (!empty) {
    var daily = attAlertEntries_(b.daily), state = attAlertEntries_(b.state);
    var sched = attAlertStrList_(b.sched), notes = attAlertStrList_(b.notes);
    var failed = [];
    if (b.failed_stores !== undefined && b.failed_stores !== null) {
      if (!Array.isArray(b.failed_stores)) return { ok: false, error: 'bad_input' };
      for (var i = 0; i < b.failed_stores.length; i++) {
        var f = b.failed_stores[i];
        if (typeof f === 'string') failed.push([f, '資料查不到']);
        else if (f && typeof f.store === 'string') failed.push([f.store, typeof f.reason === 'string' && f.reason ? f.reason.slice(0, 500) : '資料查不到']);
        else return { ok: false, error: 'bad_input' };
      }
    }
    if (daily === null || state === null || sched === null || notes === null) return { ok: false, error: 'bad_input' };
    daily.forEach(function (x) { spec.push(['daily', x[0], x[1]]); });
    state.forEach(function (x) { spec.push(['state', x[0], x[1]]); });
    sched.forEach(function (l) { spec.push(['sched', '', l]); });
    failed.forEach(function (x) { spec.push(['failed', x[0], x[1]]); });
    notes.forEach(function (l) { spec.push(['notes', '', l]); });
    if (spec.length > ATT_ALERT_MAX_ROWS) return { ok: false, error: 'too_big' };
    // 沒有任何可組字內容（只有 notes、或全空但沒帶 empty 旗標）→ 當 empty 處理：只 supersede、不寫列、不設旗標
    if (!spec.some(function (x) { return x[0] !== 'notes'; })) { empty = true; spec = []; }
  }
  var seq = Number(b.seq);
  var now = attAlertNow_();
  if (!(b.seq !== undefined && b.seq !== null && b.seq !== '' && isFinite(seq))) seq = now.getTime();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };   // mini 呼叫，可以等
  try {
    var p = attAlertProps_();
    var sh = attAlertSheet_();
    var rows = attAlertReadRows_(sh);
    var mine = rows.filter(function (r) { return r.batch_id === b.batch_id; });
    if (mine.length) {
      // 分頁已有這一批（上次只寫到一半）：補寫 superseded／狀態／批次記錄，再回 dup
      var s0 = Number(mine[0].seq);
      attAlertSupersede_(sh, rows, b.run_date, isFinite(s0) ? s0 : seq, b.batch_id);
      if (mine.some(function (r) { return r.status === 'pending'; })) p.setProperty('ATT_HAS_PENDING', '1');
      if (p.getProperty('ATT_RUN_' + b.run_date) !== 'received') p.setProperty('ATT_RUN_' + b.run_date, 'received');
      if (!p.getProperty('ATT_BATCH_' + b.batch_id)) p.setProperty('ATT_BATCH_' + b.batch_id, attAlertIso_(now));
      return { ok: true, dup: true };
    }
    if (p.getProperty('ATT_BATCH_' + b.batch_id)) return { ok: true, dup: true };
    var iso = attAlertIso_(now);
    var matrix = spec.map(function (s, n) {
      return [b.batch_id + '#' + n, b.run_date, b.batch_id, seq, s[0], s[1], s[2], 'pending', iso, '', '', ''];
    });
    // 寫入順序（出事時留下的是「可重送」的狀態）：①新批列 pending → ②舊列 superseded → ③ATT_RUN → ④ATT_BATCH
    attAlertAppend_(sh, matrix);
    attAlertSupersede_(sh, rows, b.run_date, seq, b.batch_id);
    if (matrix.length) p.setProperty('ATT_HAS_PENDING', '1');
    p.setProperty('ATT_RUN_' + b.run_date, empty ? 'empty' : 'received');
    p.setProperty('ATT_BATCH_' + b.batch_id, iso);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
/**
 * §8.3：新批（run_date, seq）只取代「比它更舊」的 pending state／sched／failed／notes／guard；daily 保留。
 * 更舊＝run_date 較早，或同 run_date 且 seq 較小；guard 只要 run_date ≤ 新批就取代（guard 的 seq 是 GAS 時鐘，不跟 mini 比）。
 * 舊日重送的批次因此不會取代今天的 guard 或較新的批次（P4-1）。rows 是呼叫前讀到的快照。
 */
function attAlertSupersede_(sh, rows, runDate, seq, batchId) {
  var changed = [];
  rows.forEach(function (r) {
    if (r.status !== 'pending' || ATT_ALERT_LOOSE.indexOf(r.section) < 0 || r.batch_id === batchId) return;
    var older = r.section === 'guard' ? r.run_date <= runDate
      : (r.run_date < runDate || (r.run_date === runDate && Number(r.seq) < seq));
    if (older) { r.status = 'superseded'; changed.push(r); }
  });
  if (changed.length) attAlertWriteStatus_(sh, changed);
}

// ───────────────────────── 訊息版面（mini renderMessage 的移植）─────────────────────────
function attAlertStoreCode_(c) { return (c === '' || c === null || c === undefined) ? 'gf' : String(c); }
function attAlertStoreLabel_(x) {
  var labels = Object.keys(ATT_ALERT_STORE_LABEL).map(function (c) { return ATT_ALERT_STORE_LABEL[c]; });
  if (labels.indexOf(x) >= 0) return x;
  return ATT_ALERT_STORE_LABEL[attAlertStoreCode_(x)] || String(x);
}
function attAlertStoreOrder_(a, b) {
  var order = Object.keys(ATT_ALERT_STORE_LABEL).map(function (c) { return ATT_ALERT_STORE_LABEL[c]; });
  var ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}
function attAlertMergeByStore_(entries) {
  var m = {}, keys = [];
  (entries || []).forEach(function (e) {
    if (!e) return;
    var store = attAlertStoreLabel_(e.store);
    var lines = (e.lines || []).filter(Boolean);
    if (!lines.length) return;
    if (!m[store]) { m[store] = []; keys.push(store); }
    Array.prototype.push.apply(m[store], lines);
  });
  return keys.sort(attAlertStoreOrder_).map(function (store) { return { store: store, lines: m[store] }; });
}
function attAlertNormFailed_(list) {
  var byS = {}, keys = [];
  (list || []).forEach(function (f) {
    if (f === null || f === undefined) return;
    var store = attAlertStoreLabel_(typeof f === 'string' ? f : f.store);
    var reason = (typeof f === 'object' && f.reason) || '資料查不到';
    if (!byS[store]) { byS[store] = []; keys.push(store); }
    String(reason).split('、').forEach(function (r) { if (byS[store].indexOf(r) < 0) byS[store].push(r); });
  });
  return keys.map(function (s) { return { store: s, reason: byS[s].join('、') }; }).sort(function (a, b) { return attAlertStoreOrder_(a.store, b.store); });
}
/**
 * batches＝一個或多個 buildPayload 形狀的批次（含 seq、empty）。opts:{today?, limit?, maxMessages?, guardLines?}
 * guardLines（GAS 專有）：09:30 保底的句子，印在尾端「請各單位…」之前、前面加「⚠ 」；沒有 guardLines 時與 mini 輸出逐字相同。
 * @returns {string[]|{error}} 訊息陣列（空陣列＝沒有要發的）
 */
function attAlertRenderMessage_(batches, opts) {
  opts = opts || {};
  var limit = opts.limit || ATT_ALERT_LINE_LIMIT, maxMsg = opts.maxMessages || ATT_ALERT_MAX_MESSAGES;
  var guardLines = (opts.guardLines || []).filter(Boolean);
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  var seqOf = function (b) { var n = Number(b.seq); return b.seq !== null && b.seq !== undefined && b.seq !== '' && isFinite(n) ? n : -Infinity; };
  var list = (Array.isArray(batches) ? batches : [batches]).filter(Boolean).map(function (b, i) { return { b: b, i: i }; })
    .sort(function (x, y) {
      var sx = seqOf(x.b), sy = seqOf(y.b);
      if (sx !== sy) return sx < sy ? -1 : 1;
      if (x.b.run_date !== y.b.run_date) return x.b.run_date < y.b.run_date ? -1 : 1;
      return x.i - y.i;
    }).map(function (x) { return x.b; });
  if (!list.length) return [];
  if (list.some(function (b) { return !attAlertValidDate_(b.run_date); }) || (opts.today !== null && opts.today !== undefined && !attAlertValidDate_(opts.today))) return { error: 'bad_date' };
  var latest = list[list.length - 1];
  var today = opts.today || latest.run_date;
  var recentFrom = attAlertAddDays_(today, -(ATT_ALERT_RECENT_DAYS - 1));
  if (opts.info) { opts.info.latest = latest.run_date; opts.info.recentFrom = recentFrom; }   // GAS 專有：讓呼叫端知道哪些列被印出

  var dailyBy = {};   // run_date → entries
  list.forEach(function (b) {
    if (b.empty) return;
    if (!dailyBy[b.run_date]) dailyBy[b.run_date] = [];
    Array.prototype.push.apply(dailyBy[b.run_date], b.daily || []);
  });
  var state = latest.empty ? [] : attAlertMergeByStore_(latest.state);
  var failed = latest.empty ? [] : attAlertNormFailed_(latest.failed_stores);
  var latestDaily = latest.empty ? [] : attAlertMergeByStore_(dailyBy[latest.run_date]);

  var sections = [];   // {head, bullets[]}
  var seen = {}, stores = [];
  state.concat(latestDaily).forEach(function (e) { if (!seen[e.store]) { seen[e.store] = 1; stores.push(e.store); } });
  stores.sort(attAlertStoreOrder_);
  stores.forEach(function (s) {
    var a = (state.filter(function (e) { return e.store === s; })[0] || {}).lines || [];
    var bb = (latestDaily.filter(function (e) { return e.store === s; })[0] || {}).lines || [];
    sections.push({ head: '▍' + s, bullets: a.concat(bb) });
  });
  var earlier = [];
  Object.keys(dailyBy).filter(function (x) { return x !== latest.run_date; }).sort().reverse().forEach(function (d) {
    attAlertMergeByStore_(dailyBy[d]).forEach(function (e) {
      if (d >= recentFrom) sections.push({ head: '▍' + attAlertMmdd_(d) + ' ' + e.store, bullets: e.lines });
      else e.lines.forEach(function (l) { earlier.push(e.store + ' ' + l); });
    });
  });
  if (earlier.length) sections.push({ head: '▍更早未帶出', bullets: earlier });
  var schedLines = latest.empty ? [] : (latest.sched || []);
  // sched 區：以「▍」開頭的行是段落標題（本期班表／下一期班表）；標題前的行（舊版 payload）歸「▍班表」
  var schedSec = null;
  schedLines.forEach(function (l) {
    if (typeof l === 'string' && l.indexOf('▍') === 0) { schedSec = { head: l, bullets: [] }; sections.push(schedSec); return; }
    if (!schedSec) { schedSec = { head: '▍班表', bullets: [] }; sections.push(schedSec); }
    schedSec.bullets.push(l);
  });
  var live = sections.filter(function (s) { return s.bullets.length; });
  if (!live.length && !failed.length && !guardLines.length) return [];

  var first = list.map(function (b) { return b.run_date; }).sort()[0];
  var lastDate = opts.lastDate || latest.run_date;   // lastDate 是 GAS 專有（保底列的日期要進標題區間）
  var title = first === lastDate
    ? '【考勤異常】' + attAlertMmdd_(lastDate) + '（' + WD[attAlertWeekday_(lastDate)] + '）'
    : '【考勤異常】' + attAlertMmdd_(first) + '–' + attAlertMmdd_(lastDate);
  var tail = ['請各單位到「考勤管理」處理。'];
  if (failed.length) {
    tail.unshift('⚠ 這些單位今天資料查不到：' + failed.map(function (f) { return f.reason === '資料查不到' ? f.store : f.store + '（' + f.reason + '）'; }).join('、'));
  }
  (latest.empty ? [] : (latest.notes || [])).forEach(function (n) { tail.splice(tail.length - 1, 0, '⚠ ' + n); });   // 註記放在「請各單位…」之前
  guardLines.forEach(function (g) { tail.splice(tail.length - 1, 0, '⚠ ' + g); });
  var tailText = '\n\n' + tail.join('\n');
  var total = live.reduce(function (n, s) { return n + s.bullets.length; }, 0);

  // 單一 bullet 過長：截斷到放得進一則（上限 4990 字＋「…」）
  var maxHead = Math.max.apply(null, [0].concat(live.map(function (s) { return s.head.length; })));
  var lineMax = Math.min(4990, limit - title.length - maxHead - 4);
  live.forEach(function (s) { s.bullets = s.bullets.map(function (x) { return x.length + 1 > lineMax ? x.slice(0, lineMax - 2) + '…' : x; }); });
  // 貪心裝箱；續則補上段落標題。reserve＝最後一則預留給「還有 N 筆」與尾端的字數。
  var pack = function (reserve) {
    var msgs = [];
    var cur = title, curHead = null, shown = 0, stopped = false;
    var cap = function () { return msgs.length === maxMsg - 1 ? limit - reserve : limit; };
    outer:
    for (var si = 0; si < live.length; si++) {
      var s = live[si];
      for (var bi = 0; bi < s.bullets.length; bi++) {
        var line = '・' + s.bullets[bi];
        var add = curHead === s.head ? '\n' + line : '\n\n' + s.head + '\n' + line;
        if (cur.length + add.length > cap()) {
          if (msgs.length === maxMsg - 1) { stopped = true; break outer; }
          msgs.push(cur);
          cur = '';
          add = s.head + '\n' + line;
          if (add.length > cap()) { stopped = true; break outer; }
        }
        cur += add; curHead = s.head; shown++;
      }
    }
    return { msgs: msgs, cur: cur, shown: shown, stopped: stopped };
  };

  var r = pack(0);
  if (!r.stopped) {
    var msgs = r.msgs;
    if (r.cur.length + tailText.length <= limit) msgs.push(r.cur + tailText);
    else msgs.push(r.cur, tail.join('\n'));
    if (msgs.length <= maxMsg) return msgs;
  }
  var notice = function (n) { return '\n\n…還有 ' + n + ' 筆，請到考勤管理查看'; };
  r = pack(notice(9999999).length + tailText.length);
  r.msgs.push((r.cur + notice(total - r.shown) + tailText).replace(/^\n+/, ''));
  return r.msgs;
}

/** 佇列列 → 批次（renderMessage 的輸入）；guard 列另外回傳 */
function attAlertRowsToBatches_(rows) {
  var map = {}, batches = [], guards = [];
  var addTo = function (arr, store, line) {
    var hit = arr.filter(function (e) { return e.store === store; })[0];
    if (!hit) { hit = { store: store, lines: [] }; arr.push(hit); }
    hit.lines.push(line);
  };
  rows.forEach(function (r) {
    if (r.section === 'guard') { guards.push(r); return; }
    var b = map[r.batch_id];
    if (!b) {
      var n = r.seq === '' ? NaN : Number(r.seq);
      b = map[r.batch_id] = { run_date: r.run_date, daily: [], state: [], sched: [], failed_stores: [], notes: [] };
      if (isFinite(n)) b.seq = n;
      batches.push(b);
    }
    if (r.section === 'daily') addTo(b.daily, r.store, r.line);
    else if (r.section === 'state') addTo(b.state, r.store, r.line);
    else if (r.section === 'sched') b.sched.push(r.line);
    else if (r.section === 'failed') b.failed_stores.push({ store: r.store, reason: r.line });
    else if (r.section === 'notes') b.notes.push(r.line);
  });
  batches.forEach(function (b) { if (!b.notes.length) delete b.notes; });
  return { batches: batches, guards: guards };
}
/** 本次要帶出的列 → 訊息陣列（或 {error}）。today＝max(佇列最大 run_date, 台北今天)（P4-2）。info 選填：回填 {latest, recentFrom} */
function attAlertCompose_(rows, info) {
  var x = attAlertRowsToBatches_(rows);
  var batches = x.batches.slice();
  var dates = batches.map(function (b) { return b.run_date; });
  var guardLines = [];
  if (x.guards.length) {
    // 保底列只加尾端提醒；用一個最早排序、沒有內容的批次帶出日期，不影響其他批次的「最新」判斷
    x.guards.forEach(function (g) { if (guardLines.indexOf(g.line) < 0) guardLines.push(g.line); dates.push(g.run_date); });
    batches.push({ run_date: x.guards[x.guards.length - 1].run_date, daily: [], state: [], sched: [], failed_stores: [] });
  }
  // 前一天 daily 還沒帶出、今天 mini 送了 empty 批（empty 批不寫列，只留 ATT_RUN_<日期>＝empty）：
  // mini renderMessage 會把 empty 批當「最新批」（標題區間含今天、殘留 daily 依日期分小段），這裡補一個虛擬 empty 批照同一規則走
  if (batches.length) {
    var allP = {};
    try { allP = attAlertProps_().getProperties() || {}; } catch (e) { allP = {}; }
    var rowMax = dates.slice().sort().pop(), emptyDate = null;
    Object.keys(allP).forEach(function (k) {
      var m = /^ATT_RUN_(\d{4}-\d{2}-\d{2})$/.exec(k);
      if (m && allP[k] === 'empty' && m[1] > rowMax && (emptyDate === null || m[1] > emptyDate)) emptyDate = m[1];
    });
    if (emptyDate) { batches.push({ run_date: emptyDate, empty: true, seq: Number.MAX_SAFE_INTEGER }); dates.push(emptyDate); }
  }
  if (!batches.length) return [];
  var maxDate = dates.slice().sort().pop();
  var today = attAlertDateStr_(attAlertNow_());
  return attAlertRenderMessage_(batches, { today: maxDate > today ? maxDate : today, lastDate: maxDate, guardLines: guardLines, info: info });
}
/**
 * 被截斷（沒印進任何一則）的列 id。比對印出的「・」行：每個列算出它的 bullet 文字（跟版面同一規則），
 * 在印出的行裡找得到（數量也要夠）才算印出；單行過長被截成「…」結尾的，用前綴比對。failed／notes／guard 是尾端，一定印出。
 */
function attAlertHiddenIds_(claimed, msgs, info) {
  var seen = {}, shown = [];
  var heads = {};   // 印出的段落標題行（「▍」開頭）原樣
  msgs.forEach(function (m) { String(m).split('\n').forEach(function (l) {
    if (l.indexOf('・') === 0) { shown.push(l.slice(1)); seen[l.slice(1)] = (seen[l.slice(1)] || 0) + 1; }
    else if (l.indexOf('▍') === 0) heads[l] = true;
  }); });
  var hidden = [];
  claimed.forEach(function (r) {
    var t;
    if (r.section === 'daily') t = (r.run_date === info.latest || r.run_date >= info.recentFrom) ? r.line : attAlertStoreLabel_(r.store) + ' ' + r.line;
    else if (r.section === 'state' || r.section === 'sched') {
      // sched 段標題（「▍」開頭）在版面上是標題行不是「・」行：以標題原樣比對，印出了就算 delivered
      if (r.section === 'sched' && typeof r.line === 'string' && r.line.indexOf('▍') === 0) { if (!heads[r.line]) hidden.push(r.id); return; }
      t = r.line;
    } else return;
    if (seen[t] > 0) { seen[t]--; return; }
    for (var i = 0; i < shown.length; i++) {
      var sx = shown[i];
      if (seen[sx] > 0 && sx.slice(-1) === '…' && t.length >= sx.length && t.indexOf(sx.slice(0, -1)) === 0) { seen[sx]--; return; }
    }
    hidden.push(r.id);
  });
  return hidden;
}
// ───────────────────────── 通知匣（§8.11；照 inboxNotify_ 的接法，網址與 token 讀指令碼屬性）─────────────────────────
/** 真正打通知匣（只有保底觸發器的 outbox 會呼叫）。keyEvent 例：'guard:2026-11-23'（冒號分段，每段只留小寫英數與連字號）→ key＝att-alert:guard:2026-11-23。
 *  不拋例外；成功判準 ok===true && added===true */
function attAlertInbox_(title, text, keyEvent) {
  try {
    var p = attAlertProps_();
    var tok = p.getProperty('NOTIFY_INBOX_TOKEN'), url = p.getProperty('NOTIFY_INBOX_URL');
    if (!tok || !url) return false;
    var parts = String(keyEvent || 'event').split(':').map(function (s) { return s.toLowerCase().replace(/[^a-z0-9-]/g, ''); }).filter(Boolean);
    var payload = JSON.stringify({
      action: 'add', token: tok, from: 'att-alert', title: String(title).slice(0, 60),
      text: String(text).slice(0, 1000), level: 'normal', key: ['att-alert'].concat(parts).join(':'),
    });
    for (var i = 0; i < 2; i++) {
      try {
        var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() === 200) {
          var d = JSON.parse(res.getContentText());
          if (d && d.ok === true && d.added === true) return true;
        }
      } catch (err) {
        console.warn('att-alert 通知匣第 ' + (i + 1) + ' 次寫入失敗：' + err);
      }
    }
  } catch (err2) {
    console.error('att-alert 通知匣例外：' + err2);
  }
  return false;
}
var ATT_ALERT_OUTBOX_MAX = 20;
function attAlertOutboxRead_() {
  try { var v = JSON.parse(attAlertProps_().getProperty('ATT_OUTBOX') || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
/** webhook 路徑上不呼叫通知匣：只把要送的通知記進 ATT_OUTBOX（key 去重、上限 20、文字截 200 字，守住指令碼屬性 9KB）。不拋例外。 */
function attAlertNotify_(title, text, keyEvent) {
  var lock = LockService.getScriptLock(), got = false;
  try {
    got = lock.tryLock(500);   // 拿不到也照寫（最壞是少一筆通知，不能讓通知拖住打卡）
    var list = attAlertOutboxRead_(), key = String(keyEvent || 'event');
    if (!list.some(function (x) { return x.key === key; })) {
      list.push({ title: String(title).slice(0, 60), text: String(text).slice(0, 200), key: key });
      while (list.length > ATT_ALERT_OUTBOX_MAX) list.shift();
      attAlertProps_().setProperty('ATT_OUTBOX', JSON.stringify(list));
    }
  } catch (e) {
    console.error('att-alert outbox 寫入失敗：' + e);
  } finally { if (got) lock.releaseLock(); }
}
/** 保底觸發器：送 outbox，通知匣回 ok===true&&added===true 才移除；沒送成的留著下次 */
function attAlertFlushOutbox_() {
  var list = attAlertOutboxRead_();
  if (!list.length) return;
  var sent = {}, any = false;
  list.forEach(function (x) { if (attAlertInbox_(x.title, x.text, x.key)) { sent[x.key] = true; any = true; } });
  if (!any) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // 下次再送一次，通知匣同一天同 key 會合併
  try {
    var left = attAlertOutboxRead_().filter(function (x) { return !sent[x.key]; });
    if (left.length) attAlertProps_().setProperty('ATT_OUTBOX', JSON.stringify(left));
    else attAlertProps_().deleteProperty('ATT_OUTBOX');
  } finally { lock.releaseLock(); }
}

// ───────────────────────── 群組綁定（§8.9）─────────────────────────
/** 只能在 Apps Script 編輯器手動執行：產生 6 位數綁定碼（30 分鐘），用 Logger.log 印出。webhook 與任何動作都叫不到它。 */
function attAlertIssueBindCode() {
  if (!attAlertEnabled_()) { Logger.log('這個部署沒有設 ATT_ALERT_SVC_KEY（未啟用考勤提醒），不產生綁定碼'); return null; }
  var n = 0;
  try { n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000; } catch (e) { n = Math.floor(Math.random() * 900000); }
  var code = String(100000 + n);
  attAlertProps_().setProperty('ATT_BIND_CODE', JSON.stringify({ code: code, exp: attAlertNow_().getTime() + ATT_ALERT_BIND_TTL_MS, fails: 0 }));
  Logger.log('考勤提醒綁定碼：' + code + '（30 分鐘內有效）。先把機器人拉進行政群組，再在那個群組輸入：綁定考勤提醒 ' + code);
  return code;
}
function attAlertJoinList_() {
  var j = null;
  try { j = JSON.parse(attAlertProps_().getProperty('ATT_JOIN_LAST') || 'null'); } catch (e) { j = null; }
  if (j && !Array.isArray(j)) j = [j];   // 舊格式（單一物件）
  return (j || []).filter(function (x) { return x && x.groupId; });
}
/** 發話群在最近 5 筆 join 裡，且該筆 join 在 30 分鐘內 */
function attAlertJoinOk_(groupId, nowMs) {
  if (!groupId) return false;
  return attAlertJoinList_().some(function (j) {
    var t = Date.parse(j.at);
    return j.groupId === groupId && isFinite(t) && nowMs - t <= ATT_ALERT_BIND_TTL_MS && nowMs - t >= -60000;
  });
}
/**
 * 群裡「綁定考勤提醒 <6 碼>」。回 true＝這句是綁定口令（不論成功與否都不再往下處理）。
 * 全部成立才綁：碼正確且未過期、ATT_GROUP_ID 空、發話群＝ATT_JOIN_LAST 且 join 在 30 分鐘內。
 * 有未過期的碼時，任何不成立的嘗試都累計一次失敗，滿 5 次就刪 ATT_BIND_CODE（要重新產生）。碼錯、過期、已綁定都不回應。
 */
function attAlertTryBind_(ev, groupId) {
  var m = ev.message && ev.message.type === 'text' ? /^綁定考勤提醒\s+(\d{6})$/.exec(String(ev.message.text || '').trim()) : null;
  if (!m) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return true;
  var ok = false;
  try {
    var p = attAlertProps_(), nowMs = attAlertNow_().getTime();
    var raw = p.getProperty('ATT_BIND_CODE'), rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
    if (!p.getProperty('ATT_GROUP_ID') && rec && Number(rec.exp) >= nowMs) {
      if (rec.code === m[1] && groupId && attAlertJoinOk_(groupId, nowMs)) {
        p.setProperty('ATT_GROUP_ID', groupId);
        p.deleteProperty('ATT_BIND_CODE');
        ok = true;
      } else {
        rec.fails = (Number(rec.fails) || 0) + 1;
        if (rec.fails >= 5) p.deleteProperty('ATT_BIND_CODE');
        else p.setProperty('ATT_BIND_CODE', JSON.stringify(rec));
      }
    }
  } finally { lock.releaseLock(); }
  if (ok) {
    try { attAlertReply_(ev.replyToken, ['已綁定，之後考勤異常會發在這裡']); } catch (e2) { console.error('att-alert 綁定回覆失敗：' + e2); }
    attAlertNotify_('考勤提醒已綁定到群組', '考勤提醒已綁定到群組（群組 ID 末 6 碼：' + groupId.slice(-6) + '）。不是你綁的請立刻到指令碼屬性刪除 ATT_GROUP_ID。', 'bound:' + attAlertDateStr_(attAlertNow_()));
    // 綁定前就已經寄放的內容：把旗標補回來，下一句話就能帶出
    try {
      var sh = getSS().getSheetByName(ATT_ALERT_SHEET);
      if (sh && attAlertReadRows_(sh).some(function (r) { return r.status === 'pending'; })) attAlertProps_().setProperty('ATT_HAS_PENDING', '1');
    } catch (e3) { console.error('att-alert 綁定後補旗標失敗：' + e3); }
  }
  return true;
}

// ───────────────────────── webhook 掛勾（T16）與帶出（§8.5）─────────────────────────
/** LINE reply；回 HTTP 狀態碼，沒有 token 或 replyToken 回 0（沒送出）。逾時／網路例外直接丟出，由呼叫端判成「結果不明」。 */
function attAlertReply_(replyToken, texts) {
  var token = (typeof LINE_HUB_BOT_TOKEN !== 'undefined') ? LINE_HUB_BOT_TOKEN : '';
  if (!token || !replyToken) return 0;
  var resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: texts.slice(0, ATT_ALERT_MAX_MESSAGES).map(function (t) { return { type: 'text', text: String(t) }; }) }),
  });
  return resp && resp.getResponseCode ? resp.getResponseCode() : 0;
}
/**
 * 只處理「群組」事件（LineHub.gs 在私訊全部處理完之後才呼叫）。處理了回 true，沒處理回 false。
 * 沒啟用的店、非綁定群組的訊息、私訊一律回 false。可能丟例外：呼叫端要 try/catch。
 */
function attAlertOnEvent_(ev) {
  if (!ev || !ev.source || ev.source.type !== 'group') return false;
  if (!attAlertEnabled_()) return false;
  var gid = String(ev.source.groupId || '');
  var p = attAlertProps_();
  if (ev.type === 'join') {
    if (gid) {
      var js = attAlertJoinList_().filter(function (x) { return x.groupId !== gid; });
      js.push({ groupId: gid, at: attAlertIso_(attAlertNow_()) });
      p.setProperty('ATT_JOIN_LAST', JSON.stringify(js.slice(-5)));
    }
    return true;
  }
  var bound = p.getProperty('ATT_GROUP_ID') || '';
  if (ev.type === 'leave') {
    if (!gid || gid !== bound) return false;
    // 機器人被踢出綁定群：解除綁定（佇列不動），要重新綁
    p.deleteProperty('ATT_GROUP_ID'); p.deleteProperty('ATT_HAS_PENDING');
    attAlertNotify_('考勤提醒機器人被移出行政群', '考勤提醒機器人被移出行政群，需重新綁定（到編輯器執行 attAlertIssueBindCode，再把機器人拉回群組）。', 'left:' + attAlertDateStr_(attAlertNow_()));
    return true;
  }
  if (ev.type !== 'message') return false;
  if (!bound) return attAlertTryBind_(ev, gid);
  if (gid !== bound) return false;
  attAlertDeliver_(ev);
  return true;
}
function attAlertDeliver_(ev) {
  var p = attAlertProps_();
  if (!p.getProperty('ATT_HAS_PENDING')) return;   // 沒有寄放內容：完全不讀試算表
  var evId = String(ev.webhookEventId || '');
  if (evId && p.getProperty('ATT_EVT_' + evId)) return;
  if (!ev.replyToken) return;
  var sh = getSS().getSheetByName(ATT_ALERT_SHEET);
  if (!sh) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;   // 拿不到鎖就算了，下一句話再帶
  var nowMs = attAlertNow_().getTime();
  var eid = evId || ('noid-' + nowMs);
  var claimed = [];
  try {
    if (evId && p.getProperty('ATT_EVT_' + evId)) return;
    var rows = attAlertReadRows_(sh), iso = attAlertIso_(attAlertNow_()), changed = [];
    rows.forEach(function (r) {
      if (r.status === 'pending') { r.status = 'inflight'; r.inflight_at = iso; r.webhook_event_id = eid; claimed.push(r); changed.push(r); }
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
    p.deleteProperty('ATT_HAS_PENDING');   // 所有 pending 都已認領；結果是 pending 的會在寫回時補旗標
    if (evId) p.setProperty('ATT_EVT_' + evId, String(nowMs));
  } finally { lock.releaseLock(); }
  if (!claimed.length) return;

  var verdict = 'pending';   // pending＝沒送出去、等下一句；delivered；unknown
  var hidden = [];
  try {
    var info = {};
    var msgs = attAlertCompose_(claimed, info);
    if (!Array.isArray(msgs) || !msgs.length) {
      if (Array.isArray(msgs)) verdict = 'superseded';   // 組出來是空的：這些列沒東西可講，改 superseded、不回話（旗標已清）
      else console.error('att-alert 日期錯誤，保留 pending');
    } else {
      var code = attAlertReply_(ev.replyToken, msgs);
      if (code >= 200 && code < 300) { verdict = 'delivered'; hidden = attAlertHiddenIds_(claimed, msgs, info); }
      else if (code >= 400 && code < 500) verdict = 'pending';   // 明確失敗（replyToken 失效等）
      else if (code === 0) verdict = 'pending';                   // 根本沒送
      else verdict = 'unknown';
    }
  } catch (e) {
    console.error('att-alert 帶出例外，結果不明：' + e);
    verdict = 'unknown';
  }
  attAlertFinish_(claimed, eid, verdict, hidden);
  if (verdict === 'unknown') attAlertNotify_('考勤提醒帶出結果不明', '考勤異常提醒送出時逾時或出錯，不知道群組有沒有收到，不會自動重發，請到考勤管理確認。', 'unknown:' + claimed[0].run_date);
}
/** 帶出結果寫回：只改還是 inflight、且事件 id 對得上的那幾列；delivered 但沒印出的列記 truncated（終態，不重發）。
 *  拿不到鎖（500ms）就把 {eventId, verdict} 存進 ATT_VERDICT_<事件 id>，由保底觸發器補寫（此時截斷標記不補，一律當 delivered）。 */
function attAlertFinish_(claimed, eid, verdict, hidden) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) {
    try { attAlertProps_().setProperty('ATT_VERDICT_' + eid, JSON.stringify({ eventId: eid, verdict: verdict, at: attAlertNow_().getTime() })); }
    catch (e) { console.error('att-alert 結果暫存失敗，列維持 inflight：' + e); }
    return;
  }
  try {
    var sh = attAlertSheet_();
    var ids = {}, hid = {};
    claimed.forEach(function (r) { ids[r.id] = true; });
    (hidden || []).forEach(function (id) { hid[id] = true; });
    var iso = attAlertIso_(attAlertNow_()), changed = [];
    attAlertReadRows_(sh).forEach(function (r) {
      if (!ids[r.id] || r.status !== 'inflight' || r.webhook_event_id !== eid) return;
      r.status = (verdict === 'delivered' && hid[r.id]) ? 'truncated' : verdict;
      if (verdict === 'delivered') r.delivered_at = iso;
      if (verdict === 'pending') { r.inflight_at = ''; r.webhook_event_id = ''; }
      changed.push(r);
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
    if (verdict === 'pending') attAlertProps_().setProperty('ATT_HAS_PENDING', '1');
  } finally { lock.releaseLock(); }
}

// ───────────────────────── 保底觸發器（§8.4）與每 5 分鐘的維護 ─────────────────────────
/** 補寫 ATT_VERDICT_*（帶出結果寫回當時拿不到鎖） */
function attAlertApplyVerdicts_() {
  var p = attAlertProps_(), all = p.getProperties() || {}, pend = [];
  Object.keys(all).forEach(function (k) { if (k.indexOf('ATT_VERDICT_') === 0) { try { pend.push({ k: k, v: JSON.parse(all[k]) }); } catch (e) { p.deleteProperty(k); } } });
  if (!pend.length) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  var unknownDates = [];
  try {
    var sh = attAlertSheet_(), rows = attAlertReadRows_(sh), iso = attAlertIso_(attAlertNow_()), changed = [], anyPending = false;
    pend.forEach(function (x) {
      rows.forEach(function (r) {
        if (r.status !== 'inflight' || r.webhook_event_id !== x.v.eventId) return;
        r.status = x.v.verdict;
        if (x.v.verdict === 'delivered') r.delivered_at = iso;
        if (x.v.verdict === 'pending') { r.inflight_at = ''; r.webhook_event_id = ''; anyPending = true; }
        if (x.v.verdict === 'unknown') unknownDates.push(r.run_date);
        changed.push(r);
      });
      p.deleteProperty(x.k);
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
    if (anyPending) p.setProperty('ATT_HAS_PENDING', '1');
  } finally { lock.releaseLock(); }
  if (unknownDates.length) attAlertNotify_('考勤提醒帶出結果不明', '考勤異常提醒送出時結果不明，不會自動重發，請到考勤管理確認。', 'unknown:' + unknownDates[0]);
}
/** inflight 超過 10 分鐘還沒結果 → unknown（不重發），進 outbox 通知 */
function attAlertSweepStale_(now) {
  var sh = getSS().getSheetByName(ATT_ALERT_SHEET);
  if (!sh) return;
  var ms = now.getTime();
  var p0 = attAlertProps_();
  // 已有 ATT_VERDICT_<事件 id> 的列交給補寫處理，不在這裡判 unknown
  var stale = function (r) { var t = Date.parse(r.inflight_at); return r.status === 'inflight' && !p0.getProperty('ATT_VERDICT_' + r.webhook_event_id) && (!isFinite(t) || ms - t > ATT_ALERT_INFLIGHT_MS); };
  if (!attAlertReadRows_(sh).some(stale)) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  var first = null;
  try {
    var changed = [];
    attAlertReadRows_(sh).forEach(function (r) { if (stale(r)) { r.status = 'unknown'; changed.push(r); if (!first) first = r.run_date; } });
    if (changed.length) attAlertWriteStatus_(sh, changed);
  } finally { lock.releaseLock(); }
  if (first) attAlertNotify_('考勤提醒有幾筆帶出結果不明', '有提醒卡在帶出中超過 10 分鐘，不會自動重發，請到考勤管理確認。', 'unknown:' + first);
}
var ATT_ALERT_TERMINAL = ['delivered', 'superseded', 'unknown', 'truncated'];
var ATT_ALERT_ARCHIVE_DAYS = 7;
/** 每天一次：終態列（delivered／superseded／unknown／truncated）建立超過 7 天 → 刪除（不搬分頁） */
function attAlertArchive_(now) {
  var p = attAlertProps_(), today = attAlertDateStr_(now);
  if (p.getProperty('ATT_ARCHIVE_LAST') === today) return;
  var sh = getSS().getSheetByName(ATT_ALERT_SHEET);
  if (!sh) { p.setProperty('ATT_ARCHIVE_LAST', today); return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var cut = now.getTime() - ATT_ALERT_ARCHIVE_DAYS * 86400000;
    var del = attAlertReadRows_(sh).filter(function (r) { var t = Date.parse(r.created_at); return ATT_ALERT_TERMINAL.indexOf(r.status) >= 0 && isFinite(t) && t < cut; })
      .map(function (r) { return r.row; }).sort(function (a, b) { return b - a; });
    var i = 0;
    while (i < del.length) {   // 由下往上，連續的列一次刪
      var j = i;
      while (j + 1 < del.length && del[j + 1] === del[j] - 1) j++;
      sh.deleteRows(del[j], j - i + 1);
      i = j + 1;
    }
    p.setProperty('ATT_ARCHIVE_LAST', today);
  } finally { lock.releaseLock(); }
}
/** 時間觸發器每 5 分鐘呼叫。先做維護（補寫結果、逾時 inflight、清屬性、封存），再看 09:30 保底，最後送 outbox。 */
function attAlertGuard() {
  if (!attAlertEnabled_()) return;
  var now = attAlertNow_();
  [attAlertApplyVerdicts_, attAlertSweepStale_, attAlertCleanProps_, attAlertArchive_, attAlertGuardWindow_].forEach(function (fn) {
    try { fn(now); } catch (e) { console.error('att-alert 維護失敗（' + fn.name + '）：' + e); }
  });
  try { attAlertFlushOutbox_(); } catch (e2) { console.error('att-alert outbox 失敗：' + e2); }
}
/** 台北 ≥09:30 且今天狀態不是 received／empty／guarded → 寫一筆 guard（固定 batch_id guard-<日期>）、設 guarded、通知進 outbox */
function attAlertGuardWindow_(now) {
  if (attAlertHm_(now) < ATT_ALERT_GUARD_HM) return;
  var today = attAlertDateStr_(now);
  var p = attAlertProps_(), key = 'ATT_RUN_' + today;
  var done = function (s) { return s === 'received' || s === 'empty' || s === 'guarded'; };
  if (done(p.getProperty(key))) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // 下個 5 分鐘再來
  var wrote = false;
  try {
    if (!done(p.getProperty(key))) {
      var iso = attAlertIso_(now), bid = 'guard-' + today, sh = attAlertSheet_();
      if (!attAlertReadRows_(sh).some(function (r) { return r.batch_id === bid; })) {   // 已有就只補 ATT_RUN
        attAlertAppend_(sh, [[bid + '#0', today, bid, now.getTime(), 'guard', '', ATT_ALERT_GUARD_TEXT, 'pending', iso, '', '', '']]);
        p.setProperty('ATT_HAS_PENDING', '1');
        wrote = true;
      }
      p.setProperty(key, 'guarded');
    }
  } finally { lock.releaseLock(); }
  if (wrote) attAlertNotify_('今天考勤資料查不到', '09:30 還沒收到考勤異常資料，已在行政群組寄放「查不到」的提醒。請確認 Mac mini 的考勤計算有沒有跑。', 'guard:' + today);
}
/** 清舊指令碼屬性：ATT_EVT_ 超過 1 天；ATT_BATCH_／ATT_RUN_ 超過 40 天（日期在名稱裡） */
function attAlertCleanProps_(now) {
  var p = attAlertProps_(), all = p.getProperties() || {}, ms = now.getTime();
  var cut = attAlertAddDays_(attAlertDateStr_(now), -ATT_ALERT_KEEP_DAYS);
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('ATT_EVT_') === 0) { var t = Number(all[k]); if (!isFinite(t) || ms - t > ATT_ALERT_EVT_TTL_MS) p.deleteProperty(k); return; }
    var m = /^ATT_(?:BATCH|RUN)_(\d{4}-\d{2}-\d{2})/.exec(k);
    if (m && m[1] < cut) p.deleteProperty(k);
  });
}
/** 只在 Apps Script 編輯器手動執行一次：建立每 5 分鐘一次的保底觸發器（已有就先刪再建，不會重複） */
function attAlertInstallGuard() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'attAlertGuard') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('attAlertGuard').timeBased().everyMinutes(5).inTimezone('Asia/Taipei').create();
}
