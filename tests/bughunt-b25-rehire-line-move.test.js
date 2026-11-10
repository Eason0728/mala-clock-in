/* B25（2026-11-10 挑錯；2026-11-11 Eason 定：A）：同一家店、同名、舊的一列已離職 → 本人用同一支 LINE 綁新的一列時，
 * 自動把 LINE 從舊列移到新列。
 * 原本：離職那一列還留著這支 LINE；復職開新的一列後，用同一支 LINE 綁定被擋「你的 LINE 帳號已經綁定這家店的另一位同仁」。
 * 修正：這支 LINE 綁在「同一家店、姓名相同（去掉全部空白後比）、已離職」的另一列 → 清掉舊列的 LINE、綁到新列，
 *       綁定紀錄多一筆看得出「由舊列（工號）移來」。舊列還在職、或姓名不同 → 照舊擋。輸入全名綁定與金鑰綁定都一樣。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）。名字一律假名。 */
'use strict';
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, done } = H;
const rowOf = (w, code, id) => w.roster(code).filter((r) => String(r.emp_id) === id)[0] || {};
const OLD = (o) => R(Object.assign({ emp_id: 'JS01', name: '測試金', key: 'KJ01', line_user_id: 'U2', line_bound_at: '2026-09-01T09:00:00+08:00', line_ok_at: '2026-09-29T09:00:00+08:00',
  active: 'FALSE', removed_at: '2026-09-30T18:00:00+08:00', removed_by: '人資' }, o || {}));

console.log('════ 一、復職成新的一列，本人輸入全名綁定（LINE 小幫手）════');
{
  const w = buildWorld({ now: H.T('2026-11-10T09:00:00'), rosters: { mztjs: [OLD(), R({ emp_id: 'JS02', name: '測 試金', key: 'KJ02' })] } });   // 新列名字中間多一個空白：去掉空白後相同
  const js = w.fixAt('mztjs', 5);
  const b = w.bind('TOK_U2', js, '測試金');
  check('B25-01', '同一支 LINE 綁新的一列 → 綁得上', [b.first.ok, b.first.error], [true, undefined], JSON.stringify(b.first));
  check('B25-02', '名冊：舊列的 LINE（含綁定時間、LINE 打卡成功記號）清掉，新列綁上',
    [rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS01').line_bound_at, rowOf(w, 'mztjs', 'JS01').line_ok_at, rowOf(w, 'mztjs', 'JS02').line_user_id], ['', '', '', 'U2']);
  check('B25-03', '舊列還是離職（只搬 LINE，不動在職狀態）', String(rowOf(w, 'mztjs', 'JS01').active).toLowerCase(), 'false');
  check('B25-04', '綁定紀錄：一筆「由舊列 JS01 移來」＋一筆照常的綁定', w.bindLog('mztjs').map((x) => [x.emp_id, x.line_user_id, x.type]),
    [['JS02', 'U2', 'moved_from:JS01'], ['JS02', 'U2', 'bind_name']]);
  const list = w.post('mztjs', { action: 'mgr_line_binds', mgr_key: 'MK' }).items.map((x) => [x.emp_id, x.type, x.still_bound]);
  check('B25-05', '主管頁的綁定紀錄：只有新列那筆綁定帶「解除」鈕', list, [['JS02', 'bind_name', true], ['JS02', 'moved_from:JS01', false]]);
  const page = w.openPage('TOK_U2', js), p = w.punch('TOK_U2', js, 'in');
  check('B25-06', '之後開頁、打卡都算在新的一列', [page.screen, p.ok, w.events('mztjs').map((e) => e.emp_id)], ['ready', true, ['JS02']]);
  // 之後主管把舊列恢復在職也不會變成兩列同一支 LINE（同名在職本來就擋）
  const back = w.post('mztjs', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'JS01', active: true });
  check('B25-07', '舊列想恢復在職 → 同名在職照舊擋', back.error, 'duplicate_name');
}

console.log('\n════ 二、用打卡連結的金鑰綁定（liff_bind 直接打那家店）════');
{
  const w = buildWorld({ now: H.T('2026-11-10T09:00:00'), rosters: { mztjs: [OLD(), R({ emp_id: 'JS02', name: '測試金', key: 'KJ02' })] } });
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-11', '金鑰綁定 → 綁得上、LINE 移到新列', [r.ok, r.emp_id, rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS02').line_user_id], [true, 'JS02', '', 'U2']);
  check('B25-12', '綁定紀錄', w.bindLog('mztjs').map((x) => [x.emp_id, x.type]), [['JS02', 'moved_from:JS01'], ['JS02', 'bind']]);
  const again = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-13', '重按一次 → 已綁定，不多記', [again.ok, again.already, w.bindLog('mztjs').length], [true, true, 2]);
}

