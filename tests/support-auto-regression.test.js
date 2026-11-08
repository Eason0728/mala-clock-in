/* 跨店支援自動帶入 回歸守門（2026-11-05）：生效月（2026-11）之前，薪資結果必須一毛不差、逐項相同。
 *
 * 做法照 tests/comp-regression.test.js：同一份假資料分別餵
 *   ①改動前的 Payroll.gs（git origin/main）②現在的 Payroll.gs，
 * 跑 handlePayrollCalc 與 payroll_month（整條鏈：payCollect → payInputsBase → payCalcOne → 寫 run／item），
 * 逐人比對 earn／ded／gross／net（整份 results）、payroll_month 的 inputs，與寫進 run／item 的每一列（run_at 除外）。
 *   ·2026-09、2026-10：多店（光復＋央廚），含手填跨店支援（中文名、舊格式）、手動列、計時、月中到職。
 *   ·2026-11 但沒有任何打卡對照（xmap 空）：也要逐項相同（上線當下還沒同步＝什麼都不變）。
 *   ·對照組：2026-11 放進 xmap 後，帶入的那位一定要變——證明比對真的有在比。
 * 沒有 git 或取不到 origin/main 時跳過並說明，不算失敗。全部虛構資料。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
let OLD;
try { OLD = cp.execFileSync('git', ['-C', ROOT, 'show', 'origin/main:apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { console.log('⚠ 取不到 git 基準 origin/main，跳過回歸比對'); process.exit(0); }
const NEW = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
if (OLD === NEW) console.log('⚠ 基準與現在的 Payroll.gs 相同（還沒改動？）——照跑，結果必然相同');

const J = (x) => JSON.parse(JSON.stringify(x));
function ctx(P, DB, CLOCK) {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => d.toISOString() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  // 2026-11 起的加班費新算法（逐日判斷、績效獎金改名、早退扣款…）是刻意的改變，由 ot-daily.test.js 守；
  // 這支只守「其他規則沒被動到」，所以把新版的生效月份推到很遠，兩邊都照舊規則比。
  vm.runInContext("if (typeof PAY_OT_DAILY_FROM !== 'undefined') PAY_OT_DAILY_FROM = '2099-01'; if (typeof PAY_RULES3_FROM !== 'undefined') PAY_RULES3_FROM = '2099-01'; if (typeof PAY_ANNUAL_SETTLE_FROM !== 'undefined') PAY_ANNUAL_SETTLE_FROM = '2099-01'; if (typeof PAY_LATE_ATTEND_FROM !== 'undefined') PAY_LATE_ATTEND_FROM = '2099-01'; if (typeof PAY_MENSTRUAL_FULL_FROM !== 'undefined') PAY_MENSTRUAL_FULL_FROM = '2099-01';", sb);
  sb.__C = CLOCK; sb.__DB = DB;
  vm.runInContext(`
    payClockRead = function(store, sheet){
      const row = globalThis.__DB.store.filter(function(s){ return String(s.code) === String(store || 'SSLGF'); })[0];
      const id = row && row.clock_ss_id ? row.clock_ss_id : 'LOCAL';
      return JSON.parse(JSON.stringify((globalThis.__C[id] || {})[sheet] || []));
    };
    payRead      = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll= function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(){}; payInvalidate = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return '2027-01-15'; };
    currentYmTaipei = function(){ return '2027-01'; };
    payHolidaySync = function(){ return {}; };
  `, sb);
  return sb;
}

/* ── 假資料（全部虛構）── */
const EMP = (id, store, o) => Object.assign({ emp_id: id, name: id + '君', store, is_full_time: 'true', base: 30000, skill_allow: 3000,
  night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 3000, ot_rate: 240, wage: 0, labor_ins: 758, health_ins: 470,
  group_ins: 0, pension: 0, dormitory: 1500, hire_date: '2021-03-10', leave_date: '', meal_allow: 80, active: 'true' }, o);
