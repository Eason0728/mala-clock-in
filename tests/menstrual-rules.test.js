/* 生理假新規則（2026-11-18 Eason；scratchpad menstrual/decisions.md）
 *  一天算一次（不管幾張、幾段、幾小時）、一天最多 8 小時、一年 3 次（第 4 次擋，請改辦理病假）、每月一次、計時人員不適用。
 *  已核准但那天核定成別的假＝不佔次數；審核中的單落在已記生理假的日子＝不重複算；主管代開也檢查；緊急開關 REQ_MENS_RULES=off 退回原做法。
 *  用真函式跑（Requests.gs＋Code.gs；薪資段落另載 Payroll.gs）。名字一律假名。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { make, T, check, done, ROOT } = require('./helpers/gs-sandbox');

const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const NOLINE = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: '', active: 'TRUE', line_user_id: '' };
const NOW = '2026-11-18T10:00:00';
const PHRASE = '已超過年度三次上限，請改辦理病假';
/** o：now、quota（額度表 dates）、ft、leave、approved、props、opts（代開的 payroll_leave_options 回應） */
function world(o) {
  o = o || {};
  const m = make({ now: T(o.now || NOW), props: o.props || {},
    self: { roster: [ME, NOLINE], events: [], leave: (o.leave || []).map((l) => [l[0], l[1] || '測試一', l[2], l[3]]), approved: o.approved || [] },
    fetch: (url, opt) => {
      let b = null; try { b = JSON.parse(opt.payload); } catch (e) { return undefined; }
      if (b && b.action === 'payroll_leave_options') return o.opts === undefined ? { ok: false } : o.opts;
      return undefined;
    } });
  const q = o.quota === undefined ? [] : o.quota;
  m.sb.lineHubReqQuota_ = () => ({ quota: q, ft: o.ft === undefined ? null : o.ft });
  return m;
}
const MQ = (dates) => [{ name: '生理假', cap_days: 3, cap_h: 24, remain_h: 24 - dates.length * 8, used_h: dates.length * 8, used_n: dates.length, dates: dates }];
const res = (r) => (r.ok ? 'ok' : r.error + '｜' + r.message);
const send = (m, date, x) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', kind: 'leave', leave_type: '生理假', date: date, reason: '測試' }, x || { hours: 8 })); };
const sp = (a, b) => ({ start: a, end: b });

console.log('════ 一、同一天算一次 ════');
{
  const m = world({ quota: MQ(['2026-07-02', '2026-08-05']) });
  const a = res(send(m, '2026-11-20', sp('17:00', '19:00'))), b = res(send(m, '2026-11-20', sp('19:00', '21:00')));
  const c = res(send(m, '2026-12-03'));
  check('M01', '之前 2 次；11/20 送兩張（17–19、19–21）都收（同一天算一次＝第 3 次）；12/3 再送＝第 4 次擋', [a, b, c.split('｜')[0], c.indexOf(PHRASE) >= 0], ['ok', 'ok', 'quota_exhausted', true]);
  check('M01-msg', '第 4 次的訊息原文', c, 'quota_exhausted｜生理假今年已請 3 次（7/2、8/5、11/20 審核中），這次是第 4 次，' + PHRASE);
}

console.log('\n════ 二、一天最多 8 小時 ════');
{
  const m = world();
  const a = res(send(m, '2026-11-20', sp('09:00', '13:00')));
  const b = res(send(m, '2026-11-20', sp('14:00', '18:15')));
  const c = res(send(m, '2026-11-20', sp('14:00', '18:00')));
  check('M02', '11/20 已送 4 小時；再送 4.25 小時（合計 8.25）擋、送 4 小時（合計 8）收', [a, b, c], ['ok', 'menstrual_over_8｜生理假一天最多 8 小時，11/20 已請 4 小時，這次最多 4 小時', 'ok']);
  const m2 = world();
  check('M02-b', '單張 8.25 小時擋、8 小時收', [res(send(m2, '2026-11-20', { hours: 8.25 })), res(send(m2, '2026-11-20', { hours: 8 }))],
    ['menstrual_over_8｜生理假一天最多 8 小時，這次 8.25 小時超過了', 'ok']);
  const m3 = world({ quota: MQ(['2026-11-17']), leave: [['2026-11-17', '測試一', '生理假', 6]] });
  check('M02-c', '那天已登記 6 小時，再送 3 小時擋（訊息講還能請幾小時）', res(send(m3, '2026-11-17', sp('18:00', '21:00'))), 'menstrual_over_8｜生理假一天最多 8 小時，11/17 已請 6 小時，這次最多 2 小時');
}

