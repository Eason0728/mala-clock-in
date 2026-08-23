/**
 * 麻的小辛辣 — 薪資結算模組
 * ---------------------------------------------------------------------------
 * 這個檔案只「新增」，不修改 Code.gs 的任何既有邏輯（打卡與核定完全不受影響）。
 * Code.gs 的 doPost 只加了一行掛載 PAYROLL_HANDLERS。
 *
 * 分頁：payroll_master / payroll_config / payroll_holiday / payroll_run
 *       payroll_item / payroll_audit
 *
 * 計算規則正本見 ~/mala-payroll/docs/spec.md，2026-06 已用 SD 分頁 6 人對帳全數相符。
 */

const PAY_SHEETS = {
  master:  ['emp_id','name','is_full_time','wage','base','ot_rate','skill_allow','night_allow',
            'mgr_allow','editor_allow','attend_cap','labor_ins','health_ins','group_ins',
            'pension','dormitory','hire_date','leave_date','active','updated_at','meal_allow','store','gap_rate','co_labor','co_health','co_pension',
            // 2026-08-23：年終獎金月數（只影響每月「提列」的人事成本，不影響實付）。
            // 留空＝用參數設定的全店預設 yearend_months。
            'yearend_months'],
  config:  ['key','value','note','store'],
  holiday: ['ym','red_days','note','dates','store'],   // store 空白＝集團共用；填了＝該門市專屬（覆寫集團）   // dates＝該月國定假日的具體日期（逗號分隔），計時當天出勤＝時薪雙倍
  store:   ['code','name','clock_ss_id','dzy_node','emp_prefix','active','sort','brand'],
  bonus:   ['ym','store','emp_id','bonus_type','label','amount','memo','updated_at'],
  run:     ['ym','emp_id','name','is_full_time','ratio','total_hours','base_hours','surplus_hours',
            'ot_paid_hours','gross','deduction','net','status','run_at','support_hours','store'],
  item:    ['ym','emp_id','item_type','item_key','item_label','qty','rate','amount','source','memo','store'],
  input:   ['ym','emp_id','hours','extra_ot','personal_h','sick_h','annual_h','deduct_days','support','updated_at','menstrual_h','disaster_h','full_attend','work_days','wage_override','dorm_override','meal_on','custom_add_label','custom_add_amt','custom_ded_label','custom_ded_amt','store','holiday_h'],
  audit:   ['ts','ym','action','operator','reason','store'],
  // 假別參數表（2026-08-22）：一列一種假，值班核定下拉／薪資扣款／額度上限共用同一份正本。
  // store 空白＝集團共用；填了＝該門市專屬（覆寫集團），與 payroll_config 同一套覆寫規則。
  leave_type: ['code','name','pay_ratio','count_absent','offset_shortfall','cap_days','cap_basis',
               'over_ratio','merge_into','cap_per_month','tenure_months','under_ratio',
               'active','sort','note','store',
               // 2026-08-23 追加：min_unit＝最小請假單位（hour／half／day）；
               // window_before／window_days／window_max＝期限規則（見 payLeaveWindow）
               'min_unit','window_before','window_days','window_max',
               // 2026-08-23：這天算不算「餐費補助的出勤日」。出差另有差旅費，設 false 不重複給。
               'count_meal_day',
               // 2026-08-23：這種假對全勤的影響。留空＝沿用 count_absent（遞減）；
               // none＝完全不影響、deduct＝按天遞減、void＝直接讓當月全勤歸零
               'attend_effect'],
  // 留職停薪區間表（2026-08-22）：育嬰留停以月申請動輒 6 個月以上，不可能逐日填 leave 分頁，
  // 所以長區間記在這裡（起訖日）；以日申請的 30 日照舊走 leave 分頁逐日一筆。
  leave_span: ['emp_id','name','store','code','child','unit','start','end','months','days',
               'memo','updated_at'],
  // 假別事件日（2026-08-23）：期限規則要有「事件那天」才算得出可請期間。
  // 例：婚假＝結婚登記日、產假／陪產假＝分娩日、流產假＝流產日。喪假無期限故不必填。
  leave_event: ['emp_id','name','store','code','event_date','memo','updated_at'],
};
/** 餐費補助門檻：當天「實際核定工時」要達這個時數才認列一天（核定時數＝實際上班時段，
 *  全天請假核定 0、假別另存 leave 分頁，所以特休／請假／出差自然不會被算進來）。*/
const MEAL_MIN_HOURS = 6;   // 預設值；實際以 payroll_config 的 meal_min_hours 為準（可依門市覆寫）

const PAY_SHEET_NAME = {
  master:'payroll_master', config:'payroll_config', holiday:'payroll_holiday',
  run:'payroll_run', item:'payroll_item', input:'payroll_input', audit:'payroll_audit',
  store:'payroll_store', bonus:'payroll_bonus',
  leave_type:'payroll_leave_type', leave_span:'payroll_leave_span',
  leave_event:'payroll_leave_event',
};

/** 單店期間的預設門市（階段一多店上線後改為必填，屆時移除此預設） */
const PAY_DEFAULT_STORE = 'SSLGF';
/** 呼叫端沒帶 store 時一律套用預設店，確保階段 0 行為與單店完全相同 */
function payStore(v) { return String(v || PAY_DEFAULT_STORE); }
const PAY_CONFIG_DEFAULT = [
  ['daily_hours', 8, '每日基本工時'],
  ['attend_deduct_per_day', 100, '全勤每日倒扣金額'],
  // 年終獎金：每月先提列（成本認列），不進同仁的實付。只有正職提列。
  ['yearend_months', 1, '年終獎金月數（全店預設，主檔可逐人覆寫）'],
  // ── 全勤「門檻式歸零」參數（2026-08-23，央廚／總部用；填 0 或留空＝不啟用，光復維持純遞減）──
  ['attend_void_forget', 0, '忘刷達幾次(含)以上→全勤歸零，0＝不啟用'],
  ['attend_forget_unit', 'punch', '忘刷計數單位：punch＝每漏一張卡算一次、day＝同一天只算一次'],
  ['attend_void_late_min', 0, '遲到累計達幾分鐘(含)以上→全勤歸零，0＝不啟用'],
  ['attend_void_early_min', 0, '早退累計達幾分鐘(含)以上→全勤歸零，0＝不啟用'],
  ['leave_div_days', 30, '事假費率分母（天）'],
  ['leave_div_hours', 8, '事假費率分母（時）'],
  ['sick_ratio', 0.5, '病假占事假比例'],
  ['payday', 10, '發薪日'],
  // ── 計時同仁的時薪加給（2026-08-24 改為參數，原本寫死在引擎裡）──
  // 有效時薪 ＝ 基本時薪 ＋ 滿勤加給（勾選才給）＋ 年資加給（滿門檻的次月起），兩者可疊加。
  // ⚠ 填 0 ＝該門市不給這項加給（0 是合法值，不是「沒設定」）。
  ['pt_attend_plus', 10, '計時滿勤加給（元/時，勾選才給；0＝不給）'],
  ['pt_tenure_plus', 10, '計時年資加給（元/時；0＝不給）'],
  ['pt_tenure_months', 6, '年資加給門檻（滿幾個月之後的次月起）'],
  // ⚠ shortfall_deduct 已於 2026-08-23 移除：2026-08 改版後「不足時數一律倒扣（先抵已請假時數）」，
  //    引擎不再讀這個開關，留著只會讓人以為關得掉。前端存檔會把殘留的 key 一併清掉（CFG_OBSOLETE）。
  ['meal_min_hours', 6, '餐費補助門檻：當日核定工時達此時數才認列一天'],
];

/* ═══════════════════ 分頁工具 ═══════════════════ */

function paySheet(kind) {
  const ss = getSS();
  const name = PAY_SHEET_NAME[kind];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, PAY_SHEETS[kind].length).setValues([PAY_SHEETS[kind]]);
    sh.setFrozenRows(1);
    if (kind === 'config') {
      sh.getRange(2, 1, PAY_CONFIG_DEFAULT.length, 3).setValues(PAY_CONFIG_DEFAULT);
    }
  }
  return sh;
}

function ensurePayrollSheets() {
  Object.keys(PAY_SHEETS).forEach(function (k) { paySheet(k); });
  return { ok: true, sheets: Object.keys(PAY_SHEET_NAME).map(function (k) { return PAY_SHEET_NAME[k]; }) };
}

/** 讀分頁。⚠ 加「本次請求內」快取：Apps Script 每次全表讀取很慢，
 *  同一請求裡重複讀同一張表（特休／集團總覽／計算都會）會把時間拉到數十秒。
 *  任何寫入（payReplaceAll／payAppend）都必須讓對應的快取失效。 */
var PAY_READ_CACHE = {};
function payRead(kind) {
  if (PAY_READ_CACHE[kind]) return PAY_READ_CACHE[kind];
  const rows = readSheetAsObjects(paySheet(kind)).rows.map(stripRowIndex);
  PAY_READ_CACHE[kind] = rows;
  return rows;
}
function payInvalidate(kind) { delete PAY_READ_CACHE[kind]; }

/* ⚠ Sheets 會把 '2026-08'、'2020-01-01' 這種字串自動轉成日期儲存格，讀回變 Date 物件、比對全失敗
   （ym 對不到 → no_holiday／查不到 run；hire_date 壞 → payRatio 錯）。寫入前把這些字串欄鎖成文字格式 '@'。*/
