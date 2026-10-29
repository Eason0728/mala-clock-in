/* ══ 管理系統呼叫的名冊服務端點（2026-10-13，規格 ~/dzy docs/personnel/master-data/spec.md 第 3 節）══
 * 管理系統（Mac mini 同步員）POST {action, v:1, svc_key, ...}，這裡提供：
 *   svc_roster         唯讀名冊＋每人最近打卡日（絕不回 key、device_id、line_user_id）
 *   svc_add            新增同仁（與 mgr_add_employee 同一把 ScriptLock；冪等靠名冊 origin_op 欄）
 *   svc_set_active     停用／恢復在職（寫法同 mgr_set_active）
 *   svc_link           只回該人的打卡連結金鑰（不寫任何紀錄）
 *   svc_payroll_names  薪資主檔的 store／emp_id／name（不含任何金額欄）
 * 規則：
 *   ‧svc_key 要等於指令碼屬性 STAFF_SVC_KEY（沒設就全部拒絕 unauthorized），固定時間比對；v 不是 1 → bad_version。
 *   ‧回應失敗格式 {ok:false, error:<代碼>, message:<中文>}；代碼只用 unauthorized bad_version bad_input busy duplicate_name not_found disabled（svc_link 對停用者）conflict（set_active 同 op_id 重送但名冊現況與目標不同，附 active＝現況）；doPost 層另可能回 unknown_action／bad_json／server_error。
 *   ‧svc_add 不回 key、不另存結果：冪等以名冊上的 origin_op 為準，寫名冊那一刻就是唯一的「已做」紀錄。
 *   ‧寫名冊一律依試算表「實際表頭」定位欄位，不用位置 appendRow（欄序被打亂也寫得對）。
 * 回退：刪掉 Code.gs 分派表那三行＋本檔即回到原狀。 */

var SVC_STAFF_EXTRA_HEADERS = ['src_store', 'src_emp_id', 'origin_op', 'last_op'];   // last_op＝svc_set_active 最後一次執行的 op_id（冪等用）
var SVC_BY_MAX = 40;   // created_by／by 長度上限

function svcFail_(error, message) { return { ok: false, error: error, message: message }; }

/** 固定時間字串比對（逐字元 XOR 累加，長度不同也跑完整個迴圈） */
function svcEq_(a, b) {
  a = String(a); b = String(b);
  var n = Math.max(a.length, b.length), diff = a.length ^ b.length;
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** 驗金鑰與版本；通過回 null，否則回錯誤物件 */
function svcAuth_(body) {
  var key = PropertiesService.getScriptProperties().getProperty('STAFF_SVC_KEY');
  if (!key || typeof body.svc_key !== 'string' || !svcEq_(body.svc_key, key)) {
    return svcFail_('unauthorized', '金鑰不正確或服務未啟用');
  }
  if (body.v !== 1) return svcFail_('bad_version', '協定版本不支援');
  return null;
}

/** 名冊右側只補 src_store, src_emp_id, origin_op, last_op（只補不改） */
function svcEnsureHeaders_(sheet) {
  var head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
  SVC_STAFF_EXTRA_HEADERS.forEach(function (h) {
    if (head.indexOf(h) === -1) { sheet.getRange(1, head.length + 1).setValue(h); head.push(h); }
  });
}

/** 去頭空白後以 = + - @ 開頭 → 試算表會當公式執行（公式注入），一律拒收 */
function svcFormulaLike_(v) { return /^\s*[=+\-@]/.test(String(v)); }

function svcIsTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }

/** 儲存格時間 → 'yyyy-MM-dd HH:mm:ss'（契約格式；台北時間，去掉 T 與時區尾巴） */
function svcTime_(v) {
  var s = String(normCellTs(v) || '');
  var m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  return m ? m[1] + ' ' + m[2] : s;
}