console.log('\n════ 三、一年 3 次：第 3 次收、第 4 次擋 ════');
{
  const m = world({ quota: MQ(['2026-07-02', '2026-08-05']) });
  check('M03', '之前 2 次 → 11/20 第 3 次收', res(send(m, '2026-11-20')), 'ok');
  const m2 = world({ quota: MQ(['2026-07-02', '2026-08-05', '2026-09-03']) });
  check('M03-b', '之前 3 次 → 第 4 次擋，訊息含「已超過年度三次上限，請改辦理病假」', res(send(m2, '2026-11-20')), 'quota_exhausted｜生理假今年已請 3 次（7/2、8/5、9/3），這次是第 4 次，' + PHRASE);
  const m3 = world({ quota: MQ(['2026-06#1', '2026-08-05', '2026-09-03']) });
  check('M03-c', '手動工時月份（6 月沒有日期）也算 1 次', res(send(m3, '2026-11-20')).split('｜')[1], '生理假今年已請 3 次（6 月、8/5、9/3），這次是第 4 次，' + PHRASE);
}

console.log('\n════ 四、每月一次 ════');
{
  const m = world();
  const a = res(send(m, '2026-11-20')), b = res(send(m, '2026-11-25'));
  check('M04', '11/20 送過（審核中），同月 11/25 再送擋，訊息白話', [a, b], ['ok', 'menstrual_month｜生理假每月一次，這個月已請過（11/20 審核中）']);
  const m2 = world({ quota: MQ(['2026-11-03']), leave: [['2026-11-03', '測試一', '生理假', 4]] });
  check('M04-b', '這個月已登記 11/3 → 11/20 擋', res(send(m2, '2026-11-20')), 'menstrual_month｜生理假每月一次，這個月已請過（11/3）');
  const m3 = world({ quota: MQ(['2026-12#1']) });
  check('M04-c', '手動工時 12 月已記 → 12/3 擋，講月份', res(send(m3, '2026-12-03')), 'menstrual_month｜生理假每月一次，這個月已請過（12 月）');
  check('M04-d', '反例：11/20 有了，12/3 不同月照收', res(send(m, '2026-12-03')), 'ok');
}

console.log('\n════ 五、跨年重新計次 ════');
{
  const m = world({ now: '2026-12-20T10:00:00', quota: MQ(['2026-07-02', '2026-08-05', '2026-09-03']) });
  check('M05', '今年 3 次用完：12/28 擋、明年 1/5 收', [res(send(m, '2026-12-28')).split('｜')[0], res(send(m, '2027-01-05'))], ['quota_exhausted', 'ok']);
  res(send(m, '2027-02-05')); res(send(m, '2027-03-05'));
  check('M05-b', '明年已送 3 張（1/5、2/5、3/5）→ 明年第 4 次（3/10）擋，訊息寫 2027 年', res(send(m, '2027-03-10')), 'quota_exhausted｜生理假 2027 年已請 3 次（1/5 審核中、2/5 審核中、3/5 審核中），這次是第 4 次，' + PHRASE);
}

console.log('\n════ 六、取消／退回／作廢後重算 ════');
{
  const m = world({ quota: MQ(['2026-07-02', '2026-08-05']) });
  const r = send(m, '2026-11-20');
  const before = res(send(m, '2026-12-03')).split('｜')[0];
  m.sb.handleReqCancel_({ id_token: 'TOK_U1', id: r.request.id });
  check('M06-a', '11/20 審核中時 12/3 擋；本人取消 11/20 後 12/3 收', [before, res(send(m, '2026-12-03'))], ['quota_exhausted', 'ok']);
  const m2 = world({ quota: MQ(['2026-07-02', '2026-08-05']) });
  const r2 = send(m2, '2026-11-20');
  const dec = m2.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r2.request.id, decision: 'reject', reason: '日期錯了' });
  check('M06-b', '主管退回 11/20 後 12/3 收', [dec.ok, res(send(m2, '2026-12-03'))], [true, 'ok']);
  const base = { emp_id: 'E01', kind: 'leave', leave_type: '生理假', hours: 8 };
  const ex = [Object.assign({ date: '2026-11-20', status: 'voided' }, base), Object.assign({ date: '2026-10-05', status: 'cancelled' }, base), Object.assign({ date: '2026-09-05', status: 'rejected' }, base)];
  check('M06-c', '作廢、取消、退回的單都不算（直接跑判斷）', m.sb.reqMensBlock_(Object.assign({ date: '2026-12-10' }, base), ex, 'E01', { quota: MQ(['2026-07-02', '2026-08-05']) }, { today: '2026-11-18' }), null);
}

