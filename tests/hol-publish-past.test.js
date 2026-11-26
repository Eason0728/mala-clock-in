/**
 * 節日表推送：已經過去的月份一律不寫（主管 2026-11-25 11:13 定案＝方案乙：「過去的月份整月沒有節日資料時，不補上。」）。
 * 獨立審查第 1 輪擋項 2 的後續：補缺也算改過去月份 → 試推、正式推送、同版 reapply 在任何情況都不寫過去月份，
 * 回應逐月講明拒絕（past_code:'hol_past_frozen'、past_refused、past_message）；本月與未來照常寫。
 * 「已經過去」＝月份 < 台北本月 currentYmTaipei()（沿用 payHolPubPlan_，不另寫一套）。
 *
 * 用真的 Code.gs＋Payroll.gs＋Requests.gs（payRead／paySheet 不換），試算表用 helpers/sheets-like.js；
 * 寫入方法全部計數、分頁逐格快照：過去月份那一列前後逐格相同、不新增列、不建分頁。
 * 四種月份各一：過去月份有資料（跟推送不同）／過去月份整月沒有資料／本月／未來月。全部虛構資料。
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
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 500) + '\n   應為 ' + w.slice(0, 500)); }
};

/* ── 寫入計數（同 hol-publish-nocreate） ── */
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

const rowOf = (ym) => { const r = PUSH.rows[ym]; return [ym, r.red_days, r.note, r.dates, '']; };
/** 分頁＝2026-05 起到 last 都跟正本相同（再由各情境改） */
const FULL = (last) => Object.keys(PUSH.rows).filter((k) => k >= '2026-05' && k <= last).sort().map(rowOf);

function world(opt) {
  const props = Object.assign({ PAY_HOL_SVC_KEY: SVC, PAY_HOL_SOURCE: 'mini' }, opt.props || {}), propW = [];
  const sb = {
    console: { log() {}, error() {}, warn() {} }, Logger: { log() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { propW.push(k); props[k] = String(v); } }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) },
    UrlFetchApp: { fetch: () => { throw new Error('測試不連網'); } },
    __NOWYM: opt.nowYm,
  };
  sb.SpreadsheetApp = { flush() {} };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'gs' });
  const ss = createSpreadsheet({ DateCtor: vm.runInContext('Date', sb), defaultMaxCols: 40 });
  sb.SpreadsheetApp.getActive = () => ss; sb.SpreadsheetApp.openById = () => ss;
  sb.__SS = ss;
  vm.runInContext(`getSS = function () { return __SS; }; CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    currentYmTaipei = function () { return __NOWYM; }; nowTaipeiIso = function () { return __NOWYM + '-02T09:00:00+08:00'; };`, sb);
  const NAME = vm.runInContext('PAY_SHEET_NAME', sb), COLS = vm.runInContext('PAY_SHEETS', sb);
  Object.keys(opt.sheets || {}).forEach((k) => ss.seed(NAME[k], [COLS[k]].concat(opt.sheets[k]), true));
  const H = vm.runInContext('PAYROLL_HANDLERS', sb);
  const holVals = () => { const sh = ss.getSheetByName(NAME.holiday); return sh ? sh.getDataRange().getValues().slice(1).map((r) => r.slice(0, 5).map(String)) : []; };
  const row = (ym) => holVals().filter((r) => r[0] === ym && r[4] === '');
  const validate = vm.runInContext('payHolPubValidate_', sb);
  return { ss, H, props, propW, NAME, holVals, row, sheets: () => ss.getSheets().length, hash: (b) => validate(b, opt.nowYm).hash };
}
const push = (over) => Object.assign(J(PUSH), { svcKey: SVC, confirmed_by: '人資主管' }, over || {});
function run(w, body) {
  const s0 = w.sheets(); W.n = 0; W.calls = []; SPY_ON = true;
  let r;
  try { r = J(w.H.payroll_holiday_publish(body)); } finally { SPY_ON = false; }
  return { r, writes: W.n, calls: W.calls.slice(), newSheets: w.sheets() - s0 };
}
const PAST_KEYS = ['past_code', 'past_refused', 'past_message'];
const pastOf = (r) => [r.past_code, r.past_refused];

