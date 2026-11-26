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

// 有月份沒跟上這一版（鎖定／已經過去／缺列）：版本行後面帶出（推薦的 A 版文字）
eq(fB({ hol_source: 'mini', hol_pub: Object.assign({}, PUB, { lag: { locked: ['2026-12'], past: ['2026-10'], missing: [] } }) }),
  '節日表版本 2027-3，營運系統 2026-12-01 發布；其中 2 個月因已鎖定或已經過去，沒有跟著這一版更新：2026-10、2026-12', '有 2 個月沒跟上：版本行後面列出');
eq(fB({ hol_source: 'mini', hol_pub: Object.assign({}, PUB, { lag: { locked: [], past: [], missing: ['2026-09'] } }) }),
  '節日表版本 2027-3，營運系統 2026-12-01 發布；其中 1 個月因已鎖定或已經過去，沒有跟著這一版更新：2026-09<br>⚠ 2026-09 沒有節日資料、不能計算薪資（已經過去的月份系統不會補上），請聯絡資訊部人工到薪資試算表的 payroll_holiday 分頁補上', '過去月份缺列：多一行請聯絡資訊部');
eq(fB({ hol_source: 'mini', hol_pub: Object.assign({}, PUB, { lag: { locked: ['2027-01', '2027-02', '2027-03', '2027-04'], past: ['2026-09', '2026-10', '2026-11'], missing: [] } }) }).split('<br>')[0].split('；')[1],
  '其中 7 個月因已鎖定或已經過去，沒有跟著這一版更新：2026-09、2026-10、2026-11、2027-01、2027-02、2027-03 等', '超過 6 個月只列前 6 個加「等」');
eq(fB({ hol_source: 'mini', hol_pub: Object.assign({}, PUB, { lag: { locked: [], past: [], missing: [] } }) }), '節日表版本 2027-3，營運系統 2026-12-01 發布', '都有跟上：不顯示');

// applyHol＋holMiniUi：開關預設的回應不動說明與狀態列；只收推送（含共用登入的 payroll_master_get）換說明、顯示狀態列
function uiOf(html) {
  const grab = (name) => { const i = html.indexOf('function ' + name + '('); const j = html.indexOf('\n}\n', i) + 3; if (i < 0) throw new Error('找不到 ' + name); return html.slice(i, j); };
  const c0 = html.indexOf('const HOL_MINI_HINT='), c1 = c0 < 0 ? -1 : html.indexOf('\n', c0);
  const els = { holHint: { innerHTML: 'OLD' }, holSync: { style: { display: 'none' } } };
  const ctx = { $: (id) => els[id], n: (x) => Number(x), els }; vm.createContext(ctx);
  vm.runInContext('var HOL={},HOLD={},HOLSRC={},HOLN={},GOVNAMES={},HOLSYNC={};\n' + (c0 >= 0 ? html.slice(c0, c1) + '\n' : '') + grab('applyHol') + (c0 >= 0 ? grab('holMiniUi') : '') + '\nthis.get=()=>({HOL,HOLD,HOLSRC,HOLSYNC,GOVNAMES});this.applyHol=applyHol;', ctx);
  return ctx;
}
const LIST = [{ ym: '2026-12', red_days: 9, dates: '2026-12-25', note: '', _src: 'global' }];
{
  const b = uiOf(BR), a = uiOf(BASE);
  const gov = { ok: true, master: [], holidays: LIST };
  b.applyHol(LIST, gov); a.applyHol(LIST);
  eq([JSON.stringify(b.get()), b.els.holHint.innerHTML, b.els.holSync.style.display], [JSON.stringify(a.get()), 'OLD', 'none'], '開關預設：applyHol 結果跟主線相同、說明不換、狀態列不動');
  const c = uiOf(BR);
  c.applyHol(LIST, { ok: true, master: [], holidays: LIST, hol_source: 'mini', hol_pub: PUB, hol_message: '缺', names: { '2026-12-25': '行憲紀念日' }, moved: {}, double_from: '2026-08' });
  const g = c.get();
  eq([c.els.holHint.innerHTML.indexOf('由<b>營運系統的節日表</b>發布過來') > 0, c.els.holSync.style.display, g.HOLSYNC.hol_source, g.HOLSYNC.hol_pub.version, g.HOLSYNC.message, g.GOVNAMES['2026-12-25']],
    [true, '', 'mini', '2027-3', '缺', '行憲紀念日'], '只收推送（payroll_master_get，共用登入也走這裡）：換說明、狀態列顯示、版本與節日名稱就位');
  const d = uiOf(BR), syncResp = { ok: true, holidays: LIST, hol_source: 'mini', hol_pub: PUB, message: '同步的說明', names: {}, moved: {}, status: [] };
  vm.runInContext('HOLSYNC=__r;', Object.assign(d, { __r: syncResp })); d.applyHol(LIST, syncResp);
  eq([d.get().HOLSYNC === syncResp, d.els.holHint.innerHTML.indexOf('營運系統的節日表') > 0], [true, true], '只收推送（payroll_holiday_sync）：沿用同步回應本身、換說明');
}
eq(/if\(HOLSYNC\.hol_source!=='mini'\) hide\(\$\('holSync'\)\);/.test(BR), true, '共用登入：只收推送時不藏狀態列（實跑在 payroll-scope-front）');
eq(/applyHol\(m\.holidays,m\);/.test(BR) && /applyHol\(r\.holidays,r\);/.test(BR), true, '開頁（主檔）與同步都把整包回應交給 applyHol');
// 載入中、失敗的字兩種開關各驗：pay-rw-mutex F6c

console.log(`\n${fail ? '❌' : '✅'} hol-publish-front：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
