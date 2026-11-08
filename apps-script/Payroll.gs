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
  // support_group（2026-11-05 追加）：跨店支援自動帶入的「同組」判斷（sxl／mzt／*）。空白＝自己一組（不帶入任何店）。
  store:   ['code','name','clock_ss_id','dzy_node','emp_prefix','active','sort','brand','support_group'],
  bonus:   ['ym','store','emp_id','bonus_type','label','amount','memo','updated_at'],
  run:     ['ym','emp_id','name','is_full_time','ratio','total_hours','base_hours','surplus_hours',
            'ot_paid_hours','gross','deduction','net','status','run_at','support_hours','store',
            // support_auto_h（2026-11-05 追加）：計算當下「打卡帶入」的支援時數合計。payroll_month 只拿它跟這次的帶入值比，
            // 判斷草稿是不是因為別家門市核定變了而過期（手填差異不算過期）。生效月之前／對照沒同步時不寫。
            'support_auto_h',
            // ot_info（2026-11-06 追加）：加班逐日判斷的提醒（本月加班時數、班表查不到的日子、排班沒核定的日子、例假出勤日）JSON。2026-11 之前不寫。
            'ot_info'],
  item:    ['ym','emp_id','item_type','item_key','item_label','qty','rate','amount','source','memo','store'],
  input:   ['ym','emp_id','hours','extra_ot','personal_h','sick_h','annual_h','deduct_days','support','updated_at','menstrual_h','disaster_h','full_attend','work_days','wage_override','dorm_override','meal_on','custom_add_label','custom_add_amt','custom_ded_label','custom_ded_amt','store','holiday_h','custom_add_more',
            // hours_manual（2026-11-05 追加）：'0'＝「僅 support」列（只存跨店支援，本店時數照打卡歸集，
            // 只有 payroll_support_decide 會建）；空白（改版前的舊列）／'1'＝整筆手動（行為不變）。
            'hours_manual'],
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
  // 損益系統快照（T14，mala-pnl-auto#15，2026-09-25 加）：「鎖定本月」時把前端算好的
  // costTotals() 依穩定鍵整理後存一份，pnlPayroll 端點只讀這張表，不重算。
  // 不含姓名／員工編號／逐人金額——support_json 只到「門市」層級。只在 handlePayrollFinalize
  // 的鎖定流程寫入（見 pnlSnapshotUpsert_／pnlSnapshotRemove_），唯讀端點本身零寫入
  // （見 pnlReadSnapshot_）。
  // 打卡對照快照（2026-11-05，跨店支援自動帶入）：管理系統「同仁名單 → 打卡對照」同步過來，整表覆寫（scope 下只換負責門市的列）。
  // 一列＝一位同仁（emp_no＝DZY 編號）在某家打卡店（acct_store）的一個打卡帳號（emp_id）。不存姓名等個資。
  // acct_only（2026-11-05 GPT 上線前審查 #3／#5）：負責門市不含發薪店的人同步進來的列，只給打卡店看提醒，不影響發薪。
  //   離職同仁的對照由管理系統保留到離職月份的下個月底（payXmapBuild_），薪資這邊不另記移除日（Fable 複審：標記法會依同步順序算錯）。
  xmap: ['emp_no','pay_store','acct_store','emp_id','not_support','synced_at','state','acct_only'],
  cost_snapshot: ['ym','store','base_ft','ot_ft','attend_ft','allow_ft','mgr','meal','other','pt',
                  'bonus_sales','bonus_perf','bonus_proj','ins_ft_deduct','dorm_ft_deduct','ins_pt_deduct','dorm_pt_deduct',
                  'co_labor','co_health','co_pension','co_owner','co_group','ins_self','yearend',
                  'support_json','total','updated_at'],
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
  cost_snapshot:'payroll_cost_snapshot',
  xmap:'payroll_xmap',
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
  // 遲到分鐘不計薪（Eason 2026-08-23 定案）。true＝啟用；遲到「照舊也扣全勤」，兩個都扣。
  ['pt_attend_min_hours', 100, '計時全勤津貼的最低時數門檻'],
  ['late_deduct', 'true', '遲到分鐘不計薪（true/false）'],
  // 從哪個月開始按分鐘扣（YYYY-MM，空白＝一直都扣）。2026-10-10 Eason：央廚九月先不扣、十月起扣。
  ['late_deduct_from', '', '遲到按分鐘扣的起始月份（YYYY-MM，空白＝不限）'],
  ['late_div_days', 30, '遲到費率分母（天）'],
  ['late_div_hours', 8, '遲到費率分母（時）'],
  // ── 全勤「門檻式歸零」參數（2026-08-23，央廚／總部用；填 0 或留空＝不啟用，光復維持純遞減）──
  ['attend_void_forget', 0, '忘刷達幾次(含)以上→全勤歸零，0＝不啟用'],
  // 哪些日子算進「每日倒扣」（2026-10-10 Eason：央廚／總部全勤是全有全無，只有病假一天扣 100，
  // 忘刷／遲到／早退只看上面的門檻歸零、當天不倒扣）。all＝改版前行為（光復）；leave＝只算請假日。
  ['attend_deduct_basis', 'all', '每日倒扣算哪些日子：all＝遲到早退忘刷請假都算、leave＝只算請假日'],
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
function payForceTextCols(sh, cols, kind) {
  // ⚠ 純日期字串一定要鎖文字格式，否則 Sheets 轉成 Date 物件、之後比對全失敗。
  //   event_date／start／end 是 2026-08-23 新增的假別事件日與留停區間，漏了就會踩同一個坑。
  // value：payroll_config 的參數值（2026-11-04 唯讀證實：央廚 late_deduct_from '2026-10' 被轉成日期，遲到按分鐘扣從沒生效）。
  //   鎖文字後讀回一律是字串，payConfig 的 cast 會把 'true'／'false'／數字字串轉回來。
  const TEXT = { ym: 1, hire_date: 1, leave_date: 1, dates: 1,
                 event_date: 1, start: 1, end: 1, value: 1 };
  // 打卡對照：編號一律文字（'001' 這類打卡編號被轉成數字 1 就對不回打卡表）。只限這張表，其他表的格式不動。
  const EXTRA = kind === 'xmap' ? { emp_no: 1, emp_id: 1, pay_store: 1, acct_store: 1, synced_at: 1 } : {};
  cols.forEach(function (c, i) {
    if (TEXT[c] || EXTRA[c]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

/** 整張覆寫（保留表頭）——用於 master / holiday / run / item 的重建 */
function payReplaceAll(kind, rows) {
  payInvalidate(kind);
  const sh = paySheet(kind), cols = PAY_SHEETS[kind];
  sh.getRange(1, 1, 1, cols.length).setValues([cols]);   // 同步表頭（schema 只 append，補上新欄不動既有資料）
  payForceTextCols(sh, cols, kind);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(function (r) { return cols.map(function (c) { return r[c] == null ? '' : r[c]; }); });
  sh.getRange(2, 1, values.length, cols.length).setValues(values);
}

/* 寫回段加鎖（2026-11-04 夜間 QA #6）：各 handler 都是「開頭讀整張 → 算 → 用『別店列＋本店新列』整張覆寫」，
   兩店同時重算時，後寫的那支拿開頭讀到的舊整張蓋回去，先存的那店就被洗掉。
   只鎖寫回那一兩秒（重算本身可能幾十秒，不放進鎖裡，否則 LINE 綁定／送申請要排隊；打卡不用這把鎖）：
   fn 在鎖內執行，裡面一律 payRead 重讀最新整張（進鎖時已 payInvalidate），再篩、再寫。等不到鎖回 false。 */
const PAY_BUSY_ = { ok: false, error: 'busy', message: '薪資資料正在被另一台裝置儲存，請幾秒後再按一次' };
function payWriteLocked_(kinds, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return false;
  try {
    kinds.forEach(payInvalidate);
    fn();
    SpreadsheetApp.flush();
    return true;
  } finally { lock.releaseLock(); }
}
/** 鎖內重讀整張、留下 keep 為真的列、接上 rows 寫回。 */
function payReplaceKeep_(kind, keep, rows) {
  return payWriteLocked_([kind], function () { payReplaceAll(kind, payRead(kind).filter(keep).concat(rows)); });
}

function payAppend(kind, rows) {
  payInvalidate(kind);
  if (!rows.length) return;
  const sh = paySheet(kind), cols = PAY_SHEETS[kind];
  payForceTextCols(sh, cols, kind);
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
    catch (e) {
      // 試算表 ID 不回給呼叫端（Code.gs 會把例外字串當 detail 回傳）；只寫進執行紀錄給系統管理者查（payroll-scope fix2-5）
      Logger.log('payClockSS 開不起來：門市 ' + c + ' clock_ss_id=' + id + '：' + (e && e.message));
      throw new Error('門市 ' + c + ' 的打卡試算表開不起來，請找系統管理者檢查門市設定');
    }
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
  // events.ts 有人手貼成「2026-07-15 09:00:00」時 Sheets 會轉成 Date：先正規化，忘刷卡統計與總表才切得到日期（2026-11-04 仿試算表測試；Code.gs 每條路徑都這樣做）
  if (sheetName === 'events') rows.forEach(function (r) { r.ts = normCellTs(r.ts); });
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
/** cutoffDate（'YYYY-MM-DD'，選填）：只給 T15 估算端點用——只歸集「當天 <= cutoffDate」的
 *  核定／打卡／請假資料，其餘呼叫端（payInputsBase 等既有 11+ 個呼叫路徑其實只有這一個）不傳
 *  第五個參數，行為與加這個參數之前完全相同。加這個參數是為了「至昨天」的估算口徑要排除
 *  今天可能還沒核定完的部分日資料，不是為了改變既有的整月歸集邏輯。 */
function payCollect(ym, minH, store, holidayDates, cutoffDate) {
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
      deduct_days: 0, _days: {}, _ld: {}, work_days: 0, _wd: {}, _dh: {}, _trip: {}, holiday_h: 0,
      _lh: {},   // 2026-11 起逐日加班用：每天請假時數
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
    if (cutoffDate && String(d) > cutoffDate) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      const rec = approvedMap[d][emp];
      const dayH = Number(rec.approved_hours) || 0;
      slot(emp).hours += dayH;
      // 餐費補助出勤天數：當日實際核定工時滿 MEAL_MIN_HOURS 才算一天（未滿不補、請假/特休/出差核定 0 不算）
      // 餐費補助出勤天數。出差日（假別表 count_meal_day=false）要扣掉出差時數再判斷門檻，
      // 這裡先記下核定時數，等下面讀完 leave 分頁知道出差幾小時再決定（見函式尾端）。
      if (dayH >= MEALMIN) slot(emp)._wd[d] = true;
      slot(emp)._dh[d] = (slot(emp)._dh[d] || 0) + dayH;
      // 國定假日當天的出勤時數（計時同仁雙薪的基礎；時數本身照樣算進總時數）
      if (HOLSET[String(d)]) slot(emp).holiday_h += dayH;
      const st = String(rec.status_text || '');
      if (payHasLateEarly(st).any) markDay(emp, d);
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
  //    主管認定的重複打卡不算忘刷（2026-11-06 Eason；認定存在核定紀錄 dup_ignore，見 Code.gs dupIgnoreSet_）
  const paired = pairShifts(dropDupIgnored_(events, dupIgnoreSet_(approvedMap)));
  const todayStr = todayTaipeiStr();
  function markForget(empId, d, cards) {
    const sl = slot(empId);
    sl.forget_punch += (cards || 1);   // 每漏一張卡算一次
    sl._fd[d] = true;                  // 同一天只算一次（另一種計數單位）
    markDay(empId, d);
  }
  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym || d === todayStr) return;   // 今天未配對＝上班中，不算忘刷
    if (cutoffDate && d > cutoffDate) return;
    markForget(String(e.emp_id), d);
  });
  paired.unmatchedOuts.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym) return;
    if (cutoffDate && d > cutoffDate) return;
    markForget(String(e.emp_id), d);
  });
  // 2b) 「第N段下班／上班無打卡」也算忘刷（2026-09-21 建立，2026-09-29 改成逐段標示）。
  //     中間漏刷一組上下班卡時，頭尾那兩張卡被 pairShifts 配成一長段，unmatchedIns/Outs
  //     都是空的 → 上面兩圈一筆都抓不到。結果是「頭尾各刷一張、中間兩張都沒刷」的人
  //     忘刷次數 0、全勤照領，反而比老實刷四張只漏一張的人少被扣——規則對不老實的人寬鬆。
  //     改從核定狀態把它補回來（判定本身仍然只有 computeApprovalStatus 一套，不重寫規則）。
  //     現在一行就是一張卡，與上面「每漏一張卡算一次」同口徑；forget_day 照樣同一天只算 1 天。
  //     ⚠ 不跳過今天：這是核定時段之間的缺口，主管核定時人早就下班了，
  //       沒有 unmatchedIns 那種「今天＝還在上班中」的歧義。
  //     中間休息沒打卡（2026-11-02 Eason）：同仁用忘打卡申請補「休息開始下班＋回來上班」一組、主管核准了，
  //     核定狀態會寫「第一段下班無打卡、第二段上班無打卡」兩張——這一組只算 1 次。
  const breakReq = {};
  payClockRead(store, 'requests').forEach(function (r) {
    if (String(r.kind) !== 'miss' || String(r.miss_type) !== 'break' || String(r.status) !== 'approved') return;
    const k = String(r.emp_id) + '|' + String(normCellDate(r.date));
    breakReq[k] = (breakReq[k] || 0) + 1;
  });
  Object.keys(approvedMap).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    if (cutoffDate && String(d) > cutoffDate) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      let g = payMissingCards(approvedMap[d][emp].status_text);
      const nb = breakReq[String(emp) + '|' + d] || 0;
      if (g >= 2 && nb) g = Math.max(1, g - Math.min(nb, Math.floor(g / 2)));
      if (g) markForget(String(emp), d, g);
    });
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
    if (cutoffDate && d > cutoffDate) return;
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
    let ae = lt ? (lt.attend_effect || (lt.count_absent ? 'deduct' : 'none')) : 'deduct';
    if (code === 'personal' && payRules3On_(ym) && !payIsSslStore_(store)) ae = 'void';   // 非小辛辣：當月有事假績效整筆取消（3-3，Eason 2026-11-08 確認）
    if (ae === 'void') s.attend_void = true;          // 例：央廚／總部「有事假就沒全勤」
    s._lh[d] = payR2((s._lh[d] || 0) + h);
    // 病假一年 30 天內不扣全勤（出勤認定清單 C6，2026-11 起）：先記下病假日，超過的天數由計算端（知道今年已用幾天）加回缺勤
    if (ae === 'deduct' || ae === 'void') { markDay(emp, d); s._ld[d] = true; }
    // 出差之類「不算餐費出勤日」的，把當天從餐費天數扣掉
    // 時數留白＝整天出差（出差是整天的旗標，舊資料多半不填時數）→ 記成 Infinity，當天一定不算
    if (lt && lt.count_meal_day === false) s._trip[d] = (s._trip[d] || 0) + (h > 0 ? h : Infinity);
  });

  // attend_deduct_basis='leave'：缺勤天數只算請假日（央廚／總部）；忘刷／遲到只走門檻歸零
  let leaveOnly = false;
  try { leaveOnly = payPerfLeaveOnly_(store, ym, payConfig(store)); } catch (e) {}
  /* 出差日的餐費（2026-10-10 Eason：當天有打卡時數＋出差時數時，以打卡時數計算）：
     打卡時數＝當天核定 − 出差時數，滿門檻才算一天。整天出差（核定就是出差時段）＝0，不算；
     出差 1.5H、其餘上班 8.5H＝算。出差時數留白＝整天出差，不算。改版前只要當天有出差就整天不算。 */
  Object.keys(out).forEach(function (emp) {
    const o = out[emp];
    Object.keys(o._trip).forEach(function (d) {
      if ((o._dh[d] || 0) - o._trip[d] < MEALMIN) delete o._wd[d];
    });
  });
  Object.keys(out).forEach(function (emp) {
    const o = out[emp];
    if (payOtDailyOn(ym)) {   // 2026-11 之前的月份不多任何欄位（回應與改版前逐欄相同）
      o.day_h = o._dh; o.day_leave = o._lh;
    }
    delete o._lh;
    out[emp].deduct_days = Object.keys(leaveOnly ? out[emp]._ld : out[emp]._days).length;
    out[emp].work_days = Object.keys(out[emp]._wd).length;
    out[emp].forget_day = Object.keys(out[emp]._fd).length;
    delete out[emp]._days; delete out[emp]._ld; delete out[emp]._wd; delete out[emp]._fd;
    delete out[emp]._dh; delete out[emp]._trip;
  });
  return out;
}


/* ═══════════════════ 計算引擎（與 ~/mala-payroll 已驗證版本同一套公式）═══════════════════ */

function payR0(v) { return Math.round(v); }
function payR2(v) { return Math.round(v * 100) / 100; }
/** 假別時數一律四捨五入到小數第一位（Eason 2026-10-05） */
function payR1(v) { return Math.round(v * 10) / 10; }
function payNum(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }
/** 布林讀取：接受 true/1/'1'/'true'/'TRUE'（試算表可能存成數字或字串） */
function payBool(v) { return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'; }

function payDaysIn(ym) {
  const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  return new Date(y, m, 0).getDate();
}

/** d 加 m 個月；目標月份沒有那一天就取該月最後一天（8/31＋6＝2/28、1/31＋1＝2/28）。JS 的 setMonth 會溢位到下個月。 */
function payAddMonthsClamp_(d, m) {
  const y = d.getFullYear(), mo = d.getMonth() + m, day = d.getDate();
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(day, last));
}


/** 到職／離職日字串（相容 Sheets 把純日期存成 Date 物件的陷阱）→ 'yyyy-MM-dd' */
function payDateStr(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  return String(v || '').trim().slice(0, 10);
}

/** 特休額度（台灣勞基法§38 週年制）：以薪資月月底為基準日，回當前週年期 {days, ps, pe}。
 *  滿6月未滿1年3日；1年7日；2年10日；3年14日；5年15日；10年起每年+1、上限30日。年資未滿6月回 days:0。 */
/** 計時特休的工時比例（勞基法§38 部分工時：依工作時間比例計給）：
 *  前 12 個月（不含本月）薪資結算過的月份，平均每月核定時數 ÷ 全時每月工時（全年 2088 小時÷12＝174，出勤規範 3-18），最多 1。
 *  沒有任何結算過的月份＝0（新人第一個月看不到額度，結算一個月之後才有）。 */
var PAY_PT_FULL_MONTH_H = 2088 / 12;
/** 計時同仁有沒有投保勞保（主檔自付或公司負擔有填）：出勤規範 3-18 未投保者不適用特休。 */
function payPtInsured_(e) { return payNum(e.labor_ins) > 0 || payNum(e.co_labor) > 0; }
function payPtAnnualRatio(runRows, empId, ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const from = (m === 12 ? y : y - 1) + '-' + pad2(m === 12 ? 1 : m + 1);   // 12 個月前的下個月
  const byYm = {};
  (runRows || []).forEach(function (r) {
    const k = String(r.ym);
    if (String(r.emp_id) !== String(empId) || k >= ym || k < from) return;
    byYm[k] = (byYm[k] || 0) + payNum(r.total_hours) + payNum(r.support_hours);
  });
  const ks = Object.keys(byYm);
  if (!ks.length) return 0;
  const avg = ks.reduce(function (t, k) { return t + byYm[k]; }, 0) / ks.length;
  return Math.min(1, avg / PAY_PT_FULL_MONTH_H);
}
function payAnnualQuota(hireStr, ym) {
  const hs = payDateStr(hireStr); if (!hs) return null;
  const h = new Date(hs + 'T00:00:00'); if (isNaN(h)) return null;
  const asof = new Date(ym + '-' + pad2(payDaysIn(ym)) + 'T00:00:00');
  let months = (asof.getFullYear() - h.getFullYear()) * 12 + (asof.getMonth() - h.getMonth());
  // （2026-11-04 夜間 QA）「滿 N 個月」的那天，該月沒有到職日（8/31 的 2 月）就用該月最後一天（同 payAddMonthsClamp_、民法 §121）。
  //  asof 本來就是該月最後一天，所以月數＝曆月差，不再因為 asof 日 < 到職日少算一個月（8/31 到職、2026-02 原本回 5，應為 6）。
  if (months < 6) return { days: 0, ps: '', pe: '' };
  function addM(d, m) { return payAddMonthsClamp_(d, m); }   // 月底到職不溢位（8/31＋6 個月＝2/28，不是 3/3；2026-11-04 對抗驗證）
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
  /* ⚠ 門檻 0／負數／非數字一律視為「沒設定」→ 用預設 6（2026-08-24 實際踩到）。
     金額欄的 0 是合法值（某店不給加給），但**門檻的 0 沒有合理語意**——
     「到職當天就算年資已滿」等於直接調高基本時薪，不是年資加給。
     而設定頁的欄位一旦被清空，n('') 就是 0，存進去之後全體計時同仁會被誤加 10 元
     （光復的 pt_tenure_months 就是這樣變成 0 的，A 君 2026-05 因此多算了年資加給）。*/
  var months = payCfgNum(cfg, 'pt_tenure_months', 6);
  if (!(months > 0)) months = 6;
  if (!plus) return 0;
  const hs = payDateStr(e.hire_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hs)) return 0;
  const h = new Date(hs + 'T00:00:00');
  const due = payAddMonthsClamp_(h, months);   // 月底到職不溢位（8/31 到職＋6 個月＝2/28；原本溢位成 3/3、晚一個月才加，2026-11-04 對抗驗證）
  const monthStart = new Date(ym + '-01T00:00:00');
  return monthStart > due ? plus : 0;
}

/* ═══════════════════ 補休：每月加減結算（2026-11-01 Eason 改制，取代 2026-10-09 的存入＋6 個月到期）═══════════════════
 * ①只有正職能請補休 ②每人每月一本帳：本月核准的加班申請時數是正的、本月的補休時數是負的，相減＝補休帳
 *   （不跨月、沒有到期）。所有核准的加班都算，加班申請不再分「加班費／換補休」。
 * ③可以先休後補、不設上限（LINE、值班核定頁、營運系統都不擋餘額）；補休帳是負的：
 *   每月 20、25 號檢查通知（通知匣＋該店值班主管），**有負數就不能鎖定本月**（不自動扣）。
 * ④薪資：補休不再算成出勤時數（不抵不足），月底淨加班照加班費率發——休掉的補休直接從加班時數裡扣。
 *   PAY_COMP_MONTHLY_FROM 以前的月份照舊算法（那時沒有補休，留著只是保險）。
 * 補休時數＝每天取「leave 分頁假別補休的時數」與「審核中／已核准的補休申請時數」較大者（核定進 leave 之後不重算）。
 * ⚠ 放在 payR0～Handlers 之間：純函式，測試與 payroll_mock.js 會切這一段。 */
var PAY_COMP_CODE = 'comp';
var PAY_COMP_NAME = '補休';
var PAY_COMP_MONTHLY_FROM = '2026-10';
/** 這種假是不是補休（假別表沒有這列時，程式內建也認得「補休」二字） */
function payIsCompType(t) { return !!t && (String(t.code) === PAY_COMP_CODE || String(t.name).trim() === PAY_COMP_NAME); }
/** 這家店適不適用補休：墨竹亭不適用（出勤規範 4-6，Eason 2026-11-08） */
function payCompStoreOn_(store) { return !/^MZT/.test(String(payStore(store))); }
/** 程式內建的補休假別（Eason 還沒在 payroll_leave_type 加這列時用）：全薪、不扣全勤；時數不抵不足（從當月加班扣）。 */
function payCompDefaultType() {
  return { code: PAY_COMP_CODE, name: PAY_COMP_NAME, pay_ratio: 1, count_absent: false, offset_shortfall: false,
           cap_days: null, cap_basis: '', over_ratio: 0, merge_into: '', cap_per_month: null,
           tenure_months: null, under_ratio: 0, min_unit: 'hour', window_before: null, window_days: null, window_max: null,
           attend_effect: '', count_meal_day: true, sort: 9990,
           note: '補休：用當月核准的加班抵（每月加減結算，不跨月）；全薪、不扣全勤，時數不抵不足（程式內建）' };
}
/** 某人某月的補休帳（純計算）：ots＝[{date,h}] 本月核准加班；leaves＝[{date,h}] leave 分頁補休；reqs＝[{date,h}] 審核中／已核准補休申請。
 *  回 {ot_h, used_h, balance_h}（balance 可為負）。 */
function payCompMonthCalc(ots, leaves, reqs) {
  const sumBy = function (xs) {
    const m = {};
    (xs || []).forEach(function (x) { const h = payNum(x.h); if (h > 0) m[String(x.date)] = payR2((m[String(x.date)] || 0) + h); });
    return m;
  };
  const L = sumBy(leaves), R = sumBy(reqs);
  let used = 0;
  Object.keys(L).concat(Object.keys(R)).filter(function (d, i, a) { return a.indexOf(d) === i; })
    .forEach(function (d) { used = payR2(used + Math.max(L[d] || 0, R[d] || 0)); });
  const ot = payR2((ots || []).reduce(function (a, x) { return a + Math.max(0, payNum(x.h)); }, 0));
  return { ot_h: ot, used_h: used, balance_h: payR2(ot - used) };
}

/* ═══════════════════ 加班費新算法：逐日判斷（2026-11-06 Eason 定案，2026-11 薪資起）═══════════════════
 * 規格 ~/Desktop/Claude/系統/打卡/加班費新算法_規格草案_20261106.md；出勤認定清單 D1／D2／D4／D8／D9／D10／E4。
 * 每天先看排班管理發布的班表（sched_pub）那一格，再看當天核定時數（本店＋同品牌別店支援合計）：
 *   上班日（W）／請假日（L）：超過 8 小時 → 前 2 小時 ×1.34、其後 ×1.67（8 小時內月薪已含，出勤規範 4-4）
 *   休息日（H）：全部時數另給 → 前 2 小時 ×1.34、第 3–8 小時 ×1.67、第 9 小時起 ×2.67
 *   例假（R）：有上班就加發一日（月工資 ÷30）；國定假日：8 小時內加發上班時數的時薪（月工資 ÷240，出勤規範 6-3）；兩者超過 8 小時照平日加班
 *   計時：時數本來就照時薪給，只加「加成」那一段（+0.34、+0.67、+1.67、例假 +1 倍，出勤規範 4-5）；
 *         國定假日維持既有的 holiday_double（當天整天加一倍），不另加逐日加成。
 * 加班時薪＝月工資 ÷240（不取整，金額才四捨五入）；月工資＝本薪＋職能＋夜間＋店長＋小編＋績效獎金上限（原全勤上限）＋伙食費（固定 2,000）。
 * 正職不再有「不足時數」倒扣；整月加班合計（平日加班＋休息日出勤時數）超過 54 小時只標紅、不擋。
 * 補休（每月加減）：本月休掉的補休時數依加班日期先後扣（4-7）；可抵平日全部與休息日前 2 小時（4-6），例假、國定假日出勤不能抵（4-10）；
 *   抵不掉的時數記 comp_over_h，不能鎖定。墨竹亭不適用補休（payCompStoreOn_）。
 * ⚠ 放在 payR0～Handlers 之間：純函式，測試與 payroll_mock.js 只切這一段。 */
/* 遲到／早退每分鐘費率（正職）的基數自這個月起含全勤上限（Eason 2026-11-07，全部門市）。
 * 之前月份照舊：底薪＋職能＋夜間＋店長。 */
var PAY_LATE_ATTEND_FROM = '2026-10';
function payLateBaseFT(e, ym, cfg) {
  const m = payNum(e.base) + payNum(e.skill_allow) + payNum(e.night_allow) + payNum(e.mgr_allow)
    + (String(ym) >= PAY_LATE_ATTEND_FROM ? payNum(e.attend_cap) : 0);
  return m / payNum(cfg.late_div_days) / payNum(cfg.late_div_hours) / 60;
}
var PAY_OT_DAILY_FROM = '2026-11';
/* 出勤規範第 3 批（Eason 2026-11-08 確認），2026-11 薪資起：
 *   績效（原全勤）分兩套：小辛辣（SSL*）照舊每天扣；其他單位每日倒扣只算請假日，歸零門檻照舊（6-6、2-3、6-16）。
 *   忘刷一律同一天算 1 次（2-3）。計時滿勤、年資加給只有小辛辣有，其他店歸 0（6-4）。
 *   寫在程式不改參數表：參數沒有月份，改表會動到還沒鎖定的 10 月草稿。 */
var PAY_RULES3_FROM = '2026-11';
/* 出勤規範第 4 批（Eason 2026-11-08）：28 天週期加班 36H 黃字、46H 紅字並擋會變成加班的上班卡（4-15、4-17）；
 * 超過 8H 沒有核准的加班單不能鎖月（4-2，2026-11-11 起算）；平日出差不得報加班（5-1，只提醒）；曠職提醒（2-8）。 */
var PAY_ANNUAL_SETTLE_FROM = '2026-05';   // 薪酬系統第一個月；測試基準用來關掉
var PAY_OT_WARN_H = 36;
var PAY_OT_STOP_H = 46;
var PAY_OT_FORM_FROM = '2026-11-11';
var PAY_OT_FORM_TOL_H = 0.25;   // 同核定的 15 分鐘容差
/** att.ot_own_h＝本店逐日核定；att.ot_forms＝{ot:{日期:已核准加班單時數}, trip:{日期:true}}。沒帶（舊呼叫端）＝不檢查。 */
function payOtFormCheck_(att) {
  const out = { missing: [], trip_ot: [] };
  const own = att.ot_own_h, f = att.ot_forms;
  if (!own || !f) return out;
  Object.keys(own).sort().forEach(function (d) {
    if (d < PAY_OT_FORM_FROM) return;
    const need = payR2(payNum(own[d]) - 8), have = payNum(f.ot[d]);
    if (need > 0 && have + PAY_OT_FORM_TOL_H < need) out.missing.push({ date: d, need: need, have: have });
  });
  const dl = att.daily || {};
  Object.keys(f.trip).sort().forEach(function (d) {
    if (d < PAY_OT_FORM_FROM || !(payNum(f.ot[d]) > 0)) return;
    const kind = payOtKindOf((dl.sched || {})[d] || null, !!(dl.hol || {})[d]);
    if (kind !== 'H' && kind !== 'R' && kind !== 'HOL') out.trip_ot.push(d);
  });
  return out;
}
/** 墨竹亭全時同仁每日出勤要滿 8 小時（含出差、請假，出勤規範 4-6）：排工作日、到昨天為止、當天有出勤或請假卻不滿 8 小時的日子。只提醒。 */
function payMztShortDays_(e, d) {
  const out = [];
  if (!/^MZT/.test(String(e.store || '')) || !d) return out;
  (d.dates || []).forEach(function (date) {
    if (d.until && date > d.until) return;
    const cell = (d.sched || {})[date];
    if (!cell || String(cell.t) !== 'W' || (d.hol || {})[date]) return;
    const total = payR2(payNum((d.day_h || {})[date]) + payNum((d.day_leave || {})[date]));
    if (total > 0 && total < 8) out.push({ date: date, h: total });
  });
  return out;
}
/** 事假＋家庭照顧假今年累計超過事假上限的天數（3-3）。事假的已用天數含家庭照顧假逾上限併入的部分，這裡只補回沒併入的那段。 */
function payPersonalOverDays_(att, cfg, ltypes) {
  const u = att.leave_usage || {}, dayH = payNum(cfg.daily_hours) || 8, lv = payAttLeaves(att) || {};
  const capOf = function (c, d) { const t = (ltypes || []).filter(function (x) { return x.code === c; })[0]; return t && payNum(t.cap_days) > 0 ? payNum(t.cap_days) : d; };
  const p = payNum((u.personal || {}).used_before_days), fam = payNum((u.family || {}).used_before_days);
  const total = p + Math.min(fam, capOf('family', 7)) + (payNum(lv.personal) + payNum(lv.family)) / dayH;
  return payR2(Math.max(0, total - capOf('personal', 14)));
}
function payRules3On_(ym) { return String(ym) >= PAY_RULES3_FROM; }
function payIsSslStore_(store) { return /^SSL/.test(String(store || 'SSLGF')); }
function payPerfLeaveOnly_(store, ym, cfg) {
  return String((cfg || {}).attend_deduct_basis || 'all') === 'leave' || (payRules3On_(ym) && !payIsSslStore_(store));
}
function payRules3Cfg_(cfg, store, ym) {
  if (!payRules3On_(ym)) return cfg;
  const o = Object.assign({}, cfg, { attend_forget_unit: 'day' });
  if (!payIsSslStore_(store)) { o.pt_attend_plus = 0; o.pt_tenure_plus = 0; }
  return o;
}
var PAY_OT_MEAL_FIXED = 2000;        // 伙食費（算進月工資，Eason 2026-11-06：固定 2,000）
var PAY_OT_DIV = 240;                // 加班時薪分母
var PAY_OT_DAY_DIV = 30;             // 一日工資分母（例假／國定假日加發一日、特休未休折算）
var PAY_OT_MONTH_CAP = 54;           // 每月加班上限（只標紅）
var PAY_OT_MUL_FT = { a: 1.34, b: 1.67, c: 2.67 };   // 正職加班倍率（出勤規範 4-4，取代 4/3、5/3、8/3）
var PAY_OT_MUL_PT = { a: 0.34, b: 0.67, c: 1.67 };   // 計時加成（出勤規範 4-5）
var PAY_OT_FORCE_ = false;           // 只給 payroll_ot_preview 用：試算時把新算法套到任何月份（同一個請求內，算完就關）
function payOtDailyOn(ym) { return PAY_OT_FORCE_ || String(ym || '') >= PAY_OT_DAILY_FROM; }
/** 月工資總額（不乘在職比例：費率是職位的費率） */
function payOtMonthWage(e, cfg) {
  const meal = payCfgNum(cfg, 'ot_meal_fixed', PAY_OT_MEAL_FIXED);
  return payNum(e.base) + payNum(e.skill_allow) + payNum(e.night_allow) + payNum(e.mgr_allow) +
         payNum(e.editor_allow) + payNum(e.attend_cap) + meal;
}
/** 某一天怎麼拆：kind＝W（上班日，L 請假日同）／H（休息日）／R（例假）／HOL（國定假日）；h＝當天核定合計 */
function payOtDayBreak(kind, h) {
  h = payR2(Math.max(0, payNum(h)));
  const o = { w43: 0, w53: 0, r43: 0, r53: 0, r83: 0, day: 0 };
  if (!(h > 0)) return o;
  if (kind === 'H') {
    o.r43 = Math.min(h, 2); o.r53 = payR2(Math.min(Math.max(h - 2, 0), 6)); o.r83 = payR2(Math.max(h - 8, 0));
    return o;
  }
  const over = payR2(Math.max(h - 8, 0));
  o.w43 = Math.min(over, 2); o.w53 = payR2(over - o.w43);
  if (kind === 'R' || kind === 'HOL') o.day = 1;
  return o;
}
/** 班表一格 → kind。國定假日（薪資的節日清單，或班表「國」）優先；班表查不到回 ''。 */
function payOtKindOf(cell, isHol) {
  if (isHol || (cell && String(cell.t) === 'L' && String(cell.l || '') === '國')) return 'HOL';
  const t = cell ? String(cell.t || '') : '';
  if (t === 'H' || t === 'R') return t;
  if (t === 'W' || t === 'L') return 'W';
  return '';
}
/** 逐日統計（純函式）。d＝{ dates:[…本月在職日…], sched:{date:cell}, day_h:{date:時數}, day_leave:{date:時數},
 *    hol:{date:true}, until:'YYYY-MM-DD'（之後的日子還沒到，不判沒來）, comp_h, extra_ot }
 *  回 { w43,w53,r43,r53,r83, rdo_days,hol_days, rdo_dates:[], missing:[], no_show:[], ot_month_h } */
