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
function buildFns(src) {   // 任一版本的 Liff.gs → sheet_stats 相關常數與函式（舊版沒有的 props 輔助函式就略過）
  const consts = src.split('\n').filter((l) => l.indexOf('var LIFF_STATS_') === 0).join('\n');
  assert.ok(consts.indexOf('LIFF_STATS_FORMULA_MAX_CELLS_') >= 0 && consts.indexOf('LIFF_STATS_FORMULA_BUDGET_MS_') >= 0, '找不到 LIFF_STATS_ 常數');
  const extra = ['liffStatsUtf8Len_', 'liffStatsPropPattern_', 'liffStatsProps_'].filter((f) => src.indexOf('function ' + f + '(') >= 0).map((f) => extract(src, f));
  return [consts, extract(src, 'liffStatsFnNames_')].concat(extra, [extract(src, 'handleSheetStats_')]).join('\n');
}
const FNS = buildFns(liff);
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
  if (opts.PropertiesService) sb.PropertiesService = opts.PropertiesService;
  vm.createContext(sb);
  vm.runInContext(opts.fns || FNS, sb);
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

/* ══ props:true（2026-11-20，容量週檢 0b 段）：指令碼屬性個數與大小，不回任何值 ══ */
const { execFileSync } = require('child_process');
const BASE_COMMIT = '66aa2cf';   // 加 props 之前的 main（九店 11/18 起服務中的 Liff.js 就是這版的 sheet_stats）
function gitShow(ref) {
  try { return execFileSync('git', ['show', ref + ':apps-script/Liff.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); }
  catch (e) { return null; }
}
const OLD_LIFF = gitShow(BASE_COMMIT);
assert.ok(OLD_LIFF, '讀不到 ' + BASE_COMMIT + ' 版的 Liff.gs（要在 git repo 裡跑）');
const u8 = (s) => Buffer.byteLength(String(s), 'utf8');
function fakeProps(map, log) {
  const store = {
    getProperties: () => { log.push('getProperties'); return Object.assign({}, map); },
    getProperty: () => { log.push('getProperty'); throw new Error('不該逐一讀'); },
    getKeys: () => { log.push('getKeys'); throw new Error('不該用'); },
    setProperty: () => { log.push('setProperty'); throw new Error('不該寫入'); },
    setProperties: () => { log.push('setProperties'); throw new Error('不該寫入'); },
    deleteProperty: () => { log.push('deleteProperty'); throw new Error('不該寫入'); },
    deleteAllProperties: () => { log.push('deleteAllProperties'); throw new Error('不該寫入'); }
  };
  return { getScriptProperties: () => { log.push('getScriptProperties'); return store; },
           getDocumentProperties: () => { log.push('getDocumentProperties'); throw new Error('不該用'); },
           getUserProperties: () => { log.push('getUserProperties'); throw new Error('不該用'); } };
}
const fixedNow = 1763571600000;
class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(fixedNow); } static now() { return fixedNow; } }
const SHEETS = [{ name: 'events', lastRow: 3, lastCol: 2, maxRows: 1000, maxCols: 26, formulas: [['=NOW()', ''], ['', ''], ['', '']] },
                { name: '報表', lastRow: 2, lastCol: 3, maxRows: 500, maxCols: 40, hidden: true, rules: 2, charts: 1, formulas: [['=SUM(A1:A2)', '', ''], ['', '', '']] }];
const OPTS = { named: 1, triggers: [['capSweep', 'CLOCK']], Date: FixedDate };

// 假屬性：每個值都帶 VAL 記號，名稱敏感的也記下來，最後全文比對都不能出現
const BIG_SECRET = 'VALSECRETBIG' + 'x'.repeat(8000);
const DEPT_LAST = JSON.stringify(Array.from({ length: 640 }, (_, i) => 'DZY' + String(i).padStart(3, '0')));   // 約 5 KB，像 REQ_DEPT_EMPS_LAST
const PROPS = {
  RELAY_KEY: 'VALrelay0123456789abcdef', QR_SECRET: 'VALqrsecret', NOTIFY_INBOX_TOKEN: 'VALtoken', ATT_ALERT_SVC_KEY: 'VALsvc',
  relay_key_old: 'VALlower', DB_PASSWORD: 'VALpw', GCP_PRIVATE_PEM: BIG_SECRET, X_CRED: 'VALcred', OAUTH_STATE: 'VALauth',
  'ATT_RUN_2026-11-01': '{"n":"VALrun1"}', 'ATT_RUN_2026-11-02': '{"n":"VALrun2"}',
  ATT_STATE_RUN: JSON.stringify({ d: 'VALstate' + 'y'.repeat(3000) }),
  ATT_VERDICT_01JC3K9Z8QWERTY12: '{"v":"VALverdict"}',
  REQ_DEPT_EMPS_LAST: DEPT_LAST,
  REQ_SEG2_KINDS: 'VALseg2', mirror_last_ok: '2026-11-19T10:00:00+08:00VALmirror', REFRESH_CURRENT_MONTH_LAST_ROW: '1234',
  '店長備註': 'VAL中文值', DZY020: 'VALemp1', 'NOTE_HQ-01': 'VALemp2', GF012_flag: 'VALemp3',
  U4af4980629bd1ef2f0e2c4c4e2a1b3c9: 'VALline', 'my note': 'VALspace'
};
const SECRET_NAMES = ['RELAY_KEY', 'QR_SECRET', 'NOTIFY_INBOX_TOKEN', 'ATT_ALERT_SVC_KEY', 'relay_key_old', 'DB_PASSWORD', 'GCP_PRIVATE_PEM', 'X_CRED', 'OAUTH_STATE'];
const OTHER_NAMES = ['店長備註', 'DZY020', 'NOTE_HQ-01', 'GF012_flag', 'U4af4980629bd1ef2f0e2c4c4e2a1b3c9', 'my note'];

ok('props：不帶 props（或 props 不是 true）→ 回應跟加功能前的版本一字不差、key 集合不變，而且完全不碰指令碼屬性', () => {
  const oldFns = buildFns(OLD_LIFF);
  assert.ok(oldFns.indexOf('liffStatsProps_') < 0, '基準版不該有 props');
  [{ admin_key: 'ADM' }, { admin_key: 'ADM', no_formulas: true }, { admin_key: 'ADM', props: 'true' }, { admin_key: 'ADM', props: 1 }, { admin_key: 'ADM', props: false }, { admin_key: 'ADM', no_formulas: true, props: null }].forEach((b) => {
    const log = [];
    const oldR = make(SHEETS, Object.assign({ fns: oldFns }, OPTS)).run(b);
    const newR = make(SHEETS, Object.assign({ PropertiesService: fakeProps(PROPS, log) }, OPTS)).run(b);
    assert.deepStrictEqual(newR, oldR, JSON.stringify(b));
    assert.strictEqual(JSON.stringify(newR), JSON.stringify(oldR), '欄位順序也要一樣 ' + JSON.stringify(b));
    assert.deepStrictEqual(Object.keys(newR), ['ok', 'at', 'ms', 'sheets', 'named_ranges', 'triggers']);
    assert.deepStrictEqual(log, [], '沒帶 props:true 不該碰 PropertiesService ' + JSON.stringify(b));
  });
  // 沒有 PropertiesService 的環境（例如 mini 引擎）照常可跑
  assert.strictEqual(make(SHEETS, OPTS).run({ admin_key: 'ADM' }).ok, true);
});

ok('props：沒金鑰帶 props:true 一樣 unauthorized，不碰指令碼屬性', () => {
  const log = [];
  assert.deepStrictEqual(make(SHEETS, Object.assign({ PropertiesService: fakeProps(PROPS, log) }, OPTS)).run({ props: true }), { ok: false, error: 'unauthorized' });
  assert.deepStrictEqual(log, []);
});

ok('props：個數、大小、樣式正確；只呼叫 getScriptProperties().getProperties() 一次，沒有任何寫入', () => {
  const log = [];
  const r = make(SHEETS, Object.assign({ PropertiesService: fakeProps(PROPS, log) }, OPTS)).run({ admin_key: 'ADM', no_formulas: true, props: true });
  assert.deepStrictEqual(log, ['getScriptProperties', 'getProperties']);
  assert.deepStrictEqual(Object.keys(r), ['ok', 'at', 'ms', 'sheets', 'named_ranges', 'triggers', 'props']);
  const p = r.props, names = Object.keys(PROPS);
  assert.strictEqual(p.count, names.length);
  assert.strictEqual(p.total_bytes, names.reduce((a, k) => a + u8(k) + u8(PROPS[k]), 0));
  assert.deepStrictEqual(p.limits, { value_bytes: 9216, store_bytes: 512000 });
  assert.deepStrictEqual(p.secret, { count: SECRET_NAMES.length, big: 1 });   // GCP_PRIVATE_PEM 8012 位元組 ≥ 9216×0.8
  assert.deepStrictEqual(p.other, { count: OTHER_NAMES.length, bytes: OTHER_NAMES.reduce((a, k) => a + u8(k) + u8(PROPS[k]), 0) });
  // 最大單值不算金鑰類（金鑰 8012 比 REQ_DEPT_EMPS_LAST 大，但不能被拿來當最大值、也不能透露大小）
  assert.strictEqual(p.max_value_group, 'REQ_DEPT_EMPS_LAST');
  assert.strictEqual(p.max_value_bytes, u8(DEPT_LAST));
  const G = {}; p.groups.forEach((g) => { G[g.pattern] = g; });
  assert.deepStrictEqual(G['ATT_RUN_<date>'], { pattern: 'ATT_RUN_<date>', count: 2, bytes: u8('ATT_RUN_2026-11-01') * 2 + u8('{"n":"VALrun1"}') * 2, max_bytes: u8('{"n":"VALrun1"}') });
  assert.strictEqual(G['ATT_VERDICT_<id>'].count, 1);
  assert.strictEqual(G['REQ_SEG#_KINDS'].count, 1);
  assert.strictEqual(G.ATT_STATE_RUN.max_bytes, u8(PROPS.ATT_STATE_RUN));
  assert.ok(G.mirror_last_ok && G.REFRESH_CURRENT_MONTH_LAST_ROW);
  assert.deepStrictEqual(Object.keys(p.groups[0]), ['pattern', 'count', 'bytes', 'max_bytes']);
  // 依大小排序；三類加起來＝總數
  for (let i = 1; i < p.groups.length; i++) assert.ok(p.groups[i - 1].bytes >= p.groups[i].bytes);
  assert.strictEqual(p.groups.reduce((a, g) => a + g.count, 0) + p.other.count + p.secret.count, p.count);
});

ok('props：回應全文找不到任何屬性值；金鑰類、工號、中文、LINE 帳號的名稱都不出現', () => {
  const r = make(SHEETS, Object.assign({ PropertiesService: fakeProps(PROPS, []) }, OPTS)).run({ admin_key: 'ADM', props: true });
  const txt = JSON.stringify(r.props);
  assert.ok(txt.indexOf('VAL') < 0, '回應帶出了屬性值');
  Object.keys(PROPS).forEach((k) => { const v = PROPS[k]; if (v.length >= 4) assert.ok(txt.indexOf(v.slice(0, 12)) < 0, '值外洩：' + k); });
  ['DZY0', '2026-11-19', '1234'].forEach((w) => assert.ok(txt.indexOf(w) < 0, '值片段外洩：' + w));
  SECRET_NAMES.concat(OTHER_NAMES).forEach((k) => assert.ok(txt.indexOf(k) < 0, '名稱外洩：' + k));
  ['RELAY', 'QR_', 'SECRET', 'TOKEN', 'PASS', 'PRIVATE', 'CRED', 'AUTH', 'SVC_KEY', '店長', 'HQ-01', 'GF012', 'U4af'].forEach((w) => assert.ok(txt.replace(/"secret":/g, '').toUpperCase().indexOf(w.toUpperCase()) < 0, '名稱片段外洩：' + w));   // 欄位名 secret 本身不算
});

ok('props：名稱樣式化規則（手算對照）', () => {
  const sb = make([], {}).sb;
  const pat = (k) => J(vm.runInContext('liffStatsPropPattern_', sb)(k));
  const cases = [
    ['ATT_RUN_2026-11-01', { pattern: 'ATT_RUN_<date>' }],
    ['ATT_RUN_20261101', { pattern: 'ATT_RUN_<date>' }],
    ['ATT_RUN_2026_11_01', { pattern: 'ATT_RUN_<date>' }],
    ['ATT_X_2026-11', { pattern: 'ATT_X_<date>' }],
    ['ATT_VERDICT_01JC3K9Z8QWERTY12', { pattern: 'ATT_VERDICT_<id>' }],
    ['ATT_BATCH_3f2a9c1b7d', { pattern: 'ATT_BATCH_<id>' }],
    ['ATT_EVT_1763571600000', { pattern: 'ATT_EVT_#' }],
    ['REQ_SEG2_KINDS', { pattern: 'REQ_SEG#_KINDS' }],
    ['CAP10_ON', { pattern: 'CAP#_ON' }],
    ['REQ_DEPT_EMPS_LAST', { pattern: 'REQ_DEPT_EMPS_LAST' }],
    ['REFRESH_CURRENT_MONTH_LAST_APPROVED_ROW', { pattern: 'REFRESH_CURRENT_MONTH_LAST_APPROVED_ROW' }],
    ['mirror_last_ok', { pattern: 'mirror_last_ok' }],
    ['G_RECON', { pattern: 'G_RECON' }],
    ['LINE_MAP_KID', { pattern: 'LINE_MAP_KID' }],
    // 金鑰類（不分大小寫，寧可多擋）
    ['RELAY_KEY', { secret: true }], ['relay_key', { secret: true }], ['QR_SECRET', { secret: true }], ['NOTIFY_INBOX_TOKEN', { secret: true }],
    ['DB_Password', { secret: true }], ['GCP_PRIVATE', { secret: true }], ['X_CRED', { secret: true }], ['OAUTH_STATE', { secret: true }],
    ['STAFF_HUB_KEY', { secret: true }], ['PNL_KEY', { secret: true }],
    // 工號、中文、LINE 帳號、怪符號、太長、開頭不是字母 → other
    ['DZY020', { other: true }], ['NOTE_HQ-01', { other: true }], ['GF012_flag', { other: true }], ['emp_mzt1234', { other: true }],
    ['店長備註', { other: true }], ['ATT_店長', { other: true }], ['U4af4980629bd1ef2f0e2c4c4e2a1b3c9', { other: true }],
    ['my note', { other: true }], ['a-b', { other: true }], ['x.y', { other: true }], ['A'.repeat(49), { other: true }], ['', { other: true }], ['_X', { other: true }],
    ['3f2a9c1b-4b2e-11ee-be56-0242ac120002', { other: true }]
  ];
  cases.forEach(([k, want]) => assert.deepStrictEqual(pat(k), want, k));
  assert.deepStrictEqual(pat('A'.repeat(48)), { pattern: 'A'.repeat(48) });
});

ok('props：UTF-8 位元組數與 Node Buffer.byteLength 一致（中文、emoji、落單的代理字元）', () => {
  const sb = make([], {}).sb, len = vm.runInContext('liffStatsUtf8Len_', sb);
  ['', 'abc', '店長', 'é', '😀', 'a😀b店', '\uD800', 'x\uDC00y', '\uD83D', JSON.stringify({ a: '中文', b: [1, 2] }), 12345, null].forEach((s) =>
    assert.strictEqual(len(s), u8(s), JSON.stringify(s)));
});

ok('props：讀屬性出錯 → props 只帶 error，其餘照回；沒有屬性 → 全 0、max_value_group 為 null', () => {
  const boom = { getScriptProperties: () => ({ getProperties: () => { throw new Error('Properties 服務暫時無法使用'); } }) };
  const r = make(SHEETS, Object.assign({ PropertiesService: boom }, OPTS)).run({ admin_key: 'ADM', props: true });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.sheets.length, 2);
  assert.deepStrictEqual(r.props, { error: 'Properties 服務暫時無法使用' });
  const e = make(SHEETS, Object.assign({ PropertiesService: fakeProps({}, []) }, OPTS)).run({ admin_key: 'ADM', props: true }).props;
  assert.deepStrictEqual(e, { count: 0, total_bytes: 0, max_value_bytes: 0, max_value_group: null, groups: [], secret: { count: 0, big: 0 }, other: { count: 0, bytes: 0 }, limits: { value_bytes: 9216, store_bytes: 512000 } });
  // 只有金鑰類 → max_value_* 不受影響
  const s = make(SHEETS, Object.assign({ PropertiesService: fakeProps({ RELAY_KEY: 'k'.repeat(100) }, []) }, OPTS)).run({ admin_key: 'ADM', props: true }).props;
  assert.deepStrictEqual([s.count, s.total_bytes, s.max_value_bytes, s.max_value_group, s.secret.count, s.secret.big], [1, 109, 0, null, 1, 0]);
});