console.log('\n════ 三、不該搬的照舊擋 ════');
{
  // 舊列還在職
  const w = buildWorld({ rosters: { mztjs: [OLD({ active: 'TRUE', removed_at: '', removed_by: '' }), R({ emp_id: 'JS02', name: '測試新', key: 'KJ02' })] } });
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-21', '舊列還在職 → 擋，名冊與紀錄不動', [r.error, rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS02').line_user_id, w.bindLog('mztjs').length], ['line_account_in_use', 'U2', '', 0]);
}
{
  // 舊列已離職但姓名不同（同一支 LINE 想綁成另一個人）
  const w = buildWorld({ rosters: { mztjs: [OLD(), R({ emp_id: 'JS02', name: '測試新', key: 'KJ02' })] } });
  const js = w.fixAt('mztjs', 5);
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  const b = w.bind('TOK_U2', js, '測試新');
  check('B25-22', '舊列已離職、姓名不同 → 金鑰綁定與輸入全名都擋，名冊不動',
    [r.error, b.first.error, b.first.message, rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS02').line_user_id],
    ['line_account_in_use', 'line_account_in_use', '你的 LINE 帳號已經綁定這家店的另一位同仁，請找主管處理。', 'U2', '']);
}
{
  // 這支 LINE 留在兩列舊帳號上：一列同名離職、一列不同名 → 不搬
  const w = buildWorld({ rosters: { mztjs: [OLD(), OLD({ emp_id: 'JS00', name: '測試別', key: 'KJ00' }), R({ emp_id: 'JS02', name: '測試金', key: 'KJ02' })] } });
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-23', '同一支 LINE 還留在另一位不同名的舊列 → 擋，全部不動', [r.error, rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS00').line_user_id, rowOf(w, 'mztjs', 'JS02').line_user_id], ['line_account_in_use', 'U2', 'U2', '']);
}
{
  // 新列已經綁了別人的 LINE → 照舊擋（不因為要搬就蓋掉）
  const w = buildWorld({ rosters: { mztjs: [OLD(), R({ emp_id: 'JS02', name: '測試金', key: 'KJ02', line_user_id: 'U7' })] } });
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-24', '新列已綁別的 LINE → 擋，舊列的 LINE 不清', [r.error, rowOf(w, 'mztjs', 'JS01').line_user_id, rowOf(w, 'mztjs', 'JS02').line_user_id], ['already_bound_other_user', 'U2', 'U7']);
}
{
  // 別家店同名離職列不相干：只看同一家店
  const w = buildWorld({ rosters: { mztgf: [OLD({ emp_id: 'GF01' })], mztjs: [R({ emp_id: 'JS02', name: '測試金', key: 'KJ02' })] } });
  const r = w.post('mztjs', { action: 'liff_bind', id_token: 'TOK_U2', key: 'KJ02' });
  check('B25-25', '別家店的離職列不動（各店各自的名冊）', [r.ok, rowOf(w, 'mztgf', 'GF01').line_user_id, w.bindLog('mztjs').map((x) => x.type)], [true, 'U2', ['bind']]);
}

console.log('\n════ 四、主管頁的綁定紀錄：看得出是從哪一列移來的（manager.html 真的那一行）════');
{
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const html = fs.readFileSync(path.join(H.ROOT, 'manager.html'), 'utf8');
  // 整合後主管頁只有一支 lineBindLabel(it)（B12 的來源店標示與 B25 的移轉字樣共用），這裡包一層沿用原本的檢查
  const m = html.match(/  function lineBindLabel\(it\) \{[\s\S]*?\n  \}\n/);
  const sb = { escHtml: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
  vm.createContext(sb); vm.runInContext((m ? m[0] : 'function lineBindLabel(it) { return it.type; }') + '\nfunction bindTypeLabel(t) { return lineBindLabel({ type: t }); }', sb);
  check('B25-31', '「由舊列移來」顯示成白話', sb.bindTypeLabel('moved_from:JS01'), '同一支 LINE 由已離職的舊帳號（JS01）移過來');
  check('B25-32', '原本的字樣照舊', [sb.bindTypeLabel('bind_name'), sb.bindTypeLabel('unbind_by:測試主管'), sb.bindTypeLabel('code_issued')], ['輸入全名綁定', '由 測試主管 解除', 'code_issued']);
}
done();
