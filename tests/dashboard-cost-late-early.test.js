/* 薪酬挑錯第 6 項（Eason 2026-11-11 確認）：儀表板口徑要扣回遲到／早退扣款。
 *
 * 規則：薪資費用小計 ＝ 應收 −（請假扣款＋不足倒扣＋遲到扣款＋早退扣款＋宿舍代扣＋勞健保自付額＋自訂加薪）
 *   遲到／早退不計薪跟不足倒扣一樣是「真的少領」。成本分類頁（payroll.html isCostReduceKey）
 *   與損益端點（pnlIsCostReduceKey_）早就扣了，儀表板趨勢／集團總覽用的 payIsReduceKey 漏了這兩個鍵，
 *   同一個月三個地方的「薪資費用」差一筆遲到早退扣款。
 *
 * 這支不依賴 mock/payroll_mock.js（CI 上也會跑）。全部虛構同仁、只用代號。
 * 期望值照規則手算寫死：
 *   E01 正職：底薪 30000＋全勤 2000 ＝ 應收 32000
 *             扣 遲到 81、早退 40、病假 500、勞保自付 700、宿舍 2000 ＝ 3321 → 實付 28679
 *   P01 計時：時薪列 20000 ＝ 應收 20000
 *             扣 遲到 42、勞保自付 300 ＝ 342 → 實付 19658
 *   應收合計 52000；要扣回 81+40+500+700+2000+42+300 ＝ 3663
 *   薪資費用小計 ＝ 52000 − 3663 ＝ 48337 ＝ 兩人實付合計 28679＋19658
 *   自付額 700＋300 ＝ 1000 → 保險成本（公司負擔 0）＝ 1000；人事總成本 ＝ 48337＋1000 ＝ 49337
 *   修前（漏扣 81＋40＋42＝163）儀表板會是 48500。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');

const sb = { console, Logger: { log() {} },
  SpreadsheetApp: { openById: () => null, getActive: () => null },
  Utilities: { formatDate: () => '2026-10-31T12:00:00+08:00' },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb);
vm.runInContext(C + '\n' + P, sb);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

// ── 前端：從 payroll.html 原文抽 isCostReduceKey／costTotals／costRows，不另寫一份 ──
const a2 = HTML.indexOf('const COST_REDUCE_EXTRA'), b2 = HTML.indexOf('function costRows(g){', a2);
const e2 = HTML.indexOf('\n  ];\n}', b2) + '\n  ];\n}'.length;
const escLine = (HTML.match(/const esc=s=>[\s\S]*?;\n/) || [''])[0];
function front(RESULTS) {
  const ctx = { console, MASTER: [], CFG: {}, ATT: {}, RESULTS, STATUS: 'draft', COST_SNAP: null,   // 2026-11-13：costTotals 會看月份狀態
    n: v => { const x = parseFloat(v); return isNaN(x) ? 0 : x; } };
  vm.createContext(ctx);
  vm.runInContext(escLine + HTML.slice(a2, e2)
    + '\nglobalThis.__rows=costRows(costTotals());globalThis.__isCost=isCostReduceKey;', ctx);
  return ctx;
}

const YM = '2026-10', ST = 'SSLGF';
const E01_DED = [['late_deduct', '遲到扣款', 81], ['early_deduct', '早退扣款', 40], ['sick_leave', '病假', 500],
                 ['labor_ins', '勞保費', 700], ['dormitory', '宿舍自付額', 2000]];
const P01_DED = [['late_deduct', '遲到扣款', 42], ['labor_ins', '勞保費', 300]];

console.log('══ 1) 三個地方對 late_deduct／early_deduct 的判斷 ══');
const isReduce = vm.runInContext('payIsReduceKey', sb);
const isPnl = vm.runInContext('pnlIsCostReduceKey_', sb);
const F0 = front([]);
['late_deduct', 'early_deduct'].forEach(k => {
  chk(`  成本分類頁 isCostReduceKey('${k}')`, F0.__isCost(k), true);
  chk(`  損益端點 pnlIsCostReduceKey_('${k}')`, isPnl(k), true);
  chk(`  儀表板 payIsReduceKey('${k}')`, isReduce(k), true);
});
chk('  遲到／早退不是代扣代繳（不加回保險成本）',
    [vm.runInContext('payIsInsSelfKey', sb)('late_deduct'), vm.runInContext('payIsInsSelfKey', sb)('early_deduct')], [false, false]);
chk('  自訂扣款照舊不扣', isReduce('custom_ded'), false);

console.log('\n══ 2) 同一份 10 月資料：儀表板趨勢／集團總覽 vs 成本分類頁 ══');
{
  sb.__E01 = E01_DED; sb.__P01 = P01_DED;
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'run') return [
        { ym:'${YM}', store:'${ST}', emp_id:'E01', gross:32000, net:28679, total_hours:176, support_hours:0,
          surplus_hours:0, ot_paid_hours:0, is_full_time:'true',  ratio:1, status:'draft' },
        { ym:'${YM}', store:'${ST}', emp_id:'P01', gross:20000, net:19658, total_hours:100, support_hours:0,
          surplus_hours:0, ot_paid_hours:0, is_full_time:'false', ratio:1, status:'draft' }];
      if (kind === 'item') {
        var out = [
          { ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:'base_salary',  item_type:'earning', amount:30000 },
          { ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:'attend_bonus', item_type:'earning', amount:2000 },
          { ym:'${YM}', store:'${ST}', emp_id:'P01', item_key:'hourly_wage',  item_type:'earning', amount:20000 }];
        __E01.forEach(function (d) { out.push({ ym:'${YM}', store:'${ST}', emp_id:'E01', item_key:d[0], item_type:'deduction', amount:d[2] }); });
        __P01.forEach(function (d) { out.push({ ym:'${YM}', store:'${ST}', emp_id:'P01', item_key:d[0], item_type:'deduction', amount:d[2] }); });
        return out;
      }
      return [];
    };
    payConfig = function(){ return {}; };
    payStoreList = function(){ return [{code:'${ST}', name:'光復（虛構）'}]; };
  `, sb);
  const t = vm.runInContext('handlePayrollTrend', sb)({ admin_key: 'x', store: ST, ym: YM, months: 1 }).months[0];
  const gp = vm.runInContext('handlePayrollGroup', sb)({ admin_key: 'x', ym: YM });

  const toDed = arr => arr.map(d => ({ item_key: d[0], item_label: d[1], amount: d[2] }));
  const RES = [
    { emp_id: 'E01', name: '正職甲', is_full_time: true, ratio: 1, gross: 32000, deduction: 3321, net: 28679, total_hours: 176,
      earn: [{ item_key: 'base_salary', item_label: '底薪', amount: 30000 },
             { item_key: 'attend_bonus', item_label: '績效獎金', amount: 2000 }],
      ded: toDed(E01_DED) },
    { emp_id: 'P01', name: '計時乙', is_full_time: false, ratio: 1, gross: 20000, deduction: 342, net: 19658, total_hours: 100,
      earn: [{ item_key: 'hourly_wage', item_label: '薪資（時數）', amount: 20000 }],
      ded: toDed(P01_DED) }];
  const rows = front(RES).__rows;
  const frontSalary = rows.find(x => x[0] === 's' && x[1] === '薪資費用小計')[2];
  const frontIns = rows.find(x => x[0] === 's' && x[1] === '保險成本小計')[2];

  chk('  成本分類頁薪資費用小計＝兩人實付 28679+19658', frontSalary, 48337);
  chk('  儀表板趨勢 salary_cost：52000−3663', t.salary_cost, 48337);
  chk('  儀表板 salary_cost＝前端薪資費用小計', t.salary_cost, frontSalary);
  chk('  集團總覽這一店 salary_cost', gp.rows[0].salary_cost, 48337);
  chk('  集團總覽合計 salary_cost', gp.sum.salary_cost, 48337);
  chk('  自付額只有勞保 700+300（遲到早退不算進去）', t.ins_self, 1000);
  chk('  儀表板保險成本＝前端保險成本小計', [t.company, frontIns], [1000, 1000]);
  chk('  儀表板人事總成本 48337+1000', t.total_cost, 49337);
  chk('  集團總覽人事總成本', gp.rows[0].total_cost, 49337);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 儀表板口徑含遲到／早退扣款'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
