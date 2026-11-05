# 規格：跨店支援時數自動帶入（v1.0 草稿，2026-11-05）

需求見 requirements.md（九題定案）。生效月份常數 `PAY_XSUP_FROM = '2026-11'`：`ym < PAY_XSUP_FROM` 時本功能所有程式一律不動作（7B）。

## 1. 資料
### 1.1 門市表 payroll_store 追加欄 `support_group`（schema 只 append）
值：`sxl`／`mzt`／`*`。上線設定：SSLGF、SSLHQ＝sxl；MZT*＝mzt；CF、HQ＝`*`。
空白＝視為自己一組（只跟自己同組，等於沒有同組支援）——新門市忘了設不會亂帶。
同組判斷 `paySameGroup_(a,b)`：任一為 `*`，或兩者非空且相等。
> 不沿用 `brand` 欄：那是薪酬頁 logo 主題（CF、HQ 填 mzt、SSLGF 空白），語意不同。

### 1.2 新分頁 `payroll_xmap`（打卡對照快照，整表覆寫）
欄：`emp_no, pay_store, acct_store, emp_id, not_support, synced_at`
- 一列＝一位同仁在某家薪酬門市打卡表裡的一個 confirmed 帳號。`pay_store`＝該同仁的薪酬門市（dzy payStoreOfUnit_）；`acct_store`＝打卡帳號所在打卡店對應的薪酬門市代碼（clock_stores.payroll）。
- `not_support=true`＝個人例外（dzy STORE_NOT_SUPPORT_EX，例：總部薪資、央廚打卡且總部已 Mirror）。
- 不存姓名、手機等個資。

### 1.3 支援列 support JSON 追加欄位（舊列相容）
`{store, hours, rate, amount, code?, auto?, keep?, auto_h?}`
- `code`：薪酬門市代碼（新列一律寫；舊列只有中文名，靠 `PAY_SUPPORT_NAME_ALIAS` 對回代碼）。
- `auto:true`＝系統帶入列（hours／rate 由計算當下重算，不信任存檔值）。
- `keep:true`＝手填列，使用者選了「保留手填」；`auto_h`＝當時看到的打卡值（打卡值變了就再提醒一次）。

## 2. 對照同步（dzy → 薪資）
- dzy 平台新讀取 action `payrollXmap {}`（要 payroll.write；非 admin 依 scope 只回 pay_store 在負責門市的列）：回 1.2 的列（不含 synced_at）。Code.gs 白名單＋分派、dryrun READ_ACTIONS、minikit app.json readActions、Auth.gs PROXY 不涉及（這是平台 action）。
- 薪資後端新寫入 action `payroll_xmap_set {rows, synced_at}`：checkAdmin；scope 下只換 pay_store∈L 的列、保留其他（多店隔離慣例）；欄位白名單、emp_id 字串。`payroll_xmap_get` 讀取（除錯用）。
- 薪酬頁（嵌入模式）開頁時：`payroll_xmap_get` 的 synced_at 超過 6 小時 → 背景打 bridge `payroll_dzy_xmap`（bridge.js routeOf 改道到平台 payrollXmap）→ `payroll_xmap_set`。非嵌入（舊 ?k=）不同步，用現有快照。
- 快照為空（從沒同步）→ 自動帶入不動作，畫面提示「打卡對照尚未同步」。

## 3. 計算（Payroll.gs）
### 3.1 `paySupportAuto_(ym, home)` → `{ [emp_id_home]: { stores:[{code,name,hours,days:[{date,periods,hours,manager}],pending_days}], cross:[…], unmapped:[…] } }`
1. `ym < PAY_XSUP_FROM` → 回 null。
2. 讀 xmap；取 pay_store＝home 的列，依 emp_no 分組。本人在 home 的帳號＝acct_store＝home 的列（用它找 home 主檔 emp_id；沒有就跳過此人）。
3. 對此人每個 acct_store＝S≠home 的帳號：
   - `not_support` → 跳過。
   - S 沒有打卡表，或 S 與 home 的打卡表是同一份（clock_ss_id 相同，例 SSLHQ／MZTHQ／HQ 共用）→ 跳過。
   - 讀 S 的 approved（`payClockRead(S,'approved')` + buildLatestApprovedMap），加總 ym 內該 emp_id 的 approved_hours；逐日留 periods、manager_name。events 有、approved 沒有的日數記 pending_days。
   - 同組 → 放進 stores；跨組 → 放進 cross（只供 S 那邊提醒用，不帶入 home）。
