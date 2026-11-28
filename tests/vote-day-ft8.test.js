// 投票日不檢查「正職上班日要滿 8 小時」（2026-11-29 主管定案 D「投票日全放行」；Requests.gs REQ_VOTE_DAYS_／reqVoteDay_）。
// 走真 doPost（mgr_approve、mgr_approve dry_run、mgr_approve_check 一批），並拿「改動前」的 Requests.gs 在同一份假資料上逐字比對：
// 除了「投票日＋正職＋不滿 8」那幾種，其他情況回應要一模一樣。
// 改動前＝現在這份拿掉放行條件（`&& !reqVoteDay_(date)`，要剛好出現一次）；不靠 git 基準，所以疊在別的 PR 上、rebase 後都照樣成立。
// 要拿某個 commit 的 Requests.gs 當改動前：VOTE_BASE=<commit>（那個 commit 其他檔要跟現在相同才有意義）。
// 另鎖投票日清單三處相同：Requests.gs REQ_VOTE_DAYS_、光復 Payroll.gs PAY_ELEC_VOTE_DAYS、營運系統 web/modules/duty/vote-days.js（凍結副本＋雜湊）。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const { make, T, check, done, ROOT } = require('./helpers/gs-sandbox');

const PASS = ' && !reqVoteDay_(date)';
const CUR = fs.readFileSync(path.join(ROOT, 'apps-script/Requests.gs'), 'utf8');
let OLD = null;
if (process.env.VOTE_BASE) {
  try { OLD = execFileSync('git', ['show', process.env.VOTE_BASE + ':apps-script/Requests.gs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) { OLD = null; }
  if (!OLD) { console.error('讀不到 ' + process.env.VOTE_BASE + ' 版的 Requests.gs'); process.exit(1); }
} else {
  const n = CUR.split(PASS).length - 1;
  if (n > 1) { console.error('放行條件出現 ' + n + ' 次，改動前的版本做不出來'); process.exit(1); }
  OLD = CUR.split(PASS).join('');   // 0 次＝放行那行被拿掉（變異驗證）：改動前＝現在，下面放行的測試會紅
}

const VOTE = '2026-11-28', PREV = '2026-11-27', NEXT = '2026-11-29';
const NOW = T('2026-11-30T10:00:00');
const ACT = { mgr_key: 'AK', acting_name: '店長甲（DZY001）' };
const evDay = (d, emp, a, b) => [[d + 'T' + a + ':00', emp, 'in'], [d + 'T' + b + ':00', emp, 'out']];
/** 本店 E01 每天 09:00–14:00（5 小時）、E02 每天 10:00–13:00（3 小時）、E03 每天 09:00–19:00（10 小時）；別家 PEER1 有同名的 P01（跨店甲） */
function env(old, o) {
  o = o || {};
  const events = [];
  [PREV, VOTE, NEXT].forEach((d) => { events.push.apply(events, evDay(d, 'E01', '09:00', '14:00')); events.push.apply(events, evDay(d, 'E02', '10:00', '13:00')); events.push.apply(events, evDay(d, 'E03', '09:00', '19:00')); });
  const m = make({ now: NOW, props: o.props || {},
    self: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' },
      { emp_id: 'E03', name: '測試三', key: 'K3', active: 'TRUE', line_user_id: 'U3' }, { emp_id: 'E04', name: '跨店甲', key: 'K4', active: 'TRUE', line_user_id: 'U4' }],
      events: events.concat(evDay(VOTE, 'E04', '17:00', '22:00'), evDay(PREV, 'E04', '17:00', '22:00')) },
    peers: o.peer ? { PEER1: { roster: [{ emp_id: 'P01', name: '跨店甲', key: 'KP', active: 'TRUE', line_user_id: '' }],
      approved: [VOTE, PREV].map((d) => [d, 'P01', '跨店甲', '[{"start":"09:00","end":"' + o.peer + '"}]', Number(o.peer.slice(0, 2)) - 9, '正常', '值班主管', d + 'T19:00:00+08:00', '', '']) } } : undefined });
  if (old) vm.runInContext(OLD, m.sb, { filename: 'Requests.gs（改動前）' });   // 頂層函式整份換回改動前的版本
  const post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  return { m, post };
}
const item = (emp, a, b, x) => Object.assign({ emp_id: emp, periods: [{ start: a, end: b }], sched_ft: true, sched_day: 'W' }, x || {});
const approve = (e, date, it, extra) => e.post(Object.assign({ action: 'mgr_approve', date: date }, ACT, it, extra || {}));
const batch = (e, date, items) => e.post(Object.assign({ action: 'mgr_approve_check', date: date, items: items }, ACT));
const isFt8 = (r) => /正職上班日要滿 8 小時/.test(String(r && r.message || '')) || ((r && r.probs) || []).some((p) => p.rule === 'ft8');

// ── 1. 清單本身 ──
const NEW_SRC = fs.readFileSync(path.join(ROOT, 'apps-script/Requests.gs'), 'utf8');
const listOf = (src, name) => { const mm = new RegExp('^var ' + name + ' = (\\[[^\\]]*\\]);', 'm').exec(src); return mm ? vm.runInNewContext(mm[1]) : null; };
const LINE_RE = /^var REQ_VOTE_DAYS_ = \[[^\]]*\];$/m;
{
  const e = env(false);
  check('V01', '投票日清單：只有 2026-11-28；reqVoteDay_ 只認這天（前後一天、空白、怪格式都不是）',
    [JSON.stringify(e.m.sb.REQ_VOTE_DAYS_), e.m.sb.reqVoteDay_(VOTE), e.m.sb.reqVoteDay_(PREV), e.m.sb.reqVoteDay_(NEXT), e.m.sb.reqVoteDay_(''), e.m.sb.reqVoteDay_(undefined), e.m.sb.reqVoteDay_('2026/11/28'), e.m.sb.reqVoteDay_(' 2026-11-28')],
    ['["2026-11-28"]', true, false, false, false, false, false, false]);
  const pay = listOf(fs.readFileSync(path.join(ROOT, 'apps-script/Payroll.gs'), 'utf8'), 'PAY_ELEC_VOTE_DAYS');
  check('V02', '跟光復薪資 PAY_ELEC_VOTE_DAYS 相同（一邊加日期另一邊沒加＝紅）', JSON.stringify(pay), JSON.stringify(e.m.sb.REQ_VOTE_DAYS_));
  // 營運系統那份（web/modules/duty/vote-days.js）凍結的是這一行的雜湊：這行一改，營運系統的一致性測試就會紅，提醒兩邊一起改
  const line = (LINE_RE.exec(NEW_SRC) || [''])[0];
  check('V03', '打卡端定義那一行的雜湊（營運系統 tests 凍結同一個值）', crypto.createHash('sha256').update(line).digest('hex').slice(0, 16), '9520d588b53da1b9');
  const so = process.env.STORE_OPS_ROOT || path.join(ROOT, '..', '..', 'mala-store-ops');
  const soFile = path.join(so, 'web/modules/duty/vote-days.js');
  if (fs.existsSync(soFile)) {
    const mm = /export const VOTE_DAYS = Object\.freeze\((\[[^\]]*\])\)/.exec(fs.readFileSync(soFile, 'utf8'));
    check('V04', '旁邊有營運系統的副本：清單跟打卡端相同', mm ? JSON.stringify(vm.runInNewContext(mm[1])) : null, JSON.stringify(e.m.sb.REQ_VOTE_DAYS_));
  } else console.log('• V04 旁邊沒有營運系統的 vote-days.js（' + soFile + '），只靠雜湊（V03）鎖');
}

