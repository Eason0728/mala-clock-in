/* 月結狀態唯讀查詢 payroll_status（2026-11-22 待辦 10，選舉假 Codex 第四次 SHOULD-FIX）
 * 用途：薪資頁按「鎖定本月」後回應斷掉／逾時，前端用它確認剛才那次有沒有鎖成功。
 * 守的事：
 *   1. 回 final／draft／none、選舉假名單改過的草稿回 elec_stale（同 payroll_month 的判斷）。
 *   2. 純唯讀：不寫任何分頁（payReplaceAll／payAppend 0 次、假資料庫前後逐字相同）、不取鎖、不寫快取；
 *      對照組：同一個情境 payroll_month 會自動重算寫回（證明這支測試抓得到寫入）。
 *   3. 權限＝payroll_month（選舉假名單的讀取路徑）：管理金鑰錯、門市不在負責範圍、scope 形狀錯一律擋，八種身分逐一跟 payroll_month 同結果。
 * 假資料借 election-day-emp.test.js 的 world()（虛構同仁，不碰正式試算表）。 */
'use strict';
const fs = require('fs'), path = require('path');
const T = fs.readFileSync(path.join(__dirname, 'election-day-emp.test.js'), 'utf8');
const cut = T.indexOf('const BASE_REF');
const mod = { exports: {} };
new Function('require', 'module', '__dirname', T.slice(0, cut).replace("'use strict';", '') + '\nmodule.exports = { world };')(require, mod, __dirname);
const { world } = mod.exports;

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

/* 假試算表（2026-11-22 後續 PR，Codex 複審 SHOULD-FIX 2）：payroll_status 改成用一次取得的分頁物件直接讀格子，
   world() 原本的分頁替身是空物件，這裡換成「用假資料庫的列組出 getDataRange().getValues()」的分頁；
   分頁不存在（假資料庫沒有這個 kind）＝getSheetByName 回 null。建分頁、寫格子都記數（payroll_status 一律應為 0）。 */
function fakeBook(w, opt) {
  opt = opt || {};
  const sb = w.sb, c = { insert: 0, setValues: 0, getSS: 0 };
  const kindOf = (name) => Object.keys(w.F('PAY_SHEET_NAME')).filter((k) => w.F('PAY_SHEET_NAME')[k] === name)[0];
  const sheetOf = (kind) => ({
    getDataRange: () => ({ getValues: () => {
      const rows = w.DB[kind] || [], cols = (w.F('PAY_SHEETS')[kind] || []).slice();
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (cols.indexOf(k) < 0) cols.push(k); }));
      return [cols].concat(rows.map((r) => cols.map((k) => (r[k] === undefined || r[k] === null ? '' : r[k]))));
    } }),
    getRange: () => ({ setValues: () => { c.setValues++; }, setNumberFormat() {} }),
    setFrozenRows() {}, getMaxRows: () => 1000,
  });
  sb.SpreadsheetApp.openById = () => {
    c.getSS++;
    if (opt.throwOn && opt.throwOn.indexOf(c.getSS) >= 0) throw new Error('Service Spreadsheets timed out（測試）');
    return {
      getSheetByName: (name) => { const k = kindOf(name); return k && (k in w.DB) && !(opt.missing || []).includes(k) ? sheetOf(k) : null; },
      insertSheet: (name) => { c.insert++; return sheetOf(kindOf(name)); },
    };
  };
  return c;
}

/* 包一層計數：寫表、取鎖、寫快取 */
function spy(w) {
  const sb = w.sb, c = { write: 0, lock: 0 };
  sb.__CNT = c;
  fakeBook(w);
  require('vm').runInContext(`
    (function(){ const R = payReplaceAll, A = payAppend;
      payReplaceAll = function(k, rows){ globalThis.__CNT.write++; return R(k, rows); };
      payAppend = function(k, rows){ globalThis.__CNT.write++; return A(k, rows); };
      const L = LockService.getScriptLock; LockService.getScriptLock = function(){ globalThis.__CNT.lock++; return L(); };
      checkAdmin = function(b){ return !!b && (b.admin_key === 'good' || b.admin_key === 'x'); };   // 'x'＝world().calc() 自己用的
    })();`, sb);
  sb.__PUTS.length = 0;
  return c;
}
const H = (w, act) => w.F('PAYROLL_HANDLERS')[act];
const snap = (w) => JSON.stringify(w.DB);

