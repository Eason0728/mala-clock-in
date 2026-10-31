// 補休（LineHub.gs；2026-10-09 加，2026-11-01 改每月加減結算＋開放全部門市）：
// ①申請頁開頁資料 comp {allowed, ot_h, used_h, balance_h, ym}——正職就有「補休」假別、不看餘額、不受 LINE_HUB_PAY_STORES 限制
// ②假別額度卡的「本月補休」列（加班 − 補休，欠的標紅）③不再有到期提醒 ④舊制薪資卡兩列補休的數量仍帶 H
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const ROOT = __dirname + '/..';
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
const PAYSRC = fs.readFileSync(ROOT + '/apps-script/Payroll.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(walk); } })(o); return out; };

function make(pay, compFor) {
  const cache = {};
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    Utilities: { formatDate: () => '2026-10-09' },
    pad2: (v) => ('0' + v).slice(-2), payDateStr: (v) => String(v),
    LEAVE_TYPES: ['特休假', '事假', '病假', '生理假', '家庭照顧假', '婚假', '出差'],
  };
  vm.createContext(sb); vm.runInContext(SRC + '\n' + extract(PAYSRC, 'payDayBefore'), sb);
  sb.lineHubMine_ = () => [{ st: { code: 'MZTJS', name: '墨竹亭 金山店' }, row: { emp_id: 'MZTJS06', name: '甲君' } }];
  sb.verifyLineIdToken_ = (t) => (t ? 'U1' : null);
  sb.lineHubThrottled_ = () => false;
  sb.lineHubPayPick_ = () => null;   // 金山不在 LINE_HUB_PAY_STORES：假別額度、薪資卡不開放
  sb.payLeaveTypes = () => sb.LEAVE_TYPES.map((x) => ({ name: x })).concat([{ name: '補休' }]);
  sb.lineHubPayslipFor_ = () => pay;
  sb.lineHubCompFor_ = compFor || (() => ({ allowed: false }));
  return sb;
}
const FT = { allowed: true, ot_h: 6, used_h: 2, balance_h: 4, ym: '2026-11' };

