# 薪資引擎測試

```bash
node tests/run-all.js
```

| 檔案 | 測什麼 | 為什麼需要 |
|---|---|---|
| `leave-e2e.test.js` | 值班核定 → leave 分頁 → `payCollect` → `payCalcOne` 整條鏈 | **`payCollect` 落在 `payroll_mock.js` 的切片之外，改版前這條鏈零測試覆蓋**（2026-08-23 補） |
| `leave-sweep.test.js` | 22 種假別逐一走完整條鏈、驗扣款金額 | 假別名是中文（含全形括號），比對錯了會靜靜當成全薪 |
| `leave-cap.test.js` | 跨月額度累計（病假 30 日、家庭照顧假併入事假） | 額度要掃整個曆年，只測單月測不到 |
| `attend-bonus.test.js` | 全勤兩段式（遞減＋門檻歸零），含各店不同設定 | 光復必須與改版前完全一致 |
| `annual-payout.test.js` | 特休週年期屆滿當月折算工資 | 一年只會發生一次，出錯很難發現 |
| `engine-diff.js` | 拿改動前後兩版引擎跑 2160 組情境逐項對拆 | 改公式時確認既有數字沒動 |
| `engine-diff-coverage.test.js` | 對拆工具本身：用 #97 之前的版本當舊版，新月份那一區要抓得到 2026-10 月中到職的差異、舊四個月仍 0 差異、`--strict`、缺函式不掛掉 | 2026-11-11 以前對拆只比 2026-06／07／08／02，10 月以後的規則改了也顯示 0 個不同 |
| `comp-leave.test.js` | 補休：到期日定義、換補休上限、計時忽略、先換先用、到期／離職折算、只認定案月份、假別表內建列；20／25 號補休為負提醒已停用（`payCompCheckDaily` 不做事、`payroll_comp_trigger_setup` 只刪不建，2026-11-22） | 2026-10-09 動到薪資，期望值全部手算 |
| `comp-regression.test.js` | 同一份假資料餵補休上線前（git 3668329）與現在的 `handlePayrollCalc`，沒有補休的人 results／run／item 逐列相同 | 補休不可以動到任何沒有補休的人；含一位有補休的對照組證明比對有效 |
| `line-hub-comp.test.js` | LINE：申請頁 comp 資訊、假別額度卡補休列、到期提醒、薪資卡數量帶 H | |
| `sheets-fidelity.test.js` | 用 `helpers/sheets-like.js`（仿 Google 試算表自動轉型的假 Sheet）把真函式的寫→讀跑一遍：events／approved／leave／requests／roster／notices／sched_pub／punch_timing／qr_punch／Payroll 讀的範圍／月表備註往返；`KNOWN` 是已確認的問題（只印不擋） | **mock 與既有沙盒把儲存格當純字串，真的試算表會把 '2026-07-14' 轉成 Date、'11:00' 轉成 1899-12-30 的時間、'false' 轉成布林**；2026-07-15（approved.date）、2026-08-23（roster.shift_in、'false' 布林陷阱）三個歷史 bug 都在這裡用當年的舊寫法重現 |
| `duty-push.test.js` | 門鈴（PR #181）：門鈴關時跟 PR #181 合併前的 main（`50a80bc^1`，可用 `DUTY_PUSH_BASE` 換）逐次相同、只多讀 `DUTY_PUSH_URL`；只計數、熔斷、上限、簽章、push_setup／push_cfg、授權範圍 | 打卡回應路徑上多一次連外，關的時候必須跟沒有一樣 |
| `duty-push-live.test.js` | 開真推送前補強（2026-11-20）：關／只計數跟九店線上版 a9fac60（`50a80bc`）逐字逐次相同（只差 push_stats.cap）；回應慢也熔斷、等 ping 復原、半開、最壞情況（mini 持續卡 3 秒 2 小時同仁只有第一筆多等）、停推不縮短、flush 失敗不按；flush 只在正式推送；每日上限 800 | 慢熔斷與 flush 只在正式推送生效，關的店不能有任何差別 |
| `helpers/duty-push-harness.js` | 門鈴測試的假 Apps Script 環境（不是測試） | |
| `../e2e/req_submit_mini.py`（瀏覽器，不在 run-all；搭配 `req-line-mini.test.js`） | LINE 申請送出／取消先送 Mac mini（`SUBMIT_MINI`，預設 false，用 `?submit_mini=1` 打開）：假 mini 照營運系統真形狀回（外層 `{ok,data}`）；收下／mini_off／影子／mini_busy／資料還在更新／逾時／500／非 JSON／連不上，逐一數 mini 與 Google 各被打幾次（收下＝Google 0 次）；開關關時送出、取消不碰 mini。`E2E_MOCK_PORT=8967 /usr/bin/python3 e2e/req_submit_mini.py` | 以前假 mini 少包外層、單元測試沒抓到「mini 收下了手機還再送 Google 一次」；這條要真瀏覽器＋真 `req-line.js` 才看得到次數 |
| `election-day-emp.test.js` | 選舉假逐人名單（payroll_hol_emp，2026-11-22）：沒有名單跟 #178 分支頭逐欄相同；勾選後只有班表上班日 W 的人加「選舉日出勤」，H／R／L／查不到不變、沒有人變少；與國定假日並存、同一天只算一次；補休照國定假日（已抵的會變負、擋鎖定，存名單時提醒人數）；名單存檔的鎖定、權限、門市範圍；損益月中估算同一套；支援別店班別仍是 W | Eason 定案「不可讓任何人因被勾選而少領」，用全部勾選 vs 沒有名單逐人比對守住 |
| `election-day-emp-random.test.js` | 選舉假「勾選 vs 不勾選」隨機對照（2026-11-22 Codex 第三次後補）：每輪 8 位假同仁（正職／計時、當月停用離職、班表 W/H/R/L/查不到、國定假日、加班單、補休、同品牌別店支援含當天只在別店、手填國定假日／手調總時數／只手填支援），同一份資料名單空白 vs 隨機勾選各算一次，逐人比實付與應發；預設 2500 輪＝2 萬人次（`ELEC_RAND_N`、`ELEC_RAND_SEED` 可改） | Eason 定案「不可讓任何人因被勾選而少領」；手填衝突時本店、支援都不自動發（不勾選本來就沒有選舉日加發，仍是勾選 ≥ 不勾選）也一起守 |
| `payroll-status.test.js` | 月結狀態唯讀查詢 `payroll_status`（2026-11-22 待辦 10；後續 PR 加第 5 段：分頁不存在不建分頁、預查丟例外回 `status_read_failed`）：final／draft／none／mixed、名單改過的草稿回 elec_stale；不寫表、不取鎖、不寫快取（對照組 payroll_month 同情境會寫）；九種身分權限逐一＝payroll_month；整條 handlePayrollCalc 與 4f929d3 逐欄相同 | 鎖定逾時後要確認有沒有鎖成功，不能用會自動重算寫回的 payroll_month |
| `ui/elec-codex6-e2e.py`（瀏覽器，不在 run-all） | 選舉假 Codex 第六次 SHOULD-FIX：A 晚到的舊月資料不蓋重算結果、要重讀；B 鎖後重讀失敗擋匯出／鎖定；C 存名單途中丟例外也解除待確認；D 直連逾時；E 趨勢預抓版本；F 鎖定逾時改問 payroll_status。`python3 tests/ui/elec-codex6-e2e.py [A,B,…]`，`E2E_WATCHDOG` 秒數卡住自動收掉 | 都是回應先後順序的問題，只有實際瀏覽器加攔請求才重現得到 |
| `payroll-mon-unsure-gate.test.js` | 「這個月讀取失敗」只有一個判斷來源（#212 後續，2026-11-22）：只在 `monUnsure()` 讀旗標；薪資數字的出口（`exportCSV`／`exportExcel`／`exportPDF`／`printSlip`）第一行都是 `monUnsureStop()`、沒有 onclick 直接列印；鎖定用 `monBlocked()`；被擋只有主管同意的那一句 |
| `ui/elec-status-followup-e2e.py`（瀏覽器，不在 run-all） | #212 後續：G 讀取失敗後薪資單列印要擋；H 鎖定結果不明、狀態查詢失敗（逾時／`status_read_failed`／系統忙碌／嵌入逾時）設旗標、只有舊後端或代轉未放行才退回 `payroll_month`；I 讀取失敗後仍可重新計算、重算成功後重新載入成功才解開 |
| `elec-date-confirm.test.js` | 選舉假名單投票日清單（2026-11-22 選項 7B）：清單內直接存；清單外沒帶 `confirm_off_list` 布林 true 一律擋（"true"、1、"yes"、缺少…）、回 `elec_date_unconfirmed`；帶旗標存成功、操作紀錄多記「（不在投票日清單）」；既有檢查先擋；`payroll_month` 帶 `elec_vote_days`。`PAYROLL_GS=<舊版>` 可拿舊版跑（應紅） |
| `ui/elec-date-confirm-e2e.py`（瀏覽器，不在 run-all） | 選舉假名單投票日確認框（7B）：說明行、清單外跳確認框（逐字）、取消／Esc 不送出、確定才帶旗標、成功提示逐字；日期欄初始值（沒存過＝該月最早投票日、存過＝存過的日期、12 月空白；帶入不存不重算）；新畫面＋舊後端照舊直接存、舊畫面＋新後端顯示後端說明不存 |
| `xstore-claim-1122.test.js` | 跨店請款 N4（2026-11-22 Eason 定案 D1–D7）：手算 H1–H14 對到分、Eason 四個吸收例子、D3 兩種比例（`PAY_XCLAIM_SHARE`）、有沒有跨店資料同一人應發扣款逐欄相同（隨機 3000 組）、選舉日三處不重複、月份閘（xr 戳記／已鎖有快照／已鎖沒快照）、前端 costTotals vs 後端 pnlEstimateClassify_、D5 加班單檢查 vs Requests.gs 打卡端現行要求（隨機 3000 組逐案一致）、損益端點 xsup_cost | 請款只動成本歸屬，不可以讓任何人實領改變；加班單檢查要跟打卡端同一套，不然月底鎖月被擋 |
| `xstore-claim-invariant.test.js` | 跨店請款兩個不變量（2026-11-22 r2）：選舉假上線版 `1ab5655`（`XINV_BASE` 可換）vs 本版隨機 2 萬組（`XINV_N`）——同仁應發、扣款、實領、每個薪資項目逐欄相同（只允許 ot_info.xr／xclaim／cross_ot／ot_form_missing 不同）；逐日、逐店請款的加成倍數時數不超過同仁實際多拿的加成，計時國定假日／選舉日支援的 hx 不超過薪資單實發的「（支援○○）」加倍時數 | 請款只能動成本歸屬；選舉日手填衝突停發的支援時數不可以拿去請款（r2 前直接讀 att.sup_elec 會多請） |
| `xstore-lock-flow.test.js` | 跨店請款 r7 鎖月流程隨機對照：正式版 `1ab5655` vs 本版，算草稿 → 停用／改離職日／清除手動工時／改指定金額／別家核定改了／不動 → 重算或不重算 → 鎖。正式版鎖得下去本版也要（只允許「草稿存的請款跟重算不同」的設計擋，重算後要鎖得下去）、定案薪資列與明細逐列相同、快照請款＝定案草稿列 `ot_info.xsup`。`XFLOW_N`（預設 2,000，驗收跑 10,000） | 「草稿有、重算沒有的人」連續兩輪出事；請款跟薪資草稿必須是同一份資料 |
| `pay-replaceall-safe.test.js` | 薪資分頁整張覆寫 `payReplaceAll` 寫入防壞（2026-11-22）：假試算表外包一層會故意失敗的殼，15 張表 × 5 種列數 × 三種失敗點（清空後立刻失敗、寫到一半、送出 flush 才失敗）內容只能是寫入前或完整新內容且呼叫端收到錯誤；還原也失敗要講清楚；薪資計算 run＋item 兩張一起寫（後面失敗前面退回）；讀不到分頁不當空表（假別表、留停、事件日、打卡對照）；超過格線先加列；同時讀只會讀到舊或新；正常路徑跟改版前（`PAYRA_BASE`，預設 4f929d3）逐格相同（直接覆寫 540 次＋14 次真的存檔）；各店月加班表 ot_month（`payOtMonthSync_`）同樣三種失敗點、同時讀、超過格線、正常路徑 60 次同步 | 以前「先清空再寫」中途失敗會留下空表或半張表；`PAYRA_SRC=<舊版>` 可看到改版前在哪幾組失敗 |
| `helpers/sheets-like.js` | 假試算表本體（不是測試，run-all 不會跑它）：寫入字串照 Sheets 規則轉型、`setNumberFormat('@')` 鎖文字、在 vm 的 Date realm 建 Date、格線範圍外丟例外；每條規則標 [已查證] 或 [推定]＋出處，見檔頭 | 要模擬正式試算表時用這個，不要再寫「把字串原樣存起來」的假 sheet |