/** 每人最近一次打卡日（只讀 events 底部分段；全部在職者都見到就停，最多回溯約 400 天） */
function svcLastPunch_(ss, empIds) {
  var out = {};
  var sh = ss.getSheetByName('events');
  if (!sh || !empIds.length) return out;
  var want = {}, seen = {}; empIds.forEach(function (e) { want[e] = true; });
  var left = empIds.length;
  var since = Date.now() - 400 * 86400000;
  var data = readEventsSince(sh, since, function (objs) {
    objs.forEach(function (e) {
      var id = String(e.emp_id);
      if (want[id] && !seen[id] && String(e.status).indexOf('rejected') !== 0) { seen[id] = true; left--; }
    });
    return left <= 0;
  });
  data.rows.forEach(function (e) {
    var id = String(e.emp_id);
    if (!want[id] || String(e.status).indexOf('rejected') === 0) return;
    var d = String(normCellTs(e.ts)).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!out[id] || d > out[id])) out[id] = d;
  });
  return out;
}

/** 小寫 hex HMAC-SHA256(key=LINE_MAP_KEY, msg=userId)。GAS 回有號 byte（-128..127），要 &0xff。
 *  金鑰未設或沒綁 → ''。平台只拿雜湊比對，絕不回原始 line_user_id。 */
function svcLineHash_(uid, key) {
  uid = String(uid || '');
  if (!uid || !key) return '';
  return Utilities.computeHmacSha256Signature(uid, key).map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

/** 有值班主管的店，managers 分頁有沒有啟用中的營運系統專用列（allow_acting＝TRUE）：值班主管本人的申請只能從這列核決 */
function svcHasActingRow_(ss) {
  var sh = ss.getSheetByName('managers');
  if (!sh) return true;   // 沒有 managers 分頁＝沒有值班主管，不用報
  var act = readSheetAsObjects(sh).rows.filter(function (m) { return reqTrue_(m.active); });
  if (!act.some(function (m) { return !reqTrue_(m.allow_acting); })) return true;   // 沒有值班主管（人）就不用營運系統列
  return act.some(function (m) { return reqTrue_(m.allow_acting); });
}

function handleSvcRoster_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var ss = getSS();
  var sh = ss.getSheetByName('roster');
  if (!sh) return { ok: true, rows: [] };
  var rows = readSheetAsObjects(sh).rows.filter(function (r) { return String(r.emp_id) !== ''; });
  var last = svcLastPunch_(ss, rows.map(function (r) { return String(r.emp_id); }));
  var props = PropertiesService.getScriptProperties();
  var mapKey = props.getProperty('LINE_MAP_KEY') || '', mapKid = props.getProperty('LINE_MAP_KID') || '';
  var duty = reqLocalDutyMgrs_(ss);   // 值班主管本人的申請改由上層審（只看本店判斷，不含跨店名單）
  return { ok: true,
    mgr_warn: duty.warn.map(function (w) { return { name_len: String(w.name).length, reason: w.reason }; })
      .concat(svcHasActingRow_(ss) ? [] : [{ name_len: 0, reason: 'no_acting_row' }]),   // 不回姓名；no_acting_row＝沒有營運系統專用列，上層在營運系統核不了值班主管本人的單
    line_probe: svcLineHash_('dzy-line-probe', mapKey),   // 平台每晚比對：真 Apps Script 的 HMAC 要與 node 相同、各店金鑰一致
    line_kid: String(mapKid),
    rows: rows.map(function (r) {
    var id = String(r.emp_id);
    var bound = String(r.line_user_id || '') !== '';
    return { emp_id: id, name: String(r.name),
             active: svcIsTrue_(r.active),
             created_at: svcTime_(r.created_at),
             removed_at: svcTime_(r.removed_at),
             line_bound: bound,
             line_h: bound ? svcLineHash_(r.line_user_id, mapKey) : '',
             line_kid: bound ? String(mapKid) : '',
             line_bound_at: bound ? String(normCellTs(r.line_bound_at) || '') : '',
             line_ok_at: bound ? String(normCellTs(r.line_ok_at) || '') : '',
             last_punch: last[id] || '',
             duty_mgr: !!duty.emps[id],
             src_store: String(r.src_store || ''),
             src_emp_id: String(r.src_emp_id || '') };
  }) };
}

