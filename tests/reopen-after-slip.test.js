/**
 * 核定之後才核准的補單：自動打回待核定（2026-11-26 主管「照推薦」1A 2A 3A 4A 5A 6A 7A 8A 9A；
 * 設計 ~/加盟名單平台/_brain_out/reapprove-after-slip/design.md，主管確認頁 kickoff.html）。
 * 用真函式跑（Code／Liff／Rest／Requests／DutyFeed，必要時加 RelayG、AttDigest）；全部虛構同仁、示意工號。
 *
 * 規則白話：開關 REQ_REOPEN_ON 去頭尾空白後剛好是 '1' 時，主管核准請假／出差／加班單，那天在這家店已有自己的核定（不算總部鏡像列）、
 *   而且核定還沒包含這張單 → 先把那人那天的核定與假別登記搬到留底分頁（同作廢打回），再核准；打回失敗＝單子不核准。
 *   開關其他值（沒設、空白、0、true、打錯字）＝跟改版前（REOPEN_BASE，預設 f21cc25）逐位元組相同。
 *
 * 手算對照（例 1～12 同設計 1.6；時數單位小時）：
 *   例1 11/20 核定 10:00–13:00 3h，整天出差 8h 核准 → 打回（approved 1 列搬走、leave 0），重核出差 8 → 8h
 *   例2 11/18 核定 12:00–20:00 8h，加班單 20:00–22:00 → 不在核定時段 → 打回；核定到 22:00、加班 20:00–21:55 → 已包含、不打回
 *   例3 11/22 核定 09:00–18:00，事假 14:00–18:00 4h，請假登記沒有事假 → 打回
 *   例4 11/20 已核「出差 8」，請假登記有 出差 8，出差單 8 → 已包含、不打回
 *   例5 11/19 已核定，同一批核准 出差 4＋事假 4 → 只打回一次（第一張），第二張不重打、不提醒
 *   例6 作廢已打回 → 新出差單核准時那天沒有核定 → 不打回、不提醒
 *   例7 忘打卡單 → 不打回、不提醒（1A）
 *   例8 11 月已鎖 → 核准被擋（鎖月），不打回
 *   例9 未來日期 → 沒有核定 → 不打回
 *   例10 總部只有鏡像核定 → 不打回、照今天的提醒字
 *   例11 核准人＝原核定人 → 一樣打回
 *   例12 搬資料出錯 → 單子不核准，回「這天的核定沒有打回成功，這張還沒核准，請再按一次」
 */
'use strict';
const cp = require('child_process');
const H = require('./helpers/gs-sandbox');
const { make, T, check, done, R, ROOT } = H;

const BASE = process.env.REOPEN_BASE || 'f21cc25';
const gitShow = (f) => cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':' + f], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
let BASE_REQ, BASE_RELAY;
try { BASE_REQ = gitShow('apps-script/Requests.gs'); BASE_RELAY = gitShow('apps-script/RelayG.gs'); }
catch (e) { console.error('讀不到舊版 ' + BASE + '（淺複製？可用 REOPEN_BASE 換）：' + e.message); process.exit(1); }
if (/REQ_REOPEN_ON/.test(BASE_REQ)) { console.error('REOPEN_BASE 指到已經有打回的版本'); process.exit(1); }

const J = (x) => JSON.parse(JSON.stringify(x));
const NOW = '2026-11-28T10:00:00';
const AH = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason', 'mirror_src'];
const AP = (date, emp, name, periods, hours, st, mgr, at, mirror) => [date, emp, name, periods, hours, st || '正常', mgr || '店長', at || date + 'T21:00:00+08:00', '', '', mirror || ''];
const ROSTER = [
  { emp_id: 'MZTJS07', name: '示意甲', key: 'K7', active: 'true' }, { emp_id: 'MZTGF06', name: '示意乙', key: 'K6', active: 'true' },
  { emp_id: 'MZTMC03', name: '示意丙', key: 'K3', active: 'true' }, { emp_id: 'MZTJS11', name: '示意丁', key: 'K11', active: 'true' },
  { emp_id: 'E05', name: '同名', key: 'K5', active: 'true' }, { emp_id: 'E06', name: '同名', key: 'K6b', active: 'true' },
];

/**
 * 一家店。o：{approved:[AP…], leave:[[日期,姓名,假別,時數]…], reqs:[{…}], events:[[ts,emp,type]…], props, base:true＝改版前程式, relay, digest}
 */
function world(o) {
  o = o || {};
  const m = make({ now: T(o.now || NOW), props: Object.assign({ REQ_BIND_FROM: 'off' }, o.props || {}), digest: !!o.digest,
    self: { roster: o.roster || ROSTER, events: o.events || [], approved: [], leave: o.leave || [] } });
  if (o.relay || o.base) m.run(R('apps-script/RelayG.gs'));
  if (o.base) { m.run(BASE_REQ); m.run(BASE_RELAY); }
  const ap = m.self.sh.approved.values;
  ap[0] = AH.slice();
  (o.approved || []).forEach((r) => ap.push(r.slice()));
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  (o.reqs || []).forEach((q) => {
    const r = Object.assign({ created_at: '2026-11-27T09:00:00+08:00', status: 'pending' }, q);
    sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k])));
  });
  return m;
}
// 沙盒沒有薪資模組＝打卡端自己讀不到鎖月 → 照營運系統代轉時帶的 pay_unlocked（先向光復確認過沒鎖的月份）；測試預設帶 11、12 月（鎖月讀不到另有一段測試）
const UNL = ['2026-11', '2026-12'];
const dec = (m, id, x) => J(m.sb.handleMgrReqDecide_(Object.assign({ mgr_key: 'MK', id, decision: 'approve', pay_unlocked: UNL }, x || {})));
const batch = (m, ids) => J(m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids, decision: 'approve', pay_unlocked: UNL }));
const st = (m, id) => m.sb.reqRows_(m.sb.getSS()).find((x) => String(x.id) === String(id)).status;
const sheetVals = (m, nm) => { const s = m.self.sh[nm]; return s ? s.values.map((r) => r.slice()) : null; };
const apRows = (m) => (sheetVals(m, 'approved') || []).slice(1);
const bakRows = (m) => (sheetVals(m, 'approved_revoked') || []).slice(1);
const lvRows = (m) => (sheetVals(m, 'leave') || []).slice(1);
const lvBak = (m) => (sheetVals(m, 'leave_revoked') || []).slice(1);
const ON = { REQ_REOPEN_ON: '1' };
const TRIP8 = (id, emp, date, x) => Object.assign({ id, emp_id: emp, name: '', kind: 'trip', date, leave_type: '出差', hours: 8 }, x || {});

