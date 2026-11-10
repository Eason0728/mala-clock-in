/**
 * 薪酬挑錯第 1 項：已鎖定的月份不能再改工時、獎金、紅字天數（Eason 2026-11-11 確認）。
 *  後端：handlePayrollInputSet／handlePayrollBonusSet 遇到該店該月已鎖定 → {ok:false,error:'locked',message}，資料不動；
 *        拿到寫鎖後再查一次。handlePayrollHolidaySet 只擋「已鎖定月份那一列的 red_days 或 dates 有變動、被刪、或新增」。
 *  前端：payroll.html 的 saveAtt／clearAtt／saveBonus 在 STATUS==='final' 時先擋；後端回失敗時不顯示存檔完成。
 *  沒鎖定、沒算過的月份行為不變。全部虛構同仁（代號 E01／P01），期望值照規則寫死。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load, ftEmp, ptEmp } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const ok = (c, m) => eq(!!c, true, m);
const KEY = 'test-admin-key';
const snap = (o) => JSON.stringify(o);

const run = (ym, store, status, emp) => ({ ym, store, emp_id: emp || 'E01', status, net: 40000 });
const inRow = (ym, store, emp, hours) => ({ ym, emp_id: emp, store, hours, extra_ot: 0, deduct_days: 0, support: '[]', hours_manual: '', updated_at: 'x' });
const bnRow = (ym, store, emp, amount) => ({ ym, store, emp_id: emp, bonus_type: 'sales', label: '業績', amount, memo: '', updated_at: 'x' });
function env(data) {
  const d = Object.assign({ master: [ftEmp(), ptEmp()], config: [], holiday: [], run: [], item: [], input: [], bonus: [], audit: [], store: [] }, data);
  const s = load({ data: d, clock: { SSLGF: { roster: [], approved: [], events: [], leave: [], requests: [] } }, today: '2026-11-10' });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  s.post = (fn, body) => JSON.parse(JSON.stringify(s.call(fn, Object.assign({ admin_key: KEY }, body))));
  return s;
}
const NEW_IN = { E01: { hours: 100, support: [] }, P01: { hours: 5, support: [] } };
const NEW_BN = [{ emp_id: 'E01', bonus_type: 'sales', label: '業績', amount: 5000 }];

/* ── A. 光復 2026-10 已鎖定：工時、獎金都擋，資料不動 ── */
{
  const s = env({
    run: [run('2026-10', 'SSLGF', 'final', 'E01'), run('2026-10', 'SSLGF', 'final', 'P01')],
    input: [inRow('2026-10', 'SSLGF', 'E01', 200), inRow('2026-10', 'SSLGF', 'P01', 120), inRow('2026-10', 'CF', 'C01', 150), inRow('2026-09', 'SSLGF', 'E01', 190)],
    bonus: [bnRow('2026-10', 'SSLGF', 'E01', 1000), bnRow('2026-10', 'CF', 'C01', 700)],
  });
  const in0 = snap(s.__DATA.input), bn0 = snap(s.__DATA.bonus);
  let r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'SSLGF', inputs: NEW_IN });
  eq([r.ok, r.error], [false, 'locked'], 'A1 已鎖定月份「儲存工時」→ locked');
  ok(/^2026-10 已鎖定，請先解鎖再修改/.test(String(r.message || '')), 'A1 訊息開頭是「2026-10 已鎖定，請先解鎖再修改」');
  eq(snap(s.__DATA.input), in0, 'A1 工時表沒被動');
  r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'SSLGF', inputs: {} });
  eq([r.ok, r.error], [false, 'locked'], 'A2 已鎖定月份「清除本月手動工時」→ locked');
  eq(snap(s.__DATA.input), in0, 'A2 工時表沒被動');
  r = s.post('handlePayrollBonusSet', { ym: '2026-10', store: 'SSLGF', bonuses: NEW_BN });
  eq([r.ok, r.error], [false, 'locked'], 'A3 已鎖定月份「儲存獎金」→ locked');
  ok(/^2026-10 已鎖定，請先解鎖再修改/.test(String(r.message || '')), 'A3 訊息開頭是「2026-10 已鎖定，請先解鎖再修改」');
  eq(snap(s.__DATA.bonus), bn0, 'A3 獎金表沒被動');
  // 不帶 store＝預設店（光復）也一樣被擋
  r = s.post('handlePayrollInputSet', { ym: '2026-10', inputs: NEW_IN });
  eq([r.ok, r.error], [false, 'locked'], 'A4 不帶門市（預設光復）→ locked');
  eq(snap(s.__DATA.input), in0, 'A4 工時表沒被動');

  /* ── B. 同一份資料：別店、別月沒鎖定 → 照舊可存 ── */
  r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'CF', inputs: { C01: { hours: 160, support: [] } } });
  eq([r.ok, r.count], [true, 1], 'B1 光復鎖定不擋央廚同月存工時');
  eq(s.__DATA.input.filter(x => x.ym === '2026-10' && x.store === 'CF').map(x => [x.emp_id, x.hours]), [['C01', 160]], 'B1 央廚 10 月工時改成 160');
  eq(s.__DATA.input.filter(x => x.ym === '2026-10' && x.store === 'SSLGF').map(x => [x.emp_id, x.hours]), [['E01', 200], ['P01', 120]], 'B1 光復 10 月工時原樣');
  r = s.post('handlePayrollInputSet', { ym: '2026-09', store: 'SSLGF', inputs: { E01: { hours: 180, support: [] } } });
  eq([r.ok, r.count], [true, 1], 'B2 光復 10 月鎖定不擋光復 9 月（沒算過）存工時');
  eq(s.__DATA.input.filter(x => x.ym === '2026-09').map(x => [x.emp_id, x.hours]), [['E01', 180]], 'B2 光復 9 月工時改成 180');
  r = s.post('handlePayrollBonusSet', { ym: '2026-10', store: 'CF', bonuses: [{ emp_id: 'C01', bonus_type: 'sales', label: '業績', amount: 900 }] });
  eq([r.ok, r.count], [true, 1], 'B3 光復鎖定不擋央廚同月存獎金');
  eq(s.__DATA.bonus.map(x => [x.ym, x.store, x.emp_id, x.amount]), [['2026-10', 'SSLGF', 'E01', 1000], ['2026-10', 'CF', 'C01', 900]], 'B3 獎金表：光復原樣、央廚改 900');
}

