/* 人事成本口徑（payIsReduceKey）——這條規則 Eason 改過兩次，獨立守住。
 *
 * 現行定義（2026-08-24）：薪資費用小計 ＝ 應收 −（請假扣款 ＋ 不足時數倒扣 ＋ 宿舍代扣）
 *   ✔ 請假扣款：任何 /_leave$/（新假別自動涵蓋，不必逐一列舉）
 *   ✔ 不足時數倒扣 shortfall_hours
 *   ✔ 宿舍代扣 dormitory —— 同仁付給公司的房租，不是人事成本；另在成本分類下方列成租金收入
 *   ✘ 勞健保／團保／退休金自付額 —— **不扣**，那是薪資的一部分，只是代扣去繳保費
 *
 * 三處必須同口徑：Payroll.gs payIsReduceKey（儀表板趨勢／集團總覽）、
 * payroll.html isCostReduceKey＋宿舍、mock/payroll_mock.js isReduce（兩處）。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const MOCK = fs.readFileSync(path.join(__dirname, '..', 'mock', 'payroll_mock.js'), 'utf8');

const sb = { console, Logger: { log() {} },
  SpreadsheetApp: { openById: () => null, getActive: () => null },
  Utilities: { formatDate: () => '2026-08-24T12:00:00+08:00' },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb);
vm.runInContext(C + '\n' + P, sb);
const isReduce = vm.runInContext('payIsReduceKey', sb);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

const isInsSelf = vm.runInContext('payIsInsSelfKey', sb);
console.log('══ 1) 哪些扣項要從薪資費用扣回 ══');
[['personal_leave', true, '事假扣款'], ['sick_leave', true, '病假扣款'],
 ['family_leave', true, '家庭照顧假（新假別自動涵蓋）'], ['sick_hosp_leave', true, '住院傷病假'],
 ['shortfall_hours', true, '不足時數倒扣'], ['dormitory', true, '宿舍代扣（2026-08-24 起）'],
 ['labor_ins', true, '勞保自付（2026-08-24 起改扣，移到保險成本）'],
 ['health_ins', true, '健保自付（同上）'], ['group_ins', true, '團保自付（同上）'],
 ['pension', true, '退休金自付（同上）'],
 ['custom_ded', false, '自訂扣款（不扣）'],
].forEach(([k, want, label]) => chk(`  ${label}`, isReduce(k), want));

console.log('\n══ 1b) 自付額 vs 宿舍：一個要加回保險成本、一個不用 ══');
chk('  勞保自付＝代扣代繳（要加回）', isInsSelf('labor_ins'), true);
chk('  健保自付＝代扣代繳', isInsSelf('health_ins'), true);
chk('  退休金自付＝代扣代繳', isInsSelf('pension'), true);
chk('  宿舍不是代扣代繳（留在公司＝租金收入）', isInsSelf('dormitory'), false);
chk('  請假扣款不是代扣代繳', isInsSelf('sick_leave'), false);

console.log('\n══ 2) 儀表板趨勢／集團總覽用同一口徑 ══');
{
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'run') return [{ ym:'2026-08', store:'SSLGF', emp_id:'Y01', gross:40000, net:35000,
        total_hours:180, support_hours:0, surplus_hours:0, ot_paid_hours:0, is_full_time:'true', status:'draft' }];
      if (kind === 'item') return [
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'sick_leave',      item_type:'deduction', amount:600 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'shortfall_hours', item_type:'deduction', amount:400 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'dormitory',       item_type:'deduction', amount:3500 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'labor_ins',       item_type:'deduction', amount:758 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'health_ins',      item_type:'deduction', amount:470 }];
      return [];
    };
    payConfig = function(){ return {}; };
    payStoreList = function(){ return [{code:'SSLGF', name:'光復'}]; };
  `, sb);
  // 應收 40000 − (病假600 + 不足400 + 宿舍3500 + 勞保758 + 健保470) = 34272
  const t = vm.runInContext('handlePayrollTrend', sb)({ admin_key: 'x', store: 'SSLGF', ym: '2026-08', months: 1 });
  chk('  趨勢薪資費用：40000−(600+400+3500+758+470)=34272', t.months[0].salary_cost, 34272);
  chk('  自付額有單獨回報', t.months[0].ins_self, 1228);
  chk('  保險成本＝公司負擔0＋自付額1228', t.months[0].company, 1228);
  // ⚠ 關鍵：自付額只是換位置，人事總成本不可以變少
  chk('  人事總成本＝34272+1228=35500（與只扣宿舍時相同）', t.months[0].total_cost, 35500);
  const gp = vm.runInContext('handlePayrollGroup', sb)({ admin_key: 'x', ym: '2026-08' });
  chk('  集團總覽薪資費用同口徑', gp.rows[0].salary_cost, 34272);
  chk('  集團總覽總成本也不變', gp.rows[0].total_cost, 35500);
}

console.log('\n══ 3) 三處程式碼口徑一致（防止只改一處造成報表打架）══');
chk('  payroll.html 有把宿舍併入成本扣除', /item_key==='dormitory'/.test(HTML), true);
chk('  payroll.html 有「減：宿舍代扣」列', /減：宿舍代扣/.test(HTML), true);
chk('  payroll.html 有獨立的宿舍收入區塊', /宿舍收入/.test(HTML), true);
chk('  宿舍收入區塊標明勿重複計列', /勿重複計列/.test(HTML), true);
chk('  mock 兩處都納入 dormitory', (MOCK.match(/k==='dormitory'/g) || []).length, 2);

console.log('\n══ 4) 請假扣款／不足倒扣要扣進所屬科目（2026-08-24 Eason：損益表只認列實際值）══');
chk('  有分開累計正職／計時的扣款', /reduceFT/.test(HTML) && /reducePT/.test(HTML), true);
chk('  正職科目扣掉 reduceFT', /g\.base-g\.reduceFT/.test(HTML), true);
chk('  PT 科目扣掉 reducePT', /g\.pt-g\.reducePT/.test(HTML), true);
chk('  不再有獨立的「減：請假扣款」列（否則會扣兩次）', /減：請假扣款/.test(HTML), false);
chk('  小計不再重複減 g.reduce', /salaryGross-g\.reduce\b/.test(HTML), false);
chk('  參考明細標明已扣在科目內', /已扣在上方各科目內/.test(HTML), true);

console.log('\n══ 5) 勞健保自付額：從薪資費用扣除、加回保險成本（2026-08-24）══');
chk('  前端有自付額 key 清單', /INS_SELF_KEYS/.test(HTML), true);
chk('  正職科目扣掉 insFT', /g\.base-g\.reduceFT-g\.insFT/.test(HTML), true);
chk('  PT 科目扣掉 insPT', /g\.pt-g\.reducePT-g\.insPT/.test(HTML), true);
chk('  保險成本小計含自付額', /coTotal\+g\.ins/.test(HTML), true);
chk('  人事總成本含自付額（不可少算）', /salaryCost\+coTotal\+g\.ins/.test(HTML), true);
chk('  有「同仁自付額（代扣代繳」那一列', /同仁自付額（代扣代繳/.test(HTML), true);
chk('  mock 兩處同步自付額', (MOCK.match(/'labor_ins','health_ins','group_ins','pension'/g) || []).length, 2);

console.log(`\n${fail ? '❌ 有失敗' : '✅ 成本口徑三處一致'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
