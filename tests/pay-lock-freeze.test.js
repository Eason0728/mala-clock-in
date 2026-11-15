/**
 * 薪資鎖月後不可以再動（Eason 2026-11-15 定）：這家店這個月薪資已「鎖定本月」（payroll_run 該店該月 status=final）之後，
 * 日期落在那個月的這些動作，打卡端一律回 { ok:false, error:'pay_locked', message }，資料不動：
 *   主管核定／重新核定（mgr_approve，含只檢查 dry_run、mgr_approve_check）、主管核准／退回申請（單筆、批次）、
 *   主管代開（mgr_req_proxy）、同仁自己送申請（req_submit）、作廢（mgr_req_void）。
 * 不擋：同仁撤回待審單（req_cancel）、別的月份、別家店鎖的月份、讀不到鎖月狀態（沒掛薪資模組、讀表失敗）。
 * 解鎖後照常可動。全部虛構同仁；金鑰都是測試沙盒的假值。
 */
'use strict';
const H = require('./helpers/gs-sandbox');
const { make, T, check, done } = H;
const J = (x) => JSON.parse(JSON.stringify(x));

const MSG = '2026-10 薪資已鎖定，請先到薪資頁解鎖這個月';
const MSG_STAFF = '2026-10 薪資已鎖定，不能再送這個月的申請；有需要請找主管（主管要先到薪資頁解鎖這個月）';
const LOCKED = { ok: false, error: 'pay_locked', message: MSG };
const AP = (date, emp, name) => [date, emp, name, '10:00-18:00', 8, '正常', '值班主管', date + 'T20:00:00+08:00', '', ''];
const ROSTER = [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true', line_user_id: 'U1' },
                { emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true', line_user_id: 'U2' }];
const EVENTS = [['2026-10-20T10:00:00', 'E01', 'in'], ['2026-10-20T18:00:00', 'E01', 'out'],
                ['2026-10-21T10:00:00', 'E02', 'in'], ['2026-10-21T18:00:00', 'E02', 'out'],
                ['2026-09-20T10:00:00', 'E01', 'in'], ['2026-09-20T18:00:00', 'E01', 'out'],
                ['2026-11-02T10:00:00', 'E01', 'in'], ['2026-11-02T18:00:00', 'E01', 'out']];
// runs：[ym, store, status]…；payroll=false＝這個專案沒掛薪資模組（光復以外的店）
function world(runs, opt) {
  opt = opt || {};
  const m = make({ now: T('2026-11-03T10:00:00'), payroll: opt.payroll !== false, props: opt.props,
    self: { roster: ROSTER, events: opt.events || EVENTS, approved: opt.approved || [AP('2026-10-22', 'E01', '代號甲')], leave: opt.leave } });
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  const add = (o) => { const r = Object.assign({ created_at: '2026-10-19T09:00:00+08:00', status: 'pending', hours: 8, emp_id: 'E01', name: '代號甲', kind: 'leave', leave_type: '事假' }, o); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); };
  add({ id: 'L1', date: '2026-10-25' });                       // 鎖定月、待審
  add({ id: 'L2', date: '2026-10-26' });                       // 鎖定月、待審
  add({ id: 'L3', date: '2026-10-22', status: 'approved' });   // 鎖定月、已核准（作廢用）
  add({ id: 'N1', date: '2026-11-05' });                       // 沒鎖的月、待審
  add({ id: 'N2', date: '2026-11-06', status: 'approved' });   // 沒鎖的月、已核准
  add({ id: 'S1', date: '2026-09-25' });                       // 別家店鎖的月、待審
  m.add = add;
  // 開試算表的次數（正式環境每開一次都要時間）
  m.opens = 0; const open0 = m.sb.SpreadsheetApp.openById; m.sb.SpreadsheetApp.openById = function (id) { m.opens++; return open0(id); };
  m.opensOf = (body) => { const n0 = m.opens; const r = m.post(body); return { ok: r.ok, opens: m.opens - n0 }; };
  if (opt.payroll !== false) {
    const head = m.run('PAY_SHEETS.run'), rs = ss.insertSheet(m.run('PAY_SHEET_NAME.run'));
    rs.appendRow(head.slice());
    (runs || []).forEach((r) => { const o = { ym: r[0], store: r[1], status: r[2], emp_id: 'E01', name: '代號甲', net: 40000 }; rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k]))); });
    m.runSheet = rs;
  }
  m.post = (body) => { m.run('if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; }'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text); };
  m.reqStatus = (id) => m.sb.reqRows_(ss).filter((x) => String(x.id) === id)[0].status;
  m.reqCount = () => m.sb.reqRows_(ss).length;
  return m;
}
const RUNS = [['2026-10', 'SSLGF', 'final'], ['2026-11', 'SSLGF', 'draft'], ['2026-09', 'CF', 'final']];
const UNLOCKED = [['2026-10', 'SSLGF', 'draft'], ['2026-11', 'SSLGF', 'draft'], ['2026-09', 'CF', 'final']];
const APV = (date, emp, extra) => Object.assign({ action: 'mgr_approve', mgr_key: 'MK', date: date, emp_id: emp || 'E01', periods: [{ start: '10:00', end: '18:00' }], leaves: [] }, extra || {});
const pick = (r) => ({ ok: r.ok, error: r.error, message: r.message });

