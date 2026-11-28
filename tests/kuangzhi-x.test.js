/**
 * 曠職合約 v1.2 打卡端（2026-11-26）：已發布班表格子的排除代號 x（docs/kuangzhi/contract.md 第 3 節）。
 * 規則白話：
 *   ‧營運系統發布班表時，在「已經是 W」的格子可以多帶 x（dir 總監層級、hq_off 總部同仁開關關、away 支援帳號列、late 瑞光文心上線前）。
 *   ‧打卡端收（SchedPub.gs）：只存 W 格上這四個代號之一；不認得的值、空字串、不是字串、格子不是 W → 丟掉＝當沒有。
 *   ‧薪資掃疑似曠職（Payroll.gs payKzScan_）：那天格子有有效的 x ＝排除（跟瑞光文心上線前同一個處理），不列疑似、不擋鎖月；
 *     x 再判一次（sched_pub 被手改成怪值也不會放寬）。x 不影響已認定的曠職（leave 分頁），也不影響生效日之前的日子。
 *   ‧同仁看的班表（LINE 出勤班表 line_hub_sched、訂貨小幫手 sched_day_roster）不輸出 x。
 *   ‧開關 KUANGZHI_FROM 關：sched_publish、LINE 班表、薪資試算、鎖定的回應跟主線 f21cc25 逐字相同（就算 sched_pub 裡已經有 x）。
 * 手算對照（示意薪資，同 kuangzhi-payroll：正職全薪 34,000；12 月週一～五 A 班 8 小時；開關 12/1、鎖月擋開關 on）：
 *   C1 12/15 W、沒來、沒單、沒有 x            → 疑似 [12/15]；鎖月擋 kz_suspect
 *   C2 12/15 W x=hq_off、沒來                 → 不疑似；鎖得下去；金額 34,000 不變
 *   C3 12/15 W x='zzz'（不認得）／''／1／null  → 照 C1 列疑似、擋鎖月
 *   C4 12/14、12/15、12/16 沒來，12/15 x=dir   → 疑似 [12/14, 12/16]、最長連續 1（12/15 是排除的上班日、照改之前的瑞光文心一樣斷開）；沒 x 時連續 3、到門檻
 *   C5 12/10 已認定曠職、12/10 格子 x=dir     → 照扣 34,000 ÷ 30 × 1 ＝ 1,133（x 只管疑似，不管已認定）
 *   C6 生效日 12/15、12/08 沒來且 x=dir       → 12/08 照舊列在 no_show（生效日前 x 不作用），整個回應跟沒有 x 一樣
 *   C7 開關關、sched_pub 有 x                 → 試算、鎖定跟主線 f21cc25 逐字相同
 * 全部假資料（測試甲～丙、假金鑰）。基準版 KZ_BASE（預設 f21cc25，固定 commit）。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const AS = path.join(ROOT, 'apps-script');
const BASE = process.env.KZ_BASE || 'f21cc25';
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + String(g).slice(0, 1500) + '\n   預期 ' + String(w).slice(0, 1500)); }
};
const J = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const cur = (f) => fs.readFileSync(path.join(AS, f), 'utf8');
const old = (f) => cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f], { encoding: 'utf8', maxBuffer: 64 << 20 });
const SRC = { now: {}, base: {} };
['Code.gs', 'Payroll.gs', 'Requests.gs', 'SchedPub.gs', 'Sched.gs'].forEach((f) => { SRC.now[f] = cur(f); SRC.base[f] = old(f); });
const hasX = (o) => JSON.stringify(o).indexOf('"x"') >= 0;

/* ════ 一、班表發布＋同仁看的班表（Code.gs＋SchedPub.gs＋Sched.gs）════ */
const LEAVE_HEAD = ['日期', '姓名', '假別', '時數'];
function schedEnv(which, props, o) {
  o = o || {};
  const cache = {};
  let pubRows = null;
  const pubSheet = {
    getDataRange: () => ({ getValues: () => pubRows.map((r) => r.slice()) }),
    getLastRow: () => pubRows.length,
    getRange: (r) => { const g = { setNumberFormat: () => g, setValues: (v) => { pubRows[r - 1] = v[0].slice(); } }; return g; },
  };
  const leaveRows = [LEAVE_HEAD].concat(o.leave || []);
  const leaveSheet = { getDataRange: () => ({ getValues: () => leaveRows.map((r) => r.slice()) }), getSheetId: () => 9, getName: () => 'leave' };
  const P = Object.assign({ SCHED_SVC_KEY: 'k1', SCHED_READ_KEY: 'rk' }, props || {});
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d, tz, f) => (f === 'HH:mm' ? '12:00' : '2026-12-10') },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in P ? P[k] : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; } }) },
    __SS: { getSheetByName: (n) => (n === 'sched_pub' && pubRows ? pubSheet : null), insertSheet: () => { pubRows = []; return pubSheet; } },
    __LEAVE_BOOK: { getSheetByName: (n) => (n === 'leave' ? leaveSheet : null) },
  };
  vm.createContext(sb);
  const S = SRC[which];
  vm.runInContext(S['Code.gs'] + '\n' + S['SchedPub.gs'] + '\n' + S['Sched.gs'], sb, { filename: which + '.gs' });
  vm.runInContext(`getSS = function(){ return __SS; };
    verifyLineIdToken_ = function(t){ return t === 'good' ? 'U1' : null; };
    lineHubThrottled_ = function(){ return false; };
    lineHubMine_ = function(){ return [{ st: { code: '' }, row: { emp_id: 'E01', name: '測試甲' } }, { st: { code: 'mztjs' }, row: { emp_id: 'J01', name: '測試甲' } }]; };
    lineHubSS_ = function(){ return __LEAVE_BOOK; };`, sb);
  sb.pubRows = () => pubRows;
  return sb;
}
const START = '2026-11-29';   // T02：11/29～12/26
const dateAt = (i) => new Date(Date.UTC(2026, 10, 29) + i * 86400000).toISOString().slice(0, 10);
// E01 的 28 格：索引 → 格子（含各種 x）；其他格週一～五 W(A)、週六 H、週日 R
const E01X = {
  2: { t: 'W', s: 'A', x: 'dir' }, 3: { t: 'W', s: 'A', w: 'st1', x: 'hq_off' }, 4: { t: 'W', s: 'A', x: 'away' }, 5: { t: 'W', s: 'B', x: 'late' },
  6: { t: 'W', s: 'A', x: 'zzz' }, 7: { t: 'W', s: 'A', x: '' }, 8: { t: 'W', s: 'A', x: 1 }, 9: { t: 'W', s: 'A', x: null }, 10: { t: 'W', s: 'A', x: true },
  11: { t: 'W', s: 'A', x: ['dir'] }, 12: { t: 'W', s: 'A', x: {} }, 13: { t: 'W', s: 'A', x: 'DIR' }, 14: { t: 'W', s: 'A', x: ' dir' },
  15: { t: 'W', s: 'A', x: '__proto__' }, 16: { t: 'W', s: 'A', x: 'constructor' }, 17: { t: 'H', s: 'A', x: 'dir' }, 18: { t: 'R', x: 'dir' },
  19: { t: 'L', l: '特', x: 'dir' }, 20: { t: 'H', x: 'hq_off' }, 21: { t: 'X', x: 'dir' }, 22: { t: 'W', x: 'dir' }, 23: { t: 'W', s: 'A', x: 'toString' },
};
const X_KEPT = { 2: 'dir', 3: 'hq_off', 4: 'away', 5: 'late', 22: 'dir' };   // 規則上只該留下這幾格
const plainCell = (i) => { const w = new Date(dateAt(i) + 'T00:00:00Z').getUTCDay(); return w === 0 ? { t: 'R' } : w === 6 ? { t: 'H' } : { t: 'W', s: 'A' }; };
function payloadOf(withX) {
  return { v: 2, action: 'sched_publish', store: '', period: 'T02', seq: 1, op_id: 'op-x-1', start: START, days: 28, svcKey: 'k1',
    shifts: [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }, { id: 'B', name: '二段班', start: '10:00', end: '21:00', break_min: 0, segs: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }] }],
    stations: [{ id: 'st1', name: '內場' }],
    notes: [{ d: '2026-12-01', lunch: '午餐備註', dinner: '' }],
    rows: [
      { emp_id: 'E01', name: '測試甲', cells: Array.from({ length: 28 }, (_, i) => { const c = E01X[i]; if (!c) return plainCell(i); const o = J(c); if (!withX) delete o.x; return o; }) },
      { emp_id: 'E02', name: '測試乙', cells: Array.from({ length: 28 }, (_, i) => Object.assign(plainCell(i), withX && plainCell(i).t === 'W' && i < 4 ? { x: 'hq_off' } : {})) },
    ] };
}
const stored = (sb) => sb.pubRows().slice(1).map((r) => r[3]);
const dropX = (s) => JSON.stringify(JSON.parse(s), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && 'x' in v ? Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'x')) : v));