// ── 2. 投票日＋正職不滿 8：放行（真送出、試算、一批只檢查）；改動前會擋 ──
{
  const o = env(true), n = env(false);
  const ro = approve(o, VOTE, item('E01', '09:00', '14:00'), { dry_run: true }), rn = approve(n, VOTE, item('E01', '09:00', '14:00'), { dry_run: true });
  check('V10', '改動前：投票日正職 5 小時被擋、要補 3 小時假單（證明這組情境會踩到）', [ro.ok, ro.error, isFt8(ro), ro.need && ro.need.leave_hours], [false, 'need_request', true, 3]);
  check('V11', '投票日正職 5 小時：試算放行、不要補單', [rn.ok, rn.dry_run, isFt8(rn)], [true, true, false]);
  const n0 = n.m.approved().length;
  const w = approve(n, VOTE, item('E01', '09:00', '14:00'));
  check('V12', '真的送出：寫入一筆、核定 5 小時', [w.ok, n.m.approved().length - n0, (n.m.approved().slice(-1)[0] || [])[4]], [true, 1, 5]);
  // 連續核定：核完一個人緊接著核下一個（同一個沙盒、同一次頁面工作階段）
  const w2 = approve(n, VOTE, item('E02', '10:00', '13:00'));
  check('V13', '緊接著核定下一位（E02 3 小時）也放行、再寫一筆', [w2.ok, n.m.approved().length - n0], [true, 2]);
  const w3 = approve(n, PREV, item('E01', '09:00', '14:00'));
  check('V14', '再接著核前一天（11/27，不是投票日）照擋、要補 3 小時', [w3.ok, w3.error, isFt8(w3), w3.need && w3.need.leave_hours, n.m.approved().length - n0], [false, 'need_request', true, 3, 2]);
  const w4 = approve(n, VOTE, item('E01', '09:00', '14:00'));
  check('V15', '再回頭重新核定投票日那位：照放行（重新核定覆蓋）', w4.ok, true);
}
{
  const o = env(true), n = env(false);
  const its = [item('E01', '09:00', '14:00'), item('E02', '10:00', '13:00'), item('E03', '09:00', '19:00')];
  const bo = batch(o, VOTE, its), bn = batch(n, VOTE, its);
  check('V20', '一批只檢查（改動前）：E01、E02 因不滿 8 被擋', bo.results.map((x) => [x.emp_id, x.ok, isFt8(x)]), [['E01', false, true], ['E02', false, true], ['E03', false, false]]);
  check('V21', '一批只檢查：投票日 E01、E02 放行；E03（10 小時沒加班單）照擋、原因跟改動前一字不差',
    [bn.results.map((x) => [x.emp_id, x.ok, isFt8(x)]), JSON.stringify(bn.results[2]) === JSON.stringify(bo.results[2])], [[['E01', true, false], ['E02', true, false], ['E03', false, false]], true]);
  const bp = batch(n, PREV, its.slice(0, 2));
  check('V22', '一批只檢查前一天（非投票日）：照擋', bp.results.map((x) => [x.emp_id, x.ok, isFt8(x)]), [['E01', false, true], ['E02', false, true]]);
}
{
  // 跨店：投票日這家 5 小時（支援帳號）、別家已核定 2 小時＝合計 7 → 改動前擋、改動後放行；加班歸屬不受影響
  const o = env(true, { peer: '11:00' }), n = env(false, { peer: '11:00' });
  const it = item('E04', '17:00', '22:00', { sched_support: true });
  const ro = approve(o, VOTE, it, { dry_run: true }), rn = approve(n, VOTE, it, { dry_run: true });
  check('V30', '跨店合計 7（投票日）：改動前擋（還差 1）、改動後放行', [ro.ok, isFt8(ro), ro.need && ro.need.leave_hours, rn.ok], [false, true, 1, true]);
}

