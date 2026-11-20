// P3-3：開關全空（DUTY_AUTH、DUTY_VER_STRICT、DUTY_APPROVE_LOCK 都沒設）時，新版跟改版前的 main 逐字相同。
// 同一組請求（核定成功／版本退回／金鑰錯／沒帶版本／帶了寫回欄位但店沒設金鑰／讀不到版本兩種／審單／批次／作廢／LINE 送單）
// 分別在舊版（git show DUTY_AUTH_BASE 的 DutyFeed.gs、Requests.gs，其他檔用這一版）與新版跑，比全部回應＋試算表最後內容＋暫存區記號。
// 唯一允許的差別：四個核定類動作（不含 dry_run）每次多讀一次 getProperties()（印出來，不算不同）。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { check, done, ROOT } = require('./helpers/gs-sandbox');
const BASE = process.env.DUTY_AUTH_BASE || '7dceb4b';   // 改版前的 main（PR 開出時的 merge-base；合併後可用環境變數換）
let base;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-auth-base-'));
  fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
  ['DutyFeed.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));
} catch (e) {
  console.log('• 跳過：拿不到改版前的版本 ' + BASE + '（' + String(e.message).split('\n')[0] + '）'); process.exit(0);
}
const run = (root) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'duty-auth-corpus.js')], { env: Object.assign({}, process.env, { GS_ROOT: root }), encoding: 'utf8', maxBuffer: 64 << 20 }));
const a = run(base), b = run(ROOT);
a.out.forEach((x, i) => check('S' + String(i + 1).padStart(2, '0'), x[0] + '：回應逐字相同', b.out[i], x));
check('S90', '回應筆數相同', b.out.length, a.out.length);
Object.keys(a.sheets).forEach((k) => check('S91-' + k, '試算表「' + k + '」最後內容相同', b.sheets[k], a.sheets[k]));
check('S92', '分頁清單相同', Object.keys(b.sheets), Object.keys(a.sheets));
check('S93', '暫存區記號相同（不含變動紀錄 dfeed_；新版沒有留 dwb: 記號）', b.cacheKeys, a.cacheKeys);
const extra = {}; Object.keys(a.reads).forEach((k) => { extra[k] = b.reads[k] - a.reads[k]; });
check('S94', '屬性讀取次數差：核定、審單各多 1 次 getProperties()；送單、讀當天 0 次', extra, { approve: 1, decide: 1, submit: 0, day: 0 });
fs.rmSync(base, { recursive: true, force: true });
done();
