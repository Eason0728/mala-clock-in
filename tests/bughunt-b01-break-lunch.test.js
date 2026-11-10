/* B01（2026-11-10 挑錯）：央廚（12:00–13:00）、總部（14:00–15:00）規定休息不用打卡，但午休照樣打卡的同仁，
 * 2026-11-10 #96 把休息帶隔開的兩段核定一律併成一塊，只拿「重疊最多的那一條打卡段」比，
 * 結果四張卡準時也被標「早退300分、有多出的打卡段」；每日 05:00 重算還會把舊紀錄改寫成早退／遲到 300 分。
 * 修正：同仁在休息帶前後有打卡（不併用得到比較多張卡）就不併；沒打的照 #96 併成一塊。
 * 用真函式跑（整檔載入 apps-script/*.gs）。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'CF01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const CF = { RADIUS_M: 50, NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' };   // 央廚
const HQ = { RADIUS_M: 50, NO_PUNCH_BREAK_START: '14:00', NO_PUNCH_BREAK_END: '15:00' };   // 總部
const D = '2026-11-07';
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));

/** 放好打卡 → 送真的核定（關掉「要有忘打卡單」那道，只看狀態）→ 回 { 狀態, 月表異常天數 } */
function approve(config, cards, periods, props) {
  const m = make({ now: T('2026-11-10T21:00:00'), config: config, props: Object.assign({ REQ_BIND_FROM: 'off' }, props || {}),
    self: { roster: [ME], events: cards.map((c) => [D + 'T' + c[0] + ':00', 'CF01', c[1]]) } }), sb = m.sb;
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'CF01', periods: P(periods) });
  const ev = sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = sb.normCellTs(e.ts); return e; });
  const built = sb.buildMonthlySheet('2026-11', sb.readSheetAsObjects(m.self.sh.roster).rows, ev, [], sb.todayTaipeiStr(), sb.readSheetAsObjects(m.self.sh.approved).rows);
  const sum = built.rows.filter((x) => x[0] === '測試一' && typeof x[1] === 'number')[0];
  return { ok: r.ok, error: r.error, 狀態: r.status_text, 月表異常天數: sum ? sum[3] : null };
}
/** 只算「少幾張卡要幾張忘打卡單」（核定綁單開著），回 need_request 的訊息或 ok */
function bind(config, cards, periods) {
  const m = make({ now: T('2026-11-10T21:00:00'), config: config, self: { roster: [ME], events: cards.map((c) => [D + 'T' + c[0] + ':00', 'CF01', c[1]]) } });
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'CF01', periods: P(periods) });
  const n = /少了 (\d+) 張打卡/.exec(String(r.message || ''));
  return r.ok ? 'ok' : r.error + (n ? '：少 ' + n[1] + ' 張' : '：' + String(r.message || ''));
}
const CF_P = '08:00-12:00,13:00-17:00', HQ_P = '09:00-14:00,15:00-18:00';
const IN = 'in', OUT = 'out';

console.log('════ 一、午休有打卡的同仁（這次修的）════');
let r = approve(CF, [['08:00', IN], ['12:00', OUT], ['13:00', IN], ['17:00', OUT]], CF_P);
check('B01-01', '央廚：四張卡準時、核定和打卡一樣 → 正常、異常 0 天', [r.狀態, r.月表異常天數], ['正常', 0]);
r = approve(HQ, [['09:00', IN], ['14:00', OUT], ['15:00', IN], ['18:00', OUT]], HQ_P);
check('B01-02', '總部：四張卡準時 → 正常、異常 0 天', [r.狀態, r.月表異常天數], ['正常', 0]);
r = approve(CF, [['07:55', IN], ['11:55', OUT], ['13:03', IN], ['17:05', OUT]], CF_P);
check('B01-03', '央廚：午休早走 5 分、晚回 3 分 → 早退5分、遲到3分（不是遲到303分）', r.狀態, '早退5分、遲到3分');
r = approve(CF, [['08:00', IN], ['12:00', OUT], ['13:00', IN]], CF_P);
check('B01-04', '央廚：午休有打卡、最後忘打下班 → 第二段下班忘刷卡（不是早退300分）', r.狀態, '第二段下班忘刷卡');
r = approve(CF, [['12:00', OUT], ['13:00', IN], ['17:00', OUT]], CF_P);
check('B01-05', '央廚：午休有打卡、早上忘打上班 → 第一段上班忘刷卡（不是遲到300分）', r.狀態, '第一段上班忘刷卡');
r = approve(CF, [['08:00', IN], ['12:00', OUT], ['13:00', IN], ['15:00', OUT]], CF_P);
check('B01-06', '央廚：午休有打卡、下午 15:00 就走 → 早退120分（不是早退300分、有多出的打卡段）', r.狀態, '早退120分');
r = approve(CF, [['12:00', OUT], ['13:00', IN]], CF_P);
check('B01-07', '央廚：只打了午休那兩張 → 第一段上班忘刷卡、第二段下班忘刷卡', r.狀態, '第一段上班忘刷卡、第二段下班忘刷卡');