// ── 3. 其他情況：回應跟改動前逐字相同 ──
const SAME = [
  ['非投票日（11/27）正職 5 小時', {}, PREV, item('E01', '09:00', '14:00')],
  ['非投票日（11/29）正職 3 小時', {}, NEXT, item('E02', '10:00', '13:00')],
  ['投票日班表休息日 H（5 小時全算加班、要加班單）', {}, VOTE, item('E01', '09:00', '14:00', { sched_day: 'H' })],
  ['投票日班表例假 R', {}, VOTE, item('E01', '09:00', '14:00', { sched_day: 'R' })],
  ['投票日計時（sched_ft false）5 小時', {}, VOTE, item('E01', '09:00', '14:00', { sched_ft: false })],
  ['投票日沒帶正職（門市共用登入那種）', {}, VOTE, { emp_id: 'E01', periods: [{ start: '09:00', end: '14:00' }] }],
  ['投票日 REQ_FT8_FROM=off', { props: { REQ_FT8_FROM: 'off' } }, VOTE, item('E01', '09:00', '14:00')],
  ['投票日正職剛好 8 小時（09:00–17:00 核定，打卡到 19:00）', {}, VOTE, item('E03', '09:00', '17:00')],
  ['投票日正職 10 小時沒有加班單（超過 8 要加班單照舊）', {}, VOTE, item('E03', '09:00', '19:00')],
  ['投票日支援帳號 5 小時＋別家已核定 6 小時＝11（跨店加班歸屬照舊）', { peer: '15:00' }, VOTE, item('E04', '17:00', '22:00', { sched_support: true })],
  ['投票日原單位 5 小時＋被支援那家已核定 6 小時', { peer: '15:00' }, VOTE, item('E04', '17:00', '22:00', { sched_support: false })],
  ['非投票日支援帳號 5＋別家 2＝7', { peer: '11:00' }, PREV, item('E04', '17:00', '22:00', { sched_support: true })],
];
SAME.forEach((c, i) => {
  const o = env(true, c[1]), n = env(false, c[1]);
  const ro = approve(o, c[2], c[3], { dry_run: true }), rn = approve(n, c[2], c[3], { dry_run: true });
  const bo = batch(o, c[2], [c[3]]), bn = batch(n, c[2], [c[3]]);
  const so = approve(o, c[2], c[3]), sn = approve(n, c[2], c[3]);
  check('V4' + i, c[0] + '：試算、一批只檢查、真送出都跟改動前逐字相同（' + (sn.ok ? '可核定' : '擋：' + sn.error) + '）',
    [JSON.stringify(rn) === JSON.stringify(ro), JSON.stringify(bn) === JSON.stringify(bo), JSON.stringify(sn) === JSON.stringify(so), JSON.stringify(n.m.approved()) === JSON.stringify(o.m.approved())], [true, true, true, true]);
});
{
  // 上面那組「其他情況」至少要有被擋的（不然比對沒意義）
  const e = env(false);
  check('V60', '對照：非投票日 5 小時、投票日 10 小時沒加班單、投票日休息日都是被擋的', [approve(e, PREV, item('E01', '09:00', '14:00'), { dry_run: true }).ok, approve(e, VOTE, item('E03', '09:00', '19:00'), { dry_run: true }).ok, approve(e, VOTE, item('E01', '09:00', '14:00', { sched_day: 'H' }), { dry_run: true }).ok], [false, false, false]);
}
done();