function payOtDailySum(d) {
  const S = { w43: 0, w53: 0, r43: 0, r53: 0, r83: 0, rdo_days: 0, rdo_h: 0, hol_days: 0, hol_h: 0, no_show_streak: 0, ot_days: {}, rdo_dates: [], hol_dates: [], missing: [], no_show: [] };
  const pool = [];   // 補休可以抵的加班，依日期先後（4-6、4-7、4-10）
  let absentRun = 0;   // 連續幾個應出勤日沒來（2-8）
  (d.dates || []).forEach(function (date) {
    const cell = (d.sched || {})[date] || null;
    const isHol = !!(d.hol || {})[date];
    const kind = payOtKindOf(cell, isHol);
    const h = payNum((d.day_h || {})[date]);
    if (!cell || !String(cell.t || '')) S.missing.push(date);
    // 有排班、沒核定、沒請假：只提醒（Eason 2026-11-06：不自動扣）
    const scheduledWork = cell && (String(cell.t) === 'W' || (String(cell.t) === 'H' && cell.s));
    if (scheduledWork && !isHol && (!d.until || date <= d.until)) {
      if (!(h > 0) && !(payNum((d.day_leave || {})[date]) > 0)) { S.no_show.push(date); absentRun++; S.no_show_streak = Math.max(S.no_show_streak, absentRun); }
      else absentRun = 0;
    }
    const b = payOtDayBreak(kind || 'W', h);   // 班表查不到的日子先當上班日算（鎖定會被擋，補發布後重算）
    ['w43', 'w53', 'r43', 'r53', 'r83'].forEach(function (k) { S[k] = payR2(S[k] + b[k]); });
    { const dayOt = payR2(b.w43 + b.w53 + b.r43 + b.r53 + b.r83); if (dayOt > 0) S.ot_days[date] = dayOt; }
    if (kind === 'H') { if (b.r43 > 0) pool.push({ date: date, k: 'r43', h: b.r43 }); }
    else if (kind !== 'R' && kind !== 'HOL') {
      if (b.w43 > 0) pool.push({ date: date, k: 'w43', h: b.w43 });
      if (b.w53 > 0) pool.push({ date: date, k: 'w53', h: b.w53 });
    }
    if (b.day && kind === 'R') { S.rdo_days++; S.rdo_h = payR2((S.rdo_h || 0) + h); S.rdo_dates.push(date); }
    if (b.day && kind === 'HOL') { S.hol_days++; S.hol_h = payR2(S.hol_h + Math.min(h, 8)); S.hol_dates.push(date); }
  });
  const extraOt = Math.max(0, payNum(d.extra_ot));
  S.w43 = payR2(S.w43 + extraOt);   // 舊的「逐日加班」手填欄：照平日前 2 小時給
  if (extraOt > 0) pool.push({ date: '9999-12-31', k: 'w43', h: extraOt });   // 手填沒有日期，排最後
  let comp = Math.max(0, payNum(d.comp_h));
  S.comp_used_h = 0;
  pool.sort(function (x, y) { return String(x.date).localeCompare(String(y.date)); });
  pool.forEach(function (p) {
    const x = Math.min(comp, p.h);
    S[p.k] = payR2(S[p.k] - x); comp = payR2(comp - x); S.comp_used_h = payR2(S.comp_used_h + x);
    if (x > 0 && S.ot_days[p.date] != null) S.ot_days[p.date] = payR2(S.ot_days[p.date] - x);
  });
  S.comp_over_h = comp;   // 抵不掉的補休：不能鎖定，要改成其他假別
  S.ot_month_h = payR2(S.w43 + S.w53 + S.r43 + S.r53 + S.r83);
  return S;
}
/** 逐日加班 → 薪資單明細（push 由 payCalcOne 傳入）。ft：正職給全額倍率；計時只給加成（w＝有效時薪）。 */
function payOtDailyItems(S, ft, M, w, push) {
  const R = ft ? M / PAY_OT_DIV : w;          // 一小時的「1 倍」
  const mul = ft ? PAY_OT_MUL_FT : PAY_OT_MUL_PT;
  const tag = ft ? '' : '加成';
  if (S.w43 > 0) push('ot_w43', '平日加班' + tag + '（' + mul.a + '）', S.w43, payR2(R * mul.a), S.w43 * R * mul.a);
  if (S.w53 > 0) push('ot_w53', '平日加班' + tag + '（' + mul.b + '）', S.w53, payR2(R * mul.b), S.w53 * R * mul.b);
  const restH = payR2(S.r43 + S.r53 + S.r83);
  if (restH > 0) {
    const amt = (S.r43 * mul.a + S.r53 * mul.b + S.r83 * mul.c) * R;
    push('ot_rest', '休息日出勤' + tag, restH, null, amt,
         '前2H×' + mul.a + ' ' + S.r43 + 'H、3–8H×' + mul.b + ' ' + S.r53 + 'H' + (S.r83 ? '、9H起×' + mul.c + ' ' + S.r83 + 'H' : ''));
  }
  if (ft) {
    const day = M / PAY_OT_DAY_DIV;
    if (S.rdo_days) push('ot_rdo', '例假出勤（加發一日）', S.rdo_days, payR2(day), S.rdo_days * day);
    if (S.hol_h > 0) push('ot_hol', '國定假日出勤（加發時數）', S.hol_h, payR2(R), S.hol_h * R);
  } else if (S.rdo_h > 0) {
    push('ot_rdo_h', '例假出勤加倍', S.rdo_h, payR2(w), S.rdo_h * w);
  }
}
/** 加班類明細（成本分類「加班」科目、儀表板加班費占比都用這個判斷） */
function payIsOtKey(k) { return String(k) === 'overtime' || /^ot_/.test(String(k)); }

/* 正職加班「上班＋可抵扣假」口徑的生效月份（Eason 2026-10-02）。
 * 更早的月份是打卡上線前，工時從考勤機報表手動填、加班已另填在逐日加班 extra_ot，
 * 那時的 hours 不一定是純上班（有的直接填滿 184）——套新口徑會把假重複算成加班。
 * 2026-08 已發薪，Eason 決定不補回、維持舊算法 → 生效月份為 2026-09。
 * ⚠ 放在 payR0～Handlers 之間：payroll_mock.js 與測試只切這一段。 */
const PAY_OT_NET_FROM = '2026-09';

