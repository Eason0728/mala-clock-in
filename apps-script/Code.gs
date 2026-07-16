/**
 * 麻的小辛辣 員工打卡系統 - Apps Script 後端
 *
 * 部署方式（老闆手動操作，Claude 不代為部署雲端資源）：
 *   1. 開一份新的 Google 試算表，把試算表「網址」整串貼到下面 CONFIG.SPREADSHEET_ID
 *      （貼純 ID 也可以，程式會自動從網址抽出 ID）。
 *   2. 開啟 Extensions > Apps Script，貼上本檔全部內容。
 *   3. 設定 CONFIG.ADMIN_KEY（自訂一組管理密鑰，供管理端點 API 使用；
 *      排班 app 整合暫緩期間，日常名冊/裝置管理改用檔尾的編輯器管理函式）。
 *   4. 手動執行一次 setup() 函式（會要求授權），建立 roster / events 兩個分頁與表頭。
 *   5. Deploy > New deployment > Web app：Execute as「我」、Who has access「Anyone」。
 *   6. 複製部署網址，貼到 clock.html 的 API_URL 常數。
 *
 * 本檔與 mock/mock_server.py 實作同一套 API 合約：
 *   clock / whoami / sync_roster / get_roster / get_events / approve_device / my_recent
 *   mgr_day / mgr_approve（值班主管核定，2026-07-13 新增）
 * 另有 GAS 專屬 action（mock_server 不實作，因為依賴試算表分頁）：
 *   rebuild_month {admin_key, ym?}（ym 缺省＝當月，格式 yyyy-MM）→ 重算該月出勤月表分頁
 */

const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE',
  STORE_LAT: 24.7840945,   // 2026-07-13 依店內實測校正（原地址標記點偏差約 35m）
  STORE_LNG: 121.0157448,
  RADIUS_M: 20,             // 允許打卡半徑（公尺）。演變 50→5→30→20；2026-07-14 Eason 指定收緊為 20（已知代價：室內 GPS 飄移＞20m 的在店打卡可能被擋，如 7/13 有一筆 25.5m）
  ADMIN_KEY: 'PASTE_ADMIN_KEY_HERE',
  // 上下班交替判斷的回看視窗（小時）：看得到跨夜班前一晚的上班卡，
  // 但昨天忘打的下班卡（超過視窗）不會鎖死今天的上班卡。
  ALTERNATION_LOOKBACK_HOURS: 12,
};

const ROSTER_HEADERS = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'];
const LEAVE_HEADERS = ['日期', '姓名', '假別', '時數'];
const EVENTS_HEADERS = [
  'ts',
  'emp_id',
  'type',
  'lat',
  'lng',
  'distance_m',
  'within_range',
  'device_id',
  'device_match',
  'status',
];
// 值班主管核定（2026-07-13 新增）：只追加不覆蓋；同 (date,emp_id) 多筆以 entered_at 最新為準（讀取端處理）
const APPROVED_HEADERS = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'];
const MANAGERS_HEADERS = ['name', 'key', 'active'];
// 主管核定頁「請假註記」可選假別（2026-07-13 Eason 定案；改清單前後端 mock 要同步）
const LEAVE_TYPES = ['病假', '事假', '特休假', '生理假', '家庭照顧假', '喪假', '婚假'];

/**
 * 手動執行一次：建立 roster / events 兩個分頁與表頭。
 * 若分頁已存在則只補表頭，不會清空既有資料。
 */
/** CONFIG.SPREADSHEET_ID 接受整串試算表網址或純 ID。 */
function spreadsheetId() {
  const m = String(CONFIG.SPREADSHEET_ID).match(/\/d\/([a-zA-Z0-9\-_]+)/);
  return m ? m[1] : CONFIG.SPREADSHEET_ID;
}

function setup() {
  const ss = SpreadsheetApp.openById(spreadsheetId());

  let roster = ss.getSheetByName('roster');
  if (!roster) {
    roster = ss.insertSheet('roster');
  }
  roster.getRange(1, 1, 1, ROSTER_HEADERS.length).setValues([ROSTER_HEADERS]);

  let events = ss.getSheetByName('events');
  if (!events) {
    events = ss.insertSheet('events');
  }
  events.getRange(1, 1, 1, EVENTS_HEADERS.length).setValues([EVENTS_HEADERS]);

  // 請假分頁：Eason 手動填（日期 yyyy-mm-dd、姓名須與 roster.name 一致、假別如「特休」）
  let leave = ss.getSheetByName('leave');
  if (!leave) {
    leave = ss.insertSheet('leave');
  }
  leave.getRange(1, 1, 1, LEAVE_HEADERS.length).setValues([LEAVE_HEADERS]);

  // 值班主管核定紀錄：只追加不覆蓋（2026-07-13 新增）
  let approved = ss.getSheetByName('approved');
  if (!approved) {
    approved = ss.insertSheet('approved');
  }
  approved.getRange(1, 1, 1, APPROVED_HEADERS.length).setValues([APPROVED_HEADERS]);

  // 值班主管名冊：addManager() 產生 key（2026-07-13 新增）
  let managers = ss.getSheetByName('managers');
  if (!managers) {
    managers = ss.insertSheet('managers');
  }
  managers.getRange(1, 1, 1, MANAGERS_HEADERS.length).setValues([MANAGERS_HEADERS]);
}

