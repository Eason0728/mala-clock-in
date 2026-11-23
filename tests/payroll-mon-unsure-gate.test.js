/* 「這個月讀取失敗」只有一個判斷來源（2026-11-22 #212 後續 PR，驗收員第 4 點）
 * 規則（主管同意）：這個月任何一次讀取失敗 → 擋匯出（Excel、CSV、薪資單／PDF 列印）與鎖定，重新載入成功才解開；
 *   被擋的提示只用「這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出」。
 * 守的事（靜態掃 payroll.html，之後新增按鈕漏掉就會紅）：
 *   1. 讀「目前店月有沒有讀取失敗」只在 monUnsure() 一處；其他地方只能寫（=1）或刪（delete）MON_UNSURE。
 *   2. 會把薪資數字送出去的入口（所有 window.print、所有 a.download 下載、onclick 直接列印）都要先經過 monUnsureStop()；
 *      不是薪資數字的入口（出勤紀錄匯出、操作紀錄、申請證明下載）列在白名單、說明理由。
 *   3. 鎖定鈕的停用與 toggleLock 的擋都用 monBlocked()（＝名單待確認 elecPending()＋讀取失敗 monUnsure()），monBlocked 不是死碼。
 *   4. 被擋提示只有那一句（MON_UNSURE_MSG 逐字相同、monUnsureStop 只用它）。 */
