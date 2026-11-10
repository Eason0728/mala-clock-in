/* B17（2026-11-10 挑錯）：舊連結打卡頁（clock.html）「連線不穩，正在確認這筆有沒有進去」的判斷。
 * 判斷的依據是「送出前的今日紀錄」和「查回來的今日紀錄」有沒有不同。但打卡鍵不等開頁資料回來就能按，
 * 這時候「送出前的今日紀錄」是空的——今天稍早只要打過同一種卡，查回來就一定「不同」，
 * 畫面就說「剛才那筆打卡已經完成，不用再按一次」。這次的卡其實沒進去，同仁就少一張卡。
 * 修正：
 *   ① 基準在「送出那一刻」才取（等定位的幾秒裡開頁資料常常已經回來了）。
 *   ② 送出時開頁資料還沒回來（沒有基準）：只有查到的那張卡是「送出之後」的才說已完成；
 *      查到的是更早的卡 → 不下結論，請同仁看今日紀錄；今天完全沒有這種卡 → 沒有送出。
 * 做法：從真的 clock.html 取出判斷用的函式來跑。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'clock.html'), 'utf8');
function extract(name) {
  const a = SRC.indexOf('  function ' + name + '(');
  if (a < 0) throw new Error('clock.html 找不到 ' + name);
  let i = SRC.indexOf('{', a), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) break; } }
  return SRC.slice(a, i + 1);
}
let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     實際=' + JSON.stringify(got) + '\n     預期=' + JSON.stringify(want))); };

let sb;
try {
  sb = { Date, String, isNaN };
  vm.createContext(sb);
  vm.runInContext(['findLatestByType', 'computeTypeStat', 'punchLanded'].map(extract).join('\n') +
    '\nthis.punchLanded = punchLanded; this.computeTypeStat = computeTypeStat;', sb);
} catch (e) {
  console.log('FAIL 取不到判斷函式：' + e.message);
  process.exit(1);
}
const E = (hms, type, status) => ({ ts: '2026-11-10T' + hms + '+08:00', type: type, status: status || 'ok' });
const MS = (hms) => Date.parse('2026-11-10T' + hms + '+08:00');
const verdict = (events, type, snap) => { const r = sb.punchLanded(events, type, snap); return [r.state, r.found ? String(r.found.ts).slice(11, 16) : null]; };
const AM = [E('11:00:00', 'in'), E('14:30:00', 'out')];   // 今天稍早：11:00 上班、14:30 下班

console.log('── 送出時開頁資料還沒回來（沒有基準）──');
const NOBASE = { count: 0, lastTs: '', known: false, sentAt: MS('17:00:00') };
chk('17:00 按上班、卡沒進去（今天只有 11:00 那張上班卡）→ 不可以說已完成', verdict(AM, 'in', NOBASE), ['unsure', '11:00']);
chk('17:00 按上班、卡有進去（多一張 17:00:03）→ 已完成 17:00', verdict(AM.concat([E('17:00:03', 'in')]), 'in', NOBASE), ['landed', '17:00']);
chk('17:00 按上班、被判重複（17:00:03 rejected_duplicate）→ 找得到這張', verdict(AM.concat([E('17:00:03', 'in', 'rejected_duplicate')]), 'in', NOBASE), ['landed', '17:00']);
chk('今天完全沒有上班卡 → 沒有送出', verdict([E('14:30:00', 'out')], 'in', NOBASE), ['not_sent', null]);
chk('今天沒有任何卡 → 沒有送出', verdict([], 'in', NOBASE), ['not_sent', null]);
chk('手機時鐘快 90 秒（卡的時間比手機送出時間早 90 秒）→ 仍算這次的', verdict(AM.concat([E('16:58:30', 'in')]), 'in', NOBASE), ['landed', '16:58']);
chk('手機時鐘快 5 分鐘 → 不下結論（請看今日紀錄），不會說沒送出', verdict(AM.concat([E('16:55:00', 'in')]), 'in', NOBASE), ['unsure', '16:55']);
chk('沒有基準、也沒有送出時間 → 不下結論', verdict(AM, 'in', { count: 0, lastTs: '', known: false }), ['unsure', '11:00']);

console.log('── 送出時開頁資料已經回來（有基準）：照原本的比法，不看手機時鐘 ──');
const BASE = Object.assign({ known: true, sentAt: MS('17:00:00') }, sb.computeTypeStat(AM, 'in'));
chk('卡沒進去（今日紀錄沒變）→ 沒有送出', verdict(AM, 'in', BASE), ['not_sent', null]);
chk('卡有進去（多一張）→ 已完成', verdict(AM.concat([E('17:00:03', 'in')]), 'in', BASE), ['landed', '17:00']);
chk('手機時鐘快 20 分鐘、卡有進去（16:40）→ 已完成（有基準時不比時間）', verdict(AM.concat([E('16:40:00', 'in')]), 'in', BASE), ['landed', '16:40']);
const BASE0 = Object.assign({ known: true, sentAt: MS('09:00:00') }, sb.computeTypeStat([], 'in'));
chk('今天第一張：有基準（空的）、卡有進去 → 已完成', verdict([E('09:00:02', 'in')], 'in', BASE0), ['landed', '09:00']);
chk('今天第一張：有基準（空的）、卡沒進去 → 沒有送出', verdict([], 'in', BASE0), ['not_sent', null]);

console.log('── 程式接法 ──');
chk('開頁資料畫出來才算有基準（snapshotTodayByType 會記下來）', /function snapshotTodayByType\(events\) \{[^\n]*\n[^\n]*todaySnapshotKnown = true/.test(SRC), true);
chk('基準在送出那一刻才取（在 apiPost 打卡請求之前、定位之後）', /requestSent = true;\s*\n\s*beforeSnap = \{[^}]*known: todaySnapshotKnown[^}]*sentAt: Date\.now\(\)/.test(SRC), true);
chk('不下結論時畫面請同仁看今日紀錄，不說「已經完成」', /state === 'unsure'[\s\S]{0,400}今日紀錄/.test(SRC), true);
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
