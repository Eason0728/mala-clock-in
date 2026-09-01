/* 人事成本口徑——Eason 在 2026-08-24 一天內調整了四輪，這支獨立守住最終版。
 *
 * 現行定義：薪資費用小計 ＝ 應收 −（請假扣款 ＋ 不足時數倒扣 ＋ 宿舍代扣 ＋ 勞健保自付額 ＋ 自訂加薪）
 *   ✔ 請假扣款：任何 /_leave$/（新假別自動涵蓋，不必逐一列舉）
 *   ✔ 不足時數倒扣 shortfall_hours
 *   ✔ 宿舍代扣 dormitory —— 同仁付給公司的房租，錢**留在公司**；下方另列成租金收入
 *   ✔ 勞健保／團保／退休金自付額 —— 代扣後**要繳給勞保局**，所以扣掉之後**必須加回保險成本**
 *     （payIsInsSelfKey），否則人事總成本會憑空少一筆。這是它與宿舍的關鍵差異。
 *   ✔ 自訂加薪／扣款（custom_add／custom_ded）—— 性質不定（行銷補助、補發…），科目要人自己判斷，
 *     所以**不計入薪資費用**、在成本分類獨立列出。⚠ 同仁薪資單是另一條路徑（my_payslip 回完整
 *     earn/ded），**照舊看得到**，不可因為成本口徑而被過濾掉。
 *
 * ⚠ 呈現原則：以上四種**全部扣進所屬科目**（正職→薪資費用／正職、計時→薪資費用／PT），
 *   表上**不再有任何獨立減項列**——列了就會扣兩次。所以「薪資費用／PT」那列
 *   恰好等於計時同仁的實付總額，每一列都是損益表可直接認列的實際值。
 *
 * 三處必須同口徑：Payroll.gs payIsReduceKey（儀表板趨勢／集團總覽）、
 * payroll.html（cutNote／baseNet／ptNet 那段）、mock/payroll_mock.js isReduce（兩處）。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
// ⚠ mock/payroll_mock.js 含真實薪資，是 gitignore 的 → CI（GitHub runner）上不存在。
//    這支測試依賴它，檔案不在就整支跳過而不是失敗；本機開發照樣會跑到。
const MOCK_PATH = path.join(__dirname, '..', 'mock', 'payroll_mock.js');
if (!fs.existsSync(MOCK_PATH)) {
  console.log('⊘ 略過：mock/payroll_mock.js 不存在（gitignore，CI 上沒有這個檔）');
  process.exit(0);
}
const MOCK = fs.readFileSync(MOCK_PATH, 'utf8');

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
// 2026-08-24 起宿舍也扣進所屬科目，不再有獨立減項列（列了會扣兩次）
chk('  不再有獨立的「減：宿舍代扣」列', /減：宿舍代扣/.test(HTML), false);
chk('  正職科目扣掉 dormFT', /g\.base-g\.reduceFT-g\.insFT-g\.dormFT/.test(HTML), true);
chk('  PT 科目扣掉 dormPT', /g\.pt-g\.reducePT-g\.insPT-g\.dormPT/.test(HTML), true);
chk('  小計不再重複減 g.dorm', /salaryGross-g\.dorm/.test(HTML), false);
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

console.log('\n══ 6) 公司負擔：後端改為依主檔逐人加總，與成本分類頁一致（2026-08-24）══');
{
  /* 事故：這三項早改成「員工設定逐人填、自動加總」，但只有前端跟上，
     儀表板／集團總覽仍讀參數手填值 → 央廚實測差 40,365。
     折算規則必須與 payroll.html 一致：勞保／退休金 ×在職比例、健保整月。 */
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'master') return [
        // 光復兩人：一位整月正職、一位月中到職（ratio 0.5）
        { emp_id:'A', store:'SSLGF', co_labor:1000, co_health:400, co_pension:600 },
        { emp_id:'B', store:'SSLGF', co_labor:1000, co_health:400, co_pension:600 },
        // 央廚一人，主檔有填
        { emp_id:'C', store:'CF',    co_labor:2000, co_health:800, co_pension:1200 }];
      if (kind === 'run') return [
        { ym:'2026-08', store:'SSLGF', emp_id:'A', gross:30000, net:30000, is_full_time:'true',  ratio:1,   total_hours:0, support_hours:0, surplus_hours:0, ot_paid_hours:0, status:'draft' },
        { ym:'2026-08', store:'SSLGF', emp_id:'B', gross:20000, net:20000, is_full_time:'true',  ratio:0.5, total_hours:0, support_hours:0, surplus_hours:0, ot_paid_hours:0, status:'draft' },
        { ym:'2026-08', store:'CF',    emp_id:'C', gross:40000, net:40000, is_full_time:'false', ratio:1,   total_hours:0, support_hours:0, surplus_hours:0, ot_paid_hours:0, status:'draft' }];
      if (kind === 'item') return [];
      return [];
    };
    // 參數手填值刻意設成明顯不同的數字，用來確認「逐人加總有蓋過參數」
    payConfig = function(){ return { co_labor:99999, co_health:99999, co_pension:99999,
                                     co_owner:500, co_group:300 }; };
    payStoreList = function(){ return [{code:'SSLGF',name:'光復'},{code:'CF',name:'央廚'}]; };
  `, sb);
  // 光復：勞保 1000×1 + 1000×0.5 = 1500；健保 400+400 = 800（整月不折算）；退休金 600×1+600×0.5 = 900
  //       ＋負責人 500 ＋團險 300 = 4000
  const t = vm.runInContext('handlePayrollTrend', sb)({ admin_key:'x', store:'SSLGF', ym:'2026-08', months:1 });
  chk('  光復公司負擔＝逐人加總 3200＋負責人500＋團險300', t.months[0].company, 4000);
  chk('  沒有用到參數手填的 99999', t.months[0].company < 99999, true);
  chk('  健保不按在職比例折算（800 而非 600）',
      t.months[0].company - 1500 - 900 - 500 - 300, 800);
  const gp = vm.runInContext('handlePayrollGroup', sb)({ admin_key:'x', ym:'2026-08' });
  const gf = gp.rows.find(r => r.store === 'SSLGF'), cf = gp.rows.find(r => r.store === 'CF');
  chk('  集團總覽光復同值', gf.company, 4000);
  // 央廚：計時 ratio 不折算 → 2000+800+1200 = 4000 ＋負責人500＋團險300 = 4800
  chk('  集團總覽央廚＝4000＋800', cf.company, 4800);
  chk('  兩店各自加總、不互相污染', gf.company !== cf.company, true);
}

console.log('\n══ 7) 主檔沒填公司負擔時，退回參數手填值（不可變成 0）══');
{
  vm.runInContext(`
    payRead = function(kind){
      if (kind === 'master') return [{ emp_id:'A', store:'HQ', co_labor:0, co_health:0, co_pension:0 }];
      if (kind === 'run') return [{ ym:'2026-08', store:'HQ', emp_id:'A', gross:10000, net:10000,
        is_full_time:'true', ratio:1, total_hours:0, support_hours:0, surplus_hours:0, ot_paid_hours:0, status:'draft' }];
      if (kind === 'item') return [];
      return [];
    };
    payConfig = function(){ return { co_labor:1000, co_health:400, co_pension:600, co_owner:500, co_group:300 }; };
    payStoreList = function(){ return [{code:'HQ',name:'總部'}]; };
  `, sb);
  const t = vm.runInContext('handlePayrollTrend', sb)({ admin_key:'x', store:'HQ', ym:'2026-08', months:1 });
  chk('  退回參數值 1000+400+600+500+300', t.months[0].company, 2800);
}

console.log('\n══ 8) 自訂加薪／扣款不計入薪資費用，獨立列出（2026-08-24）══');
{
  /* Eason：自訂加薪可能是行銷補助、補發之類，科目要自己判斷，不該混進人事費用。
     ⚠ 同仁薪資單是另一條路徑（my_payslip 回完整 earn/ded），**照舊看得到**，不可因此被過濾掉。*/
  vm.runInContext(`
    checkAdmin = function(){ return true; };
    payRead = function(kind){
      if (kind === 'run') return [{ ym:'2026-08', store:'SSLGF', emp_id:'Y01', gross:40000, net:39000,
        total_hours:180, support_hours:0, surplus_hours:0, ot_paid_hours:0, is_full_time:'true', ratio:1, status:'draft' }];
      if (kind === 'item') return [
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'custom_add', item_type:'earning',   amount:250 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'custom_ded', item_type:'deduction', amount:300 },
        { ym:'2026-08', store:'SSLGF', emp_id:'Y01', item_key:'sick_leave', item_type:'deduction', amount:600 }];
      if (kind === 'master') return [];
      return [];
    };
    payConfig = function(){ return { co_owner:0, co_group:0 }; };
    payStoreList = function(){ return [{code:'SSLGF',name:'光復'}]; };
  `, sb);
  // 應收 40000 − 病假600 − 自訂加薪250 = 39150（自訂扣款 300 不在 gross 裡，不必再扣）
  const t = vm.runInContext('handlePayrollTrend', sb)({ admin_key:'x', store:'SSLGF', ym:'2026-08', months:1 });
  chk('  趨勢：自訂加薪不計入薪資費用', t.months[0].salary_cost, 39150);
  const gp = vm.runInContext('handlePayrollGroup', sb)({ admin_key:'x', ym:'2026-08' });
  chk('  集團總覽同口徑', gp.rows[0].salary_cost, 39150);
}
chk('前端把自訂加薪抽出、不進 PT/其他津貼', /k==='custom_add'\).*custAdd/.test(HTML.replace(/\n/g,' ')), true);
chk('前端把自訂扣款抽出', /item_key==='custom_ded'/.test(HTML), true);
chk('成本分類有自訂項目獨立區塊', /自訂加薪／扣款 · 不計入上方薪資費用/.test(HTML), true);
chk('⚠ 同仁薪資單不受影響（my_payslip 仍回完整明細）',
    /payRunItemsToResult\(run, items\)/.test(fs.readFileSync(path.join(__dirname,'..','apps-script','Payroll.gs'),'utf8')), true);

console.log(`\n${fail ? '❌ 有失敗' : '✅ 成本口徑三處一致'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
