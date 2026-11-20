/* ══ LINE 打卡 G＋備援（2026-11-15，mala-clock-relay docs/g-primary）══
   切換後 Mac mini 是打卡正本：mini 先寫自己的資料庫，再用 relay_append 抄一份到這裡（各店 events 變副本）；
   mini 停了手機改送 liff_punch（同一張單號 req_id），這裡照舊判、寫，mini 回來用 relay_pull 補回。
   這份九店整檔共用（動作掛在 Liff.gs LIFF_HANDLERS），不用改各店 程式碼.js。
   金鑰：沿用快速通道的指令碼屬性 RELAY_KEY（relayKeyOk_，Liff.gs）。
   ⚠ 沒切換前（光復 G_PRIMARY 沒開、手機沒送 req_id）所有既有動作行為不變：這裡只多三個動作。 */

var RELAYG_VERSION = 1;
var RELAYG_REQ_RE_ = /^r[0-9a-f]{16}$/;
var RELAYG_CAP_RE_ = /^cap:[^:]{1,40}:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/;   // 單日滿 10 小時系統卡的單號（mini 寫的）
var RELAYG_MARK_TTL_S_ = 900;          // 「這張單號寫好了」記號留 15 分鐘
var RELAYG_PENDING_TTL_S_ = 120;       // 「手機改送的那張正在寫」記號最多留 2 分鐘（liff_punch 中途出錯沒清掉也不會卡太久；Fable 審查 B4）
var RELAYG_TS_BACK_MS_ = 3 * 86400000, RELAYG_TS_AHEAD_MS_ = 2 * 60000;   // relay_append 收的時間範圍：3 天前～2 分鐘後（審查 C2）
// relay_pull 只給 mini 擋卡要的欄（審查 D1：不給名冊的建立人、移除人等；以後表上新增的欄也不會自動流出）
var RELAYG_EVENT_COLS_ = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m', 'source', 'req_id', 'mirror_src'];
var RELAYG_ROSTER_COLS_ = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'removed_at', 'line_user_id', 'line_bound_at', 'line_ok_at'];
var RELAYG_PULL_MAX_ = 4000;           // relay_pull 一次最多回幾列
var RELAYG_SHEETS_ = ['ot_month', 'sched_pub'];   // mini 擋卡規則會讀的其他分頁（Rest.gs 加班上限、Cap10.gs 班表）
var RELAYG_PROPS_ = ['REST_RULE_ON', 'REST_CAP_ON', 'REST_OT_ON'];
// P2-B 開頁只問 mini（2026-11-21）：公告副本跟 sheets 同一趟帶。只給打卡頁要的欄（不給 created_by）；分頁不存在也回表頭（mini 才知道「這家店沒有公告」）
var RELAYG_NOTICE_COLS_ = ['id', 'text', 'active', 'ends_on', 'created_at'];
// P3-1 原始列副本（2026-11-21，契約 dzy-mini-playbook docs/clock-to-mini/contracts/r-line.md）：with.rows／with.fp 才回，沒帶＝回應不變。
var RELAYG_ROW_SHEETS_ = { approved: 'date', leave: '日期', requests: 'date' };   // 分頁 → 算「哪一天」的欄
var RELAYG_ROWS_MAX_ = 8000;                                                    // 單張超過就不送列（回 too_many）
var RELAYG_MGR_COLS_ = ['name', 'active', 'allow_acting', 'emp_id'];           // 主管名單白名單：沒有 key、也不給雜湊
var RELAYG_SECRET_COL_RE_ = /(^|_)(key|token|secret|pass|password|device_id|line_user_id)($|_)/i;   // 原始列這幾種欄一律不帶、不算指紋（mini 端同一條）

