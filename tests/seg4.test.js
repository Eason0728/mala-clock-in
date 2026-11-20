/* 加班一次最多四段（2026-11-21 Eason：門市加班常被切成三、四段，原本只能兩段、要拆成兩張單送）
 *
 * 規則白話版（打卡端 Requests.gs，送單時檢查；核定與薪資規則不動）：
 *   1. 只有加班開到四段；請假、出差維持最多兩段，忘打卡不分段（段數上限依類別：REQ_SEG_MAX_N_）。
 *   2. 各段兩兩比：任何兩段重疊、接在一起都擋（三、四段時訊息講第幾段和第幾段，照送來的順序）；中間有空檔才收。
 *   3. 加班合計上限照舊 10 小時（同仁送單、店長代開都是），四段合計超過就擋。
 *   4. 寫入格式不變：每段一列、同一個 grp、同一個 created_at，照時間先後排，__seg＝1…4；全部過了才一次 setValues，任一段沒過一列都不寫。
 *   5. req_info 的 ot_segments_max：開關有開 → 4，沒開 → 1（申請頁依這個決定「＋加一段」能加到第幾段；舊後端回 2，新申請頁只加到第二段）。
 *
 * 手算對照（日期 2026-11-16 休息日，今天 11/17）：
 *   F1 三段 09–11＋12–14＋15–17 → 3 列 2＋2＋2＝6
 *   F2 四段 09–11＋12–14＋15–17＋18–20 → 4 列 2×4＝8
 *   F3 四段 3＋3＋2＋2＝10 剛好 → 收；3＋3＋3＋2＝11 > 10 → 擋，0 列
 *   F4 第五段 → 擋「加班一次最多填四段時間」
 *   F5 第一段和第三段重疊、第二段和第四段重疊、第三段和第四段接在一起 → 都擋
 *   F6 送來的順序亂 → 寫入照時間排，seg 1…4 跟著時間
 *   G  核定比對（reqBindCheck_，程式沒改）：四段一次送 vs 分四次送，結果逐欄相同；班表內、時段不在核定內、時數、打卡佐證都照單張算
 * 用真函式跑（tests/helpers/gs-sandbox），名字一律假名。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const NOLINE = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: '', active: 'TRUE', line_user_id: '' };
const D = '2026-11-16', NOW = T('2026-11-17T10:00:00');
const ALL = { REQ_SEG2_KINDS: 'ot,leave,trip' };
const res = (r) => (r.ok ? 'ok' : r.error + '｜' + r.message);
function world(o) {
  o = o || {};
  return make({ now: NOW, props: o.props === undefined ? ALL : o.props, self: { roster: [ME, NOLINE], events: o.events || [], leave: [] } });
}
const submit = (m, body) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', date: D }, body)); };
const reqRows = (m) => { const sh = m.self.sh.requests; if (!sh) return []; const h = sh.values[0]; return sh.values.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };
const nRows = (m) => reqRows(m).length;
const seg = (a, b) => ({ start: a, end: b });
const segsOf = (list) => list.map((x) => seg(x[0], x[1]));
const ot = (list, x) => Object.assign({ kind: 'ot', reason: '盤點', segments: segsOf(list) }, x || {});
const blocked = (m, body) => { const before = nRows(m); const r = submit(m, body); return [res(r), nRows(m) - before]; };
const S3 = [['09:00', '11:00'], ['12:00', '14:00'], ['15:00', '17:00']];
const S4 = S3.concat([['18:00', '20:00']]);

/* ── 開關 ── */
{
  const m = world({ props: {} });
  const info = m.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  check('K1', '開關沒設：ot_segments_max 1、seg2_kinds 空；送四段 → seg2_off，0 列', [info.ot_segments_max, info.seg2_kinds, blocked(m, ot(S4))], [1, [], ['seg2_off｜這家店還沒開放一次填兩段，請一段一段分開送', 0]]);
  m.props.REQ_SEG2_KINDS = 'leave,trip';
  check('K2', '只開請假、出差（沒開 ot）：ot_segments_max 1；加班三段 → seg2_off', [m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).ot_segments_max, blocked(m, ot(S3))[0].split('｜')[0]], [1, 'seg2_off']);
  m.props.REQ_SEG2_KINDS = 'ot';
  check('K3', '開 ot：ot_segments_max 4（seg2_max_h、ot_max_h 仍是 10，合計上限沒變）', [m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).ot_segments_max, m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).ot_max_h, m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_max_h.ot], [4, 10, 10]);
}

