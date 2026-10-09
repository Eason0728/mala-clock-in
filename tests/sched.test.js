// 出勤班表（2026-10-10）：Sched.gs 解析排班系統 Gist、摘要、下一個班、認人、回應不外洩其他欄位。
// 測試資料全是假的（測試一～三）；真資料的逐人比對在 private repo mala-clock-schedule 的裁判腳本。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const hubSrc = fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

// ── 假 Gist：照排班系統實際的怪寫法（C1 沒冒號、F 兩段相連沒分隔、事 沒時間、H1 被隱藏）──
function gist(extra) {
  return Object.assign({
    mala_employees: [
      { id: 'a1', name: '測試一', wage: 999, phone: '0900', birthday: '01-01', insurance: 1 },
      { id: 'a2', name: '測試 二', wage: 888 },
      { id: 'a3', name: '測試三' }, { id: 'a4', name: '測試三' },
    ],
    mala_shifts: {
      F: { name: 'F班', time: '11:00～14:0017:30～22:30', hours: 8 },
      C1: { name: 'C1班', time: '1700~2100', hours: 4 },
      '事': { name: '事假', time: '', hours: 0 },
      X: { name: '奇怪班', time: '1730到2200', hours: 5 },
    },
    mala_hidden_shifts: ['H1'],
    mala_locks: ['2026_9', '2026_10'],
    mala_sch_2026_9: { a1: { 1: 'A', 2: '休' } },
    mala_sch_2026_10: { a1: { 1: 'F', 2: 'C1', 3: '休', 4: '事', 5: '國', 6: 'E', 10: 'C', 12: 'H1', 13: 'ZZ', 31: 'A' },
                        a2: { 1: '休' } },
  }, extra || {});
}

let fetchCalls = 0, fetchBody = null, fetchCode = 200, cacheStore = {}, props = {}, mine = [];
const sb = {
  console, Date, JSON, Math, String, Number, isNaN, parseInt, Object, Array,
  verifyLineIdToken_: (t) => (t === 'good' ? 'U1' : null),
  lineHubThrottled_: () => false,
  lineHubMine_: () => mine,
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
  UrlFetchApp: { fetch: () => { fetchCalls++; return { getResponseCode: () => fetchCode, getContentText: () => fetchBody }; } },
  Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? sb.__date : sb.__hm) },
  __date: '2026-10-10', __hm: '12:00',
};
vm.createContext(sb);
vm.runInContext([fs.readFileSync(ROOT + '/apps-script/Sched.gs', 'utf8'), extract(hubSrc, 'lineHubNormName_')].join('\n'), sb);
// vm 內建出來的陣列／物件跨 realm，deepStrictEqual 會判不等 → 一律過一次 JSON
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
['schedParseTime_', 'schedShifts_', 'schedSubset_', 'schedMonth_'].forEach((f) => { const o = sb[f]; sb[f] = (...a) => J(o(...a)); });
const reset = (g) => { fetchCalls = 0; fetchCode = 200; fetchBody = JSON.stringify(g || gist()); cacheStore = {}; props = {}; };
const bind = (name, empId, code) => { mine = [{ st: { code: code === undefined ? '' : code }, row: { emp_id: empId || 'E01', name: name } }]; };
const call = (b) => JSON.parse(JSON.stringify(sb.handleLineHubSched_(Object.assign({ id_token: 'good' }, b || {}))));

// ── 解析 ──
ok('時間解析：標準單段補零', () => assert.deepStrictEqual(sb.schedParseTime_('9:00～17:30'), [['09:00', '17:30']]));
ok('時間解析：兩段以換行分隔', () => assert.deepStrictEqual(sb.schedParseTime_('11:00～14:00\n17:30～22:30'), [['11:00', '14:00'], ['17:30', '22:30']]));
ok('時間解析：兩段相連沒分隔（真資料的 F）', () => assert.deepStrictEqual(sb.schedParseTime_('11:00～14:0017:30～22:30'), [['11:00', '14:00'], ['17:30', '22:30']]));
ok('時間解析：沒冒號＋半形波浪（真資料的 C1）', () => assert.deepStrictEqual(sb.schedParseTime_('1700~2100'), [['17:00', '21:00']]));
ok('時間解析：休假類沒時段', () => { ['－', '特休假', '', null].forEach((t) => assert.deepStrictEqual(sb.schedParseTime_(t), [])); });
ok('班別表：預設＋覆蓋−隱藏', () => {
  const s = sb.schedShifts_(gist());
  assert.strictEqual(s.F.time, '11:00～14:0017:30～22:30');
  assert.strictEqual(s.A.hours, 8.5);
  assert.ok(!s.H1, 'H1 被隱藏');
  assert.strictEqual(s['事'].time, '');
});
ok('Gist 值是 JSON 字串也接得住', () => {
  const g = gist(); const g2 = {}; Object.keys(g).forEach((k) => { g2[k] = JSON.stringify(g[k]); });
  const sub = sb.schedSubset_(g2, [{ y: 2026, m: 10 }]);
  assert.strictEqual(sub.emps.a1, '測試一'); assert.ok(sub.sch['2026_10'].a1); assert.deepStrictEqual(sub.locks, ['2026_9', '2026_10']);
});
ok('子集不帶薪資／電話／生日', () => {
  const s = JSON.stringify(sb.schedSubset_(gist(), [{ y: 2026, m: 10 }]));
  ['wage', 'phone', 'birthday', 'insurance', '999', '0900'].forEach((w) => assert.ok(s.indexOf(w) < 0, '不該有 ' + w));
});

