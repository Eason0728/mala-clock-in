// 方案 A：LINE 申請 req_submit／req_cancel 的 mini 簽名寫回（2026-11-21，Eason 定案四題全照推薦；契約 docs/contract-writeback.md 第 10 節）
// 設計稿第 7 節的 12 組權限對照（L01–L12）＋直接打外部入口嘗試冒名（X01–X08）＋光復店／特休／題 3 細節（G01–G05）。
// 店設定模擬「非光復店」（金山）：CONFIG.PAYROLL_API／PAYROLL_STORE 有填、沒有載入 LineHub.gs。
'use strict';
const crypto = require('crypto');
const { make, T, check, done } = require('./helpers/gs-sandbox');

const KEY = 'k'.repeat(32), STORE = 'mztjs', HUB = 'https://hub.test/exec';
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const YOU = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
const GONE = { emp_id: 'E03', name: '測試三', key: 'K3', active: 'FALSE', line_user_id: 'U3' };
const NOLINE = { emp_id: 'E04', name: '測試四', key: 'K4', active: 'TRUE', line_user_id: '' };
const D = '2026-11-16';
const GOOGLE = { DUTY_PUSH_KEY: KEY, DUTY_PUSH_STORE: STORE };
const MINI = Object.assign({ DUTY_AUTH: 'mini' }, GOOGLE);
const LV = { kind: 'leave', leave_type: '事假', hours: 8, reason: '家裡有事', date: D };

/** hub：{ locked（id_token 那條）, lockOnly（主管金鑰那條；'down'＝連不上）, annualFrom } */
function world(props, hub) {
  hub = Object.assign({ locked: false, lockOnly: false, annualFrom: '' }, hub || {});
  const calls = [];
  const m = make({ now: T('2026-11-17T10:00:00'), props: Object.assign({ REQ_SEG2_KINDS: 'ot,leave,trip' }, props || {}),
    config: { PAYROLL_API: HUB, PAYROLL_STORE: 'MZTJS' }, self: { roster: [ME, YOU, GONE, NOLINE], events: [] },
    fetch: (url, opt) => {
      let b = null; try { b = JSON.parse(opt.payload); } catch (e) { return undefined; }   // LINE 驗證（表單參數）交給沙盒預設
      if (!b || url !== HUB) return undefined;
      calls.push(b);
      if (b.action === 'line_hub_pay_lock') return b.id_token === 'TOK_U1' || b.id_token === 'TOK_U2' ? { ok: true, store: 'MZTJS', ym: b.ym, locked: hub.locked } : { ok: false, error: 'invalid_id_token' };
      if (b.action === 'line_hub_req_quota') { if (hub.quotaDown) throw new Error('連不上'); }
      if (b.action === 'line_hub_req_quota') return b.id_token ? { ok: true, quota: [], annual_from: /^\d{4}-/.test(hub.annualFrom) ? hub.annualFrom : '' } : { ok: false, error: 'invalid_id_token' };
      if (b.action === 'payroll_leave_options' && b.lock_only === true) {
        if (hub.lockOnly === 'down') throw new Error('連不上');
        if (b.mgr_key !== 'AK') return { ok: false, error: 'unauthorized' };
        return { ok: true, store: 'MZTJS', ym: b.ym, lock_only: true, locked: hub.lockOnly };
      }
      if (b.action === 'payroll_annual_from') {   // annualFrom：'down'＝連不上、'err'＝ok:false、'bad'＝ok 但沒給 annual_from、'junk'＝給的不是日期
        if (hub.annualFrom === 'down') throw new Error('連不上');
        if (hub.annualFrom === 'err') return { ok: false, error: 'unauthorized' };
        if (hub.annualFrom === 'bad') return { ok: true };
        if (hub.annualFrom === 'junk') return { ok: true, annual_from: '不是日期' };
        return { ok: true, annual_from: hub.annualFrom };
      }
      return { ok: false, error: 'unknown' };
    } });
  m.sb.console = { log: () => {}, warn: () => {}, info: () => {}, error: () => {} };
  m.calls = calls; m.hub = hub;
  m.post = (b) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text); };
  m.rows = () => { const sh = m.self.sh.requests; if (!sh) return []; const h = sh.values[0]; return sh.values.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };
  return m;
}
const target = (b) => b.action === 'req_submit' ? [b.emp_id, b.req_id, b.kind, b.date].join('|') : b.emp_id + '|' + b.id;
const sign = (b, opt) => crypto.createHmac('sha256', (opt && opt.key) || KEY).update(['wb', '1', (opt && opt.store) || STORE, b.action, b.wb_id, String(b.wb_ts), target(b)].join('|'), 'utf8').digest('hex');
/** 營運系統會送的樣子：原本那份＋單號＋工號＋代管主管金鑰＋簽名（id_token 視情況） */
function wbSubmit(m, rid, extra, opt) {
  const b = Object.assign({ action: 'req_submit', mgr_key: 'AK', req_id: rid, emp_id: 'E01' }, LV, extra || {});
  b.wb_id = (opt && opt.wbId) || rid; b.wb_ts = (opt && opt.ts) || m.sb.Date.now() + 1000;
  b.wb_sig = sign(b, opt);
  if (opt && opt.after) Object.assign(b, opt.after);   // 簽完才改（模擬被竄改）
  return b;
}
function wbCancel(m, wbId, id, extra) {
  const b = Object.assign({ action: 'req_cancel', mgr_key: 'AK', id: id, emp_id: 'E01', req_id: wbId }, extra || {});
  b.wb_id = wbId; b.wb_ts = m.sb.Date.now() + 1000; b.wb_sig = sign(b);
  return b;
}
const annualCalls = (m) => m.calls.filter((c) => c.action === 'payroll_annual_from').length;
const R = (n) => 'r' + String(n).padStart(16, '0');

