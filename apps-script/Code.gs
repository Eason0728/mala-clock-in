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
 *   recheck_approvals {admin_key}（2026-07-19 新增）→ 手動觸發「該段無打卡」核定狀態重算
 *   backfill_missing_groups {admin_key, from, to, apply?}（2026-09-21 新增）→ 一次性回填
 *     「少刷N組卡」到已核定完的歷史紀錄；不帶 apply 為 dry-run，只回報不寫入
 *   setup_triggers {admin_key}（2026-08-24 新增）→ 建立／重建月表的兩個時間觸發器（冪等）
 *   （平常由每日 05:00 觸發器 dailyMonthlyRebuild 自動跑，這個 action 只供部署後手動驗證）
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
  // 值班核定頁的「預設上下班時間」全店預設（2026-08-23）。個人若在名冊填了 shift_in／shift_out
  // 就以個人的為準。兩者都留空＝核定頁維持空白，主管自己填（＝改版前的行為）。
  DEFAULT_SHIFT_IN: '',
  DEFAULT_SHIFT_OUT: '',
  // 「不打卡休息帶」（2026-09-22）：該店規定休息時間不打卡才填，例：央廚 '12:00'／'13:00'。
  // **只影響「少刷N組卡」的判定**——核定時段之間的空檔若與這段重疊，視為休息造成的、不算漏刷；
  // 時數計算一律不碰（核定時數永遠等於畫面上的時段相加，系統不做任何隱形加減）。
  // 留空＝該店沒有不打卡休息（光復／總部／金山），任何空檔都算少刷。
  // ⚠ 要與 tools/build-store-pages.py 的 mgr_break 同一組值：那邊管核定頁「預填挖缺口」，
  //    這邊管「這個缺口算不算漏刷」。只改一邊＝央廚整店每天被冤枉標少刷。
  NO_PUNCH_BREAK_START: '',
  NO_PUNCH_BREAK_END: '',
  // 薪酬後端（2026-08-23）：值班核定送出的假別若不在本檔 LEAVE_TYPES 白名單，
  // 會即時向薪酬假別表（payroll_leave_type，資料驅動的正本）確認一次再放行——
  // 在表上加新假別不必再改三家店的後端。光復＝薪資模組掛在同一個專案，兩者留空直接查；
  // 央廚／總部要填薪酬 exec 網址（與 manager.html 的 PAYROLL_API 同一個）與大寫店代碼（CF／HQ）。
  PAYROLL_API: '',
  PAYROLL_STORE: '',
};

// shift_in／shift_out（2026-08-23）：值班核定頁「預設上下班時間」。
// 格式 HH:mm（如 11:00）。留空＝用 CONFIG.DEFAULT_SHIFT_* 的全店預設；兩者都空＝維持空白要主管自己填。
// ⚠ 只在名冊末尾 append，不可插中間（既有資料會錯位）。
const ROSTER_HEADERS = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active',
                        'shift_in', 'shift_out',
                        // 2026-08-23：值班主管自助開帳號的留痕。created_by 記主管姓名，
                        // 薪酬系統與每日指揮台據此標示／通知「最近新增了誰」。
                        'created_at', 'created_by',
                        // 2026-08-25：值班主管把同仁設為離職的留痕（停用不是真刪，見 handleMgrSetActive）
                        'removed_at', 'removed_by',
                        // 2026-08-27：LIFF 身分層——LINE 帳號與綁定時間戳。只在名冊末尾 append，
                        // 不可插中間（既有資料會錯位）。handleClock 綁裝置那段用
                        // ROSTER_HEADERS.indexOf('欄名') + 1 換算欄號。
                        'line_user_id', 'line_bound_at'];
/** 把班別時間正規化成 'HH:mm'。接受 '11:00'、'0900'、Date 物件（Sheets 會把 11:00 轉成時間物件）。
 *  不合法一律回空字串——寧可讓核定頁留白，也不要餵一個 <input type="time"> 認不得的值。 */
function normShiftTime(v) {
  if (v instanceof Date) {
    const p = function (n) { return ('0' + n).slice(-2); };
    return p(v.getHours()) + ':' + p(v.getMinutes());
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return '';
  return ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2);
}

const LEAVE_HEADERS = ['日期', '姓名', '假別', '時數'];
// 一天最多記幾種假別（2026-10-26 起可以多種，一種一列）
const MAX_LEAVES_PER_DAY = 4;
// 人工備註（Eason 在月表明細右邊那欄手打的忘刷卡原因等）。月表每次重算是 sheet.clear()
// 整張清空再重寫，手打的字不另外保存就會被擦掉——notes 分頁是這些字的正本。
const NOTES_HEADERS = ['日期', '姓名', '備註'];
// 月表明細的第 7 欄＝人工備註欄（前 6 欄由程式產生：日期/星期/班段/參考時數/核定時數/狀態）
const MONTH_NOTE_COL = 7;
const MONTH_NOTE_HEADER = '人工備註';
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
  // 手機回報的定位精確度（公尺，越小越準）。2026-08-19 新增：A 君 8/11 當天 12 筆全被判超出範圍，
  // 只能靠座標反推是 Wi-Fi 定位不是 GPS；存下這個數字，這類案子一眼就分得出來。
  // ⚠ 加在最後一欄，既有 10 欄資料不位移；舊列此欄為空。
  'accuracy_m',
];

// 判定「在不在店裡」時，可以拿定位誤差折抵多少距離（公尺）。
// 起因：誤差 ±120m 卻報距離 80m 時，真實位置很可能就在店裡，拿那個距離擋人並不合理
// （A 君 8/11 連按 12 次全被擋就是這種）。所以改判「距離扣掉誤差後」還超出半徑才擋。
// 設上限 100 是為了避免誤差爆掉時變成誰都能過；折抵後最遠約落在同一個街廓內。
// ⚠ 手機沒回報誤差時折抵 0，行為與加這條之前完全相同（舊版前端不受影響）。
const ACCURACY_CREDIT_CAP_M = 100;

// 定位精確度超過這個值就視為「這次定位不可信」（公尺）。
// GPS 通常 5–30 m；Wi-Fi／基地台定位常見 50–150 m。門市半徑只有 20 m，
// 誤差 50 m 以上的座標本來就不足以判斷人在不在店裡，所以拿來提示同仁「定位可能不準」。
const LOW_ACCURACY_M = 50;
// 值班主管核定（2026-07-13 新增）：只追加不覆蓋；同 (date,emp_id) 多筆以 entered_at 最新為準（讀取端處理）
const APPROVED_HEADERS = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason'];   // dup_ignore：2026-11-06 主管認定的重複打卡；diff_reason：2026-11-16 起核定和打卡差 30 分鐘以上的原因
const MANAGERS_HEADERS = ['name', 'key', 'active'];
// 店內公告（2026-08-28 新增）：值班主管在核定頁發布，同仁打卡頁最上方輪播。
// 只追加不刪除——停用是把 active 改 FALSE，紀錄留著（同「同仁異動」精神）。
// ends_on 是「顯示到這天為止（含當天）」，留空＝不自動下架。
const NOTICE_HEADERS = ['id', 'text', 'active', 'ends_on', 'created_at', 'created_by'];
// 打卡頁最多輪播幾則。輪播一輪 5 秒，超過 5 則同仁根本輪不完，多的直接不送到前端。
const NOTICE_MAX_SHOW = 5;
// 單則字數上限。公告寫成長篇沒人看，也會把打卡按鈕擠出畫面。
const NOTICE_MAX_LEN = 120;
// 主管核定頁「請假註記」可選假別（2026-07-13 Eason 定案；改清單前後端 mock 要同步）
// ⚠ 2026-08-22 起：值班核定頁的下拉改由薪酬系統的 payroll_leave_type 表決定，
//   這份清單降級為「送出時的合法性白名單」＋薪酬後端連不上時的 fallback。
//   在 payroll_leave_type 加新假別時，這一行也要一起放行，否則送出會被擋成 bad_leave_type。
const LEAVE_TYPES = [
  '特休假', '事假', '病假',
  '住院傷病假', '安胎休養假', '生理假',
  '家庭照顧假', '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）',
  '喪假（曾祖父母・兄弟姊妹）', '婚假', '天災假',
  '公傷病假', '產假（分娩）', '流產假（妊娠3個月以上）',
  '流產假（妊娠2～未滿3個月）', '流產假（妊娠未滿2個月）', '產檢假',
  '陪產檢及陪產假', '公假', '謀職假',
  '育嬰假', '喪假', '產假',
  '出差',
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
  rosterLockTextCols_(roster);   // 工號、金鑰欄鎖文字（2026-11-04）：之後手打的純數字金鑰也不會被轉成數字

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

  // 人工備註正本：月表明細第 7 欄手打的字，重算前會被收進這裡再放回去（2026-08-19 新增）
  let notes = ss.getSheetByName('notes');
  if (!notes) {
    notes = ss.insertSheet('notes');
  }
  notes.getRange(1, 1, 1, NOTES_HEADERS.length).setValues([NOTES_HEADERS]);

  // 值班主管名冊：addManager() 產生 key（2026-07-13 新增）
  let managers = ss.getSheetByName('managers');
  if (!managers) {
    managers = ss.insertSheet('managers');
  }
  managers.getRange(1, 1, 1, MANAGERS_HEADERS.length).setValues([MANAGERS_HEADERS]);

  // 店內公告：值班主管在核定頁發布（2026-08-28 新增）
  let notices = ss.getSheetByName('notices');
  if (!notices) {
    notices = ss.insertSheet('notices');
  }
  notices.getRange(1, 1, 1, NOTICE_HEADERS.length).setValues([NOTICE_HEADERS]);
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

  // LINE 官方帳號「鼎兆元打卡」的 webhook（LineHub.gs，只有光復部署）：LINE 送來的是 {destination, events}，沒有 action。
  if (body && Array.isArray(body.events) && typeof handleLineWebhook_ === 'function') {
    return jsonOut(handleLineWebhook_(body));
  }

  const handlers = {
    clock: handleClock,
    whoami: handleWhoami,
    // 開新店用的兩個管理動作（2026-10-30 補進 repo）：各分店線上早就有（開店時手動加的），repo 一直沒有，
    // 部署時會被洗掉。setup_sheets＝建分頁；add_manager＝加值班主管（同名在職的就回原本那把鑰匙）。
    setup_sheets: function (body) {
      if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
      setup();
      return { ok: true, message: '分頁已建立' };
    },
    add_manager: function (body) {
      if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
      const nm = String(body.name || '').trim();
      if (!nm) return { ok: false, error: 'name_required' };
      const ss = getSS();
      const sh = ss.getSheetByName('managers');
      if (!sh) return { ok: false, error: 'no_managers_sheet', message: '請先跑 setup_sheets' };
      const rows = readSheetAsObjects(sh).rows;
      const exist = rows.filter(function (r) { return String(r.name).trim() === nm && String(r.active).toLowerCase() === 'true'; })[0];
      if (exist) return { ok: true, name: nm, key: String(exist.key), existed: true };
      const key = genKey();
      sh.appendRow([nm, key, true]);
      return { ok: true, name: nm, key: key, existed: false };
    },
    sync_roster: handleSyncRoster,
    set_shifts: handleSetShifts,
    mgr_add_employee: handleMgrAddEmployee,
    mgr_roster: handleMgrRoster,
    mgr_set_active: handleMgrSetActive,
    recent_hires: handleRecentHires,
    get_roster: handleGetRoster,
    get_events: handleGetEvents,
    approve_device: handleApproveDevice,
    rebuild_month: handleRebuildMonth,
    recheck_approvals: handleRecheckApprovals,
    backfill_missing_groups: handleBackfillMissingGroups,
    setup_triggers: handleSetupTriggers,
    my_recent: handleMyRecent,
    mgr_day: handleMgrDay,
    mgr_approve: handleMgrApprove,
    mgr_pending_devices: handleMgrPendingDevices,
    mgr_pending_approvals: handleMgrPendingApprovals,
    mgr_device_decision: handleMgrDeviceDecision,
    mgr_notices: handleMgrNotices,
    mgr_add_notice: handleMgrAddNotice,
    mgr_set_notice_active: handleMgrSetNoticeActive,
  };

  // 考勤異常候補提醒（AttDigest.gs，唯讀）；檔案不存在時完全不影響其他動作。
  if (typeof handleAttDigestData === 'function') handlers.att_digest_data = handleAttDigestData;

  // 考勤異常候補提醒的寄放（AttAlert.gs，只有光復設了 ATT_ALERT_SVC_KEY 才會動；其他店回 not_enabled）。
  if (typeof handleAttAlertStart === 'function') handlers.att_alert_start = handleAttAlertStart;
  if (typeof handleAttAlertEnqueue === 'function') handlers.att_alert_enqueue = handleAttAlertEnqueue;

  // 薪資模組（Payroll.gs）的 action 掛載於此；Payroll.gs 不存在時完全不影響打卡與核定。
  if (typeof PAYROLL_HANDLERS !== 'undefined') {
    Object.keys(PAYROLL_HANDLERS).forEach(function (k) { handlers[k] = PAYROLL_HANDLERS[k]; });
  }

  // LIFF 身分層（Liff.gs）的 action 掛載於此；Liff.gs 不存在時完全不影響打卡與核定。
  if (typeof LIFF_HANDLERS !== 'undefined') {
    Object.keys(LIFF_HANDLERS).forEach(function (k) { handlers[k] = LIFF_HANDLERS[k]; });
  }

  // LINE 單一打卡入口的集中服務（LineHub.gs，只有光復部署）；不存在時完全不影響其他功能。
  if (typeof LINE_HUB_HANDLERS !== 'undefined') {
    Object.keys(LINE_HUB_HANDLERS).forEach(function (k) { handlers[k] = LINE_HUB_HANDLERS[k]; });
  }

  // 管理系統呼叫的名冊服務（SvcStaff.gs）；不存在時完全不影響其他功能。
  if (typeof SVC_STAFF_HANDLERS !== 'undefined') {
    Object.keys(SVC_STAFF_HANDLERS).forEach(function (k) { handlers[k] = SVC_STAFF_HANDLERS[k]; });
  }

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
  // 金鑰要用難以推測的亂數：UUID 取 SHA-256 當來源；248 以上的位元組捨棄，字元才平均。
  let out = '';
  while (out.length < n) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
    for (let i = 0; i < bytes.length && out.length < n; i++) {
      const b = bytes[i] & 0xff;
      if (b < 248) out += chars.charAt(b % chars.length);
    }
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

/**
 * 只讀 events 最底下「夠用」的那一段（2026-10-12，Eason：「打卡只讀最低需求的列數」）。
 * 原本每打一次卡都把整張 events 從頭讀一遍，表一年會長到幾萬列、打卡跟著越來越慢。
 * 做法：appendRow 一定加在最後，所以從最後一列往上一段一段讀（300 列起、每次加倍），
 * 讀到某一段的第一列已經早於 sinceMs 就停——再往上都比需要的更舊。
 * stopFn（選填）：每讀完一段就問一次「這段裡已經有需要的東西了嗎」，回 true 也停（例：找到這個人上一張有效的卡）。
 * 回傳形狀與 readSheetAsObjects 相同（headers 是真的第 1 列、每列帶正確的 __rowIndex）。
 * 沒有 ts 欄、sinceMs 不合理、或讀的過程出錯 → 退回整張讀（寧可慢，不能少讀）。
 * ⚠ 前提是列依時間排序；手動在中間插入舊日期的列，可能讓那一列之前的資料沒被讀到。
 */
function readEventsSince(sheet, sinceMs, stopFn) {
  try {
    const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    if (lastRow < 2) return { headers: headers, rows: [] };
    const tsCol = headers.indexOf('ts');
    const mirrorCol = headers.indexOf('mirror_src');
    if (tsCol < 0 || !(Number(sinceMs) > 0)) return readSheetAsObjects(sheet);
    const chunks = [];
    let end = lastRow, size = 300;
    while (end >= 2) {
      const start = Math.max(2, end - size + 1);
      const vals = sheet.getRange(start, 1, end - start + 1, lastCol).getValues();
      const objs = vals.map(function (row, i) {
        const obj = {};
        headers.forEach(function (h, j) { obj[h] = row[j]; });
        obj.__rowIndex = start + i;
        return obj;
      });
      chunks.unshift(objs);
      // （2026-11-04 夜間 QA）鏡像列（mirror_src 非空）是整段歷史每天追加在底部，時間不照順序，
      //  不能拿它當「這段已早於 sinceMs、可以停」的依據，否則自家同仁的近期卡會被擠到沒讀到。
      //  改拿這段第一個非鏡像列的時間判斷；鏡像列本身照樣讀進結果。表頭沒有 mirror_src 欄時行為不變。
      let basis = 0;
      if (mirrorCol >= 0) {
        while (basis < vals.length && String(vals[basis][mirrorCol] == null ? '' : vals[basis][mirrorCol]) !== '') basis++;
      }
      const firstMs = basis < vals.length ? new Date(String(normCellTs(vals[basis][tsCol]))).getTime() : NaN;
      if (!isNaN(firstMs) && firstMs < sinceMs) break;   // 時間空白／讀不懂就繼續往上，不提早停
      if (stopFn && stopFn(objs)) break;
      end = start - 1;
      size *= 2;
    }
    return { headers: headers, rows: [].concat.apply([], chunks) };
  } catch (e) {
    return readSheetAsObjects(sheet);
  }
}

function findRosterByKey(rows, key) {
  if (!String(key == null ? '' : key).trim()) return undefined;   // 空白金鑰不算身分（2026-11-10 資安審計）
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
/** 同型（上班後又上班、下班後又下班）只在這幾分鐘內擋成 rejected_duplicate（2026-11-02，原本 12 小時內都擋）。
 *  與 Liff.gs LIFF_LOCK_MIN、clock.html CLOCK_LOCK_MIN、mock_server.py 同步。 */
const SAME_TYPE_LOCK_MIN = 10;

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

/* 同一人兩筆打卡同時到（2026-11-03 對抗驗證 #1，11-03 晚從 Liff.gs 搬進 handleClock，舊連結 clock.html 也受保護）：
   handleClock 用「打卡前讀的 events」判重複，兩個畫面同時送上班卡會兩張都 ok。不用 ScriptLock（會跟月表重算搶鎖、讓打卡卡住）：
   判完重複就在 CacheService 記「這個人剛送出哪一型、幾點」（鍵 lfl:<emp_id>，Liff.gs liffWithMark_ 也讀同一個），
   下一筆讀完 events 後把記號當成最後一張卡併進來；這張被擋（rejected_*）或寫入失敗就還原。快取壞了一律當沒有記號。 */
function clockMarkKey_(empId) { return 'lfl:' + empId; }
function clockLastWithMark_(eventRows, empId) {
  const last = lastCountedEvent(eventRows, empId);
  try {
    const v = CacheService.getScriptCache().get(clockMarkKey_(empId));
    if (!v) return last;
    const m = JSON.parse(v), mt = new Date(String(m && m.ts)).getTime();
    if (!m || (m.type !== 'in' && m.type !== 'out') || isNaN(mt) || mt < Date.now() - CONFIG.ALTERNATION_LOOKBACK_HOURS * 3600000) return last;
    if (last && new Date(last.ts).getTime() >= mt) return last;
    return { ts: String(m.ts), type: m.type };
  } catch (e) { return last; }
}
/** 放記號，回原本的記號（字串或 null）給 clockMarkRestore_ 用。 */
function clockMarkPut_(empId, type, ts) {
  try {
    const c = CacheService.getScriptCache(), k = clockMarkKey_(empId), prev = c.get(k);
    c.put(k, JSON.stringify({ type: type, ts: ts }), SAME_TYPE_LOCK_MIN * 60 + 60);
    return prev;
  } catch (e) { return null; }
}
function clockMarkRestore_(empId, prev) {
  try {
    const c = CacheService.getScriptCache(), k = clockMarkKey_(empId);
    if (prev) c.put(k, prev, SAME_TYPE_LOCK_MIN * 60 + 60); else c.remove(k);
  } catch (e) { /* 快取壞了：記號最多 11 分鐘自己過期 */ }
}

/**
 * 今日出勤時數（whoami 用，同仁自助查詢，不落地寫入試算表）。
 * 只取今日（Asia/Taipei）status='ok' 的事件跑 pairShifts（沿用月表同一套配對／核定
 * 邏輯，不重寫 pairShifts/approvedHoursOfShift 本身）：
 *   reference＝已完成時段 15 分鐘取整加總（2026-07-15 Eason 指定：原始相減改為與核定工時
 *   同一套 approvedHoursOfShift 取整——上班進位、下班捨去，必為 0.25 倍數）
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
    reference += approvedHoursOfShift(s.in_ts, s.out_ts);
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
 * reference＝該日已完成班段 15 分鐘取整加總（approvedHoursOfShift，2026-07-15 起）；
 * 當天有任一筆忘刷卡（見上例外）→ 整天回 null，不是部分加總（A3，與月表同一規則，
 * 見 dayReferenceIncomplete，勿各自重寫判斷）。
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
  const paired = pairShifts(dropDupIgnored_(evs, dupIgnoreSet_(approvedMap)));   // pairShifts 內部只取 status='ok'；主管認定的重複卡拿掉（2026-11-06）

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
    c.reference += approvedHoursOfShift(s.in_ts, s.out_ts);
  });

  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d < startStr || d > todayStr) return;
    const c = day(d);
    c.segments.push({ sortMs: tsMs(e.ts), in: tsHm(e.ts), out: null, cross: false });
    c.notes.push(d === todayStr ? '上班中' : '下班忘刷卡');
  });

  paired.unmatchedOuts.forEach(function (e) {
    const d = loneOutDate_(e.ts);
    if (d < startStr || d > todayStr) return;
    const c = day(d);
    c.segments.push({ sortMs: tsMs(e.ts), in: null, out: tsHm(e.ts), cross: d !== tsDateStr(e.ts) });
    c.notes.push('上班忘刷卡');
  });

  return Object.keys(dayMap).sort().map(function (d) {
    const c = dayMap[d];
    c.segments.sort(function (a, b) { return a.sortMs - b.sortMs; });
    c.segments.forEach(function (s) { delete s.sortMs; });
    // 參考時數：忘刷卡整天留白（null），與出勤月表同一規則（A3，見 dayReferenceIncomplete）
    c.reference = dayReferenceIncomplete(c.segments, d, todayStr) ? null : Math.round(c.reference * 100) / 100;
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
 * 某員工某月（ym='yyyy-MM'）的核定時數合計——打卡頁「本月／上月合計」用。
 * 讀 approvedMap（buildLatestApprovedMap 產出＝每日最新一筆核定），與出勤月表的
 * approvedTotalByEmp 同一份資料、同一套讀法，兩邊數字保證一致。
 * ⚠ 絕不可改成把 my_recent 的 days 加總——RECENT_DAYS_WINDOW(40) 天視窗涵蓋不到完整上月
 *   （例：7/31 只回溯到 6/22，6/1–6/21 全部漏掉），合計會少算。
 * 未核定的日子不計入（rec 不存在＝待核定）；核定 0 小時（全天請假）是合法值照樣計入 0。
 */
function monthlyApprovedTotal(approvedMap, empId, ym) {
  let total = 0;
  Object.keys(approvedMap || {}).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    const rec = approvedMap[d][String(empId)];
    if (!rec) return;
    total += Number(rec.approved_hours) || 0;
  });
  // 核定工時是 0.25 的倍數，用 2 位小數整理浮點誤差（勿取 1 位，會把 .75 進成 .8）
  return Math.round(total * 100) / 100;
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
  if (!roster || String(roster.active).toLowerCase() !== 'true') {
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

  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化（勿自己重寫日期正規化，沿用既有 normCellTs）
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
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
    // 本月／上月核定時數合計（2026-07-31 新增）。獨立於 days 計算——days 只有 40 天視窗，
    // 蓋不滿整個上月；這裡直接掃 approved 分頁全部日期，與月表合計同源。
    month_totals: monthTotalsFor(approvedMap, roster.emp_id, eventRows, todayTaipeiStr()),
  };
}

