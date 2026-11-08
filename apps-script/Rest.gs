/* ══ 單日 10 小時（2026-11-06 起只提醒）、兩班間隔 11 小時擋（2026-11-01 Eason 定案；2026-11-02 從 12 改 11＝勞基法 §34 下限）══
   規格：~/Desktop/Claude/系統/打卡/工時上限與班距_規格_20261101.md
   - 只擋「上班卡」（下班卡一律照收，擋了就沒有離開的紀錄）：
     ①這張上班卡跟上一段班同一天（段落歸上班卡那天，跨夜算前一天）→ 當天已打卡加總滿 10 小時：
       2026-11-06 Eason 改成**不擋、只提醒**（code 'cap'、warn:true；打卡照收，畫面多一句）
     ②上一段班在前一天以前 → 距離那張下班卡不到 11 小時就擋（照舊）
   - 跨店一起算：同一個人（姓名去空白）在別家店的打卡也算，別家店的試算表 ID 在 RestConfig.gs（只放 ~/mala-gas，不進公開 repo）。
   - 上一段忘了打下班卡（沒有下班時間）＝算不出間隔，不擋。沒有例外（主管 QR 也擋）。
   - 總開關：指令碼屬性 REST_RULE_ON 恰為 '1' 才擋（Eason 先通知店長再開）。
   - 任何一步出錯一律不擋（不能讓打卡因為這道檢查壞掉）。
   七店整檔共用；handleClock（各店 程式碼.js）與 liff_status 呼叫。 */
var REST_DAY_MAX_H = 10;
var REST_GAP_H = 11;          // 2026-11-02 Eason：12→11（法定下限，不能再低）
var REST_PAIR_H = 16;          // 上班卡往後 16 小時內的下班卡才配成一段（同 MONTHLY_PAIR_WINDOW_HOURS）
var REST_LOOKBACK_H = 40;      // 今天的段落（最早昨天 16:00 前上班的跨夜班不算今天）＋前一段的下班卡，多留一點
var REST_PEER_CACHE_S = 21600; // 別家店名冊快取 6 小時
/* 28 天週期加班（出勤規範 4-15、4-17，Eason 2026-11-08）：超過 36 小時提醒；滿 46 小時只擋會變成加班的上班卡（休息日、例假、國定假日，或今天已打滿 8 小時），正常班照打。
   時數在 ot_month 分頁（光復每天 09:00 寫，只有當天日期的列才算）。緊急關＝指令碼屬性 REST_OT_ON 設 '0'。 */
var REST_OT_WARN_H = 36;
var REST_OT_STOP_H = 46;
var REST_OT_BASE_H = 8;
var REST_OT_CACHE_S = 600;

function restOn_() {
  try { return PropertiesService.getScriptProperties().getProperty('REST_RULE_ON') === '1'; } catch (e) { return false; }
}
function restName_(v) { return String(v === null || v === undefined ? '' : v).replace(/\s/g, ''); }
function restMs_(ts) { var t = new Date(String(ts)).getTime(); return isNaN(t) ? NaN : t; }
function restDay_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'yyyy-MM-dd'); }
function restHm_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'HH:mm'); }
function restMd_(ms) { return Utilities.formatDate(new Date(ms), 'Asia/Taipei', 'M/d'); }

/** 打卡列（{ts,type,status}，可混多家店）→ 段落 [{in, out}]（毫秒）。算數＝非 rejected_*（同 lastCountedEvent）。
 *  上班卡後面接的是上班卡＝前一張沒有下班卡（忘打），那段不成立；下班卡前面沒有上班卡也不算。 */
function restSegments_(evs) {
  var list = (evs || []).filter(function (e) {
    return (e.type === 'in' || e.type === 'out') && String(e.status || '').indexOf('rejected_') !== 0 && !isNaN(restMs_(e.ts));
  }).map(function (e) { return { ms: restMs_(e.ts), type: String(e.type) }; })
    .sort(function (a, b) { return a.ms - b.ms; });
  var segs = [], open = null;
  list.forEach(function (e) {
    if (e.type === 'in') { open = e.ms; return; }
    if (open !== null && e.ms - open <= REST_PAIR_H * 3600000) segs.push({ in: open, out: e.ms });
    open = null;
  });
  return segs;
}

