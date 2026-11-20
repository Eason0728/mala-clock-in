/* 一次填兩段（2026-11-18 Eason；設計「一次填兩段」第 2 版＋最終決定 N1–N5，docs/decisions/0002-一次填兩段-20261118.md）
 *
 * 規則白話版（打卡端 Requests.gs，送單時檢查；核定與薪資規則不動）：
 *   1. 同仁一天有兩段加班／請假／出差，可以一次送出（segments 兩段）→ 系統拆成兩張普通的單，各自照現有規則檢查。
 *      第二段檢查時，把第一段當成一張「審核中」的單一起比（＝分兩次送時第二張看到的樣子）。
 *   2. 兩段都過才寫，一次寫兩列（同一個 grp、同一個送出時間、照時間先後排）；任一段沒過，一列都不寫，訊息標「第一段／第二段：」。
 *   3. 上限：加班單張 10 小時、兩段合計 10 小時（同仁送單與店長代開都是 10，N1 更正）；
 *      請假兩段合計 8、出差兩段合計 8（N2）；單段上限照舊（請假 12、出差 8）。
 *   4. 兩段重疊、或接在一起（一段結束＝另一段開始）→ 擋；中間有空檔就收。跨夜（22:00–01:00）照現在的算法，日期記上班那天。
 *   5. 不開放兩段：忘打卡、生理假（一天只算一次）、請假出差的「整天／只填時數」、店長代開的請假出差（N3）。
 *   6. 開關：每店指令碼屬性 REQ_SEG2_KINDS（ot,leave,trip）；沒設＝全關，送兩段一律擋 seg2_off、一列不寫，跟現在完全一樣。
 *   （2026-11-21 起加班可以填到四段，請假、出差仍兩段；加班三、四段的規則見 seg4.test.js）
 *   7. 只填一段：寫入的每一欄跟現在相同（多一個空白的 grp 欄）；只有 N1 單張加班上限 12→10、N4 拿掉「本月第幾次事假」提醒。
 *
 * 手算對照（日期 2026-11-16，今天 11/17）：
 *   H1 休息日 11:00–14:00＋17:00–21:00 → 2 列 3＋4＝7；核定 7 小時（休息日整天算加班）需 7 有 7 → 核定放行
 *   H2 平日班表 10–14／17–21，加班 09:00–10:00＋21:00–22:30 → 2 列 1＋1.5＝2.5；核定 10.5 小時，需 2.5 有 2.5 → 放行
 *   H3 11:00–14:00＋13:00–15:00 → 重疊 13:00–14:00 → 0 列
 *   H4 08:00–14:00＋15:00–20:00 → 6＋5＝11 > 10 → 0 列
 *   H5 17:00–20:00＋22:00–01:00 → 3＋3＝6（跨夜 22→01 是 3 小時）→ 2 列
 *   H6 11:00–14:00＋14:00–17:00 → 接在一起 → 0 列；H7 22:00–01:00＋01:00–03:00 → 跨夜也接在一起 → 0 列
 *   H8 08:00–13:00＋14:00–19:00 → 5＋5＝10，剛好 10 → 2 列；單張 08:00–18:15＝10.25 > 10 → 擋（N1）
 *   L1 病假 09:00–11:00＋15:00–17:00、附 1 張證明 → 2 列 2＋2＝4，兩列同一個 attach_id；核定登記病假 4＝單 2＋2 → 放行
 *   L2 事假 09:00–13:00＋14:00–19:00 → 4＋5＝9 > 8 → 0 列
 *   L3 家庭照顧假剩 3 小時，送 2＋2＝4 > 3 → 0 列；送 1＋2＝3 → 收（分兩次送：第二張 2 > 剩 1 被擋，結果一樣）
 *   L4 生理假兩段 → 擋（一天只算一次）
 *   T1 出差 09:00–12:00＋13:00–16:00 台北瑞光 → 2 列 3＋3＝6；核定登記出差 6＝單 6 → 放行
 *   T2 出差 08:00–12:00＋13:00–18:00 → 4＋5＝9 > 8 → 0 列
 *   P1 代開加班 11:00–14:00＋17:00–21:00 → 2 列都有 proxy_by、同 grp；P2 代開 08:00–14:00＋15:00–20:00＝11 > 10 → 0 列
 * 用真函式跑（tests/helpers/gs-sandbox），名字一律假名。 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const { make, T, check, done, ROOT } = require('./helpers/gs-sandbox');

const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const NOLINE = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: '', active: 'TRUE', line_user_id: '' };
const D = '2026-11-16', NOW = T('2026-11-17T10:00:00');
const ALL = { REQ_SEG2_KINDS: 'ot,leave,trip' };
const res = (r) => (r.ok ? 'ok' : r.error + '｜' + r.message);
const ATT = 'ATTACH_abcdefghij';
function world(o) {
  o = o || {};
  const quota = o.quota;
  return make({ now: NOW, props: o.props === undefined ? ALL : o.props,
    self: { roster: [ME, NOLINE], events: o.events || [], leave: o.leave || [] },
    fetch: (url, opt) => {
      let b = null; try { b = JSON.parse(opt.payload); } catch (e) { return undefined; }
      if (b && b.action === 'line_hub_req_quota') return { ok: true, quota: quota || [], annual_from: '' };
      return undefined;
    } });
}
const submit = (m, body) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', date: D }, body)); };
const reqRows = (m) => { const sh = m.self.sh.requests; if (!sh) return []; const h = sh.values[0]; return sh.values.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };
const nRows = (m) => reqRows(m).length;
const seg = (a, b) => ({ start: a, end: b });
const otS = (a, b, x) => Object.assign({ kind: 'ot', reason: '盤點', segments: [seg(a[0], a[1]), seg(b[0], b[1])] }, x || {});
const lvS = (t, a, b, x) => Object.assign({ kind: 'leave', leave_type: t, reason: '看醫生', segments: [seg(a[0], a[1]), seg(b[0], b[1])] }, x || {});
const tpS = (a, b, x) => Object.assign({ kind: 'trip', place: '台北瑞光', why: '開會', segments: [seg(a[0], a[1]), seg(b[0], b[1])] }, x || {});
/** 兩段被擋：回 [錯誤碼｜訊息, 寫入列數] */
const blocked = (m, body) => { const before = nRows(m); const r = submit(m, body); return [res(r), nRows(m) - before]; };

