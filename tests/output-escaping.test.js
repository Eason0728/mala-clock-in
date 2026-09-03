/* 輸出轉義——2026-09-03 交付前資安稽核的守門測試。
 *
 * 守什麼：**任何「人打進來的自由文字」進 innerHTML 之前都要先轉義。**
 * 涵蓋姓名（主管在核定頁新增同仁時填）、假別名、門市名、自訂加薪／扣款的項目名、備註。
 *
 * 為什麼需要這支：2026-09-03 稽核發現一條提權路徑——主管把同仁姓名填成 HTML
 * （handleMgrAddEmployee 只驗非空與長度 ≤20，不過濾字元），管理者開
 * payroll.html?k=<管理金鑰> 時酬載在其瀏覽器執行，而管理金鑰就在網址列
 * （location.search）→ 主管即可竊取全集團薪資讀寫權。主管本來看不到任何薪資資料。
 *
 * 原本的防護是「想到才加」而非預設：公告那條路早就防住了（clock.html renderNotices 走
 * textContent、manager.html 公告列表有 esc），但姓名同樣是主管手打、同樣進 innerHTML，
 * 卻沒被想到。這支測試把「預設就轉義」變成可重跑的檢查。
 *
 * ⚠⚠ 這支測試存在的最大理由：**靜態掃描會漏。**
 * 稽核當時最危險的那處是 renderEmp 的通用欄位產生器 `<input value="${e[k]??''}">`——
 * 欄位名是變數 e[k]（EF 表第一項就是 ['name','姓名','text']），
 * 任何以 `.name` 為模式的 grep 都不命中，是端到端注入測試才發現的**屬性注入**。
 * 同樣漏過的還有 ${q.name}（假別名）、${o.name}、${x.status_text}。
 * → 所以 §2 一定要真的跑渲染函式、檢查產出的 HTML，不能只有 §3 的模式掃描。
 *
 * ⚠ 前端有四份轉義函式（payroll.html／my.html 的 esc()、clock.html 的 payEsc()、
 * manager.html 的 escHtml()），行為必須一致。改一邊要四邊都看，§1 會擋住不一致。
 * ⚠ 改 clock.html／manager.html 後要重跑 tools/build-store-pages.py，§4 會擋住忘記。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PAYROLL = R('payroll.html');
const MY = R('my.html');
const CLOCK = R('clock.html');
const MANAGER = R('manager.html');

let pass = 0, fail = 0;
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + `\n      得到 ${JSON.stringify(got)}／期望 ${JSON.stringify(want)}`); }
}

/* 從 HTML 抽出一段原始碼實跑。⚠ 用字串定位，不要改成硬編碼行號（前端一改就失準）。
   定位失敗時直接丟錯，不要靜靜跑過去——那會讓測試假通過。 */
function slice(html, startMark, endMark, label) {
  const a = html.indexOf(startMark);
  if (a < 0) throw new Error(`抽不到切片起點「${startMark}」（${label}）——前端結構可能改了，請更新本測試的定位字串`);
  const b = html.indexOf(endMark, a);
  if (b < 0) throw new Error(`抽不到切片終點「${endMark}」（${label}）`);
  return html.slice(a, b + endMark.length);
}

function loadFn(src, name, extra) {
  const sb = Object.assign({ String, Object, Array, Number, Math, JSON, RegExp }, extra || {});
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return vm.runInContext(name, sb);
}

/* ═════════ §1 四份轉義函式的行為必須一致且正確 ═════════ */
console.log('\n§1 四份轉義函式（payroll/my 的 esc、clock 的 payEsc、manager 的 escHtml）');

const ESC_TAIL = `.replace(/'/g,'&#39;');`;
const escFns = {
  'payroll.html esc': loadFn(slice(PAYROLL, 'const esc=s=>String', ESC_TAIL, 'payroll esc'), 'esc'),
  'my.html esc': loadFn(slice(MY, 'const esc=s=>String', ESC_TAIL, 'my esc'), 'esc'),
  'clock.html payEsc': loadFn(slice(CLOCK, 'function payEsc(s) {', '\n  }', 'clock payEsc'), 'payEsc'),
  'manager.html escHtml': loadFn(slice(MANAGER, 'function escHtml(v) {', '\n  }', 'manager escHtml'), 'escHtml'),
};

/* 正常資料必須「完全不變」——這是「修完畫面不會變」的保證。
   只要有一項變了，就代表轉義過頭，畫面會出現 &amp; 之類的雜訊。 */