function payForceTextCols(sh, cols) {
  // ⚠ 純日期字串一定要鎖文字格式，否則 Sheets 轉成 Date 物件、之後比對全失敗。
  //   event_date／start／end 是 2026-08-23 新增的假別事件日與留停區間，漏了就會踩同一個坑。
  const TEXT = { ym: 1, hire_date: 1, leave_date: 1, dates: 1,
                 event_date: 1, start: 1, end: 1 };
  cols.forEach(function (c, i) {
    if (TEXT[c]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

/** 整張覆寫（保留表頭）——用於 master / holiday / run / item 的重建 */
function payReplaceAll(kind, rows) {
  payInvalidate(kind);
  const sh = paySheet(kind), cols = PAY_SHEETS[kind];
  sh.getRange(1, 1, 1, cols.length).setValues([cols]);   // 同步表頭（schema 只 append，補上新欄不動既有資料）
  payForceTextCols(sh, cols);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(function (r) { return cols.map(function (c) { return r[c] == null ? '' : r[c]; }); });
  sh.getRange(2, 1, values.length, cols.length).setValues(values);
}

function payAppend(kind, rows) {
  payInvalidate(kind);
  if (!rows.length) return;
  const sh = paySheet(kind), cols = PAY_SHEETS[kind];
  payForceTextCols(sh, cols);
  const values = rows.map(function (r) { return cols.map(function (c) { return r[c] == null ? '' : r[c]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, cols.length).setValues(values);
}

/** 參數取值順序：該門市覆寫 → 集團預設（store 空白）→ 程式內建 PAY_CONFIG_DEFAULT */
function payConfig(store) {
  const st = store ? String(store) : '';
  const glob = {}, own = {};
  function cast(v) {
    const s2 = String(v);
    return (s2 === 'true') ? true : (s2 === 'false') ? false :
           (s2 !== '' && isFinite(Number(s2)) ? Number(s2) : s2);
  }
  payRead('config').forEach(function (r) {
    const rs = String(r.store || '');
    if (rs === '') glob[r.key] = cast(r.value);
    else if (st && rs === st) own[r.key] = cast(r.value);
  });
  const out = {};
  PAY_CONFIG_DEFAULT.forEach(function (d) { out[d[0]] = d[1]; });
  Object.keys(glob).forEach(function (k) { out[k] = glob[k]; });
  Object.keys(own).forEach(function (k) { out[k] = own[k]; });
  return out;
}
/** 參數來源標示（設定頁用）：回 {key: 'own'|'global'|'builtin'} */
function payConfigSource(store) {
  const st = store ? String(store) : '';
  const src = {};
  PAY_CONFIG_DEFAULT.forEach(function (d) { src[d[0]] = 'builtin'; });
  payRead('config').forEach(function (r) {
    const rs = String(r.store || '');
    if (rs === '') { if (src[r.key] !== 'own') src[r.key] = 'global'; }
    else if (st && rs === st) src[r.key] = 'own';
  });
  return src;
}

/* ═══════════════════ 門市工具（多店：各店打卡各自一份試算表）═══════════════════ */

function payStoreRow(code) {
  const c = payStore(code);
  return payRead('store').filter(function (s) { return String(s.code) === c; })[0] || null;
}
/** 該門市的打卡試算表；門市表沒填 clock_ss_id 就用本地試算表（＝光復現況，行為不變）。
 *  同一次請求內快取，避免重複 openById。 */
var PAY_SS_CACHE = {};
/** 該門市有沒有連打卡系統（預設店永遠有；其他店要填 clock_ss_id） */
function payHasClock(store) {
  const c = payStore(store);
  if (c === PAY_DEFAULT_STORE) return true;
  const row = payStoreRow(c);
  return !!(row && String(row.clock_ss_id || ''));
}
/** 取該門市的打卡試算表。soft=true 時，未連打卡的門市回 null（＝手動輸入模式），不丟錯。 */
function payClockSS(store, soft) {
  const c = payStore(store);
  if (PAY_SS_CACHE[c]) return PAY_SS_CACHE[c];
  const row = payStoreRow(c);
  const id = row ? String(row.clock_ss_id || '') : '';
  var ss;
  if (!id) {
    // 預設店（光復）留空＝用本系統所在的試算表。
    // 其他門市留空＝還沒接打卡：手動輸入模式回 null；真的需要打卡資料的功能才丟錯。
    if (c !== PAY_DEFAULT_STORE) {
      if (soft) return null;
      throw new Error('門市 ' + c + ' 尚未連結打卡系統（未設定「打卡試算表 ID」）。此門市的工時請在「出勤資料」手動輸入；若要自動歸集，請到 參數設定 → 門市設定 填入試算表 ID。');
    }
    ss = getSS();
  }
  else {
    try { ss = SpreadsheetApp.openById(id); }
    catch (e) { throw new Error('門市 ' + c + ' 的打卡試算表開不起來（clock_ss_id=' + id + '）：' + e.message); }
  }
  PAY_SS_CACHE[c] = ss;
  return ss;
}
/** 讀某門市打卡試算表的某張分頁（請求內快取）。
 *  ⚠ payCollect、payAnnualInfo、payroll_punch 都會讀同幾張表，不快取就是重複全表讀取。 */
var PAY_CLOCK_CACHE = {};
function payClockRead(store, sheetName) {
  const key = payStore(store) + '|' + sheetName;
  if (PAY_CLOCK_CACHE[key]) return PAY_CLOCK_CACHE[key];
  var rows = [];
  const ss = payClockSS(store, true);          // 未連打卡的門市回 null → 視為沒有資料
  const sh = ss ? ss.getSheetByName(sheetName) : null;
  if (sh) rows = readSheetAsObjects(sh).rows.map(stripRowIndex);
  PAY_CLOCK_CACHE[key] = rows;
  return rows;
}

/** 啟用中的門市清單；門市表是空的就回一個預設店（單店期間） */
function payStoreList() {
  const rows = payRead('store').filter(function (s) { return String(s.active).toLowerCase() !== 'false'; });
  if (rows.length) {
    return rows.sort(function (a, b) { return (payNum(a.sort) || 99) - (payNum(b.sort) || 99); });
  }
  return [{ code: PAY_DEFAULT_STORE, name: '麻的小辛辣 新竹光復店', clock_ss_id: '', dzy_node: 'sxl-gf', emp_prefix: '', active: 'true', sort: 1 }];
}
/** 一次算出「每個員工待過哪些門市」→ {emp_id:[store,...]}。
 *  ⚠ 不要寫成「每個員工各掃一次表」，9 人就會變成 27 次全表讀取、請求直接超時。 */
function payEmpStoresMap() {
  const map = {};
  function mark(id, st) {
    const k = String(id);
    (map[k] = map[k] || {})[payStore(st)] = true;
  }
  payRead('master').forEach(function (m) { mark(m.emp_id, m.store); });
  payRead('run').forEach(function (r) { mark(r.emp_id, r.store); });
  payRead('input').forEach(function (r) { mark(r.emp_id, r.store); });
  const out = {};
  Object.keys(map).forEach(function (k) { out[k] = Object.keys(map[k]); });
  return out;
}
/** 單一員工的歷任門市（薄包裝，內部走上面那張表） */
function payEmpStores(empId) { return payEmpStoresMap()[String(empId)] || []; }

/* ═══════════════════ 工時歸集（重點：直接讀既有打卡資料）═══════════════════ */

/**
 * 從 approved / leave / events 歸集某月每人的薪資輸入。
 * 這就是「不用人工把工時搬進薪資系統」的那一段。
 */
function payCollect(ym, minH, store, holidayDates) {
  const MEALMIN = (minH === undefined || minH === null || minH === '') ? MEAL_MIN_HOURS : Number(minH);
  // 國定假日的具體日期（計時同仁雙薪用）；沒給就是空集合，行為與加這個功能之前相同
  const HOLSET = {};
  (holidayDates || []).forEach(function (d) { HOLSET[String(d).trim()] = true; });
  const LTYPES = payLeaveTypes(store);
  const LTMAP = {};
  LTYPES.forEach(function (t) { LTMAP[t.code] = t; });
  const roster   = payClockRead(store, 'roster');
  const approved = payClockRead(store, 'approved');
  const events   = payClockRead(store, 'events');
  const leaves   = payClockRead(store, 'leave');

  const approvedMap = buildLatestApprovedMap(approved);   // { date: { emp_id: {...} } }
  const nameToEmp = {};
  roster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });

  const out = {};
  function slot(emp) {
    if (!out[emp]) out[emp] = {
      hours: 0, extra_ot: 0,
      personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0, other_h: 0,
      deduct_days: 0, _days: {}, work_days: 0, _wd: {}, holiday_h: 0,
      leaves: {},   // { 假別code: 時數 }＝新的正本；上面五個舊欄位同步維護供手動輸入與既有報表用
      // 全勤門檻式歸零用（2026-08-23）：忘刷次數／忘刷天數／遲到累計分鐘／早退累計分鐘／假別觸發歸零
      forget_punch: 0, forget_day: 0, _fd: {}, late_min: 0, early_min: 0, attend_void: false,
    };
    return out[emp];
  }
  function markDay(emp, d) { slot(emp)._days[d] = true; }

  // 1) 核定時數 ＋ 遲到／早退日
  Object.keys(approvedMap).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      const rec = approvedMap[d][emp];
      const dayH = Number(rec.approved_hours) || 0;
      slot(emp).hours += dayH;
      // 餐費補助出勤天數：當日實際核定工時滿 MEAL_MIN_HOURS 才算一天（未滿不補、請假/特休/出差核定 0 不算）
      // 餐費補助出勤天數。⚠ 出差當天不算（假別表 count_meal_day=false）——出差另有差旅費，
      // 不重複給。這裡先記下來，等下面讀完 leave 分頁知道那天是不是出差再決定。
      if (dayH >= MEALMIN) slot(emp)._wd[d] = true;
      // 國定假日當天的出勤時數（計時同仁雙薪的基礎；時數本身照樣算進總時數）
      if (HOLSET[String(d)]) slot(emp).holiday_h += dayH;
      const st = String(rec.status_text || '');
      if (st.indexOf('遲到') !== -1 || st.indexOf('早退') !== -1) markDay(emp, d);
      // 累計遲到／早退分鐘數（全勤門檻用）。狀態字串是「遲到5分」「早退12分」，多項用「、」串。
      // ⚠ 一定要 split('、') 逐項比對，直接 indexOf 抓不到第二項的數字。
      st.split('、').forEach(function (part) {
        const m = String(part).match(/^(遲到|早退)(\d+(?:\.\d+)?)分/);
        if (!m) return;
        if (m[1] === '遲到') slot(emp).late_min += Number(m[2]);
        else slot(emp).early_min += Number(m[2]);
      });
    });
  });

  // 2) 忘刷卡日（沿用既有 pairShifts 的判定，不重寫規則）
  const paired = pairShifts(events);
  const todayStr = todayTaipeiStr();
  function markForget(empId, d) {
    const sl = slot(empId);
    sl.forget_punch += 1;      // 每漏一張卡算一次
    sl._fd[d] = true;          // 同一天只算一次（另一種計數單位）
    markDay(empId, d);
  }
  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym || d === todayStr) return;   // 今天未配對＝上班中，不算忘刷
    markForget(String(e.emp_id), d);
  });
  paired.unmatchedOuts.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym) return;
    markForget(String(e.emp_id), d);
  });

  // 3) 請假時數（分假別）＋ 請假日
  leaves.forEach(function (l) {
    // ⚠ leave 分頁表頭是中文（日期/姓名/假別/時數，見 Code.gs LEAVE_HEADERS），不是英文 key！
    //   原本讀 l.name/l.date/l.hours/l.type 全 undefined → 請假整批被跳過。沿用月表(buildMonthlySheet)同一套中文 key。
    const emp = nameToEmp[String(l['姓名'] || '').trim()];
    if (!emp) return;
    // leave 日期被 Sheets 存成 Date 物件時，用 normCellDate 正規化（避免日期陷阱）。
    const d = normCellDate(l['日期']);
    if (d.slice(0, 7) !== ym) return;
    const h = Number(l['時數']) || 0;
    const t = String(l['假別'] || '');
    const s = slot(emp);
    // 改版前這裡是寫死的關鍵字比對（含『事』→全扣…），新增假別必漏改；現在一律查假別表。
    const code = payLeaveCode(t, LTYPES);
    const lt = code ? LTMAP[code] : null;
    if (code) s.leaves[code] = payR2((s.leaves[code] || 0) + h);
    // 舊的五個欄位繼續維護：工時分頁的手動輸入欄與既有報表都還在讀它們
    if (code === 'personal')       s.personal_h += h;
    else if (code === 'menstrual') s.menstrual_h += h;
    else if (code === 'disaster')  s.disaster_h += h;
    else if (code === 'sick')      s.sick_h += h;
    else if (code === 'annual')    s.annual_h += h;
    else                           s.other_h += h;
    // 這種假對全勤的影響：attend_effect 留空＝沿用 count_absent（改版前行為）
    const ae = lt ? (lt.attend_effect || (lt.count_absent ? 'deduct' : 'none')) : 'deduct';
    if (ae === 'void') s.attend_void = true;          // 例：央廚／總部「有事假就沒全勤」
    if (ae === 'deduct' || ae === 'void') markDay(emp, d);
    // 出差之類「不算餐費出勤日」的，把當天從餐費天數扣掉
    if (lt && lt.count_meal_day === false) delete s._wd[d];
  });

  Object.keys(out).forEach(function (emp) {
    out[emp].deduct_days = Object.keys(out[emp]._days).length;
    out[emp].work_days = Object.keys(out[emp]._wd).length;
    out[emp].forget_day = Object.keys(out[emp]._fd).length;
    delete out[emp]._days; delete out[emp]._wd; delete out[emp]._fd;
  });
  return out;
}


/* ═══════════════════ 計算引擎（與 ~/mala-payroll 已驗證版本同一套公式）═══════════════════ */

