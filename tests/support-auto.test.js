/* 跨店支援時數自動帶入（2026-11-05，docs/support-auto/spec.md §6＋§7 十二條）
 *
 * 用 vm 載入真的 Code.gs＋Payroll.gs，假試算表走記憶體：
 *   payRead／payReplaceAll → __DB（薪資各表）；payClockRead(門市, 分頁) → 依門市表 clock_ss_id 找 __CLOCK[打卡表]
 *   （共用同一份打卡表的門市讀到的是同一份資料，跟正式環境一樣）。
 * 全部虛構門市與同仁（A 君、B 君…），不含任何真名。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));

const STORES = () => [
  { code: 'SSLGF', name: '麻的小辛辣 新竹光復店', clock_ss_id: '', active: 'true', support_group: 'sxl' },
  { code: 'SSLHQ', name: '小辛辣總部', clock_ss_id: 'ck-hq', active: 'true', support_group: 'sxl' },
  { code: 'HQ', name: '鼎兆元總部', clock_ss_id: 'ck-hq', active: 'true', support_group: '*' },
  { code: 'CF', name: '中央廚房', clock_ss_id: 'ck-cf', active: 'true', support_group: '*' },
  { code: 'MZTJS', name: '墨竹亭 金山店', clock_ss_id: 'ck-js', active: 'true', support_group: 'mzt' },
  { code: 'MZTGF', name: '墨竹亭 光復店', clock_ss_id: 'ck-gf', active: 'true', support_group: 'mzt' },
  { code: 'MZTLZL', name: '墨竹亭 六張犁店', clock_ss_id: 'ck-lzl', active: 'true', support_group: 'mzt' },
  { code: 'XX', name: '未設組別店', clock_ss_id: 'ck-xx', active: 'true', support_group: '' },
];
const EMP = (id, store, o) => Object.assign({ emp_id: id, name: id + '君', store, is_full_time: 'true', base: 30000, ot_rate: 240,
  wage: 0, skill_allow: 0, night_allow: 0, mgr_allow: 0, editor_allow: 0, attend_cap: 0, labor_ins: 0, health_ins: 0, group_ins: 0,
  pension: 0, dormitory: 0, hire_date: '2020-01-01', leave_date: '', meal_allow: 0, active: 'true' }, o);
const MASTER = () => [
  EMP('E01', 'SSLGF'),                                                     // A 君：正職，CF 支援＋金山（跨品牌）＋未設組別店
  EMP('E02', 'SSLGF', { is_full_time: 'false', base: 0, ot_rate: 0, wage: 200 }),   // B 君：計時，總部共用打卡表
  EMP('E03', 'SSLGF'),                                                     // C 君：CF 帳號 not_support
  EMP('E04', 'SSLGF'),                                                     // D 君：CF 帳號只有 suggested
  EMP('E05', 'SSLGF'),                                                     // E 君：手填與打卡不同
  EMP('E06', 'SSLGF'),                                                     // F 君：CF 主檔也有他（dup_pay）
  EMP('E07', 'SSLGF'),                                                     // G 君：手填門市名認不出
  EMP('E08', 'SSLGF'),                                                     // H 君：手填跨品牌（金山）
  EMP('E09', 'SSLGF'),                                                     // I 君：CF 帳號本月 0 小時
  EMP('HQ-05', 'SSLHQ'),                                                   // J 君：小辛辣總部同仁，帳號在 HQ 那份打卡表
  EMP('CF30', 'CF'),                                                       // F 君在 CF 的主檔（會被付兩次）
];
// xmap：DZY 編號 ↔ 各店打卡帳號
const XROW = (no, pay, acct, id, o) => Object.assign({ emp_no: no, pay_store: pay, acct_store: acct, emp_id: id, not_support: 'false', state: 'confirmed', synced_at: '2026-11-05T09:00:00+08:00' }, o);
const XMAP = () => [
  XROW('D01', 'SSLGF', 'SSLGF', 'E01'), XROW('D01', 'SSLGF', 'CF', 'CF21'), XROW('D01', 'SSLGF', 'MZTJS', 'JS07'), XROW('D01', 'SSLGF', 'XX', 'X01'),
  XROW('D02', 'SSLGF', 'SSLGF', 'E02'), XROW('D02', 'SSLGF', 'HQ', 'HQ-11'), XROW('D02', 'SSLGF', 'SSLHQ', 'HQ-11'),   // 同一份打卡表兩列
  XROW('D03', 'SSLGF', 'SSLGF', 'E03'), XROW('D03', 'SSLGF', 'CF', 'CF22', { not_support: 'true' }),
  XROW('D04', 'SSLGF', 'SSLGF', 'E04'), XROW('D04', 'SSLGF', 'CF', 'CF23', { state: 'suggested' }),
  XROW('D05', 'SSLGF', 'SSLGF', 'E05'), XROW('D05', 'SSLGF', 'CF', 'CF24'),
  XROW('D06', 'SSLGF', 'SSLGF', 'E06'), XROW('D06', 'SSLGF', 'CF', 'CF30'),
  XROW('D07', 'SSLGF', 'SSLGF', 'E07'), XROW('D07', 'SSLGF', 'CF', 'CF25'),
  XROW('D08', 'SSLGF', 'SSLGF', 'E08'), XROW('D08', 'SSLGF', 'CF', 'CF26'),
  XROW('D09', 'SSLGF', 'SSLGF', 'E09'), XROW('D09', 'SSLGF', 'CF', 'CF27'),
  XROW('D10', 'SSLHQ', 'HQ', 'HQ-05'), XROW('D10', 'SSLHQ', 'SSLGF', 'E10'),                   // 總部同仁：acct_store 是 HQ
];
const AP = (date, emp_id, h, o) => Object.assign({ date, emp_id, name: '', periods: '10:00-' + (10 + h) + ':00', approved_hours: h, status_text: '正常', manager_name: '值班主管', entered_at: date + 'T23:00:00+08:00' }, o);
const CLOCK = () => ({
  LOCAL: { roster: ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10'].map((id) => ({ emp_id: id, name: id + '君', active: true })),
    approved: [AP('2026-11-02', 'E01', 8), AP('2026-11-02', 'E02', 6), AP('2026-11-03', 'E10', 5), AP('2026-10-05', 'E01', 8)],
    events: [], leave: [], requests: [] },
  'ck-cf': { roster: [], approved: [AP('2026-11-04', 'CF21', 8), AP('2026-11-05', 'CF21', 4.5), AP('2026-11-04', 'CF22', 8), AP('2026-11-04', 'CF23', 8),
    AP('2026-11-04', 'CF24', 8), AP('2026-11-04', 'CF30', 8), AP('2026-11-04', 'CF25', 8), AP('2026-11-04', 'CF26', 8), AP('2026-10-04', 'CF27', 8),
    AP('2026-10-10', 'CF21', 7)],
    events: [{ emp_id: 'CF21', ts: '2026-11-06T10:00:00+08:00', type: 'in', status: 'ok' }, { emp_id: 'CF21', ts: '2026-11-04T10:00:00+08:00', type: 'in', status: 'ok' }],
    leave: [], requests: [] },
  'ck-hq': { roster: [], approved: [AP('2026-11-06', 'HQ-11', 3), AP('2026-11-07', 'HQ-05', 8)], events: [], leave: [], requests: [] },
  'ck-js': { roster: [], approved: [AP('2026-11-08', 'JS07', 6)], events: [], leave: [], requests: [] },
  'ck-xx': { roster: [], approved: [AP('2026-11-08', 'X01', 2)], events: [], leave: [], requests: [] },
  'ck-gf': { roster: [], approved: [], events: [], leave: [], requests: [] },
  'ck-lzl': { roster: [], approved: [], events: [], leave: [], requests: [] },
});
const MONTHS = ['2026-09', '2026-10', '2026-11', '2026-12'];
function SEED() {
  return { store: STORES(), master: MASTER(), xmap: XMAP(), config: [], leave_type: [], leave_span: [], leave_event: [], bonus: [],
    holiday: MONTHS.map((ym) => ({ ym, store: '', red_days: 9 })), run: [], item: [], input: [], audit: [], cost_snapshot: [] };
}

function ctx(src) {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => d.toISOString() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + (src || P), sb);
  sb.__DB = SEED(); sb.__CLOCK = CLOCK();
  vm.runInContext(`
    payRead = function(kind){ return JSON.parse(JSON.stringify(globalThis.__DB[kind] || [])); };
    payReplaceAll = function(kind, rows){ globalThis.__DB[kind] = JSON.parse(JSON.stringify(rows)); };
    payAppend = function(kind, rows){ globalThis.__DB[kind] = (globalThis.__DB[kind] || []).concat(JSON.parse(JSON.stringify(rows || []))); };
    payInvalidate = function(){}; ensurePayrollSheets = function(){};
    checkAdmin = function(){ return true; };
    todayTaipeiStr = function(){ return '2026-11-06'; };
    currentYmTaipei = function(){ return '2026-12'; };
    payHolidaySync = function(){ return {}; };
    payClockRead = function(store, sheet){
      const row = globalThis.__DB.store.filter(function(s){ return String(s.code) === String(store); })[0];
      const id = row && row.clock_ss_id ? row.clock_ss_id : (String(store) === 'SSLGF' ? 'LOCAL' : '');
      const t = globalThis.__CLOCK[id] || {};
      return JSON.parse(JSON.stringify(t[sheet] || []));
    };
  `, sb);
  sb.H = (a, b) => vm.runInContext('PAYROLL_HANDLERS', sb)[a](J(Object.assign({ admin_key: 'x' }, b)));
  sb.F = (name) => vm.runInContext(name, sb);
  return sb;
}

let pass = 0, fail = 0;
const chk = (n, cond, detail) => { cond ? pass++ : fail++; console.log((cond ? '  ✔ ' : '  ✘ ') + n + (!cond && detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); };
const sup = (inp, emp) => (((inp || {})[emp] || {}).support || []);
const autoRows = (inp, emp) => sup(inp, emp).filter((s) => s.auto);
const sumH = (l) => Math.round(l.reduce((t, s) => t + Number(s.hours || 0), 0) * 100) / 100;

/* ── §1 schema（只 append）── */
console.log('§1 schema');
{
  const s = ctx();
  const PS = s.F('PAY_SHEETS');
  chk('payroll_store 最後一欄是 support_group（append，不插中間）', PS.store[PS.store.length - 1] === 'support_group' && PS.store.indexOf('brand') === 7, PS.store);
  chk('payroll_input 最後一欄是 hours_manual', PS.input[PS.input.length - 1] === 'hours_manual' && PS.input.indexOf('custom_add_more') === PS.input.length - 2, PS.input);
  chk('新表 payroll_xmap 欄位', JSON.stringify(PS.xmap) === JSON.stringify(['emp_no', 'pay_store', 'acct_store', 'emp_id', 'not_support', 'synced_at', 'state']));
  chk('分頁名 payroll_xmap', s.F('PAY_SHEET_NAME').xmap === 'payroll_xmap');
  chk('生效常數 PAY_XSUP_FROM=2026-11', s.F('PAY_XSUP_FROM') === '2026-11');
}

