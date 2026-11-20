// P3-3：duty_changes auth_cfg（營運系統 ops/duty-auth.sh 遠端切核定模式；契約 docs/contract-writeback.md 第 5 節）
// 驗證：主管金鑰＋管理金鑰＋（店有門鈴金鑰時）mini 簽名；只寫 DUTY_AUTH、DUTY_VER_STRICT；認不得的值不動；每次寫入留紀錄。
'use strict';
const crypto = require('crypto');
const { make, T, check, done } = require('./helpers/gs-sandbox');
const KEY = 'k'.repeat(32), STORE = 'gf';
const world = (props) => {
  const m = make({ now: T('2026-11-21T15:00:00'), props: Object.assign({ REQ_CARD_REASON_FROM: 'off' }, props || {}),
    self: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }], events: [['2026-11-20T09:00:00', 'E01', 'in'], ['2026-11-20T17:00:00', 'E01', 'out']] } });
  m.post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  return m;
};
const sig = (store, mode, vs, ts, nonce, key) => crypto.createHmac('sha256', key || KEY).update(['cfg', '2', store, mode, vs === true ? '1' : vs === false ? '0' : '-', String(ts), nonce].join('|')).digest('hex');
let nSeq = 0;
const cfg = (m, c, extra) => m.post(Object.assign({ action: 'duty_changes', mgr_key: 'AK', admin_key: 'ADM', acting_name: '資訊部（DZY000）', auth_cfg: c }, extra || {}));
const signed = (m, mode, vs, opt) => { opt = opt || {}; const ts = opt.ts || m.sb.Date.now(); const nonce = opt.nonce || ('nonce-' + String(++nSeq).padStart(6, '0'));
  const c = { mode, ts, nonce, sig: sig(opt.store || STORE, mode, vs, ts, nonce, opt.key) }; if (vs !== undefined) c.ver_strict = vs; return c; };
const P = (m) => ({ DUTY_AUTH: m.props.DUTY_AUTH, DUTY_VER_STRICT: m.props.DUTY_VER_STRICT });

