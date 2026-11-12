/* B10（2026-11-10 挑錯；2026-11-11 Eason 定：A「每一家新店的第一次都自動加入」）。
 * 原本：這個 LINE 已經在別家綁同名「恰好一家」才會自動加入；綁了兩家以上的人到第三家，畫面是空白綁定框，
 *       輸入全名回「你的 LINE 在兩個以上的單位都有綁定，請找主管協助加入」，連管理系統都沒去問。
 * 改成：已在別家綁定（一家或多家）、名字都相同、不跨品牌 → 照樣問管理系統、放行就自動加入。
 *       來源店（告訴管理系統「這個人是哪一家的誰」）的挑法：原單位（不是自動加入建的列）優先 → 最早綁 LINE 的 → 店家清單順序。
 *       總部、央廚的同仁兩個品牌都可以去：他在門市那幾列是「從總部／央廚自動加入」的，不算他的品牌。
 *       名字不一致照舊擋（name_conflict）；有一家名冊讀不到照舊請稍後再試（B28）。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）。名字一律假名。 */
'use strict';
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, done } = H;
const bound = (code) => w0.roster(code).filter((r) => String(r.line_user_id) === 'U1');
let w0;

console.log('════ 一、墨竹亭同仁已在金山、墨竹亭光復兩家，人到六張犁 ════');
{
  const w = w0 = buildWorld({ rosters: {
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1', line_bound_at: '2026-10-01T09:00:00+08:00' })],
    mztgf: [R({ emp_id: 'GF01', name: '測試一', key: 'KG01', line_user_id: 'U1', line_bound_at: '2026-10-20T09:00:00+08:00' })] } });
  const fx = w.fixAt('mztlzl', 5);
  const page = w.openPage('TOK_U1', fx);
  check('B10-01', '開頁：綁定框帶出名字，而且是「是我，加入並打卡」那條路（support_from＝最早綁的金山）',
    [page.screen, page.suggest_name, page.support_from], ['bind', '測試一', '墨竹亭 新竹金山']);
  const b = w.bind('TOK_U1', fx, '測試一');
  check('B10-02', '按下去：自動加入成功', [b.first.ok, b.first.first_support, b.first.error], [true, true, undefined]);
  check('B10-03', '管理系統被問 1 次，來源店＝金山（兩家都是原單位 → 挑最早綁 LINE 的）',
    [w.miniCalls.length, w.miniCalls[0] && w.miniCalls[0].src_store, w.miniCalls[0] && w.miniCalls[0].src_emp_id, w.miniCalls[0] && w.miniCalls[0].store_code], [1, 'mztjs', 'JS01', 'mztlzl']);
  check('B10-04', '六張犁名冊多一列、綁的是這支 LINE', [w.roster('mztlzl').length, bound('mztlzl').length], [1, 1]);
  const p = w.punch('TOK_U1', fx, 'in');
  check('B10-05', '接著打上班卡 → 成功，六張犁多一張上班卡', [p.ok, w.events('mztlzl').length], [true, 1]);
}

console.log('\n════ 二、總部同仁：金山（墨竹亭）→ 墨竹亭光復 → 小辛辣光復，每一家的第一次都自動加入 ════');
{
  const w = w0 = buildWorld({ rosters: { hq: [R({ emp_id: 'HQ-01', name: '測試總', key: 'KH01', line_user_id: 'U1', line_bound_at: '2026-09-01T09:00:00+08:00' })] } });
  const go = (code) => { const fx = w.fixAt(code, 3); const page = w.openPage('TOK_U1', fx); const b = w.bind('TOK_U1', fx, '測試總'); w.advance(11 * 60000); return { page, b }; };
  const a = go('mztjs');
  check('B10-10', '第一家（金山）：照舊自動加入', [a.page.support_from, a.b.first.ok], ['鼎兆元 總部', true]);
  const b = go('mztgf');
  check('B10-11', '第二家（墨竹亭光復）：開頁有「加入並打卡」、按下去自動加入；來源店＝總部（原單位優先）',
    [b.page.screen, b.page.support_from, b.b.first.ok, w.miniCalls.length, w.miniCalls[1] && w.miniCalls[1].src_store], ['bind', '鼎兆元 總部', true, 2, 'hq']);
  const c = go('');
  check('B10-12', '第三家（小辛辣光復）：總部同仁兩個品牌都可以，照樣自動加入；來源店＝總部',
    [c.page.screen, c.page.support_from, c.b.first.ok, w.miniCalls.length, w.miniCalls[2] && w.miniCalls[2].src_store], ['bind', '鼎兆元 總部', true, 3, 'hq']);
  check('B10-13', '三家名冊各多一列、都綁這支 LINE', [bound('mztjs').length, bound('mztgf').length, bound('').length], [1, 1, 1]);
}