console.log('══ 例 1～12（開關開著）══');
// 例 1：整天出差，先照打卡核了 3 小時 → 打回；店長重核帶出差 8 → 8 小時；待核定清單、08:50 提醒照列
{
  const ev = [['2026-11-20T10:00:00', 'MZTJS07', 'in'], ['2026-11-20T13:00:00', 'MZTJS07', 'out']];
  const m = world({ props: ON, events: ev, digest: true, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3, '正常', '店長', '2026-11-21T20:00:00+08:00')],
    reqs: [TRIP8('X1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const r = dec(m, 'X1');
  check('ex1-a', '回應：照常核准＋打回（沿用 warn 代碼、新字）', [r.ok, r.status, r.warn, r.warn_dates, r.reopened, r.message],
    [true, 'approved', 'already_approved_day', ['2026-11-20'], true, '11/20 原本已核定，已打回待核定，請重新核定這天']);
  check('ex1-b', 'revoked：搬 1 列核定、0 列假別；before＝原核定摘要', r.revoked,
    { approved: 1, leave: 0, before: { periods: '10:00-13:00', approved_hours: 3, status_text: '正常', manager_name: '店長', entered_at: '2026-11-21T20:00:00+08:00', leaves: [] } });
  check('ex1-c', '回應帶工號、日期、種類、摘要（營運系統記打回用）', [r.emp_id, r.date, r.kind, typeof r.summary === 'string' && r.summary.length > 0], ['MZTJS07', '2026-11-20', 'trip', true]);
  check('ex1-d', 'approved 沒有那列；approved_revoked 多 1 列、理由以「核准申請 X1（值班主管）後打回：」開頭',
    [apRows(m).length, bakRows(m).length, /^核准申請 X1（值班主管）後打回：/.test(bakRows(m)[0][bakRows(m)[0].length - 1]), bakRows(m)[0][bakRows(m)[0].length - 2]],
    [0, 1, true, '2026-11-28T10:00:00+08:00']);
  check('ex1-e', '申請 status=approved', st(m, 'X1'), 'approved');
  const pa = J(m.sb.handleMgrPendingApprovals({ mgr_key: 'MK', ym: '2026-11' }));
  check('ex1-f', '待核定清單列出 11/20（打回後自然回到清單）', (pa.items || []).some((x) => x.date === '2026-11-20' && JSON.stringify(x).indexOf('MZTJS07') >= 0), true);
  const dg = J(m.sb.handleAttDigestData({ action: 'att_digest_data', mgr_key: 'MK', from: '2026-11-20', to: '2026-11-27', since: '2026-11-27T08:50:00+08:00', until: '2026-11-28T08:50:00+08:00', unapproved_from: '2026-11-01' }));
  check('ex1-g', '08:50 提醒資料：11/20 照列在「工時還沒核定」（第 4 題 A，提醒程式不改）', (dg.unapproved || []).some((x) => x.date === '2026-11-20' && x.emp_id === 'MZTJS07'), true);
  const rd = J(m.sb.handleMgrReqDay_({ mgr_key: 'MK', date: '2026-11-20' }));
  check('ex1-h', '核定頁預填：那天已核准的出差單帶得出來', ((rd.by_emp || {}).MZTJS07 || []).map((x) => [x.kind, x.status, Number(x.hours)]), [['trip', 'approved', 8]]);
  const ra = J(m.sb.handleMgrApprove({ mgr_key: 'MK', date: '2026-11-20', emp_id: 'MZTJS07', periods: [], leaves: [{ type: '出差', hours: 8 }] }));
  check('ex1-i', '店長重核出差 8 → 8 小時', [ra.ok, Number(ra.approved_hours)], [true, 8]);
  const dg2 = J(m.sb.handleAttDigestData({ action: 'att_digest_data', mgr_key: 'MK', from: '2026-11-20', to: '2026-11-27', since: '2026-11-27T08:50:00+08:00', until: '2026-11-28T08:50:00+08:00', unapproved_from: '2026-11-01' }));
  check('ex1-j', '重核後 08:50 提醒不再列 11/20', (dg2.unapproved || []).some((x) => x.date === '2026-11-20' && x.emp_id === 'MZTJS07'), false);
}
// 例 2：加班單整段不在核定時段 → 打回；在核定時段內（差 15 分內）→ 不打回
{
  const m = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '12:00-20:00', 8)], reqs: [{ id: 'O1', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '20:00', end: '22:00', hours: 2 }] });
  const r = dec(m, 'O1');
  check('ex2-a', '加班 20:00–22:00 不在核定 12:00–20:00 → 打回', [r.reopened, r.revoked.approved, apRows(m).length, r.message], [true, 1, 0, '11/18 原本已核定，已打回待核定，請重新核定這天']);
  // 2026-11-26 獨立審查第 1 項：跟核定檢查同一個口徑——核定 10 小時（一般日應有加班 2 小時），這天所有已核准加班單（含這張）每張都在時段內（±15 分）、合計 2～2.25 小時才算已包含
  const OTX = (id, a, b, h, st) => ({ id, emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: a, end: b, hours: h, status: st || 'pending' });
  const cases = [[[], '20:00', '22:00', 2, false, '時段內、時數剛好'], [[], '20:00', '22:15', 2.25, false, '晚 15 分、多 15 分內'], [[], '20:00', '22:16', 2.27, true, '超出時段 16 分'],
    [[], '20:00', '21:55', 1.92, true, '時數不夠（應有 2）'], [[OTX('P1', '20:00', '21:00', 1, 'approved')], '21:00', '22:00', 1, false, '兩張加班單合計 2'],
    [[OTX('P1', '20:00', '22:00', 2, 'approved')], '18:00', '20:00', 2, true, '已有 2 小時加班單、再補 2 小時（合計 4 比應有 2 多）']];
  cases.forEach(([pre, a, b, h, want, why], i) => {
    const m2 = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '12:00-22:00', 10)], reqs: pre.concat([OTX('O2', a, b, h)]) });
    const r2 = dec(m2, 'O2');
    check('ex2-b' + i, '核定 12:00–22:00、' + why + '：加班 ' + a + '–' + b + ' → ' + (want ? '打回' : '已包含'),
      want ? [!!r2.reopened, apRows(m2).length] : [r2.day_ok, r2.message, 'warn' in r2, apRows(m2).length],
      want ? [true, 0] : [true, '11/18 的核定已經包含這張單，不用重新核定', false, 1]);
  });
  // 跨夜：核定 18:00–02:00，凌晨加班 00:30–01:30（日期算前一天）→ 已包含
  const m3 = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '16:00-02:00', 10)], reqs: [{ id: 'O3', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '00:00', end: '02:00', hours: 2 }] });
  check('ex2-c', '跨夜核定 16:00–02:00（10 小時）、加班 00:00–02:00 2 小時 → 已包含', dec(m3, 'O3').day_ok, true);
  const m3b = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '18:00-02:00', 8)], reqs: [{ id: 'O3', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '00:30', end: '01:30', hours: 1 }] });
  check('ex2-c2', '核定 8 小時（沒超過 8）卻有加班單（核定檢查會要作廢）→ 不算已包含、打回', !!dec(m3b, 'O3').reopened, true);
  // 加班時間格子在正式試算表是時間（Date），reqRows_ 先轉成 HH:mm（reqHm_），跟填文字一樣判（審查「其餘」：掃描工具讀副本的台北 ISO 字串取時分＝同一個值）
  const m3c = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '12:00-22:00', 10)], reqs: [] });
  m3c.sb.reqSheet_(m3c.sb.getSS(), true).appendRow(m3c.run('REQ_HEADERS_').map((k) => ({ id: 'O9', created_at: '2026-11-27T09:00:00+08:00', status: 'pending', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', hours: 2,
    start: new m3c.sb.Date(H.T('1899-12-30T20:00:00')), end: new m3c.sb.Date(H.T('1899-12-30T22:00:00')) })[k] ?? ''));
  check('ex2-c3', '加班起訖是試算表時間格子（Date）→ 轉成 20:00–22:00 照判 → 已包含', dec(m3c, 'O9').day_ok, true);
  // 兩段核定（中間休息）：加班落在第二段 → 已包含；跨過休息空檔 → 打回
  const m4 = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '09:00-13:00,14:00-20:00', 10)], reqs: [{ id: 'O4', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '18:00', end: '20:00', hours: 2 }, { id: 'O5', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '12:00', end: '15:00', hours: 3 }] });
  check('ex2-d', '兩段核定、加班 18:00–20:00 在第二段 → 已包含', dec(m4, 'O4').day_ok, true);
  check('ex2-e', '加班 12:00–15:00 跨過 13:00–14:00 空檔（超過 15 分）→ 打回', !!dec(m4, 'O5').reopened, true);
  // 核定是整天出差（沒有時段）→ 加班單算不包含 → 打回；核定時段格式怪 → 拿不準 → 打回
  const m5 = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '', 8, '出差')], reqs: [{ id: 'O6', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '18:00', end: '19:00', hours: 1 }] });
  check('ex2-f', '核定沒有時段（整天出差）＋加班單 → 打回', !!dec(m5, 'O6').reopened, true);
  const m6 = world({ props: ON, approved: [AP('2026-11-18', 'MZTGF06', '示意乙', '9點-18點', 8)], reqs: [{ id: 'O7', emp_id: 'MZTGF06', name: '示意乙', kind: 'ot', date: '2026-11-18', start: '10:00', end: '11:00', hours: 1 }] });
  check('ex2-g', '核定時段讀不懂 → 拿不準當不包含 → 打回', !!dec(m6, 'O7').reopened, true);
}
// 例 3：全天核定後才補下午事假 4 小時 → 打回
{
  const m = world({ props: ON, approved: [AP('2026-11-22', 'MZTMC03', '示意丙', '09:00-18:00', 9)], reqs: [{ id: 'L1', emp_id: 'MZTMC03', name: '示意丙', kind: 'leave', date: '2026-11-22', leave_type: '事假', start: '14:00', end: '18:00', hours: 4 }] });
  const r = dec(m, 'L1');
  check('ex3', '事假沒登記 → 打回、申請已核准', [r.reopened, r.revoked.approved, r.revoked.leave, st(m, 'L1')], [true, 1, 0, 'approved']);
}
// 例 4：已核「出差 8」，出差單 8 → 已包含；時數不同 → 打回；單沒填時數 → 有同假別就算
{
  const base = { props: ON, approved: [AP('2026-11-20', 'MZTJS11', '示意丁', '', 8, '出差')] };
  const m = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 8]], reqs: [TRIP8('T4', 'MZTJS11', '2026-11-20', { name: '示意丁' })] }));
  const r = dec(m, 'T4');
  check('ex4-a', '已包含 → 不打回、day_ok、沒有 warn（舊畫面安靜）', [r.ok, r.status, r.day_ok, r.message, 'warn' in r, 'reopened' in r],
    [true, 'approved', true, '11/20 的核定已經包含這張單，不用重新核定', false, false]);
  check('ex4-b', '核定與假別登記都沒動、沒有留底分頁', [apRows(m).length, lvRows(m).length, sheetVals(m, 'approved_revoked'), sheetVals(m, 'leave_revoked')], [1, 1, null, null]);
  const m2 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 4]], reqs: [TRIP8('T5', 'MZTJS11', '2026-11-20', { name: '示意丁' })] }));
  const r2 = dec(m2, 'T5');
  check('ex4-c', '登記出差 4、單 8 → 時數不同 → 打回；假別登記一起搬（leave 1）', [r2.reopened, r2.revoked.approved, r2.revoked.leave, r2.revoked.before.leaves, lvBak(m2).length], [true, 1, 1, [{ type: '出差', hours: 4 }], 1]);
  const m3 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 4]], reqs: [TRIP8('T6', 'MZTJS11', '2026-11-20', { name: '示意丁', hours: '' })] }));
  check('ex4-d', '單沒填時數、登記出差 4 → 同核定檢查口徑（單的時數空白算 0，跟登記 4 不同）→ 打回', !!dec(m3, 'T6').reopened, true);
  // 審查重現：出差 09–11（2 小時）已核准、核定登記出差 2；再補 14–16 出差 2 小時 → 合計 4 ≠ 登記 2 → 打回（以前會被同一列重複匹配成已包含）
  const TRP = (id, a, b, st) => TRIP8(id, 'MZTJS11', '2026-11-20', { name: '示意丁', start: a, end: b, hours: 2, status: st || 'pending' });
  const m7 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 2]], reqs: [TRP('T10', '09:00', '11:00', 'approved'), TRP('T11', '14:00', '16:00')] }));
  check('ex4-i', '第二張同假別同時數的出差單：合計 4 ≠ 登記 2 → 打回', [!!dec(m7, 'T11').reopened, 'day_ok' in dec(world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 2]], reqs: [TRP('T10', '09:00', '11:00', 'approved'), TRP('T11', '14:00', '16:00')] })), 'T11')], [true, false]);
  const m8 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 4]], reqs: [TRP('T10', '09:00', '11:00', 'approved'), TRP('T11', '14:00', '16:00')] }));
  check('ex4-j', '登記出差 4、兩張 2 小時（一張已核准）→ 合計 4＝登記 4 → 已包含', dec(m8, 'T11').day_ok, true);
  const m9 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 2], ['2026-11-20', '示意丁', '出差', 2]], reqs: [TRP('T10', '09:00', '11:00', 'approved'), TRP('T11', '14:00', '16:00')] }));
  check('ex4-k', '登記兩列出差各 2（合計 4）、兩張單合計 4 → 已包含', dec(m9, 'T11').day_ok, true);
  const mA = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 2]], reqs: [TRP('T10', '09:00', '11:00'), TRP('T11', '14:00', '16:00')] }));
  const rA = batch(mA, ['T10', 'T11']);
  check('ex4-l', '批次同時核准兩張（登記 2）：第一張合計 2＝2 已包含、第二張合計 4 → 打回', [(rA.day_ok_items || []).map((x) => x.id), (rA.warn_items || []).filter((x) => x.reopened).map((x) => x.id)], [['T10'], ['T11']]);
  const m4 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', 7.995]], reqs: [TRIP8('T7', 'MZTJS11', '2026-11-20', { name: '示意丁' })] }));
  check('ex4-e', '時數差 < 0.01 算相同', dec(m4, 'T7').day_ok, true);
  const m5 = world(Object.assign({}, base, { leave: [['2026-11-20', '示意丁', '出差', '']], reqs: [TRIP8('T8', 'MZTJS11', '2026-11-20', { name: '示意丁' })] }));
  check('ex4-f', '登記時數空白、單 8 → 拿不準 → 打回', !!dec(m5, 'T8').reopened, true);
  const m6 = world(Object.assign({}, base, { approved: [AP('2026-11-20', 'MZTJS11', '示意丁', '09:00-13:00', 8)], leave: [['2026-11-20', '示意丁', '事假', 4]],
    reqs: [{ id: 'L6', emp_id: 'MZTJS11', name: '示意丁', kind: 'leave', date: '2026-11-20', leave_type: '事假', start: '14:00', end: '18:00', hours: 4 }, { id: 'L7', emp_id: 'MZTJS11', name: '示意丁', kind: 'leave', date: '2026-11-20', leave_type: '特休假', start: '14:00', end: '18:00', hours: 4 }] }));
  check('ex4-g', '請假：同假別同時數 → 已包含', dec(m6, 'L6').day_ok, true);
  check('ex4-h', '請假：登記的是別的假別 → 打回', !!dec(m6, 'L7').reopened, true);
}
// 例 5：同一天補兩張，一起核准 → 只打回一次
{
  const m = world({ props: ON, approved: [AP('2026-11-19', 'MZTJS07', '示意甲', '10:00-18:00', 8)],
    reqs: [TRIP8('B1', 'MZTJS07', '2026-11-19', { name: '示意甲', hours: 4 }), { id: 'B2', emp_id: 'MZTJS07', name: '示意甲', kind: 'leave', date: '2026-11-19', leave_type: '事假', hours: 4, start: '14:00', end: '18:00' }] });
  const r = batch(m, ['B1', 'B2']);
  check('ex5-a', '兩張都核准', [r.done, r.skipped], [['B1', 'B2'], []]);
  check('ex5-b', 'warn_items 只有第一張（打回）；第二張不重打、不提醒', (r.warn_items || []).map((x) => [x.id, x.reopened, x.revoked.approved, x.message]),
    [['B1', true, 1, '11/19 原本已核定，已打回待核定，請重新核定這天']]);
  check('ex5-c', 'approved_revoked 只多那天那一列', [bakRows(m).length, apRows(m).length], [1, 0]);
  const m2 = world({ props: ON, approved: [AP('2026-11-19', 'MZTJS07', '示意甲', '10:00-18:00', 8), AP('2026-11-19', 'MZTGF06', '示意乙', '10:00-18:00', 8)],
    reqs: [TRIP8('B3', 'MZTJS07', '2026-11-19', { name: '示意甲', hours: 4 }), TRIP8('B4', 'MZTGF06', '2026-11-19', { name: '示意乙', hours: 4 })] });
  const r2 = batch(m2, ['B3', 'B4']);
  check('ex5-d', '不同人不互相影響：各打回各的', [(r2.warn_items || []).map((x) => x.id + ':' + x.emp_id), bakRows(m2).length], [['B3:MZTJS07', 'B4:MZTGF06'], 2]);
}
// 例 6：作廢（已打回）後再開新出差單 → 那天沒有核定 → 不打回
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '', 8, '出差')], leave: [['2026-11-20', '示意甲', '出差', 8]],
    reqs: [TRIP8('V1', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' }), TRIP8('V2', 'MZTJS07', '2026-11-20', { name: '示意甲', hours: 4 })] });
  const v = J(m.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'V1', reason: '改成 4 小時' }));
  check('ex6-a', '作廢照舊打回（回應不變：沒有 before）', [v.ok, v.revoked], [true, { approved: 1, leave: 1 }]);
  const r = dec(m, 'V2');
  check('ex6-b', '新出差單核准：那天沒核定 → 不打回、不提醒', [r.ok, 'warn' in r, 'reopened' in r, 'day_ok' in r, bakRows(m).length], [true, false, false, false, 1]);
}
// 例 7：忘打卡單（1A）→ 不打回、不提醒
{
  const m = world({ props: ON, approved: [AP('2026-11-21', 'MZTJS07', '示意甲', '10:00-14:00', 4)], reqs: [{ id: 'M1', emp_id: 'MZTJS07', name: '示意甲', kind: 'miss', date: '2026-11-21', miss_type: 'out', end: '19:00' }] });
  const r = dec(m, 'M1');
  check('ex7', '忘打卡單：照常核准、不打回、不提醒', [r.ok, r.status, 'warn' in r, 'reopened' in r, apRows(m).length], [true, 'approved', false, false, 1]);
}
// 例 8：已鎖月 → 核准被擋，不打回
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('P1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  m.run("payLockedBlock_ = function (d) { return String(d).slice(0, 7) === '2026-11' ? { ok: false, error: 'pay_locked', message: '11 月薪資已鎖定，請先到薪資頁解鎖' } : null; };");
  const r = dec(m, 'P1');
  check('ex8-a', '單筆：鎖月擋下、不打回、單子仍待審', [r.ok, r.error, apRows(m).length, sheetVals(m, 'approved_revoked'), st(m, 'P1')], [false, 'pay_locked', 1, null, 'pending']);
  const rb = batch(m, ['P1']);
  check('ex8-b', '批次：那筆略過、不打回', [rb.done, rb.skipped.map((x) => x.error), apRows(m).length], [[], ['pay_locked'], 1]);
}
// 例 9：未來日期 → 沒有核定 → 不打回
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-18:00', 8)], reqs: [{ id: 'F1', emp_id: 'MZTJS07', name: '示意甲', kind: 'leave', date: '2026-12-05', leave_type: '特休假', hours: 8 }] });
  const r = dec(m, 'F1');
  check('ex9', '12/5 特休：不打回、不提醒', [r.ok, 'warn' in r, 'reopened' in r, apRows(m).length], [true, false, false, 1]);
}
// 例 10：總部只有鏡像核定 → 不打回、照今天的提醒字；有自己的核定＋鏡像列 → 只搬自己的
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '09:00-18:00', 8, '正常', '央廚店長', '2026-11-21T20:00:00+08:00', 'CF')], reqs: [TRIP8('H1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const r = dec(m, 'H1');
  check('ex10-a', '只有鏡像列：照今天提醒（舊字）、不打回、鏡像列不動', [r.warn, r.message, 'reopened' in r, apRows(m).length, sheetVals(m, 'approved_revoked')],
    ['already_approved_day', '11/20 已經核定過，請重新核定一次，假別才會寫進薪資', false, 1, null]);
  const m2 = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '09:00-18:00', 8, '正常', '央廚店長', '2026-11-21T20:00:00+08:00', 'CF'), AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3, '正常', '店長', '2026-11-21T19:00:00+08:00')],
    reqs: [TRIP8('H2', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const r2 = dec(m2, 'H2');
  check('ex10-b', '自己的核定＋鏡像列：打回只搬自己的那列，鏡像列留著；before 是自己的那列', [r2.reopened, r2.revoked.approved, apRows(m2).map((x) => x[10]), r2.revoked.before.manager_name], [true, 1, ['CF'], '店長']);
  const m3 = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '09:00-18:00', 8, '正常', '央廚店長', '2026-11-21T20:00:00+08:00', 'CF')], reqs: [TRIP8('H3', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const rb = batch(m3, ['H3']);
  check('ex10-c', '批次只有鏡像列：warn_items 照今天的字', rb.warn_items, [{ id: 'H3', warn: 'already_approved_day', warn_dates: ['2026-11-20'], message: '11/20 已經核定過，請重新核定一次，假別才會寫進薪資' }]);
}
// 例 11：核准人＝原核定人 → 一樣打回
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3, '正常', '值班主管')], reqs: [TRIP8('S1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const r = dec(m, 'S1');
  check('ex11', '核准人與原核定人同一位：照樣打回', [r.reopened, r.revoked.before.manager_name], [true, '值班主管']);
}
// 例 12：打回時搬資料出錯 → 單子不核准
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('E1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const before = JSON.stringify(apRows(m));
  m.self.sh.approved.deleteRow = () => { throw new Error('試算表忙碌'); };
  const r = dec(m, 'E1');
  check('ex12-a', '單筆：revoke_failed、逐字訊息、單子仍待審、核定沒動', [r.ok, r.error, r.message, st(m, 'E1'), JSON.stringify(apRows(m)) === before],
    [false, 'revoke_failed', '這天的核定沒有打回成功，這張還沒核准，請再按一次', 'pending', true]);
  const m2 = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3), AP('2026-11-20', 'MZTGF06', '示意乙', '10:00-13:00', 3)],
    reqs: [TRIP8('E2', 'MZTJS07', '2026-11-20', { name: '示意甲' }), TRIP8('E3', 'MZTGF06', '2026-11-20', { name: '示意乙' })] });
  const sh2 = m2.self.sh.approved, del0 = sh2.deleteRow;
  sh2.deleteRow = (n) => { if (sh2.values[n - 1][1] === 'MZTJS07') throw new Error('試算表忙碌'); return del0(n); };
  const rb = batch(m2, ['E2', 'E3']);
  check('ex12-b', '批次：失敗那筆進 skipped（逐字理由）、其他照做', [rb.done, rb.skipped, (rb.warn_items || []).map((x) => x.id), st(m2, 'E2'), st(m2, 'E3')],
    [['E3'], [{ id: 'E2', reason: '這天的核定沒有打回成功，這張還沒核准，請再按一次' }], ['E3'], 'pending', 'approved']);
  // 判斷時讀不到表（例：approved 分頁讀取丟例外）→ 也不核准（不會出現半套）
  const m3 = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('E4', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  m3.self.sh.approved.getDataRange = () => { throw new Error('讀取逾時'); };
  const r3 = dec(m3, 'E4');
  check('ex12-c', '判斷時讀不到核定 → revoke_failed、單子仍待審', [r3.error, st(m3, 'E4')], ['revoke_failed', 'pending']);
}

