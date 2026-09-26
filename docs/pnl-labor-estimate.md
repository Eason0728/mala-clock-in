# T15：`pnlLaborEstimate` 唯讀端點（月中人事成本估算）

對應損益系統（`Eason0728/mala-pnl-auto`）需求：`pnlPayroll`（T14）只在「鎖定本月」後回鎖定
快照的定案數字，月中損益草稿想先看一份估算值時沒有東西可讀。本端點即時重算「當月 1 日至
**昨天**（台北時間）」的人事成本，鍵與 `pnlPayroll` 完全相同，另外多回 `as_of` /
`days_elapsed` / `days_in_month` / `method`。

## 端點規格

```
POST {action:'pnlLaborEstimate', key, ym:'YYYY-MM', store}   // 平面 body，同既有 pnlPayroll 慣例
```

- 認證：與 `pnlPayroll` 共用同一把 `PNL_KEY`（Script Property）、同一套 `checkPnlKey_`（連續錯
  20 次鎖 10 分鐘，`CacheService`，兩支端點的失敗計數共用同一個 cache key，互相會疊加失敗次數）。
- `ym` 只能是「今天所在月份」或「上個月」：
  - `ym` ＝當月 → `as_of` ＝昨天；今天是 1 號（還沒有「昨天」）→ `NO_DATA`。
  - `ym` ＝上個月 → 上個月一定已經整月過完，`as_of` ＝上個月最後一天（等同整月即時重算，
    月初 1～10 號左右、上月還沒按「鎖定本月」時特別有用）。
  - 更早的月份／下個月以後 → `BAD_INPUT`（更早的月份請改打 `pnlPayroll` 讀定案快照）。
- 錯誤碼與 `pnlPayroll` 同一集合：`AUTH` / `AUTH_LOCKED` / `BAD_INPUT` / `NO_DATA`
  （`pnlPayroll` 用 `NOT_FINAL`/`NO_SNAPSHOT`，本端點不需要——它本來就不看鎖定狀態）。
- 回應：

```jsonc
{
  ok: true, ym, store,
  as_of: 'YYYY-MM-DD', days_elapsed: 26, days_in_month: 30,
  method: '……（中文說明，見下方「估算原則」）',
  rows: {
    base_ft, ot_ft, attend_ft, allow_ft, mgr, meal, other, pt,
    bonus_sales, bonus_perf, bonus_proj,
    ins_ft_deduct, dorm_ft_deduct, ins_pt_deduct, dorm_pt_deduct,
    co_labor, co_health, co_pension, co_owner, co_group, ins_self, yearend,
  },
  support: { 門市名: 金額, ... },   // 跨店支援請款，只到門市層級
  total: 12345.6,
  not_estimated: ['custom_add', 'custom_ded', 'dorm_income（g.dorm，宿舍收入參考區塊）'],
  red_days_missing: true,   // 選填：只在當月「紅字天數」還沒設定時才會出現，見下方說明
}
```

不含任何人名、員工編號、逐人金額——`rows` 全部是科目彙總，`support` 只到「門市」層級。

## 可估／不可估的鍵

**可估**（與 `pnlPayroll` 定案快照鍵完全相同）：
`base_ft`、`ot_ft`、`attend_ft`、`allow_ft`、`mgr`、`meal`、`other`、`pt`、`bonus_sales`、
`bonus_perf`、`bonus_proj`、`ins_ft_deduct`、`dorm_ft_deduct`、`ins_pt_deduct`、
`dorm_pt_deduct`、`co_labor`、`co_health`、`co_pension`、`co_owner`、`co_group`、
`ins_self`、`yearend`、`support`、`total`。

**估不了／刻意不含**（與 `pnlPayroll` 對齊，`costStable()` 本來就不含這兩塊）：
- `custom_add` / `custom_ded`（自訂加薪／扣款）：性質不定（行銷補助、補發…），科目要人自己判斷，
  本來就是獨立參考區塊、不計入「人事總成本」。
- 宿舍收入（`g.dorm`）：已從薪資費用扣除的參考區塊，不是損益表正式科目。

## 估算原則（`method` 欄位的白話版）

