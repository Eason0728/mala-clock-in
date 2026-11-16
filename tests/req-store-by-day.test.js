// 加班／請假／出差依「申請那天、那個時段」在哪家打卡選店（2026-11-15 Eason）。
// 起因：一位支援同仁在墨竹亭金山加班，加班單送到原單位墨竹亭光復（預設看最後一次打卡），金山核定看不到。
// 前端 req-line.js storeByDay（純函式）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const fe = {};
vm.createContext(fe);
vm.runInContext(extract(fs.readFileSync(ROOT + '/req-line.js', 'utf8'), 'storeByDay'), fe);
const P = (hm, type, status) => ({ hm, type: type || 'in', status: status || 'ok' });
const day = (...p) => ({ date: '2026-11-12', punches: p });
const R = (code, name, d) => ({ code, name, day: d });
const D = '2026-11-12';
const J = (x) => JSON.parse(JSON.stringify(x));
const GF = (d) => R('mztgf', '墨竹亭光復', d), JS = (d) => R('mztjs', '墨竹亭金山', d);

ok('只有金山有卡、目前選光復 → 換到金山（鍾仕新 11/12 情境）', () => {
  const r = J(fe.storeByDay([GF(day()), JS(day(P('09:50'), P('16:03', 'out'), P('18:27'), P('20:54', 'out')))], 'mztgf', D, ['15:45', '16:00']));
  assert.strictEqual(r.pick, 'mztjs'); assert.deepStrictEqual(r.expect, ['mztjs']); assert.strictEqual(r.must, false);
});
ok('只有一家有卡、已經是那家 → 不換、expect 是那家', () => {
  const r = J(fe.storeByDay([GF(day()), JS(day(P('09:50'), P('20:54', 'out')))], 'mztjs', D, null));
  assert.strictEqual(r.pick, null); assert.deepStrictEqual(r.expect, ['mztjs']);
});
ok('同一天兩家有卡、加班時段只對到一家 → 選那家', () => {
  const res = [GF(day(P('09:00'), P('13:00', 'out'))), JS(day(P('17:00'), P('21:00', 'out')))];
  const r = J(fe.storeByDay(res, 'mztgf', D, ['20:00', '21:00']));
  assert.strictEqual(r.pick, 'mztjs'); assert.strictEqual(r.note.kind, 'range'); assert.strictEqual(r.must, false);
  const r2 = J(fe.storeByDay(res, 'mztjs', D, ['08:30', '09:30']));
  assert.strictEqual(r2.pick, 'mztgf', '早到加班對到光復');
});
ok('同一天兩家有卡、時段在兩家之間或沒有時段 → 要同仁自己選，列出兩家時間', () => {
  const res = [GF(day(P('09:00'), P('13:00', 'out'))), JS(day(P('17:00'), P('21:00', 'out')))];
  const r = J(fe.storeByDay(res, 'mztgf', D, ['14:00', '15:00']));
  assert.strictEqual(r.must, true); assert.strictEqual(r.pick, null); assert.deepStrictEqual(r.expect.sort(), ['mztgf', 'mztjs']);
  assert.deepStrictEqual(r.note.all, ['墨竹亭光復 09:00–13:00', '墨竹亭金山 17:00–21:00']);
  assert.strictEqual(J(fe.storeByDay(res, 'mztgf', D, null)).must, true, '整天的假');
});
ok('被擋的卡不算；都沒卡 → 不換、不判斷；有店問不到 → 不判斷', () => {
  assert.deepStrictEqual(J(fe.storeByDay([GF(day(P('10:00', 'in', 'rejected_far'))), JS(day())], 'mztgf', D, null)), { pick: null, expect: [], must: false, note: null });
  assert.deepStrictEqual(J(fe.storeByDay([GF(day()), JS(null)], 'mztgf', D, null)), { pick: null, expect: [], must: false, note: null });
});
ok('跨夜時段（22:00–02:00）對到晚班那家', () => {
  const res = [GF(day(P('09:00'), P('13:00', 'out'))), JS(day(P('18:00'), P('23:30', 'out')))];
  const r = J(fe.storeByDay(res, 'mztgf', D, ['23:00', '01:00']));
  assert.strictEqual(r.pick, 'mztjs');
});
// 光復的店代碼是空字串（2026-11-16：綁「總部＋小辛辣光復」的同仁，那天只有光復有卡卻沒有自動換到光復）
const SSL = (d) => R('', '小辛辣 新竹光復', d), HQ = (d) => R('hq', '鼎兆元 總部', d);
ok('只有光復（代碼空字串）有卡、目前選總部 → pick 是空字串、不是 null', () => {
  const r = J(fe.storeByDay([SSL(day(P('17:00'), P('21:30', 'out'))), HQ(day())], 'hq', D, null));
  assert.strictEqual(r.pick, ''); assert.deepStrictEqual(r.expect, ['']); assert.strictEqual(r.note.kind, 'switched');
  assert.strictEqual(J(fe.storeByDay([SSL(day(P('17:00'))), HQ(day())], '', D, null)).pick, null, '已經在光復就不換');
});
// storeHint 實際跑一次：要自動換到光復的時候真的有換（原本用 truthy 判斷 pick，空字串被當成「不用換」）
function runHint(res, cur, picked) {
  const src = fs.readFileSync(ROOT + '/req-line.js', 'utf8');
  const log = { sw: [], render: 0 };
  const stores = res.map((x) => ({ code: x.code, name: x.name }));
  const box = { dataset: {}, isConnected: true, textContent: '', className: '', appendChild() {} };
  const cx = { st: { init: { stores }, store: stores.filter((x) => x.code === cur)[0], picked: picked || {} },
    daysFor: () => ({ then: (f) => f(res) }), switchStore: (c) => log.sw.push(c), render: () => { log.render++; },
    document: { createTextNode: (t) => t }, chips: () => null };
  vm.createContext(cx);
  vm.runInContext(extract(src, 'storeByDay') + extract(src, 'shortMd') + extract(src, 'storeHint'), cx);
  cx.storeHint(box, D, null);
  return { log, box };
}
ok('storeHint：那天只有光復（代碼空字串）有卡、目前選總部 → 自動換到光復並重畫', () => {
  const r = runHint([SSL(day(P('17:00'), P('21:30', 'out'))), HQ(day())], 'hq');
  assert.deepStrictEqual(r.log.sw, ['']); assert.strictEqual(r.log.render, 1);
});
ok('storeHint：換到一般代碼的店照舊；這一天手動選過店就不換、橘字提醒', () => {
  const a = runHint([SSL(day()), HQ(day(P('09:00')))], '');
  assert.deepStrictEqual(a.log.sw, ['hq']);
  const b = runHint([SSL(day(P('17:00'))), HQ(day())], 'hq', { [D]: 'hq' });
  assert.deepStrictEqual(b.log.sw, []); assert.strictEqual(b.box.className, 'rq-auto-store warn');
  assert.strictEqual(b.box.textContent, '11/12 你是在小辛辣 新竹光復打卡，上面選的是「鼎兆元 總部」，確認要送到這家嗎？');
});
console.log('\n共 ' + n + ' 項通過');
