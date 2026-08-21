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
            'pension','dormitory','hire_date','leave_date','active','updated_at','meal_allow','store','gap_rate'],
  config:  ['key','value','note','store'],
  holiday: ['ym','red_days','note'],
  store:   ['code','name','clock_ss_id','dzy_node','emp_prefix','active','sort','brand'],
  bonus:   ['ym','store','emp_id','bonus_type','label','amount','memo','updated_at'],
  run:     ['ym','emp_id','name','is_full_time','ratio','total_hours','base_hours','surplus_hours',
            'ot_paid_hours','gross','deduction','net','status','run_at','support_hours','store'],
  item:    ['ym','emp_id','item_type','item_key','item_label','qty','rate','amount','source','memo','store'],
  input:   ['ym','emp_id','hours','extra_ot','personal_h','sick_h','annual_h','deduct_days','support','updated_at','menstrual_h','disaster_h','full_attend','work_days','wage_override','dorm_override','meal_on','custom_add_label','custom_add_amt','custom_ded_label','custom_ded_amt','store'],
  audit:   ['ts','ym','action','operator','reason','store'],
};
/** 餐費補助門檻：當天「實際核定工時」要達這個時數才認列一天（核定時數＝實際上班時段，
 *  全天請假核定 0、假別另存 leave 分頁，所以特休／請假／出差自然不會被算進來）。*/
const MEAL_MIN_HOURS = 6;   // 預設值；實際以 payroll_config 的 meal_min_hours 為準（可依門市覆寫）

const PAY_SHEET_NAME = {
  master:'payroll_master', config:'payroll_config', holiday:'payroll_holiday',
  run:'payroll_run', item:'payroll_item', input:'payroll_input', audit:'payroll_audit',
  store:'payroll_store', bonus:'payroll_bonus',
};