function payR0(v) { return Math.round(v); }
function payR2(v) { return Math.round(v * 100) / 100; }
function payNum(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }
/** 布林讀取：接受 true/1/'1'/'true'/'TRUE'（試算表可能存成數字或字串） */
function payBool(v) { return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'; }

function payDaysIn(ym) {
  const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  return new Date(y, m, 0).getDate();
}

/** 到職／離職日字串（相容 Sheets 把純日期存成 Date 物件的陷阱）→ 'yyyy-MM-dd' */
function payDateStr(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  return String(v || '').trim().slice(0, 10);
}

/** 特休額度（台灣勞基法§38 週年制）：以薪資月月底為基準日，回當前週年期 {days, ps, pe}。
 *  滿6月未滿1年3日；1年7日；2年10日；3年14日；5年15日；10年起每年+1、上限30日。年資未滿6月回 days:0。 */
function payAnnualQuota(hireStr, ym) {
  const hs = payDateStr(hireStr); if (!hs) return null;
  const h = new Date(hs + 'T00:00:00'); if (isNaN(h)) return null;
  const asof = new Date(ym + '-' + pad2(payDaysIn(ym)) + 'T00:00:00');
  let months = (asof.getFullYear() - h.getFullYear()) * 12 + (asof.getMonth() - h.getMonth());
  if (asof.getDate() < h.getDate()) months--;
  if (months < 6) return { days: 0, ps: '', pe: '' };
  function addM(d, m) { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }
  const fmt = function (d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  if (months < 12) return { days: 3, ps: fmt(addM(h, 6)), pe: fmt(addM(h, 12)) };
  const y = Math.floor(months / 12);
  const days = y < 2 ? 7 : y < 3 ? 10 : y < 5 ? 14 : y < 10 ? 15 : Math.min(30, 15 + (y - 9));
  return { days: days, ps: fmt(addM(h, y * 12)), pe: fmt(addM(h, (y + 1) * 12)) };
}

/** 該門市有效的紅字天數清單（每月一筆，該店專屬優先），附 _src 標示來源供前端顯示 */
function payHolidayList(store) {
  const st = String(store || '');
  const rows = payRead('holiday');
  const byYm = {};
  rows.forEach(function (h) {
    const ym = String(h.ym), rs = String(h.store || '');
    if (rs === '') { if (!byYm[ym] || byYm[ym]._src !== 'own') { h._src = 'global'; byYm[ym] = h; } }
    else if (st && rs === st) { h._src = 'own'; byYm[ym] = h; }
  });
  return Object.keys(byYm).sort().map(function (k) { return byYm[k]; });
}

/** 取某門市某月的紅字天數設定：先找該門市專屬，沒有才用集團共用（store 空白）。
 *  ⚠ 這裡不可以用 payStore()——holiday 的空白代表「全集團共用」，不是預設店。 */
function payHolidayRow(ym, store) {
  const st = String(store || '');
  const rows = payRead('holiday').filter(function (h) { return String(h.ym) === String(ym); });
  const own = rows.filter(function (h) { return String(h.store || '') === st && st !== ''; })[0];
  if (own) return own;
  return rows.filter(function (h) { return String(h.store || '') === ''; })[0] || null;
}

/** 解析某月的國定假日日期清單。
 *  ⚠ 只填一天時 Sheets 會把 '2026-10-10' 存成日期物件，讀回是 Date 而不是字串——
 *  一律先過 payDateStr 正規化，否則比對不到打卡日期、雙薪會靜默失效。 */
function payHolidayDates(holRow) {
  if (!holRow) return [];
  const v = holRow.dates;
  if (v instanceof Date) return [payDateStr(v)];
  return String(v || '').split(/[,，\s]+/).filter(Boolean).map(function (x) { return payDateStr(x); });
}

/** 在職比例：月中到職／離職才折算，整月在職回 1 */
function payRatio(e, ym) {
  const D = payDaysIn(ym);
  const first = new Date(ym + '-01T00:00:00');
  const last  = new Date(ym + '-' + pad2(D) + 'T00:00:00');
  let s = first, t = last;
  const hs = payDateStr(e.hire_date), ls = payDateStr(e.leave_date);
  if (hs) { const h = new Date(hs + 'T00:00:00'); if (!isNaN(h) && h > s) s = h; }
  if (ls) { const l = new Date(ls + 'T00:00:00'); if (!isNaN(l) && l < t) t = l; }
  if (s > t) return 0;
  const d = Math.round((t - s) / 86400000) + 1;
  return Math.min(1, d / D);
}

/** 參數取值：未設定（欄位不存在／空白）才用預設；**0 是合法值**（例：某店不給加給就填 0），
 *  所以不能用 `payNum(v) || dflt` ——那會把 0 當成沒設定。 */
function payCfgNum(cfg, key, dflt) {
  const v = (cfg || {})[key];
  return (v === undefined || v === null || String(v).trim() === '') ? dflt : payNum(v);
}

/** 計時「年資加給」：任職滿指定月數「之後的次月」起，時薪 +N。
 *  例（預設 6 個月／+10）：到職 6/5 → 12/5 滿半年 → 隔年 1 月起（該月 1 號晚於滿期日才算）。
 *  ⚠ 2026-08-24 起金額與年資門檻改為門市可覆寫參數（pt_tenure_plus／pt_tenure_months），
 *    不再寫死——央廚等門市的加給規則可能與光復不同。cfg 沒帶＝用預設，行為與改版前相同。 */
function payTenurePlus(e, ym, cfg) {
  const plus = payCfgNum(cfg, 'pt_tenure_plus', 10);
  const months = payCfgNum(cfg, 'pt_tenure_months', 6);
  if (!plus) return 0;
  const hs = payDateStr(e.hire_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hs)) return 0;
  const h = new Date(hs + 'T00:00:00');
  const due = new Date(h.getFullYear(), h.getMonth() + months, h.getDate());
  const monthStart = new Date(ym + '-01T00:00:00');
  return monthStart > due ? plus : 0;
}

function payCalcOne(e, ym, att, cfg, redDays, ltypes) {
  // 假別規則一律由 ltypes（payroll_leave_type）決定；不傳時退回內建預設，
  // 這樣 payroll_mock.js 只抽這支函式也算得出來，不必碰試算表。
  const LT = (ltypes && ltypes.length) ? ltypes : payLeaveTypes('');
  const LTM = {}; LT.forEach(function (t) { LTM[t.code] = t; });
  const D = payDaysIn(ym), P = payRatio(e, ym);
  const earn = [], ded = [];
  const ft = String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true;
  function push(L, key, label, qty, rate, amt) {
    L.push({ item_key: key, item_label: label, qty: qty, rate: rate, amount: payR0(amt) });
  }

  let baseH = null, surplus = null, otPaid = null;
  const supportH = (att.support || []).reduce(function (a, s) { return a + payNum(s.hours); }, 0);

  if (ft) {
    // 正職：加班／不足時數以「本店核定＋支援」的總時數對基本工時判斷（支援併入，用員工加班費率）
    baseH = payR2((D - redDays) * payNum(cfg.daily_hours) * P);
    surplus = payR2((att.hours + supportH) - baseH);
    otPaid = payR2((surplus > 0 ? surplus : 0) + payNum(att.extra_ot));
    push(earn, 'base_salary', '底薪', null, null, payNum(e.base) * P);
    if (otPaid > 0) push(earn, 'overtime', '加班', otPaid, payNum(e.ot_rate), otPaid * payNum(e.ot_rate));
    if (surplus < 0) {
      // 不足時數倒扣，但先扣掉已請假時數——那些另有處理，不重複倒扣。
      // 哪些假可以抵扣改讀假別表的 offset_shortfall（改版前是寫死的五種假）。
      const LMAP = payAttLeaves(att);
      let paidLeave = 0;
      Object.keys(LMAP).forEach(function (c) {
        const t = LTM[c];
        if (!t || t.offset_shortfall) paidLeave += payNum(LMAP[c]);
      });
      const shortH = payR2(Math.max(0, Math.abs(surplus) - paidLeave));
      if (shortH > 0) push(ded, 'shortfall_hours', '不足時數', shortH, payNum(e.ot_rate), shortH * payNum(e.ot_rate));
    }
    if (payNum(e.attend_cap) > 0) {
      /* 全勤獎金＝遞減式（缺勤天數 × 每日倒扣）。
       * 2026-08-23 加「門檻式歸零」：忘刷次數／遲到累計分鐘／早退累計分鐘任一達門檻，或請了
       * attend_effect='void' 的假（例：央廚／總部「有事假就沒全勤」）→ 整筆歸零。
       * ⚠ 三個門檻參數預設 0＝不啟用，assend_effect 預設留空＝沿用舊行為，
       *   所以沒設定的門市（光復）算出來與改版前完全相同。 */
      const voidReason = payAttendVoid(att, cfg);
      const bonusAmt = voidReason ? 0
        : Math.max(0, payNum(e.attend_cap) * P - att.deduct_days * payNum(cfg.attend_deduct_per_day));
      push(earn, 'attend_bonus', '全勤獎金' + (voidReason ? '（' + voidReason + '）' : ''), null, null, bonusAmt);
    }
    // 餐費補助（正職）：工時分頁勾選才算＝出勤天數 × 餐費補助/日（主檔 meal_allow，無預設）。按實際天數不另乘 P。
    const mealRate = payNum(e.meal_allow);
    const wd = payNum(att.work_days);
    if (payBool(att.meal_on) && mealRate > 0 && wd > 0) push(earn, 'meal_sub', '餐費補助', wd, mealRate, wd * mealRate);
  } else {
    // 計時：本店時數 × 時薪；時薪加給＝滿勤(工時分頁手動打勾)+10、年資(滿半年次月起)+10，可疊加
    // 本月時薪：工時分頁填了 wage_override 就用該月值，否則用主檔 wage（計時每月時薪可不同、又保留歷史）
    let w = payNum(att.wage_override) > 0 ? payNum(att.wage_override) : payNum(e.wage);
    // E1 滿勤加給：管理者於工時分頁手動勾選（滿100H+全勤由管理者判定）。金額門市可覆寫（0＝不給）
    if (payBool(att.full_attend)) w += payCfgNum(cfg, 'pt_attend_plus', 10);
    w += payTenurePlus(e, ym, cfg);          // E2 年資加給（金額與年資門檻同樣可依門市覆寫）
    push(earn, 'hourly_wage', '薪資（時數）', payR2(att.hours), w, att.hours * w);
    // 國定假日出勤：計時同仁時薪雙倍（正職是給假、不另計）。
    // 時數本身已含在上面的總時數裡，這裡只補「多的那一倍」。
    const holH = payR2(Math.min(payNum(att.holiday_h), payNum(att.hours)));
    if (holH > 0) push(earn, 'holiday_double', '國定假日加倍', holH, w, holH * w);
  }

  const pr = ft ? P : 1;
  if (payNum(e.skill_allow))  push(earn, 'skill_allow', '職能津貼', null, null, payNum(e.skill_allow) * pr);
  if (payNum(e.night_allow))  push(earn, 'night_allow', '夜間津貼', null, null, payNum(e.night_allow) * pr);
  if (payNum(e.mgr_allow))    push(earn, 'mgr_allow', '店長津貼', null, null, payNum(e.mgr_allow) * pr);
  if (payNum(e.editor_allow)) push(earn, 'editor_allow', '小編津貼', null, null, payNum(e.editor_allow));
  // 自訂加薪／扣款（工時分頁逐月填，名稱自訂）
  if (payNum(att.custom_add_amt)) push(earn, 'custom_add', String(att.custom_add_label || '自訂加薪'), null, null, payNum(att.custom_add_amt));
  // 獎金（獎金分頁登記，逐筆併入加項；item_key 帶類型供成本分類歸科目）
  const BONUS_KEY = { sales: 'bonus_sales', perf: 'bonus_perf', project: 'bonus_project' };
  const BONUS_DEF = { sales: '業績獎金', perf: '績效獎金', project: '專案獎金' };
  (att.bonuses || []).forEach(function (b) {
    const amt = payNum(b.amount);
    if (!amt) return;
    const t = String(b.bonus_type || 'project');
    push(earn, BONUS_KEY[t] || 'bonus_project', String(b.label || BONUS_DEF[t] || '獎金'), null, null, amt);
  });

  /* 跨店支援明細：
     - 計時：支援時數 × 支援門市費率，獨立加項（留空金額＝時數×費率；填了以填的為準）。
     - 正職：支援時數已併入上面的總時數、以員工加班費率計酬，這裡不再獨立列（門市/費率仍保留於工時分頁供記錄）。 */
  if (!ft) {
    (att.support || []).forEach(function (s) {
      const h = payNum(s.hours), rt = payNum(s.rate);
      const amt = (s.amount === '' || s.amount == null) ? h * rt : payNum(s.amount);
      if (!amt && !h) return;
      push(earn, 'cross_store', '支援' + (s.store ? '－' + s.store : ''), h, rt, amt);
    });
  }

  // 請假扣款：費率用「未折算」的全額（費率是職位時薪，不因月中到職而改變）
  const rate = payR0(
    (payNum(e.base) + payNum(e.skill_allow) + payNum(e.night_allow) +
     payNum(e.mgr_allow) + payNum(e.attend_cap)) / payNum(cfg.leave_div_days) / payNum(cfg.leave_div_hours)
  );
  /* 請假扣款：一律查假別表算，不再逐種假寫死。
   *   扣款率 ＝ rate ×（1 − 給薪比例）：事假 0%→全扣、病假 50%→扣一半、特休 100%→不扣。
   *   年度上限：超過 cap_days 的部分改用 over_ratio（病假逾 30 日→無薪全扣）。
   *   年資門檻：年資未達 tenure_months 者用 under_ratio（產假未滿 6 個月→減半）。
   *   att.leave_usage 帶「本月之前」已用日數，沒帶＝當作 0（單月獨立計算）。 */
  /* 特休未休完折算工資（勞基法§38，2026-08-23 加）
   * 只在「週年期屆滿前一日所在的月份」發一次；折算率用平日每小時工資額（＝下方請假費率同一條）。
   * 計時同仁沒有特休（att.annual 為 null），自然不會進來。 */
  if (att.annual && att.annual.payout_ym === ym && payNum(att.annual.left_h) > 0) {
    const ah = payR2(payNum(att.annual.left_h));
    push(earn, 'annual_payout', '特休未休折算', ah, rate, ah * rate);
  }

  const LEAVES = payAttLeaves(att);
  const dayH = payLeaveDayHours(cfg);
  const tenureM = payTenureMonths(e.hire_date, ym);
  Object.keys(LEAVES).sort().forEach(function (code) {
    const h = payNum(LEAVES[code]);
    if (!h) return;
    const t = LTM[code];
    if (!t) return;   // 對不到假別＝不扣款，與改版前的 other_h 行為相同
    let ratio = t.pay_ratio;
    if (t.tenure_months != null && tenureM != null && tenureM < t.tenure_months) ratio = t.under_ratio;
    const usage = (att.leave_usage || {})[code] || {};
    const before = payNum(usage.used_before_days);
    let overH = 0;
    if (t.cap_days != null && t.cap_basis !== 'tenure') {
      const days = h / dayH;
      const within = Math.max(0, Math.min(days, t.cap_days - before));
      overH = payR2(Math.max(0, days - within) * dayH);
    }
    const withinH = payR2(h - overH);
    const r1 = payR0(rate * (1 - ratio));
    const r2 = payR0(rate * (1 - t.over_ratio));
    const amt = withinH * r1 + overH * r2;
    // 全薪假（特休、婚喪、公傷、公假…）本來就不該有扣款列。
    // ⚠ 但「該扣卻扣到 0」的必須照印——計時同仁 base=0 → rate=0 → 事假金額 0，
    //    舊版會印出「事假 8H $0」這一列，濾掉會讓計時的薪資單少一列（金額不變但看得出差別）。
    if (!amt && ratio >= 1) return;
    const label = t.name + (ratio === 0 ? '(無薪)' : '') + (overH > 0 ? '（含逾上限 ' + payR2(overH / dayH) + ' 日）' : '');
    push(ded, code + '_leave', label, h, (overH > 0 ? null : r1), amt);
  });

  // 勞保與宿舍折算；健保、團保、退休金算整月。
  // ⚠ 2026-08-23 修正：規則正本「勞保、宿舍×P」不分正職計時——原本這兩行乘的是 pr（計時恆為 1），
  //   計時同仁月中到職／離職會被收整月的勞保與宿舍。改乘 P（正職 pr===P，行為不變）。
  if (payNum(e.labor_ins))  push(ded, 'labor_ins', '勞保費', null, null, payNum(e.labor_ins) * P);
  // 宿舍費隨月：工時分頁填了「本月宿舍費」（含 0＝本月免收）就用該月值，空白＝用主檔
  const dormFee = (att.dorm_override === '' || att.dorm_override == null) ? payNum(e.dormitory) : payNum(att.dorm_override);
  if (dormFee) push(ded, 'dormitory', '宿舍自付額', null, null, dormFee * P);
  if (payNum(e.health_ins)) push(ded, 'health_ins', '健保費', null, null, payNum(e.health_ins));
  if (payNum(e.group_ins))  push(ded, 'group_ins', '團保費', null, null, payNum(e.group_ins));
  if (payNum(e.pension))    push(ded, 'pension', '退休金', null, null, payNum(e.pension));
  if (payNum(att.custom_ded_amt)) push(ded, 'custom_ded', String(att.custom_ded_label || '自訂扣款'), null, null, payNum(att.custom_ded_amt));

  const gross = earn.reduce(function (a, b) { return a + b.amount; }, 0);
  const deduct = ded.reduce(function (a, b) { return a + b.amount; }, 0);
  return {
    emp_id: e.emp_id, name: e.name, is_full_time: ft, ratio: P,
    total_hours: payR2(att.hours), support_hours: payR2(supportH),
    base_hours: baseH, surplus_hours: surplus, ot_paid_hours: otPaid,
    earn: earn, ded: ded, gross: gross, deduction: deduct, net: gross - deduct, leave_rate: rate,
  };
}

/* run row ＋ item rows → 還原成 payCalcOne 形狀的 result（前端只認這一種形狀）。
 * ⚠ 放在引擎區段（Handlers 標記之前），讓 payroll_mock.js 能一併抽出、測到本重組邏輯。
 * 攤平時 payItemRow 會把 null 的 qty/rate 寫成 ''，這裡一律還原成 null（前端用 !=null 判斷是否顯示時數/單價）。*/
function payRunItemsToResult(run, items) {
  function toLine(i) {
    return {
      item_key:  i.item_key,
      item_label: i.item_label,
      qty:  (i.qty  === '' || i.qty  == null) ? null : Number(i.qty),
      rate: (i.rate === '' || i.rate == null) ? null : Number(i.rate),
      amount: Number(i.amount),
    };
  }
  const earn = items.filter(function (i) { return String(i.item_type) === 'earning'; }).map(toLine);
  const ded  = items.filter(function (i) { return String(i.item_type) === 'deduction'; }).map(toLine);
  return {
    emp_id: run.emp_id, name: run.name, is_full_time: run.is_full_time, ratio: Number(run.ratio),
    total_hours: Number(run.total_hours), support_hours: Number(run.support_hours) || 0, base_hours: Number(run.base_hours),
    surplus_hours: Number(run.surplus_hours), ot_paid_hours: Number(run.ot_paid_hours),
    earn: earn, ded: ded,
    gross: Number(run.gross), deduction: Number(run.deduction), net: Number(run.net),
  };
}

/* 排班系統(mala_employees 一筆) → 薪資主檔欄位。只對映排班「有」的欄位；
   缺口欄位(勞健保/團保/退休金/小編津貼/在職/離職)不在這裡，交給 payMergeScheduleMaster 保留既有值。 */
function paySchedFieldsToMaster(s) {
  function num(v) { return (v === '' || v == null || isNaN(Number(v))) ? 0 : Number(v); }
  return {
    emp_id: String(s.id),
    name: s.name,
    is_full_time: (s.isFullTime === true || String(s.isFullTime).toLowerCase() === 'true') ? 'true' : 'false',
    wage: num(s.wage), base: num(s.base), ot_rate: num(s.otRate),
    skill_allow: num(s.skillAllow), night_allow: num(s.nightAllow), mgr_allow: num(s.mgrAllow),
    attend_cap: num(s.attendBonus), dormitory: num(s.dormitory),
    hire_date: s.hireDate || '',
  };
}

/* 合併：以既有主檔為底，套上排班帶來的欄位；缺口欄位沿用既有值(新人給預設)。
   ⚠ 放引擎區段讓 payroll_mock.js 抽出、測得到「缺口保留」邏輯——這正是手動微調不被帶入蓋掉的關鍵。
   既有主檔裡排班沒有的人(離職但沒清)會原封保留，不會被刪。 */
/* nameToEmp：{排班姓名 → 打卡 roster 的 emp_id}。⚠ 排班系統自己的 id（uid）與打卡 emp_id 是兩套，
   工時歸集(payCollect)用的是 roster emp_id，所以主檔必須也用 roster emp_id，否則計算時工時接不到人（全 0）。
   唯一能對起來的是姓名。傳 nameToEmp 時以它為準；沒傳時（mock 單元測試）退回用排班自己的 id。
   姓名在 roster 找不到的排班員工 → 收進 skipped、不寫入（沒有打卡身分就無法計薪）。*/
function payMergeScheduleMaster(existing, schedEmployees, nameToEmp) {
  const GAP = { editor_allow: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, leave_date: '', active: 'true' };
  const byId = {};
  (existing || []).forEach(function (m) { byId[String(m.emp_id)] = m; });
  const updated = [], added = [], skipped = [];
  (schedEmployees || []).forEach(function (s) {
    const nm = String(s.name || '').trim();
    const empId = nameToEmp ? nameToEmp[nm] : String(s.id);
    if (!empId) { skipped.push(nm || String(s.id)); return; }
    const mapped = paySchedFieldsToMaster(s);
    mapped.emp_id = String(empId);   // 用打卡 roster 的 emp_id，不是排班自己的 id
    const prev = byId[mapped.emp_id];
    const gap = {};
    Object.keys(GAP).forEach(function (k) {
      gap[k] = (prev && prev[k] !== undefined && prev[k] !== '') ? prev[k] : GAP[k];
    });
    byId[mapped.emp_id] = Object.assign({}, gap, mapped);   // gap 先、mapped 後：排班欄位覆蓋，缺口欄位保留
    (prev ? updated : added).push(mapped.name);
  });
  return { master: Object.keys(byId).map(function (k) { return byId[k]; }), updated: updated, added: added, skipped: skipped };
}

/** 某日期字串的前一日（yyyy-MM-dd）。空字串或格式不對就原樣回傳。 */
function payDayBefore(dstr) {
  const d = payDateStr(dstr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return String(dstr || '');
  const x = new Date(d + 'T00:00:00');
  if (isNaN(x.getTime())) return d;
  x.setDate(x.getDate() - 1);
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}

/** 全勤是否整筆歸零；回歸零原因字串，沒歸零回空字串。
 *  參數全部可依門市覆寫（payroll_config 的 store 欄），預設 0／空＝不啟用。 */
function payAttendVoid(att, cfg) {
  if (att.attend_void) return '請假未達全勤';
  const unit = String((cfg || {}).attend_forget_unit || 'punch');
  const fCap = payNum((cfg || {}).attend_void_forget);
  if (fCap > 0) {
    const n = (unit === 'day') ? payNum(att.forget_day) : payNum(att.forget_punch);
    if (n >= fCap) return '忘刷' + n + (unit === 'day' ? '天' : '次');
  }
  const lCap = payNum((cfg || {}).attend_void_late_min);
  if (lCap > 0 && payNum(att.late_min) >= lCap) return '遲到累計' + payR2(att.late_min) + '分';
  const eCap = payNum((cfg || {}).attend_void_early_min);
  if (eCap > 0 && payNum(att.early_min) >= eCap) return '早退累計' + payR2(att.early_min) + '分';
  return '';
}

/** 把 att 上的請假時數整理成 { 假別code: 時數 }。
 *  ⚠ 這五個舊欄位（personal_h…disaster_h）在工時分頁有手動輸入格，payInputsBase 已經處理過
 *  「空白＝用歸集值、有填＝以填的為準」，所以這裡一律以它們為準，其餘假別才取 att.leaves。 */
function payAttLeaves(att) {
  const out = {};
  const raw = (att && att.leaves) || {};
  Object.keys(raw).forEach(function (k) { if (payNum(raw[k])) out[k] = payNum(raw[k]); });
  const legacy = { personal: 'personal_h', sick: 'sick_h', menstrual: 'menstrual_h',
                   annual: 'annual_h', disaster: 'disaster_h' };
  Object.keys(legacy).forEach(function (code) {
    const v = payNum(att[legacy[code]]);
    if (v) out[code] = v; else delete out[code];
  });
  return out;
}

/** 到職到該月月底的年資（月數）。到職日沒填回 null（呼叫端一律當作「年資門檻不適用」）。 */
function payTenureMonths(hireDate, ym) {
  const hd = payDateStr(hireDate);
  if (!hd || !/^\d{4}-\d{2}-\d{2}$/.test(hd)) return null;
  const hy = parseInt(hd.slice(0, 4), 10), hm = parseInt(hd.slice(5, 7), 10), hdd = parseInt(hd.slice(8, 10), 10);
  const y = parseInt(String(ym).slice(0, 4), 10), m = parseInt(String(ym).slice(5, 7), 10);
  const eom = payDaysIn(ym);
  let months = (y - hy) * 12 + (m - hm);
  if (eom < hdd) months -= 1;   // 月底日數不足到職日 → 該月尚未滿月
  return Math.max(0, months);
}

/** 每位員工在「本月之前」已用掉的假別日數（給年度上限用）。
 *  回 { emp_id: { code: { used_before_days } } }
 *
 *  ⚠ 三個必守的點：
 *   ① 跨店累計——沿用特休那套 payEmpStoresMap()，調店不會讓額度歸零。
 *   ② 只算「本月之前」——本月的時數要留給 payCalcOne 自己切「上限內／逾上限」。
 *   ③ 迴圈外把表讀完再進迴圈（payRead／payClockRead 都不准出現在逐人迴圈裡，效能鐵則）。
 *  cap_basis 是 event（婚喪產檢）或 tenure（特休）的不在這裡處理：
 *  前者一年可能發生多次、後者額度另由 payAnnualQuota 算。 */
function payLeaveUsedBefore(ym, store, ltypes, cfg, master) {
  const out = {};
  const capped = (ltypes || []).filter(function (t) {
    return t.cap_days != null && (t.cap_basis === 'calendar' || t.cap_basis === 'child');
  });
  if (!capped.length) return out;

  const dayH = payLeaveDayHours(cfg);
  const year = String(ym).slice(0, 4);
  const firstOfMonth = ym + '-01';
  const empStores = payEmpStoresMap();
  const stA = payStore(store);

  const leaveCache = {};
  function leavesOf(st) {
    if (leaveCache[st]) return leaveCache[st];
    let rows = [];
    try { rows = payClockRead(st, 'leave'); } catch (err) { rows = []; }
    leaveCache[st] = rows;
    return rows;
  }
  const savedRows = payRead('input');           // 打卡上線前的月份，假別時數在手動工時裡
  const legacyCol = { personal: 'personal_h', sick: 'sick_h', menstrual: 'menstrual_h',
                      annual: 'annual_h', disaster: 'disaster_h' };

  (master || []).forEach(function (e) {
    const emp = String(e.emp_id);
    const acc = {};
    // ① 手動工時（只有舊的五個欄位有格子）
    savedRows.forEach(function (r) {
      if (String(r.emp_id) !== emp) return;
      const m = String(r.ym);
      if (!/^\d{4}-\d{2}$/.test(m) || m.slice(0, 4) !== year || m >= ym) return;
      capped.forEach(function (t) {
        const col = legacyCol[t.code];
        if (col) acc[t.code] = (acc[t.code] || 0) + payNum(r[col]) / dayH;
      });
    });
    // ② leave 分頁（歷任門市）
    (empStores[emp] || [stA]).forEach(function (st2) {
      leavesOf(st2).forEach(function (l) {
        if (String(l['姓名'] || '').trim() !== String(e.name || '').trim()) return;
        const d = normCellDate(l['日期']);
        if (!d || d.slice(0, 4) !== year || d >= firstOfMonth) return;
        const code = payLeaveCode(String(l['假別'] || ''), ltypes);
        if (!code) return;
        acc[code] = (acc[code] || 0) + (Number(l['時數']) || 0) / dayH;
      });
    });
    // ③ 併入：家庭照顧假全額吃事假額度、生理假逾上限的部分吃病假額度
    (ltypes || []).forEach(function (t) {
      if (!t.merge_into) return;
      const u = acc[t.code] || 0;
      if (!u) return;
      const add = (t.cap_days == null) ? u
                : (t.code === 'family' ? u : Math.max(0, u - t.cap_days));
      if (add > 0) acc[t.merge_into] = (acc[t.merge_into] || 0) + add;
    });
    const slot = {};
    capped.forEach(function (t) { slot[t.code] = { used_before_days: payR2(acc[t.code] || 0) }; });
    out[emp] = slot;
  });
  return out;
}

/* ═══════════════════ 假別參數表（2026-08-22 上線）═══════════════════
 *  在此之前，假別是「用關鍵字比對寫死在程式裡」的（含『事』→全扣、含『病』→半薪…），
 *  新增一種假就要改 Code.gs／manager.html／mock 三處＋薪資引擎，漏一處就默默算成全薪。
 *  現在改成資料驅動：payroll_leave_type 一列一種假，值班核定的下拉、薪資扣款、額度上限
 *  全部讀同一張表。Eason 在表上加一列就多一種假，不必改程式。
 *
 *  ⚠ 表是空的時候一律回 PAY_LEAVE_DEFAULTS（下方內建），所以「還沒建表」不會讓系統壞掉。 */

/** 給薪比例：1＝全薪不扣、0.5＝半薪、0＝無薪全額扣。
 *  count_absent＝計入缺勤天數（扣全勤）；offset_shortfall＝抵扣不足時數（那天沒上班不該再倒扣）。
 *  cap_days＋cap_basis＝年度上限；超過上限的部分改用 over_ratio 計薪。
 *  merge_into＝超過上限後併入哪個假別的額度（法規用語「併入○○假計算」）。
 *  tenure_months＋under_ratio＝年資未達門檻時的給薪比例（產假：未滿 6 個月減半）。 */
const PAY_LEAVE_DEFAULTS = [
  // ⚠ count_absent（扣全勤）2026-08-23 Eason 定案改為「依法」：只有事假／病假／住院傷病假可扣全勤。
  //    特休、生理、家庭照顧、喪假、婚假依勞工請假規則§9 與性平法§21 不得扣發全勤獎金，全部改 false。
  //    （改版初期為了不動既有數字曾一律沿用舊的 8 種 true，正式環境已於同日改為現在這套，本表跟上。）
  // min_unit：hour＝可用小時請、half＝半日、day＝只能整日。
  // window_before／window_days／window_max：期限規則，以「事件日」為基準（payroll_leave_event）。
  //    例婚假＝結婚登記日前 10 日起、3 個月內請畢、經同意可延至 1 年。
  // code            name                        pay  absent short cap  basis       over merge      permo ten under unit    wbef wdays wmax  note
  ['annual',        '特休假',                    1,   false, true, '',  'tenure',   0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞基法§38 依年資 3/7/10/14/15…30 天；年度終結未休完自動折算工資'],
  ['personal',      '事假',                      0,   true,  true, 14,  'calendar', 0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞工請假規則§7 全年 14 日，不給薪'],
  ['sick',          '病假',                      0.5, true,  true, 30,  'calendar', 0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞工請假規則§4 未住院全年 30 日內半薪，超過不給薪。⚠2026新制：1 年內未逾 10 日不得為不利處分'],
  ['sick_hosp',     '住院傷病假',                0.5, true,  true, 365, 'calendar', 0,   '',        '',   '', '',   'hour', '',  '',   '',   '住院傷病假 2 年內合計不超過 1 年；與未住院病假合計亦不得逾 1 年'],
  ['prenatal_rest', '安胎休養假',                0.5, false, true, 365, 'calendar', 0,   'sick_hosp','',  '', '',   'hour', '',  '',   '',   '性平法§15 併入住院傷病假計算，2 年合計不超過 1 年；須醫師診斷需安胎休養。半薪'],
  ['menstrual',     '生理假',                    0.5, false, true, 3,   'calendar', 0.5, 'sick',    1,    '', '',   'hour', '',  '',   '',   '性平法§14 每月 1 日；全年 3 日不併入病假，超過的併入病假額度（仍半薪）'],
  ['family',        '家庭照顧假',                0,   false, true, 7,   'calendar', 0,   'personal','',   '', '',   'hour', '',  '',   '',   '性平法§20 全年 7 日、併入事假 14 日額度、不給薪'],
  ['funeral8',      '喪假（父母・配偶）',        1,   false, true, 8,   'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞工請假規則§3 父母、養父母、繼父母、配偶喪亡：8 日，工資照給；只計工作日、可用小時請'],
  ['funeral6',      '喪假（祖父母・子女・配偶父母）', 1, false, true, 6, 'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '祖父母、子女、配偶之父母／養父母／繼父母喪亡：6 日，工資照給'],
  ['funeral3',      '喪假（曾祖父母・兄弟姊妹）',1,   false, true, 3,   'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '曾祖父母、兄弟姊妹、配偶之祖父母喪亡：3 日，工資照給'],
  ['marriage',      '婚假',                      1,   false, true, 8,   'event',    0,   '',        '',   '', '',   'hour', 10,  90,   365,  '勞工請假規則§2 8 日，工資照給；結婚登記日前 10 日起 3 個月內請畢，經雇主同意可延至 1 年'],
  ['disaster',      '天災假',                    0,   false, true, '',  '',         0,   '',        '',   '', '',   'day',  '',  '',   '',   '天災事變停止上班，不給薪但不扣全勤'],
  ['occupational',  '公傷病假',                  1,   false, true, '',  '',         0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞基法§59 職災醫療中不能工作期間，原領工資照給，無日數上限'],
  ['maternity',     '產假（分娩）',              1,   false, true, 56,  'event',    0,   '',        '',   6,  0.5,  'day',  '',  '',   '',   '勞基法§50 分娩前後 8 週；年資未滿 6 個月工資減半'],
  ['miscarriage3',  '流產假（妊娠3個月以上）',   1,   false, true, 28,  'event',    0,   '',        '',   6,  0.5,  'day',  '',  '',   '',   '勞基法§50 妊娠 3 個月以上流產：4 週；年資未滿 6 個月工資減半'],
  ['miscarriage2',  '流產假（妊娠2～未滿3個月）',0,   false, true, 7,   'event',    0,   '',        '',   '', '',   'day',  '',  '',   '',   '性平法§15 妊娠 2 個月以上未滿 3 個月流產：1 週；不適用工資照給規定（預設不給薪，公司要給可改）'],
  ['miscarriage1',  '流產假（妊娠未滿2個月）',   0,   false, true, 5,   'event',    0,   '',        '',   '', '',   'day',  '',  '',   '',   '性平法§15 妊娠未滿 2 個月流產：5 日；不適用工資照給規定（預設不給薪，公司要給可改）'],
  ['prenatal',      '產檢假',                    1,   false, true, 7,   'event',    0,   '',        '',   '', '',   'half', '',  '',   '',   '性平法§15 7 日，工資照給；限懷孕期間使用，可用半日或小時請，未休完不折算'],
  ['paternity',     '陪產檢及陪產假',            1,   false, true, 7,   'event',    0,   '',        '',   '', '',   'half', 7,   14,   '',   '性平法施行細則§7 於配偶分娩「當日及其前後合計 15 日」內擇 7 日請畢＝分娩日前後各 7 天（前7＋當日＋後7＝15 日）'],
  ['official',      '公假',                      1,   false, true, '',  '',         0,   '',        '',   '', '',   'hour', '',  '',   '',   '依事實需要給假，工資照給'],
  ['jobseek',       '謀職假',                    1,   false, true, '',  '',         0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞基法§16 預告終止契約期間，每週不超過 2 日之工作時間，工資照給'],
  ['parental',      '育嬰假',                    0,   false, true, 720, 'child',    0,   '',        '',   '', '',   'day',  '',  '',   '',   '育嬰留停：每一子女 3 歲前最長 2 年（24 個月＝720 日）；另有「以日 30 日」「以月未滿 6 個月 2 次」兩條線'],
  // ⚠ 出差不是請假，是「在工作、只是人不在店裡」——放在這張表只是為了共用值班核定頁的下拉。
  //    給薪 100%、不扣全勤，時數走主管核定的時段（照常計薪），所以 offset_shortfall 設 false
  //    避免與已計入的工時重複折抵。最後一欄 false＝當天不給餐費補助（出差另有差旅費）。
  ['trip',          '出差',                      1,   false, false, '', '',         0,   '',        '',   '', '',   'hour', '',  '',   '',   '出差：時數照算、工資照給、不扣全勤；當天不計餐費補助（另有差旅費）', false],
];

/** 育嬰留停專屬額度（性平法§16＋育嬰留停實施辦法，Eason 2026-08-22 指定）
 *  以日申請合計上限 30 日；以月申請未滿 6 個月者以 2 次為限，6 個月以上不限次數。
 *  這三條線各自獨立檢查，且以日申請的日數同樣併入 24 個月總額。 */
const PAY_PARENTAL = {
  code: 'parental',
  total_months: 24,     // 每一子女總額（月）
  day_unit_cap: 30,     // 以日為單位申請，合計上限（日）
  short_month_cap: 2,   // 以月申請但未滿 6 個月者，次數上限
  short_month_len: 6,   // 「未滿 6 個月」的門檻
};

/** 讀假別表；表不存在或全空 → 回內建預設（系統不會因為沒建表而壞掉）。
 *  依門市覆寫：該店專屬列（store 有填）優先於集團共用列（store 空白），與參數設定同一套規則。 */
function payLeaveTypes(store) {
  // ⚠ payroll_mock.js 只抽「payR0 → Handlers」這段，payStore／payRead 不在切片內，
  //    所以兩者都要包 try——本機測試才不會 ReferenceError，且自動退回內建預設。
  let st = '';
  try { st = payStore(store); } catch (err) { st = String(store || ''); }
  let rows = [];
  try { rows = payRead('leave_type'); } catch (err) { rows = []; }
  const pick = {};
  rows.forEach(function (r) {
    const code = String(r.code || '').trim();
    if (!code) return;
    if (payBool(r.active) === false && String(r.active).trim() !== '') return;
    const rs = String(r.store || '').trim();
    if (rs && payStore(rs) !== st) return;          // 別店專屬列，跳過
    if (pick[code] && !rs) return;                  // 已有該店專屬列，集團預設不覆蓋
    pick[code] = {
      code: code,
      name: String(r.name || '').trim(),
      pay_ratio: payNum(r.pay_ratio),
      count_absent: payBool(r.count_absent),
      offset_shortfall: payBool(r.offset_shortfall),
      cap_days: (r.cap_days === '' || r.cap_days == null) ? null : payNum(r.cap_days),
      cap_basis: String(r.cap_basis || '').trim(),
      over_ratio: payNum(r.over_ratio),
      merge_into: String(r.merge_into || '').trim(),
      cap_per_month: (r.cap_per_month === '' || r.cap_per_month == null) ? null : payNum(r.cap_per_month),
      tenure_months: (r.tenure_months === '' || r.tenure_months == null) ? null : payNum(r.tenure_months),
      under_ratio: payNum(r.under_ratio),
      min_unit: String(r.min_unit || 'hour').trim(),
      window_before: (r.window_before === '' || r.window_before == null) ? null : payNum(r.window_before),
      window_days:   (r.window_days   === '' || r.window_days   == null) ? null : payNum(r.window_days),
      window_max:    (r.window_max    === '' || r.window_max    == null) ? null : payNum(r.window_max),
      attend_effect: String(r.attend_effect || '').trim(),
      // 留空一律當 true（＝改版前行為：有核定滿 6H 就算一天）
      // ⚠ Sheets 會把字串 'false' 存成**布林 FALSE**，此時 `r.x || ''` 會把 false 吃成空字串
      //   → 判成 true，出差就又給餐費了（實際踩過）。布林要先單獨判。
      count_meal_day: (r.count_meal_day === false
                       || String(r.count_meal_day == null ? '' : r.count_meal_day).trim().toLowerCase() === 'false')
                      ? false : true,
      sort: payNum(r.sort),
      note: String(r.note || ''),
    };
  });
  const list = Object.keys(pick).map(function (k) { return pick[k]; });
  if (list.length) return list.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  return PAY_LEAVE_DEFAULTS.map(function (d, i) {
    return {
      code: d[0], name: d[1], pay_ratio: d[2], count_absent: d[3], offset_shortfall: d[4],
      cap_days: (d[5] === '' ? null : d[5]), cap_basis: d[6], over_ratio: d[7], merge_into: d[8],
      cap_per_month: (d[9] === '' ? null : d[9]),
      tenure_months: (d[10] === '' ? null : d[10]), under_ratio: (d[11] === '' ? 0 : d[11]),
      min_unit: d[12] || 'hour',
      window_before: (d[13] === '' ? null : d[13]),
      window_days:   (d[14] === '' ? null : d[14]),
      window_max:    (d[15] === '' ? null : d[15]),
      attend_effect: '',   // 內建預設一律留空＝沿用 count_absent，避免動到既有全勤計算
      count_meal_day: (d[17] === false ? false : true),
      sort: (i + 1) * 10, note: d[16],
    };
  });
}

/** 把 leave 分頁的中文假別名對到假別表的 code。
 *  比對順序：①完全相同 ②表上的名字是輸入的開頭或反之（容忍「病假(住院)」這類寫法）
 *  ③舊資料的關鍵字後備（含『事』『生理』『災』『病』『特』），確保改版前的紀錄照樣算得出來。
 *  都對不到 → 回 null，呼叫端記進 other_h（不扣款，行為與改版前相同）。 */
function payLeaveCode(name, types) {
  const n = String(name || '').trim();
  if (!n) return null;
  for (let i = 0; i < types.length; i++) if (types[i].name === n) return types[i].code;
  for (let i = 0; i < types.length; i++) {
    const tn = types[i].name;
    if (tn && (n.indexOf(tn) === 0 || tn.indexOf(n) === 0)) return types[i].code;
  }
  const has = function (s) { return n.indexOf(s) !== -1; };
  if (has('育嬰')) return 'parental';
  if (has('公傷') || has('職災')) return 'occupational';
  if (has('安胎')) return 'prenatal_rest';
  if (has('謀職')) return 'jobseek';
  if (has('住院')) return 'sick_hosp';
  if (has('產檢') && !has('陪')) return 'prenatal';
  if (has('陪產')) return 'paternity';
  if (has('流產')) return 'miscarriage3';   // 舊資料沒分週數，歸最常見的「3個月以上」，需要時人工改
  if (has('產')) return 'maternity';
  if (has('家庭')) return 'family';
  if (has('喪')) return 'funeral8';         // 舊資料沒分親等，歸日數最高的一級（8 日）以免少給
  if (has('婚')) return 'marriage';
  if (has('公假')) return 'official';
  if (has('生理')) return 'menstrual';   // 要排在『病』之前
  if (has('事')) return 'personal';
  if (has('災')) return 'disaster';
  if (has('病')) return 'sick';
  if (has('特')) return 'annual';
  return null;
}

/** 假別的可請期間（期限規則，2026-08-23）。
 *  以「事件日」為基準：婚假＝結婚登記日、產假／陪產假＝分娩日、流產假＝流產日。
 *    window_before：事件日「前」幾天就可以開始請（婚假 10、陪產假 15）
 *    window_days  ：自起算日起算，幾天內要請畢（婚假 90＝3 個月、陪產假 15）
 *    window_max   ：經雇主同意可延長到幾天（婚假 365＝1 年）
 *  回 { has:是否有期限規則, from, to, to_max } —— 沒設定 window_days 就是「無期限」。 */
function payLeaveWindow(type, eventDate) {
  const t = type || {};
  if (t.window_days == null) return { has: false };
  const ev = payDateStr(eventDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev)) return { has: true, need_event: true };
  function shift(d, n) {
    const x = new Date(d + 'T00:00:00');
    x.setDate(x.getDate() + n);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }
  const from = shift(ev, -(payNum(t.window_before) || 0));
  return {
    has: true, event: ev, from: from,
    to: shift(from, payNum(t.window_days)),
    to_max: (t.window_max == null) ? null : shift(from, payNum(t.window_max)),
  };
}

/** 某天請某種假有沒有超過期限。回 { ok, state, msg }
 *  state：'ok'／'need_event'（還沒登記事件日）／'extend'（超過期限但在可延長範圍）／'over'（超過）／'early'（太早） */
function payLeaveWindowCheck(type, eventDate, leaveDate) {
  const w = payLeaveWindow(type, eventDate);
  if (!w.has) return { ok: true, state: 'ok' };
  if (w.need_event) return { ok: true, state: 'need_event',
    msg: (type.name || '') + ' 有期限規定，但尚未登記事件日（結婚登記日／分娩日等），系統無法檢查期限' };
  const d = payDateStr(leaveDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: true, state: 'ok' };
  if (d < w.from) return { ok: false, state: 'early',
    msg: type.name + ' 最早只能從 ' + w.from + ' 開始請（事件日 ' + w.event + '）' };
  if (d <= w.to) return { ok: true, state: 'ok' };
  if (w.to_max && d <= w.to_max) return { ok: true, state: 'extend',
    msg: type.name + ' 已超過 ' + w.to + ' 的期限，需雇主同意才可延至 ' + w.to_max };
  return { ok: false, state: 'over',
    msg: type.name + ' 請畢期限是 ' + w.to + (w.to_max ? '（經同意最多延至 ' + w.to_max + '）' : '') + '，已超過' };
}

/** 讀某店的假別事件日 → { emp_id: { code: 'yyyy-MM-dd' } }（同人同假別取最新一筆） */
function payLeaveEventMap(store) {
  const st = payStore(store);
  let rows = [];
  try { rows = payRead('leave_event'); } catch (err) { rows = []; }
  const out = {};
  rows.forEach(function (r) {
    if (payStore(r.store) !== st) return;
    const emp = String(r.emp_id || '').trim(), code = String(r.code || '').trim();
    const d = payDateStr(r.event_date);
    if (!emp || !code || !d) return;
    if (!out[emp]) out[emp] = {};
    if (!out[emp][code] || String(r.updated_at || '') >= String(out[emp][code].__u || '')) {
      out[emp][code] = d; out[emp][code + '__u'] = String(r.updated_at || '');
    }
  });
  return out;
}

/** 一天等於幾小時（額度是「日」、系統記「時」，換算基準）。*/
function payLeaveDayHours(cfg) {
  const h = payNum((cfg || {}).daily_hours);
  return h > 0 ? h : 8;
}

/** 算某員工各假別的已用額度與剩餘。
 *  ⚠ 跨店累計：與特休同一個原則（payEmpStores 掃歷任門市），調店不會讓額度歸零。
 *  回 { code: {used_days, cap_days, remain_days, basis, blocked, over_days} }
 *  basis 為 'event'（婚喪產這類一年可能發生多次的）→ blocked 永遠 false，只回數字供顯示，
 *  因為系統無法判斷「這是第幾次事件」，硬擋會擋錯真正該准的假。 */
function payLeaveUsage(empId, ym, types, cfg, storesMap, leavesByStore, spans) {
  const dayH = payLeaveDayHours(cfg);
  const year = String(ym || '').slice(0, 4);
  const used = {};        // code -> 已用「日」
  const perMonth = {};    // code -> { 'yyyy-MM': 日 }

  (leavesByStore || []).forEach(function (l) {
    if (String(l.emp_id) !== String(empId)) return;
    const d = String(l.date || '');
    const code = l.code;
    if (!code) return;
    const days = payNum(l.hours) / dayH;
    if (d.slice(0, 4) === year) used[code] = (used[code] || 0) + days;
    const m = d.slice(0, 7);
    if (!perMonth[code]) perMonth[code] = {};
    perMonth[code][m] = (perMonth[code][m] || 0) + days;
  });

  // 併入：家庭照顧假吃事假額度、生理假超過 3 日吃病假額度
  const merged = {};
  types.forEach(function (t) {
    if (!t.merge_into) return;
    const u = used[t.code] || 0;
    const cap = t.cap_days;
    const over = (cap == null) ? 0 : Math.max(0, u - cap);
    // 家庭照顧假是「全額併入事假」，生理假是「超過上限才併入病假」
    const add = (t.code === 'family') ? u : over;
    if (add > 0) merged[t.merge_into] = (merged[t.merge_into] || 0) + add;
  });

  const out = {};
  types.forEach(function (t) {
    const u = payR2((used[t.code] || 0) + (merged[t.code] || 0));
    let cap = t.cap_days;
    if (t.cap_basis === 'tenure') cap = null;   // 特休額度另由 payAnnualQuota 算，不在這裡擋
    const basis = t.cap_basis || '';
    const remain = (cap == null) ? null : payR2(cap - u);
    out[t.code] = {
      used_days: u,
      cap_days: cap,
      remain_days: remain,
      basis: basis,
      over_days: (cap == null) ? 0 : payR2(Math.max(0, u - cap)),
      // 只有「曆年」與「每子女」制才硬擋；事件別（婚喪產檢）一年可能發生多次，擋了會擋錯
      blocked: (cap != null && (basis === 'calendar' || basis === 'child') && u >= cap),
      per_month: perMonth[t.code] || {},
      month_cap: t.cap_per_month,
    };
  });

  // 育嬰留停三條線
  const p = payParentalUsage(empId, spans, leavesByStore, dayH);
  if (out[PAY_PARENTAL.code]) {
    out[PAY_PARENTAL.code].parental = p;
    out[PAY_PARENTAL.code].blocked = p.blocked;
  }
  return out;
}

/** 育嬰留停額度：每一子女分開算。
 *  ①總額 24 個月（以日申請的天數換算成月一併計入）
 *  ②以日申請合計 30 日
 *  ③以月申請未滿 6 個月者以 2 次為限（6 個月以上不限次數）*/
function payParentalUsage(empId, spans, leavesByStore, dayH) {
  const byChild = {};
  function slot(c) {
    const k = String(c || '').trim() || '(未指定)';
    if (!byChild[k]) byChild[k] = { child: k, month_used: 0, day_used: 0, short_count: 0, spans: [] };
    return byChild[k];
  }
  (spans || []).forEach(function (s) {
    if (String(s.emp_id) !== String(empId)) return;
    if (String(s.code || '').trim() !== PAY_PARENTAL.code) return;
    const sl = slot(s.child);
    const unit = String(s.unit || 'month').trim();
    if (unit === 'day') {
      sl.day_used += payNum(s.days) || payLeaveSpanDays(s);
    } else {
      const mo = payNum(s.months) || payR2(payLeaveSpanDays(s) / 30);
      sl.month_used += mo;
      if (mo > 0 && mo < PAY_PARENTAL.short_month_len) sl.short_count += 1;
    }
    sl.spans.push(s);
  });
  // leave 分頁裡逐日填的育嬰假也算進「以日申請」
  (leavesByStore || []).forEach(function (l) {
    if (String(l.emp_id) !== String(empId)) return;
    if (l.code !== PAY_PARENTAL.code) return;
    slot(l.child).day_used += payNum(l.hours) / dayH;
  });

  const children = Object.keys(byChild).map(function (k) {
    const c = byChild[k];
    const totalMonths = payR2(c.month_used + c.day_used / 30);
    return {
      child: c.child,
      month_used: payR2(c.month_used),
      day_used: payR2(c.day_used),
      short_count: c.short_count,
      total_months: totalMonths,
      total_remain_months: payR2(PAY_PARENTAL.total_months - totalMonths),
      day_remain: payR2(PAY_PARENTAL.day_unit_cap - c.day_used),
      short_remain: PAY_PARENTAL.short_month_cap - c.short_count,
      over_total: totalMonths >= PAY_PARENTAL.total_months,
      over_day: c.day_used >= PAY_PARENTAL.day_unit_cap,
      over_short: c.short_count >= PAY_PARENTAL.short_month_cap,
    };
  });
  // 任何一個子女的額度還沒用完 → 不擋（因為新的一胎會有新額度）
  const blocked = children.length > 0 && children.every(function (c) { return c.over_total; });
  return { children: children, blocked: blocked, rule: PAY_PARENTAL };
}

/** 區間天數（含頭尾），start/end 任一為空回 0。*/
function payLeaveSpanDays(s) {
  const a = payDateStr(s.start), b = payDateStr(s.end);
  if (!a || !b) return 0;
  const d1 = new Date(a + 'T00:00:00'), d2 = new Date(b + 'T00:00:00');
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  return Math.max(0, Math.round((d2 - d1) / 86400000) + 1);
}

/* ═══════════════════ Handlers ═══════════════════ */

function handlePayrollSetup(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return ensurePayrollSheets();
}

/* 帶入排班主檔＋(可選)當月紅字天數。
   ⚠ 排班資料由「前端(payroll.html)在瀏覽器讀 token-free Gist」後 POST 進來（body.employees／body.red_days），
   後端不做 UrlFetch——這樣後端就不需要 external_request 連外權限（免額外授權、攻擊面更小）。
   一鍵帶入：覆蓋排班有的欄位，缺口欄位保留既有(見 payMergeScheduleMaster)，帶入後仍可在薪資頁手動微調。*/

function handlePayrollBootstrap(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ensurePayrollSheets();
  const stBs = payStore(body.store);
  if (!payHasClock(stBs)) return { ok: false, error: 'no_clock',
    message: '門市 ' + stBs + ' 尚未連結打卡系統，沒有名冊可帶入。請在「員工設定」手動新增同仁，或先到 參數設定 → 門市設定 填入打卡試算表 ID。' };
  const roster = payClockRead(stBs, 'roster');
  const prefix = (function () { const r = payStoreRow(stBs); return r ? String(r.emp_prefix || '') : ''; })();
  const existing = {};
  payRead('master').forEach(function (m) { if (payStore(m.store) === stBs) existing[String(m.emp_id)] = true; });
  const add = roster
    .filter(function (r) { return String(r.active).toLowerCase() === 'true' && !existing[prefix + String(r.emp_id)]; })
    .map(function (r) {
      return { emp_id: prefix + r.emp_id, name: r.name, is_full_time: 'false', wage: 0, base: 0, ot_rate: 0,
               skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 0,
               labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
               hire_date: '', leave_date: '', active: 'true', updated_at: nowTaipeiIso(), store: stBs };
    });
  payAppend('master', add);
  return { ok: true, added: add.length, names: add.map(function (a) { return a.name; }) };
}

function handlePayrollMasterGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const stG = payStore(body.store);
  return { ok: true, store: stG,
           master: payRead('master').filter(function (m) { return payStore(m.store) === stG; }),
           config: payConfig(stG), config_src: payConfigSource(stG),
           stores: payRead('store').filter(function (x) { return String(x.active).toLowerCase() !== 'false'; }),
           holidays: payHolidayList(stG) };
}

function handlePayrollMasterSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.master)) return { ok: false, error: 'master_required' };
  const now = nowTaipeiIso();
  const stMs = payStore(body.store);
  const mine = body.master.map(function (m) { m.updated_at = now; m.store = payStore(m.store || stMs); return m; });
  const others = payRead('master').filter(function (m) { return payStore(m.store) !== stMs; });
  payReplaceAll('master', others.concat(mine));
  return { ok: true, count: mine.length, store: stMs };
}

function handlePayrollConfigSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const stC = String(body.store || '');   // 空白＝寫集團預設；有值＝寫該門市覆寫
  const rows = Object.keys(body.config || {}).map(function (k) {
    return { key: k, value: String(body.config[k]), note: '', store: stC };
  });
  if (!rows.length) return { ok: false, error: 'config_required' };
  const otherCfg = payRead('config').filter(function (r) { return String(r.store || '') !== stC; });
  payReplaceAll('config', otherCfg.concat(rows));
  return { ok: true };
}

function handlePayrollHolidaySet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.holidays)) return { ok: false, error: 'holidays_required' };
  const stH = String(body.store || '');   // 空白＝集團共用；有值＝該門市專屬
  const mine = body.holidays.map(function (h) { h.store = stH; return h; });
  const others = payRead('holiday').filter(function (h) { return String(h.store || '') !== stH; });
  payReplaceAll('holiday', others.concat(mine));
  return { ok: true, count: mine.length, store: stH };
}