/* ── 開關 ── */
{
  const m = world({ props: {} });
  const info = m.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  check('S01', '開關沒設：req_info.seg2_kinds 空、ot_segments_max 1、上限欄位照帶', [info.seg2_kinds, info.ot_segments_max, info.ot_max_h, info.seg2_max_h, info.seg2_no_types], [[], 1, 10, { ot: 10, leave: 8, trip: 8 }, []]);   // 2026-11-18 生理假新規則：生理假開放兩段（原預期 ['生理假']）
  m.props.REQ_MENS_RULES = 'off';
  check('S01-off', '生理假新規則緊急開關 off：seg2_no_types 回到 [生理假]', m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_no_types, ['生理假']);
  delete m.props.REQ_MENS_RULES;
  check('S02', '開關沒設：送加班兩段 → seg2_off，一列都不寫', blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'])), ['seg2_off｜這家店還沒開放一次填兩段，請一段一段分開送', 0]);
  check('S03', '開關沒設：送一段照舊收（跟沒開功能一樣）', res(submit(m, { kind: 'ot', start: '11:00', end: '14:00', reason: '盤點' })), 'ok');
  m.props.REQ_SEG2_KINDS = 'ot';
  check('S04', '開關只開 ot：req_info 回 [ot]、ot_segments_max 4（2026-11-21 加班開到四段，原預期 2）', [m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_kinds, m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).ot_segments_max], [['ot'], 4]);
  check('S05', '只開 ot：請假兩段、出差兩段 → seg2_off，0 列', [blocked(m, lvS('事假', ['09:00', '10:00'], ['15:00', '16:00'])), blocked(m, tpS(['09:00', '10:00'], ['15:00', '16:00']))],
    [['seg2_off｜這家店還沒開放一次填兩段，請一段一段分開送', 0], ['seg2_off｜這家店還沒開放一次填兩段，請一段一段分開送', 0]]);
  m.props.REQ_SEG2_KINDS = ' OT, leave，trip、foo constructor ot ';
  check('S06', '屬性寫法容錯：大小寫、全形逗號、頓號、重複、不認得的字（constructor 這類）都濾掉', m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_kinds, ['ot', 'leave', 'trip']);
  m.props.REQ_SEG2_KINDS = '';
  check('S07', '屬性改回空字串＝全關（退回不用部署）', blocked(m, otS(['18:00', '19:00'], ['20:00', '21:00']))[0].split('｜')[0], 'seg2_off');
  const d = m.sb.handleReqInfo_({ id_token: 'TOK_U1', date: D, day_only: true });
  check('S08', 'day_only 也帶 seg2_kinds（申請頁選店時用不到，但不會壞）', [d.day_only, Array.isArray(d.seg2_kinds)], [true, true]);
}