console.log('══ 簽名算法（契約第 10.1 節範例）══');
{
  const m = world(MINI);
  const b = { action: 'req_submit', wb_id: R(2), wb_ts: 1763344801000, emp_id: 'E01', req_id: R(2), kind: 'leave', date: '2026-11-16' };
  check('W10', 'Google 端對象欄＋簽名＝契約範例值', [m.sb.dutyWbTarget_('req_submit', b), m.sb.dutyWbTarget_('req_cancel', { emp_id: 'E01', id: 'r9' }), m.sb.dutyWbSign_(m.sb.dutyWbMsg_('mztjs', 'req_submit', b), KEY)],
    ['E01|' + R(2) + '|leave|2026-11-16', 'E01|r9', '15c6b1bd601e0118da8aae622bfb91a0bee04faf24b1c856e7c91704178e4600']);
}

console.log('\n══ 設計稿第 7 節：12 組權限對照 ══');
{
  const m = world(GOOGLE);
  const a = m.post(Object.assign({ action: 'req_submit', id_token: 'TOK_U1', req_id: R(1) }, LV));
  check('L01', '沒帶簽名、token 有效：照以前寫一列（逐字與 main 相同另見 line-wb-same.test.js）', [a.ok, m.rows().length, m.rows()[0].emp_id, m.calls.map((c) => c.action)], [true, 1, 'E01', ['line_hub_pay_lock']]);
}
for (const [id, props] of [['L02', GOOGLE], ['L02m', MINI]]) {
  const m = world(props);
  const r = m.post(wbSubmit(m, R(2)));
  const row = m.rows()[0] || {};
  check(id, '簽名對＋代管主管金鑰對＋工號在職有綁、沒有 token（' + (props.DUTY_AUTH || 'google') + '）：寫一列，編號＝req_id、工號＝簽名工號、名字照名冊',
    [r.ok, r.dup, m.rows().length, row.id, row.emp_id, row.name, row.status, m.calls.map((c) => c.action + (c.lock_only ? ':lock_only' : ''))],
    [true, undefined, 1, R(2), 'E01', '測試一', 'pending', ['payroll_leave_options:lock_only']], r.ok ? '' : r.error + '｜' + r.message);
}
{
  const m = world(MINI);
  const r1 = m.post(wbSubmit(m, R(3), { mgr_key: 'WRONG' }));
  const r2 = m.post(wbSubmit(m, R(3), { mgr_key: 'MK' }));
  const r3 = m.post(wbSubmit(m, R(3), { mgr_key: '' }));
  check('L03', '主管金鑰錯／一般值班主管金鑰（不是營運系統代管）／空白：unauthorized，不寫', [r1.error, r2.error, r3.error, m.rows().length], ['unauthorized', 'unauthorized', 'unauthorized', 0]);
}
{
  const m = world(MINI);
  const old = wbSubmit(m, R(4), null, { ts: m.sb.Date.now() - 11 * 60000 });
  const r1 = m.post(old);
  const r2 = m.post(wbSubmit(m, R(4)));
  const g = world(GOOGLE);
  const r3 = g.post(wbSubmit(g, R(4), null, { ts: g.sb.Date.now() - 11 * 60000 }));
  check('L04', 'wb_ts 是 11 分鐘前：mini 回 wb_ts、不寫；重簽後成功；google 模式當沒帶→沒有 token→invalid_id_token',
    [r1.error, r2.ok, m.rows().length, r3.error, g.rows().length], ['wb_ts', true, 1, 'invalid_id_token', 0]);
}
{
  const m = world(MINI), g = world(GOOGLE);
  const r1 = m.post(wbSubmit(m, R(5), null, { after: { date: '2026-11-15' } }));
  const r2 = g.post(wbSubmit(g, R(5), null, { after: { date: '2026-11-15' } }));
  const r3 = m.post(wbSubmit(m, R(6), null, { after: { emp_id: 'E02' } }));
  check('L05', '簽完把日期／工號改掉：mini＝bad_sig；google＝當沒帶→invalid_id_token；都不寫', [r1.error, r2.error, r3.error, m.rows().length, g.rows().length], ['bad_sig', 'invalid_id_token', 'bad_sig', 0, 0]);
}
{
  const m = world(MINI);
  const r1 = m.post(wbSubmit(m, R(7), { emp_id: 'E03' }));
  const r2 = m.post(wbSubmit(m, R(8), { emp_id: 'E04' }));
  const r3 = m.post(wbSubmit(m, R(9), { emp_id: 'E99' }));
  const r4 = m.post(wbSubmit(m, R(10), { emp_id: '' }));
  check('L06', '工號已離職／沒綁 LINE／名冊沒有／空白：not_bound，不寫', [r1.error, r2.error, r3.error, r4.error, m.rows().length], ['not_bound', 'not_bound', 'not_bound', 'not_bound', 0]);
}
{
  const m = world(MINI);
  const r1 = m.post(wbSubmit(m, R(11), { id_token: 'TOK_U2' }));
  const r2 = m.post(wbSubmit(m, R(12), { id_token: 'TOK_U1' }));
  Object.keys(m.cache).filter((k) => /^rqpl:/.test(k)).forEach((k) => delete m.cache[k]);   // 鎖月暫存清掉，才看得到第三張問的是哪一條
  const r3 = m.post(wbSubmit(m, R(13), { id_token: 'EXPIRED', date: '2026-11-15' }));
  check('L07', '簽名工號 E01、帶 E02 的 token：line_emp_mismatch 不寫；帶自己的 token 照寫（走 id_token 那條問光復）；token 驗不過＝當沒帶照寫（走主管金鑰那條）',
    [r1.error, r2.ok, r3.ok, m.rows().map((x) => x.id), m.calls.map((c) => c.action + (c.lock_only ? ':lock_only' : ''))],
    ['line_emp_mismatch', true, true, [R(12), R(13)], ['line_hub_pay_lock', 'payroll_leave_options:lock_only']], r3.ok ? '' : r3.error + '｜' + r3.message);
}
{
  const m = world(MINI);
  const a = m.post(wbSubmit(m, R(14)));
  const b = m.post(wbSubmit(m, R(14)));
  Object.keys(m.cache).forEach((k) => delete m.cache[k]);
  const c = m.post(wbSubmit(m, R(14)));
  check('L08', '同一個 req_id 重送：dup:true 不多寫；暫存區清掉也一樣（查試算表）', [a.ok, b.ok, b.dup, c.ok, c.dup, m.rows().length], [true, true, true, true, true, 1]);
}
{
  const m = world(MINI);
  const mens = m.post(wbSubmit(m, R(15), { leave_type: '生理假' }));
  const fam = m.post(wbSubmit(m, R(16), { leave_type: '家庭照顧假', date: '2026-11-15' }));
  const sick = m.post(wbSubmit(m, R(17), { leave_type: '病假', date: '2026-11-14' }));
  const segs = m.post(wbSubmit(m, R(18), { leave_type: '生理假', hours: undefined, date: '2026-11-13', segments: [{ start: '10:00', end: '12:00' }, { start: '14:00', end: '16:00' }] }));
  const calls0 = m.calls.length;
  const tok = m.post(wbSubmit(m, R(19), { leave_type: '家庭照顧假', hours: 8, date: '2026-11-12', id_token: 'TOK_U1' }));
  check('L09', '金山、沒有 token：生理假／家庭照顧假／病假（含兩段）＝need_line_token 不寫；帶 token 的家庭照顧假照額度規則判（有問 line_hub_req_quota）',
    [mens.error, fam.error, sick.error, segs.error, tok.ok, m.rows().map((x) => x.id), m.calls.slice(calls0).map((c) => c.action).indexOf('line_hub_req_quota') >= 0],
    ['need_line_token', 'need_line_token', 'need_line_token', 'need_line_token', true, [R(19)], true], tok.ok ? '' : tok.error + '｜' + tok.message);
}
{
  const m = world(MINI, { lockOnly: true });
  const r1 = m.post(wbSubmit(m, R(20), { date: '2026-11-05' }));
  const q = m.calls.filter((c) => c.lock_only)[0] || {};
  const d = world(MINI, { lockOnly: 'down' });
  const r2 = d.post(wbSubmit(d, R(21)));
  check('L10', '金山、沒有 token、11 月已鎖：pay_locked（用代管主管金鑰問 lock_only）；光復查不到＝busy（不可查不到就不擋）',
    [r1.error, q.store, q.ym, q.mgr_key === 'AK', r2.error, m.rows().length, d.rows().length], ['pay_locked', 'MZTJS', '2026-11', true, 'busy', 0, 0]);
}
{
  const m = world(MINI);
  const mine = m.post(Object.assign({ action: 'req_submit', id_token: 'TOK_U1', req_id: R(30) }, LV));
  const yours = m.post(Object.assign({ action: 'req_submit', id_token: 'TOK_U2', req_id: R(31) }, LV, { date: '2026-11-15' }));
  const x = m.post(wbCancel(m, R(32), R(31)));
  const y = m.post(wbCancel(m, R(33), R(30)));
  const z = m.post(wbCancel(m, R(33), R(30)));
  Object.keys(m.cache).filter((k) => /^dwb:/.test(k)).forEach((k) => delete m.cache[k]);
  const w = m.post(wbCancel(m, R(33), R(30)));
  const st = (id) => (m.rows().filter((r) => r.id === id)[0] || {}).status;
  check('L11', '簽名取消別人的單：not_found 不動；取消自己的：cancelled；同 wb_id 重送 dup；記號清掉後重送＝not_pending（營運系統看副本確認）',
    [mine.ok, yours.ok, x.error, st(R(31)), y.ok, st(R(30)), z.dup, w.error], [true, true, 'not_found', 'pending', true, 'cancelled', true, 'not_pending']);
}
{
  const m = world(MINI), g = world(GOOGLE);
  const r1 = m.post(wbSubmit(m, R(40), null, { wbId: R(41) }));
  const r2 = g.post(wbSubmit(g, R(40), null, { wbId: R(41) }));
  check('L12', 'req_submit 的 wb_id ≠ req_id：mini＝bad_wb；google＝當沒帶→invalid_id_token；都不寫', [r1.error, r2.error, m.rows().length, g.rows().length], ['bad_wb', 'invalid_id_token', 0, 0]);
}