/**
 * 某員工某月「有上班紀錄」的日期清單。日期歸屬完全比照出勤月表 buildMonthlySheet：
 * 完整班段歸 in 那一天（跨夜段不會誤算成隔天多一天）、未配對的 in／out 各歸自己那天
 * （＝忘刷卡的那天也算有上班，那正是最需要主管核定的日子）。
 * 直接用 pairShifts，勿自己重寫配對或日期歸屬。
 */
function monthWorkedDays(eventRows, empId, ym) {
  const paired = pairShifts(eventRows.filter(function (e) { return String(e.emp_id) === String(empId); }));
  const days = {};
  function mark(d) { if (String(d).slice(0, 7) === ym) days[d] = true; }
  paired.shifts.forEach(function (s) { mark(tsDateStr(s.in_ts)); });
  paired.unmatchedIns.forEach(function (e) { mark(tsDateStr(e.ts)); });
  paired.unmatchedOuts.forEach(function (e) { mark(loneOutDate_(e.ts)); });
  return Object.keys(days);
}

/**
 * 某員工某月「有上班但主管還沒核定」的日期陣列（由舊到新）——供打卡頁天數提示與
 * 主管核定頁置頂提醒共用同一套判斷（2026-09-18 從 monthPendingApprovalDays 抽出，行為不變）。
 * 今天（與未來）不算：當天班還沒結束、主管本來就還不會核，天天顯示只是雜訊
 * （與月表把今天未配對 in 標「上班中」而非忘刷卡同一個精神）。
 */
function monthPendingApprovalDates(eventRows, approvedMap, empId, ym, todayStr) {
  return monthWorkedDays(eventRows, empId, ym).filter(function (d) {
    if (d >= todayStr) return false;
    return !((approvedMap[d] || {})[String(empId)]);
  }).sort();
}

/**
 * 某員工某月「有上班但主管還沒核定」的天數——打卡頁合計下方的提示用。
 * 合計只加總已核定的日子，沒這個提示同仁會以為時數被少算（Eason 2026-07-31 指定）。
 */
function monthPendingApprovalDays(eventRows, approvedMap, empId, ym, todayStr) {
  return monthPendingApprovalDates(eventRows, approvedMap, empId, ym, todayStr).length;
}

/** 打卡頁「本月／上月合計」的成組回傳（current/previous 各含 ym、hours、pending_days）。 */
function monthTotalsFor(approvedMap, empId, eventRows, todayStr) {
  const ym = currentYmTaipei();
  const prev = prevYm(ym);
  function box(y) {
    return {
      ym: y,
      hours: monthlyApprovedTotal(approvedMap, empId, y),
      pending_days: monthPendingApprovalDays(eventRows, approvedMap, empId, y, todayStr),
    };
  }
  return { current: box(ym), previous: box(prev) };
}

function handleClock(body, preRead, preRoster) {   // preRead／preRoster：LINE 打卡已經讀好的 events（{headers, rows}）與名冊列，給了就不再讀一次（2026-10-12）
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = (preRoster && preRoster.length) ? preRoster : readSheetAsObjects(rosterSheet).rows;

  const roster = findRosterByKey(rosterRows, body.key);
  if (!roster || String(roster.active).toLowerCase() !== 'true') {
    return { ok: false, error: 'invalid_key' };
  }

  // 2026-10-29 審查：舊 clock 動作原本不擋 type，也不管 device_id 內容——= 開頭的字串寫進 events／名冊會被 Sheets 當公式跑。
  // 所有呼叫端（clock.html、LINE 打卡）只送 in／out；device_id 是 UUID 或 line:<userId>，第一個字是 = + - @ 就換成全形（不擋，免得舊手機打不了卡）。
  if (body.type !== 'in' && body.type !== 'out') return { ok: false, error: 'bad_type' };
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  const deviceId = String(body.device_id || '').replace(/^[=+\-@]/, function (c) { return { '=': '＝', '+': '＋', '-': '－', '@': '＠' }[c]; });
  const distanceM = Math.round(haversineM(CONFIG.STORE_LAT, CONFIG.STORE_LNG, lat, lng) * 10) / 10;
  const ts = nowTaipeiIso();
  // 手機沒給或給了怪值就存空白（舊版前端不會帶這個欄位，不能因此讓打卡失敗）
  const rawAccuracy = parseFloat(body.accuracy);
  const accuracyM = isFinite(rawAccuracy) && rawAccuracy >= 0 ? Math.round(rawAccuracy * 10) / 10 : '';
  // 距離扣掉定位誤差後才拿來判定（見 ACCURACY_CREDIT_CAP_M）。distance_m 欄位仍存原始距離，
  // 誤差另存 accuracy_m，兩者都留著，事後要重算判定隨時可以。
  const accuracyCredit = accuracyM === '' ? 0 : Math.min(accuracyM, ACCURACY_CREDIT_CAP_M);
  // 2026-11-11（B20）：相減後再取到 0.1 公尺。兩個 0.1 一格的數字相減，「剛好等於半徑」時小數運算會多出 0.000000000000004，
  // 被判成超出範圍（例：32.2 − 12.2）。LineHub.gs lineHubPickStore_、clock-line-core.js 同一條算式，要一起改。
  const effectiveDistanceM = Math.max(0, Math.round((distanceM - accuracyCredit) * 10) / 10);
  const withinRange = effectiveDistanceM <= CONFIG.RADIUS_M;

  // 檢查順序：重複檢查 → 裝置檢查 → 範圍檢查
  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化，否則交替防呆的回看視窗可能誤判
  const eventsRead = (preRead && preRead.headers && preRead.headers.length) ? preRead
    : readEventsSince(eventsSheet, Date.now() - (CONFIG.ALTERNATION_LOOKBACK_HOURS + 1) * 3600000);   // 交替防呆只回看 12 小時，多留 1 小時
  // 既有 events 分頁的表頭只有 10 欄，沒補表頭的話新寫入的第 11 欄會因為 readSheetAsObjects
  // 是照表頭取值而永遠讀不回來。這裡就地自癒，不必請 Eason 去編輯器跑 setup()。
  if (eventsRead.headers.indexOf('accuracy_m') === -1) {
    eventsSheet.getRange(1, 1, 1, EVENTS_HEADERS.length).setValues([EVENTS_HEADERS]);
  }
  const clockEventRows = eventsRead.rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  const lastCounted = clockLastWithMark_(clockEventRows, roster.emp_id);   // 併上「剛送出」記號（同一人兩筆同時到，2026-11-03）
  // 同型只擋 10 分鐘（2026-11-02 Eason：中午忘打下班卡，晚上回來要能打上班卡）；超過就收，前一張由配對標忘刷卡
  const isDuplicate = lastCounted !== null && lastCounted.type === String(body.type)
    && Date.now() - new Date(lastCounted.ts).getTime() < SAME_TYPE_LOCK_MIN * 60000;
  const prevMark = isDuplicate ? null : clockMarkPut_(roster.emp_id, String(body.type), ts);
  // 單日 10 小時／兩班間隔 11 小時（2026-11-01，11-02 由 12 改 11；Rest.gs）：只擋上班卡；沒部署 Rest.gs 或總開關關著＝null
  let restBlock = null;
  try { restBlock = (body.type === 'in' && !isDuplicate && typeof restCheckIn_ === 'function') ? restCheckIn_(ss, roster) : null; }
  catch (e) { if (!isDuplicate) clockMarkRestore_(roster.emp_id, prevMark); throw e; }

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

  // status 優先序：重複 > 休息不足（rejected_rest，Rest.gs）> 裝置不符 > 超出範圍 > ok
  let status;
  if (isDuplicate) {
    status = 'rejected_duplicate';
  } else if (restBlock) {
    status = 'rejected_rest';
  } else if (!deviceMatch) {
    status = 'pending_device_approval';
  } else if (!withinRange) {
    status = 'rejected_out_of_range';
  } else {
    status = 'ok';
  }

  // 這張沒算數（被擋）就把記號還原，不能讓它擋到同仁接著重按；寫入失敗也還原
  if (!isDuplicate && status.indexOf('rejected_') === 0) clockMarkRestore_(roster.emp_id, prevMark);
  empIdColText_(eventsSheet);
  try { eventsSheet.appendRow([ts, roster.emp_id, body.type, lat, lng, distanceM, withinRange, deviceId, deviceMatch, status, accuracyM]); }
  catch (e) { if (!isDuplicate) clockMarkRestore_(roster.emp_id, prevMark); throw e; }

  const result = {
    ok: true,
    status: status,
    name: roster.name,
    ts: ts,
    distance_m: distanceM,
    within_range: withinRange,
    accuracy_m: accuracyM === '' ? null : accuracyM,
    // 前端用這個決定要不要多給一句「定位可能不準」的提示，門檻不寫死在前端
    low_accuracy: accuracyM !== '' && accuracyM > LOW_ACCURACY_M,
  };
  if (status === 'rejected_duplicate') {
    result.last_type = lastCounted.type;
  }
  if (restBlock) result.rest = restBlock;
  return result;
}

function handleWhoami(body) {
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  const eventsSheet = ss.getSheetByName('events');
  const rosterRows = readSheetAsObjects(rosterSheet).rows;

  const roster = findRosterByKey(rosterRows, body.key);
  if (!roster || String(roster.active).toLowerCase() !== 'true') {
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
  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化（同一批補漏見 handleMyRecent/handleMgrDay 等）
  const eventRows = readSheetAsObjects(eventsSheet).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  const todayEvents = eventRows
    .filter(function (e) { return String(e.emp_id) === String(roster.emp_id) && String(e.ts).slice(0, 10) === today; })
    .map(function (e) {
      const acc = parseFloat(e.accuracy_m);
      return {
        ts: e.ts,
        type: e.type,
        status: e.status,
        // 今日紀錄裡「超出範圍」那幾筆要能標出定位誤差，同仁才知道是定位不準還是真的不在店裡
        accuracy_m: isFinite(acc) ? acc : null,
        low_accuracy: isFinite(acc) && acc > LOW_ACCURACY_M,
      };
    });

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
    // 店內公告：沒有公告時回空陣列，前端整塊不顯示（畫面與加這功能之前一模一樣）。
    notices: activeNotices(ss, today),
  };
}

function checkAdmin(body) {
  // 金鑰沒設時一律拒絕，避免空字串對空字串也算通過（2026-11-10 資安審計；範本值由部署工具擋）
  const k = String(CONFIG.ADMIN_KEY || '');
  if (!k) return false;
  return body.admin_key === k;
}

