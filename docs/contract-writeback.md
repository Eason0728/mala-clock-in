# G 線契約｜寫回 Google（`wb|` 簽名、`DUTY_AUTH`、`req_submit` 單號）

- 撰寫：G 線子對話（Opus），2026-11-21。程式在 mala-clock-in 分支 `p25-g-p3-3`（worktree `~/dev/_wt/p25-g-google`），只動 `apps-script/DutyFeed.gs`、`apps-script/Requests.gs`。
- 讀者：S 線（營運系統寫回隊伍 `duty-mirror.js`、`duty-auth.js`、`ops/duty-auth.sh`、`req-line.js`）、E 線（engine 照跑同一份 Requests.gs 時要知道新開關）、大腦。
- 狀態：**v3（2026-11-21 晚）**：驗收五點修正（第 8 節）。v2：拿掉 `DUTY_APPROVE_LOCK`（併進 #195 的鎖）、加第 5 節遠端設定 `auth_cfg`、第 3.5 節寫明重送時怎麼用指紋確認。v1 → v2 差異見第 7 節。改欄位會在 PR 標題寫「契約改動」並通知 S 線。正本＝本檔；playbook `docs/clock-to-mini/contracts/g-line.md` 是複本。
- 依據：設計 `phase2-5-design.md` §4.1–4.4；plan P3-3；並行排程 1.3 G 線。

## 1. 一句話
九店 Google 端（只換 `DutyFeed.js`＋`Requests.js`）多三件事，**全部預設關**：
1. 核定 `mgr_approve`、審單 `mgr_req_decide`／`mgr_req_decide_batch`、作廢 `mgr_req_void` 可以帶 **mini 的寫回簽名**（`wb_id`、`wb_ts`、`wb_sig`）；簽過名的同一個 `wb_id` 只寫一次。
2. 指令碼屬性 `DUTY_AUTH=mini` 時，上面四個動作**只收簽過名的**，其他一律回 `moved_to_mini`。
3. LINE 送申請 `req_submit` 可以帶單號 `req_id`；同一個單號只寫一次（重送回原本那張）。

## 2. 開關（各店指令碼屬性；全部沒設＝跟現在逐字相同）
| 屬性 | 值 | 預設 | 分類 | 填錯值 |
|---|---|---|---|---|
| `DUTY_AUTH` | `mini`／`on`＝只收 mini；空／`google`／`off`／`shadow`＝現行（**全系統只有這一張表**，`auth_cfg` 也用） | 沒設＝現行 | 放寬性規則（交出核定權） | **認不得的值＝現行（不交出核定權）**＋警告（執行紀錄 `console.warn`；`auth_cfg get` 回 `unknown_value:true`）。正常只由 `auth_cfg` 寫 `mini` 或空字串 |
| `DUTY_VER_STRICT` | 空＝關；`0`／`off`／`false`／`no`＝關；其他＝開 | 沒設＝關 | 保護性檢查（兩個舊缺口：帶 `base_ver` 讀不到版本＝擋；寫入前在 #195 那把指令碼鎖內再比一次版本） | 當開 |
- `DUTY_AUTH=mini` 時，`DUTY_VER_STRICT` 一律當開（不看屬性）。
- v1 的 `DUTY_APPROVE_LOCK` 已拿掉：#195 已在 `handleMgrApprove` 寫入前拿指令碼鎖（`REQ_PEND_BLOCK` 沒關就拿，預設就生效），P3-3 改成在同一把鎖內再比一次版本，不另外包一層鎖（兩層同一把鎖會巢狀，實測每筆都 `busy`）。
- 簽名用的金鑰與店代碼沿用門鈴已設好的 `DUTY_PUSH_KEY`（≥ 32 字）、`DUTY_PUSH_STORE`，**不新增金鑰**；營運系統那一邊是保險箱 `push:<店>`（同 `server/duty-push.js` 驗門鈴用的那把）。
- 讀屬性的成本：上面四個動作（不含 `dry_run`）每次多一次 `getProperties()`；其他動作不多讀。
- `req_submit` 的 `req_id` 沒有開關：**呼叫端不帶就跟現在一樣**（現在沒有任何頁面帶）。

