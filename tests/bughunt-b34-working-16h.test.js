/* B34（2026-11-10 挑錯；2026-11-11 Eason 定：A）：上班卡之後 16 小時內都顯示「上班中」。
 * 修正前：沒配到下班卡的上班卡，只有「日期是今天」才算上班中；跨夜班 22:00 上班的人，過了午夜還在上班，
 *   同仁頁、主管頁、月表就先把前一天標成「下班忘刷卡」、參考時數空白、異常 +1，今日時數顯示 0 小時。
 * 新規則：沒配到下班卡、而且是這個人最後一張卡的上班卡，距離現在不到 16 小時（打卡配對的上限
 *   MONTHLY_PAIR_WINDOW_HOURS）→ 不論日期都算上班中、不算異常；滿 16 小時還沒有下班卡才標「下班忘刷卡」。
 *   同仁頁最近幾天與今日時數、主管頁那天、月表、核定狀態、少幾張卡、每日 05:00 重算，全部同一口徑。
 * 用真函式跑（整檔載入 apps-script/*.gs）。名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const P = (s) => s.split(',').map((x) => ({ start: x.split('-')[0], end: x.split('-')[1] }));
const YDAY = '2026-11-10', TODAY = '2026-11-11';
const NIGHT_IN = [[YDAY + 'T22:00:00', 'E01', 'in']];
const W = (events, now, extra) => make(Object.assign({ now: T(now), self: { roster: [ME], events: events } }, extra || {}));
const evs = (m) => m.sb.readSheetAsObjects(m.self.sh.events).rows.map((e) => { e.ts = m.sb.normCellTs(e.ts); return e; });
function month(m) {
  const sb = m.sb;
  const built = sb.buildMonthlySheet('2026-11', sb.readSheetAsObjects(m.self.sh.roster).rows, evs(m), [], sb.todayTaipeiStr(), sb.readSheetAsObjects(m.self.sh.approved).rows);
  const sum = built.rows.filter((r) => r[0] === '測試一' && typeof r[1] === 'number')[0];
  const days = {};
  built.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r[0]))).forEach((r) => { days[r[0]] = { 班段: r[2], 參考: r[3], 狀態: r[5] }; });
  return { 異常天數: sum[3], days: days };
}
const recent = (m) => { const o = {}; m.sb.handleMyRecent({ key: 'K1', device_id: 'D1' }).days.forEach((d) => { o[d.date] = { notes: d.notes, reference: d.reference }; }); return o; };
const mgrDay = (m, date) => { const e = m.sb.handleMgrDay({ mgr_key: 'MK', date: date }).employees.filter((x) => x.emp_id === 'E01')[0]; return { segments: e.segments, reference: e.reference }; };
const todayHours = (m) => m.sb.handleWhoami({ key: 'K1', device_id: 'D1' }).today_hours;
const lastApproved = (m) => { const rows = m.approved(); return rows.length ? rows[rows.length - 1][5] : null; };

console.log('════ 一、跨夜班 22:00 上班，隔天 00:30 人還在上班 ════');
{
  const m = W(NIGHT_IN, TODAY + 'T00:30:00');
  check('B34-01', '同仁頁最近幾天：11/10 標上班中、參考時數照上班中的算法（已完成 0 小時，不是空白）', recent(m)[YDAY], { notes: ['上班中'], reference: 0 });
  check('B34-02', '同仁頁今日時數：上班中（22:00 起）', todayHours(m), { reference: 0, approved: 0, working_since: '22:00' });
  check('B34-03', '主管頁 11/10：22:00–？、參考時數 0（不是空白）', mgrDay(m, YDAY), { segments: [{ in: '22:00', out: null, cross: false }], reference: 0 });
  const mo = month(m);
  check('B34-04', '月表 11/10：狀態上班中', mo.days[YDAY].狀態, '上班中');
  check('B34-05', '月表異常天數 0', mo.異常天數, 0);
}
{
  // 當天白天還有一段完整的班：參考時數要留著那一段
  const m = W([[YDAY + 'T09:00:00', 'E01', 'in'], [YDAY + 'T13:00:00', 'E01', 'out']].concat(NIGHT_IN), TODAY + 'T00:30:00');
  check('B34-06', '白天 09:00–13:00 已完成、晚上 22:00 還在上班：最近幾天參考 4 小時', recent(m)[YDAY], { notes: ['上班中'], reference: 4 });
  check('B34-07', '同上：主管頁參考 4 小時', mgrDay(m, YDAY).reference, 4);
}

console.log('\n════ 二、滿 16 小時還沒有下班卡才算忘刷 ════');
{
  const m = W(NIGHT_IN, TODAY + 'T14:00:00');
  check('B34-10', '剛好 16 小時（14:00，這時打下班卡還配得成一段）→ 還是上班中', [recent(m)[YDAY].notes, month(m).異常天數], [['上班中'], 0]);
  m.setNow(TODAY + 'T14:01:00');
  check('B34-11', '超過 16 小時（14:01）→ 下班忘刷卡、參考空白', recent(m)[YDAY], { notes: ['下班忘刷卡'], reference: null });
  check('B34-12', '同上：今日時數不再顯示上班中', todayHours(m).working_since, null);
  check('B34-13', '同上：主管頁參考空白', mgrDay(m, YDAY).reference, null);
  const mo = month(m);
  check('B34-14', '同上：月表下班忘刷卡、異常 1 天', [mo.days[YDAY].狀態, mo.異常天數], ['下班忘刷卡', 1]);
}
{
  // 白班 09:00 上班忘了打下班卡：當天照舊上班中；隔天 00:30（15.5 小時）還算上班中，01:01 以後才標忘刷
  const m = W([[YDAY + 'T09:00:00', 'E01', 'in']], TODAY + 'T00:30:00');
  check('B34-15', '白班 09:00 上班沒下班卡，隔天 00:30（未滿 16 小時）→ 上班中', recent(m)[YDAY].notes, ['上班中']);
  m.setNow(TODAY + 'T01:01:00');
  check('B34-16', '同上，隔天 01:01（滿 16 小時）→ 下班忘刷卡、月表異常 1 天', [recent(m)[YDAY].notes, month(m).異常天數], [['下班忘刷卡'], 1]);
}

console.log('\n════ 三、後面又打了卡的上班卡，不是「還在上班」 ════');
{
  // 昨晚 22:00 上班沒打下班，今天 08:00 又打上班（10 小時後）→ 昨晚那張是忘刷，今天這張才是上班中
  const m = W(NIGHT_IN.concat([[TODAY + 'T08:00:00', 'E01', 'in']]), TODAY + 'T08:30:00');
  const r = recent(m);
  check('B34-20', '昨晚 22:00 那張後面已經有新的上班卡 → 昨天標下班忘刷卡', r[YDAY], { notes: ['下班忘刷卡'], reference: null });
  check('B34-21', '今天 08:00 那張 → 上班中', r[TODAY].notes, ['上班中']);
  check('B34-22', '月表：昨天下班忘刷卡、異常 1 天', [month(m).days[YDAY].狀態, month(m).異常天數], ['下班忘刷卡', 1]);
  check('B34-23', '今日時數：上班中（08:00 起）', todayHours(m).working_since, '08:00');
}
{
  const m = W(NIGHT_IN.concat([[TODAY + 'T06:05:00', 'E01', 'out']]), TODAY + 'T06:30:00');
  check('B34-24', '06:05 打了下班卡 → 配成一段 22:00–06:05(+1)，不再是上班中', [recent(m)[YDAY], todayHours(m).working_since], [{ notes: [], reference: 8 }, null]);
}

console.log('\n════ 四、核定與每日 05:00 重算 ════');
{
  const m = W(NIGHT_IN, TODAY + 'T00:30:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: YDAY, emp_id: 'E01', periods: P('22:00-06:00') });
  check('B34-30', '00:30 人還在上班，主管核定 11/10 22:00-06:00 → 送得出、狀態上班中（不寫下班忘刷卡）', [r.ok, r.status_text], [true, '上班中']);
  check('B34-31', '核定後月表：異常 0 天', month(m).異常天數, 0);
  m.setNow(TODAY + 'T05:00:00');
  const before = m.approved().length;
  m.sb.recheckPendingApprovalStatuses();
  check('B34-32', '05:00 重算時人還在上班 → 不改寫成下班忘刷卡（沒有多一列）', [m.approved().length - before, lastApproved(m)], [0, '上班中']);
  check('B34-33', '05:00 的月表：11/10 上班中、異常 0', [month(m).days[YDAY].狀態, month(m).異常天數], ['上班中、上班中', 0]);
  m.setNow(TODAY + 'T06:05:00');
  m.sb.handleClock({ key: 'K1', type: 'out', device_id: 'D1', lat: 24.7840945, lng: 121.0157448, accuracy: 5 });
  m.setNow('2026-11-12T05:00:00');
  m.sb.recheckPendingApprovalStatuses();
  check('B34-34', '06:05 打了下班卡；隔天 05:00 重算 → 正常', lastApproved(m), '正常');
}
{
  const m = W(NIGHT_IN, TODAY + 'T00:30:00');
  m.sb.handleMgrApprove({ mgr_key: 'MK', date: YDAY, emp_id: 'E01', periods: P('22:00-06:00') });
  m.setNow('2026-11-12T05:00:00');
  m.sb.recheckPendingApprovalStatuses();
  check('B34-35', '一直沒打下班卡；隔天 05:00（已滿 16 小時）重算 → 下班忘刷卡', lastApproved(m), '下班忘刷卡');
  check('B34-36', '這時月表異常 1 天', month(m).異常天數, 1);
}
{
  const m = W([[YDAY + 'T22:10:00', 'E01', 'in']], TODAY + 'T00:30:00');
  const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: YDAY, emp_id: 'E01', periods: P('22:00-06:00') });
  check('B34-37', '遲到 10 分、還在上班 → 遲到照算，另標上班中', r.status_text, '遲到10分、上班中');
}
{
  // 以前核定時被寫成下班忘刷卡的（修正前的紀錄），05:00 重算時人還在上班 → 改回上班中
  const m = W(NIGHT_IN, TODAY + 'T05:00:00', {});
  m.self.sh.approved.appendRow([YDAY, 'E01', '測試一', '22:00-06:00', 8, '下班忘刷卡', '值班主管', TODAY + 'T00:30:00+08:00', '', '']);
  m.sb.recheckPendingApprovalStatuses();
  check('B34-38', '舊紀錄寫著下班忘刷卡、05:00 人還在上班 → 重算改成上班中', lastApproved(m), '上班中');
}
{
  const ap = (now) => { const m = W(NIGHT_IN, now); const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: YDAY, emp_id: 'E01', periods: P('22:00-06:00') }); const n = /少了 (\d+) 張打卡/.exec(String(r.message || '')); return r.ok ? 'ok' : r.error + (n ? '：少 ' + n[1] + ' 張' : ''); };
  check('B34-40', '隔天 07:00（上班後 9 小時）核定 → 還在 16 小時內，不擋', ap(TODAY + 'T07:00:00'), 'ok');
  check('B34-41', '隔天 15:00（上班後 17 小時）核定 → 少 1 張，要忘打卡單', ap(TODAY + 'T15:00:00'), 'need_request：少 1 張');
}

console.log('\n════ 五、LINE 出勤紀錄的紅字 ════');
{
  const sb = make({ hub: true }).sb;
  check('B34-50', '已核定、狀態是上班中 → 不列成異常紅字', sb.lineHubDayStatus_({ approved: 8, approved_status: '上班中', notes: [] }), '');
  check('B34-51', '已核定、遲到又還在上班 → 只列遲到', sb.lineHubDayStatus_({ approved: 8, approved_status: '遲到10分、上班中', notes: [] }), '遲到10分');
  check('B34-52', '對照：下班忘刷卡照樣列', sb.lineHubDayStatus_({ approved: 8, approved_status: '下班忘刷卡', notes: [] }), '下班忘刷卡');
}

console.log('\n════ 六、舊連結打卡頁（clock.html）最近幾天的醒目小字 ════');
{
  // 從真的 clock.html 取出判斷用的函式來跑
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'clock.html'), 'utf8');
  const a = SRC.indexOf('  function approvedMarkText(');
  let fn = null;
  if (a >= 0) {
    let i = SRC.indexOf('{', a), depth = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
    const sb = { String }; vm.createContext(sb);
    vm.runInContext(SRC.slice(a, i + 1) + '\nthis.approvedMarkText = approvedMarkText;', sb);
    fn = sb.approvedMarkText;
  }
  check('B34-60', 'clock.html 有 approvedMarkText', typeof fn, 'function');
  if (fn) {
    check('B34-61', '核定狀態「上班中」→ 不列成醒目小字', fn('上班中'), '');
    check('B34-62', '「遲到10分、上班中」→ 只列遲到', fn('遲到10分、上班中'), '遲到10分');
    check('B34-63', '「正常」→ 不列；「下班忘刷卡」→ 照列', [fn('正常'), fn('下班忘刷卡'), fn(null)], ['', '下班忘刷卡', '']);
  }
  const fsx = require('fs'), px = require('path');
  const stale = ['clock-cf.html', 'clock-hq.html', 'clock-mztgf.html'].filter((f) => fsx.readFileSync(px.join(__dirname, '..', f), 'utf8').indexOf('function approvedMarkText(') === -1);
  check('B34-64', '各店打卡頁已重新產生（也有同一支函式）', stale, []);
}
done();
