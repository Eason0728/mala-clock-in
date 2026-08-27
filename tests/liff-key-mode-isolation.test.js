/* 2026-08-27 審查 Important 8（Critical 1 的回歸測試）
 *
 * Reviewer 原話："That property is the whole safety argument for this branch and
 * currently nothing enforces it — which is precisely how the head <script> slipped through."
 *
 * 這支測試就是要補上那個「什麼都沒有」：
 *   1. 靜態檢查：整份 clock.html / clock-cf.html / clock-hq.html 裡不可以出現任何指到外部主機的
 *      <script src=...>（Critical 1 就是被一顆這種標籤在 <head> 擋住整份文件解析）。
 *      這正是 reviewer 說「這種形式的檢查真的抓得到那次事故」的做法。
 *   2. 動態檢查：直接從 clock.html 原始碼裡切出真正的 initIdentity()／loadLiffSdk() 函式本體
 *      （不是重寫一份行為相同的替身，是切「正式部署的那段程式碼」本身）丟進 vm 執行，
 *      驗證 ?k= 模式下 initIdentity() 完全不會去讀 window.liff、也不會呼叫
 *      document.createElement 插入任何東西——這是「舊路徑完全不碰 LIFF」這個安全論證
 *      在程式行為層級的驗證，不是只看有沒有一顆標籤。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLOCK_FILES = ['clock.html', 'clock-cf.html', 'clock-hq.html'];

console.log('══ 1) 靜態檢查：不可有任何指到外部主機的 <script src=...> ══');
{
  // 一律用「絕對 URL」判斷是不是外部主機：本機的相對路徑（例如 assets/xxx.js，這份專案目前
  // 其實沒有任何本機 <script src>，但規則要涵蓋這種情況）不算，只有 http(s):// 或
  // protocol-relative（//host/...）才算「會離開這個 origin 去發請求」。
  const EXTERNAL_SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+["'][^>]*>/gi;
  CLOCK_FILES.forEach(function (f) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const matches = html.match(EXTERNAL_SCRIPT_SRC) || [];
    assert.deepStrictEqual(
      matches, [],
      f + ' 出現了指到外部主機的 <script src>（Critical 1 的原始事故就是這種標籤放在 <head>，' +
      '擋住 ?k= 舊模式的整份文件解析）：' + JSON.stringify(matches)
    );
    console.log('  ✓ ' + f + ' 沒有任何指到外部主機的 <script src>');
  });
}

console.log('\n══ 2) 靜態檢查：<head> 裡不可以出現 line-scdn.net（LIFF SDK 的網域）══');
{
  CLOCK_FILES.forEach(function (f) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const headMatch = html.match(/<head[\s\S]*?<\/head>/i);
    assert.ok(headMatch, f + ' 找不到 <head> 區塊，測試本身可能失效，要檢查一下');
    assert.strictEqual(
      headMatch[0].indexOf('line-scdn.net'), -1,
      f + ' 的 <head> 裡出現了 line-scdn.net——LIFF SDK 不可以在 <head> 同步載入'
    );
    console.log('  ✓ ' + f + ' 的 <head> 乾淨，沒有 line-scdn.net');
  });
}

// ── 從 clock.html 原始碼裡切出 loadLiffSdk / initIdentity 的真實函式本體 ──
// 用配對大括號取代文字錨點：這兩支函式內部沒有字串常值或正規表示式含大括號，
// 用最簡單的計數法就能正確切出完整函式，而且不依賴周圍註解文字（註解改寫不會讓這支測試跟著碎掉，
// 只有函式簽名或大括號結構真的變了才會抓不到——那正是我們想測的東西）。
function extractFunctionSource(src, fnName) {
  const needle = 'function ' + fnName + '(';
  const startIdx = src.indexOf(needle);
  if (startIdx === -1) throw new Error('clock.html 裡找不到 function ' + fnName + '() ——結構可能已經改了');
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('function ' + fnName + '() 大括號沒有配對成功，抓取範圍有誤');
  return src.slice(startIdx, i);
}

const clockSrc = fs.readFileSync(path.join(ROOT, 'clock.html'), 'utf8');
const loadLiffSdkSrc = extractFunctionSource(clockSrc, 'loadLiffSdk');
const initIdentitySrc = extractFunctionSource(clockSrc, 'initIdentity');
const combinedSrc = loadLiffSdkSrc + '\n' + initIdentitySrc;

function makeSandbox(opts) {
  const state = {
    createElementCalls: 0,
    liffAccessed: false,
    createdEls: [],
  };
  const sandbox = {
    key: opts.key,
    useLiff: false,
    idToken: null,
    LIFF_ID: 'test-liff-id',
    LIFF_ENABLED: opts.liffEnabled,
    console: console,
    document: {
      createElement: function (tag) {
        state.createElementCalls++;
        const el = { tag: tag };
        state.createdEls.push(el);
        if (opts.onCreateElement) opts.onCreateElement(el);
        return el;
      },
      head: { appendChild: function (el) { if (opts.onAppendChild) opts.onAppendChild(el); } },
    },
  };
  Object.defineProperty(sandbox, 'liff', {
    configurable: true,
    get: function () {
      state.liffAccessed = true;
      return opts.liffRef ? opts.liffRef.current : undefined;
    },
  });
  sandbox.window = sandbox; // window.liff 與裸的 liff 要是同一個插槽
  vm.createContext(sandbox);
  vm.runInContext(combinedSrc, sandbox);
  return { sandbox: sandbox, state: state };
}

console.log('\n══ 3) 動態檢查：?k= 模式下 initIdentity() 完全不碰 LIFF（真正執行 clock.html 的原始程式碼）══');
(async function () {
  // 3a. key 存在 → 舊路徑。這是這支測試的核心斷言：完全不可以呼叫 document.createElement，
  //     也完全不可以讀取 window.liff / 裸的 liff（哪怕只是判斷用的 if (window.liff)）。
  //     LIFF_ENABLED 刻意設成 true，證明就算某天有人把「該店是否啟用」的判斷寫壞，
  //     ?k= 這個更早的短路仍然完全隔絕 LIFF，這才是 reviewer 說的「整個分支的安全論證」。
  {
    const { sandbox, state } = makeSandbox({ key: 'testkey1', liffEnabled: true, liffRef: { current: undefined } });
    const result = await vm.runInContext('initIdentity()', sandbox);
    assert.strictEqual(result, true, '?k= 模式下 initIdentity() 應該直接回傳 true');
    assert.strictEqual(state.createElementCalls, 0,
      '?k= 模式下不可以呼叫 document.createElement——不該有任何載入 LIFF SDK 的動作');
    assert.strictEqual(state.liffAccessed, false,
      '?k= 模式下完全不可以讀取 window.liff／liff——這正是 Critical 1 的頭尾之爭：' +
      '舊模式要「完全不碰」，不是「碰了但沒用到」');
    assert.strictEqual(sandbox.useLiff, false, '?k= 模式下 useLiff 必須維持 false');
    console.log('  ✓ key 存在時：initIdentity() 回傳 true，且從頭到尾沒有碰 document.createElement 或 window.liff');
  }

  // 3b. 對照組：key 不存在、該店啟用 LIFF → 一定要真的走到 loadLiffSdk／liff.init，
  //     證明上面 3a 的「沒有碰」不是因為測試腳手架本身就跑不到那段程式碼、抓取失敗了才誤判通過。
  {
    const fakeLiff = {
      init: function () { return Promise.resolve(); },
      isLoggedIn: function () { return true; },
      getIDToken: function () { return 'FAKE_ID_TOKEN'; },
      login: function () {},
    };
    // liffRef 一開始是 undefined（模擬 SDK 還沒載入、window.liff 還不存在），
    // 直到 <script> 被插入且觸發 onload 之後才「變出」liff——這樣才是真的在測
    // loadLiffSdk() 動態插入的路徑，而不是一開始就給 window.liff 騙過 if (window.liff) 短路。
    const liffRef = { current: undefined };
    const { sandbox, state } = makeSandbox({
      key: '', liffEnabled: true, liffRef: liffRef,
      onAppendChild: function (el) { liffRef.current = fakeLiff; if (el.onload) el.onload(); }, // 模擬 SDK 立刻載入成功
    });
    const result = await vm.runInContext('initIdentity()', sandbox);
    assert.strictEqual(state.createElementCalls, 1, '沒有 key 且該店啟用 LIFF 時應該要插入一顆 <script>');
    assert.strictEqual(state.createdEls[0].tag, 'script');
    assert.strictEqual(state.liffAccessed, true, '這條路徑本來就應該讀取 window.liff——用來證明上面的斷言有意義');
    assert.strictEqual(result, true, 'liff.init 成功、已登入時 initIdentity() 應該回傳 true');
    assert.strictEqual(sandbox.useLiff, true);
    console.log('  ✓ 對照組：沒有 key 時真的會插入 <script> 並讀取 liff——證明 3a 的「沒碰」不是抓取失敗的假陽性');
  }

  console.log('\n✅ liff-key-mode-isolation 全部通過');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
