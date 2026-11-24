/* 補缺卡改讀「店＋期」分塊快取（2026-11-25；Cap10.gs capMakeFill_ → capMakeFillAll_(…, true) → capGraceSched_；拿掉整表快取 capSchedPub_）
 *
 * 規則白話版（這次只換「班表從哪裡讀」，補法一個字沒改）：
 *   1. 開關 '1'／'2'（九店現在都是 '1'）算「當日出勤滿 10 小時」時，缺下班卡（或缺上班卡）的那張本店卡用本店已發布班表補：
 *      孤單上班卡找開始差 2 小時內的時段、用它的結束；孤單下班卡找結束差 2 小時內的、用它的開始；凌晨 06:00 以前的下班卡算前一天。別家店的卡不補。
 *   2. 原本班表整張 sched_pub 一個快取鍵（capsched:v1），整張超過 90000 字就不快取 → 每次要補都重讀整張；
 *      改成跟班表寬限（#232）、跨店補時（#234）同一份「店＋期」分塊快取（capgr1:），5 分鐘。
 *   3. 正常資料（正式發布流程 SchedPub.gs 寫出來的）補出來的時間、收卡結果逐筆相同；只有手改 sched_pub 分頁造出的五種壞資料不同（F5，大腦已接受）。
 * 手算：
 *   F3 金山（mzt）本人 E01：光復那列排 A 09–18、金山那列排 L 09–21；09:00 上班沒下班 → 金山補到 21:00（讀金山那塊），不是 18:00。
 *   F5-4 班表列有 null：09:00、17:30 兩張上班卡、班表 A 09–18，19:05 開頁：舊版整期讀列丟錯 → 09:00 那張孤單、只算 17:30–19:00＝1.5 小時、不鎖；
 *        新版跳過 null 列 → 09:00–17:30＝8.5 ＋ 1.5＝10 → 19:00 收卡、鎖。
 * 舊版＝git show ${CAP_FILL_BASE:-0bf30bd}:apps-script/Cap10.gs（這次改之前的主線）。 */
'use strict';
const path = require('path'), { execFileSync } = require('child_process');
const { make, T, at, check, show, done, R } = require('./helpers/gs-sandbox');

