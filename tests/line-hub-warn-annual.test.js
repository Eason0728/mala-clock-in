// 2026-10-09 Eason（LineHub.gs）：①出勤紀錄的異常（核定狀態＋還沒核定時的忘刷卡註記）紅字給同仁看
// ②假別額度卡第一列放特休、到期日 ③打卡回覆卡片提醒特休快到期（一天最多一次、查薪資壞了不影響）④「出差申請」指令
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
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x); Object.values(x).forEach(walk); } })(o); return out; };

function make(opts) {
  const cache = {};
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite, RegExp,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v, ttl) => { cache[k] = v; cache.__ttl = ttl; }, remove: (k) => { delete cache[k]; } }) },
    // 「今天」固定 2026-10-09；6 天前（出勤紀錄的起點）固定 10/03，不靠真的時鐘
    Utilities: { formatDate: (d) => (Date.now() - d.getTime() > 3 * 86400000 ? '2026-10-03' : (opts.today || '2026-10-09')) },
    currentYmTaipei: () => '2026-10', prevYm: () => '2026-09',
    normCellTs: (v) => v,
    buildLatestApprovedMap: () => ({}),
    monthTotalsFor: () => null, monthlyApprovedTotal: () => 0,
    buildRecentDays: () => opts.days || [],
    pad2: (v) => ('0' + v).slice(-2), payDateStr: (v) => String(v),
  };
  vm.createContext(sb); vm.runInContext(SRC + '\n' + extract(PAYSRC, 'payDayBefore'), sb);
  sb.lineHubMine_ = () => (opts.noBind ? [] : [{ st: { code: '', name: '小辛辣 新竹光復' }, row: { emp_id: 'E1' } }]);
  sb.lineHubSS_ = () => ({});
  sb.lineHubSheetRows_ = () => [];
  sb.__payCalls = 0;
  sb.lineHubPayslipFor_ = () => { sb.__payCalls++; if (opts.payThrows) throw new Error('薪資系統讀不到'); return opts.pay; };
  sb.__cache = cache;
  return sb;
}
const day = (date, o) => Object.assign({ date, segments: [{ in: '10:00', out: '19:00' }], approved: null, approved_status: null, notes: [] }, o);

// ── ① 出勤異常紅字 ──
ok('還沒核定：當天註記（下班忘刷卡／上班忘刷卡）列成紅字；「上班中」不算異常', () => {
  const sb = make({ days: [
    day('2026-10-07', { segments: [{ in: '10:00', out: null }], notes: ['下班忘刷卡'] }),
    day('2026-10-08', { segments: [{ in: null, out: '19:00' }], notes: ['上班忘刷卡'] }),
    day('2026-10-09', { segments: [{ in: '10:00', out: null }], notes: ['上班中'] }),
  ] });
  const card = sb.lineHubAttendanceCard_('U1');
  const red = texts(card.contents.body).filter(t => t.color === '#c22a12').map(t => t.text);
  assert.deepStrictEqual(red, ['小辛辣 新竹光復｜⚠️ 下班忘刷卡', '小辛辣 新竹光復｜⚠️ 上班忘刷卡'], JSON.stringify(red));
  assert(texts(card.contents.body).some(t => t.text === '小辛辣 新竹光復' && t.color === '#8a817a'), '上班中那天維持灰字、不寫上班中');
});
ok('已核定：核定狀態不是「正常」才列（紅字），且不再列打卡註記；「正常」照舊灰字', () => {
  const sb = make({ days: [
    day('2026-10-06', { approved: 8, approved_status: '第一段下班無打卡、第二段上班無打卡', notes: ['下班忘刷卡'] }),
    day('2026-10-07', { approved: 8, approved_status: '正常' }),
  ] });
  const card = sb.lineHubAttendanceCard_('U1');
  const subs = texts(card.contents.body).filter(t => /小辛辣/.test(t.text));
  assert.strictEqual(subs[0].text, '小辛辣 新竹光復｜⚠️ 第一段下班無打卡、第二段上班無打卡'); assert.strictEqual(subs[0].color, '#c22a12');
  assert.strictEqual(subs[1].text, '小辛辣 新竹光復'); assert.strictEqual(subs[1].color, '#8a817a');
});
ok('文字版（卡片太大時的備用）與卡片一致：異常同樣標出', () => {
  const sb = make({ days: [day('2026-10-07', { segments: [{ in: '10:00', out: null }], notes: ['下班忘刷卡'] }), day('2026-10-08', { approved: 9, approved_status: '正常' })] });
  const t = sb.lineHubAttendanceText_('U1');
  assert(/10\/7（三）小辛辣 新竹光復\n　10:00–？｜待核定｜⚠️ 下班忘刷卡/.test(t), t);
  assert(/10\/8（四）小辛辣 新竹光復\n　10:00–19:00｜核定 9h$/m.test(t), t);
});
ok('月份版出勤紀錄同一套：異常紅字', () => {
  const sb = make({ days: [day('2026-10-07', { segments: [{ in: '10:00', out: null }], notes: ['下班忘刷卡'] })] });
  const card = sb.lineHubAttendanceMonthCard_('U1', '2026-10');
  assert(texts(card.contents.body).some(t => t.color === '#c22a12' && /下班忘刷卡/.test(t.text)));
});
ok('卡片 row 的 warn 選項：小字紅色、粗體；沒 warn 維持灰字', () => {
  const sb = make({});
  const r = sb.lineHubFlexRow_('左', '右', { sub: '小字', warn: true });
  const sub = r.contents[0].contents[1];
  assert.strictEqual(sub.color, '#c22a12'); assert.strictEqual(sub.weight, 'bold');
  assert.strictEqual(sb.lineHubFlexRow_('左', '右', { sub: '小字' }).contents[0].contents[1].color, '#8a817a');
});