console.log('\n════ 三、照舊要擋的 ════');
{
  // 跨品牌：墨竹亭同仁（金山＋墨竹亭光復）到小辛辣光復
  const w = w0 = buildWorld({ rosters: {
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })],
    mztgf: [R({ emp_id: 'GF01', name: '測試一', key: 'KG01', line_user_id: 'U1' })] } });
  const fx = w.fixAt('', 3);
  const page = w.openPage('TOK_U1', fx), b = w.bind('TOK_U1', fx, '測試一');
  check('B10-20', '墨竹亭同仁（綁兩家）到小辛辣光復 → 開頁、綁定都回 cross_brand，管理系統沒被問、名冊沒多人',
    [page.code, b.first.error, w.miniCalls.length, w.roster('').length], ['cross_brand', 'cross_brand', 0, 0]);
}
{
  // 小辛辣同仁支援過總部（總部那列是從光復自動加入的）→ 到墨竹亭金山：照舊擋
  const w = w0 = buildWorld({ rosters: { '': [R({ emp_id: 'E01', name: '測試辣', key: 'KE01', line_user_id: 'U1' })] } });
  const h = w.bind('TOK_U1', w.fixAt('hq', 3), '測試辣');
  w.advance(11 * 60000);
  const fx = w.fixAt('mztjs', 3);
  const page = w.openPage('TOK_U1', fx), b = w.bind('TOK_U1', fx, '測試辣');
  check('B10-21', '小辛辣同仁先支援總部（成功），再到墨竹亭金山 → 照舊 cross_brand',
    [h.first.ok, page.code, b.first.error, w.roster('mztjs').length], [true, 'cross_brand', 'cross_brand', 0]);
}
{
  // 名字不一致：同一支 LINE 在兩家綁的名字不同
  const w = w0 = buildWorld({ rosters: {
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })],
    mztgf: [R({ emp_id: 'GF01', name: '測試壹', key: 'KG01', line_user_id: 'U1' })] } });
  const fx = w.fixAt('mztlzl', 5);
  const page = w.openPage('TOK_U1', fx), b = w.bind('TOK_U1', fx, '測試一');
  check('B10-22', '兩家綁的名字不一樣 → 開頁不帶名字、綁定回 name_conflict，管理系統沒被問',
    [page.screen, page.suggest_name, page.support_from, b.first.error, w.miniCalls.length, w.roster('mztlzl').length], ['bind', '', '', 'name_conflict', 0, 0]);
}
{
  // 有一家讀不到（B28 不可退）
  const w = w0 = buildWorld({ rosters: {
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })],
    mztgf: [R({ emp_id: 'GF01', name: '測試一', key: 'KG01', line_user_id: 'U1' })] } });
  delete w.hub.peers.SS_mztgf;
  const b = w.bind('TOK_U1', w.fixAt('mztlzl', 5), '測試一');
  check('B10-23', '墨竹亭光復的名冊讀不到 → 請稍後再試，沒有被加入六張犁', [b.first.error, w.miniCalls.length, w.roster('mztlzl').length], ['unreachable', 0, 0]);
}
{
  // 管理系統拒絕
  const w = w0 = buildWorld({ mini: 'deny', rosters: {
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })],
    mztgf: [R({ emp_id: 'GF01', name: '測試一', key: 'KG01', line_user_id: 'U1' })] } });
  const b = w.bind('TOK_U1', w.fixAt('mztlzl', 5), '測試一');
  check('B10-24', '管理系統不放行 → 有去問（1 次）、沒加入，請找主管', [b.first.error, w.miniCalls.length, w.roster('mztlzl').length], ['support_failed', 1, 0]);
}

