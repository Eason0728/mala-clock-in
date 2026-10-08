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
  // via：LINE 單一打卡入口（LineHub.gs）代綁時標註是「輸入姓名」還是「跨店自動」綁的，給主管看綁定紀錄用
  logLiffBind_(target.emp_id, target.name, userId,
               body.via === 'name' ? 'bind_name' : body.via === 'auto' ? 'bind_auto' : 'bind');
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
function logLiffBind_(empId, name, userId, type) {
  var ss = getSS();
  var sheet = ss.getSheetByName(LIFF_BIND_LOG_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(LIFF_BIND_LOG_SHEET_);
    sheet.getRange(1, 1, 1, LIFF_BIND_LOG_HEADERS_.length).setValues([LIFF_BIND_LOG_HEADERS_]);
  }
  sheet.appendRow([nowTaipeiIso(), empId, name, userId, type || 'bind']);
}

/** 用 LINE 帳號找本店名冊上的在職同仁 → {roster, ss} 或 {error}（no_roster／line_identity_conflict／not_bound）。 */
function liffRosterByLine_(userId) {
  // 唯讀查身分，刻意不呼叫 ensureRosterHeaders——這條路徑不寫入。
  // 若表頭還沒有 line_user_id 欄，讀出來的列就沒有該屬性，篩出來自然是查不到而回 not_bound，
  // 那正是「還沒綁定」的正確答案。
  var ss = getSS();
  var rosterSheet = ss.getSheetByName('roster');
  if (!rosterSheet) return { error: 'no_roster' };

  // ⚠ 2026-08-27 審查 Important 4：一個 LINE 帳號綁兩個在職員工違反「一帳號一員工」的不變量，
  // 理論上已經被 handleLiffBind_ 的衝突檢查（anyExisting）擋住。萬一資料還是壞了
  // （例如試算表被人手動改過、或衝突檢查本身有漏洞），這裡不可以像 findRosterByLineUser_
  // 原本那樣悄悄取 [0]——那會把打卡算到「剛好排第一筆」的員工頭上，錯得無聲無息。
  // 寧可整條 fail closed 明確回錯，也不要用不變量已經被違反的資料繼續動作。
  var activeMatches = readSheetAsObjects(rosterSheet).rows.filter(function (r) {
    return r.line_user_id && String(r.line_user_id) === String(userId)
        && String(r.active).toLowerCase() === 'true';
  });
  if (activeMatches.length > 1) return { error: 'line_identity_conflict' };
  var roster = activeMatches[0];
  if (!roster) return { error: 'not_bound' };
  return { roster: roster, ss: ss };
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

  var found = liffRosterByLine_(userId);
  if (found.error) return { ok: false, error: found.error };
  var roster = found.roster;

  // 複製一份 body，換上該員工的 key，並移除 id_token（不讓它流進既有邏輯）
  var inner = {};
  Object.keys(body).forEach(function (k) {
    if (k !== 'id_token' && k !== 'action') inner[k] = body[k];
  });
  inner.key = roster.key;
  return innerHandler(inner);
}

/* ── 值班主管看得到誰綁了 LINE、綁錯可以解除（2026-10-08，LINE 單一打卡入口改成「輸入全名」綁定）── */
function liffMgr_(body) {
  var sh = getSS().getSheetByName('managers');
  return sh ? findManagerByKey(readSheetAsObjects(sh).rows, body.mgr_key) : null;
}

