/**
 * 節日表推送：試推與所有唯讀動作在「分頁不存在」時零寫入（獨立審查第 1 輪擋項 1，2026-11-25）。
 * 問題：試推先呼叫 payRead() → paySheet()，分頁不存在時會建分頁、寫表頭、凍結首列，之後才走到試推的提前返回。
 *       開關照舊（PAY_HOL_SOURCE=gov）時也收試推 → 開關關著時行為跟改動前不同、而且「試推」有寫入。
 * 這支用真的 Code.gs＋Payroll.gs＋Requests.gs（payRead／paySheet 都不換），試算表換成 helpers/sheets-like.js 的假試算表，
 * 把試算表、分頁、格子所有會寫的方法都包一層計數：唯讀路徑一律要「沒有新增分頁、沒有任何 setValue(s)／appendRow／setFrozenRows…」、
 * 指令碼屬性沒有寫、分頁內容前後逐格相同。對照組：只收推送時正式推送（會寫）在同樣情境下計數不是 0，證明計數抓得到寫入。
 * 全部虛構門市與資料。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createSpreadsheet, Spreadsheet, Sheet, Range } = require('./helpers/sheets-like');

const ROOT = path.join(__dirname, '..', 'apps-script');
const SRC = ['Code.gs', 'Payroll.gs', 'Requests.gs'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const PUSH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hol-publish-v1.json'), 'utf8'));
delete PUSH._note;
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key', SVC = 'test-hol-svc-key';

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 400) + '\n   應為 ' + w.slice(0, 400)); }
};

/* ── 寫入計數：試算表／分頁／格子所有會改東西的方法 ── */
const W = { n: 0, calls: [] };
const MUT = [
  [Spreadsheet.prototype, ['insertSheet', 'deleteSheet']],
  [Sheet.prototype, ['setName', 'setFrozenRows', 'setColumnWidth', 'autoResizeColumn', 'appendRow', 'deleteRow', 'deleteRows', 'insertRowAfter',
    'insertRowsAfter', 'insertRows', 'insertColumnAfter', 'insertColumnsAfter', 'clear', 'clearContents']],
  [Range.prototype, ['setValues', 'setValue', 'setNumberFormat', 'setNumberFormats', 'clearContent', 'clear', 'setFontWeight', 'setFontSize']],
];
let SPY_ON = false;
MUT.forEach(([proto, names]) => names.forEach((nm) => {
  const orig = proto[nm];
  if (typeof orig !== 'function') return;
  proto[nm] = function () { if (SPY_ON) { W.n++; W.calls.push(nm); } return orig.apply(this, arguments); };
}));

const G = (ym, red, dates) => [ym, red, '依人事行政總處115年中華民國政府行政機關辦公日曆表', dates || '', ''];
const PROD = [G('2026-05', 11), G('2026-06', 9), G('2026-07', 8), G('2026-08', 10), G('2026-09', 10, '2026-09-25, 2026-09-28'),
  G('2026-10', 11, '2026-10-09, 2026-10-26'), G('2026-11', 9), G('2026-12', 9, '2026-12-25')];

/** opt.sheets：{kind: rows（陣列的陣列，不含表頭）}；沒列的 kind＝分頁不存在。opt.props：指令碼屬性。 */
function world(opt) {
  opt = opt || {};
  const props = Object.assign({ PAY_HOL_SVC_KEY: SVC }, opt.props || {}), propW = [];
  const sb = {
    console: { log() {}, error() {}, warn() {} }, Logger: { log() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { propW.push(k); props[k] = String(v); } }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) },
    UrlFetchApp: { fetch: () => { throw new Error('測試不連網'); } },
  };
  sb.SpreadsheetApp = { flush() {} };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'gs' });
  const ss = createSpreadsheet({ DateCtor: vm.runInContext('Date', sb), defaultMaxCols: 40 });
  sb.SpreadsheetApp.getActive = () => ss; sb.SpreadsheetApp.openById = () => ss;
  sb.__SS = ss;
  vm.runInContext(`getSS = function () { return __SS; }; CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    currentYmTaipei = function () { return '2026-11'; }; nowTaipeiIso = function () { return '2026-11-25T09:00:00+08:00'; };`, sb);
  const NAME = vm.runInContext('PAY_SHEET_NAME', sb), COLS = vm.runInContext('PAY_SHEETS', sb);
  Object.keys(opt.sheets || {}).forEach((k) => ss.seed(NAME[k], [COLS[k]].concat(opt.sheets[k]), true));
  const H = vm.runInContext('PAYROLL_HANDLERS', sb);
  const snap = () => JSON.stringify(ss.getSheets().map((s) => [s.getName(), s.getDataRange().getValues()]));
  return { sb, ss, H, props, propW, NAME, snap, hash: (body) => vm.runInContext('payHolPubValidate_', sb)(body, '2026-11').hash };
}
const push = (over) => Object.assign(J(PUSH), { svcKey: SVC, confirmed_by: '人資主管' }, over || {});
/** 跑一次唯讀動作：回 [回應, 寫入次數, 寫了哪些方法, 新增分頁數, 屬性寫入, 內容前後相同] */
function ro(w, fn) {
  const sheets0 = w.ss.getSheets().length, s0 = w.snap(), p0 = w.propW.length;
  W.n = 0; W.calls = []; SPY_ON = true;
  let r;
  try { r = J(fn()); } finally { SPY_ON = false; }
  return { r, writes: W.n, calls: W.calls.slice(), newSheets: w.ss.getSheets().length - sheets0, propW: w.propW.length - p0, same: w.snap() === s0 };
}
const ZERO = (x) => [x.writes, x.newSheets, x.propW, x.same];

