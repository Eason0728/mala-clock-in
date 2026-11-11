/* B13（2026-11-10 挑錯；2026-11-11 Eason 定：A）：原單位把同仁設離職時，連帶停用「同一支 LINE」在其他店名冊上還在職的列。
 * 原本：原單位馬上打不了卡，但他支援過的別家店那一列還在職、LINE 還綁著，照樣開得了頁、打得了卡、送得出申請。
 * 做法：光復自己設離職時直接處理；別家店設離職成功後回頭通知光復（line_hub_left），由光復去停用其他店同一支 LINE 的在職列。
 *       只認 LINE 帳號完全相同；沒綁 LINE、LINE 不同、同名不同人都不動。通知失敗不影響原單位的離職結果（回應帶警告）。
 *       之後原單位恢復在職，不會自動恢復別店（維持手動）。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）。名字一律假名。 */
'use strict';
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, show, done } = H;

const HQ = () => [
  R({ emp_id: 'HQ-01', name: '測試總', key: 'KH01', line_user_id: 'U3', device_id: 'PHONE-H' }),
  R({ emp_id: 'HQ-02', name: '測試二', key: 'KH02' }),                                // 對照：沒綁 LINE
];
const JS = () => [
  R({ emp_id: 'JS08', name: '測試二', key: 'KJ08' }),                                 // 對照：同名、沒綁 LINE
  R({ emp_id: 'JS09', name: '測試總', key: 'KJ09x', active: 'FALSE', line_user_id: '' }),   // 佔位：早就離職的同名列（不影響）
  R({ emp_id: 'JS10', name: '測試金', key: 'KJ10', line_user_id: 'U2' }),             // 對照：LINE 不同
];
function scene(how, opt) {
  opt = opt || {};
  const w = buildWorld({ now: H.T('2026-11-03T09:00:00'), rosters: { hq: HQ(), mztjs: [JS()[0], JS()[2]], cf: [R({ emp_id: 'CF03', name: '測試總', key: 'KC03', line_user_id: 'U9' })] } });
  const js = w.fixAt('mztjs', 5);
  const b = w.bind('TOK_U3', js, '測試總');                       // 11/03 第一次去金山：自動加入
  w.punch('TOK_U3', js, 'in');
  w.setNow('2026-11-03T18:00:00'); w.punch('TOK_U3', js, 'out');
  w.setNow('2026-11-05T10:00:00');
  if (opt.hubDown) w.hubDown = true;
  const off = how === 'svc'
    ? w.post('hq', { action: 'svc_set_active', v: 1, svc_key: 'SVC-KEY-hq', emp_id: 'HQ-01', active: false, op_id: 'leave-1', by: '人資' })
    : w.post('hq', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'HQ-01', active: false });
  w.hubDown = false;
  return { w, js, b, off };
}
const rowOf = (w, code, pred) => w.roster(code).filter(pred)[0] || {};
const act = (r) => String(r.active).toLowerCase() === 'true';

