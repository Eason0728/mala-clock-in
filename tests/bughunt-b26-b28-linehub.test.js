/* B26、B27、B28（2026-10 挑錯，LINE 身分三項）。用真函式跑（九店世界 tests/helpers/gs-world.js），名字一律假名。
 * B26：總部每天把央廚名冊裡總部同仁的打卡與核定抄一份到總部的表（Mirror.gs，最右一欄 mirror_src＝來源）。
 *      這位同仁的 LINE 在總部、央廚兩家都綁著時，機器人「出勤紀錄」把同一段班算兩次。
 *      修正：來源那家店也是本人綁定的店時，抄過來的那些列不再算一次。
 * B27：新增同仁的同名檢查只去頭尾空白；LINE 綁定比對姓名時去掉全部空白。「測 試一」新增得進去，之後兩位都綁不了。
 *      修正：新增時的同名檢查也去掉全部空白再比。
 * B28：跨單位綁定要查各店名冊。有一家讀不到時，原本「兩位同名」會被當成只有一位而放行。
 *      修正：有任何一家讀不到，就請同仁稍後再試（程式註解原本就是這樣寫的）。 */
'use strict';
const vm = require('vm');
const { buildWorld, R, H, cardText, SS } = require('./helpers/gs-world');
const { check, done } = H;

console.log('════ B26：鏡像過來的列不重複算 ════');
{
  const who = (code) => R({ emp_id: 'HQ-01', name: '測試總', key: 'K' + code, line_user_id: 'U3', device_id: 'D' });
  const w = buildWorld({ now: H.T('2026-11-10T09:30:00'),
    rosters: { hq: [who('hq')], cf: [who('cf')] },
    events: { cf: [['2026-11-07T08:00:00', 'HQ-01', 'in'], ['2026-11-07T16:00:00', 'HQ-01', 'out'], ['2026-11-09T08:00:00', 'HQ-01', 'in'], ['2026-11-09T16:00:00', 'HQ-01', 'out']] } });
  ['2026-11-07', '2026-11-09'].forEach((d) => w.post('cf', { action: 'mgr_approve', mgr_key: 'MK', date: d, emp_id: 'HQ-01', periods: [{ start: '08:00', end: '16:00' }] }));
  const says = (t) => w.chat('U3', t || '出勤紀錄').messages.map(cardText).join(' ');
  const cur = (s) => (/本月（11 月） \/ ([\d.]+) 小時/.exec(s) || [])[1];
  check('B26-01', '鏡像前：本月核定合計 16 小時', cur(says()), '16');
  const hq = w.stores.hq;
  vm.runInContext(H.R('apps-script/Mirror.gs'), hq.sb, { filename: 'apps-script/Mirror.gs' });
  hq.sb.MIRROR_SOURCES = [{ code: 'CF', ss_id: SS('cf'), emp_prefix: 'HQ-' }];
  const cfBook = w.stores.cf.self;
  hq.peers[SS('cf')] = { sh: cfBook.sh, getId: () => SS('cf'), getSheetByName: cfBook.getSheetByName, insertSheet: cfBook.insertSheet };
  const mr = hq.sb.mirrorCore_(true);
  check('B26-02', '總部鏡像成功、總部的表多了抄來的核定 2 列', [mr.ok, hq.self.sh.approved.values.length - 1], [true, 2]);
  w.advance(6 * 60000);
  const after = says();
  check('B26-03', '鏡像後：本月核定合計還是 16 小時（不是 32）', cur(after), '16');
  check('B26-04', '最近 7 天每天只列一次（11/9 只出現一次）', (after.match(/11\/9|11\/09/g) || []).length, 1);
  const mon = says('出勤紀錄 2026-11');
  check('B26-05', '「出勤紀錄 2026-11」整月合計 16 小時', (/11 月 \/ ([\d.]+) 小時/.exec(mon) || [])[1], '16');
  // 只綁總部一家（央廚那列解除綁定）：抄來的列要算（不然總部同仁看不到自己的出勤）
  w.post('cf', { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: 'HQ-01' });
  w.advance(6 * 60000);
  check('B26-06', '只綁總部一家時：抄來的列照算，合計 16 小時', cur(says()), '16');
}

{
  // 獨立審查補：本人在央廚綁的是另一個工號（舊的 HQ-01 那列已離職、沒綁）→ 抄到總部的 HQ-01 列要照算，不能兩邊都落空
  const w = buildWorld({ now: H.T('2026-11-10T09:30:00'),
    rosters: { hq: [R({ emp_id: 'HQ-01', name: '測試總', key: 'Khq', line_user_id: 'U3' })],
               cf: [R({ emp_id: 'HQ-01', name: '測試總', key: 'Kcf', active: 'FALSE' }), R({ emp_id: 'CF07', name: '測試總', key: 'Kcf7', line_user_id: 'U3' })] },
    events: { cf: [['2026-11-09T08:00:00', 'HQ-01', 'in'], ['2026-11-09T16:00:00', 'HQ-01', 'out']] } });
  w.post('cf', { action: 'mgr_approve', mgr_key: 'MK', date: '2026-11-09', emp_id: 'HQ-01', periods: [{ start: '08:00', end: '16:00' }] });
  const hq = w.stores.hq;
  vm.runInContext(H.R('apps-script/Mirror.gs'), hq.sb, { filename: 'apps-script/Mirror.gs' });
  hq.sb.MIRROR_SOURCES = [{ code: 'CF', ss_id: SS('cf'), emp_prefix: 'HQ-' }];
  const cfBook = w.stores.cf.self;
  hq.peers[SS('cf')] = { sh: cfBook.sh, getId: () => SS('cf'), getSheetByName: cfBook.getSheetByName, insertSheet: cfBook.insertSheet };
  hq.sb.mirrorCore_(true);
  w.advance(6 * 60000);
  const s = w.chat('U3', '出勤紀錄').messages.map(cardText).join(' ');
  check('B26-10', '央廚綁的是另一個工號：抄到總部的那一天照算，本月 8 小時', (/本月（11 月） \/ ([\d.]+) 小時/.exec(s) || [])[1], '8');
}

