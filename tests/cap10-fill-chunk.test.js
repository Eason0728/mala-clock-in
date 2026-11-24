/* 補缺卡改讀「店＋期」分塊快取（2026-11-25；Cap10.gs capMakeFill_ → capMakeFillAll_(…, true) → capGraceSched_；拿掉整表快取 capSchedPub_）
 *
 * 規則白話版（這次只換「班表從哪裡讀」，補法一個字沒改）：
 *   1. 開關 '1'／'2'（九店現在都是 '1'）算「當日出勤滿 10 小時」時，缺下班卡（或缺上班卡）的那張本店卡用本店已發布班表補：
 *      孤單上班卡找開始差 2 小時內的時段、用它的結束；孤單下班卡找結束差 2 小時內的、用它的開始；凌晨 06:00 以前的下班卡算前一天。別家店的卡不補。
 *   2. 原本班表整張 sched_pub 一個快取鍵（capsched:v1），整張超過 90000 字就不快取 → 每次要補都重讀整張；
 *      改成跟班表寬限（#232）、跨店補時（#234）同一份「店＋期」分塊快取（capgr1:），5 分鐘。
 *   3. 正常資料（正式發布流程 SchedPub.gs 寫出來的）補出來的時間、收卡結果逐筆相同；只有手改 sched_pub 分頁造出的壞資料不同：已知 6 類（4 類少補、2 類多補；F5，大腦已接受）。
 * 手算：
 *   F3 金山（mzt）本人 E01：光復那列排 A 09–18、金山那列排 L 09–21；09:00 上班沒下班 → 金山補到 21:00（讀金山那塊），不是 18:00。
 *   F5-5x 班表列有 null：09:00、17:30 兩張上班卡、班表 A 09–18，19:05 開頁：舊版整期讀列丟錯 → 09:00 那張孤單、只算 17:30–19:00＝1.5 小時、不鎖；
 *        新版跳過 null 列 → 09:00–17:30＝8.5 ＋ 1.5＝10 → 19:00 收卡、鎖。
 * 舊版＝git show ${CAP_FILL_BASE:-0bf30bd}:apps-script/Cap10.gs（這次改之前的主線）。 */
'use strict';
const path = require('path'), { execFileSync } = require('child_process');
const { make, T, at, check, show, done, R } = require('./helpers/gs-sandbox');

