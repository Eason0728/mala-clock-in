/* 2026-08-23 審查修正批的回歸測試（四個修正各自驗證）：
 *   A. 出差＋空時段 → 硬擋 trip_needs_periods（修法 A）；出差＋填時段照常 ok
 *   B. 假別白名單外 → 查薪酬假別表放行（同專案直查＋跨後端 UrlFetch 兩條路徑）
 *   C. 計時同仁月中到職 → 勞保／宿舍依在職比例 P 折算（原本收整月）
 *   D. 儀表板趨勢／集團總覽的「要扣回」改 /_leave$/ 正則（新假別扣款不再漏扣）＋出差改名鎖
 * 作法：vm 載入真的 Code.gs／Payroll.gs 跑真函式，試算表換記憶體假表。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

function FakeSheet(headers) { this.headers = headers.slice(); this.rows = []; }
FakeSheet.prototype.getDataRange = function () {
  const all = [this.headers].concat(this.rows);
  return { getValues: () => all.map(r => r.slice()) };
};
FakeSheet.prototype.appendRow = function (a) { this.rows.push(a.slice()); };
FakeSheet.prototype.getRange = function (r, c) {
  const self = this; return { setValue: v => { self.rows[r - 2][c - 1] = v; },
    setValues: vv => { for (let j = 0; j < vv[0].length; j++) self.rows[r - 2][c - 1 + j] = vv[0][j]; } };
};
FakeSheet.prototype.deleteRow = function (r) { this.rows.splice(r - 2, 1); };

function newClockSS() {
  const roster = new FakeSheet(['emp_id','name','key','device_id','device_bound_at','active','shift_in','shift_out','created_at','created_by']);
  roster.appendRow(['Y01','端測試員乙','key-y01','DEV-B','', 'true','','','','']);
  const managers = new FakeSheet(['name','key','active']);
  managers.appendRow(['測試店長乙','mgr-y01','true']);
  return { sheets: {
    roster, managers,
    events:   new FakeSheet(['ts','emp_id','type','lat','lng','distance_m','within_range','device_id','device_match','status','accuracy_m']),
    approved: new FakeSheet(['date','emp_id','name','periods','approved_hours','status_text','manager_name','entered_at']),
    leave:    new FakeSheet(['日期','姓名','假別','時數']),
  }, getSheetByName(n) { return this.sheets[n] || null; } };
}

function makeCtx(code, ss) {
  const sandbox = { console,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss },
    Utilities: { formatDate: d => { const p = n => ('0' + n).slice(-2);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '+08:00'; } },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch() { throw new Error('未 stub'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext('nowTaipeiIso = function(){ return "2026-08-18T21:00:00+08:00"; };', sandbox);
  return { sandbox, call: (fn, ...a) => vm.runInContext(fn, sandbox)(...a), run: s => vm.runInContext(s, sandbox) };
}

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

/* ── A. 出差空時段硬擋 ── */
console.log('══ A. 出差＋空時段 → trip_needs_periods ══');
{
  const ctx = makeCtx(C + '\n' + P, newClockSS());
  ctx.run('payRead = function(){ return []; };');   // 假別表空 → 內建預設（含出差）
  let r = ctx.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '出差', leave_hours: '' });
  chk('空時段被擋', [r.ok, r.error], [false, 'trip_needs_periods']);
  r = ctx.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [{ start: '09:00', end: '17:00' }], leave_type: '出差', leave_hours: '' });
  chk('填時段照常過：8H＋狀態「出差」', [r.ok, r.approved_hours, r.status_text], [true, 8, '出差']);
  r = ctx.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '病假', leave_hours: 8 });
  chk('一般假別整天請假不受影響', [r.ok, r.approved_hours, r.status_text], [true, 0, '全天請假']);
}

/* ── B. 白名單外查薪酬假別表 ── */
console.log('\n══ B. 假別白名單動態放行 ══');
{
  // B1 光復路徑：薪資模組同專案 → 直接查 payLeaveTypes（stub 假別表加一種新假）
  const ctx = makeCtx(C + '\n' + P, newClockSS());
  ctx.run(`payRead = function(kind){
    if (kind === 'leave_type') return [{ code:'newtype', name:'測試新假別', pay_ratio:1,
      count_absent:'false', offset_shortfall:'false', active:'true' }];
    return [];
  };`);
  let r = ctx.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '測試新假別', leave_hours: 8 });
  chk('表上有的新假別（不在白名單）放行', [r.ok, r.leave_type], [true, '測試新假別']);
  r = ctx.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '亂打的假', leave_hours: 8 });
  chk('表上沒有的照舊擋', [r.ok, r.error], [false, 'bad_leave_type']);

  // B2 央廚／總部路徑：無薪資模組 → 打薪酬後端（stub UrlFetchApp）
  const cf = makeCtx(C, newClockSS());
  cf.run(`CONFIG.PAYROLL_API = 'https://fake-payroll/exec'; CONFIG.PAYROLL_STORE = 'CF';
    var __CALLS = [];
    UrlFetchApp = { fetch: function(url, opt){ __CALLS.push(JSON.parse(opt.payload));
      return { getContentText: function(){ return JSON.stringify({ ok:true, types:[{name:'測試新假別'}] }); } }; } };`);
  r = cf.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '測試新假別', leave_hours: 8 });
  const sent = cf.run('__CALLS[0]');
  chk('跨後端查到 → 放行', r.ok, true);
  chk('查詢帶對 store 與主管金鑰', [sent.action, sent.store, sent.mgr_key],
      ['payroll_leave_options', 'CF', 'mgr-y01']);
  cf.run(`UrlFetchApp = { fetch: function(){ throw new Error('薪酬後端連不上'); } };`);
  r = cf.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '另一種新假', leave_hours: 8 });
  chk('薪酬連不上 → 照舊擋（防呆不放水）', [r.ok, r.error], [false, 'bad_leave_type']);
  r = cf.call('handleMgrApprove', { mgr_key: 'mgr-y01', date: '2026-08-18', emp_id: 'Y01',
    periods: [], leave_type: '病假', leave_hours: 8 });
  chk('白名單內假別不打網路照常過', r.ok, true);
}

