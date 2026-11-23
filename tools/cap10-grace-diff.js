#!/usr/bin/env node
/* 班表寬限（2026-11-24）逐位元組比對：同一批輸入餵 38d0340 的 Cap10.gs（舊）與工作區的 Cap10.gs（新），
 * 依序跑「即時狀態（開頁）、掃描、LINE 按上班／下班、舊 liff_clock 上班／下班、舊連結 clock 上班／下班」，
 * 每一步的回應＋每一步之後的 events 整張表＋指令碼屬性都要一樣。
 *   第一輪：兩邊 REST_CAP_ON='1'（寬限關著）→ 一定全部一樣。
 *   第二輪：舊 '1'、新 '2'（寬限開著）→ 第一個不一樣的那一步，必須是「有班表、滿 10 那一刻晚於班表下班超過 30 分、本店這段、
 *           而且那一步是開頁／掃描／按上班」（之後兩邊的表已經不同，不再比）；其他任何差異都算錯。
 *   第四輪（2026-11-23）：兩家店同步隨機＋名冊／打卡列隨機丟例外（判準見第四輪說明）。
 * 用法：node tools/cap10-grace-diff.js [--old <舊 Cap10.gs 路徑>] [--new <新 Cap10.gs 路徑>] [--n 400] [--long 1000] [--n4 600] [--seed 20261124]
 *   沒給 --old 就用 git show 38d0340:apps-script/Cap10.gs。只用假資料（gs-sandbox），不連網路、不讀金鑰。 */
'use strict';
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const { make, T, at, R } = require('../tests/helpers/gs-sandbox');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OLD = arg('--old') ? fs.readFileSync(arg('--old'), 'utf8')
  : execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', '38d0340:apps-script/Cap10.gs'], { encoding: 'utf8' });
const NEW = arg('--new') ? fs.readFileSync(arg('--new'), 'utf8') : R('apps-script/Cap10.gs');   // --new：反向對照用（故意改壞的版本要被抓到）
const N = +arg('--n', 400), NL = +arg('--long', 1000);
let seed = +arg('--seed', 20261124);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-20', BASE = T(D + 'T00:00:00');
const HERE = Object.assign({ accuracy: 10 }, at(3));
const CF = { NO_PUNCH_BREAK_START: '12:00', NO_PUNCH_BREAK_END: '13:00' }, HQ = { NO_PUNCH_BREAK_START: '14:00', NO_PUNCH_BREAK_END: '15:00' };
const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at'];
const hm = (min) => ('0' + Math.floor((min % 1440) / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
const iso = (ms) => { const x = new Date(ms + 8 * 3600000); return x.toISOString().slice(0, 19) + '+08:00'; };

function genSched() {
  const r = rnd();
  if (r < 0.12) return { kind: 'none' };
  const cells = (cell) => ({ start: '2026-11-01', rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? cell : { t: 'R' })) }] });
  if (r < 0.22) return { kind: 'nonwork', data: Object.assign(cells(pick([{ t: 'R' }, { t: 'H', s: 'A' }, { t: 'L', l: '特' }, { t: 'L', l: '國' }, { t: '' }])), { shifts: [{ id: 'A', name: 'x', start: '09:00', end: '18:00' }] }) };
  const st = ri(24, 64) * 15;                       // 06:00–16:00
  let shift;
  if (rnd() < 0.55) shift = { id: 'A', name: '一段', start: hm(st), end: hm(st + ri(28, 44) * 15) };   // 7–11 小時，可能跨午夜
  else { const a = ri(12, 20) * 15, g = ri(4, 24) * 15, b = ri(12, 24) * 15;
    shift = { id: 'A', name: '兩段', start: hm(st), end: hm(st + a + g + b), segs: [{ start: hm(st), end: hm(st + a) }, { start: hm(st + a + g), end: hm(st + a + g + b) }] }; }
  return { kind: 'work', st, data: Object.assign(cells({ t: 'W', s: 'A' }), { shifts: [shift] }) };
}
/** 一般：最多 3 段、最後一段可能沒下班；長工時：最後一段一定開著、從早上上到很晚 */
function genEvents(long, sc) {
  const out = [];
  let t = BASE + (sc.st !== undefined && rnd() < 0.7 ? sc.st + ri(-40, 40) : ri(300, 900)) * 60000 + ri(0, 59) * 1000;
  const segs = long ? ri(1, 2) : ri(1, 3);
  for (let i = 0; i < segs; i++) {
    out.push([iso(t), 'in']);
    const last = i === segs - 1;
    if (last && (long || rnd() < 0.6)) break;
    t += ri(60, long ? 360 : 300) * 60000 + ri(0, 59) * 1000;
    out.push([iso(t), 'out']);
    t += ri(15, 240) * 60000 + ri(0, 59) * 1000;
  }
  return out;
}
const OPS = ['status', 'sweep', 'punch_in', 'punch_out', 'lclock_in', 'lclock_out', 'old_in', 'old_out'];
function genScenario(long) {
  const sc = genSched();
  const evs = genEvents(long, sc);
  const cfg = rnd() < 0.7 ? null : pick([CF, HQ]);
  const leave = rnd() < 0.12 ? (() => { const s = ri(20, 64) * 15; return [D, hm(s), hm(s + ri(4, 12) * 15)]; })() : null;
  const lastIn = Date.parse(evs.filter((e) => e[1] === 'in').slice(-1)[0][0]);
  let now = long ? lastIn + ri(8 * 60, 15 * 60) * 60000 : Date.parse(evs[evs.length - 1][0]) + ri(5, 600) * 60000;
  const ops = [];
  const k = ri(2, 6);
  for (let i = 0; i < k; i++) { ops.push([now, pick(OPS)]); now += ri(1, 150) * 60000 + ri(0, 59) * 1000; }
  return { sc, evs, cfg, leave, ops };
}