console.log('\n══ 開關各種值 ══');
{
  const mk = (val) => world({ props: val === undefined ? {} : { REQ_REOPEN_ON: val }, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('W1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const OLD = [true, 'approved', 'already_approved_day', ['2026-11-20'], '11/20 已經核定過，請重新核定一次，假別才會寫進薪資', false, 1];
  const pk = (m, r) => [r.ok, r.status, r.warn, r.warn_dates, r.message, 'reopened' in r, apRows(m).length];
  [undefined, '', ' ', '0', 'on', 'yes', 'true', 'TRUE', ' 1x', '１', '01', '1.0', '11', 'l'].forEach((v) => {
    const m = mk(v); check('sw-off-' + JSON.stringify(v), '開關 ' + JSON.stringify(v) + ' → 照今天只提醒、不打回', pk(m, dec(m, 'W1')), OLD);
  });
  ['1', ' 1 ', '\t1\n', '　1'].forEach((v) => {
    const m = mk(v); const r = dec(m, 'W1');
    check('sw-on-' + JSON.stringify(v), '開關 ' + JSON.stringify(v) + ' → 打回', [r.reopened, apRows(m).length, r.message], [true, 0, '11/20 原本已核定，已打回待核定，請重新核定這天']);
  });
}

console.log('\n══ 不重複打回、退回、同名 ══');
{
  const m = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)],
    reqs: [TRIP8('D1', 'MZTJS07', '2026-11-20', { name: '示意甲', hours: 4 }), { id: 'D2', emp_id: 'MZTJS07', name: '示意甲', kind: 'leave', date: '2026-11-20', leave_type: '事假', hours: 4 }] });
  check('dup-a', '第一張打回', !!dec(m, 'D1').reopened, true);
  const again = dec(m, 'D1');
  check('dup-b', '同一張重送 → not_pending（不再打回）', [again.error, bakRows(m).length], ['not_pending', 1]);
  const r2 = dec(m, 'D2');
  check('dup-c', '同一天第二張單另外核准：那天已沒核定 → 不打回、不提醒', [r2.ok, 'warn' in r2, 'reopened' in r2, bakRows(m).length], [true, false, false, 1]);
  const m2 = world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('D3', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const rj = J(m2.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'D3', decision: 'reject', reason: '日期錯了', pay_unlocked: UNL }));
  check('dup-d', '退回：不打回、不提醒', [rj.ok, rj.status, 'warn' in rj, 'reopened' in rj, apRows(m2).length], [true, 'rejected', false, false, 1]);
  // 同名：名冊最後一位同名的是 E06；E05 的出差單、登記是「同名 出差 8」→ 不是他的登記 → 不算包含 → 打回；假別登記不搬（B14 同規則）
  const m3 = world({ props: ON, approved: [AP('2026-11-20', 'E05', '同名', '', 8, '出差')], leave: [['2026-11-20', '同名', '出差', 8]], reqs: [TRIP8('N1', 'E05', '2026-11-20', { name: '同名' })] });
  const r3 = dec(m3, 'N1');
  check('dup-e', '同名不是名冊最後一位：登記不算他的 → 打回、假別登記不搬', [r3.reopened, r3.revoked.approved, r3.revoked.leave, lvRows(m3).length], [true, 1, 0, 1]);
  const m4 = world({ props: ON, approved: [AP('2026-11-20', 'E06', '同名', '', 8, '出差')], leave: [['2026-11-20', '同名', '出差', 8]], reqs: [TRIP8('N2', 'E06', '2026-11-20', { name: '同名' })] });
  check('dup-f', '同名最後一位（登記是他的）→ 已包含', dec(m4, 'N2').day_ok, true);
  // 別家店的核定不動：這家沒有核定（別家才有）→ 不打回（只看開單這家店的 approved）
  const m5 = world({ props: ON, approved: [AP('2026-11-20', 'MZTGF06', '示意乙', '10:00-13:00', 3)], reqs: [TRIP8('N3', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  check('dup-g', '只有別人的核定 → 不打回', ['reopened' in dec(m5, 'N3'), apRows(m5).length], [false, 1]);
}

console.log('\n══ mini 引擎路徑與開關帶到引擎 ══');
{
  const KEY = 'relay-key-for-tests-0123456789';
  const fx = () => ({ approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('G1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const g = world(Object.assign({ relay: true, props: { REQ_REOPEN_ON: '1', RELAY_KEY: KEY } }, fx()));
  const pulled = J(g.sb.handleRelayPull_({ relay_key: KEY, with: { props: true } })).props;
  check('mini-a', 'relay_pull 帶開關給引擎（有設才帶）', pulled, { REQ_REOPEN_ON: '1' });
  const g0 = world(Object.assign({ relay: true, props: { RELAY_KEY: KEY } }, fx()));
  check('mini-b', '沒設開關 → relay_pull 的 props 跟以前一樣（不帶這個鍵）', J(g0.sb.handleRelayPull_({ relay_key: KEY, with: { props: true } })).props, {});
  const eng = world(Object.assign({ props: Object.assign({ REQ_BIND_FROM: 'off' }, pulled) }, fx()));      // 引擎沙盒：屬性只看拉回來的 props
  const rg = dec(g, 'G1'), re = J(eng.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'G1', decision: 'approve', pay_unlocked: UNL }, true));      // viaAuth＝引擎／寫回那條
  check('mini-c', '引擎（viaAuth）與 Google 判同一份資料：回應逐字相同（含 reopened／revoked）', JSON.stringify(re), JSON.stringify(rg));
  check('mini-d', '引擎路徑也真的打回', [re.reopened, apRows(eng).length], [true, 0]);
  const engOff = world(Object.assign({ props: { REQ_BIND_FROM: 'off' } }, fx()));
  const ro = J(engOff.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'G1', decision: 'approve', pay_unlocked: UNL }, true));
  check('mini-e', '引擎沒拿到開關 → 照今天只提醒、不打回', [ro.warn, 'reopened' in ro, apRows(engOff).length], ['already_approved_day', false, 1]);
  const gb = world(Object.assign({ relay: true, props: { REQ_REOPEN_ON: '1', RELAY_KEY: KEY } }, fx())), eb = world(Object.assign({ props: Object.assign({ REQ_BIND_FROM: 'off' }, pulled) }, fx()));
  const b1 = J(gb.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['G1'], decision: 'approve', pay_unlocked: UNL })), b2 = J(eb.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['G1'], decision: 'approve', pay_unlocked: UNL }, true));
  check('mini-f', '批次：引擎與 Google 回應逐字相同（含 warn_items 的 reopened／revoked）', [JSON.stringify(b2) === JSON.stringify(b1), (b1.warn_items || [])[0] && b1.warn_items[0].reopened], [true, true]);
}

