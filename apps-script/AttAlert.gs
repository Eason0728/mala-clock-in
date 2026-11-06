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
 *   ATT_BIND_CODE      一次性綁定碼 JSON {code, exp}（30 分鐘）
 *   ATT_JOIN_LAST      最近一次被拉進群組 JSON {groupId, at}（Eason 查群組 ID 用）
 *   ATT_RUN_<日期>     當天狀態機 running／received／empty／guarded
 *   ATT_BATCH_<批次>   已收過的批次（冪等）
 *   ATT_EVT_<事件 id>  已處理過的 webhook 事件（保留 1 天）
 *   NOTIFY_INBOX_URL／NOTIFY_INBOX_TOKEN  通知匣（Eason 自己貼）
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
/** run_date 合法：格式正確且不晚於台北今天＋1 天。不要求「是今天」——mini 跨日會原樣重送前一天未確認的批次（P3-13） */
function attAlertRunDateOk_(d) {
  return attAlertValidDate_(d) && d <= attAlertAddDays_(attAlertDateStr_(attAlertNow_()), 1);
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
  }
  var seq = Number(b.seq);
  var now = attAlertNow_();
  if (!(b.seq !== undefined && b.seq !== null && b.seq !== '' && isFinite(seq))) seq = now.getTime();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };   // mini 呼叫，可以等
  try {
    var p = attAlertProps_();
    if (p.getProperty('ATT_BATCH_' + b.batch_id)) return { ok: true, dup: true };
    var sh = attAlertSheet_();
    var rows = attAlertReadRows_(sh);
    if (rows.some(function (r) { return r.batch_id === b.batch_id; })) return { ok: true, dup: true };   // 屬性寫失敗過的保險
    // §8.3：舊 pending 的 state／sched／failed／notes／guard 改 superseded；daily 保留
    var changed = [];
    rows.forEach(function (r) {
      if (r.status === 'pending' && ATT_ALERT_LOOSE.indexOf(r.section) >= 0) { r.status = 'superseded'; changed.push(r); }
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
    var iso = attAlertIso_(now);
    var matrix = spec.map(function (s, n) {
      return [b.batch_id + '#' + n, b.run_date, b.batch_id, seq, s[0], s[1], s[2], 'pending', iso, '', '', ''];
    });
    attAlertAppend_(sh, matrix);
    p.setProperty('ATT_RUN_' + b.run_date, empty ? 'empty' : 'received');
    p.setProperty('ATT_BATCH_' + b.batch_id, iso);
    return { ok: true };
  } finally { lock.releaseLock(); }
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
  if (schedLines.length) sections.push({ head: '▍班表', bullets: schedLines.slice() });
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
/** 本次要帶出的列 → 訊息陣列（或 {error}） */
function attAlertCompose_(rows) {
  var x = attAlertRowsToBatches_(rows);
  var batches = x.batches.slice();
  var dates = batches.map(function (b) { return b.run_date; });
  var guardLines = [];
  if (x.guards.length) {
    // 保底列只加尾端提醒；用一個最早排序、沒有內容的批次帶出日期，不影響其他批次的「最新」判斷
    x.guards.forEach(function (g) { if (guardLines.indexOf(g.line) < 0) guardLines.push(g.line); dates.push(g.run_date); });
    batches.push({ run_date: x.guards[x.guards.length - 1].run_date, daily: [], state: [], sched: [], failed_stores: [] });
  }
  if (!batches.length) return [];
  return attAlertRenderMessage_(batches, { today: dates.slice().sort().pop(), lastDate: dates.slice().sort().pop(), guardLines: guardLines });
}

// ───────────────────────── 通知匣（§8.11；照 inboxNotify_ 的接法，網址與 token 讀指令碼屬性）─────────────────────────
/** keyEvent 例：'guard:2026-11-23'（冒號分段，每段只留小寫英數與連字號）→ key＝att-alert:guard:2026-11-23。不拋例外；成功判準 ok===true && added===true */
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

// ───────────────────────── 群組綁定（§8.9）─────────────────────────
/** 只能在 Apps Script 編輯器手動執行：產生 6 位數綁定碼（30 分鐘），用 Logger.log 印出。webhook 與任何動作都叫不到它。 */
function attAlertIssueBindCode() {
  if (!attAlertEnabled_()) { Logger.log('這個部署沒有設 ATT_ALERT_SVC_KEY（未啟用考勤提醒），不產生綁定碼'); return null; }
  var n = 0;
  try { n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000; } catch (e) { n = Math.floor(Math.random() * 900000); }
  var code = String(100000 + n);
  attAlertProps_().setProperty('ATT_BIND_CODE', JSON.stringify({ code: code, exp: attAlertNow_().getTime() + ATT_ALERT_BIND_TTL_MS }));
  Logger.log('考勤提醒綁定碼：' + code + '（30 分鐘內有效）。到行政群組輸入：綁定考勤提醒 ' + code);
  return code;
}
/** 群裡「綁定考勤提醒 <6 碼>」。回 true＝這句是綁定口令（不論成功與否都不再往下處理）；碼錯、過期、已綁定都不回應 */
function attAlertTryBind_(ev, groupId) {
  var m = ev.message && ev.message.type === 'text' ? /^綁定考勤提醒\s+(\d{6})$/.exec(String(ev.message.text || '').trim()) : null;
  if (!m) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return true;
  var ok = false;
  try {
    var p = attAlertProps_();
    var raw = p.getProperty('ATT_BIND_CODE'), rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
    if (!p.getProperty('ATT_GROUP_ID') && rec && rec.code === m[1] && Number(rec.exp) >= attAlertNow_().getTime() && groupId) {
      p.setProperty('ATT_GROUP_ID', groupId);
      p.deleteProperty('ATT_BIND_CODE');
      ok = true;
    }
  } finally { lock.releaseLock(); }
  if (ok) {
    try { attAlertReply_(ev.replyToken, ['已綁定，之後考勤異常會發在這裡']); } catch (e2) { console.error('att-alert 綁定回覆失敗：' + e2); }
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
 * 只處理「群組」事件。處理了回 true（呼叫端略過打卡流程），沒處理回 false。
 * 沒啟用的店、非綁定群組的訊息、私訊一律回 false。可能丟例外：呼叫端（LineHub.gs）要 try/catch。
 */
function attAlertOnEvent_(ev) {
  if (!ev || !ev.source || ev.source.type !== 'group') return false;
  if (!attAlertEnabled_()) return false;
  var gid = String(ev.source.groupId || '');
  if (ev.type === 'join') {
    if (gid) attAlertProps_().setProperty('ATT_JOIN_LAST', JSON.stringify({ groupId: gid, at: attAlertIso_(attAlertNow_()) }));
    return true;
  }
  if (ev.type !== 'message') return false;
  var bound = attAlertProps_().getProperty('ATT_GROUP_ID') || '';
  if (!bound) return attAlertTryBind_(ev, gid);
  if (gid !== bound) return false;
  attAlertDeliver_(ev);
  return true;
}
function attAlertDeliver_(ev) {
  var p = attAlertProps_();
  var evId = String(ev.webhookEventId || '');
  if (evId && p.getProperty('ATT_EVT_' + evId)) return;
  if (!ev.replyToken) return;
  var sh = getSS().getSheetByName(ATT_ALERT_SHEET);
  if (!sh) return;
  var nowMs = attAlertNow_().getTime();
  var stale = function (r) { var t = Date.parse(r.inflight_at); return r.status === 'inflight' && (!isFinite(t) || nowMs - t > ATT_ALERT_INFLIGHT_MS); };
  var peek = attAlertReadRows_(sh);
  if (!peek.some(function (r) { return r.status === 'pending' || stale(r); })) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;   // 拿不到鎖就算了，下一句話再帶
  var claimed = [], expired = [];
  try {
    if (evId && p.getProperty('ATT_EVT_' + evId)) return;
    var rows = attAlertReadRows_(sh), iso = attAlertIso_(attAlertNow_()), changed = [];
    rows.forEach(function (r) {
      if (stale(r)) { r.status = 'unknown'; expired.push(r); changed.push(r); }
      else if (r.status === 'pending') { r.status = 'inflight'; r.inflight_at = iso; r.webhook_event_id = evId; claimed.push(r); changed.push(r); }
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
    if (claimed.length && evId) p.setProperty('ATT_EVT_' + evId, String(nowMs));
  } finally { lock.releaseLock(); }
  if (expired.length) attAlertInbox_('考勤提醒有幾筆帶出結果不明', '有 ' + expired.length + ' 筆提醒卡在帶出中超過 10 分鐘，不會自動重發，請到考勤管理確認。', 'unknown:' + expired[0].run_date);
  if (!claimed.length) return;

  var verdict = 'pending';   // pending＝沒送出去、等下一句；delivered；unknown
  try {
    var msgs = attAlertCompose_(claimed);
    if (!Array.isArray(msgs) || !msgs.length) {
      console.error('att-alert 沒有可帶出的內容或日期錯誤，保留 pending');
    } else {
      var code = attAlertReply_(ev.replyToken, msgs);
      if (code >= 200 && code < 300) verdict = 'delivered';
      else if (code >= 400 && code < 500) verdict = 'pending';   // 明確失敗（replyToken 失效等）
      else if (code === 0) verdict = 'pending';                   // 根本沒送
      else verdict = 'unknown';
    }
  } catch (e) {
    console.error('att-alert 帶出例外，結果不明：' + e);
    verdict = 'unknown';
  }
  attAlertFinish_(claimed, evId, verdict);
  if (verdict === 'unknown') attAlertInbox_('考勤提醒帶出結果不明', '考勤異常提醒送出時逾時或出錯，不知道群組有沒有收到，不會自動重發，請到考勤管理確認。', 'unknown:' + claimed[0].run_date);
}
/** 帶出結果寫回：只改還是 inflight、且事件 id 對得上的那幾列 */
function attAlertFinish_(claimed, evId, verdict) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.error('att-alert 結果寫回拿不到鎖，列維持 inflight'); return; }
  try {
    var sh = attAlertSheet_();
    var ids = {};
    claimed.forEach(function (r) { ids[r.id] = true; });
    var iso = attAlertIso_(attAlertNow_()), changed = [];
    attAlertReadRows_(sh).forEach(function (r) {
      if (!ids[r.id] || r.status !== 'inflight' || r.webhook_event_id !== evId) return;
      r.status = verdict;
      if (verdict === 'delivered') r.delivered_at = iso;
      if (verdict === 'pending') { r.inflight_at = ''; r.webhook_event_id = ''; }
      changed.push(r);
    });
    if (changed.length) attAlertWriteStatus_(sh, changed);
  } finally { lock.releaseLock(); }
}

// ───────────────────────── 09:30 保底（§8.4）─────────────────────────
/** 時間觸發器每 5 分鐘呼叫。台北 ≥09:30 且今天狀態不是 received／empty／guarded → 寫一筆 guard、設 guarded、送通知匣 */
function attAlertGuard() {
  if (!attAlertEnabled_()) return;
  var now = attAlertNow_();
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
      var iso = attAlertIso_(now), bid = 'guard-' + today;
      attAlertAppend_(attAlertSheet_(), [[bid + '#0', today, bid, now.getTime(), 'guard', '', ATT_ALERT_GUARD_TEXT, 'pending', iso, '', '', '']]);
      p.setProperty(key, 'guarded');
      wrote = true;
    }
  } finally { lock.releaseLock(); }
  if (wrote) attAlertInbox_('今天考勤資料查不到', '09:30 還沒收到考勤異常資料，已在行政群組寄放「查不到」的提醒。請確認 Mac mini 的考勤計算有沒有跑。', 'guard:' + today);
  try { attAlertCleanProps_(now); } catch (e) { console.error('att-alert 清屬性失敗：' + e); }
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
