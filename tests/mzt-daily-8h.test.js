/* 墨竹亭全時每日出勤要滿 8 小時（4-6）：只提醒 */
const fs = require('fs');
const GS = fs.readFileSync(require('path').join(__dirname, '..') + '/apps-script/Payroll.gs', 'utf8');
const a = GS.indexOf('function payR0'), b = GS.indexOf('/* ═══════════════════ Handlers');
const E = {}; new Function('exports', "function pad2(n){return ('0'+n).slice(-2)}\n" + GS.slice(a, b) + '\nexports.f=payMztShortDays_;')(E);
let p = 0, f = 0; const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };
const d = { dates: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'],
  sched: { '2026-11-02': { t: 'W' }, '2026-11-03': { t: 'W' }, '2026-11-04': { t: 'H' }, '2026-11-05': { t: 'W' }, '2026-11-06': { t: 'W' }, '2026-11-07': { t: 'W' }, '2026-11-08': { t: 'W' } },
  day_h: { '2026-11-02': 7.5, '2026-11-03': 4, '2026-11-04': 3, '2026-11-05': 8, '2026-11-07': 6, '2026-11-08': 2 }, day_leave: { '2026-11-03': 4 }, hol: { '2026-11-07': true }, until: '2026-11-07' };
chk('只列工作日不滿 8H（請假併計、休息日、國定、沒來、今天不列）', E.f({ store: 'MZTJS' }, d), [{ date: '2026-11-02', h: 7.5 }]);
chk('小辛辣不適用', E.f({ store: 'SSLGF' }, d), []);
chk('央廚不適用', E.f({ store: 'CF' }, d), []);
chk('沒有逐日資料', E.f({ store: 'MZTJS' }, null), []);
console.log(f ? `\n❌ 失敗 ${f}` : `\n✅ 全部通過 (${p}/${p})`); process.exit(f ? 1 : 0);
