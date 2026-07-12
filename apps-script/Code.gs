/**
 * 麻的小辛辣 員工打卡系統 - Apps Script 後端
 *
 * 部署方式（老闆手動操作，Claude 不代為部署雲端資源）：
 *   1. 開一份新的 Google 試算表，複製其 ID 貼到下面 CONFIG.SPREADSHEET_ID。
 *   2. 開啟 Extensions > Apps Script，貼上本檔全部內容。
 *   3. 設定 CONFIG.ADMIN_KEY（自訂一組管理密鑰，供管理端點 API 使用；
 *      排班 app 整合暫緩期間，日常名冊/裝置管理改用檔尾的編輯器管理函式）。
 *   4. 手動執行一次 setup() 函式（會要求授權），建立 roster / events 兩個分頁與表頭。
 *   5. Deploy > New deployment > Web app：Execute as「我」、Who has access「Anyone」。
 *   6. 複製部署網址，貼到 clock.html 的 API_URL 常數。
 *
 * 本檔與 mock/mock_server.py 實作同一套 API 合約：
 *   clock / whoami / sync_roster / get_roster / get_events / approve_device
 */

const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE',
  STORE_LAT: 24.7838051,
  STORE_LNG: 121.015592,
  RADIUS_M: 50,
  ADMIN_KEY: 'PASTE_ADMIN_KEY_HERE',
  // 上下班交替判斷的回看視窗（小時）：看得到跨夜班前一晚的上班卡，
  // 但昨天忘打的下班卡（超過視窗）不會鎖死今天的上班卡。
  ALTERNATION_LOOKBACK_HOURS: 12,
};

const ROSTER_HEADERS = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'];
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

/**
 * 手動執行一次：建立 roster / events 兩個分頁與表頭。
 * 若分頁已存在則只補表頭，不會清空既有資料。
 */
function setup() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

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
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
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
  const eventRows = readSheetAsObjects(eventsSheet).rows;
  eventRows.forEach(function (e) {
    if (
      String(e.emp_id) === String(empId) &&
      String(e.device_id) === String(deviceId) &&
      e.status === 'pending_device_approval'
    ) {
      const newStatus = approve ? 'ok' : 'rejected_device';
      eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('status') + 1).setValue(newStatus);
      if (approve) {
        eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('device_match') + 1).setValue(true);
      }
      changed++;
    }
  });

  return { ok: true, changed: changed };
}

function handleApproveDevice(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return applyDeviceDecision(body.emp_id, body.device_id, !!body.approve);
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
