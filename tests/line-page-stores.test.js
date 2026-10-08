// clock-line.html 內建的店家表必須與 tools/stores.json 一致（方案 C：畫面自己挑店、直接打那家店）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
execFileSync('python3', [path.join(ROOT, 'tools', 'build-line-page.py'), '--check'], { stdio: 'pipe' });
const html = fs.readFileSync(path.join(ROOT, 'clock-line.html'), 'utf8');
const blk = html.slice(html.indexOf('STORES:BEGIN'), html.indexOf('STORES:END'));
if (/ss_id|ADMIN|KEY|spreadsheet/i.test(blk)) throw new Error('店家表不可含試算表 ID 或金鑰');
if (html.indexOf('<script src="clock-line-core.js"></script>') < 0) throw new Error('沒載入 clock-line-core.js');
console.log('✅ 打卡畫面店家表與 stores.json 一致、不含試算表 ID／金鑰');