/* ── C. 草稿月份（算過但沒鎖定）行為不變 ── */
{
  const s = env({ run: [run('2026-10', 'SSLGF', 'draft', 'E01')], input: [inRow('2026-10', 'SSLGF', 'E01', 200)], bonus: [] });
  let r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'SSLGF', inputs: NEW_IN });
  eq([r.ok, r.ym, r.store, r.count], [true, '2026-10', 'SSLGF', 2], 'C1 草稿月份存工時 → ok、2 人');
  eq(s.__DATA.input.map(x => [x.emp_id, x.hours]), [['E01', 100], ['P01', 5]], 'C1 工時表改成 100／5');
  r = s.post('handlePayrollBonusSet', { ym: '2026-10', store: 'SSLGF', bonuses: NEW_BN });
  eq([r.ok, r.ym, r.store, r.count], [true, '2026-10', 'SSLGF', 1], 'C2 草稿月份存獎金 → ok、1 筆');
  eq(s.__DATA.bonus.map(x => [x.emp_id, x.amount]), [['E01', 5000]], 'C2 獎金表寫入 5000');
  r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'SSLGF', inputs: {} });
  eq([r.ok, r.count], [true, 0], 'C3 草稿月份清除手動工時 → ok、0 人');
  eq(s.__DATA.input.length, 0, 'C3 工時表清空');
}

