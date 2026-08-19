---
name: mala-clock-in
description: >
  維護「麻的小辛辣」員工打卡系統（mala-clock-in repo）的專用 skill。
  涵蓋：員工打卡頁 clock.html（含天氣動態背景與薪資查詢分頁）、值班主管
  核定頁 manager.html、薪資管理頁 payroll.html、Apps Script 後端與出勤月表。
  當使用者提到以下任何情境時，必須載入此 skill：改打卡頁／打卡介面、
  天氣背景（沒出現、效果不對、想調整）、加員工／員工離職、換手機核准裝置、
  出勤月表怪怪的、請假登記、超出範圍打不了卡、定位不準、主管核定、
  改薪資頁、部署打卡系統、debug 這些頁面的錯誤。即使使用者只說
  「打卡頁改一下」「有人打不了卡」「月表數字不對」，也應載入此 skill。
---

## 系統概覽

員工打卡系統，階段一「純記錄」：不做登入，認人靠**專屬連結 key ＋ GPS（20 公尺半徑）＋裝置綁定**三者組合。後端是 Google Apps Script Web App ＋ Google 試算表。**README.md 是完整正本**，本 skill 只放最常用的速查，細節以 README 為準。

| 檔案 | 用途 |
|---|---|
| `clock.html` | 員工打卡頁（`?k=員工key`），含「我的薪資」分頁與天氣動態背景 |
| `manager.html` | 值班主管核定頁（`?k=主管key`），輸入實際上班時段，不需定位 |
| `payroll.html` | 薪資管理頁（Eason 用；時薪、餐補、加薪扣款、特休等） |
| `apps-script/Code.gs` | 打卡後端（貼到試算表的 Apps Script） |
| `apps-script/Payroll.gs` | 薪資後端 |
| `mock/mock_server.py` | 本機模擬後端（port 8899，免裝套件） |

試算表分頁：`roster`（名冊）、`events`（逐筆打卡，只增不減）、`leave`（請假，手填）、`approved`（主管核定）、`managers`、`notes`（月表人工備註正本）、每月一張 `yyyy-MM` 月表。

## 部署

- 前端：GitHub Pages 直接吃 `main`，push 後約 1–2 分鐘生效，員工連結永遠不變。
- 後端：改 `Code.gs`/`Payroll.gs` 要貼回 Apps Script 編輯器並重新部署 Web App。
- `API_URL` 常數在 `clock.html` 與 `manager.html` **各有一份**，要改要改兩處。

## 核心規則速查

- 打卡判定：光復店座標（`CONFIG.STORE_LAT/STORE_LNG`，2026-07-13 實測校正值 `24.7840945, 121.0157448`）、半徑 `RADIUS_M = 20`。
- `events.status`：`ok`／`pending_device_approval`（新裝置待核准）／`rejected_out_of_range`／`rejected_device`／`rejected_duplicate`（12 小時內同型未交替）。
- 定位誤差 `accuracy_m` 記在 events 最後一欄；`LOW_ACCURACY_M = 50`（Code.gs 與 mock 兩處要同步）。超出範圍＋誤差大才提示同仁關 Wi-Fi，定位準卻在店外**不**提示。
- **參考時數**＝打卡各自取整 15 分鐘相減加總，純機器記錄；**核定時數**＝讀 `approved` 分頁（主管輸入），兩者獨立。忘刷卡當天參考時數整天留白，核定不受影響。
- 月表：程式整頁重算，**前 6 欄不可手改**；第 7 欄「人工備註」給人手打，正本在 `notes` 分頁（刪備註要刪 notes 那一列，清月表格子沒用）。每月 4 日起上月凍結。
- 異常筆數以「天」計：當天命中任一異常項就算 1 筆；「超出範圍嘗試」標紅但不計數。
- 觸發器兩顆都要裝：`setupMonthlyTrigger()`（每天 05:00 重算）＋`setupMonthRefreshTrigger()`（每 10 分鐘有新資料才重算）。時區須為台北。

## 常用操作（都在 Apps Script 編輯器跑臨時函式）

```javascript
function run() { addEmployee('王小明'); }        // 加員工，Logger 印出 ?k=專屬連結
function run() { deactivateEmployee('E03'); }    // 離職（連結失效，不刪資料）
function run() { listPendingDevices(); }         // 列待核准裝置（換手機時）
function run() { addManager('王經理'); }          // 加值班主管
function run() { rebuildMonth('2026-07'); }      // 手動重算月表
```

## 本機測試

```
cd mock && python3 mock_server.py     # port 8899，靜態檔＋ /api 一起服務
clock.html?k=testkey1&api=/api        # 測試員工；testmgr1=測試主管；admin_key=test-admin
```
`?api=`、`loc=`（模擬座標）、`acc=`（模擬定位誤差）都只在 localhost 生效。刪 `mock/mock_data.json` 重置種子資料。薪資 mock（`payroll_mock*.json/js`）含真實姓名薪資，**絕不 commit**（.gitignore 已擋）。

## 天氣動態背景（2026-08-19 上線）

打卡頁背景依**光復店當下真實天氣**自動換情境（Open-Meteo `weather_code,is_day`，免金鑰），日夜依實際日出日落自動切，同仁不用選任何東西。走真實感路線：雨有景深與動態模糊、玻璃水珠會滑落、太陽有鏡頭光斑、雲是雜訊算的、閃電有分岔。**背景火焰影片已移除（2026-08-19），不要加回來**；紅底保留。

- 程式全在 `clock.html`：色調 CSS 在 `/* ── 天氣動態背景 ── */` 區塊，效果 JS 是檔尾**最後一個 `<script>`**（獨立 IIFE，與打卡邏輯分離，改壞不影響打卡）。
- 快取 localStorage `mala_wx_cache`，20 分鐘更新；開頁先用快取再背景更新、6 秒逾時——**天氣永遠不拖慢打卡**。抓不到就不套用、維持紅底，這是刻意設計不是 bug。
- 效能：切背景分頁即停動畫；`prefers-reduced-motion` 只畫靜止一幀；粒子有上限（雨 170／雪 120／星 110），畫布最高 1.75 倍解析度，貴的圖層預先烘成貼圖。
- 常見調整：換座標→`STORE_LAT/LNG`；更新頻率→`CACHE_MS`；雨勢→`sceneOf()` 的 `power` 或 `rebuild()` 密度；色調深淺→CSS `.wxTint`；整組關掉→移除天氣 IIFE 與 `.wx` 圖層 HTML。
- 預覽：網址加 `&weather=clear|cloudy|overcast|fog|drizzle|rain|heavy-rain|storm|snow`（可加 `&night=1`）。預覽模式不抓 API、不被真實天氣蓋掉。
- `manager.html`／`payroll.html` 沒有天氣背景；要照搬就複製天氣 CSS 區塊＋`.wx` 圖層 HTML＋天氣 IIFE 三段。
- 授權：Open-Meteo 免費層是「非商業、每日 1 萬次內」，本店用量遠低於上限但嚴格說屬商業使用；要合規可買商用方案（只換 API 網域）或改接中央氣象署——授權碼放 Apps Script 後端代轉，**絕不可寫進前端**（repo 是 public）。

## 注意事項

- `events` 只逐筆新增絕不覆蓋；`sync_roster` 不覆蓋既有 `key/device_id`。
- 開發測試**不可**對正式試算表做覆蓋性操作。
- repo 是 public：任何金鑰、授權碼、真實個資都不能進 repo。
- 改判定規則（半徑、寬限、異常口徑）前先問 Eason——這些都是他逐項定案的。