- **底薪與固定津貼**（`base_ft`／`allow_ft`／`mgr`／`attend_ft` 等正職科目）＝月薪 ×
  （截至 `as_of` 的在職比例）。這個比例**不是另外寫一條公式**，而是借用 `payCalcOne` 既有的
  `payRatio()`（「月中到職／離職才折算」機制）：給 `payCalcOne` 一份複本，把 `leave_date`
  設成「`as_of`（若員工原本的到職/離職日更早，取較早的那個）」，等於告訴引擎「這個人在
  `as_of` 這天離職」，`payRatio` 自然算出「已過天數 ÷ 當月天數」。這個複本只影響
  `payRatio()` 讀到的欄位，不會寫回任何地方（純記憶體複本），也不影響 `payAnnualQuota`／
  `payTenureMonths` 等其他讀 `hire_date`／`ym` 的函式（它們不讀 `leave_date`）。
- **PT／加班／餐費／全勤**＝`as_of` 之前已核定工時 × 費率，並疊上 `payroll_input`（工時
  分頁）手動覆蓋的 `support`（跨店支援）／`meal_on`（餐費補助勾選）／`full_attend`（全勤
  勾選）／`wage_override`（PT 月度時薪覆蓋）與手動輸入門市的整月工時。實作上直接呼叫
  `payInputsBase(ym, store, asOf)`——這是既有 `handlePayrollCalc` 用的同一支函式，只是
  新增了一個可選的第三參數 `cutoffDate`（透傳給 `payCollect`，只影響「打卡歸集」那一半；
  `payroll_input` 手動覆蓋本身沒有日期粒度，不受影響），**不是另外寫一套合併規則**
  （2026-09-27 審查修正：原本只呼叫 `payCollect`，漏掉了手動覆蓋那一半——會讓無打卡門市的
  工時、跨店支援請款、計時同仁的全勤/餐費勾選、PT 月度時薪調整全部估成 0 或預設值）。
  ⚠ 與既有系統其餘地方同一套慣例：`payroll_input` 有該員工當月的手動覆蓋列時，是**整列
  取代**打卡歸集（不是欄位級合併），所以如果管理者已經在當月手動填過工時（常見於打卡上線
  前的月份、或無打卡門市），估算會反映那筆手動填的值，而不是打卡歸集值——這是既有系統的
  既定行為，估算端點沒有另立標準。
- **勞健保公司負擔／退休金**：按同一個在職比例折算（正職）；健保／團保整月不折算——與
  `payCalcOne` 既有的「勞保、宿舍 × P；健保、團保、退休金算整月」規則一致，估算沒有另立
  標準。
- **年終獎金提列**＝月提列額 ×（估算比例）——與 `costTotals()` 的月提列公式相同，只是
  用估算出來的 `pr`（在職比例）而非整月的 1。
- **跨店支援請款**＝`as_of` 前已記錄或手動填寫的支援時數 × 費率（缺口時數的平均分擔演算法
  逐字 port 自 `payroll.html` 的 `allocGapHours()`）。
- **獎金**：`ym`＝當月時，只計入 `updated_at` 日期 <= `as_of` 的獎金（用 `updated_at` 粗略
  過濾，沒有逐日時間戳）；`ym`＝上個月時**不套這個過濾**，不論登記日一律計入——上個月一定
  已經整月過完，獎金常常是**次月才補登記**（例如月結後才核發績效獎金），如果照樣用
  `updated_at > as_of` 篩掉，上個月的估算會系統性少計已經確定屬於上個月的獎金
  （2026-09-27 審查修正：原本兩種 `ym` 都套同一個過濾，導致上月估算失真）。
- **紅字天數**：若當月的 `payroll_holiday` 還沒設定，估算直接當 0 計（不像 `handlePayrollCalc`
  那樣在缺紅字天數時嘗試 `payHolidaySync` 自動同步——那條路徑會寫入 `payroll_holiday`
  分頁，違反本端點的唯讀承諾），只影響加班／不足時數的門檻，不影響底薪本身；此時回應會多帶
  `red_days_missing:true`，損益端看到這個旗標應該顯示提醒（見 `mala-pnl-auto` issue #46）。

## 已知限制

- **`payroll_input` 手動覆蓋是整列取代，不是逐欄合併**：見上方「PT／加班／餐費／全勤」一節
  的說明，這是既有系統的既定行為（`payInputsBase` 本來就這樣做），估算端點沿用而非另立標準。
- **獎金**只能用 `updated_at` 欄位的日期粗略過濾，`updated_at` 不可靠或缺漏時會保守地照樣
  計入；當月與上月的過濾規則不同，見上方說明。
