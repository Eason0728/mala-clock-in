/**
 * 薪資分頁整張覆寫（payReplaceAll）寫入防壞（2026-11-22）
 * ─────────────────────────────────────────────────────────────────────────────
 * 以前 payReplaceAll 是「先清空整張、再寫新資料」：寫到一半出錯（逾時、配額、單格太長、送出失敗）會留下空表或半張表，
 * 另一台同時在讀的也會讀到空表。這支用 helpers/sheets-like.js 的假試算表（外面再包一層「可以故意讓它失敗」的殼）跑真的
 * Code.gs＋Payroll.gs，驗：
 *   F1 清空後立刻失敗（第一次寫資料就丟例外，什麼都沒寫進去）
 *   F2 寫到一半失敗（寫進前一半的列才丟例外）
 *   F3 收尾（送出）失敗：寫入先排隊、送出（flush）時才失敗——Apps Script 真的會這樣，錯誤到 flush 才冒出來
 *   → 三種都要：分頁內容＝寫入前 或＝完整新內容，而且呼叫端收到錯誤（沒失敗的話內容要＝完整新內容）。
 *   F4 還原也失敗：錯誤訊息要講清楚（殘餘風險，不保證內容）
 *   F5 一次寫兩張（薪資計算的 run＋item）：後面那張失敗，先寫好的那張退回原內容
 *   F6 讀不到分頁時不可以當成空表整張覆寫（假別表、留停、假別事件日、打卡對照）
 *   F7 列數超過分頁格線：以前清空後才發現範圍超出 → 整張變空；現在先加列
 *   F8 同時有人在讀：每一個寫入動作之後別人讀到的，只能是舊內容或新內容
 *   N1 正常路徑：同一串寫入，改版前（PAYRA_BASE，預設 4f929d3＝#210 合併後主線）和現在逐格相同（值、型別、格式、格線）
 *
 * 用法：node tests/pay-replaceall-safe.test.js
 *       PAYRA_SRC=<某版 Payroll.gs 路徑> 可拿別版來跑失敗組（改版前會在 F1～F3、F6～F8 失敗）。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const { createSpreadsheet } = require('./helpers/sheets-like');

const ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const CUR = fs.readFileSync(process.env.PAYRA_SRC || path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const BASE = process.env.PAYRA_BASE || '4f929d3';
let baseSrc = null;
try { baseSrc = execFileSync('git', ['show', BASE + ':apps-script/Payroll.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) {}

let pass = 0, fail = 0;
const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const section = {};
const sec = (name, c, m) => { section[name] = section[name] || [0, 0]; section[name][c ? 0 : 1]++; ok(c, name + '｜' + m); };

/* ── 假 Apps Script 環境：真的 Code.gs＋Payroll.gs，試算表換成 sheets-like，外面包一層可以故意失敗的殼 ── */
function world(src, opt) {
  opt = opt || {};
  const F = { mode: 'direct', queue: [], faults: [], fired: 0, observe: null };
  const sb = {
    console: { log() {}, error() {}, warn() {} }, Logger: { log() {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) },
  };
  sb.SpreadsheetApp = { flush() { flushAll(); } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + src, sb, { filename: 'gs' });
  const ss = createSpreadsheet({ DateCtor: vm.runInContext('Date', sb), defaultMaxCols: 40, defaultMaxRows: opt.maxRows || 1000 });
  sb.SpreadsheetApp.getActive = () => ss; sb.SpreadsheetApp.openById = () => ss;
  sb.__SS = ss;
  vm.runInContext(`getSS = function () { return __SS; }; CONFIG.ADMIN_KEY = 'k'; nowTaipeiIso = function () { return '2026-11-22T09:00:00+08:00'; };`, sb);

  function exec(op) {
    for (const f of F.faults) {
      if (f.times > 0 && f.match(op)) {
        f.times--; F.fired++;
        if (f.how === 'half') {   // 只寫進前一半的列
          const k = Math.floor(op.vals.length / 2);
          if (k) op.sheet._origGetRange(op.r, op.c, k, op.nc).setValues(op.vals.slice(0, k));
        }
        throw new Error('模擬寫入失敗（' + f.how + '）');
      }
    }
    op.run();
    if (F.observe && op.data) F.observe(op);
  }
  function flushAll() {
    while (F.queue.length) {
      const op = F.queue.shift();
      try { exec(op); } catch (e) { F.queue = []; throw e; }
    }
  }
  function submit(op) { if (F.mode === 'buffered') F.queue.push(op); else exec(op); }
  const readFirst = (fn) => function () { if (F.mode === 'buffered') flushAll(); return fn.apply(this, arguments); };

  const origInsert = ss.insertSheet.bind(ss);
  ss.insertSheet = function (n) {
    const sh = origInsert(n);
    sh._origGetRange = sh.getRange.bind(sh);
    sh.getLastRow = readFirst(sh.getLastRow.bind(sh));
    sh.getMaxRows = readFirst(sh.getMaxRows.bind(sh));
    sh.getDataRange = readFirst(sh.getDataRange.bind(sh));
    const origClr = sh.clearContents.bind(sh);   // 整張清（各店 ot_month 舊寫法用）也一樣排隊
    sh.clearContents = function () { submit({ type: 'clearSheet', sheet: sh, name: n, data: true, run: () => origClr() }); return sh; };
    const origIns = sh.insertRowsAfter.bind(sh);
    sh.insertRowsAfter = function (r, k) { submit({ type: 'insertRows', sheet: sh, run: () => origIns(r, k) }); return sh; };
    sh.getRange = function (r, c, nr, nc) {
      const rg = sh._origGetRange(r, c, nr, nc);
      const w = Object.create(rg);
      w.getValues = readFirst(() => rg.getValues());
      w.setValues = (vals) => { submit({ type: 'setValues', sheet: sh, name: n, r, c, nr, nc, vals, data: r + nr - 1 >= 2 || n === 'ot_month', run: () => rg.setValues(vals) }); return w; };
      w.clearContent = () => { submit({ type: 'clearContent', sheet: sh, name: n, r, c, nr, nc, data: r + nr - 1 >= 2, run: () => rg.clearContent() }); return w; };
      w.setNumberFormat = (fmt) => { submit({ type: 'fmt', sheet: sh, run: () => rg.setNumberFormat(fmt) }); return w; };
      w.getLastRow = () => rg.getLastRow();
      return w;
    };
    return sh;
  };
  const W = { sb, ss, F, vm: (code) => vm.runInContext(code, sb) };
  W.sheetOf = (kind) => ss.getSheetByName(W.vm('PAY_SHEET_NAME')[kind]);
  W.state = (kind) => dump(W.sheetOf(kind));
  W.replace = (kind, rows) => { sb.__k = kind; sb.__rows = rows; return W.vm('payReplaceAll(__k, __rows)'); };
  return W;
}
/* 整張表的內容（值＋型別），日期換成數字比較 */
function dump(sh) {
  if (!sh) return '[]';
  const F0 = sh.getMaxRows; const lr = sh.cells.length ? (function () { for (let r = sh.cells.length; r >= 1; r--) { const row = sh.cells[r - 1]; if (row && row.some((x) => x !== undefined)) return r; } return 0; })() : 0;
  const out = [];
  for (let r = 1; r <= lr; r++) {
    const row = [];
    for (let c = 1; c <= 40; c++) {
      const v = sh._read(r, c), cell = sh._cell(r, c);
      row.push(cell ? cell.k + ':' + (Object.prototype.toString.call(v) === '[object Date]' ? 'D' + v.getTime() : String(v)) : '');
    }
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  return JSON.stringify(out);
}
function fmtDump(sh, nc) {
  const out = [];
  for (let r = 1; r <= sh.maxRows; r++) for (let c = 1; c <= nc + 1; c++) { const f = sh._fmtOf(r, c); if (f) out.push(r + ',' + c + '=' + f); }
  return out.join(';') + '|max=' + sh.maxRows;
}

/* ── 假資料（全部虛構，沒有真實姓名或金額）── */
let seed = 20261122;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CELLS = ['', null, undefined, 0, 1, -500, 28000.5, true, false, 'TRUE', 'false', '2026-11', '2026-11-03', '11:00', '00123', '=SUM(1)', '+A1', '-500',
               '測試甲', '測試乙 備註', '{"a":1}', '[{"code":"x","h":2}]', 'SSLGF', 'MZTGF', 'E01', 'x'.repeat(30)];
function makeRows(cols, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = { __extra: 'not-a-col' };
    cols.forEach((c) => { if (rnd() < 0.85) r[c] = pick(CELLS); });
    r[cols[0]] = 'K' + i + '-' + Math.floor(rnd() * 1000);
    rows.push(r);
  }
  return rows;
}

