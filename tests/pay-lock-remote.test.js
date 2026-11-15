/**
 * 其他店同仁從 LINE 送鎖定月的申請也要擋（Eason 2026-11-16 回「要補」）。
 * 背景：薪資模組只掛在光復；其他八家店的 payLockedFor_ 回 undefined＝不擋。主管動作有營運系統先擋，
 *   可是同仁從 LINE 申請頁送單（req_submit）直接打各店自己的後端，所以其他店同仁還送得出鎖定月的申請。
 * 做法：
 *   其他店（沒掛薪資模組、CONFIG.PAYROLL_API 與 PAYROLL_STORE 都有填）只在 req_submit 這條路問光復 line_hub_pay_lock，
 *   帶同仁自己的 LINE id_token（不帶任何金鑰）；結果記 60 秒；問不到＝不知道＝不擋。主管的路徑完全不打網路。
 *   光復自己照舊讀自己的 payroll_run，不打網路。
 * 全部虛構同仁；金鑰、網址都是測試沙盒的假值。
 */
'use strict';
const H = require('./helpers/gs-sandbox');
const { make, T, check, done } = H;

const HUB = 'https://fake-hub.test/exec';
const MSG_STAFF = '2026-10 薪資已鎖定，不能再送這個月的申請；有需要請找主管（主管要先到薪資頁解鎖這個月）';
const AP = (date, emp, name) => [date, emp, name, '10:00-18:00', 8, '正常', '值班主管', date + 'T20:00:00+08:00', '', ''];
const ROSTER = [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true', line_user_id: 'U1' },
                { emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true', line_user_id: 'U2' }];
const EVENTS = [['2026-10-20T10:00:00', 'E01', 'in'], ['2026-10-20T18:00:00', 'E01', 'out'],
                ['2026-11-02T10:00:00', 'E01', 'in'], ['2026-11-02T18:00:00', 'E01', 'out']];
const SB = (date, extra) => Object.assign({ action: 'req_submit', id_token: 'TOK_U2', kind: 'leave', leave_type: '事假', date: date, hours: 8, reason: '測試' }, extra || {});
const pick = (r) => ({ ok: r.ok, error: r.error, message: r.message });
const hubSays = (locked) => (p) => Object.assign({ ok: true, store: p.store, ym: p.ym }, locked === undefined ? {} : { locked: locked });

/** 一家「其他店」（預設央廚 CF、沒掛薪資模組）。answer(payload)＝光復怎麼回（丟錯＝連不上）。 */
function store(answer, opt) {
  opt = opt || {};
  const m = make({ now: T('2026-11-03T10:00:00'), payroll: !!opt.payroll,
    config: Object.assign({ PAYROLL_API: HUB, PAYROLL_STORE: 'CF' }, opt.config || {}),
    self: { roster: ROSTER, events: EVENTS, approved: [AP('2026-10-22', 'E01', '代號甲')] },
    fetch: (url, o) => { if (url !== HUB) return undefined; const p = JSON.parse(o.payload); m.asked.push(p); return answer(p); } });
  m.asked = [];
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  const add = (o) => { const r = Object.assign({ created_at: '2026-10-19T09:00:00+08:00', status: 'pending', hours: 8, emp_id: 'E01', name: '代號甲', kind: 'leave', leave_type: '事假' }, o); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); };
  add({ id: 'L1', date: '2026-10-25' });
  add({ id: 'L2', date: '2026-10-26' });
  add({ id: 'L3', date: '2026-10-22', status: 'approved' });
  if (opt.payroll) {
    const head = m.run('PAY_SHEETS.run'), rs = ss.insertSheet(m.run('PAY_SHEET_NAME.run'));
    rs.appendRow(head.slice());
    (opt.runs || []).forEach((r) => { const o = { ym: r[0], store: r[1], status: r[2], emp_id: 'E01', name: '代號甲', net: 40000 }; rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k]))); });
    m.runSheet = rs;
  }
  m.post = (body) => { m.run('if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; }'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text); };
  m.reqCount = () => m.sb.reqRows_(ss).length;
  m.hubCalls = () => m.sb.__fetches.filter((f) => f.url === HUB).length;
  return m;
}