/** {action:'mgr_line_binds', mgr_key, days?} → 最近 N 天（預設 30）的綁定／解除紀錄＋現在是否仍綁著。不回 LINE userId 全文。 */
function handleMgrLineBinds_(body) {
  if (!liffMgr_(body)) return { ok: false, error: 'unauthorized' };
  var days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 180);
  var cutoff = Date.now() - days * 86400000;
  var ss = getSS();
  var roster = readSheetAsObjects(ss.getSheetByName('roster')).rows;
  var nowBound = {};
  roster.forEach(function (r) { if (r.line_user_id) nowBound[String(r.emp_id)] = String(r.line_user_id); });
  var sh = ss.getSheetByName(LIFF_BIND_LOG_SHEET_);
  var rows = sh ? readSheetAsObjects(sh).rows : [];
  var items = rows.map(function (r) { return { ts: String(normCellTs(r.ts) || ''), emp_id: String(r.emp_id), name: String(r.name),
                                              type: String(r.type || 'bind'), uid: String(r.line_user_id || '') }; })
    .filter(function (r) { var t = new Date(r.ts).getTime(); return !isNaN(t) && t >= cutoff; })
    .map(function (r) {
      return { ts: r.ts, emp_id: r.emp_id, name: r.name, type: r.type,
               still_bound: r.type.indexOf('bind') === 0 && nowBound[r.emp_id] === r.uid };
    })
    .reverse();
  return { ok: true, days: days, items: items };
}

/** {action:'mgr_line_unbind', mgr_key, emp_id} → 清掉該同仁的 LINE 綁定（他下次打卡要重新輸入姓名綁定）。 */
function handleMgrLineUnbind_(body) {
  var mgr = liffMgr_(body);
  if (!mgr) return { ok: false, error: 'unauthorized' };
  var sheet = getSS().getSheetByName('roster');
  ensureRosterHeaders(sheet);
  var row = readSheetAsObjects(sheet).rows.filter(function (r) { return String(r.emp_id) === String(body.emp_id); })[0];
  if (!row) return { ok: false, error: 'not_found' };
  if (!row.line_user_id) return { ok: true, already: true };
  setRosterCell(sheet, row.__rowIndex, 'line_user_id', '');
  setRosterCell(sheet, row.__rowIndex, 'line_bound_at', '', true);
  logLiffBind_(row.emp_id, row.name, String(row.line_user_id), 'unbind_by:' + String(mgr.name || ''));
  return { ok: true };
}

/* ══ 方案 C（2026-10-08）：LINE 打卡畫面直接打這家店，不再經光復轉一手 ══
   打卡畫面（clock-line.html）用 GPS 自己挑店，直接呼叫該店的 liff_status／liff_punch。
   防呆（同型擋、10 分鐘鎖）由各店自己在伺服器端擋——規則與網頁版 clock.html、光復 LineHub.gs 共用 liffGuard_。
   舊動作 liff_whoami／liff_clock／liff_bind 一律不動。 */
var LIFF_LOCK_MIN = 10;

function liffHm_(ts) { return String(ts || '').slice(11, 16); }

/** 選上班／下班的防呆，與網頁版 clock.html updateButtonStates 同規則：
 *  最後一張算數的卡（lastCountedEvent，往回 12 小時）是什麼型別，就不能再打同型（blocked）；
 *  打完那張後 10 分鐘內不能打另一型（lock[另一型]＝解鎖時刻 ms）。 */
function liffGuard_(events, empId) {
  var last = lastCountedEvent(events, empId);
  var g = { last: last ? { type: last.type, hm: liffHm_(last.ts), ts: last.ts } : null, blocked: last ? last.type : null, lock: {} };
  if (last) {
    var t = new Date(String(last.ts)).getTime();
    if (!isNaN(t)) g.lock[last.type === 'in' ? 'out' : 'in'] = t + LIFF_LOCK_MIN * 60000;
  }
  return g;
}

/** 防呆擋下時的白話原因；沒擋回 null。 */
function liffGuardReject_(g, type) {
  var label = type === 'in' ? '上班' : '下班';
  if (g.blocked === type) {
    return { reason: '你 ' + g.last.hm + ' 已經打過' + label + '卡了',
             hint: '要' + (type === 'in' ? '下班' : '上班') + '請按另一顆；真的要補打請告知主管' };
  }
  if (g.lock[type] && g.lock[type] > Date.now()) {
    return { reason: '你 ' + g.last.hm + ' 剛打過' + (g.last.type === 'in' ? '上班' : '下班') + '卡，' + Math.ceil((g.lock[type] - Date.now()) / 60000) + ' 分鐘內不能打' + label + '卡（避免連按誤打）',
             hint: '真的要' + label + '請告知主管補登' };
  }
  return null;
}

