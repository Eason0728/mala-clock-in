/* 選舉假逐人名單（payroll_hol_emp，Eason 2026-11-22 定案）
 * 規則：名單上的同仁、選舉日班表是上班日 W → 那天照國定假日算，項目名稱「選舉日出勤」；
 *   班表 H／R／L／查不到 → 不套用（照原本算）；同一天已經是國定假日 → 以國定假日為準、只算一次；
 *   補休照國定假日（選舉日的加班不能抵補休；已抵掉的會讓補休帳變負、擋鎖定，名單存檔時提醒人數，Eason 2026-11-22 00:40）；已鎖定月份不能改名單。
 * 整條鏈：Code.gs＋Payroll.gs＋SchedPub.gs 真函式（payCollect→payDailyFor_→payCalcOne→payOtFormCheck_→Finalize），假資料。
 * 假人：正職 本薪 34000＋伙食 2000＝月工資 36000 → 加班時薪 150；計時 時薪 200（到職未滿半年，沒有年資加給）。
 * 期望值全部手算，寫在每條旁邊。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const C = rd('Code.gs'), SP = rd('SchedPub.gs'), GS_NOW = rd('Payroll.gs');
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

const DAYS = (n) => Array.from({ length: n }, (_, i) => '2026-11-' + ('0' + (i + 1)).slice(-2));
const W = { t: 'W', s: 'A' }, H = { t: 'H' }, Hs = { t: 'H', s: 'A' }, R = { t: 'R' }, Rs = { t: 'R', s: 'A' }, LT = { t: 'L', l: '特' };
const E = '2026-11-28';
/* [代號, 說明, 正職?, 11/28 格子, 11/28 核定時數, 11/28 已核准加班單時數, 其他：{cells:{日期:格子}, hours:{日期:時數}, ot:{日期:時數}, comp:{日期:時數}}] */
const PEOPLE = [
  ['a', '正職 W 8h', true, W, 8, 0],
  ['b', '正職 W 10h（單 2h）', true, W, 10, 2],
  ['c', '正職 W 4h', true, W, 4, 0],
  ['d', '正職 W 沒出勤', true, W, 0, 0],
  ['e', '正職 H 8h（單 8h）', true, Hs, 8, 8],
  ['f', '正職 R 8h（單 8h）', true, Rs, 8, 8],
  ['g', '計時 W 8h', false, W, 8, 0],
  ['h', '計時 H 6h（單 6h）', false, Hs, 6, 6],
  ['i', '計時 W 沒出勤', false, W, 0, 0],
  ['j', '正職 L特 沒出勤', true, LT, 0, 0],
  ['k', '正職 查不到班表 8h', true, null, 8, 0],
  ['l', '正職 W 10h（單 2h）＋11/20 補休 2h', true, W, 10, 2, { comp: { '2026-11-20': 2 } }],
  ['m', '計時 W 10h（單 2h）', false, W, 10, 2],
];
const NAMES = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥'.split('');

