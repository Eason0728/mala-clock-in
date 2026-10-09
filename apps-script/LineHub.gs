/**
 * LINE 單一打卡入口的集中服務（2026-10-08，規格 mala-clock-liff/docs/spec.md §2.4）。
 *
 * 只部署在光復後端（薪資也在這裡）。各店的專屬打卡連結（clock*.html?k=）完全不經過這裡，
 * 這支壞掉時同仁仍可用原本的連結打卡。
 *
 * v2（2026-10-08）：打卡改經過這裡（line_quick_clock）以便把結果交給聊天室機器人回覆；第一次使用輸入全名綁定
 * （line_bind_name）；出勤／薪資／假別查詢由 webhook（handleLineWebhook_）在聊天室回覆。v1 的 line_my_stores／
 * line_bind_all／line_my_payslip（貼連結綁定、網頁查詢）已移除。
 * 依賴：Liff.gs 的 verifyLineIdToken_／handleLiffBind_／LIFF_HANDLERS、Payroll.gs 的 payMyPayslipFor_、
 *       Code.gs 的 getSS／readSheetAsObjects。
 * 各店試算表 ID 與後端網址放在 LineHubConfig.gs（變數 LINE_HUB_STORES_CONFIG）——
 * 那支只在部署目錄 ~/mala-gas/mala-clock-in，**不進公開 repo**（同 Code.gs 的 SPREADSHEET_ID 不進 repo 的理由）。
 * 範本見 LineHubConfig.example.gs。
 *
 * 回退：移除 Code.gs 併入 LINE_HUB_HANDLERS 的三行即可，其他功能完全不受影響。
 */

/** 設定檔不存在時只認得光復（本機試算表），其他店一律當「讀不到」。 */
function lineHubStores_() {
  return (typeof LINE_HUB_STORES_CONFIG !== 'undefined' && LINE_HUB_STORES_CONFIG.length)
    ? LINE_HUB_STORES_CONFIG
    : [{ code: '', name: '小辛辣 新竹光復', ss_id: '', api: '' }];
}

/** 讀某店的名冊；讀不到回 null（呼叫端把它列為 unreadable，不讓單一店拖垮整個查詢）。 */
function lineHubRoster_(st) {
  var ss;
  if (st.code === '') ss = getSS();
  else if (st.ss_id) ss = SpreadsheetApp.openById(st.ss_id);
  else return null;
  var sh = ss.getSheetByName('roster');
  return sh ? readSheetAsObjects(sh).rows : null;
}

function lineHubActive_(r) { return String(r.active).toLowerCase() === 'true'; }
/* 離職後查詢（2026-10-09 Eason 定案）：打卡一離職就關；自己的薪資單、打卡紀錄、假別額度離職後 60 天內還能查
   （涵蓋最後一次發薪），超過就關。依名冊 removed_at（主管設離職時寫入）；沒有 removed_at 的舊離職者視為已超過。
   ⚠ 舊的個人薪資連結（Payroll.gs handleMyPayslip）呼叫同一支，兩邊規則一致。 */
var LINE_HUB_LEFT_VIEW_DAYS = 60;
function lineHubCanView_(r) {
  if (lineHubActive_(r)) return true;
  var t = new Date(String(normCellTs(r.removed_at) || '')).getTime();
  return isFinite(t) && t > 0 && Date.now() - t <= LINE_HUB_LEFT_VIEW_DAYS * 86400000;
}

/* ══════════════ v2：全部在 LINE 聊天室完成（spec v2，2026-10-08）══════════════
 * 選單「打卡」→ LIFF 小畫面抓 GPS → line_quick_clock（這裡）→ 結果暫存 →
 * LIFF 代同仁送出「打卡」→ webhook（handleLineWebhook_）取暫存結果用「回覆」送進聊天室（免費）。
 * 不分上班／下班：自動判斷（往回 16 小時＝配對視窗內最後一張算數的卡是上班→這次是下班，反之上班），
 * 距離那張卡不到 CLOCK_LOCK_MIN 分鐘就擋（原本網頁版的 10 分鐘鎖，搬到伺服器端）。 */
var LINE_HUB_ACC_CAP_M = 100;      // 與各店後端 ACCURACY_CREDIT_CAP_M、clock-line-core.js 相同
var LINE_HUB_STASH_SEC = 300;

/** 與 clock-line-core.js 的 pickStore 同一套規則（tests/line-hub-v2.test.js 第一項逐點比對兩邊結果）。 */
function lineHubDistanceM_(lat1, lng1, lat2, lng2) {
  var toRad = Math.PI / 180, R = 6371000;
  var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lineHubPickStore_(fix, stores) {
  if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number' ||
      !isFinite(fix.lat) || !isFinite(fix.lng)) return { status: 'no_fix' };
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var acc = (typeof fix.accuracy_m === 'number' && isFinite(fix.accuracy_m) && fix.accuracy_m >= 0) ? r1(fix.accuracy_m) : 0;
  var hits = [], nearest = null, nearestD = Infinity;
  (stores || []).forEach(function (s) {
    if (typeof s.lat !== 'number') return;
    var d = lineHubDistanceM_(fix.lat, fix.lng, s.lat, s.lng);
    if (d < nearestD) { nearestD = d; nearest = s; }
    if (Math.max(0, r1(d) - Math.min(acc, LINE_HUB_ACC_CAP_M)) <= s.radius_m) hits.push({ store: s, d: d });
  });
  if (hits.length === 1) return { status: 'ok', store: hits[0].store, distance_m: Math.round(hits[0].d * 10) / 10 };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits.map(function (h) { return h.store.code; }) };
  return { status: 'none', nearest: nearest, distance_m: nearest ? Math.round(nearestD) : null };
}

/** 姓名比對：去掉所有空白（半形、全形）。 */
function lineHubNormName_(s) { return String(s || '').replace(/[\s\u3000]/g, ''); }

/** 呼叫某家店自己的 handler（光復本機直接呼叫，其他店伺服器對伺服器）；失敗回 null。 */
function lineHubCallStore_(st, payload) {
  try {
    if (st.code === '') return LIFF_HANDLERS[payload.action](payload);
    return JSON.parse(UrlFetchApp.fetch(st.api, { method: 'post', contentType: 'text/plain', payload: JSON.stringify(payload),
                                                  muteHttpExceptions: true, followRedirects: true }).getContentText());
  } catch (e) { return null; }
}

/**
 * {action:'line_bind_name', id_token, name, lat, lng, accuracy}（Eason 2026-10-08：第一次使用輸入全名，不給連結或啟用碼）
 * 防代綁三道：①手機定位必須在「名冊上有這個名字」的那家店範圍內 ②只能綁還沒被綁的名字
 *             ③綁定寫進那家店的 liff_bind_log（type=bind_name），值班核定頁看得到、可解除。
 */
function handleLineBindName_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('bind', userId, 5, 600)) {
    return { ok: false, error: 'too_many', message: '嘗試太多次了，請 10 分鐘後再試；名字確定沒錯還是不行，請找主管。' };
  }
  var want = lineHubNormName_(body.name);
  if (!want) return { ok: false, error: 'empty_name', message: '請輸入你的全名' };
  var pick = lineHubPickStore_({ lat: Number(body.lat), lng: Number(body.lng),
    accuracy_m: body.accuracy === null || body.accuracy === undefined || body.accuracy === '' ? undefined : Number(body.accuracy) }, lineHubStores_());
  if (pick.status !== 'ok') {
    return { ok: false, error: 'not_at_store', message: pick.status === 'ambiguous'
      ? '定位不夠準，分不出你在哪一家店。請開啟「精確位置」與 Wi‑Fi 後再試。'
      : '綁定要人在店裡：請到你上班的店再試一次（目前定位不在任何打卡地點範圍內）。' };
  }
  var st = pick.store, rows;
  try { rows = lineHubSheetRows_(lineHubSS_(st), 'roster'); } catch (e) { return { ok: false, error: 'unreachable', message: '「' + st.name + '」的系統暫時連不上，請稍後再試。' }; }
  var hit = rows.filter(function (r) { return lineHubActive_(r) && lineHubNormName_(r.name) === want; });
  if (!hit.length) return { ok: false, error: 'name_not_found', store_name: st.name,
                            message: '「' + st.name + '」的名冊上沒有「' + String(body.name).trim() + '」。請確認是全名、沒有錯字；名冊上沒有你請主管把你加進去。' };
  if (hit.length > 1) return { ok: false, error: 'name_conflict', message: '「' + st.name + '」有兩位同名同仁，請找主管協助綁定。' };
  var row = hit[0];
  if (row.line_user_id && String(row.line_user_id) === String(userId)) return { ok: true, already: true, store_name: st.name, name: String(row.name) };
  if (row.line_user_id) return { ok: false, error: 'name_taken', message: '「' + String(row.name) + '」已經綁定別的 LINE 帳號。如果那不是你，請立刻告知主管在值班核定頁解除。' };
  // via：伺服器自己判斷（不信前端，v2 審查 N2）——這個 LINE 在別家店已綁定同名＝跨店（auto），否則＝輸入全名（name）
  var sameNameElsewhere = lineHubMine_(userId).some(function (m) { return lineHubNormName_(m.row.name) === want; });
  var j = lineHubCallStore_(st, { action: 'liff_bind', id_token: body.id_token, key: String(row.key), via: sameNameElsewhere ? 'auto' : 'name' });
  if (!j || !j.ok) {
    var m = { line_account_in_use: '你的 LINE 帳號已經綁定這家店的另一位同仁，請找主管處理。' }[j && j.error];
    return { ok: false, error: (j && j.error) || 'unreachable', message: m || '綁定沒有成功，請稍後再試；一直不行請告知主管。' };
  }
  lineHubForget_(userId);   // 剛綁好：機器人那邊記的「綁了哪幾家」要重查
  return { ok: true, store_name: st.name, name: String(row.name) };
}

/** 上／下班自動判斷用的「最後一張算數的卡」：與 lastCountedEvent 同規則（排除 rejected_*），但回看
 *  配對視窗 MONTHLY_PAIR_WINDOW_HOURS（16）小時。用交替防呆的 12 小時會把
 *  10:30 上、22:45 下這種超過 12 小時的長班，下班卡記成上班（v2 審查 #3）。超過 16 小時的上班卡本來就配不成一段，
 *  視為忘打下班，這次記上班。 */
function lineHubLastCounted_(eventRows, empId) {
  // 執行時才取值：Apps Script 檔案載入順序不保證 程式碼.js 在前（v2 審查 N3）
  var lookbackH = (typeof MONTHLY_PAIR_WINDOW_HOURS !== 'undefined') ? MONTHLY_PAIR_WINDOW_HOURS : 16;
  var cutoff = Date.now() - lookbackH * 3600000, last = null;
  eventRows.forEach(function (e) {
    if (String(e.emp_id) !== String(empId) || String(e.status).indexOf('rejected_') === 0) return;
    var t = new Date(String(e.ts)).getTime();
    if (isNaN(t) || t < cutoff) return;
    if (!last || t >= last.ms) last = { ts: String(e.ts), type: String(e.type), ms: t };
  });
  return last;
}