/** 單店期間的預設門市（階段一多店上線後改為必填，屆時移除此預設） */
const PAY_DEFAULT_STORE = 'SSLGF';
/** 呼叫端沒帶 store 時一律套用預設店，確保階段 0 行為與單店完全相同 */
function payStore(v) { return String(v || PAY_DEFAULT_STORE); }
const PAY_CONFIG_DEFAULT = [
  ['daily_hours', 8, '每日基本工時'],
  ['attend_deduct_per_day', 100, '全勤每日倒扣金額'],
  ['leave_div_days', 30, '事假費率分母（天）'],
  ['leave_div_hours', 8, '事假費率分母（時）'],
  ['sick_ratio', 0.5, '病假占事假比例'],
  ['payday', 10, '發薪日'],
  ['shortfall_deduct', 'false', '工時不足是否倒扣（Eason 2026-07-20 定案：不倒扣，因缺勤已由請假扣款扣過）'],
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

function payRead(kind) { return readSheetAsObjects(paySheet(kind)).rows.map(stripRowIndex); }

/* ⚠ Sheets 會把 '2026-08'、'2020-01-01' 這種字串自動轉成日期儲存格，讀回變 Date 物件、比對全失敗
   （ym 對不到 → no_holiday／查不到 run；hire_date 壞 → payRatio 錯）。寫入前把這些字串欄鎖成文字格式 '@'。*/
function payForceTextCols(sh, cols) {
  const TEXT = { ym: 1, hire_date: 1, leave_date: 1 };
  cols.forEach(function (c, i) {
    if (TEXT[c]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
}

/** 整張覆寫（保留表頭）——用於 master / holiday / run / item 的重建 */
function payReplaceAll(kind, rows) {
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
function payClockSS(store) {
  const c = payStore(store);
  if (PAY_SS_CACHE[c]) return PAY_SS_CACHE[c];
  const row = payStoreRow(c);
  const id = row ? String(row.clock_ss_id || '') : '';
  var ss;
  if (!id) {
    // 只有預設店（光復）留空才代表「用本系統所在的試算表」。其他門市留空一定是漏填，
    // 若放行會去讀到光復的打卡資料且不會報錯 —— 直接擋下來。
    if (c !== PAY_DEFAULT_STORE) {
      throw new Error('門市 ' + c + ' 尚未設定「打卡試算表 ID」，無法取得該店打卡資料。請到 參數設定 → 門市設定 填入。');
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
/** 啟用中的門市清單；門市表是空的就回一個預設店（單店期間） */
function payStoreList() {
  const rows = payRead('store').filter(function (s) { return String(s.active).toLowerCase() !== 'false'; });
  if (rows.length) {
    return rows.sort(function (a, b) { return (payNum(a.sort) || 99) - (payNum(b.sort) || 99); });
  }
  return [{ code: PAY_DEFAULT_STORE, name: '麻的小辛辣 新竹光復店', clock_ss_id: '', dzy_node: 'sxl-gf', emp_prefix: '', active: 'true', sort: 1 }];
}
/** 某員工待過的所有門市（跨店調動時特休／年資要跨店累計用） */
function payEmpStores(empId) {
  const set = {};
  payRead('master').forEach(function (m) { if (String(m.emp_id) === String(empId)) set[payStore(m.store)] = true; });
  payRead('run').forEach(function (r) { if (String(r.emp_id) === String(empId)) set[payStore(r.store)] = true; });
  payRead('input').forEach(function (r) { if (String(r.emp_id) === String(empId)) set[payStore(r.store)] = true; });
  return Object.keys(set);
}

/* ═══════════════════ 工時歸集（重點：直接讀既有打卡資料）═══════════════════ */

/**
 * 從 approved / leave / events 歸集某月每人的薪資輸入。
 * 這就是「不用人工把工時搬進薪資系統」的那一段。
 */
function payCollect(ym, minH, store) {
  const MEALMIN = (minH === undefined || minH === null || minH === '') ? MEAL_MIN_HOURS : Number(minH);
  const ss = payClockSS(store);
  const roster   = readSheetAsObjects(ss.getSheetByName('roster')).rows.map(stripRowIndex);
  const approved = readSheetAsObjects(ss.getSheetByName('approved')).rows.map(stripRowIndex);
  const events   = readSheetAsObjects(ss.getSheetByName('events')).rows.map(stripRowIndex);
  const leaveSh  = ss.getSheetByName('leave');
  const leaves   = leaveSh ? readSheetAsObjects(leaveSh).rows.map(stripRowIndex) : [];

  const approvedMap = buildLatestApprovedMap(approved);   // { date: { emp_id: {...} } }
  const nameToEmp = {};
  roster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });

  const out = {};
  function slot(emp) {
    if (!out[emp]) out[emp] = {
      hours: 0, extra_ot: 0,
      personal_h: 0, sick_h: 0, menstrual_h: 0, annual_h: 0, disaster_h: 0, other_h: 0,
      deduct_days: 0, _days: {}, work_days: 0, _wd: {},
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
      if (dayH >= MEALMIN) slot(emp)._wd[d] = true;
      const st = String(rec.status_text || '');
      if (st.indexOf('遲到') !== -1 || st.indexOf('早退') !== -1) markDay(emp, d);
    });
  });

  // 2) 忘刷卡日（沿用既有 pairShifts 的判定，不重寫規則）
  const paired = pairShifts(events);
  const todayStr = todayTaipeiStr();
  paired.unmatchedIns.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym || d === todayStr) return;   // 今天未配對＝上班中，不算忘刷
    markDay(String(e.emp_id), d);
  });
  paired.unmatchedOuts.forEach(function (e) {
    const d = tsDateStr(e.ts);
    if (d.slice(0, 7) !== ym) return;
    markDay(String(e.emp_id), d);
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
    const isDisaster = t.indexOf('災') !== -1;   // 天災假
    if (t.indexOf('事') !== -1)        s.personal_h += h;
    else if (t.indexOf('生理') !== -1) s.menstrual_h += h;
    else if (isDisaster)               s.disaster_h += h;
    else if (t.indexOf('病') !== -1)   s.sick_h += h;
    else if (t.indexOf('特') !== -1)   s.annual_h += h;
    else                               s.other_h += h;
    if (!isDisaster) markDay(emp, d);   // 天災假不計缺勤天數（不扣全勤）
  });

  Object.keys(out).forEach(function (emp) {
    out[emp].deduct_days = Object.keys(out[emp]._days).length;
    out[emp].work_days = Object.keys(out[emp]._wd).length;
    delete out[emp]._days; delete out[emp]._wd;
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

/** 計時「年資加給」：任職滿半年「之後的次月」起，時薪 +10。
 *  例：到職 6/5 → 12/5 滿半年 → 隔年 1 月起（該月 1 號晚於滿半年日才算）。 */
function payTenurePlus(e, ym) {
  const hs = payDateStr(e.hire_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hs)) return 0;
  const h = new Date(hs + 'T00:00:00');
  const sixMo = new Date(h.getFullYear(), h.getMonth() + 6, h.getDate());
  const monthStart = new Date(ym + '-01T00:00:00');
  return monthStart > sixMo ? 10 : 0;
}

function payCalcOne(e, ym, att, cfg, redDays) {
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
      // 不足時數倒扣，但先扣掉已請假時數（事假＋病假＋生理假＋特休＋天災假）——那些另有處理，不重複倒扣
      const paidLeave = payNum(att.personal_h) + payNum(att.sick_h) + payNum(att.menstrual_h) + payNum(att.annual_h) + payNum(att.disaster_h);
      const shortH = payR2(Math.max(0, Math.abs(surplus) - paidLeave));
      if (shortH > 0) push(ded, 'shortfall_hours', '不足時數', shortH, payNum(e.ot_rate), shortH * payNum(e.ot_rate));
    }
    if (payNum(e.attend_cap) > 0) {
      push(earn, 'attend_bonus', '全勤獎金', null, null,
           Math.max(0, payNum(e.attend_cap) * P - att.deduct_days * payNum(cfg.attend_deduct_per_day)));
    }
    // 餐費補助（正職）：工時分頁勾選才算＝出勤天數 × 餐費補助/日（主檔 meal_allow，無預設）。按實際天數不另乘 P。
    const mealRate = payNum(e.meal_allow);
    const wd = payNum(att.work_days);
    if (payBool(att.meal_on) && mealRate > 0 && wd > 0) push(earn, 'meal_sub', '餐費補助', wd, mealRate, wd * mealRate);
  } else {
    // 計時：本店時數 × 時薪；時薪加給＝滿勤(工時分頁手動打勾)+10、年資(滿半年次月起)+10，可疊加
    // 本月時薪：工時分頁填了 wage_override 就用該月值，否則用主檔 wage（計時每月時薪可不同、又保留歷史）
    let w = payNum(att.wage_override) > 0 ? payNum(att.wage_override) : payNum(e.wage);
    if (payBool(att.full_attend)) w += 10;   // E1 滿勤加給：管理者於工時分頁手動勾選（滿100H+全勤由管理者判定）
    w += payTenurePlus(e, ym);               // E2 年資加給
    push(earn, 'hourly_wage', '薪資（時數）', payR2(att.hours), w, att.hours * w);
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
  if (att.personal_h) push(ded, 'personal_leave', '事假', att.personal_h, rate, att.personal_h * rate);
  if (att.disaster_h) push(ded, 'disaster_leave', '天災假(無薪)', att.disaster_h, rate, att.disaster_h * rate);
  if (att.sick_h) {
    const sr = payR0(rate * payNum(cfg.sick_ratio));
    push(ded, 'sick_leave', '病假', att.sick_h, sr, att.sick_h * sr);
  }
  if (att.menstrual_h) {   // 生理假：半薪（同病假，法定）
    const mr = payR0(rate * payNum(cfg.sick_ratio));
    push(ded, 'menstrual_leave', '生理假', att.menstrual_h, mr, att.menstrual_h * mr);
  }
  // 特休不扣款

  // 勞保與宿舍折算；健保、團保、退休金算整月
  if (payNum(e.labor_ins))  push(ded, 'labor_ins', '勞保費', null, null, payNum(e.labor_ins) * pr);
  // 宿舍費隨月：工時分頁填了「本月宿舍費」（含 0＝本月免收）就用該月值，空白＝用主檔
  const dormFee = (att.dorm_override === '' || att.dorm_override == null) ? payNum(e.dormitory) : payNum(att.dorm_override);
  if (dormFee) push(ded, 'dormitory', '宿舍自付額', null, null, dormFee * pr);
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
  const roster = readSheetAsObjects(payClockSS(stBs).getSheetByName('roster')).rows.map(stripRowIndex);
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
           holidays: payRead('holiday') };
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
  payReplaceAll('holiday', body.holidays);
  return { ok: true, count: body.holidays.length };
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
  const base = payCollect(ym, payConfig(st).meal_min_hours, st);
  const saved = paySavedInputs(ym, st);
  Object.keys(saved).forEach(function (emp) { base[emp] = saved[emp]; });
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
      work_days: payNum(a.work_days), wage_override: payNum(a.wage_override), meal_on: payBool(a.meal_on) ? 1 : 0,
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

  const holiday = payRead('holiday').filter(function (h) { return String(h.ym) === ym; })[0];
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
      custom_add_label: o.custom_add_label !== undefined ? o.custom_add_label : (c.custom_add_label||''),
      custom_add_amt:   o.custom_add_amt   !== undefined ? payNum(o.custom_add_amt) : payNum(c.custom_add_amt),
      custom_ded_label: o.custom_ded_label !== undefined ? o.custom_ded_label : (c.custom_ded_label||''),
      custom_ded_amt:   o.custom_ded_amt   !== undefined ? payNum(o.custom_ded_amt) : payNum(c.custom_ded_amt),
      bonuses: bonusBy[String(e.emp_id)] || [],
    };
    return payCalcOne(e, ym, att, cfg, redDays);
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
    const hol = payRead('holiday').filter(function (h) { return String(h.ym) === ym; })[0];
    if (hol) {
      const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, store: stM, inputs: body.inputs || {} });
      if (calc && calc.ok) run = { results: calc.results, status: 'draft' };
    }
  }
  return { ok: true, ym: ym, store: stM, inputs: inputs, run: run, annual: payAnnualInfo(ym, stM),
           master: payRead('master').filter(function (m) { return payStore(m.store) === stM; }),
           config: payConfig(stM), config_src: payConfigSource(stM),
           bonuses: payRead('bonus').filter(function (b) { return String(b.ym) === ym && payStore(b.store) === stM; }),
           stores: payRead('store').filter(function (x) { return String(x.active).toLowerCase() !== 'false'; }),
           holidays: payRead('holiday') };
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
  const leaveCache = {};
  function leavesOf(st) {
    if (leaveCache[st]) return leaveCache[st];
    var rows = [];
    try {
      const sh2 = payClockSS(st).getSheetByName('leave');
      rows = sh2 ? readSheetAsObjects(sh2).rows.map(stripRowIndex) : [];
    } catch (e) { rows = []; }   // 某店試算表暫時開不起來不該讓整頁掛掉
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
    payEmpStores(e.emp_id).forEach(function (st2) {
      leavesOf(st2).forEach(function (l) {
        if (String(l['姓名'] || '').trim() !== String(e.name || '').trim()) return;
        if (String(l['假別'] || '').indexOf('特') === -1) return;
        const d = normCellDate(l['日期']);
        if (!(q.ps && d >= q.ps && d < q.pe)) return;
        if (inputMonths[d.slice(0, 7)]) return;
        used += Number(l['時數']) || 0;
      });
    });
    out[String(e.emp_id)] = { days: q.days, quota_h: q.days * 8, used_h: payR2(used), left_h: payR2(q.days * 8 - used) };
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
  const ss = payClockSS(stP);
  const roster = readSheetAsObjects(ss.getSheetByName('roster')).rows.map(stripRowIndex);
  const nameById = {};
  roster.forEach(function (r) { nameById[String(r.emp_id)] = r.name; });
  const events = readSheetAsObjects(ss.getSheetByName('events')).rows.map(stripRowIndex);
  const appSh = ss.getSheetByName('approved');
  const approvedMap = buildLatestApprovedMap(appSh ? readSheetAsObjects(appSh).rows.map(stripRowIndex) : []);

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
  const leaveSh2 = ss.getSheetByName('leave');
  if (leaveSh2) {
    const nameToEmp = {};
    roster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });
    readSheetAsObjects(leaveSh2).rows.map(stripRowIndex).forEach(function (l) {
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

  const REDUCE = ['personal_leave','sick_leave','menstrual_leave','disaster_leave','shortfall_hours'];
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
      } else if (REDUCE.indexOf(k) >= 0) reduce += a;
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
  const REDUCE = ['personal_leave','sick_leave','menstrual_leave','disaster_leave','shortfall_hours'];
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
      } else if (REDUCE.indexOf(k) >= 0) reduce += a;
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
    try { rs = readSheetAsObjects(payClockSS(code).getSheetByName('roster')).rows.map(stripRowIndex); }
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
};
