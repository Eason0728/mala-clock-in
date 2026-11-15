/* 2026-11-15 考勤管理驗收找出的四個錯（打卡後端 Code.gs）。用真的 .gs 在 vm 跑，名字一律假名。
 *  C9-5 ：mgr_approve 的遲到分鐘沒有上限，99999 被寫成「遲到99999分(認定)」→ 超過一天（1440 分）回 bad_late_min、不寫入。
 *  C11-5：mgr_day 的日期格式錯，丟沒接住的 RangeError 變成 server_error → 回 bad_date。
 *  C11-7：mgr_approve 的 emp_id 送陣列／物件被收下、寫進 approved → 回 invalid_emp_id、不寫入。
 *  C11-8：doPost 的動作名稱送 constructor、toString、__proto__ 這類字被當成處理函式執行 → 回 unknown_action。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-10';
const P = [{ start: '09:00', end: '17:00' }];
const world = () => make({ now: T(D + 'T23:00:00'), props: { REQ_BIND_FROM: 'off' },
  self: { roster: [ME], events: [[D + 'T09:07:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']] } });
const post = (m, b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const approve = (m, extra) => post(m, Object.assign({ action: 'mgr_approve', mgr_key: 'MK', date: D, emp_id: 'E01', periods: P }, extra || {}));

console.log('════ C9-5：遲到分鐘超過一天（1440 分）不收 ════');
{
  const bad = (late) => { const m = world(); const r = approve(m, { late_min: late }); return [r.ok, r.error, m.approved().length]; };
  check('C9-5-01', '99999 → bad_late_min、approved 一列都沒寫', bad(99999), [false, 'bad_late_min', 0]);
  check('C9-5-02', '"99999"（文字）→ 同上', bad('99999'), [false, 'bad_late_min', 0]);
  check('C9-5-03', '1441 → 同上', bad(1441), [false, 'bad_late_min', 0]);
  check('C9-5-04', '1440.5（取整後 1441）→ 同上', bad(1440.5), [false, 'bad_late_min', 0]);
  check('C9-5-05', '1e308 → 同上', bad(1e308), [false, 'bad_late_min', 0]);
  {
    const m = world(); const r = approve(m, { late_min: 99999 });
    check('C9-5-06', '錯誤有中文說明', typeof r.message === 'string' && r.message.length > 0, true);
  }
  {
    const m = world(); const r = approve(m, { late_min: 99999, dry_run: true });
    check('C9-5-07', '只檢查（dry_run）也擋', [r.ok, r.error], [false, 'bad_late_min']);
  }
  {
    const m = world();
    const r = post(m, { action: 'mgr_approve_check', mgr_key: 'MK', date: D, items: [{ emp_id: 'E01', periods: P, late_min: 99999 }] });
    const it = (r.items || r.results || [])[0] || {};
    check('C9-5-08', '一次多人的只檢查（mgr_approve_check）那一筆也擋', [it.ok, it.error], [false, 'bad_late_min']);
  }
  const good = (late) => { const m = world(); const r = approve(m, { late_min: late }); return [r.ok, r.status_text, m.approved().length]; };
  check('C9-5-10', '對照：1440（剛好一天）照收', good(1440), [true, '遲到1440分(認定)', 1]);
  check('C9-5-11', '對照：15 照收', good(15), [true, '遲到15分(認定)', 1]);
  check('C9-5-12', '對照：0 → 主管認定不計遲到', good(0), [true, '主管認定不計遲到', 1]);
  check('C9-5-13', '對照：留空 → 用系統算的遲到 7 分', good(''), [true, '遲到7分', 1]);
  check('C9-5-14', '對照：沒帶這一欄 → 用系統算的', good(undefined), [true, '遲到7分', 1]);
  check('C9-5-15', '12.6（小數）→ 退回、不寫入（2026-11-15 Eason 定：也擋）', bad(12.6), [false, 'bad_late_min', 0]);
  check('C9-5-16', '-5、abc、true、[5] → 退回、不寫入', [bad(-5), bad('abc'), bad(true), bad([5])], [[false, 'bad_late_min', 0], [false, 'bad_late_min', 0], [false, 'bad_late_min', 0], [false, 'bad_late_min', 0]]);
  check('C9-5-17', '對照："7.0"、" 7 " 是整數照收', [good('7.0'), good(' 7 ')], [[true, '遲到7分(認定)', 1], [true, '遲到7分(認定)', 1]]);
}

console.log('\n════ C11-5：mgr_day 日期格式錯回 bad_date ════');
{
  const m = world();
  const day = (date) => { const r = post(m, { action: 'mgr_day', mgr_key: 'MK', date: date }); return [r.ok, r.error, r.detail === undefined]; };
  check('C11-5-01', '2026-13-40 → bad_date（不是 server_error）', day('2026-13-40'), [false, 'bad_date', true]);
  check('C11-5-02', 'abc → bad_date', day('abc'), [false, 'bad_date', true]);
  check('C11-5-03', '2026-02-30（沒有這天）→ bad_date', day('2026-02-30'), [false, 'bad_date', true]);
  check('C11-5-04', '5000 個字 → bad_date', day('2'.repeat(5000)), [false, 'bad_date', true]);
  check('C11-5-05', '數字 20261110 → bad_date', day(20261110), [false, 'bad_date', true]);
  check('C11-5-06', '陣列 ["2026-11-10"] → bad_date', day([D]), [false, 'bad_date', true]);
  const okDay = (body) => { const r = post(m, Object.assign({ action: 'mgr_day', mgr_key: 'MK' }, body)); return [r.ok, r.date]; };
  check('C11-5-10', '對照：正常日期照舊', okDay({ date: '2026-11-09' }), [true, '2026-11-09']);
  check('C11-5-11', '對照：沒帶日期＝今天', okDay({}), [true, D]);
  check('C11-5-12', '對照：空字串＝今天', okDay({ date: '' }), [true, D]);
  {
    const r = post(m, { action: 'mgr_day', mgr_key: 'WRONG', date: 'abc' });
    check('C11-5-13', '對照：金鑰不對照舊先回 unauthorized', [r.ok, r.error], [false, 'unauthorized']);
  }
}

console.log('\n════ C11-7：mgr_approve 的 emp_id 只收字串或數字 ════');
{
  const bad = (emp) => { const m = world(); const r = approve(m, { emp_id: emp }); return [r.ok, r.error, m.approved().length]; };
  check('C11-7-01', '陣列 ["E01"] → invalid_emp_id、不寫入', bad(['E01']), [false, 'invalid_emp_id', 0]);
  check('C11-7-02', '物件 → invalid_emp_id、不寫入', bad({ toString: 'E01', a: 1 }), [false, 'invalid_emp_id', 0]);
  check('C11-7-03', '巢狀陣列 [["E01"]] → invalid_emp_id', bad([['E01']]), [false, 'invalid_emp_id', 0]);
  check('C11-7-04', 'true → invalid_emp_id', bad(true), [false, 'invalid_emp_id', 0]);
  {
    const m = world(); const r = approve(m, { emp_id: ['E01'], dry_run: true });
    check('C11-7-05', '只檢查（dry_run）也擋', [r.ok, r.error], [false, 'invalid_emp_id']);
  }
  {
    const m = world(); const r = approve(m, {});
    check('C11-7-10', '對照：字串 E01 照收，approved 的員編那格是字串 E01', [r.ok, m.approved().length, m.approved()[0][1]], [true, 1, 'E01']);
  }
  {
    const m = make({ now: T(D + 'T23:00:00'), props: { REQ_BIND_FROM: 'off' },
      self: { roster: [Object.assign({}, ME, { emp_id: 7 })], events: [[D + 'T09:00:00', 7, 'in'], [D + 'T17:00:00', 7, 'out']] } });
    const r = approve(m, { emp_id: 7 });
    check('C11-7-11', '對照：數字員編照收', [r.ok, m.approved().length], [true, 1]);
  }
  check('C11-7-12', '對照：名冊沒有的員編照舊 invalid_emp_id', bad('E99'), [false, 'invalid_emp_id', 0]);
}

console.log('\n════ C11-8：doPost 只認處理表自己的動作名稱 ════');
{
  const m = world();
  ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf', 'toLocaleString', '__defineGetter__', 'propertyIsEnumerable'].forEach(function (a, i) {
    check('C11-8-' + String(i + 1).padStart(2, '0'), '動作 ' + a + ' → unknown_action', post(m, { action: a, x: 1 }), { ok: false, error: 'unknown_action' });
  });
  check('C11-8-20', '動作是陣列 ["constructor"] → unknown_action', post(m, { action: ['constructor'] }), { ok: false, error: 'unknown_action' });
  check('C11-8-21', '對照：亂打的動作名稱照舊 unknown_action', post(m, { action: 'no_such_action' }), { ok: false, error: 'unknown_action' });
  check('C11-8-22', '對照：沒帶動作照舊 unknown_action', post(m, {}), { ok: false, error: 'unknown_action' });
  {
    const r = post(m, { action: 'mgr_day', mgr_key: 'MK', date: D });
    check('C11-8-23', '對照：表上有的動作照常（mgr_day）', r.ok, true);
  }
  {
    const mp = make({ now: T(D + 'T23:00:00'), payroll: true, hub: true, self: { roster: [ME] } });
    const r1 = post(mp, { action: 'constructor' }), r2 = post(mp, { action: 'whoami', key: 'K1' });
    check('C11-8-24', '薪資、LINE 模組都掛上時：constructor 一樣 unknown_action、whoami 照常', [r1, r2.ok], [{ ok: false, error: 'unknown_action' }, true]);
  }
}

done();
