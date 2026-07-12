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
   - `ADMIN_KEY` 自訂一組管理密鑰（給排班 App 呼叫管理端點用，不要用本機測試的 `test-admin`）
   - `STORE_LAT` / `STORE_LNG` / `RADIUS_M` 已預填光復店座標與 50 公尺半徑，如需調整在此修改
4. 在 Apps Script 編輯器手動執行一次 `setup()` 函式（會跳出授權視窗，需同意），建立 `roster`、`events` 兩個分頁與表頭。
5. Deploy > New deployment > Web app：
   - Execute as：我（自己的帳號）
   - Who has access：Anyone
   - 部署後複製 Web App 網址
6. 把該網址貼到 `clock.html` 的 `API_URL` 常數（取代 `PASTE_APPS_SCRIPT_URL_HERE`）。
7. 用排班 App 的「同步名冊」功能（`sync_roster` 動作）把在職員工同步進 `roster` 分頁，取得每人的專屬 `key`，組出打卡連結：
   ```
   https://你的網域或路徑/clock.html?k=員工的key
   ```
   （若 clock.html 直接放 GitHub Pages 或其他靜態網站，網址前綴依實際部署位置而定）
8. 把連結傳給對應員工即可開始使用。

## 注意事項

- 階段一不做 PIN 密碼、不做登入，認人靠「專屬連結 key ＋ GPS ＋ 裝置綁定」三者組合，這是設計文件的刻意決定。
- `events` 分頁只會逐筆新增，絕不覆蓋既有紀錄。
- `sync_roster` 對既有員工只更新 `name`/`active`，絕不覆蓋 `key`/`device_id`/`device_bound_at`。
- 開發/測試階段請勿對正式 Google 試算表做會覆蓋既有資料的操作。
