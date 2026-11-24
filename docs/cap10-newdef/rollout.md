# 滿 10 小時新定義＋15 分鐘緩衝：上線包需求清單（PR #223；只寫清單，未執行）

來源：分支 `feat/cap10-newdef`（60d1338 新定義、da9d510 驗收擋項、緩衝 A＋改字、Codex 第一輪：假單時段格式、系統卡同段去重 `RelayG.gs`、央廚／總部固定休息表 `Cap10.gs`）。設計正本 `~/加盟名單平台/_brain_out/cap10-newdef/design.md`、`buffer15.md`。
做包的人照 `~/dzy-mini-playbook/docs/clock-to-mini/p6lw`／`p7ad` 的骨架（三方比對、鎖、runs、退回、驗證、redeploy 慢一拍重試）。

## 1. 要換的檔
九店換 `Cap10.js`＋`Rest.js`＋`RelayG.js`，光復另換 `薪資.js`。

| 雲端檔 | 店 | 新版來源 | 上線前的現行版本（2026-11-23 晚核：`~/dev/mala-gas` d098c8d 九店逐檔 sha1 前綴；`Cap10`／`Rest`／`RelayG`＝main 6593423＝main 1a982a3 的同名檔） |
|---|---|---|---|
| `Cap10.js` | 九店 | 合併後 main 的 `apps-script/Cap10.gs` | f581dbb2（九店相同） |
| `Rest.js` | 九店 | 合併後 main 的 `apps-script/Rest.gs` | 12cb7762（九店相同） |
| `RelayG.js` | 九店 | 合併後 main 的 `apps-script/RelayG.gs` | 02ab5227（九店相同；上次上線 mala-gas 42839eb p5rg） |
| `薪資.js` | 只有光復 gf | 合併後 main 的 `apps-script/Payroll.gs`（rebase 到含 #226 的主線之後） | 54ab4f59a3c1（＝@326，#226 上線，來源 78814bb；＝main 1a982a3 的 Payroll.gs） |

- 雜湊怎麼取（做包當下要重取，不要抄這張表）：
  - 現行：`for d in mala-clock-in mztjs-clock-in mztgf-clock-in mztlzl-clock-in mztmc-clock-in mztrg-clock-in mztwx-clock-in hq-clock-in cf-clock-in; do shasum ~/dev/mala-gas/$d/<檔> | cut -c1-8; done`（`薪資.js` 只有 mala-clock-in）；再用做包腳本拉回各店部署指向的版本核一次雲端＝mala-gas。
  - 新版：`git -C ~/dev/mala-clock-in show <合併後 main 的 commit>:apps-script/<Cap10|Rest|RelayG|Payroll>.gs | shasum | cut -c1-8`；換完拉回的雲端檔要等於這個值。
- **央廚、總部固定休息表**（`Cap10.gs` 的 `CAP_PEER_BRK_`，跟兩店 `程式碼.js` 的 `NO_PUNCH_BREAK_START／END` 是兩份）：做包前跑下面這行，兩行都要是「相同」，有「不同」就停（只比時段值，不印其他設定）：
  ```
  node -e 'const fs=require("fs"),h=require("os").homedir();const T=Function("return "+/var CAP_PEER_BRK_ = (\{[^\n]*\});/.exec(fs.readFileSync(process.argv[1],"utf8"))[1])();for(const [c,d] of [["cf","cf-clock-in"],["hq","hq-clock-in"]]){const s=fs.readFileSync(h+"/dev/mala-gas/"+d+"/程式碼.js","utf8"),g=(k)=>(new RegExp("NO_PUNCH_BREAK_"+k+"\\s*:\\s*[\x27\x22]([0-9:]*)[\x27\x22]").exec(s)||[])[1];console.log(c,g("START")===T[c].s&&g("END")===T[c].e?"相同":"不同（停）")}' ~/dev/mala-clock-in/apps-script/Cap10.gs
  ```
  （2026-11-23 跑過：cf 相同、hq 相同；把表上 hq 改成 13:00 會印「不同（停）」。）跨店代碼 `cf`／`hq` 要跟 `RestConfig.js` 的 `REST_PEERS_` 一樣（九店 RestConfig 現況都是這兩個代碼）。

- **不換 `程式碼.js`**，但 Cap10 現在呼叫 `程式碼.js` 的 `approvedHoursOfShift`、`tsMs`：包要每店核「服務中 `程式碼.js` 有這兩支、內容＝main」（mala-gas 九店 `approvedHoursOfShift` 本體 sha1 前 10 碼都是 1f3b0dc726）。沒有就停（Cap10 會丟錯→整個收卡判斷變成不擋不寫）。
- `薪資.js` 也被 #217、#224、#226 改（不同段，見第 6 節）。#226 已在 2026-11-23 下午上線（@326），服務中基準現在是那一版；#217、#224 誰先上線，基準就再變成那一版；這包要用合併後 main 整檔，三方比對只准 #223 那幾段跟基準不同（rebase 到 473c6cb 後量：通知匣註解 5884 行、09:00 通知檔頭與 `payRestOverList_`／`payDayLoadOver_`／`handlePayrollRestCheck` 5917–5973、`payRestOverRun_`～`payRestOverText_` 5998–6013；`git diff origin/main HEAD -- apps-script/Payroll.gs` 三段 hunk）。
- 沒有新分頁、新屬性、新觸發器、新對外連線；`appsscript.json` 用服務中那份。

