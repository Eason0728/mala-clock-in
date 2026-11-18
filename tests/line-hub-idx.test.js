/* 申請頁第一次開頁加快（2026-11-18 Eason：「第一次開申請頁向光復讀取要 13 到 14 秒」）：光復共用對照表 lhix。
 * 用九店世界（真函式＋薪資模組）跑：
 *   A. 結果完全一樣：開頁資料（店別、預設店、假別）與額度，用對照表 vs 原本逐店讀，四種同仁（綁兩家、綁一家、離職 60 天內、沒綁）逐欄相同。
 *   B. 讀表次數（推估秒數用）：第一次開頁 init＋quota 兩支各讀幾次表、開幾次別店試算表；mini 先建好（line_hub_warm）後又是幾次。
 *   C. 新鮮度保護：對照表沒有的人（剛在店家那邊綁好）照原本逐店讀；光復這邊綁定（lineHubForget_）清掉對照表；
 *      店家主管解除綁定最多 5 分鐘後才反映（同原本），期間送那家店的單由那家店自己擋 not_bound。
 *   D. 讀不到的店：不存對照表、結果照原本；warm 回 unreadable。
 *   E. line_hub_warm：不回任何人的資料、200 秒內不重建、正在建的不重複建；切段存取（人很多也存得下、太大就不存但結果照樣對）。
 *   F. 這兩支（line_hub_warm、line_hub_req_init）不記進考勤變動通知（不會讓 mini 重讀光復當天考勤）。 */
'use strict';
const { buildWorld, R, H, SS } = require('./helpers/gs-world');
const { check, show, done, T } = H;

const NOW = T('2026-11-18T10:00:00');
const PAYSTORES = [
  { code: 'SSLGF', name: '小辛辣 新竹光復', clock_ss_id: '', active: 'true', sort: 1, brand: 'sxl' },
  { code: 'MZTJS', name: '墨竹亭 金山', clock_ss_id: SS('mztjs'), active: 'true', sort: 2, brand: 'mzt' },
  { code: 'CF', name: '央廚', clock_ss_id: SS('cf'), active: 'true', sort: 3, brand: '' },
  { code: 'HQ', name: '總部', clock_ss_id: SS('hq'), active: 'true', sort: 4, brand: '' },
];
const LEFT_AT = '2026-11-01T10:00:00+08:00';
function world() {
  const w = buildWorld({ now: NOW, payroll: true, payStores: PAYSTORES,
    rosters: {
      '': [R({ emp_id: 'E01', name: '測試甲', key: 'K1', line_user_id: 'U1' }), R({ emp_id: 'E02', name: '測試乙', key: 'K2' })],
      mztjs: [R({ emp_id: 'J01', name: '測試甲', key: 'KJ1', line_user_id: 'U1' })],
      cf: [R({ emp_id: 'C01', name: '測試丙', key: 'KC1', line_user_id: 'U2' })],
      hq: [R({ emp_id: 'H01', name: '測試丁', key: 'KH1', line_user_id: 'U3', active: 'FALSE', removed_at: LEFT_AT })],
      mztgf: [R({ emp_id: 'G01', name: '測試戊', key: 'KG1' })],
    },
    events: { mztjs: [['2026-11-17T09:00:00', 'J01', 'in']], '': [['2026-11-16T09:00:00', 'E01', 'in']] } });
  // 計數：光復讀表（readSheetAsObjects、讀 events 尾端）、開別店試算表
  const hub = w.hub, cnt = { read: 0, tail: 0, open: 0 };
  const rso = hub.sb.readSheetAsObjects, tail = hub.sb.lineHubTailRows_, ob = hub.sb.SpreadsheetApp.openById;
  hub.sb.readSheetAsObjects = function (sh) { cnt.read++; return rso(sh); };
  hub.sb.lineHubTailRows_ = function (a, b, c) { cnt.tail++; return tail(a, b, c); };
  hub.sb.SpreadsheetApp.openById = function (id) { if (id !== 'SELF') cnt.open++; return ob(id); };
  w.cnt = cnt;
  w.reset = () => { cnt.read = 0; cnt.tail = 0; cnt.open = 0; };
  w.clearCache = () => { Object.keys(hub.cache).forEach((k) => delete hub.cache[k]); };
  w.idxOff = () => { hub.run('lineHubIdx_ = function () { return null; };'); };   // 「改前」：對照表永遠不能用＝原本逐店讀
  return w;
}
const TOK = (u) => 'TOK_' + u;
const initOf = (w, u) => w.hubPost({ action: 'line_hub_req_init', id_token: TOK(u), lite: true });
const quotaOf = (w, u) => w.hubPost({ action: 'line_hub_req_quota', id_token: TOK(u) });
const pick = (r) => (r.ok ? { stores: r.stores, punch_store: r.punch_store, leave_types: r.leave_types } : r);