/** 只歸集不計算——讓管理者先看工時對不對，再按計算 */
/** 讀 payroll_input 分頁的手動工時覆蓋（某月）→ {emp_id:{hours,extra_ot,...,support:[]}} */
function paySavedInputs(ym, store) {
  const st = payStore(store);
  const out = {};
  payRead('input').forEach(function (r) {
    if (String(r.ym) !== ym) return;
    if (payStore(r.store) !== st) return;
    var sup = [];
    try { sup = r.support ? JSON.parse(r.support) : []; } catch (e) { sup = []; }
    out[String(r.emp_id)] = {
      hours: payNum(r.hours), extra_ot: payNum(r.extra_ot),
      personal_h: payNum(r.personal_h), sick_h: payNum(r.sick_h), menstrual_h: payNum(r.menstrual_h), disaster_h: payNum(r.disaster_h), annual_h: payNum(r.annual_h),
      deduct_days: payNum(r.deduct_days), support: sup, full_attend: payBool(r.full_attend),
      work_days: payNum(r.work_days), wage_override: payNum(r.wage_override), meal_on: payBool(r.meal_on),
      holiday_h: (r.holiday_h === '' || r.holiday_h == null) ? '' : payNum(r.holiday_h),
      custom_add_label: String(r.custom_add_label||''), custom_add_amt: payNum(r.custom_add_amt),
      custom_ded_label: String(r.custom_ded_label||''), custom_ded_amt: payNum(r.custom_ded_amt),
      dorm_override: (r.dorm_override === '' || r.dorm_override == null) ? '' : payNum(r.dorm_override),
    };
  });
  return out;
}