const KINDS = Object.keys(world(CUR).vm('PAY_SHEETS'));
const COLS = world(CUR).vm('PAY_SHEETS');

/* 一個情境：先寫好舊內容 → 設定失敗點 → 寫新內容 → 檢查 */
function scenario(src, kind, oldN, newN, setup) {
  const W = world(src);
  const cols = COLS[kind];
  const oldRows = makeRows(cols, oldN), newRows = makeRows(cols, newN);
  W.vm('paySheet(' + JSON.stringify(kind) + ')');   // 分頁先建好（舊內容 0 列＝只有表頭的空分頁）
  if (oldN) W.replace(kind, oldRows);
  W.vm('payInvalidate(' + JSON.stringify(kind) + ')');   // 一半情境用快取的舊內容、一半不用
  if (rnd() < 0.5) W.vm('payRead(' + JSON.stringify(kind) + ')');
  // 期望的「完整新內容」：另一個沒有失敗的環境寫同樣兩次
  const E = world(src);
  E.vm('paySheet(' + JSON.stringify(kind) + ')');
  if (oldN) E.replace(kind, oldRows);
  E.replace(kind, newRows);
  const before = W.state(kind), after = E.state(kind);
  setup(W);
  let err = null;
  try { W.replace(kind, newRows); W.sb.SpreadsheetApp.flush(); } catch (e) { err = e; }   // 呼叫端最後一定會送出（payWriteLocked_／執行結束）
  W.F.faults = []; W.F.mode = 'direct'; W.F.queue = [];
  const got = W.state(kind);
  return { before, after, got, err, fired: W.F.fired, W };
}
const isData = (op) => op.type === 'setValues' && op.data;
const FAULTS = {
  'F1 清空後立刻失敗': (W) => { W.F.faults = [{ match: isData, how: 'throw', times: 1 }]; },
  'F2 寫到一半失敗': (W) => { W.F.faults = [{ match: isData, how: 'half', times: 1 }]; },
  'F3 收尾（送出）失敗': (W) => { W.F.mode = 'buffered'; W.F.faults = [{ match: isData, how: 'throw', times: 1 }]; },
};
const SHAPES = [[0, 5], [6, 9], [9, 4], [7, 0], [3, 3]];
function runFaults(src) {
  for (const [name, setup] of Object.entries(FAULTS)) {
    for (const kind of KINDS) {
      for (const [oldN, newN] of SHAPES) {
        const r = scenario(src, kind, oldN, newN, setup);
        const tag = `${kind} ${oldN}→${newN}`;
        if (r.fired) {
          sec(name, !!r.err, tag + '：呼叫端收到錯誤');
          sec(name, r.got === r.before || r.got === r.after, tag + '：內容＝寫入前或完整新內容' + (r.got === r.before ? '' : r.got === r.after ? '' : '（實際是別的：' + r.got.slice(0, 80) + '）'));
        } else {
          sec(name, !r.err && r.got === r.after, tag + '：沒有觸發失敗時正常寫完');
        }
      }
    }
  }
}