/* ── 加班 H1–H8 ── */
{
  const m = world();
  const r = submit(m, otS(['11:00', '14:00'], ['17:00', '21:00']));
  const rows = reqRows(m);
  check('H1-a', '休息日加班 11–14＋17–21 → 收，寫 2 列 3、4 小時', [res(r), rows.map((x) => [x.kind, x.start, x.end, x.hours, x.status])], ['ok', [['ot', '11:00', '14:00', 3, 'pending'], ['ot', '17:00', '21:00', 4, 'pending']]]);
  check('H1-b', '兩列同一個 grp（g 開頭）、同一個送出時間、id 不同；回應 group＝grp', [rows[0].grp === rows[1].grp, /^g[0-9a-z]+$/.test(rows[0].grp), rows[0].created_at === rows[1].created_at, rows[0].id !== rows[1].id, r.group === rows[0].grp], [true, true, true, true, true]);
  check('H1-c', '回應：request＝第一段（舊前端照用）、requests 兩段帶 group／seg、摘要「加班兩段…共 7 小時」',
    [r.request.id === rows[0].id, r.requests.map((x) => [x.start, x.seg, x.group === rows[0].grp]), r.summary], [true, [['11:00', 1, true], ['17:00', 2, true]], '11/16 加班兩段 11:00–14:00、17:00–21:00（共 7 小時）']);
  const info = m.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  check('H1-d', '「我的申請」兩張各一列，讀回來 group 一樣、seg 1／2', info.requests.map((x) => [x.start, x.seg, x.group === rows[0].grp]).sort(), [['11:00', 1, true], ['17:00', 2, true]]);
}
{
  const m = world();
  check('H2', '平日加班 09–10＋21:00–22:30 → 2 列 1、1.5', [res(submit(m, otS(['09:00', '10:00'], ['21:00', '22:30']))), reqRows(m).map((x) => x.hours)], ['ok', [1, 1.5]]);
}
check('H3', '11–14＋13–15 重疊 → 擋，0 列', blocked(world(), otS(['11:00', '14:00'], ['13:00', '15:00'])), ['seg_overlap｜兩段時間重疊（11:00–14:00、13:00–15:00），請確認時間', 0]);
check('H4', '08–14＋15–20＝11 小時 > 10 → 擋，0 列', blocked(world(), otS(['08:00', '14:00'], ['15:00', '20:00'])), ['seg_total｜兩段合計 11 小時，超過加班一天上限 10 小時', 0]);
{
  const m = world();
  check('H5', '跨夜 17–20＋22:00–01:00 → 2 列 3、3，日期都是上班那天', [res(submit(m, otS(['17:00', '20:00'], ['22:00', '01:00']))), reqRows(m).map((x) => [x.date, x.start, x.end, x.hours])],
    ['ok', [[D, '17:00', '20:00', 3], [D, '22:00', '01:00', 3]]]);
}
check('H6', '11–14＋14–17 接在一起 → 擋，請填成一段', blocked(world(), otS(['11:00', '14:00'], ['14:00', '17:00'])), ['seg_touch｜兩段時間接在一起（11:00–14:00、14:00–17:00），請直接填成一段', 0]);
check('H7', '跨夜接在一起 22:00–01:00＋01:00–03:00 → 擋', blocked(world(), otS(['22:00', '01:00'], ['01:00', '03:00']))[0].split('｜')[0], 'seg_touch');
check('H7-b', '跨夜重疊 22:00–01:00＋00:00–02:00 → 擋（同 B29 的凌晨比法）', blocked(world(), otS(['22:00', '01:00'], ['00:00', '02:00']))[0].split('｜')[0], 'seg_overlap');
check('H7-c', '中間空 1 分鐘 11:00–14:00＋14:01–15:00 → 收', res(submit(world(), otS(['11:00', '14:00'], ['14:01', '15:00']))), 'ok');
{
  const m = world();
  check('H8-a', '08–13＋14–19 剛好 10 小時 → 收', [res(submit(m, otS(['08:00', '13:00'], ['14:00', '19:00']))), reqRows(m).map((x) => x.hours)], ['ok', [5, 5]]);
  check('H8-b', 'N1：同仁送一張 08:00–18:15（10.25 小時）→ 擋；08:00–18:00（10 小時）→ 收',
    [res(submit(world(), { kind: 'ot', start: '08:00', end: '18:15', reason: '盤點' })), res(submit(world(), { kind: 'ot', start: '08:00', end: '18:00', reason: '盤點' }))],
    ['bad_time｜加班時段超過 10 小時，請確認時間', 'ok']);
}
{
  const m = world();
  const r = submit(m, otS(['17:00', '21:00'], ['11:00', '14:00']));
  check('H9', '第二段比第一段早 → 收，存檔照時間排（11–14 是第 1 段）', [res(r), reqRows(m).map((x) => x.start), r.requests.map((x) => x.seg + ':' + x.start)], ['ok', ['11:00', '17:00'], ['1:11:00', '2:17:00']]);
  const m2 = world();
  submit(m2, otS(['00:30', '02:00'], ['20:00', '23:00']));
  check('H9-b', '凌晨 06:00 前開始的段當成跨過午夜那段，排在後面', reqRows(m2).map((x) => x.start), ['20:00', '00:30']);
}

/* ── 被擋的各種情況：一律 0 列，訊息標第幾段 ── */
{
  const m = world();
  submit(m, { kind: 'ot', start: '17:30', end: '18:30', reason: '盤點' });   // 審核中
  check('X01', '同一天已經有審核中、跟第二段重疊的單 → 第二段被擋，整批 0 列', blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'])),
    ['duplicate｜第二段：這天已經有一筆審核中的加班申請，要改請先取消那一筆', 0]);
  check('X01-b', '回應帶 seg:2（前端標紅第二段）', submit(m, otS(['11:00', '14:00'], ['17:00', '21:00'])).seg, 2);
  check('X02', '同一天審核中的單跟兩段都不重疊 → 收（同 B29：不重疊本來就能同時在審）', res(submit(m, otS(['11:00', '14:00'], ['19:00', '21:00']))), 'ok');
}
{
  const m = world();
  const a = submit(m, { kind: 'ot', start: '11:00', end: '12:00', reason: '盤點' });
  m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  check('X03', '同一天已核准、跟第一段重疊 → 第一段被擋，0 列', blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'])),
    ['duplicate｜第一段：這天已經有一筆核准的加班申請（11:00–12:00），不用再送；要改請找你的主管作廢那一筆', 0]);
}
check('X04', '原因沒寫（兩段共用的欄位）→ 不標第幾段，0 列', blocked(world(), otS(['11:00', '14:00'], ['17:00', '21:00'], { reason: '' })), ['need_reason｜加班要寫原因', 0]);
check('X05', '第二段時間沒填完整 → 第二段：…，0 列', blocked(world(), otS(['11:00', '14:00'], ['17:00', ''])), ['bad_time｜第二段：請填完整的加班時段', 0]);
check('X06', '第一段開始＝結束 → 第一段：…', blocked(world(), otS(['11:00', '11:00'], ['17:00', '18:00'])), ['bad_time｜第一段：開始和結束時間一樣，請確認', 0]);
check('X07', '請假三段、出差三段、忘打卡兩段 → bad_segments（都 0 列）；加班三段、四段是 2026-11-21 起開放（見 seg4.test.js）',
  [blocked(world(), lvS('事假', ['09:00', '10:00'], ['11:00', '12:00'], { segments: [seg('09:00', '10:00'), seg('11:00', '12:00'), seg('13:00', '14:00')] })),
   blocked(world(), { kind: 'trip', place: '央廚', why: '開會', segments: [seg('09:00', '10:00'), seg('11:00', '12:00'), seg('13:00', '14:00')] }),
   blocked(world(), { kind: 'miss', miss_type: 'out', reason: 'x', segments: [seg('09:00', '10:00'), seg('11:00', '12:00')] })].map((x) => x[0].split('｜')[0] + x[1]), ['bad_segments0', 'bad_segments0', 'bad_segments0']);
