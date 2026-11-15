/* G＋備援（2026-11-15，RelayG.gs）：mini 拉副本、mini 寫回、手機改送 Google 帶單號不重複、光復開關與薪資鎖月檢查。
 * 用真函式跑（Code／Liff／Rest／Requests／DutyFeed＋RelayG）。名字一律假名、金鑰假的。 */
'use strict';
const { make, T, at, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';
const SUB = 'U' + 'a'.repeat(32);
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const NEW = { emp_id: 'E03', name: '測試三', key: 'K3', device_id: '', active: 'TRUE', line_user_id: SUB };
const HERE = Object.assign({ accuracy: 10 }, at(3));
const RID = (n) => 'r' + String(n).padStart(16, '0');

function world(now, events, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props: Object.assign({ REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, opt.props || {}),
    self: { roster: [ME, NEW], events: events || [] } });
  m.run(R('apps-script/RelayG.gs'));
  return m;
}
const heads = (m) => m.self.sh.events.values[0].slice();
const rows = (m) => { const h = heads(m); return m.self.sh.events.values.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const doPost = (m, body) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text);

// ── relay_pull ──
{
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  check('P1', '沒有金鑰不給', m.sb.handleRelayPull_({ relay_key: 'x' }).error, 'unauthorized');
  const r = m.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true, props: true, sheets: true } });
  check('P2', '回打卡列數與內容', [r.ok, r.total, r.events.length, r.events[0].emp_id, r.events[0].__row], [true, 1, 1, 'E01', 2]);
  check('P3', '裝置碼回雜湊不回原文', /^h:[0-9a-f]{64}$/.test(r.events[0].device_id), true);
  const me = r.roster.find((x) => x.emp_id === 'E01');
  check('P4', '名冊金鑰、LINE 帳號、裝置碼都是雜湊', [/^h:/.test(me.key), /^h:/.test(me.line_user_id), /^h:/.test(me.device_id), JSON.stringify(r).indexOf('"K1"') < 0], [true, true, true, true]);
  check('P5', 'LINE 雜湊跟快速通道同一種算法', me.line_user_id, 'h:' + m.sb.relayUidHash_('U1', KEY));
  check('P6', '設定值有座標半徑', [r.config.RADIUS_M, typeof r.config.STORE_LAT], [20, 'number']);
  check('P7', 'from_row 之後才回', m.sb.handleRelayPull_({ relay_key: KEY, from_row: 2 }).events.length, 0);
  check('P8', '是唯讀：不記考勤變動', m.sb.dutyFeedIsRead_('relay_pull'), true);
}

// ── relay_append ──
{
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const row = { ts: '2026-11-20T09:00:05+08:00', emp_id: 'E01', type: 'out', lat: HERE.lat, lng: HERE.lng, distance_m: 3, within_range: true, device_match: true, status: 'ok', accuracy_m: 10, source: 'mini' };
  check('A1', '沒有金鑰不收', m.sb.handleRelayAppend_({ relay_key: 'x', req_id: RID(1), row }).error, 'unauthorized');
  check('A2', '單號格式不對不收', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'zz', row }).error, 'bad_req_id');
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(1), row, line_ok: true });
  check('A3', '寫進一列', [a.ok, a.dup, rows(m).length], [true, false, 2]);
  const w = rows(m)[1];
  check('A4', '列上有單號、來源、名冊的裝置碼', [w.req_id, w.source, w.device_id, w.status, w.ts], [RID(1), 'mini', 'D1', 'ok', row.ts]);
  check('A5', '表頭補了 source、req_id 在最後', heads(m).slice(-2), ['source', 'req_id']);
  check('A6', '回日期與同仁（考勤副本變動紀錄用）', [a.date, a.emp_id], ['2026-11-20', 'E01']);
  const b = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(1), row });
  check('A7', '同一張單號再送：不寫第二張', [b.ok, b.dup, rows(m).length], [true, true, 2]);
  // 名冊沒綁裝置：用 line:<LINE 帳號> 綁上
  const c = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(2), bind_sub: SUB, row: Object.assign({}, row, { emp_id: 'E03', type: 'in', ts: '2026-11-20T09:01:00+08:00' }) });
  const e3 = m.roster().find((x) => x.emp_id === 'E03');
  check('A8', '沒綁裝置的人綁上 line:帳號', [c.ok, rows(m)[2].device_id, e3.device_id, e3.device_bound_at], [true, 'line:' + SUB, 'line:' + SUB, '2026-11-20T09:01:00+08:00']);
  // 寫完 Google 這邊的防呆看得到（剛送出記號）
  const mk = JSON.parse(m.cache['lfl:E03'].v);
  check('A9', '放了剛送出記號', [mk.type, mk.ts], ['in', '2026-11-20T09:01:00+08:00']);
  // 被擋的卡也照抄（status 照 mini 判的）
  const d = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(3), row: Object.assign({}, row, { ts: '2026-11-20T09:02:00+08:00', status: 'rejected_out_of_range', within_range: false }) });
  check('A10', '被擋的卡照抄', [d.ok, rows(m)[3].status], [true, 'rejected_out_of_range']);
  check('A11', '寫入會記考勤變動', m.sb.dutyFeedIsRead_('relay_append'), false);
}