## 3. 寫回簽名 `wb|`
### 3.1 請求長相
原本的請求（含 `mgr_key`、`acting_name` 等全部欄位，跟營運系統現在送的一樣）**多三欄**：
```json
{
  "action": "mgr_approve", "mgr_key": "…", "acting_name": "店長甲（DZY001）",
  "date": "2026-11-21", "emp_id": "E012", "periods": [{"start":"10:00","end":"15:00"}], "base_ver": "Qm9vZm9vYmFyYmF6",
  "wb_id": "wb-gf-000123-1a2b", "wb_ts": 1763712000000, "wb_sig": "<64 個小寫十六進位>"
}
```
| 欄 | 規則 |
|---|---|
| `wb_id` | 寫回單號，`/^[A-Za-z0-9_-]{8,64}$/`。**同一筆寫回重送時不變**；Google 用它防重寫。一個 `wb_id` 只對應一個動作與一組對象，不可重用 |
| `wb_ts` | 簽名當下的時間（毫秒，數字）。Google 只收 **現在 ±10 分鐘**。重送時可以（也應該）重簽：換 `wb_ts`、`wb_sig`，`wb_id` 不變 |
| `wb_sig` | `HMAC-SHA256(key=DUTY_PUSH_KEY, msg=簽名字串)` 的小寫十六進位（64 字） |

### 3.2 簽名字串
用 `|` 接起來（UTF-8；各欄照字面，數字用十進位文字）：
```
wb|1|<店代碼>|<action>|<wb_id>|<wb_ts>|<對象>
```
- `<店代碼>`＝該店 `DUTY_PUSH_STORE`（gf、mztjs…，跟門鈴同一個；mini 那邊就是保險箱 `push:<店>` 的 `<店>`）。
- `<對象>` 依動作：
| action | `<對象>` |
|---|---|
| `mgr_approve` | `<emp_id>|<date>|<base_ver>` |
| `mgr_req_decide` | `<id>|<decision>` |
| `mgr_req_decide_batch` | `<ids 用逗號接，照請求裡的順序>|<decision>` |
| `mgr_req_void` | `<id>` |
- `emp_id`、`id` 照請求裡的值轉文字；缺的欄用空字串（例：沒帶 `base_ver` 就是結尾 `…|2026-11-21|`）。
- 簽名綁住「店＋動作＋單號＋時間＋對誰」，時數、理由等內容沒綁（仍要正確的 `mgr_key` 才能過原本的權限檢查）。

範例（假金鑰 `k`×32＝`kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk`、店 `gf`）：
```
msg = "wb|1|gf|mgr_approve|wb-gf-000123-1a2b|1763712000000|E012|2026-11-21|Qm9vZm9vYmFyYmF6"
sig = "70fb31e2d50b704638823055eab0131de269ea4f818d7b73a95d41d18c6ea80b"   （tests/duty-auth.test.js W01 用同一組值比對 Google 端算的結果）
```
Node：`crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')`（跟門鈴 `dutyPushSign_` 同一套 Apps Script 函式）。

### 3.3 Google 怎麼判（順序）
1. 動作不是上面四個，或 `dry_run:true` → 照現在（`mgr_approve_check`、只檢查不寫入都不擋、不驗簽）。
2. 請求有沒有帶 `wb_*`（三欄任一欄出現就算帶）：
   - `DUTY_AUTH=mini`：**沒帶 → `moved_to_mini`**；帶了但不合格 → 回對應錯誤（3.4），不寫。
   - 現行模式（沒設）：沒帶 → 照現在；帶了但不合格 → **當沒帶**（照現在，不防重）；帶了且合格 → 照現在判＋防重。
