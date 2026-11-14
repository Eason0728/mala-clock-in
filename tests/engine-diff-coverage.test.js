/* 第 9 項（Eason 2026-11-11 確認）：新舊引擎對拆要測得到 2026-10 以後的規則。
 * 舊版＝git cc3de16~1（#97「正職月中到職／離職固定 30 天折算」之前），新版＝現行 apps-script/Payroll.gs。
 * 期望值全部照規則手算寫死（不從程式反推）；同仁全部虛構、只用代號。
 *
 * 手算依據（#97：2026-10 起，正職金額比例＝在職天數÷30；之前＝在職天數÷當月天數；計時不變）：
 *   月中到職D（正職，底薪 32,000，當月 16 日到職）
 *     2026-10（31 天，在職 16 天）：舊 32000×16÷31＝16516.13→16,516；新 32000×16÷30＝17066.67→17,067
 *     2027-02（28 天，在職 13 天）：舊 32000×13÷28＝14857.14→14,857；新 32000×13÷30＝13866.67→13,867
 *   月中離職E（正職，底薪 30,000，當月 15 日離職）
 *     2026-10（在職 15 天）：舊 30000×15÷31＝14516.13→14,516；新 30000×15÷30＝15,000
 *   2026-09、2026-11 都是 30 天的月份：÷30 與 ÷當月天數相同，而且 2026-09 在生效月份之前 → 0 組不同
 *   2026-10 不同的只有 D、E 兩位（正職月中）：每一種工時假別組合的底薪都不同 → 不同組數＝2 × 每人組合數 */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tests', 'engine-diff.js');
const WRAP = path.join(ROOT, 'diff_engines.js');
const NEW = path.join(ROOT, 'apps-script', 'Payroll.gs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-diff-cov-'));
const gitShow = (rev, name) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, cp.execFileSync('git', ['-C', ROOT, 'show', rev + ':apps-script/Payroll.gs'], { maxBuffer: 64 * 1024 * 1024 }));
  return p;
};
const run = (script, args) => {
  const r = cp.spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};
let p = 0, f = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 手算 ' + JSON.stringify(want)));
};
// 「新月份 2026-10：比對 N 組，金額不同 M 組」→ {n, bad}；沒有這一行回 null
const monthLine = (out, ym) => {
  const m = out.match(new RegExp('新月份 ' + ym + '：比對 (\\d+) 組，金額不同 (\\d+) 組'));
  return m ? { n: +m[1], bad: +m[2] } : null;
};
// 某個月份那一區的文字（到下一個「新月份」或結尾）
const monthBlock = (out, ym) => {
  const i = out.indexOf('新月份 ' + ym + '：');
  if (i < 0) return '';
  const j = out.indexOf('新月份 ', i + 5);
  return out.slice(i, j < 0 ? out.length : j);
};
const perEmp = (out) => { const m = out.match(/每人 (\d+) 種工時假別組合/); return m ? +m[1] : null; };

const OLD97 = gitShow('cc3de16~1', 'before97.gs');

/* ── 一、#97 之前 vs 現行 ── */
const a = run(TOOL, [OLD97, NEW]);
chk('不加 --strict：結束碼 0', a.code, 0);
chk('舊四個月仍是 2160 組', /比對 2160 組情境/.test(a.out), true);
chk('舊四個月 0 差異', /✅ 金額逐項完全相同/.test(a.out) && !/❌/.test(a.out), true);
const N = perEmp(a.out);
chk('2026-10 抓到差異：不同組數＝2 位正職月中 × 每人組合數', [N > 0, (monthLine(a.out, '2026-10') || {}).bad], [true, 2 * N]);
chk('2026-10 月中到職D 底薪 16,516 → 17,067', /月中到職D[^\n]*\n(?:\s+[^\n]*\n)*?\s+base_salary：舊 16516 → 新 17067/.test(monthBlock(a.out, '2026-10')), true);
chk('2026-10 月中離職E 底薪 14,516 → 15,000', /月中離職E[^\n]*\n(?:\s+[^\n]*\n)*?\s+base_salary：舊 14516 → 新 15000/.test(monthBlock(a.out, '2026-10')), true);
chk('2027-02 月中到職D 底薪 14,857 → 13,867', /月中到職D[^\n]*\n(?:\s+[^\n]*\n)*?\s+base_salary：舊 14857 → 新 13867/.test(monthBlock(a.out, '2027-02')), true);
chk('2026-09（生效前、30 天）0 組不同', (monthLine(a.out, '2026-09') || {}).bad, 0);
/* 2026-11 的不同組數（薪酬挑錯第 4、10 項，Eason 2026-11-11 確認；原本手算 0，÷30 那條規則在 30 天的月份沒有差）：
 *   第 10 項：2026-11 起半薪假「時數×整數時薪×0.5」最後才取整。扣款時薪是奇數才有差：
 *     正職A 39,000÷240＝162.5→163（奇數）；月中到職C、D 37,000÷240→154；月中離職E、墨竹亭正職G 36,000÷240＝150；計時 0。
 *     所以只有正職A：帶病假的假別組合 3 種（病假 16H、事假＋病假 8H＋特休、病假 240H）× 5 種工時 × 2 種支援 × 2 種加扣＝60 組，
 *     加「病假 17H＋事假 5H」1 組、「生理假第 4 次 4H 轉半薪」1 組 ＝ 62 組。
 *   第 4 項：特休折算 16H 的情境，A 41,000÷240×16＝2,733.33、E／G 38,000÷240×16＝2,533.33、C／D 39,000÷240×16＝2,600，
 *     跟「時薪先取 2 位」算出來的整數相同 → 0 組。
 *   墨竹亭開放補休（Eason 2026-11-14，PAY_MZT_COMP_FROM='2026-11'）：墨竹亭正職G 逐日「平日超時＋補休」補休改抵加班 → 2 組（加班 8→5H）。共 64 組。 */
