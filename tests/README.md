# 薪資引擎測試

```bash
node tests/run-all.js
```

| 檔案 | 測什麼 | 為什麼需要 |
|---|---|---|
| `leave-e2e.test.js` | 值班核定 → leave 分頁 → `payCollect` → `payCalcOne` 整條鏈 | **`payCollect` 落在 `payroll_mock.js` 的切片之外，改版前這條鏈零測試覆蓋**（2026-08-23 補） |
| `leave-sweep.test.js` | 22 種假別逐一走完整條鏈、驗扣款金額 | 假別名是中文（含全形括號），比對錯了會靜靜當成全薪 |
| `leave-cap.test.js` | 跨月額度累計（病假 30 日、家庭照顧假併入事假） | 額度要掃整個曆年，只測單月測不到 |
| `attend-bonus.test.js` | 全勤兩段式（遞減＋門檻歸零），含各店不同設定 | 光復必須與改版前完全一致 |
| `annual-payout.test.js` | 特休週年期屆滿當月折算工資 | 一年只會發生一次，出錯很難發現 |
| `engine-diff.js` | 拿改動前後兩版引擎跑 2160 組情境逐項對拆 | 改公式時確認既有數字沒動 |

## 改引擎之前先跑 engine-diff

```bash
git show HEAD:apps-script/Payroll.gs > /tmp/before.gs
node tests/engine-diff.js /tmp/before.gs apps-script/Payroll.gs
```

## ⚠ 寫這類測試的三個坑（都踩過）

1. **`payCalcOne` 回的是 `earn`／`ded`，沒有 `items`**——寫錯欄位名會讓「逐項比對」變成空陣列比空陣列，
   測試全綠但其實什麼都沒比到。寫完測試先故意改壞一行，確認它會紅。
2. **vm 裡要用 vm context 的 `Date`**（`vm.runInContext('Date',sandbox)`）——
   模擬「Sheets 把日期轉成 Date 物件」時，跨 realm 的 `instanceof Date` 會判 false，測出來跟正式環境不一樣。
3. **leave 分頁的欄位名是中文**（日期／姓名／假別／時數），不是英文 key。