'use strict';
const fs = require('fs'), path = require('path');
const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n, extra) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra))); };
const lineOf = (i) => H.slice(0, i).split('\n').length;
/* 取出某個位置所在的 function 名稱與函式本體（往前找最近的 function 宣告，往後配對大括號） */
function fnAt(i) {
  const re = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g;
  let m, best = null;
  while ((m = re.exec(H)) && m.index < i) best = m;
  if (!best) return null;
  let d = 0, j = best.index + best[0].length - 1;
  for (; j < H.length; j++) { if (H[j] === '{') d++; else if (H[j] === '}' && --d === 0) break; }
  return j >= i ? { name: best[1], body: H.slice(best.index, j + 1) } : null;
}
const fnBody = (name) => { const i = H.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(')); return i < 0 ? '' : fnAt(i + 12).body; };

console.log('══ 1) 讀取失敗旗標只在 monUnsure() 讀 ══');
{
  const reads = [];
  const re = /MON_UNSURE\[[^\]]+\]/g; let m;
  while ((m = re.exec(H))) {
    const before = H.slice(Math.max(0, m.index - 7), m.index), after = H.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const write = /^\s*=[^=]/.test(after), del = /delete\s*$/.test(before);
    if (!write && !del) reads.push({ line: lineOf(m.index), fn: (fnAt(m.index) || {}).name });
  }
  ok(reads.length === 1 && reads[0].fn === 'monUnsure', '讀 MON_UNSURE 的地方只有 monUnsure()', reads);
  ok(/function monUnsure\(\)\{ return !!MON_UNSURE\[STORE\+'\|'\+ym\(\)\]; \}/.test(H), 'monUnsure()＝目前店月（STORE|ym）');
}

console.log('══ 2) 會把薪資數字送出去的入口都先經過 monUnsureStop() ══');
{
  /* 不是這個月薪資數字的入口：出勤紀錄（打卡核定時數，另一支 API 讀的，有自己的讀取失敗處理）、操作紀錄、申請證明附件 */
  const NOT_PAY = { exportAttPDF: '出勤紀錄 PDF（打卡資料，不是薪資金額）', exportAttExcel: '出勤紀錄 Excel（同上）', exportOplogExcel: '操作紀錄 Excel', attOpenProof: '出勤紀錄表的申請證明附件下載' };
  const outs = [];
  const re = /window\.print\(\)|\.download\s*=|XLSX\.writeFile\(/g; let m;
  while ((m = re.exec(H))) {
    const f = fnAt(m.index);
    outs.push({ line: lineOf(m.index), what: m[0], fn: f ? f.name : '(不在函式內：onclick 直接寫)' });
  }
  const pay = outs.filter((o) => !NOT_PAY[o.fn]);
  const names = [...new Set(pay.map((o) => o.fn))].sort();
  ok(JSON.stringify(names) === JSON.stringify(['exportCSV', 'exportExcel', 'exportPDF', 'printSlip']), '薪資數字的出口＝exportCSV／exportExcel／exportPDF／printSlip（多了新出口要加進來並擋）', names);
  names.forEach((n) => {
    const b = fnBody(n);
    const first = (b.split('{').slice(1).join('{').trim().split(';')[0] || '');
    ok(/^if\(monUnsureStop\(\)\) return$/.test(first), n + '：第一行就是 if(monUnsureStop()) return', first);
  });
  const others = [...new Set(outs.filter((o) => NOT_PAY[o.fn]).map((o) => o.fn))].sort();
  console.log('  （白名單、不擋：' + others.map((n) => n + '＝' + NOT_PAY[n]).join('；') + '）');
  ok(!/onclick="[^"]*window\.print/.test(H), 'HTML 沒有 onclick 直接 window.print()（薪資單列印改走 printSlip）');
  ok(/<button class="btn" onclick="printSlip\(\)">列印 \/ 存成 PDF<\/button>/.test(H), '薪資單頁「列印 / 存成 PDF」走 printSlip()');
}

console.log('══ 3) 鎖定用 monBlocked()（不是死碼）══');
{
  ok(/function monBlocked\(\)\{ return elecPending\(\)\|\|monUnsure\(\); \}/.test(H), 'monBlocked()＝elecPending()||monUnsure()');
  ok(/lb\.disabled=monBlocked\(\)/.test(fnBody('elecBtns')), 'elecBtns：鎖定鈕停用＝monBlocked()');
  ok(/if\(monBlocked\(\)\) return;/.test(fnBody('toggleLock')), 'toggleLock：開頭 if(monBlocked()) return');
  ok(!/cb\.disabled=[^;]*monUnsure|cb\.disabled=[^;]*MON_UNSURE/.test(fnBody('elecBtns')), '重新計算鈕不看讀取失敗旗標（讀取失敗後仍可重算，重算成功後重新載入才解開）');
}

console.log('══ 4) 被擋提示只有那一句 ══');
{
  ok(H.indexOf("const MON_UNSURE_MSG='這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出';") >= 0, 'MON_UNSURE_MSG 逐字＝主管同意的那一句');
  ok(/function monUnsureStop\(\)\{ if\(!monUnsure\(\)\) return false; toast\(MON_UNSURE_MSG,true\); return true; \}/.test(H), 'monUnsureStop 只用 MON_UNSURE_MSG');
}

console.log('══ 5) 讀取失敗後重算：有未存的出勤編輯就不自動重新載入（Codex 複審 2026-11-22 BLOCKER）══');
let done5;
{
  /* 讀取失敗旗標在、按「重新計算」成功：
   *   沒有未存編輯 → 重新載入（#214 第 5 點）；有未存編輯 → 不重新載入（留著編輯與「儲存工時 ●」、旗標照擋）；
   *   saveAtt 存好工時後叫的重算（inputsSaved）→ 重新載入。旗標不在 → 都不重新載入。 */
  const vm = require('vm');
  const src = fnBody('doCalc');
  const run = async (unsure, dirty, saved) => {
    const log = { reload: 0 };
    const ctx = { loadingStop: () => false, get wpost() { return this.post; }, STORE: 'S', ym: () => '2026-10', MON_UNSURE: unsure ? { 'S|2026-10': 1 } : {}, RES_GEN: {}, ELEC_PEND: {}, LOAD_INFLIGHT: null, ATT_DIRTY: dirty, ATT: { e: { custom_add_amt: 500 } },
      RESULTS: [], STATUS: 'draft', CFG: {}, COST_SNAP: null, ELEC_STALE: false, NOT_IN_PAY: [], ZERO_RATIO: [], LEAVE_MM: [],
      setResults(l) { ctx.RESULTS = l; }, supCrossBlock: () => false, setBusy() {}, elecBtns() {}, asofFromCalc() {}, vClear() {}, renderRun() {}, renderSlipSel() {}, toast() {}, alert() {},
      CALC_INPUTS: () => (ctx.ATT_DIRTY ? ctx.ATT : {}), post: async () => ({ ok: true, results: [{ emp_id: 'e' }] }),
      loadMonth: async () => { log.reload++; delete ctx.MON_UNSURE['S|2026-10']; ctx.ATT_DIRTY = false; return true; } };
    ctx.monUnsure = () => !!ctx.MON_UNSURE[ctx.STORE + '|' + ctx.ym()];
    vm.createContext(ctx); vm.runInContext(src + '\nglobalThis.__d=doCalc;', ctx);
    const ret = await ctx.__d(undefined, saved);
    return { ret, reload: log.reload, unsure: ctx.monUnsure(), dirty: ctx.ATT_DIRTY };
  };
  done5 = (async () => {
    let r = await run(true, false, undefined);
    ok(r.ret === true && r.reload === 1 && !r.unsure, '旗標在、沒有未存編輯 → 重算後重新載入、成功才解開（#214 第 5 點照舊）', r);
    r = await run(true, true, undefined);
    ok(r.ret === true && r.reload === 0 && r.unsure && r.dirty === true, '旗標在、有未存編輯 → 重算成功但不重新載入：未存標記還在、旗標照擋', r);
    r = await run(true, true, true);
    ok(r.ret === true && r.reload === 1 && !r.unsure, '旗標在、saveAtt 剛存好工時（inputsSaved）→ 重新載入、成功才解開', r);
    r = await run(false, true, undefined);
    ok(r.reload === 0, '旗標不在 → 不重新載入（同線上版：留著未存編輯）', r);
    ok(/await doCalc\(undefined,true\);/.test(fnBody('saveAtt')), 'saveAtt 存好工時後叫 doCalc(undefined,true)');
    ok(/else if\(st\.status==='mixed'\)\{ MON_UNSURE\[lockKey\]=1; toast\(/.test(fnBody('toggleLock')), '鎖定回應遺失、狀態查詢回 mixed → 設讀取失敗旗標（提示照舊）');
  })();
}

done5.then(() => {
  console.log(fail ? `\n❌ ${pass} 過、${fail} 失敗` : `\n✅ ${pass} 過、0 失敗`);
  process.exit(fail ? 1 : 0);
});
