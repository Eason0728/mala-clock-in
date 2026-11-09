/* 2026-11-09 Eason 定案：家庭照顧假第 8 天起視同事假（績效）、婚假跨月累計、跨店超過 8H 由做到超過的那家開加班單 */
const vm = require('vm');
const H = require('./helpers/payroll-vm.js');
let p = 0, f = 0; const chk = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w), ok = a === b; ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + a + (ok ? '' : ' ← 應為 ' + b)); };
const J = (x) => JSON.parse(JSON.stringify(x));

/* ── 1A 家庭照顧假 ── */
{
  const S = H.load({ today: '2026-11-20' }), T = S.call('payLeaveTypes', 'CF');
  const e = H.ftEmp({ store: 'CF' }), ym = '2026-11';
  const att = (before, h) => H.baseAtt({ leaves: { family: h }, leave_usage: { family: { used_before_days: before } } });
  const run = (emp, a, m) => { const r = S.call('payCalcOne', emp, m || ym, a, H.cfg, 4, T); return H.item(r, 'attend_bonus'); };
  chk('今年累計剛好 7 天，績效照發', run(e, att(5, 16)), 3000);
  chk('累計到第 8 天，非小辛辣績效取消', run(e, att(5, 24)), 0);
  chk('之前已超過、本月再請也取消', run(e, att(8, 4)), 0);
  chk('之前已超過、本月沒請不取消', run(e, att(8, 0)), 3000);
  chk('小辛辣不適用', run(H.ftEmp({ store: 'SSLGF' }), att(5, 24)), 3000);
  chk('墨竹亭適用', run(H.ftEmp({ store: 'MZTJS' }), att(5, 24)), 0);
  chk('2026-10 以前不適用', run(e, att(5, 24), '2026-10'), 3000);
}

/* ── 3A 婚假跨月 ── */
{
  const leave = (d, h, t) => ({ '日期': d, '姓名': '測試甲', '假別': t || '婚假', '時數': h });
  const mk = (rows, ev) => H.load({ today: '2026-12-20', data: { leave_event: ev || [] }, clock: { SSLGF: { roster: [], approved: [], events: [], leave: rows } } });
  const nov = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => leave('2026-11-' + ('0' + n).slice(-2), 8));
  const ev = [{ store: 'SSLGF', emp_id: 'E01', code: 'marriage', event_date: '2026-11-05', updated_at: '2026-11-01' }];
  const run = (S, m, days) => {
    const T = S.call('payLeaveTypes', 'SSLGF'), e = H.ftEmp();
    const u = J(S.call('payLeaveUsedBefore', m, 'SSLGF', T, H.cfg, [e]))['E01'];
    const r = S.call('payCalcOne', e, m, H.baseAtt({ leaves: { marriage: days * 8 }, leave_usage: u }), H.cfg, 4, T);
    return { u, ded: H.item(r, 'marriage_leave') };
  };
  const a = run(mk(nov, ev), '2026-12', 8);
  chk('有結婚日：12 月已用帶 11 月 8 天', a.u.marriage, { used_before_days: 8 });
  chk('有結婚日：共 16 天，多的 2 天要扣', a.ded > 0, true);
  const b = run(mk(nov, ev), '2026-12', 6);
  chk('有結婚日：共 14 天不扣', b.ded, 0);
  const c = run(mk(nov), '2026-12', 8);
  chk('沒結婚日：不累計、記下要提醒', [c.u.marriage, c.ded], [{ used_before_days: 0, no_event_prior_days: 8 }, 0]);
  const old = [leave('2026-02-01', 8)];
  const oldEv = [{ store: 'SSLGF', emp_id: 'E01', code: 'marriage', event_date: '2026-11-05', updated_at: '2026-11-01' }];
  chk('結婚日前 10 天以前的婚假不算這一次', run(mk(old, oldEv), '2026-12', 1).u.marriage, { used_before_days: 0 });
  const cy = [leave('2026-12-20', 80)];
  const cyEv = [{ store: 'SSLGF', emp_id: 'E01', code: 'marriage', event_date: '2026-12-25', updated_at: '2026-12-01' }];
  chk('跨年也累計', run(mk(cy, cyEv), '2027-01', 1).u.marriage, { used_before_days: 10 });
  chk('2026-10 不動', run(mk(old, oldEv), '2026-10', 1).u.marriage, undefined);
  const S = mk(nov), T = S.call('payLeaveTypes', 'SSLGF');
  const u = J(S.call('payLeaveUsedBefore', '2026-12', 'SSLGF', T, H.cfg, [H.ftEmp()]))['E01'];
  const D = '2026-12-02';
  const daily = S.call('payDailyFor_', H.ftEmp(), '2026-12', { day_h: {}, day_leave: {} }, null, { [D]: { t: 'W' } }, [], '2026-12-19', 0);
  const r = S.call('payCalcOne', H.ftEmp(), '2026-12', H.baseAtt({ leaves: { marriage: 16 }, leave_usage: u, daily }), H.cfg, 4, T);
  chk('沒結婚日：薪資頁提醒資料', J(r.ot_info.marriage_cross), { prior_days: 8, month_days: 2 });
}

