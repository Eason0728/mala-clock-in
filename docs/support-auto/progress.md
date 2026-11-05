# 進度：跨店支援時數自動帶入
- 開案日：2026-11-05
- 分級：完整
- 分級依據：排程=否 發訊息=否 外部後台=否 被看到=是 寫正式資料=是
- 現在在：④
- 等 Eason：無（GPT 17:31 後補審設計）

## 探到的事實（2026-11-05，唯讀）
- Payroll.gs payCollect 只讀本店打卡表；跨店支援只吃 payroll_input.support 手填 JSON（store 存中文名、rate 手填）。
- payroll.html 支援門市下拉寫死 5 家（無美村、瑞光）。
- 對人：薪資主檔沒有 DZY 編號；dzy staff_clock（payrollStaffRoster ids）有 DZY ↔ 各店打卡帳號（state confirmed）。
- 10 月：光復 A 君 金山 打卡 62.5＝手填 62.5；B 君 金山 54.5 vs 手填 57、墨竹亭光復 8.5 vs 12.5。
- 個人例外（總部薪資、央廚打卡）已由總部 Mirror 自動抄打卡，要排除；SSLHQ／MZTHQ 打卡表與 HQ 同一份，要依打卡表去重。

## Eason 決定（2026-11-05）
- 1B 每次重算自動帶入；2A 用 dzy 打卡對照；3A 有手填且不同→列差異逐筆決定；4B 費率＝本人加班費率（計時＝時薪）；6A 要逐日明細；7B 只從 2026-11 起。
- 5：11 月起只有同品牌算支援；跨品牌由打卡店的薪資主檔發薪。央廚、鼎兆元總部跟誰都算同品牌。
- 8A（2026-11-05）：跨品牌主檔＝計時、時薪＝原店加班費率、不扣保險、不給全勤餐費年終。待定：9（只跟跨品牌有關） 原店正職倒扣是否接受（推薦接受）。
- 開工要查：同仁查薪（my_payslip 找到第一家店即停、LINE 薪資明細）一人兩張薪資單看不看得到。

## 關卡紀錄
| 日期 | 關 | 對象 | 結果 | 第幾次 | 證據 |
|---|---|---|---|---|---|
| 2026-11-05 | 設計審 | requirements＋spec | Fable 12 條（高 5），全收進 spec §7 | 1 | scratchpad xsup-review；GPT 額度用完待補 |
| 2026-11-05 | 任務關 | T3–T8（薪資後端＋薪酬頁＋mock） | tests 92 支 0 FAIL；新 support-auto 99 項、regression 97 項；破壞驗證 3 種皆紅 | 1 | tests/support-auto*.test.js；docs/support-auto/shot-att.png |
| 2026-11-05 | 上線前審 | Payroll.gs＋payroll.html | Fable probe 七條全修（高 1、中 4、低 2），每條補測試並破壞驗證會紅 | 1 | tests/support-auto.test.js §12；scratchpad prelaunch-fable/probe.js |
| 2026-11-05 | 上線前審 | Payroll.gs＋payroll.html＋dzy diff | GPT 12 條（高 7、中 4、低 1）：10 條修、2 條（整月覆寫無版本、已鎖定月份仍可存工時）是改版前既有行為，另案；新增 27 項測試皆先在修改前程式上紅 | 1 | tests/support-auto.test.js §13；scratchpad prelaunch-gpt2/gpt-result.md；commit 2f68848 |
| 2026-11-05 | 上線前審 | GPT 修正＋損益估算 | Fable 複審 5 條（高 3、中 1、低 1）：撤掉移除標記法、改管理系統保留離職一個月；acct_only 不算已同步。測試 157 項＋dzy 45 項全過 | 2 | scratchpad fable-r3/run.js |

## 落地清單
- [ ] 1 排程上線：
- [ ] 2 掛進監看：
- [ ] 3 納入故障追蹤：
- [ ] 4 登錄資源：
- [ ] 5 建 skill 並登錄路由：
- [ ] 6 寫一則記憶：
- [ ] 7 進版控：
- [ ] 8 回報未完成與等待事項：