function handleSyncRoster(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };

  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  rosterLockTextCols_(rosterSheet);   // 工號、金鑰欄鎖文字：'0007' 不會變成 7（2026-11-04 仿試算表測試）
  const rosterRows = readSheetAsObjects(rosterSheet).rows;
  const employees = body.employees || [];

  const skipped = [];
  // （2026-11-04 夜間 QA）新增同仁前先擋同名在職者（薪資／請假用姓名對人，同名會算錯；比照 svc_add／mgr_add_employee）。
  const activeNames = {};
  // 2026-11-13 驗收 F7：改名也要擋同名在職（原本只擋新增，改名撞名後兩人的請假列會互蓋）。
  // activeByName：名字 → { 工號: true }，只記在職者；同一批照順序更新，互換名字時先改的那位會先讓出名字。
  const activeByName = {};
  const isOn = function (v) { return v === true || String(v).toLowerCase() === 'true'; };
  rosterRows.forEach(function (r) {
    if (!isOn(r.active)) return;
    activeNames[String(r.name).trim()] = true;
    (activeByName[String(r.name).trim()] = activeByName[String(r.name).trim()] || {})[String(r.emp_id)] = true;
  });
  const otherActiveSameName = function (nm, id) {
    const m = activeByName[nm] || {};
    return Object.keys(m).some(function (k) { return k !== id; });
  };
  employees.forEach(function (emp) {
    const existing = findRosterByEmpId(rosterRows, emp.emp_id);
    const nm = sheetSafeText_(String(emp.name == null ? '' : emp.name));   // = + - @ 開頭換全形（2026-11-04 對抗驗證）
    if (existing) {
      const id = String(existing.emp_id);
      const oldNm = String(existing.name).trim();
      const wasOn = isOn(existing.active);
      const willOn = emp.active === undefined ? wasOn : isOn(emp.active);
      // 只在「名字真的改了」或「離職改回在職」時檢查；名字沒變的既有同名列照舊更新，不誤擋。
      if (willOn && (nm.trim() !== oldNm || !wasOn) && otherActiveSameName(nm.trim(), id)) {
        skipped.push({ emp_id: String(emp.emp_id), reason: 'duplicate_name' });
        return;
      }
      if (wasOn && activeByName[oldNm]) delete activeByName[oldNm][id];
      if (willOn) { (activeByName[nm.trim()] = activeByName[nm.trim()] || {})[id] = true; activeNames[nm.trim()] = true; }
      // 只更新 name/active，絕不覆蓋 key/device_id/device_bound_at
      rosterSheet.getRange(existing.__rowIndex, ROSTER_HEADERS.indexOf('name') + 1).setValue(nm);
      // 沒帶 active（undefined）就保留原本的在職狀態，不可把沒帶欄位當成 false 停用人（2026-11-04 夜間 QA）
      if (emp.active !== undefined) {
        rosterSheet.getRange(existing.__rowIndex, ROSTER_HEADERS.indexOf('active') + 1).setValue(emp.active === true || String(emp.active).toLowerCase() === 'true');   // 夜間 QA 低-2：字串 "false" 不是在職
      }
    } else {
      if (activeNames[nm.trim()]) { skipped.push({ emp_id: String(emp.emp_id), reason: 'duplicate_name' }); return; }
      const act = emp.active === undefined ? true : (emp.active === true || String(emp.active).toLowerCase() === 'true');   // 新增列沒帶 active 一律在職
      rosterSheet.appendRow([sheetSafeText_(String(emp.emp_id)), nm, genKey(), '', '', act]);
      if (act) { activeNames[nm.trim()] = true; (activeByName[nm.trim()] = activeByName[nm.trim()] || {})[sheetSafeText_(String(emp.emp_id))] = true; }
    }
  });

  const finalRows = readSheetAsObjects(rosterSheet).rows.map(stripRowIndex);
  const res = { ok: true, roster: finalRows };
  if (skipped.length) res.skipped = skipped;
  return res;
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
  const rows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(stripRowIndex)
    .map(function (e) { e.ts = normCellTs(e.ts); return e; });

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

  const eventRows = readSheetAsObjects(eventsSheet).rows;

  // 防呆（2026-08-03）：該 (emp_id, device_id) 至少要有一筆待核准事件才准動。
  // 原本改綁那段無條件執行且在事件迴圈之前——傳一個不存在的 device_id（例如只看了前 8 碼
  // 自己補完的），回應是無害的 changed:0，名冊卻已被改綁成那個假 ID，該同仁下次打卡直接
  // 變「新裝置待核准」。沒有待核准事件＝沒有東西要決定，一律不改綁、不寫入。
  const hasPending = eventRows.some(function (e) {
    return String(e.emp_id) === String(empId) &&
      String(e.device_id) === String(deviceId) &&
      e.status === 'pending_device_approval';
  });
  if (!hasPending) return { ok: false, error: 'no_pending_device' };

  if (approve) {
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_id') + 1).setValue(deviceId);
    rosterSheet.getRange(roster.__rowIndex, ROSTER_HEADERS.indexOf('device_bound_at') + 1).setValue(nowTaipeiIso());
  }

  let changed = 0;
  const affectedMonths = {};
  eventRows.forEach(function (e) {
    if (
      String(e.emp_id) === String(empId) &&
      String(e.device_id) === String(deviceId) &&
      e.status === 'pending_device_approval'
    ) {
      // 核准只解「裝置」這一關：超出範圍的卡翻成 rejected_out_of_range，不得入帳
      // （否則在家用新裝置打卡→核准換機→在家打的卡變有效，2026-07-12 實測抓到的漏洞）
      const newStatus = approve
        ? (String(e.within_range).toLowerCase() === 'true' ? 'ok' : 'rejected_out_of_range')
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

/**
 * API：{action:'mgr_pending_devices', mgr_key} → 目前所有待核准裝置（給主管頁用）。
 * 與 admin 的差別只在驗證方式（主管金鑰 vs 管理金鑰），資料來源同為 collectPendingDevices，
 * 不另寫一套分組邏輯。（2026-08-03 新增：原本核准裝置只能開 Apps Script 編輯器跑函式。）
 */
function handleMgrPendingDevices(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  if (!findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };
  return { ok: true, pending: collectPendingDevices() };
}

/**
 * API：{action:'mgr_pending_approvals', mgr_key} → 本月「有上班但主管還沒核定」清單，
 * 依日期分組給主管核定頁置頂提醒用（2026-09-18 新增）。
 * 判斷規則與同仁打卡頁「尚有 N 天待核定」完全同一套（monthPendingApprovalDates），不另寫一套。
 * 對象：本月 events 裡出現過的所有 emp_id，含已停用／離職——他們漏核的日子一樣影響薪資。
 * 姓名一律從 roster 對（不論 active），對不到就用 emp_id 頂替。
 */
function handleMgrPendingApprovals(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  if (!findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };

  const ym = currentYmTaipei();
  const today = todayTaipeiStr();
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化（勿自己重寫日期正規化，沿用既有 normCellTs）
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  const approvedSheet = ss.getSheetByName('approved');
  const approvedRows = approvedSheet ? readSheetAsObjects(approvedSheet).rows : [];
  const approvedMap = buildLatestApprovedMap(approvedRows);

  // 本月 events 出現過的所有 emp_id（含停用／離職；不用 roster 的 active 名單，避免漏掉離職者）
  const empIds = {};
  eventRows.forEach(function (e) {
    if (tsDateStr(e.ts).slice(0, 7) === ym) empIds[String(e.emp_id)] = true;
  });

  const items = [];
  Object.keys(empIds).forEach(function (empId) {
    const roster = findRosterByEmpId(rosterRows, empId);
    const name = roster ? String(roster.name) : empId;
    monthPendingApprovalDates(eventRows, approvedMap, empId, ym, today).forEach(function (d) {
      items.push({ date: d, emp_id: empId, name: name });
    });
  });

  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  return { ok: true, ym: ym, today: today, items: items };
}

/**
 * API：{action:'mgr_device_decision', mgr_key, emp_id, device_id, approve} → 核准/拒絕裝置。
 * 直接轉呼叫 applyDeviceDecision（含「核准只解裝置這關、超出範圍的卡仍不入帳」的分流，
 * 以及 2026-08-03 的「沒有待核准事件就不改綁」防呆），不重寫決策邏輯。
 */
function handleMgrDeviceDecision(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  const actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };
  const result = applyDeviceDecision(body.emp_id, body.device_id, !!body.approve);
  if (result.ok) result.manager_name = actor;
  return result;
}

/* ============================================================
 * 值班主管核定 — API（2026-07-13 新增）
 * 依賴的純函式（dayPunchSegments/computeApprovalStatus/buildLatestApprovedMap/
 * hmToMs/addDaysStr）定義在下方「出勤月表 — 純函式區」，因 function 宣告會 hoist，
 * 這裡可直接呼叫。
 * ============================================================ */

function findManagerByKey(rows, key) {
  if (!String(key == null ? '' : key).trim()) return undefined;   // 空白金鑰不算身分（2026-11-10 資安審計）
  return rows.filter(function (r) { return String(r.key) === String(key) && String(r.active).toLowerCase() === 'true'; })[0];
}

/**
 * 實際操作人（2026-10-18，營運系統改個人帳號）：寫進「核定人／審核人／建立者／移除者」欄的名字。
 * 只有 managers 列 allow_acting＝TRUE（營運系統代管的那把主管鑰匙）才採用 body.acting_name；
 * 其他主管連結一律照舊回該主管名字（拿舊連結的人不能冒名）。
 * 採用時格式不合（非字串、去空白後空的、超過 40 字）回 null，呼叫端要整筆拒絕，不要默默退回主管名字。
 */
function actingName_(body, mgr) {
  const own = String((mgr && mgr.name) || '');
  if (String((mgr && mgr.allow_acting) || '').toLowerCase() !== 'true') return own;
  const v = body ? body.acting_name : undefined;
  if (v === undefined || v === null || v === '') return own;
  if (typeof v !== 'string') return null;
  const s = sheetSafeText_(v.trim());
  return s && s.length <= 40 ? s : null;
}

/** 主管輸入的文字寫進試算表前，開頭的 = + - @ 換全形（2026-11-03 對抗驗證 #2）：
 *  否則 Sheets 會把它當公式跑，例如 =IMPORTDATA(…&JOIN(",",roster!C2:C50)) 就能把名冊金鑰送到外部。
 *  同 Requests.gs reqSheetText_、handleClock 對 device_id 的處理；開頭空白也算（Sheets 會略過空白再判斷）。 */
function sheetSafeText_(v) {
  const s = String(v), m = /^(\s*)([=+\-@])/.exec(s);
  return m ? m[1] + { '=': '＝', '+': '＋', '-': '－', '@': '＠' }[m[2]] + s.slice(m[0].length) : s;
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
 * API：{action:'set_shifts', admin_key, shifts:[{emp_id?|name?, shift_in, shift_out}]}
 * → 批次設定名冊的預設上下班時間（值班核定頁會據此預填時段）。
 * 認 emp_id 優先，沒給就用 name 比對。時間留空＝清掉該人的個人設定（改用全店預設）。
 * ⚠ 只寫 shift_in／shift_out 兩欄，不動 key／device_id／active——避免誤改綁定或把人停用。
 */
function handleSetShifts(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.shifts)) return { ok: false, error: 'shifts_required' };
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  /* ⚠ 舊試算表的 roster 只有 6 欄（emp_id…active），沒有 shift_in／shift_out。
     原本的檢查看的是程式常數 ROSTER_HEADERS（一定有那兩欄），所以檢查永遠通過、
     值就被寫進「沒有表頭的欄位」——readSheetAsObjects 依表頭取值，於是永遠讀不回來，
     而且不會報錯（2026-08-26 實際踩到：總部一位同仁寫進去回查是 undefined，
     光復也缺這兩欄、預填班別功能等於從沒生效過）。這裡照 handleClock 對 events 的做法就地自癒。*/
  const rosterRead = readSheetAsObjects(rosterSheet);
  if (rosterRead.headers.indexOf('shift_in') === -1 || rosterRead.headers.indexOf('shift_out') === -1) {
    rosterSheet.getRange(1, 1, 1, ROSTER_HEADERS.length).setValues([ROSTER_HEADERS]);
  }
  const rows = readSheetAsObjects(rosterSheet).rows;   // 補完表頭再讀，欄位才對得上
  const ci = ROSTER_HEADERS.indexOf('shift_in') + 1;
  const co = ROSTER_HEADERS.indexOf('shift_out') + 1;
  if (ci <= 0 || co <= 0) return { ok: false, error: 'no_shift_columns', message: '名冊還沒有 shift_in／shift_out 欄，請先跑 setup()' };

  const done = [], missed = [];
  body.shifts.forEach(function (x) {
    const wantId = String(x.emp_id || '').trim();
    const wantNm = String(x.name || '').trim();
    const hit = rows.filter(function (r) {
      return wantId ? String(r.emp_id) === wantId : String(r.name).trim() === wantNm;
    })[0];
    if (!hit) { missed.push(wantId || wantNm); return; }
    const si = normShiftTime(x.shift_in), so = normShiftTime(x.shift_out);
    // 兩欄一起寫。給了值卻正規化失敗（打錯格式）就當成清空，不會寫進髒資料。
    // 每格先鎖文字再寫（2026-11-04 仿試算表測試）：原本整欄最後才鎖，第一次寫入的 11:00 已被轉成時間，核定頁預填空白
    const cIn = rosterSheet.getRange(hit.__rowIndex, ci), cOut = rosterSheet.getRange(hit.__rowIndex, co);
    cIn.setNumberFormat('@'); cIn.setValue(si);
    cOut.setNumberFormat('@'); cOut.setValue(so);
    done.push({ emp_id: String(hit.emp_id), name: String(hit.name), shift_in: si, shift_out: so });
  });
  // 時間欄鎖成文字，否則 Sheets 會把 11:00 轉成時間物件（讀回來是 Date）
  rosterSheet.getRange(2, ci, Math.max(1, rosterSheet.getLastRow() - 1), 2).setNumberFormat('@');
  return { ok: true, updated: done.length, shifts: done, not_found: missed };
}
/** 依現有名冊推下一個員工編號：抓出「英數前綴＋數字」形式最常見的那種，取最大值 +1，
 *  並維持原本的位數（E09→E10、CF13→CF14、HQ-01→HQ-02）。名冊全空時用 CONFIG.EMP_PREFIX。 */
function nextEmpId(rosterRows) {
  const pat = {};
  rosterRows.forEach(function (r) {
    const m = String(r.emp_id || '').match(/^(.*?)(\d+)$/);
    if (!m) return;
    const k = m[1] + '|' + m[2].length;
    if (!pat[k]) pat[k] = { prefix: m[1], width: m[2].length, max: 0, n: 0 };
    pat[k].max = Math.max(pat[k].max, parseInt(m[2], 10));
    pat[k].n += 1;
  });
  const keys = Object.keys(pat);
  if (!keys.length) {
    const pfx = String(CONFIG.EMP_PREFIX || 'E');
    return pfx + '01';
  }
  keys.sort(function (a, b) { return pat[b].n - pat[a].n; });   // 用最多人採用的那種格式
  const p = pat[keys[0]];
  let num = String(p.max + 1);
  while (num.length < p.width) num = '0' + num;
  return p.prefix + num;
}

/**
 * API：{action:'mgr_add_employee', mgr_key, name} → 值班主管自助新增同仁，回傳專屬打卡連結。
 *
 * 設計取捨（Eason 2026-08-23 定案）：**不做事前核准，改用事後看得見**。
 *  - 新增後立刻可打卡、立刻計薪，主管不必等 Eason，Eason 也不會變成瓶頸。
 *  - 代價由三件事承擔：①名冊記 created_at／created_by ②每日指揮台隔天通知
 *    ③薪酬系統標「本月新增」。異常才需要處理，正常招募完全不用介入。
 * 兩條硬性限制：
 *  - 不能新增與自己同名的人（防自建自用）。
 *  - 不能與現有在職同仁同名——薪酬的請假與工時是**用姓名**對應的，同名會直接算錯錢。
 */
/**
 * 新增同仁加鎖（2026-10-12，營運系統 Codex 審查）：兩台同時新增時，取號（nextEmpId）與寫入要在同一把鎖裡，
 * 否則兩邊都讀到同一份名冊、拿到同一個員工編號。鎖等不到回 busy，請稍後再按。
 */
function handleMgrAddEmployee(body) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return { ok: false, error: 'busy', message: '有人同時在新增同仁，請稍等幾秒再按一次' }; }
  try {
    const r = handleMgrAddEmployeeUnlocked_(body);
    SpreadsheetApp.flush();
    return r;
  } finally { lock.releaseLock(); }
}

function handleMgrAddEmployeeUnlocked_(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'no_managers' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  const actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };

  const name = sheetSafeText_(String(body.name || '').trim());
  if (!name) return { ok: false, error: 'name_required', message: '請輸入同仁姓名' };
  if (name.length > 20) return { ok: false, error: 'name_too_long', message: '姓名過長' };
  if (name === String(mgr.name).trim()) {
    return { ok: false, error: 'self_add', message: '不能新增與自己同名的同仁' };
  }

  const rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  const rows = readSheetAsObjects(rosterSheet).rows;
  // 2026-11-11（B27）：去掉全部空白再比（LINE 綁定比對姓名就是這樣比的）。只去頭尾的話「測 試一」新增得進去，
  // 之後兩位在 LINE 綁定時都會被當成同名而綁不了。
  const nameKey = name.replace(/\s/g, '');
  const dup = rows.filter(function (r) {
    return String(r.name).replace(/\s/g, '') === nameKey && String(r.active).toLowerCase() === 'true';
  })[0];
  if (dup) {
    return { ok: false, error: 'duplicate_name',
             message: '名冊已經有在職的「' + name + '」（編號 ' + dup.emp_id + '）。'
                    + '薪資是用姓名對應請假與工時，同名會算錯——如果真的是不同人，請改用可區分的名字。' };
  }

  const empId = nextEmpId(rows);
  const key = genKey();
  const now = nowTaipeiIso();
  // 依 ROSTER_HEADERS 順序組列，避免日後欄位增減時錯位
  const row = ROSTER_HEADERS.map(function (h) {
    return h === 'emp_id' ? empId : h === 'name' ? name : h === 'key' ? key
         : h === 'active' ? true : h === 'created_at' ? now
         : h === 'created_by' ? actor : '';
  });
  rosterLockTextCols_(rosterSheet);   // 工號、金鑰欄鎖文字（2026-11-04）
  rosterSheet.appendRow(row);
  // created_at 是純日期時間字串，鎖文字避免被轉成日期物件
  const ci = ROSTER_HEADERS.indexOf('created_at') + 1;
  rosterSheet.getRange(rosterSheet.getLastRow(), ci).setNumberFormat('@').setValue(now);
  return { ok: true, emp_id: empId, name: name, key: key, created_by: actor, created_at: now };
}

/**
 * 依「試算表實際表頭」寫名冊某一格。
 * ⚠ 不可用 ROSTER_HEADERS.indexOf 當欄號——新欄位是補在表最右邊的，
 *   實際順序不一定等於常數順序（既有三家店的表都是先建好才加欄位）。
 */
function setRosterCell(sheet, rowIndex, header, value, asText) {
  const head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
  const c = head.indexOf(header) + 1;
  if (!c) return false;
  const cell = sheet.getRange(rowIndex, c);
  if (asText) cell.setNumberFormat('@');
  cell.setValue(value);
  return true;
}

/** 名冊缺哪個 ROSTER_HEADERS 欄位就補到最右邊（冪等）。三家店不必手動改表頭。 */
/** 名冊的 emp_id、key 兩欄整欄鎖成文字（依實際表頭找欄）：純數字工號／金鑰（'0007'、'00123'）才不會被 Sheets 轉成數字、吃掉前導零。
 *  只影響之後寫入或手打的格子；已經被轉成數字的舊格要人工改回。失敗不擋呼叫端。 */
function rosterLockTextCols_(sheet) {
  try {
    const head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
    ['emp_id', 'key'].forEach(function (h) {
      const c = head.indexOf(h);
      if (c >= 0) sheet.getRange(1, c + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    });
  } catch (e) { /* 鎖不上照常寫，只是回到原本行為 */ }
}

/* events／approved 的 emp_id 欄（第 2 欄）鎖文字（2026-11-04 夜間 QA #3）：純數字工號（'0007'）寫進去會被試算表轉成數字 7，
   之後本月合計、mgr_day 都對不上這個人。每次寫入都設格式太貴 → 每張表每 6 小時只設一次（快取記號＋本次執行記憶）。
   系統自己開的工號都帶英文字頭（E01／CF01），這條只防人手在名冊打純數字工號。 */
var EMPID_TEXT_DONE_ = {};
function empIdColText_(sheet) {
  try {
    const k = 'eidtxt:' + sheet.getSheetId();
    if (EMPID_TEXT_DONE_[k]) return;
    EMPID_TEXT_DONE_[k] = true;
    const cache = CacheService.getScriptCache();
    if (cache.get(k)) return;
    sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat('@');
    cache.put(k, '1', 21600);
  } catch (e) { /* 鎖不上照常寫，只是回到原本行為 */ }
}

function ensureRosterHeaders(sheet) {
  const head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
  ROSTER_HEADERS.forEach(function (h) {
    if (head.indexOf(h) === -1) { sheet.getRange(1, head.length + 1).setValue(h); head.push(h); }
  });
}

/**
 * API：{action:'mgr_roster', mgr_key} → 名冊清單，給主管頁的「同仁異動」用。
 * 刻意不回 key 與 device_id：主管頁只需要姓名與在職狀態，金鑰沒有理由在這條路徑上流動。
 */
function handleMgrRoster(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'no_managers' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  const rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  const roster = readSheetAsObjects(rosterSheet).rows.map(function (r) {
    return { emp_id: String(r.emp_id), name: String(r.name),
             active: String(r.active).toLowerCase() === 'true',
             created_by: String(r.created_by || ''),
             removed_at: String(normCellTs(r.removed_at) || ''),
             removed_by: String(r.removed_by || '') };
  });
  return { ok: true, roster: roster, manager_name: String(mgr.name || ''), add_redirect: staffMasterAddRedirect_() };
}

/**
 * API：{action:'mgr_set_active', mgr_key, emp_id, active} → 值班主管把同仁設為離職／恢復在職。
 *
 * 「刪除同仁」在這個系統一律是**停用、不是真刪**：打卡事件、核定紀錄、薪資的請假與工時
 * 都是用 emp_id／姓名對應的，真的移除名冊列會讓歷史紀錄對不到人。停用後該員打不了卡、
 * 不再出現在核定清單，但當天若已有打卡，mgr_day 仍會把他補進清單（見該函式的 firstTs 補位），
 * 所以離職當天的工時照樣核定得到。
 *
 * 留痕 removed_at／removed_by，與 created_at／created_by 同一套精神
 * （Eason 2026-08-22 定調：不做事前核准，改用事後看得見）。
 */
function handleMgrSetActive(body) {
  // 夜間 QA 低-5：整支包 script lock（讀名冊→檢查→寫入不可交錯；比照 svc_set_active）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy', message: '另一個名冊動作進行中，請稍後再試' };
  try {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'no_managers' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  const actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };

  const rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  ensureRosterHeaders(rosterSheet);

  const empId = String(body.emp_id || '').trim();
  if (!empId) return { ok: false, error: 'emp_id_required', message: '請先選擇同仁' };
  const rows = readSheetAsObjects(rosterSheet).rows;
  const row = findRosterByEmpId(rows, empId);
  if (!row) return { ok: false, error: 'not_found', message: '名冊裡找不到這位同仁' };

  const active = body.active === true || String(body.active).toLowerCase() === 'true';
  const wasActive = String(row.active).toLowerCase() === 'true';
  const name = String(row.name).trim();

  // 不能把自己設為離職（與 mgr_add_employee 的「不能新增與自己同名」同一道防線）
  if (!active && name === String(mgr.name).trim()) {
    return { ok: false, error: 'self_remove', message: '不能把自己設為離職' };
  }
  if (active === wasActive) {
    return { ok: true, unchanged: true, emp_id: empId, name: name, active: active };
  }
  // 恢復在職要擋同名：薪資用姓名對應請假與工時，兩位同名同時在職會直接算錯錢
  if (active) {
    const dup = rows.filter(function (r) {
      return String(r.emp_id) !== empId && String(r.name).replace(/\s/g, '') === String(name).replace(/\s/g, '')   // 去掉全部空白再比（同新增，B27）
          && String(r.active).toLowerCase() === 'true';
    })[0];
    if (dup) {
      return { ok: false, error: 'duplicate_name',
               message: '名冊已經有在職的「' + name + '」（編號 ' + dup.emp_id + '），'
                      + '不能同時有兩位同名在職。' };
    }
  }

  // 夜間 QA 低-5：恢復在職前，這列的 LINE 若已被另一個在職列使用 → 兩個在職列同一 LINE，liffRosterByLine_ 會 line_identity_conflict、本人打不了卡
  const uid = String(row.line_user_id || '').trim();
  if (active && uid) {
    const lineDup = rows.filter(function (r) {
      return String(r.emp_id) !== empId && String(r.line_user_id || '').trim() === uid
          && String(r.active).toLowerCase() === 'true';
    })[0];
    if (lineDup) return { ok: false, error: 'line_identity_conflict', message: '這位同仁的 LINE 已綁在另一個在職帳號，請先解除其中一個綁定' };
  }

  const now = nowTaipeiIso();
  setRosterCell(rosterSheet, row.__rowIndex, 'active', active);
  // removed_at 是純日期時間字串，鎖文字避免被 Sheets 轉成日期物件（同 created_at）
  setRosterCell(rosterSheet, row.__rowIndex, 'removed_at', active ? '' : now, true);
  setRosterCell(rosterSheet, row.__rowIndex, 'removed_by', active ? '' : actor);
  if (typeof lineHubForget_ === 'function' && uid) lineHubForget_(uid);   // 夜間 QA 低-7：LINE 小幫手的「綁了哪幾家」快取要重查
  return { ok: true, emp_id: empId, name: name, active: active,
           removed_at: active ? '' : now, removed_by: active ? '' : actor };
  } finally { lock.releaseLock(); }
}

/* ══════════════════════════════════════════════════════════════
   店內公告（2026-08-28 新增）
   值班主管在核定頁發布 → 同仁打卡頁最上方輪播。
   分頁不存在時一律當作「沒有公告」，不報錯——三家店的舊試算表
   在部署當下都還沒有 notices 分頁，whoami 必須照常運作。
   ══════════════════════════════════════════════════════════════ */