/* ── 4C 跨店超過 8H ── */
{
  const S = H.load({ today: '2026-11-20' });
  const D = '2026-11-12';
  const X = (periods, hours) => ({ stores: [{ code: 'SSLMC', name: '美村', acct: 'M9', hours, days: [{ date: D, periods, hours }] }] });
  const need = (own, ownP, sp, sh) => J(S.call('payOtCrossNeed_', { day_h: own ? { [D]: own } : {}, day_periods: ownP ? { [D]: ownP } : {} }, X(sp, sh)))[D];
  chk('本店先 6H、支援後 4H：支援店開 2H', need(6, '10:00-16:00', '17:00-21:00', 4), [{ code: 'SSLMC', name: '美村', acct: 'M9', home: false, need: 2 }]);
  chk('支援先 4H、本店後 6H：本店開 2H', need(6, '14:00-20:00', '09:00-13:00', 4), [{ code: '', name: '', acct: '', home: true, need: 2 }]);
  chk('合計沒超過 8H 不用開', need(4, '10:00-14:00', '15:00-19:00', 4), []);
  chk('本店本來就超過：兩邊各開', need(9, '09:00-18:00', '19:00-21:00', 2).map((x) => [x.home, x.need]), [[true, 1], [false, 2]]);
  chk('同一家中間穿插：照時段先後', need(8, '09:00-13:00,18:00-22:00', '14:00-17:00', 3).map((x) => [x.home, x.need]), [[true, 3]]);
  chk('時段看不懂：本店排前面', need(6, '', '17:00-21:00', 4).map((x) => [x.home, x.need]), [[false, 2]]);
  const check = (cross, f, fx, own) => J(S.call('payOtFormCheck_', { ot_own_h: own || { [D]: 6 }, ot_forms: f || { ot: {}, trip: {} }, ot_cross: cross, ot_forms_x: fx, ot_name: '測試甲' })).missing;
  const cr = { [D]: [{ code: 'SSLMC', name: '美村', acct: 'M9', home: false, need: 2 }] };
  chk('支援店沒開：列缺單、標哪家店', check(cr, null, { SSLMC: {} }), [{ date: D, need: 2, have: 0, store: 'SSLMC', store_name: '美村' }]);
  chk('支援店開了（工號對）：不缺', check(cr, null, { SSLMC: { 'id:M9': { ot: { [D]: 2 } } } }), []);
  chk('支援店開了（姓名對）：不缺', check(cr, null, { SSLMC: { '測試甲': { ot: { [D]: 2 } } } }), []);
  chk('開在本店不算', check(cr, { ot: { [D]: 2 }, trip: {} }, { SSLMC: {} }).length, 1);
  chk('支援店讀不到：不檢查', check(cr, null, { SSLMC: null }), []);
  chk('本店要開 2H 沒開', check({ [D]: [{ code: '', name: '', acct: '', home: true, need: 2 }] }, null, {}), [{ date: D, need: 2, have: 0 }]);
  chk('有支援的日子不再用本店單獨判斷', check({ [D]: [] }, null, {}, { [D]: 10 }), []);
  chk('沒有支援的日子照舊', check({}, null, {}, { [D]: 10 }), [{ date: D, need: 2, have: 0 }]);
  chk('11/10 以前不檢查', check({ '2026-11-10': cr[D] }, null, { SSLMC: {} }, {}), []);
  chk('沒帶 ot_cross 的舊呼叫端照舊', J(S.call('payOtFormCheck_', { ot_own_h: { [D]: 10 }, ot_forms: { ot: {}, trip: {} } })).missing, [{ date: D, need: 2, have: 0 }]);
  const K = H.load({ today: '2026-11-20', clock: { SSLMC: { requests: [{ status: 'approved', kind: 'ot', date: D, name: '測試甲', emp_id: 'M9', hours: 2 }] } } });
  const F = J(K.call('payOtFormsMonth_', 'SSLMC', '2026-11'));
  chk('加班單姓名與工號都查得到', [F['測試甲'].ot[D], F['id:M9'].ot[D]], [2, 2]);
}