console.log('══ 一、其他店：鎖定月送單被擋、沒寫入 ══');
{
  const m = store(hubSays(true)), n0 = m.reqCount();
  check('pr-01', '光復說鎖了 → pay_locked（給同仁看的那句，跟光復一樣）', pick(m.post(SB('2026-10-31'))), { ok: false, error: 'pay_locked', message: MSG_STAFF });
  check('pr-02', '申請表沒多一筆', m.reqCount(), n0);
  check('pr-03', '問光復的內容：動作、這家店的 PAYROLL_STORE、月份、同仁自己的 id_token；不帶任何金鑰',
    [m.asked.length, Object.keys(m.asked[0]).sort(), m.asked[0].action, m.asked[0].store, m.asked[0].ym, m.asked[0].id_token],
    [1, ['action', 'id_token', 'store', 'ym'], 'line_hub_pay_lock', 'CF', '2026-10', 'TOK_U2']);
}

console.log('\n══ 二、其他店：沒鎖照常送 ══');
{
  const m = store(hubSays(false)), n0 = m.reqCount();
  check('pr-10', '光復說沒鎖 → 照常送出、申請表多一筆', [m.post(SB('2026-10-31')).ok, m.reqCount()], [true, n0 + 1]);
  check('pr-11', '有問光復一次', m.hubCalls(), 1);
}

console.log('\n══ 三、其他店：問不到＝不知道＝不擋、不丟錯 ══');
{
  const cases = [
    ['連不上（丟錯／逾時）', () => { throw new Error('連不上'); }],
    ['回的不是 JSON', () => '<html>錯誤頁</html>'],
    ['光復回 invalid_id_token', () => ({ ok: false, error: 'invalid_id_token' })],
    ['光復回 not_bound', () => ({ ok: false, error: 'not_bound' })],
    ['光復回 unknown_action（光復還沒換新版）', () => ({ ok: false, error: 'unknown_action' })],
    ['光復讀不到 payroll_run（沒有 locked）', hubSays(undefined)],
    ['locked 不是布林', (p) => ({ ok: true, store: p.store, ym: p.ym, locked: 'true' })],
    ['回的月份對不上', (p) => ({ ok: true, store: p.store, ym: '2026-09', locked: true })],
    ['回的店對不上', (p) => ({ ok: true, store: 'HQ', ym: p.ym, locked: true })],
    ['回 null', () => 'null'],
  ];
  cases.forEach((c, i) => {
    const m = store(c[1]), n0 = m.reqCount();
    const r = m.post(SB('2026-10-31'));
    check('pr-2' + i, c[0] + ' → 照常送出', [r.ok, m.reqCount(), m.hubCalls()], [true, n0 + 1, 1]);
  });
}

console.log('\n══ 四、60 秒內第二張單不再問 ══');
{
  const m = store(hubSays(true));
  m.post(SB('2026-10-31')); m.advance(30 * 1000);
  check('pr-30', '30 秒後第二張（別的同仁、同一個月）：照樣被擋，沒有再打網路', [pick(m.post(SB('2026-10-30', { id_token: 'TOK_U1' }))).error, m.hubCalls()], ['pay_locked', 1]);
  check('pr-31', '別的月份另外問（鍵含月份）', [m.post(SB('2026-11-05')).error, m.hubCalls(), m.asked[1].ym], ['pay_locked', 2, '2026-11']);
  m.advance(31 * 1000);
  check('pr-32', '超過 60 秒：再問一次', [m.post(SB('2026-10-29')).error, m.hubCalls()], ['pay_locked', 3]);
  check('pr-33', '快取鍵含店碼與月份', Object.keys(m.cache).filter((k) => /CF/.test(k) && /2026-10/.test(k)).length, 1);

  const f = store(hubSays(false)), n0 = f.reqCount();
  f.post(SB('2026-10-31')); f.advance(10 * 1000);
  check('pr-34', '沒鎖也記：10 秒後第二張照常送、沒有再打網路', [f.post(SB('2026-10-30', { id_token: 'TOK_U1' })).ok, f.hubCalls(), f.reqCount()], [true, 1, n0 + 2]);

  let up = false;
  const u = store((p) => { if (!up) throw new Error('連不上'); return hubSays(true)(p); });
  check('pr-35', '問不到不記：第一張照常送', u.post(SB('2026-10-31')).ok, true);
  up = true;
  check('pr-36', '下一張（同一分鐘內）會再問，這次問到鎖了 → 擋', [u.post(SB('2026-10-30', { id_token: 'TOK_U1' })).error, u.hubCalls()], ['pay_locked', 2]);

  const h = store(hubSays(undefined));
  h.post(SB('2026-10-31'));
  check('pr-37', '光復說不知道（沒有 locked）也不記：下一張再問', [h.post(SB('2026-10-30', { id_token: 'TOK_U1' })).ok, h.hubCalls()], [true, 2]);
}