/** 工時基底＝打卡歸集(payCollect) 疊上手動覆蓋(payroll_input)；saved 有該員就整筆蓋掉歸集值。
 *  供「工時分頁顯示」與「計算」共用，確保兩邊一致。 */
function payInputsBase(ym, store) {
  const st = payStore(store);
  const holRow = payHolidayRow(ym, st);
  const holDates = payHolidayDates(holRow);
  const base = payCollect(ym, payConfig(st).meal_min_hours, st, holDates);
  const saved = paySavedInputs(ym, st);
  Object.keys(saved).forEach(function (emp) {
    const col = base[emp] || {}, sv = saved[emp];
    // 國定假日時數：手動工時沒填就沿用打卡歸集出來的值
    //（這個欄位是後加的，先前存過的月份都是空白，不 fallback 會全部變 0）
    if (sv.holiday_h === '' || sv.holiday_h == null) sv.holiday_h = payNum(col.holiday_h);
    base[emp] = sv;
  });
  return base;
}

function handlePayrollInputs(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const st = payStore(body.store);
  return { ok: true, ym: ym, store: st, inputs: payInputsBase(ym, st),
           master: payRead('master').filter(function (m) { return payStore(m.store) === st; }) };
}

/** 儲存/覆蓋某月手動工時；inputs 空＝清除該月手動覆蓋（還原成打卡歸集）。 */
function handlePayrollInputSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const inputs = body.inputs || {};
  const now = nowTaipeiIso();
  const rows = Object.keys(inputs).map(function (emp) {
    const a = inputs[emp] || {};
    return {
      ym: ym, emp_id: emp,
      hours: payNum(a.hours), extra_ot: payNum(a.extra_ot),
      personal_h: payNum(a.personal_h), sick_h: payNum(a.sick_h), menstrual_h: payNum(a.menstrual_h), disaster_h: payNum(a.disaster_h), annual_h: payNum(a.annual_h),
      deduct_days: payNum(a.deduct_days), support: JSON.stringify(a.support || []), updated_at: now,
      full_attend: payBool(a.full_attend) ? 1 : 0,
      work_days: payNum(a.work_days), wage_override: payNum(a.wage_override), meal_on: payBool(a.meal_on) ? 1 : 0, holiday_h: payNum(a.holiday_h),
      custom_add_label: String(a.custom_add_label||''), custom_add_amt: payNum(a.custom_add_amt),
      custom_ded_label: String(a.custom_ded_label||''), custom_ded_amt: payNum(a.custom_ded_amt),
      dorm_override: (a.dorm_override === '' || a.dorm_override == null) ? '' : payNum(a.dorm_override),
    };
  });
  const others = payRead('input').filter(function (r) { return String(r.ym) !== ym; });
  payReplaceAll('input', others.concat(rows));
  return { ok: true, ym: ym, count: rows.length };
}

