/* 22 種假別逐一走完整條鏈：leave 分頁 → payCollect → payCalcOne，驗證扣款金額 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const CLOCK={};
const sandbox={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sandbox); vm.runInContext(C+'\n'+P,sandbox);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};',sandbox);
sandbox.__CLOCK=CLOCK;
const call=(fn,...a)=>vm.runInContext(fn,sandbox)(...a);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const mk=h=>({emp_id:'E01',name:'張三',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:h,leave_date:'',meal_allow:0,active:'true'});
const rate=Math.round((30000+3000+3000+0+3000)/30/8);
const T=call('payLeaveTypes','');

console.log('假別名（值班核定下拉看到的）        →  對到  給薪   8H的扣款   預期     結果');
console.log('─'.repeat(88));
let p=0,f=0;
for(const t of T){
  CLOCK.roster=[{emp_id:'E01',name:'張三',active:true,key:'k1'}];
  CLOCK.approved=[{date:'2026-07-05',name:'張三',emp_id:'E01',approved_hours:0,status_text:'正常',
    entered_at:'2026-07-05T20:00',manager_name:'M'}];
  CLOCK.events=[];
  CLOCK.leave=[{'日期':'2026-07-05','姓名':'張三','假別':t.name,'時數':8}];
  const c=call('payCollect','2026-07',6,'SSLGF',[])['E01']||{};
  const att=Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,leave_usage:{}},c);
  // 年資 5 年以上（產假不減半）
  const r=call('payCalcOne',mk('2019-01-01'),'2026-07',att,cfg,4,T);
  const line=(r.ded||[]).find(i=>i.item_key===t.code+'_leave');
  const got=line?line.amount:0;
  const want=Math.round(8*Math.round(rate*(1-t.pay_ratio)));
  const codeOK=(c.leaves||{})[t.code]===8;
  const ok=codeOK&&got===want; ok?p++:f++;
  console.log(`${(ok?'✓ ':'✗ ')}${t.name.padEnd(24)} ${(codeOK?t.code:'✗對不到').padEnd(14)} ${String(t.pay_ratio*100).padStart(3)}%  ${String(got).padStart(7)}  ${String(want).padStart(7)}`);
}
// 產假年資減半（未滿 6 個月）
CLOCK.leave=[{'日期':'2026-07-05','姓名':'張三','假別':'產假（分娩）','時數':8}];
const c2=call('payCollect','2026-07',6,'SSLGF',[])['E01']||{};
const r2=call('payCalcOne',mk('2026-05-01'),'2026-07',Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,leave_usage:{}},c2),cfg,4,T);
const m=(r2.ded||[]).find(i=>i.item_key==='maternity_leave');
const wantHalf=8*Math.round(rate*0.5);
const ok2=(m?m.amount:0)===wantHalf; ok2?p++:f++;
console.log('─'.repeat(88));
console.log((ok2?'✓ ':'✗ ')+'產假 年資未滿6個月 → 減半扣款: '+(m?m.amount:0)+(ok2?'':' ← 應為 '+wantHalf));
console.log(`\n${f?'❌ 有 '+f+' 項失敗':'✅ 22 種假別端對端全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