const master = [
  EMP('E01', 'SSLGF'),
  EMP('E02', 'SSLGF', { base: 32000, mgr_allow: 3000, ot_rate: 250, hire_date: '2025-11-20' }),
  EMP('E03', 'SSLGF', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 205, skill_allow: 0, hire_date: '2026-01-05' }),
  EMP('E04', 'SSLGF', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 200, skill_allow: 0, editor_allow: 250, hire_date: '2026-08-14' }),
  EMP('E05', 'SSLGF', { hire_date: '2026-09-16', dormitory: 0 }),
  EMP('CF01', 'CF', { base: 31000 }),
  EMP('CF02', 'CF', { is_full_time: 'false', base: 0, attend_cap: 0, ot_rate: 0, wage: 210, skill_allow: 0 }),
];
const stores = [
  { code: 'SSLGF', name: '麻的小辛辣 新竹光復店', clock_ss_id: '', active: 'true', support_group: 'sxl' },
  { code: 'CF', name: '中央廚房', clock_ss_id: 'ck-cf', active: 'true', support_group: '*' },
  { code: 'MZTJS', name: '墨竹亭 金山店', clock_ss_id: 'ck-js', active: 'true', support_group: 'mzt' },
];
const MONTHS = ['2026-09', '2026-10', '2026-11'];
const RED = { '2026-09': 10, '2026-10': 11, '2026-11': 9 };
const CLOCK = { LOCAL: { roster: [], approved: [], events: [], leave: [], requests: [] }, 'ck-cf': { roster: [], approved: [], events: [], leave: [], requests: [] }, 'ck-js': { roster: [], approved: [], events: [], leave: [], requests: [] } };
const LEAVES = ['事假', '病假', '特休假', '生理假', '家庭照顧假', '天災假', '出差'];
master.forEach((e, ei) => {
  const T = CLOCK[e.store === 'CF' ? 'ck-cf' : 'LOCAL'];
  T.roster.push({ emp_id: e.emp_id, name: e.name, active: true });
  MONTHS.forEach((ym, mi) => {
    const nd = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
    for (let d = 1; d <= nd; d++) {
      const date = ym + '-' + ('0' + d).slice(-2);
      if (date < e.hire_date) continue;
      if ((d + ei) % 7 === 0 || (d + ei) % 7 === 3) continue;
      const k = (d * 7 + ei * 3 + mi) % 11;
      const h = [8, 8.5, 9, 7.5, 8, 10, 8.25, 6, 8, 8.75, 4][k];
      const st = k === 3 ? '遲到5分' : k === 7 ? '第二段下班無打卡' : k === 10 ? '遲到3分、早退12分' : '正常';
      T.approved.push({ date, emp_id: e.emp_id, name: e.name, periods: '10:00-18:00', approved_hours: h, status_text: st, entered_at: date + 'T22:00:00+08:00', manager_name: '主管' });
      T.events.push({ emp_id: e.emp_id, ts: date + 'T10:00:00+08:00', type: 'in', status: 'ok' });
      if (k !== 7) T.events.push({ emp_id: e.emp_id, ts: date + 'T19:00:00+08:00', type: 'out', status: 'ok' });
      if (k === 6 || k === 10) T.leave.push({ '日期': date, '姓名': e.name, '假別': LEAVES[(d + ei + mi) % LEAVES.length], '時數': k === 6 ? 4 : 8 });
    }
  });
});
// 光復同仁在央廚／金山另有帳號、也真的有核定（舊制下不該被帶入；新制要有 xmap 才會帶）
['2026-09-03', '2026-10-07', '2026-11-04', '2026-11-05'].forEach((date) => {
  CLOCK['ck-cf'].approved.push({ date, emp_id: 'CF91', name: '支援', periods: '10:00-18:00', approved_hours: 8, status_text: '正常', entered_at: date + 'T22:00:00+08:00', manager_name: '主管' });
  CLOCK['ck-js'].approved.push({ date, emp_id: 'JS91', name: '支援', periods: '10:00-16:00', approved_hours: 6, status_text: '正常', entered_at: date + 'T22:00:00+08:00', manager_name: '主管' });
});
function freshDB() {
  return {
    master: J(master), store: J(stores), run: [], item: [], config: [], leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [], xmap: [],
    holiday: MONTHS.map((ym) => ({ ym, store: '', red_days: RED[ym] })),
    bonus: [{ ym: '2026-10', emp_id: 'E01', store: 'SSLGF', bonus_type: 'sales', label: '業績', amount: 1200 }],
    input: [
      { ym: '2026-09', emp_id: 'E02', store: 'SSLGF', hours: 180, extra_ot: 3, personal_h: 8, sick_h: 0, menstrual_h: 0, disaster_h: 0, annual_h: 8,
        deduct_days: 1, support: '[{"store":"央廚","hours":6,"rate":220,"amount":""},{"store":"墨竹亭金山","hours":4.5,"rate":240,"amount":""}]', full_attend: 0, work_days: 20, wage_override: 0, meal_on: 1, holiday_h: 0 },
      { ym: '2026-10', emp_id: 'E03', store: 'SSLGF', hours: 96, support: '[{"store":"墨金","hours":12,"rate":230,"amount":""},{"store":"某某分店","hours":2,"rate":200,"amount":"500"}]', full_attend: 1, wage_override: 215 },
      { ym: '2026-10', emp_id: 'E01', store: 'SSLGF', hours: 170, support: '[{"store":"央廚","hours":10,"rate":240,"amount":""}]', meal_on: 1 },
      { ym: '2026-11', emp_id: 'E02', store: 'SSLGF', hours: 175, support: '[{"store":"央廚","hours":7,"rate":250,"amount":""},{"store":"墨竹亭金山","hours":3,"rate":250,"amount":""}]', meal_on: 1 },
      { ym: '2026-11', emp_id: 'E04', store: 'SSLGF', hours: 60, support: '[{"store":"墨復","hours":5,"rate":200,"amount":""}]' },
      { ym: '2026-10', emp_id: 'CF02', store: 'CF', hours: 80, support: '[{"store":"小辛辣光復","hours":9,"rate":210,"amount":""}]' },
    ],
  };
}

