// P3-3 Google 端核定改版（2026-11-21，DutyFeed.gs dutyAuthRun_／dutyVerGuard_、Requests.gs 四個入口）
// 契約：docs/contract-writeback.md。驗收照 phase2-5-plan P3-3：
//   帶 base_ver 三種讀不到都回 ver_unknown；兩個請求同時核定同一人同一天只有一個成功；
//   DUTY_AUTH=mini 沒簽名回 moved_to_mini、簽名錯回錯、同單號第二次不重寫、LINE req_submit 不受影響；開關全空＝以前的行為。
'use strict';
const crypto = require('crypto');
const { make, T, check, done } = require('./helpers/gs-sandbox');

const KEY = 'k'.repeat(32), STORE = 'gf';
const ROSTER = [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' }];
const EVENTS = [['2026-11-09T09:00:00', 'E01', 'in'], ['2026-11-09T17:00:00', 'E01', 'out'], ['2026-11-09T10:00:00', 'E02', 'in'], ['2026-11-09T18:00:00', 'E02', 'out']];

function world(props) {
  const m = make({ now: T('2026-11-10T10:00:00'), props: Object.assign({ REQ_CARD_REASON_FROM: 'off' }, props || {}), self: { roster: ROSTER, events: EVENTS } });
  m.post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  m.ver = (emp) => (m.post({ action: 'mgr_day', mgr_key: 'AK', date: '2026-11-09', with_ver: true }).employees.filter((e) => e.emp_id === emp)[0] || {}).ver;
  const ss = m.sb.getSS(), sh = m.sb.reqSheet_(ss, true), HD = m.run('REQ_HEADERS_');
  m.addReq = (o) => { const r = Object.assign({ created_at: '2026-11-01T09:00:00+08:00', status: 'pending', hours: 8, emp_id: 'E01', name: '測試一', kind: 'leave', leave_type: '事假', date: '2026-11-12' }, o); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); };
  m.reqs = () => m.sb.reqRows_(ss);
  m.reqStatus = (id) => (m.reqs().filter((x) => String(x.id) === id)[0] || {}).status;
  return m;
}
const sign = (o, store, key) => {
  const t = o.action === 'mgr_approve' ? [o.emp_id, o.date, o.base_ver || ''].join('|')
    : o.action === 'mgr_req_decide' ? o.id + '|' + o.decision
    : o.action === 'mgr_req_decide_batch' ? o.ids.join(',') + '|' + o.decision : String(o.id);
  const msg = ['wb', '1', store || STORE, o.action, o.wb_id, String(o.wb_ts), t].join('|');
  return crypto.createHmac('sha256', key || KEY).update(msg, 'utf8').digest('hex');
};
const signed = (m, o, opt) => { opt = opt || {}; const b = Object.assign({ wb_id: 'wb-test-0001', wb_ts: m.sb.Date.now() }, o); b.wb_sig = sign(b, opt.store, opt.key); return b; };
const APV = (extra) => Object.assign({ action: 'mgr_approve', mgr_key: 'AK', acting_name: '店長甲（DZY001）', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }, extra || {});
const pick = (r) => ({ ok: r.ok, error: r.error });
const MINI = { DUTY_AUTH: 'mini', DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: STORE };

console.log('══ 零、簽名算法（契約第 3.2 節範例）══');
{
  const m = world();
  const msg = 'wb|1|gf|mgr_approve|wb-gf-000123-1a2b|1763712000000|E012|2026-11-21|Qm9vZm9vYmFyYmF6';
  check('W01', 'Google 端 dutyWbSign_＝契約範例值（Node crypto 同值）', [m.sb.dutyWbSign_(msg, KEY), crypto.createHmac('sha256', KEY).update(msg).digest('hex')],
    ['70fb31e2d50b704638823055eab0131de269ea4f818d7b73a95d41d18c6ea80b', '70fb31e2d50b704638823055eab0131de269ea4f818d7b73a95d41d18c6ea80b']);
  check('W02', '對象欄：四種動作', [m.sb.dutyWbTarget_('mgr_approve', { emp_id: 'E1', date: 'D', base_ver: 'V' }), m.sb.dutyWbTarget_('mgr_req_decide', { id: 'r1', decision: 'approve' }),
    m.sb.dutyWbTarget_('mgr_req_decide_batch', { ids: ['a', 'b'], decision: 'approve' }), m.sb.dutyWbTarget_('mgr_req_void', { id: 'r9' }), m.sb.dutyWbTarget_('mgr_approve', { emp_id: 'E1', date: 'D' })],
    ['E1|D|V', 'r1|approve', 'a,b|approve', 'r9', 'E1|D|']);
}

