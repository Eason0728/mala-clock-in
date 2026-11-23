# 跨帳號重複出差／請假：鎖月擋（第一階段）上線清單

設計正本：`~/加盟名單平台/_brain_out/dup-trip-leave/design.md`（方案 A）。主管 2026-11-23 定案：鎖月只擋會讓薪資重複的 ①②③、做到哪＝B 的第一階段（鎖月擋＋提醒＋行政群每日清單）、行政群只列員工代號。
本檔只列步驟，**不含任何執行紀錄**；誰按 `--go` 由大腦決定。

## 動到什麼

| 東西 | 要不要換 | 說明 |
|---|---|---|
| 光復打卡專案 `薪資.js`（＝`apps-script/Payroll.gs`） | **要換** | 薪資後端與薪資試算表只有光復一套（mala-payroll skill）。只換 `薪資.js`，其他檔（`程式碼.js`、`Requests.js`…）不動 |
| 其他八店的 Apps Script | **不用換** | 八店沒有薪資檔；這次沒改 `Code.gs`、`Requests.gs`、`AttDigest.gs` |
| `payroll.html`（GitHub Pages） | 合併就發布 | 只多「提醒區列出重複」與鎖定被擋跳對話框。新畫面＋舊後端＝什麼都不顯示；舊畫面＋新後端＝被擋時用一行提示顯示同一段訊息。兩種先後都安全 |
| mala-store-ops（行政群每日清單） | 另一個 PR | 跟這邊沒有先後依賴；那邊要等主線「連續核定」回歸解鎖才能上 |

## 步驟（照 `~/加盟名單平台/_brain_out/pay212-deploy/` 的上線包形狀做一份 `dupx-deploy`）

1. **主管先看「待預覽文字」**（PR 說明有完整清單；design.md 沒有草稿的句子都在那裡）。改字＝改 `Payroll.gs` 的 `payDupXacctLine_`／`PAY_DUP_XACCT_MSG_`／finalize 那段、`payroll.html` 兩行，跑 `node tests/dup-xacct.test.js` 更新期望值。
2. **跟另外三個 PR 的先後**：#217（檔尾新增＋handler 表兩行）、#223（`payRestOverList_` 約 5633–5680 行）、#224（`payOtFormCheck_`、`payOtFormsMonth_`、`payroll.html` 1714 行）跟本 PR 沒有改到同一段，誰先合都行；後合的要 rebase 到新主線、重跑 `node tests/run-all.js`。上線包要比「主線上的 `Payroll.gs` sha1＝要推的版本」。
3. 合併本 PR → Pages 自動發布 `payroll.html`。
4. 上線包「只檢查」：clasp pull 光復專案、比對服務中 `薪資.js`＝上一版（目前 @324，以當時服務中為準）、其他檔原樣；用乾淨 worktree 跑 `node tests/run-all.js`（期望全部通過、`dup-xacct.test.js` 0 失敗）。
5. 時段：避開 05:30–07:10（06:00 `payAsOfDaily` 重算草稿）、08:30–09:20（09:00 `payRestOverDaily`）；不要在會計按「鎖定本月」時換。
6. `--go`：`clasp push`（只換 `薪資.js`）→ `clasp version` → **`clasp redeploy <光復部署 ID> -V <新版本>`**（不用 `clasp deploy`）。預設帳號（madesiaosinla）。redeploy 後約 1 分鐘才生效。
7. 上線後驗證（不寫任何東西也能看）：
   - 管理系統薪資頁打開 DZY010 的計薪門市（HQ 或 MZTHQ，未確認是哪一家，兩家都看），11 月按「重新計算」：提醒區應出現紅字「…11/5 DZY010 出差：…（HQ-03）整天 8 小時＋…（MZTGF01）整天 8 小時——處理前不能鎖定」（若墨竹亭光復那張已作廢則不會出現）。
   - 11 月還沒過完時按鎖定會先被「還沒過完」擋（`month_not_over`），**鎖月擋要 12/1 之後才看得到**。12/1 起如果 DZY010 那張還沒作廢，按鎖定應跳「不能鎖定：下面的同仁同一天在兩個打卡帳號…」。
   - 其他門市 11 月重算：沒有重複的人提醒區不會多任何一行（11 月實掃只有 DZY010 一筆）。
8. 收尾：mala-payroll skill 補一節（開關、擋的三種、退回方式），mala-gas commit＋push。