/* ── §2 引擎（paySupportAuto_）── */
console.log('§2 帶入規則');
{
  const s = ctx();
  const A = s.F('paySupportAuto_');
  chk('ym=2026-10 回 null（7B）', A('2026-10', 'SSLGF', true) === null);
  chk('ym=2026-09 回 null', A('2026-09', 'SSLGF', true) === null);
  const r = A('2026-11', 'SSLGF', true);
  const e1 = r.byEmp.E01;
  chk('同組（CF＝*）：A 君帶入 CF 12.5H（只算 11 月）', e1.stores.length === 1 && e1.stores[0].code === 'CF' && e1.stores[0].hours === 12.5, e1.stores);
  chk('逐日明細：日期、時段、核定時數、核定人（6A／§7-12 manager_name）', e1.stores[0].days.length === 2 && e1.stores[0].days[0].date === '2026-11-04'
    && e1.stores[0].days[0].manager_name === '值班主管' && e1.stores[0].days[0].periods === '10:00-18:00' && e1.stores[0].days[0].hours === 8, e1.stores[0].days);
  chk('跨組（金山 mzt）：不帶入，放 cross', e1.cross.some((x) => x.code === 'MZTJS' && x.hours === 6));
  chk('空白組（XX）：不帶入（只跟自己同組）', e1.cross.some((x) => x.code === 'XX') && !e1.stores.some((x) => x.code === 'XX'));
  const e2 = r.byEmp.E02;
  chk('共用打卡表只算一次（HQ／SSLHQ 同一份表同一帳號 3H，不是 6H）（§7-5）', e2.stores.length === 1 && e2.stores[0].hours === 3, e2.stores);
  chk('not_support 帳號不帶入', r.byEmp.E03.stores.length === 0);
  chk('suggested 不帶入、進 unmapped（§7-9）', !(r.byEmp.E04 && r.byEmp.E04.stores.length) && r.unmapped.some((x) => x.emp_id === 'CF23'), r.unmapped);
  chk('dup_pay：打卡店主檔也有他 → 不帶入、列待處理（§7-11）', r.byEmp.E06.stores.length === 0 && r.dup_pay.some((x) => x.emp_id === 'E06' && x.code === 'CF'), r.dup_pay);
  chk('本月 0 小時：帶入值 0（10 月的不算）', r.byEmp.E09.stores[0].hours === 0);
  chk('未核定天數：有打卡沒核定的日子（今天不算）', r.pending.some((x) => x.emp_id === 'E01' && x.code === 'CF' && x.days === 0) === false
    && !r.pending.some((x) => x.emp_id === 'E01'), r.pending);
  // 總部同仁：本人帳號 acct_store 是 HQ，但 HQ 與 SSLHQ 同一份打卡表 → 用 clock_ss_id 找到本人（§7-3）
  const h = A('2026-11', 'SSLHQ', false);
  chk('總部同仁用 clock_ss_id 找到本人帳號（acct_store=HQ）→ 帶入光復 5H', h.byEmp['HQ-05'] && h.byEmp['HQ-05'].stores.length === 1
    && h.byEmp['HQ-05'].stores[0].code === 'SSLGF' && h.byEmp['HQ-05'].stores[0].hours === 5, h.byEmp);
  chk('不要逐日明細時不產 days（§7-10）', !!(h.byEmp['HQ-05'] && h.byEmp['HQ-05'].stores[0]) && h.byEmp['HQ-05'].stores[0].days === undefined);
  // pending：CF21 11/06 有打卡未核定，但今天＝11/06 不算；改成今天 11/07 就算
  vm.runInContext("todayTaipeiStr = function(){ return '2026-11-07'; };", s);
  const r2 = A('2026-11', 'SSLGF', false);
  chk('未核定天數：11/06 打了卡沒核定 → 1 天', r2.pending.some((x) => x.emp_id === 'E01' && x.code === 'CF' && x.days === 1), r2.pending);
  // 空白 xmap
  s.__DB.xmap = [];
  const r3 = A('2026-11', 'SSLGF', false);
  chk('對照從沒同步：empty=true、沒人帶入', r3.empty === true && Object.keys(r3.byEmp).length === 0);
}