/** 簡單節流：同一個 LINE 帳號在 windowSec 秒內最多 max 次（CacheService，鍵 lht:<kind>:<uid>）。 */
function lineHubThrottled_(kind, userId, max, windowSec) {
  var c = CacheService.getScriptCache(), k = 'lht:' + kind + ':' + userId;
  var n = parseInt(c.get(k) || '0', 10) + 1;
  c.put(k, String(n), windowSec);
  return n > max;
}

function lineHubSS_(st) { return st.code === '' ? getSS() : SpreadsheetApp.openById(st.ss_id); }
function lineHubSheetRows_(ss, name) {
  var sh = ss.getSheetByName(name);
  return sh ? readSheetAsObjects(sh).rows : [];
}
function lineHubHm_(ts) { return String(ts || '').slice(11, 16); }

/** 暫存「這個 LINE 帳號剛才的打卡結果」，給 webhook 回覆用。 */
function lineHubStash_(userId, obj) {
  CacheService.getScriptCache().put('lhq:' + userId, JSON.stringify(obj), LINE_HUB_STASH_SEC);
}
function lineHubTakeStash_(userId) {
  var c = CacheService.getScriptCache(), k = 'lhq:' + userId, v = c.get(k);
  if (!v) return null;
  c.remove(k);
  try { return JSON.parse(v); } catch (e) { return null; }
}

/* 打卡成功問候語：字句與挑法搬到 Liff.gs（LIFF_GREETINGS／liffGreeting_），五家店的 liff_punch 與這裡共用，
   同一筆打卡（同一個 ts）在打卡畫面與聊天室卡片一定是同一句。 */
function lineHubGreeting_(type, ts) { return liffGreeting_(type, ts); }

/** 打卡結果 → 聊天室文字。r：{ok, type, ts, store_name, reason, hint, note} */
function lineHubPunchText_(r) {
  var label = r.type === 'out' ? '下班' : (r.type === 'in' ? '上班' : '');
  if (r.ok) {
    return '✅ ' + label + '打卡成功 ' + lineHubHm_(r.ts) + '\n地點：' + r.store_name + (r.note ? '\n' + r.note : '')
      + (r.missed ? '\n\n⚠️ ' + r.missed : '') + (r.greeting ? '\n\n' + r.greeting : '') + (r.annual_note ? '\n\n' + r.annual_note : '');
  }
  return '❌ ' + (label ? label : '') + '打卡失敗\n原因：' + r.reason + (r.hint ? '\n怎麼辦：' + r.hint : '');
}

/**
 * {action:'line_quick_clock', id_token, lat, lng, accuracy} → {ok, result:{ok,type,ts,store_name,reason,hint,note}, text}
 * 挑店 → 讀那家店的名冊與打卡紀錄決定上／下班與 10 分鐘鎖 → 伺服器對伺服器打那家店的 liff_clock → 暫存結果。
 */
function handleLineQuickClock_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  var res = lineHubQuickClockFor_(userId, body);
  // 問候語在這裡抽一次存進結果：小畫面顯示的 text 與 webhook 回覆用同一份暫存，兩邊才會是同一句
  if (res && res.ok) res.greeting = lineHubGreeting_(res.type, res.ts);
  lineHubStash_(userId, res);
  return { ok: true, result: res, text: lineHubPunchText_(res) };
}

/**
 * 共用：依定位挑店、找出這個 LINE 在那家店的名冊列與打卡紀錄。
 * 回傳 {fail: <打卡結果物件>} 或 {fix, st, ss, me, events}。
 */
function lineHubResolve_(userId, body) {
  var fix = { lat: Number(body.lat), lng: Number(body.lng),
              accuracy_m: body.accuracy === null || body.accuracy === undefined || body.accuracy === '' ? undefined : Number(body.accuracy) };
  var pick = lineHubPickStore_(fix, lineHubStores_());
  if (pick.status === 'no_fix') return { fail: { ok: false, code: 'no_fix', reason: '抓不到手機定位', hint: '請允許 LINE 使用定位後再試一次' } };
  if (pick.status === 'ambiguous') return { fail: { ok: false, code: 'ambiguous', reason: '定位不夠準，分不出你在哪一家店', hint: '請開啟手機的「精確位置」與 Wi‑Fi 後再試一次' } };
  if (pick.status === 'none') {
    return { fail: { ok: false, code: 'out_of_range',
      reason: '你不在任何打卡地點範圍內（最近的是' + (pick.nearest ? pick.nearest.name : '—') + '，約 ' + pick.distance_m + ' 公尺）',
      hint: '人在店裡的話，請開啟「精確位置」與 Wi‑Fi 後再試一次',
      nearest: pick.nearest ? { name: pick.nearest.name, lat: pick.nearest.lat, lng: pick.nearest.lng, radius_m: pick.nearest.radius_m } : null } };
  }
  var st = pick.store, ss;
  try { ss = lineHubSS_(st); } catch (e) { return { fail: { ok: false, store_name: st.name, reason: '「' + st.name + '」的系統暫時連不上', hint: '請稍後再試；一直不行請告知主管' } }; }
  var me = lineHubSheetRows_(ss, 'roster').filter(function (r) {
    return lineHubActive_(r) && r.line_user_id && String(r.line_user_id) === String(userId);
  })[0];
  if (!me) {
    // 跨店：這個 LINE 在別家店已綁定、名字唯一，這家店名冊有同名且還沒被綁的在職同仁 → 帶出名字請本人確認
    // （v2 審查 #7：不靜默自動綁，避免同名不同人時直接替別人記一張卡）
    var names = {};
    lineHubMine_(userId).forEach(function (m) { names[lineHubNormName_(m.row.name)] = String(m.row.name); });
    var nameKeys = Object.keys(names), suggest = '';
    if (nameKeys.length === 1) {
      var cand = lineHubSheetRows_(ss, 'roster').filter(function (r) {
        return lineHubActive_(r) && lineHubNormName_(r.name) === nameKeys[0];
      });
      if (cand.length === 1 && !cand[0].line_user_id) suggest = names[nameKeys[0]];
    }
    return { fail: { ok: false, code: 'not_bound', store_name: st.name, suggest_name: suggest,
             reason: '你的 LINE 帳號還沒有綁定「' + st.name + '」',
             hint: '請在打卡畫面輸入你的全名完成綁定；名冊上沒有你請主管把你加進去' } };
  }
  var events = lineHubSheetRows_(ss, 'events').map(function (e) { e.ts = normCellTs(e.ts); return e; });
  return { fix: fix, st: st, ss: ss, me: me, events: events };
}

/** 選上班／下班的防呆，與網頁版 clock.html updateButtonStates 同規則：
 *  最後一張算數的卡（lastCountedEvent，往回 12 小時）是什麼型別，就不能再打同型（blocked）；
 *  打完那張後 10 分鐘內不能打另一型（lock_until）。 */
function lineHubGuard_(events, empId) { return liffGuard_(events, empId); }

/**
 * {action:'line_hub_status', id_token, lat, lng, accuracy}（打卡畫面開啟時）
 * → {ok, status:'ready', name, store:{code,name,lat,lng,radius_m}, shift_in, shift_out, today:[{type,hm,status}], guard}
 *   或 {ok, status:'fail', result:<同打卡失敗格式，含 code>}
 */
function handleLineHubStatus_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('st', userId, 30, 60)) return { ok: false, error: 'too_many' };   // 每人每分鐘 30 次（審查 L7）
  var r = lineHubResolve_(userId, body);
  if (r.fail) return { ok: true, status: 'fail', result: r.fail };
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var mine = r.events.filter(function (e) { return String(e.emp_id) === String(r.me.emp_id) && String(e.ts).slice(0, 10) === today; })
    .map(function (e) { return { type: String(e.type), hm: lineHubHm_(e.ts), status: String(e.status) }; });
  var g = lineHubGuard_(r.events, r.me.emp_id);
  return { ok: true, status: 'ready', name: String(r.me.name),
           store: { code: r.st.code, name: r.st.name, lat: r.st.lat, lng: r.st.lng, radius_m: r.st.radius_m },
           shift_in: normShiftTime(r.me.shift_in), shift_out: normShiftTime(r.me.shift_out),
           today: mine, guard: { blocked: g.blocked, lock: g.lock, last: g.last, now: Date.now() } };
}

function lineHubQuickClockFor_(userId, body) {
  var r = lineHubResolve_(userId, body);
  if (r.fail) return r.fail;
  var fix = r.fix, st = r.st, me = r.me, events = r.events, autoNote = '';
  var type;
  if (body.type === 'in' || body.type === 'out') {
    // 同仁自己選上班／下班（Eason 2026-10-08 改回手選）：防呆與網頁版相同
    type = body.type;
    var stop = liffGuardReject_(lineHubGuard_(events, me.emp_id), type);
    if (stop) return { ok: false, type: type, store_name: st.name, reason: stop.reason, hint: stop.hint };
  } else {
    // 舊版前端（沒帶 type）：自動判斷
    var last = lineHubLastCounted_(events, me.emp_id);
    type = last && last.type === 'in' ? 'out' : 'in';
    if (last) {
      var lastMs = new Date(String(last.ts)).getTime();
      var leftMs = lastMs + LIFF_LOCK_MIN * 60000 - Date.now();
      if (!isNaN(lastMs) && leftMs > 0) {
        var lastLabel = last.type === 'in' ? '上班' : '下班';
        return { ok: false, type: type, store_name: st.name,
                 reason: '你 ' + lineHubHm_(last.ts) + ' 剛打過' + lastLabel + '卡，' + Math.ceil(leftMs / 60000) + ' 分鐘內不能再打（避免連按誤打）',
                 hint: '真的要' + (type === 'out' ? '下班' : '上班') + '請告知主管補登' };
      }
    }
  }
  // 裝置碼：LINE 身分已經擋住「連結轉傳代打」（LINE 帳號綁在本人手機上），所以沿用名冊上已綁定的裝置碼，
  // 否則同仁第一次從 LINE 打卡（LINE 內建瀏覽器與 Safari 是不同裝置碼）會整批變成「新裝置待核准」。
  // 名冊還沒綁裝置的人，用 'line:<userId>' 讓後端照原本規則自動綁定。
  var deviceId = me.device_id ? String(me.device_id) : 'line:' + userId;
  var payload = { action: 'liff_clock', id_token: body.id_token, type: type, lat: fix.lat, lng: fix.lng,
                  accuracy: fix.accuracy_m === undefined ? null : fix.accuracy_m, device_id: deviceId };
  var j = lineHubCallStore_(st, payload);
  if (!j) return { ok: false, type: type, store_name: st.name, reason: '「' + st.name + '」的系統沒有回應，不確定這筆有沒有進去',
                   hint: '請先按選單「出勤紀錄」看今天有沒有這筆；沒有再按一次「打卡」' };
  if (j.ok && j.status === 'ok') return { ok: true, type: type, ts: j.ts, store_name: st.name, note: autoNote };
  var reasons = {
    pending_device_approval: ['這支手機還沒被核准', '已送出待核准，請主管在值班核定頁核准'],
    rejected_out_of_range: ['店家判定你不在範圍內', '請開啟「精確位置」與 Wi‑Fi 後再按一次'],
    rejected_duplicate: ['這一筆和上一筆重複', '請按「出勤紀錄」確認今天的紀錄'],
  };
  var rr = reasons[j.status] || reasons[j.error] || ['系統回覆：' + (j.status || j.error || '未知'), '請告知主管'];
  return { ok: false, type: type, store_name: st.name, reason: rr[0], hint: rr[1] };
}