const UNCHANGED = ['陳盈如', '王禹婕', 'Wang Yu Chieh', 'CF01', 'HQ-01', '（未命名）', '麻的小辛辣 光復', '2026-08', '0'];
/* 危險輸入必須被轉義成無法執行的形式 */
const MUST_ESCAPE = [
  ['<svg onload=f()>', '&lt;svg onload=f()&gt;'],
  ['<img src=x onerror=f()>', '&lt;img src=x onerror=f()&gt;'],
  ['" onmouseover="f()', '&quot; onmouseover=&quot;f()'],   // 屬性逃逸
  ["' onclick='f()", '&#39; onclick=&#39;f()'],
  ['A & B', 'A &amp; B'],
  ['<a>', '&lt;a&gt;'],                                      // 不可雙重轉義
];

for (const [label, fn] of Object.entries(escFns)) {
  console.log(`  ── ${label}`);
  chk(`    正常資料完全不變（${UNCHANGED.length} 項）`, UNCHANGED.filter(s => fn(s) !== s), []);
  for (const [input, want] of MUST_ESCAPE) chk(`    ${JSON.stringify(input)} → 轉義`, fn(input), want);
  chk('    null 安全', fn(null), '');
  chk('    undefined 安全', fn(undefined), '');
  chk('    數字安全', fn(0), '0');
}

/* 四份行為必須一致：同一輸入、四份輸出相同。不一致代表有人只改了一邊。 */
const probes = ['陳盈如', '<img src=x>', '" onfocus="f()', "'", '&', '<>'];
const sigs = Object.entries(escFns).map(([k, fn]) => [k, probes.map(p => fn(p)).join('|')]);
chk('  四份轉義函式行為完全一致', new Set(sigs.map(s => s[1])).size, 1);

/* ═════════ §2 端到端：真的跑渲染函式，檢查產出的 HTML ═════════ */
/* 這一節是本測試的核心。§3 的模式掃描抓不到動態鍵（e[k]），只有真跑才抓得到。 */
console.log('\n§2 端到端：renderEmp 實跑（含 EF 表的通用欄位產生器＝姓名的實際輸出路徑）');

const PAYLOAD_TAG = '<img src=x onerror="__FIRED=1">';
const PAYLOAD_ATTR = '" onmouseover="__FIRED=1';

function renderEmpHtml(names) {
  const src = [
    slice(PAYROLL, 'const esc=s=>String', ESC_TAIL, 'esc'),
    slice(PAYROLL, 'const EF=[', '];', 'EF'),
    slice(PAYROLL, 'function renderEmp(){', "\n  }).join('');\n}", 'renderEmp'),
  ].join('\n');
  let captured = '';
  const sb = {
    String, Object, Array, Number, Math, JSON, RegExp,
    MASTER: names.map((nm, i) => ({ emp_id: 'T0' + (i + 1), name: nm, is_full_time: i === 0 ? 'true' : 'false', wage: 200, base: 30000, active: 'true' })),
    ATT: {}, CFG: {}, HAS_CLOCK: true,
    isFT: e => String(e.is_full_time) === 'true',
    n: v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; },
    // 攔住 innerHTML 賦值，把產生的 HTML 抓出來檢查
    $: id => id === 'empList'
      ? { set innerHTML(v) { captured = v; }, get innerHTML() { return captured; } }
      : { disabled: false, title: '' },
  };
  vm.createContext(sb);
  vm.runInContext(src, sb);
  vm.runInContext('renderEmp()', sb);
  return captured;
}

const h1 = renderEmpHtml(['陳盈如', PAYLOAD_TAG]);
chk('  產出非空（切片真的跑起來了）', h1.length > 100, true);
chk('  正常姓名原樣出現', h1.includes('陳盈如'), true);
chk('  標籤酬載不以可執行形式出現', h1.includes('<img src=x'), false);
/* ⚠ 這裡要斷言「整串酬載都以轉義形式出現」，不可以寫成 /\sonerror=/ 之類——
   轉義後的字串裡本來就含有 `onerror=` 這幾個**字**（在 &lt;img src=x onerror=&quot;… 裡面），
   那是無害的純文字。用那種 regex 會誤判成失敗。（本測試第一版就是這樣寫錯的。） */
chk('  標籤酬載整串被完整轉義',
  h1.includes('&lt;img src=x onerror=&quot;__FIRED=1&quot;&gt;'), true);