console.log('\n══ 待審清單：核准前就標出來（第 5 題 A）══');
{
  const fx = (props) => world({ props, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3), AP('2026-11-21', 'MZTJS11', '示意丁', '', 8, '出差'), AP('2026-11-22', 'MZTGF06', '示意乙', '09:00-18:00', 9, '正常', '央廚', '2026-11-22T21:00:00+08:00', 'CF')],
    leave: [['2026-11-21', '示意丁', '出差', 8]],
    reqs: [TRIP8('Q1', 'MZTJS07', '2026-11-20', { name: '示意甲' }), TRIP8('Q2', 'MZTJS11', '2026-11-21', { name: '示意丁' }), TRIP8('Q3', 'MZTGF06', '2026-11-22', { name: '示意乙' }),
      { id: 'Q4', emp_id: 'MZTJS07', name: '示意甲', kind: 'miss', date: '2026-11-20', miss_type: 'out', end: '19:00' }, { id: 'Q5', emp_id: 'MZTJS07', name: '示意甲', kind: 'leave', date: '2026-12-05', leave_type: '特休假', hours: 8 }] });
  const on = J(fx(ON).sb.handleMgrReqPending_({ mgr_key: 'MK' }));
  check('pend-a', '開關開：只有「現在核准會打回」的那張標 day_approved（已包含、只有鏡像、忘打卡、未來日期都不標）',
    on.items.map((x) => x.id + ':' + (x.day_approved === true)), ['Q1:true', 'Q2:false', 'Q3:false', 'Q4:false', 'Q5:false']);
  const off = J(fx({}).sb.handleMgrReqPending_({ mgr_key: 'MK' }));
  check('pend-b', '開關關：沒有任何一張帶 day_approved 這個鍵', off.items.some((x) => 'day_approved' in x), false);
  const mb = fx({}); mb.run(BASE_REQ);
  check('pend-c', '開關關：待審清單回應與改版前逐字相同', JSON.stringify(off), JSON.stringify(J(mb.sb.handleMgrReqPending_({ mgr_key: 'MK' }))));
}

