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
            'pension','dormitory','hire_date','leave_date','active','updated_at','meal_allow'],
  config:  ['key','value','note'],
  holiday: ['ym','red_days','note'],
  run:     ['ym','emp_id','name','is_full_time','ratio','total_hours','base_hours','surplus_hours',
            'ot_paid_hours','gross','deduction','net','status','run_at','support_hours'],
  item:    ['ym','emp_id','item_type','item_key','item_label','qty','rate','amount','source','memo'],
  input:   ['ym','emp_id','hours','extra_ot','personal_h','sick_h','annual_h','deduct_days','support','updated_at','menstrual_h','disaster_h','full_attend','work_days','wage_override','dorm_override','meal_on','custom_add_label','custom_add_amt','custom_ded_label','custom_ded_amt'],
  audit:   ['ts','ym','action','operator','reason'],
};
const PAY_SHEET_NAME = {
  master:'payroll_master', config:'payroll_config', holiday:'payroll_holiday',
  run:'payroll_run', item:'payroll_item', input:'payroll_input', audit:'payroll_audit',
};
const PAY_CONFIG_DEFAULT = [
  ['daily_hours', 8, '每日基本工時'],
  ['attend_deduct_per_day', 100, '全勤每日倒扣金額'],
  ['leave_div_days', 30, '事假費率分母（天）'],
  ['leave_div_hours', 8, '事假費率分母（時）'],
  ['sick_ratio', 0.5, '病假占事假比例'],
  ['payday', 10, '發薪日'],
  ['shortfall_deduct', 'false', '工時不足是否倒扣（Eason 2026-07-20 定案：不倒扣，因缺勤已由請假扣款扣過）'],
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

function payConfig() {
  const out = {};
  payRead('config').forEach(function (r) {
    const v = String(r.value);
    out[r.key] = (v === 'true') ? true : (v === 'false') ? false :
                 (v !== '' && isFinite(Number(v)) ? Number(v) : v);
  });
  PAY_CONFIG_DEFAULT.forEach(function (d) { if (out[d[0]] === undefined) out[d[0]] = d[1]; });
  return out;
}

/* ═══════════════════ 工時歸集（重點：直接讀既有打卡資料）═══════════════════ */

/**
 * 從 approved / leave / events 歸集某月每人的薪資輸入。
 * 這就是「不用人工把工時搬進薪資系統」的那一段。
 */
function payCollect(ym) {
  const ss = getSS();
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
      slot(emp).hours += Number(rec.approved_hours) || 0;
      slot(emp)._wd[d] = true;   // 有核定紀錄＝這天有上班（供餐費補助數出勤天數）
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
function handlePayrollImportSchedule(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ensurePayrollSheets();

  var emps = body.employees;
  if (!Array.isArray(emps) || !emps.length) return { ok: false, error: 'no_employees' };

  // 用打卡 roster 的姓名→emp_id 對映，把排班員工鍵成 roster emp_id（否則工時接不到人）
  var roster = readSheetAsObjects(getSS().getSheetByName('roster')).rows.map(stripRowIndex);
  var nameToEmp = {};
  roster.forEach(function (r) { nameToEmp[String(r.name).trim()] = String(r.emp_id); });

  var merged = payMergeScheduleMaster(payRead('master'), emps, nameToEmp);
  var now = nowTaipeiIso();
  payReplaceAll('master', merged.master.map(function (m) { m.updated_at = now; return m; }));

  var redInfo = null;
  var ym = String(body.ym || '');
  if (/^\d{4}-\d{2}$/.test(ym) && body.red_days !== undefined && body.red_days !== null && body.red_days !== '') {
    var red = Number(body.red_days);
    var others = payRead('holiday').filter(function (h) { return String(h.ym) !== ym; });
    payReplaceAll('holiday', others.concat([{ ym: ym, red_days: red, note: '排班帶入 ' + now.slice(0, 10) }]));
    redInfo = { ym: ym, red_days: red };
  }
  return { ok: true, added: merged.added, updated: merged.updated, skipped: merged.skipped, count: merged.master.length, red: redInfo };
}

function handlePayrollBootstrap(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  ensurePayrollSheets();
  const roster = readSheetAsObjects(getSS().getSheetByName('roster')).rows.map(stripRowIndex);
  const existing = {};
  payRead('master').forEach(function (m) { existing[String(m.emp_id)] = true; });
  const add = roster
    .filter(function (r) { return String(r.active).toLowerCase() === 'true' && !existing[String(r.emp_id)]; })
    .map(function (r) {
      return { emp_id: r.emp_id, name: r.name, is_full_time: 'false', wage: 0, base: 0, ot_rate: 0,
               skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 0,
               labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
               hire_date: '', leave_date: '', active: 'true', updated_at: nowTaipeiIso() };
    });
  payAppend('master', add);
  return { ok: true, added: add.length, names: add.map(function (a) { return a.name; }) };
}

function handlePayrollMasterGet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return { ok: true, master: payRead('master'), config: payConfig(), holidays: payRead('holiday') };
}

function handlePayrollMasterSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  if (!Array.isArray(body.master)) return { ok: false, error: 'master_required' };
  const now = nowTaipeiIso();
  payReplaceAll('master', body.master.map(function (m) { m.updated_at = now; return m; }));
  return { ok: true, count: body.master.length };
}