// ── 系統收卡（滿 10 小時）由 mini 寫：Google 觸發器已經寫過同一張就不重複 ──
{
  const m = world('2026-11-20T19:00:00', []);
  const sh = m.self.sh.events; sh.values[0].push('source');
  sh.values.push(['2026-11-20T19:00:00+08:00', 'E01', 'out', '', '', '', '', 'system', '', 'ok', '', 'system_cap']);
  const capRow = { ts: '2026-11-20T19:00:20+08:00', emp_id: 'E01', type: 'out', lat: '', lng: '', distance_m: '', within_range: '', device_match: '', status: 'ok', accuracy_m: '', source: 'system_cap' };
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:20+08:00', row: capRow });
  check('C1', '同人同時刻的系統卡已存在＝當成同一張', [r.ok, r.dup, rows(m).length], [true, true, 1]);
}

// ── 手機改送 Google（liff_punch 帶 req_id）──
{
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const before = heads(m).join(',');
  m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out' }, HERE));
  check('F0', '沒帶單號：跟今天一模一樣（不補欄位）', heads(m).join(','), before);
}
{
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const r1 = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(9) }, HERE));
  const w = rows(m)[1];
  check('F1', '改送 Google 寫一張，列上記單號與來源 line_g', [r1.ok, w.req_id, w.source], [true, RID(9), 'line_g']);
  m.advance(2000);
  const r2 = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(9) }, HERE));
  check('F2', '同一張單號再送：回原結果、不寫第二張', [r2.ok, r2.dup, r2.ts, rows(m).length], [true, true, r1.ts, 2]);
  // mini 晚一步把同一張抄過來：當成同一張
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(9), row: { ts: '2026-11-20T09:00:01+08:00', emp_id: 'E01', type: 'out', lat: 1, lng: 1, distance_m: 3, within_range: true, device_match: true, status: 'ok', accuracy_m: 10, source: 'mini' } });
  check('F3', 'mini 抄同一張單號＝dup，回 Google 那張', [a.dup, a.row.ts, rows(m).length], [true, r1.ts, 2]);
}
{
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(5), row: { ts: '2026-11-20T09:00:00+08:00', emp_id: 'E01', type: 'out', lat: 1, lng: 1, distance_m: 3, within_range: true, device_match: true, status: 'ok', accuracy_m: 10, source: 'mini' } });
  // 記號清掉（模擬過了 15 分鐘或另一台伺服器），只靠表上的單號
  Object.keys(m.cache).filter((k) => k.indexOf('rqg:') === 0).forEach((k) => delete m.cache[k]);
  const r = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(5) }, HERE));
  check('F4', 'mini 已寫的單號，手機改送 Google 也不寫第二張', [r.ok, r.dup, rows(m).length, !!r.greeting], [true, true, 2, true]);
}
{
  // 手機改送時 Google 判被擋（10 分鐘鎖）：沒寫任何列，記號標完成；之後 mini 抄同一張照寫（mini 是正本）
  const m = world('2026-11-20T08:05:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const r = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(6) }, HERE));
  check('F5', 'Google 擋下：不寫', [r.ok, rows(m).length], [false, 1]);
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(6), row: { ts: '2026-11-20T08:05:00+08:00', emp_id: 'E01', type: 'out', lat: 1, lng: 1, distance_m: 3, within_range: true, device_match: true, status: 'rejected_too_soon', accuracy_m: 10, source: 'mini' } });
  check('F6', 'mini 那張照抄', [a.ok, a.dup, rows(m).length], [true, false, 2]);
}