/* ── §3 合併規則（payMergeSupport_）── */
console.log('§3 合併');
{
  const s = ctx();
  const M = s.F('payMergeSupport_'), by = s.F('payXsupStoreBy_')(STORES());
  const cx = { home: 'SSLGF', storeBy: by };
  const ent = { stores: [{ code: 'CF', name: '中央廚房', hours: 12.5 }], cross: [], dup: [] };
  const ft = MASTER()[0], pt = Object.assign(MASTER()[1], { wage: 200 });
  let m = M([], ent, ft, cx);
  chk('沒有手填 → 加 auto 列（code＋中文名，§7-12）', m.support.length === 1 && m.support[0].auto === true && m.support[0].code === 'CF' && m.support[0].store === '中央廚房' && m.support[0].hours === 12.5, m.support);
  chk('費率：正職＝主檔 ot_rate', m.support[0].rate === 240);
  m = M([], ent, Object.assign({}, pt, { wage: 200 }), cx);
  chk('費率：計時＝主檔 wage', m.support[0].rate === 200);
  m = M([{ store: '央廚', hours: 12.5, rate: 240, amount: '' }], ent, ft, cx);
  chk('手填時數相同 → 不動、沒有差異、不加 auto', m.support.length === 1 && !m.support[0].auto && m.diffs.length === 0);
  m = M([{ store: '央廚', hours: 10, rate: 240, amount: '' }], ent, ft, cx);
  chk('手填不同 → 不蓋掉、列差異（3A）', m.support.length === 1 && m.support[0].hours === 10 && m.diffs.length === 1 && m.diffs[0].manual === 10 && m.diffs[0].auto === 12.5, m.diffs);
  m = M([{ store: '央廚', hours: 10, rate: 240, amount: '', keep: true, auto_h: 12.5 }], ent, ft, cx);
  chk('保留手填（keep＋auto_h＝這次打卡值）→ 不再提醒', m.diffs.length === 0 && m.support.length === 1);
  m = M([{ store: '央廚', hours: 10, rate: 240, amount: '', keep: true, auto_h: 11 }], ent, ft, cx);
  chk('保留手填但打卡值變了（auto_h≠）→ 再提醒一次', m.diffs.length === 1);
  m = M([{ code: 'CF', store: '中央廚房', hours: 999, rate: 1, amount: '', auto: true }], ent, ft, cx);
  chk('舊頁面送來的 auto 列（999H）被丟掉、照打卡重算', m.support.length === 1 && m.support[0].hours === 12.5 && m.support[0].rate === 240, m.support);
  m = M([{ code: 'CF', store: '中央廚房', hours: 5, auto: true }], { stores: [{ code: 'CF', name: '中央廚房', hours: 0 }] }, ft, cx);
  chk('自動店本月 0 小時 → 移除 auto 列', m.support.length === 0);
  m = M([{ store: '某某分店', hours: 4, rate: 240, amount: '' }], ent, ft, cx);
  chk('手填門市名認不出 → 該人整個不自動帶入（§7-1）', m.unresolved === true && m.support.length === 1 && !m.support.some((x) => x.auto));
  m = M([{ store: '', hours: 4, rate: 240, amount: '' }], ent, ft, cx);
  chk('手填列門市空白（有時數）也算認不出', m.unresolved === true);
  m = M([{ store: '', hours: 0, rate: 0, amount: '' }], ent, ft, cx);
  chk('剛按「新增支援」還沒填的空白列不算認不出', m.unresolved === false && m.support.some((x) => x.auto));
  m = M([{ store: '墨竹亭金山', hours: 6, rate: 240, amount: '' }], ent, ft, cx);
  chk('跨品牌手填（光復同仁填金山）→ cross_manual（§7-2）', m.cross.length === 1 && m.cross[0] === 'MZTJS');
  m = M([{ code: 'CF', store: '中央廚房', hours: 3 }], ent, ft, cx);
  chk('同組手填（CF）不算 cross', m.cross.length === 0);
  const by2 = s.F('payXsupStoreBy_')(STORES().map((x) => Object.assign(x, { support_group: '' })));
  m = M([{ store: '墨竹亭金山', hours: 6 }], ent, ft, { home: 'SSLGF', storeBy: by2 });
  chk('兩邊都還沒設 support_group（上線過渡期）→ 不判 cross_manual', m.cross.length === 0);
}

