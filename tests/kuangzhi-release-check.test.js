/* 曠職上線檢查（2026-11-26）：主管改定第 6-1 題「全薪÷ 30 × 曠職天數」細節待確認，扣款先放佔位（KUANGZHI_DEDUCT_PENDING）。
 * 這支釘住：①旗標還在 → tools/kuangzhi-release-check.js 結束碼 1、印出原因；②把旗標改成 false 的版本 → 通過（證明檢查真的看旗標）。
 * ⚠ 換成正式算法、拿掉旗標的那一次，①要改成「通過」——那是預期中的改動，不是測試壞掉。只讀檔，暫存放 KZ_TMP（沒給用系統暫存）。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'kuangzhi-release-check.js');
let pass = 0, fail = 0;
const eq = (got, want, m) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g + '\n   預期 ' + w); } };
const run = (args) => cp.spawnSync('node', [TOOL].concat(args || []), { encoding: 'utf8' });

const r = run();
eq([r.status, /待主管確認/.test(r.stdout)], [1, true], '① 旗標還在（KUANGZHI_DEDUCT_PENDING = true）：上線檢查失敗、說明原因');

const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');
eq((P.match(/^var KUANGZHI_DEDUCT_PENDING = true;$/m) || []).length, 1, '旗標在 Payroll.gs 只有一處、目前是 true');
const dir = fs.mkdtempSync(path.join(process.env.KZ_TMP || os.tmpdir(), 'kz-rel-'));
try {
  const f = path.join(dir, 'Payroll.gs');
  fs.writeFileSync(f, P.replace(/^var KUANGZHI_DEDUCT_PENDING = true;$/m, 'var KUANGZHI_DEDUCT_PENDING = false;'));
  const r2 = run([f]);
  eq([r2.status, /通過/.test(r2.stdout)], [0, true], '② 旗標改成 false 的版本：上線檢查通過（證明檢查看的是旗標）');
  fs.writeFileSync(f, 'var x = 1;');
  eq(run([f]).status, 1, '③ 檔案不對（沒有 payKzReleaseProblems_）：一律失敗');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('\n' + pass + ' 過、' + fail + ' 失敗');
if (fail) process.exit(1);
