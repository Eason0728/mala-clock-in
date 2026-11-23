/* 跨店補時（2026-11-24 主管：「現行版本就有的跨店時數漏算。繼續做」；Cap10.gs capMakeFillAll_／capPeerId_／capFillPick_；REST_CAP_ON '3'／'4'）
 *
 * 規則白話版：
 *   1. 開關：REST_CAP_ON '3'＝收卡＋跨店補時；'4'＝收卡＋班表寬限（#232）＋跨店補時；'1'／'2'＝跟 ddd0cd0 完全一樣（不補別家店的卡）。
 *   2. 開著時，算「當日出勤」用班表補缺卡，別家店的卡也補：用那家店當天的已發布班表、那家店名冊同名在職的唯一工號（跟本店補缺卡同一條規則）。
 *      同名多人、名冊／班表讀不到、那家店沒發布、班表上找不到開始時間差 2 小時內的時段 → 不補（＝現狀）。
 *   3. 只有「正在上班那段在本店」（本店會寫系統卡）或「沒有正在上班」時用補過的結果；正在上班那段在別家店（本店只擋不寫）時照 38d0340 算。
 *      → 寫卡的店開著就會在對的時間寫；開關不同步時不會比現在多出「沒卡卻鎖」。
 * 手算：
 *   P1 B 店排 09–18（B07），09:00 在 B 上班、沒打下班；17:30 到 A 店（E01）上班。
 *      38d0340：A 只從 17:30 算（B 那張孤單、0 小時）→ 19:05 A 不收；B 用自己的班表補 09:00–17:30＝8.5 → 加上 A 那段 1.5＝10 → B 頁顯示「19:00 幫你記了下班卡」但 B 只擋不寫＝沒卡卻鎖。
 *      開關 '3'（A）：A 把 B 那張補到 17:30（下一張上班卡）＝8.5 小時 → 加 A 那段 → 19:00 滿 10 → A 掃描寫 19:00、A 頁鎖；B 讀到那張卡、鎖 19:00；B 掃描不寫。
 *   P2 同 P1 但 B 店同名兩人（B07、B08）→ A 分不出 → 不補 → 跟 38d0340 一樣。P3 B 沒發布 → 不補。P4 B 名冊讀不到 → 不補。
 *   P5 A 關（'1'）、B 開（'3'）：寫卡的是 A（那段在 A）→ A 照 38d0340 不寫；B 只擋不寫、照 38d0340 算 → 跟 38d0340 一樣（不會更糟）。
 *   P6 A 開、B 關：A 寫 19:00；B（關）讀到卡鎖 → 收斂。
 *   P7 '4'：多店者照補時（不給寬限）；單店者照 #232 寬限。 */
'use strict';
const { make, T, at, check, done, R } = require('./helpers/gs-sandbox');
const CAP_SRC_REAL = R('apps-script/Cap10.gs');
const CAP_SRC = CAP_SRC_REAL.replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;');   // 沙盒兩家店
const git = (ref) => require('child_process').execFileSync('git', ['-C', require('path').join(__dirname, '..'), 'show', ref + ':apps-script/Cap10.gs'], { encoding: 'utf8' });
const SRC_BASE = git('38d0340'), SRC_232 = git('ddd0cd0').replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;');
const D = '2026-11-20', D2 = '2026-11-21';
const HERE = Object.assign({ accuracy: 10 }, at(3));
const SP_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];
const RQH = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at'];
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const B07 = { emp_id: 'B07', name: '測試一', key: 'KB', device_id: 'DB', active: 'TRUE', line_user_id: 'U1' };
const B08 = { emp_id: 'B08', name: '測試 一', key: 'KB8', device_id: 'DB8', active: 'TRUE' };
const cellsOf = (map) => Array.from({ length: 28 }, (_, i) => map[i] || { t: 'R' });
/** shifts＋{工號: {格 index: 班別 id}} → sched_pub 資料 */
const sched = (shifts, who) => ({ start: '2026-11-01', shifts, rows: Object.keys(who).map((id) => ({ emp_id: id, name: '測試一', cells: cellsOf(Object.fromEntries(Object.entries(who[id]).map(([i, s]) => [i, { t: 'W', s }]))) })) });
const SH = [{ id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'N', name: '夜', start: '18:00', end: '02:00' },
  { id: 'S', name: '兩段', start: '09:00', end: '20:00', segs: [{ start: '09:00', end: '13:00' }, { start: '16:00', end: '20:00' }] }, { id: 'L', name: '長', start: '09:00', end: '21:00' }];

