// 出勤班表：Sched.gs＋SchedPub.gs（營運系統發布的班表）。2026-11-10 月曆版下架：接手日之前不讀任何 Gist。
// 測試資料全是假的。
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

let fetchCalls = 0, fetchBody = null, fetchCode = 200, cacheStore = {}, props = {}, mine = [];
const sb = {
  console, Date, JSON, Math, String, Number, isNaN, parseInt, Object, Array,
  verifyLineIdToken_: (t) => (t === 'good' ? 'U1' : null),
  lineHubThrottled_: () => false,
  lineHubMine_: () => mine,
  CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
  UrlFetchApp: { fetch: () => { fetchCalls++; return { getResponseCode: () => fetchCode, getContentText: () => fetchBody }; } },
  Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? sb.__date : sb.__hm) },
  __date: '2026-10-10', __hm: '12:00',
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  getSS: () => fakeSS,
};
// 假試算表（sched_pub 分頁）：getDataRange().getValues()、getRange(r,c,1,n).setNumberFormat().setValues()
let pubRows = null;
const fakeSheet = {
  getDataRange: () => ({ getValues: () => pubRows.map((r) => r.slice()) }),
  getLastRow: () => pubRows.length,
  getRange: (r, c, nr, nc) => { const o = { setNumberFormat: () => o, setValues: (v) => { pubRows[r - 1] = v[0].slice(); } }; return o; },
};
const fakeSS = { getSheetByName: (n) => (n === 'sched_pub' && pubRows ? fakeSheet : null), insertSheet: () => { pubRows = []; return fakeSheet; } };
vm.createContext(sb);
vm.runInContext([fs.readFileSync(ROOT + '/apps-script/Sched.gs', 'utf8'), fs.readFileSync(ROOT + '/apps-script/SchedPub.gs', 'utf8'), extract(hubSrc, 'lineHubNormName_')].join('\n'), sb);
// vm 內建出來的陣列／物件跨 realm，deepStrictEqual 會判不等 → 一律過一次 JSON
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const reset = () => { fetchCalls = 0; fetchCode = 200; fetchBody = null; cacheStore = {}; props = {}; pubRows = null; };
const bind = (name, empId, code) => { mine = [{ st: { code: code === undefined ? '' : code }, row: { emp_id: empId || 'E01', name: name } }]; };
const call = (b) => JSON.parse(JSON.stringify(sb.handleLineHubSched_(Object.assign({ id_token: 'good' }, b || {}))));

// ── API（2026-11-10 起：接手日之前＝archived，不讀 Gist）──
ok('API 整個月都在接手日之前 → archived、不讀任何網址', () => {
  reset(); bind('測試一');
  const r = call();
  assert.deepStrictEqual([r.ok, r.status, r.ym, r.months], [true, 'archived', '2026-10', ['2026-09', '2026-10', '2026-11']]);
  assert.ok(!r.days); assert.strictEqual(fetchCalls, 0);
  assert.strictEqual(call({ ym: '2026-09' }).status, 'archived');
});
ok('API 只收上個月、本月、下個月', () => { reset(); bind('測試一'); ['2026-12', '2026-08', 'abc'].forEach((ym) => assert.strictEqual(call({ ym }).error, 'bad_month')); });
ok('API 假 id_token', () => assert.strictEqual(call({ id_token: 'bad' }).error, 'invalid_id_token'));
ok('API 離職＝lineHubMine_ 只認在職，沒拿到 → 11 月 not_bound', () => {
  reset(); mine = []; sb.__date = '2026-11-02'; const r = call(); sb.__date = '2026-10-10';
  assert.strictEqual(r.status, 'not_bound');
});
ok('API 名冊讀不到（有店 unreadable）且沒找到人 → sched_unreadable，不說沒綁', () => {
  reset(); mine = []; const orig = sb.lineHubMine_;
  sb.lineHubMine_ = (u, info) => { if (info) info.unreadable = true; return []; };
  const r = call(); sb.lineHubMine_ = orig;
  assert.deepStrictEqual([r.ok, r.error], [false, 'sched_unreadable']);
});
ok('API 1 月的上個月是去年 12 月（月份清單）', () => {
  reset(); bind('測試一'); sb.__date = '2027-01-05'; const r = call({ ym: '2026-12' }); sb.__date = '2026-10-10';
  assert.deepStrictEqual(r.months, ['2026-12', '2027-01', '2027-02']);
});
ok('程式裡已經沒有月曆版 Gist 的網址與讀取函式', () => {
  const src = fs.readFileSync(ROOT + '/apps-script/Sched.gs', 'utf8');
  ['gist.githubusercontent', '47c876cc', 'schedLoad_', 'UrlFetchApp'].forEach((w) => assert.ok(src.indexOf(w) < 0, '不該還有 ' + w));
});

