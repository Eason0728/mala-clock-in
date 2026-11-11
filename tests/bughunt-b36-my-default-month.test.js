/* B36③（2026-11-10 挑錯）：個人薪資頁（my.html）的月份欄寫死 2026-06，11 月開頁預設查的是 6 月。
 * 修正：開頁時把月份欄設成台北的當月（不看手機時區）。B36 另外兩項在舊值班核定頁（manager.html，12/1 停用），沒有改。
 * 做法：從真的 my.html 取出 defaultYm 來跑。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'my.html'), 'utf8');
let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '\n     實際=' + JSON.stringify(got) + '\n     預期=' + JSON.stringify(want))); };
function defaultYmAt(iso) {
  const m = /function defaultYm\([^)]*\)\{[^\n]*\}/.exec(SRC);
  if (!m) return 'my.html 找不到 defaultYm';
  const sb = { Date, String };
  vm.createContext(sb);
  return vm.runInContext(m[0] + '\ndefaultYm(' + Date.parse(iso) + ')', sb);
}
if (process.argv[2] === 'child') { console.log(JSON.stringify(process.argv.slice(3).map(defaultYmAt))); process.exit(0); }
chk('2026-11-10 開頁 → 2026-11', defaultYmAt('2026-11-10T09:00:00+08:00'), '2026-11');
chk('台北 12/1 00:30（世界標準時間還在 11/30）→ 2026-12', defaultYmAt('2026-12-01T00:30:00+08:00'), '2026-12');
chk('台北 2027-01-01 07:59 → 2027-01', defaultYmAt('2027-01-01T07:59:00+08:00'), '2027-01');
chk('台北 11/30 23:59 → 2026-11', defaultYmAt('2026-11-30T23:59:00+08:00'), '2026-11');
['America/New_York', 'Pacific/Auckland'].forEach((tz) => {
  const out = cp.execFileSync(process.execPath, [__filename, 'child', '2026-12-01T00:30:00+08:00', '2026-11-30T23:59:00+08:00'], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' }).trim();
  chk('手機時區 ' + tz + ' 也一樣', JSON.parse(out), ['2026-12', '2026-11']);
});
chk('月份欄不再寫死 2026-06', /id="ym" value="2026-06"/.test(SRC), false);
chk('開頁先設月份再載入', /getElementById\('ym'\)\.value=defaultYm\(\);[\s\S]{0,200}load\(\)/.test(SRC), true);
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
