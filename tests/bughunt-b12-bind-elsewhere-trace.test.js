/* B12（2026-11-10 挑錯；2026-11-11 Eason 定：B「照舊可以在別店綁，但留痕並通知」）。
 * 情況：定位那家店的名冊沒有這個名字時，系統會查全公司名冊；恰好一位同名、還沒綁 LINE，本人按確認就綁到原單位那一列。
 *       人不必在原單位。這條路照舊不擋，但原本原單位的綁定紀錄只寫「輸入全名綁定」，看不出是在別家店綁的，主管也不會知道。
 * 改成：① 原單位的綁定紀錄記下「在哪一家店綁的」，主管頁的 LINE 綁定紀錄看得到、標得明顯。
 *       ② 綁定成功後，用打卡機器人私訊原單位的值班主管（名冊上有綁 LINE 的那幾位）：
 *          「○○（工號）的 LINE 剛在「某店」被綁定，如果不是本人請立刻解除」。送不出去不影響綁定。
 * 用真函式跑（九店世界：tests/helpers/gs-world.js）；LINE 推播只被記下來，不會真的送出。名字一律假名。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { buildWorld, R, H } = require('./helpers/gs-world');
const { check, done } = H;
const CF = '鼎兆元 中央廚房', GF = '小辛辣 新竹光復';
const pushes = (w) => w.hub.sb.__fetches.filter((f) => /\/v2\/bot\/message\/push$/.test(f.url)).map((f) => JSON.parse(f.o.payload));
/** 光復：測試一（還沒綁 LINE）＋值班主管測試長（已綁 U9，managers 分頁用工號對到他） */
function world(opts) {
  const w = buildWorld(Object.assign({ mini: 'deny', rosters: { '': [
    R({ emp_id: 'E01', name: '測試一', key: 'KE01' }),
    R({ emp_id: 'E09', name: '測試長', key: 'KE09', line_user_id: 'U9' })] } }, opts || {}));
  const mg = w.hub.self.sh.managers.values; mg[1][mg[0].indexOf('emp_id')] = 'E09';
  w.hub.sb.LINE_HUB_BOT_TOKEN = 'BOT';
  return w;
}

console.log('════ 一、沒綁過的 LINE，人在央廚，輸入光復同仁的全名 ════');
{
  const w = world();
  const b = w.bind('TOK_UX', w.fixAt('cf', 5), '測試一');
  check('B12-01', '照舊不擋：先出確認框（你是光復的測試一嗎），按確定後綁到光復那一列',
    [b.first.error, b.first.home_store_name, b.second.home_bound, w.roster('').filter((r) => r.emp_id === 'E01')[0].line_user_id], ['confirm_home', GF, true, 'UX']);
  const log = w.bindLog('');
  check('B12-02', '光復的綁定紀錄寫明是在央廚綁的', [log.length, log[0] && log[0].emp_id, log[0] && log[0].type], [1, 'E01', 'bind_name@' + CF]);
  const mb = w.post('', { action: 'mgr_line_binds', mgr_key: 'MK' });
  check('B12-03', '主管頁讀綁定紀錄：類型照舊是「輸入全名綁定」，另外帶出 from_store＝央廚，仍可解除',
    [mb.ok, mb.items[0].type, mb.items[0].from_store, mb.items[0].still_bound], [true, 'bind_name', CF, true]);
  const ps = pushes(w);
  check('B12-04', '私訊光復的值班主管 1 則（只送給主管，不送給綁定的那支 LINE）', [ps.length, ps[0] && ps[0].to], [1, 'U9']);
  check('B12-05', '訊息內容（逐字）', ps[0] && ps[0].messages[0].text,
    '【LINE 綁定提醒】\n「' + GF + '」測試一（E01）的 LINE 剛在「' + CF + '」被綁定。\n如果不是本人，請立刻到管理系統「考勤管理 → 員工名冊」的 LINE 綁定紀錄按「解除」。');
  // 主管按解除照常
  const un = w.post('', { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: 'E01' });
  check('B12-06', '主管解除照常：光復那一列的 LINE 清掉', [un.ok, w.roster('').filter((r) => r.emp_id === 'E01')[0].line_user_id], [true, '']);
}
{
  // 管理系統放行（自動加入央廚成功）也一樣留痕、通知
  const w = world({ mini: 'approve' });
  const b = w.bind('TOK_UX', w.fixAt('cf', 5), '測試一');
  check('B12-07', '管理系統放行、加入央廚成功時：光復的紀錄一樣寫明在央廚綁的、一樣通知主管',
    [b.second.ok, b.second.first_support, w.bindLog('')[0].type, pushes(w).map((p) => p.to)], [true, true, 'bind_name@' + CF, ['U9']]);
  check('B12-08', '央廚那一列是自動加入綁的（跨店同名），不帶來源店', w.bindLog('cf').map((x) => x.type), ['bind_auto']);
}

