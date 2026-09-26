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
- **PT／加班／餐費／全勤**＝`as_of` 之前已核定工時 × 費率——直接用 `payCollect` 新增的
  `cutoffDate` 參數，只歸集「日期 <= as_of」的核定／打卡／請假資料，其餘完全是
  `payCalcOne` 原生算法（正職加班＝核定總時數超過折算後基本工時的部分；全勤獎金/餐費補助
  的判定門檻不變）。
- **勞健保公司負擔／退休金**：按同一個在職比例折算（正職）；健保／團保整月不折算——與
  `payCalcOne` 既有的「勞保、宿舍 × P；健保、團保、退休金算整月」規則一致，估算沒有另立
  標準。
- **年終獎金提列**＝月提列額 ×（估算比例）——與 `costTotals()` 的月提列公式相同，只是
  用估算出來的 `pr`（在職比例）而非整月的 1。
- **跨店支援請款**＝`as_of` 之前已記錄的支援時數 × 費率（缺口時數的平均分擔演算法逐字
  port 自 `payroll.html` 的 `allocGapHours()`）。
- **紅字天數**：若當月的 `payroll_holiday` 還沒設定，估算直接當 0（不像 `handlePayrollCalc`
  那樣在缺紅字天數時嘗試 `payHolidaySync` 自動同步——那條路徑會寫入 `payroll_holiday`
  分頁，違反本端點的唯讀承諾，所以估算端點寧可少一點精準度也不寫入）。這只影響加班／不足
  時數的門檻計算，不影響底薪本身。

## 已知限制

- **不合併 `payroll_input`（手動覆蓋工時）**：規格要求「以打卡實際工時為準」，所以只用
  `payCollect` 的打卡歸集，不像 `handlePayrollCalc`／`payInputsBase` 那樣疊上管理者手動
  覆蓋的工時。如果某個月大量使用手動覆蓋（例如打卡上線前的月份，或某些特殊情況手動改過
  工時），估算會跟最終定案數字有落差——但這兩個月份（當月／上月）通常打卡都在正常運作，
  這個落差預期很小或不存在。
- **獎金** 沒有逐日時間戳，只能用 `updated_at` 欄位的日期粗略過濾「`as_of` 之後才登記的
  獎金不計入」；`updated_at` 不可靠或缺漏時會保守地照樣計入。
- **紅字天數未依比例調整**：`redDays` 用當月完整設定值（不是「已過天數對應的紅字天數」），
  只影響加班／不足時數的門檻，不影響底薪金額本身，見上方說明。

## 唯讀證明

新增的 T15 函式區塊（`payCollect` 之外的部分）整段 grep：

```
$ awk '/^\/\/ ---------- 損益系統唯讀端點（T15/{f=1} f' apps-script/Payroll.gs \
  | grep -nE "setValue|setValues|appendRow|insertSheet|deleteRow|\.clear\(|DriveApp\.create|PropertiesService[^)]*\.set|LockService"
（只有註解命中「不呼叫 setValue/…」那幾行，沒有任何實際呼叫）
```

`payCollect` 本身只新增一個可選的第五參數 `cutoffDate`（純過濾，讀取邏輯不變），既有唯一
呼叫路徑 `payInputsBase()` 不傳這個參數，行為與加這個參數之前完全相同。

## 效能

單次呼叫只讀一家店當月的 `master`（通常個位數到十幾人）、`approved`/`events`/`leave`
（該店當月全部列）、`bonus`（該店當月），逐人跑一次 `payCalcOne`（純記憶體計算，無 I/O）。
與既有 `handlePayrollCalc`（管理頁「重新計算」按鈕，同一數量級的資料與計算量）同一數量級，
`handlePayrollCalc` 實測在數十人規模的門市內是秒級完成，`pnlLaborEstimate` 少了
`payReplaceAll` 兩次整表覆寫（唯讀），預期比 `handlePayrollCalc` 更快、遠低於 30 秒門檻。

## 本機測試

```
$ node tests/pnl-labor-estimate.test.js      # 32 項斷言：估算邏輯、cutoff、錯誤碼、鎖定門檻、唯讀
$ node tests/run-all.js                      # 既有 30 支＋本支＝31 支測試檔全部通過，證明沒有動到既有計薪邏輯
$ node tools/pnl-labor-estimate-august-compare.js   # 見下方「與定案路徑的比對」
```

### 與「定案路徑」的比對（複製 8 月鎖定情境）

⚠ 這次改動的鐵律是「不准打正式端點、不准碰任何試算表」，所以**無法**用真正的
2026-08 正式鎖定快照做比對（那份資料含真實姓名薪資，也不能連線去讀）。改用
`tools/pnl-labor-estimate-august-compare.js`：拿同一份虛構的整月資料（含月中到職折算、
請假扣款、獎金、跨店支援），分別跑「路徑 A：模擬鎖定當下的定案計算（整月不截止、原始
員工物件）」與「路徑 B：`pnlLaborEstimate`，`ym` 設成上個月、`today` 落在下個月」，逐鍵比對。

兩條路徑理論上必須完全相同（`as_of` ＝月底時，虛擬離職日與 `cutoffDate` 都不會排除任何
資料），腳本輸出：

```
✅ 整月情境下，pnlLaborEstimate 與定案路徑逐鍵完全相同
```

（22 個科目鍵 ＋ `support` ＋ `total` 全部一致，涵蓋月中到職折算、加班、全勤、請假扣款、
獎金、公司負擔自動加總、跨店支援缺口分攤等情境。）

**Eason 之後想再做一次真的對比**（用正式資料）：8 月鎖定後，本機執行
`clasp run 'handlePnlLaborEstimate_'`（或臨時在管理頁加一個按鈕呼叫）帶 `ym:'2026-08'`、
`today` 落在 9 月，跟 `payroll.html` 「當月薪資總覽」的人事成本分類卡逐項核對；預期完全一致，
因為兩者最終都是同一套 `payCalcOne`＋`costTotals()`/`pnlEstimateClassify_`（同一份規則正本）。

## 上線步驟

1. `PNL_KEY` 已經在 Script Properties 設定過（T14 沿用），**不需要再設一次**。
2. Review 這個 PR，確認 diff 只新增（`payCollect` 的第五參數＋檔案結尾新函式＋
   `PAYROLL_HANDLERS` 多一行）。
3. Merge 後在 Apps Script 編輯器 `clasp pull` 確認雲端沒有未知的手動修改，`rm -f Code.js`
   （clasp 3.x 撞名），再 `clasp push`，redeploy **既有部署 ID**（不要 `clasp deploy` 建新的）。
4. Redeploy 後有數秒到十幾秒的生效延遲（見 `dispatch-resources.md` 既有提醒），先跑一次
   `curl` 探針（帶 `key` 但故意用當月以外的 `ym` 觸發 `BAD_INPUT`）確認正式站已經認得這個
   `action`，再讓 mala-pnl-auto 開始串接。

## 回滾步驟

純新增：刪掉 `PAYROLL_HANDLERS` 那一行 `pnlLaborEstimate: handlePnlLaborEstimate_,`、刪掉
檔案結尾「T15」整個區塊、把 `payCollect` 的第五參數 `cutoffDate` 拿掉（或留著不傳也沒差，
反正沒人呼叫），redeploy 既有部署 ID 即可。不涉及任何分頁結構變更，沒有資料要清理。
