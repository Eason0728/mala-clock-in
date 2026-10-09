// 「薪資明細」卡片（LineHub.gs lineHubPayFlex_／lineHubPayMessage_）
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const sb = { console, CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) } };
vm.createContext(sb); vm.runInContext(SRC, sb);
const J = { ok: true, ready: true, ym: '2026-09', payday: '5', result: {
  total_hours: 152, support_hours: 8, base_hours: 160, ot_paid_hours: 0, gross: 25700, deduction: 1011, net: 24689,
  earn: [{ item_key: 'hourly_wage', item_label: '時薪', qty: 152, rate: 162.5, amount: 24700 },
         { item_key: 'pt_attend_plus', item_label: '計時滿勤加給', qty: null, rate: null, amount: 1000 },
         { item_key: 'personal_leave', item_label: '事假', qty: 8, rate: 0, amount: 0 }],
  ded: [{ item_key: 'labor', item_label: '勞保自付', qty: null, rate: null, amount: 621 },
        { item_key: 'health', item_label: '健保自付', qty: null, rate: null, amount: 390 }] } };
module.exports = { sample: () => sb.lineHubPayFlex_(J), sampleEmpty: () => { const J2 = JSON.parse(JSON.stringify(J)); J2.result.ded = []; J2.result.deduction = 0; return sb.lineHubPayFlex_(J2); } };
const texts = (o) => { const out = []; (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(walk); } })(o); return out; };
ok('fixture 自洽（加項相加＝應收、扣項相加＝應付、應收−應付＝實付）', () => {
  const r = J.result; const sum = (a) => a.reduce((t, x) => t + x.amount, 0);
  assert.strictEqual(sum(r.earn), r.gross); assert.strictEqual(sum(r.ded), r.deduction); assert.strictEqual(r.gross - r.deduction, r.net);
});
ok('已定案 → Flex 卡片：實付在最上面；altText 不露金額', () => {
  const f = sb.lineHubPayFlex_(J);
  assert.strictEqual(f.type, 'flex'); assert(!/\d/.test(f.altText.replace(/9 月/, '')), f.altText);
  const t = texts(f.contents.body); assert(t.indexOf('NT$ 24,689') < t.indexOf('加項'));
});
ok('與網頁同格式：小字「152H × 162.5」、0 元的事假照列、扣項不加負號', () => {
  const t = texts(sb.lineHubPayFlex_(J));
  assert(t.includes('152H × 162.5')); assert(t.includes('事假')); assert(t.includes('8H'));
  assert(t.includes('621') && !t.some(x => /^-/.test(x))); assert(t.includes('每月 5 日')); assert(t.includes('基本工時'));
});
ok('沒有任何扣項、項目名空白、時數非數字 → 卡片裡沒有任何空字串（LINE 會整則拒收）', () => {
  const J2 = JSON.parse(JSON.stringify(J)); J2.result.ded = []; J2.result.deduction = 0; J2.result.earn[1].item_label = ''; J2.result.total_hours = 'x';
  const t = texts(sb.lineHubPayFlex_(J2));
  assert(t.every(x => typeof x === 'string' && x.length > 0), JSON.stringify(t));
  assert(t.includes('—'));
});
ok('未定案／沒綁定 → 文字，不送卡片', () => {
  sb.lineHubPayslipFor_ = () => ({ ok: true, ready: false, ym: '2026-10', message: '本月薪資尚未結算' });
  assert.strictEqual(typeof sb.lineHubPayMessage_('U1'), 'string');
  sb.lineHubPayslipFor_ = () => null; sb.lineHubMine_ = () => [];
  assert(/還沒綁定/.test(sb.lineHubPayMessage_('U1')));
  sb.lineHubPayslipFor_ = () => J;
  assert.strictEqual(sb.lineHubPayMessage_('U1').type, 'flex');
});
ok('分區塊＋淡色系（2026-10-09 Eason 選 A）：實付／工時／加項／扣項／其他五區依序、各自淡色底，加項區含應收合計、扣項區含應付合計', () => {
  const body = sb.lineHubPayFlex_(J).contents.body.contents;
  const boxes = body.filter(x => x.type === 'box' && x.backgroundColor);
  assert.strictEqual(JSON.stringify(boxes.map(x => x.backgroundColor)), JSON.stringify(['#eaf6ee', '#edf3fa', '#fdf7e6', '#fcefed', '#f4f4f2']));
  assert.strictEqual(boxes.slice(1).map(x => x.contents[0].text).join(), '工時,加項,扣項,其他');
  assert(texts(boxes[0]).includes('應收 25,700　－　應付 1,011'));
  assert(texts(boxes[2]).includes('應收合計') && texts(boxes[2]).includes('事假'));
  assert(texts(boxes[3]).includes('應付合計') && texts(boxes[3]).includes('621'));
  assert(texts(boxes[1]).includes('跨店支援時數'));
});
ok('沒有發薪日 → 不出現「其他」區', () => {
  const J2 = JSON.parse(JSON.stringify(J)); delete J2.payday;
  assert(!texts(sb.lineHubPayFlex_(J2)).includes('其他'));
});
if (require.main === module) console.log(`\n${n} 項全部通過`);