3. 簽名合格後，`DUTY_AUTH=mini` 的 `mgr_approve` 還要有 `base_ver`，沒有 → `need_base_ver`。
4. **防重（同一把指令碼鎖內查＋放記號）**：拿鎖（最多等 10 秒，拿不到 → `busy`）→ 查記號 `dwb:<wb_id>`：
   - 已寫好 → 直接回當時的成功結果，加 `dup:true`（不再寫）。
   - 正在寫（另一個執行剛放的記號）→ `busy`（`wb_pending:true`）。
   - 沒有 → 放「正在寫」記號（10 分鐘），放鎖，照原本流程判＋寫。
5. 寫完：成功（`ok:true`）→ 記號改「已寫好」並存結果，**留 6 小時**；失敗或丟例外 → 記號拿掉（下一次重送會重新判）。
6. `mgr_approve` 帶 `base_ver`、`DUTY_VER_STRICT` 開（或 `mini`）時：讀不到版本 → `ver_unknown`；寫入前在 #195 那把指令碼鎖內（最多等 10 秒，拿不到 → `busy`）再比一次版本，對不上 → `stale_ver`。`REQ_PEND_BLOCK=off` 時也照樣拿這把鎖。

### 3.4 回應一覽（`ok:false` 時 HTTP 仍是 200，看 `error`）
| `error` | 什麼時候 | 營運系統該怎麼做 | 範例 |
|---|---|---|---|
| （成功） | 照原本動作的成功回應 | 標寫回完成 | `{"ok":true,"date":"2026-11-21","emp_id":"E012",…}` |
| 成功＋`dup:true` | 同一個 `wb_id` 先前已寫好（6 小時內） | 標寫回完成（**不是**衝突） | `{"ok":true,…,"dup":true,"wb_id":"wb-gf-000123-1a2b"}` |
| `moved_to_mini` | `DUTY_AUTH=mini`、沒帶簽名（舊門市核定頁、手打 API） | 營運系統不該收到；收到＝自己忘了簽，當程式錯誤 | `{"ok":false,"error":"moved_to_mini","message":"核定已改在管理系統。系統暫停時請等恢復，不要改用其他頁面。"}` |
| `bad_wb` | `wb_id` 格式錯、`wb_ts` 不是數字、`wb_sig` 不是 64 字十六進位 | 不重試，列衝突（程式錯誤） | `{"ok":false,"error":"bad_wb","message":"寫回欄位格式不對"}` |
| `wb_no_key` | `DUTY_AUTH=mini` 但這家店 `DUTY_PUSH_KEY`／`DUTY_PUSH_STORE` 沒設好 | 不重試，通知（這家店不該切 mini） | `{"ok":false,"error":"wb_no_key","message":"這家店還沒設好寫回金鑰"}` |
| `wb_ts` | `wb_ts` 超出 Google 現在 ±10 分鐘 | 重簽（新 `wb_ts`）再送；連續發生＝mini 時鐘偏了 | `{"ok":false,"error":"wb_ts","message":"寫回簽名時間超過 10 分鐘","now":1763712900000}` |
| `bad_sig` | 簽名對不上（金鑰、店代碼、對象欄不同） | 不重試，列衝突並通知 | `{"ok":false,"error":"bad_sig","message":"寫回簽名不對"}` |
| `need_base_ver` | `mini` 模式、簽名的 `mgr_approve` 沒帶 `base_ver` | 不重試，程式錯誤 | `{"ok":false,"error":"need_base_ver","message":"核定要帶版本"}` |
| `busy` | 鎖拿不到；或同一個 `wb_id` 正在寫（`wb_pending:true`） | **重試**（同 `wb_id`、可重簽） | `{"ok":false,"error":"busy","message":"系統忙碌，請再按一次"}`／`{"ok":false,"error":"busy","message":"這筆正在寫入，請幾秒後再送一次","wb_pending":true}` |
| `ver_unknown` | 帶了 `base_ver`，Google 讀不到現在的版本（讀不到當天資料、名單裡沒有這個人、算不出版本） | **重試**（設計 §4.5：3 次仍失敗＝衝突） | `{"ok":false,"error":"ver_unknown","message":"資料正在更新，請幾秒後再按一次"}` |
| `stale_ver` | 版本對不上（現有行為，沒變） | 衝突，不重試 | `{"ok":false,"error":"stale_ver","message":"…","cur_ver":"…"}` |
| 原本的各種規則錯誤 | `not_pending`、`need_proof`、`pay_locked`、`unauthorized`… | 照設計 §4.5：真衝突 | 照原本 |

