/**
 * 月表重算的「打烊尖峰不跑」守門（2026-09-21）。
 * 起因：2026-09-20 實測金山 21:14–21:42 有 32–45% 的請求失敗或超過一分鐘，
 * 同一時段晚上沒人打卡的央廚 0%——判斷是「整月重寫」與同仁下班打卡擠在一起互搶同一份試算表。
 * 這支釘住三件事：①20–23 點回 true、其餘回 false ②refreshCurrentMonth 第一行就是這道守門
 * （不是擺在搶鎖或讀表之後，那樣就沒省到）③兩處建立觸發器都是 30 分鐘。
 * 照 skill 慣例：從 Code.gs 抽真函式跑，不要自己重寫一份模擬版。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}

// ── 抽真函式（const 不會掛到 sandbox，要用 runInContext 取）──
const sandbox = {};
vm.createContext(sandbox);
const quietConst = SRC.match(/const MONTH_REFRESH_QUIET_HOURS = \[[^\]]*\];/);
const quietFn = SRC.match(/function isMonthRefreshQuietHour\(taipeiIso\) \{[\s\S]*?\n\}/);
check('Code.gs 裡有 MONTH_REFRESH_QUIET_HOURS', !!quietConst);
check('Code.gs 裡有 isMonthRefreshQuietHour', !!quietFn);
if (quietConst && quietFn) {
  vm.runInContext(quietConst[0] + '\n' + quietFn[0], sandbox);
  const isQuiet = vm.runInContext('isMonthRefreshQuietHour', sandbox);
  for (let h = 0; h < 24; h++) {
    const iso = '2026-09-21T' + String(h).padStart(2, '0') + ':17:00+08:00';
    const want = h >= 20 && h <= 23;
    check(h + ' 點應該' + (want ? '跳過' : '重算'), isQuiet(iso) === want);
  }
  // 邊界：19:59 要跑、20:00 要跳、23:59 要跳、00:00 要跑
  check('19:59 重算', isQuiet('2026-09-21T19:59:59+08:00') === false);
  check('20:00 跳過', isQuiet('2026-09-21T20:00:00+08:00') === true);
  check('23:59 跳過', isQuiet('2026-09-21T23:59:59+08:00') === true);
  check('00:00 重算', isQuiet('2026-09-22T00:00:00+08:00') === false);
}

// ── 守門必須在最前面（搶鎖、讀表之前）──
const body = SRC.match(/function refreshCurrentMonth\(\) \{([\s\S]*?)\n\}/);
check('找得到 refreshCurrentMonth', !!body);
if (body) {
  const lines = body[1].split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !l.startsWith('//'); });
  check('第一行就是打烊守門', lines[0] === 'if (isMonthRefreshQuietHour(nowTaipeiIso())) return;');
  check('守門在搶鎖之前', body[1].indexOf('isMonthRefreshQuietHour') < body[1].indexOf('getScriptLock'));
}

// ── 兩處建立觸發器都要是 30 分鐘 ──
check('沒有殘留的 everyMinutes(10)', !/everyMinutes\(10\)/.test(SRC));
check('兩處都是 everyMinutes(30)', (SRC.match(/refreshCurrentMonth'\)\.timeBased\(\)\.everyMinutes\(30\)/g) || []).length === 2);

if (fails.length) {
  console.log('❌ 月表打烊守門有 ' + fails.length + ' 項不正確：');
  fails.forEach(function (f) { console.log('   - ' + f); });
  process.exit(1);
}
console.log('✅ 月表打烊尖峰守門全部正確 (' + pass + '/' + pass + ')');
