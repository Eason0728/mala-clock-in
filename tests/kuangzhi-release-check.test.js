/* 曠職上線檢查（2026-11-26）：主管已定第 6-1 題算式，「待主管確認」佔位旗標 KUANGZHI_DEDUCT_PENDING 已拿掉。
 * 這支釘住：①現在的版本 tools/kuangzhi-release-check.js 通過；②又出現佔位旗標的版本 → 結束碼 1；③檔案不對 → 失敗。
 * 只讀檔，暫存放 KZ_TMP（沒給用系統暫存）。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'kuangzhi-release-check.js');
let pass = 0, fail = 0;
const eq = (got, want, m) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g + '\n   預期 ' + w); } };
const run = (args) => cp.spawnSync('node', [TOOL].concat(args || []), { encoding: 'utf8' });

const r = run();
eq([r.status, /通過/.test(r.stdout)], [0, true], '① 佔位旗標已拿掉（主管 2026-11-26 定案扣款算式）：上線檢查通過');

const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
eq(/^var KUANGZHI_DEDUCT_PENDING\b/m.test(P), false, 'Payroll.gs 沒有 KUANGZHI_DEDUCT_PENDING 旗標');
const dir = fs.mkdtempSync(path.join(process.env.KZ_TMP || os.tmpdir(), 'kz-rel-'));
try {
  const f = path.join(dir, 'Payroll.gs');
  fs.writeFileSync(f, P + '\nvar KUANGZHI_DEDUCT_PENDING = true;\n');
  const r2 = run([f]);
  eq([r2.status, /佔位旗標/.test(r2.stdout)], [1, true], '② 又出現佔位旗標的版本：上線檢查失敗（證明檢查真的看旗標）');
  fs.writeFileSync(f, 'var x = 1;');
  eq(run([f]).status, 1, '③ 檔案不對（沒有 payKzReleaseProblems_）：一律失敗');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('\n' + pass + ' 過、' + fail + ' 失敗');
if (fail) process.exit(1);
