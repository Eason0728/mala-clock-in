// 「薪資明細」卡片（LineHub.gs lineHubPayFlex_／lineHubPayMessage_）
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const sb = { console, CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) } };
vm.createContext(sb); vm.runInContext(SRC, sb);
const J = { ok: true, ready: true, ym: '2026-09', payday: '5', result: {
  total_hours: 152, support_hours: 8, ot_paid_hours: 0, gross: 28000, deduction: 1011, net: 26989,
  earn: [{ item_key: 'hourly_wage', item_label: '時薪', qty: 152, rate: 162.5, amount: 24700 },
         { item_key: 'pt_attend_plus', item_label: '計時滿勤加給', qty: null, rate: null, amount: 1000 },
         { item_key: 'night', item_label: '夜班津貼', qty: null, rate: null, amount: 0 }],
  ded: [{ item_key: 'labor', item_label: '勞保自付', qty: null, rate: null, amount: 621 }] } };
module.exports = { sample: () => sb.lineHubPayFlex_(J) };
ok('已定案 → Flex 卡片：altText 含月份與實付、實付在最上面', () => {
  const f = sb.lineHubPayFlex_(J);
  assert.strictEqual(f.type, 'flex'); assert(/9 月薪資.*26,989/.test(f.altText));
  const texts = JSON.stringify(f.contents.body.contents);
  assert(texts.indexOf('NT$ 26,989') < texts.indexOf('加項'), '實付要在加項前面');
});
ok('項目與網頁同格式：時薪列小字「152H × 162.5」；0 元的不列；扣項帶負號', () => {
  const s = JSON.stringify(sb.lineHubPayFlex_(J));
  assert(s.includes('152H × 162.5')); assert(!s.includes('夜班津貼')); assert(s.includes('-621')); assert(s.includes('-1,011'));
  assert(s.includes('每月 5 日')); assert(s.includes('跨店支援時數'));
});
ok('未定案／沒綁定 → 文字，不送卡片', () => {
  sb.lineHubPayslipFor_ = () => ({ ok: true, ready: false, ym: '2026-10', message: '本月薪資尚未結算' });
  assert.strictEqual(typeof sb.lineHubPayMessage_('U1'), 'string');
  sb.lineHubPayslipFor_ = () => null; sb.lineHubMine_ = () => [];
  assert(/還沒綁定/.test(sb.lineHubPayMessage_('U1')));
  sb.lineHubPayslipFor_ = () => J;
  assert.strictEqual(sb.lineHubPayMessage_('U1').type, 'flex');
});
if (require.main === module) console.log(`\n${n} 項全部通過`);