console.log('══ 1) 開關照舊（gov）試推：分頁都不存在 ══');
{
  const w = world({ sheets: {} });
  const x = ro(w, () => w.H.payroll_holiday_publish(push({ dry_run: true })));
  eq([x.r.ok, x.r.mode, x.r.dry_run, x.r.would_change.length, x.r.past_missing.length], [true, 'gov', true, 14, 6], '照樣算出預覽：本月起 14 個月會新增、過去 6 個月缺列');
  eq(ZERO(x), [0, 0, 0, true], '零寫入：沒有新增分頁、沒有寫格子、沒有寫屬性、內容相同');
  eq([w.ss.getSheetByName(w.NAME.holiday), w.ss.getSheetByName(w.NAME.run)], [null, null], 'payroll_holiday、payroll_run 分頁仍然不存在');
}

console.log('\n══ 2) gov 試推：節日分頁在、payroll_run 不存在，而且有待新增的月份 ══');
{
  const w = world({ sheets: { holiday: PROD } });
  const x = ro(w, () => w.H.payroll_holiday_publish(push({ dry_run: true })));
  eq([x.r.ok, x.r.would_change.length, x.r.skipped_locked], [true, 12, []], '預覽：2027 年 12 個月會新增、沒有鎖定（沒有 payroll_run＝沒有人鎖）');
  eq(ZERO(x), [0, 0, 0, true], '零寫入');
  eq(w.ss.getSheetByName(w.NAME.run), null, 'payroll_run 分頁仍然不存在（以前查鎖定時會被建出來）');
}

console.log('\n══ 3) 只收推送（mini）：同版本、沒帶 reapply（不寫的路徑），分頁都不存在 ══');
{
  const w = world({ sheets: {}, props: { PAY_HOL_SOURCE: 'mini' } });
  w.props.PAY_HOL_PUB = JSON.stringify({ version: '2027-1', hash: w.hash(push()), published_at: PUSH.published_at, years: ['2026', '2027'] });
  const x = ro(w, () => w.H.payroll_holiday_publish(push()));
  eq([x.r.ok, x.r.added, x.r.changed, x.r.drift.length], [true, false, [], 14], '同版本：不寫、drift 列出分頁跟這一版不同的 14 個月');
  eq(ZERO(x), [0, 0, 0, true], '零寫入（也不取寫鎖、不建分頁）');
  const y = ro(w, () => w.H.payroll_holiday_publish(push({ dry_run: true, reapply: true })));
  eq([y.r.ok, y.r.would_change.length], [true, 14], '試推帶 reapply：預覽 14 個月');
  eq(ZERO(y), [0, 0, 0, true], '試推帶 reapply 也零寫入');
}

console.log('\n══ 4) 本店專屬唯讀清單 payroll_holiday_own_list：節日分頁不存在 ══');
{
  const w = world({ sheets: {} });
  const x = ro(w, () => w.H.payroll_holiday_own_list({ admin_key: KEY }));
  eq([x.r.ok, x.r.count, x.r.rows], [true, 0, []], '回空清單');
  eq(ZERO(x), [0, 0, 0, true], '零寫入、不建分頁');
}

console.log('\n══ 5) 只收推送時開薪資頁 payroll_holiday_sync：節日分頁不存在 ══');
{
  const w = world({ sheets: {}, props: { PAY_HOL_SOURCE: 'mini' } });
  const x = ro(w, () => w.H.payroll_holiday_sync({ admin_key: KEY, years: [2026], store: 'SSLGF', operator: 'auto' }));
  eq([x.r.ok, x.r.hol_source, x.r.holidays, x.r.changed], [true, 'mini', [], []], '回空清單＋hol_source mini');
  eq(ZERO(x), [0, 0, 0, true], '零寫入、不建分頁');
}

console.log('\n══ 6) 分頁都在時的試推（gov 與 mini）：一樣零寫入 ══');
{
  const w = world({ sheets: { holiday: PROD, run: [] } });
  eq(ZERO(ro(w, () => w.H.payroll_holiday_publish(push({ dry_run: true })))), [0, 0, 0, true], 'gov 試推零寫入');
  const w2 = world({ sheets: { holiday: PROD, run: [] }, props: { PAY_HOL_SOURCE: 'mini' } });
  eq(ZERO(ro(w2, () => w2.H.payroll_holiday_publish(push({ dry_run: true })))), [0, 0, 0, true], 'mini 試推零寫入');
  eq(ZERO(ro(w2, () => w2.H.payroll_holiday_own_list({ admin_key: KEY }))), [0, 0, 0, true], '本店專屬清單零寫入');
}

console.log('\n══ 7) 對照組：計數真的抓得到寫入 ══');
{
  const w = world({ sheets: {}, props: { PAY_HOL_SOURCE: 'mini' } });
  const x = ro(w, () => w.H.payroll_holiday_publish(push()));
  eq([x.r.ok, x.r.added], [true, true], '只收推送時正式推送（分頁不存在）→ 收下');
  eq([x.writes > 0, x.newSheets > 0, x.propW > 0, x.same, x.calls.indexOf('insertSheet') >= 0], [true, true, true, false, true], '正式推送會建分頁、寫格子、記版本 → 計數不是 0（上面的 0 是真的 0）');
  const w2 = world({ sheets: {} });
  const y = ro(w2, () => w2.H.payroll_holiday_publish(push()));
  eq([y.r.error, ZERO(y)], ['hol_source_gov', [0, 0, 0, true]], 'gov 下正式推送被擋（hol_source_gov）且零寫入');
}

console.log('\n' + (fail ? '❌' : '✅') + ' hol-publish-nocreate：' + pass + ' 通過、' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