// ── 自動排班發布（SchedPub.gs，2026-10-11）：營運系統送來的 payload v1 ──
// 範例檔與營運系統共用同一份格式（~/mala-store-ops/test/fixtures/sched-payload-v1.json；這裡有一份相同內容的副本）
const FIX = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/sched-payload-v1.json', 'utf8'));
const pub = (o) => J(sb.handleSchedPublish_(Object.assign(JSON.parse(JSON.stringify(FIX)), { svcKey: 'k1' }, o || {})));
const unpub = (o) => J(sb.handleSchedUnpublish_(Object.assign({ v: 1, action: 'sched_unpublish', store: '', period: 'T01', svcKey: 'k1' }, o || {})));
ok('發布：沒設金鑰或金鑰錯 → unauthorized；v 不是 1 或 2 → bad_version；格子不是 28 格 → bad_input', () => {
  reset(); assert.strictEqual(pub().error, 'unauthorized');
  props.SCHED_SVC_KEY = 'k1';
  assert.strictEqual(pub({ svcKey: 'x' }).error, 'unauthorized');
  assert.strictEqual(pub({ v: 3 }).error, 'bad_version');
  assert.strictEqual(pub({ v: 0 }).error, 'bad_version');
  assert.strictEqual(pub({ v: '2' }).error, 'bad_version');
  const bad = JSON.parse(JSON.stringify(FIX)); bad.rows[0].cells.pop();
  assert.strictEqual(pub({ rows: bad.rows }).error, 'bad_input');
  assert.strictEqual(pubRows, null, '失敗不能建分頁或寫入');
});
ok('發布：寫入、同 op_id 重送回同結果、較舊 seq 回 stale、撤回留墓碑、舊發布晚到不復活', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  assert.deepStrictEqual(pub(), { ok: true, seq: FIX.seq });
  assert.deepStrictEqual(pub(), { ok: true, seq: FIX.seq });                       // 同 op_id
  assert.strictEqual(pubRows.length, 2);
  assert.deepStrictEqual(pub({ op_id: 'other' }), { ok: false, error: 'stale', seq: FIX.seq });   // 同 seq 不同 op：回目前 seq
  assert.deepStrictEqual(unpub({ seq: FIX.seq + 1, op_id: 'u1' }), { ok: true, seq: FIX.seq + 1 });
  assert.strictEqual(pubRows[1][3], '');                                            // 墓碑：資料清空
  assert.strictEqual(pub({ op_id: 'late' }).error, 'stale');                        // 舊的發布晚到
  assert.strictEqual(pubRows[1][3], '');
  assert.deepStrictEqual(pub({ seq: FIX.seq + 2, op_id: 'p2' }), { ok: true, seq: FIX.seq + 2 });
  const stored = JSON.parse(pubRows[1][3]);
  assert.deepStrictEqual(Object.keys(stored.rows[0]).sort(), ['cells', 'emp_id', 'name']);   // 多送的欄位被丟掉
});
ok('11 月起讀發布的班表：用 emp_id 對人、每家店都接、還沒發布 → not_locked', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  sb.__date = '2026-11-02'; sb.__hm = '08:00';
  bind('不同名字也沒關係', 'E001', '');
  assert.strictEqual(call().status, 'not_locked');
  pub();
  const r = call();
  assert.deepStrictEqual([r.status, r.ym, r.months], ['ready', '2026-11', ['2026-10', '2026-11', '2026-12']]);
  assert.strictEqual(r.days.length, 30);
  assert.deepStrictEqual([r.days[0].label, r.days[0].segs, r.days[0].hours, r.days[0].work], ['早班', [['10:00', '19:00']], 8, true]);
  assert.deepStrictEqual([r.days[1].label, r.days[1].rest], ['例假', true]);
  assert.strictEqual(r.days[3].label, '晚班（休息日出勤）');
  assert.strictEqual(r.days[4].label, '特休');
  assert.strictEqual(r.next.date, '2026-11-03');
  assert.deepStrictEqual([r.days[28].label, r.days[28].pending], ['尚未發布', true]);           // 11/29 屬 T02、還沒發布：明講尚未發布，不留白                                  // 11/2 是例假，下一個班是 11/3
  assert.strictEqual(fetchCalls, 0, '不讀任何外部網址');
  assert.ok(JSON.stringify(r).indexOf('E002') < 0, '不能看到別人的班');
  // 墨竹亭金山的同仁（只綁 mztjs）也看得到自己店發布的班表
  bind('金山同仁', 'E001', 'mztjs');
  assert.strictEqual(call().status, 'not_locked');
  pub({ store: 'mztjs', op_id: 'js1' });
  assert.strictEqual(call().status, 'ready');
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});
// ── 工作站別（2026-10-19）：payload v2 = v1 + cell.w + 頂層 stations；沒有站別仍送 v1 ──
const FIX2 = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/sched-payload-v2-stations.json', 'utf8'));
const pub2 = (o) => J(sb.handleSchedPublish_(Object.assign(JSON.parse(JSON.stringify(FIX2)), { svcKey: 'k1' }, o || {})));
ok('站別：v1 舊資料照舊（接受、不帶 w／stations、day 沒有 station）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1'; sb.__date = '2026-11-02'; sb.__hm = '08:00'; bind('x', 'E001', '');
  assert.deepStrictEqual(pub(), { ok: true, seq: 1 });
  const stored = JSON.parse(pubRows[1][3]);
  assert.strictEqual(stored.stations, undefined);
  assert.ok(JSON.stringify(stored).indexOf('"w"') < 0);
  const r = call(); assert.strictEqual(r.status, 'ready');
  assert.ok(!r.days.some((d) => 'station' in d), 'v1 不該有 station');
  assert.ok(!('station' in r.next));
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});
ok('站別：v2 接受；清理保留 cell.w 與頂層 stations（其他欄位照舊被丟掉）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  assert.deepStrictEqual(pub2(), { ok: true, seq: 1 });
  const stored = JSON.parse(pubRows[1][3]);
  assert.deepStrictEqual(stored.stations, FIX2.stations);
  assert.deepStrictEqual(stored.rows[0].cells.map((c) => c.w), FIX2.rows[0].cells.map((c) => c.w));
  assert.deepStrictEqual(stored.rows[2].cells.filter((c) => c.w).length, 1);
  assert.deepStrictEqual(Object.keys(stored).sort(), ['rows', 'shifts', 'start', 'stations']);
  assert.deepStrictEqual(Object.keys(stored.rows[0]).sort(), ['cells', 'emp_id', 'name']);
});
ok('站別：清理的格式與長度上限（站名、站別 id 截斷；壞項目丟掉；空陣列不留 stations）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  const long = 'x'.repeat(100);
  const rows = JSON.parse(JSON.stringify(FIX2.rows)); rows[0].cells[0].w = long;
  pub2({ rows: rows, stations: [{ id: 'ST1', name: long }, { id: '', name: '空id' }, null, { id: 'ST2' }, { id: 'ST3', name: 123 }] });
  const st = JSON.parse(pubRows[1][3]);
  assert.deepStrictEqual(st.stations.map((s) => s.id), ['ST1', 'ST3']);
  assert.strictEqual(st.stations[0].name.length, 20);
  assert.strictEqual(st.stations[1].name, '123');
  assert.strictEqual(st.rows[0].cells[0].w.length, 32);
  reset(); props.SCHED_SVC_KEY = 'k1';
  pub2({ op_id: 'e', stations: [] });
  assert.strictEqual(JSON.parse(pubRows[1][3]).stations, undefined);
  reset(); props.SCHED_SVC_KEY = 'k1';
  const many = []; for (let i = 0; i < 50; i++) many.push({ id: 'S' + i, name: 'n' + i });
  pub2({ stations: many });
  assert.strictEqual(JSON.parse(pubRows[1][3]).stations.length, 50, '不再有筆數上限（上線前審查）：由整體 45,000 字上限保護');
});
ok('站別：31 個站都收、都能顯示（第 31 站的格子顯示站名）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  const many = []; for (let i = 1; i <= 31; i++) many.push({ id: 'ST' + i, name: '站' + i });
  const rows = JSON.parse(JSON.stringify(FIX2.rows)); rows[0].cells[0].w = 'ST31';
  pub2({ rows: rows, stations: many });
  const st = JSON.parse(pubRows[1][3]);
  assert.strictEqual(st.stations.length, 31);
  assert.strictEqual(st.stations[30].name, '站31');
  assert.strictEqual(J(sb.schedPubDay_({ t: 'W', s: 'S1', w: 'ST31' }, FIX2.shifts, st.stations)).station, '站31');
});
ok('站別：schedPubDay_ 有站／沒站／找不到站／非上班格', () => {
  const shifts = FIX2.shifts, stations = FIX2.stations;
  const d1 = J(sb.schedPubDay_({ t: 'W', s: 'S1', w: 'ST1' }, shifts, stations));
  assert.strictEqual(d1.station, '炒鍋'); assert.strictEqual(d1.label, '早班'); assert.strictEqual(d1.work, true);
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'W', s: 'S1' }, shifts, stations))), '沒站');
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'W', s: 'S1', w: 'GONE' }, shifts, stations))), '找不到站');
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'W', s: 'S1', w: 'ST1' }, shifts, []))), 'stations 空');
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'W', s: 'S1', w: 'ST1' }, shifts))), '舊呼叫沒傳 stations');
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'R', w: 'ST1' }, shifts, stations))), '休假格不帶');
  assert.ok(!('station' in J(sb.schedPubDay_({ t: 'W', s: 'NOPE', w: 'ST1' }, shifts, stations))), '班別不存在');
  assert.strictEqual(J(sb.schedPubDay_({ t: 'H', s: 'S2', w: 'ST2' }, shifts, stations)).station, '外場');
});
ok('站別：一路到 LIFF 回應（days 與 next 都帶 station；沒站的人沒有）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1'; sb.__date = '2026-11-02'; sb.__hm = '08:00';
  pub2();
  bind('甲', 'E001', '');
  let r = call();
  assert.strictEqual(r.days[0].station, '炒鍋');            // 11/1 S1 ST1
  assert.strictEqual(r.days[5].station, '外場');            // 11/6 S2 ST2
  assert.ok(!('station' in r.days[1]), '例假不帶');
  assert.deepStrictEqual([r.next.date, r.next.station], ['2026-11-03', '炒鍋']);
  bind('乙', 'E002', ''); r = call();
  assert.deepStrictEqual([r.days[1].station, r.days[3].station, r.next.date, r.next.station], ['炒鍋', '外場', '2026-11-02', '炒鍋']);   // E002：11/1 例假，11/2 晚班在炒鍋
  bind('丙', 'E003', ''); r = call();
  assert.strictEqual(r.days[0].station, '炒鍋'); assert.ok(!('station' in r.days[2]), '沒排站的格子');
  assert.ok(!('station' in r.next), '下一個班沒站就不帶');
  // 站別被刪掉（找不到）：日子仍在，只是沒站
  reset(); props.SCHED_SVC_KEY = 'k1'; pub2({ stations: [{ id: 'ST2', name: '外場' }] }); bind('甲', 'E001', '');
  r = call(); assert.ok(!('station' in r.days[0])); assert.strictEqual(r.days[5].station, '外場'); assert.ok(!('station' in r.next));
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});
ok('站別＋備註：v2（有站別）也收午餐／晚餐備註，LINE 那天同時帶站別與備註', () => {
  reset(); props.SCHED_SVC_KEY = 'k1'; sb.__date = '2026-11-02'; sb.__hm = '08:00';
  pub2({ notes: [{ d: '2026-11-01', lunch: '團體訂位' }] });
  const stored = JSON.parse(pubRows[1][3]);
  assert.deepStrictEqual(stored.notes, { '2026-11-01': { lunch: '團體訂位' } });
  bind('甲', 'E001', '');
  const r = call();
  assert.deepStrictEqual([r.days[0].station, r.days[0].note], ['炒鍋', { lunch: '團體訂位' }]);
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});
ok('站別：schedSummarize_ 的 next 有站才帶；訂貨小幫手名單不受影響', () => {
  const days = [{ d: 1, work: true, rest: false, segs: [['10:00', '19:00']], hours: 8, label: '早班', station: '炒鍋' },
                { d: 2, work: true, rest: false, segs: [['10:00', '19:00']], hours: 8, label: '早班' }];
  const a = J(sb.schedSummarize_(days, '2026-11', { date: '2026-11-01', hm: '08:00' }));
  assert.strictEqual(a.next.station, '炒鍋');
  const b = J(sb.schedSummarize_(days, '2026-11', { date: '2026-11-02', hm: '08:00' }));
  assert.ok(!('station' in b.next));
});

