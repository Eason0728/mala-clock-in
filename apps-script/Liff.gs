/**
 * LIFF 身分層 —— 獨立檔案，不修改 Code.gs 的任何既有函式。
 *
 * 設計原則：轉接而非改造。
 * 新 handler 先驗 ID token 取得可信 userId，再從 roster 查出該員工既有的 key，
 * 然後直接呼叫原本的 handleClock / handleWhoami / handleMyRecent。
 *
 * 回退方式：移除 Code.gs 中併入 LIFF_HANDLERS 的三行，即完全回到原狀。
 */

var LIFF_CONFIG = {
  CHANNEL_ID: '2011292256',            // 鼎兆元打卡登入（非機密，前端也看得到）
  VERIFY_URL: 'https://api.line.me/oauth2/v2.1/verify',
};

/**
 * 驗證 LIFF 的 ID token，回傳可信的 userId。
 *
 * ⚠ 絕不可直接信任前端傳來的 userId——那是任何人都能偽造的字串。
 * 必須拿 ID token 向 LINE 驗證，取回應中的 sub。
 */
function verifyLineIdToken_(idToken) {
  if (!idToken) return null;
  var channelId = (typeof CONFIG !== 'undefined' && CONFIG.LINE_CHANNEL_ID)
    ? CONFIG.LINE_CHANNEL_ID : LIFF_CONFIG.CHANNEL_ID;
  var res = UrlFetchApp.fetch(LIFF_CONFIG.VERIFY_URL, {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  var data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    // HTTP 200 但 body 不是有效 JSON（gateway 異常、API 改版等）——乾淨失敗
    return null;
  }
  if (!data || !data.sub) return null;
  if (String(data.aud) !== String(channelId)) return null;   // 防別的 channel 的 token 冒用
  return String(data.sub);
}

/** 用 userId 查在職員工。空 userId 一律查不到（否則會比對到未綁定者的空欄位）。 */
function findRosterByLineUser_(rows, userId) {
  if (!userId) return undefined;
  return rows.filter(function (r) {
    return String(r.line_user_id) === String(userId)
        && String(r.active).toLowerCase() === 'true';
  })[0];
}

/**
 * 綁定：把 LINE 帳號與員工對上。
 *
 * 流程：驗 ID token 拿到可信 userId → 用店長給的啟用碼(key)找到員工 → 寫回 roster。
 * 啟用碼綁定後**不作廢**——舊連結保留為退路，不強迫同仁同一天全部轉換。
 *
 * ⚠ 寫入前一定要 ensureRosterHeaders：setRosterCell 依試算表當下表頭找欄號，
 *   欄位不存在時它回 false 而不是 throw，會變成「回報成功但沒寫入」的靜默失敗。
 */
function handleLiffBind_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };

  var rosterSheet = getSS().getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  ensureRosterHeaders(rosterSheet);
  var rows = readSheetAsObjects(rosterSheet).rows;

  // 這個 LINE 帳號是否已經綁在別的員工身上？
  // ⚠ 2026-08-27 審查 Important 4：衝突檢查要看「所有列」，不能只看在職——
  // findRosterByLineUser_ 只比對 active==='true'，於是離職列上殘留的 userId 不會擋人。
  // 情境：員工離職（active=false，line_user_id 留著）→ 用新 emp_id 復職 → 綁同一個 LINE 帳號
  // （此時舊列不在職，查不到，綁定放行）→ 之後主管把舊列復職 → 兩個在職列共用一個 userId，
  // withLineIdentity_ 取 [0] 會悄悄把打卡算到錯的人頭上、一路餵進 approved 與薪資。
  // 所以這裡刻意不用 findRosterByLineUser_（它的「只看在職」是給 withLineIdentity_ 的
  // 認證用途設計的，那裡本來就該只看在職——不要改那支函式，改這裡的判斷依據）。
  var anyExisting = rows.filter(function (r) {
    return r.line_user_id && String(r.line_user_id) === String(userId);
  })[0];

  var target = rows.filter(function (r) {
    return String(r.key) === String(body.key)
        && String(r.active).toLowerCase() === 'true';
  })[0];
  if (!target) return { ok: false, error: 'invalid_key' };

  if (anyExisting && String(anyExisting.emp_id) !== String(target.emp_id)) {
    return { ok: false, error: 'line_account_in_use' };
  }

  // 該員工已綁了另一個 LINE 帳號 → 要店長先解綁，避免默默換人
  if (target.line_user_id && String(target.line_user_id) !== String(userId)) {
    return { ok: false, error: 'already_bound_other_user' };
  }

  // 已經是綁好的同一組，直接回成功（同仁重按不該報錯，也不該重寫，也不該記一筆稽核紀錄——
  // 這不是新的綁定事件，記了只會洗版）
  if (String(target.line_user_id) === String(userId)) {
    return { ok: true, name: target.name, emp_id: target.emp_id, already: true };
  }

  setRosterCell(rosterSheet, target.__rowIndex, 'line_user_id', userId);
  // 純日期時間字串鎖成文字，避免被 Sheets 轉成 Date 物件（同 removed_at 的處理）
  setRosterCell(rosterSheet, target.__rowIndex, 'line_bound_at', nowTaipeiIso(), true);
  logLiffBind_(target.emp_id, target.name, userId);
  return { ok: true, name: target.name, emp_id: target.emp_id };
}