console.log('\n══ 五、便宜的檢查沒過就不問光復 ══');
{
  const m = store(hubSays(true));
  check('pr-40', 'LINE 身分不對 → invalid_id_token，沒打光復', [m.post(SB('2026-10-31', { id_token: 'BAD' })).error, m.hubCalls()], ['invalid_id_token', 0]);
  check('pr-41', '日期格式不對 → bad_date，沒打光復', [m.post(SB('2026/10/31')).error, m.hubCalls()], ['bad_date', 0]);
  check('pr-42', '申請類別不對 → bad_kind，沒打光復', [m.post(SB('2026-10-31', { kind: 'toString' })).error, m.hubCalls()], ['bad_kind', 0]);
  const a = store(hubSays(true), { config: { PAYROLL_API: '' } });
  check('pr-43', 'PAYROLL_API 沒填的店：照常送、沒打網路', [a.post(SB('2026-10-31')).ok, a.sb.__fetches.filter((f) => /line_hub_pay_lock/.test(String(f.o && f.o.payload))).length], [true, 0]);
  const s = store(hubSays(true), { config: { PAYROLL_STORE: '' } });
  check('pr-44', 'PAYROLL_STORE 沒填的店（不知道要看哪家的鎖月）：照常送、沒打光復', [s.post(SB('2026-10-31')).ok, s.hubCalls()], [true, 0]);
}

console.log('\n══ 六、其他店的主管路徑完全不打網路 ══');
{
  const m = store(hubSays(true));
  const n0 = m.sb.__fetches.length;
  const APV = (extra) => Object.assign({ action: 'mgr_approve', mgr_key: 'MK', date: '2026-10-20', emp_id: 'E01', periods: [{ start: '10:00', end: '18:00' }], leaves: [] }, extra || {});
  const rs = [
    m.post(APV()),
    m.post(APV({ dry_run: true })),
    m.post({ action: 'mgr_approve_check', mgr_key: 'MK', date: '2026-10-20', items: [{ emp_id: 'E01', periods: [{ start: '10:00', end: '18:00' }], leaves: [] }] }),
    m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'L1', decision: 'approve' }),
    m.post({ action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['L2'], decision: 'approve' }),
    m.post({ action: 'mgr_req_void', mgr_key: 'MK', id: 'L3', reason: '測試' }),
    m.post({ action: 'mgr_req_proxy', mgr_key: 'AK', acting_name: '代號店長', emp_id: 'E02', kind: 'leave', leave_type: '事假', date: '2026-10-21', hours: 8, reason: '測試代開' }),
  ];
  check('pr-50', '核定、只檢查、核准、批次核准、作廢、代開：全部照常成功（其他店主管路徑不擋，營運系統先擋）', rs.map((r) => r.ok), [true, true, true, true, true, true, true]);
  check('pr-51', '這七個動作一次網路都沒打', m.sb.__fetches.length - n0, 0);
}