console.log('\n════ 四、來源店的挑法 ════');
{
  // 原單位優先：央廚（原單位，比較晚綁 LINE）＋金山（從央廚自動加入的列，比較早的時間戳）→ 來源店＝央廚
  const w = w0 = buildWorld({ rosters: { cf: [R({ emp_id: 'CF01', name: '測試廚', key: 'KC01', line_user_id: 'U1', line_bound_at: '2026-10-05T09:00:00+08:00' })] } });
  w.bind('TOK_U1', w.fixAt('mztjs', 3), '測試廚');
  const sh = w.stores.mztjs.self.sh.roster.values, col = sh[0].indexOf('line_bound_at');
  sh[1][col] = '2026-09-01T09:00:00+08:00';   // 故意讓支援列的綁定時間比原單位早
  w.advance(11 * 60000);
  const b = w.bind('TOK_U1', w.fixAt('mztgf', 3), '測試廚');
  check('B10-30', '原單位優先（不看誰先綁）：來源店＝央廚', [b.first.ok, w.miniCalls[1] && w.miniCalls[1].src_store, w.miniCalls[1] && w.miniCalls[1].src_emp_id], [true, 'cf', 'CF01']);
}
{
  // 都是原單位、綁定時間也一樣 → 照店家清單順序（穩定，不會這次挑這家、下次挑那家）
  const w = w0 = buildWorld({ rosters: {
    mztgf: [R({ emp_id: 'GF01', name: '測試一', key: 'KG01', line_user_id: 'U1' })],
    mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })] } });
  const b = w.bind('TOK_U1', w.fixAt('mztlzl', 5), '測試一');
  check('B10-31', '都沒有綁定時間 → 照店家清單順序（金山在前）', [b.first.ok, w.miniCalls[0] && w.miniCalls[0].src_store], [true, 'mztjs']);
}
{
  // 對照：只綁一家的人照舊
  const w = w0 = buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS01', name: '測試一', key: 'KJ01', line_user_id: 'U1' })] } });
  const fx = w.fixAt('mztgf', 5);
  const page = w.openPage('TOK_U1', fx), b = w.bind('TOK_U1', fx, '測試一');
  check('B10-40', '對照：只綁一家 → 照舊自動加入', [page.support_from, b.first.ok, w.miniCalls.length], ['墨竹亭 新竹金山', true, 1]);
}
{
  // 獨立審查補：小辛辣同仁借道央廚（央廚那列是從光復自動加入的，src_store＝gf）→ 不可以進墨竹亭；也不可以借道之後又同時綁回小辛辣兩邊打卡
  const w = w0 = buildWorld({ rosters: { '': [R({ emp_id: 'E01', name: '測試辣', key: 'KE01', line_user_id: 'U1' })] } });
  const c = w.bind('TOK_U1', w.fixAt('cf', 3), '測試辣');
  w.advance(11 * 60000);
  w.post('', { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: 'E01' });   // 光復主管把原單位那列的 LINE 解除（只剩央廚支援列）
  w.advance(6 * 60000);
  const fx = w.fixAt('mztjs', 3);
  const page = w.openPage('TOK_U1', fx), b = w.bind('TOK_U1', fx, '測試辣');
  w.advance(11 * 60000);
  const p = w.punch('TOK_U1', fx, 'in');
  check('B10-25', '小辛辣同仁先支援央廚（成功），再到墨竹亭金山 → cross_brand、金山名冊沒有多人、打不了卡',
    [c.first.ok, page.code, b.first.error, w.roster('mztjs').length, p.ok === true], [true, 'cross_brand', 'cross_brand', 0, false]);
  const g = w.bind('TOK_U1', w.fixAt('mztgf', 3), '測試辣');
  check('B10-26', '同一個人再到墨竹亭光復 → 一樣 cross_brand', [g.first.error, w.roster('mztgf').length], ['cross_brand', 0]);
  const back = w.bind('TOK_U1', w.fixAt('', 3), '測試辣');
  check('B10-28', '回小辛辣光復重新綁定原單位 → 綁得回來（他本來就是小辛辣的人）', back.first.ok, true, JSON.stringify(back.first));
}
{
  // 對照：總部原單位的同仁（總部那列 src_store 空白）支援過墨竹亭金山之後，照樣可以去小辛辣
  const w = w0 = buildWorld({ rosters: { hq: [R({ emp_id: 'HQ-01', name: '測試總', key: 'KH01', line_user_id: 'U1' })] } });
  const a = w.bind('TOK_U1', w.fixAt('mztjs', 3), '測試總');
  w.advance(11 * 60000);
  const b = w.bind('TOK_U1', w.fixAt('', 3), '測試總');
  check('B10-27', '對照：總部同仁 → 金山 → 小辛辣光復，兩次都自動加入', [a.first.ok, b.first.ok], [true, true]);
}
done();