/* ── §4 中文名 alias（§7-1）：payroll.html 舊 STORES 常數＋mock 用過的簡寫全部要對得回代碼 ── */
console.log('§4 alias');
{
  const s = ctx();
  const code = (x) => s.F('paySupportCode_')(x, s.F('payXsupStoreBy_')(STORES()));
  const m = HTML.match(/const STORES=\[([^\]]*)\]/);
  const fromHtml = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : [];
  chk('payroll.html 舊 STORES 常數抓得到（5 家）', fromHtml.length === 5, fromHtml);
  const WANT = { '小辛辣光復': 'SSLGF', '墨竹亭金山': 'MZTJS', '墨竹亭光復': 'MZTGF', '墨竹亭六張犁': 'MZTLZL', '央廚': 'CF', '墨金': 'MZTJS', '墨復': 'MZTGF' };
  fromHtml.forEach((n) => chk('舊下拉「' + n + '」→ ' + WANT[n], code({ store: n }) === WANT[n], code({ store: n })));
  ['墨金', '墨復'].forEach((n) => chk('mock 簡寫「' + n + '」→ ' + WANT[n], code({ store: n }) === WANT[n]));
  chk('門市表名稱（含空白）「墨竹亭 金山店」→ MZTJS', code({ store: '墨竹亭 金山店' }) === 'MZTJS');
  chk('前後多空白「 央廚 」→ CF', code({ store: ' 央廚 ' }) === 'CF');
  chk('新列帶 code 以 code 為準', code({ code: 'mztgf', store: '亂寫' }) === 'MZTGF');
  chk('「光復」兩字不猜（兩個品牌都有光復）', code({ store: '光復' }) === '');
  chk('認不出回空字串', code({ store: '某某分店' }) === '' && code({ store: '' }) === '');
}

