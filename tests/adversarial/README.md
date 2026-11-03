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
