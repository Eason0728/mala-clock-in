// 不到場加綁主店（2026-11-27）等價測試：基準固定 commit f21cc25（LINE_BIND_HOME_BASE 可換）的 LineHub.gs。
// ①開關關（沒設／各種錯值）：申請頁開頁 line_hub_req_init 的回應逐字相同、對外動作（讀分頁、讀名冊、快取、連外、私訊）順序逐筆相同，
//   唯一差別是多讀一次指令碼屬性 LINE_BIND_HOME_ON。
// ②開關「開」也一樣：打卡頁開頁、打卡、輸入全名綁定（現行到場綁定與跨店支援自動加入）、額度、預熱這些動作完全不經過新程式，
//   回應與對外動作逐筆相同。
// ③原始碼：基準檔的每一個函式在新檔都逐字存在，只有 handleLineHubReqInit_ 多了掛勾那兩行、lineHubLeftCascade_ 多了開關包住的保護段（基準的行一行不少、順序不變）；Liff.gs 沒動。
// ④設離職連帶停用 lineHubLeftCascade_（光復直接做、別店經 line_hub_left 進來）：開關關（沒設／各種錯值）時，含「加綁過的主店帳號」在內的每個情境
//   停用結果、名冊、對外動作都跟基準相同（第一輪驗收擋項：原本不看開關）；開關開時只有「確定是主店帳號」那一列不同。
// ⚠ 基準：預設 f21cc25＝本分支開出來時的主線（也是光復服務中那份）。主線換了之後（例：判遲到 #242 上線、本分支併入新主線），
//   要把下面的預設基準改成新主線，或執行時設 LINE_BIND_HOME_BASE=<新主線 commit>；否則 ③（其他後端檔要跟基準相同）等會紅，
//   紅的時候訊息會寫明「基準已不是這條分支的分岔點」。
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const H = require('./helpers/line-bind-home-harness');
const { make, R, X } = H;
const BASE = process.env.LINE_BIND_HOME_BASE || 'f21cc25';
const git = (args) => execFileSync('git', args, { cwd: H.ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// 基準過期的提示：基準不是目前 HEAD 與 origin/main 的分岔點時，任何一條失敗都附上原因（只看本機已有的 origin/main，不 fetch）
const BASE_HINT = (() => {
  const sha = (r) => { try { return git(['rev-parse', '--verify', '-q', r + '^{commit}']).trim(); } catch (e) { return ''; } };
  const b = sha(BASE), mb = (() => { try { return git(['merge-base', 'HEAD', 'origin/main']).trim(); } catch (e) { return ''; } })();
  if (!b) return '比對基準 ' + BASE + ' 在本機找不到。';
  if (mb && mb !== b) return '比對基準 ' + BASE + ' 已不是這條分支與主線的分岔點（目前分岔點 ' + mb.slice(0, 7) + '）：主線換了，'
    + '請把本檔預設基準改成新主線，或設 LINE_BIND_HOME_BASE=' + mb.slice(0, 7) + ' 再跑；這種情況的紅不代表新程式有錯。';
  return '';
})();
let OLD;
try { OLD = git(['show', BASE + ':apps-script/LineHub.gs']); }
catch (e) { throw new Error('讀不到基準 ' + BASE + ' 的 apps-script/LineHub.gs。' + BASE_HINT + '（主線換了之後要把預設基準改成新主線，或設 LINE_BIND_HOME_BASE）'); }
const NEW = fs.readFileSync(H.ROOT + '/apps-script/LineHub.gs', 'utf8');
let n = 0;
const ok = (name, fn) => {
  try { fn(); } catch (e) {
    if (BASE_HINT) { console.error('✗ ' + name + '\n【基準可能過期】' + BASE_HINT); e.message = '【基準可能過期】' + BASE_HINT + '\n' + e.message; e.stack = e.message + '\n' + String(e.stack || ''); }
    throw e;
  }
  n++; console.log('✓ ' + name);
};
const J = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));

