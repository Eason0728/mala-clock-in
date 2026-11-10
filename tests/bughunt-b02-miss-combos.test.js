/* B02（2026-11-10 挑錯）：2026-11-06 起「少幾張卡就要幾張已核准的忘打卡單」才能核定，
 * 但同一天同一種忘打卡單只能有一張（「整段」還會擋掉其他所有忘打卡單），而且申請頁只看真的打卡、
 * 不看已經送出的申請。兩段班一天四張卡的 16 種漏卡組合裡，有 6 種照實補單補不齊（例：四張都沒打，
 * 要 4 張、只開得出 1 張整段＝2 張），那一天永遠核不下去。
 * 修正：算「那天還缺哪張卡」時，把這個人已送出（審核中或已核准）的忘打卡申請當成已經補上的卡。
 * 用真函式跑：同仁照實補單 → 主管核准每一張 → 主管核定兩段，16 種組合都要送得出去。名字一律假名。 */
'use strict';
const { make, T, check, show, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const D = '2026-11-08';
const CARDS = [['in1', '10:00', 'in'], ['out1', '14:00', 'out'], ['in2', '17:00', 'in'], ['out2', '21:00', 'out']];
const PERIODS = [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }];
const LABEL = { in1: '第一段上班', out1: '第一段下班', in2: '第二段上班', out2: '第二段下班' };

/** 同仁照實要補的申請（單張的先、整段、中間休息）；covered＝真的有打或已經送出申請的卡 */
function candidates(covered) {
  const has = (k) => covered.indexOf(k) !== -1, c = [];
  if (!has('in1') && has('out1')) c.push({ cover: ['in1'], body: { miss_type: 'in', start: '10:00' } });
  if (!has('out1') && has('in1')) c.push({ cover: ['out1'], body: { miss_type: 'out', end: '14:00' } });
  if (!has('in2') && has('out2')) c.push({ cover: ['in2'], body: { miss_type: 'in', start: '17:00' } });
  if (!has('out2') && has('in2')) c.push({ cover: ['out2'], body: { miss_type: 'out', end: '21:00' } });
  if (!has('in1') && !has('out1')) c.push({ cover: ['in1', 'out1'], body: { miss_type: 'both', start: '10:00', end: '14:00' } });
  if (!has('in2') && !has('out2')) c.push({ cover: ['in2', 'out2'], body: { miss_type: 'both', start: '17:00', end: '21:00' } });
  if (!has('out1') && !has('in2') && has('in1') && has('out2')) c.push({ cover: ['out1', 'in2'], body: { miss_type: 'break', end: '14:00', start: '17:00' } });
  return c;
}
function world(present) {
  return make({ now: T('2026-11-10T10:00:00'), self: { roster: [ME], events: CARDS.filter((c) => present.indexOf(c[0]) !== -1).map((c) => [D + 'T' + c[1] + ':00', 'E01', c[2]]) } });
}
const submit = (m, body) => m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', kind: 'miss', date: D, reason: '忘記了' }, body));

/** 一種組合跑到底：回 { 送出的申請, 核定結果 } */
function run(present) {
  const m = world(present), sb = m.sb;
  let covered = present.slice(); const sent = [], ids = [];
  for (let round = 0; round < 6; round++) {
    let progressed = false;
    candidates(covered).forEach((c) => {
      if (c.cover.some((k) => covered.indexOf(k) !== -1)) return;   // 這一輪前面已經補到了
      const r = submit(m, c.body);
      if (r.ok) { covered = covered.concat(c.cover); sent.push(c.body.miss_type + (c.body.start ? ' ' + c.body.start : '') + (c.body.end ? '–' + c.body.end : '')); ids.push(r.request.id); progressed = true; }
    });
    if (!progressed) break;
  }
  ids.forEach((id) => sb.handleMgrReqDecide_({ mgr_key: 'MK', id: id, decision: 'approve' }));
  const ap = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: PERIODS });
  return { 補得到的卡: covered.length, 送出的申請: sent, 核定: ap.ok ? 'ok' : ap.error + '：' + String(ap.message || '').replace(/^這天還不能核定：/, '').slice(0, 30) };
}

console.log('════ 一、兩段班（10:00–14:00、17:00–21:00）四張卡的 16 種組合：照實補單、主管核准後，核定都要送得出 ════');
const bad = [];
for (let mask = 0; mask < 16; mask++) {
  const present = CARDS.filter((c, i) => mask & (1 << i)).map((c) => c[0]);
  const missing = CARDS.filter((c) => present.indexOf(c[0]) === -1).map((c) => LABEL[c[0]]);
  const r = run(present);
  const okk = r.核定 === 'ok' && r.補得到的卡 === 4;
  if (!okk) bad.push(missing.join('、') || '（都有打）');
  show('B02-c' + ('0' + mask).slice(-2), '漏：' + (missing.join('、') || '（都有打）'), r);
}
check('B02-01', '16 種組合全部補得齊、核得下去（列出不行的）', bad, []);

