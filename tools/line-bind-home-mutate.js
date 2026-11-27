#!/usr/bin/env node
// 不到場加綁主店（2026-11-27）變異測試：把四個條件 (a)(b)(c)(d) 與開關、次數限制各自拿掉，
// 跑 tests/line-bind-home.test.js，每個變異至少要有一條測試變紅。不在 run-all（要跑十幾次測試檔）。
//   node tools/line-bind-home-mutate.js [暫存資料夾]    （沒給就在 repo 裡建 .mutant-*，跑完刪掉）
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8');
const M = [
  ['a 已綁那列不即時重讀（在職、仍綁這支 LINE）',
    "if (s.length !== 1 || !lineHubActive_(s[0]) || String(s[0].line_user_id || '') !== uid) return no('src_changed');",
    "if (s.length !== 1) return no('src_changed');"],
  ['b1 姓名不比對', "if (!sn || sn !== String(t.name == null ? '' : t.name)) return no('name_mismatch');", ''],
  ['b2 目標列在職不檢查', "if (!lineHubActive_(t)) return no('home_inactive');", ''],
  ['b3 目標列已綁別人不檢查', "if (String(t.line_user_id || '')) return no('home_taken');", ''],
  ['b4 主店名冊綁過這支 LINE 不檢查', "if (homeRows.some(function (r) { return String(r.line_user_id || '') === uid; })) return no('home_line_seen');", ''],
  ['b5 解除過不檢查', "if (log.some(function (r) { return String(r.emp_id) === String(t.emp_id) && String(r.type || '').indexOf('unbind') === 0; })) return no('unbound_before');", ''],
  ['c1 對照要 confirmed 拿掉', "if (String(r.state == null ? '' : r.state).trim().toLowerCase() !== 'confirmed') return;", ''],
  ['c2 對到不同工號不擋', "if (el.length > 1) return no('mapped_multi');", ''],
  ['c3 目標列改用姓名找（不靠對照工號）',
    "var t = homeRows.filter(function (r) { return lineBindHomeId_(r.emp_id) === ids[0]; });",
    "var t = homeRows.filter(function (r) { return String(r.name) === String(src.row.name) && !r.line_user_id; });"],
  ['c4 acct_only 不排除', "if (r.acct_only === true || String(r.acct_only == null ? '' : r.acct_only).trim().toLowerCase() === 'true') return;", ''],
  ['c5 同步日期不檢查', 'if (!(lineBindHomeMs_(r.synced_at) >= lim)) return;', ''],
  ['d1 目標店改成「任何一家有對照帳號、還沒綁的店」（不看主店）',
    'var homeCode = ent.homes[hk[0]];',
    "var homeCode = null; Object.keys(ent.accts).forEach(function (k) { var cc = k.slice(2); if (homeCode === null && !mine.some(function (m) { return String(m.st.code) === cc; })) homeCode = cc; });"],
  ['d2 主店不只一種不擋', "if (hk.length !== 1) return no('home_ambiguous');", ''],
  ['開關 改成「不是 0 就開」', "return PropertiesService.getScriptProperties().getProperty(name) === '1';", "return PropertiesService.getScriptProperties().getProperty(name) !== '0';"],
  ['次數限制拿掉', "if (lineHubThrottled_('bind', userId, 5, 600)) return { act: false, reason: 'too_many' };", ''],
];
const dir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(ROOT, '.mutant-'));
fs.mkdirSync(dir, { recursive: true });
let survived = 0;
for (const [name, from, to] of M) {
  const cnt = SRC.split(from).length - 1;
  if (cnt !== 1) { console.log('✗ 找不到（或不只一處）要變異的那一行：' + name + '（' + cnt + ' 處）'); survived++; continue; }
  const f = path.join(dir, 'LineHub.mut.gs');
  fs.writeFileSync(f, SRC.replace(from, to));
  const r = spawnSync('node', [ROOT + '/tests/line-bind-home.test.js'], { encoding: 'utf8', env: Object.assign({}, process.env, { LINE_BIND_HOME_SRC: f, LINE_BIND_HOME_KEEP_GOING: '1' }) });
  const red = (r.stdout || '').split('\n').filter(l => l.indexOf('✗ ') === 0).map(l => l.slice(2, 40));
  if (r.status === 0) { survived++; console.log('✗ 活下來（沒有測試變紅）：' + name); }
  else console.log('✓ ' + name + ' → 紅 ' + red.length + ' 條：' + red.join('｜') + (red.length ? '' : (r.stderr || '').slice(0, 200)));
}
if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (M.length - survived) + '／' + M.length + ' 個變異被抓到' + (survived ? '，' + survived + ' 個活下來' : ''));
process.exit(survived ? 1 : 0);
