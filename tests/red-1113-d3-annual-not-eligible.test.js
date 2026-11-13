/* 1113 紅燈 d3（Eason 2026-11-13 選 B）：請假端直接擋——到職未滿六個月不能請特休。
 * 假別＝特休假、請假日期早於「到職滿六個月那天」（payAnnualFirstPs_，到職日用薪資主檔同一份）→ annual_not_eligible，
 * 訊息「到職滿六個月（YYYY-MM-DD）起才能請特休，這之前請改請事假或補休」。
 * 入口：同仁 LINE 送單（req_submit）、主管代開（mgr_req_proxy）、主管核准（mgr_req_decide／批次，核准時再查一次）。
 * 查不到到職日就不擋（照舊）。到職日來源：
 *   和薪資同專案（光復）→ 直接讀薪資主檔；別家店 → LINE 送單打光復 line_hub_req_quota（帶 annual_from），主管端打 payroll_annual_from。
 * 全部虛構同仁。 */
'use strict';
const vm = require('vm');
const { make, T, check, done } = require('./helpers/gs-sandbox');
const { load, ftEmp } = require('./helpers/payroll-vm');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const NOW = '2026-11-10T10:00:00';
const FROM = '2026-12-01';   // 到職 2026-06-01 → 滿六個月 2026-12-01

/** 別家店（沒有薪資）：光復回 annual_from（null＝光復查不到這個人） */
function store(from, asked) {
  return make({ now: T(NOW), self: { roster: [ME], events: [] },
    fetch: (url, o) => {
      let b = {}; try { b = JSON.parse(o.payload); } catch (e) { return undefined; }
      if (b.action === 'line_hub_req_quota') { asked && asked.push(b.action); return { ok: true, quota: [], comp: {}, annual_from: from }; }
      if (b.action === 'payroll_annual_from') { asked && asked.push(b.action + ':' + b.emp_id); return from == null ? { ok: false, error: 'not_found' } : { ok: true, annual_from: from }; }
      return undefined;
    } });
}
const sub = (m, type, date) => { const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: type, date, hours: 8, reason: '測試' }); return r.ok ? 'ok' : r.error + '｜' + (r.message || ''); };
const MSG = 'annual_not_eligible｜到職滿六個月（2026-12-01）起才能請特休，這之前請改請事假或補休';

console.log('══ 一、同仁 LINE 送單 ══');
let asked = [];
let m = store(FROM, asked);
check('d3-01', '特休假、11/20（未滿六個月）→ 擋', sub(m, '特休假', '2026-11-20'), MSG);
check('d3-02', '有去光復查到職日', asked.indexOf('line_hub_req_quota') >= 0, true);
check('d3-03', '反例：特休假、12/01（滿六個月當天）→ 可以送', sub(m, '特休假', '2026-12-01'), 'ok');
check('d3-04', '反例：事假、11/23 → 可以送（只擋特休）', sub(m, '事假', '2026-11-23'), 'ok');
m = store('');
check('d3-05', '反例：光復查不到到職日（annual_from 空白）→ 不擋', sub(m, '特休假', '2026-11-20'), 'ok');

console.log('\n══ 二、主管核准時再查一次（單筆、批次） ══');
asked = [];
m = store('', asked);   // 送單時查不到 → 放行；核准時查得到 → 擋
const id1 = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: '特休假', date: '2026-11-20', hours: 8, reason: '測試' }).request.id;
const id2 = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: '特休假', date: '2026-11-21', hours: 8, reason: '測試' }).request.id;
const id3 = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: '事假', date: '2026-11-22', hours: 8, reason: '測試' }).request.id;
m.sb.__FROM = FROM;
m.sb.UrlFetchApp = { fetch: (url, o) => { const b = JSON.parse(o.payload); asked.push(b.action + ':' + b.emp_id); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(b.action === 'payroll_annual_from' ? { ok: true, annual_from: FROM } : {}) }; } };
let d = JSON.parse(JSON.stringify(m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: id1, decision: 'approve' })));
check('d3-06', '核准未滿六個月的特休 → 擋（照樣是審核中）', [d.ok, d.error, d.message], [false, 'annual_not_eligible', '到職滿六個月（2026-12-01）起才能請特休，這之前請改請事假或補休']);
check('d3-07', '核准時用主管金鑰查 payroll_annual_from（帶工號）', asked.indexOf('payroll_annual_from:E01') >= 0, true);
d = JSON.parse(JSON.stringify(m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: id1, decision: 'reject', reason: '改請事假' })));
check('d3-08', '反例：退回不擋', [d.ok, d.status], [true, 'rejected']);
d = JSON.parse(JSON.stringify(m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [id2, id3], decision: 'approve' })));
check('d3-09', '批次：特休那筆略過、說明原因；事假照常核准', [d.done, d.skipped], [[id3], [{ id: id2, reason: '到職滿六個月（2026-12-01）起才能請特休，這之前請改請事假或補休' }]]);

