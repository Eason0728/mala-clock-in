/* 紅字天數整年自動同步（2026-09-18）
 *
 * Eason：「直接帶入整年度，不用再手動輸入」。紅字天數與國定假日日期改由後端依
 * 人事行政總處「政府行政機關辦公日曆表」自動寫入。這支測試守住四條規則：
 *   1. 過去且已存在的月份不動（多半已發薪，重算會改到已發的錢）
 *   2. 補假／調整放假不算國定假日（那是公務機關另放的那天）
 *   3. 國定假日雙薪 2026-08 才生效，更早的月份不寫日期
 *   4. 只動集團共用列，本店專屬列不碰
 * 另守：未來月份翻開不可以自動試算（會先存一份全是 0 的草稿）。
 * 行事曆用程式產生（週末＋115 年公布的節日與補假），不連網。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

/* 115 年（2026）辦公日曆表：週末＋這些有備註的放假日（2026-09-18 從官方 CSV 抄下） */
const NAMED_2026 = {
  '2026-01-01': '開國紀念日', '2026-02-15': '小年夜', '2026-02-16': '農曆除夕', '2026-02-17': '春節',
  '2026-02-18': '春節', '2026-02-19': '春節', '2026-02-20': '補假', '2026-02-27': '補假',
  '2026-02-28': '和平紀念日', '2026-04-03': '補假', '2026-04-04': '兒童節', '2026-04-05': '清明節',
  '2026-04-06': '補假', '2026-05-01': '勞動節', '2026-06-19': '端午節', '2026-09-25': '中秋節',
  '2026-09-28': '孔子誕辰紀念日/教師節', '2026-10-09': '補假', '2026-10-10': '國慶日',
  '2026-10-25': '臺灣光復暨金門古寧頭大捷紀念日', '2026-10-26': '補假', '2026-12-25': '行憲紀念日',
};
function cal2026() {
  const days = [];
  for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), wd = d.getUTCDay();
    if (wd === 0 || wd === 6 || NAMED_2026[iso]) days.push({ date: iso, week: '日一二三四五六'[wd], note: NAMED_2026[iso] || '' });
  }
  return { ok: true, year: 2026, title: '115年中華民國政府行政機關辦公日曆表', days };
}