// 情境：總部同仁（會被加綁的那種）、一般同仁、兩家都綁、沒綁、憑證錯、對照讀不到、通知開著…
const STORES = H.STORES;
const at = (code) => STORES.find(s => s.code === code);
function scenes() {
  const xm = [X('DZY901', 'MZTHQ', 'MZTLZL', 'L01'), X('DZY901', 'MZTHQ', 'HQ', 'H09'), X('DZY902', 'MZTLZL', 'MZTLZL', 'L02')];
  const s = (extra) => () => {
    const sheets = {
      mztlzl: { roster: [R('L01', '測試甲', { line_user_id: 'U1' }), R('L02', '測試乙', { line_user_id: 'U2' })], events: [] },
      hq: { roster: [R('H09', '測試甲'), R('H10', '測試丙', { line_user_id: 'U3' })], events: [] },
      mztjs: { roster: [R('J20', '測試乙', { line_user_id: 'U2', src_store: 'mztlzl' })], events: [] },
      '': { roster: [R('G01', '測試丁')], events: [] },
    };
    if (extra && extra.sheets) extra.sheets(sheets);
    return Object.assign({ sheets, xmap: xm.map(r => Object.assign({}, r)), dutyMgrs: { hq: { H10: true } } }, extra && extra.make);
  };
  return {
    candidate: s(), plain: s({ sheets: (x) => { x.hq.roster[0].line_user_id = 'U5'; } }),
    no_xmap_sheet: s({ make: { xmap: undefined } }), xmap_throw: s({ make: { xmapThrow: true } }),
    taken: s({ sheets: (x) => { x.hq.roster[0].line_user_id = 'U7'; } }),
  };
}
const TOKENS = ['TOK_U1', 'TOK_U2', 'TOK_U3', 'TOK_U9', 'BAD', ''];
const OFF_VALUES = [undefined, '0', 'true', ' 1', '1 ', '', 'yes', '１'];
const dropProp = (t) => t.filter(x => x !== 'prop:LINE_BIND_HOME_ON');
function run(src, cfg, props, fn) {
  const m = make(Object.assign({}, cfg(), { src, props }));
  const out = []; fn(m, out);
  return { out: J(out), trace: m.trace.slice(), sheets: J(m.sheets), pushes: J(m.pushes) };
}

