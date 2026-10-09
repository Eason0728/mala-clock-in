/* 補休回歸守門（2026-10-09）：沒有補休的人，薪資結果必須一毛不差、逐項相同。
 *
 * 做法：同一份假資料（打卡核定／請假／加班申請／手動工時／獎金／支援，多人多月）分別餵
 *   ①改版前的 Payroll.gs（git 基準 3668329，補休上線前最後一版）②現在的 Payroll.gs
 * 都跑 handlePayrollCalc（整條鏈：payCollect → payInputsBase → payCalcOne → 寫 run／item），
 * 逐人比對回傳的 results 與寫進 run／item 的每一列（run_at 時間戳除外）。
 * 另外放一位「有換補休」的同仁當對照：只有他會變，其他人一律相同——證明比對真的有在比。
 * 沒有 git（例如只拿到單一檔案）時跳過並說明，不算失敗。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = '3668329';
let OLD;
try { OLD = cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { console.log('⚠ 取不到 git 基準 ' + BASE + '，跳過回歸比對'); process.exit(0); }
const NEW = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');

function ctx(P, DB, CLOCK) {
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return JSON.parse(JSON.stringify(globalThis.__C[sheet] || [])); };
    payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return '2027-01-15'; };
  `, sb);
  return sb;
}

/* ── 假資料（全部虛構）── */
const EMP = (id, name, o) => Object.assign({ emp_id: id, name, store: 'SSLGF', is_full_time: 'true', base: 30000, skill_allow: 3000,
  night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 758, health_ins: 470,
  group_ins: 0, pension: 0, dormitory: 1500, hire_date: '2021-03-10', leave_date: '', meal_allow: 80, active: 'true' }, o);
const master = [
  EMP('E01', '甲君', {}),
  EMP('E02', '乙君', { base: 32000, mgr_allow: 3000, ot_rate: 250, hire_date: '2025-11-20' }),
  EMP('E03', '丙君', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 205, skill_allow: 0, hire_date: '2026-01-05' }),
  EMP('E04', '丁君', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 200, skill_allow: 0, editor_allow: 250, hire_date: '2026-08-14' }),
  EMP('E05', '戊君', { hire_date: '2026-09-16', dormitory: 0 }),                                     // 月中到職
  EMP('E09', '換補休對照', { hire_date: '2020-02-01' }),                                              // 只有他有換補休
];
const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];
const RED = { '2026-07': 8, '2026-08': 10, '2026-09': 10, '2026-10': 11, '2026-11': 9, '2026-12': 8 };
const approved = [], events = [], leave = [], requests = [];
const LEAVES = ['事假', '病假', '特休假', '生理假', '家庭照顧假', '天災假', '喪假（父母・配偶）', '出差', '公假'];
let seq = 0;
master.forEach((e, ei) => {
  MONTHS.forEach((ym, mi) => {
    const nd = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
    for (let d = 1; d <= nd; d++) {
      const date = ym + '-' + ('0' + d).slice(-2);
      if (date < e.hire_date) continue;
      if ((d + ei) % 7 === 0 || (d + ei) % 7 === 3) continue;          // 休假日
      const k = (d * 7 + ei * 3 + mi) % 11;
      const h = [8, 8.5, 9, 7.5, 8, 10, 8.25, 6, 8, 8.75, 4][k];
      const st = k === 3 ? '遲到5分' : k === 7 ? '第二段下班無打卡' : k === 10 ? '遲到3分、早退12分' : '正常';
      approved.push({ date, emp_id: e.emp_id, name: e.name, approved_hours: h, status_text: st, entered_at: date + 'T22:00:00+08:00', manager_name: '主管' });
      events.push({ emp_id: e.emp_id, ts: date + 'T10:00:00+08:00', type: 'in', status: 'ok' });
      if (k !== 7) events.push({ emp_id: e.emp_id, ts: date + 'T19:00:00+08:00', type: 'out', status: 'ok' });
      if (k === 6 || k === 10) leave.push({ '日期': date, '姓名': e.name, '假別': LEAVES[(d + ei + mi) % LEAVES.length], '時數': k === 6 ? 4 : 8 });
      if (k === 5) {   // 加班申請：沒有補休的人送的都是「加班費」，有的舊列連 comp 欄都沒有
        seq++;
        const row = { id: 'r' + seq, kind: 'ot', date, start: '19:00', end: '21:00', hours: 2, status: seq % 4 === 0 ? 'pending' : 'approved', emp_id: e.emp_id };
        if (e.emp_id === 'E09') row.comp = 'comp';
        else if (seq % 3 === 0) row.comp = 'pay';
        else if (seq % 3 === 1) row.comp = '';      // 空白＝加班費
        requests.push(row);                          // 其餘：沒有 comp 欄（上線前的舊分頁）
      }
    }
  });
});
// 計時同仁也送「換補休」（應被忽略）
requests.push({ id: 'rPT', kind: 'ot', date: '2026-10-08', start: '19:00', end: '22:00', hours: 3, status: 'approved', emp_id: 'E03', comp: 'comp' });
const CLOCK = { roster: master.map((e) => ({ emp_id: e.emp_id, name: e.name, active: true })), approved, events, leave, requests };
function freshDB() {
  return {
    master: JSON.parse(JSON.stringify(master)), run: [], item: [], config: [], leave_type: [],
    holiday: MONTHS.map((ym) => ({ ym, store: 'SSLGF', red_days: RED[ym] })),
    bonus: [{ ym: '2026-10', emp_id: 'E01', store: 'SSLGF', bonus_type: 'sales', label: '業績', amount: 1200 }],
    input: [{ ym: '2026-08', emp_id: 'E02', store: 'SSLGF', hours: 180, extra_ot: 3, personal_h: 8, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 8,
              deduct_days: 1, support: '[{"store":"央廚","hours":6,"rate":220,"amount":""}]', full_attend: 0, work_days: 20, wage_override: 0, meal_on: 1, holiday_h: 0 }],
  };
}