/* ── §5 handler 整條鏈（payroll_month／payroll_calc）── */
console.log('§5 handler 整條鏈');
{
  const s = ctx();
  s.__DB.input = [
    { ym: '2026-11', emp_id: 'E05', store: 'SSLGF', hours: 160, support: JSON.stringify([{ store: '央廚', hours: 6, rate: 240, amount: '' }]), hours_manual: '' },
    { ym: '2026-11', emp_id: 'E07', store: 'SSLGF', hours: 160, support: JSON.stringify([{ store: '某某分店', hours: 4, rate: 240, amount: '' }]) },
    { ym: '2026-11', emp_id: 'E08', store: 'SSLGF', hours: 160, support: JSON.stringify([{ store: '墨竹亭金山', hours: 6, rate: 240, amount: '' }]) },
  ];
  const mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('payroll_month ok＋support_auto', mo.ok && !!mo.support_auto, mo.error);
  chk('A 君 inputs 有 auto 列 12.5H', autoRows(mo.inputs, 'E01').length === 1 && autoRows(mo.inputs, 'E01')[0].hours === 12.5);
  chk('E 君差異列出（手填 6／打卡 8）', mo.support_auto.diffs.some((d) => d.emp_id === 'E05' && d.manual === 6 && d.auto === 8), mo.support_auto.diffs);
  chk('G 君 manual_unresolved', mo.support_auto.warn.manual_unresolved.indexOf('E07') >= 0);
  chk('H 君 cross_manual', mo.support_auto.warn.cross_manual.some((x) => x.emp_id === 'E08' && x.code === 'MZTJS'));
  chk('F 君 dup_pay', mo.support_auto.warn.dup_pay.some((x) => x.emp_id === 'E06'));
  chk('D 君 unmapped（對照未確認）', mo.support_auto.unmapped.some((x) => x.emp_id === 'CF23'));
  chk('逐日明細 detail.E01.CF', mo.support_auto.detail.E01 && mo.support_auto.detail.E01.CF.days.length === 2);
  const ra = (mo.run.results || []).find((r) => r.emp_id === 'E01');
  chk('run：A 君 support_hours=12.5（自動試算有帶入）', ra && ra.support_hours === 12.5, ra && ra.support_hours);
  const rb = (mo.run.results || []).find((r) => r.emp_id === 'E02');
  const cs = rb.earn.find((x) => x.item_key === 'cross_store');
  chk('計時 B 君：cross_store 3H × 主檔時薪 200 = 600', cs && cs.qty === 3 && cs.rate === 200 && cs.amount === 600, cs);
  const rj = s.H('payroll_month', { ym: '2026-11', store: 'SSLHQ' });
  chk('總部門市：J 君帶入光復 5H 並算進 run', (rj.run.results.find((r) => r.emp_id === 'HQ-05') || {}).support_hours === 5);
  // 計時費率不吃 wage_override 與加給（4B）
  s.__DB.input.push({ ym: '2026-11', emp_id: 'E02', store: 'SSLGF', hours: 6, wage_override: 260, full_attend: 1, support: '[]' });
  const c2 = s.H('payroll_calc', { ym: '2026-11', store: 'SSLGF' });
  const cs2 = c2.results.find((r) => r.emp_id === 'E02').earn.find((x) => x.item_key === 'cross_store');
  chk('計時有本月時薪 260＋滿勤勾選，支援費率仍是主檔 200', cs2 && cs2.rate === 200 && cs2.amount === 600, cs2);
  // 舊頁面送 auto 列被丟掉
  const c3 = s.H('payroll_calc', { ym: '2026-11', store: 'SSLGF', inputs: { E01: { hours: 8, support: [{ code: 'CF', store: '中央廚房', hours: 99, rate: 1, amount: '', auto: true }] } } });
  chk('payroll_calc：前端送來的 auto 列（99H）丟掉重算 → 12.5H', c3.results.find((r) => r.emp_id === 'E01').support_hours === 12.5);
  chk('payroll_calc 也回 support_auto', !!c3.support_auto && c3.support_auto.diffs.some((d) => d.emp_id === 'E05'));
  // ym=2026-10：沒有 support_auto、沒有 auto 列
  const old = s.H('payroll_month', { ym: '2026-10', store: 'SSLGF' });
  chk('ym=2026-10：payroll_month 沒有 support_auto、A 君沒有支援', old.ok && old.support_auto === undefined && sup(old.inputs, 'E01').length === 0
    && old.run.results.find((r) => r.emp_id === 'E01').support_hours === 0);
  const inp = s.H('payroll_inputs', { ym: '2026-11', store: 'SSLGF' });
  chk('payroll_inputs 也帶 auto 列但不產逐日明細', autoRows(inp.inputs, 'E01').length === 1 && Object.keys(inp.support_auto.detail).length === 0);
}

