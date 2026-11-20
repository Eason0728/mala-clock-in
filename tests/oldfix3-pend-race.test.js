/* 出勤核定舊問題 3（2026-11-21，Codex 20261121-rules-ab 問題 5）：規則乙「有待審單就擋核定」的檢查（Code.gs handleMgrApprove 開頭）
 * 跟真正寫入核定之間沒有同一把鎖。同仁送申請（Requests.gs req_submit 等）是在 ScriptLock 裡寫入的；核定在檢查完、跑完一長串綁單檢查之後才寫，
 * 中間同仁剛好送出一張單 → 寫入當下已有待審單卻照樣核定。
 * 修法（照 docs/clock-to-mini/phase2-5-design.md §4.2-2 的書面做法：鎖只包最後一段、搶不到回 busy）：
 *   寫入前拿 ScriptLock（tryLock 10 秒，同送申請），鎖內重讀申請表再判一次待審，沒有才寫 approved＋leave；搶不到回 busy「系統忙碌，請再按一次」、什麼都不寫。
 *   只檢查（dry_run）不拿鎖；REQ_PEND_BLOCK=off（規則乙關掉）時也不拿鎖＝完全退回舊行為。
 * 模擬競態：把 reqBindCheck_（開頭檢查之後、寫入之前一定會跑）包一層，跑的當下往申請表塞一張待審單＝「檢查完、寫入前，同仁送出一張單」。
 * 手算預期：
 *   R1 檢查後才出現待審單 → 擋 pending_request、approved 0 筆（原本照寫 1 筆）
 *   R2 搶不到鎖 → busy、approved 0 筆（原本不拿鎖、照寫）
 *   R3 正常核定 → 拿鎖 1 次、放鎖 1 次、approved 1 筆
 *   R4 鎖內擋下也要放鎖（放鎖次數＝拿到次數）
 *   R5 只檢查（dry_run）→ 不拿鎖
 *   R6 REQ_PEND_BLOCK=off → 不拿鎖、照舊寫入（競態也照舊放行＝退回舊行為）
 *   R7 待審單是別天的 → 照常寫入
 * 名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const D = '2026-11-20';
function env(props) {
  const m = make({ now: T('2026-11-21T21:00:00'), props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props || {}),
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: [ME], events: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:00:00', 'E01', 'out']] } });
  m.lockLog = { got: 0, rel: 0, tries: 0 };
  m.lockFree = true;
  m.sb.LockService = { getScriptLock: () => ({
    tryLock: () => { m.lockLog.tries++; if (m.lockFree) m.lockLog.got++; return m.lockFree; },
    waitLock: () => { m.lockLog.tries++; if (!m.lockFree) throw new Error('timeout'); m.lockLog.got++; },
    releaseLock: () => { m.lockLog.rel++; }, hasLock: () => true,
  }) };
  return m;
}
function sneakPending(m, date) {
  const orig = m.sb.reqBindCheck_;
  m.sb.reqBindCheck_ = function () {
    const sh = m.sb.reqSheet_(m.self, true);
    const row = { id: 'RX', created_at: D + 'T20:59:00+08:00', emp_id: 'E01', name: '測試一', date: date || D, status: 'pending', kind: 'ot', start: '17:00', end: '18:00', hours: 1 };
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
    return orig.apply(this, arguments);
  };
}
const approvedN = (m) => m.sb.readSheetAsObjects(m.self.getSheetByName('approved')).rows.length;
function approve(m, extra) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', message: r.message || '' };
}

console.log('════ 一、檢查完、寫入前出現待審單 ════');
{
  const m = env();
  sneakPending(m);
  const r = approve(m);
  check('R1', '寫入前同仁送出待審單 → 擋 pending_request、不寫 approved（原本照寫）', [r.ok, r.error, approvedN(m)], [false, 'pending_request', 0]);
  check('R4', '鎖內擋下也有放鎖', [m.lockLog.got, m.lockLog.rel], [1, 1]);
}
{
  const m = env();
  m.lockFree = false;
  const r = approve(m);
  check('R2', '搶不到鎖 → busy、什麼都不寫', [r.ok, r.error, /請再按一次/.test(r.message), approvedN(m)], [false, 'busy', true, 0]);
}
console.log('\n════ 二、平常照舊 ════');
{
  const m = env();
  const r = approve(m);
  check('R3', '正常核定：拿鎖 1 次、放鎖 1 次、寫 1 筆', [r.ok, m.lockLog.got, m.lockLog.rel, approvedN(m)], [true, 1, 1, 1]);
}
{
  const m = env();
  const r = approve(m, { dry_run: true });
  check('R5', '只檢查（dry_run）不拿鎖', [r.ok, m.lockLog.tries], [true, 0]);
}
{
  const m = env({ REQ_PEND_BLOCK: 'off' });
  sneakPending(m);
  const r = approve(m);
  check('R6', 'REQ_PEND_BLOCK=off → 不拿鎖、照舊寫入（退回舊行為）', [r.ok, m.lockLog.tries, approvedN(m)], [true, 0, 1]);
}
{
  const m = env();
  sneakPending(m, '2026-11-19');
  const r = approve(m);
  check('R7', '寫入前出現的是別天的待審單 → 照常寫入', [r.ok, approvedN(m)], [true, 1]);
}
done();