/** notices 缺哪個欄位就補到最右邊（冪等）。同 ensureRosterHeaders 的精神。 */
function ensureNoticeHeaders(sheet) {
  const head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
  NOTICE_HEADERS.forEach(function (h) {
    if (head.indexOf(h) === -1) { sheet.getRange(1, head.length + 1).setValue(h); head.push(h); }
  });
}

/** 取得 notices 分頁；create 為真時找不到就自建（免得每加一家店都要記得跑 setup）。 */
function noticeSheet(ss, create) {
  let sheet = ss.getSheetByName('notices');
  if (!sheet && create) {
    sheet = ss.insertSheet('notices');
    sheet.getRange(1, 1, 1, NOTICE_HEADERS.length).setValues([NOTICE_HEADERS]);
  }
  if (sheet) ensureNoticeHeaders(sheet);
  // 公告內容欄鎖文字（2026-11-04 仿試算表測試）：'0800' 這種內容原本會被轉成數字 800
  if (sheet && create) { try { sheet.getRange(1, NOTICE_HEADERS.indexOf('text') + 1, sheet.getMaxRows(), 1).setNumberFormat('@'); } catch (e) {} }
  return sheet;
}

/**
 * 同仁端要顯示的公告：啟用中、未過下架日，新的排前面，最多 NOTICE_MAX_SHOW 則。
 * ⚠ ends_on／created_at 從儲存格讀回可能是 Date 物件，一律過 normCellDate／normCellTs，
 *   不可直接 String()（同 2026-07-15 核定日期比對那個坑）。
 */
function activeNotices(ss, today) {
  const sheet = ss.getSheetByName('notices');
  if (!sheet) return [];
  const t = String(today || todayTaipeiStr());
  return readSheetAsObjects(sheet).rows
    .filter(function (r) {
      if (String(r.active).toLowerCase() !== 'true') return false;
      const end = normCellDate(r.ends_on);
      // yyyy-MM-dd 是等寬格式，字串比較就等於日期比較。留空＝不下架。
      return !end || end >= t;
    })
    .map(function (r) {
      return { id: String(r.id), text: String(r.text || '').trim(),
               created_at: normCellTs(r.created_at) };
    })
    .filter(function (n) { return !!n.text; })
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : (a.created_at > b.created_at ? -1 : 0); })
    .slice(0, NOTICE_MAX_SHOW)
    .map(function (n) { return { id: n.id, text: n.text }; });
}

/** 送出來的下架日：允許空字串，否則必須是 yyyy-MM-dd。回 null 代表格式不合。 */
function normNoticeEndsOn(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** 主管金鑰驗證：三支公告 API 共用，回 {ok:false} 或 {ok:true, ss, mgr}。 */
function noticeAuth(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, res: { ok: false, error: 'no_managers' } };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, res: { ok: false, error: 'unauthorized' } };
  return { ok: true, ss: ss, mgr: mgr };
}

/**
 * API：{action:'mgr_notices', mgr_key} → 全部公告（含已停用與已過期），給主管頁管理用。
 * 與 activeNotices 不同：這裡不過濾、不截斷，主管要看得到自己發過什麼。
 */
function handleMgrNotices(body) {
  const auth = noticeAuth(body);
  if (!auth.ok) return auth.res;

  const sheet = auth.ss.getSheetByName('notices');
  if (!sheet) return { ok: true, notices: [], max_len: NOTICE_MAX_LEN, max_show: NOTICE_MAX_SHOW };

  const today = todayTaipeiStr();
  const notices = readSheetAsObjects(sheet).rows.map(function (r) {
    const end = normCellDate(r.ends_on);
    const on = String(r.active).toLowerCase() === 'true';
    return {
      id: String(r.id),
      text: String(r.text || '').trim(),
      active: on,
      ends_on: end,
      expired: !!end && end < today,
      created_at: normCellTs(r.created_at),
      created_by: String(r.created_by || ''),
    };
  }).filter(function (n) { return !!n.id; });

  notices.sort(function (a, b) { return a.created_at < b.created_at ? 1 : (a.created_at > b.created_at ? -1 : 0); });
  return { ok: true, notices: notices, max_len: NOTICE_MAX_LEN, max_show: NOTICE_MAX_SHOW };
}

/** API：{action:'mgr_add_notice', mgr_key, text, ends_on?} → 發布一則公告。 */
function handleMgrAddNotice(body) {
  const auth = noticeAuth(body);
  if (!auth.ok) return auth.res;
  const actor = actingName_(body, auth.mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };

  const text = sheetSafeText_(String(body.text == null ? '' : body.text).trim());
  if (!text) return { ok: false, error: 'text_required', message: '請先輸入公告內容' };
  if (text.length > NOTICE_MAX_LEN) {
    return { ok: false, error: 'text_too_long',
             message: '公告最多 ' + NOTICE_MAX_LEN + ' 個字（目前 ' + text.length + ' 個字）' };
  }
  const endsOn = normNoticeEndsOn(body.ends_on);
  if (endsOn === null) return { ok: false, error: 'bad_ends_on', message: '下架日期格式不對' };
  const today = todayTaipeiStr();
  if (endsOn && endsOn < today) {
    return { ok: false, error: 'ends_on_past', message: '下架日期已經過了，這則公告發出來不會顯示' };
  }

  const sheet = noticeSheet(auth.ss, true);
  const id = 'N' + Date.now();
  const createdAt = nowTaipeiIso();
  // appendRow 依 NOTICE_HEADERS 的順序；表頭自癒已在 noticeSheet 做過。
  sheet.appendRow([id, text, true, endsOn, createdAt, actor]);

  return { ok: true, id: id, text: text, ends_on: endsOn,
           created_at: createdAt, created_by: actor };
}

/**
 * API：{action:'mgr_set_notice_active', mgr_key, id, active} → 下架／重新啟用一則公告。
 * 刻意不做真刪除：發過什麼、誰發的要留得住（同 mgr_set_active 的處理）。
 */
function handleMgrSetNoticeActive(body) {
  const auth = noticeAuth(body);
  if (!auth.ok) return auth.res;

  const sheet = auth.ss.getSheetByName('notices');
  if (!sheet) return { ok: false, error: 'not_found', message: '找不到這則公告' };
  ensureNoticeHeaders(sheet);

  const id = String(body.id || '').trim();
  if (!id) return { ok: false, error: 'id_required' };
  const row = readSheetAsObjects(sheet).rows.filter(function (r) { return String(r.id) === id; })[0];
  if (!row) return { ok: false, error: 'not_found', message: '找不到這則公告' };

  const active = body.active === true || String(body.active).toLowerCase() === 'true';
  // setRosterCell 是依「實際表頭」定位的泛用寫格函式（名字沿用歷史），
  // 不可改用 NOTICE_HEADERS.indexOf——實際欄序未必等於常數順序。
  setRosterCell(sheet, row.__rowIndex, 'active', active);
  return { ok: true, id: id, active: active };
}

/**
 * API：{action:'recent_hires', admin_key, days?} → 最近 N 天由主管新增的同仁（預設 7 天）。
 * 給每日指揮台拉來做「今天新增了誰」的通知用；唯讀。
 */
function handleRecentHires(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const days = Number(body.days) > 0 ? Number(body.days) : 7;
  const ss = getSS();
  const rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { ok: true, hires: [] };
  // 2026-11-11（B22）：用時間點比，不比字串。原本拿世界標準時間的字串（…Z）和名冊上台北時間的字串（…+08:00）比大小，多算 8 小時。
  const cutoffMs = Date.now() - days * 86400000;
  const hires = readSheetAsObjects(rosterSheet).rows.filter(function (r) {
    const c = normCellTs(r.created_at);
    const t = c ? Date.parse(String(c)) : NaN;
    return c && !isNaN(t) && t >= cutoffMs;
  }).map(function (r) {
    return { emp_id: String(r.emp_id), name: String(r.name),
             created_at: String(normCellTs(r.created_at)), created_by: String(r.created_by || '') };
  });
  return { ok: true, days: days, hires: hires };
}

/**
 * API：{action:'mgr_day', mgr_key, date?}（date 缺省＝今天，Asia/Taipei）
 * → 回傳「roster 全部 active 同仁」（2026-07-13 Eason 實測回饋改版：當天沒打卡的也要出現，
 *   整天忘刷卡的人才核得到——segments 空陣列、reference=null，主管照樣可輸入時段核定）：
 *   有打卡的照舊顯示打卡段（沿用 pairShifts，未配對顯示？）＋參考時數、既有核定紀錄（最新一筆）。
 *   reference 忘刷卡整天也回 null（A3，與月表／my_recent 同一規則，不是沒打卡才 null）。
 *   attempts＝該日該員工 status!=='ok' 的事件筆數（A4，rejected 開頭或 pending 都算，主管頁揭露透明度）。
 *   排序：有打卡的在前（依當日第一筆打卡時間），沒打卡的在後（依名冊順序）。
 *   名冊外（或已離職）但當天有事件的 emp_id 補在最後，防禦用。
 */
/** 7A 自動加入的人（LineHub.gs → 管理系統同步員 svc_add）在名冊的 created_by（與同步員的 SUPPORT_CREATED_BY 同字串） */
const FIRST_SUPPORT_CREATED_BY = 'LINE 自動（首次支援）';

/** 值班核定頁「新增同仁」是否改成導向管理系統：指令碼屬性 STAFF_MASTER_ADD_REDIRECT＝'1'，或 CONFIG 同名欄位＝'1'。未設＝false（完全照舊）。 */
function staffMasterAddRedirect_() {
  try {
    if (String(CONFIG.STAFF_MASTER_ADD_REDIRECT || '') === '1') return true;
    return PropertiesService.getScriptProperties().getProperty('STAFF_MASTER_ADD_REDIRECT') === '1';
  } catch (e) { return false; }
}
/** leave 分頁 → { 日期: { 姓名(trim): [{type, hours}] } }（hours 空白＝''，同 mgr_day）。onlyDate 給了就只收那天。
 *  mgr_day 的 leaves 與 att_digest_data 的 leave_hours 共用這一支（不准另寫一套）。 */
function leaveByDateName_(ss, onlyDate) {
  const out = {};
  const sh = ss.getSheetByName('leave');
  if (!sh) return out;
  readSheetAsObjects(sh).rows.forEach(function (l) {
    const d = normCellDate(l['日期']);
    if (onlyDate && d !== onlyDate) return;
    const nm = String(l['姓名'] || '').trim();
    const t = String(l['假別'] || '').trim();
    if (!t) return;
    const byName = (out[d] = out[d] || {});
    (byName[nm] = byName[nm] || []).push({ type: t, hours: l['時數'] === '' || l['時數'] == null ? '' : Number(l['時數']) });
  });
  return out;
}


function handleMgrDay(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };

  const today = todayTaipeiStr(); // 與 date 分開：判斷「今天」的未配對上班卡是否算上班中（A3）
  const date = body.date || today;
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化（勿自己重寫日期正規化，沿用既有 normCellTs）
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  const approvedSheet = ss.getSheetByName('approved');
  const approvedRows = approvedSheet ? readSheetAsObjects(approvedSheet).rows : [];
  const approvedMap = buildLatestApprovedMap(approvedRows);
  // 打卡段要拿掉主管認定的重複卡；重複卡組本身用原始 events 算（重開那天才看得到原本的選項）
  const segEventRows = dropDupIgnored_(eventRows, dupIgnoreSet_(approvedMap));

  // 該日 leave 分頁的假別＋時數（姓名→[{type, hours}]）。2026-10-26 起一天可以記多種假別（一種一列）。
  // 舊欄位 leave_type／leave_hours 給只認得一種假別的呼叫端（營運系統）：取第一列。
  const leavesByName = (leaveByDateName_(ss, date)[date]) || {};

  // 該日每位員工最早一筆事件時間（有打卡者排序用；任何 status 的事件都算「有打卡」）＋
  // 未入帳嘗試次數（A4：status !== 'ok' 的事件筆數，rejected_*/pending 都算，供主管頁揭露透明度）
  const firstTs = {};
  const attemptsCount = {};
  const earlyOut = {};   // 隔天凌晨 06:00 前的成功下班卡（可能是這天跨夜班的下班卡）
  const nextDate = addDaysStr(date, 1);
  eventRows.forEach(function (e) {
    const emp = String(e.emp_id);
    const d = tsDateStr(e.ts);
    if (d === nextDate && String(e.type) === 'out' && String(e.status) === 'ok' && tsHm(e.ts) <= LONE_EARLY_OUT_HM) {
      if (!earlyOut[emp] || String(e.ts) < earlyOut[emp]) earlyOut[emp] = String(e.ts);
    }
    if (d !== date) return;
    if (!firstTs[emp] || String(e.ts) < firstTs[emp]) firstTs[emp] = String(e.ts);
    if (String(e.status) !== 'ok') attemptsCount[emp] = (attemptsCount[emp] || 0) + 1;
  });
  // 這天完全沒有卡、但隔天凌晨有一張歸到這天的孤單下班卡（晚班忘打上班卡；2026-11-10 起這張卡算前一天）：
  // 也算這天有打卡，主管頁才看得到這張卡（2026-11-11 B05；原本兩天都看不到）。歸不歸這天由 dayPunchSegments 決定。
  Object.keys(earlyOut).forEach(function (emp) {
    if (firstTs[emp]) return;
    if (dayPunchSegments(segEventRows, emp, date).segments.length) firstTs[emp] = earlyOut[emp];
  });

  // 「首次支援」標記：7A 自動加入、且從來沒有任何核定紀錄（主管核定過一次＝本店已認這個人，標記就消失）
  const everApproved = {};
  approvedRows.forEach(function (a) { everApproved[String(a.emp_id)] = true; });
  // roster 全部 active 同仁都列；名冊外但當天有事件者補最後（防禦，理論上不會發生）
  const listed = [];
  const seen = {};
  rosterRows.forEach(function (r) {
    if (String(r.active).toLowerCase() !== 'true') return;
    const emp = String(r.emp_id);
    listed.push({ emp_id: emp, name: String(r.name), rosterIdx: listed.length,
                  first_support: String(r.created_by) === FIRST_SUPPORT_CREATED_BY && !everApproved[emp] });
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

  /** 名冊裡的個人預設班別；空白就回全店預設。
   *  ⚠ '11:00' 這種字串會被 Sheets 自動轉成時間物件，讀回來是 Date——要正規化回 HH:mm，
   *    不然前端 <input type="time"> 收到 "Sat Dec 30 1899..." 會整個不顯示。 */
  function shiftOf(empId, col, fallback) {
    const r = findRosterByEmpId(rosterRows, empId);
    const v = r ? r[col] : '';
    return normShiftTime(v) || normShiftTime(fallback) || '';
  }

  const employees = listed.map(function (item) {
    const hasPunch = !!firstTs[item.emp_id];
    const punch = hasPunch ? dayPunchSegments(segEventRows, item.emp_id, date) : null;
    // 參考時數：忘刷卡整天留白，與月表／my_recent 同一規則（A3，見 dayReferenceIncomplete，禁止重寫判斷）
    const out = {
      emp_id: item.emp_id,
      name: item.name,
      segments: hasPunch ? punch.segments : [],
      reference: hasPunch ? dayReferenceHours_(punch, date, today) : null, // 沒打卡或忘刷卡整天＝參考空白
      attempts: attemptsCount[item.emp_id] || 0, // A4：未入帳嘗試次數（status!=='ok'，供主管頁透明化）
      // 名冊姓名可能帶尾端空白：leave 分頁那邊已 trim，這邊也 trim 才對得到（2026-11-04 對抗驗證）
      leaves: leavesByName[String(item.name || '').trim()] || [],
      leave_type: (leavesByName[String(item.name || '').trim()] || [])[0] ? leavesByName[String(item.name || '').trim()][0].type : '',
      leave_hours: (leavesByName[String(item.name || '').trim()] || [])[0] ? leavesByName[String(item.name || '').trim()][0].hours : '',
      // 預設上下班時間：個人（名冊 shift_in／shift_out）優先，沒填才用全店預設
      shift_in: shiftOf(item.emp_id, 'shift_in', CONFIG.DEFAULT_SHIFT_IN),
      shift_out: shiftOf(item.emp_id, 'shift_out', CONFIG.DEFAULT_SHIFT_OUT),
    };
    if (item.first_support) out.first_support = true;
    const rr = findRosterByEmpId(rosterRows, item.emp_id);
    if (rr && !String(rr.line_user_id || '').trim()) out.no_line = true;   // 沒綁 LINE（2026-11-10：考勤管理手機版 7 天內也能代開）
    if (hasPunch) {
      const dg = dupPunchGroups_(eventRows, item.emp_id, date);
      if (dg.length) out.dup_groups = dg;
    }
    const rec = (approvedMap[date] || {})[item.emp_id];
    if (rec) {
      out.approved = {
        periods: parsePeriodsStr(rec.periods),
        approved_hours: Number(rec.approved_hours) || 0,
        status_text: String(rec.status_text || ''),
        manager_name: String(rec.manager_name || ''),
        dup_ignore: dupIgnoreList_(rec.dup_ignore),
        diff_reason: String(rec.diff_reason || ''),
      };
    }
    return out;
  });

  return { ok: true, date: date, employees: employees, add_redirect: staffMasterAddRedirect_() };
}

/**
 * API：{action:'mgr_approve', mgr_key, date, emp_id, periods:[{start,end}]}
 * → 驗證格式、計算核定時數與遲到早退判定，append 到 approved 分頁（只追加不覆蓋），
 *   回傳計算結果讓主管頁立即顯示。
 * 比對規則：每個輸入時段找重疊最大的打卡段；該段無任何打卡→「該段無打卡」；
 *   打卡段多於輸入段→「有多出的打卡段」；中間有間隔的兩個輸入段配到同一條打卡段
 *   →「少刷N組卡」；早到晚走不加時數、算正常（無寬限：遲到/早退各自標記分鐘數）。
 */
/** 白名單外的假別 → 向薪酬假別表（payroll_leave_type，資料驅動的正本）即時確認（2026-08-23）。
 *  背景：LEAVE_TYPES 是寫死的送出白名單，但核定頁的下拉已改為資料驅動——只在表上加新假別、
 *  忘了同步三家店後端的白名單，主管選了就被擋成 bad_leave_type。改為白名單外自動查表放行。
 *  查不到／連不上＝照舊擋下（防呆不放水）；白名單內的常用假別完全不走這段，零額外延遲。 */
function leaveTypeAllowedByPayroll(leaveType, mgrKey) {
  // 薪資模組掛在同一個專案（光復）→ 直接查函式，不用打網路
  try {
    if (typeof payLeaveTypes === 'function') {
      return payLeaveTypes(CONFIG.PAYROLL_STORE || '').some(function (t) {
        return String(t.name).trim() === leaveType;
      });
    }
  } catch (err) { /* 掉到下面的跨後端路徑 */ }
  // 央廚／總部 → 打薪酬後端（帶主管金鑰，薪酬端會反查該店 managers 分頁驗身分）
  if (!CONFIG.PAYROLL_API) return false;
  try {
    const resp = UrlFetchApp.fetch(CONFIG.PAYROLL_API, {
      method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'payroll_leave_options', store: CONFIG.PAYROLL_STORE, mgr_key: mgrKey }),
    });
    const data = JSON.parse(resp.getContentText());
    return !!(data && data.ok && (data.types || []).some(function (t) {
      return String(t.name).trim() === leaveType;
    }));
  } catch (err) { return false; }
}