/* ── 4C 支援店核定：別家店當天有打卡，就不要求作廢加班單 ── */
{
  const D = '2026-11-12';
  const mk = (peer) => {
    const S = H.load({ today: '2026-11-20' });
    S.__PEER = peer ? [{ ts: D + 'T09:00:00+08:00', type: 'in', status: 'ok' }] : [];
    S.__CALLS = 0;
    vm.runInContext('restPeerEvents_ = function(){ __CALLS++; return __PEER; }; reqBindFrom_ = function(){ return "2026-11-01"; }; reqStrictFrom_ = function(){ return "2026-11-01"; };', S);
    return S;
  };
  const row = (over) => Object.assign({ emp_id: 'M9', name: '測試甲', date: D, kind: 'ot', status: 'approved', hours: 2, start: '19:00', end: '21:00' }, over || {});
  const ms = (hm) => new Date(D + 'T' + hm + ':00+08:00').getTime();
  const per = [{ startMs: ms('17:00'), endMs: ms('21:00') }];
  const seg = [{ inMs: ms('17:00'), outMs: ms('21:00') }];
  const go = (S, h, r, opt) => { const x = S.call('reqBindCheck_', null, 'M9', D, h, per, seg, null, Object.assign({ rows: r, preview: true, sched_day: 'W' }, opt || {})); return J(x.probs).map((p) => p.rule); };
  chk('別家店有上班：4H 配 2H 加班單可核定', go(mk(true), 4, [row()]), []);
  chk('別家店沒上班：照舊要作廢', go(mk(false), 4, [row()]), ['ot_void']);
  chk('加班時段落在支援班表內：別家店有上班不擋', go(mk(true), 4, [row()], { sched_spans: [{ start: '17:00', end: '21:00' }] }), []);
  chk('加班時段落在班表內：別家店沒上班照擋', go(mk(false), 9, [row({ hours: 1, start: '20:00', end: '21:00' })], { sched_spans: [{ start: '17:00', end: '21:00' }] }), ['ot_in_sched']);
  chk('加班單仍要在本店核定時段內', go(mk(true), 4, [row({ start: '22:00', end: '23:30', hours: 1.5 })]), ['ot_slot']);
  const S = mk(true); go(S, 9, [row({ hours: 1, start: '20:00', end: '21:00' })]);
  chk('正常情況不多讀別家店', S.__CALLS, 0);
  chk('沒有 Rest 程式的環境回 false', H.load({ today: '2026-11-20' }).call('reqPeerWorked_', '測試甲', D), false);
}

console.log(f ? `\n❌ 失敗 ${f}` : `\n✅ 全部通過 (${p}/${p})`); process.exit(f ? 1 : 0);