ok('午餐／晚餐備註：選填、只收本期日期、裁成 60 字、跟著當天上班的店顯示（2026-10-26）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  sb.__date = '2026-11-02'; sb.__hm = '08:00';
  bind('不同名字也沒關係', 'E001', '');
  assert.deepStrictEqual(pub(), { ok: true, seq: FIX.seq });                              // 舊版沒帶 notes 照收
  assert.strictEqual(JSON.parse(pubRows[1][3]).notes, undefined);
  const long = '團'.repeat(80);
  assert.deepStrictEqual(pub({ seq: FIX.seq + 1, op_id: 'n1', notes: [
    { d: '2026-11-01', lunch: ' 30 人團體訂位 ', dinner: '' },
    { d: '2026-11-03', dinner: long },
    { d: '2026-12-31', lunch: '期外不收' }, { d: 'x', lunch: '壞日期' }, { d: '2026-11-05', lunch: '   ' }, null,
  ] }), { ok: true, seq: FIX.seq + 1 });
  const st = JSON.parse(pubRows[1][3]).notes;
  assert.deepStrictEqual(Object.keys(st).sort(), ['2026-11-01', '2026-11-03']);
  assert.deepStrictEqual(st['2026-11-01'], { lunch: '30 人團體訂位' });
  assert.strictEqual(st['2026-11-03'].dinner.length, 60);
  const r = call();
  assert.deepStrictEqual(r.days[0].note, { lunch: '30 人團體訂位' });
  assert.strictEqual(r.days[1].note, undefined);
  assert.strictEqual(r.days[2].note.dinner.length, 60);
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});
ok('SCHED_STORE_FROM 改晚 → 接手日之前的日子留白、整月在前＝archived（不再退回月曆版）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1'; pub(); props.SCHED_STORE_FROM = '2026-11-03'; bind('不同名字也沒關係', 'E001', '');
  sb.__date = '2026-11-02'; sb.__hm = '08:00';
  const r = call(); const r0 = call({ ym: '2026-10' }); sb.__date = '2026-10-10'; sb.__hm = '12:00';
  assert.strictEqual(r.status, 'ready'); assert.deepStrictEqual([r.days[0].label, r.days[0].work], ['', false]);
  assert.strictEqual(r0.status, 'archived'); assert.strictEqual(fetchCalls, 0);
});
ok('GPT 5：讀發布資料時拿不到鎖就只讀不寫快取（不會把舊班表塞回快取）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1'; pub();
  cacheStore = {};
  const orig = sb.LockService;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  const out = J(sb.schedPubLoad_());
  sb.LockService = orig;
  assert.ok(out['|T01'], '照樣讀得到');
  assert.strictEqual(cacheStore['schedpub:v1'], undefined, '沒拿到鎖不寫快取');
  J(sb.schedPubLoad_());
  assert.ok(cacheStore['schedpub:v1'], '拿到鎖才寫快取');
});
ok('期別換算與營運系統一致', () => {
  assert.strictEqual(sb.schedPubPeriodOf_('2026-10-04'), 'T00');
  assert.strictEqual(sb.schedPubPeriodOf_('2026-11-28'), 'T01');
  assert.strictEqual(sb.schedPubPeriodOf_('2026-11-29'), 'T02');
  assert.strictEqual(sb.schedPubIndex_('2026-11-29'), 0);
  assert.strictEqual(sb.schedPubIndex_('2026-12-26'), 27);
});