function doGet(e) {
  return ContentService
    .createTextOutput('麻的小辛辣打卡系統後端運作中')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'bad_json' });
  }

  const handlers = {
    clock: handleClock,
    whoami: handleWhoami,
    sync_roster: handleSyncRoster,
    get_roster: handleGetRoster,
    get_events: handleGetEvents,
    approve_device: handleApproveDevice,
    rebuild_month: handleRebuildMonth,
    my_recent: handleMyRecent,
    mgr_day: handleMgrDay,
    mgr_approve: handleMgrApprove,
  };

  const handler = handlers[body.action];
  if (!handler) {
    return jsonOut({ ok: false, error: 'unknown_action' });
  }

  try {
    return jsonOut(handler(body));
  } catch (err) {
    return jsonOut({ ok: false, error: 'server_error', detail: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSS() {
  return SpreadsheetApp.openById(spreadsheetId());
}

function nowTaipeiIso() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function todayTaipeiStr() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = function (d) { return (d * Math.PI) / 180; };
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const a = Math.pow(Math.sin(dPhi / 2), 2) + Math.cos(phi1) * Math.cos(phi2) * Math.pow(Math.sin(dLambda / 2), 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function genKey(n) {
  n = n || 20;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** 讀整張表成物件陣列，每個物件多帶 __rowIndex（1-based 實際列號，含表頭）。 */
function readSheetAsObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { headers: values[0] || [], rows: [] };
  const headers = values[0];
  const rows = values.slice(1).map(function (row, idx) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    obj.__rowIndex = idx + 2;
    return obj;
  });
  return { headers: headers, rows: rows };
}

function findRosterByKey(rows, key) {
  return rows.filter(function (r) { return String(r.key) === String(key); })[0];
}

function findRosterByEmpId(rows, empId) {
  return rows.filter(function (r) { return String(r.emp_id) === String(empId); })[0];
}

function stripRowIndex(row) {
  const copy = {};
  Object.keys(row).forEach(function (k) {
    if (k !== '__rowIndex') copy[k] = row[k];
  });
  return copy;
}

/**
 * 上下班交替判斷：取該員工「現在時刻往前 ALTERNATION_LOOKBACK_HOURS 小時內」
 * status 非 rejected_* 的最後一筆事件（跨日也算）。回傳 {ts, type} 或 null。
 * pending_device_approval 也算數：核准後會翻成 ok，若不算數會造成核准後同型重複。
 */
function lastCountedEvent(eventRows, empId) {
  const cutoffMs = Date.now() - CONFIG.ALTERNATION_LOOKBACK_HOURS * 60 * 60 * 1000;
  let last = null;
  eventRows.forEach(function (e) {
    if (String(e.emp_id) !== String(empId)) return;
    if (String(e.status).indexOf('rejected_') === 0) return;
    const tsMs = new Date(String(e.ts)).getTime();
    if (isNaN(tsMs) || tsMs < cutoffMs) return;
    last = { ts: String(e.ts), type: String(e.type) };
  });
  return last;
}

/**
 * 今日出勤時數（whoami 用，同仁自助查詢，不落地寫入試算表）。
 * 只取今日（Asia/Taipei）status='ok' 的事件跑 pairShifts（沿用月表同一套配對／核定
 * 邏輯，不重寫 pairShifts/approvedHoursOfShift 本身）：
 *   reference＝已完成時段原始相減加總（小時，取 2 位小數）
 *   approved＝已完成時段 approvedHoursOfShift 加總（必為 0.25 倍數，取 2 位小數整理浮點誤差）
 * 若今日最後一筆 ok 事件是尚未配對的 in（上班中）→ working_since 為該筆「原始」HH:mm
 * （不是取整後的刻度），reference/approved 只計入已完成時段；今日無完成時段則兩者為 0。
 */
function todayHoursSummary(eventRows, empId, today) {
  const todayOkEvents = eventRows.filter(function (e) {
    if (String(e.emp_id) !== String(empId) || String(e.ts).slice(0, 10) !== today) return false;
    // 保留 ok 事件，另保留 rejected_duplicate 的 in（pairShifts 用它當忘打下班的斷點）
    return String(e.status) === 'ok' || (String(e.status) === 'rejected_duplicate' && e.type === 'in');
  });
  const paired = pairShifts(todayOkEvents);

  let reference = 0;
  let approved = 0;
  paired.shifts.forEach(function (s) {
    reference += (tsMs(s.out_ts) - tsMs(s.in_ts)) / 3600000;
    approved += approvedHoursOfShift(s.in_ts, s.out_ts);
  });

  const result = {
    reference: Math.round(reference * 100) / 100,
    approved: Math.round(approved * 100) / 100,
    working_since: null,
  };
  if (paired.unmatchedIns.length > 0) {
    const openIn = paired.unmatchedIns[paired.unmatchedIns.length - 1];
    // 這筆未配對 in 之後若已有 ok 的下班卡 → 當天其實已下班（只是中間漏刷一次），不算上班中；
    // 只有後面沒有更晚的下班卡才顯示「上班中」（被拒的重複上班卡不代表離場）。
    const laterOut = todayOkEvents.some(function (e) {
      return String(e.status) === 'ok' && e.type === 'out' && tsMs(e.ts) > tsMs(openIn.ts);
    });
    if (!laterOut) result.working_since = tsHm(openIn.ts);
  }
  return result;
}

// my_recent 回查視窗（天，含今天）。2026-07-13 Eason 指定 40 天（原規劃 14）
const RECENT_DAYS_WINDOW = 40;

/**
 * 最近 N 天出勤明細（my_recent 用，同仁自助回查，不落地寫入試算表）。
 * 配對沿用月表同一套（pairShifts，只算 status='ok'），慣例照 buildMonthlySheet：
 * 班段歸 in 那一天（跨夜段標 cross，前端顯示 (+1)）、未配對 in→「下班忘刷卡」、
 * 未配對 out→「上班忘刷卡」；事件往前多抓 1 天供跨夜配對。
 * 例外：未配對 in 落在「今天」→ 不算忘刷卡（上班中），照 today_hours 的邏輯。
 * reference＝該日已完成班段原始相減加總（取 2 位小數）。
 * approved＝值班主管在 approved 分頁核定的時數，照月表（1201 行）慣例：有紀錄→數字、
 * 無紀錄→null 讓前端顯示「待核定」。**不是** approvedHoursOfShift 的 15 分鐘取整——
 * 那是 2026-07-13 前的舊定義，核定已改為主管手動輸入實際時段（2026-07-15 改）。
 * 無任何事件的日子省略不回；回傳依日期由舊到新排序。
 */
function buildRecentDays(eventRows, empId, todayStr, approvedMap) {
  const todayMs = new Date(todayStr + 'T00:00:00Z').getTime(); // 純日期運算，todayStr 已是台北日期
  const startStr = new Date(todayMs - (RECENT_DAYS_WINDOW - 1) * 86400000).toISOString().slice(0, 10);
  const fetchStartStr = new Date(todayMs - RECENT_DAYS_WINDOW * 86400000).toISOString().slice(0, 10);

  const evs = eventRows.filter(function (e) {
    if (String(e.emp_id) !== String(empId)) return false;
    const d = tsDateStr(e.ts);
    return d >= fetchStartStr && d <= todayStr;
  });
  const paired = pairShifts(evs); // pairShifts 內部只取 status='ok'

  const dayMap = {};
  function day(d) {
    if (!dayMap[d]) dayMap[d] = { date: d, segments: [], reference: 0, notes: [] };
    return dayMap[d];
  }

  paired.shifts.forEach(function (s) {
    const d = tsDateStr(s.in_ts); // 班段歸 in 的那一天（月表慣例）
    if (d < startStr || d > todayStr) return;
    const c = day(d);
    c.segments.push({ sortMs: tsMs(s.in_ts), in: tsHm(s.in_ts), out: tsHm(s.out_ts), cross: tsDateStr(s.out_ts) !== d });
    c.reference += (tsMs(s.out_ts) - tsMs(s.in_ts)) / 3600000;
  });

  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d < startStr || d > todayStr) return;
    const c = day(d);
    c.segments.push({ sortMs: tsMs(e.ts), in: tsHm(e.ts), out: null, cross: false });
    c.notes.push(d === todayStr ? '上班中' : '下班忘刷卡');
  });

  paired.unmatchedOuts.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d < startStr || d > todayStr) return;
    const c = day(d);
    c.segments.push({ sortMs: tsMs(e.ts), in: null, out: tsHm(e.ts), cross: false });
    c.notes.push('上班忘刷卡');
  });

  return Object.keys(dayMap).sort().map(function (d) {
    const c = dayMap[d];
    c.segments.sort(function (a, b) { return a.sortMs - b.sortMs; });
    c.segments.forEach(function (s) { delete s.sortMs; });
    c.reference = Math.round(c.reference * 100) / 100;
    // 核定＝值班主管在 approved 分頁的最新核定（照月表 1201 慣例）。無紀錄→null＝待核定；
    // 有紀錄但 0 小時＝全天請假，必須與 null 區分，故用 rec 是否存在判斷、不看數值真假。
    const rec = ((approvedMap || {})[d] || {})[String(empId)];
    c.approved = rec ? Math.round(Number(rec.approved_hours) * 100) / 100 : null;
    // 核定狀態（computeApprovalStatus 於主管核定當下算好存進 status_text，月表狀態欄同源，
    // 故兩邊標記保證一致）：'遲到2分'／'早退5分'／'遲到2分、早退5分'／'該段無打卡'／
    // '有多出的打卡段'，無異常＝'正常'。這裡原樣帶回，由前端決定「正常」不顯示。
    c.approved_status = rec ? String(rec.status_text || '') : null;
    return c;
  });
}

/**
 * API：{action:'my_recent', key, device_id} → 該員工最近 RECENT_DAYS_WINDOW 天（含今天）出勤明細。
 * 驗證與 whoami 相同：key 無效（或離職）→ invalid_key；裝置照 whoami 作法只回
 * device_state 供前端提示，不因裝置不符而拒回（回查是唯讀，不產生打卡事件）。
 */
function handleMyRecent(body) {
  const ss = getSS();
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;

  const roster = findRosterByKey(rosterRows, body.key);
  if (!roster || roster.active !== true) {
    return { ok: false, error: 'invalid_key' };
  }

  const deviceId = body.device_id || '';
  let deviceState;
  if (!roster.device_id) {
    deviceState = 'unbound';
  } else if (String(roster.device_id) === String(deviceId)) {
    deviceState = 'match';
  } else {
    deviceState = 'mismatch';
  }

  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows;
  // 核定時數取自 approved 分頁；讀法與「最新一筆」判斷完全沿用 mgr_day／月表那套
  // （buildLatestApprovedMap 內部會 normCellDate，勿自己重寫日期正規化）。
  const approvedSheet = ss.getSheetByName('approved');
  const approvedRows = approvedSheet ? readSheetAsObjects(approvedSheet).rows : [];
  const approvedMap = buildLatestApprovedMap(approvedRows);
  return {
    ok: true,
    emp_id: roster.emp_id,
    name: roster.name,
    device_state: deviceState,
    days: buildRecentDays(eventRows, roster.emp_id, todayTaipeiStr(), approvedMap),
  };
}

function handleClock(body) {
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;

  const roster = findRosterByKey(rosterRows, body.key);
  if (!roster || roster.active !== true) {
    return { ok: false, error: 'invalid_key' };
  }

  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  const deviceId = body.device_id || '';
  const distanceM = Math.round(haversineM(CONFIG.STORE_LAT, CONFIG.STORE_LNG, lat, lng) * 10) / 10;
  const withinRange = distanceM <= CONFIG.RADIUS_M;
  const ts = nowTaipeiIso();

  // 檢查順序：重複檢查 → 裝置檢查 → 範圍檢查
  const lastCounted = lastCountedEvent(readSheetAsObjects(eventsSheet).rows, roster.emp_id);
  const isDuplicate = lastCounted !== null && lastCounted.type === String(body.type);

  let deviceMatch;
  if (!roster.device_id) {
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_id') + 1).setValue(deviceId);
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_bound_at') + 1).setValue(ts);
    deviceMatch = true;
  } else if (String(roster.device_id) === String(deviceId)) {
    deviceMatch = true;
  } else {
    deviceMatch = false;
  }

  // status 優先序：重複 > 裝置不符 > 超出範圍 > ok
  let status;
  if (isDuplicate) {
    status = 'rejected_duplicate';
  } else if (!deviceMatch) {
    status = 'pending_device_approval';
  } else if (!withinRange) {
    status = 'rejected_out_of_range';
  } else {
    status = 'ok';
  }

  eventsSheet.appendRow([ts, roster.emp_id, body.type, lat, lng, distanceM, withinRange, deviceId, deviceMatch, status]);

  const result = { ok: true, status: status, name: roster.name, ts: ts, distance_m: distanceM, within_range: withinRange };
  if (status === 'rejected_duplicate') {
    result.last_type = lastCounted.type;
  }
  return result;
}

