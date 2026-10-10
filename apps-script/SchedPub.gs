/* ══ 自動排班發布（2026-10-11，規格 ~/mala-store-ops docs/autoschedule/spec.md 第 8、10.2 節）══
 * 營運系統（Mac mini）鎖定一期班表 → POST sched_publish；解鎖 → sched_unpublish。只有光復這套部署（LINE Hub）收。
 * 規則：
 *   ‧svcKey 要等於指令碼屬性 SCHED_SVC_KEY（沒設就全部拒絕）；v 不是 1 → bad_version。
 *   ‧ScriptLock 包住「讀→比→寫」；seq ≤ 已存的 → stale（不寫）；同一列最後一次的 op_id 重送 → 回上次結果（冪等）。
 *   ‧unpublish 留墓碑：seq 保留、資料清空，比它舊的 publish 晚到會因 seq 較小被擋，不會復活。
 *   ‧人員只收 emp_id、name、cells（營運系統那端已白名單；這裡再丟掉其他欄位，不寫進試算表）。
 * 存放：光復打卡試算表分頁 sched_pub，一店一期一列：store｜period｜seq｜data｜last_op｜updated_at。
 * 讀取（出勤班表）：schedPubLoad_()，快取 SCHED_PUB_CACHE_SEC 秒，寫入時清快取。 */
var SCHED_PUB_SHEET = 'sched_pub';
var SCHED_PUB_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];
var SCHED_PUB_CACHE_KEY = 'schedpub:v1';
var SCHED_PUB_CACHE_SEC = 120;
var SCHED_PUB_MAX_CHARS = 45000;   // 試算表一格上限 50000 字元

function schedPubSheet_() {
  var ss = getSS();
  var sh = ss.getSheetByName(SCHED_PUB_SHEET);
  if (!sh) { sh = ss.insertSheet(SCHED_PUB_SHEET); sh.getRange(1, 1, 1, SCHED_PUB_HEAD.length).setValues([SCHED_PUB_HEAD]); }
  return sh;
}

function schedPubClean_(b) {
  var shifts = (Array.isArray(b.shifts) ? b.shifts : []).map(function (s) {
    return { id: String(s.id), name: String(s.name || s.id), start: String(s.start), end: String(s.end), break_min: Number(s.break_min) || 0 };
  });
  var rows = (Array.isArray(b.rows) ? b.rows : []).map(function (r) {
    return { emp_id: String(r.emp_id), name: String(r.name || ''), cells: (Array.isArray(r.cells) ? r.cells : []).map(function (c) {
      var o = { t: String((c && c.t) || '') };
      if (c && c.s) o.s = String(c.s);
      if (c && c.l) o.l = String(c.l);
      return o;
    }) };
  });
  return { start: String(b.start || ''), shifts: shifts, rows: rows };
}

function schedPubWrite_(b, kind) {
  var key = PropertiesService.getScriptProperties().getProperty('SCHED_SVC_KEY');
  if (!key || b.svcKey !== key) return { ok: false, error: 'unauthorized' };
  if (b.v !== 1) return { ok: false, error: 'bad_version' };
  if (typeof b.store !== 'string' || b.store.length > 12 || !/^T\d{2,}$/.test(String(b.period || '')) ||
      typeof b.seq !== 'number' || b.seq < 1 || Math.floor(b.seq) !== b.seq || typeof b.op_id !== 'string' || !b.op_id || b.op_id.length > 64) {
    return { ok: false, error: 'bad_input' };
  }
  var data = '';
  if (kind === 'publish') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.start || '')) || b.days !== 28 || !Array.isArray(b.rows)) return { ok: false, error: 'bad_input' };
    for (var i = 0; i < b.rows.length; i++) if (!b.rows[i] || !Array.isArray(b.rows[i].cells) || b.rows[i].cells.length !== 28) return { ok: false, error: 'bad_input' };
    data = JSON.stringify(schedPubClean_(b));
    if (data.length > SCHED_PUB_MAX_CHARS) return { ok: false, error: 'too_big' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy' };
  try {
    var sh = schedPubSheet_();
    var vals = sh.getDataRange().getValues();
    var at = -1;
    for (var r = 1; r < vals.length; r++) if (String(vals[r][0]) === b.store && String(vals[r][1]) === b.period) { at = r; break; }
    if (at > 0) {
      var cur = Number(vals[at][2]) || 0;
      if (String(vals[at][4]) === b.op_id) return { ok: true, seq: cur };
      if (b.seq <= cur) return { ok: false, error: 'stale', seq: cur };   // 附目前的 seq：營運系統資料庫從備份還原時能跳號重送
    }
    var row = [b.store, b.period, b.seq, data, b.op_id, new Date().toISOString()];
    var rng = at > 0 ? sh.getRange(at + 1, 1, 1, row.length) : sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
    rng.setNumberFormat('@').setValues([row]);    // 文字格式：光復的店別是空字串、期別 T01 不能被轉型
    try { CacheService.getScriptCache().remove(SCHED_PUB_CACHE_KEY); } catch (e) { /* 快取清不掉最多晚兩分鐘 */ }
    return { ok: true, seq: b.seq };
  } finally { lock.releaseLock(); }
}
function handleSchedPublish_(b) { return schedPubWrite_(b, 'publish'); }
function handleSchedUnpublish_(b) { return schedPubWrite_(b, 'unpublish'); }

