/* 選舉假名單：「勾選 vs 不勾選」隨機對照（Eason 2026-11-22 定案「不可讓任何人因被勾選而少領」；Codex 第三次後補）
 * 每一輪隨機產生 8 位假同仁（正職／計時、在職／當月停用離職、班表 W/H/R/L/查不到、11/28 時數 0～12、國定假日 0／11/10／11/28、
 * 加班單、補休、同品牌別店支援（自動帶入，含當天只在別店）、手填國定假日時數／手調總時數／只手填支援），
 * 同一份資料算兩次：名單空白 vs 隨機勾選，逐人比 實付（net）與應發（gross）：勾選後不可小於不勾選。
 * 手填國定假日衝突（elec_hol_manual）時本店與支援都不自動加發（Codex 第三次 B3）——不勾選本來就沒有選舉日加發，所以仍是「勾選 ≥ 不勾選」，這裡一併驗。
 * 用法：node tests/election-day-emp-random.test.js　（ELEC_RAND_N＝輪數，預設 2500 輪 × 8 人 ＝ 20,000 人次；ELEC_RAND_SEED＝亂數種子）
 * 世界（假試算表、假打卡表）直接拿 election-day-emp.test.js 的 world()，不另寫一份。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const T = fs.readFileSync(path.join(__dirname, 'election-day-emp.test.js'), 'utf8');
const cut = T.indexOf("const BASE_REF");
if (cut < 0) { console.log('✗ 找不到 election-day-emp.test.js 的 world()'); process.exit(1); }
const mod = { exports: {} };
new Function('require', 'module', '__dirname', T.slice(0, cut).replace("'use strict';", '') + '\nmodule.exports = { world, W, H, R, LT, E, DAYS };')(require, mod, __dirname);
const { world, W, H, R, LT, E, DAYS } = mod.exports;

const N = parseInt(process.env.ELEC_RAND_N || '2500', 10);
let seed = parseInt(process.env.ELEC_RAND_SEED || '20261128', 10) >>> 0;
const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; seed ^= seed >>> 13; return (seed >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

const w = world({ only: [], elec: [] });
w.DB.store.push({ code: 'SSLHQ', name: '支援店', clock_ss_id: 'ck-hq', active: 'true', support_group: 'sxl' });
w.F('(function(){ payXsupData_ = function(withDays){ return { xmap: payRead("xmap"), stores: payRead("store"), master: payRead("master"), approvedMap: function(c){ return globalThis.__AP[c] || {}; }, events: function(){ return []; }, tsDate: function(s){ return String(s).slice(0,10); }, today: "2026-12-01", days: !!withDays }; }; })')();
const calc = w.F('handlePayrollCalc');
const D28 = DAYS(28), PER = (h) => h >= 10 ? '10:00-21:00' : h >= 8 ? '10:00-19:00' : h >= 6 ? '10:00-16:00' : '10:00-14:00';
const AP = (h) => ({ approved_hours: h, status_text: '正常', periods: PER(h), manager_name: '主管' });

let cmp = 0, bad = 0, elecPaid = 0, warned = 0, manualCase = 0, supOnlyCase = 0, depCase = 0;
const samples = [];
for (let it = 0; it < N; it++) {
  const master = [], rows = [], approved = [], requests = [], leave = [], input = [], xmap = [], apHQ = {};
  const holDates = pick(['', '', '2026-11-10', E]);
  for (let i = 0; i < 8; i++) {
    const emp = 'E' + (i + 1), name = '人' + i + '君', ft = chance(0.5);
    const dep = chance(0.2);
    master.push({ emp_id: emp, name, store: 'SSLGF', is_full_time: ft ? 'true' : 'false', base: ft ? 34000 : 0, skill_allow: 0, night_allow: 0, mgr_allow: 0,
      editor_allow: 0, attend_cap: 0, ot_rate: 0, wage: ft ? 0 : pick([200, 210, 250]), labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0,
      hire_date: ft ? '2020-01-01' : '2026-10-01', leave_date: dep ? pick(['2026-11-29', '2026-11-30', '2026-12-05']) : '', meal_allow: 0, active: dep ? 'false' : 'true' });
    if (dep) depCase++;
    const cells = D28.map((d) => d === E ? pick([W, W, W, H, R, LT, null]) : pick([W, W, W, H, H, R]));
    rows.push({ emp_id: emp, name, cells });
    const onlySup = chance(0.15);   // 11/28 只在別店支援
    D28.forEach((d, k) => {
      const c = cells[k]; if (!c || c.t === 'L') return;
      let h = d === E ? (onlySup ? 0 : pick([0, 4, 8, 8, 10, 12])) : (c.t === 'W' ? pick([0, 8, 8, 10]) : (chance(0.15) ? pick([4, 8]) : 0));
      if (h > 0) approved.push({ date: d, emp_id: emp, name, approved_hours: h, periods: PER(h), status_text: '正常', entered_at: d + 'T22:00:00+08:00', manager_name: '主管' });
      const otNeed = c.t === 'W' ? Math.max(0, h - 8) : h;
      if (otNeed > 0 && chance(0.8)) requests.push({ id: 'R' + i + k, kind: 'ot', status: 'approved', date: d, name, emp_id: emp, hours: otNeed, created_at: d + 'T08:00:00+08:00' });
    });
    if (ft && chance(0.3)) { const d = pick(['2026-11-12', '2026-11-20']); const h = pick([2, 4]);
      leave.push({ '日期': d, '姓名': name, '假別': '補休', '時數': h });
      requests.push({ id: 'C' + i, kind: 'leave', leave_type: '補休', status: 'approved', date: d, name, emp_id: emp, hours: h, created_at: d + 'T08:00:00+08:00' }); }
    // 同品牌別店支援（自動帶入）：11/28 或 11/10，或兩天
    if (onlySup || chance(0.25)) {
      xmap.push({ emp_no: String(i + 1), pay_store: 'SSLGF', acct_store: 'SSLGF', emp_id: emp, state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' },
                { emp_no: String(i + 1), pay_store: 'SSLGF', acct_store: 'SSLHQ', emp_id: 'H' + (i + 1), state: 'confirmed', not_support: 'false', synced_at: '2026-11-05' });
      if (onlySup || chance(0.6)) { (apHQ[E] = apHQ[E] || {})['H' + (i + 1)] = AP(pick([4, 8])); if (onlySup) supOnlyCase++; }
      if (chance(0.4)) (apHQ['2026-11-10'] = apHQ['2026-11-10'] || {})['H' + (i + 1)] = AP(pick([4, 8]));
    }
    // 手填：國定假日時數（跟打卡不同 → 衝突）、總時數調低、只手填支援（沒有日期）
    const man = pick(['none', 'none', 'none', 'hol', 'hours', 'sup']);
    if (man !== 'none') {
      manualCase++;
      const own = approved.filter((a) => a.emp_id === emp).reduce((t, a) => t + a.approved_hours, 0);
      const row = { ym: '2026-11', emp_id: emp, store: 'SSLGF', hours: own, extra_ot: 0, deduct_days: 0, support: '', hours_manual: '' };
      if (man === 'hol') row.holiday_h = pick([4, 8]);
      if (man === 'hours') row.hours = Math.max(0, own - pick([4, 8, 16]));
      if (man === 'sup') { row.hours_manual = '0'; row.support = JSON.stringify([{ code: 'SSLHQ', store: '支援店', hours: pick([4, 8]), rate: ft ? 150 : 200, keep: true }]); }
      input.push(row);
    }
  }
  w.DB.master = master; w.DB.input = input; w.DB.xmap = xmap; w.DB.holiday = [{ ym: '2026-11', store: '', red_days: 9, dates: holDates }];
  w.DB.run = []; w.DB.item = [];
  w.sb.__C = { roster: master.map((m) => ({ emp_id: m.emp_id, name: m.name, active: true })), approved, events: [], leave, requests };
  w.sb.__AP = { SSLHQ: apHQ };
  w.sb.__PUB = { '|T01': { start: '2026-11-01', shifts: [{ id: 'A', name: 'A班', start: '10:00', end: '19:00', break_min: 60 }], rows },
                 '|T02': { start: '2026-11-29', shifts: [], rows: rows.map((r) => ({ emp_id: r.emp_id, name: r.name, cells: Array(28).fill(H) })) } };
  const chosen = master.filter(() => chance(0.6)).map((m) => m.emp_id);
  w.DB.hol_emp = [];
  const r0 = calc({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  w.DB.hol_emp = chosen.map((id) => ({ ym: '2026-11', date: E, store: 'SSLGF', emp_id: id, name: '', note: '', updated_at: '' }));
  w.DB.run = []; w.DB.item = [];
  const r1 = calc({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
  if (!r0.ok || !r1.ok) { bad++; samples.push(['calc失敗', it, r0.error, r1.error]); continue; }
  const by0 = {}; r0.results.forEach((r) => { by0[r.emp_id] = r; });
  r1.results.forEach((r) => {
    const a = by0[r.emp_id]; cmp++;
    if (!a || r.net < a.net - 0.5 || r.gross < a.gross - 0.5) { bad++; if (samples.length < 5) samples.push([it, r.emp_id, a && a.net, r.net]); }
    if (r.earn.some((x) => String(x.item_label).indexOf('選舉日出勤') === 0)) elecPaid++;
    if (r.ot_info && (r.ot_info.elec_warn || r.ot_info.elec_sup_warn)) warned++;
    if (!chosen.includes(r.emp_id) && (r.net !== a.net || JSON.stringify(r.earn) !== JSON.stringify(a.earn))) { bad++; if (samples.length < 5) samples.push(['沒勾選卻不同', it, r.emp_id]); }
  });
}
const ok = bad === 0 && cmp >= N * 6 && elecPaid > 0 && warned > 0;
console.log(`${ok ? '✓' : '✗'} 隨機 ${N} 輪、比對 ${cmp} 人次：勾選後實付／應發小於不勾選、或沒勾選卻不同 ${bad} 人次` +
  `（有發選舉日出勤 ${elecPaid}、有選舉日提醒 ${warned}、手填 ${manualCase}、當天只在別店 ${supOnlyCase}、停用離職 ${depCase}）` + (samples.length ? ' 例：' + JSON.stringify(samples) : ''));
console.log(`\n${ok ? '✅ 1 過、0 失敗' : '❌ 0 過、1 失敗'}`);
process.exit(ok ? 0 : 1);