console.log('\n══ 一、帶 base_ver 讀不到版本：開關關＝照舊放行；DUTY_VER_STRICT／mini＝ver_unknown ══');
const STUBS = [['V1', '讀當天資料丟回 null', 'null'], ['V2', '讀當天資料失敗（ok:false）', '({ ok: false, error: "read_failed" })'],
  ['V3', '名單裡沒有這個人', '({ ok: true, employees: [] })'], ['V4', '有這個人但算不出版本', '({ ok: true, employees: [{ emp_id: "E01" }] })']];
STUBS.forEach(([id, desc, ret]) => {
  for (const mode of ['off', 'strict', 'mini']) {
    const m = world(mode === 'strict' ? { DUTY_VER_STRICT: '1' } : mode === 'mini' ? MINI : {});
    const real = m.sb.handleMgrDay;
    m.run('handleMgrDay = function (b) { if (b && b.with_ver) return ' + ret + '; return __realDay(b); }');
    m.sb.__realDay = real;
    const n0 = m.approved().length;
    const body = APV({ base_ver: 'AAAAAAAAAAAAAAAA' });
    const r = mode === 'mini' ? m.post(signed(m, body)) : m.post(body);
    const exp = mode === 'off' ? [true, undefined, n0 + 1] : [false, 'ver_unknown', n0];
    check(id + '-' + mode, desc + '（' + mode + '）', [r.ok, r.error, m.approved().length], exp);
  }
});
{
  const m = world({ DUTY_VER_STRICT: '1' });
  const r = m.post(APV({ mgr_key: 'WRONG', base_ver: 'AAAAAAAAAAAAAAAA' }));
  check('V5', 'strict：金鑰錯照舊回 unauthorized（不回可重試的 ver_unknown）', pick(r), { ok: false, error: 'unauthorized' });
  const v = m.ver('E01');
  check('V6', 'strict：版本對得上照常核定', pick(m.post(APV({ base_ver: v }))), { ok: true, error: undefined });
  check('V7', 'strict：版本對不上照舊 stale_ver', pick(m.post(APV({ base_ver: v }))), { ok: false, error: 'stale_ver' });
  check('V8', 'strict：沒帶 base_ver（現行模式的舊頁）照常核定', pick(m.post(APV({ emp_id: 'E02', periods: [{ start: '10:00', end: '18:00' }] }))), { ok: true, error: undefined });
  const m2 = world({ DUTY_VER_STRICT: 'off' });
  m2.run('handleMgrDay = function () { return null; }');
  check('V9', 'DUTY_VER_STRICT=off＝關（照舊放行）', m2.post(APV({ base_ver: 'AAAAAAAAAAAAAAAA' })).ok, true);
  const m3 = world({ DUTY_VER_STRICT: 'yes please' });
  m3.run('handleMgrDay = function () { return null; }');
  check('V10', 'DUTY_VER_STRICT 填錯值＝開（保護性）', m3.post(APV({ base_ver: 'AAAAAAAAAAAAAAAA' })).error, 'ver_unknown');
}