const BASE = process.env.CAP_FILL_BASE || '0bf30bd';
const single = (s) => { const o = s.replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;'); if (o === s) throw new Error('找不到 CAP_SINGLE_STORES'); return o; };   // 沙盒兩家店：'2' 寬限才會真的生效
// CAP_FILL_NEW＝git 版本：拿那一版當「新版」跑（例 CAP_FILL_NEW=ad022fc 重現 #238 審查第 1 輪擋項，F6 要紅）
const NEW = single(process.env.CAP_FILL_NEW ? execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', process.env.CAP_FILL_NEW + ':apps-script/Cap10.gs'], { encoding: 'utf8' }) : R('apps-script/Cap10.gs'));
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
/** 依鍵前綴數讀快取次數：{capgr1:{get,getAll,keys}, capfl1:…, capsched:…} */
function countCache(m) {
  const c = m.sb.CacheService.getScriptCache(), calls = {};
  ['capgr1', 'capfl1', 'capsched'].forEach((p) => { calls[p] = { get: 0, getAll: 0, keys: 0 }; });
  const pre = (k) => String(k).split(':')[0];
  m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, {
    get: (k) => { if (calls[pre(k)]) calls[pre(k)].get++; return c.get(k); },
    getAll: (ks) => { const p0 = ks.length ? pre(ks[0]) : ''; if (calls[p0]) { calls[p0].getAll++; calls[p0].keys += ks.length; } return c.getAll(ks); } }) };
  return calls;
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
  const dawn = (segs.segs || []).filter((x) => x.filled && /^05:/.test(hmOf(x.out))).length;   // 清晨 05:00–05:59 的下班卡補出來的段（06:00 前算前一天）
  return { r, filled: (segs.segs || []).filter((x) => x.filled).length, dawn };
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
  const shifts = SH.concat([{ id: 'X', name: '隨機', start: hm(rs), end: hm((rs + len) % 1440) }, { id: 'M', name: '大夜', start: '20:00', end: '05:30' }]);
  const cell = () => { const r = rnd(); if (r < 0.15) return { t: 'R' }; if (r < 0.2) return { t: 'H', s: pk(['A', 'L']) }; if (r < 0.25) return { t: 'W', s: 'Q' }; return { t: 'W', s: pk(['A', 'N', 'S', 'L', 'X', 'M']) }; };
  const pub = [];
  const dawnOut = rnd() < 0.35;                                // 清晨 05:00–06:00 的孤單下班卡（06:00 前算前一天，前一天排大夜 20:00–05:30 才補得到）
  const mine = {}; mine[idx] = cell();
  const prev = {}; prev[prevIdx] = dawnOut && rnd() < 0.7 ? { t: 'W', s: 'M' } : cell();
  if (per === prevPer) { Object.assign(mine, prev); if (rnd() > 0.1) pub.push([alias, per, one(shifts, 'E01', mine)]); }
  else { if (rnd() > 0.1) pub.push([alias, per, one(shifts, 'E01', mine)]); if (rnd() > 0.1) pub.push([alias, prevPer, one(shifts, 'E01', prev)]); }
  const o2 = {}; o2[idx] = { t: 'W', s: 'L' };
  const oth = one(SH, 'E01', o2);                              // 另一家店同工號排別的班（鍵對錯就會補錯）
  oth.rows.push({ emp_id: 'B07', name: '測試一', cells: cellsOf(Object.fromEntries([[idx, { t: 'W', s: 'A' }]])) });   // 另一家店也排了本人（B07）：跨店補時開著就補得到那張卡；'1'／'2' 照舊不補
  pub.push([other, per, oth]);
  if (rnd() < 0.25) for (let k = 0; k < 6; k++) pub.push(BIG(k));   // 整張超過 90000 字：舊版每次重讀整張
  const ev = [], base = T(day + 'T00:00:00');
  let t = base - 18 * 3600000 + ri(0, 20) * 900000;
  for (let i = 0, n = ri(1, 4); i < n; i++) { ev.push([iso(t), 'E01', pk(['in', 'in', 'out'])]); t += ri(1, 40) * 900000; }
  if (dawnOut) { ev.push([iso(base + ri(301, 359) * 60000), 'E01', 'out']); ev.sort((a, b) => T(a[0]) - T(b[0])); t = Math.max(t, base + 360 * 60000); }
  const pev = rnd() < 0.3 ? [[iso(base + 9 * 3600000 + ri(-4, 4) * 900000), 'B07', 'in']] : [];   // 07:00–11:00 在另一家店上班（那家店班表 A 09–18）
  let now = Math.max(t, base + ri(56, 84) * 900000);
  const steps = [];
  for (let i = 0, n = ri(3, 6); i < n; i++) { steps.push([now, pk(OPS)]); now += ri(1, 40) * 60000; }
  return { view, opt: { cap, ev: ev.filter((e) => T(e[0]) <= steps[0][0]), pev, pub, now: iso(steps[0][0]) }, steps, big: pub.length > 6, peerCode: view === 'gf' ? 'mzt' : 'gf' };
}
function runChains(srcNew, n, cap) {
  let same = 0, filled = 0, bigN = 0, ops = 0, dawn = 0, peerOk = 0; const bad = [];
  for (let k = 0; k < n; k++) {
    const c = genChain(cap), N = world(srcNew, c.view, c.opt), O = world(OLD, c.view, c.opt);
    if (c.big) bigN++;
    if (c.opt.pev.length) {   // 前提確認（另開一份，不碰 N／O 的快取）：跨店補時版（帶姓名）補得到別家店那張卡＝「別家店補卡會成功」的情境真的有出現
      const P = world(srcNew, c.view, c.opt);
      if (P.sb.capMakeFillAll_(meRow(P))('in', { ms: T(c.opt.pev[0][0]), store: c.peerCode })) peerOk++;
    }
    let diff = null;
    for (const [t, o] of c.steps) {
      N.setNow(t); O.setNow(t); ops++;
      const jn = judge(N), jo = judge(O);
      filled += jn.filled ? 1 : 0; dawn += jn.dawn ? 1 : 0;
      const rn = JSON.stringify(op(N, o)), ro = JSON.stringify(op(O, o));
      if (JSON.stringify(jn) !== JSON.stringify(jo)) diff = 'judge ' + JSON.stringify(jn.r) + ' vs ' + JSON.stringify(jo.r);
      else if (rn !== ro) diff = o + ' 回應 ' + rn + ' vs ' + ro;
      else if (JSON.stringify(N.self.sh.events.values) !== JSON.stringify(O.self.sh.events.values)) diff = o + ' 打卡列不同';
      else if (JSON.stringify(N.props) !== JSON.stringify(O.props)) diff = o + ' 屬性不同';
      if (diff) { bad.push([k, c.view, diff.slice(0, 300)]); break; }
    }
    if (!diff) same++;
  }
  return { same, bad, filled, bigN, ops, dawn, peerOk };
}
const N1 = 300;
const res = {};
['1', '2'].forEach((cap) => {
  const r = runChains(NEW, N1, cap); res[cap] = r;
  r.bad.slice(0, 3).forEach((x) => console.log('  ✗ ' + JSON.stringify(x)));
  check('F1-' + cap, "開關 '" + cap + "'：隨機 " + N1 + " 串（開頁、掃描、LINE／舊連結上下班、今日出勤），每一步的判斷、回應、打卡列、屬性都跟舊版相同", [r.same, r.bad.length], [N1, 0]);
  show('F1-' + cap + 'c', '涵蓋：步數、有用班表補出時段的步數、清晨 05 點多下班卡補出的步數、整張超過 90000 字的串數、別家店那張卡跨店補時版補得到的串數', { ops: r.ops, filled: r.filled, dawn: r.dawn, big: r.bigN, peerOk: r.peerOk });
});
const sum = (k) => res['1'][k] + res['2'][k];
check('F1c', '涵蓋夠：補出時段的步數 ≥ 300、清晨 05 點多下班卡補出 ≥ 50 步、超過 90000 字的串 ≥ 100、別家店補卡會成功的串 ≥ 50（兩個開關合計）',
  [sum('filled') >= 300, sum('dawn') >= 50, sum('bigN') >= 100, sum('peerOk') >= 50], [true, true, true, true]);
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
    const calls = countCache(m);
    m.sb.capSweep(); const r1 = m.__reads, c1 = JSON.parse(JSON.stringify(calls));
    m.setNow(T(D + 'T18:45:00')); m.sb.capSweep();
    return { reads: [r1, m.__reads - r1], cache1: c1 };
  };
  const sn = sweep(NEW, '1'), so = sweep(OLD, '1'), s2 = sweep(NEW, '2');
  check('F2c★', "定時掃描（6 人都要補）：新版第一輪讀整張 1 次、15 分後第二輪 1 次（快取 5 分鐘已過）；舊版每人各讀 1 次＝6、6",
    [sn.reads, s2.reads, so.reads], [[1, 1], [1, 1], [6, 6]]);
  check('F2d', "一輪掃描（6 人各一張孤單卡）讀快取：新版補缺卡命名空間 capfl1: 目錄 get 6、資料塊 getAll 5（第一人讀表）；舊版整表 capsched:v1 get 6",
    [sn.cache1.capfl1, so.cache1.capsched], [{ get: 6, getAll: 5, keys: 5 }, { get: 6, getAll: 0, keys: 0 }]);
  // 一人多張孤單卡：同一個補缺卡函式內同一店＋期只讀一次快取（同原本 pub 只讀一次）
  const multi = (src) => {
    const m = world(src, 'gf', { cap: '1', now: D + 'T17:00:00', pub: [['', 'T01', one(SH, 'E01', { 18: { t: 'W', s: 'N' }, 19: { t: 'W', s: 'S' } })]],
      ev: [['2026-11-19T18:00:00', 'E01', 'in'], [D + 'T09:00:00', 'E01', 'in'], [D + 'T12:00:00', 'E01', 'in'], [D + 'T13:00:00', 'E01', 'out'], [D + 'T15:00:00', 'E01', 'out'], [D + 'T16:00:00', 'E01', 'in']] });
    let fills = 0; const f0 = m.sb.capMakeFill_;
    const sb = m.sb, ss = sb.getSS(), me = meRow(m), now = sb.__now, ev = sb.capEventsFor_(ss, me, now, null);
    const fn = f0('E01'), wrapped = (k, e) => { fills++; return fn(k, e); };
    sb.capJudge_(ev, now, wrapped, sb.capBreak_(), sb.capLeavesFor_(ss, me, now));   // 暖快取
    const calls = countCache(m); fills = 0;
    const fn2 = f0('E01'), w2 = (k, e) => { fills++; return fn2(k, e); };
    sb.capJudge_(ev, now, w2, sb.capBreak_(), sb.capLeavesFor_(ss, me, now));
    return { fills, capfl1: calls.capfl1, capsched: calls.capsched };
  };
  const mn = multi(NEW), mo = multi(OLD);
  show('F2e', '一人多張孤單卡、快取已暖：一次判斷叫補缺卡幾次、新版 capfl1: 讀快取次數、舊版 capsched:v1 讀快取次數', { new: mn, old: mo });
  check('F2f', '一人多張孤單卡（同一期）：新版一次判斷讀快取 2 次（目錄 1、資料塊 1）、舊版 1 次，不隨孤單卡張數增加',
    [mn.fills >= 2, mn.capfl1.get + mn.capfl1.getAll, mo.capsched.get], [true, 2, 1]);
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