function payCalcOne(e, ym, att, cfg, redDays, ltypes) {
  cfg = payRules3Cfg_(cfg, e.store, ym);
  // 假別規則一律由 ltypes（payroll_leave_type）決定；不傳時退回內建預設，
  // 這樣 payroll_mock.js 只抽這支函式也算得出來，不必碰試算表。
  const LT = (ltypes && ltypes.length) ? ltypes : payLeaveTypes('');
  const LTM = {}; LT.forEach(function (t) { LTM[t.code] = t; });
  const D = payDaysIn(ym), P = payRatio(e, ym);
  const earn = [], ded = [];
  const ft = String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true;
  function push(L, key, label, qty, rate, amt, memo) {
    const x = { item_key: key, item_label: label, qty: qty, rate: rate, amount: payR0(amt) };
    if (memo) x.memo = memo;
    L.push(x);
  }
  // 加班費新算法（2026-11 起）：有逐日資料（att.daily）才走逐日判斷；沒有的呼叫端（舊月份、單元測試）照舊
  const daily = payOtDailyOn(ym) && !!att.daily;
  const MW = payOtMonthWage(e, cfg);   // 月工資總額（加班時薪÷240、一日工資÷30 的基數）
  let otS = null;                      // 逐日統計結果（回傳給前端顯示提醒）

  let baseH = null, surplus = null, otPaid = null;
  let ptWage = 0;   // 計時同仁的有效時薪（基本＋滿勤加給＋年資加給），遲到扣款要用
  let ptAttendInfo = null;   // 計時全勤津貼的判定結果（前端顯示時薪組成用）
  const supportH = (att.support || []).reduce(function (a, s) { return a + payNum(s.hours); }, 0);

  if (ft) {
    // 正職：加班／不足時數以「本店核定＋支援」的總時數對基本工時判斷（支援併入，用員工加班費率）
    baseH = payR2((D - redDays) * payNum(cfg.daily_hours) * P);
    surplus = payR2((att.hours + supportH) - baseH);   // 純上班−基本（顯示用，不含假）
    // 可抵扣的假（假別表 offset_shortfall）。這些假另有扣款／給薪處理，在時數上視同已出勤。
    const LMAP = payAttLeaves(att);
    let paidLeave = 0;
    const compMonthly = String(ym) >= PAY_COMP_MONTHLY_FROM;
    Object.keys(LMAP).forEach(function (c) {
      const t = LTM[c];
      // 補休（2026-11-01 改制）：不算出勤時數，休掉的時數直接從當月加班扣（假別表就算勾了可抵不足也一樣）；
      // 改制前的月份照舊制（補休視同出勤），不看內建列已經改成不抵
      if (c === PAY_COMP_CODE || payIsCompType(t)) { if (!compMonthly) paidLeave += payNum(LMAP[c]); return; }
      if (!t || t.offset_shortfall) paidLeave += payNum(LMAP[c]);
    });
    // 淨時數＝上班＋支援＋可抵扣假 − 基本（Eason 2026-10-02 定案）：正→加班、負→不足倒扣。
    // 改版前加班只看 surplus，請假只抵不足，抵完多出來的被吃掉——當月有請假的正職，
    // 某天上 8.5H 那 0.5H 永遠拿不到加班費（A 君 2026-09 實例）。不足倒扣的結果與改版前相同。
    const netH = payR2(surplus + paidLeave);
    const otBase = String(ym) >= PAY_OT_NET_FROM ? netH : surplus;   // 生效月份前沿用舊口徑
    push(earn, 'base_salary', '底薪', null, null, payNum(e.base) * P);
    if (daily) {
      // 2026-11 起：逐日判斷，不再整月加總、也不再「不足時數」倒扣（Eason 2026-11-06）
      otS = payOtDailySum(Object.assign({}, att.daily, {
        extra_ot: att.extra_ot, comp_h: !compMonthly ? 0 : Object.keys(LMAP).reduce(function (t, c) {
          return t + ((c === PAY_COMP_CODE || payIsCompType(LTM[c])) ? payNum(LMAP[c]) : 0); }, 0) }));
      otPaid = otS.ot_month_h;
      payOtDailyItems(otS, true, MW, 0, function (k, l, q, r, a, m) { push(earn, k, l, q, r, a, m); });
    } else {
      otPaid = payR2((otBase > 0 ? otBase : 0) + payNum(att.extra_ot));
      if (otPaid > 0) push(earn, 'overtime', '加班', otPaid, payNum(e.ot_rate), otPaid * payNum(e.ot_rate));
      if (netH < 0) {
        const shortH = payR2(-netH);
        if (shortH > 0) push(ded, 'shortfall_hours', '不足時數', shortH, payNum(e.ot_rate), shortH * payNum(e.ot_rate));
      }
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
      // 2026-11 起改名「績效獎金」（出勤認定清單 E1），規則不變
      push(earn, 'attend_bonus', (payOtDailyOn(ym) ? '績效獎金' : '全勤獎金') + (voidReason ? '（' + voidReason + '）' : ''), null, null, bonusAmt);
    }
    // 餐費補助（正職）：工時分頁勾選才算＝出勤天數 × 餐費補助/日（主檔 meal_allow，無預設）。按實際天數不另乘 P。
    const mealRate = payNum(e.meal_allow);
    const wd = payNum(att.work_days);
    if (payBool(att.meal_on) && mealRate > 0 && wd > 0) push(earn, 'meal_sub', '餐費補助', wd, mealRate, wd * mealRate);
  } else {
    // 計時：本店時數 × 時薪；時薪加給＝滿勤(工時分頁手動打勾)+10、年資(滿半年次月起)+10，可疊加
    // 本月時薪：工時分頁填了 wage_override 就用該月值，否則用主檔 wage（計時每月時薪可不同、又保留歷史）
    let w = payNum(att.wage_override) > 0 ? payNum(att.wage_override) : payNum(e.wage);
    const wBase = w;                         // 基本時薪（不含加給）——薪資單要單獨顯示這個
    // E1 全勤津貼（2026-08-23 改）：勾選＝有資格，**實際符不符合由系統自動偵測**
    //   （時數達門檻且缺勤 0），與餐費補助同一套「勾了才算＋自動判定」的做法。
    //   改版前是「勾了就給」，管理者要自己判斷條件；現在勾錯也不會多給。
    const ptAttend = payPtAttendCheck(att, cfg);
    w += ptAttend.plus;
    const tenPlus = payTenurePlus(e, ym, cfg);   // E2 年資加給（金額與年資門檻同樣可依門市覆寫）
    w += tenPlus;
    ptWage = w;   // 存到外層：下面的「遲到不計薪」要用同一個有效時薪，不另立標準
    ptAttendInfo = ptAttend;   // 帶到回傳值，前端要顯示「有沒有加到全勤津貼、為什麼」
    /* 薪資單要看得到時薪組成（Eason 2026-09-03）：基本時薪一列，兩個加給各一列，
       同仁才知道 225 是怎麼來的。三列的 rate 分別是基本／滿勤／年資，qty 都是同一份時數。
       ⚠ 總額必須與拆列前的「時數 × 有效時薪」**完全相同**——各列分別 payR0 會差 1 元，
          所以先算兩個加給，基本那列＝總額扣掉加給，run 的 gross 才不會因為拆列而變動。
       ⚠ holiday_double 與遲到不計薪仍用有效時薪 w，不受拆列影響。 */
    const totalWage = payR0(att.hours * w);
    const amtAttend = ptAttend.plus ? payR0(att.hours * ptAttend.plus) : 0;
    const amtTenure = tenPlus       ? payR0(att.hours * tenPlus)       : 0;
    push(earn, 'hourly_wage', '薪資（時數）', payR2(att.hours), wBase, totalWage - amtAttend - amtTenure);
    if (amtAttend) push(earn, 'pt_attend_plus', '滿勤加給', payR2(att.hours), ptAttend.plus, amtAttend);
    if (amtTenure) push(earn, 'pt_tenure_plus', '年資加給', payR2(att.hours), tenPlus,       amtTenure);
    // 國定假日出勤：計時同仁時薪雙倍（正職是給假、不另計）。
    // 時數本身已含在上面的總時數裡，這裡只補「多的那一倍」。
    const holH = payR2(Math.min(payNum(att.holiday_h), payNum(att.hours)));
    if (holH > 0) push(earn, 'holiday_double', '國定假日加倍', holH, w, holH * w);
    if (daily) {
      // 2026-11 起：一天超過 8 小時、休息日、例假的加成（時數本身上面已照時薪給，這裡只加多的那段）
      otS = payOtDailySum(Object.assign({}, att.daily, { extra_ot: 0, comp_h: 0 }));
      otPaid = otS.ot_month_h;
      payOtDailyItems(otS, false, 0, w, function (k, l, q, r, a, m) { push(earn, k, l, q, r, a, m); });
      // 計時特休（出勤認定清單 E2）：請特休的時數照有效時薪給（計時本來只按上班時數領錢）
      const ptAnnualH = payNum(payAttLeaves(att).annual);
      if (ptAnnualH > 0) push(earn, 'pt_annual', '特休（計時）', payR2(ptAnnualH), w, ptAnnualH * w);
    }
  }

  const pr = ft ? P : 1;
  if (payNum(e.skill_allow))  push(earn, 'skill_allow', '職能津貼', null, null, payNum(e.skill_allow) * pr);
  if (payNum(e.night_allow))  push(earn, 'night_allow', '夜間津貼', null, null, payNum(e.night_allow) * pr);
  if (payNum(e.mgr_allow))    push(earn, 'mgr_allow', '店長津貼', null, null, payNum(e.mgr_allow) * pr);
  if (payNum(e.editor_allow)) push(earn, 'editor_allow', '小編津貼', null, null, payNum(e.editor_allow));
  // 自訂加薪／扣款（工時分頁逐月填，名稱自訂）
  if (payNum(att.custom_add_amt)) push(earn, 'custom_add', String(att.custom_add_label || '自訂加薪'), null, null, payNum(att.custom_add_amt));
  // 第二筆以後（2026-10-10 Eason：同一人同月要能有多筆自訂加薪，例：8月分紅＋AI種子計畫補助）
  (att.custom_add_more || []).forEach(function (x) {
    if (x && payNum(x.amt)) push(earn, 'custom_add', String(x.label || '自訂加薪'), null, null, payNum(x.amt));
  });
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
  const rateRaw =
    (payNum(e.base) + payNum(e.skill_allow) + payNum(e.night_allow) +
     payNum(e.mgr_allow) + payNum(e.attend_cap)) / payNum(cfg.leave_div_days) / payNum(cfg.leave_div_hours);
  const rate = payR0(rateRaw);
  /* 請假扣款：一律查假別表算，不再逐種假寫死。
   *   扣款率 ＝ rate ×（1 − 給薪比例）：事假 0%→全扣、病假 50%→扣一半、特休 100%→不扣。
   *   年度上限：超過 cap_days 的部分改用 over_ratio（病假逾 30 日→無薪全扣）。
   *   年資門檻：年資未達 tenure_months 者用 under_ratio（產假未滿 6 個月→減半）。
   *   att.leave_usage 帶「本月之前」已用日數，沒帶＝當作 0（單月獨立計算）。 */
  /* 特休未休完折算工資（勞基法§38，2026-08-23 加）
   * 只在「週年期屆滿前一日所在的月份」發一次；折算率用平日每小時工資額（＝下方請假費率同一條）。
   * 計時同仁沒有特休（att.annual 為 null），自然不會進來。 */
  const annualH = att.annual ? payNum(att.annual.payout_h != null ? att.annual.payout_h : att.annual.left_h) : 0;
  if (att.annual && att.annual.payout_ym === ym && annualH > 0) {
    // 折算時薪不先取整（2026-10-05 Eason：39,000÷30÷8＝162.5，不是 163）；只有最後金額四捨五入
    // 2026-11 起（出勤認定清單 E3）：正職改「月工資 ÷30 ÷每日工時」；計時＝有效時薪
    const ah = payR2(annualH);
    const aRate = !payOtDailyOn(ym) ? payR2(rateRaw)
      : (ft ? payR2(MW / PAY_OT_DAY_DIV / (payNum(cfg.daily_hours) || 8)) : payR2(ptWage));
    push(earn, 'annual_payout', '特休未休折算', ah, aRate, ah * aRate);
  }

  /* 遲到分鐘不計薪（Eason 2026-08-23 定案）
   *   正職：(底薪＋職能＋夜間＋店長＋全勤上限) ÷ 30 ÷ 8 ÷ 60 × 當月實際遲到分鐘
   *          全勤上限自 PAY_LATE_ATTEND_FROM（2026-10）起算進基數，全部門市（Eason 2026-11-07）；
   *          之前月份照舊不含（當初理由：全勤已另外因遲到被扣）。
   *   計時：有效時薪 ÷ 60 × 當月實際遲到分鐘（有效時薪＝基本時薪＋滿勤加給＋年資加給，
   *          與他實際領錢的那個時薪同一個，不另立標準）。
   *   遲到「照舊也扣全勤」是 Eason 指定的——這兩件事並存，不是二擇一。
   *   att.late_min 由 payCollect 從核定狀態字串解析（「遲到5分、早退3分」要 split('、')）。
   *   att.xsup_late_min／xsup_early_min＝同組支援門市的遲到／早退分鐘（2026-11 起有，跟著跨店支援自動帶入），
   *   用本店費率一起扣（Eason 2026-11-07）；全勤判斷只看 att.late_min，不含支援門市。 */
  const lateMin = payNum(att.late_min) + payNum(att.xsup_late_min);
  const lateFrom = String(cfg.late_deduct_from || '').trim();
  if (lateMin > 0 && payBool(cfg.late_deduct) && !(lateFrom && String(ym) < lateFrom)) {
    const lateBase = ft
      ? payLateBaseFT(e, ym, cfg)
      : ptWage / 60;
    const lateAmt = payR0(lateBase * lateMin);
    if (lateAmt > 0) push(ded, 'late_deduct', '遲到不計薪', lateMin, payR2(lateBase), lateAmt);
  }
  // 早退比照遲到按分鐘扣（出勤認定清單 B4，2026-11 起）：同一個費率、同一個開關與起始月份
  const earlyMin = payNum(att.early_min) + payNum(att.xsup_early_min);
  if (payOtDailyOn(ym) && earlyMin > 0 && payBool(cfg.late_deduct) && !(lateFrom && String(ym) < lateFrom)) {
    const earlyBase = ft
      ? payLateBaseFT(e, ym, cfg)
      : ptWage / 60;
    const earlyAmt = payR0(earlyBase * earlyMin);
    if (earlyAmt > 0) push(ded, 'early_deduct', '早退不計薪', earlyMin, payR2(earlyBase), earlyAmt);
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
    if (code === 'menstrual' && String(ym) < PAY_MENSTRUAL_FULL_FROM) ratio = 0.5;   // 3 次內全薪從 2026-11 起，之前月份照舊半薪
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
  const out = {
    emp_id: e.emp_id, name: e.name, is_full_time: ft, ratio: P,
    total_hours: payR2(att.hours), support_hours: payR2(supportH),
    base_hours: baseH, surplus_hours: surplus, ot_paid_hours: otPaid,
    earn: earn, ded: ded, gross: gross, deduction: deduct, net: gross - deduct, leave_rate: rate,
    pt_attend: ptAttendInfo,
  };
  if (otS) out.ot_info = { ot_h: otS.ot_month_h, over_cap: otS.ot_month_h > PAY_OT_MONTH_CAP, missing: otS.missing,
    no_show: otS.no_show, rdo: otS.rdo_dates, hol: otS.hol_dates, comp_h: otS.comp_used_h, comp_over_h: otS.comp_over_h,
    manual_sup_h: payNum(att.daily.manual_sup_h) };
  if (otS) {
    const chk = payOtFormCheck_(att);
    out._ot_days = otS.ot_days;   // 給 28 天週期加總（payOtMonthSync_）；不進 run 表
    out.ot_info.ot_form_missing = chk.missing;
    out.ot_info.trip_ot = chk.trip_ot;
    out.ot_info.absent_alert = otS.no_show_streak >= 3 || otS.no_show.length >= 6;
    out.ot_info.absent_streak = otS.no_show_streak;
    out.ot_info.short_8h = ft ? payMztShortDays_(e, att.daily) : [];
    out.ot_info.personal_over_days = payPersonalOverDays_(att, cfg, ltypes);
  }
  return out;
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
  const out = {
    emp_id: run.emp_id, name: run.name, is_full_time: run.is_full_time, ratio: Number(run.ratio),
    total_hours: Number(run.total_hours), support_hours: Number(run.support_hours) || 0, base_hours: Number(run.base_hours),
    surplus_hours: Number(run.surplus_hours), ot_paid_hours: Number(run.ot_paid_hours),
    earn: earn, ded: ded,
    gross: Number(run.gross), deduction: Number(run.deduction), net: Number(run.net),
  };
  const oi = payParseOtInfo(run.ot_info);
  if (oi) out.ot_info = oi;   // 2026-11 起才有；之前的月份回應形狀不變
  return out;
}
function payParseOtInfo(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (e) { return null; }
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

/** 計時全勤津貼是否「實際符合」（Eason 2026-08-23 改成與餐費補助同一套邏輯）：
 *  勾選＝**有這項補助的資格**，實際給不給由系統自動偵測。兩個條件都成立才加。
 *    ①當月時數 ≥ 門檻（預設 100H，`pt_attend_min_hours` 可依門市覆寫）
 *    ②缺勤天數為 0（遲到／早退／忘刷／請假都算在 deduct_days，依假別表的 count_absent）
 *  ⚠ 手動輸入工時的月份 deduct_days 是人工填的，這裡照樣吃那個值——
 *    以前改成純手動就是因為那種月份抓不到缺勤，現在等於「你填 0 就算全勤」，語意一致。
 *  回 { on:是否勾選, qualified:是否符合, hours, deduct_days, min_hours, plus } */
function payPtAttendCheck(att, cfg) {
  const on = payBool(att.full_attend);
  const minH = payCfgNum(cfg, 'pt_attend_min_hours', 100);
  const h = payNum(att.hours);
  const dd = payNum(att.deduct_days);
  const qualified = h >= minH && dd === 0;
  return { on: on, qualified: qualified, hours: h, deduct_days: dd, min_hours: minH,
           plus: (on && qualified) ? payCfgNum(cfg, 'pt_attend_plus', 10) : 0 };
}

/** 狀態字串裡有沒有「真的」遲到／早退。
 *  ⚠ 不能用 indexOf('遲到')——「主管認定不計遲到」也含這兩個字，會被誤判成遲到而扣全勤
 *    （2026-09-01 加那個註記時當場踩到）。狀態是多項用「、」串的，要逐項判**開頭**。 */
function payHasLateEarly(statusText) {
  const parts = String(statusText || '').split('、');
  let late = false, early = false;
  parts.forEach(function (x) {
    const t = String(x).trim();
    if (t.indexOf('遲到') === 0) late = true;
    if (t.indexOf('早退') === 0) early = true;
  });
  return { late: late, early: early, any: late || early };
}

/** 狀態字串裡「第N段下班無打卡／第N段上班無打卡」共幾張（沒有就 0）。
 *  2026-09-29 起取代舊的「少刷N組卡」：**一行＝漏一張卡**，所以回傳的就是張數，
 *  呼叫端不必再乘 2（舊版回傳的是組數）。
 *  ⚠ 刻意不引用 Code.gs 的常數：payHasLateEarly 解析「遲到／早退」也是在這裡寫字面值，
 *    兩邊同一個慣例；真要改字樣，grep '段下班無打卡' 兩檔一起改。
 *  ⚠ 與 payHasLateEarly 同理，要 split('、') 逐項判**結尾**，不能整串 indexOf。 */
function payMissingCards(statusText) {
  let n = 0;
  String(statusText || '').split('、').forEach(function (x) {
    const t = String(x).trim();
    if (/^第.+段(上班|下班)無打卡$/.test(t)) n += 1;
  });
  return n;
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
  // （2026-11-04 夜間 QA）月底到職者（8/31、1/31…）「滿 N 個月」那天該月沒有那一日，用該月最後一天（同 payAddMonthsClamp_）；
  //  ym 當月月底一定 ≥ 那一天，所以年資月數＝曆月差，不再因 eom < 到職日少算一個月。
  const months = (y - hy) * 12 + (m - hm);
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
        if (col) acc[t.code] = (acc[t.code] || 0) + payLeaveQuotaDays_(t.code, r[col], dayH);
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
        acc[code] = (acc[code] || 0) + payLeaveQuotaDays_(code, Number(l['時數']) || 0, dayH);
      });
    });
    // ③ 併入：家庭照顧假（出勤規範 3-11）、生理假都是逾上限的部分才併入
    (ltypes || []).forEach(function (t) {
      if (!t.merge_into) return;
      const u = acc[t.code] || 0;
      if (!u) return;
      const add = (t.cap_days == null) ? u : Math.max(0, u - t.cap_days);
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
  ['menstrual',     '生理假',                    1,   false, true, 3,   'calendar', 0.5, 'sick',    1,    '', '',   'hour', '',  '',   '',   '性平法§14 每月 1 日；全年 3 日不併入病假，超過的併入病假額度（仍半薪）'],
  ['family',        '家庭照顧假',                0,   false, true, 7,   'calendar', 0,   'personal','',   '', '',   'hour', '',  '',   '',   '性平法§20 全年 7 日、併入事假 14 日額度、不給薪'],
  ['funeral8',      '喪假（父母・配偶）',        1,   false, true, 8,   'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '勞工請假規則§3 父母、養父母、繼父母、配偶喪亡：8 日，工資照給；只計工作日、可用小時請'],
  ['funeral6',      '喪假（祖父母・子女・配偶父母）', 1, false, true, 6, 'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '祖父母、子女、配偶之父母／養父母／繼父母喪亡：6 日，工資照給'],
  ['funeral3',      '喪假（曾祖父母・兄弟姊妹）',1,   false, true, 3,   'event',    0,   '',        '',   '', '',   'hour', '',  '',   '',   '曾祖父母、兄弟姊妹、配偶之祖父母喪亡：3 日，工資照給'],
  ['marriage',      '婚假',                      1,   false, true, 14,   'event',    0,   '',        '',   '', '',   'hour', 10,  90,   365,  '勞工請假規則§2 8 日，工資照給；結婚登記日前 10 日起 3 個月內請畢，經雇主同意可延至 1 年'],
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
  let compOff = false;   // 表上有補休列但停用了 → 尊重設定，不補內建列
  rows.forEach(function (r) {
    const code = String(r.code || '').trim();
    if (!code) return;
    if (payBool(r.active) === false && String(r.active).trim() !== '') {
      if (payIsCompType({ code: code, name: r.name }) && (!String(r.store || '').trim() || payStore(r.store) === st)) compOff = true;
      return;
    }
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
  if (list.length) {
    list.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    return compOff ? list : payWithCompType(list);
  }
  return payWithCompType(PAY_LEAVE_DEFAULTS.map(function (d, i) {
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
  }));
}
/** 補休（2026-10-09）：假別表沒有補休這列時，補上程式內建的那列（排最後）——Eason 還沒加表也能請、能算。
 *  表上已經有（code＝comp 或名稱＝補休）就完全以表為準。放最後是為了不影響其他假別名稱的比對順序（payLeaveCode）。 */
function payWithCompType(list) {
  if (list.some(payIsCompType)) return list;
  return list.concat([payCompDefaultType()]);
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
/** 生理假 3 次內全薪的起始月份（出勤規範 3-7）。 */
var PAY_MENSTRUAL_FULL_FROM = '2026-11';
/** 時數換成額度用掉的「日」：生理假看次數不看時數，請 4H 也算一次（Eason 2026-10-23）。 */
function payLeaveQuotaDays_(code, h, dayH) {
  const days = payNum(h) / dayH;
  return (code === 'menstrual' && days > 0) ? Math.ceil(days) : days;
}
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
    const days = payLeaveQuotaDays_(code, l.hours, dayH);
    if (d.slice(0, 4) === year) used[code] = (used[code] || 0) + days;
    const m = d.slice(0, 7);
    if (!perMonth[code]) perMonth[code] = {};
    perMonth[code][m] = (perMonth[code][m] || 0) + days;
  });

  // 併入：家庭照顧假超過 7 日（出勤規範 3-11）、生理假超過 3 次，超過的部分才併入
  const merged = {};
  types.forEach(function (t) {
    if (!t.merge_into) return;
    const u = used[t.code] || 0;
    const cap = t.cap_days;
    const over = (cap == null) ? 0 : Math.max(0, u - cap);
    const add = over;
    if (add > 0) merged[t.merge_into] = (merged[t.merge_into] || 0) + add;
  });

  const out = {};
  types.forEach(function (t) {
    const u = payR2((used[t.code] || 0) + (merged[t.code] || 0));
    let cap = t.cap_days;
    if (t.cap_basis === 'tenure') cap = null;   // 特休額度另由 payAnnualQuota 算，不在這裡擋
    const basis = t.cap_basis || '';
    const remain = (cap == null) ? null : payR2(cap - u);
    // 時數直接由「未取整的天數」換算再四捨五入到一位小數——先把天數取到兩位再 ×8
    // 會出現 44.5H→5.56 天→44.48H 這種誤差（2026-10-05 光復一位同仁事假）
    const uRaw = (used[t.code] || 0) + (merged[t.code] || 0);
    out[t.code] = {
      used_days: u,
      used_h: payR1(uRaw * dayH),
      cap_h: (cap == null) ? null : payR1(cap * dayH),
      remain_h: (cap == null) ? null : payR1((cap - uRaw) * dayH),
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

/* ═══════════════════ 跨店支援自動帶入（2026-11-05，docs/support-auto）═══════════════════
 * 2026-11 起：同仁在「同組其他店」主管已核定的時數，計算時自動帶進跨店支援（auto 列）。
 * 認人＝管理系統「同仁名單 → 打卡對照」快照（payroll_xmap，confirmed 才算），不用姓名。
 * ⚠ 放在 payR0～Handlers 之間（payroll_mock.js 只抽這段）：這裡不准直接用 payStore／payRead／payClockRead，
 *   讀資料一律由 paySupportAuto_（包裝）傳進 paySupportAutoCore_（純函式），本段其餘都是純函式。
 * ⚠ ym < PAY_XSUP_FROM 一律不動作（回 null），輸出與改版前逐欄相同（tests/support-auto-regression.test.js 守）。
 * ⚠ 去重與「本人在本店的帳號」一律比打卡表（clock_ss_id），不比門市代碼（SSLHQ／MZTHQ 與 HQ 共用一份打卡表）。 */
var PAY_XSUP_FROM = '2026-11';
/* 舊手填列只有中文門市名（payroll.html 舊 STORES 下拉＋早期簡寫）→ 薪酬門市代碼。
 * 比對前去掉所有空白。認不出來的一律不猜：該人本月整個不自動帶入（manual_unresolved，spec §7-1）。
 * ⚠「光復」單獨兩字不收：小辛辣光復／墨竹亭光復都叫光復，猜錯就是付錯店。 */
var PAY_SUPPORT_NAME_ALIAS = {
  '小辛辣光復': 'SSLGF', '麻的小辛辣光復': 'SSLGF', '小辛辣新竹光復': 'SSLGF',
  '墨竹亭金山': 'MZTJS', '墨金': 'MZTJS',
  '墨竹亭光復': 'MZTGF', '墨復': 'MZTGF',
  '墨竹亭六張犁': 'MZTLZL',
  '央廚': 'CF', '中央廚房': 'CF',
};
function payXsupOn_(ym) { return String(ym || '') >= PAY_XSUP_FROM; }
function payXsupCode_(v) { return String(v == null ? '' : v).trim().toUpperCase(); }
/** 主檔／工時列的門市（空白＝預設店，與 payStore 同口徑；payStore 不在 mock 切片內所以自己寫） */
function payXsupRowStore_(v) {
  const c = payXsupCode_(v);
  return c || (typeof PAY_DEFAULT_STORE !== 'undefined' ? PAY_DEFAULT_STORE : 'SSLGF');
}
/** 打卡編號比對用（spec 審查 #5）：字串化、去空白、去前導零（Sheets 會把 '007' 轉成數字 7）。xmap 與 approved 兩邊都過這一支。 */
function payXsupId_(v) {
  const t = String(v == null ? '' : v).trim();
  return /^\d+$/.test(t) ? String(t.replace(/^0+(?=\d)/, '')) : t;
}
function payXsupBool_(v) { return v === true || String(v == null ? '' : v).trim().toLowerCase() === 'true'; }
/** 同組判斷（spec §1.1）：任一為 *，或兩者非空且相等。空白＝自己一組。 */
function paySameGroup_(a, b) {
  a = String(a == null ? '' : a).trim(); b = String(b == null ? '' : b).trim();
  if (a === '*' || b === '*') return true;
  return !!a && a === b;
}
/** 門市表 → { 代碼大寫: row } */
function payXsupStoreBy_(stores) {
  const by = {};
  (stores || []).forEach(function (s) { const c = payXsupCode_(s && s.code); if (c) by[c] = s; });
  return by;
}
/** 打卡表的識別：有 clock_ss_id 就用它；預設店留空＝本系統所在試算表；其他店留空＝沒有打卡（回 ''）。 */
function payXsupClockKey_(code, storeBy) {
  const c = payXsupCode_(code), row = storeBy[c];
  const id = row ? String(row.clock_ss_id || '').trim() : '';
  if (id) return 'ID:' + id;
  return c === payXsupRowStore_('') ? 'LOCAL' : '';
}
/** 支援列 → 門市代碼。新列看 code；舊列只有中文名 → 別名表／門市表的名稱／代碼本身。認不出回 ''。 */
function paySupportCode_(s, storeBy) {
  if (!s) return '';
  const c = payXsupCode_(s.code);
  if (c && storeBy[c]) return c;
  const raw = String(s.store == null ? '' : s.store).replace(/\s+/g, '');
  if (!raw) return '';
  if (PAY_SUPPORT_NAME_ALIAS[raw]) return PAY_SUPPORT_NAME_ALIAS[raw];
  const up = raw.toUpperCase();
  if (storeBy[up]) return up;
  const codes = Object.keys(storeBy);
  for (let i = 0; i < codes.length; i++) {
    if (String(storeBy[codes[i]].name || '').replace(/\s+/g, '') === raw) return codes[i];
  }
  return '';
}
/** 空白的支援列（剛按「＋新增支援」還沒填）：不算認不出門市 */
function paySupportBlank_(s) {
  return !s || (!String(s.store == null ? '' : s.store).trim() && !String(s.code == null ? '' : s.code).trim()
    && !payNum(s.hours) && (s.amount === '' || s.amount == null || !payNum(s.amount)));
}
function payXsupIsAuto_(s) { return !!s && (s.auto === true || String(s.auto) === 'true'); }
/** 每人「別家門市核定」可帶入的時數合計（byEmp[].stores，不含跨組與 dup_pay）。過期判斷只看這個，手填怎麼改都不影響。 */
function payXsupAutoSums_(auto) {
  const o = {};
  Object.keys((auto && auto.byEmp) || {}).forEach(function (k) {
    o[k] = payR2((auto.byEmp[k].stores || []).reduce(function (t, x) { return t + payNum(x.hours); }, 0));
  });
  return o;
}
/** 存檔前整理支援列（spec §3.3）：丟掉 auto 列，手填列只留白名單欄位（逐日明細等顯示用欄位不落地）。 */
function paySupportStrip_(list) {
  return (Array.isArray(list) ? list : []).filter(function (s) { return s && typeof s === 'object' && !payXsupIsAuto_(s); })
    .map(function (s) {
      const o = { store: s.store == null ? '' : s.store, hours: s.hours, rate: s.rate, amount: s.amount == null ? '' : s.amount };
      if (s.code != null && String(s.code).trim()) o.code = payXsupCode_(s.code);
      if (s.keep === true || String(s.keep) === 'true') { o.keep = true; o.auto_h = payR2(payNum(s.auto_h)); }
      return o;
    });
}

/** 核定狀態字串「遲到5分、早退12分」→ 分鐘數（多項用「、」串，要逐項比，同 payCollect）。 */
function payLateEarlyMin_(st) {
  const o = { late: 0, early: 0 };
  String(st || '').split('、').forEach(function (part) {
    const m = String(part).match(/^(遲到|早退)(\d+(?:\.\d+)?)分/);
    if (m) o[m[1] === '遲到' ? 'late' : 'early'] += Number(m[2]);
  });
  return o;
}
/** 同組支援門市（會帶入時數的那些，不含跨品牌與 dup_pay）的遲到／早退分鐘合計。
 *  支援門市遲到也按分鐘扣（Eason 2026-11-07）；只進扣款、不進全勤（支援門市出勤不列入全勤，Eason 2026-11-05）。 */
function payXsupLateEarly_(entry) {
  const o = { late: 0, early: 0 };
  ((entry && entry.stores) || []).forEach(function (s) { o.late += payNum(s.late_min); o.early += payNum(s.early_min); });
  return { late: payR2(o.late), early: payR2(o.early) };
}

/**
 * 純函式本體（spec §3.1＋§7-3／5／9／11）。d＝{ xmap, stores, master, approvedMap(code), events(code), tsDate, today, days }。
 * 回 { empty, synced_at, byEmp:{ 本店emp_id: { stores:[{code,name,hours,days,pending_days}], cross:[…], dup:[code] } },
 *      unmapped:[{emp_no,acct_store,emp_id}], dup_pay:[{emp_id,code}], pending:[{emp_id,code,days}] }；ym < 生效月回 null。
 */
function paySupportAutoCore_(ym, home, d) {
  if (!payXsupOn_(ym)) return null;
  home = payXsupCode_(home);
  const storeBy = payXsupStoreBy_(d.stores);
  const homeKey = payXsupClockKey_(home, storeBy);
  const homeGroup = storeBy[home] ? storeBy[home].support_group : '';
  // acct_only 列只給打卡店提醒：不算「已同步」、不進計薪（Fable 複審 #4）
  const xmap = (d.xmap || []).filter(function (r) { return !payXsupBool_(r.acct_only); });
  let synced = '';
  xmap.forEach(function (r) { const t = String(r.synced_at || ''); if (t > synced) synced = t; });
  const out = { empty: !xmap.length, synced_at: synced, byEmp: {}, unmapped: [], dup_pay: [], dup_acct: [], pending: [] };
  // 同一個打卡帳號確認給兩個人（GPT #6）：兩邊都不帶入、列提醒，否則 8H 會發成 16H
  const owners = {};
  xmap.forEach(function (r) {
    if (String(r.state || 'confirmed').trim() !== 'confirmed') return;
    const k = (payXsupClockKey_(r.acct_store, storeBy) || payXsupCode_(r.acct_store)) + '|' + payXsupId_(r.emp_id);
    (owners[k] = owners[k] || {})[String(r.emp_no)] = true;
  });
  // 主檔（在職）依打卡表分：dup_pay 要看「用同一份打卡表的門市」有沒有同一個編號
  const masterByKey = {}, homeMaster = {};   // homeMaster：正規化編號 → 主檔上的原編號
  (d.master || []).forEach(function (m) {
    if (String(m.active).toLowerCase() !== 'true') return;   // 跟正式計薪同一個口徑（GPT #11：空白／1 兩邊都不算在職）
    const st = payXsupRowStore_(m.store), id = payXsupId_(m.emp_id);
    if (st === home) homeMaster[id] = String(m.emp_id == null ? '' : m.emp_id).trim();
    const k = payXsupClockKey_(st, storeBy);
    if (k) (masterByKey[k] = masterByKey[k] || {})[id] = true;
  });
  const mapCache = {}, evCache = {};
  function approvedOf(code, key) {   // { 日期: { 正規化編號: 核定列 } }
    if (mapCache[key]) return mapCache[key];
    const raw = d.approvedMap(code) || {}, o = {};
    Object.keys(raw).forEach(function (day) {
      o[day] = {};
      Object.keys(raw[day] || {}).forEach(function (id) { o[day][payXsupId_(id)] = raw[day][id]; });
    });
    mapCache[key] = o;
    return o;
  }
  function pendingOf(code, key) {   // { emp_id: { 日期: true } }：本月有打卡、但主管還沒核定的日子
    if (evCache[key]) return evCache[key];
    const amap = approvedOf(code, key), o = {};
    (d.events ? (d.events(code) || []) : []).forEach(function (e) {
      const day = d.tsDate(e.ts);
      if (String(day).slice(0, 7) !== ym || (d.today && day >= d.today)) return;
      const id = payXsupId_(e.emp_id);
      if (amap[day] && amap[day][id]) return;
      (o[id] = o[id] || {})[day] = true;
    });
    evCache[key] = o;
    return o;
  }
  const groups = {};
  xmap.forEach(function (r) {
    if (payXsupCode_(r.pay_store) !== home) return;
    const state = String(r.state || 'confirmed').trim();
    if (state === 'suggested') { out.unmapped.push({ emp_no: String(r.emp_no), acct_store: payXsupCode_(r.acct_store), emp_id: String(r.emp_id) }); return; }
    if (state !== 'confirmed') return;
    (groups[String(r.emp_no)] = groups[String(r.emp_no)] || []).push(r);
  });
  Object.keys(groups).forEach(function (no) {
    const accts = groups[no];
    const isHome = function (r) {
      const k = payXsupClockKey_(r.acct_store, storeBy);
      return homeKey ? k === homeKey : payXsupCode_(r.acct_store) === home;
    };
    const mine = accts.filter(function (r) { return isHome(r) && homeMaster[payXsupId_(r.emp_id)]; })[0];
    if (!mine) return;   // 本店主檔找不到本人：不帶入（spec §3.1-2）
    const empId = homeMaster[payXsupId_(mine.emp_id)];
    const entry = { stores: [], cross: [], dup: [] };
    const seen = {};
    accts.forEach(function (r) {
      if (isHome(r)) return;                         // 本店（含共用同一份打卡表的門市）＝不是支援
      if (payXsupBool_(r.not_support)) return;       // 個人例外（例：總部薪資、央廚打卡且已 Mirror）
      const S = payXsupCode_(r.acct_store), key = payXsupClockKey_(S, storeBy);
      if (!key || key === homeKey) return;
      const eid = payXsupId_(r.emp_id);
      if (Object.keys(owners[key + '|' + eid] || {}).length > 1) {
        if (!seen[key + '|' + eid]) out.dup_acct.push({ emp_id: empId, code: S, acct: String(r.emp_id) });
        seen[key + '|' + eid] = true;
        return;
      }
      if (seen[key + '|' + eid]) return;             // 共用打卡表：同一份表同一個帳號只算一次（§7-5）
      seen[key + '|' + eid] = true;
      const amap = approvedOf(S, key);
      let hours = 0, late = 0, early = 0; const days = [];
      Object.keys(amap).sort().forEach(function (day) {
        if (String(day).slice(0, 7) !== ym || (d.until && day > d.until)) return;
        const rec = amap[day][eid];
        if (!rec) return;
        const le = payLateEarlyMin_(rec.status_text);
        late += le.late; early += le.early;
        const h = payNum(rec.approved_hours);
        if (!h) return;
        hours += h;
        if (d.days) days.push({ date: day, periods: String(rec.periods || ''), hours: payR2(h), manager_name: String(rec.manager_name || '') });
      });
      const pend = Object.keys(pendingOf(S, key)[eid] || {}).length;
      const row = { code: S, name: String((storeBy[S] || {}).name || S), hours: payR2(hours), pending_days: pend,
                    late_min: payR2(late), early_min: payR2(early) };
      if (d.days) row.days = days;
      if (pend) out.pending.push({ emp_id: empId, code: S, days: pend });
      if (!paySameGroup_(homeGroup, (storeBy[S] || {}).support_group)) { entry.cross.push(row); return; }
      if ((masterByKey[key] || {})[eid]) {           // 打卡店主檔也有他＝會被付兩次 → 不帶入、列待處理（§7-11）
        entry.dup.push(S); out.dup_pay.push({ emp_id: empId, code: S, hours: row.hours });
        return;
      }
      entry.stores.push(row);
    });
    out.byEmp[empId] = entry;
  });
  return out;
}

/** 跨品牌打卡、本店（打卡店 S）沒有主檔的人（spec §3.4 cross_no_master，在 S 端看）。純函式，d 同上。 */
function payCrossIncomingCore_(ym, S, d) {
  if (!payXsupOn_(ym)) return [];
  S = payXsupCode_(S);
  const storeBy = payXsupStoreBy_(d.stores);
  const sKey = payXsupClockKey_(S, storeBy), sGroup = (storeBy[S] || {}).support_group;
  if (!sKey || !String(sGroup == null ? '' : sGroup).trim()) return [];
  const have = {};
  (d.master || []).forEach(function (m) {
    if (String(m.active).toLowerCase() !== 'true') return;
    if (payXsupClockKey_(payXsupRowStore_(m.store), storeBy) === sKey) have[payXsupId_(m.emp_id)] = true;
  });
  let amap = null;
  const out = [], seen = {};
  (d.xmap || []).forEach(function (r) {
    if (String(r.state || 'confirmed').trim() !== 'confirmed' || payXsupBool_(r.not_support)) return;
    if (payXsupClockKey_(r.acct_store, storeBy) !== sKey) return;
    const P = payXsupCode_(r.pay_store), pGroup = (storeBy[P] || {}).support_group;
    if (payXsupClockKey_(P, storeBy) === sKey) return;
    if (!String(pGroup == null ? '' : pGroup).trim() || paySameGroup_(pGroup, sGroup)) return;
    const eid = payXsupId_(r.emp_id);
    if (have[eid] || seen[eid]) return;
    if (!amap) {
      const raw = d.approvedMap(S) || {};
      amap = {};
      Object.keys(raw).forEach(function (day) { amap[day] = {}; Object.keys(raw[day] || {}).forEach(function (id) { amap[day][payXsupId_(id)] = raw[day][id]; }); });
    }
    let h = 0;
    Object.keys(amap).forEach(function (day) {
      if (String(day).slice(0, 7) === ym && amap[day][eid]) h += payNum(amap[day][eid].approved_hours);
    });
    if (!h) return;
    seen[eid] = true;
    out.push({ emp_id: String(r.emp_id).trim(), pay_store: P, hours: payR2(h) });
  });
  return out;
}

/**
 * 一位同仁的支援列合併（spec §3.2＋§7-1／2／12）。純函式。
 * support＝工時列（或前端送來）的支援陣列；entry＝paySupportAutoCore_ 的 byEmp[emp]（可為 undefined）；e＝主檔列。
 * ctx＝{ home, storeBy }。回 { support, diffs, unresolved, cross }。
 * ·auto 列一律先丟掉再重算（舊頁面送上來的凍結值不算數）。
 * ·有任一手填列認不出門市 → 整個人不帶入（unresolved）。
 * ·手填列的門市與本店不同組 → cross（前端標紅擋存檔／重算）；兩邊都還沒設 support_group 時不判（上線過渡期不誤擋）。
 * ·有手填且時數相同 → 不動；不同 → 不動、列差異（keep＋auto_h＝這次打卡值 → 不再提醒）；沒有手填 → 加 auto 列。
 * ·費率（4B）：正職＝主檔 ot_rate；計時＝主檔 wage（不含本月 wage_override 與加給）。
 */
function payMergeSupport_(support, entry, e, ctx) {
  const manual = (support || []).filter(function (s) { return !payXsupIsAuto_(s); });
  const out = { support: manual.slice(), diffs: [], unresolved: false, cross: [] };
  const storeBy = ctx.storeBy || {}, home = payXsupCode_(ctx.home);
  const homeGroup = String((storeBy[home] || {}).support_group || '').trim();
  let unresolved = false;
  const codes = manual.map(function (s) {
    if (paySupportBlank_(s)) return '';
    const c = paySupportCode_(s, storeBy);
    if (!c) unresolved = true;
    return c;
  });
  const isCross = codes.map(function (c) {
    if (!c || c === home) return false;
    const g = String((storeBy[c] || {}).support_group || '').trim();
    return !!(homeGroup && g && !paySameGroup_(homeGroup, g));
  });
  codes.forEach(function (c, i) { if (isCross[i] && out.cross.indexOf(c) < 0) out.cross.push(c); });
  /* 跨品牌手填列不計（審查 #3）：2026-11 起由打卡那家店發薪，原店再算就付兩次。
     ctx.dropCross（＝對照已同步）才剔除；剔除的列放 crossRows，畫面另外標紅給人移除。 */
  if (ctx.dropCross) {
    out.crossRows = manual.filter(function (s, i) { return isCross[i]; });
    out.support = manual.filter(function (s, i) { return !isCross[i]; });
  }
  if (unresolved) { out.unresolved = true; return out; }
  if (!entry || !e) return out;
  const ft = String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true;
  const rate = ft ? payNum(e.ot_rate) : payNum(e.wage);
  (entry.stores || []).forEach(function (a) {
    const idx = [];
    codes.forEach(function (c, i) { if (c === a.code) idx.push(i); });
    if (!idx.length) {
      if (payNum(a.hours) > 0) out.support.push({ code: a.code, store: a.name, hours: payR2(a.hours), rate: rate, amount: '', auto: true });
      return;
    }
    const mh = payR2(idx.reduce(function (t, i) { return t + payNum(manual[i].hours); }, 0));
    const ah = payR2(a.hours);
    if (mh === ah) return;
    const kept = idx.every(function (i) {
      const s = manual[i];
      return (s.keep === true || String(s.keep) === 'true') && s.auto_h !== '' && s.auto_h != null && payR2(payNum(s.auto_h)) === ah;
    });
    if (kept) return;
    out.diffs.push({ code: a.code, name: a.name, manual: mh, auto: ah });
  });
  return out;
}

/**
 * 把自動帶入套到整份工時（payroll_month／payroll_inputs 顯示用，也給計算用）。純函式。
 * inputs＝{emp:{…support}}（就地改 support）；master＝本店主檔列；auto＝paySupportAutoCore_ 的結果；
 * incoming＝payCrossIncomingCore_ 的結果。回 support_auto（前端提醒列與逐日明細用）。
 */
function payApplySupportAuto_(inputs, master, auto, ctx, incoming) {
  const sa = { synced_at: auto.synced_at, empty: auto.empty, diffs: [], auto_h: payXsupAutoSums_(auto), pending_days: auto.pending.slice(),
               unmapped: auto.unmapped.slice(), detail: {},
               warn: { manual_unresolved: [], cross_manual: [], dup_pay: auto.dup_pay.slice(), dup_acct: (auto.dup_acct || []).slice(), cross_no_master: incoming || [], support_error: [] } };
  const mBy = {};
  (master || []).forEach(function (m) { mBy[String(m.emp_id).trim()] = m; });
  const ids = {};
  Object.keys(inputs).forEach(function (k) { ids[k] = true; });
  Object.keys(auto.byEmp).forEach(function (k) { if (mBy[k]) ids[k] = true; });
  Object.keys(ids).forEach(function (emp) {
    const e = mBy[String(emp).trim()];
    const A = inputs[emp] || (inputs[emp] = { hours: 0, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0, disaster_h: 0,
                                             annual_h: 0, deduct_days: 0, work_days: 0, support: [] });
    if (A.support_error) { sa.warn.support_error.push(emp); return; }   // 支援欄壞掉的人一律不帶入（前端會擋存檔；審查 #2）
    const ent = auto.byEmp[String(emp).trim()];
    const r = payMergeSupport_(A.support || [], ent, e, ctx);
    // 畫面用：剔除的跨品牌列照樣放回去、標 cross（存檔時 paySupportStrip_ 會去掉這個標記；前端標紅擋存檔）
    const shown = r.support.concat((r.crossRows || []).map(function (x) { return Object.assign({}, x, { cross: true }); }));
    if (A.support !== undefined || shown.length) A.support = shown;   // 沒有支援欄的人不多塞一個空陣列（輸出與改版前相同）
    if (r.unresolved) sa.warn.manual_unresolved.push(emp);
    r.cross.forEach(function (c) { sa.warn.cross_manual.push({ emp_id: emp, code: c }); });
    r.diffs.forEach(function (x) { sa.diffs.push({ emp_id: emp, code: x.code, name: x.name, manual: x.manual, auto: x.auto }); });
    if (ent) (ent.stores || []).concat(ent.cross || []).forEach(function (s) {
      if (s.days) (sa.detail[emp] = sa.detail[emp] || {})[s.code] = { name: s.name, hours: s.hours, days: s.days };
    });
  });
  return sa;
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
  if (!payReplaceKeep_('master', function (m) { return payStore(m.store) !== stMs; }, mine)) return PAY_BUSY_;
  return { ok: true, count: mine.length, store: stMs };
}

function handlePayrollConfigSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const stC = String(body.store || '');   // 空白＝寫集團預設；有值＝寫該門市覆寫
  const rows = Object.keys(body.config || {}).map(function (k) {
    return { key: k, value: String(body.config[k]), note: '', store: stC };
  });
  if (!rows.length) return { ok: false, error: 'config_required' };
  /* 單項儲存（2026-10-10 Eason：「只套用到目前門市要一次單獨儲存一項，不要全部項目連動」）：
     帶 keys:true 時只換送來的這幾個鍵，同一 scope 的其他參數原樣保留。
     不帶＝舊行為（整批覆寫該 scope），setMode 等舊呼叫不受影響。 */
  if (body.keys === true) {
    const ks = {};
    rows.forEach(function (r) { ks[r.key] = true; });
    if (!payReplaceKeep_('config', function (r) {
      return !(String(r.store || '') === stC && ks[r.key]);
    }, rows)) return PAY_BUSY_;
    return { ok: true, keys: Object.keys(ks), store: stC };
  }
  if (!payReplaceKeep_('config', function (r) { return String(r.store || '') !== stC; }, rows)) return PAY_BUSY_;
  return { ok: true };
}

function handlePayrollHolidaySet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.holidays)) return { ok: false, error: 'holidays_required' };
  const stH = String(body.store || '');   // 空白＝集團共用；有值＝該門市專屬
  const mine = body.holidays.map(function (h) { h.store = stH; return h; });
  if (!payReplaceKeep_('holiday', function (h) { return String(h.store || '') !== stH; }, mine)) return PAY_BUSY_;
  return { ok: true, count: mine.length, store: stH };
}

/** 人事行政總處「中華民國政府行政機關辦公日曆表」（政府資料開放平臺 dataset 14718）。
 *  回該年所有放假日（含週末）與備註；只讀不寫。
 *  ⚠ 這個 CSV 沒有跨網域授權（CORS），瀏覽器抓不到，所以一定要由後端代抓。
 *  ⚠ 每年的檔案網址不固定（還會出「更新版」），一律先查資料集的檔案清單再挑，不可寫死網址。
 *  CSV 欄位：西元日期(yyyymmdd)／星期／是否放假(2＝放假、0＝上班)／備註。 */
function payGovCalendar(year) {
  year = Number(year);
  if (!(year >= 2017 && year <= 2100)) return { ok: false, error: 'bad_year' };
  const roc = year - 1911, cacheKey = 'govcal_' + year;
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  try {
    const meta = JSON.parse(UrlFetchApp.fetch('https://data.gov.tw/api/v2/rest/dataset/14718',
      { muteHttpExceptions: true }).getContentText());
    const dist = ((meta.result || meta).distribution || []).filter(function (d) {
      const t = String(d.resourceDescription || '');
      return t.indexOf(roc + '年') === 0 && t.indexOf('辦公日曆表') >= 0 && t.indexOf('Google') < 0
        && String(d.resourceFormat || '').toUpperCase() === 'CSV';
    });
    if (!dist.length) return { ok: false, error: 'not_published',
      message: '人事行政總處還沒公布 ' + year + ' 年（民國 ' + roc + ' 年）的辦公日曆表' };
    // 同一年有「更新版」時取上傳月份最新的那份（網址裡的 dgpa/files/YYYYMM/）
    const upAt = function (d) { const m = String(d.resourceDownloadUrl || '').match(/files\/(\d{6})\//); return m ? m[1] : ''; };
    const pick = dist.reduce(function (a, b) { return upAt(b) >= upAt(a) ? b : a; });
    const blob = UrlFetchApp.fetch(pick.resourceDownloadUrl, { muteHttpExceptions: true }).getBlob();
    let txt = blob.getDataAsString('UTF-8');
    if (txt.indexOf('西元日期') < 0) txt = blob.getDataAsString('Big5');   // 舊年度的檔案是 Big5
    const days = [];
    txt.replace(/^﻿/, '').split(/\r?\n/).forEach(function (line) {
      const c = line.split(',');
      const m = String(c[0] || '').trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (!m || String(c[2] || '').trim() !== '2') return;
      days.push({ date: m[1] + '-' + m[2] + '-' + m[3], week: String(c[1] || '').trim(),
                  note: String(c[3] || '').trim() });
    });
    if (!days.length) return { ok: false, error: 'parse_failed', message: '人事行政總處的檔案讀不懂（格式可能改了）' };
    const out = { ok: true, year: year, title: String(pick.resourceDescription || ''), source: pick.resourceDownloadUrl, days: days };
    try { cache.put(cacheKey, JSON.stringify(out), 21600); } catch (e) {}   // 6 小時；太大放不進去就算了
    return out;
  } catch (e) {
    Logger.log('payGovCalendar: ' + e);
    return { ok: false, error: 'fetch_failed', message: '連不上人事行政總處的資料：' + String(e.message || e) };
  }
}
function handlePayrollGovHolidays(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return payGovCalendar(body.year);
}

/* 紅字天數整年自動同步（2026-09-18 Eason：「直接帶入整年度，不用再手動輸入」）。
 * 規則（動任何一條前先讀 skill 的「紅字天數」一節）：
 *  - 紅字天數＝行事曆上該月「是否放假=2」的天數（含週末、補假、調整放假）；Eason 手填的 5～9 月逐月與此相同。
 *  - 國定假日雙薪日期（Eason 2026-09-18 定案：「有國定假日跟補假，雙薪以補假日期為主」）：
 *      節日落在平日 → 節日當天；節日落在週末且有對應補假 → 改算補假那天（節日當天不算）；
 *      落在週末卻找不到補假 → 保留節日當天（不讓雙薪憑空消失）。調整放假不算。
 *    ⚠ 法律上這是「調移」，需同仁本人同意（勞動部）；同意書由公司處理，程式只照規則算。
 *  - 只動「集團共用」列（store 空白）；本店專屬列照舊優先、不碰。
 *  - ⚠ 只改「本月與未來」的月份；已經過去的月份若已存在就不動——那些月份多半已發薪，
 *    回頭改紅字天數或加國定假日，重算就會改到已發的錢。缺的過去月份才補（且不早於 PAY_HOL_SYNC_FROM）。
 *  - ⚠ 國定假日雙薪 2026-08-22 才上線，PAY_HOL_DOUBLE_FROM 之前的月份不寫日期（比照遲到規則「8 月起生效、不回頭」）。 */
const PAY_HOL_SYNC_FROM = '2026-05';     // 薪酬系統第一個月；更早的月份不建列（建了會被自動試算出一堆空的薪資）
const PAY_HOL_DOUBLE_FROM = '2026-08';   // 國定假日計時雙薪的生效月份
const PAY_HOL_NOT_HOLIDAY = /補假|調整放假/;   // 不是節日本身
const PAY_HOL_COMP = /補假/;                  // 公務機關的補假日

/** 算出雙薪日期：回 { dates:[…], moved:{節日:補假日} }。
 *  配對＝每個週末節日找「前後 7 天內、還沒被配走、最近的」補假（週六補前一個上班日、週日補後一個，連假會往後推）。
 *  extraComp＝鄰近年度的補假（元旦逢週六時補假在前一年 12/31），只拿來配對、不加進本年日期。 */
function payHolidayDoublePlan(days, extraComp) {
  const dn = function (s) { const p = String(s).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; };
  const weekend = function (s) { const w = new Date(dn(s) * 86400000).getUTCDay(); return w === 0 || w === 6; };
  const comp = days.filter(function (d) { return PAY_HOL_COMP.test(d.note || ''); }).map(function (d) { return d.date; });
  const pool = comp.concat(extraComp || []), used = {}, moved = {}, dates = comp.slice();
  days.filter(function (d) { return d.note && !PAY_HOL_NOT_HOLIDAY.test(d.note); })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; })
    .forEach(function (h) {
      if (!weekend(h.date)) { dates.push(h.date); return; }
      let best = null;
      pool.forEach(function (c) {
        if (used[c]) return;
        const g = Math.abs(dn(c) - dn(h.date));
        if (g <= 7 && (!best || g < best.g)) best = { c: c, g: g };
      });
      if (best) { used[best.c] = true; moved[h.date] = best.c; } else dates.push(h.date);
    });
  return { dates: dates.filter(function (d, i, a) { return a.indexOf(d) === i; }).sort(), moved: moved };
}

function payHolidayGovRows(cal, extraComp) {
  const by = {};
  for (let m = 1; m <= 12; m++) {
    const ym = cal.year + '-' + ('0' + m).slice(-2);
    by[ym] = { ym: ym, red_days: 0, note: '依人事行政總處' + cal.title, dates: [] };
  }
  (cal.days || []).forEach(function (d) { const r = by[String(d.date).slice(0, 7)]; if (r) r.red_days++; });
  const plan = payHolidayDoublePlan(cal.days || [], extraComp);
  plan.dates.forEach(function (d) { const r = by[d.slice(0, 7)]; if (r && r.ym >= PAY_HOL_DOUBLE_FROM) r.dates.push(d); });
  Object.keys(by).forEach(function (k) { by[k].dates = by[k].dates.sort().join(', '); });
  return { rows: by, moved: plan.moved };
}

function payHolidaySync(years, operator) {
  const nowYm = currentYmTaipei();
  const status = [], names = {}, want = {}, moved = {};
  (years || []).forEach(function (y) {
    const cal = payGovCalendar(y);
    if (!cal.ok) { status.push({ year: Number(y), ok: false, error: cal.error, message: cal.message }); return; }
    status.push({ year: cal.year, ok: true, title: cal.title });
    (cal.days || []).forEach(function (d) { if (d.note) names[d.date] = d.note; });
    // 元旦逢週六 → 補假在前一年 12/31，要拿前一年的行事曆來配對，否則元旦當天會被當成「找不到補假」而重複算
    let extra = [];
    const edge = (cal.days || []).some(function (d) {
      return d.note && !PAY_HOL_NOT_HOLIDAY.test(d.note) && String(d.date).slice(5) <= '01-07';
    });
    if (edge) {
      const prev = payGovCalendar(Number(y) - 1);
      if (prev.ok) extra = prev.days.filter(function (d) {
        return PAY_HOL_COMP.test(d.note || '') && String(d.date).slice(5) >= '12-25';
      }).map(function (d) { return d.date; });
    }
    const plan = payHolidayGovRows(cal, extra);
    Object.keys(plan.moved).forEach(function (h) { moved[h] = plan.moved[h]; });
    Object.keys(plan.rows).forEach(function (k) { if (k >= PAY_HOL_SYNC_FROM) want[k] = plan.rows[k]; });
  });
  const all = payRead('holiday'), changed = [];
  const out = all.map(function (r) {
    const k = String(r.ym);
    if (String(r.store || '') !== '' || !want[k]) return r;
    const w = want[k]; delete want[k];
    if (k < nowYm) return r;   // 已經過去且已存在的月份不動
    const same = payNum(r.red_days) === w.red_days && payHolidayDates(r).join(', ') === w.dates;
    if (same) return r;
    changed.push(k);
    return { ym: k, red_days: w.red_days, note: w.note, dates: w.dates, store: '' };
  });
  Object.keys(want).sort().forEach(function (k) {   // 還沒有的月份：補上
    const w = want[k];
    out.push({ ym: k, red_days: w.red_days, note: w.note, dates: w.dates, store: '' });
    changed.push(k);
  });
  if (changed.length) {
    payReplaceAll('holiday', out);
    payAppend('audit', [{ ts: nowTaipeiIso(), ym: '', action: 'holiday_sync', operator: String(operator || 'auto'),
      reason: '依人事行政總處辦公日曆表更新紅字天數：' + changed.join('、'), store: '' }]);
  }
  return { status: status, names: names, moved: moved, changed: changed };
}

function handlePayrollHolidaySync(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const years = (Array.isArray(body.years) ? body.years : [body.year])
    .map(Number).filter(function (y, i, a) { return y >= 2017 && y <= 2100 && a.indexOf(y) === i; });
  if (!years.length) return { ok: false, error: 'bad_year' };
  const r = payHolidaySync(years, body.operator);
  return { ok: true, changed: r.changed, status: r.status, names: r.names, moved: r.moved,
           sync_from: PAY_HOL_SYNC_FROM, double_from: PAY_HOL_DOUBLE_FROM,
           holidays: payHolidayList(payStore(body.store)) };
}

/** 只歸集不計算——讓管理者先看工時對不對，再按計算 */
/** 讀 payroll_input 分頁的手動工時覆蓋（某月）→ {emp_id:{hours,extra_ot,...,support:[]}} */
function paySavedInputs(ym, store) {
  const st = payStore(store);
  const out = {};
  payRead('input').forEach(function (r) {
    if (String(r.ym) !== ym) return;
    if (payStore(r.store) !== st) return;
    /* 跨店支援是 JSON 字串存在儲存格裡。原本寫 `catch(e){ sup=[] }` **靜默吞掉**——
       只要字串壞掉（手動編輯、貼上智慧引號、被 Sheets 自動判型、截斷），支援時數就無聲無息
       變成 0，薪水少算幾萬也沒有任何提示；更糟的是下一次「儲存工時」會把這個空值寫回去，
       原始資料永久消失。改為：記下原始值與錯誤，回傳 support_error 讓前端擋下並顯示。 */
    var sup = [], supErr = '';
    if (r.support !== '' && r.support != null) {
      try {
        sup = JSON.parse(r.support);
        if (!Array.isArray(sup)) { supErr = '不是陣列格式'; sup = []; }
      } catch (e) {
        supErr = '無法解析';
        sup = [];
        try {
          Logger.log('⚠ payroll_input 支援時數解析失敗 ym=' + r.ym + ' emp=' + r.emp_id
                     + ' store=' + r.store + ' 原值=' + String(r.support).slice(0, 200));
        } catch (e2) { /* Logger 在某些執行環境不存在，不能因此讓整支掛掉 */ }
      }
    }
    // 第二筆以後的自訂加薪（JSON），比照支援時數：解析失敗要回報、不可靜默歸零
    var addMore = [], addMoreErr = '';
    if (r.custom_add_more !== '' && r.custom_add_more != null) {
      try {
        addMore = JSON.parse(r.custom_add_more);
        if (!Array.isArray(addMore)) { addMoreErr = '不是陣列格式'; addMore = []; }
      } catch (e) {
        addMoreErr = '無法解析'; addMore = [];
        try { Logger.log('⚠ payroll_input 自訂加薪解析失敗 ym=' + r.ym + ' emp=' + r.emp_id + ' 原值=' + String(r.custom_add_more).slice(0, 200)); } catch (e2) {}
      }
    }
    out[String(r.emp_id)] = {
      hours: payNum(r.hours), extra_ot: payNum(r.extra_ot),
      personal_h: payNum(r.personal_h), sick_h: payNum(r.sick_h), menstrual_h: payNum(r.menstrual_h), disaster_h: payNum(r.disaster_h), annual_h: payNum(r.annual_h),
      deduct_days: payNum(r.deduct_days), support: sup, support_error: supErr, full_attend: payBool(r.full_attend),
      work_days: payNum(r.work_days), wage_override: payNum(r.wage_override), meal_on: payBool(r.meal_on),
      holiday_h: (r.holiday_h === '' || r.holiday_h == null) ? '' : payNum(r.holiday_h),
      custom_add_label: String(r.custom_add_label||''), custom_add_amt: payNum(r.custom_add_amt),
      custom_add_more: addMore, custom_add_more_error: addMoreErr,
      custom_ded_label: String(r.custom_ded_label||''), custom_ded_amt: payNum(r.custom_ded_amt),
      dorm_override: (r.dorm_override === '' || r.dorm_override == null) ? '' : payNum(r.dorm_override),
    };
    // 「僅 support」列（hours_manual='0'，只有 payroll_support_decide 會建）：只帶支援欄，本店時數照打卡歸集。
    // 舊列 hours_manual 空白＝整筆手動，物件形狀與改版前完全相同（不多一個欄位）。
    if (String(r.hours_manual == null ? '' : r.hours_manual).trim() === '0') out[String(r.emp_id)]._support_only = true;
  });
  return out;
}

/** 只能由打卡核定算出來的欄位：手動列（payroll_input）沒有這些欄，整筆取代時必須 fallback 回歸集值。
 *  ⚠ 新增這類欄位（來源是 payCollect、schema 沒有對應欄）時要一起加進來，否則會靜靜歸零。 */
const PAY_PUNCH_ONLY_NUM = ['late_min', 'early_min', 'forget_punch', 'forget_day'];

/** 工時基底＝打卡歸集(payCollect) 疊上手動覆蓋(payroll_input)；saved 有該員就整筆蓋掉歸集值，
 *  但 PAY_PUNCH_ONLY_NUM 與 attend_void 例外（見函式內註解）。
 *  供「工時分頁顯示」與「計算」共用，確保兩邊一致。
 *  cutoffDate（'YYYY-MM-DD'，選填，T15 估算端點用）：透傳給 payCollect，只影響「打卡歸集」
 *  那一半；payroll_input 手動覆蓋本來就沒有日期粒度（管理者存檔當下就是整月一筆），不受影響。
 *  既有唯一呼叫路徑 handlePayrollCalc 不傳第三參數，行為不變。 */
function payInputsBase(ym, store, cutoffDate) {
  const st = payStore(store);
  const holRow = payHolidayRow(ym, st);
  const holDates = payHolidayDates(holRow);
  const cfgSt = payConfig(st);
  const base = payCollect(ym, cfgSt.meal_min_hours, st, holDates, cutoffDate);
  const saved = paySavedInputs(ym, st);
  /* 每日倒扣只算請假日的門市（央廚／總部，2026-10-10）：有打卡資料的人，缺勤天數一律取歸集值。
     手動列存的 deduct_days 是按「儲存工時」當下、用舊口徑（忘刷／遲到也算）算出的快照，
     沿用會讓忘刷那天照樣扣 100（陳建樺 2026-09 實例：手動列 1 天、新口徑 0 天）。
     沒有打卡資料的人（純手動月份）照舊用手填值。 */
  const leaveOnly = payPerfLeaveOnly_(st, ym, cfgSt);
  Object.keys(saved).forEach(function (emp) {
    const col = base[emp] || {}, sv = saved[emp];
    if (sv._support_only) {   // 僅 support 列：本店時數不凍結（spec §7-4），只換支援欄
      const keep = base[emp] || {};
      keep.support = sv.support; keep.support_error = sv.support_error;
      base[emp] = keep;
      return;
    }
    // 整筆手動列（2026-11 起）：標給前端看，存檔時不可以因為「數值全 0」就略過（GPT #2：人工填 0 的會被刪掉、改發打卡工時）
    if (payXsupOn_(ym)) sv._manual = true;
    // 國定假日時數：手動工時沒填就沿用打卡歸集出來的值
    //（這個欄位是後加的，先前存過的月份都是空白，不 fallback 會全部變 0）
    if (sv.holiday_h === '' || sv.holiday_h == null) sv.holiday_h = payNum(col.holiday_h);
    /* ⚠ 打卡才算得出來的四個欄位一律 fallback 回歸集值（2026-09-03 修）。
       payroll_input 的 schema 根本沒有這幾欄（paySavedInputs／handlePayrollInputSet 都沒寫），
       所以「整筆取代」會讓它們全部變 0/false —— 而 handlePayrollCalc 的 collected 就是本函式，
       結果是**只要那個月按過一次「儲存工時」，遲到不計薪與忘刷／遲到門檻歸零就全部失效**。
       實例：光復 2026-08 打卡有遲到（3／3／8 分）但薪資明細一筆 late_deduct 都沒有。
       這幾欄的正本永遠是打卡核定，手動列不可能有更好的值，所以無條件取歸集值，
       不像 hours／deduct_days 那樣「手動優先」。 */
    PAY_PUNCH_ONLY_NUM.forEach(function (k) { sv[k] = payNum(col[k]); });
    sv.attend_void = !!col.attend_void;
    // （2026-11-04 夜間 QA）leaves（家庭照顧／婚／喪／公傷…）與 other_h 同樣只有歸集值、payroll_input 沒這欄：
    //  整筆取代會讓它們消失（扣款與抵不足時數都算錯），所以一律取歸集值，重算結果與沒存檔前一致。
    sv.leaves = col.leaves || {};
    sv.other_h = payNum(col.other_h);
    if (leaveOnly && base[emp]) sv.deduct_days = payNum(col.deduct_days);
    // 2026-11 起逐日加班：每天的核定／請假時數只有打卡算得出來（手動列沒有日期）；
    // 病假 30 天內不扣全勤也改了缺勤天數的算法，有打卡資料的人一律取歸集值
    if (payOtDailyOn(ym)) {
      sv.day_h = col.day_h || {}; sv.day_leave = col.day_leave || {};
      if (base[emp]) sv.deduct_days = payNum(col.deduct_days);
    }
    base[emp] = sv;
  });
  return base;
}

function handlePayrollInputs(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const st = payStore(body.store);
  const inputs = payInputsBase(ym, st);
  const master = payRead('master').filter(function (m) { return payStore(m.store) === st; });
  const res = { ok: true, ym: ym, store: st, inputs: inputs, master: master };
  const sa = payXsupApply_(ym, st, inputs, false);   // 不產逐日明細（spec §7-10）
  if (sa) res.support_auto = sa;
  return res;
}

/** 儲存/覆蓋某月手動工時；inputs 空＝清除該月手動覆蓋（還原成打卡歸集）。 */
function handlePayrollInputSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const inputs = body.inputs || {};
  const now = nowTaipeiIso();
  // ⚠ 2026-08-24 修：本支原本**完全沒有門市概念**——寫入不帶 store、刪除只比 ym。
  //   後果：在 A 店按一次「儲存工時」，會把同月**所有門市**的手動工時整批刪掉，
  //   而寫進去的列 store 空白（＝payStore('') 回 SSLGF）又被當成光復的資料。
  //   實際事故：央廚存 2026-07 工時 → 光復 7 月的工時與跨店支援（72H／93H）被洗掉，
  //   央廚自己的 13 筆卻讀不回來（讀取端有 store 過濾）。
  //   十一支整批覆寫的 handler 裡，只有這支漏了門市過濾——與 master／config／run／item
  //   ／bonus／leave_* 的寫法對齊即可。
  const st = payStore(body.store);
  const xsup = payXsupOn_(ym);
  /* 審查 #1（2026-11-05）：本店打卡歸集裡沒有這個人（只在別店有時數）時，畫面上的 hours:0＋auto 列
     不可以存成「整筆手動」——存了之後本店核定就流不進來。2026-11 起：
       ·其他欄全 0／未填、剔除 auto 後沒有支援 → 不寫列
       ·其他欄全 0／未填、只剩手填支援 → 寫「僅 support」列（hours_manual='0'）
     本店有歸集的人照舊整筆手動（行為不變）。歸集讀不到（例外）時也照舊。 */
  let colHome = null;
  if (xsup) {
    try { colHome = payCollect(ym, payConfig(st).meal_min_hours, st, payHolidayDates(payHolidayRow(ym, st))); }
    catch (e) { colHome = null; }
  }
  const rows = Object.keys(inputs).map(function (emp) {
    const a = inputs[emp] || {};
    return {
      ym: ym, emp_id: emp, store: st,
      hours: payNum(a.hours), extra_ot: payNum(a.extra_ot),
      personal_h: payNum(a.personal_h), sick_h: payNum(a.sick_h), menstrual_h: payNum(a.menstrual_h), disaster_h: payNum(a.disaster_h), annual_h: payNum(a.annual_h),
      // 2026-11 起：打卡帶入的 auto 列不落地（永遠跟著打卡重算，spec §3.3）；手填列只留白名單欄位。生效月之前原樣照存。
      deduct_days: payNum(a.deduct_days), support: JSON.stringify(xsup ? paySupportStrip_(a.support) : (a.support || [])), updated_at: now,
      hours_manual: xsup ? '1' : '',   // 生效月之前不寫新語意（GPT #12；空白本來就＝整筆手動）
      full_attend: payBool(a.full_attend) ? 1 : 0,
      work_days: payNum(a.work_days), wage_override: payNum(a.wage_override), meal_on: payBool(a.meal_on) ? 1 : 0, holiday_h: payNum(a.holiday_h),
      custom_add_label: String(a.custom_add_label||''), custom_add_amt: payNum(a.custom_add_amt),
      custom_ded_label: String(a.custom_ded_label||''), custom_ded_amt: payNum(a.custom_ded_amt),
      dorm_override: (a.dorm_override === '' || a.dorm_override == null) ? '' : payNum(a.dorm_override),
      custom_add_more: JSON.stringify((a.custom_add_more || []).filter(function (x) {
        return x && (String(x.label || '').trim() || payNum(x.amt));
      }).map(function (x) { return { label: String(x.label || ''), amt: payNum(x.amt) }; })),
    };
  }).filter(function (r) {
    if (!colHome || colHome[r.emp_id] || !payInputRowBlank_(r)) return true;
    if (r.support === '[]') return false;
    r.hours_manual = '0';
    return true;
  });
  // 只換「本月＋本店」，其他月份與其他門市原封不動
  if (!payReplaceKeep_('input', function (r) {
    return String(r.ym) !== ym || payStore(r.store) !== st;
  }, rows)) return PAY_BUSY_;
  return { ok: true, ym: ym, store: st, count: rows.length };
}

/* ═══════════════════ 加班費新算法：班表與逐日資料（2026-11 起）═══════════════════
 * 班表正本＝排班管理（營運系統）發布到光復打卡試算表 sched_pub 的資料（SchedPub.gs schedPubLoad_）。
 * 店別：打卡店代碼（光復＝空字串、其他＝小寫，例 mztjs／cf／hq）；同仁＝打卡名冊工號。
 * 薪資主檔工號＝門市 emp_prefix＋打卡工號（多數店 prefix 空白）；在別家打卡、班表由總部填的人
 * （例：總部薪資、央廚打卡）由打卡那家店發布 → 本店找不到時，到別家找「工號＋姓名都對得上」的那一列。 */
function paySchedCode_(st) { st = payStore(st); return st === PAY_DEFAULT_STORE ? '' : String(st).toLowerCase(); }
function payMonthDates_(ym) {
  const out = [], D = payDaysIn(ym);
  for (let i = 1; i <= D; i++) out.push(ym + '-' + pad2(i));
  return out;
}
/** 這個人本月在職的日子（到職日～離職日） */
function payEmpDates_(e, ym) {
  const hs = payDateStr(e.hire_date), ls = payDateStr(e.leave_date);
  return payMonthDates_(ym).filter(function (d) {
    return !(/^\d{4}-\d{2}-\d{2}$/.test(hs) && d < hs) && !(/^\d{4}-\d{2}-\d{2}$/.test(ls) && d > ls);
  });
}
/** 已發布班表整理成 { 'code|period': { byId: {工號: row}, start } }；讀不到回 {}（呼叫端會把每天都當「查不到」） */
function paySchedIndex_() {
  let pub = {};
  try { pub = (typeof schedPubLoad_ === 'function') ? (schedPubLoad_() || {}) : {}; } catch (e) { pub = {}; }
  const idx = {};
  Object.keys(pub).forEach(function (k) {
    const data = pub[k] || {}, byId = {};
    (data.rows || []).forEach(function (r) { byId[String(r.emp_id).trim()] = r; });
    idx[k] = { byId: byId };
  });
  return idx;
}
/** 某店某月每位同仁的班表格子：{ emp_id: { date: {t, s?, l?} } }（查不到的日子不列） */
function paySchedMonth_(ym, st, master, idx) {
  idx = idx || paySchedIndex_();
  if (typeof schedPubPeriodOf_ !== 'function') {   // 沒有班表模組（SchedPub.gs 只部署在光復這套）：每天都當查不到
    const none = {}; master.forEach(function (m) { none[String(m.emp_id)] = {}; }); return none;
  }
  const code = paySchedCode_(st);
  const prefix = String((payStoreRow(payStore(st)) || {}).emp_prefix || '').trim();
  const keys = Object.keys(idx);
  const out = {};
  master.forEach(function (m) {
    const id = String(m.emp_id).trim(), name = String(m.name || '').trim();
    const ids = [id];
    if (prefix && id.indexOf(prefix) === 0 && id.length > prefix.length) ids.push(id.slice(prefix.length));
    const days = {};
    payMonthDates_(ym).forEach(function (d) {
      const p = schedPubPeriodOf_(d);
      if (!p) return;
      const i = schedPubIndex_(d);
      let row = null;
      const own = idx[code + '|' + p];
      if (own) for (let j = 0; j < ids.length && !row; j++) row = own.byId[ids[j]] || null;
      if (!row) {   // 在別家打卡、由那家發布（工號與姓名都要對得上，避免撞號）
        for (let k = 0; k < keys.length && !row; k++) {
          if (keys[k].split('|')[1] !== p || keys[k] === code + '|' + p) continue;
          for (let j = 0; j < ids.length && !row; j++) {
            const r = idx[keys[k]].byId[ids[j]];
            if (r && String(r.name || '').trim() === name) row = r;
          }
        }
      }
      const cell = row ? (row.cells || [])[i] : null;
      if (cell && String(cell.t || '')) days[d] = cell;
    });
    out[String(m.emp_id)] = days;
  });
  return out;
}
/** 一個人的逐日資料（給 payCalcOne 的 att.daily）。col＝打卡歸集（day_h／day_leave）；xEntry＝跨店支援自動帶入（同品牌別店，含逐日）；
 *  supportH＝這次計薪採用的支援時數合計（手填＋帶入），多出逐日帶入的部分沒有日期 → 只列提醒 manual_sup_h。 */
function payDailyFor_(e, ym, col, xEntry, sched, holDates, until, supportH) {
  const dayH = {};
  Object.keys((col && col.day_h) || {}).forEach(function (d) { dayH[d] = payNum(col.day_h[d]); });
  let autoH = 0;
  ((xEntry && xEntry.stores) || []).forEach(function (s) {
    (s.days || []).forEach(function (x) {
      const h = payNum(x.hours);
      dayH[x.date] = payR2((dayH[x.date] || 0) + h); autoH += h;
    });
  });
  const hol = {};
  (holDates || []).forEach(function (d) { hol[String(d).trim()] = true; });
  return { dates: payEmpDates_(e, ym), sched: sched || {}, day_h: dayH, day_leave: (col && col.day_leave) || {},
           hol: hol, until: until || '', manual_sup_h: payR2(Math.max(0, payNum(supportH) - autoH)) };
}
/** 這家店本月已核准的加班單、出差單（以姓名分人）。沒連打卡或讀不到回 null＝不檢查。 */
function payOtFormsMonth_(st, ym) {
  if (!payHasClock(st)) return null;
  let rows;
  try { rows = payClockRead(st, 'requests'); } catch (e) { return null; }
  const out = {};
  (rows || []).forEach(function (r) {
    if (String(r.status) !== 'approved') return;
    const kind = String(r.kind), d = normCellDate(r.date);
    if ((kind !== 'ot' && kind !== 'trip') || String(d).slice(0, 7) !== ym) return;
    const nm = String(r.name || '').trim();
    const x = out[nm] = out[nm] || { ot: {}, trip: {} };
    if (kind === 'ot') x.ot[d] = payR2(payNum(x.ot[d]) + payNum(r.hours)); else x.trip[d] = true;
  });
  return out;
}
/** 今天在哪一個 28 天週期（與排班 period.js、SchedPub 同一個起算日）→ {start, end}。 */
function payPeriodRange_(date) {
  const base = Date.UTC(2026, 10, 1), day = 86400000;
  const n = Math.floor((Date.parse(date + 'T00:00:00Z') - base) / day / 28);
  const iso = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
  return { start: iso(base + n * 28 * day), end: iso(base + (n * 28 + 27) * day) };
}
/** 把每個人這一期（28 天）的加班時數與今天是不是休息日寫進各店 ot_month 分頁，給打卡端（Rest.gs）判斷 36／46 小時（4-15、4-17）。
 *  時數＝主管已核定到目前為止；每天 09:00 跟著超時檢查跑一次。某家算不出來就略過並記錯。姓名跨店相加（5-8）。 */
function payOtMonthSync_() {
  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd'), ym = today.slice(0, 7);
  const stores = payRead('store').filter(function (s) { return String(s.active).toLowerCase() !== 'false' && payHasClock(s.code); });
  const by = {}, errors = [], range = payPeriodRange_(today);
  const yms = range.start.slice(0, 7) === range.end.slice(0, 7) ? [range.start.slice(0, 7)] : [range.start.slice(0, 7), range.end.slice(0, 7)];
  stores.forEach(function (s) {
    const st = payStore(s.code);
    try {
      yms.forEach(function (m) {
        const r = handlePayrollCalc({ admin_key: CONFIG.ADMIN_KEY, ym: m, store: st, dry_run: true });
        if (!r || !r.ok) throw new Error((r && r.error) || 'calc_failed');
        (r.results || []).forEach(function (x) {
          const nm = String(x.name || '').replace(/\s/g, '');
          if (!nm || !x.ot_info) return;
          const row = by[nm] = by[nm] || { h: 0, rest: false, work: false };
          Object.keys(x._ot_days || {}).forEach(function (d) { if (d >= range.start && d <= range.end) row.h = payR2(row.h + payNum(x._ot_days[d])); });
          if (m !== ym) return;
          const kind = payOtKindOf(((r._sched || {})[String(x.emp_id)] || {})[today] || null, (r._hol || []).map(String).indexOf(today) >= 0);
          if (kind === 'H' || kind === 'R' || kind === 'HOL') row.rest = true; else if (kind) row.work = true;
        });
      });
    } catch (e) { errors.push(st); Logger.log('ot_month 算不出來 ' + st + '：' + e); }
  });
  const stamp = nowTaipeiIso();
  const rows = [['name', 'ot_h', 'rest', 'date', 'updated_at']].concat(Object.keys(by).map(function (nm) {
    return [nm, by[nm].h, (by[nm].rest && !by[nm].work) ? 'TRUE' : 'FALSE', today, stamp];
  }));
  const writeErrors = [];
  stores.forEach(function (s) {
    try {
      const ss = payClockSS(s.code);
      const sh = ss.getSheetByName('ot_month') || ss.insertSheet('ot_month');
      sh.clearContents();
      sh.getRange(1, 1, rows.length, 5).setNumberFormat('@').setValues(rows.map(function (x) { return x.map(String); }));
    } catch (e) { writeErrors.push(String(s.code)); Logger.log('ot_month 寫不進去 ' + s.code + '：' + e); }
  });
  return { ok: true, date: today, stores: stores.length, people: rows.length - 1, errors: errors, write_errors: writeErrors,
           warn: Object.keys(by).filter(function (n) { return by[n].h > PAY_OT_WARN_H && by[n].h < PAY_OT_STOP_H; }).length,
           stop: Object.keys(by).filter(function (n) { return by[n].h >= PAY_OT_STOP_H; }).length };
}
/** 薪資頁用：這家店 ot_month 分頁今天的週期加班時數 {姓名去空白: 時數}；沒有就空物件。 */
function payOtPeriodMap_(st) {
  const out = {};
  try {
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    payClockRead(st, 'ot_month').forEach(function (r) { if (String(r.date).slice(0, 10) === today) out[String(r.name)] = payNum(r.ot_h); });
  } catch (e) {}
  return out;
}
function handlePayrollOtMonthSync(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return payOtMonthSync_();
}
/** 鎖定前檢查：本店每位在職同仁本月每一天都要在已發布的班表上查得到（Eason 2026-11-06：查不到就不能鎖定） */
function paySchedMissingAll_(ym, st) {
  const master = payRead('master').filter(function (m) { return String(m.active).toLowerCase() === 'true' && payStore(m.store) === payStore(st); });
  const sched = paySchedMonth_(ym, st, master);
  const out = [];
  master.forEach(function (m) {
    const have = sched[String(m.emp_id)] || {};
    const miss = payEmpDates_(m, ym).filter(function (d) { return !have[d]; });
    if (miss.length) out.push({ emp_id: String(m.emp_id), name: String(m.name || ''), days: miss.length, first: miss[0], last: miss[miss.length - 1] });
  });
  return out;
}

function handlePayrollCalc(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };

  const runs = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === payStore(body.store); });
  if (runs.length && String(runs[0].status) === 'final' && !body.force && !body.dry_run) {
    return { ok: false, error: 'locked', message: ym + ' 已鎖定，請先解鎖再重算' };
  }
  // （2026-11-04 夜間 QA）force 只用來跳過「資料有變動」之類的確認，不能無聲解鎖已定案月份（重算會把 status 改回 draft、也不寫稽核）；
  //  要重算先走解鎖（會寫稽核）。
  if (runs.length && String(runs[0].status) === 'final' && body.force && !body.dry_run) {
    return { ok: false, error: 'finalized', message: ym + ' 已定案，請先解鎖（會留稽核）再重算' };
  }

  let holiday = payHolidayRow(ym, payStore(body.store));
  if (!holiday) {   // 紅字天數改成自動帶入（2026-09-18）：沒有就先依人事行政總處同步該年再找一次
    try { payHolidaySync([Number(ym.slice(0, 4))]); } catch (e) { Logger.log('holiday sync in calc: ' + e); }
    holiday = payHolidayRow(ym, payStore(body.store));
  }
  if (!holiday) return { ok: false, error: 'no_holiday', message: ym + ' 沒有紅字天數（人事行政總處可能還沒公布該年行事曆）' };
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
  const OT_FORMS = payOtFormsMonth_(st, ym);
  const LTYPES_FOR_CALC = payLeaveTypes(st);
  const USAGE_BEFORE = payLeaveUsedBefore(ym, st, LTYPES_FOR_CALC, cfg, master);
  const ANNUAL_INFO = payAnnualInfo(ym, st);   // 特休額度／已用／週年期，折算工資要用（迴圈外算一次）
  // 跨店支援自動帶入（2026-11 起；之前回 null＝完全不動）。迴圈外讀一次，逐人只做純函式合併。
  const DAILY = payOtDailyOn(ym);   // 2026-11 起加班逐日判斷：要逐日的支援時數、班表、國定假日
  const XSUP = paySupportAuto_(ym, st, DAILY);
  const SCHED = DAILY ? paySchedMonth_(ym, st, master) : null;
  const HOLD = DAILY ? payHolidayDates(holiday) : null;
  const UNTIL = DAILY ? payYesterday_() : '';
  const XCTX = XSUP ? { home: st, storeBy: payXsupStoreBy_(payRead('store')), dropCross: !XSUP.empty } : null;
  // 每人這次「別家門市核定」可帶入的時數合計（不論有沒有被手填蓋過）→ 寫進 run.support_auto_h，payroll_month 只拿它判斷過期
  const XAUTO_H = XSUP ? payXsupAutoSums_(XSUP) : {};
  const XSA = XSUP ? payApplySupportAuto_({}, [], { synced_at: XSUP.synced_at, empty: XSUP.empty, byEmp: {}, unmapped: XSUP.unmapped,
                                                    dup_pay: XSUP.dup_pay, dup_acct: XSUP.dup_acct, pending: XSUP.pending }, XCTX, null) : null;

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
      custom_add_more:  o.custom_add_more  !== undefined ? (o.custom_add_more || []) : (c.custom_add_more || []),
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
    if (XSUP && c.support_error) XSA.warn.support_error.push(String(e.emp_id));   // 支援欄壞掉：一律不帶入（審查 #2）
    else if (XSUP) {
      const mg = payMergeSupport_(att.support, XSUP.byEmp[String(e.emp_id).trim()], e, XCTX);
      att.support = mg.support;
      const xle = payXsupLateEarly_(XSUP.byEmp[String(e.emp_id).trim()]);
      att.xsup_late_min = xle.late; att.xsup_early_min = xle.early;

      if (mg.unresolved) XSA.warn.manual_unresolved.push(String(e.emp_id));
      mg.cross.forEach(function (c) { XSA.warn.cross_manual.push({ emp_id: String(e.emp_id), code: c }); });
      mg.diffs.forEach(function (x) { XSA.diffs.push({ emp_id: String(e.emp_id), code: x.code, name: x.name, manual: x.manual, auto: x.auto }); });
    }
    if (DAILY) {
      const id = String(e.emp_id);
      const supH = (att.support || []).reduce(function (t, x) { return t + payNum(x && x.hours); }, 0);
      att.daily = payDailyFor_(e, ym, c, XSUP ? XSUP.byEmp[id.trim()] : null, SCHED[id], HOLD, UNTIL, supH);
      if (OT_FORMS) { att.ot_own_h = (c && c.day_h) || {}; att.ot_forms = OT_FORMS[String(e.name || '').trim()] || { ot: {}, trip: {} }; }
    }
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
    if (XSUP && !XSUP.empty) runRows[runRows.length - 1].support_auto_h = XAUTO_H[String(r.emp_id)] || 0;
    if (r.ot_info) runRows[runRows.length - 1].ot_info = JSON.stringify(r.ot_info);
  });

  if (body.dry_run) {   // 唯讀試算（payroll_ot_preview）：不寫 run／item
    const dres = { ok: true, ym: ym, store: st, results: results, red_days: redDays, dry_run: true };
    if (typeof SCHED !== 'undefined') { dres._sched = SCHED; dres._hol = HOLD; }   // 只給 payOtMonthSync_；試算回應不帶
    return dres;
  }
  let lockedMeanwhile = false;
  const wrote = payWriteLocked_(['run', 'item'], function () {
    const runNow = payRead('run');
    // 算的這段時間別台剛好按了鎖定 → 不蓋（否則定案的月份被改回草稿）
    lockedMeanwhile = runNow.some(function (r) { return String(r.ym) === ym && payStore(r.store) === st && String(r.status) === 'final'; });
    if (lockedMeanwhile) return;
    const mineOut = function (r) { return String(r.ym) !== ym || payStore(r.store) !== st; };
    payReplaceAll('run', runNow.filter(mineOut).concat(runRows));
    payReplaceAll('item', payRead('item').filter(mineOut).concat(itemRows));
  });
  if (!wrote) return PAY_BUSY_;
  if (lockedMeanwhile) return { ok: false, error: 'locked', message: ym + ' 剛被鎖定，這次重算沒有寫入' };

  const res = { ok: true, ym: ym, store: st, results: results, config: cfg, red_days: redDays, collected: collected };
  if (XSA) res.support_auto = XSA;
  return res;
}

