/* 考勤挑錯 2026-11-15（營運系統 scratch/att-bughunt 第一階段找到、Eason 回「全部照改」）。用真函式跑，名字一律假名。
 * B1  主管把遲到改成 0（或改小），被免掉的遲到分鐘要算進「核定比打卡多」：只打 5 分鐘卡不能核出 8 小時
 * B3  代開人改了姓名也不能審自己代開的單（用括號裡的編號認人）
 * B5  那天已經核定後才核准加班單：要提醒重新核定（原本只有請假、出差會提醒）
 * B6  REQ_UPPER_ON 寫成 true 也算開；主管列對不到名冊時，那把鑰匙不能核加班、請假、出差
 * B14 同名兩人：作廢甲的單不搬乙的假別紀錄（假別紀錄只有姓名，照薪資算給名冊最後一位同名的人）
 * B19 時段起訖不是字串擋下；一種假別一天不能超過 24 小時；月彙整標出主管代開的單；名單讀壞時待核定提醒也不列 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const D = '2026-11-18';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const P = (s, e) => [{ start: s, end: e }];
const brief = (r) => (r.ok ? { ok: true, approved_hours: r.approved_hours, status_text: r.status_text } : { ok: false, error: r.error });
const W = (events, o) => make(Object.assign({ now: T('2026-11-20T10:00:00'), self: { roster: [ME], events: events || [] } }, o || {}));
const ap = (m, o) => m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01' }, o));

// ── B1 ──
{
  const ev5 = [[D + 'T16:55:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']];
  const r0 = ap(W(ev5), { periods: P('09:00', '17:00'), late_min: 0 });
  check('B1-1', '只打 16:55–17:00、核 09–17、遲到填 0：擋下', { ok: r0.ok, error: r0.error, over: /核定比打卡多 475 分鐘/.test(String(r0.message)) }, { ok: false, error: 'need_request', over: true });
  check('B1-2', '同上經營運系統代轉：也擋', brief(ap(W(ev5), { mgr_key: 'AK', acting_name: '店長甲', sched_day: 'W', periods: P('09:00', '17:00'), late_min: 0 })), { ok: false, error: 'need_request' });
  check('B1-3', '不填遲到分鐘：照舊核定、狀態標遲到 475 分（薪資照扣）', brief(ap(W(ev5), { periods: P('09:00', '17:00') })), { ok: true, approved_hours: 8, status_text: '遲到475分' });
  check('B1-4', '遲到填 400（實際 475）：免掉的 75 分鐘要有單', brief(ap(W(ev5), { periods: P('09:00', '17:00'), late_min: 400 })), { ok: false, error: 'need_request' });
  check('B1-5', '遲到填 475（照實）：核定', brief(ap(W(ev5), { periods: P('09:00', '17:00'), late_min: 475 })).ok, true);
  const ev10 = [[D + 'T09:10:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']];
  check('B1-6', '遲到 10 分、主管認定不計遲到（未達 30 分）：照舊核定', brief(ap(W(ev10), { periods: P('09:00', '17:00'), late_min: 0 })), { ok: true, approved_hours: 8, status_text: '主管認定不計遲到' });
}

// ── B3 ──
{
  const m = make({ now: T('2026-11-10T10:00:00'), self: { roster: [{ emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE' }], events: [['2026-10-20T09:00:00', 'E02', 'in'], ['2026-10-20T20:00:00', 'E02', 'out']] } });
  const px = () => m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '人資主管（DZY020）', emp_id: 'E02', kind: 'ot', date: '2026-10-20', start: '18:00', end: '20:00', reason: '代開' });
  const p = px();
  check('B3-0', '代開成功', p.ok, true);
  const dec = (who, id) => { const r = m.sb.handleMgrReqDecide_({ mgr_key: 'AK', acting_name: who, director_ok: true, id: id || p.request.id, decision: 'approve' }); return r.ok ? 'ok' : r.error; };
  check('B3-1', '同名同編號核准：擋', dec('人資主管（DZY020）'), 'self_proxy');
  check('B3-2', '改名、同一個編號核准：擋', dec('人資主管A（DZY020）'), 'self_proxy');
  check('B3-3', '改名、同一個編號批次核准：略過', m.sb.handleMgrReqDecideBatch_({ mgr_key: 'AK', acting_name: '人資主管A（DZY020）', director_ok: true, ids: [p.request.id], decision: 'approve' }).done, []);
  check('B3-4', '別的總監層級（同姓名、不同編號）核准：放行', dec('人資主管（DZY099）'), 'ok');
  const v = m.sb.handleMgrReqVoid_({ mgr_key: 'AK', acting_name: '人資主管A（DZY020）', director_ok: true, id: p.request.id, reason: 'v' });
  check('B3-5', '改名後作廢自己代開的單：擋', v.ok ? 'ok' : v.error, 'self_proxy');
}

// ── B5 ──
{
  const ev = [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']];
  const flow = (batch) => {
    const m = W(ev);
    ap(m, { mgr_key: 'AK', acting_name: '店長甲', sched_day: 'W', periods: P('09:00', '17:00') });
    const a = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: D, start: '13:00', end: '17:00', reason: 'x' });
    return batch ? m.sb.handleMgrReqDecideBatch_({ mgr_key: 'AK', acting_name: '店長甲', ids: [a.request.id], decision: 'approve' })
                 : m.sb.handleMgrReqDecide_({ mgr_key: 'AK', acting_name: '店長甲', id: a.request.id, decision: 'approve' });
  };
  const r1 = flow(false);
  check('B5-1', '已核定後核准加班單：照常核准，帶「已經核定過」提醒', { ok: r1.ok, warn: r1.warn, dates: r1.warn_dates, msg: /已經核定過，請重新核定一次/.test(String(r1.message)) }, { ok: true, warn: 'already_approved_day', dates: [D], msg: true });
  const r2 = flow(true);
  check('B5-2', '批次核准也帶提醒', { done: r2.done.length, warn: (r2.warn_items || []).map((x) => x.warn) }, { done: 1, warn: ['already_approved_day'] });
  const m3 = W(ev);
  const a3 = m3.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: D, start: '13:00', end: '17:00', reason: 'x' });
  const r3 = m3.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a3.request.id, decision: 'approve' });
  check('B5-3', '那天還沒核定：沒有提醒', { ok: r3.ok, warn: r3.warn }, { ok: true, warn: undefined });
}

// ── B6 ──
{
  const world = (props, roster) => make({ now: T('2026-11-20T10:00:00'), props: props || {},
    self: { roster: roster || [{ emp_id: 'E01', name: '王店長', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' }],
      managers: [['王店長', 'MK', 'true', '', ''], ['營運系統代管', 'AK', 'true', 'true', '']], events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T19:00:00', 'E01', 'out']] } });
  const ot = { id_token: 'TOK_U1', kind: 'ot', date: D, start: '17:00', end: '19:00', reason: '結帳' };
  const lv = { id_token: 'TOK_U1', kind: 'leave', date: '2026-11-25', leave_type: '事假', hours: 8, reason: '私事' };
  const run = (props, roster) => {
    const m = world(props, roster);
    const a = m.sb.handleReqSubmit_(ot), b = m.sb.handleReqSubmit_(lv);
    const d = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
    const bt = m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [b.request.id], decision: 'approve' });
    const ak = m.sb.handleMgrReqDecide_({ mgr_key: 'AK', acting_name: '區經理（DZY060）', id: a.request.id, decision: 'approve' });
    const v = m.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: a.request.id, reason: 'x' });
    return { decide: d.ok ? 'ok' : d.error, batch_done: bt.done.length, acting: ak.ok ? 'ok' : ak.error, void: v.ok ? 'ok' : v.error };
  };
  check('B6-1', 'REQ_UPPER_ON=true：值班主管鑰匙核不了自己的加班、請假，也作廢不了；營運系統代轉照常', run({ REQ_UPPER_ON: 'true' }), { decide: 'upper_review', batch_done: 0, acting: 'ok', void: 'upper_review' });
  check('B6-2', 'REQ_UPPER_ON= TRUE （大小寫、空白）一樣算開', run({ REQ_UPPER_ON: ' TRUE ' }).decide, 'upper_review');
  const R3 = [{ emp_id: 'E01', name: '王小明', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' }];
  check('B6-3', 'REQ_UPPER_ON=1、主管列姓名對不到名冊：這把鑰匙核不了加班、請假，也作廢不了；營運系統代轉照常', run({ REQ_UPPER_ON: '1' }, R3), { decide: 'upper_review', batch_done: 0, acting: 'ok', void: 'upper_review' });
  {
    const m = world({ REQ_UPPER_ON: '1' }, R3.concat([{ emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' }]));
    const s = m.sb.handleReqSubmit_({ id_token: 'TOK_U2', kind: 'miss', date: D, miss_type: 'both', start: '09:00', end: '18:00', reason: '忘了' });
    const r = s.ok ? m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: s.request.id, decision: 'approve' }) : s;
    check('B6-4', '對不到名冊的鑰匙：別人的忘打卡單照常核（忘打卡單不在這條）', r.ok ? 'ok' : r.error, 'ok');
  }
  check('B6-5', 'REQ_UPPER_ON=0：關（行為不變）', run({ REQ_UPPER_ON: '0' }).decide, 'ok');
  check('B6-6', 'REQ_UPPER_ON=1、姓名對得上：照舊擋本人', run({ REQ_UPPER_ON: '1' }).decide, 'upper_review');
}

// ── B14 ──
{
  const R2 = [ME, { emp_id: 'E02', name: '測試一', key: 'K2', active: 'TRUE', line_user_id: 'U2' }];
  const mk = () => make({ now: T('2026-11-20T10:00:00'), self: { roster: R2, events: [], leave: [[D, '測試一', '事假', 8]], approved: [[D, 'E02', '測試一', '', 0, '全天請假', '值班主管', '2026-11-19T10:00:00+08:00']] } });
  const voidOf = (tok) => { const m = mk(); const a = m.sb.handleReqSubmit_({ id_token: tok, kind: 'ot', date: D, start: '18:00', end: '20:00', reason: 'x' }); m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
    const v = m.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: a.request.id, reason: 'v' }); return { ok: v.ok, revoked: v.revoked, leave_rows: m.self.sh.leave.values.length - 1 }; };
  check('B14-1', '作廢 E01（同名、不是薪資認的那一位）的單：不搬假別紀錄', voidOf('TOK_U1'), { ok: true, revoked: { approved: 0, leave: 0 }, leave_rows: 1 });
  check('B14-2', '作廢 E02（薪資把這個姓名算給他）的單：照舊連假別一起打回', voidOf('TOK_U2'), { ok: true, revoked: { approved: 1, leave: 1 }, leave_rows: 0 });
}

// ── B19 ──
{
  const m = W([]);
  const r = ap(m, { date: '2026-10-30', periods: [{ start: ['09:00'], end: ['09:00'] }] });
  check('B19-1', '時段起訖包成陣列：擋下、不寫入', { ok: r.ok, error: r.error, rows: m.approved().length }, { ok: false, error: 'bad_periods', rows: 0 });
  const m2 = W([]);
  const r2 = ap(m2, { date: '2026-11-05', periods: [], leaves: [{ type: '出差', hours: 999 }] });
  check('B19-2', '整天出差 999 小時：擋下、不寫入', { ok: r2.ok, error: r2.error, rows: m2.approved().length }, { ok: false, error: 'bad_leave_hours', rows: 0 });
  check('B19-3', '整天出差 24 小時以內照舊收', ap(W([]), { date: '2026-11-05', periods: [], leaves: [{ type: '出差', hours: 8 }] }).ok, true);
}
{
  const R = [ME, { emp_id: 'E05', name: '總監乙', key: 'K5', active: 'TRUE', line_user_id: 'U2' }];
  const m = make({ now: T('2026-12-10T10:00:00'), self: { roster: R, events: [] } });
  m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲（DZY023）', emp_id: 'E01', kind: 'ot', date: '2026-12-01', start: '18:00', end: '20:00', reason: '代開' });
  m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: '2026-12-09', start: '18:00', end: '20:00', reason: 'x' });
  const pick = (x) => ({ date: x.date, upper: x.upper, upper_kind: x.upper_kind });
  check('B19-4', '月彙整（值班主管鑰匙）：主管代開的單標 upper／director，一般單不標', m.sb.handleMgrReqMonth_({ mgr_key: 'MK', ym: '2026-12' }).items.map(pick),
    [{ date: '2026-12-01', upper: true, upper_kind: 'director' }, { date: '2026-12-09', upper: false, upper_kind: '' }]);
}
{
  const ev = [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']];
  const bad = W(ev, { props: { REQ_HOME_EMPS: '{壞掉' } });
  check('B19-5', '部門同仁名單讀壞：待核定提醒也不列（跟 mgr_day 一致）', bad.sb.reqPendingApprovalsPlus_({ mgr_key: 'MK' }).items, []);
  check('B19-6', '名單正常：照舊提醒', W(ev).sb.reqPendingApprovalsPlus_({ mgr_key: 'MK' }).items.map((x) => x.emp_id), ['E01']);
  check('B19-7', '名單讀壞、營運系統代轉：照舊提醒', bad.sb.reqPendingApprovalsPlus_({ mgr_key: 'AK', acting_name: '店長甲' }).items.map((x) => x.emp_id), ['E01']);
}
done();