console.log('\n══ 直接打外部入口嘗試冒名（「誰送的」只能從簽名包裝進來）══');
{
  const m = world(MINI);
  const fake = { me: { emp_id: 'E02', name: '測試二', active: 'TRUE' }, userId: 'U2', ss: null, tokenless: true, wb: true };
  const r1 = m.post(Object.assign({ action: 'req_submit', req_id: R(50), emp_id: 'E02', mgr_key: 'AK', who: fake, wbWho: fake, me: fake.me, userId: 'U2', tokenless: true }, LV));
  check('X01', '沒帶簽名、塞 who／wbWho／me／userId／emp_id＋代管主管金鑰：照舊要 id_token → invalid_id_token，不寫', [r1.error, m.rows().length], ['invalid_id_token', 0]);
  const r2 = m.post(Object.assign({ action: 'req_submit', id_token: 'TOK_U1', req_id: R(51), emp_id: 'E02', mgr_key: 'AK', wbWho: fake }, LV));
  check('X02', '自己的 token＋寫別人的工號：寫進去的是 token 本人（E01），emp_id 欄位不被採用', [r2.ok, (m.rows()[0] || {}).emp_id], [true, 'E01']);
  const r3 = m.post(wbSubmit(m, R(52), { emp_id: 'E02' }, { key: 'x'.repeat(32) }));
  check('X03', '自己算簽名（金鑰不對）冒 E02：bad_sig，不寫', [r3.error, m.rows().length], ['bad_sig', 1]);
  const r4 = m.post(wbSubmit(m, R(53), { emp_id: 'E02' }, { store: 'gf' }));
  check('X04', '拿別家店的店代碼簽：bad_sig，不寫', [r4.error, m.rows().length], ['bad_sig', 1]);
  const b5 = wbSubmit(m, R(54), { emp_id: 'E02' }); delete b5.mgr_key;
  const r5 = m.post(b5);
  check('X05', '簽名對但沒帶主管金鑰：unauthorized（兩道都要過）', [r5.error, m.rows().length], ['unauthorized', 1]);
  const r6 = m.post(Object.assign({ action: 'req_cancel', id: R(51), emp_id: 'E01', mgr_key: 'AK', wbWho: { me: ME } }));
  check('X06', '沒帶簽名的取消、塞 wbWho：照舊要 id_token → invalid_id_token，那張單不動', [r6.error, (m.rows()[0] || {}).status], ['invalid_id_token', 'pending']);
}
{
  const g = world({});   // 這家店沒設門鈴金鑰（瑞光、文心這種）
  const r = g.post(wbSubmit(g, R(55)));
  const m = world({ DUTY_AUTH: 'mini' });
  const r2 = m.post(wbSubmit(m, R(55)));
  check('X07', '店沒設門鈴金鑰：google 模式當沒帶→invalid_id_token；mini 模式 wb_no_key；都不寫', [r.error, r2.error, g.rows().length, m.rows().length], ['invalid_id_token', 'wb_no_key', 0, 0]);
}
{
  const m = world(MINI);
  const r = m.sb.handleReqSubmit_(Object.assign({ action: 'req_submit', req_id: R(56) }, LV));
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Liff.gs'), 'utf8');
  const routed = [/req_submit: function \(b\) \{ return handleReqSubmit_\(b\); \}/.test(src), /req_cancel: function \(b\) \{ return handleReqCancel_\(b\); \}/.test(src)];
  const calls = (require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8') + require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'DutyFeed.gs'), 'utf8'))
    .match(/handleReq(Submit|Cancel)_\([^)]*,/g) || [];
  check('X08', '路由只傳一個參數（Liff.gs）；兩個參數的呼叫只有入口自己的宣告；直接呼叫不帶第二參數＝照舊要 id_token', [r.error, routed, calls, m.rows().length],
    ['invalid_id_token', [true, true], ['handleReqSubmit_(body,', 'handleReqCancel_(body,'], 0]);
}

console.log('\n══ 其他細節 ══');
{
  const m = world(MINI);
  const seen = [];
  m.sb.lineHubReqQuota_ = (u) => { seen.push(u); return { quota: [{ name: '生理假', cap_h: 24, remain_h: 24, cap_days: 3 }], annual_from: '' }; };
  m.sb.payMonthLocked_ = () => false;
  const r = m.post(wbSubmit(m, R(60), { leave_type: '生理假' }));
  check('G01', '光復店（同專案有額度程式）、沒有 token：不回 need_line_token，額度用名冊上那位的 LINE 帳號直接算（輸入跟現在一樣）', [r.error === 'need_line_token', seen[0], m.calls.filter((c) => c.action === 'payroll_leave_options').length], [false, 'U1', 0]);
}
{
  const m = world(MINI, { annualFrom: '2027-01-01' });
  const r = m.post(wbSubmit(m, R(61), { leave_type: '特休假' }));
  check('G02', '沒有 token 的特休：改問 payroll_annual_from（主管核准同一支），到職未滿半年照擋', [r.error, m.calls.some((c) => c.action === 'payroll_annual_from' && c.emp_id === 'E01' && c.mgr_key === 'AK'), m.calls.some((c) => c.action === 'line_hub_req_quota')], ['annual_not_eligible', true, false]);
}
{
  const m = world(MINI);
  m.post(wbSubmit(m, R(62)));
  const n = m.calls.length;
  m.post(wbSubmit(m, R(63), { date: '2026-11-15' }));
  check('G03', '鎖月結果暫存 60 秒（跟 id_token 那條同一個鍵）：同月第二張不再問光復', m.calls.length - n, 0);
}
{
  const m = world(MINI, { lockOnly: 'down' });
  m.post(wbSubmit(m, R(64)));
  check('G04', '題 3：查不到鎖月時不留「正在寫」記號（下次重送可以重新判）', Object.keys(m.cache).filter((k) => k.indexOf(R(64)) >= 0).length, 0);
}
{
  const m = world(Object.assign({ REQ_SICK_USED_UP: 'off' }, MINI));
  const r = m.post(wbSubmit(m, R(65), { leave_type: '病假' }));
  check('G05', '病假年度用完規則關掉時，病假不需要額度表＝照常寫', [r.ok, r.error], [true, undefined], r.ok ? '' : r.error + '｜' + r.message);
}
{
  // 2026-11-21 暫存鍵納入動作名稱：手機讓「取消」用跟某張「送單」相同的 wb_id，不可被當成送單的重放
  const m = world(MINI);
  const st = (id) => (m.rows().filter((r) => r.id === id)[0] || {}).status;
  const s1 = m.post(wbSubmit(m, R(70)));
  const s1b = m.post(wbSubmit(m, R(70)));
  const c1 = m.post(wbCancel(m, R(70), R(70)));   // wb_id 刻意＝送單的 wb_id（也＝要取消的單號）
  const c1b = m.post(wbCancel(m, R(70), R(70)));
  check('K01', '送單後用同一個 wb_id 送取消：不當重放（真的取消）；同動作同 wb_id 重送仍 dup、不重寫',
    [s1.ok, s1.dup, s1b.dup, s1b.wb_id, c1.ok, c1.dup, st(R(70)), c1b.ok, c1b.dup, m.rows().length], [true, undefined, true, R(70), true, undefined, 'cancelled', true, true, 1]);
  check('K02', '暫存鍵＝dwb:動作:wb_id，送單與取消各一把', Object.keys(m.cache).filter((k) => /^dwb:/.test(k)).sort(), ['dwb:req_cancel:' + R(70), 'dwb:req_submit:' + R(70)]);
  const bad = wbCancel(m, R(70), R(70)); bad.wb_sig = '0'.repeat(64);
  check('K03', '送單後用同一個 wb_id 送取消、簽名不對：照簽名規則擋（bad_sig），不因為暫存命中而回成功', m.post(bad).error, 'bad_sig');
}
{
  // 換版相容：換版前寫的舊格式鍵（dwb:<wb_id>，內含 a）——動作相同才算命中
  const m = world(MINI);
  const put = (k, o) => m.sb.CacheService.getScriptCache().put(k, JSON.stringify(o), 600);
  put('dwb:' + R(71), { state: 'done', a: 'req_submit', res: { ok: true, id: R(71) } });
  const r1 = m.post(wbSubmit(m, R(71)));
  check('K04', '舊格式鍵、動作相同（送單）：仍當重放 dup，不重寫', [r1.ok, r1.dup, m.rows().length], [true, true, 0]);
  const r2 = m.post(wbSubmit(m, R(72)));
  put('dwb:' + R(72), { state: 'done', a: 'req_submit', res: { ok: true } });
  const c2 = m.post(wbCancel(m, R(72), R(72)));
  check('K05', '舊格式鍵、動作不同（暫存是送單、這次是取消）：當沒命中，照規則取消', [r2.ok, c2.ok, c2.dup, (m.rows().filter((r) => r.id === R(72))[0] || {}).status], [true, true, undefined, 'cancelled']);
  // 新鍵內存的動作對不上（雙保險）：當沒命中
  put('dwb:req_cancel:' + R(73), { state: 'done', a: 'req_submit', res: { ok: true } });
  m.post(wbSubmit(m, R(73)));
  const c3 = m.post(wbCancel(m, R(73), R(73)));
  check('K06', '新鍵裡存的 a 跟這次動作不同：當沒命中（取消照常執行）', [c3.ok, c3.dup, (m.rows().filter((r) => r.id === R(73))[0] || {}).status], [true, undefined, 'cancelled']);
}
{
  // 2026-11-21 Eason 定案「特休滿半年查不到時比照鎖月」：簽名路、沒有 token、問光復 payroll_annual_from 問不到 → busy（不寫、不留記號）
  const keys = (m) => Object.keys(m.cache).filter((k) => /^dwb:/.test(k));
  const AN = { leave_type: '特休假' };
  const m = world(MINI, { annualFrom: 'down' });
  const r1 = m.post(wbSubmit(m, R(80), AN));
  check('A01', '沒 token＋特休＋光復連不上：busy、沒寫入、沒留「正在寫」記號', [r1.ok, r1.error, m.rows().length, keys(m)], [false, 'busy', 0, []]);
  m.hub.annualFrom = '2027-01-01';
  const r2 = m.post(wbSubmit(m, R(80), AN));
  check('A02', '光復恢復後同一 wb_id 重送：照判斷——未滿半年擋（annual_not_eligible）、沒寫入', [r2.error, m.rows().length, keys(m)], ['annual_not_eligible', 0, []]);
  m.hub.annualFrom = '2026-01-01';
  const r3 = m.post(wbSubmit(m, R(80), AN));
  check('A03', '光復恢復後同一 wb_id 重送：滿半年收、寫一列', [r3.ok, r3.dup, m.rows().length, keys(m)], [true, undefined, 1, ['dwb:req_submit:' + R(80)]]);
}
for (const [id, v, desc] of [['A04', 'err', 'ok:false'], ['A05', 'bad', 'ok:true 但沒給 annual_from'], ['A06', 'junk', 'annual_from 不是日期']]) {
  const m = world(MINI, { annualFrom: v });
  const r = m.post(wbSubmit(m, R(81), { leave_type: '特休假' }));
  check(id, '光復回應看不懂（' + desc + '）：busy、沒寫入、沒記號', [r.error, m.rows().length, Object.keys(m.cache).filter((k) => /^dwb:/.test(k)).length], ['busy', 0, 0]);
}
{
  const m = world(MINI, { annualFrom: '' });
  const r = m.post(wbSubmit(m, R(82), { leave_type: '特休假' }));
  check('A07', '光復明確回「沒有到職日資料／不適用」（ok:true、annual_from 空）：維持現行＝不擋、寫一列', [r.ok, m.rows().length], [true, 1]);
}
{
  const m = world(MINI, { annualFrom: 'down' });
  const r = m.post(wbSubmit(m, R(83), { leave_type: '事假' }));
  check('A08', '其他假別（事假）不多問光復滿半年：照常寫、payroll_annual_from 一次都沒打', [r.ok, annualCalls(m)], [true, 0]);
}
{
  const m = world(MINI, { annualFrom: 'down' });
  const r = m.post(wbSubmit(m, R(85), { leave_type: '特休假', hours: undefined, date: '2026-11-13', segments: [{ start: '10:00', end: '12:00' }, { start: '14:00', end: '16:00' }] }));
  check('A09', '多段特休、光復連不上：busy、沒寫入、沒記號', [r.error, m.rows().length, Object.keys(m.cache).filter((k) => /^dwb:/.test(k)).length], ['busy', 0, 0]);
}
{
  // 簽名路有 token：照舊（用 LINE 身分問 line_hub_req_quota，不打 payroll_annual_from；問不到不擋）
  const m = world(MINI, { annualFrom: 'down', quotaDown: true });
  const r = m.post(wbSubmit(m, R(86), { leave_type: '特休假', id_token: 'TOK_U1' }));
  check('A10', '簽名路有 token（驗得過）：照舊走 LINE 身分那條，不打 payroll_annual_from；問不到＝不擋', [r.ok, annualCalls(m), m.rows().length], [true, 0, 1]);
}
{
  // id_token 路（沒帶簽名）：問不到＝不擋（與 main 相同）
  const m = world(GOOGLE, { quotaDown: true });
  const r = m.post(Object.assign({ action: 'req_submit', id_token: 'TOK_U1', req_id: R(87) }, LV, { leave_type: '特休假' }));
  check('A11', 'id_token 路（沒簽名）特休、查不到：照舊不擋（寫一列）', [r.ok, m.rows().length, annualCalls(m)], [true, 1, 0]);
}
done();
