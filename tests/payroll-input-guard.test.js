/**
 * 薪資主檔輸入防護（2026-11-10 資安審計後）：
 *  1. 存主檔時員工編號要合格式；2. 薪資分頁寫入時，文字開頭的 = + - @ 不能變公式；
 *  3. payroll.html 把資料放進 HTML 或按鈕指令前要先處理。全部用假資料。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m); } };
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const KEY = 'test-admin-key';

/* ── 1. 主檔存檔的編號格式 ── */
function masterEnv() {
  const s = load({ data: { master: [{ emp_id: 'E1', name: '甲', store: 'SSLGF', active: 'true' }], input: [] } });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  return s;
}
function saveIds(ids) {
  const s = masterEnv();
  const master = ids.map(id => ({ emp_id: id, name: '乙', store: 'SSLGF', active: 'true' }));
  const r = s.call('handlePayrollMasterSet', { admin_key: KEY, store: 'SSLGF', master });
  return { r, rows: s.__DATA.master };
}
for (const id of ['E1', 'MZT-3', 'a_b', 'HQ0012', 123, 'A'.repeat(32)]) {
  ok(saveIds([id]).r.ok === true, '合格編號可存：' + String(id).slice(0, 12));
}
const BAD = [`x');alert(1)//`, '<img src=x onerror=1>', 'a b', '=1+1', '員工1', '', '   ', null, 'A'.repeat(33)];
for (const id of BAD) {
  const { r, rows } = saveIds(['E2', id]);
  ok(r.ok === false && r.error === 'bad_emp_id', '不合格編號被擋：' + JSON.stringify(id).slice(0, 24));
  ok(!!r.message && /英文、數字/.test(r.message), '擋下時有中文說明：' + JSON.stringify(id).slice(0, 24));
  ok(rows.length === 1 && rows[0].emp_id === 'E1', '整批不存，原資料不動：' + JSON.stringify(id).slice(0, 24));
}

/* ── 2. 寫入層（payReplaceAll／payAppend 本體，只把試算表換成記錄器）── */
function writerEnv() {
  const written = [];
  const range = { setValues: v => written.push(v), clearContent() {}, setNumberFormat() { return range; } };
  const sheet = { getRange: () => range, getLastRow: () => 1, getMaxRows: () => 10 };
  const s = { console, Logger: { log() {} }, written };
  vm.createContext(s);
  const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
  vm.runInContext(C + '\n' + P, s, { filename: 'gs' });
  s.__sheet = sheet;
  vm.runInContext('paySheet = function () { return __sheet; };', s);
  return s;
}
const CASES = [
  ['=IMPORTDATA("x")', '＝IMPORTDATA("x")'], ['+SUM(1)', '＋SUM(1)'], ['-A1', '－A1'], ['@x', '＠x'],
  ['  =1+1', '  ＝1+1'], ['\t=1', '\t＝1'],
  ['-500', '-500'], ['+12', '+12'], ['-1.5', '-1.5'], ['2026-11', '2026-11'], ['王小明', '王小明'], ['{"a":1}', '{"a":1}'], ['', ''],
];
function written(fnName) {
  const s = writerEnv();
  const row = o => ({ emp_id: 'E1', name: o });
  s.__rows = CASES.map(c => row(c[0]));
  vm.runInContext(`${fnName}('master', __rows)`, s);
  const nameCol = 1;
  return s.written[s.written.length - 1].map(v => v[nameCol]);
}
for (const fnName of ['payReplaceAll', 'payAppend']) {
  const got = written(fnName);
  CASES.forEach((c, i) => ok(got[i] === c[1], `${fnName} ${JSON.stringify(c[0])} → ${JSON.stringify(c[1])}`));
}
{
  const s = writerEnv();
  s.__rows = [{ emp_id: 'E1', wage: -500, active: true }];
  vm.runInContext(`payReplaceAll('master', __rows)`, s);
  const line = s.written[s.written.length - 1][0];
  ok(line[0] === 'E1' && line.indexOf(-500) !== -1 && line.indexOf(true) !== -1, '數字與布林值原樣寫入');
}

/* ── 3. payroll.html ── */
const handlers = html.match(/\bon(click|change|input)="[^"]*"/g) || [];
ok(handlers.length > 30, '抓得到按鈕指令（' + handlers.length + ' 個）');
ok(!handlers.some(h => /'\$\{(e\.emp_id|esc\(|sid)/.test(h)), '按鈕指令裡沒有把編號包在單引號直接放入');
ok(!/ATT\['\$\{/.test(html), '工時表沒有 ATT[\'${...}\'] 寫法');
ok(!/onchange="\$\{onL\}"[^`]*\n[^`]*ATT\['/.test(html), '自訂加薪沒有舊寫法');

function pick(re, label) { const m = re.exec(html); ok(!!m, '找得到 ' + label); return m ? m[0] : ''; }
const escSrc = pick(/const esc=s=>String\(s==null\?'':s\)\s*\.replace[\s\S]*?&#39;'\);/, 'esc');
const jsaSrc = pick(/const jsa=s=>[^\n]*;/, 'jsa');
const xlsSrc = pick(/const xlsText=s=>[^\n]*;/, 'xlsText');
const box = {};
vm.createContext(box);
vm.runInContext(`${escSrc}\n${jsaSrc}\n${xlsSrc}\nthis.esc=esc;this.jsa=jsa;this.xlsText=xlsText;`, box);
const unHtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const evil of [`x');alert(1)//`, `a"b`, `</b><img src=x>`, `\\'`, 'E1', "'+alert(1)+'"]) {
  const attr = box.jsa(evil);
  ok(!/["<>']/.test(attr), 'jsa 輸出放進雙引號屬性不會斷開：' + evil);
  box.__code = unHtml(attr);
  ok(vm.runInContext('eval("(" + __code + ")")', box) === evil, 'jsa 解回來和原字串相同：' + evil);
}
ok(box.xlsText('=1+1').startsWith('＝'), '匯出 Excel 開頭 = 轉成純文字');
ok(box.xlsText('-A1').startsWith('－'), '匯出 Excel 開頭 - 轉成純文字');
ok(box.xlsText('-500') === '-500', '匯出 Excel 負數不動');
ok(box.xlsText('<b>') === '&lt;b>', '匯出 Excel 仍轉義 <');

for (const [needle, label] of [
  ['esc(nameOf(b.emp_id))', '獎金表姓名'], ['esc(x.manager_name||', '出勤核定人'], ['esc(x.periods||', '出勤核定時段'],
  ['esc(A.support_error)', '支援資料錯誤訊息'], ['${esc(STORE)}', '對帳區門市代碼'], ['bad.map(x=>esc(x.name||x.code))', '缺打卡試算表的門市名'],
]) ok(html.includes(needle), label + ' 有轉義');
ok(!/讀取失敗：'\+\(r\.error\|\|''\)\+'/.test(html), '讀取失敗訊息有轉義');
ok(/toast\('儲存失敗：'\+\(r\.message\|\|r\.error\|\|''\),true\);return false}\s*\n\s*renderEmp\(\)/.test(html), '主檔存檔失敗會顯示中文說明');

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