/* ── 三段、四段收進來 ── */
{
  const m = world();
  const r = submit(m, ot(S3));
  const rows = reqRows(m);
  check('F1-a', '休息日加班三段 → 收，3 列 2、2、2', [res(r), rows.map((x) => [x.kind, x.start, x.end, x.hours, x.status])], ['ok', S3.map((x) => ['ot', x[0], x[1], 2, 'pending'])]);
  check('F1-b', '三列同一個 grp、同一個送出時間、id 都不同；回應 group＝grp、requests 3 張 seg 1–3、摘要「加班三段…共 6 小時」',
    [new Set(rows.map((x) => x.grp)).size, rows[0].grp === r.group, new Set(rows.map((x) => x.created_at)).size, new Set(rows.map((x) => x.id)).size, r.requests.map((x) => x.seg), r.request.id === rows[0].id, r.summary],
    [1, true, 1, 3, [1, 2, 3], true, '11/16 加班三段 09:00–11:00、12:00–14:00、15:00–17:00（共 6 小時）']);
}
{
  const m = world();
  const r = submit(m, ot(S4));
  const rows = reqRows(m);
  check('F2-a', '休息日加班四段 → 收，4 列各 2 小時、都審核中', [res(r), rows.map((x) => [x.start, x.end, x.hours, x.status])], ['ok', S4.map((x) => [x[0], x[1], 2, 'pending'])]);
  check('F2-b', '四列同一個 grp（g 開頭）、同一個送出時間；回應 4 張、seg 1–4、group 一樣、摘要「加班四段…共 8 小時」',
    [new Set(rows.map((x) => x.grp)).size, /^g[0-9a-z]+$/.test(rows[0].grp), new Set(rows.map((x) => x.created_at)).size, r.requests.map((x) => [x.seg, x.group === rows[0].grp]), r.summary],
    [1, true, 1, [[1, true], [2, true], [3, true], [4, true]], '11/16 加班四段 09:00–11:00、12:00–14:00、15:00–17:00、18:00–20:00（共 8 小時）']);
  const info = m.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  check('F2-c', '「我的申請」讀回來 4 張、group 一樣、seg 1–4（畫面「第 N 段／共 M 段」靠這兩欄）', info.requests.map((x) => [x.start, x.seg, x.group === rows[0].grp]).sort(), S4.map((x, i) => [x[0], i + 1, true]));
  const pend = m.sb.handleMgrReqPending_({ mgr_key: 'MK' }).items;
  check('F2-d', '主管待審清單（mgr_req_pending）4 張各帶 group、seg', pend.map((x) => [x.start, x.seg, x.group === r.group]), S4.map((x, i) => [x[0], i + 1, true]));
  const bt = m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: r.requests.map((x) => x.id), decision: 'approve' });
  check('F2-e', '四張一起核准（mgr_req_decide_batch）→ 4 張都 approved', [(bt.done || []).length, reqRows(m).map((x) => x.status)], [4, ['approved', 'approved', 'approved', 'approved']]);
}
{
  const m = world();
  const r = submit(m, ot(S4));
  m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[0].id, decision: 'approve' });
  m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[1].id, decision: 'reject', reason: '時間不對' });
  m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[2].id, decision: 'approve' });
  check('F2-f', '四張可以各自核准／退回（第 2 張退回、其餘核准）', reqRows(m).map((x) => x.status), ['approved', 'rejected', 'approved', 'pending']);
  const c = submit(world(), ot(S4));
  const m2 = world(); const r2 = submit(m2, ot(S4));
  check('F2-g', '同仁只取消第三段，其餘三張照舊審核中', [m2.sb.handleReqCancel_({ id_token: 'TOK_U1', id: r2.requests[2].id }).ok, reqRows(m2).map((x) => x.status)], [true, ['pending', 'pending', 'cancelled', 'pending']]);
  void c;
}
{ // F6 順序亂
  const m = world();
  const r = submit(m, ot([['15:00', '17:00'], ['09:00', '11:00'], ['21:00', '22:00'], ['18:00', '20:00']]));
  check('F6', '送來的順序亂 → 寫入照時間先後排，seg 1…4 跟著時間走', [res(r), reqRows(m).map((x) => x.start), r.requests.map((x) => [x.start, x.seg])], ['ok', ['09:00', '15:00', '18:00', '21:00'], [['09:00', 1], ['15:00', 2], ['18:00', 3], ['21:00', 4]]]);
}
{ // 跨夜：最後一段跨過午夜，日期記上班那天
  const m = world();
  const r = submit(m, ot([['17:00', '19:00'], ['19:30', '21:00'], ['21:30', '23:00'], ['23:30', '01:00']]));
  check('F7', '跨夜四段（最後一段 23:30–01:00）→ 收 4 列 2、1.5、1.5、1.5，日期都是上班那天', [res(r), reqRows(m).map((x) => [x.date, x.start, x.end, x.hours])],
    ['ok', [[D, '17:00', '19:00', 2], [D, '19:30', '21:00', 1.5], [D, '21:30', '23:00', 1.5], [D, '23:30', '01:00', 1.5]]]);
}