console.log('══ 一、收發布（SchedPub.gs schedPubClean_）：只留 W 格上的四個代號 ══');
{
  const now = schedEnv('now', {}), base = schedEnv('base', {});
  const rN = J(now.handleSchedPublish_(payloadOf(true))), rB = J(base.handleSchedPublish_(payloadOf(true)));
  eq(rN, rB, 'sched_publish（帶 x）回應跟主線相同');
  eq(rN, { ok: true, seq: 1 }, '回應 {ok:true, seq:1}');
  const data = JSON.parse(stored(now)[0]);
  const e01 = data.rows[0].cells, kept = {};
  e01.forEach((c, i) => { if ('x' in c) kept[i] = c.x; });
  eq(kept, X_KEPT, 'E01 只留下 W 格的 dir／hq_off／away／late（W 沒班別也留）；zzz、空字串、1、null、true、陣列、物件、大寫、前面空白、__proto__、constructor、toString、H／R／L 格、不認得的格子一律丟掉');
  eq(e01[3], { t: 'W', s: 'A', w: 'st1', x: 'hq_off' }, 'x 排在 t、s、w 之後（其他欄位不動）');
  eq(e01[21], { t: '' }, '不認得的格子照舊清成空格（不留 x）');
  eq(data.rows[1].cells.map((c, i) => (c.x ? i : -1)).filter((i) => i >= 0), [1, 2, 3], 'E02 前 4 天（11/29 週日 R、11/30–12/2 W）：W 格的 hq_off 都留下（3 格）');
  eq(dropX(stored(now)[0]), stored(base)[0], '把 x 拿掉後，存進 sched_pub 的內容跟主線逐字相同（x 是唯一差別）');
  const n2 = schedEnv('now', {}), b2 = schedEnv('base', {});
  eq([J(n2.handleSchedPublish_(payloadOf(false))), stored(n2)], [J(b2.handleSchedPublish_(payloadOf(false))), stored(b2)], '沒帶 x 的發布：回應與存進 sched_pub 的字串都跟主線逐字相同');
  for (const [nm, props] of [['開關開', { KUANGZHI_FROM: '2026-12-01' }], ['開關壞值', { KUANGZHI_FROM: 'on' }]]) {
    const a = schedEnv('now', props); a.handleSchedPublish_(payloadOf(true));
    eq(stored(a), stored(now), nm + '：存的內容跟開關沒設一樣（收發布不看開關；營運系統那端開了才送 x）');
  }
  // too_big 照算（x 也算字數）：做一份去掉 x 剛好在上限內、帶 x 超過的
  const big = (withX) => { const p = payloadOf(false); p.op_id = 'big'; p.rows = Array.from({ length: 60 }, (_, k) => ({ emp_id: 'Z' + k, name: '測試' + k, cells: Array.from({ length: 28 }, () => Object.assign({ t: 'W', s: 'A' }, withX ? { x: 'hq_off' } : {})) })); return p; };
  const len0 = JSON.stringify(now.schedPubClean_(big(false))).length, len1 = JSON.stringify(now.schedPubClean_(big(true))).length;
  eq([len0 <= 45000, len1 > 45000, len1 - len0], [true, true, 60 * 28 * 13], 'too_big 的字數含 x：60 人全 W 不帶 x ' + len0 + ' 字、帶 hq_off ' + len1 + ' 字（每格多 13 字）');
  eq([J(schedEnv('now', {}).handleSchedPublish_(big(true))).error, J(schedEnv('base', {}).handleSchedPublish_(big(true))).error], ['too_big', undefined], '超過上限回 too_big、不寫（主線因為丟掉 x 寫得進去——這是預期的差別）');
}