console.log('══ 1) 狀態 ══');
{
  const w = world({});
  const fn = H(w, 'payroll_status');
  chk('  有 payroll_status 這支', typeof fn, 'function');
  if (typeof fn === 'function') {
    spy(w);
    chk('  還沒有月結列 → none', fn({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' }).status, 'none');
    w.calc();
    const d = fn({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' });
    chk('  算過草稿 → draft、列數＝人數、elec_stale false', [d.ok, d.ym, d.store, d.status, d.rows, d.elec_stale], [true, '2026-11', 'SSLGF', 'draft', w.DB.master.length, false]);
    w.DB.run.forEach((r) => { r.status = 'final'; });
    chk('  每列都是 final → final', fn({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' }).status, 'final');
    w.DB.run[0].status = 'draft';
    chk('  有 final 也有草稿 → mixed（照實回）', fn({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' }).status, 'mixed');
    chk('  別的月份 → none', fn({ admin_key: 'good', ym: '2026-10', store: 'SSLGF' }).status, 'none');
    chk('  月份格式錯 → bad_ym', fn({ admin_key: 'good', ym: '2026-1', store: 'SSLGF' }).error, 'bad_ym');
  }
}

console.log('══ 2) 唯讀：不寫表、不取鎖、不寫快取 ══');
{
  /* 選舉假名單改過、草稿還是舊名單算的：payroll_month 會自動重算寫回；payroll_status 只回 elec_stale */
  const mk = () => { const w = world({ elec: ['a'] }); w.calc(); w.DB.hol_emp.push(Object.assign({}, w.DB.hol_emp[0], { emp_id: 'E2', name: '乙君' })); return w; };
  const w = mk();
  if (typeof H(w, 'payroll_status') === 'function') {
    const c = spy(w), before = snap(w);
    const r = H(w, 'payroll_status')({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' });
    chk('  名單改過的草稿 → draft＋elec_stale true', [r.status, r.elec_stale], ['draft', true]);
    chk('  寫表 0 次、取鎖 0 次、寫快取 0 次', [c.write, c.lock, w.sb.__PUTS.length], [0, 0, 0]);
    chk('  假資料庫前後逐字相同', snap(w) === before, true);
    for (const st of ['final', 'none']) {
      const w2 = world({ elec: ['a'] }); if (st === 'final') { w2.calc(); w2.DB.run.forEach((x) => { x.status = 'final'; }); }
      const c2 = spy(w2), b2 = snap(w2);
      const r2 = H(w2, 'payroll_status')({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' });
      chk('  ' + st + '：elec_stale false、寫表 0、資料庫不變', [r2.status, r2.elec_stale, c2.write, snap(w2) === b2], [st, false, 0, true]);
    }
  }
  /* 對照組：同一情境 payroll_month 會寫（證明上面的計數抓得到寫入） */
  const wm = mk(), cm = spy(wm), bm = snap(wm);
  H(wm, 'payroll_month')({ admin_key: 'good', ym: '2026-11', store: 'SSLGF' });
  chk('  對照組：同情境 payroll_month 有寫表（自動重算）、資料庫有變', [cm.write > 0, snap(wm) !== bm], [true, true]);
}

console.log('══ 3) 權限＝payroll_month ══');
{
  const bodies = [
    ['金鑰錯', { admin_key: 'bad' }],
    ['沒有金鑰', {}],
    ['金鑰對、沒有 scope', { admin_key: 'good' }],
    ['金鑰對、scope *', { admin_key: 'good', scope: '*' }],
    ['金鑰對、負責本店', { admin_key: 'good', scope: ['sslgf '] }],
    ['金鑰對、只負責別店', { admin_key: 'good', scope: ['CF'] }],
    ['金鑰對、空名單', { admin_key: 'good', scope: [] }],
    ['金鑰對、scope 形狀錯', { admin_key: 'good', scope: 'CF' }],
    ['金鑰錯、負責本店', { admin_key: 'bad', scope: ['SSLGF'] }],
  ];
  const w = world({}); w.calc();
  if (typeof H(w, 'payroll_status') === 'function') {
    spy(w);
    const cls = (r) => r && r.ok ? 'ok' : (r && r.error) + (r && r.detail ? ':' + String(r.detail).slice(0, 12) : '');
    bodies.forEach(([lab, b]) => {
      const base = Object.assign({ ym: '2026-11', store: 'SSLGF' }, b);
      const s = cls(H(w, 'payroll_status')(JSON.parse(JSON.stringify(base))));
      const m = cls(H(w, 'payroll_month')(JSON.parse(JSON.stringify(base))));
      chk('  ' + lab + '：payroll_status ' + s + '＝payroll_month ' + m, s, m);
    });
    chk('  金鑰錯 → unauthorized、不回狀態', H(w, 'payroll_status')({ admin_key: 'bad', ym: '2026-11', store: 'SSLGF' }), { ok: false, error: 'unauthorized' });
    const r = H(w, 'payroll_status')({ admin_key: 'good', scope: ['CF'], ym: '2026-11', store: 'SSLGF' });
    chk('  只負責別店 → scope_forbidden、不回狀態', [r.ok, r.error, 'status' in r], [false, 'scope_forbidden', false]);
    chk('  沒有列進「限系統管理者」清單（跟 payroll_month 一樣，負責本店的人可查）', w.F('PAY_SCOPE_ADMIN_ONLY').indexOf('payroll_status'), -1);
  }
}

console.log('══ 5) 預查丟例外：不建分頁、不寫格子、回錯誤（不可當成「沒有資料」）（Codex 複審 SHOULD-FIX 2，2026-11-22 後續 PR）══');
{
  /* 換回正式的 payRead／paySheet（world() 把 payRead 換成讀假資料庫的替身，不會走到 paySheet 建分頁那一步）：
     這一段要證明的就是「payroll_status 不會經 payRead → paySheet 把不存在的分頁建出來」 */
  const GS = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
  const slice = (a, b) => GS.slice(GS.indexOf(a), GS.indexOf(b));
  const realRead = slice('function paySheet(kind)', 'function ensurePayrollSheets') + '\n' + slice('function payRead(kind)', 'function payHdrSame_');
  // prep：換回正式讀法之前先用 world() 的替身算好草稿（正式 payRead 有請求內快取，替身的寫入不會讓它失效）
  const mkW = (o, prep) => { const w = world(o); if (prep) prep(w); spy(w); require('vm').runInContext(realRead, w.sb); return w; };
  // 每次查詢＝一個新請求：Apps Script 每次執行全域變數都是新的，請求內快取（PAY_READ_CACHE）從空的開始（草稿計算時留下的不算）
  const ask = (w, ym) => { w.F('PAY_READ_CACHE = {}; PAY_RAW_CACHE = {}; 0'); return H(w, 'payroll_status')({ admin_key: 'good', ym: ym || '2026-11', store: 'SSLGF' }); };
  const isErr = (r) => !!r && r.ok === false && r.error === 'status_read_failed' && !('status' in r);

  /* 5a：run 分頁不存在、第一次開試算表丟例外（逾時）、第二次正常 */
  {
    const w = mkW({}); delete w.DB.run;
    const c = fakeBook(w, { throwOn: [1] }), before = snap(w);
    const r = ask(w);
    chk('  5a run 預查丟例外 → 回 status_read_failed、不回 status', [r.ok, r.error, 'status' in r], [false, 'status_read_failed', false]);
    chk('  5a 建分頁 0 次、寫格子 0 次、只開一次試算表（不重試走到建表）', [c.insert, c.setValues, c.getSS], [0, 0, 1]);
    chk('  5a 假資料庫不變（沒有多出 run 分頁）', [snap(w) === before, 'run' in w.DB], [true, false]);
  }
  /* 5b：有選舉假的生效月份、草稿：run 讀得到，名單分頁不存在、名單預查那次丟例外 */
  {
    const w = mkW({}, (x) => x.calc()); delete w.DB.hol_emp;
    const n = fakeBook(w, {}); ask(w); const nOpen = n.getSS;   // 正常情況開幾次試算表（run 一次、名單一次）
    const c = fakeBook(w, { throwOn: [nOpen] }), before = snap(w);
    const r = ask(w);
    chk('  5b 正常情況：run 一次、名單一次', nOpen, 2);
    chk('  5b 名單預查丟例外 → 回 status_read_failed（不當成「沒有名單、沒過期」）', isErr(r), true);
    chk('  5b 建分頁 0 次、寫格子 0 次、假資料庫不變', [c.insert, c.setValues, snap(w) === before, 'hol_emp' in w.DB], [0, 0, true, false]);
  }
  /* 5c：getSheetByName 本身丟例外（試算表開得了、查分頁失敗） */
  {
    const w = mkW({}); const c = fakeBook(w, {});
    const ob = w.sb.SpreadsheetApp.openById; let k = 0;
    w.sb.SpreadsheetApp.openById = () => { const ss = ob(); return Object.assign({}, ss, { getSheetByName: (nm) => { if (++k === 1) throw new Error('查分頁失敗（測試）'); return ss.getSheetByName(nm); } }); };
    const r = ask(w);
    chk('  5c getSheetByName 丟例外 → status_read_failed、建分頁 0 次', [isErr(r), c.insert, c.setValues], [true, 0, 0]);
  }
  /* 5d：對照組（不丟例外）：分頁不存在＝none、不建分頁；分頁存在照讀 */
  {
    const w = mkW({}); delete w.DB.run; const c = fakeBook(w, {});
    const r = ask(w);
    chk('  5d run 分頁不存在（正常）→ none、建分頁 0 次', [r.ok, r.status, c.insert, c.setValues], [true, 'none', 0, 0]);
    const w2 = mkW({ elec: ['a'] }, (x) => x.calc()); w2.DB.hol_emp.push(Object.assign({}, w2.DB.hol_emp[0], { emp_id: 'E2', name: '乙君' }));
    const c2 = fakeBook(w2, {});
    const r2 = ask(w2);
    chk('  5d 分頁都在、名單改過 → draft＋elec_stale true（直接讀格子跟原本讀法同結果）', [r2.ok, r2.status, r2.rows, r2.elec_stale, c2.insert], [true, 'draft', w2.DB.master.length, true, 0]);
  }
  /* 5f：直接呼叫 payReadNoCreate_（驗收員第 2 點：分頁「真的不存在」＝getSheetByName 回 null 的案例要釘住） */
  {
    const w = mkW({}); delete w.DB.run; const c = fakeBook(w, {});
    w.F('PAY_READ_CACHE = {}; 0');
    const got = w.F("JSON.stringify(payReadNoCreate_('run'))");
    chk('  5f run 分頁不存在：payReadNoCreate_ 回 []、建分頁 0 次、寫格子 0 次', [got, c.insert, c.setValues], ['[]', 0, 0]);
    const w2 = mkW({}, (x) => x.calc()); const c2 = fakeBook(w2, {});
    w2.F('PAY_READ_CACHE = {}; 0');
    const rows = JSON.parse(w2.F("JSON.stringify(payReadNoCreate_('run'))"));
    chk('  5f run 分頁存在：照格子讀出每一列（列數、狀態欄）、建分頁 0 次', [rows.length, rows.every((r) => r.status === 'draft' && !('__rowIndex' in r)), c2.insert], [w2.DB.run.length, true, 0]);
  }
  /* 5e：別的路徑照舊（payRead／paySheet 一行都沒改）：正式 payRead 遇到分頁不存在仍會建分頁（既有行為） */
  {
    const w = mkW({}); delete w.DB.run; const c = fakeBook(w, {});
    w.F("payRead('run')");
    chk('  5e 對照：其他路徑的 payRead 遇到分頁不存在照舊建分頁（證明這裡抓得到建表）', c.insert, 1);
  }
}

console.log('══ 4) 薪資金額不變：本次改動前（main 4f929d3）vs 現在，同一份資料整條 handlePayrollCalc 逐欄相同 ══');
{
  let before = null;
  try { before = require('child_process').execFileSync('git', ['show', '4f929d3:apps-script/Payroll.gs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { before = null; }
  chk('  找得到基準 4f929d3 的 Payroll.gs', !!before, true);
  if (before) {
    for (const [lab, o] of [['沒有名單', {}], ['名單空白', { elec: [] }], ['勾 a b g m', { elec: ['a', 'b', 'g', 'm'] }], ['全部勾選', { elec: 'abcdefghijklm'.split('') }], ['11/28 同時是國定假日', { elec: ['a', 'g'], hol: '2026-11-28' }]]) {
      const wa = world(Object.assign({}, o, { gs: before })), wb = world(o);
      const A = wa.calc().res, B = wb.calc().res;
      chk('  ' + lab + '：results 逐欄相同（' + A.results.length + ' 人）', JSON.stringify(B.results) === JSON.stringify(A.results), true);
      chk('  ' + lab + '：寫進 run／item 的列相同', JSON.stringify([wb.DB.run, wb.DB.item]) === JSON.stringify([wa.DB.run, wa.DB.item]), true);
    }
  }
}

console.log(fail ? `\n❌ ${pass} 過、${fail} 失敗` : `\n✅ ${pass} 過、0 失敗`);
process.exit(fail ? 1 : 0);
