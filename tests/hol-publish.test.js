/**
 * 節日表由營運系統發布（2026-11-24，節日表只留一份第 2 個改動）：接收端 payroll_holiday_publish、開關 PAY_HOL_SOURCE、
 * 只收推送時的薪資頁同步／算薪／手動覆寫、本店專屬唯讀清單。
 * 規則白話與手算對照見 docs/holiday-publish/README.md 第 5 節（H1～H8 在下面逐一驗）。
 * 推送內容用 tests/fixtures/hol-publish-v1.json（營運系統正本 payrollRows()）；全部虛構門市與同仁。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 500) + '\n   應為 ' + w.slice(0, 500)); }
};
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key', SVC = 'test-hol-svc-key';
const PUSH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hol-publish-v1.json'), 'utf8'));
delete PUSH._note;
const push = (over) => Object.assign(J(PUSH), { svcKey: SVC }, over || {});

const G = (ym, red, dates, o) => Object.assign({ ym, red_days: red, note: '依人事行政總處115年中華民國政府行政機關辦公日曆表', dates: dates || '', store: '' }, o || {});
/** 正式環境 2026-11-24 的樣子：2026-05～12 集團列（照 115 年行事曆），沒有 2027 */
const PROD = () => [G('2026-05', 11), G('2026-06', 9), G('2026-07', 8), G('2026-08', 10), G('2026-09', 10, '2026-09-25, 2026-09-28'),
  G('2026-10', 11, '2026-10-09, 2026-10-26'), G('2026-11', 9), G('2026-12', 9, '2026-12-25')];

