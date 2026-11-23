/**
 * 跨帳號重複出差／請假（2026-11-23 主管定案；_brain_out/dup-trip-leave/design.md 方案 A 第一階段）
 *  ①純函式 payDupXacctCore_ 跑共用案例檔 fixtures/dup-xacct-cases-v1.json（mala-store-ops 跑同一份）
 *  ②payDupOverlap_ 跟 Requests.gs reqOverlap_（B29）逐格一致
 *  ③整條 handlePayrollCalc → ot_info.dup_xacct → handlePayrollFinalize：會讓薪資重複的擋、其他只提醒
 *  ④開關關（PAY_DUP_XACCT_FROM 很後面）：計算結果、寫進 run／item、鎖定回應、讀了哪些分頁，跟 origin/main 逐位元組相同
 *  ⑤開關填錯值＝維持擋；偵測失敗＝擋（保護性）
 * 全部虛構門市與同仁；期望值手寫。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const { load, ftEmp } = require('./helpers/payroll-vm');
const CASES = require('./fixtures/dup-xacct-cases-v1.json');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g + '\n   規則要 ' + w); }
};
const KEY = 'test-admin-key';
const J = (x) => JSON.parse(JSON.stringify(x));

console.log('══ ① 純函式：共用案例檔 ══');
{
  const h = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures', 'dup-xacct-cases-v1.json'))).digest('hex');
  eq(h, '1d347c6a8b4d6e595ceec044065f156dca47aa12fa19e3cd05b5c2ed54394856', '共用案例檔跟 mala-store-ops 那份逐字相同（sha256 釘住；兩邊要一起改）');
}
{
  const s = load({ data: {}, clock: {} });
  for (const c of CASES.cases) {
    let got;
    try { got = J(s.call('payDupXacctCore_', J(c.accts), J(c.opt))).map((x) => [x.date, x.kind, x.cats, x.pay, x.approved, x.a.id, x.b.id]); }
    catch (e) { got = 'ERR ' + e.message; }
    eq(got, c.expect, c.name);
  }
}

console.log('\n══ ② payDupOverlap_ ＝ Requests.gs reqOverlap_（B29）逐格比對 ══');
{
  const s = load({ data: {}, clock: {} });
  const ours = vm.runInContext('payDupOverlap_', s), theirs = vm.runInContext('reqOverlap_', s);
  const T = []; for (let m = 0; m < 1440; m += 60) T.push(('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2));
  T.push('00:30', '23:30', '12:15');
  let n = 0, bad = [];
  for (const a of T) for (const b of T) for (const c of T) for (const d of T) {
    n++;
    const want = theirs(a, b, c, d) !== false, got = ours({ start: a, end: b }, { start: c, end: d });
    if (want !== got && bad.length < 5) bad.push([a, b, c, d, got, want]);
  }
  eq(bad, [], `逐格 ${n} 組（含跨夜、剛好接在一起）結果一致`);
  eq([ours({ start: '', end: '' }, { start: '09:00', end: '10:00' }), ours({ start: '09:00', end: '' }, { start: '20:00', end: '21:00' }), ours({}, {})], [true, true, true], '任一張沒有完整起訖＝整天，一定重疊');
}

/* ── ③ 整條鏈 ── */
const STORES = () => [
  { code: 'SSLGF', name: '小辛辣光復', clock_ss_id: '', emp_prefix: '', active: 'true', support_group: 'sxl' },
  { code: 'HQ', name: '總部', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: '*' },
  { code: 'MZTHQ', name: '墨竹亭總部', clock_ss_id: 'ck-hq', emp_prefix: '', active: 'true', support_group: 'mzt' },
  { code: 'MZTGF', name: '墨竹亭光復', clock_ss_id: 'ck-gf', emp_prefix: '', active: 'true', support_group: 'mzt' },
  { code: 'MZTJS', name: '墨竹亭金山', clock_ss_id: 'ck-js', emp_prefix: '', active: 'true', support_group: 'mzt' },
];
const XROW = (no, pay, acct, id, o) => Object.assign({ emp_no: no, pay_store: pay, acct_store: acct, emp_id: id, not_support: 'false', state: 'confirmed', synced_at: '2026-11-20T09:00:00+08:00' }, o);
const AP = (date, emp_id, h, st) => ({ date, emp_id, name: '', periods: '09:00-' + (9 + h) + ':00', approved_hours: h, status_text: st || '出差', manager_name: '值班主管', entered_at: date + 'T23:00:00+08:00' });
const RQ = (id, emp, date, kind, o) => Object.assign({ id, emp_id: emp, name: '', kind, date, leave_type: kind === 'trip' ? '出差' : '', start: '', end: '', hours: 8, status: 'approved', voided_at: '' }, o);
const LV = (date, name, type, h) => ({ '日期': date, '姓名': name, '假別': type, '時數': h });