function relayGHash_(v, key) {
  if (v === '' || v === null || v === undefined) return '';
  return relayUidHash_(String(v), key);   // Liff.gs：HMAC-SHA256(RELAY_KEY, 值) 十六進位
}
function relayGCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  return v;
}
/** events 表頭補 source、req_id 兩欄（沒有才補，補在最後；readSheetAsObjects 照表頭取值，舊程式不受影響）。回補好的表頭。 */
function relayGHeads_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var heads = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || ''); });
  while (heads.length && heads[heads.length - 1] === '') heads.pop();
  ['source', 'req_id'].forEach(function (h) {
    if (heads.indexOf(h) < 0) { heads.push(h); sh.getRange(1, heads.length).setValue(h); }
  });
  return heads;
}
/** 最後 N 列（物件，含 __rowIndex）。 */
function relayGTail_(sh, heads, n) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, heads.length).getValues().map(function (row, i) {
    var o = {}; heads.forEach(function (h, k) { o[h] = row[k]; }); o.__rowIndex = from + i; o.ts = normCellTs(o.ts); return o;
  });
}
/** 整欄找單號（審查 B5：只看最後 400 列，總部每天鏡像重寫就超過）。找到回那一列（物件），沒有回 null。 */
function relayGFindReqRow_(sh, heads, reqId) {
  var c = heads.indexOf('req_id'), last = sh.getLastRow();
  if (c < 0 || last < 2) return null;
  var col = sh.getRange(2, c + 1, last - 1, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0] || '') === reqId) {
      var row = sh.getRange(i + 2, 1, 1, heads.length).getValues()[0], o = {};
      heads.forEach(function (h, k) { o[h] = row[k]; }); o.__rowIndex = i + 2; o.ts = normCellTs(o.ts);
      return o;
    }
  }
  return null;
}
function relayGLock_(ms) {   // 拿不到鎖回 null（呼叫端照常做，只是少一道保險）
  try { var l = LockService.getScriptLock(); return l.tryLock(ms) ? l : null; } catch (e) { return null; }
}
function relayGMarkKey_(reqId) { return 'rqg:' + reqId; }
function relayGMarkGet_(reqId) {
  try { var v = CacheService.getScriptCache().get(relayGMarkKey_(reqId)); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function relayGMarkPut_(reqId, obj, ttl) {
  try { CacheService.getScriptCache().put(relayGMarkKey_(reqId), JSON.stringify(obj), ttl || RELAYG_MARK_TTL_S_); } catch (e) {}
}
function relayGRowOut_(r, key, cols, memo) {
  var o = {};
  cols.forEach(function (k) {
    if (!(k in r)) return;
    var v = relayGCell_(r[k]);
    if (k === 'device_id' && !(String(v) === 'system' || v === '')) v = memo[v] || (memo[v] = 'h:' + relayGHash_(v, key));   // 裝置碼重複多：算過的不再算（審查 D2）
    o[k] = v;
  });
  o.__row = r.__rowIndex;
  return o;
}
/** 寫進表的值：數字欄轉數字、是非欄轉 true／false、其他是文字的話開頭 = + - @ 換成全形（同 handleClock，擋公式；審查 C1） */
function relayGNum_(v) { if (v === '' || v === null || v === undefined) return ''; var n = Number(v); return isFinite(n) ? n : ''; }
function relayGBool_(v) { return v === true || String(v).toLowerCase() === 'true' ? true : (v === false || String(v).toLowerCase() === 'false' ? false : ''); }

/* ── P3-1 原始列與指紋（契約 r-line.md 第 3、4 節；mini 端 gstore.js rowCanon／fpOfRows 同一套，改這裡要一起改） ── */
function relayGFpVal_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return relayGCell_(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  return String(v);
}
/** 一列的正規字串：欄名排序後 [[欄名, 值], …]；不含 __row、空欄名、金鑰類欄 */
function relayGCanon_(row) {
  var ks = Object.keys(row).filter(function (k) { return k && k !== '__row' && k !== '__rowIndex' && !RELAYG_SECRET_COL_RE_.test(k); }).sort();
  return JSON.stringify(ks.map(function (k) { return [k, relayGFpVal_(row[k])]; }));
}
function relayGHex16_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8), h = '';
  for (var i = 0; i < 8; i++) h += ('0' + (b[i] & 255).toString(16)).slice(-2);
  return h;
}
function relayGRowDay_(sheet, row) {
  var m = /^\d{4}-\d\d-\d\d/.exec(relayGFpVal_(row[RELAYG_ROW_SHEETS_[sheet]]));
  return m ? m[0] : '?';
}
/** {day: '<列數>:<16 位雜湊>'}：同一天的列正規字串排序後接起來算（順序、列號不影響） */
function relayGFpOf_(sheet, rows) {
  var by = {}, out = {};
  rows.forEach(function (r) { var d = relayGRowDay_(sheet, r); (by[d] = by[d] || []).push(relayGCanon_(r)); });
  Object.keys(by).forEach(function (d) { var a = by[d].sort(); out[d] = a.length + ':' + relayGHex16_(a.join('\n')); });
  return out;
}
/** 一張原始列分頁（同 export_tables 的讀法）：{headers, total, rows:[{…, __row}]}；金鑰類欄、空欄名不帶 */
function relayGReadRows_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) return { headers: [], total: 0, rows: [] };
  var rd = readSheetAsObjects(sh);
  var heads = rd.headers.map(function (h) { return String(h === null || h === undefined ? '' : h); })
    .filter(function (h) { return h && !RELAYG_SECRET_COL_RE_.test(h); });
  if (rd.rows.length > RELAYG_ROWS_MAX_) return { error: 'too_many', total: rd.rows.length };
  return { headers: heads, total: rd.rows.length, rows: rd.rows.map(function (r) {
    var o = {}; heads.forEach(function (h) { o[h] = relayGCell_(r[h]); }); o.__row = r.__rowIndex; return o;
  }) };
}
/** with.rows／with.fp：三張原始列＋主管名單（白名單欄）＋每天指紋。wantRows=false 只回 fp。 */
function relayGRowsOut_(ss, out, wantRows) {
  var rows = {}, fp = {};
  Object.keys(RELAYG_ROW_SHEETS_).forEach(function (nm) {
    var t = relayGReadRows_(ss, nm);
    fp[nm] = t.error ? null : relayGFpOf_(nm, t.rows);
    rows[nm] = t;
  });
  out.fp = fp;
  if (!wantRows) return;
  out.rows = rows;
  var msh = ss.getSheetByName('managers');
  out.managers = msh ? readSheetAsObjects(msh).rows.map(function (r) {
    var o = {}; RELAYG_MGR_COLS_.forEach(function (k) { if (k in r) o[k] = relayGCell_(r[k]); }); o.__row = r.__rowIndex; return o;
  }) : [];
}

/**
 * {action:'relay_pull', relay_key, from_row?:資料第幾列起（1＝第一張卡）, with?:{roster,sheets,props,rows,fp}}
 * → {ok, v, now, total, from_row, events:[…], last:{row, ts, emp_id, type}, roster?, sheets?, props?, rows?, managers?, fp?, config}
 * rows／fp（P3-1）：approved、leave、requests 全部列＋主管名單白名單欄＋每天指紋；fp 只回指紋。格式見 r-line.md。
 * 唯讀。金鑰、裝置碼、LINE 帳號一律回 HMAC（'h:'＋十六進位），mini 拿不到原文。
 */