console.log('\n══ 七、光復（掛薪資模組）不打網路，照舊讀自己的 payroll_run ══');
{
  const RUNS = [['2026-10', 'SSLGF', 'final'], ['2026-11', 'SSLGF', 'draft']];
  const g = store(hubSays(false), { payroll: true, runs: RUNS, config: { PAYROLL_API: '', PAYROLL_STORE: '' } }), n0 = g.reqCount();
  check('pr-60', '鎖定月 → pay_locked', pick(g.post(SB('2026-10-31'))), { ok: false, error: 'pay_locked', message: MSG_STAFF });
  check('pr-61', '沒鎖的月份照常送', [g.post(SB('2026-11-04')).ok, g.reqCount()], [true, n0 + 1]);
  check('pr-62', '沒打光復那支', g.sb.__fetches.filter((f) => /line_hub_pay_lock/.test(String(f.o && f.o.payload))).length, 0);
  // 就算哪天光復的 PAYROLL_API 被填了：有薪資模組就只看自己的 payroll_run（光復說沒鎖也不算數）
  const g2 = store(hubSays(false), { payroll: true, runs: RUNS, config: { PAYROLL_API: HUB, PAYROLL_STORE: 'SSLGF' } });
  check('pr-63', '掛著薪資模組又填了 PAYROLL_API：還是看自己的、不打網路', [g2.post(SB('2026-10-31')).error, g2.post(SB('2026-11-04')).ok, g2.hubCalls()], ['pay_locked', true, 0]);
}

