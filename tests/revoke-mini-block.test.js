/**
 * 店切 mini 核定後，bind_revoke／ft8_revoke 不在 Google 直接套用（2026-11-21 大腦定案，金山切 mini 前要先上）。
 *  - DUTY_AUTH＝mini／on：apply:true 回 moved_to_mini、核定列一筆都不搬；只預覽照常。
 *  - DUTY_AUTH 填了認不得的值、讀不到屬性：apply:true 回 auth_unknown（保護性：不知道是不是 mini 就先不搬）；只預覽照常。
 *  - 沒設／空／google／off／shadow：跟改版前的 main 逐字相同（回應＋approved、approved_revoked 兩張表）。
 * 全部虛構同仁；金鑰都是測試沙盒的假值。
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const H = require('./helpers/gs-sandbox');
const { make, T, check, done, ROOT } = H;
const J = (x) => JSON.parse(JSON.stringify(x));

const AP = (date, emp, name, per, h) => [date, emp, name, per || '10:00-18:00', h || 8, '正常', '值班主管', date + 'T20:00:00+08:00', '', ''];
const ROSTER = [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true', line_user_id: 'U1' }];
const BP = { REQ_BIND_FROM: '2026-11-01', REQ_STRICT_FROM: '2026-11-08' };
const BEV = [['2026-11-02T10:00:00', 'E01', 'in'], ['2026-11-03T10:00:00', 'E01', 'in']];   // 兩天都只有上班卡＝缺忘打卡單
const BAP = [AP('2026-11-02', 'E01', '代號甲'), AP('2026-11-03', 'E01', '代號甲')];
const BR = (apply) => ({ action: 'bind_revoke', admin_key: 'ADM', from: '2026-11-01', to: '2026-11-07', apply: apply });
const FP = { REQ_FT8_FROM: '2026-11-01' };
const FEV = [['2026-11-04T10:00:00', 'E01', 'in'], ['2026-11-04T14:00:00', 'E01', 'out']];
const FAP = [AP('2026-11-04', 'E01', '代號甲', '10:00-14:00', 4)];
const FR = (apply) => ({ action: 'ft8_revoke', admin_key: 'ADM', items: [{ emp_id: 'E01', date: '2026-11-04' }], apply: apply });

function world(kind, auth) {
  const props = Object.assign({}, kind === 'bind' ? BP : FP);
  if (auth !== undefined) props.DUTY_AUTH = auth;
  const m = make({ now: T('2026-11-10T10:00:00'), props, self: { roster: ROSTER, events: kind === 'bind' ? BEV : FEV, approved: kind === 'bind' ? BAP : FAP } });
  m.post = (body) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return m;
}
const revoked = (m) => { const sh = m.self.sh.approved_revoked; return sh ? sh.values.slice(1).map((r) => r.slice(0, 2)) : []; };
// 跑一輪：預覽、套用；回應去掉時間欄位以外全保留
function corpus() {
  const out = [], sheets = {};
  [['bind', BR], ['ft8', FR]].forEach(([kind, req]) => {
    [undefined, '', 'google', 'GOOGLE', ' off ', 'shadow'].forEach((auth) => {
      const m = world(kind, auth);
      out.push([kind + '|' + JSON.stringify(auth) + '|預覽', J(m.post(req(false)))]);
      out.push([kind + '|' + JSON.stringify(auth) + '|套用', J(m.post(req(true)))]);
      sheets[kind + '|' + JSON.stringify(auth)] = { approved: J(m.approved()), revoked: J(m.self.sh.approved_revoked ? m.self.sh.approved_revoked.values : null) };
    });
  });
  return { out, sheets };
}
if (process.env.REVOKE_CHILD === '1') { process.stdout.write(JSON.stringify(corpus())); process.exit(0); }

console.log('══ 一、DUTY_AUTH＝mini／on：apply:true 擋、只預覽照常 ══');
for (const auth of ['mini', 'on', ' MINI ']) {
  const b = world('bind', auth);
  const pv = b.post(BR(false));
  check('RM1[' + auth + ']', 'bind_revoke 預覽照常列出兩天', [pv.ok, (pv.items || []).map((x) => x.date)], [true, ['2026-11-02', '2026-11-03']]);
  const r = b.post(BR(true));
  check('RM2[' + auth + ']', 'bind_revoke 套用 → moved_to_mini＋白話訊息，核定列不動、沒有留底分頁',
    [r.ok, r.error, /mini/.test(r.message) && /切回 google/.test(r.message), b.approved().length, revoked(b)], [false, 'moved_to_mini', true, 2, []]);
  const f = world('ft8', auth);
  check('RM3[' + auth + ']', 'ft8_revoke 預覽照常', (f.post(FR(false)).items || []).map((x) => x.date), ['2026-11-04']);
  const rf = f.post(FR(true));
  check('RM4[' + auth + ']', 'ft8_revoke 套用 → moved_to_mini，核定列不動', [rf.ok, rf.error, f.approved().length], [false, 'moved_to_mini', 1]);
}

console.log('\n══ 二、認不得的值、讀不到屬性：apply:true 擋（保護性）══');
for (const auth of ['mni', 'disabled', '亂碼']) {
  const b = world('bind', auth);
  check('RU1[' + auth + ']', 'bind_revoke 預覽照常', (b.post(BR(false)).items || []).length, 2);
  const r = b.post(BR(true));
  check('RU2[' + auth + ']', 'bind_revoke 套用 → auth_unknown、核定列不動', [r.ok, r.error, /auth_cfg/.test(r.message), b.approved().length], [false, 'auth_unknown', true, 2]);
  const f = world('ft8', auth);
  check('RU3[' + auth + ']', 'ft8_revoke 套用 → auth_unknown', [f.post(FR(true)).error, f.approved().length], ['auth_unknown', 1]);
}
{
  const b = world('bind');
  const sp = b.sb.PropertiesService.getScriptProperties;
  b.sb.PropertiesService.getScriptProperties = () => Object.assign(sp(), { getProperties: () => { throw new Error('屬性服務暫時讀不到'); } });
  const r = b.post(BR(true));
  check('RU4', '讀不到指令碼屬性 → auth_unknown、核定列不動', [r.ok, r.error, b.approved().length], [false, 'auth_unknown', 2]);
}
{
  const b = world('bind', 'mini');
  const r = b.post(Object.assign(BR(true), { admin_key: 'WRONG' }));
  check('RU5', '管理金鑰錯：照舊先回 unauthorized（不洩漏核定模式）', r.error, 'unauthorized');
}

console.log('\n══ 三、沒設／google 類：照常搬 ══');
for (const auth of [undefined, '', 'google', 'shadow']) {
  const b = world('bind', auth);
  const r = b.post(BR(true));
  check('RG1[' + JSON.stringify(auth) + ']', 'bind_revoke 套用照常兩天都搬', [r.ok, r.moved, b.approved().length, revoked(b).length], [true, 2, 0, 2]);
  const f = world('ft8', auth);
  check('RG2[' + JSON.stringify(auth) + ']', 'ft8_revoke 套用照常', [f.post(FR(true)).moved, f.approved().length], [1, 0]);
}

console.log('\n══ 四、沒設／google 類：跟改版前的 main 逐字相同 ══');
const BASE = process.env.REVOKE_BASE || 'ef6e05f';   // 改版前的 main（PR 開出時的 merge-base；合併後可用環境變數換）
let base = null;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-base-'));
  fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
  fs.writeFileSync(path.join(base, 'apps-script', 'Requests.gs'), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/Requests.gs']));
} catch (e) { console.log('• 跳過：拿不到改版前的版本 ' + BASE + '（' + String(e.message).split('\n')[0] + '）'); base = null; }
if (base) {
  const run = (root) => JSON.parse(execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { GS_ROOT: root, REVOKE_CHILD: '1' }), encoding: 'utf8', maxBuffer: 64 << 20 }));
  const a = run(base), b = run(ROOT);
  a.out.forEach((x, i) => check('RS' + String(i + 1).padStart(2, '0'), x[0] + '：回應逐字相同', b.out[i], x));
  check('RS90', '回應筆數相同', b.out.length, a.out.length);
  Object.keys(a.sheets).forEach((k) => check('RS91-' + k, k + '：approved、approved_revoked 最後內容相同', b.sheets[k], a.sheets[k]));
  fs.rmSync(base, { recursive: true, force: true });
}
done();
