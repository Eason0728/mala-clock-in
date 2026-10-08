// 2026-10-09 Eason：「薪資明細」可看歷月；「出勤紀錄」可看本月與上個月（LineHub.gs）
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(walk); } })(o); return out; };
const buttons = (card) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'button') out.push(x.action); Object.values(x).forEach(walk); } })(card.contents.footer || {}); return out; };

const PAY = { ok: true, ready: true, payday: '5', result: { total_hours: 160, gross: 30000, deduction: 1000, net: 29000,
  earn: [{ item_key: 'base', item_label: '底薪', amount: 30000 }], ded: [{ item_key: 'labor', item_label: '勞保自付', amount: 1000 }] } };
function make(opts) {
  const replies = [], calls = { buildRecentDays: [] };
  const sb = { console, JSON, Math, String, Number, Date, Object, Array, parseInt, isFinite,
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    Utilities: { formatDate: () => opts.today },
    currentYmTaipei: () => opts.today.slice(0, 7),
    prevYm: (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 1 ? (y - 1) + '-12' : y + '-' + ('0' + (m - 1)).slice(-2); },
    payStore: (v) => String(v || ''),
    payRead: (k) => k === 'master' ? [{ emp_id: 'E1', store: '' }] : (opts.runs || []),
    payMyPayslipFor_: (me, st, ym) => {
      const r = (opts.runs || []).find(x => x.ym === ym && x.status === 'final');
      return r ? Object.assign({ ym }, PAY) : { ok: true, ym, ready: false, message: '本月薪資尚未結算' };
    },
    normCellTs: (v) => v,
    buildLatestApprovedMap: () => ({}),
    monthlyApprovedTotal: (amap, emp, ym) => (opts.monthHours || {})[ym] || 0,
    buildRecentDays: (ev, emp, end) => { calls.buildRecentDays.push(end); return (opts.days || []).filter(d => d.date <= end); },
  };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  sb.lineHubPayPick_ = () => (opts.noPick ? null : { me: { emp_id: 'E1', name: '甲' }, store: '' });
  sb.lineHubMine_ = () => (opts.noBind ? [] : [{ st: { code: '', name: '小辛辣 新竹光復' }, row: { emp_id: 'E1' } }]);
  sb.lineHubSS_ = () => ({});
  sb.lineHubSheetRows_ = () => [];
  return { sb, calls };
}
const run = (ym, status) => ({ emp_id: 'E1', store: '', ym, status: status || 'final' });

// ── 薪資明細 ──
ok('預設給最新已定案月份（不是本月「尚未結算」），並說明本月還沒定案；其他已定案月份做成按鈕', () => {
  const { sb } = make({ today: '2026-10-09', runs: [run('2026-10', 'draft'), run('2026-09'), run('2026-08'), run('2026-07')] });
  const c = sb.lineHubPayCard_('U1');
  assert.strictEqual(c.type, 'flex');
  assert(texts(c).includes('9 月薪資'), texts(c));
  assert(texts(c).some(t => /10 月薪資還沒定案/.test(t)));
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['薪資明細 2026-08', '薪資明細 2026-07']);
  assert.deepStrictEqual(buttons(c).map(b => b.label), ['8 月', '7 月']);
});
ok('「薪資明細 2026-08」→ 8 月那張；按鈕列出其他月份（不含自己）、不加「本月未定案」那句', () => {
  const { sb } = make({ today: '2026-10-09', runs: [run('2026-09'), run('2026-08')] });
  const c = sb.lineHubPayCard_('U1', '2026-08');
  assert(texts(c).includes('8 月薪資'));
  assert(!texts(c).some(t => /還沒定案/.test(t)));
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['薪資明細 2026-09']);
  assert(!/\d{3}/.test(c.altText.replace(/\d+ 月/, '')), '推播預覽不露金額：' + c.altText);
});
ok('要看沒定案或太舊的月份 → 提示卡＋可選月份按鈕；跨年月份標年份', () => {
  const { sb } = make({ today: '2026-01-09', runs: [run('2025-12'), run('2025-11')] });
  const c = sb.lineHubPayCard_('U1', '2026-01');
  assert(texts(c).some(t => /還沒定案/.test(t)));
  assert.deepStrictEqual(buttons(c).map(b => b.label), ['2025/12', '2025/11']);
});
ok('一個月都還沒定案 → 本月「尚未定案」提示卡，沒有按鈕', () => {
  const { sb } = make({ today: '2026-10-09', runs: [run('2026-10', 'draft')] });
  const c = sb.lineHubPayCard_('U1');
  assert(texts(c).some(t => /還沒有已定案的薪資單/.test(t)));
  assert.strictEqual(c.contents.footer, undefined);
});
ok('最多列 12 個月；別人的、別店的、重複的 run 不算', () => {
  const runs = [];
  for (let m = 1; m <= 12; m++) runs.push(run('2025-' + ('0' + m).slice(-2)));
  runs.push(run('2026-01'), run('2026-02'), { emp_id: 'E2', store: '', ym: '2026-03', status: 'final' }, { emp_id: 'E1', store: 'cf', ym: '2026-03', status: 'final' }, run('2026-02'));
  const { sb } = make({ today: '2026-03-09', runs });
  const months = sb.lineHubPayFinalMonths_({ me: { emp_id: 'E1' }, store: '' });
  assert.strictEqual(months.length, 12); assert.strictEqual(months[0], '2026-02'); assert(!months.includes('2026-03'));
  const c = sb.lineHubPayCard_('U1');
  assert.strictEqual(buttons(c).length, 11);
  assert(JSON.stringify(c).length < 28000);
});
ok('按鈕每列 3 顆、標準高度（避免誤按）', () => {
  const { sb } = make({ today: '2026-10-09', runs: ['09', '08', '07', '06', '05'].map(m => run('2026-' + m)) });
  const c = sb.lineHubPayCard_('U1');
  const rows = c.contents.footer.contents.filter(x => x.type === 'box');
  assert.strictEqual(rows.length, 2);
  rows.forEach(r => { assert.strictEqual(r.contents.length, 3); r.contents.filter(b => b.type === 'button').forEach(b => assert.strictEqual(b.height, 'md')); });
});
ok('沒接薪資／沒綁定 → 原本的提示卡', () => {
  assert(texts(make({ today: '2026-10-09', noPick: true }).sb.lineHubPayCard_('U1')).some(t => /薪資系統/.test(t)));
  assert(texts(make({ today: '2026-10-09', noPick: true, noBind: true }).sb.lineHubPayCard_('U1')).some(t => /還沒綁定/.test(t)));
});

