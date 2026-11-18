/* 中間請假晚回來＝遲到（2026-11-18 Eason 選 B，不設 30 分門檻）：營運系統核定會從已核准假單／出差單的結束時間起算（核定 15:00–18:00、15:40 才打卡），
 * 打卡端「核定比打卡多」（reqOverCreditMin_）原本只把第一段開頭當遲到，這段 40 分會被當成沒打卡的多核工時、達 30 分就擋。
 * 改：第二段以後的核定時段開頭剛好是已核准假單結束（中間只隔不打卡休息帶也算）→ 到實際回來那張上班卡＝遲到，不擋；狀態照記「遲到 N 分」（Code.gs computeApprovalStatus 逐段比，本來就沒門檻）。
 * 手算預期（班表 09–18、休 12–13、已核准事假 14:00–15:00 1h；核定 09–12、13–14、15–18＝7 小時＋補休 1）：
 *   15:20 回＝遲到20｜15:29＝遲到29｜15:30＝遲到30｜15:40＝遲到40（卡差 40＞30 要原因，給了就過）｜16:30＝遲到90（要原因）
 *   二段班 09–13／18–22、事假 18:00–18:15、核定 09–13、18:15–22、18:50 回＝遲到35（要原因）
 *   跨夜 22–07、事假 01:00–02:00、核定 22–01、02–07、02:40 回＝遲到40
 *   出差 13–15、核定 09–12、15–18＋出差 2、15:40 回＝遲到40
 *   不適用：假單被退回／作廢、沒有假單（中途離開 14–15、15:40 回仍擋「核定比打卡多 40 分鐘」）、加嚴日期之前（REQ_STRICT_FROM 晚於那天＝不跑這條，本來就不擋）
 * 用真函式（gs-sandbox 整檔載入 Code.gs＋Requests.gs）。名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' };
const D = '2026-11-20', D1 = '2026-11-21';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
function env(evs, reqs, props) {
  const m = make({ now: T('2026-11-21T21:00:00'), props: Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props || {}), config: { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' },
    self: { roster: [ME], events: evs.map((e) => [e[0], 'E01', e[1]]) } });
  const sh = m.sb.reqSheet_(m.self, true);
  (reqs || []).forEach((r, i) => {
    const row = Object.assign({ id: 'R' + i, created_at: D + 'T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
    sh.appendRow(m.sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
  });
  return m;
}
function approve(m, periods, extra) {
  const r = m.sb.handleMgrApprove(Object.assign({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P(periods) }, extra || {}));
  return { ok: !!r.ok, error: r.error || '', hours: r.approved_hours === undefined ? null : r.approved_hours, status: r.status_text || '', rules: (r.probs || []).map((p) => p.rule).join(','), message: r.message || '' };
}
const LV = [{ kind: 'leave', leave_type: '事假', start: '14:00', end: '15:00', hours: 1 }];
const L1 = { leaves: [{ type: '事假', hours: 1 }] };
const day = (back) => [[D + 'T09:00:00', 'in'], [D + 'T14:00:00', 'out'], [D + 'T' + back + ':00', 'in'], [D + 'T18:00:00', 'out']];
const WHY = { diff_reason: '上班卡 15:40：主管同意' };

console.log('════ 一、中間請假晚回來：照記遲到、不擋 ════');
for (const [back, late, why] of [['15:20', 20, false], ['15:29', 29, false], ['15:30', 30, false], ['15:40', 40, true], ['16:30', 90, true]]) {
  const m = env(day(back), LV);
  const dry = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({ dry_run: true }, L1));
  if (why) {
    check('BL-' + back + 'a', back + ' 回：卡差超過 30 分 → 要選原因（同開頭遲到；不是「核定比打卡多」）', [dry.ok, dry.error, /核定比打卡多/.test(dry.message)], [false, 'need_diff_reason', false]);
    Object.assign(L1, WHY);
  }
  const r = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({}, L1));
  delete L1.diff_reason;
  check('BL-' + back, back + ' 回 → 核定 7 小時、狀態記遲到' + late + '分（不擋）', [r.ok, r.hours, /遲到(\d+)分/.exec(r.status) && +/遲到(\d+)分/.exec(r.status)[1]], [true, 7, late]);
}
let m = env(day('15:40'), LV);
let r = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({ dry_run: true }, L1, WHY));
check('BL-dry', '只檢查（dry_run）同樣放行', [r.ok, r.hours], [true, 7]);

console.log('\n════ 二、二段班、跨夜、出差 ════');
m = env([[D + 'T09:00:00', 'in'], [D + 'T13:00:00', 'out'], [D + 'T18:50:00', 'in'], [D + 'T22:00:00', 'out']], [{ kind: 'leave', leave_type: '事假', start: '18:00', end: '18:15', hours: 0.25 }]);
r = approve(m, '09:00-13:00,18:15-22:00', { leaves: [{ type: '事假', hours: 0.25 }], diff_reason: '上班卡 18:50：主管同意' });
check('BL-two', '二段班第二段開頭請到 18:15、18:50 回 → 7.75 小時、遲到35分', [r.ok, r.hours, /遲到35分/.test(r.status)], [true, 7.75, true]);
// 跨夜：班表 18:00–02:00、事假 21:00–22:00、打卡 18:00–21:00、22:40–隔天 02:00 → 核定 18–21、22–02＝7 小時、遲到 40
//（凌晨才請假再回來的跨夜班，打卡端把午夜後的卡算隔天，本來就湊不成這天的段、會要忘打卡單——跟這次無關，沒改）
m = env([[D + 'T18:00:00', 'in'], [D + 'T21:00:00', 'out'], [D + 'T22:40:00', 'in'], [D1 + 'T02:00:00', 'out']], [{ kind: 'leave', leave_type: '事假', start: '21:00', end: '22:00', hours: 1 }]);
r = approve(m, '18:00-21:00,22:00-02:00', { leaves: [{ type: '事假', hours: 1 }], diff_reason: '上班卡 22:40：主管同意' });
check('BL-night', '跨夜 18–02、事假 21–22、22:40 回 → 7 小時、遲到40分（核定跨午夜）', [r.ok, r.hours, /遲到40分/.test(r.status), r.rules], [true, 7, true, '']);
{
  // 函式層：凌晨的假單（22–07 班、事假 01:00–02:00 寫在前一天的單上）→ backs 試隔天，02:00（隔天）起那段 02:40 回＝遲到 40，不算多核
  const mm = (hm, d) => Date.parse(d + 'T' + hm + ':00+08:00');
  const ps = [{ startMs: mm('22:00', D), endMs: mm('01:00', D1) }, { startMs: mm('02:00', D1), endMs: mm('07:00', D1) }];
  const ss = [{ inMs: mm('22:00', D), outMs: mm('01:00', D1) }, { inMs: mm('02:40', D1), outMs: mm('07:00', D1) }];
  const backs = m.sb.reqLeaveBackMs_(D, [{ kind: 'leave', leave_type: '事假', start: '01:00', end: '02:00', status: 'approved' }]);
  check('BL-night2', '跨夜凌晨的假單：沒帶 backs＝40（改之前）、帶 backs＝0', [m.sb.reqOverCreditMin_(ps, ss, null, null), m.sb.reqOverCreditMin_(ps, ss, null, null, backs)], [40, 0]);
}
m = env(day('15:40').map((e, i) => (i === 1 ? [D + 'T12:00:00', 'out'] : e)), [{ kind: 'trip', leave_type: '出差', start: '13:00', end: '15:00', hours: 2 }]);
r = approve(m, '09:00-12:00,15:00-18:00', { leaves: [{ type: '出差', hours: 2 }], diff_reason: '上班卡 15:40：主管同意' });
check('BL-trip', '出差 13–15、15:40 回 → 8 小時（6＋出差 2）、遲到40分', [r.ok, r.hours, /遲到40分/.test(r.status)], [true, 8, true]);

console.log('\n════ 三、不適用：照舊擋 ════');
for (const st of ['rejected', 'void']) {
  m = env(day('15:40'), [Object.assign({ status: st }, LV[0])]);
  r = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({ dry_run: true }, WHY));
  check('BL-' + st, '假單' + st + ' → 不當遲到，照舊「核定比打卡多 40 分鐘」擋', [r.ok, r.rules.split(',').includes('over_credit'), /核定比打卡多 40 分鐘/.test(r.message)], [false, true, true]);
}
m = env(day('15:40'), []);
r = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({ dry_run: true }, WHY));
check('BL-noleave', '沒有假單（中途離開 14–15）→ 照舊擋 over_credit 40', [r.ok, /核定比打卡多 40 分鐘/.test(r.message)], [false, true]);
m = env(day('15:40'), LV, { REQ_STRICT_FROM: '2026-12-01' });
r = approve(m, '09:00-12:00,13:00-14:00,15:00-18:00', Object.assign({ dry_run: true }, L1, WHY));
check('BL-prestrict', '加嚴日期之前（REQ_STRICT_FROM 12/1）：這條不跑（本來就不比「核定比打卡多」）→ 放行', [r.ok, r.rules], [true, '']);

console.log('\n════ 四、函式層：沒帶 backs 跟改之前一樣；開頭遲到照舊 ════');
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const PP = (a, b) => ({ startMs: ms(a), endMs: ms(b) }), SS = (a, b) => ({ inMs: ms(a), outMs: ms(b) }), BW = { startMs: ms('12:00'), endMs: ms('13:00') };
const ps3 = [PP('09:00', '12:00'), PP('13:00', '14:00'), PP('15:00', '18:00')], ss2 = [SS('09:00', '14:00'), SS('15:40', '18:00')];
check('BL-f1', '沒帶 backs：40（同改之前）', m.sb.reqOverCreditMin_(ps3, ss2, BW, null), 40);
check('BL-f2', '帶 15:00 的 backs：0', m.sb.reqOverCreditMin_(ps3, ss2, BW, null, [ms('15:00')]), 0);
check('BL-f3', '主管填遲到 10：只有 10 分算遲到，剩 30 仍要有單', m.sb.reqOverCreditMin_(ps3, ss2, BW, 10, [ms('15:00')]), 30);
check('BL-f4', '假單結束 12:00（下一段 13:00 起，只隔休息帶）、13:20 回 → 0', m.sb.reqOverCreditMin_([PP('09:00', '10:00'), PP('13:00', '18:00')], [SS('09:00', '10:00'), SS('13:20', '18:00')], BW, null, [ms('12:00')]), 0);
check('BL-f5', '假單結束 11:00、下一段 13:00 起（中間 11–12 沒有假也不是休息）→ 不適用，照算 20', m.sb.reqOverCreditMin_([PP('09:00', '10:00'), PP('13:00', '18:00')], [SS('09:00', '10:00'), SS('13:20', '18:00')], BW, null, [ms('11:00')]), 20);
check('BL-f6', '開頭遲到（第一段）照舊扣掉：09:40 到 → 0', m.sb.reqOverCreditMin_([PP('09:00', '18:00')], [SS('09:40', '18:00')], BW, null, []), 0);
check('BL-f7', '回來那段開頭已有打卡蓋到（請假時段裡有打卡）→ 不另扣', m.sb.reqOverCreditMin_(ps3, [SS('09:00', '18:00')], BW, null, [ms('15:00')]), 0);
done();
