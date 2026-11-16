// 定位先粗後精（2026-11-17）：打卡頁「多粗可以先放行」的上限，必須等於後端收卡時「誤差最多抵幾公尺」。
// 畫面比後端鬆 → 按鍵亮了、按下去被擋；畫面比後端嚴 → 同仁白等。三個地方（打卡頁、共用挑店程式、後端）要同一個數字。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(ROOT + '/clock-line.html', 'utf8');
const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const core = require(ROOT + '/clock-line-core.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const num = (src, re, what) => { const m = src.match(re); assert.ok(m, '找不到 ' + what); return Number(m[1]); };

ok('先放行的誤差上限＝後端最多抵的誤差＝共用挑店程式的上限（100 公尺）', () => {
  const page = num(html, /COARSE_MAX_ACC = (\d+)/, 'COARSE_MAX_ACC');
  const back = num(code, /const ACCURACY_CREDIT_CAP_M = (\d+)/, 'ACCURACY_CREDIT_CAP_M');
  assert.strictEqual(page, back);
  assert.strictEqual(page, core.ACCURACY_CREDIT_CAP_M);
  assert.strictEqual(page, 100);
});

ok('「合格位置」的門檻沒有被放寬：仍是誤差 40 公尺內、30 秒內', () => {
  assert.strictEqual(num(html, /var GOOD_ACC = (\d+)/, 'GOOD_ACC'), 40);
  assert.strictEqual(num(html, /STALE_MS = (\d+)/, 'STALE_MS'), 30000);
});

ok('放行條件用的是共用挑店規則：誤差 100、扣掉後在唯一一家店內才算；兩家都中、都不中、沒有位置都不算', () => {
  const A = { code: 'a', lat: 24.7764, lng: 121.0199, radius_m: 50 }, B = { code: 'b', lat: 24.7767, lng: 121.0219, radius_m: 50 };   // 相距約 200 公尺
  const at = (lat, lng, acc) => core.pickStore({ lat, lng, accuracy_m: acc }, [A, B]);
  assert.strictEqual(at(A.lat, A.lng, 100).status, 'ok');
  assert.strictEqual(at((A.lat + B.lat) / 2, (A.lng + B.lng) / 2, 100).status, 'ambiguous');
  assert.strictEqual(at(A.lat + 0.003, A.lng, 100).status, 'none');           // 約 330 公尺外：抵 100 也進不來
  assert.strictEqual(at(A.lat + 0.003, A.lng, 400).status, 'none');           // 誤差再大也只抵 100
  assert.strictEqual(core.pickStore(null, [A, B]).status, 'no_fix');
});

ok('兩個開關都在，而且預設是開；關掉就退回舊做法（用網址參數可在單一手機上切換）', () => {
  assert.ok(/var COARSE_FIRST = true, COARSE_MAX_ACC = 100, GEO_EARLY = true/.test(html));
  assert.ok(/flagOn\('coarse', COARSE_FIRST\)/.test(html) && /flagOn\('geo_early', GEO_EARLY\)/.test(html));
});

ok('送出打卡前仍然用最新位置再挑一次店（先放行不等於直接收卡）', () => {
  const i = html.indexOf('function sendPunch('); assert.ok(i > 0);
  const body = html.slice(i, i + 900);
  assert.ok(/ClockLineCore\.pickStore\(fixForPick\(\), STORES\)/.test(body) && /pick\.store\.code !== curStore\.code/.test(body));
});

console.log('geo-coarse：' + n + ' 項全過');