/* ── D. 鎖外查完、拿到寫鎖之前被別人鎖定 → 鎖內再查一次，資料不動 ── */
{
  const mk = () => {
    const s = env({ run: [run('2026-10', 'SSLGF', 'draft', 'E01')], input: [inRow('2026-10', 'SSLGF', 'E01', 200)], bonus: [bnRow('2026-10', 'SSLGF', 'E01', 1000)] });
    vm.runInContext(`payWriteLocked_ = function (kinds, fn) { __DATA.run.forEach(function (r) { r.status = 'final'; }); fn(); return true; };`, s);
    return s;
  };
  let s = mk(); const in0 = snap(s.__DATA.input);
  let r = s.post('handlePayrollInputSet', { ym: '2026-10', store: 'SSLGF', inputs: NEW_IN });
  eq([r.ok, r.error], [false, 'locked'], 'D1 等寫鎖期間被鎖定：存工時 → locked');
  eq(snap(s.__DATA.input), in0, 'D1 工時表沒被動');
  s = mk(); const bn0 = snap(s.__DATA.bonus);
  r = s.post('handlePayrollBonusSet', { ym: '2026-10', store: 'SSLGF', bonuses: NEW_BN });
  eq([r.ok, r.error], [false, 'locked'], 'D2 等寫鎖期間被鎖定：存獎金 → locked');
  eq(snap(s.__DATA.bonus), bn0, 'D2 獎金表沒被動');
}

/* ── E. 紅字天數：只擋已鎖定月份那一列的 red_days／dates 變動、被刪、新增 ── */
{
  const HOL = () => [
    { ym: '2026-10', red_days: 8, note: '', dates: '2026-10-10', store: '' },
    { ym: '2026-11', red_days: 10, note: '', dates: '', store: '' },
    { ym: '2026-10', red_days: 9, note: '', dates: '2026-10-10', store: 'CF' },
  ];
  // 光復 10 月已鎖定（用集團共用列）、央廚 10 月已鎖定（有專屬列）、金山 11 月草稿
  const RUN = () => [run('2026-10', 'SSLGF', 'final'), run('2026-10', 'CF', 'final', 'C01'), run('2026-11', 'MZTJS', 'draft', 'J01')];
  const G10 = { ym: '2026-10', red_days: 8, note: '', dates: '2026-10-10' }, G11 = { ym: '2026-11', red_days: 10, note: '', dates: '' };
  const blocked = (label, body, runs) => {
    const s = env({ holiday: HOL(), run: runs || RUN() }); const h0 = snap(s.__DATA.holiday);
    const r = s.post('handlePayrollHolidaySet', body);
    eq([r.ok, r.error], [false, 'locked'], label + ' → locked');
    ok(/^2026-10 已鎖定，請先解鎖再修改/.test(String(r.message || '')), label + '：訊息開頭是「2026-10 已鎖定，請先解鎖再修改」');
    eq(snap(s.__DATA.holiday), h0, label + '：紅字天數表沒被動');
  };
  blocked('E1 光復新增 10 月專屬列（12 天）', { store: 'SSLGF', holidays: [{ ym: '2026-10', red_days: 12, note: '', dates: '' }] });
  blocked('E2 集團共用列 10 月 8→9 天', { store: '', holidays: [Object.assign({}, G10, { red_days: 9 }), G11] });
  blocked('E3 集團共用列 10 月被刪', { store: '', holidays: [G11] });
  blocked('E4 集團共用列 10 月 dates 多一天', { store: '', holidays: [Object.assign({}, G10, { dates: '2026-10-10,2026-10-25' }), G11] });
  blocked('E5 央廚專屬列 10 月 9→10 天', { store: 'CF', holidays: [{ ym: '2026-10', red_days: 10, note: '', dates: '2026-10-10' }] });
  blocked('E6 央廚專屬列 10 月被刪', { store: 'CF', holidays: [] });

  // E7 鎖定月份那一列不變（只改備註；red_days 以文字 '8' 送來）＋改沒鎖定的 11 月＋新增 12 月 → 照存
  let s = env({ holiday: HOL(), run: RUN() });
  let r = s.post('handlePayrollHolidaySet', { store: '', holidays: [Object.assign({}, G10, { red_days: '8', note: '備註' }), Object.assign({}, G11, { red_days: 11 }), { ym: '2026-12', red_days: 9, note: '', dates: '' }] });
  eq([r.ok, r.count, r.store], [true, 3, ''], 'E7 鎖定月份那列不變、改 11 月＋加 12 月 → ok、3 筆');
  eq(s.__DATA.holiday.map(h => [h.store, h.ym, Number(h.red_days), h.note]),
    [['CF', '2026-10', 9, ''], ['', '2026-10', 8, '備註'], ['', '2026-11', 11, ''], ['', '2026-12', 9, '']], 'E7 紅字天數表內容');
  // E8 央廚專屬列 10 月不變、加沒鎖定的 11 月專屬列 → 照存
  s = env({ holiday: HOL(), run: RUN() });
  r = s.post('handlePayrollHolidaySet', { store: 'CF', holidays: [{ ym: '2026-10', red_days: 9, note: '', dates: '2026-10-10' }, { ym: '2026-11', red_days: 12, note: '', dates: '' }] });
  eq([r.ok, r.count, r.store], [true, 2, 'CF'], 'E8 央廚 10 月專屬列不變、加 11 月專屬列 → ok');
  eq(s.__DATA.holiday.filter(h => h.store === 'CF').map(h => [h.ym, Number(h.red_days)]), [['2026-10', 9], ['2026-11', 12]], 'E8 央廚專屬列內容');
  // E9 10 月只有央廚鎖定，央廚有專屬列 → 改集團共用列 10 月不擋
  s = env({ holiday: HOL(), run: [run('2026-10', 'SSLGF', 'draft'), run('2026-10', 'CF', 'final', 'C01')] });
  r = s.post('handlePayrollHolidaySet', { store: '', holidays: [Object.assign({}, G10, { red_days: 9 }), G11] });
  eq([r.ok, r.count], [true, 2], 'E9 鎖定的店都有專屬列 → 集團共用列可改');
  eq(s.__DATA.holiday.filter(h => h.store === '' && h.ym === '2026-10').map(h => Number(h.red_days)), [9], 'E9 集團共用列 10 月改成 9');
  // E10 光復 10 月鎖定、光復本來沒有專屬列、送空清單（沒有新增）→ 照存
  s = env({ holiday: HOL(), run: RUN() }); const h0 = snap(s.__DATA.holiday);
  r = s.post('handlePayrollHolidaySet', { store: 'SSLGF', holidays: [] });
  eq([r.ok, r.count], [true, 0], 'E10 光復沒有專屬列、送空清單 → ok');
  eq(snap(s.__DATA.holiday), h0, 'E10 紅字天數表內容不變');
  // E11 完全沒有月結資料 → 照舊整批覆寫
  s = env({ holiday: HOL(), run: [] });
  r = s.post('handlePayrollHolidaySet', { store: '', holidays: [Object.assign({}, G10, { red_days: 7 })] });
  eq([r.ok, r.count], [true, 1], 'E11 沒有任何月結 → ok');
  eq(s.__DATA.holiday.map(h => [h.store, h.ym, Number(h.red_days)]), [['CF', '2026-10', 9], ['', '2026-10', 7]], 'E11 集團共用列整批換掉');
}

