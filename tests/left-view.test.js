// 離職後查詢（2026-10-09 Eason）：打卡一離職就關；自己的薪資單、打卡紀錄、假別離職後 60 天內可查。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const ROOT = __dirname + '/..';
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
const PAY = fs.readFileSync(ROOT + '/apps-script/Payroll.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const NOW = Date.parse('2026-10-09T10:00:00+08:00');
const daysAgo = (d) => new Date(NOW - d * 86400000 + 8 * 3600000).toISOString().replace(/\.\d+Z$/, '+08:00');

function make(roster) {
  const cache = {};
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = { console, JSON, Math, String, Number, Object, Array, isFinite, parseInt, Date: FakeDate,
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }, removeAll: ks => ks.forEach(k => delete cache[k]) }) },
    normCellTs: v => v, LINE_HUB_STORES_CONFIG: [{ code: 'hq', name: '總部', ss_id: 'SS', lat: 0, lng: 0, radius_m: 50 }],
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => ({ rows: roster }) }) },
    readSheetAsObjects: sh => ({ rows: sh.rows.map(r => Object.assign({}, r)) }) };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  return sb;
}
const R = (x) => Object.assign({ emp_id: 'E1', name: '甲', key: 'k1', active: 'true', line_user_id: 'U1' }, x);

ok('在職：查詢與綁定都看得到', () => {
  const sb = make([R()]);
  assert.strictEqual(sb.lineHubMine_('U1').length, 1);
  assert.strictEqual(sb.lineHubMine_('U1', null, true).length, 1);
});
ok('離職 10 天：查詢看得到（view），綁定／打卡那條看不到', () => {
  const sb = make([R({ active: 'false', removed_at: daysAgo(10) })]);
  assert.strictEqual(sb.lineHubMine_('U1').length, 0);
  assert.strictEqual(sb.lineHubMine_('U1', null, true).length, 1);
});
ok('離職 60 天整還可以、61 天就不行；沒有 removed_at 的舊離職者不行', () => {
  assert.strictEqual(make([R({ active: 'false', removed_at: daysAgo(59.9) })]).lineHubMine_('U1', null, true).length, 1);
  assert.strictEqual(make([R({ active: 'false', removed_at: daysAgo(61) })]).lineHubMine_('U1', null, true).length, 0);
  assert.strictEqual(make([R({ active: 'false', removed_at: '' })]).lineHubMine_('U1', null, true).length, 0);
});
ok('兩種查法分開快取，互不影響', () => {
  const sb = make([R({ active: 'false', removed_at: daysAgo(5) })]);
  sb.lineHubMine_('U1', null, true);
  assert.strictEqual(sb.lineHubMine_('U1').length, 0);
});
ok('打卡（liff_status／liff_punch）仍只認在職：離職 1 天就擋', () => {
  const sb = make([R({ active: 'false', removed_at: daysAgo(1) })]);
  sb.getSS = () => ({ getSheetByName: () => ({ rows: [R({ active: 'false', removed_at: daysAgo(1) })] }) });
  assert.strictEqual(sb.liffRosterByLine_('U1').error, 'not_bound');
});

// 舊的個人薪資連結 handleMyPayslip
function payslip(row, withHub) {
  const sb = make([row]);
  vm.runInContext(extract(PAY, 'handleMyPayslip'), sb);
  sb.payStoreList = () => [{ code: '' }];
  sb.payClockRead = () => [row];
  sb.findRosterByKey = (rows, k) => rows.filter(r => r.key === k)[0];
  sb.payMyPayslipFor_ = () => ({ ok: true, ready: true });
  sb.currentYmTaipei = () => '2026-10';
  if (!withHub) sb.lineHubCanView_ = undefined;   // 宣告的全域函式刪不掉，改成蓋成 undefined
  return sb.handleMyPayslip({ key: 'k1' });
}
ok('舊薪資連結：在職、離職 30 天 → 可查；離職 61 天、沒有 removed_at → left_expired', () => {
  assert.strictEqual(payslip(R(), true).ok, true);
  assert.strictEqual(payslip(R({ active: 'false', removed_at: daysAgo(30) }), true).ok, true);
  assert.strictEqual(payslip(R({ active: 'false', removed_at: daysAgo(61) }), true).error, 'left_expired');
  assert.strictEqual(payslip(R({ active: 'false', removed_at: '' }), true).error, 'left_expired');
});
ok('舊薪資連結：沒部署 LineHub 的環境 → 只給在職的人', () => {
  assert.strictEqual(payslip(R({ active: 'false', removed_at: daysAgo(3) }), false).error, 'left_expired');
  assert.strictEqual(payslip(R(), false).ok, true);
});
ok('my.html 有 left_expired 的說明（不是「連結失效」）', () => {
  assert(/left_expired[\s\S]{0,200}離職超過 60 天/.test(fs.readFileSync(ROOT + '/my.html', 'utf8')));
});
console.log(`\n${n} 項全部通過`);