function svcAddLocked_(body, name) {
  var ss = getSS();
  var sh = ss.getSheetByName('roster');
  if (!sh) return svcFail_('not_found', '找不到名冊分頁');
  svcEnsureHeaders_(sh);
  var rows = readSheetAsObjects(sh).rows;
  // 冪等：名冊已有這個 op_id 建的列 → 回那列（崩潰後重送也找得回）
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].origin_op) === body.op_id) return { ok: true, emp_id: String(rows[i].emp_id), active: svcIsTrue_(rows[i].active) };
  }
  var dup = rows.filter(function (r) { return String(r.name).trim() === name && svcIsTrue_(r.active); })[0];
  if (dup) return svcFail_('duplicate_name', '本店已有在職同仁同名');
  var empId = nextEmpId(rows);
  var now = nowTaipeiIso();
  var vals = { emp_id: empId, name: name, key: genKey(), active: true, created_at: now,
               created_by: body.created_by, src_store: String(body.src_store || ''),
               src_emp_id: String(body.src_emp_id || ''), origin_op: body.op_id };
  // 依「實際表頭」組列：表頭是什麼順序就照什麼順序放
  var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
  var row = head.map(function (h) { return Object.prototype.hasOwnProperty.call(vals, h) ? vals[h] : ''; });
  var at = sh.getLastRow() + 1;
  ['emp_id', 'name', 'key', 'created_at', 'created_by', 'src_store', 'src_emp_id', 'origin_op'].forEach(function (h) {
    var c = head.indexOf(h) + 1;
    if (c) sh.getRange(at, c).setNumberFormat('@');
  });
  sh.getRange(at, 1, 1, row.length).setValues([row]);   // 一次寫完整列：寫入成功＝origin_op 同時落地
  SpreadsheetApp.flush();
  return { ok: true, emp_id: empId, active: true };
}

function handleSvcAdd_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 20) return svcFail_('bad_input', '姓名不可空白且最多 20 字');
  if (svcFormulaLike_(name) || svcFormulaLike_(body.created_by) || svcFormulaLike_(body.src_store) || svcFormulaLike_(body.src_emp_id)) return svcFail_('bad_input', '欄位不可以 = + - @ 開頭');
  if (typeof body.op_id !== 'string' || !body.op_id || body.op_id.length > 80) return svcFail_('bad_input', 'op_id 不正確');
  if (typeof body.created_by !== 'string' || !body.created_by.trim() || body.created_by.length > SVC_BY_MAX) return svcFail_('bad_input', 'created_by 不可空白且最多 ' + SVC_BY_MAX + ' 字');
  var lock = LockService.getScriptLock();   // 與 handleMgrAddEmployee 同一把
  try { lock.waitLock(15000); } catch (e) { return svcFail_('busy', '另一個新增動作進行中，請稍後再試'); }
  try { return svcAddLocked_(body, name); } finally { lock.releaseLock(); }
}

function handleSvcSetActive_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var empId = typeof body.emp_id === 'string' ? body.emp_id.trim() : '';
  var a = body.active;
  if (!empId || typeof body.op_id !== 'string' || !body.op_id ||
      !(a === true || a === false || a === 'true' || a === 'false')) return svcFail_('bad_input', '輸入不正確');
  var active = (a === true || a === 'true');
  if (body.by !== undefined && (typeof body.by !== 'string' || body.by.length > SVC_BY_MAX)) return svcFail_('bad_input', 'by 最多 ' + SVC_BY_MAX + ' 字');
  if (svcFormulaLike_(body.by)) return svcFail_('bad_input', 'by 不可以 = + - @ 開頭');
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return svcFail_('busy', '另一個名冊動作進行中，請稍後再試'); }
  try {
    var sh = getSS().getSheetByName('roster');
    if (!sh) return svcFail_('not_found', '找不到名冊分頁');
    ensureRosterHeaders(sh);
    svcEnsureHeaders_(sh);
    var rows = readSheetAsObjects(sh).rows;
    var row = findRosterByEmpId(rows, empId);
    if (!row) return svcFail_('not_found', '名冊裡找不到這位同仁');
    // 冪等：這個 op_id 就是這位同仁最後一次執行的 op → 回當時的結果，不再動（即使之後被別的 op 改過）
    if (String(row.last_op) === body.op_id) {
      var cur = svcIsTrue_(row.active);
      if (cur !== active) return { ok: false, error: 'conflict', message: '這個 op_id 執行過，但名冊現況已被別的動作改變', active: cur };
      return { ok: true, emp_id: empId, active: active };
    }
    if (svcIsTrue_(row.active) === active) return { ok: true, emp_id: empId, active: active };   // 已是目標狀態
    var name = String(row.name).trim();
    if (active) {
      var dup = rows.filter(function (r) {
        return String(r.emp_id) !== empId && String(r.name).trim() === name && svcIsTrue_(r.active);
      })[0];
      if (dup) return svcFail_('duplicate_name', '本店已有在職同仁同名');
    }
    var now = nowTaipeiIso();
    setRosterCell(sh, row.__rowIndex, 'active', active);
    setRosterCell(sh, row.__rowIndex, 'removed_at', active ? '' : now, true);
    setRosterCell(sh, row.__rowIndex, 'removed_by', active ? '' : String(body.by || ''));
    setRosterCell(sh, row.__rowIndex, 'last_op', body.op_id, true);
    SpreadsheetApp.flush();
    return { ok: true, emp_id: empId, active: active };
  } finally { lock.releaseLock(); }
}

