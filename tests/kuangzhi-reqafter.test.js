/* 曠職：認定曠職之後才核准忘打卡單 → 比照假單帶「那天已經核定過」提醒（2026-11-28，只是提醒、不改任何資料）
 * 規則白話：
 *   ‧原本（1113 紅燈 a2）：核准請假／出差／加班單時那天已核定 → warn:'already_approved_day'＋message；忘打卡單不提醒。
 *   ‧新增：開關開、日期在生效日起、那天有核定、那人那天請假登記有「曠職」（＝已認定曠職）→ 核准忘打卡單也帶 warn、warn_dates，**不帶 message**
 *     （既有兩種句尾講的是假別、加班單，不是忘打卡單；營運系統畫面顯示它既有的「那天已經核定過，請重新核定一次」）。
 *   ‧其他情況（開關關、日期早於生效日、那天核定沒有曠職、曠職是別人的、退回）＝跟改之前一樣（忘打卡單不提醒）。
 *   ‧單筆（mgr_req_decide）與批次（mgr_req_decide_batch）同一條。
 * 手算預期（今天 12/8；12/3 測試一已認定曠職 8 小時：approved 0 小時「全天請假」＋leave 12/3 測試一 曠職 8）：
 *   M1 測試一 12/3 忘打卡（開關 12/01）→ ok、approved、warn already_approved_day、warn_dates [12/3]、沒有 message
 *   M1 同一份資料、開關沒設 → ok、approved、沒有 warn（＝改之前）
 *   M2 測試二 12/3 忘打卡，那天核定 8 小時上班、沒有曠職 → 沒有 warn
 *   L1 測試一 12/3 事假單 → 照舊「12/3 已經核定過，請重新核定一次，假別才會寫進薪資」
 * 全部虛構姓名工號。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const D = '2026-12-03';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const YOU = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' };
const AP_KZ = [D, 'E01', '測試一', '', 0, '全天請假', '店長甲（DZY023）', '2026-12-03T20:00:00+08:00', '', ''];
const AP_WORK = [D, 'E02', '測試二', '10:00-18:00', 8, '正常', '店長甲（DZY023）', '2026-12-03T20:00:00+08:00', '', ''];
const LV_KZ = [D, '測試一', '曠職', 8];

function env(o) {
  o = o || {};
  const props = Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, o.from === undefined ? { KUANGZHI_FROM: '2026-12-01' } : o.from === null ? {} : { KUANGZHI_FROM: o.from });
  const m = make({ now: T('2026-12-08T10:00:00'), props, config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME, YOU], events: [], approved: o.approved || [AP_KZ, AP_WORK], leave: o.leave || [LV_KZ] } });
  const sh = m.sb.reqSheet_(m.self, true);
  const reqs = o.reqs || [
    { id: 'M1', emp_id: 'E01', name: '測試一', kind: 'miss', miss_type: 'both', start: '10:00', end: '19:00', hours: '' },
    { id: 'M2', emp_id: 'E02', name: '測試二', kind: 'miss', miss_type: 'in', start: '10:00', end: '', hours: '' },
    { id: 'L1', emp_id: 'E01', name: '測試一', kind: 'leave', leave_type: '事假', hours: 8 },
  ];
  reqs.forEach((r) => {
    const row = Object.assign({ created_at: '2026-12-04T08:00:00+08:00', date: D, status: 'pending' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
const J = (x) => JSON.parse(JSON.stringify(x));
const dec = (m, id, decision) => J(m.sb.handleMgrReqDecide_(Object.assign({ mgr_key: 'MK', id, decision: decision || 'approve' }, decision === 'reject' ? { reason: '測試' } : {})));
const pick = (r) => [r.ok, r.status, r.warn || null, r.warn_dates || null, 'message' in r ? r.message : null];
const W = [true, 'approved', 'already_approved_day', [D], null];
const NO = [true, 'approved', null, null, null];
const LEAVE_MSG = '12/3 已經核定過，請重新核定一次，假別才會寫進薪資';

console.log('══ 單筆核准 ══');
{
  check('RA1', '已認定曠職那天核准忘打卡單 → 帶提醒、不帶 message（營運系統顯示既有句）', pick(dec(env(), 'M1')), W);
  check('RA2', '開關沒設：同一份資料 → 不提醒（＝改之前）', pick(dec(env({ from: null }), 'M1')), NO);
  check('RA2b', '開關壞值：不提醒', pick(dec(env({ from: 'on' }), 'M1')), NO);
  check('RA3', '日期早於生效日（開關 12/05）：不提醒', pick(dec(env({ from: '2026-12-05' }), 'M1')), NO);
  check('RA4', '那天核定的是上班 8 小時、沒有曠職 → 不提醒（忘打卡照舊不提醒）', pick(dec(env(), 'M2')), NO);
  check('RA4b', '那天核定全天請假、登記是事假（不是曠職）→ 不提醒', pick(dec(env({ leave: [[D, '測試一', '事假', 8]] }), 'M1')), NO);
  check('RA5', '那天有核定、曠職登記是別人的 → 不提醒', pick(dec(env({ leave: [[D, '測試二', '曠職', 8]], approved: [AP_KZ] }), 'M1')), NO);
  check('RA6', '有曠職登記但那天沒有核定（不該發生的資料）→ 不提醒', pick(dec(env({ approved: [AP_WORK] }), 'M1')), NO);
  check('RA7', '請假單照舊（字不變）', pick(dec(env(), 'L1')), [true, 'approved', 'already_approved_day', [D], LEAVE_MSG]);
  const rj = dec(env(), 'M1', 'reject');
  check('RA8', '退回不帶提醒', [rj.ok, rj.status, 'warn' in rj], [true, 'rejected', false]);
  check('RA8b', '登記姓名前後有空白也對得到（同 leaveRowsOf 去空白）', pick(dec(env({ leave: [[D, ' 測試一 ', '曠職', 8]] }), 'M1')), W);
}

console.log('\n══ 批次核准 ══');
{
  const r = J(env().sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['M1', 'M2', 'L1'], decision: 'approve' }));
  check('RA9', '批次照常核准 3 筆', r.done, ['M1', 'M2', 'L1']);
  check('RA10', 'warn_items：忘打卡（已認定曠職那天）不帶 message；事假照舊', r.warn_items || null,
    [{ id: 'M1', warn: 'already_approved_day', warn_dates: [D] }, { id: 'L1', warn: 'already_approved_day', warn_dates: [D], message: LEAVE_MSG }]);
  const r2 = J(env({ from: null }).sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['M1', 'M2'], decision: 'approve' }));
  check('RA11', '開關沒設：批次忘打卡不帶 warn_items（＝改之前）', [r2.done, 'warn_items' in r2], [['M1', 'M2'], false]);
}

console.log('\n══ 只是提醒：資料跟沒提醒時一樣 ══');
{
  const a = env(), b = env({ from: null });
  dec(a, 'M1'); dec(b, 'M1');
  const snap = (m) => ['approved', 'leave', 'requests'].map((n) => JSON.stringify((m.self.sh[n] || { values: [] }).values));
  const strip = (s) => s.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, '"T"');
  check('RA12', '開關開（有提醒）與開關關（沒提醒）核准後三張表內容相同（只差時間戳）', snap(a).map(strip), snap(b).map(strip));
}
done();