const plf = (m, d) => (typeof m.sb.payLockedFor_ === 'function' ? m.sb.payLockedFor_(d) : '（還沒有這支函式）');
console.log('══ 一、共用判斷 payLockedFor_：true／false／undefined ══');
{
  const m = world(RUNS);
  check('pl-01', '這家店鎖定的月份 → true', plf(m, '2026-10-20'), true);
  check('pl-02', '草稿的月份 → false', plf(m, '2026-11-02'), false);
  check('pl-03', '別家店（央廚）鎖的月份 → false', plf(m, '2026-09-20'), false);
  check('pl-04', '沒算過的月份 → false', plf(m, '2026-08-20'), false);
  check('pl-05', '日期不像日期 → undefined（不知道）', [plf(m, ''), plf(m, null), plf(m, 'abc')].map((x) => x === undefined), [true, true, true]);
  const n = world(RUNS, { payroll: false });
  check('pl-06', '沒掛薪資模組 → undefined（不擋）', plf(n, '2026-10-20') === undefined, true);
  m.run('PAY_READ_CACHE = {};'); m.runSheet.getDataRange = function () { throw new Error('讀不到'); };
  check('pl-07', '讀 payroll_run 丟錯 → undefined（不擋、不丟錯）', plf(m, '2026-10-20') === undefined, true);
}