/** 純判斷：段落＋現在 → null（可以打）或 {code:'cap'|'gap', reason, hint, until}（until＝幾點起可以打，毫秒；cap 沒有）。 */
function restJudge_(segs, nowMs) {
  var today = restDay_(nowMs), done = segs.filter(function (s) { return s.out <= nowMs; });
  if (!done.length) return null;
  var todays = done.filter(function (s) { return restDay_(s.in) === today; });
  if (todays.length) {
    var h = todays.reduce(function (a, s) { return a + (s.out - s.in); }, 0) / 3600000;
    if (h >= REST_DAY_MAX_H) {
      return { code: 'cap', warn: true, reason: '你今天已經上班 ' + (Math.round(h * 10) / 10) + ' 小時（一天最多 ' + REST_DAY_MAX_H + ' 小時）',
               hint: '再上班會超過 10 小時，請先跟店長確認', until: null };
    }
    return null;   // 同一天的第二段（二段班中間休息回來）不看間隔
  }
  var last = done[done.length - 1], until = last.out + REST_GAP_H * 3600000;
  if (nowMs >= until) return null;
  var sameDay = restDay_(until) === today;
  return { code: 'gap', reason: '你' + (restDay_(last.out) === today ? '今天 ' : ' ' + restMd_(last.out) + ' ') + restHm_(last.out) +
             ' 下班，兩班要隔 ' + REST_GAP_H + ' 小時，' + (sameDay ? '' : restMd_(until) + ' ') + restHm_(until) + ' 以後才能打上班卡',
           hint: '有問題請找值班主管', until: until };
}

/** 別家店（RestConfig.gs 的 REST_PEERS_：[{code, ss}]，跳過自己）跟這個人同名的在職同仁，近 REST_LOOKBACK_H 小時的打卡。
 *  名冊快取 6 小時（多數人只在一家店，不必每次開別家的表）；哪家讀不到就跳過那家。 */
function restPeerEvents_(name, sinceMs) {
  var out = [], nm = restName_(name);
  if (!nm || typeof REST_PEERS_ === 'undefined' || !REST_PEERS_.length) return out;
  var selfId = '';
  try { selfId = getSS().getId(); } catch (e) { selfId = ''; }
  var cache = CacheService.getScriptCache();
  REST_PEERS_.forEach(function (p) {
    if (!p || !p.ss || p.ss === selfId) return;
    try {
      var ss = null, ids = null, ck = 'rpr:' + p.ss.slice(-12), hit = cache.get(ck);
      var roster = hit ? JSON.parse(hit) : null;
      if (!roster) {
        ss = SpreadsheetApp.openById(p.ss);
        roster = readSheetAsObjects(ss.getSheetByName('roster')).rows
          .filter(function (r) { return String(r.active).toLowerCase() === 'true'; })
          .map(function (r) { return [restName_(r.name), String(r.emp_id)]; });
        try { cache.put(ck, JSON.stringify(roster), REST_PEER_CACHE_S); } catch (e) {}
      }
      ids = roster.filter(function (r) { return r[0] === nm; }).map(function (r) { return r[1]; });
      if (!ids.length) return;
      ss = ss || SpreadsheetApp.openById(p.ss);
      readEventsSince(ss.getSheetByName('events'), sinceMs).rows.forEach(function (e) {
        if (ids.indexOf(String(e.emp_id)) >= 0) out.push({ ts: normCellTs(e.ts), type: String(e.type), status: String(e.status), store: p.code });
      });
    } catch (e) { Logger.log('REST 讀別家店 ' + p.code + ' 失敗：' + e); }
  });
  return out;
}

/** ot_month 分頁裡這個人今天那列 → {h, rest}，沒有回 null；任何錯誤回 null（不能讓打卡因為這道檢查壞掉）。 */
function restOtRow_(ss, name, nowMs) {
  try {
    if (PropertiesService.getScriptProperties().getProperty('REST_OT_ON') === '0') return null;
    var today = restDay_(nowMs), cache = CacheService.getScriptCache(), ck = 'rot:' + today, hit = cache.get(ck), map = hit ? JSON.parse(hit) : null;
    if (!map) {
      map = {};
      var sh = ss.getSheetByName('ot_month');
      if (sh) readSheetAsObjects(sh).rows.forEach(function (r) {
        if (String(r.date).slice(0, 10) === today) map[restName_(r.name)] = { h: Number(r.ot_h) || 0, rest: String(r.rest).toUpperCase() === 'TRUE' };
      });
      try { cache.put(ck, JSON.stringify(map), REST_OT_CACHE_S); } catch (e) {}
    }
    return map[restName_(name)] || null;
  } catch (e) { Logger.log('REST 月加班讀取失敗（不擋）：' + e); return null; }
}
/** 純判斷：row＝restOtRow_ 的結果 → null、擋（code 'ot46'）或提醒（warn:true）。 */
function restOtJudge_(row, segs, nowMs) {
  if (!row || !(row.h > REST_OT_WARN_H)) return null;
  var today = restDay_(nowMs);
  var h = (segs || []).filter(function (s) { return s.out <= nowMs && restDay_(s.in) === today; })
    .reduce(function (a, s) { return a + (s.out - s.in); }, 0) / 3600000;
  var shown = Math.round(row.h * 10) / 10;
  if (row.h >= REST_OT_STOP_H) {
    if (row.rest || h >= REST_OT_BASE_H) {
      return { code: 'ot46', reason: '你這一期（28 天）加班已經 ' + shown + ' 小時（滿 ' + REST_OT_STOP_H + ' 小時），' + (row.rest ? '今天是休息日' : '今天也上滿 ' + REST_OT_BASE_H + ' 小時') + '，不能再打上班卡',
               hint: '正常班不受影響；有問題請找值班主管', until: null };
    }
    return { code: 'ot46', warn: true, reason: '你這一期（28 天）加班已經 ' + shown + ' 小時（滿 ' + REST_OT_STOP_H + ' 小時）', hint: '今天上滿 ' + REST_OT_BASE_H + ' 小時就不能再打上班卡' };
  }
  return { code: 'ot36', warn: true, reason: '你這一期（28 天）加班已經 ' + shown + ' 小時（超過 ' + REST_OT_WARN_H + ' 小時）', hint: '滿 ' + REST_OT_STOP_H + ' 小時後，休息日和超過 ' + REST_OT_BASE_H + ' 小時的上班卡會打不了' };
}