function handleMgrApprove(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  const mgr = findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  const actor = actingName_(body, mgr);
  if (actor === null) return { ok: false, error: 'bad_acting_name', message: '核定人姓名格式不對' };

  const date = String(body.date || '');
  if (!isRealDateStr_(date)) return { ok: false, error: 'bad_date' };   // 擋 2026-11-31、2026-13-01（2026-11-04 對抗驗證）

  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  const roster = findRosterByEmpId(rosterRows, body.emp_id);
  if (!roster) return { ok: false, error: 'invalid_emp_id' };

  // （2026-11-04 夜間 QA）不能核定還沒到的日子的上班時段（錢會先於出勤入帳）。整天請假（periods 空）的未來日期照收：
  //  主管可能預先記特休。跨夜班隔天凌晨核「今天」沒問題，所以用 > 今天。
  if (Array.isArray(body.periods) && body.periods.length > 0 && date > todayTaipeiStr()) {
    return { ok: false, error: 'future_date', message: '不能核定還沒到的日子的上班時段' };
  }

  // 請假註記（2026-10-26 起一天可以多種）：新版核定頁送 leaves:[{type, hours}]；
  // 舊呼叫端（營運系統的出勤核定）只送 leave_type／leave_hours＝一種。
  const multiLeave = Array.isArray(body.leaves);
  const rawLeaves = multiLeave ? body.leaves
    : [{ type: body.leave_type, hours: body.leave_hours }];
  if (rawLeaves.length > MAX_LEAVES_PER_DAY) return { ok: false, error: 'too_many_leaves', message: '一天最多記 ' + MAX_LEAVES_PER_DAY + ' 種假別' };
  const leaves = [];
  for (let i = 0; i < rawLeaves.length; i++) {
    const x = rawLeaves[i] || {};
    const t = String(x.type || '').trim();
    if (!t) continue;
    if (LEAVE_TYPES.indexOf(t) === -1 && !leaveTypeAllowedByPayroll(t, String(body.mgr_key || ''))) {
      return { ok: false, error: 'bad_leave_type' };
    }
    if (leaves.some(function (y) { return y.type === t; })) return { ok: false, error: 'dup_leave_type', message: '同一個假別選了兩次：' + t };
    // 請假時數：可留空（＝只註記假別、不記時數）；有填要是 0 以上的數字，四捨五入到 2 位。
    let h = '';
    if (x.hours !== '' && x.hours != null) {
      h = Number(x.hours);
      if (!isFinite(h) || h < 0) return { ok: false, error: 'bad_leave_hours' };
      h = Math.round(h * 100) / 100;
    }
    leaves.push({ type: t, hours: h });
  }
  // 只認得一種假別的呼叫端不能把「多種假別的那天」改成一種（會把其他假別悄悄刪掉）——擋下、請他到值班核定頁改
  //（Eason 2026-10-26 選）。
  if (!multiLeave && leaveRowsOf(ss, date, String(roster.name)).length > 1) {
    return { ok: false, error: 'multi_leave_day', message: '這天記了多種假別，請到打卡系統的值班核定頁修改' };
  }
  const hasTrip = leaves.some(function (x) { return x.type === TRIP_NOTE; });

  const rawPeriods = body.periods || [];
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(rawPeriods)) return { ok: false, error: 'bad_periods' };

  // 主管認定的重複打卡（2026-11-06）：有送 dup_ignore（陣列，可空＝取消認定）就用送來的；
  // 沒送（舊呼叫端）就沿用這天上一筆核定的認定，不洗掉。
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  const approvedSheet = ss.getSheetByName('approved');
  if (!approvedSheet) return { ok: false, error: 'approved_sheet_missing' };
  const approvedMapAll = buildLatestApprovedMap(readSheetAsObjects(approvedSheet).rows);
  const prevRec = (approvedMapAll[date] || {})[String(body.emp_id)];
  if (body.dup_ignore !== undefined && body.dup_ignore !== null && !Array.isArray(body.dup_ignore)) {
    return { ok: false, error: 'bad_dup_ignore', message: '重複打卡的選擇格式不對' };
  }
  const dupList = Array.isArray(body.dup_ignore)
    ? body.dup_ignore.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
    : (prevRec ? dupIgnoreList_(prevRec.dup_ignore) : []);
  if (Array.isArray(body.dup_ignore) && dupList.length) {
    const bad = dupIgnoreInvalid_(dupPunchGroups_(eventRows, body.emp_id, date), dupList);
    if (bad) return { ok: false, error: 'bad_dup_ignore', message: bad };
  }

  // 出差時數（2026-10-02 Eason 指定）：出差那格填幾小時就認定幾小時，與上班時段相加成核定時數。
  // ⚠ 出差在薪資假別表是 pay_ratio 1／offset_shortfall false——那格時數本身不扣款也不抵不足，
  //   所以加進核定時數不會被重複給錢。其他假別的時數仍只是註記，不進核定。
  const tripHours = leaves.reduce(function (a, x) { return a + (x.type === TRIP_NOTE && x.hours !== '' ? x.hours : 0); }, 0);

  let approvedHours, periodsStr, statusText;
  let periodsMs = [], punchMs = [];   // 核定綁申請單用（整天請假時是空的）
  if (rawPeriods.length === 0) {
    // 整天請假：沒有任何上班時段，但必須有假別；核定 0 小時、狀態標「全天請假」
    // （沒假別的空送出仍擋掉）。這樣月表那天顯示核定 0h＋假別，而非誤導的「待核定」。
    if (!leaves.length) return { ok: false, error: 'bad_periods' };
    if (hasTrip) {
      // 整天出差：核定＝出差時數。沒填時數＝當天 0 工時（正職月底會被不足倒扣），硬擋。
      if (!(tripHours > 0)) return { ok: false, error: 'trip_needs_hours' };
      approvedHours = tripHours;
      periodsStr = '';
      statusText = TRIP_NOTE;
    } else {
      approvedHours = 0;
      periodsStr = '';
      statusText = '全天請假';
    }
  } else {
    for (let i = 0; i < rawPeriods.length; i++) {
      const p = rawPeriods[i];
      if (!p || !timeRe.test(p.start) || !timeRe.test(p.end)) return { ok: false, error: 'bad_periods' };
      // 起訖一樣原本當成跨夜算 24 小時（營運系統直送沒有確認框）；同 Requests.gs reqSpanCheck_（2026-11-04 對抗驗證）
      if (p.start === p.end) return { ok: false, error: 'bad_periods', message: '上班時段 ' + p.start + '–' + p.end + ' 開始和結束一樣，請確認' };
    }
    const periods = rawPeriods.map(function (p) {
      const startMs = hmToMs(date, p.start);
      let endMs = hmToMs(date, p.end);
      if (endMs <= startMs) endMs += 24 * 3600000; // 跨夜段：end<=start 視為+1天
      return { start: p.start, end: p.end, startMs: startMs, endMs: endMs };
    });
    approvedHours = tripHours;
    periods.forEach(function (p) { approvedHours += (p.endMs - p.startMs) / 3600000; });
    approvedHours = Math.round(approvedHours * 100) / 100;

    // 其他天的認定照舊拿掉；這天這人改用這次送來的認定
    const ign = dupIgnoreSet_(approvedMapAll);
    (prevRec ? dupIgnoreList_(prevRec.dup_ignore) : []).forEach(function (ts) { delete ign[String(body.emp_id) + '|' + ts]; });
    dupList.forEach(function (ts) { ign[String(body.emp_id) + '|' + ts] = true; });
    const punch = dayPunchSegments(dropDupIgnored_(eventRows, ign), body.emp_id, date);
    const punchWithMs = punch.segments.map(function (s) {
      const outDate = s.cross ? addDaysStr(date, 1) : date;
      return {
        in: s.in, out: s.out,
        inMs: s.in ? hmToMs(date, s.in) : null,
        outMs: s.out ? hmToMs(outDate, s.out) : null,
      };
    });
    statusText = computeApprovalStatus(periods, punchWithMs,
      unresolvedAttemptCount_(eventRows, body.emp_id, date) > 0,
      hasTrip,
      noPunchBreakWindow(date));
    // 主管手動認定的遲到分鐘覆蓋系統判定（打卡沒入帳時系統算不出來）
    statusText = applyManualLate(statusText, body.late_min);
    statusText = applyDupNote_(statusText, dupList);
    periodsStr = rawPeriods.map(function (p) { return p.start + '-' + p.end; }).join(',');
    periodsMs = periods; punchMs = punchWithMs;
  }
  // 核定綁定申請單（2026-11-06）＋核定加嚴（2026-11-16 起，Requests.gs reqBindCheck_）：單對不上＝整天送不出；舊 Requests 沒有就不擋。
  // sched_day（那天班表 H／R／W）只有營運系統個人帳號代轉時才採信，由營運系統伺服器讀排班資料帶入、前端送的會被蓋掉
  if (typeof reqBindCheck_ === 'function') {
    const acting = reqMgrActing_(mgr, body);
    const bind = reqBindCheck_(ss, String(body.emp_id), date, approvedHours, periodsMs, punchMs, noPunchBreakWindow(date),
      { leaves: leaves, trip_hours: tripHours, sched_day: acting ? String(body.sched_day || '') : '', sched_spans: acting && Array.isArray(body.sched_spans) ? body.sched_spans : [], diff_reason: body.diff_reason, acting: acting,
        // 那天這位同仁「新手機待核准」的卡有幾張（2026-11-11 B35）：少卡被擋時訊息請主管先核准裝置
        pending_device: eventRows.filter(function (e) { return String(e.emp_id) === String(body.emp_id) && e.status === 'pending_device_approval' && tsDateStr(e.ts) === date; }).length });
    if (bind) return bind;
  }
  const enteredAt = nowTaipeiIso();

  empIdColText_(approvedSheet);
  appendApprovedRow_(approvedSheet, [date, body.emp_id, roster.name, periodsStr, approvedHours, statusText, actor, enteredAt],
    rawPeriods.length ? dupList : [],
    rawPeriods.length && typeof reqCleanDiffReason_ === 'function' ? reqCleanDiffReason_(body.diff_reason) : '');
  replaceLeaveRows(ss, date, String(roster.name), leaves);

  return {
    ok: true, date: date, emp_id: body.emp_id, name: roster.name,
    periods: rawPeriods, approved_hours: approvedHours, leaves: leaves,
    leave_type: leaves[0] ? leaves[0].type : '', leave_hours: leaves[0] ? leaves[0].hours : '',
    status_text: statusText, manager_name: actor, entered_at: enteredAt,
    dup_ignore: rawPeriods.length ? dupList : [],
  };
}

/** 'yyyy-MM-dd' 而且真的有這天（同 Requests.gs reqIsDate_）。 */
function isRealDateStr_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** 某人某天在 leave 分頁的列號（由上而下）。 */
function leaveRowsOf(ss, date, name) {
  const sheet = ss.getSheetByName('leave');
  if (!sheet) return [];
  return readSheetAsObjects(sheet).rows
    // 兩邊都去空白（2026-11-04 對抗驗證）：名冊姓名帶尾端空白時原本永遠對不到，重送核定請假列就越疊越多（薪資照列數加總、多扣）
    .filter(function (r) { return normCellDate(r['日期']) === date && String(r['姓名'] || '').trim() === String(name || '').trim(); })
    .map(function (r) { return r.__rowIndex; });
}

/**
 * 主管核定夾帶的請假註記寫回 leave 分頁（2026-10-26 起一天可以多種，一種一列）：
 * 同日同人既有的列全部刪掉，再照這次送出的假別一列一列加回去；送出空清單＝清掉（主管改回「無」重送）。
 * 含 Eason 手填的同日同人列——核定頁送出後以核定頁為準。leaves 每筆 {type, hours}，hours '' ＝時數欄留空。
 * 薪資（payCollect）、月表、出勤紀錄表本來就是逐列加總，同一天多列不用另外處理。
 */
function replaceLeaveRows(ss, date, name, leaves) {
  const sheet = ss.getSheetByName('leave');
  if (!sheet) return;
  const rows = leaveRowsOf(ss, date, name);
  for (let j = rows.length - 1; j >= 0; j--) sheet.deleteRow(rows[j]);   // 由下往上刪，列號不位移
  (leaves || []).forEach(function (x) { sheet.appendRow([date, name, x.type, x.hours === '' || x.hours == null ? '' : x.hours]); });
}

/* ============================================================
 * 出勤月表 — 純函式區
 * 只吃 plain object 陣列、回列陣列，不碰 SpreadsheetApp/Utilities，
 * 可直接用 node 載入本檔測試（本檔頂層無任何 GAS 呼叫）。
 * ============================================================ */

// in 配「16 小時內的下一筆 out」的配對視窗（小時）
// 2026-09-02 Eason 指定 12→16：長班（例 08:23–20:48＝12.4h）會超出 12 小時視窗，上下班
// 兩張卡被拆成孤兒卡 → 月表誤標「上班忘刷卡」、參考時數整天留白、計入異常筆數。
// 放寬前以三家店 7/1–9/2 全部 events 抽真 pairShifts 實跑比對：光復 777 筆與總部 3 筆
// 結果完全相同，央廚只多配成該長班一筆，且無任何原本配得上的段反而配不到。
// ⚠ 代價：忘打下班卡、隔天 12–16 小時內才補打的情形，會被配成一長段而非標忘刷卡
//    （歷史資料未發生過）。要再收緊改回此常數即可，不影響其他邏輯。
const MONTHLY_PAIR_WINDOW_HOURS = 16;
// 被拒的重複上班卡（rejected_duplicate 的 in）距開著的 in 達此分鐘數 → 視為忘打下班的斷點
// （見 pairShifts）。低於此門檻＝手滑連按，忽略不斷段。
const REJECTED_IN_BREAK_MIN = 60;
const REJECTED_IN_MISTAP_SEC = 120;  // 被擋的上班卡若在此秒數內就打了成功的下班卡 → 視為按錯鍵，忽略這張（不當新段起點）
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];
// 「少刷N組卡」的字首。⚠ 宣告位置不可往後搬：ABNORMAL_CATEGORIES 是頂層 const、載入當下就求值，
// 放到它後面會 TDZ ReferenceError，整支 Code.gs 起不來。語意上它跟 NO_PUNCH_NOTE 同一組，
// 那邊留了指路註解。
const MISSING_GROUP_PREFIX = '第';
// 2026-09-29 Eason 指定：原本整天只標一句「少刷N組卡」，改成逐段標「第N段下班無打卡」
// 「第N段上班無打卡」——看表的人直接知道是哪一段少了哪一張卡。字首仍沿用這個常數，
// 所以 backfill 的「已經標過了」與 statusDiffIsOnlyMissingGroup 的比對不必改。
const SEG_MISS_OUT = '段下班無打卡';
const SEG_MISS_IN = '段上班無打卡';
const SEG_NUM_ZH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function segMissNote(no, tail) { return MISSING_GROUP_PREFIX + (SEG_NUM_ZH[no] || String(no)) + tail; }
// 備註欄中屬於「異常」的字樣（列入異常筆數統計、明細標紅）；假別不算異常
// 計入月表「異常筆數」的分類。2026-08-19 Eason 定義：忘刷卡、遲到、早退、病假、事假
// （＋沿用既有的新裝置待核准）。
// ⚠ 用「開頭比對」不是完全相等，因為這些字串都帶變動的尾巴：
//   遲到5分／早退10分（分鐘數）、病假2.5h（時數，沒填時數就只有「病假」）。
// ⚠ **計數單位是「天」不是「次」**（Eason 2026-08-19 定案）：某人某天只要命中下面任一類，
//   當天就算 **1 筆**，不管當天發生幾次、也不管同時命中幾類——遲到又早退、遲到又忘刷卡、
//   一天多段各自遲到，全部都是 1 筆。分類清單在這裡的作用是「判斷這天算不算異常」，
//   不再是計數單位。
// ⚠ 「超出範圍嘗試」不在這裡（Eason 指定）：那多半是同仁人在店裡、手機定位飄掉，
//   一天連按十幾次就把數字灌爆（A 君 8/11 一天 12 次），當異常看會失真。
// ⚠ 只列病假與事假：特休假／生理假／家庭照顧假／喪假／婚假是應有的假，不算異常。
// ⚠ 「該段無打卡」「有多出的打卡段」「上班中」也不列入。
const ABNORMAL_CATEGORIES = [
  { key: '上班忘刷卡', prefixes: ['上班忘刷卡'] },
  { key: '下班忘刷卡', prefixes: ['下班忘刷卡'] },
  // 「少刷N組卡」＝中間漏刷一組上下班卡（見 computeApprovalStatus）。本質就是忘刷卡，
  // 只是 pairShifts 從打卡事件看不出來、要靠核定時段比對才抓得到，所以跟上面兩類同等對待。
  { key: '段內無打卡', prefixes: [MISSING_GROUP_PREFIX] },
  { key: '遲到早退', prefixes: ['遲到', '早退'] },
  { key: '病假', prefixes: ['病假'] },
  { key: '事假', prefixes: ['事假'] },
  { key: '新裝置待核准', prefixes: ['新裝置待核准'] },
];
// 狀態欄要標紅字的：異常那組再加「超出範圍嘗試」——看得到當天有被擋過，只是不進統計。
const HIGHLIGHT_CATEGORIES = ABNORMAL_CATEGORIES.concat([
  { key: '超出範圍嘗試', prefixes: ['超出範圍嘗試'] },
]);

/**
 * 回傳這一格（某人某天）命中的異常類別清單（同類重複只出現一次）。
 * 異常筆數只看這個清單「是不是空的」——非空＝當天算 1 筆（以天計算，見上方常數說明）；
 * 清單本身留著是為了標紅字判斷，以及日後若要細分類別時不用重寫。
 * ⚠ 主管核定帶回的狀態是「多項用『、』串成一個字串」（例：'遲到5分、早退10分'），
 *   要先拆開再逐項比對，否則整串比不到任何開頭。
 */