function env(opt) {
  opt = opt || {};
  const s = load({ data: { holiday: opt.holiday || PROD(), run: opt.run || [], audit: [], master: [], store: [], config: [] }, today: '2026-11-24' });
  s.__PROPS = Object.assign({ PAY_HOL_SVC_KEY: SVC }, opt.props || {}); s.__PROPW = []; s.__PROPR = 0;
  s.__NOWYM = opt.nowYm || '2026-11'; s.__FETCH = 0; s.__W = 0; s.__LOCK = opt.lock === false ? false : true;
  s.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => { s.__PROPR++; return Object.prototype.hasOwnProperty.call(s.__PROPS, k) ? s.__PROPS[k] : null; },
    setProperty: (k, v) => { s.__PROPW.push(k); s.__PROPS[k] = String(v); } }) };
  s.UrlFetchApp = { fetch: () => { s.__FETCH++; throw new Error('測試不連網'); } };
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    currentYmTaipei = function () { return __NOWYM; };
    var __ra = payReplaceAll; payReplaceAll = function (k, rows) { __W++; return __ra(k, rows); };
    payWriteLocked_ = function (kinds, fn) { if (!__LOCK) return false; fn(); return true; };`, s);
  s.H = vm.runInContext('PAYROLL_HANDLERS', s);
  s.pub = (body) => J(s.H.payroll_holiday_publish(body));
  s.hol = () => J(s.__DATA.holiday);
  s.row = (ym, st) => s.hol().find((r) => String(r.ym) === ym && String(r.store || '') === (st || ''));
  return s;
}
const MINI = { PAY_HOL_SOURCE: 'mini' };
/** 拒收時：分頁一格不動、沒有稽核、沒有寫屬性、沒有寫分頁 */
function untouched(s, before, m) {
  eq([JSON.stringify(s.hol()) === before, s.__DATA.audit.length, s.__PROPW, s.__W], [true, 0, [], 0], m + '：分頁一格不動、沒有稽核、沒有記版本');
}

console.log('══ 1) 服務金鑰 ══');
{
  const s = env({ props: Object.assign({ PAY_HOL_SVC_KEY: '' }, MINI) }), b = JSON.stringify(s.hol());
  eq(s.pub(push()).error, 'unauthorized', '指令碼屬性 PAY_HOL_SVC_KEY 沒設 → 一律拒絕');
  untouched(s, b, '沒設金鑰');
  const s2 = env({ props: MINI }), b2 = JSON.stringify(s2.hol());
  eq([s2.pub(push({ svcKey: 'wrong' })).error, s2.pub(Object.assign(push(), { svcKey: undefined, admin_key: KEY })).error], ['unauthorized', 'unauthorized'], '金鑰錯、只帶管理金鑰 → unauthorized（只認服務金鑰）');
  untouched(s2, b2, '金鑰錯');
  eq(s2.pub(Object.assign(push(), { scope: ['SSLGF'], admin_key: KEY })).error, 'scope_forbidden', '帶門市範圍 → scope_forbidden（集團功能）');
  eq(J(s2.H.payroll_holiday_own_list({ admin_key: KEY, scope: ['SSLGF'] })).error, 'scope_forbidden', '本店專屬清單帶門市範圍 → scope_forbidden');
}

console.log('\n══ 2) 合格推送（H1：正式環境 2026-11 收第一版）══');
{
  const s = env({ props: MINI });
  const r = s.pub(push());
  eq([r.ok, r.mode, r.dry_run, r.added, r.version, r.current], [true, 'mini', false, true, '2027-1', ''], '回應：成功、記成新版本 2027-1');
  eq(r.months_new, ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12'], 'H1 新增 2027 整年 12 個月');
  eq([r.months_changed, r.skipped_locked, r.skipped_past, r.past_missing, r.own_rows], [[], [], [], [], 0], 'H1 2026-11、12 跟推送相同不寫；過去月份相同；沒有本店專屬');
  eq(r.changed, r.months_new, 'changed＝這次實際寫的月份');
  eq([s.row('2027-02').red_days, s.row('2027-02').dates], [13, '2027-02-04, 2027-02-05, 2027-02-08, 2027-02-09, 2027-02-10'], '2027-02 寫入：紅字 13、加發日含 2/9、2/10');
  eq([s.row('2027-03').dates, s.row('2027-01').dates], ['2027-03-01', '2027-01-01'], '2027-03 加發日 3/1（替 2/28）、2027-01 加發日 1/1');
  eq(s.hol().filter((x) => String(x.ym) < '2026-05').length, 0, '2026-01～04（薪酬系統之前）不建列');
  eq(s.__W, 1, '分頁只整張寫一次');
  const a = s.__DATA.audit;
  eq([a.length, a[0].action, a[0].operator, a[0].store, a[0].ym], [1, 'holiday_publish', 'mini', '', ''], '稽核一筆 holiday_publish（operator＝mini）');
  eq(a[0].reason, '營運系統節日表 版本 2027-1（發布 2026-11-24T20:52:47+08:00）：新增 2027-01、2027-02、2027-03、2027-04、2027-05、2027-06、2027-07、2027-08、2027-09、2027-10、2027-11、2027-12', '稽核寫哪一版、何時發布、改了哪幾個月');
  const st = JSON.parse(s.__PROPS.PAY_HOL_PUB);
  eq([st.version, st.published_at, st.years, typeof st.hash, st.received_at.slice(0, 10)], ['2027-1', '2026-11-24T20:52:47+08:00', ['2026', '2027'], 'string', '2026-11-24'], '版本記在 PAY_HOL_PUB');
  eq(JSON.parse(s.__PROPS.PAY_HOL_PUB_VIEW).moved['2027-02-07'], '2027-02-10', '顯示用補假對照記在 PAY_HOL_PUB_VIEW');

  console.log('\n── 同版本重送（冪等）──');
  const w0 = s.__W, a0 = s.__DATA.audit.length, p0 = s.__PROPW.length, h0 = JSON.stringify(s.hol());
  const r2 = s.pub(push());
  eq([r2.ok, r2.added, r2.changed, r2.drift], [true, false, [], []], '同版本同內容 → added:false、不寫');
  eq([s.__W - w0, s.__DATA.audit.length - a0, s.__PROPW.length - p0, JSON.stringify(s.hol()) === h0], [0, 0, 0, true], '同版本重送：分頁、稽核、屬性都沒動');

  console.log('\n── 分頁被別的管道改過（同版本）：只回報、reapply 才對齊 ──');
  s.__DATA.holiday.find((x) => x.ym === '2027-02').dates = '2027-02-04';
  const r3 = s.pub(push());
  eq([r3.added, r3.changed, r3.drift, s.row('2027-02').dates], [false, [], ['2027-02'], '2027-02-04'], '同版本、分頁不同 → drift 列出 2027-02、不寫');
  const r4 = s.pub(push({ reapply: true }));
  eq([r4.ok, r4.added, r4.changed, s.row('2027-02').dates.split(', ').length], [true, false, ['2027-02'], 5], 'reapply:true → 只把 2027-02 對齊回這一版');
  eq(s.__DATA.audit[s.__DATA.audit.length - 1].reason.indexOf('重新套用 版本 2027-1') >= 0, true, 'reapply 稽核寫「重新套用」');
  eq(JSON.parse(s.__PROPS.PAY_HOL_PUB).version, '2027-1', 'reapply 不改版本紀錄');

  console.log('\n── 版本倒退、同版本改內容、升版 ──');
  const b = JSON.stringify(s.hol()), wB = s.__W, aB = s.__DATA.audit.length, pB = s.__PROPW.length;
  const old = s.pub(push({ version: '2027-0' }));
  eq(old.error, 'bad_payload', '版本 2027-0（第 0 版）格式不對');
  const pre = J(PUSH); pre.version = '2026-9';
  for (const y of ['2027']) for (let m = 1; m <= 12; m++) delete pre.rows[y + '-' + ('0' + m).slice(-2)];
  const rb = s.pub(Object.assign(pre, { svcKey: SVC }));
  eq([rb.ok, rb.error, rb.current], [false, 'version_rollback', '2027-1'], '版本 2026-9 比目前 2027-1 舊 → version_rollback');
  const cf = J(PUSH); cf.rows['2027-06'].note = '改過的說明';
  const rc = s.pub(Object.assign(cf, { svcKey: SVC }));
  eq([rc.ok, rc.error], [false, 'version_conflict'], '同版本 2027-1 內容不同（連說明也算）→ version_conflict');
  eq([JSON.stringify(s.hol()) === b, s.__W - wB, s.__DATA.audit.length - aB, s.__PROPW.length - pB], [true, 0, 0, 0], '倒退、衝突：分頁、稽核、屬性都沒動');
  const up = J(PUSH); up.version = '2027-2'; up.rows['2027-06'].note = '改過的說明';
  const ru = s.pub(Object.assign(up, { svcKey: SVC }));
  eq([ru.ok, ru.added, ru.current, ru.changed, JSON.parse(s.__PROPS.PAY_HOL_PUB).version], [true, true, '2027-1', [], '2027-2'], '升版 2027-2（只改說明）→ 收下、記新版本、沒有月份要改（說明不影響薪資）');
  eq(s.__DATA.audit[s.__DATA.audit.length - 1].reason.slice(-6), '沒有月份要改', '升版沒有月份要改也留一筆稽核');
}

console.log('\n══ 3) 不合格整份拒收（分頁一格不動）══');
{
  const cases = [
    ['空表 rows:{}', (p) => { p.rows = {}; }],
    ['沒有 rows', (p) => { delete p.rows; }],
    ['rows 是陣列', (p) => { p.rows = Object.values(p.rows); }],
    ['少一個月（2027-05）', (p) => { delete p.rows['2027-05']; }],
    ['只送 2027 半年', (p) => { for (let m = 7; m <= 12; m++) delete p.rows['2027-' + ('0' + m).slice(-2)]; }],
    ['日期格式錯 2027/02/04', (p) => { p.rows['2027-02'].dates = p.rows['2027-02'].dates.replace('2027-02-04', '2027/02/04'); }],
    ['日期用全形逗號', (p) => { p.rows['2027-02'].dates = p.rows['2027-02'].dates.replace(/, /g, '，'); }],
    ['不存在的日期 2027-02-30', (p) => { p.rows['2027-02'].dates = '2027-02-04, 2027-02-30'; }],
    ['別月份的日期', (p) => { p.rows['2027-03'].dates = '2027-02-28, 2027-03-01'; }],
    ['日期沒排序', (p) => { p.rows['2027-02'].dates = '2027-02-05, 2027-02-04'; }],
    ['日期重複', (p) => { p.rows['2027-02'].dates = '2027-02-04, 2027-02-04'; }],
    ['紅字天數是文字', (p) => { p.rows['2027-02'].red_days = '13'; }],
    ['紅字天數 30 天（不合理）', (p) => { p.rows['2027-02'].red_days = 30; }],
    ['紅字天數 0 天（不合理）', (p) => { p.rows['2027-11'].red_days = 0; }],
    ['紅字天數小數', (p) => { p.rows['2027-11'].red_days = 8.5; }],
    ['加發日比紅字天數多', (p) => { p.rows['2026-11'].red_days = 8; p.rows['2026-11'].dates = '2026-11-02, 2026-11-03, 2026-11-04, 2026-11-05, 2026-11-06, 2026-11-09, 2026-11-10, 2026-11-11, 2026-11-12'; }],
    ['加發生效前（2026-05）有日期', (p) => { p.rows['2026-05'].dates = '2026-05-01'; }],
    ['含本店專屬店別 store:CF', (p) => { p.rows['2027-02'].store = 'CF'; }],
    ['多一個不認得的欄位', (p) => { p.rows['2027-02'].extra = 1; }],
    ['ym 跟鍵不同', (p) => { p.rows['2027-02'].ym = '2027-03'; }],
    ['月份鍵 2027-13', (p) => { p.rows['2027-13'] = J(p.rows['2027-12']); p.rows['2027-13'].ym = '2027-13'; }],
    ['沒有今年', (p) => { for (let m = 1; m <= 12; m++) delete p.rows['2026-' + ('0' + m).slice(-2)]; }],
    ['年份中間斷掉（2026、2028）', (p) => { for (let m = 1; m <= 12; m++) { const k = '2027-' + ('0' + m).slice(-2), n = '2028-' + ('0' + m).slice(-2); p.rows[n] = Object.assign(J(p.rows[k]), { ym: n, dates: '' }); delete p.rows[k]; } p.version = '2028-1'; }],
    ['整年紅字天數太少', (p) => { for (let m = 1; m <= 12; m++) { const r = p.rows['2027-' + ('0' + m).slice(-2)]; r.red_days = 7; r.dates = ''; } }],
    ['version 年份跟內容最後一年不同', (p) => { p.version = '2026-3'; }],
    ['version 格式錯', (p) => { p.version = 'v3'; }],
    ['沒有 v', (p) => { delete p.v; }],
    ['v 不是 1', (p) => { p.v = 2; }],
    ['沒有發布時間', (p) => { delete p.published_at; }],
    ['發布時間沒時區', (p) => { p.published_at = '2026-11-24 20:52'; }],
    ['dry_run 是文字', (p) => { p.dry_run = 'true'; }],
    ['moved 有不是日期的', (p) => { p.moved = { x: 'y' }; }],
    ['names 太長', (p) => { p.names = { '2027-01-01': 'x'.repeat(41) }; }],
    ['confirmed_by 太長', (p) => { p.confirmed_by = 'x'.repeat(41); }],
  ];
  cases.forEach(([nm, f]) => {
    const s = env({ props: MINI }), b = JSON.stringify(s.hol());
    const p = push(); f(p);
    const r = s.pub(p);
    eq([r.ok, r.error, Array.isArray(r.problems) && r.problems.length > 0, /整份沒有收/.test(r.message || '')], [false, 'bad_payload', true, true], '拒收：' + nm + (r.problems ? '（' + r.problems[0] + '）' : ''));
    untouched(s, b, nm);
  });
  // 試推也一樣先檢查
  const s = env({}), b = JSON.stringify(s.hol());
  eq(s.pub(push({ dry_run: true, rows: {} })).error, 'bad_payload', '試推空表也拒收');
  untouched(s, b, '試推空表');
}

console.log('\n══ 4) 已鎖定、已經過去的月份（H2～H6）══');
{
  // H2：2026-12 那格錯了、沒有人鎖 → 改
  const s = env({ props: MINI });
  s.__DATA.holiday.find((x) => x.ym === '2026-12').dates = '';
  let r = s.pub(push());
  eq([r.months_changed, s.row('2026-12').dates], [['2026-12'], '2026-12-25'], 'H2 本月以後那格不同、沒人鎖 → 改回 12/25');
  // H3：光復 2026-12 已鎖定（用集團列）→ 跳過
  const s3 = env({ props: MINI, run: [{ ym: '2026-12', store: 'SSLGF', emp_id: 'E1', status: 'final' }] });
  s3.__DATA.holiday.find((x) => x.ym === '2026-12').dates = '';
  r = s3.pub(push());
  eq([r.months_changed, r.skipped_locked, s3.row('2026-12').dates], [[], ['2026-12'], ''], 'H3 使用集團列的門市已鎖定 → 2026-12 跳過不動');
  eq(s3.__DATA.audit[0].reason.indexOf('已鎖定跳過 2026-12') >= 0, true, 'H3 稽核寫已鎖定跳過');
  // H4：鎖定的店另有本店專屬 2026-12 → 不吃集團列，集團列照改；本店專屬列不動
  const own = G('2026-12', 10, '2026-12-25', { store: 'SSLGF', note: '本店' });
  const s4 = env({ props: MINI, holiday: PROD().concat([own]), run: [{ ym: '2026-12', store: 'SSLGF', emp_id: 'E1', status: 'final' }] });
  s4.__DATA.holiday.find((x) => x.ym === '2026-12' && !x.store).dates = '';
  r = s4.pub(push());
  eq([r.months_changed, r.skipped_locked, s4.row('2026-12').dates, r.own_rows], [['2026-12'], [], '2026-12-25', 1], 'H4 鎖定的店用本店專屬列 → 集團列照改');
  eq(s4.row('2026-12', 'SSLGF'), own, 'H4 本店專屬列一格不動');
  // 本店專屬列排在集團列前面、內容跟推送不同：不能被當成集團列比對（集團列相同＝這個月不用改）
  const s4b = env({ props: MINI, holiday: [own].concat(PROD()) });
  r = s4b.pub(push());
  eq([r.months_changed, r.own_rows, s4b.__DATA.holiday[0]], [[], 1, own], '本店專屬列排在前面：不拿它跟推送比、集團列相同就不改、本店列不動');
  // H5：過去月份（2026-10）跟推送不同 → 不動、回報
  const s5 = env({ props: MINI });
  s5.__DATA.holiday.find((x) => x.ym === '2026-10').red_days = 7;
  r = s5.pub(push());
  eq([r.skipped_past, s5.row('2026-10').red_days, r.months_changed], [['2026-10'], 7, []], 'H5 已經過去的 2026-10 跟推送不同 → 不動，列在 skipped_past');
  // H6：過去月份缺列（2026-09）→ 不補、回報
  const s6 = env({ props: MINI, holiday: PROD().filter((x) => x.ym !== '2026-09') });
  r = s6.pub(push());
  eq([r.past_missing, !!s6.row('2026-09')], [['2026-09'], false], 'H6 已經過去的 2026-09 缺列 → 不補，列在 past_missing');
  eq(s6.__DATA.audit[0].reason.indexOf('已經過去的月份不動 2026-09') >= 0, true, 'H6 稽核寫已經過去的月份不動');
  // H7：本月（2026-11）已鎖定 → 跳過；2027 照新增
  const s7 = env({ props: MINI, run: [{ ym: '2026-11', store: 'HQ', emp_id: 'E1', status: 'final' }, { ym: '2026-11', store: 'CF', emp_id: 'E2', status: 'draft' }] });
  s7.__DATA.holiday.find((x) => x.ym === '2026-11').red_days = '';
  r = s7.pub(push());
  eq([r.skipped_locked, s7.row('2026-11').red_days, r.months_new.length], [['2026-11'], '', 12], 'H7 本月有門市已鎖定（紅字空白也不補）→ 跳過；2027 照樣新增 12 個月');
  // H8：時間到 2027-01：2026-12 變成過去月份
  const s8 = env({ props: MINI, nowYm: '2027-01' });
  s8.__DATA.holiday.find((x) => x.ym === '2026-12').dates = '';
  r = s8.pub(push());
  eq([r.skipped_past, s8.row('2026-12').dates, r.months_new[0]], [['2026-12'], '', '2027-01'], 'H8 2027-01 收到時 2026-12 已經過去 → 不動；2027-01 起新增');
}

console.log('\n══ 5) 試推（dry_run）與開關 ══');
{
  const s = env({}), b = JSON.stringify(s.hol());
  const r = s.pub(push({ dry_run: true }));
  eq([r.ok, r.mode, r.dry_run, r.added, r.would_change.length, r.changed], [true, 'gov', true, true, 12, undefined], '開關預設時試推：回報會新增 12 個月');
  untouched(s, b, '試推');
  const r2 = s.pub(push());
  eq([r2.ok, r2.error, r2.mode], [false, 'hol_source_gov', 'gov'], '開關預設時正式推送 → hol_source_gov（只接受試推）');
  untouched(s, b, '開關預設時正式推送');
  const sm = env({ props: MINI }), bm = JSON.stringify(sm.hol());
  eq(sm.pub(push({ dry_run: true })).would_change.length, 12, '只收推送時也能試推');
  untouched(sm, bm, '只收推送時試推');
  const sb = env({ props: MINI, lock: false }), bb = JSON.stringify(sb.hol());
  eq(sb.pub(push()).error, 'busy', '拿不到寫鎖 → busy');
  untouched(sb, bb, '拿不到寫鎖');

  const src = (v) => { const e = env({ props: v === undefined ? {} : { PAY_HOL_SOURCE: v } }); return vm.runInContext('payHolSource_', e)(); };
  eq([undefined, '', 'gov', 'GOV', 'mini', 'MINI', ' Mini ', 'minii', 'mini2', 'true', '1'].map(src),
    ['gov', 'gov', 'gov', 'gov', 'mini', 'mini', 'mini', 'gov', 'gov', 'gov', 'gov'], '開關：沒設／空白／gov／亂填＝gov；只有 mini（不分大小寫、可有前後空白）才是只收推送');
}

console.log('\n══ 6) 只收推送時：薪資頁同步、算薪、手動覆寫 ══');
{
  // 還沒收到任何一版
  const s = env({ props: MINI }), b = JSON.stringify(s.hol());
  let r = J(s.H.payroll_holiday_sync({ admin_key: KEY, years: [2026], operator: 'auto', store: 'SSLGF' }));
  eq([r.ok, r.changed, r.status, r.hol_source, r.hol_pub, s.__FETCH], [true, [], [], 'mini', null, 0], '開薪資頁：不連人事行政總處、hol_pub＝null');
  eq(r.message, '節日表改由營運系統發布，但薪資還沒有收到任何一版；請先到營運系統確認並發布節日表。', '還沒收到任何一版的提示');
  eq(r.holidays.map((h) => h.ym), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'], '照樣回分頁現況給畫面');
  untouched(s, b, '只收推送時開薪資頁');
  eq(J(s.H.payroll_holiday_sync({ admin_key: 'x', years: [2026] })).error, 'unauthorized', '金鑰錯照舊 unauthorized');
  eq(J(s.H.payroll_holiday_sync({ admin_key: KEY, years: [1900] })).error, 'bad_year', '年份錯照舊 bad_year');
  // 收到一版後、時間到 2028-01 而推送只到 2027
  s.pub(push());
  s.__NOWYM = '2028-01';
  r = J(s.H.payroll_holiday_sync({ admin_key: KEY, years: [2028], store: 'SSLGF' }));
  eq([r.hol_pub.version, r.hol_pub.published_at, r.hol_missing.length, s.__FETCH], ['2027-1', '2026-11-24T20:52:47+08:00', 12, 0], '2028-01 開頁：回版本與發布時間、缺 2028 整年、不連外');
  eq(r.message, '還沒有 2028-01 的節日資料，這個月不能計算薪資；請先到營運系統確認並發布 2028 年節日表。', '缺本月資料的提示');
  // 算薪：缺列 → 不同步、明確擋下
  const n = s.__FETCH, w = s.__W;
  r = J(s.H.payroll_calc({ admin_key: KEY, ym: '2028-01', store: 'SSLGF', inputs: {} }));
  eq([r.ok, r.error, s.__FETCH - n, s.__W - w], [false, 'no_holiday', 0, 0], '算 2028-01：no_holiday、不連外、不寫分頁');
  eq(r.message, '薪資計算（2028-01）：還沒有這個月的節日資料，這次沒有計算。請先到營運系統確認並發布 2028 年節日表，再重新計算。', '算薪缺資料提示（照確認頁預覽③）');
  // 手動整批覆寫擋下
  const before = JSON.stringify(s.hol());
  for (const st of ['', 'CF']) {
    r = J(s.H.payroll_holiday_set({ admin_key: KEY, store: st, holidays: [G('2027-06', 9, '2027-06-09')] }));
    eq([r.ok, r.error], [false, 'hol_source_mini'], '只收推送時 payroll_holiday_set（' + (st || '集團') + '）擋下');
  }
  eq(JSON.stringify(s.hol()) === before, true, '擋下時分頁不動');
  // 本店專屬清單（唯讀）
  const so = env({ props: MINI, holiday: PROD().concat([G('2026-12', 10, '2026-12-25', { store: 'CF', note: '央廚自訂' }), G('2026-10', 11, '2026-10-09, 2026-10-26', { store: 'HQ' })]) });
  const bo = JSON.stringify(so.hol()), rp = so.__PROPR;
  const ol = J(so.H.payroll_holiday_own_list({ admin_key: KEY }));
  eq([ol.ok, ol.count, ol.rows.map((x) => [x.ym, x.store, x.red_days, x.dates, x.global_red_days, x.same_as_global])],
    [true, 2, [['2026-10', 'HQ', 11, '2026-10-09, 2026-10-26', 11, true], ['2026-12', 'CF', 10, '2026-12-25', 9, false]]], '本店專屬清單：列出兩筆、標出跟集團列是否相同');
  eq([JSON.stringify(so.hol()) === bo, so.__W, so.__DATA.audit.length, so.__PROPW, so.__PROPR - rp], [true, 0, 0, [], 0], '本店專屬清單唯讀：不寫分頁、稽核、屬性，也不讀屬性');
  eq(J(so.H.payroll_holiday_own_list({ admin_key: 'x' })).error, 'unauthorized', '本店專屬清單要管理金鑰');
}

console.log('\n══ 7) 開關預設時：既有動作的行為照舊（細部對照在 hol-publish-equiv）══');
{
  const s = env({});
  const r = J(s.H.payroll_holiday_set({ admin_key: KEY, store: 'CF', holidays: [G('2027-06', 9, '2027-06-09')] }));
  eq([r.ok, r.count, r.store, !!s.row('2027-06', 'CF')], [true, 1, 'CF', true], '開關預設：payroll_holiday_set 照舊可存（含本店專屬）');
  const r2 = J(s.H.payroll_holiday_sync({ admin_key: KEY, years: [2026], store: 'SSLGF' }));
  eq([r2.ok, r2.hol_source, r2.hol_pub, s.__FETCH > 0], [true, undefined, undefined, true], '開關預設：開頁同步照舊連人事行政總處、回應沒有新欄位');
}

console.log(`\n${fail ? '❌' : '✅'} hol-publish：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