console.log('\n════ 二、在自己的店綁定：照舊，不多標、不通知 ════');
{
  const w = world();
  const b = w.bind('TOK_UX', w.fixAt('', 3), '測試一');
  const mb = w.post('', { action: 'mgr_line_binds', mgr_key: 'MK' });
  check('B12-10', '人在光復綁光復的名字 → 紀錄照舊「輸入全名綁定」、沒有來源店、不私訊主管',
    [b.first.ok, w.bindLog('')[0].type, mb.items[0].type, mb.items[0].from_store, pushes(w).length], [true, 'bind_name', 'bind_name', '', 0]);
}

console.log('\n════ 三、通知送不出去，不影響綁定 ════');
{
  const w = world(); w.hub.sb.LINE_HUB_BOT_TOKEN = '';
  const b = w.bind('TOK_UX', w.fixAt('cf', 5), '測試一');
  check('B12-20', '機器人權杖沒設 → 不送、綁定照常、紀錄照樣寫明來源店', [b.second.home_bound, pushes(w).length, w.bindLog('')[0].type], [true, 0, 'bind_name@' + CF]);
}
{
  const w = world();
  const real = w.hub.sb.UrlFetchApp.fetch;
  w.hub.sb.UrlFetchApp.fetch = (url, o) => { if (/message\/push$/.test(url)) throw new Error('連不上 LINE'); return real(url, o); };
  const b = w.bind('TOK_UX', w.fixAt('cf', 5), '測試一');
  check('B12-21', '推播那一下連不上 → 綁定照常完成', [b.second.home_bound, w.roster('').filter((r) => r.emp_id === 'E01')[0].line_user_id], [true, 'UX']);
}
{
  // 值班主管沒有綁 LINE（或主管名單對不到人）→ 沒有人可以私訊；紀錄仍然標明
  const w = world(); const rs = w.hub.self.sh.roster.values; rs[2][rs[0].indexOf('line_user_id')] = '';
  const b = w.bind('TOK_UX', w.fixAt('cf', 5), '測試一');
  check('B12-22', '值班主管沒綁 LINE → 送 0 則、綁定照常、紀錄標明來源店', [b.second.home_bound, pushes(w).length, w.bindLog('')[0].type], [true, 0, 'bind_name@' + CF]);
}

console.log('\n════ 四、來源店字樣是外面傳進來的：只留店名該有的字 ════');
{
  const w = world();
  const j = w.post('', { action: 'liff_bind', id_token: 'TOK_UX', key: 'KE01', via: 'name', via_store: '  央廚\n=HYPERLINK("x")' + '長'.repeat(60) });
  const t = w.bindLog('')[0].type;
  check('B12-30', '換行與控制字元去掉、最長 30 個字', [j.ok, /[\u0000-\u001f]/.test(t), t.indexOf('bind_name@央廚') === 0, t.length <= 'bind_name@'.length + 30], [true, false, true, true]);
  const w2 = world();
  w2.post('', { action: 'liff_bind', id_token: 'TOK_UX', key: 'KE01', via: 'auto', via_store: CF });
  const w3 = world();
  w3.post('', { action: 'liff_bind', id_token: 'TOK_UX', key: 'KE01', via_store: CF });
  check('B12-31', '只有「輸入全名」那條路才記來源店（跨店同名、打卡連結綁定照舊）', [w2.bindLog('')[0].type, w3.bindLog('')[0].type], ['bind_auto', 'bind']);
}

console.log('\n════ 五、主管頁畫面（manager.html 真的函式）════');
{
  const SRC = fs.readFileSync(path.join(H.ROOT, 'manager.html'), 'utf8');
  const extract = (name) => {
    const a = SRC.indexOf('  function ' + name + '(');
    if (a < 0) throw new Error('manager.html 找不到 ' + name);
    let i = SRC.indexOf('{', a), depth = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
    return SRC.slice(a, i + 1);
  };
  let label = null, err = '';
  try {
    const sb = { String }; vm.createContext(sb);
    vm.runInContext(extract('escHtml') + '\n' + extract('lineBindLabel') + '\nthis.lineBindLabel = lineBindLabel;', sb);
    label = sb.lineBindLabel;
  } catch (e) { err = e.message; }
  check('B12-40', '取得到畫面用的函式 lineBindLabel', [typeof label, err], ['function', '']);
  if (label) {
    check('B12-41', '在別家店綁的：寫出店名，而且用醒目的樣式', label({ type: 'bind_name', from_store: CF }),
      '輸入全名綁定・<b class="lb-away">在「' + CF + '」綁的（不是在本店）</b>');
    check('B12-42', '店名裡的符號要跳脫', label({ type: 'bind_name', from_store: '<b>x' }).indexOf('<b>x'), -1);
    check('B12-43', '在本店綁的、其他類型照舊', [label({ type: 'bind_name', from_store: '' }), label({ type: 'bind_auto' }), label({ type: 'bind' }), label({ type: 'unbind_by:測試長' })],
      ['輸入全名綁定', '跨店同名（本人確認）', '用打卡連結綁定', '由 測試長 解除']);
  }
  const built = ['manager-cf.html', 'manager-hq.html', 'manager-mztjs.html'].map((f) => fs.readFileSync(path.join(H.ROOT, f), 'utf8').indexOf('function lineBindLabel(') >= 0);
  check('B12-44', '各店的主管頁也重新產生了（央廚、總部、金山抽查）', built, [true, true, true]);
}
done();
