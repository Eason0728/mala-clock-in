/* 出勤規範第 1 批（2026-11-08）：婚假 14 天、生理假 3 次全薪、家庭照顧假超過 7 天才併入事假、計時特休 2088 與未投保排除 */
const fs=require('fs'), vm=require('vm');
const ROOT=require('path').join(__dirname,'..');
const P=fs.readFileSync(ROOT+'/apps-script/Payroll.gs','utf8'), C=fs.readFileSync(ROOT+'/apps-script/Code.gs','utf8');
const sandbox={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sandbox); vm.runInContext(C+'\n'+P,sandbox);
vm.runInContext('payRead=function(k){return [];};payClockRead=function(){return [];};',sandbox);
const call=(fn,...a)=>vm.runInContext(fn,sandbox)(...a);
let p=0,f=0; const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};
const T=call('payLeaveTypes','');
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8};
const tOf=c=>T.filter(t=>t.code===c)[0];
chk('婚假上限 14 天',tOf('marriage').cap_days,14);
chk('婚假工資照給',tOf('marriage').pay_ratio,1);
chk('生理假預設全薪',tOf('menstrual').pay_ratio,1);
// 生理假看次數：3 次 4H 就用完額度，第 4 次的超過部分併入病假
const rows=(c,ds,h)=>ds.map(d=>({emp_id:'E1',code:c,date:d,hours:h}));
let q=call('payLeaveUsage','E1','2026-11',T,cfg,null,rows('menstrual',['2026-01-05','2026-02-05','2026-03-05'],4),[]);
chk('3 次 4H 算用掉 3 次＝24H',q.menstrual.used_h,24);
chk('第 3 次後額度歸零',q.menstrual.remain_h,0);
chk('還沒超過，不併入病假',q.sick.used_h,0);
q=call('payLeaveUsage','E1','2026-11',T,cfg,null,rows('menstrual',['2026-01-05','2026-02-05','2026-03-05','2026-04-05'],4),[]);
chk('第 4 次併入病假 8H',q.sick.used_h,8);
// 家庭照顧假：7 天內不吃事假，超過才吃
q=call('payLeaveUsage','E1','2026-11',T,cfg,null,rows('family',['2026-01-05','2026-02-05'],8),[]);
chk('家庭照顧假 2 天不併入事假',q.personal.used_h,0);
const eight=[...Array(8).keys()].map(i=>'2026-05-'+('0'+(i+1)).slice(-2));
q=call('payLeaveUsage','E1','2026-11',T,cfg,null,rows('family',eight,8),[]);
chk('家庭照顧假 8 天只有第 8 天併入事假',q.personal.used_h,8);
// 計時特休比例
chk('全時每月工時＝2088÷12',call('eval','PAY_PT_FULL_MONTH_H'),174);
chk('有勞保自付算投保',call('payPtInsured_',{labor_ins:500}),true);
chk('公司負擔有填算投保',call('payPtInsured_',{co_labor:900}),true);
chk('兩邊都沒填算未投保',call('payPtInsured_',{}),false);
chk('份額數字：87H÷174＝0.5',call('payPtAnnualRatio',[{ym:'2026-10',emp_id:'E1',total_hours:87,support_hours:0}],'E1','2026-11'),0.5);
// 生理假薪資：正職 rate＝30000÷30÷8＝125，半薪扣 63
const e={emp_id:'E1',name:'A',is_full_time:true,base:30000,attend_cap:0,hire_date:'2024-01-01',active:true};
const fullCfg=Object.assign({},cfg,{attend_deduct_per_day:0,sick_ratio:0.5,late_deduct:false});
function menDed(ym,before,h){
  const att={hours:176,total_hours:176,menstrual_h:h,leave_usage:{menstrual:{used_before_days:before}}};
  const r=vm.runInContext('payCalcOne',sandbox)(e,ym,att,fullCfg,8,T);
  const it=r.ded.filter(d=>d.key==='menstrual_leave'||d.item_key==='menstrual_leave'||d.code==='menstrual_leave')[0];
  return it?it.amount:0;
}
chk('11 月第 1 次：全薪不扣',menDed('2026-11',0,8),0);
chk('11 月第 3 次：全薪不扣',menDed('2026-11',2,8),0);
chk('11 月第 4 次：算病假半薪',menDed('2026-11',3,8),8*63);
chk('10 月照舊半薪',menDed('2026-10',0,8),8*63);
console.log(f?`\n❌ 失敗 ${f}`:`\n✅ 全部通過 (${p}/${p})`); process.exit(f?1:0);
