// 申請頁開頁資料 stores 多帶 support（2026-11-18，一次填兩段的加班防呆）：
// 名冊 src_store 有值（自動加入的支援帳號）→ support:true；沒有（原單位）→ false。
// 走真的 lineHubMine_：第一次（讀名冊）與 5 分鐘快取命中兩條路徑都要對；其他欄位不變。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const ROOT = __dirname + '/..';
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
function make(rosters) {
  const cache = {};
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, isNaN, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; }, removeAll() {} }) },
    Utilities: { formatDate: () => '2026-11-18' }, LEAVE_TYPES: ['特休假', '事假', '病假'], normCellTs: (v) => String(v) };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  sb.lineHubStores_ = () => [{ code: 'hq', name: '總部' }, { code: 'mztjs', name: '金山' }];
  sb.lineHubRoster_ = (st) => rosters[st.code];
  sb.verifyLineIdToken_ = (t) => (t ? 'U1' : null);
  sb.lineHubThrottled_ = () => false;
  sb.lineHubPayPick_ = () => null; sb.payLeaveTypes = () => []; sb.lineHubPayslipFor_ = () => null;
  sb.lineHubCompFor_ = () => ({ allowed: false });
  return sb;
}
const R = (id, name, src) => ({ emp_id: id, name, active: 'true', line_user_id: 'U1', src_store: src });
const J = (x) => JSON.parse(JSON.stringify(x));
const sup = (r) => J(r.stores.map((s) => [s.code, s.support]));

ok('原單位（src_store 空白）＝false、支援帳號（src_store 有值）＝true；沒有 src_store 欄的舊名冊＝false', () => {
  const sb = make({ hq: [R('HQ-02', '張淳', '')], mztjs: [R('MZTJS16', '張淳', 'hq')] });
  assert.deepStrictEqual(sup(sb.handleLineHubReqInit_({ id_token: 't', lite: true })), [['hq', false], ['mztjs', true]]);
  const old = make({ hq: [{ emp_id: 'E1', name: '甲', active: 'true', line_user_id: 'U1' }], mztjs: [] });
  assert.deepStrictEqual(sup(old.handleLineHubReqInit_({ id_token: 't', lite: true })), [['hq', false]]);
});
ok('5 分鐘快取命中（第二次不再讀名冊）：support 一樣對', () => {
  let reads = 0;
  const sb = make({ hq: [R('HQ-02', '張淳', '')], mztjs: [R('MZTJS16', '張淳', ' hq ')] });
  const rd = sb.lineHubRoster_; sb.lineHubRoster_ = (st) => { reads++; return rd(st); };
  const a = sb.handleLineHubReqInit_({ id_token: 't', lite: true }), r1 = reads;
  const b = sb.handleLineHubReqInit_({ id_token: 't', lite: true });
  assert.ok(r1 > 0 && reads === r1, '第二次應該走快取：' + reads);
  assert.deepStrictEqual(sup(b), [['hq', false], ['mztjs', true]]); assert.deepStrictEqual(J(a.stores), J(b.stores));
});
ok('其他欄位照舊（code、name、emp_id、emp_name 沒動，只多 support）', () => {
  const sb = make({ hq: [R('HQ-02', '張淳', '')], mztjs: [R('MZTJS16', '張淳', 'hq')] });
  const r = sb.handleLineHubReqInit_({ id_token: 't', lite: true });
  assert.deepStrictEqual(J(r.stores[1]), { code: 'mztjs', name: '金山', emp_id: 'MZTJS16', emp_name: '張淳', support: true });
  assert.deepStrictEqual(J(Object.keys(r).sort()), ['comp', 'leave_types', 'lite', 'ok', 'punch_store', 'quota', 'stores']);
});
console.log('\n' + n + ' 過、0 失敗');