console.log('\n══ 二、主管核定 mgr_approve（含只檢查） ══');
{
  const m = world(RUNS), ap0 = JSON.stringify(m.approved());
  check('pl-10', '鎖定月核定 → pay_locked', pick(m.post(APV('2026-10-20'))), LOCKED);
  check('pl-11', '鎖定月重新核定（那天已核定過）→ pay_locked', pick(m.post(APV('2026-10-22'))), LOCKED);
  check('pl-12', '鎖定月只檢查 dry_run → 同樣 pay_locked', pick(m.post(APV('2026-10-20', 'E01', { dry_run: true }))), LOCKED);
  check('pl-13', '核定紀錄沒被動', JSON.stringify(m.approved()), ap0);
  let reads = 0; const dr = m.runSheet.getDataRange; m.runSheet.getDataRange = function () { reads++; return dr.apply(this, arguments); };
  const c = m.post({ action: 'mgr_approve_check', mgr_key: 'MK', date: '2026-10-20', items: [{ emp_id: 'E01', periods: [{ start: '10:00', end: '18:00' }], leaves: [] }, { emp_id: 'E02', periods: [], leaves: [] }] });
  check('pl-14', 'mgr_approve_check 一批兩人：每人都回 pay_locked 與同一句訊息', (c.results || []).map((x) => [x.emp_id, x.ok, x.error, x.message]), [['E01', false, 'pay_locked', MSG], ['E02', false, 'pay_locked', MSG]]);
  check('pl-15', '一批只檢查同一個月只讀一次 payroll_run', reads, 1);
  m.runSheet.getDataRange = dr;
  check('pl-16', '反例：沒鎖的月份照常核定', m.post(APV('2026-11-02')).ok, true);
  check('pl-17', '反例：別家店鎖的月份（2026-09 央廚）不影響這家', m.post(APV('2026-09-20')).ok, true);
  check('pl-18', '反例：沒鎖的月份只檢查照常', m.post(APV('2026-11-02', 'E01', { dry_run: true })).ok, true);
  check('pl-19', '金鑰不對照舊 unauthorized（不洩漏鎖月狀態）', m.post(APV('2026-10-20', 'E01', { mgr_key: 'XX' })).error, 'unauthorized');
  const u = world(UNLOCKED);
  check('pl-20', '解鎖後：同一天照常核定', u.post(APV('2026-10-20')).ok, true);
  const n = world(RUNS, { payroll: false });
  check('pl-21', '沒掛薪資模組的店：照常核定（不擋）', n.post(APV('2026-10-20')).ok, true);
  const f = world(RUNS); f.runSheet.getDataRange = function () { throw new Error('讀不到'); };
  check('pl-22', '讀不到 payroll_run：照常核定（不擋、不丟錯）', J(f.sb.reqMgrApproveHome_(APV('2026-10-20'))).ok, true);
}

console.log('\n══ 三、主管核准／退回申請（單筆） ══');
{
  const m = world(RUNS);
  check('pl-30', '鎖定月的單核准 → pay_locked', pick(m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'L1', decision: 'approve' })), LOCKED);
  check('pl-31', '鎖定月的單退回 → pay_locked', pick(m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'L1', decision: 'reject', reason: '測試' })), LOCKED);
  check('pl-32', '那張單還是待審', m.reqStatus('L1'), 'pending');
  check('pl-33', '反例：沒鎖的月份的單照常核准', [m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'N1', decision: 'approve' }).ok, m.reqStatus('N1')], [true, 'approved']);
  check('pl-34', '反例：別家店鎖的月份的單照常退回', [m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'S1', decision: 'reject', reason: '測試' }).ok, m.reqStatus('S1')], [true, 'rejected']);
  check('pl-35', '金鑰不對照舊 unauthorized', m.post({ action: 'mgr_req_decide', mgr_key: 'XX', id: 'L1', decision: 'approve' }).error, 'unauthorized');
  const u = world(UNLOCKED);
  check('pl-36', '解鎖後：同一張單照常核准', [u.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'L1', decision: 'approve' }).ok, u.reqStatus('L1')], [true, 'approved']);
  const n = world(RUNS, { payroll: false });
  check('pl-37', '沒掛薪資模組的店：照常核准', n.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'L1', decision: 'approve' }).ok, true);
}

console.log('\n══ 四、批次核准：鎖定月的那幾筆失敗、其他照做 ══');
{
  const m = world(RUNS);
  const r = m.post({ action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['L1', 'N1', 'L2', 'S1'], decision: 'approve' });
  check('pl-40', '沒鎖的照常核准', [r.ok, r.done], [true, ['N1', 'S1']]);
  check('pl-41', '鎖定月的列在 skipped，帶 pay_locked 與訊息', r.skipped, [{ id: 'L1', reason: MSG, error: 'pay_locked' }, { id: 'L2', reason: MSG, error: 'pay_locked' }]);
  check('pl-42', '試算表上：鎖定月的還是待審、其他已核准', ['L1', 'L2', 'N1', 'S1'].map(m.reqStatus), ['pending', 'pending', 'approved', 'approved']);
  const u = world(UNLOCKED);
  const r2 = u.post({ action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['L1', 'N1', 'L2'], decision: 'approve' });
  check('pl-43', '解鎖後：整批照常核准', [r2.done, r2.skipped], [['L1', 'N1', 'L2'], []]);
}