function handleWhoami(body) {
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;

  const roster = findRosterByKey(rosterRows, body.key);
  if (!roster || roster.active !== true) {
    return { ok: false, error: 'invalid_key' };
  }

  const deviceId = body.device_id || '';
  let deviceState;
  if (!roster.device_id) {
    deviceState = 'unbound';
  } else if (String(roster.device_id) === String(deviceId)) {
    deviceState = 'match';
  } else {
    deviceState = 'mismatch';
  }

  const today = todayTaipeiStr();
  const eventRows = readSheetAsObjects(eventsSheet).rows;
  const todayEvents = eventRows
    .filter(function (e) { return String(e.emp_id) === String(roster.emp_id) && String(e.ts).slice(0, 10) === today; })
    .map(function (e) { return { ts: e.ts, type: e.type, status: e.status }; });

  return {
    ok: true,
    emp_id: roster.emp_id,
    name: roster.name,
    device_state: deviceState,
    today_events: todayEvents,
    // 前端按鈕灰階/擋卡提醒用這個判斷（12 小時回看視窗，跨日也算），
    // 不要自己從 today_events 算，避免跨日時兩邊算法不一致。
    last_counted: lastCountedEvent(eventRows, roster.emp_id),
    today_hours: todayHoursSummary(eventRows, roster.emp_id, today),
  };
}

function checkAdmin(body) {
  return body.admin_key === CONFIG.ADMIN_KEY;
}

function handleSyncRoster(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };

  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;
  const employees = body.employees || [];

  employees.forEach(function (emp) {
    const existing = findRosterByEmpId(rosterRows, emp.emp_id);
    if (existing) {
      // 只更新 name/active，絕不覆蓋 key/device_id/device_bound_at
      rosterSheet.getRange(existing.__rowIndex, ROSTER_HEADERS.indexOf('name') + 1).setValue(emp.name);
      rosterSheet.getRange(existing.__rowIndex, ROSTER_HEADERS.indexOf('active') + 1).setValue(!!emp.active);
    } else {
      rosterSheet.appendRow([emp.emp_id, emp.name, genKey(), '', '', !!emp.active]);
    }
  });

  const finalRows = readSheetAsObjects(rosterSheet).rows.map(stripRowIndex);
  return { ok: true, roster: finalRows };
}

function handleGetRoster(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ss = getSS();
  const rows = readSheetAsObjects(ss.getSheetByName('roster')).rows.map(stripRowIndex);
  return { ok: true, roster: rows };
}

function handleGetEvents(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ss = getSS();
  const rows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(stripRowIndex);

  const toDate = body.to ? new Date(body.to + 'T23:59:59+08:00') : new Date();
  const fromDate = body.from
    ? new Date(body.from + 'T00:00:00+08:00')
    : new Date(toDate.getTime() - 31 * 24 * 60 * 60 * 1000);

  const filtered = rows.filter(function (e) {
    const d = new Date(String(e.ts));
    return d >= fromDate && d <= toDate;
  });

  return { ok: true, events: filtered };
}

/**
 * 裝置核准/拒絕的共用邏輯（API 的 approve_device 與編輯器端
 * approvePendingDevice / rejectPendingDevice 都走這裡，勿複製兩份）。
 * approve=true：roster 改綁該裝置＋pending events 改 ok、device_match=true；
 * approve=false：pending events 改 rejected_device，roster 不改綁。
 */
function applyDeviceDecision(empId, deviceId, approve) {
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;
  const roster = findRosterByEmpId(rosterRows, empId);
  if (!roster) return { ok: false, error: 'invalid_emp_id' };

  if (approve) {
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_id') + 1).setValue(deviceId);
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_bound_at') + 1).setValue(nowTaipeiIso());
  }

  let changed = 0;
  const affectedMonths = {};
  const eventRows = readSheetAsObjects(eventsSheet).rows;
  eventRows.forEach(function (e) {
    if (
      String(e.emp_id) === String(empId) &&
      String(e.device_id) === String(deviceId) &&
      e.status === 'pending_device_approval'
    ) {
      // 核准只解「裝置」這一關：超出範圍的卡翻成 rejected_out_of_range，不得入帳
      // （否則在家用新裝置打卡→核准換機→在家打的卡變有效，2026-07-12 實測抓到的漏洞）
      const newStatus = approve
        ? (e.within_range === true ? 'ok' : 'rejected_out_of_range')
        : 'rejected_device';
      eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('status') + 1).setValue(newStatus);
      if (approve) {
        eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('device_match') + 1).setValue(true);
      }
      // 記下受影響月份：月表註記放在 tsDateStr(e.ts) 那天，取同一日期的 yyyy-MM 才一致；
      // e.ts 由原始儲存格讀出可能是 Date，先 normCellTs 正規化成台北 ISO 字串再切。
      const ym = tsDateStr(normCellTs(e.ts)).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(ym)) affectedMonths[ym] = true;
      changed++;
    }
  });

  // 就地改既有列的狀態不新增 events 列 → 每 10 分鐘「列數變化式」自動重算會跳過，
  // 月表會停在舊狀態（例：核准裝置後仍顯示「新裝置待核准」）。故核准/拒絕有異動時
  // 主動重算受影響月份，讓變更即時反映。重算失敗不得回滾已完成的核准，故 try/catch 吞掉。
  // （2026-07-14 根治；沿用 handleRebuildMonth 的無鎖直接呼叫慣例。rebuilt 欄同時當「新版已部署」的辨識訊號）
  const rebuilt = [];
  Object.keys(affectedMonths).forEach(function (ym) {
    try { rebuildMonth(ym); rebuilt.push(ym); } catch (err) {}
  });

  return { ok: true, changed: changed, rebuilt: rebuilt };
}

function handleApproveDevice(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return applyDeviceDecision(body.emp_id, body.device_id, !!body.approve);
}

/* ============================================================
 * 值班主管核定 — API（2026-07-13 新增）
 * 依賴的純函式（dayPunchSegments/computeApprovalStatus/buildLatestApprovedMap/
 * hmToMs/addDaysStr）定義在下方「出勤月表 — 純函式區」，因 function 宣告會 hoist，
 * 這裡可直接呼叫。
 * ============================================================ */

function findManagerByKey(rows, key) {
  return rows.filter(function (r) { return String(r.key) === String(key) && r.active === true; })[0];
}

/** 'HH:mm-HH:mm,HH:mm-HH:mm' → [{start,end}] */
function parsePeriodsStr(s) {
  if (!s) return [];
  return String(s).split(',').filter(function (x) { return x; }).map(function (part) {
    const kv = part.split('-');
    return { start: kv[0], end: kv[1] };
  });
}

/**
 * API：{action:'mgr_day', mgr_key, date?}（date 缺省＝今天，Asia/Taipei）
 * → 回傳「roster 全部 active 同仁」（2026-07-13 Eason 實測回饋改版：當天沒打卡的也要出現，
 *   整天忘刷卡的人才核得到——segments 空陣列、reference=null，主管照樣可輸入時段核定）：
 *   有打卡的照舊顯示打卡段（沿用 pairShifts，未配對顯示？）＋參考時數、既有核定紀錄（最新一筆）。
 *   排序：有打卡的在前（依當日第一筆打卡時間），沒打卡的在後（依名冊順序）。
 *   名冊外（或已離職）但當天有事件的 emp_id 補在最後，防禦用。
 */