// ── 出勤紀錄 ──
const day = (date, approved) => ({ date, segments: [{ in: '08:30', out: '17:30' }], approved: approved === undefined ? 8 : approved, approved_status: '正常' });
ok('「出勤紀錄 上個月」→ 用月底當終點（40 天視窗才涵蓋整個月），只列那個月、核定合計', () => {
  const days = [day('2026-08-31'), day('2026-09-01'), day('2026-09-30', null), day('2026-10-01')];
  const { sb, calls } = make({ today: '2026-10-09', days, monthHours: { '2026-09': 8 } });
  const c = sb.lineHubAttendanceMonthCard_('U1', '2026-09');
  assert.deepStrictEqual(calls.buildRecentDays, ['2026-09-30']);
  const t = texts(c).join('\n');
  assert(/9\/1（二）/.test(t) && /9\/30/.test(t) && !/8\/31|10\/1/.test(t), t);
  assert(/8 小時/.test(t) && /尚有 1 天待核定/.test(t), t);
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['出勤紀錄', '出勤紀錄 2026-10']);
});
ok('「出勤紀錄 本月」→ 用今天當終點；今天沒核定不算待核定', () => {
  const { sb, calls } = make({ today: '2026-10-09', days: [day('2026-10-08', null), day('2026-10-09', null)] });
  const c = sb.lineHubAttendanceMonthCard_('U1', '2026-10');
  assert.deepStrictEqual(calls.buildRecentDays, ['2026-10-09']);
  assert(/尚有 1 天待核定/.test(texts(c).join('\n')));
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['出勤紀錄', '出勤紀錄 2026-09']);
});
ok('前兩個月以前 → 只能查本月與上個月的提示，三顆按鈕都給', () => {
  const { sb, calls } = make({ today: '2026-10-09' });
  const c = sb.lineHubAttendanceMonthCard_('U1', '2026-08');
  assert(texts(c).some(t => /本月和上個月/.test(t)));
  assert.strictEqual(calls.buildRecentDays.length, 0);
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['出勤紀錄', '出勤紀錄 2026-10', '出勤紀錄 2026-09']);
});
ok('一月查上個月＝去年 12 月', () => {
  const { sb, calls } = make({ today: '2026-01-05', days: [day('2025-12-31')] });
  const c = sb.lineHubAttendanceMonthCard_('U1', '2025-12');
  assert.deepStrictEqual(calls.buildRecentDays, ['2025-12-31']);
  assert(/12\/31/.test(texts(c).join('\n')));
});
ok('整個月 31 天都有兩段打卡＋異常狀態 → 卡片仍在 LINE 上限內（超過才退文字版）', () => {
  const days = [];
  for (let d = 1; d <= 31; d++) days.push({ date: '2026-08-' + ('0' + d).slice(-2), segments: [{ in: '08:30', out: '12:00' }, { in: '13:00', out: '21:30' }], approved: 11.5, approved_status: '遲到2分、早退5分' });
  const { sb } = make({ today: '2026-09-09', days });
  const c = sb.lineHubAttendanceMonthCard_('U1', '2026-08');
  assert.strictEqual(typeof c, 'object', '31 天不應退成文字');
  assert(JSON.stringify(c).length < 28000, JSON.stringify(c).length);
  assert(texts(c).every(x => typeof x === 'string' && x.length > 0));
});
ok('「出勤紀錄」（最近 7 天）底下有本月／上月按鈕', () => {
  const { sb } = make({ today: '2026-10-09', days: [] });
  sb.lineHubAttendanceData_ = () => ({ lines: [], tot: null });
  sb.lineHubAttendanceText_ = () => 'x';
  const c = sb.lineHubAttendanceCard_('U1');
  assert.deepStrictEqual(buttons(c).map(b => b.text), ['出勤紀錄 2026-10', '出勤紀錄 2026-09']);
});
ok('沒綁定 → 還沒綁定提示', () => {
  const { sb } = make({ today: '2026-10-09', noBind: true });
  assert(texts(sb.lineHubAttendanceMonthCard_('U1', '2026-10')).some(t => /還沒綁定/.test(t)));
});
console.log(`\n${n} 項全部通過`);
