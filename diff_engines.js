// 新舊引擎對拆的入口：只是轉呼叫 tests/engine-diff.js（參數原樣傳）。
//   node diff_engines.js <舊版 Payroll.gs> <新版 Payroll.gs> [--strict]
require('./tests/engine-diff.js');
