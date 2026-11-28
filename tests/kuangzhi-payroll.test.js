/**
 * 曠職：薪資端（2026-11-26 主管定案；開工確認第 5–8、10、11 題；合約 docs/kuangzhi/contract.md 第 7、8 節）
 * 規則白話（照推薦＋主管改定第 6-1 題）：
 *   ‧開關 KUANGZHI_FROM 沒設／壞值：薪資每一欄、ot_info、假別表、下拉、鎖定回應跟主線 f21cc25 逐字相同（①）。
 *   ‧開著、生效日起：leave 分頁「曠職」→ 假別 absent。績效走假別設定的對全勤（內建＝整筆歸零，名稱「績效獎金（當月有曠職）」）；
 *     計時滿勤加給不給（缺勤 1 天）。扣款只走 payKzDeduct_：全薪（底薪＋職能＋夜間＋店長加給＋績效上限）÷ 30 × 曠職天數，
 *     曠職天數＝各日班表時數 ÷ 8（單日最多 1 天）加總，最後才四捨五入到元；月中到職不折算；計時 0（主管 2026-11-26 定案）。
 *   ‧疑似曠職（已發布班表上班日、沒打卡、沒核定、沒登記、沒有待審或已核准的請假出差忘打卡單、不是國定假日）只提醒、不動金額；
 *     生效日起有疑似沒處理 → 鎖月擋（句 22），但先用 KUANGZHI_LOCK_BLOCK 包住、預設不擋（關著時鎖定跟主線相同）。已認定的曠職不被「請假單和請假登記對不上」擋。
 *   ‧沒有曠職的月份：金額每一欄跟主線相同（不可降的標準 1）。
 * 手算（示意薪資，不是任何同仁）：正職底薪 32,000、績效上限 2,000、其他加給 0、每日倒扣 100；12 月班表週一到週五上班（A 班 8 小時）、週六休息日、週日例假，12/25 國定假日。
 *   全薪 34,000 ÷ 30 ＝ 1,133.33／天
 *   H1 曠職 1 天（12/10，班表 8 小時）：底薪 32,000 不變；績效 0（績效獎金（當月有曠職））；扣「曠職(無薪) 1天」1,133 → 應發 32,000、扣款 1,133
 *   H2 班表 4 小時曠職＝0.5 天：567
 *   H2b 一天 8 小時＋一天 4 小時＝1.5 天：1,700；H2c 班表 9 小時也只算 1 天：1,133
 *   H3 12/16 到職、曠職 1 天：全薪不折算 → 1,133；績效 0
 *   H4 連續 3 天曠職（12/9–12/11）：3,400；績效 0；已認定連續 3 天／本月 3 天（句 18）
 *   H5 計時（小辛辣，滿勤勾選、時數 ≥ 100）：沒曠職有滿勤加給 時數×10；曠職 1 天 → 沒有滿勤加給、扣款 0（全薪 0）
 *   H6 疑似（12/15 沒處理）：金額跟主線相同；鎖月擋句 22「下面 1 天是疑似曠職還沒處理…：12/15 測試甲」；認定後可以鎖
 *   H7 認定後重新核定成病假 8 小時：曠職沒了、扣款列沒了；病假扣 8 × 142 × 0.5 ＝ 568
 *   H8 小辛辣假別表把曠職設「按天遞減」：績效 2,000 − 100 ＝ 1,900
 * 全部虛構門市與同仁（測試甲～丁）。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 2000) + '\n   規則要 ' + w.slice(0, 2000)); }
};
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key';
const ROOT = path.join(__dirname, '..');
const AS = path.join(ROOT, 'apps-script');
const BASE = process.env.KZ_BASE || 'f21cc25';
const cur = (f) => fs.readFileSync(path.join(AS, f), 'utf8');
const old = (f) => cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f], { encoding: 'utf8', maxBuffer: 64 << 20 });
const SRC = { now: { C: cur('Code.gs'), P: cur('Payroll.gs'), R: cur('Requests.gs'), SP: cur('SchedPub.gs') },
              base: { C: old('Code.gs'), P: old('Payroll.gs'), R: old('Requests.gs'), SP: old('SchedPub.gs') } };

/** 跟 helpers/payroll-vm.js 同一套假環境，但 Code／Payroll／Requests／SchedPub 可以換版本 */
function load(src, opt) {
  const props = opt.props || {};
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); const t = new Date(d.getTime() + 8 * 3600000); return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    __DATA: J(opt.data), __CLOCK: J(opt.clock), __TODAY: opt.today || '2027-01-05', __PUB: J(opt.pub || {}), __COUNT: {},
  };
  vm.createContext(sb);
  vm.runInContext(src.C + '\n' + src.P + '\n' + src.R + '\n' + src.SP, sb, { filename: 'clock.gs' });
  vm.runInContext(`
    payRead = function(kind){ __COUNT['payRead:'+kind]=(__COUNT['payRead:'+kind]||0)+1; return (__DATA[kind]||[]).map(function(r){return Object.assign({},r)}); };
    payReplaceAll = function(kind, rows){ __DATA[kind]=rows.map(function(r){return Object.assign({},r)}); };
    payAppend = function(kind, rows){ __DATA[kind]=(__DATA[kind]||[]).concat(rows); };
    payWriteLocked_ = function(kinds, fn){ fn(); return true; };
    payClockRead = function(store, sheet){ __COUNT['clock:'+sheet]=(__COUNT['clock:'+sheet]||0)+1; return ((__CLOCK[store]||{})[sheet]||[]).map(function(r){return Object.assign({},r)}); };
    payHasClock = function(){ return true; };
    payEmpStoresMap = function(){ return {}; };
    todayTaipeiStr = function(){ return __TODAY; };
    nowTaipeiIso = function(){ return __TODAY+'T09:00:00+08:00'; };
    payYesterday_ = function(){ var d=new Date(__TODAY+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); };
    schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(__PUB)); };
    CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    paySchedMissingAll_=function(){return [];}; payUnapprovedAll_=function(){return [];}; payCompNegatives=function(){return [];};
    __SCAN = {};
    if (typeof payCalcOne === 'function') { var __pcOrig = payCalcOne; payCalcOne = function(e, ym, att){ if (att && att.kz_scan) __SCAN[String(e.emp_id)] = JSON.parse(JSON.stringify(att.kz_scan)); return __pcOrig.apply(this, arguments); }; }
  `, sb);
  sb.post = (fn, body) => J(vm.runInContext(fn, sb)(Object.assign({ admin_key: KEY }, body)));
  sb.call = (fn, ...a) => J(vm.runInContext(fn, sb)(...a));
  // 乙（2026-11-28）：薪資回應不再帶 kz_suspect；規則測試改看 payKzScan_ 掃出來的疑似（＝丙要沿用的判斷），沒有＝undefined（同改版前回應的寫法）
  sb.sus = (id) => { const sc = (sb.__SCAN || {})[id || 'E01']; return sc && sc.suspect.length ? sc.suspect : undefined; };
  sb.susStreak = (id) => { const sc = (sb.__SCAN || {})[id || 'E01']; return sc ? sc.suspect_streak : undefined; };
  return sb;
}

