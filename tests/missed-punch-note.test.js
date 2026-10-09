// 忘打卡提醒（2026-10-09 Eason 指定）：不主動推播，下一次打卡成功時告知上一次漏了哪張卡。
// 測 Liff.gs 的 liffMissedNote_（打卡畫面）、liffPunchFor_ 回傳 missed，以及 LineHub.gs 聊天室文字／卡片帶出同一句。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const hubSrc = fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW_TS = '2026-10-08T08:31:00+08:00';
const NOW = Date.parse(NOW_TS);
const sb = {
  console, Date, JSON, Math, String, Number, isNaN, parseInt, Object, Array,
  CONFIG: { ALTERNATION_LOOKBACK_HOURS: 12 },
  normCellTs: (v) => String(v),
  CacheService: { getScriptCache: () => ({ put() {}, get: () => null, remove() {} }) },
};
vm.createContext(sb);
vm.runInContext([fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'), extract(codeSrc, 'lastCountedEvent'),
                 extract(hubSrc, 'lineHubPunchText_'), extract(hubSrc, 'lineHubHm_')].join('\n'), sb);
const note = (evs, type, ts) => sb.liffMissedNote_(evs, 'E01', type, ts || NOW_TS);
const ev = (ts, type, status, emp) => ({ ts, type, status: status || 'ok', emp_id: emp || 'E01' });

ok('上班：上一張算數的卡也是上班 → 告知那天沒打下班卡（日期時間）', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in')], 'in'),
    '你 10/7 08:30 上班後沒有打下班卡，請跟主管說實際下班時間');
});
ok('上班：上一張是下班＝正常，不提', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in'), ev('2026-10-07T17:30:00+08:00', 'out')], 'in'), '');
});
ok('上班：下班卡有按但被超出範圍擋下 → 說「沒有打成功」', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in'), ev('2026-10-07T17:30:00+08:00', 'out', 'rejected_out_of_range')], 'in'),
    '你 10/7 08:30 上班後的下班卡沒有打成功（不在範圍內），請跟主管說實際下班時間');
});
ok('上班：連按被擋（rejected_duplicate）不算「有按下班」也不算上一張', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in'), ev('2026-10-07T08:30:05+08:00', 'in', 'rejected_duplicate')], 'in'),
    '你 10/7 08:30 上班後沒有打下班卡，請跟主管說實際下班時間');
});
ok('上班：超過 7 天前的漏卡不提（月底多半已處理）', () => {
  assert.strictEqual(note([ev('2026-09-30T08:30:00+08:00', 'in')], 'in'), '');
});
ok('上班：第一次打卡（沒有任何紀錄）不提', () => { assert.strictEqual(note([], 'in'), ''); });
ok('上班：待核准裝置的上班卡也算上一張（同 lastCountedEvent）', () => {
  assert.ok(note([ev('2026-10-07T09:00:00+08:00', 'in', 'pending_device_approval')], 'in').indexOf('10/7 09:00') > 0);
});
ok('別人的卡不影響', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in', 'ok', 'E02')], 'in'), '');
});
ok('這次這筆（同一個 ts）與之後的卡不算「上一張」', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in'), ev('2026-10-07T17:00:00+08:00', 'out'), ev(NOW_TS, 'in')], 'in'), '');
});
ok('下班：16 小時內有上班卡＝正常，不提', () => {
  assert.strictEqual(note([ev('2026-10-08T08:00:00+08:00', 'in')], 'out', '2026-10-08T17:00:00+08:00'), '');
});
ok('下班：今天沒有上班卡（前一張是昨天下班）→ 告知這次沒打上班卡', () => {
  assert.strictEqual(note([ev('2026-10-07T08:00:00+08:00', 'in'), ev('2026-10-07T17:00:00+08:00', 'out')], 'out', '2026-10-08T17:00:00+08:00'),
    '你這次沒有打上班卡，請跟主管說實際上班時間');
});
ok('下班：上班卡被超出範圍擋下 → 說「沒有打成功」', () => {
  assert.strictEqual(note([ev('2026-10-08T08:00:00+08:00', 'in', 'rejected_out_of_range')], 'out', '2026-10-08T17:00:00+08:00'),
    '你這次的上班卡沒有打成功（不在範圍內），請跟主管說實際上班時間');
});
ok('下班：上班卡超過 16 小時（配對視窗外）→ 視為這次沒打上班卡', () => {
  assert.strictEqual(note([ev('2026-10-07T23:00:00+08:00', 'in')], 'out', '2026-10-08T16:00:00+08:00'),
    '你這次沒有打上班卡，請跟主管說實際上班時間');
});
ok('列順序亂（手動插列）照時間排，不照列序', () => {
  assert.strictEqual(note([ev('2026-10-07T17:30:00+08:00', 'out'), ev('2026-10-07T08:30:00+08:00', 'in')], 'in'), '');
});
ok('ts 壞掉或型別不對 → 不提', () => {
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in')], 'in', 'bad'), '');
  assert.strictEqual(note([ev('2026-10-07T08:30:00+08:00', 'in')], 'x'), '');
});

ok('liffPunchFor_ 打卡成功回傳 missed（用打卡前讀的 events，不多讀一次）', () => {
  let reads = 0;
  sb.liffEvents_ = () => { reads++; return [ev('2026-10-07T08:30:00+08:00', 'in')]; };
  sb.lastCountedEvent = () => null;   // 防呆放行（這裡只測回傳）
  sb.handleClock = () => ({ ok: true, status: 'ok', ts: NOW_TS });
  const r = sb.liffPunchFor_('U1', { emp_id: 'E01', key: 'k', device_id: 'd' }, {}, 'in', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.missed, '你 10/7 08:30 上班後沒有打下班卡，請跟主管說實際下班時間');
  assert.strictEqual(reads, 1);
});
ok('liffPunchFor_ 打卡失敗不帶 missed', () => {
  sb.handleClock = () => ({ ok: true, status: 'rejected_out_of_range', ts: NOW_TS });
  const r = sb.liffPunchFor_('U1', { emp_id: 'E01', key: 'k', device_id: 'd' }, {}, 'in', {});
  assert.strictEqual(r.ok, false); assert.strictEqual(r.missed, undefined);
});

ok('聊天室文字：有 missed 才多一段 ⚠️，位置在問候語之前', () => {
  const t = sb.lineHubPunchText_({ ok: true, type: 'in', ts: NOW_TS, store_name: '光復', missed: 'X漏卡', greeting: 'G' });
  assert.ok(t.indexOf('⚠️ X漏卡') > 0 && t.indexOf('⚠️ X漏卡') < t.indexOf('G'));
  assert.strictEqual(sb.lineHubPunchText_({ ok: true, type: 'in', ts: NOW_TS, store_name: '光復', missed: '' }).indexOf('⚠️'), -1);
});
ok('聊天室卡片與機器人「打卡」最新一筆都接上 missed（原始碼檢查）', () => {
  assert.ok(/if \(r\.missed\) blocks\.push/.test(extract(hubSrc, 'lineHubPunchCard_')));
  assert.ok(/missed: liffMissedNote_\(best\.rows, best\.emp_id, best\.type, best\.ts\)/.test(extract(hubSrc, 'lineHubLatestPunch_')));
});
ok('打卡畫面顯示 r.missed', () => {
  const html = fs.readFileSync(ROOT + '/clock-line.html', 'utf8');
  assert.ok(html.indexOf("(r.missed ? '\\n\\n⚠️ ' + r.missed : '')") > 0);
});

console.log('\n全部通過：' + n + ' 項');