function handleMgrDay(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };

  const date = body.date || todayTaipeiStr();
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows;
  const approvedSheet = ss.getSheetByName('approved');
  const approvedRows = approvedSheet ? readSheetAsObjects(approvedSheet).rows : [];
  const approvedMap = buildLatestApprovedMap(approvedRows);

  // 該日 leave 分頁的假別＋時數（姓名→值；同日同人多筆時最後一筆為準，與 upsertLeaveRow 保留邏輯一致）
  const leaveSheetForDay = ss.getSheetByName('leave');
  const leaveByName = {};
  const leaveHoursByName = {};
  if (leaveSheetForDay) {
    readSheetAsObjects(leaveSheetForDay).rows.forEach(function (l) {
      if (normCellDate(l['日期']) !== date) return;
      const nm = String(l['姓名'] || '').trim();
      leaveByName[nm] = String(l['假別'] || '').trim();
      leaveHoursByName[nm] = l['時數'] === '' || l['時數'] == null ? '' : Number(l['時數']);
    });
  }

  // 該日每位員工最早一筆事件時間（有打卡者排序用；任何 status 的事件都算「有打卡」）
  const firstTs = {};
  eventRows.forEach(function (e) {
    if (tsDateStr(e.ts) !== date) return;
    const emp = String(e.emp_id);
    if (!firstTs[emp] || String(e.ts) < firstTs[emp]) firstTs[emp] = String(e.ts);
  });

  // roster 全部 active 同仁都列；名冊外但當天有事件者補最後（防禦，理論上不會發生）
  const listed = [];
  const seen = {};
  rosterRows.forEach(function (r) {
    if (String(r.active).toLowerCase() !== 'true') return;
    const emp = String(r.emp_id);
    listed.push({ emp_id: emp, name: String(r.name), rosterIdx: listed.length });
    seen[emp] = true;
  });
  Object.keys(firstTs).sort().forEach(function (emp) {
    if (!seen[emp]) {
      const roster = findRosterByEmpId(rosterRows, emp);
      listed.push({ emp_id: emp, name: roster ? String(roster.name) : emp, rosterIdx: listed.length });
    }
  });

  // 排序：有打卡的在前（依第一筆打卡時間），沒打卡的在後（依名冊順序）
  listed.sort(function (a, b) {
    const fa = firstTs[a.emp_id];
    const fb = firstTs[b.emp_id];
    if (fa && fb) return fa < fb ? -1 : (fa > fb ? 1 : 0);
    if (fa) return -1;
    if (fb) return 1;
    return a.rosterIdx - b.rosterIdx;
  });

  const employees = listed.map(function (item) {
    const hasPunch = !!firstTs[item.emp_id];
    const punch = hasPunch ? dayPunchSegments(eventRows, item.emp_id, date) : null;
    const out = {
      emp_id: item.emp_id,
      name: item.name,
      segments: hasPunch ? punch.segments : [],
      reference: hasPunch ? punch.reference : null, // 沒打卡＝參考空白
      leave_type: leaveByName[item.name] || '',
      leave_hours: (leaveHoursByName[item.name] === '' || leaveHoursByName[item.name] == null) ? '' : leaveHoursByName[item.name],
    };
    const rec = (approvedMap[date] || {})[item.emp_id];
    if (rec) {
      out.approved = {
        periods: parsePeriodsStr(rec.periods),
        approved_hours: Number(rec.approved_hours) || 0,
        status_text: String(rec.status_text || ''),
        manager_name: String(rec.manager_name || ''),
      };
    }
    return out;
  });

  return { ok: true, date: date, employees: employees };
}

/**
 * API：{action:'mgr_approve', mgr_key, date, emp_id, periods:[{start,end}]}
 * → 驗證格式、計算核定時數與遲到早退判定，append 到 approved 分頁（只追加不覆蓋），
 *   回傳計算結果讓主管頁立即顯示。
 * 比對規則：每個輸入時段找重疊最大的打卡段；該段無任何打卡→「該段無打卡」；
 *   打卡段多於輸入段→「有多出的打卡段」；早到晚走不加時數、算正常（無寬限：遲到/早退各自標記分鐘數）。
 */
function handleMgrApprove(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };

  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };

  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  const roster = findRosterByEmpId(rosterRows, body.emp_id);
  if (!roster) return { ok: false, error: 'invalid_emp_id' };

  const leaveType = String(body.leave_type || '').trim();
  if (leaveType && LEAVE_TYPES.indexOf(leaveType) === -1) return { ok: false, error: 'bad_leave_type' };
  // 請假時數：可留空（＝只註記假別、不記時數）；有填要是 0 以上的數字，四捨五入到 2 位。
  let leaveHours = '';
  if (leaveType && body.leave_hours !== '' && body.leave_hours != null) {
    const h = Number(body.leave_hours);
    if (!isFinite(h) || h < 0) return { ok: false, error: 'bad_leave_hours' };
    leaveHours = Math.round(h * 100) / 100;
  }

  const rawPeriods = body.periods || [];
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(rawPeriods)) return { ok: false, error: 'bad_periods' };

  let approvedHours, periodsStr, statusText;
  if (rawPeriods.length === 0) {
    // 整天請假：沒有任何上班時段，但必須有假別；核定 0 小時、狀態標「全天請假」
    // （沒假別的空送出仍擋掉）。這樣月表那天顯示核定 0h＋假別，而非誤導的「待核定」。
    if (!leaveType) return { ok: false, error: 'bad_periods' };
    approvedHours = 0;
    periodsStr = '';
    statusText = '全天請假';
  } else {
    for (let i = 0; i < rawPeriods.length; i++) {
      const p = rawPeriods[i];
      if (!p || !timeRe.test(p.start) || !timeRe.test(p.end)) return { ok: false, error: 'bad_periods' };
    }
    const periods = rawPeriods.map(function (p) {
      const startMs = hmToMs(date, p.start);
      let endMs = hmToMs(date, p.end);
      if (endMs <= startMs) endMs += 24 * 3600000; // 跨夜段：end<=start 視為+1天
      return { start: p.start, end: p.end, startMs: startMs, endMs: endMs };
    });
    approvedHours = 0;
    periods.forEach(function (p) { approvedHours += (p.endMs - p.startMs) / 3600000; });
    approvedHours = Math.round(approvedHours * 100) / 100;

    const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows;
    const punch = dayPunchSegments(eventRows, body.emp_id, date);
    const punchWithMs = punch.segments.map(function (s) {
      const outDate = s.cross ? addDaysStr(date, 1) : date;
      return {
        in: s.in, out: s.out,
        inMs: s.in ? hmToMs(date, s.in) : null,
        outMs: s.out ? hmToMs(outDate, s.out) : null,
      };
    });
    statusText = computeApprovalStatus(periods, punchWithMs);
    periodsStr = rawPeriods.map(function (p) { return p.start + '-' + p.end; }).join(',');
  }
  const enteredAt = nowTaipeiIso();

  const approvedSheet = ss.getSheetByName('approved');
  if (!approvedSheet) return { ok: false, error: 'approved_sheet_missing' };
  approvedSheet.appendRow([date, body.emp_id, roster.name, periodsStr, approvedHours, statusText, mgr.name, enteredAt]);
  upsertLeaveRow(ss, date, String(roster.name), leaveType, leaveHours);

  return {
    ok: true, date: date, emp_id: body.emp_id, name: roster.name,
    periods: rawPeriods, approved_hours: approvedHours, leave_type: leaveType, leave_hours: leaveHours,
    status_text: statusText, manager_name: mgr.name, entered_at: enteredAt,
  };
}

/**
 * 主管核定夾帶的請假註記寫回 leave 分頁：同日同人維持最多一筆——
 * 有假別＝更新既有列的假別＋時數（無則新增）；空字串＝刪除既有列（主管改回「無」重送時清掉，
 * 含 Eason 手填的同日同人列——核定頁送出後以核定頁為準）。
 * 多筆歷史重複列順手去重，只留最後一筆。leaveHours 傳 '' ＝時數欄留空。
 */
function upsertLeaveRow(ss, date, name, leaveType, leaveHours) {
  const sheet = ss.getSheetByName('leave');
  if (!sheet) return;
  const hours = (leaveHours === '' || leaveHours == null) ? '' : leaveHours;
  const matches = readSheetAsObjects(sheet).rows
    .filter(function (r) {
      return normCellDate(r['日期']) === date && String(r['姓名'] || '').trim() === name;
    })
    .map(function (r) { return r.__rowIndex; });
  let kept = matches.length ? matches[matches.length - 1] : 0;
  for (let j = matches.length - 2; j >= 0; j--) {
    sheet.deleteRow(matches[j]); // 由下往上刪重複列，避免列號位移
    kept--; // 刪的都在保留列上方，保留列每次上移一列
  }
  if (leaveType) {
    if (kept) sheet.getRange(kept, 3, 1, 2).setValues([[leaveType, hours]]);
    else sheet.appendRow([date, name, leaveType, hours]);
  } else if (kept) {
    sheet.deleteRow(kept);
  }
}

/* ============================================================
 * 出勤月表 — 純函式區
 * 只吃 plain object 陣列、回列陣列，不碰 SpreadsheetApp/Utilities，
 * 可直接用 node 載入本檔測試（本檔頂層無任何 GAS 呼叫）。
 * ============================================================ */

// in 配「12 小時內的下一筆 out」的配對視窗（小時）
const MONTHLY_PAIR_WINDOW_HOURS = 12;
// 被拒的重複上班卡（rejected_duplicate 的 in）距開著的 in 達此分鐘數 → 視為忘打下班的斷點
// （見 pairShifts）。低於此門檻＝手滑連按，忽略不斷段。
const REJECTED_IN_BREAK_MIN = 60;
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
// 備註欄中屬於「異常」的字樣（列入異常筆數統計、明細標紅）；假別不算異常
const ABNORMAL_NOTES = ['下班忘刷卡', '上班忘刷卡', '新裝置待核准', '超出範圍嘗試'];

