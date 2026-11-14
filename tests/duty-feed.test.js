// 考勤副本變動通知＋版本（2026-11-14，DutyFeed.gs；營運系統 docs/duty-replica-b）
// 走真 doPost：寫入記變動、duty_changes 拿得到、mgr_day with_ver 每人有 ver、mgr_approve 帶 base_ver 對不上就退回。
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const m = make({ now: T('2026-11-10T10:00:00'), self: {
  roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' }],
  events: [['2026-11-09T09:00:00', 'E01', 'in'], ['2026-11-09T17:00:00', 'E01', 'out'], ['2026-11-09T10:00:00', 'E02', 'in'], ['2026-11-09T18:00:00', 'E02', 'out']],
} });
const post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const day = (extra) => post(Object.assign({ action: 'mgr_day', mgr_key: 'AK', acting_name: '考勤副本（system）', date: '2026-11-09' }, extra || {}));
const verOf = (r, emp) => (r.employees.filter((e) => e.emp_id === emp)[0] || {}).ver;
const changes = (since) => post({ action: 'duty_changes', mgr_key: 'AK', since });

// 1. 沒帶 with_ver：回應不變
const plain = day();
check('F01', '沒帶 with_ver：沒有 ver', [plain.ok, plain.employees.some((e) => 'ver' in e), plain.with_ver], [true, false, undefined]);

// 2. 帶 with_ver：每人一個 16 字的 ver，重讀不變
const d1 = day({ with_ver: true });
const v1 = verOf(d1, 'E01');
check('F02', '帶 with_ver：每人有 ver、重讀一樣', [d1.with_ver, typeof v1, String(v1).length, verOf(day({ with_ver: true }), 'E01') === v1, verOf(d1, 'E01') !== verOf(d1, 'E02')], [true, 'string', 16, true, true]);

// 3. 讀取不記變動；duty_changes 沒給 since＝reset
const c0 = changes();
check('F03', '只有讀取：沒有變動、沒給 since 要求整批對帳', [c0.ok, c0.reset, c0.changes.length], [true, true, 0]);
const t0 = Date.now ? m.sb.Date.now() : 0;

// 4. 依副本核定：base_ver 對得上 → 核定成功，記一筆變動（動作、日期、人）
m.advance(5000);
const a1 = post({ action: 'mgr_approve', mgr_key: 'AK', acting_name: '店長甲（DZY001）', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], base_ver: v1 });
check('F04', 'base_ver 相符：照常核定', [a1.ok, a1.error], [true, undefined]);
const c1 = changes(t0);
check('F05', '核定後 duty_changes 有一筆（動作、日期、同仁）', c1.changes.map((x) => [x.a, x.d, x.e]), [['mgr_approve', ['2026-11-09'], 'E01']]);
check('F06', '有給 since 且在 15 分鐘內：不要求整批對帳', c1.reset, false);

// 5. 核定後版本變了；拿舊版本再核一次 → 退回 stale_ver，approved 不多寫
const v2 = verOf(day({ with_ver: true }), 'E01');
const nApproved = m.approved().length;
const a2 = post({ action: 'mgr_approve', mgr_key: 'AK', acting_name: '店長乙（DZY002）', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '16:00' }], base_ver: v1 });
check('F07', '核定後版本改變', v2 !== v1, true);
check('F08', '拿舊版本核定：退回 stale_ver、不寫入', [a2.ok, a2.error, a2.cur_ver === v2, m.approved().length], [false, 'stale_ver', true, nApproved]);
check('F09', '被退回不記變動', changes(t0).changes.length, 1);

// 6. 補一張打卡（直接寫 events，模擬 LINE 打卡）→ 版本改變
const vE2 = verOf(day({ with_ver: true }), 'E02');
m.self.sh.events.values.push(['2026-11-09T12:00:00+08:00', 'E02', 'out', 24.78, 121.01, 5, true, 'D1', true, 'ok', 10]);
check('F10', '同仁補了打卡：版本改變', verOf(day({ with_ver: true }), 'E02') !== vE2, true);

// 7. 沒帶 base_ver：照舊流程（舊 manager.html）
const a3 = post({ action: 'mgr_approve', mgr_key: 'MK', date: '2026-11-09', emp_id: 'E02', periods: [{ start: '10:00', end: '18:00' }] });
check('F11', '沒帶 base_ver：照常核定', [a3.ok], [true]);

// 8. 失敗的寫入不記
m.advance(1000);
const before = changes(t0).changes.length;
const bad = post({ action: 'mgr_approve', mgr_key: 'WRONG', date: '2026-11-09', emp_id: 'E02', periods: [{ start: '10:00', end: '18:00' }] });
check('F12', '失敗的寫入不記變動', [bad.ok, changes(t0).changes.length], [false, before]);

// 9. since 太舊（超過 15 分鐘）→ reset；duty_changes 要主管金鑰
m.advance(20 * 60000);
check('F13', 'since 超過 15 分鐘：要求整批對帳', changes(t0).reset, true);
check('F14', '金鑰不對：unauthorized', post({ action: 'duty_changes', mgr_key: 'NOPE', since: t0 }).error, 'unauthorized');

// 10. 薪資只讀動作不記；名單外動作（例 mgr_set_active）照記
const t1 = m.sb.Date.now();
m.advance(1000);
m.sb.dutyFeedNote_({ action: 'payroll_leave_options' }, { ok: true });
m.sb.dutyFeedNote_({ action: 'mgr_set_active', emp_id: 'E02' }, { ok: true });
check('F15', '只讀動作不記、其他寫入照記', changes(t1).changes.map((x) => x.a), ['mgr_set_active']);

// 11. 同仁從 LINE 送申請（內文沒有 emp_id）：從回應的 request 補上同仁與日期
const t2 = m.sb.Date.now();
m.advance(1000);
m.sb.dutyFeedNote_({ action: 'req_submit', id_token: 'x' }, { ok: true, request: { emp_id: 'E01', date: '2026-11-09' } });
check('F16', 'LINE 送申請：變動記到那位同仁那天', changes(t2).changes.map((x) => [x.a, x.e, x.d]), [['req_submit', 'E01', ['2026-11-09']]]);
done();