/** 一個門市計薪的情境。pay＝計薪門市；over＝覆寫 xmap／clock。 */
function scene(pay, over) {
  over = over || {};
  const master = [ftEmp({ emp_id: 'HQ-03', name: '代號甲', store: pay }), ftEmp({ emp_id: 'HQ-04', name: '代號乙', store: pay })];
  const xmap = over.xmap || [
    XROW('DZY010', pay, 'HQ', 'HQ-03'), XROW('DZY010', pay, 'MZTGF', 'MZTGF01'),
    XROW('DZY011', pay, 'HQ', 'HQ-04'), XROW('DZY011', pay, 'MZTJS', 'MZTJS14'),
  ];
  const clock = {
    'ck-hq': { roster: [], events: [], approved: [AP('2026-11-05', 'HQ-03', 8)], leave: [LV('2026-11-05', '代號甲', '出差', 8)],
               requests: [RQ('rq-hq-1', 'HQ-03', '2026-11-05', 'trip')] },
    'ck-gf': { roster: [], events: [], approved: [AP('2026-11-05', 'MZTGF01', 8)], leave: [], requests: [RQ('rq-gf-1', 'MZTGF01', '2026-11-05', 'trip')] },
    'ck-js': { roster: [], events: [], approved: [], leave: [], requests: [] },
    LOCAL: { roster: [], events: [], approved: [], leave: [], requests: [] },
  };
  if (over.clock) over.clock(clock);
  const data = {
    master, xmap, store: STORES(),
    holiday: [{ ym: '2026-11', red_days: 10, note: '', dates: '', store: '' }],
    config: [], run: [], item: [], input: [], bonus: [], audit: [], leave_type: [], leave_span: [], leave_event: [], cost_snapshot: [],
  };
  return { data, clock };
}
function env(sc, opt) {
  opt = opt || {};
  const s = load({ data: J(sc.data), clock: {}, today: '2026-12-02', payrollSrc: opt.src });
  s.__CK = J(sc.clock); s.__READS = [];
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
    payClockRead = function (store, sheet) {
      var row = (__DATA.store || []).filter(function (x) { return String(x.code) === String(store); })[0];
      var id = row && row.clock_ss_id ? row.clock_ss_id : 'LOCAL';
      __READS.push(store + ':' + sheet);
      if (globalThis.__THROW && globalThis.__THROW(store, sheet)) throw new Error('打不開 ' + store + ' ' + sheet);
      return ((__CK[id] || {})[sheet] || []).map(function (r) { return Object.assign({}, r); });
    };`, s);
  if (opt.from !== undefined) vm.runInContext('PAY_DUP_XACCT_FROM = ' + JSON.stringify(opt.from) + ';', s);
  if (opt.stub !== false) vm.runInContext('paySchedMissingAll_=function(){return [];};payUnapprovedAll_=function(){return [];};payCompNegatives=function(){return [];};payLeaveMismatch_=function(){return [];};', s);
  s.post = (fn, body) => J(s.call(fn, Object.assign({ admin_key: KEY }, body)));
  return s;
}
const dupOf = (r, id) => { const x = (r.results || []).find((y) => y.emp_id === id); return x && x.ot_info ? (x.ot_info.dup_xacct || null) : 'NO_OT_INFO'; };
const linesOf = (r, id) => (dupOf(r, id) || []).map((x) => [x.pay, x.line]);
const lock = (s, st) => s.post('handlePayrollFinalize', { ym: '2026-11', store: st, lock: true });

let OLDSRC = null;
try { OLDSRC = cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', 'origin/main:apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { OLDSRC = null; }
console.log('\n══ ③-1 設計案例 1：DZY010 11/5 兩個帳號各一張整天出差（計薪門市是 HQ 或 MZTHQ 都要擋）══');
for (const pay of ['HQ', 'MZTHQ']) {
  const s = env(scene(pay));
  const r = s.post('handlePayrollCalc', { ym: '2026-11', store: pay });
  eq(r.ok, true, `[${pay}] 計算成功`);
  eq(linesOf(r, 'HQ-03'), [[true, '11/5 DZY010 出差：總部（HQ-03）整天 8 小時＋墨竹亭光復（MZTGF01）整天 8 小時']], `[${pay}] ot_info.dup_xacct 一筆、會讓薪資重複，白話照 design.md 草稿`);
  eq(dupOf(r, 'HQ-04'), null, `[${pay}] 沒有重複的人 ot_info 不多欄位`);
  const run = s.__DATA.run.find((x) => x.emp_id === 'HQ-03');
  eq(JSON.parse(run.ot_info).dup_xacct.length, 1, `[${pay}] 草稿 run.ot_info 也存了`);
  const L = lock(s, pay);
  eq([L.ok, L.error, (L.list || []).map((x) => [x.name, x.emp_id, x.list.length])], [false, 'dup_xacct', [['代號甲', 'HQ-03', 1]]], `[${pay}] 鎖定被擋：error dup_xacct`);
  eq(L.message, '不能鎖定：下面的同仁同一天在兩個打卡帳號重複申請出差或請假，薪資會重複計算工時。請先請人資作廢多出來的那張、該帳號重新核定，再按「重新計算」後鎖定。\n・11/5 DZY010 出差：總部（HQ-03）整天 8 小時＋墨竹亭光復（MZTGF01）整天 8 小時',
    `[${pay}] 擋住的訊息逐字照 design.md 草稿`);
  eq(s.__DATA.run.every((x) => x.status === 'draft'), true, `[${pay}] 被擋時仍是草稿`);
  // 作廢墨竹亭光復那張、重新計算 → 可以鎖
  s.__CK['ck-gf'].requests[0].status = 'voided'; s.__CK['ck-gf'].requests[0].voided_at = '2026-11-25T10:00:00+08:00';
  const L2 = lock(s, pay);
  eq([L2.ok, L2.error], [false, 'stale_run'], `[${pay}] 作廢後沒重算就鎖 → 先回 stale_run（鎖定前重算比對抓到重複不見了）`);
  s.post('handlePayrollCalc', { ym: '2026-11', store: pay });
  const L3 = lock(s, pay);
  eq([L3.ok, L3.status], [true, 'final'], `[${pay}] 重算後可以鎖`);
}

console.log('\n══ ③-2 其他規則 ══');
function calcLines(over, pay) {
  pay = pay || 'HQ';
  const s = env(scene(pay, over));
  const r = s.post('handlePayrollCalc', { ym: '2026-11', store: pay });
  return { s, r, l3: linesOf(r, 'HQ-03'), l4: linesOf(r, 'HQ-04') };
}
{
  // 出差＋計薪店請假 → 擋（②）
  let x = calcLines({ clock: (c) => { c['ck-hq'].requests = [RQ('rq-hq-2', 'HQ-03', '2026-11-05', 'leave', { leave_type: '事假' })]; } });
  eq(x.l3, [[true, '11/5 DZY010 事假＋出差：總部（HQ-03）事假 整天 8 小時＋墨竹亭光復（MZTGF01）出差 整天 8 小時']], '出差（支援帳號）＋計薪那家店請假 → 擋（②）');
  eq(lock(x.s, 'HQ').error, 'dup_xacct', '　鎖定被擋');
  // 出差＋支援店請假 → 只提醒（設計 3）
  x = calcLines({ clock: (c) => {
    c['ck-hq'].requests = [RQ('rq-hq-3', 'HQ-04', '2026-11-05', 'trip')];
    c['ck-js'].requests = [RQ('rq-js-1', 'MZTJS14', '2026-11-05', 'leave', { leave_type: '事假', start: '14:00', end: '18:00', hours: 4 })];
    c['ck-gf'].requests = [];
  } });
  eq(x.l4, [[false, '提醒：11/5 墨竹亭金山帳號（MZTJS14）登記了事假 4 小時，跟總部的出差時段重疊。支援店的假不會扣薪，請確認是不是重複申請。']], '出差（本店）＋支援店請假 → 只提醒，白話照 design.md 草稿');
  let L = lock(x.s, 'HQ');
  eq([L.ok, L.status], [true, 'final'], '　只提醒的不擋鎖定');
  // 同一帳號兩張重疊 → 擋（③）
  x = calcLines({ clock: (c) => { c['ck-gf'].requests = []; c['ck-hq'].requests = [
    RQ('rq-a', 'HQ-03', '2026-11-05', 'trip', { start: '09:00', end: '12:00', hours: 3 }),
    RQ('rq-b', 'HQ-03', '2026-11-05', 'trip', { start: '11:00', end: '13:00', hours: 2 })]; } });
  eq(x.l3, [[true, '11/5 DZY010 出差：總部（HQ-03）09:00–12:00 3 小時＋總部（HQ-03）11:00–13:00 2 小時']], '同一帳號兩張重疊的已核准單 → 擋（③）');
  // 剛好接在一起 → 不算
  x = calcLines({ clock: (c) => {
    c['ck-hq'].requests = [RQ('rq-a', 'HQ-03', '2026-11-05', 'trip', { start: '08:00', end: '12:00', hours: 4 })];
    c['ck-gf'].requests = [RQ('rq-b', 'MZTGF01', '2026-11-05', 'trip', { start: '12:00', end: '18:00', hours: 6 })]; } });
  eq(x.l3, [], '12:00 接 12:00 → 不算');
  // 只填時數沒填起訖 → 當整天
  x = calcLines({ clock: (c) => {
    c['ck-hq'].requests = [RQ('rq-a', 'HQ-03', '2026-11-05', 'trip', { start: '09:00', end: '10:00', hours: 1 })];
    c['ck-gf'].requests = [RQ('rq-b', 'MZTGF01', '2026-11-05', 'trip', { hours: 1 })]; } });
  eq(x.l3, [[true, '11/5 DZY010 出差：總部（HQ-03）09:00–10:00 1 小時＋墨竹亭光復（MZTGF01）整天 1 小時']], '另一張只填時數 → 當整天、重疊、擋');
  // 對照未確認／被駁回／acct_only → 不算同一人
  for (const st of ['rejected', 'suggested']) {
    x = calcLines({ xmap: [XROW('DZY010', 'HQ', 'HQ', 'HQ-03'), XROW('DZY010', 'HQ', 'MZTGF', 'MZTGF01', { state: st })] });
    eq(x.l3, [], `墨竹亭光復帳號的對照是 ${st} → 不算同一人`);
  }
  x = calcLines({ xmap: [XROW('DZY010', 'HQ', 'HQ', 'HQ-03'), XROW('DZY010', 'HQ', 'MZTGF', 'MZTGF01', { acct_only: 'true' })] });
  eq(x.l3, [], '對照是 acct_only（發薪店不歸同步的人管）→ 不算（同跨店支援自動帶入）');
  // 其中一張作廢／未核准 → 不算
  for (const [st, va] of [['voided', '2026-11-20T10:00:00+08:00'], ['pending', ''], ['rejected', '']]) {
    x = calcLines({ clock: (c) => { c['ck-gf'].requests[0].status = st; c['ck-gf'].requests[0].voided_at = va; } });
    eq(x.l3, [], `墨竹亭光復那張是 ${st} → 不算`);
  }
  // Mirror 抄的列
  x = calcLines({ clock: (c) => { c['ck-gf'].requests = []; c['ck-hq'].requests.push(RQ('rq-hq-1', 'HQ-03', '2026-11-05', 'trip', { mirror_src: 'CF', id: 'rq-m' })); } });
  eq(x.l3, [], '總部表裡 mirror_src=CF 的列先排除');
  // 跨單位（小辛辣光復計薪＋墨竹亭金山帳號）→ 只提醒
  {
    const sc = scene('SSLGF', { xmap: [XROW('DZY020', 'SSLGF', 'SSLGF', 'E01'), XROW('DZY020', 'SSLGF', 'MZTJS', 'MZTJS20')],
      clock: (c) => { c.LOCAL.requests = [RQ('rq-l', 'E01', '2026-11-10', 'trip')]; c['ck-js'].requests = [RQ('rq-j', 'MZTJS20', '2026-11-10', 'trip')]; c['ck-js'].approved = [AP('2026-11-10', 'MZTJS20', 8)]; } });
    sc.data.master = [ftEmp({ emp_id: 'E01', name: '代號丙', store: 'SSLGF' })];
    const s = env(sc);
    const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'SSLGF' });
    eq(linesOf(r, 'E01'), [[false, '提醒：11/10 墨竹亭金山帳號（MZTJS20）登記了出差 整天 8 小時，跟小辛辣光復帳號（E01）的出差時段重疊，請確認是不是重複申請。']], '跨單位兩個帳號都出差 → 只提醒（跨單位時數不自動帶入）');
    const L = lock(s, 'SSLGF');
    eq([L.ok, L.status], [true, 'final'], '　不擋鎖定');
  }
  // not_support 帳號 → 只提醒
  x = calcLines({ xmap: [XROW('DZY010', 'HQ', 'HQ', 'HQ-03'), XROW('DZY010', 'HQ', 'MZTGF', 'MZTGF01', { not_support: 'true' })] });
  eq(x.l3.map((y) => y[0]), [false], '支援帳號標 not_support（時數不帶入）→ 兩張出差只提醒');
  // 沒有任何對照的人：本店帳號同帳號重疊照樣擋
  x = calcLines({ xmap: [], clock: (c) => { c['ck-gf'].requests = []; c['ck-hq'].requests = [
    RQ('rq-a', 'HQ-03', '2026-11-05', 'trip', { start: '09:00', end: '12:00', hours: 3 }), RQ('rq-b', 'HQ-03', '2026-11-05', 'leave', { leave_type: '補休', start: '11:00', end: '12:00', hours: 1 })]; } });
  eq(x.l3, [[true, '11/5 HQ-03 出差＋補休：總部（HQ-03）出差 09:00–12:00 3 小時＋總部（HQ-03）補休 11:00–12:00 1 小時']], '沒有對照的人：同帳號重疊照樣擋，代號用薪資主檔工號');
  // 別的月份的單不算
  x = calcLines({ clock: (c) => { c['ck-gf'].requests[0].date = '2026-12-05'; c['ck-hq'].requests[0].date = '2026-12-05'; } });
  eq(x.l3, [], '12 月的單不進 11 月');
}

console.log('\n══ ③-3 驗收補（2026-11-23）：對照計薪店不一致、對照表讀不到、認人跟引擎同一口徑、各帶入路徑、② 集中一處 ══');
{
  // 第 1 項：主檔計薪門市跟對照表 pay_store 不一致（三個總部代號共用總部打卡表）→ 照樣認進來，不靜默排除
  for (const [pay, xpay] of [['MZTHQ', 'HQ'], ['HQ', 'MZTHQ'], ['HQ', 'SSLHQ'], ['MZTHQ', 'SSLGF']]) {
    const xm = [XROW('DZY010', xpay, 'HQ', 'HQ-03'), XROW('DZY010', xpay, 'MZTGF', 'MZTGF01')];
    let x = calcLines({ xmap: xm }, pay);
    eq(x.l3, [[false, '提醒：11/5 墨竹亭光復帳號（MZTGF01）登記了出差 整天 8 小時，跟總部帳號（HQ-03）的出差時段重疊，請確認是不是重複申請。']],
      `[主檔 ${pay}／對照 ${xpay}] 照樣偵測；引擎沒帶入墨竹亭光復的時數（pay_store 不一致）→ ① 只提醒（薪資沒重複）`);
    x = calcLines({ xmap: xm, clock: (c) => { c['ck-hq'].requests = [RQ('rq-hq-2', 'HQ-03', '2026-11-05', 'leave', { leave_type: '事假' })]; } }, pay);
    eq([x.l3.map((y) => y[0]), lock(x.s, pay).error], [[true], 'dup_xacct'], `[主檔 ${pay}／對照 ${xpay}] 計薪店請假＋另一帳號出差 → ② 照擋`);
  }
  // 第 2 項：對照表讀不到 → 檢查沒做完，鎖定擋
  {
    const s = env(scene('HQ'));
    vm.runInContext("var __pr0 = payRead; payRead = function (k) { if (k === 'xmap') throw new Error('對照表打不開'); return __pr0(k); };", s);
    const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq([r.ok, (r.results || []).every((x) => x.ot_info && x.ot_info.dup_xacct_err === true)], [true, true], '對照表讀不到：計算照樣完成、每人記 dup_xacct_err（不當空表）');
    eq(lock(s, 'HQ').error, 'dup_xacct_check_failed', '　鎖定擋 dup_xacct_check_failed');
  }
  // 認人口徑跟引擎（跨店支援自動帶入）共用 payXsupConfirmed_：引擎認的就認（含 state 空白），引擎不認的（大小寫不同）也不認
  for (const [st, want] of [['', true], [null, true], [undefined, true], ['confirmed ', true], ['Confirmed', false], ['CONFIRMED', false]]) {
    const xm = [XROW('DZY010', 'HQ', 'HQ', 'HQ-03', { state: st }), XROW('DZY010', 'HQ', 'MZTGF', 'MZTGF01', { state: st })];
    const x = calcLines({ xmap: xm });
    const h = x.r.results.find((y) => y.emp_id === 'HQ-03');
    const sup = Number(h.support_hours) || 0;
    eq([sup > 0, x.l3.map((y) => y[0]), lock(x.s, 'HQ').error], want ? [true, [true], 'dup_xacct'] : [false, [], undefined],
      `對照 state=${JSON.stringify(st)}：引擎${want ? '有' : '沒有'}帶入墨竹亭光復時數 → 重複檢查${want ? '認得、兩張整天出差擋' : '也不認、可鎖'}（跟引擎一致）`);
  }
  // pay_store 不一致、引擎沒帶入 → ① 只提醒可鎖；金額跟「墨竹亭光復沒有那張單」時完全相同（證明沒有重複算）
  {
    const xm = [XROW('DZY010', 'MZTHQ', 'HQ', 'HQ-03'), XROW('DZY010', 'MZTHQ', 'MZTGF', 'MZTGF01')];
    const a = calcLines({ xmap: xm });
    const b = calcLines({ xmap: xm, clock: (c) => { c['ck-gf'].requests = []; c['ck-gf'].approved = []; } });
    const pick = (x) => { const h = x.r.results.find((y) => y.emp_id === 'HQ-03'); return [h.gross, h.deduction, h.net, h.total_hours, h.support_hours, h.ot_paid_hours]; };
    eq([a.l3.map((y) => y[0]), pick(a)], [[false], pick(b)], 'pay_store 不一致（主檔 HQ／對照 MZTHQ）：只提醒；應發、扣款、實付、時數跟沒有第二張單時逐項相同');
    eq([lock(a.s, 'HQ').ok], [true], '　可以鎖');
  }
  // 其他帶入路徑：總部 Mirror（央廚帳號的核定抄進本店打卡表）→ 時數實際進計薪 → ① 要擋（not_support、pay_store 不一致都一樣）
  for (const [label, xpay] of [['對照計薪店一致', 'HQ'], ['對照計薪店不一致', 'MZTHQ']]) {
    const sc = scene('HQ', { xmap: [XROW('DZY027', xpay, 'HQ', 'HQ-03'), XROW('DZY027', xpay, 'CF', 'HQ-03', { not_support: 'true' })],
      clock: (c) => {
        c['ck-gf'].requests = []; c['ck-gf'].approved = [];
        c['ck-cf'] = { roster: [], events: [], leave: [], approved: [AP('2026-11-05', 'HQ-03', 8)], requests: [RQ('rq-cf-1', 'HQ-03', '2026-11-05', 'trip')] };
        c['ck-hq'].approved = [Object.assign(AP('2026-11-05', 'HQ-03', 8), { mirror_src: 'CF', entered_at: '2026-11-06T04:00:00+08:00' })];
      } });
    sc.data.store.push({ code: 'CF', name: '央廚', clock_ss_id: 'ck-cf', emp_prefix: '', active: 'true', support_group: '*' });
    let s = env(sc);
    let r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq([linesOf(r, 'HQ-03').map((y) => y[0]), lock(s, 'HQ').error], [[true], 'dup_xacct'], `Mirror 路徑（${label}、央廚帳號 not_support）：央廚核定抄進總部表、時數進計薪 → 兩張整天出差擋`);
    const sc2 = J(sc);
    sc2.clock['ck-hq'].approved = [AP('2026-11-05', 'HQ-03', 8)];
    s = env(sc2);
    r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(linesOf(r, 'HQ-03').map((y) => y[0]), [false], `　對照組（${label}）：總部表沒有抄自央廚的核定 → 央廚帳號時數沒進計薪 → 只提醒`);
  }
  // 手填的跨店支援時數（沒有日期、對不回哪個帳號哪一天）：主管 2026-11-23 定案保守擋——這個月有手填支援（> 0）＋① 兩帳號都出差 → 擋
  {
    const xm = [XROW('DZY010', 'MZTHQ', 'HQ', 'HQ-03'), XROW('DZY010', 'MZTHQ', 'MZTGF', 'MZTGF01')];
    const SUP = (h) => ({ 'HQ-03': { support: [{ code: 'MZTGF', store: '墨竹亭光復', hours: h, rate: 240, amount: '' }] } });
    const run1 = (sc, inputs, src) => { const s = env(sc, { src }); const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ', inputs }); return { s, r }; };
    let { s, r } = run1(scene('HQ', { xmap: xm }), SUP(8));
    eq([Number(r.results.find((y) => y.emp_id === 'HQ-03').support_hours), linesOf(r, 'HQ-03')], [8, [[true, '11/5 DZY010 出差：總部（HQ-03）整天 8 小時＋墨竹亭光復（MZTGF01）整天 8 小時']]],
      '有手填支援 8 小時＋① 兩帳號整天出差（pay_store 不一致、引擎沒帶入）→ 擋，訊息沿用既有那一行');
    let L = s.post('handlePayrollFinalize', { ym: '2026-11', store: 'HQ', lock: true, inputs: SUP(8) });
    eq([L.error, L.message], ['dup_xacct', '不能鎖定：下面的同仁同一天在兩個打卡帳號重複申請出差或請假，薪資會重複計算工時。請先請人資作廢多出來的那張、該帳號重新核定，再按「重新計算」後鎖定。\n・11/5 DZY010 出差：總部（HQ-03）整天 8 小時＋墨竹亭光復（MZTGF01）整天 8 小時'], '　鎖定擋 dup_xacct，句子不變');
    for (const h of [0, '', null]) {
      ({ s, r } = run1(scene('HQ', { xmap: xm }), SUP(h)));
      eq(linesOf(r, 'HQ-03').map((y) => y[0]), [false], `手填支援時數 ${JSON.stringify(h)} → 當沒有，維持只提醒`);
    }
    ({ s, r } = run1(scene('HQ', { xmap: xm }), undefined));
    eq([linesOf(r, 'HQ-03').map((y) => y[0]), lock(s, 'HQ').ok], [[false], true], '沒有手填支援＋pay_store 不一致的 ① → 維持只提醒、可鎖');
    // 只限 ①：手填支援＋支援店請假（只提醒那類）→ 仍只提醒
    ({ s, r } = run1(scene('HQ', { xmap: xm, clock: (c) => { c['ck-gf'].requests = [RQ('rq-gf-2', 'MZTGF01', '2026-11-05', 'leave', { leave_type: '事假', start: '14:00', end: '18:00', hours: 4 })]; } }), SUP(8)));
    eq(linesOf(r, 'HQ-03').map((y) => y[0]), [false], '手填支援＋本店出差／支援店請假 → 不在範圍，仍只提醒');
    // 有手填支援但沒有重複 → 不擋、計算回應與 run 跟 GitHub main 逐字相同
    if (OLDSRC) {
      const sc = scene('HQ', { xmap: xm, clock: (c) => { c['ck-gf'].requests = []; } });
      const a = run1(sc, SUP(8), OLDSRC), b = run1(sc, SUP(8));
      eq(JSON.stringify(b.r) === JSON.stringify(a.r) && JSON.stringify(b.s.__DATA.run) === JSON.stringify(a.s.__DATA.run), true, '有手填支援但沒有重複：計算回應、run 跟 main 逐字相同');
      const Lb = b.s.post('handlePayrollFinalize', { ym: '2026-11', store: 'HQ', lock: true, inputs: SUP(8) });
      eq([Lb.ok, Lb.status], [true, 'final'], '　可以鎖');
    }
  }
  // 第 5 項：② 集中在 PAY_DUP_R2_ANY_TRIP_ 一行
  {
    const sc = scene('SSLGF', { xmap: [XROW('DZY020', 'SSLGF', 'SSLGF', 'E01'), XROW('DZY020', 'SSLGF', 'MZTJS', 'MZTJS20')],
      clock: (c) => { c.LOCAL.requests = [RQ('rq-l', 'E01', '2026-11-10', 'leave', { leave_type: '事假' })]; c['ck-js'].requests = [RQ('rq-j', 'MZTJS20', '2026-11-10', 'trip')]; c['ck-js'].approved = [AP('2026-11-10', 'MZTJS20', 8)]; } });
    sc.data.master = [ftEmp({ emp_id: 'E01', name: '代號丙', store: 'SSLGF' })];
    let s = env(sc);
    eq(linesOf(s.post('handlePayrollCalc', { ym: '2026-11', store: 'SSLGF' }), 'E01').map((y) => y[0]), [true], '計薪店請假＋跨單位帳號出差 → 現行擋（PAY_DUP_R2_ANY_TRIP_=true）');
    s = env(sc); vm.runInContext('PAY_DUP_R2_ANY_TRIP_ = false;', s);
    eq(linesOf(s.post('handlePayrollCalc', { ym: '2026-11', store: 'SSLGF' }), 'E01').map((y) => y[0]), [false], '　改成 false → 只提醒（只動這一行）');
  }
}

console.log('\n══ ③-4 Codex 第一輪 ══');
{
  // P1：開著算的草稿帶重複旗標 → 關開關 → 直接鎖：跟 main 拿同一份草稿鎖定逐字相同（不多一次 stale_run）
  if (OLDSRC) {
    const sc = scene('HQ');
    const on = env(sc); on.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(JSON.parse(on.__DATA.run.find((x) => x.emp_id === 'HQ-03').ot_info).dup_xacct.length, 1, 'P1 前提：開著算的草稿帶了 dup_xacct');
    const a = env(sc, { src: OLDSRC }), b = env(sc, { from: '9999-12' });
    a.__DATA.run = J(on.__DATA.run); b.__DATA.run = J(on.__DATA.run);
    const la = lock(a, 'HQ'), lb = lock(b, 'HQ');
    eq([JSON.stringify(lb) === JSON.stringify(la), lb.ok, lb.status], [true, true, 'final'], 'P1：關開關後直接鎖，回應跟 main 逐字相同、鎖成功（沒有 stale_run）');
    eq(JSON.stringify(b.__DATA.run) === JSON.stringify(a.__DATA.run) && JSON.stringify(b.__DATA.audit) === JSON.stringify(a.__DATA.audit), true, '　鎖定後 run／稽核跟 main 逐字相同');
  }
  // Codex 第二輪：開著算的草稿 → 關開關 → 讀月資料／讀草稿的回應跟 main 逐字相同（沒有 dup_xacct_on → 畫面不顯示那類提醒）
  if (OLDSRC) {
    const sc = scene('HQ');
    const on = env(sc); const rc = on.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(rc.dup_xacct_on, true, '開著、有重複：計算回應帶 dup_xacct_on');
    eq(on.post('handlePayrollMonth', { ym: '2026-11', store: 'HQ' }).dup_xacct_on, true, '開著、有重複：讀月資料也帶 dup_xacct_on');
    const a = env(sc, { src: OLDSRC }), b = env(sc, { from: '9999-12' });
    a.__DATA.run = J(on.__DATA.run); a.__DATA.item = J(on.__DATA.item); b.__DATA.run = J(on.__DATA.run); b.__DATA.item = J(on.__DATA.item);
    const ma = a.post('handlePayrollMonth', { ym: '2026-11', store: 'HQ' }), mb = b.post('handlePayrollMonth', { ym: '2026-11', store: 'HQ' });
    eq([JSON.stringify(mb) === JSON.stringify(ma), 'dup_xacct_on' in mb], [true, false], '關開關：讀月資料（payroll_month）回應跟 main 逐字相同、不帶 dup_xacct_on');
    eq(JSON.stringify(b.post('handlePayrollGet', { ym: '2026-11' })) === JSON.stringify(a.post('handlePayrollGet', { ym: '2026-11' })), true, '關開關：讀草稿（payroll_get）回應跟 main 逐字相同');
    const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
    eq([/if\(DUPX_ON\) \(o\.dup_xacct\|\|\[\]\)\.forEach/.test(html), /if\(DUPX_ON&&o\.dup_xacct_err\)/.test(html), (html.match(/DUPX_ON=!!r\.dup_xacct_on/g) || []).length], [true, true, 3],
      '畫面：提醒區兩行都要 DUPX_ON；DUPX_ON 只從後端回應的 dup_xacct_on 來（計算、讀月資料、重算三處）');
  }
  // P2-1：對照表分頁不存在（讀回 0 列）→ 引擎自動帶入 0 小時，金額跟沒有第二張單時相同；沒有手填支援 → 照常可鎖
  {
    const a = calcLines({ xmap: [] });
    const b = calcLines({ xmap: [], clock: (c) => { c['ck-gf'].requests = []; c['ck-gf'].approved = []; } });
    const pick = (x) => { const h = x.r.results.find((y) => y.emp_id === 'HQ-03'); return [h.gross, h.deduction, h.net, h.total_hours, h.support_hours]; };
    eq([pick(a), a.l3, lock(a.s, 'HQ').ok], [pick(b), [], true], 'P2 對照表沒有資料：引擎支援時數 0、金額跟沒有第二張單逐項相同，可鎖');
    const s = env(scene('HQ', { xmap: [] }));
    const inputs = { 'HQ-03': { support: [{ code: 'MZTGF', store: '墨竹亭光復', hours: 8, rate: 240, amount: '' }] } };
    const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ', inputs });
    eq([Number(r.results.find((y) => y.emp_id === 'HQ-03').support_hours), linesOf(r, 'HQ-03'), s.post('handlePayrollFinalize', { ym: '2026-11', store: 'HQ', lock: true, inputs }).ok],
      [8, [], true], '【現況，待定】P2 對照表沒有資料＋手填支援 8 小時：手填時數進計薪、但認不出人 → 偵測不到、可鎖（對照表沒資料＝「還沒同步」，主線 support-auto-regression 要求這種狀態跟改版前逐項相同）');
  }
  // P2-2：申請分頁不存在 ≡ 分頁存在但空的（requests 分頁是第一張申請單送出時才建，Requests.gs reqSheet_(ss, true)）
  {
    const miss = calcLines({ clock: (c) => { delete c['ck-gf'].requests; } });
    const empty = calcLines({ clock: (c) => { c['ck-gf'].requests = []; } });
    const pick = (x) => { const h = x.r.results.find((y) => y.emp_id === 'HQ-03'); return [h.support_hours, x.l3, h.net]; };
    eq([pick(miss), lock(miss.s, 'HQ').ok], [pick(empty), lock(empty.s, 'HQ').ok], 'P2 支援店沒有 requests 分頁：結果跟「有分頁但沒有任何申請單」完全相同（新店沒有申請單不擋）');
    eq(Number(miss.r.results.find((y) => y.emp_id === 'HQ-03').support_hours), 8, '　（那天的核定照樣帶入 8 小時＝主管直接核定、沒有申請單的情況，屬已知限制「只看申請分頁」，有沒有分頁都一樣）');
    const R = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8');
    eq(/function reqSheet_\(ss, create\) \{\s*var sh = ss\.getSheetByName\(REQ_SHEET_\);\s*if \(!sh && create\) \{\s*sh = ss\.insertSheet\(REQ_SHEET_\);/.test(R), true, '　佐證：requests 分頁是送單時才建（reqSheet_ create 才 insertSheet）');
  }
  // P3：草稿算完後同仁退出名單 → 重算跳過此人，舊草稿列照定案；跟 main 同一個行為（已知限制）
  if (OLDSRC) {
    const sc = scene('HQ', { clock: (c) => { c['ck-gf'].requests = []; } });
    const on = env(sc); on.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    const sc2 = J(sc); sc2.data.master[0].active = 'false'; sc2.data.master[0].leave_date = '2026-10-31';
    sc2.clock['ck-gf'].requests = [RQ('rq-gf-1', 'MZTGF01', '2026-11-05', 'trip')];
    const a = env(sc2, { src: OLDSRC }), b = env(sc2);
    a.__DATA.run = J(on.__DATA.run); b.__DATA.run = J(on.__DATA.run);
    const la = lock(a, 'HQ'), lb = lock(b, 'HQ');
    eq([JSON.stringify(lb) === JSON.stringify(la), lb.ok], [true, true], 'P3（已知限制）：草稿後才退出名單的人，本版跟 main 一樣照草稿定案');
  }
}

console.log('\n══ ④ 開關關：跟 origin/main 逐位元組相同 ══');
let OLD = null;
try { OLD = cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', 'origin/main:apps-script/Payroll.gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
catch (e) { console.log('⚠ 取不到 origin/main，跳過逐位元組比對'); }
if (OLD) {
  const NEWSRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
  eq(OLD !== NEWSRC, true, '基準與本版確實不同（比對有意義）');
  for (const pay of ['HQ', 'MZTHQ']) {
    const sc = scene(pay);
    const a = env(sc, { src: OLD }), b = env(sc, { from: '9999-12' });
    const ra = a.post('handlePayrollCalc', { ym: '2026-11', store: pay }), rb = b.post('handlePayrollCalc', { ym: '2026-11', store: pay });
    eq(JSON.stringify(rb) === JSON.stringify(ra), true, `[${pay}] 計算回應逐字相同（有 DZY010 那筆重複的資料）`);
    eq(JSON.stringify(b.__DATA.run) === JSON.stringify(a.__DATA.run) && JSON.stringify(b.__DATA.item) === JSON.stringify(a.__DATA.item), true, `[${pay}] 寫進 run／item 的每一列逐字相同`);
    eq(JSON.stringify(b.__READS) === JSON.stringify(a.__READS), true, `[${pay}] 讀打卡分頁的順序與次數相同（沒有多讀 requests）`);
    const la = lock(a, pay), lb = lock(b, pay);
    eq(JSON.stringify(lb) === JSON.stringify(la), true, `[${pay}] 鎖定回應逐字相同（${la.ok ? '鎖成功' : la.error}）`);
    eq(JSON.stringify(b.__DATA.run) === JSON.stringify(a.__DATA.run) && JSON.stringify(b.__DATA.audit) === JSON.stringify(a.__DATA.audit), true, `[${pay}] 鎖定後 run／稽核逐字相同`);
  }
  // 開著、但沒有任何重複：也跟基準相同（沒有重複的人不多欄位）
  {
    const sc = scene('HQ', { clock: (c) => { c['ck-gf'].requests = []; } });
    const a = env(sc, { src: OLD }), b = env(sc);
    const ra = a.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' }), rb = b.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(JSON.stringify(rb) === JSON.stringify(ra) && JSON.stringify(b.__DATA.run) === JSON.stringify(a.__DATA.run), true, '開著但沒有重複：計算回應、run 逐字相同');
    eq(JSON.stringify(lock(b, 'HQ')) === JSON.stringify(lock(a, 'HQ')), true, '開著但沒有重複：鎖定回應逐字相同');
  }
  // payLockStale_ 比對字串：開關關時同一份草稿兩版結果相同
  {
    const sc = scene('HQ');
    const a = env(sc, { src: OLD }), b = env(sc, { from: '9999-12' });
    a.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' }); b.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(JSON.stringify(b.post('payLockStale_', { ym: '2026-11', store: 'HQ' }) || null), JSON.stringify(a.post('payLockStale_', { ym: '2026-11', store: 'HQ' }) || null), '開關關：payLockStale_ 回傳相同');
  }
  // 2026-10（開關月份之前）：開著也跟基準相同
  {
    const sc = scene('HQ', { clock: (c) => { for (const k of ['ck-hq', 'ck-gf']) { c[k].requests.forEach((q) => { q.date = '2026-10-05'; }); c[k].approved.forEach((q) => { q.date = '2026-10-05'; }); } c['ck-hq'].leave[0]['日期'] = '2026-10-05'; } });
    sc.data.holiday.push({ ym: '2026-10', red_days: 9, note: '', dates: '', store: '' });
    const a = env(sc, { src: OLD }), b = env(sc);
    const ra = a.post('handlePayrollCalc', { ym: '2026-10', store: 'HQ' }), rb = b.post('handlePayrollCalc', { ym: '2026-10', store: 'HQ' });
    eq(JSON.stringify(rb) === JSON.stringify(ra) && JSON.stringify(b.__READS) === JSON.stringify(a.__READS), true, '2026-10（生效月之前）：開著也逐字相同、不多讀');
  }
}

console.log('\n══ ⑤ 開關值與保護性 ══');
{
  for (const v of ['abc', '', null, '2026-13', '2026/11', 202611]) {
    const s = env(scene('HQ'), { from: v });
    const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq([linesOf(r, 'HQ-03').length, lock(s, 'HQ').error], [1, 'dup_xacct'], `開關填錯值 ${JSON.stringify(v)} → 照上線月份 2026-11 維持擋`);
  }
  for (const [v, want] of [['2026-11', 'dup_xacct'], ['2026-12', undefined], ['9999-12', undefined]]) {
    const s = env(scene('HQ'), { from: v });
    s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(lock(s, 'HQ').error, want, `開關 ${v} → 11 月${want ? '擋' : '不擋'}`);
  }
  eq(vm.runInContext('PAY_DUP_XACCT_FROM', load({ data: {}, clock: {} })), '2026-11', '上線值 PAY_DUP_XACCT_FROM＝2026-11');
  // 偵測時讀不到某家店的申請分頁 → 每人記 dup_xacct_err，鎖定擋
  {
    const s = env(scene('HQ'));
    vm.runInContext("globalThis.__THROW = function (st, sh) { return st === 'MZTGF' && sh === 'requests'; };", s);
    const r = s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq([r.ok, (r.results || []).every((x) => x.ot_info && x.ot_info.dup_xacct_err === true)], [true, true], '讀不到支援店申請分頁：計算照樣完成，每人記 dup_xacct_err');
    const L = lock(s, 'HQ');
    eq([L.ok, L.error, L.message], [false, 'dup_xacct_check_failed', '檢查「跨帳號重複出差／請假」失敗，這次沒有鎖定，請按「重新計算」後再鎖定一次'], '　鎖定擋 dup_xacct_check_failed');
    vm.runInContext('globalThis.__THROW = null;', s);
    s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    eq(lock(s, 'HQ').error, 'dup_xacct', '　讀得到之後照常判斷（這份資料有 DZY010 那筆 → 擋 dup_xacct）');
  }
  // 解鎖不擋
  {
    const s = env(scene('HQ'));
    s.post('handlePayrollCalc', { ym: '2026-11', store: 'HQ' });
    s.__DATA.run.forEach((x) => { x.status = 'final'; });
    const r = s.post('handlePayrollFinalize', { ym: '2026-11', store: 'HQ', lock: false, reason: '測試' });
    eq([r.ok, r.status], [true, 'draft'], '解鎖不擋');
  }
}

console.log('\n══ ⑥ 畫面 payroll.html ══');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
  eq(/r\.error==='dup_xacct'\|\|r\.error==='dup_xacct_check_failed'\)\) alert\(r\.message\)/.test(html), true, '鎖定被 dup_xacct／dup_xacct_check_failed 擋時跳對話框（同 leave_mismatch）');
  eq(/\(o\.dup_xacct\|\|\[\]\)\.forEach\(x=>rows\.push\(x\.pay\?/.test(html) && /esc\(x\.line\)/.test(html), true, '提醒區逐筆列出（pay 紅字「處理前不能鎖定」、其他黃字），文字跳脫');
  eq(/o\.dup_xacct_err/.test(html), true, '檢查沒做完也列出');
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
