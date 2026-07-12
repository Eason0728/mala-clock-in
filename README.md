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
   - `STORE_LAT` / `STORE_LNG` / `RADIUS_M` 已預填光復店座標與 50 公尺半徑，如需調整在此修改
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
| `rejected_out_of_range` | 超出 50 公尺範圍，記錄但不算數 |
| `rejected_device` | 新裝置被拒，不算數 |

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

## 注意事項

- 階段一不做 PIN 密碼、不做登入，認人靠「專屬連結 key ＋ GPS ＋ 裝置綁定」三者組合，這是設計文件的刻意決定。
- `events` 分頁只會逐筆新增，絕不覆蓋既有紀錄。
- `sync_roster` 對既有員工只更新 `name`/`active`，絕不覆蓋 `key`/`device_id`/`device_bound_at`。
- 開發/測試階段請勿對正式 Google 試算表做會覆蓋既有資料的操作。
