// 打卡成功問候語（2026-10-08）：時段邊界、上／下班分流、隨機挑句、認不得時回空字串，
// 以及五份門市打卡頁的字句必須一致（擋忘記重跑 build-store-pages.py）。
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('✗ ' + msg); } }

function load(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const a = src.indexOf('  var CLOCK_GREETINGS = {');
  const b = src.indexOf('  function withGreeting(');
  if (a < 0 || b < 0) return null;
  const end = src.indexOf('\n  }\n', b) + 4;
  const code = src.slice(a, end);
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(code + '\nthis.clockGreeting = clockGreeting; this.withGreeting = withGreeting; this.G = CLOCK_GREETINGS;', sb);
  return { sb, code };
}

const main = load('clock.html');
ok(main, 'clock.html 找得到問候語區塊');
const { clockGreeting, withGreeting, G } = main.sb;
const ts = h => '2026-10-08T' + h + ':00+08:00';

// 時段邊界
const cases = [
  ['04:59', 'evening'], ['05:00', 'morning'], ['11:59', 'morning'],
  ['12:00', 'afternoon'], ['17:59', 'afternoon'], ['18:00', 'evening'],
  ['23:59', 'evening'], ['00:00', 'evening'],
];
for (const [hm, slot] of cases) {
  for (const type of ['in', 'out']) {
    ok(clockGreeting(type, ts(hm), 0) === G[type][slot][0], `${type} ${hm} 應落在 ${slot}`);
  }
}
// 隨機挑句：0、0.5、0.999 分別挑到第 1、2、3 句；1 也不能越界
ok(clockGreeting('in', ts('08:00'), 0.5) === G.in.morning[1], 'rnd 0.5 → 第 2 句');
ok(clockGreeting('in', ts('08:00'), 0.999) === G.in.morning[2], 'rnd 0.999 → 第 3 句');
ok(clockGreeting('in', ts('08:00'), 1) === G.in.morning[0], 'rnd 1 不越界');
// 不帶 rnd 也一定在清單內
for (let i = 0; i < 50; i++) ok(G.out.evening.includes(clockGreeting('out', ts('21:30'))), '預設隨機一定在清單內');
// 晚上上班不說「晚安」（道別用語），只有下班才說
ok(G.in.evening.every(s => s.indexOf('晚安') < 0), '晚上上班不出現「晚安」');
ok(G.in.evening.every(s => s.indexOf('晚上好') === 0), '晚上上班一律「晚上好」開頭');
// 通用字句：不帶品牌／門市視角
const all = [].concat(...['in', 'out'].map(t => [].concat(...Object.values(G[t]))));
ok(all.length === 18, '共 18 句');
ok(all.every(s => !/小辛辣|墨竹亭|客人|店裡|味道/.test(s)), '字句不帶品牌／門市視角');
// 認不得就回空字串，withGreeting 只回原句
ok(clockGreeting('in', '', 0) === '', 'ts 空 → 空字串');
ok(clockGreeting('in', 'abc', 0) === '', 'ts 亂碼 → 空字串');
ok(clockGreeting('x', ts('08:00'), 0) === '', 'type 不認得 → 空字串');
ok(withGreeting('✓ 打卡成功', 'in', '') === '✓ 打卡成功', '沒有問候語時不多一行');
ok(/^✓ 打卡成功\n.+/.test(withGreeting('✓ 打卡成功', 'out', ts('20:00'))), '有問候語時接在下一行');

// 五份門市打卡頁的問候語區塊必須一字不差
for (const f of ['clock-cf.html', 'clock-hq.html', 'clock-mztjs.html', 'clock-mztgf.html']) {
  const other = load(f);
  ok(other && other.code === main.code, `${f} 的問候語與 clock.html 一致（改母版後要重跑 build-store-pages.py）`);
}

console.log(`clock-greeting：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