## 改引擎之前先跑 engine-diff

```bash
git show HEAD:apps-script/Payroll.gs > /tmp/before.gs
node tests/engine-diff.js /tmp/before.gs apps-script/Payroll.gs
```

（根目錄的 `node diff_engines.js …` 是同一支。）舊四個月（2026-06／07／08／02）2160 組必須完全相同，否則結束碼 1；
另外會比 2026-09／10／11、2027-02（2026-11 帶逐日資料），這一區只列出不同的組合、不影響結束碼，加 `--strict` 才會回 1。

## ⚠ 寫這類測試的三個坑（都踩過）

1. **`payCalcOne` 回的是 `earn`／`ded`，沒有 `items`**——寫錯欄位名會讓「逐項比對」變成空陣列比空陣列，
   測試全綠但其實什麼都沒比到。寫完測試先故意改壞一行，確認它會紅。
2. **vm 裡要用 vm context 的 `Date`**（`vm.runInContext('Date',sandbox)`）——
   模擬「Sheets 把日期轉成 Date 物件」時，跨 realm 的 `instanceof Date` 會判 false，測出來跟正式環境不一樣。
3. **leave 分頁的欄位名是中文**（日期／姓名／假別／時數），不是英文 key。

## 改後端之後：驗證三家店一致

```bash
cd ~/mala-gas/mala-clock-in && clasp pull
cd ~/mala-gas/cf-clock-in && clasp pull
cd ~/mala-gas/hq-clock-in && clasp pull
python3 tools/verify-store-backends.py
```