ok('申請頁開頁：正職（金山，不在 LINE 薪資開放名單）→ comp 是本月補休帳、「補休」放進常用假別', () => {
  const r = make(null, () => FT).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(JSON.stringify(r.comp), JSON.stringify({ allowed: true, ot_h: 6, used_h: 2, balance_h: 4, ym: '2026-11' }));
  assert(r.leave_types.common.indexOf('補休') >= 0, JSON.stringify(r.leave_types));
  assert(r.leave_types.special.indexOf('補休') < 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.quota)), []);   // 假別額度仍只開放光復、央廚
});
ok('申請頁開頁：正職本月沒加班也是負的 → 照樣有「補休」（先休後補）；計時 → 沒有', () => {
  let r = make(null, () => ({ allowed: true, ot_h: 0, used_h: 8, balance_h: -8, ym: '2026-11' })).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(r.comp.balance_h, -8); assert(r.leave_types.common.indexOf('補休') >= 0);
  r = make(null, () => ({ allowed: false, ot_h: 0, used_h: 0, balance_h: 0 })).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(r.comp.allowed, false); assert(r.leave_types.common.indexOf('補休') < 0);
});
ok('申請頁開頁：補休帳算不出來（拋例外）→ 不開補休，申請頁照常', () => {
  const r = make(null, () => { throw new Error('讀不到'); }).handleLineHubReqInit_({ id_token: 't' });
  assert(r.ok); assert.strictEqual(r.comp.allowed, false); assert(r.leave_types.common.indexOf('補休') < 0);
});
ok('lineHubCompFor_：不看 LINE_HUB_PAY_STORES——金山正職也算得到；沒有主檔＝不開放', () => {
  const sb = make(null);
  vm.runInContext(extract(SRC, 'lineHubCompFor_'), sb);
  sb.lineHubPayPickAny_ = () => ({ me: { emp_id: 'MZTJS06', name: '甲君' }, store: 'MZTJS' });
  sb.payStore = (v) => String(v || 'SSLGF'); sb.payCompToday = () => '2026-11-03';
  let master = [{ emp_id: 'MZTJS06', name: '甲君', store: 'MZTJS', is_full_time: true }];
  sb.payRead = () => master;
  sb.payCompMonthBook = (ym) => ({ forEmp: (e, st) => ({ allowed: true, ym: ym, st: st, emp: e.emp_id }) });
  const c = sb.lineHubCompFor_('U1');
  assert.strictEqual(c.ym, '2026-11'); assert.strictEqual(c.st, 'MZTJS'); assert.strictEqual(c.emp, 'MZTJS06');
  master = [];
  assert.strictEqual(sb.lineHubCompFor_('U1').allowed, false);
  sb.lineHubPayPickAny_ = () => null;
  assert.strictEqual(sb.lineHubCompFor_('U1').allowed, false);
});
ok('lineHubPayPickFresh_：any＝true 時不套開放名單，否則照舊只回光復、央廚', () => {
  const sb = make(null);
  sb.payStoreList = () => [{ code: 'MZTJS' }];
  sb.payClockRead = () => [{ emp_id: 'MZTJS06', name: '甲君', line_user_id: 'U1', active: 'TRUE' }];
  sb.lineHubCanView_ = () => true;
  sb.payRead = () => [{ emp_id: 'MZTJS06', store: 'MZTJS' }];
  sb.payStore = (v) => String(v || 'SSLGF');
  assert.strictEqual(sb.lineHubPayPickFresh_('U1'), null);
  assert.strictEqual(sb.lineHubPayPickFresh_('U1', true).store, 'MZTJS');
});
ok('假別額度卡：特休下面一列「本月補休 剩 4 小時」＋加班 − 補休；欠的標紅；文字版同步', () => {
  let sb = make({ ok: true, annual: null, leave_quota: [], comp: FT });
  let t = texts(sb.lineHubLeaveCard_('U1'));
  assert(t.indexOf('本月補休') >= 0 && t.indexOf('剩 4 小時') >= 0, JSON.stringify(t));
  assert(t.some((x) => /^加班 6 − 補休 2・每月結算/.test(x)), JSON.stringify(t));
  assert(/・本月補休：加班 6 − 補休 2 ＝ 剩 4 小時/.test(sb.lineHubLeaveText_('U1')));
  sb = make({ ok: true, annual: null, leave_quota: [], comp: { allowed: true, ot_h: 0, used_h: 3, balance_h: -3 } });
  t = texts(sb.lineHubLeaveCard_('U1'));
  assert(t.indexOf('欠 3 小時') >= 0, JSON.stringify(t));
  assert(/欠 3 小時/.test(sb.lineHubLeaveText_('U1')));
});
ok('假別額度卡：計時 → 不出現補休列', () => {
  assert(!texts(make({ ok: true, annual: null, leave_quota: [], comp: { allowed: false, balance_h: 0 } }).lineHubLeaveCard_('U1')).join().includes('補休'));
});
ok('打卡回覆：補休沒有到期日，不再提醒（只剩特休）', () => {
  const sb = make({ ok: true, annual: null, comp: FT });
  assert.strictEqual(typeof sb.lineHubCompNoteText_, 'undefined');
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-09T19:00:00+08:00'), '');
});
ok('薪資卡：舊制的本月換補休／補休到期折算（2026-10 以前若有）數量仍帶 H', () => {
  const sb = make(null);
  assert.strictEqual(sb.lineHubPayLineSub_({ item_key: 'comp_bank', qty: 4, rate: null }), '4H');
  assert.strictEqual(sb.lineHubPayLineSub_({ item_key: 'comp_expire', qty: 3, rate: 240 }), '3H × 240');
});
console.log('\n✅ LINE 補休全部正確 (' + n + '/' + n + ')');
