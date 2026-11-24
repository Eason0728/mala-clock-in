# 節日表測試夾具（薪資接收端用）

人事行政總處「中華民國政府行政機關辦公日曆表」原檔（政府資料開放平臺資料集 14718），從 mala-store-ops `feat/holiday-master`（`d165474`）
的 `test/fixtures/holidays/` 原樣複製（該 repo 於 2026-11-24 20:42 從官方網址下載，sha256 兩邊相同）。

| 檔 | 民國年 | 上傳 | 編碼 | sha256 |
|---|---|---|---|---|
| `115-202506.csv` | 115（2026） | 2025-06 | UTF-8（BOM） | 0edd80d368626eb73caa05b6c33400ec9d87691b46834d03936efb91e6a0f00d |
| `116-202607.csv` | 116（2027） | 2026-07 | UTF-8（BOM） | e30df188649bf5347db3ec43fa989af2cc8d93d793fbe5c9891601e6cce4acf3 |
| `114-202510.csv` | 114（2025）1141020 更新版 | 2025-10 | Big5 | b4bd40d4d1f4ffc20cb724a07bf3b7c5c1b32a9100e55dcf216f329af3513ca6 |
| `dataset-14718.json` | 資料集檔案清單（只留名稱、格式、網址） | — | UTF-8 | 04bb8b71a0206aaee37f8dd78cdb802c1212313b882bba654aa20ba18a578a12 |

`../hol-publish-v1.json`：營運系統正本推給薪資的內容（第 3 個改動要送的形狀），在 mala-store-ops `d165474` 的 worktree 用下面這段產生：

```
node -e "
const H=require('./server/holiday-master.js');
const m=JSON.parse(require('fs').readFileSync('server/holidays/master.json','utf8'));
const p=H.payrollRows(m);
const names={}; for(const y of Object.keys(m.years).sort()){ const off=m.years[y].off; for(const d of Object.keys(off).sort()) if(off[d]) names[d]=off[d]; }
const last=m.history[m.history.length-1];
const out={_note:'…', v:1, version:m.version, published_at:last.at, source:'人事行政總處 115、116 年辦公日曆表', rows:p.rows, moved:p.moved, names};
require('fs').writeFileSync(process.argv[1], JSON.stringify(out,null,1)+'\n');
" <輸出檔>
```

sha256 `d26087c7f45b15819dde2943b6fbf60c21128e059a960c71d9e70fbd1ee957da`（`tests/hol-publish-equiv.test.js` 釘住）。正本改版或 `payrollRows()` 介面改了要重產、一起改測試裡的雜湊。
