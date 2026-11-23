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

// ── 系統卡同一段上班只留一張（2026-11-23 #223 Codex 擋項一）：Google 因假單先收 18:45、mini 照打卡算 19:00 抄過來 ──
const CAPROW = (ts, emp) => ({ ts, emp_id: emp || 'E01', type: 'out', lat: '', lng: '', distance_m: '', within_range: '', device_match: '', status: 'ok', accuracy_m: '', source: 'system_cap' });
const capWorld = (now, evs, sys) => {
  const m = world(now, evs);
  const sh = m.self.sh.events; sh.values[0].push('source');
  (sys || []).forEach((ts) => sh.values.push([ts, 'E01', 'out', '', '', '', '', 'system', '', 'ok', '', 'system_cap']));
  sh.values.sort((a, b) => (a === sh.values[0] ? -1 : b === sh.values[0] ? 1 : String(a[0]).localeCompare(String(b[0]))));
  return m;
};
{
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C2★', '同一段上班 Google 已有 18:45 系統卡、mini 抄來 19:00 → 當重複、回 18:45 那張、不多寫（改前寫成兩張）',
    [r.ok, r.dup, r.row && r.row.ts, r.row && r.row.source, rows(m).filter((x) => x.source === 'system_cap').length], [true, true, '2026-11-20T18:45:00+08:00', 'system_cap', 1]);
}
{
  const m = capWorld('2026-11-21T02:00:06', [['2026-11-20T05:00:00', 'E01', 'in'], ['2026-11-20T16:00:00', 'E01', 'in']], ['2026-11-20T15:00:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-21T02:00:00+08:00', row: CAPROW('2026-11-21T02:00:00+08:00') });
  check('C3', '前一段上班的系統卡（在最後一張上班卡之前）不算同一段 → 照寫', [r.ok, r.dup, rows(m).filter((x) => x.source === 'system_cap').length], [true, false, 2]);
}
{
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E02', 'in'], ['2026-11-20T09:00:00', 'E01', 'in', 'rejected_rest']], []);
  m.self.sh.events.values.push(['2026-11-20T18:45:00+08:00', 'E02', 'out', '', '', '', '', 'system', '', 'ok', '', 'system_cap']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C4', '別人的系統卡、被擋的上班卡都不算 → 往前 16 小時找不到這個人的上班卡＝照寫（不猜）', [r.ok, r.dup, rows(m).filter((x) => x.source === 'system_cap').length], [true, false, 2]);
}
{
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  m.self.sh.events.values[2][9] = 'rejected_x';
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C5', '已有的那張是被擋的（rejected_*）不算 → 照寫', [r.ok, r.dup], [true, false]);
}
{
  // 順序反過來：mini 先寫 19:00（只看打卡）、Google 的掃描後來才因假單算出 18:45 → capWrite_ 看到這段已有系統卡就不寫，最後留 19:00（比規則晚 15 分）
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E01', 'in']], []);
  m.run(R('apps-script/Cap10.gs')); m.props.REST_CAP_ON = '1';
  const rq = m.self.insertSheet('requests');
  rq.appendRow(['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at']);
  rq.appendRow(['r1', '', 'E01', '', 'leave', '2026-11-20', '特休假', '08:45', '09:00', 0.25, '', '', '', 'approved', '2026-11-19T15:00:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  m.setNow('2026-11-20T19:07:00'); m.sb.capSweep();
  const st = m.sb.handleLiffStatus_({ id_token: 'TOK_U1' }).cap;
  check('C6', 'mini 先寫 19:00、Google 19:07 掃描（因假單應 18:45）→ 不再寫；只留 19:00 一張、打卡頁講 19:00',
    [r.dup, rows(m).filter((x) => x.source === 'system_cap').map((x) => String(x.ts).slice(11, 16)), st.sys_hm], [false, ['19:00'], '19:00']);
}

// ── Codex 第二輪（2026-11-23）：關閉過渡期、晚到的舊卡、16 小時邊界 ──
const sysTs = (m) => rows(m).filter((x) => x.source === 'system_cap').map((x) => String(x.ts));
const lone = (m) => m.sb.pairShifts(rows(m).map((x) => Object.assign({}, x, { ts: m.sb.normCellTs(x.ts) }))).unmatchedOuts.map((e) => String(e.ts).slice(11, 16));
{
  // REST_CAP_ON 已關（world 沒給這個屬性）、mini 還沒拉回新屬性就抄來 19:00：去重不跟開關走
  const send = (m) => m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  const nw = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  const old = capWorld('2026-11-20T19:00:06', [['2026-11-20T09:00:00', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  old.sb.relayGCapSameSeg_ = () => null;   // 改動前（base／main RelayG）的行為：只比單號與 ±60 秒
  const rn = send(nw), ro = send(old);
  check('C7', '關閉過渡期也去重（設計如此）：開關關著、mini 抄來同段 19:00 → 新版回重複、只留 18:45、沒有孤單下班卡；改動前的寫法會變兩張＋19:00 孤單（上班忘刷卡）',
    [nw.props.REST_CAP_ON === undefined, rn.dup, sysTs(nw).length, lone(nw), ro.dup, sysTs(old).length, lone(old)], [true, true, 1, [], false, 2, ['19:00']]);
}
{
  const m = capWorld('2026-11-21T19:30:00', [['2026-11-20T09:00:00', 'E01', 'in'], ['2026-11-21T09:00:00', 'E01', 'in']], ['2026-11-21T19:00:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C8★', '晚到的舊卡：11/20 那段的 19:00 系統卡等到 11/21 那段已收卡後才抄來 → 照寫，不被隔天那段的 19:00 擋掉（段的終點＝下一張上班卡）',
    [r.ok, r.dup, sysTs(m).sort()], [true, false, ['2026-11-20T19:00:00+08:00', '2026-11-21T19:00:00+08:00']]);
}
{
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T03:00:00', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C9', '上班卡剛好在 16 小時前（03:00 → 19:00）＝同一段（同配對上限的 ≤）→ 重複、回 18:45', [r.dup, r.row && r.row.ts, sysTs(m).length], [true, '2026-11-20T18:45:00+08:00', 1]);
}
{
  const m = capWorld('2026-11-20T19:00:06', [['2026-11-20T02:59:59', 'E01', 'in']], ['2026-11-20T18:45:00+08:00']);
  const r = m.sb.handleRelayAppend_({ relay_key: KEY, req_id: 'cap:E01:2026-11-20T19:00:00+08:00', row: CAPROW('2026-11-20T19:00:00+08:00') });
  check('C10★', '上班卡在 16 小時又 1 秒前（短表全讀回來也一樣）＝往前 16 小時內找不到上班卡 → 照寫（逐列篩，不靠讀表停止點）', [r.dup, sysTs(m).length], [false, 2]);
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
  check('C2c2', '員編是陣列／物件不收（2026-11-16）', [m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(28), row: ROW({ emp_id: ['E01'] }) }).error, m.sb.handleRelayAppend_({ relay_key: KEY, req_id: RID(29), row: ROW({ emp_id: {} }) }).error], ['no_emp', 'no_emp']);
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
// ── P3-1 原始列副本（with.rows／with.fp；契約 dzy-mini-playbook contracts/r-line.md）──
{
  const m = make({ now: T('2026-11-20T09:00:00'), props: { REQ_BIND_FROM: 'off', RELAY_KEY: KEY },
    self: { roster: [ME], events: [['2026-11-20T08:00:00', 'E01', 'in']],
      approved: [['2026-11-19', 'E01', '測試一', '09:00-18:00', 8, '正常', '值班主管', '2026-11-19T19:00:00+08:00', '', ''], ['2026-11-19', 'E01', '測試一', '09:00-17:00', 7, '正常', '值班主管', '2026-11-19T20:00:00+08:00', '', '改']],
      leave: [['2026-11-18', '測試一', '特休', 8]],
      managers: [['值班主管', 'MGR-SECRET-0001', 'true', '', 'E09']] } });
  m.run(R('apps-script/RelayG.gs'));
  const plain = m.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true } });
  check('RW1', '沒帶 rows／fp：回應沒有新欄位', ['rows', 'managers', 'fp'].map((k) => k in plain), [false, false, false]);
  const r = m.sb.handleRelayPull_({ relay_key: KEY, with: { rows: true } });
  check('RW2', '三張表筆數（requests 分頁不存在＝空）', [r.rows.approved.total, r.rows.leave.total, r.rows.requests.total, r.rows.requests.rows.length], [2, 1, 0, 0]);
  check('RW3', '主管名單只有白名單欄、整個回應找不到主管金鑰', [Object.keys(r.managers[0]).sort().join(','), JSON.stringify(r).indexOf('MGR-SECRET-0001') < 0], ['__row,active,allow_acting,emp_id,name', true]);
  check('RW4', '指紋格式：同一天兩列', /^2:[0-9a-f]{16}$/.test(r.fp.approved['2026-11-19']), true);
  const f = m.sb.handleRelayPull_({ relay_key: KEY, with: { fp: true } });
  check('RW5', '只要指紋：不帶列、指紋相同', ['rows' in f, 'managers' in f, JSON.stringify(f.fp) === JSON.stringify(r.fp)], [false, false, true]);
  m.self.sh.approved.getRange(3, 5).setValue(6.5);
  const g = m.sb.handleRelayPull_({ relay_key: KEY, with: { fp: true } });
  check('RW6', '改一格 → 那天指紋變、別天不變', [g.fp.approved['2026-11-19'] !== r.fp.approved['2026-11-19'], g.fp.leave['2026-11-18'] === r.fp.leave['2026-11-18']], [true, true]);
  check('RW7', '金鑰類欄名一律不帶', [m.sb.RELAYG_SECRET_COL_RE_.test('key'), m.sb.RELAYG_SECRET_COL_RE_.test('relay_key'), m.sb.RELAYG_SECRET_COL_RE_.test('line_user_id'), m.sb.RELAYG_SECRET_COL_RE_.test('emp_id'), m.sb.RELAYG_SECRET_COL_RE_.test('monkey')], [true, true, true, false, false]);
}

// ── P3-1 部分失敗：一張原始列讀不了，relay_pull 其他內容照常回（fix/relayg-rows-guard）──
{
  const mk = () => {
    const m = make({ now: T('2026-11-20T09:00:00'), props: { REQ_BIND_FROM: 'off', RELAY_KEY: KEY },
      self: { roster: [ME], events: [['2026-11-20T08:00:00', 'E01', 'in']],
        approved: [['2026-11-19', 'E01', '測試一', '09:00-18:00', 8, '正常', '值班主管', '2026-11-19T19:00:00+08:00', '', '']],
        leave: [['2026-11-18', '測試一', '特休', 8]],
        managers: [['值班主管', 'MGR-SECRET-0001', 'true', '', 'E09']] } });
    m.run(R('apps-script/RelayG.gs'));
    return m;
  };
  const boom = (m, nm) => { m.self.sh[nm].getDataRange = () => { throw new Error('Exception: 服務發生錯誤 SECRET-INTERNAL-XYZ'); }; };
  const strip = (r) => { const o = JSON.parse(JSON.stringify(r)); delete o.rows; delete o.fp; delete o.managers; delete o.rows_error; return o; };
  const m0 = mk();
  const base = m0.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true, props: true, sheets: true } });
  const full = m0.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true, props: true, sheets: true, rows: true } });
  check('RG0', '全部成功：沒有 rows_error、其餘內容與不帶 with.rows 相同', ['rows_error' in full, JSON.stringify(strip(full)) === JSON.stringify(strip(base))], [false, true]);

  const m1 = mk(); boom(m1, 'leave');
  const a = m1.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true, props: true, sheets: true, rows: true } });
  check('RG1', '假單讀不了：relay_pull 仍 ok、其餘內容與不帶 with.rows 相同', [a.ok, JSON.stringify(strip(a)) === JSON.stringify(strip(base))], [true, true]);
  check('RG2', '假單標失敗（rows.leave={error}、fp.leave=null、rows_error.leave）、核定與申請照常', [JSON.stringify(a.rows.leave), a.fp.leave, a.rows_error.leave, a.rows.approved.total, !!a.fp.approved['2026-11-19'], a.rows.requests.total, Array.isArray(a.managers)], ['{"error":"read_failed"}', null, 'read_failed', 1, true, 0, true]);
  check('RG3', '失敗標記只有固定碼：整個回應找不到例外訊息原文', [JSON.stringify(a).indexOf('SECRET-INTERNAL') < 0, Object.keys(a.rows_error).join(',')], [true, 'leave']);

  const m2 = mk(); boom(m2, 'approved');
  const b = m2.sb.handleRelayPull_({ relay_key: KEY, with: { fp: true } });
  check('RG4', '只要指紋、核定讀不了：ok、不帶 rows、fp.approved=null、leave 指紋照常、rows_error 有標', [b.ok, 'rows' in b, b.fp.approved, !!b.fp.leave['2026-11-18'], JSON.stringify(b.rows_error)], [true, false, null, true, '{"approved":"read_failed"}']);

  const m4 = mk(); ['approved', 'leave', 'managers'].forEach((n) => boom(m4, n));
  m4.self.sh.requests = (function () { const x = { getDataRange: () => { throw new Error('boom'); }, getSheetId: () => 99, getName: () => 'requests', getLastRow: () => 0, getLastColumn: () => 0 }; return x; })();
  const c = m4.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true, props: true, sheets: true, rows: true } });
  check('RG5', '四張（含主管名單）全丟錯：仍 ok、其餘內容相同、各自標失敗、沒有 managers', [c.ok, JSON.stringify(strip(c)) === JSON.stringify(strip(base)), Object.keys(c.rows_error).sort().join(','), ['approved', 'leave', 'requests'].every((n) => c.rows[n].error === 'read_failed' && c.fp[n] === null), 'managers' in c], [true, true, 'approved,leave,managers,requests', true, false]);

  const m5 = mk(); boom(m5, 'managers');
  const d = m5.sb.handleRelayPull_({ relay_key: KEY, with: { rows: true } });
  check('RG6', '只有主管名單讀不了：三張表照常、沒有 managers、rows_error.managers', [d.ok, d.rows.approved.total, d.rows.leave.total, 'managers' in d, JSON.stringify(d.rows_error)], [true, 1, 1, false, '{"managers":"read_failed"}']);

  const m6 = mk(); boom(m6, 'leave');
  const e = m6.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true } });
  check('RG7', '不帶 rows／fp：完全不讀這幾張，壞表也不影響、沒有新欄位', [e.ok, ['rows', 'managers', 'fp', 'rows_error'].map((k) => k in e)], [true, [false, false, false, false]]);
}
done();