function handlePayrollConfigSet(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const rows = Object.keys(body.config || {}).map(function (k) {
    return { key: k, value: String(body.config[k]), note: '' };
  });
  if (!rows.length) return { ok: false, error: 'config_required' };
  payReplaceAll('config', rows);
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
function paySavedInputs(ym) {
  const out = {};
  payRead('input').forEach(function (r) {
    if (String(r.ym) !== ym) return;
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
function payInputsBase(ym) {
  const base = payCollect(ym);
  const saved = paySavedInputs(ym);
  Object.keys(saved).forEach(function (emp) { base[emp] = saved[emp]; });
  return base;
}

function handlePayrollInputs(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  const ym = String(body.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'bad_ym' };
  return { ok: true, ym: ym, inputs: payInputsBase(ym), master: payRead('master') };
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

  const runs = payRead('run').filter(function (r) { return String(r.ym) === ym; });
  if (runs.length && String(runs[0].status) === 'final' && !body.force) {
    return { ok: false, error: 'locked', message: ym + ' 已鎖定，請先解鎖再重算' };
  }

  const holiday = payRead('holiday').filter(function (h) { return String(h.ym) === ym; })[0];
  if (!holiday) return { ok: false, error: 'no_holiday', message: ym + ' 尚未設定紅字天數' };
  const redDays = payNum(holiday.red_days);

  const cfg = payConfig();
  const master = payRead('master').filter(function (m) { return String(m.active).toLowerCase() === 'true'; });
  const collected = payInputsBase(ym);   // 打卡歸集＋已儲存的手動覆蓋
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
    };
    return payCalcOne(e, ym, att, cfg, redDays);
  });

  // 保留 manual 明細，只重建 auto
  const keptManual = payRead('item').filter(function (i) {
    return String(i.ym) === ym && String(i.source) === 'manual';
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

    r.earn.forEach(function (x) { itemRows.push(payItemRow(ym, r.emp_id, 'earning', x, 'auto')); });
    r.ded.forEach(function (x) { itemRows.push(payItemRow(ym, r.emp_id, 'deduction', x, 'auto')); });
    mine.forEach(function (i) { itemRows.push(i); });

    runRows.push({
      ym: ym, emp_id: r.emp_id, name: r.name, is_full_time: r.is_full_time, ratio: r.ratio,
      total_hours: r.total_hours, support_hours: r.support_hours, base_hours: r.base_hours, surplus_hours: r.surplus_hours,
      ot_paid_hours: r.ot_paid_hours, gross: r.gross, deduction: r.deduction, net: r.net,
      status: 'draft', run_at: now,
    });
  });

  const otherRuns  = payRead('run').filter(function (r) { return String(r.ym) !== ym; });
  const otherItems = payRead('item').filter(function (i) { return String(i.ym) !== ym; });
  payReplaceAll('run', otherRuns.concat(runRows));
  payReplaceAll('item', otherItems.concat(itemRows));

  return { ok: true, ym: ym, results: results, config: cfg, red_days: redDays, collected: collected };
}

function payItemRow(ym, empId, type, x, source) {
  return { ym: ym, emp_id: empId, item_type: type, item_key: x.item_key, item_label: x.item_label,
           qty: x.qty == null ? '' : x.qty, rate: x.rate == null ? '' : x.rate,
           amount: x.amount, source: source, memo: '' };
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
function payBuildRunResults(ym) {
  const runRows = payRead('run').filter(function (r) { return String(r.ym) === ym; });
  if (!runRows.length) return null;
  const items = payRead('item').filter(function (i) { return String(i.ym) === ym; });
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
  const inputs = payInputsBase(ym);
  let run = payBuildRunResults(ym);
  if (!run) {
    const hol = payRead('holiday').filter(function (h) { return String(h.ym) === ym; })[0];
    if (hol) {
      const calc = handlePayrollCalc({ admin_key: body.admin_key, ym: ym, inputs: body.inputs || {} });
      if (calc && calc.ok) run = { results: calc.results, status: 'draft' };
    }
  }
  return { ok: true, ym: ym, inputs: inputs, run: run, annual: payAnnualInfo(ym),
           master: payRead('master'), config: payConfig(), holidays: payRead('holiday') };
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
  rows.forEach(function (r) { if (String(r.ym) === ym) { r.status = lock ? 'final' : 'draft'; n++; } });
  if (!n) return { ok: false, error: 'no_run', message: ym + ' 還沒有月結資料' };
  payReplaceAll('run', rows);
  payAppend('audit', [{ ts: nowTaipeiIso(), ym: ym, action: lock ? 'lock' : 'unlock',
                        operator: String(body.operator || 'admin'), reason: String(body.reason || '') }]);
  return { ok: true, ym: ym, status: lock ? 'final' : 'draft', count: n };
}

/**
 * 員工自助查詢：以打卡專屬連結的 key 反查 emp_id。
 * 絕不接受前端傳入的 emp_id——否則改網址就能看別人的薪水。
 */
/** 每人剩餘特休（工時分頁與員工薪資單共用）：額度=payAnnualQuota、已用=當前週年期內 leave 分頁特休時數合計 */
function payAnnualInfo(ym) {
  const master = payRead('master');
  const sh = getSS().getSheetByName('leave');
  const leaves = sh ? readSheetAsObjects(sh).rows.map(stripRowIndex) : [];
  const out = {};
  master.forEach(function (e) {
    const q = payAnnualQuota(e.hire_date, ym);
    if (!q) { out[String(e.emp_id)] = null; return; }
    let used = 0;
    leaves.forEach(function (l) {
      if (String(l['姓名'] || '').trim() !== String(e.name || '').trim()) return;
      if (String(l['假別'] || '').indexOf('特') === -1) return;
      const d = normCellDate(l['日期']);
      if (q.ps && d >= q.ps && d < q.pe) used += Number(l['時數']) || 0;
    });
    out[String(e.emp_id)] = { days: q.days, quota_h: q.days * 8, used_h: payR2(used), left_h: payR2(q.days * 8 - used) };
  });
  return out;
}

function handleMyPayslip(body) {
  const key = String(body.key || '');
  if (!key) return { ok: false, error: 'unauthorized' };
  const roster = readSheetAsObjects(getSS().getSheetByName('roster')).rows.map(stripRowIndex);
  const me = findRosterByKey(roster, key);
  if (!me) return { ok: false, error: 'unauthorized' };

  const ym = String(body.ym || currentYmTaipei());
  const run = payRead('run').filter(function (r) {
    return String(r.ym) === ym && String(r.emp_id) === String(me.emp_id);
  })[0];
  const annual = payAnnualInfo(ym)[String(me.emp_id)] || null;
  if (!run) return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資尚未結算', annual: annual };
  if (String(run.status) !== 'final') {
    return { ok: true, ym: ym, name: me.name, ready: false, message: '本月薪資結算中，尚未定案', annual: annual };
  }
  const items = payRead('item').filter(function (i) {
    return String(i.ym) === ym && String(i.emp_id) === String(me.emp_id);
  });
  return { ok: true, ym: ym, name: me.name, ready: true, annual: annual,
           result: payRunItemsToResult(run, items), payday: payConfig().payday };
}

/* ═══════════════════ 掛載點 ═══════════════════ */

const PAYROLL_HANDLERS = {
  payroll_setup:        handlePayrollSetup,
  payroll_bootstrap:    handlePayrollBootstrap,
  payroll_import_schedule: handlePayrollImportSchedule,
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
};