console.log('\n════ 七、已核准但那天核定成別的假：不佔次數 ════');
{
  const CORE = ['2026-11-17', 'E01', '測試一', '[]', 8, '全天請假', '值班主管', '2026-11-17T22:00:00+08:00', '', ''];
  const mk = (cored) => {
    const m = world({ quota: MQ(['2026-07-02', '2026-08-05']), approved: cored ? [CORE] : [], leave: cored ? [['2026-11-17', '測試一', '事假', 8]] : [] });
    const r = send(m, '2026-11-17');
    if (!r.ok) throw new Error('準備資料失敗：' + JSON.stringify(r));
    const d = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' });
    if (!d.ok) throw new Error('核准失敗：' + JSON.stringify(d));
    return m;
  };
  check('M07', '11/17 生理假已核准、那天核定成事假 → 不算；12/3 是第 3 次收', res(send(mk(true), '2026-12-03')), 'ok');
  check('M07-b', '對照：11/17 已核准、那天還沒核定 → 算；12/3 是第 4 次擋', res(send(mk(false), '2026-12-03')).split('｜')[0], 'quota_exhausted');
}

console.log('\n════ 八、審核中的單落在已記生理假的日子：不重複算 ════');
{
  const m = world({ quota: MQ(['2026-07-02', '2026-11-17']), leave: [['2026-11-17', '測試一', '生理假', 4]] });
  const a = res(send(m, '2026-11-17', sp('18:00', '20:00')));
  check('M08', '11/17 已登記 4 小時，再送 2 小時（同一天）收；12/3 是第 3 次收（11/17 只算一次）', [a, res(send(m, '2026-12-03'))], ['ok', 'ok']);
}