console.log('\n════ B27：新增同仁的同名檢查 ════');
{
  [['測 試一', '中間半形空白'], ['測　試一', '中間全形空白'], ['測試 一', '中間不換行空白']].forEach((v, i) => {
    const mk = () => buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01' })] } });
    const w = mk(), w2 = mk();
    const a = w.post('mztjs', { action: 'svc_add', v: 1, svc_key: 'SVC-KEY-mztjs', name: v[0], op_id: 'add-' + i, created_by: '人資' });
    const b = w2.post('mztjs', { action: 'mgr_add_employee', mgr_key: 'MK', name: v[0] });
    check('B27-0' + (i + 1), '已有在職「測試一」，再新增（' + v[1] + '）→ 兩個入口都回 duplicate_name、名冊沒有多一列',
      [a.error, b.error, w.roster('mztjs').length, w2.roster('mztjs').length], ['duplicate_name', 'duplicate_name', 1, 1]);
  });
  const w = buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01' })] } });
  const ok1 = w.post('mztjs', { action: 'svc_add', v: 1, svc_key: 'SVC-KEY-mztjs', name: '測試二', op_id: 'add-x', created_by: '人資' });
  const ok2 = w.post('mztjs', { action: 'mgr_add_employee', mgr_key: 'MK', name: '測 試三' });
  check('B27-10', '對照：不同名的照常新增（名字中間有空白也可以）', [ok1.ok, ok2.ok, w.roster('mztjs').length], [true, true, 3]);
  // 離職的同名不擋（照舊）
  const w3 = buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', active: 'FALSE' })] } });
  check('B27-11', '對照：同名的那位已離職 → 可以新增', w3.post('mztjs', { action: 'mgr_add_employee', mgr_key: 'MK', name: '測 試一' }).ok, true);
}

{
  // 獨立審查補：「恢復在職」的同名檢查也要去掉全部空白
  const mk = () => buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', active: 'FALSE' }), R({ emp_id: 'JS02', name: '測 試一', key: 'KJ02' })] } });
  const w = mk(), w2 = mk();
  const a = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  const b = w2.post('mztjs', { action: 'svc_set_active', v: 1, svc_key: 'SVC-KEY-mztjs', emp_id: 'JS01', active: true, op_id: 'act-1' });
  check('B27-20', '已有在職「測 試一」，把離職的「測試一」恢復在職 → 兩個入口都回 duplicate_name', [a.error, b.error], ['duplicate_name', 'duplicate_name']);
}

console.log('\n════ B28：有一家店的名冊讀不到 ════');
{
  const mk = () => buildWorld({ mini: 'deny', rosters: { hq: [R({ emp_id: 'HQ-01', name: '測試同', key: 'KH01' })], cf: [R({ emp_id: 'CF01', name: '測試同', key: 'KC01' })] } });
  let w = mk();
  check('B28-01', '對照：兩家都讀得到、各有一位同名 → name_conflict', w.bind('TOK_UX', w.fixAt('mztjs', 5), '測試同').first.error, 'name_conflict');
  w = mk(); delete w.hub.peers.SS_cf;
  const r = w.bind('TOK_UX', w.fixAt('mztjs', 5), '測試同');
  check('B28-02', '央廚讀不到 → 請稍後再試，總部那一列沒有被綁', [r.first.error, r.first.message, w.roster('hq')[0].line_user_id], ['unreachable', '有單位的系統暫時連不上，請稍後再試。', '']);
}
{
  const mk = () => buildWorld({ rosters: { cf: [R({ emp_id: 'CF01', name: '測試雙', key: 'KC01', line_user_id: 'U1' })], hq: [R({ emp_id: 'HQ-01', name: '測試雙', key: 'KH01', line_user_id: 'U1' })] } });
  const w1 = mk();
  // 2026-11-11 Eason 定（B10：A「每一家新店的第一次都自動加入」）：綁了兩家以上、名字相同的人到新店，不再回 name_conflict，
  // 改成照樣問管理系統、放行就自動加入。原本這裡預期 'name_conflict'。
  const b1 = w1.bind('TOK_U1', w1.fixAt('mztjs', 5), '測試雙');
  check('B28-10', '對照：綁了央廚＋總部兩家的人去金山，兩家都讀得到 → 自動加入金山', [b1.first.ok, b1.first.first_support, w1.roster('mztjs').length], [true, true, 1]);
  const w2 = mk(); delete w2.hub.peers.SS_hq;
  const b = w2.bind('TOK_U1', w2.fixAt('mztjs', 5), '測試雙');
  check('B28-11', '總部讀不到的那一刻 → 請稍後再試，沒有被自動加入金山', [b.first.ok === true, b.first.error, w2.roster('mztjs').length], [false, 'unreachable', 0]);
}
{
  // 對照：全部讀得到、全公司恰好一位 → 照常出確認框
  const w = buildWorld({ mini: 'deny', rosters: { hq: [R({ emp_id: 'HQ-01', name: '測試單', key: 'KH01' })] } });
  check('B28-20', '對照：都讀得到、恰好一位 → 確認框', w.bind('TOK_UX', w.fixAt('mztjs', 5), '測試單', false).first.error, 'confirm_home');
}
done();
