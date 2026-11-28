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
| `pay-html-followups.test.js` | 薪資頁後續小修（2026-11-23）不開瀏覽器的部分：①出勤表單是哪個店月的（`ATT_KEY`／`attForeign`，讀取失敗不換、`attGuardUi` 收起表單、`saveAtt`／`supDecide` 第一行擋）②「儲存工時 ●」（已是未存再編輯也補圓點、停用中不動字、`attBtnIdle`）③待辦 17（5A）`lockBlockedBox`：加句只給三種、只有「知道了」能關 ⑤讀取失敗後重新載入成功先問 `payroll_status`：mixed／查不到照擋，草稿／已鎖／沒資料／舊後端才解開 ⑥獎金、主檔、參數（`saveCfg`／`setMode`）、假別設定、事件日、門市表：資料是別店（月）的或沒讀到就不送（後端都是整份取代），月資料還在讀時提示「讀取中…」 | 讀取失敗時畫面留著上一個月的出勤表單，按儲存會存進目前選的月份 |
| `ui/pay-html-followups-e2e.py`（瀏覽器，不在 run-all） | 同上五件實際按按鈕：A 切月份讀取失敗 → 表單收起來、儲存／差異決定不送、重算送 {}、開頁就失敗也不能存；B 存檔失敗圓點回來；C 鎖定被擋視窗（Esc、按外圍不關）；D 存檔成功正本＝草稿、重算失敗、重新載入失敗；E mixed 重新載入照擋；F 獎金（切月份失敗／開頁就失敗）收起來不送、切門市讀取失敗時主檔／參數／假別設定／事件日／獎金／工時都不送。`E2E_ROOT=<舊版解壓目錄>` 可看改版前哪幾條紅 | 都是畫面狀態與先後順序，只有實際瀏覽器才看得到 |
| `elec-date-confirm.test.js` | 選舉假名單投票日清單（2026-11-22 選項 7B）：清單內直接存；清單外沒帶 `confirm_off_list` 布林 true 一律擋（"true"、1、"yes"、缺少…）、回 `elec_date_unconfirmed`；帶旗標存成功、操作紀錄多記「（不在投票日清單）」；既有檢查先擋；`payroll_month` 帶 `elec_vote_days`。`PAYROLL_GS=<舊版>` 可拿舊版跑（應紅） |
| `ui/elec-date-confirm-e2e.py`（瀏覽器，不在 run-all） | 選舉假名單投票日確認框（7B）：說明行、清單外跳確認框（逐字）、取消／Esc 不送出、確定才帶旗標、成功提示逐字；日期欄初始值（沒存過＝該月最早投票日、存過＝存過的日期、12 月空白；帶入不存不重算）；新畫面＋舊後端照舊直接存、舊畫面＋新後端顯示後端說明不存 |
| `ui/cap-grace-hint-e2e.py`（瀏覽器，不在 run-all） | 班表寬限打卡頁提示（2026-11-23 主管選短版）：開頁回應有 `cap.grace_hm` 且沒鎖 → 訊息列逐字顯示定稿、時間正確、鍵不鎖、寬 390／320 不破版不蓋鍵；沒有 `grace_hm`、`locked:true`、格式怪 → 不出現、畫面與原樣相同；Chromium、WebKit；假後端隨機埠、跑完確認程序結束。`python3 tests/ui/cap-grace-hint-e2e.py [截圖資料夾]` | 這個頁面一合併就發布，後端新版另一晚才換：沒有欄位時畫面必須完全不變 |
| `xstore-claim-1122.test.js` | 跨店請款 N4（2026-11-22 Eason 定案 D1–D7）：手算 H1–H14 對到分、Eason 四個吸收例子、D3 兩種比例（`PAY_XCLAIM_SHARE`）、有沒有跨店資料同一人應發扣款逐欄相同（隨機 3000 組）、選舉日三處不重複、月份閘（xr 戳記／已鎖有快照／已鎖沒快照）、前端 costTotals vs 後端 pnlEstimateClassify_、D5 加班單檢查 vs Requests.gs 打卡端現行要求（隨機 3000 組逐案一致）、損益端點 xsup_cost | 請款只動成本歸屬，不可以讓任何人實領改變；加班單檢查要跟打卡端同一套，不然月底鎖月被擋 |
| `xstore-claim-invariant.test.js` | 跨店請款兩個不變量（2026-11-22 r2）：選舉假上線版 `1ab5655`（`XINV_BASE` 可換）vs 本版隨機 2 萬組（`XINV_N`）——同仁應發、扣款、實領、每個薪資項目逐欄相同（只允許 ot_info.xr／xclaim／cross_ot／ot_form_missing 不同）；逐日、逐店請款的加成倍數時數不超過同仁實際多拿的加成，計時國定假日／選舉日支援的 hx 不超過薪資單實發的「（支援○○）」加倍時數 | 請款只能動成本歸屬；選舉日手填衝突停發的支援時數不可以拿去請款（r2 前直接讀 att.sup_elec 會多請） |
| `xstore-lock-flow.test.js` | 跨店請款 r7 鎖月流程隨機對照：正式版 `1ab5655` vs 本版，算草稿 → 停用／改離職日／清除手動工時／改指定金額／別家核定改了／不動 → 重算或不重算 → 鎖。正式版鎖得下去本版也要（只允許「草稿存的請款跟重算不同」的設計擋，重算後要鎖得下去）、定案薪資列與明細逐列相同、快照請款＝定案草稿列 `ot_info.xsup`。`XFLOW_N`（預設 2,000，驗收跑 10,000） | 「草稿有、重算沒有的人」連續兩輪出事；請款跟薪資草稿必須是同一份資料 |
| `pay-replaceall-safe.test.js` | 薪資分頁整張覆寫 `payReplaceAll` 寫入防壞（2026-11-22）：假試算表外包一層會故意失敗的殼，15 張表 × 5 種列數 × 三種失敗點（清空後立刻失敗、寫到一半、送出 flush 才失敗）內容只能是寫入前或完整新內容且呼叫端收到錯誤；還原也失敗要講清楚；薪資計算 run＋item 兩張一起寫（後面失敗前面退回）；讀不到分頁不當空表（假別表、留停、事件日、打卡對照）；超過格線先加列；同時讀只會讀到舊或新；正常路徑跟改版前（`PAYRA_BASE`，預設 4f929d3）逐格相同（直接覆寫 540 次＋14 次真的存檔）；各店月加班表 ot_month（`payOtMonthSync_`）同樣三種失敗點、同時讀、超過格線、正常路徑 60 次同步 | 以前「先清空再寫」中途失敗會留下空表或半張表；`PAYRA_SRC=<舊版>` 可看到改版前在哪幾組失敗 |
| `hol-sched-gap.test.js` | 班表排了「國定假日假」（L＋國）、薪資國定假日清單（雙薪日）沒有那天 → 薪資頁黃字提示（2026-12 起，`PAY_HOL_GAP_FROM`）：純函式、同一天多人、班表沒發布／讀不到、節日表沒有那列（照舊 no_holiday）、週末節日與補假日、計時、跨期、到離職、月中草稿、總部／央廚發布找法、已鎖定照顯示；拿掉提示資料後計算回應、run／item、鎖定、讀取次數跟固定基準 473c6cb 相同；2026-09／10／11 與開關關著的 12 月 payroll_month／calc／get／鎖定逐字相同 | 只是提示，絕不能動到金額、擋到鎖月或多讀分頁；起算月之前必須跟沒做一樣 |
| `dup-xacct.test.js` | 跨帳號重複出差／請假（2026-11-23 主管定案 A，第一階段）：共用案例檔 `fixtures/dup-xacct-cases-v1.json`（mala-store-ops 跑同一份，兩份必須逐字相同）、`payDupOverlap_` 跟 `Requests.gs reqOverlap_` 逐格一致、整條計算→鎖定（DZY010 那種擋、出差＋計薪店請假擋、同帳號重疊擋、支援店的假只提醒、跨單位只提醒、對照沒確認／作廢／審核中／Mirror 列不算）；開關 `PAY_DUP_XACCT_FROM` 很後面時計算回應、run／item、鎖定回應、讀分頁順序跟 origin/main 逐字相同；填錯值維持擋、讀不到分頁擋 | 鎖月是薪資最後一道關，誤擋會卡發薪、漏擋會多付；關著時必須跟沒做一樣 |
| `hol-publish.test.js` | 節日表由營運系統發布（2026-11-24，節日表只留一份第 2 個改動）接收端：服務金鑰 `PAY_HOL_SVC_KEY`、合格推送與稽核、同版本重送不寫（drift／reapply）、版本倒退／同版本改內容／升版、34 種不合格整份拒收（空表、少月份、日期格式錯、本店專屬店別…；分頁、稽核、屬性都不動）、手算 H1～H9（已鎖定、已經過去、本店專屬；H9＝只收推送時已經過去的月份缺列：算薪擋下請聯絡資訊部、其他月份照常、版本資料帶出）、試推、開關 `PAY_HOL_SOURCE` 各種值、只收推送時開頁／算薪／手動覆寫與缺資料提示、本店專屬唯讀清單 | 動到薪資的資料來源；規則白話與手算見 `docs/holiday-publish/README.md` |
| `hol-publish-equiv.test.js` | 薪資試算逐字對照：主線 `64c9b52`（自己同步）vs 本分支開關預設（沒設／gov／亂填／空白）vs 只收推送（推送＝營運系統正本 `payrollRows()`），人事行政總處真檔夾具；4 單位 × 2026-08～2027-03 的 inputs／calc／run／item／month 逐字相同；兩個反證 | 不可降的標準：任何一個月任何一個人的試算結果跟主線相同 |
| `hol-publish-nocreate.test.js` | 節日表推送的試推與唯讀動作在分頁不存在時零寫入（獨立審查第 1 輪擋項 1）：真的 `payRead`／`paySheet`＋假試算表，所有寫入方法計數；gov／mini 試推、同版本不寫、`payroll_holiday_own_list`、只收推送時開頁同步；對照組＝正式推送會寫 | 開關照舊時試推不能有任何寫入（不能建分頁） |
| `hol-publish-past.test.js` | 節日表推送：已經過去的月份一律不寫（主管 2026-11-25 定案「過去的月份整月沒有節日資料時，不補上。」）：過去月份有資料但不同／整月沒有資料／本月／未來月 × 試推、正式推送、同版 reapply，真的 `payRead`／`paySheet`＋假試算表逐格快照；過去月份零寫入、不建分頁、回 `past_code:'hol_past_frozen'`＋`past_refused`＋`past_message`；本月與未來照常寫；沒有過去月份問題時回應沒有 `past_*`；界線＝`currentYmTaipei()`；gov 正式推送照舊 `hol_source_gov` | 擋項 2 的規則定案後，「過去月份不寫」要在三種推送都成立、而且回應講得出拒絕；重現另見 `tools/hol-blocker2-repro.js`（不在 run-all） |
| `hol-past-gov.test.js` | 已經過去的月份缺列不補，現行做法（gov）也套用（主管 2026-11-25「甲，也套用」；Codex 節日表第 2 輪擋項）：gov／mini × 開頁同步／算薪 × 過去缺列／過去有列／本月缺／未來缺；零寫入比分頁前後逐字相同；月初邊界用真的 `currentYmTaipei`（台北 11/30 23:59:59 vs 12/01 00:00）；放行比對另見 `tools/hol-gov-equiv.js`（不在 run-all） | 改到現行算薪前的同步路徑（紅燈區）：本月與未來照補、過去缺列一律不補，兩種開關同一句擋下 |
| `hol-past-set.test.js` | 整批儲存 `payroll_holiday_set`（gov）不能新增已經過去的月份列（Codex 第 2 輪；獨立 commit，拿掉限制時連這支一起刪）：過去缺列新增擋 `hol_past_add`＋分頁逐字不變；改既有過去列、本月、未來照舊；本店專屬範圍；月初邊界；mini 照舊 `hol_source_mini` | 這支 API 薪資頁已不呼叫，只剩直接打 API；擋了之後人工補過去月份只剩直接改試算表（取捨見 docs/holiday-publish A-1b） |
| `hol-publish-front.test.js` | 薪資頁紅字天數表上方那一行（版本、營運系統發布日、沒跟上這一版的月份、過去月份缺資料）與說明文字、`applyHol`／`holMiniUi`（共用登入從主檔回應拿到同一份）；開關預設時 `holSyncHtml`、`applyHol` 跟主線相同 | 共用登入不藏版本行的實跑在 `payroll-scope-front`；載入中／失敗的字兩種開關各驗在 `pay-rw-mutex` F6c |
| `ft8-peer-trip.test.js` | 正職滿 8 小時跨店合計算進別家「還沒核定」的已核准出差單（2026-11-23 Eason 定案）：11/06 原始互卡情境（舊版擋、新版過）與各種核定先後；別家已核定用核定時數不重複加；假單＋出差單同時；待審／退回／作廢／取消不算；不相加單位、同名兩位、總部鏡像列不算；讀不到別家照舊放行；支援那家超過 8 小時沒加班單仍擋、出差單不觸發跨店加班歸屬；Mac mini 摘要（peer_given）帶 tp 跟自己開別家逐字相同；上線途中新舊混著＝舊版結果；兩種核定順序要求相同＋隨機 1500 組「只有出差單 vs 已核定出差」要求相同；隨機 6000 組沒有（該算的）出差單時跟改版前 `473c6cb`（`FT8TRIP_BASE` 可換）逐位元組相同＋對照組證明比對有效 | 這條決定主管能不能核定工時；沒有出差單的人必須跟改版前完全一樣 |
| `late-first-block.test.js` | 上午整段沒到改算遲到（2026-11-26 主管定案，2026-11-01 起〔原定 12/1，11/26 主管改〕；`Code.gs lateLeadOf_`、`Requests.gs reqLateLeadOn_`）：共用案例檔 `fixtures/late-lead-cases-v1.json`（mala-store-ops 跑同一份，兩份必須逐字相同）逐案核定狀態／擋不擋／忘打卡單張數／遲到分鐘＝營運系統預填；主管填遲到 240／0；正職不用假單；加班單照現行；`lateLeadOf_` 邊界；每天 05:00 重算不改「第一段上班無打卡」「打卡未入帳」與前導段有忘打卡單的列；改版前（`LATE_LEAD_BASE`，預設 f21cc25）vs 本版亂數 3000 組（`helpers/late-lead-corpus.js`，`LATE_LEAD_N`／`LATE_LEAD_SEED`）不觸發的逐筆相同；計時 8 小時－遲到 240 分＝實發 4 小時、遲到不計薪沒開會多發的反證 | 動到薪資金額（紅燈）：不觸發的情境、生效日前、已核定的列都必須跟改版前一樣 |
| `late-lead-xcheck.test.js` | 上午整段沒到改算遲到的前後端一致性對照（2026-11-26 第四輪起；Codex 第二輪、驗收員第五輪加驗的固定防線）：同一組輸入先用營運系統 `core-calc.js` 算預填（新版／改動前），再照預填送打卡端只檢查（這一版／f21cc25）；格點 20808 組（休息帶 × 日期 × 班表三種寫法 × 17 種打卡樣態 × 17 種單據〔含補中間休息、整天／下午出差、補上班＋部分假〕× 主管遲到欄）＋亂數 5 個種子 × 15000（`LATE_XCHECK_SEEDS`／`LATE_XCHECK_N`）；斷言 (a) 預填送出去不會因新規則被擋（主線不擋的）、(b) 卡片遲到＝打卡端遲到、(c) 打卡端不套時預填＝改動前；另量總閘擋回主線的比例。營運系統程式預設用凍結副本 `fixtures/storeops-core-calc.js`（＋`storeops-core-calc-before.mjs`；sha256 釘在測試裡、mala-store-ops 釘同一個），設 `STOREOPS_ROOT` 就改讀那個資料夾；平行子行程數 `LATE_XCHECK_JOBS`（預設 4） | 前端另寫一套判斷跟打卡端不一致的那類錯（Codex 第一、二輪、驗收員第五輪都是）；營運系統改 core-calc.js 要同步副本、兩邊雜湊一起改 |
| `helpers/sheets-like.js` | 假試算表本體（不是測試，run-all 不會跑它）：寫入字串照 Sheets 規則轉型、`setNumberFormat('@')` 鎖文字、在 vm 的 Date realm 建 Date、格線範圍外丟例外；每條規則標 [已查證] 或 [推定]＋出處，見檔頭 | 要模擬正式試算表時用這個，不要再寫「把字串原樣存起來」的假 sheet |
| `kuangzhi-approve.test.js` | 曠職打卡端（2026-11-26 開工確認 13 題照推薦；合約 `docs/kuangzhi/contract.md`）：共用案例檔 `fixtures/kuangzhi-cases-v1.json`（營運系統跑同一份，sha256 釘住）；認定成功（核定 0＋leave 曠職＝班表時數、句 8）、句 9–13 各種擋、kz_day_done、自補期限、權限（只收個人帳號代轉）、生效日與壞值、只檢查不寫、重新核定解除、一般下拉／代開／同仁請假單選不到、打卡頁與 LINE 出勤班表顯示曠職、不會自動寫、relay_pull 帶開關 | 認定曠職會扣錢：擋的條件與字一個都不能錯 |
| `kuangzhi-equiv.test.js` | 曠職開關沒設／空白／壞值時，打卡端核定、只檢查、白名單查表、同仁請假單、代開、打卡頁跟主線 `f21cc25`（`KZ_BASE` 可換）逐字相同；開關開時沒帶曠職的請求也相同；mgr_day（合約 v1.2）開關關逐字相同、開關開只有那天有曠職登記的人 approved 多帶 entered_at（with_ver 只有那人變）。`git archive` 解基準版到暫存（`KZ_TMP`） | 紅線「空白＝今天的行為逐字不變」 |
| `kuangzhi-latelead.test.js` | 合併預演（#242＋#243）：認定曠職與上午整段沒到改算遲到同一次核定互斥（曠職只收 0 時段、沒打卡；遲到只在有時段時算）；試核定兩欄都在；先曠職後打卡進來重新核定＝覆蓋、曠職那列消失 | 不重複扣（曠職＋遲到） |
| `kuangzhi-payroll.test.js` | 曠職薪資端：開關關＝12／11 月試算、假別設定、下拉、鎖定、草稿列跟主線逐字相同；開關開、沒曠職的月份金額每一欄相同；手算 H1–H8（績效歸零、計時滿勤、扣款＝全薪÷30×曠職天數、按天遞減設定）；疑似清單規則、鎖月擋句 22（KUANGZHI_LOCK_BLOCK=on 才擋；關著鎖定跟主線相同）、stale_run、請假對不上豁免；生效日在月中；假別表自動補內建列、既有列不變 | 不可降的標準 1（沒曠職的月份 100% 相同）、手算對照 |
| `kuangzhi-sameday.test.js` | 曠職 v1.4 認定時點（2026-11-28 主管定案「那一班的下班時間過後就可以認定」）：一段班、兩段班（看最後一段）、跨午夜的班一律不能認定（外部審查擋項 1）、end 不合理或讀不出一律不通過、沒帶 end 照舊自補期限句 12、國定假日／沒發布照舊句 11、打卡先於時點判、認定後補打卡不會自己改 | 認定會扣錢：時點只能比主管定的晚、不能早 |
| `kuangzhi-x.test.js` | 曠職合約 v1.2 打卡端：sched_pub 格子的排除代號 x（只收 W 格上的 dir／hq_off／away／late，怪值、非字串、非 W 丟掉；too_big 含 x）；LINE 出勤班表、sched_day_roster、schedPubDaysFor_ 不輸出 x（對 `f21cc25` 逐字）；薪資掃疑似 C1–C6（有效 x 不列疑似、不擋鎖月；怪值照舊；連續被排除日斷開；已認定照扣；生效日前不作用；從 sched_pub 分頁讀起的真路徑）；開關關 sched_pub 有 x 也跟主線逐字相同；容量（`tools/kuangzhi-x-capacity.js`）；v1.3 第六節：國定假日 `hol`（2027-02-06、02-07、02-28 帶 hol 不列疑似、補假日不列、一般上班日照列；帶不帶 hol 金額與國定假日加發逐字相同；開關關跟主線相同） | x 是放寬欄位：只能在五個代號（v1.3 加 hol）、W 格時放寬，其他一律照舊列疑似 |
| `kuangzhi-release-check.test.js` | `tools/kuangzhi-release-check.js`：佔位旗標已拿掉＝通過；又出現佔位旗標的版本一定失敗 | 不能帶著佔位上線 |

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