let pass = 0, fail = 0, compared = 0, rowsCompared = 0;
const chk = (n, cond, detail) => { cond ? pass++ : fail++; if (!cond || detail) console.log((cond ? '✓ ' : '✗ ') + n + (detail ? '：' + detail : '')); };
const strip = (rows) => rows.map((r) => { const o = Object.assign({}, r); delete o.run_at; return o; });
const DB_OLD = freshDB(), DB_NEW = freshDB();
const sOld = ctx(OLD, DB_OLD, CLOCK), sNew = ctx(NEW, DB_NEW, CLOCK);
const HO = (a, b) => vm.runInContext('PAYROLL_HANDLERS', sOld)[a](J(b)), HN = (a, b) => vm.runInContext('PAYROLL_HANDLERS', sNew)[a](J(b));
const cmpResults = (tag, A, B) => {
  chk(tag + ' 兩版都算得出來', A.ok && B.ok, A.ok && B.ok ? '' : JSON.stringify([A.error, B.error]));
  const ra = (A.results || (A.run || {}).results || []), rb = (B.results || (B.run || {}).results || []);
  chk(tag + ' 人數相同（' + ra.length + '）', ra.length === rb.length && ra.length > 0);
  ra.forEach((x) => {
    const y = rb.find((z) => z.emp_id === x.emp_id);
    compared++;
    const same = JSON.stringify(x) === JSON.stringify(y);
    chk(tag + ' ' + x.emp_id + ' earn／ded／gross／net 逐項相同', same, same ? '' : '\n  舊 ' + JSON.stringify(x).slice(0, 300) + '\n  新 ' + JSON.stringify(y).slice(0, 300));
  });
};
MONTHS.forEach((ym) => {
  ['SSLGF', 'CF'].forEach((st) => {
    cmpResults(ym + ' ' + st + ' payroll_calc', HO('payroll_calc', { admin_key: 'x', ym, store: st }), HN('payroll_calc', { admin_key: 'x', ym, store: st }));
    ['run', 'item'].forEach((k) => {
      const a = strip(DB_OLD[k].filter((r) => r.ym === ym && r.store === st)), b = strip(DB_NEW[k].filter((r) => r.ym === ym && r.store === st));
      rowsCompared += a.length;
      chk(ym + ' ' + st + ' 寫入的 ' + k + ' 列相同（' + a.length + ' 列）', a.length > 0 && JSON.stringify(a) === JSON.stringify(b));
    });
    const mo = HO('payroll_month', { admin_key: 'x', ym, store: st }), mn = HN('payroll_month', { admin_key: 'x', ym, store: st });
    cmpResults(ym + ' ' + st + ' payroll_month', mo, mn);
    // _manual：2026-11 起標「這是已存的整筆手動列」給前端存檔用（GPT #2），不進計算；比對時拿掉，其他欄位逐欄相同
    const noMk = (o) => JSON.stringify(o, (k, v) => (k === '_manual' ? undefined : v));
    chk(ym + ' ' + st + ' payroll_month 的 inputs（工時分頁）逐欄相同', noMk(mo.inputs) === noMk(mn.inputs));
    if (ym >= '2026-11' && (DB_NEW.input || []).some((r) => r.ym === ym && r.store === st)) chk(ym + ' ' + st + ' 有手動列的人標 _manual（且只多這一欄）', Object.keys(mn.inputs).some((k) => mn.inputs[k]._manual === true));
    if (ym < '2026-11') chk(ym + ' ' + st + ' payroll_month 回應整份相同（沒有多任何欄位）', JSON.stringify(mo) === JSON.stringify(mn));
    const io = HO('payroll_inputs', { admin_key: 'x', ym, store: st }), inw = HN('payroll_inputs', { admin_key: 'x', ym, store: st });
    chk(ym + ' ' + st + ' payroll_inputs inputs 相同', noMk(io.inputs) === noMk(inw.inputs));
  });
});
// 儲存工時：2026-10 寫進去的 support 欄與舊版逐字相同
{
  const body = { admin_key: 'x', ym: '2026-10', store: 'SSLGF', inputs: { E01: { hours: 160, support: [{ store: '央廚', hours: 3, rate: 240, amount: '' }] } } };
  HO('payroll_input_set', body); HN('payroll_input_set', body);
  const a = DB_OLD.input.find((r) => r.ym === '2026-10' && r.emp_id === 'E01'), b = DB_NEW.input.find((r) => r.ym === '2026-10' && r.emp_id === 'E01');
  const ka = Object.assign({}, a), kb = Object.assign({}, b); delete ka.updated_at; delete kb.updated_at; delete ka.hours_manual; delete kb.hours_manual;   // hours_manual 已併進主線（兩邊都有），一起拿掉
  chk('2026-10 儲存工時：除了 hours_manual，寫入的列逐欄相同', JSON.stringify(ka) === JSON.stringify(kb), JSON.stringify(ka) === JSON.stringify(kb) ? '' : JSON.stringify(Object.keys(Object.assign({}, ka, kb)).filter((k) => JSON.stringify(ka[k]) !== JSON.stringify(kb[k])).map((k) => [k, ka[k], kb[k]])));
}
// 對照組：2026-11 有 xmap 後，帶入的那位（E01 在央廚 CF91 有 16H）一定要變
{
  DB_NEW.xmap = [
    { emp_no: 'D01', pay_store: 'SSLGF', acct_store: 'SSLGF', emp_id: 'E01', not_support: 'false', state: 'confirmed', synced_at: '2026-11-05T09:00:00+08:00' },
    { emp_no: 'D01', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'CF91', not_support: 'false', state: 'confirmed', synced_at: '2026-11-05T09:00:00+08:00' },
  ];
  const B = HN('payroll_calc', { admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  const A = HO('payroll_calc', { admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  const a = A.results.find((r) => r.emp_id === 'E01'), b = B.results.find((r) => r.emp_id === 'E01');
  chk('對照組：放進打卡對照後 E01 支援 0 → 16H、加班費變了（證明比對有在比）', a.support_hours === 0 && b.support_hours === 16 && JSON.stringify(a.earn) !== JSON.stringify(b.earn), JSON.stringify([a.support_hours, b.support_hours]));
  // E02（手填墨竹亭金山 3H）是跨品牌手填：對照同步後不計（審查 #3），支援時數少掉那 3H。
  // E04 手填「墨復」→ MZTGF 不在這份門市表（沒有組別）→ 不判跨品牌、照算（support_group 空白不判）
  const CROSS = { E02: 3 };
  const others = A.results.filter((r) => r.emp_id !== 'E01' && !CROSS[r.emp_id]).every((r) => JSON.stringify(r) === JSON.stringify(B.results.find((z) => z.emp_id === r.emp_id)));
  chk('對照組：其他人一律不變', others);
  chk('對照組：跨品牌手填的那位只少掉跨品牌那 3H', Object.keys(CROSS).every((k) => {
    const a = A.results.find((r) => r.emp_id === k), b = B.results.find((r) => r.emp_id === k);
    return Math.round((a.support_hours - b.support_hours) * 100) / 100 === CROSS[k];
  }));
}
console.log(`\n比對 ${compared} 人次（${MONTHS.length} 個月 × 2 店 × calc／month），寫入列 ${rowsCompared} 列`);
console.log(fail ? `❌ ${fail} 項不一致` : `✅ 生效月之前（及 2026-11 沒有打卡對照時）逐項完全相同 (${pass}/${pass})`);
process.exit(fail ? 1 : 0);
