/* B16（2026-11-10 挑錯）：下班打卡後「要申請加班嗎？」的提示，用打卡的實際分秒加總，超過 8 小時就提示——多 18 秒也算。
 * 2026-11-11 起的核定加嚴規定「核定沒有超過 8 小時，卻有已核准的加班單，要先作廢」。兩個規則打架：
 * 早到 5 分、晚走 5 分（參考時數 8.0）的人照提示送了 16:45–17:05 的加班單、主管也核准了，隔天主管照參考時數核定 8 小時，
 * 整天被「請先把加班單作廢」擋住。
 * 修正：加嚴生效的日子，提示的時數改用和主管頁「參考時數」一樣的算法（每段上班進位、下班捨去到 15 分鐘），
 * 預填的加班時段也落在 15 分鐘刻度上。加嚴生效以前的日子、或加嚴被關掉時，照原本的算法。
 * 用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const HERE = { lat: 24.7840945, lng: 121.0157448, accuracy: 5 };
const E = (d, hms, type) => ({ ts: d + 'T' + hms + '+08:00', emp_id: 'E01', type: type, status: 'ok' });
function hint(date, cards, props, rows) {
  const m = make({ now: T(date + 'T23:00:00'), props: props || {}, self: { roster: [ME], events: [] } });
  const evs = cards.map((c) => E(c[3] || date, c[0], c[1]));
  const last = evs[evs.length - 1];
  const h = m.sb.reqOtHint_(evs, 'E01', last.ts, rows || []);
  return h ? JSON.parse(JSON.stringify(h)) : null;
}
const S = '2026-11-12';   // 加嚴生效之後的日子（預設 2026-11-11 起）
const P = '2026-11-09';   // 生效以前

console.log('════ 一、加嚴生效的日子：照參考時數（15 分鐘刻度）════');
check('B16-01', '09:00:00–17:00:18（多 18 秒）→ 不提示', hint(S, [['09:00:00', 'in'], ['17:00:18', 'out']]), null);
check('B16-02', '08:55–17:05（早到 5 分、晚走 5 分，參考 8.0）→ 不提示', hint(S, [['08:55:00', 'in'], ['17:05:00', 'out']]), null);
check('B16-03', '08:46–13:25＋13:48–17:30（打卡加總 8.35、參考 7.75）→ 不提示', hint(S, [['08:46:00', 'in'], ['13:25:00', 'out'], ['13:48:00', 'in'], ['17:30:00', 'out']]), null);
check('B16-04', '09:00–17:14（參考 8.0）→ 不提示', hint(S, [['09:00:00', 'in'], ['17:14:00', 'out']]), null);
check('B16-05', '09:00–17:20（參考 8.25）→ 提示 8.25 小時，預填 17:00–17:15', hint(S, [['09:00:00', 'in'], ['17:20:00', 'out']]), { date: S, hours: 8.25, start: '17:00', end: '17:15' });
check('B16-06', '10:07–19:20（參考 9.0）→ 提示 9 小時，預填 18:15–19:15', hint(S, [['10:07:00', 'in'], ['19:20:00', 'out']]), { date: S, hours: 9, start: '18:15', end: '19:15' });
check('B16-07', '兩段班 10:00–14:00＋17:00–22:30（9.5）→ 預填 21:00–22:30', hint(S, [['10:00:00', 'in'], ['14:00:00', 'out'], ['17:00:00', 'in'], ['22:30:00', 'out']]), { date: S, hours: 9.5, start: '21:00', end: '22:30' });
check('B16-08', '跨夜 15:00–02:00(+1)（11 小時）→ 歸上班那天，預填 23:00–02:00', hint(S, [['15:00:00', 'in'], ['02:00:00', 'out', null, '2026-11-13']]), { date: S, hours: 11, start: '23:00', end: '02:00' });
check('B16-09', '已經有審核中的加班單 → 不提示', hint(S, [['09:00:00', 'in'], ['19:00:00', 'out']], {}, [{ emp_id: 'E01', kind: 'ot', date: S, status: 'pending' }]), null);

console.log('\n════ 二、生效以前的日子、加嚴關掉時：照原本的算法（不動）════');
check('B16-10', '11/09 09:00:00–17:00:18 → 照舊提示 8.01 小時、16:45–17:00', hint(P, [['09:00:00', 'in'], ['17:00:18', 'out']]), { date: P, hours: 8.01, start: '16:45', end: '17:00' });
check('B16-11', '11/09 10:07–19:20 → 照舊 9.22 小時、18:00–19:20', hint(P, [['10:07:00', 'in'], ['19:20:00', 'out']]), { date: P, hours: 9.22, start: '18:00', end: '19:20' });
check('B16-12', '加嚴關掉（REQ_STRICT_FROM=off）：11/12 08:55–17:05 → 照舊提示', hint(S, [['08:55:00', 'in'], ['17:05:00', 'out']], { REQ_STRICT_FROM: 'off' }), { date: S, hours: 8.17, start: '16:45', end: '17:05' });

console.log('\n════ 三、從打卡到核定走一遍（加嚴生效的日子）════');
{
  // 08:55 上班、17:05 下班：下班打卡不再提示加班 → 沒有加班單 → 主管照參考時數核定 09:00-17:00 送得出
  const m = make({ now: T(S + 'T08:55:00'), self: { roster: [ME], events: [] } }), sb = m.sb;
  const me = () => sb.readSheetAsObjects(m.self.sh.roster).rows[0];
  sb.liffPunchFor_('U1', me(), m.self, 'in', Object.assign({}, HERE), null);
  m.setNow(S + 'T17:05:00');
  const out = sb.liffPunchFor_('U1', me(), m.self, 'out', Object.assign({}, HERE), null);
  m.setNow('2026-11-13T10:00:00');
  const ap = sb.handleMgrApprove({ mgr_key: 'MK', date: S, emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
  check('B16-20', '08:55–17:05：下班打卡成功、沒有加班提示；隔天核定 09:00-17:00 送得出', [out.ok, out.ot_hint === undefined || out.ot_hint === null, ap.ok, ap.error], [true, true, true, undefined]);
}
{
  // 09:00 上班、18:35 下班：提示 1.5 小時、預填 17:00–18:30；照提示送單、主管核准；核定 09:00-18:30 送得出
  const m = make({ now: T(S + 'T09:00:00'), self: { roster: [ME], events: [] } }), sb = m.sb;
  const me = () => sb.readSheetAsObjects(m.self.sh.roster).rows[0];
  sb.liffPunchFor_('U1', me(), m.self, 'in', Object.assign({}, HERE), null);
  m.setNow(S + 'T18:35:00');
  const out = sb.liffPunchFor_('U1', me(), m.self, 'out', Object.assign({}, HERE), null);
  const h = out.ot_hint ? JSON.parse(JSON.stringify(out.ot_hint)) : null;
  check('B16-21', '09:00–18:35：提示 9.5 小時、預填 17:00–18:30', h, { date: S, hours: 9.5, start: '17:00', end: '18:30' });
  const rq = sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'ot', date: S, start: h.start, end: h.end, reason: '結帳' });
  const dec = sb.handleMgrReqDecide_({ mgr_key: 'MK', id: rq.request && rq.request.id, decision: 'approve' });
  m.setNow('2026-11-13T10:00:00');
  const ap = sb.handleMgrApprove({ mgr_key: 'MK', date: S, emp_id: 'E01', periods: [{ start: '09:00', end: '18:30' }] });
  check('B16-22', '照提示送加班單、主管核准，再核定 09:00-18:30（9.5 小時）→ 送得出', [rq.ok, dec.ok, ap.ok, ap.error, ap.message], [true, true, true, undefined, undefined]);
}
done();