console.log('\n══ 五、作廢 mgr_req_void ══');
{
  const m = world(RUNS), ap0 = JSON.stringify(m.approved());
  check('pl-50', '鎖定月的已核准單作廢 → pay_locked', pick(m.post({ action: 'mgr_req_void', mgr_key: 'MK', id: 'L3', reason: '測試' })), LOCKED);
  check('pl-51', '那張單還是已核准、那天的核定沒被打回', [m.reqStatus('L3'), JSON.stringify(m.approved()) === ap0], ['approved', true]);
  check('pl-52', '反例：沒鎖的月份照常作廢', [m.post({ action: 'mgr_req_void', mgr_key: 'MK', id: 'N2', reason: '測試' }).ok, m.reqStatus('N2')], [true, 'voided']);
  const u = world(UNLOCKED);
  check('pl-53', '解鎖後：同一張單照常作廢', [u.post({ action: 'mgr_req_void', mgr_key: 'MK', id: 'L3', reason: '測試' }).ok, u.reqStatus('L3')], [true, 'voided']);
}

console.log('\n══ 六、主管代開 mgr_req_proxy ══');
{
  const PX = (date) => ({ action: 'mgr_req_proxy', mgr_key: 'AK', acting_name: '代號店長', emp_id: 'E02', kind: 'leave', leave_type: '事假', date: date, hours: 8, reason: '測試代開' });
  const m = world(RUNS), n0 = m.reqCount();
  check('pl-60', '鎖定月代開 → pay_locked', pick(m.post(PX('2026-10-21'))), LOCKED);
  check('pl-61', '申請表沒多一筆', m.reqCount(), n0);
  check('pl-62', '不是營運系統代管的鑰匙照舊 acting_only（不洩漏鎖月狀態）', m.post(Object.assign(PX('2026-10-21'), { mgr_key: 'MK' })).error, 'acting_only');
  const u = world(UNLOCKED);
  const r = u.post(PX('2026-10-21'));
  check('pl-63', '解鎖後：同一筆照常代開', [r.ok, u.reqCount()], [true, n0 + 1]);
  const s = world(RUNS);
  check('pl-64', '反例：別家店鎖的月份（2026-09）照常代開', s.post(PX('2026-09-21')).ok, true);
}

console.log('\n══ 七、同仁自己送申請 req_submit；撤回不擋 ══');
{
  const SB = (date) => ({ action: 'req_submit', id_token: 'TOK_U2', kind: 'leave', leave_type: '事假', date: date, hours: 8, reason: '測試' });
  const m = world(RUNS), n0 = m.reqCount();
  check('pl-70', '鎖定月送申請 → pay_locked（給同仁看的說法）', pick(m.post(SB('2026-10-31'))), { ok: false, error: 'pay_locked', message: MSG_STAFF });
  check('pl-71', '申請表沒多一筆', m.reqCount(), n0);
  check('pl-72', '反例：沒鎖的月份照常送', [m.post(SB('2026-11-04')).ok, m.reqCount()], [true, n0 + 1]);
  check('pl-73', 'LINE 身分不對照舊 invalid_id_token', m.post(Object.assign(SB('2026-10-31'), { id_token: 'BAD' })).error, 'invalid_id_token');
  check('pl-74', '同仁撤回鎖定月的待審單：不擋', [m.post({ action: 'req_cancel', id_token: 'TOK_U1', id: 'L1' }).ok, m.reqStatus('L1')], [true, 'cancelled']);
  const u = world(UNLOCKED);
  check('pl-75', '解鎖後：同一天照常送', u.post(SB('2026-10-31')).ok, true);
  const n = world(RUNS, { payroll: false });
  check('pl-76', '沒掛薪資模組的店：照常送（不擋）', n.post(SB('2026-10-31')).ok, true);
}