/* 打卡成功問候語（2026-10-08 Eason 指定）：依伺服器打卡時間分早安／午安／晚上，上下班各三時段各三句。
   ⚠ 字句正本在 mala-clock-in repo 的 clock.html（CLOCK_GREETINGS），這裡是同一份，改一邊要改另一邊。
   時段：05:00–11:59 早安／12:00–17:59 午安／18:00–隔天 04:59 晚上（上班「晚上好」，「晚安」只給下班）。
   挑哪一句由打卡時間（含秒）決定：打卡畫面（各店 liff_punch）與聊天室卡片（光復 webhook）各自算也會是同一句。 */
var LIFF_GREETINGS = {
  in: {
    morning: ['早安！今天也謝謝你來，有你在真好 ☀️', '早安！有你一起努力，今天一定很順 💪', '早安！新的一天，祝你一切順利 🌱'],
    afternoon: ['午安！謝謝你來接力，下午一起加油 💪', '午安！有你在就安心，下午也順順利利 ☀️', '午安！吃飽了嗎？下午也要元氣滿滿 😊'],
    evening: ['晚上好！謝謝你今晚的付出，有你超放心 🌙', '晚上好！今晚也一起加油，辛苦你了 💪', '晚上好！謝謝有你，今晚一切順利 ✨']
  },
  out: {
    morning: ['早安！忙完這一段辛苦了，好好休息 ☀️', '辛苦了！謝謝你一早的付出，接下來好好照顧自己 ❤️', '收工了！今天的你超棒，記得補充體力 💪'],
    afternoon: ['午安！辛苦了，謝謝你今天的用心 ❤️', '辛苦了！接下來的時間留給自己，好好放鬆 ☀️', '今天的努力大家都看得到，辛苦了，好好休息 ✨'],
    evening: ['辛苦了！今天的你超棒，好好休息，明天見 ❤️', '晚安！謝謝你今天的用心，回家好好犒賞自己 🌙', '今天也辛苦了，路上小心，好好睡一覺 🌙']
  }
};
function liffGreeting_(type, ts) {
  var set = LIFF_GREETINGS[type], s = String(ts || '');
  var h = parseInt(s.substring(11, 13), 10);
  if (!set || !(h >= 0 && h <= 23)) return '';
  var list = (h >= 5 && h < 12) ? set.morning : (h >= 12 && h < 18) ? set.afternoon : set.evening;
  var sum = 0;
  for (var i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return list[sum % list.length];
}

/** 簡單節流：同一個 LINE 帳號在固定時間窗（windowSec 秒，依時間切格）內最多 max 次（CacheService，鍵 lfq:<kind>:<uid>:<格>）。
 *  固定窗不是滑動窗：每次計數都重設 TTL 的寫法會讓持續慢慢按的人永遠解不了鎖（階段 1 審查 #2）。 */
function liffThrottled_(kind, userId, max, windowSec) {
  var c = CacheService.getScriptCache();
  var k = 'lfq:' + kind + ':' + userId + ':' + Math.floor(Date.now() / (windowSec * 1000));
  var n = parseInt(c.get(k) || '0', 10) + 1;
  c.put(k, String(n), windowSec + 5);
  return n > max;
}

/** 全站節流：驗 LINE 身分前先擋（驗身分要打 LINE API，吃 UrlFetch 配額；階段 1 審查 #3）。 */
function liffSiteThrottled_() { return liffThrottled_('site', 'all', 600, 60); }

function liffEvents_(ss) {
  var sh = ss.getSheetByName('events');
  return sh ? readSheetAsObjects(sh).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; }) : [];
}