### 3.5 營運系統要注意的三件事
1. **6 小時後記號會消失**（CacheService 上限）。重送超過 5 小時還沒成功就不要再送，改走對帳。記號被 Google 提早清掉時，Google 就照原本流程再判一次：核定會因 `base_ver` 已變而回 `stale_ver`、審單回 `not_pending`（「這筆已經處理過了」）、作廢回 `not_approved`。**重送（第 2 次以上）收到這三種，先照下面確認是不是自己上一次其實已經寫進去，再決定算不算衝突**：
   - **第一步：當天指紋**（R 線契約 `r-line.md` 第 4 節）。用 `relay_pull {with:{fp:true}}` 重拉這家店的指紋（或等下一次每小時對帳），取 `fp.<表>[<日期>]`：核定看 `approved`、審單與作廢看 `requests`（日期＝申請單的 `date`）。mini 用自己原始表、同一套 `rowCanon`／`fpOfRows` 算同一天，值是 `"<列數>:<雜湊>"`。**兩邊相同＝Google 那天跟 mini 一模一樣＝自己那筆已寫進去，標完成**。
   - **第二步：指紋不同時看那一列**（`relay_pull {with:{rows:true}}`，或 R 線副本表 `g_approved`／`g_requests` 重拉後）：
     - 核定：`approved` 有 `date`＝那天、`emp_id`＝那人、`periods`、`approved_hours`、`status_text`、`manager_name` 都等於 mini 寫回的值，而且沒有更晚的列（`entered_at` 最大的那列就是它）。`entered_at` 是 Google 寫入時間，不比。另一個捷徑：`stale_ver` 回應帶 `cur_ver`，跟 mini 照自己寫完後的原始列用同一套 `dutyVerOf_` 算出的版本相同，也算同一筆。
     - 審單：`requests` 那個 `id` 的 `status` 是自己的決定（`approved`／`rejected`），`decided_by` 是自己送的核定人姓名（`acting_name`），退回的 `reject_reason` 也相同。
     - 作廢：那個 `id` 的 `status`＝`voided`，`voided_by`、`void_reason` 跟自己送的一樣。
   - 兩步都對不上＝真衝突（別人改過），列「衝突待處理」。
2. 一筆寫回只有一個 `wb_id`；批次審單（`mgr_req_decide_batch`）整批一個 `wb_id`，成功結果裡的 `done`／`skipped` 照原本。
3. 同一店同時送很多筆會排同一把指令碼鎖：一筆一筆送（隊伍本來就是逐筆），不要並發。

## 4. `req_submit` 單號（LINE 送申請）
### 4.1 請求
原本 `req_submit` 的欄位（`id_token`、`kind`、`date`…，含兩段以上的 `segments`）多一欄：
```json
{ "action": "req_submit", "id_token": "…", "kind": "ot", "date": "2026-11-21", "start": "18:00", "end": "20:00", "reason": "…",
  "req_id": "r0123456789abcdef" }
```
- `req_id`：`/^r[0-9a-f]{16}$/`（跟打卡單號同一個格式）；手機產生，**送 mini 與改送 Google 用同一個**。
- 沒帶或空字串＝跟現在完全一樣（Google 自己編號）。帶了但格式不對 → `{"ok":false,"error":"bad_req_id","message":"申請單號格式不對"}`（不寫）。

