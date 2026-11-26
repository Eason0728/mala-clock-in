/**
 * 已經過去的月份缺列不補——現行做法（gov）也套用（主管 2026-11-25：「甲，也套用」「甲，照現有算法」；Codex 節日表第 2 輪擋項）。
 * 「已經過去」＝月份 < 台北時間本月（currentYmTaipei）。開頁同步、算薪缺列時的同步、退回 gov 後的同步共用 payHolidaySync 同一個判斷。
 * 矩陣：gov／mini × 開頁同步（payroll_holiday_sync）／算薪（payroll_calc）× 過去缺列／過去有列（跟行事曆不同）／本月缺／未來缺；
 *       零寫入的情境比 payroll_holiday 分頁前後逐字相同、沒有稽核、沒有整張重寫。
 * 月初邊界：用真的 currentYmTaipei（Utilities.formatDate 照格式、時區 +8），時鐘停在台北 11/30 23:59:59 與 12/01 00:00:00。
 * 人事行政總處原檔用 tests/fixtures/holidays 真檔（假 UrlFetchApp 回，不連網）。全部虛構資料。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 500) + '\n   應為 ' + w.slice(0, 500)); }
};
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key';
const FIX = path.join(__dirname, 'fixtures');
const DATASET = fs.readFileSync(path.join(FIX, 'holidays', 'dataset-14718.json'), 'utf8');
const CSV_BY_URL = { '202506/a52331bd': '115-202506.csv', '202607/f538b1ff': '116-202607.csv', '202510/b84cb88a': '114-202510.csv' };
const N = '依人事行政總處115年中華民國政府行政機關辦公日曆表';
const G = (ym, red, dates) => ({ ym, red_days: red, note: N, dates: dates || '', store: '' });
/** 跟人事行政總處 115 年行事曆相同的 2026-05～12 */
const PROD = () => [G('2026-05', 11), G('2026-06', 9), G('2026-07', 8), G('2026-08', 10), G('2026-09', 10, '2026-09-25, 2026-09-28'),
  G('2026-10', 11, '2026-10-09, 2026-10-26'), G('2026-11', 9), G('2026-12', 9, '2026-12-25')];
const PAST_TEXT = (ym) => '薪資計算（' + ym + '）：這個月已經過去、整月沒有節日資料；已經過去的月份系統不會補上紅字天數與國定假日，這次沒有計算。' +
  '要算這個月，請聯絡資訊部人工到薪資試算表的 payroll_holiday 分頁補上這個月（系統外處理）。';