/**
 * {action:'liff_status', id_token} → 打卡畫面開啟時要的全部資料（一次呼叫）
 * {ok, status:'ready', name, shift_in, shift_out, today:[{type,hm,status}], guard:{blocked, lock, last, now}}
 * 沒綁定回 {ok:false, error:'not_bound'}（畫面改問光復走綁定流程）。
 */
function handleLiffStatus_(body) {
  if (liffSiteThrottled_()) return { ok: false, error: 'too_many' };
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (liffThrottled_('st', userId, 30, 60)) return { ok: false, error: 'too_many' };
  var found = liffRosterByLine_(userId);
  if (found.error) return { ok: false, error: found.error };
  var me = found.roster, events = liffEvents_(found.ss);
  var today = todayTaipeiStr();
  var mine = events.filter(function (e) { return String(e.emp_id) === String(me.emp_id) && String(e.ts).slice(0, 10) === today; })
    .map(function (e) { return { type: String(e.type), hm: liffHm_(e.ts), status: String(e.status) }; });
  var g = liffGuard_(events, me.emp_id);
  return { ok: true, status: 'ready', name: String(me.name),
           shift_in: normShiftTime(me.shift_in), shift_out: normShiftTime(me.shift_out),
           today: mine, guard: { blocked: g.blocked, lock: g.lock, last: g.last, now: Date.now() } };
}

var LIFF_PUNCH_REASONS_ = {
  pending_device_approval: ['這支手機還沒被核准', '已送出待核准，請主管在值班核定頁核准'],
  rejected_out_of_range: ['店家判定你不在範圍內', '請開啟「精確位置」與 Wi‑Fi 後再按一次'],
  rejected_duplicate: ['這一筆和上一筆重複', '請按「出勤紀錄」確認今天的紀錄'],
};

/**
 * {action:'liff_punch', id_token, type:'in'|'out', lat, lng, accuracy}
 * → {ok:true, type, ts, greeting} 或 {ok:false, type, reason, hint}（error：invalid_id_token／too_many／not_bound…）
 * 防呆在伺服器端擋（不信前端）；裝置碼沿用名冊已綁定的（LINE 身分已擋住連結轉傳代打），沒綁用 'line:<userId>'。
 */
function handleLiffPunch_(body) {
  var type = body.type;
  if (type !== 'in' && type !== 'out') return { ok: false, error: 'bad_type' };
  if (liffSiteThrottled_()) return { ok: false, error: 'too_many' };
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (liffThrottled_('pu', userId, 10, 60)) return { ok: false, error: 'too_many' };
  var found = liffRosterByLine_(userId);
  if (found.error) return { ok: false, error: found.error };
  var me = found.roster;
  // 雙擊防護（審查 #7）：上一筆還在處理就不再進場。不是原子鎖（ScriptLock 會跟月表重算搶、讓打卡卡住），
  // 只把「兩次請求都讀到舊紀錄、都通過防呆」的視窗縮到幾毫秒；handleClock 自己的 rejected_duplicate 是最後一道。
  var cache = CacheService.getScriptCache(), busyKey = 'lfp:' + userId;
  if (cache.get(busyKey)) return { ok: false, type: type, reason: '上一筆還在處理中', hint: '請等幾秒，看出勤紀錄有沒有這筆再決定要不要重按' };
  cache.put(busyKey, '1', 20);
  try {
    return liffPunchFor_(userId, me, found.ss, type, body);
  } finally {
    cache.remove(busyKey);
  }
}