const BASE = process.env.CAP_FILL_BASE || '0bf30bd';
const single = (s) => { const o = s.replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;'); if (o === s) throw new Error('找不到 CAP_SINGLE_STORES'); return o; };   // 沙盒兩家店：'2' 寬限才會真的生效
const NEW = single(R('apps-script/Cap10.gs'));
const OLD = single(execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', BASE + ':apps-script/Cap10.gs'], { encoding: 'utf8' }));
if (NEW.indexOf('function capSchedPub_') >= 0) throw new Error('新版還有 capSchedPub_');
if (OLD.indexOf('function capSchedPub_') < 0) throw new Error('舊版（' + BASE + '）沒有 capSchedPub_，CAP_FILL_BASE 指錯');

const D = '2026-11-20';
const HERE = Object.assign({ accuracy: 10 }, at(3));
const SP_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const PEER = { emp_id: 'B07', name: '測試一', key: 'KB', device_id: 'DB', active: 'TRUE' };
const SH = [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'N', name: '夜', start: '18:00', end: '02:00' },
  { id: 'S', name: '兩段', start: '09:00', end: '20:00', segs: [{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }] },
  { id: 'L', name: '長', start: '09:00', end: '21:00' }];
const cellsOf = (map) => Array.from({ length: 28 }, (_, i) => map[i] || { t: 'R' });
const one = (shifts, emp, map) => ({ start: '2026-11-01', shifts, rows: [{ emp_id: emp, name: '測試一', cells: cellsOf(map) }] });
const hmOf = (ms) => (ms === null || ms === undefined ? null : new Date(ms + 8 * 3600000).toISOString().slice(11, 16));
/** 中文名字、每人 28 格都排班的大班表（讓整張 sched_pub 超過 90000 字） */
const bigRows = (n, tag) => Array.from({ length: n }, (_, i) => ({ emp_id: 'Z' + tag + i, name: '同仁名字' + tag + i, cells: cellsOf(Object.fromEntries(Array.from({ length: 28 }, (_, j) => [j, { t: 'W', s: 'A' }]))) }));
const BIG = (k) => ['zz', 'T0' + (k + 2), { start: '2026-11-01', shifts: SH, rows: bigRows(40, k) }];

/** view 'gf'＝本店是光復（sched_pub 在本店）；'mzt'＝本店是金山（sched_pub 在光復＝別家店的試算表）。
 *  opt：cap、now、ev（本店 [ts, emp, type]）、pev（別家店）、pub（[[店別, 期別, 資料物件或字串], …]）、roster */
function world(src, view, opt) {
  const selfSpec = { roster: opt.roster || [ME], events: opt.ev || [] }, peerSpec = { roster: [PEER], events: opt.pev || [] };
  const m = make({ now: T(opt.now || D + 'T19:05:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: opt.cap }, self: selfSpec, peers: { SS_P: peerSpec } });
  m.run(src);
  if (opt.cap === undefined) delete m.props.REST_CAP_ON;
  m.sb.REST_PEERS_ = view === 'gf' ? [{ code: 'mzt', ss: 'SS_P' }, { code: 'gf', ss: 'SELF' }] : [{ code: 'mzt', ss: 'SELF' }, { code: 'gf', ss: 'SS_P' }];
  const gf = view === 'gf' ? m.self : m.peers.SS_P;
  const sh = gf.insertSheet('sched_pub'); sh.appendRow(SP_HEAD);
  (opt.pub || []).forEach((p) => sh.appendRow([p[0], p[1], 1, typeof p[2] === 'string' ? p[2] : JSON.stringify(p[2]), 'op', '']));
  m.__reads = 0;
  const g = sh.getDataRange; sh.getDataRange = function () { m.__reads++; return g.apply(this, arguments); };
  m.__sp = sh;
  return m;
}
const fillAt = (m, kind, hms, emp) => hmOf(m.sb.capMakeFill_(emp || 'E01')(kind, { ms: T(hms), store: '' }));
const page = (m) => { const c = (m.sb.handleLiffStatus_({ id_token: 'TOK_U1' }).cap) || {}; return c.locked ? 'LOCK' + c.sys_hm : c.grace_hm ? 'grace' + c.grace_hm : 'free'; };
const meRow = (m) => m.sb.readSheetAsObjects(m.sb.getSS().getSheetByName('roster')).rows.filter((r) => r.emp_id === 'E01')[0];
/** 直接用 capMakeFill_ 跑 capJudge_／capSegs_（判斷本身，不經過開頁） */
function judge(m) {
  const sb = m.sb, ss = sb.getSS(), me = meRow(m), now = sb.__now;
  const ev = sb.capEventsFor_(ss, me, now, null);
  const r = sb.capJudge_(ev, now, sb.capMakeFill_(me.emp_id), sb.capBreak_(), sb.capLeavesFor_(ss, me, now));
  const segs = sb.capSegs_(ev, now, sb.capMakeFill_(me.emp_id));
  return { r, filled: (segs.segs || []).filter((x) => x.filled).length };
}

console.log('\n════ F1 正常資料：新舊兩版逐筆相同（開關 \'1\'、\'2\' 各跑；隨機串） ════');
let seed = 20261125;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pk = (xs) => xs[Math.floor(rnd() * xs.length)];
const hm = (min) => ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
const iso = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
const OPS = ['status', 'sweep', 'in_line', 'out_line', 'in_old', 'out_old', 'today'];
function op(m, o) {
  const sb = m.sb, ty = /^in/.test(o) ? 'in' : 'out';
  if (o === 'status') return sb.handleLiffStatus_({ id_token: 'TOK_U1' });
  if (o === 'sweep') { sb.capSweep(); return null; }
  if (o === 'today') { const on = sb.capOn_(); return on ? sb.capTodayMs_(sb.getSS(), meRow(m), sb.__now) : 'off'; }
  if (/_line$/.test(o)) return sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: ty, confirm_same: true }, HERE));
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: 'K1', type: ty, device_id: 'D1' }, HERE)) } }).text);
}
/** 一串隨機情境：{view, opt, steps:[[時間, 動作]]} */
function genChain(cap) {
  const view = pk(['gf', 'gf', 'mzt']), alias = view === 'gf' ? '' : 'mzt', other = view === 'gf' ? 'mzt' : '';
  const day = pk([D, D, '2026-11-29']);                       // 11-29＝T02 第一天（前一天 11-28 是 T01 最後一格）：跨期
  const per = day === D ? 'T01' : 'T02', idx = day === D ? 19 : 0, prevPer = 'T01', prevIdx = day === D ? 18 : 27;
  const rs = ri(24, 60) * 15, len = ri(16, 48) * 15;          // 隨機班別 06:00–15:00 開始、4–12 小時
  const shifts = SH.concat([{ id: 'X', name: '隨機', start: hm(rs), end: hm((rs + len) % 1440) }]);
  const cell = () => { const r = rnd(); if (r < 0.15) return { t: 'R' }; if (r < 0.2) return { t: 'H', s: pk(['A', 'L']) }; if (r < 0.25) return { t: 'W', s: 'Q' }; return { t: 'W', s: pk(['A', 'N', 'S', 'L', 'X']) }; };
  const pub = [];
  const mine = {}; mine[idx] = cell();
  const prev = {}; prev[prevIdx] = cell();
  if (per === prevPer) { Object.assign(mine, prev); if (rnd() > 0.1) pub.push([alias, per, one(shifts, 'E01', mine)]); }
  else { if (rnd() > 0.1) pub.push([alias, per, one(shifts, 'E01', mine)]); if (rnd() > 0.1) pub.push([alias, prevPer, one(shifts, 'E01', prev)]); }
  const o2 = {}; o2[idx] = { t: 'W', s: 'L' };
  pub.push([other, per, one(SH, 'E01', o2)]);                  // 另一家店同工號排別的班（鍵對錯就會補錯）
  if (rnd() < 0.25) for (let k = 0; k < 6; k++) pub.push(BIG(k));   // 整張超過 90000 字：舊版每次重讀整張
  const ev = [], base = T(day + 'T00:00:00');
  let t = base - 18 * 3600000 + ri(0, 20) * 900000;
  for (let i = 0, n = ri(1, 4); i < n; i++) { ev.push([iso(t), 'E01', pk(['in', 'in', 'out'])]); t += ri(1, 40) * 900000; }
  const pev = rnd() < 0.3 ? [[iso(base + ri(28, 60) * 900000), 'B07', 'in']] : [];
  let now = Math.max(t, base + ri(56, 84) * 900000);
  const steps = [];
  for (let i = 0, n = ri(3, 6); i < n; i++) { steps.push([now, pk(OPS)]); now += ri(1, 40) * 60000; }
  return { view, opt: { cap, ev: ev.filter((e) => T(e[0]) <= steps[0][0]), pev, pub, now: iso(steps[0][0]) }, steps, big: pub.length > 6 };
}
function runChains(srcNew, n, cap) {
  let same = 0, filled = 0, bigN = 0, ops = 0; const bad = [];
  for (let k = 0; k < n; k++) {
    const c = genChain(cap), N = world(srcNew, c.view, c.opt), O = world(OLD, c.view, c.opt);
    if (c.big) bigN++;
    let diff = null;
    for (const [t, o] of c.steps) {
      N.setNow(t); O.setNow(t); ops++;
      const jn = judge(N), jo = judge(O);
      filled += jn.filled ? 1 : 0;
      const rn = JSON.stringify(op(N, o)), ro = JSON.stringify(op(O, o));
      if (JSON.stringify(jn) !== JSON.stringify(jo)) diff = 'judge ' + JSON.stringify(jn.r) + ' vs ' + JSON.stringify(jo.r);
      else if (rn !== ro) diff = o + ' 回應 ' + rn + ' vs ' + ro;
      else if (JSON.stringify(N.self.sh.events.values) !== JSON.stringify(O.self.sh.events.values)) diff = o + ' 打卡列不同';
      else if (JSON.stringify(N.props) !== JSON.stringify(O.props)) diff = o + ' 屬性不同';
      if (diff) { bad.push([k, c.view, diff.slice(0, 300)]); break; }
    }
    if (!diff) same++;
  }
  return { same, bad, filled, bigN, ops };
}
const N1 = 300;
const res = {};
['1', '2'].forEach((cap) => {
  const r = runChains(NEW, N1, cap); res[cap] = r;
  r.bad.slice(0, 3).forEach((x) => console.log('  ✗ ' + JSON.stringify(x)));
  check('F1-' + cap, "開關 '" + cap + "'：隨機 " + N1 + " 串（開頁、掃描、LINE／舊連結上下班、今日出勤），每一步的判斷、回應、打卡列、屬性都跟舊版相同", [r.same, r.bad.length], [N1, 0]);
  show('F1-' + cap + 'c', '涵蓋：步數、有用班表補出時段的步數、整張超過 90000 字的串數', { ops: r.ops, filled: r.filled, big: r.bigN });
});
check('F1c', '涵蓋夠：兩個開關合計補出時段的步數 ≥ 300、超過 90000 字的串 ≥ 100', [res['1'].filled + res['2'].filled >= 300, res['1'].bigN + res['2'].bigN >= 100], [true, true]);
{
  // 反向對照：比對工具要抓得到差異（把「差 2 小時內」故意改成 1 小時）
  const broken = NEW.replace('var CAP_SCHED_TOL_MIN = 120;', 'var CAP_SCHED_TOL_MIN = 60;');
  if (broken === NEW) throw new Error('找不到 CAP_SCHED_TOL_MIN');
  seed = 777;
  const r = runChains(broken, 150, '1');
  check('F1x', '反向對照：故意改壞（容許差改 1 小時）的版本，150 串裡要抓到差異', r.bad.length > 0, true);
}

