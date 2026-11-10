/* B11（2026-11-10 挑錯）：小辛辣同仁不能在墨竹亭門市打卡，反過來也是（2026-11-06）；央廚、總部兩邊都可以。
 * 但品牌只在「這家店名冊沒有這個名字」時才檢查。那家店的名冊剛好有一列同名、還沒綁 LINE 的在職同仁時，
 * 已經在另一個品牌綁定的人照樣看得到綁定畫面、綁得上去、打得了卡。
 * 修正：這個 LINE 已經在另一個品牌的門市綁定，就不能在這家店綁定或打卡，不管名冊有沒有同名的列。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）。名字一律假名。 */
'use strict';
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, show, done } = H;
const SXL = R({ emp_id: 'E01', name: '測試一', key: 'KE01', line_user_id: 'U1', device_id: 'PHONE-A' });      // 小辛辣光復，已綁 LINE
const MZT = R({ emp_id: 'JS01', name: '測試金', key: 'KJ01', line_user_id: 'U2' });                              // 墨竹亭金山，已綁 LINE

console.log('════ 一、對方品牌那家店的名冊有同名、還沒綁 LINE 的在職列：也要擋 ════');
{
  const w = buildWorld({ rosters: { '': [SXL], mztjs: [MZT, R({ emp_id: 'JS02', name: '測試一', key: 'KJ02' })] } });
  const js = w.fixAt('mztjs', 5);
  const page = w.openPage('TOK_U1', js);
  check('B11-01', '小辛辣同仁在墨竹亭金山開頁 → 擋（不出現綁定畫面）', [page.screen, page.code], ['fail', 'cross_brand']);
  check('B11-02', '畫面上的原因與提示（逐字）', [page.reason, page.hint], ['你是小辛辣的同仁，不能在「墨竹亭 新竹金山」打卡', '小辛辣與墨竹亭不能互相支援打卡；有問題請找店長']);
  const b = w.bind('TOK_U1', js, '測試一');
  check('B11-03', '直接送綁定 → 擋（逐字）', [b.first.ok, b.first.error, b.first.message],
    [false, 'cross_brand', '你是小辛辣的同仁，不能在「墨竹亭 新竹金山」打卡（小辛辣與墨竹亭不能互相支援打卡）；有問題請找店長。']);
  const p = w.punch('TOK_U1', js, 'in');
  check('B11-04', '打上班卡 → 打不進去，金山名冊那一列沒有被綁、沒有打卡紀錄',
    [p.ok === true, w.roster('mztjs').filter((r) => r.emp_id === 'JS02')[0].line_user_id, w.events('mztjs').length], [false, '', 0]);
}
{
  const w = buildWorld({ rosters: { '': [SXL, R({ emp_id: 'E02', name: '測試金', key: 'KE02' })], mztjs: [MZT] } });
  const gf = w.fixAt('', 3);
  const page = w.openPage('TOK_U2', gf);
  const b = w.bind('TOK_U2', gf, '測試金');
  const p = w.punch('TOK_U2', gf, 'in');
  check('B11-05', '反方向：墨竹亭同仁在小辛辣光復（光復名冊有同名未綁列）→ 開頁、綁定、打卡都擋',
    [page.screen, page.code, b.first.error, p.ok === true], ['fail', 'cross_brand', 'cross_brand', false]);
}

console.log('\n════ 二、原本就可以的照舊 ════');
{
  // 同品牌：墨竹亭金山的同仁到墨竹亭光復，那家名冊有同名未綁列 → 照舊帶出名字請本人確認、綁得上
  const w = buildWorld({ rosters: { mztjs: [MZT], mztgf: [R({ emp_id: 'GF09', name: '測試金', key: 'KG09' })] } });
  const fx = w.fixAt('mztgf', 5);
  const page = w.openPage('TOK_U2', fx);
  const b = w.bind('TOK_U2', fx, '測試金');
  check('B11-10', '同品牌跨店（名冊有同名未綁列）→ 綁定畫面帶出名字、綁得上', [page.screen, page.suggest_name, b.first.ok], ['bind', '測試金', true]);
}
{
  // 央廚、總部兩邊都可以：小辛辣同仁到央廚（央廚名冊有同名未綁列）
  const w = buildWorld({ rosters: { '': [SXL], cf: [R({ emp_id: 'CF05', name: '測試一', key: 'KC05' })] } });
  const fx = w.fixAt('cf', 5);
  const page = w.openPage('TOK_U1', fx);
  const b = w.bind('TOK_U1', fx, '測試一');
  check('B11-11', '小辛辣同仁到央廚（不分品牌）→ 綁得上', [page.screen, b.first.ok], ['bind', true]);
  // 央廚的同仁到墨竹亭金山（名冊有同名未綁列）
  const w2 = buildWorld({ rosters: { cf: [R({ emp_id: 'CF01', name: '測試廚', key: 'KC01', line_user_id: 'U3' })], mztjs: [R({ emp_id: 'JS03', name: '測試廚', key: 'KJ03' })] } });
  const b2 = w2.bind('TOK_U3', w2.fixAt('mztjs', 5), '測試廚');
  check('B11-12', '央廚同仁到墨竹亭金山 → 綁得上', b2.first.ok, true);
}
{
  // 還沒綁過任何一家的新同仁：照舊用姓名＋定位綁定
  const w = buildWorld({ rosters: { mztjs: [R({ emp_id: 'JS04', name: '測試新', key: 'KJ04' })] } });
  const b = w.bind('TOK_U4', w.fixAt('mztjs', 5), '測試新');
  check('B11-13', '沒綁過的新同仁在自己的店輸入全名 → 綁得上', b.first.ok, true);
}
{
  // 已經在這家店綁好的人照舊打卡
  const w = buildWorld({ rosters: { mztjs: [MZT] } });
  const p = w.punch('TOK_U2', w.fixAt('mztjs', 5), 'in');
  check('B11-14', '本店同仁照舊打得了卡', p.ok, true);
}
done();