{
  // F4c（#238 審查第 1 輪擋項的函式層版本）：寬限先把 capgr1: 暖起來（讀到舊班），重新發布後補缺卡第一次讀 → 要讀到新班（跟舊版一樣）
  const pubA = one(SH, 'E01', { 19: { t: 'W', s: 'A' } }), pubL = one(SH, 'E01', { 19: { t: 'W', s: 'L' } });
  const run = (src) => {
    const m = world(src, 'gf', { cap: '2', now: D + 'T19:00:00', pub: [['', 'T01', pubA]] });
    m.sb.capGraceSched_('', 'T01');                           // 寬限（別人開頁／掃描）暖了 capgr1:
    m.__sp.values[1][3] = JSON.stringify(pubL);               // 19:01 重新發布（A → L）
    m.setNow(T(D + 'T19:02:00'));
    return [fillAt(m, 'in', D + 'T09:00:00'), m.sb.capGraceSched_('', 'T01').rows[0].cells[19].s];
  };
  check('F4c★', '寬限先暖了快取、之後重新發布：補缺卡第一次讀到新班（21:00），跟舊版一樣；寬限自己那份照舊 5 分鐘內仍是舊班（A）',
    [run(NEW), run(OLD)], [['21:00', 'A'], ['21:00', 'A']]);
}

