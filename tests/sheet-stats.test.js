// sheet_stats（2026-11-17）：唯讀的分頁清單與大小，查某家店的試算表為什麼變重。
// 重點：要管理金鑰、只回名稱與數字（不回儲存格內容）、不寫入、太大的分頁不數公式、單一分頁出錯不影響其他分頁。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const liff = fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const maxLine = liff.split('\n').filter((l) => l.indexOf('var LIFF_STATS_') === 0).join('\n');
assert.ok(maxLine.indexOf('LIFF_STATS_FORMULA_MAX_CELLS_') >= 0 && maxLine.indexOf('LIFF_STATS_FORMULA_BUDGET_MS_') >= 0, '找不到 LIFF_STATS_ 常數');
const FNS = maxLine + '\n' + extract(liff, 'liffStatsFnNames_') + '\n' + extract(liff, 'handleSheetStats_');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const J = (v) => JSON.parse(JSON.stringify(v));

function make(sheets, opts) {
  opts = opts || {};
  const calls = [];
  const mk = (s) => ({
    getName: () => s.name,
    getLastRow: () => { if (s.boom) throw new Error('壞掉的分頁'); return s.lastRow; },
    getLastColumn: () => s.lastCol, getMaxRows: () => s.maxRows, getMaxColumns: () => s.maxCols,
    isSheetHidden: () => !!s.hidden,
    getRange: (r, c, nr, nc) => { calls.push([s.name, 'getRange', r, c, nr, nc]); return {
      getFormulas: () => { calls.push([s.name, 'getFormulas']); return s.formulas || []; },
      getValues: () => { throw new Error('不該讀儲存格內容'); },
      setValue: () => { throw new Error('不該寫入'); }, setValues: () => { throw new Error('不該寫入'); } }; },
    getConditionalFormatRules: () => new Array(s.rules || 0).fill({}),
    getCharts: () => new Array(s.charts || 0).fill({}),
    appendRow: () => { throw new Error('不該寫入'); }, insertSheet: () => { throw new Error('不該寫入'); }
  });
  const sb = {
    console, Date: opts.Date || Date, JSON, Math, String, Number, Object, Array,
    CONFIG: { ADMIN_KEY: 'ADM' },
    checkAdmin: (b) => b.admin_key === 'ADM',
    getSS: () => ({ getSheets: () => sheets.map(mk), getNamedRanges: () => { if (opts.namedBoom) throw new Error('x'); return new Array(opts.named || 0).fill({}); } }),
    Utilities: { formatDate: () => '2026-11-17T01:00:00+08:00' },
    ScriptApp: { getProjectTriggers: () => { if (opts.trigBoom) throw new Error('沒有權限'); return (opts.triggers || []).map((t) => ({ getHandlerFunction: () => t[0], getEventType: () => t[1] })); } }
  };
  vm.createContext(sb);
  vm.runInContext(FNS, sb);
  return { run: (b) => J(vm.runInContext('handleSheetStats_', sb)(b)), calls, sb };
}

