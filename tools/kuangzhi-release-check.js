#!/usr/bin/env node
/* 曠職上線檢查（2026-11-26）：扣款算法還是「待主管確認」佔位時不能上線。
 * 用法：node tools/kuangzhi-release-check.js [Payroll.gs 路徑]   → 可以上線結束碼 0；還有問題結束碼 1（印出問題）。
 * 上線（deploy-to-clasp.py --apply 之前）一定要跑；tests/kuangzhi-release-check.test.js 釘住「旗標還在時一定失敗」。
 * 只讀檔、不連網路、不碰 clasp。 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', 'apps-script');
const payPath = process.argv[2] || path.join(ROOT, 'Payroll.gs');
const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(payPath, 'utf8');
const sb = { console: { log() {}, warn() {}, error() {} }, Logger: { log() {} } };
vm.createContext(sb);
let problems;
try {
  vm.runInContext(src, sb, { filename: 'release-check.gs' });
  problems = vm.runInContext('typeof payKzReleaseProblems_ === "function" ? payKzReleaseProblems_() : ["找不到 payKzReleaseProblems_（Payroll.gs 版本不對）"]', sb);
} catch (e) {
  problems = ['載入 Payroll.gs 失敗：' + (e && e.message)];
}
if (problems.length) {
  console.log('✗ 曠職上線檢查沒過，不能上線：');
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('✓ 曠職上線檢查通過');
