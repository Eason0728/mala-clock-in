# 麻的小辛辣 員工打卡系統（階段一：純記錄）

設計文件：`/Users/guoeason/mala-schedule/docs/superpowers/specs/2026-07-05-employee-clock-in-design.md`

## 檔案

- `clock.html` — 員工打卡頁（手機開啟，網址帶 `?k=員工專屬key`）
- `apps-script/Code.gs` — Google Apps Script 後端（貼到 Apps Script 編輯器）
- `mock/mock_server.py` — 本機模擬後端（Python3 標準庫，免裝套件）
- `mock/mock_data.json` — 模擬後端的資料檔（首次執行自動產生，含種子員工）

## 本機測試步驟

1. 啟動模擬後端：
   ```
   cd /Users/guoeason/mala-clock-in/mock
   python3 mock_server.py
   ```
   預設監聽 `http://localhost:8899`，同時服務 repo 靜態檔＋`/api` 端點。

2. 用手機瀏覽器（或電腦瀏覽器）打開：
   ```
   http://localhost:8899/clock.html?k=testkey1&api=/api
   ```
   - `k=testkey1` → 測試員工「測試一」（E01）
   - `k=testkey2` → 測試員工「測試二」（E02）
   - `?api=/api` 只在 `localhost`/`127.0.0.1` 生效，用來覆蓋 clock.html 內建的正式 API_URL 佔位字串；正式環境不需要也不能加這個參數。

3. 手機打開時瀏覽器會跳出「允許定位」，需允許才能打卡。若在電腦上測試，Chrome 開發者工具可用 Sensors 面板模擬座標。

4. 管理端點（admin_key 固定 `test-admin`，僅本機測試用）：
   ```bash
   # 查詢名冊
   curl -s -X POST http://localhost:8899/api \
     -d '{"action":"get_roster","admin_key":"test-admin"}'

   # 查詢近 31 天打卡紀錄
   curl -s -X POST http://localhost:8899/api \
     -d '{"action":"get_events","admin_key":"test-admin"}'

   # 核准/拒絕新裝置
   curl -s -X POST http://localhost:8899/api \
     -d '{"action":"approve_device","admin_key":"test-admin","emp_id":"E01","device_id":"新裝置碼","approve":true}'

   # 名冊同步（新增/更新員工，不覆蓋既有 key/device_id）
   curl -s -X POST http://localhost:8899/api \
     -d '{"action":"sync_roster","admin_key":"test-admin","employees":[{"emp_id":"E03","name":"測試三","active":true}]}'
   ```

5. 重置測試資料：關掉 mock server 後刪除 `mock/mock_data.json`，下次啟動會重新產生種子資料（E01/testkey1、E02/testkey2）。

## 日後部署步驟（正式上線前，動手前務必先跟老闆確認）

**以下都是建立正式雲端資源的動作，Claude 不會主動執行，需老闆手動操作或明確同意後才進行：**

1. 開一份新的 Google 試算表（正式用），複製試算表 ID。
2. 開啟該試算表的 Extensions > Apps Script，貼上 `apps-script/Code.gs` 全部內容。
3. 修改檔頭 `CONFIG`：
   - `SPREADSHEET_ID` 填入步驟 1 的試算表 ID
   - `ADMIN_KEY` 自訂一組管理密鑰（供管理端點 API 使用，不要用本機測試的 `test-admin`）
   - `STORE_LAT` / `STORE_LNG` / `RADIUS_M` 已預填光復店座標與 5 公尺半徑，如需調整在此修改
4. 在 Apps Script 編輯器手動執行一次 `setup()` 函式（會跳出授權視窗，需同意），建立 `roster`、`events` 兩個分頁與表頭。
5. Deploy > New deployment > Web app：
   - Execute as：我（自己的帳號）
   - Who has access：Anyone
   - 部署後複製 Web App 網址
6. 把該網址貼到 `clock.html` 的 `API_URL` 常數（取代 `PASTE_APPS_SCRIPT_URL_HERE`）。
7. 加入員工並取得每人的專屬 `key`（做法見下節「不連接排班 app 的營運方式」），組出打卡連結：
   ```
   https://你的網域或路徑/clock.html?k=員工的key
   ```
   （若 clock.html 直接放 GitHub Pages 或其他靜態網站，網址前綴依實際部署位置而定）
8. 把連結傳給對應員工即可開始使用。

（暫緩，待日後連接）原設計由排班 App 的「同步名冊」按鈕呼叫 `sync_roster` 動作批次同步在職員工、並在排班 App 的「出勤」分頁看紀錄與核准裝置；排班 app 整合暫緩期間改用下節做法，`sync_roster`／`approve_device` 等 API 動作原樣保留，日後連接直接可用。