/* ── §6 存檔剔除 auto 列（§3.3）＋hours_manual ── */
console.log('§6 存檔');
{
  const s = ctx();
  const r = s.H('payroll_input_set', { ym: '2026-11', store: 'SSLGF', inputs: { E01: { hours: 8, support: [
    { code: 'CF', store: '中央廚房', hours: 12.5, rate: 240, amount: '', auto: true, days: [{ date: '2026-11-04' }] },
    { store: '央廚', hours: 2, rate: 240, amount: '', keep: true, auto_h: 12.5, junk: 'x' }] } } });
  const row = s.__DB.input.find((x) => x.emp_id === 'E01');
  const saved = JSON.parse(row.support);
  chk('input_set ok', r.ok);
  chk('auto 列不落地、手填列留 keep／auto_h、雜欄位不存', saved.length === 1 && !saved[0].auto && saved[0].keep === true && saved[0].auto_h === 12.5 && saved[0].junk === undefined && saved[0].days === undefined, saved);
  chk('整筆手動列 hours_manual=1', String(row.hours_manual) === '1');
  const s2 = ctx();
  s2.H('payroll_input_set', { ym: '2026-10', store: 'SSLGF', inputs: { E01: { hours: 8, support: [{ store: '央廚', hours: 2, rate: 240, amount: '', extra: 1 }] } } });
  chk('2026-10 存檔：支援欄原樣照存（不套白名單）', s2.__DB.input[0].support === JSON.stringify([{ store: '央廚', hours: 2, rate: 240, amount: '', extra: 1 }]));
}

