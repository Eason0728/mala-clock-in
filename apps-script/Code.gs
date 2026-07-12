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
 *   clock / whoami / sync_roster / get_roster / get_events / approve_device
 * 另有 GAS 專屬 action（mock_server 不實作，因為依賴試算表分頁）：
 *   rebuild_month {admin_key, ym?}（ym 缺省＝當月，格式 yyyy-MM）→ 重算該月出勤月表分頁
 */

const CONFIG = {
  SPREADSHEET_ID: 'PASTE_SPREADSHEET_ID_HERE',
  STORE_LAT: 24.7838051,
  STORE_LNG: 121.015592,
  RADIUS_M: 5, // 允許打卡半徑（公尺）：Eason 指定收緊為 5 公尺，人要就在店裡
  ADMIN_KEY: 'PASTE_ADMIN_KEY_HERE',
  // 上下班交替判斷的回看視窗（小時）：看得到跨夜班前一晚的上班卡，
  // 但昨天忘打的下班卡（超過視窗）不會鎖死今天的上班卡。
  ALTERNATION_LOOKBACK_HOURS: 12,
};

const ROSTER_HEADERS = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'];
const LEAVE_HEADERS = ['日期', '姓名', '假別'];
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
      // 核准只解「裝置」這一關：超出範圍的卡翻成 rejected_out_of_range，不得入帳
      // （否則在家用新裝置打卡→核准換機→在家打的卡變有效，2026-07-12 實測抓到的漏洞）
      const newStatus = approve
        ? (e.within_range === true ? 'ok' : 'rejected_out_of_range')
        : 'rejected_device';
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
 * 出勤月表 — 純函式區
 * 只吃 plain object 陣列、回列陣列，不碰 SpreadsheetApp/Utilities，
 * 可直接用 node 載入本檔測試（本檔頂層無任何 GAS 呼叫）。
 * ============================================================ */

// in 配「12 小時內的下一筆 out」的配對視窗（小時）
const MONTHLY_PAIR_WINDOW_HOURS = 12;
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
 * 打卡事件配對成班段。只取 status='ok'，依員工分組、時間排序，
 * in 配「MONTHLY_PAIR_WINDOW_HOURS 小時內的下一筆 out」（途中遇到另一筆 in 就斷）。
 * 回傳 { shifts:[{emp_id,in_ts,out_ts}], unmatchedIns:[event], unmatchedOuts:[event] }。
 */
function pairShifts(events) {
  const byEmp = {};
  events.forEach(function (e) {
    if (String(e.status) !== 'ok') return;
    if (e.type !== 'in' && e.type !== 'out') return;
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

/**
 * 產生月表分頁的全部列＋格式標記（純函式）。
 * @param {string} ym 'yyyy-MM'
 * @param {Array} roster [{emp_id,name,active}]（依 roster 順序輸出累計）
 * @param {Array} events [{ts,emp_id,type,status}] 必須涵蓋「月初往前 1 天～月底往後 1 天」
 *                （跨月班段配對用：班段歸 in 日所在月份；上月末深夜 in 配到本月初 out 時，
 *                 該 out 不得在本月被判「上班忘刷卡」）
 * @param {Array} leaves [{date:'yyyy-mm-dd',name,type}] leave 分頁原始列（姓名未比對）
 * @param {string} todayStr 'yyyy-mm-dd'（台北）——當月明細只列到今天
 * @returns {{rows:Array, boldRows:Array, weekendRows:Array, abnormalNoteRows:Array}}
 *          rows 為 6 欄列陣列（明細依員工分區塊，參考時數／核定工時並列）；*Rows 皆為 1-based 列號
 */
function buildMonthlySheet(ym, roster, events, leaves, todayStr) {
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
      cellMap[k] = { date: dateStr, emp_id: emp, segments: [], notes: [], hours: 0, approved: 0, hasComplete: false, incomplete: false };
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
    c.approved += approvedHoursOfShift(s.in_ts, s.out_ts); // 每段各自取整再加總
    c.hasComplete = true;
  });

  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (!inMonthToEnd(d)) return;
    const c = cell(d, String(e.emp_id));
    c.segments.push({ sortMs: tsMs(e.ts), text: tsHm(e.ts) + '–？' });
    c.notes.push('下班忘刷卡');
    c.incomplete = true;
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
  leaves.forEach(function (l) {
    const emp = nameToEmp[String(l.name || '').trim()];
    if (!emp) return;
    const d = String(l.date || '').slice(0, 10);
    if (d.slice(0, 7) !== ym) return;
    (leaveDates[emp] = leaveDates[emp] || {})[d] = true;
    if (inMonthToEnd(d)) cell(d, emp).notes.push(String(l.type || '請假'));
  });

  // ---- 每員工統計（上段累計與區塊小計共用） ----
  const empStats = {}; // emp -> { total, approved, abnormal }
  Object.keys(cellMap).forEach(function (k) {
    const c = cellMap[k];
    const s = (empStats[c.emp_id] = empStats[c.emp_id] || { total: 0, approved: 0, abnormal: 0 });
    if (!c.incomplete) { // 有忘刷卡的那天整天不計入（參考/核定皆然）
      s.total += c.hours;
      s.approved += c.approved;
    }
    c.notes.forEach(function (n) { if (ABNORMAL_NOTES.indexOf(n) !== -1) s.abnormal++; });
  });

  // 核定工時是 0.25 的倍數，用 2 位小數整理浮點誤差（勿取 1 位，會把 .75 進成 .8）
  function roundApproved(x) { return Math.round(x * 100) / 100; }

  // ---- 組列（6 欄）----
  const rows = [];
  const boldRows = [];
  const weekendRows = [];
  const abnormalNoteRows = [];

  rows.push(['姓名', '參考時數', '核定工時', '異常筆數', '請假天數', '']);
  boldRows.push(1);

  activeRoster.forEach(function (r) {
    const emp = String(r.emp_id);
    const s = empStats[emp] || { total: 0, approved: 0, abnormal: 0 };
    const leaveCount = Object.keys(leaveDates[emp] || {}).length;
    rows.push([String(r.name), Math.round(s.total * 10) / 10, roundApproved(s.approved), s.abnormal, leaveCount, '']);
  });

  rows.push(['', '', '', '', '', '']);
  rows.push(['日期', '星期', '班段', '參考時數', '核定工時', '備註']);
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
      // 當天只要有任一筆忘刷卡 → 參考/核定兩欄整天留空白（待人工判定）
      const complete = !c.incomplete && c.hasComplete;
      const hours = complete ? Math.round(c.hours * 10) / 10 : '';
      const approved = complete ? roundApproved(c.approved) : '';
      rows.push([c.date, WEEKDAY_ZH[wd], seg, hours, approved, c.notes.join('、')]);
      const rowNo = rows.length;
      if (wd === 0 || wd === 6) weekendRows.push(rowNo);
      if (c.notes.some(function (n) { return ABNORMAL_NOTES.indexOf(n) !== -1; })) abnormalNoteRows.push(rowNo);
    });

    const s = empStats[emp] || { total: 0, approved: 0 };
    rows.push(['小計', '', '', Math.round(s.total * 10) / 10, roundApproved(s.approved), '']);
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
        return { date: normCellDate(r['日期']), name: r['姓名'], type: r['假別'] };
      })
    : [];

  const built = buildMonthlySheet(ym, roster, events, leaves, todayTaipeiStr());

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
