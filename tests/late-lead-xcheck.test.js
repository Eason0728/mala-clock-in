/* 上午整段沒到改算遲到：前後端一致性對照（2026-11-26 第四輪，Codex 第二輪兩個擋項都是「營運系統預填跟打卡端判斷不一致」的固定防線）。
 *
 * 流程：同一組輸入 → 營運系統 core-calc.js 算預填（這一版 NEW／改動前凍結副本 OLD）→ 照預填送打卡端只檢查（這一版／改動前 f21cc25）。
 * 斷言：
 *   (a) 這一版的預填送這一版打卡端被擋，而主線（OLD 預填送 f21cc25）不擋 → 不行；例外：主管填的遲到比系統少（第 4 題「填得比系統少，免掉的那段要有單」）。
 *   (b) 打卡端有套新規則、而且過了、主管沒填遲到 → 卡片顯示的遲到分鐘（預填 late）＝打卡端狀態的遲到分鐘。
 *   (c) 打卡端沒套新規則 → 這一版預填跟改動前預填逐字相同。
 * 輸入：休息帶（央廚 12–13、總部 14–15）× 日期（生效日後兩天、生效日前一天）× 班表三種寫法（一段休 60、一段沒填休息、兩段）
 *   × 打卡樣態（上午有來、休息中到、休息後晚回來、休息中短打一段、整點、只有上班卡、只有下班卡…）× 單據（無、補上班、補下班、兩張、上午整段假、部分假、出差、加班）
 *   × 主管遲到欄（空白、0、比系統少、比系統多）；另加亂數。
 * 營運系統那份程式從 STOREOPS_ROOT（mala-store-ops 的資料夾，要是同一個分支）讀；沒設＝跳過（印一行），run-all 照樣過。
 *   例：STOREOPS_ROOT=~/dev/_wt/storeops-late-first-block node tests/late-lead-xcheck.test.js
 * 打卡端改動前的版本用 git show（LATE_LEAD_BASE，預設 f21cc25）。只用假資料，不連網路。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { check, show, done, ROOT } = require('./helpers/gs-sandbox');

const SO = process.env.STOREOPS_ROOT;
if (!SO || !fs.existsSync(path.join(SO, 'web', 'modules', 'duty', 'core-calc.js'))) {
  show('XC0', '跳過：沒設 STOREOPS_ROOT（營運系統同一分支的資料夾）', SO || '');
  done();
  return;
}
const NEW = require(path.join(SO, 'web', 'modules', 'duty', 'core-calc.js'));
const OLD = require(path.join(SO, 'test', 'fixtures', 'core-calc-before-latelead.mjs'));
const BASE = process.env.LATE_LEAD_BASE || 'f21cc25';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'late-xcheck-base-'));
fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
['Code.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));

const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const lateSum = (st) => String(st || '').split('、').reduce((a, n) => { const g = /^遲到(\d+)分/.exec(n); return a + (g ? Number(g[1]) : 0); }, 0);
const ps = (r) => (r ? r.periods.map((p) => p.start + '-' + p.end).join(',') : '');

function scen(brk, date, planKind, S, E, punches, reqs, lateKind, tag) {
  const [bs, be] = brk;
  const plan = planKind === 'one' ? [{ start: hm(S), end: hm(E), break_min: 60 }] : planKind === 'one0' ? [{ start: hm(S), end: hm(E) }] : [{ start: hm(S), end: hm(bs) }, { start: hm(be), end: hm(E) }];
  return { tag, brk: { start: hm(bs), end: hm(be) }, date, plan, punches: punches.map(([a, b]) => ({ in: a == null ? null : hm(a), out: b == null ? null : hm(b) })), reqs, lateKind };
}
const list = [];
// 格點
for (const brk of [[720, 780], [840, 900]]) {
  const [bs, be] = brk, S = bs === 720 ? 480 : 540, E = S + 540;      // 一天 8 小時（央廚 08–17、總部 09–18，各休 1 小時）
  const P = [['morning', [[S + 5, E]]], ['brkIn16', [[bs + 16, E]]], ['brkIn47', [[bs + 47, E]]], ['atBs', [[bs, E]]], ['atBe', [[be, E]]], ['late20', [[be + 20, E]]],
    ['brkSeg', [[bs + 16, bs + 27], [be, E]]], ['brkSegLate', [[bs + 16, bs + 27], [be + 20, E]]], ['brkSegEarlyBack', [[bs + 30, bs + 45], [be - 10, E]]], ['brkSegAtBs', [[bs, bs + 10], [be, E]]],
    ['loneIn', [[bs + 47, null]]], ['loneOut', [[null, E]]], ['morningPart', [[S + 30, bs - 60], [be, E]]], ['straddle', [[bs + 50, be + 5], [be + 15, E]]]];
  const R = [['none', []], ['missIn', [{ kind: 'miss', miss_type: 'in', start: hm(S), end: '' }]], ['missOut', [{ kind: 'miss', miss_type: 'out', start: '', end: hm(E) }]],
    ['missBoth', [{ kind: 'miss', miss_type: 'both', start: hm(S), end: hm(bs) }]], ['missTwo', [{ kind: 'miss', miss_type: 'in', start: hm(S), end: '' }, { kind: 'miss', miss_type: 'out', start: '', end: hm(bs) }]],
    ['leaveAM', [{ kind: 'leave', leave_type: '事假', start: hm(S), end: hm(bs), hours: (bs - S) / 60 }]], ['leaveMid', [{ kind: 'leave', leave_type: '事假', start: hm(S + 120), end: hm(S + 180), hours: 1 }]],
    ['leaveHead', [{ kind: 'leave', leave_type: '事假', start: hm(S), end: hm(S + 60), hours: 1 }]], ['tripAM', [{ kind: 'trip', start: hm(S), end: hm(bs), hours: (bs - S) / 60 }]],
    ['ot', [{ kind: 'ot', start: hm(E), end: hm(E + 60), hours: 1 }]]];
  for (const date of ['2026-11-20', '2026-12-03', '2026-10-28'])
    for (const pk of ['one', 'one0', 'two'])
      for (const [pn, pu] of P) for (const [rn, rq] of R) for (const lk of ['', '0', 'less', 'more'])
        list.push(scen(brk, date, pk, S, E, pu, rq, lk, [hm(bs), date, pk, pn, rn, lk || 'blank'].join('|')));
}
// 亂數
let seed = Number(process.env.LATE_XCHECK_SEED) || 20261127;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)], ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
for (let i = 0; i < Number(process.env.LATE_XCHECK_N || 3000); i++) {
  const brk = pick([[720, 780], [840, 900]]), [bs, be] = brk, S = pick([420, 480, 540, 600].filter((x) => x < bs - 60)), E = be + pick([180, 240, 300]);
  const segs = []; let cur = rnd() < 0.7 ? ri(bs - 20, be + 90) : ri(S - 30, bs - 1);
  for (let k = 0, n = pick([1, 1, 2, 2, 3]); k < n && cur < E + 60; k++) { const a = cur, b = Math.min(1410, a + pick([ri(5, 40), ri(60, 400)])), r = rnd(); segs.push(r < 0.1 ? [null, b] : r < 0.2 ? [a, null] : [a, b]); cur = b + ri(3, 60); }
  // 單張上班卡後面緊接單張下班卡，打卡端（dayPunchSegments）會配成一段——營運系統拿到的打卡段也是配好的，這裡照樣先配好
  for (let k = 0; k + 1 < segs.length; k++) if (segs[k][1] == null && segs[k + 1][0] == null) { segs.splice(k, 2, [segs[k][0], segs[k + 1][1]]); }
  const rq = [];
  const q = rnd();
  if (q < 0.12) rq.push({ kind: 'miss', miss_type: 'in', start: hm(pick([S, S + 30])), end: '' });
  else if (q < 0.2) rq.push({ kind: 'miss', miss_type: 'out', start: '', end: hm(pick([bs, E])) });
  else if (q < 0.28) rq.push({ kind: 'miss', miss_type: 'both', start: hm(S), end: hm(bs) });
  else if (q < 0.38) { const a = ri(S, bs - 30); rq.push({ kind: 'leave', leave_type: '事假', start: hm(a), end: hm(Math.min(bs, a + pick([30, 60, 120]))), hours: 1 }); }
  else if (q < 0.43) rq.push({ kind: 'trip', start: hm(S), end: hm(pick([bs, S + 60])), hours: 1 });
  else if (q < 0.5) rq.push({ kind: 'ot', start: hm(E), end: hm(E + 60), hours: 1 });
  rq.forEach((r) => { if (r.kind === 'leave' || r.kind === 'trip') r.hours = Math.round((toM(r.end) - toM(r.start)) / 60 * 100) / 100; });
  list.push(scen(brk, pick(['2026-11-20', '2026-12-03', '2026-10-28']), pick(['one', 'one0', 'two']), S, E, segs, rq, pick(['', '', '', '0', 'less', 'more']), 'rnd' + i));
}
function schedMin(c) { const [bs, be] = [toM(c.brk.start), toM(c.brk.end)]; return c.plan.reduce((a, p) => a + toM(p.end) - toM(p.start) - Math.max(0, Math.min(toM(p.end), be) - Math.max(toM(p.start), bs)), 0); }
function toM(x) { return Number(String(x).slice(0, 2)) * 60 + Number(String(x).slice(3, 5)); }

// 前端預填（這一版、改動前），再組打卡端要的輸入
const leavesOf = (reqs) => reqs.filter((r) => r.kind === 'leave' || r.kind === 'trip').map((r) => ({ type: r.kind === 'trip' ? '出差' : r.leave_type, hours: Number(r.hours) || 0 }));
const fe = list.map((c) => {
  const o = () => ({ segs: c.punches.map((x) => Object.assign({ cross: false }, x)), plan: { work: true, segs: c.plan, date: c.date }, reqs: c.reqs.map((x) => Object.assign({}, x)), brk: c.brk });
  const n = NEW.corePeriods(o()), m = OLD.corePeriods(o());
  const lm = (r) => (c.lateKind === '' ? '' : c.lateKind === '0' ? '0' : c.lateKind === 'less' ? String(Math.max(0, (r ? r.late : 0) - 30)) : String((r ? r.late : 0) + 30));
  return { n, m, inN: n && n.periods.length ? { date: c.date, brk: c.brk, punches: c.punches, reqs: c.reqs, leaves: leavesOf(c.reqs), periods: n.periods, late_min: lm(n), sched_spans: c.plan } : null,
    inM: m && m.periods.length ? { date: c.date, brk: c.brk, punches: c.punches, reqs: c.reqs, leaves: leavesOf(c.reqs), periods: m.periods, late_min: lm(m), sched_spans: c.plan } : null };
});
const runCI = (root, items) => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'late-xcheck-')), 'in.json');
  fs.writeFileSync(tmp, JSON.stringify(items.map((x) => x || { date: '2026-12-03', brk: { start: '12:00', end: '13:00' }, punches: [], reqs: [], periods: [{ start: '09:00', end: '10:00' }] })));
  try { return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'late-lead-xcheck-run.js')], { env: Object.assign({}, process.env, { GS_ROOT: root, LATE_XCHECK_IN: tmp }), encoding: 'utf8', maxBuffer: 512 << 20 })); }
  finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
};
const ciN = runCI(ROOT, fe.map((x) => x.inN)), ciM = runCI(base, fe.map((x) => x.inM));
fs.rmSync(base, { recursive: true, force: true });

const bad = { a: [], b: [], c: [] }, cnt = { otLong: 0, all: list.length, trig: 0, trigOk: 0, nt: 0, grid: list.filter((c) => !/^rnd/.test(c.tag)).length };
list.forEach((c, i) => {
  const f = fe[i], yn = f.inN ? ciN[i] : null, ym = f.inM ? ciM[i] : null;
  if (!yn) { if (ps(f.n) !== ps(f.m)) bad.c.push([c.tag, ps(f.n), ps(f.m)]); return; }
  if (yn.trig) { cnt.trig++; if (yn.ok) cnt.trigOk++; } else cnt.nt++;
  const sanctioned = (yn.trig && (c.lateKind === '0' || c.lateKind === 'less'))      // 第 4 題：填得比系統少，免掉的那段要有單
    || (yn.rules === 'ot_hours' && f.n.hours > 8 && schedMin(c) > 480);              // 班表本身超過 8 小時：新規則核滿班表＝超過 8 小時要加班單（第 8 題照現行；回報大腦）
  if (!yn.ok && ym && ym.ok && sanctioned && yn.rules === 'ot_hours') cnt.otLong++;
  if (!yn.ok && ym && ym.ok && !sanctioned) bad.a.push([c.tag, ps(f.n) + ' ' + yn.error + ':' + yn.rules, ps(f.m) + ' ok']);
  if (yn.trig && yn.ok && c.lateKind === '' && lateSum(yn.st) !== f.n.late) bad.b.push([c.tag, ps(f.n), '卡片 ' + f.n.late, '打卡端 ' + yn.st]);
  if (!yn.trig && JSON.stringify(f.n) !== JSON.stringify(f.m)) bad.c.push([c.tag, ps(f.n) + ' late ' + (f.n && f.n.late), ps(f.m) + ' late ' + (f.m && f.m.late)]);
});
if (process.env.LATE_XCHECK_DUMP) { const tags = new Set([].concat(bad.a, bad.b, bad.c).map((x) => x[0])); fs.writeFileSync(process.env.LATE_XCHECK_DUMP, JSON.stringify(Object.assign({ sc: list.filter((c) => tags.has(c.tag)) }, bad), null, 1)); }      // 除錯用：整份不一致清單
show('XC1', '組數：全部／其中格點／打卡端套新規則／其中過了／沒套／（不算擋項）班表超過 8 小時、新規則核滿班表要加班單、主線不用', [cnt.all, cnt.grid, cnt.trig, cnt.trigOk, cnt.nt, cnt.otLong]);
check('XC2', '組數夠（全部 ≥ 5000、套新規則 ≥ 300、沒套 ≥ 3000）', [cnt.all >= 5000, cnt.trig >= 300, cnt.nt >= 3000], [true, true, true]);
check('XCa', '(a) 這一版預填送打卡端被擋、主線同情境不擋（主管填的遲到比系統少除外）：' + bad.a.length + ' 組', bad.a.slice(0, 6), []);
check('XCb', '(b) 打卡端套新規則、過了、遲到欄空白：卡片的遲到分鐘＝打卡端狀態的遲到分鐘：不一致 ' + bad.b.length + ' 組', bad.b.slice(0, 6), []);
check('XCc', '(c) 打卡端沒套新規則：這一版預填跟改動前預填逐字相同：不同 ' + bad.c.length + ' 組', bad.c.slice(0, 6), []);
done();
