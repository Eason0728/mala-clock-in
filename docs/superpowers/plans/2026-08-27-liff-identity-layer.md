# LIFF 身分層 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同仁在 LINE 裡用自己的 LINE 帳號打卡，取代現在每人一條、可轉傳的 `?k=` 專屬連結。

**Architecture:** 採「轉接層」而非改造。新增獨立檔案 `apps-script/Liff.gs`，定義 `LIFF_HANDLERS`（模仿既有 `PAYROLL_HANDLERS` 的動態併入機制）。新 handler 先用 LINE 的 ID token 驗證取得可信 userId，再從 roster 查出該員工既有的 `key`，然後**直接呼叫原本的 `handleClock` / `handleWhoami` / `handleMyRecent`**。既有函式一行不改，`?k=` 舊路徑完全不受影響，回退只需移除 Code.gs 的三行併入。

**Tech Stack:** Google Apps Script（後端）、Google 試算表（資料）、LIFF SDK 2.x（前端）、LINE ID token 驗證 API、Node.js（測試）、Python mock server（本機測試）

**Spec:**
- 原始設計文件：`/Users/guoeason/mala-schedule/docs/superpowers/specs/2026-07-05-employee-clock-in-design.md`
- 階段 0 驗證結果：`/Users/guoeason/mala-clock-liff/README.md`

---

## Global Constraints

以下每一條都適用於每一個 Task，違反任一條即為未完成：

1. **既有 `?k=` 路徑必須完全不受影響。** 舊連結在整個改造期間持續可用，不強迫同仁同一天全部轉換。任何 Task 完成後，用舊連結打卡都必須照常成功。
2. **roster 新欄位只能 append 在最後。** 程式註解明訂「只在名冊末尾 append，不可插中間（既有資料會錯位）」——`handleClock` 綁裝置那兩行用 `ROSTER_HEADERS.indexOf('欄名') + 1` 換算欄號，插中間會打壞。
3. **改 `clock.html` / `manager.html` 母版後，必須重跑 `python3 tools/build-store-pages.py`。** `clock-cf.html` / `clock-hq.html` 是母版全文複製＋4 處字串置換產生的**獨立靜態檔**，不是執行期切換。漏跑＝央廚與總部停在舊版程式碼。
4. **三份後端要逐份套補丁。** 央廚（`~/mala-gas/cf-clock-in`）與總部（`~/mala-gas/hq-clock-in`）各有自己的 `程式碼.js`，含 repo 沒有的 `setup_sheets` / `add_manager`，且 `doPost` handlers 縮排是 2 空格——**套補丁的錨點不可寫死縮排**。
5. **補丁的「是否已套用」判斷必須用完整片段，不可用函式名子字串。** 2026-08-23 的教訓：用子字串 `'isTrip' in src` 判斷，而前一步剛加的 `isTripDay` 含這個子字串 → 三份全被誤判成已套用而跳過 → 出差照樣扣全勤，`node --check` 完全過。
6. **不得擅自建立或部署正式雲端資源。** 任何 `clasp push`、新增正式試算表、正式 Apps Script 部署，都必須先問 Eason（守則 §12 停損訊號）。本計畫的 Task 1–6 全部在本機完成。
7. **LINE Login Channel ID 為 `2011292256`**（非機密，會出現在前端）。ID token 驗證的 `client_id` 用這個值。**Channel secret 絕不進 repo。**
8. **每次改後端後跑 `node tests/run-all.js`，必須全綠才能進下一個 Task。**

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `apps-script/Liff.gs` | **新建** | LIFF 身分層全部邏輯：ID token 驗證、userId↔員工查詢、綁定、轉接既有 handler |
| `apps-script/Code.gs` | 修改（3 行） | 併入 `LIFF_HANDLERS`；新增 2 個 roster 欄位常數 |
| `tests/liff-identity.test.js` | **新建** | Liff.gs 的單元測試 |
| `tests/roster-headers.test.js` | 修改 | 更新為 14 欄 |
| `mock/mock_server.py` | 修改 | 加入 LIFF action 的模擬，讓前端能本機測 |
| `clock.html` | 修改 | 身分層雙模式（`?k=` 或 LIFF）、定位預熱 |
| `tools/build-store-pages.py` | 不改 | 但每次改母版後必須重跑 |

**新增的 roster 欄位（append 在第 13、14 欄）：** `line_user_id`、`line_bound_at`

---

## Task 1：roster 新增 LINE 綁定欄位

**Files:**
- Modify: `apps-script/Code.gs`（`ROSTER_HEADERS` 常數）
- Test: `tests/roster-headers.test.js`

**Interfaces:**
- Produces: `ROSTER_HEADERS` 含 14 個欄位，最後兩個為 `line_user_id`、`line_bound_at`

- [ ] **Step 1: 先看現況，確認欄位順序與測試現在怎麼寫**

```bash
cd /Users/guoeason/mala-clock-in
grep -n "ROSTER_HEADERS" apps-script/Code.gs | head -5
cat tests/roster-headers.test.js
```

- [ ] **Step 2: 改測試，預期 14 欄（先讓它紅）**

在 `tests/roster-headers.test.js` 中，把預期的欄位陣列改成：

```javascript
const EXPECTED = [
  'emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active',
  'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by',
  'line_user_id', 'line_bound_at'
];
```

並加一個新測試，確認新欄位在最後（這條防的是「有人日後插到中間」）：

```javascript
assert.strictEqual(EXPECTED.indexOf('line_user_id'), 12, 'line_user_id 必須是第 13 欄（index 12）');
assert.strictEqual(EXPECTED.indexOf('line_bound_at'), 13, 'line_bound_at 必須是第 14 欄（index 13）');
assert.strictEqual(EXPECTED.length, 14, 'roster 應為 14 欄');
```

- [ ] **Step 3: 跑測試，確認它失敗**

```bash
cd /Users/guoeason/mala-clock-in && node tests/roster-headers.test.js
```

預期：FAIL，訊息顯示實際只有 12 欄。**如果它通過了，代表測試沒真的比對到東西，先修測試。**