/* ── webhook：只做「讀暫存回覆」與「查詢回覆」，不做綁定（綁定在 LIFF 頁，需要 LINE 身分憑證）── */
/** 聊天室顯示「輸入中」動畫（LINE 免費功能，不算訊息額度）：同仁按選單後馬上看到有反應。失敗不影響回覆。 */
function lineHubLoading_(userId) {
  var token = (typeof LINE_HUB_BOT_TOKEN !== 'undefined') ? LINE_HUB_BOT_TOKEN : '';
  if (!token || !userId) return;
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify({ chatId: userId, loadingSeconds: 20 }) });
  } catch (e) { /* 只是動畫 */ }
}
function lineHubReply_(replyToken, texts) {
  var token = (typeof LINE_HUB_BOT_TOKEN !== 'undefined') ? LINE_HUB_BOT_TOKEN : '';
  if (!token || !replyToken) return;
  var resp = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken,
      // 字串＝文字訊息；物件＝已組好的 LINE 訊息（例如薪資卡片 Flex），原樣送出
      messages: texts.slice(0, 5).map(function (t) {
        return (t && typeof t === 'object') ? t : { type: 'text', text: String(t).slice(0, 4900) };
      }) }),
  });
  // 回覆失敗（例如卡片格式被 LINE 拒收）要留 log，否則線上完全看不出同仁為什麼沒收到（Flex 審查 #8）
  var code = resp && resp.getResponseCode ? resp.getResponseCode() : 200;
  if (code < 200 || code >= 300) console.error('LINE reply ' + code + ': ' + String(resp.getContentText()).slice(0, 200));
}

/** 這個 LINE 帳號綁了哪幾家店 → [{st, row}]（webhook 沒有 id_token，用 LINE 送來的 userId） */
/** info（選填）：有店名冊讀不到時設 info.unreadable = true（機器人「打卡」不能因此說沒打卡——階段 2 審查 #9）。 */
/* 速度（2026-10-09 Eason：點選單要 10 秒）：每次都要開五家店試算表找人，是最慢的一段。
   找到的結果記 5 分鐘（只記店代碼＋emp_id／姓名，不記金鑰）；綁定成功時 lineHubForget_ 立刻清掉。
   代價：主管在店家那邊「解除綁定」後，最多 5 分鐘內機器人還認得這個 LINE 帳號（打卡畫面不受影響，它直接問店家）。
   有店讀不到時不記，下次重查。 */
var LINE_HUB_MINE_TTL = 300;
function lineHubForget_(userId) {
  CacheService.getScriptCache().removeAll(['lhm:' + userId, 'lhv:' + userId, 'lhp:' + userId]);
}
/** view＝true：查詢用，含離職 60 天內（lineHubCanView_）；預設只算在職（綁定、打卡相關） */
function lineHubMine_(userId, info, view) {
  var cache = CacheService.getScriptCache(), key = (view ? 'lhv:' : 'lhm:') + userId, hit = cache.get(key);
  if (hit) {
    try {
      var stores = lineHubStores_(), got = [];
      JSON.parse(hit).forEach(function (x) {
        var st = stores.filter(function (s) { return String(s.code) === String(x.c); })[0];
        if (st) got.push({ st: st, row: { emp_id: x.e, name: x.n } });
      });
      return got;
    } catch (e) { /* 壞掉就重查 */ }
  }
  var out = [], bad = false;
  lineHubStores_().forEach(function (st) {
    var rows = null;
    try { rows = lineHubRoster_(st); } catch (e) { rows = null; bad = true; if (info) info.unreadable = true; }
    (rows || []).forEach(function (r) {
      if ((view ? lineHubCanView_(r) : lineHubActive_(r)) && r.line_user_id && String(r.line_user_id) === String(userId)) out.push({ st: st, row: r });
    });
  });
  if (!bad) {
    cache.put(key, JSON.stringify(out.map(function (m) { return { c: m.st.code, e: String(m.row.emp_id), n: String(m.row.name) }; })), LINE_HUB_MINE_TTL);
  }
  return out;
}

/** 方案 C（2026-10-08）：打卡畫面改成直接打各店、光復不再有暫存 → 機器人收到「打卡」時，
 *  查這個 LINE 帳號在已綁定各店最近 LINE_HUB_LATEST_SEC 秒內最新一筆成功的卡（打卡畫面只在成功時才代送「打卡」）。
 *  問候語用同一個打卡時間算（liffGreeting_），與畫面上那句相同。
 *  每家店只讀 events 尾端 LINE_HUB_TAIL_ROWS 列（appendRow 一定加在最後；光復 events 上萬列，整張讀太慢——階段 2 審查 #1）。
 *  回傳：打卡結果物件／null（真的沒有）／{unreadable:true}（有店讀不到、又沒找到，不能說「沒有打卡」——審查 #8）。 */
var LINE_HUB_LATEST_SEC = 300;
var LINE_HUB_TAIL_ROWS = 200;
function lineHubTailRows_(ss, name, n) {
  var sh = ss.getSheetByName(name);
  if (!sh) return [];
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2 || cols < 1) return [];
  var headers = sh.getRange(1, 1, 1, cols).getValues()[0];
  var from = Math.max(2, last - n + 1);
  return sh.getRange(from, 1, last - from + 1, cols).getValues().map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}
function lineHubLatestPunch_(userId) {
  var best = null, info = {}, unreadable = false, cutoff = Date.now() - LINE_HUB_LATEST_SEC * 1000;
  var mine = lineHubMine_(userId, info);
  unreadable = !!info.unreadable;
  mine.forEach(function (m) {
    var rows;
    try { rows = lineHubTailRows_(lineHubSS_(m.st), 'events', LINE_HUB_TAIL_ROWS); } catch (e) { unreadable = true; return; }
    rows.forEach(function (e) {
      if (String(e.emp_id) !== String(m.row.emp_id) || String(e.status) !== 'ok') return;
      var ts = String(normCellTs(e.ts)), t = new Date(ts).getTime();
      if (isNaN(t) || t < cutoff) return;
      if (!best || t > best.ms) best = { ms: t, ts: ts, type: String(e.type), store_name: m.st.name, rows: rows, emp_id: m.row.emp_id };
    });
  });
  // 忘打卡提醒：用同一家店讀到的尾端列判斷（與打卡畫面 liff_punch 同一支 liffMissedNote_）；尾端沒涵蓋到就不提
  if (best) return { ok: true, type: best.type, ts: best.ts, store_name: best.store_name, greeting: liffGreeting_(best.type, best.ts),
                     missed: liffMissedNote_(best.rows, best.emp_id, best.type, best.ts) };
  return unreadable ? { unreadable: true } : null;
}

/* 打卡後特休到期提醒（2026-10-09 Eason）：特休還有剩、最後一天在 30 天內 → 打卡回覆卡片多一行。
   每人每天最多算一次（CacheService 'lha:<userId>:<日期>'，要提醒／不用提醒都記，避免每次打卡都去算薪資）；
   CacheService 最長 6 小時，所以 TTL 取「到今天午夜」與 6 小時的較小者——早晚班相隔超過 6 小時可能再提醒一次（可接受）。
   查薪資失敗一律不提，絕不能讓打卡回覆壞掉。 */
var LINE_HUB_ANNUAL_WARN_DAYS = 30;
function lineHubAnnualNote_(userId, ts) {
  try {
    var today = String(ts || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    var c = CacheService.getScriptCache(), key = 'lha:' + userId + ':' + today;
    if (c.get(key)) return '';
    var note = lineHubAnnualNoteText_(lineHubPayslipFor_(userId), today);
    var midnight = new Date(today + 'T00:00:00+08:00').getTime() + 86400000;
    var ttl = Math.max(60, Math.min(21600, Math.floor((midnight - Date.now()) / 1000)));
    c.put(key, note ? '1' : '0', ttl);
    return note;
  } catch (e) { return ''; }
}
/** 純計算（測試用）：j＝payMyPayslipFor_ 結果；today＝台北日期。 */
function lineHubAnnualNoteText_(j, today) {
  var an = j && j.ok ? lineHubAnnual_(j.annual) : null;
  if (!an || !(an.left_h > 0)) return '';
  var days = Math.round((Date.UTC(+an.last.slice(0, 4), +an.last.slice(5, 7) - 1, +an.last.slice(8, 10)) -
                         Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))) / 86400000);
  if (days < 0 || days > LINE_HUB_ANNUAL_WARN_DAYS) return '';
  return '🗓 你的特休還剩 ' + an.left_h + ' 小時，' + an.md + ' 到期，記得跟店長排休';
}

var LINE_HUB_NOT_BOUND_TEXT = '你的 LINE 帳號還沒綁定打卡系統。\n請到你上班的店，按選單的「打卡」，第一次會請你輸入全名完成綁定。';

/** 出勤異常字樣（2026-10-09 Eason：同仁看得到紅字）：已核定＝核定狀態（不是「正常」才列）；還沒核定＝那天的打卡註記
 *  （下班忘刷卡／上班忘刷卡；「上班中」不算異常）。回空字串＝沒異常。 */
function lineHubDayStatus_(d) {
  var parts = [];
  if (d.approved_status && d.approved_status !== '正常') parts.push(String(d.approved_status));
  if (d.approved === null || d.approved === undefined) {
    (d.notes || []).forEach(function (x) { x = String(x); if (x && x !== '上班中' && parts.indexOf(x) < 0) parts.push(x); });
  }
  return parts.join('、');
}

function lineHubAttendanceText_(userId) {
  var a = lineHubAttendanceData_(userId);
  if (!a) return LINE_HUB_NOT_BOUND_TEXT;
  var body = '📋 最近 7 天出勤\n' + (a.lines.length ? a.lines.map(function (l) {
    return l.day + l.store + '\n　' + (l.segs || '—') + '｜' + l.hrs + (l.status ? '｜⚠️ ' + l.status : '');
  }).join('\n') : '最近 7 天沒有打卡紀錄');
  if (a.tot) body += '\n\n' + a.tot.curText + '\n' + a.tot.prevText;
  return body;
}