console.log('\n════ F6 快取由誰、何時暖起（#238 審查第 1 輪擋項）：新版不可比舊版更常讀到舊班表 ════');
const SP = R('apps-script/SchedPub.gs');
const ME2 = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
/** 經正式發布流程（handleSchedPublish_）發布光復 T01：甲（E01）當天班別 sid、乙（E02）排 A */
function publish(m, sid, seq) {
  const cells = (s0) => Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: s0 } : { t: 'R' }));
  const shifts = [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'P', name: '午', start: '14:00', end: '20:00' }, { id: 'Q', name: '晚', start: '18:00', end: '20:00' }];
  const r = m.sb.handleSchedPublish_({ svcKey: 'SVC', v: 1, store: '', period: 'T01', seq, op_id: 'op' + seq, start: '2026-11-01', days: 28, shifts,
    rows: [{ emp_id: 'E01', name: '測試一', cells: cells(sid) }, { emp_id: 'E02', name: '測試二', cells: cells('A') }] });
  if (!r.ok) throw new Error('發布失敗 ' + JSON.stringify(r));
}
function pubWorld(src, cap, ev, now) {
  const m = world(src, 'gf', { cap, now, ev, roster: [ME, ME2] });
  m.props.SCHED_SVC_KEY = 'SVC'; m.run(SP);
  return m;
}
{
  // 審查重現：整張不到 90000 字、'2'。甲 09:00 上班、14:00 下班、20:00 下班（缺上班卡）；乙 08:00 上班還在上班（20:15 已滿 10）
  const ev = [[D + 'T08:00:00', 'E02', 'in'], [D + 'T09:00:00', 'E01', 'in'], [D + 'T14:00:00', 'E01', 'out'], [D + 'T20:00:00', 'E01', 'out']];
  const run = (src, cap) => {
    const m = pubWorld(src, cap, ev, D + 'T19:30:00');
    publish(m, 'P', 1);                                        // 甲 14:00–20:00
    m.setNow(T(D + 'T20:15:00')); m.sb.capSweep();             // 掃描處理乙（寬限暖起 capgr1:）；甲最後一張是下班卡、這輪不檢查甲
    m.setNow(T(D + 'T20:16:00')); publish(m, 'Q', 2);          // 甲改成 18:00–20:00
    m.setNow(T(D + 'T20:17:00'));
    const before = m.self.sh.events.values.length;
    const r = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'in', confirm_same: true }, HERE));
    const added = m.self.sh.events.values.slice(before).map((x) => [String(x[0]).slice(11, 16), x[1], x[2]]);
    return { ok: r.ok === true, status: r.status || null, added, rows: m.self.sh.events.values.length - 1 };
  };
  const on = run(NEW, '2'), oo = run(OLD, '2'), n1 = run(NEW, '1'), o1 = run(OLD, '1');
  // #238 審查第 2 輪：明確斷言甲 20:17 的上班卡兩版都收下、只寫 1 列（甲的上班卡）、整張打卡列數一樣
  const want = (x) => [x.ok, x.status, JSON.stringify(x.added)];
  check('F6a★', "掃描只暖寬限 → 正式重新發布 → 甲 20:17 按 LINE 上班：新舊兩版、'1'／'2' 都回 ok（不是 cap_locked）、這次只寫甲 20:17 上班 1 列、整張列數相同",
    [want(on), want(oo), want(n1), want(o1), on.rows === oo.rows && n1.rows === o1.rows],
    [[true, null, '[["20:17","E01","in"]]'], [true, null, '[["20:17","E01","in"]]'], [true, null, '[["20:17","E01","in"]]'], [true, null, '[["20:17","E01","in"]]'], true]);
  show('F6a-v', '回應摘要（新／舊，\'2\'）', { new: on, old: oo });
}
/** 隨機時序：兩位同仁、開頁／掃描／按卡／今日出勤／正式重新發布任意交錯。
 *  big＝另放 6 期大班表讓整張超過 90000 字（舊版補缺卡不快取＝每次讀最新）。
 *  每一步只比回應與打卡列（不在中途另外叫補缺卡：那本身會把快取暖起來、把時序抹平）；沒有差異時最後再比一次甲的判斷。
 *  有差異時（只在 big 允許）要同時符合「已接受的那一種」：①新版補缺卡命名空間最後一次載入早於最近一次重新發布、而且還沒過 5 分鐘（新版讀的是舊快取）；
 *  ②同一步「新版但補缺卡快取永遠讀不到（＝每次讀最新）」那一份跟舊版完全一樣（差異只來自補缺卡快取）。符合就記為已接受、這串到此為止；不符合就算錯。
 *  （②只在 big 比：整張不到 90000 字時舊版本來就快取 5 分鐘，「每次讀最新」不是舊版的行為。） */