- **紅字天數未依比例調整**：`redDays` 用當月完整設定值（不是「已過天數對應的紅字天數」），
  只影響加班／不足時數的門檻，不影響底薪金額本身；缺列時回應會帶 `red_days_missing:true`。

## 唯讀證明

新增的 T15 函式區塊（`payCollect`／`payInputsBase` 之外的部分）整段 grep：

```
$ awk '/^\/\/ ---------- 損益系統唯讀端點（T15/{f=1} f' apps-script/Payroll.gs \
  | grep -nE "setValue|setValues|appendRow|insertSheet|deleteRow|\.clear\(|DriveApp\.create|PropertiesService[^)]*\.set|LockService"
（只有註解命中「不呼叫 setValue/…」那幾行，沒有任何實際呼叫）
```

`payCollect` 本身只新增一個可選的第五參數 `cutoffDate`（純過濾，讀取邏輯不變）；
`payInputsBase` 只新增一個可選的第三參數 `cutoffDate`（透傳給 `payCollect`）。兩者既有唯一
呼叫路徑（`payInputsBase()` 呼叫 `payCollect()`；`handlePayrollCalc` 呼叫 `payInputsBase()`）
都不傳這個新參數，行為與加這個參數之前完全相同。

**分頁存在性檢查**（2026-09-27 審查加）：`handlePnlLaborEstimate_` 進入任何會讀分頁的邏輯
之前，先呼叫 `pnlEstimateSheetsReady_()`——直接 `getSS().getSheetByName(...)` 逐一確認
`master`/`config`/`holiday`/`leave_type`/`bonus`/`input` 六張分頁都存在，缺一張就回
`NO_DATA`，**不透過**會在分頁不存在時自動 `insertSheet` 建表頭的 `payRead()`/`paySheet()`。
確認過都存在之後，才呼叫 `payRead`／`payConfig`／`payHolidayRow`／`payLeaveTypes` 等既有
唯讀 helper——這些 helper 內部雖然還是走 `payRead()`，但因為分頁已經確認存在，
`insertSheet` 那個分支在這條路徑上永遠不會被觸發（`tests/pnl-labor-estimate.test.js` 第
13 項用假 `getSS()` 標記一張分頁「不存在」，驗證回 `NO_DATA`）。

**CacheService 的兩處用途都不是分頁寫入**：`checkPnlKey_` 的金鑰失敗計數（cache key
`pnlkeyfail_payroll`，與 `pnlPayroll` 共用）、以及本端點自己按 `(ym, store, as_of)` 做的
10 分鐘結果快取（cache key 前綴 `pnlestimate|`）。

## 效能

單次呼叫只讀一家店當月的 `master`（通常個位數到十幾人）、`approved`/`events`/`leave`
（該店當月全部列）、`bonus`（該店當月），逐人跑一次 `payCalcOne`（純記憶體計算，無 I/O）。
與既有 `handlePayrollCalc`（管理頁「重新計算」按鈕，同一數量級的資料與計算量）同一數量級，
`handlePayrollCalc` 實測在數十人規模的門市內是秒級完成，`pnlLaborEstimate` 少了
`payReplaceAll` 兩次整表覆寫（唯讀），預期比 `handlePayrollCalc` 更快、遠低於 30 秒門檻。

## 本機測試

```
$ node tests/pnl-labor-estimate.test.js             # 45 項斷言：估算邏輯、cutoff、上月獎金不套過濾、
                                                      # 手動覆蓋合併、red_days_missing、缺分頁 NO_DATA、
                                                      # audit 文字區分端點、快取、錯誤碼、鎖定門檻、唯讀
$ node tests/pnl-labor-estimate-anti-drift.test.js  # 26 項斷言：前端 costTotals/costStable/allocGapHours
                                                      # 逐字抽出，與後端 pnlEstimateClassify_ 用同一組
                                                      # 輸入比對，任何一邊口徑漂移測試就會紅
$ node tests/run-all.js                             # 既有 30 支＋本次新增 2 支＝32 支測試檔全部通過，
                                                      # 證明沒有動到既有計薪邏輯
$ node tools/pnl-labor-estimate-august-compare.js   # 見下方「與定案路徑的比對」
```

### 與「定案路徑」的比對（複製 8 月鎖定情境）