function relayGNoticesOut_(ss) {
  var cols = RELAYG_NOTICE_COLS_, s = ss.getSheetByName('notices');
  var v = s ? s.getDataRange().getValues() : [];
  if (!v.length) return [cols.slice()];
  var heads = v[0].map(function (h) { return String(h || ''); }), idx = cols.map(function (h) { return heads.indexOf(h); });
  return [cols.slice()].concat(v.slice(1).map(function (row) { return idx.map(function (i) { return i < 0 ? '' : relayGCell_(row[i]); }); }));
}
function handleRelayPull_(body) {
  if (!relayKeyOk_(body.relay_key)) return { ok: false, error: 'unauthorized' };
  relayGWatchSeen_();   // P2-D：記「mini 剛來過」（光復的停機通知觸發器看這個）
  var ss = getSS(), key = relayKey_(), sh = ss.getSheetByName('events');
  var w = body['with'] || {};
  var out = { ok: true, v: RELAYG_VERSION, now: relayIsoNow_(), events: [], total: 0 };
  if (sh) {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var heads = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || ''); });
    var total = Math.max(sh.getLastRow() - 1, 0);
    var from = Math.max(1, Math.floor(Number(body.from_row) || 1));
    out.total = total; out.from_row = from; out.headers = heads.filter(function (h) { return h && RELAYG_EVENT_COLS_.indexOf(h) >= 0; });
    if (from <= total) {
      var n = Math.min(total - from + 1, RELAYG_PULL_MAX_);
      var memo = {};
      out.events = sh.getRange(from + 1, 1, n, heads.length).getValues().map(function (row, i) {
        var o = {}; heads.forEach(function (h, k) { if (h) o[h] = row[k]; }); o.__rowIndex = from + 1 + i; return relayGRowOut_(o, key, RELAYG_EVENT_COLS_, memo);
      });
      out.more = from + n - 1 < total;
    }
    if (total) {
      var lr = sh.getRange(total + 1, 1, 1, heads.length).getValues()[0], lo = {};
      heads.forEach(function (h, k) { if (h) lo[h] = relayGCell_(lr[k]); });
      out.last = { row: total, ts: String(lo.ts || ''), emp_id: String(lo.emp_id || ''), type: String(lo.type || '') };
    }
  }
  if (w.roster) {
    var rs = ss.getSheetByName('roster');
    var rmemo = {};
    out.roster = rs ? readSheetAsObjects(rs).rows.map(function (r) {
      var o = relayGRowOut_(r, key, RELAYG_ROSTER_COLS_, rmemo);
      o.key = r.key ? 'h:' + relayGHash_(r.key, key) : '';
      o.line_user_id = r.line_user_id ? 'h:' + relayGHash_(r.line_user_id, key) : '';
      return o;
    }) : [];
  }
  if (w.sheets) {
    out.sheets = {};
    RELAYG_SHEETS_.forEach(function (nm) {
      var s = ss.getSheetByName(nm);
      if (s) out.sheets[nm] = s.getDataRange().getValues().map(function (row) { return row.map(relayGCell_); });
    });
    out.sheets.notices = relayGNoticesOut_(ss);
  }
  if (w.props) {
    out.props = {};
    var p = PropertiesService.getScriptProperties();
    RELAYG_PROPS_.forEach(function (k) { var v = p.getProperty(k); if (v !== null) out.props[k] = v; });
  }
  if (w.rows || w.fp) relayGRowsOut_(ss, out, !!w.rows);   // P3-1：沒帶就完全不讀這幾張
  out.config = { STORE_LAT: CONFIG.STORE_LAT, STORE_LNG: CONFIG.STORE_LNG, RADIUS_M: CONFIG.RADIUS_M,
                 NO_PUNCH_BREAK_START: CONFIG.NO_PUNCH_BREAK_START || '', NO_PUNCH_BREAK_END: CONFIG.NO_PUNCH_BREAK_END || '',
                 ALTERNATION_LOOKBACK_HOURS: CONFIG.ALTERNATION_LOOKBACK_HOURS };
  return out;
}

/**
 * {action:'relay_append', relay_key, req_id, row:{ts,emp_id,type,lat,lng,distance_m,within_range,device_match,status,accuracy_m,source},
 *  bind_sub?:LINE 帳號（名冊還沒綁裝置時才帶）, line_ok?:true}
 * → {ok, dup?, row:{ts,status,…}, date, emp_id, extras:{req_notes, ot_hint}}
 * mini 已經判好、寫進正本的一張卡，抄到這裡。同一張單號只寫一次（重送或手機改送 Google 的那張都算同一張）。
 * 裝置碼由這裡決定：名冊已綁就用名冊的（同 liff_punch），沒綁用 'line:<LINE 帳號>' 並綁上（同 handleClock）。
 */