ok('① 開關關：line_hub_req_init（lite／非 lite，連開兩次）回應、名冊、私訊逐字相同；對外動作只多讀一次 LINE_BIND_HOME_ON', () => {
  let cnt = 0;
  const sc = scenes();
  Object.keys(sc).forEach(k => OFF_VALUES.forEach(v => TOKENS.forEach(tok => [true, false].forEach(lite => {
    const props = Object.assign({ LINE_BIND_HOME_NOTIFY: '1' }, v === undefined ? {} : { LINE_BIND_HOME_ON: v });
    const f = (m, out) => { out.push(m.sb.handleLineHubReqInit_({ id_token: tok, lite })); out.push(m.sb.handleLineHubReqInit_({ id_token: tok, lite, emp_id: 'H09', store: 'hq' })); };
    const a = run(OLD, sc[k], props, f), b = run(NEW, sc[k], props, f);
    const tag = [k, JSON.stringify(v), tok, lite].join(' ');
    assert.deepStrictEqual(b.out, a.out, tag); assert.deepStrictEqual(b.sheets, a.sheets, tag); assert.deepStrictEqual(b.pushes, a.pushes, tag);
    assert.deepStrictEqual(dropProp(b.trace), a.trace, tag);
    const extra = b.trace.length - a.trace.length;
    assert.ok(extra === 0 || extra === 1 || extra === 2, tag + ' 多了 ' + extra + ' 筆');   // 綁定的人每次開頁多讀一次屬性；沒綁的人不讀
    cnt++;
  }))));
  console.log('   （' + cnt + ' 組）');
});
ok('② 開關開：打卡頁開頁、打卡、輸入全名綁定（到場綁定／跨店第一次自動加入／confirm_home）、額度、預熱，跟基準逐筆相同（新程式完全不經過）', () => {
  let cnt = 0;
  const sc = scenes();
  const PROPS = { LINE_BIND_HOME_ON: '1', LINE_BIND_HOME_NOTIFY: '1', STAFF_HUB_URL: 'https://mini.test/svc/auto-support', STAFF_HUB_KEY: 'TEST-HUB-KEY-0123456789' };
  const acts = {
    status_hq: (m, tok) => m.sb.handleLineHubStatus_({ id_token: tok, lat: at('hq').lat, lng: at('hq').lng, accuracy: 10 }),
    status_lzl: (m, tok) => m.sb.handleLineHubStatus_({ id_token: tok, lat: at('mztlzl').lat, lng: at('mztlzl').lng, accuracy: 10 }),
    clock_hq: (m, tok) => m.sb.handleLineQuickClock_({ id_token: tok, lat: at('hq').lat, lng: at('hq').lng, accuracy: 10, type: 'in' }),
    bind_hq: (m, tok) => m.sb.handleLineBindName_({ id_token: tok, name: '測試甲', lat: at('hq').lat, lng: at('hq').lng, accuracy: 10 }),
    bind_hq_sp: (m, tok) => m.sb.handleLineBindName_({ id_token: tok, name: ' 測試甲 ', lat: at('hq').lat, lng: at('hq').lng, accuracy: 10 }),
    bind_gf_elsewhere: (m, tok) => m.sb.handleLineBindName_({ id_token: tok, name: '測試甲', lat: at('').lat, lng: at('').lng, accuracy: 10 }),
    bind_gf_confirm: (m, tok) => m.sb.handleLineBindName_({ id_token: tok, name: '測試丁', lat: at('mztjs').lat, lng: at('mztjs').lng, accuracy: 10, confirm_home: '|G01' }),
    quota: (m, tok) => m.sb.handleLineHubReqQuota_({ id_token: tok }),
    warm: (m) => m.sb.handleLineHubWarm_(),
  };
  Object.keys(sc).forEach(k => Object.keys(acts).forEach(an => TOKENS.forEach(tok => {
    const f = (m, out) => { out.push(acts[an](m, tok)); out.push(acts[an](m, tok)); };
    const a = run(OLD, sc[k], PROPS, f), b = run(NEW, sc[k], PROPS, f);
    const tag = [k, an, tok].join(' ');
    assert.deepStrictEqual(b.out, a.out, tag); assert.deepStrictEqual(b.trace, a.trace, tag);
    assert.deepStrictEqual(b.sheets, a.sheets, tag); assert.deepStrictEqual(b.pushes, a.pushes, tag);
    cnt++;
  })));
  console.log('   （' + cnt + ' 組）');
});
ok('②-對照組：開關開時申請頁開頁確實不一樣（證明比對有效）', () => {
  const sc = scenes();
  const f = (m, out) => out.push(m.sb.handleLineHubReqInit_({ id_token: 'TOK_U1', lite: true }));
  const a = run(OLD, sc.candidate, { LINE_BIND_HOME_ON: '1' }, f), b = run(NEW, sc.candidate, { LINE_BIND_HOME_ON: '1' }, f);
  assert.notDeepStrictEqual(b.out, a.out); assert.notDeepStrictEqual(b.sheets, a.sheets);
});
const CASCADE_ADDED = [
  'var homeKeep;   // 不到場加綁（2026-11-27）：開關 LINE_BIND_HOME_ON 開著才保護主店帳號；undefined＝還沒讀開關、null＝關（與改版前完全相同）',
  '// 主店帳號不連帶停用（2026-11-27；只在開關開著時）：支援列（src_store 有值）照舊停用；其他列問對照，',
  '// 「確定」是這個人的主店帳號才留著；判斷不了（對照讀不到、對到兩個人、主店不只一種、出錯）＝照舊停用（設離職是保護性動作）。',
  "if (homeKeep === undefined) homeKeep = lineBindHomeOn_('LINE_BIND_HOME_ON') ? {} : null;",
  'if (homeKeep) {',
  'hit = hit.filter(function (r) {',
  "if (String(r.src_store || '').trim()) return true;",
  'var kind;',
  "try { kind = lineHubLeftHomeKind_(src, srcEmpId, st, r, homeKeep); } catch (e) { kind = 'unknown'; }",
  "return kind !== 'home';",
  '});',
  'if (!hit.length) return;',
  '}',
];
ok('③ 原始碼：基準的每個函式在新檔逐字存在；handleLineHubReqInit_ 只多掛勾兩行；lineHubLeftCascade_ 只多開關包住的保護段；Liff.gs 等其他後端檔與基準相同', () => {
  const names = (src) => [...src.matchAll(/^function ([A-Za-z0-9_$]+)\(/gm)].map(m => m[1]);
  const oldNames = names(OLD);
  oldNames.forEach(nm => {
    const a = H.extract(OLD, nm), b = H.extract(NEW, nm);
    if (nm === 'lineHubLeftCascade_') {   // 主店帳號保護：基準的行一行不少、順序不變；多出來的只有下面這段（全部在開關判斷裡）
      const al0 = a.split('\n'), bl0 = b.split('\n'), extra = [];
      let i = 0;
      bl0.forEach(l => { if (i < al0.length && l === al0[i]) i++; else extra.push(l.trim()); });
      assert.strictEqual(i, al0.length, 'lineHubLeftCascade_ 基準的行有被改或刪');
      assert.deepStrictEqual(extra, CASCADE_ADDED);
      return;
    }
    if (nm !== 'handleLineHubReqInit_') { assert.strictEqual(b, a, nm + ' 有改動'); return; }
    const al = a.split('\n'), bl = b.split('\n');
    const added = bl.filter(l => al.indexOf(l) < 0);
    assert.deepStrictEqual(added.map(s => s.trim()), [
      'var withHome = lineHubBindHomeAuto_(userId, body, mine);   // 不到場加綁主店（2026-11-27）：開關關＝回 null、什麼都不做',
      'if (withHome) mine = withHome;']);
    assert.strictEqual(bl.length, al.length + 2);
  });
  const fresh = names(NEW).filter(x => oldNames.indexOf(x) < 0).sort();
  assert.deepStrictEqual(fresh, ['lineBindHomeCode_', 'lineBindHomeDecide_', 'lineBindHomeDo_', 'lineBindHomeHomeOf_', 'lineBindHomeIdClash_', 'lineBindHomeIdLoose_', 'lineBindHomeId_', 'lineBindHomeIndex_', 'lineBindHomeMs_', 'lineBindHomeOn_', 'lineBindHomePlan_', 'lineBindHomePreview', 'lineBindHomeRecheck_', 'lineBindHomeUndo_', 'lineBindHomeXmapBuild_', 'lineBindHomeXmapKeep_', 'lineBindHomeXmap_', 'lineHubBindHomeAuto_', 'lineHubLeftHomeKind_']);
  const lf = git(['diff', '--stat', BASE, '--', 'apps-script/Liff.gs', 'apps-script/Code.gs', 'apps-script/Requests.gs', 'apps-script/Payroll.gs']).trim();
  assert.strictEqual(lf, '', '其他後端檔不可以動：' + lf);
});
// 連帶停用的情境：src＝[設離職的店, 工號]（預設六張犁 L01）；via＝'left' 走別店通知光復那條（handleLineHubLeft_）
const CASC = {
  home_bound: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; } },                                       // 第一輪擋項：主店帳號加綁過
  home_bound_left: { via: 'left', sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; } },
  home_and_support: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; x.mztjs.roster.push(R('J21', '測試甲', { line_user_id: 'U1', src_store: 'mztlzl' })); } },
  home_xmap_throw: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; }, make: { xmapThrow: true } },
  home_no_xmap_sheet: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; }, make: { xmap: undefined } },
  home_two_people: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; }, xmapAdd: [X('DZY999', 'HQ', 'MZTLZL', 'L01')] },
  home_ambiguous: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; }, xmapAdd: [X('DZY901', 'MZTJS', 'MZTJS', 'J77')] },
  support_only: { trace: true, sheets: (x) => { x.mztjs.roster = [R('J20', '測試甲', { line_user_id: 'U1', src_store: 'mztlzl' })]; } },
  unmapped_rows: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; }, make: { xmap: [] } },
  home_leaves: { src: ['hq', 'H09'], sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; } },
  non_home_other: { sheets: (x) => { x.mztgf = { roster: [R('F05', '測試甲', { line_user_id: 'U1' })] }; } },
  nobody_else: {},
  home_two_rows_one_mapped: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; x.hq.roster.push(R('H12', '測試甲', { line_user_id: 'U1' })); } },   // 第二輪加驗：只留 H09
  home_two_rows_both_mapped: { sheets: (x) => { x.hq.roster[0].line_user_id = 'U1'; x.hq.roster.push(R('H12', '測試甲', { line_user_id: 'U1' })); },
                               xmapAdd: [X('DZY901', 'MZTHQ', 'HQ', 'H12')] },                                                                     // 歧義：照停
};
const CASC_ON_DIFF = ['home_bound', 'home_bound_left', 'home_and_support', 'home_two_rows_one_mapped'];   // 開關開：只有這三個（確定是主店帳號）跟基準不同
function cascCfg(c) {
  return () => {
    const base = scenes().candidate(); if (c.sheets) c.sheets(base.sheets);
    if (c.xmapAdd) base.xmap = base.xmap.concat(c.xmapAdd);
    return Object.assign(base, c.make || {});
  };
}
function cascRun(c) {
  return (m, out) => {
    const sc = c.src ? c.src[0] : 'mztlzl', se = c.src ? c.src[1] : 'L01';
    const row = m.sheets[sc].roster.find(r => r.emp_id === se);
    row.active = 'false'; row.removed_at = H.isoAgo(0); row.removed_by = '店長甲';
    if (c.via === 'left') out.push(m.sb.handleLineHubLeft_({ emp_id: se, removed_at: row.removed_at }));
    else out.push(m.sb.lineHubLeftCascade_(m.sb.lineHubStores_().filter(s => s.code === sc)[0], se, 'U1', '店長甲'));
  };
}
const CASC_OFF = [undefined, '', ' ', 'ON', 'on', 'true', 'TRUE', '1 ', ' 1', '0', 'yes', '亂字x', '１', '01'];
ok('④ 設離職連帶停用，開關關（沒設／空白／ON／true／"1 "／0／亂字…）：每個情境（含加綁過的主店帳號、別店通知光復那條）回應、名冊、私訊跟基準逐字相同，對外動作只多讀一次 LINE_BIND_HOME_ON', () => {
  let cnt = 0;
  Object.keys(CASC).forEach(k => CASC_OFF.forEach(v => {
    const props = Object.assign({ LINE_BIND_HOME_NOTIFY: '1' }, v === undefined ? {} : { LINE_BIND_HOME_ON: v });
    const a = run(OLD, cascCfg(CASC[k]), props, cascRun(CASC[k])), b = run(NEW, cascCfg(CASC[k]), props, cascRun(CASC[k]));
    const tag = k + ' ' + JSON.stringify(v);
    assert.deepStrictEqual(b.out, a.out, tag); assert.deepStrictEqual(b.sheets, a.sheets, tag); assert.deepStrictEqual(b.pushes, a.pushes, tag);
    assert.deepStrictEqual(dropProp(b.trace), a.trace, tag + ' 對外動作');
    assert.ok(b.trace.length - a.trace.length <= 1, tag + ' 屬性最多多讀一次');
    cnt++;
  }));
  console.log('   （' + cnt + ' 組）');
});
ok('④-開 開關 "1"：沒有「確定是主店帳號」的情境（判斷不了、對照查不到、只有支援列、主店自己離職…）停用結果與名冊跟基準相同；只有支援列時連對外動作都相同', () => {
  let cnt = 0;
  Object.keys(CASC).filter(k => CASC_ON_DIFF.indexOf(k) < 0).forEach(k => {
    const c = CASC[k];
    const a = run(OLD, cascCfg(c), { LINE_BIND_HOME_ON: '1' }, cascRun(c)), b = run(NEW, cascCfg(c), { LINE_BIND_HOME_ON: '1' }, cascRun(c));
    assert.deepStrictEqual(b.out, a.out, k); assert.deepStrictEqual(b.sheets, a.sheets, k);
    if (c.trace) assert.deepStrictEqual(dropProp(b.trace), a.trace, k + ' 對外動作');
    cnt++;
  });
  console.log('   （' + cnt + ' 組）');
});
ok('④-對照組：開關 "1" 時加綁過的主店帳號，基準會連帶停用、新版留著；支援列兩邊都停（證明比對有效）；開關沒設時兩邊都停', () => {
  CASC_ON_DIFF.forEach(k => {
    const c = CASC[k];
    const a = run(OLD, cascCfg(c), { LINE_BIND_HOME_ON: '1' }, cascRun(c)), b = run(NEW, cascCfg(c), { LINE_BIND_HOME_ON: '1' }, cascRun(c));
    assert.strictEqual(a.sheets.hq.roster[0].active, false, k); assert.strictEqual(b.sheets.hq.roster[0].active, 'true', k);
    if (k === 'home_and_support') { assert.strictEqual(a.sheets.mztjs.roster[1].active, false); assert.strictEqual(b.sheets.mztjs.roster[1].active, false); }
    if (k === 'home_two_rows_one_mapped') { assert.strictEqual(a.sheets.hq.roster[2].active, false); assert.strictEqual(b.sheets.hq.roster[2].active, false, '主店不在對照的那列照停'); }
    const a0 = run(OLD, cascCfg(c), {}, cascRun(c)), b0 = run(NEW, cascCfg(c), {}, cascRun(c));
    assert.strictEqual(a0.sheets.hq.roster[0].active, false, k); assert.strictEqual(b0.sheets.hq.roster[0].active, false, k + ' 開關沒設要照停');
  });
});
console.log('\n' + n + ' 過、0 失敗');
