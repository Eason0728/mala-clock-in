# 給 Claude 的工作規則

- **一律使用繁體中文回覆**，包含程式工作中的說明、進度與總結；程式碼、指令、檔名維持原文。對話再長、中間穿插再多英文的工具輸出，也不要改用英文。
- 說明寫給門市營運主管看：講現場會發生什麼事，不用管理或工程術語。

## 後端部署（鼎兆元打卡，7 家門市的 Apps Script）

1. `python3 tools/deploy-to-clasp.py`（先看）→ 加 `--apply`（寫入 ~/mala-gas）→ `python3 tools/verify-store-backends.py`（每家都要 ✓）
2. `tools/redeploy-store.sh mala-clock-in`（光復先做、測過）→ `tools/redeploy-store.sh --others`
3. `tools/redeploy-store.sh --check`（每家回 `invalid_key` 才算正常）

使用者的 Mac 是 zsh：給指令時不要依賴未加引號的變數拆字（例如 `$F`），要用陣列 `"${F[@]}"`。