function tsMs(ts) { return new Date(String(ts)).getTime(); }
function tsDateStr(ts) { return String(ts).slice(0, 10); }
function tsHm(ts) { return String(ts).slice(11, 16); }
function pad2(n) { return ('0' + n).slice(-2); }

function lastDayOfMonth(ym) {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(5, 7), 10);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function prevYm(ym) {
  let y = parseInt(ym.slice(0, 4), 10);
  let m = parseInt(ym.slice(5, 7), 10) - 1;
  if (m === 0) { m = 12; y--; }
  return y + '-' + pad2(m);
}

/** 0=日 … 6=六（用 UTC 午夜算，避開時區位移） */
function weekdayOf(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

/**
 * 核定工時（Eason 定案）：打卡時間「各自」取整到 15 分鐘刻度再相減，不是段長捨去——
 * 上班先捨秒、往「後」進位到刻度（11:02→11:15；剛好在刻度不動）；
 * 下班先捨秒、往「前」捨去到刻度（14:31→14:30）。
 * 每段＝取整後相減（取整後 out ≤ in 該段＝0），當日＝各段相加，跨夜段同規則。
 * 例：11:02–14:31＋17:05–21:44 → 3.25＋4.25 ＝ 7.5H。
 * （epoch 分鐘取整可對齊本地 15 分鐘刻度：epoch 起點在刻度上、+08:00 也是 15 的倍數。）
 */
function approvedHoursOfShift(inTs, outTs) {
  const inMin = Math.floor(tsMs(inTs) / 60000);   // 捨秒
  const outMin = Math.floor(tsMs(outTs) / 60000); // 捨秒
  const inGrid = Math.ceil(inMin / 15) * 15;      // 上班往後進位到刻度
  const outGrid = Math.floor(outMin / 15) * 15;   // 下班往前捨去到刻度
  return Math.max(0, (outGrid - inGrid) / 60);
}

/**
 * 打卡事件配對成班段。取 status='ok' 的 in/out 配對，另把 status='rejected_duplicate'
 * 的 in 當「新一段的實際起點」：同仁上班中途忘打下班、隔一段又打上班被交替防呆擋下——
 * 這筆雖被拒不算正式打卡，但系統有記到時間，代表前一段班已結束、新一段從這裡開始。
 * 用它把開著的 in 收成「下班忘刷卡」＋以它當新 open 起點，讓後面的 out 配成完整段
 * （不是把它當忘刷卡冤枉同仁，也不會 11:02 in 與 21:44 out 相距＜12h 被誤併成一長段）。
 * 依員工分組、時間排序，in 配「MONTHLY_PAIR_WINDOW_HOURS 小時內的下一筆 out」（途中遇到
 * 另一筆 in 就斷）；被拒 in 距開著的 in ≥ REJECTED_IN_BREAK_MIN 分鐘才視為換段（低於＝手滑連按，忽略）。
 * 回傳 { shifts:[{emp_id,in_ts,out_ts}], unmatchedIns:[event], unmatchedOuts:[event] }。
 */
function pairShifts(events) {
  const byEmp = {};
  events.forEach(function (e) {
    const st = String(e.status);
    const isOk = st === 'ok' && (e.type === 'in' || e.type === 'out');
    const isBreakMark = st === 'rejected_duplicate' && e.type === 'in';
    if (!isOk && !isBreakMark) return;
    const k = String(e.emp_id);
    (byEmp[k] = byEmp[k] || []).push(e);
  });

  const shifts = [];
  const unmatchedIns = [];
  const unmatchedOuts = [];

  Object.keys(byEmp).forEach(function (emp) {
    const evs = byEmp[emp].slice().sort(function (a, b) { return tsMs(a.ts) - tsMs(b.ts); });
    let open = null;
    evs.forEach(function (e) {
      if (String(e.status) === 'rejected_duplicate') {
        // 被擋的重複上班卡：距開著的 in ≥ 門檻 → 前段忘打下班（收未配對），以本卡當新段起點。
        // 未達門檻＝手滑連按，忽略（open 不變）；沒有開著的 in → 也以本卡當新段起點（防禦，
        // 例如視窗外的 ok in 未抓到），讓後面的 out 仍能配成段而非誤判上班忘刷卡。
        if (!open) {
          open = e;
        } else if (tsMs(e.ts) - tsMs(open.ts) >= REJECTED_IN_BREAK_MIN * 60000) {
          unmatchedIns.push(open);
          open = e;
        }
        return;
      }
      if (e.type === 'in') {
        if (open) unmatchedIns.push(open); // 途中遇到另一筆 in → 前一筆 in 斷掉
        open = e;
      } else if (open && tsMs(e.ts) - tsMs(open.ts) <= MONTHLY_PAIR_WINDOW_HOURS * 3600000) {
        shifts.push({ emp_id: emp, in_ts: String(open.ts), out_ts: String(e.ts) });
        open = null;
      } else {
        if (open) { unmatchedIns.push(open); open = null; } // out 超過視窗 → in 也配不到
        unmatchedOuts.push(e);
      }
    });
    if (open) unmatchedIns.push(open);
  });

  return { shifts: shifts, unmatchedIns: unmatchedIns, unmatchedOuts: unmatchedOuts };
}

/* ---- 值班主管核定用的純函式（2026-07-13 新增，供 handleMgrDay/handleMgrApprove/buildMonthlySheet 共用） ---- */

/** dateStr 'yyyy-MM-dd' 位移 n 天（純日期運算，避開時區位移）。 */
function addDaysStr(dateStr, n) {
  const ms = new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 'yyyy-MM-dd' + 'HH:mm' → 該台北時刻的 epoch ms（明寫 +08:00，不依賴專案時區設定）。 */
function hmToMs(dateStr, hm) {
  return new Date(dateStr + 'T' + hm + ':00+08:00').getTime();
}

/**
 * 單一員工單一天的打卡段（給 mgr_day/mgr_approve 用，沿用 pairShifts）。
 * 事件往前後各多抓 1 天供跨夜配對，只回傳歸屬 dateStr 這天的班段。
 * 回傳 { segments:[{in,out,cross}]（未配對一端為 null）, reference（已完成時段小時數，2 位小數）}。
 */
function dayPunchSegments(eventRows, empId, dateStr) {
  const lo = addDaysStr(dateStr, -1);
  const hi = addDaysStr(dateStr, 1);
  const evs = eventRows.filter(function (e) {
    return String(e.emp_id) === String(empId) && tsDateStr(e.ts) >= lo && tsDateStr(e.ts) <= hi;
  });
  const paired = pairShifts(evs);
  const segments = [];
  let reference = 0;

  paired.shifts.forEach(function (s) {
    const d = tsDateStr(s.in_ts);
    if (d !== dateStr) return;
    segments.push({ sortMs: tsMs(s.in_ts), in: tsHm(s.in_ts), out: tsHm(s.out_ts), cross: tsDateStr(s.out_ts) !== d });
    reference += (tsMs(s.out_ts) - tsMs(s.in_ts)) / 3600000;
  });
  paired.unmatchedIns.forEach(function (e) {
    if (tsDateStr(e.ts) !== dateStr) return;
    segments.push({ sortMs: tsMs(e.ts), in: tsHm(e.ts), out: null, cross: false });
  });
  paired.unmatchedOuts.forEach(function (e) {
    if (tsDateStr(e.ts) !== dateStr) return;
    segments.push({ sortMs: tsMs(e.ts), in: null, out: tsHm(e.ts), cross: false });
  });

  segments.sort(function (a, b) { return a.sortMs - b.sortMs; });
  segments.forEach(function (s) { delete s.sortMs; });
  return { segments: segments, reference: Math.round(reference * 100) / 100 };
}

/**
 * 比對主管輸入時段 vs 打卡段，回傳狀態字串（'正常' 或以「、」串接的異常註記）。
 * 規則（無寬限）：每個輸入時段找重疊最大的打卡段；in 晚於時段起點→「遲到X分」；
 * out 早於時段終點→「早退X分」；早到晚走不標記。該段完全找不到重疊打卡→「該段無打卡」。
 * 打卡的完整段（in+out 皆有）多於被用掉的輸入段數→再加一句「有多出的打卡段」。
 * @param {Array} periods [{startMs,endMs}]
 * @param {Array} punchSegments dayPunchSegments().segments 各自加上 inMs/outMs（未配對為 null）
 */
function computeApprovalStatus(periods, punchSegments) {
  const fullSegs = punchSegments.filter(function (s) { return s.inMs != null && s.outMs != null; });
  const notes = [];
  const usedIdx = {};

  periods.forEach(function (p) {
    let bestIdx = -1;
    let bestOverlap = 0;
    fullSegs.forEach(function (seg, i) {
      const overlap = Math.min(p.endMs, seg.outMs) - Math.max(p.startMs, seg.inMs);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIdx = i; }
    });
    if (bestIdx === -1) {
      if (notes.indexOf('該段無打卡') === -1) notes.push('該段無打卡');
      return;
    }
    usedIdx[bestIdx] = true;
    const seg = fullSegs[bestIdx];
    if (seg.inMs > p.startMs) notes.push('遲到' + Math.round((seg.inMs - p.startMs) / 60000) + '分');
    if (seg.outMs < p.endMs) notes.push('早退' + Math.round((p.endMs - seg.outMs) / 60000) + '分');
  });

  if (fullSegs.length > Object.keys(usedIdx).length) notes.push('有多出的打卡段');
  return notes.length ? notes.join('、') : '正常';
}

/**
 * approved 分頁原始列（可能同 (date,emp_id) 多筆）→ {date: {emp_id: 最新一筆}}。
 * 「最新」以 entered_at 字串比較（格式固定為台北 ISO，字串序＝時序）。
 */
function buildLatestApprovedMap(approvedRecords) {
  const map = {};
  approvedRecords.forEach(function (r) {
    // r.date 由儲存格讀出可能被 Sheets 轉成 Date 物件，必須 normCellDate 而非 tsDateStr
    //（String(Date) 開頭是 "Tue Jul 14"，slice 10 字對不上 yyyy-MM-dd，核定紀錄會整批查不回來）
    const d = normCellDate(r.date);
    const emp = String(r.emp_id);
    if (!map[d]) map[d] = {};
    const existing = map[d][emp];
    if (!existing || normCellTs(r.entered_at) > normCellTs(existing.entered_at)) {
      map[d][emp] = r;
    }
  });
  return map;
}

/**
 * 產生月表分頁的全部列＋格式標記（純函式）。
 * @param {string} ym 'yyyy-MM'
 * @param {Array} roster [{emp_id,name,active}]（依 roster 順序輸出累計）
 * @param {Array} events [{ts,emp_id,type,status}] 必須涵蓋「月初往前 1 天～月底往後 1 天」
 *                （跨月班段配對用：班段歸 in 日所在月份；上月末深夜 in 配到本月初 out 時，
 *                 該 out 不得在本月被判「上班忘刷卡」）
 * @param {Array} leaves [{date:'yyyy-mm-dd',name,type}] leave 分頁原始列（姓名未比對）
 * @param {string} todayStr 'yyyy-mm-dd'（台北）——當月明細只列到今天
 * @param {Array} approvedRecords approved 分頁原始列（可能同 (date,emp_id) 多筆，內部取最新一筆；
 *                可省略＝[]，此時核定欄全部顯示「待核定」）。核定工時／狀態（遲到/早退）改由此讀，
 *                不再用 approvedHoursOfShift 算（2026-07-13 值班主管核定改版，approvedHoursOfShift
 *                函式仍保留給 whoami/my_recent 用，不在月表出現）。
 * @returns {{rows:Array, boldRows:Array, weekendRows:Array, abnormalNoteRows:Array}}
 *          rows 為 6 欄列陣列（明細依員工分區塊，參考時數／核定時數並列）；*Rows 皆為 1-based 列號
 */
function buildMonthlySheet(ym, roster, events, leaves, todayStr, approvedRecords) {
  const approvedMap = buildLatestApprovedMap(approvedRecords || []);
  const activeRoster = roster.filter(function (r) { return String(r.active).toLowerCase() === 'true'; });

  const lastDay = lastDayOfMonth(ym);
  const todayYm = todayStr.slice(0, 7);
  let endDay;
  if (ym < todayYm) endDay = lastDay;         // 過去月份：整月
  else if (ym === todayYm) endDay = parseInt(todayStr.slice(8, 10), 10); // 當月：到今天
  else endDay = 0;                            // 未來月份：不產明細

  const nameToEmp = {};
  activeRoster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });
  const empName = {};
  roster.forEach(function (r) { empName[String(r.emp_id)] = String(r.name); });

  function inMonthToEnd(dateStr) {
    return dateStr.slice(0, 7) === ym && parseInt(dateStr.slice(8, 10), 10) <= endDay;
  }

  // 每日×每員工一格：班段/備註/時數彙整
  const cellMap = {};
  function cell(dateStr, emp) {
    const k = dateStr + '||' + emp;
    if (!cellMap[k]) {
      cellMap[k] = { date: dateStr, emp_id: emp, segments: [], notes: [], hours: 0, hasComplete: false, incomplete: false };
    }
    return cellMap[k];
  }

  const paired = pairShifts(events);

  paired.shifts.forEach(function (s) {
    const d = tsDateStr(s.in_ts); // 班段歸 in 的那一天
    if (!inMonthToEnd(d)) return;
    const cross = tsDateStr(s.out_ts) !== d;
    const c = cell(d, String(s.emp_id));
    c.segments.push({ sortMs: tsMs(s.in_ts), text: tsHm(s.in_ts) + '–' + tsHm(s.out_ts) + (cross ? '(+1)' : '') });
    c.hours += (tsMs(s.out_ts) - tsMs(s.in_ts)) / 3600000;
    c.hasComplete = true;
  });

  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (!inMonthToEnd(d)) return;
    const c = cell(d, String(e.emp_id));
    c.segments.push({ sortMs: tsMs(e.ts), text: tsHm(e.ts) + '–？' });
    if (d === todayStr) {
      // 今天的未配對上班卡＝人還在上班，顯示「上班中」、當天已完成班段時數照計，
      // 不標忘刷卡（營業時間看月表才不會滿版假忘刷卡）；隔天起才算真的下班忘刷卡
      c.notes.push('上班中');
    } else {
      c.notes.push('下班忘刷卡');
      c.incomplete = true;
    }
  });

  paired.unmatchedOuts.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (!inMonthToEnd(d)) return;
    const c = cell(d, String(e.emp_id));
    c.segments.push({ sortMs: tsMs(e.ts), text: '？–' + tsHm(e.ts) });
    c.notes.push('上班忘刷卡');
    c.incomplete = true;
  });

  // pending → 備註不入班段；超出範圍 → 備註；rejected_duplicate / rejected_device 不顯示（雜訊）
  events.forEach(function (e) {
    const st = String(e.status);
    if (st !== 'pending_device_approval' && st !== 'rejected_out_of_range') return;
    const d = tsDateStr(e.ts);
    if (!inMonthToEnd(d)) return;
    cell(d, String(e.emp_id)).notes.push(st === 'pending_device_approval' ? '新裝置待核准' : '超出範圍嘗試');
  });

  // 請假：姓名 trim 後精確比對 roster.name，比不到就跳過該列。
  // 請假天數計整月（含當月未到期的已填假單）；明細列只到今天。
  const leaveDates = {};
  const leaveHoursByEmp = {};
  leaves.forEach(function (l) {
    const emp = nameToEmp[String(l.name || '').trim()];
    if (!emp) return;
    const d = String(l.date || '').slice(0, 10);
    if (d.slice(0, 7) !== ym) return;
    (leaveDates[emp] = leaveDates[emp] || {})[d] = true;
    const h = (l.hours === '' || l.hours == null) ? null : Number(l.hours);
    if (h != null && isFinite(h)) leaveHoursByEmp[emp] = (leaveHoursByEmp[emp] || 0) + h;
    if (inMonthToEnd(d)) {
      const label = String(l.type || '請假') + (h != null && isFinite(h) ? Math.round(h * 100) / 100 + 'h' : '');
      cell(d, emp).notes.push(label);
    }
  });

  // 核定紀錄可能落在沒有任何打卡事件的日子（主管手動補登實際時段），
  // 確保這種 (date,emp) 也有格子可以顯示核定時數/狀態。
  Object.keys(approvedMap).forEach(function (d) {
    if (!inMonthToEnd(d)) return;
    Object.keys(approvedMap[d]).forEach(function (emp) { cell(d, emp); });
  });

  // ---- 每員工統計（上段累計與區塊小計共用） ----
  const empStats = {}; // emp -> { total, abnormal }
  Object.keys(cellMap).forEach(function (k) {
    const c = cellMap[k];
    const s = (empStats[c.emp_id] = empStats[c.emp_id] || { total: 0, abnormal: 0 });
    if (!c.incomplete) s.total += c.hours; // 有忘刷卡的那天整天不計入參考時數
    c.notes.forEach(function (n) { if (ABNORMAL_NOTES.indexOf(n) !== -1) s.abnormal++; });
  });

  // 核定時數改讀 approved 分頁（每人每月累計＝當月每天最新一筆核定紀錄的 approved_hours 加總）
  const approvedTotalByEmp = {};
  Object.keys(approvedMap).forEach(function (d) {
    if (!inMonthToEnd(d)) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      approvedTotalByEmp[emp] = (approvedTotalByEmp[emp] || 0) + (Number(approvedMap[d][emp].approved_hours) || 0);
    });
  });

  // 核定工時是 0.25 的倍數，用 2 位小數整理浮點誤差（勿取 1 位，會把 .75 進成 .8）
  function roundApproved(x) { return Math.round(x * 100) / 100; }

  // ---- 組列（6 欄）----
  const rows = [];
  const boldRows = [];
  const weekendRows = [];
  const abnormalNoteRows = [];

  rows.push(['姓名', '參考時數', '核定時數', '異常筆數', '請假天數', '請假時數']);
  boldRows.push(1);

  activeRoster.forEach(function (r) {
    const emp = String(r.emp_id);
    const s = empStats[emp] || { total: 0, abnormal: 0 };
    const leaveCount = Object.keys(leaveDates[emp] || {}).length;
    const leaveHoursSum = leaveHoursByEmp[emp] ? Math.round(leaveHoursByEmp[emp] * 100) / 100 : '';
    rows.push([String(r.name), Math.round(s.total * 10) / 10, roundApproved(approvedTotalByEmp[emp] || 0), s.abnormal, leaveCount, leaveHoursSum]);
  });

  rows.push(['', '', '', '', '', '']);
  rows.push(['日期', '星期', '班段', '參考時數', '核定時數', '狀態']);
  boldRows.push(rows.length);

  // 明細：依員工分組（roster 順序、只列 active 或該月有紀錄者），每人一個區塊
  const blockEmps = [];
  roster.forEach(function (r) {
    const emp = String(r.emp_id);
    const isActive = String(r.active).toLowerCase() === 'true';
    if (isActive || empStats[emp]) blockEmps.push(emp);
  });
  Object.keys(empStats).sort().forEach(function (emp) { // 名冊外但有紀錄者（理論上不會發生）補在最後
    if (blockEmps.indexOf(emp) === -1) blockEmps.push(emp);
  });

  blockEmps.forEach(function (emp, idx) {
    if (idx > 0) rows.push(['', '', '', '', '', '']); // 區塊之間空一列
    rows.push([empName[emp] || emp, '', '', '', '', '']); // 粗體姓名標題列
    boldRows.push(rows.length);

    const dayCells = Object.keys(cellMap).map(function (k) { return cellMap[k]; })
      .filter(function (c) { return c.emp_id === emp; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    dayCells.forEach(function (c) {
      const wd = weekdayOf(c.date);
      c.segments.sort(function (a, b) { return a.sortMs - b.sortMs; });
      const seg = c.segments.map(function (s) { return s.text; }).join('、');
      // 參考時數：當天只要有任一筆忘刷卡 → 整天留空白（待人工判定），不受核定是否已輸入影響
      const complete = !c.incomplete && c.hasComplete;
      const hours = complete ? Math.round(c.hours * 10) / 10 : '';
      // 核定時數：改讀 approved 分頁最新一筆，主管沒輸入就顯示「待核定」
      const approvedRec = (approvedMap[c.date] || {})[emp];
      const approvedDisplay = approvedRec ? roundApproved(approvedRec.approved_hours) : '待核定';
      // 狀態：既有忘刷卡/新裝置/超出範圍/請假註記＋主管核定帶回的遲到/早退（或「正常」）
      const statusNotes = c.notes.slice();
      if (approvedRec && approvedRec.status_text) statusNotes.push(String(approvedRec.status_text));
      rows.push([c.date, WEEKDAY_ZH[wd], seg, hours, approvedDisplay, statusNotes.join('、')]);
      const rowNo = rows.length;
      if (wd === 0 || wd === 6) weekendRows.push(rowNo);
      if (c.notes.some(function (n) { return ABNORMAL_NOTES.indexOf(n) !== -1; })) abnormalNoteRows.push(rowNo);
    });

    const s = empStats[emp] || { total: 0 };
    rows.push(['小計', '', '', Math.round(s.total * 10) / 10, roundApproved(approvedTotalByEmp[emp] || 0), '']);
  });

  return { rows: rows, boldRows: boldRows, weekendRows: weekendRows, abnormalNoteRows: abnormalNoteRows };
}

/* ============================================================
 * 出勤月表 — sheet 讀寫層（SpreadsheetApp 只在這層出現）
 * ============================================================ */

/** leave 分頁的日期格常被 Sheets 轉成 Date 物件，正規化回 yyyy-MM-dd 字串。 */
function normCellDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  return String(v || '').trim().slice(0, 10);
}