/** 出勤資料（文字與卡片共用）：null＝沒綁定；{lines:[{day,store,segs,hrs,status}], tot:{curText,prevText,curLabel,curH,curP,prevLabel,prevH,prevP}} */
function lineHubAttendanceData_(userId) {
  var mine = lineHubMine_(userId, null, true);
  if (!mine.length) return null;
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var cut = Utilities.formatDate(new Date(Date.now() - 6 * 86400000), 'Asia/Taipei', 'yyyy-MM-dd');
  var lines = [], tot = null, wk = ['日', '一', '二', '三', '四', '五', '六'];
  mine.forEach(function (m) {
    var ss = lineHubSS_(m.st);
    var events = lineHubSheetRows_(ss, 'events').map(function (e) { e.ts = normCellTs(e.ts); return e; });
    var amap = buildLatestApprovedMap(lineHubSheetRows_(ss, 'approved'));
    buildRecentDays(events, m.row.emp_id, today, amap).forEach(function (d) {
      if (d.date < cut) return;
      var segs = (d.segments || []).map(function (g) { return (g.in || '？') + '–' + (g.out || '？'); }).join('、');
      var hrs = (d.approved === null || d.approved === undefined) ? '待核定' : '核定 ' + d.approved + 'h';
      lines.push({ k: d.date + m.st.name, store: m.st.name, segs: segs, hrs: hrs,
        day: parseInt(d.date.slice(5, 7), 10) + '/' + parseInt(d.date.slice(8, 10), 10) + '（' + wk[new Date(d.date + 'T12:00:00Z').getUTCDay()] + '）',
        status: lineHubDayStatus_(d) });
    });
    var mt = monthTotalsFor(amap, m.row.emp_id, events, today);
    if (mt && mt.current) {
      if (!tot) tot = { cur: { ym: mt.current.ym, h: 0, p: 0 }, prev: { ym: mt.previous.ym, h: 0, p: 0 } };
      tot.cur.h += mt.current.hours || 0; tot.cur.p += mt.current.pending_days || 0;
      tot.prev.h += mt.previous.hours || 0; tot.prev.p += mt.previous.pending_days || 0;
    }
  });
  lines.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
  var t = null;
  if (tot) {
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var cm = parseInt(tot.cur.ym.slice(5), 10), pm = parseInt(tot.prev.ym.slice(5), 10);
    t = { curLabel: '本月（' + cm + ' 月）核定合計', curH: r2(tot.cur.h), curP: tot.cur.p,
          prevLabel: '上月（' + pm + ' 月）核定合計', prevH: r2(tot.prev.h), prevP: tot.prev.p };
    t.curText = t.curLabel + ' ' + t.curH + ' 小時' + (t.curP ? '，尚有 ' + t.curP + ' 天待核定' : '');
    t.prevText = t.prevLabel + ' ' + t.prevH + ' 小時' + (t.prevP ? '，尚有 ' + t.prevP + ' 天待核定' : '');
  }
  return { lines: lines, tot: t };
}

/** 薪資／假別：用 LINE 身分在薪資有接的店找人（與 line_my_payslip 同一套挑法） */
function lineHubPayslipFor_(userId, ym) {
  var pick = lineHubPayPick_(userId);
  if (!pick) return null;
  return payMyPayslipFor_(pick.me, pick.store, ym || currentYmTaipei());
}
/** 用 LINE 身分在薪資有接的店找人：{me, store} 或 null（有薪資主檔的那家優先） */
function lineHubPayPick_(userId) {
  var cache = CacheService.getScriptCache(), key = 'lhp:' + userId, hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 重查 */ } }
  var found = lineHubPayPickFresh_(userId);
  if (found) cache.put(key, JSON.stringify({ me: { emp_id: String(found.me.emp_id), name: String(found.me.name) }, store: found.store }), LINE_HUB_MINE_TTL);
  return found;
}
function lineHubPayPickFresh_(userId) {
  var hits = [];
  payStoreList().forEach(function (s) {
    var code = String(s.code), rs = [];
    try { rs = payClockRead(code, 'roster'); } catch (e) { return; }
    rs.forEach(function (r) {
      if (lineHubCanView_(r) && r.line_user_id && String(r.line_user_id) === String(userId)) hits.push({ me: r, store: code });
    });
  });
  if (!hits.length) return null;
  var masterIds = {};
  payRead('master').forEach(function (m) { masterIds[String(m.emp_id)] = true; });
  return hits.filter(function (h) { return masterIds[String(h.me.emp_id)]; })[0] || hits[0];
}
/** 薪資卡只要「那個月的薪資單」：不像 payMyPayslipFor_ 還算特休額度與年資（那兩樣最慢，卡片又用不到）。
 *  回傳形狀與 payMyPayslipFor_ 已定案時相同（lineHubPayFlex_ 吃得下）。 */
function lineHubPayslipLite_(pick, ym) {
  var mm = payRead('master').filter(function (m) { return String(m.emp_id) === String(pick.me.emp_id); })[0];
  var st = payStore((mm && mm.store) || pick.store);
  var run = payRead('run').filter(function (r) {
    return String(r.ym) === ym && String(r.emp_id) === String(pick.me.emp_id) && payStore(r.store) === st;
  })[0];
  if (!run || String(run.status) !== 'final') return { ok: true, ym: ym, name: pick.me.name, ready: false, message: run ? '本月薪資結算中，尚未定案' : '本月薪資尚未結算' };
  var items = payRead('item').filter(function (i) {
    return String(i.ym) === ym && String(i.emp_id) === String(pick.me.emp_id) && payStore(i.store) === st;
  });
  return { ok: true, ym: ym, name: pick.me.name, ready: true, result: payRunItemsToResult(run, items), payday: payConfig().payday };
}
/** 這個人已定案的薪資月份（新到舊，最多 LINE_HUB_PAY_MONTHS 個）。店別照 payMyPayslipFor_：主檔為準。 */
var LINE_HUB_PAY_MONTHS = 12;
function lineHubPayFinalMonths_(pick) {
  var mm = payRead('master').filter(function (m) { return String(m.emp_id) === String(pick.me.emp_id); })[0];
  var st = payStore((mm && mm.store) || pick.store), seen = {};
  return payRead('run').filter(function (r) {
    return String(r.emp_id) === String(pick.me.emp_id) && payStore(r.store) === st && String(r.status) === 'final' && /^\d{4}-\d{2}$/.test(String(r.ym));
  }).map(function (r) { return String(r.ym); })
    .filter(function (y) { if (seen[y]) return false; seen[y] = true; return true; })
    .sort().reverse().slice(0, LINE_HUB_PAY_MONTHS);
}

var LINE_HUB_NO_PAYROLL_TEXT = '你上班的店還沒接上薪資系統，薪資與假別請先找店長確認。';
function lineHubPayText_(userId, pre) {
  var j = pre === undefined ? lineHubPayslipFor_(userId) : pre;
  if (!j) return lineHubMine_(userId, null, true).length ? LINE_HUB_NO_PAYROLL_TEXT : LINE_HUB_NOT_BOUND_TEXT;
  if (!j.ok) return '查不到你的薪資資料，請找店長確認。';
  var t = '💰 ' + j.ym.replace('-', ' 年 ') + ' 月薪資\n';
  if (!j.ready) return t + (j.message || '尚未結算') + '\n（結算定案後這裡就會顯示明細）';
  var res = j.result || {};
  var nf = function (v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); };
  t += '實付：' + nf(res.net) + ' 元\n應發：' + nf(res.gross) + ' 元｜扣款：' + nf(res.deduction) + ' 元';
  if (j.payday) t += '\n發薪日：' + j.payday;
  return t + '\n（完整明細請找店長或從打卡頁「我的薪資」查看）';
}

/* ── 薪資卡片（Eason 2026-10-08 選 C：LINE Flex 卡片，實付放最上面、金額靠右）──
 * 項目與網頁版「我的薪資」（clock.html payLine）同一份資料、同一套小字（數量 H × 單價）。
 * 尚未結算／定案、沒綁定、店家沒接薪資 → 照舊回文字。 */
var LINE_HUB_HOURLY_KEYS = ['overtime', 'shortfall_hours', 'personal_leave', 'sick_leave', 'menstrual_leave',
                            'disaster_leave', 'hourly_wage', 'pt_attend_plus', 'pt_tenure_plus'];   // 與 clock.html HOURY 相同