/* 一個世界：opt.elec＝勾選的代號（undefined＝沒有名單分頁）；opt.hol＝payroll_holiday 11 月 dates；opt.extra＝額外的人；opt.gs＝要載入的 Payroll.gs 原始碼 */
function world(opt) {
  opt = opt || {};
  const people = (opt.only ? PEOPLE.filter((p) => opt.only.includes(p[0])) : PEOPLE).concat(opt.extra || []);
  const rows = [], master = [], approved = [], requests = [], leave = [];
  people.forEach(([id, label, ft, cell, h, ot, more], i) => {
    more = more || {};
    const emp = 'E' + (i + 1), name = NAMES[i] + '君';
    rows.push({ emp_id: emp, name, cells: DAYS(28).map((d) => d === E ? (cell || null) : ((more.cells || {})[d] || H)) });
    master.push({ emp_id: emp, name, store: 'SSLGF', is_full_time: ft ? 'true' : 'false', base: ft ? 34000 : 0, skill_allow: 0, night_allow: 0, mgr_allow: 0,
      editor_allow: 0, attend_cap: 0, ot_rate: 0, wage: ft ? 0 : 200, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
      hire_date: ft ? '2020-01-01' : '2026-10-01', leave_date: '', meal_allow: 0, active: 'true' });
    const hrs = Object.assign({}, more.hours || {}); if (h > 0) hrs[E] = h;
    Object.keys(hrs).forEach((d) => approved.push({ date: d, emp_id: emp, name, approved_hours: hrs[d],
      periods: hrs[d] >= 10 ? '10:00-21:00' : hrs[d] >= 8 ? '10:00-19:00' : hrs[d] >= 6 ? '10:00-16:00' : '10:00-14:00',
      status_text: '正常', entered_at: d + 'T22:00:00+08:00', manager_name: '主管' }));
    const ots = Object.assign({}, more.ot || {}); if (ot > 0) ots[E] = ot;
    Object.keys(ots).forEach((d, j) => requests.push({ id: 'R' + i + j, kind: 'ot', status: 'approved', date: d, name, emp_id: emp, hours: ots[d], created_at: d + 'T08:00:00+08:00' }));
    Object.keys(more.comp || {}).forEach((d) => {
      leave.push({ '日期': d, '姓名': name, '假別': '補休', '時數': more.comp[d] });
      requests.push({ id: 'C' + i, kind: 'leave', leave_type: '補休', status: 'approved', date: d, name, emp_id: emp, hours: more.comp[d], created_at: d + 'T08:00:00+08:00' });
    });
  });
  if (opt.patch) opt.patch(master);
  const PUB = {
    '|T01': { start: '2026-11-01', shifts: [{ id: 'A', name: 'A班', start: '10:00', end: '19:00', break_min: 60 }], rows },
    '|T02': { start: '2026-11-29', shifts: [], rows: rows.map((r) => ({ emp_id: r.emp_id, name: r.name, cells: Array(28).fill(H) })) },
  };
  const DB = { master, run: [], item: [], config: [], leave_type: [], bonus: [], input: [], xmap: [], audit: [],
    holiday: [{ ym: '2026-11', store: '', red_days: 9, dates: opt.hol || '' }],
    store: [{ code: 'SSLGF', name: '測試店', clock_ss_id: '', active: true, support_group: 'sxl' }] };
  const hasSheet = opt.elec !== undefined;
  if (hasSheet) DB.hol_emp = (opt.elec || []).map((id) => { const i = people.findIndex((p) => p[0] === id); return { ym: '2026-11', date: opt.elecDate || E, store: 'SSLGF', emp_id: 'E' + (i + 1), name: NAMES[i] + '君', note: '', updated_at: '' }; });
  const CLOCK = { roster: master.map((m) => ({ emp_id: m.emp_id, name: m.name, active: true })), approved, events: [], leave, requests };
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => ({ getSheetByName: (n) => (n === 'payroll_hol_emp' && !hasSheet ? null : {}) }) },
    Utilities: { formatDate: () => '2026-11-30' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + (opt.gs || GS_NOW) + '\n' + SP, sb);
  sb.__C = CLOCK; sb.__DB = DB; sb.__PUB = PUB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return JSON.parse(JSON.stringify(globalThis.__C[sheet] || [])); };
    payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(JSON.parse(JSON.stringify(rows))); };
    payInvalidate = function(){}; pnlSnapshotRemove_ = function(){};
    payHasClock = function(){ return true; }; payEmpStoresMap = function(){ return {}; };
    checkAdmin = function(){ return true; }; spreadsheetId = function(){ return 'X'; };
    todayTaipeiStr = function(){ return globalThis.__TODAY || '2026-12-01'; };
    schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(globalThis.__PUB)); };
  `, sb);
  const F = (n) => vm.runInContext(n, sb);
  return { sb, F, DB, people, calc: () => {
    const res = F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
    if (!res.ok) throw new Error('calc ' + JSON.stringify(res).slice(0, 300));
    const by = {};
    res.results.forEach((r) => { by[people[master.findIndex((m) => m.emp_id === r.emp_id)][0]] = r; });
    return { res, by };
  } };
}
const items = (r) => [].concat(r.earn.map((x) => '+' + x.item_label + ' ' + x.qty + '=' + x.amount), r.ded.map((x) => '-' + x.item_label + '=' + x.amount));
const strip = (res) => JSON.parse(JSON.stringify(res.results));

/* 基準＝main 上 #178 合併後的版本（45ccbec）。找不到就算失敗，不跳過（Codex T：跳過會假綠燈）。 */
const BASE_REF = '45ccbec';
console.log('══ a) 沒有名單：跟改版前（main ' + BASE_REF + '）逐欄相同 ══');
{
  let before = null;
  try { before = execFileSync('git', ['show', BASE_REF + ':apps-script/Payroll.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { before = null; }
  chk('  找得到基準 ' + BASE_REF + ' 的 Payroll.gs', !!before, true);
  if (before) {
    for (const [lab, o] of [['沒有分頁', {}], ['分頁空白', { elec: [] }], ['另有國定假日 11/10', { hol: '2026-11-10' }]]) {
      const A = world(Object.assign({}, o, { gs: before })).calc().res, B = world(o).calc().res;
      chk('  ' + lab + '：results 逐欄相同（' + A.results.length + ' 人）', JSON.stringify(strip(B)) === JSON.stringify(strip(A)), true);
      const wa = world(Object.assign({}, o, { gs: before })), wb = world(o); wa.calc(); wb.calc();
      chk('  ' + lab + '：寫進 run／item 的列相同', JSON.stringify([wb.DB.run, wb.DB.item]) === JSON.stringify([wa.DB.run, wa.DB.item]), true);
    }
    const mA = world({ gs: before }).F('handlePayrollMasterGet')({ store: 'SSLGF' }), mB = world({}).F('handlePayrollMasterGet')({ store: 'SSLGF' });
    chk('  payroll_master_get 回應形狀不變（沒有名單不多 hol_emp）', JSON.stringify(Object.keys(mB)), JSON.stringify(Object.keys(mA)));
    const pm = (gs, o2) => { const w = world(Object.assign({ gs }, o2 || {})); w.calc(); return JSON.parse(JSON.stringify(w.F('handlePayrollMonth')({ ym: '2026-11', store: 'SSLGF' }))); };
    const pA = pm(before), pB = pm(undefined);
    chk('  payroll_month 回應（JSON）逐字相同', JSON.stringify(pB) === JSON.stringify(pA), true);
    chk('  payroll_month 有名單時多 hol_emp', pm(undefined, { elec: ['a'] }).hol_emp, [{ ym: '2026-11', date: E, emp_id: 'E1', note: '' }]);
    const raw = (o2) => { const w = world(o2 || {}); w.calc(); return w.F('handlePayrollMonth')({ ym: '2026-11', store: 'SSLGF' }); };
    chk('  payroll_month 沒有名單：連值為 undefined 的 hol_emp 屬性都沒有（Codex B5c）', Object.prototype.hasOwnProperty.call(raw({}), 'hol_emp'), false);
    const other = world({ elec: ['a'] }); other.DB.hol_emp.forEach((r) => { r.ym = '2026-12'; r.date = '2026-12-05'; }); other.calc();
    chk('  只有別月名單：11 月 payroll_month 不帶 hol_emp（Codex B5b）', Object.prototype.hasOwnProperty.call(other.F('handlePayrollMonth')({ ym: '2026-11', store: 'SSLGF' }), 'hol_emp'), false);
    const mL = world({ elec: ['a'] }).F('handlePayrollMasterGet')({ store: 'SSLGF' });
    chk('  payroll_master_get 有名單也不帶 hol_emp（名單只隨 payroll_month）', JSON.stringify(Object.keys(mL)), JSON.stringify(Object.keys(mA)));
  }
  const w0 = world({}); w0.calc();
  chk('  沒有分頁時計算不會建分頁（DB 沒有 hol_emp）', 'hol_emp' in w0.DB, false);
}

console.log('\n══ b) 全部勾選 vs 沒有名單：逐人差額 ══');
const ALL = PEOPLE.map((p) => p[0]);
const N0 = world({}).calc().by, N1 = world({ elec: ALL }).calc().by;
const diff = (id) => N1[id].gross - N0[id].gross;
PEOPLE.forEach(([id, lab]) => console.log(`   ${id} ${lab}\n     前 ${N0[id].gross} [${items(N0[id]).join('｜')}]\n     後 ${N1[id].gross} [${items(N1[id]).join('｜')}]  差 ${diff(id)}`));
chk('a 正職 W 8h：+ 選舉日出勤 8H × 150 ＝ 1200', [diff('a'), N1.a.earn.filter((x) => x.item_label === '選舉日出勤').map((x) => [x.item_key, x.qty, x.rate, x.amount])], [1200, [['ot_hol', 8, 150, 1200]]]);
chk('b 正職 W 10h：+1200（平日加班 2H×1.34 照給 402）', [diff('b'), (N1.b.earn.find((x) => x.item_key === 'ot_w43') || {}).amount], [1200, 402]);
chk('c 正職 W 4h：+ 4H × 150 ＝ 600', diff('c'), 600);
chk('d 正職 W 沒出勤：0（月薪照給）', diff('d'), 0);
chk('e 正職 H 8h：0（照休息日 1905）', [diff('e'), (N1.e.earn.find((x) => x.item_key === 'ot_rest') || {}).amount], [0, 1905]);
chk('f 正職 R 8h：0（照例假加發一日 1200）', [diff('f'), (N1.f.earn.find((x) => x.item_key === 'ot_rdo') || {}).amount], [0, 1200]);
chk('g 計時 W 8h：+ 8H × 200 ＝ 1600（項目 holiday_double、名稱選舉日出勤）', [diff('g'), N1.g.earn.filter((x) => x.item_label === '選舉日出勤').map((x) => [x.item_key, x.qty, x.rate, x.amount])], [1600, [['holiday_double', 8, 200, 1600]]]);
chk('h 計時 H 6h：0（照休息日加成 672）', [diff('h'), (N1.h.earn.find((x) => x.item_key === 'ot_rest') || {}).amount], [0, 672]);
chk('i 計時 W 沒出勤：0（不給）', diff('i'), 0);
chk('j 正職 班表 L特：不套用 0', diff('j'), 0);
chk('k 正職 查不到班表：不套用 0', diff('k'), 0);
chk('m 計時 W 10h：+10H × 200 ＝ 2000（當天時數全部再一倍，超過 8H 的加成照舊）', diff('m'), 2000);
chk('沒有任何人變少', PEOPLE.every(([id]) => diff(id) >= 0), true);
chk('沒有任何負的薪資項目（勾選後所有人的加項、扣項金額都 ≥ 0）', PEOPLE.every(([id]) => N1[id].earn.concat(N1[id].ded).every((x) => x.amount >= 0)), true);
chk('ot_info.elec 只出現在有算到的人', PEOPLE.filter(([id]) => N1[id].ot_info && N1[id].ot_info.elec).map(([id]) => id), ['a', 'b', 'c', 'g', 'l', 'm']);
chk('W 沒出勤也不再列「排班沒來」（同國定假日）', [N0.d.ot_info.no_show.includes(E), N1.d.ot_info.no_show.includes(E)], [true, false]);

console.log('\n══ b2) 一半勾選：沒勾選的人跟沒有名單時完全一樣 ══');
{
  const half = ['a', 'c', 'e', 'g'];
  const H1 = world({ elec: half }).calc().by;
  PEOPLE.forEach(([id]) => { if (!half.includes(id)) chk('  沒勾選 ' + id + ' 逐欄相同', JSON.stringify(H1[id]) === JSON.stringify(N0[id]), true); });
  chk('  勾選的 a、c、g 照加，e（H）不變', [H1.a.gross - N0.a.gross, H1.c.gross - N0.c.gross, H1.g.gross - N0.g.gross, H1.e.gross - N0.e.gross], [1200, 600, 1600, 0]);
}

console.log('\n══ c) 與國定假日並存 ══');
{
  // 11/10 是國定假日（payroll_holiday），另多一位 11/10 上班 8H 的正職、一位計時
  const extra = [['x1', '正職 11/10 國定假日 W 8h＋11/28 W 8h', true, W, 8, 0, { cells: { '2026-11-10': W }, hours: { '2026-11-10': 8 } }],
                 ['x2', '計時 11/10 W 8h＋11/28 W 8h', false, W, 8, 0, { cells: { '2026-11-10': W }, hours: { '2026-11-10': 8 } }]];
  const A = world({ hol: '2026-11-10', extra }).calc().by, B = world({ hol: '2026-11-10', extra, elec: ['x1', 'x2'] }).calc().by;
  const lab = (r) => r.earn.filter((x) => x.item_key === 'ot_hol' || x.item_key === 'holiday_double').map((x) => x.item_label + ' ' + x.qty + '=' + x.amount);
  chk('  正職：國定假日 8H 1200 一列、選舉日 8H 1200 一列，各算各的', lab(B.x1), ['國定假日出勤（加發時數） 8=1200', '選舉日出勤 8=1200']);
  chk('  正職：勾選前只有國定假日那列；差額 1200', [lab(A.x1), B.x1.gross - A.x1.gross], [['國定假日出勤（加發時數） 8=1200'], 1200]);
  chk('  計時：國定假日加倍 8H 1600、選舉日出勤 8H 1600', lab(B.x2), ['國定假日加倍 8=1600', '選舉日出勤 8=1600']);
  // 同一天：11/28 本身就在 payroll_holiday，又被勾選 → 只算一次、名稱照國定假日
  const S0 = world({ hol: E }).calc().by, S1 = world({ hol: E, elec: ALL }).calc().by;
  chk('  同一天既是國定假日又勾選：每個人都跟只有國定假日時相同', PEOPLE.every(([id]) => JSON.stringify(S1[id]) === JSON.stringify(S0[id])), true);
  chk('  名稱照國定假日（a）', lab(S1.a), ['國定假日出勤（加發時數） 8=1200']);
}

console.log('\n══ d) 補休：選舉日的加班照國定假日不能抵補休（Eason 2026-11-22 00:40）══');
{
  // l：11/28 W 10h、加班單 2h、11/20 補休 2h。
  //   沒勾選：平日 2H 被補休抵掉（不發），補休帳 2−2＝0，可以鎖定。
  //   勾選：那天照國定假日，2H 加班不能抵 → 平日加班 2H×1.34＝402 照發＋選舉日出勤 1200；補休 2H 抵不掉；補休帳 0−2＝−2 → 擋鎖定
  chk('  沒勾選：補休抵 2H、抵不掉 0、沒有平日加班列', [N0.l.ot_info.comp_h, N0.l.ot_info.comp_over_h, !!N0.l.earn.find((x) => x.item_key === 'ot_w43')], [2, 0, false]);
  chk('  勾選：補休抵 0、抵不掉 2H、平日加班 402 照發、差額 +1602', [N1.l.ot_info.comp_h, N1.l.ot_info.comp_over_h, (N1.l.earn.find((x) => x.item_key === 'ot_w43') || {}).amount, N1.l.gross - N0.l.gross], [0, 2, 402, 1602]);
  const w0 = world({ elec: [], only: ['l'] }); w0.calc();   // 只放 l（k 查不到班表會擋鎖定）
  chk('  沒勾選：補休帳沒有負數、可以鎖定', [w0.F('payCompNegatives')('2026-11', 'SSLGF').length, w0.F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true }).ok], [0, true]);
  const wl = world({ elec: ['l'], only: ['l'] }); wl.calc();
  chk('  勾選：補休帳 加班 0 − 補休 2 ＝ −2', wl.F('payCompNegatives')('2026-11', 'SSLGF').map((x) => [x.ot_h, x.used_h, x.balance_h]), [[0, 2, -2]]);
  const lk = wl.F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
  chk('  勾選：鎖定被擋 comp_negative（沿用現行訊息）', [lk.ok, lk.error, lk.message], [false, 'comp_negative', '補休帳是負的，不能鎖定（請補核准加班申請，或把多請的補休改成其他假別）：\n甲君：加班 0 − 補休 2 ＝ -2 小時']);
  const wh = world({ hol: E, only: ['l'] }); wh.calc();
  chk('  跟 11/28 是真國定假日時一樣（補休帳、補休抵、實付）', [wh.F('payCompNegatives')('2026-11', 'SSLGF').map((x) => x.balance_h), wh.calc().by.l.ot_info.comp_over_h], [[-2], 2]);
  // 期間補休帳（班表截止前提醒）同一套
  const pb = (w) => w.F('payCompPeriodBook')('2026-11-01', '2026-11-28').forEmp(w.DB.master[0], 'SSLGF');
  chk('  期間補休帳：沒勾選 加班 2、勾選 加班 0', [pb(w0).ot_h, pb(wl).ot_h], [2, 0]);
  // 名單存檔當下提醒（只回人數）
  const ws = world({ elec: [], only: ['l', 'a'] });
  const r1 = ws.F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E, emp_ids: ['E1', 'E2'] });
  chk('  存檔成功＋提醒 1 人（l 的加班已抵補休；a 沒有）', [r1.ok, r1.warn_comp_negative, r1.warn_message],
    [true, 1, '已儲存。其中 1 人選舉日的加班先前已拿去抵補休；選舉假那天的加班不能抵補休，這 1 人的補休帳會變成負的，本月會鎖不了。請把多請的補休改成其他假別，或補核准加班申請。']);
  // 勾選前補休帳就是負的、勾選後更負（−2 → −4）也要算進提醒人數
  const deeper = [['y1', '正職 W 10h（單 2h）＋補休 4h', true, W, 10, 2, { comp: { '2026-11-20': 4 } }],
                  ['y2', '正職 W 8h＋補休 2h（本來就 −2，勾選後不變）', true, W, 8, 0, { comp: { '2026-11-19': 2 } }]];
  const wd = world({ elec: [], only: [], extra: deeper });
  chk('  勾選前：y1 −2、y2 −2', wd.F('payCompNegatives')('2026-11', 'SSLGF').map((x) => x.balance_h), [-2, -2]);
  const rd = wd.F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E, emp_ids: ['E1', 'E2'] });
  chk('  勾選 y1、y2：只有變得更負的 y1 算進提醒（1 人）', [rd.ok, rd.warn_comp_negative, wd.F('payCompNegatives')('2026-11', 'SSLGF').map((x) => x.balance_h)], [true, 1, [-4, -2]]);
  // 補休抵不掉（comp_over）的鎖定訊息補上選舉日
  const co = [['z1', '正職 11/20 W 8h＋加班單 2h（沒有超過 8H）＋11/21 補休 2h', true, W, 0, 0, { cells: { '2026-11-20': W }, hours: { '2026-11-20': 8 }, ot: { '2026-11-20': 2 }, comp: { '2026-11-21': 2 } }]];
  const wc = world({ only: [], extra: co }); wc.calc();
  const lc = wc.F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
  chk('  comp_over 訊息：休息日第 3 小時起、例假、國定假日、選舉日的加班不能抵', [lc.error, /例假、國定假日、選舉日的加班不能抵/.test(lc.message || '')], ['comp_over', true]);
  const r2 = ws.F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E, emp_ids: ['E2'] });
  chk('  只勾沒問題的人：沒有提醒欄位', [r2.ok, 'warn_comp_negative' in r2, 'warn_message' in r2], [true, false, false]);
  // 存名單提醒：當月離職（主檔已停用）的正職也算；班表日別查不到 → 回「沒檢查成」而不是零人（Codex S2）
  const wq = world({ elec: [], only: ['l'], patch: (m) => { m[0].active = 'false'; m[0].leave_date = '2026-11-29'; } });
  const rq = wq.F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E, emp_ids: ['E1'] });
  chk('  當月離職的正職也算進提醒', [rq.ok, rq.warn_comp_negative], [true, 1]);
  const wf = world({ elec: [], only: ['l'] });
  wf.F('(function(){ paySchedMonth_ = function(){ throw new Error("讀不到班表"); }; })')();
  const rf = wf.F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E, emp_ids: ['E1'] });
  chk('  補休檢查失敗 → 存檔成功、warn_check_failed＋訊息', [rf.ok, rf.warn_check_failed, rf.warn_comp_negative, rf.warn_message],
    [true, true, undefined, '已儲存，但這次沒能檢查補休帳（讀取失敗）。請到「6 薪資計算」重新計算看提醒；鎖定時會再檢查一次。']);
  // 期間補休帳跨月：11/28 選舉日加班 2H（勾選＝不算）＋12/05 休息日加班 2H（照算）
  const cross = (el) => { const w = world({ elec: el, only: ['l'], patch: () => {} });
    w.DB.hol_emp = (el || []).length ? [{ ym: '2026-11', date: E, store: 'SSLGF', emp_id: 'E1' }] : [];
    w.sb.__C.requests.push({ id: 'X1', kind: 'ot', status: 'approved', date: '2026-12-05', name: '甲君', emp_id: 'E1', hours: 2 });
    return w.F('payCompPeriodBook')('2026-11-15', '2026-12-12').forEmp(w.DB.master[0], 'SSLGF').ot_h; };
  chk('  期間補休帳跨 11／12 月：沒勾選 4H、勾選 2H', [cross([]), cross(['l'])], [4, 2]);
  // 28 天加班同步的休息日旗標：試算回應帶 _elec（只有套用的人），payOtMonthSync_ 當國定假日
  const dr = (o) => { const w = world(o); return w.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', dry_run: true, full_month: true }); };
  chk('  試算回應：沒有名單不帶 _elec；有名單只列套用的人（a、g，不含 e 休息日）', ['_elec' in dr({}), dr({ elec: ['a', 'e', 'g'] })._elec], [false, { E1: [E], E7: [E] }]);
}

console.log('\n══ e) 名單存檔：權限、鎖定、檢查 ══');
{
  const w = world({ elec: [] });
  const S = (b) => w.F('handlePayrollHolEmpSet')(Object.assign({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', date: E }, b));
  chk('  存 2 人', [S({ emp_ids: ['E1', 'E7'] }).ok, w.DB.hol_emp.map((r) => [r.ym, r.date, r.store, r.emp_id])], [true, [['2026-11', E, 'SSLGF', 'E1'], ['2026-11', E, 'SSLGF', 'E7']]]);
  chk('  再存＝整份取代該店該月（不累加）', [S({ emp_ids: ['E3'] }).count, w.DB.hol_emp.map((r) => r.emp_id)], [1, ['E3']]);
  chk('  操作紀錄只記人數不記姓名', w.DB.audit.slice(-1)[0].reason, 'SSLGF 選舉假名單 2026-11-28 共 1 人');
  chk('  別店的列不動', (() => { w.DB.hol_emp.push({ ym: '2026-11', date: E, store: 'CF', emp_id: 'Z1' }); S({ emp_ids: ['E1'] }); return w.DB.hol_emp.map((r) => r.store + r.emp_id); })(), ['CF' + 'Z1', 'SSLGF' + 'E1']);
  chk('  空陣列＝清除本店該月', [S({ emp_ids: [], date: '' }).ok, w.DB.hol_emp.filter((r) => r.store === 'SSLGF').length], [true, 0]);
  chk('  不在本店主檔的編號 → 不存', [S({ emp_ids: ['E1', 'NOPE'] }).error, S({ emp_ids: ['E1', 'NOPE'] }).emp_ids], ['not_in_master', ['NOPE']]);
  chk('  日期不在該月 → 不存', S({ emp_ids: ['E1'], date: '2026-12-01' }).error, 'bad_date');
  chk('  日期不存在 → 不存', S({ emp_ids: ['E1'], date: '2026-11-31' }).error, 'bad_date');
  chk('  月份格式錯 → 不存', S({ emp_ids: ['E1'], ym: '2026/11' }).error, 'bad_ym');
  chk('  編號帶怪字 → 不存', S({ emp_ids: ['E1"><b>'] }).error, 'bad_emp_id');
  w.DB.run.push({ ym: '2026-11', store: 'SSLGF', emp_id: 'E1', status: 'final' });
  chk('  已鎖定月份 → 不能改', [S({ emp_ids: ['E1'] }).error, w.DB.hol_emp.filter((r) => r.store === 'SSLGF').length], ['locked', 0]);
  chk('  沒有管理金鑰 → unauthorized', (() => { w.F('(function(){ checkAdmin = function(){ return false; }; })')(); return S({ emp_ids: ['E1'] }).error; })(), 'unauthorized');
  // 門市範圍（管理系統代轉帶 scope）：名單上的編號要在負責門市主檔
  const w2 = world({ elec: [] });
  w2.DB.master.push({ emp_id: 'C9', name: '別店人', store: 'CF', is_full_time: 'true' });
  const g = w2.F('payScopeGuard_');
  chk('  scope 只有 SSLGF：本店編號放行', g('payroll_hol_emp_set', { scope: ['SSLGF'], store: 'SSLGF', emp_ids: ['E1'] }), null);
  chk('  scope 只有 SSLGF：混進別店編號 → emp_out_of_scope', g('payroll_hol_emp_set', { scope: ['SSLGF'], store: 'SSLGF', emp_ids: ['E1', 'C9'] }).detail, 'emp_out_of_scope');
  chk('  scope 只有 SSLGF：改別店名單 → 擋', g('payroll_hol_emp_set', { scope: ['SSLGF'], store: 'CF', emp_ids: [] }).error, 'scope_forbidden');
  chk('  有掛進 PAYROLL_HANDLERS', typeof w2.F('PAYROLL_HANDLERS').payroll_hol_emp_set, 'function');
  // 空 scope（Codex B4：查證不成立，guard 先回空殼；留作回歸測試）
  const ws = world({ elec: ['a'] }), HH = ws.F('PAYROLL_HANDLERS');
  chk('  scope:[] 讀 payroll_master_get → 空殼、沒有名單', HH.payroll_master_get({ admin_key: 'x', scope: [], store: 'SSLGF' }), { ok: true, stores: [], master: [], config: {}, scope: [] });
  chk('  scope:[] 讀 payroll_month → scope_forbidden', HH.payroll_month({ admin_key: 'x', scope: [], store: 'SSLGF', ym: '2026-11' }).error, 'scope_forbidden');
  chk('  2026-10 以前不能存名單（Codex S1）', world({ elec: [] }).F('handlePayrollHolEmpSet')({ admin_key: 'x', store: 'SSLGF', ym: '2026-10', date: '2026-10-28', emp_ids: ['E1'] }).error, 'elec_not_open');
}

console.log('\n══ e2) 名單與鎖定／重算交錯（Codex B1）══');
{
  // 鎖定：草稿比對跑完、拿寫鎖之前，另一個請求存了名單 → 不鎖，回 stale_run
  const w = world({ elec: [], only: ['a'] }); w.calc();
  w.F('(function(){ var o = payLockStale_; payLockStale_ = function(b, ym, st){ var r = o(b, ym, st); handlePayrollHolEmpSet({ admin_key: "x", store: "SSLGF", ym: "2026-11", date: "2026-11-28", emp_ids: ["E1"] }); return r; }; })')();
  const lk = w.F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
  chk('  鎖定中途名單被改 → stale_run、沒鎖', [lk.ok, lk.error, w.DB.run.map((r) => r.status)], [false, 'stale_run', ['draft']]);
  chk('  訊息', lk.message, '試算後選舉假名單有改過，不能直接鎖定。請重新計算、確認新數字後再鎖定。');
  w.F('(function(){ payLockStale_ = function(){ return { list: [] }; }; })')();
  w.calc();
  const lk2 = w.F('handlePayrollFinalize')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', lock: true });
  chk('  重算後再鎖 → 成功，草稿含選舉日出勤', [lk2.ok, w.DB.run[0].status, w.DB.run[0].gross], [true, 'final', 35200]);
  // 重算：讀完名單、寫回之前名單被改 → 不寫草稿
  const w2 = world({ elec: [], only: ['a'] }); w2.calc();
  const g0 = w2.DB.run[0].gross;
  w2.F('(function(){ var o = payZeroRatioRows_; payZeroRatioRows_ = function(){ handlePayrollHolEmpSet({ admin_key: "x", store: "SSLGF", ym: "2026-11", date: "2026-11-28", emp_ids: ["E1"] }); return o.apply(null, arguments); }; })')();
  const rc = w2.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  chk('  重算中途名單被改 → hol_emp_changed、草稿沒被舊名單蓋掉', [rc.ok, rc.error, w2.DB.run[0].gross === g0], [false, 'hol_emp_changed', true]);
}

console.log('\n══ e3) 計時：跨店支援兩種加倍共用採計時數、手填國定假日時數（Codex B2、B3）══');
{
  const w = world({ only: [] });
  w.F('(function(){ paySupportCode_ = function(x){ return x.code; }; })')();
  const f = w.F('paySupportElecDouble_'), fh = w.F('paySupportHolDouble_');
  const entry = { stores: [{ code: 'MZTLZL', name: '六張犁', days: [{ date: '2026-11-10', hours: 8 }, { date: E, hours: 8 }] }] };
  const sup = (h) => [{ store: '六張犁', code: 'MZTLZL', hours: h, rate: 200 }];
  chk('  支援列只採計 8H：國定假日加倍 8H、選舉日 0H（合計不超過 8H）', [fh(sup(8), entry, ['2026-11-10'], {}).map((x) => x.hours), f(sup(8), entry, ['2026-11-10'], [E], {}).map((x) => x.hours)], [[8], []]);
  chk('  採計 12H：國定假日 8H、選舉日 4H', f(sup(12), entry, ['2026-11-10'], [E], {}).map((x) => x.hours), [4]);
  chk('  採計 16H：國定假日 8H、選舉日 8H', f(sup(16), entry, ['2026-11-10'], [E], {}).map((x) => [x.hours, x.rate]), [[8, 200]]);
  chk('  當月沒有國定假日：選舉日 min(8, 採計)', f(sup(5), entry, [], [E], {}).map((x) => x.hours), [5]);
  chk('  until 之後的日子不算', f(sup(16), entry, [], [E], {}, '2026-11-27'), []);
  // 本店：手填國定假日時數跟打卡不同 → 不自動加發、提醒區列出
  const extra = [['p', '計時 W 8h＋11/20 W 8h', false, W, 8, 0, { cells: { '2026-11-20': W }, hours: { '2026-11-20': 8 } }]];
  const wp = world({ only: [], extra, elec: ['p'] });
  const calcP = (inputs) => wp.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF', inputs }).results[0];
  const lab = (r) => r.earn.filter((x) => x.item_key === 'holiday_double').map((x) => x.item_label + ' ' + x.qty + '=' + x.amount);
  const r0 = calcP({});
  chk('  沒手改：選舉日出勤 8H、沒有提醒', [lab(r0), r0.ot_info.elec_warn], [['選舉日出勤 8=1600'], undefined]);
  const r1 = calcP({ E1: { hours: 16, holiday_h: 8 } });
  chk('  手填國定假日 8H（打卡 0H）：不加發選舉日、提醒 hol_manual', [lab(r1), r1.ot_info.elec_warn], [['國定假日加倍 8=1600'], { want: 8, paid: 0, reason: 'hol_manual' }]);
  const r2 = calcP({ E1: { hours: 4, holiday_h: 0 } });
  chk('  月總時數手調成 4H：選舉日只加發 4H、提醒 cap', [lab(r2), r2.ot_info.elec_warn], [['選舉日出勤 4=800'], { want: 8, paid: 4, reason: 'cap' }]);
}


console.log('\n══ f) 損益月中估算（handlePnlLaborEstimate_）同一套 ══');
{
  const est = (o) => { const w = world(o); w.sb.__TODAY = '2026-11-29';
    w.F('(function(){ checkPnlKey_ = function(){ return ""; }; })')();
    return w.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2026-11', store: 'SSLGF' }); };
  const A = est({}), B = est({ elec: [] }), C2 = est({ elec: ['a', 'g'] });
  chk('  沒有名單／空白分頁：估算相同', JSON.stringify(B) === JSON.stringify(A), true);
  const tot = (r) => JSON.stringify(r).length;
  chk('  勾選 a、g：估算有變（應發多 1200＋1600）', [A.ok, C2.ok, tot(C2) !== tot(A) || JSON.stringify(C2) !== JSON.stringify(A)], [true, true, true]);
  const g = (r, k) => payNumOf(r, k);
  function payNumOf(r, k) { return r && r[k] != null ? r[k] : (r && r.totals && r.totals[k] != null ? r.totals[k] : null); }
  const gA = g(A, 'gross') ?? g(A, 'total'), gC = g(C2, 'gross') ?? g(C2, 'total');
  if (gA != null && gC != null) chk('  應發差 2800', gC - gA, 2800);
}

console.log('\n══ g) 純函式 ══');
{
  const w = world({});
  const D = w.F('payElecDates_'), A = w.F('payElecApply_');
  const rows = [{ ym: '2026-11', date: E, store: 'SSLGF', emp_id: 'E1' }, { ym: '2026-11', date: E, store: 'CF', emp_id: 'E1' }, { ym: '2026-12', date: '2026-12-05', store: 'SSLGF', emp_id: 'E1' },
                { ym: '2026-11', date: '2026-12-01', store: 'SSLGF', emp_id: 'E1' }];
  chk('  只取本店本月、日期在該月', D(rows, '2026-11', 'SSLGF', 'E1'), [E]);
  chk('  店別空白＝預設店（payStore）', D([{ ym: '2026-11', date: E, store: '', emp_id: 'E1' }], '2026-11', 'SSLGF', 'E1'), [E]);
  const VD = vm.runInContext('Date', w.sb);
  chk('  Sheets 轉成 Date 的日期也認得', D([{ ym: new VD(2026, 10, 1), date: new VD(2026, 10, 28), store: 'SSLGF', emp_id: 'E1' }], '2026-11', 'SSLGF', 'E1'), [E]);
  chk('  Date 一律照台北日期讀：台北 11/01 00:00（UTC 10/31 16:00）＝ 11/01（Codex S3）', D([{ ym: '2026-11', date: new VD(Date.UTC(2026, 9, 31, 16, 0, 0)), store: 'SSLGF', emp_id: 'E1' }], '2026-11', 'SSLGF', 'E1'), ['2026-11-01']);
  chk('  同店同月兩個日期：只認名單第一列的日期（Codex S3）', [D([{ ym: '2026-11', date: '2026-11-27', store: 'SSLGF', emp_id: 'E2' }, { ym: '2026-11', date: E, store: 'SSLGF', emp_id: 'E1' }], '2026-11', 'SSLGF', 'E1'),
    D([{ ym: '2026-11', date: '2026-11-27', store: 'SSLGF', emp_id: 'E2' }, { ym: '2026-11', date: E, store: 'SSLGF', emp_id: 'E1' }], '2026-11', 'SSLGF', 'E2')], [[], ['2026-11-27']]);
  chk('  生效月份：2026-10 不套用、2026-11 起套用（不跟 payroll_ot_preview 的強制旗標）', [w.F('payElecOn_')('2026-10'), w.F('payElecOn_')('2026-11'), (w.F('(function(){ PAY_OT_FORCE_ = true; return payElecOn_("2026-10"); })')())], [false, true, false]);
  chk('  W 才套用；H、R、L、查不到不套用；國定假日那天不套用', [A([E], { [E]: W }, []), A([E], { [E]: H }, []), A([E], { [E]: R }, []), A([E], { [E]: LT }, []), A([E], {}, []), A([E], { [E]: W }, [E])],
    [[E], [], [], [], [], []]);
}

console.log('\n══ h) 支援：班表是別店班別（例 MZTLZL.S1）、時數在別店打卡 ══');
{
  const w = world({});
  const SX = { t: 'W', s: 'MZTLZL.S1' };
  chk('  別店班別的格子日別仍是上班日 W', w.F('payOtKindOf')(SX, false), 'W');
  const e = { emp_id: 'HQ-12', name: '支援君', store: 'HQ', is_full_time: 'true', base: 34000, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 0,
    labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2020-01-01', leave_date: '' };
  const xEntry = { stores: [{ code: 'MZTLZL', name: '六張犁', days: [{ date: E, hours: 8, periods: '09:00-22:00' }] }] };
  const sched = {}; DAYS(30).forEach((d) => { sched[d] = H; }); sched[E] = SX;
  const on = w.F('payElecApply_')([E], sched, []);
  const att = (el) => ({ hours: 0, extra_ot: 0, deduct_days: 0, support: [{ store: '六張犁', code: 'MZTLZL', hours: 8, rate: 150 }], bonuses: [], annual: null, leave_usage: {},
    late_min: 0, early_min: 0, personal_h: 0, sick_h: 0, annual_h: 0, menstrual_h: 0, disaster_h: 0,
    daily: w.F('payDailyFor_')(e, '2026-11', { day_h: {}, day_leave: {} }, xEntry, sched, [], '2026-11-30', 8, el) });
  const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, late_div_days: 30, late_div_hours: 8 };
  const r0 = w.F('payCalcOne')(e, '2026-11', att([]), cfg, 9), r1 = w.F('payCalcOne')(e, '2026-11', att(on), cfg, 9);
  chk('  總部正職、別店班別、勾選、在六張犁出勤 8H：編制店（總部）薪資單多「選舉日出勤」8H × 150 ＝ 1200',
    [r1.gross - r0.gross, r1.earn.filter((x) => x.item_label === '選舉日出勤').map((x) => [x.item_key, x.qty, x.amount])], [1200, [['ot_hol', 8, 1200]]]);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
