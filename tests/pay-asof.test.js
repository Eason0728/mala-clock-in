/* 月中草稿算到昨天（Eason 2026-11-17 定案；Payroll.gs payAsOfMode_）
 *  ① 本月：handlePayrollCalc 只算到昨天，正職底薪津貼照在職比例折算，run 列記 as_of
 *  ② 本月的結果分類後＝損益月中估算（handlePnlLaborEstimate_）同一天的數字
 *  ③ 整個月過完（隔月 1 號起）＝改版前的整月算法，逐人逐項相同（拿 git 上一版 Payroll.gs 當對照）
 *  ④ 過去的月份、dry_run＋full_month：跟改版前逐人逐項相同
 *  ⑤ 1 號沒有昨天；月中不能鎖定；月中草稿跨月後不能直接鎖
 *  ⑥ 開頁自動換成昨天那一份；每天排程只重算草稿
 * 全部虛構姓名與金額。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const C = rd('Code.gs'), SP = rd('SchedPub.gs'), P_NEW = rd('Payroll.gs');
/* 對照組：這個功能加進來之前的 Payroll.gs（PAY_ASOF_BASE 可指定；CI 抓不到歷史就略過 ③④ 的新舊比對並說明） */
let P_OLD = null;
try { P_OLD = cp.execSync('git show ' + (process.env.PAY_ASOF_BASE || '3318d6c') + ':apps-script/Payroll.gs', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString(); } catch (e) { P_OLD = null; }

let pass = 0, fail = 0;
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '\n    實得 ' + (g || '').slice(0, 600) + '\n    應為 ' + (w || '').slice(0, 600)));
}
const J = (x) => JSON.parse(JSON.stringify(x));

