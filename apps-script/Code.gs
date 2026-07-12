/**
 * 麻的小辛辣 員工打卡系統 - Apps Script 後端
 *
 * 部署方式（老闆手動操作，Claude 不代為部署雲端資源）：
 *   1. 開一份新的 Google 試算表，複製其 ID 貼到下面 CONFIG.SPREADSHEET_ID。
 *   2. 開啟 Extensions > Apps Script，貼上本檔全部內容。
 *   3. 設定 CONFIG.ADMIN_KEY（自訂一組管理密鑰，供排班 App 呼叫管理端點用）。
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

  // status 優先序：裝置不符 > 超出範圍 > ok
  let status;
  if (!deviceMatch) {
    status = 'pending_device_approval';
  } else if (!withinRange) {
    status = 'rejected_out_of_range';
  } else {
    status = 'ok';
  }

  eventsSheet.appendRow([ts, roster.emp_id, body.type, lat, lng, distanceM, withinRange, deviceId, deviceMatch, status]);

  return { ok: true, status: status, name: roster.name, ts: ts, distance_m: distanceM, within_range: withinRange };
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

  return { ok: true, emp_id: roster.emp_id, name: roster.name, device_state: deviceState, today_events: todayEvents };
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

function handleApproveDevice(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };

  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;
  const roster = findRosterByEmpId(rosterRows, body.emp_id);
  if (!roster) return { ok: false, error: 'invalid_emp_id' };

  const deviceId = body.device_id;
  const approve = !!body.approve;

  if (approve) {
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_id') + 1).setValue(deviceId);
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_bound_at') + 1).setValue(nowTaipeiIso());
  }

  const eventRows = readSheetAsObjects(eventsSheet).rows;
  eventRows.forEach(function (e) {
    if (
      String(e.emp_id) === String(body.emp_id) &&
      String(e.device_id) === String(deviceId) &&
      e.status === 'pending_device_approval'
    ) {
      const newStatus = approve ? 'ok' : 'rejected_device';
      eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('status') + 1).setValue(newStatus);
      if (approve) {
        eventsSheet.getRange(e.__rowIndex, EVENTS_HEADERS.indexOf('device_match') + 1).setValue(true);
      }
    }
  });

  return { ok: true };
}