[['mgr', '總部值班主管 mgr_set_active 設離職'], ['svc', '管理系統 svc_set_active 設離職']].forEach((x, k) => {
  console.log('\n════ ' + (k + 1) + '、' + x[1] + ' ════');
  const { w, js, b, off } = scene(x[0]);
  const T = 'B13-' + (k + 1);
  const sup = rowOf(w, 'mztjs', (r) => r.line_user_id === 'U3');
  check(T + '1', '前置：總部同仁第一次到金山自動加入；總部設離職成功', [b.first.first_support, off.ok, off.active], [true, true, false]);
  check(T + '2', '金山那一列（同一支 LINE）連帶變離職，有寫停用時間', [act(sup), /^2026-11-05T10:00:00/.test(String(sup.removed_at))], [false, true]);
  check(T + '3', '金山那一列寫明是誰、因為什麼被停用', String(sup.removed_by), '連帶停用：鼎兆元 總部 設離職（HQ-01' + (x[0] === 'svc' ? '／人資' : '／值班主管') + '）');
  check(T + '4', '設離職的回應帶連帶結果（哪家店、哪一列）', off.cascade, { ok: true, stopped: [{ store_name: '墨竹亭 新竹金山', emp_id: String(sup.emp_id), name: '測試總' }], failed: [] });
  // 對照組都不動
  check(T + '5', '對照：金山沒綁 LINE 的同名列、LINE 不同的列、央廚同名但 LINE 不同的列 → 都還在職',
    [act(rowOf(w, 'mztjs', (r) => r.emp_id === 'JS08')), act(rowOf(w, 'mztjs', (r) => r.emp_id === 'JS10')), act(rowOf(w, 'cf', (r) => r.emp_id === 'CF03'))], [true, true, true]);
  check(T + '6', '對照：總部沒綁 LINE 的另一位 → 還在職', act(rowOf(w, 'hq', (r) => r.emp_id === 'HQ-02')), true);
  // 離職隔天到金山
  w.setNow('2026-11-06T09:00:00');
  const page = w.openPage('TOK_U3', js);
  check(T + '7', '離職後到金山開頁 → 不能打卡', page.screen === 'ready', false, JSON.stringify(page));
  const n0 = w.events('mztjs').length;
  const p = w.punch('TOK_U3', js, 'in');
  check(T + '8', '離職後在金山打上班卡 → 打不進去、沒有多一筆打卡', [p.ok === true, p.error, w.events('mztjs').length - n0], [false, 'not_bound', 0]);
  const rq = w.post('mztjs', { action: 'req_submit', id_token: 'TOK_U3', kind: 'ot', date: '2026-11-06', start: '18:00', end: '20:00', reason: '測試' });
  check(T + '9', '離職後在金山送加班申請 → 送不出去', rq.ok === true, false, JSON.stringify(rq));
  const rb = w.bind('TOK_U3', js, '測試總');
  check(T + 'A', '離職後想在金山重新綁定 → 綁不上', rb.first.ok === true, false, JSON.stringify(rb.first));
  // 對照：LINE 不同的金山同仁照常
  const p2 = w.punch('TOK_U2', js, 'in');
  check(T + 'B', '對照：金山另一位同仁（LINE 不同）照常打卡', p2.ok, true);
});

console.log('\n════ 3、光復自己設離職（光復就是集中服務那一台，不必繞網路）════');
{
  const w = buildWorld({ now: H.T('2026-11-03T09:00:00'), rosters: { '': [R({ emp_id: 'E01', name: '測試一', key: 'KE01', line_user_id: 'U1' }), R({ emp_id: 'E02', name: '測試二', key: 'KE02' })],
    cf: [R({ emp_id: 'CF07', name: '測試二', key: 'KC07', line_user_id: 'U4' })] } });
  const cf = w.fixAt('cf', 5);
  const b = w.bind('TOK_U1', cf, '測試一');                       // 第一次到央廚：自動加入
  w.setNow('2026-11-05T10:00:00');
  const off = w.post('', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'E01', active: false });
  const sup = rowOf(w, 'cf', (r) => r.line_user_id === 'U1');
  check('B13-31', '光復設離職 → 央廚同一支 LINE 那一列連帶離職', [b.first.first_support, off.ok, act(sup), (off.cascade || {}).ok, ((off.cascade || {}).stopped || []).length], [true, true, false, true, 1]);
  check('B13-32', '停用原因', String(sup.removed_by), '連帶停用：小辛辣 新竹光復 設離職（E01／值班主管）');
  check('B13-33', '光復不用打網路通知自己', w.hubCalls.length, 0);
  w.setNow('2026-11-06T09:00:00');
  const p = w.punch('TOK_U1', cf, 'in');
  check('B13-34', '離職後到央廚打卡 → 打不進去', [p.ok === true, p.error], [false, 'not_bound']);
  // 光復沒綁 LINE 的人設離職：央廚同名（LINE 是別人的）不動、不做連帶
  const off2 = w.post('', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'E02', active: false });
  check('B13-35', '沒綁 LINE 的人設離職 → 不做連帶，央廚同名不同人照舊在職', [off2.ok, off2.cascade === undefined, act(rowOf(w, 'cf', (r) => r.emp_id === 'CF07'))], [true, true, true]);
  // 恢復在職：不自動恢復別店
  const on = w.post('', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'E01', active: true });
  check('B13-36', '光復恢復在職 → 央廚那一列維持離職（要手動恢復）', [on.ok, on.active, act(rowOf(w, 'cf', (r) => r.line_user_id === 'U1'))], [true, true, false]);
}