// ── LineHub 接線 ──
ok('選單「出勤班表」回卡片、按鈕開 ?view=sched；handler 已掛', () => {
  assert.ok(/'出勤班表': function \(\) \{ return lineHubSchedCard_\(\); \}/.test(hubSrc));
  assert.ok(/line_hub_sched: function \(b\) \{ return handleLineHubSched_\(b\); \}/.test(hubSrc));
  assert.ok(extract(hubSrc, 'lineHubSchedCard_').indexOf("LINE_HUB_LIFF_URL + '?view=sched'") > 0);
  assert.ok(hubSrc.indexOf('出勤班表功能還在準備中') < 0);
  assert.ok(/sched_publish: function \(b\) \{ return handleSchedPublish_\(b\); \}/.test(hubSrc));
  assert.ok(/sched_unpublish: function \(b\) \{ return handleSchedUnpublish_\(b\); \}/.test(hubSrc));
});

// 營運系統實際產出的 v2 範例（~/mala-store-ops test/fixtures/sched-payload-v2-stations.json 的複本，兩邊要一致）
ok('站別：營運系統產出的 v2 範例可收、每個有站的上班格都顯示站名', () => {
  const FX = JSON.parse(fs.readFileSync(ROOT + '/tests/fixtures/sched-payload-v2-from-store-ops.json', 'utf8'));
  reset(); props.SCHED_SVC_KEY = 'k1'; sb.__date = '2026-11-02'; sb.__hm = '08:00';
  const res = J(sb.handleSchedPublish_(Object.assign(JSON.parse(JSON.stringify(FX)), { svcKey: 'k1' })));
  assert.strictEqual(res.ok, true);
  const name = {}; FX.stations.forEach((x) => { name[x.id] = x.name; });
  let hit = 0;
  FX.rows.forEach((row) => {
    bind('x', row.emp_id, ''); const r = call();
    row.cells.forEach((c, i) => {
      if (c.s && c.w) { assert.strictEqual(r.days[i].station, name[c.w], row.emp_id + ' 第 ' + (i + 1) + ' 天'); hit++; }
      else if (r.days[i]) assert.ok(!('station' in r.days[i]), row.emp_id + ' 第 ' + (i + 1) + ' 天不該有站');
    });
  });
  assert.ok(hit > 0, '範例裡要有站別格');
  sb.__date = '2026-10-10'; sb.__hm = '12:00';
});

