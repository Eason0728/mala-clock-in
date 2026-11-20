/* 還有待審的申請單就不能核定，打卡後端也擋（2026-11-20 Eason 第 13 題 A；Requests.gs reqPendBlock_、Code.gs handleMgrApprove）。
 * 規則白話：requests 裡這位同仁、這一天還有 status＝pending 的單（加班、請假、忘打卡、出差不分種類；本人送的、要上層審的也算）→ 核定一律退回，
 *   字句同營運系統畫面「這天還有待審的申請，請先審單（審完才能核定）」。核定、重新核定、整天請假、只檢查（dry_run）都擋。
 * 手算預期（2026-11-20，打卡 09:00–17:00，核定 09:00–17:00）：
 *   P1 加班單待審 → 擋 pending_request｜P2 假單待審 → 擋｜P3 忘打卡單待審 → 擋｜P4 出差單待審 → 擋
 *   P5 待審單在別天 → 可以核定｜P6 別人的待審單 → 可以｜P7 已核准／退回／取消／作廢 → 可以
 *   P8 只檢查（dry_run）也擋｜P9 整天請假（沒有上班時段）也擋｜P10 舊值班頁、營運系統個人帳號都擋
 *   P11 指令碼屬性 REQ_PEND_BLOCK=off → 不擋（退回用）｜P12 待審單核准後 → 可以核定
 *   P13 薪資鎖月照舊先擋（pay_locked 優先）不在這裡測；P14 加嚴日期以前的日子也擋（這條沒有起算日）
 * 名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const D = '2026-11-20';
const MSG = '這天還有待審的申請，請先審單（審完才能核定）';
function env(reqs, props, date) {
  const d = date || D;
  const m = make({ now: T('2026-11-21T21:00:00'), props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props || {}),
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME, { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' }],
      events: [[d + 'T09:00:00', 'E01', 'in'], [d + 'T17:00:00', 'E01', 'out']] } });
  const sh = m.sb.reqSheet_(m.self, true);
  (reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: d + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: d, status: 'pending' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
function approve(m, extra, date) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: date || D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', message: r.message || '', pending: r.pending, status: r.status_text || '' };
}
const OT = { kind: 'ot', start: '17:00', end: '18:00', hours: 1 };
const LV = { kind: 'leave', leave_type: '事假', start: '13:00', end: '14:00', hours: 1 };
const MS = { kind: 'miss', miss_type: 'out', start: '', end: '17:00' };
const TR = { kind: 'trip', leave_type: '出差', start: '14:00', end: '15:00', hours: 1, reason: '地點：測試；事由：測試' };

console.log('════ 一、各種待審單都擋 ════');
for (const [id, label, rq] of [['P1', '加班單', OT], ['P2', '假單', LV], ['P3', '忘打卡單', MS], ['P4', '出差單', TR]]) {
  const r = approve(env([rq]));
  check(id, label + '待審 → 擋 pending_request、字句同畫面、不寫核定', [r.ok, r.error, r.message, r.pending], [false, 'pending_request', MSG, 1]);
}
{
  const m = env([OT, LV]);
  const r = approve(m);
  const n = m.sb.readSheetAsObjects(m.self.getSheetByName('approved')).rows.length;
  check('P1b', '兩張待審 → pending 2；approved 分頁沒有新增', [r.ok, r.pending, n], [false, 2, 0]);
}

console.log('\n════ 二、不相干的單不擋 ════');
check('P5', '待審單在別天（11/19）→ 可以核定', approve(env([Object.assign({}, OT, { date: '2026-11-19' })])).ok, true);
check('P6', '別人（E02）的待審單 → 可以核定', approve(env([Object.assign({}, OT, { emp_id: 'E02', name: '測試二' })])).ok, true);
for (const st of ['approved', 'rejected', 'cancelled', 'voided']) {
  const r = approve(env([Object.assign({}, LV, { status: st, start: '', end: '', hours: '' })]));
  check('P7-' + st, '狀態 ' + st + ' → 不算待審（不因這條擋）', r.error === 'pending_request', false);
}

console.log('\n════ 三、核定的各種走法都擋 ════');
let r = approve(env([OT]), { dry_run: true });
check('P8', '只檢查（dry_run）也擋', [r.ok, r.error], [false, 'pending_request']);
r = approve(env([LV]), { periods: [], leaves: [{ type: '事假', hours: 8 }] });
check('P9', '整天請假（沒有上班時段）也擋', [r.ok, r.error], [false, 'pending_request']);
r = approve(env([OT]), { mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: [{ start: '09:00', end: '17:00' }] });
check('P10', '營運系統個人帳號代轉也擋', [r.ok, r.error], [false, 'pending_request']);
{
  const m = env([OT]);
  const c = m.sb.reqMgrApproveCheck_({ mgr_key: 'MK', date: D, items: [{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }] });
  check('P10b', '一次檢查多人（mgr_approve_check）：那位回 pending_request＋字句', [c.ok, c.results[0].ok, c.results[0].error, c.results[0].message], [true, false, 'pending_request', MSG]);
}

console.log('\n════ 四、開關、審完、加嚴以前 ════');
r = approve(env([OT], { REQ_PEND_BLOCK: 'off' }));
check('P11', 'REQ_PEND_BLOCK=off → 這條不擋（退回用；加班單待審由原本的綁單規則處理）', r.error === 'pending_request', false);
{
  const m = env([OT]);
  const d = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'R0', decision: 'approve' });
  r = approve(m, { periods: [{ start: '09:00', end: '17:00' }] });
  check('P12', '待審單核准後 → 這條不再擋', [!!d.ok, r.error === 'pending_request'], [true, false]);
}
r = approve(env([LV], { REQ_STRICT_FROM: '2026-12-01', REQ_BIND_FROM: 'off' }, '2026-11-05'), {}, '2026-11-05');
check('P14', '綁單、加嚴都關著的日子也擋（這條沒有起算日）', [r.ok, r.error], [false, 'pending_request']);
check('P15', '函式層：沒有待審＝null；有＝錯誤物件', [env([]).sb.reqPendBlock_([], 'E01', D), env([]).sb.reqPendBlock_([{ emp_id: 'E01', date: D, status: 'pending' }], 'E01', D).error], [null, 'pending_request']);
done();
