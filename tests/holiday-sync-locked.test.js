/* 薪酬挑錯第 1 項補洞：紅字天數「開頁自動同步」（payHolidaySync）遇到已鎖定月份不動。
 *
 * 洞：第 1 項擋的是 handlePayrollHolidaySet（手動整批覆寫）；薪資頁實際在用的寫入是開頁自動同步
 *     payroll_holiday_sync → payHolidaySync（計算前沒有紅字天數時也會呼叫），沒有鎖定檢查。
 * 規則（2026-11-11 補洞）：
 *   同步只動集團共用列。某個月份只要有任何「使用集團共用列的門市」（該月沒有專屬列的門市）已鎖定，
 *   同步就不動那個月的列（不改、不補），並在回傳裡列出（skipped_locked、message）；其他月份照舊。
 *   已鎖定的門市那個月有自己的專屬列 → 不吃共用列，不算。那個月的列本來就跟行事曆一樣 → 沒有要動，不列。
 *
 * 行事曆用程式產生（週末＋115 年公布的節日與補假，同 holiday-sync.test.js），不連網。
 * 期望值手算寫死：2026 逐月放假天數 9 月 10、10 月 11、11 月 9、12 月 9；
 *   雙薪日 9 月＝9/25、9/28；10 月＝10/9（國慶補假）、10/26（光復節補假）；12 月＝12/25。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

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
function makeCtx(holiday, run, nowYm) {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-09-18T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__DB = { holiday: (holiday || []).map(r => Object.assign({}, r)), run: (run || []).map(r => Object.assign({}, r)), audit: [] };
  sb.__N = { replace: 0 };
  sb.__CALS = { 2026: cal2026() };
  sb.__NOW = nowYm || '2026-09';
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    currentYmTaipei = function(){ return globalThis.__NOW; };
    nowTaipeiIso = function(){ return '2026-09-18T12:00:00+08:00'; };
    payRead = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll = function(kind, rows){ globalThis.__N.replace++; globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(rows); };
    payInvalidate = function(){};
    payGovCalendar = function(y){ return globalThis.__CALS[Number(y)]
      || { ok: false, error: 'not_published', message: '人事行政總處還沒公布 ' + y + ' 年' }; };
  `, sb);
  const hol = () => sb.__DB.holiday;
  const get = (ym, st) => hol().find(r => r.ym === ym && String(r.store || '') === (st || ''));
  const sync = (body) => JSON.parse(JSON.stringify(vm.runInContext('handlePayrollHolidaySync', sb)(Object.assign({ years: [2026], store: 'SSLGF' }, body || {}))));
  return { sb, hol, get, sync };
}
// 5～9 月集團共用列、日期全空（同 holiday-sync.test.js 的正式環境現況）
const PROD = [['2026-05', 11], ['2026-06', 9], ['2026-07', 8], ['2026-08', 10], ['2026-09', 10]]
  .map(([ym, d]) => ({ ym, red_days: d, note: '', dates: '', store: '' }));
const RUN = (ym, store, status) => ({ ym, emp_id: 'E01', name: '代號甲', store, status, gross: 0, deduction: 0, net: 0 });
const rowOf = r => (r ? [r.red_days, r.dates] : null);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

console.log('══ 0) 對照組：沒有任何門市鎖定 → 照舊同步 ══');
{
  const c = makeCtx(PROD, [RUN('2026-10', 'SSLGF', 'draft')]);
  const r = c.sync();
  chk('  有變動的月份', r.changed, ['2026-09', '2026-10', '2026-11', '2026-12']);
  chk('  10 月補上：11 天、10/9、10/26', rowOf(c.get('2026-10')), [11, '2026-10-09, 2026-10-26']);
  chk('  沒有跳過的月份、沒有說明', [r.skipped_locked, r.message || ''], [[], '']);
}

console.log('\n══ 1) 光復 10 月已鎖定、集團共用列還沒有 10 月 → 不補 10 月，其他月份照舊 ══');
{
  const c = makeCtx(PROD, [RUN('2026-10', 'SSLGF', 'final'), RUN('2026-10', 'CF', 'draft'), RUN('2026-09', 'SSLGF', 'draft')]);
  const r = c.sync();
  chk('  有變動的月份（沒有 10 月）', r.changed, ['2026-09', '2026-11', '2026-12']);
  chk('  10 月沒有被建出來', c.get('2026-10') === undefined, true);
  chk('  9、11、12 月照舊同步', ['2026-09', '2026-11', '2026-12'].map(k => rowOf(c.get(k))), [[10, '2026-09-25, 2026-09-28'], [9, ''], [9, '2026-12-25']]);
  chk('  回傳列出跳過的月份', r.skipped_locked, ['2026-10']);
  chk('  回傳的說明', r.message, '2026-10 已有門市鎖定，這次沒有同步紅字天數（要更新請先解鎖）');
  chk('  稽核紀錄只寫真的有動的月份', c.sb.__DB.audit.map(a => a.reason), ['依人事行政總處辦公日曆表更新紅字天數：2026-09、2026-11、2026-12']);
  chk('  回傳的清單沒有 10 月', r.holidays.map(h => h.ym), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-11', '2026-12']);
}

console.log('\n══ 2) 已有 10 月共用列（手填 8 天、沒有日期）、光復 10 月已鎖定 → 那一列原封不動 ══');
{
  const seed = PROD.concat([{ ym: '2026-10', red_days: 8, note: '手填', dates: '', store: '' }]);
  const c = makeCtx(seed, [RUN('2026-10', 'SSLGF', 'final')]);
  const r = c.sync();
  chk('  10 月維持 8 天、沒有日期、備註沒變', [c.get('2026-10').red_days, c.get('2026-10').dates, c.get('2026-10').note], [8, '', '手填']);
  chk('  有變動的月份（沒有 10 月）、跳過 10 月', [r.changed, r.skipped_locked], [['2026-09', '2026-11', '2026-12'], ['2026-10']]);
}

console.log('\n══ 3) 不帶門市代碼的月結列＝預設店光復，也算 ══');
{
  const c = makeCtx(PROD, [RUN('2026-10', '', 'final')]);
  const r = c.sync();
  chk('  跳過 10 月', [r.skipped_locked, c.get('2026-10') === undefined], [['2026-10'], true]);
}

console.log('\n══ 4) 已鎖定的門市那個月有自己的專屬列 → 不吃共用列，共用列照樣同步 ══');
{
  const seed = PROD.concat([{ ym: '2026-10', red_days: 12, note: '', dates: '2026-10-09', store: 'CF' }]);
  const c = makeCtx(seed, [RUN('2026-10', 'CF', 'final'), RUN('2026-10', 'SSLGF', 'draft')]);
  const r = c.sync();
  chk('  共用列 10 月照樣補上', rowOf(c.get('2026-10')), [11, '2026-10-09, 2026-10-26']);
  chk('  央廚專屬列原樣', rowOf(c.get('2026-10', 'CF')), [12, '2026-10-09']);
  chk('  沒有跳過', [r.changed, r.skipped_locked], [['2026-09', '2026-10', '2026-11', '2026-12'], []]);
  // 同一個月：央廚（有專屬列）鎖定＋光復（吃共用列）也鎖定 → 跳過
  const c2 = makeCtx(seed, [RUN('2026-10', 'CF', 'final'), RUN('2026-10', 'SSLGF', 'final')]);
  const r2 = c2.sync();
  chk('  央廚（專屬列）與光復（共用列）都鎖定 → 跳過 10 月', [r2.skipped_locked, c2.get('2026-10') === undefined], [['2026-10'], true]);
}

console.log('\n══ 5) 本月（9 月）已鎖定 → 9 月不補日期；兩個月都鎖定 → 兩個月都列出 ══');
{
  const c = makeCtx(PROD, [RUN('2026-09', 'SSLGF', 'final')]);
  const r = c.sync();
  chk('  9 月維持 10 天、沒有日期', rowOf(c.get('2026-09')), [10, '']);
  chk('  其他月份照補、跳過 9 月', [r.changed, r.skipped_locked], [['2026-10', '2026-11', '2026-12'], ['2026-09']]);
  const c2 = makeCtx(PROD, [RUN('2026-09', 'SSLGF', 'final'), RUN('2026-10', 'MZTJS', 'final')]);
  const r2 = c2.sync();
  chk('  光復 9 月、金山 10 月都鎖定：跳過兩個月', [r2.changed, r2.skipped_locked], [['2026-11', '2026-12'], ['2026-09', '2026-10']]);
  chk('  說明列出兩個月', r2.message, '2026-09、2026-10 已有門市鎖定，這次沒有同步紅字天數（要更新請先解鎖）');
}

console.log('\n══ 6) 要動的月份全部鎖定 → 不寫試算表、不寫稽核 ══');
{
  const seed = PROD.concat([{ ym: '2026-10', red_days: 11, note: '', dates: '2026-10-09, 2026-10-26', store: '' },
    { ym: '2026-11', red_days: 9, note: '', dates: '', store: '' }, { ym: '2026-12', red_days: 9, note: '', dates: '2026-12-25', store: '' }]);
  const c = makeCtx(seed, [RUN('2026-09', 'SSLGF', 'final')]);
  const r = c.sync();
  chk('  沒有變動、跳過 9 月、沒有寫入、沒有稽核', [r.changed, r.skipped_locked, c.sb.__N.replace, c.sb.__DB.audit.length], [[], ['2026-09'], 0, 0]);
}

console.log('\n══ 7) 已鎖定但那個月的列本來就跟行事曆一樣 → 沒有要動，不列在跳過清單 ══');
{
  const seed = PROD.concat([{ ym: '2026-10', red_days: 11, note: '', dates: '2026-10-09, 2026-10-26', store: '' }]);
  const c = makeCtx(seed, [RUN('2026-10', 'SSLGF', 'final')]);
  const r = c.sync();
  chk('  10 月不在跳過清單、其他月份照舊', [r.changed, r.skipped_locked, r.message || ''], [['2026-09', '2026-11', '2026-12'], [], '']);
}

console.log('\n══ 8) 過去月份（已存在）照舊不動，也不列在跳過清單 ══');
{
  const seed = PROD.map(r => Object.assign({}, r)); seed[1].red_days = 7;   // 6 月手填 7
  const c = makeCtx(seed, [RUN('2026-06', 'SSLGF', 'final')]);
  const r = c.sync();
  chk('  6 月維持 7、不列在跳過清單', [c.get('2026-06').red_days, r.skipped_locked], [7, []]);
}

console.log('\n══ 9) 純函式 payHolidaySyncLockedYms_ ══');
{
  const c = makeCtx([], []);
  const fn = (...a) => JSON.parse(JSON.stringify(vm.runInContext('payHolidaySyncLockedYms_', c.sb)(...a)));
  const H = [{ ym: '2026-10', store: 'CF', red_days: 12, dates: '' }];
  chk('  光復 10 月鎖定（吃共用列）', fn(['2026-09', '2026-10'], H, [RUN('2026-10', 'SSLGF', 'final')]), ['2026-10']);
  chk('  央廚 10 月鎖定（有專屬列）不算', fn(['2026-09', '2026-10'], H, [RUN('2026-10', 'CF', 'final')]), []);
  chk('  草稿不算', fn(['2026-10'], H, [RUN('2026-10', 'SSLGF', 'draft')]), []);
  chk('  別的月份鎖定不算', fn(['2026-10'], H, [RUN('2026-11', 'SSLGF', 'final')]), []);
  chk('  回傳由小到大、不重複', fn(['2026-12', '2026-10', '2026-10'], [], [RUN('2026-10', 'SSLGF', 'final'), RUN('2026-12', 'MZTJS', 'final')]), ['2026-10', '2026-12']);
  chk('  空清單', fn([], H, [RUN('2026-10', 'SSLGF', 'final')]), []);
}

console.log('\n══ 10) 薪資頁：同步狀態列顯示後端的說明（文字經 esc）══');
{
  const html = fs.readFileSync(process.env.PAYROLL_HTML || path.join(__dirname, '..', 'payroll.html'), 'utf8');
  const e0 = html.indexOf('const esc=s=>'), e1 = html.indexOf("'&#39;');", e0) + "'&#39;');".length;
  const f0 = html.indexOf('function holSyncHtml('), f1 = f0 < 0 ? -1 : html.indexOf('\n}\n', f0) + 3;
  chk('  找得到 holSyncHtml', f0 > 0, true);
  if (f0 > 0) {
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(html.slice(e0, e1) + '\n' + html.slice(f0, f1) + '\nthis.F=holSyncHtml;', ctx);
    const OK = { year: 2026, ok: true, title: '115年辦公日曆表' };
    chk('  沒有說明：只有行事曆那一行', ctx.F({ status: [OK] }), '✓ 2026 年已依人事行政總處《115年辦公日曆表》自動帶入');
    chk('  有說明：多一行 ⚠', ctx.F({ status: [OK], message: '2026-10 已有門市鎖定，這次沒有同步紅字天數（要更新請先解鎖）' }),
      '✓ 2026 年已依人事行政總處《115年辦公日曆表》自動帶入<br>⚠ 2026-10 已有門市鎖定，這次沒有同步紅字天數（要更新請先解鎖）');
    chk('  說明裡的標籤被跳脫', ctx.F({ status: [], message: '<b>x</b>' }), '⚠ &lt;b&gt;x&lt;/b&gt;');
    chk('  還沒同步過（空物件）：空字串', ctx.F({}), '');
    chk('  未公布的年度那一行照舊', ctx.F({ status: [{ year: 2027, ok: false, error: 'not_published' }] }), '2027 年行事曆人事行政總處還沒公布（每年約 6 月公布下一年）');
  }
  chk('  renderHol 用 holSyncHtml 組狀態列', /st\.innerHTML=holSyncHtml\(HOLSYNC\);/.test(html), true);
}

console.log(fail ? `\n❌ ${fail} 項不對（通過 ${pass}）` : `\n✅ 已鎖定月份的紅字天數同步全部正確 (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
