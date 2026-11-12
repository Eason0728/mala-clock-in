/* F10（2026-11-10 驗收；Eason 2026-11-13 定案「2：擋恢復在職」）：跨品牌只在綁定時擋。
 * 11/06 以前就綁好的舊列（例：小辛辣同仁在墨竹亭名冊有一列、綁著同一支 LINE、已停用），
 * 只要主管或管理系統把它改回在職，他就打得進對方品牌的店（打卡直送各店，不經過光復）。
 * 修正：把一列「停用 → 在職」而且那一列綁著 LINE 時，問光復這支 LINE 在別家有沒有另一個品牌的在職列；有就不准恢復。
 *       三個入口都擋：主管頁 mgr_set_active、管理系統 svc_set_active、名冊同步 sync_roster。
 *       光復連不上 → 照常恢復，回應帶提醒（恢復在職很少，不讓店長卡住）。央廚、總部兩邊都可以。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）。名字一律假名。 */
'use strict';
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, done } = H;
const act = (r) => String(r && r.active).toLowerCase() === 'true';
const rowOf = (w, code, id) => w.roster(code).filter((r) => String(r.emp_id) === id)[0];
const MSG = '這位同仁的 LINE 綁在小辛辣的門市，不能在「墨竹亭 新竹金山」恢復在職（小辛辣與墨竹亭不能互相支援打卡）；要轉品牌請先把原品牌那邊設離職。';

// 小辛辣光復在職、綁 U1；墨竹亭金山有一列舊的、已停用、也綁 U1（DZY020 的情況）
const scene = (over) => buildWorld({ now: H.T('2026-11-13T10:00:00'), rosters: Object.assign({
  '': [R({ emp_id: 'E01', name: '測試一', key: 'KE01', line_user_id: 'U1' })],
  mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1', active: 'FALSE' })],
}, over || {}) });

console.log('════ 一、對方品牌有在職的同一支 LINE：三個入口都不准恢復 ════');
{
  const w = scene();
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  check('F10-01', '金山主管頁恢復在職 → 擋（逐字）', [r.ok, r.error, r.message], [false, 'cross_brand', MSG]);
  check('F10-02', '金山那一列還是停用', act(rowOf(w, 'mztjs', 'JS01')), false);
  check('F10-03', '恢復被擋後，他在金山打卡 → 打不進去', w.punch('TOK_U1', w.fixAt('mztjs', 5), 'in').ok === true, false);
}
{
  const w = scene();
  const r = w.post('mztjs', { action: 'svc_set_active', v: 1, svc_key: 'SVC-KEY-mztjs', emp_id: 'JS01', active: true, op_id: 'on-1', by: '人資' });
  check('F10-04', '管理系統 svc_set_active 恢復在職 → 擋', [r.ok, r.error], [false, 'cross_brand']);
  check('F10-05', '金山那一列還是停用、沒有記 last_op（下次同一個 op 可以重送）', [act(rowOf(w, 'mztjs', 'JS01')), String(rowOf(w, 'mztjs', 'JS01').last_op || '')], [false, '']);
}
{
  const w = scene();
  const r = w.post('mztjs', { action: 'sync_roster', admin_key: 'ADM', employees: [{ emp_id: 'JS01', name: '測試一', active: true }] });
  check('F10-06', '名冊同步 sync_roster 帶 active:true → 這一位略過（cross_brand）、其他照常', [r.ok, JSON.stringify(r.skipped)], [true, JSON.stringify([{ emp_id: 'JS01', reason: 'cross_brand' }])]);
  check('F10-07', '金山那一列還是停用', act(rowOf(w, 'mztjs', 'JS01')), false);
}
{
  // 反方向、而且是光復自己恢復（光復就是集中服務，不用打網路）
  const w = buildWorld({ now: H.T('2026-11-13T10:00:00'), rosters: {
    mztjs: [R({ emp_id: 'JS02', name: '測試金', key: 'KJ02', line_user_id: 'U2' })],
    '': [R({ emp_id: 'E02', name: '測試金', key: 'KE02', line_user_id: 'U2', active: 'FALSE' })],
  } });
  const r = w.post('', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'E02', active: true });
  check('F10-08', '反方向：墨竹亭同仁在小辛辣光復被恢復在職 → 擋', [r.ok, r.error], [false, 'cross_brand']);
}

console.log('\n════ 二、照舊可以恢復 ════');
{
  const w = scene({ '': [R({ emp_id: 'E01', name: '測試一', key: 'KE01', line_user_id: 'U1', active: 'FALSE' })] });
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  check('F10-10', '對方品牌那一列也已停用（轉品牌）→ 恢復得了', [r.ok, act(rowOf(w, 'mztjs', 'JS01'))], [true, true]);
}
{
  const w = scene({ mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: '', active: 'FALSE' })] });
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  check('F10-11', '這一列沒綁 LINE → 恢復得了（之後綁定時 B11 會擋）', r.ok, true);
}
{
  const w = buildWorld({ now: H.T('2026-11-13T10:00:00'), rosters: {
    '': [R({ emp_id: 'E01', name: '測試一', key: 'KE01', line_user_id: 'U1' })],
    cf: [R({ emp_id: 'CF01', name: '測試一', key: 'KC01', line_user_id: 'U1', active: 'FALSE' })],
  } });
  const r = w.post('cf', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'CF01', active: true });
  check('F10-12', '小辛辣同仁在央廚恢復在職 → 可以（央廚兩邊都行）', r.ok, true);
}
{
  const w = buildWorld({ now: H.T('2026-11-13T10:00:00'), rosters: {
    mztgf: [R({ emp_id: 'GF01', name: '測試金', key: 'KG01', line_user_id: 'U2' })],
    mztjs: [R({ emp_id: 'JS02', name: '測試金', key: 'KJ02', line_user_id: 'U2', active: 'FALSE' })],
  } });
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS02', active: true });
  check('F10-13', '同品牌（墨竹亭光復在職）→ 金山恢復得了', r.ok, true);
}
{
  const w = scene(); w.hubDown = true;
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  check('F10-14', '光復連不上 → 照常恢復、回應帶提醒', [r.ok, act(rowOf(w, 'mztjs', 'JS01')), typeof r.warn === 'string' && r.warn.indexOf('沒辦法確認') >= 0], [true, true, true]);
}
{
  const w = scene();
  const r = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: false });
  check('F10-15', '設離職（本來就停用）不受影響', r.ok, true);
}
done();