/** 新舊算法唯讀並列試算（2026-11-06，加班費新算法上線前給 Eason 看；之後也可拿來對帳）：
 *  {admin_key, ym, store} → 同一份資料用舊算法、新算法各算一次，**都不寫入**，回每人的金額與加班相關明細。 */
function handlePayrollOtPreview(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const st = payStore(body.store);
  const KEEP = /^(ot_|overtime$|shortfall_hours$|attend_bonus$|early_deduct$|late_deduct$|annual_payout$|pt_annual$|holiday_double$|hourly_wage$|cross_store$)/;
  const slim = function (r) {
    return { emp_id: r.emp_id, name: r.name, ft: r.is_full_time, hours: r.total_hours, support_h: r.support_hours,
             ot_h: r.ot_paid_hours, gross: r.gross, deduction: r.deduction, net: r.net, ot_info: r.ot_info || null,
             items: [].concat(r.earn.map(function (x) { return [x.item_key, x.item_label, x.qty, x.rate, x.amount, 'e']; }),
                              r.ded.map(function (x) { return [x.item_key, x.item_label, x.qty, x.rate, x.amount, 'd']; }))
                      .filter(function (x) { return KEEP.test(x[0]); }) };
  };
  const was = PAY_OT_FORCE_, fromWas = PAY_OT_DAILY_FROM;
  let oldR, newR;
  try {
    PAY_OT_FORCE_ = false; PAY_OT_DAILY_FROM = '9999-12';
    oldR = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: st, dry_run: true });
    PAY_OT_FORCE_ = true;
    newR = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: st, dry_run: true });
  } finally { PAY_OT_FORCE_ = was; PAY_OT_DAILY_FROM = fromWas; }
  if (!oldR || !oldR.ok) return oldR || { ok: false, error: 'calc_failed' };
  if (!newR || !newR.ok) return newR || { ok: false, error: 'calc_failed' };
  const runs = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === st; });
  return { ok: true, ym: ym, store: st, status: runs.length ? String(runs[0].status) : '', red_days: oldR.red_days,
           old: oldR.results.map(slim), new: newR.results.map(slim) };
}