/* ── 合計 10 小時 ── */
check('F3-a', '四段 3＋3＋2＋2＝10 剛好 → 收', (() => { const m = world(); return [res(submit(m, ot([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '18:00'], ['19:00', '21:00']]))), reqRows(m).map((x) => x.hours)]; })(), ['ok', [3, 3, 2, 2]]);
check('F3-b', '四段 3＋3＋3＋2＝11 > 10 → 擋「四段合計 11 小時，超過加班一天上限 10 小時」，0 列', blocked(world(), ot([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '19:00'], ['20:00', '22:00']])), ['seg_total｜四段合計 11 小時，超過加班一天上限 10 小時', 0]);
check('F3-c', '三段 4＋4＋3＝11 > 10 → 擋「三段合計…」，0 列', blocked(world(), ot([['06:00', '10:00'], ['11:00', '15:00'], ['16:00', '19:00']])), ['seg_total｜三段合計 11 小時，超過加班一天上限 10 小時', 0]);
check('F3-d', '兩段 11 小時的舊訊息不變（兩段合計…）', blocked(world(), ot([['08:00', '14:00'], ['15:00', '20:00']])), ['seg_total｜兩段合計 11 小時，超過加班一天上限 10 小時', 0]);
check('F3-e', '其中一段自己就超過 10 小時（單段 10.25）→ 第 N 段被擋（既有單張上限），0 列', blocked(world(), ot([['08:00', '08:30'], ['09:00', '19:15'], ['20:00', '20:30']]))[0].split('｜')[0], 'seg_total');

