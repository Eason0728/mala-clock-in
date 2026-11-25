#!/usr/bin/env node
/**
 * 放行比對（2026-11-25，Codex 第 2 輪擋項：現行做法 gov 也不補過去月份）：
 *   「沒有過去缺列時，新舊版的分頁寫入與回應逐字相同」。
 * 舊＝git 版本（預設 d26637a，Codex 第 2 輪審的那版）的 Payroll.gs；新＝工作目錄的 Payroll.gs。Code.gs、Requests.gs 用工作目錄的（這次沒改）。
 * 世界＝tests/hol-publish-equiv.test.js 同一套：4 個計薪單位（光復、總部、央廚、墨竹亭）各一位正職、一位計時，2026-08～2027-03 每天都有核定；
 *   人事行政總處原檔用 tests/fixtures/holidays 真檔（假 UrlFetchApp 回，不連網）。
 * 情境（都沒有「已經過去而且整月缺列」的月份）× 開關 4 種預設值（沒設、gov、打錯 minii、空白）：
 *   S1 2026-11-24 開薪資頁同步（分頁 2026-05～10）→ 2027-04-15 算 4 單位 × 8 個月
 *   S2 2026-12-01 00:00（台北，月初邊界）開頁同步今年（分頁 2026-05～11 齊）→ 2027-01-02 開頁同步今年 → 2027-04-15 算
 *      （薪資頁 syncHol 只帶今年：每年 1 月第一次開頁補整年；1 月整個月都沒人開頁、算薪，1 月就會變成「已經過去而且缺列」＝不在本比對範圍，見回報）
 *   S3 不開頁：2026-11-24 直接算 2026-11～2027-03（算薪缺列時的同步：本月、未來月）→ 2027-04-15 算其餘
 *   S4 2027-01-05 開頁同步（分頁 2026-05～12 齊、2027 缺＝本月與未來）→ 2027-04-15 算
 * 每個情境比：每一步的回應、payroll_holiday 分頁、稽核、指令碼屬性寫入、對外連線（網址與順序）、run／item 分頁、payroll_master_get。
 * 反證（要不同）：分頁缺已經過去的 2026-09 → 舊版開頁會補、新版不補（證明比對抓得到差別）。
 * 用法：node tools/hol-gov-equiv.js [舊版 git 版本，預設 d26637a]；結束碼 0＝全部相同且反證抓得到。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const { load, ftEmp, ptEmp } = require(path.join(ROOT, 'tests', 'helpers', 'payroll-vm'));
const OLD = process.argv[2] || 'd26637a';
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key';
const FIX = path.join(ROOT, 'tests', 'fixtures');
const DATASET = fs.readFileSync(path.join(FIX, 'holidays', 'dataset-14718.json'), 'utf8');
const CSV_BY_URL = { '202506/a52331bd': '115-202506.csv', '202607/f538b1ff': '116-202607.csv', '202510/b84cb88a': '114-202510.csv' };
const SRC = { old: cp.execFileSync('git', ['-C', ROOT, 'show', OLD + ':apps-script/Payroll.gs'], { encoding: 'utf8', maxBuffer: 64 << 20 }),
  new: fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8') };

const STORES = [
  { code: 'SSLGF', name: '測試光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' },
  { code: 'HQ', name: '測試總部', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'CF', name: '測試央廚', clock_ss_id: 'ck-cf', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'MZTGF', name: '測試墨竹亭', clock_ss_id: 'ck-mgf', emp_prefix: '', active: 'true', support_group: 'mzt' },
];
const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const daysOf = (ym) => { const n = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate(); const a = []; for (let d = 1; d <= n; d++) a.push(ym + '-' + ('0' + d).slice(-2)); return a; };
const N = '依人事行政總處115年中華民國政府行政機關辦公日曆表';
const HIST = { '2026-05': [11, ''], '2026-06': [9, ''], '2026-07': [8, ''], '2026-08': [10, ''], '2026-09': [10, '2026-09-25, 2026-09-28'],
  '2026-10': [11, '2026-10-09, 2026-10-26'], '2026-11': [9, ''], '2026-12': [9, '2026-12-25'] };
function world(histUpTo, drop) {
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
  const pre = Object.keys(HIST).filter((k) => k <= histUpTo && k !== drop).map((k) => ({ ym: k, red_days: HIST[k][0], note: N, dates: HIST[k][1], store: '' }));
  return { data: { master, store: J(STORES), holiday: pre, config: [], run: [], item: [], input: [], bonus: [], audit: [],
    leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [], xmap: [] }, ck };
}
function env(src, props, w) {
  const s = load({ data: J(w.data), clock: {}, today: '2026-11-24', payrollSrc: src });
  s.__CK = J(w.ck); s.__FETCH = []; s.__PROPS = Object.assign({}, props); s.__NOWYM = '2026-11'; s.__PROPW = [];
  s.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(s.__PROPS, k) ? s.__PROPS[k] : null),
    setProperty: (k, v) => { s.__PROPW.push(k); s.__PROPS[k] = String(v); }, getProperties: () => Object.assign({}, s.__PROPS) }) };
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
  s.H = vm.runInContext('PAYROLL_HANDLERS', s);
  s.setNow = (today, nowYm) => { s.__TODAY = today; s.__NOWYM = nowYm; };
  return s;
}
/** 跑一個情境，每一步留快照：[步驟名, 回應, 節日分頁, 稽核, 屬性寫入, 連外, run, item] */
function play(src, props, sc) {
  const s = env(src, props, world(sc.hist, sc.drop)), log = [];
  const snap = (nm, r) => log.push([nm, J(r), J(s.__DATA.holiday), J(s.__DATA.audit), s.__PROPW.slice(), s.__FETCH.slice(), J(s.__DATA.run), J(s.__DATA.item)]);
  const calcAll = (yms) => STORES.forEach((st) => yms.forEach((ym) => {
    snap('inputs ' + st.code + ' ' + ym, s.H.payroll_inputs({ admin_key: KEY, ym, store: st.code }));
    snap('calc ' + st.code + ' ' + ym, s.H.payroll_calc({ admin_key: KEY, ym, store: st.code, inputs: {} }));
    snap('month ' + st.code + ' ' + ym, s.H.payroll_month({ admin_key: KEY, ym, store: st.code }));
  }));
  s.setNow(sc.at[0], sc.at[1]);
  if (sc.sync) snap('開頁同步 ' + sc.at[1], s.H.payroll_holiday_sync({ admin_key: KEY, years: sc.sync, operator: 'auto (薪資頁開啟)', store: 'SSLGF' }));
  if (sc.then) { s.setNow(sc.then.at[0], sc.then.at[1]); snap('開頁同步 ' + sc.then.at[1], s.H.payroll_holiday_sync({ admin_key: KEY, years: sc.then.sync, operator: 'auto (薪資頁開啟)', store: 'SSLGF' })); }
  if (sc.calcFirst) calcAll(sc.calcFirst);
  s.setNow('2027-04-15', '2027-04');
  calcAll(MONTHS.filter((m) => !(sc.calcFirst || []).includes(m)));
  STORES.forEach((st) => snap('master_get ' + st.code, s.H.payroll_master_get({ admin_key: KEY, store: st.code })));
  return log;
}
const SCEN = [
  { id: 'S1', note: '2026-11-24 開頁同步（分頁 2026-05～10）', hist: '2026-10', at: ['2026-11-24', '2026-11'], sync: [2026, 2027] },
  { id: 'S2', note: '2026-12-01 00:00 月初開頁同步今年（分頁 2026-05～11 齊）→ 2027-01-02 開頁同步今年（薪資頁只帶今年，照正式做法）', hist: '2026-11', at: ['2026-12-01', '2026-12'], sync: [2026],
    then: { at: ['2027-01-02', '2027-01'], sync: [2027] } },
  { id: 'S3', note: '不開頁、2026-11-24 直接算 2026-11～2027-03（算薪缺列時同步本月與未來）', hist: '2026-10', at: ['2026-11-24', '2026-11'], calcFirst: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'] },
  { id: 'S4', note: '2027-01-05 開頁同步（分頁 2026-05～12 齊、2027 缺）', hist: '2026-12', at: ['2027-01-05', '2027-01'], sync: [2027] },
];
const PROPS = [['沒設', {}], ['gov', { PAY_HOL_SOURCE: 'gov' }], ['打錯 minii', { PAY_HOL_SOURCE: 'minii' }], ['空白', { PAY_HOL_SOURCE: '  ' }]];
let bad = 0, total = 0;
console.log('舊＝' + OLD + '，新＝工作目錄');
for (const sc of SCEN) for (const [pn, props] of PROPS) {
  const a = play(SRC.old, props, sc), b = play(SRC.new, props, sc);
  let diff = 0;
  a.forEach((x, i) => { total++; if (JSON.stringify(x) !== JSON.stringify(b[i])) { diff++; if (diff <= 3) console.log('   ✗ ' + sc.id + '／' + pn + '：' + x[0] + ' 不同'); } });
  if (a.length !== b.length) diff++;
  bad += diff;
  const okCalc = a.filter((x) => /^calc /.test(x[0]) && x[1].ok).length, nCalc = a.filter((x) => /^calc /.test(x[0])).length;
  console.log((diff ? '✗ ' : '✓ ') + sc.id + '｜' + pn + '｜' + sc.note + '：' + a.length + ' 步逐字相同' + (diff ? '？不同 ' + diff : '') + '（試算成功 ' + okCalc + '/' + nCalc + '）');
}
// 反證：已經過去的 2026-09 缺列 → 舊版開頁會補、新版不補
const neg = { id: 'N1', hist: '2026-10', drop: '2026-09', at: ['2026-11-24', '2026-11'], sync: [2026, 2027] };
const na = play(SRC.old, {}, neg), nb = play(SRC.new, {}, neg);
const has09 = (log) => log[0][2].some((r) => r.ym === '2026-09');
const negOk = has09(na) && !has09(nb) && JSON.stringify(na) !== JSON.stringify(nb);
console.log((negOk ? '✓' : '✗') + ' 反證 N1（缺已經過去的 2026-09）：舊版開頁補了 2026-09＝' + has09(na) + '、新版沒補＝' + !has09(nb) + '（比對抓得到差別）');
console.log('\n' + (bad || !negOk ? '✗ 有不同：' + bad : '✓ 沒有過去缺列時，' + SCEN.length + ' 情境 × ' + PROPS.length + ' 種開關值、共 ' + total + ' 步：回應、分頁、稽核、屬性、連外、run／item 逐字相同'));
process.exit(bad || !negOk ? 1 : 0);
