/* 曠職：認定錯了怎麼撤回（2026-11-29 主管定案「選 B」：不加按鈕，改成手動修改什麼都不填也可以送出，送出就等於撤銷）。打卡端 Code.gs handleMgrApprove＋kzRevokePlan_／kzMarkedDay_。
 * 規則白話（不變式）：
 *   ‧只有「那天已認定曠職、薪資月份未鎖」時，手動修改送出「空時段＋無假別」＝撤銷認定：
 *     那天這人的核定列（approved）與請假登記（leave，含曠職那列）整天搬到既有的留底分頁 approved_revoked／leave_revoked
 *     （revoked_at＝何時、revoke_reason＝「撤銷認定曠職（核定人）」＝誰），那天回到未核定，跟從沒認定過一樣；
 *     薪資讀不到曠職列 → 曠職扣款、績效歸零一併消失。
 *   ‧其他所有情況（那天沒有已認定曠職、已鎖月、開關關、時段沒帶成陣列、舊呼叫端只送 leave_type）照改之前：
 *     沒鎖＝{ok:false, error:'bad_periods'}、鎖了＝既有鎖月句，什麼都不寫。
 *   ‧保守多看：最新核定要是認定那筆的樣子（沒有時段、0 小時）；同名的人，請假登記要照薪資算法屬於這位（名冊最後一位同名）才撤。
 *   ‧那天還有待審的單：照規則乙先擋（pending_request），先審單。只檢查（dry_run）：回 kz_revoke:true、什麼都不寫。
 *   ‧只有營運系統個人帳號代轉能撤（同認定；門市共用鑰匙空送出照舊 bad_periods）。
 * 手算（示意薪資：正職底薪 32,000、績效上限 2,000、其他 0；全薪 34,000 ÷ 30 ＝ 1,133.33／天；12 月班表週一到週五 A 班 10:00–19:00 休 60 分＝8 小時）：
 *   C1 12/10 認定曠職 8 小時：扣「曠職」1 天 1,133、績效 0 → 撤銷後：沒有曠職扣款、績效回到「12/10 從沒認定」時的金額（逐欄相同）
 *   C2 兩段班 10:00–14:00＋17:00–21:00（班表時數 8）認定 → 1,133；撤銷 → 0
 *   C3 班表 4 小時認定 0.5 天 → 567；撤銷 → 0
 *   C4 12/9、12/10 兩天認定 → 2,267；只撤 12/10 → 剩 12/9 一天 1,133
 *   C5 撤銷後再認定 12/10 → 又是 1,133、績效 0
 * 全部虛構姓名工號。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { make, T, check, done } = require('./helpers/gs-sandbox');

const D = '2026-12-10';
const ME = { emp_id: 'E01', name: '測試甲', key: 'K1', device_id: 'D1', active: 'TRUE' };
const KZS = { work: true, hours: 8, xpunch: false, xreq: false, end: T('2026-12-10T19:00:00') };
function env(o) {
  o = o || {};
  const m = make({ now: T(o.now || '2026-12-11T10:00:00'), payroll: !!o.payroll, hub: false,
    props: Object.assign({ REQ_STRICT_FROM: '2026-11-01', KUANGZHI_FROM: '2026-12-01' }, o.props || {}),
    config: { NO_PUNCH_BREAK_START: '', NO_PUNCH_BREAK_END: '' },
    self: { roster: o.roster || [ME], events: o.events || [], approved: o.approved || [], leave: o.leave || [] } });
  m.sb.reqSheet_(m.self, true);
  return m;
}
const mark = (m, date, ks, emp) => m.sb.handleMgrApprove({ mgr_key: 'AK', acting_name: '店長甲', date: date || D, emp_id: emp || 'E01', periods: [], leaves: [{ type: '曠職', hours: 8 }],
  kz_sched: Object.assign({}, KZS, { end: T((date || D) + 'T19:00:00') }, ks || {}) });
const empty = (m, x) => m.sb.handleMgrApprove(Object.assign({ mgr_key: 'AK', acting_name: '店長乙', date: D, emp_id: 'E01', periods: [], leaves: [], late_min: '' }, x || {}));
const dayRows = (m, date) => [m.self.sh.approved.values.slice(1).filter((r) => m.sb.normCellDate(r[0]) === (date || D)).length,
  m.self.sh.leave.values.slice(1).filter((r) => m.sb.normCellDate(r[0]) === (date || D)).length];
const bak = (m, nm) => (m.self.sh[nm] ? m.self.sh[nm].values : []);
const BAD = { ok: false, error: 'bad_periods' };
const J = (x) => JSON.parse(JSON.stringify(x));

console.log('══ 一、已認定 → 空送出＝撤銷（C1）══');
{
  const m = env();
  check('R1', '先認定 12/10 曠職', mark(m).ok, true);
  check('R1a', '認定後 approved 1 列、leave 1 列曠職', [dayRows(m), m.self.sh.leave.values[1][2]], [[1, 1], '曠職']);
  const r = empty(m);
  check('R1b', '空時段＋無假別送出 → ok、kz_revoked、搬了 1 列核定＋1 列請假', [r.ok, r.kz_revoked, r.revoked], [true, true, { approved: 1, leave: 1 }]);
  check('R1c', '回應：時數、狀態空白、核定人＝撤銷的人', [r.approved_hours, r.status_text, r.manager_name, r.periods, r.leaves], ['', '', '店長乙', [], []]);
  check('R1d', '那天 approved、leave 都沒有這人的列（回到未核定）', dayRows(m), [0, 0]);
  const ab = bak(m, 'approved_revoked'), lb = bak(m, 'leave_revoked');
  check('R1e', '留底 approved_revoked：表頭多 revoked_at、revoke_reason；那一列＝認定那筆＋撤銷理由（誰）', [ab[0].slice(-2), ab.length, ab[1][1], ab[1][4], ab[1][ab[0].length - 1]],
    [['revoked_at', 'revoke_reason'], 2, 'E01', 0, '撤銷認定曠職（店長乙）']);
  check('R1f', '留底 leave_revoked：曠職那列＋工號＋何時＋誰', [lb.length, lb[1][2], lb[1][4], /^2026-12-11T/.test(String(lb[1][5])), lb[1][6]], [2, '曠職', 'E01', true, '撤銷認定曠職（店長乙）']);
  // mgr_day：撤銷後跟「從沒認定過」那份逐欄相同（含版本號 ver）
  const fresh = env();
  const md = (mm) => J(JSON.parse(mm.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_day', mgr_key: 'AK', acting_name: '店長乙', date: D, with_ver: true }) } }).text));
  const a = md(m), b = md(fresh);
  check('R1g', 'mgr_day 回應整份跟從沒認定過相同（approved 沒有、leaves 空、ver 相同）', a, b);
  check('R1h', '對照：mgr_day 有讀到這人', (b.employees || []).some((e) => e.emp_id === 'E01'), true);
}

{
  // 營運系統個人帳號代轉會帶正職、班表（sched_ft／sched_day／sched_spans）：撤銷不是核定，不走「正職上班日滿 8 小時」等綁單檢查
  const m = env(); mark(m);
  const r = empty(m, { sched_ft: true, sched_support: false, sched_day: 'W', sched_spans: [{ start: '10:00', end: '19:00', break_min: 60 }] });
  check('R1i', '帶正職＋上班日班表空送出 → 照樣撤銷（不被滿 8 小時擋）', [r.ok, r.kz_revoked, r.error || ''], [true, true, '']);
  const n = env({ approved: [[D, 'E01', '測試甲', '', 0, '全天請假', '店長甲', D + 'T20:00:00+08:00', '', '']], leave: [[D, '測試甲', '事假', 8]] });
  check('R1j', '對照：不是已認定的日子帶同樣欄位空送出 → bad_periods', empty(n, { sched_ft: true, sched_support: false, sched_day: 'W', sched_spans: [{ start: '10:00', end: '19:00', break_min: 60 }] }), BAD);
}

console.log('\n══ 二、已鎖月 → 空送出被擋（照既有鎖月句），什麼都不動 ══');
{
  const m = env({ payroll: true });
  check('R2', '先認定', mark(m).ok, true);
  const ss = m.sb.getSS(), head = m.run('PAY_SHEETS.run'), rs = ss.insertSheet(m.run('PAY_SHEET_NAME.run'));
  rs.appendRow(head.slice());
  const o = { ym: '2026-12', store: 'SSLGF', status: 'final', emp_id: 'E01', name: '測試甲', net: 30000 };
  rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k])));
  m.run('if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; }');
  const r = empty(m);
  check('R2a', '回 pay_locked＋既有鎖月句', [r.ok, r.error, r.message], [false, 'pay_locked', '2026-12 薪資已鎖定，請先到薪資頁解鎖這個月']);
  check('R2b', '核定、請假登記都還在；沒有留底分頁', [dayRows(m), !!m.self.sh.approved_revoked, !!m.self.sh.leave_revoked], [[1, 1], false, false]);
  // 解鎖（改成 draft）後同一個送出就能撤
  m.self.sh[m.run('PAY_SHEET_NAME.run')].values[1][head.indexOf('status')] = 'draft';
  m.run('if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; }');
  const r2 = empty(m);
  check('R2c', '解鎖後再送 → 撤銷成功', [r2.ok, r2.kz_revoked, dayRows(m)], [true, true, [0, 0]]);
}

console.log('\n══ 三、沒有已認定曠職 → 空送出仍回 bad_periods（逐位元組同改之前）══');
{
  const m = env();
  check('R3', '那天沒核定 → bad_periods', empty(m), BAD);
  const n = env({ approved: [[D, 'E01', '測試甲', '10:00-19:00', 9, '正常', '店長甲', D + 'T20:00:00+08:00', '', '']] });
  check('R3a', '那天已核定一般上班 9 小時 → bad_periods', empty(n), BAD);
  check('R3b', '核定沒被動', dayRows(n), [1, 0]);
  const p = env({ approved: [[D, 'E01', '測試甲', '', 0, '全天請假', '店長甲', D + 'T20:00:00+08:00', '', '']], leave: [[D, '測試甲', '事假', 8]] });
  check('R3c', '那天整天事假（0 小時、沒有時段、不是曠職）→ bad_periods', empty(p), BAD);
  check('R3d', '事假那天沒被動', dayRows(p), [1, 1]);
}

console.log('\n══ 四、開關關 → 照改之前 bad_periods（已經有曠職登記也一樣）══');
{
  const m = env();
  check('R4', '先認定（開著）', mark(m).ok, true);
  m.props.KUANGZHI_FROM = '';
  check('R4a', '開關改空白 → bad_periods', empty(m), BAD);
  m.props.KUANGZHI_FROM = '2026-12-20';
  check('R4b', '生效日晚於那天 → bad_periods', empty(m), BAD);
  check('R4c', '都沒動', dayRows(m), [1, 1]);
}

console.log('\n══ 五、送的形狀不是「空時段陣列＋假別陣列」→ bad_periods ══');
{
  const m = env(); mark(m);
  check('R5', '沒帶 periods（舊呼叫端）→ bad_periods', (() => { const b = { mgr_key: 'AK', acting_name: '店長乙', date: D, emp_id: 'E01', leaves: [] }; return m.sb.handleMgrApprove(b); })(), BAD);
  check('R5a', '只送 leave_type 空白（舊營運系統單一假別）→ bad_periods', empty(m, { leaves: undefined, leave_type: '', leave_hours: '' }), BAD);
  const g = env(); mark(g);
  check('R5c', '門市共用鑰匙（不是個人帳號代轉）空送出 → bad_periods（同認定只收個人帳號）', [g.sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: [], leaves: [], late_min: '' }), dayRows(g)], [BAD, [1, 1]]);
  check('R5b', '假別陣列裡只有空白假別＝無假別 → 照樣撤銷', empty(m, { leaves: [{ type: '', hours: '' }] }).kz_revoked, true);
}

console.log('\n══ 六、兩段班（C2）、4 小時班（C3）══');
{
  const m = env();
  check('R6', '兩段班 10:00–14:00＋17:00–21:00 認定（班表時數 8，end 21:00）', mark(m, D, { hours: 8, end: T(D + 'T21:00:00') }).ok, true);
  check('R6a', '撤銷 → ok、整天清掉', [empty(m).kz_revoked, dayRows(m)], [true, [0, 0]]);
  const h = env();
  check('R6b', '4 小時班認定', mark(h, D, { hours: 4 }).ok, true);
  check('R6c', '4 小時那筆一樣撤得掉', [empty(h).kz_revoked, dayRows(h)], [true, [0, 0]]);
}

console.log('\n══ 七、同店同名：只撤得到「薪資算在他身上」的那位 ══');
{
  // 名冊兩位都叫測試甲（E09 已離職、排在後面＝薪資把「測試甲」的請假登記算給 E09）
  const two = [ME, { emp_id: 'E09', name: '測試甲', key: 'K9', device_id: 'D9', active: 'FALSE' }];
  const m = env({ roster: two });
  check('R7', 'E01 認定成功', mark(m).ok, true);
  check('R7a', 'E01 空送出：請假登記不算他的 → 不撤、bad_periods', empty(m), BAD);
  check('R7b', '都沒動', dayRows(m), [1, 1]);
  const m2 = env({ roster: [{ emp_id: 'E09', name: '測試甲', key: 'K9', device_id: 'D9', active: 'FALSE' }, ME] });
  check('R7c', '名冊順序對調（E01 在後）→ E01 認定後空送出可以撤', [mark(m2).ok, empty(m2).kz_revoked, dayRows(m2)], [true, true, [0, 0]]);
  // 同名兩位都在職（正式環境會被擋，這裡硬造）：E01 認定曠職、E02 同一天一般上班 8 小時
  const m3 = env({ roster: [ME, { emp_id: 'E02', name: '測試甲', key: 'K2', device_id: 'D2', active: 'TRUE' }],
    approved: [[D, 'E02', '測試甲', '10:00-18:00', 8, '正常', '店長甲', D + 'T20:00:00+08:00', '', '']] });
  check('R7d', 'E01 認定（同名 E02 那天有一般核定）', mark(m3).ok, true);
  check('R7e', 'E02 空送出：他那天不是認定曠職那筆的樣子 → bad_periods，E01 的曠職與 E02 的核定都不動', [empty(m3, { emp_id: 'E02' }), dayRows(m3)], [BAD, [2, 1]]);
}

console.log('\n══ 八、撤銷後再認定可以正常認定（C5）；只檢查不寫；有待審單先擋 ══');
{
  const m = env();
  mark(m); empty(m);
  const r = mark(m);
  check('R8', '撤銷後再按認定 → 成功（句 8）', [r.ok, r.message], [true, '已認定 12/10 曠職（8 小時）']);
  check('R8a', '又是 approved 1 列、leave 1 列曠職', [dayRows(m), m.self.sh.leave.values.slice(-1)[0][2]], [[1, 1], '曠職']);
  check('R8b', '再撤一次也可以，留底累積 2 列', [empty(m).kz_revoked, bak(m, 'approved_revoked').length - 1, bak(m, 'leave_revoked').length - 1], [true, 2, 2]);
  const d = env(); mark(d);
  const dr = empty(d, { dry_run: true });
  check('R8c', '只檢查（dry_run）→ ok、kz_revoke:true、什麼都不寫', [dr.ok, dr.dry_run, dr.kz_revoke, dayRows(d), !!d.self.sh.approved_revoked], [true, true, true, [1, 1], false]);
  const p = env(); mark(p);
  const HD = p.run('REQ_HEADERS_'), sh = p.sb.reqSheet_(p.self, true);
  const rq = { id: 'Q1', created_at: '2026-12-11T09:00:00+08:00', status: 'pending', hours: 8, emp_id: 'E01', name: '測試甲', kind: 'leave', leave_type: '事假', date: D };
  sh.appendRow(HD.map((k) => (rq[k] === undefined ? '' : rq[k])));
  const pr = empty(p);
  check('R8d', '那天有待審單 → pending_request（規則乙），不撤', [pr.ok, pr.error, dayRows(p)], [false, 'pending_request', [1, 1]]);
}

console.log('\n══ 九、多天：只撤送出的那天（C4）══');
{
  const m = env({ now: '2026-12-11T10:00:00' });
  check('R9', '12/9、12/10 各認定一天', [mark(m, '2026-12-09').ok, mark(m, D).ok], [true, true]);
  check('R9a', '撤 12/10 → 12/9 不動', [empty(m).kz_revoked, dayRows(m, '2026-12-09'), dayRows(m, D)], [true, [1, 1], [0, 0]]);
}

// ── 十、薪資：用上面真的寫出來的列算薪（C1～C5 金額）──
const ROOT = path.join(__dirname, '..'), AS = path.join(ROOT, 'apps-script');
const SRC = ['Code.gs', 'Payroll.gs', 'Requests.gs', 'SchedPub.gs'].map((f) => fs.readFileSync(path.join(AS, f), 'utf8')).join('\n');
const KEY = 'test-admin-key';
function payEnv(clock, pub) {
  const props = { KUANGZHI_FROM: '2026-12-01' };
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); const t = new Date(d.getTime() + 8 * 3600000); return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    __DATA: J(PAYDATA), __CLOCK: J({ SSLGF: clock }), __PUB: J(pub) };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'clock.gs' });
  vm.runInContext(`
    payRead = function(kind){ return (__DATA[kind]||[]).map(function(r){return Object.assign({},r)}); };
    payReplaceAll = function(kind, rows){ __DATA[kind]=rows.map(function(r){return Object.assign({},r)}); };
    payAppend = function(kind, rows){ __DATA[kind]=(__DATA[kind]||[]).concat(rows); };
    payWriteLocked_ = function(kinds, fn){ fn(); return true; };
    payClockRead = function(store, sheet){ return ((__CLOCK[store]||{})[sheet]||[]).map(function(r){return Object.assign({},r)}); };
    payHasClock = function(){ return true; }; payEmpStoresMap = function(){ return {}; };
    todayTaipeiStr = function(){ return '2027-01-05'; }; nowTaipeiIso = function(){ return '2027-01-05T09:00:00+08:00'; };
    payYesterday_ = function(){ return '2027-01-04'; };
    schedPubLoad_ = function(){ return JSON.parse(JSON.stringify(__PUB)); };
    CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    paySchedMissingAll_=function(){return [];}; payUnapprovedAll_=function(){return [];}; payCompNegatives=function(){return [];};
  `, sb);
  const r = vm.runInContext('handlePayrollCalc', sb)({ admin_key: KEY, ym: '2026-12', store: 'SSLGF', inputs: {} });
  return J(r);
}
const PAYDATA = { master: [{ emp_id: 'E01', name: '測試甲', is_full_time: 'true', base: 32000, skill_allow: 0, night_allow: 0, mgr_allow: 0, attend_cap: 2000, ot_rate: 240, wage: 0,
  labor_ins: 0, health_ins: 0, group_ins: 0, pension: 0, dormitory: 0, hire_date: '2021-06-15', leave_date: '', meal_allow: 0, active: 'true', store: 'SSLGF' }],
  xmap: [], store: [{ code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' }],
  holiday: [{ ym: '2026-12', red_days: 9, note: '', dates: '2026-12-25', store: '' }], config: [], run: [], item: [], input: [], bonus: [], audit: [],
  leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [] };
const addD = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const PERIODS = { p1: '2026-11-23', p2: '2026-12-21' };
const cellOf = (d, hrs) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w === 0) return { t: 'R' }; if (w === 6) return { t: 'H' }; return { t: 'W', s: 'A' }; };
const PUB = {};
Object.keys(PERIODS).forEach((p) => { PUB['|' + p] = { shifts: [{ id: 'A', name: 'A 班', start: '10:00', end: '19:00', break_min: 60 }],
  rows: [{ emp_id: 'E01', name: '測試甲', cells: Array.from({ length: 28 }, (_, i) => cellOf(addD(PERIODS[p], i))) }] }; });
const decWork = () => { const o = []; for (let i = 1; i <= 31; i++) { const d = '2026-12-' + ('0' + i).slice(-2); if (cellOf(d).t === 'W' && d !== '2026-12-25') o.push(d); } return o; };
/** 打卡端沙盒的 approved／leave 分頁 → 薪資的打卡資料；kzDays＝這些上班日交給沙盒（認定／撤銷），其他上班日當一般 8 小時核定 */
function clockOf(m, kzDays) {
  const A = m.self.sh.approved.values, L = m.self.sh.leave.values;
  const ah = A[0], approved = A.slice(1).map((r) => Object.fromEntries(ah.map((h, i) => [h, r[i] instanceof Date ? m.sb.normCellDate(r[i]) : r[i]])))
    .map((x) => Object.assign(x, { date: m.sb.normCellDate(x.date), entered_at: String(m.sb.normCellTs(x.entered_at) || '') }));
  decWork().filter((d) => kzDays.indexOf(d) < 0).forEach((d) => approved.push({ date: d, emp_id: 'E01', name: '', periods: '10:00-19:00', approved_hours: 8, status_text: '正常', manager_name: '店長甲', entered_at: d + 'T23:00:00+08:00' }));
  const leave = L.slice(1).map((r) => ({ '日期': m.sb.normCellDate(r[0]), '姓名': r[1], '假別': r[2], '時數': r[3] }));
  return { roster: [{ emp_id: 'E01', name: '測試甲', active: 'true' }], events: [], approved, leave, requests: [] };
}
const one = (r) => (r.results || []).find((x) => x.emp_id === 'E01');
const ded = (r) => { const x = one(r); return x ? x.ded.filter((i) => /absent|kz|曠職/.test(i.item_key + i.item_label)).map((i) => [i.item_label, i.amount]) : 'no-result'; };
const bonus = (r) => { const x = one(r); const b = x && x.earn.find((i) => i.item_key === 'attend_bonus'); return b ? [b.item_label, b.amount] : null; };
const money = (r) => (r.results || []).map((x) => [x.gross, x.deduction, x.net, x.earn.map((i) => [i.item_key, i.item_label, i.qty, i.amount]), x.ded.map((i) => [i.item_key, i.item_label, i.qty, i.amount])]);

