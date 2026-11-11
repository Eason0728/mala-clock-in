/**
 * 考勤異常候補提醒（Phase 2，2026-11-07）：各店唯讀動作 att_digest_data。
 *
 * {action:'att_digest_data', mgr_key, store?, from, to, since, until, unapproved_from?, include_xmap?}
 *   since／until：ISO 時間；since 也可用 since_by_store:{<店>:ISO}（一店一呼叫時取該店或唯一那個 key）。
 *   from／to：YYYY-MM-DD，含頭尾最多 35 天。unapproved_from：未核定的起算日，最多 56 天前（預設＝56 天前）。
 *
 * 唯讀、一輪讀 events／approved／requests／roster，不迴圈呼叫 mgr_day。
 * 算法全部沿用既有函式，不另寫一套：
 *   punch_hours ＝ mgr_day 的 reference（dayPunchSegments＋dayReferenceHours_，與 handleMgrDay 同一支）
 *   approved    ＝ buildLatestApprovedMap（每日最新一筆）
 *   unapproved  ＝ monthPendingApprovalDates（逐月呼叫，所以可跨月）
 *   requests    ＝ reqRows_（Requests.gs）
 * 九店都有 Liff.gs 覆寫 mgr_day（reqMgrDayHome_），但只是濾掉人：設了 REQ_HOME_EMPS 的店才會隱藏，
 * reference 仍來自 handleMgrDay。digest 照樣列出所有人，days／unapproved 每列加 home_hidden
 * （值班主管在 mgr_day 看不到的人＝true，直接呼叫 reqHomeHide_／reqInList_，不重寫判斷）。
 *
 * 唯一例外：reqHomeHide_ 讀 REQ_HOME_EMPS 的既有行為，名單有變動時可能順手寫一個 `_LAST` 指令碼屬性
 * （只是讀失敗時的備份，不寫任何分頁）。名單讀不到／格式錯時全員 home_hidden＝false 並回 home_list_error。
 */
const ATT_DIGEST_MAX_DAYS = 35;
const ATT_DIGEST_UNAPPROVED_MAX_DAYS = 56;

function attDigestGoodDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(s + 'T00:00:00Z').getTime();
  // 往返檢查：2026-02-30 會被 Date 滾成 03-02，格式化回來就對不上原字串
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function attDigestMs_(s) {
  const t = Date.parse(String(s || ''));
  return isNaN(t) ? null : t;
}
function attDigestDaysBetween_(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}
function attDigestCmp_(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function handleAttDigestData(body) {
  const ss = getSS();
  const mgrSheet = ss.getSheetByName('managers');
  if (!mgrSheet) return { ok: false, error: 'managers_sheet_missing' };
  if (!findManagerByKey(readSheetAsObjects(mgrSheet).rows, body.mgr_key)) return { ok: false, error: 'unauthorized' };

  const from = body.from, to = body.to;
  if (!attDigestGoodDate_(from) || !attDigestGoodDate_(to)) return { ok: false, error: 'bad_date' };
  if (to < from) return { ok: false, error: 'bad_range' };
  if (attDigestDaysBetween_(from, to) + 1 > ATT_DIGEST_MAX_DAYS) return { ok: false, error: 'range_too_long' };

  const byStore = (body.since_by_store && typeof body.since_by_store === 'object') ? body.since_by_store : null;
  let store = String(body.store || '');
  if (!store && byStore && Object.keys(byStore).length === 1) store = Object.keys(byStore)[0];
  const sinceRaw = body.since != null ? body.since : (byStore ? byStore[store] : undefined);
  const sinceMs = attDigestMs_(sinceRaw), untilMs = attDigestMs_(body.until);
  if (sinceMs === null) return { ok: false, error: 'bad_since' };
  if (untilMs === null) return { ok: false, error: 'bad_until' };

  const today = todayTaipeiStr();
  const yesterday = addDaysStr(today, -1);
  const floor = addDaysStr(today, -ATT_DIGEST_UNAPPROVED_MAX_DAYS);
  const hasUFrom = body.unapproved_from !== undefined && body.unapproved_from !== null && body.unapproved_from !== '';
  if (hasUFrom && !attDigestGoodDate_(body.unapproved_from)) return { ok: false, error: 'bad_date' };
  let uFrom = hasUFrom ? body.unapproved_from : floor;
  if (uFrom < floor) uFrom = floor;

  let complete = true;
  function guarded(fn, fallback) {
    try { return fn(); } catch (e) { complete = false; return fallback; }
  }

  const rosterRows = guarded(function () {
    const sh = ss.getSheetByName('roster'); if (!sh) throw new Error('no roster');
    return readSheetAsObjects(sh).rows;
  }, []);
  const eventRows = guarded(function () {
    const sh = ss.getSheetByName('events'); if (!sh) throw new Error('no events');
    return readSheetAsObjects(sh).rows.map(function (e) { e.ts = normCellTs(e.ts); return e; });
  }, []);
  const approvedRows = guarded(function () {
    const sh = ss.getSheetByName('approved');
    return sh ? readSheetAsObjects(sh).rows : [];
  }, []);
  const reqRowsAll = guarded(function () {
    if (typeof reqRows_ !== 'function') throw new Error('no Requests.gs');
    return reqRows_(ss);
  }, []);

  const approvedMap = buildLatestApprovedMap(approvedRows);
  // 值班主管在 mgr_day 看不到的人（REQ_HOME_EMPS）；沒有 Requests.gs、讀不到、或本店沒設＝都不隱藏
  // 名單讀壞（reqEmpListProp_ 回 {'*':true}）或丟錯時，不能讓全員隱藏：改全員 false＋回 home_list_error
  let homeListError = '';
  let homeHide = null;
  try {
    homeHide = typeof reqHomeHide_ === 'function' ? reqHomeHide_(body) : null;
    if (homeHide && homeHide[REQ_ALL_]) { homeHide = null; homeListError = 'REQ_HOME_EMPS 讀不到或格式錯誤'; }
  } catch (e) {
    homeHide = null; homeListError = String((e && e.message) || e);
  }
  const hidden = function (emp) { return !!(homeHide && reqInList_(homeHide, String(emp))); };
  const segEventRows = dropDupIgnored_(eventRows, dupIgnoreSet_(approvedMap));

  const nameOf = {};
  approvedRows.forEach(function (a) { if (a.name) nameOf[String(a.emp_id)] = String(a.name); });
  rosterRows.forEach(function (r) { nameOf[String(r.emp_id)] = String(r.name); });
  const nm = function (emp) { return nameOf[emp] || emp; };

  // 每人的事件（raw＝判斷有沒有打卡／未核定；seg＝拿掉認定重複卡後算時數，同 mgr_day）
  const rawBy = {}, segBy = {};
  eventRows.forEach(function (e) { (rawBy[String(e.emp_id)] = rawBy[String(e.emp_id)] || []).push(e); });
  segEventRows.forEach(function (e) { (segBy[String(e.emp_id)] = segBy[String(e.emp_id)] || []).push(e); });

  // ── days：from–to 每人每天（有打卡或有核定才列）──
  // punch_hours 與 mgr_day reference 完全同一套：全部上班卡都被擋（有上班嘗試、沒有任何 status=ok 的上班事件）的日子是 0 或 null，
  // 不代表真的 0 小時；這種日子 punch_blocked＝true。忘刷卡整天是 null。
  const dayKeys = {};
  eventRows.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d >= from && d <= to) dayKeys[d + '|' + String(e.emp_id)] = true;
  });
  Object.keys(approvedMap).forEach(function (d) {
    if (d < from || d > to) return;
    Object.keys(approvedMap[d]).forEach(function (emp) { dayKeys[d + '|' + emp] = true; });
  });
  // 跨夜班：只有下班事件落在隔天、沒有歸屬 segments（in 日才算）也沒有核定的那天不出列，時數都在 in 日。
  const days = Object.keys(dayKeys).sort().map(function (k) {
    const d = k.slice(0, 10), emp = k.slice(11);
    const hasPunch = (rawBy[emp] || []).some(function (e) { return tsDateStr(e.ts) === d; });
    const punch = hasPunch ? dayPunchSegments(segBy[emp] || [], emp, d) : null;
    const rec = (approvedMap[d] || {})[emp];
    // 以「歸屬該日的上班事件」判斷：該日有上班嘗試、但沒有任何 status=ok 的上班事件（前一晚跨夜的下班卡不能遮住）
    // 打完卡 10 分鐘內被擋的卡（rejected_too_soon，B33）是手滑重按，不算「上班嘗試」（獨立審查補）
    const inEvs = (rawBy[emp] || []).filter(function (e) { return tsDateStr(e.ts) === d && String(e.type) === 'in' && String(e.status) !== 'rejected_too_soon'; });
    const blocked = inEvs.length > 0 && !inEvs.some(function (e) { return String(e.status) === 'ok'; });
    const at = rec ? String(normCellTs(rec.entered_at)).trim() : '';
    if (!rec && !blocked && !(punch && punch.segments.length)) return null;
    return {
      store: store, date: d, emp_id: emp, name: nm(emp),
      punch_hours: hasPunch ? dayReferenceHours_(punch, d, today) : null,
      punch_blocked: blocked,
      approved_hours: rec ? (Number(rec.approved_hours) || 0) : null,
      approved_at: at ? at : null,
      home_hidden: hidden(emp),
    };
  }).filter(function (x) { return x !== null; });

  // ── newly_approved：entered_at ∈ (since, until]，不看工作日期 ──
  const newly = [];
  approvedRows.forEach(function (a) {
    const at = attDigestMs_(normCellTs(a.entered_at));
    if (at === null || at <= sinceMs || at > untilMs) return;
    const emp = String(a.emp_id);
    newly.push({ store: store, date: normCellDate(a.date), emp_id: emp, name: a.name ? String(a.name) : nm(emp),
                 approved_hours: Number(a.approved_hours) || 0, entered_at: normCellTs(a.entered_at),
                 // 主管手動填遲到分鐘（2026-11-08 Eason）：Mac mini 從狀態欄找「主管認定不計遲到」「遲到N分(認定)」，列出是誰核定的
                 status_text: String(a.status_text || ''), manager_name: String(a.manager_name || '') });
  });
  newly.sort(function (a, b) { return attDigestCmp_(a.entered_at, b.entered_at); });

  // ── unapproved：逐月呼叫 monthPendingApprovalDates（可跨月），uFrom–昨天；更早的只算天數 ──
  const unapproved = [];
  let older = 0;
  Object.keys(rawBy).forEach(function (emp) {
    const yms = {};
    rawBy[emp].forEach(function (e) {
      const d = tsDateStr(e.ts);
      yms[d.slice(0, 7)] = true;
    });
    Object.keys(yms).sort().forEach(function (ym) {
      monthPendingApprovalDates(rawBy[emp], approvedMap, emp, ym, today).forEach(function (d) {
        if (d > yesterday) return;
        if (d < uFrom) older++;
        else unapproved.push({ store: store, date: d, emp_id: emp, name: nm(emp), home_hidden: hidden(emp) });
      });
    });
  });
  unapproved.sort(function (a, b) { return attDigestCmp_(a.date, b.date) || attDigestCmp_(a.emp_id, b.emp_id); });

  // ── requests_pending ──
  const pending = reqRowsAll.filter(function (r) { return String(r.status) === 'pending'; })
    .sort(function (a, b) { return attDigestCmp_(a.created_at, b.created_at); })
    .map(function (r) {
      return { id: String(r.id), emp_id: String(r.emp_id), name: String(r.name), kind: String(r.kind), created_at: String(r.created_at) };
    });

  const out = {
    ok: true, store: store, asOf: nowTaipeiIso(), complete: complete,
    days: days, newly_approved: newly, unapproved: unapproved, unapproved_older_count: older,
    requests_pending: pending,
  };
  if (homeListError) out.home_list_error = homeListError;

  // ── xmap（光復薪資模組的打卡對照；要求才給，沒這分頁就不回欄位；不含姓名）──
  if (body.include_xmap === true) {
    try {
      if (typeof PAY_SHEET_NAME !== 'undefined' && typeof payRead === 'function' && typeof payXsupId_ === 'function'
          && ss.getSheetByName(PAY_SHEET_NAME.xmap)) {   // 先確認分頁存在：paySheet() 找不到會自動建分頁（寫入），這裡不准
        out.xmap = payRead('xmap')
          .filter(function (r) { return String(r.state || '').trim().toLowerCase() === 'confirmed' && !payXsupBool_(r.acct_only); })
          .map(function (r) {
            return { emp_no: String(r.emp_no == null ? '' : r.emp_no), acct_store: String(r.acct_store == null ? '' : r.acct_store), emp_id: payXsupId_(r.emp_id) };
          });
      }
    } catch (e) {
      out.xmap_error = String((e && e.message) || e);
    }
  }
  return out;
}