check('X08', 'segments 不是陣列、或裡面不是物件 → bad_segments', [blocked(world(), { kind: 'ot', reason: 'x', segments: 'abc' }), blocked(world(), { kind: 'ot', reason: 'x', segments: ['09:00', '10:00'] })].map((x) => x[0].split('｜')[0] + x[1]), ['bad_segments0', 'bad_segments0']);
{
  // B39：跨夜班的凌晨加班日期選錯 → 那一段被擋、整批 0 列
  const m = world({ events: [['2026-11-15T18:00:00', 'E01', 'in'], ['2026-11-16T02:00:00', 'E01', 'out']] });
  const b = blocked(m, otS(['00:30', '01:30'], ['18:00', '19:00']));
  check('X09', '跨夜班日期選錯（B39）：第一段 00:30–01:30 在 11/15 的跨夜班裡 → 第一段被擋，0 列', [b[0].split('｜')[0], /^第一段：00:30–01:30 在 11\/15 上班的跨夜班裡/.test(b[0].split('｜')[1]), b[1]], ['bad_date', true, 0]);
}
{
  const m = world();
  m.sb.payLockedBlock_ = () => ({ ok: false, error: 'pay_locked', message: '這個月薪資已經結算鎖定' });
  check('X10', '薪資鎖月 → 整批擋（既有規則），0 列', blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'])), ['pay_locked｜這個月薪資已經結算鎖定', 0]);
}
{
  const m = world();
  check('X11', '日期太早（超過補申請期限）→ too_old 不標段', blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'], { date: '2026-10-20' }))[0].split('｜')[0], 'too_old');
}

/* ── 寫入次數：成功＝一次 setValues 寫 2 列、沒有 appendRow；被擋＝一次都沒寫 ── */
{
  const m = world();
  m.sb.reqSheet_(m.sb.getSS(), true);
  const sh = m.self.sh.requests, log = [];
  const gr = sh.getRange, ap = sh.appendRow;
  sh.appendRow = (row) => { log.push('append'); return ap(row); };
  sh.getRange = (a, c, nr, nc) => { const g = gr(a, c, nr, nc); if (typeof a === 'number' && a > 1) { const sv = g.setValues, s1 = g.setValue; g.setValues = (v) => { log.push('setValues:' + v.length); return sv(v); }; g.setValue = (v) => { log.push('setValue'); return s1(v); }; } return g; };
  ['H3', 'H4', 'H6'].forEach(() => {});
  blocked(m, otS(['11:00', '14:00'], ['13:00', '15:00']));
  blocked(m, otS(['08:00', '14:00'], ['15:00', '20:00']));
  blocked(m, otS(['11:00', '14:00'], ['17:00', '21:00'], { reason: '' }));
  m.props.REQ_MENS_RULES = 'off';   // 2026-11-18：生理假開放兩段了，這裡改用緊急開關 off 驗「被擋＝0 次寫入」
  blocked(m, lvS('生理假', ['09:00', '10:00'], ['15:00', '16:00']));
  delete m.props.REQ_MENS_RULES;
  check('W01', '各種被擋（重疊、超過上限、沒原因、生理假）：寫入動作 0 次', log, []);
  submit(m, otS(['11:00', '14:00'], ['17:00', '21:00']));
  check('W02', '兩段成功：只有一次 setValues（2 列），沒有 appendRow', log, ['setValues:2']);
  log.length = 0;
  submit(m, { kind: 'ot', start: '22:00', end: '23:00', reason: '盤點' });
  check('W03', '只填一段：照舊 appendRow 一次（寫法不變）', log, ['append']);
}

/* ── 請假 L1–L4 ── */
{
  const m = world();
  const r = submit(m, lvS('病假', ['09:00', '11:00'], ['15:00', '17:00'], { attach_id: ATT }));
  const rows = reqRows(m);
  check('L1-a', '病假 09–11＋15–17 附 1 張證明 → 2 列 2、2，同一個 attach_id、同一個 grp', [res(r), rows.map((x) => [x.leave_type, x.start, x.end, x.hours, x.attach_id]), rows[0].grp === rows[1].grp && !!rows[0].grp],
    ['ok', [['病假', '09:00', '11:00', 2, ATT], ['病假', '15:00', '17:00', 2, ATT]], true]);
  check('L1-b', '兩張都有證明、不缺證明；病假今年第 1 天（同一天算同一天）；摘要', [r.requests.map((x) => [x.has_attach, x.need_proof, x.sick_n]), r.summary], [[[true, false, 1], [true, false, 1]], '11/16 病假兩段 09:00–11:00、15:00–17:00（共 4 小時）']);
  const m2 = world();
  const r2 = submit(m2, lvS('病假', ['09:00', '11:00'], ['15:00', '17:00']));
  check('L1-c', '先送不附證明：兩張都標缺證明；之後各補一次 req_attach 就都不缺', [res(r2), r2.requests.map((x) => x.need_proof),
    r2.requests.map((x) => m2.sb.handleReqAttach_({ id_token: 'TOK_U1', id: x.id, attach_id: ATT }).request.need_proof)], ['ok', [true, true], [false, false]]);
}
check('L2', '事假 09–13＋14–19＝9 小時 > 8 → 擋，0 列', blocked(world(), lvS('事假', ['09:00', '13:00'], ['14:00', '19:00'])), ['seg_total｜兩段合計 9 小時，超過請假一天上限 8 小時', 0]);
check('L2-b', '請假 4＋4 剛好 8 → 收', res(submit(world(), lvS('事假', ['09:00', '13:00'], ['14:00', '18:00']))), 'ok');
{
  const Q = [{ name: '家庭照顧假', remain_h: 3, cap_h: 56 }];
  const m = world({ quota: Q });
  const b = blocked(m, lvS('家庭照顧假', ['09:00', '11:00'], ['15:00', '17:00']));
  check('L3-a', '家庭照顧假剩 3 小時，送 2＋2 → 擋（兩段一起算額度），0 列', [b[0].split('｜')[0], /只剩 3 小時/.test(b[0]), b[1]], ['quota_exhausted', true, 0]);
  check('L3-b', '同樣剩 3 小時，送 1＋2＝3 → 收', res(submit(world({ quota: Q }), lvS('家庭照顧假', ['09:00', '10:00'], ['15:00', '17:00']))), 'ok');
  const s = world({ quota: Q });
  const one = res(submit(s, { kind: 'leave', leave_type: '家庭照顧假', start: '09:00', end: '11:00', reason: 'x' }));
  const two = res(submit(s, { kind: 'leave', leave_type: '家庭照顧假', start: '15:00', end: '17:00', reason: 'x' })).split('｜')[0];
  check('L3-c', '對照：分兩次送 2＋2 → 第一張收、第二張因額度被擋（兩段送出是整批不寫，判斷一樣）', [one, two], ['ok', 'quota_exhausted']);
}
check('L4', '生理假新規則開關 off：生理假兩段 → 擋（一天只算一次），0 列', blocked(world({ props: Object.assign({ REQ_MENS_RULES: 'off' }, ALL) }), lvS('生理假', ['09:00', '10:00'], ['15:00', '16:00'])), ['seg2_type｜生理假一天只算一次，不能分兩段，請填成一段', 0]);
{ // 2026-11-18 生理假新規則：開放兩段（同一天算一次，兩段合計 8 小時）
  const m = world(), r = submit(m, lvS('生理假', ['09:00', '10:00'], ['15:00', '16:00']));
  check('L4-new', '生理假兩段 → 收，2 列', [res(r), nRows(m)], ['ok', 2]);
}
{
  const m = world();
  submit(m, { kind: 'leave', leave_type: '特休假', hours: 8, reason: 'x' });   // 整天（只填時數）審核中
  check('L5', '同一天已經有整天的假（只填時數）→ 擋（既有規則：只填時數一律當重疊），0 列', blocked(m, lvS('事假', ['09:00', '10:00'], ['15:00', '16:00'])),
    ['duplicate｜第一段：這天已經有一筆審核中的請假申請，要改請先取消那一筆', 0]);
}
check('L6', '假別沒選（兩段共用）→ 不標段', blocked(world(), lvS('', ['09:00', '10:00'], ['15:00', '16:00']))[0], 'bad_leave_type｜請選假別');
{
  const m = world();
  const r = submit(m, lvS('事假', ['09:00', '10:00'], ['15:00', '16:00'], { hours: 8 }));
  check('L7', '請假兩段帶了 hours 也不理（時數照時段算）', [res(r), reqRows(m).map((x) => x.hours)], ['ok', [1, 1]]);
}

/* ── 出差 T1–T2 ── */
{
  const m = world();
  const r = submit(m, tpS(['09:00', '12:00'], ['13:00', '16:00']));
  check('T1', '出差 09–12＋13–16 台北瑞光 → 2 列 3、3，地點事由一樣；摘要帶地點', [res(r), reqRows(m).map((x) => [x.kind, x.leave_type, x.hours, x.reason]), r.summary],
    ['ok', [['trip', '出差', 3, '地點：台北瑞光；事由：開會'], ['trip', '出差', 3, '地點：台北瑞光；事由：開會']], '11/16 出差兩段 09:00–12:00、13:00–16:00（共 6 小時，地點：台北瑞光）']);
}
check('T2', '出差 08–12＋13–18＝9 小時 > 8 → 擋，0 列', blocked(world(), tpS(['08:00', '12:00'], ['13:00', '18:00'])), ['seg_total｜兩段合計 9 小時，超過出差一天上限 8 小時', 0]);
check('T3', '出差地點沒填（共用）→ 不標段，0 列', blocked(world(), tpS(['09:00', '12:00'], ['13:00', '16:00'], { place: '' })), ['need_place｜請填出差地點', 0]);

/* ── 店長代開（只有加班能兩段，上限 10） ── */
const ACT = { mgr_key: 'AK', acting_name: '林店長（S1）' };
const proxy = (m, o) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return m.sb.handleMgrReqProxy_(Object.assign({ action: 'mgr_req_proxy', emp_id: 'E02', kind: 'ot', date: D, reason: '盤點' }, ACT, o)); };
{
  const m = world();
  const r = proxy(m, { segments: [seg('11:00', '14:00'), seg('17:00', '21:00')] });
  const rows = reqRows(m);
  check('P1', '代開加班 11–14＋17–21（同仁沒綁 LINE）→ 2 列都有 proxy_by、同 grp；摘要帶代開', [res(r), rows.map((x) => [x.emp_id, x.hours, x.proxy_by]), rows[0].grp === rows[1].grp && !!rows[0].grp, r.summary],
    ['ok', [['E02', 3, '林店長（S1）'], ['E02', 4, '林店長（S1）']], true, '11/16 加班兩段 11:00–14:00、17:00–21:00（共 7 小時）（林店長代開）']);
  const before = nRows(m);
  check('P2', '代開 08–14＋15–20＝11 > 10（N1 更正：代開也是 10）→ 擋，0 列', [res(proxy(m, { date: '2026-11-15', segments: [seg('08:00', '14:00'), seg('15:00', '20:00')] })), nRows(m) - before],
    ['seg_total｜兩段合計 11 小時，超過加班一天上限 10 小時', 0]);
  check('P3', '代開單張 08:00–18:15（10.25）→ 擋；08:00–18:00 → 收', [res(proxy(m, { date: '2026-11-14', start: '08:00', end: '18:15' })), res(proxy(m, { date: '2026-11-14', start: '08:00', end: '18:00' }))],
    ['bad_time｜加班時段超過 10 小時，請確認時間', 'ok']);
  check('P4', '代開請假、出差送兩段 → bad_segments（N3），0 列', [
    proxy(m, { kind: 'leave', leave_type: '事假', segments: [seg('09:00', '10:00'), seg('15:00', '16:00')] }).error,
    proxy(m, { kind: 'trip', place: '央廚', why: '開會', segments: [seg('09:00', '10:00'), seg('15:00', '16:00')] }).error, nRows(m) - before], ['bad_segments', 'bad_segments', 1]);
  const m2 = world({ props: {} });
  check('P5', '開關沒開：代開兩段一樣 seg2_off', [proxy(m2, { segments: [seg('11:00', '14:00'), seg('17:00', '21:00')] }).error, nRows(m2)], ['seg2_off', 0]);
}

/* ── 主管：待審清單帶 group／seg、兩筆一起核准、各自退回、同仁只取消一段 ── */
{
  const m = world();
  const r = submit(m, otS(['11:00', '14:00'], ['17:00', '21:00']));
  const pend = m.sb.handleMgrReqPending_({ mgr_key: 'MK' }).items;
  check('A01', 'mgr_req_pending 每張帶 group、seg', pend.map((x) => [x.start, x.seg, x.group === r.group]), [['11:00', 1, true], ['17:00', 2, true]]);
  const bt = m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: r.requests.map((x) => x.id), decision: 'approve' });
  check('A02', '兩筆一起核准（既有 mgr_req_decide_batch）→ 兩張都 approved', [(bt.done || []).length, reqRows(m).map((x) => x.status)], [2, ['approved', 'approved']]);
  const m2 = world();
  const r2 = submit(m2, otS(['11:00', '14:00'], ['17:00', '21:00']));
  m2.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r2.requests[0].id, decision: 'approve' });
  m2.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r2.requests[1].id, decision: 'reject', reason: '時間不對' });
  check('A03', '兩張可以各自核准／退回', reqRows(m2).map((x) => x.status), ['approved', 'rejected']);
  const m3 = world();
  const r3 = submit(m3, otS(['11:00', '14:00'], ['17:00', '21:00']));
  check('A04', '同仁取消只取消那一段，另一張照舊審核中', [m3.sb.handleReqCancel_({ id_token: 'TOK_U1', id: r3.requests[1].id }).ok, reqRows(m3).map((x) => x.status)], [true, ['pending', 'cancelled']]);
}