// ── 光復開關、對帳結果、薪資鎖月檢查 ──
{
  const m = world('2026-11-20T09:00:00', []);
  check('M1', '沒開：不擋', m.sb.payGReconBlock_('2026-11', 'SS1'), null);
  doPost(m, { action: 'relay_mode', relay_key: KEY, on: true, stores: ['SS1'] });
  check('M2', '開了沒有對帳結果：擋', m.sb.payGReconBlock_('2026-11', 'SS1').error, 'g_recon_missing');
  check('M3', '不在名單的店：不擋', m.sb.payGReconBlock_('2026-11', 'SS2'), null);
  m.sb.handleRelayMode_({ relay_key: KEY, recon: { SS1: { '2026-11': { ok: true, mini: 10, g: 10, at: T('2026-11-20T08:50:00') } } } });
  check('M4', '30 分鐘內一致：放行', m.sb.payGReconBlock_('2026-11', 'SS1'), null);
  m.setNow('2026-11-20T09:25:00');
  check('M5', '超過 30 分鐘沒更新：擋', m.sb.payGReconBlock_('2026-11', 'SS1').error, 'g_recon_stale');
  m.sb.handleRelayMode_({ relay_key: KEY, recon: { SS1: { '2026-11': { ok: false, mini: 11, g: 10, at: T('2026-11-20T09:24:00'), diff: '11/20 E01 下班' } } } });
  const b = m.sb.payGReconBlock_('2026-11', 'SS1');
  check('M6', '對不上：擋，訊息寫張數', [b.error, /11 張.*10 張/.test(b.message)], ['g_recon_mismatch', true]);
  doPost(m, { action: 'relay_mode', relay_key: KEY, on: false });
  check('M7', '退回（關掉）：不擋', m.sb.payGReconBlock_('2026-11', 'SS1'), null);
  check('M8', '沒金鑰不能改開關', m.sb.handleRelayMode_({ relay_key: 'x', on: true }).error, 'unauthorized');
}

