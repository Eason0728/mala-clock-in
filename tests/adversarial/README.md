# LINE 打卡對抗性驗證（2026-11-03）

主動找「會讓它算錯工時、代打、從店外打卡、防呆失效、申請或核定被竄改、看到別人資料、同仁卡住」的輸入與時序；每一條都實際跑程式證實或推翻。
判斷以 `apps-script/*.gs` 真函式為準，mock 只用來讓畫面動。

| 檔案 | 怎麼跑 | 內容 |
|---|---|---|
| `tests/adversarial-line.test.js` | `node tests/adversarial-line.test.js`（`run-all.js` 也會跑） | 後端：Liff／Code／Rest／Requests／LineHub 真函式在 vm 裡實跑。`KNOWN`＝已確認的問題，寫的是「應該要」的行為，目前會失敗、只印出不擋 run-all；修好後會變 ✓，再改成 `ok`。 |
| `tests/adversarial/front_line.py` | `E2E_MOCK_PORT=8971 /usr/bin/python3 tests/adversarial/front_line.py` | 前端：三個 LINE 頁面灌 HTML 看會不會變標籤（T1–T4）；打卡頁開著不動再按上班（T5，KNOWN）。自己起 mock、跑完關掉。 |

- 起 mock 前先 `lsof -nP -iTCP:<埠> -sTCP:LISTEN` 確認沒人用；8931、8947 常有別的 mock，不要關。
- 設 `ADV_STRICT=1` 時 KNOWN 失敗也讓程序非零結束（修完驗收用）。
- 兩支都不能和 `e2e/run.py`、`e2e/clock_line.py` 在同一個 worktree 同時跑（共用 `mock/mock_data*.json`）。
- 修法與嚴重度寫在交付報告（不進 repo）；測試檔只用假名、不含金鑰與試算表 ID。

## 2026-11-03 修正後
當初確認的 7 條都已修（分支 fix/line-adv），對應的 `KNOWN` 已改成 `ok`、另補對照組（不重疊的第二段加班照收、不同假別照收、第一筆沒算數時記號還原等）。
`node tests/adversarial-line.test.js` 現在 31 項全過、0 KNOWN。之後再找到新問題，照原本的方式用 `KNOWN` 先記下。

## 第二輪：其餘模組（2026-11-03，分支 adv/modules2）
LINE 那條路以外的模組：值班核定頁 manager.html 呼叫的 `mgr_*`（核定一條龍、多假別、遲到分鐘欄、同仁異動、新增同仁、公告、裝置核准）、
舊連結打卡（handleClock／whoami／my_recent）、班表 `Sched.gs`／`SchedPub.gs`、薪資 `Payroll.gs`（payCollect／payCalcOne／出勤紀錄表／附件權限／特休／補休帳）、
總部鏡像 `Mirror.gs`、名冊服務 `SvcStaff.gs`。

| 檔案 | 怎麼跑 | 內容 |
|---|---|---|
| `tests/adversarial-modules.test.js` | `node tests/adversarial-modules.test.js`（`run-all.js` 也會跑） | 後端：Code／Payroll／Liff／Rest／Requests／Mirror／SvcStaff／Sched／SchedPub 整檔載進同一個 vm（跟正式的光復專案同一個全域），假試算表會真的刪列、可模擬 Sheets 把日期轉成日期物件（`autoDate`）。七節 53 項：45 項 `ok` 守門、8 項 `KNOWN`。 |
| `tests/adversarial/front_modules.py` | `E2E_MOCK_PORT=8981 /usr/bin/python3 tests/adversarial/front_modules.py` | 前端：manager.html 每個「人打的文字」欄位灌 HTML／屬性逃脫（M1）、新增同仁與恢復在職的成功回顯（M2／M3，KNOWN）、09:00–09:00 的確認框（M4）、批次核准 31 筆（M5）；clock.html 姓名／公告／狀態（C1）。22 項：19 項過、3 項 KNOWN。 |

- 沙盒裡 Payroll.gs 的 `PAY_*_CACHE` 是「同一次請求內」的快取，每個薪資入口被呼叫時會先清掉（正式環境每次請求都是新的執行環境）；自己加測試時用 `m.fresh()`。
- 同一個人同一天兩筆核定若在**同一秒**落地，後寫的會輸給先寫的（KNOWN #2）——測試裡連續核定要 `m.sb.__now += 1000`。
- 8981 是這支的埠；8931、8947、8961、8971 有別的 mock 在用，不要動。
