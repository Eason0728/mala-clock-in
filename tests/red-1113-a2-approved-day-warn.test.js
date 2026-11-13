/**
 * 1113 紅燈 a2（Eason 2026-11-13 選 A）：主管核准請假／出差單時，那天那人已經核定過（approved 分頁最新一筆）→
 * 照常核准，但回應多 warn:'already_approved_day'、warn_dates、message「X 月 X 日已經核定過，請重新核定一次，假別才會寫進薪資」。
 * 批次核准每筆結果都帶。加班、忘打卡不會寫進請假登記，不提醒。主管頁核准成功後把 message 顯示出來。
 * 全部虛構同仁。
 */
'use strict';
const fs = require('fs'), path = require('path');
const H = require('./helpers/gs-sandbox');

const AP = (date, emp, name) => [date, emp, name, '10:00-18:00', 8, '正常', '值班主管', date + 'T20:00:00+08:00', '', ''];
function world() {
  const m = H.make({ now: H.T('2026-11-12T10:00:00'), self: {
    roster: [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true' }, { emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true' }],
    approved: [AP('2026-11-05', 'E01', '代號甲'), AP('2026-11-06', 'E02', '代號乙')] } });
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  const add = (o) => { const r = Object.assign({ created_at: '2026-11-01T09:00:00+08:00', status: 'pending', hours: 8 }, o); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); };
  add({ id: 'A1', emp_id: 'E01', name: '代號甲', kind: 'leave', date: '2026-11-05', leave_type: '事假' });   // 那天已核定 → 提醒
  add({ id: 'A2', emp_id: 'E01', name: '代號甲', kind: 'leave', date: '2026-11-07', leave_type: '事假' });   // 還沒核定 → 不提醒
  add({ id: 'A3', emp_id: 'E02', name: '代號乙', kind: 'trip', date: '2026-11-06', leave_type: '出差', start: '10:00', end: '18:00' });  // 出差也寫請假登記 → 提醒
  add({ id: 'A4', emp_id: 'E02', name: '代號乙', kind: 'ot', date: '2026-11-06', start: '18:00', end: '19:00', hours: 1 });   // 加班 → 不提醒
  add({ id: 'A5', emp_id: 'E02', name: '代號乙', kind: 'leave', date: '2026-11-05', leave_type: '事假' });   // 那天核定的是別人 → 不提醒
  return m;
}
const J = (x) => JSON.parse(JSON.stringify(x));
const dec = (m, id) => J(m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: id, decision: 'approve' }));
const pick = (r) => [r.ok, r.status, r.warn || null, r.warn_dates || null, r.message || null];

console.log('══ a2 單筆核准 ══');
{
  const m = world();
  H.check('a2-1', '那天已核定的請假單：照常核准、帶提醒', pick(dec(m, 'A1')),
    [true, 'approved', 'already_approved_day', ['2026-11-05'], '11 月 5 日已經核定過，請重新核定一次，假別才會寫進薪資']);
  H.check('a2-2', '反例：那天還沒核定 → 不帶提醒', pick(dec(m, 'A2')), [true, 'approved', null, null, null]);
  H.check('a2-3', '出差單那天已核定 → 也提醒', pick(dec(m, 'A3')),
    [true, 'approved', 'already_approved_day', ['2026-11-06'], '11 月 6 日已經核定過，請重新核定一次，假別才會寫進薪資']);
  H.check('a2-4', '反例：加班單不寫請假登記 → 不提醒', pick(dec(m, 'A4')), [true, 'approved', null, null, null]);
  H.check('a2-5', '反例：那天核定的是別人 → 不提醒', pick(dec(m, 'A5')), [true, 'approved', null, null, null]);
  const r = J(m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'A2', decision: 'reject', reason: 'x' }));
  H.check('a2-6', '反例：處理過的單照舊回 not_pending', r.error, 'not_pending');
}

console.log('\n══ a2 批次核准 ══');
{
  const m = world();
  const r = J(m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['A1', 'A2', 'A3', 'A4'], decision: 'approve' }));
  H.check('a2-7', '批次照常核准 4 筆', r.done, ['A1', 'A2', 'A3', 'A4']);
  H.check('a2-8', '每筆結果都帶（有提醒的才有 warn）', (r.results || []).map((x) => [x.id, x.warn || null, x.warn_dates || null]),
    [['A1', 'already_approved_day', ['2026-11-05']], ['A2', null, null], ['A3', 'already_approved_day', ['2026-11-06']], ['A4', null, null]]);
  H.check('a2-9', '批次整體 message 列出要重新核定的日子', r.message || null, '11 月 5 日、11 月 6 日已經核定過，請重新核定一次，假別才會寫進薪資');
}

console.log('\n══ a2 主管頁：核准成功後顯示 message ══');
{
  const ROOT = H.ROOT;
  const pages = fs.readdirSync(ROOT).filter((f) => /^manager.*\.html$/.test(f));
  H.check('a2-10', '九份主管頁都在', pages.length, 9);
  H.check('a2-11', '每一份主管頁核准後有 warn 就顯示 message', pages.filter((f) => /already_approved_day/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).length, 9);
}
H.done();
