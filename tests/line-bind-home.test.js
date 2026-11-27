// 不到場加綁主店帳號（LineHub.gs lineHubBindHomeAuto_／lineBindHomeDecide_，2026-11-27）。測試資料一律假名、假工號。
// 規則白話：同一支 LINE 已綁在集團某店的在職帳號、主店（管理系統主要單位所屬打卡店）有同名（逐字）、在職、沒綁 LINE 的帳號、
// 光復打卡對照快照（payroll_xmap，confirmed）確認兩個帳號是同一個 DZY → 申請頁開頁時自動加綁主店帳號，這一次的單位清單就含主店。
// 開關 LINE_BIND_HOME_ON 只有 '1' 才開。手算對照案例 H1～H6 寫在各條測試名稱前。
const assert = require('assert');
const { make, R, X, init, codes, payStores, isoAgo } = require('./helpers/line-bind-home-harness');
let n = 0; const bad = [];
// 變異測試（tools/line-bind-home-mutate.js）帶 LINE_BIND_HOME_KEEP_GOING=1：一條失敗不中斷，最後列出哪幾條紅
const ok = (name, fn) => { try { fn(); n++; console.log('✓ ' + name); } catch (e) { if (process.env.LINE_BIND_HOME_KEEP_GOING !== '1') throw e; bad.push(name); console.log('✗ ' + name); } };
const ON = { LINE_BIND_HOME_ON: '1' };
const TAG = '（不到場加綁）';

// 基本情境＝總部同仁那種：LINE U1 綁在六張犁 L01「測試甲」；主店＝墨竹亭品牌辦公室（MZTHQ）→ 總部打卡店；總部 H09「測試甲」在職、沒綁。
function base(o) {
  o = o || {};
  const sheets = {
    mztlzl: { roster: [R('L01', '測試甲', { line_user_id: 'U1' }), R('L02', '測試乙', { line_user_id: 'U2' })], events: [] },
    hq: { roster: [R('H09', '測試甲'), R('H10', '測試丙', { line_user_id: 'U3' })], events: [] },
  };
  const xmap = [X('DZY901', 'MZTHQ', 'MZTLZL', 'L01'), X('DZY901', 'MZTHQ', 'HQ', 'H09'),
                X('DZY902', 'MZTLZL', 'MZTLZL', 'L02'), X('DZY903', 'HQ', 'HQ', 'H10')];
  if (o.sheets) o.sheets(sheets);
  return make(Object.assign({ sheets, props: ON, xmap: o.xmap ? o.xmap(xmap) : xmap }, o.make || {}));
}
const binds = (m) => m.storeCalls.filter(c => c.body.action === 'liff_bind');
const NO_BIND = (m, msg) => assert.strictEqual(binds(m).length, 0, (msg || '') + ' 不應該送綁定：' + JSON.stringify(binds(m).map(c => c.body)));