console.log('\n══ 三、主管代開 ══');
m = make({ now: T(NOW), self: { roster: [Object.assign({}, ME, { line_user_id: '' })], events: [] },
  fetch: (url, o) => { const b = JSON.parse(o.payload); if (b.action === 'payroll_annual_from') return { ok: true, annual_from: FROM }; return undefined; } });
const px = (type, date) => { const r = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E01', kind: 'leave', leave_type: type, date, hours: 8, reason: '沒綁 LINE' }); return r.ok ? 'ok' : r.error + '｜' + (r.message || ''); };
check('d3-10', '代開特休假 11/09（未滿六個月）→ 擋', px('特休假', '2026-11-09'), MSG);
check('d3-11', '反例：代開事假 11/08 → 可以', px('事假', '2026-11-08'), 'ok');

console.log('\n══ 四、薪資端：到職日來源＝薪資主檔 ══');
{
  const data = { master: [ftEmp({ emp_id: 'E01', name: '測試一', hire_date: '2026-06-01' }), ftEmp({ emp_id: 'E02', name: '測試二', hire_date: '' }),
    ftEmp({ emp_id: 'GF09', name: '測試九', hire_date: '2026-08-31', store: 'MZTGF' })], store: [{ code: 'SSLGF', clock_ss_id: '', emp_prefix: '' }, { code: 'MZTGF', clock_ss_id: 'x', emp_prefix: 'GF' }] };
  const s = load({ data, clock: { SSLGF: { managers: [{ key: 'MK', active: 'true' }] }, MZTGF: { managers: [{ key: 'MK2', active: 'true' }] } } });
  vm.runInContext('payStoreRow = function (c) { return (__DATA.store || []).filter(function (x) { return x.code === c; })[0] || null; }; checkAdmin = function () { return false; };', s);
  const f = (st, id) => s.call('payAnnualFromOf_', st, id);
  check('d3-12', '到職 2026-06-01 → 2026-12-01', f('SSLGF', 'E01'), FROM);
  check('d3-13', '到職日空白 → 空字串（不擋）', f('SSLGF', 'E02'), '');
  check('d3-14', '別家店打卡工號沒帶前綴（09）→ 對到主檔 GF09；8/31 到職 → 2027-02-28（月底不溢位）', f('MZTGF', '09'), '2027-02-28');
  check('d3-15', '找不到人 → 空字串', f('SSLGF', 'E99'), '');
  const h = (b) => JSON.parse(JSON.stringify(s.call('handlePayrollAnnualFrom', b)));
  check('d3-16', 'payroll_annual_from：主管金鑰對 → 回 annual_from', h({ store: 'SSLGF', mgr_key: 'MK', emp_id: 'E01' }), { ok: true, annual_from: FROM });
  check('d3-17', 'payroll_annual_from：金鑰不對 → unauthorized', h({ store: 'SSLGF', mgr_key: 'XX', emp_id: 'E01' }).error, 'unauthorized');
  check('d3-18', 'payroll_annual_from 有掛進 PAYROLL_HANDLERS', vm.runInContext('typeof PAYROLL_HANDLERS.payroll_annual_from', s), 'function');
}
console.log('\n══ 五、光復 line_hub_req_quota 帶 annual_from（LINE 身分→薪資主檔） ══');
{
  const hub = make({ now: T(NOW), hub: true, payroll: true, self: { roster: [ME], events: [] } });
  hub.run(`lineHubPayslipFor_ = function () { return { ok: true, leave_quota: [] }; }; lineHubCompFor_ = function () { return null; };
    lineHubPayPick_ = function (u) { return u === 'U1' ? { me: { emp_id: 'E01', name: '測試一' }, store: 'SSLGF' } : null; };
    payRead = function (k) { return k === 'master' ? [{ emp_id: 'E01', name: '測試一', store: 'SSLGF', hire_date: '2026-06-01' }] : []; };
    payStoreRow = function () { return { code: 'SSLGF', emp_prefix: '' }; };`);
  check('d3-19', 'lineHubReqQuota_ 回 annual_from 2026-12-01', hub.sb.lineHubReqQuota_('U1').annual_from, FROM);
  check('d3-20', '反例：薪資找不到這個人 → annual_from 空白', hub.sb.lineHubReqQuota_('U9').annual_from, '');
  check('d3-21', '光復本身送單（同專案、不打網路）也擋', sub(hub, '特休假', '2026-11-20'), MSG);
}
done();