function lineHubNf_(v) { return Math.round(Number(v) || 0).toLocaleString('en-US'); }
function lineHubR2_(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function lineHubPayLineSub_(x) {
  if (x.qty === null || x.qty === undefined) return '';
  return lineHubR2_(x.qty) + (LINE_HUB_HOURLY_KEYS.indexOf(x.item_key) !== -1 ? 'H' : '') +
         (x.rate ? ' × ' + (+x.rate).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '');
}
/** LINE Flex 的 text 不收空字串（整則回覆會 400、同仁收不到），所有顯示字串都過這支 */
function lineHubTxt_(v) { var t = (v === null || v === undefined) ? '' : String(v); return t === '' ? '—' : t; }
function lineHubHours_(v) { var n = Number(v); return isFinite(n) ? lineHubR2_(n) + ' H' : '—'; }
var LINE_HUB_WARN_COLOR = '#c22a12';
function lineHubFlexRow_(label, value, opts) {
  opts = opts || {};
  var left = { type: 'box', layout: 'vertical', flex: 5, contents: [
    { type: 'text', text: lineHubTxt_(label), size: 'sm', color: opts.muted ? '#8a817a' : '#222222', wrap: true }] };
  // warn：小字改紅色（出勤異常，2026-10-09）
  if (opts.sub) left.contents.push({ type: 'text', text: opts.sub, size: 'xxs', color: opts.warn ? LINE_HUB_WARN_COLOR : '#8a817a', wrap: true, weight: opts.warn ? 'bold' : 'regular' });
  return { type: 'box', layout: 'horizontal', margin: 'sm', contents: [left,
    { type: 'text', text: lineHubTxt_(value), size: 'sm', align: 'end', flex: 3, wrap: true, color: opts.muted ? '#8a817a' : '#222222',
      weight: opts.bold ? 'bold' : 'regular' }] };
}
/* 2026-10-09 Eason 選 A：分區塊＋淡色系（實付淡綠／工時淡藍／加項淡黃／扣項淡紅／其他淡灰），每區整塊淡色底。
 * 項目、金額、小字規則都不變（與網頁「我的薪資」一致），只改排版。 */
var LINE_HUB_PAY_TONE = {
  net:   { bg: '#eaf6ee', fg: '#1e7d4f', sub: '#5f7a6b' },
  hours: { bg: '#edf3fa', fg: '#2b5c8a' },
  earn:  { bg: '#fdf7e6', fg: '#8a6100', line: '#ecdcae' },
  ded:   { bg: '#fcefed', fg: '#b03a26', line: '#efc9c2' },
  misc:  { bg: '#f4f4f2', fg: '#6b6b66' },
};
function lineHubPaySection_(key, title, rows) {
  var t = LINE_HUB_PAY_TONE[key];
  return { type: 'box', layout: 'vertical', margin: 'md', backgroundColor: t.bg, cornerRadius: '10px', paddingAll: '10px',
           contents: [{ type: 'text', text: title, size: 'xs', weight: 'bold', color: t.fg }].concat(rows) };
}
function lineHubPayFlex_(j) {
  var res = j.result || {};
  var ymLabel = parseInt(String(j.ym).slice(5, 7), 10) + ' 月薪資';
  var T = LINE_HUB_PAY_TONE;
  var body = [{ type: 'box', layout: 'vertical', margin: 'none', backgroundColor: T.net.bg, cornerRadius: '10px', paddingAll: '12px', contents: [
    { type: 'text', text: '實付金額', size: 'xs', color: T.net.fg },
    { type: 'text', text: 'NT$ ' + lineHubNf_(res.net), size: 'xxl', weight: 'bold', color: T.net.fg },
    { type: 'text', text: '應收 ' + lineHubNf_(res.gross) + '　－　應付 ' + lineHubNf_(res.deduction), size: 'xxs', color: T.net.sub, margin: 'xs' }] }];
  var hours = [lineHubFlexRow_('核定工時', lineHubHours_(res.total_hours))];
  if (res.support_hours) hours.push(lineHubFlexRow_('跨店支援時數', lineHubHours_(res.support_hours)));
  if (res.base_hours !== null && res.base_hours !== undefined && res.base_hours !== '') hours.push(lineHubFlexRow_('基本工時', lineHubHours_(res.base_hours)));
  if (res.ot_paid_hours) hours.push(lineHubFlexRow_('計薪加班', lineHubHours_(res.ot_paid_hours)));
  body.push(lineHubPaySection_('hours', '工時', hours));
  // 與網頁「我的薪資」（clock.html payLine）一致：0 元也照列——薪資引擎刻意保留「事假 8H $0」「全勤獎金（遲到 N 次）$0」
  // 這類資訊列（Payroll.gs 註解：該扣卻扣到 0 必須照印），兩邊才對得起來（Flex 審查 #3）
  var earn = (res.earn || []).map(function (x) { return lineHubFlexRow_(x.item_label, lineHubNf_(x.amount), { sub: lineHubPayLineSub_(x) }); });
  earn.push({ type: 'separator', margin: 'md', color: T.earn.line });
  earn.push(lineHubFlexRow_('應收合計', lineHubNf_(res.gross), { bold: true }));
  body.push(lineHubPaySection_('earn', '加項', earn));
  // 扣項金額與網頁一致：不加負號、不取絕對值（手動補發是負的扣項，取絕對值會變成多扣）（Flex 審查 #4）
  var deds = res.ded || [];
  var ded = deds.length ? deds.map(function (x) { return lineHubFlexRow_(x.item_label, lineHubNf_(x.amount), { sub: lineHubPayLineSub_(x) }); })
                        : [lineHubFlexRow_('無', '—', { muted: true })];
  ded.push({ type: 'separator', margin: 'md', color: T.ded.line });
  ded.push(lineHubFlexRow_('應付合計', lineHubNf_(res.deduction), { bold: true }));
  body.push(lineHubPaySection_('ded', '扣項', ded));
  if (j.payday) {
    var pd = String(j.payday);
    body.push(lineHubPaySection_('misc', '其他', [lineHubFlexRow_('發薪日', /^\d+$/.test(pd) ? '每月 ' + pd + ' 日' : pd, { muted: true })]));
  }
  return {
    type: 'flex',
    altText: ymLabel + '明細已送達',   // 推播預覽／鎖屏不露金額（Flex 審查 #9）
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'horizontal', backgroundColor: '#ffffff', paddingAll: '12px', paddingBottom: '4px', contents: [
        { type: 'text', text: ymLabel, weight: 'bold', color: '#222222', size: 'md' },
        { type: 'text', text: '已定案', align: 'end', color: '#1e7d4f', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', paddingTop: '6px', contents: body },
    },
  };
}
/** （2026-10-08 起 webhook 改用 lineHubPayCard_；這支留作文字版備用與測試用）「薪資明細」：已定案 → 卡片；其他情況 → 文字 */
function lineHubPayMessage_(userId) {
  var j = lineHubPayslipFor_(userId);
  if (j && j.ok && j.ready) return lineHubPayFlex_(j);
  return lineHubPayText_(userId, j);
}

/* 特休（2026-10-09 Eason）：payMyPayslipFor_ 的 annual {days, quota_h, used_h, left_h, ps, pe}，pe 不含（最後一天＝pe 前一天）。
   假別額度卡第一列放特休；正職只有特休額度時，舊版會說「沒有需要顯示的額度」——改掉。 */
function lineHubMd_(d) { return parseInt(String(d).slice(5, 7), 10) + '/' + parseInt(String(d).slice(8, 10), 10); }
/** annual → {left_h, quota_h, last, md}；沒有特休（計時同仁、或資料不全）回 null。 */
function lineHubAnnual_(a) {
  if (!a || !/^\d{4}-\d{2}-\d{2}/.test(String(a.pe || ''))) return null;
  var r1 = function (v) { return Math.round((Number(v) || 0) * 10) / 10; };
  var last = payDayBefore(String(a.pe).slice(0, 10));
  return { left_h: r1(a.left_h), quota_h: r1(a.quota_h), last: last, md: lineHubMd_(last) };
}
function lineHubLeaveText_(userId) {
  var j = lineHubPayslipFor_(userId);
  if (!j) return lineHubMine_(userId, null, true).length ? LINE_HUB_NO_PAYROLL_TEXT : LINE_HUB_NOT_BOUND_TEXT;
  if (!j.ok) return '查不到你的假別資料，請找店長確認。';
  var list = j.leave_quota || [], an = lineHubAnnual_(j.annual);
  if (!list.length && !an) return '📅 假別額度\n你目前沒有需要顯示的假別額度（計時同仁不適用特休等額度）。';
  var r1 = function (v) { return Math.round((Number(v) || 0) * 10) / 10; };
  var head = an ? '・特休假：剩 ' + an.left_h + ' 小時（共 ' + an.quota_h + ' 小時，' + an.md + ' 到期，未休完依法折算工資）\n' : '';
  return '📅 今年假別額度（已請／剩餘）\n' + head + list.map(function (q) {
    var used = q.used_days ? r1(q.used_h) + 'H' : '未請過';
    var rem = q.cap_days == null ? '無上限' : (q.basis === 'event' ? '每次上限 ' + r1(q.cap_h) + 'H'
      : (q.remain_h < 0 ? '超出 ' + r1(-q.remain_h) + 'H' : r1(q.remain_h) + 'H／上限 ' + r1(q.cap_h) + 'H'));
    return '・' + q.name + '：' + used + '｜' + rem;
  }).join('\n') + '\n（數字來自店長登記的請假紀錄，有出入請找店長）';
}

/* ══════ 卡片式訊息（Eason 2026-10-08：機器人回覆全部改成卡片）══════
 * 共用版型：上方色帶標題（綠＝成功／一般、橘＝失敗或提醒）、內文列（左項目右數值，可帶灰色小字）、整列文字、底部灰字。
 * ⚠ LINE Flex 的 text 不收空字串，一律過 lineHubTxt_。altText 是手機通知預覽，**不放金額與時數**。 */
var LINE_HUB_TONE = { ok: ['#e3f1e8', '#1e7d4f'], warn: ['#fbeee2', '#a15a00'], info: ['#eef2f1', '#2a6b5e'] };
function lineHubFlexText_(text, opts) {
  opts = opts || {};
  var t = { type: 'text', text: lineHubTxt_(text), size: opts.size || 'sm', color: opts.color || '#222222', wrap: true };
  if (opts.margin) t.margin = opts.margin;
  if (opts.bold) t.weight = 'bold';
  return t;
}
/** spec：{title, right?, tone?, alt, hero?:{label,value}, blocks:[ {type:'row',l,r,sub,bold,muted,warn} | {type:'text',text,muted,margin} | {type:'heading',text} | {type:'sep'} ], foot?} */
function lineHubCard_(spec) {
  var tone = LINE_HUB_TONE[spec.tone || 'info'];
  var head = [{ type: 'text', text: lineHubTxt_(spec.title), weight: 'bold', color: tone[1], size: 'md', wrap: true, flex: 3 }];
  if (spec.right) head.push({ type: 'text', text: lineHubTxt_(spec.right), align: 'end', color: tone[1], size: 'sm', flex: 2 });
  var body = [];
  if (spec.hero) {
    body.push({ type: 'text', text: lineHubTxt_(spec.hero.label), size: 'xs', color: '#8a817a' });
    body.push({ type: 'text', text: lineHubTxt_(spec.hero.value), size: 'xxl', weight: 'bold', color: tone[1] });
  }
  (spec.blocks || []).forEach(function (b) {
    if (b.type === 'sep') body.push({ type: 'separator', margin: 'md' });
    else if (b.type === 'heading') {
      var hd = { type: 'text', text: lineHubTxt_(b.text), size: 'xs', color: '#8a817a' };
      if (body.length) hd.margin = 'lg';   // 第一個小標不留上方空白
      body.push(hd);
    }
    else if (b.type === 'text') body.push(lineHubFlexText_(b.text, { color: b.muted ? '#8a817a' : '#222222', margin: b.margin || 'sm', size: b.size }));
    else body.push(lineHubFlexRow_(b.l, b.r, { sub: b.sub, bold: b.bold, muted: b.muted, warn: b.warn }));
  });
  if (spec.foot) { body.push({ type: 'separator', margin: 'md' }); body.push(lineHubFlexText_(spec.foot, { color: '#8a817a', margin: 'md', size: 'xs' })); }
  if (!body.length) body.push(lineHubFlexText_('—'));
  var card = { type: 'flex', altText: lineHubTxt_(String(spec.alt || spec.title).trim()).slice(0, 380),
    contents: { type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'horizontal', backgroundColor: tone[0], paddingAll: '12px', contents: head },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: body } } };
  // 按鈕（選填）：每顆按下去＝同仁替自己送出那句文字（message action），機器人再回對應的卡片
  if (spec.buttons && spec.buttons.length) {
    // 按鈕用標準高度、按鈕之間留 12px（2026-10-09 Eason：每一格大一點避免誤按）
    card.contents.footer = { type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '14px',
      contents: spec.buttons.map(function (b) {
        // b.uri＝開網頁（佈告欄）；其餘是 message action
        if (b.uri) return { type: 'button', style: 'primary', color: '#1F4E8C', height: 'md',
                            action: { type: 'uri', label: lineHubTxt_(b.label).slice(0, 20), uri: String(b.uri) } };
        return { type: 'button', style: 'secondary', height: 'md',
                 action: { type: 'message', label: lineHubTxt_(b.label).slice(0, 20), text: lineHubTxt_(b.text).slice(0, 300) } };
      }) };
  }
  // LINE 單張卡片上限 30KB，超過整則被拒收、同仁什麼都收不到：留 2KB 餘裕，超過就退回文字版（審查 #6-2）
  if (JSON.stringify(card).length > 28000 && spec.fallbackText) return spec.fallbackText;
  return card;
}
/** 簡短提示（沒綁定、準備中、按選單…） */
function lineHubNoticeCard_(title, text, tone) {
  return lineHubCard_({ title: title, tone: tone || 'info', alt: title, blocks: [{ type: 'text', text: text }] });
}
/** 打卡結果卡片（與 lineHubPunchText_ 同一份結果物件；小畫面仍顯示文字版） */
function lineHubPunchCard_(r) {
  var label = r.type === 'out' ? '下班' : (r.type === 'in' ? '上班' : '');
  if (r.ok) {
    var blocks = [{ type: 'heading', text: '地點' }, { type: 'text', text: r.store_name, margin: 'xs', size: 'md' }];
    if (r.note) blocks.push({ type: 'text', text: r.note, muted: true });
    if (r.missed) blocks.push({ type: 'sep' }, { type: 'heading', text: '⚠️ 上次漏打卡' }, { type: 'text', text: r.missed, margin: 'xs' });
    if (r.greeting) blocks.push({ type: 'sep' }, { type: 'text', text: r.greeting, margin: 'md', size: 'md' });
    if (r.annual_note) blocks.push({ type: 'text', text: r.annual_note, margin: 'md' });
    return lineHubCard_({ title: label + '打卡成功', right: '✓', tone: 'ok', alt: label + '打卡成功 ' + lineHubHm_(r.ts),
                          hero: { label: '打卡時間', value: lineHubHm_(r.ts) }, blocks: blocks });
  }
  var fb = [{ type: 'heading', text: '原因' }, { type: 'text', text: r.reason }];
  if (r.hint) fb.push({ type: 'heading', text: '怎麼辦' }, { type: 'text', text: r.hint });
  return lineHubCard_({ title: (label || '') + '打卡失敗', tone: 'warn', alt: (label || '') + '打卡失敗', blocks: fb });
}
function lineHubAttendanceCard_(userId) {
  var a = lineHubAttendanceData_(userId);
  if (!a) return lineHubNoticeCard_('還沒綁定', LINE_HUB_NOT_BOUND_TEXT);
  var blocks = [];
  if (!a.lines.length) blocks.push({ type: 'text', text: '最近 7 天沒有打卡紀錄', muted: true });
  a.lines.forEach(function (l, i) {
    if (i) blocks.push({ type: 'sep' });
    blocks.push({ type: 'row', l: l.day + ' ' + (l.segs || '—'), r: l.hrs, sub: l.store + (l.status ? '｜⚠️ ' + l.status : ''), bold: l.hrs !== '待核定', warn: !!l.status });
  });
  if (a.tot) {
    blocks.push({ type: 'heading', text: '核定合計' });
    blocks.push({ type: 'row', l: a.tot.curLabel.replace('核定合計', ''), r: a.tot.curH + ' 小時', sub: a.tot.curP ? '尚有 ' + a.tot.curP + ' 天待核定' : '', bold: true });
    blocks.push({ type: 'row', l: a.tot.prevLabel.replace('核定合計', ''), r: a.tot.prevH + ' 小時', sub: a.tot.prevP ? '尚有 ' + a.tot.prevP + ' 天待核定' : '' });
  }
  var card = lineHubCard_({ title: '最近 7 天出勤', tone: 'info', alt: '最近 7 天出勤紀錄', blocks: blocks,
                            fallbackText: lineHubAttendanceText_(userId) });
  return typeof card === 'string' ? card : lineHubAttendanceMonthButtons_(card, '');
}
function lineHubLeaveCard_(userId) {
  var j = lineHubPayslipFor_(userId);
  if (!j) return lineHubMine_(userId, null, true).length ? lineHubNoticeCard_('假別額度', LINE_HUB_NO_PAYROLL_TEXT, 'warn') : lineHubNoticeCard_('還沒綁定', LINE_HUB_NOT_BOUND_TEXT);
  if (!j.ok) return lineHubNoticeCard_('假別額度', '查不到你的假別資料，請找店長確認。', 'warn');
  var list = j.leave_quota || [], an = lineHubAnnual_(j.annual);
  if (!list.length && !an) return lineHubNoticeCard_('假別額度', '你目前沒有需要顯示的假別額度（計時同仁不適用特休等額度）。');
  var r1 = function (v) { return Math.round((Number(v) || 0) * 10) / 10; };
  var blocks = list.map(function (q) {
    var rem = q.cap_days == null ? '無上限' : (q.basis === 'event' ? '每次上限 ' + r1(q.cap_h) + 'H'
      : (q.remain_h < 0 ? '超出 ' + r1(-q.remain_h) + 'H' : '剩 ' + r1(q.remain_h) + 'H'));
    var sub = (q.used_days ? '已請 ' + r1(q.used_h) + 'H' : '未請過') + (q.cap_days != null && q.basis !== 'event' ? '・上限 ' + r1(q.cap_h) + 'H' : '');
    return { type: 'row', l: q.name, r: rem, sub: sub, bold: true };
  });
  if (an) blocks.unshift({ type: 'row', l: '特休假', r: '剩 ' + an.left_h + ' 小時', sub: '共 ' + an.quota_h + ' 小時・' + an.md + ' 到期（未休完依法折算工資）', bold: true });
  return lineHubCard_({ title: '今年假別額度', tone: 'info', alt: '今年假別額度', blocks: blocks,
                        foot: '數字來自店長登記的請假紀錄，有出入請找店長。', fallbackText: lineHubLeaveText_(userId) });
}
/** 薪資明細（2026-10-09 Eason：可看歷月）：預設＝最新已定案月份的明細，底下按鈕列出其他已定案月份；
 *  「薪資明細 yyyy-MM」＝那個月（只給已定案的）。一個月都還沒定案＝提示卡片。 */