function handleRelayAppend_(body) {
  if (!relayKeyOk_(body.relay_key)) return { ok: false, error: 'unauthorized' };
  var reqId = String(body.req_id || ''), row = body.row || {};
  var isCap = String(row.source || '') === (typeof CAP_SRC === 'string' ? CAP_SRC : 'system_cap');
  if (!(RELAYG_REQ_RE_.test(reqId) || (isCap && RELAYG_CAP_RE_.test(reqId)))) return { ok: false, error: 'bad_req_id' };
  if (row.type !== 'in' && row.type !== 'out') return { ok: false, error: 'bad_type' };
  // 員編只收文字或數字（2026-11-16，同 mgr_approve 的 C11-7）：陣列 ["E01"] 轉成文字剛好等於 E01 會對到人
  if (typeof row.emp_id !== 'string' && typeof row.emp_id !== 'number') return { ok: false, error: 'no_emp' };
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/.test(String(row.ts || ''))) return { ok: false, error: 'bad_ts' };
  var status = String(row.status || '');
  if (!/^(ok|pending_device_approval|rejected_[a-z_]+)$/.test(status)) return { ok: false, error: 'bad_status' };
  var src = String(row.source || 'mini');
  if (['mini', 'system_cap'].indexOf(src) < 0) return { ok: false, error: 'bad_source' };
  var tsMs = new Date(String(row.ts)).getTime();
  if (!(tsMs >= Date.now() - RELAYG_TS_BACK_MS_ && tsMs <= Date.now() + RELAYG_TS_AHEAD_MS_)) return { ok: false, error: 'bad_ts' };   // 太舊或未來的卡不收（金鑰外流也不能補寫任意時間的卡）
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy' };
  try {
    var ss = getSS(), sh = ss.getSheetByName('events');
    var heads = relayGHeads_(sh), tail = relayGTail_(sh, heads, 60);
    var found = relayGFindReqRow_(sh, heads, reqId);
    if (!found && isCap) {   // 系統卡：這裡的觸發器（capSweep）可能已經先寫了同一張（同人、同時刻 ±60 秒）
      var atMs = tsMs;
      tail.forEach(function (e) {
        if (String(e.emp_id) === String(row.emp_id) && String(e.source || '') === 'system_cap' && Math.abs(new Date(String(e.ts)).getTime() - atMs) <= 60000) found = e;
      });
    }
    if (!found) {
      var mk = relayGMarkGet_(reqId);
      if (mk && mk.state === 'pending') return { ok: false, error: 'busy' };   // 手機改送的那張正在寫：等一下再送
    }
    if (found) return relayGDupOut_(found, reqId);
    var rr = readSheetAsObjects(ss.getSheetByName('roster')).rows;
    var me = rr.filter(function (r) { return String(r.emp_id) === String(row.emp_id); })[0];
    if (!me) return { ok: false, error: 'no_emp' };   // 系統卡也要是名冊上的人（審查 C1）
    if (!isCap && String(me.active).toLowerCase() !== 'true') return { ok: false, error: 'inactive' };
    var dev;
    if (isCap) dev = 'system';
    else if (me.device_id) dev = String(me.device_id);
    else if (body.bind_sub && /^U[0-9a-f]{32}$/.test(String(body.bind_sub)) && String(me.line_user_id) === String(body.bind_sub)) {   // 只能綁成這個人自己的 LINE（審查 C3）
      dev = 'line:' + String(body.bind_sub);
      var rsh = ss.getSheetByName('roster');
      rsh.getRange(me.__rowIndex, ROSTER_HEADERS.indexOf('device_id') + 1).setValue(dev);
      rsh.getRange(me.__rowIndex, ROSTER_HEADERS.indexOf('device_bound_at') + 1).setValue(String(row.ts));
    } else return { ok: false, error: 'no_device' };
    var val = { ts: String(row.ts), emp_id: String(me.emp_id), type: row.type, lat: relayGNum_(row.lat), lng: relayGNum_(row.lng), distance_m: relayGNum_(row.distance_m),
                within_range: relayGBool_(row.within_range), device_id: dev, device_match: relayGBool_(row.device_match), status: status,
                accuracy_m: relayGNum_(row.accuracy_m), source: src, req_id: reqId };
    if (typeof empIdColText_ === 'function') { try { empIdColText_(sh); } catch (e) {} }
    sh.appendRow(heads.map(function (h) { return val.hasOwnProperty(h) ? (val[h] === null || val[h] === undefined ? '' : val[h]) : ''; }));
    SpreadsheetApp.flush();
    // 讓 Google 這邊的防呆（手機改送、舊網址）看得到這張剛寫的卡：同 handleClock 的「剛送出」記號
    if (status.indexOf('rejected_') !== 0 && typeof clockMarkPut_ === 'function') clockMarkPut_(val.emp_id, val.type, val.ts);
    var out = { ok: true, dup: false, row: { ts: val.ts, status: status, type: val.type, source: val.source }, date: val.ts.slice(0, 10), emp_id: val.emp_id, extras: {} };
    if (!isCap && status === 'ok') {
      if (body.line_ok && typeof liffMarkLineOk_ === 'function') { try { liffMarkLineOk_(ss, me.emp_id, me.__rowIndex); } catch (e) {} }
      out.extras = relayGExtras_(ss, val, tail);
    }
    relayGMarkPut_(reqId, { state: 'done', out: { ok: true, dup: false, row: out.row, date: out.date, emp_id: out.emp_id, extras: {} } });
    return out;
  } finally { lock.releaseLock(); }
}
function relayGDupOut_(e, reqId) {
  return { ok: true, dup: true, row: { ts: String(e.ts), status: String(e.status), type: String(e.type), source: String(e.source || '') },
           date: String(e.ts).slice(0, 10), emp_id: String(e.emp_id), extras: {} };
}
/** 打卡成功後要讀申請表的提示（申請結果通知、下班超時提示）：同 liffPunchFor_ 成功那段。讀不到就空著。 */
function relayGExtras_(ss, val, tail) {
  var x = { req_notes: [] }, rq = null;
  try { rq = reqRows_(ss); } catch (e) { rq = null; }
  try { x.req_notes = reqUnseenNotes_(ss, val.emp_id, rq); } catch (e) { x.req_notes = []; }
  if (val.type === 'out') {
    try {
      var since = new Date(val.ts).getTime() - 3 * (typeof REQ_PAIR_MS !== 'undefined' ? REQ_PAIR_MS : 16 * 3600000) - 3600000;
      var evs = readEventsSince(ss.getSheetByName('events'), since).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
      var hint = reqOtHint_(evs, val.emp_id, val.ts, rq || reqRows_(ss));
      if (hint) x.ot_hint = hint;
    } catch (e) {}
  }
  return x;
}

/* ── 手機改送 Google（liff_punch 帶 req_id）：同一張單號只寫一次 ──
   Liff.gs handleLiffPunch_ 呼叫：寫之前 relayGFallbackBefore_，寫完 relayGFallbackAfter_ 把 req_id、source 補到那一列。 */
/** 回 null＝照常寫；回物件＝這張單號已經處理過，直接回這個結果（不再寫一次）。
 *  查「有沒有寫過」與放「正在寫」記號在同一把鎖裡做，跟 relay_append（也拿這把鎖）不會同時判（審查 B1／B2：mini 剛好 3 秒後才抄過來）。 */