⚠ 這次改動的鐵律是「不准打正式端點、不准碰任何試算表」，所以**無法**用真正的
2026-08 正式鎖定快照做比對（那份資料含真實姓名薪資，也不能連線去讀）。改用
`tools/pnl-labor-estimate-august-compare.js`：拿同一份虛構的整月資料（含月中到職折算、
請假扣款、獎金、跨店支援、**payroll_input 手動覆蓋**——同仁丙的支援請款／全勤勾選／手動
工時＋時薪覆蓋、同仁乙的餐費補助勾選，確保兩條路徑都真的跑到「疊上手動覆蓋」那段邏輯），
分別跑「路徑 A：模擬鎖定當下的定案計算（`payInputsBase` 整月不截止、原始員工物件——
`handlePayrollCalc` 本來就是呼叫 `payInputsBase`，不是直接呼叫 `payCollect`）」與
「路徑 B：`pnlLaborEstimate`，`ym` 設成上個月、`today` 落在下個月」，逐鍵比對。

兩條路徑理論上必須完全相同（`as_of` ＝月底時，虛擬離職日與 `cutoffDate` 都不會排除任何
資料；兩邊都經過同一個 `payInputsBase`），腳本輸出：

```
✅ 整月情境下，pnlLaborEstimate 與定案路徑逐鍵完全相同，且 saved input（支援/餐費/全勤/手動工時）確實生效
```

（22 個科目鍵 ＋ `support` ＋ `total` 全部一致，涵蓋月中到職折算、加班、全勤、請假扣款、
獎金、公司負擔自動加總、跨店支援缺口分攤、手動覆蓋合併等情境；腳本另外明確斷言 `meal`／
`support.MZTJS` 兩邊都 > 0，確保不是「兩邊剛好都沒有手動覆蓋資料、比對失去意義」。）

**Eason 之後想再做一次真的對比**（用正式資料）：8 月鎖定後，本機執行
`clasp run 'handlePnlLaborEstimate_'`（或臨時在管理頁加一個按鈕呼叫）帶 `ym:'2026-08'`、
`today` 落在 9 月，跟 `payroll.html` 「當月薪資總覽」的人事成本分類卡逐項核對；預期完全一致，
因為兩者最終都是同一套 `payCalcOne`＋`costTotals()`/`pnlEstimateClassify_`（同一份規則正本）。

## 上線步驟

1. `PNL_KEY` 已經在 Script Properties 設定過（T14 沿用），**不需要再設一次**。
2. Review 這個 PR，確認 diff 只新增：`payCollect` 的第五參數、`payInputsBase` 的第三參數、
   `checkPnlKey_` 的第二參數（`endpoint`，選填、預設值保留舊行為）、檔案結尾新函式群
   （`handlePnlLaborEstimate_`／`pnlEstimateClassify_`／`pnlEstimateSheetsReady_`／
   `pnlPrevYm_`／`pnlAsOfDate_`／`pnlAllocGapHours_`）、`PAYROLL_HANDLERS` 多一行。
3. Merge 後在 Apps Script 編輯器 `clasp pull` 確認雲端沒有未知的手動修改，`rm -f Code.js`
   （clasp 3.x 撞名），再 `clasp push`，redeploy **既有部署 ID**（不要 `clasp deploy` 建新的）。
4. Redeploy 後有數秒到十幾秒的生效延遲（見 `dispatch-resources.md` 既有提醒），先跑一次
   `curl` 探針（帶 `key` 但故意用當月以外的 `ym` 觸發 `BAD_INPUT`）確認正式站已經認得這個
   `action`，再讓 mala-pnl-auto 開始串接。

## 回滾步驟

純新增：刪掉 `PAYROLL_HANDLERS` 那一行 `pnlLaborEstimate: handlePnlLaborEstimate_,`、刪掉
檔案結尾「T15」整個區塊、把 `payCollect` 的第五參數與 `payInputsBase` 的第三參數
`cutoffDate` 拿掉（或留著不傳也沒差，反正沒人呼叫）、`checkPnlKey_` 的 `endpoint` 參數留著
也沒差（有預設值，`handlePnlPayroll_` 的呼叫多帶一個 `'pnlPayroll'` 字面值不影響行為），
redeploy 既有部署 ID 即可。不涉及任何分頁結構變更，沒有資料要清理；快取用的是
`CacheService`（10 分鐘自動過期），不需要手動清。
