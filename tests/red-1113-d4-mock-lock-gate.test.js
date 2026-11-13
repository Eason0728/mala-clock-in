/* 1113 紅燈 d4（Eason 2026-11-13 選 A）：本機假後端 payroll_finalize 補齊正式版的鎖定前檢查
 * （stale_run、comp_negative、comp_over、ot_form_missing、sched_missing、unapproved、leave_mismatch），行為與訊息同正式版。
 * 做法：mock/payroll_mock_handlers.py 的 h_finalize 鎖定時把資料交給 mock/payroll_lock_gate.js，那支直接跑 apps-script 的 handlePayrollFinalize。
 * 這裡用 python3 真的呼叫 h_finalize，一關一關把問題拿掉，最後才鎖得成；再拿同一份資料跑正式版，訊息要一樣。全部虛構同仁。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const { load } = require('./helpers/payroll-vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const TODAY = '2026-12-02', YM = '2026-11', ST = 'SSLGF';

function finalize(data, body) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'mock'))})
import payroll_mock_handlers as H
data = json.loads(sys.stdin.read())
out = H.h_finalize(data, json.loads(${JSON.stringify(JSON.stringify(body || { ym: YM, store: ST, lock: true }))}))
print(json.dumps({'out': out, 'run': [r.get('status') for r in data['payroll']['run'] if r.get('ym') == '${YM}']}, ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { MOCK_TODAY: TODAY, MOCK_NODE: process.execPath });
  return JSON.parse(execFileSync('python3', ['-c', py], { input: JSON.stringify(data), env, encoding: 'utf8' }));
}

// 班表：2026-11 每一天都排上班（用正式版的期別算法產生，不手算期別）
const SP = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/SchedPub.gs'), 'utf8'), SP);
function fullSched(emps) {
  const out = {};
  for (let d = 1; d <= 30; d++) {
    const ds = YM + '-' + String(d).padStart(2, '0');
    const p = vm.runInContext(`schedPubPeriodOf_(${JSON.stringify(ds)})`, SP), i = vm.runInContext(`schedPubIndex_(${JSON.stringify(ds)})`, SP);
    const k = '|' + p;
    out[k] = out[k] || { rows: emps.map((e) => ({ emp_id: e.emp_id, name: e.name, cells: Array.from({ length: 28 }, () => null) })) };
    out[k].rows.forEach((r) => { r.cells[i] = { t: 'W', s: 'A' }; });
  }
  return out;
}

const M = { emp_id: 'E01', name: '代號甲', is_full_time: 'true', base: 30000, active: 'TRUE', store: ST, hire_date: '2020-01-01', leave_date: '' };
function world() {
  return {
    roster: [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'TRUE' }],
    events: [], approved: [], requests: [], leave: [],
    payroll: { master: [Object.assign({}, M)], holiday: [{ ym: YM, red_days: 10, store: '' }], run: [], input: [], config: {}, store: [{ code: ST, name: '甲店（虛構）', emp_prefix: '' }] },
  };
}
// mock 自己的簡化算薪：正職＝本薪 30000、沒有扣項 → 實付 30000
const RUN = (o) => Object.assign({ ym: YM, emp_id: 'E01', name: '代號甲', store: ST, status: 'draft', gross: 30000, deduction: 0, net: 30000 }, o || {});
const REQ = (o) => Object.assign({ id: 'R' + Math.random().toString(36).slice(2, 8), emp_id: 'E01', name: '代號甲', kind: 'leave', hours: 8, status: 'approved', created_at: '2026-11-01T09:00:00+08:00' }, o);

let w = world(), r;
w.payroll.run = [RUN({ net: 29000 })];
r = finalize(w);
eq([r.out.ok, r.out.error, r.run], [false, 'stale_run', ['draft']], 'd4-1 草稿實付 29000、現在算 30000 → stale_run，沒有鎖');

w.payroll.run = [RUN()];
w.requests = [REQ({ date: '2026-11-04', leave_type: '補休' })];
w.leave = [{ date: '2026-11-04', name: '代號甲', type: '補休', hours: 8 }];
r = finalize(w);
eq([r.out.ok, r.out.error], [false, 'comp_negative'], 'd4-2 請了 8 小時補休、沒有加班 → comp_negative');

w.requests = []; w.leave = [];
w.payroll.run = [RUN({ ot_info: JSON.stringify({ comp_over_h: 2 }) })];
r = finalize(w);
eq([r.out.ok, r.out.error], [false, 'comp_over'], 'd4-3 草稿 ot_info 補休抵不掉 2 小時 → comp_over');

w.payroll.run = [RUN({ ot_info: JSON.stringify({ ot_form_missing: [{ date: '2026-11-06', need: 2, have: 0 }] }) })];
r = finalize(w);
eq([r.out.ok, r.out.error], [false, 'ot_form_missing'], 'd4-4 草稿 ot_info 缺加班單 → ot_form_missing');

w.payroll.run = [RUN()];
r = finalize(w);
eq([r.out.ok, r.out.error], [false, 'sched_missing'], 'd4-5 沒有發布班表 → sched_missing');

w.payroll.sched_pub = fullSched([M]);
w.events = [{ ts: '2026-11-03T09:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }, { ts: '2026-11-03T18:00:00+08:00', emp_id: 'E01', type: 'out', status: 'ok' }];
r = finalize(w);
eq([r.out.ok, r.out.error, r.out.message], [false, 'unapproved', '還有 1 天有打卡但沒核定，請主管先核定完再鎖定：11/3 代號甲'], 'd4-6 11/3 有打卡沒核定 → unapproved（訊息同正式版）');

w.approved = [{ date: '2026-11-03', emp_id: 'E01', name: '代號甲', periods: '09:00-18:00', approved_hours: 8, status_text: '正常', manager_name: '值班', entered_at: '2026-11-03T20:00:00+08:00' }];
w.requests = [REQ({ date: '2026-11-05', leave_type: '事假' })];
r = finalize(w);
eq([r.out.ok, r.out.error, (r.out.list || []).length], [false, 'leave_mismatch', 1], 'd4-7 11/5 已核准事假、請假登記沒有 → leave_mismatch');
const mockMsg = r.out.message;

w.leave = [{ date: '2026-11-05', name: '代號甲', type: '事假', hours: 8 }];
r = finalize(w);
eq([r.out.ok, r.out.status, r.run], [true, 'final', ['final']], 'd4-8 全部處理完 → 鎖定成功');
r = finalize(w, { ym: YM, store: ST, lock: false, reason: '測試' });
eq([r.out.ok, r.out.status], [true, 'draft'], 'd4-9 解鎖不擋');

// 同一份資料（11/5 請假登記拿掉）跑正式版：訊息要一樣
{
  const s = load({ data: { master: [Object.assign({}, M, { active: 'true' })], run: [RUN()], holiday: [{ ym: YM, red_days: 10, store: '' }], store: [{ code: ST, emp_prefix: '' }] },
    clock: { SSLGF: { approved: w.approved, events: w.events, requests: w.requests, leave: [], roster: w.roster } }, today: TODAY });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/SchedPub.gs'), 'utf8'), s);   // payroll-vm 沒載班表模組
  vm.runInContext(`checkAdmin = function () { return true; }; payLockStale_ = function () { return { list: [] }; };
    schedPubLoad_ = function () { return ${JSON.stringify(fullSched([M]))}; };`, s);
  const real = JSON.parse(JSON.stringify(s.call('handlePayrollFinalize', { ym: YM, store: ST, lock: true })));
  eq([real.error, real.message], ['leave_mismatch', mockMsg], 'd4-10 正式版同一份資料 → 同樣是 leave_mismatch、訊息一字不差');
}

// 找不到 node → 不鎖（同正式版「檢查失敗就不鎖」）
{
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'mock'))})
import payroll_mock_handlers as H
data = json.loads(sys.stdin.read())
print(json.dumps(H.h_finalize(data, {'ym': '${YM}', 'store': '${ST}', 'lock': True}), ensure_ascii=False))
`;
  const env = Object.assign({}, process.env, { MOCK_TODAY: TODAY, MOCK_NODE: '/nonexistent/node', PATH: '/nonexistent', HOME: '/nonexistent' });
  const PY = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();   // PATH 拿掉後要用絕對路徑叫 python
  const out = JSON.parse(execFileSync(PY, ['-c', py], { input: JSON.stringify(w), env, encoding: 'utf8' }));
  eq([out.ok, out.error], [false, 'recheck_failed'], 'd4-11 跑不了檢查（找不到 node）→ recheck_failed，不鎖');
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
