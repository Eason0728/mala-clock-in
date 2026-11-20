/* 規則甲（二段班中途離開記遲到）Codex 交叉驗證 2026-11-21 的問題 1～4：在 mini 上照報告條件重寫的重現測試＋延後生效（PR-A）的保證。
 * Codex 原始重現檔 review-gap-late-edge.test.js 在 MacBook，這裡沒有；條件照 ~/dzy-mini-playbook/handoff/codex/20261121-rules-ab/report.md 重寫。
 *
 * 一、重現（屬性 REQ_GAP_LATE_FROM 明確設成日期＝規則甲開著時的現況）。標「現況（錯）」的項目是在記錄錯誤行為，PR-B 修好後會改成正確預期。
 *   Q1 班表 09–11、13–17；卡 09:00 上、11:00 下、12:58 上、13:03 下、14:00 上（缺最後下班卡）。
 *      營運系統規則甲開著會預填 09–11、13–17（把猜補的 14:00–17:00 也當有效打卡、13:03–14:00 當中途離開；前端那半在 mala-store-ops 測）。
 *      打卡端：填卡差原因後就核成 6 小時、狀態「早退237分」，沒有要忘打卡單。
 *      ⚠ mini 實測：同一組時段在規則甲關著、甚至 11/20 前的版本（d3798f5）也一樣被接受＝後端這個洞是舊的；退化在於營運系統現在會「自動預填」這組時段。
 *      對照：規則甲關著時營運系統預填 09–11、14–17 → 打卡端要忘打卡單（下面 Q1c）。
 *   Q2 班表 09–11、11:10–15（兩段間隔 10 分）；卡 09:00–11:00、11:10–15:00；營運系統 15 分對齊（規則甲開關都一樣）預填 09:00–15:00。
 *      打卡端開著：「遲到10分、中途離開10分」（空檔跨兩段班表，不該算中途離開）；關著：照舊。
 *   Q3 班表 11–14、16–20；卡 10:58–14:00、15:58–16:03、16:13–20:00；核定 11–14、16–20。
 *      關著先核一次＝「遲到13分、有多出的打卡段」；之後開著重新送出 → 變「遲到10分、中途離開10分」並多一筆核定（規格：已核定的日子照舊）。
 *   Q4 同 Q3 的卡：前端開／後端關 → 後端照舊寫「遲到13分、有多出的打卡段」（前端顯示遲到 10）；前端關（預填同樣 11–14、16–20、遲到 0）／後端開 → 後端寫「遲到10分、中途離開10分」。
 * 二、延後生效（PR-A，2026-11-21）：沒設 REQ_GAP_LATE_FROM 時，11/22 以後的日子打卡端完全不套規則甲＝跟 REQ_GAP_LATE_FROM=off 逐欄相同、狀態沒有「中途離開」。
 * 名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
function env(D, now, evs, props) {
  return make({ now: T(now), props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props || {}),
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: evs.map((e) => [D + 'T' + e[0] + ':00', 'E01', e[1]]) } });
}
const ACT = (spans, o) => Object.assign({ mgr_key: 'AK', acting_name: '店長乙（DZY002）', sched_day: 'W', sched_spans: spans }, o || {});
function approve(m, D, periods, extra) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods) }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', hours: r.approved_hours === undefined ? null : r.approved_hours, status: r.status_text || '', message: r.message || '' };
}
const approvedRows = (m) => m.sb.readSheetAsObjects(m.self.getSheetByName('approved')).rows.length;

const D0 = '2026-11-20', NOW0 = '2026-11-21T21:00:00';
const ON = { REQ_GAP_LATE_FROM: '2026-11-20' }, OFF = { REQ_GAP_LATE_FROM: 'off' };
const SP1 = [{ start: '09:00', end: '11:00' }, { start: '13:00', end: '17:00' }];
const EV1 = [['09:00', 'in'], ['11:00', 'out'], ['12:58', 'in'], ['13:03', 'out'], ['14:00', 'in']];
const SP2 = [{ start: '09:00', end: '11:00' }, { start: '11:10', end: '15:00' }];
const EV2 = [['09:00', 'in'], ['11:00', 'out'], ['11:10', 'in'], ['15:00', 'out']];
const SP3 = [{ start: '11:00', end: '14:00' }, { start: '16:00', end: '20:00' }];
const EV3 = [['10:58', 'in'], ['14:00', 'out'], ['15:58', 'in'], ['16:03', 'out'], ['16:13', 'in'], ['20:00', 'out']];
const WHY = '上班卡 14:00：主管同意';

console.log('════ 一、Codex 問題 1～4 重現（規則甲開著）════');
{
  let m = env(D0, NOW0, EV1, ON);
  let r = approve(m, D0, '09:00-11:00,13:00-17:00', ACT(SP1, { dry_run: true }));
  check('Q1a', '問題1 現況：先只要卡差原因（上班卡 14:00 差 60 分），沒要忘打卡單', [r.ok, r.error], [false, 'need_diff_reason']);
  r = approve(m, D0, '09:00-11:00,13:00-17:00', ACT(SP1, { diff_reason: WHY }));
  check('Q1b', '問題1 現況（錯）：填原因後核成 6 小時、狀態「早退237分」（缺最後一張下班卡卻沒要忘打卡單）', [r.ok, r.hours, r.status], [true, 6, '早退237分']);
  m = env(D0, NOW0, EV1, OFF);
  r = approve(m, D0, '09:00-11:00,13:00-17:00', ACT(SP1, { diff_reason: WHY }));
  check('Q1b-off', '問題1 後端那半是舊洞：規則甲關著同一組時段也一樣被接受（mini 另以 d3798f5 實測同結果）', [r.ok, r.status], [true, '早退237分']);
  m = env(D0, NOW0, EV1, OFF);
  r = approve(m, D0, '09:00-11:00,14:00-17:00', ACT(SP1, { diff_reason: WHY }));
  check('Q1c', '對照：規則甲關著營運系統預填 09–11、14–17 → 打卡端要忘打卡單（不會核成）', [r.ok, r.error], [false, 'need_request']);
}
{
  let m = env(D0, NOW0, EV2, ON);
  let r = approve(m, D0, '09:00-15:00', ACT(SP2, { dry_run: true }));
  check('Q2', '問題2 現況（錯）：空檔 11:00–11:10 在兩段班表之間，開著卻寫「遲到10分、中途離開10分」', [r.ok, r.status], [true, '遲到10分、中途離開10分']);
  m = env(D0, NOW0, EV2, OFF);
  r = approve(m, D0, '09:00-15:00', ACT(SP2, { dry_run: true }));
  check('Q2-off', '問題2 對照：關著不記中途離開', [r.ok, /中途離開/.test(r.status)], [true, false]);
}
{
  const m = env(D0, NOW0, EV3, OFF);
  let r = approve(m, D0, '11:00-14:00,16:00-20:00', ACT(SP3));
  check('Q3a', '問題3：規則甲關著先核定＝遲到13分、有多出的打卡段', [r.ok, r.status, approvedRows(m)], [true, '遲到13分、有多出的打卡段', 1]);
  m.props.REQ_GAP_LATE_FROM = '2026-11-20';
  if (m.sb.READ_MEMO_) m.sb.READ_MEMO_ = null;
  r = approve(m, D0, '11:00-14:00,16:00-20:00', ACT(SP3));
  check('Q3b', '問題3 現況（錯）：開著後同一天重新送出 → 改寫成「遲到10分、中途離開10分」、多一筆核定', [r.ok, r.status, approvedRows(m)], [true, '遲到10分、中途離開10分', 2]);
}
{
  let m = env(D0, NOW0, EV3, OFF);
  let r = approve(m, D0, '11:00-14:00,16:00-20:00', ACT(SP3, { dry_run: true }));
  check('Q4a', '問題4 現況（錯）：前端開（顯示遲到 10）／後端關 → 後端寫「遲到13分、有多出的打卡段」', [r.ok, r.status], [true, '遲到13分、有多出的打卡段']);
  m = env(D0, NOW0, EV3, ON);
  r = approve(m, D0, '11:00-14:00,16:00-20:00', ACT(SP3, { dry_run: true }));
  check('Q4b', '問題4 現況（錯）：前端關（預填一樣、顯示遲到 0）／後端開 → 後端寫「遲到10分、中途離開10分」', [r.ok, r.status], [true, '遲到10分、中途離開10分']);
}

console.log('\n════ 二、延後生效（PR-A）：沒設屬性，11/22 以後也不套規則甲 ════');
{
  const D = '2026-11-23', NOW = '2026-11-25T21:00:00';
  const DAY81 = [['10:58', 'in'], ['14:00', 'out'], ['15:58', 'in'], ['16:03', 'out'], ['17:24', 'in'], ['20:00', 'out']];
  const SPB = [{ start: '11:00', end: '14:00' }, { start: '16:00', end: '20:00', break_min: 30 }];
  const REST = [['11:00', 'in'], ['14:00', 'out'], ['16:00', 'in'], ['17:00', 'out'], ['17:50', 'in'], ['20:00', 'out']];
  const cases = [
    ['N1', '81 分鐘例子（二段班空檔 81）', DAY81, SP3, '11:00-14:00,16:00-20:00', {}],
    ['N2', '問題1 的卡（缺最後下班卡）', EV1, SP1, '09:00-11:00,13:00-17:00', { diff_reason: WHY }],
    ['N3', '問題2 的卡（兩段班表間隔 10 分）', EV2, SP2, '09:00-15:00', {}],
    ['N4', '問題3／4 的卡（空檔 10 分）', EV3, SP3, '11:00-14:00,16:00-20:00', {}],
    ['N5', '班別休息超過（休 30、出去 50）', REST, SPB, '11:00-14:00,16:00-17:00,17:30-20:00', {}],
  ];
  for (const [id, label, evs, spans, periods, extra] of cases) {
    for (const dry of [true, false]) {
      const a = approve(env(D, NOW, evs, {}), D, periods, ACT(spans, Object.assign({ dry_run: dry }, extra)));
      const b = approve(env(D, NOW, evs, OFF), D, periods, ACT(spans, Object.assign({ dry_run: dry }, extra)));
      check(id + (dry ? 'd' : 'w'), label + '：沒設屬性＝跟 off 逐欄相同、沒有「中途離開」（' + (dry ? '只檢查' : '真的核定') + '）',
        [JSON.stringify(a) === JSON.stringify(b), /中途離開/.test(a.status)], [true, false]);
    }
  }
  const on = approve(env(D, NOW, DAY81, { REQ_GAP_LATE_FROM: '2026-11-22' }), D, '11:00-14:00,16:00-20:00', ACT(SP3, { dry_run: true }));
  check('N-sanity', '對照（證明上面比得出差別）：屬性設 2026-11-22 才會開 → 遲到81分、中途離開81分', [on.ok, on.status], [true, '遲到81分、中途離開81分']);
  const m = env(D, NOW, [], {});
  check('N-fn', '函式層：沒設屬性 reqGapLateFrom_＝null；11/22、11/23、12/31 都不套；reqGapLateDay_（二段班）＝false',
    [m.sb.reqGapLateFrom_(), m.sb.reqGapLateOn_('2026-11-22'), m.sb.reqGapLateOn_('2026-11-23'), m.sb.reqGapLateOn_('2026-12-31'), m.sb.reqGapLateDay_(D, SP3)],
    [null, false, false, false, false]);
  for (const v of ['', '   ', 'on', 'true', '2026/11/22', 'yes']) {
    check('N-v' + JSON.stringify(v), 'REQ_GAP_LATE_FROM=' + JSON.stringify(v) + ' → 關', env(D, NOW, [], { REQ_GAP_LATE_FROM: v }).sb.reqGapLateOn_(D), false);
  }
}
done();