/* ── §7 差異決定 payroll_support_decide（§7-4）── */
console.log('§7 差異決定');
{
  const s = ctx();
  // E 君：「僅 support」列（hours_manual='0'）＋手填央廚 6H
  s.__DB.input = [{ ym: '2026-11', emp_id: 'E05', store: 'SSLGF', hours: 0, support: JSON.stringify([{ store: '央廚', hours: 6, rate: 240, amount: '' }]), hours_manual: '0' },
                  { ym: '2026-11', emp_id: 'E01', store: 'MZTJS', hours: 1, support: '[]', hours_manual: '1' }];
  s.__CLOCK.LOCAL.approved.push(AP('2026-11-09', 'E05', 7.5));
  let mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('僅 support 列：本店時數照打卡歸集 7.5H（不凍結）', mo.inputs.E05.hours === 7.5 && mo.inputs.E05.custom_add_label === undefined, mo.inputs.E05);
  chk('僅 support 列：差異照列', mo.support_auto.diffs.some((d) => d.emp_id === 'E05'));
  let d = s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-11', emp_id: 'E05', code: 'CF', choice: 'keep', auto_h: 8 });
  const row = s.__DB.input.find((x) => x.emp_id === 'E05' && x.store === 'SSLGF');
  chk('keep：ok，該列加 keep＋auto_h，hours_manual 仍是 0', d.ok && JSON.parse(row.support)[0].keep === true && JSON.parse(row.support)[0].auto_h === 8 && String(row.hours_manual) === '0', [d, row]);
  chk('keep：別店的列原封不動', s.__DB.input.some((x) => x.store === 'MZTJS' && x.emp_id === 'E01'));
  s.__CLOCK.LOCAL.approved.push(AP('2026-11-10', 'E05', 2));
  mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('decide 之後再改核定：本店時數跟著變（9.5H），沒有被凍結', mo.inputs.E05.hours === 9.5);
  chk('keep 後差異不再提醒', !mo.support_auto.diffs.some((x) => x.emp_id === 'E05'));
  d = s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-11', emp_id: 'E05', code: 'CF', choice: 'auto', auto_h: 8 });
  chk('auto：刪掉手填列；僅 support 列刪到空就整列移除', d.ok && !s.__DB.input.some((x) => x.emp_id === 'E05'), s.__DB.input);
  mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('auto 之後：變成打卡帶入 8H', autoRows(mo.inputs, 'E05').length === 1 && autoRows(mo.inputs, 'E05')[0].hours === 8);
  // 整筆手動列：decide 只改 support 欄，hours 不動
  s.__DB.input.push({ ym: '2026-11', emp_id: 'E01', store: 'SSLGF', hours: 150, extra_ot: 2, support: JSON.stringify([{ store: '央廚', hours: 10, rate: 240, amount: '' }]), hours_manual: '' });
  d = s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-11', emp_id: 'E01', code: 'CF', choice: 'auto' });
  const r1 = s.__DB.input.find((x) => x.emp_id === 'E01' && x.store === 'SSLGF');
  chk('整筆手動列：只改 support，hours／extra_ot 原樣', d.ok && r1.hours === 150 && r1.extra_ot === 2 && r1.support === '[]' && String(r1.hours_manual) === '');
  chk('ym=2026-10 不給決定', s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-10', emp_id: 'E01', code: 'CF', choice: 'auto' }).error === 'xsup_off');
  chk('choice 亂填擋下', s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-11', emp_id: 'E01', code: 'CF', choice: 'x' }).error === 'bad_choice');
  s.__DB.run.push({ ym: '2026-11', store: 'SSLGF', emp_id: 'E01', status: 'final' });
  chk('已鎖定月份不給決定', s.H('payroll_support_decide', { store: 'SSLGF', ym: '2026-11', emp_id: 'E01', code: 'CF', choice: 'auto' }).error === 'locked');
}

/* ── §8 run 過期自動重算（§7-6）── */
console.log('§8 run 過期');
{
  const s = ctx();
  let mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('第一次：A 君 12.5H', mo.run.results.find((r) => r.emp_id === 'E01').support_hours === 12.5);
  s.__CLOCK['ck-cf'].approved.push(AP('2026-11-12', 'CF21', 3));
  mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('CF 多核定 3H、草稿 → 自動重算（recalc=true）、run 變 15.5H', mo.support_auto.recalc === true && mo.run.results.find((r) => r.emp_id === 'E01').support_hours === 15.5);
  mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('沒變動時不重算', !mo.support_auto.recalc);
  s.__DB.run.forEach((r) => { if (r.ym === '2026-11') r.status = 'final'; });
  s.__CLOCK['ck-cf'].approved.push(AP('2026-11-13', 'CF21', 1));
  const before = JSON.stringify(s.__DB.run);
  mo = s.H('payroll_month', { ym: '2026-11', store: 'SSLGF' });
  chk('已鎖定：只標 stale、不重算、run 一列不動', mo.support_auto.stale === true && !mo.support_auto.recalc && JSON.stringify(s.__DB.run) === before);
}

/* ── §9 打卡對照讀寫＋scope（§7-7／§7-8）── */
console.log('§9 xmap 讀寫與 scope');
{
  const s = ctx();
  s.__DB.xmap = [];
  const r = s.H('payroll_xmap_set', { rows: [
    { emp_no: 'D01', pay_store: 'sslgf', acct_store: 'CF', emp_id: 'CF21', state: 'confirmed', not_support: false },
    { emp_no: 'D02', pay_store: 'SSLGF', acct_store: 'HQ', emp_id: 'HQ-11', state: 'confirmed' },
    { emp_no: 'D02', pay_store: 'SSLGF', acct_store: 'SSLHQ', emp_id: 'HQ-11', state: 'confirmed' },   // 同一份表同一帳號 → 合併
    { emp_no: 'D03', pay_store: '', acct_store: 'CF', emp_id: 'CF22' },            // 空白代碼 → 丟棄（不可變成光復）
    { emp_no: 'D04', pay_store: 'SSLGF', acct_store: 'NOPE', emp_id: 'CF23' },     // 不存在的門市 → 丟棄
    { emp_no: 'D05', pay_store: 'SSLGF', acct_store: 'CF', emp_id: '' },           // 沒帳號 → 丟棄
    { emp_no: 'D06', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'CF24', state: 'rejected' },   // 不收 rejected
    { emp_no: 'D07', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'CF25', state: 'suggested', not_support: true },
  ], synced_at: '2026-11-05T10:00:00+08:00' });
  chk('xmap_set ok：留 3 列、丟 4 列', r.ok && r.count === 3 && r.dropped === 4, r);
  chk('空白代碼丟棄，沒有被當成光復寫入', !s.__DB.xmap.some((x) => x.emp_id === 'CF22'));
  chk('代碼正規化成大寫', s.__DB.xmap[0].pay_store === 'SSLGF');
  const g = s.H('payroll_xmap_get', {});
  chk('set → get 逐欄相同', g.ok && g.synced_at === '2026-11-05T10:00:00+08:00' && JSON.stringify(g.rows.map((x) => [x.emp_no, x.pay_store, x.acct_store, x.emp_id, x.not_support, x.state]))
    === JSON.stringify([['D01', 'SSLGF', 'CF', 'CF21', false, 'confirmed'], ['D02', 'SSLGF', 'HQ', 'HQ-11', false, 'confirmed'], ['D07', 'SSLGF', 'CF', 'CF25', true, 'suggested']]), g.rows);
  // scope
  s.__DB.xmap.push({ emp_no: 'D99', pay_store: 'MZTJS', acct_store: 'CF', emp_id: 'CF99', not_support: 'false', synced_at: 'x', state: 'confirmed' });
  const deny = s.H('payroll_xmap_set', { scope: ['SSLGF'], store: 'SSLGF', rows: [{ emp_no: 'D99', pay_store: 'MZTJS', acct_store: 'CF', emp_id: 'CFZZ' }] });
  chk('scope 下送別店（MZTJS）的列 → scope_forbidden', deny.ok === false && deny.error === 'scope_forbidden', deny);
  const ok2 = s.H('payroll_xmap_set', { scope: ['SSLGF'], store: 'SSLGF', rows: [{ emp_no: 'D01', pay_store: 'SSLGF', acct_store: 'CF', emp_id: 'CF21' }] });
  chk('scope 下 xmap_set 動不到別店列（MZTJS 那列還在、光復換成 1 列）', ok2.ok && s.__DB.xmap.some((x) => x.emp_id === 'CF99' && x.pay_store === 'MZTJS')
    && s.__DB.xmap.filter((x) => x.pay_store === 'SSLGF').length === 1, s.__DB.xmap);
  const g2 = s.H('payroll_xmap_get', { scope: ['SSLGF'], store: 'SSLGF' });
  chk('scope 下 xmap_get 只回負責門市的列', g2.ok && g2.rows.length === 1 && g2.rows[0].pay_store === 'SSLGF', g2.rows);
  const d2 = s.H('payroll_support_decide', { scope: ['SSLGF'], store: 'SSLGF', ym: '2026-11', emp_id: 'CF30', code: 'CF', choice: 'auto' });
  chk('scope 下 decide 動不到別店主檔的人', d2.ok === false && d2.error === 'scope_forbidden', d2);
  const d3 = s.H('payroll_support_decide', { scope: ['SSLGF'], store: 'CF', ym: '2026-11', emp_id: 'CF30', code: 'CF', choice: 'auto' });
  chk('scope 下 decide 不能指定負責範圍外的門市', d3.ok === false && d3.error === 'scope_forbidden');
}

/* ── §10 跨品牌打卡、打卡店沒有主檔（cross_no_master）── */
console.log('§10 cross_no_master');
{
  const s = ctx();
  const mo = s.H('payroll_month', { ym: '2026-11', store: 'MZTJS' });
  chk('金山端：A 君在本店有打卡 6H、但沒有主檔 → 提醒', mo.ok && mo.support_auto.warn.cross_no_master.some((x) => x.emp_id === 'JS07' && x.pay_store === 'SSLGF' && x.hours === 6), mo.support_auto && mo.support_auto.warn);
  s.__DB.master.push(EMP('JS07', 'MZTJS', { is_full_time: 'false', wage: 240 }));
  const mo2 = s.H('payroll_month', { ym: '2026-11', store: 'MZTJS' });
  chk('建了主檔（8A）就不提醒', mo2.support_auto.warn.cross_no_master.length === 0);
  const mo3 = s.H('payroll_month', { ym: '2026-11', store: 'CF' });
  chk('同組（CF＝*）不算跨品牌，不提醒', mo3.support_auto.warn.cross_no_master.length === 0);
}

/* ── §11 mock 切片：新引擎函式要在 payR0～Handlers 之間（payroll_mock.js 只抽這段）── */
console.log('§11 mock 切片');
{
  const a = P.indexOf('function payR0'), b = P.indexOf('/* ═══════════════════ Handlers');
  const slice = "function pad2(n){return ('0'+n).slice(-2)}\n" + P.slice(a, b);
  const ex = {};
  let err = '';
  try {
    new Function('exports', slice + '\nexports.core=paySupportAutoCore_;exports.merge=payMergeSupport_;exports.apply=payApplySupportAuto_;exports.cross=payCrossIncomingCore_;exports.strip=paySupportStrip_;exports.by=payXsupStoreBy_;')(ex);
  } catch (e) { err = String(e); }
  chk('切片載得起來且五支新函式都在', !err && typeof ex.core === 'function' && typeof ex.apply === 'function' && typeof ex.strip === 'function', err);
  let r = null;
  try {
    r = ex.core('2026-11', 'SSLGF', { xmap: XMAP(), stores: STORES(), master: MASTER(), days: true, tsDate: (t) => String(t).slice(0, 10), today: '2026-11-06',
      approvedMap: (code) => { const id = (STORES().find((x) => x.code === code) || {}).clock_ss_id || 'LOCAL'; const m = {}; (CLOCK()[id].approved).forEach((x) => { (m[x.date] = m[x.date] || {})[x.emp_id] = x; }); return m; },
      events: () => [] });
  } catch (e) { err = String(e); }
  chk('切片裡不靠試算表也算得出 A 君 12.5H（沒用到 payStore／payRead）', r && r.byEmp.E01.stores[0].hours === 12.5, err);
}

console.log(`\n${fail ? '❌ ' + fail + ' 項失敗' : '✅ 跨店支援自動帶入全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
