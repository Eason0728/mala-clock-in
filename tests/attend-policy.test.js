/* 全勤扣減政策（2026-08-23 Eason 定案，依法）：
 *   只有「事假／病假／住院傷病假」可以扣全勤；其餘假別一律不得扣發全勤獎金
 *   （勞工請假規則§9：婚喪公傷公假；性平法§21：生理、家庭照顧、產假、產檢、陪產、育嬰；特休依勞動部見解）。
 * 這支把政策本身變成可重跑的檢查——內建預設值被誰改動都會紅。
 * 另驗：廢棄參數 shortfall_deduct 已從 PAY_CONFIG_DEFAULT 移除。*/
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const a = P.indexOf('function payR0'), b = P.indexOf('/* ═══════════════════ Handlers');
const sb = { console };
vm.createContext(sb);
vm.runInContext("function pad2(n){return ('0'+n).slice(-2)}\n" + P.slice(a, b), sb);
const types = vm.runInContext('payLeaveTypes', sb)('');

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

const MAY_DEDUCT = ['personal', 'sick', 'sick_hosp'];   // 依法可扣全勤的唯三

console.log('══ 內建預設：哪些假可以扣全勤 ══');
const checked = types.filter(t => t.count_absent).map(t => t.code).sort();
chk('可扣全勤的只有事假／病假／住院傷病假', checked, [...MAY_DEDUCT].sort());

// 逐項點名，讓誰被改動時錯誤訊息看得出是哪一種假
const MUST_NOT = [['annual', '特休假'], ['menstrual', '生理假'], ['family', '家庭照顧假'],
  ['funeral8', '喪假（父母・配偶）'], ['funeral6', '喪假（祖父母等）'], ['funeral3', '喪假（曾祖父母等）'],
  ['marriage', '婚假'], ['occupational', '公傷病假'], ['official', '公假'],
  ['maternity', '產假'], ['prenatal', '產檢假'], ['paternity', '陪產檢及陪產假'],
  ['parental', '育嬰假'], ['disaster', '天災假'], ['trip', '出差']];
console.log('\n══ 逐項：這些依法都不得扣全勤 ══');
MUST_NOT.forEach(([code, label]) => {
  const t = types.find(x => x.code === code);
  chk(`  ${label}不扣全勤`, t ? t.count_absent : '找不到此假別', false);
});
console.log('\n══ 逐項：這三種可以扣 ══');
MAY_DEDUCT.forEach(code => {
  const t = types.find(x => x.code === code);
  chk(`  ${t ? t.name : code}可扣全勤`, t ? t.count_absent : '找不到此假別', true);
});

console.log('\n══ 廢棄參數已移除 ══');
const cfgKeys = vm.runInContext('typeof PAY_CONFIG_DEFAULT !== "undefined" ? PAY_CONFIG_DEFAULT.map(function(d){return d[0]}) : null', sb)
  || P.slice(P.indexOf('const PAY_CONFIG_DEFAULT'), P.indexOf('/* ═══════════════════ 分頁工具'))
       .split('\n').map(l => (l.match(/^\s*\['([a-z_]+)'/) || [])[1]).filter(Boolean);
chk('shortfall_deduct 已不在預設參數清單', cfgKeys.indexOf('shortfall_deduct'), -1);
chk('meal_min_hours 仍在（設定頁要用）', cfgKeys.indexOf('meal_min_hours') >= 0, true);
chk('attend_forget_unit 仍在（設定頁要用）', cfgKeys.indexOf('attend_forget_unit') >= 0, true);

console.log(`\n${fail ? '❌ 有失敗' : '✅ 全勤政策全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