console.log('\n══ 二、兩個請求同時核定同一人同一天 ══');
// 假鎖：同一時間只有一個持有者；第二個執行（巢狀呼叫模擬）tryLock 拿不到就回 false（正式環境是等滿 20 秒才放棄）
function realLock(m) {
  const st = { held: null, n: 0, waits: [] };
  m.sb.LockService = { getScriptLock: () => { const me = { id: ++st.n }; return {
    tryLock: (ms) => { st.waits.push(ms); if (st.held) return false; st.held = me.id; return true; },
    waitLock: () => { if (st.held) throw new Error('lock timeout'); st.held = me.id; },
    releaseLock: () => { if (st.held === me.id) st.held = null; }, hasLock: () => st.held === me.id }; } };
  return st;
}
function race(props, signedMode) {
  const m = world(props);
  const st = realLock(m);
  const v = m.ver('E01');
  const realApprove = m.sb.handleMgrApprove;
  let second = null, fired = false;
  m.sb.__realApprove = realApprove;
  m.sb.__fire = () => {
    if (fired) return; fired = true;
    const b2 = APV({ acting_name: '店長乙（DZY002）', periods: [{ start: '09:00', end: '16:00' }], base_ver: v });
    second = m.post(signedMode ? signed(m, Object.assign(b2, { wb_id: 'wb-test-0002' })) : b2);
  };
  // 第一個請求判完版本、正要寫入時，第二個請求進來（＝兩位主管幾乎同時按）
  m.run('handleMgrApprove = function (b) { if (b.dry_run !== true) __fire(); return __realApprove(b); }');
  const b1 = APV({ base_ver: v });
  const first = m.post(signedMode ? signed(m, b1) : b1);
  const rows = m.approved().filter((r) => r[0] === '2026-11-09' && r[1] === 'E01');
  return { first: pick(first), second: pick(second), rows: rows.length, waits: st.waits };
}
{
  const off = race({});
  check('L1', '開關關（現在的行為）：兩個都成功＝舊缺口 2 重現', [off.first.ok, off.second.ok], [true, true], '證明測試抓得到問題；上線預設照舊，開 DUTY_APPROVE_LOCK 或 mini 才修');
  const on = race({ DUTY_APPROVE_LOCK: '1' });
  check('L2', 'DUTY_APPROVE_LOCK=1：只有一個成功，另一個 busy', [on.first, on.second, on.rows], [{ ok: true, error: undefined }, { ok: false, error: 'busy' }, 1]);
  check('L3', '核定鎖最多等 20 秒', on.waits.indexOf(20000) >= 0, true);
  const mini = race(MINI, true);
  check('L4', 'mini 模式（簽名寫回）：只有一個成功', [mini.first, mini.second, mini.rows], [{ ok: true, error: undefined }, { ok: false, error: 'busy' }, 1]);
  const m = world({ DUTY_APPROVE_LOCK: '1' });
  const v = m.ver('E01');
  m.post(APV({ base_ver: v }));
  check('L5', '鎖開：一前一後送，第二個照版本退回 stale_ver', m.post(APV({ base_ver: v, acting_name: '店長乙（DZY002）' })).error, 'stale_ver');
  const m2 = world({ DUTY_APPROVE_LOCK: '1' });
  m2.sb.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  const n0 = m2.approved().length;
  check('L6', '鎖拿不到：回 busy、不寫', [pick(m2.post(APV())), m2.approved().length], [{ ok: false, error: 'busy' }, n0]);
  check('L7', '鎖拿不到也不擋只檢查（mgr_approve_check）', m2.post({ action: 'mgr_approve_check', mgr_key: 'AK', date: '2026-11-09', items: [{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }] }).ok, true);
}