let pass = 0, fail = 0, compared = 0, rowsCompared = 0;
const chk = (n, cond, detail) => { cond ? pass++ : fail++; if (!cond || detail) console.log((cond ? '✓ ' : '✗ ') + n + (detail ? '：' + detail : '')); };
const DB_OLD = freshDB(), DB_NEW = freshDB();
const sOld = ctx(OLD, DB_OLD, CLOCK), sNew = ctx(NEW, DB_NEW, CLOCK);
const strip = (rows) => rows.map((r) => { const o = Object.assign({}, r); delete o.run_at; return o; });
let e09Diff = 0;
MONTHS.forEach((ym) => {
  const A = vm.runInContext('handlePayrollCalc', sOld)({ admin_key: 'x', ym, store: 'SSLGF' });
  const B = vm.runInContext('handlePayrollCalc', sNew)({ admin_key: 'x', ym, store: 'SSLGF' });
  chk(ym + ' 兩版都算得出來', A.ok && B.ok, A.ok && B.ok ? '' : JSON.stringify([A.error, B.error]));
  A.results.forEach((ra) => {
    const rb = B.results.find((x) => x.emp_id === ra.emp_id);
    const same = JSON.stringify(ra) === JSON.stringify(rb);
    if (ra.emp_id === 'E09') { if (!same) e09Diff++; return; }
    compared++;
    chk(ym + ' ' + ra.emp_id + ' 逐項相同', same, same ? '' : '\n  舊 ' + JSON.stringify(ra).slice(0, 400) + '\n  新 ' + JSON.stringify(rb).slice(0, 400));
  });
  // 寫進表的 run／item（不含補休對照那位）逐列相同
  ['run', 'item'].forEach((k) => {
    const a = strip(DB_OLD[k].filter((r) => r.ym === ym && r.emp_id !== 'E09'));
    const b = strip(DB_NEW[k].filter((r) => r.ym === ym && r.emp_id !== 'E09'));
    rowsCompared += a.length;
    chk(ym + ' 寫入的 ' + k + ' 列相同（' + a.length + ' 列）', JSON.stringify(a) === JSON.stringify(b));
  });
  // 定案（讓後面的月份讀得到補休存入）
  DB_OLD.run.forEach((r) => { if (r.ym === ym) r.status = 'final'; });
  DB_NEW.run.forEach((r) => { if (r.ym === ym) r.status = 'final'; });
});
chk('對照組：換補休的那位確實有變（' + e09Diff + ' 個月）——證明比對有在比', e09Diff > 0, String(e09Diff) + ' 個月不同');
console.log(`\n比對 ${compared} 人月（${MONTHS.length} 個月 × ${master.length - 1} 人，含正職／計時／月中到職／手動工時／支援／獎金／9 種假／遲到忘刷），寫入列 ${rowsCompared} 列`);
console.log(fail ? `❌ ${fail} 項不一致` : `✅ 沒有補休的人逐項完全相同 (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
