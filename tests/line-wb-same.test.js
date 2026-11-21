// 方案 A（LINE 簽名寫回）：沒帶簽名的 LINE 申請，新版跟改版前的 main（6c5f137，可用 LINE_WB_BASE 換）逐字相同。
// 同一組請求（送單、同號、別人的號、格式錯、鎖月、額度、生理假、病假、特休、兩段、token 錯／沒帶、離職、取消各種、我的申請）
// 分別在舊版（git show 舊版的 DutyFeed.gs、Requests.gs，其他檔用這一版）與新版跑，比全部回應、試算表、暫存區鍵、屬性讀取次數、連外請求。
// 不允許任何差別（沒帶簽名時新版一個屬性都不多讀、不多打一次網路）。另跑一輪「店已設門鈴金鑰＋DUTY_AUTH=mini」也要相同（LINE 送單不受 DUTY_AUTH 影響）。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { check, done, ROOT } = require('./helpers/gs-sandbox');
const BASE = process.env.LINE_WB_BASE || '6c5f137';
let base;
try {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'line-wb-base-'));
  fs.cpSync(path.join(ROOT, 'apps-script'), path.join(base, 'apps-script'), { recursive: true });
  ['DutyFeed.gs', 'Requests.gs'].forEach((f) => fs.writeFileSync(path.join(base, 'apps-script', f), execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/' + f])));
} catch (e) {
  console.log('• 跳過：拿不到改版前的版本 ' + BASE + '（' + String(e.message).split('\n')[0] + '）'); process.exit(0);
}
const run = (root, props) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'line-wb-corpus.js')],
  { env: Object.assign({}, process.env, { GS_ROOT: root, CORPUS_PROPS: JSON.stringify(props || {}) }), encoding: 'utf8', maxBuffer: 64 << 20 }));
for (const [tag, props] of [['A', {}], ['B', { DUTY_AUTH: 'mini', DUTY_PUSH_KEY: 'k'.repeat(32), DUTY_PUSH_STORE: 'mztjs' }]]) {
  const a = run(base, props), b = run(ROOT, props);
  a.out.forEach((x, i) => check(tag + String(i + 1).padStart(2, '0'), (tag === 'B' ? '［mini＋金鑰］' : '') + x[0] + '：回應逐字相同', b.out[i], x));
  check(tag + '90', '回應筆數相同', b.out.length, a.out.length);
  check(tag + '91', '試算表最後內容相同（全部分頁）', b.sheets, a.sheets);
  check(tag + '92', '暫存區鍵相同（新版沒有留 dwb: 記號）', b.cacheKeys, a.cacheKeys);
  check(tag + '93', '每個請求的屬性讀取次數相同', b.reads, a.reads);
  check(tag + '94', '連外請求（光復、LINE 驗證）逐筆相同', b.fetches, a.fetches);
  check(tag + '95', '對照組有效：語料裡有成功寫入、有被規則擋', [a.out.some((x) => x[1].ok === true), a.out.some((x) => x[1].error === 'pay_locked'), a.out.some((x) => x[1].error === 'quota_exhausted')], [true, true, true]);
}
fs.rmSync(base, { recursive: true, force: true });
done();
