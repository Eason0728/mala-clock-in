/**
 * 班表排了「國定假日假」、薪資國定假日清單沒有那一天 → 薪資頁提示（2026-11-23 主管：「做薪資端加『班表排了國定假日假、但薪資節日表沒有那一天』的提示」）
 *  ①純函式 payHolGap_／payHolGapView_／開關 payHolGapOn_
 *  ②整條 handlePayrollCalc → ot_info.hol_gap → 回應 hol_sched_gap → payroll_month（草稿、已鎖定）各個邊界
 *  ③只提示：金額、明細列、鎖定回應跟改版前（473c6cb）相同；不多讀任何分頁、不多讀班表
 *  ④起算月之前（2026-09／10／11）與開關關著的 2026-12：payroll_month、payroll_calc、payroll_get、鎖定回應跟 473c6cb 逐位元組相同
 * 全部虛構門市與同仁（測試甲～戊）；期望值手寫。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), crypto = require('crypto');
const { load, ftEmp, ptEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g + '\n   規則要 ' + w); }
};
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key';
const AS = path.join(__dirname, '..', 'apps-script');
const NEWP = fs.readFileSync(path.join(AS, 'Payroll.gs'), 'utf8');
const SP = fs.readFileSync(path.join(AS, 'SchedPub.gs'), 'utf8');

// 改版前的基準：固定 commit（主線 473c6cb，＝光復 @326 服務中的 薪資.js，sha1 前綴 54ab4f59a3c1）。不用 origin/main（會跟著變）。
const BASE_COMMIT = '473c6cb9f8a2246d628de2e35c5918666e6eca2f', BASE_SHA1 = '54ab4f59a3c1';
function loadBase() {
  let src;
  try { src = cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', BASE_COMMIT + ':apps-script/Payroll.gs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('取不到比對基準 ' + BASE_COMMIT.slice(0, 7) + ':apps-script/Payroll.gs（淺層複製？請 git fetch --unshallow；CI 要 fetch-depth: 0）：' + String(e.message).split('\n')[0]); }
  const sha = crypto.createHash('sha1').update(src).digest('hex');
  if (sha.slice(0, BASE_SHA1.length) !== BASE_SHA1) throw new Error('比對基準內容不對：sha1 ' + sha.slice(0, 12) + '，應為 ' + BASE_SHA1);
  return src;
}
const OLDP = loadBase();

/* ── 班表：營運系統期別（2026-11-01＝T01 第 1 天，每期 28 天）。T01＝11/01–11/28、T02＝11/29–12/26、T03＝12/27–2027/01/23 ── */
const GUO = { t: 'L', l: '國' };
const PERIODS = { T01: '2026-11-01', T02: '2026-11-29', T03: '2026-12-27' };
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
/** marks＝{ 'YYYY-MM-DD': cell }；沒標的日子＝上班（W、A 班） */
function pubRows(code, people) {
  const out = {};
  Object.keys(PERIODS).forEach((p) => {
    out[code + '|' + p] = { rows: people.map((x) => ({ emp_id: x.id, name: x.name,
      cells: Array.from({ length: 28 }, (_, i) => (x.marks || {})[addDays(PERIODS[p], i)] || { t: 'W', s: 'A' }) })) };
  });
  return out;
}
const STORES = () => [
  { code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' },
  { code: 'HQ', name: '總部', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'CF', name: '央廚', clock_ss_id: 'ck-cf', emp_prefix: '', active: 'true', support_group: '*' },
];
const AP = (date, emp_id, h) => ({ date, emp_id, name: '', periods: '09:00-' + (9 + h) + ':00', approved_hours: h, status_text: '', manager_name: '值班主管', entered_at: date + 'T23:00:00+08:00' });
const HOLROWS = () => [
  { ym: '2026-09', red_days: 8, note: '', dates: '', store: '' },
  { ym: '2026-10', red_days: 10, note: '', dates: '2026-10-09', store: '' },
  { ym: '2026-11', red_days: 9, note: '', dates: '', store: '' },
  { ym: '2026-12', red_days: 9, note: '', dates: '2026-12-25', store: '' },
];

/** 光復（SSLGF）一個月的情境。marks＝每人班表標記；over 可改 holiday／master／pub */
function scene(marks, over) {
  over = over || {};
  const master = over.master || [ftEmp({ emp_id: 'E01', name: '測試甲' }), ftEmp({ emp_id: 'E02', name: '測試乙' }), ptEmp({ emp_id: 'P01', name: '測試丙' })];
  const people = master.map((m) => ({ id: m.emp_id, name: m.name, marks: (marks || {})[m.emp_id] }));
  const clock = { SSLGF: { roster: [], events: [], leave: [], requests: [],
    approved: [AP('2026-12-23', 'E01', 8), AP('2026-12-25', 'E01', 8), AP('2026-12-22', 'E02', 8), AP('2026-12-23', 'P01', 6),
               AP('2026-11-20', 'E01', 8), AP('2026-10-15', 'E01', 8), AP('2026-09-15', 'E01', 8)] } };
  const data = { master, xmap: [], store: STORES(), holiday: over.holiday || HOLROWS(),
    config: [], run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [] };
  return { data, clock, pub: over.pub || pubRows('', people) };
}
function env(sc, opt) {
  opt = opt || {};
  const s = load({ data: J(sc.data), clock: J(sc.clock), today: opt.today || '2027-01-05', payrollSrc: (opt.src || NEWP) + '\n' + SP });
  s.__PUB = J(sc.pub || {}); s.__PUBN = 0; s.__PUBTHROW = !!opt.pubThrow;
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    schedPubLoad_ = function () { __PUBN++; if (__PUBTHROW) throw new Error('sched_pub 讀不到'); return JSON.parse(JSON.stringify(__PUB)); };
    paySchedMissingAll_=function(){return [];};payUnapprovedAll_=function(){return [];};payCompNegatives=function(){return [];};payLeaveMismatch_=function(){return [];};`, s);
  if (opt.from !== undefined) vm.runInContext('PAY_HOL_GAP_FROM = ' + JSON.stringify(opt.from) + ';', s);
  /* ptOff：計時國定假日調移（2026-11-28 定案，PAY_PT_HOL_MOVE_FROM；tests/pt-hol-move.test.js）關掉。這支比的是「黃字提示不動金額」跟 473c6cb，
     那版還沒有計時調移；計時丙 12/24 排了國定假日假，開著時 12/25 對他是一般上班日（沒上班多一筆 no_show 提醒、班表那段多讀主檔），是新規則本身的差別、不是提示造成的。 */
  if (opt.ptOff) vm.runInContext("PAY_PT_HOL_MOVE_FROM = '9999-12';", s);
  s.post = (fn, body) => J(s.call(fn, Object.assign({ admin_key: KEY }, body)));
  return s;
}
const calc = (s, ym, st) => s.post('handlePayrollCalc', { ym, store: st || 'SSLGF' });
const gapOf = (r, id) => { const x = (r.results || []).find((y) => y.emp_id === id); return x && x.ot_info ? (x.ot_info.hol_gap || null) : 'NO_OT_INFO'; };
const lock = (s, ym, st) => s.post('handlePayrollFinalize', { ym, store: st || 'SSLGF', lock: true, operator: '測試' });
/** 把新版多出的提示資料拿掉（金額比對用）：回應的 hol_sched_gap、每人 ot_info.hol_gap（物件或 JSON 字串） */
function strip(x) {
  x = J(x);
  const fix = (r) => {
    if (!r || r.ot_info == null) return;
    if (typeof r.ot_info === 'string') { const o = JSON.parse(r.ot_info); delete o.hol_gap; r.ot_info = JSON.stringify(o); }
    else delete r.ot_info.hol_gap;
  };
  if (Array.isArray(x)) x.forEach(fix);
  else { delete x.hol_sched_gap; (x.results || []).forEach(fix); if (x.run && x.run.results) x.run.results.forEach(fix); }
  return x;
}

console.log('══ ① 純函式與開關 ══');
{
  const s = env(scene({}));
  const g = (sched, hol, dates) => J(s.call('payHolGap_', sched, hol, dates));
  eq(g({ '2026-12-24': GUO, '2026-12-25': GUO }, ['2026-12-25'], ['2026-12-24', '2026-12-25']), ['2026-12-24'], 'L＋國 不在清單 → 列；在清單 → 不列');
  eq(g({ '2026-12-24': { t: 'L', l: '特' }, '2026-12-23': { t: 'H' }, '2026-12-22': { t: 'R' }, '2026-12-21': { t: 'W', s: 'A' } }, [], ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24']), [], '其他假別、休息日、例假、上班都不列');
  eq(g({ '2026-12-24': { t: 'W', l: '國' }, '2026-12-23': { t: 'L' } }, [], ['2026-12-23', '2026-12-24']), [], '只有 L＋國 才算（W 帶國、L 沒假別都不算）');
  eq(g({ '2026-12-24': GUO }, [' 2026-12-24 '], ['2026-12-24']), [], '清單日期前後有空白照樣對得到');
  eq(g({ '2026-12-24': GUO }, ['2026-12-25'], ['2026-12-01', '2026-12-02']), [], '不在 dates（例：離職後）不列');
  eq(g(undefined, ['2026-12-25'], ['2026-12-24']), [], '這個人沒有班表（undefined）→ 不列、不報錯');
  eq(g({ '2026-12-24': GUO }, null, ['2026-12-24']), ['2026-12-24'], '清單是 null（沒有雙薪日）→ L＋國 照列');
  const v = (ym, rs) => J(s.call('payHolGapView_', ym, rs));
  eq(v('2026-12', [{ emp_id: 'A', name: '甲', ot_info: { hol_gap: ['2026-12-24', '2026-12-31'] } }, { emp_id: 'B', name: '乙', ot_info: JSON.stringify({ hol_gap: ['2026-12-24'] }) }, { emp_id: 'C', name: '', ot_info: { hol_gap: ['2026-12-24'] } }, { emp_id: 'D', name: '丁' }]),
    [{ date: '2026-12-24', n: 3, names: ['甲', '乙', 'C'] }, { date: '2026-12-31', n: 1, names: ['甲'] }], '彙總：依日期、人數、姓名（物件或字串都讀；沒姓名用工號；沒有 ot_info 跳過）');
  eq(v('2026-12', [{ emp_id: 'A', name: '甲', ot_info: { ot_h: 0 } }]), null, '彙總：都沒有 → null（回應不帶）');
  eq(v('2026-12', [{ emp_id: 'A', name: '甲', ot_info: { hol_gap: ['2026-11-30'] } }]), null, '彙總：別的月份的日期不算');
  eq(v('2026-11', [{ emp_id: 'A', name: '甲', ot_info: { hol_gap: ['2026-11-20'] } }]), null, '彙總：起算月之前（2026-11）一律 null');
  eq(v('2026-12', [{ emp_id: 'A', name: '甲', ot_info: '{壞掉' }]), null, '彙總：ot_info 字串壞掉 → 當沒有、不報錯');
  const on = (ym) => s.call('payHolGapOn_', ym);
  eq([on('2026-11'), on('2026-12'), on('2027-01'), on(''), on('2026/12'), on(null)], [false, true, true, false, false, false], '上線值：2026-12 起才開');
  eq(vm.runInContext('PAY_HOL_GAP_FROM', s), '2026-12', '上線值 PAY_HOL_GAP_FROM＝2026-12');
  for (const bad of ['abc', '', null, '2026-13', '2026/12', 202612]) {
    vm.runInContext('PAY_HOL_GAP_FROM = ' + JSON.stringify(bad) + ';', s);
    eq([on('2026-11'), on('2026-12')], [false, true], `開關填錯值 ${JSON.stringify(bad)} → 照 2026-12`);
  }
  vm.runInContext("PAY_HOL_GAP_FROM = '9999-12';", s);
  eq(on('2026-12'), false, "開關 '9999-12' → 關");
}

console.log('\n══ ② 整條鏈：各個邊界 ══');
// 基本：清單只有 12/25；乙（正職）、丙（計時）12/24 排國定假日假；甲 12/25 排國定假日假（在清單）
const MK = { E01: { '2026-12-25': GUO }, E02: { '2026-12-24': GUO }, P01: { '2026-12-24': GUO } };
{
  const s = env(scene(MK));
  const r = calc(s, '2026-12');
  eq(r.ok, true, '計算成功');
  eq([gapOf(r, 'E01'), gapOf(r, 'E02'), gapOf(r, 'P01')], [null, ['2026-12-24'], ['2026-12-24']], '每人 ot_info.hol_gap：甲（在清單）沒有；乙（正職）、丙（計時）都有 12/24');
  eq(r.hol_sched_gap, [{ date: '2026-12-24', n: 2, names: ['測試乙', '測試丙'] }], '同一天多人：回應 hol_sched_gap 一筆、2 人、列姓名');
  eq(JSON.parse(s.__DATA.run.find((x) => x.emp_id === 'E02').ot_info).hol_gap, ['2026-12-24'], '草稿 run.ot_info 存了（之後開頁、鎖定後都讀得到）');
  const m = s.post('handlePayrollMonth', { ym: '2026-12', store: 'SSLGF' });
  eq([m.ok, m.run && m.run.status, m.hol_sched_gap], [true, 'draft', [{ date: '2026-12-24', n: 2, names: ['測試乙', '測試丙'] }]], 'payroll_month（草稿）從 run 彙總出同一份，不用再讀班表');
  const L = lock(s, '2026-12');
  eq([L.ok, L.error], [true, undefined], '不擋鎖定（有漏列日期照樣鎖成功）');
  const mf = s.post('handlePayrollMonth', { ym: '2026-12', store: 'SSLGF' });
  eq([mf.run && mf.run.status, mf.hol_sched_gap], ['final', [{ date: '2026-12-24', n: 2, names: ['測試乙', '測試丙'] }]], '已鎖定月份照樣帶（同 dup_xacct_on 等提醒的慣例：鎖定後仍顯示）');
  const g = s.post('handlePayrollGet', { ym: '2026-12' });
  eq(g.hol_sched_gap, undefined, 'payroll_get 不加欄位（只有 run.ot_info 裡多 hol_gap）');
}
// 薪資節日表有、班表沒排 → 不提示
{
  const s = env(scene({ E01: {}, E02: {}, P01: {} }));
  const r = calc(s, '2026-12');
  eq([r.ok, r.hol_sched_gap, gapOf(r, 'E01'), gapOf(r, 'E02')], [true, undefined, null, null], '清單有 12/25、班表沒人排國定假日假 → 不提示、ot_info 不多欄位');
}
// 班表沒發布／讀不到
{
  const sc = scene(MK); sc.pub = {};
  const s = env(sc); const r = calc(s, '2026-12');
  eq([r.ok, r.hol_sched_gap, gapOf(r, 'E02')], [true, undefined, null], '班表沒發布（sched_pub 空）→ 不提示、不報錯');
  const s2 = env(scene(MK), { pubThrow: true }); const r2 = calc(s2, '2026-12');
  eq([r2.ok, r2.hol_sched_gap, gapOf(r2, 'E02')], [true, undefined, null], '班表讀不到（schedPubLoad_ 丟例外）→ 不提示、不報錯');
  const s3 = env(scene(MK)); vm.runInContext('schedPubPeriodOf_ = undefined;', s3); const r3 = calc(s3, '2026-12');
  eq([r3.ok, r3.hol_sched_gap], [true, undefined], '沒有班表模組（schedPubPeriodOf_ 不存在）→ 不提示');
}
// 節日表讀不到：照既有行為（沒有該月那列 → no_holiday；新版跟 473c6cb 回一樣的錯，不多擋也不多放）
{
  const sc = scene(MK, { holiday: HOLROWS().filter((h) => h.ym !== '2026-12') });
  const a = env(sc, { src: OLDP }), b = env(sc);
  vm.runInContext('payHolidaySync = function(){ return []; };', a); vm.runInContext('payHolidaySync = function(){ return []; };', b);   // 不連人事行政總處
  const ra = calc(a, '2026-12'), rb = calc(b, '2026-12');
  eq([rb.ok, rb.error], [false, 'no_holiday'], '沒有 2026-12 紅字天數列 → 照舊 no_holiday');
  eq(JSON.stringify(rb) === JSON.stringify(ra), true, '跟 473c6cb 回應逐字相同');
  // 該月那列有、雙薪日空白（這個月沒有國定假日）→ 班表上的國定假日假全部列出（清單確實沒有）
  const sc2 = scene({ E02: { '2026-12-24': GUO } }, { holiday: HOLROWS().map((h) => h.ym === '2026-12' ? Object.assign({}, h, { dates: '' }) : h) });
  const r2 = calc(env(sc2), '2026-12');
  eq(r2.hol_sched_gap, [{ date: '2026-12-24', n: 1, names: ['測試乙'] }], '雙薪日空白 → 12/24 照列（清單確實沒有這天）');
}
// 週末國定假日與補假日：清單照「雙薪以補假為主」只有補假日 12/25（虛構：12/26 週六節日、補 12/25 週五）
{
  const s = env(scene({ E01: { '2026-12-26': GUO }, E02: { '2026-12-25': GUO }, P01: { '2026-12-25': GUO } }));
  const r = calc(s, '2026-12');
  eq(r.hol_sched_gap, [{ date: '2026-12-26', n: 1, names: ['測試甲'] }], '週六節日本身（不在雙薪日）排了國定假日假 → 列；補假日 12/25（在雙薪日）排了 → 不列');
  eq(gapOf(r, 'P01'), null, '計時同仁在補假日排國定假日假 → 不列');
  const r2 = calc(env(scene({ P01: { '2026-12-28': GUO } })), '2026-12');
  eq(r2.hol_sched_gap, [{ date: '2026-12-28', n: 1, names: ['測試丙'] }], '計時同仁在清單沒有的日子排國定假日假 → 照列（提示看的是清單，不分正職計時）');
}
// 月份跨期：T02（11/29–12/26）、T03（12/27–1/23）
{
  const mk = { E01: { '2026-11-30': GUO, '2026-12-28': GUO, '2027-01-04': GUO } };
  const s = env(scene(mk));
  const r = calc(s, '2026-12');
  eq(r.hol_sched_gap, [{ date: '2026-12-28', n: 1, names: ['測試甲'] }], '跨期：12 月只列 12/28；同一期的 11/30、下一個月的 1/4 不列');
  const rn = calc(s, '2026-11');
  eq([rn.ok, rn.hol_sched_gap, gapOf(rn, 'E01')], [true, undefined, null], '11 月（起算月之前）：11/30 也不列、ot_info 不多欄位');
}
// 到職／離職：只看在職日
{
  const master = [ftEmp({ emp_id: 'E01', name: '測試甲', leave_date: '2026-12-20' }), ftEmp({ emp_id: 'E02', name: '測試乙', hire_date: '2026-12-26' })];
  const r = calc(env(scene({ E01: { '2026-12-24': GUO }, E02: { '2026-12-24': GUO, '2026-12-29': GUO } }, { master })), '2026-12');
  eq(r.hol_sched_gap, [{ date: '2026-12-29', n: 1, names: ['測試乙'] }], '離職後、到職前的格子不算（甲 12/20 離職、乙 12/26 到職）');
}
// 月中草稿：算到昨天，但提示看整個月（還沒到的國定假日假也先提醒）
{
  const s = env(scene(MK), { today: '2026-12-10' });
  const r = calc(s, '2026-12');
  eq([r.ok, r.asof && r.asof.as_of, r.hol_sched_gap], [true, '2026-12-09', [{ date: '2026-12-24', n: 2, names: ['測試乙', '測試丙'] }]], '月中草稿（12/10）：12/24 還沒到也先提示');
}
// 總部／央廚：計薪單位 HQ；總部打卡的人用 hq 班表；在央廚打卡、班表由央廚發布的人（工號＋姓名對得上）照引擎的找法
{
  const master = [ftEmp({ emp_id: 'H01', name: '測試丁', store: 'HQ' }), ftEmp({ emp_id: 'C01', name: '測試戊', store: 'HQ' })];
  const pub = Object.assign(pubRows('hq', [{ id: 'H01', name: '測試丁', marks: { '2026-12-24': GUO } }]),
                            pubRows('cf', [{ id: 'C01', name: '測試戊', marks: { '2026-12-24': GUO, '2026-12-31': GUO } }]));
  const sc = scene({}, { master, pub });
  sc.clock = { HQ: { roster: [], events: [], leave: [], requests: [], approved: [AP('2026-12-23', 'H01', 8)] } };
  const r = calc(env(sc), '2026-12', 'HQ');
  eq([r.ok, r.hol_sched_gap], [true, [{ date: '2026-12-24', n: 2, names: ['測試丁', '測試戊'] }, { date: '2026-12-31', n: 1, names: ['測試戊'] }]], '總部：本店（hq）班表＋央廚（cf）發布的同名同號班表都看得到');
  const pub2 = pubRows('cf', [{ id: 'C01', name: '別人', marks: { '2026-12-24': GUO } }]);
  const sc2 = scene({}, { master: [master[1]], pub: pub2 }); sc2.clock = sc.clock;
  const r2 = calc(env(sc2), '2026-12', 'HQ');
  eq(r2.hol_sched_gap, undefined, '別家發布的列工號相同但姓名不同 → 不算這個人（同引擎，避免撞號）');
}
// 正職的國定假日調移（既有規則，說明提示句為什麼要提）：清單漏了 12/24、正職 12/24 排國定假日假 → 同一期 12/25 上班的國定假日加發被抵掉
{
  const s = env(scene({ E01: { '2026-12-24': GUO } }));
  const idx = s.call('paySchedIndex_');
  eq(J(s.call('payHolMoved_', '2026-12', 'SSLGF', s.__DATA.master, ['2026-12-25'], idx)), { E01: { '2026-12-25': true } }, '既有 payHolMoved_：甲 12/24（清單沒有）排國定假日假 → 12/25 當調移、不給國定假日加發（提示句「同一期其他國定假日上班的加給會被抵掉」的依據）');
}

console.log('\n══ ③ 只提示：金額、明細列、鎖定跟 473c6cb 相同；不多讀 ══');
for (const st of ['SSLGF']) {
  const sc = scene(MK);
  const a = env(sc, { src: OLDP }), b = env(sc, { ptOff: true });
  const ra = calc(a, '2026-12'), rb = calc(b, '2026-12');
  eq(rb.hol_sched_gap !== undefined && ra.hol_sched_gap === undefined, true, '前提：新版有提示、基準沒有');
  eq(JSON.stringify(strip(rb)) === JSON.stringify(ra), true, '拿掉提示資料後，計算回應（含每人應發／扣款／實付／明細）跟 473c6cb 逐字相同');
  eq(JSON.stringify(b.__DATA.item) === JSON.stringify(a.__DATA.item), true, '寫進 item 的每一列逐字相同');
  eq(JSON.stringify(strip(b.__DATA.run)) === JSON.stringify(a.__DATA.run), true, '寫進 run 的每一列：除了 ot_info.hol_gap 以外逐字相同');
  eq([JSON.stringify(b.__COUNT) === JSON.stringify(a.__COUNT), b.__PUBN === a.__PUBN], [true, true], `讀取次數：試算表／打卡分頁（${Object.keys(a.__COUNT).length} 種）與班表（${a.__PUBN} 次）都跟基準相同`);
  const la = lock(a, '2026-12'), lb = lock(b, '2026-12');
  eq(JSON.stringify(lb) === JSON.stringify(la), true, `鎖定回應逐字相同（${la.ok ? '鎖成功' : la.error}）`);
  eq(JSON.stringify(b.__DATA.audit) === JSON.stringify(a.__DATA.audit) && JSON.stringify(strip(b.__DATA.run)) === JSON.stringify(a.__DATA.run), true, '鎖定後 run（拿掉 hol_gap）、稽核逐字相同');
  const ma = a.post('handlePayrollMonth', { ym: '2026-12', store: st }), mb = b.post('handlePayrollMonth', { ym: '2026-12', store: st });
  eq(JSON.stringify(strip(mb)) === JSON.stringify(ma), true, '已鎖定月份 payroll_month：拿掉提示資料後逐字相同');
}
{
  const sc = scene(MK);
  const a = env(sc, { src: OLDP }), b = env(sc, { ptOff: true });
  calc(a, '2026-12'); calc(b, '2026-12');
  eq(JSON.stringify(b.post('payLockStale_', { ym: '2026-12', store: 'SSLGF' })), JSON.stringify(a.post('payLockStale_', { ym: '2026-12', store: 'SSLGF' })), '鎖定前重算比對（payLockStale_）回傳相同（hol_gap 不進比對字串）');
  // 提示那段出錯：不影響試算（只記 log）
  const c = env(sc, { ptOff: true }); vm.runInContext("payHolGap_ = function () { throw new Error('壞掉'); };", c);
  const rc = calc(c, '2026-12');
  eq([rc.ok, rc.hol_sched_gap, JSON.stringify(strip(rc)) === JSON.stringify(calc(env(sc, { src: OLDP }), '2026-12'))], [true, undefined, true], '提示那段丟例外 → 試算照常成功、不提示、金額照舊');
}

console.log('\n══ ④ 起算月之前與開關關著：跟 473c6cb 逐位元組相同 ══');
eq(OLDP !== NEWP, true, '基準與本版確實不同（比對有意義）');
function sameAll(ym, label, opt) {
  // 每個月都放「國定假日假在清單沒有的日子」：11/20、10/20、9/20、12/24
  const mk = { E01: { [ym + '-20']: GUO }, E02: { [ym + '-24']: GUO }, P01: { [ym + '-24']: GUO } };
  const sc = scene(mk);
  const a = env(sc, { src: OLDP }), b = env(sc, Object.assign({ ptOff: ym >= '2026-12' }, opt));   // 2026-09～11 開著計時調移照樣要逐位元組相同（開關之前的月份）
  const steps = [
    ['payroll_month（沒草稿、自動試算）', (s) => s.post('handlePayrollMonth', { ym, store: 'SSLGF' })],
    ['payroll_calc', (s) => calc(s, ym)],
    ['payroll_calc（試算 dry_run）', (s) => s.post('handlePayrollCalc', { ym, store: 'SSLGF', dry_run: true })],
    ['payroll_get', (s) => s.post('handlePayrollGet', { ym })],
    ['payroll_month（草稿）', (s) => s.post('handlePayrollMonth', { ym, store: 'SSLGF' })],
    ['鎖定', (s) => lock(s, ym)],
    ['payroll_month（已鎖定）', (s) => s.post('handlePayrollMonth', { ym, store: 'SSLGF' })],
    ['payroll_get（已鎖定）', (s) => s.post('handlePayrollGet', { ym })],
    ['解鎖', (s) => s.post('handlePayrollFinalize', { ym, store: 'SSLGF', lock: false, reason: '測試', operator: '測試' })],
  ];
  const diff = [], info = [];
  for (const [nm, f] of steps) {
    const ra = f(a), rb = f(b);
    if (JSON.stringify(ra) !== JSON.stringify(rb)) diff.push(nm);
    if (nm === '鎖定') info.push(ra.ok ? '鎖成功' : ra.error);
    if (nm === 'payroll_calc') info.push((ra.results || []).length + ' 人');
  }
  const store = ['run', 'item', 'audit', 'cost_snapshot'].filter((k) => JSON.stringify(a.__DATA[k]) !== JSON.stringify(b.__DATA[k]));
  eq([diff, store, JSON.stringify(a.__COUNT) === JSON.stringify(b.__COUNT), a.__PUBN === b.__PUBN], [[], [], true, true],
    `${label}：payroll_month／calc／get／鎖定／解鎖 ${steps.length} 個回應、run／item／稽核、讀取次數都跟 473c6cb 逐字相同（${info.join('、')}）`);
}
sameAll('2026-09', '2026-09');
sameAll('2026-10', '2026-10');
sameAll('2026-11', '2026-11（逐日加班已開、班表有國定假日假在 11/20、11/24）');
sameAll('2026-12', "2026-12 開關關（PAY_HOL_GAP_FROM='9999-12'）", { from: '9999-12' });
sameAll('2026-12', "2026-12 開關改 '2027-01'", { from: '2027-01' });
{
  // 開關關掉時，草稿上留著開著時算的 hol_gap：payroll_month 不帶（畫面不顯示）
  const s = env(scene(MK)); calc(s, '2026-12');
  vm.runInContext("PAY_HOL_GAP_FROM = '9999-12';", s);
  const m = s.post('handlePayrollMonth', { ym: '2026-12', store: 'SSLGF' });
  eq([m.ok, m.hol_sched_gap, JSON.parse(s.__DATA.run.find((x) => x.emp_id === 'E02').ot_info).hol_gap], [true, undefined, ['2026-12-24']], '開關關掉後，草稿上舊的 hol_gap 還在，但 payroll_month 不帶（畫面不顯示）');
}

console.log('\n══ ⑤ 畫面（payroll.html）══');
{
  const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  eq((H.match(/HOL_GAP=r\.hol_sched_gap\|\|\[\]/g) || []).length, 3, '三個載入點（autoCalc、loadMonth、doCalc）都從回應取 hol_sched_gap，沒有就清空');
  eq(/if\(HOL_GAP\.length\)\{/.test(H) && H.indexOf('國定假日清單可能漏了日子') > 0, true, '提醒區有這一行，只在有資料時顯示');
  const fn = H.slice(H.indexOf('function renderOtInfo('), H.indexOf('async function toggleLock('));
  eq(fn.indexOf('HOL_GAP') > 0 && !/HOL_GAP[^\n]*(lock|LOCK|finalize)/.test(H), true, '只在 renderOtInfo 顯示；鎖定流程不看 HOL_GAP');
  const render = (gap) => {
    const box = { innerHTML: '' };
    const ctx = { console, $: () => box, ROSTER_MISS: [], SAME_NAME: [], RESULTS: [], OT_PERIOD: {}, OT_MONTH_CAP: 54, NOT_IN_PAY: [], ZERO_RATIO: [], LEAVE_MM: [], HOL_GAP: gap,
      esc: (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      r2: (v) => Math.round(v * 100) / 100 };
    vm.createContext(ctx);
    vm.runInContext(fn.slice(0, fn.lastIndexOf('}') + 1) + '\nrenderOtInfo({});', ctx);
    return box.innerHTML;
  };
  eq(render([]), '', '沒有資料 → 提醒區空白（不多一個框）');
  eq(fs.readFileSync(path.join(__dirname, '..', 'payroll-guide.html'), 'utf8').indexOf('<li><span class="tag y">黃字</span>國定假日清單可能漏了日子（2026 年 12 月薪資起）：班表有同仁排了「國定假日假」，參數設定的國定假日雙薪日卻沒有那天。那天上班的同仁不會算國定假日加給；排了那天國定假日假的正職，會被當成把國定假日調到那天休，他本人同一期其他國定假日上班就不再加給。先核對雙薪日，漏了請找資訊部同步後重新計算；同仁本來就是調到那天休的，照現況即可。這個提醒不會擋鎖定。</li>') > 0, true, '手冊那一句＝定稿（含「不會擋鎖定」）');
  const html = render([{ date: '2026-12-24', n: 2, names: ['測試乙', '測試丙'] }, { date: '2026-12-31', n: 6, names: ['甲', '乙', '丙', '丁', '戊', '己<b>'] }]);
  eq(html.indexOf('班表有同仁排了「國定假日假」，但「2 參數設定」的國定假日雙薪日沒有這幾天：12/24（2 人：測試乙、測試丙）、12/31（6 人：甲、乙、丙、丁、戊 等）。') > 0, true, '文字：日期、人數、姓名；超過 5 人只列 5 個加「等」');
  eq(html.indexOf('<b style="color:#b7791f">國定假日清單可能漏了日子</b>：<span style="color:#b7791f">班表有同仁排了「國定假日假」，但「2 參數設定」的國定假日雙薪日沒有這幾天：12/24（2 人：測試乙、測試丙）、12/31（6 人：甲、乙、丙、丁、戊 等）。影響有兩種：①那天有上班的同仁，不會算國定假日加給。②排了這天國定假日假的正職，系統會當成他把國定假日調到這天休，他本人在同一期（28 天）其他國定假日上班時就不再加給。請先核對雙薪日：清單漏了，請找資訊部同步後再重新計算；如果同仁本來就是把國定假日調到這天休，照現況即可。這個提醒不會擋鎖定。</span>') > 0, true, '整句逐字＝2026-11-23 主管同意修正後的長版');
  eq([html.indexOf('己') < 0, html.indexOf('color:#b7791f') > 0, html.indexOf('不能鎖定') < 0], [true, true, true], '黃字、只提醒（沒有「不能鎖定」）');
  eq(render([{ date: '2026-12-24', n: 1, names: ['<b>x</b>'] }]).indexOf('&lt;b&gt;x&lt;/b&gt;') > 0, true, '姓名經過 esc()');
}

console.log(`\n結果：${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