### 4.2 語意（全部在 `req_submit` 原本那把指令碼鎖內）
- 申請單編號（requests 分頁的 `id` 欄）**直接用 `req_id`**；一次送多段時第 n 段用 `<req_id>_<n>`（`_1`、`_2`…）。所以 mini 端用同一個編號就對得上 Google 那一列，之後審單、作廢都用這個 `id`。
- 鎖內先找 requests 分頁有沒有 `id`＝`req_id` 或開頭是 `<req_id>_` 的列：
  - 有，而且都是這位同仁的 → **不寫**，回當時那張（或那幾張）單現在的樣子，加 `dup:true`（狀態可能已經不是審核中，照實回）。
  - 有，但不是這位同仁的 → `{"ok":false,"error":"req_id_taken","message":"申請單號重複，請重新送出"}`（不寫，也不回別人的單）。
  - 沒有 → 照原本規則判、寫，編號用 `req_id`；寫完放鎖前 `SpreadsheetApp.flush()`。
- 這是查試算表本身（不是暫存記號），所以**沒有時間限制**：mini 停機一天後回來再送，同一個單號還是只算一張。
- **同號查重排在鎖月、額度等檢查之前**（v3）：已寫過的單號，就算那個月後來鎖了，補送也回 `dup`，不回 `pay_locked`。
- 回應形狀跟原本一樣（單張：`{ok, request, summary}`；多段：照原本多段的回應），重送多 `dup:true`。
- `DUTY_AUTH` 不影響 `req_submit`（設計 §4.3：LINE 送出不擋）。身分照舊用 `id_token` 驗：mini 代送時要帶手機的 `id_token`（LINE 的 token 約 1 小時過期；過期 → 原本的 `invalid_token` 類錯誤，mini 要讓手機重送或走對帳）。**沒有「用簽名代替 id_token」的路**（那會改變誰能送單，不在這包）。

## 5. 遠端設定 `auth_cfg`（給 `ops/duty-auth.sh`）
這台沒有別的方式改指令碼屬性，所以比照門鈴的 `push_cfg` 開一個設定動作（掛在 `duty_changes` 底下，不新增動作名稱，不記成考勤變動）。
```json
{ "action": "duty_changes", "mgr_key": "<營運系統代管主管金鑰>", "admin_key": "<管理金鑰>", "acting_name": "資訊部（DZY000）",
  "auth_cfg": { "mode": "mini", "ver_strict": true, "ts": 1763712000000, "nonce": "cfg-gf-0001-7f3a", "sig": "<64 個小寫十六進位>" } }
{ "action": "duty_changes", "mgr_key": "…", "admin_key": "…", "auth_cfg": { "get": true } }
```
- **驗證（三把金鑰都要有）**：①主管金鑰（`managers` 分頁上在職的那把）＋②管理金鑰 `admin_key`（同 `push_cfg`）＋③這家店已設門鈴金鑰時，還要 mini 的設定簽名：
  `sig = HMAC-SHA256(DUTY_PUSH_KEY, "cfg|2|<店代碼>|<mode 照請求原字小寫>|<ver_strict：1／0／沒帶寫 ->|<ts>|<nonce>")`，`ts` 只收 Google 現在 **±2 分鐘**；
  `nonce`＝一次性單號 `/^[A-Za-z0-9_-]{8,64}$/`，每次呼叫都要新的；用過的（暫存區 10 分鐘＋`DUTY_AUTH_LOG` 的 `n` 兩處查）回 `replay`、不動。
  沒設門鈴金鑰的店（瑞光、文心）只能設 `google`（＝現行），切 `mini` 一律 `need_key`。