function liffPunchFor_(userId, me, ss, type, body) {
  var stop = liffGuardReject_(liffGuard_(liffEvents_(ss), me.emp_id), type);
  if (stop) return { ok: false, type: type, reason: stop.reason, hint: stop.hint };
  var j = handleClock({ key: me.key, type: type, lat: body.lat, lng: body.lng,
                        accuracy: body.accuracy === undefined ? null : body.accuracy,
                        device_id: me.device_id ? String(me.device_id) : 'line:' + userId });
  if (j && j.ok && j.status === 'ok') return { ok: true, type: type, ts: j.ts, greeting: liffGreeting_(type, j.ts) };
  var st = j && (j.status || j.error);
  var rr = LIFF_PUNCH_REASONS_[st] || ['系統回覆：' + (st || '未知'), '請告知主管'];
  return { ok: false, type: type, status: st || '', reason: rr[0], hint: rr[1] };
}

/* ══ 方案 C：Mac mini 每天 04:30 備份（唯讀，管理金鑰）══
   放在 Liff.gs 是因為這份檔案五家店整檔共用，加動作不必改各店的 程式碼.js。 */
var LIFF_EXPORT_TABLES_ = ['events', 'approved', 'leave', 'roster'];
// 備份不該變成萬能鑰匙、也不該對得到 LINE 帳號：events.device_id 沒綁裝置時存的是 'line:<LINE 帳號>'（階段 1 審查 #1）
var LIFF_EXPORT_DROP_ = { roster: ['key', 'device_id', 'line_user_id'], events: ['device_id'] };

function liffExportCell_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
  return v;
}

/** {action:'export_tables', admin_key} → {ok, exported_at, tables:{events, approved, leave, roster}}；不寫入任何東西。
 *  admin_key 空字串一律擋（CONFIG.ADMIN_KEY 萬一漏設，checkAdmin 會讓空金鑰通過；審查 #9）。 */
function handleExportTables_(body) {
  if (!body.admin_key || !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  var ss = getSS(), out = {};
  LIFF_EXPORT_TABLES_.forEach(function (name) {
    var sh = ss.getSheetByName(name), drop = LIFF_EXPORT_DROP_[name] || [];
    out[name] = sh ? readSheetAsObjects(sh).rows.map(function (r) {
      var o = {};
      Object.keys(r).forEach(function (k) { if (k !== '__rowIndex' && drop.indexOf(k) < 0) o[k] = liffExportCell_(r[k]); });
      return o;
    }) : [];
  });
  return { ok: true, exported_at: Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"), tables: out };
}

var LIFF_HANDLERS = {
  mgr_line_binds: handleMgrLineBinds_,
  mgr_line_unbind: handleMgrLineUnbind_,
  liff_bind: handleLiffBind_,
  liff_clock: function (body) { return withLineIdentity_(body, handleClock); },
  liff_whoami: function (body) { return withLineIdentity_(body, handleWhoami); },
  liff_my_recent: function (body) { return withLineIdentity_(body, handleMyRecent); },
  liff_status: handleLiffStatus_,
  liff_punch: handleLiffPunch_,
  export_tables: handleExportTables_,
};

/**
 * 一次性授權用：讓專案擁有者在 Apps Script 編輯器裡執行這支，
 * 好觸發 UrlFetchApp（連線至外部服務）的授權對話框。
 *
 * 為什麼需要它：Apps Script 是「按需授權」——執行一支用不到外部連線的函式時，
 * 授權畫面不會要求該權限。而本檔其餘函式都以底線結尾（私有慣例），
 * 編輯器的執行下拉選單刻意不顯示它們，擁有者無從選取。
 *
 * 這支只用一個假 token 打一次 LINE 的驗證端點（必定回 400），不寫入任何資料。
 * 授權完成後可以留著，日後換人接手或重建專案時還會用到。
 */
function liffAuthorizeOnce() {
  var res = UrlFetchApp.fetch(LIFF_CONFIG.VERIFY_URL, {
    method: 'post',
    payload: { id_token: 'dummy-for-authorization', client_id: LIFF_CONFIG.CHANNEL_ID },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  Logger.log('LINE verify 回應 HTTP ' + code + '（400 是正常的，代表連得出去、授權已完成）');
  return code;
}
