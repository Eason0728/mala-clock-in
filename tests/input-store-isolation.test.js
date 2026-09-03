/* 工時（payroll_input）的門市隔離與支援時數防護（2026-08-24 修）
 *
 * 事故背景：handlePayrollInputSet 原本**完全沒有門市概念**——寫入不帶 store、刪除只比 ym。
 * 在央廚按一次「儲存工時」，光復同月的工時與跨店支援就被整批洗掉（實際發生於 2026-07：
 * C 君 72H、D 君 93H 的支援消失），而央廚自己存的 13 筆因為 store 空白被當成光復的、
 * 自己反而讀不回來。十一支整批覆寫的 handler 裡只有這支漏了門市過濾。
 *
 * 另修：paySavedInputs 對 support 的 JSON 解析原本 catch 後靜默回空陣列——
 * 資料壞掉時薪水少算不會有任何提示，且下次存檔會把空值寫回去、原始資料永久消失。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');

function makeCtx(seedRows) {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-08-24T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__DB = { input: (seedRows || []).slice() };
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payReplaceAll = function(kind, rows){ globalThis.__DB[kind] = rows.slice(); };
    payAppend = function(){}; payInvalidate = function(){};
  `, sb);
  return { sb, call: (fn, ...a) => vm.runInContext(fn, sb)(...a), db: () => sb.__DB.input };
}
const row = (ym, emp, store, hours, support) => ({
  ym, emp_id: emp, store, hours, extra_ot: 0, personal_h: 0, sick_h: 0, menstrual_h: 0,
  disaster_h: 0, annual_h: 0, deduct_days: 0, support: support === undefined ? '[]' : support,
  updated_at: '', full_attend: 0, work_days: 0, wage_override: 0, meal_on: 0, holiday_h: 0,
  custom_add_label: '', custom_add_amt: 0, custom_ded_label: '', custom_ded_amt: 0, dorm_override: '',
});
const SUP_72 = JSON.stringify([{ store: '墨竹亭金山', hours: 72, rate: 240, amount: '' }]);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

console.log('══ 1) 央廚存工時不可以動到光復（本次事故的核心）══');
{
  const ctx = makeCtx([
    row('2026-07', 'E01', 'SSLGF', 154.5, SUP_72),   // 光復：有支援 72H
    row('2026-07', 'E02', 'SSLGF', 167.75),
    row('2026-06', 'E01', 'SSLGF', 100, SUP_72),     // 光復上個月
  ]);
  const r = ctx.call('handlePayrollInputSet', { ym: '2026-07', store: 'CF',
    inputs: { CF01: { hours: 160 }, CF02: { hours: 150 } } });
  chk('  存檔成功且回報門市', [r.ok, r.store, r.count], [true, 'CF', 2]);
  const db = ctx.db();
  const gf7 = db.filter(x => x.ym === '2026-07' && x.store === 'SSLGF');
  chk('  光復 7 月的 2 筆還在', gf7.length, 2);
  chk('  光復的支援時數沒被洗掉', gf7.find(x => x.emp_id === 'E01').support, SUP_72);
  chk('  光復 6 月不受影響', db.filter(x => x.ym === '2026-06').length, 1);
  const cf7 = db.filter(x => x.ym === '2026-07' && x.store === 'CF');
  chk('  央廚的 2 筆有正確標上 store=CF', [cf7.length, cf7[0].store], [2, 'CF']);
}

console.log('\n══ 2) 央廚存完自己讀得回來（原本讀不到）══');
{
  const ctx = makeCtx([]);
  ctx.call('handlePayrollInputSet', { ym: '2026-07', store: 'CF', inputs: { CF01: { hours: 160 } } });
  chk('  央廚讀得到自己的', Object.keys(ctx.call('paySavedInputs', '2026-07', 'CF')), ['CF01']);
  chk('  光復讀不到央廚的', Object.keys(ctx.call('paySavedInputs', '2026-07', 'SSLGF')), []);
}

console.log('\n══ 3) 同店重存＝覆蓋自己（既有行為不變）══');
{
  const ctx = makeCtx([row('2026-07', 'E01', 'SSLGF', 154.5, SUP_72)]);
  ctx.call('handlePayrollInputSet', { ym: '2026-07', store: 'SSLGF', inputs: { E01: { hours: 200 } } });
  const gf = ctx.db().filter(x => x.ym === '2026-07' && payStoreOf(x) === 'SSLGF');
  chk('  仍只有 1 筆（覆蓋不是新增）', gf.length, 1);
  chk('  時數已更新', gf[0].hours, 200);
  function payStoreOf(x) { return String(x.store || 'SSLGF'); }
}

console.log('\n══ 4) 舊資料 store 空白仍視為光復（不可讓既有資料失蹤）══');
{
  const ctx = makeCtx([row('2026-07', 'E01', '', 154.5, SUP_72)]);   // 空白 store
  chk('  光復讀得到舊列', Object.keys(ctx.call('paySavedInputs', '2026-07', 'SSLGF')), ['E01']);
  chk('  支援時數讀得出來', ctx.call('paySavedInputs', '2026-07', 'SSLGF').E01.support[0].hours, 72);
  // 光復重存時，空白 store 的舊列會被自己的新列取代（payStore('')===SSLGF）
  ctx.call('handlePayrollInputSet', { ym: '2026-07', store: 'SSLGF', inputs: { E01: { hours: 99 } } });
  chk('  重存後不會殘留重複列', ctx.db().filter(x => x.ym === '2026-07').length, 1);
}

console.log('\n══ 5) 「清除本月手動工時」只清該店 ══');
{
  const ctx = makeCtx([row('2026-07', 'E01', 'SSLGF', 154.5, SUP_72), row('2026-07', 'CF01', 'CF', 160)]);
  ctx.call('handlePayrollInputSet', { ym: '2026-07', store: 'SSLGF', inputs: {} });
  const db = ctx.db();
  chk('  光復被清空', db.filter(x => x.store === 'SSLGF').length, 0);
  chk('  央廚原封不動', db.filter(x => x.store === 'CF').length, 1);
}

console.log('\n══ 6) 支援時數解析失敗要回報，不可靜默歸零 ══');
{
  const SMART = SUP_72.replace(/"/g, String.fromCharCode(8220));   // Sheets 智慧引號
  const ctx = makeCtx([
    row('2026-07', 'E01', 'SSLGF', 100, SMART),
    row('2026-07', 'E02', 'SSLGF', 100, '{"not":"array"}'),
    row('2026-07', 'E03', 'SSLGF', 100, SUP_72),
    row('2026-07', 'E04', 'SSLGF', 100, ''),
  ]);
  const s = ctx.call('paySavedInputs', '2026-07', 'SSLGF');
  chk('  壞掉的 JSON 有標記', s.E01.support_error, '無法解析');
  chk('  不是陣列也有標記', s.E02.support_error, '不是陣列格式');
  chk('  正常的沒有標記且讀得到', [s.E03.support_error, s.E03.support[0].hours], ['', 72]);
  chk('  空字串是合法的（沒有支援）', [s.E04.support_error, s.E04.support], ['', []]);
}

/* ═════ 舊分頁不可用舊工時影本覆蓋試算表（2026-09-03 修）═════
 * 出勤資料在兩處：試算表是正本、每個分頁開啟時抓一份影本（ATT）。payroll_calc 原本一律
 * 把 ATT 送上去、後端以送來的為準 → 別台裝置剛存好的跨店支援會被舊分頁蓋掉。
 * 改成只有這個分頁真的有未存變更（ATT_DIRTY）才送影本。 */