4. 只讀「有人有帳號」的店（xmap 決定），每店一次（payClockRead 請求內快取）。
### 3.2 合併進 att.support（payInputsBase 之後、handlePayrollCalc 之前，單一函式 `payMergeSupport_(att, auto, master)`）
對每個自動店 S：
- 支援列沒有 code＝S 的手填列 → 加 `{code:S, store:S名稱, hours:auto.hours, rate, amount:'', auto:true}`，rate＝正職 ot_rate、計時 wage（4B）。
- 有手填列（非 auto）且 hours 相同 → 不動。
- 有手填列且不同 → 不動，記 `diff:{code, manual, auto}`；`keep:true` 且 `auto_h===auto.hours` 時不記。
- 有 auto 列 → 以本次重算值取代。
- 自動店本月 0 小時 → 移除該 auto 列。
- 前端送來的 inputs（CALC_INPUTS）裡的 auto 列一律丟掉再重算（防舊頁面凍結）。
回傳 `support_auto:{diffs, pending_days, unmapped}` 放進 payroll_month／payroll_calc 回應。
### 3.3 存檔
`payroll_input_set` 寫入前剔除 `auto:true` 列（自動列不落地，永遠跟著打卡）。使用者在差異點「改成打卡值」＝刪掉該手填列（下次計算就變 auto 列）；「保留手填」＝該列加 keep＋auto_h。
### 3.4 防呆檢查（回在 `support_auto.warn`）
- `dup_pay`：同組支援的人在 S 的主檔也有同一個 emp_id → 會被付兩次（S 自己算一次＋home 支援一次）。
- `cross_no_master`（在 S 端看）：xmap 有跨組帳號在 S、S 本月 approved 有時數、S 主檔沒有此 emp_id → 「在本店有打卡、但沒有主檔」。需要 S 端反查：`paySupportAuto_` 另提供 `payCrossIncoming_(ym, S)`。

## 4. 前端（payroll.html）
- 出勤資料 → 跨店支援：auto 列標「打卡帶入」、時數唯讀、可展開逐日（6A）；手填列照舊可編輯。門市下拉改讀 STORE_LIST（代碼＋名稱），舊中文名列照舊顯示。
- 頁頂提醒：差異（3A，兩顆鈕）、未核定天數、對照未確認、dup_pay、cross_no_master。
- `costRows` 請款區、`qtyUnit` 不用改（auto 列與手填列同形）。新增 action 要補 dzy Auth.gs PROXY_READ/WRITE_ACTIONS.payroll＋dryrun.js（payroll_xmap_get 讀、payroll_xmap_set 寫）。
- scope：payroll_xmap_set 在 payScopeGuard_ 下只准 pay_store∈L 的列。

## 5. 同仁查薪（查證項，不改行為）
my_payslip 依打卡金鑰逐店找 roster，找到即停 → 每個打卡連結看該店那張。LINE 薪資明細（LineHub，只光復）→ 只看光復。開發時實測並回報 Eason；要不要合併顯示另案。

## 6. 測試
- `tests/support-auto.test.js`：同組／跨組／`*`／空白組；共用打卡表去重；not_support；手填相同／不同／keep；auto 列不落地；舊頁面送 auto 列被丟棄；0 小時移除；ym<2026-11 回 null；scope 隔離。
- 迴歸：`ym < 2026-11` 全部 handler 輸出與改動前逐欄相同（沿用 comp-regression 做法，基準＝改動前 commit）。
- 真資料唯讀回放：2026-11 草稿（上線時）帶入值＝各店 approved 加總（獨立腳本算）。
- dzy：payrollXmap 單元測試（scope 裁切、not_support、rejected 不出）。