function lineHubYmLabel_(ym, curYm) {
  return String(ym).slice(0, 4) === String(curYm).slice(0, 4) ? parseInt(String(ym).slice(5, 7), 10) + ' 月'
       : String(ym).slice(0, 4) + '/' + parseInt(String(ym).slice(5, 7), 10);
}
function lineHubPayCard_(userId, wantYm) {
  var pick = lineHubPayPick_(userId);
  if (!pick) return lineHubMine_(userId, null, true).length ? lineHubNoticeCard_('薪資明細', LINE_HUB_NO_PAYROLL_TEXT, 'warn') : lineHubNoticeCard_('還沒綁定', LINE_HUB_NOT_BOUND_TEXT);
  var months = lineHubPayFinalMonths_(pick), cur = currentYmTaipei();
  if (!months.length) {
    var j0 = lineHubPayslipLite_(pick, cur);
    return lineHubCard_({ title: parseInt(cur.slice(5, 7), 10) + ' 月薪資', right: '尚未定案', tone: 'info', alt: '薪資明細',
                          blocks: [{ type: 'text', text: (j0 && j0.message) || '本月薪資尚未結算' }, { type: 'text', text: '目前還沒有已定案的薪資單，結算定案後這裡就會顯示明細。', muted: true }] });
  }
  var ym = wantYm || months[0];
  if (months.indexOf(ym) < 0) {
    return lineHubCard_({ title: '薪資明細', tone: 'warn', alt: '薪資明細',
      blocks: [{ type: 'text', text: lineHubYmLabel_(ym, cur) + '的薪資還沒定案，或不在可查詢的範圍（最近 ' + LINE_HUB_PAY_MONTHS + ' 個已定案月份）。' }],
      buttons: months.slice(0, 6).map(function (y) { return { label: lineHubYmLabel_(y, cur), text: '薪資明細 ' + y }; }) });
  }
  var j = lineHubPayslipLite_(pick, ym);
  if (!j || !j.ok || !j.ready) return lineHubNoticeCard_('薪資明細', '查不到 ' + lineHubYmLabel_(ym, cur) + '的薪資單，請找店長確認。', 'warn');
  var card = lineHubPayFlex_(j);
  if (!wantYm && months[0] !== cur) {
    card.contents.body.contents.unshift({ type: 'text', text: parseInt(cur.slice(5, 7), 10) + ' 月薪資還沒定案，先給你最近一個已定案的月份。', size: 'xs', color: '#a15a00', wrap: true, margin: 'none' });
    card.contents.body.contents[1].margin = 'md';   // 說明字與實付色塊之間留空
  }
  var others = months.filter(function (y) { return y !== ym; });
  if (others.length) lineHubAddMonthButtons_(card, others.map(function (y) { return { label: lineHubYmLabel_(y, cur), text: '薪資明細 ' + y }; }), '看其他月份');
  return card;
}
/** 卡片底部加月份按鈕：每列 3 顆、標準高度（2026-10-09 Eason：按鈕大一點避免誤按） */
function lineHubAddMonthButtons_(card, btns, heading) {
  var rows = [{ type: 'text', text: heading, size: 'xs', color: '#8a817a' }];
  for (var i = 0; i < btns.length; i += 3) {
    var row = btns.slice(i, i + 3).map(function (b) {
      return { type: 'button', style: 'secondary', height: 'md', flex: 1,
               action: { type: 'message', label: lineHubTxt_(b.label).slice(0, 20), text: lineHubTxt_(b.text).slice(0, 300) } };
    });
    while (row.length < 3) row.push({ type: 'filler' });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'md', contents: row });
  }
  card.contents.footer = { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px', contents: rows };
  return card;
}

/* 出勤紀錄的月份（2026-10-09 Eason：最久看到上個月）：「出勤紀錄 yyyy-MM」＝那個月每天的打卡與核定。
   每天的資料用 buildRecentDays（40 天視窗）：本月用今天當終點，上個月用月底當終點，一定涵蓋整個月。 */
function lineHubLastDay_(ym) {
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  return ym + '-' + ('0' + new Date(Date.UTC(y, m, 0)).getUTCDate()).slice(-2);
}
function lineHubAttendanceMonthData_(userId, ym) {
  var mine = lineHubMine_(userId, null, true);
  if (!mine.length) return null;
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var end = ym === today.slice(0, 7) ? today : lineHubLastDay_(ym);
  var wk = ['日', '一', '二', '三', '四', '五', '六'], lines = [], hours = 0, pending = 0;
  mine.forEach(function (m) {
    var ss = lineHubSS_(m.st);
    var events = lineHubSheetRows_(ss, 'events').map(function (e) { e.ts = normCellTs(e.ts); return e; });
    var amap = buildLatestApprovedMap(lineHubSheetRows_(ss, 'approved'));
    buildRecentDays(events, m.row.emp_id, end, amap).forEach(function (d) {
      if (d.date.slice(0, 7) !== ym) return;
      var segs = (d.segments || []).map(function (g) { return (g.in || '？') + '–' + (g.out || '？'); }).join('、');
      if (d.approved === null || d.approved === undefined) { if (d.date !== today) pending++; }
      lines.push({ k: d.date + m.st.name, store: m.st.name, segs: segs,
        hrs: (d.approved === null || d.approved === undefined) ? '待核定' : '核定 ' + d.approved + 'h',
        day: parseInt(d.date.slice(5, 7), 10) + '/' + parseInt(d.date.slice(8, 10), 10) + '（' + wk[new Date(d.date + 'T12:00:00Z').getUTCDay()] + '）',
        status: lineHubDayStatus_(d) });
    });
    hours += monthlyApprovedTotal(amap, m.row.emp_id, ym);
  });
  lines.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
  return { ym: ym, lines: lines, hours: Math.round(hours * 100) / 100, pending: pending };
}
function lineHubAttendanceMonthButtons_(card, exceptYm) {
  var cur = currentYmTaipei(), prev = prevYm(cur);
  var b = [{ label: '最近 7 天', text: '出勤紀錄' }, { label: parseInt(cur.slice(5), 10) + ' 月', text: '出勤紀錄 ' + cur },
           { label: parseInt(prev.slice(5), 10) + ' 月', text: '出勤紀錄 ' + prev }];
  // exceptYm：'' ＝目前在「最近 7 天」那張；'yyyy-MM'＝目前在那個月；null＝全部列出
  return lineHubAddMonthButtons_(card, b.filter(function (x) { return x.text !== '出勤紀錄 ' + exceptYm && !(exceptYm === '' && x.text === '出勤紀錄'); }), '看其他期間');
}
function lineHubAttendanceMonthCard_(userId, ym) {
  var cur = currentYmTaipei();
  if (ym !== cur && ym !== prevYm(cur)) {
    return lineHubAttendanceMonthButtons_(lineHubNoticeCard_('出勤紀錄', '出勤紀錄可以查本月和上個月；更早的請找店長。'), null);
  }
  var a = lineHubAttendanceMonthData_(userId, ym);
  if (!a) return lineHubNoticeCard_('還沒綁定', LINE_HUB_NOT_BOUND_TEXT);
  var mLabel = parseInt(ym.slice(5), 10) + ' 月';
  var blocks = [];
  if (!a.lines.length) blocks.push({ type: 'text', text: mLabel + '沒有打卡紀錄', muted: true });
  a.lines.forEach(function (l, i) {
    if (i) blocks.push({ type: 'sep' });
    blocks.push({ type: 'row', l: l.day + ' ' + (l.segs || '—'), r: l.hrs, sub: l.store + (l.status ? '｜⚠️ ' + l.status : ''), bold: l.hrs !== '待核定', warn: !!l.status });
  });
  blocks.push({ type: 'heading', text: '核定合計' });
  blocks.push({ type: 'row', l: mLabel, r: a.hours + ' 小時', sub: a.pending ? '尚有 ' + a.pending + ' 天待核定' : '', bold: true });
  var text = '📋 ' + mLabel + '出勤\n' + (a.lines.length ? a.lines.map(function (l) { return l.day + ' ' + (l.segs || '—') + '｜' + l.hrs + (l.status ? '｜⚠️ ' + l.status : ''); }).join('\n') : '沒有打卡紀錄') +
             '\n\n核定合計 ' + a.hours + ' 小時' + (a.pending ? '，尚有 ' + a.pending + ' 天待核定' : '');
  var card = lineHubCard_({ title: mLabel + '出勤', tone: 'info', alt: mLabel + '出勤紀錄', blocks: blocks, fallbackText: text });
  return typeof card === 'string' ? card : lineHubAttendanceMonthButtons_(card, ym);
}

