// 不到場加綁主店（2026-11-27）等價測試：基準固定 commit f21cc25（LINE_BIND_HOME_BASE 可換）的 LineHub.gs。
// ①開關關（沒設／各種錯值）：申請頁開頁 line_hub_req_init 的回應逐字相同、對外動作（讀分頁、讀名冊、快取、連外、私訊）順序逐筆相同，
//   唯一差別是多讀一次指令碼屬性 LINE_BIND_HOME_ON。
// ②開關「開」也一樣：打卡頁開頁、打卡、輸入全名綁定（現行到場綁定與跨店支援自動加入）、額度、預熱這些動作完全不經過新程式，
//   回應與對外動作逐筆相同。
// ③原始碼：基準檔的每一個函式在新檔都逐字存在，只有 handleLineHubReqInit_ 多了掛勾那兩行；Liff.gs 沒動。
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const H = require('./helpers/line-bind-home-harness');
const { make, R, X } = H;
const BASE = process.env.LINE_BIND_HOME_BASE || 'f21cc25';
const git = (args) => execFileSync('git', args, { cwd: H.ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const OLD = git(['show', BASE + ':apps-script/LineHub.gs']);
const NEW = fs.readFileSync(H.ROOT + '/apps-script/LineHub.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
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
ok('③ 原始碼：基準的每個函式在新檔逐字存在；handleLineHubReqInit_ 只多掛勾兩行；Liff.gs 與基準相同', () => {
  const names = (src) => [...src.matchAll(/^function ([A-Za-z0-9_$]+)\(/gm)].map(m => m[1]);
  const oldNames = names(OLD);
  oldNames.forEach(nm => {
    const a = H.extract(OLD, nm), b = H.extract(NEW, nm);
    if (nm !== 'handleLineHubReqInit_') { assert.strictEqual(b, a, nm + ' 有改動'); return; }
    const al = a.split('\n'), bl = b.split('\n');
    const added = bl.filter(l => al.indexOf(l) < 0);
    assert.deepStrictEqual(added.map(s => s.trim()), [
      'var withHome = lineHubBindHomeAuto_(userId, body, mine);   // 不到場加綁主店（2026-11-27）：開關關＝回 null、什麼都不做',
      'if (withHome) mine = withHome;']);
    assert.strictEqual(bl.length, al.length + 2);
  });
  const fresh = names(NEW).filter(x => oldNames.indexOf(x) < 0).sort();
  assert.deepStrictEqual(fresh, ['lineBindHomeCode_', 'lineBindHomeDecide_', 'lineBindHomeDo_', 'lineBindHomeId_', 'lineBindHomeMs_', 'lineBindHomeOn_', 'lineBindHomePreview', 'lineBindHomeXmap_', 'lineHubBindHomeAuto_']);
  const lf = git(['diff', '--stat', BASE, '--', 'apps-script/Liff.gs', 'apps-script/Code.gs', 'apps-script/Requests.gs', 'apps-script/Payroll.gs']).trim();
  assert.strictEqual(lf, '', '其他後端檔不可以動：' + lf);
});
console.log('\n' + n + ' 過、0 失敗');