## 7. 設計審查修正（Fable 2026-11-05，12 條全收；GPT 額度 17:31 恢復後補審）
以下覆蓋前文：
1. **手填列認不出門市**（高）：同仁有任一手填列 code 解析不到（含 store 空白、別名對不到）→ 該人本月整個不自動帶入，回 `warn.manual_unresolved`。alias 表上線前用正式 payroll_input 全部 distinct store 值做單元測試。
2. **跨品牌手填列**（高）：手填列的 code 與 home 不同組（2026-11 起）→ `warn.cross_manual`，前端標紅並擋「儲存工時」與「重新計算」（否則原店手填＋打卡店主檔各付一次）。
3. **總部同仁找不到本人帳號**（高）：「本人在 home 的帳號」與「共用打卡表去重」一律用 clock_ss_id 判斷（acct_store 的打卡表＝home 的打卡表），不比代碼（SSLHQ／MZTHQ 的帳號 acct_store 是 HQ）。
4. **差異決定不可借道整份儲存工時**（高）：新 action `payroll_support_decide {store, ym, emp_id, code, choice:'auto'|'keep', auto_h}`，只改該員 payroll_input 列的 support 欄，不建新列；找不到該員工時數列回 `ok:false, error:'no_row'`（前端提示「沒有手填資料，不用決定」並重新載入）。payroll_input 新增 `hours_manual` 欄（schema append）：`'0'`＝「僅 support」列（本店時數沿用打卡歸集），空白（舊列）／`'1'`＝整筆手動，行為不變、不必遷移。「僅 support」列由「儲存工時」建立：2026-11 起，本店歸集沒有此人、其他欄全 0／未填、只剩手填支援 → 寫 `'0'`；連手填支援都沒有 → 不寫列（審查 2026-11-05 #1）。decide 把「僅 support」列刪到沒有支援就整列移除。
5. **共用打卡表重複計算**（高）：以 clock_ss_id 去重，每份打卡表每個 emp_id 只算一次（xmap 同步時也合併）。
6. **run 快照過期**（中）：payroll_month 在草稿、ym≥2026-11 時比對 run 內支援時數與本次自動加總，不同就自動重算一次並回 `support_auto.recalc:true`；已鎖定月份只回 `stale:true` 提示，不重算。
7. **scope 守門**（中）：payScopeGuard_ 加 xmap 分支——set 逐列檢查 pay_store∈L；get 回應裁掉 pay_store∉L 的列。
8. **空白代碼被當光復**（中）：xmap_set 的 pay_store／acct_store 必須是 payroll_store 現有代碼，否則丟棄並回報丟棄筆數；讀取時不經 payStore() 預設。
9. **對照未確認的提醒**（中）：payrollXmap 多回 `state`（只收 confirmed、suggested）；帶入只用 confirmed，suggested 列進 unmapped 提醒。
10. **效能**（中）：pending_days 只讀 S 的 approved＋該月 events（依日期欄篩）；payroll_inputs 與排程估算端點不產逐日明細；上線前實測 payroll_month 耗時（目標：比現在多 ≤ 5 秒）。
11. **調店雙發**（中）：dup_pay 命中時該店不自動帶入，列待處理（不只警告）。
12. **欄位與名稱**（低）：逐日明細用 `manager_name`；auto 列同時寫 store（中文名，給請款區顯示）與 code；4B 計時費率＝主檔 `wage`（不含本月 wage_override 與加給），寫進測試釘住。

## 8. 上線前審查修正（Fable 2026-11-05，probe.js 七條，覆蓋前文）
1. 只在別店有時數的人：見 §7-4（儲存工時不寫 hours:0 整筆手動列；前端 attSendable 不送）。
2. support_error 的人一律不帶入，回 `warn.support_error`。
3. 對照已同步（xmap 非空）時，跨品牌手填列不計入支援時數；畫面上保留並標 `cross:true`（存檔時去掉標記），前端標紅擋存檔與重算。support_group 空白不判。
4. run 追加 `support_auto_h`（＝別家門市核定可帶入時數合計，不論是否被手填蓋過）；payroll_month 只拿它和本次值比，判斷草稿過期。
5. 打卡編號比對一律過 `payXsupId_`（字串化、去前導零）。
6. decide 找不到列回 `no_row` 錯誤（§7-4）。
7. scope 使用者：xmap_set 換掉 pay_store∈L 或 acct_store∈L 的列（其餘保留）；守門只擋兩者都不在 L 的列；xmap_get 回 pay_store∈L 或 acct_store∈L 的列。

## 9. 上線前審查修正（GPT 2026-11-05，12 條；覆蓋前文）
1. 差異「改成打卡值」後：有草稿就在 decide 裡直接重算（support_auto_h 前後一樣，payroll_month 判不出過期）。
2. 2026-11 起已存的整筆手動列在 inputs 標 `_manual`，前端 attSendable 照送（人工填 0 不會被當沒動過刪掉）。
3／5. xmap_set 有 scope 時：pay_store∈L 的列整批換；pay_store∉L、acct_store∈L 存成 `acct_only`，只給打卡店的「有打卡沒主檔」提醒用，計薪忽略。前端不再自己篩。state 必填。
4. 離職：管理系統 payXmapBuild_ 保留離職同仁到離職月份的下個月底（上個月薪資次月初才算）；薪資這邊照快照整批換。（曾做 removed_at 標記，Fable 複審抓到同步順序不同會付錯人／付不到，已撤掉。）已知限制：月中調店，那個月的跨店支援時數全部歸新店、原店主檔仍在職時會列「可能付兩次」待人工處理。
6. 同一打卡帳號確認給兩位 DZY 同仁：兩位都不帶入，列 `warn.dup_acct`。
7. 過期判斷比「草稿裡的人 ∪ 這次要帶入的人」。
9. decide 拿到寫鎖後再查一次鎖定。（input_set 對已鎖定月份照舊可寫：改版前既有行為，另案）
10. synced_at 比現有正式列舊 → `stale_snapshot`，不寫。
11. 在職判斷與正式計薪同口徑（active 恰好是 true）。
12. 生效月之前存工時 hours_manual 寫空白。
未修：8（payroll_input_set 整月覆寫無版本，兩個分頁同時存後者蓋前者）——改版前既有行為，另案。

## 10. Fable 複審（2026-11-05，對 §9 的修正）
- 撤掉 removed_at 標記法（第 1–3、5 條都出在它）；改由管理系統保留離職同仁一個月。
- acct_only 列不算本店已同步：empty 與 xmap_get 的 synced_at 都不看它（第 4 條）。
