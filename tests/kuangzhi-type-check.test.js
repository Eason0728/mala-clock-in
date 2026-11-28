/* 曠職上線前檢查 tools/kuangzhi-type-check.py 的判定（不連網路：--self-test 跑內建手算案例）。
 * 規則：代碼 absent 卻不叫曠職＝不通過；有名稱「曠職」的生效列＝通過；看不到曠職列：開關已開＝不通過、還沒開＝未確認。只印曠職列的名稱、啟用、對全勤欄位。 */
'use strict';
const cp = require('child_process'), path = require('path');
let out = '';
try { out = cp.execFileSync('python3', ['-I', path.join(__dirname, '..', 'tools', 'kuangzhi-type-check.py'), '--self-test'], { encoding: 'utf8' }); }
catch (e) {
  if (e.code === 'ENOENT') { console.log('⊘ 略過：這台沒有 python3'); process.exit(0); }
  console.log(e.stdout || ''); console.error(e.stderr || ''); process.exit(1);
}
console.log(out.trim());
if (!/✅ 判定手算 \d+ 例、錯 0/.test(out)) process.exit(1);
