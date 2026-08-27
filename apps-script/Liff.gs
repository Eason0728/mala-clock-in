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