console.log('\n══ 二、同仁看的班表不輸出 x（schedPubDay_、schedPubDaysFor_、line_hub_sched、sched_day_roster）══');
{
  const pubWith = (which, props, o) => { const s = schedEnv(which, props, o); s.handleSchedPublish_(payloadOf(true)); return s; };
  const pubNo = (which, props, o) => { const s = schedEnv(which, props, o); s.handleSchedPublish_(payloadOf(false)); return s; };
  const views = (s) => ({
    hubDec: J(s.handleLineHubSched_({ id_token: 'good', ym: '2026-12' })),
    hubNov: J(s.handleLineHubSched_({ id_token: 'good', ym: '2026-11' })),
    roster: Array.from({ length: 28 }, (_, i) => J(s.handleSchedDayRoster_({ key: 'rk', date: dateAt(i) }))),
    daysFor: J(s.schedPubDaysFor_(s.schedPubLoad_(), [{ st: { code: '' }, row: { emp_id: 'E01' } }], Array.from({ length: 28 }, (_, i) => dateAt(i)))),
  });
  for (const [nm, props] of [['開關沒設', {}], ['開關開（沒有曠職登記）', { KUANGZHI_FROM: '2026-12-01' }]]) {
    const vN = views(pubWith('now', props)), vNo = views(pubNo('now', props)), vB = views(pubWith('base', {}));
    eq(hasX(vN), false, nm + '：四條路徑的回應裡都沒有 x 欄');
    eq(vN, vNo, nm + '：sched_pub 有沒有 x，四條路徑的回應逐字相同');
    eq(vN, vB, nm + '：跟主線 ' + BASE + ' 逐字相同');
  }
  const kz = views(pubWith('now', { KUANGZHI_FROM: '2026-12-01' }, { leave: [['2026-12-01', '測試甲', '曠職', 8]] }));
  eq([hasX(kz), kz.hubDec.days[0].kz, kz.hubDec.days[0].code], [false, true, 'A'], '開關開、12/1 有曠職登記：那天標 kz、照樣不輸出 x（12/1 格子帶 x=dir）');
  eq(vmDayKeys(), ['code', 'label', 'segs', 'hours', 'work', 'rest'], 'schedPubDay_ 對帶 x 的格子只回這幾欄');
  function vmDayKeys() { const s = schedEnv('now', {}); return Object.keys(J(s.schedPubDay_({ t: 'W', s: 'A', x: 'dir' }, [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }]))); }
}