console.log('\n══ 八、光復的新動作 line_hub_pay_lock：只回鎖月布林，要驗 LINE 身分＋是那家店的同仁 ══');
{
  const HUBSTORES = [{ code: '', name: '小辛辣 新竹光復', ss_id: '', api: '' }, { code: 'cf', name: '鼎兆元 中央廚房', ss_id: 'CFSS', api: '' },
                     { code: 'hq', name: '鼎兆元 總部', ss_id: 'HQSS', api: '' }];
  const RUNS = [['2026-10', 'CF', 'final'], ['2026-11', 'CF', 'draft'], ['2026-09', 'SSLGF', 'final'], ['2026-08', 'HQ', 'final']];
  const hub = (opt) => {
    opt = opt || {};
    const m = make({ now: T('2026-11-03T10:00:00'), hub: true, payroll: opt.payroll !== false, hubStores: HUBSTORES,
      self: { roster: [{ emp_id: 'E01', name: '代號甲', key: 'K1', active: 'true', line_user_id: 'U1' }], events: [] },
      peers: { CFSS: { roster: [{ emp_id: 'CF01', name: '代號丙', key: 'K3', active: 'true', line_user_id: 'U3' },
                                { emp_id: 'CF02', name: '代號丁', key: 'K4', active: 'false', line_user_id: 'U4' }] },
               HQSS: { roster: [{ emp_id: 'HQ01', name: '代號戊', key: 'K5', active: 'true', line_user_id: 'U2' }] } } });
    if (opt.payroll !== false && opt.noRun !== true) {
      const head = m.run('PAY_SHEETS.run'), rs = m.sb.getSS().insertSheet(m.run('PAY_SHEET_NAME.run'));
      rs.appendRow(head.slice());
      RUNS.forEach((r) => { const o = { ym: r[0], store: r[1], status: r[2], emp_id: 'X', name: '代號', net: 40000 }; rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k]))); });
      m.runSheet = rs;
    }
    m.post = (body) => { m.run('if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; }'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text); };
    return m;
  };
  const Q = (tok, st, ym) => ({ action: 'line_hub_pay_lock', id_token: tok, store: st, ym: ym });
  const m = hub();
  check('pr-70', '央廚同仁問央廚鎖定月 → 只回 ok／store／ym／locked:true', m.post(Q('TOK_U3', 'CF', '2026-10')), { ok: true, store: 'CF', ym: '2026-10', locked: true });
  check('pr-71', '央廚同仁問央廚草稿月 → locked:false', m.post(Q('TOK_U3', 'CF', '2026-11')), { ok: true, store: 'CF', ym: '2026-11', locked: false });
  check('pr-72', '沒算過的月份 → locked:false', m.post(Q('TOK_U3', 'CF', '2026-07')), { ok: true, store: 'CF', ym: '2026-07', locked: false });
  check('pr-73', '別家店鎖的月份不算（光復 2026-09 鎖了，央廚沒鎖）', m.post(Q('TOK_U3', 'CF', '2026-09')).locked, false);
  check('pr-74', 'id_token 無效 → invalid_id_token', m.post(Q('BAD', 'CF', '2026-10')), { ok: false, error: 'invalid_id_token' });
  check('pr-75', '沒帶 id_token → invalid_id_token（不能不驗證就問）', m.post({ action: 'line_hub_pay_lock', store: 'CF', ym: '2026-10' }), { ok: false, error: 'invalid_id_token' });
  check('pr-76', '帶管理金鑰、主管金鑰也沒用（只認 LINE 身分）', m.post({ action: 'line_hub_pay_lock', admin_key: 'ADM', mgr_key: 'MK', store: 'CF', ym: '2026-10' }), { ok: false, error: 'invalid_id_token' });
  check('pr-77', '問別家店（央廚同仁問總部、問光復）→ not_bound，不給鎖月狀態', [m.post(Q('TOK_U3', 'HQ', '2026-08')), m.post(Q('TOK_U3', '', '2026-09')), m.post(Q('TOK_U3', 'SSLGF', '2026-09'))],
    [{ ok: false, error: 'not_bound' }, { ok: false, error: 'not_bound' }, { ok: false, error: 'not_bound' }]);
  check('pr-78', '離職同仁（名冊停用）→ not_bound', m.post(Q('TOK_U4', 'CF', '2026-10')), { ok: false, error: 'not_bound' });
  check('pr-79', '不存在的店碼 → not_bound', m.post(Q('TOK_U3', 'NOPE', '2026-10')), { ok: false, error: 'not_bound' });
  check('pr-80', 'ym 格式錯 → bad_ym', ['2026-13', '2026-1', '202610', '', '2026-10-01', null].map((y) => m.post(Q('TOK_U3', 'CF', y)).error), ['bad_ym', 'bad_ym', 'bad_ym', 'bad_ym', 'bad_ym', 'bad_ym']);
  check('pr-81', '店碼小寫也認得（回薪資用的大寫店碼）', m.post(Q('TOK_U3', 'cf', '2026-10')), { ok: true, store: 'CF', ym: '2026-10', locked: true });
  check('pr-82', '光復同仁問光復（店碼空白或 SSLGF）', [m.post(Q('TOK_U1', '', '2026-09')), m.post(Q('TOK_U1', 'SSLGF', '2026-10'))],
    [{ ok: true, store: 'SSLGF', ym: '2026-09', locked: true }, { ok: true, store: 'SSLGF', ym: '2026-10', locked: false }]);
  check('pr-83', '總部同仁問總部', m.post(Q('TOK_U2', 'HQ', '2026-08')), { ok: true, store: 'HQ', ym: '2026-08', locked: true });

  const f = hub(); f.runSheet.getDataRange = function () { throw new Error('讀不到'); };
  check('pr-84', '讀 payroll_run 丟錯 → ok 但不給 locked（各店當作不知道）', f.post(Q('TOK_U3', 'CF', '2026-10')), { ok: true, store: 'CF', ym: '2026-10' });
  const nr = hub({ noRun: true });
  check('pr-85', '還沒有 payroll_run 分頁 → locked:false，而且不順手建分頁', [nr.post(Q('TOK_U3', 'CF', '2026-10')), nr.sb.getSS().getSheetByName(nr.run('PAY_SHEET_NAME.run')) === null], [{ ok: true, store: 'CF', ym: '2026-10', locked: false }, true]);
  const np = hub({ payroll: false });
  check('pr-86', '這個專案沒掛薪資模組 → ok 但不給 locked', np.post(Q('TOK_U3', 'CF', '2026-10')), { ok: true, store: 'CF', ym: '2026-10' });

  const t = hub(); let last;
  for (let i = 0; i < 31; i++) last = t.post(Q('TOK_U3', 'CF', '2026-10'));
  check('pr-87', '同一個人一分鐘問超過 30 次 → too_many', last, { ok: false, error: 'too_many' });

  const other = store(hubSays(true));
  check('pr-88', '沒掛 LineHub 的店沒有這個動作', other.post(Q('TOK_U1', 'CF', '2026-10')).error, 'unknown_action');
}

