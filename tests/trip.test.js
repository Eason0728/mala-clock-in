/* 出差：時數照算、不扣全勤、不給餐費補助、狀態標「出差」 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const CLOCK={};
const sb={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sb); vm.runInContext(C+'\n'+P,sb);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};',sb);
sb.__CLOCK=CLOCK;
const call=(fn,...a)=>vm.runInContext(fn,sb)(...a);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const emp={emp_id:'E01',name:'張三',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:80,active:'true'};
const T=call('payLeaveTypes','');
let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

function setup(leaveType){
  CLOCK.roster=[{emp_id:'E01',name:'張三',active:true,key:'k'}];
  CLOCK.events=[];
  // 兩天各核定 9 小時（主管補登），其中一天標 leaveType
  CLOCK.approved=[
    {date:'2026-07-01',name:'張三',emp_id:'E01',approved_hours:9,status_text:'正常',entered_at:'x',manager_name:'M'},
    {date:'2026-07-02',name:'張三',emp_id:'E01',approved_hours:9,status_text:'正常',entered_at:'x',manager_name:'M'}];
  CLOCK.leave = leaveType ? [{'日期':'2026-07-02','姓名':'張三','假別':leaveType,'時數':''}] : [];
  return call('payCollect','2026-07',6,'SSLGF',[])['E01']||{};
}
function calc(c){
  const att=Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,leave_usage:{},meal_on:true},c);
  const r=call('payCalcOne',emp,'2026-07',att,cfg,4,T);
  const g=k=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x?x.amount:0;};
  return {r,g};
}
console.log('══ 沒標出差（對照組）══');
let c=setup(null);
chk('  總時數 18H',        c.hours, 18);
chk('  缺勤天數 0',        c.deduct_days, 0);
chk('  餐費出勤 2 天',     c.work_days, 2);
chk('  餐費補助 2×80',     calc(c).g('meal_sub'), 160);

console.log('\n══ 其中一天標「出差」══');
c=setup('出差');
chk('  總時數還是 18H（照算）', c.hours, 18);
chk('  缺勤天數 0（不扣全勤）', c.deduct_days, 0);
chk('  餐費出勤剩 1 天',       c.work_days, 1);
chk('  餐費補助只給 1×80',     calc(c).g('meal_sub'), 80);
chk('  沒有產生扣款列',        calc(c).g('trip_leave'), 0);
chk('  全勤獎金全額',          calc(c).g('attend_bonus'), 3000);

console.log('\n══ 對照：標「事假」──應該扣錢也扣全勤 ══');
c=setup('事假');
chk('  缺勤天數 1',        c.deduct_days, 1);
chk('  全勤被扣 100',      calc(c).g('attend_bonus'), 2900);

console.log('\n══ 核定狀態：出差不標「該段無打卡」══');
const cas=vm.runInContext('computeApprovalStatus',sb);
const periods=[{startMs:new Date('2026-07-02T09:00:00+08:00').getTime(),endMs:new Date('2026-07-02T18:00:00+08:00').getTime()}];
chk('  一般沒打卡 → 該段無打卡', cas(periods,[],false,false), '該段無打卡');
chk('  出差 → 出差',             cas(periods,[],false,true),  '出差');
console.log(`\n${f?'❌ 有失敗':'✅ 出差全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
