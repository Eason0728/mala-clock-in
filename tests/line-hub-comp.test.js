// 補休（2026-10-09，LineHub.gs）：①申請頁開頁資料 comp {allowed, balance_h, earliest_expiry}、有餘額才出現「補休」假別
// ②假別額度卡多一列補休（正職、有餘額或有紀錄才出現）③打卡回覆的到期提醒（30 天內、與特休共用一天一次）
// ④薪資卡兩列補休的數量帶 H
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

function make(pay) {
  const cache = {};
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    Utilities: { formatDate: () => '2026-10-09' },
    pad2: (v) => ('0' + v).slice(-2), payDateStr: (v) => String(v),
    LEAVE_TYPES: ['特休假', '事假', '病假', '生理假', '家庭照顧假', '婚假', '出差'],
  };
  vm.createContext(sb); vm.runInContext(SRC + '\n' + extract(PAYSRC, 'payDayBefore'), sb);
  sb.lineHubMine_ = () => [{ st: { code: '', name: '小辛辣 新竹光復' }, row: { emp_id: 'E1', name: '甲君' } }];
  sb.verifyLineIdToken_ = (t) => (t ? 'U1' : null);
  sb.lineHubThrottled_ = () => false;
  sb.lineHubPayPick_ = () => ({ me: { emp_id: 'E1', name: '甲君' }, store: 'SSLGF' });
  sb.payLeaveTypes = () => sb.LEAVE_TYPES.map((x) => ({ name: x })).concat([{ name: '補休' }]);
  sb.lineHubPayslipFor_ = () => pay;
  return sb;
}
const FT = { allowed: true, balance_h: 6.5, earliest_expiry: '2026-11-01', history: true };

ok('申請頁開頁：正職有餘額 → comp 回傳、「補休」放進常用假別', () => {
  const r = make({ ok: true, leave_quota: [], comp: FT }).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(JSON.stringify(r.comp), JSON.stringify({ allowed: true, balance_h: 6.5, earliest_expiry: '2026-11-01' }));
  assert(r.leave_types.common.indexOf('補休') >= 0, JSON.stringify(r.leave_types));
  assert(r.leave_types.special.indexOf('補休') < 0);
});
ok('申請頁開頁：正職沒餘額 → allowed 但沒有「補休」假別；計時 → allowed false', () => {
  let r = make({ ok: true, leave_quota: [], comp: { allowed: true, balance_h: 0, earliest_expiry: '', history: true } }).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(r.comp.allowed, true); assert(r.leave_types.common.indexOf('補休') < 0);
  r = make({ ok: true, leave_quota: [], comp: { allowed: false, balance_h: 0, earliest_expiry: '', history: false } }).handleLineHubReqInit_({ id_token: 't' });
  assert.strictEqual(r.comp.allowed, false); assert(r.leave_types.common.indexOf('補休') < 0);
});
ok('申請頁開頁：薪資讀不到（j=null）→ comp 預設不開放，申請頁照常', () => {
  const r = make(null).handleLineHubReqInit_({ id_token: 't' });
  assert(r.ok); assert.strictEqual(r.comp.allowed, false);
});
ok('假別額度卡：特休下面多一列「補休 剩 6.5 小時・最早 11/1 到期」；文字版同步', () => {
  const sb = make({ ok: true, annual: null, leave_quota: [], comp: FT });
  const t = texts(sb.lineHubLeaveCard_('U1'));
  assert(t.indexOf('補休') >= 0 && t.indexOf('剩 6.5 小時') >= 0, JSON.stringify(t));
  assert(t.some((x) => /最早 11\/1 到期/.test(x)), JSON.stringify(t));
  assert(/・補休：剩 6\.5 小時（最早 11\/1 到期/.test(sb.lineHubLeaveText_('U1')));
});
ok('假別額度卡：計時、或正職沒餘額也沒紀錄 → 不出現補休列；有紀錄但用完 → 剩 0', () => {
  assert(!texts(make({ ok: true, annual: null, leave_quota: [], comp: { allowed: false, balance_h: 0, history: true } }).lineHubLeaveCard_('U1')).includes('補休'));
  assert(!texts(make({ ok: true, annual: null, leave_quota: [], comp: { allowed: true, balance_h: 0, history: false } }).lineHubLeaveCard_('U1')).includes('補休'));
  const t = texts(make({ ok: true, annual: null, leave_quota: [], comp: { allowed: true, balance_h: 0, earliest_expiry: '', history: true } }).lineHubLeaveCard_('U1'));
  assert(t.includes('補休') && t.includes('剩 0 小時') && t.includes('目前沒有可休的補休'), JSON.stringify(t));
});
ok('打卡回覆到期提醒：最早一批 30 天內到期才提，與特休共用一天一次', () => {
  const sb = make({ ok: true, annual: null, comp: FT });
  assert.strictEqual(sb.lineHubCompNoteText_({ ok: true, comp: FT }, '2026-10-09'), '🗓 你的補休還剩 6.5 小時，最早一批 11/1 到期（沒休完會照加班費折算），記得跟店長排休');
  assert.strictEqual(sb.lineHubCompNoteText_({ ok: true, comp: Object.assign({}, FT, { earliest_expiry: '2026-12-01' }) }, '2026-10-09'), '');
  assert.strictEqual(sb.lineHubCompNoteText_({ ok: true, comp: Object.assign({}, FT, { allowed: false }) }, '2026-10-09'), '');
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-09T19:00:00+08:00').indexOf('🗓 你的補休'), 0);
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-09T21:00:00+08:00'), '');   // 同一天第二次不提
});
ok('薪資卡：本月換補休／補休到期折算的數量帶 H', () => {
  const sb = make(null);
  assert.strictEqual(sb.lineHubPayLineSub_({ item_key: 'comp_bank', qty: 4, rate: null }), '4H');
  assert.strictEqual(sb.lineHubPayLineSub_({ item_key: 'comp_expire', qty: 3, rate: 240 }), '3H × 240');
});
console.log('\n✅ LINE 補休全部正確 (' + n + '/' + n + ')');