console.log('════ A. 用對照表 vs 原本逐店讀：結果逐欄相同 ════');
{
  const neu = world(), old = world(); old.idxOff();
  ['U1', 'U2', 'U3', 'U4'].forEach((u) => {
    neu.clearCache(); old.clearCache();
    check('A-init-' + u, u + ' 開頁資料一樣', pick(initOf(neu, u)), pick(initOf(old, u)));
    neu.clearCache(); old.clearCache();
    check('A-quota-' + u, u + ' 額度一樣', quotaOf(neu, u), quotaOf(old, u));
    // 對照表已經熱的（別人先查過）再查一次也一樣
    check('A-warm-' + u, u + ' 對照表熱的時候開頁資料也一樣', pick(initOf(neu, u)), pick(initOf(old, u)));
  });
  const r = initOf(neu, 'U1');
  check('A-10', 'U1 綁光復＋金山、預設店＝最近一張卡（金山 11/17）', [r.stores.map((s) => s.code), r.punch_store], [['', 'mztjs'], 'mztjs']);
  check('A-11', '沒綁的人一樣回 not_bound', initOf(neu, 'U4').error, 'not_bound');
  check('A-12', '離職 60 天內：開頁資料不算（在職才算）→ not_bound，跟原本一樣', initOf(neu, 'U3').error, 'not_bound');
  const pk = neu.hub.run('JSON.stringify(lineHubPayPickFresh_("U3"))');
  const pkOld = old.hub.run('JSON.stringify(lineHubPayPickFresh_("U3"))');
  check('A-13', '找薪資那家（離職 60 天內也找得到）：店別、工號、姓名一樣', [JSON.parse(pk).store, JSON.parse(pk).me.emp_id, JSON.parse(pk).me.name],
    [JSON.parse(pkOld).store, JSON.parse(pkOld).me.emp_id, JSON.parse(pkOld).me.name]);
}

console.log('════ B. 讀表次數（第一次開頁：同時打 init＋quota）════');
{
  const run = (w) => { w.clearCache(); w.reset(); initOf(w, 'U1'); quotaOf(w, 'U1'); return Object.assign({}, w.cnt); };
  const old = world(); old.idxOff();
  const neu = world();
  const a = run(old), b = run(neu);
  // 對照表先由 mini 建好（line_hub_warm），之後第一次開頁
  const warm = world(); warm.clearCache(); warm.hubPost({ action: 'line_hub_warm' }); warm.reset(); initOf(warm, 'U1'); quotaOf(warm, 'U1');
  const c = Object.assign({}, warm.cnt);
  show('B-01', '改前（逐店讀）init＋quota 讀表／開別店試算表次數', a);
  show('B-02', '改後、對照表冷的（這次自己建）', b);
  show('B-03', '改後、mini 先建好對照表', c);
  check('B-04', '改後讀表次數比改前少', b.read < a.read, true);
  check('B-05', 'mini 先建好後：開頁不再開任何一家店的名冊試算表讀名冊（開別店試算表只剩讀最近一張卡、額度要的那幾家）', c.open < a.open && c.read < b.read, true);
  // 只看 init 一支（同仁看到表單要等的就是它）
  const one = (w) => { w.reset(); initOf(w, 'U1'); return Object.assign({}, w.cnt); };
  old.clearCache(); const ia = one(old);
  const w2 = world(); w2.clearCache(); w2.hubPost({ action: 'line_hub_warm' }); const ib = one(w2);
  show('B-06', '只看開頁資料 init：改前 vs mini 先建好', { before: ia, after: ib });
  check('B-07', 'init 讀表：改前要讀 9 家名冊＋薪資 4 家名冊（≥13 次），mini 先建好後只剩假別、薪資店別、主檔（≤3 次）', [ia.read >= 13, ib.read <= 3], [true, true]);
}