/** events.ts 若被 Sheets 轉成 Date 物件，正規化回台北 ISO 字串。 */
function normCellTs(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  return String(v || '');
}

function currentYmTaipei() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
}

/** 整頁重算 ym（yyyy-MM）月表分頁：不存在自動建立，存在則整頁重寫。回傳列數。 */
function rebuildMonth(ym) {
  ym = String(ym);
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('月份格式錯誤，應為 yyyy-MM：' + ym);

  const ss = getSS();
  const roster = readSheetAsObjects(ss.getSheetByName('roster')).rows.map(stripRowIndex);

  // 事件取「月初往前 1 天～月底往後 1 天」跑配對（跨月班段用）
  const fromMs = new Date(ym + '-01T00:00:00+08:00').getTime() - 24 * 3600000;
  const toMs = new Date(ym + '-' + pad2(lastDayOfMonth(ym)) + 'T23:59:59+08:00').getTime() + 24 * 3600000;
  const events = readSheetAsObjects(ss.getSheetByName('events')).rows.map(stripRowIndex)
    .map(function (e) { e.ts = normCellTs(e.ts); return e; })
    .filter(function (e) {
      const t = tsMs(e.ts);
      return !isNaN(t) && t >= fromMs && t <= toMs;
    });

  const leaveSheet = ss.getSheetByName('leave');
  const leaves = leaveSheet
    ? readSheetAsObjects(leaveSheet).rows.map(function (r) {
        return { date: normCellDate(r['日期']), name: r['姓名'], type: r['假別'], hours: r['時數'] };
      })
    : [];

  const approvedSheet = ss.getSheetByName('approved');
  const approvedRecords = approvedSheet
    ? readSheetAsObjects(approvedSheet).rows.map(stripRowIndex).map(function (r) {
        return {
          date: normCellDate(r.date),
          emp_id: String(r.emp_id),
          name: r.name,
          periods: r.periods,
          approved_hours: Number(r.approved_hours) || 0,
          status_text: r.status_text,
          manager_name: r.manager_name,
          entered_at: normCellTs(r.entered_at),
        };
      })
    : [];

  const built = buildMonthlySheet(ym, roster, events, leaves, todayTaipeiStr(), approvedRecords);

  let sheet = ss.getSheetByName(ym);
  if (!sheet) sheet = ss.insertSheet(ym);
  sheet.clear();

  if (built.rows.length > 0) {
    sheet.getRange(1, 1, built.rows.length, 6).setValues(built.rows);
    built.boldRows.forEach(function (r) { sheet.getRange(r, 1, 1, 6).setFontWeight('bold'); });
    built.weekendRows.forEach(function (r) { sheet.getRange(r, 1, 1, 6).setBackground('#f3f3f3'); });
    built.abnormalNoteRows.forEach(function (r) { sheet.getRange(r, 6).setFontColor('#cc0000'); });
    sheet.setFrozenRows(1);
  }
  return built.rows.length;
}