- **值**：`mode` 只認 `google`、`mini`（別名 `off`、`shadow`＝`google`；`on`＝`mini`）。營運系統的 shadow 模式在 Google 端就是 `google`。`ver_strict` 只認 `true`／`false`，沒帶＝不動。**其他任何值 → `bad_input`，屬性一個都不動（維持原值）**。
- **只寫白名單**：`DUTY_AUTH`（mini→`mini`、google→空字串）、`DUTY_VER_STRICT`（true→`1`、false→空字串）。不碰金鑰、店代碼、其他屬性（有測試）。
- **紀錄**：每次寫入記一筆到 Apps Script 執行紀錄，並存進指令碼屬性 `DUTY_AUTH_LOG`（最近 20 筆 `{at, by, mode, ver_strict, from, n}`；`n`＝nonce；`by`＝主管名單上的名字＋`acting_name`，不含金鑰）。`get:true` 讀得到。
- **回應**：
  - 成功 `{"ok":true,"auth_cfg":{"mode":"mini","ver_strict":true},"changed":true}`
  - 讀現況 `{"ok":true,"auth_cfg":{…},"log":[{"at":"2026-11-21T15:00:00+08:00","by":"營運系統代管／資訊部（DZY000）","mode":"mini","ver_strict":true,"from":"google"}]}`
  - 錯誤：`unauthorized`（任一把金鑰錯）、`bad_sig`（缺簽名、缺 nonce 或簽名錯）、`wb_ts`（超過 ±2 分鐘，附 `now`）、`replay`（nonce 用過）、`bad_input`（值認不得）、`need_key`（沒門鈴金鑰卻要切 mini）、`busy`、`not_supported`（那家店的 `Requests.js` 還是舊版）。
- 生效：下一筆核定就照新模式（不快取）。

## 5b. 版本與退回
- 上線（D2）：九店換 `DutyFeed.js`＋`Requests.js`（＋`程式碼.js` 的程式部分，設定區逐位元組保留），屬性全空 → 跟現在一樣。
- 開：`ops/duty-auth.sh <店> mini --go` 用第 5 節設 `DUTY_AUTH=mini`（S 線）；舊缺口修正可以逐店先開 `DUTY_VER_STRICT`（`auth_cfg {mode:'google', ver_strict:true}`）。
- 退回：清空屬性（秒級，下一筆生效）；程式退回＝部署包 `p3g/rollback_one.sh <店>`。

## 6. 測試對照
`tests/duty-auth.test.js`（寫回、模式、鎖）、`tests/duty-auth-cfg.test.js`（第 5 節）、`tests/req-submit-id.test.js`（第 4 節）、`tests/duty-auth-same.test.js`（屬性全空＝跟改版前逐字相同）。範例 JSON 直接取自測試輸出。S 線寫假 Google 時照第 3.4、4.2、5 節。

## 7. v1 → v2 差異（S 線要對的）
- 拿掉 `DUTY_APPROVE_LOCK`。鎖等待從 20 秒改成 10 秒（#195 那把）；`busy` 的意思不變，照樣重送。
- 新增第 5 節 `auth_cfg`（`ops/duty-auth.sh` 要改成呼叫它）。
- 第 3.5 節寫明重送時怎麼用指紋與原始列確認。

## 8. v2 → v3（2026-11-21 驗收五點）
- **P1**：`DUTY_AUTH` 只剩一張表（第 2 節）；`shadow` 一律＝現行；認不得的值＝現行＋警告（原本當 mini）。
- **P2**：`auth_cfg` 簽名改 `cfg|2|…|ts|nonce`，時間窗 ±2 分鐘、nonce 一次性（第 5 節）。**S 線 `ops/duty-auth.sh` 要改成帶 `nonce`**。
- **P4**：`req_submit` 同號查重提前（第 4.2 節）。
- **P5（說明，不改程式）`dup` 記號只在暫存區 6 小時的風險**：
  - 核定寫回的簽名只在 `wb_ts` ±10 分鐘內有效，所以**被別人攔下重放**只可能發生在簽名後 10 分鐘內；這段時間「已寫好」記號一定還在（6 小時、正常不會 10 分鐘就被清），重放直接回 `dup`。
  - 6 小時只限制 **mini 自己重送**（每次重簽、`wb_id` 不變）。記號提早被清或超過 6 小時，Google 就照原流程再判：核定有 `base_ver`（第二次一定 `stale_ver`）、審單看狀態（`not_pending`）、作廢看狀態（`not_approved`），**不會重寫**；營運系統照第 3.5 節用指紋確認是不是自己寫過的，不會誤判成衝突。
  - 所以不另外在試算表或屬性留永久記號：屬性每天寫入有額度、試算表要新分頁或新欄（會改指紋與表結構），換到的只是「回 `dup` 而不是回原流程錯誤」，安全性沒變。`req_submit` 的單號本來就查試算表（永久）。