function handlePayrollCalc(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };

  const runs = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === payStore(body.store); });
  if (runs.length && String(runs[0].status) === 'final' && !body.force) {
    return { ok: false, error: 'locked', message: ym + ' 已鎖定，請先解鎖再重算' };
  }

  const holiday = payHolidayRow(ym, payStore(body.store));
  if (!holiday) return { ok: false, error: 'no_holiday', message: ym + ' 尚未設定紅字天數' };
  const redDays = payNum(holiday.red_days);

  const st = payStore(body.store);
  const cfg = payConfig(st);
  const master = payRead('master').filter(function (m) {
    return String(m.active).toLowerCase() === 'true' && payStore(m.store) === st;
  });
  const collected = payInputsBase(ym, st);   // 打卡歸集＋已儲存的手動覆蓋
  // 當月該店獎金，依員工分組
  const bonusBy = {};
  payRead('bonus').forEach(function (b) {
    if (String(b.ym) !== ym || payStore(b.store) !== st) return;
    const k = String(b.emp_id);
    (bonusBy[k] = bonusBy[k] || []).push({ bonus_type: b.bonus_type, label: b.label, amount: payNum(b.amount) });
  });
  const override = body.inputs || {};   // 本次前端送來的即時編輯（未存的也要算）

  // 假別表與「本月之前已用額度」都在迴圈外算好——逐人迴圈裡不准出現 payRead（效能鐵則）
  const LTYPES_FOR_CALC = payLeaveTypes(st);
  const USAGE_BEFORE = payLeaveUsedBefore(ym, st, LTYPES_FOR_CALC, cfg, master);
  const ANNUAL_INFO = payAnnualInfo(ym, st);   // 特休額度／已用／週年期，折算工資要用（迴圈外算一次）

  const results = master.map(function (e) {
    const c = collected[String(e.emp_id)] || {};
    const o = override[String(e.emp_id)] || {};
    const att = {
      hours:      o.hours      !== undefined ? payNum(o.hours)      : payNum(c.hours),
      extra_ot:   o.extra_ot   !== undefined ? payNum(o.extra_ot)   : payNum(c.extra_ot),
      personal_h: o.personal_h !== undefined ? payNum(o.personal_h) : payNum(c.personal_h),
      sick_h:     o.sick_h     !== undefined ? payNum(o.sick_h)     : payNum(c.sick_h),
      menstrual_h:o.menstrual_h!== undefined ? payNum(o.menstrual_h): payNum(c.menstrual_h),
      disaster_h: o.disaster_h !== undefined ? payNum(o.disaster_h) : payNum(c.disaster_h),
      annual_h:   o.annual_h   !== undefined ? payNum(o.annual_h)   : payNum(c.annual_h),
      deduct_days:o.deduct_days!== undefined ? payNum(o.deduct_days): payNum(c.deduct_days),
      support:    o.support    !== undefined ? o.support            : (c.support || []),
      full_attend:o.full_attend!== undefined ? payBool(o.full_attend): payBool(c.full_attend),
      work_days:  o.work_days  !== undefined ? payNum(o.work_days)  : payNum(c.work_days),
      wage_override: o.wage_override !== undefined ? payNum(o.wage_override) : payNum(c.wage_override),
      dorm_override: o.dorm_override !== undefined ? o.dorm_override : (c.dorm_override != null ? c.dorm_override : ''),
      meal_on:    o.meal_on    !== undefined ? payBool(o.meal_on)   : payBool(c.meal_on),
      holiday_h:  o.holiday_h  !== undefined ? payNum(o.holiday_h)  : payNum(c.holiday_h),
      custom_add_label: o.custom_add_label !== undefined ? o.custom_add_label : (c.custom_add_label||''),
      custom_add_amt:   o.custom_add_amt   !== undefined ? payNum(o.custom_add_amt) : payNum(c.custom_add_amt),
      custom_ded_label: o.custom_ded_label !== undefined ? o.custom_ded_label : (c.custom_ded_label||''),
      custom_ded_amt:   o.custom_ded_amt   !== undefined ? payNum(o.custom_ded_amt) : payNum(c.custom_ded_amt),
      bonuses: bonusBy[String(e.emp_id)] || [],
      // 五個舊欄位以外的假別（家庭照顧／婚／喪／公傷／產／育嬰…）走這裡
      leaves: (o.leaves !== undefined ? o.leaves : (c.leaves || {})),
      // 年度上限用：本月之前已用幾日（病假 30 日、事假 14 日…）
      leave_usage: USAGE_BEFORE[String(e.emp_id)] || {},
      // 特休週年期與剩餘時數；週年期屆滿當月要折算工資（計時同仁為 null）
      annual: ANNUAL_INFO[String(e.emp_id)] || null,
      // 全勤門檻用（手動輸入工時的月份沒有這些資料→0／false→不會觸發歸零）
      forget_punch: o.forget_punch !== undefined ? payNum(o.forget_punch) : payNum(c.forget_punch),
      forget_day:   o.forget_day   !== undefined ? payNum(o.forget_day)   : payNum(c.forget_day),
      late_min:     o.late_min     !== undefined ? payNum(o.late_min)     : payNum(c.late_min),
      early_min:    o.early_min    !== undefined ? payNum(o.early_min)    : payNum(c.early_min),
      attend_void:  o.attend_void  !== undefined ? payBool(o.attend_void) : !!c.attend_void,
    };
    return payCalcOne(e, ym, att, cfg, redDays, LTYPES_FOR_CALC);
  });

  // 保留 manual 明細，只重建 auto
  const keptManual = payRead('item').filter(function (i) {
    return String(i.ym) === ym && payStore(i.store) === st && String(i.source) === 'manual';
  });
  const manualByEmp = {};
  keptManual.forEach(function (i) { (manualByEmp[String(i.emp_id)] = manualByEmp[String(i.emp_id)] || []).push(i); });

  const now = nowTaipeiIso();
  const itemRows = [], runRows = [];
  results.forEach(function (r) {
    const mine = manualByEmp[String(r.emp_id)] || [];
    mine.forEach(function (i) {
      const amt = payNum(i.amount);
      if (String(i.item_type) === 'earning') r.gross += amt; else r.deduction += amt;
    });
    r.net = r.gross - r.deduction;

    r.earn.forEach(function (x) { itemRows.push(payItemRow(ym, r.emp_id, 'earning', x, 'auto', st)); });
    r.ded.forEach(function (x) { itemRows.push(payItemRow(ym, r.emp_id, 'deduction', x, 'auto', st)); });
    mine.forEach(function (i) { itemRows.push(i); });

    runRows.push({
      ym: ym, emp_id: r.emp_id, name: r.name, is_full_time: r.is_full_time, ratio: r.ratio,
      total_hours: r.total_hours, support_hours: r.support_hours, base_hours: r.base_hours, surplus_hours: r.surplus_hours,
      ot_paid_hours: r.ot_paid_hours, gross: r.gross, deduction: r.deduction, net: r.net,
      status: 'draft', run_at: now, store: st,
    });
  });

  const otherRuns  = payRead('run').filter(function (r) { return String(r.ym) !== ym || payStore(r.store) !== st; });
  const otherItems = payRead('item').filter(function (i) { return String(i.ym) !== ym || payStore(i.store) !== st; });
  payReplaceAll('run', otherRuns.concat(runRows));
  payReplaceAll('item', otherItems.concat(itemRows));

  return { ok: true, ym: ym, store: st, results: results, config: cfg, red_days: redDays, collected: collected };
}

function payItemRow(ym, empId, type, x, source, store) {
  return { ym: ym, emp_id: empId, item_type: type, item_key: x.item_key, item_label: x.item_label,
           qty: x.qty == null ? '' : x.qty, rate: x.rate == null ? '' : x.rate,
           amount: x.amount, source: source, memo: '', store: payStore(store) };
}

function handlePayrollGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  return {
    ok: true, ym: ym,
    run:  payRead('run').filter(function (r) { return String(r.ym) === ym; }),
    item: payRead('item').filter(function (i) { return String(i.ym) === ym; }),
    config: payConfig(),
  };
}

/** 從 run 列＋item 列重建 {results, status}（每人用 payRunItemsToResult 還原 earn/ded）；無資料回 null。 */
function payBuildRunResults(ym, store) {
  const stB = payStore(store);
  const runRows = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === stB; });
  if (!runRows.length) return null;
  const items = payRead('item').filter(function (i) { return String(i.ym) === ym && payStore(i.store) === stB; });
  const byEmp = {};
  items.forEach(function (i) { (byEmp[String(i.emp_id)] = byEmp[String(i.emp_id)] || []).push(i); });
  const results = runRows.map(function (run) { return payRunItemsToResult(run, byEmp[String(run.emp_id)] || []); });
  return { results: results, status: String(runRows[0].status || 'draft') };
}

/** 切月份一次到位：一個請求回 工時(inputs)＋月結(run)；沒算過且該月有紅字天數就自動算一次。
 *  取代前端「payroll_inputs→payroll_get→payroll_calc」三次往返，切月份大幅變快。 */
function handlePayrollMonth(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const stM = payStore(body.store);
  const inputs = payInputsBase(ym, stM);
  let run = payBuildRunResults(ym, stM);
  if (!run) {
    const hol = payHolidayRow(ym, stM);
    if (hol) {
      const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: stM, inputs: body.inputs || {} });
      if (calc && calc.ok) run = { results: calc.results, status: 'draft' };
    }
  }
  return { ok: true, ym: ym, store: stM, has_clock: payHasClock(stM), inputs: inputs, run: run, annual: payAnnualInfo(ym, stM),
           master: payRead('master').filter(function (m) { return payStore(m.store) === stM; }),
           config: payConfig(stM), config_src: payConfigSource(stM),
           bonuses: payRead('bonus').filter(function (b) { return String(b.ym) === ym && payStore(b.store) === stM; }),
           stores: payRead('store').filter(function (x) { return String(x.active).toLowerCase() !== 'false'; }),
           holidays: payHolidayList(stM) };
}

function handlePayrollItemUpsert(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const it = body.item;
  if (!it || !it.ym || !it.emp_id) return { ok: false, error: 'item_required' };
  const rows = payRead('item').filter(function (i) {
    return !(String(i.ym) === String(it.ym) && String(i.emp_id) === String(it.emp_id) &&
             String(i.item_key) === String(it.item_key) && String(i.source) === 'manual');
  });
  if (!body.remove) { it.source = 'manual'; rows.push(it); }
  payReplaceAll('item', rows);
  return { ok: true };
}

function handlePayrollFinalize(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || ''), lock = !!body.lock;
  if (!lock && !body.reason) return { ok: false, error: 'reason_required', message: '解鎖必須填原因' };
  const rows = payRead('run');
  let n = 0;
  const stF = payStore(body.store);
  rows.forEach(function (r) { if (String(r.ym) === ym && payStore(r.store) === stF) { r.status = lock ? 'final' : 'draft'; n++; } });
  if (!n) return { ok: false, error: 'no_run', message: ym + ' 還沒有月結資料' };
  payReplaceAll('run', rows);
  payAppend('audit', [{ ts: nowTaipeiIso(), ym: ym, action: lock ? 'lock' : 'unlock',
                        operator: String(body.operator || 'admin'), reason: String(body.reason || ''), store: stF }]);
  return { ok: true, ym: ym, status: lock ? 'final' : 'draft', count: n };
}

/**
 * 員工自助查詢：以打卡專屬連結的 key 反查 emp_id。
 * 絕不接受前端傳入的 emp_id——否則改網址就能看別人的薪水。
 */