function abnormalCategoriesOf(notes, categories) {
  const hit = {};
  (notes || []).forEach(function (note) {
    String(note).split('、').forEach(function (part) {
      const t = part.trim();
      if (!t) return;
      categories.forEach(function (c) {
        if (c.prefixes.some(function (pre) { return t.indexOf(pre) === 0; })) hit[c.key] = true;
      });
    });
  });
  return Object.keys(hit);
}

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
    evs.forEach(function (e, i) {
      if (String(e.status) === 'rejected_duplicate') {
        // 按錯鍵：他要下班卻按到上班，被擋下後很快就改按了下班（中間可能還連按了幾次上班）。
        // 這張不是新一段的起點——忽略它，讓那張下班卡跟原本開著的上班卡配成完整一段。
        // 只在「已經有開著的上班卡」時才忽略，否則後面那張下班卡會配不到人。
        let nx = null;
        for (let j = i + 1; j < evs.length; j++) {
          if (String(evs[j].status) === 'rejected_duplicate') continue;  // 連按，繼續往後找
          nx = evs[j]; break;
        }
        if (open && nx && nx.type === 'out' && String(nx.status) === 'ok' &&
            tsMs(nx.ts) - tsMs(e.ts) <= REJECTED_IN_MISTAP_SEC * 1000) {
          return;
        }
        // 被擋的重複上班卡：距開著的 in ≥ 門檻 → 前段忘打下班（收未配對），以本卡當新段起點。
        // 未達門檻＝手滑連按，忽略（open 不變）。
        // 沒有開著的 in → 忽略（2026-11-11 B09）。原本「防禦性」拿它當新段起點，但 2026-11-02 起同一種卡只在
        // 10 分鐘內擋，被擋的重複卡前面一定有一張算數的上班卡；那張若不是成功的卡（新手機待核准後來被拒、
        // 或同一秒兩筆同時到、被擋的這筆先寫進表），拿被擋的卡當起點就會變出假的「下班忘刷卡」或假的一整段。
        if (!open) {
          return;
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

/* ── 主管認定的重複打卡（2026-11-06 Eason）──────────────────────────────
 * 10 分鐘鎖過後同一顆鍵可以再按（例：17:26 上班、17:55 又按上班、21:00 下班），
 * 系統照規則會把 17:26 當成「下班忘刷卡」。店長在考勤管理看到這組卡時可以選「以哪張為準」，
 * 沒被選的那張存進核定紀錄的 dup_ignore 欄（JSON 陣列，放打卡時間 ts），
 * 之後所有配對（打卡段、遲到早退、月表、薪資忘刷次數）都當那張不存在。
 * ‧只限同一天、同一型、相鄰（中間沒有另一型的成功卡）、間隔 DUP_PUNCH_MAX_MIN 分鐘內的成功卡。
 * ‧events 一律不改：認定只存在核定紀錄裡，核定重送就能改選或取消。
 * ‧不選＝照原本規則（算忘刷）。 */
const DUP_PUNCH_MAX_MIN = 60;
const DUP_PUNCH_NOTE = '主管認定重複打卡';

/** 核定紀錄 dup_ignore 欄 → ts 字串陣列（空白、壞掉都回 []）。 */
function dupIgnoreList_(v) {
  if (Array.isArray(v)) return v.map(function (x) { return String(normCellTs(x)); }).filter(Boolean);
  const s = String(v || '').trim();
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(function (x) { return String(x); }).filter(Boolean) : [];
  } catch (e) { return []; }
}

/** 全部核定紀錄（每天每人取最新那筆）裡被認定重複的卡 → { 'emp|ts': true }。 */
function dupIgnoreSet_(approvedMap) {
  const set = {};
  Object.keys(approvedMap || {}).forEach(function (d) {
    Object.keys(approvedMap[d] || {}).forEach(function (emp) {
      dupIgnoreList_(approvedMap[d][emp].dup_ignore).forEach(function (ts) { set[String(emp) + '|' + ts] = true; });
    });
  });
  return set;
}

/** 把被認定重複的卡從 events 拿掉（回新陣列；沒有認定就原樣回傳）。 */
function dropDupIgnored_(events, set) {
  if (!set || !Object.keys(set).length) return events;
  return events.filter(function (e) { return !set[String(e.emp_id) + '|' + String(normCellTs(e.ts))]; });
}

/**
 * 某人某天可以讓主管認定的重複卡組：[{type, cards:[{ts, hm}]}]（cards 依時間，至少 2 張）。
 * 用原始 events 算（不先拿掉已認定的），主管重開那天才看得到原本的選項。
 * 歸日：上班卡組歸第一張那天；下班卡組歸它前面最近那張成功上班卡那天（跨夜班的凌晨下班卡歸前一天），沒有就歸自己那天。
 */
function dupPunchGroups_(eventRows, empId, dateStr) {
  const lo = addDaysStr(dateStr, -1);
  const hi = addDaysStr(dateStr, 1);
  const oks = eventRows.filter(function (e) {
    const d = tsDateStr(normCellTs(e.ts));
    return String(e.emp_id) === String(empId) && String(e.status) === 'ok' &&
      (e.type === 'in' || e.type === 'out') && d >= lo && d <= hi;
  }).map(function (e) { return { ts: String(normCellTs(e.ts)), type: e.type }; })
    .sort(function (a, b) { return tsMs(a.ts) - tsMs(b.ts); });
  const groups = [];
  let cur = null;
  oks.forEach(function (e, i) {
    const prev = i > 0 ? oks[i - 1] : null;
    if (cur && prev && prev.type === e.type && tsMs(e.ts) - tsMs(prev.ts) <= DUP_PUNCH_MAX_MIN * 60000) {
      cur.cards.push(e);
    } else {
      cur = { type: e.type, cards: [e], at: i };
      groups.push(cur);
    }
  });
  return groups.filter(function (g) { return g.cards.length >= 2; }).filter(function (g) {
    let day = tsDateStr(g.cards[0].ts);
    if (g.type === 'out') {
      for (let j = g.at - 1; j >= 0; j--) {
        if (oks[j].type !== 'in') continue;
        if (tsMs(g.cards[0].ts) - tsMs(oks[j].ts) <= MONTHLY_PAIR_WINDOW_HOURS * 3600000) day = tsDateStr(oks[j].ts);
        break;
      }
    }
    return day === dateStr;
  }).map(function (g) {
    return { type: g.type, cards: g.cards.map(function (c) { return { ts: c.ts, hm: tsHm(c.ts) }; }) };
  });
}

/** 主管送來的 dup_ignore 是否合法：每張都要屬於那天的某組重複卡，而且每組至少留一張。回 null＝合法，否則回錯誤字句。 */
function dupIgnoreInvalid_(groups, list) {
  const left = {};
  groups.forEach(function (g, gi) { left[gi] = g.cards.length; });
  for (let i = 0; i < list.length; i++) {
    let gi = -1;
    groups.forEach(function (g, k) { if (g.cards.some(function (c) { return c.ts === list[i]; })) gi = k; });
    if (gi === -1) return '這天沒有 ' + tsHm(list[i]) + ' 這組重複打卡，請重新整理再選';
    left[gi]--;
    if (left[gi] < 1) return '同一組重複打卡至少要留一張';
  }
  return null;
}

/** 狀態字串補上（或換掉）「主管認定重複打卡（17:55）」；沒有認定就拿掉舊的。 */
function applyDupNote_(statusText, list) {
  const parts = String(statusText || '').split('、').filter(function (x) {
    return x && x.indexOf(DUP_PUNCH_NOTE) !== 0;
  });
  if (list && list.length) {
    const hms = list.slice().sort().map(function (ts) { return tsHm(ts); });
    if (parts.length === 1 && parts[0] === '正常') parts.length = 0;
    parts.push(DUP_PUNCH_NOTE + '（' + hms.join('／') + '）');
  }
  return parts.length ? parts.join('、') : '正常';
}

/** 寫一列核定紀錄：照實際表頭放，沒有 dup_ignore 表頭就先補在最右邊（舊試算表只有 8 欄）。 */
function appendApprovedRow_(sheet, row8, dupList, diffReason) {
  const hasDup = !!(dupList && dupList.length), reason = String(diffReason || '');
  if (!hasDup && !reason) { sheet.appendRow(row8); return; }   // 沒有認定也沒有原因＝跟以前一模一樣，不碰表頭
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const heads = (sheet.getRange(1, 1, 1, lastCol).getValues()[0] || []).map(String);
  const colOf = function (name) {
    let at = heads.indexOf(name);
    if (at === -1) {
      at = heads.length;
      while (at > 0 && !heads[at - 1]) at--;   // 跳過右邊空白表頭
      at = Math.max(at, APPROVED_HEADERS.indexOf(name));
      sheet.getRange(1, at + 1).setValue(name);
      heads[at] = name;
    }
    return at;
  };
  const row = row8.slice();
  const put = function (name, v) { const at = colOf(name); while (row.length < at) row.push(''); row[at] = v; };
  put('dup_ignore', hasDup ? JSON.stringify(dupList) : '');
  if (reason) put('diff_reason', reason);
  sheet.appendRow(row);
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
    reference += approvedHoursOfShift(s.in_ts, s.out_ts);
  });
  paired.unmatchedIns.forEach(function (e) {
    if (tsDateStr(e.ts) !== dateStr) return;
    segments.push({ sortMs: tsMs(e.ts), in: tsHm(e.ts), out: null, cross: false });
  });
  paired.unmatchedOuts.forEach(function (e) {
    // 凌晨 06:00 以前的孤單下班卡＝前一天的跨夜班（2026-11-10 Eason，同 Requests.gs REQ_EARLY_OUT_HM）
    const d = loneOutDate_(e.ts);
    if (d !== dateStr) return;
    segments.push({ sortMs: tsMs(e.ts), in: null, out: tsHm(e.ts), cross: d !== tsDateStr(e.ts) });
  });

  segments.sort(function (a, b) { return a.sortMs - b.sortMs; });
  segments.forEach(function (s) { delete s.sortMs; });
  return { segments: segments, reference: Math.round(reference * 100) / 100 };
}

/**
 * 判斷某天參考時數是否該留白（A3：與出勤月表「當天只要有任一筆忘刷卡→整天留空白」同一規則，
 * 套到 my_recent／mgr_day——抽共用 helper、禁止各自重寫判斷）。只吃已算好的 segments
 * （dayPunchSegments／buildRecentDays 產生的 {in,out,cross} 陣列，未配對一端為 null），
 * 不重新讀事件：
 *   有任一筆未配對 out（in 為 null，即「上班忘刷卡」）→ 恆不完整；
 *   有任一筆未配對 in（out 為 null，即「下班忘刷卡」）且 dateStr 不是今天 → 不完整；
 *   dateStr 是今天的未配對 in → 上班中，不算不完整（a872de4 規則，月表已如此）。
 * ⚠ 月表 buildMonthlySheet 因 segments 結構不同（{sortMs,text}）無法呼叫本函式，
 *   在 unmatchedIns/unmatchedOuts 兩段維護著同一規則的 inline 版——改這裡必同步改那裡。
 */
function dayReferenceIncomplete(segments, dateStr, todayStr) {
  const hasForgotOut = segments.some(function (s) { return s.in === null; });
  const hasForgotIn = segments.some(function (s) { return s.out === null; });
  return hasForgotOut || (hasForgotIn && dateStr !== todayStr);
}

/** mgr_day 的 reference 規則（已完成時段 15 分鐘取整加總；忘刷卡整天留白＝null）。handleMgrDay 與 att_digest_data 共用。 */
function dayReferenceHours_(punch, dateStr, todayStr) {
  return dayReferenceIncomplete(punch.segments, dateStr, todayStr) ? null : punch.reference;
}

/**
 * 比對主管輸入時段 vs 打卡段，回傳狀態字串（'正常' 或以「、」串接的異常註記）。
 * 規則（無寬限）：每個輸入時段找重疊最大的打卡段；in 晚於時段起點→「遲到X分」；
 * out 早於時段終點→「早退X分」；早到晚走不標記。該段完全找不到重疊打卡→「該段無打卡」。
 * 打卡的完整段（in+out 皆有）多於被用掉的輸入段數→再加一句「有多出的打卡段」。
 * 反向（2026-09-21 新增）：中間有間隔的兩個輸入段配到**同一條**打卡段→「少刷N組卡」。
 * @param {Array} periods [{startMs,endMs}]
 * @param {Array} punchSegments dayPunchSegments().segments 各自加上 inMs/outMs（未配對為 null）
 */
// 「核定時段對不到打卡段」有兩種成因，措辭要分開（2026-08-19 Eason 指定）：
//   1. 同仁有打，但那天的卡整批沒入帳（超出範圍／新裝置待核准）→ 不是他沒打，是系統沒收
//   2. 真的沒打（忘刷卡）→ 沿用原本的說法
// 分辨依據＝當天有沒有 status!=='ok' 的事件（與 mgr_day 的 attempts 同一口徑）。
const NO_PUNCH_NOTE = '該段無打卡';
// 「少刷N組卡」的字首 MISSING_GROUP_PREFIX 宣告在 ABNORMAL_CATEGORIES 上方（載入順序所迫，見那裡）。
const MANUAL_LATE_MARK = '(認定)';   // 主管手動填的遲到，與系統比對出來的區分
const NO_LATE_NOTE = '主管認定不計遲到';   // 系統判有遲到、但主管判定不算（填 0 觸發）
const TRIP_NOTE = '出差';   // 出差當天打不了卡，狀態標這個而不是「該段無打卡」

/** 主管手動認定的遲到分鐘，覆蓋進狀態字串（2026-09-01）。
 *
 *  為什麼需要：打卡被擋（超出範圍）或整批未入帳時，系統**沒有進場時間可以比對**，
 *  computeApprovalStatus 只會標「打卡未入帳，主管補登」——那天實際遲到幾分鐘算不出來，
 *  遲到不計薪就扣不到。主管是當場看到人幾點到的人，由他填最準。
 *
 *  刻意寫進 status_text 而不是另開欄位：payCollect 已經在解析「遲到N分」了
 *  （split('、') 後逐項比對），寫進去就自動流進薪資，歸集邏輯一行都不用改。
 *  標「(認定)」是為了讓月表看得出這筆是人工填的、不是系統比對出來的。
 *
 *  規則：手動填了就以手動為準——把系統自動判的「遲到N分」換掉，其餘註記（早退、
 *  未入帳、有多出的打卡段…）原樣保留。填 0 或留空＝不覆蓋，用系統的。
 */
function applyManualLate(statusText, lateMin) {
  const raw = String(lateMin == null ? '' : lateMin).trim();
  if (raw === '') return statusText;           // 留空＝不覆蓋，用系統自動判的
  // 2026-11-11（B21）：先取整再判斷。原本 0.4 不等於 0、又被四捨五入成「遲到0分(認定)」，月表算 1 天異常。
  const rawN = Number(raw);
  if (!isFinite(rawN) || rawN < 0) return statusText;   // 負數先擋（-0.4 取整後是 0，不可以被當成「填 0」）
  const n = Math.round(rawN);
  const kept = String(statusText || '').split('、')
    .filter(function (x) { return x && x.indexOf('遲到') !== 0; });
  if (n === 0) {
    // 填 0＝主管認定不算遲到（例：交通事故、店裡臨時交辦）。
    // 系統判的「遲到N分」被移除，那天就不會因遲到計缺勤、也不會扣遲到的錢。
    // 標一句話留痕，否則月表上看起來像系統沒抓到。
    kept.push(NO_LATE_NOTE);
  } else {
    kept.push('遲到' + n + '分' + MANUAL_LATE_MARK);
  }
  const out = kept.filter(function (x) { return x !== '正常'; });
  return out.length ? out.join('、') : '正常';
}


/** 某人某天在 leave 分頁是不是登記了出差。⚠ leave 分頁是中文欄位（日期／姓名／假別／時數）。 */
function isTripDay(ss, dateStr, name) {
  try {
    const sh = ss.getSheetByName('leave');
    if (!sh) return false;
    return readSheetAsObjects(sh).rows.some(function (l) {
      return normCellDate(l['日期']) === dateStr
          && String(l['姓名'] || '').trim() === String(name || '').trim()
          && String(l['假別'] || '').trim() === TRIP_NOTE;
    });
  } catch (e) { return false; }
}
const NOT_RECORDED_NOTE = '打卡未入帳，主管補登';

/** 某人某天「送出了但沒入帳」的打卡筆數（status!=='ok'，含超出範圍與待核准，與 mgr_day 的 attempts 同口徑）。 */
function unrecordedAttemptCount(eventRows, empId, dateStr) {
  let n = 0;
  eventRows.forEach(function (e) {
    if (String(e.emp_id) !== String(empId)) return;
    if (tsDateStr(e.ts) !== dateStr) return;
    if (String(e.status) !== 'ok') n++;
  });
  return n;
}

/**
 * 某人某天「真的沒入帳」的打卡筆數：送出了、沒成功，而且之後也沒有補成功（2026-11-11 B08）。
 * 核定狀態用這個判斷要不要寫「打卡未入帳，主管補登」。不算的兩種：
 *   連按被擋（rejected_duplicate）——前面那張同型的卡已經成功；
 *   被擋之後 10 分鐘內同一種卡重按成功（例：定位飄掉、走近一點再按一次）。
 * 原本只要當天有任何一筆沒成功的卡就整天當成「未入帳」，多按一下，遲到分鐘與忘刷就都不見了。
 * 主管頁顯示的嘗試次數仍用 unrecordedAttemptCount（每一筆都列出來）。
 */
const ATTEMPT_RETRY_OK_MS = 10 * 60000;
function unresolvedAttemptCount_(eventRows, empId, dateStr) {
  const mine = eventRows.filter(function (e) { return String(e.emp_id) === String(empId); });
  let n = 0;
  mine.forEach(function (e) {
    if (tsDateStr(e.ts) !== dateStr) return;
    const st = String(e.status);
    if (st === 'ok' || st === 'rejected_duplicate') return;
    const t = tsMs(e.ts);
    const retried = mine.some(function (x) {
      const d = tsMs(x.ts) - t;
      return String(x.status) === 'ok' && String(x.type) === String(e.type) && d > 0 && d <= ATTEMPT_RETRY_OK_MS;
    });
    if (!retried) n++;
  });
  return n;
}

/**
 * 該店「不打卡休息帶」在指定日期的毫秒區間；沒設定回 null。
 * 只給「少刷N組卡」用。呼叫端一律傳這個進 computeApprovalStatus，不要各自算。
 */
function noPunchBreakWindow(date) {
  const bs = String(CONFIG.NO_PUNCH_BREAK_START || '').trim();
  const be = String(CONFIG.NO_PUNCH_BREAK_END || '').trim();
  if (!bs || !be) return null;
  const startMs = hmToMs(date, bs);
  let endMs = hmToMs(date, be);
  if (endMs <= startMs) endMs += 24 * 3600000;   // 跨夜休息帶（目前沒有，但別讓它變成負區間）
  return { startMs: startMs, endMs: endMs };
}

/** 兩段核定之間的空檔，是不是該店那段「規定不打卡」的休息造成的（有重疊就算）。 */
function gapExplainedByBreak(gapStartMs, gapEndMs, breakWindow) {
  if (!breakWindow) return false;
  return gapStartMs < breakWindow.endMs && gapEndMs > breakWindow.startMs;
}

// 只打了一張卡的段落歸給核定時段（前後 4 小時內，同 Requests.gs REQ_BIND_NEAR_MS）。2026-11-10 Eason：整天一起找配到最多張、
// 總距離最小的配法（不再先到先配）；有的時段完全沒卡也照樣採用，那段自己標上班、下班都沒打。卡太多（>8 張）不配。
const LONE_CARD_NEAR_MS = 4 * 3600000;
const LONE_EARLY_OUT_HM = '06:00';
/** 孤單下班卡歸哪一天：凌晨 06:00 以前算前一天的跨夜班（2026-11-10 Eason；核定狀態、月表、薪資、申請單同一口徑） */
function loneOutDate_(ts) { const d = tsDateStr(ts); return tsHm(ts) <= LONE_EARLY_OUT_HM ? addDaysStr(d, -1) : d; }
const SEG_FORGOT_OUT = '段下班忘刷卡';
const SEG_FORGOT_IN = '段上班忘刷卡';
function loneCardsForPeriods_(periods, fullSegs, punchSegments) {
  const open = [];
  periods.forEach(function (p, pi) {
    if (!fullSegs.some(function (s) { return Math.min(p.endMs, s.outMs) - Math.max(p.startMs, s.inMs) > 0; })) open.push(pi);
  });
  const cards = punchSegments.filter(function (s) { return (s.inMs == null) !== (s.outMs == null); });
  if (!open.length || !cards.length || cards.length > 8) return {};
  const dist = function (c, pi) {
    const d = c.inMs != null ? Math.abs(c.inMs - periods[pi].startMs) : Math.abs(c.outMs - periods[pi].endMs);
    return d <= LONE_CARD_NEAR_MS ? d : null;
  };
  let best = {}, bestN = 0, bestD = Infinity;
  (function walk(ci, pick, n, total) {
    if (ci === cards.length) {
      if (n > bestN || (n === bestN && n > 0 && total < bestD)) { bestN = n; bestD = total; best = Object.assign({}, pick); }
      return;
    }
    walk(ci + 1, pick, n, total);
    open.forEach(function (pi) {
      if (pick[pi]) return;
      const d = dist(cards[ci], pi);
      if (d === null) return;
      pick[pi] = cards[ci];
      walk(ci + 1, pick, n + 1, total + d);
      delete pick[pi];
    });
  })(0, {}, 0, 0);
  return best;
}

/**
 * 核定時段依「規定不打卡的休息帶」（央廚 12–13、總部 14–15）分塊，回傳依時間排序的
 * [{ startMs, endMs, firstNo, lastNo }]（段號＝原始時段依時間先後的序號）。沒有休息帶＝每段自己一塊。
 * 2026-11-10 起，休息帶隔開的兩段併成一塊（否則照規定不打午休卡的人，漏一張卡會寫成三張）。
 * 2026-11-11（B01）：併成一塊以後只會拿一條打卡段去比，午休照樣打卡的人四張卡準時也變成
 * 「早退300分、有多出的打卡段」。所以只在「併了才講得通」的時候併：
 *   ① 那一塊裡只要有一段配得到完整打卡段，就拆回各段自己比（2026-11-10 以前的比法；
 *      一長段跨過休息帶的人，兩段都配到同一條、空檔由休息帶解釋，結果和併起來一樣）。
 *   ② 整塊都沒有完整打卡段（只有單張卡或完全沒卡）：併與不併各算配得到幾張單張卡，
 *      不併配得到比較多張（休息帶前後有打卡）才拆；一樣多照舊併（只漏一張卡＝只寫一張）。
 * computeApprovalStatus 與 Requests.gs reqBindMissCards_ 共用，狀態寫的忘刷張數和要補的單才會一致。
 */
function breakBlocksFor_(periods, punchSegments, breakWindow) {
  const sorted = periods.slice().sort(function (a, b) { return a.startMs - b.startMs; });
  const mk = function (p, k) { return { startMs: p.startMs, endMs: p.endMs, firstNo: k + 1, lastNo: k + 1 }; };
  const plain = sorted.map(mk);
  if (!breakWindow) return plain;
  const merged = sorted.reduce(function (acc, p, k) {
    const last = acc[acc.length - 1];
    if (last && p.startMs > last.endMs && gapExplainedByBreak(last.endMs, p.startMs, breakWindow)) {
      last.endMs = Math.max(last.endMs, p.endMs); last.lastNo = k + 1;
    } else acc.push(mk(p, k));
    return acc;
  }, []);
  if (merged.length === plain.length) return plain;   // 沒有被休息帶隔開的時段
  const fullSegs = punchSegments.filter(function (s) { return s.inMs != null && s.outMs != null; });
  const hasFull = function (b) {
    return fullSegs.some(function (s) { return Math.min(b.endMs, s.outMs) - Math.max(b.startMs, s.inMs) > 0; });
  };
  // ① 有完整打卡段的那一塊拆回各段
  const blocks = [];
  merged.forEach(function (b) {
    const parts = sorted.slice(b.firstNo - 1, b.lastNo).map(function (p, i) { return mk(p, b.firstNo - 1 + i); });
    if (parts.length > 1 && parts.some(hasFull)) parts.forEach(function (x) { blocks.push(x); });
    else blocks.push(b);
  });
  if (blocks.length === plain.length) return plain;
  // ② 剩下還併著的：不併配得到比較多張單張卡才拆
  const loneUsed = function (bs) { return Object.keys(loneCardsForPeriods_(bs, fullSegs, punchSegments)).length; };
  return loneUsed(plain) > loneUsed(blocks) ? plain : blocks;
}

function computeApprovalStatus(periods, punchSegments, hadUnrecordedAttempts, isTrip, breakWindow) {
  const fullSegs = punchSegments.filter(function (s) { return s.inMs != null && s.outMs != null; });
  const legacy = !!(isTrip || hadUnrecordedAttempts);   // 出差、打卡未入帳：照舊標示，不冤枉人
  // 段號照店長輸入的核定時段（依時間先後）；規定不打卡的休息帶（央廚）隔開的兩段併成一塊，和補單張數一致
  //（2026-11-10；否則漏一張卡會寫成三張）。併起來的那塊：上班卡用第一段的段號、下班卡用最後一段的段號。
  // 午休照樣打卡的同仁不併、各段自己比（2026-11-11 B01，判斷在 breakBlocksFor_）。
  const sortedP = periods.slice().sort(function (a, b) { return a.startMs - b.startMs; });
  const multiOrig = sortedP.length > 1;
  const blocks = breakBlocksFor_(sortedP, punchSegments, legacy ? null : breakWindow);
  if (!legacy && breakWindow) periods = blocks;
  const lone = legacy ? {} : loneCardsForPeriods_(periods, fullSegs, punchSegments);
  const multi = periods.length > 1 && multiOrig;
  const anyCard = punchSegments.length > 0;
  const inNo = [], outNo = [];
  periods.forEach(function (p, pi) {
    const b = blocks.filter(function (x) { return x.startMs <= p.startMs && x.endMs >= p.endMs; })[0];
    inNo[pi] = b ? b.firstNo : pi + 1; outNo[pi] = b ? b.lastNo : pi + 1;
  });
  const notes = [];
  const add = function (n) { if (notes.indexOf(n) === -1) notes.push(n); };
  const usedIdx = {};
  const matchedIdx = [];   // 核定時段 index → 配到的完整打卡段 index（≥0 有證據；<0 沒有，供下方逐段檢查）

  periods.forEach(function (p, pi) {
    let bestIdx = -1;
    let bestOverlap = 0;
    fullSegs.forEach(function (seg, i) {
      const overlap = Math.min(p.endMs, seg.outMs) - Math.max(p.startMs, seg.inMs);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIdx = i; }
    });
    matchedIdx[pi] = bestIdx;
    if (bestIdx === -1 && lone[pi]) {
      // 只打了一張卡（2026-11-10）：只標真正漏的那張；有的那張照樣算遲到或早退；多段時寫段號
      matchedIdx[pi] = fullSegs.length + pi;
      const c = lone[pi];
      if (c.outMs == null) {
        if (c.inMs > p.startMs) notes.push('遲到' + Math.round((c.inMs - p.startMs) / 60000) + '分');
        add(multi ? segMissNote(outNo[pi], SEG_FORGOT_OUT) : '下班忘刷卡');
      } else {
        if (c.outMs < p.endMs) notes.push('早退' + Math.round((p.endMs - c.outMs) / 60000) + '分');
        add(multi ? segMissNote(inNo[pi], SEG_FORGOT_IN) : '上班忘刷卡');
      }
      return;
    }
    if (bestIdx === -1 && !legacy && multi && anyCard) {
      // 這天別的時段有打卡、這段整段沒打（2026-11-10）：標這一段的上班、下班，不再寫成前一段沒下班
      matchedIdx[pi] = -2 - pi;
      add(segMissNote(inNo[pi], SEG_MISS_IN));
      add(segMissNote(outNo[pi], SEG_MISS_OUT));
      return;
    }
    if (bestIdx === -1) {
      // ⚠ 出差當天本來就打不了卡（人不在店裡），標「該段無打卡」會被當成忘刷卡去扣全勤，
      //    所以改標「出差」——時數照算、工資照給，只是提醒看表的人這天不在店。
      add(isTrip ? TRIP_NOTE : (hadUnrecordedAttempts ? NOT_RECORDED_NOTE : NO_PUNCH_NOTE));
      return;
    }
    usedIdx[bestIdx] = true;
    const seg = fullSegs[bestIdx];
    if (seg.inMs > p.startMs) notes.push('遲到' + Math.round((seg.inMs - p.startMs) / 60000) + '分');
    if (seg.outMs < p.endMs) notes.push('早退' + Math.round((p.endMs - seg.outMs) / 60000) + '分');
  });

  // 「第N段下班無打卡／第N段上班無打卡」（2026-09-29 Eason 指定）：兩段之間有無法用休息帶解釋的空檔、
  // 卻配到同一條完整打卡段＝中間休息的下班卡、上班卡都沒打。間隔＝0（拆段核定）不算。
  // 有一邊沒證據時，那一段自己已經標了（2026-11-10 起不再補標前一段沒下班）。
  const ordered = periods.map(function (p, i) { return { p: p, idx: matchedIdx[i] }; })
    .sort(function (a, b) { return a.p.startMs - b.p.startMs; });
  let maxEnd = null;
  let prevIdx = -1;
  let prevNo = 0;
  ordered.forEach(function (o) {
    const pi = periods.indexOf(o.p);
    if (maxEnd === null) { maxEnd = o.p.endMs; prevIdx = o.idx; prevNo = outNo[pi]; return; }
    if (o.p.startMs > maxEnd && !gapExplainedByBreak(maxEnd, o.p.startMs, breakWindow)
        && prevIdx >= 0 && o.idx >= 0 && o.idx === prevIdx) {
      add(segMissNote(prevNo, SEG_MISS_OUT));
      add(segMissNote(inNo[pi], SEG_MISS_IN));
    }
    if (o.p.endMs > maxEnd) maxEnd = o.p.endMs;
    prevIdx = o.idx;
    prevNo = outNo[pi];
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
    // >=：同一秒內兩筆（主管連按、營運系統連送更正）取後寫的那列（2026-11-04 對抗驗證；原本 > 會留住先寫的那筆）
    if (!existing || normCellTs(r.entered_at) >= normCellTs(existing.entered_at)) {
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
  events = dropDupIgnored_(events, dupIgnoreSet_(approvedMap));   // 主管認定的重複卡不配對、不算忘刷（2026-11-06）
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
    c.hours += approvedHoursOfShift(s.in_ts, s.out_ts);
    c.hasComplete = true;
  });

  // ⚠ 下面兩段的 incomplete 判斷＝dayReferenceIncomplete() 的 inline 版（segments 結構不同
  // 無法共用）——改任一邊要同步改另一邊，含「今天未配對 in＝上班中不算忘刷卡」例外。
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
    const d = loneOutDate_(e.ts);
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
    // ⚠ 異常筆數要連主管核定帶回的狀態（遲到X分／早退X分）一起算。
    //   那段字**不在** c.notes 裡——c.notes 只有打卡與請假產生的註記，核定狀態是
    //   下面渲染明細列時才併進去顯示的，只數 c.notes 會漏掉遲到早退（2026-08-19 實測抓到）。
    const rec = (approvedMap[c.date] || {})[c.emp_id];
    const notesForCount = rec && rec.status_text ? c.notes.concat([String(rec.status_text)]) : c.notes;
    // 以天計算：這一格＝某人某天，命中任何一類就 +1，命中幾類、幾次都一樣
    if (abnormalCategoriesOf(notesForCount, ABNORMAL_CATEGORIES).length > 0) s.abnormal++;
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
  // 明細列的座標簿：{row, date, name}，給 rebuildMonth 依 (日期,姓名) 把人工備註放回第 7 欄。
  // 用 (日期,姓名) 當 key 而不是列號，所以名冊增減、月份天數不同都不會錯位。
  const detailRows = [];
  let detailHeaderRow = 0;

  rows.push(['姓名', '參考時數', '核定時數', '異常筆數', '請假天數', '請假時數']);
  boldRows.push(1);

  activeRoster.forEach(function (r) {
    const emp = String(r.emp_id);
    const s = empStats[emp] || { total: 0, abnormal: 0 };
    const leaveCount = Object.keys(leaveDates[emp] || {}).length;
    const leaveHoursSum = leaveHoursByEmp[emp] ? Math.round(leaveHoursByEmp[emp] * 100) / 100 : '';
    rows.push([String(r.name), Math.round(s.total * 100) / 100, roundApproved(approvedTotalByEmp[emp] || 0), s.abnormal, leaveCount, leaveHoursSum]);
  });

  rows.push(['', '', '', '', '', '']);
  rows.push(['日期', '星期', '班段', '參考時數', '核定時數', '狀態']);
  boldRows.push(rows.length);
  detailHeaderRow = rows.length;

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
      const hours = complete ? Math.round(c.hours * 100) / 100 : ''; // 0.25 刻度要兩位小數，一位會把 7.25 顯示成 7.3
      // 核定時數：改讀 approved 分頁最新一筆，主管沒輸入就顯示「待核定」
      const approvedRec = (approvedMap[c.date] || {})[emp];
      const approvedDisplay = approvedRec ? roundApproved(approvedRec.approved_hours) : '待核定';
      // 狀態：既有忘刷卡/新裝置/超出範圍/請假註記＋主管核定帶回的遲到/早退（或「正常」）
      const statusNotes = c.notes.slice();
      if (approvedRec && approvedRec.status_text) statusNotes.push(String(approvedRec.status_text));
      // 2026-11-13 驗收 F9：同一句（例：打卡比對的「下班忘刷卡」＋核定帶回的「下班忘刷卡」）只留一次，順序不變。
      for (let i = statusNotes.length - 1; i > 0; i--) if (statusNotes.indexOf(statusNotes[i]) < i) statusNotes.splice(i, 1);
      rows.push([c.date, WEEKDAY_ZH[wd], seg, hours, approvedDisplay, statusNotes.join('、')]);
      const rowNo = rows.length;
      detailRows.push({ row: rowNo, date: c.date, name: empName[emp] || emp });
      if (wd === 0 || wd === 6) weekendRows.push(rowNo);
      // 用 statusNotes（已含核定狀態）而不是 c.notes，跟異常筆數看同一份資料：
      // 遲到/早退既然算異常，那一列就該標紅，不然數字對得起來、眼睛找不到。
      if (abnormalCategoriesOf(statusNotes, HIGHLIGHT_CATEGORIES).length > 0) abnormalNoteRows.push(rowNo);
    });

    const s = empStats[emp] || { total: 0 };
    rows.push(['小計', '', '', Math.round(s.total * 100) / 100, roundApproved(approvedTotalByEmp[emp] || 0), '']);
  });

  return {
    rows: rows,
    boldRows: boldRows,
    weekendRows: weekendRows,
    abnormalNoteRows: abnormalNoteRows,
    detailRows: detailRows,
    detailHeaderRow: detailHeaderRow,
  };
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

