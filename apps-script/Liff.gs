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
  var existing = findRosterByLineUser_(rows, userId);

  var target = rows.filter(function (r) {
    return String(r.key) === String(body.key)
        && String(r.active).toLowerCase() === 'true';
  })[0];
  if (!target) return { ok: false, error: 'invalid_key' };

  if (existing && String(existing.emp_id) !== String(target.emp_id)) {
    return { ok: false, error: 'line_account_in_use' };
  }

  // 該員工已綁了另一個 LINE 帳號 → 要店長先解綁，避免默默換人
  if (target.line_user_id && String(target.line_user_id) !== String(userId)) {
    return { ok: false, error: 'already_bound_other_user' };
  }

  // 已經是綁好的同一組，直接回成功（同仁重按不該報錯，也不該重寫）
  if (String(target.line_user_id) === String(userId)) {
    return { ok: true, name: target.name, emp_id: target.emp_id, already: true };
  }

  setRosterCell(rosterSheet, target.__rowIndex, 'line_user_id', userId);
  // 純日期時間字串鎖成文字，避免被 Sheets 轉成 Date 物件（同 removed_at 的處理）
  setRosterCell(rosterSheet, target.__rowIndex, 'line_bound_at', nowTaipeiIso(), true);
  return { ok: true, name: target.name, emp_id: target.emp_id };
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
  // 若表頭還沒有 line_user_id 欄，讀出來的列就沒有該屬性，findRosterByLineUser_
  // 自然查不到而回 not_bound，那正是「還沒綁定」的正確答案。
  var rosterSheet = getSS().getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };

  var roster = findRosterByLineUser_(readSheetAsObjects(rosterSheet).rows, userId);
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