console.log('════ C. 新鮮度保護 ════');
{
  const w = world(); w.clearCache();
  w.hubPost({ action: 'line_hub_warm' });
  // 店家那邊直接綁好（不經過光復）：對照表裡沒有 U5 → 照原本逐店讀，第一次就找得到
  const mg = w.stores.mztgf.self.sh.roster, col = mg.values[0].indexOf('line_user_id');
  mg.values[1][col] = 'U5';
  const r = initOf(w, 'U5');
  check('C-01', '對照表沒有的人（剛在店家綁好）→ 照原本逐店讀，第一次就找到墨竹亭光復', r.ok && r.stores.map((s) => s.code), ['mztgf']);
  // 店家主管解除綁定（不經過光復）：5 分鐘內對照表還在（同原本每人 5 分鐘快取）；送那家店的單，那家店自己擋
  w.post('cf', { action: 'mgr_line_unbind', mgr_key: 'MK', emp_id: 'C01' });
  const r2 = initOf(w, 'U2');
  check('C-02', '店家解綁後 5 分鐘內：開頁資料可能還列著央廚（已知、同原本）', r2.ok && r2.stores.map((s) => s.code), ['cf']);
  const sub = w.post('cf', { action: 'req_submit', id_token: TOK('U2'), kind: 'leave', date: '2026-11-20', leave_type: '事假', hours: 8, reason: '測' });
  check('C-03', '這時候送到央廚的單：央廚後端自己擋（沒綁定）→ 不會送出錯的單', [sub.ok, sub.error], [false, 'not_bound']);
  w.advance(6 * 60000);
  check('C-04', '6 分鐘後：對照表過期重建 → 不再列央廚（not_bound）', initOf(w, 'U2').error, 'not_bound');
  // 光復這邊的綁定流程會呼叫 lineHubForget_ → 對照表清掉
  w.hubPost({ action: 'line_hub_warm' });
  check('C-05', 'warm 後目錄鍵在', !!w.hub.cache.lhix, true);
  w.hub.run('lineHubForget_("U1")');
  check('C-06', 'lineHubForget_（綁定、解綁、離職連帶都會呼叫）→ 對照表目錄鍵清掉', !!w.hub.cache.lhix, false);
}

console.log('════ D. 有店讀不到 ════');
{
  const w = world(); w.clearCache();
  const peer = w.hub.peers[SS('hq')]; delete w.hub.peers[SS('hq')];   // 總部試算表開不起來
  const wr = w.hubPost({ action: 'line_hub_warm' });
  check('D-01', 'warm：回 unreadable、不存', [wr.ok, wr.error, !!w.hub.cache.lhix], [false, 'unreadable', false]);
  const old = world(); old.clearCache(); delete old.hub.peers[SS('hq')]; old.idxOff();
  check('D-02', '開頁資料照原本（對照表不能用就逐店讀）', pick(initOf(w, 'U1')), pick(initOf(old, 'U1')));
  w.hub.peers[SS('hq')] = peer;
}

console.log('════ E. line_hub_warm 本身 ════');
{
  const w = world(); w.clearCache();
  const a = w.hubPost({ action: 'line_hub_warm' });
  check('E-01', '第一次：重建、不回任何人的資料也不回綁定總筆數 n', [a.ok, a.built, a.saved, Object.keys(a).sort()], [true, true, true, ['built', 'ms', 'ok', 'saved']]);
  w.advance(60000);
  const b = w.hubPost({ action: 'line_hub_warm' });
  check('E-02', '60 秒後再打：不重建（200 秒內）', [b.built, b.age_s], [false, 60]);
  w.advance(150000);
  check('E-03', '210 秒後：重建', w.hubPost({ action: 'line_hub_warm' }).built, true);
  w.advance(210000); w.hub.cache.lhixb = { v: 'b', exp: w.hub.sb.__now + 60000 };
  check('E-04', '別人正在建（lhixb）：不重複建', w.hubPost({ action: 'line_hub_warm' }).busy, true);
  delete w.hub.cache.lhixb;
  // 切段：很多人也存得下、讀得回來
  w.clearCache();
  const big = w.stores.mztmc.self.sh.roster;
  for (let i = 0; i < 1500; i++) big.values.push(H.RH.map((h) => ({ emp_id: 'M' + i, name: '大量' + i, key: 'KM' + i, active: 'TRUE', line_user_id: 'U' + String(i).padStart(32, '0') }[h] || '')));
  const c = w.hubPost({ action: 'line_hub_warm' });
  const meta = JSON.parse(w.hub.cache.lhix.v);
  check('E-05', '1500 人：切成好幾段存，讀得回來', [c.saved, meta.k > 1, w.hub.run('lineHubIdxLoad_() !== null')], [true, true, true]);
  check('E-06', '大量資料時查得到人（第 1499 位）', JSON.parse(w.hub.run('JSON.stringify(lineHubMineFast_("U' + String(1499).padStart(32, '0') + '", false).map(function (m) { return m.row.emp_id; }))')), ['M1499']);
  w.hub.run('LINE_HUB_IDX_MAX_CHUNKS = 1;');
  w.clearCache();
  const d = w.hubPost({ action: 'line_hub_warm' });
  check('E-07', '太大（超過段數上限）：不存，查詢照原本逐店讀、結果照樣對', [d.saved, !!w.hub.cache.lhix, initOf(w, 'U1').stores.map((s) => s.code)], [false, false, ['', 'mztjs']]);
  w.hub.run('LINE_HUB_IDX_MAX_CHUNKS = 40;');
  // 段被清掉（CacheService 自己丟掉其中一段）→ 當沒有，重建
  w.clearCache(); w.hubPost({ action: 'line_hub_warm' });
  const k0 = Object.keys(w.hub.cache).filter((k) => /^lhix:.*:0$/.test(k))[0]; delete w.hub.cache[k0];
  check('E-08', '缺一段 → 當沒有（不會拿到半份）', w.hub.run('lineHubIdxLoad_() === null'), true);
  check('E-09', '缺一段時查詢照樣對', initOf(w, 'U1').stores.map((s) => s.code), ['', 'mztjs']);
}