function world(src, s, cap) {
  const m = make({ now: s.ops[0][0], props: { REQ_BIND_FROM: 'off', REST_CAP_ON: cap }, self: { roster: [ME], events: s.evs.map((e) => [e[0], 'E01', e[1]]) }, config: s.cfg || undefined });
  m.run(src);
  if (s.sc.kind !== 'none') {
    m.sb.REST_PEERS_ = (m.sb.REST_PEERS_ || []).filter((p) => p.ss !== 'SELF').concat([{ code: 'gf', ss: 'SELF' }]);
    const sh = m.self.insertSheet('sched_pub');
    sh.appendRow(['store', 'period', 'seq', 'data', 'last_op', 'updated_at']);
    sh.appendRow(['', 'T01', 1, JSON.stringify(s.sc.data), 'op', '']);
  }
  if (s.leave) {
    const sh = m.self.insertSheet('requests');
    sh.appendRow(RQH);
    sh.appendRow(['r1', '', 'E01', '', 'leave', s.leave[0], '特休假', s.leave[1], s.leave[2], 1, '', '', '', 'approved', '2026-11-19T20:00:00+08:00']);
  }
  return m;
}
function runOp(m, op) {
  const sb = m.sb;
  const post = (b) => JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  switch (op) {
    case 'status': return sb.handleLiffStatus_({ id_token: 'TOK_U1' });
    case 'sweep': sb.capSweep(); return null;
    case 'punch_in': case 'punch_out': return sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: op.slice(6), confirm_same: true }, HERE));
    case 'lclock_in': case 'lclock_out': return sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: op.slice(7) }, HERE));
    case 'old_in': case 'old_out': return post(Object.assign({ action: 'clock', key: 'K1', type: op.slice(4), device_id: 'D1' }, HERE));
  }
}
/** 這一步之前是不是「寬限情境」——不用新版自己的函式判（免得循環論證）：滿 10 那一刻取舊版 capJudge_（取整、休息、假單同一套），
 *  班表下班時刻在這裡自己算（情境產生器知道班表長什麼樣：只有 11/20 那格是 W，分段照順序接、跨午夜加一天、上班卡比下班晚＝不算）。 */
