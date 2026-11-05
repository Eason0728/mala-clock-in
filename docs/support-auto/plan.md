# 技術方案：跨店支援時數自動帶入

## Phase 1｜管理系統出對照（dzy＋minikit）
- 平台讀取 action `payrollXmap`（StaffClock.gs 末節，沿用 payStaffRosterBuild_ 的資料來源）。
- Code.gs 白名單＋分派、dryrun READ_ACTIONS、minikit app.json readActions、bridge.js routeOf `payroll_dzy_xmap`。
- 里程碑：本機 mock 打得到、scope 裁切測試綠。

## Phase 2｜薪資後端（mala-clock-in Payroll.gs）
- schema：store 追加 support_group、新表 xmap；`payroll_xmap_set／get`；PAY_XSUP_FROM。
- `paySupportAuto_`、`payMergeSupport_`、`payCrossIncoming_`、存檔剔除 auto 列、scope 規則。
- 里程碑：support-auto.test.js 全綠；ym<2026-11 迴歸逐欄相同。

## Phase 3｜薪酬頁（payroll.html）
- 對照同步（6 小時）、auto 列顯示與逐日展開、差異兩顆鈕、各種提醒、門市下拉讀清單。
- dzy Auth.gs PROXY_*_ACTIONS.payroll＋dryrun.js 補 payroll_xmap_get／set。
- 里程碑：本機整套（minikit runner＋mala-clock-in mock＋dzy 複本）點過一輪。

## Phase 4｜上線
順序：薪資後端（clasp，xmap 空＝不動作）→ 門市表填 support_group → mini（minikit）→ dzy 前端 → payroll.html。
上線後：開一次薪酬頁觸發同步 → 11 月草稿唯讀比對帶入值＝各店核定加總。

## 審查
- 設計審：GPT（codex-gpt.sh）對抗性審 requirements＋spec，高嚴重度拿不準的交 Fable 複核。
- 上線前：Fable＋GPT 互盲，只審金額計算、寫外部系統兩塊。