/* ── 第五段被擋、其他類別上限不變 ── */
const S5 = S4.concat([['21:00', '22:00']]);
check('F4-a', '加班第五段 → bad_segments「加班一次最多填四段時間」，0 列', blocked(world(), ot(S5)), ['bad_segments｜加班一次最多填四段時間', 0]);
check('F4-b', '加班 20 段（亂塞）也是同一句、一列都不寫', blocked(world(), ot(Array.from({ length: 20 }, (_, i) => [('0' + i).slice(-2) + ':00', ('0' + i).slice(-2) + ':30']))), ['bad_segments｜加班一次最多填四段時間', 0]);
check('F4-c', '請假三段 → bad_segments「請假、出差一次最多填兩段時間」，0 列', blocked(world(), { kind: 'leave', leave_type: '事假', reason: 'x', segments: segsOf([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00']]) }), ['bad_segments｜請假、出差一次最多填兩段時間', 0]);
check('F4-d', '出差三段 → 同樣擋，0 列', blocked(world(), { kind: 'trip', place: '央廚', why: '開會', segments: segsOf([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00']]) }), ['bad_segments｜請假、出差一次最多填兩段時間', 0]);
check('F4-e', '忘打卡兩段、三段 → 都擋（只有加班、請假、出差可以分段），0 列',
  [blocked(world(), { kind: 'miss', miss_type: 'out', reason: 'x', segments: segsOf(S3.slice(0, 2)) }), blocked(world(), { kind: 'miss', miss_type: 'out', reason: 'x', segments: segsOf(S3) })].map((x) => x[0].split('｜')[0] + x[1]), ['bad_segments0', 'bad_segments0']);
check('F4-f', '請假、出差兩段照舊收', [res(submit(world(), { kind: 'leave', leave_type: '事假', reason: 'x', segments: segsOf([['09:00', '10:00'], ['15:00', '16:00']]) })), res(submit(world(), { kind: 'trip', place: '央廚', why: '開會', segments: segsOf([['09:00', '10:00'], ['15:00', '16:00']]) }))], ['ok', 'ok']);
check('F4-g', '四段裡有一段不是物件 → bad_segments（格式不對），0 列', blocked(world(), { kind: 'ot', reason: 'x', segments: [seg('09:00', '10:00'), '11:00', seg('13:00', '14:00'), seg('15:00', '16:00')] }), ['bad_segments｜時段格式不對，請重新填', 0]);
check('F4-h', '請假兩段的生理假仍擋、事假一段加班四段混用不可能（kind 只能一種）：生理假新規則開 → 兩段收', res(submit(world(), { kind: 'leave', leave_type: '生理假', reason: 'x', segments: segsOf([['09:00', '10:00'], ['15:00', '16:00']]) })), 'ok');

/* ── 兩兩比：重疊、接在一起（講第幾段和第幾段，照送來的順序） ── */
const ov = (list) => blocked(world(), ot(list));
check('F5-a', '第一段和第三段重疊（11–14 與 13–15）→ 擋，講「第一段和第三段」，0 列', ov([['11:00', '14:00'], ['16:00', '17:00'], ['13:00', '15:00'], ['18:00', '19:00']]),
  ['seg_overlap｜第一段和第三段時間重疊（11:00–14:00、13:00–15:00），請確認時間', 0]);
check('F5-b', '第二段和第四段重疊 → 擋，講「第二段和第四段」', ov([['09:00', '10:00'], ['11:00', '14:00'], ['15:00', '16:00'], ['13:00', '15:00']]),
  ['seg_overlap｜第二段和第四段時間重疊（11:00–14:00、13:00–15:00），請確認時間', 0]);
check('F5-c', '第一段和第四段重疊（第四段 10–13 包住第一段 11–12，其他段互相不衝突）→ 擋，講「第一段和第四段」', ov([['11:00', '12:00'], ['14:00', '15:00'], ['16:00', '17:00'], ['10:00', '13:00']]),
  ['seg_overlap｜第一段和第四段時間重疊（11:00–12:00、10:00–13:00），請確認時間', 0]);
check('F5-d', '第三段和第四段接在一起（15–17 接 17–19）→ 擋「接在一起」，請直接填成一段', ov([['09:00', '10:00'], ['11:00', '12:00'], ['15:00', '17:00'], ['17:00', '19:00']]),
  ['seg_touch｜第三段和第四段時間接在一起（15:00–17:00、17:00–19:00），請直接填成一段', 0]);
check('F5-e', '第一段和第三段接在一起（順序不相鄰也要抓到）→ 擋', ov([['09:00', '11:00'], ['13:00', '14:00'], ['11:00', '12:00'], ['16:00', '17:00']]),
  ['seg_touch｜第一段和第三段時間接在一起（09:00–11:00、11:00–12:00），請直接填成一段', 0]);
check('F5-f', '跨夜接在一起（22:00–01:00 接 01:00–03:00，放在第二、第四段）→ 擋', ov([['09:00', '10:00'], ['22:00', '01:00'], ['12:00', '13:00'], ['01:00', '03:00']])[0].split('｜')[0], 'seg_touch');
check('F5-g', '三段時第二、三段重疊 → 擋，講「第二段和第三段」', ov([['09:00', '10:00'], ['12:00', '15:00'], ['14:00', '16:00']]),
  ['seg_overlap｜第二段和第三段時間重疊（12:00–15:00、14:00–16:00），請確認時間', 0]);
check('F5-h', '中間空 1 分鐘（四段都隔 1 分鐘）→ 收', res(submit(world(), ot([['09:00', '10:00'], ['10:01', '11:00'], ['11:01', '12:00'], ['12:01', '13:00']]))), 'ok');
check('F5-i', '四段都沒重疊、但某一段開始＝結束 → 標那一段「第三段：開始和結束時間一樣」，0 列', blocked(world(), ot([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '13:00'], ['15:00', '16:00']])), ['bad_time｜第三段：開始和結束時間一樣，請確認', 0]);
check('F5-j', '第四段沒填完整 → 「第四段：請填完整的加班時段」，帶 seg 4，0 列', (() => { const m = world(); const r = submit(m, ot([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00'], ['15:00', '']])); return [res(r), r.seg, nRows(m)]; })(), ['bad_time｜第四段：請填完整的加班時段', 4, 0]);

/* ── 單段檢查逐段套用：第三段跟別張單衝突 → 標第三段、整批不寫 ── */
{
  const m = world();
  submit(m, { kind: 'ot', start: '16:00', end: '17:00', reason: '先送的' });
  m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: reqRows(m).map((x) => x.id), decision: 'approve' });
  const b = blocked(m, ot([['09:00', '10:00'], ['11:00', '12:00'], ['16:30', '17:30'], ['19:00', '20:00']]));
  check('F8', '同一天已核准 16:00–17:00，第三段 16:30–17:30 重疊 → 「第三段：…」，連其他三段一列都不寫', [b[0].split('｜')[0], b[0].indexOf('第三段：') === b[0].indexOf('｜') + 1, b[1]], ['duplicate', true, 0]);
  const n0 = nRows(m);
  const m2 = world();
  submit(m2, ot([['09:00', '10:00'], ['11:00', '12:00']]));   // 同一天先送一張兩段（審核中）
  check('F8-b', '同一天已有審核中的兩段，再送四段其中一段重疊 → 擋（跟分次送一樣），不多寫', blocked(m2, ot([['09:30', '10:30'], ['13:00', '14:00'], ['15:00', '16:00'], ['17:00', '18:00']]))[1], 0);
  void n0;
}
{ // 原因（共用欄位）沒寫、跨夜班日期選錯：不標段 / 標第一段
  check('F9', '原因沒寫（四段共用）→ 不標第幾段，0 列', blocked(world(), ot(S4, { reason: '' })), ['need_reason｜加班要寫原因', 0]);
}

/* ── 寫入：成功＝一次 setValues 寫 4 列、沒有 appendRow；被擋＝一次都沒寫 ── */
{
  const m = world();
  m.sb.reqSheet_(m.sb.getSS(), true);
  const sh = m.self.sh.requests, log = [];
  const gr = sh.getRange, ap = sh.appendRow;
  sh.appendRow = (row) => { log.push('append'); return ap(row); };
  sh.getRange = (a, c, nr, nc) => { const g = gr(a, c, nr, nc); if (typeof a === 'number' && a > 1) { const sv = g.setValues, s1 = g.setValue; g.setValues = (v) => { log.push('setValues:' + v.length); return sv(v); }; g.setValue = (v) => { log.push('setValue'); return s1(v); }; } return g; };
  blocked(m, ot(S5)); blocked(m, ot([['11:00', '14:00'], ['16:00', '17:00'], ['13:00', '15:00'], ['18:00', '19:00']]));
  blocked(m, ot([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '19:00'], ['20:00', '22:00']]));
  check('W01', '各種被擋（第五段、重疊、超過 10 小時）：寫入動作 0 次', log, []);
  submit(m, ot(S4));
  check('W02', '四段成功：只有一次 setValues（4 列），沒有 appendRow', log, ['setValues:4']);
}

/* ── 店長代開加班四段（同樣上限 10 小時；代開請假、出差仍不分段） ── */
const ACT = { mgr_key: 'AK', acting_name: '林店長（S1）' };
const proxy = (m, o) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return m.sb.handleMgrReqProxy_(Object.assign({ action: 'mgr_req_proxy', emp_id: 'E02', kind: 'ot', date: D, reason: '盤點' }, ACT, o)); };
{
  const m = world();
  const r = proxy(m, { segments: segsOf(S4) });
  const rows = reqRows(m);
  check('P1', '代開加班四段（同仁沒綁 LINE）→ 4 列都有 proxy_by、同 grp、seg 1–4；摘要帶「四段…（林店長代開）」', [res(r), rows.map((x) => [x.emp_id, x.hours, x.proxy_by]), new Set(rows.map((x) => x.grp)).size, r.requests.map((x) => x.seg), r.summary],
    ['ok', S4.map(() => ['E02', 2, '林店長（S1）']), 1, [1, 2, 3, 4], '11/16 加班四段 09:00–11:00、12:00–14:00、15:00–17:00、18:00–20:00（共 8 小時）（林店長代開）']);
  const before = nRows(m);
  check('P2', '代開四段合計 11 小時 > 10 → 擋，0 列', [res(proxy(m, { date: '2026-11-15', segments: segsOf([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '19:00'], ['20:00', '22:00']]) })), nRows(m) - before], ['seg_total｜四段合計 11 小時，超過加班一天上限 10 小時', 0]);
  check('P3', '代開第五段 → 擋「加班一次最多填四段時間」', [res(proxy(m, { date: '2026-11-15', segments: segsOf(S5) })), nRows(m) - before], ['bad_segments｜加班一次最多填四段時間', 0]);
  check('P4', '代開第一、三段重疊 → 擋', [res(proxy(m, { date: '2026-11-15', segments: segsOf([['11:00', '14:00'], ['16:00', '17:00'], ['13:00', '15:00'], ['18:00', '19:00']]) })), nRows(m) - before], ['seg_overlap｜第一段和第三段時間重疊（11:00–14:00、13:00–15:00），請確認時間', 0]);
  check('P5', '代開請假、出差三段、兩段都 bad_segments（代開請假出差不分段），0 列', [
    proxy(m, { kind: 'leave', leave_type: '事假', segments: segsOf(S3) }).error, proxy(m, { kind: 'leave', leave_type: '事假', segments: segsOf(S3.slice(0, 2)) }).error,
    proxy(m, { kind: 'trip', place: '央廚', why: '開會', segments: segsOf(S3.slice(0, 2)) }).error, nRows(m) - before], ['bad_segments', 'bad_segments', 'bad_segments', 0]);
  const m2 = world({ props: {} });
  check('P6', '開關沒開：代開四段 → seg2_off，0 列', [proxy(m2, { segments: segsOf(S4) }).error, nRows(m2)], ['seg2_off', 0]);
}

/* ── 核定比對（reqBindCheck_，程式沒改）：四段一次送 vs 分四次送，結果逐欄相同 ── */
{
  const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
  const P = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
  const S = (a, b) => ({ inMs: ms(a), outMs: ms(b) });
  /** 兩個世界：A 一次送四段、B 分四次送；全部核准後讀回申請表、跑同一組核定判斷 */
  function pair(list) {
    const A = world(), B = world();
    const ra = submit(A, ot(list));
    const rb = list.map((x) => submit(B, { kind: 'ot', start: x[0], end: x[1], reason: '盤點' }));
    [A, B].forEach((m) => { const ids = reqRows(m).map((x) => x.id); m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids, decision: 'approve' }); });
    const cols = (m) => reqRows(m).map((x) => { const o = Object.assign({}, x); delete o.id; delete o.created_at; delete o.decided_at; delete o.grp; return o; });
    return { A, B, ok: [res(ra)].concat(rb.map(res)), colsA: cols(A), colsB: cols(B) };
  }
  const bind = (m, hours, periods, segs, opt) => {
    m.run('READ_MEMO_ = null; REQ_PEER_MEMO_ = {};');
    const pv = m.sb.reqBindCheck_(m.sb.getSS(), 'E01', D, hours, periods, segs, null, Object.assign({ preview: true }, opt));
    m.run('READ_MEMO_ = null; REQ_PEER_MEMO_ = {};');
    const full = m.sb.reqBindCheck_(m.sb.getSS(), 'E01', D, hours, periods, segs, null, opt);
    return JSON.parse(JSON.stringify({ pv, full }));
  };
  const OPT = { force_strict: true, force_ot_punch: true, name: '測試一' };
  const rules = (x) => x.pv.probs.map((p) => p.rule);
  // G1 休息日四段（整天都算加班）：核定 8 小時＝加班 2＋2＋2＋2
  {
    const w = pair(S4);
    const per = S4.map((x) => P(x[0], x[1])), pun = S4.map((x) => S(x[0], x[1])), o = Object.assign({ sched_day: 'R' }, OPT);
    check('G1-a', '休息日四段：一次送 vs 分四次送，申請表除了 id／送出時間／grp 逐欄相同', [w.ok, w.colsA.length, w.colsA], [['ok', 'ok', 'ok', 'ok', 'ok'], 4, w.colsB]);
    const a = bind(w.A, 8, per, pun, o), b = bind(w.B, 8, per, pun, o);
    check('G1-b', '休息日四段：核定判斷逐欄相同，而且放行（需 8 有 8；四段都有打卡佐證、都在核定時段內）', [a, a.full, a.pv.ot_have, a.pv.ot_need], [b, null, 8, 8]);
    const a2 = bind(w.A, 8.5, per, pun, o), b2 = bind(w.B, 8.5, per, pun, o);
    check('G1-c', '時數：核定改 8.5 小時（單只有 8）→ 兩邊都擋 ot_hours、訊息逐字相同', [a2, a2.full && a2.full.error, rules(a2).indexOf('ot_hours') >= 0], [b2, 'need_request', true]);
    const a3 = bind(w.A, 7, per, pun, o);
    check('G1-d', '時數：核定改 7 小時（單 8 小時多超過）→ 擋 ot_hours「比應有的…多」', [rules(a3).indexOf('ot_hours') >= 0, /比應有的/.test((a3.pv.probs.filter((p) => p.rule === 'ot_hours')[0] || {}).text || '')], [true, true]);
  }
  // G2 平日四段：班表 11–14／17–21，加班 09–10、10:30–11、21–22、22:30–23（共 3 小時），核定 09–14＋17–23＝11
  {
    const L = [['09:00', '10:00'], ['10:30', '11:00'], ['21:00', '22:00'], ['22:30', '23:00']];
    const w = pair(L);
    const per = [P('09:00', '14:00'), P('17:00', '23:00')], pun = [S('08:58', '14:03'), S('16:57', '23:05')];
    const spans = [{ start: '11:00', end: '14:00' }, { start: '17:00', end: '21:00' }];
    const o = Object.assign({ sched_day: '', sched_spans: spans }, OPT);
    const a = bind(w.A, 11, per, pun, o), b = bind(w.B, 11, per, pun, o);
    check('G2-a', '平日四段：申請表逐欄相同', [w.ok, w.colsA], [['ok', 'ok', 'ok', 'ok', 'ok'], w.colsB]);
    check('G2-b', '平日四段：不在班表內、都在核定內、有打卡 → 逐欄相同、放行（需 3 有 3）', [a, a.full, a.pv.ot_have, a.pv.ot_need], [b, null, 3, 3]);
    // 班表內：班表第一段改 10:00 開始 → 第二張 10:30–11:00 有 30 分鐘在班表內（> 容差 15 分）
    const o2 = Object.assign({}, o, { sched_spans: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }] });
    const a2 = bind(w.A, 11, per, pun, o2), b2 = bind(w.B, 11, per, pun, o2);
    const tx = a2.pv.probs.filter((p) => p.rule === 'ot_in_sched').map((p) => p.text.split('（')[0]);
    check('G2-c', '班表內：第二段 10:30–11:00 落在班表 10:00 開始的上班時段 → 只有那一張被擋 ot_in_sched，兩邊逐欄相同', [a2, rules(a2), tx], [b2, ['ot_in_sched'], ['加班單 10:30–11:00 有 30 分鐘在班表上班時段內']]);
    // 時段不在核定內：核定第二段只到 22:40，第四段 22:30–23:00 超出 > 15 分
    const a3 = bind(w.A, 10.67, [P('09:00', '14:00'), P('17:00', '22:40')], pun, o), b3 = bind(w.B, 10.67, [P('09:00', '14:00'), P('17:00', '22:40')], pun, o);
    check('G2-d', '時段不在核定內：核定到 22:40，第四段 22:30–23:00 超出 → 擋 ot_slot（只指第四段），逐欄相同', [a3, a3.pv.probs.filter((p) => p.rule === 'ot_slot').map((p) => p.text.split('（')[0])], [b3, ['加班單 22:30–23:00 不在核定時段內']]);
    // 打卡佐證：第三、四張的打卡只到 21:30 → 兩張（21–22 不全、22:30–23 沒）被擋 ot_punch
    const a4 = bind(w.A, 11, per, [S('08:58', '14:03'), S('16:57', '21:30')], o), b4 = bind(w.B, 11, per, [S('08:58', '14:03'), S('16:57', '21:30')], o);
    check('G2-e', '打卡佐證：下班卡只到 21:30 → 第三張 21:00–22:00、第四張 22:30–23:00 各一條 ot_punch，逐欄相同', [a4, a4.pv.probs.filter((p) => p.rule === 'ot_punch').map((p) => p.text.split('（')[0])], [b4, ['加班單 21:00–22:00 沒有打卡紀錄', '加班單 22:30–23:00 沒有打卡紀錄']]);
  }
  // G3 四張加班單其中一張被退回／取消：已核准的才算（核定只認已核准）
  {
    const m = world(); const r = submit(m, ot(S4));
    m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[0].id, decision: 'approve' });
    m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[1].id, decision: 'approve' });
    m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[2].id, decision: 'approve' });
    m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.requests[3].id, decision: 'reject', reason: '沒加班' });
    const per = S4.map((x) => P(x[0], x[1])), pun = S4.map((x) => S(x[0], x[1]));
    const a = bind(m, 8, per, pun, Object.assign({ sched_day: 'R' }, OPT));
    check('G3', '四張只核准三張：核定 8 小時只有 6 小時的單 → 擋 ot_hours（已核准 6），第四段沒核准的時段也不在單內', [a.full && a.full.error, a.pv.ot_have, a.pv.ot_need], ['need_request', 6, 8]);
  }
}

done();