/** opt.now：台北時間 ISO（含 +08:00）；用真的 currentYmTaipei */
function env(opt) {
  const s = load({ data: { holiday: opt.holiday, run: [], audit: [], master: [], store: [], config: [], item: [], input: [], bonus: [] }, today: opt.now.slice(0, 10) });
  s.__PROPS = Object.assign({}, opt.props || {}); s.__FETCH = 0; s.__W = 0; s.__NOW = Date.parse(opt.now);
  s.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (Object.prototype.hasOwnProperty.call(s.__PROPS, k) ? s.__PROPS[k] : null), setProperty: (k, v) => { s.__PROPS[k] = String(v); } }) };
  // 照格式、固定台北 +8 的 formatDate（helpers 的版本不看格式）；currentYmTaipei 用 'yyyy-MM'
  s.Utilities = { formatDate: (d, tz, f) => { const t = new Date(d.getTime() + 8 * 3600000), p = (n) => ('0' + n).slice(-2);
    const ymd = t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
    return f === 'yyyy-MM' ? ymd.slice(0, 7) : ymd; } };
  s.UrlFetchApp = { fetch: (url) => {
    s.__FETCH++;
    if (url === 'https://data.gov.tw/api/v2/rest/dataset/14718') return { getContentText: () => DATASET };
    const k = Object.keys(CSV_BY_URL).find((x) => url.indexOf('dgpa/files/' + x) >= 0);
    if (!k) throw new Error('夾具沒有這個檔：' + url);
    const buf = fs.readFileSync(path.join(FIX, 'holidays', CSV_BY_URL[k]));
    return { getBlob: () => ({ getDataAsString: (enc) => new TextDecoder(/big5/i.test(enc) ? 'big5' : 'utf-8').decode(buf) }) };
  } };
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    Date = (function (D) { function F() { if (!(this instanceof F)) return new D(__NOW).toString(); return arguments.length ? new (Function.prototype.bind.apply(D, [null].concat([].slice.call(arguments))))() : new D(__NOW); }
      F.prototype = D.prototype; F.now = function () { return __NOW; }; F.UTC = D.UTC; F.parse = D.parse; return F; })(Date);
    var __ra = payReplaceAll; payReplaceAll = function (k, rows) { if (k === 'holiday') __W++; return __ra(k, rows); };
    paySchedMissingAll_ = function () { return []; }; payUnapprovedAll_ = function () { return []; };
    payCompNegatives = function () { return []; }; payLeaveMismatch_ = function () { return []; };`, s);
  s.H = vm.runInContext('PAYROLL_HANDLERS', s);
  s.ymNow = () => vm.runInContext('currentYmTaipei()', s);
  s.hol = () => JSON.stringify(s.__DATA.holiday);
  s.row = (ym) => J(s.__DATA.holiday).find((r) => String(r.ym) === ym && String(r.store || '') === '');
  s.sync = (years) => J(s.H.payroll_holiday_sync({ admin_key: KEY, years, store: 'SSLGF', operator: 'auto (薪資頁開啟)' }));
  s.calc = (ym) => J(s.H.payroll_calc({ admin_key: KEY, ym, store: 'SSLGF', inputs: {} }));
  return s;
}
const GOV = {}, MINI = { PAY_HOL_SOURCE: 'mini' };
/** 零寫入：分頁逐字相同、沒有整張重寫、沒有稽核 */
const zero = (s, before, m) => eq([s.hol() === before, s.__W, s.__DATA.audit.length], [true, 0, 0], m + '：節日分頁前後逐字相同、沒有重寫、沒有稽核');

console.log('══ 0) 時鐘：真的 currentYmTaipei ══');
eq([env({ holiday: [], now: '2026-11-30T23:59:59+08:00' }).ymNow(), env({ holiday: [], now: '2026-12-01T00:00:00+08:00' }).ymNow()], ['2026-11', '2026-12'], '台北 11/30 23:59:59＝2026-11；12/01 00:00＝2026-12（UTC 11/30 16:00）');

console.log('\n══ 1) gov 開頁同步（今天台北 2026-12-15）══');
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-09'), now: '2026-12-15T10:00:00+08:00', props: GOV }), b = s.hol();
  const r = s.sync([2026]);
  eq([r.ok, r.changed, r.past_missing, !!s.row('2026-09')], [true, [], ['2026-09'], false], '過去缺列（2026-09）：不補、回 past_missing');
  eq(r.message, '2026-09 已經過去、整月沒有節日資料，系統不會補上（不能計算薪資）；要算請聯絡資訊部人工到薪資試算表的 payroll_holiday 分頁補上', '過去缺列：畫面那一行的說明');
  zero(s, b, '過去缺列');
}
{
  const s = env({ holiday: PROD().map((r) => (r.ym === '2026-10' ? G('2026-10', 7, '2026-10-09, 2026-10-26') : r)), now: '2026-12-15T10:00:00+08:00', props: GOV }), b = s.hol();
  const r = s.sync([2026]);
  eq([r.changed, 'past_missing' in r, s.row('2026-10').red_days, r.message], [[], false, 7, ''], '過去有列、跟行事曆不同（2026-10 紅字 7）：不動（照舊）、沒有 past_missing、說明空白');
  zero(s, b, '過去有列');
}
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-12'), now: '2026-12-15T10:00:00+08:00', props: GOV });
  const r = s.sync([2026]);
  eq([r.changed, s.row('2026-12').dates, 'past_missing' in r, s.__DATA.audit.length], [['2026-12'], '2026-12-25', false, 1], '本月缺（2026-12）：照舊補上、記稽核');
}
{
  const s = env({ holiday: PROD(), now: '2026-12-15T10:00:00+08:00', props: GOV });
  const r = s.sync([2027]);
  eq([r.changed.length, r.changed[0], s.row('2027-02').red_days, 'past_missing' in r], [12, '2027-01', 13, false], '未來缺（2027 整年）：照舊補上 12 個月');
}
{
  // 過去缺＋本月缺同時：本月照補、過去不補，稽核只列本月
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-09' && r.ym !== '2026-12'), now: '2026-12-15T10:00:00+08:00', props: GOV });
  const r = s.sync([2026]);
  eq([r.changed, r.past_missing, !!s.row('2026-09'), !!s.row('2026-12'), /2026-12/.test(s.__DATA.audit[0].reason), /2026-09/.test(s.__DATA.audit[0].reason)],
    [['2026-12'], ['2026-09'], false, true, true, false], '過去缺＋本月缺：只補本月，稽核也只寫本月');
}

console.log('\n══ 2) gov 算薪（今天台北 2026-12-15）══');
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-09'), now: '2026-12-15T10:00:00+08:00', props: GOV }), b = s.hol();
  const c = s.calc('2026-09');
  eq([c.ok, c.error, c.hol_past, c.hol_source, c.message, s.__FETCH], [false, 'no_holiday', true, undefined, PAST_TEXT('2026-09'), 0], '過去缺列：不同步、直接擋下（跟只收推送同一句）、不連外');
  zero(s, b, '算過去缺列');
  eq([s.calc('2026-10').ok, s.calc('2026-12').ok], [true, true], '同一份分頁：其他月份照常算得出來');
}
{
  const s = env({ holiday: PROD().map((r) => (r.ym === '2026-10' ? G('2026-10', 7, '2026-10-09, 2026-10-26') : r)), now: '2026-12-15T10:00:00+08:00', props: GOV }), b = s.hol();
  const c = s.calc('2026-10');
  eq([c.ok, s.__FETCH], [true, 0], '過去有列（跟行事曆不同）：照分頁算、不同步');
  eq(s.hol() === b, true, '過去有列：分頁不變');
}
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-12'), now: '2026-12-15T10:00:00+08:00', props: GOV });
  const c = s.calc('2026-12');
  eq([c.ok, s.row('2026-12').dates, s.__FETCH > 0], [true, '2026-12-25', true], '本月缺：照舊先同步補上再算');
}
{
  const s = env({ holiday: PROD(), now: '2026-12-15T10:00:00+08:00', props: GOV });
  const c = s.calc('2027-02');
  eq([c.ok, s.row('2027-02').red_days, s.__FETCH > 0], [true, 13, true], '未來缺（2027-02）：照舊先同步那一年再算');
}

console.log('\n══ 3) mini（只收推送）：開頁同步與算薪都不寫 ══');
for (const [nm, hol, ym] of [['過去缺列', PROD().filter((r) => r.ym !== '2026-09'), '2026-09'], ['過去有列', PROD(), '2026-10'], ['本月缺', PROD().filter((r) => r.ym !== '2026-12'), '2026-12'], ['未來缺', PROD(), '2027-02']]) {
  const s = env({ holiday: hol, now: '2026-12-15T10:00:00+08:00', props: MINI }), b = s.hol();
  const r = s.sync([2026, 2027]);
  eq([r.ok, r.hol_source, r.changed, s.__FETCH], [true, 'mini', [], 0], 'mini 開頁同步（' + nm + '）：不連外、不寫');
  const c = s.calc(ym);
  if (nm === '過去缺列') eq([c.error, c.hol_past, c.hol_source, c.message], ['no_holiday', true, 'mini', PAST_TEXT('2026-09')], 'mini 算過去缺列：擋下、同一句');
  else if (nm === '過去有列') eq(c.ok, true, 'mini 算過去有列：照分頁算');
  else eq([c.error, c.hol_past, /請先到營運系統確認並發布/.test(c.message)], ['no_holiday', undefined, true], 'mini 算' + nm + '：擋下、請營運系統發布');
  zero(s, b, 'mini ' + nm);
}

console.log('\n══ 4) 月初邊界（gov，分頁缺 2026-11）══');
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-11'), now: '2026-11-30T23:59:59+08:00', props: GOV });
  const r = s.sync([2026]);
  eq([r.changed, !!s.row('2026-11'), 'past_missing' in r], [['2026-11'], true, false], '台北 11/30 23:59:59：2026-11 還是本月 → 開頁照舊補上');
}
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-11'), now: '2026-11-30T23:59:59+08:00', props: GOV });
  eq([s.calc('2026-11').ok, !!s.row('2026-11')], [true, true], '台北 11/30 23:59:59：算 2026-11 照舊先同步補上再算');
}
{
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-11'), now: '2026-12-01T00:00:00+08:00', props: GOV }), b = s.hol();
  const r = s.sync([2026]);
  eq([r.changed, r.past_missing, !!s.row('2026-11')], [[], ['2026-11'], false], '台北 12/01 00:00:00：2026-11 已經過去 → 開頁不補');
  const c = s.calc('2026-11');
  eq([c.error, c.hol_past, c.message], ['no_holiday', true, PAST_TEXT('2026-11')], '台北 12/01 00:00:00：算 2026-11 擋下（12/1～12/10 結算 11 月也一樣）');
  zero(s, b, '月初 00:00 過去缺列');
}
{
  // 主管：要人工在節日表補上才能算薪 → 人工補上那一列（直接改分頁）後照常算
  const s = env({ holiday: PROD().filter((r) => r.ym !== '2026-11'), now: '2026-12-01T00:00:00+08:00', props: GOV });
  s.__DATA.holiday.push(G('2026-11', 9));
  eq(s.calc('2026-11').ok, true, '人工在分頁補上 2026-11 之後：照常算');
}

console.log('\n' + (fail ? '❌' : '✅') + ' hol-past-gov：' + pass + ' 通過、' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