console.log('════ G. warm 失敗也要節流（不需金鑰，被連打不可每次重讀九家名冊）════');
{
  const w = world(); w.clearCache();
  delete w.hub.peers[SS('hq')];   // 總部試算表讀不到 → 重建一定失敗
  w.reset();
  const first = w.hubPost({ action: 'line_hub_warm' });
  const readsFirst = w.cnt.read, opensFirst = w.cnt.open;
  check('G-01', '第一次：真的去讀了（讀到總部前幾家）、回 unreadable', [first.ok, first.error, readsFirst > 0], [false, 'unreadable', true]);
  const res = [];
  for (let i = 0; i < 20; i++) res.push(w.hubPost({ action: 'line_hub_warm' }));
  check('G-02', '之後連打 20 次：讀表次數、開別店試算表次數都不增加', [w.cnt.read, w.cnt.open], [readsFirst, opensFirst]);
  check('G-03', '連打的回應：busy、不重建、不洩漏筆數 n', [res.every((r) => r.busy === true && r.built === false && !('n' in r)), res.every((r) => r.ok === false)], [true, true]);
  w.advance(59000);
  w.hubPost({ action: 'line_hub_warm' });
  check('G-04', '59 秒內還是不讀表', w.cnt.read, readsFirst);
  w.advance(2000);   // 共 61 秒
  w.hubPost({ action: 'line_hub_warm' });
  check('G-05', '60 秒後允許再試一次（店家恢復才會被發現）', w.cnt.read > readsFirst, true);
}
{
  // 成功但存不進（太大）：也算失敗那一類，不可連打就每次重讀
  const w = world(); w.clearCache();
  w.hub.run('LINE_HUB_IDX_MAX_CHUNKS = 0;');
  w.reset();
  const first = w.hubPost({ action: 'line_hub_warm' });
  const readsFirst = w.cnt.read;
  check('G-06', '存不進：第一次讀了、saved=false', [first.built, first.saved, readsFirst > 0], [true, false, true]);
  for (let i = 0; i < 20; i++) w.hubPost({ action: 'line_hub_warm' });
  check('G-07', '存不進、連打 20 次：不再讀表', w.cnt.read, readsFirst);
  w.advance(59000);
  w.hubPost({ action: 'line_hub_warm' });
  check('G-08', '存不進：59 秒內仍不讀表', w.cnt.read, readsFirst);
  w.advance(2000);
  w.hub.run('LINE_HUB_IDX_MAX_CHUNKS = 40;');
  check('G-09', '61 秒後（資料量恢復）重建、這次存得進；之後不留記號', [w.hubPost({ action: 'line_hub_warm' }).saved, !!w.hub.cache.lhixb], [true, false]);
}
{
  // 成功重建後 200 秒內被連打：不重讀（原本的行為不變）
  const w = world(); w.clearCache(); w.hubPost({ action: 'line_hub_warm' }); w.reset();
  for (let i = 0; i < 20; i++) w.hubPost({ action: 'line_hub_warm' });
  check('G-10', '成功後連打 20 次：不讀表', w.cnt.read, 0);
}

console.log('════ H. 從沒查過的人在店家端剛被設離職：不能還開得了申請頁（E）════');
{
  const w = world(); w.clearCache();
  w.hubPost({ action: 'line_hub_warm' });   // 對照表已熱，裡面 U2（央廚 C01）在職
  check('H-01', '設離職前：U2 開得了頁（央廚）', initOf(w, 'U2').ok, true);
  w.clearCache(); w.hubPost({ action: 'line_hub_warm' });   // 清掉每人快取後再熱起來，確保 U2 是「從沒查過」
  const off = w.post('cf', { action: 'mgr_set_active', mgr_key: 'MK', emp_id: 'C01', active: false });
  check('H-02', '央廚主管設離職成功、有通知光復', [off.ok, w.hubCalls.filter((c) => c.action === 'line_hub_left').length], [true, 1]);
  const r = initOf(w, 'U2');
  check('H-03', '設離職後馬上開頁：not_bound（不用等對照表過期）', r.error, 'not_bound');
}

console.log('════ F. 不記進考勤變動通知 ════');
{
  const w = world(); w.clearCache();
  w.hubPost({ action: 'line_hub_warm' }); initOf(w, 'U1');
  check('F-01', 'line_hub_warm、line_hub_req_init 之後沒有 dfeed_ 變動紀錄', Object.keys(w.hub.cache).filter((k) => /^dfeed_/.test(k)).length, 0);
}
done();