/** view 'A'＝光復（E01）、'B'＝mzt（B07[＋B08]）。opt：aEv、bEv（[ts, emp, type]）、bTwin、bSched／aSched（資料或 null）、capA／capB、reqsA／reqsB、hook */
function world(view, opt, src) {
  const aSpec = { roster: [ME], events: opt.aEv || [] }, bSpec = { roster: opt.bTwin ? [B07, B08] : [B07], events: opt.bEv || [] };
  const m = make({ now: T(opt.now || D + 'T19:05:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: view === 'A' ? opt.capA : opt.capB },
    self: view === 'A' ? aSpec : bSpec, peers: view === 'A' ? { SS_B: bSpec } : { SS_A: aSpec } });
  m.run(src || CAP_SRC);
  if ((view === 'A' ? opt.capA : opt.capB) === undefined) delete m.props.REST_CAP_ON;
  m.sb.REST_PEERS_ = view === 'A' ? [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }] : [{ code: 'mzt', ss: 'SELF' }, { code: 'gf', ss: 'SS_A' }];
  const gf = view === 'A' ? m.self : m.peers.SS_A;
  const sh = gf.insertSheet('sched_pub'); sh.appendRow(SP_HEAD);
  if (opt.bSched) sh.appendRow(['mzt', 'T01', 1, JSON.stringify(opt.bSched), 'op', '']);
  if (opt.aSched) sh.appendRow(['', 'T01', 1, JSON.stringify(opt.aSched), 'op', '']);
  const addReqs = (bk, rows, emp) => { if (!rows) return; const r = bk.insertSheet('requests'); r.appendRow(RQH); rows.forEach((x, i) => r.appendRow(['r' + i, '', emp, '', 'leave', x[0], '特休假', x[1], x[2], x[3], '', '', '', 'approved', '2026-11-19T20:00:00+08:00'])); };
  addReqs(view === 'A' ? m.self : m.peers.SS_A, opt.reqsA, 'E01');
  addReqs(view === 'A' ? m.peers.SS_B : m.self, opt.reqsB, 'B07');
  if (opt.hook) opt.hook(m, view);
  return m;
}
const cp = (dst, src) => { dst.length = 0; src.forEach((r) => dst.push(r.slice())); };
function pair(opt, src) { return { A: world('A', opt, src), B: world('B', opt, src), opt }; }
function sync(W, from) {
  if (from === 'A') { cp(W.B.peers.SS_A.sh.events.values, W.A.self.sh.events.values); cp(W.B.self.sh.events.values, W.A.peers.SS_B.sh.events.values); }
  else { cp(W.A.self.sh.events.values, W.B.peers.SS_A.sh.events.values); cp(W.A.peers.SS_B.sh.events.values, W.B.self.sh.events.values); }
}
const setNow = (W, t) => { W.A.setNow(t); W.B.setNow(t); };
const isSys = (r) => r.indexOf('system_cap') >= 0;
const cards = (W) => W.A.self.sh.events.values.filter(isSys).map((r) => 'A' + String(r[0]).slice(11, 16)).concat(W.B.self.sh.events.values.filter(isSys).map((r) => 'B' + String(r[0]).slice(11, 16) + (r[1] === 'B08' ? 'B08' : '')));
const page = (m) => { const c = (m.sb.handleLiffStatus_({ id_token: 'TOK_U1' }).cap) || {}; return c.locked ? 'LOCK' + c.sys_hm : c.grace_hm ? 'grace' + c.grace_hm : 'free'; };
const OPS = ['A_status', 'A_sweep', 'A_in_line', 'A_out_line', 'A_in_lclock', 'A_out_lclock', 'A_in_old', 'A_out_old', 'B_status', 'B_sweep', 'B_in_line', 'B_out_line'];
function op(W, o) {
  const m = o[0] === 'A' ? W.A : W.B, sb = m.sb, ty = /_in_/.test(o) ? 'in' : 'out';
  let r = null;
  if (o.endsWith('status')) r = sb.handleLiffStatus_({ id_token: 'TOK_U1' });
  else if (o.endsWith('sweep')) sb.capSweep();
  else if (o.endsWith('_line')) r = sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: ty, confirm_same: true }, HERE));
  else if (o.endsWith('_lclock')) r = sb.handleLiffClockGuarded_(Object.assign({ id_token: 'TOK_U1', type: ty }, HERE));
  else r = JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'clock', key: o[0] === 'A' ? 'K1' : 'KB', type: ty, device_id: o[0] === 'A' ? 'D1' : 'DB' }, HERE)) } }).text);
  sync(W, o[0]);
  return JSON.stringify(r);
}
/** 收斂：兩店掃描、同步，再看兩頁 */
function settle(W) { W.A.sb.capSweep(); sync(W, 'A'); W.B.sb.capSweep(); sync(W, 'B'); W.A.sb.capSweep(); sync(W, 'A'); return [page(W.A), page(W.B)]; }
/** 用補過的算法直接算（兩店各自）：{today_ms, due, reach} */
function judgeFill(m) {
  const sb = m.sb, ss = sb.getSS(), me = sb.findRosterByKey ? null : null;
  const roster = sb.readSheetAsObjects(ss.getSheetByName('roster')).rows, who = roster.filter((r) => r.line_user_id === 'U1')[0];
  const now = sb.Date.now();
  const r = sb.capJudge_(sb.capEventsFor_(ss, who, now, null), now, sb.capMakeFillAll_(who), sb.capBreak_(), sb.capLeavesFor_(ss, who, now));
  return { today: r.today_ms, due: r.due ? r.due.at : null, reach: r.reach === undefined ? null : r.reach, lock: !!r.lock };
}