/* ── C. 計時月中到職：勞保／宿舍 ×P ── */
console.log('\n══ C. 計時勞保宿舍依在職比例折算 ══');
{
  const ctx = makeCtx(C + '\n' + P, newClockSS());
  ctx.run('payRead = function(){ return []; };');
  const cfg = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
  const att = { hours: 80, extra_ot: 0, deduct_days: 0, support: [], bonuses: [], annual: null, leave_usage: {}, work_days: 0 };
  const emp = { emp_id: 'Y01', name: '端測試員乙', is_full_time: 'false', wage: 190, base: 0, skill_allow: 0,
    night_allow: 0, mgr_allow: 0, attend_cap: 0, ot_rate: 0, labor_ins: 310, health_ins: 700, group_ins: 0,
    pension: 0, dormitory: 1500, hire_date: '2026-08-16', leave_date: '', meal_allow: 0, active: 'true' };
  const r = ctx.call('payCalcOne', emp, '2026-08', att, cfg, 8, null);
  const g = k => { const x = r.ded.find(i => i.item_key === k); return x ? x.amount : 0; };
  chk('月中到職 P<1', r.ratio > 0 && r.ratio < 1, true);
  chk('勞保 310×P（不再收整月）', g('labor_ins'), Math.round(310 * r.ratio));
  chk('宿舍 1500×P（不再收整月）', g('dormitory'), Math.round(1500 * r.ratio));
  chk('健保照舊整月', g('health_ins'), 700);
  const full = ctx.call('payCalcOne', Object.assign({}, emp, { hire_date: '2026-08-01' }), '2026-08', att, cfg, 8, null);
  chk('整月在職的計時不變：勞保 310／宿舍 1500',
      [full.ded.find(i => i.item_key === 'labor_ins').amount, full.ded.find(i => i.item_key === 'dormitory').amount], [310, 1500]);
}

/* ── D. REDUCE 正則＋出差改名鎖 ── */
console.log('\n══ D. 儀表板扣回口徑＋出差改名鎖 ══');
{
  const ctx = makeCtx(C + '\n' + P, newClockSS());
  ctx.run(`checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'run') return [{ ym:'2026-08', store:'SSLGF', emp_id:'Y01', gross:30000, net:28000,
        total_hours:100, support_hours:0, surplus_hours:0, ot_paid_hours:0, is_full_time:'true', status:'locked' }];
      if (kind === 'item') return [
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'family_leave',    item_type:'deduction', amount:800 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'shortfall_hours', item_type:'deduction', amount:500 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'health_ins',      item_type:'deduction', amount:700 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'overtime',        item_type:'earning',  amount:1000 }];
      return [];
    };`);
  const t = ctx.call('handlePayrollTrend', { admin_key: 'x', store: 'SSLGF', ym: '2026-08', months: 1 });
  chk('趨勢：新假別扣款也扣回 30000-(800+500)=28700（舊版會算 29500）',
      t.months[0].salary_cost, 28700);
  const gp = ctx.call('handlePayrollGroup', { admin_key: 'x', ym: '2026-08' });
  chk('集團總覽同口徑 28700', gp.rows[0].salary_cost, 28700);

  ctx.run('payReplaceAll = function(){}; payAppend = function(){};');
  let r = ctx.call('handlePayrollLeaveTypeSet', { admin_key: 'x', store: '',
    types: [{ code: 'trip', name: '外勤', pay_ratio: 1 }] });
  chk('trip 改名被鎖', [r.ok, r.error], [false, 'trip_name_locked']);
  r = ctx.call('handlePayrollLeaveTypeSet', { admin_key: 'x', store: '',
    types: [{ code: 'trip', name: '出差', pay_ratio: 1 }] });
  chk('名稱維持「出差」可存', [r.ok, r.saved], [true, 1]);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 審查修正批全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