// ── ② 假別額度卡：特休 ──
const ANNUAL = { days: 7, quota_h: 56, used_h: 16, left_h: 40, ps: '2025-11-01', pe: '2026-11-01', payout_ym: '2026-10' };
ok('假別額度卡第一列＝特休「剩 X 小時」，小字寫總時數與到期日（pe 前一天）', () => {
  const sb = make({ pay: { ok: true, annual: ANNUAL, leave_quota: [{ name: '事假', cap_days: 14, cap_h: 112, remain_h: 104, used_days: 1, used_h: 8, basis: 'calendar' }] } });
  const card = sb.lineHubLeaveCard_('U1');
  const ts = texts(card.contents.body).map(t => t.text);
  assert.strictEqual(ts[0], '特休假'); assert.strictEqual(ts[1], '共 56 小時・10/31 到期（未休完依法折算工資）'); assert.strictEqual(ts[2], '剩 40 小時');
  assert(ts.indexOf('事假') > 0);
  const tx = sb.lineHubLeaveText_('U1');
  assert(/・特休假：剩 40 小時（共 56 小時，10\/31 到期，未休完依法折算工資）\n・事假/.test(tx), tx);
});
ok('正職只有特休（其他假都沒請過）：不再說「沒有需要顯示的假別額度」', () => {
  const sb = make({ pay: { ok: true, annual: ANNUAL, leave_quota: [] } });
  const card = sb.lineHubLeaveCard_('U1');
  assert(!texts(card).some(t => /沒有需要顯示/.test(t.text)));
  assert(texts(card).some(t => t.text === '剩 40 小時'));
  assert(!/沒有需要顯示/.test(sb.lineHubLeaveText_('U1')));
});
ok('計時同仁（沒有特休、沒有額度）：維持原本說明', () => {
  const sb = make({ pay: { ok: true, annual: null, leave_quota: [] } });
  assert(texts(sb.lineHubLeaveCard_('U1')).some(t => /沒有需要顯示的假別額度/.test(t.text)));
});