var RELAYG_FB_T0_ = 0;   // 這次手機改送開始的時間（寫完找那一列用；每次請求是獨立執行）
function relayGFallbackBefore_(body) {
  var reqId = String(body.req_id || '');
  if (!RELAYG_REQ_RE_.test(reqId)) return null;
  RELAYG_FB_T0_ = Date.now() - 2000;
  var lock = relayGLock_(8000);
  try {
    var mk = relayGMarkGet_(reqId);
    if (mk && mk.state === 'done' && mk.punch) { var cp = JSON.parse(JSON.stringify(mk.punch)); cp.dup = true; delete cp.steps; return cp; }
    if (mk && mk.state === 'done' && mk.out) return relayGPunchFromRow_(body.type, mk.out.row);
    try {
      var sh = getSS().getSheetByName('events'), heads = relayGHeads_(sh);
      var hit = relayGFindReqRow_(sh, heads, reqId);
      if (hit) return relayGPunchFromRow_(body.type, { ts: String(hit.ts), status: String(hit.status), type: String(hit.type) });
    } catch (e) {}
    relayGMarkPut_(reqId, { state: 'pending' }, RELAYG_PENDING_TTL_S_);
    return null;
  } finally { if (lock) lock.releaseLock(); }
}
function relayGPunchFromRow_(type, r) {
  var ok = r.status === 'ok';
  var res = { ok: ok, type: r.type || type, ts: r.ts, status: r.status, dup: true };
  if (ok) res.greeting = liffGreeting_(r.type || type, r.ts);
  else { var rr = LIFF_PUNCH_REASONS_[r.status] || ['系統回覆：' + r.status, '請告知主管']; res.reason = rr[0]; res.hint = rr[1]; }
  return res;
}
/** liff_punch 做完（不管成功、被擋、出錯都會呼叫；Liff.gs 放在 finally）：handleClock 寫的那一列補 req_id 與 source（line_g＝手機改送 Google），記號改成完成。
 *  被擋的卡回應沒有 ts（審查 B3）：找這次開始之後、這個人、這一型、還沒有單號的最後一列。 */
function relayGFallbackAfter_(body, res, empId) {
  var reqId = String(body.req_id || '');
  if (!RELAYG_REQ_RE_.test(reqId)) return;
  var keep = res ? JSON.parse(JSON.stringify(res)) : { ok: false, reason: '系統沒有回應', hint: '請再按一次' };
  delete keep.steps; delete keep.req_notes; delete keep.ot_hint;   // 記號裡不放申請結果等個人提示（同單號重送不用驗身分就拿得到；審查 B7）
  try {
    if (empId) {
      var sh = getSS().getSheetByName('events'), heads = relayGHeads_(sh), tail = relayGTail_(sh, heads, 30);
      for (var i = tail.length - 1; i >= 0; i--) {
        var e = tail[i], t = new Date(String(e.ts)).getTime();
        if (String(e.emp_id) !== String(empId) || String(e.type) !== String(body.type) || e.req_id) continue;
        if (res && res.ts ? String(e.ts) !== String(res.ts) : !(t >= RELAYG_FB_T0_)) continue;
        sh.getRange(e.__rowIndex, heads.indexOf('req_id') + 1).setValue(reqId);
        if (!e.source) sh.getRange(e.__rowIndex, heads.indexOf('source') + 1).setValue('line_g');
        if (!keep.ts) keep.ts = String(e.ts);
        if (!keep.status) keep.status = String(e.status);
        break;
      }
    }
  } catch (e) {}
  relayGMarkPut_(reqId, { state: 'done', punch: keep });
}

/* ── 切換開關與對帳結果（只有光復用）：薪資鎖月前檢查（Payroll.gs payGReconBlock_） ──
   {action:'relay_mode', relay_key, on?:true|false, stores?:[打卡試算表 ID…], recon?:{試算表 ID:{ym:{ok,mini,g,at}}}}
   → {ok, on, stores, recon_at}。on／stores 由 g-switch／g-rollback 設；recon 由 mini 每 10 分鐘送。 */
function handleRelayMode_(body) {
  if (!relayKeyOk_(body.relay_key)) return { ok: false, error: 'unauthorized' };
  var p = PropertiesService.getScriptProperties();
  var mode = relayGMode_();
  if (body.on === true || body.on === false) {
    mode = { on: body.on === true, stores: body.on === true && Array.isArray(body.stores) ? body.stores.map(String).slice(0, 20) : [], at: Date.now() };
    p.setProperty('G_PRIMARY', JSON.stringify(mode));
  }
  if (body.recon && typeof body.recon === 'object') {
    var cur = relayGRecon_();
    Object.keys(body.recon).slice(0, 20).forEach(function (id) {
      var m = body.recon[id]; if (!m || typeof m !== 'object') return;
      cur[id] = cur[id] || {};
      Object.keys(m).forEach(function (ym) {
        if (!/^\d{4}-\d\d$/.test(ym)) return;
        var r = m[ym] || {};
        cur[id][ym] = { ok: r.ok === true, mini: Number(r.mini) || 0, g: Number(r.g) || 0, at: Number(r.at) || 0, diff: String(r.diff || '').slice(0, 80) };   // 指令碼屬性一個值約 9KB 上限（審查 E3）
        var lr = relayGLockRowsIn_(r.rows); if (lr) cur[id][ym].rows = lr;   // P3-8：核定／請假／申請一致、未寫回、衝突（mini 有開 G_ROWS_ON 才會送）
      });
      var yms = Object.keys(cur[id]).sort(); while (yms.length > 3) delete cur[id][yms.shift()];   // 每店只留最近 3 個月
    });
    var js = JSON.stringify(cur);
    if (js.length > 8500) {   // P3-8 多了 rows：太大先丟掉說明文字（不影響判斷；鎖月照擋／照放）
      Object.keys(cur).forEach(function (id) { Object.keys(cur[id]).forEach(function (ym) { var e = cur[id][ym]; e.diff = ''; if (e.rows) { e.rows.bad = []; e.rows.why = ''; } }); });
      js = JSON.stringify(cur);
    }
    for (var keep = 2; js.length > 8500 && keep >= 1; keep--) {   // 還太大：每店只留最近 keep 個月（被丟掉的月份鎖月會因為「沒有對帳結果」被擋＝安全方向）
      Object.keys(cur).forEach(function (id) { var ks = Object.keys(cur[id]).sort(); while (ks.length > keep) delete cur[id][ks.shift()]; });
      js = JSON.stringify(cur);
    }
    p.setProperty('G_RECON', js);
  }
  return { ok: true, on: !!mode.on, stores: mode.stores || [], at: mode.at || 0 };
}
function relayGMode_() {
  try { var v = PropertiesService.getScriptProperties().getProperty('G_PRIMARY'); var m = v ? JSON.parse(v) : null; return m && typeof m === 'object' ? m : { on: false, stores: [] }; }
  catch (e) { return { on: false, stores: [] }; }
}
function relayGRecon_() {
  try { var v = PropertiesService.getScriptProperties().getProperty('G_RECON'); var m = v ? JSON.parse(v) : null; return m && typeof m === 'object' ? m : {}; }
  catch (e) { return {}; }
}