/**
 * 每日重算（給時間觸發器跑）：重算當月；每月 1–3 日連上月一起重算
 * （收尾跨夜班與補核准的裝置事件），之後上月凍結不再改動。
 */
function dailyMonthlyRebuild() {
  const ym = currentYmTaipei();
  rebuildMonth(ym);
  const day = parseInt(todayTaipeiStr().slice(8, 10), 10);
  if (day <= 3) rebuildMonth(prevYm(ym));
}

/**
 * 手動跑一次：建立每日 05:00 的 dailyMonthlyRebuild 時間觸發器
 * （先刪除既有同 handler 的觸發器再建，跑幾次都不會重複）。
 * 注意：觸發時刻依 Apps Script「專案設定」的時區，請確認為台北 (GMT+8)。
 */
function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyMonthlyRebuild') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyMonthlyRebuild').timeBased().everyDays(1).atHour(5).create();
  Logger.log('已建立 dailyMonthlyRebuild 每日 05:00 觸發器');
}

// refreshCurrentMonth 記錄「上次重算時 events 分頁的列數」用的 Script Properties key
const REFRESH_LAST_ROW_PROP = 'REFRESH_CURRENT_MONTH_LAST_ROW';
// 同上，記錄 approved 分頁的列數（2026-07-13 新增：主管核定後 10 分鐘內月表也要反映，
// 不能只看 events 有沒有新列——主管核定不會新增 events 列）
const REFRESH_LAST_APPROVED_ROW_PROP = 'REFRESH_CURRENT_MONTH_LAST_APPROVED_ROW';

