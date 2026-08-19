---
name: mala-clock-in
description: >
  維護「麻的小辛辣」員工打卡系統（mala-clock-in repo）的專用 skill，
  重點涵蓋打卡頁 clock.html 的天氣動態背景。當使用者提到以下任何情境時，
  必須載入此 skill：改打卡頁、打卡介面調整、天氣背景（沒出現／效果不對／
  想調整）、換門市座標、調雨勢或亮度、關閉天氣效果、Open-Meteo 相關問題、
  打卡頁 debug、部署打卡頁。即使使用者只說「打卡頁背景怪怪的」「改一下
  打卡介面」，也應載入此 skill。
---

## Repo 與部署

- Repo：`Eason0728/mala-clock-in`（public）。整個系統的完整說明在 README.md，先讀它。
- 部署：GitHub Pages 直接吃 `main`，push 後約 1–2 分鐘自動生效，無需其他步驟。
  員工連結 `clock.html?k=員工key` 永遠不變。
- 本機測試：`cd mock && python3 mock_server.py`（port 8899），
  `http://localhost:8899/clock.html?k=testkey1&api=/api`。

## 天氣動態背景（2026-08-19 上線）

打卡頁背景依**光復店當下真實天氣**自動切換情境，日夜依當天實際日出日落
（氣象資料的 `is_day`）自動判斷，同仁不用選任何東西。

### 架構（全部在 clock.html，無外部檔案）

- CSS：`/* ── 天氣動態背景 ── */` 註解起的區塊。
- JS：檔尾**最後一個 `<script>`**，獨立 IIFE，與打卡邏輯完全分離，改壞不影響打卡。
- 資料源：Open-Meteo `current=weather_code,is_day`（免金鑰），座標與
  `apps-script/Code.gs` 的 `CONFIG.STORE_LAT/STORE_LNG` 同一組（光復店
  `24.7840945, 121.0157448`）。
- 快取：localStorage key `mala_wx_cache`，20 分鐘更新一次；開頁先用上次
  快取立刻顯示、再背景更新，另設 6 秒逾時——**天氣永遠不會拖慢打卡**。
- 失敗行為：抓不到天氣（沒網路／API 掛／舊瀏覽器）→ 完全不套用情境，
  維持原本紅底，這是刻意設計，不是 bug。
- 情境：body 上掛 `wx-clear/cloudy/overcast/fog/rain/storm/snow` ＋
  `wx-day/night`（晴天另有 `wx-sun`/`wx-moon`）。雨滴／雪花／星星畫在
  `#wxCanvas`，太陽／月亮／雲／色調／閃電是 CSS 圖層。
- 效能：切到背景分頁即停動畫；`prefers-reduced-motion` 時只畫靜止一幀；
  粒子數依螢幕大小計算並設上限。

### 常見調整在哪改

| 要調什麼 | 改哪裡（都在 clock.html 的天氣 JS/CSS 內） |
|---|---|
| 換門市座標 | `STORE_LAT` / `STORE_LNG` |
| 天氣更新頻率 | `CACHE_MS`（預設 20 分鐘） |
| 雨勢強弱 | `sceneOf()` 各天氣代碼的 `power`，或 `buildParts()` 密度 |
| 閃電頻率 | `scheduleFlash()`（預設 5–16 秒隨機） |
| 各天氣的底色明暗 | CSS `.wxTint` 各 `body.wx-xxx` 規則 |
| 整組關掉 | 移除天氣 IIFE 與 `.wx` 圖層 HTML 即可，其餘不動 |

### 驗收／預覽（不用等真的下雨）

網址加 `&weather=clear|cloudy|overcast|fog|drizzle|rain|heavy-rain|storm|snow`
（可再加 `&night=1` 看夜間版）。不加參數＝照真實天氣。預覽模式不會抓 API、
也不會被真實天氣蓋掉。

### 注意事項

- **背景火焰影片已於 2026-08-19 移除**（連同 `assets/fire.mp4` 的引用），
  不要再把它加回來或引用它。
- `manager.html` 與 `payroll.html` **沒有**天氣背景；若要照搬，複製 clock.html
  的天氣 CSS 區塊＋`.wx` 圖層 HTML＋檔尾天氣 IIFE 三段即可。
- Open-Meteo 免費層條款為「非商業、每日 1 萬次內」。本店用量（20 分鐘快取）
  遠低於上限，但嚴格說屬商業使用；要完全合規可買其商用方案（只換 API 網域），
  或改接中央氣象署開放資料——授權碼須放 Apps Script 後端代轉，
  **絕不可寫進前端**（repo 是 public）。