console.log('\n══ 6) 重算時送出的工時來源（前端）══');
{
  const fs2 = require('fs'), vm2 = require('vm');
  const HTML = fs2.readFileSync(require('path').join(__dirname, '..', 'payroll.html'), 'utf8');
  const grab = sig => { const i = HTML.indexOf(sig); return HTML.slice(i, HTML.indexOf('\n}', i) + 2); };

  chk('  有 CALC_INPUTS 這個判斷', /const CALC_INPUTS = \(\) => ATT_DIRTY \? ATT : \{\};/.test(HTML), true);
  chk('  payroll_calc 不可以再直接送 ATT', /payroll_calc',\{ym:ym\(\),inputs:ATT\}/.test(HTML), false);
  chk('  兩處都改用 CALC_INPUTS（手動重算＋切月份自動試算）',
      (HTML.match(/payroll_calc',\{ym:ym\(\),inputs:CALC_INPUTS\(\)\}/g) || []).length, 2);
  chk('  儲存工時仍然要送完整 ATT（那才是存檔）',
      /payroll_input_set',\{ym:ym\(\),inputs:ATT\}/.test(HTML), true);

  // 實跑：同一份程式碼，只差在有沒有未存變更
  const SUP = { E02: { support: [{ store: 'MZTJS', hours: 84.75, rate: 0 }] } };
  /* ⚠ CALC_INPUTS 一定要從 payroll.html 抓出來，不可以在這裡寫死一份——
     寫死的話這兩條實跑測的是「測試自己寫的邏輯」，把程式改壞也照樣綠（2026-09-03 踩過）。 */
  const calcLine = (HTML.match(/const CALC_INPUTS = [^\n]+/) || [''])[0];
  const src = [grab('async function autoCalc(){'), calcLine, grab('async function doCalc(){')].join('\n');
  const sentWith = dirty => {
    let sent = null;
    const ctx = { console, ATT: SUP, ATT_DIRTY: dirty, STATUS: 'draft', RESULTS: [], CFG: {},
      ym: () => '2026-08', setBusy(){}, vClear(){}, renderRun(){}, renderSlipSel(){}, toast(){},
      post: async (a2, b2) => { sent = b2.inputs; return { ok: true, results: [], config: {} }; } };
    vm2.createContext(ctx);
    vm2.runInContext(src + '\nglobalThis.__d=doCalc;', ctx);
    ctx.__d();   // post 是同步 resolve，這裡取得的 sent 已經填好
    return sent;
  };
  chk('  沒有未存變更 → 送 {}（以試算表為準）', sentWith(false), {});
  chk('  有未存變更 → 照送影本（行為不變）', sentWith(true), SUP);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 工時門市隔離與支援防護全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
