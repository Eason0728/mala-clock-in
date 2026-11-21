/**
 * 獨立複審 2026-11-21 第 10、11 項（dzy-mini-playbook handoff/review-20261121.md L3、L4）。
 *
 * 第 10 項：relay_pull 的 props 帶 Google「實際採用」的 DUTY_VER_STRICT，讓 mini 核定引擎（快速通道 duty-worker 沙盒跑同一份
 *   DutyFeed.gs／Code.gs，屬性只看 props）跟 Google 判斷一致。
 *   - 開（DUTY_VER_STRICT 是開的值，或 DUTY_AUTH＝mini／on）→ props.DUTY_VER_STRICT＝'1'；關 → 不帶這個鍵。
 *   - 不帶 DUTY_AUTH 本身（引擎看到 mini 會自己回 moved_to_mini）。
 *   - 兩個屬性都沒設：回應跟改版前的 main 逐字相同（子程序各跑一次比 JSON）。
 * 第 11 項：05:00 recheckPendingApprovalStatuses **沒有改**（薪資全勤會讀它改的 status_text，mini 模式停掉要 Eason 定）。
 *   這裡只把現況釘住：mini 模式照樣寫、只追加一列、時數與時段照抄，只換 status_text／manager_name／entered_at；跟沒設時寫的一模一樣。
 * 全部虛構同仁；金鑰都是測試沙盒的假值。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { make, T, R, check, done } = require('./helpers/gs-sandbox');
const J = (x) => JSON.parse(JSON.stringify(x));
const REPO = path.join(__dirname, '..');
const KEY = 'relay-key-for-tests-0123456789';
const ME = { emp_id: 'E01', name: '代號甲', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const EV = [['2026-11-09T09:00:00', 'E01', 'in'], ['2026-11-09T17:00:00', 'E01', 'out']];
const ALL = { roster: true, props: true, sheets: true, rows: true, fp: true };

function world(props, approved) {
  const m = make({ now: T('2026-11-10T05:00:00'), props: Object.assign({ REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, props || {}),
    self: { roster: [ME], events: EV, approved: approved || [] } });
  m.run(R('apps-script/RelayG.gs'));
  m.post = (body) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return m;
}
const pull = (m, w) => J(m.sb.handleRelayPull_({ relay_key: KEY, with: w || ALL }));

// ── 子程序：拿某一版 apps-script（GS_ROOT）跑同一組 relay_pull，回 JSON（兩個屬性都沒設的各種情況） ──
function corpus() {
  const out = [];
  const cases = [
    ['全空', {}],
    ['只有 REST_*', { REST_RULE_ON: '1', REST_CAP_ON: '0', REST_OT_ON: 'yes' }],
    ['其他 DUTY_* 有設', { DUTY_PUSH_KEY: 'x'.repeat(40), DUTY_PUSH_STORE: 'mztjs', G_LOCK_ROWS: '1' }],
  ];
  cases.forEach(([nm, props]) => {
    [ALL, { props: true }, { roster: true }, {}].forEach((w, i) => {
      const m = world(props);
      out.push([nm + '|with#' + i, pull(m, w), J(m.props)]);
    });
  });
  out.push(['金鑰錯', J(world({}).sb.handleRelayPull_({ relay_key: 'x', with: ALL })), null]);
  return out;
}
if (process.env.RVS_CHILD === '1') { process.stdout.write('\n@@RVS@@' + JSON.stringify(corpus())); process.exit(0); }

console.log('══ 一、props.DUTY_VER_STRICT 跟 Google 自己的判斷（dutyAuthCfg_().strict）一致 ══');
const VS = [undefined, '', '1', 'on', 'yes', 'true', ' ON ', '0', 'off', 'false', 'no', ' OFF '];
const AU = [undefined, '', 'google', 'shadow', 'off', 'mini', 'on', ' MINI ', 'xyz'];
let n = 0, bad = [];
VS.forEach((vs) => AU.forEach((au) => {
  const props = {};
  if (vs !== undefined) props.DUTY_VER_STRICT = vs;
  if (au !== undefined) props.DUTY_AUTH = au;
  const m = world(props);
  const r = pull(m, { props: true });
  const g = m.sb.dutyAuthCfg_().strict;
  const has = Object.prototype.hasOwnProperty.call(r.props, 'DUTY_VER_STRICT');
  n++;
  if (has !== g || (has && r.props.DUTY_VER_STRICT !== '1') || 'DUTY_AUTH' in r.props) bad.push([vs, au, r.props, g]);
}));
check('VS1', VS.length + '×' + AU.length + ' 種組合：開＝帶 \'1\'、關＝不帶，跟 Google 判斷相同；DUTY_AUTH 一律不帶', [n, bad], [VS.length * AU.length, []]);
{
  const r = pull(world({ DUTY_VER_STRICT: '1', DUTY_AUTH: 'mini', DUTY_PUSH_KEY: 'k'.repeat(40), RELAY_KEY: KEY }), { props: true });
  check('VS2', '只多 DUTY_VER_STRICT 一個鍵，不帶金鑰、DUTY_AUTH', Object.keys(r.props).sort(), ['DUTY_VER_STRICT']);
  check('VS3', '沒要 props（with 不含 props）＝不帶', 'props' in pull(world({ DUTY_VER_STRICT: '1' }), { roster: true }), false);
  check('VS4', 'mini 模式、DUTY_VER_STRICT 明寫 0 → 仍帶 \'1\'（Google mini 一律當開）', pull(world({ DUTY_VER_STRICT: '0', DUTY_AUTH: 'mini' }), { props: true }).props, { DUTY_VER_STRICT: '1' });
  check('VS5', 'REST_* 照舊一起帶', pull(world({ REST_RULE_ON: '1', DUTY_VER_STRICT: 'on' }), { props: true }).props, { REST_RULE_ON: '1', DUTY_VER_STRICT: '1' });
}

console.log('\n══ 二、引擎（只拿 props 的沙盒）跟 Google 對「版本讀不到」判得一樣 ══');
// 引擎＝快速通道 duty-worker：同一份程式，指令碼屬性＝relay_pull 回的 props（engine.js replaceData）。讓「讀版本」失敗，看兩邊回什麼。
function verUnknownOf(props) {
  const m = make({ now: T('2026-11-10T10:00:00'), props: Object.assign({ REQ_BIND_FROM: 'off' }, props), self: { roster: [ME], events: EV } });
  m.run('handleMgrDay = function () { return { ok: false, error: "read_failed" }; };');   // 讀不到版本
  const r = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_approve', mgr_key: 'MK', date: '2026-11-09', emp_id: 'E01',
    periods: [{ start: '09:00', end: '17:00' }], base_ver: 'v-from-copy' }) } }).text);
  return { err: r.error || (r.ok ? 'ok' : ''), mini: m.sb.dutyAuthCfg_().mini, written: m.approved().length };
}
for (const vs of [undefined, '1', 'off']) {
  const gp = vs === undefined ? {} : { DUTY_VER_STRICT: vs };
  const g = verUnknownOf(gp);
  const e = verUnknownOf(pull(world(gp), { props: true }).props);
  check('EG1[' + JSON.stringify(vs) + ']', 'Google 回什麼、引擎就回什麼（strict 開＝兩邊都 ver_unknown、都沒寫）', [e.err, e.written], [g.err, g.written]);
}
{
  const g = world({ DUTY_AUTH: 'mini' }).sb.dutyAuthCfg_();
  const ep = pull(world({ DUTY_AUTH: 'mini' }), { props: true }).props;
  const e = verUnknownOf(ep);
  check('EG2', 'Google mini 模式（strict 當開）→ 引擎也 strict：版本讀不到回 ver_unknown、不寫；而且引擎不是 mini（不會自己回 moved_to_mini）',
    [g.strict, e.err, e.written, e.mini], [true, 'ver_unknown', 0, false]);
  // 對照組：用 main 的寫法（props 不帶 DUTY_VER_STRICT）引擎會放行——證明上面那條真的有測到差別
  const old = verUnknownOf({});
  check('EG3', '對照：props 沒帶時引擎放行（不是 ver_unknown）＝改之前的不一致', old.err !== 'ver_unknown', true);
}

console.log('\n══ 三、兩個屬性都沒設：跟改版前的 main 逐字相同 ══');
const BASE = process.env.RVS_BASE || 'ef6e05f';   // 改版前的 main（origin/main，PR #203 合併點）
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-base-'));
try {
  execFileSync('tar', ['-x', '-C', base], { input: execFileSync('git', ['-C', REPO, 'archive', BASE, 'apps-script'], { maxBuffer: 64 << 20 }) });
  const run = (root) => {
    const s = execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { GS_ROOT: root, RVS_CHILD: '1' }), encoding: 'utf8', maxBuffer: 64 << 20 });
    return JSON.parse(s.slice(s.indexOf('\n@@RVS@@') + 8));
  };
  const a = run(base), b = run(REPO);
  check('BS0', 'main 版確實沒有這個函式（比對對象沒拿錯）', fs.readFileSync(path.join(base, 'apps-script', 'RelayG.gs'), 'utf8').indexOf('relayGVerStrictOut_') < 0, true);
  a.forEach((x, i) => { const same = JSON.stringify(b[i]) === JSON.stringify(x); check('BS' + String(i + 1).padStart(2, '0'), x[0] + '：回應與屬性逐字相同（' + JSON.stringify(x).length + ' 字）', same ? '相同' : JSON.stringify(b[i]), '相同'); });
  check('BS90', '情境數相同', b.length, a.length);
} finally { fs.rmSync(base, { recursive: true, force: true }); }

console.log('\n══ 四、第 11 項現況（沒改）：05:00 重算在 mini 模式照樣寫，寫法跟沒設時一模一樣 ══');
const AP0 = ['2026-11-09', 'E01', '代號甲', '09:00-17:00', 8, '下班忘刷卡', '值班主管', '2026-11-09T16:00:00+08:00', '', '主管填的原因'];
function recheck(auth) {
  const m = world(auth === undefined ? {} : { DUTY_AUTH: auth }, [AP0]);
  const r = J(m.sb.recheckPendingApprovalStatuses());
  return { r, rows: J(m.approved()) };
}
const r0 = recheck(undefined), rm = recheck('mini');
check('RC1', '沒設：補一列（下班忘刷卡 → 正常）', [r0.r.fixed, r0.rows.length, r0.rows[1][5]], [1, 2, '正常']);
const head = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason'];
const changed = head.filter((h, i) => JSON.stringify(r0.rows[1][i]) !== JSON.stringify(AP0[i]));
check('RC2', '新列跟原列只差 status_text、manager_name（加「（系統重算）」）、entered_at；時數、時段、差異原因照抄', changed, ['status_text', 'manager_name', 'entered_at']);
check('RC3', 'DUTY_AUTH＝mini：重算照樣寫、內容跟沒設時一模一樣（這支排程不看 DUTY_AUTH，本 PR 沒改）', rm, r0);
done();