## 2. 時段與順序
1. 時段：**02:00–03:15**（設計 §7.1；01–07 點每整點只剩 7–8 段還在上班，多半是忘打下班）。這時段不在 p 系列腳本預設允許時段（14–17、22–24）→ 要 `--force-time`，照往例先取得 Eason 同意。禁止 03:20–04:50、08:50–11:00、20:00–22:00。
2. 換之前唯讀看一次「現在還在上班的人」（`gen/nightopen.js` 的寫法）；有人就延後或那店最後換。
3. 店序：mztjs → gf（多換 `薪資.js`）→ 其他七店。每店：只檢查 → `--go` → 拉回逐檔比對。
   - 同一家店的 `Cap10.js`、`Rest.js`、`RelayG.js`（gf 加 `薪資.js`）放在**同一次部署版本**一起換（店內不會有新舊混搭）。店與店之間沒有先後講究：新 `RelayG.js` 配舊 `Cap10.js`（還沒換到的店、或還沒重啟的快速通道）也只會留一張系統卡（2026-11-23 混搭試跑：兩邊都舊規則 1 張、Google 新＋mini 舊 1 張）。
4. 九店做完：新檔 commit 進 `~/dev/mala-gas`（main、乾淨）→ push。
5. **03:20 前**重啟快速通道：`~/dzy-minikit/kit/bin/update-all.sh --restart clock-relay --dry-run` → 拿掉 `--dry-run`；跑完另開指令確認 `/clock/g-health` green、九店 `Cap10.js`／`Rest.js` 載入指紋＝mala-gas。
   - `RelayG.js` 不用額外步驟，但一定要先做完第 4 步：重啟前檢查（`ops/g-ops.js` restart-pre）比「雲端服務中＝mala-gas」用的是核定引擎那份 18 檔清單（`engine.js` `DUTY_FILES`，含 `RelayG.js`），mala-gas 沒 commit 新 `RelayG.js` 會被擋下；重啟後驗證另比核定引擎（`G_DUTY_ENGINE=1`）載入的 18 檔＝mala-gas。打卡引擎（`g-health` 的 files）不載入 `RelayG.js`。
   - 快速通道**不用改程式**（覆核過）：`server/lib/engine.js:11` 打卡引擎載入 `程式碼.js、Liff.js、Rest.js、RestConfig.js、Cap10.js`，`approvedHoursOfShift` 在 `程式碼.js`，引擎裡就有；mala-clock-relay `server` 測試以本分支跑 213 過／3 敗，與 origin/main 完全相同（3 敗是 predict.test.js 既有的測試環境問題）。
6. `REST_CAP_ON` 不用動（九店都是 '1'）；主管已決定不發門市通知。

## 3. 同一段上班幾張系統卡（換完之後；快速通道重啟前後都一樣）
mini 看不到假單，「因假單才滿 10」只有 Google 算得出來，所以 Google 與 mini 可能算出不同的收卡時間（例 Google 18:45、mini 19:00）。修正後的保證：
- **Google 先寫**（掃描或開頁，因假單 18:45）、mini 還沒拉回又照打卡寫 19:00（按下班 `Liff.gs:680` 或開打卡頁 `primary.js:660`）→ 抄回 Google 時 `relay_append` 看到同一段上班（最後一張上班卡之後）已有系統卡，回「重複」＋18:45 那張、不寫；mini 收到後把自己那列改成 18:45（g_log 記 conflict），下次拉回（≤30 秒）擋卡引擎也換成 18:45。結果兩邊都只有 18:45 一張、不會有孤單的 19:00（2026-11-23 用真快速通道程式＋假 Google 兩條入口實跑）。這 ≤30 秒內 mini 回手機的字是「19:00 幫你記了」、mini 擋卡表暫時是 19:00。
- **mini 先寫**（只看打卡 19:00）、Google 之後才因假單算出 18:45 → `capWrite_` 看到這段已有系統卡就不寫，留 19:00。會這樣只有在 Google 第一次寫之前 mini 就先到點：Google 每 15 分鐘掃一次，所以最多比規則晚約 15 分鐘（加觸發器延遲）。
- 舊規則與新規則混著跑（換到一半、快速通道還沒重啟）同上，只會一張——**前提是同一家店的 `Cap10.js`、`Rest.js`、`RelayG.js` 在同一次部署版本一起換**：舊 `RelayG.js`（只比 ±60 秒）配新 `Cap10.js`（會因假單算出不同時間）正是 Codex 第一輪擋項一，同段會留 2 張系統卡（2026-11-23 用 6d2ffb1 重現過）。新 `RelayG.js` 配舊 `Cap10.js` 則沒問題（混搭實測 1 張）。
- **剩下的已知空窗（主管已接受、這次沒變）**：Google 因假單收卡後約 30 秒內、mini 還沒拉回，同仁在 mini 按下班而 mini 只看打卡**還沒**滿 10 → mini 照常寫一張**本人**下班卡（不是系統卡，`relay_append` 這次的去重只管系統卡）。
- 夜間換版＝實際影響 0。

