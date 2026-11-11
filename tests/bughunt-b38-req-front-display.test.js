/* B38（2026-11-10 挑錯）：申請頁（req-line.js）兩個顯示上的問題。
 *  ① 2026-11-10 加了第二個同名的 spanHours（不取整），同名的函式後面的會蓋掉前面的，
 *     整頁的時數都變成沒取整的——加班 17:00–17:20 顯示成「共 0.3333333333333333 小時」。
 *  ② 「台北的今天」經過手機自己的時區換算；手機時區有夏令時間時，加減天數剛好跨過換時間的那一天會差一天
 *     （日期選單的範圍、預設日期跟著錯）。
 * 做法：整檔載入真的 req-line.js（檔尾多掛一個測試用的出口）；②在子行程把時區設成紐約、時鐘固定在換時間那一天。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const FILE = path.join(__dirname, '..', 'req-line.js');

function load(nowMs) {
  const src = fs.readFileSync(FILE, 'utf8');
  const TAIL = 'window.ReqLine = { open: open };';
  if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
  const hooked = src.replace(TAIL, TAIL + ' window.__t = { spanHours: spanHours, taipeiToday: taipeiToday };');
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(nowMs); } static now() { return nowMs; } }
  const sb = { window: {}, document: {}, console, Promise, setTimeout, Date: nowMs === undefined ? RealDate : FakeDate, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
  vm.createContext(sb);
  vm.runInContext(hooked, sb, { filename: 'req-line.js' });
  return sb.window.__t;
}

if (process.argv[2] === 'child') {   // 子行程：時區由環境變數 TZ 決定
  const t = load(Number(process.argv[3]));
  console.log(JSON.stringify([t.taipeiToday(0), t.taipeiToday(-1), t.taipeiToday(-7), t.taipeiToday(90)]));
  process.exit(0);
}

let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     實際=' + JSON.stringify(got) + '\n     預期=' + JSON.stringify(want))); };
const t = load();
chk('時數取到小數兩位：17:00–17:20 → 0.33', t.spanHours('17:00', '17:20'), 0.33);
chk('18:00–19:10 → 1.17', t.spanHours('18:00', '19:10'), 1.17);
chk('整點照舊：09:00–18:00 → 9', t.spanHours('09:00', '18:00'), 9);
chk('跨午夜：22:00–01:30 → 3.5', t.spanHours('22:00', '01:30'), 3.5);
chk('時間還沒填 → 沒有時數（畫面不顯示「共 … 小時」）', [t.spanHours('', '18:00'), t.spanHours('09:00', '')], [null, null]);
chk('檔案裡只剩一個 spanHours', (fs.readFileSync(FILE, 'utf8').match(/function spanHours\(/g) || []).length, 1);

// 台北 2026-11-01 23:30（＝UTC 15:30）。紐約 2026-11-01 02:00 結束夏令時間，前一天還是夏令時間。
const NOW = Date.UTC(2026, 10, 1, 15, 30, 0);
const WANT = ['2026-11-01', '2026-10-31', '2026-10-25', '2027-01-30'];
['Asia/Taipei', 'America/New_York', 'Europe/London', 'UTC', 'Pacific/Auckland'].forEach((tz) => {
  const out = cp.execFileSync(process.execPath, [__filename, 'child', String(NOW)], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' }).trim();
  chk('手機時區 ' + tz + '：台北 11/1 23:30 的今天、昨天、7 天前、90 天後', JSON.parse(out), WANT);
});
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
