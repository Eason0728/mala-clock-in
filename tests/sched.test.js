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
      { id: 'a1', name: '測試一', isFullTime: true, wage: 999, phone: '0900', birthday: '01-01', insurance: 1 },
      { id: 'a2', name: '測試 二', isFullTime: true, wage: 888 },
      { id: 'p1', name: '計時一', isFullTime: false },
      { id: 'a3', name: '測試三' }, { id: 'a4', name: '測試三' },
    ],
    mala_shifts: {
      F: { name: 'F班', time: '11:00～14:0017:30～22:30', hours: 8, breakH: 0, isOff: false },
      F1: { name: 'F1班', time: '11:00～14:00\n17:00～22:00', hours: 8, breakH: 0, isOff: false },
      C1: { name: 'C1班', time: '1700~2100', hours: 4, breakH: 0, isOff: false },
      '事': { name: '事假', time: '', hours: 0, breakH: 0, isOff: true },
      '公休': { name: '公休', time: '－', hours: 8, breakH: 0, isOff: false },   // 真資料：公休被設成要算 8 小時
      X: { name: '奇怪班', time: '1730到2200', hours: 5, breakH: 0, isOff: false },
    },
    mala_hidden_shifts: ['H1'],
    mala_locks: ['2026_9', '2026_10'],
    mala_sch_2026_9: { a1: { 1: 'A', 2: '休' } },
    mala_sch_2026_10: { a1: { 1: 'F', 2: 'C1', 3: '休', 4: '事', 5: '國', 6: 'E', 10: 'C', 12: 'H1', 13: 'ZZ', 31: 'A' },
                        a2: { 1: '休' }, p1: { 2: 'C', 3: '休' } },
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
['schedParseTime_', 'schedShifts_', 'schedSubset_', 'schedMonth_', 'schedDayOf_'].forEach((f) => { const o = sb[f]; sb[f] = (...a) => J(o(...a)); });
const reset = (g) => { fetchCalls = 0; fetchCode = 200; fetchBody = JSON.stringify(g || gist()); cacheStore = {}; props = {}; };
const bind = (name, empId, code) => { mine = [{ st: { code: code === undefined ? '' : code }, row: { emp_id: empId || 'E01', name: name } }]; };
const call = (b) => JSON.parse(JSON.stringify(sb.handleLineHubSched_(Object.assign({ id_token: 'good' }, b || {}))));