console.log('\n══ 三、DUTY_AUTH=mini：只收 mini 簽名的寫回 ══');
{
  const m = world(MINI);
  m.addReq({ id: 'P1' }); m.addReq({ id: 'P2' }); m.addReq({ id: 'P3' }); m.addReq({ id: 'A1', status: 'approved' });
  const n0 = m.approved().length;
  const moved = { ok: false, error: 'moved_to_mini', message: '核定已改在管理系統。系統暫停時請等恢復，不要改用其他頁面。' };
  const full = (r) => ({ ok: r.ok, error: r.error, message: r.message });
  check('M1', '沒簽名的核定（舊門市核定頁）→ moved_to_mini、不寫', [full(m.post(APV({ mgr_key: 'MK' }))), m.approved().length], [moved, n0]);
  check('M2', '沒簽名的審單 → moved_to_mini', [full(m.post({ action: 'mgr_req_decide', mgr_key: 'MK', id: 'P1', decision: 'approve' })), m.reqStatus('P1')], [moved, 'pending']);
  check('M3', '沒簽名的批次審單 → moved_to_mini', [full(m.post({ action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['P1'], decision: 'approve' })), m.reqStatus('P1')], [moved, 'pending']);
  check('M4', '沒簽名的作廢 → moved_to_mini', [full(m.post({ action: 'mgr_req_void', mgr_key: 'MK', id: 'A1', reason: 'x' })), m.reqStatus('A1')], [moved, 'approved']);
  check('M5', '只檢查（dry_run、mgr_approve_check）不擋', [m.post(APV({ dry_run: true })).ok, m.post({ action: 'mgr_approve_check', mgr_key: 'AK', date: '2026-11-09', items: [{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }] }).ok], [true, true]);
  const v = m.ver('E01');
  const ok1 = m.post(signed(m, APV({ base_ver: v })));
  check('M6', '簽名正確＋base_ver → 照常核定', [ok1.ok, ok1.dup, m.approved().length], [true, undefined, n0 + 1]);
  const again = m.post(signed(m, APV({ base_ver: v })));
  check('M7', '同一個 wb_id 再送一次 → 回當時結果＋dup:true、不再寫', [again.ok, again.dup, again.wb_id, m.approved().length, again.approved_hours === ok1.approved_hours], [true, true, 'wb-test-0001', n0 + 1, true]);
  m.advance(5 * 60000);
  const resign = m.post(signed(m, APV({ base_ver: v })));
  check('M8', '5 分鐘後重簽（新 wb_ts、同 wb_id）→ 仍是 dup', [resign.ok, resign.dup, m.approved().length], [true, true, n0 + 1]);
  const v2 = m.ver('E02');
  const bad = signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0003' })); bad.wb_sig = bad.wb_sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  check('M9', '簽名錯 → bad_sig、不寫', [pick(m.post(bad)), m.approved().length], [{ ok: false, error: 'bad_sig' }, n0 + 1]);
  check('M10', '店代碼不同簽的 → bad_sig', m.post(signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0004' }), { store: 'mztjs' })).error, 'bad_sig');
  check('M11', '別把金鑰簽的 → bad_sig', m.post(signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0005' }), { key: 'x'.repeat(32) })).error, 'bad_sig');
  const tampered = signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0006' })); tampered.emp_id = 'E01';
  check('M12', '簽完改對象（emp_id）→ bad_sig', m.post(tampered).error, 'bad_sig');
  const old = signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0007', wb_ts: m.sb.Date.now() - 11 * 60000 }));
  const oldR = m.post(old);
  check('M13', '簽名時間超過 10 分鐘 → wb_ts（附 Google 現在時間）', [oldR.error, oldR.now === m.sb.Date.now()], ['wb_ts', true]);
  check('M14', '簽名時間 9 分鐘內 → 收', m.post(signed(m, APV({ emp_id: 'E02', base_ver: v2, wb_id: 'wb-test-0008', wb_ts: m.sb.Date.now() + 9 * 60000 }))).ok, true);
  check('M15', '格式錯（wb_id 太短／wb_ts 是文字／wb_sig 不是 64 字）→ bad_wb', [
    m.post(Object.assign(APV(), { wb_id: 'x', wb_ts: m.sb.Date.now(), wb_sig: 'a'.repeat(64) })).error,
    m.post(Object.assign(APV(), { wb_id: 'wb-test-0009', wb_ts: String(m.sb.Date.now()), wb_sig: 'a'.repeat(64) })).error,
    m.post(Object.assign(APV(), { wb_id: 'wb-test-0009', wb_ts: m.sb.Date.now(), wb_sig: 'abc' })).error,
    m.post(Object.assign(APV(), { wb_id: 'wb-test-0009' })).error], ['bad_wb', 'bad_wb', 'bad_wb', 'bad_wb']);
  check('M16', '簽名正確但核定沒帶 base_ver → need_base_ver', m.post(signed(m, APV({ emp_id: 'E02', wb_id: 'wb-test-0010' }))).error, 'need_base_ver');
  // 審單、作廢、批次
  const d1 = m.post(signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'P1', decision: 'approve', wb_id: 'wb-dec-0001' }));
  const d1b = m.post(signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'P1', decision: 'approve', wb_id: 'wb-dec-0001' }));
  check('M17', '簽名審單 → 核准；同 wb_id 重送 → dup（不是「已經處理過了」）', [d1.ok, m.reqStatus('P1'), d1b.ok, d1b.dup, d1b.error], [true, 'approved', true, true, undefined]);
  const d2 = m.post(signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'P1', decision: 'approve', wb_id: 'wb-dec-0002' }));
  check('M18', '換一個 wb_id 再核同一張 → 照原本規則 not_pending', d2.error, 'not_pending');
  const b1 = m.post(signed(m, { action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['P2', 'P3'], decision: 'approve', wb_id: 'wb-bat-0001' }));
  const b1b = m.post(signed(m, { action: 'mgr_req_decide_batch', mgr_key: 'MK', ids: ['P2', 'P3'], decision: 'approve', wb_id: 'wb-bat-0001' }));
  check('M19', '簽名批次審單 → 兩張核准；重送 dup、done 照原本', [b1.ok, b1.done, b1b.dup, b1b.done], [true, ['P2', 'P3'], true, ['P2', 'P3']]);
  const vd = m.post(signed(m, { action: 'mgr_req_void', mgr_key: 'MK', id: 'A1', reason: '改單', wb_id: 'wb-void-0001' }));
  const vd2 = m.post(signed(m, { action: 'mgr_req_void', mgr_key: 'MK', id: 'A1', reason: '改單', wb_id: 'wb-void-0001' }));
  check('M20', '簽名作廢 → 作廢；重送 dup', [vd.ok, m.reqStatus('A1'), vd2.ok, vd2.dup], [true, 'voided', true, true]);
  const swap = signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'P9', decision: 'approve', wb_id: 'wb-swap-0001' }); swap.action = 'mgr_req_void';
  check('M21', '審單的簽名拿去作廢 → bad_sig', m.post(swap).error, 'bad_sig');
  // 失敗不留記號
  const nf = m.post(signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'NOPE', decision: 'approve', wb_id: 'wb-nf-0001' }));
  const nf2 = m.post(signed(m, { action: 'mgr_req_decide', mgr_key: 'MK', id: 'NOPE', decision: 'approve', wb_id: 'wb-nf-0001' }));
  check('M22', '規則擋下（找不到單）→ 不留記號，重送照樣重判', [nf.error, nf2.error, nf2.dup, m.sb.dutyWbGet_('wb-nf-0001')], ['not_found', 'not_found', undefined, null]);
  // 正在寫的記號（另一個執行剛放的）→ busy
  m.sb.dutyWbPut_('wb-pend-0001', { state: 'pending' }, 600);
  const pend = m.post(signed(m, APV({ emp_id: 'E02', base_ver: m.ver('E02'), wb_id: 'wb-pend-0001' })));
  check('M23', '同 wb_id 正在寫 → busy＋wb_pending', [pend.error, pend.wb_pending], ['busy', true]);
  // 執行中丟例外 → 記號拿掉
  m.run('var __realRows = reqRows_; reqRows_ = function () { throw new Error("boom"); };');   // 原本流程鎖內第一件事就丟例外
  const ex = m.post(signed(m, { action: 'mgr_req_void', mgr_key: 'MK', id: 'P2', reason: 'x', wb_id: 'wb-ex-0001' }));
  check('M24', '執行中丟例外 → server_error、記號拿掉（重送不會卡 busy）', [ex.error, m.sb.dutyWbGet_('wb-ex-0001')], ['server_error', null]);
  m.run('reqRows_ = __realRows;');
  // 6 小時後記號過期
  m.advance(6 * 3600000 + 1000);
  check('M25', '「已寫好」記號 6 小時後過期', m.sb.dutyWbGet_('wb-dec-0001'), null);
}
{
  const m = world({ DUTY_AUTH: 'mini' });
  check('M26', 'mini 但這家店沒設金鑰 → wb_no_key', m.post(signed(m, APV({ base_ver: m.ver('E01') }))).error, 'wb_no_key');
  const m2 = world({ DUTY_AUTH: 'mini', DUTY_PUSH_KEY: KEY });
  check('M27', 'mini 但沒設店代碼 → wb_no_key', m2.post(signed(m2, APV({ base_ver: m2.ver('E01') }))).error, 'wb_no_key');
  const m3 = world({ DUTY_AUTH: 'mni', DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: STORE });
  check('M28', 'DUTY_AUTH 填錯值（mni）＝當 mini（保護性）', m3.post(APV()).error, 'moved_to_mini');
  for (const val of ['', 'google', 'GOOGLE', ' off ']) {
    const mg = world({ DUTY_AUTH: val });
    check('M29[' + JSON.stringify(val) + ']', 'DUTY_AUTH=' + JSON.stringify(val) + '＝現行（沒簽名照常核定）', mg.post(APV()).ok, true);
  }
}

console.log('\n══ 四、LINE 送申請不受 DUTY_AUTH 影響 ══');
{
  const m = world(MINI);
  const r = m.post({ action: 'req_submit', id_token: 'TOK_U1', kind: 'leave', leave_type: '事假', date: '2026-11-20', hours: 8, reason: '家裡有事' });
  check('S1', 'mini 模式：LINE req_submit 照常送出', [r.ok, r.error, r.request && r.request.status], [true, undefined, 'pending']);
}

console.log('\n══ 五、現行模式（DUTY_AUTH 沒設）帶簽名 ══');
{
  const m = world({ DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: STORE });
  const v = m.ver('E01');
  const a = m.post(signed(m, APV({ base_ver: v })));
  const b = m.post(signed(m, APV({ base_ver: v })));
  check('G1', '簽名合格 → 照常核定＋同 wb_id 防重', [a.ok, b.ok, b.dup], [true, true, true]);
  const bad = signed(m, APV({ emp_id: 'E02', wb_id: 'wb-g-0002' })); bad.wb_sig = '0'.repeat(64);
  check('G2', '簽名不合格 → 當沒帶（照以前核定，不防重）', [m.post(bad).ok, m.sb.dutyWbGet_('wb-g-0002')], [true, null]);
}
done();
