# 任務清單：跨店支援時數自動帶入

| # | 任務 | 檔案 | 輸入 → 輸出 | 驗收 |
|---|---|---|---|---|
| T1 | 平台 payrollXmap | dzy StaffClock.gs、Code.gs、dryrun.js | token(payroll.write) → rows[{emp_no,pay_store,acct_store,emp_id,not_support}] | 新測試：confirmed 才出、rejected 不出、例外帳號 not_support、非 admin 只回負責門市 |
| T2 | bridge 改道＋minikit 同步 | dzy modules/payroll/bridge.js；minikit gas＋app.json | payroll_dzy_xmap → 平台 | payroll-module.test 補一條；minikit SOURCE.sha256 正確 |
| T3 | schema＋xmap 讀寫 | Payroll.gs | payroll_xmap_set{rows} → 覆寫（scope 只換自己的）；get 回 rows＋synced_at | set→get 逐欄相同；scope 下動不到別店列 |
| T4 | paySupportAuto_ | Payroll.gs（payR0～Handlers 標記之間） | (ym,home) → stores／cross／pending | 同組／跨組／*／空白組／共用打卡表／not_support／ym<2026-11=null |
| T5 | payMergeSupport_＋接進 handlePayrollCalc／Month | Payroll.gs | att.support＋auto → 新 support＋diffs | 手填同／異／keep／auto_h 變動／0 小時移除／前端送 auto 列被丟 |
| T6 | 存檔剔除 auto＋防呆 dup_pay／cross_no_master | Payroll.gs | input_set 不落地 auto；warn 清單 | input_set 後讀回無 auto 列；兩種 warn 各一案例 |
| T7 | 迴歸 | tests/support-auto-regression.test.js | 改動前後 9、10 月 | 全部 handler 輸出逐欄相同 |
| T8 | 薪酬頁 UI | payroll.html | — | auto 列唯讀＋逐日展開；差異兩鈕；提醒；門市下拉讀清單；page-handlers.test 綠 |
| T9 | 代轉白名單 | dzy Auth.gs、dryrun.js | — | proxy-authorize 第 13 節比對綠 |
| T10 | 查證同仁查薪兩張單 | 唯讀 | — | 回報 Eason 打卡頁／LINE 各看到哪張 |