console.log('\n════ 4、通知光復失敗：原單位的離職照樣成立，回應帶警告 ════');
['mgr', 'svc'].forEach((how, k) => {
  const { w, off } = scene(how, { hubDown: true });
  const sup = rowOf(w, 'mztjs', (r) => r.line_user_id === 'U3');
  check('B13-4' + (k + 1), (how === 'mgr' ? '主管頁' : '管理系統') + '：光復連不上 → 總部照樣設成離職；金山沒被動到；回應帶警告',
    [off.ok, off.active, act(rowOf(w, 'hq', (r) => r.emp_id === 'HQ-01')), act(sup), (off.cascade || {}).ok, typeof (off.cascade || {}).message],
    [true, false, false, true, false, 'string']);
});

console.log('\n════ 5、光復那支通知不能被拿來亂停用別人 ════');
{
  const w = buildWorld({ now: H.T('2026-11-05T10:00:00'), rosters: {
    hq: [R({ emp_id: 'HQ-01', name: '測試總', key: 'KH01', line_user_id: 'U3' }),
         R({ emp_id: 'HQ-05', name: '測試舊', key: 'KH05', line_user_id: 'U5', active: 'FALSE', removed_at: '2026-09-30T18:00:00+08:00', removed_by: '值班主管' })],
    mztjs: [R({ emp_id: 'JS01', name: '測試總', key: 'KJ01', line_user_id: 'U3' }), R({ emp_id: 'JS05', name: '測試舊', key: 'KJ05', line_user_id: 'U5' })] } });
  const r1 = w.hubPost({ action: 'line_hub_left', emp_id: 'HQ-01', removed_at: '2026-11-05T10:00:00+08:00' });
  check('B13-51', '名冊上還在職的人：通知不算數，別店不動', [r1.ok, act(rowOf(w, 'mztjs', (r) => r.emp_id === 'JS01'))], [false, true]);
  const r2 = w.hubPost({ action: 'line_hub_left', emp_id: 'HQ-05', removed_at: '2026-09-30T18:00:00+08:00' });
  check('B13-52', '很久以前離職的列：通知不算數，別店不動', [r2.ok, act(rowOf(w, 'mztjs', (r) => r.emp_id === 'JS05'))], [false, true]);
  const r3 = w.hubPost({ action: 'line_hub_left', emp_id: '', removed_at: '' });
  check('B13-53', '沒帶內容 → 不處理', r3.ok, false);
}