/* F4 還原也失敗：要講清楚（殘餘風險） */
function runDoubleFault(src) {
  const W = world(src);
  W.replace('run', makeRows(COLS.run, 6));
  W.F.faults = [{ match: isData, how: 'half', times: 2 }];
  let err = null;
  try { W.replace('run', makeRows(COLS.run, 8)); } catch (e) { err = e; }
  sec('F4 還原也失敗', !!err, '呼叫端收到錯誤');
  sec('F4 還原也失敗', !!err && /還原也失敗/.test(err.message) && err.pay_restored === false, '錯誤訊息說還原也失敗（' + (err && err.message || '').slice(0, 40) + '）');
  const W2 = world(src);
  W2.replace('run', makeRows(COLS.run, 6));
  W2.F.faults = [{ match: isData, how: 'throw', times: 1 }];
  let e2 = null;
  try { W2.replace('run', makeRows(COLS.run, 8)); } catch (e) { e2 = e; }
  sec('F4 還原也失敗', !!e2 && /已還原/.test(e2.message) && e2.pay_restored === true, '只失敗一次時訊息說已還原、請再按一次');
}

/* F5 一次寫兩張：後面那張失敗，前面那張退回 */
function runMany(src) {
  const has = /function payReplaceMany_\(/.test(src);
  sec('F5 兩張一起寫', has, '有 payReplaceMany_');
  if (has) {
    for (const order of [['run', 'item'], ['item', 'run']]) {
      for (const how of ['throw', 'half']) {
        const W = world(src);
        W.replace('run', makeRows(COLS.run, 5)); W.replace('item', makeRows(COLS.item, 12));
        const b = { run: W.state('run'), item: W.state('item') };
        const nr = { run: makeRows(COLS.run, 7), item: makeRows(COLS.item, 9) };
        W.F.faults = [{ match: (op) => isData(op) && op.name === W.vm('PAY_SHEET_NAME')[order[1]], how, times: 1 }];
        W.sb.__pairs = order.map((k) => [k, nr[k]]);
        let err = null;
        try { W.vm('payReplaceMany_(__pairs)'); } catch (e) { err = e; }
        sec('F5 兩張一起寫', !!err, `${order.join('→')} 後面那張${how}：呼叫端收到錯誤`);
        sec('F5 兩張一起寫', W.state('run') === b.run && W.state('item') === b.item, `${order.join('→')} 後面那張${how}：兩張都＝寫入前`);
      }
    }
    const W = world(src);
    W.replace('run', makeRows(COLS.run, 5)); W.replace('item', makeRows(COLS.item, 12));
    const nr = { run: makeRows(COLS.run, 3), item: makeRows(COLS.item, 20) };
    const E = world(src); E.replace('run', makeRows(COLS.run, 0)); E.replace('run', nr.run); E.replace('item', nr.item);
    W.sb.__pairs = [['run', nr.run], ['item', () => nr.item]];
    W.vm('payReplaceMany_(__pairs)');
    sec('F5 兩張一起寫', W.state('run') === E.state('run') && W.state('item') === E.state('item'), '沒失敗時兩張都是完整新內容（rows 可以給函式）');
  }
  // handlePayrollCalc 的寫回段走 payReplaceMany_、順序照舊（有選舉假指紋先明細後彙總，沒有先彙總後明細）
  const i = src.indexOf('const wrote = payWriteLocked_([\'run\', \'item\']');
  const seg = i >= 0 ? src.slice(i, src.indexOf('if (!wrote) return PAY_BUSY_;', i)) : '';
  sec('F5 兩張一起寫', /payReplaceMany_\(\[itemPair, runPair\]\)[\s\S]*payReplaceMany_\(\[runPair, itemPair\]\)/.test(seg) && !/payReplaceAll\(/.test(seg),
      '薪資計算寫回段兩張一起寫，順序照舊');
}

/* F6 讀不到分頁時不可以當成空表整張覆寫 */
function runReadFail(src) {
  const cases = [
    ['leave_type', 'handlePayrollLeaveTypeSet', { store: 'SSLGF', types: [] }],
    ['leave_span', 'handlePayrollLeaveSpanSet', { store: 'SSLGF', spans: [] }],
    ['leave_event', 'handlePayrollLeaveEventSet', { store: 'SSLGF', events: [] }],
    ['xmap', 'handlePayrollXmapSet', { rows: [] }],
  ];
  for (const [kind, fn, body] of cases) {
    const W = world(src);
    const rows = makeRows(COLS[kind], 6).map((r, i) => Object.assign(r, { store: i % 2 ? 'MZTGF' : 'CF', pay_store: i % 2 ? 'mztgf' : 'cf', acct_only: '' }));
    W.replace(kind, rows);
    const before = W.state(kind);
    const sh = W.sheetOf(kind), orig = sh.getDataRange;
    let once = true;
    sh.getDataRange = function () { if (once) { once = false; throw new Error('模擬讀取失敗'); } return orig.apply(this, arguments); };
    W.vm('payInvalidate(' + JSON.stringify(kind) + ')');
    let res = null, err = null;
    try { W.sb.__b = Object.assign({ admin_key: 'k' }, body); res = W.vm(fn + '(__b)'); } catch (e) { err = e; }
    sh.getDataRange = orig;
    sec('F6 讀不到不當空表', W.state(kind) === before, `${kind}：別家店的列還在`);
    sec('F6 讀不到不當空表', !!err || (res && res.ok === false), `${kind}：呼叫端知道失敗`);
  }
}

/* F7 列數超過分頁格線 */
function runGrid(src) {
  const W = world(src, { maxRows: 12 });
  W.replace('run', makeRows(COLS.run, 8));
  const before = W.state('run');
  const nr = makeRows(COLS.run, 20);
  let err = null;
  try { W.replace('run', nr); } catch (e) { err = e; }
  const E = world(src, { maxRows: 100 }); E.replace('run', makeRows(COLS.run, 0)); E.replace('run', nr);
  const got = W.state('run');
  sec('F7 超過格線', (!err && got === E.state('run')) || (!!err && got === before), '20 列寫進 12 列的分頁：寫完整或維持原樣（' + (err ? '丟錯' : '寫完') + '）');
  sec('F7 超過格線', !err && got === E.state('run'), '先加列再寫，結果是完整新內容');
}

/* F8 同時有人在讀：每一個寫入動作之後別人讀到的，只能是舊的或新的 */
function runObserve(src) {
  let bad = 0, total = 0;
  for (const kind of ['run', 'item', 'holiday', 'master', 'cost_snapshot']) {
    for (const [oldN, newN] of SHAPES) {
      if (!oldN) continue;
      const W = world(src);
      const oldRows = makeRows(COLS[kind], oldN), newRows = makeRows(COLS[kind], newN);
      W.replace(kind, oldRows);
      const before = W.state(kind);
      const E = world(src); E.replace(kind, oldRows); E.replace(kind, newRows);
      const after = E.state(kind);
      const seen = [];
      W.F.observe = () => seen.push(W.state(kind));
      W.replace(kind, newRows);
      total++;
      if (!seen.every((s) => s === before || s === after)) bad++;
    }
  }
  sec('F8 同時有人在讀', bad === 0, `${total} 次覆寫，中途讀到空表或半張的次數 ${bad}`);
}

/* N1 正常路徑：改版前後逐格相同（值、型別、格式、格線大小） */
function runSame() {
  if (!baseSrc) { sec('N1 正常路徑', false, '讀不到改版前的 Payroll.gs（' + BASE + '）'); return; }
  let diff = 0, n = 0;
  for (const kind of KINDS) {
    for (let t = 0; t < 6; t++) {
      const s0 = seed;
      const A = world(baseSrc), B = world(CUR);
      const seq = [];
      for (let i = 0; i < 6; i++) seq.push(makeRows(COLS[kind], pick([0, 1, 3, 8, 15, 2, 0, 30])));
      for (const rows of seq) {
        A.replace(kind, rows); B.replace(kind, rows);
        // 中間穿插讀一次（讓新版有時用快取的舊內容、有時重讀）
        if (rnd() < 0.5) { A.vm(`payRead(${JSON.stringify(kind)})`); B.vm(`payRead(${JSON.stringify(kind)})`); }
        n++;
        const same = A.state(kind) === B.state(kind) && fmtDump(A.sheetOf(kind), COLS[kind].length) === fmtDump(B.sheetOf(kind), COLS[kind].length)
          && JSON.stringify(A.vm(`payRead(${JSON.stringify(kind)})`)) === JSON.stringify(B.vm(`payRead(${JSON.stringify(kind)})`));
        if (!same) { diff++; if (diff <= 3) fails.push('N1 不同：' + kind + ' seed=' + s0); }
      }
    }
  }
  sec('N1 正常路徑', diff === 0, `${KINDS.length} 張表 × 6 串 × 6 次覆寫＝${n} 次，改版前後逐格（值、型別、文字格式、格線、payRead 讀回）不同 ${diff} 次`);
}

/* N2 正常路徑（呼叫端）：真的存檔 handler 走一遍，改版前後每張表逐格相同 */
function runSameHandlers() {
  if (!baseSrc) return;
  const steps = [
    ['handlePayrollStoreSet', { stores: [{ code: 'SSLGF', name: '測試店甲', active: 'true' }, { code: 'MZTGF', name: '測試店乙', active: 'true' }] }],
    ['handlePayrollMasterSet', { store: 'SSLGF', master: [{ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: '30,000', hire_date: '2025-01-02', active: 'true' }, { emp_id: 'P01', name: '測試丙', is_full_time: 'false', wage: 200, active: 'true' }] }],
    ['handlePayrollMasterSet', { store: 'MZTGF', master: [{ emp_id: 'M01', name: '測試丁', is_full_time: 'true', base: 32000, active: 'true' }] }],
    ['handlePayrollMasterSet', { store: 'SSLGF', master: [{ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: 31000, active: 'true' }] }],
    ['handlePayrollConfigSet', { store: 'SSLGF', config: { daily_hours: 8, payday: 5 }, keys: true }],
    ['handlePayrollConfigSet', { store: '', config: { late_deduct_from: '2026-10' } }],
    ['handlePayrollHolidaySet', { store: '', holidays: [{ ym: '2026-11', red_days: 9, dates: '2026-11-01,2026-11-02', note: '' }, { ym: '2026-12', red_days: 9, dates: '', note: '' }] }],
    ['handlePayrollBonusSet', { store: 'SSLGF', ym: '2026-11', bonuses: [{ emp_id: 'E01', bonus_type: 'sales', amount: 1500, label: '=x', memo: '' }] }],
    ['handlePayrollBonusSet', { store: 'MZTGF', ym: '2026-11', bonuses: [{ emp_id: 'M01', bonus_type: 'perf', amount: 800 }] }],
    ['handlePayrollBonusSet', { store: 'SSLGF', ym: '2026-11', bonuses: [] }],
    ['handlePayrollLeaveTypeSet', { store: 'SSLGF', types: [{ code: 'personal', name: '事假', pay_ratio: 0, window_days: '' }] }],
    ['handlePayrollLeaveSpanSet', { store: 'SSLGF', spans: [{ emp_id: 'E01', name: '測試甲', code: 'parental', start: '2026-11-01', end: '2027-01-31', months: 3 }] }],
    ['handlePayrollLeaveEventSet', { store: 'SSLGF', events: [{ emp_id: 'E01', name: '測試甲', code: 'marriage', event_date: '2026-11-10' }] }],
    ['handlePayrollLeaveEventSet', { store: 'MZTGF', events: [{ emp_id: 'M01', name: '測試丁', code: 'bereave', event_date: '2026-10-30' }] }],
  ];
  const A = world(baseSrc), B = world(CUR);
  let diff = 0, okN = 0;
  for (const [fn, body] of steps) {
    A.sb.__b = Object.assign({ admin_key: 'k' }, JSON.parse(JSON.stringify(body)));
    B.sb.__b = Object.assign({ admin_key: 'k' }, JSON.parse(JSON.stringify(body)));
    const ra = A.vm(fn + '(__b)'), rb = B.vm(fn + '(__b)');
    if (rb && rb.ok) okN++;
    if (JSON.stringify(ra) !== JSON.stringify(rb)) { diff++; fails.push('N2 回應不同：' + fn); }
    for (const kind of KINDS) {
      if (A.state(kind) !== B.state(kind)) { diff++; fails.push('N2 不同：' + fn + ' → ' + kind); }
    }
  }
  sec('N2 正常路徑（存檔）', okN === steps.length, `${steps.length} 次存檔都成功（${okN}）`);
  sec('N2 正常路徑（存檔）', diff === 0, `每次存檔後 ${KINDS.length} 張表與回應改版前後不同 ${diff} 處`);
}

/* ── 各店月加班表 ot_month（payOtMonthSync_，每天 09:00；打卡端 Rest.gs 讀它擋 46 小時）──
   以前先 clearContents 整張再寫。計算本身（handlePayrollCalc 試算）換成固定假結果，只測「寫進去」這段。 */
function otWorld(src) {
  const W = world(src);
  W.vm(`
    payHasClock = function () { return true; };
    payClockSS = function () { return __SS; };
    handlePayrollCalc = function (b) {
      var d = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd'), res = [];
      (__PEOPLE || []).forEach(function (p, i) { var o = {}; o[d] = p.h; res.push({ name: p.name, emp_id: 'E' + i, ot_info: { ot_h: p.h }, _ot_days: o }); });
      return { ok: true, results: res, _sched: {}, _hol: [] };
    };
  `);
  W.replace('store', [{ code: 'SSLGF', name: '測試店甲', active: 'true' }]);
  W.sync = (people) => { W.sb.__PEOPLE = people; return W.vm('payOtMonthSync_()'); };
  W.ot = () => dump(W.ss.getSheetByName('ot_month'));
  return W;
}
const people = (n, tag) => { const a = []; for (let i = 0; i < n; i++) a.push({ name: '測試' + tag + i, h: Math.round(rnd() * 500) / 10 }); return a; };
/* 舊內容：先同步一次；extra＝分頁上另外有第 8～9 欄的舊字（舊寫法 clearContents 會一起清掉） */
function otSeed(W, n, extra) {
  W.sync(people(n, 'A'));
  if (extra) { const sh = W.ss.getSheetByName('ot_month'); sh._origGetRange(2, 8, 1, 2).setValues([['舊備註', '2026-10-01']]); }
}
const OT_SHAPES = [[4, 7, false], [9, 3, false], [5, 0, false], [6, 6, true], [0, 5, false]];
const isOt = (op) => op.type === 'setValues' && op.name === 'ot_month';
function runOtFaults(src) {
  const FA = {
    'G1 ot_month 清空後立刻失敗': (W) => { W.F.faults = [{ match: isOt, how: 'throw', times: 1 }]; },
    'G2 ot_month 寫到一半失敗': (W) => { W.F.faults = [{ match: isOt, how: 'half', times: 1 }]; },
    'G3 ot_month 收尾（送出）失敗': (W) => { W.F.mode = 'buffered'; W.F.faults = [{ match: isOt, how: 'throw', times: 1 }]; },
  };
  for (const [name, setup] of Object.entries(FA)) {
    for (const [oldN, newN, extra] of OT_SHAPES) {
      const s0 = seed;
      const W = otWorld(src); if (oldN || extra) otSeed(W, oldN, extra);
      seed = s0;
      const E = otWorld(src); if (oldN || extra) otSeed(E, oldN, extra);
      const s1 = seed;
      const pB = people(newN, 'B');
      E.sync(pB);
      const before = W.ot(), after = E.ot();
      setup(W);
      let res = null, err = null;
      try { res = W.sync(pB); W.sb.SpreadsheetApp.flush(); } catch (e) { err = e; }
      W.F.faults = []; W.F.mode = 'direct'; W.F.queue = [];
      const got = W.ot(), told = !!err || !!(res && (res.write_errors || []).length);
      const tag = `${oldN}→${newN}${extra ? '（有舊備註欄）' : ''}`;
      if (W.F.fired) {
        sec(name, told, tag + '：呼叫端知道失敗（write_errors／錯誤）');
        sec(name, got === before || got === after, tag + '：內容＝寫入前或完整新內容' + (got === before || got === after ? '' : '（實際：' + got.slice(0, 80) + '）'));
      } else sec(name, !err && got === after, tag + '：沒有觸發失敗時正常寫完');
      seed = s1;
    }
  }
  // 同時有人在讀（打卡端 Rest.gs 這時讀到空表會當成「沒有加班」、還會快取起來）
  let bad = 0, total = 0;
  for (const [oldN, newN, extra] of OT_SHAPES) {
    if (!oldN) continue;
    const s0 = seed;
    const W = otWorld(src); otSeed(W, oldN, extra);
    seed = s0;
    const E = otWorld(src); otSeed(E, oldN, extra);
    const pB = people(newN, 'B'); E.sync(pB);
    const before = W.ot(), after = E.ot(), seen = [];
    W.F.observe = () => seen.push(W.ot());
    W.sync(pB);
    total++;
    if (!seen.every((x) => x === before || x === after)) bad++;
  }
  sec('G4 ot_month 同時有人在讀', bad === 0, `${total} 次同步，中途讀到空表或半張的次數 ${bad}`);
  // 格線不夠：分頁只有 5 列、要寫 12 人
  {
    const W = otWorld(src); otSeed(W, 3, false);
    W.ss.getSheetByName('ot_month').maxRows = 5;
    const pB = people(12, 'B');
    const res = W.sync(pB);
    const E = otWorld(src); E.sync(pB);
    sec('G5 ot_month 超過格線', W.ot() === E.ot() && !(res.write_errors || []).length, '12 人寫進 5 列的分頁：先加列、寫完整');
  }
}
function runOtSame() {
  if (!baseSrc) return;
  let diff = 0, n = 0;
  for (let t = 0; t < 12; t++) {
    const A = otWorld(baseSrc), B = otWorld(CUR);
    const s0 = seed;
    if (t % 3 === 1) { otSeed(A, 4, true); seed = s0; otSeed(B, 4, true); }
    for (let i = 0; i < 5; i++) {
      const p = people(pick([0, 1, 3, 8, 20, 2]), 'S' + i);
      const ra = A.sync(p), rb = B.sync(p);
      n++;
      const shA = A.ss.getSheetByName('ot_month'), shB = B.ss.getSheetByName('ot_month');
      if (A.ot() !== B.ot() || fmtDump(shA, 9) !== fmtDump(shB, 9) || JSON.stringify(ra) !== JSON.stringify(rb)) { diff++; if (diff <= 3) fails.push('G6 不同：t=' + t + ' i=' + i); }
    }
  }
  sec('G6 ot_month 正常路徑', diff === 0, `${n} 次同步，改版前後（值、型別、文字格式、格線、回應）不同 ${diff} 次`);
}

/* H 分頁上的表頭順序跟 PAY_SHEETS 不同（有人手動調過欄、或多一欄 PAY_SHEETS 沒有的）：
   寫入失敗＋還原後，整張（含表頭列）要跟寫入前逐格相同、payRead 讀回的每列物件也相同。
   另外記下「正常寫入」時那一欄會怎樣（既有行為，跟 4f929d3 一樣就好，不改）。 */
function hdrSeed(W, layout) {
  const sh = W.vm('paySheet("bonus")') && W.sheetOf('bonus');
  const vals = [layout].concat([0, 1, 2, 3].map((i) => layout.map((c) => c + '-' + i)));
  sh._origGetRange(1, 1, vals.length, layout.length).setValues(vals);
  return sh;
}
function runHeaderOrder(src) {
  const cols = COLS.bonus;   // ym, store, emp_id, bonus_type, label, amount, memo, updated_at
  const LAYOUTS = {
    '欄位順序對調': [cols[1], cols[0]].concat(cols.slice(2)),
    '中間多一欄': cols.slice(0, 3).concat(['手寫備註']).concat(cols.slice(3)),
    '對調＋最後多一欄': [cols[2], cols[0], cols[1]].concat(cols.slice(3)).concat(['手寫備註']),
  };
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    for (const warm of [true, false]) {
      for (const how of ['throw', 'half']) {
        const W = world(src);
        hdrSeed(W, layout);
        W.vm('payInvalidate("bonus")');
        const objBefore = JSON.stringify(W.vm('payRead("bonus")'));
        W.vm('payInvalidate("bonus")');
        if (warm) W.vm('payRead("bonus")');
        const before = W.state('bonus');
        W.F.faults = [{ match: isData, how, times: 1 }];
        let err = null;
        try { W.replace('bonus', makeRows(cols, 6)); } catch (e) { err = e; }
        W.F.faults = [];
        W.vm('payInvalidate("bonus")');
        const tag = `${name}／${warm ? '用讀的當下那份' : '沒讀過'}／${how}`;
        sec('H 表頭順序不同', !!err, tag + '：呼叫端收到錯誤');
        sec('H 表頭順序不同', W.state('bonus') === before, tag + '：整張（含表頭列）＝寫入前');
        sec('H 表頭順序不同', JSON.stringify(W.vm('payRead("bonus")')) === objBefore, tag + '：payRead 讀回每列物件＝寫入前');
      }
    }
  }
}
function headerNormalNote() {
  if (!baseSrc) return [];
  const out = [];
  const cols = COLS.bonus;
  for (const layout of [cols.slice(0, 3).concat(['手寫備註']).concat(cols.slice(3)), cols.concat(['手寫備註'])]) {
    const s0 = seed;
    const A = world(baseSrc), B = world(CUR);
    hdrSeed(A, layout); hdrSeed(B, layout);
    const rows = makeRows(cols, 3); seed = s0;
    A.replace('bonus', rows); B.replace('bonus', rows);
    const same = A.state('bonus') === B.state('bonus');
    sec('H 表頭順序不同', same, '正常寫入：額外欄在第 ' + (layout.indexOf('手寫備註') + 1) + ' 欄時，結果跟改版前逐格相同');
    const sh = B.sheetOf('bonus'), c = layout.indexOf('手寫備註') + 1;
    out.push('額外欄在第 ' + c + ' 欄：正常寫入後表頭＝' + JSON.stringify(sh._read(1, c)) + '、第 2 列＝' + JSON.stringify(sh._read(2, c)) + '（改版前' + (same ? '相同' : '不同') + '）');
  }
  return out;
}

/* 每次 payReplaceAll 的試算表呼叫數（給 PR 描述的估計） */
function countCalls(src, kind, oldN, newN, warm) {
  const W = world(src);
  W.replace(kind, makeRows(COLS[kind], oldN));
  W.vm(`payInvalidate(${JSON.stringify(kind)})`);
  if (warm) W.vm(`payRead(${JSON.stringify(kind)})`);
  const cnt = {};
  const sh = W.sheetOf(kind);
  const wrap = (obj, name) => { const o = obj[name]; obj[name] = function () { cnt[name] = (cnt[name] || 0) + 1; return o.apply(this, arguments); }; };
  ['getLastRow', 'getMaxRows', 'insertRowsAfter'].forEach((m) => wrap(sh, m));
  const og = sh.getRange;
  sh.getRange = function () {
    const w = og.apply(this, arguments);
    ['setValues', 'getValues', 'clearContent', 'setNumberFormat'].forEach((m) => wrap(w, m));
    return w;
  };
  const of = W.sb.SpreadsheetApp.flush; W.sb.SpreadsheetApp.flush = function () { cnt.flush = (cnt.flush || 0) + 1; return of.apply(this, arguments); };
  W.replace(kind, makeRows(COLS[kind], newN));
  return cnt;
}

runFaults(CUR);
runDoubleFault(CUR);
runMany(CUR);
runReadFail(CUR);
runGrid(CUR);
runObserve(CUR);
runOtFaults(CUR);
runHeaderOrder(CUR);
const HDR_NOTE = (!process.env.PAYRA_SRC || process.env.PAYRA_N1) ? headerNormalNote() : [];
if (!process.env.PAYRA_SRC || process.env.PAYRA_N1) { runSame(); runSameHandlers(); runOtSame(); }   // PAYRA_N1=1：拿 PAYRA_SRC 那版跟改版前比（驗這組抓得到差異）

console.log('\n各組結果（通過／失敗）：');
Object.keys(section).forEach((k) => console.log('  ' + (section[k][1] ? '✗ ' : '✓ ') + k + '：' + section[k][0] + '／' + section[k][1]));
if (!process.env.PAYRA_SRC && baseSrc) {
  const fmt = (c) => Object.keys(c).sort().map((k) => k + '×' + c[k]).join('、');
  console.log('\n每次覆寫的試算表呼叫（run 表，舊 40 列 → 新 42 列）：');
  console.log('  改版前：' + fmt(countCalls(baseSrc, 'run', 40, 42, true)));
  console.log('  現在（鎖內剛 payRead 過，用讀的當下那份）：' + fmt(countCalls(CUR, 'run', 40, 42, true)));
  console.log('  現在（沒有讀過，要多讀一次）：' + fmt(countCalls(CUR, 'run', 40, 42, false)));
}
if (HDR_NOTE.length) { console.log('\n正常寫入時 PAY_SHEETS 沒有的欄（既有行為）：'); HDR_NOTE.forEach((x) => console.log('  ' + x)); }
if (fails.length) { console.log('\n失敗明細（前 15 筆）：'); fails.slice(0, 15).forEach((m) => console.log('  ✗ ' + m)); }
console.log(`\n${fail ? '❌' : '✅'} pay-replaceall-safe：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