ok('沒帶金鑰、錯金鑰、空字串金鑰 → unauthorized，而且不碰試算表', () => {
  const { run, calls } = make([{ name: 'events', lastRow: 3, lastCol: 2, maxRows: 1000, maxCols: 26 }]);
  assert.deepStrictEqual(run({}), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(run({ admin_key: 'x' }), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(run({ admin_key: '' }), { ok: false, error: 'unauthorized' });
  assert.strictEqual(calls.length, 0);
});

ok('每個分頁回名稱與大小；公式只回格數與函式名稱次數，不回公式內容或儲存格內容', () => {
  const { run, calls } = make([
    { name: 'events', lastRow: 3, lastCol: 2, maxRows: 1000, maxCols: 26, formulas: [['', ''], ['', ''], ['', '']] },
    { name: '報表', lastRow: 2, lastCol: 3, maxRows: 50000, maxCols: 40, hidden: true, rules: 4, charts: 1,
      formulas: [['=IMPORTRANGE("https://docs.google.com/secret-id","events!A:L")', '', '=sum(A1:A9)'], ['=ARRAYFORMULA(IF(A2:A="","",VLOOKUP(A2:A,roster!A:B,2,0)))', '', '']] }
  ], { named: 2, triggers: [['dailyMonthlyRebuild', 'CLOCK'], ['capSweep', 'CLOCK']] });
  const r = run({ admin_key: 'ADM' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.at, '2026-11-17T01:00:00+08:00');
  assert.strictEqual(r.sheets.length, 2);
  const a = r.sheets[0], b = r.sheets[1];
  assert.deepStrictEqual([a.name, a.last_row, a.last_col, a.max_rows, a.max_cols, a.cells, a.formulas, a.hidden], ['events', 3, 2, 1000, 26, 26000, 0, false]);
  assert.deepStrictEqual(a.formula_kinds, []);
  assert.deepStrictEqual([b.name, b.max_rows, b.max_cols, b.cells, b.formulas, b.hidden, b.cond_rules, b.charts], ['報表', 50000, 40, 2000000, 3, true, 4, 1]);
  assert.deepStrictEqual(b.formula_kinds.slice().sort(), ['ARRAYFORMULA:1', 'IF:1', 'IMPORTRANGE:1', 'SUM:1', 'VLOOKUP:1']);
  assert.strictEqual(r.named_ranges, 2);
  assert.deepStrictEqual(r.triggers, ['dailyMonthlyRebuild:CLOCK', 'capSweep:CLOCK']);
  const txt = JSON.stringify(r);
  assert.ok(txt.indexOf('secret-id') < 0 && txt.indexOf('docs.google.com') < 0 && txt.indexOf('roster!') < 0, '不能回公式內容');
  // 只取有內容的範圍、只問公式
  assert.deepStrictEqual(calls.filter((c) => c[1] === 'getRange'), [['events', 'getRange', 1, 1, 3, 2], ['報表', 'getRange', 1, 1, 2, 3]]);
});

ok('有內容的範圍超過上限 → 不數公式（formulas=null），照樣回大小', () => {
  const { run, calls } = make([{ name: '超大', lastRow: 100000, lastCol: 30, maxRows: 100000, maxCols: 30 }]);
  const r = run({ admin_key: 'ADM' });
  assert.strictEqual(r.sheets[0].formulas, null);
  assert.strictEqual(r.sheets[0].formula_kinds, null);
  assert.strictEqual(r.sheets[0].cells, 3000000);
  assert.strictEqual(calls.length, 0);
});

ok('空白分頁不讀範圍；剛好等於上限會數', () => {
  const { run, calls } = make([{ name: '空', lastRow: 0, lastCol: 0, maxRows: 1000, maxCols: 26 }, { name: '剛好', lastRow: 200000, lastCol: 1, maxRows: 200000, maxCols: 1, formulas: [['=NOW()']] }]);
  const r = run({ admin_key: 'ADM' });
  assert.strictEqual(r.sheets[0].formulas, null);
  assert.strictEqual(r.sheets[1].formulas, 1);
  assert.deepStrictEqual(calls.filter((c) => c[1] === 'getRange').map((c) => c[0]), ['剛好']);
});

ok('某個分頁讀取出錯 → 只有那一列帶 error，其他分頁照回；具名範圍讀不到回 null', () => {
  const { run } = make([{ name: '壞', boom: true }, { name: 'roster', lastRow: 5, lastCol: 16, maxRows: 1000, maxCols: 26, formulas: [] }], { namedBoom: true });
  const r = run({ admin_key: 'ADM' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sheets[0].error, '壞掉的分頁');
  assert.strictEqual(r.sheets[1].last_row, 5);
  assert.strictEqual(r.named_ranges, null);
});

ok('有掛進動作表，而且登記成「讀取」（不會讓考勤副本以為有人改了資料）', () => {
  assert.ok(/\n\s*sheet_stats: handleSheetStats_,/.test(liff), 'LIFF_HANDLERS 沒有 sheet_stats');
  const feed = fs.readFileSync(ROOT + '/apps-script/DutyFeed.gs', 'utf8');
  const sb = {}; vm.createContext(sb);
  vm.runInContext(feed.slice(feed.indexOf('var DUTY_FEED_READS_'), feed.indexOf('function dutyFeedDate_')), sb);
  assert.strictEqual(vm.runInContext('dutyFeedIsRead_("sheet_stats")', sb), true);
  assert.strictEqual(vm.runInContext('dutyFeedIsRead_("mgr_approve")', sb), false);
});

ok('公式裡的字串常值、帶引號的分頁名稱不會被當成函式名帶出', () => {
  const { run } = make([{ name: 'x', lastRow: 1, lastCol: 4, maxRows: 10, maxCols: 4,
    formulas: [['="ABC("', '=IF(A1="John(店長)","SECRET(1)",1)', "='Sheet(1)'!A1", '=IF(A1="他說""HIDE(""",NOW(),0)']] }]);
  const r = run({ admin_key: 'ADM' });
  assert.strictEqual(r.sheets[0].formulas, 4);
  assert.deepStrictEqual(r.sheets[0].formula_kinds.slice().sort(), ['IF:2', 'NOW:1']);
  const txt = JSON.stringify(r.sheets[0].formula_kinds).toUpperCase();   // 只看函式名稱那一欄（回應的鍵名本身就有 sheets）
  ['ABC', 'JOHN', 'SECRET', 'SHEET', 'HIDE'].forEach((w) => assert.ok(txt.indexOf(w) < 0, '帶出了 ' + w));
});

ok('函式種類超過 8 種只留前 8，次數多的在前', () => {
  const names = ['A1F', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const row = []; names.forEach((nm, i) => { for (let k = 0; k < 10 - i; k++) row.push('=' + nm + '()'); });
  const { run } = make([{ name: 'x', lastRow: 1, lastCol: row.length, maxRows: 10, maxCols: row.length, formulas: [row] }]);
  assert.deepStrictEqual(run({ admin_key: 'ADM' }).sheets[0].formula_kinds, ['A1F:10', 'B:9', 'C:8', 'D:7', 'E:6', 'F:5', 'G:4', 'H:3']);
});

ok('no_formulas:true → 完全不讀範圍，每頁 skipped=off，大小照回；字串 "true" 不算，照常數', () => {
  const sheets = [{ name: 'a', lastRow: 2, lastCol: 2, maxRows: 10, maxCols: 5, formulas: [['=NOW()', ''], ['', '']] }];
  const x = make(sheets); const r = x.run({ admin_key: 'ADM', no_formulas: true });
  assert.deepStrictEqual([r.sheets[0].formulas, r.sheets[0].skipped, r.sheets[0].cells], [null, 'off', 50]);
  assert.strictEqual(x.calls.length, 0);
  assert.strictEqual(make(sheets).run({ admin_key: 'ADM', no_formulas: 'true' }).sheets[0].formulas, 1);
});

ok('整趟超過時間上限後的分頁不再數公式（skipped=time），大小照回；太大的分頁 skipped=big', () => {
  let now = 1000000;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  const x = make([
    { name: '第一頁', lastRow: 1, lastCol: 1, maxRows: 10, maxCols: 1, get formulas() { now += 121000; return [['=NOW()']]; } },   // 數這頁「花了」121 秒
    { name: '第二頁', lastRow: 1, lastCol: 1, maxRows: 10, maxCols: 1, formulas: [['=NOW()']] },
    { name: '超大', lastRow: 300000, lastCol: 1, maxRows: 300000, maxCols: 1 }
  ], { Date: FakeDate });
  const r = x.run({ admin_key: 'ADM' });
  assert.deepStrictEqual(r.sheets.map((s) => [s.name, s.formulas, s.skipped || '']), [['第一頁', 1, ''], ['第二頁', null, 'time'], ['超大', null, 'big']]);
  assert.strictEqual(r.sheets[1].max_rows, 10);
  assert.ok(r.ms >= 121000);
});

ok('排程清單讀不到（沒有權限）→ triggers=null，其餘照回', () => {
  const r = make([{ name: 'a', lastRow: 0, lastCol: 0, maxRows: 10, maxCols: 5 }], { trigBoom: true }).run({ admin_key: 'ADM' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.triggers, null); assert.strictEqual(r.sheets.length, 1);
});

ok('真的 checkAdmin：金鑰沒設或有設，空字串、亂填、非文字都被擋，而且不碰試算表', () => {
  const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
  [{ ADMIN_KEY: '' }, { ADMIN_KEY: 'ADM' }].forEach((cfg) => {
    const sb = { console, Date, JSON, Math, String, Number, Object, Array, CONFIG: cfg,
      getSS: () => { throw new Error('被擋的請求不該碰試算表'); }, Utilities: {}, ScriptApp: {} };
    vm.createContext(sb);
    vm.runInContext(extract(code, 'checkAdmin') + '\n' + FNS, sb);
    const run = vm.runInContext('handleSheetStats_', sb);
    [{}, { admin_key: '' }, { admin_key: 'x' }, { admin_key: true }, { admin_key: { a: 1 } }, { admin_key: 0 }].forEach((b) =>
      assert.deepStrictEqual(J(run(b)), { ok: false, error: 'unauthorized' }, JSON.stringify([cfg, b])));
  });
});

ok('整份 Liff.gs 在沒有 ScriptApp 的環境載入不出錯（Mac mini 打卡服務會整檔載入）', () => {
  const sb = { console, Date, JSON, Math, String, Number, Object, Array, isNaN, isFinite, parseInt, parseFloat, CONFIG: {} };
  vm.createContext(sb);
  vm.runInContext(liff, sb);
  assert.strictEqual(typeof vm.runInContext('LIFF_HANDLERS.sheet_stats', sb), 'function');
});

console.log('sheet-stats：' + n + ' 項全過');