function handleSvcLink_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var empId = typeof body.emp_id === 'string' ? body.emp_id.trim() : '';
  if (!empId) return svcFail_('bad_input', '缺少 emp_id');
  var sh = getSS().getSheetByName('roster');
  var row = sh ? findRosterByEmpId(readSheetAsObjects(sh).rows, empId) : null;
  if (!row || !String(row.key || '')) return svcFail_('not_found', '名冊裡找不到這位同仁');
  if (String(row.active).toLowerCase() !== 'true') return svcFail_('disabled', '這位同仁已停用，不提供打卡連結');
  return { ok: true, key: String(row.key) };
}

function handleSvcPayrollNames_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var sh = getSS().getSheetByName('payroll_master');
  if (!sh) return { ok: true, rows: [] };
  var def = (typeof PAY_DEFAULT_STORE !== 'undefined') ? PAY_DEFAULT_STORE : '';
  var rows = [];
  readSheetAsObjects(sh).rows.forEach(function (r) {
    if (String(r.emp_id) === '' && String(r.name) === '') return;
    rows.push({ store: String(r.store || '') || def, emp_id: String(r.emp_id), name: String(r.name) });   // 只取三欄，絕不帶金額
  });
  return { ok: true, rows: rows };
}

/** {svc_key, emp_ids:[…]} → 寫 Script Property REQ_UPPER_EMPS（跨店值班主管的本店 emp_id；管理系統每日同步） */
function handleSvcSetUpper_(body) {
  var bad = svcAuth_(body); if (bad) return bad;
  var hasUp = Array.isArray(body.emp_ids), hasDept = Array.isArray(body.dept_emp_ids);   // 至少帶一份；沒帶的那份不動
  if (!hasUp && !hasDept) return svcFail_('bad_request', 'emp_ids 要是陣列');
  function clean(list) {
    var seen = {}, out = [];
    list.forEach(function (x) {
      if (typeof x !== 'string') return;
      var s = x.trim();
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    });
    return out;
  }
  var up = hasUp ? clean(body.emp_ids) : null, dept = hasDept ? clean(body.dept_emp_ids) : null;
  if ((up && up.length > 500) || (dept && dept.length > 500)) return svcFail_('too_many', '最多 500 個 emp_id');
  var props = PropertiesService.getScriptProperties();
  if (up) props.setProperty('REQ_UPPER_EMPS', JSON.stringify(up));
  if (dept) { if (dept.length) props.setProperty('REQ_DEPT_EMPS', JSON.stringify(dept)); else props.deleteProperty('REQ_DEPT_EMPS'); }   // 部門同仁名單（2026-10-29）
  if (body.on === true) props.setProperty('REQ_UPPER_ON', '1');
  else if (body.on === false) props.deleteProperty('REQ_UPPER_ON');   // 沒帶 on＝不動開關
  var res = { ok: true, n: up ? up.length : JSON.parse(props.getProperty('REQ_UPPER_EMPS') || '[]').length, on: props.getProperty('REQ_UPPER_ON') === '1' };
  if (dept) res.dept_n = dept.length;
  return res;
}

var SVC_STAFF_HANDLERS = {
  svc_roster: handleSvcRoster_,
  svc_add: handleSvcAdd_,
  svc_set_active: handleSvcSetActive_,
  svc_link: handleSvcLink_,
  svc_payroll_names: handleSvcPayrollNames_,
  svc_set_upper: handleSvcSetUpper_,
};
