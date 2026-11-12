/* B33（2026-11-10 挑錯；2026-11-11 Eason 定：A 後端也擋）：打完卡 10 分鐘內，另一型的卡也不收。
 * 原本後端只擋「同一種卡 10 分鐘內」；「打完上班 10 分鐘內不能打下班」只鎖在畫面上，
 * 舊專屬連結（clock.html）用的是手機時鐘——手機時鐘快的人打完上班可以馬上打下班，兩張都收，
 * 當天就多出一段幾秒鐘的班。
 * 修正：後端看「最後一張算數的卡」（新手機待核准的也算），不到 10 分鐘，不論同型或另一型都不收。
 *       另一型被擋時記一筆 rejected_too_soon（不配對、不算工時、不會讓那天變成「打卡未入帳」），
 *       回一句「剛打完上班卡，X 分鐘後才能再打卡」；剛好滿 10 分鐘就收（和 LINE 打卡頁同一刻解鎖）。
 * 用真函式跑。名字一律假名。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { make, T, at, check, done, ROOT } = require('./helpers/gs-sandbox');
const PV = require(path.join(ROOT, 'tests/helpers/payroll-vm.js'));
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-07';
const HERE = Object.assign({ accuracy: 10 }, at(3));
const punch = (m, type, dev) => m.sb.handleClock(Object.assign({ key: 'K1', type: type, device_id: dev || 'D1' }, HERE));
const world = (now, events) => make({ now: T(now), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: events || [] } });
const st = (m) => m.events().map((e) => String(e.ts).slice(11, 19) + ' ' + e.type + ' ' + e.status);

console.log('════ 一、打完卡 10 分鐘內，另一型也不收 ════');
{
  const m = world(D + 'T09:00:00');
  check('B33-01', '09:00 上班卡 → 收', punch(m, 'in').status, 'ok');
  m.setNow(D + 'T09:03:00');
  const r = punch(m, 'out');
  check('B33-02', '09:03 打下班（另一型）→ 不收，狀態 rejected_too_soon', [r.ok, r.status], [true, 'rejected_too_soon']);
  check('B33-03', '回應帶白話訊息（還要等幾分鐘）', r.message, '剛打完上班卡，7 分鐘後才能再打卡');
  check('B33-04', '回應帶上一張卡的型別', r.last_type, 'in');
  check('B33-05', '打卡表留一筆被擋的紀錄，沒有變成成功的下班卡', st(m), ['09:00:00 in ok', '09:03:00 out rejected_too_soon']);
  m.setNow(D + 'T09:09:59');
  const r2 = punch(m, 'out');
  check('B33-06', '09:09:59（差 1 秒滿 10 分鐘）→ 還是不收，訊息說 1 分鐘後', [r2.status, r2.message], ['rejected_too_soon', '剛打完上班卡，1 分鐘後才能再打卡']);
  m.setNow(D + 'T09:10:00');
  check('B33-07', '09:10:00（剛好滿 10 分鐘）→ 收（被擋的那兩筆不會把鎖往後延）', punch(m, 'out').status, 'ok');
}
{
  const m = world(D + 'T18:00:00', [[D + 'T09:00:00', 'E01', 'in']]);
  check('B33-08', '18:00 下班卡 → 收', punch(m, 'out').status, 'ok');
  m.setNow(D + 'T18:00:08');
  const r = punch(m, 'in');
  check('B33-09', '18:00:08 連按到上班鍵 → 不收，訊息說剛打完下班卡', [r.status, r.message], ['rejected_too_soon', '剛打完下班卡，10 分鐘後才能再打卡']);
  m.setNow(D + 'T18:11:00');
  check('B33-10', '18:11 再打上班（超過 10 分鐘）→ 收', punch(m, 'in').status, 'ok');
}
{
  const m = world(D + 'T09:00:00');
  punch(m, 'in');
  m.setNow(D + 'T09:02:00');
  const r = punch(m, 'in');
  check('B33-11', '同一種卡 10 分鐘內照舊是 rejected_duplicate（沒有改）', [r.status, r.last_type], ['rejected_duplicate', 'in']);
}
{
  const m = world(D + 'T09:00:00');
  check('B33-12', '換了新手機打上班 → 新裝置待核准（這張也算「最後一張卡」）', punch(m, 'in', 'NEW').status, 'pending_device_approval');
  m.setNow(D + 'T09:01:00');
  check('B33-13', '1 分鐘後用新手機打下班 → 不收', punch(m, 'out', 'NEW').status, 'rejected_too_soon');
}
{
  const m = world(D + 'T09:00:00');
  const far = Object.assign({ key: 'K1', type: 'in', device_id: 'D1', accuracy: 5 }, at(500));
  check('B33-14', '上班卡超出範圍被擋（沒算數）', m.sb.handleClock(far).status, 'rejected_out_of_range');
  m.setNow(D + 'T09:00:30');
  check('B33-15', '30 秒後走近按下班：前一張沒算數，不受 10 分鐘鎖影響 → 收', punch(m, 'out').status, 'ok');
}

console.log('\n════ 二、被擋的那一筆不會讓正常的一天變成異常 ════');
function day(events) {
  const m = make({ now: T('2026-11-10T21:00:00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: events } }), sb = m.sb;
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '18:00' }] });
  const seg = sb.dayPunchSegments(sb.readSheetAsObjects(m.self.sh.events).rows, 'E01', D).segments.map((s) => (s.in || '') + '-' + (s.out || ''));
  const dayRow = sb.handleMgrDay({ mgr_key: 'MK', date: D }).employees.filter((e) => e.emp_id === 'E01')[0];
  const apRows = sb.readSheetAsObjects(m.self.sh.approved).rows;
  const ps = PV.load({ today: '2026-11-10', clock: { SSLGF: { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }],
    events: m.events().map((e) => ({ ts: e.ts, emp_id: e.emp_id, type: e.type, status: e.status })),
    approved: apRows.map((a) => ({ date: a.date, emp_id: a.emp_id, name: a.name, periods: a.periods, approved_hours: a.approved_hours, status_text: a.status_text, manager_name: a.manager_name, entered_at: a.entered_at })),
    leave: [], requests: [] } }, data: { master: [PV.ftEmp()] } });
  const c = JSON.parse(JSON.stringify(ps.call('payCollect', '2026-11', 6, 'SSLGF', [], null))).E01 || {};
  return { 狀態: r.status_text, 打卡段: seg, 主管頁嘗試次數: dayRow.attempts, 薪資遲到分鐘: c.late_min || 0, 薪資忘刷天數: c.forget_day || 0, m: m };
}
const ev = (hms, type, s) => [D + 'T' + hms, 'E01', type, s];
const pick = (x) => [x.狀態, x.打卡段, x.薪資遲到分鐘, x.薪資忘刷天數];
const base = day([ev('09:00:00', 'in'), ev('18:00:00', 'out')]);
check('B33-20', '對照：09:00 上班、18:00 下班 → 正常、一段', pick(base), ['正常', ['09:00-18:00'], 0, 0]);
let r = day([ev('09:00:00', 'in'), ev('09:00:06', 'out', 'rejected_too_soon'), ev('18:00:00', 'out')]);
check('B33-21', '同上＋09:00:06 手滑按到下班被擋 → 和對照一樣（不是「打卡未入帳」、沒有多一段）', pick(r), pick(base));
check('B33-22', '主管頁照舊列出那一筆被擋的嘗試（1 次）', r.主管頁嘗試次數, 1);
r = day([ev('09:00:00', 'in'), ev('18:00:00', 'out'), ev('18:00:05', 'in', 'rejected_too_soon')]);
check('B33-23', '下班後 5 秒手滑按到上班被擋 → 和對照一樣（不會冒出「下班忘刷卡」）', pick(r), pick(base));
{
  const m = make({ now: T('2026-11-08T05:00:00'), props: { REQ_BIND_FROM: 'off' },
    self: { roster: [ME], events: [ev('09:00:00', 'in'), ev('09:00:06', 'out', 'rejected_too_soon'), ev('18:00:00', 'out')],
      approved: [[D, 'E01', '測試一', '09:00-18:00', 9, '打卡未入帳，主管補登', '值班主管', D + 'T20:00:00+08:00', '', '']] } });
  m.sb.recheckPendingApprovalStatuses();
  const rows = m.approved();
  check('B33-24', '每日重算用同一個口徑：被擋的那筆不算「未入帳」→ 重算後 正常', rows[rows.length - 1][5], '正常');
}
r = day([ev('09:00:00', 'in'), ev('09:00:06', 'out', 'rejected_too_soon')]);
check('B33-25', '真的忘打下班的人照舊標出來（被擋的那筆不當成下班卡）', [r.狀態, r.打卡段], ['下班忘刷卡', ['09:00-']]);

console.log('\n════ 三、和 LINE 打卡頁的 10 分鐘鎖同一刻解開、不會多擋 ════');
{
  const m = world(D + 'T09:10:00', [[D + 'T09:00:00', 'E01', 'in']]);
  const g = m.sb.liffGuard_(m.sb.liffEvents_(m.self, m.sb.liffStatusSince_()), 'E01');
  check('B33-30', '09:00 上班、09:10:00 整：LINE 那道鎖兩顆都解開', [g.blocked, m.sb.liffGuardReject_(g, 'out'), m.sb.liffGuardReject_(g, 'in')], [null, null, null]);
  check('B33-31', '同一刻後端也收下班卡', punch(m, 'out').status, 'ok');
}
{
  const m = world(D + 'T09:09:59', [[D + 'T09:00:00', 'E01', 'in']]);
  const g = m.sb.liffGuard_(m.sb.liffEvents_(m.self, m.sb.liffStatusSince_()), 'E01');
  check('B33-32', '09:09:59：LINE 那道鎖擋下班、後端也擋下班', [!!m.sb.liffGuardReject_(g, 'out'), punch(m, 'out').status], [true, 'rejected_too_soon']);
}
{
  // LINE 打卡正常會先被 LINE 那道鎖擋下、到不了後端這道；萬一漏過去（這裡把前一道關掉模擬），畫面要顯示後端那句話
  const m = world(D + 'T09:00:00');
  punch(m, 'in');
  m.setNow(D + 'T09:04:00');
  m.sb.liffGuardReject_ = () => null;
  const j = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out' }, HERE));
  check('B33-33', 'LINE 打卡收到後端這道擋 → 失敗，原因是那句白話、有說怎麼辦', [j.ok, j.status, j.reason, j.hint],
    [false, 'rejected_too_soon', '剛打完上班卡，6 分鐘後才能再打卡', '真的要下班請告知主管補登']);
}

console.log('\n════ 四、舊連結打卡頁（clock.html）收到這個狀態怎麼顯示 ════');
{
  const SRC = fs.readFileSync(path.join(ROOT, 'clock.html'), 'utf8');
  const extract = (name) => {
    const a = SRC.indexOf('  function ' + name + '(');
    if (a < 0) throw new Error('clock.html 找不到 ' + name);
    let i = SRC.indexOf('{', a), depth = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
    return SRC.slice(a, i + 1);
  };
  let f = null, err = '';
  try {
    const sb = { String };
    vm.createContext(sb);
    vm.runInContext(['tooSoonMessage', 'statusLabel'].map(extract).join('\n') + '\nthis.tooSoonMessage = tooSoonMessage; this.statusLabel = statusLabel;', sb);
    f = sb;
  } catch (e) { err = e.message; }
  check('B33-40', '畫面顯示後端那句話（不是「打卡成功」、也不是統一的失敗句）',
    f ? f.tooSoonMessage({ ok: true, status: 'rejected_too_soon', message: '剛打完上班卡，7 分鐘後才能再打卡' }, 'out') : err,
    '⚠ 剛打完上班卡，7 分鐘後才能再打卡（避免手滑誤打）。真的要下班請告知主管補登。');
  check('B33-41', '後端沒帶訊息時也有一句講得通的話',
    f ? f.tooSoonMessage({ ok: true, status: 'rejected_too_soon' }, 'in') : err,
    '⚠ 剛打完卡，10 分鐘內不能再打卡（避免手滑誤打）。真的要上班請告知主管補登。');
  check('B33-42', '今日紀錄裡這一筆的標示', f ? f.statusLabel('rejected_too_soon') : err, '太快重按');
  const doClock = (() => { try { return extract('doClock'); } catch (e) { return ''; } })();
  const iSoon = doClock.indexOf("res.status === 'rejected_too_soon'"), iSrv = doClock.indexOf("res.error === 'server_error'"), iOk = doClock.indexOf("res.ok && res.status === 'ok'");
  check('B33-43', '打卡回應的處理：先看是不是成功，再看這個狀態（顯示那句話），不會走到「回頭確認」那一支',
    [iOk >= 0 && iSoon > iOk, iSrv > iSoon, /rejected_too_soon'\) \{\s*(\/\/[^\n]*\n\s*)*showStatus\('status-warn', tooSoonMessage\(res, type\)\);/.test(doClock)], [true, true, true]);
  ['clock-cf.html', 'clock-hq.html', 'clock-mztgf.html'].forEach((fn, i) => {
    check('B33-44' + 'abc'[i], fn + '（由 clock.html 產生）也有同一段', fs.readFileSync(path.join(ROOT, fn), 'utf8').indexOf('function tooSoonMessage(') >= 0, true);
  });
}
done();