ok('站別：休假格帶來的 w 不存（只有上班格存站別）', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  const b = JSON.parse(JSON.stringify(FIX2)); b.rows[0].cells[0] = { t: 'R', w: 'ST1' }; b.rows[0].cells[1] = { t: '', w: 'ST9' };
  assert.strictEqual(J(sb.handleSchedPublish_(Object.assign(b, { svcKey: 'k1' }))).ok, true);
  const stored = JSON.parse(pubRows[1][3]);
  assert.ok(!('w' in stored.rows[0].cells[0]) && !('w' in stored.rows[0].cells[1]));
});

ok('分段班：segs 收進來、LINE 一天顯示多段；格式不對整個丟掉照舊一整段', () => {
  reset(); props.SCHED_SVC_KEY = 'k1';
  const b = JSON.parse(JSON.stringify(FIX2));
  const TWO = [{ start: '11:00', end: '14:00', break_min: 0 }, { start: '17:30', end: '22:30', break_min: 0 }];
  b.shifts[0].segs = TWO; b.shifts[0].start = '11:00'; b.shifts[0].end = '22:30'; b.shifts[0].break_min = 210;
  if (b.shifts[1]) b.shifts[1].segs = [{ start: 'x', end: '14:00' }, { start: '17:00', end: '21:00' }];
  assert.strictEqual(J(sb.handleSchedPublish_(Object.assign(b, { svcKey: 'k1' }))).ok, true);
  const stored = JSON.parse(pubRows[1][3]);
  assert.deepStrictEqual(stored.shifts[0].segs, TWO);
  if (stored.shifts[1]) assert.ok(!('segs' in stored.shifts[1]), '格式不對不收');
  const d = J(sb.schedPubDay_({ t: 'W', s: stored.shifts[0].id }, stored.shifts, []));
  assert.deepStrictEqual(d.segs, [['11:00', '14:00'], ['17:30', '22:30']]);
  assert.strictEqual(d.hours, 8);
  const one = J(sb.schedPubDay_({ t: 'W', s: 'S1' }, FIX2.shifts, []));
  assert.strictEqual(one.segs.length, 1);
});

console.log('\n' + n + ' 項全過');

ok('假別：營運系統送來的事假、病假等顯示假別名稱，不認得的仍是「請假」（2026-10-31）', () => {
  const lab = (l) => J(sb.schedPubDay_({ t: 'L', l }, [], [])).label;
  assert.deepStrictEqual(['特', '事', '病', '婚', '喪', '公', '產', '陪', '生', '家', '補', '國'].map(lab),
    ['特休', '事假', '病假', '婚假', '喪假', '公假', '產假', '陪產假', '生理假', '家庭照顧假', '補休', '國定假日']);
  assert.strictEqual(lab('X'), '請假');
  const d = J(sb.schedPubDay_({ t: 'L', l: '事' }, [], []));
  assert.strictEqual(d.code, '事'); assert.strictEqual(d.rest, true); assert.strictEqual(d.work, false);
});