## 不連接排班 app 的營運方式（現行做法）

排班 app 整合暫緩，名冊管理與裝置核准全部在 **Apps Script 編輯器**操作：開啟試算表 > Extensions > Apps Script，在程式碼最下方寫一個暫時函式帶參數，選它執行，結果看下方「執行紀錄」（Logger）。

### 加員工、拿專屬連結

```javascript
function run() { addEmployee('王小明'); }        // 自動編號（接續最大 E 編號，如 E03）
function run() { addEmployee('王小明', 'E10'); } // 或自訂編號
```

執行紀錄會印出：`已新增員工 王小明（E03），專屬連結參數：?k=xxxxxxxxxxxxxxxxxxxx`。把 `?k=...` 接在 clock.html 網址後面，傳給該員工。

員工離職：`function run() { deactivateEmployee('E03'); }`（active 設 false，該連結即失效，不刪資料）。

### 看打卡紀錄

直接開 Google 試算表的 `events` 分頁，一列一筆打卡事件（時間、員工、上/下班、座標、距離、是否在範圍內、裝置、狀態）。`status` 欄意義：

| status | 意義 |
|---|---|
| `ok` | 正常入帳 |
| `pending_device_approval` | 新裝置，待核准（核准後會變 `ok`） |
| `rejected_out_of_range` | 超出 5 公尺範圍，記錄但不算數 |
| `rejected_device` | 新裝置被拒，不算數 |
| `rejected_duplicate` | 重複打卡（回看 12 小時內最後一筆算數的卡是同型，上/下班未交替），記錄但不算數 |

### 員工換手機（或懷疑連結被轉傳）時的核准流程

1. 列出所有待核准裝置（姓名、裝置碼、首次時間、筆數）：
   ```javascript
   function run() { listPendingDevices(); }
   ```
2. 確認是本人換手機 → 核准（取該員工「最新一個」待核准裝置：roster 改綁新裝置，該裝置的待核准打卡全部補登為 `ok`）：
   ```javascript
   function run() { approvePendingDevice('E01'); }
   ```
3. 不是本人（連結被轉傳代打）→ 拒絕（那些打卡改 `rejected_device`，roster 不改綁）：
   ```javascript
   function run() { rejectPendingDevice('E01'); }
   ```

## 出勤月表

### 分頁機制

- 每月一個分頁，分頁名＝`yyyy-MM`（如 `2026-07`），由程式**整頁重算產生**——不要手動改月表分頁的內容，下次重算會整頁覆蓋（要人工修正就改 `events`／`leave` 來源資料）。
- 版面：上段「當月累計」（姓名｜參考時數｜核定工時｜異常筆數｜請假天數，依 roster 順序、只列在職員工），空一列後接明細——**一人一整月**：每位員工一個區塊（粗體姓名標題列＋該員工當月每個有紀錄日一列：日期｜星期｜班段｜參考時數｜核定工時｜備註＋「小計」列，小計含參考／核定兩個數字），區塊間空一列。明細列到今天為止；週六日該列淺灰底、備註異常字紅色。
- 班段＝`ok` 事件依時間配對（in 配 12 小時內的下一筆 out），跨夜班顯示 `HH:MM–HH:MM(+1)` 並歸上班那天。配不到的顯示 `？`＋備註「下班忘刷卡」／「上班忘刷卡」；**當天只要有任一筆忘刷卡，該日參考時數與核定工時整天留空白**（待人工判定）。
- 兩個時數欄並列供驗證換算：
  - **參考時數**＝打卡時間原始相減（1 位小數，不取整）。
  - **核定工時**＝打卡時間**各自取整到 15 分鐘刻度**再相減：上班捨秒後往「後」進位到刻度（11:02→11:15，剛好在刻度不動）、下班捨秒後往「前」捨去到刻度（14:31→14:30）；每段取整後相減（若 out ≤ in 該段＝0），當日＝各段相加，跨夜段同規則。例：11:02–14:31＋17:05–21:44 → 3.25＋4.25 ＝ 7.5H。
- 自動重算：先在 Apps Script 編輯器手動執行一次 `setupMonthlyTrigger()`（重複執行不會疊加觸發器），之後每天 05:00 自動重算當月。**觸發時刻依 Apps Script 專案設定的時區，請確認為台北 (GMT+8)。**
- 凍結規則：每月 1–3 日會連上月一起重算（收尾跨夜班、補核准的裝置事件），4 日起上月分頁凍結不再變動。

### 10 分鐘刷新（同仁打卡後月表多快反映）