/** 薪資鎖月前（Payroll.gs handlePayrollFinalize 呼叫，Eason 2026-11-15 第 4 題「擋下」）：
 *  G 開著、而且這家店在 G 名單內 → 這個月要有 30 分鐘內「mini 和 Google 筆數一致」的對帳結果才能鎖。
 *  G 關著（沒切換或已退回）、這家店不在名單、沒接打卡＝不看。回 null＝放行，回 {error, message}＝擋。 */
var RELAYG_RECON_FRESH_MS_ = 30 * 60000;
function payGReconBlock_(ym, ssId) {
  var mode = relayGMode_();
  if (!mode.on || !ssId || (mode.stores || []).indexOf(String(ssId)) < 0) return null;
  // 切換那個月以前的月份：正本本來就是 Google，不看對帳（審查 E1）
  var swYm = mode.at ? Utilities.formatDate(new Date(Number(mode.at)), 'Asia/Taipei', 'yyyy-MM') : '';
  if (swYm && String(ym) < swYm) return null;
  var r = (relayGRecon_()[String(ssId)] || {})[String(ym)];
  if (!r) return { error: 'g_recon_missing', message: '打卡正本（Mac mini）和 Google 這個月還沒有對帳結果，這次沒有鎖定。請找資訊部確認 Mac mini 打卡服務是否正常。' };
  if (Date.now() - Number(r.at || 0) > RELAYG_RECON_FRESH_MS_)
    return { error: 'g_recon_stale', message: '打卡正本（Mac mini）和 Google 的對帳結果超過 30 分鐘沒有更新，這次沒有鎖定。請找資訊部確認 Mac mini 打卡服務是否正常。' };
  if (!r.ok) return { error: 'g_recon_mismatch', message: '打卡正本（Mac mini）有 ' + r.mini + ' 張、Google 有 ' + r.g + ' 張，對不上，這次沒有鎖定。請找資訊部處理' + (r.diff ? '（' + r.diff + '）' : '') + '。' };
  if (relayGLockRowsOn_()) return relayGLockRowsBlock_(r);   // P3-8（開關 G_LOCK_ROWS，沒設＝關＝照舊只看打卡）
  return null;
}

/* ── P3-8 鎖月條件加項（2026-11-21；設計 phase2-5-design.md §4.6、plan P3-8；Eason 2026-11-21 第 2 題選 A「三項都擋」）──
   光復指令碼屬性 G_LOCK_ROWS：沒設、空白、'0'＝關（＝上面那樣只看打卡）；其他任何值＝開。
   ⚠ 這是保護性檢查：開了以後填錯值（'yes'、'1 '、'on'…）一律當開＝維持擋，絕不會因為打錯字變成放行。
   開著時，除了打卡筆數，這家店這個月還要同時滿足（mini 每 10 分鐘隨 relay_mode recon 帶來的 rows）：
     ①核定（approved）、請假（leave）、申請（requests）三張表該月每一天 mini 和 Google 指紋一致；
     ②mini 還沒寫回 Google 的 0 筆；③衝突待處理 0 筆。
   任何一項不知道（沒回報、超過 30 分鐘沒更新、mini 問不到營運系統）＝擋，不放行。
   Mac mini 長時間不在又要鎖月：照舊在光復編輯器執行 relayGEditorPrimaryOff（P2-A）——正本記號關了，這裡整段不看（Payroll.gs 也不會呼叫）。
   未寫回／衝突算哪個範圍：RELAYG_LOCK_SCOPE_。'month'＝日期在要鎖的那個月（日期認不出來的算進每個月）；其他值＝全店任何一筆都算。 */
var RELAYG_LOCK_SCOPE_ = 'month';   // Eason 2026-11-21 定案 A：只算要鎖的那個月（日期認不出來的算進每個月）；改 'store' 才是全店
function relayGLockRowsOn_() {
  var v; try { v = PropertiesService.getScriptProperties().getProperty('G_LOCK_ROWS'); } catch (e) { return true; }   // 讀不到設定：當開（保護性）
  if (v === null || v === undefined) return false;
  v = String(v).trim();
  return !(v === '' || v === '0');
}
function relayGLockNum_(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? v : null; }   // 不是 0 以上整數（數字型別）＝不知道（null）
/** mini 送來的 rows 只留認得的欄、限長度（屬性大小）；不是物件回 null（＝不寫，鎖月時當沒回報）。 */
function relayGLockRowsIn_(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  return { fp: x.fp === 'ok' || x.fp === 'bad' ? x.fp : 'unknown',
    bad: (Array.isArray(x.bad) ? x.bad : []).slice(0, 3).map(function (s) { return String(s).slice(0, 24); }),
    unwb: relayGLockNum_(x.unwb), conflict: relayGLockNum_(x.conflict), unwb_all: relayGLockNum_(x.unwb_all), conflict_all: relayGLockNum_(x.conflict_all),
    at: Number(x.at) || 0, why: String(x.why || '').slice(0, 40) };
}
/** 回 null＝三項都過；回 {error, message}＝擋。r＝這家店這個月的對帳結果（打卡那幾項已經過了）。 */
function relayGLockRowsBlock_(r) {
  var x = r && r.rows, tail = '這次沒有鎖定。請找資訊部處理。';
  if (!x || typeof x !== 'object') return { error: 'g_rows_missing', message: 'Mac mini 還沒回報這個月核定、請假、申請和 Google 是否一致，' + tail };
  if (!(Number(x.at) > 0) || Date.now() - Number(x.at) > RELAYG_RECON_FRESH_MS_)
    return { error: 'g_rows_stale', message: 'Mac mini 回報的核定、請假、申請對帳結果超過 30 分鐘沒有更新，' + tail };
  if (x.fp === 'bad') return { error: 'g_rows_fp', message: '這個月的核定、請假或申請，Mac mini 和 Google 對不上' + ((x.bad || []).length ? '（' + x.bad.join('、') + '）' : '') + '，' + tail };
  if (x.fp !== 'ok') return { error: 'g_rows_fp_unknown', message: '這個月的核定、請假、申請還沒比對完（' + (x.why || '原因不明') + '），' + tail };
  var all = RELAYG_LOCK_SCOPE_ !== 'month';
  var u = all ? x.unwb_all : x.unwb, c = all ? x.conflict_all : x.conflict;
  u = relayGLockNum_(u); c = relayGLockNum_(c);
  if (u === null || c === null) return { error: 'g_rows_count_unknown', message: 'Mac mini 問不到「還沒寫回 Google」和「衝突待處理」的筆數，' + tail };
  if (u > 0) return { error: 'g_rows_unwb', message: 'Mac mini 還有 ' + u + ' 筆核定、審單還沒寫回 Google，請過幾分鐘再按一次鎖定；一直這樣請找資訊部。' };
  if (c > 0) return { error: 'g_rows_conflict', message: '還有 ' + c + ' 筆核定衝突待處理（Mac mini 和 Google 結果不同），要資訊部處理完才能鎖定。' };
  return null;
}