/** 全部已發布的班表：{ 'store|period': {start, shifts, rows} }（墓碑不列） */
function schedPubLoad_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(SCHED_PUB_CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 重讀 */ } }
  // 沒快取：跟寫入用同一把鎖再讀表、寫快取，避免「讀到舊的 → 寫入者清快取 → 再把舊的塞回快取」（GPT 上線前審查 5）
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(10000); } catch (e) { locked = false; }
  try {
    if (locked) { hit = cache.get(SCHED_PUB_CACHE_KEY); if (hit) { try { return JSON.parse(hit); } catch (e) { /* 重讀 */ } } }
    return schedPubReadSheet_(cache, locked);
  } finally { if (locked) lock.releaseLock(); }
}
function schedPubReadSheet_(cache, mayCache) {
  var sh = getSS().getSheetByName(SCHED_PUB_SHEET);
  var out = {};
  if (sh) {
    var vals = sh.getDataRange().getValues();
    for (var r = 1; r < vals.length; r++) {
      var d = String(vals[r][3] || '');
      if (!d) continue;
      try { out[String(vals[r][0]) + '|' + String(vals[r][1])] = JSON.parse(d); } catch (e) { /* 壞列略過 */ }
    }
  }
  var s = JSON.stringify(out);
  if (mayCache && unescape(encodeURIComponent(s)).length < 90000) { try { cache.put(SCHED_PUB_CACHE_KEY, s, SCHED_PUB_CACHE_SEC); } catch (e) { /* 快取失敗照樣回應 */ } }   // 沒拿到鎖就只讀不寫快取
  return out;
}

/* ── 期別換算（與營運系統 web/modules/schedule/period.js 同一套：2026-11-01＝T01 第 1 天，每期 28 天）── */
var SCHED_PUB_BASE = '2026-11-01';
function schedPubMs_(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
function schedPubAddDays_(d, n) { return new Date(schedPubMs_(d) + n * 86400000).toISOString().slice(0, 10); }
function schedPubPeriodOf_(d) {
  var n = Math.floor(Math.round((schedPubMs_(d) - schedPubMs_(SCHED_PUB_BASE)) / 86400000) / 28) + 1;
  return n < 0 ? null : 'T' + ('0' + n).slice(-Math.max(2, String(n).length));
}
function schedPubIndex_(d) {
  var k = Math.round((schedPubMs_(d) - schedPubMs_(SCHED_PUB_BASE)) / 86400000) % 28;
  return k < 0 ? k + 28 : k;
}
var SCHED_PUB_OFF_LABEL = { R: '例假', H: '休息日', W: '', L: '請假' };
var SCHED_PUB_LEAVE_LABEL = { '特': '特休', '補': '補休', '國': '國定假日' };
/** 一格 → 出勤班表的一天（與 schedDayOf_ 同形：code／label／segs／hours／work／rest） */
function schedPubDay_(cell, shifts) {
  if (!cell || !cell.t) return null;
  if (cell.s) {
    var sh = null;
    for (var i = 0; i < shifts.length; i++) if (shifts[i].id === cell.s) { sh = shifts[i]; break; }
    if (!sh) return { code: cell.s, label: cell.s, segs: [], hours: 0, work: true, rest: false, no_time: true };
    var a = +sh.start.slice(0, 2) * 60 + +sh.start.slice(3), b = +sh.end.slice(0, 2) * 60 + +sh.end.slice(3);
    var span = b > a ? b - a : b + 1440 - a;
    var label = sh.name + (cell.t === 'H' ? '（休息日出勤）' : '');
    return { code: cell.s, label: label, segs: [[sh.start, sh.end]], hours: Math.round(Math.max(0, span - (sh.break_min || 0)) / 60 * 100) / 100, work: true, rest: false };
  }
  var lab = cell.t === 'L' ? (SCHED_PUB_LEAVE_LABEL[cell.l] || '請假') : (SCHED_PUB_OFF_LABEL[cell.t] || '');
  return { code: cell.t === 'L' ? String(cell.l || 'L') : cell.t, label: lab, segs: [], hours: 0, work: false, rest: true };
}
/** 某人（可能綁多家店）某月、日期 ≥ fromDate 的天：{ 'yyyy-MM-dd': day }。同一天多家店都有班時取有上班的那家 */
function schedPubDaysFor_(pub, mine, dates) {
  var out = {};
  dates.forEach(function (d) {
    var p = schedPubPeriodOf_(d);
    if (!p) return;
    var idx = schedPubIndex_(d), best = null;
    mine.forEach(function (x) {
      var data = pub[String(x.st.code) + '|' + p];
      if (!data) return;
      for (var i = 0; i < data.rows.length; i++) {
        if (String(data.rows[i].emp_id) !== String(x.row.emp_id)) continue;
        var day = schedPubDay_(data.rows[i].cells[idx], data.shifts || []);
        if (day && (!best || (day.work && !best.work))) best = day;
      }
    });
    if (best) out[d] = best;
  });
  return out;
}