console.log('\n════ 二、不該因此開出重複或多餘的單 ════');
{
  // 四張都沒打：第一張整段送出後
  const m = world([]);
  const a = submit(m, { miss_type: 'both', start: '10:00', end: '14:00' });
  const same = submit(m, { miss_type: 'both', start: '10:00', end: '14:00' });
  const overlap = submit(m, { miss_type: 'both', start: '13:00', end: '18:00' });
  const second = submit(m, { miss_type: 'both', start: '17:00', end: '21:00' });
  const third = submit(m, { miss_type: 'both', start: '22:00', end: '23:00' });
  check('B02-10', '四張都沒打：第一張整段收', a.ok, true);
  check('B02-11', '一模一樣再送一次 → 擋', same.ok, false);
  check('B02-12', '和第一張時間重疊的整段 → 擋', overlap.ok, false);
  check('B02-13', '另一段（17:00–21:00）的整段 → 收', second.ok, true);
  show('B02-14', '第三張整段（22:00–23:00，主管沒核這一段）', { ok: third.ok, error: third.error });
}
{
  // 只打了上班卡 10:00：補下班 14:00 之後，同一張卡不能再補一次
  const m = world(['in1']);
  const a = submit(m, { miss_type: 'out', end: '14:00' });
  const again = submit(m, { miss_type: 'out', end: '14:30' });
  check('B02-20', '只打第一段上班：補下班 14:00 收', a.ok, true);
  check('B02-21', '同一張下班卡換個時間再補一次 → 擋（要改請先取消）', [again.ok, again.error], [false, 'duplicate']);
  const cancel = m.sb.handleReqCancel_ ? m.sb.handleReqCancel_({ id_token: 'TOK_U1', id: a.request.id }) : { ok: false, error: 'no_cancel' };
  const after = submit(m, { miss_type: 'out', end: '14:30' });
  check('B02-22', '取消第一張之後，可以重新補 14:30', [cancel.ok, after.ok], [true, true]);
}
{
  // 兩張上班卡都漏（只有 14:00、21:00 兩張下班卡）：兩張上班卡各補一張，順序不拘
  const m1 = world(['out1', 'out2']);
  const x1 = submit(m1, { miss_type: 'in', start: '17:00' }), x2 = submit(m1, { miss_type: 'in', start: '10:00' });
  check('B02-30', '兩張上班卡都漏：先補第二段 17:00、再補第一段 10:00 都收', [x1.ok, x2.ok], [true, true]);
  const x3 = submit(m1, { miss_type: 'in', start: '09:00' });
  check('B02-31', '兩張都補了，再補第三張上班卡 → 擋', x3.ok, false);
  // 補的上班時間比它要配的那張下班卡還晚 → 擋
  const m2 = world(['out1', 'out2']);
  const y = submit(m2, { miss_type: 'in', start: '21:30' });
  check('B02-32', '補的上班時間 21:30 比所有下班卡都晚 → 擋', [y.ok, y.error], [false, 'bad_time']);
}
{
  // 兩張下班卡都漏（只有 10:00、17:00 兩張上班卡）
  const m = world(['in1', 'in2']);
  const x1 = submit(m, { miss_type: 'out', end: '14:00' }), x2 = submit(m, { miss_type: 'out', end: '21:00' });
  check('B02-40', '兩張下班卡都漏：補 14:00、再補 21:00 都收', [x1.ok, x2.ok], [true, true]);
  const z = submit(world(['in1', 'in2']), { miss_type: 'out', end: '09:00' });
  check('B02-41', '補的下班時間 09:00 比所有上班卡都早 → 擋', [z.ok, z.error], [false, 'bad_time']);
}
{
  // 一段班、卡都齊：照舊不用補
  const m = make({ now: T('2026-11-10T10:00:00'), self: { roster: [ME], events: [[D + 'T10:00:00', 'E01', 'in'], [D + 'T18:00:00', 'E01', 'out']] } });
  const r = submit(m, { miss_type: 'in', start: '09:00' });
  check('B02-50', '卡都齊的日子補上班卡 → 擋（not_missing）', [r.ok, r.error], [false, 'not_missing']);
}

console.log('\n════ 三、申請頁查「那天還缺哪張卡」時，已送出的申請算已經補上 ════');
{
  const m = world([]), sb = m.sb;
  const day = () => sb.handleReqInfo_({ id_token: 'TOK_U1', date: D, day_only: true, apply_miss: true }).day.missing.options;
  const before = day();
  submit(m, { miss_type: 'both', start: '10:00', end: '14:00' });
  const mid = day();
  submit(m, { miss_type: 'both', start: '17:00', end: '21:00' });
  check('B02-60', '四張都沒打：一開始只能選整段', before, ['both']);
  check('B02-61', '送出第一張整段後，還能選「另一段整段」', mid.indexOf('both') !== -1, true);
  const info = sb.handleReqInfo_({ id_token: 'TOK_U1', date: D, day_only: true, apply_miss: true }).day;
  check('B02-62', '畫面上的「當天紀錄」仍只列真的打卡（申請不算打卡）', info.punches.length, 0);
}
{
  // 只打了第一段上班卡：補了下班之後，申請頁要看得到「另一段整段」；沒帶 apply_miss 的舊頁面照舊只看真的卡
  const m = world(['in1']), sb = m.sb;
  const opts = (extra) => sb.handleReqInfo_(Object.assign({ id_token: 'TOK_U1', date: D, day_only: true }, extra || {})).day.missing.options;
  check('B02-63', '只打第一段上班：一開始可補下班卡、中間休息', opts({ apply_miss: true }), ['out', 'break']);
  submit(m, { miss_type: 'out', end: '14:00' });
  check('B02-64', '補了下班 14:00 之後：下班卡不用再補，改成可補中間休息、另一段整段', opts({ apply_miss: true }), ['break', 'both']);
  check('B02-65', '沒帶 apply_miss（舊頁面）：照舊只看真的打卡', opts(), ['out', 'break']);
  const full = sb.handleReqInfo_({ id_token: 'TOK_U1', date: D }).day;
  check('B02-66', '完整查詢（不是 day_only）也把申請算進去；真的卡那一段不帶 virtual 欄', [full.missing.options, JSON.parse(JSON.stringify(full.missing.spans))], [['break', 'both'], [{ in: '10:00', out: '14:00', out_next: false }]]);
}
done();