const SB918 = sched(SH, { B07: { 19: 'A' } }), SA918 = sched(SH, { E01: { 19: 'A' } });
const GAP = { bEv: [[D + 'T09:00:00', 'B07', 'in']], aEv: [[D + 'T17:30:00', 'E01', 'in']], bSched: SB918 };

console.log('════ 一、缺口重現（B 09:00 上班沒打下班、17:30 到 A 上班）════');
{
  const W = pair(Object.assign({ capA: '1', capB: '1' }, GAP), SRC_BASE);
  check('P0', '38d0340（兩店 \'1\'）：A 不收、A 頁沒鎖；B 頁顯示 19:00 已代記但沒有卡（現行缺口）', [settle(W), cards(W)], [['free', 'LOCK19:00'], []]);
}
['3', '4'].forEach((v) => {
  const W = pair(Object.assign({ capA: v, capB: v }, GAP));
  const fa = judgeFill(W.A), fb = judgeFill(W.B);
  check('P1★' + v, "兩店 '" + v + "'：A 把 B 那張補到 17:30（8.5 小時）→ 19:00 滿 10；A 掃描寫 19:00、兩頁都鎖 19:00、B 不寫；兩店用補過的算法算出同一個數字",
    [settle(W), cards(W), fa.today === fb.today && fa.due === fb.due && fa.reach === fb.reach], [['LOCK19:00', 'LOCK19:00'], ['A19:00'], true]);
});
{
  const W = pair(Object.assign({ capA: '3', capB: '3', now: D + 'T19:30:00' }, GAP));
  const r = op(W, 'A_in_line');
  check('P1b', "兩店 '3'、19:30 在 A 再按上班（寫卡前）→ cap_locked、A 寫 19:00、只有一張", [JSON.parse(r).status, cards(W), settle(W), cards(W)], ['cap_locked', ['A19:00'], ['LOCK19:00', 'LOCK19:00'], ['A19:00']]);
}