/* ── 只填一段：跟上線前的程式（23dff23）逐欄相同 ── */
{
  const oldSrc = execFileSync('git', ['-C', ROOT, 'show', '23dff23:apps-script/Requests.gs'], { encoding: 'utf8' });
  const cases = [
    ['加班', { kind: 'ot', start: '18:00', end: '20:30', reason: '盤點' }],
    ['請假整天（只填時數）', { kind: 'leave', leave_type: '事假', hours: 4, reason: '家裡有事' }],
    ['請假一段＋證明', { kind: 'leave', leave_type: '病假', start: '09:00', end: '12:00', attach_id: ATT }],
    ['出差一段', { kind: 'trip', start: '09:00', end: '12:00', place: '央廚', why: '開會' }],
  ];
  cases.forEach(([nm, body], i) => {
    const mNew = world({ props: {} }), mOld = world({ props: {} });
    mOld.run(oldSrc);
    const rn = submit(mNew, body), ro = submit(mOld, body);
    const wn = mNew.self.sh.requests.values, wo = mOld.self.sh.requests.values;
    const strip = (o) => { const x = JSON.parse(JSON.stringify(o)); delete x.id; delete x.group; delete x.seg; return x; };
    check('R0' + (i + 1), '只填一段（' + nm + '）：舊 23 欄逐欄相同（id 除外）、新的 grp 欄空白；回應除了新加的 group／seg 都一樣',
      [wn[0].slice(0, 23), wn[1].slice(1, 23), wn[1][23], strip(rn.request), rn.summary, rn.request.group, rn.request.seg],
      [wo[0], wo[1].slice(1), '', strip(ro.request), ro.summary, '', null]);
  });
  // segments 只有一段＝跟直接填 start/end 一樣（開關沒開也一樣收）
  const a = world({ props: {} }), b = world({ props: {} });
  const ra = submit(a, { kind: 'ot', reason: '盤點', segments: [seg('18:00', '20:30')] }), rb = submit(b, { kind: 'ot', start: '18:00', end: '20:30', reason: '盤點' });
  check('R05', 'segments 只有一段 → 走原本一張的流程，寫入跟直接填 start/end 相同', [res(ra), a.self.sh.requests.values[1].slice(1)], [res(rb), b.self.sh.requests.values[1].slice(1)]);
  const io = world({ props: {} }), inw = world({ props: {} });
  io.run(oldSrc);
  const iO = io.sb.handleReqInfo_({ id_token: 'TOK_U1' }), iN = inw.sb.handleReqInfo_({ id_token: 'TOK_U1' });
  const added = Object.keys(iN).filter((k) => !(k in iO)).sort();
  const same = Object.keys(iO).every((k) => JSON.stringify(iO[k]) === JSON.stringify(iN[k]));
  // 2026-11-18 生理假新規則／病假用完再多三欄：mens_rules、sick_used_up、leave_live（原預期只有 seg2 那五欄）
  check('R06', 'req_info：舊欄位全部一樣，只多 seg2_kinds、seg2_max_h、seg2_no_types、ot_max_h、ot_segments_max（＋生理假／病假三欄）', [same, added], [true, ['leave_live', 'mens_rules', 'ot_max_h', 'ot_segments_max', 'seg2_kinds', 'seg2_max_h', 'seg2_no_types', 'sick_used_up']]);
}

