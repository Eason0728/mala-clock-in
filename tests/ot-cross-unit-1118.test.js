// 跨店加班歸屬（2026-11-18 Eason）：支援單位吸收（最多到它自己的時數，第 1 題 B）、支援兩家以上時數長的吸收、一樣長算後上班（第 2 題 A）、
// 同一單位才相加（墨竹亭↔總部、總部↔小辛辣同一單位，小辛辣↔墨竹亭不同；央廚、總部跟誰都同一單位）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8');
function extract(name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const ctx = { REQ_FT8_H: 8, REST_PEERS_: [{ code: 'gf', ss: 'S-GF' }, { code: 'mztjs', ss: 'S-JS' }, { code: 'hq', ss: 'S-HQ' }, { code: 'cf', ss: 'S-CF' }] };
vm.createContext(ctx);
['reqFt8Split_', 'reqUnitOf_', 'reqSameUnit_', 'reqSelfCode_'].forEach((n) => vm.runInContext(extract(n), ctx));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const P = (by) => ({ worked: true, pending: false, failed: false, by, names: Object.keys(by) });

ok('張淳 11/17：總部（原單位）6.75＋金山 2 → 0.75 小時算金山，總部不用開', () => {
  const x = ctx.reqFt8Split_(6.75, {}, P({ mztjs: { work: 2, ot: 0, fs: 540 } }), false);
  assert.strictEqual(x.comb, 8.75); assert.strictEqual(x.abs, 'mztjs'); assert.strictEqual(x.atSup, 0.75); assert.strictEqual(x.here, 0);
});
ok('同一天金山（支援）那邊看：要開 0.75', () => {
  const x = ctx.reqFt8Split_(2, { sched_home: 'hq', own_fs: 540 }, P({ hq: { work: 6.75, ot: 0, fs: 471 } }), true);
  assert.strictEqual(x.selfAbs, true); assert.strictEqual(x.here, 0.75);
});
ok('第 1 題 B：原單位 9＋支援 1 → 支援吸收 1，原單位留 1', () => {
  const home = ctx.reqFt8Split_(9, {}, P({ mztjs: { work: 1, ot: 0, fs: 1080 } }), false);
  assert.strictEqual(home.atSup, 1); assert.strictEqual(home.here, 1);
  const sup = ctx.reqFt8Split_(1, { sched_home: 'hq' }, P({ hq: { work: 9, ot: 0 } }), true);
  assert.strictEqual(sup.here, 1);
});
ok('不分誰先上後上：支援先上、原單位後上結果一樣', () => {
  const a = ctx.reqFt8Split_(5, {}, P({ mztjs: { work: 4.5, ot: 0, fs: 420 } }), false);
  const b = ctx.reqFt8Split_(5, {}, P({ mztjs: { work: 4.5, ot: 0, fs: 1020 } }), false);
  assert.strictEqual(a.atSup, 1.5); assert.strictEqual(b.atSup, 1.5); assert.strictEqual(a.here, 0);
});
ok('第 2 題 A：原單位 0＋A 4.5＋B 4 → A 吸收 0.5（原單位不比）', () => {
  const a = ctx.reqFt8Split_(4.5, { sched_home: 'hq', own_fs: 600 }, P({ cf: { work: 4, ot: 0, fs: 900 } }), true);
  assert.strictEqual(a.selfAbs, true); assert.strictEqual(a.here, 0.5);
  const b = ctx.reqFt8Split_(4, { sched_home: 'hq', own_fs: 900 }, P({ mztjs: { work: 4.5, ot: 0, fs: 600 } }), true);
  assert.strictEqual(b.selfAbs, false); assert.strictEqual(b.here, 0); assert.strictEqual(b.abs, 'mztjs');
});
ok('第 2 題 A：原單位 3＋A 4.5＋B 4（原單位時數最短也不吸收）→ A 吸收 3.5', () => {
  const x = ctx.reqFt8Split_(3, {}, P({ mztjs: { work: 4.5, ot: 0, fs: 600 }, cf: { work: 4, ot: 0, fs: 900 } }), false);
  assert.strictEqual(x.abs, 'mztjs'); assert.strictEqual(x.atSup, 3.5); assert.strictEqual(x.here, 0);
});
ok('兩家支援一樣長 → 後上班那家吸收', () => {
  const x = ctx.reqFt8Split_(2, {}, P({ mztjs: { work: 4, ot: 0, fs: 600 }, cf: { work: 4, ot: 0, fs: 840 } }), false);
  assert.strictEqual(x.abs, 'cf'); assert.strictEqual(x.atSup, 2);
  const me = ctx.reqFt8Split_(4, { sched_home: 'hq', own_fs: 840 }, P({ hq: { work: 2, ot: 0, fs: 480 }, mztjs: { work: 4, ot: 0, fs: 600 } }), true);
  assert.strictEqual(me.selfAbs, true); assert.strictEqual(me.here, 2);
});
ok('支援帳號沒帶原單位：別家都當原單位（同 11-13）', () => {
  const x = ctx.reqFt8Split_(2, {}, P({ hq: { work: 6.75, ot: 0 } }), true);
  assert.strictEqual(x.here, 0.75);
});
ok('同一單位：墨竹亭↔總部、總部↔小辛辣同一單位；小辛辣↔墨竹亭不同；央廚跟誰都同一單位', () => {
  assert.strictEqual(ctx.reqSameUnit_('mztjs', 'hq'), true);
  assert.strictEqual(ctx.reqSameUnit_('gf', 'hq'), true);
  assert.strictEqual(ctx.reqSameUnit_('gf', 'mztjs'), false);
  assert.strictEqual(ctx.reqSameUnit_('mztgf', 'gf'), false);
  assert.strictEqual(ctx.reqSameUnit_('mztlzl', 'mztjs'), true);
  assert.strictEqual(ctx.reqSameUnit_('cf', 'gf'), true);
  assert.strictEqual(ctx.reqSelfCode_('S-JS'), 'mztjs');
  assert.strictEqual(ctx.reqSelfCode_('nope'), '');
});
console.log('✅ pass ' + n + ' / fail 0');