/* ════ 三、薪資掃疑似（Code.gs＋Payroll.gs＋Requests.gs＋SchedPub.gs，同 kuangzhi-payroll 的假環境）════ */
const KEY = 'test-admin-key';
function load(which, opt) {
  const props = opt.props || {};
  const S = SRC[which];
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); const t = new Date(d.getTime() + 8 * 3600000); return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    __DATA: J(opt.data), __CLOCK: J(opt.clock), __TODAY: opt.today || '2027-01-05', __PUB: J(opt.pub || {}), __PUBSHEET: opt.pubSheet || null,
  };
  vm.createContext(sb);
  vm.runInContext(S['Code.gs'] + '\n' + S['Payroll.gs'] + '\n' + S['Requests.gs'] + '\n' + S['SchedPub.gs'], sb, { filename: which + '.gs' });
  vm.runInContext(`
    payRead = function(kind){ return (__DATA[kind]||[]).map(function(r){return Object.assign({},r)}); };
    payReplaceAll = function(kind, rows){ __DATA[kind]=rows.map(function(r){return Object.assign({},r)}); };
    payAppend = function(kind, rows){ __DATA[kind]=(__DATA[kind]||[]).concat(rows); };
    payWriteLocked_ = function(kinds, fn){ fn(); return true; };
    payClockRead = function(store, sheet){ return ((__CLOCK[store]||{})[sheet]||[]).map(function(r){return Object.assign({},r)}); };
    payHasClock = function(){ return true; };
    payEmpStoresMap = function(){ return {}; };
    todayTaipeiStr = function(){ return __TODAY; };
    nowTaipeiIso = function(){ return __TODAY+'T09:00:00+08:00'; };
    payYesterday_ = function(){ var d=new Date(__TODAY+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); };
    if (__PUBSHEET) {   // 走真的讀表路徑：sched_pub 分頁 → schedPubLoad_ → paySchedIndex_ → paySchedMonth_ → payDailyFor_ → payKzScan_
      getSS = function(){ return { getSheetByName: function(n){ return n === 'sched_pub' ? { getDataRange: function(){ return { getValues: function(){ return JSON.parse(JSON.stringify(__PUBSHEET)); } }; } } : null; } }; };
    } else schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(__PUB)); };
    CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    paySchedMissingAll_=function(){return [];}; payUnapprovedAll_=function(){return [];}; payCompNegatives=function(){return [];};
  `, sb);
  sb.post = (fn, body) => J(vm.runInContext(fn, sb)(Object.assign({ admin_key: KEY }, body)));
  return sb;
}
const PERIODS = { T01: '2026-11-01', T02: '2026-11-29', T03: '2026-12-27' };
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const cellOf = (d, marks) => (marks && marks[d]) || (dow(d) === 0 ? { t: 'R' } : dow(d) === 6 ? { t: 'H' } : { t: 'W', s: 'A' });
function pubRows(people) {
  const out = {};
  Object.keys(PERIODS).forEach((p) => {
    out['|' + p] = { shifts: [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }],
      rows: people.map((x) => ({ emp_id: x.id, name: x.name, cells: Array.from({ length: 28 }, (_, i) => cellOf(addDays(PERIODS[p], i), x.marks)) })) };
  });
  return out;
}
const ft = (o) => Object.assign({ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: 32000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 2000,
  ot_rate: 240, wage: 0, labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-06-15', leave_date: '', meal_allow: 0, active: 'true', store: 'SSLGF' }, o || {});
const AP = (date, id, h) => ({ date, emp_id: id, name: '', periods: h ? '10:00-' + (10 + h + 1) + ':00' : '', approved_hours: h, status_text: h ? '正常' : '全天請假', manager_name: '店長甲', entered_at: date + 'T23:00:00+08:00' });
const LV = (date, name, type, h) => ({ '日期': date, '姓名': name, '假別': type, '時數': h });
const HOL = () => [{ ym: '2026-11', red_days: 9, note: '', dates: '', store: '' }, { ym: '2026-12', red_days: 9, note: '', dates: '2026-12-25', store: '' }];
function scene(o) {
  o = o || {};
  const master = o.master || [ft()];
  const approved = [];
  master.forEach((m) => { for (let i = 1; i <= 31; i++) { const d = '2026-12-' + ('0' + i).slice(-2); if (cellOf(d, (o.marks || {})[m.emp_id]).t === 'W' && d !== '2026-12-25' && ((o.skip || {})[m.emp_id] || []).indexOf(d) < 0) approved.push(AP(d, m.emp_id, 8)); } });
  (o.extraAp || []).forEach((x) => approved.push(x));
  return {
    data: { master, xmap: [], store: [{ code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }], holiday: HOL(), config: [], run: [], item: [], input: [], bonus: [], audit: [],
      leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [] },
    clock: { SSLGF: { roster: master.map((m) => ({ emp_id: m.emp_id, name: m.name, active: 'true' })), events: [], approved, leave: o.leave || [], requests: [] } },
    pub: pubRows(master.map((m) => ({ id: m.emp_id, name: m.name, marks: (o.marks || {})[m.emp_id] }))),
  };
}
const ON = { KUANGZHI_FROM: '2026-12-01' };
const ONL = { KUANGZHI_FROM: '2026-12-01', KUANGZHI_LOCK_BLOCK: 'on' };
const env = (sc, which, props, extra) => load(which, Object.assign({ data: sc.data, clock: sc.clock, pub: sc.pub, props: props || {} }, extra || {}));
const calc = (s, ym) => s.post('handlePayrollCalc', { ym: ym || '2026-12', store: 'SSLGF', inputs: {} });
const lock = (s) => s.post('handlePayrollFinalize', { ym: '2026-12', store: 'SSLGF', lock: true, operator: '測試' });
const one = (r, id) => (r.results || []).find((x) => x.emp_id === (id || 'E01'));
const W15 = (x) => ({ E01: { '2026-12-15': Object.assign({ t: 'W', s: 'A' }, x === undefined ? {} : { x }) } });
const sus15 = (x, props) => one(calc(env(scene({ skip: { E01: ['2026-12-15'] }, marks: W15(x) }), 'now', props || ON))).ot_info.kz_suspect;

console.log('\n══ 三、薪資掃疑似：有效 x ＝排除；其他照舊（C1–C6）══');
{
  eq(sus15(undefined), ['2026-12-15'], 'C1 沒有 x：12/15 疑似');
  { const s = env(scene({ skip: { E01: ['2026-12-15'] }, marks: W15() }), 'now', ONL); calc(s); eq(lock(s).error, 'kz_suspect', 'C1 沒有 x：鎖月擋（KUANGZHI_LOCK_BLOCK=on）'); }
  ['dir', 'hq_off', 'away', 'late'].forEach((x) => eq(sus15(x), undefined, 'C2 x=' + x + '：不列疑似'));
  { const s = env(scene({ skip: { E01: ['2026-12-15'] }, marks: W15('hq_off') }), 'now', ONL); const r = calc(s); const L = lock(s);
    eq([one(r).gross, L.ok, L.error || ''], [34000, true, ''], 'C2 x=hq_off：金額 34,000 不變、鎖得下去（不擋鎖月）'); }
  for (const [nm, x] of [['zzz', 'zzz'], ['空字串', ''], ['數字 1', 1], ['null', null], ['true', true], ['陣列', ['dir']], ['物件', { dir: 1 }], ['大寫 DIR', 'DIR'], ['前面空白', ' dir'], ['__proto__', '__proto__'], ['constructor', 'constructor'], ['hasOwnProperty', 'hasOwnProperty']]) {
    eq(sus15(x), ['2026-12-15'], 'C3 x=' + nm + '：不認得／型別不對 → 照舊列疑似');
  }
  { const s = env(scene({ skip: { E01: ['2026-12-15'] }, marks: W15('zzz') }), 'now', ONL); calc(s); eq(lock(s).error, 'kz_suspect', 'C3 x=zzz：照舊擋鎖月'); }
  // 格子不是 W：x 不起作用（結果跟沒帶 x 一模一樣）
  for (const c of [{ t: 'H', s: 'A' }, { t: 'L', l: '特' }, { t: 'R' }]) {
    const a = calc(env(scene({ skip: { E01: ['2026-12-15'] }, marks: { E01: { '2026-12-15': Object.assign({ x: 'dir' }, c) } } }), 'now', ON));
    const b = calc(env(scene({ skip: { E01: ['2026-12-15'] }, marks: { E01: { '2026-12-15': c } } }), 'now', ON));
    eq(a, b, '格子 ' + c.t + ' 帶 x=dir：整個試算回應跟沒帶 x 相同');
  }
  { const r = one(calc(env(scene({ skip: { E01: ['2026-12-14'] }, marks: { E01: { '2026-12-14': { t: 'H', s: 'A', x: 'dir' }, '2026-12-15': { t: 'W', s: 'A', x: 'dir' } } } }), 'now', ON)));
    eq(r.ot_info.kz_suspect, undefined, '對照：W 格的 x 起作用、H 格的 x 不影響（12/14 休息日排班本來就不算）'); }
  const skip3 = { E01: ['2026-12-14', '2026-12-15', '2026-12-16'] };
  const r4 = one(calc(env(scene({ skip: skip3, marks: W15('dir') }), 'now', ON))), r4n = one(calc(env(scene({ skip: skip3 }), 'now', ON)));
  eq([r4.ot_info.kz_suspect, r4.ot_info.kz_suspect_streak, r4.ot_info.kz_suspect_alert], [['2026-12-14', '2026-12-16'], 1, false], 'C4 12/14–16 沒來、12/15 x=dir：疑似 12/14、12/16，最長連續 1（排除的上班日斷開）');
  eq([r4n.ot_info.kz_suspect.length, r4n.ot_info.kz_suspect_streak, r4n.ot_info.kz_suspect_alert], [3, 3, true], 'C4 對照：沒有 x 是連續 3 天、到門檻');
  const kz = scene({ skip: { E01: ['2026-12-10'] }, extraAp: [AP('2026-12-10', 'E01', 0)], leave: [LV('2026-12-10', '測試甲', '曠職', 8)], marks: { E01: { '2026-12-10': { t: 'W', s: 'A', x: 'dir' } } } });
  const r5 = one(calc(env(kz, 'now', ON)));
  const ded = r5.ded.find((i) => i.item_key === 'absent_deduct');
  eq([ded && ded.amount, ded && ded.item_label, r5.ot_info.kz_marked], [1133, '曠職(無薪) 1天', [{ date: '2026-12-10', h: 8 }]], 'C5 已認定曠職那天格子帶 x=dir：照扣 1,133（x 只管疑似）');
  const c6 = (x) => calc(env(scene({ skip: { E01: ['2026-12-08'] }, marks: { E01: { '2026-12-08': Object.assign({ t: 'W', s: 'A' }, x ? { x } : {}) } } }), 'now', { KUANGZHI_FROM: '2026-12-15' }));
  eq([one(c6('dir')).ot_info.no_show, c6('dir')], [['2026-12-08'], c6()], 'C6 生效日 12/15、12/08 沒來且 x=dir：照舊列在「有排班沒核定」，整個回應跟沒 x 相同');
  // 真的讀表路徑（sched_pub 分頁字串 → schedPubLoad_ → paySchedMonth_ → payDailyFor_ → payKzScan_）
  const sheetOf = (x) => { const sc = scene({ skip: { E01: ['2026-12-15'] }, marks: W15(x) }); return [['store', 'period', 'seq', 'data', 'last_op', 'updated_at']].concat(Object.keys(sc.pub).map((k) => [k.split('|')[0], k.split('|')[1], 1, JSON.stringify(sc.pub[k]), 'op', ''])); };
  const viaSheet = (x) => one(calc(env(scene({ skip: { E01: ['2026-12-15'] } }), 'now', ON, { pubSheet: sheetOf(x) }))).ot_info.kz_suspect;
  eq([viaSheet('hq_off'), viaSheet('zzz'), viaSheet(undefined)], [undefined, ['2026-12-15'], ['2026-12-15']], '從 sched_pub 分頁讀起：hq_off 排除、zzz 與沒有 x 照舊疑似（確認薪資讀班表的路徑拿得到 x）');
  // 收發布 → 存 → 薪資：發布時被丟掉的 x 到了薪資也不會出現
  const s0 = schedEnv('now', {}); s0.handleSchedPublish_(payloadOf(true));
  const t02 = JSON.parse(stored(s0)[0]);
  eq([kzx(t02, 2), kzx(t02, 6)], ['dir', undefined], '收發布後 sched_pub 的 12/1 格子 x=dir、12/5 的 zzz 已被丟掉');
  function kzx(d, i) { return d.rows[0].cells[i].x; }
}

console.log('\n══ 四、開關關：sched_pub 有 x 也跟主線 ' + BASE + ' 逐字相同（C7）══');
{
  const sc = scene({ master: [ft(), ft({ emp_id: 'E02', name: '測試乙' })], skip: { E01: ['2026-12-15'], E02: ['2026-12-16', '2026-12-17'] },
    marks: { E01: { '2026-12-15': { t: 'W', s: 'A', x: 'hq_off' }, '2026-12-16': { t: 'W', s: 'A', x: 'dir' } }, E02: { '2026-12-16': { t: 'W', s: 'A', x: 'zzz' } } } });
  const scNo = scene({ master: [ft(), ft({ emp_id: 'E02', name: '測試乙' })], skip: { E01: ['2026-12-15'], E02: ['2026-12-16', '2026-12-17'] } });
  const b = env(sc, 'base', {}); const bC = calc(b), bN = calc(b, '2026-11'); calc(b); const bL = lock(b);
  for (const [nm, props] of [['沒設', {}], ['空白', { KUANGZHI_FROM: '' }], ['on', { KUANGZHI_FROM: 'on' }], ['2026-12-32', { KUANGZHI_FROM: '2026-12-32' }], ['鎖月擋開但生效日沒設', { KUANGZHI_LOCK_BLOCK: 'on' }]]) {
    const s = env(sc, 'now', props);
    eq(calc(s), bC, nm + '：12 月試算整個回應相同');
    eq(calc(s, '2026-11'), bN, nm + '：11 月試算相同');
    calc(s); eq(lock(s), bL, nm + '：鎖定回應相同');
    eq(s.__DATA.run.map((r) => [r.emp_id, r.gross, r.net, r.ot_info]), b.__DATA.run.map((r) => [r.emp_id, r.gross, r.net, r.ot_info]), nm + '：寫進 run 的草稿列相同');
    eq(calc(env(scNo, 'now', props)), bC, nm + '：sched_pub 有沒有 x 都一樣');
  }
  eq([bC.ok, one(bC).ot_info.no_show], [true, ['2026-12-15']], '對照：主線試算成功、舊提醒照列 12/15（比對有東西）');
  const clean = scene({ master: [ft()], marks: { E01: { '2026-12-03': { t: 'W', s: 'A', x: 'dir' } } } });
  eq(calc(env(clean, 'now', ON)), calc(env(clean, 'base', {})), '開關開、當月沒有疑似也沒有曠職（有一格 x）：整個回應跟主線相同');
}

console.log('\n══ 五、容量：每格都帶 x 的最壞情況離 too_big（45,000 字）多遠（tools/kuangzhi-x-capacity.js）══');
{
  const cap = require('../tools/kuangzhi-x-capacity.js');
  const m = cap.measure(cap.SHAPES);
  eq(m.limit, 45000, '上限讀自 SchedPub.gs SCHED_PUB_MAX_CHARS');
  eq(m.shapes.map((s) => s.x_per_person), [364, 364, 364], '每人 28 格全 W 帶 hq_off：每人多 364 字（28 × 13）');
  eq(m.shapes.map((s) => s.max_x < s.max_no_x && s.max_x > 0), [true, true, true], '帶 x 後一期能放的人數變少、但不是 0');
  eq(m.shapes.map((s) => [s.max_no_x, s.max_x]), [[77, 47], [34, 27], [20, 17]], '一期最多人數（不帶 x → 全部帶 x）：短代號 77→47、總部支援門市班 34→27、最長代號 20→17');
}

console.log('\n══ 六、合約 v1.3：國定假日 x=hol（2026-11-27 主管選 A：節日當天與補假日都不記曠職，以營運系統節日表為準）══');
/* 手算（假資料，正職全薪 34,000；開關 12/1；薪資國定假日清單＝薪資現行算法：週末節日配到補假日）：
 *   薪資清單 2027-01：1/1；2027-02：2/4、2/5、2/8、2/9、2/10；2027-03：3/1（2/6、2/7、2/28 是週末節日，不在清單）
 *   營運系統節日表（isHoliday）另外還有 2/6、2/7、2/28 → 發布班表時 W 格帶 x='hol'
 *   H1 2/6、2/7、2/28 排 W 沒來、沒帶 x（改之前營運系統送的）→ 薪資列疑似（＝這次要修的不一致）
 *   H2 同上、帶 x='hol'                                      → 不列疑似（跟營運系統一致）
 *   H3 補假日 2/9、2/10、3/1 排 W 沒來：沒帶 x 也不列（薪資清單有）、帶 x 也不列
 *   H4 一般上班日 2/2、2/17、3/2 排 W 沒來（沒有 x）          → 照列疑似
 *   H5 帶不帶 hol 只差在疑似清單：金額、國定假日加發、其他 ot_info 逐字相同
 *   H6 開關關：sched_pub 有 hol 也跟主線逐字相同 */
{
  const P2 = { T04: '2027-01-24', T05: '2027-02-21', T06: '2027-03-21' };
  const HOL2 = () => [{ ym: '2027-01', red_days: 10, note: '', dates: '2027-01-01', store: '' },
    { ym: '2027-02', red_days: 12, note: '', dates: '2027-02-04,2027-02-05,2027-02-08,2027-02-09,2027-02-10', store: '' },
    { ym: '2027-03', red_days: 9, note: '', dates: '2027-03-01', store: '' }];
  const FEST = ['2027-02-06', '2027-02-07', '2027-02-28'], SUB = ['2027-02-09', '2027-02-10', '2027-03-01'], NORM = ['2027-02-02', '2027-02-17', '2027-03-02'];
  const OTHER_HOL = ['2027-01-01', '2027-02-04', '2027-02-05', '2027-02-08'];
  const SO_HOL = new Set([...FEST, ...SUB, ...OTHER_HOL]);   // 營運系統 isHoliday 在 1～3 月的日子
  // E01：週一～五 W；週末節日那三天也排 W（假資料）；skip＝那天沒有核定（沒來）
  const isWk = (d) => dow(d) !== 0 && dow(d) !== 6;
  const cell2 = (d, withHol) => {
    const c = (isWk(d) || FEST.indexOf(d) !== -1) ? { t: 'W', s: 'A' } : dow(d) === 0 ? { t: 'R' } : { t: 'H' };
    if (withHol && c.t === 'W' && SO_HOL.has(d)) c.x = 'hol';
    return c;
  };
  const scene2 = (withHol, skip) => {
    const master = [ft()], approved = [];
    for (let d = '2027-01-01'; d <= '2027-03-31'; d = addDays(d, 1)) if (cell2(d).t === 'W' && skip.indexOf(d) < 0) approved.push(AP(d, 'E01', 8));   // 沒在 skip＝有來（國定假日排 W 也有來）
    const pub = {};
    Object.keys(P2).forEach((p) => { pub['|' + p] = { shifts: [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }],
      rows: [{ emp_id: 'E01', name: '測試甲', cells: Array.from({ length: 28 }, (_, i) => cell2(addDays(P2[p], i), withHol)) }] }; });
    return { data: { master, xmap: [], store: [{ code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }], holiday: HOL2(), config: [], run: [], item: [], input: [], bonus: [], audit: [],
        leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [] },
      clock: { SSLGF: { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }], events: [], approved, leave: [], requests: [] } }, pub };
  };
  const run2 = (withHol, skip, which, props, ym) => { const sc = scene2(withHol, skip); return calc(load(which || 'now', { data: sc.data, clock: sc.clock, pub: sc.pub, props: props || ON, today: '2027-04-05' }), ym); };
  const sus2 = (withHol, skip) => ['2027-02', '2027-03'].map((ym) => (one(run2(withHol, skip, 'now', ON, ym)).ot_info.kz_suspect || [])).reduce((a, b) => a.concat(b), []);
  // 收發布：W 格的 hol 留下；H 格、大寫、後面有空白丟掉
  {
    const s = schedEnv('now', {});
    const pl = payloadOf(false);
    pl.op_id = 'op-hol'; pl.rows[0].cells[3] = { t: 'W', s: 'A', x: 'hol' }; pl.rows[0].cells[6] = { t: 'H', s: 'A', x: 'hol' }; pl.rows[0].cells[7] = { t: 'W', s: 'A', x: 'HOL' }; pl.rows[0].cells[8] = { t: 'W', s: 'A', x: 'hol ' };
    eq(J(s.handleSchedPublish_(pl)), { ok: true, seq: 1 }, '收發布（帶 hol）成功');
    const c = JSON.parse(stored(s)[0]).rows[0].cells;
    eq([c[3], c[6], c[7], c[8]], [{ t: 'W', s: 'A', x: 'hol' }, { t: 'H', s: 'A' }, { t: 'W', s: 'A' }, { t: 'W', s: 'A' }], 'W 格的 hol 存下來；H 格的 hol、大寫 HOL、後面有空白的都丟掉');
    eq([s.kzPubX_({ t: 'W', x: 'hol' }), s.kzPubX_({ t: 'H', x: 'hol' }), s.kzPubX_({ t: 'W', x: 'holiday' })], ['hol', '', ''], 'kzPubX_：W 格 hol 認得；非 W、不認得的字一律空');
  }
  const ALLSKIP = FEST.concat(SUB, NORM);
  eq(sus2(false, ALLSKIP), FEST.concat(NORM).sort(), 'H1 沒帶 hol：週末節日 2/6、2/7、2/28 被列疑似（修之前跟營運系統不一致）、補假日不列、一般日照列');
  eq(sus2(true, ALLSKIP), NORM.slice().sort(), 'H2＋H4 帶 hol：2/6、2/7、2/28 不列疑似；一般上班日 2/2、2/17、3/2 照列');
  eq([sus2(false, SUB), sus2(true, SUB)], [[], []], 'H3 補假日 2/9、2/10、3/1 沒來：帶不帶 hol 都不列（薪資清單有）');
  FEST.forEach((d) => eq([sus2(false, [d]), sus2(true, [d])], [[d], []], 'H1／H2 只有 ' + d + ' 沒來：沒帶 hol 疑似、帶了不疑似'));
  NORM.forEach((d) => eq(sus2(true, [d]), [d], 'H4 一般上班日 ' + d + ' 沒來：帶 hol 的班表照列疑似'));
  // H5：帶不帶 hol 只差在疑似清單（全部人都來的月份整個回應相同；有疑似的月份拿掉 kz_* 後相同）
  const strip = (r) => JSON.parse(JSON.stringify(r), (k, v) => (/^kz_/.test(k) ? undefined : v));
  ['2027-01', '2027-02', '2027-03'].forEach((ym) => {
    eq(run2(true, [], 'now', ON, ym), run2(false, [], 'now', ON, ym), 'H5 ' + ym + ' 大家都有來：帶不帶 hol 整個試算回應逐字相同（國定假日加發、底薪、金額都不受影響）');
    eq(strip(run2(true, ALLSKIP, 'now', ON, ym)), strip(run2(false, ALLSKIP, 'now', ON, ym)), 'H5 ' + ym + ' 有人沒來：拿掉 kz_* 欄位後逐字相同（只差疑似清單）');
  });
  { const r = one(run2(true, [], 'now', ON, '2027-02'));
    eq([r.ot_info.hol, r.earn.map((x) => x.item_key + ':' + x.amount)], [['2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10'], ['base_salary:32000', 'ot_hol:6000', 'attend_bonus:2000']], 'H5 對照（手算：月工資 32,000＋績效上限 2,000＋伙食 2,000＝36,000 ÷240＝150 元 × 8 小時 × 5 天＝6,000）：2 月國定假日加發照薪資自己的清單（2/4、2/5、2/8、2/9、2/10，沒有 2/6、2/7）——hol 不影響加發日'); }
  { const r = one(run2(true, ALLSKIP, 'now', ON, '2027-02')); eq([r.ot_info.kz_suspect, r.ot_info.kz_suspect_streak], [['2027-02-02', '2027-02-17'], 1], 'H2 2 月疑似 2/2、2/17、最長連續 1'); }
  // H6：開關關，sched_pub 有 hol 也跟主線一樣
  for (const [nm, props] of [['沒設', {}], ['空白', { KUANGZHI_FROM: '' }], ['壞值', { KUANGZHI_FROM: 'on' }]]) {
    ['2027-02', '2027-03'].forEach((ym) => eq(run2(true, ALLSKIP, 'now', props, ym), run2(true, ALLSKIP, 'base', {}, ym), 'H6 開關' + nm + '：' + ym + ' 試算跟主線 ' + BASE + ' 逐字相同（sched_pub 有 hol）'));
  }
}

console.log('\n' + pass + ' 過、' + fail + ' 失敗');
if (fail) process.exit(1);