function runF6(nb, big, seed0) {
  let sd = seed0; const r0 = () => { sd = (sd * 1103515245 + 12345) % 2147483648; return sd / 2147483648; };
  const pick = (xs) => xs[Math.floor(r0() * xs.length)];
  const OPS6 = ['sweep', 'st1', 'st2', 'pub', 'pub', 'in1', 'out1', 'today1', 'in2'];
  let same = 0, pubs = 0, accepted = 0; const bad = [];
  const mk = (src, cap, ev) => { const m = pubWorld(src, cap, ev, D + 'T19:30:00'); if (big) for (let k = 0; k < 6; k++) { const b = BIG(k); m.__sp.appendRow([b[0], b[1], 1, JSON.stringify(b[2]), 'op', '']); } return m; };
  for (let k = 0; k < nb; k++) {
    const cap = pick(['1', '2']);
    const ev = [[D + 'T08:00:00', 'E02', 'in'], [D + 'T09:00:00', 'E01', 'in']].concat(r0() < 0.5 ? [[D + 'T14:00:00', 'E01', 'out']] : []).concat(r0() < 0.6 ? [[D + 'T' + pick(['18', '19', '20']) + ':00:00', 'E01', 'out']] : []);
    const N = mk(NEW, cap, ev), O = mk(OLD, cap, ev), F = mk(NEW, cap, ev);
    // F：補缺卡命名空間永遠讀不到（每次讀最新）；N：記下補缺卡命名空間最後一次載入的時間
    { const c = F.sb.CacheService.getScriptCache(); F.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { get: (x) => (/^capfl1:/.test(x) ? null : c.get(x)), getAll: (ks) => (ks.some((x) => /^capfl1:/.test(x)) ? {} : c.getAll(ks)) }) }; }
    { const c = N.sb.CacheService.getScriptCache(); N.__fillAt = -Infinity; N.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { putAll: (o, t) => { if (Object.keys(o).some((x) => /^capfl1:/.test(x))) N.__fillAt = N.sb.__now; return c.putAll(o, t); } }) }; }
    let seq = 1, t = T(D + 'T19:30:00'), diff = null, lastPub = -Infinity; const s0 = pick(['A', 'P', 'Q']); [N, O, F].forEach((m) => publish(m, s0, seq));
    const steps = [];
    for (let i = 0, n = 4 + Math.floor(r0() * 6); i < n && !diff; i++) {
      t += (1 + Math.floor(r0() * 4)) * 60000; [N, O, F].forEach((m) => m.setNow(t));
      const o = pick(OPS6); steps.push(o);
      const doOp = (m) => {
        const sb = m.sb;
        if (o === 'sweep') { sb.capSweep(); return null; }
        if (o === 'st1' || o === 'st2') return sb.handleLiffStatus_({ id_token: o === 'st1' ? 'TOK_U1' : 'TOK_U2' });
        if (o === 'pub') return null;
        if (o === 'today1') { return sb.capOn_() ? sb.capTodayMs_(sb.getSS(), meRow(m), sb.__now) : 'off'; }
        return sb.handleLiffPunch_(Object.assign({ id_token: o === 'in2' ? 'TOK_U2' : 'TOK_U1', type: o === 'out1' ? 'out' : 'in', confirm_same: true }, HERE));
      };
      if (o === 'pub') { seq++; pubs++; lastPub = t; const sid = pick(['A', 'P', 'Q']); [N, O, F].forEach((m) => publish(m, sid, seq)); }
      const stale = N.__fillAt < lastPub && t - N.__fillAt < CAP_TTL_MS;   // 這一步之前：新版補缺卡快取是重新發布前載入、還沒到期
      const rn = JSON.stringify(doOp(N)), ro = JSON.stringify(doOp(O)), rf = JSON.stringify(doOp(F));
      const evN = JSON.stringify(N.self.sh.events.values), evO = JSON.stringify(O.self.sh.events.values), evF = JSON.stringify(F.self.sh.events.values);
      if (big && (rf !== ro || evF !== evO)) { diff = o + ' 每次讀最新的新版跟舊版不同 ' + rf.slice(0, 120) + ' vs ' + ro.slice(0, 120); break; }
      if (rn !== ro || evN !== evO) {
        if (big && stale) { accepted++; diff = 'accepted'; break; }
        diff = o + (big ? '（不是已接受的那一種）' : '') + ' 回應 ' + rn.slice(0, 140) + ' vs ' + ro.slice(0, 140);
      }
    }
    if (!diff) { const jn = JSON.stringify(judge(N)), jo = JSON.stringify(judge(O)), jf = JSON.stringify(judge(F));
      if (big && jf !== jo) diff = '最後判斷（每次讀最新）不同 ' + jf.slice(0, 120) + ' vs ' + jo.slice(0, 120);
      else if (jn !== jo) diff = (big && N.__fillAt < lastPub && N.sb.__now - N.__fillAt < CAP_TTL_MS) ? 'accepted' : '最後判斷 ' + jn.slice(0, 120) + ' vs ' + jo.slice(0, 120);
      if (diff === 'accepted') accepted++; }
    if (diff && diff !== 'accepted') bad.push([k, cap, steps.join(','), diff]); else if (!diff) same++;
  }
  return { same, accepted, bad, pubs };
}
const CAP_TTL_MS = 300 * 1000;
{
  const r = runF6(400, false, 4242);
  r.bad.slice(0, 3).forEach((x) => console.log('  ✗ ' + JSON.stringify(x)));
  check('F6b★', '隨機時序 400 串（整張不到 90000 字；開頁、掃描、按卡、今日出勤、正式重新發布任意交錯；\'1\'／\'2\'）：每一步回應、打卡列與最後甲的判斷新舊都一樣（CAP_FILL_NEW=ad022fc 時要抓到差異）', [r.same, r.bad.length], [400, 0]);
  show('F6b-c', '涵蓋：重新發布次數', r.pubs);
}
{
  const r = runF6(150, true, 9090);
  r.bad.slice(0, 3).forEach((x) => console.log('  ✗ ' + JSON.stringify(x)));
  check('F6c★', '隨機時序 150 串（整張超過 90000 字）：新舊差異只准是已接受的那一種（新版補缺卡快取在重新發布前載入、未滿 5 分鐘；同一步「每次讀最新」的新版＝舊版），其他任何差異 0',
    [r.bad.length, r.same + r.accepted], [0, 150]);
  check('F6c-c', '涵蓋：已接受那一種真的出現過（≥ 1 串）、其餘串新舊完全相同', r.accepted >= 1, true);
  show('F6c-n', '完全相同／已接受的差異／重新發布次數', { same: r.same, accepted: r.accepted, pubs: r.pubs });
}

