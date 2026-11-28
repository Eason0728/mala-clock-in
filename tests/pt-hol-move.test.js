/* 計時同仁國定假日調移（2026-11-28 主管定案；班表端 mala-store-ops 同時開放計時排「國定假日假」L＋國）
 * 定案（照抄）：
 *  1. 計時在同一個 28 天週期有排 L國，原國定假日當天上班就當一般上班日、不給「國定假日加倍」——照正職 payHolMoved_ 的做法
 *     （先對掉排在當天的，剩下依日期先後抵本期其他國定假日）。
 *  2. 計時排 L國 那天維持 0 元，不新增任何給薪項目。
 *  5. 計時的國定假日一律認「節日當天」：逢週末時，計時要節日當天上班才雙倍，補假那天上班是一般日（例：10/10 週六、補假 10/09）。正職完全不變。
 *  6. 從 2026-12 月份薪資起（PAY_PT_HOL_MOVE_FROM）；之前的月份與改版前逐位元組相同；填錯值＝不開（放寬性規則）。
 *  手填國定假日時數：同期有排移假時，手填時數也不加倍（跟自動算的一致）。
 * 比對基準：固定 commit 4ae34b2（origin/main 2026-11-28，Payroll.gs sha1 前綴 b98c28591bfd＝光復 @334 服務中的 薪資.js）。
 *   產生方式：git show 4ae34b286f48d8c80d219ec9a9a6d9bf4ac427ea:apps-script/Payroll.gs（取不到或雜湊不對直接失敗，不靜悄悄跳過）。
 * 假人：計時時薪 200（到職未滿半年、沒勾全勤 → 沒有加給）；正職本薪 34000。全部虛構同仁。期望值手算寫在每條旁邊。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const C = rd('Code.gs'), SP = rd('SchedPub.gs'), GS_NOW = rd('Payroll.gs');
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + (ok ? '' : ': ' + JSON.stringify(got).slice(0, 900) + ' ← 應為 ' + JSON.stringify(want).slice(0, 900))); };
const J = (x) => JSON.parse(JSON.stringify(x));

const BASE_COMMIT = '4ae34b286f48d8c80d219ec9a9a6d9bf4ac427ea', BASE_SHA1 = 'b98c28591bfd';
let GS_BASE;
try { GS_BASE = cp.execFileSync('git', ['-C', ROOT, 'show', BASE_COMMIT + ':apps-script/Payroll.gs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { throw new Error('取不到比對基準 ' + BASE_COMMIT.slice(0, 7) + '（淺層複製？請 git fetch --unshallow；CI 要 fetch-depth: 0）：' + String(e.message).split('\n')[0]); }
{ const sha = crypto.createHash('sha1').update(GS_BASE).digest('hex');
  if (sha.slice(0, 12) !== BASE_SHA1) throw new Error('比對基準內容不對：sha1 ' + sha.slice(0, 12) + '，應為 ' + BASE_SHA1); }

/* ── 班表期別（2026-11-01＝T01 第 1 天，每期 28 天）── */
const T0 = Date.UTC(2026, 10, 1), DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const PER = Array.from({ length: 9 }, (_, i) => ({ p: 'T' + ('0' + (i + 1)).slice(-2), start: iso(T0 + i * 28 * DAY) }));   // T01 11/01 … T09 2027-06-19
const W = { t: 'W', s: 'A' }, GUO = { t: 'L', l: '國' }, H = { t: 'H' };
/* 正職雙薪日（＝payroll_holiday.dates，人事行政總處 115／116 年辦公日曆表經 payHolidayDoublePlan，逢週末＝補假日） */
const HOLROWS = () => [
  ['2026-09', 8, '2026-09-25, 2026-09-28'], ['2026-10', 10, '2026-10-09, 2026-10-26'], ['2026-11', 9, ''], ['2026-12', 9, '2026-12-25'],
  ['2027-01', 11, '2027-01-01'], ['2027-02', 13, '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10'], ['2027-03', 9, '2027-03-01'],
  ['2027-04', 11, '2027-04-05, 2027-04-06, 2027-04-30'], ['2027-05', 10, ''], ['2027-06', 9, '2027-06-09'],
].map(([ym, red, dates]) => ({ ym, red_days: red, note: '', dates, store: '' }));

/** people：[{id, ft, cells:{日期:格子}, hours:{日期:核定時數}}]；沒標的日子＝上班 W（只有標了時數的日子才有核定）。
 *  opt：gs（載入哪一版 Payroll.gs）、from（覆寫 PAY_PT_HOL_MOVE_FROM，undefined＝不動）、today、input（payroll_input 手動列）、sup（{日期:時數} 同品牌支援店核定）、store */
