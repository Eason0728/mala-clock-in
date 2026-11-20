# 考勤副本門鈴（DutyFeed.gs 推送）

打卡端每做完一筆寫入，順手通知 Mac mini 營運系統「哪家店、什麼動作、哪幾天」，mini 再回頭用 `duty_changes` 拿變動，主管看考勤不用等 30 秒輪詢。
設計：`dzy-mini-playbook docs/clock-to-mini/phase1-design.md` 2.3–2.8；mini 收門鈴端：mala-store-ops `server/duty-push.js`。

## 三種模式（指令碼屬性）

| 模式 | 屬性 | 打卡時多做什麼 |
|---|---|---|
| 關（預設） | `DUTY_PUSH_URL` 沒設或空白 | 只多讀 1 個屬性 |
| 只計數 | `DUTY_PUSH_URL`＋`DUTY_PUSH_DRY=1` | 多讀 2 個屬性＋暫存區讀寫 1 次（記「本來會推幾次」），不連外 |
| 正式推送 | `DUTY_PUSH_URL`＋`DUTY_PUSH_DRY=0`＋`DUTY_PUSH_KEY`＋`DUTY_PUSH_STORE`（選填 `DUTY_PUSH_TUNE`） | 讀屬性 3 次（網址、旗標、一次 `getProperties()`）、`SpreadsheetApp.flush()`、連外一次（最多等 3 秒）、暫存區寫 2–3 次 |

開關不用進編輯器：mini 用 `duty_changes` 帶 `push_cfg:{url_on, dry}`（主管金鑰＋管理金鑰），網址寫死在程式裡；沒有金鑰與店代碼時最多開到只計數。金鑰用 `push_setup:{key, store}` 一次寫入（已設過回 `already_set`）。

## 寫入絕不能因門鈴變慢（2026-11-20 開真推送前補強）

1. 先寫暫存區、再按門鈴；整段 try/catch，門鈴出什麼事都不影響打卡回應。
2. `timeoutSeconds:3`（官方 UrlFetchApp 參考文件有列、預設 360 秒；**實際生效與否要在第一家店實測**）、`muteHttpExceptions`、不跟轉址。
3. 失敗（非 2xx、不是 JSON、例外）→ 停推 60 秒；mini 回 `off:true` → 停 1 小時。
4. **回應慢也熔斷**：一次 ≥2 秒、或連外丟出逾時例外 → 停 10 分鐘（2026-11-20 實測 timeoutSeconds:3 約 2.44 秒就逾時，原本 2.5 秒碰不到）；連續 3 次 ≥1.5 秒 → 停 10 分鐘；快又成功一次才歸零。
   因慢停推後**不拿同仁打卡當探針**：停推期滿，一般寫入仍不推（記 skip_off、`slow.need_ping:true`），要等 mini 帶來的 ping（不在推送模式時每 20 分鐘）又快又成功才恢復；那次 ping 還是慢＝再停 10 分鐘（半開）。mini 持續卡住時同仁只有第一筆多等（測試：持續卡 3 秒、每 10 秒一筆、每 20 分鐘 ping、2 小時 → 寫入只連外 1 次、合計多等 3 秒）。mini 都不 ping 時，慢計數快取 6 小時後過期才會再用寫入試一次。
5. **按門鈴前先 flush**：mini 收到門鈴會馬上回頭讀，所以真的要連外（不是 ping）之前先 `SpreadsheetApp.flush()` 讓這次寫入落地。關、只計數、熔斷中、上限滿都不 flush。flush 丟錯＝這一筆不按門鈴（打卡回應不變），記 `push_stats.flush_err`。
   停推只延長不縮短（寫入前重讀，別的同時執行寫了更晚的就不蓋；快取存 6 小時、看 until）；慢計數在連外之後重讀再改，同時的快速失敗不會清掉別人的慢計數或等 ping 狀態。
6. **每店每天上限 800 次**（原 1,500）：計數在 CacheService、不是原子，最壞約兩倍；九店 9×800×2＝14,400＝帳號每天 2 萬次連外的 72%（≤80%）。設計估九店合計一天約 500–800 次。
7. ping（mini 每小時帶 nonce 請打卡端按一下）另有每店每天 40 次上限；也算進每日上限。

調門檻：指令碼屬性 `DUTY_PUSH_TUNE`（JSON，只在正式推送讀；格式錯或超出範圍的欄位用預設）
`{"slow_ms":1500,"slow_n":3,"hard_ms":2000,"slow_off_s":600,"cap":800}`；範圍 slow_ms 300–10000、slow_n 1–10、hard_ms 500–30000（不低於 slow_ms）、slow_off_s 60–21600、cap 0–1500。

## 看狀況

`duty_changes` 帶 `push_stats:true` → `push`：
- 關：`{on:false}`。
- 只計數：`mode:'dry'`、`dry`（本來會推幾次）、`cap`、`skip_*`。
- 正式推送：另有 `sent ok fail remote_off`、`p50ms p95ms max_ms`（連外耗時，最近 100 次）、`off:{why:'fail'|'slow'|'remote', until}`、
  `slow:{n, need_ping, trips, slow_ms, slow_n, hard_ms, off_s}`（n＝目前連續慢幾次、need_ping＝因慢停推、等 ping 復原、trips＝今天因慢停推幾次）、`flush_samples flush_p50ms flush_max_ms`（按門鈴前 flush 花多久，最近 20 次）、`flush_err`（今天 flush 失敗、沒按門鈴幾次）。
- 計數存 CacheService 6 小時、只看得到「今天」：要一天的量請每小時收（mala-clock-mini `push-stats-hourly.js`）。

## 測試
`node tests/duty-push.test.js`、`node tests/duty-push-live.test.js`（關／只計數跟九店線上版逐次相同的證明在後者第 1 節）。