/** 每人剩餘特休（工時分頁與員工薪資單共用）：額度=payAnnualQuota、已用=當前週年期內 leave 分頁特休時數合計 */
function payAnnualInfo(ym, store) {
  const stA = payStore(store);
  const master = payRead('master').filter(function (m) { return payStore(m.store) === stA; });
  /** 依門市讀 leave（跨店調動要把歷任門市的特休都算進已用）；同一次請求快取 */
  const empStores = payEmpStoresMap();   // 一次算完，避免逐人重掃
  const leaveCache = {};
  function leavesOf(st) {
    if (leaveCache[st]) return leaveCache[st];
    var rows = [];
    try { rows = payClockRead(st, 'leave'); }
    catch (e) { rows = []; }   // 某店試算表暫時開不起來不該讓整頁掛掉
    leaveCache[st] = rows;
    return rows;
  }
  const out = {};
  const savedRows = payRead('input');   // 手動工時（打卡上線前的月份特休 key 在這裡，不在 leave 分頁）
  master.forEach(function (e) {
    // 計時同仁沒有特休（Eason 2026-08 定案）——不算也不顯示
    const ft = String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true;
    if (!ft) { out[String(e.emp_id)] = null; return; }
    const q = payAnnualQuota(e.hire_date, ym);
    if (!q) { out[String(e.emp_id)] = null; return; }
    let used = 0;
    // ① 手動工時的特休（annual_h）：該月落在週年期內就累計；同月以手動為準（覆蓋語意，與計薪一致）
    const inputMonths = {};
    savedRows.forEach(function (r) {
      if (String(r.emp_id) !== String(e.emp_id)) return;
      const m = String(r.ym);
      if (!/^\d{4}-\d{2}$/.test(m)) return;
      if (!q.ps || (m + '-31') < q.ps || (m + '-01') >= q.pe) return;
      inputMonths[m] = true;
      used += payNum(r.annual_h);
    });
    // ② leave 分頁的特休：掃該員工「歷任門市」的請假紀錄；只算沒有手動工時覆蓋的月份，避免同月重複計
    (empStores[String(e.emp_id)] || [stA]).forEach(function (st2) {
      leavesOf(st2).forEach(function (l) {
        if (String(l['姓名'] || '').trim() !== String(e.name || '').trim()) return;
        if (String(l['假別'] || '').indexOf('特') === -1) return;
        const d = normCellDate(l['日期']);
        if (!(q.ps && d >= q.ps && d < q.pe)) return;
        if (inputMonths[d.slice(0, 7)]) return;
        used += Number(l['時數']) || 0;
      });
    });
    // payout_ym＝週年期「屆滿前一日」所在的月份：勞基法§38 特休因年度終結而未休完者應折算工資，
    // 例到職 10/01 → 週年期到 次年10/01 → 前一日 9/30 → 在 9 月的薪資折算發放。
    out[String(e.emp_id)] = { days: q.days, quota_h: q.days * 8, used_h: payR2(used),
                              left_h: payR2(q.days * 8 - used),
                              ps: q.ps, pe: q.pe, payout_ym: payDayBefore(q.pe).slice(0, 7) };
  });
  return out;
}

/** 打卡紀錄查詢（管理者）：某月每人每日的原始打卡事件＋主管核定結果。
 *  只讀不寫，資料直接來自打卡系統的 events／approved 分頁（與月表同源）。*/
function handlePayrollPunch(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const only = body.emp_id ? String(body.emp_id) : '';
  const stP = payStore(body.store);
  if (!payHasClock(stP)) return { ok: false, error: 'no_clock',
    message: '門市 ' + stP + ' 尚未連結打卡系統，沒有打卡紀錄可看。' };
  const roster = payClockRead(stP, 'roster');
  const nameById = {};
  roster.forEach(function (r) { nameById[String(r.emp_id)] = r.name; });
  const events = payClockRead(stP, 'events');
  const approvedMap = buildLatestApprovedMap(payClockRead(stP, 'approved'));

  const byKey = {};
  function slot(d, emp) {
    const k = d + '|' + emp;
    if (!byKey[k]) byKey[k] = { date: d, emp_id: String(emp), name: nameById[emp] || emp,
      punches: [], approved_hours: '', status_text: '', periods: '', manager_name: '' };
    return byKey[k];
  }
  events.forEach(function (e) {
    const ts = normCellTs(e.ts), d = tsDateStr(ts);
    if (d.slice(0, 7) !== ym) return;
    const emp = String(e.emp_id);
    if (only && only !== emp) return;
    slot(d, emp).punches.push({ time: tsHm(ts), type: String(e.type || ''), status: String(e.status || ''),
      within: String(e.within_range || ''), dist: e.distance_m === '' || e.distance_m == null ? '' : Number(e.distance_m) });
  });
  Object.keys(approvedMap).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      if (only && only !== String(emp)) return;
      const rec = approvedMap[d][emp], t = slot(d, emp);
      t.approved_hours = rec.approved_hours === '' || rec.approved_hours == null ? '' : Number(rec.approved_hours);
      t.status_text = String(rec.status_text || '');
      t.periods = String(rec.periods || '');
      t.manager_name = String(rec.manager_name || '');
    });
  });
  const rows = Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
  rows.forEach(function (r) { r.punches.sort(function (a, b) { return a.time < b.time ? -1 : 1; }); });

  /* 總表：全體同仁當月統計（不受單人篩選影響）
     出勤工時＝核定時數合計；異常筆數＝status!=='ok' 的打卡事件數；
     請假時數＝leave 分頁該月合計；忘刷＝pairShifts 未配對的日數；遲到／早退＝核定狀態字樣的日數 */
  const sum = {};
  function box(emp) {
    if (!sum[emp]) sum[emp] = { emp_id: String(emp), name: nameById[emp] || emp,
      hours: 0, abnormal: 0, leave_h: 0, miss: 0, late: 0, early: 0 };
    return sum[emp];
  }
  const roster_active = roster.filter(function (r) { return String(r.active).toLowerCase() === 'true'; });
  roster_active.forEach(function (r) { box(String(r.emp_id)); });
  Object.keys(approvedMap).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      const rec = approvedMap[d][emp], b = box(emp);
      b.hours += Number(rec.approved_hours) || 0;
      const st = String(rec.status_text || '');
      if (st.indexOf('遲到') !== -1) b.late++;
      if (st.indexOf('早退') !== -1) b.early++;
    });
  });
  events.forEach(function (e) {
    const d = tsDateStr(normCellTs(e.ts));
    if (d.slice(0, 7) !== ym) return;
    if (String(e.status) !== 'ok') box(String(e.emp_id)).abnormal++;
  });
  const paired = pairShifts(events);
  const today = todayTaipeiStr();
  const missDays = {};
  function markMiss(e, skipToday) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym) return;
    if (skipToday && d === today) return;   // 今天未配對＝上班中，不算忘刷（同 payCollect）
    missDays[String(e.emp_id) + '|' + d] = true;
  }
  paired.unmatchedIns.forEach(function (e) { markMiss(e, true); });
  paired.unmatchedOuts.forEach(function (e) { markMiss(e, false); });
  Object.keys(missDays).forEach(function (k) { box(k.split('|')[0]).miss++; });
  {
    const nameToEmp = {};
    roster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });
    payClockRead(stP, 'leave').forEach(function (l) {
      const emp = nameToEmp[String(l['姓名'] || '').trim()];
      if (!emp) return;
      if (normCellDate(l['日期']).slice(0, 7) !== ym) return;
      box(emp).leave_h += Number(l['時數']) || 0;
    });
  }
  const summary = Object.keys(sum).map(function (k) {
    const b = sum[k]; b.hours = payR2(b.hours); b.leave_h = payR2(b.leave_h); return b;
  }).sort(function (a, b) { return String(a.emp_id) < String(b.emp_id) ? -1 : 1; });

  return { ok: true, ym: ym, rows: rows, summary: summary,
    roster: roster.filter(function (r) { return String(r.active).toLowerCase() === 'true'; })
                  .map(function (r) { return { emp_id: String(r.emp_id), name: r.name }; }) };
}

/* ═══════════════════ 門市表 ═══════════════════ */

function handlePayrollStoreGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ensurePayrollSheets();
  return { ok: true, stores: payRead('store') };
}
function handlePayrollStoreSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.stores)) return { ok: false, error: 'stores_required' };
  payReplaceAll('store', body.stores);
  return { ok: true, count: body.stores.length };
}

/* ═══════════════════ 獎金登記 ═══════════════════ */

const PAY_BONUS_TYPES = ['sales', 'perf', 'project'];

function handlePayrollBonusGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || ''), st = payStore(body.store);
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  return { ok: true, ym: ym, store: st,
           bonuses: payRead('bonus').filter(function (b) { return String(b.ym) === ym && payStore(b.store) === st; }) };
}

/** 覆寫某店某月的全部獎金（前端整批送）。金額 0 或空的列自動略過。 */
function handlePayrollBonusSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || ''), st = payStore(body.store);
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  if (!Array.isArray(body.bonuses)) return { ok: false, error: 'bonuses_required' };
  const now = nowTaipeiIso();
  const rows = body.bonuses
    .filter(function (b) { return b && String(b.emp_id || '') !== '' && payNum(b.amount) !== 0; })
    .map(function (b) {
      const t = PAY_BONUS_TYPES.indexOf(String(b.bonus_type)) >= 0 ? String(b.bonus_type) : 'project';
      return { ym: ym, store: st, emp_id: String(b.emp_id), bonus_type: t,
               label: String(b.label || ''), amount: payNum(b.amount),
               memo: String(b.memo || ''), updated_at: now };
    });
  const others = payRead('bonus').filter(function (b) { return String(b.ym) !== ym || payStore(b.store) !== st; });
  payReplaceAll('bonus', others.concat(rows));
  return { ok: true, ym: ym, store: st, count: rows.length };
}

/* ═══════════════════ 儀表板：人事成本趨勢 ═══════════════════ */

/** 回近 N 個月的彙總（依門市）。資料全部取自既有 run／item，不需額外輸入。 */
/** 成本口徑「要扣回」的扣項（薪資費用小計＝應收−這些）：任何請假扣款（/_leave$/，新假別自動涵蓋）
 *  ＋不足時數倒扣。與 payroll.html 的 isCostReduceKey、payroll_mock 的 isReduce 同一口徑。
 *  ⚠ 2026-08-23 前這裡是兩份寫死的五個舊 key——新假別（住院傷病、安胎、家庭照顧…）的扣款
 *    沒被扣回，儀表板趨勢與集團總覽的薪資費用被高估。改口徑要三處一起：本函式／payroll.html／mock。 */
function payIsReduceKey(k) { return /_leave$/.test(String(k)) || String(k) === 'shortfall_hours'; }

function handlePayrollTrend(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  const months = Math.min(24, Math.max(1, payNum(body.months) || 12));
  const endYm = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? String(body.ym) : currentYmTaipei();
  // 產生月份清單（由舊到新）
  const list = [];
  var y = parseInt(endYm.slice(0, 4), 10), m = parseInt(endYm.slice(5, 7), 10);
  for (var i = months - 1; i >= 0; i--) {
    var yy = y, mm = m - i;
    while (mm <= 0) { mm += 12; yy--; }
    list.push(yy + '-' + pad2(mm));
  }
  const runs = payRead('run').filter(function (r) { return payStore(r.store) === st; });
  const items = payRead('item').filter(function (i) { return payStore(i.store) === st; });
  const runByYm = {}, itemByYm = {};
  runs.forEach(function (r) { (runByYm[String(r.ym)] = runByYm[String(r.ym)] || []).push(r); });
  items.forEach(function (i) { (itemByYm[String(i.ym)] = itemByYm[String(i.ym)] || []).push(i); });

  const out = list.map(function (ym) {
    const rs = runByYm[ym] || [], its = itemByYm[ym] || [];
    if (!rs.length) return { ym: ym, has: false };
    var gross = 0, hours = 0, ft = 0, pt = 0, ot = 0, reduce = 0, bonus = 0, supportH = 0;
    // 每人的加班費（拆「支援造成的加班」用）
    const otByEmp = {};
    its.forEach(function (i) {
      const k = String(i.item_key), a = payNum(i.amount);
      if (String(i.item_type) === 'earning') {
        if (k === 'overtime') { ot += a; otByEmp[String(i.emp_id)] = (otByEmp[String(i.emp_id)] || 0) + a; }
        if (k.indexOf('bonus_') === 0) bonus += a;
      } else if (payIsReduceKey(k)) reduce += a;
    });
    // 支援造成的加班費：支援時數把超時墊高的那一段，按時數比例攤回金額
    //   支援造成的加班時數 = max(超時,0) − max(超時−支援時數,0)
    var otSupport = 0;
    rs.forEach(function (r) {
      gross += payNum(r.gross); hours += payNum(r.total_hours);
      supportH += payNum(r.support_hours);
      if (String(r.is_full_time).toLowerCase() === 'true') ft++; else pt++;
      const otPaidH = payNum(r.ot_paid_hours);
      const amt = otByEmp[String(r.emp_id)] || 0;
      if (otPaidH > 0 && amt > 0) {
        const sp = payNum(r.surplus_hours), sup = payNum(r.support_hours);
        const hSup = Math.max(sp, 0) - Math.max(sp - sup, 0);   // 支援墊高的加班時數
        if (hSup > 0) otSupport += amt * Math.min(1, hSup / otPaidH);
      }
    });
    const otLocal = ot - otSupport;
    const cfg = payConfig(st);
    const co = payNum(cfg.co_labor) + payNum(cfg.co_health) + payNum(cfg.co_pension) +
               payNum(cfg.co_owner) + payNum(cfg.co_group);
    const salaryCost = gross - reduce;
    const people = ft + pt;
    return { ym: ym, has: true,
             salary_cost: payR0(salaryCost), company: payR0(co), total_cost: payR0(salaryCost + co),
             overtime: payR0(ot), overtime_support: payR0(otSupport), overtime_local: payR0(otLocal),
             support_hours: payR2(supportH), bonus: payR0(bonus),
             people: people, ft: ft, pt: pt, hours: payR2(hours),
             ot_ratio: salaryCost > 0 ? Math.round(ot / salaryCost * 1000) / 10 : 0,
             ot_ratio_local: salaryCost > 0 ? Math.round(otLocal / salaryCost * 1000) / 10 : 0,
             avg_hours: people ? payR2(hours / people) : 0,
             avg_net: people ? payR0(rs.reduce(function (a, r) { return a + payNum(r.net); }, 0) / people) : 0,
             status: String(rs[0].status || 'draft') };
  });
  return { ok: true, store: st, months: out };
}

/* ═══════════════════ 集團總覽 ═══════════════════ */

/** 某月各門市的人事成本並列＋合計。成本口徑與前端 costRows 一致：
 *  薪資費用＝應收−(請假扣款+不足倒扣)；公司負擔取該店參數；總成本＝兩者相加。 */
function handlePayrollGroup(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const runs = payRead('run').filter(function (r) { return String(r.ym) === ym; });
  const items = payRead('item').filter(function (i) { return String(i.ym) === ym; });
  const runBy = {}, itemBy = {};
  runs.forEach(function (r) { (runBy[payStore(r.store)] = runBy[payStore(r.store)] || []).push(r); });
  items.forEach(function (i) { (itemBy[payStore(i.store)] = itemBy[payStore(i.store)] || []).push(i); });

  const rows = payStoreList().map(function (st) {
    const code = String(st.code), rs = runBy[code] || [], its = itemBy[code] || [];
    const cfg = payConfig(code);
    const co = payNum(cfg.co_labor) + payNum(cfg.co_health) + payNum(cfg.co_pension) +
               payNum(cfg.co_owner) + payNum(cfg.co_group);
    if (!rs.length) return { store: code, name: String(st.name || code), has: false, company: payR0(co) };
    var gross = 0, net = 0, hours = 0, ft = 0, pt = 0, ot = 0, bonus = 0, reduce = 0;
    rs.forEach(function (r) {
      gross += payNum(r.gross); net += payNum(r.net); hours += payNum(r.total_hours);
      if (String(r.is_full_time).toLowerCase() === 'true') ft++; else pt++;
    });
    its.forEach(function (i) {
      const k = String(i.item_key), a = payNum(i.amount);
      if (String(i.item_type) === 'earning') {
        if (k === 'overtime') ot += a;
        if (k.indexOf('bonus_') === 0) bonus += a;
      } else if (payIsReduceKey(k)) reduce += a;
    });
    const salaryCost = gross - reduce;
    return { store: code, name: String(st.name || code), has: true,
             people: ft + pt, ft: ft, pt: pt, hours: payR2(hours),
             gross: payR0(gross), net: payR0(net), overtime: payR0(ot), bonus: payR0(bonus),
             salary_cost: payR0(salaryCost), company: payR0(co), total_cost: payR0(salaryCost + co),
             status: String(rs[0].status || 'draft') };
  });
  const sum = { people: 0, hours: 0, gross: 0, net: 0, overtime: 0, bonus: 0, salary_cost: 0, company: 0, total_cost: 0 };
  rows.forEach(function (r) {
    if (!r.has) { sum.company += payNum(r.company); sum.total_cost += payNum(r.company); return; }
    ['people','hours','gross','net','overtime','bonus','salary_cost','company','total_cost'].forEach(function (k) {
      sum[k] += payNum(r[k]);
    });
  });
  return { ok: true, ym: ym, rows: rows, sum: sum };
}

