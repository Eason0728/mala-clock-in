/* 曠職 v1.4：認定時點改成「那一班的下班時間過後」（2026-11-28 主管定案，取代第 4 題 A 的自補期限）。打卡端 Code.gs kzApprovePost_ G 段＋kzShiftOver_。
 * 規則白話：
 *   ‧營運系統在 kz_sched 帶 end（已發布班表那一班「整天最後一段」的下班時間，毫秒；跨午夜＝隔天）。現在 ≥ end 才可以認定，不用等同仁自補期限。
 *   ‧現在 < end、end 不在「那天 00:00～隔天 24:00」、end 帶了但不是數字 → kz_too_early（不帶字；營運系統換成既有的字）。什麼都不寫。
 *   ‧沒帶 end（舊營運系統）→ 照舊等自補期限、句 12（比較嚴，不放鬆）。
 *   ‧其他擋法（打卡、單、班表不是上班日、已核定、跟別的假一起）全部照舊，而且先於 G 段判（有打卡照樣句 9）。
 * 手算（台北時間）：12/3 一段班 08:00–17:00 → end 12/3 17:00；兩段班 10:00–14:00＋17:00–21:00 → 12/3 21:00；跨午夜 18:00–02:00 → 12/4 02:00。
 * 全部虛構姓名工號。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const D = '2026-12-03';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const KZS = { work: true, hours: 8, xpunch: false, xreq: false };
const E17 = T('2026-12-03T17:00:00'), E21 = T('2026-12-03T21:00:00'), E02 = T('2026-12-04T02:00:00');
function env(o) {
  o = o || {};
  const m = make({ now: T(o.now || '2026-12-03T17:00:00'), payroll: false, hub: false,
    props: { REQ_STRICT_FROM: '2026-11-01', KUANGZHI_FROM: '2026-12-01' },
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: o.events || [], approved: [], leave: [] } });
  m.sb.reqSheet_(m.self, true);
  return m;
}
const ap = (m, ks, x) => m.sb.handleMgrApprove(Object.assign({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }],
  kz_sched: Object.assign({}, KZS, ks) }, x || {}));
const brief = (r) => [r.ok === true, r.error || '', r.message || ''];
const written = (m) => [m.self.sh.approved.values.length - 1, m.self.sh.leave.values.length - 1];
const EARLY = [false, 'kz_too_early', ''];

console.log('══ 一、一段班 08:00–17:00：當天下班後就能認定（不用等 12/8）══');
{
  const m = env({ now: '2026-12-03T16:59:59' });
  check('S1', '16:59:59 → kz_too_early、不帶字', brief(ap(m, { end: E17 })), EARLY);
  check('S1b', '被擋什麼都沒寫', written(m), [0, 0]);
  const m2 = env({ now: '2026-12-03T17:00:00' });
  const r2 = ap(m2, { end: E17 });
  check('S1c', '17:00 整 → 認定成功（同仁自補期限 12/7 還沒過也可以）', [r2.ok, r2.message], [true, '已認定 12/3 曠職（8 小時）']);
  check('S1d', '寫入 approved 一列、leave 一列曠職', written(m2), [1, 1]);
}

console.log('\n══ 二、兩段班 10:00–14:00＋17:00–21:00：看最後一段 ══');
{
  check('S2', '14:30（第一段下班、第二段還沒上）→ 還不能', brief(ap(env({ now: '2026-12-03T14:30:00' }), { end: E21 })), EARLY);
  check('S2b', '20:59 → 還不能', brief(ap(env({ now: '2026-12-03T20:59:00' }), { end: E21 })), EARLY);
  check('S2c', '21:00 → 可以', ap(env({ now: '2026-12-03T21:00:00' }), { end: E21 }).ok, true);
}

console.log('\n══ 三、跨午夜 18:00–02:00：一律不能認定（外部審查第一輪擋項 1，保守做法）══');
{
  check('S3', '12/4 01:59 → 還不能', brief(ap(env({ now: '2026-12-04T01:59:00' }), { end: E02 })), EARLY);
  check('S3b', '12/4 02:00 過了下班也不能（跨午夜的班不認定）', brief(ap(env({ now: '2026-12-04T02:00:00' }), { end: E02 })), EARLY);
  check('S3b2', '12/20 很久以後也不能、什麼都沒寫', (() => { const m = env({ now: '2026-12-20T10:00:00' }); return [brief(ap(m, { end: E02 })), written(m)]; })(), [EARLY, [0, 0]]);
  check('S3b3', '第二段隔天才開班（20:00–23:00＋00:00–03:00，end 12/4 03:00）、次日只有 00:00 上班卡 → 不能認定（原本會被當成沒打卡）',
    brief(ap(env({ now: '2026-12-04T09:00:00', events: [['2026-12-04T00:00:00', 'E01', 'in']] }), { end: T('2026-12-04T03:00:00') })), EARLY);
  check('S3b4', '下班剛好隔天 00:00（不跨午夜）、過了 → 可以', ap(env({ now: '2026-12-04T00:00:00' }), { end: T('2026-12-04T00:00:00') }).ok, true);
  check('S3c', '12/4 01:30 有下班卡（算 12/3）→ 照舊句 9（打卡先判）', brief(ap(env({ now: '2026-12-04T02:00:00', events: [['2026-12-04T01:30:00', 'E01', 'out']] }), { end: E02 })),
    [false, 'kz_has_punch', '這天有打卡紀錄，不能認定曠職']);
  check('S3d', '下班前就有上班卡 → 句 9 先於 kz_too_early', brief(ap(env({ now: '2026-12-03T19:00:00', events: [[D + 'T18:05:00', 'E01', 'in']] }), { end: E02 })),
    [false, 'kz_has_punch', '這天有打卡紀錄，不能認定曠職']);
}

console.log('\n══ 四、end 不合理 → 一律還不能（不放鬆）══');
{
  const late = env({ now: '2026-12-20T10:00:00' });
  check('S4', 'end 在 12/6（超過那天＋隔天）→ 還不能', brief(ap(late, { end: T('2026-12-06T00:00:01') })), EARLY);
  check('S4b', 'end 在前一天 → 還不能', brief(ap(env({ now: '2026-12-20T10:00:00' }), { end: T('2026-12-02T23:59:00') })), EARLY);
  check('S4c', 'end 是字串 → 還不能', brief(ap(env({ now: '2026-12-20T10:00:00' }), { end: String(E17) })), EARLY);
  check('S4d', 'end 是 null → 還不能', brief(ap(env({ now: '2026-12-20T10:00:00' }), { end: null })), EARLY);
  check('S4e', 'end 在隔天 24:00（12/5 00:00）＝跨午夜 → 不能', brief(ap(env({ now: '2026-12-05T00:00:00' }), { end: T('2026-12-05T00:00:00') })), EARLY);
}

console.log('\n══ 五、沒帶 end（舊營運系統）→ 照舊自補期限、句 12 ══');
{
  check('S5', '12/7 23:59 → 句 12「補單到 12/7」', brief(ap(env({ now: '2026-12-07T23:59:00' }), {})), [false, 'kz_too_early', '同仁還能自己補單到 12/7，請之後再認定']);
  check('S5b', '12/8 00:01 → 可以', ap(env({ now: '2026-12-08T00:01:00' }), {}).ok, true);
  check('S5c', '當天 17:00 沒帶 end → 不可以（不會因為沒帶就放鬆）', ap(env({ now: '2026-12-03T17:00:00' }), {}).ok, false);
}

console.log('\n══ 六、國定假日、沒發布班表（營運系統帶 work=false）→ 照舊句 11，下班後也一樣 ══');
{
  check('S6', 'work=false＋end 已過 → 句 11', brief(ap(env({ now: '2026-12-26T10:00:00' }), { work: false, hours: 8, end: E17 })), [false, 'kz_not_workday', '這天班表不是上班日，不能認定曠職']);
  check('S6b', '沒帶 kz_sched（沒發布）→ 句 11', brief(ap(env({ now: '2026-12-26T10:00:00' }), {}, { kz_sched: undefined })), [false, 'kz_not_workday', '這天班表不是上班日，不能認定曠職']);
}

console.log('\n══ 七、當天認定後才補打卡：不會自己改，主管重新核定才解除（第 12 題，照舊）══');
{
  const m = env({ now: '2026-12-03T17:00:00' });
  check('S7', '17:00 認定成功', ap(m, { end: E17 }).ok, true);
  const ev = (ts, type) => [ts + '+08:00', 'E01', type, 24.7840945, 121.0157448, 5, true, 'D1', true, 'ok', 10];      // 同 helpers/gs-sandbox.js evRow 的欄位順序
  m.self.sh.events.appendRow(ev('2026-12-03T08:02:00', 'in'));
  m.self.sh.events.appendRow(ev('2026-12-03T17:01:00', 'out'));
  check('S7a', '補進來的兩張卡讀得到（in／out）', m.events().map((e) => e.type), ['in', 'out']);
  check('S7b', '補打卡後 leave 仍有曠職（要主管重新核定）', m.self.sh.leave.values.slice(1).map((r) => r[2]), ['曠職']);
  m.setNow('2026-12-03T17:30:00');
  check('S7c', '再按一次認定 → 先撞「這天有打卡」句 9（不會重複寫）', brief(ap(m, { end: E17 })), [false, 'kz_has_punch', '這天有打卡紀錄，不能認定曠職']);
  // 外部審查第二輪 A：主管手動修改填時段重新核定（網頁開關開著時不把曠職跟時段一起送）→ 成功、曠職被移除
  const r8 = m.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [{ start: '09:01', end: '17:01' }], leaves: [], late_min: '', diff_reason: '同仁其實有來（測試）' });
  check('S7d', '重新核定只帶時段 09:01–17:01（8 小時、附差異原因）→ 成功', [r8.ok, r8.error || ''], [true, '']);
  check('S7e', '重新核定後 leave 那天沒有曠職（扣款跟著沒了）', m.self.sh.leave.values.slice(1).filter((r) => String(r[0]).slice(0, 10) === D || (r[0] instanceof Date)).map((r) => r[2]), []);
  const r9 = m.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'E01', periods: [{ start: '08:00', end: '17:00' }], leaves: [{ type: '曠職', hours: 8 }], late_min: '' });
  check('S7f', '對照：時段跟曠職一起送 → kz_mixed（網頁不再這樣送）', [r9.ok, r9.error], [false, 'kz_mixed']);
}

done();
