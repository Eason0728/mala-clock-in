/**
 * 節日表由營運系統發布（2026-11-24，節日表只留一份第 2 個改動）：薪資試算逐字對照。
 *
 * 不可降的標準：薪資計算程式不動、任何一個月任何一個人的試算結果跟主線相同。這支用同一批假資料跑三種：
 *   甲 主線   ＝ 固定基準 64c9b52 的 Payroll.gs（sha1 前綴釘住），薪資頁打開時自己向人事行政總處同步（payroll_holiday_sync）
 *   乙 本分支 ＝ 開關沒設／'gov'／亂填（＝預設），同一個同步流程
 *   丙 本分支 ＝ PAY_HOL_SOURCE=mini，分頁只靠營運系統推送（payroll_holiday_publish），推送內容＝營運系統正本 payrollRows()
 *              （tests/fixtures/hol-publish-v1.json，由 mala-store-ops feat/holiday-master d165474 產生）
 * 人事行政總處原檔用 tests/fixtures/holidays 的真檔（115、116 年，另有 114 年 Big5 更新版給元旦配對用），由假 UrlFetchApp 回應；不連網。
 * 比對：同步回應、payroll_holiday 分頁、稽核、對外連線次數；4 個計薪單位 × 2026-08～2027-03（含沒有國定假日的 8、11 月）
 *       的 payroll_inputs（payCollect 歸集）、payroll_calc 回應、寫進 run／item 的列、payroll_month 回應，逐字相同。
 * 另有兩個反證：推送內容少一天、主線分頁少一天 → 對照要抓得到不同（證明比對真的有比到東西）。
 * 全部虛構門市代碼與同仁。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), crypto = require('crypto');
const { load, ftEmp, ptEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 600) + '\n   應為 ' + w.slice(0, 600)); }
};
const ok = (c, m) => eq(!!c, true, m);
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key', SVC = 'test-hol-svc-key';
const FIX = path.join(__dirname, 'fixtures');

/* ── 固定基準：64c9b52（本分支開出來的 origin/main）。取不到或內容不對直接失敗，不靜悄悄跳過 ── */
const BASE_COMMIT = '64c9b525d6311543ea6e9aaea43f66fcecb9fa7e', BASE_SHA1 = '1622356ce1c5';
let BASE_SRC;
try { BASE_SRC = cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', BASE_COMMIT + ':apps-script/Payroll.gs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { throw new Error('取不到比對基準 ' + BASE_COMMIT.slice(0, 7) + '（淺層複製？請 git fetch --unshallow）：' + String(e.message).split('\n')[0]); }
{
  const sha = crypto.createHash('sha1').update(BASE_SRC).digest('hex');
  if (sha.slice(0, 12) !== BASE_SHA1) throw new Error('比對基準內容不對：sha1 ' + sha.slice(0, 12) + '，應為 ' + BASE_SHA1);
}

/* ── 夾具 ── */
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
eq([sha256(path.join(FIX, 'holidays', '115-202506.csv')), sha256(path.join(FIX, 'holidays', '116-202607.csv')), sha256(path.join(FIX, 'holidays', '114-202510.csv'))],
  ['0edd80d368626eb73caa05b6c33400ec9d87691b46834d03936efb91e6a0f00d', 'e30df188649bf5347db3ec43fa989af2cc8d93d793fbe5c9891601e6cce4acf3', 'b4bd40d4d1f4ffc20cb724a07bf3b7c5c1b32a9100e55dcf216f329af3513ca6'],
  '人事行政總處原檔夾具＝mala-store-ops 那份（sha256 釘住）');
eq(sha256(path.join(FIX, 'hol-publish-v1.json')), 'd26087c7f45b15819dde2943b6fbf60c21128e059a960c71d9e70fbd1ee957da', '推送夾具＝營運系統正本 payrollRows()（sha256 釘住）');
const PUSH = JSON.parse(fs.readFileSync(path.join(FIX, 'hol-publish-v1.json'), 'utf8'));
const DATASET = fs.readFileSync(path.join(FIX, 'holidays', 'dataset-14718.json'), 'utf8');
const CSV_BY_URL = { '202506/a52331bd': '115-202506.csv', '202607/f538b1ff': '116-202607.csv', '202510/b84cb88a': '114-202510.csv' };

const STORES = [
  { code: 'SSLGF', name: '測試光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' },
  { code: 'HQ', name: '測試總部', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'CF', name: '測試央廚', clock_ss_id: 'ck-cf', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'MZTGF', name: '測試墨竹亭', clock_ss_id: 'ck-mgf', emp_prefix: '', active: 'true', support_group: 'mzt' },
];
const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const daysOf = (ym) => { const n = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate(); const a = []; for (let d = 1; d <= n; d++) a.push(ym + '-' + ('0' + d).slice(-2)); return a; };
/** 每家店一位正職、一位計時；每天都有核定（時數依日期變化，國定假日、週末、補假都有人上班） */
function world() {
  const master = [], ck = {};
  STORES.forEach((s, i) => {
    const id = s.clock_ss_id || 'LOCAL';
    master.push(ftEmp({ emp_id: s.code + '-F1', name: '正職' + i, store: s.code, hire_date: '2024-03-01' }));
    master.push(ptEmp({ emp_id: s.code + '-P1', name: '計時' + i, store: s.code, hire_date: '2025-01-10', wage: 196 }));
    const approved = [];
    MONTHS.forEach((ym) => daysOf(ym).forEach((d, k) => {
      const ftH = 8 + (k % 3), ptH = 4 + (k % 5);
      approved.push({ date: d, emp_id: s.code + '-F1', name: '正職' + i, periods: '09:00-' + (9 + ftH) + ':00', approved_hours: ftH, status_text: '', manager_name: '值班主管', entered_at: d + 'T23:00:00+08:00' });
      if (k % 4 !== 3) approved.push({ date: d, emp_id: s.code + '-P1', name: '計時' + i, periods: '10:00-' + (10 + ptH) + ':00', approved_hours: ptH, status_text: '', manager_name: '值班主管', entered_at: d + 'T23:00:00+08:00' });
    }));
    ck[id] = { roster: [], events: [], approved, leave: [], requests: [] };
  });
  // 薪資分頁上線前就有的過去月份（正式環境的樣子：2026-05～08 日期空白，9、10 月照行事曆）
  const pre = [['2026-05', 11, ''], ['2026-06', 9, ''], ['2026-07', 8, ''], ['2026-08', 10, ''],
    ['2026-09', 10, '2026-09-25, 2026-09-28'], ['2026-10', 11, '2026-10-09, 2026-10-26']]
    .map(([ym, d, ds]) => ({ ym, red_days: d, note: '依人事行政總處115年中華民國政府行政機關辦公日曆表', dates: ds, store: '' }));
  const data = { master, store: J(STORES), holiday: pre, config: [], run: [], item: [], input: [], bonus: [], audit: [],
    leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [], xmap: [] };
  return { data, ck };
}

/** 一個薪資後端（vm）。src＝Payroll.gs 原文；props＝指令碼屬性（可寫） */
function env(src, props) {
  const w = world();
  const s = load({ data: J(w.data), clock: {}, today: '2026-11-24', payrollSrc: src });
  s.__CK = J(w.ck); s.__FETCH = []; s.__PROPS = Object.assign({}, props || {}); s.__NOWYM = '2026-11'; s.__PROPW = [];
  s.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(s.__PROPS, k) ? s.__PROPS[k] : null),
    setProperty: (k, v) => { s.__PROPW.push(k); s.__PROPS[k] = String(v); },
    getProperties: () => Object.assign({}, s.__PROPS) }) };
  s.UrlFetchApp = { fetch: (url) => {
    s.__FETCH.push(url);
    if (url === 'https://data.gov.tw/api/v2/rest/dataset/14718') return { getContentText: () => DATASET };
    const k = Object.keys(CSV_BY_URL).find((x) => url.indexOf('dgpa/files/' + x) >= 0);
    if (!k) throw new Error('夾具沒有這個檔：' + url);
    const buf = fs.readFileSync(path.join(FIX, 'holidays', CSV_BY_URL[k]));
    return { getBlob: () => ({ getDataAsString: (enc) => new TextDecoder(/big5/i.test(enc) ? 'big5' : 'utf-8').decode(buf) }) };
  } };
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    currentYmTaipei = function () { return __NOWYM; };
    payClockRead = function (store, sheet) {
      var row = (__DATA.store || []).filter(function (x) { return String(x.code) === String(store); })[0];
      var id = row && row.clock_ss_id ? row.clock_ss_id : 'LOCAL';
      return ((__CK[id] || {})[sheet] || []).map(function (r) { return Object.assign({}, r); });
    };
    paySchedMissingAll_ = function () { return []; }; payUnapprovedAll_ = function () { return []; };
    payCompNegatives = function () { return []; }; payLeaveMismatch_ = function () { return []; };`, s);
  s.post = (fn, body) => J(s.call(fn, Object.assign({ admin_key: KEY }, body)));
  s.setNow = (today, nowYm) => { s.__TODAY = today; s.__NOWYM = nowYm; };
  return s;
}
const HANDLERS = (s) => vm.runInContext('PAYROLL_HANDLERS', s);
const holRows = (s) => J(s.__DATA.holiday).map((r) => ({ ym: String(r.ym), red_days: r.red_days, note: String(r.note || ''), dates: String(r.dates || ''), store: String(r.store || '') }));

/** 一整輪：開頁同步或推送 → 換到 2027-04-15 → 每家店每個月 inputs／calc／month */
function runAll(s, how) {
  const out = { pre: {} };
  if (how === 'sync') out.pre.sync = J(HANDLERS(s).payroll_holiday_sync({ admin_key: KEY, years: [2026, 2027], operator: 'auto (薪資頁開啟)', store: 'SSLGF' }));
  else out.pre.publish = J(HANDLERS(s).payroll_holiday_publish(Object.assign(J(how), { svcKey: SVC })));
  out.pre.hol = holRows(s);
  out.pre.audit = J(s.__DATA.audit);
  out.pre.fetch = s.__FETCH.slice();
  s.setNow('2027-04-15', '2027-04');
  out.calc = {};
  STORES.forEach((st) => MONTHS.forEach((ym) => {
    const k = st.code + ' ' + ym;
    const inputs = s.post('handlePayrollInputs', { ym, store: st.code });
    const calc = s.post('handlePayrollCalc', { ym, store: st.code, inputs: {} });
    const run = J(s.__DATA.run.filter((r) => String(r.ym) === ym && String(r.store) === st.code));
    const item = J(s.__DATA.item.filter((r) => String(r.ym) === ym && String(r.store) === st.code));
    const month = s.post('handlePayrollMonth', { ym, store: st.code });
    out.calc[k] = { inputs, calc, run, item, month };
  }));
  out.master = STORES.map((st) => s.post('handlePayrollMasterGet', { store: st.code }));
  out.auditAfter = J(s.__DATA.audit).filter((a) => a.action !== 'holiday_sync' && a.action !== 'holiday_publish');
  out.fetchAfter = s.__FETCH.length - out.pre.fetch.length;
  return out;
}

console.log('══ 甲 主線（64c9b52）══');
const A = runAll(env(BASE_SRC, {}), 'sync');
ok(A.pre.sync.ok && A.pre.sync.changed.length === 14, '主線同步成功：寫入 2026-11～2027-12（14 個月）');
const hol0702 = A.pre.hol.find((r) => r.ym === '2027-02' && r.store === '');
eq([hol0702.red_days, hol0702.dates], [13, '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10'], '主線分頁 2027-02：紅字 13、加發日含 2/9、2/10 補假（2/6、2/7 週末不在）');
const kHol = A.calc['SSLGF 2027-02'];
ok(kHol.calc.ok, '主線 2027-02 光復試算成功');
const ptRes = (kHol.calc.results || []).find((r) => /-P1$/.test(r.emp_id));
const ptHol = ptRes ? [].concat(ptRes.earn || []).filter((i) => /holiday/.test(i.item_key)).reduce((a, i) => a + i.amount, 0) : 0;
ok(ptHol > 0, '主線 2027-02 計時同仁有國定假日加倍（' + ptHol + ' 元）：對照有比到國定假日');
const ftRes = (kHol.calc.results || []).find((r) => /-F1$/.test(r.emp_id));
const ftHol = ftRes ? [].concat(ftRes.earn || []).filter((i) => i.item_key === 'ot_hol').reduce((a, i) => a + i.amount, 0) : 0;
ok(ftHol > 0, '主線 2027-02 正職有國定假日上班加發（' + ftHol + ' 元）');
eq(MONTHS.filter((ym) => !A.calc['SSLGF ' + ym].calc.ok), [], '主線 8 個月都算得出來（沒有被擋）');

const KEYS = Object.keys(A.calc);
const calcPart = (x) => ({ inputs: x.inputs, calc: x.calc, run: x.run, item: x.item });
function sameAs(B, label, opt) {
  opt = opt || {};
  if (!opt.skipPre) {
    eq(B.pre.sync, A.pre.sync, label + '：同步回應逐字相同');
    eq(B.pre.audit, A.pre.audit, label + '：同步寫的稽核逐字相同');
    eq(B.pre.fetch, A.pre.fetch, label + '：對外連線（網址、次數、順序）相同');
  }
  eq(B.pre.hol, A.pre.hol, label + '：payroll_holiday 分頁逐列相同');
  const diff = KEYS.filter((k) => JSON.stringify(B.calc[k]) !== JSON.stringify(A.calc[k]));
  eq(diff, [], label + `：${KEYS.length} 組（4 單位 × 8 個月）inputs／calc／run／item／month 逐字相同`);
  eq(B.auditAfter, A.auditAfter, label + '：試算期間其他稽核相同');
  const strip = (m) => { const o = Object.assign({}, m); ['hol_source', 'hol_pub', 'hol_message', 'hol_missing', 'names', 'moved', 'double_from'].forEach((k) => { if (opt.skipPre) delete o[k]; }); return o; };
  eq(B.master.map(strip), A.master, label + '：4 單位 payroll_master_get 逐字相同' + (opt.skipPre ? '（扣掉只收推送多帶的版本欄位）' : ''));
  eq(B.fetchAfter, A.fetchAfter, label + '：試算期間對外連線次數相同（' + A.fetchAfter + '）');
}

console.log('\n══ 乙 本分支、開關＝預設 ══');
const BR = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
for (const [nm, props] of [['沒設', {}], ['gov', { PAY_HOL_SOURCE: 'gov' }], ['亂填 minii', { PAY_HOL_SOURCE: 'minii' }], ['空白', { PAY_HOL_SOURCE: '  ' }]]) {
  const s = env(BR, Object.assign({ PAY_HOL_SVC_KEY: SVC }, props));
  sameAs(runAll(s, 'sync'), 'PAY_HOL_SOURCE ' + nm);
  eq(s.__PROPW, [], 'PAY_HOL_SOURCE ' + nm + '：沒有寫任何指令碼屬性');
}

console.log('\n══ 丙 本分支、只收推送（推送＝營運系統正本 payrollRows()）══');
{
  const s = env(BR, { PAY_HOL_SVC_KEY: SVC, PAY_HOL_SOURCE: 'mini' });
  const C = runAll(s, PUSH);
  eq([C.pre.publish.ok, C.pre.publish.added, C.pre.publish.months_new, C.pre.publish.months_changed, C.pre.publish.skipped_past, C.pre.publish.past_missing],
    [true, true, ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12'], [], [], []],
    '推送成功：新增 2026-11～2027-12、過去月份不動（2026-05～10 跟推送內容相同）');
  eq(C.pre.fetch, [], '只收推送：推送時沒有連人事行政總處');
  sameAs(C, '只收推送', { skipPre: true });
  eq(C.fetchAfter, 0, '只收推送：試算期間也沒有對外連線');
  eq(C.pre.audit.map((a) => a.action), ['holiday_publish'], '只收推送：稽核一筆 holiday_publish');
  // 推送後薪資頁打開：不連外、不寫分頁，分頁仍＝主線
  s.setNow('2026-11-24', '2026-11');
  const n = s.__FETCH.length, h = JSON.stringify(holRows(s));
  const r = J(HANDLERS(s).payroll_holiday_sync({ admin_key: KEY, years: [2026], operator: 'auto (薪資頁開啟)', store: 'SSLGF' }));
  eq([r.ok, r.changed, r.hol_source, r.hol_pub && r.hol_pub.version, s.__FETCH.length - n, JSON.stringify(holRows(s)) === h], [true, [], 'mini', '2027-1', 0, true], '只收推送：之後開薪資頁不連外、不寫分頁、回版本 2027-1');
  eq([r.moved['2027-02-06'], r.names['2027-02-09']], ['2027-02-09', '補假'], '只收推送：畫面要的補假對照與節日名稱由推送帶來');
}

console.log('\n══ 反證：比對真的抓得到不同 ══');
{
  const bad = J(PUSH); bad.version = '2027-2';
  bad.rows['2027-02'].dates = '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-10';   // 少 2/9
  const s = env(BR, { PAY_HOL_SVC_KEY: SVC, PAY_HOL_SOURCE: 'mini' });
  const C = runAll(s, bad);
  const diff = KEYS.filter((k) => JSON.stringify(calcPart(C.calc[k])) !== JSON.stringify(calcPart(A.calc[k])));
  eq(diff, STORES.map((st) => st.code + ' 2027-02'), '推送少 2/9 → 只有 4 單位的 2027-02 試算（inputs／calc／run／item）跟主線不同，其他月份相同');
  eq(KEYS.filter((k) => JSON.stringify(C.calc[k].month.holidays) === JSON.stringify(A.calc[k].month.holidays)), [], 'payroll_month 回應帶整份節日清單：每個月的 month 回應都抓得到這一天的差別');
}
{
  const s = env(BASE_SRC, {});
  vm.runInContext('var __o = payHolidayGovRows; payHolidayGovRows = function (c, e) { var r = __o(c, e); if (r.rows["2026-12"]) r.rows["2026-12"].dates = ""; return r; };', s);
  const B = runAll(s, 'sync');
  const diff = KEYS.filter((k) => JSON.stringify(calcPart(B.calc[k])) !== JSON.stringify(calcPart(A.calc[k])));
  eq(diff, STORES.map((st) => st.code + ' 2026-12'), '主線故意拿掉 12/25 → 只有 4 單位的 2026-12 試算跟原本不同');
}

console.log(`\n${fail ? '❌' : '✅'} hol-publish-equiv：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