console.log('\n══ 九、兩邊接起來：央廚後端問到的是光復真的回的東西 ══');
{
  // 光復
  const HUBSTORES = [{ code: '', name: '小辛辣 新竹光復', ss_id: '', api: '' }, { code: 'cf', name: '鼎兆元 中央廚房', ss_id: 'CFSS', api: '' }];
  const hubM = make({ now: T('2026-11-03T10:00:00'), hub: true, payroll: true, hubStores: HUBSTORES, self: { roster: [], events: [] },
    peers: { CFSS: { roster: [{ emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true', line_user_id: 'U2' }] } } });
  const head = hubM.run('PAY_SHEETS.run'), rs = hubM.sb.getSS().insertSheet(hubM.run('PAY_SHEET_NAME.run'));
  rs.appendRow(head.slice());
  const o = { ym: '2026-10', store: 'CF', status: 'final', emp_id: 'E02', name: '代號乙', net: 40000 }; rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k])));
  const viaHub = (p) => JSON.parse(hubM.sb.doPost({ postData: { contents: JSON.stringify(p) } }).text);
  const cf = store(viaHub), n0 = cf.reqCount();
  check('pr-90', '央廚同仁（U2）送鎖定月 → 擋；沒鎖的月 → 照常', [pick(cf.post(SB('2026-10-31'))).error, cf.post(SB('2026-11-04')).ok, cf.reqCount()], ['pay_locked', true, n0 + 1]);
  const cf2 = store(viaHub);
  check('pr-91', '光復不認得這位同仁是央廚的（U1 沒綁央廚）→ 問不到 → 照常送', cf2.post(SB('2026-10-31', { id_token: 'TOK_U1' })).ok, true);
}

console.log('\n══ 十、複驗補修：洗額度繞不過去、不記成考勤變動、剛綁定的同仁也認得 ══');
{
  const HUBSTORES = [{ code: '', name: '小辛辣 新竹光復', ss_id: '', api: '' }, { code: 'cf', name: '鼎兆元 中央廚房', ss_id: 'CFSS', api: '' }];
  const pair = () => {
    const hubM = make({ now: T('2026-11-03T10:00:00'), hub: true, payroll: true, hubStores: HUBSTORES, self: { roster: [], events: [] },
      peers: { CFSS: { roster: [{ emp_id: 'E02', name: '代號乙', key: 'K2', active: 'true', line_user_id: 'U2' }] } } });
    const head = hubM.run('PAY_SHEETS.run'), rs = hubM.sb.getSS().insertSheet(hubM.run('PAY_SHEET_NAME.run'));
    rs.appendRow(head.slice());
    const o = { ym: '2026-10', store: 'CF', status: 'final', emp_id: 'E02', name: '代號乙', net: 40000 }; rs.appendRow(head.map((k) => (o[k] === undefined ? '' : o[k])));
    const hubPost = (p) => JSON.parse(hubM.sb.doPost({ postData: { contents: JSON.stringify(p) } }).text);
    const cf = store(hubPost);
    let opens = 0; const open0 = hubM.sb.SpreadsheetApp.openById;
    hubM.sb.SpreadsheetApp.openById = (id) => { opens++; return open0(id); };
    return { cf, hubM, hubPost, adv: (ms) => { cf.advance(ms); hubM.advance(ms); }, opens: () => opens };
  };
  const Q = (st, ym) => ({ action: 'line_hub_pay_lock', id_token: 'TOK_U2', store: st, ym: ym });
  const BUSY = { ok: false, error: 'busy', message: '系統忙碌，請一分鐘後再送一次' };

  // （一）同仁先把自己在光復的每分鐘額度洗完，再送鎖定月的單：不可以因為光復回 too_many 就當成「不知道、不擋」
  const m = store(() => ({ ok: false, error: 'too_many' })), n0 = m.reqCount();
  check('pr-100', '光復回 too_many（這位同仁自己問太多次）→ 這張單先不收，請他一分鐘後再送；沒寫入', [m.post(SB('2026-10-31')), m.reqCount()], [BUSY, n0]);
  check('pr-101', 'too_many 不記：下一張照樣再問光復', [m.post(SB('2026-10-30')).error, m.hubCalls()], ['busy', 2]);

  const a = pair(), a0 = a.cf.reqCount();
  let last;
  for (let i = 0; i < 31; i++) last = a.hubPost(Q('亂填', '亂填'));
  check('pr-102', '（前提）直接打光復 31 次、店與月份亂填也算次數 → 第 31 次起 too_many', [last.error, a.hubPost(Q('CF', '2026-10')).error], ['too_many', 'too_many']);
  check('pr-103', '洗完額度馬上向央廚送鎖定月的單 → 送不出去、沒寫入', [a.cf.post(SB('2026-10-31')).error, a.cf.reqCount()], ['busy', a0]);
  a.adv(61 * 1000);
  check('pr-104', '一分鐘後（額度回來）再送 → 問得到 → pay_locked', [a.cf.post(SB('2026-10-31')).error, a.cf.reqCount()], ['pay_locked', a0]);
  a.adv(61 * 1000);   // 央廚那邊 60 秒的「鎖了」過期
  for (let i = 0; i < 31; i++) a.hubPost(Q('亂填', '亂填'));
  check('pr-105', '等央廚的快取過期再洗一次額度再送 → 還是送不出去、沒寫入', [a.cf.post(SB('2026-10-30')).error, a.cf.reqCount()], ['busy', a0]);

  // （二）光復回答鎖月查詢是只讀：不可以被記成「考勤有變動」（Mac mini 的考勤副本會因此重讀光復今天四份清單）
  const d = pair();
  check('pr-110', 'line_hub_pay_lock 列在只讀動作', d.hubM.run('dutyFeedIsRead_("line_hub_pay_lock")'), true);
  d.hubPost(Q('CF', '2026-10')); d.hubPost(Q('CF', '2026-11'));
  check('pr-111', '光復成功回答兩次之後，一筆考勤變動都沒記', Object.keys(d.hubM.cache).filter((k) => /^dfeed_/.test(k)).length, 0);

  // （三）同仁剛在自己店綁好 LINE，光復手上還是 5 分鐘前「這個 LINE 沒綁任何店」的舊紀錄：要重新看一次名冊，不能就當不認得
  const b = pair(), rv = b.hubM.peers.CFSS.sh.roster.values, col = rv[0].indexOf('line_user_id'), b0 = b.cf.reqCount();
  rv[1][col] = '';
  check('pr-120', '（前提）還沒綁的時候問 → not_bound', b.hubPost(Q('CF', '2026-10')).error, 'not_bound');
  rv[1][col] = 'U2';
  check('pr-121', '綁好後馬上送鎖定月 → 擋、沒寫入', [b.cf.post(SB('2026-10-31')).error, b.cf.reqCount()], ['pay_locked', b0]);
  // 真的沒綁的人一直問：5 分鐘內只多重看一次名冊（不會每問一次就把每家店的名冊重開一遍）
  const c = pair(), cv = c.hubM.peers.CFSS.sh.roster.values;
  cv[1][cv[0].indexOf('line_user_id')] = '';
  c.hubPost(Q('CF', '2026-10')); c.hubPost(Q('CF', '2026-10'));
  const o2 = c.opens();
  for (let i = 0; i < 5; i++) c.hubPost(Q('CF', '2026-10'));
  check('pr-122', '沒綁的人接著再問 5 次：都回 not_bound、沒有再開任何名冊', [c.hubPost(Q('CF', '2026-10')).error, c.opens() - o2], ['not_bound', 0]);
}

done();
