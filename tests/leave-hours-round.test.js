/* 假別時數一律四捨五入到小數第一位（2026-10-05）
 * 舊版先把天數取到兩位再 ×8：事假 44.5H → 5.5625 天 → 5.56 天 → 44.48H。
 * 現在 used_h／cap_h／remain_h 直接由未取整的天數換算。 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const sandbox={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sandbox); vm.runInContext(C+'\n'+P,sandbox);
vm.runInContext('payRead=function(k){return [];};payClockRead=function(){return [];};',sandbox);
const call=(fn,...a)=>vm.runInContext(fn,sandbox)(...a);
const T=call('payLeaveTypes','');
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8};
let p=0,f=0;
const chk=(n,g,w)=>{const ok=g===w;ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+g+(ok?'':' ← 應為 '+w));};
// 事假 7＋10＋10＋17.5＝44.5H；病假 25.25＋50＋26＋38.5＋16.25＝156H；生理假 4.33H（測一位小數）
const flat=[
 ['personal','2026-01-01',7],['personal','2026-06-01',10],['personal','2026-07-01',10],['personal','2026-09-01',17.5],
 ['sick','2026-05-01',25.25],['sick','2026-06-01',50],['sick','2026-07-01',26],['sick','2026-08-01',38.5],['sick','2026-09-01',16.25],
 ['menstrual','2026-08-03',4.33],
].map(([code,date,hours])=>({emp_id:'E07',code,date,hours}));
const q=call('payLeaveUsage','E07','2026-10',T,cfg,null,flat,[]);
chk('事假已用 44.5H（不是 44.48）',q.personal.used_h,44.5);
chk('事假剩餘＝112−44.5',q.personal.remain_h,67.5);
chk('病假已用 156H',q.sick.used_h,156);
chk('病假剩餘 84H',q.sick.remain_h,84);
chk('生理假 4.33H → 4.3H',q.menstrual.used_h,4.3);
chk('上限照列',q.sick.cap_h,240);
chk('payR1(12.25)=12.3',call('payR1',12.25),12.3);
console.log(f?`\n❌ 失敗 ${f}`:`\n✅ 全部通過 (${p}/${p})`); process.exit(f?1:0);
