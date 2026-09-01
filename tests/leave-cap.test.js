/* 跨月額度累計：payLeaveUsedBefore 從 leave 分頁掃整個曆年，算出「本月之前已用幾日」 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const CLOCK={},PAY={};
const sandbox={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sandbox); vm.runInContext(C+'\n'+P,sandbox);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};'
 +'payRead=function(k){return (globalThis.__PAY[k]||[]);};'
 +'payEmpStoresMap=function(){return {E01:["SSLGF"]};};',sandbox);
sandbox.__CLOCK=CLOCK; sandbox.__PAY=PAY;
const call=(fn,...a)=>vm.runInContext(fn,sandbox)(...a);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const emp={emp_id:'E01',name:'張三',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:0,active:'true'};
const rate=Math.round((30000+3000+3000+0+3000)/30/8);
const T=call('payLeaveTypes','');
let p=0,f=0;
const chk=(n,g,w)=>{const ok=g===w;ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+g+(ok?'':' ← 應為 '+w));};

// 1~6 月每月請 5 天病假 = 30 天，7 月再請 2 天
CLOCK.leave=[]; PAY.input=[]; PAY.master=[emp];
for(let m=1;m<=6;m++) for(let d=1;d<=5;d++)
  CLOCK.leave.push({'日期':`2026-0${m}-0${d}`,'姓名':'張三','假別':'病假','時數':8});

const used=call('payLeaveUsedBefore','2026-07','SSLGF',T,cfg,[emp]);
chk('7月之前已用病假日數', used.E01.sick.used_before_days, 30);

// 7 月再請 2 天 → 全部逾上限 → 無薪全扣
CLOCK.leave.push({'日期':'2026-07-01','姓名':'張三','假別':'病假','時數':8});
CLOCK.leave.push({'日期':'2026-07-02','姓名':'張三','假別':'病假','時數':8});
CLOCK.roster=[{emp_id:'E01',name:'張三',active:true,key:'k1'}]; CLOCK.approved=[]; CLOCK.events=[];
const c=call('payCollect','2026-07',6,'SSLGF',[])['E01']||{};
chk('7月歸集病假 16H', c.leaves.sick, 16);
const att=Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,
  leave_usage:used.E01},c);
const r=call('payCalcOne',emp,'2026-07',att,cfg,4,T);
const line=(r.ded||[]).find(i=>i.item_key==='sick_leave');
chk('已用滿30日 → 16H 全額扣（不是半薪）', line?line.amount:0, 16*rate);
console.log('   項目名：', line?line.item_label:'(無)');

// 對照：若之前只用了 28 日，7 月的 16H 應該是 2日半薪 + 0日全扣
const used2={sick:{used_before_days:28}};
const r2=call('payCalcOne',emp,'2026-07',Object.assign({},att,{leave_usage:used2}),cfg,4,T);
const l2=(r2.ded||[]).find(i=>i.item_key==='sick_leave');
chk('已用28日 → 16H 全在額度內＝半薪', l2?l2.amount:0, 16*Math.round(rate*0.5));

// 家庭照顧假併入事假額度
CLOCK.leave=[];
for(let d=1;d<=7;d++) CLOCK.leave.push({'日期':`2026-03-0${d}`,'姓名':'張三','假別':'家庭照顧假','時數':8});
const u3=call('payLeaveUsedBefore','2026-07','SSLGF',T,cfg,[emp]);
chk('家庭照顧假 7 天 → 吃掉事假額度 7 日', u3.E01.personal.used_before_days, 7);

console.log(`\n${f?'❌ 有失敗':'✅ 跨月額度累計全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
