# 滿 10 小時新定義＋15 分鐘緩衝：上線包需求清單（PR #223；只寫清單，未執行）

來源：分支 `feat/cap10-newdef`（60d1338 新定義、da9d510 驗收擋項、本輪緩衝 A＋改字）。設計正本 `~/加盟名單平台/_brain_out/cap10-newdef/design.md`、`buffer15.md`。
做包的人照 `~/dzy-mini-playbook/docs/clock-to-mini/p6lw`／`p7ad` 的骨架（三方比對、鎖、runs、退回、驗證、redeploy 慢一拍重試）。

## 1. 要換的檔
| 雲端檔 | 店 | 新版來源 | 服務中基準（2026-11-23 以 `~/dev/mala-gas` f67d56a 比對；上線當下要再核雲端） |
|---|---|---|---|
| `Cap10.js` | 九店 | 合併後 main 的 `apps-script/Cap10.gs` | ＝origin/main 6593423 的 Cap10.gs（sha1 前 8 碼 f581dbb2，九店相同） |
| `Rest.js` | 九店 | 合併後 main 的 `apps-script/Rest.gs` | ＝origin/main Rest.gs（12cb7762，九店相同） |
| `薪資.js` | 只有光復 gf | 合併後 main 的 `apps-script/Payroll.gs` | ＝origin/main Payroll.gs（76049aab）＝@324（來源 215a983） |

- **不換 `程式碼.js`**，但 Cap10 現在呼叫 `程式碼.js` 的 `approvedHoursOfShift`、`tsMs`：包要每店核「服務中 `程式碼.js` 有這兩支、內容＝main」（mala-gas 九店 `approvedHoursOfShift` 本體 sha1 前 10 碼都是 1f3b0dc726）。沒有就停（Cap10 會丟錯→整個收卡判斷變成不擋不寫）。
- `薪資.js` 也被 #217、#224、#226 改（不同段，見第 6 節）。誰先上線，`薪資.js` 的「服務中基準」就變成那一版；這包要用合併後 main 整檔，三方比對只准 #223 那幾段（`payRestOverList_`～`payRestOverText_`，約 5597–5727 行）跟基準不同。
- 沒有新分頁、新屬性、新觸發器、新對外連線；`appsscript.json` 用服務中那份。

## 2. 時段與順序
1. 時段：**02:00–03:15**（設計 §7.1；01–07 點每整點只剩 7–8 段還在上班，多半是忘打下班）。這時段不在 p 系列腳本預設允許時段（14–17、22–24）→ 要 `--force-time`，照往例先取得 Eason 同意。禁止 03:20–04:50、08:50–11:00、20:00–22:00。
2. 換之前唯讀看一次「現在還在上班的人」（`gen/nightopen.js` 的寫法）；有人就延後或那店最後換。
3. 店序：mztjs → gf（多換 `薪資.js`）→ 其他七店。每店：只檢查 → `--go` → 拉回逐檔比對。
4. 九店做完：新檔 commit 進 `~/dev/mala-gas`（main、乾淨）→ push。
5. **03:20 前**重啟快速通道：`~/dzy-minikit/kit/bin/update-all.sh --restart clock-relay --dry-run` → 拿掉 `--dry-run`；跑完另開指令確認 `/clock/g-health` green、九店 `Cap10.js`／`Rest.js` 載入指紋＝mala-gas。
   - 快速通道**不用改程式**（覆核過）：`server/lib/engine.js:11` 打卡引擎載入 `程式碼.js、Liff.js、Rest.js、RestConfig.js、Cap10.js`，`approvedHoursOfShift` 在 `程式碼.js`，引擎裡就有；mala-clock-relay `server` 測試以本分支跑 213 過／3 敗，與 origin/main 完全相同（3 敗是 predict.test.js 既有的測試環境問題）。
6. `REST_CAP_ON` 不用動（九店都是 '1'）；主管已決定不發門市通知。

## 3. 換完、快速通道還沒重啟那段（≤ 幾分鐘）
Google 新規則（取整、不扣班表休息、加有時段的假）、mini 舊規則（原始秒數、扣班表休息）。兩邊可能各自先到點：
- mini 先到點寫系統卡 → Google 之後看到「這段上班已有系統卡」照那張鎖（capWrite_ 同段去重，W3）；
- Google 先寫 → mini 30 秒內拉回、照那張鎖。
同一段只會一張系統卡；時間以先寫的那邊為準。夜間換版＝實際影響 0。

## 4. 每店驗證
1. 部署指向的版本拉回逐檔比：`Cap10.js`、`Rest.js`（gf 加 `薪資.js`）＝新、其他檔＝換前版本（redeploy 後每 25 秒問一次、最多約 5 分鐘）。
2. 唯讀探針：錯金鑰打 `cap_set` → `unauthorized`（只證明 Cap10 有載入，分不出新舊；沒有安全的唯讀行為記號，以第 1 點為準）。
3. 重啟後：`g-status` 指紋＝mala-gas；`/store/health` 200（例行）。
4. 隔天（不在上線包裡、大腦另查）：新寫的系統卡時間都在 :00／:15／:30／:45；09:00 通知匣（有人才會發）標題是「M/D 當日出勤滿 10 小時：N 人」。

## 5. 退回
| 狀況 | 做法 | 退到哪 |
|---|---|---|
| 緊急：收卡出問題 | `python3 ~/dev/mala-clock-in/deploy-local/cap10/cap_call.py off [店…]`（刪 `REST_CAP_ON`＋`capSweep` 觸發器；`RELAYG_PROPS_` 有帶這個屬性，mini 下次拉回也跟著關） | **完全不收卡、不擋上班卡**（不是退回舊規則）；打卡頁提醒回到改版前的原始打卡加總與舊字。已寫的系統卡不會消失。 |
| 要回舊規則 | 九店 `Cap10.js`、`Rest.js` 換回上線前版本（rollback 腳本只切部署版本，不從本機推）＋mala-gas 退回那個 commit＋`update-all.sh --restart clock-relay` | 舊規則（扣班表休息、原始秒數、不看假單） |
| 09:00 通知字／門檻 | **`cap_call.py off` 退不回**（09:00 不看 `REST_CAP_ON`）。光復 `薪資.js` 換回上線前版本 | 舊字「核定超過 10 小時」、舊門檻（各店核定 > 10、同名只列一次） |
- 沒有改資料格式、沒有新分頁或屬性；退回不用清資料。

## 6. 與其他 PR（2026-11-23 對 GitHub 最新狀態核）
- origin/main 自分支起點 6593423 之後沒有新 commit；`git merge-tree` 對 #216、#217、#218、#221、#222、#224、#225、#226、#227 兩兩都無衝突。
- 依序合併 main＋#216＋#222＋#218＋#221＋#225＋#217＋#224＋#227＋#223：無衝突（#226 跟 #221／#225／#227 在 `payroll.html` 衝突，與本 PR 無關）；合併後 `node tests/run-all.js` 266/267，唯一失敗 `pay-rw-mutex.test.js`（#225 帶來，拿掉 #223 也一樣失敗）。
- `Payroll.gs` 行段（origin/main 行號）：#223 改 5597、5630–5727（09:00 通知）；#217 改 6846、7000、7814 之後；#224 改 1574、1636–1642、4340；#226 改 893、3312–3370、4458、4683–5136。互不重疊。
- 本 PR 不改任何 `.html`（`clock-line.html` 的字不用改，理由見 PR 說明）→ 合併到 main 不會改到發布的畫面。
