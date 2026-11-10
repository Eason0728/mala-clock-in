/* B29（2026-11-10 挑錯；2026-11-11 Eason 定：A）：同一天兩張申請「都有時段、而且時段不重疊」就可以同時在審。
 * 原本：同一人、同一天、同一類只要有一張審核中，第二張一律擋——上午病假還在等證明，下午的事假就送不出去；
 *       同一天兩段加班也要等第一張核完才能送第二張。
 * 新規則（請假／加班／出差）：兩張都有開始、結束時間，而且不重疊 → 收；時段重疊、或任一張只填時數沒有時段 → 照舊擋（不分假別）。
 *       忘打卡不變（同一張卡才算重複）。擋下來的字句不變。
 * 用真函式跑，名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-12';
const res = (r) => (r.ok ? 'ok' : r.error + '｜' + r.message);
function world() { return make({ now: T('2026-11-10T10:00:00'), self: { roster: [ME], events: [] } }); }
function submit(m, body) { m.advance(1000); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', date: D }, body)); }
const ot = (s, e) => ({ kind: 'ot', start: s, end: e, reason: '盤點' });
const lv = (t, s, e) => ({ kind: 'leave', leave_type: t, start: s, end: e });
const lvH = (t, h) => ({ kind: 'leave', leave_type: t, hours: h });
const trip = (s, e) => ({ kind: 'trip', start: s, end: e, place: '央廚', why: '開會' });
const two = (a, b) => { const m = world(); return [res(submit(m, a)), res(submit(m, b))]; };
const DUP = (k) => 'duplicate｜這天已經有一筆審核中的' + k + '申請，要改請先取消那一筆';

// ── 加班 ──
check('B29-01', '加班 18:00–19:00 審核中，再送 21:00–22:00（不重疊）→ 收', two(ot('18:00', '19:00'), ot('21:00', '22:00')), ['ok', 'ok']);
check('B29-02', '加班相接 17:00–18:00 與 18:00–19:00（不算重疊）→ 收', two(ot('17:00', '18:00'), ot('18:00', '19:00')), ['ok', 'ok']);
check('B29-03', '加班 18:00–20:00 審核中，再送 19:00–21:00（重疊）→ 照舊擋，字句不變', two(ot('18:00', '20:00'), ot('19:00', '21:00')), ['ok', DUP('加班')]);
check('B29-04', '一模一樣的加班再送一次 → 擋', two(ot('18:00', '19:00'), ot('18:00', '19:00')), ['ok', DUP('加班')]);
check('B29-05', '跨夜 22:00–01:00 審核中，再送 00:00–02:00（凌晨那一小時重疊）→ 擋', two(ot('22:00', '01:00'), ot('00:00', '02:00')), ['ok', DUP('加班')]);
check('B29-06', '反過來：00:00–02:00 審核中，再送 22:00–01:00 → 擋', two(ot('00:00', '02:00'), ot('22:00', '01:00')), ['ok', DUP('加班')]);
check('B29-07', '對照：跨夜 22:00–01:00 與同一天傍晚 18:00–20:00（不重疊）→ 收', two(ot('22:00', '01:00'), ot('18:00', '20:00')), ['ok', 'ok']);
{
  const m = world();
  const r = [submit(m, ot('18:00', '19:00')), submit(m, ot('21:00', '22:00')), submit(m, ot('18:30', '21:30'))].map(res);
  check('B29-08', '兩張不重疊的都在審，第三張跨到其中一張 → 擋', r, ['ok', 'ok', DUP('加班')]);
}

// ── 請假 ──
check('B29-10', '上午病假 09:00–13:00（等證明、審核中）＋下午事假 14:00–18:00 → 收', two(lv('病假', '09:00', '13:00'), lv('事假', '14:00', '18:00')), ['ok', 'ok']);
check('B29-11', '病假 09:00–13:00 審核中，再送事假 12:00–15:00（重疊，假別不同也擋）→ 擋', two(lv('病假', '09:00', '13:00'), lv('事假', '12:00', '15:00')), ['ok', DUP('請假')]);
check('B29-12', '第一張只填時數（沒有時段），第二張有時段 → 照舊擋', two(lvH('事假', 4), lv('病假', '14:00', '18:00')), ['ok', DUP('請假')]);
check('B29-13', '第一張有時段，第二張只填時數 → 照舊擋', two(lv('病假', '14:00', '18:00'), lvH('事假', 4)), ['ok', DUP('請假')]);
check('B29-14', '兩張都只填時數 → 照舊擋', two(lvH('特休假', 8), lvH('事假', 4)), ['ok', DUP('請假')]);

// ── 出差 ──
check('B29-20', '出差 09:00–12:00 審核中，再送 13:00–17:00 → 收', two(trip('09:00', '12:00'), trip('13:00', '17:00')), ['ok', 'ok']);
check('B29-21', '出差 09:00–12:00 審核中，再送 11:00–14:00（重疊）→ 擋', two(trip('09:00', '12:00'), trip('11:00', '14:00')), ['ok', DUP('出差')]);
check('B29-22', '出差只填時數＋另一張有時段 → 擋', two({ kind: 'trip', hours: 8, place: '央廚', why: '開會' }, trip('13:00', '17:00')), ['ok', DUP('出差')]);
check('B29-23', '對照：請假與出差是不同類，本來就各算各的 → 收', two(lv('事假', '09:00', '12:00'), trip('09:00', '12:00')), ['ok', 'ok']);

// ── 兩張不重疊的單一起核准之後：不會重複算，再送同一段還是擋 ──
{
  const m = world();
  const a = submit(m, ot('17:00', '18:00')), b = submit(m, ot('18:00', '19:00'));
  const bt = m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [a.request && a.request.id, b.request && b.request.id].filter(Boolean), decision: 'approve' });
  check('B29-30', '兩張相接的加班一起批次核准 → 兩張都核准', [res(a), res(b), (bt.done || []).length, (bt.skipped || []).length], ['ok', 'ok', 2, 0]);
  const day = m.sb.handleMgrReqDay_({ mgr_key: 'MK', date: D });
  const ots = ((day.by_emp || {}).E01 || []).filter((x) => x.kind === 'ot');
  check('B29-31', '核定頁帶出的已核准加班：兩筆、合計 2 小時（沒有多算）', [ots.length, ots.reduce((s, x) => s + Number(x.hours), 0)], [2, 2]);
  check('B29-32', '核准後再送同一段 17:00–18:00 → 已核准那一關擋', res(submit(m, ot('17:00', '18:00'))).split('（')[0], 'duplicate｜這天已經有一筆核准的加班申請');
  check('B29-33', '核准後再送 17:30–18:30（跨到兩張）→ 擋', res(submit(m, ot('17:30', '18:30'))).split('｜')[0], 'duplicate');
  check('B29-34', '核准後送第三段不重疊的 20:00–21:00 → 收', res(submit(m, ot('20:00', '21:00'))), 'ok');
  const all = m.sb.handleMgrReqDay_({ mgr_key: 'MK', date: D });
  check('B29-35', '第三段還沒核准：已核准的加班仍是 2 小時', ((all.by_emp || {}).E01 || []).filter((x) => x.kind === 'ot').reduce((s, x) => s + Number(x.hours), 0), 2);
}
{
  // 跨夜的那張核准之後，凌晨重疊的那張一樣不能收（不然凌晨那一小時算兩次）
  const m = world();
  const a = submit(m, ot('22:00', '01:00'));
  const ok = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request && a.request.id, decision: 'approve' });
  check('B29-40', '跨夜 22:00–01:00 核准後，再送 00:00–02:00 → 擋', [ok.ok, res(submit(m, ot('00:00', '02:00'))).split('｜')[0]], [true, 'duplicate']);
}
{
  // 上午病假等證明（審核中），下午事假先核准；病假補不補證明都不影響事假
  const m = world();
  const a = submit(m, lv('病假', '09:00', '13:00')), b = submit(m, lv('事假', '14:00', '18:00'));
  const ok = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request && b.request.id, decision: 'approve' });
  const rows = m.sb.reqRows_(m.sb.getSS()).filter((r) => r.date === D).map((r) => r.leave_type + ' ' + r.status).sort();
  check('B29-50', '下午事假可以先核准，上午病假留在審核中', [res(a), res(b), ok.ok, rows], ['ok', 'ok', true, ['事假 approved', '病假 pending']]);
}

// ── 忘打卡照舊：同一張卡才算重複 ──
{
  const m = make({ now: T('2026-11-13T10:00:00'), self: { roster: [ME], events: [[D + 'T10:00:00', 'E01', 'in']] } });
  const miss = (end) => { m.advance(1000); return m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'miss', date: D, miss_type: 'out', end: end, reason: '忘記按' }); };
  check('B29-60', '忘打卡：補下班卡審核中，再補一次 → 照舊擋', [res(miss('18:00')), res(miss('18:00')).split('｜')[0]], ['ok', 'duplicate']);
}
done();