console.log('\n════ F2 整張 sched_pub 超過 90000 字：\'1\'／\'2\' 不再每次重讀整張 ════');
{
  const pubBig = [['', 'T01', one(SH, 'E01', { 19: { t: 'W', s: 'A' } })]].concat(Array.from({ length: 6 }, (_, k) => BIG(k)));
  const size = pubBig.reduce((s, p) => s + JSON.stringify(p[2]).length, 0), bytes = pubBig.reduce((s, p) => s + Buffer.byteLength(JSON.stringify(p[2]), 'utf8'), 0);
  const opt = (cap) => ({ cap, now: D + 'T18:00:00', ev: [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:30:00', 'E01', 'in']], pub: pubBig });
  const seq = (src, cap) => { const m = world(src, 'gf', opt(cap)); const out = []; for (let i = 0; i < 3; i++) { page(m); m.setNow(T(D + 'T18:0' + (i + 1) + ':00')); out.push(m.__reads); } return out; };
  check('F2a', '測試資料：整張 > 90000 字、含中文（位元組 > 字數）', [size > 90000, bytes > size], [true, true]);
  check('F2b★', "連續開頁三次（隔 1 分鐘）sched_pub 累計讀取：新版 '1'、'2' 都是 1、1、1；舊版 1、2、3（每次重讀整張）",
    [seq(NEW, '1'), seq(NEW, '2'), seq(OLD, '1'), seq(OLD, '2')], [[1, 1, 1], [1, 1, 1], [1, 2, 3], [1, 2, 3]]);
  // 定時掃描逐人呼叫 capCheck_：6 個人都在上班、都有一張孤單上班卡要補
  const ppl = Array.from({ length: 6 }, (_, i) => ({ emp_id: 'E0' + (i + 1), name: '測試' + i, key: 'K' + i, device_id: 'D' + i, active: 'TRUE', line_user_id: 'U' + (i + 1) }));
  const rows = ppl.map((p) => ({ emp_id: p.emp_id, name: p.name, cells: cellsOf({ 19: { t: 'W', s: 'A' } }) }));
  const pub6 = [['', 'T01', { start: '2026-11-01', shifts: SH, rows }]].concat(Array.from({ length: 6 }, (_, k) => BIG(k)));
  const ev6 = [].concat(...ppl.map((p) => [[D + 'T09:00:00', p.emp_id, 'in'], [D + 'T17:30:00', p.emp_id, 'in']]));
  const sweep = (src, cap) => {
    const m = world(src, 'gf', { cap, now: D + 'T18:30:00', ev: ev6, pub: pub6, roster: ppl });
    const c = m.sb.CacheService.getScriptCache(), calls = { get: 0, getAll: 0, chunks: 0 };
    m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, {
      get: (k) => { if (/^capgr1:/.test(k)) calls.get++; return c.get(k); },
      getAll: (ks) => { if (ks.some((k) => /^capgr1:/.test(k))) { calls.getAll++; calls.chunks += ks.length; } return c.getAll(ks); } }) };
    m.sb.capSweep(); const r1 = m.__reads, c1 = Object.assign({}, calls);
    m.setNow(T(D + 'T18:45:00')); m.sb.capSweep();
    return { reads: [r1, m.__reads - r1], cache1: c1 };
  };
  const sn = sweep(NEW, '1'), so = sweep(OLD, '1'), s2 = sweep(NEW, '2');
  check('F2c★', "定時掃描（6 人都要補）：新版第一輪讀整張 1 次、15 分後第二輪 1 次（快取 5 分鐘已過）；舊版每人各讀 1 次＝6、6",
    [sn.reads, s2.reads, so.reads], [[1, 1], [1, 1], [6, 6]]);
  show('F2d', "新版 '1' 一輪掃描讀快取的次數（目錄 get、資料塊 getAll、getAll 合計鍵數）", sn.cache1);
}

console.log('\n════ F3 讀別家店／本店那一塊（鍵對不對） ════');
{
  const pub = [['', 'T01', one(SH, 'E01', { 19: { t: 'W', s: 'A' } })], ['mzt', 'T01', one(SH, 'E01', { 19: { t: 'W', s: 'L' } })]];
  const f = (src, view) => { const m = world(src, view, { cap: '1', pub }); return [fillAt(m, 'in', D + 'T09:00:00'), m.__reads]; };
  check('F3a', '金山（sched_pub 在光復的試算表）補 09:00 上班卡：讀金山那塊 → 21:00；光復讀光復那塊 → 18:00；新舊相同、各讀 1 次',
    [f(NEW, 'mzt'), f(NEW, 'gf'), f(OLD, 'mzt'), f(OLD, 'gf')], [['21:00', 1], ['18:00', 1], ['21:00', 1], ['18:00', 1]]);
  const m = world(NEW, 'gf', { cap: '1', pub });
  const a = m.sb.capGraceSched_('', 'T01'), b = m.sb.capGraceSched_('mzt', 'T01'), c = m.sb.capGraceSched_('mzt', 'T09');
  check('F3b', 'capGraceSched_ 照店別取塊：光復那塊是 A 班、金山那塊是 L 班、沒發布的期回 null；三次只讀整張 1 次',
    [a.rows[0].cells[19].s, b.rows[0].cells[19].s, c, m.__reads], ['A', 'L', null, 1]);
  const mz = world(NEW, 'mzt', { cap: '1', pub, pev: [[D + 'T08:00:00', 'B07', 'in']] });
  check('F3c', "開關 '1' 別家店的卡照舊不補（null），而且不讀班表", [hmOf(mz.sb.capMakeFill_('E01')('in', { ms: T(D + 'T09:00:00'), store: 'gf' })), mz.__reads], [null, 0]);
}

console.log('\n════ F4 班表重新發布後多久跟上 ════');
{
  const pubA = one(SH, 'E01', { 19: { t: 'W', s: 'A' } }), pubL = one(SH, 'E01', { 19: { t: 'W', s: 'L' } });
  const run = (src, big) => {
    const m = world(src, 'gf', { cap: '1', now: D + 'T19:00:00', pub: [['', 'T01', pubA]].concat(big ? Array.from({ length: 6 }, (_, k) => BIG(k)) : []) });
    const out = [fillAt(m, 'in', D + 'T09:00:00')];
    m.__sp.values[1][3] = JSON.stringify(pubL);               // 19:01 重新發布（A → L）
    [['19:01:00'], ['19:04:59'], ['19:05:01']].forEach(([h]) => { m.setNow(T(D + 'T' + h)); out.push(fillAt(m, 'in', D + 'T09:00:00')); });
    return out;
  };
  check('F4a', '整張不到 90000 字：新舊一樣，19:00 讀進快取，19:01 重新發布後 19:04:59 仍是舊班（18:00），19:05:01 起新班（21:00）＝最慢 5 分鐘跟上',
    [run(NEW, false), run(OLD, false)], [['18:00', '18:00', '18:00', '21:00'], ['18:00', '18:00', '18:00', '21:00']]);
  check('F4b', '整張超過 90000 字：舊版不快取、重新發布立刻讀到；新版跟不到 90000 時一樣最慢 5 分鐘（＝寬限、跨店補時現在的新鮮度）',
    [run(NEW, true), run(OLD, true)], [['18:00', '18:00', '18:00', '21:00'], ['18:00', '21:00', '21:00', '21:00']]);
}

console.log('\n════ F5 手改 sched_pub 才會有的壞資料：大腦接受的五種差異（釘住新版行為） ════');
{
  const row = (map) => ({ emp_id: 'E01', name: '測試一', cells: cellsOf(map) });
  const A19 = { 19: { t: 'W', s: 'A' } };
  const cases = [
    ['F5-1', '分段班其中一段缺下班時間', [['', 'T01', { start: '2026-11-01', shifts: [{ id: 'S', start: '09:00', end: '20:00', segs: [{ start: '09:00', end: '13:00' }, { start: '16:00' }] }], rows: [row({ 19: { t: 'W', s: 'S' } })] }]], '13:00', null, '少補'],
    ['F5-2', '班別時間是數字（9、18）', [['', 'T01', { start: '2026-11-01', shifts: [{ id: 'A', start: 9, end: 18 }], rows: [row(A19)] }]], '18:00', null, '少補'],
    ['F5-3', '班別清單混了數字', [['', 'T01', { start: '2026-11-01', shifts: [5, { id: 'A', start: '09:00', end: '18:00' }], rows: [row(A19)] }]], '18:00', null, '少補'],
    ['F5-4', '班表列有 null', [['', 'T01', { start: '2026-11-01', shifts: SH, rows: [null, row(A19)] }]], null, '18:00', '多補'],
    ['F5-5', '同店同期兩列、後面那列 rows 不是陣列', [['', 'T01', one(SH, 'E01', A19)], ['', 'T01', { start: '2026-11-01', shifts: SH, rows: {} }]], null, '18:00', '多補'],
  ];
  cases.forEach(([id, desc, pub, oldV, newV, dir]) => {
    const got = [OLD, NEW].map((src) => fillAt(world(src, 'gf', { cap: '1', pub }), 'in', D + 'T09:00:00'));
    check(id, desc + '：09:00 孤單上班卡 → 舊版補到 ' + oldV + '、新版 ' + newV + '（' + dir + '）', got, [oldV, newV]);
  });
  // 多補會不會變成多代記：09:00、17:30 兩張上班卡，19:05 開頁
  const ev = [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:30:00', 'E01', 'in']];
  const e2e = (pub) => [OLD, NEW].map((src) => { const m = world(src, 'gf', { cap: '1', pub, ev }); const p = page(m); return [p, m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0).length]; });
  check('F5-4b', "班表列有 null，開關 '1' 19:05 開頁：舊版 1.5 小時不鎖、沒寫卡；新版 10 小時 19:00 收卡（多代記一張）",
    e2e(cases[3][2]), [['free', 0], ['LOCK19:00', 1]]);
  check('F5-5b', "同店同期兩列（後列壞），開關 '1' 19:05 開頁：舊版不鎖；新版用前列補 → 19:00 收卡",
    e2e(cases[4][2]), [['free', 0], ['LOCK19:00', 1]]);
  check('F5-0', '對照：同一情境的正常班表新舊都 19:00 收卡', e2e([['', 'T01', one(SH, 'E01', A19)]]), [['LOCK19:00', 1], ['LOCK19:00', 1]]);
}

done();
