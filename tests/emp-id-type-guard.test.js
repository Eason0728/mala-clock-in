/* 2026-11-16：員編只收文字或數字（接 2026-11-15 驗收 C11-7 的 mgr_approve），補到其他「收員編又會寫入」的動作；
 *  以及 doPost 內文是 JSON 的 null 時不可以丟例外。用真的 .gs 在 vm 跑，名字一律假名。
 *  K1：陣列 ["E01"] 轉成文字剛好等於 E01，原本會對到人、照樣寫入。各動作沿用自己原本的錯誤碼。
 *  K2：內文是 null → 原本在 body.action 丟 TypeError（那一行在 try 之外）→ 回 unknown_action（同數字、字串、陣列）。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const D = '2026-11-10';
const E1 = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const E2 = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE' };   // 沒綁 LINE
const world = (o) => make(Object.assign({ now: T(D + 'T23:00:00'), props: { REQ_BIND_FROM: 'off' },
  self: { roster: [E1, E2], events: [[D + 'T09:00:00', 'E01', 'in', 'pending_device_approval', 'D9']] } }, o || {}));
const raw = (m, text) => m.sb.doPost({ postData: { contents: text } });
const post = (m, b) => JSON.parse(raw(m, JSON.stringify(b)).text);
const BAD = [['陣列 ["E01"]', ['E01']], ['巢狀陣列', [['E01']]], ['物件', { a: 1 }], ['true', true]];
const row = (m, id) => m.roster().filter((r) => String(r.emp_id) === id)[0];

console.log('════ K1-1：裝置核准（approve_device、mgr_device_decision）════');
BAD.forEach((b, i) => {
  const m = world();
  const r = post(m, { action: 'mgr_device_decision', mgr_key: 'MK', emp_id: b[1], device_id: 'D9', approve: true });
  check('K1-1-0' + (i + 1), 'mgr_device_decision ' + b[0] + ' → invalid_emp_id、裝置沒換、卡沒放行', [r.ok, r.error, row(m, 'E01').device_id, m.events()[0].status], [false, 'invalid_emp_id', 'D1', 'pending_device_approval']);
});
{
  const m = world();
  const r = post(m, { action: 'approve_device', admin_key: 'ADM', emp_id: ['E01'], device_id: 'D9', approve: true });
  check('K1-1-05', 'approve_device 陣列 → invalid_emp_id、裝置沒換', [r.ok, r.error, row(m, 'E01').device_id], [false, 'invalid_emp_id', 'D1']);
}
{
  const m = world();
  const r = post(m, { action: 'mgr_device_decision', mgr_key: 'MK', emp_id: 'E01', device_id: 'D9', approve: true });
  check('K1-1-10', '對照：文字 E01 照常核准、換成新裝置', [r.ok, row(m, 'E01').device_id, m.events()[0].status], [true, 'D9', 'ok']);
  const r2 = post(world(), { action: 'mgr_device_decision', mgr_key: 'MK', emp_id: 'E99', device_id: 'D9', approve: true });
  check('K1-1-11', '對照：名冊沒有的員編照舊 invalid_emp_id', [r2.ok, r2.error], [false, 'invalid_emp_id']);
}
{
  const m = make({ now: T(D + 'T23:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [Object.assign({}, E1, { emp_id: 7 })], events: [[D + 'T09:00:00', 7, 'in', 'pending_device_approval', 'D9']] } });
  const r = post(m, { action: 'mgr_device_decision', mgr_key: 'MK', emp_id: 7, device_id: 'D9', approve: true });
  check('K1-1-12', '對照：數字員編照收', [r.ok, row(m, '7').device_id], [true, 'D9']);
}

console.log('\n════ K1-2：設離職／恢復在職（mgr_set_active）════');
BAD.forEach((b, i) => {
  const m = world();
  const r = post(m, { action: 'mgr_set_active', mgr_key: 'MK', emp_id: b[1], active: false });
  check('K1-2-0' + (i + 1), b[0] + ' → emp_id_required、沒被設離職', [r.ok, r.error, String(row(m, 'E01').active).toLowerCase()], [false, 'emp_id_required', 'true']);
});
{
  const m = world();
  const r = post(m, { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'E01', active: false });
  check('K1-2-10', '對照：文字 E01 照常設離職', [r.ok, String(row(m, 'E01').active).toLowerCase()], [true, 'false']);
}

console.log('\n════ K1-3：LINE 綁定碼、解除綁定（mgr_bind_code、mgr_line_unbind）════');
BAD.forEach((b, i) => {
  const m = world();
  const r = post(m, { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: b[1] });
  check('K1-3-0' + (i + 1), 'mgr_line_unbind ' + b[0] + ' → not_found、綁定還在', [r.ok, r.error, row(m, 'E01').line_user_id], [false, 'not_found', 'U1']);
});
{
  const m = world();
  const r = post(m, { action: 'mgr_bind_code', mgr_key: 'MK', emp_id: ['E02'] });
  check('K1-3-05', 'mgr_bind_code 陣列 ["E02"] → not_found、沒給綁定碼', [r.ok, r.error, r.code === undefined], [false, 'not_found', true]);
  const g = post(world(), { action: 'mgr_bind_code', mgr_key: 'MK', emp_id: 'E02' });
  check('K1-3-10', '對照：文字 E02 照常給 6 碼綁定碼', [g.ok, /^\d{6}$/.test(String(g.code))], [true, true]);
  const m2 = world();
  const u = post(m2, { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: 'E01' });
  check('K1-3-11', '對照：文字 E01 照常解除綁定', [u.ok, row(m2, 'E01').line_user_id], [true, '']);
}

console.log('\n════ K1-4：主管代開（mgr_req_proxy）════');
{
  const proxy = (emp) => { const m = world(); const r = post(m, { action: 'mgr_req_proxy', mgr_key: 'AK', acting_name: '代號店長', emp_id: emp, kind: 'leave', leave_type: '事假', date: D, hours: 8, reason: '測試代開' }); return [r.ok, r.error || '']; };
  BAD.forEach((b, i) => check('K1-4-0' + (i + 1), (i === 0 ? "陣列 [\"E02\"]" : b[0]) + " → invalid_emp_id", proxy(i === 0 ? ["E02"] : b[1]), [false, 'invalid_emp_id']));
  check('K1-4-10', '對照：文字 E02 不是 invalid_emp_id（照原本流程走）', proxy('E02')[1] !== 'invalid_emp_id', true);
  check('K1-4-11', '對照：名冊沒有的員編照舊 invalid_emp_id', proxy('E99'), [false, 'invalid_emp_id']);
}

console.log('\n════ K1-5：名冊整批同步（sync_roster）════');
{
  const m = world();
  const r = post(m, { action: 'sync_roster', admin_key: 'ADM', employees: [{ emp_id: ['E01'], name: '被改名' }, { emp_id: { a: 1 }, name: '怪員編' }, null, { emp_id: 'E03', name: '測試三' }] });
  check('K1-5-01', '陣列、物件、null 那三筆略過（invalid_emp_id），正常那筆照加', [r.ok, (r.skipped || []).map((x) => x.reason), row(m, 'E01').name, m.roster().length, !!row(m, 'E03')],
    [true, ['invalid_emp_id', 'invalid_emp_id', 'invalid_emp_id'], '測試一', 3, true]);
  const m2 = world();
  const g = post(m2, { action: 'sync_roster', admin_key: 'ADM', employees: [{ emp_id: 'E01', name: '測試一改' }, { emp_id: 8, name: '數字員編' }] });
  check('K1-5-10', '對照：文字、數字員編照常改名／新增', [g.ok, g.skipped === undefined, row(m2, 'E01').name, !!row(m2, '8')], [true, true, '測試一改', true]);
}

console.log('\n════ K1-6：預填班別（set_shifts）════');
{
  const m = world();
  const r = post(m, { action: 'set_shifts', admin_key: 'ADM', shifts: [{ emp_id: ['E01'], shift_in: '11:00', shift_out: '20:00' }, null] });
  check('K1-6-01', '陣列、null → 不寫入、列在 not_found', [r.ok, r.updated, (r.not_found || []).length, row(m, 'E01').shift_in], [true, 0, 2, '']);
  const m2 = world();
  const g = post(m2, { action: 'set_shifts', admin_key: 'ADM', shifts: [{ emp_id: 'E01', shift_in: '11:00', shift_out: '20:00' }, { name: '測試二', shift_in: '10:00', shift_out: '19:00' }] });
  check('K1-6-10', '對照：文字員編、只帶姓名的照常寫入', [g.ok, g.updated, row(m2, 'E01').shift_in, row(m2, 'E02').shift_in], [true, 2, '11:00', '10:00']);
}

console.log('\n════ K1-7：滿 8 小時撤銷（ft8_revoke）════');
{
  const ft8 = (emp) => { const r = post(world({ props: { REQ_BIND_FROM: 'off', REQ_FT8_FROM: '2026-11-01' } }), { action: 'ft8_revoke', admin_key: 'ADM', items: [{ emp_id: emp, date: D }] }); return [r.ok, r.error || '']; };
  BAD.forEach((b, i) => check('K1-7-0' + (i + 1), b[0] + ' → bad_items', ft8(b[1]), [false, 'bad_items']));
  check('K1-7-10', '對照：文字 E01 不是 bad_items', ft8('E01')[1] !== 'bad_items', true);
  check('K1-7-11', '對照：數字 7 不是 bad_items', ft8(7)[1] !== 'bad_items', true);
}

console.log('\n════ K2：doPost 內文不是物件 ════');
{
  const m = world();
  const safe = (text) => { try { return JSON.parse(raw(m, text).text); } catch (e) { return { threw: String(e && e.name) }; } };
  const p = (text) => { const r = safe(text); return [r.ok, r.error, r.threw]; };
  check('K2-01', 'null → unknown_action，不丟例外', p('null'), [false, 'unknown_action', undefined]);
  check('K2-02', '數字 123 → unknown_action', p('123'), [false, 'unknown_action', undefined]);
  check('K2-03', '文字 "clock" → unknown_action', p('"clock"'), [false, 'unknown_action', undefined]);
  check('K2-04', '陣列 [{"action":"whoami"}] → unknown_action', p('[{"action":"whoami"}]'), [false, 'unknown_action', undefined]);
  check('K2-05', 'true、false、0、空字串 "" → unknown_action', [p('true'), p('false'), p('0'), p('""')].map((x) => x[1] + '|' + x[2]), Array(4).fill('unknown_action|undefined'));
  check('K2-06', '對照：不是 JSON 照舊 bad_json', p('{oops'), [false, 'bad_json', undefined]);
  check('K2-07', '對照：空物件 {} 照舊 unknown_action', p('{}'), [false, 'unknown_action', undefined]);
  const w = safe(JSON.stringify({ action: 'mgr_day', mgr_key: 'MK', date: D }));
  check('K2-08', '對照：正常動作照舊', [w.ok, w.date], [true, D]);
  const g = m.sb.doGet({});
  check('K2-09', 'doGet 不讀任何參數（沒帶 e 也不丟）', [typeof g.text, typeof m.sb.doGet().text], ['string', 'string']);
}
done();
