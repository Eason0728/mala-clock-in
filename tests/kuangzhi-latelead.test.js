/* 曠職（#243）× 上午整段沒到改算遲到（#242）交會（2026-11-27 合併預演 pre/1130-243b）。
 * 規則白話（兩邊都從 handleMgrApprove 入口追到寫入）：
 *   ‧認定曠職（kzPlan）只在「0 個上班時段＋只有曠職」才成立（kzApprovePre_：帶時段或別的假別＝kz_mixed，句 13），
 *     而且那天不能有任何打卡（kzApprovePost_：kz_has_punch，句 9）、不能有待審／已核准忘打卡單（kz_has_req，句 10）。
 *   ‧上午整段沒到改算遲到（lateLead）只在「有上班時段」那個分支算（rawPeriods 非空），還要有打卡段；0 個時段＝一定是 false；每天重算對沒有時段的列直接跳過。
 *   → 同一次核定兩者互斥。同一天先認定曠職、後來打卡進來／補單再重新核定＝合約 2-4「重新核定覆蓋」：leave 整批換掉、曠職消失，只剩遲到（不會曠職＋遲到重複扣）。
 * 手算（央廚 12–13 休息帶，班 08:00–12:00、13:00–17:00；今天 12/10；生效日 12/1）：
 *   X1 12:47 上班、17:00 下班：主管送曠職（0 時段）→ kz_has_punch；照時段核定 dry_run → 遲到 240 分、late_lead true、沒有 kz
 *   X2 同一天送曠職＋時段 → kz_mixed
 *   X3 整天沒打卡：曠職 dry_run → ok、kz 8 小時、late_lead false、什麼都沒寫；正式認定 → leave 一列曠職 8
 *   X4 X3 之後打卡進來（12:47／17:00）、主管照時段重新核定 → 遲到 240、late_lead true、leave 的曠職那列被換掉（0 列）；再送曠職 → kz_day_done
 * 全部虛構姓名工號。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const D = '2026-12-03';
const ME = { emp_id: 'CF15', name: '測試甲', key: 'K1', device_id: 'D1', active: 'TRUE' };
const PER = [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }];
const KZS = { work: true, hours: 8, xpunch: false, xreq: false };
const PUNCH = [[D + 'T12:47:00', 'CF15', 'in'], [D + 'T17:00:00', 'CF15', 'out']];
function env(events) {
  return make({ now: T('2026-12-10T10:00:00'), props: { REQ_STRICT_FROM: '2026-11-01', KUANGZHI_FROM: '2026-12-01' },
    config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' },
    self: { roster: [ME], events: events || [], approved: [], leave: [] } });
}
const base = (x) => Object.assign({ mgr_key: 'AK', acting_name: '店長甲', date: D, emp_id: 'CF15' }, x);
const KZ = (x) => base(Object.assign({ periods: [], leaves: [{ type: '曠職', hours: 8 }], kz_sched: KZS }, x || {}));
const lv = (m) => m.self.sh.leave.values.slice(1);
const apRows = (m) => m.self.sh.approved.values.slice(1).length;

console.log('══ 曠職 × 上午整段沒到改算遲到：同一次核定互斥；先曠職後重新核定＝覆蓋 ══');
{
  const m = env(PUNCH);
  const r = m.sb.handleMgrApprove(KZ());
  check('X1a', '有打卡（12:47 上班）的日子送曠職：擋 kz_has_punch（句 9），什麼都沒寫', [r.ok, r.error, apRows(m), lv(m).length], [false, 'kz_has_punch', 0, 0]);
  const d = m.sb.handleMgrApprove(base({ periods: PER, leaves: [], dry_run: true }));
  check('X1b', '同一天照時段試核定：套新規則遲到 240 分、late_lead true、沒有 kz 欄', [d.ok, d.status_text, d.late_lead, d.kz], [true, '遲到240分', true, undefined]);
  const r2 = m.sb.handleMgrApprove(KZ({ periods: PER }));
  check('X2', '曠職＋上班時段：擋 kz_mixed（句 13），走不到遲到的判斷', [r2.ok, r2.error], [false, 'kz_mixed']);
}
{
  const m = env([]);
  const d = m.sb.handleMgrApprove(KZ({ dry_run: true }));
  check('X3a', '整天沒打卡、曠職試核定：ok、kz 8 小時、late_lead false、leaves 只有曠職、什麼都沒寫',
    [d.ok, d.dry_run, d.kz, d.late_lead, d.leaves, d.status_text, apRows(m), lv(m).length], [true, true, { hours: 8 }, false, [{ type: '曠職', hours: 8 }], '全天請假', 0, 0]);
  const r = m.sb.handleMgrApprove(KZ());
  check('X3b', '正式認定：leave 一列曠職 8', [r.ok, r.kz, r.late_lead, lv(m)], [true, { hours: 8 }, undefined, [[D, '測試甲', '曠職', 8]]]);
  // 之後打卡進來（例：打卡未入帳後來補進、或補單後主管重新核定）
  env(PUNCH).self.sh.events.values.slice(1).forEach((row) => m.self.sh.events.appendRow(row.slice()));   // 同 helper 的打卡列格式
  const again = m.sb.handleMgrApprove(KZ());
  check('X4a', '已認定過、後來有打卡、又送曠職：擋（打卡檢查 D 先於已處理 F → kz_has_punch）', [again.ok, again.error], [false, 'kz_has_punch']);
  const re = m.sb.handleMgrApprove(base({ periods: PER, leaves: [] }));
  check('X4b', '照時段重新核定：遲到 240、late_lead 不出現在正式回應、沒有 kz；leave 的曠職那列被換掉（合約 2-4，不會曠職＋遲到重複扣）',
    [re.ok, re.status_text, re.kz, lv(m).filter((x) => x[2] === '曠職').length], [true, '遲到240分', undefined, 0]);
}
done();
