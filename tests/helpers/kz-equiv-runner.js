// 曠職「開關關＝跟改之前逐字相同」的對照跑者（2026-11-26）：用 GS_ROOT 指到哪一版的 apps-script 就跑哪一版，
// 把一組固定請求的完整回應＋試算表快照印成 JSON（tests/kuangzhi-equiv.test.js 跑兩次比對）。全部假資料。
// 用法：GS_ROOT=<某版本根目錄> KZ_PROPS='{"KUANGZHI_FROM":"on"}' node tests/helpers/kz-equiv-runner.js
'use strict';
const { make, T } = require('./gs-sandbox');
const extraProps = JSON.parse(process.env.KZ_PROPS || '{}');
const D = '2026-12-03';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const YOU = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' };
const KZS = { work: true, hours: 8, xpunch: false, xreq: false };

function env(o) {
  o = o || {};
  const m = make({ now: T(o.now || '2026-12-08T10:00:00'), payroll: !!o.payroll,
    props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, extraProps, o.props || {}),
    config: Object.assign({ NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' }, o.config || {}),
    self: { roster: [ME, YOU], events: o.events || [], approved: o.approved || [], leave: o.leave || [] } });
  const sh = m.sb.reqSheet_(m.self, true);
  (o.reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: '2026-12-02T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'pending' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
const snap = (m) => ({ approved: m.self.sh.approved.values.slice(1), leave: m.self.sh.leave.values.slice(1) });
const out = [];
function run(name, o, body, how) {
  const m = env(o);
  let res;
  try {
    if (how === 'check') res = m.sb.reqMgrApproveCheck_(body);
    else if (how === 'home') res = m.sb.reqMgrApproveHome_(body);
    else if (how === 'allowed') res = m.sb.leaveTypeAllowedByPayroll(body.type, 'AK');
    else if (how === 'validate') res = m.sb.reqValidate_(body, ME, [], '2026-12-08', [], body.__proxy === true);
    else if (how === 'recent') res = m.sb.handleMyRecent(body);
    else if (how === 'day') res = m.sb.handleMgrDay(body);
    else res = m.sb.handleMgrApprove(body);
  } catch (e) { res = { threw: String(e && e.message) }; }
  if (res && res.timing) delete res.timing;   // 只檢查的分段計時（毫秒）每次不同
  out.push({ name, res, sheets: snap(m) });
}
const ACT = { mgr_key: 'AK', acting_name: '店長甲' };
const KZ = Object.assign({}, ACT, { date: D, emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: KZS });
const PUNCH = [[D + 'T10:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']];
const SICK_OK = { kind: 'leave', leave_type: '病假', start: '', end: '', hours: 8, status: 'approved' };

run('一般核定（有打卡）', { events: PUNCH }, Object.assign({}, ACT, { date: D, emp_id: 'E01', periods: [{ start: '10:00', end: '18:00' }] }));
run('曠職、個人帳號、班表事實齊全', {}, KZ);
run('曠職、門市鑰匙', {}, Object.assign({}, KZ, { mgr_key: 'MK', acting_name: undefined }));
run('曠職＋上班時段', { events: PUNCH }, Object.assign({}, KZ, { periods: [{ start: '10:00', end: '18:00' }] }));
run('曠職＋事假', { reqs: [Object.assign({}, SICK_OK, { leave_type: '事假' })] }, Object.assign({}, KZ, { leaves: [{ type: '曠職', hours: 8 }, { type: '事假', hours: 8 }] }));
run('曠職、有待審單', { reqs: [{ kind: 'ot', start: '19:00', end: '20:00', hours: 1 }] }, KZ);
run('曠職、舊呼叫端 leave_type', {}, Object.assign({}, ACT, { date: D, emp_id: 'E01', periods: [], leave_type: '曠職', leave_hours: 8 }));
run('曠職、只檢查', {}, Object.assign({}, KZ, { dry_run: true }));
run('曠職、走 mgr_approve 入口', {}, KZ, 'home');
run('整天病假（有已核准假單）', { reqs: [SICK_OK] }, Object.assign({}, ACT, { date: D, emp_id: 'E01', periods: [], leaves: [{ type: '病假', hours: 8 }] }));
run('只檢查一批（含曠職）', {}, Object.assign({}, ACT, { date: D, items: [{ emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: KZS }, { emp_id: 'E02', periods: [], leaves: [] }] }), 'check');
run('白名單外假別查表：曠職（光復，有薪資模組）', { payroll: true }, { type: '曠職' }, 'allowed');
run('白名單外假別查表：補休（光復）', { payroll: true }, { type: '補休' }, 'allowed');
run('同仁請假單：曠職', {}, { kind: 'leave', leave_type: '曠職', date: '2026-12-07', hours: 8 }, 'validate');
run('主管代開：曠職（光復）', { payroll: true }, { kind: 'leave', leave_type: '曠職', date: D, hours: 8, __proxy: true, mgr_key: 'AK' }, 'validate');
run('打卡頁最近 40 天', { events: PUNCH, approved: [[D, 'E01', '測試一', '10:00-18:00', 8, '正常', '店長甲', '2026-12-04T09:00:00+08:00']] }, { key: 'K1', device_id: 'D1' }, 'recent');
run('打卡頁最近 40 天（有一筆手填的曠職登記）', { approved: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-12-08T09:00:00+08:00']], leave: [[D, '測試一', '曠職', 8]] }, { key: 'K1', device_id: 'D1' }, 'recent');
// 合約 v1.2（2026-11-26）：mgr_day 的 approved 只在「那天有曠職登記、開關開、日期 ≥ 生效日」才多帶 entered_at（with_ver 版本跟著變）
const KZ_DAY = { approved: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-12-08T09:00:00+08:00'], [D, 'E02', '測試二', '10:00-18:00', 8, '正常', '店長甲', '2026-12-04T09:00:00+08:00']],
  leave: [[D, '測試一', '曠職', 8]], events: [[D + 'T10:00:00', 'E02', 'in'], [D + 'T18:00:00', 'E02', 'out']] };
run('mgr_day：那天有曠職登記', KZ_DAY, { mgr_key: 'AK', date: D }, 'day');
run('mgr_day：那天有曠職登記（with_ver）', KZ_DAY, { mgr_key: 'MK', date: D, with_ver: true }, 'day');
run('mgr_day：生效日前的曠職登記（11/20）', { approved: [['2026-11-20', 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-11-26T09:00:00+08:00']], leave: [['2026-11-20', '測試一', '曠職', 8]] }, { mgr_key: 'AK', date: '2026-11-20', with_ver: true }, 'day');
run('mgr_day：別的假別（病假）', { approved: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-12-08T09:00:00+08:00']], leave: [[D, '測試一', '病假', 8]] }, { mgr_key: 'AK', date: D, with_ver: true }, 'day');
process.stdout.write(JSON.stringify(out));