/**
 * 每 10 分鐘重算當月月表（給時間觸發器呼叫，不進 doPost 路由，Eason 2026-07-13 要求
 * 打卡後最多 10 分鐘反映到月表，不等隔天 05:00）。重用 rebuildMonth 既有核心，不複製邏輯。
 *
 * 三道防呆：
 *   1. events 分頁「與」approved 分頁列數都沒變 → 沒有新打卡也沒有新核定，直接 return
 *      （半夜空轉幾乎零成本；任一張表有新列就重算）。
 *   2. LockService 搶不到鎖（跟 05:00 的 dailyMonthlyRebuild 或手動 rebuild_month 撞期）
 *      → tryLock(0) 立刻放棄，不排隊等待，直接 return。
 *   3. 任何例外都吞掉只寫 log，不讓觸發器因丟例外被 Apps Script 自動停用。
 */
function refreshCurrentMonth() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('refreshCurrentMonth: 搶不到鎖，跳過本次（可能與 05:00 重算或手動 rebuild_month 重疊）');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const ss = getSS();
    const eventsSheet = ss.getSheetByName('events');
    const approvedSheet = ss.getSheetByName('approved');
    const lastRow = eventsSheet.getLastRow();
    const lastApprovedRow = approvedSheet ? approvedSheet.getLastRow() : 0;
    const prevRow = parseInt(props.getProperty(REFRESH_LAST_ROW_PROP) || '0', 10);
    const prevApprovedRow = parseInt(props.getProperty(REFRESH_LAST_APPROVED_ROW_PROP) || '0', 10);

    if (lastRow === prevRow && lastApprovedRow === prevApprovedRow) {
      return; // 兩張表都沒有新增列，跳過本次重算
    }

    rebuildMonth(currentYmTaipei());
    props.setProperty(REFRESH_LAST_ROW_PROP, String(lastRow));
    props.setProperty(REFRESH_LAST_APPROVED_ROW_PROP, String(lastApprovedRow));
  } catch (err) {
    console.log('refreshCurrentMonth 執行失敗：' + err);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 手動跑一次：建立每 10 分鐘一次的 refreshCurrentMonth 時間觸發器
 * （先刪除既有同 handler 的觸發器再建，跑幾次都不會疊加出第二顆）。
 * 部署後要在 Apps Script 編輯器手動執行一次本函式才會生效；本函式只建立觸發器，
 * 不會自己執行 refreshCurrentMonth。
 * 注意：觸發時刻依 Apps Script「專案設定」的時區，請確認為台北 (GMT+8)。
 */
function setupMonthRefreshTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshCurrentMonth') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshCurrentMonth').timeBased().everyMinutes(10).create();
  Logger.log('已建立 refreshCurrentMonth 每 10 分鐘觸發器');
}

/** API：{action:'rebuild_month', admin_key, ym?}（ym 缺省＝當月）。GAS 專屬，mock 不實作。 */
function handleRebuildMonth(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = body.ym || currentYmTaipei();
  const rows = rebuildMonth(ym);
  return { ok: true, ym: ym, rows: rows };
}

/* ============================================================
 * 管理用函式：在 Apps Script 編輯器手動執行，不經 API。
 * （排班 app 整合暫緩，名冊管理與裝置核准先由這裡操作。）
 * 用法：在編輯器裡開一個暫時函式帶參數呼叫，例如
 *   function run() { addEmployee('王小明'); }
 * 然後選 run 執行，結果看「執行紀錄」（Logger）。
 * ============================================================ */

/**
 * 新增員工。empId 可省略，省略時自動編號（接續現有最大 E 編號，如 E03）。
 * 執行後 Logger 印出該員工的專屬連結參數（?k=金鑰）。
 */
function addEmployee(name, empId) {
  if (!name) throw new Error('請提供員工姓名，例如 addEmployee("王小明")');
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;

  if (!empId) {
    let maxNum = 0;
    rosterRows.forEach(function (r) {
      const m = String(r.emp_id).match(/^E(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });
    empId = 'E' + ('0' + (maxNum + 1)).slice(-2);
  } else if (findRosterByEmpId(rosterRows, empId)) {
    throw new Error('emp_id 已存在：' + empId);
  }

  const key = genKey();
  rosterSheet.appendRow([empId, name, key, '', '', true]);
  Logger.log('已新增員工 %s（%s），專屬連結參數：?k=%s', name, empId, key);
  return { emp_id: empId, name: name, key: key };
}

/** 員工離職：active 設 false（不刪列、不動 key/裝置紀錄）。用法：deactivateEmployee('E03') */
function deactivateEmployee(empId) {
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const roster = findRosterByEmpId(readSheetAsObjects(rosterSheet).rows, empId);
  if (!roster) throw new Error('找不到員工：' + empId);
  rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('active') + 1).setValue(false);
  Logger.log('已將 %s（%s）設為離職（active=false）', roster.name, empId);
}

/** 收集所有待核准裝置，依 員工＋裝置碼 分組（內部共用）。 */
function collectPendingDevices() {
  const ss = getSS();
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows;

  const groups = {};
  eventRows.forEach(function (e) {
    if (e.status !== 'pending_device_approval') return;
    const gk = String(e.emp_id) + '||' + String(e.device_id);
    if (!groups[gk]) {
      const roster = findRosterByEmpId(rosterRows, e.emp_id);
      groups[gk] = {
        emp_id: String(e.emp_id),
        name: roster ? roster.name : '(不在名冊)',
        device_id: String(e.device_id),
        first_ts: String(e.ts),
        last_ts: String(e.ts),
        count: 0,
      };
    }
    const g = groups[gk];
    g.count++;
    if (String(e.ts) < g.first_ts) g.first_ts = String(e.ts);
    if (String(e.ts) > g.last_ts) g.last_ts = String(e.ts);
  });

  return Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return a.first_ts < b.first_ts ? -1 : 1; });
}

/** 列出所有待核准的新裝置（姓名、裝置碼、首次時間、筆數），結果看 Logger。 */
function listPendingDevices() {
  const pending = collectPendingDevices();
  if (pending.length === 0) {
    Logger.log('目前沒有待核准的裝置。');
    return;
  }
  pending.forEach(function (g) {
    Logger.log(
      '員工 %s（%s）｜裝置碼 %s｜首次 %s｜共 %s 筆待核准',
      g.name, g.emp_id, g.device_id, g.first_ts, String(g.count)
    );
  });
}

/** 取該員工最新（最後打卡）的待核准裝置；沒有則丟錯誤（內部共用）。 */
function latestPendingDevice(empId) {
  const pending = collectPendingDevices().filter(function (g) { return g.emp_id === String(empId); });
  if (pending.length === 0) throw new Error('員工 ' + empId + ' 沒有待核准的裝置');
  pending.sort(function (a, b) { return a.last_ts < b.last_ts ? -1 : 1; });
  return pending[pending.length - 1];
}

/**
 * 核准某員工「最新一個」待核准裝置：roster 改綁該裝置，
 * 該員工該裝置所有 pending events 改 status=ok、device_match=true。
 * 用法：approvePendingDevice('E01')
 */
function approvePendingDevice(empId) {
  const target = latestPendingDevice(empId);
  const result = applyDeviceDecision(empId, target.device_id, true);
  Logger.log('已核准 %s（%s）的裝置 %s，共更新 %s 筆事件', target.name, empId, target.device_id, String(result.changed));
}

/**
 * 拒絕某員工「最新一個」待核准裝置：pending events 改 status=rejected_device，
 * roster 不改綁。用法：rejectPendingDevice('E01')
 */
function rejectPendingDevice(empId) {
  const target = latestPendingDevice(empId);
  const result = applyDeviceDecision(empId, target.device_id, false);
  Logger.log('已拒絕 %s（%s）的裝置 %s，共更新 %s 筆事件', target.name, empId, target.device_id, String(result.changed));
}

/**
 * 新增值班主管（2026-07-13 新增）。仿 addEmployee 慣例產生 key。
 * 執行後 Logger 印出主管專頁網址參數（?k=金鑰），貼到 manager.html 網址後面給該主管。
 * 用法：function run() { addManager('王經理'); }
 */
function addManager(name) {
  if (!name) throw new Error('請提供主管姓名，例如 addManager("王經理")');
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  const key = genKey();
  mgrSheet.appendRow([name, key, true]);
  Logger.log('已新增值班主管 %s，主管專頁網址參數：?k=%s', name, key);
  return { name: name, key: key };
}

/** 主管離職/停用：active 設 false（不刪列）。用法：deactivateManager('王經理的key或用下方寫法自查') */
function deactivateManagerByKey(key) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  const rows = readSheetAsObjects(mgrSheet).rows;
  const target = rows.filter(function (r) { return String(r.key) === String(key); })[0];
  if (!target) throw new Error('找不到主管金鑰：' + key);
  mgrSheet.getRange(target.__rowIndex, MANAGERS_HEADERS.indexOf('active') + 1).setValue(false);
  Logger.log('已將主管 %s 設為停用（active=false）', target.name);
}