/* ── F. 前端 payroll.html：saveAtt／clearAtt／saveBonus ── */
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
function fnSrc(name) {   // 抽出一支頂層函式的原文（到下一個頂層宣告之前）
  const m = new RegExp('\\n(async function|function) ' + name + '\\(').exec(HTML);
  if (!m) throw new Error('找不到 ' + name);
  const start = m.index + 1, rest = HTML.slice(start + 10);
  const nx = /\n(async function |function |\/\* ═|let |const )/.exec(rest);
  return HTML.slice(start, start + 10 + nx.index);
}
function page(status, reply) {
  const log = { posts: [], toasts: [], calc: 0, reload: 0, confirms: 0 };
  const btn = { disabled: false, textContent: '儲存', title: '', classList: { add() {}, remove() {} } };
  const ctx = { console, setTimeout: () => 0, btn, log,
    $: () => btn, toast: (t, bad) => log.toasts.push([String(t), !!bad]), confirm: () => { log.confirms++; return true; },
    ym: () => '2026-10', STORE: 'SSLGF', XSUP_FROM: '2026-11', STATUS: status, RESULTS: [1], ATT_DIRTY: true, CFG: {},
    BONUS: [{ emp_id: 'E01', bonus_type: 'sales', label: '業績', amount: 5000 }],
    MASTER: [{ emp_id: 'E01', name: '測試甲' }, { emp_id: 'P01', name: '測試丙' }], ATT: { E01: { hours: 100, support: [] }, P01: { hours: 5, support: [] } },
    supCrossBlock: () => false, scopeLimited: () => false,
    doCalc: async () => { log.calc++; }, loadMonth: async () => { log.reload++; },
    post: async (action, body) => { log.posts.push(action); return reply(action, body); },
  };
  vm.createContext(ctx);
  vm.runInContext('const n=v=>{const x=parseFloat(v);return isNaN(x)?0:x};\n' + ['attSendable', 'saveFX', 'saveAtt', 'clearAtt', 'saveBonus'].map(fnSrc).join('\n')
    + '\nthis.saveAtt=saveAtt;this.clearAtt=clearAtt;this.saveBonus=saveBonus;', ctx);
  return ctx;
}
const lastToast = (p) => p.log.toasts[p.log.toasts.length - 1] || ['', false];
const OKR = (a) => ({ ok: true, ym: '2026-10', store: 'SSLGF', count: a === 'payroll_bonus_set' ? 1 : 2 });
const LOCKR = () => ({ ok: false, error: 'locked', message: '2026-10 已鎖定，請先解鎖再修改' });