function payItemRow(ym, empId, type, x, source, store) {
  return { ym: ym, emp_id: empId, item_type: type, item_key: x.item_key, item_label: x.item_label,
           qty: x.qty == null ? '' : x.qty, rate: x.rate == null ? '' : x.rate,
           amount: x.amount, source: source, memo: x.memo || '', store: payStore(store) };   // memo：舊制補休 comp_bank 會帶（2026-11-01 改制後已不產生）
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

/** 主檔工號在本店打卡名冊找不到的人（2026-11-06：光復 A 君主檔 E10、打卡 E11，打卡時數與班表都對不到人）。
 *  比對法與 paySchedMonth_ 相同：主檔工號原樣、或去掉 emp_prefix。名冊裡有同名的人就一併回他的打卡工號，方便改。
 *  沒有打卡的店（has_clock＝false）不檢查；讀不到名冊也不報（不讓提醒拖垮整頁）。 */
function payRosterMismatch_(st, master) {
  st = payStore(st);
  if (!payHasClock(st)) return [];
  let roster = [];
  try { roster = payClockRead(st, 'roster') || []; } catch (e) { return []; }
  if (!roster.length) return [];
  const ids = {}, byName = {};
  roster.forEach(function (r) {
    ids[String(r.emp_id).trim()] = true;
    const n = String(r.name || '').trim();
    if (n) (byName[n] = byName[n] || []).push(String(r.emp_id).trim());
  });
  const prefix = String((payStoreRow(st) || {}).emp_prefix || '').trim();
  const out = [];
  (master || []).forEach(function (m) {
    if (String(m.active).toLowerCase() !== 'true' || payStore(m.store) !== st) return;
    const id = String(m.emp_id).trim();
    if (ids[id] || (prefix && id.indexOf(prefix) === 0 && ids[id.slice(prefix.length)])) return;
    out.push({ emp_id: id, name: String(m.name || ''), roster_ids: byName[String(m.name || '').trim()] || [] });
  });
  return out;
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
  const sa = payXsupApply_(ym, stM, inputs, true);   // 2026-11 起：顯示用工時帶入 auto 列＋提醒（之前回 null，輸出不變）
  let run = payBuildRunResults(ym, stM);
  /* run 快照過期（spec §7-6）：打卡核定改了、對照同步了，草稿裡的支援時數就不再是現在的值。
     草稿 → 自動重算一次；已鎖定 → 只標 stale 不重算。對照從沒同步過（empty）時不判。 */
  if (sa && run && !sa.empty) {
    // 只比「打卡帶入」的時數（審查 #4）：手填和存檔值不同（例：用未存的影本重算）不算過期，不可以被靜默蓋掉
    const want = sa.auto_h || {}, had = {};
    payRead('run').forEach(function (r) { if (String(r.ym) === ym && payStore(r.store) === stM) had[String(r.emp_id)] = payR2(payNum(r.support_auto_h)); });
    // 比「草稿裡的人 ∪ 這次要帶入的人」：草稿之後新增的同仁也要看得到（GPT #7）
    const ids = {};
    (run.results || []).forEach(function (r) { ids[String(r.emp_id)] = true; });
    Object.keys(want).forEach(function (k) { if (want[k]) ids[k] = true; });
    const stale = Object.keys(ids).some(function (k) { return (had[k] || 0) !== (want[k] || 0); });
    if (stale && run.status === 'final') sa.stale = true;
    else if (stale) {
      const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: stM });
      if (calc && calc.ok) { run = { results: calc.results, status: 'draft' }; sa.recalc = true; }
    }
  }
  if (!run) {
    const hol = payHolidayRow(ym, stM);
    // ⚠ 紅字天數整年自動帶入後，未來月份也有列了；只是翻到未來月份不可以就自動試算並寫入，
    //   否則會先存一份全是 0 的草稿，到了那個月打開看到的是那份舊草稿（要按重新計算才會更新）。
    if (hol && ym <= currentYmTaipei()) {
      const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: stM, inputs: body.inputs || {} });
      if (calc && calc.ok) run = { results: calc.results, status: 'draft' };
    }
  }
  const masterM = payRead('master').filter(function (m) { return payStore(m.store) === stM; });
  let rosterMiss = [];
  try { rosterMiss = payRosterMismatch_(stM, masterM); } catch (e) { rosterMiss = []; }
  return { ok: true, ym: ym, store: stM, has_clock: payHasClock(stM), inputs: inputs, run: run, annual: payAnnualInfo(ym, stM),
           master: masterM, roster_mismatch: rosterMiss.length ? rosterMiss : undefined,   // 沒有就不帶（回應形狀與改版前相同）
           ot_period: (function (m) { return Object.keys(m).length ? m : undefined; })(payOtPeriodMap_(stM)),   // 沒有就不帶（回應形狀與改版前相同）
           config: payConfig(stM), config_src: payConfigSource(stM),
           bonuses: payRead('bonus').filter(function (b) { return String(b.ym) === ym && payStore(b.store) === stM; }),
           stores: payRead('store').filter(function (x) { return String(x.active).toLowerCase() !== 'false'; }),
           holidays: payHolidayList(stM), support_auto: sa || undefined };
}

function handlePayrollItemUpsert(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const it = body.item;
  if (!it || !it.ym || !it.emp_id) return { ok: false, error: 'item_required' };
  // （2026-11-04 夜間 QA）已定案（final）的月份不能再偷加／改明細項；要改先解鎖（會寫稽核）。
  const itRuns = payRead('run').filter(function (r) { return String(r.ym) === String(it.ym) && payStore(r.store) === payStore(it.store); });
  if (itRuns.length && String(itRuns[0].status) === 'final') {
    return { ok: false, error: 'finalized', message: String(it.ym) + ' 已定案，請先解鎖再改明細項' };
  }
  if (!body.remove) it.source = 'manual';
  if (!payReplaceKeep_('item', function (i) {
    return !(String(i.ym) === String(it.ym) && String(i.emp_id) === String(it.emp_id) &&
             String(i.item_key) === String(it.item_key) && String(i.source) === 'manual');
  }, body.remove ? [] : [it])) return PAY_BUSY_;
  return { ok: true };
}

function handlePayrollFinalize(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || ''), lock = !!body.lock;
  if (!lock && !body.reason) return { ok: false, error: 'reason_required', message: '解鎖必須填原因' };
  const stF = payStore(body.store);
  /* 補休帳是負的不能鎖定（Eason 2026-11-01：不自動扣，擋住鎖定）。解鎖不擋。 */
  if (lock && ym >= PAY_COMP_MONTHLY_FROM) {
    const neg = payCompNegatives(ym, stF);
    if (neg.length) return { ok: false, error: 'comp_negative', list: neg,
      message: '補休帳是負的，不能鎖定（請補核准加班申請，或把多請的補休改成其他假別）：\n' + neg.map(payCompNegLine).join('\n') };
  }
  /* 補休抵不掉不能鎖定（出勤規範 4-6、4-10）：休息日第 3 小時起、例假、國定假日的加班不能抵，多請的補休要改成其他假別。解鎖不擋。 */
  if (lock && payOtDailyOn(ym)) {
    const over = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === stF; }).map(function (r) {
      let o = {}; try { o = JSON.parse(r.ot_info || '{}') || {}; } catch (e) { o = {}; }
      return { name: r.name, h: payNum(o.comp_over_h) };
    }).filter(function (x) { return x.h > 0; });
    if (over.length) return { ok: false, error: 'comp_over', list: over,
      message: '下面的同仁補休比可以抵的加班多，不能鎖定（休息日第 3 小時起、例假、國定假日的加班不能抵）。請把多請的補休改成其他假別：\n' +
        over.map(function (x) { return x.name + '：' + x.h + ' 小時'; }).join('\n') };
  }
  /* 超過 8H 沒有核准的加班單不能鎖定（出勤規範 4-2，2026-11-11 起算）。解鎖不擋。 */
  if (lock && payOtDailyOn(ym)) {
    const noForm = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === stF; }).map(function (r) {
      let o = {}; try { o = JSON.parse(r.ot_info || '{}') || {}; } catch (e) { o = {}; }
      return { name: r.name, list: o.ot_form_missing || [] };
    }).filter(function (x) { return x.list.length; });
    if (noForm.length) return { ok: false, error: 'ot_form_missing', list: noForm,
      message: '下面的同仁當天超過 8 小時，卻沒有足夠的已核准加班單，補單前不能鎖定：\n' +
        noForm.map(function (x) { return x.name + '：' + x.list.map(function (y) { return y.date.slice(5) + ' 少 ' + payR2(y.need - y.have) + ' 小時'; }).join('、'); }).join('\n') };
  }
  /* 班表查不到不能鎖定（Eason 2026-11-06）：2026-11 起加班看班表判斷休息日／例假，
     某人某月有任何一天在排班管理發布的班表上查不到，就要先去補發布班表。解鎖不擋。 */
  if (lock && payOtDailyOn(ym)) {
    const miss = paySchedMissingAll_(ym, stF);
    if (miss.length) return { ok: false, error: 'sched_missing', list: miss,
      message: '下面的同仁有日子在排班管理發布的班表上查不到，不能鎖定（加班要看班表判斷休息日、例假）。請先到排班管理把那幾天排好並發布：\n' +
        miss.map(function (x) { return x.name + '：' + x.days + ' 天查不到（' + x.first.slice(5) + (x.days > 1 ? '～' + x.last.slice(5) : '') + '）'; }).join('\n') };
  }
  let n = 0;
  if (!payWriteLocked_(['run'], function () {
    const rows = payRead('run');
    rows.forEach(function (r) { if (String(r.ym) === ym && payStore(r.store) === stF) { r.status = lock ? 'final' : 'draft'; n++; } });
    if (n) payReplaceAll('run', rows);
  })) return PAY_BUSY_;
  if (!n) return { ok: false, error: 'no_run', message: ym + ' 還沒有月結資料' };
  payAppend('audit', [{ ts: nowTaipeiIso(), ym: ym, action: lock ? 'lock' : 'unlock',
                        operator: String(body.operator || 'admin'), reason: String(body.reason || ''), store: stF }]);
  /* 損益系統快照（T14，Eason 2026-09-25 選方案 C）：只在「鎖定」（不是解鎖）且前端有送
     cost_snapshot 時才寫新快照。鎖定本身在上面已經完成了，快照寫入失敗絕對不可以讓鎖定
     失敗——try/catch 接住，失敗只記一筆稽核方便之後追查，不影響這次呼叫的回應。
     ⚠ 2026-09-25 審查修正：兩種情況要清掉「舊快照殘留」，否則端點會把上一輪鎖定留下的
     舊數字誤當成這次的答案繼續回傳——①解鎖時（這個月不再是定案數字）②鎖定但沒送
     cost_snapshot（沒有新資料可信，寧可讓端點誠實回 NO_SNAPSHOT，也不要用舊資料充數）。
     移除同樣包 try/catch，失敗不影響鎖定/解鎖本身。 */
  if (lock && body.cost_snapshot) {
    try {
      pnlSnapshotUpsert_(ym, stF, body.cost_snapshot);
    } catch (snapErr) {
      payAppend('audit', [{ ts: nowTaipeiIso(), ym: ym, action: 'pnl_snapshot_fail',
                            operator: String(body.operator || 'admin'),
                            reason: String((snapErr && snapErr.message) || snapErr), store: stF }]);
    }
  } else {
    try {
      pnlSnapshotRemove_(ym, stF);
    } catch (rmErr) {
      payAppend('audit', [{ ts: nowTaipeiIso(), ym: ym, action: 'pnl_snapshot_remove_fail',
                            operator: String(body.operator || 'admin'),
                            reason: String((rmErr && rmErr.message) || rmErr), store: stF }]);
    }
  }
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
  const ptOn = payOtDailyOn(ym);
  const runRows = ptOn ? payRead('run') : [];
  master.forEach(function (e) {
    // 計時同仁：2026-10 以前沒有特休（Eason 2026-08 定案）；2026-11 起依工時比例給（出勤認定清單 E2、四週變形 C21：報到日起算）
    const ft = String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true;
    if (!ft && (!ptOn || !payPtInsured_(e))) { out[String(e.emp_id)] = null; return; }
    let q = payAnnualQuota(e.hire_date, ym);
    if (!q) { out[String(e.emp_id)] = null; return; }
    /* 離職當月剩下的特休折算（6-10）：離職日在這個月，週年日還沒到就用上一個週年期 */
    const lastDay = payDateStr(e.leave_date);
    const leavingNow = payRules3On_(ym) && lastDay.slice(0, 7) === ym;
    if (leavingNow && q.ps && q.ps > lastDay) q = payAnnualQuota(e.hire_date, payDayBefore(ym + '-01').slice(0, 7));
    const ratio = ft ? 1 : payPtAnnualRatio(runRows, e.emp_id, ym);
    const usedIn = function (qp) {
      let used = 0;
      // ① 手動工時的特休（annual_h）：該月落在週年期內就累計；同月以手動為準（覆蓋語意，與計薪一致）
      const inputMonths = {};
      savedRows.forEach(function (r) {
        if (String(r.emp_id) !== String(e.emp_id)) return;
        const m = String(r.ym);
        if (!/^\d{4}-\d{2}$/.test(m)) return;
        if (!qp.ps || (m + '-31') < qp.ps || (m + '-01') >= qp.pe) return;
        inputMonths[m] = true;
        used += payNum(r.annual_h);
      });
      // ② leave 分頁的特休：掃該員工「歷任門市」的請假紀錄；只算沒有手動工時覆蓋的月份，避免同月重複計
      (empStores[String(e.emp_id)] || [stA]).forEach(function (st2) {
        leavesOf(st2).forEach(function (l) {
          if (String(l['姓名'] || '').trim() !== String(e.name || '').trim()) return;
          if (String(l['假別'] || '').indexOf('特') === -1) return;
          const d = normCellDate(l['日期']);
          if (!(qp.ps && d >= qp.ps && d < qp.pe)) return;
          if (inputMonths[d.slice(0, 7)]) return;
          used += Number(l['時數']) || 0;
        });
      });
      return used;
    };
    const used = usedIn(q);
    // payout_ym＝週年期「屆滿前一日」所在的月份：勞基法§38 特休因年度終結而未休完者應折算工資。
    // 例到職 10/01 → 到 9/30，算 9 月薪資；到職 10/15 → 到 10/14，算 10 月薪資（Eason 2026-11-08）。
    // q 用月底算，10/15 到職的人一進 10 月 q 已是新年度，所以要回頭看上個月的那一期才結得到舊年度。
    const settle = (leavingNow || String(ym) < PAY_ANNUAL_SETTLE_FROM) ? null : payAnnualQuota(e.hire_date, payDayBefore(ym + '-01').slice(0, 7));
    const settleNow = !!(settle && settle.days > 0 && settle.pe && payDayBefore(settle.pe).slice(0, 7) === ym);
    const quotaH = payR1(q.days * 8 * ratio);
    out[String(e.emp_id)] = { days: q.days, quota_h: quotaH, used_h: payR1(used),
                              left_h: payR1(quotaH - used),
                              ps: q.ps, pe: q.pe, payout_ym: (leavingNow || settleNow) ? ym : payDayBefore(q.pe).slice(0, 7) };
    if (settleNow) out[String(e.emp_id)].payout_h = payR1(settle.days * 8 * ratio - usedIn(settle));
    if (!ft) out[String(e.emp_id)].ratio = payR2(ratio);   // 計時：工時比例（畫面說明用）
  });
  return out;
}

/* ═══════════════════ 補休：讀資料（規則本身在引擎區段的 payCompMonthCalc）═══════════════════ */

/** 一次把補休帳要的表讀好（效能鐵則：逐人迴圈裡不准 payRead／payClockRead）：各店 requests、leave 分頁，用到才讀、讀過快取。
 *  forEmp(e, store)＝{allowed, ym, ot_h, used_h, balance_h}。對人：歷任門市（payEmpStoresMap）＋本店，用姓名對（同 leave 分頁的對法）。 */
function payCompMonthBook(ym) {
  const empStores = payEmpStoresMap();
  const cache = {};
  function rowsOf(st, sheet) {
    const k = st + '|' + sheet;
    if (!(k in cache)) { try { cache[k] = payClockRead(st, sheet); } catch (e) { cache[k] = []; } }   // 某店暫時開不起來不該讓整頁掛掉
    return cache[k];
  }
  return {
    forEmp: function (e, store) {
      const name = String(e.name || '').trim();
      const sts = (empStores[String(e.emp_id)] || []).slice();
      if (sts.indexOf(payStore(store)) < 0) sts.push(payStore(store));
      const ots = [], leaves = [], reqs = [];
      sts.forEach(function (st) {
        rowsOf(st, 'requests').forEach(function (r) {
          if (String(r.name || '').trim() !== name) return;
          const d = normCellDate(r.date), h = payNum(r.hours);
          if (String(d).slice(0, 7) !== ym || !(h > 0)) return;
          const status = String(r.status);
          if (String(r.kind) === 'ot' && status === 'approved') ots.push({ date: d, h: h });
          else if (String(r.kind) === 'leave' && String(r.leave_type || '').trim() === PAY_COMP_NAME &&
                   (status === 'pending' || status === 'approved')) reqs.push({ date: d, h: h });
        });
        rowsOf(st, 'leave').forEach(function (l) {
          if (String(l['姓名'] || '').trim() !== name || String(l['假別'] || '').trim() !== PAY_COMP_NAME) return;
          const d = normCellDate(l['日期']), h = Number(l['時數']) || 0;
          if (String(d).slice(0, 7) === ym && h > 0) leaves.push({ date: d, h: h });
        });
      });
      const c = payCompMonthCalc(ots, leaves, reqs);
      c.allowed = payIsFt(e); c.ym = ym;
      return c;
    },
  };
}

/** 台北今天（Code.gs 的 todayTaipeiStr；只載入 Payroll.gs 的測試環境沒有它就自己算） */
function payCompToday() {
  try { return todayTaipeiStr(); } catch (e) { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
}
/** 正職判斷（與 payCalcOne 同一條） */
function payIsFt(e) { return !!e && (String(e.is_full_time).toLowerCase() === 'true' || e.is_full_time === true); }

/** 某店某月補休帳是負的正職：[{emp_id, name, ot_h, used_h, balance_h}]（鎖定前、20／25 號檢查共用）。 */
function payCompNegatives(ym, store, book) {
  const st = payStore(store);
  const bk = book || payCompMonthBook(ym);
  const out = [];
  payRead('master').forEach(function (e) {
    if (String(e.active).toLowerCase() !== 'true' || payStore(e.store) !== st || !payIsFt(e)) return;
    const c = bk.forEmp(e, st);
    if (c.balance_h < 0) out.push({ emp_id: String(e.emp_id), name: String(e.name), ot_h: c.ot_h, used_h: c.used_h, balance_h: c.balance_h });
  });
  return out;
}
/** 一行字：「A 君：加班 4 − 補休 8 ＝ −4 小時」 */
function payCompNegLine(x) {
  return x.name + '：加班 ' + x.ot_h + ' − 補休 ' + x.used_h + ' ＝ ' + x.balance_h + ' 小時';
}

/** {action:'payroll_comp_check', admin_key, ym?} → 各店補休帳是負的正職（唯讀，給管理者與排程用）。 */
function handlePayrollCompCheck(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? String(body.ym) : payCompToday().slice(0, 7);
  return { ok: true, ym: ym, stores: payCompCheckAll_(ym) };
}
function payCompCheckAll_(ym) {
  const book = payCompMonthBook(ym);
  const out = [];
  payStoreList().forEach(function (s) {
    const list = payCompNegatives(ym, s.code, book);
    if (list.length) out.push({ store: payStore(s.code), name: String(s.name || s.code), list: list });
  });
  return out;
}

/* 20／25 號檢查（Eason 2026-11-01）：每天 09:00 觸發器跑，只有 20、25 號真的做事。
   有負數 → 通知匣一般件（key 同一天同一件）＋ LINE 私訊該店值班主管（打卡官方帳號，會花推播額度，Eason 選的）。
   觸發器用 payroll_comp_trigger_setup 建（重跑不疊）。通知匣密碼＝指令碼屬性 NOTIFY_INBOX_TOKEN（Eason 自己貼）。 */
var PAY_COMP_CHECK_DAYS = [20, 25];
var PAY_NOTIFY_INBOX_URL = 'https://script.google.com/macros/s/AKfycbyZ-sVl9KbKhotjsFhKg9Id7j4qgNRf6wSlSCacoBe7lATkuJFb9_ShCaicAJuLOak/exec';
function payCompCheckDaily() {
  const today = payCompToday();
  if (PAY_COMP_CHECK_DAYS.indexOf(+today.slice(8, 10)) < 0) return;
  payCompCheckRun_(today);
}
/** 實際檢查＋通知（today 可指定，給手動補跑）。回 {stores, inbox, pushed}。任何一步失敗都不拋例外。 */
function payCompCheckRun_(today) {
  const ym = String(today).slice(0, 7), md = (+today.slice(5, 7)) + '/' + (+today.slice(8, 10));
  let stores = [];
  try { stores = payCompCheckAll_(ym); } catch (err) {
    payInboxNotify_('補休檢查讀不到資料', md + ' 補休帳檢查失敗：' + err, 'compcheck-fail-' + today);
    return { stores: [], inbox: false, pushed: 0, error: String(err) };
  }
  if (!stores.length) return { stores: [], inbox: false, pushed: 0 };
  let pushed = 0;
  const lines = [];
  stores.forEach(function (s) {
    const body = s.list.map(payCompNegLine).join('\n');
    const n = payCompPushManagers_(s.store, '⚠ 補休帳是負的（' + md + ' 檢查）\n' + body +
      '\n\n請在月底前補核准加班申請，或把多請的補休改成其他假別；有負數的話這個月薪資不能鎖定。');
    pushed += n;
    lines.push('【' + s.name + '】' + (n ? '' : '（沒有可私訊的值班主管）') + '\n' + body);
  });
  const inbox = payInboxNotify_('補休帳有負數：' + stores.map(function (s) { return s.name; }).join('、'),
    md + ' 檢查 ' + ym + ' 補休帳（核准加班 − 補休）：\n' + lines.join('\n') + '\n\n有負數的店不能鎖定本月薪資。',
    'compcheck-' + today);
  return { stores: stores, inbox: inbox, pushed: pushed };
}
/** 通知匣一般件；成功判準 ok===true && added===true。任何情況都不拋例外。 */
function payInboxNotify_(title, text, keyEvent, from, prefix) {
  try {
    const tok = PropertiesService.getScriptProperties().getProperty('NOTIFY_INBOX_TOKEN');
    if (!tok) { Logger.log('通知匣沒設密碼（NOTIFY_INBOX_TOKEN）：' + title); return false; }
    const payload = JSON.stringify({ action: 'add', token: tok, from: from || '補休檢查', title: String(title).slice(0, 60),
      text: String(text).slice(0, 1000), level: 'normal', key: (prefix || 'compcheck') + ':' + String(keyEvent).toLowerCase().replace(/[^a-z0-9-]/g, '') });
    for (let i = 0; i < 3; i++) {
      try {
        const res = UrlFetchApp.fetch(PAY_NOTIFY_INBOX_URL, { method: 'post', contentType: 'application/json', payload: payload,
          muteHttpExceptions: true, followRedirects: true });
        if (res.getResponseCode() === 200) {
          const d = JSON.parse(res.getContentText());
          if (d && d.ok === true && d.added === true) return true;
        }
      } catch (err) { Logger.log('通知匣第 ' + (i + 1) + ' 次寫入失敗：' + err); }
      if (i < 2) Utilities.sleep(i ? 15000 : 5000);
    }
    return false;
  } catch (err) { return false; }
}
/** 私訊某店值班主管（managers 分頁 active＝TRUE、不是營運系統鑰匙列；emp_id 有填為準，沒填用姓名對名冊）→ 送出幾個人。 */
function payCompPushManagers_(store, text) {
  try {
    const token = (typeof LINE_HUB_BOT_TOKEN !== 'undefined') ? LINE_HUB_BOT_TOKEN : '';
    if (!token) return 0;
    const roster = payClockRead(store, 'roster'), uids = {};
    payClockRead(store, 'managers').forEach(function (m) {
      if (String(m.active).toLowerCase() !== 'true' || String(m.allow_acting).toLowerCase() === 'true') return;
      const id = String(m.emp_id || '').trim(), nm = String(m.name || '').replace(/\s/g, '');
      roster.forEach(function (r) {
        if (String(r.active).toLowerCase() !== 'true' || !r.line_user_id) return;
        if (id ? String(r.emp_id) === id : String(r.name || '').replace(/\s/g, '') === nm) uids[String(r.line_user_id)] = true;
      });
    });
    let n = 0;
    Object.keys(uids).forEach(function (uid) {
      try {
        const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', { method: 'post', contentType: 'application/json',
          muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ to: uid, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }) });
        if (res.getResponseCode() === 200) n++;
        else Logger.log('補休檢查私訊失敗 ' + store + '：' + res.getResponseCode());
      } catch (err) { Logger.log('補休檢查私訊失敗 ' + store + '：' + err); }
    });
    return n;
  } catch (err) { return 0; }
}
/** {action:'payroll_comp_trigger_setup', admin_key} → 建每天 09:00 的 payCompCheckDaily（同名先刪，重跑不疊）。 */
function handlePayrollCompTriggerSetup(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'payCompCheckDaily') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('payCompCheckDaily').timeBased().everyDays(1).atHour(9).inTimezone('Asia/Taipei').create();
  return { ok: true, triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
}

/* 單日核定超過 10 小時（2026-11-01 Eason）：照實核定、不擋，每天 09:00 把各店「前一天」核定超過 10 小時的人列進通知匣（一般件）。
   打卡端的上班卡擋法在 Rest.gs；這裡只看主管實際核了幾小時（approved 分頁，同一天多筆取最新）。
   總部的 HQ- 同仁由央廚表鏡像過去（Mirror.js），兩家店同一人同一天只列一次。觸發器用 payroll_rest_trigger_setup 建。 */
var PAY_DAY_MAX_H = 10;
function payRestOverList_(date) {
  const out = [], seen = {};
  payStoreList().forEach(function (s) {
    if (!payHasClock(s.code)) return;
    const day = buildLatestApprovedMap(payClockRead(s.code, 'approved'))[date] || {};
    Object.keys(day).forEach(function (emp) {
      const r = day[emp], h = payNum(r.approved_hours);
      const nm = String(r.name || emp).replace(/\s/g, ''), k = nm + '|' + date;
      if (h <= PAY_DAY_MAX_H || seen[k]) return;
      seen[k] = true;
      out.push({ store: payStore(s.code), store_name: String(s.name || s.code), emp_id: emp, name: String(r.name || emp),
                 hours: h, periods: String(r.periods || '') });
    });
  });
  return out;
}
function payYesterday_() {
  return Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Taipei', 'yyyy-MM-dd');
}
/** {action:'payroll_rest_check', admin_key, date?} → 那天（預設昨天）各店核定超過 10 小時的人（唯讀）。 */
function handlePayrollRestCheck(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : payYesterday_();
  return { ok: true, date: date, list: payRestOverList_(date) };
}
function payRestOverDaily() {
  payRestOverRun_(payYesterday_());
  try {
    const r = payOtMonthSync_();
    if (r.errors.length || r.write_errors.length) payInboxNotify_('月加班同步有店失敗', '算不出來：' + r.errors.join('、') + '；寫不進去：' + r.write_errors.join('、'), 'otmonth-fail-' + r.date, '超時檢查', 'otmonth');
  } catch (e) { payInboxNotify_('月加班同步失敗', String(e), 'otmonth-fail-' + payYesterday_(), '超時檢查', 'otmonth'); }
}
/** 實際檢查＋通知（date 可指定，給手動補跑）。任何一步失敗都不拋例外。 */
function payRestOverRun_(date) {
  const md = (+date.slice(5, 7)) + '/' + (+date.slice(8, 10));
  let list = [];
  try { list = payRestOverList_(date); } catch (err) {
    payInboxNotify_('超時檢查讀不到資料', md + ' 核定工時檢查失敗：' + err, 'restover-fail-' + date, '超時檢查', 'restover');
    return { list: [], inbox: false, error: String(err) };
  }
  if (!list.length) return { list: [], inbox: false };
  const by = {};
  list.forEach(function (x) { (by[x.store_name] = by[x.store_name] || []).push(x); });
  const lines = Object.keys(by).map(function (st) {
    return '【' + st + '】\n' + by[st].map(function (x) { return x.name + ' ' + x.hours + ' 小時（' + x.periods + '）'; }).join('\n');
  });
  const inbox = payInboxNotify_(md + ' 核定超過 ' + PAY_DAY_MAX_H + ' 小時：' + list.length + ' 人',
    md + ' 各店核定工時超過一天 ' + PAY_DAY_MAX_H + ' 小時（照實核定、已照付）：\n' + lines.join('\n') +
    '\n\n請提醒店長排班與下班時間控制在 ' + PAY_DAY_MAX_H + ' 小時內。', 'restover-' + date, '超時檢查', 'restover');
  return { list: list, inbox: inbox };
}
/** {action:'payroll_rest_trigger_setup', admin_key} → 建每天 09:00 的 payRestOverDaily（同名先刪，重跑不疊）。 */
function handlePayrollRestTriggerSetup(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'payRestOverDaily') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('payRestOverDaily').timeBased().everyDays(1).atHour(9).inTimezone('Asia/Taipei').create();
  return { ok: true, triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
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
     請假時數＝leave 分頁該月合計；忘刷＝pairShifts 未配對的日數＋核定狀態標「少刷N組卡」的日數；
     遲到／早退＝核定狀態字樣的日數 */
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
      const le = payHasLateEarly(st);
      if (le.late) b.late++;
      if (le.early) b.early++;
    });
  });
  events.forEach(function (e) {
    const d = tsDateStr(normCellTs(e.ts));
    if (d.slice(0, 7) !== ym) return;
    if (String(e.status) !== 'ok') box(String(e.emp_id)).abnormal++;
  });
  const paired = pairShifts(dropDupIgnored_(events, dupIgnoreSet_(approvedMap)));   // 主管認定的重複卡不算忘刷（同 payCollect）
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
  // 「第N段下班／上班無打卡」的日子也算忘刷日（與 payCollect 2b) 同一口徑，否則總表跟薪資對不起來）
  Object.keys(approvedMap).forEach(function (d) {
    if (String(d).slice(0, 7) !== ym) return;
    Object.keys(approvedMap[d]).forEach(function (emp) {
      if (payMissingCards(approvedMap[d][emp].status_text)) missDays[String(emp) + '|' + d] = true;
    });
  });
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

