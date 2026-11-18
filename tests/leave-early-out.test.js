/* 請假前提早離開一律記早退（2026-11-18 Eason）：營運系統核定會算到已核准假單／出差單的開始（假 16–18、15:44 走 → 核定 13–16），
 * 打卡端「核定比打卡多」（reqOverCreditMin_）把實際下班卡到假單開始當早退、不當多核工時；Code.gs computeApprovalStatus 逐段比照記「早退N分」（沒改 Code.gs）。
 * 手算預期（班表 09–18、休 12–13、已核准事假 16:00–18:00；核定 09–12、13–16＝6 小時＋事假 2）：
 *   15:59 走＝早退1｜15:50＝10｜15:44＝16｜15:30＝30｜14:00＝120（卡差 120＞30 要選原因）——都放行、6 小時
 *   中間事假 14–15、核定 09–12、13–14、15–18＝7：13:50 走＝早退10｜13:30 走＝早退30
 *   出差 16–18、15:30 走＝8 小時（6＋出差 2）、早退30｜跨夜 18:00–02:00、事假 00:00–02:00、核定 18:00–00:00、23:30 走＝6、早退30
 *   同一天前面早走＋後面晚回（事假 14–15、13:30 走、15:40 回）＝7、遲到40、早退30
 *   主管填遲到分鐘 0（認定不計遲到）不影響早退：事假 16–18、15:30 走 → 放行、早退30
 *   不適用（照舊擋「核定比打卡多 30 分鐘」）：假單退回、作廢、審核中；沒有假單（班表結尾 17:30 走、核定 13–18 → 照舊擋 30）
 * 用真函式（gs-sandbox）。名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const D = '2026-11-20', D1 = '2026-11-21';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
function env(evs, reqs) {
  const m = make({ now: T('2026-11-21T21:00:00'), props: { REQ_STRICT_FROM: '2026-11-01' }, config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' },
    self: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' }], events: evs.map((e) => [e[0], 'E01', e[1]]) } });
  const sh = m.sb.reqSheet_(m.self, true);
  (reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
function approve(m, periods, extra) {
  const body = Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods) }, extra || {});
  let r = m.sb.handleMgrApprove(Object.assign({ dry_run: true }, body)), why = false;
  if (r.error === 'need_diff_reason') { why = true; body.diff_reason = '主管同意'; }
  r = m.sb.handleMgrApprove(body);
  const n = (k) => { const x = new RegExp(k + '(\\d+)分').exec(r.status_text || ''); return x ? +x[1] : 0; };
  return { ok: !!r.ok, hours: r.approved_hours === undefined ? null : r.approved_hours, early: n('早退'), late: n('遲到'), why, rules: (r.probs || []).map((p) => p.rule).join(','), message: r.message || '' };
}
const L = (o) => Object.assign({ kind: 'leave', leave_type: '事假', start: '16:00', end: '18:00', hours: 2 }, o || {});
const LV2 = { leaves: [{ type: '事假', hours: 2 }] };
const ev = (a, b) => [[D + 'T' + a + ':00', 'in'], [D + 'T' + b + ':00', 'out']];

console.log('════ 一、結尾請假前提早走 ════');
for (const [out, gone] of [['15:59', 1], ['15:50', 10], ['15:44', 16], ['15:30', 30], ['14:00', 120]]) {
  const r = approve(env(ev('08:58', out), [L()]), '09:00-12:00,13:00-16:00', LV2);
  check('EO-' + out, '事假 16–18、' + out + ' 走 → 放行、6 小時、早退' + gone + '（已記成早退，不用選原因）', [r.ok, r.hours, r.early, r.why], [true, 6, gone, false]);
}

console.log('\n════ 二、中間請假、出差、跨夜、前面早走＋後面晚回、主管填遲到 ════');
const mid = (o, b) => [[D + 'T09:00:00', 'in'], [D + 'T' + o + ':00', 'out'], [D + 'T' + b + ':00', 'in'], [D + 'T18:00:00', 'out']];
const LM = L({ start: '14:00', end: '15:00', hours: 1 }), LV1 = { leaves: [{ type: '事假', hours: 1 }] };
let r = approve(env(mid('13:50', '15:00'), [LM]), '09:00-12:00,13:00-14:00,15:00-18:00', LV1);
check('EO-mid50', '中間事假 14–15、13:50 走 → 7 小時、早退10', [r.ok, r.hours, r.early], [true, 7, 10]);
r = approve(env(mid('13:30', '15:00'), [LM]), '09:00-12:00,13:00-14:00,15:00-18:00', LV1);
check('EO-mid30', '中間事假 14–15、13:30 走 → 7 小時、早退30', [r.ok, r.hours, r.early], [true, 7, 30]);
r = approve(env(ev('08:58', '15:30'), [{ kind: 'trip', leave_type: '出差', start: '16:00', end: '18:00', hours: 2 }]), '09:00-12:00,13:00-16:00', { leaves: [{ type: '出差', hours: 2 }] });
check('EO-trip', '出差 16–18、15:30 走 → 8 小時（6＋出差 2）、早退30', [r.ok, r.hours, r.early], [true, 8, 30]);
r = approve(env([[D + 'T18:00:00', 'in'], [D + 'T23:30:00', 'out']], [L({ start: '00:00', end: '02:00' })]), '18:00-00:00', LV2);
check('EO-night', '跨夜 18–02、事假 00:00–02:00、23:30 走 → 6 小時、早退30', [r.ok, r.hours, r.early], [true, 6, 30]);
r = approve(env(mid('13:30', '15:40'), [LM]), '09:00-12:00,13:00-14:00,15:00-18:00', LV1);
check('EO-both', '事假 14–15、13:30 走、15:40 回 → 7 小時、遲到40、早退30', [r.ok, r.hours, r.late, r.early], [true, 7, 40, 30]);
r = approve(env(ev('08:58', '15:30'), [L()]), '09:00-12:00,13:00-16:00', Object.assign({ late_min: '0' }, LV2));
check('EO-lategiven', '主管填遲到 0（認定不計遲到）→ 早退照記 30、放行（沒有「主管填早退分鐘」的欄位）', [r.ok, r.early], [true, 30]);

console.log('\n════ 三、不適用：照舊擋 ════');
for (const st of ['rejected', 'void', 'pending']) {
  r = approve(env(ev('08:58', '15:30'), [L({ status: st })]), '09:00-12:00,13:00-16:00', st === 'pending' ? {} : {});
  check('EO-' + st, '假單' + st + ' → 照舊「核定比打卡多 30 分鐘」擋', [r.ok, r.rules.split(',').includes('over_credit')], [false, true]);
}
r = approve(env(ev('08:58', '17:30'), []), '09:00-12:00,13:00-18:00', {});
check('EO-noleave', '沒有假單：班表結尾 17:30 走、核定到 18:00 → 照舊擋 over_credit 30', [r.ok, /核定比打卡多 30 分鐘/.test(r.message)], [false, true]);

console.log('\n════ 四、函式層：沒帶 starts 跟改之前一樣 ════');
const m = env([], []);
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const ps = [{ startMs: ms('09:00'), endMs: ms('12:00') }, { startMs: ms('13:00'), endMs: ms('16:00') }], ss = [{ inMs: ms('08:58'), outMs: ms('15:30') }], BW = { startMs: ms('12:00'), endMs: ms('13:00') };
check('EO-f1', '沒帶 starts：30（同改之前）', m.sb.reqOverCreditMin_(ps, ss, BW, null, []), 30);
check('EO-f2', '帶 16:00：0', m.sb.reqOverCreditMin_(ps, ss, BW, null, [], [ms('16:00')]), 0);
check('EO-f3', '假單 13:00 起（結尾 12:00 只隔休息帶）、11:30 走 → 0', m.sb.reqOverCreditMin_([{ startMs: ms('09:00'), endMs: ms('12:00') }], [{ inMs: ms('09:00'), outMs: ms('11:30') }], BW, null, [], [ms('13:00')]), 0);
check('EO-f4', '假單 15:00 起但核定到 16:00（結尾不是假單開始）→ 不適用 30', m.sb.reqOverCreditMin_(ps, ss, BW, null, [], [ms('15:00')]), 30);
check('EO-f5', '結尾有打卡蓋到（做到請假時段裡）→ 不另扣、0', m.sb.reqOverCreditMin_(ps, [{ inMs: ms('08:58'), outMs: ms('16:30') }], BW, null, [], [ms('16:00')]), 0);
done();
