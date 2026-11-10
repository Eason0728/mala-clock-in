/* B20、B21、B22（2026-11-10 挑錯，低嚴重度三項）。用真函式跑，名字一律假名。
 * B20：有效距離＝距離 − 誤差。兩個都是 0.1 公尺一格的數字，相減「數學上剛好等於半徑」時，小數運算會算出 20.000000000000004，
 *      被判超出範圍（需求是「超過半徑才擋」）。後端、LINE 挑店（LineHub）、打卡頁挑店（clock-line-core.js）三處同一條算式。
 * B21：遲到分鐘欄填 0.4 → 四捨五入成「遲到0分(認定)」，月表算 1 天異常。應該和填 0 一樣（主管認定不計遲到）。
 * B22：recent_hires 的「最近 N 天」拿世界標準時間的字串和台北時間的字串比，多算 8 小時。 */
'use strict';
const path = require('path');
const { make, T, iso, at, check, done } = require('./helpers/gs-sandbox');
const { buildWorld } = require('./helpers/gs-world');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };

console.log('════ B20：有效距離剛好等於半徑 ════');
{
  // 掃描：距離、誤差都是 0.1 一格，相減數學上剛好 20.0 的全部組合，三處算式都要算「在範圍內」
  const core = require(path.join(__dirname, '..', 'clock-line-core.js'));
  const m0 = make({ now: T('2026-11-10T09:00:00'), self: { roster: [ME], events: [] } });
  let total = 0, coreWrong = 0, example = null;
  for (let d10 = 200; d10 <= 1200; d10++) {
    const acc10 = d10 - 200; total++;
    if (!(core.effectiveDistance(d10 / 10, acc10 / 10) <= 20)) { coreWrong++; example = example || [d10 / 10, acc10 / 10]; }
  }
  check('B20-01', '打卡頁挑店（clock-line-core.js）：' + total + ' 組「相減剛好 20.0」沒有一組算成超過 20', coreWrong, 0);
  // 後端實打：挑幾組會出事的（32.2−12.2、45.3−25.3、111.1−91.1）＋對照
  [[32.2, 12.2, 'ok'], [45.3, 25.3, 'ok'], [111.1, 91.1, 'ok'], [32.3, 12.2, 'rejected_out_of_range'], [20.0, undefined, 'ok'], [20.1, undefined, 'rejected_out_of_range'], [120.0, 100, 'ok'], [120.1, 100, 'rejected_out_of_range']].forEach((c, i) => {
    const m = make({ now: T('2026-11-10T09:00:00'), self: { roster: [ME], events: [] } });
    const p = at(c[0]);
    const body = { key: 'K1', type: 'in', device_id: 'D1', lat: p.lat, lng: p.lng };
    if (c[1] !== undefined) body.accuracy = c[1];
    const r = m.sb.handleClock(body);
    check('B20-1' + i, '後端：距離 ' + c[0] + '、誤差 ' + (c[1] === undefined ? '沒回報' : c[1]) + ' → ' + c[2] + '（後端記的距離 ' + r.distance_m + '）', r.status, c[2]);
  });
  // LINE 挑店（LineHub.gs）
  const HUB = buildWorld({ rosters: { '': [ME] } }).hub.sb;
  const store = { code: 'gf', name: '測試店', lat: 24.7840945, lng: 121.0157448, radius_m: 20 };
  const pick = (d, acc) => { const p = at(d); const r = HUB.lineHubPickStore_({ lat: p.lat, lng: p.lng, accuracy_m: acc }, [store]); return r.status; };
  check('B20-20', 'LINE 挑店：距離 32.2、誤差 12.2 → 在範圍內', pick(32.2, 12.2), 'ok');
  check('B20-21', 'LINE 挑店：距離 32.3、誤差 12.2 → 不在範圍內', pick(32.3, 12.2), 'none');
  check('B20-22', '打卡頁挑店：距離 32.2、誤差 12.2 → 在範圍內；32.3 → 不在', [core.pickStore({ lat: at(32.2).lat, lng: at(32.2).lng, accuracy_m: 12.2 }, [store]).status, core.pickStore({ lat: at(32.3).lat, lng: at(32.3).lng, accuracy_m: 12.2 }, [store]).status], ['ok', 'none']);
}

console.log('\n════ B21：遲到分鐘欄填小數 ════');
{
  const run = (late) => {
    const m = make({ now: T('2026-11-10T23:00:00'), props: { REQ_BIND_FROM: 'off' }, self: { roster: [ME], events: [['2026-11-10T09:07:00', 'E01', 'in'], ['2026-11-10T17:22:00', 'E01', 'out']] } });
    const r = m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-10', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], late_min: late });
    return r.status_text;
  };
  check('B21-01', '對照：填 0 → 主管認定不計遲到', run(0), '主管認定不計遲到');
  check('B21-02', '填 0.4 → 和填 0 一樣（不出現「遲到0分」）', run(0.4), '主管認定不計遲到');
  check('B21-03', '填 "0.4"（文字）→ 同上', run('0.4'), '主管認定不計遲到');
  check('B21-04', '填 0.5 → 進位成遲到 1 分', run(0.5), '遲到1分(認定)');
  check('B21-05', '填 12.6 → 遲到 13 分', run(12.6), '遲到13分(認定)');
  check('B21-08', '負數（-0.4、-0.5、-3）是無效輸入 → 不覆蓋，照系統算的遲到 7 分', [run(-0.4), run('-0.5'), run(-3)], ['遲到7分', '遲到7分', '遲到7分']);
  check('B21-06', '對照：留空 → 用系統算的（遲到 7 分）', run(''), '遲到7分');
  check('B21-07', '對照：填 15 → 遲到 15 分（認定）', run(15), '遲到15分(認定)');
}

console.log('\n════ B22：recent_hires 最近 N 天 ════');
{
  const now = T('2026-11-10T21:30:00');
  const mk = (h) => ({ emp_id: 'E' + h, name: '新人' + h, key: 'K' + h, active: 'TRUE', created_at: iso(now - h * 3600000), created_by: '值班主管' });
  const m = make({ now: now, self: { roster: [mk(23), mk(25), mk(31), mk(33), mk(167), mk(169)], events: [] } });
  check('B22-01', 'days:1 → 只回 23 小時前建的', m.sb.handleRecentHires({ admin_key: 'ADM', days: 1 }).hires.map((h) => h.name), ['新人23']);
  check('B22-02', 'days:7（預設）→ 167 小時前的算、169 小時前的不算', m.sb.handleRecentHires({ admin_key: 'ADM' }).hires.map((h) => h.name), ['新人23', '新人25', '新人31', '新人33', '新人167']);
  // 凌晨（台北和世界標準時間不同一天）也對
  const now2 = T('2026-11-11T03:00:00');
  const mk2 = (h) => ({ emp_id: 'F' + h, name: '夜' + h, key: 'Q' + h, active: 'TRUE', created_at: iso(now2 - h * 3600000), created_by: '值班主管' });
  const m2 = make({ now: now2, self: { roster: [mk2(2), mk2(20), mk2(26)], events: [] } });
  check('B22-03', '台北凌晨 03:00、days:1 → 2、20 小時前的算，26 小時前的不算', m2.sb.handleRecentHires({ admin_key: 'ADM', days: 1 }).hires.map((h) => h.name), ['夜2', '夜20']);
}
done();
