/* B05（2026-11-10 挑錯）：晚班忘打上班卡、只有隔天凌晨的下班卡（例：11/9 01:00 下班）。
 * 2026-11-10 起這張卡歸前一天（凌晨 06:00 前的孤單下班卡＝前一天的跨夜班）：核定狀態、月表都照這樣算，
 * 但主管頁（mgr_day）判斷「這個人那天有沒有打卡」只看日期等於那天的打卡，結果 11/8、11/9 兩天都看不到這張卡。
 * 修正：有歸到那天的凌晨下班卡，也算那天有打卡。用真函式跑。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const A = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const B = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
const C = { emp_id: 'E03', name: '測試三', key: 'K3', device_id: 'D3', active: 'TRUE', line_user_id: 'U3' };
const D = '2026-11-08', D1 = '2026-11-09';
const m = make({ now: T('2026-11-10T10:00:00'), self: { roster: [A, B, C], events: [
  [D1 + 'T01:00:00', 'E01', 'out'],                                   // 測試一：11/8 晚班忘打上班，只有 11/9 01:00 下班
  [D + 'T22:00:00', 'E02', 'in'], [D1 + 'T02:00:00', 'E02', 'out'],   // 測試二：正常跨夜班 22:00–02:00
  // 測試三：兩天都沒打卡
] } });
const day = (date) => { const r = m.sb.handleMgrDay({ mgr_key: 'MK', date: date }); const o = {}; r.employees.forEach((e) => { o[e.emp_id] = e; }); return { r: r, by: o }; };
const segText = (e) => (e.segments || []).map((s) => (s.in || '？') + '–' + (s.out || '？') + (s.cross ? '(+1)' : '')).join('、');

const d8 = day(D), d9 = day(D1);
check('B05-01', '11/8 的主管頁：測試一看得到那張凌晨下班卡（？–01:00，標隔天）', segText(d8.by.E01), '？–01:00(+1)');
check('B05-02', '11/8：只有下班卡＝參考時數留白', d8.by.E01.reference === null || d8.by.E01.reference === '', true);
check('B05-03', '11/9 的主管頁：那張卡不重複出現在 11/9', segText(d9.by.E01), '');
check('B05-04', '對照：正常跨夜班在 11/8 顯示 22:00–02:00(+1)、11/9 不重複', [segText(d8.by.E02), segText(d9.by.E02)], ['22:00–02:00(+1)', '']);
check('B05-05', '對照：兩天都沒打卡的人照舊沒有打卡段', [segText(d8.by.E03), segText(d9.by.E03)], ['', '']);
check('B05-06', '11/8 的排序：有卡的兩位排在沒打卡的前面', d8.r.employees.map((e) => e.emp_id).indexOf('E03'), 2);
// 核定與月表本來就把這張卡算在 11/8（這次沒動），確認三邊一致
const ap = m.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [{ start: '17:00', end: '01:00' }] });
show('B05-07', '核定 11/8 17:00-01:00（要補上班卡的單，這裡只看訊息）', { ok: ap.ok, error: ap.error, message: String(ap.message || '').slice(0, 40) });
check('B05-08', '核定算的是少 1 張（上班卡），不是少 2 張', /少了 1 張打卡/.test(String(ap.message || '')), true);
done();