console.log('\n══ 十、薪資：撤銷後扣款與績效歸零消失（手算 C1～C5）══');
{
  const never = env(); const rNever = payEnv(clockOf(never, [D]), PUB);
  const m = env(); mark(m);
  const rMark = payEnv(clockOf(m, [D]), PUB);
  check('P1', 'C1 認定 12/10：扣曠職 1 天 1,133、績效歸零', [ded(rMark), bonus(rMark)], [[['曠職(無薪) 1天', 1133]], ['績效獎金（當月有曠職）', 0]]);
  empty(m);
  const rRev = payEnv(clockOf(m, [D]), PUB);
  check('P1a', 'C1 撤銷後：沒有曠職扣款、績效不是「當月有曠職」', [ded(rRev), bonus(rRev) && bonus(rRev)[0]], [[], '績效獎金']);
  check('P1b', 'C1 撤銷後每一欄金額跟「12/10 從沒認定」相同', money(rRev), money(rNever));
  check('P1c', '對照：從沒認定那份的績效是 2,000（12/10 只是有排班沒核定，不扣錢）', bonus(rNever), ['績效獎金', 2000]);
  const m3 = env(); mark(m3, D, { hours: 4 });
  check('P3', 'C3 4 小時班認定 0.5 天 → 567', ded(payEnv(clockOf(m3, [D]), PUB)), [['曠職(無薪) 0.5天', 567]]);
  empty(m3);
  check('P3a', 'C3 撤銷 → 0', ded(payEnv(clockOf(m3, [D]), PUB)), []);
  const m2 = env(); mark(m2, D, { hours: 8, end: T(D + 'T21:00:00') });
  check('P2', 'C2 兩段班 8 小時認定 → 1,133', ded(payEnv(clockOf(m2, [D]), PUB)), [['曠職(無薪) 1天', 1133]]);
  empty(m2);
  check('P2a', 'C2 撤銷 → 0', ded(payEnv(clockOf(m2, [D]), PUB)), []);
  const m4 = env(); mark(m4, '2026-12-09'); mark(m4, D);
  check('P4', 'C4 兩天認定 → 2,267', ded(payEnv(clockOf(m4, ['2026-12-09', D]), PUB)), [['曠職(無薪) 2天', 2267]]);
  empty(m4);
  check('P4a', 'C4 只撤 12/10 → 剩 1 天 1,133、績效仍 0', [ded(payEnv(clockOf(m4, ['2026-12-09', D]), PUB)), bonus(payEnv(clockOf(m4, ['2026-12-09', D]), PUB))], [[['曠職(無薪) 1天', 1133]], ['績效獎金（當月有曠職）', 0]]);
  const m5 = env(); mark(m5); empty(m5); mark(m5);
  check('P5', 'C5 撤銷後再認定 → 又扣 1,133、績效 0', [ded(payEnv(clockOf(m5, [D]), PUB)), bonus(payEnv(clockOf(m5, [D]), PUB))], [[['曠職(無薪) 1天', 1133]], ['績效獎金（當月有曠職）', 0]]);
}

done();