console.log('\n════ 九、主管代開也檢查 ════');
{
  const px = (m, date, h) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return res(m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E02', kind: 'leave', leave_type: '生理假', date: date, hours: h || 8, reason: '沒綁 LINE' })); };
  const OPT = (dates, ft) => ({ ok: true, quotas: { E02: { menstrual: { cap_days: 3, cap_h: 24, remain_h: 24 - dates.length * 8, used_h: dates.length * 8, used_n: dates.length, dates: dates, ft: ft } } } });
  check('M09-a', '代開：之前 3 次 → 第 4 次擋', px(world({ opts: OPT(['2026-07-02', '2026-08-05', '2026-09-03'], true) }), '2026-11-18'),
    'quota_exhausted｜生理假今年已請 3 次（7/2、8/5、9/3），這次是第 4 次，' + PHRASE);
  check('M09-b', '代開：這個月已有 11/3 → 擋', px(world({ opts: OPT(['2026-11-03'], true) }), '2026-11-18'), 'menstrual_month｜生理假每月一次，這個月已請過（11/3）');
  check('M09-c', '代開：9 小時擋', px(world({ opts: OPT([], true) }), '2026-11-18', 9), 'menstrual_over_8｜生理假一天最多 8 小時，這次 9 小時超過了');
  check('M09-d', '代開：計時人員擋', px(world({ opts: OPT([], false) }), '2026-11-18'), 'menstrual_pt｜計時人員不適用生理假，請改請病假或事假');
  check('M09-e', '代開：查不到額度（沒有薪資主檔的店）→ 用本店登記與申請單照算；第 1 次收', px(world({ opts: { ok: true, quotas: {} } }), '2026-11-18'), 'ok');
  check('M09-f', '代開：本店登記 11/3 → 同月擋（沒有薪資主檔的店也擋得到）', px(world({ opts: { ok: true, quotas: {} }, leave: [['2026-11-03', '測試二', '生理假', 8]] }), '2026-11-18'), 'menstrual_month｜生理假每月一次，這個月已請過（11/3）');
}

console.log('\n════ 十、計時人員 ════');
check('M10-a', '薪資主檔是計時（ft:false）→ 擋', res(send(world({ ft: false }), '2026-11-20')), 'menstrual_pt｜計時人員不適用生理假，請改請病假或事假');
check('M10-b', '正職（ft:true）→ 收', res(send(world({ ft: true }), '2026-11-20')), 'ok');
check('M10-c', '查不到（ft:null，沒有薪資主檔）→ 不擋', res(send(world({ ft: null }), '2026-11-20')), 'ok');

console.log('\n════ 十一、一次填兩段：同一天算一次 ════');
{
  const m = world({ props: { REQ_SEG2_KINDS: 'leave' }, quota: MQ(['2026-07-02', '2026-08-05']) });
  const a = send(m, '2026-11-20', { segments: [sp('09:00', '10:00'), sp('15:00', '16:00')] });
  check('M11', '之前 2 次；11/20 兩段收（2 張）；12/3 是第 4 次擋', [res(a), (a.requests || []).length, res(send(m, '2026-12-03')).split('｜')[0]], ['ok', 2, 'quota_exhausted']);
  const m2 = world({ props: { REQ_SEG2_KINDS: 'leave' } });
  res(send(m2, '2026-11-20', sp('17:00', '23:00')));
  check('M11-b', '那天已送 6 小時，再送兩段 1＋2＝3 小時 → 合計 9 擋', res(send(m2, '2026-11-20', { segments: [sp('09:00', '10:00'), sp('14:00', '16:00')] })), 'menstrual_over_8｜生理假一天最多 8 小時，11/20 已請 6 小時，這次最多 2 小時');
  check('M11-c', 'req_info：seg2_no_types 不再有生理假', m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_no_types, []);
}

console.log('\n════ 十二、緊急開關 REQ_MENS_RULES=off：回到現行 ════');
{
  const OFF = { REQ_MENS_RULES: 'off', REQ_SEG2_KINDS: 'leave' };
  const PER = (remain) => [{ name: '生理假', cap_h: 24, remain_h: remain }];
  const m = world({ props: OFF, quota: PER(8) });
  const a = res(send(m, '2026-11-20')), b = res(send(m, '2026-11-25'));
  check('M12-a', 'off：剩 1 次、11/20 收；11/25 照舊一張算一次 → 「3 次已經用完」（不是每月一次）', [a, b], ['ok', 'quota_exhausted｜生理假今年 3 次已經用完（含審核中），不能再申請']);
  check('M12-b', 'off：同一天合計超過 8 小時不擋（照舊）', res(send(world({ props: OFF }), '2026-11-20', { hours: 9 })), 'ok');
  check('M12-c', 'off：計時不擋（照舊）', res(send(world({ props: OFF, ft: false }), '2026-11-20')), 'ok');
  check('M12-d', 'off：兩段照舊不開放', res(send(world({ props: OFF }), '2026-11-20', { segments: [sp('09:00', '10:00'), sp('15:00', '16:00')] })), 'seg2_type｜生理假一天只算一次，不能分兩段，請填成一段');
  check('M12-e', 'off：req_info 的 seg2_no_types 回 [生理假]', m.sb.handleReqInfo_({ id_token: 'TOK_U1' }).seg2_no_types, ['生理假']);
}

console.log('\n════ 十三、核定：生理假一天超過 8 小時擋 ════');
{
  const ap = (m, h) => { const r = m.sb.handleMgrApprove({ mgr_key: 'MK', emp_id: 'E01', date: '2026-11-02', periods: [], leaves: [{ type: '生理假', hours: h }] }); return r.ok ? 'ok' : r.error; };
  // 8 小時過了這一關，接著是原本就有的「請假要有已核准的假單」（need_request）——證明 8 小時那條沒擋到它
  check('M13', '核定生理假 9 小時擋（menstrual_over_8）、8 小時過這關（往下走到原本的假單檢查 need_request）', [ap(world(), 9), ap(world(), 8)], ['menstrual_over_8', 'need_request']);
  check('M13-off', 'off：9 小時不擋這關（照舊往下走到 need_request）', ap(world({ props: { REQ_MENS_RULES: 'off' } }), 9), 'need_request');
}

console.log('\n════ 十四、薪資：額度表與「本月之前」一天算一次（PAY_MENSTRUAL_DAY_FROM 起） ════');
{
  const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
  const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const CL = {}, PY = {};
  const sb = { console, SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
    Utilities: { formatDate: (d) => { const p = (n) => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
    Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
  vm.runInContext('payClockRead=function(s,sh){return ((globalThis.__CL[s]||{})[sh]||[]);};payRead=function(k){return (globalThis.__PY[k]||[]);};payEmpStoresMap=function(){return {E01:["SSLGF","CF"]};};', sb);
  sb.__CL = CL; sb.__PY = PY;
  const call = (fn, ...a) => JSON.parse(JSON.stringify(vm.runInContext(fn, sb)(...a)));
  const cfg = { daily_hours: 8 };
  const T2 = call('payLeaveTypes', '');
  const rows = [{ emp_id: 'E01', code: 'menstrual', date: '2026-09-03', hours: 12 }, { emp_id: 'E01', code: 'menstrual', date: '2026-09-03', hours: 4 },
    { emp_id: 'E01', code: 'menstrual', date: '2026-10-01', hours: 0 }, { emp_id: 'E01', code: 'menstrual', date: '2026-06-01', hours: 8, manual: true }];
  const qn = call('payLeaveUsage', 'E01', '2026-11', T2, cfg, null, rows, []).menstrual;
  check('M14-a', '2026-11 額度表：12H 列＋同日 4H 列＝1 次、時數空白＝1 次、手動 6 月 8H＝1 次 → 3 次，日期照排', [qn.used_n, qn.used_days, qn.dates, qn.blocked], [3, 3, ['2026-06#1', '2026-09-03', '2026-10-01'], true]);
  const qo = call('payLeaveUsage', 'E01', '2026-10', T2, cfg, null, rows, []).menstrual;
  check('M14-b', '2026-10（生效月之前）照舊每列 ceil(時數/8)：2＋1＋0＋1＝4，沒有 used_n／dates', [qo.used_days, qo.used_n, qo.dates], [4, undefined, undefined]);
  const E = { emp_id: 'E01', name: '測試一', store: 'SSLGF', is_full_time: 'true' };
  CL.SSLGF = { leave: [{ '日期': '2026-09-03', '姓名': '測試一', '假別': '生理假', '時數': 12 }, { '日期': '2026-10-01', '姓名': '測試一', '假別': '生理假', '時數': '' }] };
  CL.CF = { leave: [{ '日期': '2026-09-03', '姓名': '測試一', '假別': '生理假', '時數': 4 }] };
  PY.input = [];
  const ubN = call('payLeaveUsedBefore', '2026-12', 'SSLGF', T2, cfg, [E]).E01.menstrual.used_before_days;
  const ubO = call('payLeaveUsedBefore', '2026-10', 'SSLGF', T2, cfg, [E]).E01.menstrual.used_before_days;
  check('M14-c', '本月之前（計薪）：12 月算 9/3（兩家店都記）1 次＋10/1 空白 1 次＝2；10 月照舊 ceil(12/8)＋ceil(4/8)＝3', [ubN, ubO], [2, 3]);
  PY.master = [E];
  PY.input = [{ ym: '2026-06', emp_id: 'E01', store: 'SSLGF', menstrual_h: 8 }];
  const my = call('payMyLeaveQuota', 'E01', '測試一', '2026-11', 'SSLGF').filter((x) => x.code === 'menstrual')[0];
  check('M14-d', '同仁額度 payMyLeaveQuota 帶 used_n、dates（本店 leave＋手動工時）', [my.used_n, my.dates], [3, ['2026-06#1', '2026-09-03', '2026-10-01']]);
  // 驗收缺口 a：is_full_time 空白不當計時；同工號多筆主檔（雙店）要取對，取不準＝判斷不出來
  const ME1 = { emp_id: 'E01', name: '測試一' };
  const ft = (rows, st) => { PY.master = rows; return call('payFtOfMe_', ME1, st); };
  check('M14-e', 'payFtOfMe_：true／false 照主檔；空白、其他字＝null（不擋）',
    [ft([Object.assign({}, E, { is_full_time: 'TRUE' })], 'SSLGF'), ft([Object.assign({}, E, { is_full_time: false })], 'SSLGF'), ft([Object.assign({}, E, { is_full_time: '' })], 'SSLGF'), ft([Object.assign({}, E, { is_full_time: '正職' })], 'SSLGF')],
    [true, false, null, null]);
  check('M14-f', '雙店主檔：本店那筆優先（光復計時、央廚正職，看光復＝false）；本店沒有、別店同工號同名有兩筆說法不一＝null；別店只一筆＝照那筆',
    [ft([Object.assign({}, E, { is_full_time: 'false' }), Object.assign({}, E, { store: 'CF', is_full_time: 'true' })], 'SSLGF'),
     ft([Object.assign({}, E, { store: 'CF', is_full_time: 'false' }), Object.assign({}, E, { store: 'HQ', is_full_time: 'true' })], 'MZTGF'),
     ft([Object.assign({}, E, { store: 'CF', is_full_time: 'true' }), Object.assign({}, E, { store: 'HQ', name: '別人', is_full_time: 'false' })], 'MZTGF'),
     ft([Object.assign({}, E, { store: 'SSLGF', is_full_time: 'true' }), Object.assign({}, E, { store: 'SSLGF', is_full_time: '' })], 'SSLGF')],
    [false, null, true, null]);
}

console.log('\n════ 十五、光復 LINE 回傳欄位 ════');
{
  const m = make({ now: T(NOW), hub: true, self: { roster: [ME] } });
  const out = JSON.parse(JSON.stringify(m.sb.lineHubQuotaOut_([{ name: '生理假', cap_days: 3, cap_h: 24, remain_h: 8, used_h: 16, basis: 'calendar', used_n: 2, dates: ['2026-07-02', '2026-08-05'] },
    { name: '事假', cap_days: 14, cap_h: 112, remain_h: 100, used_h: 12, basis: 'calendar' }])));
  check('M15-a', 'lineHubQuotaOut_：生理假多帶 used_n、dates、unit；事假形狀不變', out,
    [{ name: '生理假', cap_days: 3, cap_h: 24, remain_h: 8, used_h: 16, basis: 'calendar', used_n: 2, dates: ['2026-07-02', '2026-08-05'], unit: 'times' },
     { name: '事假', cap_days: 14, cap_h: 112, remain_h: 100, used_h: 12, basis: 'calendar' }]);
  m.sb.lineHubPayPick_ = () => ({ me: { emp_id: 'E01', name: '測試一' }, store: 'SSLGF' });
  m.sb.payFtOfMe_ = () => false;
  const a = m.sb.lineHubFtOf_('U1');
  m.sb.payFtOfMe_ = () => null;
  check('M15-b', 'lineHubFtOf_ 照薪資 payFtOfMe_：計時＝false；判斷不出來＝null', [a, m.sb.lineHubFtOf_('U1')], [false, null]);
}
console.log('\n════ 十六、病假年度用完 → 請改請事假（Eason 選 A：剩 0 才擋） ════');
{
  const SQ = (remain) => [{ name: '病假', cap_days: 30, cap_h: 240, remain_h: remain, used_h: 240 - remain }];
  const sk = (m, date, x) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return res(m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1', kind: 'leave', leave_type: '病假', date: date, reason: '看醫生' }, x || { hours: 8 }))); };
  const MSG = 'sick_used_up｜今年病假額度已用完（30 天），請改請事假';
  check('S01', '病假剩 0 → 擋，訊息白話', sk(world({ quota: SQ(0) }), '2026-11-20'), MSG);
  check('S02', '剩 4 小時、這張 8 小時 → 不擋（剩的不夠也照現行，超過的部分薪資無薪）', sk(world({ quota: SQ(4) }), '2026-11-20'), 'ok');
  const m3 = world({ quota: SQ(8) });
  const a3 = sk(m3, '2026-11-19');
  check('S03', '剩 8 小時、已有一張審核中 8 小時（跟生理假同口徑：審核中算已用）→ 下一張擋', [a3, sk(m3, '2026-11-20')], ['ok', 'sick_used_up｜今年病假額度已用完（30 天，含審核中或已核准還沒核定的病假單），請改請事假']);
  const m4 = world({ quota: SQ(8), leave: [['2026-11-17', '測試一', '病假', 8]] });
  const d4 = m4.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: m4.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: '病假', date: '2026-11-17', hours: 8, reason: 'x', attach_id: 'ATTACH_abcdefghij' }).request.id, decision: 'approve' });
  if (!d4.ok) throw new Error('核准失敗：' + JSON.stringify(d4));
  const m3b = world({ quota: SQ(8) });
  const p3 = m3b.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: '病假', date: '2026-11-19', hours: 8, reason: '看醫生' });
  const blockedBefore = sk(m3b, '2026-11-20').split('｜')[0];
  const rj = m3b.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: p3.request.id, decision: 'reject', reason: '日期錯了' });
  check('S03-b', '審核中的病假單把額度用完 → 下一張擋；那張被退回後 → 可以再送（Eason 選 A：審核中算已用）', [blockedBefore, rj.ok, sk(m3b, '2026-11-20')], ['sick_used_up', true, 'ok']);
  check('S04', '已核准而那天本店已記病假（額度表算過了）→ 不重複扣，剩 8 小時照收', sk(m4, '2026-11-20'), 'ok');
  check('S05', '查不到額度（沒有薪資主檔）→ 不擋', sk(world({ quota: [] }), '2026-11-20'), 'ok');
  check('S06', '請的是明年 → 不擋', sk(world({ now: '2026-12-20T10:00:00', quota: SQ(0) }), '2027-01-05'), 'ok');
  check('S07', '開關 REQ_SICK_USED_UP=off → 不擋', sk(world({ quota: SQ(0), props: { REQ_SICK_USED_UP: 'off' } }), '2026-11-20'), 'ok');
  const m8 = world({ props: { REQ_SEG2_KINDS: 'leave' }, quota: SQ(0) });
  check('S08', '兩段也擋', sk(m8, '2026-11-20', { segments: [sp('09:00', '10:00'), sp('15:00', '16:00')] }), MSG);
  const px = (m) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return res(m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E02', kind: 'leave', leave_type: '病假', date: '2026-11-18', hours: 8, reason: '沒綁 LINE' })); };
  check('S09', '主管代開：剩 0 擋、剩 8 收', [px(world({ opts: { ok: true, quotas: { E02: { sick: { cap_days: 30, cap_h: 240, remain_h: 0 } } } } })), px(world({ opts: { ok: true, quotas: { E02: { sick: { cap_days: 30, cap_h: 240, remain_h: 8 } } } } }))], [MSG, 'ok']);
  check('S10', '事假、生理假不受這條影響', sk(world({ quota: SQ(0) }), '2026-11-20', { hours: 8, leave_type: '事假' }), 'ok');
}
console.log('\n════ 十七、req_info 帶開關狀態與「已核准、那天還沒核定」的病假／生理假（申請頁事前提示用） ════');
{
  const CORE = ['2026-11-10', 'E01', '測試一', '[]', 8, '全天請假', '值班主管', '2026-11-10T22:00:00+08:00', '', ''];
  const m = world({ approved: [CORE], leave: [['2026-11-10', '測試一', '事假', 8], ['2026-11-11', '測試一', '病假', 8]] });
  const mk = (type, date, h) => { m.advance(1000); m.run('READ_MEMO_ = null;'); const r = m.sb.handleReqSubmit_({ id_token: 'TOK_U1', kind: 'leave', leave_type: type, date: date, hours: h, reason: 'x', attach_id: 'ATTACH_abcdefghij' });
    if (!r.ok) throw new Error(JSON.stringify(r)); const d = m.sb.handleMgrReqDecide_({ mgr_key: 'MK', id: r.request.id, decision: 'approve' }); if (!d.ok) throw new Error(JSON.stringify(d)); };
  mk('病假', '2026-11-12', 6); mk('病假', '2026-11-11', 8); mk('病假', '2026-11-10', 4); mk('生理假', '2026-11-13', 4);
  const info = JSON.parse(JSON.stringify(m.sb.handleReqInfo_({ id_token: 'TOK_U1' })));
  check('I01', '開關狀態＋已核准未核定：病假只算 11/12 的 6 小時（11/11 已記病假、11/10 核定成事假不算）、生理假 11/13', [info.mens_rules, info.sick_used_up, info.leave_live], [true, true, { sick_ok_h: 6, mens_ok_dates: ['2026-11-13'] }]);
  const off = world({ props: { REQ_MENS_RULES: 'off', REQ_SICK_USED_UP: 'off' } }).sb.handleReqInfo_({ id_token: 'TOK_U1' });
  check('I02', '兩個開關 off → false；沒有已核准的單 → 不讀表、回 0', [off.mens_rules, off.sick_used_up, JSON.parse(JSON.stringify(off.leave_live))], [false, false, { sick_ok_h: 0, mens_ok_dates: [] }]);
}
done();