/* ── 打卡求助：故障排除步驟（2026-10-09 Eason 指定：打卡失敗時自動回覆簡易操作手冊）──
   打卡畫面失敗時多一顆「看排除步驟」，按下＝同仁送出「打卡求助：<類別>」，機器人回對應那張卡；
   只打「打卡求助」＝回目錄（每類一顆按鈕）。⚠ 類別名稱與 clock-line.html 的 offerHelp() 一致，改一邊要改另一邊。 */
var LINE_HUB_HELP = {
  '定位權限': { title: 'LINE 沒有定位權限', steps: [
    ['iPhone', '設定 › LINE › 位置 → 選「使用 App 期間」，並打開「精確位置」'],
    ['安卓', '設定 › 應用程式 › LINE › 權限 › 位置 → 「僅在使用時允許」，並打開「使用精確位置」'],
    ['然後', '回到聊天室，重新按選單「打卡」'] ] },
  '定位抓不到': { title: '定位抓不到', steps: [
    ['1', '確認手機的「定位服務」是開的（iPhone：設定 › 隱私權與安全性 › 定位服務；安卓：下拉選單的「位置」）'],
    ['2', '打開 Wi‑Fi（不用連上任何網路，有開就能幫忙定位）'],
    ['3', '關掉「低耗電／省電模式」，走到門口或窗邊'],
    ['4', '等 10 秒，按畫面上的「重新定位」'],
    ['5', '還是一直「定位中」：把手機重新開機，再從選單按「打卡」'],
    ['6', '都不行：請值班主管在核定頁按「打卡 QR」，用 LINE 掃描打卡'] ] },
  '定位不準': { title: '定位不準（位置飄、誤差大）', steps: [
    ['1', '打開「精確位置」（iPhone：設定 › LINE › 位置；安卓：LINE 權限 › 位置）'],
    ['2', '打開 Wi‑Fi：室內靠 Wi‑Fi 定位比較準，不用連線'],
    ['3', '地圖上你的點跳到很遠（Wi‑Fi 偏移）：改成關掉 Wi‑Fi、走到門口用 GPS 再試'],
    ['4', '等 10～20 秒讓定位穩定，再按「重新定位」'],
    ['5', '還是不準：把手機重新開機再試一次'],
    ['6', '都不行：請值班主管在核定頁按「打卡 QR」，用 LINE 掃描打卡'] ] },
  '不在範圍': { title: '系統說你不在打卡範圍', steps: [
    ['1', '確認人真的在店裡（不是停車場、隔壁或路上）'],
    ['2', '人在店裡還是不行：照「定位不準」的步驟開精確位置與 Wi‑Fi，再按「重新定位」'],
    ['3', '一直不行：請值班主管在核定頁按「打卡 QR」，用 LINE 掃描打卡，不要連按'] ] },
  '網路不穩': { title: '連線失敗／網路不穩', steps: [
    ['1', '先看「出勤紀錄」今天有沒有剛才那筆，有就不用再打'],
    ['2', '換網路：Wi‑Fi 不穩就關掉改用行動網路，反過來也一樣；有開 VPN 先關掉'],
    ['3', '關掉打卡畫面，從選單重新按「打卡」'],
    ['4', '還是不行：先用舊的專屬打卡連結打卡，並告訴值班主管'] ] },
  '新手機': { title: '這支手機還沒被核准', steps: [
    ['原因', '系統第一次看到這支手機（換手機、重灌 LINE 都會發生），要主管核准'],
    ['怎麼辦', '請值班主管打開值班核定頁，在「待核准裝置」按核准'],
    ['這筆卡', '已經記下來了（待核准），核准後就算數，不用重打'] ] },
  '綁定': { title: 'LINE 帳號綁定有問題', steps: [
    ['1', '關掉打卡畫面，從選單重新按「打卡」再試一次'],
    ['2', '還是說「沒有認得你的 LINE 帳號」：請值班主管在值班核定頁的「LINE 綁定紀錄」解除綁定，再重新輸入全名綁一次'],
    ['3', '這段時間先用舊的專屬打卡連結打卡'] ] },
  '置頂': { title: '把「鼎兆元打卡」置頂', steps: [
    ['為什麼', '聊天室很多時，置頂後每次打卡不用再找'],
    ['iPhone', '聊天列表把「鼎兆元打卡」往右滑 → 點圖釘'],
    ['安卓', '聊天列表長按「鼎兆元打卡」→ 選「置頂」'] ] },
};
var LINE_HUB_HELP_ORDER = ['網路不穩', '定位抓不到', '定位不準', '不在範圍', '定位權限', '新手機', '綁定', '置頂'];

function lineHubHelpCard_(key) {
  var h = LINE_HUB_HELP[key];
  if (!h) {
    return lineHubCard_({ title: '🛠 打卡遇到問題？', tone: 'info', alt: '打卡求助',
      blocks: [{ type: 'text', text: '選一個最像你遇到的狀況，會告訴你怎麼排除：' }],
      buttons: LINE_HUB_HELP_ORDER.map(function (k) { return { label: LINE_HUB_HELP[k].title, text: '打卡求助：' + k }; }) });
  }
  var blocks = [];
  h.steps.forEach(function (st, i) {
    if (i) blocks.push({ type: 'sep' });
    blocks.push({ type: 'heading', text: st[0] });
    blocks.push({ type: 'text', text: st[1], margin: 'xs' });
  });
  return lineHubCard_({ title: '🛠 ' + h.title, tone: 'warn', alt: '打卡求助：' + h.title, blocks: blocks,
    foot: '都試過還是不行：先用舊的專屬打卡連結，並告訴值班主管。',
    buttons: [{ label: '其他狀況', text: '打卡求助' }] });
}

/** 電子佈告欄入口。選單「佈告欄」若仍是傳文字，機器人回這張卡片給連結（2026-10-09 選單改版）。 */
var LINE_HUB_BULLETIN_URL = 'https://dzy-bulletin.github.io/';
function lineHubBulletinCard_() {
  return lineHubCard_({ title: '📌 電子佈告欄', tone: 'info', alt: '電子佈告欄',
    blocks: [{ type: 'text', text: '公司公告都在這裡，看完要手寫簽名確認已讀。' }],
    buttons: [{ label: '打開佈告欄', uri: LINE_HUB_BULLETIN_URL }] });
}

// 2026-10-09 選單改版（打卡／出勤紀錄／出勤班表／加班請假／薪資明細／佈告欄）；舊選單的字句仍保留可打字查
var LINE_HUB_TEXT_COMMANDS = {
  '出勤紀錄': lineHubAttendanceCard_,
  '薪資明細': lineHubPayCard_,
  '假別額度': lineHubLeaveCard_,
  '加班申請': function () { return lineHubReqCard_('ot'); },
  '請假申請': function () { return lineHubReqCard_('leave'); },
  '出差申請': function () { return lineHubReqCard_('trip'); },
  '忘打卡': function () { return lineHubReqCard_('miss'); },
  '忘打卡申請': function () { return lineHubReqCard_('miss'); },
  '我的申請': function () { return lineHubReqCard_('mine'); },
  '加班請假': function () { return lineHubReqCard_(''); },
  '意見回饋': function () { return lineHubNoticeCard_('意見回饋', '有任何建議，直接在聊天室打「建議：」加上你的想法送出就可以，例如：\n建議：打卡畫面字可以再大一點'); },
  '出勤班表': function () { return lineHubNoticeCard_('出勤班表', '出勤班表功能還在準備中，目前請看店內公告的班表。'); },
  '佈告欄': lineHubBulletinCard_,
};

/** LINE webhook（Code.gs doPost 看到 body.events 就轉來這裡）。 */
/** 本官方帳號的 bot userId（webhook 的 destination 必須等於它）。部署時由 patch_line_hub.py 寫進
 *  LineHubConfig.js（LINE_HUB_BOT_USER_ID）；沒有才即時查一次並快取 6 小時。 */
function lineHubBotUserId_() {
  if (typeof LINE_HUB_BOT_USER_ID !== 'undefined' && LINE_HUB_BOT_USER_ID) return String(LINE_HUB_BOT_USER_ID);
  var c = CacheService.getScriptCache(), v = c.get('lh_bot_uid');
  if (v) return v;
  var token = (typeof LINE_HUB_BOT_TOKEN !== 'undefined') ? LINE_HUB_BOT_TOKEN : '';
  if (!token) return '';
  try {
    var r = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    v = String((JSON.parse(r.getContentText()) || {}).userId || '');
  } catch (e) { v = ''; }
  if (v) c.put('lh_bot_uid', v, 21600);
  return v;
}