console.log('\n══ 開關關著：回應與寫入跟改版前逐位元組相同（隨機對照）══');
{
  // 簡單可重現的亂數
  let seed = Number(process.env.REOPEN_SEED || 20261126);
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const N = Number(process.env.REOPEN_N || 200);
  const EMPS = [['MZTJS07', '示意甲'], ['MZTGF06', '示意乙'], ['E05', '同名'], ['E06', '同名']];
  const DATES = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-12-02'];
  const OFFV = [undefined, '', '0', 'true', 'on', ' 1x'];
  let same = 0, diff = [];
  for (let k = 0; k < N; k++) {
    const approved = [], leave = [], reqs = [];
    EMPS.forEach(([e, n]) => DATES.slice(0, 3).forEach((d) => {
      const x = rnd();
      if (x < 0.35) approved.push(AP(d, e, n, pick(['10:00-13:00', '12:00-20:00', '09:00-13:00,14:00-18:00', '']), pick([3, 8, 9]), pick(['正常', '出差']), '店長', d + 'T2' + Math.floor(rnd() * 9) + ':00:00+08:00'));
      else if (x < 0.45) approved.push(AP(d, e, n, '09:00-18:00', 8, '正常', '央廚', d + 'T21:00:00+08:00', 'CF'));
      if (rnd() < 0.3) leave.push([d, n, pick(['出差', '事假', '特休假']), pick([4, 8, ''])]);
    }));
    const nReq = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < nReq; i++) {
      const [e, n] = pick(EMPS), d = pick(DATES), kind = pick(['leave', 'trip', 'ot', 'miss']);
      const q = { id: 'R' + k + '_' + i, emp_id: e, name: n, kind, date: d };
      if (kind === 'leave') Object.assign(q, { leave_type: pick(['事假', '特休假']), hours: pick([4, 8, '']), start: '14:00', end: '18:00' });
      if (kind === 'trip') Object.assign(q, { leave_type: '出差', hours: pick([4, 8, '']) });
      if (kind === 'ot') Object.assign(q, pick([{ start: '20:00', end: '22:00', hours: 2 }, { start: '18:00', end: '19:00', hours: 1 }, { start: '12:30', end: '13:30', hours: 1 }]));
      if (kind === 'miss') Object.assign(q, { miss_type: 'out', end: '19:00' });
      reqs.push(q);
    }
    const v = pick(OFFV), props = v === undefined ? {} : { REQ_REOPEN_ON: v };
    const fx = { props, approved, leave, reqs };
    const a = world(fx), b = world(Object.assign({ base: true }, fx));
    const ops = [];
    const useBatch = rnd() < 0.4;
    const ids = reqs.map((q) => q.id);
    const run = (m) => {
      const out = [];
      out.push(J(m.sb.handleMgrReqPending_({ mgr_key: 'MK' })));
      if (useBatch) out.push(J(m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids, decision: 'approve', pay_unlocked: UNL })));
      else ids.forEach((id, i) => out.push(J(m.sb.handleMgrReqDecide_(i % 4 === 3 ? { mgr_key: 'MK', id, decision: 'reject', reason: '錯', pay_unlocked: UNL } : { mgr_key: 'MK', id, decision: 'approve', pay_unlocked: UNL }))));
      out.push(Object.keys(m.self.sh).sort().map((nm) => [nm, m.self.sh[nm].values]));
      return JSON.stringify(out);
    };
    const ra = run(a), rb = run(b);
    if (ra === rb) same++; else diff.push(k);
    ops.length = 0;
  }
  check('off-eq', '開關關著（沒設／空白／0／true／on／ 1x）隨機 ' + N + ' 組：待審清單、核准／批次／退回回應、所有分頁內容跟改版前逐位元組相同', [same, diff.slice(0, 5)], [N, []]);
  // 對照組：開關開著時同一套比對要抓得到差異（證明比對有效）
  const fxOn = { props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('C1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] };
  const a2 = world(fxOn), b2 = world(Object.assign({ base: true }, fxOn));
  check('off-eq-ctl', '對照組：開關開著時跟改版前不同（比對有效）', JSON.stringify(dec(a2, 'C1')) === JSON.stringify(dec(b2, 'C1')), false);
}

console.log('\n══ 鎖月狀態讀不到：照常核准、不打回、照今天的提醒（2026-11-26 驗收第 2 項，大腦裁定保守解讀第 7 題）══');
{
  const fx = () => world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], reqs: [TRIP8('K1', 'MZTJS07', '2026-11-20', { name: '示意甲' }), TRIP8('K2', 'MZTJS07', '2026-11-20', { name: '示意甲', hours: 4 })] });
  const OLD = ['already_approved_day', '11/20 已經核定過，請重新核定一次，假別才會寫進薪資', false, 1];
  const pk = (m, r) => [r.warn, r.message, 'reopened' in r, apRows(m).length];
  let m = fx(); check('lock-a', '打卡端讀不到鎖月、沒帶 pay_unlocked → 照今天提醒、不打回', pk(m, dec(m, 'K1', { pay_unlocked: undefined })), OLD);
  m = fx(); check('lock-b', '帶的是別的月份（2026-12）→ 不打回', pk(m, dec(m, 'K1', { pay_unlocked: ['2026-12'] })), OLD);
  m = fx(); check('lock-c', 'pay_unlocked 格式不對（字串）→ 不打回', pk(m, dec(m, 'K1', { pay_unlocked: '2026-11' })), OLD);
  m = fx(); const rb = J(m.sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: ['K1', 'K2'], decision: 'approve' }));
  check('lock-d', '批次沒帶 → 兩張都照今天提醒、不打回', [rb.done, (rb.warn_items || []).map((x) => [x.id, x.message, 'reopened' in x]), apRows(m).length],
    [['K1', 'K2'], [['K1', OLD[1], false], ['K2', OLD[1], false]], 1]);
  m = fx(); m.run('payLockedFor_ = function () { return false; };');
  check('lock-e', '本店讀得到、確定沒鎖（光復有薪資模組）→ 不用帶也打回', !!dec(m, 'K1', { pay_unlocked: undefined }).reopened, true);
  m = fx(); m.run('payLockedFor_ = function () { return undefined; };');
  check('lock-f', '本店讀不到、營運系統說 11 月沒鎖 → 打回', !!dec(m, 'K1').reopened, true);
  m = fx(); m.run('payLockedFor_ = function () { return true; };');
  const rl = dec(m, 'K1');
  check('lock-g', '已鎖月（就算帶了 pay_unlocked）→ 核准本身被擋、不打回', [rl.error, apRows(m).length, st(m, 'K1')], ['pay_locked', 1, 'pending']);
  m = fx(); m.run('payLockedFor_ = function () { return undefined; };');
  check('lock-h', '本店讀不到（payLockedFor_ 回 undefined，它自己吃掉例外）、也沒帶 → 照今天提醒（不卡核准）', pk(m, dec(m, 'K1', { pay_unlocked: undefined })), OLD);
}