/* ══ 第 2 階段 P2-A／P2-D（2026-11-21，dzy-mini-playbook docs/clock-to-mini/phase2-5-plan.md） ══
   - P2-A：Mac mini 長時間不在、又要鎖月 → 在「光復」Apps Script 編輯器執行 relayGEditorPrimaryOff（不用參數），
     等同快速通道的 g-rollback 送 relay_mode on:false：薪資鎖月改回只看 Google（＝切換前的行為）。
   - P2-D：Google 端看「Mac mini 最後一次來 relay_pull」；超過 15 分鐘通知一次、恢復再通知一次（每次停機最多 2 封）。
     ⚠ 九店共用檔不新增 Apps Script 服務（不用 Google 的寄信服務：檔案裡出現那兩個服務名稱，連寫在註解都會被 Apps Script 判成要新權限＝九店都要重新授權，授權前打卡備援與核定全掛）。
       通知改用既有的 UrlFetchApp 送到指令碼屬性 G_WATCH_HOOK_URL（寄信的那一端由題 4 決定：例如另開的寄信小專案）。
     開關：光復指令碼屬性 G_WATCH_ON＝'1' 才通知（沒設／其他值＝關）＋觸發器（relayGWatchInstall 裝、relayGWatchUninstall 拆）。
     收件人 G_WATCH_TO、網址 G_WATCH_HOOK_URL、金鑰 G_WATCH_HOOK_TOKEN 都只放指令碼屬性，不進程式。
     只裝在光復；其他八店的 relay_pull 只多寫一個快取記號，沒有觸發器就沒有其他作用。 */
var RELAYG_WATCH_DOWN_MS_ = 15 * 60000;   // 超過這麼久沒來拉＝停了
var RELAYG_WATCH_FN_ = 'relayGWatchTick';
var RELAYG_WATCH_PROP_EVERY_S_ = 300;     // 「最後一次來拉」寫進指令碼屬性最多 5 分鐘一次（快取可能被清掉時的備援；不每 30 秒寫屬性）

/** relay_pull 每次呼叫（handleRelayPull_ 驗過金鑰後）：記「mini 剛來過」。出錯不影響拉回。 */
function relayGWatchSeen_() {
  try {
    var c = CacheService.getScriptCache(), t = String(Date.now());
    c.put('g_watch_seen', t, 21600);
    if (!c.get('g_watch_prop')) {
      PropertiesService.getScriptProperties().setProperty('G_WATCH_SEEN', t);
      c.put('g_watch_prop', '1', RELAYG_WATCH_PROP_EVERY_S_);
    }
  } catch (e) {}
}
function relayGWatchLastSeen_() {
  var a = 0, b = 0;
  try { a = Number(CacheService.getScriptCache().get('g_watch_seen')) || 0; } catch (e) {}
  try { b = Number(PropertiesService.getScriptProperties().getProperty('G_WATCH_SEEN')) || 0; } catch (e) {}
  return Math.max(a, b);
}
function relayGWatchState_() {
  try { var v = PropertiesService.getScriptProperties().getProperty('G_WATCH_STATE'); var s = v ? JSON.parse(v) : null; return s && typeof s === 'object' ? s : { state: 'up' }; }
  catch (e) { return { state: 'up' }; }
}
function relayGWatchFmt_(ms) {   // 「11/21 09:05」；分兩段格式（mini 擋卡引擎的替身只認得這幾種）
  if (!ms) return '（沒有紀錄）';
  var d = new Date(Number(ms));
  return Utilities.formatDate(d, 'Asia/Taipei', 'M/d') + ' ' + Utilities.formatDate(d, 'Asia/Taipei', 'HH:mm');
}
/** 送通知到 G_WATCH_HOOK_URL。回 {ok} 或 {ok:false, error}；不丟例外。 */
function relayGWatchSend_(kind, title, text) {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('G_WATCH_HOOK_URL') || ''), to = String(p.getProperty('G_WATCH_TO') || '');
  if (!/^https:\/\//.test(url) || !to) return { ok: false, error: 'no_hook' };
  try {
    var r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'add', token: String(p.getProperty('G_WATCH_HOOK_TOKEN') || ''), to: to, from: '打卡（Google 光復）',
        title: title, text: text, level: 'high', key: 'clock:mini-' + kind }) });
    var code = r.getResponseCode();
    return code >= 200 && code < 300 ? { ok: true } : { ok: false, error: 'http_' + code };
  } catch (e) { return { ok: false, error: 'fetch' }; }
}
/**
 * 觸發器每 10 分鐘（relayGWatchInstall 裝）：
 * - 沒開（G_WATCH_ON 不是 '1'）→ 什麼都不做。
 * - 平常 → 最後一次來拉超過 15 分鐘 → 標「停了」、送一封；送不出去下一輪再試（仍算同一次停機）。
 * - 停了 → mini 又來拉（最後一次 > 標停的時間）→ 標「恢復」；停的那封有送出才送恢復那封。
 * 回 {state, sent?, error?}（給測試與 relayGEditorStatus 看）。
 */
