/* 紅字 trip_ot（平日出差有加班單）只在「整天出差」才出現（主管 2026-11-23）：
 * 平日出差＋本店上班合計超過 8 小時，超過的部分照現行算加班（金額不改），所以出差＋上班的日子不該再跳這則紅字。
 * 整天出差＝當天已核准出差單時數合計＝當天本店核定時數（核定 0 或還沒核定＝不算整天出差）。
 * 只改提醒出不出現與文字；加班單缺單（missing，擋鎖月）一律不受影響（拿 origin/main 的 Payroll.gs 逐筆對照）。 */
const fs = require('fs'), vm = require('vm'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8');
const mkSb = () => ({ console,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10) },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } });
const load = (payroll) => { const sb = mkSb(); vm.createContext(sb); vm.runInContext(read('Code.gs') + '\n' + payroll + '\n' + read('Rest.gs') + '\n' + read('Requests.gs'), sb); return sb; };
const sb = load(read('Payroll.gs'));
const F = (n) => vm.runInContext(n, sb);
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

const C = F('payOtFormCheck_');
const D = '2026-11-21';
const W = { sched: { [D]: { t: 'W' } }, hol: {} };
const forms = (ot, tripH) => ({ ot: ot == null ? {} : { [D]: ot }, trip: tripH == null ? {} : { [D]: true }, trip_h: tripH == null ? {} : { [D]: tripH } });
const T = (own, ot, tripH, daily) => C({ ot_own_h: own == null ? {} : { [D]: own }, ot_forms: forms(ot, tripH), daily: daily || W }).trip_ot;

// (a) 上班日 核定 9＝門市 8＋出差 1、有加班單 → 不出現（E02 11/21 實例）
chk('(a) 出差 1＋門市 8＝核定 9、有加班單 1：不出現', T(9, 1, 1), []);
chk('(a2) 出差 2＋門市 6＝核定 8、有加班單：不出現', T(8, 1, 2), []);
// (b) 上班日 核定 8 全部是出差、有加班單 → 出現
chk('(b) 整天出差 8＝核定 8、有加班單：出現', T(8, 2, 8), [D]);
chk('(b2) 整天出差 6＝核定 6、有加班單：出現', T(6, 1, 6), [D]);
// (c) 平日整天出差但沒有加班單 → 跟現在一樣不出現
chk('(c) 整天出差、沒有加班單：不出現', T(8, null, 8), []);
chk('(c2) 加班單 0 小時：不出現', T(8, 0, 8), []);
// (d) 休息日、例假、國定假日 → 跟現在一樣不出現
chk('(d) 休息日整天出差有加班單：不出現', T(8, 2, 8, { sched: { [D]: { t: 'H' } }, hol: {} }), []);
chk('(d) 例假整天出差有加班單：不出現', T(8, 2, 8, { sched: { [D]: { t: 'R' } }, hol: {} }), []);
chk('(d) 國定假日（節日清單）整天出差有加班單：不出現', T(8, 2, 8, { sched: { [D]: { t: 'W' } }, hol: { [D]: true } }), []);
chk('(d) 國定假日假（L＋國）整天出差有加班單：不出現', T(8, 2, 8, { sched: { [D]: { t: 'L', l: '國' } }, hol: {} }), []);
// (e) 沒有出差的日子不受影響
chk('(e) 沒有出差、有加班單：不出現', T(10, 2, null), []);
// 班表查不到（payOtKindOf 回 ''）：跟現在一樣當平日看
chk('班表查不到、整天出差有加班單：出現（同現行，查不到不當休息日）', T(8, 2, 8, { sched: {}, hol: {} }), [D]);
// 邊界（照「出差時數＝核定時數」判）
chk('邊界：同一天兩張出差單 4＋4＝核定 8：出現', C({ ot_own_h: { [D]: 8 }, ot_forms: { ot: { [D]: 1 }, trip: { [D]: true }, trip_h: { [D]: 8 } }, daily: W }).trip_ot, [D]);
chk('邊界：出差 8 ＞ 核定 7（核定少於出差單）：不出現', T(7, 1, 8), []);
chk('邊界：核定 0：不出現', T(0, 1, 8), []);
chk('邊界：還沒核定（沒有核定時數）：不出現', T(null, 1, 8), []);
chk('邊界：差 0.25 小時（7.75 對 8）：不出現', T(8, 1, 7.75), []);
chk('邊界：舊形狀只有 trip 旗標、沒有 trip_h：不出現（看不出時數）', C({ ot_own_h: { [D]: 8 }, ot_forms: { ot: { [D]: 1 }, trip: { [D]: true } }, daily: W }).trip_ot, []);
chk('11/10 不算（11/11 起算，同現行）', C({ ot_own_h: { '2026-11-10': 8 }, ot_forms: { ot: { '2026-11-10': 1 }, trip: { '2026-11-10': true }, trip_h: { '2026-11-10': 8 } }, daily: { sched: { '2026-11-10': { t: 'W' } }, hol: {} } }).trip_ot, []);