/**
 * 綁定稽核紀錄（2026-08-27 審查 Important 6）：目前誰綁了哪個 LINE 帳號只有
 * roster.line_bound_at 一格，會被下一次綁定覆蓋——一旦發生誤綁，事後完全查不到
 * 「什麼時候、被誰的 LINE 帳號」蓋過去的。這是現在只要幾行、以後想補也補不回來的那種紀錄。
 *
 * 刻意獨立開一張分頁，不塞進既有的 events：
 *   1. events 是 pairShifts／todayHoursSummary／handleWhoami 的 today_events 的資料來源，
 *      混進非打卡列會被那些既有邏輯一起讀到（尤其 handleWhoami today_events 不篩 type，
 *      綁定紀錄會直接出現在同仁的「今日紀錄」列表裡）。
 *   2. 「刪除 Liff.gs 即回到原狀」是這個分支的回退承諾——如果寫進 events，刪掉 Liff.gs
 *      之後殘留的怪列還是會被 Code.gs 的既有邏輯繼續讀到，回退就不乾淨了。
 *      獨立分頁則是 Liff.gs 專屬的副作用，刪掉檔案後這張表單純變成沒人再寫入的歷史紀錄。
 */
var LIFF_BIND_LOG_SHEET_ = 'liff_bind_log';
var LIFF_BIND_LOG_HEADERS_ = ['ts', 'emp_id', 'name', 'line_user_id', 'type'];
function logLiffBind_(empId, name, userId) {
  var ss = getSS();
  var sheet = ss.getSheetByName(LIFF_BIND_LOG_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(LIFF_BIND_LOG_SHEET_);
    sheet.getRange(1, 1, 1, LIFF_BIND_LOG_HEADERS_.length).setValues([LIFF_BIND_LOG_HEADERS_]);
  }
  sheet.appendRow([nowTaipeiIso(), empId, name, userId, 'bind']);
}

/**
 * 轉接：把「LINE 身分」換成「既有的 key 身分」，然後呼叫原本的 handler。
 *
 * 這是整份設計的核心——既有的 handleClock / handleWhoami / handleMyRecent
 * 一行都不用改，也就不可能被改壞。
 */
function withLineIdentity_(body, innerHandler) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };

  // 唯讀查身分，刻意不呼叫 ensureRosterHeaders——這條路徑不寫入。
  // 若表頭還沒有 line_user_id 欄，讀出來的列就沒有該屬性，篩出來自然是查不到而回 not_bound，
  // 那正是「還沒綁定」的正確答案。
  var rosterSheet = getSS().getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };

  // ⚠ 2026-08-27 審查 Important 4：一個 LINE 帳號綁兩個在職員工違反「一帳號一員工」的不變量，
  // 理論上已經被 handleLiffBind_ 的衝突檢查（anyExisting）擋住。萬一資料還是壞了
  // （例如試算表被人手動改過、或衝突檢查本身有漏洞），這裡不可以像 findRosterByLineUser_
  // 原本那樣悄悄取 [0]——那會把打卡算到「剛好排第一筆」的員工頭上，錯得無聲無息。
  // 寧可整條 fail closed 明確回錯，也不要用不變量已經被違反的資料繼續動作。
  var activeMatches = readSheetAsObjects(rosterSheet).rows.filter(function (r) {
    return r.line_user_id && String(r.line_user_id) === String(userId)
        && String(r.active).toLowerCase() === 'true';
  });
  if (activeMatches.length > 1) return { ok: false, error: 'line_identity_conflict' };
  var roster = activeMatches[0];
  if (!roster) return { ok: false, error: 'not_bound' };

  // 複製一份 body，換上該員工的 key，並移除 id_token（不讓它流進既有邏輯）
  var inner = {};
  Object.keys(body).forEach(function (k) {
    if (k !== 'id_token' && k !== 'action') inner[k] = body[k];
  });
  inner.key = roster.key;
  return innerHandler(inner);
}

var LIFF_HANDLERS = {
  liff_bind: handleLiffBind_,
  liff_clock: function (body) { return withLineIdentity_(body, handleClock); },
  liff_whoami: function (body) { return withLineIdentity_(body, handleWhoami); },
  liff_my_recent: function (body) { return withLineIdentity_(body, handleMyRecent); },
};