console.log('\n══ 八、管理金鑰的打回工具 bind_revoke／ft8_revoke：鎖定月的不搬 ══');
{
  const BP = { REQ_BIND_FROM: '2026-10-01', REQ_STRICT_FROM: '2026-11-08' };
  const BEV = [['2026-10-22T10:00:00', 'E01', 'in'], ['2026-11-02T10:00:00', 'E01', 'in']];   // 兩天都只有上班卡＝缺忘打卡單
  const BAP = [AP('2026-10-22', 'E01', '代號甲'), AP('2026-11-02', 'E01', '代號甲')];
  const BR = (apply) => ({ action: 'bind_revoke', admin_key: 'ADM', from: '2026-10-01', to: '2026-11-07', apply: apply });
  const m = world(RUNS, { props: BP, events: BEV, approved: BAP });
  const pv = m.post(BR(false));
  check('pl-80', 'bind_revoke 試算：兩天都列出，鎖定月那天標 pay_locked', (pv.items || []).map((x) => [x.date, x.pay_locked === true]), [['2026-10-22', true], ['2026-11-02', false]]);
  const r = m.post(BR(true));
  check('pl-81', 'bind_revoke apply：只搬沒鎖的那天，鎖定月那天列在 pay_locked 並帶訊息', [r.ok, r.moved, (r.items || []).map((x) => x.date), (r.pay_locked || []).map((x) => [x.date, x.emp_id]), r.message],
    [true, 1, ['2026-11-02'], [['2026-10-22', 'E01']], MSG]);
  check('pl-82', '鎖定月那天的核定列還在', m.approved().map((x) => x[0]), ['2026-10-22']);
  const u = world(UNLOCKED, { props: BP, events: BEV, approved: BAP });
  const ru = u.post(BR(true));
  check('pl-83', '解鎖後：兩天都搬', [ru.moved, u.approved().length, ru.pay_locked === undefined], [2, 0, true]);
  const n = world(RUNS, { payroll: false, props: BP, events: BEV, approved: BAP });
  check('pl-84', '沒掛薪資模組的店：照常兩天都搬', n.post(BR(true)).moved, 2);

  const FAP = [['2026-10-23', 'E01', '代號甲', '10:00-14:00', 4, '正常', '值班主管', '2026-10-23T20:00:00+08:00', '', '']];
  const FEV = [['2026-10-23T10:00:00', 'E01', 'in'], ['2026-10-23T14:00:00', 'E01', 'out']];
  const FR = { action: 'ft8_revoke', admin_key: 'ADM', items: [{ emp_id: 'E01', date: '2026-10-23' }], apply: true };
  const f = world(RUNS, { props: { REQ_FT8_FROM: '2026-10-01' }, events: FEV, approved: FAP });
  const rf = f.post(FR);
  check('pl-85', 'ft8_revoke apply：鎖定月的不搬', [rf.ok, rf.moved, (rf.pay_locked || []).map((x) => x.date), f.approved().length], [true, 0, ['2026-10-23'], 1]);
  const fu = world(UNLOCKED, { props: { REQ_FT8_FROM: '2026-10-01' }, events: FEV, approved: FAP });
  check('pl-86', '解鎖後：ft8_revoke 照常搬', [fu.post(FR).moved, fu.approved().length], [1, 0]);
}

