/* tools/deploy-to-clasp.py：WHOLE_FILES 第三欄 new_ok（AttDigest.gs 允許新增）。只用暫存假專案，不碰 ~/mala-gas、不碰 clasp。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`); };

const STORES = ['mala-clock-in', 'cf-clock-in', 'hq-clock-in', 'mztjs-clock-in', 'mztgf-clock-in', 'mztlzl-clock-in', 'mztmc-clock-in', 'mztrg-clock-in', 'mztwx-clock-in'];
const gas = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-'));
const code = fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8');
STORES.forEach(st => { fs.mkdirSync(path.join(gas, st)); fs.writeFileSync(path.join(gas, st, '程式碼.js'), code); });
fs.copyFileSync(path.join(ROOT, 'apps-script/Payroll.gs'), path.join(gas, 'mala-clock-in', 'Payroll.js'));
fs.copyFileSync(path.join(ROOT, 'apps-script/Requests.gs'), path.join(gas, 'mala-clock-in', 'Requests.js'));   // 既有檔：照一般流程

const run = args => spawnSync('python3', [path.join(ROOT, 'tools/deploy-to-clasp.py'), '--gas-root', gas].concat(args), { encoding: 'utf8' });

const d = run([]);
chk('dry-run：九家都印「將新增 AttDigest.js」', (d.stdout.match(/將新增 AttDigest\.js/g) || []).length, 9);
chk('dry-run：不寫檔', STORES.some(st => fs.existsSync(path.join(gas, st, 'AttDigest.js'))), false);
chk('dry-run：其他既有檔維持原行為（Liff.js 每家都沒有 → 沒有套、不新增）', /每家專案都沒有 Liff\.js，沒有套/.test(d.stdout), true);
chk('dry-run：Liff.js 沒被新增', STORES.some(st => fs.existsSync(path.join(gas, st, 'Liff.js'))), false);

const a = run(['--apply']);
chk('--apply：九家都寫入與 repo 相同的 AttDigest.js',
  STORES.every(st => fs.readFileSync(path.join(gas, st, 'AttDigest.js'), 'utf8') === fs.readFileSync(path.join(ROOT, 'apps-script/AttDigest.gs'), 'utf8')), true);
const d2 = run([]);
chk('套完再 dry-run：AttDigest.js 已是最新、不再「將新增」', [/將新增/.test(d2.stdout), /mala-clock-in\/AttDigest\.js：已是最新/.test(d2.stdout)], [false, true]);
fs.rmSync(gas, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