ok('props：樣式超過 80 種（異常）→ 多的併進 other，個數守恆', () => {
  const m = {}; for (let i = 0; i < 100; i++) m['K' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)) + '_X'] = 'v'.repeat(i + 1);
  const p = make(SHEETS, Object.assign({ PropertiesService: fakeProps(m, []) }, OPTS)).run({ admin_key: 'ADM', props: true }).props;
  assert.strictEqual(p.groups.length, 80);
  assert.strictEqual(p.other.count, 20);
  assert.strictEqual(p.groups.reduce((a, g) => a + g.count, 0) + p.other.count, 100);
  assert.strictEqual(p.groups.reduce((a, g) => a + g.bytes, 0) + p.other.bytes, p.total_bytes);
  assert.strictEqual(p.max_value_bytes, 100);
});

// Apps Script 依程式碼文字判斷要哪些授權：Liff.gs 只要多出一個新服務（或 ScriptApp 等的新方法），九店都要重新授權、授權前全部失敗
const SVC_RE = /\b(?:[A-Z][A-Za-z]*(?:App|Service|Services)|Utilities|Session|Logger|Browser|Maps|Jdbc|XmlService|Charts|Drive|Gmail|Calendar|Sheets|Docs|Slides|People|Tasks|AdminDirectory|YouTube|Analytics|BigQuery|Console)\b(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g;
function svcUse(src) {
  const names = new Set(), calls = new Set();
  (src.match(SVC_RE) || []).forEach((m) => { const t = m.replace(/\s+/g, ''); names.add(t.split('.')[0]); if (t.indexOf('.') > 0) calls.add(t); });
  return { names, calls };
}
ok('授權範圍不變：新版 Liff.gs 用到的服務名稱與「服務.方法」都 ⊆ 加功能前版本（' + BASE_COMMIT + '，有 origin/main 也一起比）', () => {
  const now = svcUse(liff);
  [BASE_COMMIT, 'origin/main'].forEach((ref) => {
    const src = gitShow(ref);
    if (!src) { assert.notStrictEqual(ref, BASE_COMMIT); return; }
    const old = svcUse(src);
    const newNames = [...now.names].filter((x) => !old.names.has(x)), newCalls = [...now.calls].filter((x) => !old.calls.has(x));
    assert.deepStrictEqual(newNames, [], ref + ' 沒有的服務：' + newNames);
    assert.deepStrictEqual(newCalls, [], ref + ' 沒有的服務方法：' + newCalls);
  });
  assert.ok(now.calls.has('PropertiesService.getScriptProperties') && now.names.has('Utilities'), '比對規則本身要抓得到既有服務');
  assert.ok(svcUse('DriveApp.getFiles(); ScriptApp.newTrigger("x")').calls.has('ScriptApp.newTrigger'), '比對規則要抓得到新方法');
});

ok('新增段落零寫入：跟 ' + BASE_COMMIT + ' 比，Liff.gs 新增的行沒有任何寫入呼叫', () => {
  const diff = execFileSync('git', ['diff', '-U0', BASE_COMMIT, '--', 'apps-script/Liff.gs'], { cwd: ROOT, encoding: 'utf8' });
  const added = diff.split('\n').filter((l) => l[0] === '+' && l.indexOf('+++') !== 0);
  assert.ok(added.length > 0, '應該有新增的行');
  const bad = added.filter((l) => /setProperty|deleteProperty|appendRow|setValue|setValues|insertSheet|deleteRow|clear\(|setProperties|deleteAllProperties|getDocumentProperties|getUserProperties|UrlFetchApp|newBlob/.test(l));
  assert.deepStrictEqual(bad, []);
});

console.log('sheet-stats：' + n + ' 項全過');