function makeCtx(seed, nowYm) {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-09-18T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__DB = { holiday: (seed || []).map(r => Object.assign({}, r)), audit: [] };
  sb.__N = { replace: 0, calc: 0 };
  sb.__CAL = cal2026();
  sb.__NOW = nowYm || '2026-09';
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    currentYmTaipei = function(){ return globalThis.__NOW; };
    nowTaipeiIso = function(){ return '2026-09-18T12:00:00+08:00'; };
    payRead = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll = function(kind, rows){ globalThis.__N.replace++; globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(rows); };
    payInvalidate = function(){};
    payGovCalendar = function(y){ return Number(y) === 2026 ? globalThis.__CAL
      : { ok: false, error: 'not_published', message: '人事行政總處還沒公布 ' + y + ' 年' }; };
  `, sb);
  const hol = () => sb.__DB.holiday;
  const get = (ym, st) => hol().find(r => r.ym === ym && String(r.store || '') === (st || ''));
  return { sb, call: (fn, ...a) => vm.runInContext(fn, sb)(...a), hol, get };
}
// 正式環境 2026-09-18 當下的樣子：5～9 月集團共用列、日期全空
const PROD = [['2026-05', 11], ['2026-06', 9], ['2026-07', 8], ['2026-08', 10], ['2026-09', 10]]
  .map(([ym, d]) => ({ ym, red_days: d, note: '', dates: '', store: '' }));

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

console.log('══ 0) 測試用行事曆本身要對（逐月放假天數＝官方 CSV）══');
{
  const cnt = {}; cal2026().days.forEach(d => { const k = d.date.slice(0, 7); cnt[k] = (cnt[k] || 0) + 1; });
  chk('  2026 逐月紅字天數', Object.keys(cnt).sort().map(k => cnt[k]), [10, 14, 9, 10, 11, 9, 8, 10, 10, 11, 9, 9]);
}

console.log('\n══ 1) 正式環境現況跑一次同步（本月＝2026-09）══');
{
  const ctx = makeCtx(PROD, '2026-09');
  const r = ctx.call('handlePayrollHolidaySync', { years: [2026, 2027], store: 'SSLGF' });
  chk('  回報有變動的月份', r.changed, ['2026-09', '2026-10', '2026-11', '2026-12']);
  chk('  9 月：紅字不變、補上中秋與教師節', [ctx.get('2026-09').red_days, ctx.get('2026-09').dates], [10, '2026-09-25, 2026-09-28']);
  chk('  10 月：國慶與光復節，補假 10/9、10/26 不帶', [ctx.get('2026-10').red_days, ctx.get('2026-10').dates], [11, '2026-10-10, 2026-10-25']);
  chk('  11 月：沒有國定假日', [ctx.get('2026-11').red_days, ctx.get('2026-11').dates], [9, '']);
  chk('  12 月：行憲紀念日', [ctx.get('2026-12').red_days, ctx.get('2026-12').dates], [9, '2026-12-25']);
  chk('  5～8 月原封不動（日期仍空白：5/1、6/19 不回頭補）',
    ['2026-05', '2026-06', '2026-07', '2026-08'].map(k => [ctx.get(k).red_days, ctx.get(k).dates]),
    [[11, ''], [9, ''], [8, ''], [10, '']]);
  chk('  不建 2026-05 以前的月份', ctx.hol().filter(x => x.ym < '2026-05').length, 0);
  chk('  2027 未公布：回報但不報錯', r.status.map(s => [s.year, s.ok, s.error || '']), [[2026, true, ''], [2027, false, 'not_published']]);
  chk('  回傳節日名稱供畫面顯示', r.names['2026-09-25'], '中秋節');
  chk('  留一筆稽核紀錄', ctx.sb.__DB.audit.map(a => a.action), ['holiday_sync']);
  chk('  回傳的清單＝寫入後的 8 列', r.holidays.map(h => h.ym), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']);

  const n = ctx.sb.__N.replace;
  const r2 = ctx.call('handlePayrollHolidaySync', { years: [2026], store: 'SSLGF' });
  chk('  再跑一次：沒有變動、不寫試算表', [r2.changed, ctx.sb.__N.replace - n, ctx.sb.__DB.audit.length], [[], 0, 1]);
}

console.log('\n══ 2) 過去月份就算數字不同也不動；本月與未來會被校正 ══');
{
  const seed = PROD.map(r => Object.assign({}, r));
  seed[1].red_days = 7;          // 6 月（過去）手填錯
  seed[4].red_days = 12;         // 9 月（本月）手填錯
  const ctx = makeCtx(seed, '2026-09');
  ctx.call('handlePayrollHolidaySync', { years: [2026] });
  chk('  6 月維持 7（已發薪的月份不改）', ctx.get('2026-06').red_days, 7);
  chk('  9 月校正回 10', ctx.get('2026-09').red_days, 10);
}

console.log('\n══ 3) 本店專屬列不碰 ══');
{
  const seed = PROD.concat([{ ym: '2026-10', red_days: 12, note: '', dates: '2026-10-09', store: 'CF' }]);
  const ctx = makeCtx(seed, '2026-09');
  ctx.call('handlePayrollHolidaySync', { years: [2026] });
  chk('  央廚專屬 10 月原樣', [ctx.get('2026-10', 'CF').red_days, ctx.get('2026-10', 'CF').dates], [12, '2026-10-09']);
  chk('  集團共用 10 月照樣補上', ctx.get('2026-10').red_days, 11);
}

console.log('\n══ 4) 雙薪生效月份以前不寫日期（假設在 5 月就跑同步）══');
{
  const ctx = makeCtx([], '2026-05');
  ctx.call('handlePayrollHolidaySync', { years: [2026] });
  chk('  5 月有紅字天數、沒有 5/1', [ctx.get('2026-05').red_days, ctx.get('2026-05').dates], [11, '']);
  chk('  6 月沒有 6/19', ctx.get('2026-06').dates, '');
  chk('  9 月有日期', ctx.get('2026-09').dates, '2026-09-25, 2026-09-28');
}

console.log('\n══ 5) 計算時沒有紅字天數 → 先自動同步；該年沒公布才報錯 ══');
{
  const ctx = makeCtx([], '2026-09');
  let r; try { r = ctx.call('handlePayrollCalc', { ym: '2026-09', store: 'SSLGF' }); } catch (e) { r = { threw: true }; }
  chk('  算 9 月前自動補上紅字天數', !!ctx.get('2026-09'), true);
  chk('  沒有回 no_holiday', r && r.error === 'no_holiday', false);
  const r2 = ctx.call('handlePayrollCalc', { ym: '2031-01', store: 'SSLGF' });
  chk('  2031 沒公布 → no_holiday 並說明原因', [r2.error, /還沒公布/.test(r2.message)], ['no_holiday', true]);
}

console.log('\n══ 6) 翻到未來月份不自動試算（本月照舊會）══');
{
  const ctx = makeCtx(PROD, '2026-09');
  ctx.call('handlePayrollHolidaySync', { years: [2026] });
  vm.runInContext(`
    payInputsBase = function(){ return {}; }; payBuildRunResults = function(){ return null; };
    payAnnualInfo = function(){ return {}; }; payHasClock = function(){ return true; };
    handlePayrollCalc = function(b){ globalThis.__N.calc++; return { ok: true, results: [] }; };
  `, ctx.sb);
  ctx.call('handlePayrollMonth', { ym: '2026-10', store: 'SSLGF' });
  chk('  10 月（未來）沒有自動試算', ctx.sb.__N.calc, 0);
  ctx.call('handlePayrollMonth', { ym: '2026-09', store: 'SSLGF' });
  chk('  9 月（本月）照舊自動試算', ctx.sb.__N.calc, 1);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 紅字天數自動同步全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
