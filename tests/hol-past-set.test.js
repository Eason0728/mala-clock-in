/**
 * 整批儲存 payroll_holiday_set（現行做法 gov）不能新增「已經過去的月份」列（Codex 節日表第 2 輪；主管 2026-11-25「甲，也套用」）。
 * 獨立的一條限制（payHolSetPastNew_）：拿掉時連這支測試一起刪。
 * 事實：薪資頁 2026-09-18 起沒有呼叫這支 API（紅字天數表改唯讀），只剩帶管理金鑰直接打 API 與 mock 假後端；
 *       擋掉之後，人工補過去月份只剩直接改試算表 payroll_holiday 分頁。
 * 矩陣：過去缺列（新增）／過去有列（修改，照舊允許、只受鎖定管）／本月缺／未來缺；本店專屬範圍；mini 照舊整批擋；月初邊界。全部虛構資料。
 */
'use strict';
const vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 500) + '\n   應為 ' + w.slice(0, 500)); }
};
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key';
const G = (ym, red, dates, st) => ({ ym, red_days: red, note: 'n', dates: dates || '', store: st || '' });
const PROD = () => [G('2026-05', 11), G('2026-06', 9), G('2026-07', 8), G('2026-08', 10), G('2026-10', 11, '2026-10-09, 2026-10-26'), G('2026-11', 9)];   // 缺 2026-09、2026-12

function env(nowYm, props, hol) {
  const s = load({ data: { holiday: hol || PROD(), run: [], audit: [], master: [], store: [], config: [] }, today: nowYm + '-15' });
  s.__P = Object.assign({}, props || {}); s.__NOWYM = nowYm; s.__W = 0;
  s.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in s.__P ? s.__P[k] : null), setProperty() {} }) };
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)}; currentYmTaipei = function () { return __NOWYM; };
    var __ra = payReplaceAll; payReplaceAll = function (k, rows) { if (k === 'holiday') __W++; return __ra(k, rows); };`, s);
  s.H = vm.runInContext('PAYROLL_HANDLERS', s);
  s.set = (rows, store) => J(s.H.payroll_holiday_set({ admin_key: KEY, holidays: J(rows), store: store || '' }));
  s.hol = () => JSON.stringify(s.__DATA.holiday);
  return s;
}
const MSG = (yms) => '已經過去的月份不能新增紅字天數：' + yms + '（過去月份缺了不補，主管 2026-11-25 定案），整批沒有儲存。要補請資訊部人工到薪資試算表的 payroll_holiday 分頁處理。';

console.log('══ 現行做法（gov），今天 2026-12 ══');
{
  const s = env('2026-12'), b = s.hol();
  const r = s.set(PROD().concat([G('2026-09', 10, '2026-09-25, 2026-09-28')]));
  eq([r.ok, r.error, r.yms, r.message], [false, 'hol_past_add', ['2026-09'], MSG('2026-09')], '過去缺列（新增 2026-09）：整批不存、列出月份');
  eq([s.hol() === b, s.__W], [true, 0], '過去缺列：分頁前後逐字相同、沒有重寫');
}
{
  const s = env('2026-12');
  const r = s.set(PROD().map((x) => (x.ym === '2026-10' ? G('2026-10', 7, '2026-10-09') : x)));
  eq([r.ok, JSON.parse(s.hol()).find((x) => x.ym === '2026-10').red_days], [true, 7], '過去有列（改 2026-10）：照舊允許（只受鎖定管）');
}
{
  const s = env('2026-12');
  const r = s.set(PROD().concat([G('2026-12', 9, '2026-12-25')]));
  eq([r.ok, JSON.parse(s.hol()).some((x) => x.ym === '2026-12')], [true, true], '本月缺（新增 2026-12）：照舊存');
}
{
  const s = env('2026-12');
  const r = s.set(PROD().concat([G('2027-01', 10, '2027-01-01')]));
  eq([r.ok, s.__W], [true, 1], '未來缺（新增 2027-01）：照舊存');
}
{
  const s = env('2026-12'), b = s.hol();
  const r = s.set(PROD().concat([G('2026-09', 10), G('2026-12', 9), G('2025-12', 9)]));
  eq([r.error, r.yms, s.hol() === b], ['hol_past_add', ['2025-12', '2026-09'], true], '過去缺＋本月缺混在一起：整批不存（列出所有過去新增）');
}
{
  // 本店專屬範圍：集團有 2026-10，CF 專屬原本沒有 → 新增 CF 的 2026-10 也算新增過去月份的列
  const s = env('2026-12'), b = s.hol();
  const r = s.set([G('2026-10', 12, '2026-10-09', 'CF')], 'CF');
  eq([r.error, r.yms, s.hol() === b], ['hol_past_add', ['2026-10'], true], '本店專屬：新增過去月份的專屬列也擋');
  const s2 = env('2026-12', {}, PROD().concat([G('2026-10', 12, '2026-10-09', 'CF')]));
  eq(s2.set([G('2026-10', 11, '2026-10-09', 'CF')], 'CF').ok, true, '本店專屬：改既有的過去專屬列照舊允許');
}
{
  // 整批沒帶到既有的過去列 → 照舊會被刪（只受鎖定管；這條限制只擋新增）
  const s = env('2026-12');
  const r = s.set(PROD().filter((x) => x.ym !== '2026-05'));
  eq([r.ok, JSON.parse(s.hol()).some((x) => x.ym === '2026-05')], [true, false], '既有過去列沒帶到：照舊被刪（這條只擋新增，見文件 A-1b）');
}

console.log('\n══ 月初邊界 ══');
{
  const s = env('2026-11', {}, PROD().filter((x) => x.ym !== '2026-11'));
  eq(s.set(PROD()).ok, true, '台北本月 2026-11：新增 2026-11 照舊存');
  const s2 = env('2026-12', {}, PROD().filter((x) => x.ym !== '2026-11'));
  eq([s2.set(PROD()).error], ['hol_past_add'], '台北本月 2026-12：新增 2026-11 擋下');
}

console.log('\n══ 只收推送（mini）：照舊整批擋 ══');
{
  const s = env('2026-12', { PAY_HOL_SOURCE: 'mini' }), b = s.hol();
  eq([s.set(PROD().concat([G('2026-09', 10)])).error, s.hol() === b], ['hol_source_mini', true], 'mini：hol_source_mini、分頁不變');
}

console.log('\n' + (fail ? '❌' : '✅') + ' hol-past-set：' + pass + ' 通過、' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