// ── ③ 打卡回覆的特休到期提醒 ──
ok('特休有剩、最後一天在 30 天內 → 提醒一行；超過 30 天、已過期、沒剩都不提', () => {
  const sb = make({});
  const j = (a) => ({ ok: true, annual: Object.assign({}, ANNUAL, a) });
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({}), '2026-10-09'), '🗓 你的特休還剩 40 小時，10/31 到期，記得跟店長排休');
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({}), '2026-10-01'), '🗓 你的特休還剩 40 小時，10/31 到期，記得跟店長排休');   // 剛好 30 天
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({}), '2026-09-30'), '');   // 31 天
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({}), '2026-11-01'), '');   // 已過最後一天
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({ left_h: 0 }), '2026-10-09'), '');
  assert.strictEqual(sb.lineHubAnnualNoteText_(j({ left_h: -4 }), '2026-10-09'), '');
  assert.strictEqual(sb.lineHubAnnualNoteText_({ ok: true, annual: null }, '2026-10-09'), '');
  assert.strictEqual(sb.lineHubAnnualNoteText_(null, '2026-10-09'), '');
});
ok('打卡回覆卡片：附上提醒；同一人同一天只算一次（第二次不查薪資、不提醒）', () => {
  const sb = make({ pay: { ok: true, annual: ANNUAL } });
  const r = { ok: true, type: 'in', ts: '2026-10-09T10:00:00+08:00', store_name: '小辛辣 新竹光復', greeting: '早安' };
  r.annual_note = sb.lineHubAnnualNote_('U1', r.ts);
  const card = sb.lineHubPunchCard_(r);
  assert(texts(card).some(t => t.text === '🗓 你的特休還剩 40 小時，10/31 到期，記得跟店長排休'));
  assert(/🗓 你的特休還剩/.test(sb.lineHubPunchText_(r)));
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-09T19:00:00+08:00'), '');
  assert.strictEqual(sb.__payCalls, 1);
  assert(sb.__cache['lha:U1:2026-10-09']); assert(sb.__cache.__ttl > 0 && sb.__cache.__ttl <= 21600);
  assert.strictEqual(sb.lineHubAnnualNote_('U2', '2026-10-09T19:00:00+08:00'), '🗓 你的特休還剩 40 小時，10/31 到期，記得跟店長排休');   // 別人照算
});
ok('不用提醒的也記下來（同一天不再查薪資）；查薪資壞了回空字串、打卡回覆照常', () => {
  const sb = make({ pay: { ok: true, annual: Object.assign({}, ANNUAL, { pe: '2027-03-01' }) } });
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-09T10:00:00+08:00'), '');
  sb.lineHubAnnualNote_('U1', '2026-10-09T19:00:00+08:00');
  assert.strictEqual(sb.__payCalls, 1);
  const bad = make({ payThrows: true });
  assert.strictEqual(bad.lineHubAnnualNote_('U1', '2026-10-09T10:00:00+08:00'), '');
});
ok('webhook「打卡」：回覆卡片帶特休提醒；薪資壞掉也照樣回打卡卡片', () => {
  for (const throws of [false, true]) {
    const sb = make({ pay: { ok: true, annual: ANNUAL }, payThrows: throws });
    const sent = [];
    sb.LINE_HUB_BOT_USER_ID = 'BOTU';
    sb.lineHubLoading_ = () => {};
    sb.lineHubThrottled_ = () => false;
    sb.lineHubTakeStash_ = () => ({ ok: true, type: 'out', ts: '2026-10-09T19:00:00+08:00', store_name: '小辛辣 新竹光復', greeting: '辛苦了' });
    sb.lineHubReply_ = (tok, msgs) => sent.push(msgs[0]);
    sb.handleLineWebhook_({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '打卡' } }] });
    assert.strictEqual(sent.length, 1);
    assert(texts(sent[0]).some(t => t.text === '下班打卡成功'), JSON.stringify(texts(sent[0])));
    assert.strictEqual(texts(sent[0]).some(t => /特休還剩/.test(t.text)), !throws);
  }
});

// ── ④ 出差申請指令 ──
ok('打「出差申請」→ 申請卡片，按鈕開 tab=trip；分頁表順序 請假｜加班｜出差｜忘打卡｜我的申請', () => {
  const sb = make({});
  const card = sb.LINE_HUB_TEXT_COMMANDS['出差申請']('U1');
  const btn = card.contents.footer.contents[0].action;
  assert.strictEqual(btn.label, '打開出差'); assert(/\?view=req&tab=trip$/.test(btn.uri), btn.uri);
  assert.deepStrictEqual(Object.keys(sb.LINE_HUB_REQ_TABS), ['leave', 'ot', 'trip', 'miss', 'mine']);
  const reqJs = fs.readFileSync(ROOT + '/req-line.js', 'utf8');
  assert(/\['leave', '請假'\], \['ot', '加班'\], \['trip', '出差'\], \['miss', '忘打卡'\], \['mine', '我的申請'\]/.test(reqJs), '申請頁分頁與機器人一致');
});
console.log(`\n${n} 項全部通過`);