/* ── 核定判斷（reqBindCheck_，程式沒改）：兩段送出 vs 分兩次送，結果逐欄相同 ── */
{
  const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
  const P = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
  const S = (a, b) => ({ inMs: ms(a), outMs: ms(b) });
  /** 兩個世界：A 一次送兩段、B 分兩次送；全部核准後讀回申請表、跑同一組核定判斷 */
  function pair(segBody, oneA, oneB) {
    const A = world(), B = world();
    const ra = submit(A, segBody);
    const rb1 = submit(B, oneA), rb2 = submit(B, oneB);
    [A, B].forEach((m) => { const ids = reqRows(m).map((x) => x.id); m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids, decision: 'approve' }); });
    const cols = (m) => reqRows(m).map((x) => { const o = Object.assign({}, x); delete o.id; delete o.created_at; delete o.decided_at; delete o.grp; return o; });
    return { A, B, ok: [res(ra), res(rb1), res(rb2)], colsA: cols(A), colsB: cols(B) };
  }
  const bind = (m, hours, periods, segs, opt) => {
    m.run('READ_MEMO_ = null; REQ_PEER_MEMO_ = {};');
    const pv = m.sb.reqBindCheck_(m.sb.getSS(), 'E01', D, hours, periods, segs, null, Object.assign({ preview: true }, opt));
    m.run('READ_MEMO_ = null; REQ_PEER_MEMO_ = {};');
    const full = m.sb.reqBindCheck_(m.sb.getSS(), 'E01', D, hours, periods, segs, null, opt);
    return JSON.parse(JSON.stringify({ pv, full }));
  };
  const OPT = { force_strict: true, force_ot_punch: true, name: '測試一' };
  // E1 加班休息日（H1）
  {
    const w = pair(otS(['11:00', '14:00'], ['17:00', '21:00']), { kind: 'ot', start: '11:00', end: '14:00', reason: '盤點' }, { kind: 'ot', start: '17:00', end: '21:00', reason: '盤點' });
    const per = [P('11:00', '14:00'), P('17:00', '21:00')], pun = [S('10:58', '14:03'), S('16:57', '21:06')], o = Object.assign({ sched_day: 'R' }, OPT);
    const a = bind(w.A, 7, per, pun, o), b = bind(w.B, 7, per, pun, o);
    check('E1-a', '加班休息日：兩邊寫入的申請表除了 id／送出時間／grp 逐欄相同', [w.ok, w.colsA], [['ok', 'ok', 'ok'], w.colsB]);
    check('E1-b', '加班休息日：核定判斷結果逐欄相同，而且放行（需 7 有 7）', [a, a.full, a.pv.ot_have, a.pv.ot_need], [b, null, 7, 7]);
    const a2 = bind(w.A, 8, [P('11:00', '14:00'), P('17:00', '22:00')], [S('10:58', '14:03'), S('16:57', '22:06')], o), b2 = bind(w.B, 8, [P('11:00', '14:00'), P('17:00', '22:00')], [S('10:58', '14:03'), S('16:57', '22:06')], o);
    check('E1-c', '對照（證明比對有效）：核定改 8 小時 → 兩邊都擋、訊息逐字相同', [a2, a2.full && a2.full.error], [b2, 'need_request']);
  }
  // E2 加班平日（H2）
  {
    const w = pair(otS(['09:00', '10:00'], ['21:00', '22:30']), { kind: 'ot', start: '09:00', end: '10:00', reason: '盤點' }, { kind: 'ot', start: '21:00', end: '22:30', reason: '盤點' });
    const per = [P('09:00', '14:00'), P('17:00', '22:30')], pun = [S('08:58', '14:02'), S('16:58', '22:31')];
    const o = Object.assign({ sched_day: '', sched_spans: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '21:00' }] }, OPT);
    const a = bind(w.A, 10.5, per, pun, o), b = bind(w.B, 10.5, per, pun, o);
    check('E2-a', '加班平日：申請表逐欄相同', [w.ok, w.colsA], [['ok', 'ok', 'ok'], w.colsB]);
    check('E2-b', '加班平日：核定判斷逐欄相同，而且放行（需 2.5 有 2.5、兩段都不在班表內）', [a, a.full, a.pv.ot_have, a.pv.ot_need], [b, null, 2.5, 2.5]);
    const o2 = Object.assign({}, o, { sched_spans: [{ start: '09:00', end: '14:00' }, { start: '17:00', end: '21:00' }] });
    const a3 = bind(w.A, 10.5, per, pun, o2), b3 = bind(w.B, 10.5, per, pun, o2);
    check('E2-c', '對照：班表改成 09:00 開始 → 第一段落在班表內，兩邊都擋、逐字相同', [a3, a3.pv.probs.map((p) => p.rule)], [b3, ['ot_in_sched']]);
  }
  // E3 病假（L1）
  {
    const w = pair(lvS('病假', ['09:00', '11:00'], ['15:00', '17:00'], { attach_id: ATT }),
      { kind: 'leave', leave_type: '病假', start: '09:00', end: '11:00', reason: '看醫生', attach_id: ATT }, { kind: 'leave', leave_type: '病假', start: '15:00', end: '17:00', reason: '看醫生', attach_id: ATT });
    const per = [P('11:00', '15:00')], pun = [S('11:00', '15:00')];
    const a = bind(w.A, 4, per, pun, Object.assign({ leaves: [{ type: '病假', hours: 4 }] }, OPT)), b = bind(w.B, 4, per, pun, Object.assign({ leaves: [{ type: '病假', hours: 4 }] }, OPT));
    check('E3-a', '病假：申請表逐欄相同（含同一個 attach_id）', [w.ok, w.colsA], [['ok', 'ok', 'ok'], w.colsB]);
    check('E3-b', '病假：核定登記病假 4＝單 2＋2 → 兩邊逐欄相同、放行', [a, a.full], [b, null]);
    const a2 = bind(w.A, 4, per, pun, Object.assign({ leaves: [{ type: '病假', hours: 3 }] }, OPT)), b2 = bind(w.B, 4, per, pun, Object.assign({ leaves: [{ type: '病假', hours: 3 }] }, OPT));
    check('E3-c', '對照：登記病假 3 小時 → 兩邊都擋、訊息相同', [a2, a2.pv.probs.map((p) => p.text)], [b2, ['病假核定登記 3 小時，已核准的單是 4 小時']]);
  }
  // E4 出差（T1）
  {
    const w = pair(tpS(['09:00', '12:00'], ['13:00', '16:00']),
      { kind: 'trip', start: '09:00', end: '12:00', place: '台北瑞光', why: '開會' }, { kind: 'trip', start: '13:00', end: '16:00', place: '台北瑞光', why: '開會' });
    const per = [P('16:30', '18:30')], pun = [S('16:30', '18:30')];
    const o = Object.assign({ leaves: [{ type: '出差', hours: 6 }], trip_hours: 6 }, OPT);
    const a = bind(w.A, 2, per, pun, o), b = bind(w.B, 2, per, pun, o);
    check('E4-a', '出差：申請表逐欄相同', [w.ok, w.colsA], [['ok', 'ok', 'ok'], w.colsB]);
    check('E4-b', '出差：核定登記出差 6＝單 6 → 兩邊逐欄相同、放行', [a, a.full], [b, null]);
    const a2 = bind(w.A, 2, per, pun, Object.assign({}, o, { leaves: [{ type: '出差', hours: 3 }] })), b2 = bind(w.B, 2, per, pun, Object.assign({}, o, { leaves: [{ type: '出差', hours: 3 }] }));
    check('E4-c', '對照：登記出差 3 → 兩邊都擋、訊息相同', [a2, a2.full && a2.full.error], [b2, 'need_request']);
  }
}

