/* 曠職：打卡端「認定曠職」（2026-11-26 主管定案；開工確認 kickoff.html 第 1–5、11、12 題；合約 docs/kuangzhi/contract.md 第 2 節）
 * 規則白話：
 *   ‧沿用 mgr_approve：0 個上班時段＋假別曠職＋營運系統伺服器帶的已發布班表事實 kz_sched。只收營運系統個人帳號代轉（第 2 題、第 1 題「誰按的有紀錄」）。
 *   ‧擋：跟別的假別或上班時段一起（句 13）、班表不是上班日（句 11）、有任何打卡（句 9）、有待審或已核准的請假出差忘打卡單（句 10）、
 *     那天已經有核定或登記（kz_day_done，逐句表沒有字）、還在同仁自補期限內（句 12）。
 *   ‧通過：approved 一列 0 小時（狀態字照舊「全天請假」）＋leave 一列 曠職（時數＝班表時數，送來的 hours 不採用）；回句 8。
 *   ‧開關 KUANGZHI_FROM：沒設／壞值＝跟主線一樣（kuangzhi-equiv.test.js 逐字比）；早於 12/1 當 12/1；日期早於生效日＝bad_leave_type。
 *   ‧一般核定、主管代開、同仁請假單都選不到曠職；重新核定成別的假＝曠職消失（第 12 題）。
 * 手算預期（今天 12/8，12/3 班表 10:00–19:00 扣休息 1 小時＝8 小時）：
 *   K1 認定成功 → 核定 0、全天請假、leave [12/3 測試一 曠職 8]、「已認定 12/3 曠職（8 小時）」
 *   K2 今天 12/7 → 擋「同仁還能自己補單到 12/7，請之後再認定」；12/5 的班今天 12/8 → 補單到 12/9
 *   …其餘見各段。全部虛構姓名工號。 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { make, T, check, show, done, R } = require('./helpers/gs-sandbox');
const CASES = require('./fixtures/kuangzhi-cases-v1.json');

const D = '2026-12-03';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const YOU = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' };
const KZS = { work: true, hours: 8, xpunch: false, xreq: false };
const MSG = {
  ok: '已認定 12/3 曠職（8 小時）',
  punch: '這天有打卡紀錄，不能認定曠職',
  req: '這天有待審或已核准的請假、出差或忘打卡單，請先處理那張單',
  notwork: '這天班表不是上班日，不能認定曠職',
  mixed: '曠職不能跟其他假別或上班時段一起核定',
  pend: '這天還有待審的申請，請先審單（審完才能核定）',
};
function env(o) {
  o = o || {};
  const m = make({ now: T(o.now || '2026-12-08T10:00:00'), payroll: !!o.payroll, hub: !!o.payroll,
    props: Object.assign({ REQ_STRICT_FROM: '2026-11-01', KUANGZHI_FROM: '2026-12-01' }, o.props || {}),
    config: Object.assign({ NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' }, o.config || {}),
    self: { roster: [ME, YOU], events: o.events || [], approved: o.approved || [], leave: o.leave || [] } });
  if (o.noProp) delete m.props.KUANGZHI_FROM;
  const sh = m.sb.reqSheet_(m.self, true);
  (o.reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: '2026-12-02T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'pending' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
const KZ = (x) => Object.assign({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: KZS }, x || {});
const ap = (m, x) => m.sb.handleMgrApprove(KZ(x));
const brief = (r) => [r.ok === true, r.error || '', r.message || ''];
const sheets = (m) => ({ ap: m.self.sh.approved.values.slice(1).map((r) => r.slice(0, 7)), lv: m.self.sh.leave.values.slice(1) });
const LV_OK = (t) => ({ kind: 'leave', leave_type: t, start: '', end: '', hours: 8, status: 'approved' });

console.log('══ 零、共用案例檔（mala-store-ops 跑同一份）══');
{
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures', 'kuangzhi-cases-v1.json'))).digest('hex');
  show('C0', '案例檔 sha256（營運系統那份要逐字相同；改了兩邊一起改並更新這裡）', h);
  check('C0b', '案例檔 sha256 釘住（兩個 repo 一起改）', h, '1cc5b5e2ec6a540fd11ba94429fc1d120e5fb39dde3f58265a17fba3d811168d');
  const m = env();
  CASES.from.forEach((c, i) => {
    if (c.raw === null) delete m.props.KUANGZHI_FROM; else m.props.KUANGZHI_FROM = c.raw;
    check('C1-' + i, '開關讀法：' + c.name, m.sb.kzFrom_(), c.expect);
  });
  CASES.self_until.forEach((c, i) => check('C2-' + i, '自補期限：' + c.name, [m.sb.kzSelfUntil_(c.date, c.today), m.sb.kzCanMark_(c.date, c.today)], [c.until, c.can_mark]));
  CASES.suspect.forEach((c, i) => check('C3-' + i, '疑似判定：' + c.name, m.sb.kzSuspect_(c.f), c.expect));
}

console.log('\n══ 一、認定成功（第 5 題 A：核定 0 小時＋假別曠職、時數＝班表時數）══');
{
  const m = env();
  const r = ap(m, { leaves: [{ type: '曠職', hours: 3 }] });   // 送來的 3 小時不採用
  check('K1', '成功、句 8、時數用班表 8 小時', [r.ok, r.message, r.approved_hours, r.status_text, r.leaves, r.kz, r.manager_name], [true, MSG.ok, 0, '全天請假', [{ type: '曠職', hours: 8 }], { hours: 8 }, '店長甲']);
  check('K1b', '寫入：approved 一列 0 小時、狀態字照舊「全天請假」、核定人＝按的人；leave 一列曠職 8', sheets(m),
    { ap: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲']], lv: [[D, '測試一', '曠職', 8]] });
  const m2 = env();
  const r2 = ap(m2, { kz_sched: Object.assign({}, KZS, { hours: 4 }) });
  check('K1c', '短班 4 小時（6-2 照班表時數；扣多少待主管確認）', [r2.ok, r2.message, sheets(m2).lv], [true, '已認定 12/3 曠職（4 小時）', [[D, '測試一', '曠職', 4]]]);
  const m3 = env();
  const r3 = ap(m3, { kz_sched: Object.assign({}, KZS, { hours: 7.5 }) });
  check('K1d', '7.5 小時照寫', [r3.message, sheets(m3).lv[0][3]], ['已認定 12/3 曠職（7.5 小時）', 7.5]);
  const m4 = env();
  const r4 = m4.sb.reqMgrApproveHome_(KZ());
  check('K1e', '走 mgr_approve 入口（reqMgrApproveHome_）一樣成功', [r4.ok, r4.message], [true, MSG.ok]);
  const m5 = env();
  const r5 = ap(m5, { leaves: undefined, leave_type: '曠職', leave_hours: 8 });
  check('K1f', '舊呼叫端 leave_type＝曠職 也走同一條路', [r5.ok, r5.message], [true, MSG.ok]);
}

console.log('\n══ 二、自補期限（第 4 題 A）══');
{
  const r = ap(env({ now: '2026-12-07T23:59:00' }));
  check('K2', '12/3 的班、今天 12/7 → 句 12，補單到 12/7', [brief(r), r.until], [[false, 'kz_too_early', '同仁還能自己補單到 12/7，請之後再認定'], '2026-12-07']);
  const r2 = ap(env({ now: '2026-12-08T00:01:00' }));
  check('K2b', '12/8 00:01 起可以認定', r2.ok, true);
  const r3 = ap(env(), { date: '2026-12-05' });
  check('K2c', '12/5 的班、今天 12/8 → 補單到 12/9（畫面 1 的字）', brief(r3), [false, 'kz_too_early', '同仁還能自己補單到 12/9，請之後再認定']);
  const r4 = ap(env({ now: '2026-12-08T10:00:00' }), { date: '2026-12-20' });
  check('K2d', '未來的日子 → 也是句 12', brief(r4), [false, 'kz_too_early', '同仁還能自己補單到 12/24，請之後再認定']);
}

console.log('\n══ 三、有打卡（第 3-4 題 A：有打卡就是有來）══');
{
  check('K3', '只有上班卡 → 句 9', brief(ap(env({ events: [[D + 'T10:02:00', 'E01', 'in']] }))), [false, 'kz_has_punch', MSG.punch]);
  check('K3b', '被擋的卡（status rejected）也算有打卡 → 句 9', brief(ap(env({ events: [[D + 'T10:02:00', 'E01', 'in', 'rejected']] }))), [false, 'kz_has_punch', MSG.punch]);
  check('K3c', '新手機待核准的卡也算 → 句 9', brief(ap(env({ events: [[D + 'T10:02:00', 'E01', 'in', 'pending_device_approval']] }))), [false, 'kz_has_punch', MSG.punch]);
  check('K3d', '隔天 05:30 的下班卡算前一天 → 句 9', brief(ap(env({ events: [['2026-12-04T05:30:00', 'E01', 'out']] }))), [false, 'kz_has_punch', MSG.punch]);
  check('K3e', '隔天 05:30 的上班卡不算這天 → 可以認定', ap(env({ events: [['2026-12-04T05:30:00', 'E01', 'in']] })).ok, true);
  check('K3f', '別人的打卡不影響 → 可以認定', ap(env({ events: [[D + 'T10:00:00', 'E02', 'in']] })).ok, true);
  check('K3g', '營運系統說其他帳號有打卡（xpunch）→ 句 9', brief(ap(env(), { kz_sched: Object.assign({}, KZS, { xpunch: true }) })), [false, 'kz_has_punch', MSG.punch]);
  check('K3h', '前一天 23:00 上班卡（跨夜）不算這天 → 可以認定', ap(env({ events: [['2026-12-02T23:00:00', 'E01', 'in']] })).ok, true);
}

console.log('\n══ 四、有單（第 3-3 題 A：待審或已核准的請假、出差、忘打卡單）══');
{
  check('K4', '待審假單 → 句 10（先於一般待審擋）', brief(ap(env({ reqs: [{ kind: 'leave', leave_type: '病假', hours: 8 }] }))), [false, 'kz_has_req', MSG.req]);
  check('K4b', '已核准忘打卡單 → 句 10', brief(ap(env({ reqs: [{ kind: 'miss', miss_type: 'in', start: '10:00', status: 'approved' }] }))), [false, 'kz_has_req', MSG.req]);
  check('K4c', '待審出差單 → 句 10', brief(ap(env({ reqs: [{ kind: 'trip', leave_type: '出差', hours: 8 }] }))), [false, 'kz_has_req', MSG.req]);
  check('K4d', '被退回的假單 → 回到疑似，可以認定', ap(env({ reqs: [{ kind: 'leave', leave_type: '病假', hours: 8, status: 'rejected' }] })).ok, true);
  check('K4e', '已核准但作廢的假單 → 可以認定', ap(env({ reqs: [{ kind: 'leave', leave_type: '病假', hours: 8, status: 'voided', voided_at: '2026-12-05T09:00:00+08:00' }] })).ok, true);
  check('K4f', '待審加班單（不在第 3 題清單）→ 照既有規則擋「請先審單」', brief(ap(env({ reqs: [{ kind: 'ot', start: '19:00', end: '20:00', hours: 1 }] }))), [false, 'pending_request', MSG.pend]);
  check('K4g', '別天的單不影響 → 可以認定', ap(env({ reqs: [{ kind: 'leave', leave_type: '病假', hours: 8, date: '2026-12-04' }] })).ok, true);
  check('K4h', '營運系統說其他帳號有單（xreq）→ 句 10', brief(ap(env(), { kz_sched: Object.assign({}, KZS, { xreq: true }) })), [false, 'kz_has_req', MSG.req]);
}

console.log('\n══ 五、班表不是上班日（第 3-1、3-5、3-6 題）══');
{
  check('K5', 'work=false（休息日排班、例假、國定假日、排除名單由營運系統判）→ 句 11', brief(ap(env(), { kz_sched: Object.assign({}, KZS, { work: false }) })), [false, 'kz_not_workday', MSG.notwork]);
  check('K5b', '沒帶 kz_sched → 句 11', brief(ap(env(), { kz_sched: undefined })), [false, 'kz_not_workday', MSG.notwork]);
  [['hours 0', { hours: 0 }], ['hours 字串', { hours: '8' }], ['hours 25', { hours: 25 }], ['work 字串', { work: 'true' }], ['xpunch 缺', { xpunch: undefined }], ['xreq null', { xreq: null }]].forEach(([nm, x], i) => {
    check('K5c-' + i, 'kz_sched 形狀不對（' + nm + '）→ 句 11', brief(ap(env(), { kz_sched: Object.assign({}, KZS, x) })), [false, 'kz_not_workday', MSG.notwork]);
  });
  check('K5d', 'kz_sched 是陣列 → 句 11', brief(ap(env(), { kz_sched: [KZS] })), [false, 'kz_not_workday', MSG.notwork]);
  check('K5e', '瑞光（PAYROLL_STORE MZTRG）2027-01-01 前 → 句 11', brief(ap(env({ config: { PAYROLL_STORE: 'MZTRG' } }))), [false, 'kz_not_workday', MSG.notwork]);
  check('K5f', '文心（MZTWX）2027-01-01 前 → 句 11', brief(ap(env({ config: { PAYROLL_STORE: 'MZTWX' } }))), [false, 'kz_not_workday', MSG.notwork]);
  const r = ap(env({ now: '2027-01-11T10:00:00', config: { PAYROLL_STORE: 'MZTRG' } }), { date: '2027-01-04' });
  check('K5g', '瑞光 2027-01-04 → 可以認定', [r.ok, r.message], [true, '已認定 1/4 曠職（8 小時）']);
}

console.log('\n══ 六、跟別的假別或上班時段一起（句 13）══');
{
  check('K6', '曠職＋事假 → 句 13', brief(ap(env(), { leaves: [{ type: '曠職', hours: 8 }, { type: '事假', hours: 8 }] })), [false, 'kz_mixed', MSG.mixed]);
  check('K6b', '曠職＋上班時段 → 句 13', brief(ap(env({ events: [[D + 'T10:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']] }), { periods: [{ start: '10:00', end: '18:00' }] })), [false, 'kz_mixed', MSG.mixed]);
  check('K6c', '曠職＋出差 → 句 13', brief(ap(env(), { leaves: [{ type: '出差', hours: 8 }, { type: '曠職', hours: 8 }] })), [false, 'kz_mixed', MSG.mixed]);
  check('K6d', '曠職選兩次 → 既有「同一個假別選了兩次」', brief(ap(env(), { leaves: [{ type: '曠職', hours: 8 }, { type: '曠職', hours: 8 }] })), [false, 'dup_leave_type', '同一個假別選了兩次：曠職']);
  check('K6e', 'periods 不是陣列（字串）→ 句 13', brief(ap(env(), { periods: '10:00-18:00' })), [false, 'kz_mixed', MSG.mixed]);
}

console.log('\n══ 七、誰可以按（第 2 題 A＋第 1 題「每一筆有人按、有紀錄」）══');
{
  check('K7', '門市鑰匙（舊值班頁、門市登入）→ bad_leave_type（同主線）', brief(ap(env(), { mgr_key: 'MK', acting_name: undefined })), [false, 'bad_leave_type', '']);
  check('K7b', '營運系統代管鑰匙但沒帶 acting_name → bad_leave_type', brief(ap(env(), { acting_name: undefined })), [false, 'bad_leave_type', '']);
  check('K7c', '錯的鑰匙 → unauthorized（照舊）', brief(ap(env(), { mgr_key: 'NOPE' })), [false, 'unauthorized', '']);
}

console.log('\n══ 八、生效日（第 11 題 A：12/1 起、不回溯）══');
{
  check('K8', '開關 2026-12-10、日期 12/3 → bad_leave_type', brief(ap(env({ props: { KUANGZHI_FROM: '2026-12-10' } }))), [false, 'bad_leave_type', '']);
  check('K8b', '開關 2026-11-01（早於 12/1）、日期 11/25 → bad_leave_type（當成 12/1）', brief(ap(env({ props: { KUANGZHI_FROM: '2026-11-01' } }), { date: '2026-11-25' })), [false, 'bad_leave_type', '']);
  check('K8c', '開關 2026-11-01、日期 12/3 → 可以認定', ap(env({ props: { KUANGZHI_FROM: '2026-11-01' } })).ok, true);
  ['', 'on', '2026-12-32', '2026/12/01'].forEach((v, i) => check('K8d-' + i, '開關壞值「' + v + '」→ bad_leave_type', brief(ap(env({ props: { KUANGZHI_FROM: v } }))), [false, 'bad_leave_type', '']));
  check('K8e', '沒設開關 → bad_leave_type', brief(ap(env({ noProp: true }))), [false, 'bad_leave_type', '']);
}

console.log('\n══ 九、那天已經有核定或登記（kz_day_done，逐句表沒有字 → 不帶 message）══');
{
  const m = env();
  ap(m);
  const r = ap(m);
  check('K9', '同一天再按一次 → kz_day_done、不重複寫', [brief(r), sheets(m).lv.length, sheets(m).ap.length], [[false, 'kz_day_done', ''], 1, 1]);
  check('K9b', '那天已核定（全天特休）→ kz_day_done', brief(ap(env({ approved: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-12-04T09:00:00+08:00']], leave: [[D, '測試一', '特休假', 8]] }))), [false, 'kz_day_done', '']);
  check('K9c', '只有 leave 登記沒有核定 → kz_day_done', brief(ap(env({ leave: [[D, '測試一', '出差', '']] }))), [false, 'kz_day_done', '']);
}

console.log('\n══ 十、只檢查（dry_run、一批試算）不寫 ══');
{
  const m = env();
  const r = ap(m, { dry_run: true });
  check('K10', 'dry_run 成功、帶 kz、不帶 message、什麼都沒寫', [r.ok, r.dry_run, r.kz, r.message, sheets(m)], [true, true, { hours: 8 }, undefined, { ap: [], lv: [] }]);
  const m2 = env();
  const r2 = m2.sb.reqMgrApproveCheck_({ mgr_key: 'AK', acting_name: '店長甲', date: D, items: [{ emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: KZS }] });
  check('K10b', 'mgr_approve_check 一批：曠職那位 ok、什麼都沒寫', [r2.ok, r2.results[0].ok, sheets(m2)], [true, true, { ap: [], lv: [] }]);
  const r3 = env().sb.reqMgrApproveCheck_({ mgr_key: 'AK', acting_name: '店長甲', date: D, items: [{ emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: Object.assign({}, KZS, { work: false }) }] });
  check('K10c', 'mgr_approve_check 一批：班表不是上班日 → 句 11', [r3.results[0].ok, r3.results[0].error, r3.results[0].message], [false, 'kz_not_workday', MSG.notwork]);
}

console.log('\n══ 十一、重新核定就解除（第 12 題 A）══');
{
  const m = env({ reqs: [] });
  ap(m);
  const sh = m.sb.reqSheet_(m.self, true);
  const row = Object.assign({ id: 'RS', created_at: '2026-12-12T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D }, LV_OK('病假'));
  sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  m.setNow('2026-12-12T10:00:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '病假', hours: 8 }] });
  check('K11', '店長代開病假並核准後，重新核定那天為病假 8 小時 → 曠職消失、只剩病假', [r.ok, sheets(m).lv], [true, [[D, '測試一', '病假', 8]]]);
  const m2 = env();
  ap(m2);
  const r2 = m2.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }, { type: '病假', hours: 8 }] });
  check('K11b', '重新核定時又帶曠職＋病假 → 句 13（不會兩種一起留）', brief(r2), [false, 'kz_mixed', MSG.mixed]);
  show('K11c', '「補單打回」（PR #241）若上線：核准補單時把那天打回待核定（approved／leave 那天清掉）→ 曠職跟著消失、扣款歸 0；本分支沒有實作打回，'
    + '接主線時要補一條「認定後核准補單 → 那天打回 → leave 沒有曠職」的測試', '只說明，未實作');
}

console.log('\n══ 十二、一般假別下拉、代開、同仁請假單都選不到（第 5 題 A）══');
{
  const m = env({ payroll: true });
  check('K12', '白名單外查表 leaveTypeAllowedByPayroll(曠職)：開關開 → false（光復，假別表內建列有曠職也一樣）', m.sb.leaveTypeAllowedByPayroll('曠職', 'AK'), false);
  check('K12a', '對照：光復 payLeaveTypes 開關開時有內建曠職列', m.sb.payLeaveTypes('').some((t) => t.name === '曠職'), true);
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }] });
  check('K12b', '值班主管頁（門市鑰匙）送曠職 → bad_leave_type', brief(r), [false, 'bad_leave_type', '']);
  const v = m.sb.reqValidate_({ kind: 'leave', leave_type: '曠職', date: '2026-12-07', hours: 8 }, ME, [], '2026-12-08', [], false);
  check('K12c', '同仁 LINE 請假單 → bad_leave_type', [v.error, v.message], ['bad_leave_type', '請選假別']);
  const v2 = m.sb.reqValidate_({ kind: 'leave', leave_type: '曠職', date: D, hours: 8, mgr_key: 'AK' }, ME, [], '2026-12-08', [], true);
  check('K12d', '主管代開 → bad_leave_type', [v2.error, v2.message], ['bad_leave_type', '請選假別']);
  const m2 = env({ payroll: true, noProp: true });
  check('K12e', '開關關：查表照舊（內建列沒有曠職 → false，同主線）', m2.sb.leaveTypeAllowedByPayroll('曠職', 'AK'), false);
}

console.log('\n══ 十三、打卡頁「最近 40 天」顯示曠職（句 15）══');
{
  const m = env();
  ap(m);
  const r = m.sb.handleMyRecent({ key: 'K1', device_id: 'D1' });
  const d = r.days.filter((x) => x.date === D)[0];
  check('K13', '已認定那天列出來、狀態「曠職」（不是全天請假）、核定 0', d && [d.approved, d.approved_status, d.segments], [0, '曠職', []]);
  const m2 = env({ noProp: true, approved: [[D, 'E01', '測試一', '', 0, '全天請假', '店長甲', '2026-12-08T09:00:00+08:00']], leave: [[D, '測試一', '曠職', 8]] });
  check('K13b', '開關關：照舊不列（沒有打卡的日子不列）', m2.sb.handleMyRecent({ key: 'K1', device_id: 'D1' }).days.length, 0);
}

console.log('\n══ 十四、系統不會自己寫曠職（不可降的標準）══');
{
  const SRC = ['Code.gs', 'Requests.gs', 'Payroll.gs', 'RelayG.gs', 'DutyFeed.gs', 'AttAlert.gs', 'AttDigest.gs', 'Cap10.gs', 'LineHub.gs', 'Liff.gs', 'Mirror.gs', 'Rest.gs', 'Sched.gs', 'SchedPub.gs', 'SvcStaff.gs']
    .map((f) => [f, fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8')]);
  // leave 分頁唯一的寫入點是 replaceLeaveRows（值班核定），曠職只會在 kzPlan（通過 kzApprovePre_／Post_）時加進 leaves
  const writers = SRC.filter(([, s]) => /replaceLeaveRows\(ss, date/.test(s)).map(([f]) => f);
  check('K14', 'leave 分頁的寫入只有 Code.gs handleMgrApprove 一處', writers, ['Code.gs']);
  const code = SRC[0][1];
  check('K14b', 'Code.gs 裡把曠職放進 leaves 的只有 kzPlan 那一行', (code.match(/leaves\.push\(\{ type: KZ_TYPE/g) || []).length, 1);
  check('K14c', '曠職字面只出現在常數、說明與判斷（沒有其他寫入）', SRC.filter(([f, s]) => f !== 'Code.gs' && f !== 'Payroll.gs' && f !== 'Requests.gs' && /'曠職'/.test(s)).map(([f]) => f), []);
}
console.log('\n══ 十五、Mac mini 核定引擎看得到同一個開關（合約第 6 節）══');
{
  const pull = (props) => { const m = make({ now: T('2026-12-08T10:00:00'), props: Object.assign({ REQ_BIND_FROM: 'off', RELAY_KEY: 'RELAY-KEY-0123456789abcdef' }, props), self: { roster: [ME], events: [] } });
    m.run(R('apps-script/RelayG.gs'));
    return m.sb.handleRelayPull_({ relay_key: 'RELAY-KEY-0123456789abcdef', with: { props: true } }).props; };
  check('K15', 'relay_pull 帶 KUANGZHI_FROM 原值（有設才帶）', pull({ KUANGZHI_FROM: '2026-12-01' }).KUANGZHI_FROM, '2026-12-01');
  check('K15b', '沒設 → props 沒有這個鍵（回應跟以前一樣）', Object.prototype.hasOwnProperty.call(pull({}), 'KUANGZHI_FROM'), false);
}
done();