function handleLineWebhook_(body) {
  // Apps Script 讀不到 LINE 簽章標頭，所以：destination 要是本帳號、只回 1 對 1 私訊（群組裡打「薪資明細」不能回到群組）、
  // 每人每分鐘最多 20 則（偽造請求也只能拿無效的回覆權杖，什麼都送不出去；節流是防它拖垮後端）（v2 審查 #4）
  // fail-closed：查不到本帳號 userId、或請求沒帶／帶錯 destination，一律不處理（v2 審查 N1）
  var bot = lineHubBotUserId_();
  if (!bot || String(body.destination || '') !== bot) return { ok: true, ignored: 'destination' };
  // 全站每分鐘上限按「事件」算，單一請求最多處理 10 個事件（LINE 正常一次只送幾個），防一個請求塞上百個放大（v2 審查 N6）
  (body.events || []).slice(0, 10).forEach(function (ev) {
    if (lineHubThrottled_('wh', '*all*', 300, 60)) return;
    try {
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
      if (!ev.source || ev.source.type !== 'user') return;
      var userId = ev.source.userId;
      if (!userId) return;
      if (lineHubThrottled_('wh', userId, 20, 60)) return;
      var text = String(ev.message.text || '').trim();
      if (text === '打卡' || LINE_HUB_TEXT_COMMANDS[text] || /^(出勤紀錄|薪資明細)\s*\d{4}-\d{2}$/.test(text)) lineHubLoading_(userId);
      if (text === '打卡') {
        var r = lineHubTakeStash_(userId) || lineHubLatestPunch_(userId);
        if (r && r.ok) r.annual_note = lineHubAnnualNote_(userId, r.ts);   // 特休快到期提醒（一天最多一次；查不到就不提）
        lineHubReply_(ev.replyToken, [
          r && r.unreadable ? lineHubNoticeCard_('打卡', '剛才那筆暫時查不到（店家系統忙碌）。打卡畫面顯示成功就是成功，可按選單「出勤紀錄」確認。', 'warn')
          : r ? lineHubPunchCard_(r)
          : lineHubNoticeCard_('打卡', '請按下方選單的「打卡」，打卡要用手機定位，直接打字不會記錄。')]);
        return;
      }
      if (text === '打卡求助' || text.indexOf('打卡求助：') === 0) {
        lineHubReply_(ev.replyToken, [lineHubHelpCard_(text.slice('打卡求助：'.length).trim())]);
        return;
      }
      if (text.indexOf('申請已送出：') === 0) {   // 申請頁送出後代同仁傳的（只回給他自己看，內容照抄不另查）
        lineHubReply_(ev.replyToken, [lineHubCard_({ title: '⏳ 申請已送出', tone: 'warn', alt: '申請已送出，等主管審核',
          blocks: [{ type: 'text', text: text.slice('申請已送出：'.length).slice(0, 120) }, { type: 'text', text: '等值班主管審核。結果在「我的申請」，下次打卡時也會告訴你。', muted: true }],
          buttons: [{ label: '我的申請', uri: LINE_HUB_LIFF_URL + '?view=req&tab=mine' }] })]);
        return;
      }
      if (/^建議\s*[:：]/.test(text)) {
        lineHubReply_(ev.replyToken, [lineHubFeedback_(userId, text.replace(/^建議\s*[:：]\s*/, ''))]);
        return;
      }
      var mm = /^(出勤紀錄|薪資明細)\s*(\d{4}-\d{2})$/.exec(text);
      if (mm) {
        lineHubReply_(ev.replyToken, [mm[1] === '出勤紀錄' ? lineHubAttendanceMonthCard_(userId, mm[2]) : lineHubPayCard_(userId, mm[2])]);
        return;
      }
      var fn = LINE_HUB_TEXT_COMMANDS[text];
      if (fn) { lineHubReply_(ev.replyToken, [fn(userId)]); return; }
    } catch (e) {
      try { lineHubReply_(ev.replyToken, [lineHubNoticeCard_('系統忙碌', '請稍後再試一次。', 'warn')]); } catch (e2) {}
    }
  });
  return { ok: true };
}

var LINE_HUB_HANDLERS = {
  line_quick_clock: handleLineQuickClock_,
  line_hub_status: handleLineHubStatus_,
  line_bind_name: handleLineBindName_,
  line_hub_req_init: function (b) { return handleLineHubReqInit_(b); },
  line_hub_attach_put: function (b) { return handleLineHubAttachPut_(b); },
  line_hub_attach_get: function (b) { return handleLineHubAttachGet_(b); },
};

/* ══ 加班請假／忘打卡申請（2026-10-09，規格 mala-clock-liff docs/requests-spec.md）══
   申請本身存各店（Requests.gs）；這裡只做：選單入口卡片、申請頁開頁資料（綁哪些店＋假別＋額度）、附件（只存光復的雲端硬碟）、意見回饋。 */
var LINE_HUB_LIFF_URL = 'https://liff.line.me/2011292256-QFXEwFh4';
var LINE_HUB_REQ_TABS = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡', mine: '我的申請' };
function lineHubReqCard_(tab) {
  var t = LINE_HUB_REQ_TABS[tab] ? tab : 'leave';
  return lineHubCard_({ title: '📝 加班請假', tone: 'info', alt: '加班請假申請',
    blocks: [{ type: 'text', text: '請假、加班、出差、忘打卡都在這裡申請，送出後由值班主管審核。結果會在「我的申請」，下次打卡時也會告訴你。' }],
    buttons: [{ label: '打開' + (tab ? LINE_HUB_REQ_TABS[t] : '申請頁'), uri: LINE_HUB_LIFF_URL + '?view=req&tab=' + t }] });
}
var LINE_HUB_COMMON_LEAVES = ['特休假', '事假', '病假', '生理假', '家庭照顧假'];
/** {action:'line_hub_req_init', id_token} → {ok, stores:[{code,name,emp_id,emp_name}], leave_types:{common,special}, quota:[…]} */
function handleLineHubReqInit_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('rqi', userId, 20, 60)) return { ok: false, error: 'too_many' };
  var mine = lineHubMine_(userId, null, false);
  if (!mine.length) return { ok: false, error: 'not_bound' };
  var stores = mine.map(function (x) { return { code: String(x.st.code), name: String(x.st.name), emp_id: String(x.row.emp_id), emp_name: String(x.row.name) }; });
  var names = [];
  try {
    var pick = lineHubPayPick_(userId);
    names = payLeaveTypes(pick ? pick.store : '').map(function (t) { return String(t.name); });
  } catch (e) { names = []; }
  if (!names.length) names = LEAVE_TYPES.slice();
  names = names.filter(function (n) { return n && n !== '出差' && LEAVE_TYPES.indexOf(n) >= 0; });
  var quota = [];
  try { var j = lineHubPayslipFor_(userId); quota = (j && j.ok && j.leave_quota) || []; } catch (e) { quota = []; }
  return { ok: true, stores: stores,
           leave_types: { common: LINE_HUB_COMMON_LEAVES.filter(function (n) { return names.indexOf(n) >= 0; }),
                          special: names.filter(function (n) { return LINE_HUB_COMMON_LEAVES.indexOf(n) < 0; }) },
           quota: quota.map(function (q) { return { name: q.name, cap_days: q.cap_days, cap_h: q.cap_h, remain_h: q.remain_h, used_h: q.used_h, basis: q.basis }; }) };
}

var LINE_HUB_ATTACH_FOLDER = '打卡申請附件';
var LINE_HUB_ATTACH_MAX = 3 * 1024 * 1024;   // 解碼後 3MB（前端會先壓成 1600px JPEG，一般 200–500KB）
function lineHubAttachFolder_() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('REQ_ATTACH_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 被刪了就重建 */ } }
  var f = DriveApp.createFolder(LINE_HUB_ATTACH_FOLDER);
  p.setProperty('REQ_ATTACH_FOLDER', f.getId());
  return f;
}
/** {action:'line_hub_attach_put', id_token, data_url} → {ok, attach_id}。只收圖片與 PDF；檔案不公開分享。 */
function handleLineHubAttachPut_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('att', userId, 10, 600)) return { ok: false, error: 'too_many', message: '上傳太多次了，請 10 分鐘後再試' };
  if (!lineHubMine_(userId, null, false).length) return { ok: false, error: 'not_bound' };
  var m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+\/=]+)$/.exec(String(body.data_url || ''));
  if (!m) return { ok: false, error: 'bad_file', message: '只能上傳照片或 PDF' };
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > LINE_HUB_ATTACH_MAX) return { ok: false, error: 'too_big', message: '檔案太大（上限 3MB）' };
  var ext = m[1] === 'application/pdf' ? 'pdf' : m[1] === 'image/png' ? 'png' : 'jpg';
  var name = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8) + '.' + ext;
  var file = lineHubAttachFolder_().createFile(Utilities.newBlob(bytes, m[1], name));
  return { ok: true, attach_id: file.getId() };
}
/** {action:'line_hub_attach_get', store, mgr_key, attach_id} → {ok, mime, data}。
 *  驗：那家店的值班主管金鑰＋這個附件真的掛在那家店的某筆申請上（不能拿 ID 亂撈別店或別人的檔）。 */
function handleLineHubAttachGet_(body) {
  if (lineHubThrottled_('atg', '*all*', 120, 60)) return { ok: false, error: 'too_many' };
  var code = String(body.store || ''), st = lineHubStores_().filter(function (x) { return String(x.code) === code; })[0];
  if (!st) return { ok: false, error: 'bad_store' };
  var ss = code === '' ? getSS() : (st.ss_id ? SpreadsheetApp.openById(st.ss_id) : null);
  if (!ss) return { ok: false, error: 'bad_store' };
  var msh = ss.getSheetByName('managers');
  if (!msh || !findManagerByKey(readSheetAsObjects(msh).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };
  var rsh = ss.getSheetByName('requests'), id = String(body.attach_id || '');
  if (!id || !rsh || !readSheetAsObjects(rsh).rows.some(function (r) { return String(r.attach_id) === id; })) return { ok: false, error: 'not_found' };
  // 只給附件資料夾裡的檔（審查 #1）：attach_id 是同仁送申請時自己帶的，不檢查的話可以填任何本帳號讀得到的雲端檔 ID
  var file = DriveApp.getFileById(id), folderId = PropertiesService.getScriptProperties().getProperty('REQ_ATTACH_FOLDER'), inFolder = false;
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) inFolder = true;
  if (!folderId || !inFolder) return { ok: false, error: 'not_found' };
  var blob = file.getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
/** 一次性授權（Eason 在光復編輯器執行）：讓附件存得進雲端硬碟。只建／讀資料夾，不動其他檔案。 */
function reqAuthorizeDrive() {
  var f = lineHubAttachFolder_();
  Logger.log('附件資料夾：' + f.getName() + '（' + f.getId() + '）授權完成');
  return f.getId();
}

/* 意見回饋（2026-10-09）：同仁打「建議：…」→ 存光復試算表 feedback 分頁（時間、店、工號、姓名、內容），回一張謝謝卡片。 */
function lineHubFeedback_(userId, text) {
  var t = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (!t) return lineHubNoticeCard_('意見回饋', '請在「建議：」後面寫上你的想法再送出。');
  var mine = lineHubMine_(userId, null, true), who = mine[0];
  var ss = getSS(), sh = ss.getSheetByName('feedback');
  if (!sh) { sh = ss.insertSheet('feedback'); sh.getRange(1, 1, 1, 5).setValues([['ts', 'store', 'emp_id', 'name', 'text']]); }
  sh.appendRow([nowTaipeiIso(), who ? String(who.st.name) : '', who ? String(who.row.emp_id) : '', who ? String(who.row.name) : '', t]);
  return lineHubNoticeCard_('收到你的建議', '謝謝！你的建議已經記下來，會轉給負責的主管。', 'ok');
}
