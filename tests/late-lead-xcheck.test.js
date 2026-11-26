/* 上午整段沒到改算遲到：前後端一致性對照（2026-11-26 第四輪起；Codex 第二輪兩個擋項、驗收員第五輪加驗的固定防線）。
 *
 * 流程：同一組輸入 → 營運系統 core-calc.js 算預填（這一版 NEW／改動前凍結副本 OLD）→ 照預填送打卡端只檢查（這一版／改動前 f21cc25）。
 * 斷言：
 *   (a) 這一版的預填送這一版打卡端被擋，而主線（OLD 預填送 f21cc25）不擋 → 不行；例外：主管填的遲到比系統少（第 4 題「填得比系統少，免掉的那段要有單」）、
 *       班表本身超過 8 小時要加班單（第 8 題照現行，見 progress.md 第五輪）。
 *   (b) 打卡端有套新規則、而且過了、主管沒填遲到 → 卡片顯示的遲到分鐘（預填 late）＝打卡端狀態的遲到分鐘。
 *   (c) 打卡端沒套新規則 → 這一版預填跟改動前預填逐字相同。
 * 輸入：休息帶（央廚 12–13、總部 14–15）× 日期（生效日後兩天、生效日前一天）× 班表三種寫法（一段休 60、一段沒填休息、兩段）
 *   × 打卡樣態 × 單據（無、補上班、補下班、補中間休息、兩張、上午整段假／部分假／開頭假、下午部分假、上午出差、整天出差、下午出差、補上班＋部分假、加班）
 *   × 主管遲到欄（空白、0、比系統少、比系統多）；另加亂數：LATE_XCHECK_SEEDS（逗號分隔，預設 5 個）× LATE_XCHECK_N（每個種子幾組，預設 15000）。
 * 營運系統那份程式：有設 STOREOPS_ROOT（mala-store-ops 同一分支的資料夾）就讀那裡；沒設就用本 repo 的凍結副本 fixtures/storeops-core-calc.js
 *   （＋改動前 fixtures/storeops-core-calc-before.mjs）。凍結副本的 sha256 釘在下面，mala-store-ops test/server/late-lead.test.js 釘同一個值：
 *   營運系統改了 core-calc.js 沒同步過來，那邊就紅（預設 npm test 就會跑到）。
 * 打卡端改動前的版本用 git show（LATE_LEAD_BASE，預設 f21cc25）。只用假資料，不連網路。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { check, show, done, ROOT } = require('./helpers/gs-sandbox');

const FROZEN_SHA = '8e518c8f84f9457ab6a662eaf438dd98db3cfb8a8684cdf5f2883c2f88c0b7fe';      // fixtures/storeops-core-calc.js（＝mala-store-ops web/modules/duty/core-calc.js）
const SO = process.env.STOREOPS_ROOT;
const newPath = SO ? path.join(SO, 'web', 'modules', 'duty', 'core-calc.js') : path.join(__dirname, 'fixtures', 'storeops-core-calc.js');
const oldPath = SO ? path.join(SO, 'test', 'fixtures', 'core-calc-before-latelead.mjs') : path.join(__dirname, 'fixtures', 'storeops-core-calc-before.mjs');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
check('XC00', '營運系統 core-calc.js 凍結副本的 sha256 ＝釘住的值（mala-store-ops 那邊釘同一個；改了前端要同步副本並一起改兩邊）' + (SO ? '；這次另外讀 STOREOPS_ROOT，副本也要跟它相同' : ''),
  [sha(path.join(__dirname, 'fixtures', 'storeops-core-calc.js')), SO ? sha(newPath) : FROZEN_SHA], [FROZEN_SHA, FROZEN_SHA]);
const NEW = require(newPath);
const OLD = require(oldPath);
const BASE = process.env.LATE_LEAD_BASE || 'f21cc25';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'late-xcheck-base-'));
fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
['Code.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));

const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toM = (x) => Number(String(x).slice(0, 2)) * 60 + Number(String(x).slice(3, 5));
const lateSum = (st) => String(st || '').split('、').reduce((a, n) => { const g = /^遲到(\d+)分/.exec(n); return a + (g ? Number(g[1]) : 0); }, 0);
const ps = (r) => (r ? r.periods.map((p) => p.start + '-' + p.end).join(',') : '');
const L = (a, b, t) => ({ kind: 'leave', leave_type: t || '事假', start: hm(a), end: hm(b), hours: Math.round((b - a) / 60 * 100) / 100 });
const TRIP = (a, b) => ({ kind: 'trip', start: hm(a), end: hm(b), hours: Math.round((b - a) / 60 * 100) / 100 });
const MI = (a) => ({ kind: 'miss', miss_type: 'in', start: hm(a), end: '' }), MO = (b) => ({ kind: 'miss', miss_type: 'out', start: '', end: hm(b) });
const MB = (a, b) => ({ kind: 'miss', miss_type: 'both', start: hm(a), end: hm(b) });
const MBRK = (out, back) => ({ kind: 'miss', miss_type: 'break', start: hm(back), end: hm(out) });      // 中間休息沒打卡：end＝出去、start＝回來

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
    ['brkSegLate16', [[bs + 27, bs + 42], [be + 16, E + 54]]], ['brkStraddleOnly', [[bs + 42, be + 13]]], ['brkStraddleLoneOut', [[bs + 42, be + 13], [null, E + 97]]],
    ['loneIn', [[bs + 47, null]]], ['loneOut', [[null, E]]], ['morningPart', [[S + 30, bs - 60], [be, E]]], ['straddle', [[bs + 50, be + 5], [be + 15, E]]]];
  const R = [['none', []], ['missIn', [MI(S)]], ['missOut', [MO(E)]], ['missBoth', [MB(S, bs)]], ['missTwo', [MI(S), MO(bs)]], ['missBreakAM', [MBRK(S + 120, S + 150)]], ['missBreakPM', [MBRK(be + 60, be + 90)]],
    ['leaveAM', [L(S, bs)]], ['leaveMid', [L(S + 120, S + 180)]], ['leaveHead', [L(S, S + 60)]], ['leavePM', [L(be + 30, E - 60)]], ['leavePMend', [L(be + 48, E)]],
    ['tripAM', [TRIP(S, bs)]], ['tripDay', [TRIP(S, E)]], ['tripPM', [TRIP(be, E)]], ['missInLeave', [MI(S), L(S + 120, S + 180)]], ['ot', [{ kind: 'ot', start: hm(E), end: hm(E + 60), hours: 1 }]]];
  for (const date of ['2026-11-20', '2026-12-03', '2026-10-28'])
    for (const pk of ['one', 'one0', 'two'])
      for (const [pn, pu] of P) for (const [rn, rq] of R) for (const lk of ['', '0', 'less', 'more'])
        list.push(scen(brk, date, pk, S, E, pu, rq, lk, [hm(bs), date, pk, pn, rn, lk || 'blank'].join('|')));
}
const nGrid = list.length;
// 亂數（多個種子）
const SEEDS = String(process.env.LATE_XCHECK_SEEDS || '20261127,11,22,33,44').split(',').map(Number).filter((x) => x);
const NPER = Number(process.env.LATE_XCHECK_N || 15000);
for (const sd of SEEDS) {
  let seed = sd;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)], ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  for (let i = 0; i < NPER; i++) {
    const brk = pick([[720, 780], [840, 900]]), [bs, be] = brk, S = pick([420, 480, 540, 600].filter((x) => x < bs - 60)), E = pick([S + 540, S + 540, be + pick([180, 240, 300])]);
    const segs = []; let cur = rnd() < 0.7 ? ri(bs - 20, be + 90) : ri(S - 30, bs - 1);
    for (let k = 0, n = pick([1, 1, 2, 2, 3]); k < n && cur < E + 60; k++) { const a = cur, b = Math.min(1410, a + pick([ri(5, 40), ri(60, 400)])), r = rnd(); segs.push(r < 0.1 ? [null, b] : r < 0.2 ? [a, null] : [a, b]); cur = b + ri(3, 60); }
    // 單張上班卡後面緊接單張下班卡，打卡端（dayPunchSegments）會配成一段——營運系統拿到的打卡段也是配好的，這裡照樣先配好
    for (let k = 0; k + 1 < segs.length; k++) if (segs[k][1] == null && segs[k + 1][0] == null) segs.splice(k, 2, [segs[k][0], segs[k + 1][1]]);
    const rq = [];
    for (let k = 0, n = pick([0, 1, 1, 1, 2]); k < n; k++) {
      const q = rnd();
      if (q < 0.12) rq.push(MI(pick([S, S + 30])));
      else if (q < 0.2) rq.push(MO(pick([bs, E])));
      else if (q < 0.27) rq.push(MB(S, bs));
      else if (q < 0.33) { const o = ri(S + 30, E - 60); rq.push(MBRK(o, o + pick([20, 30, 60]))); }
      else if (q < 0.48) { const a = ri(S, E - 30); rq.push(L(a, Math.min(E, a + pick([30, 60, 120, 132])))); }
      else if (q < 0.53) rq.push(TRIP(S, pick([bs, S + 60])));
      else if (q < 0.57) rq.push(TRIP(S, E));
      else if (q < 0.61) rq.push(TRIP(be, E));
      else if (q < 0.68) rq.push({ kind: 'ot', start: hm(E), end: hm(E + 60), hours: 1 });
    }
    list.push(scen(brk, pick(['2026-11-20', '2026-12-03', '2026-10-28']), pick(['one', 'one0', 'two']), S, E, segs, rq, pick(['', '', '', '0', 'less', 'more']), 's' + sd + ':' + i));
  }
}
function schedMin(c) { const bs = toM(c.brk.start), be = toM(c.brk.end); return c.plan.reduce((a, p) => a + toM(p.end) - toM(p.start) - Math.max(0, Math.min(toM(p.end), be) - Math.max(toM(p.start), bs)), 0); }

// 前端預填（這一版、改動前），再組打卡端要的輸入
const leavesOf = (reqs) => reqs.filter((r) => r.kind === 'leave' || r.kind === 'trip').map((r) => ({ type: r.kind === 'trip' ? '出差' : r.leave_type, hours: Number(r.hours) || 0 }));
const gate = { grid: { would: 0, gated: 0 }, rnd: { would: 0, gated: 0 } };      // 新規則會套的日子裡，被總閘擋回主線的有幾組
const thrown = [];      // 營運系統算預填丟例外（新版丟、改動前不丟＝新問題）
const fe = list.map((c) => {
  const o = () => ({ segs: c.punches.map((x) => Object.assign({ cross: false }, x)), plan: { work: true, segs: c.plan, date: c.date }, reqs: c.reqs.map((x) => Object.assign({}, x)), brk: c.brk });
  const tryIt = (F) => { try { return F.corePeriods(o()); } catch (e) { return { throw: String(e && e.message || e).slice(0, 80) }; } };
  const n0 = tryIt(NEW), m0 = tryIt(OLD);
  if (n0 && n0.throw) thrown.push([c.tag, 'NEW: ' + n0.throw, m0 && m0.throw ? 'OLD 也丟: ' + m0.throw : 'OLD 正常']);
  const n = n0 && n0.throw ? null : n0, m = m0 && m0.throw ? null : m0;
  // 閘擋回主線的量測：不開閘時新規則會套（預填拿去問 lateLeadClock 成立），開閘後卻照主線
  if (typeof NEW.lateLeadShapeOk === 'function' && c.date >= NEW.LATE_LEAD_FROM) {
    let g = null; try { g = NEW.corePeriods(Object.assign(o(), { lateLeadGate: false })); } catch (e) { g = null; }
    const would = !!(g && g.periods.length && NEW.lateLeadClock(g.periods, c.punches, c.brk, c.reqs, c.date));
    if (would) { const k = /^s\d/.test(c.tag) ? 'rnd' : 'grid'; gate[k].would++; if (!NEW.lateLeadShapeOk(c.punches, c.reqs, c.brk)) gate[k].gated++; }
  }
  const lm = (r) => (c.lateKind === '' ? '' : c.lateKind === '0' ? '0' : c.lateKind === 'less' ? String(Math.max(0, (r ? r.late : 0) - 30)) : String((r ? r.late : 0) + 30));
  const inOf = (r) => (r && r.periods.length ? { date: c.date, brk: c.brk, punches: c.punches, reqs: c.reqs, leaves: leavesOf(c.reqs), periods: r.periods, late_min: lm(r), sched_spans: c.plan } : null);
  return { n, m, inN: inOf(n), inM: inOf(m) };
});
// 打卡端只檢查：切成幾份平行跑（每份一個子行程，GS_ROOT 決定版本）
// 打卡端只檢查：切成每份 2500 組的小份、同時跑幾個子行程（GS_ROOT 決定版本）。每個子行程別塞太多沙盒：
//   一個子行程 2 萬多組時 node 偶爾 SIGSEGV（第五輪 run-all 遇過，沙盒每組一個 vm context）；失敗的那份自動重跑一次。
const CHUNK = 2500, JOBS = Math.max(1, Number(process.env.LATE_XCHECK_JOBS) || Math.min(4, os.cpus().length - 1));
const DUMMY = { date: '2026-12-03', brk: { start: '12:00', end: '13:00' }, punches: [], reqs: [], periods: [{ start: '09:00', end: '10:00' }] };
function runPart(root, file) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [path.join(__dirname, 'helpers', 'late-lead-xcheck-run.js')], { env: Object.assign({}, process.env, { GS_ROOT: root, LATE_XCHECK_IN: file }) });
    const out = []; ch.stdout.on('data', (d) => out.push(d)); ch.stderr.on('data', () => {});
    ch.on('close', (code) => (code === 0 ? resolve(JSON.parse(Buffer.concat(out).toString('utf8'))) : reject(new Error('打卡端子行程失敗 ' + code + ' ' + (ch.signalCode || '')))));
  });
}
async function runCI(root, items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-xcheck-')), parts = [];
  for (let k = 0; k * CHUNK < items.length; k++) {
    const f = path.join(dir, 'in' + k + '.json');
    fs.writeFileSync(f, JSON.stringify(items.slice(k * CHUNK, (k + 1) * CHUNK).map((x) => x || DUMMY)));
    parts.push(f);
  }
  const res = new Array(parts.length);
  let next = 0;
  const worker = async () => { while (next < parts.length) { const k = next++; try { res[k] = await runPart(root, parts[k]); } catch (e) { res[k] = await runPart(root, parts[k]); } } };
  await Promise.all(Array.from({ length: JOBS }, worker));
  fs.rmSync(dir, { recursive: true, force: true });
  return [].concat(...res);
}
(async () => {
  const [ciN, ciM] = await Promise.all([runCI(ROOT, fe.map((x) => x.inN)), runCI(base, fe.map((x) => x.inM))]);
  fs.rmSync(base, { recursive: true, force: true });
  const clockOnly = [];
  const bad = { a: [], b: [], c: [] }, cnt = { all: list.length, grid: nGrid, trig: 0, trigOk: 0, nt: 0, otLong: 0, seeds: {} };
  list.forEach((c, i) => {
    const f = fe[i], yn = f.inN ? ciN[i] : null, ym = f.inM ? ciM[i] : null, sk = c.tag.split(':')[0];
    const fail = (k, x) => { bad[k].push(x); if (/^s\d/.test(sk)) cnt.seeds[sk] = (cnt.seeds[sk] || 0) + 1; };
    if (!yn) { if (ps(f.n) !== ps(f.m)) fail('c', [c.tag, ps(f.n), ps(f.m)]); return; }
    if (yn.trig) { cnt.trig++; if (yn.ok) cnt.trigOk++; } else cnt.nt++;
    const otLong = yn.rules === 'ot_hours' && f.n.hours > 8 && schedMin(c) > 480;              // 班表本身超過 8 小時：新規則核滿班表＝超過 8 小時要加班單（第 8 題照現行）
    const sanctioned = (yn.trig && (c.lateKind === '0' || c.lateKind === 'less')) || otLong;      // 第 4 題：填得比系統少，免掉的那段要有單
    if (!yn.ok && ym && ym.ok && otLong) cnt.otLong++;
    // 前端預填跟主線逐字相同、只因打卡端新規則（打卡端這輪不准改）在同一份時段上被擋：前端已經照主線、沒有更好的做法 → 另外列（交大腦），不算前端擋項
    const sameAsMain = !yn.ok && ym && ym.ok && !sanctioned && ps(f.n) === ps(f.m);
    if (sameAsMain) clockOnly.push([c.tag, ps(f.n) + ' ' + yn.error + ':' + yn.rules]);
    if (!yn.ok && ym && ym.ok && !sanctioned && !sameAsMain) fail('a', [c.tag, ps(f.n) + ' ' + yn.error + ':' + yn.rules, ps(f.m) + ' ok']);
    if (yn.trig && yn.ok && c.lateKind === '' && lateSum(yn.st) !== f.n.late) fail('b', [c.tag, ps(f.n), '卡片 ' + f.n.late, '打卡端 ' + yn.st]);
    if (!yn.trig && JSON.stringify(f.n) !== JSON.stringify(f.m)) fail('c', [c.tag, ps(f.n) + ' late ' + (f.n && f.n.late), ps(f.m) + ' late ' + (f.m && f.m.late)]);
  });
  if (process.env.LATE_XCHECK_DUMP) { const tags = new Set([].concat(bad.a, bad.b, bad.c).map((x) => x[0])); fs.writeFileSync(process.env.LATE_XCHECK_DUMP, JSON.stringify(Object.assign({ sc: list.filter((c) => tags.has(c.tag)) }, bad), null, 1)); }      // 除錯用：整份不一致清單
  show('XC1', '組數：全部／其中格點／打卡端套新規則／其中過了／沒套／（不算擋項）班表超過 8 小時、新規則核滿班表要加班單、主線不用；種子 ' + SEEDS.join(',') + ' × ' + NPER, [cnt.all, cnt.grid, cnt.trig, cnt.trigOk, cnt.nt, cnt.otLong]);
  show('XC1g', '總閘（lateLeadShapeOk）：不開閘時新規則會套的組數／其中被閘擋回主線的（格點、亂數）', gate);
  show('XC1s', '各種子不一致組數（沒有＝0）', cnt.seeds);
  check('XC2', '組數夠（全部 ≥ 5000、套新規則 ≥ 300、沒套 ≥ 3000）', [cnt.all >= 5000, cnt.trig >= 300, cnt.nt >= 3000], [true, true, true]);
  check('XCx', '營運系統新版算預填不丟例外（改動前也丟的照列、不算新問題）：新版才丟的 ' + thrown.filter((x) => x[2] === 'OLD 正常').length + ' 組', thrown.filter((x) => x[2] === 'OLD 正常').slice(0, 6), []);
  if (thrown.length) show('XCx2', '（對照）改動前也丟例外的組數', thrown.filter((x) => x[2] !== 'OLD 正常').length);
  check('XCa', '(a) 這一版預填送打卡端被擋、主線同情境不擋（主管填的遲到比系統少、班表超過 8 小時除外）：' + bad.a.length + ' 組', bad.a.slice(0, 6), []);
  show('XCa2', '（不算前端擋項，交大腦）前端預填跟主線逐字相同、只因打卡端新規則在同一份時段被擋：' + clockOnly.length + ' 組', clockOnly.slice(0, 6));
  check('XCb', '(b) 打卡端套新規則、過了、遲到欄空白：卡片的遲到分鐘＝打卡端狀態的遲到分鐘：不一致 ' + bad.b.length + ' 組', bad.b.slice(0, 6), []);
  check('XCc', '(c) 打卡端沒套新規則：這一版預填跟改動前預填逐字相同：不同 ' + bad.c.length + ' 組', bad.c.slice(0, 6), []);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