// ── 月曆＋摘要 ──
const sub10 = () => sb.schedSubset_(gist(), [{ y: 2026, m: 9 }, { y: 2026, m: 10 }]);
ok('月曆列滿 31 天、各類日子', () => {
  const r = sb.schedMonth_(sub10(), 'a1', 2026, 10, { date: '2026-10-10', hm: '12:00' });
  assert.strictEqual(r.days.length, 31);
  const d = (i) => r.days[i - 1];
  assert.deepStrictEqual([d(1).work, d(1).segs.length, d(1).hours], [true, 2, 8]);
  assert.deepStrictEqual([d(2).work, d(2).segs, d(2).hours], [true, [['17:00', '21:00']], 4]);
  assert.deepStrictEqual([d(3).work, d(3).label], [false, '休假']);
  assert.deepStrictEqual([d(4).work, d(4).label], [false, '事假']);
  assert.deepStrictEqual([d(5).work, d(5).label], [false, '國定假日']);
  assert.deepStrictEqual([d(7).code, d(7).work], ['', false]);
  assert.deepStrictEqual([d(12).label, d(12).work], ['H1', false], '被隱藏的班別＝未知代碼');
  assert.deepStrictEqual([d(13).label, d(13).work], ['ZZ', false]);
});
ok('摘要：上班天／休假天（空白不算）／時數', () => {
  const r = sb.schedMonth_(sub10(), 'a1', 2026, 10, null);
  // 上班：1 F8、2 C1 4、6 E8.5、10 C5.5、31 A8.5 → 5 天 34.5；休假：3 休、4 事、5 國、12 H1、13 ZZ → 5 天
  assert.deepStrictEqual(r.summary, { work_days: 5, off_days: 5, hours: 34.5 });
});
ok('有時鐘字但解析不出時段：算上班、標時間未設定', () => {
  const g = gist(); g.mala_sch_2026_10.a1[20] = 'X';
  const r = sb.schedMonth_(sb.schedSubset_(g, [{ y: 2026, m: 10 }]), 'a1', 2026, 10, null);
  assert.deepStrictEqual([r.days[19].work, r.days[19].time_unknown, r.days[19].hours], [true, true, 5]);
});

// ── 下一個班 ──
const nxt = (date, hm) => sb.schedMonth_(sub10(), 'a1', 2026, 10, { date, hm }).next;
ok('下一個班：今天沒班 → 往後找', () => assert.strictEqual(nxt('2026-10-07', '08:00').date, '2026-10-10'));
ok('下一個班：今天的班還沒下班 → 就是今天', () => assert.strictEqual(nxt('2026-10-10', '20:00').date, '2026-10-10'));
ok('下一個班：今天已下班 → 往後找', () => assert.strictEqual(nxt('2026-10-10', '22:30').date, '2026-10-31'));
ok('下一個班：本月沒有了 → null（不看下個月）', () => assert.strictEqual(nxt('2026-10-31', '23:40'), null));
ok('下一個班：兩段班看最後一段', () => assert.strictEqual(nxt('2026-10-01', '15:00').date, '2026-10-01'));
ok('看上個月：next 一律 null', () => assert.strictEqual(sb.schedMonth_(sub10(), 'a1', 2026, 9, { date: '2026-10-10', hm: '00:00' }).next, null));

// ── 認人 ──
ok('同名剛好一人（去空白比）', () => { assert.strictEqual(sb.schedMatch_(sub10(), 'E1', '測試一', {}), 'a1'); assert.strictEqual(sb.schedMatch_(sub10(), 'E2', '測試二', {}), 'a2'); });
ok('同名兩人 → 不猜', () => assert.strictEqual(sb.schedMatch_(sub10(), 'E3', '測試三', {}), null));
ok('沒有同名 → null', () => assert.strictEqual(sb.schedMatch_(sub10(), 'E9', '測試九', {}), null));
ok('對照表優先，且對照到不存在的人不算', () => {
  assert.strictEqual(sb.schedMatch_(sub10(), 'E3', '測試三', { E3: 'a4' }), 'a4');
  assert.strictEqual(sb.schedMatch_(sub10(), 'E9', '測試一', { E9: 'nope' }), 'a1');
});

