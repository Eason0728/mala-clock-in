#!/usr/bin/env node
// 不到場加綁主店（2026-11-27）變異測試：把四個條件 (a)(b)(c)(d)、開關、次數限制、驗收修正（同店兩列、未來日期、放行前現讀、斷路、連帶停用保護與它的開關、判斷不了照停）各自拿掉，
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
    "var t = homeRows.filter(function (r) { return lineBindHomeId_(r.emp_id) === p.target_id; });",
    "var t = homeRows.filter(function (r) { return String(r.name) === String(src.row.name) && !r.line_user_id; });"],
  ['c4 acct_only 不排除', "if (r.acct_only === true || String(r.acct_only == null ? '' : r.acct_only).trim().toLowerCase() === 'true') return;", ''],
  ['c5 同步日期不檢查', 'if (!(t >= lim && t <= now + LINE_BIND_HOME_FUTURE_MS)) return;', ''],
  ['c6 未來日期不擋（驗收 3）', 'if (!(t >= lim && t <= now + LINE_BIND_HOME_FUTURE_MS)) return;', 'if (!(t >= lim)) return;'],
  ['c7 放行前不現讀對照（驗收 4）', 'var d = lineBindHomeDecide_(userId, mine, lineBindHomeXmap_(), lineBindHomeXmapBuild_);', 'var d = lineBindHomeDecide_(userId, mine, lineBindHomeXmap_());'],
  ['d1 目標店改成「任何一家有對照帳號、還沒綁的店」（不看主店）',
    'var homeCode = hm.code;',
    "var homeCode = null; Object.keys(ent.accts).forEach(function (k) { var cc = k.slice(2); if (homeCode === null && !mine.some(function (m) { return String(m.st.code) === cc; })) homeCode = cc; });"],
  ['d2 主店不只一種不擋', "if (hk.length !== 1) return { reason: 'home_ambiguous' };", ''],
  ['e1 同店兩列綁同一支 LINE：兩道都拿掉（驗收 2）', "if (per[pc]) return no('line_conflict');", '', "if (srcRows.filter(function (r) { return lineHubActive_(r) && String(r.line_user_id || '') === uid; }).length > 1) return no('line_conflict');", ''],
  ['e2 同店兩列：只拿掉即時重讀那一道', "if (srcRows.filter(function (r) { return lineHubActive_(r) && String(r.line_user_id || '') === uid; }).length > 1) return no('line_conflict');", ''],
  ['h1 慢的主店不記斷路（驗收 5）', "if (!j || Date.now() - t1 > LINE_BIND_HOME_SLOW_MS) c.put('lbhs:' + code, '1', LINE_BIND_HOME_SLOW_TTL);", ''],
  ['h2 判斷太久照打主店', "if (Date.now() - t0 > LINE_BIND_HOME_BUDGET_MS) return { act: false, reason: 'slow_reads' };", ''],
  ['h3 同一家同時不限一筆', "if (c.get('lbhs:' + code) || c.get('lbhq:' + code)) return { act: false, reason: 'home_slow' };", "if (c.get('lbhs:' + code)) return { act: false, reason: 'home_slow' };"],
  ['i1 連帶停用不保護主店帳號（驗收 1）', "return kind !== 'home';", 'return true;'],
  ['i2 連帶停用：對照讀不到當成主店帳號（不停）', "if (!cache.xi) return 'unknown';", "if (!cache.xi) return 'home';"],
  ['i3 連帶停用：支援列也問對照', "if (String(r.src_store || '').trim()) return true;\n          var kind;", "var kind;"],
  ['i4 連帶停用不看開關（第一輪驗收擋項）', "if (homeKeep === undefined) homeKeep = lineBindHomeOn_('LINE_BIND_HOME_ON') ? {} : null;", 'if (homeKeep === undefined) homeKeep = {};'],
  ['i5 連帶停用：判斷不了改回「不停用」（9618ea9 的做法）', "return kind !== 'home';", "return kind === 'stop';"],
  ['i6 連帶停用：判斷出錯當成主店帳號', "catch (e) { kind = 'unknown'; }", "catch (e) { kind = 'home'; }"],
  ['i7 連帶停用：對到兩個人當成主店帳號', "if (el.length > 1) return 'unknown';", "if (el.length > 1) return 'home';"],
  ['i8 連帶停用：主店不只一種當成主店帳號', "if (hm.reason === 'home_ambiguous') return 'unknown';", "if (hm.reason === 'home_ambiguous') return 'home';"],
  ['i9 連帶停用：改回「人加店」（主店整家留著，不看是哪一列）', "return ids.length === 1 && ids[0] === lineBindHomeId_(row.emp_id) ? 'home' : 'stop';", "return 'home';"],
  ['i10 連帶停用：主店兩個帳號對到同一人也保護（歧義不照停）', "return ids.length === 1 && ids[0] === lineBindHomeId_(row.emp_id) ? 'home' : 'stop';", "return ids.indexOf(lineBindHomeId_(row.emp_id)) >= 0 ? 'home' : 'stop';"],
  ['開關 改成「不是 0 就開」', "return PropertiesService.getScriptProperties().getProperty(name) === '1';", "return PropertiesService.getScriptProperties().getProperty(name) !== '0';"],
  ['次數限制拿掉', "if (lineHubThrottled_('bind', userId, 5, 600)) return { act: false, reason: 'too_many' };", ''],
];
const dir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(ROOT, '.mutant-'));
fs.mkdirSync(dir, { recursive: true });
let survived = 0;
for (const [name, ...pairs] of M) {
  let src = SRC, bad = false;
  for (let i = 0; i < pairs.length; i += 2) {
    const cnt = src.split(pairs[i]).length - 1;
    if (cnt !== 1) { console.log('✗ 找不到（或不只一處）要變異的那一行：' + name + '（' + cnt + ' 處）'); bad = true; break; }
    src = src.replace(pairs[i], pairs[i + 1]);
  }
  if (bad) { survived++; continue; }
  const f = path.join(dir, 'LineHub.mut.gs');
  fs.writeFileSync(f, src);
  const r = spawnSync('node', [ROOT + '/tests/line-bind-home.test.js'], { encoding: 'utf8', env: Object.assign({}, process.env, { LINE_BIND_HOME_SRC: f, LINE_BIND_HOME_KEEP_GOING: '1' }) });
  const red = (r.stdout || '').split('\n').filter(l => l.indexOf('✗ ') === 0).map(l => l.slice(2, 40));
  if (r.status === 0) { survived++; console.log('✗ 活下來（沒有測試變紅）：' + name); }
  else console.log('✓ ' + name + ' → 紅 ' + red.length + ' 條：' + red.join('｜') + (red.length ? '' : (r.stderr || '').slice(0, 200)));
}
if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (M.length - survived) + '／' + M.length + ' 個變異被抓到' + (survived ? '，' + survived + ' 個活下來' : ''));
process.exit(survived ? 1 : 0);