// ── 放行 ──
ok('H1 總部同仁情境：開申請頁就加綁總部 H09，同一次回應的單位清單＝[六張犁, 總部]（照店家清單順序），紀錄註明不到場加綁', () => {
  const m = base();
  const r = init(m);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(codes(r), ['mztlzl', 'hq']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.stores[1])), { code: 'hq', name: '鼎兆元 總部', emp_id: 'H09', emp_name: '測試甲', support: false });
  const b = binds(m); assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].code, 'hq'); assert.strictEqual(b[0].body.key, 'kH09'); assert.strictEqual(b[0].body.via, 'name');
  assert.strictEqual(b[0].body.id_token, 'TOK_U1', '店端要拿同仁自己的 id_token 再驗一次');
  assert.strictEqual(m.sheets.hq.roster[0].line_user_id, 'U1');
  assert.deepStrictEqual(m.sheets.hq.liff_bind_log.map(x => [x.emp_id, x.type]), [['H09', 'bind_name@墨竹亭 台北六張犁' + TAG]]);
  assert.strictEqual(m.pushes.length, 0, '通知開關沒開：不私訊');
  assert.strictEqual(m.cache['lbh:U1'], 'done');
});
ok('H1 之後：第二次開頁不再判斷、不再綁（判斷結果記 30 分鐘）；記憶過期後再開，名冊已綁＝already，也不綁', () => {
  const m = base(); init(m);
  m.storeCalls.length = 0;
  const r2 = init(m); assert.deepStrictEqual(codes(r2), ['mztlzl', 'hq']); NO_BIND(m);
  delete m.cache['lbh:U1'];
  const pr = m.counters.payRead; const r3 = init(m);
  assert.deepStrictEqual(codes(r3), ['mztlzl', 'hq']); NO_BIND(m);
  assert.strictEqual(m.cache['lbh:U1'], 'already'); assert.strictEqual(m.counters.payRead, pr, '對照索引 10 分鐘內不重讀');
});
ok('H2 三個總部名單單位（鼎兆元總部 HQ、小辛辣品牌辦公室 SSLHQ、墨竹亭品牌辦公室 MZTHQ）都對到總部那家打卡店', () => {
  ['HQ', 'SSLHQ', 'MZTHQ'].forEach(p => {
    const m = base({ xmap: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { pay_store: p }) : r) });
    assert.deepStrictEqual(codes(init(m)), ['mztlzl', 'hq'], p);
    assert.strictEqual(binds(m)[0].code, 'hq', p);
  });
});
ok('H3 規則不寫死總部：央廚綁定、主店是金山 → 加綁金山；主店是小辛辣光復（店代碼空字串）也對', () => {
  const m = make({ props: ON, sheets: { cf: { roster: [R('C05', '測試丁', { line_user_id: 'U5' })] }, mztjs: { roster: [R('J07', '測試丁')] } },
                   xmap: [X('DZY905', 'MZTJS', 'CF', 'C05'), X('DZY905', 'MZTJS', 'MZTJS', 'J07')] });
  assert.deepStrictEqual(codes(init(m, 'TOK_U5')), ['mztjs', 'cf']);
  assert.deepStrictEqual(m.sheets.mztjs.liff_bind_log.map(x => x.type), ['bind_name@鼎兆元 中央廚房' + TAG]);
  const g = make({ props: ON, sheets: { cf: { roster: [R('C06', '測試戊', { line_user_id: 'U6' })] }, '': { roster: [R('G03', '測試戊')] } },
                   xmap: [X('DZY906', 'SSLGF', 'CF', 'C06'), X('DZY906', 'SSLGF', 'SSLGF', 'G03')] });
  assert.deepStrictEqual(codes(init(g, 'TOK_U6')), ['', 'cf']);
  assert.strictEqual(binds(g)[0].code, ''); assert.strictEqual(g.sheets[''].roster[0].line_user_id, 'U6');
});
ok('H4 綁兩家（六張犁原單位＋金山支援列）都對到同一個 DZY → 照樣加綁總部；清單順序＝金山、六張犁、總部', () => {
  const m = base({ sheets: (s) => { s.mztjs = { roster: [R('J20', '測試甲', { line_user_id: 'U1', src_store: 'mztlzl' })] }; },
                   xmap: (x) => x.concat([X('DZY901', 'MZTHQ', 'MZTJS', 'J20')]) });
  assert.deepStrictEqual(codes(init(m)), ['mztjs', 'mztlzl', 'hq']);
  assert.strictEqual(binds(m).length, 1);
});
ok('通知開關 LINE_BIND_HOME_NOTIFY=1：私訊主店值班主管（沿用既有文字、不送給本人）；只填其他值不送', () => {
  const dm = { hq: { H10: true, H09: true } };
  const m = base({ make: { props: Object.assign({ LINE_BIND_HOME_NOTIFY: '1' }, ON), dutyMgrs: dm } });
  init(m);
  assert.strictEqual(m.pushes.length, 1); assert.strictEqual(m.pushes[0].to, 'U3', '只送總部有綁 LINE 的值班主管、不送給剛綁的本人');
  assert.strictEqual(m.pushes[0].messages[0].text, '【LINE 綁定提醒】\n「鼎兆元 總部」測試甲（H09）的 LINE 剛在「墨竹亭 台北六張犁」被綁定。\n'
    + '如果不是本人，請立刻到管理系統「考勤管理 → 員工名冊」的 LINE 綁定紀錄按「解除」。');
  ['true', 'on', ' 1', '1 ', '', '0'].forEach(v => {
    const q = base({ make: { props: Object.assign({ LINE_BIND_HOME_NOTIFY: v }, ON), dutyMgrs: dm } }); init(q);
    assert.strictEqual(binds(q).length, 1); assert.strictEqual(q.pushes.length, 0, JSON.stringify(v));
  });
});

