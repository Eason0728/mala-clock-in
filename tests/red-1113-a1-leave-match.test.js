/**
 * 1113 紅燈 a1（Eason 2026-11-13 選 A）：鎖月前比對「已核准請假單」與 leave 分頁。
 *  - requests 有已核准請假（含補休）或出差單、leave 那天沒有同假別列 → 列「請假單有、請假登記沒有」
 *  - leave 有假別列、卻沒有已核准的單 → 列「請假登記有、請假單沒有」
 *  - 有差異：鎖定回 leave_mismatch（list、白話 message），不能鎖；解鎖不擋；2026-11 以前不查（PAY_LEAVE_MATCH_FROM）
 *  - 試算（payroll_calc）回應帶 leave_mismatch 讓畫面標紅；沒有差異就不帶
 * 全部虛構同仁（代號），期望值手寫。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const RQ = (emp, name, date, kind, type, status) => ({ id: 'R' + emp + date + (type || kind), emp_id: emp, name: name, kind: kind, date: date,
  leave_type: type || '', hours: 8, status: status || 'approved' });
const LV = (date, name, type, h) => ({ '日期': date, '姓名': name, '假別': type, '時數': h == null ? 8 : h });

const master = [ftEmp({ emp_id: 'E01', name: '代號甲' }), ftEmp({ emp_id: 'E02', name: '代號乙' })];
const data = () => ({
  master: master.map(x => Object.assign({}, x)),
  holiday: [{ ym: '2026-10', red_days: 8, note: '', dates: '', store: '' }, { ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }],
  config: [], run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], xmap: [], leave_span: [], leave_event: [], cost_snapshot: [],
  store: [{ code: 'SSLGF', name: '甲店（虛構）', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
});
function env(clock) {
  const s = load({ data: data(), clock: { SSLGF: Object.assign({ roster: [], approved: [], events: [], leave: [], requests: [] }, clock) }, today: '2026-12-02' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}

const D12 = (s) => vm.runInContext('new Date(2026, 10, 12)', s);
const CLOCK = (s) => ({
  requests: [
    RQ('E01', '代號甲', '2026-11-03', 'leave', '事假'),              // leave 沒有 → 請假單多
    RQ('E01', '代號甲', '2026-11-06', 'leave', '特休假'),            // 兩邊都有 → 不列
    RQ('E01', '代號甲', '2026-11-07', 'trip', '出差'),               // 出差單 ↔ leave「出差」→ 不列
    RQ('E02', '代號乙', '2026-11-08', 'leave', '病假', 'pending'),   // 審核中不算
    RQ('E02', '代號乙', '2026-11-09', 'leave', '病假', 'voided'),    // 作廢不算
    RQ('E02', '代號乙', '2026-11-10', 'leave', '補休'),              // 補休也比；leave 記成事假 → 兩邊各多一筆
    RQ('E02', '代號乙', '2026-11-12', 'leave', '事假'),              // leave 日期被轉成 Date 物件 → 認得、不列
    RQ('E01', '代號甲', '2026-10-30', 'leave', '事假'),              // 別的月份不列
    RQ('E09', '外人', '2026-11-04', 'leave', '事假'),                // 不在本店薪資主檔 → 不列
  ],
  leave: [
    LV('2026-11-05', '代號甲', '病假'),            // 沒有單 → 請假登記多
    LV('2026-11-06', '代號甲 ', '特休假', 4),      // 姓名尾端空白也對得上
    LV('2026-11-07', '代號甲', '出差', ''),
    LV('2026-11-10', '代號乙', '事假'),
    LV(D12(s), '代號乙', '事假'),
    LV('2026-12-01', '代號甲', '事假'),            // 別的月份
    LV('2026-11-04', '外人', '病假'),              // 不在主檔
  ],
});

console.log('══ a1 純函式：payLeaveMismatch_ ══');
{
  const s = env({});
  Object.assign(s.__CLOCK.SSLGF, CLOCK(s));
  let got = null;
  try { got = JSON.parse(JSON.stringify(s.call('payLeaveMismatch_', '2026-11', ST))); } catch (e) { got = 'ERR ' + e.message; }
  eq(got, [
    { emp_id: 'E01', name: '代號甲', date: '2026-11-03', type: '事假', side: 'request' },
    { emp_id: 'E01', name: '代號甲', date: '2026-11-05', type: '病假', side: 'leave' },
    { emp_id: 'E02', name: '代號乙', date: '2026-11-10', type: '事假', side: 'leave' },
    { emp_id: 'E02', name: '代號乙', date: '2026-11-10', type: '補休', side: 'request' },
  ], '列出 4 筆（依日期、姓名、假別）：11/03 單多、11/05 登記多、11/10 補休↔事假各多一筆');
  let early = null;
  try { early = JSON.parse(JSON.stringify(s.call('payLeaveMismatch_', '2026-10', ST))); } catch (e) { early = 'ERR ' + e.message; }
  eq(early, [], '2026-10（PAY_LEAVE_MATCH_FROM 之前）一律空');
  eq(vm.runInContext('typeof PAY_LEAVE_MATCH_FROM === "string" ? PAY_LEAVE_MATCH_FROM : null', s), '2026-11', '起算常數 PAY_LEAVE_MATCH_FROM＝2026-11');
}

console.log('\n══ a1 鎖定：leave_mismatch 擋下 ══');
{
  const s = env({});
  Object.assign(s.__CLOCK.SSLGF, CLOCK(s));
  // 其他六道檢查都放行，只看第 7 道
  vm.runInContext(`payLockStale_=function(){return {list:[]};};payCompNegatives=function(){return [];};paySchedMissingAll_=function(){return [];};payUnapprovedAll_=function(){return [];};`, s);
  s.__DATA.run = [{ ym: '2026-11', emp_id: 'E01', name: '代號甲', store: ST, status: 'draft', ot_info: '{}' }];
  let r = s.post('handlePayrollFinalize', { ym: '2026-11', store: ST, lock: true });
  eq([r.ok, r.error, (r.list || []).length], [false, 'leave_mismatch', 4], '鎖定 2026-11 → leave_mismatch、名單 4 筆');
  eq(/請假單和請假登記對不上/.test(r.message || '') && /11\/3 代號甲 事假：請假單有、請假登記沒有/.test(r.message || '') && /11\/5 代號甲 病假：請假登記有、請假單沒有/.test(r.message || ''), true,
    '訊息白話：11/3 代號甲 事假：請假單有、請假登記沒有；11/5 代號甲 病假：請假登記有、請假單沒有');
  eq(s.__DATA.run[0].status, 'draft', '被擋時沒有鎖（狀態仍是草稿）');
  r = s.post('handlePayrollFinalize', { ym: '2026-11', store: ST, lock: false, reason: '測試' });
  eq(r.error === 'leave_mismatch', false, '解鎖不擋');
  s.__DATA.run = [{ ym: '2026-10', emp_id: 'E01', name: '代號甲', store: ST, status: 'draft', ot_info: '{}' }];
  s.__CLOCK.SSLGF.requests = [RQ('E01', '代號甲', '2026-10-03', 'leave', '事假')];
  r = s.post('handlePayrollFinalize', { ym: '2026-10', store: ST, lock: true });
  eq(r.error === 'leave_mismatch', false, '反例：2026-10 不查');
  // 兩邊對齊 → 不擋
  s.__DATA.run = [{ ym: '2026-11', emp_id: 'E01', name: '代號甲', store: ST, status: 'draft', ot_info: '{}' }];
  s.__CLOCK.SSLGF.requests = [RQ('E01', '代號甲', '2026-11-03', 'leave', '事假'), RQ('E01', '代號甲', '2026-11-05', 'leave', '病假')];
  s.__CLOCK.SSLGF.leave = [LV('2026-11-03', '代號甲', '事假'), LV('2026-11-05', '代號甲', '病假')];
  r = s.post('handlePayrollFinalize', { ym: '2026-11', store: ST, lock: true });
  eq([r.ok, r.status], [true, 'final'], '反例：兩邊對齊 → 照常鎖定');
}

console.log('\n══ a1 試算：payroll_calc 帶 leave_mismatch ══');
{
  const s = env({});
  Object.assign(s.__CLOCK.SSLGF, CLOCK(s));
  let r = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq([r.ok, (r.leave_mismatch || []).map(x => x.date.slice(5) + x.side)], [true, ['11-03request', '11-05leave', '11-10leave', '11-10request']], '試算回應帶 leave_mismatch 4 筆');
  s.__CLOCK.SSLGF.requests = []; s.__CLOCK.SSLGF.leave = [];
  r = s.post('handlePayrollCalc', { ym: '2026-11', store: ST });
  eq([r.ok, 'leave_mismatch' in r], [true, false], '反例：沒有差異 → 回應不帶這個欄位');
}

console.log('\n══ a1 畫面：payroll.html ══');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  eq(/r\.error==='leave_mismatch'/.test(html), true, '鎖定被 leave_mismatch 擋時跳對話框（同 sched_missing、unapproved）');
  eq(/LEAVE_MM=r\.leave_mismatch\|\|\[\]/.test(html), true, '試算結果的 leave_mismatch 存起來');
  eq(/LEAVE_MM\.forEach\(/.test(html) && /鎖定/.test(html), true, '提醒區逐筆紅字列出');
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