function world(src, fx) {
  const cache = {};
  const sb = { console, Logger: { log() {} },
    Utilities: { formatDate(date, tz, fmt) {
      const d = new Date(date.getTime() + 8 * 3600 * 1000), p = (n) => String(n).padStart(2, '0');
      const s = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
      return fmt === 'yyyy-MM-dd' ? s : s + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + '+08:00';
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'PNL_KEY' ? 'k-pnl' : null), setProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put(k, v) { cache[k] = String(v); }, remove(k) { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { flush() {}, getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => { throw new Error('no trigger in test'); } },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + src + '\n' + SP, sb);
  sb.__DB = J(fx.db); sb.__CLOCK = J(fx.clock); sb.__TODAY = fx.today; sb.__NOTIFY = [];
  vm.runInContext(`
    payRead = function (k) { return JSON.parse(JSON.stringify(__DB[k] || [])); };
    payReplaceAll = function (k, rows) { __DB[k] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function (k, rows) { __DB[k] = (__DB[k] || []).concat(JSON.parse(JSON.stringify(rows))); };
    payInvalidate = function () {};
    payClockRead = function (st, sh) { return JSON.parse(JSON.stringify(__CLOCK[st + ':' + sh] || [])); };
    payHasClock = function () { return true; };
    todayTaipeiStr = function () { return __TODAY; };
    currentYmTaipei = function () { return __TODAY.slice(0, 7); };
    payYesterday_ = function () { var d = new Date(__TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    checkAdmin = function () { return true; };
    schedPubLoad_ = function () { return {}; };
    payHolidaySync = function () { return { changed: [] }; };
    payInboxNotify_ = function (t, x) { __NOTIFY.push([t, x]); return true; };
    getSS = function () { return { getSheetByName: function (n) { return { name: n }; } }; };
    payGovCalendar = function () { return null; };
  `, sb);
  const fn = (n) => vm.runInContext(n, sb);
  return { sb, fn, calc: (b) => J(fn('handlePayrollCalc')(Object.assign({ admin_key: 'x', store: 'SSLGF' }, b))) };
}

/* ── 假資料：正職甲（底薪 30,000＋績效 3,000）、計時乙（時薪 200）、月中到職的正職丙、光復（純遞減制） ── */
const emp = (o) => Object.assign({ store: 'SSLGF', active: 'true', base: 0, wage: 0, ot_rate: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0,
  attend_cap: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2026-01-01', leave_date: '', meal_allow: 0, gap_rate: 0,
  co_labor: 0, co_health: 0, co_pension: 0, yearend_months: '' }, o);
const MASTER = [
  emp({ emp_id: 'F1', name: '同仁甲', is_full_time: 'true', base: 30000, attend_cap: 3000, ot_rate: 200, labor_ins: 758, health_ins: 470, dormitory: 900, co_labor: 2692, co_health: 1466, co_pension: 1818 }),
  emp({ emp_id: 'P1', name: '同仁乙', is_full_time: 'false', wage: 200, labor_ins: 277, health_ins: 458, hire_date: '2026-06-01' }),
  emp({ emp_id: 'F2', name: '同仁丙', is_full_time: 'true', base: 36000, attend_cap: 3000, ot_rate: 240, labor_ins: 800, health_ins: 500, hire_date: '2026-11-10' }),
];
const day = (ym, d) => ym + '-' + String(d).padStart(2, '0');
function clockFor(ym, days) {
  const approved = [], roster = MASTER.map((m) => ({ emp_id: m.emp_id, name: m.name, active: 'true', key: 'k' + m.emp_id }));
  for (let d = 1; d <= days; d++) {
    const dt = day(ym, d), dow = new Date(dt + 'T00:00:00Z').getUTCDay();
    if (dow === 0) continue;
    approved.push({ date: dt, emp_id: 'F1', name: '同仁甲', approved_hours: d === 5 ? 9.5 : 8, status_text: d === 3 ? '遲到6分' : '正常', entered_at: dt + 'T22:00:00+08:00', manager_name: 'M' });
    if (d % 2) approved.push({ date: dt, emp_id: 'P1', name: '同仁乙', approved_hours: 5, status_text: '正常', entered_at: dt + 'T22:00:00+08:00', manager_name: 'M' });
    if (d >= 10) approved.push({ date: dt, emp_id: 'F2', name: '同仁丙', approved_hours: 8, status_text: '正常', entered_at: dt + 'T22:00:00+08:00', manager_name: 'M' });
  }
  const leave = [{ '日期': day(ym, 12), '姓名': '同仁甲', '假別': '病假', '時數': 8 }];
  return { 'SSLGF:roster': roster, 'SSLGF:approved': approved, 'SSLGF:events': [], 'SSLGF:leave': leave, 'SSLGF:requests': [] };
}
const DB = () => ({ master: MASTER, config: [{ key: 'daily_hours', value: '8', store: '' }], item: [], run: [], bonus: [], input: [], audit: [], leave_type: [], leave_span: [], leave_event: [], xmap: [], cost_snapshot: [],
  holiday: [{ ym: '2026-10', red_days: '9', note: '', dates: '', store: '' }, { ym: '2026-11', red_days: '9', note: '', dates: '', store: '' }, { ym: '2026-12', red_days: '8', note: '', dates: '', store: '' }],
  store: [{ code: 'SSLGF', name: '測試店', clock_ss_id: '', active: 'true', support_group: '' }, { code: 'EMPTY', name: '沒主檔的店', clock_ss_id: 'x', active: 'true', support_group: '' }] });
const CLOCK = Object.assign({}, clockFor('2026-11', 30));
Object.keys(clockFor('2026-10', 31)).forEach((k) => { if (k.endsWith('approved')) CLOCK[k] = CLOCK[k].concat(clockFor('2026-10', 31)[k]); });
const slim = (rs) => (rs || []).map((r) => ({ id: r.emp_id, ratio: r.ratio, h: r.total_hours, gross: r.gross, ded: r.deduction, net: r.net,
  earn: r.earn.map((x) => [x.item_key, x.qty, x.rate, x.amount]), dd: r.ded.map((x) => [x.item_key, x.qty, x.rate, x.amount]) }));
const by = (rs, id) => (rs || []).find((r) => r.emp_id === id) || {};
const amt = (r, key, side) => ((r[side || 'earn'] || []).find((x) => x.item_key === key) || {}).amount;

console.log('══ ① 本月只算到昨天（今天 2026-11-17）══');
const W = world(P_NEW, { db: DB(), clock: CLOCK, today: '2026-11-17' });
const mid = W.calc({ ym: '2026-11' });
chk('ok', mid.ok, true);
chk('回應帶算到哪一天', mid.asof, { as_of: '2026-11-16', days_elapsed: 16, days_in_month: 30 });
chk('run 列記 as_of、狀態草稿', J(W.sb.__DB.run).map((r) => [r.emp_id, r.as_of, r.status]), [['F1', '2026-11-16', 'draft'], ['P1', '2026-11-16', 'draft'], ['F2', '2026-11-16', 'draft']]);
chk('正職甲：本薪＝30,000×16÷30', amt(by(mid.results, 'F1'), 'base_salary'), 16000);
chk('正職甲：勞保自付照比例、健保整月', [amt(by(mid.results, 'F1'), 'labor_ins', 'ded'), amt(by(mid.results, 'F1'), 'health_ins', 'ded')], [Math.round(758 * 16 / 30), 470]);
chk('計時乙：只算 11/16 以前核定的時數（單數日；11/1、11/15 是週日沒排）', by(mid.results, 'P1').total_hours, 5 * [3, 5, 7, 9, 11, 13].length);
chk('月中到職的丙：11/10～11/16 共 7 天 → 36,000×7÷30', amt(by(mid.results, 'F2'), 'base_salary'), 8400);
{
  const W2 = world(P_NEW, { db: DB(), clock: Object.assign({}, CLOCK, { 'SSLGF:approved': CLOCK['SSLGF:approved'].map((r) => (r.date === '2026-11-17' && r.emp_id === 'P1' ? Object.assign({}, r, { approved_hours: 99 }) : r)) }), today: '2026-11-17' });
  chk('今天才核定的時數不算進來', slim(W2.calc({ ym: '2026-11' }).results), slim(mid.results));
}

console.log('\n══ ② 跟損益月中估算同一天的數字相同 ══');
{
  const est = J(W.fn('handlePnlLaborEstimate_')({ key: 'k-pnl', ym: '2026-11', store: 'SSLGF' }));
  chk('損益估算 ok、同一個 as_of', [est.ok, est.as_of], [true, '2026-11-16']);
  const cls = J(W.fn('pnlEstimateClassify_')(mid.results, W.fn('payRead')('master'), mid.collected, mid.config));
  const rows = {}; Object.keys(est.rows).forEach((k) => { rows[k] = cls[k]; });
  chk('各科目金額相同', rows, est.rows);
  chk('合計相同', cls.total, est.total);
}

console.log('\n══ ③ 整個月過完＝改版前的整月算法 ══');
if (!P_OLD) console.log('（略過：抓不到對照版本 Payroll.gs，請在有 git 歷史的環境跑）');
else {
  const O = world(P_OLD, { db: DB(), clock: CLOCK, today: '2026-12-01' });
  const N = world(P_NEW, { db: DB(), clock: CLOCK, today: '2026-12-01' });
  const o = O.calc({ ym: '2026-11' }), n = N.calc({ ym: '2026-11' });
  chk('12/1 算 11 月：逐人逐項跟改版前相同', slim(n.results), slim(o.results));
  chk('整月沒有 asof、run 列 as_of 空白', [n.asof === undefined, J(N.sb.__DB.run).every((r) => !r.as_of)], [true, true]);
  chk('正職甲整月本薪', amt(by(n.results, 'F1'), 'base_salary'), 30000);
  chk('item 列相同', J(N.sb.__DB.item), J(O.sb.__DB.item));

  console.log('\n══ ④ 過去的月份、指定整月的試算：跟改版前相同 ══');
  const O2 = world(P_OLD, { db: DB(), clock: CLOCK, today: '2026-11-17' });
  chk('11/17 算 10 月', slim(W.calc({ ym: '2026-10' }).results), slim(O2.calc({ ym: '2026-10' }).results));
  chk('10 月 run 列沒有 as_of', J(W.sb.__DB.run).filter((r) => r.ym === '2026-10').every((r) => !r.as_of), true);
  chk('11/17 dry_run＋full_month 算 11 月（月加班同步、加班試算用）', slim(W.calc({ ym: '2026-11', dry_run: true, full_month: true }).results), slim(O2.calc({ ym: '2026-11', dry_run: true }).results));
  chk('full_month 只對試算有效：不帶 dry_run 仍是月中', W.calc({ ym: '2026-11', full_month: true }).asof.as_of, '2026-11-16');
}

console.log('\n══ ⑤ 1 號、鎖定 ══');
{
  const D = world(P_NEW, { db: Object.assign(DB(), { item: [{ ym: '2026-12', emp_id: 'F1', item_type: 'earning', item_key: 'adj_x', item_label: '補發', amount: 500, source: 'manual', store: 'SSLGF' }] }), clock: CLOCK, today: '2026-12-01' });
  const r = D.calc({ ym: '2026-12' });
  chk('12/1 算 12 月：沒有列、標 day1', [r.ok, r.results.length, r.asof], [true, 0, { day1: true }]);
  chk('1 號不會弄丟手動明細', J(D.sb.__DB.item).length, 1);
  const fin = (w, b) => J(w.fn('handlePayrollFinalize')(Object.assign({ admin_key: 'x', store: 'SSLGF', lock: true }, b)));
  chk('本月不能鎖定', fin(W, { ym: '2026-11' }).error, 'month_not_over');
  chk('未來月份不能鎖定', fin(W, { ym: '2026-12' }).error, 'month_not_over');
  /* 11/17 的月中草稿留到 12/1，沒重算就按鎖定 → 擋 */
  const L = world(P_NEW, { db: J(W.sb.__DB), clock: CLOCK, today: '2026-12-01' });
  const f1 = fin(L, { ym: '2026-11' });
  chk('月中草稿跨月後不能直接鎖', [f1.ok, f1.error], [false, 'stale_run']);
  chk('被擋時 run 仍是草稿', J(L.sb.__DB.run).filter((x) => x.ym === '2026-11').every((x) => x.status === 'draft'), true);
  chk('解鎖不受影響（要填原因的檢查照舊）', J(L.fn('handlePayrollFinalize')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', lock: false })).error, 'reason_required');
  chk('10 月以前的月份不看這條', fin(world(P_NEW, { db: DB(), clock: CLOCK, today: '2026-11-17' }), { ym: '2026-09' }).error !== 'month_not_over', true);
}

console.log('\n══ ⑥ 開頁自動換成昨天那一份、每天排程 ══');
{
  const M = world(P_NEW, { db: J(W.sb.__DB), clock: CLOCK, today: '2026-11-19' });
  const m = J(M.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' }));
  chk('11/19 打開 11 月：草稿自動換成算到 11/18', [m.run.as_of, m.asof.as_of, m.asof.days_elapsed], ['2026-11-18', '2026-11-18', 18]);
  chk('run 表也換了', J(M.sb.__DB.run).filter((x) => x.ym === '2026-11').map((x) => x.as_of), ['2026-11-18', '2026-11-18', '2026-11-18']);
  chk('帶「有打卡沒核定」清單欄位（這份假資料沒有打卡事件＝空）', m.asof.unapproved, []);
  {
    const at1 = J(M.sb.__DB.run).filter((x) => x.ym === '2026-11').map((x) => x.run_at);
    M.sb.__DB.run.forEach((x) => { if (x.ym === '2026-11') x.run_at = 'MARK'; });
    const again = J(M.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' }));
    chk('同一天再開一次：不重算（run_at 沒被改寫）', [at1.length, J(M.sb.__DB.run).filter((x) => x.ym === '2026-11').every((x) => x.run_at === 'MARK'), again.run.as_of], [3, true, '2026-11-18']);
    chk('出勤資料也只算到昨天（跟薪資計算同一個範圍）', [again.inputs.P1.hours, by(again.run.results, 'P1').total_hours], [35, 35]);
  }
  const m10 = J(M.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-10', store: 'SSLGF' }));
  chk('過去的月份不帶 asof', m10.asof === undefined, true);
  const M2 = world(P_NEW, { db: J(W.sb.__DB), clock: CLOCK, today: '2026-12-03' });
  const mm = J(M2.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' }));
  chk('12/3 打開 11 月：月中草稿自動換成整月', [mm.run.as_of === undefined, mm.asof === undefined, amt(by(mm.run.results, 'F1'), 'base_salary')], [true, true, 30000]);

  /* 每天排程：10 月已鎖定不碰、11 月草稿重算、沒主檔的店不算 */
  const db = J(W.sb.__DB);
  db.run.forEach((r) => { if (r.ym === '2026-10') r.status = 'final'; });
  const before10 = JSON.stringify(db.run.filter((r) => r.ym === '2026-10'));
  const S = world(P_NEW, { db, clock: CLOCK, today: '2026-11-20' });
  const out = J(S.fn('payAsOfDaily')());
  chk('只重算本月草稿', [out.done, out.fails], [['SSLGF 2026-11'], []]);
  chk('已鎖定的 10 月原封不動', JSON.stringify(J(S.sb.__DB.run).filter((r) => r.ym === '2026-10')), before10);
  chk('11 月換成算到 11/19', J(S.sb.__DB.run).filter((r) => r.ym === '2026-11').every((r) => r.as_of === '2026-11-19'), true);
  const S2 = world(P_NEW, { db: J(W.sb.__DB), clock: CLOCK, today: '2026-12-01' });
  const o2 = J(S2.fn('payAsOfDaily')());
  {
    /* 上個月已經是整月草稿：排程不可以再動（會計看過的數字不能無聲被換掉；主檔改了要在鎖定前比對時跳出來） */
    const S3 = world(P_NEW, { db: J(S2.sb.__DB), clock: CLOCK, today: '2026-12-03' });
    S3.sb.__DB.master.forEach((m) => { if (m.emp_id === 'F1') m.base = 33000; });
    const net0 = J(S3.sb.__DB.run).find((r) => r.ym === '2026-11' && r.emp_id === 'F1').net;
    const o3 = J(S3.fn('payAsOfDaily')());
    chk('12/3：整月的 11 月草稿不重寫', [o3.done.indexOf('SSLGF 2026-11') < 0, J(S3.sb.__DB.run).find((r) => r.ym === '2026-11' && r.emp_id === 'F1').net], [true, net0]);
    const f3 = J(S3.fn('handlePayrollFinalize')({ admin_key: 'x', store: 'SSLGF', ym: '2026-11', lock: true }));
    chk('主檔改過 → 鎖定前照舊跳出差異（stale_run 名單有甲）', [f3.error, (f3.list || []).map((x) => x.name)], ['stale_run', ['同仁甲']]);
  }
  {
    /* 月中已登記的獎金照算（存獎金會整店重寫 updated_at，不可以照日期濾掉） */
    const db = DB(); db.bonus = [{ ym: '2026-11', store: 'SSLGF', emp_id: 'F1', bonus_type: 'perf', label: '績效', amount: 5000, updated_at: '2026-11-17T10:00:00+08:00' }];
    const B = world(P_NEW, { db, clock: CLOCK, today: '2026-11-17' });
    chk('今天才存的獎金也在月中草稿裡', amt(by(B.calc({ ym: '2026-11' }).results, 'F1'), 'bonus_perf'), 5000);
    /* 1 號：之前有人先算過的整月草稿不可以跟「還沒有昨天」的說明一起出現 */
    const D1 = world(P_NEW, { db: DB(), clock: CLOCK, today: '2026-11-20' });
    D1.calc({ ym: '2026-12' });
    const had = J(D1.sb.__DB.run).filter((r) => r.ym === '2026-12').length;
    const D2 = world(P_NEW, { db: J(D1.sb.__DB), clock: CLOCK, today: '2026-12-01' });
    const m1 = J(D2.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-12', store: 'SSLGF' }));
    chk('12/1 開 12 月：先前的整月草稿清掉、只留 1 號說明', [had > 0, m1.run, m1.asof, J(D2.sb.__DB.run).filter((r) => r.ym === '2026-12').length], [true, null, { day1: true }, 0]);
    /* 自動更新失敗：照實標，不寫成昨天 */
    const Fz = world(P_NEW, { db: J(W.sb.__DB), clock: CLOCK, today: '2026-11-19' });
    vm.runInContext('var __real = handlePayrollCalc; handlePayrollCalc = function () { return { ok: false, error: "busy" }; };', Fz.sb);
    const mf = J(Fz.fn('handlePayrollMonth')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' }));
    chk('更新失敗：說明寫草稿實際算到 11/16、標 stale', [mf.asof.as_of, mf.asof.stale, mf.run.as_of], ['2026-11-16', true, '2026-11-16']);
  }
  chk('12/1：上個月草稿換成整月、本月（1 號）不算', [o2.done, J(S2.sb.__DB.run).filter((r) => r.ym === '2026-11').every((r) => !r.as_of)], [['SSLGF 2026-11'], true]);
  chk('沒有通知匣訊息', S.sb.__NOTIFY.length + S2.sb.__NOTIFY.length, 0);
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