console.log('\n══ 打回做到一半失敗：每一個寫入步驟各失敗一次 → 單子不核准、不留半套 → 再按一次＝跟一次成功逐格相同（驗收第 1 項）══');
{
  const snap = (m) => JSON.stringify(Object.keys(m.self.sh).sort().map((nm) => [nm, m.self.sh[nm].values]));
  const live = (m, emp, name) => JSON.stringify([apRows(m).filter((x) => x[1] === emp && !x[10]).map((x) => x.join('|')).sort(), lvRows(m).filter((x) => x[1] === name).map((x) => x.join('|')).sort()]);
  // 寫入計數：插分頁、加列、刪列（留底分頁是中途才建的，建的時候也包起來）；第 failAt 次丟例外（只丟一次）
  function hook(m, failAt) {
    const st0 = { n: 0, fired: false };
    const wrap = (sh) => {
      if (sh.__hooked) return sh; sh.__hooked = true;
      const ap = sh.appendRow, dl = sh.deleteRow;
      sh.appendRow = (row) => { if (++st0.n === failAt && !st0.fired) { st0.fired = true; throw new Error('注入失敗 #' + failAt); } return ap(row); };
      sh.deleteRow = (r) => { if (++st0.n === failAt && !st0.fired) { st0.fired = true; throw new Error('注入失敗 #' + failAt); } return dl(r); };
      return sh;
    };
    Object.keys(m.self.sh).forEach((k) => wrap(m.self.sh[k]));
    const ins = m.self.insertSheet;
    m.self.insertSheet = (nm) => { if (++st0.n === failAt && !st0.fired) { st0.fired = true; throw new Error('注入失敗 #' + failAt); } return wrap(ins(nm)); };
    return st0;
  }
  const scenarios = [
    { label: '補單打回（出差單）', act: (m) => dec(m, 'J1'), emp: 'MZTJS07', name: '示意甲',
      fx: () => world({ props: ON, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3, '正常', '店長', '2026-11-21T19:00:00+08:00'), AP('2026-11-20', 'MZTGF06', '示意乙', '10:00-18:00', 8),
          AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-14:00', 4, '正常', '店長', '2026-11-21T20:00:00+08:00'), AP('2026-11-20', 'MZTJS07', '示意甲', '09:00-18:00', 8, '正常', '央廚', '2026-11-21T21:00:00+08:00', 'CF'), AP('2026-11-21', 'MZTJS07', '示意甲', '10:00-18:00', 8)],
        leave: [['2026-11-20', '示意甲', '事假', 2], ['2026-11-20', '示意乙', '事假', 1], ['2026-11-20', '示意甲', '出差', 4], ['2026-11-21', '示意甲', '出差', 8]],
        reqs: [TRIP8('J1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] }) },
    { label: '作廢（原本就用這支）', act: (m) => J(m.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'J2', reason: '改單' })), emp: 'MZTJS07', name: '示意甲',
      fx: () => world({ approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '', 8, '出差'), AP('2026-11-20', 'MZTGF06', '示意乙', '10:00-18:00', 8)], leave: [['2026-11-20', '示意甲', '出差', 8], ['2026-11-20', '示意乙', '事假', 1]],
        reqs: [TRIP8('J2', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] }) },
  ];
  scenarios.forEach((sc, si) => {
    const ref = sc.fx(), cnt = hook(ref, Infinity), r0 = sc.act(ref), S1 = snap(ref), N = cnt.n;
    check('half-' + si + '-ref', sc.label + '：一次成功的寫入次數（插分頁＋加列＋刪列）', N > 0 && r0.ok === true, true, 'N=' + N);
    let allOk = true; const bad = [];
    for (let k = 1; k <= N; k++) {
      const m = sc.fx(), live0 = live(m, sc.emp, sc.name), h = hook(m, k);
      const r1 = sc.act(m);
      const halfOk = r1.error === 'revoke_failed' && h.fired && live(m, sc.emp, sc.name) === live0 && st(m, sc.id || (si === 0 ? 'J1' : 'J2')) === (si === 0 ? 'pending' : 'approved');
      const r2 = sc.act(m);
      const sameOk = JSON.stringify(r2) === JSON.stringify(r0) && snap(m) === S1;
      if (!halfOk || !sameOk) { allOk = false; bad.push({ k, halfOk, sameOk, r1: r1.error }); }
    }
    check('half-' + si, sc.label + '：第 1～' + N + ' 次寫入各失敗一次 → 回 revoke_failed、單子沒變、核定列與假別登記都還在原表（沒有半套）→ 再按一次：回應與所有分頁跟一次成功逐格相同', [allOk, bad.slice(0, 3)], [true, []]);
  });
  // 作廢路徑正常情況：回應與所有分頁跟改版前（REOPEN_BASE）逐格相同
  const vfx = scenarios[1].fx;
  const a = vfx(), b = world(Object.assign({ base: true }, { approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '', 8, '出差'), AP('2026-11-20', 'MZTGF06', '示意乙', '10:00-18:00', 8)], leave: [['2026-11-20', '示意甲', '出差', 8], ['2026-11-20', '示意乙', '事假', 1]],
    reqs: [TRIP8('J2', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] }));
  const va = scenarios[1].act(a), vb = scenarios[1].act(b);
  check('half-void-eq', '作廢正常情況：回應與所有分頁跟改版前逐格相同', [JSON.stringify(va) === JSON.stringify(vb), snap(a) === snap(b)], [true, true]);
  const a2 = scenarios[0].fx(), b2 = world({ base: true, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], leave: [['2026-11-20', '示意甲', '出差', 4]], reqs: [TRIP8('J9', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
  const a3 = world({ approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3)], leave: [['2026-11-20', '示意甲', '出差', 4]], reqs: [TRIP8('J9', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
  const v2 = J(a3.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'J9', reason: '錯' })), v3 = J(b2.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'J9', reason: '錯' }));
  check('half-void-eq2', '作廢（核定＋假別各一列）正常情況：跟改版前逐格相同', [JSON.stringify(v2) === JSON.stringify(v3), snap(a3) === snap(b2)], [true, true]);
  void a2;
  // 對照組：改版前的作廢（先搬核定、再搬假別）在「刪假別那一步」失敗 → 留下半套（核定列已搬走、假別還在）——證明上面的檢查抓得到
  const bc = world({ base: true, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '', 8, '出差')], leave: [['2026-11-20', '示意甲', '出差', 8]], reqs: [TRIP8('J8', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
  const lv0 = live(bc, 'MZTJS07', '示意甲');
  hook(bc, 8);      // 改版前的寫入順序：插核定留底、表頭、留底列、刪核定、插假別留底、表頭、留底列、刪假別（第 8 次）
  const rc = J(bc.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'J8', reason: '錯' }));
  check('half-ctl', '對照組：改版前在刪假別時失敗 → revoke_failed 但核定列已搬走、假別還在（半套）', [rc.error, live(bc, 'MZTJS07', '示意甲') !== lv0, apRows(bc).length, lvRows(bc).length], ['revoke_failed', true, 0, 1]);
}

console.log('\n══ 鏡像假別登記不搬（獨立審查第 2 項）＋留底分頁四種狀態跟改版前逐格相同（第 3 項）══');
{
  const snap = (m) => JSON.stringify(Object.keys(m.self.sh).sort().map((nm) => [nm, m.self.sh[nm].values]));
  const withMirrorLeave = (m, rows) => { const lv = m.self.sh.leave.values; lv[0] = ['日期', '姓名', '假別', '時數', 'mirror_src']; rows.forEach((r) => lv.push(r.slice())); return m; };
  // 同人同日：本店核定＋總部鏡像核定；假別登記：本店出差 2＋從央廚抄來的出差 2（mirror_src=CF）
  const fx = (o) => withMirrorLeave(world(Object.assign({ approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '09:00-18:00', 8, '正常', '央廚', '2026-11-21T20:00:00+08:00', 'CF'), AP('2026-11-20', 'MZTJS07', '示意甲', '10:00-13:00', 3, '正常', '店長', '2026-11-21T19:00:00+08:00')] }, o)),
    [['2026-11-20', '示意甲', '出差', 2, ''], ['2026-11-20', '示意甲', '出差', 2, 'CF']]);
  const m = fx({ props: ON, reqs: [TRIP8('MR1', 'MZTJS07', '2026-11-20', { name: '示意甲' })] });
  const r = dec(m, 'MR1');
  check('mir-a', '補單打回：搬本店核定與本店假別登記；鏡像核定與鏡像假別登記都留著', [r.reopened, r.revoked.approved, r.revoked.leave, apRows(m).map((x) => x[10]), lvRows(m).map((x) => x[4])], [true, 1, 1, ['CF'], ['CF']]);
  const mc = fx({ props: ON, reqs: [TRIP8('MR2', 'MZTJS07', '2026-11-20', { name: '示意甲', hours: 2 })] });
  check('mir-b', '已包含的判斷只看本店登記（本店出差 2＝單 2 → 已包含；鏡像那筆不算進合計）', dec(mc, 'MR2').day_ok, true);
  // 作廢：改版前會把鏡像假別登記一起搬走（同一個問題），這次一起改成不搬——回報說明的行為差異
  const v = fx({ reqs: [TRIP8('MV', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
  const vb = fx({ base: true, reqs: [TRIP8('MV', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
  const rv = J(v.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'MV', reason: '錯' })), rvb = J(vb.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'MV', reason: '錯' }));
  check('mir-c', '作廢（同人同日有鏡像假別登記）：改版前搬 2 列假別（含鏡像）、現在只搬本店那 1 列', [rvb.revoked, rv.revoked, lvRows(vb).length, lvRows(v).map((x) => x[4])], [{ approved: 1, leave: 2 }, { approved: 1, leave: 1 }, 0, ['CF']]);

  // 留底分頁四種狀態：作廢的回應與所有分頁跟改版前逐格相同
  const AH2 = AH.concat(['revoked_at', 'revoke_reason']), LH2 = ['日期', '姓名', '假別', '時數', 'emp_id', 'revoked_at', 'revoke_reason'];
  const OLDROW = ['2026-11-01', 'X1', '舊', '09:00-10:00', 1, '正常', '店長', '2026-11-02T10:00:00+08:00', '', '', '', '2026-11-03T00:00:00+08:00', '舊的作廢'];
  const states = { 不存在: null, 存在且空: [], 存在有表頭: [AH2], 存在有資料: [AH2, OLDROW] };
  const lstates = { 不存在: null, 存在且空: [], 存在有表頭: [LH2], 存在有資料: [LH2, ['2026-11-01', '舊', '事假', 1, 'X1', '2026-11-03T00:00:00+08:00', '舊的作廢']] };
  Object.keys(states).forEach((k, i) => {
    const mk = (base) => {
      const w = world({ base, approved: [AP('2026-11-20', 'MZTJS07', '示意甲', '', 8, '出差')], leave: [['2026-11-20', '示意甲', '出差', 8]], reqs: [TRIP8('VS', 'MZTJS07', '2026-11-20', { name: '示意甲', status: 'approved' })] });
      if (states[k]) { w.self.insertSheet('approved_revoked').values.push(...states[k].map((x) => x.slice())); w.self.insertSheet('leave_revoked').values.push(...lstates[k].map((x) => x.slice())); }
      return w;
    };
    const a = mk(false), b = mk(true);
    const ra = J(a.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'VS', reason: '錯' })), rb = J(b.sb.handleMgrReqVoid_({ mgr_key: 'MK', id: 'VS', reason: '錯' }));
    check('bak-' + i, '作廢、留底分頁「' + k + '」：回應與所有分頁跟改版前逐格相同', [JSON.stringify(ra) === JSON.stringify(rb), snap(a) === snap(b)], [true, true]);
  });
}

done();