console.log('\n════ 二、不補的情況（＝現狀）════');
[
  ['P2', 'B 店同名兩人（B07、B08）→ A 分不出工號 → 不補', { bTwin: true }],
  ['P3', 'B 店沒發布班表 → 不補', { bSched: null }],
  ['P3b', 'B 班表上 B07 那天是例假 → 不補', { bSched: sched(SH, { B07: {} }) }],
  ['P3c', 'B 班表開始時間差超過 2 小時（12:00 才上的班、09:00 刷）→ 不補', { bSched: sched([{ id: 'X', name: '晚', start: '12:00', end: '21:00' }], { B07: { 19: 'X' } }) }],
  ['P4', 'A 讀 B 店名冊丟例外 → 不補', { hook: (m, v) => { if (v === 'A') { m.peers.SS_B.sh.roster.getDataRange = () => { throw new Error('讀取失敗'); }; } } }],
  ['P4b', 'A 讀班表丟例外 → 不補', { hook: (m, v) => { if (v === 'A') m.sb.capGraceSched_ = () => { throw new Error('讀取失敗'); }; } }],
].forEach(([id, label, extra]) => {
  const opt = Object.assign({}, GAP, extra);
  const nw = pair(Object.assign({}, opt, { capA: '3', capB: '3' })), bs = pair(Object.assign({}, opt, { capA: '1', capB: '1' }), SRC_BASE);
  check(id, label + '：A 頁、A 卡跟 38d0340 一樣', [page(nw.A), nw.A.self.sh.events.values.filter(isSys).length], [page(bs.A), bs.A.self.sh.events.values.filter(isSys).length]);
});

console.log('\n════ 三、兩店開關不同步 ════');
{
  const W = pair(Object.assign({ capA: '1', capB: '3' }, GAP)), O = pair(Object.assign({ capA: '1', capB: '1' }, GAP), SRC_BASE);
  check('P5', "A '1'（那段在 A＝寫卡的店關著）、B '3' → 跟 38d0340 一樣（不會更糟）", [settle(W), cards(W)], [settle(O), cards(O)]);
}
{
  const W = pair(Object.assign({ capA: '3', capB: '1' }, GAP));
  check('P6★', "A '3'（寫卡的店開著）、B '1' → A 寫 19:00、兩頁都鎖 19:00", [settle(W), cards(W)], [['LOCK19:00', 'LOCK19:00'], ['A19:00']]);
}
{
  // 反過來的缺口：A 09:00 上班沒打下班、17:30 到 B 上班（寫卡的是 B）
  const RGAP = { aEv: [[D + 'T09:00:00', 'E01', 'in']], bEv: [[D + 'T17:30:00', 'B07', 'in']], aSched: SA918 };
  const W1 = pair(Object.assign({ capA: '3', capB: '1' }, RGAP)), O1 = pair(Object.assign({ capA: '1', capB: '1' }, RGAP), SRC_BASE);
  const W2 = pair(Object.assign({ capA: '1', capB: '3' }, RGAP));
  check('P5b', "反向（那段在 B）：B 關、A 開 → 跟 38d0340 一樣；B 開、A 關 → B 寫 19:00、兩頁鎖", [settle(W1), cards(W1), settle(W2), cards(W2)], [settle(O1), cards(O1), ['LOCK19:00', 'LOCK19:00'], ['B19:00']]);
}