function schedEndOf(s, inMs) {
  if (s.sc.kind !== 'work') return null;
  const day = iso(inMs).slice(0, 10);
  const sh = s.sc.data.shifts[0], parts = sh.segs ? sh.segs.map((x) => [x.start, x.end]) : [[sh.start, sh.end]];
  const mm = (v) => +v.slice(0, 2) * 60 + +v.slice(3, 5);
  let prev = -Infinity, end = null;
  for (const [x, y] of parts) { let a = mm(x), b = mm(y); if (a < prev) a += 1440; while (b <= a) b += 1440; prev = b; end = b; }
  const endMs = BASE + end * 60000;
  // 2026-11-23 審查第一輪第 2 條：11/21 凌晨的上班卡落在 11/20 跨夜那段（還沒到下班）→ 用 11/20 那段；11/21 是例假（其他情況＝照舊）
  if (day === iso(BASE + 86400000).slice(0, 10)) return endMs > BASE + 86400000 && inMs < endMs ? endMs : null;
  if (day !== D) return null;
  return inMs < endMs ? endMs : null;
}
function graceSituation(m, s, now) {
  const sb = m.sb, ss = sb.getSS();
  try {
    const r = sb.capJudge_(sb.capEventsFor_(ss, ME, now, null), now, sb.capMakeFill_('E01'), sb.capBreak_(), sb.capLeavesFor_(ss, ME, now));
    if (r.lock || !r.due || r.due.store) return false;
    const end = schedEndOf(s, r.due.in);
    return end !== null && r.due.at - end > 30 * 60000;
  } catch (e) { return false; }
}
const snap = (m) => JSON.stringify([m.self.sh.events.values, m.props]);
/** 舊、新各跑一次；回 {same, firstDiff:{i, op, grace}} */
function compare(s, capOld, capNew) {
  const a = world(OLD, s, capOld), b = world(NEW, s, capNew);
  for (let i = 0; i < s.ops.length; i++) {
    const [t, op] = s.ops[i];
    a.setNow(t); b.setNow(t);
    const g = capNew === '2' ? graceSituation(a, s, t) : false;   // a＝舊版世界（這一步之前兩邊的表一樣）
    let ra, rb;
    try { ra = JSON.stringify(runOp(a, op)); } catch (e) { ra = 'THROW ' + e.message; }
    try { rb = JSON.stringify(runOp(b, op)); } catch (e) { rb = 'THROW ' + e.message; }
    // props 只比 REST_CAP_ON 以外（第二輪兩邊本來就不同值）
    const pa = JSON.stringify([a.self.sh.events.values, Object.assign({}, a.props, { REST_CAP_ON: 'x' })]);
    const pb = JSON.stringify([b.self.sh.events.values, Object.assign({}, b.props, { REST_CAP_ON: 'x' })]);
    if (ra !== rb || pa !== pb) return { same: false, i, op, grace: g, ra, rb };
  }
  return { same: true };
}

const scen = [];
for (let i = 0; i < N; i++) scen.push(Object.assign(genScenario(false), { long: false }));
for (let i = 0; i < NL; i++) scen.push(Object.assign(genScenario(true), { long: true }));