function relayGWatchTick() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('G_WATCH_ON') !== '1') return { state: 'off' };
  var now = Date.now(), seen = relayGWatchLastSeen_(), st = relayGWatchState_(), out = { state: st.state };
  if (!seen) return { state: 'never' };   // 開了以後 mini 一次都還沒來過：不猜（relayGWatchInstall 會先記一次）
  if (st.state !== 'down') {
    if (now - seen <= RELAYG_WATCH_DOWN_MS_) return out;
    st = { state: 'down', since: seen, at: now, down_sent: false, tries: 0 };
  } else if (seen > Number(st.at || 0)) {
    var mins = Math.round((seen - Number(st.since || seen)) / 60000);
    var up = st.down_sent ? relayGWatchSend_('up', 'Mac mini 恢復了（停了約 ' + mins + ' 分鐘）',
      '最後一次停在 ' + relayGWatchFmt_(st.since) + '，' + relayGWatchFmt_(seen) + ' 又開始來拉打卡資料。\n請照 outage-runbook 確認三件事（快速通道綠燈、營運系統 200、待抄 0）。') : { ok: true, skipped: true };
    p.setProperty('G_WATCH_STATE', JSON.stringify({ state: 'up', at: now, last_down: { since: st.since, until: seen, down_sent: !!st.down_sent, up_sent: !!(up.ok && !up.skipped) } }));
    return { state: 'up', recovered: true, sent: !!(up.ok && !up.skipped), error: up.ok ? undefined : up.error };
  }
  if (!st.down_sent) {   // 每次停機只送一封「停了」；送不出去下一輪再試
    var r = relayGWatchSend_('down', 'Mac mini 停了：超過 15 分鐘沒來拉打卡資料',
      'Mac mini 最後一次來拉資料：' + relayGWatchFmt_(st.since) + '。\n' +
      '・同仁打卡照常（手機自動改送 Google）。\n' +
      '・已改在管理系統核定的店，暫時不能核定、審單，等 Mac mini 恢復（期限順延）。\n' +
      '・處理：照 outage-runbook 到場登入。要鎖月又等不到 Mac mini：在光復 Apps Script 編輯器執行 relayGEditorPrimaryOff。');
    st.down_sent = !!r.ok; st.tries = Number(st.tries || 0) + 1; if (!r.ok) st.err = r.error; else delete st.err;
    out.sent = !!r.ok; if (!r.ok) out.error = r.error;
  }
  p.setProperty('G_WATCH_STATE', JSON.stringify(st));
  out.state = 'down';
  return out;
}

/* ── 編輯器專用（名稱不帶底線＝編輯器「執行」選單看得到）。只在光復執行。 ── */
/** P2-A：關光復的 G_PRIMARY（等同 g-rollback 的 relay_mode on:false）。之後鎖月只看 Google；Mac mini 恢復後由資訊部跑 g-switch 再打開。 */
function relayGEditorPrimaryOff() {
  var before = relayGMode_();
  PropertiesService.getScriptProperties().setProperty('G_PRIMARY', JSON.stringify({ on: false, stores: [], at: Date.now(), by: 'editor' }));
  Logger.log('已關閉「打卡正本在 Mac mini」記號：薪資鎖月不再等 Mac mini 對帳（打卡筆數、核定／請假／申請一致、未寫回、衝突都不看；原本' + (before.on ? '開著、' + (before.stores || []).length + ' 家店' : '就是關著') + '）。Mac mini 恢復後請資訊部跑 g-switch 再打開。');
  return { ok: true, was_on: !!before.on, on: false };
}
/** 看現況（只讀）：正本記號、各店對帳時間、停機通知狀態。不印金鑰與收件人。 */
function relayGEditorStatus() {
  var p = PropertiesService.getScriptProperties(), mode = relayGMode_(), recon = relayGRecon_(), seen = relayGWatchLastSeen_();
  var s = { primary: { on: !!mode.on, stores: (mode.stores || []).length, at: relayGWatchFmt_(mode.at), by: mode.by || '' },
    lock_rows: { on: relayGLockRowsOn_(), scope: RELAYG_LOCK_SCOPE_ === 'month' ? 'month' : 'store' },
    recon_at: Object.keys(recon).map(function (id) { var yms = Object.keys(recon[id]).sort(), r = recon[id][yms[yms.length - 1]] || {}; return relayGWatchFmt_(r.at); }),
    watch: { on: p.getProperty('G_WATCH_ON') === '1', hook: !!p.getProperty('G_WATCH_HOOK_URL'), to: !!p.getProperty('G_WATCH_TO'), last_seen: relayGWatchFmt_(seen), state: relayGWatchState_().state,
      trigger: (function () { try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === RELAYG_WATCH_FN_; }); } catch (e) { return null; } })() } };
  Logger.log(JSON.stringify(s, null, 2));
  return s;
}
/** P2-D：裝每 10 分鐘的觸發器（重複執行只會有一個）。裝了但 G_WATCH_ON 不是 '1' 時觸發器什麼都不做。 */
function relayGWatchInstall() {
  relayGWatchUninstall();
  ScriptApp.newTrigger(RELAYG_WATCH_FN_).timeBased().everyMinutes(10).create();
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('G_WATCH_SEEN')) p.setProperty('G_WATCH_SEEN', String(Date.now()));   // 從現在起算，免得剛裝就誤報
  Logger.log('已裝停機通知觸發器（每 10 分鐘）。要真的送通知還要設 G_WATCH_ON=1、G_WATCH_HOOK_URL、G_WATCH_TO。');
  return { ok: true };
}
function relayGWatchUninstall() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === RELAYG_WATCH_FN_) { ScriptApp.deleteTrigger(t); n++; } });
  Logger.log('拆掉停機通知觸發器 ' + n + ' 個。');
  return { ok: true, removed: n };
}