function world(people, opt) {
  opt = opt || {};
  const st = opt.store || 'SSLGF', code = opt.pub !== undefined ? opt.pub : (st === 'SSLGF' ? '' : st.toLowerCase());   // pub：班表發布在哪家（MZTHQ／SSLHQ 的班表在總部 hq 發布）
  const master = [], approved = [], rows = {};
  people.forEach((x, i) => {
    const name = '測試' + '甲乙丙丁戊己庚辛'[i];
    x.name = name;
    master.push({ emp_id: x.id, name, store: st, is_full_time: x.ft ? 'true' : 'false', base: x.ft ? 34000 : 0, skill_allow: 0, night_allow: 0, mgr_allow: 0,
      editor_allow: 0, attend_cap: 0, ot_rate: 0, wage: x.ft ? 0 : 200, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
      hire_date: x.hire || (x.ft ? '2020-01-01' : '2026-10-01'), leave_date: x.leave || '', meal_allow: 0, active: 'true' });
    Object.keys(x.hours || {}).forEach((d) => approved.push({ date: d, emp_id: x.id, name, approved_hours: x.hours[d],
      periods: '10:00-' + (10 + x.hours[d]) + ':00', status_text: '正常', entered_at: d + 'T22:00:00+08:00', manager_name: '主管' }));
  });
  PER.forEach(({ p, start }) => {
    rows[code + '|' + p] = { start, shifts: [{ id: 'A', name: 'A班', start: '10:00', end: '19:00', break_min: 60 }],
      rows: people.map((x) => ({ emp_id: x.id, name: x.name, cells: Array.from({ length: 28 }, (_, i) => (x.cells || {})[iso(Date.parse(start + 'T00:00:00Z') + i * DAY)] || W) })) };
  });
  const DB = { master, run: [], item: [], config: [], leave_type: [], bonus: [], input: J(opt.input || []), xmap: [], audit: [],
    holiday: opt.holiday || HOLROWS(), store: [{ code: st, name: '測試店', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }] };
  if (opt.elec) DB.hol_emp = opt.elec.map((x) => ({ ym: x.date.slice(0, 7), date: x.date, store: st, emp_id: x.id, name: '', note: '', updated_at: '' }));   // 選舉假名單 [{id, date}]
  const CLOCK = { roster: master.map((m) => ({ emp_id: m.emp_id, name: m.name, active: true })), approved, events: [], leave: [], requests: [] };
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => ({ getSheetByName: (n) => (n === 'payroll_hol_emp' && !opt.elec ? null : {}) }) },
    Utilities: { formatDate: () => opt.today || '2027-06-15' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + (opt.gs || GS_NOW) + '\n' + SP, sb);
  sb.__C = CLOCK; sb.__DB = DB; sb.__PUB = rows; sb.__TODAY = opt.today || '2027-06-15'; sb.__READS = {};
  vm.runInContext(`
    payClockRead = function(store, sheet){ return JSON.parse(JSON.stringify(globalThis.__C[sheet] || [])); };
    payRead      = function(kind){ globalThis.__READS[kind] = (globalThis.__READS[kind] || 0) + 1; return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(JSON.parse(JSON.stringify(rows))); };
    payInvalidate = function(){}; pnlSnapshotRemove_ = function(){};
    payHasClock = function(){ return true; }; payEmpStoresMap = function(){ return {}; };
    checkAdmin = function(){ return true; }; spreadsheetId = function(){ return 'X'; }; checkPnlKey_ = function(){ return ''; };
    todayTaipeiStr = function(){ return globalThis.__TODAY; };
    schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(globalThis.__PUB)); };
  `, sb);
  if (opt.from !== undefined) vm.runInContext('PAY_PT_HOL_MOVE_FROM = ' + JSON.stringify(opt.from) + ';', sb);
  if (opt.sup) {   // 同品牌支援店 SSLHQ（帳號 H-<工號>）的核定：{工號: {日期: 時數}}
    DB.store.push({ code: 'SSLHQ', name: '支援店', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: 'sxl' });
    people.forEach((x, i) => {
      DB.xmap.push({ emp_no: String(i + 1), pay_store: st, acct_store: st, emp_id: x.id, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
      DB.xmap.push({ emp_no: String(i + 1), pay_store: st, acct_store: 'SSLHQ', emp_id: 'H-' + x.id, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
    });
    const ap = {};
    Object.keys(opt.sup).forEach((id) => Object.keys(opt.sup[id]).forEach((d) => { (ap[d] = ap[d] || {})['H-' + id] = { approved_hours: opt.sup[id][d], status_text: '正常', periods: '', manager_name: '' }; }));
    sb.__AP = { SSLHQ: ap };
    vm.runInContext('(function(){ payXsupData_ = function(withDays){ return { xmap: payRead("xmap"), stores: payRead("store"), master: payRead("master"), approvedMap: function(c){ return globalThis.__AP[c] || {}; }, events: function(){ return []; }, tsDate: function(s){ return String(s).slice(0,10); }, today: globalThis.__TODAY, days: !!withDays }; }; })()', sb);
  }
  const F = (n) => vm.runInContext(n, sb);
  return { sb, F, DB,
    calc: (ym, extra) => J(F('handlePayrollCalc')(Object.assign({ admin_key: 'x', ym, store: st }, extra || {}))),
    by: (res, id) => (res.results || []).find((r) => r.emp_id === id) };
}
const holItems = (r) => r ? r.earn.filter((x) => x.item_key === 'holiday_double').map((x) => x.item_label + ' ' + x.qty + '×' + x.rate + '=' + x.amount) : 'NO_ROW';
/** 同一份資料跑本版與基準，回 [本版回應, 基準回應, 本版 DB, 基準 DB] */
function both(people, ym, opt) {
  const a = world(J(people), opt), b = world(J(people), Object.assign({}, opt, { gs: GS_BASE, from: undefined }));
  const ra = a.calc(ym), rb = b.calc(ym);
  return { a, b, ra, rb };
}
const sameAll = (x) => JSON.stringify([x.ra, x.a.DB.run, x.a.DB.item]) === JSON.stringify([x.rb, x.b.DB.run, x.b.DB.item]);
const sameFt = (x, ids) => ids.every((id) => JSON.stringify(x.a.by(x.ra, id)) === JSON.stringify(x.b.by(x.rb, id))
  && JSON.stringify(x.a.DB.item.filter((i) => i.emp_id === id)) === JSON.stringify(x.b.DB.item.filter((i) => i.emp_id === id)));

console.log('══ ① 開關（放寬性：填錯＝不開）══');
{
  const w = world([]);
  const on = (ym) => w.F('payPtHolOn_')(ym);
  chk('上線值 2026-12：11 月不開、12 月起開；ym 怪值不開', [on('2026-11'), on('2026-12'), on('2027-02'), on(''), on(null), on('2026/12')], [false, true, true, false, false, false]);
  for (const bad of ['2026/12', '', null, 'abc', '2026-13', '2026-1', ' ', 202612, true]) {
    const x = world([], { from: bad });
    chk('  開關填錯 ' + JSON.stringify(bad) + ' → 每個月都不開', ['2026-12', '2027-02', '9999-12'].map((m) => x.F('payPtHolOn_')(m)), [false, false, false]);
  }
  chk('  開關前後空白可以（「 2026-12 」）', world([], { from: ' 2026-12 ' }).F('payPtHolOn_')('2026-12'), true);
}

console.log('\n══ ② 計時的國定假日清單＝節日當天（payPtHolDates_）══');
{
  const w = world([]), f = (ym, ds, wo) => J((wo || w).F('payPtHolDates_')(ym, 'SSLGF', ds));
  const FT = (ym) => HOLROWS().find((r) => r.ym === ym).dates.split(', ').filter(Boolean);
  chk('2026-12（12/25 週五，不用換）：原樣回同一個陣列', (() => { const a = FT('2026-12'); return w.F('payPtHolDates_')('2026-12', 'SSLGF', a) === a; })(), true);
  chk('2027-01（元旦週五）：不用換', f('2027-01', FT('2027-01')), ['2027-01-01']);
  chk('2027-02：春節 2/6 週六→補 2/9、2/7 週日→補 2/10；和平紀念日 2/28 週日→補 3/1（在 3 月）→ 計時 2/4 2/5 2/6 2/7 2/8 2/28',
    f('2027-02', FT('2027-02')), ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-28']);
  chk('2027-03：3/1 是補假 → 計時 3 月沒有國定假日', f('2027-03', FT('2027-03')), []);
  chk('2027-04：4/6 補 4/4（兒童節週日）、4/30 補 5/1（勞動節週六，下個月）→ 計時 4/4、4/5', f('2027-04', FT('2027-04')), ['2027-04-04', '2027-04-05']);
  chk('2027-05：4/30 在 4 月正職清單 → 計時 5 月加 5/1', f('2027-05', FT('2027-05')), ['2027-05-01']);
  // 主管舉的例子：2026-10-10 週六、補假 10/09（開關改 2026-09 試）
  const w9 = world([], { from: '2026-09' });
  chk('例 10/10 週六、補假 10/09（開關 2026-09）：計時 10 月＝10/10、10/25', f('2026-10', FT('2026-10'), w9), ['2026-10-10', '2026-10-25']);
  chk('  正職照舊 10/09、10/26（payHolidayDates 不經過這支）', FT('2026-10'), ['2026-10-09', '2026-10-26']);
  const w10 = world([], { from: '2026-10' });
  chk('跨開關月份不換：開關 2026-10 時 9 月不換（9/25、9/28 本來就是平日）', f('2026-09', FT('2026-09'), w10), ['2026-09-25', '2026-09-28']);
  chk('補假日不在正職清單（例：本店專屬列沒填那天）→ 那組不換', f('2027-02', ['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09']), ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-08', '2027-02-28']);   // 2/10 不在 → 2/7 不換（2/28 照 3 月清單換）
  chk('節日在本月、補假在別月但那個月沒有列 → 不加', (() => { const x = world([], { holiday: HOLROWS().filter((r) => r.ym !== '2027-04') }); return f('2027-05', [], x); })(), []);
  chk('日期前後空白照樣對得到', f('2027-03', [' 2027-03-01 ']), []);
  const x9 = world([], { from: '9999-12' });
  chk('開關 9999-12：2027-02 原樣回（同一個陣列）', (() => { const a = FT('2027-02'); return x9.F('payPtHolDates_')('2027-02', 'SSLGF', a) === a; })(), true);
  chk('2027-12：12/24 補 12/25（週六）、12/31 補 2028 元旦（週六）→ 計時 12 月＝12/25', f('2027-12', ['2027-12-24', '2027-12-31']), ['2027-12-25']);
  chk('2028-01：2027-12 正職清單有 12/31 → 計時 1 月加 2028-01-01', (() => { const x = world([], { holiday: HOLROWS().concat([{ ym: '2027-12', red_days: 9, note: '', dates: '2027-12-24, 2027-12-31', store: '' }]) }); return f('2028-01', [], x); })(), ['2028-01-01']);
}

console.log('\n══ ③ 對照表＝人事行政總處原檔重算（tests/fixtures/holidays）══');
{
  const w = world([]);
  const FX = path.join(__dirname, 'fixtures', 'holidays');
  const parse = (f) => fs.readFileSync(path.join(FX, f), 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.split(',')).filter((c) => /^\d{8}$/.test(String(c[0] || '').trim()) && String(c[2] || '').trim() === '2')
    .map((c) => { const s = c[0].trim(); return { date: s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6), week: c[1], note: String(c[3] || '').trim() }; });
  const y26 = parse('115-202506.csv'), y27 = parse('116-202607.csv');
  const plan = (ds) => J(w.F('payHolidayDoublePlan')(ds, []));
  const want = Object.assign({}, plan(y26).moved, plan(y27).moved);
  const table = J(w.F('(function(){ return PAY_PT_HOL_ACTUAL_; })')());
  const t2 = Object.assign({}, table); delete t2['2028-01-01'];
  chk('2026、2027 年的 {節日:補假日} 跟原檔 payHolidayDoublePlan 算出的 moved 逐筆相同', t2, want);
  chk('  營運系統節日正本推送的 moved 也相同（fixtures/hol-publish-v1.json）', t2, JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hol-publish-v1.json'), 'utf8')).moved);
  chk('2028-01-01→2027-12-31：116 年檔 12/31 是「補假」、2027 單獨算配不到（正職 2027-12 照算 12/31）、2028 元旦是週六',
    [y27.find((d) => d.date === '2027-12-31').note, plan(y27).dates.indexOf('2027-12-31') >= 0, new Date(Date.UTC(2028, 0, 1)).getUTCDay()], ['補假', true, 6]);
  chk('正職清單（payHolidayDoublePlan.dates）＝本測試假分頁的雙薪日（2026-09～2027-06）', HOLROWS().map((r) => r.dates), HOLROWS().map((r) => plan(r.ym < '2027' ? y26 : y27).dates.filter((d) => d.slice(0, 7) === r.ym).join(', ')));
  // 每年人事行政總處公布明年辦公日曆表後要補對照表：10 月 1 日起明年還沒補就紅（提醒，不影響薪資計算）
  const years = J(w.F('(function(){ return PAY_PT_HOL_ACTUAL_YEARS_; })')());
  const now = new Date(), y = now.getUTCFullYear(), need = (now.getUTCMonth() >= 9) ? y + 1 : y;
  chk('對照表已補到 ' + need + ' 年（每年 10 月起要補明年；補法：拿新年度辦公日曆表原檔放 fixtures、跑這支、照 moved 補 PAY_PT_HOL_ACTUAL_ 與 PAY_PT_HOL_ACTUAL_YEARS_）', years.indexOf(need) >= 0, true);
}

console.log('\n══ ④ 整條計算：2026-12（T02＝11/29～12/26，12/25 週五）══');
const P = (cells, hours, extra) => Object.assign({ id: 'P01', ft: false, cells: cells || {}, hours: hours || {} }, extra || {});
const F1 = (cells, hours) => ({ id: 'E01', ft: true, cells: cells || {}, hours: hours || {} });
{
  const base = { '2026-12-01': 6, '2026-12-25': 6 };
  const run = (p, opt) => { const w = world([p, F1({ '2026-12-20': GUO }, { '2026-12-25': 8 })], opt); return w.by(w.calc('2026-12'), 'P01'); };
  chk('1 沒排移假、12/25 上班 6H → 6×200＝1,200', holItems(run(P({}, base))), ['國定假日加倍 6×200=1200']);
  chk('2 12/25 當天排 L國、沒上班 → 0（也沒有任何 L國 的給薪項目）', holItems(run(P({ '2026-12-25': GUO }, { '2026-12-01': 6 }))), []);
  chk('2b 12/25 當天排 L國、還是上了 6H → 對掉當天、照給 1,200', holItems(run(P({ '2026-12-25': GUO }, base))), ['國定假日加倍 6×200=1200']);
  chk('3 12/20 排 L國、12/25 上班 6H → 0（12/25 當一般日）', holItems(run(P({ '2026-12-20': GUO }, base))), []);
  chk('4 12/20、12/21 兩天 L國、12/25 上班 6H（本期只有 1 個國定假日）→ 0', holItems(run(P({ '2026-12-20': GUO, '2026-12-21': GUO }, base))), []);
  {
    const a = run(P({ '2026-12-20': GUO }, { '2026-12-01': 6 })), b = run(P({}, { '2026-12-01': 6 }));
    chk('5 12/20 排 L國、12/25 沒上班 → 薪資單跟沒排 L國 完全相同（L國 那天 0 元、沒有新項目）', [JSON.stringify(a.earn) === JSON.stringify(b.earn), a.gross, b.gross], [true, 1200, 1200]);
  }
  {
    const a = run(P({ '2026-12-20': GUO }, base)), b = run(P({}, base));
    chk('3b 應發少的就是那 1,200（12/25 的 6H 時薪照給）', [b.gross - a.gross, a.earn.find((x) => x.item_key === 'hourly_wage').qty], [1200, 12]);
    chk('3c 逐日：12/25 不再是國定假日（ot_info.hol 沒有 12/25）', [(a.ot_info || {}).hol || [], (b.ot_info || {}).hol], [[], ['2026-12-25']]);
  }
  {
    const p9 = P({ '2026-12-20': GUO }, { '2026-12-25': 9 }), p9n = P({}, { '2026-12-25': 9 });
    const a = run(p9), b = run(p9n);
    chk('3d 12/25 上班 9H、同期 L國：第 9 小時照平日加成（跟沒排 L國 時國定假日超過 8H 那段一樣）、沒有國定假日加倍',
      [holItems(a), a.earn.filter((x) => /^ot_/.test(x.item_key)).map((x) => x.item_key + ' ' + x.qty), b.earn.filter((x) => /^ot_/.test(x.item_key)).map((x) => x.item_key + ' ' + x.qty)],
      [[], ['ot_w43 1'], ['ot_w43 1']]);
  }
  // 正職同一份資料：跟基準逐欄相同
  const x = both([P({ '2026-12-20': GUO }, base), F1({ '2026-12-20': GUO }, { '2026-12-25': 8 }), { id: 'E02', ft: true, cells: {}, hours: { '2026-12-25': 8 } }], '2026-12');
  chk('正職（有排 L國／沒排）同一份資料：結果與明細跟基準 4ae34b2 逐欄相同', sameFt(x, ['E01', 'E02']), true);
  chk('  計時的差別只有國定假日加倍那一列（拿掉後跟基準相同）', (() => {
    const strip = (r) => { r = J(r); r.earn = r.earn.filter((i) => i.item_key !== 'holiday_double'); delete r.gross; delete r.net; delete r.ot_info; return r; };
    return JSON.stringify(strip(x.a.by(x.ra, 'P01'))) === JSON.stringify(strip(x.b.by(x.rb, 'P01')));
  })(), true);
  chk('  基準（現行）計時照給 1,200、本版 0', [holItems(x.b.by(x.rb, 'P01')), holItems(x.a.by(x.ra, 'P01'))], [['國定假日加倍 6×200=1200'], []]);
  const y = both([P({}, base), F1({ '2026-12-20': GUO }, { '2026-12-25': 8 })], '2026-12');
  chk('計時沒排 L國（12 月計時清單跟正職相同）→ 整份回應、run、item 跟基準逐位元組相同', sameAll(y), true);
}

console.log('\n══ ⑤ 手填國定假日時數（定案：同期有排移假時，手填時數也不加倍）══');
{
  const inp = (h) => [{ ym: '2026-12', emp_id: 'P01', store: 'SSLGF', hours: 12, extra_ot: 0, personal_h: 0, sick_h: 0, annual_h: 0, deduct_days: 0, support: '[]', updated_at: '', menstrual_h: 0, disaster_h: 0,
    full_attend: 0, work_days: 0, wage_override: 0, dorm_override: '', meal_on: 0, custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0, holiday_h: h, custom_add_more: '[]', hours_manual: '1' }];
  const run = (cells, h) => { const w = world([P(cells, { '2026-12-01': 6, '2026-12-25': 6 })], { input: inp(h) }); return w.by(w.calc('2026-12'), 'P01'); };
  chk('7 手填 8、12/20 L國、12/25 核定 6H → (8−6)×200＝400', holItems(run({ '2026-12-20': GUO }, 8)), ['國定假日加倍 2×200=400']);
  chk('7b 同樣手填 8、沒排 L國 → 8×200＝1,600', holItems(run({}, 8)), ['國定假日加倍 8×200=1600']);
  chk('7c 手填 4（比 12/25 核定少）、有 L國 → 最少 0、不倒扣', holItems(run({ '2026-12-20': GUO }, 4)), []);
  chk('7d 手填 6（＝自動帶的）、有 L國 → 0，跟自動算的一致', holItems(run({ '2026-12-20': GUO }, 6)), []);
  {
    const w = world([P({ '2026-12-20': GUO }, { '2026-12-01': 6, '2026-12-25': 6 })]);
    const r = w.by(w.calc('2026-12', { inputs: { P01: { hours: 12, holiday_h: 6 } } }), 'P01');
    chk('7e 畫面沒存的修改（inputs）也一樣：送 6、有 L國 → 0', holItems(r), []);
  }
}

console.log('\n══ ⑥ 跨店支援那天 ══');
{
  const run = (cells, sup) => { const w = world([P(cells, { '2026-12-01': 6 })], { sup: { P01: sup } }); return w.by(w.calc('2026-12'), 'P01'); };
  chk('6 沒排 L國、12/25 去支援店 5H → 支援補發加倍 5H', holItems(run({}, { '2026-12-25': 5 })), ['國定假日加倍（支援支援店） 5×200=1000']);
  chk('6b 12/20 排 L國、12/25 去支援店 5H → 不補發（當一般日）', holItems(run({ '2026-12-20': GUO }, { '2026-12-25': 5 })), []);
  chk('6c 12/20 排 L國、只在 12/20 以外的平日支援 → 照舊沒有加倍', holItems(run({ '2026-12-20': GUO }, { '2026-12-10': 5 })), []);
}

console.log('\n══ ⑦ 逢週末：計時認節日當天、正職照補假日（2027-02，T04＝1/24～2/20）══');
{
  const ppl = [P({}, { '2027-02-06': 5, '2027-02-09': 6, '2027-02-04': 4 }), { id: 'E01', ft: true, cells: {}, hours: { '2027-02-06': 8, '2027-02-09': 8 } }];
  const x = both(ppl, '2027-02');
  chk('8 計時 2/6（春節週六）上班 5H、2/9（補假）上班 6H、2/4 上班 4H → 加倍 2/4＋2/6＝9H×200＝1,800（2/9 不加倍）', holItems(x.a.by(x.ra, 'P01')), ['國定假日加倍 9×200=1800']);
  chk('  基準（現行）：2/4＋2/9＝10H×200＝2,000', holItems(x.b.by(x.rb, 'P01')), ['國定假日加倍 10×200=2000']);
  chk('  正職照舊（2/9 加發、2/6 不加發）：結果與明細跟基準逐欄相同', sameFt(x, ['E01']), true);
  {
    const w = world(J(ppl));
    const r = J(w.F('handlePayrollInputs')({ admin_key: 'x', ym: '2027-02', store: 'SSLGF' }));
    chk('  出勤資料畫面（payroll_inputs）的國定假日時數：計時 9（節日當天）、正職照舊 8（補假日）', [r.inputs.P01.holiday_h, r.inputs.E01.holiday_h], [9, 8]);
  }
  {
    const p = [P({ '2027-02-15': GUO }, { '2027-02-06': 5, '2027-02-09': 6, '2027-02-04': 4 })];
    const w = world(p); const r = w.by(w.calc('2027-02'), 'P01');
    chk('  同期 2/15 排 1 天 L國 → 抵本期最早的國定假日 2/4：剩 2/6 的 5H×200＝1,000', holItems(r), ['國定假日加倍 5×200=1000']);
  }
  {
    const p = [P({ '2027-02-06': GUO }, { '2027-02-09': 6 }), { id: 'E01', ft: true, cells: { '2027-02-06': GUO }, hours: { '2027-02-09': 8 } }];
    const w = world(p); const res = w.calc('2027-02');
    chk('  計時 L國 排在 2/6（節日當天）：不跳「清單沒有那天」黃字；正職排 2/6 照舊會跳（正職清單是 2/9）',
      [(w.by(res, 'P01').ot_info || {}).hol_gap || null, (w.by(res, 'E01').ot_info || {}).hol_gap || null], [null, ['2027-02-06']]);
  }
  {
    const w = world(J(ppl)); const r = J(w.F('handlePayrollCalc')({ admin_key: 'x', ym: '2027-02', store: 'SSLGF', dry_run: true, full_month: true }));
    chk('  試算回應給加班月表同步的 _hol_pt＝計時清單（跟正職不同時才帶）', [r._hol, r._hol_pt], [['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10'], ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-28']]);
    const w2 = world(J(ppl)); const r2 = J(w2.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-12', store: 'SSLGF', dry_run: true, full_month: true }));
    chk('  12 月兩份相同 → 不帶 _hol_pt', '_hol_pt' in r2, false);
  }
  {
    const x2 = both([P({}, { '2027-05-01': 7 }), P({}, { '2027-04-30': 7 }, { id: 'P02' })], '2027-05');
    const x3 = both([P({}, { '2027-05-01': 7 }), P({}, { '2027-04-30': 7 }, { id: 'P02' })], '2027-04');
    chk('跨月的補假：勞動節 2027-05-01 週六、補假 4/30 → 計時 5/1 上班 7H 加倍、4/30 上班不加倍',
      [holItems(x2.a.by(x2.ra, 'P01')), holItems(x3.a.by(x3.ra, 'P02'))], [['國定假日加倍 7×210=1470'], []]);   // 5 月到職滿半年，時薪 200＋年資加給 10（基準同）
    chk('  基準（現行）：5/1 不加倍、4/30 加倍', [holItems(x2.b.by(x2.rb, 'P01')), holItems(x3.b.by(x3.rb, 'P02'))], [[], ['國定假日加倍 7×200=1400']]);
    chk('  5 月時薪基準也是 210（年資加給不是這次改的）', x2.b.by(x2.rb, 'P01').earn.find((i) => i.item_key === 'hourly_wage').rate + (x2.b.by(x2.rb, 'P01').earn.find((i) => i.item_key === 'pt_tenure_plus') || { rate: 0 }).rate, 210);
  }
}

console.log('\n══ ⑧ 跨月的四週期 ══');
{
  // T02（11/29～12/26）跨 11／12 月：11/30 排 L國（在 11 月），12/25 上班
  const p = P({ '2026-11-30': GUO }, { '2026-11-20': 6, '2026-12-25': 6 });
  const w = world([p]);
  chk('9 11/30（T02、11 月）排 L國、12/25 上班 6H → 12 月 0', holItems(w.by(w.calc('2026-12'), 'P01')), []);
  const x = both([p, F1({ '2026-11-30': GUO }, { '2026-11-20': 8, '2026-12-25': 8 })], '2026-11');
  chk('  11 月（開關之前）：整份回應、run、item 跟基準逐位元組相同', sameAll(x), true);
  // T03（12/27～2027/01/23）跨 12／1 月：12/28 排 L國（在 12 月），2027-01-01 上班
  const q = P({ '2026-12-28': GUO }, { '2026-12-25': 6, '2027-01-01': 6 });
  const w2 = world([q]);
  chk('10 12/28（T03、12 月）排 L國、2027-01-01 上班 6H → 1 月 0', holItems(w2.by(w2.calc('2027-01'), 'P01')), []);
  const w3 = world([q]);
  chk('  同一位 12 月：12/25 在 T02（12/28 的 L國 是 T03 的）→ 照給 1,200', holItems(w3.by(w3.calc('2026-12'), 'P01')), ['國定假日加倍 6×200=1200']);
}

console.log('\n══ ⑨ 開關之前的月份、開關填錯 → 跟基準逐位元組相同 ══');
{
  const ppl = [P({ '2026-09-20': GUO, '2026-10-20': GUO, '2026-11-20': GUO, '2026-12-20': GUO, '2027-02-15': GUO }, { '2026-09-25': 6, '2026-10-09': 6, '2026-10-10': 5, '2026-11-20': 6, '2026-12-25': 6, '2027-02-06': 5, '2027-02-09': 6 }),
    F1({ '2026-12-20': GUO, '2027-02-15': GUO }, { '2026-09-25': 8, '2026-10-09': 8, '2026-12-25': 8, '2027-02-09': 8 })];
  for (const ym of ['2026-09', '2026-10', '2026-11']) chk(ym + '（開關之前）：回應、run、item 逐位元組相同', sameAll(both(ppl, ym)), true);
  for (const bad of ['2026/12', '', null, 'abc', '2026-13', '9999-12']) {
    chk('開關 ' + JSON.stringify(bad) + '：2026-12、2027-02 逐位元組相同', ['2026-12', '2027-02'].map((ym) => sameAll(both(ppl, ym, { from: bad }))), [true, true]);
  }
  {
    const x = both(ppl, '2026-12', { from: '2026/12' });
    chk('  （對照組）同一份資料開關開著時 12 月計時確實不同（證明上面有比到東西）', sameAll(both(ppl, '2026-12')), false);
    chk('  填錯時計時照現行給 12/25 加倍', holItems(x.a.by(x.ra, 'P01')), ['國定假日加倍 6×200=1200']);
  }
  {
    const x = both([P({}, { '2026-12-25': 6 })], '2026-12');
    chk('沒有 L國、12 月：讀分頁次數跟基準相同（不多讀主檔）', x.a.sb.__READS, x.b.sb.__READS);
  }
}

console.log('\n══ ⑩ 正職所有情境 → 跟基準完全相同（開關開著）══');
{
  const ft = [
    { id: 'E01', ft: true, cells: { '2026-12-20': GUO }, hours: { '2026-12-25': 8 } },
    { id: 'E02', ft: true, cells: {}, hours: { '2026-12-25': 10 } },
    { id: 'E03', ft: true, cells: { '2026-12-25': GUO }, hours: {} },
    { id: 'E04', ft: true, cells: { '2026-12-20': GUO, '2026-12-21': GUO }, hours: { '2026-12-25': 6 } },
    { id: 'E05', ft: true, cells: { '2026-11-30': GUO }, hours: { '2026-12-25': 8 } },
    { id: 'E06', ft: true, cells: { '2027-02-15': GUO, '2027-02-06': GUO }, hours: { '2027-02-06': 8, '2027-02-09': 8, '2027-02-04': 8 } },
    { id: 'E07', ft: true, cells: { '2026-12-28': GUO }, hours: { '2027-01-01': 8 } },
  ];
  for (const ym of ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05']) {
    chk('只有正職、' + ym + '：回應、run、item 逐位元組相同', sameAll(both(ft, ym)), true);
    chk('  正職＋計時混在一起、' + ym + '：每位正職逐欄相同', sameFt(both(ft.concat([P({ '2026-12-20': GUO, '2027-02-15': GUO }, { '2026-12-25': 6, '2027-02-06': 5, '2027-02-09': 6, '2027-05-01': 4 })]), ym), ft.map((x) => x.id)), true);
  }
  {
    const sup = { E01: { '2026-12-25': 5 } };
    const x = both([{ id: 'E01', ft: true, cells: { '2026-12-20': GUO }, hours: { '2026-12-01': 8 } }], '2026-12', { sup });
    chk('正職 12/25 去支援、同期 L國：逐位元組相同', sameAll(x), true);
  }
}

console.log('\n══ ⑪ 總部計時出現 L國 → 照同一套 ══');
{
  const w = world([P({ '2026-12-20': GUO }, { '2026-12-25': 6 })], { store: 'HQ' });
  const w2 = world([P({}, { '2026-12-25': 6 })], { store: 'HQ' });
  chk('總部計時 12/20 L國、12/25 上班 → 0；沒排 → 1,200', [holItems(w.by(w.calc('2026-12'), 'P01')), holItems(w2.by(w2.calc('2026-12'), 'P01'))], [[], ['國定假日加倍 6×200=1200']]);
}

console.log('\n══ ⑪b 總部三個薪酬單位（HQ／MZTHQ／SSLHQ）計時：跟門市計時同一套（2026-11-28 主管「總部也改」）══');
/* 白話：總部（三個薪酬單位共用總部打卡表，班表都在總部 hq 發布）的計時同仁，2026-12 月份薪資起跟門市計時一樣——國定假日認節日當天；
 *   同一 28 天期把 L國 排在不是節日的日子（含補假日）＝移走，依日期先後抵本期最早、自己沒排 L國 的節日，被抵掉的節日上班不加倍；其餘節日上班的時數加倍（加發 時數×時薪）。
 * 手算（時薪 200、沒有加給）：
 *   H1 12 月：12/20 L國、12/25 上班 6H → 12/25 被抵 → 0
 *   H2 12 月：沒排 L國、12/25 上班 6H → 6×200＝1,200
 *   H3 2027-02：沒排 L國、只有 2/9（補假日）上班 5H → 計時 2/9 不是國定假日 → 0（基準 4ae34b2 照正職雙薪日給 5×200＝1,000）
 *   H4 2027-02：L國 排在節日當天的平日 2/4 2/5 2/8、2/6（春節週六）上班 5H、2/9 上班 6H → 2/6 沒被抵 → 5×200＝1,000；2/9 一般日
 *   H5 2027-02：總部畫面預填（L國 2/4 2/5 2/8 2/9 2/10）、2/6 上班 5H → 2/9、2/10 兩天移走，抵 2/6、2/7 → 0
 *   H6 2027-02：L國 2/4 2/5 2/8 2/9（2/10 上班 6H）、2/6 上班 5H → 移走 1 天抵最早沒排的 2/6 → 0（2/10 一般日）
 *   班表端同一組情境（mala-store-ops test/server/schedule-rules.test.js「總部計時 T02／T04」）：H1＝C3 不加倍、H2＝C3 工資加倍、H4＝2/6 C3 工資加倍、H5＝2/6 C3「移到 2/9、2/10」、H6＝2/6 C3「移到 2/9」。 */
{
  const UNITS = [['HQ', 'hq'], ['MZTHQ', 'hq'], ['SSLHQ', 'hq']];
  const G = (ds) => Object.fromEntries(ds.map((d) => [d, GUO]));
  const CASES = [
    ['H1 12 月：12/20 L國、12/25 上班 6H → 0', '2026-12', G(['2026-12-20']), { '2026-12-01': 6, '2026-12-25': 6 }, []],
    ['H2 12 月：沒排 L國、12/25 上班 6H → 1,200', '2026-12', {}, { '2026-12-01': 6, '2026-12-25': 6 }, ['國定假日加倍 6×200=1200']],
    ['H3 2027-02：沒排 L國、補假日 2/9 上班 5H → 0', '2027-02', {}, { '2027-02-09': 5 }, []],
    ['H4 2027-02：L國 2/4 2/5 2/8、2/6 上班 5H、2/9 上班 6H → 1,000', '2027-02', G(['2027-02-04', '2027-02-05', '2027-02-08']), { '2027-02-06': 5, '2027-02-09': 6 }, ['國定假日加倍 5×200=1000']],
    ['H5 2027-02：總部預填 L國 2/4 2/5 2/8 2/9 2/10、2/6 上班 5H → 0', '2027-02', G(['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10']), { '2027-02-06': 5 }, []],
    ['H6 2027-02：L國 2/4 2/5 2/8 2/9、2/10 上班 6H、2/6 上班 5H → 0', '2027-02', G(['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09']), { '2027-02-06': 5, '2027-02-10': 6 }, []],
  ];
  for (const [st, pub] of UNITS) {
    for (const [name, ym, cells, hours, want] of CASES) {
      const w = world([P(cells, hours)], { store: st, pub });
      chk(st + ' ' + name, holItems(w.by(w.calc(ym), 'P01')), want);
    }
    const x = both([P({}, { '2027-02-09': 5 })], '2027-02', { store: st, pub });
    chk(st + '   基準 4ae34b2（現行）H3 照正職雙薪日給 5×200＝1,000（證明班表找得到、有比到東西）', holItems(x.b.by(x.rb, 'P01')), ['國定假日加倍 5×200=1000']);
    const y = both([{ id: 'E01', ft: true, cells: {}, hours: { '2027-02-06': 8, '2027-02-09': 8 } }, { id: 'E02', ft: true, cells: G(['2027-02-15']), hours: { '2027-02-09': 8 } }, P({}, { '2027-02-09': 5 })], '2027-02', { store: st, pub });
    chk(st + '   正職同一份資料：結果與明細跟基準逐欄相同', sameFt(y, ['E01', 'E02']), true);
    const z = world([P({}, { '2027-02-06': 5, '2027-02-09': 6 })], { store: st, pub });
    const r = J(z.F('handlePayrollInputs')({ admin_key: 'x', ym: '2027-02', store: st }));
    chk(st + '   出勤資料畫面的國定假日時數＝節日當天 2/6 的 5（不是補假日 2/9 的 6）', r.inputs.P01.holiday_h, 5);
  }
}

console.log('\n══ ⑫ 損益月中估算（handlePnlLaborEstimate_）同一套 ══');
{
  const est = (cells) => { const w = world([P(cells, { '2026-12-01': 6, '2026-12-25': 6 })], { today: '2026-12-27' });
    return J(w.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2026-12', store: 'SSLGF' })); };
  const a = est({}), b = est({ '2026-12-20': GUO });
  const num = (r) => JSON.stringify(r).match(/"(?:gross|labor_total|total)":(\d+(?:\.\d+)?)/);
  chk('估算算得出來', [a.ok, b.ok], [true, true]);
  chk('12/20 排 L國 → 估算少 12/25 的國定假日加倍（6×200＝1,200）', num(a) && num(b) ? Number(num(a)[1]) - Number(num(b)[1]) : 'NO_NUM', 1200);
  const x = (() => { const p = [P({ '2026-12-20': GUO }, { '2026-12-01': 6, '2026-12-25': 6 })];
    const n = world(J(p), { today: '2026-12-27', from: '9999-12' }), o = world(J(p), { today: '2026-12-27', gs: GS_BASE });
    return [J(n.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2026-12', store: 'SSLGF' })), J(o.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2026-12', store: 'SSLGF' }))]; })();
  chk('  開關關著（9999-12）：估算跟基準逐位元組相同', JSON.stringify(x[0]) === JSON.stringify(x[1]), true);
}

console.log('\n══ ⑬ 驗收員補洞（2026-11-28）：每一處新判斷都要有測試守著 ══');
{
  // M4 加班月表同步（payOtMonthSync_）：今天 2027-02-06（春節週六），計時當天是國定假日 → 休息日旗標 TRUE；正職 2/6 不在雙薪日 → FALSE
  const w = world([P({}, { '2027-02-01': 6 }), { id: 'E01', ft: true, cells: {}, hours: { '2027-02-01': 8 } }], { today: '2027-02-06' });
  w.sb.__OTPUT = [];
  w.F(`(function(){ payClockSS = function(){ return { getSheetByName: function(){ return { getLastRow: function(){ return 0; }, getLastColumn: function(){ return 0; }, getMaxRows: function(){ return 1000; }, insertRowsAfter: function(){},
    getRange: function(){ return { getValues: function(){ return []; }, setNumberFormat: function(){} }; } }; } }; };
    paySafePut_ = function(sh, r0, nc, h, values){ globalThis.__OTPUT.push(JSON.parse(JSON.stringify(values))); return function(){}; }; })()`);
  const res = J(w.F('payOtMonthSync_')());
  const rows = (w.sb.__OTPUT[0] || []).slice(1).reduce((o, r) => { o[r[0]] = r[2]; return o; }, {});
  chk('M4 加班月表同步：今天 2/6 計時休息日旗標 TRUE（認節日當天）、正職 FALSE（正職雙薪日是 2/9）', [res.ok, rows['測試甲'], rows['測試乙']], [true, 'TRUE', 'FALSE']);
}
{
  // M6 損益月中估算的跨店支援補發：12/20 排 L國、12/25 去支援店 5H → 估算不含支援加倍（沒排 L國 時含 5×200＝1,000）
  const est = (cells) => { const w = world([P(cells, { '2026-12-01': 6 })], { today: '2026-12-27', sup: { P01: { '2026-12-25': 5 } } });
    return J(w.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2026-12', store: 'SSLGF' })); };
  const num = (r) => { const m = JSON.stringify(r).match(/"(?:gross|labor_total|total)":(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; };
  const a = est({}), b = est({ '2026-12-20': GUO });
  chk('M6 損益估算：12/20 排 L國、12/25 去支援 5H → 比沒排 L國 少支援補發加倍 1,000', [a.ok, b.ok, num(a) - num(b)], [true, true, 1000]);
}
{
  // M11 跨開關月份的對照不換：開關 2027-05 時，5 月開、4 月不開 → 勞動節 5/1（補假 4/30 在 4 月、照舊規則已加倍）不加進 5 月計時清單
  const w = world([], { from: '2027-05' });
  chk('M11 開關 2027-05：5 月開著，但對照到的 4/30 在 4 月（開關之前）→ 5 月計時清單不加 5/1（不重複給）', J(w.F('payPtHolDates_')('2027-05', 'SSLGF', [])), []);
  const w2 = world([], { from: '2027-04' });
  chk('  （對照組）開關 2027-04：兩邊都開 → 5 月加 5/1', J(w2.F('payPtHolDates_')('2027-05', 'SSLGF', [])), ['2027-05-01']);
  // 2027-12-31 補 2028 元旦：開關 2028-01 時 12 月不開 → 1 月不加 2028-01-01
  const w3 = world([], { from: '2028-01', holiday: HOLROWS().concat([{ ym: '2027-12', red_days: 9, note: '', dates: '2027-12-24, 2027-12-31', store: '' }]) });
  chk('M11 開關 2028-01：12/31 在 2027-12（開關之前）→ 2028-01 計時清單不加元旦', J(w3.F('payPtHolDates_')('2028-01', 'SSLGF', [])), []);
}
{
  // M12 抵法裡本期跨到的別月份也要換成計時清單：T07＝4/18～5/15；計時 5/10 排 1 天 L國、5/1 上班 7H。
  //   計時清單：4 月只有 4/4、4/5（不在 T07），5 月 5/1 → 本期只有 5/1 → 抵掉 5/1 → 0。用正職清單會多一個 4/30（比 5/1 早，先被抵）→ 5/1 照給（錯）
  const w = world([P({ '2027-05-10': GUO }, { '2027-05-01': 7, '2027-04-30': 6 })]);
  chk('M12 T07 跨 4／5 月：5/10 排 L國 → 抵掉 5/1（4/30 對計時不是國定假日，不能先被抵）→ 5 月國定假日加倍 0', holItems(w.by(w.calc('2027-05'), 'P01')), []);
  const w2 = world([P({}, { '2027-05-01': 7 })]);
  chk('  （對照組）沒排 L國 → 5/1 照給 7×210', holItems(w2.by(w2.calc('2027-05'), 'P01')), ['國定假日加倍 7×210=1470']);
}
// M13／M14 選舉日（名單上的日子）：計時用計時清單判斷「是不是國定假日」與「國定假日時數有沒有被手改」
function elecCase(fn) {
  // 甲：選舉日放在 2/6（春節週六，計時的國定假日）→ 以國定假日為準，不另加選舉日；用正職清單會多一筆選舉日加倍
  const a = fn([P({}, { '2027-02-06': 5, '2027-02-01': 6 })], [{ id: 'P01', date: '2027-02-06' }]);
  // 乙：選舉日 2/12（平日上班）6H，另 2/6 上 5H、2/9（補假）上 6H；國定假日時數＝計時清單 5H → 沒手改 → 選舉日照發 6H
  //     用正職清單比對（2/9 的 6H）會誤判成手改、選舉日停發
  const b = fn([P({}, { '2027-02-12': 6, '2027-02-06': 5, '2027-02-09': 6 })], [{ id: 'P01', date: '2027-02-12' }]);
  return [a, b];
}
{
  const run = (ppl, elec) => { const w = world(ppl, { elec }); return holItems(w.by(w.calc('2027-02'), 'P01')); };
  const [a, b] = elecCase(run);
  chk('M14 主計算：選舉日在計時的國定假日 2/6 → 只有國定假日加倍 5H、沒有選舉日那列', a, ['國定假日加倍 5×200=1000']);
  chk('M14 主計算：選舉日 2/12、國定假日時數沒手改 → 國定假日 5H＋選舉日 6H', b, ['國定假日加倍 5×200=1000', '選舉日出勤 6×200=1200']);
}
{
  const num = (r) => { const m = JSON.stringify(r).match(/"(?:gross|labor_total|total)":(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; };
  const est = (ppl, elec) => { const w = world(ppl, { elec, today: '2027-02-27' }); return num(J(w.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2027-02', store: 'SSLGF' }))); };
  const [a, b] = elecCase(est);
  const a0 = est([P({}, { '2027-02-06': 5, '2027-02-01': 6 })], [{ id: 'X99', date: '2027-02-06' }]);
  const b0 = est([P({}, { '2027-02-12': 6, '2027-02-06': 5, '2027-02-09': 6 })], [{ id: 'X99', date: '2027-02-12' }]);
  chk('M13 損益估算：選舉日在計時的國定假日 2/6 → 跟沒勾選相同（不另加選舉日）', a - a0, 0);
  chk('M13 損益估算：選舉日 2/12、國定假日時數沒手改 → 比沒勾選多選舉日 6×200＝1,200', b - b0, 1200);
}

console.log('\n══ ⑭ 上限＝本期在職國定假日天數：多排的 L國 不採計（Codex 第 2 輪擋項 1；央廚只提醒、總部違反照存，多排的班表會發布）══');
/* 白話：計時同一 28 天期的 L國，只採計「在職日、依日期先後的前 N 筆」，N＝本期國定假日（節日當天）落在在職日的天數；第 N+1 筆起當作沒排。
 *   採計的照原抵法（當天的對掉、其餘由早到晚抵本期節日，含到職前的）。跟班表 C7 擋的那一筆同一條線（mala-store-ops rules.js ptHolChecks）。
 * 手算（時薪 200、沒有加給；「加倍」＝國定假日加發 時數×時薪，當天另有本薪 時數×時薪）：
 *   K1 央廚 CF 2027-04（T06＝3/21～4/17；計時節日 4/4 週日、4/5 週一）4/5 到職 → 在職節日只有 4/5、N＝1；L國 4/7、4/8；4/5 上班 6H
 *      → 只採計 4/7，抵最早的 4/4（到職前）→ 4/5 加倍 6×200＝1,200（當天合計 2,400）。改前兩筆都採計、4/4 4/5 都被抵 → 0（少 1,200）
 *   K2 同 K1 只排 4/7 → 1,200（改前改後一樣，對照）
 *   K3 同 K1 但 2026-10 到職（N＝2）、L國 4/7 4/8 4/9 → 採計 2 筆抵 4/4、4/5 → 0（整期在職時上限碰不到被抵的天數，改前改後一樣）
 *   K4 門市 2027-02（T04＝1/24～2/20；計時節日 2/4～2/8）2/6 到職 → N＝3（2/6 2/7 2/8）；L國 2/10～2/14 五筆；2/8 上班 6H
 *      → 採計 2/10 2/11 2/12 抵 2/4 2/5 2/6 → 2/8 加倍 6×200＝1,200。改前五筆抵滿 2/4～2/8 → 0
 *   K5 K1 手填國定假日時數 6 → 抵掉的只有 4/4（當天 0H）→ 扣 0 → 6×200＝1,200。改前抵 4/4 4/5、扣 6 → 0
 *   K6 K1 損益月中估算同一套 → 比改前多 1,200
 *   K7 當天的 L國 也算在 N 裡：同 K1 但 L國 排 4/5（節日當天）、4/7 → 依日期前 1 筆＝4/5，4/7 不採計 → 不抵 4/4；沒有人在節日上班 → 抵掉的清單是空的 */
{
  const G = (ds) => Object.fromEntries(ds.map((d) => [d, GUO]));
  const cf = (cells, hours, extra, opt) => world([P(cells, hours, extra)], Object.assign({ store: 'CF', pub: 'cf' }, opt || {}));
  const K1 = [G(['2027-04-07', '2027-04-08']), { '2027-04-05': 6 }, { hire: '2027-04-05' }];
  { const w = cf(...K1); chk('K1 央廚 4/5 到職、L國 4/7 4/8、4/5 上班 6H → 只採計 4/7（抵 4/4）→ 4/5 加倍 1,200', holItems(w.by(w.calc('2027-04'), 'P01')), ['國定假日加倍 6×200=1200']); }
  { const w = cf(...K1); chk('K1   抵掉的清單只有 4/4（payHolMovedPt_）', J(w.F('payHolMovedPt_')('2027-04', 'CF', w.F('payRead')('master'), w.F('payPtHolDates_')('2027-04', 'CF', ['2027-04-05', '2027-04-06', '2027-04-30']))), { P01: { '2027-04-04': true } }); }
  { const w = cf(G(['2027-04-07']), { '2027-04-05': 6 }, { hire: '2027-04-05' }); chk('K2 同 K1 只排 4/7 → 1,200（對照，改前改後一樣）', holItems(w.by(w.calc('2027-04'), 'P01')), ['國定假日加倍 6×200=1200']); }
  { const w = cf(G(['2027-04-07', '2027-04-08', '2027-04-09']), { '2027-04-05': 6 }); chk('K3 整期在職（N＝2）、L國 4/7 4/8 4/9 → 4/4 4/5 都被抵 → 0', holItems(w.by(w.calc('2027-04'), 'P01')), []); }
  { const w = world([P(G(['2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13', '2027-02-14']), { '2027-02-08': 6 }, { hire: '2027-02-06' })]);
    chk('K4 門市 2/6 到職（N＝3）、L國 2/10～2/14 五筆、2/8 上班 6H → 採計 3 筆抵 2/4 2/5 2/6 → 2/8 加倍 1,200', holItems(w.by(w.calc('2027-02'), 'P01')), ['國定假日加倍 6×200=1200']); }
  { const inp = [{ ym: '2027-04', emp_id: 'P01', store: 'CF', hours: 6, extra_ot: 0, personal_h: 0, sick_h: 0, annual_h: 0, deduct_days: 0, support: '[]', updated_at: '', menstrual_h: 0, disaster_h: 0,
      full_attend: 0, work_days: 0, wage_override: 0, dorm_override: '', meal_on: 0, custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0, holiday_h: 6, custom_add_more: '[]', hours_manual: '1' }];
    const w = cf(...K1, { input: inp });
    chk('K5 K1 手填國定假日時數 6 → 抵掉的 4/4 當天 0H、不扣 → 1,200', holItems(w.by(w.calc('2027-04'), 'P01')), ['國定假日加倍 6×200=1200']); }
  { const est = (cells) => { const w = cf(cells, { '2027-04-05': 6 }, { hire: '2027-04-05' }, { today: '2027-04-18' }); return J(w.F('handlePnlLaborEstimate_')({ key: 'k', ym: '2027-04', store: 'CF' })); };
    const num = (r) => { const m = JSON.stringify(r).match(/"(?:gross|labor_total|total)":(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : NaN; };
    const one = est(G(['2027-04-07'])), two = est(K1[0]);
    chk('K6 損益月中估算：多排的 4/8 不採計 → 跟只排 4/7 一樣（都含 4/5 加倍）', [one.ok, two.ok, num(two) - num(one)], [true, true, 0]); }
  { const w = cf(G(['2027-04-05', '2027-04-07']), {}, { hire: '2027-04-05' });
    chk('K7 當天的 L國 也算進 N：L國 4/5 4/7、N＝1 → 只採計 4/5（當天）→ 4/7 不抵 4/4 → 沒有抵掉的日子', J(w.F('payHolMovedPt_')('2027-04', 'CF', w.F('payRead')('master'), ['2027-04-04', '2027-04-05'])), {}); }
  { // 離職：K8 2027-02 T04、2/5 離職 → N＝2（2/4 2/5）；L國 1/26 1/27 1/28 → 採計 2 筆抵 2/4 2/5（離職後的 2/6～2/8 不會被抵，本來就沒上班）
    const w = world([P(G(['2027-01-26', '2027-01-27', '2027-01-28']), {}, { leave: '2027-02-05' })]);
    chk('K8 2/5 離職（N＝2）、L國 1/26 1/27 1/28 → 只抵 2/4 2/5', J(w.F('payHolMovedPt_')('2027-02', 'SSLGF', w.F('payRead')('master'), w.F('payPtHolDates_')('2027-02', 'SSLGF', HOLROWS().find((r) => r.ym === '2027-02').dates.split(', ')))), { P01: { '2027-02-04': true, '2027-02-05': true } }); }
  // 正職、開關關著：同一份資料跟基準逐位元組相同（cap 只在計時路徑）
  { const ppl = [{ id: 'E01', ft: true, cells: G(['2027-04-07', '2027-04-08']), hours: { '2027-04-05': 8, '2027-04-06': 8 }, hire: '2027-04-05' }, P(...K1)];
    const x = both(ppl, '2027-04', { store: 'CF', pub: 'cf' });
    chk('K9 正職 4/5 到職、L國 4/7 4/8（正職不設上限，照改版前）：結果與明細跟基準逐欄相同', sameFt(x, ['E01']), true);
    const off = world(J(ppl), { store: 'CF', pub: 'cf', from: '9999-12' }), base = world(J(ppl), { store: 'CF', pub: 'cf', gs: GS_BASE });
    chk('K10 開關關著（9999-12）：整份回應與寫入跟基準逐位元組相同', JSON.stringify([off.calc('2027-04'), off.DB.run, off.DB.item]) === JSON.stringify([base.calc('2027-04'), base.DB.run, base.DB.item]), true); }
}

console.log('\n══ ⑮ 計時國定假日照「門市另設表」（本店專屬列；2026-11-28 主管「吃門市另設表」；Codex 第 2 輪擋項 2）══');
/* 白話：計時的國定假日（哪幾天是節日當天、N 幾天）照該單位的本店專屬列；沒有專屬列照集團。正職照舊。
 *   專屬列存的是正職雙薪日（含補假日）；換成計時的節日當天照 payPtHolDates_：專屬列少了某個補假日＝它替的節日計時也不算；多放的日子照原樣算。
 *   班表（mala-store-ops）每天用 payroll_holiday_pt_own 讀同一份換算結果，C3／C4／C7 與 N 跟這裡同源。
 * 手算（總部 HQ、2027-02、T04＝1/24～2/20、時薪 200、沒有加給；「加倍」＝國定假日加發 時數×時薪，當天另有本薪 時數×時薪）：
 *   O1（Codex E1）HQ 專屬 2 月列 2/4 2/5 2/8 2/9（少 2/10）→ 計時 2/4 2/5 2/6 2/8（2/7 不算）、N＝4；
 *      L國 2/4 2/5 2/6 2/9、2/8 上班 6H → 對掉 2/4 2/5 2/6，2/9 移走抵 2/8 → 2/8 不加倍：加發 0（當天本薪 1,200）。
 *      沒有專屬列（集團）：計時 2/4～2/8、2/9 抵 2/7 → 2/8 加倍 6×200＝1,200（當天 2,400）
 *   O2（多放一天）專屬列＝集團＋2/11 → 計時 2/4～2/8、2/11，N＝6；L國 2/4～2/8、2/11 上班 6H → 2/11 沒被抵 → 加倍 1,200。集團：2/11 不是節日 → 0
 *   O3（少放一天）專屬列 2/5 2/8 2/9 2/10（少 2/4）→ 計時 2/5～2/8，N＝4；L國 2/5～2/8、2/4 上班 6H → 2/4 不是節日 → 0。集團：2/4 沒被抵 → 1,200
 *   O4 跨月：HQ 專屬 3 月列沒有 3/1 → 2/28（和平紀念日，補假 3/1）計時不算 → 2 月清單少 2/28
 *   O5 正職同一份資料（含專屬列）跟基準 4ae34b2 逐欄相同 */
{
  const G = (ds) => Object.fromEntries(ds.map((d) => [d, GUO]));
  const ownRow = (ym, dates, st) => ({ ym, red_days: 13, note: '', dates, store: st || 'HQ' });
  const withOwn = (...rows) => HOLROWS().concat(rows);
  const hq = (cells, hours, hol) => world([P(cells, hours)], Object.assign({ store: 'HQ', pub: 'hq' }, hol ? { holiday: hol } : {}));
  const pay = (w) => holItems(w.by(w.calc('2027-02'), 'P01'));
  const O1 = withOwn(ownRow('2027-02', '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09'));
  const O2 = withOwn(ownRow('2027-02', '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10, 2027-02-11'));
  const O3 = withOwn(ownRow('2027-02', '2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10'));
  const c1 = [G(['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-09']), { '2027-02-08': 6 }];
  const c2 = [G(['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08']), { '2027-02-11': 6 }];
  const c3 = [G(['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08']), { '2027-02-04': 6 }];
  chk('O1 HQ 專屬列少 2/10：2/9 L國 抵 2/8 → 2/8 不加倍', pay(hq(...c1, O1)), []);
  chk('O1   沒有專屬列（集團）：2/9 抵 2/7 → 2/8 加倍 1,200', pay(hq(...c1)), ['國定假日加倍 6×200=1200']);
  chk('O2 專屬列多放 2/11：2/11 上班加倍 1,200', pay(hq(...c2, O2)), ['國定假日加倍 6×200=1200']);
  chk('O2   集團：2/11 不是節日 → 0', pay(hq(...c2)), []);
  chk('O3 專屬列少放 2/4：2/4 上班 → 0', pay(hq(...c3, O3)), []);
  chk('O3   集團：2/4 沒被抵 → 1,200', pay(hq(...c3)), ['國定假日加倍 6×200=1200']);
  // payroll_holiday_pt_own（給班表的同一份換算結果）
  const act = (w, body) => { vm.runInContext('payReadNoCreate_ = function(k){ return payRead(k); };', w.sb); return J(w.F('handlePayrollHolidayPtOwn')(body)); };
  const auth = (w) => { vm.runInContext('payHolPubSvcOk_ = function(b){ return !!b && b.svcKey === "K"; };', w.sb); return w; };
  { const w = hq(...c1, O1); chk('動作：沒設 PAY_HOL_SVC_KEY／金鑰不對 → unauthorized', act(w, { svcKey: 'K' }), { ok: false, error: 'unauthorized' }); }
  { const w = auth(hq(...c1, O1));
    chk('O1 動作回 HQ 2 月計時清單（2/7 不在）＋計時同仁名單；1 月、3 月跟集團相同不列', act(w, { svcKey: 'K' }),
      { ok: true, v: 1, from: '2026-12', units: [{ unit: 'HQ', sched: 'hq', prefix: '', pt: [{ id: 'P01', name: '測試甲' }],
        months: { '2027-02': ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-08', '2027-02-28'] } }] }); }
  { const w = auth(hq(...c2, O2)); chk('O2 動作：2 月清單多 2/11', act(w, { svcKey: 'K' }).units[0].months, { '2027-02': ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-11', '2027-02-28'] }); }
  { const w = auth(hq(...c3, O3)); chk('O3 動作：2 月清單少 2/4', act(w, { svcKey: 'K' }).units[0].months, { '2027-02': ['2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-28'] }); }
  { const w = auth(hq({}, {}, withOwn(ownRow('2027-03', ''))));
    chk('O4 跨月：HQ 專屬 3 月列沒有 3/1 → 2 月清單少 2/28（2 月沒有專屬列也列出）；3 月計時清單跟集團一樣都是空的不列', act(w, { svcKey: 'K' }).units[0].months,
      { '2027-02': ['2027-02-04', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08'] }); }
  { const w = auth(hq({}, {}, withOwn(ownRow('2027-02', HOLROWS().find((r) => r.ym === '2027-02').dates))));
    chk('專屬列跟集團一樣 → units 空的', act(w, { svcKey: 'K' }).units, []); }
  { const w = auth(hq({}, {}, withOwn(ownRow('2026-10', '2026-10-09'))));
    chk('專屬列只在開關以前的月份（2026-10）→ 不列（11 月也在開關前）', act(w, { svcKey: 'K' }).units, []); }
  { const w = auth(hq({}, {})); w.sb.__READS = {};
    const r = act(w, { svcKey: 'K' });
    chk('沒有任何專屬列 → units 空的，只讀節日分頁（不讀主檔、門市）', [r.units, Object.keys(w.sb.__READS).sort()], [[], ['holiday']]); }
  { const w = auth(world([{ id: 'E01', ft: true }, P()], { store: 'MZTHQ', pub: 'hq', holiday: withOwn(ownRow('2027-02', '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09', 'MZTHQ')) }));
    const u = act(w, { svcKey: 'K' }).units;
    chk('MZTHQ 專屬列 → unit MZTHQ、sched mzthq（班表在總部 hq，營運系統照工號＋姓名找）、pt 只有計時（正職 E01 不列）', u.map((x) => [x.unit, x.sched, x.pt]), [['MZTHQ', 'mzthq', [{ id: 'P01', name: '測試乙' }]]]); }
  { const ppl = [{ id: 'E01', ft: true, cells: G(['2027-02-15']), hours: { '2027-02-08': 8, '2027-02-10': 8 } }, P(...c1)];
    const x = both(ppl, '2027-02', { store: 'HQ', pub: 'hq', holiday: O1 });
    chk('O5 正職（含 HQ 專屬列）：結果與明細跟基準逐欄相同', sameFt(x, ['E01']), true); }
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