const VALS = ['', '0', '3', 'true', 'on', ' 1', '2 ', ' 2', '02', null, 2];   // 2＝數字 2（不是字串 '2'）
let other = { same: 0, diff: [] };
let off = { same: 0, diff: [] }, on = { same: 0, allowed: 0, bad: [], byOp: {} }, ops = 0, graceSeen = 0;
scen.forEach((s, idx) => {
  ops += s.ops.length;
  const r1 = compare(s, '1', '1');
  if (r1.same) off.same++; else off.diff.push([idx, r1]);
  const v = VALS[idx % VALS.length];
  const r3 = compare(s, v, v);   // 第三輪：兩邊同一個「不是 '1' 也不是 '2'」的值（含沒設）→ 一定一樣
  if (r3.same) other.same++; else other.diff.push([idx, v, r3]);
  const r2 = compare(s, '1', '2');
  if (r2.same) on.same++;
  else if (r2.grace && s.sc.kind === 'work' && ['status', 'sweep', 'punch_in', 'lclock_in', 'old_in'].indexOf(r2.op) >= 0) { on.allowed++; on.byOp[r2.op] = (on.byOp[r2.op] || 0) + 1; }
  else on.bad.push([idx, r2, s]);
});
console.log('情境 ' + scen.length + '（一般 ' + N + '、長工時 ' + NL + '），步驟共 ' + ops);
console.log("第一輪 兩邊 '1'：完全相同 " + off.same + '／' + scen.length + '，不同 ' + off.diff.length);
console.log("第三輪 兩邊同一個其他值（'', '0', '3', 'true', 'on', ' 1', '2 ', ' 2', '02', 沒設, 數字 2）：完全相同 " + other.same + '／' + scen.length + '，不同 ' + other.diff.length);
console.log("第二輪 舊 '1'／新 '2'：完全相同 " + on.same + '，差異都在寬限情境 ' + on.allowed + ' ' + JSON.stringify(on.byOp) + '，不該有的差異 ' + on.bad.length);
off.diff.slice(0, 3).forEach((x) => console.log('  第一輪不同 #' + x[0], JSON.stringify(x[1]).slice(0, 400)));
on.bad.slice(0, 3).forEach((x) => console.log('  第二輪不該有 #' + x[0], JSON.stringify(x[1]).slice(0, 400), JSON.stringify(x[2].ops)));
other.diff.slice(0, 3).forEach((x) => console.log('  第三輪不同 #' + x[0] + ' 值=' + JSON.stringify(x[1]), JSON.stringify(x[2]).slice(0, 300)));

/* 第四輪（2026-11-23 第三次驗收）：兩家店同步隨機——同仁在 B 店（mzt，B07）11/20 09:00 上班，A 店（光復，E01）與 B 店各跑自己的程式，
 * 每一步後把兩店 events 同步。隨機：B 店班表（09–18＝B 判寬限／09–21＝B 照舊代記／沒發布）、同名（沒有／B08 同名但沒上班／B08 同一秒上班）、
 * A 店讀 B 店名冊或打卡列時隨機丟例外、動作序列（A 開頁、A 按上班／下班 × LINE／liff_clock／舊 clock、B 開頁、B 掃描）。開關 '2'。
 * 判準：①任何時刻 E01＋B07 的系統卡 ≤ 1 張、B08 ≤ 1 張；②最後（同步＋B 掃描）兩店頁面鎖不鎖一致、鎖的時間一致；
 *       ③頁面說鎖在 HH:MM，就真的有那張系統卡；④09:00 那段之後的第一張卡不可以是本人下班卡（＝超過 10 小時），是上班卡（被放行）只在 B 判寬限、A 分得出人時；
 *       ⑤B 照舊代記（09–21、沒發布）時，最後一定有一張 19:00 的系統卡。 */
