#!/usr/bin/env node
/* 班表寬限（2026-11-24）逐位元組比對：同一批輸入餵 38d0340 的 Cap10.gs（舊）與工作區的 Cap10.gs（新），
 * 依序跑「即時狀態（開頁）、掃描、LINE 按上班／下班、舊 liff_clock 上班／下班、舊連結 clock 上班／下班」，
 * 每一步的回應＋每一步之後的 events 整張表＋指令碼屬性都要一樣。
 *   第一輪：兩邊 REST_CAP_ON='1'（寬限關著）→ 一定全部一樣。
 *   第二輪：舊 '1'、新 '2'（寬限開著）→ 第一個不一樣的那一步，必須是「有班表、滿 10 那一刻晚於班表下班超過 30 分、本店這段、
 *           而且那一步是開頁／掃描／按上班」（之後兩邊的表已經不同，不再比）；其他任何差異都算錯。
 * 用法：node tools/cap10-grace-diff.js [--old <舊 Cap10.gs 路徑>] [--new <新 Cap10.gs 路徑>] [--n 400] [--long 1000] [--seed 20261124]
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
  if (day !== D) return null;
  const sh = s.sc.data.shifts[0], parts = sh.segs ? sh.segs.map((x) => [x.start, x.end]) : [[sh.start, sh.end]];
  const mm = (v) => +v.slice(0, 2) * 60 + +v.slice(3, 5);
  let prev = -Infinity, end = null;
  for (const [x, y] of parts) { let a = mm(x), b = mm(y); if (a < prev) a += 1440; while (b <= a) b += 1440; prev = b; end = b; }
  const endMs = BASE + end * 60000;
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

const VALS = ['', '0', '3', 'true', 'on', ' 1', '2 ', ' 2', '02', null];
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
console.log("第三輪 兩邊同一個其他值（'', '0', '3', 'true', 'on', ' 1', '2 ', ' 2', '02', 沒設）：完全相同 " + other.same + '／' + scen.length + '，不同 ' + other.diff.length);
console.log("第二輪 舊 '1'／新 '2'：完全相同 " + on.same + '，差異都在寬限情境 ' + on.allowed + ' ' + JSON.stringify(on.byOp) + '，不該有的差異 ' + on.bad.length);
off.diff.slice(0, 3).forEach((x) => console.log('  第一輪不同 #' + x[0], JSON.stringify(x[1]).slice(0, 400)));
on.bad.slice(0, 3).forEach((x) => console.log('  第二輪不該有 #' + x[0], JSON.stringify(x[1]).slice(0, 400), JSON.stringify(x[2].ops)));
other.diff.slice(0, 3).forEach((x) => console.log('  第三輪不同 #' + x[0] + ' 值=' + JSON.stringify(x[1]), JSON.stringify(x[2]).slice(0, 300)));
process.exit(off.diff.length || on.bad.length || other.diff.length ? 1 : 0);