/* ═══════════════════ 一次性遷移：既有資料補門市 ═══════════════════ */

/** 把 store 為空的既有列補成預設門市（只跑一次；重複執行安全）。 */
function handlePayrollMigrateStore(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ensurePayrollSheets();
  const st = payStore(body.store);
  const done = {};
  ['master', 'input', 'run', 'item', 'audit'].forEach(function (kind) {
    const rows = payRead(kind);
    var n = 0;
    rows.forEach(function (r) { if (String(r.store || '') === '') { r.store = st; n++; } });
    if (n) payReplaceAll(kind, rows);
    done[kind] = n;
  });
  // 門市表若空，建立預設門市列
  if (!payRead('store').length) {
    payAppend('store', [{ code: st, name: '麻的小辛辣 新竹光復店', clock_ss_id: '',
                          dzy_node: 'sxl-gf', emp_prefix: '', active: 'true', sort: 1 }]);
    done.store_created = 1;
  }
  return { ok: true, store: st, filled: done };
}

function handleMyPayslip(body) {
  const key = String(body.key || '');
  if (!key) return { ok: false, error: 'unauthorized' };
  // 跨店驗身分：逐店讀該店打卡名冊比對金鑰，找到即停（各店打卡各自一份試算表）
  var me = null, meStore = '';
  const stList = payStoreList();
  for (var si = 0; si < stList.length; si++) {
    var code = String(stList[si].code);
    var rs = [];
    try { rs = payClockRead(code, 'roster'); }
    catch (e) { continue; }
    var hit = findRosterByKey(rs, key);
    if (hit) { me = hit; meStore = code; break; }
  }
  if (!me) return { ok: false, error: 'unauthorized' };

  const ym = String(body.ym || currentYmTaipei());
  // 員工所屬門市（主檔為準；找不到就用預設店）
  const mineMaster = payRead('master').filter(function (m) { return String(m.emp_id) === String(me.emp_id); })[0];
  const stMy = payStore((mineMaster && mineMaster.store) || meStore);
  const run = payRead('run').filter(function (r) {
    return String(r.ym) === ym && String(r.emp_id) === String(me.emp_id) && payStore(r.store) === stMy;
  })[0];
  const annual = payAnnualInfo(ym, stMy)[String(me.emp_id)] || null;
  if (!run) return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資尚未結算', annual: annual };
  if (String(run.status) !== 'final') {
    return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資結算中，尚未定案', annual: annual };
  }
  const items = payRead('item').filter(function (i) {
    return String(i.ym) === ym && String(i.emp_id) === String(me.emp_id) && payStore(i.store) === stMy;
  });
  return { ok: true, ym: ym, name: me.name, ready: true, annual: annual,
           result: payRunItemsToResult(run, items), payday: payConfig().payday };
}

/* ═══════════════════ 掛載點 ═══════════════════ */

/* ─────────── 假別參數表 handlers（2026-08-22）─────────── */

/** {action:'payroll_leave_type_get', admin_key, store?} → 該店生效的假別清單＋是否為內建預設。 */
function handlePayrollLeaveTypeGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  let raw = [];
  try { raw = payRead('leave_type'); } catch (err) { raw = []; }
  // ⚠ is_default 要看「這家店」有沒有自訂列——用 raw.length 會在任何一家店存過之後
  //   讓所有店都顯示「已自訂」（踩過）。空 store 的列是集團共用，也算自訂。
  const mine = raw.filter(function (r) {
    const rs = String(r.store || '').trim();
    return rs === '' || payStore(rs) === st;
  });
  return { ok: true, store: st, types: payLeaveTypes(st),
           is_default: mine.length === 0,
           store_specific: raw.some(function (r) { return String(r.store || '').trim() === st; }),
           rule_parental: PAY_PARENTAL };
}

/** {action:'payroll_leave_type_set', admin_key, store, types:[...]} → 只換該店範圍，保留他店。
 *  ⚠ 沿用主檔／參數的規則：絕不整張覆寫（會洗掉別店的設定，踩過）。 */
function handlePayrollLeaveTypeSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = String(body.store || '').trim();   // 空字串＝集團共用列，不要套 payStore
  const incoming = (body.types || []).map(function (t) {
    return {
      code: String(t.code || '').trim(), name: String(t.name || '').trim(),
      pay_ratio: payNum(t.pay_ratio), count_absent: !!t.count_absent,
      offset_shortfall: !!t.offset_shortfall,
      cap_days: (t.cap_days === '' || t.cap_days == null) ? '' : payNum(t.cap_days),
      cap_basis: String(t.cap_basis || '').trim(), over_ratio: payNum(t.over_ratio),
      merge_into: String(t.merge_into || '').trim(),
      cap_per_month: (t.cap_per_month === '' || t.cap_per_month == null) ? '' : payNum(t.cap_per_month),
      tenure_months: (t.tenure_months === '' || t.tenure_months == null) ? '' : payNum(t.tenure_months),
      under_ratio: payNum(t.under_ratio),
      // ⚠ 2026-08-23：這六欄是後來加的，一定要跟著存——漏了會在存檔時把期限規則、
      //   出差的餐費排除、對全勤的設定全部清成預設值（實際踩過，寫壞過央廚與總部）。
      min_unit: String(t.min_unit || 'hour').trim(),
      window_before: (t.window_before === '' || t.window_before == null) ? '' : payNum(t.window_before),
      window_days:   (t.window_days   === '' || t.window_days   == null) ? '' : payNum(t.window_days),
      window_max:    (t.window_max    === '' || t.window_max    == null) ? '' : payNum(t.window_max),
      attend_effect: String(t.attend_effect || '').trim(),
      count_meal_day: (t.count_meal_day === false ? 'false' : 'true'),
      active: (t.active === false ? 'false' : 'true'), sort: payNum(t.sort),
      note: String(t.note || ''), store: st,
    };
  }).filter(function (t) { return t.code && t.name; });
  // 出差改名鎖（2026-08-23 審查修正）：打卡端的出差判斷寫死「出差」二字
  // （三家店後端各有一份 TRIP_NOTE／LEAVE_TYPES）。這裡改名的話，核定送出的字串對不上
  // → 出差保護靜默失效（出差日被當忘刷卡扣全勤），不會報任何錯。要改名得三家店後端一起改，
  // 所以在寫入端擋下並講清楚，把「靜默壞掉」變成「改不動＋有說明」。
  const tripRenamed = incoming.filter(function (t) { return t.code === 'trip' && t.name !== '出差'; })[0];
  if (tripRenamed) {
    return { ok: false, error: 'trip_name_locked',
             message: '「出差」不能改名（打卡端核定狀態寫死此名稱）；要改名需同步修改三家店打卡後端，請聯絡 Eason。' };
  }
  let rows = [];
  try { rows = payRead('leave_type'); } catch (err) { rows = []; }
  const kept = rows.filter(function (r) { return String(r.store || '').trim() !== st; });
  payReplaceAll('leave_type', kept.concat(incoming));
  payAppend('audit', [{ ts: nowTaipeiIso(), ym: '', action: 'leave_type_set',
                        operator: String(body.operator || 'admin'),
                        reason: st + ' 假別設定共 ' + incoming.length + ' 列', store: st }]);
  return { ok: true, saved: incoming.length };
}

/** {action:'payroll_leave_span_get', admin_key, store?} → 留職停薪區間（含每人額度結算）。 */
function handlePayrollLeaveSpanGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  let spans = [];
  try { spans = payRead('leave_span'); } catch (err) { spans = []; }
  const mine = spans.filter(function (r) { return payStore(r.store) === st; });
  const master = payRead('master').filter(function (m) { return payStore(m.store) === st; });
  const quota = {};
  master.forEach(function (e) {
    quota[String(e.emp_id)] = payParentalUsage(String(e.emp_id), mine, [], 8);
  });
  return { ok: true, store: st, spans: mine, quota: quota, rule: PAY_PARENTAL };
}

/** {action:'payroll_leave_span_set', admin_key, store, spans:[...]} → 只換該店範圍。 */
function handlePayrollLeaveSpanSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  const now = nowTaipeiIso();
  const incoming = (body.spans || []).map(function (r) {
    return { emp_id: String(r.emp_id || '').trim(), name: String(r.name || '').trim(), store: st,
             code: String(r.code || 'parental').trim(), child: String(r.child || '').trim(),
             unit: (String(r.unit || 'month').trim() === 'day' ? 'day' : 'month'),
             start: payDateStr(r.start), end: payDateStr(r.end),
             months: payNum(r.months), days: payNum(r.days),
             memo: String(r.memo || ''), updated_at: now };
  }).filter(function (r) { return r.emp_id; });
  let rows = [];
  try { rows = payRead('leave_span'); } catch (err) { rows = []; }
  const kept = rows.filter(function (r) { return payStore(r.store) !== st; });
  payReplaceAll('leave_span', kept.concat(incoming));
  payAppend('audit', [{ ts: nowTaipeiIso(), ym: '', action: 'leave_span_set',
                        operator: String(body.operator || 'admin'),
                        reason: st + ' 留停區間共 ' + incoming.length + ' 列', store: st }]);
  return { ok: true, saved: incoming.length };
}

/** {action:'payroll_leave_options', store, mgr_key, ym?} → 給值班核定頁用：
 *  假別下拉清單 ＋ 每位同仁的剩餘額度（額度用完的回 blocked，前端把該選項反灰）。
 *
 *  ⚠ 身分驗證跨後端：薪酬是全集團共用一套，不認得央廚／總部的主管金鑰，
 *    所以反過來開該店自己的打卡試算表比對 managers 分頁——與 my_payslip 跨店驗身分同一招。 */
function handlePayrollLeaveOptions(body) {
  const st = payStore(body.store);
  const key = String(body.mgr_key || '').trim();
  if (!key) return { ok: false, error: 'unauthorized' };
  let mgrs = [];
  try { mgrs = payClockRead(st, 'managers'); } catch (err) { return { ok: false, error: 'no_clock_ss' }; }
  const hit = mgrs.filter(function (m) {
    return String(m.key) === key && String(m.active).toLowerCase() === 'true';
  })[0];
  if (!hit) return { ok: false, error: 'unauthorized' };

  const ym = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? body.ym : nowTaipeiIso().slice(0, 7);
  const types = payLeaveTypes(st);
  const cfg = payConfig(st);
  const master = payRead('master').filter(function (m) {
    return String(m.active).toLowerCase() === 'true' && payStore(m.store) === st;
  });
  let spans = [];
  try { spans = payRead('leave_span'); } catch (err) { spans = []; }

  // 額度要看「整個曆年」，含本月已請的——與計薪的 used_before 不同，這裡是給主管當下判斷用
  const dayH = payLeaveDayHours(cfg);
  let leaveRows = [];
  try { leaveRows = payClockRead(st, 'leave'); } catch (err) { leaveRows = []; }
  const nameToEmp = {};
  master.forEach(function (e) { nameToEmp[String(e.name).trim()] = String(e.emp_id); });
  const flat = [];
  leaveRows.forEach(function (l) {
    const emp = nameToEmp[String(l['姓名'] || '').trim()];
    if (!emp) return;
    flat.push({ emp_id: emp, date: normCellDate(l['日期']),
                hours: Number(l['時數']) || 0, code: payLeaveCode(String(l['假別'] || ''), types) });
  });
  const quotas = {};
  master.forEach(function (e) {
    quotas[String(e.emp_id)] = payLeaveUsage(String(e.emp_id), ym, types, cfg, null, flat, spans);
  });
  return { ok: true, store: st, ym: ym, types: types, quotas: quotas,
           day_hours: dayH, rule_parental: PAY_PARENTAL,
           // 期限規則要用：某人某假別的事件日（結婚登記日／分娩日…），前端據此擋過期的假
           events: payLeaveEventMap(st) };
}

/** {action:'payroll_leave_event_get', admin_key, store?} → 該店的假別事件日。 */
function handlePayrollLeaveEventGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  let rows = [];
  try { rows = payRead('leave_event'); } catch (err) { rows = []; }
  return { ok: true, store: st, events: rows.filter(function (r) { return payStore(r.store) === st; }) };
}

/** {action:'payroll_leave_event_set', admin_key, store, events:[...]} → 只換該店範圍，保留他店。 */
function handlePayrollLeaveEventSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store);
  const now = nowTaipeiIso();
  const incoming = (body.events || []).map(function (r) {
    return { emp_id: String(r.emp_id || '').trim(), name: String(r.name || '').trim(), store: st,
             code: String(r.code || '').trim(), event_date: payDateStr(r.event_date),
             memo: String(r.memo || ''), updated_at: now };
  }).filter(function (r) { return r.emp_id && r.code && r.event_date; });
  let rows = [];
  try { rows = payRead('leave_event'); } catch (err) { rows = []; }
  const kept = rows.filter(function (r) { return payStore(r.store) !== st; });
  payReplaceAll('leave_event', kept.concat(incoming));
  payAppend('audit', [{ ts: now, ym: '', action: 'leave_event_set',
                        operator: String(body.operator || 'admin'),
                        reason: st + ' 假別事件日共 ' + incoming.length + ' 筆', store: st }]);
  return { ok: true, saved: incoming.length };
}

const PAYROLL_HANDLERS = {
  payroll_setup:        handlePayrollSetup,
  payroll_bootstrap:    handlePayrollBootstrap,
  payroll_master_get:   handlePayrollMasterGet,
  payroll_master_set:   handlePayrollMasterSet,
  payroll_config_set:   handlePayrollConfigSet,
  payroll_holiday_set:  handlePayrollHolidaySet,
  payroll_inputs:       handlePayrollInputs,
  payroll_input_set:    handlePayrollInputSet,
  payroll_month:        handlePayrollMonth,
  payroll_calc:         handlePayrollCalc,
  payroll_get:          handlePayrollGet,
  payroll_item_upsert:  handlePayrollItemUpsert,
  payroll_finalize:     handlePayrollFinalize,
  my_payslip:           handleMyPayslip,
  payroll_punch:        handlePayrollPunch,
  payroll_store_get:    handlePayrollStoreGet,
  payroll_store_set:    handlePayrollStoreSet,
  payroll_bonus_get:    handlePayrollBonusGet,
  payroll_bonus_set:    handlePayrollBonusSet,
  payroll_trend:        handlePayrollTrend,
  payroll_group:        handlePayrollGroup,
  payroll_migrate_store: handlePayrollMigrateStore,
  payroll_leave_event_get: handlePayrollLeaveEventGet,
  payroll_leave_event_set: handlePayrollLeaveEventSet,
  payroll_leave_type_get:  handlePayrollLeaveTypeGet,
  payroll_leave_type_set:  handlePayrollLeaveTypeSet,
  payroll_leave_span_get:  handlePayrollLeaveSpanGet,
  payroll_leave_span_set:  handlePayrollLeaveSpanSet,
  payroll_leave_options:   handlePayrollLeaveOptions,
};
