/**
 * 節日表由營運系統發布（2026-11-24）：薪資頁「2 參數設定」紅字天數表上方那一行（holSyncHtml）與說明文字。
 *  ・後端沒回 hol_source:'mini'（開關預設）：跟主線 64c9b52 的 holSyncHtml 對同一批輸入逐字相同、說明文字不換。
 *  ・hol_source:'mini'：一行「節日表版本 X，營運系統 YYYY-MM-DD 發布」（確認頁「深度」段的字），有說明再多一行 ⚠；沒收到任何一版的提示。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
let pass = 0, fail = 0;
const eq = (got, want, m) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '\n   實際 ' + g + '\n   應為 ' + w); } };

const BR = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const BASE = cp.execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', '64c9b525d6311543ea6e9aaea43f66fcecb9fa7e:payroll.html'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function fnOf(html) {
  const e0 = html.indexOf('const esc=s=>'), e1 = html.indexOf("'&#39;');", e0) + "'&#39;');".length;
  const f0 = html.indexOf('function holSyncHtml('), f1 = html.indexOf('\n}\n', f0) + 3;
  if (e0 < 0 || f0 < 0) throw new Error('找不到 esc 或 holSyncHtml');
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(html.slice(e0, e1) + '\n' + html.slice(f0, f1) + '\nthis.F=holSyncHtml;', ctx);
  return ctx.F;
}
const fB = fnOf(BR), fA = fnOf(BASE);
const OK = { year: 2026, ok: true, title: '115年中華民國政府行政機關辦公日曆表' };
const GOV = [{}, null, undefined, { status: [OK] }, { status: [OK], message: '2026-10 已有門市鎖定' }, { status: [{ year: 2027, ok: false, error: 'not_published' }] },
  { status: [{ year: 2026, ok: false, error: 'fetch_failed', message: '<b>x</b>' }] }, { status: [], message: '<i>y</i>' }, { hol_source: 'gov', status: [OK] }];
eq(GOV.map((s) => fB(s)), GOV.map((s) => fA(s)), '開關預設（沒有 hol_source:mini）：9 種輸入跟主線 holSyncHtml 逐字相同');

const PUB = { version: '2027-3', published_at: '2026-12-01T06:10:00+08:00', confirmed_by: '人資主管', source: '', received_at: '2026-12-01T06:10:05+08:00' };
eq(fB({ hol_source: 'mini', hol_pub: PUB, status: [], message: '' }), '節日表版本 2027-3，營運系統 2026-12-01 發布', '只收推送：一行版本與發布日（照確認頁）');
eq(fB({ hol_source: 'mini', hol_pub: PUB, status: [], message: '還沒有 2028-01 的節日資料' }), '節日表版本 2027-3，營運系統 2026-12-01 發布<br>⚠ 還沒有 2028-01 的節日資料', '只收推送＋缺資料說明：多一行 ⚠');
eq(fB({ hol_source: 'mini', hol_pub: null, status: [], message: '請先到營運系統確認並發布節日表。' }), '⚠ 節日表改由營運系統發布，薪資還沒有收到任何一版<br>⚠ 請先到營運系統確認並發布節日表。', '只收推送、還沒收到任何一版');
eq(fB({ hol_source: 'mini', hol_pub: { version: '<b>1</b>', published_at: 'x' } }), '節日表版本 &lt;b&gt;1&lt;/b&gt;，營運系統  發布', '版本文字經 esc；發布時間格式不對就空白');

// 說明文字只有 mini 才換
eq(BR.indexOf('<p class="hint" id="holHint">基本工時') > 0, true, '說明段落多了 id（文字沒變）');
eq(BR.replace(' id="holHint"', '').indexOf(BASE.slice(BASE.indexOf('<p class="hint">基本工時'), BASE.indexOf('</p>', BASE.indexOf('<p class="hint">基本工時')))) > 0, true, '說明段落原文跟主線相同');
eq(/if\(r\.hol_source==='mini'&&\$\('holHint'\)\)/.test(BR), true, '換說明文字只在後端回 hol_source:mini 時');
eq(/st\.textContent='正在對照人事行政總處的辦公日曆表…';/.test(BR), true, '載入中文字沒改（只收推送時同步很快回來、立刻換成版本那一行）');

console.log(`\n${fail ? '❌' : '✅'} hol-publish-front：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