// ── 拒絕（每一條都斷言：沒送綁定、清單沒有總部）──
const REJ = (m, tok, why) => { const r = init(m, tok); NO_BIND(m, why); return r; };
ok('LINE 沒綁過任何店 → 開頁照舊 not_bound，不判斷、不讀對照', () => {
  const m = base(); const r = REJ(m, 'TOK_U9', '沒綁過');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'not_bound' });
  assert.strictEqual(m.counters.payRead, 0); assert.strictEqual(m.counters.props.LINE_BIND_HOME_ON || 0, 0);
});
ok('H5 姓名差一個字／全形半形／多空白（半形、全形）/大小寫 → 不綁（逐字相同才算）', () => {
  ['測試乙', '測試甲 ', ' 測試甲', '測試　甲', '測 試甲', 'Ｔ測試甲', 'T測試甲'].forEach(nm => {
    const m = base({ sheets: (s) => { s.hq.roster[0].name = nm; } });
    assert.deepStrictEqual(codes(REJ(m, null, nm)), ['mztlzl'], nm); assert.strictEqual(m.cache['lbh:U1'], 'name_mismatch', nm);
  });
  // 反過來：已綁那列多空白、目標列沒有
  const m = base({ sheets: (s) => { s.mztlzl.roster[0].name = '測試甲 '; } });
  assert.deepStrictEqual(codes(REJ(m)), ['mztlzl']);
  const fw = base({ sheets: (s) => { s.mztlzl.roster[0].name = 'ABC'; s.hq.roster[0].name = 'ＡＢＣ'; } });
  REJ(fw, null, '全形英文');
});
ok('對照未確認（suggested）／查不到／分頁不存在／讀取丟例外／對到不同工號／只有 acct_only 列／超過 35 天沒同步 → 不綁', () => {
  const cases = {
    suggested: (x) => x.map(r => r.emp_id === 'H09' ? Object.assign({}, r, { state: 'suggested' }) : r),
    hq_missing: (x) => x.filter(r => r.emp_id !== 'H09'),
    src_missing: (x) => x.filter(r => r.emp_id !== 'L01'),
    other_emp: (x) => x.map(r => r.emp_id === 'H09' ? Object.assign({}, r, { emp_no: 'DZY999' }) : r),
    acct_only: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { acct_only: 'true' }) : r),
    stale: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { synced_at: isoAgo(36) }) : r),
    bad_ts: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { synced_at: '' }) : r),
  };
  Object.keys(cases).forEach(k => { const m = base({ xmap: cases[k] }); assert.deepStrictEqual(codes(REJ(m, null, k)), ['mztlzl'], k); });
  const nosheet = base({ make: { xmap: undefined } }); assert.deepStrictEqual(codes(REJ(nosheet, null, '沒有分頁')), ['mztlzl']);
  assert.strictEqual(nosheet.counters.payRead, 0, '分頁不存在不可以叫 payRead（它會建分頁）');
  const thr = base({ make: { xmapThrow: true } }); const r = REJ(thr, null, '丟例外');
  assert.deepStrictEqual(codes(r), ['mztlzl']); assert.strictEqual(r.ok, true, '讀不到對照＝開頁其餘照舊');
  assert.strictEqual(thr.cache['lbh:U1'], 'xmap_unreadable'); assert.strictEqual(thr.cache.lbhxf, '1');
});
ok('目標帳號已綁別支 LINE／停用（離職）／沒有啟用碼 → 不綁', () => {
  [['taken', (s) => { s.hq.roster[0].line_user_id = 'U7'; }, 'home_taken'],
   ['inactive', (s) => { s.hq.roster[0].active = 'false'; }, 'home_inactive'],
   ['nokey', (s) => { s.hq.roster[0].key = ''; }, 'home_no_key']].forEach(([k, f, why]) => {
    const m = base({ sheets: f }); assert.deepStrictEqual(codes(REJ(m, null, k)), ['mztlzl'], k); assert.strictEqual(m.cache['lbh:U1'], why, k);
  });
});
ok('已綁那列停用或離職（快取還認得他）、或剛被改綁別支 LINE → 不綁（加綁前即時重讀那一列）', () => {
  const m = base(); m.sb.handleLineHubWarm_();   // 先建好共用對照表（裡面記著 U1 綁六張犁）
  m.sheets.mztlzl.roster[0].active = 'false';
  assert.deepStrictEqual(codes(REJ(m, null, '停用')), ['mztlzl']); assert.strictEqual(m.cache['lbh:U1'], 'src_changed');
  const m2 = base(); m2.sb.handleLineHubWarm_(); m2.sheets.mztlzl.roster[0].line_user_id = 'U8';
  REJ(m2, null, '改綁'); assert.strictEqual(m2.cache['lbh:U1'], 'src_changed');
});
ok('目標店不是主店：主店是六張犁本身（already）；主店是金山但金山沒有帳號、總部有對照帳號 → 不綁總部', () => {
  const m = base({ xmap: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { pay_store: 'MZTLZL' }) : r) });
  assert.deepStrictEqual(codes(REJ(m, null, '主店六張犁')), ['mztlzl']); assert.strictEqual(m.cache['lbh:U1'], 'already');
  const j = base({ xmap: (x) => x.map(r => r.emp_no === 'DZY901' ? Object.assign({}, r, { pay_store: 'MZTJS' }) : r) });
  assert.deepStrictEqual(codes(REJ(j, null, '主店金山')), ['mztlzl']); assert.strictEqual(j.cache['lbh:U1'], 'no_home_account');
  const amb = base({ xmap: (x) => x.map(r => r.emp_id === 'H09' ? Object.assign({}, r, { pay_store: 'MZTJS' }) : r) });
  REJ(amb, null, '主店兩種'); assert.strictEqual(amb.cache['lbh:U1'], 'home_ambiguous');
  const noclk = base({ make: { payStores: payStores(b => b.map(s => s.code === 'MZTHQ' ? Object.assign({}, s, { clock_ss_id: '' }) : s)) } });
  REJ(noclk, null, '薪資門市表沒填打卡表'); assert.strictEqual(noclk.cache['lbh:U1'], 'no_home_store');
});
ok('同名的另一個人（不同工號）在總部：自己沒有總部對照 → 不綁；兩位同名都在總部 → 只綁對照到自己工號那一列', () => {
  const m = base({ sheets: (s) => { s.hq.roster.push(R('H11', '測試甲')); },
                   xmap: (x) => x.filter(r => r.emp_id !== 'H09').concat([X('DZY904', 'HQ', 'HQ', 'H11')]) });
  REJ(m, null, '別人'); assert.strictEqual(m.cache['lbh:U1'], 'no_home_account');
  const two = base({ sheets: (s) => { s.hq.roster.push(R('H11', '測試甲')); }, xmap: (x) => x.concat([X('DZY904', 'HQ', 'HQ', 'H11')]) });
  init(two); assert.strictEqual(binds(two).length, 1); assert.strictEqual(binds(two)[0].body.key, 'kH09');
  assert.strictEqual(two.sheets.hq.roster[2].line_user_id, '');
});
ok('這支 LINE 綁的兩家對到不同工號／名字不一致 → 不綁', () => {
  const m = base({ sheets: (s) => { s.mztjs = { roster: [R('J20', '測試甲', { line_user_id: 'U1' })] }; },
                   xmap: (x) => x.concat([X('DZY977', 'MZTJS', 'MZTJS', 'J20')]) });
  REJ(m, null, '不同工號'); assert.strictEqual(m.cache['lbh:U1'], 'mapped_multi');
  const nm = base({ sheets: (s) => { s.mztjs = { roster: [R('J20', '測試甲甲', { line_user_id: 'U1' })] }; } });
  REJ(nm, null, '名字不一致'); assert.strictEqual(nm.cache['lbh:U1'], 'name_mismatch');
});
ok('主管解除過這一列的 LINE 綁定 → 不再自動加綁；主店名冊有離職列綁過這支 LINE → 不綁', () => {
  const m = base({ sheets: (s) => { s.hq.liff_bind_log = [{ ts: isoAgo(3), emp_id: 'H09', name: '測試甲', line_user_id: 'U1', type: 'unbind_by:店長甲' }]; } });
  REJ(m, null, '解除過'); assert.strictEqual(m.cache['lbh:U1'], 'unbound_before');
  const old = base({ sheets: (s) => { s.hq.roster.push(R('H01', '測試甲', { active: 'false', line_user_id: 'U1' })); } });
  REJ(old, null, '離職列'); assert.strictEqual(old.cache['lbh:U1'], 'home_line_seen');
});
ok('跨品牌：小辛辣光復綁定、主店是墨竹亭金山 → 不綁', () => {
  const m = make({ props: ON, sheets: { '': { roster: [R('G05', '測試己', { line_user_id: 'U4' })] }, mztjs: { roster: [R('J09', '測試己')] } },
                   xmap: [X('DZY907', 'MZTJS', 'SSLGF', 'G05'), X('DZY907', 'MZTJS', 'MZTJS', 'J09')] });
  REJ(m, 'TOK_U4', '跨品牌'); assert.strictEqual(m.cache['lbh:U4'], 'cross_brand');
});
ok('H6 同一支 LINE 連續嘗試：店端一直失敗 → 每 5 分鐘才再試一次；10 分鐘內最多 5 次（沿用綁定次數限制，與輸入全名綁定共用）', () => {
  const m = base({ make: { bindReply: () => ({ ok: false, error: 'busy' }) } });
  init(m); init(m); init(m);
  assert.strictEqual(binds(m).length, 1, '失敗後 5 分鐘內不再試'); assert.strictEqual(m.cache['lbh:U1'], 'bind_failed');
  for (let i = 0; i < 8; i++) { delete m.cache['lbh:U1']; init(m); }
  assert.strictEqual(binds(m).length, 5, '10 分鐘內最多 5 次'); assert.strictEqual(m.cache['lbh:U1'], 'too_many');
  // 輸入全名綁定已用掉 5 次 → 加綁也不試
  const q = base(); for (let i = 0; i < 5; i++) q.sb.lineHubThrottled_('bind', 'U1', 5, 600);
  REJ(q, null, '次數用完'); assert.strictEqual(q.cache['lbh:U1'], 'too_many');
});
ok('偽造請求：帶 emp_id／store／name／line_user_id／key／confirm_home／via_store 都不理，只認 id_token 的身分；別人的 token 不能替 U1 綁', () => {
  const m = base();
  const r = init(m, 'TOK_U1', { emp_id: 'H10', store: 'hq', name: '測試丙', line_user_id: 'U3', key: 'kH10', confirm_home: 'hq|H10', via_store: '偽造', user_id: 'U3' });
  assert.deepStrictEqual(codes(r), ['mztlzl', 'hq']);
  assert.strictEqual(binds(m)[0].body.key, 'kH09'); assert.strictEqual(m.sheets.hq.roster[1].line_user_id, 'U3');
  assert.deepStrictEqual(Object.keys(binds(m)[0].body).sort(), ['action', 'id_token', 'key', 'via', 'via_store']);
  const x = base(); const rx = init(x, 'TOK_U2', { name: '測試甲', emp_id: 'H09', line_user_id: 'U1' });
  NO_BIND(x, 'U2 冒用'); assert.deepStrictEqual(codes(rx), ['mztlzl']); assert.strictEqual(x.sheets.hq.roster[0].line_user_id, '');
  const bad = base(); const rb = init(bad, 'FAKE_U1'); NO_BIND(bad); assert.strictEqual(rb.error, 'invalid_id_token');
});
ok('開關：只有字串 "1" 才開；沒設、"0"、"true"、" 1"、"1 "、"yes"、"" → 不判斷、不讀對照、不綁', () => {
  [undefined, '0', 'true', ' 1', '1 ', 'yes', '', 'on', '１'].forEach(v => {
    const props = v === undefined ? {} : { LINE_BIND_HOME_ON: v };
    const m = base({ make: { props } });
    assert.deepStrictEqual(codes(REJ(m, null, JSON.stringify(v))), ['mztlzl']);
    assert.strictEqual(m.counters.payRead, 0); assert.strictEqual(m.counters.payStoreList, 0);
    assert.ok(!m.trace.some(t => /lbh/.test(t)), '關著不可以碰 lbh 快取');
  });
});
ok('高頻路徑：沒有候選人的人第二次開頁只多一次快取讀取；對照索引多人共用、10 分鐘才重讀；名冊讀不到時開頁照舊', () => {
  const m = base();
  init(m, 'TOK_U2');   // U2：主店就是六張犁 → already
  assert.strictEqual(m.cache['lbh:U2'], 'already');
  const t0 = m.trace.length, r0 = m.counters.roster; init(m, 'TOK_U2');
  const extra = m.trace.slice(t0).filter(t => /lbh|payRead|payStoreList/.test(t));
  assert.deepStrictEqual(extra, ['cget:lbh:U2']); assert.strictEqual(m.counters.roster, r0, '不多讀名冊');
  init(m, 'TOK_U1'); assert.strictEqual(m.counters.payRead, 1, 'U1 用同一份索引');
  const f = base({ make: { rosterThrow: (st) => st.code === 'hq' && f.__armed } }); f.sb.handleLineHubWarm_(); f.__armed = true;
  const rf = init(f); assert.strictEqual(rf.ok, true); NO_BIND(f, '名冊讀不到'); assert.strictEqual(f.cache['lbh:U1'], 'unreachable');
});
ok('預覽（編輯器函式 lineBindHomePreview）：列出會加綁的人（店代碼:工號）、其他人原因；不綁定、不記每人結果、不印姓名', () => {
  const m = base({ make: { props: {} } });
  const p = m.sb.lineBindHomePreview();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.will_bind)), ['mztlzl:L01 → hq:H09']);
  assert.strictEqual(p.count.will_bind, 1); assert.strictEqual(p.count.already, 2);
  NO_BIND(m); assert.ok(!Object.keys(m.cache).some(k => /^lbh:/.test(k)));
  assert.ok(!m.trace.filter(t => /^log:/.test(t)).some(t => /測試|U\d/.test(t)), '紀錄不可以有姓名或 LINE 帳號');
});
if (bad.length) { console.log('\n' + n + ' 過、' + bad.length + ' 失敗'); process.exit(1); }
console.log('\n' + n + ' 過、0 失敗');