console.log('\n════ F5 手改 sched_pub 才會有的壞資料：大腦接受的已知差異共 6 類（4 類少補、2 類多補；釘住新版行為） ════');
{
  const row = (map) => ({ emp_id: 'E01', name: '測試一', cells: cellsOf(map) });
  const A19 = { 19: { t: 'W', s: 'A' } }, S19 = { 19: { t: 'W', s: 'S' } };
  const P = (shifts, rows) => ({ start: '2026-11-01', shifts, rows });
  const good = ['', 'T01', one(SH, 'E01', A19)];
  const cases = [
    // 第 1 類（少補）分段班其中一段缺欄
    ['F5-1', '第 1 類：分段班其中一段缺下班時間', [['', 'T01', P([{ id: 'S', start: '09:00', end: '20:00', segs: [{ start: '09:00', end: '13:00' }, { start: '16:00' }] }], [row(S19)])]], '13:00', null],
    // 第 2 類（少補）時間或代號型別不對
    ['F5-2a', '第 2 類：班別時間是數字（9、18）', [['', 'T01', P([{ id: 'A', start: 9, end: 18 }], [row(A19)])]], '18:00', null],
    ['F5-2b', '第 2 類：分段的開始／結束是數字', [['', 'T01', P([{ id: 'S', start: '09:00', end: '20:00', segs: [{ start: 9, end: 13 }, { start: 16, end: 20 }] }], [row(S19)])]], '13:00', null],
    ['F5-2c', '第 2 類：分段班的班別開始／結束是數字（分段是字串）', [['', 'T01', P([{ id: 'S', start: 9, end: 20, segs: [{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }] }], [row(S19)])]], '13:00', null],
    ['F5-2d', '第 2 類：班別代號是布林（格子 s 也是 true）', [['', 'T01', P([{ id: true, start: '09:00', end: '18:00' }], [row({ 19: { t: 'W', s: true } })])]], '18:00', null],
    // 第 3 類（少補）班別清單混了非物件
    ['F5-3', '第 3 類：班別清單混了數字', [['', 'T01', P([5, { id: 'A', start: '09:00', end: '18:00' }], [row(A19)])]], '18:00', null],
    // 第 4 類（少補）列的 cells 是物件不是陣列
    ['F5-4', '第 4 類：列的 cells 是物件（{"19":{…}}）不是陣列', [['', 'T01', P(SH, [{ emp_id: 'E01', name: '測試一', cells: { 19: { t: 'W', s: 'A' } } }])]], '18:00', null],
    // 第 5 類（多補）班表列有 null
    ['F5-5', '第 5 類：班表列有 null', [['', 'T01', P(SH, [null, row(A19)])]], null, '18:00'],
    // 第 6 類（多補）同店同期兩列、後列新版讀不出來 → 新版改用前列
    ['F5-6a', '第 6 類：同店同期兩列、後列 rows 不是陣列（{}）', [good, ['', 'T01', P(SH, {})]], null, '18:00'],
    ['F5-6b', '第 6 類：同店同期兩列、後列整格是 null', [good, ['', 'T01', 'null']], null, '18:00'],
    ['F5-6c', '第 6 類：同店同期兩列、後列整格是 []', [good, ['', 'T01', '[]']], null, '18:00'],
    ['F5-6d', '第 6 類：同店同期兩列、後列整格是字串 "x"', [good, ['', 'T01', '"x"']], null, '18:00'],
    ['F5-6e', '第 6 類：同店同期兩列、後列整格是 {}（沒有 rows）', [good, ['', 'T01', '{}']], null, '18:00'],
    ['F5-6f', '第 6 類：同店同期兩列、後列班別清單有 null', [good, ['', 'T01', P([null, SH[3]], [row({ 19: { t: 'W', s: 'L' } })])]], null, '18:00'],
    ['F5-6g', '第 6 類：同店同期兩列、後列班別清單混數字（舊版照後列的 L 班補、新版改用前列的 A 班）', [good, ['', 'T01', P([5, SH[3]], [row({ 19: { t: 'W', s: 'L' } })])]], '21:00', '18:00'],
  ];
  cases.forEach(([id, desc, pub, oldV, newV]) => {
    const got = [OLD, NEW].map((src) => fillAt(world(src, 'gf', { cap: '1', pub }), 'in', D + 'T09:00:00'));
    check(id, desc + '：09:00 孤單上班卡 → 舊版 ' + oldV + '、新版 ' + newV, got, [oldV, newV]);
  });
  // 多補會不會變成多代記：09:00、17:30 兩張上班卡，19:05 開頁
  const ev = [[D + 'T09:00:00', 'E01', 'in'], [D + 'T17:30:00', 'E01', 'in']];
  const e2e = (pub) => [OLD, NEW].map((src) => { const m = world(src, 'gf', { cap: '1', pub, ev }); const p = page(m); return [p, m.self.sh.events.values.filter((r) => r.indexOf('system_cap') >= 0).length]; });
  const pubOf = (id) => cases.filter((c) => c[0] === id)[0][2];
  check('F5-5x', "第 5 類（班表列有 null），開關 '1' 19:05 開頁：舊版 1.5 小時不鎖、沒寫卡；新版 10 小時 19:00 收卡（多代記一張）", e2e(pubOf('F5-5')), [['free', 0], ['LOCK19:00', 1]]);
  check('F5-6x', "第 6 類（同店同期兩列、後列 rows 不是陣列），開關 '1' 19:05 開頁：舊版不鎖；新版用前列補 → 19:00 收卡", e2e(pubOf('F5-6a')), [['free', 0], ['LOCK19:00', 1]]);
  check('F5-0', '對照：同一情境的正常班表新舊都 19:00 收卡', e2e([good]), [['LOCK19:00', 1], ['LOCK19:00', 1]]);
}

done();