(async () => {
  // F1 畫面狀態已鎖定：三顆按鈕都不送出請求、紅字提示、不顯示存檔完成
  for (const [name, runIt] of [['saveAtt', p => p.saveAtt()], ['clearAtt', p => p.clearAtt()], ['saveBonus', p => p.saveBonus(p.btn)]]) {
    const p = page('final', OKR);
    await runIt(p);
    eq(p.log.posts, [], 'F1 ' + name + '：已鎖定時不送出請求');
    eq([/2026-10 已鎖定/.test(lastToast(p)[0]), lastToast(p)[1]], [true, true], 'F1 ' + name + '：紅字提示「2026-10 已鎖定…」');
    eq([p.btn.textContent === '✓ 存檔完成', p.log.calc, p.log.reload], [false, 0, 0], 'F1 ' + name + '：不顯示存檔完成、不重算、不重載');
  }
  // F2 畫面還是草稿（舊分頁）但後端回 locked：不顯示存檔完成、提示帶後端訊息
  for (const [name, runIt] of [['saveAtt', p => p.saveAtt()], ['clearAtt', p => p.clearAtt()], ['saveBonus', p => p.saveBonus(p.btn)]]) {
    const p = page('draft', LOCKR);
    await runIt(p);
    eq(p.log.posts.length, 1, 'F2 ' + name + '：草稿狀態有送出請求');
    eq([/已鎖定/.test(lastToast(p)[0]), lastToast(p)[1]], [true, true], 'F2 ' + name + '：後端回 locked → 紅字提示含「已鎖定」');
    eq([p.btn.textContent === '✓ 存檔完成', p.log.calc, p.log.reload], [false, 0, 0], 'F2 ' + name + '：不顯示存檔完成、不重算、不重載');
    ok(!p.log.toasts.some(t => /已儲存|已清除/.test(t[0])), 'F2 ' + name + '：沒有「已儲存／已清除」提示');
  }
  // F3 草稿、後端成功：行為不變
  let p = page('draft', OKR); await p.saveAtt();
  eq([p.log.posts, p.log.calc, p.btn.textContent, lastToast(p)], [['payroll_input_set'], 1, '✓ 存檔完成', ['2026-10 工時已儲存（2 人）', false]], 'F3 saveAtt 草稿成功 → 重算、存檔完成、提示人數');
  p = page('draft', OKR); await p.saveBonus(p.btn);
  eq([p.log.posts, p.log.calc, p.btn.textContent, lastToast(p)], [['payroll_bonus_set'], 1, '✓ 存檔完成', ['獎金已儲存（1 筆）', false]], 'F3 saveBonus 草稿成功 → 重算、存檔完成');
  p = page('draft', OKR); await p.clearAtt();
  eq([p.log.posts, p.log.confirms, p.log.reload, lastToast(p)], [['payroll_input_set'], 1, 1, ['2026-10 手動工時已清除', false]], 'F3 clearAtt 草稿成功 → 確認一次、重載、提示已清除');

  console.log(`\n小計：通過 ${pass}、失敗 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