{
  const m = world({ DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: STORE });
  check('C1', '沒管理金鑰 → unauthorized、不動', [cfg(m, signed(m, 'mini'), { admin_key: undefined }).error, P(m)], ['unauthorized', { DUTY_AUTH: undefined, DUTY_VER_STRICT: undefined }]);
  check('C2', '主管金鑰錯 → unauthorized', cfg(m, signed(m, 'mini'), { mgr_key: 'NOPE' }).error, 'unauthorized');
  check('C3', '管理金鑰錯 → unauthorized', cfg(m, signed(m, 'mini'), { admin_key: 'NOPE' }).error, 'unauthorized');
  check('C4', '店有門鈴金鑰卻沒簽名 → bad_sig、不動', [cfg(m, { mode: 'mini' }).error, P(m).DUTY_AUTH], ['bad_sig', undefined]);
  check('C5', '簽名錯（別把金鑰）→ bad_sig', cfg(m, signed(m, 'mini', undefined, { key: 'x'.repeat(32) })).error, 'bad_sig');
  check('C6', '簽名錯（別家店）→ bad_sig', cfg(m, signed(m, 'mini', undefined, { store: 'mztjs' })).error, 'bad_sig');
  const tam = signed(m, 'google'); tam.mode = 'mini';
  check('C7', '簽 google 改成 mini → bad_sig', cfg(m, tam).error, 'bad_sig');
  check('C8', '簽名時間超過 2 分鐘 → wb_ts（2026-11-21 驗收 P2：原 10 分鐘）', [cfg(m, signed(m, 'mini', undefined, { ts: m.sb.Date.now() - 3 * 60000 })).error, P(m).DUTY_AUTH], ['wb_ts', undefined]);
  const noN = signed(m, 'mini'); delete noN.nonce;
  check('C8b', '沒帶一次性單號 → bad_sig', cfg(m, noN).error, 'bad_sig');
  for (const bad of ['MINI!', 'shadoww', '', 'true', 'yes']) {
    check('C9[' + bad + ']', '認不得的值 ' + JSON.stringify(bad) + ' → bad_input、屬性不動', [cfg(m, signed(m, bad)).error, P(m).DUTY_AUTH], ['bad_input', undefined]);
  }
  check('C10', 'ver_strict 不是布林 → bad_input', cfg(m, Object.assign(signed(m, 'mini'), { ver_strict: '1' })).error, 'bad_input');
  const r = cfg(m, signed(m, 'mini'));
  check('C11', '三把金鑰都對 → 切 mini；回應只有模式與開關', [r.ok, r.auth_cfg, r.changed, Object.keys(r).sort(), P(m).DUTY_AUTH], [true, { mode: 'mini', ver_strict: false }, true, ['auth_cfg', 'changed', 'ok'], 'mini']);
  check('C12', '切 mini 後舊頁核定 → moved_to_mini（下一筆就生效）', m.post({ action: 'mgr_approve', mgr_key: 'MK', date: '2026-11-20', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }).error, 'moved_to_mini');
  const r2 = cfg(m, signed(m, 'shadow', true));
  check('C13', 'shadow＝google（清掉 DUTY_AUTH）＋ver_strict:true', [r2.ok, r2.auth_cfg, P(m)], [true, { mode: 'google', ver_strict: true }, { DUTY_AUTH: '', DUTY_VER_STRICT: '1' }]);
  const r3 = cfg(m, signed(m, 'on'));
  check('C14', 'on＝mini；沒帶 ver_strict＝不動', [r3.auth_cfg, P(m)], [{ mode: 'mini', ver_strict: true }, { DUTY_AUTH: 'mini', DUTY_VER_STRICT: '1' }]);
  cfg(m, signed(m, 'off', false));
  check('C15', 'off＝google、ver_strict:false 清掉', P(m), { DUTY_AUTH: '', DUTY_VER_STRICT: '' });
  const g = cfg(m, { get: true });
  check('C16', 'get:true：回現況＋最近紀錄（誰、何時、從哪到哪、單號），不含金鑰', [g.auth_cfg, g.log.length, g.log.map((x) => [x.by, x.from, x.mode]), JSON.stringify(g).indexOf(KEY) < 0, Object.keys(g.log[0]).sort()],
    [{ mode: 'google', ver_strict: false }, 4, [['營運系統代管／資訊部（DZY000）', 'google', 'mini'], ['營運系統代管／資訊部（DZY000）', 'mini', 'google'], ['營運系統代管／資訊部（DZY000）', 'google', 'mini'], ['營運系統代管／資訊部（DZY000）', 'mini', 'google']],
      true, ['at', 'by', 'from', 'mode', 'n', 'ver_strict']]);
  // 重放（2026-11-21 驗收 P2）：同一個請求 2 分鐘內原封不動再送 → replay、不動
  const once = signed(m, 'mini');
  const rp1 = cfg(m, once);
  cfg(m, signed(m, 'google'));
  const rp2 = cfg(m, once);
  check('C16b', '同一個設定請求再送一次 → replay、屬性不動', [rp1.ok, rp2.error, P(m).DUTY_AUTH], [true, 'replay', '']);
  Object.keys(m.cache).forEach((k) => delete m.cache[k]);
  check('C16c', '暫存區被清掉也擋得住（查 DUTY_AUTH_LOG 的單號）', cfg(m, once).error, 'replay');
  cfg(m, signed(m, 'off', false));
  check('C17', '只動白名單：門鈴金鑰、店代碼、其他屬性不變', [m.props.DUTY_PUSH_KEY === KEY, m.props.DUTY_PUSH_STORE, Object.keys(m.props).sort()],
    [true, STORE, ['DUTY_AUTH', 'DUTY_AUTH_LOG', 'DUTY_PUSH_KEY', 'DUTY_PUSH_STORE', 'DUTY_VER_STRICT', 'REQ_CARD_REASON_FROM']]);
  for (let i = 0; i < 25; i++) cfg(m, signed(m, i % 2 ? 'mini' : 'google'));
  check('C18', '紀錄只留最近 20 筆', cfg(m, { get: true }).log.length, 20);
  check('C19', '跟 push_cfg 同時帶 → bad_input', cfg(m, signed(m, 'mini'), { push_cfg: { url_on: false, dry: true } }).error, 'bad_input');
  m.props.DUTY_AUTH = 'disabled';
  const gu = cfg(m, { get: true });
  check('C19b', 'DUTY_AUTH 被手動填認不得的值：get 回 google＋unknown_value:true', [gu.auth_cfg.mode, gu.auth_cfg.unknown_value], ['google', true]);
}
{
  const m = world({});
  check('C20', '沒設門鈴金鑰的店：切 mini → need_key、不動', [cfg(m, { mode: 'mini' }).error, m.props.DUTY_AUTH], ['need_key', undefined]);
  const r = cfg(m, { mode: 'google' });
  check('C21', '沒設門鈴金鑰的店：設 google（＝現行）只要兩把金鑰', [r.ok, r.auth_cfg.mode, m.props.DUTY_AUTH], [true, 'google', '']);
  const m2 = world({ DUTY_PUSH_KEY: KEY });
  check('C22', '有金鑰沒店代碼：切 mini → need_key', cfg(m2, { mode: 'mini' }).error, 'need_key');
}
done();