- 部署後**額外**在 Apps Script 編輯器手動執行一次 `setupMonthRefreshTrigger()`（跟 `setupMonthlyTrigger()` 是兩個獨立的觸發器，都要各跑一次；重複執行不會疊加出第二顆）。
- 之後每 10 分鐘會自動檢查 `events` 分頁有沒有新增列，有才重算當月月表；沒有新打卡就直接跳過，半夜幾乎零成本。也就是說：**同仁打卡後，月表最多晚 10 分鐘反映**，不用再等隔天 05:00。
- 這個 10 分鐘觸發器只重算「當月」；**跨月凌晨的班（例如 8/1 凌晨 01:00 才打下班卡，收的是 7/31 的班）由既有每日 05:00 觸發器負責收尾**（05:00 觸發器在每月 1–3 日會連上月一起重算）——10 分鐘觸發器不處理這件事，不用另外設定。
- 若跟 05:00 的整月重算或手動 `rebuild_month` 剛好撞期，10 分鐘觸發器會直接讓路（搶不到鎖就跳過該次，下一次 10 分鐘後再重算），不會卡住或報錯。

### leave（請假）分頁填法

`setup()` 會建立 `leave` 分頁，Eason 手動填三欄：

| 欄 | 格式 | 範例 |
|---|---|---|
| 日期 | yyyy-mm-dd | 2026-07-09 |
| 姓名 | 須與 roster 的 name 一致（前後空白自動忽略） | 王小明 |
| 假別 | 自由填 | 特休 |

姓名比對不到 roster 的列會被**跳過**（不會報錯），填完可跑一次重算確認月表有出現。請假天數計整月（含當月還沒到的已填假單）；明細列只列到今天。

### 手動重算（rebuild_month）

改了 leave 或核准裝置後想立刻更新月表，不用等 05:00：

- 編輯器端：`function run() { rebuildMonth('2026-07'); }`（或 `dailyMonthlyRebuild()` 重算當月）。
- API 端（給日後排班 app 或指令列用）：
  ```bash
  curl -s -X POST 'APPS_SCRIPT網址' \
    -H 'Content-Type: text/plain' \
    -d '{"action":"rebuild_month","admin_key":"你的ADMIN_KEY","ym":"2026-07"}'
  # ym 可省略＝當月；回 {"ok":true,"ym":"2026-07","rows":N}
  ```
- `rebuild_month` 是 GAS 專屬 action（依賴試算表分頁），mock server 不實作。

## 打卡頁的今日時數（自助查詢）

`clock.html` 在今日打卡清單下方會多顯示一行今日時數摘要（`whoami` 回應新增 `today_hours: {reference, approved, working_since}`），讓同仁自己就能查、不用來問 Eason：

- 有進行中的班段（今日最後一筆 `ok` 事件是尚未配對的上班卡）→「上班中（HH:mm 起）・已完成時段：參考 X 小時／核定 X 小時」，`HH:mm` 為打卡的原始時間（取整只用於算時數，顯示不取整）。
- 無進行中班段 → 「今日時數：參考 X 小時／核定 X 小時」。
- 只計入今日**已完成**的班段（`in`＋`out` 都是 `ok` 且已配對），算法與出勤月表的參考時數／核定工時同一套規則（見上方「出勤月表」章節），不重算兩套邏輯。

### 回查最近 40 天（my_recent）

今日區塊下方有「查看最近 40 天」按鈕，點了才向後端要資料（action `my_recent`，payload 同 `whoami`：`{key, device_id}`），再點可收合。回傳 `days`：最近 40 天（台北時間，含今天）每天一筆 `{date, segments:[{in,out,cross}], reference, approved, notes}`，無事件的日子省略。慣例與出勤月表一致：班段歸上班（in）那一天、跨夜段顯示 `(+1)`、缺卡的一端顯示 `？` 並註記「上班忘刷卡」／「下班忘刷卡」（今天尚未下班的班段例外，註記「上班中」）；`reference`/`approved` 只計入該日已完成班段。驗證與 `whoami` 相同（key 無效即拒；裝置只回 `device_state` 提示，唯讀查詢不因裝置不符而拒回）。

## 注意事項

- 階段一不做 PIN 密碼、不做登入，認人靠「專屬連結 key ＋ GPS ＋ 裝置綁定」三者組合，這是設計文件的刻意決定。
- `events` 分頁只會逐筆新增，絕不覆蓋既有紀錄。
- `sync_roster` 對既有員工只更新 `name`/`active`，絕不覆蓋 `key`/`device_id`/`device_bound_at`。
- 開發/測試階段請勿對正式 Google 試算表做會覆蓋既有資料的操作。