/**
 * 從「上一版」月表分頁把第 7 欄的人工備註撈出來，回傳 [{date, name, note}]。
 * 月表沒有「這列是誰的」欄位，靠由上而下掃描還原：先等到明細表頭（A 欄＝「日期」）才開始，
 * 之後 A 欄是日期＝明細列（歸給目前的姓名區塊）、A 欄是其他非空字串＝新的姓名標題列。
 * 彙總區（表頭之前）與「小計」列一律略過——備註只認明細列。
 * ⚠ A 欄日期被 Sheets 存成 Date 物件，一律過 normCellDate，不可直接 String()。
 */
function harvestMonthNotes(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  const vals = sheet.getRange(1, 1, lastRow, MONTH_NOTE_COL).getValues();
  const out = [];
  let curName = '';
  let inDetail = false;
  for (let i = 0; i < vals.length; i++) {
    const raw = vals[i][0];
    const a = raw instanceof Date ? normCellDate(raw) : String(raw == null ? '' : raw).trim();
    if (!inDetail) {
      if (a === '日期') inDetail = true; // 明細表頭，下一列起才是明細
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(a)) {
      const note = String(vals[i][MONTH_NOTE_COL - 1] == null ? '' : vals[i][MONTH_NOTE_COL - 1]).trim();
      if (note && curName) out.push({ date: a, name: curName, note: note });
      continue;
    }
    if (a && a !== '小計') curName = a; // 姓名標題列
  }
  return out;
}

/**
 * 把撈到的人工備註寫進 notes 分頁（同一天同一人只留一列，內容有變才改；新的追加）。
 * 這裡是「只增不減」——月表上被清空的格子不會回頭刪 notes 分頁的舊備註，
 * 要刪備註請直接在 notes 分頁刪那一列（月表上清掉再重算會被正本蓋回來）。
 */
function upsertMonthNotes(ss, harvested) {
  if (!harvested || !harvested.length) return;
  let sheet = ss.getSheetByName('notes');
  if (!sheet) {
    sheet = ss.insertSheet('notes');
    sheet.getRange(1, 1, 1, NOTES_HEADERS.length).setValues([NOTES_HEADERS]);
  }
  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, NOTES_HEADERS.length).getValues() : [];
  const rowOf = {};
  existing.forEach(function (r, i) {
    rowOf[normCellDate(r[0]) + '||' + String(r[1] == null ? '' : r[1]).trim()] = i + 2;
  });
  const appends = [];
  const queued = {};
  harvested.forEach(function (h) {
    const k = h.date + '||' + h.name;
    const rowNo = rowOf[k];
    if (rowNo) {
      const old = String(existing[rowNo - 2][2] == null ? '' : existing[rowNo - 2][2]).trim();
      if (old !== h.note) sheet.getRange(rowNo, 3).setValue(h.note);
    } else if (!queued[k]) {
      queued[k] = true;
      appends.push([h.date, h.name, h.note]);
    }
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, NOTES_HEADERS.length).setValues(appends);
  }
}

/** notes 分頁 → { 'yyyy-MM-dd||姓名': 備註 }。同 key 有多列時以最後一列為準。 */
function readMonthNotesMap(ss) {
  const sheet = ss.getSheetByName('notes');
  if (!sheet) return {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const vals = sheet.getRange(2, 1, lastRow - 1, NOTES_HEADERS.length).getValues();
  const map = {};
  vals.forEach(function (r) {
    const d = normCellDate(r[0]); // ⚠ Sheets 會把純日期字串轉成 Date 物件
    const n = String(r[1] == null ? '' : r[1]).trim();
    const note = String(r[2] == null ? '' : r[2]).trim();
    if (d && n) map[d + '||' + n] = note;
  });
  return map;
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
          // 主管認定的重複打卡（2026-11-06）：要一起帶，buildMonthlySheet 才能把被認定的那張卡拿掉再配對。
          // 2026-11-10 驗收查到這裡原本沒帶，月表照樣把那張卡配成「下班忘刷卡」、異常天數多 1。
          dup_ignore: r.dup_ignore,
        };
      })
    : [];

  const built = buildMonthlySheet(ym, roster, events, leaves, todayTaipeiStr(), approvedRecords);

  let sheet = ss.getSheetByName(ym);
  if (!sheet) sheet = ss.insertSheet(ym);

  // ⚠ 順序不能動：sheet.clear() 會把整張表（含第 7 欄手打的備註）清光，
  //    所以一定要先把上一版的人工備註收進 notes 分頁，再清、再依 (日期,姓名) 放回去。
  //    這裡刻意不 try/catch——收集失敗就讓整個重算失敗（月表停在舊狀態、備註還在），
  //    比「吞掉例外照樣清空」安全，手打的字沒有第二份。
  upsertMonthNotes(ss, harvestMonthNotes(sheet));
  const notesMap = readMonthNotesMap(ss);

  sheet.clear();

  if (built.rows.length > 0) {
    sheet.getRange(1, 1, built.rows.length, 6).setValues(built.rows);
    built.boldRows.forEach(function (r) { sheet.getRange(r, 1, 1, 6).setFontWeight('bold'); });
    built.weekendRows.forEach(function (r) { sheet.getRange(r, 1, 1, 6).setBackground('#f3f3f3'); });
    built.abnormalNoteRows.forEach(function (r) { sheet.getRange(r, 6).setFontColor('#cc0000'); });
    sheet.setFrozenRows(1);

    // 第 7 欄：人工備註（表頭＋依 (日期,姓名) 對回來的內容）
    if (built.detailHeaderRow) {
      sheet.getRange(built.detailHeaderRow, MONTH_NOTE_COL).setValue(MONTH_NOTE_HEADER).setFontWeight('bold');
    }
    if (built.detailRows.length > 0) {
      const first = built.detailRows[0].row;
      const last = built.detailRows[built.detailRows.length - 1].row;
      const col = [];
      for (let r = first; r <= last; r++) col.push(['']);
      built.detailRows.forEach(function (d) {
        const note = notesMap[d.date + '||' + d.name];
        if (note) col[d.row - first][0] = note;
      });
      sheet.getRange(first, MONTH_NOTE_COL, col.length, 1).setValues(col); // 一次寫整段，不逐格 setValue
      sheet.setColumnWidth(MONTH_NOTE_COL, 220);
    }
  }
  return built.rows.length;
}

// recheckPendingApprovalStatuses 往回檢查的天數（今天不算，從昨天起算）。
// 3 天：涵蓋週五核定週六才打完卡、連假等情境；比對成本低（只掃 approved 分頁近期列），不必貪多。
// 2026-08-19 由 3 天放寬到 40 天（Eason 指定「回頭看」）。原本 3 天只涵蓋「週五核定、
// 週六才打完卡」這種短情境，同仁隔比較久才補打卡就永遠修不到了。
// 成本很低：讀 approved／events／roster 是一次性的，跟天數無關；迴圈只在「那天真的有
// 『該段無打卡』的核定紀錄」時才進到重算，多掃的日期絕大多數直接跳過。
// 取 40 與 RECENT_DAYS_WINDOW 一致，也蓋得住「當月＋上月月表凍結前」的範圍。
// ⚠ 這只修「後來補打卡了、狀態卻停在舊快照」的情況；打卡根本沒進系統的日子（例如整批被判
//   超出範圍），重算結果還是「該段無打卡」，不會變——那要另外處理措辭，不是這裡的事。
const RECHECK_STATUS_DAYS = 40;
// 補寫的核定紀錄用這個字樣標示「系統自動重算」，跟主管手動核定的紀錄分開看得出來。
const RECHECK_MARK = '（系統重算）';

/**
 * 核定時若下班段還沒打卡（開著的 in、out 為 null），這段不算「完整段」，主管核定當下比對
 * 不到就會誤判「該段無打卡」——核定時數本身是主管輸入時段直接算的，不受影響，但狀態文字
 * 是錯的，且核定是一次性快照，之後同仁補打卡也不會自動回頭修正（見 2026-07-19 C 君案例）。
 * 此函式用「當下最新」打卡資料，重新比對近 RECHECK_STATUS_DAYS 天內狀態含「該段無打卡」
 * （或「打卡未入帳」「少刷N組卡」）的核定紀錄；比對得到（新狀態≠舊狀態）就補一筆狀態修正過的核定紀錄——沿用 approved 分頁
 * append-only、同 (date,emp_id) 取 entered_at 最新為準的既有設計，periods／approved_hours
 * 原封不動照抄，只換 status_text，manager_name 加註記、entered_at 設為現在。
 * 由 dailyMonthlyRebuild（05:00 觸發器）呼叫；也開放 recheck_approvals 管理 API 供手動驗證。
 */
/**
 * 單筆核定紀錄的重算（2026-09-21 從 recheckPendingApprovalStatuses 抽出，行為不變）。
 * recheckPendingApprovalStatuses 與 backfillMissingPunchGroups 共用，禁止各自重寫判斷。
 * 回 { skip:'no_periods' } ＝這筆不該動；回 { name, newStatusText, manual_late } ＝算得出新狀態
 * （manual_late＝原狀態有主管認定的遲到，已原樣保留在新狀態裡；2026-11-11 以前這種日子回 skip:'manual_late'）
 * （newStatusText 可能與原本相同，由呼叫端決定要不要寫）。
 */