## 4. 每店驗證
1. 部署指向的版本拉回逐檔比：`Cap10.js`、`Rest.js`、`RelayG.js`（gf 加 `薪資.js`）＝新、其他檔＝換前版本（redeploy 後每 25 秒問一次、最多約 5 分鐘）。
2. 唯讀探針：錯金鑰打 `cap_set` → `unauthorized`（只證明 Cap10 有載入，分不出新舊；沒有安全的唯讀行為記號，以第 1 點為準）。
3. 重啟後：`g-status` 指紋＝mala-gas；`/store/health` 200（例行）。
4. 隔天（不在上線包裡、大腦另查）：新寫的系統卡時間都在 :00／:15／:30／:45；09:00 通知匣（有人才會發）標題是「M/D 當日出勤滿 10 小時：N 人」。

## 5. 退回
| 狀況 | 做法 | 退到哪 |
|---|---|---|
| 緊急：收卡出問題 | `python3 ~/dev/mala-clock-in/deploy-local/cap10/cap_call.py off [店…]`（刪 `REST_CAP_ON`＋`capSweep` 觸發器；`RELAYG_PROPS_` 有帶這個屬性，mini 下次拉回也跟著關） | **完全不收卡、不擋上班卡**（不是退回舊規則）；打卡頁提醒回到改版前的原始打卡加總與舊字。已寫的系統卡不會消失。 |
| 要回舊規則 | 九店部署切回上線前的版本（rollback 腳本只切部署版本，不從本機推）：`Cap10.js` f581dbb2、`Rest.js` 12cb7762、`RelayG.js` 02ab5227（gf 的 `薪資.js` 見下一列）＋mala-gas 退回上線前那個 commit（2026-11-23 晚是 d098c8d；上線當天以換檔前的 HEAD 為準、寫進 runs）＋`update-all.sh --restart clock-relay` | 舊規則（扣班表休息、原始秒數、不看假單、系統卡只比 ±60 秒） |
| 09:00 通知字／門檻 | **`cap_call.py off` 退不回**（09:00 不看 `REST_CAP_ON`）。光復 `薪資.js` 換回上線前版本（2026-11-23 晚＝@326、54ab4f59a3c1；#217／#224 若先上線就是那一版——以上線當下的服務中版本為準） | 舊字「核定超過 10 小時」、舊門檻（各店核定 > 10、同名只列一次） |
- 沒有改資料格式、沒有新分頁或屬性；退回不用清資料。
- **`RelayG.js` 的同段系統卡去重不受 `REST_CAP_ON` 控制**（2026-11-23 大腦定，Codex 第二輪）：`cap_call.py off` 只關收卡，不關去重。原因：Google 先關、mini 要到下一次拉回（正本店每次拉回都帶屬性，預設每 30 秒；Google 連不上時會更久）才跟著關，這段期間 mini 還可能寫系統卡、或有寫好還沒抄回的系統卡。若照舊寫入，同一段上班會有兩張系統卡，後到那張變成孤單下班卡（核定頁標「上班忘刷卡」、參考時數留白、薪資記一次忘刷）——正是這次要修的傷害。去重只擋「同一段上班已有系統卡」的那張；一段上班本來就只該有一張系統卡（收卡後 11 小時鎖住），所以擋掉的不會是該留的卡。開關關著一段時間後兩邊都不再產生系統卡，這段程式走不到。**要完全回到舊行為（只比單號與 ±60 秒）得換回舊 `RelayG.js`（02ab5227）**，見上表「要回舊規則」。

## 6. 與其他 PR（2026-11-23 晚對 GitHub 最新狀態核）
- **上線包製作時以當時的主線為準、要先 rebase**：2026-11-23 晚已 rebase 到主線 473c6cb（含 #226 跨帳號重複、#228 只改測試基準），`Payroll.gs` 自動合併無衝突、#223 對它的增刪行跟 rebase 前完全相同；`Cap10.gs`、`Rest.gs`、`RelayG.gs` 主線沒動、內容跟 rebase 前同一雜湊。之後主線若再動這四個檔，要再 rebase、重跑測試、重取第 1 節的新版雜湊。
- 現況（2026-11-23 晚，對 GitHub 核）：還開著的 #217、#219、#220、#224 跟 rebase 後的本分支 `git merge-tree` 都無衝突；rebase 後 `node tests/run-all.js` 266 個測試檔全過（主線 264＋本 PR 新增 2），沒有已知失敗。
- `Payroll.gs` 行段：#223 只動 09:00 通知（見第 1 節行號）；#217 動 `handlePayroll…` 一帶與檔尾新增（其分支行號約 6844、6998、7812 之後）、#224 動加班表單一帶（約 1571、1634、4337）——都跟 09:00 通知段不重疊（行號是各自分支基準，合併時以 git 為準）。
- 本 PR 不改任何 `.html`（`clock-line.html` 的字不用改，理由見 PR 說明）→ 合併到 main 不會改到發布的畫面。