/** 這次請求最近一次算出的「只提醒」結果（滿 10 小時）；restCheckIn_ 每次先清掉。
 *  各店 程式碼.js 的 handleClock 把 restCheckIn_ 回傳非 null 當擋卡，所以提醒不能從回傳值出去——放這裡給 Liff.gs 打卡成功時讀。 */
var REST_LAST_WARN_ = null;

/** 這個人現在打上班卡會不會被擋 → null 或 restJudge_ 的結果（只會是 gap）。總開關關著、或任何錯誤都回 null。
 *  滿 10 小時（cap）不擋：回 null，結果放 REST_LAST_WARN_。ss＝本店試算表；roster＝本店名冊列（emp_id、name）。 */
function restCheckIn_(ss, roster, nowMs) {
  REST_LAST_WARN_ = null;
  if (!restOn_()) return null;
  try {
    var now = nowMs || Date.now(), since = now - REST_LOOKBACK_H * 3600000;
    var mine = readEventsSince(ss.getSheetByName('events'), since).rows.filter(function (e) {
      return String(e.emp_id) === String(roster.emp_id);
    }).map(function (e) { return { ts: normCellTs(e.ts), type: String(e.type), status: String(e.status) }; });
    var segs = restSegments_(mine.concat(restPeerEvents_(roster.name, since)));
    var r = restJudge_(segs, now), o = restOtJudge_(restOtRow_(ss, roster.name, now), segs, now);
    if (r && !r.warn) return r;
    if (o && !o.warn) return o;
    if (r || o) REST_LAST_WARN_ = r || o;
    return null;
  } catch (e) { Logger.log('REST 檢查失敗（不擋）：' + e); return null; }
}

/** liff_status 用：擋＝{blocked:true, code, reason, hint, until}；滿 10 小時＝{blocked:false, warn:{reason, hint}}；都沒有回 {blocked:false}。 */
function restStatus_(ss, roster) {
  var r = restCheckIn_(ss, roster);
  if (r) return { blocked: true, code: r.code, reason: r.reason, hint: r.hint, until: r.until };
  var w = REST_LAST_WARN_;
  return w ? { blocked: false, warn: { code: w.code, reason: w.reason, hint: w.hint } } : { blocked: false };
}

/** {action:'rest_rule_set', admin_key, on?:true|false, probe?:true} → 開／關這家店的擋卡（指令碼屬性 REST_RULE_ON）；不帶 on＝只查；
 *  probe＝順便實際開一次別家店的表，回 peer_ok／peer_bad（店代碼）。
 *  給上線腳本七店一起開關用（Eason 2026-11-01：先通知店長再開）。管理金鑰空字串一律擋（同 export_tables）。 */
function handleRestRuleSet_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var props = PropertiesService.getScriptProperties();
  if (body.on === true) props.setProperty('REST_RULE_ON', '1');
  else if (body.on === false) props.deleteProperty('REST_RULE_ON');
  var peers = (typeof REST_PEERS_ === 'undefined') ? [] : REST_PEERS_, ok = [], bad = [], selfId = '';
  try { selfId = getSS().getId(); } catch (e) {}
  if (body.probe) peers.forEach(function (p) {   // 實際開一次別家店的表（跨店讀得到才算數）；只回店代碼，不回試算表 ID
    if (p.ss === selfId) return;
    try { SpreadsheetApp.openById(p.ss).getSheetByName('events'); ok.push(p.code); } catch (e) { bad.push(p.code); }
  });
  return { ok: true, on: restOn_(), peers: peers.length, peer_ok: ok, peer_bad: bad };
}