// ── API ──
ok('API ready：本月、只有自己的資料', () => {
  reset(); bind('測試一');
  const r = call();
  assert.deepStrictEqual([r.ok, r.status, r.ym, r.months, r.name], [true, 'ready', '2026-10', ['2026-09', '2026-10'], '測試一']);
  assert.strictEqual(r.days.length, 31); assert.strictEqual(r.next.date, '2026-10-10');
  const s = JSON.stringify(r);
  ['wage', 'phone', 'birthday', 'insurance', 'a2', 'a3', '測試三', '測試 二'].forEach((w) => assert.ok(s.indexOf(w) < 0, '回應不該有 ' + w));
});
ok('API 上個月', () => { reset(); bind('測試一'); const r = call({ ym: '2026-09' }); assert.deepStrictEqual([r.status, r.days.length, r.next], ['ready', 30, null]); });
ok('API 只收本月與上月', () => { reset(); bind('測試一'); ['2026-11', '2026-08', 'abc'].forEach((ym) => assert.strictEqual(call({ ym }).error, 'bad_month')); });
ok('API 假 id_token', () => assert.strictEqual(call({ id_token: 'bad' }).error, 'invalid_id_token'));
ok('API 沒綁光復（只綁別店）→ not_bound，不讀 Gist', () => { reset(); bind('測試一', 'X1', 'mztjs'); const r = call(); assert.strictEqual(r.status, 'not_bound'); assert.strictEqual(fetchCalls, 0); });
ok('API 離職＝lineHubMine_ 只認在職，沒拿到 → not_bound', () => { reset(); mine = []; assert.strictEqual(call().status, 'not_bound'); });
ok('API 該月沒鎖 → not_locked、不回班表', () => {
  reset(gist({ mala_locks: ['2026_9'] })); bind('測試一');
  const r = call(); assert.strictEqual(r.status, 'not_locked'); assert.ok(!r.days);
});
ok('API Gist 沒有 mala_locks 鍵 → not_locked', () => { const g = gist(); delete g.mala_locks; reset(g); bind('測試一'); assert.strictEqual(call().status, 'not_locked'); });
ok('API 對不上（同名兩人）→ not_matched', () => { reset(); bind('測試三'); assert.strictEqual(call().status, 'not_matched'); });
ok('API 對照表讓同名兩人也能對上', () => { reset(); props.SCHED_NAME_MAP = JSON.stringify({ E3: 'a3' }); bind('測試三', 'E3'); assert.strictEqual(call().status, 'no_schedule'); });
ok('API 對上但該月沒有他的班 → no_schedule', () => { reset(); bind('測試二'); assert.strictEqual(call({ ym: '2026-09' }).status, 'no_schedule'); });
ok('API Gist 讀不到 → sched_unreadable（重試一次）', () => {
  reset(); fetchCode = 500; bind('測試一'); const r = call(); assert.deepStrictEqual([r.ok, r.error], [false, 'sched_unreadable']); assert.strictEqual(fetchCalls, 2);
});
ok('API Gist 不是 JSON → sched_unreadable', () => { reset(); fetchBody = '<html>'; bind('測試一'); assert.strictEqual(call().error, 'sched_unreadable'); });
ok('API 快取：第二次不再讀 Gist；跨月快取作廢', () => {
  reset(); bind('測試一'); call(); call(); assert.strictEqual(fetchCalls, 1);
  sb.__date = '2026-11-01'; const r = call(); sb.__date = '2026-10-10';
  assert.strictEqual(fetchCalls, 2); assert.deepStrictEqual(r.months, ['2026-10', '2026-11']); assert.strictEqual(r.status, 'not_locked');
});
ok('API 1 月的上個月是去年 12 月', () => {
  reset(gist({ mala_locks: ['2025_12'], mala_sch_2025_12: { a1: { 1: 'A' } } })); bind('測試一');
  sb.__date = '2026-01-05'; const r = call({ ym: '2025-12' }); sb.__date = '2026-10-10';
  assert.deepStrictEqual([r.status, r.months], ['ready', ['2025-12', '2026-01']]);
});

// ── LineHub 接線 ──
ok('選單「出勤班表」回卡片、按鈕開 ?view=sched；handler 已掛', () => {
  assert.ok(/'出勤班表': function \(\) \{ return lineHubSchedCard_\(\); \}/.test(hubSrc));
  assert.ok(/line_hub_sched: function \(b\) \{ return handleLineHubSched_\(b\); \}/.test(hubSrc));
  assert.ok(extract(hubSrc, 'lineHubSchedCard_').indexOf("LINE_HUB_LIFF_URL + '?view=sched'") > 0);
  assert.ok(hubSrc.indexOf('出勤班表功能還在準備中') < 0);
});

console.log('\n' + n + ' 項全過');
