/**
 * LINE 單一打卡入口的集中服務（2026-10-08，規格 mala-clock-liff/docs/spec.md §2.4）。
 *
 * 只部署在光復後端（薪資也在這裡）。**打卡本身不經過這裡**——打卡頁直接打各店後端的 liff_clock，
 * 所以這支壞掉只影響「綁定」與「查詢」，不影響任何人打卡。
 *
 * 依賴：Liff.gs 的 verifyLineIdToken_／handleLiffBind_、Payroll.gs 的 payMyPayslipFor_、
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

/** 一次讀完全部店的名冊 → {rosters:{code:rows|null}, unreadable:[code]} */
function lineHubAllRosters_() {
  var rosters = {}, unreadable = [];
  lineHubStores_().forEach(function (st) {
    var rows = null;
    try { rows = lineHubRoster_(st); } catch (e) { rows = null; }
    rosters[st.code] = rows;
    if (!rows) unreadable.push(st.code);
  });
  return { rosters: rosters, unreadable: unreadable };
}

/**
 * {action:'line_my_stores', id_token}
 * → {ok, stores:[{code, emp_id, name}], unreadable:[code]}
 * 這個 LINE 帳號在哪幾家店綁定了。**不回 key**。
 */
function handleLineMyStores_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  var all = lineHubAllRosters_();
  var out = [];
  lineHubStores_().forEach(function (st) {
    (all.rosters[st.code] || []).forEach(function (r) {
      if (lineHubActive_(r) && r.line_user_id && String(r.line_user_id) === String(userId)) {
        out.push({ code: st.code, emp_id: String(r.emp_id), name: String(r.name) });
      }
    });
  });
  return { ok: true, stores: out, unreadable: all.unreadable };
}

/**
 * {action:'line_bind_all', id_token, key, confirm?}
 * 用任一家店的專屬連結金鑰證明身分 → 找出這個人在每家店「同名且在職」的那一列。
 *   confirm 不是 true：只回清單讓本人確認（不寫入）。
 *   confirm === true：逐店呼叫那家店自己的 liff_bind（伺服器對伺服器，金鑰不經過手機）。
 * 每店狀態 state：free（可綁）／bound_self（已綁這個 LINE）／bound_other（已綁別的 LINE，要店長先解除）
 *                 ／name_conflict（同店有兩位在職同名，不自動綁）
 */
function handleLineBindAll_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  var proofKey = String(body.key || '').trim();
  if (!proofKey) return { ok: false, error: 'invalid_key' };

  var stores = lineHubStores_();
  var all = lineHubAllRosters_();
  var me = null;
  stores.forEach(function (st) {
    if (me) return;
    (all.rosters[st.code] || []).forEach(function (r) {
      if (!me && lineHubActive_(r) && String(r.key) === proofKey) me = { name: String(r.name) };
    });
  });
  if (!me) return { ok: false, error: 'invalid_key' };

  var cands = [];
  stores.forEach(function (st) {
    var rows = (all.rosters[st.code] || []).filter(function (r) {
      return lineHubActive_(r) && String(r.name) === me.name;
    });
    if (!rows.length) return;
    var state;
    if (rows.length > 1) state = 'name_conflict';
    else if (!rows[0].line_user_id) state = 'free';
    else if (String(rows[0].line_user_id) === String(userId)) state = 'bound_self';
    else state = 'bound_other';
    cands.push({ st: st, row: rows[0], state: state });
  });
  var list = cands.map(function (c) {
    return { code: c.st.code, store_name: c.st.name, emp_id: String(c.row.emp_id), state: c.state };
  });
  if (body.confirm !== true) {
    return { ok: true, name: me.name, stores: list, unreadable: all.unreadable };
  }

  // 寫入：只綁 free 的店。光復自己直接呼叫，其他店並行打各自的 liff_bind。
  var results = list.map(function (x) { return { code: x.code, store_name: x.store_name, emp_id: x.emp_id, ok: x.state === 'bound_self', error: x.state === 'free' || x.state === 'bound_self' ? '' : x.state }; });
  var remote = [];
  cands.forEach(function (c, i) {
    if (c.state !== 'free') return;
    var payload = { action: 'liff_bind', id_token: body.id_token, key: String(c.row.key) };
    if (c.st.code === '') {
      var r = handleLiffBind_(payload);
      results[i].ok = !!(r && r.ok); results[i].error = r && r.ok ? '' : String((r && r.error) || 'server_error');
    } else {
      remote.push({ i: i, req: { url: c.st.api, method: 'post', contentType: 'text/plain',
                                  payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: true } });
    }
  });
  if (remote.length) {
    var resps = UrlFetchApp.fetchAll(remote.map(function (x) { return x.req; }));
    resps.forEach(function (resp, k) {
      var i = remote[k].i, j = null;
      try { j = JSON.parse(resp.getContentText()); } catch (e) { j = null; }
      results[i].ok = !!(j && j.ok);
      results[i].error = results[i].ok ? '' : String((j && j.error) || 'unreachable');
    });
  }
  return { ok: true, name: me.name, results: results, unreadable: all.unreadable };
}

/**
 * {action:'line_my_payslip', id_token, ym} → 與 my_payslip 相同的回應。
 * 用 LINE 身分在薪資有接的各店名冊找人；同一人在多店時，優先取「薪資主檔有這個 emp_id」的那一家。
 */
function handleLineMyPayslip_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  var hits = [];
  payStoreList().forEach(function (s) {
    var code = String(s.code), rs = [];
    try { rs = payClockRead(code, 'roster'); } catch (e) { return; }
    rs.forEach(function (r) {
      if (lineHubActive_(r) && r.line_user_id && String(r.line_user_id) === String(userId)) hits.push({ me: r, store: code });
    });
  });
  if (!hits.length) return { ok: false, error: 'not_bound' };
  var masterIds = {};
  payRead('master').forEach(function (m) { masterIds[String(m.emp_id)] = true; });
  var pick = hits.filter(function (h) { return masterIds[String(h.me.emp_id)]; })[0] || hits[0];
  return payMyPayslipFor_(pick.me, pick.store, String(body.ym || currentYmTaipei()));
}

var LINE_HUB_HANDLERS = {
  line_my_stores: handleLineMyStores_,
  line_bind_all: handleLineBindAll_,
  line_my_payslip: handleLineMyPayslip_,
};