console.log('\n════ 四、跟 #232（\'2\'）同時開（\'4\'）════');
{
  // 單店者（只在 A 名冊，B 名冊只有別人）：'4' 跟 '2' 一樣給寬限
  const aSpec = { roster: [ME], events: [[D + 'T08:55:00', 'E01', 'in']] };
  const mk = (cap) => {
    const m = make({ now: T(D + 'T19:05:00'), props: { REQ_BIND_FROM: 'off', REST_CAP_ON: cap }, self: aSpec, peers: { SS_B: { roster: [{ emp_id: 'X9', name: '別人', key: 'KX', device_id: 'DX', active: 'TRUE' }] } } });
    m.run(CAP_SRC); m.sb.REST_PEERS_ = [{ code: 'mzt', ss: 'SS_B' }, { code: 'gf', ss: 'SELF' }];
    const sh = m.self.insertSheet('sched_pub'); sh.appendRow(SP_HEAD); sh.appendRow(['', 'T01', 1, JSON.stringify(SA918), 'op', '']);
    return page(m);
  };
  check('P7', "單店者：'4' 跟 '2' 一樣給寬限（grace 19:00）；'3' 跟 '1' 一樣照舊", [mk('4'), mk('2'), mk('3'), mk('1')], ['grace19:00', 'grace19:00', 'LOCK19:00', 'LOCK19:00']);
  const W = pair(Object.assign({ capA: '4', capB: '4' }, GAP));
  check('P7b', "多店者（缺口情境）：'4' 照跨店補時收卡、不給寬限", [settle(W), cards(W)], [['LOCK19:00', 'LOCK19:00'], ['A19:00']]);
}

console.log('\n════ 五、開關沒開（\'1\'、\'2\'、其他值）跟 ddd0cd0 逐步相同 ════');
{
  let seed = 20261124; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pk = (xs) => xs[Math.floor(rnd() * xs.length)];
  let same = 0; const bad = [];
  for (let k = 0; k < 120; k++) {
    const caps = pk([['1', '1'], ['2', '2'], ['1', '2'], ['0', undefined], ['5', '1']]);
    const opt = Object.assign({ capA: caps[0], capB: caps[1] }, pk([GAP, { bEv: [[D + 'T09:00:00', 'B07', 'in']], bSched: SB918 }, { aEv: [[D + 'T08:55:00', 'E01', 'in']], aSched: SA918, bSched: SB918 }]));
    const N = pair(opt), O = pair(opt, SRC_232);
    let t = T(D + 'T18:5' + Math.floor(rnd() * 9) + ':00'), diff = null;
    for (let i = 0, n = 2 + Math.floor(rnd() * 5); i < n && !diff; i++) {
      const o = pk(OPS); setNow(N, t); setNow(O, t);
      const rn = op(N, o), ro = op(O, o);
      if (rn !== ro || JSON.stringify([N.A.self.sh.events.values, N.B.self.sh.events.values]) !== JSON.stringify([O.A.self.sh.events.values, O.B.self.sh.events.values])) diff = [k, caps, o];
      t += (1 + Math.floor(rnd() * 40)) * 60000;
    }
    if (diff) bad.push(diff); else same++;
  }
  check('P8', "開關 '1'／'2'／'0'／沒設／'5' 的兩店隨機 120 串：每一步回應與兩店打卡列都跟 ddd0cd0（#232）一樣", [same, bad.slice(0, 2)], [120, []]);
}