/* ── 綁兩家店、兩段在不同店打卡：前端擋（storeGuard），後端只收到送來的那一家 ── */
{
  const m = make({ now: NOW, props: ALL, self: { roster: [ME], events: [[D + 'T11:00:00', 'E01', 'in'], [D + 'T14:00:00', 'E01', 'out']] }, peers: { SS_B: { roster: [ME], events: [[D + 'T17:00:00', 'E01', 'in'], [D + 'T21:00:00', 'E01', 'out']] } } });
  const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', date: D, kind: 'ot', reason: '盤點', segments: [seg('11:00', '14:00'), seg('17:00', '21:00')] });
  check('M01', '送單不看打卡（同現在）：兩段都寫進送來的那一家；另一家 0 列（要不要分開送由 LINE 頁 storeGuard 擋，核定時打卡佐證照舊逐張檢查）',
    [res(r), (m.self.sh.requests.values.length - 1), m.peers.SS_B.sh.requests ? m.peers.SS_B.sh.requests.values.length - 1 : 0], ['ok', 2, 0]);
}

/* ── N4：事假「本月第幾次」提醒拿掉，合計天數提醒照舊 ── */
{
  const m = world();
  ['2026-11-02', '2026-11-03', '2026-11-04'].forEach((d) => submit(m, { kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: d }));
  const r = submit(m, { kind: 'leave', leave_type: '事假', hours: 2, reason: 'x', date: '2026-11-05' });
  check('N4', '本月第 4 次事假：不再出現「本月第 N 次事假」；合計 26 小時＞3 天的提醒照舊', r.request.warns.filter((w) => !/前一天/.test(w)), ['本月事假合計 3.3 天，超過 3 天']);
}
done();
