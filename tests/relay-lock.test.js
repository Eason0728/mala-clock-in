/* 第 3 階段 P3-8 鎖月條件加項（RelayG.gs payGReconBlock_ ＋ relayGLockRowsBlock_，2026-11-21）。
 * 驗收照 plan P3-8 五組手算對照；另測「保護性開關：填錯值維持擋」、資料不完整一律擋、P2-A 一鍵關正本可解除、範圍常數。
 * 名字、金鑰都是假的。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';
const MIN = 60000;

function world(lockProp) {
  const props = { REQ_BIND_FROM: 'off', RELAY_KEY: KEY };
  if (lockProp !== undefined) props.G_LOCK_ROWS = lockProp;
  const m = make({ now: T('2026-12-02T10:00:00'), props, self: { roster: [], events: [] } });
  m.run(R('apps-script/RelayG.gs'));
  const sb = m.sb;
  // 11/16 切換正本、光復＝SS1
  sb.__now = T('2026-11-16T01:57:00');
  sb.handleRelayMode_({ relay_key: KEY, on: true, stores: ['SS1'] });
  sb.__now = T('2026-12-02T10:00:00');
  const setProp = (k, v) => { const p = sb.PropertiesService.getScriptProperties(); if (v === null) p.deleteProperty(k); else p.setProperty(k, v); };
  // 送一次對帳：打卡一致；rows 由各組自己給
  const recon = (rows, punch) => sb.handleRelayMode_({ relay_key: KEY, recon: { SS1: { '2026-11': Object.assign({ ok: true, mini: 120, g: 120, at: sb.__now }, punch || {}, rows === undefined ? {} : { rows }) } } });
  const lock = () => { const r = sb.payGReconBlock_('2026-11', 'SS1'); return r ? r.error : null; };
  return { m, sb, setProp, recon, lock };
}
// 「全部一致」的 rows（手算：三張表 11 月每天指紋一致、未寫回 0、衝突 0、剛剛比過）
const okRows = (sb, over) => Object.assign({ fp: 'ok', bad: [], unwb: 0, conflict: 0, unwb_all: 0, conflict_all: 0, at: sb.__now, why: '' }, over || {});

// ── plan P3-8 五組手算對照 ──
{
  const w = world('1');
  w.recon(okRows(w.sb));
  check('P1', '① 全一致（打卡 120=120、指紋全一致、未寫回 0、衝突 0）→ 可鎖', w.lock(), null);
  w.recon(okRows(w.sb, { unwb: 1, unwb_all: 1 }));
  check('P2', '② 有 1 筆未寫回 → 擋', w.lock(), 'g_rows_unwb');
  check('P2b', '　訊息寫出筆數', /還有 1 筆/.test(w.sb.payGReconBlock_('2026-11', 'SS1').message), true);
  w.recon(okRows(w.sb, { conflict: 1, conflict_all: 1 }));
  check('P3', '③ 有 1 筆衝突待處理 → 擋', w.lock(), 'g_rows_conflict');
  w.recon(okRows(w.sb, { fp: 'bad', bad: ['approved 11/03'] }));
  check('P4', '④ 指紋差 1 天（approved 11/03）→ 擋', w.lock(), 'g_rows_fp');
  check('P4b', '　訊息寫出哪一天', /approved 11\/03/.test(w.sb.payGReconBlock_('2026-11', 'SS1').message), true);
}
{
  const w = world();   // 開關沒設
  w.recon(okRows(w.sb, { fp: 'bad', unwb: 3, conflict: 2 }));
  check('P5', '⑤ 開關關（沒設）→ 照舊只看打卡：打卡一致就可鎖（rows 再爛也不看）', w.lock(), null);
  w.recon(okRows(w.sb, { fp: 'bad' }), { ok: false, mini: 121, g: 120 });
  check('P5b', '⑤ 開關關、打卡對不上 → 照舊擋（跟現在一樣）', w.lock(), 'g_recon_mismatch');
  w.recon(undefined);
  check('P5c', '⑤ 開關關、mini 沒送 rows（舊版 mini）→ 可鎖', w.lock(), null);
}

// ── 保護性開關：只有 沒設／空白／'0' 算關；其他任何值都算開（打錯字維持擋，不會變放行）──
for (const [v, on] of [[null, false], ['', false], ['  ', false], ['0', false], [' 0 ', false], ['1', true], ['1 ', true], ['yes', true], ['on', true], ['off', true], ['false', true], ['開', true], ['2', true]]) {
  const w = world(v === null ? undefined : v);
  w.recon(okRows(w.sb, { unwb: 1, unwb_all: 1 }));
  check('S-' + JSON.stringify(v), 'G_LOCK_ROWS=' + JSON.stringify(v) + (on ? ' → 當開、擋' : ' → 關、放行'), w.lock(), on ? 'g_rows_unwb' : null);
}
{
  const w = world('1');
  w.sb.PropertiesService.getScriptProperties().getProperty = () => { throw new Error('讀不到'); };
  check('S-err', '讀不到設定 → 當開（保護性）', w.sb.relayGLockRowsOn_(), true);
}

// ── 開著時，不知道＝擋 ──
{
  const w = world('1');
  w.recon(undefined);
  check('U1', 'mini 沒送 rows（沒開 G_ROWS_ON 或舊版）→ 擋', w.lock(), 'g_rows_missing');
  w.recon(okRows(w.sb, { at: w.sb.__now - 31 * MIN }));
  check('U2', 'rows 超過 30 分鐘沒更新 → 擋', w.lock(), 'g_rows_stale');
  w.recon(okRows(w.sb, { at: 0 }));
  check('U3', 'rows 沒有時間 → 擋', w.lock(), 'g_rows_stale');
  w.recon(okRows(w.sb, { fp: 'unknown', why: 'leave 還沒比過指紋' }));
  check('U4', '指紋還沒比完 → 擋', w.lock(), 'g_rows_fp_unknown');
  w.recon(okRows(w.sb, { fp: 'OK' }));
  check('U5', '指紋欄填了不認得的值 → 當不知道、擋', w.lock(), 'g_rows_fp_unknown');
  w.recon(okRows(w.sb, { unwb: null }));
  check('U6', '問不到營運系統（未寫回筆數 null）→ 擋', w.lock(), 'g_rows_count_unknown');
  for (const bad of [-1, 1.5, '0', 'x', true, undefined]) {
    w.recon(okRows(w.sb, { conflict: bad }));
    check('U7-' + String(bad), '衝突筆數 ' + JSON.stringify(bad) + '（不是 0 以上整數）→ 當不知道、擋', w.lock(), 'g_rows_count_unknown');
  }
  w.recon('ok');
  check('U8', 'rows 不是物件 → 當沒回報、擋', w.lock(), 'g_rows_missing');
  w.recon(okRows(w.sb), { ok: false, mini: 119, g: 120 });
  check('U9', '打卡對不上仍先擋打卡那條（原訊息不變）', w.lock(), 'g_recon_mismatch');
  w.recon(okRows(w.sb));
  w.sb.__now += 31 * MIN;
  check('U10', '整份對帳太舊 → 先擋打卡那條（原訊息不變）', w.lock(), 'g_recon_stale');
}

// ── 範圍：'month'（只算要鎖的那個月）vs 其他（全店）──
{
  const w = world('1');
  w.recon(okRows(w.sb, { unwb: 0, conflict: 0, unwb_all: 0, conflict_all: 1 }));   // 只有 12/1 一筆衝突
  check('C1', "範圍 'month'（預設）：11 月沒有、只有 12 月 1 筆衝突 → 11 月可鎖", w.lock(), null);
  w.sb.RELAYG_LOCK_SCOPE_ = 'store';
  check('C2', "範圍 'store'：同一份資料 → 擋", w.lock(), 'g_rows_conflict');
  w.sb.RELAYG_LOCK_SCOPE_ = 'Month';
  check('C3', '範圍常數打錯 → 當全店（比較嚴）', w.lock(), 'g_rows_conflict');
  w.sb.RELAYG_LOCK_SCOPE_ = 'store';
  w.recon(okRows(w.sb, { unwb_all: null }));
  check('C4', "範圍 'store' 但全店筆數不知道 → 擋", w.lock(), 'g_rows_count_unknown');
}

// ── P2-A：Mac mini 長時間不在 → 編輯器一鍵關正本，三項新條件一起解除 ──
{
  const w = world('1');
  w.recon(okRows(w.sb, { conflict: 2, conflict_all: 2 }));
  check('E1', '有衝突 → 擋', w.lock(), 'g_rows_conflict');
  w.sb.__now += 2 * 3600000;
  check('E2', 'mini 不在 2 小時 → 擋（對帳太舊）', w.lock(), 'g_recon_stale');
  w.sb.relayGEditorPrimaryOff();
  check('E3', '執行 relayGEditorPrimaryOff 後 → 放行（改回只看 Google）', w.lock(), null);
  const s = w.sb.relayGEditorStatus();
  check('E4', '現況函式看得到 P3-8 開關與範圍', [s.lock_rows.on, s.lock_rows.scope], [true, 'month']);
}

// ── 不在名單／切換前月份：跟現在一樣不看 ──
{
  const w = world('1');
  w.recon(undefined);
  check('N1', '不在正本名單的店 → 不看', w.sb.payGReconBlock_('2026-11', 'SS9'), null);
  check('N2', '切換那個月以前（2026-10）→ 不看', w.sb.payGReconBlock_('2026-10', 'SS1'), null);
}

// ── 存進指令碼屬性的內容：只留認得的欄、限長度、不超過屬性上限 ──
{
  const w = world('1');
  w.recon(Object.assign(okRows(w.sb), { bad: ['a'.repeat(60), 'b', 'c', 'd'], why: 'x'.repeat(99), secret: 'nope', unwb: '3' }));
  const st = JSON.parse(w.sb.PropertiesService.getScriptProperties().getProperty('G_RECON')).SS1['2026-11'].rows;
  check('K1', '只留認得的欄', Object.keys(st).sort(), ['at', 'bad', 'conflict', 'conflict_all', 'fp', 'unwb', 'unwb_all', 'why']);
  check('K2', 'bad 最多 3 天、每天 24 字；why 40 字；字串數字當不知道', [st.bad.length, st.bad[0].length, st.why.length, st.unwb], [3, 24, 40, null]);
  const big = {};
  for (let i = 1; i < 20; i++) {
    big['SS' + i] = {};
    for (const ym of ['2026-10', '2026-11', '2026-12']) big['SS' + i][ym] = { ok: true, mini: 1, g: 1, at: w.sb.__now, diff: 'd'.repeat(80), rows: okRows(w.sb, { bad: ['approved 11/03', 'leave 11/04', 'requests 11/05'], why: 'w'.repeat(40) }) };
  }
  w.sb.handleRelayMode_({ relay_key: KEY, recon: big });
  const raw = w.sb.PropertiesService.getScriptProperties().getProperty('G_RECON');
  check('K3', '20 家店 × 3 個月也不超過 9KB（太大時先丟說明文字、再只留近月）', raw.length <= 9000, true);
  check('K4', '縮減後判斷照舊（SS1 的 11 月仍可鎖）', w.lock(), null);
}

done();
