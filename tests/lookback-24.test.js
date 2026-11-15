/* 交替防呆回看 12→24 小時（2026-11-15 Eason）：第一段上班後忘打下班，隔超過 12 小時才打下一張上班卡，也要先問「已經打過上班卡」。
 * 用真函式跑（Code／Liff）。名字一律假名。 */
'use strict';
const { make, T, at, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = Object.assign({ accuracy: 10 }, at(3));
const world = (now, events) => make({ now: T(now), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events } });
const punch = (m, type, extra) => m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type }, HERE, extra || {}));

check('L0', 'CONFIG 預設 24 小時', make({}).run('CONFIG.ALTERNATION_LOOKBACK_HOURS'), 24);
{ // 08:00 上班、忘打下班，21:00（13 小時後）按上班 → 先問
  const m = world('2026-11-20T21:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const r = punch(m, 'in');
  check('L1', '13 小時後再按上班：要確認（不寫）', [r.ok, r.need_confirm, r.last && r.last.hm, m.events().length], [false, true, '08:00', 1]);
  const r2 = punch(m, 'in', { confirm_same: true });
  check('L2', '確認後照收', [r2.ok, m.events().length], [true, 2]);
  const s = m.sb.handleLiffStatus_({ id_token: 'TOK_U1' });
  check('L3', '開頁狀態的最後一張卡看得到 13 小時前那張（畫面據此跳確認框）', s.guard.last && s.guard.last.type, 'in');
}
{ // 23 小時 59 分前的上班卡：還在 24 小時內 → 問；24 小時 1 分前 → 不問
  const m = world('2026-11-21T07:59:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  check('L4', '23:59 前的上班卡仍要確認', punch(m, 'in').need_confirm, true);
  const m2 = world('2026-11-21T08:01:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  check('L5', '超過 24 小時的不算，照收', punch(m2, 'in').ok, true);
}
{ // 前一天晚上下班卡，隔天早上第一張按下班（忘打上班）→ 問「已經打過下班卡」
  const m = world('2026-11-21T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in'], ['2026-11-20T22:00:00', 'E01', 'out']]);
  const r = punch(m, 'out');
  check('L6', '昨晚下班、今天第一張按下班：要確認', [r.ok, r.need_confirm, r.last && r.last.type], [false, true, 'out']);
}
{ // 正常交替不受影響、10 分鐘鎖不變
  const m = world('2026-11-20T17:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  check('L7', '正常上班→下班照收', punch(m, 'out').ok, true);
  m.advance(5 * 60000);
  check('L8', '10 分鐘內仍鎖', /分鐘內不能打/.test(punch(m, 'in').reason || ''), true);
}
done();