const NR = +arg('--n4', 600);
const ME_A = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const B07 = { emp_id: 'B07', name: '測試一', key: 'KB', device_id: 'DB', active: 'TRUE', line_user_id: 'U1' };
const B08 = { emp_id: 'B08', name: '測試 一', key: 'KB8', device_id: 'DB8', active: 'TRUE' };
const SH4 = [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'X', name: '長', start: '09:00', end: '21:00' }];
const sched4 = (sid) => ({ start: '2026-11-01', shifts: SH4, rows: ['B07', 'B08'].map((id) => ({ emp_id: id, name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: sid } : { t: 'R' })) })) });
function world4(view, sc) {
  const bEv = [[D + 'T09:00:00', 'B07', 'in']].concat(sc.twin === 'same' ? [[D + 'T09:00:00', 'B08', 'in']] : []);
  const aSpec = { roster: [ME_A], events: [] }, bSpec = { roster: sc.twin ? [B07, B08] : [B07], events: bEv };
  const m = make({ now: T(D + 'T19:00:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: '2' }, self: view === 'A' ? aSpec : bSpec, peers: view === 'A' ? { SS_B: bSpec } : { SS_A: aSpec } });
  m.run(NEW);
  m.sb.REST_PEERS_ = view === 'A' ? [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }] : [{ code: 'mzt', ss: 'SELF' }, { code: 'gf', ss: 'SS_A' }];
  const sh = (view === 'A' ? m.self : m.peers.SS_A).insertSheet('sched_pub');
  sh.appendRow(['store', 'period', 'seq', 'data', 'last_op', 'updated_at']);
  if (sc.sid) sh.appendRow(['mzt', 'T01', 1, JSON.stringify(sched4(sc.sid)), 'op', '']);
  if (view === 'A') {   // A 店在 capGraceWho_ 裡讀 B 店名冊／打卡列：m.__fail 為真時丟例外
    const orig = m.sb.capGraceWho_; let inWho = false;
    m.sb.capGraceWho_ = function () { inWho = true; try { return orig.apply(this, arguments); } finally { inWho = false; } };
    ['roster', 'events'].forEach((nm) => { const s = m.peers.SS_B.sh[nm]; ['getDataRange', 'getRange', 'getLastRow'].forEach((fn) => { const o = s[fn]; if (o) s[fn] = function () { if (inWho && m.__fail === nm) throw new Error('隨機讀取失敗'); return o.apply(this, arguments); }; }); });
    const c = m.sb.CacheService.getScriptCache();
    m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { get: (k) => (inWho && m.__fail === 'roster' && /^rpr:/.test(k) ? null : c.get(k)) }) };
  }
  return m;
}
const cp4 = (dst, src) => { dst.length = 0; src.forEach((r) => dst.push(r.slice())); };
function sync4(W, from) {
  if (from === 'A') { cp4(W.B.peers.SS_A.sh.events.values, W.A.self.sh.events.values); cp4(W.B.self.sh.events.values, W.A.peers.SS_B.sh.events.values); }
  else { cp4(W.A.self.sh.events.values, W.B.peers.SS_A.sh.events.values); cp4(W.A.peers.SS_B.sh.events.values, W.B.self.sh.events.values); }
}
const rowsOf = (bk) => { const v = bk.sh.events.values, h = v[0]; return v.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const evs4 = (W) => rowsOf(W.A.self).map((e) => Object.assign({ st: 'A' }, e)).concat(rowsOf(W.B.self).map((e) => Object.assign({ st: 'B' }, e)))
  .map((e) => Object.assign(e, { ms: Date.parse(String(e.ts)) })).sort((a, b) => a.ms - b.ms);
const sysOf = (W, id) => evs4(W).filter((e) => e.source === 'system_cap' && (!id || String(e.emp_id) === id));
const page4 = (m) => { const c = (m.sb.handleLiffStatus_({ id_token: 'TOK_U1' }).cap) || {}; return c.locked ? 'LOCK' + c.sys_hm : 'free'; };
const OPS4 = ['A_status', 'A_in_line', 'A_in_lclock', 'A_in_old', 'A_out_line', 'A_out_lclock', 'A_out_old', 'B_status', 'B_sweep'];
function op4(W, op) {
  const m = op[0] === 'A' ? W.A : W.B, sb = m.sb;
  const post = (b) => JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  const ty = /_in_/.test(op) ? 'in' : 'out';
  if (op.endsWith('status')) sb.handleLiffStatus_({ id_token: 'TOK_U1' });
  else if (op === 'B_sweep') sb.capSweep();
  else if (op.endsWith('_line')) sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: ty, confirm_same: true }, HERE));
  else if (op.endsWith('_lclock')) sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: ty }, HERE));
  else post(Object.assign({ action: 'clock', key: 'K1', type: ty, device_id: 'D1' }, HERE));
  sync4(W, op[0]);
}
const bad4 = [];
let n4 = 0, unsureOps = 0;
for (let k = 0; k < NR; k++) {
  const sc = { sid: pick(['A', 'A', 'X', 'X', null]), twin: pick([false, false, 'roster', 'same']) };
  const W = { A: world4('A', sc), B: world4('B', sc) };
  let t = T(D + 'T19:0' + ri(1, 9) + ':00');
  const steps = [], n = ri(2, 6);
  let why = '';
  for (let i = 0; i < n && !why; i++) {
    const op = pick(OPS4), fail = rnd() < 0.4 ? pick(['roster', 'events']) : null;
    W.A.__fail = fail; W.A.setNow(t); W.B.setNow(t);
    if (fail && op[0] === 'A') unsureOps++;
    op4(W, op); steps.push(op + (fail ? '!' + fail : '') + '@' + iso(t).slice(11, 16));
    W.A.__fail = null;
    const c1 = sysOf(W, 'E01').length + sysOf(W, 'B07').length, c2 = sysOf(W, 'B08').length;
    if (c1 > 1 || c2 > 1) why = '①系統卡超過 1 張 ' + JSON.stringify(sysOf(W).map((e) => e.st + String(e.ts).slice(11, 16) + e.emp_id));
    t += ri(1, 25) * 60000;
  }
  if (!why) {   // 收尾：B 掃描、兩店開頁
    W.A.setNow(t); W.B.setNow(t);
    op4(W, 'B_sweep');
    const pa = page4(W.A), pb = page4(W.B), sys = sysOf(W);
    const hasAt = (hm) => sys.some((e) => String(e.ts).slice(11, 16) === hm);
    const c1 = sysOf(W, 'E01').length + sysOf(W, 'B07').length;
    const seg = evs4(W).filter((e) => (e.type === 'in' || e.type === 'out') && String(e.status).indexOf('rejected_') !== 0 && e.ms > T(D + 'T09:00:00') && String(e.emp_id) !== 'B08');
    const first = seg[0];
    if (c1 > 1) why = '①系統卡超過 1 張';
    else if (pa !== pb) why = '②兩店頁面不一致 A=' + pa + ' B=' + pb;
    else if (pa.startsWith('LOCK') && !hasAt(pa.slice(4))) why = '③頁面鎖 ' + pa + ' 卻沒有那張卡';
    else if (first && first.type === 'out' && first.source !== 'system_cap') why = '④超過 10 小時：第一張是本人下班卡 ' + first.st + String(first.ts).slice(11, 16);
    else if (first && first.type === 'in' && !(sc.sid === 'A' && sc.twin !== 'same')) why = '④上班被放行但 B 不會判寬限或 A 分不出人 ' + first.st + String(first.ts).slice(11, 16);
    else if (sc.sid !== 'A' && !hasAt('19:00')) why = '⑤B 照舊代記卻沒有 19:00 的卡';
  }
  n4++;
  if (why) bad4.push([k, JSON.stringify(sc), steps.join(' '), why]);
}
console.log('第四輪 兩店同步隨機（名冊／打卡列隨機丟例外）：' + n4 + ' 組、A 店讀取丟例外的動作 ' + unsureOps + ' 次，違反判準 ' + bad4.length);
bad4.slice(0, 5).forEach((x) => console.log('  第四輪 #' + x[0] + ' ' + x[1] + ' ' + x[2] + ' → ' + x[3]));
process.exit(off.diff.length || on.bad.length || other.diff.length || bad4.length ? 1 : 0);