// payOtFormsMonth_：出差單時數逐日加總（同一天多張相加），只算已核准；trip 旗標照舊
vm.runInContext(`payHasClock=function(){return true;};
 payClockRead=function(s,sh){return sh==='requests'?globalThis.__REQ:[];};`, sb);
sb.__REQ = [
  { kind: 'trip', status: 'approved', date: D, name: '測試甲', emp_id: 'E02', hours: 1 },
  { kind: 'trip', status: 'approved', date: D, name: '測試甲', emp_id: 'E02', hours: '2.5' },
  { kind: 'trip', status: 'pending', date: D, name: '測試甲', emp_id: 'E02', hours: 4 },
  { kind: 'trip', status: 'cancelled', date: D, name: '測試甲', emp_id: 'E02', hours: 4 },
  { kind: 'ot', status: 'approved', date: D, name: '測試甲', emp_id: 'E02', hours: 1 },
  { kind: 'trip', status: 'approved', date: '2026-10-31', name: '測試甲', emp_id: 'E02', hours: 8 },
];
const M = JSON.parse(JSON.stringify(F('payOtFormsMonth_')('SSLGF', '2026-11')));
chk('出差單時數：只算已核准、同一天相加', M['測試甲'].trip_h, { [D]: 3.5 });
chk('工號鍵也有', M['id:E02'].trip_h, { [D]: 3.5 });
chk('trip 旗標照舊', M['測試甲'].trip, { [D]: true });
chk('加班單照舊', M['測試甲'].ot, { [D]: 1 });

// 加班單缺單（missing，擋鎖月）與舊版逐筆相同；沒有出差的日子 trip_ot 也相同
const OLD = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:apps-script/Payroll.gs'], { encoding: 'utf8' });
const Cold = vm.runInContext('payOtFormCheck_', load(OLD));
let same = 0, diffMiss = 0, diffNoTrip = 0, seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const kinds = ['W', 'H', 'R', 'L', ''];
for (let i = 0; i < 400; i++) {
  const own = {}, ot = {}, trip = {}, trip_h = {}, sched = {}, hol = {};
  for (let k = 0; k < 6; k++) {
    const d = '2026-11-' + String(12 + k);
    if (rnd() < 0.85) own[d] = Math.round(rnd() * 48) / 4;
    if (rnd() < 0.5) ot[d] = Math.round(rnd() * 16) / 4;
    if (rnd() < 0.4) { trip[d] = true; trip_h[d] = rnd() < 0.5 ? own[d] || 0 : Math.round(rnd() * 32) / 4; }
    sched[d] = { t: kinds[Math.floor(rnd() * kinds.length)] };
    if (rnd() < 0.1) hol[d] = true;
  }
  const att = { ot_own_h: own, ot_forms: { ot, trip, trip_h }, daily: { sched, hol } };
  const a = C(JSON.parse(JSON.stringify(att))), b = Cold(JSON.parse(JSON.stringify(att)));
  if (JSON.stringify(a.missing) !== JSON.stringify(b.missing)) diffMiss++;
  const nt = (x) => x.trip_ot.filter((d) => !trip[d]);
  if (JSON.stringify(nt(a)) !== JSON.stringify(nt(b))) diffNoTrip++;
  // 新版列出的一定是舊版也列出、且出差＝核定的日子（只會變少，不會多出新的日子）
  if (a.trip_ot.every((d) => b.trip_ot.indexOf(d) >= 0 && trip_h[d] === own[d] && own[d] > 0)) same++;
}
chk('隨機 400 組：加班單缺單（擋鎖月）與舊版相同', diffMiss, 0);
chk('隨機 400 組：沒有出差的日子與舊版相同', diffNoTrip, 0);
chk('隨機 400 組：新版只列舊版也列、且出差＝核定的日子', same, 400);

// 畫面文字：主管核可的句子，日期照當天
const H = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const line = H.split('\n').find((l) => l.indexOf('o.trip_ot&&o.trip_ot.length') >= 0);
const md = (d) => String(d).slice(5).replace('-', '/');
const list = (a, max) => { a = a || []; const s = a.slice(0, max || 12).map(md).join('、'); return a.length > (max || 12) ? s + ` 等 ${a.length} 天` : s; };
const render = (dates) => { const rows = []; const o = { trip_ot: dates }, nm = '王小明'; eval(line); return rows; };
chk('畫面：一天', render(['2026-11-21']), ['<li><b class="bad">王小明</b>：11/21 整天出差，平日出差不得報加班，請確認加班單</li>']);
chk('畫面：兩天', render(['2026-11-12', '2026-11-21']), ['<li><b class="bad">王小明</b>：11/12、11/21 整天出差，平日出差不得報加班，請確認加班單</li>']);
chk('畫面：沒有就不列', render([]), []);
chk('畫面：helper 與檔案同一份', [H.indexOf("const md=d=>String(d).slice(5).replace('-','/');") >= 0, H.indexOf("const list=(a,max)=>{a=a||[];const s=a.slice(0,max||12).map(md).join('、');return a.length>(max||12)?s+` 等 ${a.length} 天`:s};") >= 0], [true, true]);

console.log(`\n${p} 通過、${f} 失敗`);
process.exit(f ? 1 : 0);