- [ ] **Step 4: 改 Code.gs 的 ROSTER_HEADERS，append 兩欄在最後**

```javascript
const ROSTER_HEADERS = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active',
  'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by',
  'line_user_id', 'line_bound_at'];
```

- [ ] **Step 5: 跑測試，確認通過**

```bash
cd /Users/guoeason/mala-clock-in && node tests/run-all.js
```

預期：全綠。**特別確認薪資相關測試沒被影響**——它們讀 roster，欄位變動有可能波及。

- [ ] **Step 6: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add apps-script/Code.gs tests/roster-headers.test.js
git commit -m "roster 新增 line_user_id / line_bound_at 兩欄（append 在末尾）"
```

---

## Task 2：ID token 驗證與 userId 查詢

**Files:**
- Create: `apps-script/Liff.gs`
- Test: `tests/liff-identity.test.js`

**Interfaces:**
- Consumes: Task 1 的 `line_user_id` 欄位
- Produces:
  - `verifyLineIdToken_(idToken)` → `string userId` 或 `null`
  - `findRosterByLineUser_(rows, userId)` → roster 物件或 `undefined`

- [ ] **Step 1: 寫失敗測試**

建立 `tests/liff-identity.test.js`：

```javascript
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 載入 Liff.gs 到 sandbox，並注入假的 UrlFetchApp
function loadLiff(fetchImpl) {
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: fetchImpl },
    CONFIG: { LINE_CHANNEL_ID: '2011292256' },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

// 1. 驗證成功時回傳 sub
{
  const s = loadLiff(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sub: 'U1234567890abcdef', aud: '2011292256' }),
  }));
  assert.strictEqual(s.verifyLineIdToken_('good-token'), 'U1234567890abcdef');
  console.log('✓ 有效 token 回傳 userId');
}

// 2. 非 200 回傳 null
{
  const s = loadLiff(() => ({ getResponseCode: () => 400, getContentText: () => '{"error":"invalid"}' }));
  assert.strictEqual(s.verifyLineIdToken_('bad-token'), null);
  console.log('✓ 無效 token 回傳 null');
}

// 3. aud 不符必須拒絕（防別的 channel 的 token 冒用）
{
  const s = loadLiff(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sub: 'Uxxxx', aud: '9999999999' }),
  }));
  assert.strictEqual(s.verifyLineIdToken_('other-channel-token'), null);
  console.log('✓ aud 不符的 token 被拒絕');
}

// 4. 空 token 不打 API 直接回 null
{
  let called = false;
  const s = loadLiff(() => { called = true; return null; });
  assert.strictEqual(s.verifyLineIdToken_(''), null);
  assert.strictEqual(called, false, '空 token 不應該打外部 API');
  console.log('✓ 空 token 短路');
}