// ── Fable 審查修正（2026-11-15）──
const ROW = (o) => Object.assign({ ts: '2026-11-20T09:00:01+08:00', emp_id: 'E01', type: 'out', lat: 1, lng: 1, distance_m: 3, within_range: true, device_match: true, status: 'ok', accuracy_m: 10, source: 'mini' }, o || {});
{
  // B1／B2：手機改送那張還在寫（pending）時 mini 抄同一張 → busy；寫完再抄 → dup，只有一張
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const body = Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(21) }, HERE);
  check('R1', 'Before 放 pending', m.sb.relayGFallbackBefore_(body), null);
  check('R2', 'pending 時 mini 抄同一張 → busy、不寫', [m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(21), row: ROW() }).error, rows(m).length], ['busy', 1]);
  Object.keys(m.cache).filter((k) => k.indexOf('rqg:') === 0).forEach((k) => delete m.cache[k]);
  const r = m.sb.handleLiffPunch_(body);
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(21), row: ROW() });
  check('R3', '寫完再抄 → dup，同單號只有一張', [r.ok, a.dup, rows(m).filter((x) => x.req_id === RID(21)).length], [true, true, 1]);
}
{
  // B3：改送 Google 被擋（超出範圍）那列也補單號；mini 再抄同一張＝dup
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const far = Object.assign({ accuracy: 5 }, at(500));
  const r = m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(22) }, far));
  const w = rows(m)[1];
  check('R4', '被擋的卡那列也有單號', [r.ok, w.status, w.req_id], [false, 'rejected_out_of_range', RID(22)]);
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(22), row: ROW({ status: 'rejected_out_of_range', within_range: false }) });
  check('R5', 'mini 抄同一張＝dup，不多一列', [a.dup, rows(m).length], [true, 2]);
}
{
  // B4：liff_punch 中途出錯 → 記號改成完成，mini 抄同一張不會一直 busy
  const m = world('2026-11-20T09:00:00', [['2026-11-20T08:00:00', 'E01', 'in']]);
  const orig = m.sb.liffPunchVerified_;
  m.sb.liffPunchVerified_ = () => { throw new Error('boom'); };
  let threw = false;
  try { m.sb.handleLiffPunch_(Object.assign({ id_token: 'TOK_U1', type: 'out', req_id: RID(23) }, HERE)); } catch (e) { threw = true; }
  m.sb.liffPunchVerified_ = orig;
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(23), row: ROW() });
  check('R6', '出錯後記號不卡：mini 照抄', [threw, a.ok, a.dup], [true, true, false]);
  check('R7', 'pending 記號最多 2 分鐘', m.sb.RELAYG_PENDING_TTL_S_, 120);
}
{
  // B5：單號在 400 列以前也找得到
  const evs = [['2026-11-20T08:00:00', 'E01', 'in']];
  const m = world('2026-11-20T09:00:00', evs);
  m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(24), row: ROW() });
  const h = heads(m);
  for (let i = 0; i < 450; i++) { const r = h.map(() => ''); r[0] = '2026-11-20T09:01:00+08:00'; r[1] = 'X'; r[2] = 'in'; r[h.indexOf('status')] = 'ok'; m.self.sh.events.values.push(r); }
  Object.keys(m.cache).filter((k) => k.indexOf('rqg:') === 0).forEach((k) => delete m.cache[k]);
  const a = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(24), row: ROW() });
  check('R8', '隔 450 列再抄同一張＝dup', a.dup, true);
}
{
  // C1／C2／C3：輸入清洗
  const m = world('2026-11-20T09:00:00', []);
  const r1 = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(25), row: ROW({ lat: '=IMPORTRANGE("x")', distance_m: '=1+1', within_range: '=TRUE', source: 'mini' }) });
  const w = rows(m)[0];
  check('C2a', '公式字串不寫進數字欄', [r1.ok, w.lat, w.distance_m, w.within_range], [true, '', '', '']);
  check('C2b', '來源不在白名單不收', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(26), row: ROW({ source: '=HYPERLINK()' }) }).error, 'bad_source');
  check('C2c', '名冊沒有的人不收（系統卡也一樣）', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:=A1:2026-11-20T09:00:00+08:00', row: ROW({ emp_id: '=A1', source: 'system_cap' }) }).error, 'no_emp');
  check('C2d', '太舊的卡不收', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(27), row: ROW({ ts: '2026-08-01T09:00:00+08:00' }) }).error, 'bad_ts');
  check('C2e', '未來的卡不收', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(28), row: ROW({ ts: '2031-01-01T09:00:00+08:00' }) }).error, 'bad_ts');
  check('C2f', '綁定只能綁成自己的 LINE', m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(29), bind_sub: 'U' + 'f'.repeat(32), row: ROW({ emp_id: 'E03' }) }).error, 'no_device');
}
{
  // D1：relay_pull 不給名冊的建立人、移除人
  const m = world('2026-11-20T09:00:00', []);
  const r = m.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true } });
  check('D1', '名冊只給擋卡要的欄', ['created_by', 'removed_by', 'created_at'].some((k) => k in r.roster[0]), false);
}
{
  // E1：切換那個月以前的月份不看對帳
  const m = world('2026-11-20T09:00:00', []);
  m.sb.handleRelayMode_({ relay_key: KEY, on: true, stores: ['SS1'] });
  check('E1', '切換前的月份（2026-10）放行', m.sb.payGReconBlock_('2026-10', 'SS1'), null);
  check('E1b', '切換當月沒有對帳 → 擋', m.sb.payGReconBlock_('2026-11', 'SS1').error, 'g_recon_missing');
}
done();