/* ═══════════════════ 出勤紀錄匯出（2026-10-09，唯讀）═══════════════════
 * 用途：正式出勤紀錄（勞基法施行細則第 21 條，逐日記載至分鐘），給勞檢／稽核／同仁索取。
 * 依人、依月，整月每一天都列（沒上班的日子也列、空白）。
 * 純函式 payAttendanceBuild 不碰試算表，供 tests/attendance-export.test.js 用 vm 抽出實跑。
 * ⚠ 日期／時間一律過 normCellDate／normCellTs（Sheets 會把日期轉成 Date 物件）；
 *   核定取最新沿用 buildLatestApprovedMap、跨夜歸上班那天沿用 dayPunchSegments（pairShifts），不自己重寫。 */
var PAY_ATT_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function payAttStatusLabel(status) {
  const s = String(status || '');
  if (s === 'rejected_out_of_range') return '超出範圍，未入帳';
  if (s === 'pending_device_approval') return '新裝置待核准，未入帳';
  if (s === 'rejected_duplicate') return '重複打卡，被系統擋下';
  if (s === 'rejected_device') return '裝置不符，被系統擋下';
  return '未入帳（' + s + '）';
}
function payAttendanceBuild(ym, rosterRows, eventRows, approvedRows, leaveRows, onlyEmp, requestRows) {
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const dates = [];
  for (var d = 1; d <= dim; d++) dates.push(ym + '-' + (d < 10 ? '0' : '') + d);

  const events = eventRows.map(function (e) {
    return { ts: normCellTs(e.ts), emp_id: String(e.emp_id), type: String(e.type || ''), status: String(e.status || '') };
  });
  const approvedMap = buildLatestApprovedMap(approvedRows);
  const segEvents = dropDupIgnored_(events, dupIgnoreSet_(approvedMap));   // 打卡段不列主管認定的重複卡（2026-11-06）
  const nameToEmp = {};
  rosterRows.forEach(function (r) { nameToEmp[String(r.name || '').trim()] = String(r.emp_id); });

  // 同仁：在職者＋當月有任何紀錄者（離職前的最後一個月也要匯得出來）
  const has = {};
  events.forEach(function (e) { if (tsDateStr(e.ts).slice(0, 7) === ym) has[e.emp_id] = true; });
  Object.keys(approvedMap).forEach(function (dt) {
    if (dt.slice(0, 7) !== ym) return;
    Object.keys(approvedMap[dt]).forEach(function (emp) { has[String(emp)] = true; });
  });
  const leaveBy = {};      // emp -> date -> [{type,hours}]
  leaveRows.forEach(function (l) {
    const emp = nameToEmp[String(l['姓名'] || '').trim()];
    const dt = normCellDate(l['日期']);
    if (!emp || dt.slice(0, 7) !== ym) return;
    has[emp] = true;
    const hrs = l['時數'] === '' || l['時數'] == null ? null : Number(l['時數']);
    ((leaveBy[emp] = leaveBy[emp] || {})[dt] = (leaveBy[emp][dt] || [])).push({ type: String(l['假別'] || ''), hours: isNaN(hrs) ? null : hrs });
  });
  // 已核准申請附的證明（2026-10-30）：emp -> date -> [{label, attach_id}]；作廢、退回、審核中不算
  const attachBy = {};
  (requestRows || []).forEach(function (q) {
    const aid = String(q.attach_id || ''), dt = normCellDate(q.date);
    if (!aid || String(q.status) !== 'approved' || dt.slice(0, 7) !== ym) return;
    const emp = String(q.emp_id);
    ((attachBy[emp] = attachBy[emp] || {})[dt] = (attachBy[emp][dt] || [])).push({ label: String(q.leave_type || q.kind || ''), attach_id: aid });
  });
  // 忘打卡補登第幾次（2026-11-06 Eason：主管核准的忘打卡申請，同一人同一個月依日期排；第 3 次起出勤紀錄表標記）：emp -> date -> N
  const missBy = {}, missList = {};
  (requestRows || []).forEach(function (q) {
    const dt = normCellDate(q.date);
    if (String(q.kind) !== 'miss' || String(q.status) !== 'approved' || dt.slice(0, 7) !== ym) return;
    (missList[String(q.emp_id)] = missList[String(q.emp_id)] || []).push({ dt: dt, c: String(normCellTs(q.created_at) || '') });
  });
  Object.keys(missList).forEach(function (emp) {
    missList[emp].sort(function (a, b) { return a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : (a.c < b.c ? -1 : a.c > b.c ? 1 : 0); })
      .forEach(function (x, i) { (missBy[emp] = missBy[emp] || {})[x.dt] = i + 1; });   // 同一天兩張取後面那個號碼
  });
  const people = rosterRows.filter(function (r) {
    const emp = String(r.emp_id);
    if (onlyEmp && onlyEmp !== emp) return false;
    return String(r.active).toLowerCase() === 'true' || has[emp];
  }).sort(function (a, b) { return String(a.emp_id) < String(b.emp_id) ? -1 : 1; });

  const employees = people.map(function (r) {
    const emp = String(r.emp_id);
    const mine = segEvents.filter(function (e) { return e.emp_id === emp; });
    var apprH = 0, leaveH = 0, workDays = 0, pendingDays = 0;
    const days = dates.map(function (dt) {
      const seg = dayPunchSegments(mine, emp, dt).segments;
      const invalid = mine.filter(function (e) { return tsDateStr(e.ts) === dt && e.status !== 'ok'; })
        .sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })
        .map(function (e) { return { time: tsHm(e.ts), type: e.type, status: e.status, label: payAttStatusLabel(e.status) }; });
      const rec = (approvedMap[dt] || {})[emp];
      const lv = ((leaveBy[emp] || {})[dt] || []);
      const lvH = lv.reduce(function (a, x) { return a + (x.hours || 0); }, 0);
      var row = {
        date: dt, weekday: PAY_ATT_WEEKDAYS[new Date(dt + 'T00:00:00Z').getUTCDay()],
        segments: seg, invalid: invalid, approved: !!rec,
        periods: rec ? String(rec.periods || '') : '',
        approved_hours: rec && rec.approved_hours !== '' && rec.approved_hours != null ? Number(rec.approved_hours) : null,
        status_text: rec ? String(rec.status_text || '') : '',
        manager: rec ? String(rec.manager_name || '') : '',
        leave: lv, leave_hours: Math.round(lvH * 100) / 100,
        attach: (attachBy[emp] || {})[dt] || [],
        miss_n: (missBy[emp] || {})[dt] || null   // 這天核准的忘打卡是本月第幾次（第 3 次起畫面與 Excel 標記）
      };
      if (row.approved_hours != null) { apprH += row.approved_hours; if (row.approved_hours > 0) workDays++; }
      else if (seg.length) pendingDays++;
      leaveH += lvH;
      return row;
    });
    return { emp_id: emp, name: String(r.name || ''), active: String(r.active).toLowerCase() === 'true',
      days: days, totals: { approved_hours: Math.round(apprH * 100) / 100, leave_hours: Math.round(leaveH * 100) / 100,
        work_days: workDays, pending_days: pendingDays, miss_count: (missList[emp] || []).length } };
  });
  return { employees: employees };
}
/** 管理者：某店某月出勤紀錄（逐日、整月）。{admin_key, store, ym, emp_id?} 唯讀，不寫任何東西。 */
function handlePayrollAttendanceExport(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const st = payStore(body.store);
  if (!payHasClock(st)) return { ok: false, error: 'no_clock',
    message: '門市 ' + st + ' 尚未連結打卡系統，沒有出勤紀錄可匯出。' };
  const srow = payStoreRow(st) || {};
  const built = payAttendanceBuild(ym, payClockRead(st, 'roster'), payClockRead(st, 'events'),
    payClockRead(st, 'approved'), payClockRead(st, 'leave'), body.emp_id ? String(body.emp_id) : '', payClockRead(st, 'requests'));
  return { ok: true, store: st, store_name: String(srow.name || st), ym: ym,
    generated_at: nowTaipeiIso(), employees: built.employees };
}
/** 管理者：出勤紀錄表上的申請證明（2026-10-30）。{admin_key, store, attach_id} → {ok, mime, data}。
 *  驗：這個附件掛在那家店某筆已核准的申請上、而且檔案在附件資料夾裡（不能拿 ID 撈任意雲端檔）。唯讀。 */
function handlePayrollAttachGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const st = payStore(body.store), id = String(body.attach_id || '');
  if (!id || !payHasClock(st)) return { ok: false, error: 'not_found' };
  if (!payClockRead(st, 'requests').some(function (q) { return String(q.attach_id || '') === id && String(q.status) === 'approved'; }))
    return { ok: false, error: 'not_found' };
  const file = reqAttachFile_(id);
  if (!file) return { ok: false, error: 'not_found' };
  const blob = file.getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/* ═══════════════════ 操作紀錄（payroll_audit 唯讀，2026-11-04） ═══════════════════
 * 管理系統薪酬管理「操作紀錄」分頁讀這支：定案／解鎖、假別設定、假日同步等寫進 payroll_audit 的列，新到舊，最多 1000 筆。
 * body：ym（選填，YYYY-MM；只回該月份的列）、store（選填）、limit（選填，1～1000）。
 * 範圍（body.scope 是門市陣列）：只回 store 在負責範圍內的列；store 空白的「全域列」（假日同步、集團假別設定等）只有系統管理者／舊路看得到。
 * operator 原樣回（管理系統代轉時由 mini 覆寫成「姓名（帳號）（管理系統）」）。純讀、不寫任何東西。 */
const PAY_OPLOG_MAX = 1000;
function handlePayrollAuditGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym == null ? '' : body.ym).trim();
  if (ym && !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return { ok: false, error: 'bad_ym' };
  const sc = payScopeOf_(body), scoped = Array.isArray(sc);
  const rawSt = String(body.store == null ? '' : body.store).trim();
  const stF = rawSt ? payScopeNorm_(rawSt) : '';
  let limit = Number(body.limit);
  if (!isFinite(limit) || limit < 1) limit = PAY_OPLOG_MAX;
  limit = Math.min(Math.floor(limit), PAY_OPLOG_MAX);
  ensurePayrollSheets();
  const out = [];
  payRead('audit').forEach(function (r, i) {
    const rs = String(r.store == null ? '' : r.store).trim().toUpperCase();
    if (scoped && (!rs || sc.indexOf(rs) < 0)) return;
    if (stF && rs !== stF) return;
    const rym = String(r.ym == null ? '' : r.ym).trim();
    if (ym && rym !== ym) return;
    out.push({ ts: String(normCellTs(r.ts) || ''), ym: rym, action: String(r.action == null ? '' : r.action),
               operator: String(r.operator == null ? '' : r.operator), reason: String(r.reason == null ? '' : r.reason),
               store: rs, __i: i });
  });
  out.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.__i - a.__i; });
  const total = out.length;
  const items = out.slice(0, limit).map(function (x) { delete x.__i; return x; });
  return { ok: true, items: items, total: total, truncated: total > items.length };
}

/* ═══════════════════ 跨店支援自動帶入：讀資料＋handler（2026-11-05；規則本身在引擎區段）═══════════════════ */

/** 讀 xmap／門市表／主檔／打卡核定，交給 paySupportAutoCore_。ym < PAY_XSUP_FROM 回 null（一張表都不讀）。 */
function paySupportAuto_(ym, home, withDays, until) {
  if (!payXsupOn_(ym)) return null;
  const d = payXsupData_(withDays);
  if (until) d.until = String(until);   // 損益估算：只算到 as_of（含）
  return paySupportAutoCore_(ym, home, d);
}
function payXsupData_(withDays) {
  let xmap = [];
  try { xmap = payRead('xmap'); } catch (e) { xmap = []; }
  return {
    xmap: xmap, stores: payRead('store'), master: payRead('master'),
    approvedMap: function (code) { return buildLatestApprovedMap(payClockRead(code, 'approved')); },
    events: function (code) { return payClockRead(code, 'events'); },
    tsDate: tsDateStr, today: todayTaipeiStr(), days: !!withDays,
  };
}
/** payroll_month／payroll_inputs 共用：把 auto 列合進 inputs（就地）並回 support_auto；生效月之前回 null。 */
function payXsupApply_(ym, st, inputs, withDays) {
  if (!payXsupOn_(ym)) return null;
  const d = payXsupData_(withDays);
  const auto = paySupportAutoCore_(ym, st, d);
  const master = d.master.filter(function (m) { return payStore(m.store) === st && String(m.active).toLowerCase() === 'true'; });
  const incoming = payCrossIncomingCore_(ym, st, d);
  return payApplySupportAuto_(inputs, master, auto, { home: st, storeBy: payXsupStoreBy_(d.stores), dropCross: !auto.empty }, incoming);
}

/** 工時列除了支援以外全部是 0／空白（＝使用者沒動過，審查 #1） */
function payInputRowBlank_(r) {
  const NUMS = ['hours', 'extra_ot', 'personal_h', 'sick_h', 'menstrual_h', 'disaster_h', 'annual_h', 'deduct_days', 'work_days',
                'wage_override', 'holiday_h', 'custom_add_amt', 'custom_ded_amt', 'full_attend', 'meal_on'];
  for (let i = 0; i < NUMS.length; i++) if (payNum(r[NUMS[i]])) return false;
  if (String(r.custom_add_label || '').trim() || String(r.custom_ded_label || '').trim()) return false;
  if (r.dorm_override !== '' && r.dorm_override != null) return false;
  return r.custom_add_more === '[]' || !r.custom_add_more;
}
/** 打卡對照寫入（dzy 同步）：{rows:[{emp_no,pay_store,acct_store,emp_id,state,not_support}], synced_at}。
 *  ·pay_store／acct_store 必須是門市表現有代碼，否則丟棄（不經 payStore() 補預設店——空白不可以變成光復，§7-8）；state 一定要帶（GPT #5）。
 *  ·有 scope 時：pay_store∈L 的列＝本次決定發薪歸屬，整批換掉；pay_store∉L、acct_store∈L 的列存成 acct_only，
 *    只給打卡店看「有打卡沒主檔」提醒，不影響別店發薪（GPT #3／#5：不可以刪掉、也不可以偽造別店的對照）。
 *  ·舊快照不可以蓋新快照（GPT #10）：synced_at 比現有的舊 → stale_snapshot。
 *  ·離職同仁（GPT #4）：管理系統保留到離職月份的下個月底，上個月還沒算完薪水時對照仍在；這裡照快照整批換。
 *  ·同一人、同一份打卡表、同一個帳號只留一列（共用打卡表去重，§7-5）。 */
function handlePayrollXmapSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.rows)) return { ok: false, error: 'rows_required' };
  const synced = String(body.synced_at || '').trim() || nowTaipeiIso();
  const storeBy = payXsupStoreBy_(payRead('store'));
  const sc = payScopeOf_(body), L = Array.isArray(sc) ? sc : null;
  const inL = function (c) { return !L || L.indexOf(payXsupCode_(c)) >= 0; };
  const ck = function (x) { return payXsupClockKey_(x.acct_store, storeBy) || payXsupCode_(x.acct_store); };
  const fullKey = function (x) { return String(x.emp_no) + '|' + payXsupCode_(x.pay_store) + '|' + ck(x) + '|' + payXsupId_(x.emp_id) + '|' + String(x.state || 'confirmed'); };
  let dropped = 0;
  const clean = [], seen = {};
  body.rows.forEach(function (r) {
    if (!r || typeof r !== 'object') { dropped++; return; }
    const ps = payXsupCode_(r.pay_store), as = payXsupCode_(r.acct_store);
    const eid = String(r.emp_id == null ? '' : r.emp_id).trim(), no = String(r.emp_no == null ? '' : r.emp_no).trim();
    const state = String(r.state == null ? '' : r.state).trim();
    if (!ps || !as || !storeBy[ps] || !storeBy[as] || !eid || !no || (state !== 'confirmed' && state !== 'suggested')) { dropped++; return; }
    if (!inL(ps) && !inL(as)) { dropped++; return; }
    const row = { emp_no: no, pay_store: ps, acct_store: as, emp_id: eid,
                  not_support: payXsupBool_(r.not_support) ? 'true' : 'false', synced_at: synced, state: state,
                  acct_only: inL(ps) ? '' : 'true' };
    const k = fullKey(row) + '|' + row.acct_only;
    if (seen[k]) return;
    seen[k] = true;
    clean.push(row);
  });
  const auth = clean.filter(function (x) { return !x.acct_only; });
  const accOnly = clean.filter(function (x) { return x.acct_only; });
  const tNew = Date.parse(synced);
  let staleSnap = false;
  const wrote = payWriteLocked_(['xmap'], function () {
    let all;
    try { all = payRead('xmap'); } catch (e) { all = []; }
    const mine = all.filter(function (x) { return !payXsupBool_(x.acct_only) && inL(x.pay_store); });   // 這次有權決定的列
    let newest = NaN;
    mine.forEach(function (x) {
      const v = Date.parse(String(x.synced_at || ''));
      if (!isNaN(v) && (isNaN(newest) || v > newest)) newest = v;
    });
    if (!isNaN(tNew) && !isNaN(newest) && tNew < newest) { staleSnap = true; return; }
    const rest = all.filter(function (x) {
      if (!payXsupBool_(x.acct_only)) return !inL(x.pay_store);
      return !inL(x.acct_store) && !inL(x.pay_store);   // 打卡端提醒列：本次負責的打卡店重給；發薪店本人同步過就由正式列取代
    });
    const authKeys = {};
    rest.concat(auth).forEach(function (x) { if (!payXsupBool_(x.acct_only)) authKeys[fullKey(x)] = true; });
    const acc = accOnly.filter(function (x) { return !authKeys[fullKey(x)]; });
    payReplaceAll('xmap', rest.concat(auth, acc));
  });
  if (!wrote) return PAY_BUSY_;
  if (staleSnap) return { ok: false, error: 'stale_snapshot', message: '對照快照比現有的舊，沒有寫入' };
  return { ok: true, count: clean.length, dropped: dropped, synced_at: synced };
}
/** 打卡對照讀取：回 rows＋synced_at（最新一筆）。有 scope 時只回 pay_store 在負責門市的列（trim 另守一次）。 */
function handlePayrollXmapGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const sc = payScopeOf_(body), L = Array.isArray(sc) ? sc : null;
  let rows = [];
  try { rows = payRead('xmap'); } catch (e) { rows = []; }
  rows = rows.filter(function (r) {
    return !L || L.indexOf(payXsupCode_(r.pay_store)) >= 0 || L.indexOf(payXsupCode_(r.acct_store)) >= 0;
  }).map(function (r) {
    return { emp_no: String(r.emp_no), pay_store: payXsupCode_(r.pay_store), acct_store: payXsupCode_(r.acct_store),
             emp_id: String(r.emp_id), not_support: payXsupBool_(r.not_support), state: String(r.state || 'confirmed'),
             acct_only: payXsupBool_(r.acct_only), synced_at: String(r.synced_at || '') };
  });
  let synced = '';
  // acct_only 是別店同步留下的提醒列，不代表本店同步過（Fable 複審 #4：否則前端 6 小時內不會再同步本店對照）
  rows.forEach(function (r) { if (!r.acct_only && r.synced_at > synced) synced = r.synced_at; });
  return { ok: true, rows: rows, synced_at: synced };
}
/** 差異逐筆決定（spec §7-4）：{store, ym, emp_id, code, choice:'auto'|'keep', auto_h}。
 *  只改該員那一列 payroll_input 的 support 欄，不碰本店時數（不借道整份「儲存工時」，不會把歸集值凍結成手動列）。
 *  auto＝刪掉該店的手填列（下次計算就變打卡帶入）；keep＝該店手填列加 keep＋auto_h（打卡值再變才會再提醒）。
 *  「僅 support」列（hours_manual='0'，由「儲存工時」對本店沒有歸集的人建立）刪到沒有支援就整列移除。
 *  不會新建列；找不到該員工時數列回 ok:false／no_row。 */
function handlePayrollSupportDecide(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  if (!payXsupOn_(ym)) return { ok: false, error: 'xsup_off', message: PAY_XSUP_FROM + ' 以前的月份沒有打卡帶入' };
  const st = payStore(body.store);
  const emp = String(body.emp_id == null ? '' : body.emp_id).trim();
  const code = payXsupCode_(body.code);
  const choice = String(body.choice || '');
  if (!emp || !code) return { ok: false, error: 'bad_request' };
  if (choice !== 'auto' && choice !== 'keep') return { ok: false, error: 'bad_choice' };
  const isFinal = function () { return payRead('run').some(function (r) { return String(r.ym) === ym && payStore(r.store) === st && String(r.status) === 'final'; }); };
  if (isFinal()) return { ok: false, error: 'locked', message: ym + ' 已鎖定，請先解鎖' };
  const storeBy = payXsupStoreBy_(payRead('store'));
  let result = 'ok';
  const wrote = payWriteLocked_(['input', 'run'], function () {
    if (isFinal()) { result = 'locked'; return; }   // 鎖外查完到拿到寫鎖之間被鎖定（GPT #9）
    const all = payRead('input');
    let idx = -1;
    all.forEach(function (r, i) { if (idx < 0 && String(r.ym) === ym && payStore(r.store) === st && String(r.emp_id).trim() === emp) idx = i; });
    if (idx < 0) { result = 'no_row'; return; }
    const r = Object.assign({}, all[idx]);
    let sup;
    try { sup = (r.support === '' || r.support == null) ? [] : JSON.parse(r.support); } catch (e) { result = 'support_error'; return; }
    if (!Array.isArray(sup)) { result = 'support_error'; return; }
    const hit = function (s) { return s && !payXsupIsAuto_(s) && paySupportCode_(s, storeBy) === code; };
    if (!sup.some(hit)) { result = 'no_manual'; return; }
    if (choice === 'auto') sup = sup.filter(function (s) { return !hit(s); });
    else sup = sup.map(function (s) { return hit(s) ? Object.assign({}, s, { code: code, keep: true, auto_h: payR2(payNum(body.auto_h)) }) : s; });
    r.support = JSON.stringify(sup);
    r.updated_at = nowTaipeiIso();
    const rest = all.filter(function (x, i) { return i !== idx; });
    const supOnly = String(r.hours_manual == null ? '' : r.hours_manual).trim() === '0';
    payReplaceAll('input', (supOnly && !sup.length) ? rest : rest.concat([r]));
  });
  if (!wrote) return PAY_BUSY_;
  if (result === 'locked') return { ok: false, error: 'locked', message: ym + ' 已鎖定，請先解鎖' };
  if (result === 'support_error') return { ok: false, error: 'support_error', message: '這位同仁的支援資料格式壞了，請先修正' };
  if (result === 'no_row') return { ok: false, error: 'no_row' };   // 沒有工時列＝沒有手填可決定（審查 #6；前端顯示並重新載入）
  const res = { ok: true, ym: ym, store: st, emp_id: emp, code: code, choice: choice, result: result };
  /* 改成打卡值：草稿裡還是舊手填的金額，而 support_auto_h 前後一樣、payroll_month 判不出過期（GPT #1）→ 這裡直接重算。
     沒算過的月份不主動算（照舊由開頁決定）；重算失敗不影響這次決定，前端會照常重讀。 */
  if (result === 'ok' && choice === 'auto' && payBuildRunResults(ym, st)) {
    const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: st });
    res.recalc = !!(calc && calc.ok);
  }
  return res;
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
  if (!payReplaceKeep_('bonus', function (b) { return String(b.ym) !== ym || payStore(b.store) !== st; }, rows)) return PAY_BUSY_;
  return { ok: true, ym: ym, store: st, count: rows.length };
}

/* ═══════════════════ 儀表板：人事成本趨勢 ═══════════════════ */

/** 回近 N 個月的彙總（依門市）。資料全部取自既有 run／item，不需額外輸入。 */
/** 成本口徑「要扣回」的扣項（薪資費用小計＝應收−這些）：
 *    ①任何請假扣款（/_leave$/，新假別自動涵蓋）②不足時數倒扣
 *    ③宿舍代扣（2026-08-24 Eason 改口徑：同仁付的房租不是人事成本，從薪資費用扣除、另列租金收入）
 *  ⚠ 勞健保自付額**不在此列**——那是薪資的一部分，只是代扣去繳保費，仍算人事成本。
 *  與 payroll.html 的 isCostReduceKey＋宿舍、payroll_mock 的 isReduce 同一口徑。
 *  ⚠ 2026-08-23 前這裡是兩份寫死的五個舊 key——新假別（住院傷病、安胎、家庭照顧…）的扣款
 *    沒被扣回，儀表板趨勢與集團總覽的薪資費用被高估。改口徑要三處一起：本函式／payroll.html／mock。 */
/** 同仁自付的勞健保／團保／退休金（2026-08-24 起從薪資費用扣除）。
 *  ⚠ 與宿舍不同：這筆錢公司代扣後要繳給勞保局／健保署，**必須加回保險成本**，
 *    否則人事總成本會少一筆（公司確實付出去了）。宿舍才是真的留在公司（租金收入）。 */
function payIsInsSelfKey(k) {
  const s = String(k);
  return s === 'labor_ins' || s === 'health_ins' || s === 'group_ins' || s === 'pension';
}
function payIsReduceKey(k) {
  const s = String(k);
  return /_leave$/.test(s) || s === 'shortfall_hours' || s === 'dormitory' || payIsInsSelfKey(s);
}

/* ── 公司負擔勞保／健保／退休金：依員工主檔逐人加總（2026-08-24 修前後端不一致）──
 * 背景：這三項早就改成「員工設定逐人填、系統自動加總」，但只有 payroll.html 跟上，
 * 儀表板與集團總覽還在讀參數設定的手填值 → 同一家店在兩個畫面數字不同
 * （央廚實測差 40,365：主檔加總 63,426 vs 參數 23,061）。
 * ⚠ 折算方式必須與 payroll.html 的 costTotals 一致：勞保／退休金按在職比例、健保整月。
 * ⚠ 負責人勞健保（co_owner，全公司一份分攤）與團險（co_group，每店一份）維持參數手填，
 *   那兩項不是逐人費用。 */

/** 一次讀 master 建「門市 → {emp_id: 公司負擔三項}」對照表（效能鐵則：不可在逐人／逐店迴圈裡 payRead）。 */
function payMasterInsMap() {
  const out = {};
  payRead('master').forEach(function (m) {
    const st = payStore(m.store);
    (out[st] = out[st] || {})[String(m.emp_id)] = {
      l: payNum(m.co_labor), h: payNum(m.co_health), p: payNum(m.co_pension) };
  });
  return out;
}

/** 依該月 run 列逐人加總公司負擔；主檔全沒填（合計 0）回 null，呼叫端退回參數手填值。 */
function payAutoCompanyIns(runs, insMap) {
  var L = 0, H = 0, P = 0;
  (runs || []).forEach(function (r) {
    const m = (insMap || {})[String(r.emp_id)];
    if (!m) return;
    const pr = String(r.is_full_time).toLowerCase() === 'true' ? payNum(r.ratio) : 1;
    L += m.l * pr; H += m.h; P += m.p * pr;
  });
  return (L + H + P) > 0 ? { l: L, h: H, p: P } : null;
}

/** 公司負擔合計＝(逐人加總或參數值) ＋ 負責人勞健保 ＋ 團險。
 *  個別項目為 0 時退回參數值——與 payroll.html 的 `if(autoCo[k]>0) co[k]=autoCo[k]` 一致。 */
