/* 曠職扣款（absent_deduct）進成本口徑（2026-11-28 外部審查第一輪殘餘，主管交辦修）：
 *   成本分類頁（payroll.html isCostReduceKey，鎖定時存成 cost_snapshot 推給門市自動損益）、損益估算（pnlIsCostReduceKey_）、
 *   儀表板趨勢／集團總覽（payIsReduceKey）三處都把 absent_deduct 當「真的少領」扣回，跟請假扣款一樣。
 * 要求：沒有曠職扣款時三處輸出跟改之前（KZ_COST_BASE，預設 f0ff8428）逐字相同；有曠職扣款時實發不變、只有薪資費用少掉那一筆。
 * 手算（虛構同仁）：E01 正職 底薪 32000＋績效 2000＝應收 34000；扣 曠職 1133、勞保自付 700 → 實付 32167
 *   薪資費用小計＝34000 −（1133＋700）＝32167；保險成本＝自付 700；人事總成本＝32867。改之前（漏扣 1133）薪資費用＝33300。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.KZ_COST_BASE || 'f0ff8428';
const cur = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const old = (f) => { try { return cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':' + f], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

const YM = '2026-12', ST = 'SSLGF';
function backend(C, P, ded) {
  const sb = { console, Logger: { log() {} }, SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-12-31T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, __DED: ded };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'run') return [{ ym:'${YM}', store:'${ST}', emp_id:'E01', gross:34000, net:34000 - __DED.reduce(function(a,d){return a+d[2];},0), total_hours:176,
        support_hours:0, surplus_hours:0, ot_paid_hours:0, is_full_time:'true', ratio:1, status:'draft' }];
      if (kind === 'item') return [
        { ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:'base_salary', item_type:'earning', amount:32000 },
        { ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:'attend_bonus', item_type:'earning', amount:2000 }]
        .concat(__DED.map(function (d) { return { ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:d[0], item_type:'deduction', amount:d[2] }; }));
      return [];
    };
    payConfig = function(){ return {}; };
    payStoreList = function(){ return [{code:'${ST}', name:'光復（虛構）'}]; };
  `, sb);
  return {
    trend: JSON.parse(JSON.stringify(vm.runInContext('handlePayrollTrend', sb)({ admin_key: 'x', store: ST, ym: YM, months: 1 }).months[0])),
    group: JSON.parse(JSON.stringify(vm.runInContext('handlePayrollGroup', sb)({ admin_key: 'x', ym: YM }))),
    isReduce: vm.runInContext('payIsReduceKey', sb), isPnl: vm.runInContext('pnlIsCostReduceKey_', sb),
  };
}
function front(HTML, ded) {
  const a2 = HTML.indexOf('const COST_REDUCE_EXTRA'), b2 = HTML.indexOf('function costRows(g){', a2);
  const e2 = HTML.indexOf('\n  ];\n}', b2) + '\n  ];\n}'.length;
  const escLine = (HTML.match(/const esc=s=>[\s\S]*?;\n/) || [''])[0];
  const RES = [{ emp_id: 'E01', name: '正職甲', is_full_time: true, ratio: 1, gross: 34000, deduction: ded.reduce((a, d) => a + d[2], 0),
    net: 34000 - ded.reduce((a, d) => a + d[2], 0), total_hours: 176,
    earn: [{ item_key: 'base_salary', item_label: '底薪', amount: 32000 }, { item_key: 'attend_bonus', item_label: '績效獎金', amount: 2000 }],
    ded: ded.map((d) => ({ item_key: d[0], item_label: d[1], amount: d[2] })) }];
  const ctx = { console, MASTER: [], CFG: {}, ATT: {}, RESULTS: RES, STATUS: 'draft', COST_SNAP: null, n: (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; } };
  vm.createContext(ctx);
  vm.runInContext(escLine + HTML.slice(a2, e2) + '\nglobalThis.__rows=costRows(costTotals());globalThis.__isCost=isCostReduceKey;', ctx);
  return { rows: JSON.parse(JSON.stringify(ctx.__rows)), isCost: ctx.__isCost };
}
const NOW = { C: cur('apps-script/Code.gs'), P: cur('apps-script/Payroll.gs'), H: cur('payroll.html') };
const KZ = [['absent_deduct', '曠職(無薪) 1天', 1133], ['labor_ins', '勞保費', 700]];
const NOKZ = [['personal_leave', '事假(無薪)', 1067], ['late_deduct', '遲到扣款', 81], ['labor_ins', '勞保費', 700], ['dormitory', '宿舍', 2000]];

console.log('══ 1) 三處都把 absent_deduct 當扣回 ══');
{
  const b = backend(NOW.C, NOW.P, []), f = front(NOW.H, []);
  chk('成本分類頁 isCostReduceKey', f.isCost('absent_deduct'), true);
  chk('損益估算 pnlIsCostReduceKey_', b.isPnl('absent_deduct'), true);
  chk('儀表板 payIsReduceKey', b.isReduce('absent_deduct'), true);
  chk('不是代扣代繳（不加回保險成本）', vm.runInContext('payIsInsSelfKey', (() => { const s = { console }; vm.createContext(s); vm.runInContext(NOW.P.slice(NOW.P.indexOf('function payIsInsSelfKey'), NOW.P.indexOf('function payIsReduceKey')), s); return s; })())('absent_deduct'), false);
}

console.log('\n══ 2) 有曠職扣款：薪資費用＝實付，三處一致 ══');
{
  const b = backend(NOW.C, NOW.P, KZ), rows = front(NOW.H, KZ).rows;
  const fs1 = rows.find((x) => x[0] === 's' && x[1] === '薪資費用小計')[2];
  chk('成本分類頁薪資費用小計＝實付 32167', fs1, 32167);
  chk('儀表板趨勢 salary_cost', b.trend.salary_cost, 32167);
  chk('集團總覽 salary_cost', b.group.rows[0].salary_cost, 32167);
  chk('人事總成本 32167＋700', b.trend.total_cost, 32867);
}

console.log('\n══ 3) 跟改之前（' + BASE + '）比 ══');
{
  const O = { C: old('apps-script/Code.gs'), P: old('apps-script/Payroll.gs'), H: old('payroll.html') };
  if (!O.C || !O.P || !O.H) { console.log('⊘ 略過：讀不到 ' + BASE + '（設 KZ_COST_BASE）'); }
  else {
    for (const [nm, ded] of [['沒有扣款', []], ['事假、遲到、勞保、宿舍', NOKZ]]) {
      chk('沒有曠職扣款（' + nm + '）：儀表板趨勢逐字相同', backend(NOW.C, NOW.P, ded).trend, backend(O.C, O.P, ded).trend);
      chk('沒有曠職扣款（' + nm + '）：集團總覽逐字相同', backend(NOW.C, NOW.P, ded).group, backend(O.C, O.P, ded).group);
      chk('沒有曠職扣款（' + nm + '）：成本分類頁逐列相同', front(NOW.H, ded).rows, front(O.H, ded).rows);
    }
    const a = backend(NOW.C, NOW.P, KZ).trend, z = backend(O.C, O.P, KZ).trend;
    chk('有曠職扣款：改之前薪資費用多算 1133（33300）、現在 32167', [z.salary_cost, a.salary_cost], [33300, 32167]);
  }
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 曠職扣款進成本口徑'}（${pass}/${pass + fail}）`);
if (fail) process.exit(1);