/* 三種推送：試推、正式推送（第一次收＝新版本）、同版 reapply（先記成已收這一版） */
function three(mk, check) {
  [['試推', (w) => run(w, push({ dry_run: true }))],
    ['正式推送', (w) => run(w, push())],
    ['同版 reapply', (w) => { w.props.PAY_HOL_PUB = JSON.stringify({ version: PUSH.version, hash: w.hash(push()), published_at: PUSH.published_at, years: ['2026', '2027'] }); return run(w, push({ reapply: true })); }],
  ].forEach(([how, go]) => { const w = mk(); const before = { all: w.holVals() }; check(how, w, go(w), before); });
}

console.log('══ 1) 過去月份有資料、跟推送不同（今天 2026-12，分頁 2026-10 紅字被改成 7）══');
three(() => world({ nowYm: '2026-12', sheets: { holiday: FULL('2027-12').map((r) => (r[0] === '2026-10' ? ['2026-10', 7, r[2], '2026-10-09, 2026-10-26', ''] : r)), run: [], audit: [] } }),
  (how, w, x, b) => {
    eq(w.row('2026-10'), [['2026-10', '7', PUSH.rows['2026-10'].note, '2026-10-09, 2026-10-26', '']], how + '：2026-10 逐格不變（紅字仍 7）');
    eq([x.r.ok, x.r.skipped_past, x.r.past_missing], [true, ['2026-10'], []], how + '：ok、skipped_past=[2026-10]');
    eq(pastOf(x.r), ['hol_past_frozen', ['2026-10']], how + '：回拒絕碼 hol_past_frozen、past_refused=[2026-10]');
    eq(/2026-10 跟這一版不同，不會改/.test(x.r.past_message) && !/附錄/.test(x.r.past_message), true, how + '：白話寫出 2026-10 不會改');
    eq([JSON.stringify(w.holVals()) === JSON.stringify(b.all), x.newSheets], [true, 0], how + '：節日分頁整張逐格相同、沒有建分頁');
    if (how === '試推') eq([x.writes], [0], '試推：完全零寫入');
  });

console.log('\n══ 2) 過去月份整月沒有資料（今天 2026-12，分頁缺 2026-09）══');
three(() => world({ nowYm: '2026-12', sheets: { holiday: FULL('2027-12').filter((r) => r[0] !== '2026-09'), run: [], audit: [] } }),
  (how, w, x, b) => {
    eq(w.row('2026-09'), [], how + '：2026-09 沒有被補上');
    eq([x.r.ok, x.r.skipped_past, x.r.past_missing], [true, [], ['2026-09']], how + '：ok、past_missing=[2026-09]');
    eq(pastOf(x.r), ['hol_past_frozen', ['2026-09']], how + '：回拒絕碼 hol_past_frozen、past_refused=[2026-09]');
    eq(/2026-09 整月沒有節日資料，不會補上/.test(x.r.past_message) && /系統外處理/.test(x.r.past_message), true, how + '：白話寫出 2026-09 不補、系統外處理');
    eq([JSON.stringify(w.holVals()) === JSON.stringify(b.all), x.newSheets], [true, 0], how + '：節日分頁整張逐格相同、沒有建分頁');
    if (how === '試推') eq([x.writes], [0], '試推：完全零寫入');
    if (how === '正式推送') eq(JSON.parse(w.props.PAY_HOL_PUB).lag, { locked: [], past: [], missing: ['2026-09'] }, '正式推送：沒跟上的月份記在版本紀錄（給畫面）');
  });
{
  // 整份分頁都沒有過去月份（只有本月起）：2026-05～11 七個月都是整月沒有資料 → 一個都不補
  const w = world({ nowYm: '2026-12', sheets: { holiday: FULL('2027-12').filter((r) => r[0] >= '2026-12'), run: [], audit: [] } }), b = w.holVals();
  const x = run(w, push());
  eq([x.r.past_missing.length, (x.r.past_refused || []).length, w.holVals().filter((r) => r[0] < '2026-12').length, JSON.stringify(w.holVals()) === JSON.stringify(b)],
    [7, 7, 0, true], '過去 7 個月全缺：一個都不補、分頁不變');
}