// 5. findRosterByLineUser_
{
  const s = loadLiff(() => null);
  const rows = [
    { emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Uaaa' },
    { emp_id: 'E02', key: 'k2', active: 'true', line_user_id: '' },
    { emp_id: 'E03', key: 'k3', active: 'false', line_user_id: 'Uccc' },
  ];
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uaaa').emp_id, 'E01');
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uzzz'), undefined);
  assert.strictEqual(s.findRosterByLineUser_(rows, ''), undefined, '空 userId 不可比對到空欄位');
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uccc'), undefined, '離職者不可查得');
  console.log('✓ findRosterByLineUser_ 正確');
}

console.log('\n✅ liff-identity 全部通過');
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
cd /Users/guoeason/mala-clock-in && node tests/liff-identity.test.js
```

預期：FAIL，`ENOENT: no such file ... Liff.gs`

- [ ] **Step 3: 建立 Liff.gs，寫最小實作**

```javascript
/**
 * LIFF 身分層 —— 獨立檔案，不修改 Code.gs 的任何既有函式。
 *
 * 設計原則：轉接而非改造。
 * 新 handler 先驗 ID token 取得可信 userId，再從 roster 查出該員工既有的 key，
 * 然後直接呼叫原本的 handleClock / handleWhoami / handleMyRecent。
 *
 * 回退方式：移除 Code.gs 中併入 LIFF_HANDLERS 的三行，即完全回到原狀。
 */

var LIFF_CONFIG = {
  CHANNEL_ID: '2011292256',            // 鼎兆元打卡登入（非機密，前端也看得到）
  VERIFY_URL: 'https://api.line.me/oauth2/v2.1/verify',
};

/**
 * 驗證 LIFF 的 ID token，回傳可信的 userId。
 *
 * ⚠ 絕不可直接信任前端傳來的 userId——那是任何人都能偽造的字串。
 * 必須拿 ID token 向 LINE 驗證，取回應中的 sub。
 */
function verifyLineIdToken_(idToken) {
  if (!idToken) return null;
  var channelId = (typeof CONFIG !== 'undefined' && CONFIG.LINE_CHANNEL_ID)
    ? CONFIG.LINE_CHANNEL_ID : LIFF_CONFIG.CHANNEL_ID;
  var res = UrlFetchApp.fetch(LIFF_CONFIG.VERIFY_URL, {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  var data = JSON.parse(res.getContentText());
  if (!data || !data.sub) return null;
  if (String(data.aud) !== String(channelId)) return null;   // 防別的 channel 的 token 冒用
  return String(data.sub);
}

/** 用 userId 查在職員工。空 userId 一律查不到（否則會比對到未綁定者的空欄位）。 */
function findRosterByLineUser_(rows, userId) {
  if (!userId) return undefined;
  return rows.filter(function (r) {
    return String(r.line_user_id) === String(userId)
        && String(r.active).toLowerCase() === 'true';
  })[0];
}
```

- [ ] **Step 4: 跑測試，確認通過**

```bash
cd /Users/guoeason/mala-clock-in && node tests/liff-identity.test.js
```

預期：5 項全部 ✓

- [ ] **Step 5: 故意改壞一行，確認測試會紅**

把 `if (String(data.aud) !== String(channelId)) return null;` 暫時註解掉，重跑測試，**必須看到第 3 項失敗**。確認後改回來。

（這一步是 `tests/README.md` 明列的踩坑教訓：測試全綠但其實什麼都沒比到。）

- [ ] **Step 6: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add apps-script/Liff.gs tests/liff-identity.test.js
git commit -m "新增 LIFF 身分層：ID token 驗證與 userId 查詢"
```

---

## Task 3：綁定 handler（liff_bind）

**Files:**
- Modify: `apps-script/Liff.gs`
- Test: `tests/liff-identity.test.js`

**Interfaces:**
- Consumes: Task 2 的 `verifyLineIdToken_`、`findRosterByLineUser_`
- Produces: `handleLiffBind_(body)` → `{ok, name, emp_id}` 或 `{ok:false, error}`
  - 接受 `body.id_token`（LIFF ID token）與 `body.key`（店長給的啟用碼）
  - 錯誤碼：`invalid_id_token` / `no_roster` / `invalid_key` / `already_bound_other_user` / `line_account_in_use`

### ⚠ 本 Task 必須用的既有介面（已查證，照抄不要自創）

計畫初稿假設的函式名有誤，以下是 `Code.gs` 的**實際**介面：

| 用途 | 實際函式 | 備註 |
|---|---|---|
| 取得試算表 | `getSS()` | 無參數 |
| 取得分頁 | `ss.getSheetByName('roster')` | 取不到要回 `no_roster` |
| **補上缺少的欄位** | `ensureRosterHeaders(rosterSheet)` | **不可省略，理由見下** |
| 讀名冊 | `readSheetAsObjects(rosterSheet).rows` | 每列附 `__rowIndex`（實際列號） |
| 寫某一格 | `setRosterCell(sheet, rowIndex, header, value, asText)` | **5 個參數**，不是 `(empId, col, val)` |
| 時間戳 | `nowTaipeiIso()` | 不是 `nowIso_` |

**為什麼 `ensureRosterHeaders` 不可省略**：`setRosterCell` 是依「試算表當下實際表頭」找欄號的
（Code.gs:981-989），而 Task 1 只改了程式裡的 `ROSTER_HEADERS` 常數，**三家店既有的試算表還沒有
`line_user_id` / `line_bound_at` 這兩欄**。欄位不存在時 `setRosterCell` **回傳 `false` 而不是 throw**——
綁定會回報成功但什麼都沒寫入，是最難查的那種 bug。`ensureRosterHeaders` 會把常數裡有、
表頭沒有的欄位補到最右邊，必須在寫入前呼叫。

**為什麼 `line_bound_at` 要用 `asText = true`**：純日期時間字串若不鎖成文字，Sheets 會轉成 Date 物件，
之後讀回來型別就不一致。既有的 `removed_at` 就是這樣處理的（Code.gs:1076）。

**同構範本**：`handleMgrSetActive`（Code.gs:1039-1077）做的事跟本 Task 完全同構
（取 sheet → ensureRosterHeaders → 讀 rows → setRosterCell 改幾格），照它的寫法。

- [ ] **Step 1: 寫失敗測試（六種情境）**

在 `tests/liff-identity.test.js` 末尾（最後那行 `console.log` 之前）加入：

```javascript
// ── 綁定 handler ──
function loadLiffWithSheet(fetchImpl, rows, writes) {
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const fakeSheet = { __name: 'roster' };
  const sandbox = {
    UrlFetchApp: { fetch: fetchImpl },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? fakeSheet : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: (sheet) => { writes.push(['__ensure', sheet === fakeSheet]); },
    setRosterCell: (sheet, rowIndex, header, val, asText) => {
      writes.push([rowIndex, header, val, !!asText]); return true;
    },
    nowTaipeiIso: () => '2026-08-27T12:00:00+08:00',
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}
const okFetch = (sub) => () => ({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({ sub: sub, aud: '2011292256' }),
});

// 6. 成功綁定：先確保欄位存在，再寫入兩欄（line_bound_at 需鎖成文字）
{
  const writes = [];
  const rows = [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  const r = s.handleLiffBind_({ id_token: 't', key: 'k1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.emp_id, 'E01');
  assert.deepStrictEqual(writes[0], ['__ensure', true], '寫入前必須先呼叫 ensureRosterHeaders');
  assert.deepStrictEqual(writes[1], [5, 'line_user_id', 'Unew', false]);
  assert.deepStrictEqual(writes[2], [5, 'line_bound_at', '2026-08-27T12:00:00+08:00', true]);
  console.log('✓ 綁定成功：先補欄位，再寫回兩欄，時間戳鎖文字');
}

// 7. 啟用碼錯誤
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'WRONG' }).error, 'invalid_key');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0, '失敗時不可寫入任何一格');
  console.log('✓ 錯誤啟用碼被拒絕且未寫入');
}

// 8. 該員工已綁別的 LINE 帳號 → 需店長解綁
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Uold', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'k1' }).error, 'already_bound_other_user');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0);
  console.log('✓ 已綁他人帳號時拒絕');
}

// 9. 同一 LINE 帳號想綁第二位員工 → 拒絕
{
  const writes = [];
  const rows = [
    { emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Udup', __rowIndex: 5 },
    { emp_id: 'E02', key: 'k2', active: 'true', line_user_id: '', __rowIndex: 6 },
  ];
  const s = loadLiffWithSheet(okFetch('Udup'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'k2' }).error, 'line_account_in_use');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0);
  console.log('✓ 一個 LINE 帳號不可綁兩位員工');
}

// 10. 重綁自己（同一 userId 同一員工）視為成功，且不重複寫入
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Usame', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Usame'), rows, writes);
  const r = s.handleLiffBind_({ id_token: 't', key: 'k1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0, '已是同一組時不該重寫');
  console.log('✓ 重複綁定自己不報錯也不重寫');
}

// 11. 取不到 roster 分頁 → no_roster，不可 throw
{
  const writes = [];
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Unew') },
    getSS: () => ({ getSheetByName: () => null }),
    readSheetAsObjects: () => { throw new Error('不該被呼叫'); },
    ensureRosterHeaders: () => { throw new Error('不該被呼叫'); },
    setRosterCell: () => { throw new Error('不該被呼叫'); },
    nowTaipeiIso: () => '', console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.strictEqual(sandbox.handleLiffBind_({ id_token: 't', key: 'k1' }).error, 'no_roster');
  console.log('✓ 沒有 roster 分頁時乾淨回錯，不 throw');
}
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
cd /Users/guoeason/mala-clock-in && node tests/liff-identity.test.js
```

預期：第 6 項起 FAIL，`handleLiffBind_ is not a function`

- [ ] **Step 3: 在 Liff.gs 實作 handleLiffBind_**

```javascript
/**
 * 綁定：把 LINE 帳號與員工對上。
 *
 * 流程：驗 ID token 拿到可信 userId → 用店長給的啟用碼(key)找到員工 → 寫回 roster。
 * 啟用碼綁定後**不作廢**——舊連結保留為退路，不強迫同仁同一天全部轉換。
 *
 * ⚠ 寫入前一定要 ensureRosterHeaders：setRosterCell 依試算表當下表頭找欄號，
 *   欄位不存在時它回 false 而不是 throw，會變成「回報成功但沒寫入」的靜默失敗。
 */
function handleLiffBind_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };

  var rosterSheet = getSS().getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };
  ensureRosterHeaders(rosterSheet);
  var rows = readSheetAsObjects(rosterSheet).rows;

  // 這個 LINE 帳號是否已經綁在別的員工身上？
  var existing = findRosterByLineUser_(rows, userId);

  var target = rows.filter(function (r) {
    return String(r.key) === String(body.key)
        && String(r.active).toLowerCase() === 'true';
  })[0];
  if (!target) return { ok: false, error: 'invalid_key' };

  if (existing && String(existing.emp_id) !== String(target.emp_id)) {
    return { ok: false, error: 'line_account_in_use' };
  }

  // 該員工已綁了另一個 LINE 帳號 → 要店長先解綁，避免默默換人
  if (target.line_user_id && String(target.line_user_id) !== String(userId)) {
    return { ok: false, error: 'already_bound_other_user' };
  }

  // 已經是綁好的同一組，直接回成功（同仁重按不該報錯，也不該重寫）
  if (String(target.line_user_id) === String(userId)) {
    return { ok: true, name: target.name, emp_id: target.emp_id, already: true };
  }

  setRosterCell(rosterSheet, target.__rowIndex, 'line_user_id', userId);
  // 純日期時間字串鎖成文字，避免被 Sheets 轉成 Date 物件（同 removed_at 的處理）
  setRosterCell(rosterSheet, target.__rowIndex, 'line_bound_at', nowTaipeiIso(), true);
  return { ok: true, name: target.name, emp_id: target.emp_id };
}
```

- [ ] **Step 4: 跑測試，確認 11 項全過**

```bash
cd /Users/guoeason/mala-clock-in && node tests/liff-identity.test.js
```

- [ ] **Step 5: 故意改壞一行，確認測試會紅**

暫時把 `ensureRosterHeaders(rosterSheet);` 註解掉，重跑測試，**必須看到第 6 項失敗**
（斷言 `writes[0]` 應為 `['__ensure', true]`）。確認後改回來。

這一步防的正是本 Task 最容易出的錯：漏掉 ensureRosterHeaders 會造成靜默失敗，
而靜默失敗在單元測試裡看起來跟成功一模一樣——除非你像這樣明確斷言它被呼叫過。

- [ ] **Step 6: 跑全部測試**

```bash
cd /Users/guoeason/mala-clock-in && node tests/run-all.js
```

預期：全綠。

- [ ] **Step 7: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add apps-script/Liff.gs tests/liff-identity.test.js
git commit -m "LIFF 綁定 handler：一人一帳號雙向檢查，啟用碼不作廢保留退路"
```

---

## Task 4：轉接層 —— 打卡與查詢支援 LINE 身分

**Files:**
- Modify: `apps-script/Liff.gs`（新增轉接 handler 與 `LIFF_HANDLERS`）
- Modify: `apps-script/Code.gs`（併入 `LIFF_HANDLERS`，3 行）
- Test: `tests/liff-identity.test.js`

**Interfaces:**
- Consumes: Task 3 的 `handleLiffBind_`、Task 2 的查詢函式
- Produces: 全域 `LIFF_HANDLERS` 物件，含 `liff_bind` / `liff_whoami` / `liff_clock` / `liff_my_recent`
  - 轉接層錯誤碼：`invalid_id_token` / `no_roster` / `not_bound`

**⚠ 本 Task 沿用 Task 3 已查證的實際介面**：`getSS()`、`ss.getSheetByName('roster')`、
`readSheetAsObjects(sheet).rows`、`nowTaipeiIso()`。不要使用 `readRosterRows_` 或 `nowIso_`，那兩個不存在。

- [ ] **Step 1: 寫失敗測試 —— 轉接層必須把 userId 換成 key 後呼叫既有 handler**

在 `tests/liff-identity.test.js` 加入：

```javascript
// 11. liff_clock 應轉呼叫 handleClock，且帶入該員工的 key
{
  const rows = [{ emp_id: 'E01', name: '測試一', key: 'SECRET_KEY_1', active: 'true', line_user_id: 'Ume' }];
  let received = null;
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Ume') },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? { __name: 'roster' } : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: () => {},
    setRosterCell: () => true,
    nowTaipeiIso: () => '2026-08-27T12:00:00+08:00',
    handleClock: (b) => { received = b; return { ok: true, status: 'ok' }; },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const r = sandbox.LIFF_HANDLERS.liff_clock({
    id_token: 't', type: 'in', lat: 24.784, lng: 121.015, accuracy: 12, device_id: 'D1',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(received.key, 'SECRET_KEY_1', '必須帶入該員工的 key');
  assert.strictEqual(received.type, 'in', '原本的參數必須原封傳遞');
  assert.strictEqual(received.accuracy, 12);
  assert.strictEqual(received.id_token, undefined, 'id_token 不應傳進既有 handler');
  console.log('✓ liff_clock 正確轉接');
}

// 12. 未綁定者打卡 → not_bound，且不可呼叫 handleClock
{
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: '' }];
  let called = false;
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Ustranger') },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? { __name: 'roster' } : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: () => {}, setRosterCell: () => true, nowTaipeiIso: () => '',
    handleClock: () => { called = true; return { ok: true }; },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const r = sandbox.LIFF_HANDLERS.liff_clock({ id_token: 't', type: 'in' });
  assert.strictEqual(r.error, 'not_bound');
  assert.strictEqual(called, false, '未綁定不可進入既有打卡邏輯');
  console.log('✓ 未綁定者被擋在轉接層之外');
}
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
cd /Users/guoeason/mala-clock-in && node tests/liff-identity.test.js
```

預期：`Cannot read properties of undefined (reading 'liff_clock')`

- [ ] **Step 3: 在 Liff.gs 實作轉接層**

```javascript
/**
 * 轉接：把「LINE 身分」換成「既有的 key 身分」，然後呼叫原本的 handler。
 *
 * 這是整份設計的核心——既有的 handleClock / handleWhoami / handleMyRecent
 * 一行都不用改，也就不可能被改壞。
 */
function withLineIdentity_(body, innerHandler) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };

  // 唯讀查身分，刻意不呼叫 ensureRosterHeaders——這條路徑不寫入。
  // 若表頭還沒有 line_user_id 欄，讀出來的列就沒有該屬性，findRosterByLineUser_
  // 自然查不到而回 not_bound，那正是「還沒綁定」的正確答案。
  var rosterSheet = getSS().getSheetByName('roster');
  if (!rosterSheet) return { ok: false, error: 'no_roster' };

  var roster = findRosterByLineUser_(readSheetAsObjects(rosterSheet).rows, userId);
  if (!roster) return { ok: false, error: 'not_bound' };

  // 複製一份 body，換上該員工的 key，並移除 id_token（不讓它流進既有邏輯）
  var inner = {};
  Object.keys(body).forEach(function (k) {
    if (k !== 'id_token' && k !== 'action') inner[k] = body[k];
  });
  inner.key = roster.key;
  return innerHandler(inner);
}

var LIFF_HANDLERS = {
  liff_bind: handleLiffBind_,
  liff_clock: function (body) { return withLineIdentity_(body, handleClock); },
  liff_whoami: function (body) { return withLineIdentity_(body, handleWhoami); },
  liff_my_recent: function (body) { return withLineIdentity_(body, handleMyRecent); },
};
```

- [ ] **Step 4: 在 Code.gs 併入 LIFF_HANDLERS**

找到既有的 `PAYROLL_HANDLERS` 併入區塊，**在它後面**加入結構完全相同的三行：

```javascript
if (typeof LIFF_HANDLERS !== 'undefined') {
  Object.keys(LIFF_HANDLERS).forEach(function (k) { handlers[k] = LIFF_HANDLERS[k]; });
}
```

> **這三行是整個改造對 Code.gs 的唯一改動。回退＝刪掉它們。**

- [ ] **Step 5: 跑全部測試**

```bash
cd /Users/guoeason/mala-clock-in && node tests/run-all.js
```

預期：全綠，含既有的薪資與假別測試。

- [ ] **Step 6: 語法檢查（Apps Script 沒有編譯期，這步不能省）**

⚠ `node --check apps-script/Liff.gs` 在本機的 Node 版本會拋 `ERR_UNKNOWN_FILE_EXTENSION`——
Node 不認得 `.gs` 副檔名。改用 stdin 餵入（已實測可用）：

```bash
cd /Users/guoeason/mala-clock-in && node --input-type=commonjs --check - < apps-script/Liff.gs && node --input-type=commonjs --check - < apps-script/Code.gs && echo "語法 OK"
```

（Task 7 部署時檢查的是 `程式碼.js` 與 `Liff.js`，副檔名是 `.js`，那邊 `node --check <檔案>` 可正常使用。）

- [ ] **Step 7: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add apps-script/Liff.gs apps-script/Code.gs tests/liff-identity.test.js
git commit -m "LIFF 轉接層：userId 換 key 後呼叫既有 handler，Code.gs 僅加 3 行"
```

---

## Task 5：mock server 支援 LIFF action

**Files:**
- Modify: `mock/mock_server.py`

**Interfaces:**
- Produces: mock `/api` 支援 `liff_bind` / `liff_clock` / `liff_whoami` / `liff_my_recent`
- 測試用假 token：`MOCK_ID_TOKEN_<userId>`（例如 `MOCK_ID_TOKEN_Utest1`），mock 直接解析出 userId，不打真的 LINE API

> **給執行者：** 本 Task 的實作步驟刻意不給完整程式碼——`mock_server.py` 有 56KB，
> 寫計畫時未逐行讀過，硬寫程式碼會與它既有的分派風格打架。
> 請先完成 Step 1 把結構看清楚，再照它的風格實作。
> **驗收標準在 Step 4～5 的 curl 指令，那是明確的**：行為與錯誤碼必須與 `Liff.gs` 完全一致。

- [ ] **Step 1: 看 mock server 現有的 action 分派結構**

```bash
cd /Users/guoeason/mala-clock-in
grep -n "def handle_\|action ==" mock/mock_server.py | head -30
```

- [ ] **Step 2: 加入假 token 解析與四個 LIFF action**

依照 mock_server.py 既有的分派寫法（照抄它的風格，不要另立一套），加入：

```python
MOCK_TOKEN_PREFIX = 'MOCK_ID_TOKEN_'

def mock_verify_id_token(id_token):
    """本機測試用：不打 LINE API，直接從假 token 解出 userId。
    格式 MOCK_ID_TOKEN_<userId>，不符格式一律回 None。"""
    if not id_token or not id_token.startswith(MOCK_TOKEN_PREFIX):
        return None
    uid = id_token[len(MOCK_TOKEN_PREFIX):]
    return uid or None
```

四個 action 的行為必須與 Liff.gs 一致（同樣的錯誤碼：`invalid_id_token` / `not_bound` / `invalid_key` / `already_bound_other_user` / `line_account_in_use`）。

- [ ] **Step 3: 為種子資料加上 line_user_id 欄位**

⚠ `mock/mock_data.json` **是 gitignore 的**（`.gitignore:2`），不能直接改它然後 commit——
那是每個開發者本機各自產生的檔案。正確做法是改**產生它的程式**：

- 在 `seed_data()` 裡讓新種子員工帶有空的 `line_user_id` 與 `line_bound_at`
- 在 `load_data()` 加一段 migration，讓**既有的**本機檔案在下次讀取時自動補上這兩個欄位

兩者都要做：前者服務「刪掉檔案重新產生」的人，後者服務「已經有舊檔案」的人。

- [ ] **Step 4: 手動驗證四個 action**

```bash
cd /Users/guoeason/mala-clock-in/mock && python3 mock_server.py
```

另開一個終端機：

```bash
curl -s -X POST http://localhost:8899/api -d '{"action":"liff_whoami","id_token":"MOCK_ID_TOKEN_Utest1"}'
```

預期：`{"ok":false,"error":"not_bound"}`（還沒綁）

```bash
curl -s -X POST http://localhost:8899/api -d '{"action":"liff_bind","id_token":"MOCK_ID_TOKEN_Utest1","key":"testkey1"}'
```

預期：`{"ok":true,"name":"測試一","emp_id":"E01"}`

```bash
curl -s -X POST http://localhost:8899/api -d '{"action":"liff_whoami","id_token":"MOCK_ID_TOKEN_Utest1"}'
```

預期：這次回傳員工資料。

```bash
curl -s -X POST http://localhost:8899/api -d '{"action":"liff_bind","id_token":"MOCK_ID_TOKEN_Uother","key":"testkey1"}'
```

預期：`already_bound_other_user`

- [ ] **Step 5: 確認舊路徑沒壞**

```bash
curl -s -X POST http://localhost:8899/api -d '{"action":"whoami","key":"testkey1","device_id":"D1"}'
```

預期：照常回傳員工資料。**這一步是 Global Constraint 1 的實測。**

- [ ] **Step 6: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add mock/mock_server.py
git commit -m "mock server 支援 LIFF action，用假 token 免打 LINE API"
```

（`mock/mock_data.json` 是 gitignore 的，不要 `git add -f` 它。）

---

## Task 6：前端雙模式身分層 + 定位預熱

**Files:**
- Modify: `clock.html`（身分層、`apiPost` payload、定位流程）
- Regenerate: `clock-cf.html`、`clock-hq.html`（透過 `tools/build-store-pages.py`）

**Interfaces:**
- Consumes: Task 5 的 mock action
- Produces: 頁面在兩種模式下都能運作
  - 有 `?k=` → 舊模式，payload 帶 `key`，action 用 `clock` / `whoami`（**完全不變**）
  - 在 LIFF 內且無 `?k=` → 新模式，payload 帶 `id_token`，action 用 `liff_clock` / `liff_whoami`

- [ ] **Step 1: 加入 LIFF SDK 與模式判斷**

在 `clock.html` 的 `<head>` 加入 SDK：

```html
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
```

在既有的 `var key = qs('k');` 之後加入：

```javascript
var LIFF_ID = '2011292256-L6JQCqj0';
var idToken = null;             // LIFF 模式下的身分憑證
var useLiff = false;            // true = 走 liff_* action

/** 前綴：舊模式回空字串（action 不變），LIFF 模式回 'liff_' */
function actionPrefix() { return useLiff ? 'liff_' : ''; }

/** 身分欄位：舊模式帶 key，LIFF 模式帶 id_token */
function identityPayload() {
  return useLiff ? { id_token: idToken } : { key: key };
}
```

- [ ] **Step 2: 改造 init()，先決定身分模式再載入畫面**

```javascript
function initIdentity() {
  // 網址帶 k → 一律走舊模式，不碰 LIFF（向後相容優先）
  if (key) { useLiff = false; return Promise.resolve(true); }
  if (!window.liff) return Promise.resolve(false);
  return liff.init({ liffId: LIFF_ID }).then(function () {
    if (!liff.isLoggedIn()) { liff.login(); return false; }
    idToken = liff.getIDToken();
    useLiff = !!idToken;
    return useLiff;
  }).catch(function () { return false; });
}
```

`init()` 改成先跑 `initIdentity()`，成功才往下走；兩種模式都失敗時顯示「請用店長給你的專屬打卡連結開啟」。

- [ ] **Step 3: 讓所有 apiPost 呼叫改用 actionPrefix() 與 identityPayload()**

例如原本的：

```javascript
apiPost({ action: 'clock', key: key, device_id: deviceId, type: type, lat: lat, lng: lng, accuracy: acc })
```

改成：

```javascript
var payload = { action: actionPrefix() + 'clock', device_id: deviceId,
                type: type, lat: lat, lng: lng, accuracy: acc };
Object.keys(identityPayload()).forEach(function (k2) { payload[k2] = identityPayload()[k2]; });
apiPost(payload)
```

`whoami`、`my_recent` 比照辦理。**`my_payslip` 這一輪不動**（薪資模組還沒有 LIFF 版 handler，維持走 `PAYROLL_API` + `key`）。

**LIFF 模式下要隱藏「我的薪資」分頁**，因為它沒有 LIFF 版 handler，點了會失敗。做法：

```javascript
// LIFF 模式沒有薪資 handler（my_payslip 仍走 key），先把分頁藏起來避免點了報錯
if (useLiff) {
  var payTab = document.querySelector('.tabbar .tab[data-view="pay"]');
  if (payTab) payTab.style.display = 'none';
}
```

放在 `init()` 決定完身分模式之後。分頁按鈕的實際選擇器已查證：`clock.html:324`
是 `<button class="tab" data-view="pay" type="button">💰 我的薪資</button>`。
**只隱藏按鈕即可**，不要刪除 `#payView` 區塊本身，也不要改動 `my_payslip` 的呼叫邏輯——
下一個計畫要把它接上 LIFF，留著比較好改。

- [ ] **Step 4: 加入綁定畫面**

當 `liff_whoami` 回 `not_bound` 時，顯示一個輸入框請同仁貼上啟用碼，送出 `liff_bind`：

```javascript
function doBind(code) {
  return apiPost({ action: 'liff_bind', id_token: idToken, key: code.trim() })
    .then(function (res) {
      if (res && res.ok) { location.reload(); return; }
      var msg = {
        invalid_key: '啟用碼不正確，請跟店長確認',
        already_bound_other_user: '這個員工已綁定其他 LINE 帳號，請店長先解除綁定',
        line_account_in_use: '你的 LINE 帳號已經綁定另一位員工',
        invalid_id_token: 'LINE 身分驗證失敗，請關掉重開'
      }[res && res.error] || '綁定失敗，請告知主管';
      showBindError(msg);
    });
}
```

- [ ] **Step 5: 定位預熱 —— 頁面載入就開始抓**

階段 0 實測：冷啟動最慢 7,140ms，門檻 8,000ms。同仁按下打卡要等 7 秒會以為當掉。

在 `init()` 末尾加入預熱，**不改動既有的 `getPosition()` 邏輯**，只是先把最新定位存起來：

```javascript
var warmFix = null;     // 預熱拿到的最新定位
var warmWatchId = null;

function startWarmUp() {
  if (!navigator.geolocation) return;
  warmWatchId = navigator.geolocation.watchPosition(function (pos) {
    warmFix = pos;                                  // 持續更新，永遠是最新的
  }, function () {}, GEO_OPTS);
  // 3 分鐘後停掉，避免頁面開著一直耗電
  setTimeout(function () {
    if (warmWatchId !== null) { navigator.geolocation.clearWatch(warmWatchId); warmWatchId = null; }
  }, 180000);
}
```

在 `getPosition(onRetry)` 裡加入捷徑（沿用既有的 `fixLooksGood`，所以過時判斷與精準度門檻的行為完全一致）：

```javascript
if (warmFix && fixLooksGood(warmFix)) { return Promise.resolve(warmFix); }
```

⚠ **插入位置很重要**：必須放在**既有的 localhost 假座標區塊之後**、`return new Promise(function (resolve, reject) {` 之前。

`getPosition` 的第一段是 `if (isLocalHost && FAKE_LOCATIONS[qs('loc')]) { ... return Promise.resolve(...); }`，
那是本機測試用 `?loc=` 模擬座標的機制（`?acc=120` 還能模擬定位誤差）。
捷徑若插在它前面，預熱拿到的真實定位會蓋掉模擬座標，**Step 6 的本機測試就失效了**。

型別相容性已查證：`getPosition` 本來就回傳 Promise，且既有的假座標分支同樣用 `Promise.resolve`；
`fixLooksGood(pos)` 讀的是 `pos.coords.accuracy` 與 `pos.timestamp`，`watchPosition` 給的 position 物件兩者皆有。

- [ ] **Step 6: 本機測舊模式（Global Constraint 1）**

```bash
cd /Users/guoeason/mala-clock-in/mock && python3 mock_server.py
```

瀏覽器開 `http://localhost:8899/clock.html?k=testkey1&api=/api`

驗證：姓名顯示正常、能打卡、今日紀錄出現。**這是舊路徑的迴歸測試，必須完全正常。**

- [ ] **Step 7: 重跑多店產生器（Global Constraint 3）**

```bash
cd /Users/guoeason/mala-clock-in && python3 tools/build-store-pages.py && git status --short
```

預期：`clock-cf.html`、`clock-hq.html`、`manager-cf.html`、`manager-hq.html` 出現在變更清單。

- [ ] **Step 8: 確認產生檔真的含新程式碼**

```bash
cd /Users/guoeason/mala-clock-in
grep -c "initIdentity" clock.html clock-cf.html clock-hq.html
```

預期：三個檔案都是 1 以上。**若 cf/hq 是 0，代表產生器沒跑或沒吃到——停下來查，不要往下走。**

- [ ] **Step 9: Commit**

```bash
cd /Users/guoeason/mala-clock-in
git add clock.html clock-cf.html clock-hq.html manager-cf.html manager-hq.html
git commit -m "前端雙模式身分層（?k= 與 LIFF 並存）＋定位預熱"
```

---

## Task 7：部署到光復店後端（⚠ 需 Eason 同意才能執行）

**Files:**
- Deploy: `~/mala-gas/mala-clock-in/`（光復店，容器繫結）

> **⛔ 這個 Task 開始碰正式雲端資源。執行前必須向 Eason 取得明確同意（Global Constraint 6）。**
> 央廚與總部**不在這一輪**——先讓光復店跑兩週。

- [ ] **Step 1: 先拉線上版，確認與 repo 正本的差異**

```bash
cd ~/mala-gas/mala-clock-in && clasp pull && git diff --stat 2>/dev/null || diff <(cat 程式碼.js) /dev/null | head -5
```

- [ ] **Step 2: 產出部署檔（填入試算表 ID 與金鑰，絕不可 push 佔位版）**

依 `dispatch-resources.md` 記載的既有做法：用 `sed` 把 repo 正本的 `PASTE_` 佔位換成 `deploy-local/ADMIN_KEY.txt` 的金鑰與試算表 ID，產出後 `cp` 成 `程式碼.js`。

**Liff.gs 沒有任何佔位符**（Channel ID 非機密），直接複製即可：

```bash
cp /Users/guoeason/mala-clock-in/apps-script/Liff.gs ~/mala-gas/mala-clock-in/Liff.js
```

- [ ] **Step 3: 部署前語法檢查**

```bash
cd ~/mala-gas/mala-clock-in && node --check 程式碼.js && node --check Liff.js && echo "語法 OK"
```

- [ ] **Step 4: clasp push 並建立新版本部署**

```bash
cd ~/mala-gas/mala-clock-in && clasp push
```

然後在 Apps Script 編輯器建立新版本並 redeploy **同一個部署 ID**（網址不變，前端不用改）。

- [ ] **Step 5: 用舊連結驗證迴歸（最重要的一步）**

用任一位在職同仁的既有 `?k=` 連結打開 `clock.html`，確認姓名正常顯示。
**不要真的打卡**——只驗 `whoami`。若姓名出不來，立刻執行回退（Step 7）。

- [ ] **Step 6: Eason 本人用 LIFF 綁定並實際打一次卡**

開 `https://liff.line.me/2011292256-L6JQCqj0`（Task 8 會把 endpoint 改指向正式打卡頁），
貼上自己的啟用碼綁定，打一次上班卡，然後到試算表確認：
- roster 的 `line_user_id` 有值
- events 多一筆 `status = ok`
- 該筆的 `device_id` 與 `accuracy_m` 都有正常寫入

- [ ] **Step 7: 回退方案（若任何一步出錯，5 分鐘內執行）**

⚠ **回退有兩半，前端先於後端**——前端才是同仁看得到的那一半。

**第一步：前端**（GitHub Pages，同仁直接接觸）

```bash
cd /Users/guoeason/mala-clock-in
git revert --no-edit 8d4abe9 69167f2
python3 tools/build-store-pages.py
git add -A && git commit -m "回退 LIFF 前端" && git push
```

**第二步：後端**（Apps Script）

```bash
cd ~/mala-gas/mala-clock-in
# 刪掉 Code.gs 中併入 LIFF_HANDLERS 的三行，或直接刪除部署檔（檔名是 Liff.js，
# 對應 repo 的 apps-script/Liff.gs）
rm Liff.js && clasp push
```

Liff.js 不存在時，`typeof LIFF_HANDLERS !== 'undefined'` 為 false，那三行自動跳過，
後端完全回到改造前的行為。**舊連結從頭到尾沒有受影響，所以回退不會造成同仁打不了卡。**

只做後端回退而不動前端的話，bare URL 仍會把人導向 LINE 登入，
且 `?k=` 每次載入仍會動態注入 SDK——所以兩半都要做。

- [ ] **Step 8: ⚠ 推廣到光復以外之前，必須先有「解除綁定」功能**

最終審查指出：啟用碼綁定後不作廢（刻意保留為退路），所以拿到轉傳連結的人可以**搶先**
用自己的 LINE 帳號綁上去。真正的同仁接著會拿到 `already_bound_other_user` 而卡住，
目前唯一的解法是 Eason 手動改試算表。裝置綁定這道第二關會把損害限制在
`pending_device_approval`（代打的卡不會直接生效），所以單店試辦可以接受，
但**推廣前必須把解綁做進 manager.html**，否則五個站點的復原程序不可能只靠一個人手改試算表。

（綁定稽核紀錄已於最終審查修正中完成：獨立的 `liff_bind_log` 分頁。）

---

## Task 8：光復店試辦（兩週）

**Files:**
- Modify: LINE Developers Console 的 LIFF endpoint 設定（Eason 操作）

- [ ] **Step 1: 新增一支正式用的 LIFF app**

在同一個 LINE Login channel 下新增第二支 LIFF app（測試那支保留當診斷工具）：
- name：`打卡`
- Size：Full
- Endpoint URL：`https://eason0728.github.io/mala-clock-in/clock.html`
- Scopes：profile、openid

- [ ] **Step 2: 把新的 LIFF ID 填回 clock.html 並重跑產生器**

```bash
cd /Users/guoeason/mala-clock-in
# 把 var LIFF_ID = '...' 換成新的正式 LIFF ID
python3 tools/build-store-pages.py
git add -A && git commit -m "填入正式打卡用 LIFF ID" && git push
```

- [ ] **Step 3: 找 2～3 位光復店同仁綁定（含至少一位 Android）**

階段 0 只測了 iOS。Android 的定位行為與 LINE 版本差異是已知的未驗證項目，
這一步就是讓它暴露。每位綁定後當場打一次卡，確認 events 寫入正常。

- [ ] **Step 4: 觀察兩週**

每週檢查一次：
- events 有無 `pending_device_approval` 暴增（代表裝置綁定與 LINE 身分打架）
- 有無同仁反映打卡變慢（預熱定位有沒有生效）
- roster 的 `line_user_id` 綁定數是否符合預期

- [ ] **Step 5: 決定是否推央廚與總部**

兩週無事再推。推的時候依 Global Constraint 4、5 逐份套補丁，並跑：

```bash
cd /Users/guoeason/mala-clock-in && python3 tools/verify-store-backends.py
```

---

## ⚠ 這一輪**不會**解決的一件事

前面討論 LIFF 化時，「補掉『連結轉傳＝薪資外洩』」是主要理由之一。
**這份計畫沒有補到它。**

原因：「我的薪資」分頁走的是 `PAYROLL_API` + `my_payslip`，屬於薪資模組（`Payroll.gs`），
不在本輪的轉接層範圍。本輪在 LIFF 模式下**先隱藏薪資分頁**，同仁要查薪資仍須用舊的 `?k=` 連結——
**那條連結轉傳出去，對方仍然看得到薪資明細。**

所以本輪的實際收穫是：**打卡身分綁定 LINE 帳號**（代打變難、換手機不用重綁、同仁不用找連結），
薪資外洩要等下一輪處理。這個取捨是刻意的——薪資是敏感資料，值得單獨一輪做完整測試，
不該夾在身分層改造裡一起上。

---

## 不在這份計畫裡的事（後續計畫）

| 項目 | 為什麼延後 |
|---|---|
| 圖文選單（Rich Menu） | 需要設計圖與 Eason 在後台操作；LIFF URL 傳進群組就已可用，不阻擋試辦 |
| 「我的薪資」分頁走 LIFF | 薪資模組要另加 LIFF handler，且薪資是敏感資料，值得單獨一輪 |
| 逐日出勤明細分頁 | 與 LINE 無關，可獨立進行 |
| 支援打卡自動標記店別 | 需要全門市座標表；目前座標寫死在各後端的 `CONFIG`，要先搬出來 |
| manager.html 進 LIFF | 店長主管金鑰外流風險更高，但要等同仁端穩定後再動 |
| 解除綁定功能 | 試辦期間人少，先由 Eason 直接改試算表；正式推開前必須做進 manager.html |
