/**
 * 薪資單抬頭要印「這份薪資單所屬計薪單位」自己的名稱（2026-11-23）。
 * 以前 payroll.html 寫死「麻的小辛辣 · 新竹光復店」，央廚、總部、墨竹亭各店的薪資單也一樣。
 * 從 payroll.html 抽函式用 vm 實跑，不另寫一份邏輯；舊版（PAYSLIP_BASE，預設 6593423）拿來逐字比對「只有抬頭不同」。
 *
 * 測試資料全是虛構同仁與假金額，單位名稱用門市表的樣式。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.log('FAIL: ' + m); } };

function fnOf(src, name) {   // 抽出 function name(...) {...}（含 async）
  const re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src); if (!m) return '';
  let i = src.indexOf('{', m.index), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(m.index, j + 1);
}
function constOf(src, name) {   // 抽出 const name=...; （單行，或 esc 那種接續到第一個行尾分號）
  const m = new RegExp('^const ' + name + '=.*$', 'm').exec(src); if (!m) return '';
  let end = m.index + m[0].length, text = m[0];
  while (!/;\s*(\/\/.*)?$/.test(text)) { const nl = src.indexOf('\n', end + 1); if (nl < 0) break; text = src.slice(m.index, nl); end = nl; }
  return text;
}
function letOf(src, name) { const m = new RegExp('^let ' + name + '=.*$', 'm').exec(src); return m ? m[0] : ''; }

// ── 門市表樣式的單位（code → name）。小辛辣光復那列的名稱＝程式內建預設列（Payroll.gs payStoreList）的名稱
const UNITS = [
  { code: 'SSLGF',  name: '麻的小辛辣 新竹光復店', want: '麻的小辛辣 · 新竹光復店' },
  { code: 'MZTGF',  name: '墨竹亭 新竹光復店',     want: '墨竹亭 · 新竹光復店' },
  { code: 'MZTJS',  name: '墨竹亭 新竹金山店',     want: '墨竹亭 · 新竹金山店' },
  { code: 'MZTLZL', name: '墨竹亭 台北六張犁店',   want: '墨竹亭 · 台北六張犁店' },
  { code: 'CF',     name: '央廚',                 want: '央廚' },
  { code: 'HQ',     name: '鼎兆元 總部',           want: '鼎兆元 · 總部' },
  { code: 'MZTHQ',  name: '墨竹亭 總部',           want: '墨竹亭 · 總部' },
  { code: 'SSLHQ',  name: '麻的小辛辣 總部',       want: '麻的小辛辣 · 總部' },
];
const STORE_LIST = UNITS.map(u => ({ code: u.code, name: u.name, brand: /墨竹亭/.test(u.name) ? 'mzt' : 'sxl' }));

const RESULT = {   // 虛構同仁、假金額
  emp_id: 'T01', name: '測試甲', is_full_time: true, ratio: 1, total_hours: 168, base_hours: 168, support_hours: 0,
  earn: [{ item_key: 'base', item_label: '本薪', qty: null, rate: null, amount: 30000 },
         { item_key: 'overtime', item_label: '加班費', qty: 3, rate: 190, amount: 570 }],
  ded: [{ item_key: 'labor_ins', item_label: '勞保費', qty: null, rate: null, amount: 700 }],
  gross: 30570, deduction: 700, net: 29870,
};

function world(src, { storeList, store, results, payday }) {
  const els = {};
  const mk = () => ({ innerHTML: '', value: '', textContent: '', style: {} });
  const $ = id => els[id] || (els[id] = mk());
  $('ym').value = '2026-11'; $('slipSel').value = 'T01';
  const blobs = [];
  const ctx = {
    $, els, blobs, console, Blob,
    document: { createElement: () => ({ click() {} }), body: { appendChild() {} } },
    URL: { createObjectURL: b => { blobs.push(b); return 'blob:x'; } },
    toast() {}, window: { print() {} },
    costTotals: () => ({}), costRows: () => [], monUnsureStop: () => false, elecPending: () => false,
  };
  vm.createContext(ctx);
  const consts = ['n', 'r2', 'nf', 'rf', 'esc', 'xlsText', 'ym', 'isExpHoury', 'expQtyUnit'].map(k => constOf(src, k));
  const exp = (/^const EXP_HOURY_FIX=.*$/m.exec(src) || [''])[0];
  const fns = ['renderSlip', 'renderSlipSel', 'renderExport', 'expSub', 'exportExcel', 'unitName', 'unitTitle'].map(k => fnOf(src, k)).filter(Boolean);
  vm.runInContext(
    `let RESULTS=${JSON.stringify(results)}, STATUS='final', ASOF=null, ANNUAL={}, CFG=${JSON.stringify({ payday })}, STORE=${JSON.stringify(store)}, STORE_LIST=${JSON.stringify(storeList)};
     const mdOf=d=>d;\n${letOf(src, 'SLIP_STORE')}\n${consts.join('\n')}\n${exp}\n${fns.join('\n')}
     this.api={renderSlip,renderSlipSel,renderExport,exportExcel,
       set:(k,v)=>{ if(k==='STORE')STORE=v; if(k==='STORE_LIST')STORE_LIST=v; if(k==='RESULTS')RESULTS=v; },
       slipStore:()=>typeof SLIP_STORE==='undefined'?undefined:SLIP_STORE};`, ctx);
  return ctx;
}
const subOf = h => (/<div class="sub">([\s\S]*?)<\/div>/.exec(h) || [])[1];

(async () => {
  ok(['renderSlip', 'renderSlipSel', 'renderExport', 'exportExcel', 'unitName', 'unitTitle'].every(k => fnOf(html, k)), '找得到薪資單、匯出與取單位名稱的函式');

  // ① 各單位薪資單抬頭＝自己的名稱（品牌 · 分店）
  for (const u of UNITS) {
    const w = world(html, { storeList: STORE_LIST, store: u.code, results: [RESULT], payday: 10 });
    w.api.renderSlipSel();
    const sub = subOf(w.els.slipWrap.innerHTML);
    ok(sub === `${u.want} ｜ 2026年11月 ｜ 發薪日 每月 10 日`, `${u.code} 薪資單抬頭＝「${u.want}」`);
    if (u.code !== 'SSLGF') ok(!sub.startsWith('麻的小辛辣 · 新竹光復店 ｜'), `${u.code} 沒有被印成「麻的小辛辣 · 新竹光復店」`);
  }

  // ② 小辛辣光復：抬頭與修正前逐字相同（寫死的舊字串）
  {
    const w = world(html, { storeList: STORE_LIST, store: 'SSLGF', results: [RESULT], payday: 10 });
    w.api.renderSlipSel();
    ok(subOf(w.els.slipWrap.innerHTML) === '麻的小辛辣 · 新竹光復店 ｜ 2026年11月 ｜ 發薪日 每月 10 日', 'SSLGF 抬頭一行逐字＝修正前');
  }

  // ③ 整張薪資單（金額、工時、扣款）除了抬頭那一行，和修正前逐字相同
  let oldHtml = null;
  const base = process.env.PAYSLIP_BASE || '6593423';
  try { oldHtml = execFileSync('git', ['show', base + ':payroll.html'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) { oldHtml = null; }
  if (!oldHtml) console.log('SKIP: 讀不到舊版 ' + base + '（淺層複本？）—— 整張逐字比對略過，抬頭的比對仍有跑');
  else {
    const stripSub = h => h.replace(/<div class="sub">[\s\S]*?<\/div>/, '<div class="sub">@@</div>');
    for (const u of UNITS) {
      const wn = world(html, { storeList: STORE_LIST, store: u.code, results: [RESULT], payday: 10 });
      const wo = world(oldHtml, { storeList: STORE_LIST, store: u.code, results: [RESULT], payday: 10 });
      wn.api.renderSlipSel(); wo.api.renderSlipSel();
      ok(stripSub(wn.els.slipWrap.innerHTML) === stripSub(wo.els.slipWrap.innerHTML), `${u.code} 薪資單除抬頭外與修正前逐字相同（金額、工時、扣款沒動）`);
    }
    // 發薪日：照舊取該店參數 CFG.payday，沒有寫死
    const w7 = world(html, { storeList: STORE_LIST, store: 'MZTJS', results: [RESULT], payday: 5 });
    w7.api.renderSlipSel();
    ok(/發薪日 每月 5 日/.test(w7.els.slipWrap.innerHTML), '發薪日仍取該店參數（設 5 就印 5），這次沒動');
  }

  // ④ 退路：名稱取不到 → 印計薪單位代號，不可印光復店
  {
    const cases = [
      ['門市表讀不到（清單空）', [], 'MZTJS', 'MZTJS'],
      ['該列名稱空白', [{ code: 'CF', name: '' }], 'CF', 'CF'],
      ['該列名稱只有空白', [{ code: 'CF', name: '  　 ' }], 'CF', 'CF'],
      ['代號不在清單', STORE_LIST, 'NEWSTORE', 'NEWSTORE'],
      ['連代號都沒有', STORE_LIST, '', '（未知單位）'],
    ];
    for (const [label, list, store, want] of cases) {
      const w = world(html, { storeList: list, store, results: [RESULT], payday: 10 });
      w.api.renderSlipSel();
      const sub = subOf(w.els.slipWrap.innerHTML);
      ok(sub.startsWith(want + ' ｜ ') && !/小辛辣|光復/.test(sub), `退路：${label} → 印「${want}」，沒有小辛辣／光復`);
    }
  }

  // ⑤ 名稱是資料，要轉義
  {
    const w = world(html, { storeList: [{ code: 'X1', name: '<img src=x onerror=alert(1)> 分店' }], store: 'X1', results: [RESULT], payday: 10 });
    w.api.renderSlipSel();
    const sub = subOf(w.els.slipWrap.innerHTML);
    ok(!/<img/.test(sub) && /&lt;img/.test(sub), '單位名稱進畫面前有轉義');
  }

  // ⑥ 切門市等回應期間：舊結果的薪資單抬頭仍是舊結果自己的單位，不掛上新門市的名字
  {
    const w = world(html, { storeList: STORE_LIST, store: 'MZTJS', results: [RESULT], payday: 10 });
    w.api.renderSlipSel();                // 結果屬於 MZTJS
    w.api.set('STORE', 'CF');             // 使用者剛切到央廚，央廚的結果還沒回來
    w.api.renderSlip();                   // 這時在舊結果上換人／重畫
    ok(subOf(w.els.slipWrap.innerHTML).startsWith('墨竹亭 · 新竹金山店 ｜ '), '切門市等回應時，舊結果的薪資單抬頭不會變成新門市的名字');
    w.api.renderSlipSel();                // 央廚結果回來、重畫
    ok(subOf(w.els.slipWrap.innerHTML).startsWith('央廚 ｜ '), '新結果回來後抬頭換成新單位');
  }

  // ⑦ 匯出（PDF 列印用的明細頁、Excel 標題）同一個抬頭
  for (const u of [UNITS[0], UNITS[2], UNITS[4], UNITS[5]]) {
    const w = world(html, { storeList: STORE_LIST, store: u.code, results: [RESULT], payday: 10 });
    w.api.renderSlipSel();
    w.api.renderExport();
    const eh = w.els.exportDetail.innerHTML;
    ok(eh.includes(`>${u.want} 薪資明細</div>`) && !(u.code !== 'SSLGF' && /麻的小辛辣 薪資明細/.test(eh)), `${u.code} 匯出明細頁標題＝「${u.want} 薪資明細」`);
    w.api.exportExcel();
    const txt = await w.blobs[0].text();
    ok(txt.includes(`<h3>${u.want} 薪資明細 2026-11（已鎖定）</h3>`), `${u.code} Excel 標題＝「${u.want} 薪資明細」`);
    ok(/<td>30000<\/td>|<td>30570<\/td>/.test(txt), `${u.code} Excel 金額照舊（抬頭以外沒動）`);
  }

  // ⑧ 檔案裡不能再有寫死的「麻的小辛辣 … 薪資明細」「新竹光復店」抬頭
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');   // 註解裡舉例不算
  ok(!/麻的小辛辣 · 新竹光復店/.test(body), 'payroll.html 沒有寫死的「麻的小辛辣 · 新竹光復店」');
  ok(!/麻的小辛辣 薪資明細/.test(body), 'payroll.html 沒有寫死的「麻的小辛辣 薪資明細」');

  console.log(`\n${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();
