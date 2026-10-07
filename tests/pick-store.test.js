// LINE 打卡頁挑店規則（clock-line-core.js）——用 tools/stores.json 的真座標測。
const assert = require('assert');
const path = require('path');
const { pickStore, distanceM } = require(path.join(__dirname, '..', 'clock-line-core.js'));
const stores = require(path.join(__dirname, '..', 'tools', 'stores.json'));
const by = c => stores.find(s => s.code === c);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

// 從某點往北移 m 公尺（緯度 1 度 ≈ 111195m）
const north = (s, m) => ({ lat: s.lat + m / 111195, lng: s.lng });
const hq = by('hq'), js = by('mztjs'), gf = by(''), mgf = by('mztgf'), cf = by('cf');
const mid = { lat: (hq.lat + js.lat) / 2, lng: (hq.lng + js.lng) / 2 };

ok('總部與金山相距約 202m（前提）', () => assert(Math.abs(distanceM(hq.lat, hq.lng, js.lat, js.lng) - 202) < 2));
ok('站在總部、誤差 13 → 總部', () => { const r = pickStore({ ...hq, accuracy_m: 13 }, stores); assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.store.code, 'hq'); });
ok('站在金山、誤差 13 → 金山', () => { const r = pickStore({ ...js, accuracy_m: 13 }, stores); assert.strictEqual(r.store.code, 'mztjs'); });
ok('站在墨竹亭光復 → 墨竹亭光復', () => assert.strictEqual(pickStore({ ...mgf, accuracy_m: 10 }, stores).store.code, 'mztgf'));
ok('站在央廚 → 央廚', () => assert.strictEqual(pickStore({ ...cf, accuracy_m: 10 }, stores).store.code, 'cf'));
ok('總部金山中間、誤差 60 → ambiguous（兩家都符合，不猜）', () => {
  const r = pickStore({ ...mid, accuracy_m: 60 }, stores);
  assert.strictEqual(r.status, 'ambiguous'); assert.deepStrictEqual(r.candidates.sort(), ['hq', 'mztjs']);
});
ok('總部金山中間、誤差 40 → none（絕不 ambiguous）', () => assert.strictEqual(pickStore({ ...mid, accuracy_m: 40 }, stores).status, 'none'));
ok('誤差 51 以下任何位置都不會 ambiguous（掃 0–202m 線段）', () => {
  for (let acc = 0; acc <= 50; acc += 5) for (let t = 0; t <= 1; t += 0.02) {
    const p = { lat: hq.lat + (js.lat - hq.lat) * t, lng: hq.lng + (js.lng - hq.lng) * t, accuracy_m: acc };
    assert.notStrictEqual(pickStore(p, stores).status, 'ambiguous', `acc=${acc} t=${t}`);
  }
});
ok('誤差 500 會被折抵上限 100 擋住：中間點仍 ambiguous、1km 外仍 none', () => {
  assert.strictEqual(pickStore({ ...mid, accuracy_m: 500 }, stores).status, 'ambiguous');
  assert.strictEqual(pickStore({ ...north(hq, 1000), accuracy_m: 500 }, stores).status, 'none');
});
ok('小辛辣光復半徑 20：北 25m、誤差 3 → none；北 15m → 光復', () => {
  assert.strictEqual(pickStore({ ...north(gf, 25), accuracy_m: 3 }, stores).status, 'none');
  assert.strictEqual(pickStore({ ...north(gf, 15), accuracy_m: 3 }, stores).store.code, '');
});
ok('沒回報誤差＝折抵 0（同後端）', () => assert.strictEqual(pickStore({ ...north(js, 60) }, stores).status, 'none'));
ok('none 會帶最近的店與距離', () => { const r = pickStore({ ...north(js, 300), accuracy_m: 10 }, stores); assert.strictEqual(r.nearest.code, 'mztjs'); assert(Math.abs(r.distance_m - 300) < 3); });
ok('fix 為 null／缺座標 → no_fix', () => { assert.strictEqual(pickStore(null, stores).status, 'no_fix'); assert.strictEqual(pickStore({ lat: NaN, lng: 1 }, stores).status, 'no_fix'); });
console.log(`\n${n} 項全部通過`);
