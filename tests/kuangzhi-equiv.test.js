/* 曠職：生效日開關沒設／空白／壞值時，打卡端跟改之前（主線 f21cc25）逐字相同（開工確認紅線「空白＝今天的行為逐字不變」、驗收 1）。
 * 做法：把 f21cc25 的 apps-script 解到暫存資料夾，同一個跑者（helpers/kz-equiv-runner.js）用 GS_ROOT 各跑一次，
 *   比完整回應（含 message、錯誤碼）與 approved／leave 兩張表的內容。情境見跑者檔頭（一般核定、各種帶曠職的請求、只檢查、
 *   一批只檢查、白名單外假別查表、同仁請假單、主管代開、打卡頁最近 40 天）。
 * 另外：開關開著時，「沒有帶曠職」的請求也跟主線相同（一般核定、整天病假、打卡頁）。
 * 暫存資料夾：KZ_TMP（沒給用系統暫存），跑完刪掉。基準版可用 KZ_BASE 換。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.KZ_BASE || 'f21cc25';
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g.slice(0, 1500) + '\n   主線 ' + w.slice(0, 1500)); }
};
const tmpRoot = fs.mkdtempSync(path.join(process.env.KZ_TMP || os.tmpdir(), 'kz-base-'));
try {
  const tar = cp.execFileSync('git', ['-C', ROOT, 'archive', BASE, 'apps-script', 'tools/stores.json', 'clock-line-core.js'], { maxBuffer: 256 << 20 });
  cp.execFileSync('tar', ['-x', '-C', tmpRoot], { input: tar });
  const runner = path.join(__dirname, 'helpers', 'kz-equiv-runner.js');
  const runAt = (root, props) => JSON.parse(cp.execFileSync('node', [runner], { env: Object.assign({}, process.env, { GS_ROOT: root, KZ_PROPS: JSON.stringify(props || {}) }), encoding: 'utf8', maxBuffer: 64 << 20 }));
  const base = runAt(tmpRoot, {});
  console.log('══ 一、開關沒設／空白／壞值 vs 主線 ' + BASE + ' ══');
  for (const [label, props] of [['沒設', {}], ['空白', { KUANGZHI_FROM: '' }], ['只有空白', { KUANGZHI_FROM: '   ' }], ['on', { KUANGZHI_FROM: 'on' }],
    ['不存在的日期', { KUANGZHI_FROM: '2026-12-32' }], ['斜線', { KUANGZHI_FROM: '2026/12/01' }], ['1', { KUANGZHI_FROM: '1' }]]) {
    const now = runAt(ROOT, props);
    eq(now.length, base.length, `${label}：情境數相同（${base.length}）`);
    base.forEach((b, i) => eq(now[i], b, `${label}：${b.name}`));
  }
  console.log('\n══ 二、開關開（2026-12-01），沒有帶曠職的請求 vs 主線 ══');
  const on = runAt(ROOT, { KUANGZHI_FROM: '2026-12-01' });
  ['一般核定（有打卡）', '整天病假（有已核准假單）', '打卡頁最近 40 天', '白名單外假別查表：補休（光復）'].forEach((nm) => {
    eq(on.find((x) => x.name === nm), base.find((x) => x.name === nm), '開關開：' + nm);
  });
  // 對照組：開關開時帶曠職的請求「應該」跟主線不同（證明上面的比對抓得到差異）
  const kzOn = on.find((x) => x.name === '曠職、個人帳號、班表事實齊全'), kzBase = base.find((x) => x.name === '曠職、個人帳號、班表事實齊全');
  eq([kzBase.res.error, kzOn.res.ok, kzOn.res.message], ['bad_leave_type', true, '已認定 12/3 曠職（8 小時）'], '對照組：開關開時認定曠職成功、主線是 bad_leave_type（比對有效）');

  console.log('\n══ 三、mgr_day 的 entered_at（合約 v1.2）：只有「那天有曠職登記、開關開、日期 ≥ 生效日」才多帶 ══');
  const pick = (arr, nm) => arr.find((x) => x.name === nm);
  ['mgr_day：生效日前的曠職登記（11/20）', 'mgr_day：別的假別（病假）'].forEach((nm) => eq(pick(on, nm), pick(base, nm), '開關開：' + nm + '＝主線（含 with_ver 版本）'));
  for (const nm of ['mgr_day：那天有曠職登記', 'mgr_day：那天有曠職登記（with_ver）']) {
    const a = pick(on, nm).res, b = pick(base, nm).res;
    const e1a = a.employees.find((x) => x.emp_id === 'E01'), e1b = b.employees.find((x) => x.emp_id === 'E01');
    eq(e1a.approved.entered_at, '2026-12-08T09:00:00+08:00', '開關開：' + nm + '：曠職那人 approved 帶 entered_at（＝核定列的時間）');
    eq(Object.keys(e1a.approved), Object.keys(e1b.approved).concat(['entered_at']), '開關開：' + nm + '：approved 只多 entered_at 一欄、加在最後');
    const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); c.employees.forEach((x) => { if (x.approved) delete x.approved.entered_at; if (x.emp_id === 'E01') delete x.ver; }); return c; };
    eq(strip(a), strip(b), '開關開：' + nm + '：拿掉 entered_at（與曠職那人的 ver）後跟主線逐字相同（沒曠職的人、ver 都不變）');
    eq(e1b.approved.entered_at, undefined, '對照：主線 ' + nm + ' 沒有 entered_at');
  }
  const va = pick(on, 'mgr_day：那天有曠職登記（with_ver）').res.employees, vb = pick(base, 'mgr_day：那天有曠職登記（with_ver）').res.employees;
  const verOf = (arr, id) => arr.find((x) => x.emp_id === id).ver;
  eq([typeof verOf(va, 'E01'), verOf(va, 'E01') !== verOf(vb, 'E01'), verOf(va, 'E02') === verOf(vb, 'E02')],
    ['string', true, true], '開關開：with_ver 版本只有曠職那人不同、沒曠職的人跟主線相同');
  const on15 = runAt(ROOT, { KUANGZHI_FROM: '2026-12-15' });
  eq(pick(on15, 'mgr_day：那天有曠職登記'), pick(base, 'mgr_day：那天有曠職登記'), '開關開但生效日 12/15（那天 12/3 在生效日前）：跟主線逐字相同');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log('\n' + pass + ' 過、' + fail + ' 失敗');
if (fail) process.exit(1);
