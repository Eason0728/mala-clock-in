/* 出勤核定舊問題 1（2026-11-21，Codex 20261121-rules-ab 問題 1 的後端那半；規則甲關著也重現）：
 *   缺最後一張下班卡，主管填卡差原因就能核成完整工時，狀態卻寫「早退237分」。
 * 根因：Requests.gs reqOverCreditMin_ 只要有一段打卡不完整就整個不算（回 null，原意是「交給忘打卡單那條」）；
 *   但 reqBindMissCards_ 只認「沒配到完整打卡段的核定時段」裡的單張卡——核定時段只要碰到一小段完整打卡（12:58–13:03），
 *   同一時段裡的單張卡（14:00 上班）就沒人管，兩條都放行。
 * 規則（既有，不是新規則）：2026-11-14 Eason「打卡＋單＝核定時數」（核定比打卡多 30 分以上要有單）、2026-11-16「缺單照擋，寫原因不能代替補單」。
 * 修法：忘打卡單那條沒擋到、這天又有沒配對的卡時，「核定比打卡多」改用「完整的打卡段＋已核准忘打卡單補的卡」照算（沒配對的卡不當證據）；
 *   還在上班的那張上班卡（B34，16 小時內）照舊當成一直在上班，不擋。開關 REQ_LONE_OVER（保護性：只有 off／false／0／no／關 才關，認不得照擋）。
 * 手算預期（日期 2026-11-20；班表 09–11、13–17）：
 *   L1 卡 09:00 上、11:00 下、12:58 上、13:03 下、14:00 上（缺最後下班卡），核定 09–11、13–17＋卡差原因
 *      完整段 09–11、12:58–13:03；第二段 13–17 只蓋到 3 分 → 多 240−3＝237 分；第一段開頭沒遲到 → 237 ≥ 30 擋 over_credit
 *   L2 同 L1＋已核准忘打卡單（下班 17:00）→ 補成 14:00–17:00；13–17 蓋到 3＋180 → 多 57 分 → 擋
 *   L3 同 L2，核定改 09–11、14–17 → 多 0 → 可以核定 5 小時；狀態不再是「早退237分」
 *   L4 重複上班卡（17:26 上、17:55 上、21:00 下）核定 17:30–21:00 → 多 25、開頭遲到 25 → 0 → 照舊可以核定
 *   L5 還在上班（今天 09–12、13:00 上班還沒下班，16:00 核定 09–12、13–17）→ 照舊可以核定（B03-02）
 *   L6 REQ_LONE_OVER=off → 退回舊行為（L1 照舊核成「早退237分」）
 *   L7 REQ_LONE_OVER 填認不得的值 → 照擋
 *   L8 完整段 09–11＋18:00 單張上班卡，核定 09–17＋原因 → 多 360 分 → 擋
 *   L9 沒有單張卡的正常日 09–17 → 照舊可以核定、狀態正常
 *   L10 只有 09:00 上班卡、核定 09–17（忘打卡單那條本來就擋）→ 只寫「少了 1 張打卡」，不多一條 over_credit
 * 名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const D = '2026-11-20', NOW = '2026-11-21T21:00:00';
function env(evs, props, reqs, now, date) {
  const d = date || D;
  const m = make({ now: T(now || NOW), props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props || {}),
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: evs.map((e) => [d + 'T' + e[0] + ':00', 'E01', e[1]]) } });
  if (reqs && reqs.length) {
    const sh = m.sb.reqSheet_(m.self, true);
    reqs.forEach((r, i) => {
      const row = Object.assign({ id: 'R' + i, created_at: d + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: d, status: 'approved' }, r);
      sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
    });
  }
  return m;
}
const SP1 = [{ start: '09:00', end: '11:00' }, { start: '13:00', end: '17:00' }];
const ACT = (o) => Object.assign({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: SP1 }, o || {});
function approve(m, periods, extra, date) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: date || D, emp_id: 'E01', periods: P(periods) }, extra || {}));
  const rules = (r.probs || []).map((p) => p.rule).join(',');
  return { ok: !!r.ok, error: r.error || '', hours: r.approved_hours === undefined ? null : r.approved_hours, status: r.status_text || '',
    over: r.need ? r.need.over_min : null, rules, message: r.message || '' };
}
const EV1 = [['09:00', 'in'], ['11:00', 'out'], ['12:58', 'in'], ['13:03', 'out'], ['14:00', 'in']];
const WHY = { diff_reason: '下班卡 13:03：主管同意；上班卡 14:00：主管同意' };
const MISS_OUT = { kind: 'miss', miss_type: 'out', start: '', end: '17:00' };

console.log('════ 一、缺最後一張下班卡不能靠卡差原因核成完整工時 ════');
{
  let r = approve(env(EV1), '09:00-11:00,13:00-17:00', ACT(WHY));
  check('L1', '缺最後下班卡、核定 09–11、13–17＋原因 → 擋「核定比打卡多 237 分鐘」（原本核成 6 小時、早退237分）',
    [r.ok, r.error, r.rules, r.over], [false, 'need_request', 'over_credit', 237]);
  r = approve(env(EV1), '09:00-11:00,13:00-17:00', ACT(Object.assign({ dry_run: true }, WHY)));
  check('L1d', '只檢查（dry_run）一樣擋', [r.ok, r.error, r.over], [false, 'need_request', 237]);
  r = approve(env(EV1), '09:00-11:00,13:00-17:00', WHY);
  check('L1s', '門市共用登入（值班主管金鑰、沒有班表）一樣擋', [r.ok, r.error, r.over], [false, 'need_request', 237]);
  r = approve(env(EV1, {}, [MISS_OUT]), '09:00-11:00,13:00-17:00', ACT(WHY));
  check('L2', '補了忘打卡單（下班 17:00）仍核 13–17 → 多 57 分照擋', [r.ok, r.error, r.over], [false, 'need_request', 57]);
  r = approve(env(EV1, {}, [MISS_OUT]), '09:00-11:00,14:00-17:00', ACT(WHY));
  check('L3', '補單後核 09–11、14–17 → 可以核定 5 小時，狀態不是「早退237分」', [r.ok, r.hours, /早退237/.test(r.status)], [true, 5, false]);
}
console.log('\n════ 二、不該多擋的照舊 ════');
{
  let r = approve(env([['17:26', 'in'], ['17:55', 'in'], ['21:00', 'out']]), '17:30-21:00', ACT({ sched_spans: [{ start: '17:30', end: '21:00' }], diff_reason: '上班卡 17:55：主管同意' }));
  check('L4', '重複上班卡（17:26、17:55）核 17:30–21:00 → 照舊可以核定（多出的 25 分是開頭遲到）', [r.ok, r.error], [true, '']);
  const TODAY = '2026-11-10';
  const m5 = env([['09:00', 'in'], ['12:00', 'out'], ['13:00', 'in']], {}, null, TODAY + 'T16:00:00', TODAY);
  r = approve(m5, '09:00-12:00,13:00-17:00', null, TODAY);
  check('L5', '還在上班（13:00 上班、16:00 核定 13–17）→ 照舊可以核定', [r.ok, r.error], [true, '']);
  r = approve(env([['09:00', 'in'], ['17:00', 'out']]), '09:00-17:00', ACT({ sched_spans: [{ start: '09:00', end: '17:00' }] }));
  check('L9', '沒有單張卡的正常日 → 照舊可以核定、狀態正常', [r.ok, r.status], [true, '正常']);
  r = approve(env([['09:00', 'in']]), '09:00-17:00', ACT({ sched_spans: [{ start: '09:00', end: '17:00' }] }));
  check('L10', '只有上班卡（忘打卡單那條本來就擋）→ 只有 miss，不多一條 over_credit', [r.ok, r.error, r.rules], [false, 'need_request', 'miss']);
}
console.log('\n════ 三、多核分鐘不因任何一張單張卡就整個不算 ════');
{
  const r = approve(env([['09:00', 'in'], ['11:00', 'out'], ['18:00', 'in']]), '09:00-17:00', ACT({ sched_spans: [{ start: '09:00', end: '17:00' }], diff_reason: '下班卡 11:00：主管同意' }));
  check('L8', '完整段 09–11＋18:00 單張卡，核 09–17 → 擋多 360 分', [r.ok, r.error, r.over], [false, 'need_request', 360]);
}
console.log('\n════ 四、開關 REQ_LONE_OVER（保護性）════');
{
  let r = approve(env(EV1, { REQ_LONE_OVER: 'off' }), '09:00-11:00,13:00-17:00', ACT(WHY));
  check('L6', 'REQ_LONE_OVER=off → 退回舊行為（照舊核成，狀態早退237分）', [r.ok, r.status], [true, '早退237分']);
  for (const v of [' OFF ', '關', 'false', '0', 'no']) {
    r = approve(env(EV1, { REQ_LONE_OVER: v }), '09:00-11:00,13:00-17:00', ACT(WHY));
    check('L6' + JSON.stringify(v), 'REQ_LONE_OVER=' + JSON.stringify(v) + ' → 關', r.ok, true);
  }
  for (const v of ['xyz', '2026-11-22', 'on', '']) {
    r = approve(env(EV1, { REQ_LONE_OVER: v }), '09:00-11:00,13:00-17:00', ACT(WHY));
    check('L7' + JSON.stringify(v), 'REQ_LONE_OVER=' + JSON.stringify(v) + ' → 照擋', [r.ok, r.over], [false, 237]);
  }
}
done();
