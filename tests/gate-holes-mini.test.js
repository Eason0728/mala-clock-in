/**
 * 店切 mini 核定後，管理金鑰的兩個「改核定結果」工具不在 Google 直接套用（2026-11-21 補洞 gate-holes，比照 #204 bind_revoke／ft8_revoke）：
 *  - final_orphan_scan（舊資料清理：把那天的 approved／leave 搬到留底分頁）apply:true
 *  - backfill_missing_groups（少刷回填：在 approved 補一列改狀態字）apply:true
 * 規則（保護性檢查，Requests.gs reqMiniApplyBlock_）：
 *  - DUTY_AUTH＝mini／on：套用回 moved_to_mini，一列都不動；只預覽照常。
 *  - DUTY_AUTH 填了認不得的值、讀不到屬性：套用回 auth_unknown；只預覽照常。
 *  - 沒設／空／google／off／shadow：跟改版前的 main 逐字相同（回應＋approved、leave、兩張留底分頁、requests、events、roster）。
 * 第四段同時證明「刻意不擋」的入口（recheck_approvals、approve_device、mgr_device_decision、mgr_req_proxy、req_attach）連 mini 模式都跟 main 逐字相同。
 * 全部虛構同仁；金鑰都是測試沙盒的假值。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const H = require('./helpers/gs-sandbox');
const { make, T, check, done, ROOT } = H;
const J = (x) => JSON.parse(JSON.stringify(x));

const ROSTER = [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true', line_user_id: 'U1', device_id: 'D1' },
                { emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true', line_user_id: '' }];
const AP = (date, emp, name, per, h, st) => [date, emp, name, per || '10:00-18:00', h || 8, st || '正常', '值班主管', date + 'T20:00:00+08:00', '', ''];
// 舊資料清理：11/04 有核定＋假別、那天的申請在核定之後作廢（voided）；11/05 只有假別沒有核定（orphan_leave）
// 少刷回填：11/03 兩段班只打了第一段上班、第二段下班（狀態還沒有「第…段」字樣）
// 系統重算：11/06 狀態「該段無打卡」、卡其實都在
// 新裝置：E01 在 11/07 用 D2 打的卡待核准
const EV = [['2026-11-03T11:02:00', 'E01', 'in'], ['2026-11-03T21:44:00', 'E01', 'out'],
            ['2026-11-04T10:00:00', 'E01', 'in'], ['2026-11-04T18:00:00', 'E01', 'out'],
            ['2026-11-06T10:00:00', 'E01', 'in'], ['2026-11-06T18:00:00', 'E01', 'out'],
            ['2026-11-07T10:00:00', 'E01', 'in', 'pending_device_approval', 'D2'], ['2026-11-07T18:00:00', 'E01', 'out', 'pending_device_approval', 'D2']];
const APR = [AP('2026-11-03', 'E01', '代號甲', '11:00-14:30,17:00-21:45', 8.25, '遲到2分、早退1分'),
             AP('2026-11-04', 'E01', '代號甲'),
             AP('2026-11-06', 'E01', '代號甲', '10:00-18:00', 8, '該段無打卡')];
const LV = [['2026-11-04', '代號甲', '事假', 2], ['2026-11-05', '代號甲', '事假', 8]];

function world(auth) {
  const props = { REQ_BIND_FROM: '2026-11-01', REQ_STRICT_FROM: '2026-11-08' };   // 撤銷（#204）也在語料裡：開綁單、11/8 起加嚴，才搬得到東西
  if (auth !== undefined) props.DUTY_AUTH = auth;
  const m = make({ now: T('2026-11-10T10:00:00'), props, self: { roster: ROSTER, events: EV, approved: APR, leave: LV } });
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  const add = (o) => { const r = Object.assign({ created_at: '2026-11-03T09:00:00+08:00', status: 'pending', hours: 2, emp_id: 'E01', name: '代號甲', kind: 'leave', leave_type: '事假' }, o); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); };
  add({ id: 'V1', date: '2026-11-04', status: 'voided', voided_at: '2026-11-05T10:00:00+08:00', voided_by: '值班主管' });
  add({ id: 'P1', date: '2026-11-12' });   // 審核中的請假（補附證明用）
  m.post = (body) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  m.leave = () => m.self.sh.leave.values.slice(1);
  m.tab = (nm) => (m.self.sh[nm] ? J(m.self.sh[nm].values) : null);
  return m;
}
const FO = (extra) => Object.assign({ action: 'final_orphan_scan', admin_key: 'ADM', from: '2026-11-01', to: '2026-11-09' }, extra || {});
const KEYS = ['2026-11-04|E01', '2026-11-05|E01'];
const BF = (extra) => Object.assign({ action: 'backfill_missing_groups', admin_key: 'ADM', from: '2026-11-01', to: '2026-11-09' }, extra || {});

function corpus(auths, fresh) {   // fresh＝每個請求各自一個新世界（mini 對照用：前一個請求被擋與否不影響後面）
  const out = [], sheets = {};
  const reqs = [
    ['清理預覽', FO()], ['清理套用', FO({ apply: true, keys: KEYS })], ['清理套用沒帶 keys', FO({ apply: true })], ['清理日期錯', FO({ apply: true, keys: KEYS, from: 'x' })],
    ['清理金鑰錯', FO({ apply: true, keys: KEYS, admin_key: 'WRONG' })], ['清理 apply 不是 true', FO({ apply: 'true', keys: KEYS })],
    ['回填預覽', BF()], ['回填套用', BF({ apply: true })], ['回填日期錯', BF({ apply: true, from: 'x' })], ['回填金鑰錯', BF({ apply: true, admin_key: 'WRONG' })],
    ['回填 apply 不是 true', BF({ apply: 1 })],
    ['撤銷預覽', { action: 'bind_revoke', admin_key: 'ADM', from: '2026-11-01', to: '2026-11-07' }],
    ['撤銷套用', { action: 'bind_revoke', admin_key: 'ADM', from: '2026-11-01', to: '2026-11-07', apply: true }],
    ['系統重算（手動）', { action: 'recheck_approvals', admin_key: 'ADM' }],
    ['主管核准新裝置', { action: 'mgr_device_decision', mgr_key: 'MK', emp_id: 'E01', device_id: 'D2', approve: true }],
    ['管理金鑰核准新裝置（已處理過）', { action: 'approve_device', admin_key: 'ADM', emp_id: 'E01', device_id: 'D2', approve: true }],
    ['主管代開', { action: 'mgr_req_proxy', mgr_key: 'AK', acting_name: '代號店長（D01）', emp_id: 'E02', kind: 'leave', leave_type: '事假', date: '2026-11-09', hours: 8, reason: '測試代開' }],
    ['補附證明', { action: 'req_attach', id_token: 'TOK_U1', id: 'P1', attach_id: 'att_0123456789' }],
  ];
  auths.forEach((auth) => {
    let m = world(auth);
    const tag = JSON.stringify(auth);
    reqs.forEach(([nm, body]) => {
      if (fresh) m = world(auth);
      const r = J(m.post(body));
      if (r.request) delete r.request.id;   // 代開單號含亂數序號以外的時間戳：兩版各跑一次會一樣，保險起見不比單號本身
      out.push([tag + '|' + nm, r]);
    });
    const tabs = {};
    ['approved', 'leave', 'approved_revoked', 'leave_revoked', 'events', 'roster'].forEach((k) => { tabs[k] = m.tab(k); });
    tabs.requests = m.sb.reqRows_(m.sb.getSS()).map((x) => [x.status, x.kind, x.date, x.emp_id, x.attach_id || '', x.proxy_by || '']);
    sheets[tag] = tabs;
  });
  return { out, sheets };
}
if (process.env.GATE_CHILD) { process.stdout.write(JSON.stringify(corpus(JSON.parse(process.env.GATE_CHILD).map((x) => (x === null ? undefined : x)), process.env.GATE_FRESH === '1'))); process.exit(0); }   // JSON 傳不了 undefined：null＝沒設

console.log('══ 一、DUTY_AUTH＝mini／on：套用擋、只預覽照常 ══');
for (const auth of ['mini', 'on', ' MINI ']) {
  const m = world(auth), ap0 = J(m.approved()), lv0 = J(m.leave());
  const pv = m.post(FO());
  check('GM1[' + auth + ']', '舊資料清理預覽照常列出兩天', [pv.ok, (pv.items || []).map((x) => x.key)], [true, KEYS]);
  const r = m.post(FO({ apply: true, keys: KEYS }));
  check('GM2[' + auth + ']', '舊資料清理套用 → moved_to_mini＋白話訊息；approved、leave 不動、沒有留底分頁',
    [r.ok, r.error, /mini/.test(r.message) && /舊資料清理/.test(r.message) && /切回 google/.test(r.message), J(m.approved()), J(m.leave()), m.tab('approved_revoked'), m.tab('leave_revoked')],
    [false, 'moved_to_mini', true, ap0, lv0, null, null]);
  const bp = m.post(BF());
  check('GM3[' + auth + ']', '少刷回填預覽照常抓到 11/03', [bp.ok, bp.applied, (bp.hits || []).map((x) => x.date)], [true, false, ['2026-11-03']]);
  const b = m.post(BF({ apply: true }));
  check('GM4[' + auth + ']', '少刷回填套用 → moved_to_mini；approved 不多一列', [b.ok, b.error, /少刷回填/.test(b.message), J(m.approved())], [false, 'moved_to_mini', true, ap0]);
}

console.log('\n══ 二、認不得的值、讀不到屬性：套用擋（保護性）══');
for (const auth of ['mni', 'disabled', '亂碼']) {
  const m = world(auth), ap0 = J(m.approved());
  check('GU1[' + auth + ']', '舊資料清理預覽照常', (m.post(FO()).items || []).length, 2);
  const r = m.post(FO({ apply: true, keys: KEYS }));
  check('GU2[' + auth + ']', '舊資料清理套用 → auth_unknown、approved 不動', [r.ok, r.error, /auth_cfg/.test(r.message), J(m.approved()), J(m.leave()).length], [false, 'auth_unknown', true, ap0, 2]);
  check('GU3[' + auth + ']', '少刷回填預覽照常', m.post(BF()).fixed, 1);
  const b = m.post(BF({ apply: true }));
  check('GU4[' + auth + ']', '少刷回填套用 → auth_unknown、approved 不動', [b.ok, b.error, J(m.approved())], [false, 'auth_unknown', ap0]);
}
{
  const m = world(), ap0 = J(m.approved());
  const sp = m.sb.PropertiesService.getScriptProperties;
  m.sb.PropertiesService.getScriptProperties = () => Object.assign(sp(), { getProperties: () => { throw new Error('屬性服務暫時讀不到'); } });
  const r = m.post(FO({ apply: true, keys: KEYS }));
  check('GU5', '讀不到指令碼屬性：舊資料清理套用 → auth_unknown、approved 不動', [r.ok, r.error, J(m.approved())], [false, 'auth_unknown', ap0]);
  const b = m.post(BF({ apply: true }));
  check('GU6', '讀不到指令碼屬性：少刷回填套用 → auth_unknown、approved 不動', [b.ok, b.error, J(m.approved())], [false, 'auth_unknown', ap0]);
}
{
  const m = world('mini');
  check('GU7', '管理金鑰錯：照舊先回 unauthorized（不洩漏核定模式）', [m.post(FO({ apply: true, keys: KEYS, admin_key: 'WRONG' })).error, m.post(BF({ apply: true, admin_key: 'WRONG' })).error], ['unauthorized', 'unauthorized']);
  check('GU8', 'mini 模式 apply 不是布林 true＝當預覽（跟 main 一樣只認 === true）', [m.post(FO({ apply: 'true', keys: KEYS })).apply, m.post(BF({ apply: 1 })).applied], [false, false]);
}

console.log('\n══ 三、沒設／google 類：照常套用 ══');
for (const auth of [undefined, '', 'google', 'shadow']) {
  const m = world(auth);
  const r = m.post(FO({ apply: true, keys: KEYS }));
  check('GG1[' + JSON.stringify(auth) + ']', '舊資料清理套用照常：兩天都處理、11/04 核定搬到留底', [r.ok, (r.done || []).length, m.approved().map((x) => x[0]), (m.tab('approved_revoked') || []).length - 1], [true, 2, ['2026-11-03', '2026-11-06'], 1]);
  const b = world(auth), rb = b.post(BF({ apply: true }));
  check('GG2[' + JSON.stringify(auth) + ']', '少刷回填套用照常：approved 多一列系統重算', [rb.ok, rb.applied, rb.fixed, b.approved().length, /系統重算/.test(b.approved()[3][6])], [true, true, 1, 4, true]);
}

console.log('\n══ 四、沒設／google 類跟改版前的 main 逐字相同；刻意不擋的入口連 mini 也相同 ══');
const BASE = process.env.GATE_BASE || 'dcd5c50';   // 改版前的 main（開分支時的 origin/main；合併後可用環境變數換）
let base = null;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-'));
  fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
  ['Code.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));
} catch (e) { console.log('• 跳過：拿不到改版前的版本 ' + BASE + '（' + String(e.message).split('\n')[0] + '）'); base = null; }
if (base) {
  const run = (root, auths, fresh) => JSON.parse(execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { GS_ROOT: root, GATE_CHILD: JSON.stringify(auths), GATE_FRESH: fresh ? '1' : '' }), encoding: 'utf8', maxBuffer: 64 << 20 }));
  const GOOGLE = [undefined, '', 'google', 'GOOGLE', ' off ', 'shadow'];
  const a = run(base, GOOGLE), b = run(ROOT, GOOGLE);
  a.out.forEach((x, i) => check('GS' + String(i + 1).padStart(3, '0'), x[0] + '：回應逐字相同', b.out[i], x));
  check('GS900', '回應筆數相同', b.out.length, a.out.length);
  Object.keys(a.sheets).forEach((k) => check('GS901-' + k, k + '：approved、leave、留底、events、roster、requests 最後內容相同', b.sheets[k], a.sheets[k]));
  check('GS902', '對照組有效：main 那邊清理、回填、撤銷、重算、裝置、代開、補附都真的寫成功',
    ['清理套用', '回填套用', '撤銷套用', '系統重算（手動）', '主管核准新裝置', '主管代開', '補附證明'].map((nm) => (a.out.filter((x) => x[0] === 'undefined|' + nm)[0] || [0, {}])[1].ok),
    [true, true, true, true, true, true, true]);
  check('GS903', '對照組有效：main 那邊回填真的補了一列、系統重算真的改了一天', [a.out.filter((x) => x[0] === 'undefined|回填套用')[0][1].fixed, a.out.filter((x) => x[0] === 'undefined|系統重算（手動）')[0][1].fixed], [1, 1]);
  // mini 模式：刻意不擋的五個入口回應逐字相同（新擋的兩個、#204 的撤銷不在比較範圍）
  const KEEP = /系統重算|新裝置|主管代開|補附證明/;
  const am = run(base, ['mini'], true), bm = run(ROOT, ['mini'], true);
  am.out.forEach((x, i) => { if (KEEP.test(x[0])) check('GM9-' + String(i + 1).padStart(2, '0'), '［mini］' + x[0] + '：回應逐字相同（刻意放行）', bm.out[i], x); });
  check('GM990', '［mini］對照：新版只差在清理、回填被擋', bm.out.filter((x, i) => JSON.stringify(x) !== JSON.stringify(am.out[i])).map((x) => x[0].split('|')[1]), ['清理套用', '回填套用']);
  fs.rmSync(base, { recursive: true, force: true });
}
done();