function payCompanyTotal(cfg, auto) {
  const l = (auto && auto.l > 0) ? auto.l : payNum(cfg.co_labor);
  const h = (auto && auto.h > 0) ? auto.h : payNum(cfg.co_health);
  const p = (auto && auto.p > 0) ? auto.p : payNum(cfg.co_pension);
  return l + h + p + payNum(cfg.co_owner) + payNum(cfg.co_group);
}

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
  const insMap = (payMasterInsMap())[st] || {};   // 迴圈外先建表
  const runByYm = {}, itemByYm = {};
  runs.forEach(function (r) { (runByYm[String(r.ym)] = runByYm[String(r.ym)] || []).push(r); });
  items.forEach(function (i) { (itemByYm[String(i.ym)] = itemByYm[String(i.ym)] || []).push(i); });

  const out = list.map(function (ym) {
    const rs = runByYm[ym] || [], its = itemByYm[ym] || [];
    if (!rs.length) return { ym: ym, has: false };
    var gross = 0, hours = 0, ft = 0, pt = 0, ot = 0, reduce = 0, bonus = 0, supportH = 0, insSelf = 0, custAdd = 0;
    // 每人的加班費（拆「支援造成的加班」用）
    const otByEmp = {};
    its.forEach(function (i) {
      const k = String(i.item_key), a = payNum(i.amount);
      if (String(i.item_type) === 'earning') {
        if (payIsOtKey(k)) { ot += a; otByEmp[String(i.emp_id)] = (otByEmp[String(i.emp_id)] || 0) + a; }
        if (k.indexOf('bonus_') === 0) bonus += a;
        // 自訂加薪不計入薪資費用（2026-08-24）：性質不定（行銷／補發…），成本分類獨立列出讓人自己歸科目
        if (k === 'custom_add') custAdd += a;
      } else if (payIsReduceKey(k)) {
        reduce += a;
        if (payIsInsSelfKey(k)) insSelf += a;   // 自付額：從薪資費用扣掉，但下面要加回保險成本
      }
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
    // 公司負擔改為依主檔逐人加總（與成本分類頁一致），主檔沒填才退回參數手填值
    const co = payCompanyTotal(cfg, payAutoCompanyIns(rs, insMap));
    const salaryCost = gross - reduce - custAdd;
    // 保險成本＝公司負擔＋代扣的同仁自付額（＝實際繳出去的金額）；總成本因此與改口徑前相同
    const insCost = co + insSelf;
    const people = ft + pt;
    return { ym: ym, has: true,
             salary_cost: payR0(salaryCost), company: payR0(insCost), ins_self: payR0(insSelf),
             total_cost: payR0(salaryCost + insCost),
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

  const insMapAll = payMasterInsMap();   // 迴圈外先建表（不可在逐店迴圈裡 payRead）
  const rows = payStoreList().map(function (st) {
    const code = String(st.code), rs = runBy[code] || [], its = itemBy[code] || [];
    const cfg = payConfig(code);
    // 公司負擔改為依主檔逐人加總（與成本分類頁一致），主檔沒填才退回參數手填值
    const co = payCompanyTotal(cfg, payAutoCompanyIns(rs, insMapAll[code] || {}));
    if (!rs.length) return { store: code, name: String(st.name || code), has: false, company: payR0(co) };
    var gross = 0, net = 0, hours = 0, ft = 0, pt = 0, ot = 0, bonus = 0, reduce = 0, insSelf = 0, custAdd = 0;
    rs.forEach(function (r) {
      gross += payNum(r.gross); net += payNum(r.net); hours += payNum(r.total_hours);
      if (String(r.is_full_time).toLowerCase() === 'true') ft++; else pt++;
    });
    its.forEach(function (i) {
      const k = String(i.item_key), a = payNum(i.amount);
      if (String(i.item_type) === 'earning') {
        if (payIsOtKey(k)) ot += a;
        if (k.indexOf('bonus_') === 0) bonus += a;
        if (k === 'custom_add') custAdd += a;   // 不計入薪資費用（同 trend）
      } else if (payIsReduceKey(k)) {
        reduce += a;
        if (payIsInsSelfKey(k)) insSelf += a;   // 自付額：薪資費用扣掉、保險成本加回
      }
    });
    const salaryCost = gross - reduce - custAdd;
    const insCost = co + insSelf;   // 保險成本＝公司負擔＋代扣自付額
    return { store: code, name: String(st.name || code), has: true,
             people: ft + pt, ft: ft, pt: pt, hours: payR2(hours),
             gross: payR0(gross), net: payR0(net), overtime: payR0(ot), bonus: payR0(bonus),
             salary_cost: payR0(salaryCost), company: payR0(insCost), ins_self: payR0(insSelf),
             total_cost: payR0(salaryCost + insCost),
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

/** 請假資料有兩個來源，額度一定要兩邊都算（2026-08-27 Eason 指出 6、7 月沒被算進去）。
 *
 *  ① 打卡系統 `leave` 分頁——主管在值班核定頁登記的，打卡上線後的月份走這裡。
 *  ② 薪資的 `payroll_input` 手動工時——打卡上線前、或還沒裝打卡的門市，請假時數是直接
 *     填在工時分頁的「事假 H／病假 H…」欄位裡，**不會**進 leave 分頁。
 *
 *  ⚠ 只讀 ① 會讓額度嚴重低估：實際踩到的例子是 B 君病假已用 133.73H（5–8 月），
 *    只算 leave 分頁卻只有 32.48H；央廚 7 月六位同仁的請假更是一筆都沒算到。
 *  ⚠ 同一個月兩邊都有資料時「以手動為準」——因為計薪本來就是這個規則
 *    （payInputsBase 的手動列會整筆蓋掉歸集值），額度跟著計薪走才不會出現
 *    「薪水扣了但額度沒扣」的矛盾。這也與 payAnnualInfo 算特休的做法一致。 */
var PAY_INPUT_LEAVE_FIELDS = [
  { field: 'personal_h',  code: 'personal'  },
  { field: 'sick_h',      code: 'sick'      },
  { field: 'menstrual_h', code: 'menstrual' },
  { field: 'annual_h',    code: 'annual'    },
  { field: 'disaster_h',  code: 'disaster'  },
];
function payLeaveFlatRows(store, types, nameToEmp) {
  const st = payStore(store);
  const out = [];
  const manualMonths = {};   // 'emp_id|yyyy-MM' → 該月由手動工時作主
  payRead('input').forEach(function (r) {
    if (payStore(r.store) !== st) return;
    const m = String(r.ym);
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    const emp = String(r.emp_id);
    manualMonths[emp + '|' + m] = true;
    PAY_INPUT_LEAVE_FIELDS.forEach(function (f) {
      const h = payNum(r[f.field]);
      if (!h) return;
      // 手動工時只有「整月時數」沒有日期，掛在該月 1 號——曆年與每月上限的判斷都只看年月
      out.push({ emp_id: emp, date: m + '-01', hours: h, code: f.code });
    });
  });
  let leaveRows = [];
  try { leaveRows = payClockRead(st, 'leave'); } catch (err) { leaveRows = []; }
  leaveRows.forEach(function (l) {
    const emp = nameToEmp[String(l['姓名'] || '').trim()];
    if (!emp) return;
    const d = normCellDate(l['日期']);
    if (manualMonths[emp + '|' + String(d).slice(0, 7)]) return;   // 同月以手動為準，不重複計
    out.push({ emp_id: emp, date: d, hours: Number(l['時數']) || 0,
               code: payLeaveCode(String(l['假別'] || ''), types) });
  });
  return out;
}

/** 同仁自己看得到的假別額度（2026-08-27）。
 *  ⚠ 規則與值班核定頁／薪資頁完全同源（都呼叫 payLeaveUsage），不另寫一套，
 *    否則同仁看到的剩餘天數會跟主管看到的對不上，那比不顯示更糟。
 *  顯示範圍刻意收斂：事假與病假一律列（同仁最常問的就這兩個），
 *  其他假別只在「今年真的請過」時才出現——避免每個人都看到育嬰假 720 日、安胎休養假這些
 *  跟他無關的項目。要放寬就改 MY_LEAVE_ALWAYS。 */
var MY_LEAVE_ALWAYS = ['personal', 'sick'];
function payMyLeaveQuota(empId, empName, ym, store) {
  const st = payStore(store);
  const types = payLeaveTypes(st);
  const cfg = payConfig(st);
  const dayH = payLeaveDayHours(cfg);
  // 兩個來源都要（leave 分頁＋手動工時），只有本人的列
  const nameMap = {}; nameMap[String(empName || '').trim()] = String(empId);
  const flat = payLeaveFlatRows(st, types, nameMap)
    .filter(function (x) { return String(x.emp_id) === String(empId); });
  let spans = [];
  try { spans = payRead('leave_span'); } catch (err) { spans = []; }
  const q = payLeaveUsage(String(empId), ym, types, cfg, null, flat, spans);
  const out = [];
  types.forEach(function (t) {
    const v = q[t.code] || {};
    const used = Number(v.used_days) || 0;
    // 特休不列在這裡：它是週年制、額度由 payAnnualQuota 另算，混進來會顯示成「無上限」誤導同仁
    if (v.basis === 'tenure' || t.cap_basis === 'tenure') return;
    if (payIsCompType(t)) return;   // 補休另外一列（payMyPayslipFor_ 的 comp：餘額＋最早到期日），不在這裡顯示成「無上限」
    if (!used && MY_LEAVE_ALWAYS.indexOf(t.code) < 0) return;
    // 額度法規是以「日」定的，但畫面統一用時數呈現（Eason 2026-08-27 指定，
    // 與特休、核定工時、薪資單全部同一個單位），所以日與時數兩種都回，前端只顯示時數。
    out.push({ code: t.code, name: t.name, basis: v.basis || '',
               used_days: payR2(used), used_h: v.used_h,
               cap_days: v.cap_days == null ? null : payR2(v.cap_days),
               cap_h: v.cap_h,
               remain_days: v.remain_days == null ? null : payR2(v.remain_days),
               remain_h: v.remain_h,
               blocked: !!v.blocked });
  });
  // 請過的排前面，同仁一眼看到自己動用了哪些
  out.sort(function (a, b) { return (b.used_days || 0) - (a.used_days || 0); });
  return out;
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
  // 離職後 60 天內還能查自己的薪資單，超過就關（2026-10-09 Eason；規則在 LineHub.gs lineHubCanView_，與 LINE 一致）。
  // 沒部署 LineHub 的環境（不該發生）一律只給在職的人查。
  if (String(me.active).toLowerCase() !== 'true' &&
      !(typeof lineHubCanView_ === 'function' && lineHubCanView_(me))) return { ok: false, error: 'left_expired' };
  return payMyPayslipFor_(me, meStore, String(body.ym || currentYmTaipei()));
}

/** 已確認身分的同仁（名冊列 me、在 meStore 找到）→ 薪資單回應。
 *  my_payslip（專屬連結金鑰）與 line_my_payslip（LINE 身分，LineHub.gs）共用這一支，回應格式完全相同。 */
function payMyPayslipFor_(me, meStore, ym) {
  // 員工所屬門市（主檔為準；找不到就用預設店）
  const mineMaster = payRead('master').filter(function (m) { return String(m.emp_id) === String(me.emp_id); })[0];
  const stMy = payStore((mineMaster && mineMaster.store) || meStore);
  const run = payRead('run').filter(function (r) {
    return String(r.ym) === ym && String(r.emp_id) === String(me.emp_id) && payStore(r.store) === stMy;
  })[0];
  const annual = payAnnualInfo(ym, stMy)[String(me.emp_id)] || null;
  /* 計時同仁一律不顯示假別額度（Eason 2026-09-03 定案，與「計時沒有特休」同一個政策）。
     回空陣列，前端 payLeaveCard 的 `if (!list || !list.length) return ''` 就整張卡不畫。
     ⚠ 主檔查不到的人也當計時處理——bootstrap 建出來的預設身分就是計時，
     寧可不顯示，也不要對還沒設定身分的新人顯示錯的額度。 */
  const meFullTime = !!mineMaster && (mineMaster.is_full_time === true ||
    String(mineMaster.is_full_time).toLowerCase() === 'true');
  // 假別額度與薪資結算與否無關（同仁隨時都該查得到自己還剩多少假），所以三個回傳路徑都要帶
  const leaveQuota = meFullTime ? payMyLeaveQuota(me.emp_id, me.name, ym, stMy) : [];
  // 補休（2026-11-01 改每月加減結算）：看「今天這個月」的補休帳（不是查詢的月份）；計時同仁回 allowed:false。出錯就不顯示，不影響薪資單。
  let comp = null;
  try {
    comp = mineMaster ? payCompMonthBook(payCompToday().slice(0, 7)).forEmp(mineMaster, stMy) : { allowed: false, ot_h: 0, used_h: 0, balance_h: 0 };
  } catch (err) { comp = null; }
  if (!run) return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資尚未結算',
                     annual: annual, leave_quota: leaveQuota, comp: comp };
  if (String(run.status) !== 'final') {
    return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資結算中，尚未定案',
             annual: annual, leave_quota: leaveQuota, comp: comp };
  }
  const items = payRead('item').filter(function (i) {
    return String(i.ym) === ym && String(i.emp_id) === String(me.emp_id) && payStore(i.store) === stMy;
  });
  return { ok: true, ym: ym, name: me.name, ready: true, annual: annual, leave_quota: leaveQuota, comp: comp,
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

/** {action:'payroll_leave_options', store, mgr_key|admin_key, ym?} → 假別清單 ＋ 每位同仁的
 *  已用與剩餘額度（額度用完的回 blocked）。兩個畫面共用：值班核定頁的假別下拉（值班主管金鑰）、
 *  薪資頁工時分頁的「假別額度」（管理金鑰，2026-08-27 加）。
 *
 *  ⚠ 身分驗證跨後端：薪酬是全集團共用一套，不認得央廚／總部的主管金鑰，
 *    所以主管那條反過來開該店自己的打卡試算表比對 managers 分頁——與 my_payslip 跨店驗身分同一招。 */
/** payroll_leave_options／payroll_annual_left 共用的身分驗證：管理金鑰（薪資頁）直接放行，否則走值班主管金鑰那條。
 *  通過回 null，不通過回錯誤物件。 */
function payLeaveAuth_(body, st) {
  if (checkAdmin(body)) return null;
  const key = String(body.mgr_key || '').trim();
  if (!key) return { ok: false, error: 'unauthorized' };
  // 薪酬門市表沒有這家店（或沒填 clock_ss_id）＝薪資還沒接這家店的打卡：回 no_clock_ss，不要讀到空的 managers 再回 unauthorized
  // （2026-10-28：墨竹亭光復 MZTGF 不在門市表，營運系統一直記成「主管金鑰無效」，其實金鑰是對的）
  if (!payHasClock(st)) return { ok: false, error: 'no_clock_ss' };
  let mgrs = [];
  try { mgrs = payClockRead(st, 'managers'); } catch (err) { return { ok: false, error: 'no_clock_ss' }; }
  const hit = mgrs.filter(function (m) {
    return String(m.key) === key && String(m.active).toLowerCase() === 'true';
  })[0];
  return hit ? null : { ok: false, error: 'unauthorized' };
}

function handlePayrollLeaveOptions(body) {
  const st = payStore(body.store);
  const deny = payLeaveAuth_(body, st);
  if (deny) return deny;

  const ym = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? body.ym : nowTaipeiIso().slice(0, 7);
  const compOn = payCompStoreOn_(st);
  const types = payLeaveTypes(st).filter(function (t) { return compOn || !payIsCompType(t); });
  const cfg = payConfig(st);
  const master = payRead('master').filter(function (m) {
    return String(m.active).toLowerCase() === 'true' && payStore(m.store) === st;
  });
  let spans = [];
  try { spans = payRead('leave_span'); } catch (err) { spans = []; }

  // 額度要看「整個曆年」，含本月已請的——與計薪的 used_before 不同，這裡是給主管當下判斷用
  const dayH = payLeaveDayHours(cfg);
  const nameToEmp = {};
  master.forEach(function (e) { nameToEmp[String(e.name).trim()] = String(e.emp_id); });
  // leave 分頁 ＋ 手動工時兩個來源（見 payLeaveFlatRows）。同仁端走同一支，兩邊數字保證一致。
  const flat = payLeaveFlatRows(st, types, nameToEmp);
  const quotas = {};
  let compBook = null;
  try { compBook = compOn ? payCompMonthBook(ym) : null; } catch (err) { compBook = null; }
  const compCode = (types.filter(payIsCompType)[0] || {}).code || PAY_COMP_CODE;   // 表上自訂的補休列 code 可能不是 comp
  master.forEach(function (e) {
    quotas[String(e.emp_id)] = payLeaveUsage(String(e.emp_id), ym, types, cfg, null, flat, spans);
    // 補休帳（2026-11-01 改每月加減結算）：值班核定頁的下拉標「本月剩 N 小時」；只有計時反灰，餘額不夠也照常核定（可以先休後補）
    if (compBook) {
      try {
        const cs = compBook.forEmp(e, st);
        cs.comp = true; cs.monthly = true; cs.cap_days = null; cs.blocked = !cs.allowed;
        quotas[String(e.emp_id)][compCode] = cs;
      } catch (err) { /* 算不出來就沒有額度提示，不擋核定 */ }
    }
  });
  return { ok: true, store: st, ym: ym, types: types, quotas: quotas,
           day_hours: dayH, rule_parental: PAY_PARENTAL,
           // 期限規則要用：某人某假別的事件日（結婚登記日／分娩日…），前端據此擋過期的假
           events: payLeaveEventMap(st) };
}

/** {action:'payroll_annual_left', store, mgr_key|admin_key, ym?} → 每位正職的剩餘特休（唯讀）。
 *  給門市營運系統「自動排班」班表在名字下方顯示（2026-10-12 Eason）。數字跟薪資頁工時分頁、
 *  同仁薪資單同一支 payAnnualInfo，計時同仁沒有特休回 null。另開一支、不併進 payroll_leave_options，
 *  是因為 payAnnualInfo 要掃各店 leave 分頁，併進去會拖慢核定頁的假別下拉。 */
function handlePayrollAnnualLeft(body) {
  const st = payStore(body.store);
  const deny = payLeaveAuth_(body, st);
  if (deny) return deny;
  const ym = /^\d{4}-\d{2}$/.test(String(body.ym || '')) ? body.ym : nowTaipeiIso().slice(0, 7);
  const info = payAnnualInfo(ym, st);
  const annual = {};
  Object.keys(info).forEach(function (e) {
    const a = info[e];
    annual[e] = a ? { left_days: Math.round(a.left_h / 8 * 10) / 10, left_h: a.left_h, days: a.days, used_h: a.used_h, pe: a.pe } : null;
  });
  return { ok: true, store: st, ym: ym, annual: annual };
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

/* ═══════════════════ 門市範圍（body.scope）守門與回應裁切 ═══════════════════
 * 管理系統（平台）負責門市權限，經 Mac mini 代轉時每個薪資請求都帶 body.scope：
 *   沒有欄位／'*' → 不限制（舊路與系統管理者）；字串陣列 → 只能碰名單內的門市；其他形狀 → scope_bad。
 * 只守門與裁切，不改任何計算。比較前門市代碼一律 trim＋大寫（payStore 再補預設店）。 */
const PAY_SCOPE_ADMIN_ONLY = ['payroll_group', 'payroll_store_set', 'payroll_holiday_sync', 'payroll_get',
                              'payroll_comp_check', 'payroll_comp_trigger_setup',   // 補休檢查看全部門市（2026-11-01）
                              'payroll_rest_check', 'payroll_rest_trigger_setup',   // 超時檢查看全部門市（2026-11-01）
                              'payroll_ot_preview', 'payroll_ot_month_sync'];   // 加班費新舊並列試算（2026-11-06）只給總管理

function payScopeNorm_(v) { return payStore(String(v == null ? '' : v).trim()).toUpperCase(); }

/** 回 null（沒欄位）｜'*'｜正規化後的門市陣列｜'BAD' */
function payScopeOf_(body) {
  if (!body || typeof body !== 'object' || body.scope === undefined) return null;
  const s = body.scope;
  if (s === '*') return '*';
  if (!Array.isArray(s)) return 'BAD';
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (typeof s[i] !== 'string' || !s[i].trim()) return 'BAD';
    out.push(payScopeNorm_(s[i]));
  }
  return out;
}

function payScopeDeny_(detail, empIds) {
  const r = { ok: false, error: 'scope_forbidden', detail: detail };
  if (empIds) r.emp_ids = empIds;
  return r;
}

/** 請求端守門：通過回 null，否則回要直接回給呼叫端的錯誤物件 */
function payScopeGuard_(action, body) {
  const sc = payScopeOf_(body);
  if (sc === 'BAD') return { ok: false, error: 'scope_bad', detail: 'scope 必須是 * 或門市代碼陣列' };
  if (sc === null || sc === '*') return null;
  if (PAY_SCOPE_ADMIN_ONLY.indexOf(action) >= 0) return payScopeDeny_('集團功能，限系統管理者');
  /* 從打卡名冊建立：會把整個打卡名冊（共用打卡表時含別店的人）寫進主檔，不經 emp_out_of_scope 檢查 → 限系統管理者（fix2-3） */
  if (action === 'payroll_bootstrap') return payScopeDeny_('admin_only');
  if (action === 'payroll_store_get') return null;
  const st = payScopeNorm_(body.store);
  const inL = function (s) { return sc.indexOf(s) >= 0; };
  /* 操作紀錄（唯讀）：沒帶 store＝由 handler 只留負責門市的列；帶了就要在負責範圍內 */
  if (action === 'payroll_audit_get') return String(body.store == null ? '' : body.store).trim() && !inL(st) ? payScopeDeny_('門市 ' + st + ' 不在負責範圍') : null;
  if (action === 'payroll_master_get' && sc.length === 0) return null;   // 空名單：回空殼（見 trim）
  if (action === 'payroll_config_set' && !String(body.store || '').trim()) return payScopeDeny_('集團預設參數限系統管理者');
  if (action === 'payroll_leave_type_set' && !String(body.store || '').trim()) return payScopeDeny_('集團共用假別限系統管理者');
  if (!inL(st)) return payScopeDeny_('門市 ' + st + ' 不在負責範圍');
  if (action === 'payroll_master_set') {
    const rows = Array.isArray(body.master) ? body.master : [];
    for (let i = 0; i < rows.length; i++) {
      const to = payScopeNorm_((rows[i] && rows[i].store) || st);
      if (!inL(to)) return payScopeDeny_('不能把人員移到負責範圍外的門市 ' + to);
    }
    /* 新加進本店主檔的編號，若已出現在範圍外門市的主檔或工時 → 擋（final review I2：
       特休／假別統計以 emp_id 跨店讀工時，借別店員工的編號建檔就能動到別店的人）。本店主檔原有的人照常。 */
    const here = {}, foreign = {};
    payRead('master').forEach(function (m) {
      const k = payScopeId_(m && m.emp_id), s = payScopeNorm_(m && m.store);
      if (s === st) here[k] = true; else if (!inL(s)) foreign[k] = true;
    });
    let inp = [];
    try { inp = payRead('input'); } catch (err) { inp = []; }
    inp.forEach(function (r) { if (!inL(payScopeNorm_(r && r.store))) foreign[payScopeId_(r && r.emp_id)] = true; });
    for (let j = 0; j < rows.length; j++) {
      const k = payScopeId_(rows[j] && rows[j].emp_id);
      if (k && !here[k] && foreign[k]) return payScopeDeny_('emp_out_of_scope', [k]);
    }
  }
  /* 工時／假別事件日／獎金：每個 emp_id 都要在負責門市的主檔裡（final review I2；獎金 fix2-4）。
     前端 saveAtt 有範圍時只送本店主檔的人（工時表裡也有只打卡、未建主檔的編號）。
     獎金 bonuses:[{emp_id,amount,...}]：金額 0 的列 handler 會略過，但這裡照樣檢查（每個非空 emp_id）。 */
  /* 打卡對照寫入（2026-11-05，spec §7-7）：每一列的 pay_store 都要在負責門市內 */
  if (action === 'payroll_xmap_set') {
    const xr = Array.isArray(body.rows) ? body.rows : [];
    for (let i = 0; i < xr.length; i++) {
      const ps = payXsupCode_(xr[i] && xr[i].pay_store), as = payXsupCode_(xr[i] && xr[i].acct_store);
      if (!inL(ps) && !inL(as)) return payScopeDeny_('打卡對照的門市 ' + (ps || '（空白）') + '／' + (as || '（空白）') + ' 不在負責範圍');
    }
  }
  if (action === 'payroll_input_set' || action === 'payroll_leave_event_set' || action === 'payroll_bonus_set' || action === 'payroll_support_decide') {
    const listOf = function (arr) { return (Array.isArray(arr) ? arr : []).map(function (r) { return r && r.emp_id; }); };
    const ids = action === 'payroll_input_set'
      ? Object.keys(body.inputs && typeof body.inputs === 'object' ? body.inputs : {})
      : action === 'payroll_support_decide' ? [body.emp_id]
      : listOf(action === 'payroll_bonus_set' ? body.bonuses : body.events);
    const own = {};
    payRead('master').forEach(function (m) { if (inL(payScopeNorm_(m && m.store))) own[payScopeId_(m && m.emp_id)] = true; });
    const bad = [];
    ids.forEach(function (id) { const k = payScopeId_(id); if (k && !own[k] && bad.indexOf(k) < 0) bad.push(k); });
    if (bad.length) return payScopeDeny_('emp_out_of_scope', bad);
  }
  return null;
}

function payScopeId_(v) { return String(v == null ? '' : v).trim(); }

/** 回應端裁切：scope 為陣列時，stores 只留名單內且去掉 clock_ss_id；master_get 一律多回 scope */
function payScopeTrim_(action, body, res) {
  if (!res || typeof res !== 'object') return res;
  const sc = payScopeOf_(body);
  if (action === 'payroll_master_get' && res.ok) res.scope = (Array.isArray(sc) ? sc : '*');
  if (!Array.isArray(sc)) return res;
  if (action === 'payroll_xmap_get' && res.ok && Array.isArray(res.rows)) {
    res.rows = res.rows.filter(function (r) { return sc.indexOf(payXsupCode_(r && r.pay_store)) >= 0 || sc.indexOf(payXsupCode_(r && r.acct_store)) >= 0; });
  }
  if (['payroll_master_get', 'payroll_month', 'payroll_store_get'].indexOf(action) >= 0 && Array.isArray(res.stores)) {
    res.stores = res.stores.filter(function (s) { return sc.indexOf(payScopeNorm_(s && s.code)) >= 0; })
      .map(function (s) { const c = {}; Object.keys(s).forEach(function (k) { if (k !== 'clock_ss_id') c[k] = s[k]; }); return c; });
  }
  return res;
}

/** 就地把每個 handler 包成 guard → 原 handler → trim（Code.gs 於請求時才複製 PAYROLL_HANDLERS，所以就地包有效） */
function payScopeWrap_(handlers) {
  Object.keys(handlers).forEach(function (action) {
    const orig = handlers[action];
    handlers[action] = function (body) {
      /* 帶 scope 的請求先驗管理金鑰再守門（fix2-1）：守門會讀主檔／工時、回 emp_ids，
         不先驗金鑰的話，沒金鑰的人能拿 scope_forbidden／emp_out_of_scope 探出員工編號。 */
      if (body && typeof body === 'object' && body.scope !== undefined && !checkAdmin(body)) return { ok: false, error: 'unauthorized' };
      const deny = payScopeGuard_(action, body);
      if (deny) return deny;
      /* 有範圍時 store 先正規化（trim＋大寫）再交給 handler（final review I3）：
         守門比的是正規化後的代碼，handler 不正規化，' cf ' 會寫成另一家「店」。'*'／沒欄位不動。 */
      if (Array.isArray(payScopeOf_(body)) && action !== 'payroll_audit_get') {   // 操作紀錄的 store 可以空白（＝負責的全部門市），不能被補成預設店
        body.store = payScopeNorm_(body.store);
        if (action === 'payroll_master_set' && Array.isArray(body.master)) {
          body.master.forEach(function (m) { if (m && String(m.store == null ? '' : m.store).trim()) m.store = payScopeNorm_(m.store); });
        }
      }
      if (action === 'payroll_master_get') {
        const sc = payScopeOf_(body);
        if (Array.isArray(sc) && sc.length === 0) {
          if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
          return { ok: true, stores: [], master: [], config: {}, scope: [] };
        }
      }
      return payScopeTrim_(action, body, orig(body));
    };
  });
}

const PAYROLL_HANDLERS = {
  payroll_setup:        handlePayrollSetup,
  payroll_bootstrap:    handlePayrollBootstrap,
  payroll_master_get:   handlePayrollMasterGet,
  payroll_master_set:   handlePayrollMasterSet,
  payroll_config_set:   handlePayrollConfigSet,
  payroll_holiday_set:  handlePayrollHolidaySet,
  payroll_gov_holidays: handlePayrollGovHolidays,
  payroll_holiday_sync: handlePayrollHolidaySync,
  payroll_inputs:      handlePayrollInputs,
  payroll_input_set:    handlePayrollInputSet,
  payroll_month:        handlePayrollMonth,
  payroll_calc:         handlePayrollCalc,
  payroll_ot_month_sync: handlePayrollOtMonthSync,   // 月加班 36／46 小時同步到各店（4-15，只給總管理）
  payroll_ot_preview:   handlePayrollOtPreview,   // 加班費新舊算法唯讀並列（2026-11-06）
  payroll_get:          handlePayrollGet,
  payroll_item_upsert:  handlePayrollItemUpsert,
  payroll_finalize:     handlePayrollFinalize,
  my_payslip:           handleMyPayslip,
  payroll_punch:        handlePayrollPunch,
  payroll_attendance_export: handlePayrollAttendanceExport,
  payroll_attach_get: handlePayrollAttachGet,
  payroll_audit_get:    handlePayrollAuditGet,
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
  payroll_comp_check:      handlePayrollCompCheck,
  payroll_comp_trigger_setup: handlePayrollCompTriggerSetup,
  payroll_rest_check:      handlePayrollRestCheck,
  payroll_rest_trigger_setup: handlePayrollRestTriggerSetup,
  payroll_annual_left:     handlePayrollAnnualLeft,
  payroll_xmap_set:        handlePayrollXmapSet,
  payroll_xmap_get:        handlePayrollXmapGet,
  payroll_support_decide:  handlePayrollSupportDecide,
  pnlPayroll:              handlePnlPayroll_,
  pnlLaborEstimate:        handlePnlLaborEstimate_,
};
payScopeWrap_(PAYROLL_HANDLERS);

// ---------- 損益系統唯讀端點（T14，mala-pnl-auto#15） ----------
// 給集團「通用門市自動損益系統」讀某門市當月人事成本（依穩定鍵）用。
// Eason 2026-09-25 選方案 C：按「鎖定本月」時，前端把算好的 costTotals()（穩定鍵版本，
// 見 payroll.html 的 costStable()）隨 payroll_finalize(lock:true) 一起送上來，後端只存
// 進新分頁 payroll_cost_snapshot，不重算——保證這支端點回的數字跟畫面上人事成本分類
// 逐項一致，不會有前後端各自算一次、口徑慢慢漂移的風險（口徑本身還在調整中，見
// mala-payroll skill「人事成本分類」那節 2026-09-03 已經改過三次）。
//
// ⚠ 快照**不含**：custom_add／custom_ded（自訂加薪／扣款，畫面上本來就獨立列、不計入
// 薪資費用，性質不定要人自己判斷科目歸屬）、宿舍收入（g.dorm，畫面上是「已從薪資費用
// 扣除，損益表勿重複計列」的參考區塊，不是損益表的正式科目）。損益系統這兩塊要用其他
// 管道手動取得，不要假設 pnlPayroll 的 total 已經包含它們——它本來就沒有，跟畫面上
// 「人事總成本」那個數字的定義完全一致（那個數字本身也不含這兩塊）。
//
// 請求（跟既有 payroll_* 動作同一種格式，doPost 把整包 body 原樣傳給 handler，
// 不是 {action, payload:{...}} 那種巢狀寫法）：
//   POST {action:'pnlPayroll', key, ym:'YYYY-MM', store}
//
// handlePnlPayroll_ 本身完全唯讀：不呼叫任何 setValue/setValues/appendRow/insertSheet/
// deleteRow/clear/DriveApp.create/PropertiesService...set.../LockService。CacheService 的
// get/put 只用來記金鑰錯誤次數，不是分頁寫入。讀快照走 pnlReadSnapshot_，直接
// getSheetByName、分頁不存在就回 null，不透過會在分頁不存在時 insertSheet 的 paySheet()。
// pnlSnapshotUpsert_／pnlSnapshotRemove_ 才是真正的寫入，只從 handlePayrollFinalize 的
// 鎖定/解鎖流程呼叫（Eason 核准「鎖定流程可以多一次對新分頁的寫入」），端點本身不會呼叫它們。
//
// 不含任何人名、員工編號、逐人金額：rows 全部是科目彙總，support 只到「門市」層級，
// 而且白名單化（見 pnlSanitizeSupport_）不信任前端傳來的鍵/型別。

/* 損益系統金鑰比對：型別/長度先擋，長度一致才逐字元 XOR 累加、比對到底（定時比較），
   避免用 === 在第一個不同字元就提早 return 洩漏時間差。連續失敗 20 次鎖 10 分鐘
   （CacheService，跟 checkAdmin 用的 ADMIN_KEY 是兩把完全不同的鑰匙、互不影響；
   2026-09-25 審查把門檻從 5 次調高到 20 次——這支端點給自動化系統定期輪詢用，
   5 次太容易被系統本身的重試/多門市輪詢誤觸發，20 次仍然能擋住真正的暴力猜測）。
   門檻剛好被跨過的那一刻（第 20 次失敗）記一筆 audit，之後在鎖定期間再打不重複記。
   回傳 null＝通過；否則回傳要放進 error 欄的字串代碼。
   endpoint（選填，T15 審查加）：只影響第 20 次失敗那筆 audit 的文字，讓稽核表看得出來是
   哪一支端點被打——pnlPayroll／pnlLaborEstimate 共用同一把 PNL_KEY、同一套失敗計數
   （CACHE_KEY 不變，鎖定狀態互相影響是刻意的：同一把鑰匙的暴力猜測不分是打哪一支端點），
   不傳＝沿用舊文字 'pnlPayroll'（既有呼叫路徑 handlePnlPayroll_ 沒有跟著這次一起改，
   行為與加這個參數之前完全相同）。 */
var PNL_KEY_MAX_FAILS = 20;
function checkPnlKey_(key, endpoint) {
  var cache = CacheService.getScriptCache();
  var CACHE_KEY = 'pnlkeyfail_payroll';
  var fails = Number(cache.get(CACHE_KEY) || 0);
  if (fails >= PNL_KEY_MAX_FAILS) return 'AUTH_LOCKED';

  var real = PropertiesService.getScriptProperties().getProperty('PNL_KEY');
  var match = false;
  if (real && typeof key === 'string' && key.length === real.length) {
    var diff = 0;
    for (var i = 0; i < real.length; i++) diff |= real.charCodeAt(i) ^ key.charCodeAt(i);
    match = diff === 0;
  }
  if (!match) {
    var next = fails + 1;
    cache.put(CACHE_KEY, String(next), 600);
    if (next >= PNL_KEY_MAX_FAILS) {
      try {
        payAppend('audit', [{ ts: nowTaipeiIso(), ym: '', action: 'pnl_key_locked',
                              operator: 'system', reason: (endpoint || 'pnlPayroll') + ' 金鑰連續失敗達 ' + PNL_KEY_MAX_FAILS + ' 次，鎖定 10 分鐘', store: '' }]);
      } catch (auditErr) { /* 記錄失敗也不能擋住原本的 AUTH 回應 */ }
    }
    return 'AUTH';
  }
  cache.remove(CACHE_KEY);
  return null;
}

/* support 白名單化（2026-09-25 審查要求）：不信任前端傳來的物件結構——只留字串鍵、
   限制鍵長與鍵數，每個值一律 payNum() 轉數字，擋住異常巨大或型別怪異的 payload
   把快照分頁弄壞（例如鍵是超長字串、值是巢狀物件、或想塞 __proto__ 這種鍵名）。 */
var PNL_SUPPORT_MAX_KEYS = 50;
var PNL_SUPPORT_MAX_KEY_LEN = 40;
function pnlSanitizeSupport_(support) {
  var out = {};
  if (!support || typeof support !== 'object') return out;
  var keys = Object.keys(support).filter(function (k) {
    return typeof k === 'string' && k.length > 0 && k.length <= PNL_SUPPORT_MAX_KEY_LEN &&
      k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
  }).slice(0, PNL_SUPPORT_MAX_KEYS);
  keys.forEach(function (k) { out[k] = payNum(support[k]); });
  return out;
}

/* 寫入：只從 handlePayrollFinalize 的鎖定流程呼叫。同 (ym, store) 覆寫（upsert），
   跟既有 handlePayrollLeaveEventSet 同一套「讀→濾掉同鍵→append→整表覆寫」手法。
   金額欄位一律 payNum() 防呆（前端理論上都是數字，但別假設）；support 先過
   pnlSanitizeSupport_ 白名單化，只到門市層級、不含姓名。 */
function pnlSnapshotUpsert_(ym, store, snap) {
  var rows = [];
  try { rows = payRead('cost_snapshot'); } catch (e) { rows = []; }
  var kept = rows.filter(function (r) { return !(String(r.ym) === ym && payStore(r.store) === store); });
  var row = {
    ym: ym, store: store,
    base_ft: payNum(snap.base_ft), ot_ft: payNum(snap.ot_ft), attend_ft: payNum(snap.attend_ft),
    allow_ft: payNum(snap.allow_ft), mgr: payNum(snap.mgr), meal: payNum(snap.meal),
    other: payNum(snap.other), pt: payNum(snap.pt),
    bonus_sales: payNum(snap.bonus_sales), bonus_perf: payNum(snap.bonus_perf), bonus_proj: payNum(snap.bonus_proj),
    ins_ft_deduct: payNum(snap.ins_ft_deduct), dorm_ft_deduct: payNum(snap.dorm_ft_deduct), ins_pt_deduct: payNum(snap.ins_pt_deduct), dorm_pt_deduct: payNum(snap.dorm_pt_deduct),
    co_labor: payNum(snap.co_labor), co_health: payNum(snap.co_health), co_pension: payNum(snap.co_pension),
    co_owner: payNum(snap.co_owner), co_group: payNum(snap.co_group),
    ins_self: payNum(snap.ins_self), yearend: payNum(snap.yearend),
    support_json: JSON.stringify(pnlSanitizeSupport_(snap.support)),
    total: payNum(snap.total), updated_at: nowTaipeiIso()
  };
  payReplaceAll('cost_snapshot', kept.concat([row]));
}

/* 移除某 (ym, store) 的快照（2026-09-25 審查加）。用在：①解鎖時——這個月不再是定案
   數字，舊快照留著會讓端點把上一輪鎖定的答案誤當成現在的答案繼續回傳；②鎖定但沒送
   cost_snapshot——沒有新資料可信，寧可讓端點誠實回 NO_SNAPSHOT，也不要用舊資料充數。
   只寫快照分頁，只從 handlePayrollFinalize 呼叫，try/catch 包住不影響鎖定/解鎖本身。
   沒有東西可刪就不寫（省一次 API 往返）。 */
function pnlSnapshotRemove_(ym, store) {
  var rows = [];
  try { rows = payRead('cost_snapshot'); } catch (e) { rows = []; }
  var kept = rows.filter(function (r) { return !(String(r.ym) === ym && payStore(r.store) === store); });
  if (kept.length === rows.length) return;
  payReplaceAll('cost_snapshot', kept);
}

/* 只給唯讀端點用：直接 getSheetByName，分頁不存在、或沒有這個 (ym, store) 的快照，
   一律回 null——絕不透過 payRead()／paySheet()，那條路徑在分頁不存在時會 insertSheet
   建表頭。理論上同一 (ym, store) 只會有一筆（pnlSnapshotUpsert_ 是 upsert），
   保險起見取最後一筆命中的。 */
function pnlReadSnapshot_(ym, store) {
  var sh = getSS().getSheetByName(PAY_SHEET_NAME.cost_snapshot);
  if (!sh) return null;
  var rows = readSheetAsObjects(sh).rows.map(stripRowIndex);
  var hit = null;
  rows.forEach(function (r) {
    if (String(r.ym) === ym && payStore(r.store) === store) hit = r;
  });
  return hit;
}

/** {action:'pnlPayroll', key, ym, store} → 讀「鎖定本月」時存的人事成本快照，完全唯讀。
 *  該月未鎖定（任何一位同仁的 run 狀態不是 final）→ NOT_FINAL，不回草稿數字。
 *  已鎖定但找不到快照（鎖定當下沒送 cost_snapshot，或這個月是在本功能上線前鎖的，
 *  或快照寫入失敗過，或曾經解鎖過而快照被清掉）→ NO_SNAPSHOT，訊息教 Eason 怎麼補
 *  （解鎖→鎖定）。個人姓名、逐人金額一律不回；support 只到門市層級。 */
function handlePnlPayroll_(body) {
  var keyErr = checkPnlKey_(body.key, 'pnlPayroll');
  if (keyErr) return { ok: false, error: keyErr };

  var ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'BAD_INPUT' };
  var st = payStore(body.store);

  var runRows = payRead('run').filter(function (r) { return String(r.ym) === ym && payStore(r.store) === st; });
  if (!runRows.length) return { ok: false, error: 'NOT_FINAL' };
  var allFinal = runRows.every(function (r) { return r.status === 'final'; });
  if (!allFinal) return { ok: false, error: 'NOT_FINAL' };

  var snap = pnlReadSnapshot_(ym, st);
  if (!snap) {
    return { ok: false, error: 'NO_SNAPSHOT',
      message: '這個月鎖定時還沒有這支快照功能，或快照寫入失敗，請重新鎖定一次（解鎖→鎖定）補上快照' };
  }

  var support = {};
  try { support = JSON.parse(snap.support_json || '{}'); } catch (e) { support = {}; }

  return {
    ok: true, ym: ym, store: st,
    rows: {
      base_ft: payNum(snap.base_ft), ot_ft: payNum(snap.ot_ft), attend_ft: payNum(snap.attend_ft),
      allow_ft: payNum(snap.allow_ft), mgr: payNum(snap.mgr), meal: payNum(snap.meal),
      other: payNum(snap.other), pt: payNum(snap.pt),
      bonus_sales: payNum(snap.bonus_sales), bonus_perf: payNum(snap.bonus_perf), bonus_proj: payNum(snap.bonus_proj),
      ins_ft_deduct: payNum(snap.ins_ft_deduct), dorm_ft_deduct: payNum(snap.dorm_ft_deduct), ins_pt_deduct: payNum(snap.ins_pt_deduct), dorm_pt_deduct: payNum(snap.dorm_pt_deduct),
      co_labor: payNum(snap.co_labor), co_health: payNum(snap.co_health), co_pension: payNum(snap.co_pension),
      co_owner: payNum(snap.co_owner), co_group: payNum(snap.co_group),
      ins_self: payNum(snap.ins_self), yearend: payNum(snap.yearend)
    },
    support: support,
    total: payNum(snap.total)
  };
}

// ---------- 損益系統唯讀端點（T15，mala-pnl-auto，月中人事成本估算） ----------
// pnlPayroll（上面）只在「鎖定本月」時回鎖定快照的定案數字；損益系統想在月中就先看一份
// 估算值（給草稿損益表參考），本端點就是給這個用的：即時重算「當月 1 日至昨天（台北）」
// 的人事成本，鍵與 pnlPayroll 完全相同，另外多回 as_of／days_elapsed／days_in_month／method。
//
// ⚠ 這不是另一套算薪水的邏輯——底薪/加班/請假扣款/保險/年終提列全部原封不動呼叫既有的
// payCalcOne（跟 handlePayrollCalc 用的是同一支函式），估算只做這幾件事：
//   ① 用 payCollect 的新 cutoffDate 參數（透過 payInputsBase 的新 cutoffDate 第三參數傳入），
//      只歸集「昨天以前」的核定/打卡/請假資料，再疊上 payroll_input 手動覆蓋（support／
//      meal_on／full_attend／wage_override／手動輸入門市的整月工時），與 handlePayrollCalc
//      用的 payInputsBase 同一套合併規則（2026-09-27 審查加——原本只呼叫 payCollect，
//      漏掉手動覆蓋那一半，跨店支援請款、計時全勤/餐費補助勾選、PT 時薪調整、無打卡門市
//      的工時都會估成 0）；
//   ② 給 payCalcOne 一份「虛擬離職日＝昨天（或員工原本的到職/離職日，取較早者）」的員工物件，
//      借用 payRatio 既有的「月中到職／離職才折算」機制算出「已過天數 ÷ 當月天數」的比例——
//      這跟底薪/固定津貼要求的「月薪×已過天數÷當月天數」是同一條公式，不必另寫一套折算邏輯，
//      也不會動到 payRatio 本身（leave_date 在 payCalcOne 整條路徑上只有 payRatio 這一處會讀，
//      改的是傳入的複本，不影響試算表或呼叫端手上的原始 e）。
// 人事成本分類（base_ft/ot_ft/pt/co_labor…那組穩定鍵）則是 payroll.html costTotals()／
// costStable() 的逐字 port（見 pnlEstimateClassify_，改動記錄同一份規則正本：
// mala-payroll skill「人事成本分類」那節）——分類是「怎麼把 payCalcOne 已經算好的 earn/ded
// 歸科目」，不是重新計算金額，所以不算「另寫一套薪資引擎」。tests/pnl-labor-estimate-anti-drift
// .test.js 直接從 payroll.html 抽出 costTotals/costStable/allocGapHours，用同一組輸入跟
// pnlEstimateClassify_ 比對，兩邊口徑一旦漂移測試就會紅。
//
// 估不了／刻意不含（與 pnlPayroll 對齊，見 docs/pnl-labor-estimate.md「可估／不可估的鍵」）：
//   custom_add／custom_ded（自訂加薪扣款，性質不定要人自己判斷科目）、
//   宿舍收入 g.dorm（已從薪資費用扣除的參考區塊，不是正式科目）。
// `red_days_missing:true`（2026-09-27 審查加）：當月紅字天數還沒設定時附上這個旗標，
// 損益端看到就該顯示提醒——這種情況下 redDays 當 0 計，只影響加班/不足時數門檻，不影響底薪。
//
// 完全唯讀：進分頁前先用 pnlEstimateSheetsReady_() 逐一 getSheetByName 確認分頁存在
// （缺分頁→NO_DATA），絕不透過會在分頁不存在時 insertSheet 的 payRead()/paySheet()——
// 確認過存在之後才呼叫 payRead／payConfig／payHolidayRow／payLeaveTypes 等既有唯讀 helper，
// 這些 helper 內部雖然走 payRead()，但因為分頁已確認存在，insertSheet 分支永遠不會被觸發。
// payRead／payClockRead／payInputsBase／payCollect／payCalcOne／pnlEstimateClassify_ 全部
// 只讀，不呼叫 setValue/setValues/appendRow/insertSheet/deleteRow/clear/
// PropertiesService...set.../LockService；CacheService 用在兩處，都不是分頁寫入：
// checkPnlKey_ 的金鑰失敗計數（與 pnlPayroll 共用同一把 PNL_KEY、同一套 20 次鎖 10 分鐘，
// 但 audit 文字用 endpoint 參數區分是哪支端點被打）、以及本端點自己按 (ym,store,asOf) 做的
// 10 分鐘結果快取（cache key 前綴 `pnlestimate|`，與 checkPnlKey_ 的
// `pnlkeyfail_payroll` 是不同的 cache key，互不影響）。
//
// 請求：POST {action:'pnlLaborEstimate', key, ym:'YYYY-MM', store}   // 平面 body，同既有慣例
// ym 只能是「今天所在月份」或「上個月」——更早的月份本來就該已經鎖定，請改打 pnlPayroll 讀
// 定案快照；比 pnlPayroll 更新的月份（下個月以後）沒有意義，一律 BAD_INPUT。

/** 'YYYY-MM' → 上一個月的 'YYYY-MM'（跨年正確：1 月的上個月是去年 12 月）。 */
function pnlPrevYm_(ym) {
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return y + '-' + pad2(m);
}

/** 估算基準日：
 *   ym＝當月 → 「昨天」（今天是 1 號就沒有昨天可估，回 null，端點回 NO_DATA）；
 *   ym＝上月 → 上月一定已經整月過完，基準日＝上月最後一天（等同整月估算，只是用即時
 *     打卡重算、不是鎖定快照——月初 1～10 號左右上月可能還沒按「鎖定本月」時特別有用）。
 *   純字串運算，不碰 Date 物件的 getDate()/setDate()——那兩個方法讀寫的是「執行環境的
 *   本地時區」欄位，Apps Script 專案時區設對了沒事，但本機 Node 測試環境不一定是台北時區，
 *   會導致月初/月底跨日錯位，字串運算才能在任何執行環境下都得到與台北時間一致的答案。 */
function pnlAsOfDate_(ym, today) {
  var curYm = String(today).slice(0, 7);
  if (ym === curYm) {
    var d = parseInt(String(today).slice(8, 10), 10) - 1;
    if (d < 1) return null;
    return ym + '-' + pad2(d);
  }
  return ym + '-' + pad2(payDaysIn(ym));
}

/** 缺口時數由各支援列平均分擔；逐字 port 自 payroll.html 的 allocGapHours（跨店支援請款用）。 */
function pnlAllocGapHours_(hoursArr, gap) {
  var alloc = hoursArr.map(function () { return 0; });
  var remain = gap, active = hoursArr.map(function (_, i) { return i; });
  while (remain > 1e-6 && active.length) {
    var share = remain / active.length, used = 0, next = [];
    active.forEach(function (i) {
      var cap = hoursArr[i] - alloc[i];
      var take = Math.min(share, cap);
      alloc[i] += take; used += take;
      if (cap - take > 1e-6) next.push(i);
    });
    if (used <= 1e-9) break;
    remain -= used; active = next;
  }
  return alloc;
}

var PNL_CO_ITEMS = ['co_labor', 'co_health', 'co_pension', 'co_owner', 'co_group'];
var PNL_COST_REDUCE_EXTRA = ['shortfall_hours', 'late_deduct', 'early_deduct'];
function pnlIsCostReduceKey_(k) { return /_leave$/.test(String(k)) || PNL_COST_REDUCE_EXTRA.indexOf(k) >= 0; }
var PNL_INS_SELF_KEYS = ['labor_ins', 'health_ins', 'group_ins', 'pension'];

/** 人事成本分類（估算版）：逐字對照 payroll.html 的 costTotals()＋costStable()，只是資料
 *  來源從前端 RESULTS/MASTER/ATT/CFG 換成本端點剛算好的 results/master/att/cfg。
 *  ⚠ costRows()/costStable() 口徑改了，這裡要一起改——三處同一份規則正本
 *  （見 mala-payroll skill「人事成本分類」那節，2026-09-03 已經改過三次）。
 *  刻意不含 custom_add／custom_ded／宿舍收入 g.dorm，與 costStable() 對齊。 */
function pnlEstimateClassify_(results, master, att, cfg) {
  var g = { base: 0, ot: 0, attend: 0, allow: 0, mgr: 0, pt: 0, other: 0, meal: 0, bs: 0, bp: 0, bj: 0,
            reduceFT: 0, reducePT: 0, dormFT: 0, dormPT: 0, ins: 0, insFT: 0, insPT: 0,
            sup: [], coL: 0, coH: 0, coP: 0, ye: 0 };
  var masterById = {};
  master.forEach(function (m) { masterById[String(m.emp_id)] = m; });

  results.forEach(function (r) {
    var mEmp = masterById[String(r.emp_id)] || {};
    var pr = r.is_full_time ? payNum(r.ratio) : 1;
    g.coL += payNum(mEmp.co_labor) * pr; g.coH += payNum(mEmp.co_health); g.coP += payNum(mEmp.co_pension) * pr;

    if (r.is_full_time) {
      var mo = (mEmp.yearend_months === '' || mEmp.yearend_months == null) ? payNum(cfg.yearend_months) : payNum(mEmp.yearend_months);
      if (mo > 0) {
        var bse = payNum(mEmp.base) + payNum(mEmp.skill_allow) + payNum(mEmp.night_allow) + payNum(mEmp.mgr_allow) + payNum(mEmp.attend_cap);
        g.ye += bse * mo / 12 * pr;
      }
    }

    var sup = ((att[r.emp_id] || {}).support || []).filter(function (x) { return payNum(x.hours) || payNum(x.amount); });
    if (sup.length) {
      var gapRate = payNum(mEmp.gap_rate);
      var gapH = r.base_hours != null ? Math.max(0, payNum(r.base_hours) - payNum(r.total_hours)) : 0;
      var alloc = pnlAllocGapHours_(sup.map(function (x) { return payNum(x.hours); }), gapH);
      sup.forEach(function (x, i) {
        var h = payNum(x.hours), rt = payNum(x.rate);
        var t1 = gapRate > 0 ? alloc[i] : 0, t2 = h - t1;
        var amt = payNum(x.amount) || (t1 * gapRate + t2 * rt);
        g.sup.push({ store: x.store || '（未指定）', amount: amt });
      });
    }

    r.earn.forEach(function (x) {
      var k = x.item_key, a = x.amount;
      if (k === 'bonus_sales') { g.bs += a; return; }
      if (k === 'bonus_perf') { g.bp += a; return; }
      if (k === 'bonus_project') { g.bj += a; return; }
      if (k === 'custom_add') { return; }   // 估算不計入，與 costStable() 對齊
      if (!r.is_full_time) { g.pt += a; return; }
      if (k === 'base_salary') g.base += a;
      else if (payIsOtKey(k)) g.ot += a;
      else if (k === 'attend_bonus') g.attend += a;
      else if (k === 'night_allow' || k === 'skill_allow') g.allow += a;
      else if (k === 'mgr_allow') g.mgr += a;
      else if (k === 'meal_sub') g.meal += a;
      else g.other += a;
    });
    r.ded.forEach(function (x) {
      if (pnlIsCostReduceKey_(x.item_key)) {
        if (r.is_full_time) g.reduceFT += x.amount; else g.reducePT += x.amount;
        return;
      }
      if (x.item_key === 'dormitory' && x.amount) {
        if (r.is_full_time) g.dormFT += x.amount; else g.dormPT += x.amount;
        return;
      }
      if (x.item_key === 'custom_ded' && x.amount) { return; }   // 估算不計入
      if (PNL_INS_SELF_KEYS.indexOf(x.item_key) >= 0 && x.amount) {
        g.ins += x.amount;
        if (r.is_full_time) g.insFT += x.amount; else g.insPT += x.amount;
      }
    });
  });

  var co = {};
  PNL_CO_ITEMS.forEach(function (k) { co[k] = payNum(cfg[k]); });
  var autoCo = { co_labor: g.coL, co_health: g.coH, co_pension: g.coP };
  var coAuto = (g.coL + g.coH + g.coP) > 0;
  if (coAuto) Object.keys(autoCo).forEach(function (k) { if (autoCo[k] > 0) co[k] = autoCo[k]; });

  var baseNet = g.base - g.reduceFT, ptNet = g.pt - g.reducePT - g.insPT - g.dormPT;
  var salaryGross = baseNet + g.ot + g.attend + g.allow + g.mgr + ptNet + g.other + g.meal + g.bs + g.bp + g.bj;
  var salaryCost = salaryGross - g.insFT - g.dormFT;
  var coTotal = PNL_CO_ITEMS.reduce(function (a, k) { return a + co[k]; }, 0);
  var yearend = payR0(g.ye);
  var total = salaryCost + coTotal + g.ins + yearend;

  var support = {};
  g.sup.forEach(function (x) { support[x.store] = payR2((support[x.store] || 0) + x.amount); });

  return {
    base_ft: payR2(baseNet), ot_ft: payR2(g.ot), attend_ft: payR2(g.attend), allow_ft: payR2(g.allow),
    mgr: payR2(g.mgr), meal: payR2(g.meal), other: payR2(g.other), pt: payR2(g.pt - g.reducePT),
    ins_pt_deduct: -payR2(g.insPT), dorm_pt_deduct: -payR2(g.dormPT),
    bonus_sales: payR2(g.bs), bonus_perf: payR2(g.bp), bonus_proj: payR2(g.bj),
    ins_ft_deduct: -payR2(g.insFT), dorm_ft_deduct: -payR2(g.dormFT),
    co_labor: payR2(co.co_labor), co_health: payR2(co.co_health), co_pension: payR2(co.co_pension),
    co_owner: payR2(co.co_owner), co_group: payR2(co.co_group),
    ins_self: payR2(g.ins), yearend: yearend,
    support: support, total: payR2(total),
  };
}

/** {action:'pnlLaborEstimate', key, ym, store} → 即時估算「當月 1 日至昨天」的人事成本，
 *  鍵與 pnlPayroll 相同，另回 as_of/days_elapsed/days_in_month/method。完全唯讀，見上方說明。 */
// T15 審查（Fable）追加：讀分頁一律先確認分頁存在（getSheetByName，缺分頁→NO_DATA），
// 不透過會在分頁不存在時 insertSheet 的 payRead()/paySheet()。
// 'run'（2026-09-27 第二輪審查加）：雖然本端點自己不讀 payroll_run，但 payroll_setup
// 一次建齊全部分頁，run 分頁存不存在是「這家店有沒有初始化過薪資系統」最直接的信號——
// 漏了它，一家從沒跑過薪資的店仍可能因為 master/config/holiday/leave_type/bonus/input
// 六張都存在（例如只執行過部分初始化）而被判定「就緒」，多列一張更保守。
var PNL_ESTIMATE_REQUIRED_SHEETS = ['master', 'config', 'holiday', 'leave_type', 'bonus', 'input', 'run'];
function pnlEstimateSheetsReady_() {
  var ss = getSS();
  return PNL_ESTIMATE_REQUIRED_SHEETS.every(function (k) { return !!ss.getSheetByName(PAY_SHEET_NAME[k]); });
}

// T15 審查追加：同 (ym, store, asOf) 10 分鐘內吃快取——asOf 每天才變一次，快取範圍最多是
// 「今天之內」，損益系統短時間內重複輪詢不用每次都整套重算。CacheService，不是分頁寫入
// （與 checkPnlKey_ 的失敗計數快取同一種豁免，見 pnlPayroll 的唯讀說明）。
var PNL_ESTIMATE_CACHE_SEC = 600;

/** {action:'pnlLaborEstimate', key, ym, store} → 即時估算「當月 1 日至昨天」的人事成本，
 *  鍵與 pnlPayroll 相同，另回 as_of/days_elapsed/days_in_month/method。完全唯讀，見上方說明。 */
function handlePnlLaborEstimate_(body) {
  var keyErr = checkPnlKey_(body.key, 'pnlLaborEstimate');
  if (keyErr) return { ok: false, error: keyErr };

  var ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'BAD_INPUT' };
  var today = todayTaipeiStr();
  var curYm = today.slice(0, 7);
  var prevYm = pnlPrevYm_(curYm);
  if (ym !== curYm && ym !== prevYm) {
    return { ok: false, error: 'BAD_INPUT', message: 'ym 只能是當月或上個月；更早的月份請改打 pnlPayroll 讀定案快照' };
  }

  var st = payStore(body.store);
  var asOf = pnlAsOfDate_(ym, today);
  if (!asOf) return { ok: false, error: 'NO_DATA', message: '本月第 1 天，還沒有已過天數可估算' };
  var daysInMonth = payDaysIn(ym);
  var daysElapsed = Math.min(daysInMonth, parseInt(asOf.slice(8, 10), 10));

  var cache = CacheService.getScriptCache();
  var cacheKey = 'pnlestimate|' + ym + '|' + st + '|' + asOf;
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (parseErr) { /* 壞掉的快取當沒有，往下重算 */ }
  }

  if (!pnlEstimateSheetsReady_()) {
    return { ok: false, error: 'NO_DATA', message: '薪資分頁尚未初始化（尚未執行過 payroll_setup）' };
  }

  var master = payRead('master').filter(function (m) {
    return String(m.active).toLowerCase() === 'true' && payStore(m.store) === st;
  });
  if (!master.length) return { ok: false, error: 'NO_DATA', message: st + ' 沒有在職同仁主檔' };

  var holRow = payHolidayRow(ym, st);
  var holDates = payHolidayDates(holRow);
  var redDaysMissing = !holRow;
  var redDays = holRow ? payNum(holRow.red_days) : 0;   // 沒設定紅字天數＝先當 0，見下方 red_days_missing

  var cfg = payConfig(st);
  // 打卡歸集（只到 asOf）疊上 payroll_input 手動覆蓋——support/meal_on/full_attend/wage_override
  // 與手動輸入門市的整月工時都在這裡一起帶進來，跟 handlePayrollCalc 的 collected 同一套合併
  // 規則（payInputsBase 本身沒有改，只是新增了可選的 cutoffDate 第三參數）。
  var att = payInputsBase(ym, st, asOf);
  // 跨店支援自動帶入（2026-11 起，Eason 11-05「一起接上」）：跟 handlePayrollCalc 同一套合併，只算到 as_of；之前的月份回 null 不動
  var XS = paySupportAuto_(ym, st, payOtDailyOn(ym), asOf);   // 2026-11 起加班逐日判斷要逐日的支援時數
  if (XS) {
    var XC = { home: st, storeBy: payXsupStoreBy_(payRead('store')), dropCross: !XS.empty };
    master.forEach(function (e) {
      var id = String(e.emp_id), c = att[id] || (att[id] = {});
      if (c.support_error) return;   // 支援欄壞掉的人不帶入（同計薪）
      c.support = payMergeSupport_(c.support || [], XS.byEmp[id.trim()], e, XC).support;
    });
  }

  var bonusBy = {};
  payRead('bonus').forEach(function (b) {
    if (String(b.ym) !== ym || payStore(b.store) !== st) return;
    // 「基準日之後才登記的獎金不算」只在 ym＝當月（還在進行中的月份）才有意義；ym＝上個月時
    // 上個月本來就已經整月過完，獎金常常是次月才補登記，不能因為 updated_at 晚於 as_of 就
    // 整筆漏掉——那樣上個月的估算永遠少計已經確定屬於上個月的獎金。
    if (ym === curYm) {
      var upd = String(b.updated_at || '').slice(0, 10);
      if (upd && upd > asOf) return;
    }
    var k = String(b.emp_id);
    (bonusBy[k] = bonusBy[k] || []).push({ bonus_type: b.bonus_type, label: b.label, amount: payNum(b.amount) });
  });

  var LTYPES = payLeaveTypes(st);
  var USAGE_BEFORE = payLeaveUsedBefore(ym, st, LTYPES, cfg, master);
  var ANNUAL_INFO = payAnnualInfo(ym, st);

  var PNL_SCHED = null;
  var results = master.map(function (e) {
    var c = att[String(e.emp_id)] || {};
    var a = {
      hours: payNum(c.hours), extra_ot: payNum(c.extra_ot),
      personal_h: payNum(c.personal_h), sick_h: payNum(c.sick_h), menstrual_h: payNum(c.menstrual_h),
      disaster_h: payNum(c.disaster_h), annual_h: payNum(c.annual_h), deduct_days: payNum(c.deduct_days),
      support: c.support || [], full_attend: payBool(c.full_attend), work_days: payNum(c.work_days),
      wage_override: payNum(c.wage_override), dorm_override: (c.dorm_override === '' || c.dorm_override == null) ? '' : payNum(c.dorm_override),
      meal_on: payBool(c.meal_on), holiday_h: payNum(c.holiday_h),
      custom_add_label: c.custom_add_label || '', custom_add_amt: payNum(c.custom_add_amt),
      custom_ded_label: c.custom_ded_label || '', custom_ded_amt: payNum(c.custom_ded_amt),
      bonuses: bonusBy[String(e.emp_id)] || [], leaves: c.leaves || {},
      leave_usage: USAGE_BEFORE[String(e.emp_id)] || {}, annual: ANNUAL_INFO[String(e.emp_id)] || null,
      forget_punch: payNum(c.forget_punch), forget_day: payNum(c.forget_day),
      late_min: payNum(c.late_min), early_min: payNum(c.early_min), attend_void: !!c.attend_void,
      xsup_late_min: XS ? payXsupLateEarly_(XS.byEmp[String(e.emp_id).trim()]).late : 0,
      xsup_early_min: XS ? payXsupLateEarly_(XS.byEmp[String(e.emp_id).trim()]).early : 0,
    };
    // 虛擬離職日＝昨天，借用 payRatio 既有的「月中到職/離職才折算」機制算出「已過天數÷當月
    // 天數」；員工本來就有更早的到職日或離職日時，取較早的那個（字串比較，'YYYY-MM-DD' 可直接比大小）。
    if (payOtDailyOn(ym)) {   // 跟 handlePayrollCalc 同一套逐日加班（班表、國定假日、同品牌支援逐日合計），只算到 as_of
      if (!PNL_SCHED) PNL_SCHED = paySchedMonth_(ym, st, master);
      var supH = (a.support || []).reduce(function (t, x) { return t + payNum(x && x.hours); }, 0);
      a.daily = payDailyFor_(e, ym, c, XS ? XS.byEmp[String(e.emp_id).trim()] : null, PNL_SCHED[String(e.emp_id)], holDates, asOf, supH);
      a.daily.dates = a.daily.dates.filter(function (d) { return d <= asOf; });
    }
    var origLeave = payDateStr(e.leave_date);
    var virtualLeave = (origLeave && origLeave <= asOf) ? origLeave : asOf;
    var eEst = {};
    Object.keys(e).forEach(function (k) { eEst[k] = e[k]; });
    eEst.leave_date = virtualLeave;
    return payCalcOne(eEst, ym, a, cfg, redDays, LTYPES);
  });

  var snap = pnlEstimateClassify_(results, master, att, cfg);
  var result = {
    ok: true, ym: ym, store: st,
    as_of: asOf, days_elapsed: daysElapsed, days_in_month: daysInMonth,
    method: (ym === curYm ? 'partial_month_to_date' : 'prior_month_recomputed') +
      '｜底薪與固定津貼＝月薪×(截至 as_of 的在職比例，沿用 payRatio 的到職/離職折算機制，' +
      '虛擬設一個「離職日＝as_of」)；PT/加班/餐費/全勤＝as_of 前已核定工時×費率，並疊上 ' +
      'payroll_input 手動覆蓋的 support/meal_on/full_attend/wage_override 與手動輸入門市的整月 ' +
      '工時（同 handlePayrollCalc 的合併規則，手動覆蓋存在時整筆蓋過打卡歸集，與既有系統一致）；' +
      '勞健保公司負擔/退休金按同一在職比例折算；年終提列＝月提列額×在職比例；跨店支援請款＝' +
      'as_of 前已記錄或手動填寫的支援時數。獎金：ym＝當月時只計入 as_of 前登記的；ym＝上個月時' +
      '不論登記日一律計入（次月才登記很常見）。與 pnlPayroll 定案快照的差異：本端點即時重算、' +
      '不看鎖定狀態。',
    rows: {
      base_ft: snap.base_ft, ot_ft: snap.ot_ft, attend_ft: snap.attend_ft, allow_ft: snap.allow_ft,
      mgr: snap.mgr, meal: snap.meal, other: snap.other, pt: snap.pt,
      bonus_sales: snap.bonus_sales, bonus_perf: snap.bonus_perf, bonus_proj: snap.bonus_proj,
      ins_ft_deduct: snap.ins_ft_deduct, dorm_ft_deduct: snap.dorm_ft_deduct,
      ins_pt_deduct: snap.ins_pt_deduct, dorm_pt_deduct: snap.dorm_pt_deduct,
      co_labor: snap.co_labor, co_health: snap.co_health, co_pension: snap.co_pension,
      co_owner: snap.co_owner, co_group: snap.co_group, ins_self: snap.ins_self, yearend: snap.yearend,
    },
    support: snap.support, total: snap.total,
    not_estimated: ['custom_add', 'custom_ded', 'dorm_income（g.dorm，宿舍收入參考區塊）'],
  };
  if (redDaysMissing) result.red_days_missing = true;   // 損益端看到這個旗標就該顯示提醒（見 issue #46）

  try { cache.put(cacheKey, JSON.stringify(result), PNL_ESTIMATE_CACHE_SEC); } catch (cacheErr) { /* 快取失敗不影響回應 */ }
  return result;
}