chk('2026-11（30 天）不同 64 組＝正職A 的半薪假 62＋墨竹亭補休抵加班 2', (monthLine(a.out, '2026-11') || {}).bad, 64);
chk('2026-11 墨竹亭正職G 平日超時＋補休：補休抵加班 8→5H', /墨竹亭正職G｜逐日「平日超時＋補休」[^\n]*\n\s+ot_w43：舊 1697（8） → 新 1061（5）/.test(monthBlock(a.out, '2026-11')), true);
chk('2026-11 有帶逐日資料的情境（平日超時／休息日／例假／國定假日／補休）',
  ['平日超時', '休息日', '例假', '國定假日', '補休'].map(k => new RegExp('逐日情境：[^\\n]*' + k).test(a.out)), [true, true, true, true, true]);

/* ── 二、--strict：新月份有差異也回 1 ── */
const s = run(TOOL, [OLD97, NEW, '--strict']);
chk('--strict：新月份有差異 → 結束碼 1', s.code, 1);
chk('--strict：舊四個月仍是 0 差異', /✅ 金額逐項完全相同/.test(s.out), true);
const s2 = run(TOOL, ['--strict', OLD97, NEW]);
chk('--strict 放在前面也一樣', s2.code, 1);

/* ── 三、同一版比自己：全部 0，--strict 也回 0 ── */
const same = run(TOOL, [NEW, NEW, '--strict']);
chk('現行比現行＋--strict：結束碼 0', same.code, 0);
chk('現行比現行：四個新月份都 0 組不同', ['2026-09', '2026-10', '2026-11', '2027-02'].map(ym => (monthLine(same.out, ym) || {}).bad), [0, 0, 0, 0]);

/* ── 四、根目錄 diff_engines.js＝轉呼叫，輸出與結束碼相同 ── */
chk('diff_engines.js 存在', fs.existsSync(WRAP), true);
const w = run(WRAP, [OLD97, NEW]), ws = run(WRAP, [OLD97, NEW, '--strict']);
chk('diff_engines.js：輸出與結束碼同 tests/engine-diff.js', [w.code, w.out === a.out], [0, true]);
chk('diff_engines.js --strict：參數原樣傳', [ws.code, ws.out === s.out], [1, true]);

/* ── 五、2026-10-30 的版本（沒有逐日加班）：2026-11 逐日情境列得出差異，舊四個月照舊 0 ──
 *   規則：2026-11 起有逐日資料就逐日判斷加班（平日超過 8 小時 ot_w43、休息日 ot_rest…）；10-30 那一版沒有這些項目。 */
const OLDNOV = gitShow('dd0f22f', 'before_nov.gs');
const b = run(TOOL, [OLDNOV, NEW]);
chk('10-30 版 vs 現行：結束碼 0、舊四個月 0 差異', [b.code, /✅ 金額逐項完全相同/.test(b.out)], [0, true]);
chk('10-30 版 vs 現行：2026-11 有差異', (monthLine(b.out, '2026-11') || {}).bad > 0, true);
chk('10-30 版 vs 現行：2026-11 差異裡有逐日加班項目', /ot_w43/.test(monthBlock(b.out, '2026-11')) && /ot_rest/.test(monthBlock(b.out, '2026-11')), true);

/* ── 六、舊版引擎缺函式：不可以整支掛掉，要跑完並回報 ── */
const MARK = '/* ═══════════════════ Handlers';
const stub1 = path.join(TMP, 'stub_missing_helper.gs');   // payCalcOne 裡呼叫一支不存在的函式
fs.writeFileSync(stub1, 'function payR0(x){return Math.round(x)}\nfunction payCalcOne(e,ym,att,cfg,red){ return payNotThereYet(e,ym); }\n' + MARK + ' */\n');
const stub2 = path.join(TMP, 'stub_no_calc.gs');          // 整支沒有 payCalcOne
fs.writeFileSync(stub2, 'function payR0(x){return Math.round(x)}\n' + MARK + ' */\n');
[['payCalcOne 呼叫不存在的函式', stub1], ['沒有 payCalcOne', stub2]].forEach(([nm, sp]) => {
  const r = run(TOOL, [sp, NEW]);
  chk('缺函式（' + nm + '）：跑到最後、結束碼 1、沒有未攔截的例外',
    [r.code, /比對 2160 組情境/.test(r.out), monthLine(r.out, '2027-02') !== null, /執行錯誤/.test(r.out), /at .*engine-diff\.js|ReferenceError|TypeError/.test(r.err)],
    [1, true, true, true, false]);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${p} 過、${f} 失敗`); if (f) process.exit(1);