央廚／總部各有一份自己的 `程式碼.js`（含各自的試算表 ID／座標／金鑰，還有 repo 沒有的
`setup_sheets`／`add_manager`），所以改後端要逐份套補丁。這支把「逐一 grep 確認」變成可重跑的檢查。

**2026-08-23 的教訓**：補丁腳本判斷「是否已套用」時用了子字串 `'isTrip' in src`，
而前一步剛加的 `isTripDay` 就含這個子字串 → 三份全被誤判成已套用而跳過 →
呼叫端傳了第四個參數但函式簽名沒收 → 出差照樣扣全勤。**`node --check` 完全過**
（JS 多傳參數合法）。所以 `EXACT` 那一組查的是**完整片段**不是函式名。

## 瀏覽器實操：選舉假名單卡片＋薪資計算頁（`tests/ui/elec-ui-e2e.py`）

```bash
python3 tests/ui/elec-ui-e2e.py [截圖資料夾]
```

- 不在 `run-all.js` 裡（要 Python 的 `playwright`＋chromium、webkit 瀏覽器）；改 `payroll.html` 的選舉假卡片、`loadMonth`、匯出、`doCalc` 時手動跑。
- 自己在隨機埠起 `mock/mock_server.py`（只綁本機），用 `tests/election-day-emp.test.js` 的 `world()` 算出虛構同仁「測試甲～己」的 11 月草稿當假資料；
  跑完用自己的程序代號收掉假後端、刪掉 `mock/mock_data.json`。不碰任何正式試算表。
- Chromium、WebKit 各跑一次（共 36 條）：勾選／全選／清除／儲存、後端回補休提醒、舊後端、存檔後重算失敗、
  **重算失敗後重新整理（後端回 `elec_stale`）→ 仍顯示要重算、匯出 Excel／CSV 都擋**、**已停用但 11/29 離職的同仁勾得到（10 月離職的不出現）**、
  **開頁預抓的 11 月資料在切到 10 月之後才回來 → 不套用**、舊月份停用、已鎖定停用、沒有 JS 錯誤。
