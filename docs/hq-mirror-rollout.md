# 總部打卡鏡像：上線步驟（2026-10-09）

目的：總部試算表每天 04:00 自動抄寫「央廚名冊裡 HQ- 前綴的人」的 events／approved／leave，
之後薪酬門市表「總部」列的 clock_ss_id 改指總部自己的試算表，薪資結果不變。
程式：`apps-script/Mirror.gs`；設定範本：`MirrorConfig.example.gs`；補丁：`tools/patch_hq_mirror.py`；測試：`tests/hq-mirror.test.js`。

每步標示「是否寫入正式資料」。

| # | 動作 | 寫入正式資料？ |
|---|---|---|
| 1 | 在暫存目錄 `clasp pull`（總部）。把 `Mirror.gs` 存成 `Mirror.js`；新增 `MirrorConfig.js`（照範本，`ss_id` 填央廚打卡試算表 ID＝薪酬門市表 CF 那列的 clock_ss_id，`emp_prefix:'HQ-'`）。對複本跑 `python3 tools/patch_hq_mirror.py 程式碼.js`（乾跑）再加 `--write`；`node --check`（.gs 要先複製成 .js）。push → `clasp version` → `clasp redeploy <總部部署ID> -V <版本>`（絕不 deploy；push 前重查 list-deployments 與雲端是否有人推過）。 | 改程式，不動資料 |
| 2 | 探針：`mirror_run {admin_key, apply:false}`。看 sources[0].tables 各表 added 筆數（events 應等於央廚 HQ- 的打卡筆數）、warnings（有「來源有、目標沒有的欄位」要先看）、header_added／sheets_created。錯誤金鑰回 unauthorized＝已掛載。 | 否（零寫入） |
| 3 | `mirror_run {admin_key, apply:true}` 跑一次。回讀：總部 events／approved 的 mirror_src＝CF 筆數＝步驟 2 的 added；總部自己的列筆數不變。 | **是**（總部試算表加 mirror_src 欄、追加鏡像列） |
| 4 | `mirror_setup_trigger {admin_key}`（或編輯器跑 `setupMirrorTrigger()`）。回 after 含 mirrorFromSources 一支。`setup_triggers` 不需要改（它只管月表兩支，不會刪鏡像觸發器）。 | 是（建觸發器） |
| 5 | 備份 `payroll_store_get` 全表 JSON → 只改總部列的 clock_ss_id 為總部試算表 ID → `payroll_store_set` 整批寫回 → 回讀逐列比對（其他店不變）。`emp_prefix` 維持原值。**前提：總部名冊 HQ-01 那列只能停用、不可刪**（請假靠姓名對回工號）。 | **是**（薪酬門市表） |
| 6 | 用 `payroll_attendance_export`（store 總部、ym 2026-09、emp_id HQ-01）與 `payroll_month`／`payroll_inputs`（唯讀；注意 `payroll_month` 對沒有 run 的月份會重算寫入，驗證用 `payroll_inputs`）比對改線前後 HQ-01 九月的工時、請假、出勤天數一致（改線前的數字在步驟 5 之前先存一份）。不一致就把 clock_ss_id 改回央廚（回退）。 | 否 |

回退：薪酬門市表總部列改回央廚 ID（立即生效）；刪觸發器 mirrorFromSources；總部各表 mirror_src＝CF 的列可整批刪。

已知注意：
- 鏡像列不隨總部 05:00 recheck 重算（補丁 B）；若不套補丁 B，總部的 recheck 可能對鏡像進來的核定另寫一筆本店列覆蓋之。
- 總部 events 內若還有 HQ-01 自己的舊列（8 月測試期），會與鏡像列並存；9/1 前後是否已清請確認，否則 pairShifts 會看到重複打卡。
- 04:00 觸發器實際在 04:00–05:00 之間執行，早於 05:00–06:00 的 dailyMonthlyRebuild。