// ── 解析 ──
ok('時間解析：標準單段補零', () => assert.deepStrictEqual(sb.schedParseTime_('9:00～17:30'), [['09:00', '17:30']]));
ok('時間解析：兩段以換行分隔', () => assert.deepStrictEqual(sb.schedParseTime_('11:00～14:00\n17:30～22:30'), [['11:00', '14:00'], ['17:30', '22:30']]));
ok('時間解析：兩段相連沒分隔（真資料的 F）', () => assert.deepStrictEqual(sb.schedParseTime_('11:00～14:0017:30～22:30'), [['11:00', '14:00'], ['17:30', '22:30']]));
ok('時間解析：沒冒號＋半形波浪（真資料的 C1）', () => assert.deepStrictEqual(sb.schedParseTime_('1700~2100'), [['17:00', '21:00']]));
ok('預設班別與排班系統 index.html 的 DEFAULT_SHIFTS 一致（找得到排班系統原始碼時才比）', () => {
  const f = path.join(process.env.HOME || '', 'mala-schedule', 'index.html');
  if (!fs.existsSync(f)) { console.log('  （略過：本機沒有 ~/mala-schedule）'); return; }
  const src = fs.readFileSync(f, 'utf8'); const i = src.indexOf('const DEFAULT_SHIFTS = {');
  const blk = src.slice(i, src.indexOf('};', i));
  const re = /^\s*'?([^':\s]+)'?\s*:\s*\{name:'([^']*)',\s*time:'([^']*)',\s*hours:([\d.]+),\s*breakH:([\d.]+)[^}]*isOff:(true|false)/gm;
  let m, cnt = 0;
  while ((m = re.exec(blk))) {
    cnt++;
    const d = sb.SCHED_DEFAULT_SHIFTS[m[1]];
    assert.ok(d, '少了 ' + m[1]);
    assert.deepStrictEqual([d.name, d.time, d.hours, d.breakH, d.isOff], [m[2], m[3].replace(/\\n/g, '\n'), +m[4], +m[5], m[6] === 'true'], m[1]);
  }
  assert.strictEqual(cnt, Object.keys(sb.SCHED_DEFAULT_SHIFTS).length);
});
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
  assert.deepStrictEqual([d(6).work, d(6).hours], [true, 8], 'E 班 8.5 扣休息 0.5');
  assert.deepStrictEqual([d(2).work, d(2).segs, d(2).hours], [true, [['17:00', '21:00']], 4]);
  assert.deepStrictEqual([d(3).work, d(3).rest, d(3).label], [false, true, '休假']);
  assert.deepStrictEqual([d(4).work, d(4).rest, d(4).label], [false, true, '事假']);
  assert.deepStrictEqual([d(5).work, d(5).rest, d(5).label], [false, true, '國定假日']);
  assert.deepStrictEqual([d(7).code, d(7).work, d(7).rest], ['', false, false], '正職的空白天不算休假');
  assert.deepStrictEqual([d(12).label, d(12).work, d(12).rest], ['H1', false, false], '被隱藏的班別＝未知代碼，兩邊都不算');
  assert.deepStrictEqual([d(13).label, d(13).work, d(13).rest], ['ZZ', false, false]);
});
ok('摘要：照排班畫面——上班天／休假天（休假類＋國）／時數扣休息', () => {
  const r = sb.schedMonth_(sub10(), 'a1', 2026, 10, null);
  // 上班：1 F8、2 C1 4、6 E8.5−0.5、10 C5.5、31 A8.5−0.5 → 5 天 33.5；休假：3 休、4 事、5 國 → 3 天（H1、ZZ 不認得，兩邊都不算）
  assert.deepStrictEqual(r.summary, { work_days: 5, off_days: 3, hours: 33.5 });
});
ok('計時同仁：本月已排班後，空白天算「休」（排班畫面同一條）', () => {
  const r = sb.schedMonth_(sub10(), 'p1', 2026, 10, null);
  assert.deepStrictEqual([r.days[0].code, r.days[0].rest, r.days[30].label], ['休', true, '休假']);
  assert.deepStrictEqual(r.summary, { work_days: 1, off_days: 30, hours: 5.5 });
});
ok('每個預設與自訂班別代碼：上班／休假／時段／時數', () => {
  const s = sub10();
  const T = { A: [true, false, [['15:00', '23:30']], 8], B: [true, false, [['16:00', '23:30']], 7.5], C: [true, false, [['17:00', '22:30']], 5.5],
    C2: [true, false, [['17:30', '23:30']], 6], D: [true, false, [['18:00', '22:30']], 4.5], D1: [true, false, [['18:30', '22:30']], 4],
    E: [true, false, [['09:00', '17:30']], 8], F: [true, false, [['11:00', '14:00'], ['17:30', '22:30']], 8],
    F1: [true, false, [['11:00', '14:00'], ['17:00', '22:00']], 8], C1: [true, false, [['17:00', '21:00']], 4],
    '公休': [true, false, [], 8], '休': [false, true, [], 0], '特': [false, true, [], 0], '指': [false, true, [], 0],
    '國': [false, true, [], 0], '事': [false, true, [], 0] };
  Object.keys(T).forEach((c) => {
    const d = sb.schedDayOf_(s, c);
    assert.deepStrictEqual([d.work, d.rest, J(d.segs), d.hours], T[c], c);
  });
  assert.strictEqual(sb.schedDayOf_(s, '公休').no_time, true, '要上班但沒有時段 → 只寫班別名稱');
});
ok('要上班但時間抓不到時段：算上班、時數照算、不當成「下一個班」', () => {
  const g = gist(); g.mala_sch_2026_10.a1[20] = 'X'; g.mala_sch_2026_10.a1[21] = '公休';
  const s = sb.schedSubset_(g, [{ y: 2026, m: 10 }]);
  const r = sb.schedMonth_(s, 'a1', 2026, 10, { date: '2026-10-20', hm: '00:00' });
  assert.deepStrictEqual([r.days[19].work, r.days[19].no_time, r.days[19].hours], [true, true, 5]);
  assert.strictEqual(r.next.date, '2026-10-31');
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
ok('API 名冊讀不到（有店 unreadable）且沒找到人 → sched_unreadable，不說沒綁', () => {
  reset(); mine = []; const orig = sb.lineHubMine_;
  sb.lineHubMine_ = (u, info) => { if (info) info.unreadable = true; return []; };
  const r = call(); sb.lineHubMine_ = orig;
  assert.deepStrictEqual([r.ok, r.error], [false, 'sched_unreadable']);
});
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