console.log('\n════ 6、主管頁：設離職成功的那句話後面，講清楚別的單位一併停用了哪裡（manager.html 真函式）════');
{
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const html = fs.readFileSync(path.join(H.ROOT, 'manager.html'), 'utf8');
  const m = html.match(/function cascadeNote\(c\) \{[\s\S]*?\n    \}\n/);
  const sb = { escHtml: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.createContext(sb); vm.runInContext(m ? m[0] : 'function cascadeNote() { return "（找不到函式）"; }', sb);
  check('B13-61', '沒有連帶（沒綁 LINE）→ 不多說', sb.cascadeNote(undefined), '');
  check('B13-62', '有連帶 → 列出哪家店', sb.cascadeNote({ ok: true, stopped: [{ store_name: '墨竹亭 新竹金山', emp_id: 'JS11', name: '測試總' }], failed: [] }),
    '<br>他在「墨竹亭 新竹金山」的打卡帳號（同一支 LINE）也一併停用了；之後恢復在職時，那邊要另外恢復。');
  check('B13-63', '沒辦法確認 → 提醒通知總部', sb.cascadeNote({ ok: false, message: '已設為離職。但沒辦法確認他在其他單位的打卡帳號有沒有一併停用，請通知總部檢查。' }),
    '<br>⚠ 但沒辦法確認他在其他單位的打卡帳號有沒有一併停用，請通知總部檢查。');
}
console.log('\n════ 審查補：支援店收掉「支援列」，不可以反過來停用原單位 ════');
[['mgr', '金山值班主管 mgr_set_active'], ['svc', '管理系統 svc_set_active']].forEach((x) => {
  const w = buildWorld({ now: H.T('2026-11-03T09:00:00'), rosters: { hq: HQ(), mztjs: [JS()[0], JS()[2]], cf: [R({ emp_id: 'CF03', name: '測試總', key: 'KC03', line_user_id: 'U9' })] } });
  const js = w.fixAt('mztjs', 5);
  w.bind('TOK_U3', js, '測試總');
  const sup = rowOf(w, 'mztjs', (r) => r.line_user_id === 'U3');
  w.setNow('2026-11-05T10:00:00');
  const off = x[0] === 'svc'
    ? w.post('mztjs', { action: 'svc_set_active', v: 1, svc_key: 'SVC-KEY-mztjs', emp_id: String(sup.emp_id), active: false, op_id: 'leave-sup', by: '人資' })
    : w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: String(sup.emp_id), active: false });
  check('B13-7' + (x[0] === 'svc' ? '1' : '0'), x[1] + '把支援列設離職 → 只收掉金山那一列，總部原單位還在職、回應沒有連帶停用',
    [off.ok, act(rowOf(w, 'mztjs', (r) => r.emp_id === sup.emp_id)), act(rowOf(w, 'hq', (r) => r.emp_id === 'HQ-01')), !!(off.cascade && (off.cascade.stopped || []).length)], [true, false, true, false]);
  w.setNow('2026-11-06T09:00:00');
  const p = w.punch('TOK_U3', w.fixAt('hq', 5), 'in');
  check('B13-7' + (x[0] === 'svc' ? '3' : '2'), '隔天本人回總部打上班卡 → 照常打得進去', p.ok === true, true, JSON.stringify(p));
});
{
  // 光復端也要自己擋：就算支援店送來通知（舊版店、或直接呼叫），支援列也不當成連帶的來源
  const w = buildWorld({ now: H.T('2026-11-03T09:00:00'), rosters: { hq: HQ(), mztjs: [JS()[0]] } });
  const js = w.fixAt('mztjs', 5);
  w.bind('TOK_U3', js, '測試總');
  const sup = rowOf(w, 'mztjs', (r) => r.line_user_id === 'U3');
  w.setNow('2026-11-05T10:00:00');
  const at = '2026-11-05T10:00:00+08:00';
  const sh = w.stores.mztjs.self.sh.roster, hd = sh.values[0], i = sh.values.findIndex((v) => v[hd.indexOf('emp_id')] === sup.emp_id);
  sh.values[i][hd.indexOf('active')] = false; sh.values[i][hd.indexOf('removed_at')] = at; sh.values[i][hd.indexOf('removed_by')] = '值班主管';
  const r = w.hubPost({ action: 'line_hub_left', emp_id: String(sup.emp_id), removed_at: at });
  check('B13-74', '光復收到「支援列已離職」的通知 → 不停用原單位', [act(rowOf(w, 'hq', (x) => x.emp_id === 'HQ-01')), (r.stopped || []).length], [true, 0]);
}
{
  // 審查補：這個入口不帶金鑰，要有節流
  const w = buildWorld({ now: H.T('2026-11-05T10:00:00'), rosters: { hq: HQ() } });
  let tooMany = 0;
  for (let i = 0; i < 60; i++) { const r = w.hubPost({ action: 'line_hub_left', emp_id: 'X' + i, removed_at: '2026-11-05T10:00:00+08:00' }); if (r && r.error === 'too_many') tooMany++; }
  check('B13-75', '一分鐘內灌 60 次 line_hub_left → 超過上限的回 too_many（不再去開各店名冊）', tooMany > 0, true, 'too_many=' + tooMany);
}

done();