console.log('\n════ 二、午休沒打卡的同仁（#96 的做法要原封不動）════');
r = approve(CF, [['08:00', IN], ['17:00', OUT]], CF_P);
check('B01-10', '央廚：一長段 08:00–17:00 → 正常', [r.狀態, r.月表異常天數], ['正常', 0]);
r = approve(CF, [['08:00', IN]], CF_P);
check('B01-11', '央廚：只打上班卡 → 下班忘刷卡（不寫成三張）', r.狀態, '下班忘刷卡');
r = approve(CF, [['17:00', OUT]], CF_P);
check('B01-12', '央廚：只打下班卡 → 上班忘刷卡', r.狀態, '上班忘刷卡');
r = approve(CF, [], CF_P);
check('B01-13', '央廚：整天沒打 → 該段無打卡', r.狀態, '該段無打卡');
r = approve(CF, [['08:10', IN], ['17:00', OUT]], CF_P);
check('B01-14', '央廚：一長段、上班晚 10 分 → 遲到10分', r.狀態, '遲到10分');
r = approve(CF, [['08:00', IN], ['10:00', OUT]], CF_P);
check('B01-15', '央廚：10:00 就打下班、之後沒卡，主管仍核了下午 → 上午早退120分、下午兩張沒打（不是早退420分）', r.狀態, '早退120分、第二段上班無打卡、第二段下班無打卡');
r = approve(CF, [['08:00', IN], ['12:00', OUT]], CF_P);
check('B01-16', '央廚：只有 08:00–12:00 一段、主管仍核了下午 → 下午兩張沒打（不是早退300分）', r.狀態, '第二段上班無打卡、第二段下班無打卡');
r = approve(CF, [['13:00', IN], ['17:00', OUT]], CF_P);
check('B01-17', '央廚：只有 13:00–17:00 一段、主管仍核了上午 → 上午兩張沒打（不是遲到300分）', r.狀態, '第一段上班無打卡、第一段下班無打卡');
r = approve(CF, [['08:00', IN], ['15:00', OUT]], CF_P);
check('B01-18', '央廚：一長段 08:00–15:00（午休沒打、提早走）→ 早退120分', r.狀態, '早退120分');

console.log('\n════ 三、要幾張忘打卡單，和狀態寫的張數一致 ════');
check('B01-20', '午休有打卡、四張都在 → 不用單', bind(CF, [['08:00', IN], ['12:00', OUT], ['13:00', IN], ['17:00', OUT]], CF_P), 'ok');
check('B01-21', '午休有打卡、最後忘打下班 → 少 1 張', bind(CF, [['08:00', IN], ['12:00', OUT], ['13:00', IN]], CF_P), 'need_request：少 1 張');
check('B01-22', '午休沒打、只打上班卡 → 少 1 張（和修正前一樣）', bind(CF, [['08:00', IN]], CF_P), 'need_request：少 1 張');
check('B01-23', '午休沒打、一長段 → 不用單', bind(CF, [['08:00', IN], ['17:00', OUT]], CF_P), 'ok');
check('B01-24', '只有上午一段、主管仍核了下午 → 少 2 張（和狀態寫的兩張一致；沒有休息帶的店本來就是這樣）', bind(CF, [['08:00', IN], ['12:00', OUT]], CF_P), 'need_request：少 2 張');
check('B01-25', '整天沒打 → 少 2 張（和修正前一樣）', bind(CF, [], CF_P), 'need_request：少 2 張');

console.log('\n════ 四、每日 05:00 重算不會把舊紀錄改寫成早退／遲到 300 分 ════');
function recheck(cards, oldStatus) {
  const m = make({ now: T('2026-11-11T05:00:00'), config: CF, self: { roster: [ME], events: cards.map((c) => [D + 'T' + c[0] + ':00', 'CF01', c[1]]),
    approved: [[D, 'CF01', '測試一', CF_P, 8, oldStatus, '值班主管', D + 'T20:00:00+08:00', '', '']] } });
  m.sb.recheckPendingApprovalStatuses();
  const rows = m.approved(); return rows[rows.length - 1][5];
}
['該段無打卡', '下班忘刷卡', '第二段下班忘刷卡'].forEach((old, i) => {
  check('B01-3' + i, '午休有打卡、忘打最後下班；舊狀態「' + old + '」→ 重算後', recheck([['08:00', IN], ['12:00', OUT], ['13:00', IN]], old), '第二段下班忘刷卡');
});
['該段無打卡', '上班忘刷卡', '第一段上班忘刷卡'].forEach((old, i) => {
  check('B01-4' + i, '午休有打卡、忘打早上上班；舊狀態「' + old + '」→ 重算後', recheck([['12:00', OUT], ['13:00', IN], ['17:00', OUT]], old), '第一段上班忘刷卡');
});
check('B01-50', '對照：午休沒打、只有上班卡，舊狀態「下班忘刷卡」→ 重算後不變', recheck([['08:00', IN]], '下班忘刷卡'), '下班忘刷卡');
check('B01-51', '只有上午一段的舊紀錄「該段無打卡」→ 重算後不會變成早退300分', recheck([['08:00', IN], ['12:00', OUT]], '該段無打卡'), '第二段上班無打卡、第二段下班無打卡');

console.log('\n════ 五、沒有休息帶的店（光復等）不受影響 ════');
const GF = { RADIUS_M: 20 };
r = approve(GF, [['10:00', IN], ['14:00', OUT], ['16:00', IN], ['20:00', OUT]], '10:00-14:00,16:00-20:00');
check('B01-60', '光復：兩段各自打齊 → 正常', r.狀態, '正常');
r = approve(GF, [['10:00', IN], ['20:00', OUT]], '10:00-14:00,16:00-20:00');
check('B01-61', '光復：中間休息沒打（一長段）→ 第一段下班無打卡、第二段上班無打卡', r.狀態, '第一段下班無打卡、第二段上班無打卡');
done();