console.log('\n════ 六、兩店同步隨機：不變量 ════');
{
  /* （同名兩人 twin：規則是「分不出工號＝不補＝維持現狀」，而且 38d0340 依姓名合併跨店卡、兩店看到的卡本來就不同 → ②④⑤不適用，只驗①③。）
   * 隨機：兩店開關（含不同步）、B／A 的孤單上班卡、兩段班、跨夜、已核准請假、同名、名冊／班表／打卡列讀取隨機失敗、12 種動作。
   * 不變量：①系統卡（E01＋B07）任何時刻 ≤ 1 張；②兩店都開、這一步沒有讀取失敗時，兩店用補過的算法算出同一個數字（今日出勤、滿 10 時刻、何時會滿）；
   *         ③收斂後有卡＝兩頁都鎖、時間是那張卡；④收斂後頁面說鎖、卻沒有卡 → 只允許在「那段所在的店開關沒開」（＝38d0340 原本就有的缺口）；
   *         ⑤兩店都開、收斂後兩頁一致。 */
  let seed = 424242; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pk = (xs) => xs[Math.floor(rnd() * xs.length)], ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const hm = (min) => ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
  const bad = []; let n = 0, eqChecked = 0, fails = 0;
  for (let k = 0; k < 500; k++) {
    const caps = pk([['3', '3'], ['4', '4'], ['3', '4'], ['3', '1'], ['1', '3'], ['4', '2'], ['2', '3']]);
    const shape = pk(['gapB', 'gapA', 'two', 'night', 'leave', 'twin', 'none']);
    const inB = ri(7, 11) * 60, inA = inB + ri(4, 9) * 60 + pk([0, 15, 30]);
    const opt = { capA: caps[0], capB: caps[1], now: D + 'T' + hm(Math.min(inA + 60, 23 * 60)) + ':00' };
    const sidB = pk(['A', 'S', 'L', 'X']), sidA = pk(['A', 'S', 'L', 'X']);
    opt.bSched = sidB === 'X' ? null : sched(SH, { B07: { 19: sidB }, B08: { 19: 'A' } });
    opt.aSched = sidA === 'X' ? null : sched(SH, { E01: { 19: sidA } });
    if (shape === 'gapB' || shape === 'twin' || shape === 'leave') { opt.bEv = [[D + 'T' + hm(inB) + ':00', 'B07', 'in']]; opt.aEv = [[D + 'T' + hm(inA) + ':00', 'E01', 'in']]; }
    if (shape === 'gapA') { opt.aEv = [[D + 'T' + hm(inB) + ':00', 'E01', 'in']]; opt.bEv = [[D + 'T' + hm(inA) + ':00', 'B07', 'in']]; }
    if (shape === 'two') { opt.bEv = [[D + 'T09:00:00', 'B07', 'in'], [D + 'T13:00:00', 'B07', 'out']]; opt.aEv = [[D + 'T15:30:00', 'E01', 'in']]; opt.bSched = sched(SH, { B07: { 19: 'S' } }); }
    if (shape === 'night') { opt.bSched = sched(SH, { B07: { 18: 'N' } }); opt.bEv = [['2026-11-19T18:00:00', 'B07', 'in']]; opt.aEv = [[D + 'T03:00:00', 'E01', 'in']]; opt.now = D + 'T05:00:00'; }
    if (shape === 'leave') opt.reqsB = [[D, '07:00', '08:00', 1]];
    if (shape === 'twin') opt.bTwin = true;
    if (shape === 'none') { opt.aEv = [[D + 'T' + hm(inB) + ':00', 'E01', 'in']]; }
    // 讀取隨機失敗：m.__fail 為真時，讀別家店名冊／班表／打卡列丟例外
    opt.hook = (m) => {
      const peer = m.peers.SS_A || m.peers.SS_B;
      ['roster', 'events'].forEach((nm) => { const s = peer.sh[nm], g = s.getDataRange; s.getDataRange = function () { if (m.__fail === nm) throw new Error('隨機失敗'); return g.apply(this, arguments); }; });
      const gs = m.sb.capGraceSched_; m.sb.capGraceSched_ = function () { if (m.__fail === 'sched') throw new Error('隨機失敗'); return gs.apply(this, arguments); };
      const c = m.sb.CacheService.getScriptCache();
      m.sb.CacheService = { getScriptCache: () => Object.assign({}, c, { get: (key) => (m.__fail === 'roster' && /^rpr:/.test(key) ? null : c.get(key)) }) };
    };
    const W = pair(opt);
    let t = T(opt.now), why = '';
    const steps = [];
    for (let i = 0, cnt = ri(2, 6); i < cnt && !why; i++) {
      const o = pk(OPS), fail = rnd() < 0.3 ? pk(['roster', 'events', 'sched']) : null;
      setNow(W, t); W.A.__fail = W.B.__fail = fail; if (fail) fails++;
      op(W, o); steps.push(o + (fail ? '!' + fail : '') + '@' + new Date(t + 8 * 3600000).toISOString().slice(11, 16));
      W.A.__fail = W.B.__fail = null;
      const c = cards(W).filter((x) => !/B08$/.test(x));
      if (c.length > 1) why = '①系統卡超過 1 張 ' + JSON.stringify(c);
      if (!why && /[34]/.test(caps[0]) && /[34]/.test(caps[1]) && !fail && shape !== 'twin') {
        const fa = judgeFill(W.A), fb = judgeFill(W.B); eqChecked++;
        if (fa.today !== fb.today || fa.due !== fb.due || fa.reach !== fb.reach || fa.lock !== fb.lock) why = '②兩店算出不同的數字 A=' + JSON.stringify(fa) + ' B=' + JSON.stringify(fb);
      }
      t += ri(1, 40) * 60000;
    }
    if (!why) {
      setNow(W, t);
      const pg = settle(W), c = cards(W).filter((x) => !/B08$/.test(x));
      const has = (hmv) => c.some((x) => x.slice(1) === hmv);
      [['A', pg[0]], ['B', pg[1]]].forEach(([v, p]) => {
        if (why || !p.startsWith('LOCK') || has(p.slice(4))) return;
        // 鎖但沒有卡：那一頁看到的正在上班那段在別家店，而且那家店開關沒開（38d0340 原本就有）才允許
        const m = v === 'A' ? W.A : W.B, sb = m.sb, ss = sb.getSS(), who = sb.readSheetAsObjects(ss.getSheetByName('roster')).rows.filter((r) => r.line_user_id === 'U1')[0];
        const r = sb.capJudge_(sb.capEventsFor_(ss, who, t, null), t, sb.capMakeFill_(who.emp_id), sb.capBreak_(), sb.capLeavesFor_(ss, who, t));
        const ownerCap = v === 'A' ? caps[1] : caps[0];
        if (shape !== 'twin' && !(r.due && r.due.store && !/[34]/.test(ownerCap))) why = '④' + v + ' 頁鎖 ' + p + ' 卻沒有卡（那段的店開關 ' + ownerCap + '）';
      });
      if (!why && c.length === 1 && !(pg[0] === 'LOCK' + c[0].slice(1) && pg[1] === 'LOCK' + c[0].slice(1))) why = '③有卡 ' + c[0] + ' 但頁面 ' + JSON.stringify(pg);
      if (!why && shape !== 'twin' && /[34]/.test(caps[0]) && /[34]/.test(caps[1]) && pg[0].replace(/^grace.*/, 'free') !== pg[1].replace(/^grace.*/, 'free')) why = '⑤兩店都開、收斂後兩頁不同 ' + JSON.stringify(pg);
    }
    n++;
    if (why) bad.push([k, caps.join('/'), shape, steps.join(' '), why]);
  }
  console.log('  隨機 ' + n + ' 組、讀取失敗 ' + fails + ' 次、比對兩店數字 ' + eqChecked + ' 次');
  bad.slice(0, 4).forEach((x) => console.log('  ✗ #' + x[0] + ' ' + x[1] + ' ' + x[2] + ' ' + x[3] + ' → ' + x[4]));
  check('P9', '兩店同步隨機 500 組：不變量①～⑤違反 0', bad.length, 0);
}

console.log('\n════ 七、cap_set 的 fill ════');
{
  const m = world('A', { capA: '1' });
  const trig = [];
  m.sb.ScriptApp = { getProjectTriggers: () => trig.slice(), deleteTrigger: (x) => { trig.splice(trig.indexOf(x), 1); },
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { trig.push({ getHandlerFunction: () => fn }); } }) }) }) };
  const q = (b) => m.sb.handleCapSet_(Object.assign({ admin_key: 'ADM' }, b));
  check('P10', "fill:true → '3'；再 grace:true → '4'；grace:false → '3'；fill:false → '1'；on:true＋grace＋fill → '4'；沒帶 fill 鍵不回 fill",
    [q({ fill: true }).fill, m.props.REST_CAP_ON, q({ grace: true }).grace, m.props.REST_CAP_ON, q({ grace: false }).grace, m.props.REST_CAP_ON, q({ fill: false }).fill, m.props.REST_CAP_ON,
      q({ on: true, grace: true, fill: true }), m.props.REST_CAP_ON, q({})],
    [true, '3', true, '4', false, '3', false, '1', { ok: true, on: true, trigger: 1, grace: true, fill: true }, '4', { ok: true, on: true, trigger: 1 }]);
}

done();