/* ── 班表：期別 T02＝11/29–12/26、T03＝12/27–2027/01/23；週一～五 W（A 班 10:00–19:00 休 60＝8 小時）、週六 H、週日 R ── */
const PERIODS = { T01: '2026-11-01', T02: '2026-11-29', T03: '2026-12-27' };
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const cellOf = (d, marks) => (marks && marks[d]) || (dow(d) === 0 ? { t: 'R' } : dow(d) === 6 ? { t: 'H' } : { t: 'W', s: 'A' });
function pubRows(code, people) {
  const out = {};
  Object.keys(PERIODS).forEach((p) => {
    out[code + '|' + p] = { shifts: [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }],
      rows: people.map((x) => ({ emp_id: x.id, name: x.name, cells: Array.from({ length: 28 }, (_, i) => cellOf(addDays(PERIODS[p], i), x.marks)) })) };
  });
  return out;
}
const ft = (o) => Object.assign({ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: 32000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 2000,
  ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-06-15', leave_date: '', meal_allow: 0, active: 'true', store: 'SSLGF' }, o || {});
const pt = (o) => ft(Object.assign({ emp_id: 'P01', name: '測試丙', is_full_time: 'false', base: 0, attend_cap: 0, wage: 200 }, o || {}));
const AP = (date, id, h, st) => ({ date, emp_id: id, name: '', periods: h ? '10:00-' + (10 + h + 1) + ':00' : '', approved_hours: h, status_text: st || (h ? '正常' : '全天請假'), manager_name: '店長甲', entered_at: date + 'T23:00:00+08:00' });
const LV = (date, name, type, h) => ({ '日期': date, '姓名': name, '假別': type, '時數': h });
const decDays = () => { const o = []; for (let i = 1; i <= 31; i++) o.push('2026-12-' + ('0' + i).slice(-2)); return o; };
const workDays = (marks) => decDays().filter((d) => cellOf(d, marks).t === 'W' && d !== '2026-12-25');
const HOL = () => [{ ym: '2026-11', red_days: 9, note: '', dates: '', store: '' }, { ym: '2026-12', red_days: 9, note: '', dates: '2026-12-25', store: '' }];
const STORES = () => [{ code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }];

/** o：master（陣列）、skip（{emp:[日期]} 不核定的上班日）、extraAp、leave、requests、events、marks、leaveType、ym 用不到 */
function scene(o) {
  o = o || {};
  const master = o.master || [ft()];
  const approved = [];
  master.forEach((m) => workDays((o.marks || {})[m.emp_id]).forEach((d) => {
    if (((o.skip || {})[m.emp_id] || []).indexOf(d) < 0) approved.push(AP(d, m.emp_id, m.is_full_time === 'true' ? 8 : 6));
  }));
  (o.extraAp || []).forEach((x) => approved.push(x));
  const people = master.map((m) => ({ id: m.emp_id, name: m.name, marks: (o.marks || {})[m.emp_id] }));
  return {
    data: { master, xmap: [], store: STORES(), holiday: HOL(), config: o.config || [], run: [], item: [], input: [], bonus: [], audit: [],
            leave_type: o.leaveType || [], leave_span: [], leave_event: [], cost_snapshot: [] },
    clock: { SSLGF: { roster: master.map((m) => ({ emp_id: m.emp_id, name: m.name, active: 'true' })), events: o.events || [], approved,
                      leave: o.leave || [], requests: o.requests || [] } },
    pub: pubRows('', people),
  };
}
const envOf = (sc, which, props, today) => load(SRC[which], { data: sc.data, clock: sc.clock, pub: sc.pub, props: props || {}, today });
const ON = { KUANGZHI_FROM: '2026-12-01' };
const calc = (s, ym, inputs) => s.post('handlePayrollCalc', { ym: ym || '2026-12', store: 'SSLGF', inputs: inputs || {} });
const one = (r, id) => (r.results || []).find((x) => x.emp_id === (id || 'E01'));
const item = (x, key) => [].concat(x.earn, x.ded).find((i) => i.item_key === key);
const money = (r) => (r.results || []).map((x) => [x.emp_id, x.gross, x.deduction, x.net, x.earn.map((i) => [i.item_key, i.item_label, i.qty, i.amount]), x.ded.map((i) => [i.item_key, i.item_label, i.qty, i.amount])]);
const lock = (s, ym) => s.post('handlePayrollFinalize', { ym: ym || '2026-12', store: 'SSLGF', lock: true, operator: '測試' });
const KZ_NAME = '績效獎金（當月有曠職）';
const ONL = { KUANGZHI_FROM: '2026-12-01', KUANGZHI_LOCK_BLOCK: 'on' };   // 鎖月擋開關開著

console.log('══ ① 開關沒設／壞值：跟主線 ' + BASE + ' 逐字相同（驗收 1）══');
{
  // 一個月裡什麼都有：疑似（12/15 沒來沒單）、手填的「曠職」登記（12/10，今天的系統當成對不到假別）、事假、遲到
  const sc = scene({ master: [ft(), ft({ emp_id: 'E02', name: '測試乙' }), pt()], skip: { E01: ['2026-12-10', '2026-12-15'], E02: ['2026-12-11'] },
    extraAp: [AP('2026-12-10', 'E01', 0), AP('2026-12-11', 'E02', 0)],
    leave: [LV('2026-12-10', '測試甲', '曠職', 8), LV('2026-12-11', '測試乙', '事假', 8)],
    requests: [{ id: 'R1', emp_id: 'E02', name: '測試乙', kind: 'leave', leave_type: '事假', date: '2026-12-11', hours: 8, status: 'approved', voided_at: '' }] });
  const base = envOf(sc, 'base');
  const bCalc = calc(base), bNov = calc(base, '2026-11'), bLT = base.post('handlePayrollLeaveTypeGet', { store: 'SSLGF' });
  const bOpt = base.post('handlePayrollLeaveOptions', { store: 'SSLGF', ym: '2026-12' });
  calc(base); const bLock = lock(base);
  for (const [label, props] of [['沒設', {}], ['空白', { KUANGZHI_FROM: '' }], ['on', { KUANGZHI_FROM: 'on' }], ['2026-12-32', { KUANGZHI_FROM: '2026-12-32' }], ['2026/12/01', { KUANGZHI_FROM: '2026/12/01' }]]) {
    const s = envOf(sc, 'now', props);
    eq(calc(s), bCalc, `${label}：12 月試算整個回應（金額、明細、ot_info、提醒）相同`);
    eq(calc(s, '2026-11'), bNov, `${label}：11 月試算相同`);
    eq(s.post('handlePayrollLeaveTypeGet', { store: 'SSLGF' }), bLT, `${label}：假別設定頁回應相同（沒有曠職列、沒有 kz_on）`);
    eq(s.post('handlePayrollLeaveOptions', { store: 'SSLGF', ym: '2026-12' }), bOpt, `${label}：核定頁假別下拉回應相同`);
    calc(s); eq(lock(s), bLock, `${label}：鎖定回應相同`);
    eq(s.__DATA.run.map((r) => [r.emp_id, r.gross, r.net, r.ot_info]), base.__DATA.run.map((r) => [r.emp_id, r.gross, r.net, r.ot_info]), `${label}：寫進 run 的草稿列相同`);
  }
  eq(bCalc.ok, true, '對照：主線試算成功（比對有東西）');
}

console.log('\n══ ② 開關開、沒有曠職的月份：金額每一欄跟主線相同（不可降的標準 1）══');
{
  const clean = scene({ master: [ft(), pt()] });
  eq(calc(envOf(clean, 'now', ON)), calc(envOf(clean, 'base')), '12 月全勤（沒有疑似、沒有曠職）：整個回應相同');
  const susp = scene({ master: [ft(), pt()], skip: { E01: ['2026-12-15'], P01: ['2026-12-16'] } });
  const sA = envOf(susp, 'now', ON), a = calc(sA), b = calc(envOf(susp, 'base'));
  eq(sA.sus(), ['2026-12-15'], '乙：掃描本身照樣找到 12/15（只是不放進薪資回應；丙會用）');
  eq(money(a), money(b), '有疑似、沒有曠職：每人應發、扣款、實發、每一列明細相同');
  eq(a, b, '乙：有疑似、沒有曠職＝整個回應（金額、明細、ot_info）跟主線相同——薪資頁不出疑似清單、「有排班沒核定」照改版前');
  eq([one(a).ot_info.kz_suspect, one(a).ot_info.no_show], [undefined, ['2026-12-15']], '乙：回應沒有 kz_suspect，no_show 照改版前列 12/15');
  const nov = scene({ master: [ft()], skip: { E01: [] }, leave: [LV('2026-11-20', '測試甲', '曠職', 8)], extraAp: [AP('2026-11-20', 'E01', 0)] });
  eq(calc(envOf(nov, 'now', ON), '2026-11'), calc(envOf(nov, 'base'), '2026-11'), '11 月（生效日之前）有手填曠職登記：照改之前，整個回應相同（第 11 題不回溯）');
}

/** H 系列共用：E01 12/10 認定曠職（核定 0＋leave 曠職 8）；sh＝短班時數 */
const kzScene = (days, o) => {
  o = o || {};
  const h = o.h || 8;
  return scene(Object.assign({ skip: { E01: days }, extraAp: days.map((d) => AP(d, 'E01', 0)), leave: days.map((d) => LV(d, '測試甲', '曠職', h)) }, o));
};
console.log('\n══ ③ 手算對照（績效、扣款佔位）══');
{
  const n0 = one(calc(envOf(scene(), 'now', ON)));
  eq([item(n0, 'base_salary').amount, item(n0, 'attend_bonus').item_label, item(n0, 'attend_bonus').amount, n0.gross], [32000, '績效獎金', 2000, 34000], 'H0 對照：全勤 底薪 32,000＋績效 2,000＝34,000');
  const r1 = one(calc(envOf(kzScene(['2026-12-10']), 'now', ON)));
  eq([item(r1, 'base_salary').amount, item(r1, 'attend_bonus').item_label, item(r1, 'attend_bonus').amount, item(r1, 'absent_deduct'), r1.gross, r1.deduction, r1.net],
    [32000, KZ_NAME, 0, { item_key: 'absent_deduct', item_label: '曠職(無薪) 1天', qty: 1, rate: 1133.33, amount: 1133 }, 32000, 1133, 30867], 'H1 曠職 1 天（班表 8 小時）：34,000 ÷ 30 × 1 ＝ 1,133；底薪不變、績效 0（句 20）');
  eq([r1.ot_info.kz_marked, r1.ot_info.kz_pending, r1.ot_info.kz_marked_alert, r1.ot_info.kz_suspect, r1.ot_info.no_show], [[{ date: '2026-12-10', h: 8 }], undefined, false, undefined, []], 'H1 ot_info：已認定 12/10、沒有待確認旗標、沒有疑似（已認定那天有假別登記，不在「有排班沒核定」）');
  eq(r1.ded.filter((x) => /_leave$/.test(x.item_key)), [], 'H1 一般假別扣款（時數×扣款時薪）沒有套到曠職');
  const r2 = one(calc(envOf(kzScene(['2026-12-10'], { h: 4 }), 'now', ON)));
  eq([item(r2, 'attend_bonus').amount, item(r2, 'absent_deduct').item_label, item(r2, 'absent_deduct').amount, r2.ot_info.kz_marked], [0, '曠職(無薪) 0.5天', 567, [{ date: '2026-12-10', h: 4 }]], 'H2 班表 4 小時＝0.5 天：34,000 ÷ 30 × 0.5 ＝ 566.67 → 567');
  const twoSc = scene({ skip: { E01: ['2026-12-10', '2026-12-11'] }, extraAp: [AP('2026-12-10', 'E01', 0), AP('2026-12-11', 'E01', 0)], leave: [LV('2026-12-10', '測試甲', '曠職', 8), LV('2026-12-11', '測試甲', '曠職', 4)] });
  const r2b = one(calc(envOf(twoSc, 'now', ON)));
  eq([item(r2b, 'absent_deduct').item_label, item(r2b, 'absent_deduct').amount], ['曠職(無薪) 1.5天', 1700], 'H2b 一天 8 小時＋一天 4 小時＝1.5 天：34,000 ÷ 30 × 1.5 ＝ 1,700（最後才取整）');
  const r2c = one(calc(envOf(kzScene(['2026-12-10'], { h: 9 }), 'now', ON)));
  eq([item(r2c, 'absent_deduct').item_label, item(r2c, 'absent_deduct').amount], ['曠職(無薪) 1天', 1133], 'H2c 班表 9 小時也只算 1 天：1,133');
  const r2d = one(calc(envOf(scene(), 'now', ON)));
  eq(item(r2d, 'absent_deduct'), undefined, 'H2d 當月沒有曠職：沒有曠職扣款這一列');
  const mid = (sc) => one(calc(envOf(sc, 'now', ON)));
  const r3n = mid(scene({ master: [ft({ hire_date: '2026-12-16' })] })), r3 = mid(kzScene(['2026-12-17'], { master: [ft({ hire_date: '2026-12-16' })] }));
  eq([item(r3, 'attend_bonus').amount, item(r3, 'absent_deduct').amount, item(r3, 'base_salary').amount === item(r3n, 'base_salary').amount, item(r3n, 'base_salary').amount < 32000], [0, 1133, true, true], 'H3 月中到職（底薪有折算）、曠職 1 天：全薪不折算仍扣 1,133、績效 0');
  const r4 = one(calc(envOf(kzScene(['2026-12-09', '2026-12-10', '2026-12-11']), 'now', ON)));
  eq([item(r4, 'attend_bonus').amount, item(r4, 'absent_deduct').item_label, item(r4, 'absent_deduct').amount, r4.ot_info.kz_marked.length, r4.ot_info.kz_marked_streak, r4.ot_info.kz_marked_alert], [0, '曠職(無薪) 3天', 3400, 3, 3, true], 'H4 連續 3 天各 8 小時：34,000 ÷ 30 × 3 ＝ 3,400；績效 0、到門檻（句 18）');
  const r4b = one(calc(envOf(kzScene(['2026-12-04', '2026-12-08', '2026-12-10']), 'now', ON)));
  eq([r4b.ot_info.kz_marked_streak, r4b.ot_info.kz_marked_alert], [1, false], 'H4b 3 天但中間有上班日：連續 1 天、沒到門檻');
  const r4c = one(calc(envOf(kzScene(['2026-12-11', '2026-12-14']), 'now', ON)));
  eq(r4c.ot_info.kz_marked_streak, 2, 'H4c 週五＋下週一（中間是休息日、例假）：連續 2 天（休假日不斷）');
  // H5 計時滿勤加給：P01 每個上班日 6 小時（22 天＝132 小時 ≥ 100）
  const ptSc = (days) => scene({ master: [pt()], skip: { P01: days }, extraAp: days.map((d) => AP(d, 'P01', 0)), leave: days.map((d) => LV(d, '測試丙', '曠職', 6)) });
  const r5n = one(calc(envOf(ptSc([]), 'now', ON), '2026-12', { P01: { full_attend: true } }), 'P01');
  const r5 = one(calc(envOf(ptSc(['2026-12-10']), 'now', ON), '2026-12', { P01: { full_attend: true } }), 'P01');
  eq([!!item(r5n, 'pt_attend_plus'), item(r5n, 'pt_attend_plus') && item(r5n, 'pt_attend_plus').amount], [true, 1320], 'H5 對照：計時沒曠職有滿勤加給 132 小時（22 個上班日 × 6）× 10 ＝ 1,320');
  eq([item(r5, 'pt_attend_plus'), item(r5, 'absent_deduct').amount, item(r5, 'absent_deduct').item_label, r5.ot_info.kz_marked], [undefined, 0, '曠職(無薪) 0.8天', [{ date: '2026-12-10', h: 6 }]], 'H5 計時曠職 1 天（班表 6 小時＝0.75 天）：沒有滿勤加給（第 7 題 C）、扣款 0（全薪 0，6-4 不另外處理）');
  // H8 小辛辣假別表把曠職設「按天遞減」
  const LT = [
    { code: 'personal', name: '事假', pay_ratio: 0, count_absent: true, offset_shortfall: true, active: true, sort: 10, store: '' },
    { code: 'absent', name: '曠職', pay_ratio: 0, count_absent: true, offset_shortfall: false, attend_effect: 'deduct', active: true, sort: 20, store: '' },
  ];
  const r8 = one(calc(envOf(kzScene(['2026-12-10'], { leaveType: LT }), 'now', ON)));
  eq([item(r8, 'attend_bonus').item_label, item(r8, 'attend_bonus').amount, item(r8, 'absent_deduct').amount], ['績效獎金', 1900, 1133], 'H8 假別表把曠職設按天遞減：績效 2,000 − 100 ＝ 1,900；扣款照算 1,133');
  const r8b = one(calc(envOf(kzScene(['2026-12-10'], { leaveType: [Object.assign({}, LT[1], { pay_ratio: 1, attend_effect: 'void' })] }), 'now', ON)));
  eq([item(r8b, 'attend_bonus').amount, item(r8b, 'absent_deduct').amount, r8b.ded.filter((x) => /_leave$/.test(x.item_key))], [0, 1133, []], 'H8b 假別表曠職給薪比例改成 100%：金額不變（仍 1,133、不走一般扣款）');
}

console.log('\n══ ④ 疑似曠職：只提醒、鎖月擋（第 3、8 題）══');
{
  const sc = scene({ skip: { E01: ['2026-12-15'] } });
  const s = envOf(sc, 'now', ONL);
  const r = calc(s);
  eq([s.sus(), one(r).ot_info.kz_suspect, one(r).ot_info.kz_suspect_alert, one(r).gross], [['2026-12-15'], undefined, undefined, 34000], 'H6 12/15 掃描是疑似；乙：回應不帶疑似、金額不動（績效照給）');
  const L = lock(s);
  eq([L.ok, L.error || ''], [true, ''], 'H6 乙：KUANGZHI_LOCK_BLOCK 開著也不擋（草稿沒有疑似清單＝等同關；合約寫明乙期間不開）');
  // 認定後：核定 0＋leave 曠職 → 不再疑似、可以鎖、也不被「請假單和請假登記對不上」擋
  const sc2 = kzScene(['2026-12-15']);
  const s2 = envOf(sc2, 'now', ONL);
  calc(s2);
  const L2 = lock(s2);
  eq([L2.ok, L2.error || ''], [true, ''], 'H6b 認定後可以鎖（沒有疑似、請假對不上豁免曠職）');
  eq(s2.call('payLeaveMismatch_', '2026-12', 'SSLGF'), [], 'H6c 「請假單和請假登記對不上」不列曠職');
  // 兩人兩天
  const sc3 = scene({ master: [ft(), ft({ emp_id: 'E02', name: '測試乙' })], skip: { E01: ['2026-12-18'], E02: ['2026-12-17', '2026-12-18'] } });
  const s3 = envOf(sc3, 'now', ONL); calc(s3);
  eq([s3.sus('E01'), s3.sus('E02'), lock(s3).ok], [['2026-12-18'], ['2026-12-17', '2026-12-18'], true], 'H6d 多人多天：掃描照列；乙：開關開著也鎖得下去');
  // 草稿之後才補了單：疑似清單跟草稿不同 → stale_run（要重算）
  const s4 = envOf(scene({ skip: { E01: ['2026-12-15'] } }), 'now', ONL); calc(s4);
  s4.__CLOCK.SSLGF.requests.push({ id: 'R9', emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '病假', date: '2026-12-15', hours: 8, status: 'pending', voided_at: '' });
  { const b4 = envOf(scene({ skip: { E01: ['2026-12-15'] } }), 'base'); calc(b4); b4.__CLOCK.SSLGF.requests.push({ id: 'R9', emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '病假', date: '2026-12-15', hours: 8, status: 'pending', voided_at: '' });
    eq(lock(s4), lock(b4), 'H6e 乙：開關開著、試算後同仁補了單，草稿比對跟主線相同（疑似清單不參與）'); }
  // 鎖月擋開關（KUANGZHI_LOCK_BLOCK）關著＝預設：鎖定行為跟主線相同（只在薪資頁提醒）
  const lockPair = (sc, mut) => {
    const a = envOf(sc, 'now', ON), b = envOf(sc, 'base');
    calc(a); calc(b);
    if (mut) { mut(a); mut(b); }
    return [lock(a), lock(b)];
  };
  for (const [nm, props] of [['沒設', ON], ['空白', { KUANGZHI_FROM: '2026-12-01', KUANGZHI_LOCK_BLOCK: '' }], ['off', { KUANGZHI_FROM: '2026-12-01', KUANGZHI_LOCK_BLOCK: 'off' }], ['true', { KUANGZHI_FROM: '2026-12-01', KUANGZHI_LOCK_BLOCK: 'true' }]]) {
    const sc5 = scene({ skip: { E01: ['2026-12-15'] } });
    const a = envOf(sc5, 'now', props), b = envOf(sc5, 'base'); calc(a); calc(b);
    eq(lock(a), lock(b), 'L1 鎖月擋開關「' + nm + '」：有疑似也照主線鎖得下去（鎖定回應相同）');
  }
  const [la, lb] = lockPair(scene({ skip: { E01: ['2026-12-15'] } }), (x) => x.__CLOCK.SSLGF.requests.push({ id: 'R9', emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '病假', date: '2026-12-15', hours: 8, status: 'pending', voided_at: '' }));
  eq(la, lb, 'L2 開關關：試算後疑似清單變了也不因此擋 stale_run（草稿比對跟主線相同）');
  const [lc, ld] = lockPair(scene({ master: [ft(), ft({ emp_id: 'E02', name: '測試乙' })], skip: { E02: ['2026-12-17', '2026-12-18'] } }));
  eq(lc, ld, 'L3 開關關：兩人多天疑似，鎖定回應跟主線相同');
  eq(la.ok, true, 'L 對照：主線本來就鎖得下去（比對有東西）');
  // 規則細節（第 3 題）
  const rule = (o) => { const x = envOf(scene(Object.assign({ skip: { E01: ['2026-12-15'] } }, o)), 'now', ON); calc(x); return x.sus(); };
  eq(rule({ events: [{ ts: '2026-12-15T10:02:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }] }), undefined, '3-4 只有上班卡：不算疑似');
  eq(rule({ events: [{ ts: '2026-12-15T10:02:00+08:00', emp_id: 'E01', type: 'in', status: 'rejected' }] }), undefined, '被擋的卡也算有打卡：不算疑似');
  eq(rule({ events: [{ ts: '2026-12-16T05:30:00+08:00', emp_id: 'E01', type: 'out', status: 'ok' }] }), undefined, '隔天 05:30 下班卡算前一天：不算疑似');
  eq(rule({ requests: [{ id: 'R1', emp_id: 'E01', name: '測試甲', kind: 'miss', date: '2026-12-15', status: 'pending', voided_at: '' }] }), undefined, '3-3 有待審忘打卡單：不算疑似');
  eq(rule({ requests: [{ id: 'R1', emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '病假', date: '2026-12-15', status: 'rejected', voided_at: '' }] }), ['2026-12-15'], '被退回的單：回到疑似');
  eq(rule({ requests: [{ id: 'R1', emp_id: 'E01', name: '測試甲', kind: 'ot', date: '2026-12-15', status: 'approved', voided_at: '' }] }), ['2026-12-15'], '加班單不算「有單」：仍是疑似');
  eq(rule({ marks: { E01: { '2026-12-15': { t: 'H', s: 'A' } } } }), undefined, '3-1 休息日排班沒來：不算疑似');
  eq(rule({ marks: { E01: { '2026-12-15': { t: 'L', l: '特' } } } }), undefined, '班表排請假：不算疑似');
  { const x = envOf(scene({ skip: { E01: ['2026-12-25'] } }), 'now', ON); calc(x); eq(x.sus(), undefined, '3-6 國定假日（12/25）排上班沒來：不算疑似'); }
  const rg = scene({ skip: { E01: ['2026-12-15'] } });
  rg.data.store = [{ code: 'MZTRG', name: '墨竹亭瑞光', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'mzt' }];
  rg.data.master = rg.data.master.map((m) => Object.assign({}, m, { store: 'MZTRG' }));
  rg.clock = { MZTRG: rg.clock.SSLGF }; rg.pub = pubRows('mztrg', [{ id: 'E01', name: '測試甲' }]);
  { const x = load(SRC.now, { data: rg.data, clock: rg.clock, pub: rg.pub, props: ON }); x.post('handlePayrollCalc', { ym: '2026-12', store: 'MZTRG' }); eq(x.sus(), undefined, '3-6 瑞光 2027-01-01 前：不算疑似'); }
  const half = envOf(scene({ skip: { E01: ['2026-12-15'] } }), 'now', ON, '2026-12-10');
  half.post('handlePayrollCalc', { ym: '2026-12', store: 'SSLGF' }); eq(half.sus(), undefined, '月中草稿（今天 12/10、算到 12/9）：12/15 還沒到，不列');
  // 第 10 題 B：疑似達門檻（句 19）
  const s10 = envOf(scene({ skip: { E01: ['2026-12-14', '2026-12-15', '2026-12-16'] } }), 'now', ON), r10 = one(calc(s10));
  eq([s10.susStreak(), r10.ot_info.kz_suspect_streak, r10.ot_info.kz_suspect_alert, r10.ot_info.absent_alert, r10.ot_info.absent_streak], [3, undefined, undefined, true, 3],
    '乙：掃描連續 3 天；回應不出疑似門檻（句 19），改回改版前的「有排班沒核定」紅字（absent_alert，連續 3 天）');
}

console.log('\n══ ⑤ 生效日在月中（開關設 2026-12-15）══');
{
  const sc = scene({ skip: { E01: ['2026-12-08', '2026-12-10', '2026-12-16'] }, extraAp: [AP('2026-12-10', 'E01', 0)], leave: [LV('2026-12-10', '測試甲', '曠職', 8)] });
  const s5 = envOf(sc, 'now', { KUANGZHI_FROM: '2026-12-15' }), r = one(calc(s5));
  eq([r.ot_info.no_show, r.ot_info.kz_suspect, s5.sus(), r.ot_info.kz_marked, item(r, 'attend_bonus').item_label, item(r, 'attend_bonus').amount, item(r, 'absent_deduct')],
    [['2026-12-08', '2026-12-16'], undefined, ['2026-12-16'], undefined, '績效獎金', 1900, undefined], '乙：「有排班沒核定」整月照改版前（12/8、12/16）；12/10 曠職登記照改之前（對不到假別＝缺勤 1 天倒扣 100）；掃描 12/16 疑似但不放進回應');
}

console.log('\n══ ⑥ 重新核定成病假（第 12 題 A）══');
{
  const sc = scene({ skip: { E01: ['2026-12-10'] }, extraAp: [AP('2026-12-10', 'E01', 0)], leave: [LV('2026-12-10', '測試甲', '病假', 8)],
    requests: [{ id: 'R1', emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '病假', date: '2026-12-10', hours: 8, status: 'approved', voided_at: '' }] });
  const r = one(calc(envOf(sc, 'now', ON)));
  eq([item(r, 'absent_deduct'), item(r, 'sick_leave') && item(r, 'sick_leave').amount, item(r, 'sick_leave') && item(r, 'sick_leave').item_label, r.ot_info.kz_marked, r.ot_info.kz_pending],
    [undefined, 568, '病假', undefined, undefined], 'H7 曠職改成病假 8 小時：曠職、佔位都沒了；病假扣 8 × 142 × 0.5 ＝ 568');
}

console.log('\n══ ⑦ 假別表與下拉（第 5 題 A：表上有資料也自動補；選不到）══');
{
  const TBL = [{ code: 'personal', name: '事假', pay_ratio: 0, count_absent: true, offset_shortfall: true, active: true, sort: 10, store: '', note: '自訂' },
               { code: 'sick', name: '病假', pay_ratio: 0.5, count_absent: true, offset_shortfall: true, active: true, sort: 20, store: '', note: '' }];
  const s = envOf(scene({ leaveType: TBL }), 'now', ON);
  const lt = s.call('payLeaveTypes', 'SSLGF');
  eq(lt.map((t) => t.code), ['personal', 'sick', 'comp', 'absent'], '表上有資料（沒有曠職）：自動補內建曠職列（排最後）');
  eq(lt.filter((t) => t.code === 'absent').map((t) => [t.name, t.pay_ratio, t.count_absent, t.offset_shortfall, t.attend_effect, t.count_meal_day, t.note]),
    [['曠職', 0, true, false, 'void', true, '曠職：主管在核定頁認定的無故缺勤。只能由「認定曠職」按鈕產生，一般假別下拉與同仁請假單都選不到。']], '內建曠職列：對全勤＝整筆歸零、說明＝句 23');
  const base = envOf(scene({ leaveType: TBL }), 'base').call('payLeaveTypes', 'SSLGF');
  eq(lt.filter((t) => t.code !== 'absent'), base, '表上既有的各列設定值一個都沒變');
  eq(s.__DATA.leave_type, TBL, '假別表本身沒有被寫（只在計算時補）');
  const off = envOf(scene({ leaveType: TBL.concat([{ code: 'absent', name: '曠職', active: false, store: '' }]) }), 'now', ON).call('payLeaveTypes', 'SSLGF');
  eq(off.some((t) => t.code === 'absent'), false, '表上有曠職但停用：尊重設定、不補');
  const opt = s.post('handlePayrollLeaveOptions', { store: 'SSLGF', ym: '2026-12' });
  eq([opt.ok, opt.types.some((t) => t.name === '曠職')], [true, false], '核定頁假別下拉（payroll_leave_options）：沒有曠職');
  const get = s.post('handlePayrollLeaveTypeGet', { store: 'SSLGF' });
  eq([get.kz_on, get.types.some((t) => t.code === 'absent')], [true, true], '假別設定頁：看得到曠職列、帶 kz_on（畫面顯示句 23）');
  const q = s.call('payMyLeaveQuota', 'E01', '測試甲', '2026-12', 'SSLGF');
  eq(JSON.stringify(q).indexOf('曠職'), -1, '同仁的假別額度卡：不列曠職');
}

console.log('\n══ ⑧ 扣款隔離與上線檢查（主管 2026-11-26 定案第 6-1 題）══');
{
  const s = envOf(scene(), 'now', ON);
  const D1 = (h, d) => ({ date: d || '2026-12-10', h });
  const amt = (days, e, cfg) => s.call('payKzDeduct_', e || ft(), '2026-12', days, cfg || {}).map((x) => [x.item_label, x.amount]);
  eq([amt([D1(8)]), amt([D1(4)]), amt([D1(8, '2026-12-09'), D1(8), D1(8, '2026-12-11')]), amt([D1(8), D1(4, '2026-12-11')])],
    [[['曠職(無薪) 1天', 1133]], [['曠職(無薪) 0.5天', 567]], [['曠職(無薪) 3天', 3400]], [['曠職(無薪) 1.5天', 1700]]], '大腦四組：8 小時 1,133／4 小時 567／3 天 3,400／8＋4 小時 1,700');
  eq([amt([D1(9)]), amt([D1(8)], ft({ hire_date: '2026-12-16' })), amt([D1(6)], pt())], [[['曠職(無薪) 1天', 1133]], [['曠職(無薪) 1天', 1133]], [['曠職(無薪) 0.8天', 0]]], '9 小時算 1 天／月中到職不折算／計時 0');
  eq(amt([D1(10)], ft(), { daily_hours: 10 }), [['曠職(無薪) 1天', 1133]], '每日基本工時參數 10：排 10 小時＝1 天');
  eq(amt([D1(1, '2026-12-01'), D1(1, '2026-12-02'), D1(1, '2026-12-03')]), [['曠職(無薪) 0.4天', 425]], '每天的金額不先取整：3 × 0.125 天＝0.375 天 → 34,000 ÷ 30 × 0.375 ＝ 425（逐天取整會是 3 × 142 ＝ 426）');
  eq(s.call('payKzDeduct_', ft(), '2026-12', [], {}), [], '沒有曠職：不加任何列');
  eq([s.call('payKzReleaseProblems_'), s.call('payLeaveFullPay_', ft())], [[], 34000], '佔位旗標已拿掉：上線檢查沒有問題；全薪基數＝請假扣款同一支 payLeaveFullPay_');
  const P = cur('Payroll.gs');
  eq((P.match(/payKzDeduct_\(/g) || []).length, 2, '扣多少只有一個地方算（payKzDeduct_ 定義＋一處呼叫）');
}

console.log('\n══ ⑨ 薪資頁字逐字照逐句表（句 16–20、22、23）══');
{
  const H = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8'), P = cur('Payroll.gs');
  [['句 16', '：疑似曠職（有排班、沒打卡、沒有任何單）${list(o.kz_suspect)}——請主管到核定頁處理（補單或認定曠職）</li>'],
   ['句 17', '：已認定曠職 ${o.kz_marked.length} 天 ${list(o.kz_marked.map(x=>x.date))}</li>'],
   ['句 18', '：已認定曠職連續 ${Number(o.kz_marked_streak)||0} 天／本月 ${o.kz_marked.length} 天，已達連續 3 天或當月 6 天，後續怎麼處理請人資確認</li>'],
   ['句 19', '：疑似曠職 ${o.kz_suspect.length} 天（最長連續 ${Number(o.kz_suspect_streak)||0} 天），已達連續 3 天或當月 6 天，請確認是否曠職</li>'],
   ['句 23', '曠職：主管在核定頁認定的無故缺勤。只能由「認定曠職」按鈕產生，一般假別下拉與同仁請假單都選不到。']].forEach(([k, t]) => eq(H.indexOf(t) > 0, true, k + ' 在 payroll.html'));
  eq(P.indexOf("'當月有曠職'") > 0 && P.indexOf("'（' + voidReason + '）'") > 0, true, '句 20：績效獎金（當月有曠職）');
  eq(P.indexOf("' 天是疑似曠職還沒處理，不能鎖定（請主管補單、核定，或認定曠職；班表排錯的請先改班表並發布）：'") > 0, true, '句 22 在 Payroll.gs');
}

console.log('\n══ ⑨ 驗收第二輪補：同日兩列、鎖月後試算、月中截止（2026-11-27；只加測試、程式不變）══');
{
  // 1a 合約第 7 節：「曠職天數＝每個認定曠職的日子『那天的班表時數 ÷ 每日基本工時』，單日最多 1 天，當月加總」（例：9 小時也是 1 天）
  //    → 同一人同一天兩列曠職（手填 8＋8）合併成那天 16 小時 → 封頂 1 天 → 34,000 ÷ 30 × 1 ＝ 1,133（不是 2 天 2,267）
  //    （正常路徑同一天按第二次會被擋 kz_day_done，合約 2-2 F；兩列只會來自手改 leave 分頁）
  const two = (rows) => item(one(calc(envOf(scene({ skip: { E01: [...new Set(rows.map((r) => r[0]))] },
    extraAp: [...new Set(rows.map((r) => r[0]))].map((d) => AP(d, 'E01', 0)), leave: rows.map((r) => LV(r[0], '測試甲', '曠職', r[1])) }), 'now', ON))), 'absent_deduct');
  const d1 = two([['2026-12-10', 8], ['2026-12-10', 8]]);
  eq([d1.item_label, d1.qty, d1.amount], ['曠職(無薪) 1天', 1, 1133], '1a 同一天兩列 8＋8：合併成那天、單日最多 1 天 → 1 天 1,133');
  const d2 = two([['2026-12-10', 8], ['2026-12-11', 8]]);
  eq([d2.item_label, d2.qty, d2.amount], ['曠職(無薪) 2天', 2, 2267], '1a 對照：兩天各 8 小時 → 2 天 2,267（34,000÷30×2＝2,266.67→2,267）');
  const d3 = two([['2026-12-10', 4], ['2026-12-10', 2]]);
  eq([d3.qty, d3.amount], [0.75, 850], '1a 同一天兩列 4＋2：合併 6 小時 → 0.75 天 850（34,000÷30×0.75＝850）');

  // 1b 已鎖定月份不能再改（Payroll.gs「薪酬挑錯第 1 項，Eason 2026-11-11 確認」；確認頁紅線「不動已鎖定月份」）：
  //    鎖定後再試算 → 回 locked、不重算；run／item 分頁的曠職扣款列不變
  const s = envOf(scene({ skip: { E01: ['2026-12-10'] }, extraAp: [AP('2026-12-10', 'E01', 0)], leave: [LV('2026-12-10', '測試甲', '曠職', 8)] }), 'now', ON);
  const r0 = calc(s); const L = lock(s);
  const snap = () => JSON.stringify([s.__DATA.run, s.__DATA.item]);
  const before = snap();
  const kzItems = s.__DATA.item.filter((i) => i.emp_id === 'E01' && i.item_key === 'absent_deduct').map((i) => +i.amount);
  eq([r0.ok, L.ok, kzItems], [true, true, [1133]], '1b 試算＋鎖定成功，item 分頁曠職扣款 1,133');
  // 鎖定後把 leave 改掉（例如有人事後手改），再試算也不能改到已鎖定的錢
  s.__CLOCK.SSLGF.leave = [];
  const again = calc(s);
  eq([again.ok, again.error, again.message], [false, 'locked', '2026-12 已鎖定，請先解鎖再重算'], '1b 鎖定後再試算：一進來就回 locked（不重算；字是既有的「已鎖定，請先解鎖再重算」）');
  eq(snap(), before, '1b 鎖定後再試算：run 與 item 分頁逐字不變（曠職扣款照鎖定時的 1,133）');

  // 2 月中截止（daily.until）：「整月試算」（dry_run＋full_month，月加班同步、加班試算用）不走月中截斷，逐日日子含今天以後；
  //   疑似只能算到昨天（UNTIL＝昨天）。今天 12/10：12/8 沒來＝疑似；12/15、12/22 還沒到＝不列
  const mid = envOf(scene({ skip: { E01: ['2026-12-08', '2026-12-15', '2026-12-22'] } }), 'now', ON, '2026-12-10');
  mid.post('handlePayrollCalc', { ym: '2026-12', store: 'SSLGF', dry_run: true, full_month: true });
  eq([mid.sus(), mid.susStreak()], [['2026-12-08'], 1], '2 今天 12/10 整月試算：掃描只列 12/8（12/15、12/22 在昨天之後不列）');
  const fullS = envOf(scene({ skip: { E01: ['2026-12-08', '2026-12-15', '2026-12-22'] } }), 'now', ON);
  fullS.post('handlePayrollCalc', { ym: '2026-12', store: 'SSLGF', dry_run: true, full_month: true });
  eq(fullS.sus(), ['2026-12-08', '2026-12-15', '2026-12-22'], '2 對照：今天 2027-01-05（月份已過完）三天都列');
}

console.log('\n══ ⑨ 曠職假別鎖（2026-11-28 主管定案外部審查擋項 2 選 B）：開關開著不能改名、停用、刪除；驗證＝存檔後重算，扣款與績效歸零仍在 ══');
{
  const LT = (name, active, extra) => Object.assign({ store: '', code: 'absent', name, pay_ratio: 0, count_absent: 'true', offset_shortfall: 'false', cap_days: '', cap_basis: '',
    over_ratio: 0, merge_into: '', cap_per_month: '', tenure_months: '', under_ratio: 0, min_unit: 'hour', window_before: '', window_days: '', window_max: '',
    attend_effect: 'void', count_meal_day: 'true', sort: 9980, note: '', active }, extra || {});
  const PERS = LT('事假', 'true', { code: 'personal', attend_effect: '', sort: 10 });
  const UI = (r) => Object.assign({}, r, { active: r.active !== 'false', count_absent: r.count_absent === 'true' });      // 網頁送的形狀（布林）
  const MSG = '「曠職」是系統認定曠職用的假別，不能改名、停用或刪除。';
  const save = (s, types, store) => s.post('handlePayrollLeaveTypeSet', { store: store === undefined ? '' : store, types: types.map(UI) });
  const after = (s) => { const r = one(calc(s)); const d = (r.ded || []).find((i) => i.item_key === 'absent_deduct'); const ab = item(r, 'attend_bonus'); return [d ? d.amount : 0, ab && ab.item_label, ab && ab.amount]; };
  const KEEP = [1133, KZ_NAME, 0];      // 34,000 ÷ 30 × 1；績效（當月有曠職）0
  const envT = (rows, props) => { const sc = kzScene(['2026-12-10']); sc.data.leave_type = rows; return envOf(sc, 'now', props || ON); };
  const cases = [
    ['改名「無故缺勤」', [PERS, LT('無故缺勤', 'true')]],
    ['停用', [PERS, LT('曠職', 'false')]],
    ['刪掉曠職列（另有事假）', [PERS]],
    ['曠職列改成別的代碼又改名', [PERS, LT('無故缺勤', 'true', { code: 'x9' })]],
  ];
  for (const [nm, next] of cases) {
    const s = envT([PERS, LT('曠職', 'true')]);
    const r = save(s, next);
    eq([r.ok, r.error, r.message], [false, 'kz_type_locked', MSG], 'L-' + nm + '：擋下、句子（暫用）');
    eq(after(s), KEEP, 'L-' + nm + '：存檔被擋 → 重算扣款 1,133、績效（當月有曠職）0 仍在');
    eq(s.__DATA.leave_type.map((x) => [x.code, x.name, x.active]), [['personal', '事假', 'true'], ['absent', '曠職', 'true']], 'L-' + nm + '：假別表沒被改');
  }
  { const s = envT([PERS, LT('曠職', 'true')]); const r = save(s, [Object.assign({}, PERS, { pay_ratio: 0.5 }), LT('曠職', 'true', { attend_effect: 'deduct' })]);
    eq(r.ok, true, 'L-改事假給薪比例、曠職對全勤改 deduct（名稱與啟用不變）：照存');
    const a = after(s); eq([a[0], a[1]], [1133, '績效獎金'], 'L-照存後重算：扣款 1,133 仍在（對全勤照表上設定）'); }
  { const s = envT([]); const r = save(s, [PERS]);
    eq(r.ok, true, 'L-原本沒有曠職列（用內建）、存一張只有事假的表：照存（內建列照補）'); eq(after(s), KEEP, 'L-內建列照扣、績效歸零'); }
  { const s = envT([]); const r = save(s, [PERS, LT('無故缺勤', 'true')]);
    eq([r.ok, r.error], [false, 'kz_type_locked'], 'L-原本用內建、新增一列代碼 absent 叫別的名字（會蓋掉內建、又能被一般核定選到）：擋'); }
  { const s = envT([PERS, LT('曠職', 'true', { code: 'kz1' })]); const r = save(s, [PERS, LT('曠職', 'true', { code: 'kz1' }), LT('無故缺勤', 'true')]);
    eq([r.ok, r.error], [false, 'kz_type_locked'], 'L-自訂列（kz1 曠職）還在、另加代碼 absent 叫別的名字（一般核定選得到、又會被當曠職扣全薪÷30）：擋'); }
  { const s = envT([PERS, LT('曠職', 'true', { code: 'kz1' })]); const r = save(s, [PERS, LT('缺勤', 'true', { code: 'kz1' })]);
    eq([r.ok, r.error], [false, 'kz_type_locked'], 'L-既有自訂列（代碼 kz1、名稱曠職）改名：擋'); eq(after(s), KEEP, 'L-既有自訂列：擋下後重算照扣'); }
  { const s = envT([PERS, LT('曠職', 'false')]);
    eq(after(s), [0, '績效獎金', 1900], 'L-開開關前就停用的店（另有事假）：已認定的扣款本來就不見（要靠上線前檢查，存檔鎖救不了）');
    eq(save(s, [PERS]).error, 'kz_type_locked', 'L-這種店存檔：原本那列（停用）存了之後不在 → 擋（要先把曠職改回啟用）');
    const r = save(s, [PERS, LT('曠職', 'true')]); eq(r.ok, true, 'L-改回啟用：照存'); eq(after(s), KEEP, 'L-改回後重算：扣款 1,133、績效歸零回來'); }
  { const s = envT([PERS, LT('曠職', 'true')]); s.__DATA.leave_type.push(LT('曠職', 'true', { store: 'SSLGF' }), Object.assign({}, PERS, { store: 'SSLGF' }));
    eq(save(s, [PERS], 'SSLGF').error, 'kz_type_locked', 'L-門市專屬範圍刪掉自己的曠職列：擋');
    eq(save(s, [PERS, LT('無故缺勤', 'true')], '').error, 'kz_type_locked', 'L-集團共用範圍改名：擋（就算這家有自己的曠職列）'); }
  // 開關關：跟主線逐字相同（存得進去、表一樣、回應一樣）
  for (const [nm, next] of cases) {
    const a = envT([PERS, LT('曠職', 'true')], {}), b = (() => { const sc = kzScene(['2026-12-10']); sc.data.leave_type = [PERS, LT('曠職', 'true')]; return envOf(sc, 'base'); })();
    eq([save(a, next), a.__DATA.leave_type], [save(b, next), b.__DATA.leave_type], 'L-開關關、' + nm + '：回應與存下的表跟主線 ' + BASE + ' 逐字相同');
  }
}

console.log('\n' + pass + ' 過、' + fail + ' 失敗');
if (fail) process.exit(1);