## 「檢查沒做完」會擋整家店（`dup_xacct_check_failed`）
- **什麼時候會出現**（2026-11-23 驗收第 1、2 項修完後的範圍）：
  1. 薪資試算表的打卡對照分頁（`payroll_xmap`）讀不到 → **所有計薪門市**當次計算都標「檢查沒做完」，全部鎖不了；
  2. 這家計薪門市任何一位同仁（用本店打卡表帳號認人，**不管對照表上寫的計薪店是哪家**）任何一個已確認帳號所在門市的申請分頁讀不到 → **這家計薪門市所有人**都標，整家鎖不了。總部（HQ／MZTHQ／SSLHQ）同仁的支援帳號最多、最容易遇到。
- 只擋鎖定，不影響計算出來的金額、草稿、同仁打卡與主管核定。
- **會計遇到時**：先按一次「重新計算」再鎖（多半是那一刻開試算表逾時）。重算後還是擋 → 找資訊部查那家店門市表的打卡試算表 ID／權限（執行紀錄會記 `dup_xacct in calc: …` 與打不開的店）。急著發薪又查不出來 → 資訊部用下面「退回」關掉這個檢查。

## 已知限制
- 只比「同一天」的單（申請單的日期欄）；跨夜單（例 11/5 22:00–02:00）不會跟隔天 11/6 那天的單比。
- 只看申請分頁；主管沒等單、直接核定成出差的（沒有申請單）看不到。
- 認人口徑跟跨店支援自動帶入共用同一支（`payXsupPayRows_`＋`payXsupConfirmed_`）：state 空白算 confirmed、大小寫不同不算——引擎帶入時數的帳號重複檢查一定認得。
- 支援時數「有沒有進這次計薪」看引擎結果，兩條路都算：跨店支援自動帶入（`XSUP.byEmp[工號].stores`）、總部 Mirror（央廚核定抄進本店打卡表，payCollect 照算）。
- **手填的跨店支援時數**（薪資頁「跨店支援」欄，只有門市、時數，沒有日期與帳號）對不回是哪個帳號哪一天：現況重複檢查看不出來，① 只提醒、可鎖。**待主管定**（例：手填了同一家店的支援時數就當那家店帳號的時數進計薪 → 擋）。
- ② 現行：計薪店請假＋另一帳號出差，不論出差帳號時數進不進計薪都擋（`PAY_DUP_R2_ANY_TRIP_ = true`，待主管確認；改成跨單位只提醒＝把它改 `false`，mala-store-ops `server/dup-xacct.js` 的 `R2_ANY_TRIP` 一起改）。

## 行政群清單與薪資鎖月可能講不一樣（可以接受：清單是提醒，鎖月才是把關）
| 情況 | 薪資鎖月 | 行政群清單 |
|---|---|---|
| 對照表 `pay_store` 跟主檔計薪門市不一致（引擎沒帶入支援時數） | ① 只提醒、可鎖 | 依 pay_store 判斷，可能寫「請作廢一張」 |
| 支援帳號標 `not_support`／打卡店主檔也有他（dup_pay） | 引擎沒帶入 → ① 只提醒（Mirror 帶入的除外） | mini 看不到這兩個標記 → 寫「請作廢一張」 |
| 對照 `state` 空白 | 跟引擎一樣當已確認 → 會擋 | 打卡端只送 confirmed → 不列 |

## 退回

- **最快**：`clasp redeploy <光復部署 ID> -V <上一版號>`（不改程式，約 1 分鐘生效）。已經存了 `ot_info.dup_xacct` 的草稿在舊版不會被讀到，不影響鎖定；舊版鎖定前重算比對也不看這個欄位。
- **只關掉這個檢查、保留同一版其他改動**：把 `Payroll.gs` 的 `PAY_DUP_XACCT_FROM` 改成 `'9999-12'`、走同一套上線包換版。關掉後計算、鎖定跟改版前逐位元組相同（`tests/dup-xacct.test.js` 第 ④ 段）。
- 注意：`PAY_DUP_XACCT_FROM` 填錯（不是 `YYYY-MM`）**不會**關掉，會照 2026-11 維持擋（保護性檢查）。

## 第二階段（主管核准時擋，12/1 鎖月之後另派）可以直接用的

- `Payroll.gs`：`payDupOverlap_`（時段重疊，B29）、`payDupXacctCore_(accts, {statuses:['approved','pending']})`（回 `approved:false` 就是「另一邊還在審」，給「提醒＋仍要核准」用）。
- mala-store-ops `server/dup-xacct.js`：同一套的 node 版（`overlap`、`findDups`），加上讀 clock.db g_requests 的 `clockReader`、xmap 認人。`server/proxy/duty.js` 的 mgr_req_decide／_batch／_proxy 直接 `require` 它。
- 兩邊共用案例檔 `fixtures/dup-xacct-cases-v1.json`（兩份必須逐字相同）；第二階段加案例要兩邊一起加。