function recomputeApprovalStatusOf(ss, eventRows, rosterRows, date, empId, rec) {
  const rawPeriods = parsePeriodsStr(rec.periods);
  if (!rawPeriods.length) return { skip: 'no_periods' }; // 整天請假無時段，跳過

  const periods = rawPeriods.map(function (p) {
    const startMs = hmToMs(date, p.start);
    let endMs = hmToMs(date, p.end);
    if (endMs <= startMs) endMs += 24 * 3600000; // 跨夜段：end<=start 視為+1天（與 handleMgrApprove 同規則）
    return { start: p.start, end: p.end, startMs: startMs, endMs: endMs };
  });
  const punch = dayPunchSegments(eventRows, empId, date);
  const punchWithMs = punch.segments.map(function (s) {
    const outDate = s.cross ? addDaysStr(date, 1) : date;
    return {
      in: s.in, out: s.out,
      inMs: s.in ? hmToMs(date, s.in) : null,
      outMs: s.out ? hmToMs(outDate, s.out) : null,
    };
  });
  // 名冊的名字優先（有人改過名時 approved 上是舊名），查不到才退回 approved 那筆的 name。
  const rosterNow = findRosterByEmpId(rosterRows, empId);
  // ⚠ 主管手動認定的遲到不能被重算洗掉。2026-11-11（B06）以前是「原狀態帶認定就整筆跳過」，
  //   結果主管核定後同仁才補打的下班卡，永遠不會讓「下班忘刷卡」消失。現在重算打卡比對的部分，
  //   再把主管認定的那一項（遲到N分(認定)／主管認定不計遲到）原樣放回去，系統算的遲到照舊被它取代。
  const st0 = String(rec.status_text || '');
  const manualNote = st0.split('、').filter(function (x) { return x.indexOf(MANUAL_LATE_MARK) !== -1 || x === NO_LATE_NOTE; })[0] || '';
  let st = computeApprovalStatus(periods, punchWithMs,
    unresolvedAttemptCount_(eventRows, empId, date) > 0,
    isTripDay(ss, date, rosterNow ? rosterNow.name : rec.name),
    noPunchBreakWindow(date));
  if (manualNote) {
    const kept = st.split('、').filter(function (x) { return x && x !== '正常' && x.indexOf('遲到') !== 0; });
    kept.push(manualNote);
    st = kept.join('、');
  }
  return {
    name: rosterNow ? rosterNow.name : rec.name,
    newStatusText: applyDupNote_(st, dupIgnoreList_(rec.dup_ignore)),
    manual_late: !!manualNote,   // 回填工具用：主管認定過的日子不自動改
  };
}

function recheckPendingApprovalStatuses() {
  const ss = getSS();
  const approvedSheet = ss.getSheetByName('approved');
  if (!approvedSheet) return { checked: 0, fixed: 0 };

  const approvedMap = buildLatestApprovedMap(readSheetAsObjects(approvedSheet).rows);
  const today = todayTaipeiStr();
  const dates = [];
  for (let i = 1; i <= RECHECK_STATUS_DAYS; i++) dates.push(addDaysStr(today, -i));

  // 主管認定的重複卡先拿掉（2026-11-06），重算才不會又把它當忘刷
  const eventRows = dropDupIgnored_(readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; }),
    dupIgnoreSet_(approvedMap));
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;

  let checked = 0;
  let fixed = 0;
  dates.forEach(function (date) {
    const dayMap = approvedMap[date];
    if (!dayMap) return;
    Object.keys(dayMap).forEach(function (empId) {
      const rec = dayMap[empId];
      const statusText = String(rec.status_text || '');
      // 三種措辭都要納入：待核准裝置事後被核准 → 卡會翻成 ok → 那天就真的比對得到了
      // （「少刷N組卡」同理：中間那組卡事後入帳，長段會被拆開，少刷就該自動消失）
      if (statusText.indexOf(NO_PUNCH_NOTE) === -1 && statusText.indexOf(NOT_RECORDED_NOTE) === -1 &&
          statusText.indexOf(MISSING_GROUP_PREFIX) === -1 && statusText.indexOf('忘刷卡') === -1) return;
      const r = recomputeApprovalStatusOf(ss, eventRows, rosterRows, date, empId, rec);
      if (r.skip === 'no_periods') return;
      checked++;
      if (r.skip) return;
      if (r.newStatusText === statusText) return; // 還是沒打卡，維持原樣，下次再檢查

      empIdColText_(approvedSheet);
      appendApprovedRow_(approvedSheet, [
        date, empId, r.name, rec.periods, rec.approved_hours,
        r.newStatusText, String(rec.manager_name || '') + RECHECK_MARK, nowTaipeiIso(),
      ], dupIgnoreList_(rec.dup_ignore), String(rec.diff_reason || ''));   // 主管填的差異原因要帶到新列
      fixed++;
    });
  });
  return { checked: checked, fixed: fixed };
}

// 一次性回填的最大天數區間（防呆：手滑打成 2020 年不會把整份 approved 掃爆）
const BACKFILL_MAX_DAYS = 366;

/**
 * 判斷「重算前後的差別，是不是只多了少刷N組卡」。
 * 回填只接受這種差別——其餘（例如遲到分鐘數也跟著變）一律不寫，列進 skipped 讓人自己看。
 * 這是刻意保守：回填的目的是補上新規則抓到的少刷，不是趁機把舊狀態整批改掉。
 */
function statusDiffIsOnlyMissingGroup(oldText, newText) {
  function strip(t) {
    const kept = String(t || '').split('、').filter(function (x) {
      return x && x !== '正常' && x.indexOf(MISSING_GROUP_PREFIX) !== 0;
    });
    return kept.length ? kept.join('、') : '正常';
  }
  const added = String(newText || '').split('、').some(function (x) {
    return x.indexOf(MISSING_GROUP_PREFIX) === 0;
  });
  return added && strip(newText) === strip(oldText);
}

/**
 * 一次性回填「少刷N組卡」（2026-09-21 新增）。
 *
 * 為什麼需要：computeApprovalStatus 的反向檢查只在「主管按下核定的當下」跑，所以新規則
 * 只對**之後**的核定生效。已經核定完的日子（例如金山一位同仁 9/21，狀態停在「遲到2分、早退1分」）
 * 不會自己變，而 recheckPendingApprovalStatuses 的前置篩選只看三種措辭，也篩不到它們。
 * 9 月薪資要發，全勤的忘刷次數就會少算——所以需要一支把歷史補回來的。
 *
 * 刻意**不**掛進每日 05:00 觸發器：那會在發薪前無聲地整批改寫狀態。這支只給人工跑一次。
 *
 * 保守的地方（三道）：
 *   1. 只掃「核定時段 ≥2 段」且「狀態還沒有少刷字樣」的紀錄——其餘直接跳過，掃得很快。
 *   2. 重算後只接受「差別僅是多了少刷N組卡」的（statusDiffIsOnlyMissingGroup），
 *      其他變化列進 skipped 不寫，不趁機改到遲到／早退。
 *   3. **預設 dry-run**：apply 不是 true 就只回報要改什麼，一列都不寫。
 *
 * 寫入方式與 recheckPendingApprovalStatuses 完全相同（append-only、periods／approved_hours
 * 原封不動、manager_name 加「（系統重算）」），所以看得出來是系統補的、也留得住原紀錄。
 *
 * @param {string} fromDate 'yyyy-MM-dd'
 * @param {string} toDate   'yyyy-MM-dd'（含當天）
 * @param {boolean} apply   true 才真的寫入；其餘一律 dry-run
 */
function backfillMissingPunchGroups(fromDate, toDate, apply) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) {
    return { ok: false, error: 'bad_date' };
  }
  if (String(toDate) < String(fromDate)) return { ok: false, error: 'bad_range' };
  const span = Math.round((new Date(toDate + 'T00:00:00Z').getTime()
                         - new Date(fromDate + 'T00:00:00Z').getTime()) / 86400000) + 1;
  if (span > BACKFILL_MAX_DAYS) return { ok: false, error: 'range_too_wide', max_days: BACKFILL_MAX_DAYS };

  const ss = getSS();
  const approvedSheet = ss.getSheetByName('approved');
  if (!approvedSheet) return { ok: false, error: 'no_approved_sheet' };

  const approvedMap = buildLatestApprovedMap(readSheetAsObjects(approvedSheet).rows);
  // 主管認定的重複卡先拿掉（2026-11-06），重算才不會又把它當忘刷
  const eventRows = dropDupIgnored_(readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; }),
    dupIgnoreSet_(approvedMap));
  const rosterRows = readSheetAsObjects(ss.getSheetByName('roster')).rows;

  const hits = [];
  const skipped = [];
  let scanned = 0;

  for (let d = String(fromDate); d <= String(toDate); d = addDaysStr(d, 1)) {
    const dayMap = approvedMap[d];
    if (!dayMap) continue;
    const date = d;
    Object.keys(dayMap).forEach(function (empId) {
      const rec = dayMap[empId];
      const statusText = String(rec.status_text || '');
      if (statusText.indexOf(MISSING_GROUP_PREFIX) !== -1) return;   // 已經標過了
      if (parsePeriodsStr(rec.periods).length < 2) return;           // 單段班不可能少刷一整組
      scanned++;

      const r = recomputeApprovalStatusOf(ss, eventRows, rosterRows, date, empId, rec);
      if (r.skip) return;
      if (r.manual_late) {   // 回填只補「少刷」字樣，主管認定過的日子照舊不自動改
        skipped.push({ date: date, emp_id: empId, name: rec.name, from: statusText, reason: '主管手動認定，不自動改' });
        return;
      }
      if (r.newStatusText === statusText) return;                    // 沒變，本來就對
      if (!statusDiffIsOnlyMissingGroup(statusText, r.newStatusText)) {
        skipped.push({ date: date, emp_id: empId, name: r.name, from: statusText, to: r.newStatusText,
                       reason: '不只少刷有變，請人工確認' });
        return;
      }
      hits.push({ date: date, emp_id: empId, name: r.name, from: statusText, to: r.newStatusText,
                  periods: String(rec.periods || ''), hours: rec.approved_hours });
      if (apply === true) {
        empIdColText_(approvedSheet);
        appendApprovedRow_(approvedSheet, [
          date, empId, r.name, rec.periods, rec.approved_hours,
          r.newStatusText, String(rec.manager_name || '') + RECHECK_MARK, nowTaipeiIso(),
        ], dupIgnoreList_(rec.dup_ignore), String(rec.diff_reason || ''));
      }
    });
  }

  return { ok: true, from: String(fromDate), to: String(toDate), applied: apply === true,
           scanned: scanned, fixed: hits.length, hits: hits, skipped: skipped };
}

/**
 * API：{action:'backfill_missing_groups', admin_key, from, to, apply?}
 * 一次性回填「少刷N組卡」。**預設 dry-run**——要真的寫入必須明確帶 apply:true。
 * 先不帶 apply 跑一次看 hits 對不對，再帶 apply:true 跑第二次。
 */
function handleBackfillMissingGroups(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return backfillMissingPunchGroups(body.from, body.to, body.apply === true);
}

/**
 * 每日重算（給時間觸發器跑）：先重算「該段無打卡」的核定狀態，再重算月表分頁
 * （順序必須是先修狀態、後重算月表，否則月表這輪還是讀到舊狀態）。
 * 重算當月；每月 1–3 日連上月一起重算（收尾跨夜班與補核准的裝置事件），之後上月凍結不再改動。
 */
function dailyMonthlyRebuild() {
  // 夜間 QA 低-1：與 handleRebuildMonth 取同一把 script lock（rebuildMonth 是 clear 後整張重寫，不能兩邊同時跑）
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) {
    Logger.log('dailyMonthlyRebuild: 30 秒內拿不到鎖（另一個重算進行中），跳過本次');
    return;
  }
  try {
    recheckPendingApprovalStatuses();
    const ym = currentYmTaipei();
    rebuildMonth(ym);
    const day = parseInt(todayTaipeiStr().slice(8, 10), 10);
    if (day <= 3) rebuildMonth(prevYm(ym));
  } finally { lock.releaseLock(); }
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
/**
 * 打烊尖峰不重算月表（2026-09-20 實測後新增）。月表只是「呈現」——events／approved／leave 才是
 * 資料來源，薪資歸集、核定頁、同仁打卡頁都不讀它，所以晚幾小時更新沒有任何功能影響；
 * 但整月重寫在十幾人的表上並不便宜，跟同仁下班打卡擠在同一段時間會把整個後端拖慢：
 * 2026-09-20 21:14–21:42 實測金山有 32–45% 的請求失敗或超過一分鐘，同一時段晚上沒人打卡的央廚 0%。
 * 這段期間的異動由 23 點之後的下一次、或每日 05:00 的全月重算補上。
 */
const MONTH_REFRESH_QUIET_HOURS = [20, 21, 22, 23];

/** 現在（台北）是不是「不重算月表」的時段。傳 nowTaipeiIso() 的字串；抽成函式是為了能單獨測。 */
function isMonthRefreshQuietHour(taipeiIso) {
  return MONTH_REFRESH_QUIET_HOURS.indexOf(Number(String(taipeiIso).substring(11, 13))) !== -1;
}

const REFRESH_LAST_ROW_PROP = 'REFRESH_CURRENT_MONTH_LAST_ROW';
// 同上，記錄 approved 分頁的列數（2026-07-13 新增：主管核定後 10 分鐘內月表也要反映，
// 不能只看 events 有沒有新列——主管核定不會新增 events 列）
const REFRESH_LAST_APPROVED_ROW_PROP = 'REFRESH_CURRENT_MONTH_LAST_APPROVED_ROW';
// 同上，記錄 leave 分頁的列數（A5 補漏：Eason 手填 leave 分頁也不會新增 events/approved 列，
// 原本只看那兩張表會漏掉請假異動，要等隔天 05:00 才反映）
const REFRESH_LAST_LEAVE_ROW_PROP = 'REFRESH_CURRENT_MONTH_LAST_LEAVE_ROW';

/**
 * 每 10 分鐘重算當月月表（給時間觸發器呼叫，不進 doPost 路由，Eason 2026-07-13 要求
 * 打卡後最多 10 分鐘反映到月表，不等隔天 05:00）。重用 rebuildMonth 既有核心，不複製邏輯。
 *
 * 三道防呆：
 *   1. events／approved／leave 三個分頁列數都沒變 → 沒有新打卡、新核定、也沒有新請假紀錄，
 *      直接 return（半夜空轉幾乎零成本；任一張表有新列就重算）。
 *   2. LockService 搶不到鎖（跟 05:00 的 dailyMonthlyRebuild 或手動 rebuild_month 撞期）
 *      → tryLock(0) 立刻放棄，不排隊等待，直接 return。
 *   3. 任何例外都吞掉只寫 log，不讓觸發器因丟例外被 Apps Script 自動停用。
 */
function refreshCurrentMonth() {
  // 打烊尖峰直接跳過（連鎖都不搶、一張表都不讀）——見 MONTH_REFRESH_QUIET_HOURS 的說明
  if (isMonthRefreshQuietHour(nowTaipeiIso())) return;
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
    const leaveSheet = ss.getSheetByName('leave'); // 可能不存在（防禦同 approvedSheet 寫法）
    const lastRow = eventsSheet.getLastRow();
    const lastApprovedRow = approvedSheet ? approvedSheet.getLastRow() : 0;
    const lastLeaveRow = leaveSheet ? leaveSheet.getLastRow() : 0;
    const prevRow = parseInt(props.getProperty(REFRESH_LAST_ROW_PROP) || '0', 10);
    const prevApprovedRow = parseInt(props.getProperty(REFRESH_LAST_APPROVED_ROW_PROP) || '0', 10);
    const prevLeaveRow = parseInt(props.getProperty(REFRESH_LAST_LEAVE_ROW_PROP) || '0', 10);

    if (lastRow === prevRow && lastApprovedRow === prevApprovedRow && lastLeaveRow === prevLeaveRow) {
      return; // 三張表都沒有新增列，跳過本次重算
    }

    rebuildMonth(currentYmTaipei());
    props.setProperty(REFRESH_LAST_ROW_PROP, String(lastRow));
    props.setProperty(REFRESH_LAST_APPROVED_ROW_PROP, String(lastApprovedRow));
    props.setProperty(REFRESH_LAST_LEAVE_ROW_PROP, String(lastLeaveRow));
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
/**
 * {action:'setup_triggers', admin_key} → 建立／重建月表相關的時間觸發器（冪等，可重複呼叫）。
 *
 * 為什麼要做成 action：時間觸發器只能由「已授權的執行身分」建立，原本得進 Apps Script 編輯器
 * 手動跑 setupMonthRefreshTrigger()＋在 UI 上點一個 05:00 的 dailyMonthlyRebuild。
 * 2026-08-22 新開的央廚／總部就是漏了這步 —— 兩支月表函式都在、卻從來沒被排程執行過，
 * 所以那兩家的試算表一直沒有 yyyy-MM 月表分頁。做成 action 之後新開店可以直接呼叫。
 *
 * ⚠ 月表只是「呈現」：events／approved／leave 才是資料來源，薪資歸集與核定頁都不讀月表，
 *   所以缺月表不影響時數與算薪，只影響開試算表直接看整月出勤。
 */
function handleSetupTriggers(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const WANT = [
    { fn: 'refreshCurrentMonth', desc: '每 30 分鐘重算當月月表（台北 20–23 點打烊尖峰不跑）',
      build: function () { ScriptApp.newTrigger('refreshCurrentMonth').timeBased().everyMinutes(30).create(); } },
    { fn: 'dailyMonthlyRebuild', desc: '每日 05:00 重算當月＋月初收尾凍結上月',
      build: function () { ScriptApp.newTrigger('dailyMonthlyRebuild').timeBased().everyDays(1).atHour(5).create(); } },
  ];
  const before = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  WANT.forEach(function (w) {
    // 冪等：同名的先刪掉再建，避免重複呼叫後同一支被排兩次
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === w.fn) ScriptApp.deleteTrigger(t);
    });
    w.build();
  });
  return { ok: true,
           created: WANT.map(function (w) { return w.fn + '（' + w.desc + '）'; }),
           before: before,
           after: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
}

function setupMonthRefreshTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshCurrentMonth') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshCurrentMonth').timeBased().everyMinutes(30).create();
  Logger.log('已建立 refreshCurrentMonth 每 30 分鐘觸發器');
}

/** API：{action:'rebuild_month', admin_key, ym?}（ym 缺省＝當月）。GAS 專屬，mock 不實作。 */
function handleRebuildMonth(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = body.ym || currentYmTaipei();
  // 夜間 QA 低-1：與 dailyMonthlyRebuild 同一把鎖
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, error: 'busy' }; }
  try {
    const rows = rebuildMonth(ym);
    return { ok: true, ym: ym, rows: rows };
  } finally { lock.releaseLock(); }
}

/** 手動觸發 recheckPendingApprovalStatuses（平常由 05:00 觸發器跑），供部署後驗證用。 */
function handleRecheckApprovals(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const result = recheckPendingApprovalStatuses();
  return { ok: true, checked: result.checked, fixed: result.fixed };
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
  // events.ts 若被 Sheets 轉成 Date 物件要先 normCellTs 正規化（勿自己重寫日期正規化，沿用既有 normCellTs）
  const eventRows = readSheetAsObjects(ss.getSheetByName('events')).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });

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
        // 主管頁判斷用（2026-08-03 新增，欄位為附加，不影響既有 listPendingDevices）：
        // 全部都在範圍內＝人確實在店裡，可安心核准；有超出範圍的要留意
        all_within_range: true,
        max_distance_m: 0,
      };
    }
    const g = groups[gk];
    g.count++;
    if (String(e.ts) < g.first_ts) g.first_ts = String(e.ts);
    if (String(e.ts) > g.last_ts) g.last_ts = String(e.ts);
    if (String(e.within_range).toLowerCase() !== 'true') g.all_within_range = false;
    const dist = Number(e.distance_m);
    if (isFinite(dist) && dist > g.max_distance_m) g.max_distance_m = Math.round(dist * 10) / 10;
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