console.log('\n══ 九、舊資料清理 final_orphan_scan apply：鎖定月的略過 ══');
{
  const mk = (runs) => { const m = world(runs, { leave: [['日期', '姓名', '假別', '時數'], ['2026-10-22', '代號甲', '事假', 8]].slice(1) });
    m.add({ id: 'V1', date: '2026-10-22', status: 'voided', voided_at: '2026-10-25T10:00:00+08:00', voided_by: '值班主管' }); return m; };
  const FO = (extra) => Object.assign({ action: 'final_orphan_scan', admin_key: 'ADM', from: '2026-10-01', to: '2026-10-31' }, extra || {});
  const m = mk(RUNS), ap0 = JSON.stringify(m.approved());
  const keys = (m.post(FO()).items || []).map((x) => x.key);
  check('pl-90', '試算列得出那一天（前提）', keys, ['2026-10-22|E01']);
  const r = m.post(FO({ apply: true, keys: keys }));
  check('pl-91', 'apply：鎖定月的列在 skipped，帶 pay_locked 與訊息；核定沒被打回', [r.ok, r.done, r.skipped, JSON.stringify(m.approved()) === ap0],
    [true, [], [{ key: '2026-10-22|E01', reason: MSG, error: 'pay_locked' }], true]);
  const u = mk(UNLOCKED);
  const ru = u.post(FO({ apply: true, keys: keys }));
  check('pl-92', '解鎖後：照常清', [(ru.done || []).length, (ru.skipped || []).length, u.approved().length], [1, 0, 0]);
}

console.log('\n══ 十、系統重算 recheck_approvals（每天 05:00 也跑這支）／backfill_missing_groups：鎖定月的不改 ══');
{
  const REV = [['2026-10-22T10:00:00', 'E01', 'in'], ['2026-10-22T18:00:00', 'E01', 'out'], ['2026-11-02T10:00:00', 'E01', 'in'], ['2026-11-02T18:00:00', 'E01', 'out']];
  const RAP = [AP('2026-10-22', 'E01', '代號甲'), AP('2026-11-02', 'E01', '代號甲')].map((x) => { x[5] = '該段無打卡'; return x; });
  const st = (m) => m.approved().map((x) => [x[0], x[5]]);
  const m = world(RUNS, { events: REV, approved: RAP });
  const r = m.post({ action: 'recheck_approvals', admin_key: 'ADM' });
  check('pl-100', 'recheck：鎖定月那天不改，沒鎖的那天照常改；回報略過幾天', [r.ok, r.fixed, r.pay_locked, st(m)],
    [true, 1, 1, [['2026-10-22', '該段無打卡'], ['2026-11-02', '該段無打卡'], ['2026-11-02', '正常']]]);
  const u = world(UNLOCKED, { events: REV, approved: RAP });
  const ru = u.post({ action: 'recheck_approvals', admin_key: 'ADM' });
  check('pl-101', '解鎖後：兩天都改，回應沒有 pay_locked', [ru.fixed, ru.pay_locked === undefined, st(u).length], [2, true, 4]);
  const n = world(RUNS, { payroll: false, events: REV, approved: RAP });
  check('pl-102', '沒掛薪資模組的店：照常兩天都改', n.post({ action: 'recheck_approvals', admin_key: 'ADM' }).fixed, 2);
  const f = world(RUNS, { events: REV, approved: RAP }); f.runSheet.getDataRange = function () { throw new Error('讀不到'); };
  check('pl-103', '讀不到 payroll_run：照常重算（不擋、不丟錯）', f.post({ action: 'recheck_approvals', admin_key: 'ADM' }).fixed, 2);

  const GEV = [['2026-10-22T11:02:00', 'E01', 'in'], ['2026-10-22T21:44:00', 'E01', 'out']];
  const GAP = [['2026-10-22', 'E01', '代號甲', '11:00-14:30,17:00-21:45', 8.25, '遲到2分、早退1分', '值班主管', '2026-10-22T22:00:00+08:00', '', '']];
  const BF = { action: 'backfill_missing_groups', admin_key: 'ADM', from: '2026-10-01', to: '2026-10-31', apply: true };
  const g = world(RUNS, { events: GEV, approved: GAP });
  const rg = g.post(BF);
  check('pl-104', 'backfill apply：鎖定月的不寫，列在 skipped', [rg.ok, rg.fixed, (rg.skipped || []).map((x) => [x.date, x.error, x.reason]), g.approved().length],
    [true, 0, [['2026-10-22', 'pay_locked', MSG]], 1]);
  const gu = world(UNLOCKED, { events: GEV, approved: GAP });
  check('pl-105', '解鎖後：backfill 照常補', [gu.post(BF).fixed, gu.approved().length], [1, 2]);
}