console.log('\n══ 3) 本月（今天 2026-12，分頁 2026-12 加發日被清空；另缺過去的 2026-09）══');
three(() => world({ nowYm: '2026-12', sheets: { holiday: FULL('2027-12').filter((r) => r[0] !== '2026-09').map((r) => (r[0] === '2026-12' ? ['2026-12', 9, r[2], '', ''] : r)), run: [], audit: [] } }),
  (how, w, x, b) => {
    const wrote = how !== '試推';
    eq(w.row('2026-12')[0][3], wrote ? '2026-12-25' : '', how + '：本月 2026-12 ' + (wrote ? '照常改回 12/25' : '只預覽不寫'));
    eq(x.r[wrote ? 'changed' : 'would_change'], ['2026-12'], how + '：本月列在 ' + (wrote ? 'changed' : 'would_change'));
    eq([w.row('2026-09'), pastOf(x.r)], [[], ['hol_past_frozen', ['2026-09']]], how + '：同一份推送裡過去的 2026-09 照樣不補、回拒絕碼');
    eq([w.holVals().filter((r) => r[0] < '2026-12'), x.newSheets], [b.all.filter((r) => r[0] < '2026-12'), 0], how + '：過去月份逐格相同、沒有建分頁');
    if (how === '試推') eq(x.writes, 0, '試推：完全零寫入');
  });

console.log('\n══ 4) 未來月（今天 2026-12，分頁沒有 2027；過去月份都跟正本相同）══');
three(() => world({ nowYm: '2026-12', sheets: { holiday: FULL('2026-12'), run: [], audit: [] } }),
  (how, w, x, b) => {
    const wrote = how !== '試推';
    eq([w.row('2027-02').length, (w.row('2027-02')[0] || [])[3]], wrote ? [1, PUSH.rows['2027-02'].dates] : [0, undefined], how + '：未來 2027-02 ' + (wrote ? '照常新增' : '只預覽不寫'));
    eq((x.r[wrote ? 'changed' : 'would_change'] || []).length, 12, how + '：2027 整年 12 個月');
    eq(PAST_KEYS.filter((k) => k in x.r), [], how + '：沒有過去月份問題 → 回應沒有 past_* 欄位（跟改動前逐字相同）');
    eq([w.holVals().filter((r) => r[0] <= '2026-12'), x.newSheets], [b.all, 0], how + '：既有月份逐格相同、沒有建分頁');
    if (how === '試推') eq(x.writes, 0, '試推：完全零寫入');
  });

console.log('\n══ 5) 「已經過去」的界線：沿用 currentYmTaipei()（月份 < 台北本月）══');
{
  // 今天 2026-12 時 2026-11 已經過去：缺 2026-11 不補（12/1～12/10 結算 11 月也一樣）
  const w = world({ nowYm: '2026-12', sheets: { holiday: FULL('2027-12').filter((r) => r[0] !== '2026-11'), run: [], audit: [] } });
  const x = run(w, push());
  eq([w.row('2026-11'), x.r.past_refused], [[], ['2026-11']], '今天 2026-12：上個月 2026-11 缺列 → 不補（已經過去）');
  // 今天 2026-11 時 2026-11 是本月：缺 2026-11 照常補
  const w2 = world({ nowYm: '2026-11', sheets: { holiday: FULL('2027-12').filter((r) => r[0] !== '2026-11'), run: [], audit: [] } });
  const y = run(w2, push());
  eq([w2.row('2026-11').length, y.r.months_new, 'past_code' in y.r], [1, ['2026-11'], false], '今天 2026-11：本月 2026-11 缺列 → 照常補、沒有 past_*');
}

console.log('\n══ 6) gov（預設開關）：正式推送照舊 hol_source_gov、不帶 past_*；試推只多 past_* 欄位、零寫入 ══');
{
  const w = world({ nowYm: '2026-12', props: { PAY_HOL_SOURCE: 'gov' }, sheets: { holiday: FULL('2027-12').filter((r) => r[0] !== '2026-09'), run: [], audit: [] } });
  const x = run(w, push());
  eq([x.r.ok, x.r.error, PAST_KEYS.filter((k) => k in x.r), x.writes], [false, 'hol_source_gov', [], 0], 'gov 正式推送：hol_source_gov、沒有 past_*、零寫入');
  const y = run(w, push({ dry_run: true }));
  eq([y.r.ok, y.r.mode, pastOf(y.r), y.writes, y.newSheets], [true, 'gov', ['hol_past_frozen', ['2026-09']], 0, 0], 'gov 試推：講明 2026-09 不補、零寫入');
}

console.log('\n' + (fail ? '❌' : '✅') + ' hol-publish-past：' + pass + ' 通過、' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