const h2 = renderEmpHtml(['陳盈如', PAYLOAD_ATTR]);
/* 這條才是屬性注入的真正判準：value 屬性有沒有被提前關閉、後面接上事件處理器。 */
chk('  屬性逃逸酬載未關閉 value 屬性', /value="[^"]*"\s+onmouseover/.test(h2), false);
chk('  屬性逃逸酬載整串被完整轉義',
  h2.includes('&quot; onmouseover=&quot;__FIRED=1'), true);
/* 產出中的事件屬性只該有程式自己寫的 onchange。把轉義區段（&lt;…&gt; 與 &quot;）
   先移除再檢查，剩下的 on*= 就一定是真屬性。 */
const stripEscaped = s => s.replace(/&lt;[\s\S]*?&gt;/g, '').replace(/&quot;[\s\S]*?(?=")/g, '');
const realAttrs = [...new Set((stripEscaped(h2).match(/\son([a-z]+)\s*=/g) || []).map(s => s.trim()))];
chk('  真實事件屬性只有 onchange', realAttrs, ['onchange=']);

/* 反向驗證：把轉義拿掉，上面幾條必須變紅。
   ⚠ 沒有這一段，測試可能在「根本沒檢查到東西」的情況下全綠（payCalcOne 的
   `r.items` 就是這樣假通過過一次，還跟 Eason 報告過「2160 組逐項相同」）。 */
console.log('  ── 反向驗證（拿掉轉義，上面的檢查必須失效）');
const naive = s => String(s == null ? '' : s);      // 不轉義
const rawHtml = `<input type="text" value="${naive(PAYLOAD_ATTR)}">`;
chk('    未轉義時 value 屬性確實會被關閉', /value="[^"]*"\s+onmouseover/.test(rawHtml), true);
const rawTag = `<td>${naive(PAYLOAD_TAG)}</td>`;
chk('    未轉義時標籤確實會原樣出現', rawTag.includes('<img src=x'), true);

/* ═════════ §3 覆蓋率不退步（模式掃描，補強而非取代 §2）═════════ */
console.log('\n§3 覆蓋率守門：新增輸出點時不可漏包');

const FILES = { 'payroll.html': PAYROLL, 'my.html': MY, 'clock.html': CLOCK, 'manager.html': MANAGER };
const ESC_CALL = /esc\(|payEsc\(|escHtml\(/;

for (const [name, src] of Object.entries(FILES)) {
  // 所有進 HTML 屬性的動態值（屬性注入面：一個引號就能掛上事件處理器）
  const attrs = (src.match(/value="\$\{[^}]*\}"/g) || []).filter(s => !ESC_CALL.test(s));
  chk(`  ${name}：未轉義的 value="\${…}" 屬性`, attrs.length, 0);
  // 已知的自由文字欄位進模板
  const fields = (src.match(/\$\{[A-Za-z_]+\.[A-Za-z_]*(?:name|item_label|store|memo|label|status_text|removed_by)[A-Za-z_]*\}/g) || [])
    .filter(s => !ESC_CALL.test(s));
  chk(`  ${name}：未轉義的自由文字欄位`, fields.length, 0);
}

/* 明確釘住稽核當時最危險的那一處。動態鍵無法用通用模式偵測，只能點名。 */
chk('  payroll.html：通用欄位產生器（EF 表／姓名的實際路徑）已包覆',
  /value="\$\{esc\(e\[k\]/.test(PAYROLL), true);
chk('  EF 表第一項仍是姓名（若改了，上面那條的意義要重新確認）',
  /const EF=\[\['name'/.test(PAYROLL), true);

/* ═════════ §4 衍生檔必須與母版同步 ═════════ */
/* clock-cf/hq.html、manager-cf/hq.html 是 tools/build-store-pages.py 產生的，
   只改母版不重跑腳本＝只有光復修好，央廚與總部還是舊的。 */
console.log('\n§4 衍生檔同步（改母版後有沒有重跑 build-store-pages.py）');
for (const f of ['clock-cf.html', 'clock-hq.html']) {
  chk(`  ${f} 含 payEsc`, /function payEsc\(/.test(R(f)), true);
}
for (const f of ['manager-cf.html', 'manager-hq.html']) {
  chk(`  ${f} 含 escHtml`, /function escHtml\(/.test(R(f)), true);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 輸出轉義防護完整'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