console.log('\n══ 十一、不多開試算表：掛了薪資模組的店，每個動作開檔次數跟沒掛的店一樣 ══');
{
  const PX = { action: 'mgr_req_proxy', mgr_key: 'AK', acting_name: '代號店長', emp_id: 'E02', kind: 'leave', leave_type: '事假', date: '2026-09-21', hours: 8, reason: '測試代開' };
  const ACTS = [['mgr_approve', APV('2026-11-02')],
    ['mgr_req_decide', { action: 'mgr_req_decide', mgr_key: 'MK', id: 'N1', decision: 'approve' }],
    ['mgr_req_decide_batch（4 筆）', { action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['L1', 'N1', 'L2', 'S1'], decision: 'approve' }],
    ['mgr_req_void', { action: 'mgr_req_void', mgr_key: 'MK', id: 'N2', reason: '測試' }],
    ['mgr_req_proxy', PX],
    ['req_submit', { action: 'req_submit', id_token: 'TOK_U2', kind: 'leave', leave_type: '事假', date: '2026-11-05', hours: 8, reason: '測試' }]];
  ACTS.forEach((a, i) => {
    const p = world(UNLOCKED).opensOf(a[1]), n = world(UNLOCKED, { payroll: false }).opensOf(a[1]);
    check('pl-11' + i, a[0] + '：有做事，開檔次數跟沒掛薪資模組一樣', [p.ok, p.opens], [true, n.opens]);
  });
  const m = world(RUNS); let reads = 0; const dr = m.runSheet.getDataRange; m.runSheet.getDataRange = function () { reads++; return dr.apply(this, arguments); };
  m.opensOf({ action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['L1', 'N1', 'L2', 'S1'], decision: 'approve' });
  check('pl-116', '批次 4 筆：payroll_run 只讀一次', reads, 1);
  const e = make({ now: T('2026-11-03T10:00:00'), payroll: true, self: { roster: ROSTER, events: EVENTS, approved: [] } });
  e.sb.payLockedFor_('2026-10-20');
  check('pl-117', '還沒有 payroll_run 分頁：回 false，而且不順手建分頁', [e.sb.payLockedFor_('2026-10-20'), e.sb.getSS().getSheetByName(e.run('PAY_SHEET_NAME.run')) === null], [false, true]);
}
console.log('\n══ 十二、payroll_leave_options lock_only：只回鎖月狀態（營運系統每次核定前問的輕量讀法） ══');
{
  const m = world(RUNS);
  const q = (ym, store) => m.post({ action: 'payroll_leave_options', mgr_key: 'MK', store: store || 'SSLGF', ym: ym, lock_only: true });
  const a = q('2026-10'), b = q('2026-11'), c = q('2026-09');
  check('pl-120', '鎖定月 → locked:true，不帶假別與額度', [a.ok, a.locked, a.lock_only, a.types === undefined, a.quotas === undefined], [true, true, true, true, true]);
  check('pl-121', '草稿月 → locked:false', [b.ok, b.locked], [true, false]);
  check('pl-122', '別家店鎖的月份（這家沒鎖）→ locked:false', [c.ok, c.locked], [true, false]);
  const full = m.post({ action: 'payroll_leave_options', mgr_key: 'MK', store: 'SSLGF', ym: '2026-10' });
  check('pl-123', '不帶 lock_only：照舊回整套（有 types、locked）', [full.ok, Array.isArray(full.types), full.locked], [true, true, true]);
  const bad = m.post({ action: 'payroll_leave_options', mgr_key: 'WRONG', store: 'SSLGF', ym: '2026-10', lock_only: true });
  check('pl-124', '金鑰不對：照舊 unauthorized，不洩漏鎖月', [bad.ok, bad.locked], [false, undefined]);
}

done();
