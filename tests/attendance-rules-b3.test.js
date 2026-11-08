/* 出勤規範第 3 批（2026-11-08）：病假第 1 天起扣績效、忘刷以日計、非小辛辣只有請假日倒扣、計時加給只有小辛辣、國定假日按時數、離職當月折算特休 */
const fs=require('fs'), vm=require('vm');
const ROOT=require('path').join(__dirname,'..');
const P=fs.readFileSync(ROOT+'/apps-script/Payroll.gs','utf8'), C=fs.readFileSync(ROOT+'/apps-script/Code.gs','utf8');
const CLOCK={};
const sb={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sb); vm.runInContext(C+'\n'+P,sb);
sb.__CLOCK=CLOCK; sb.__DB={master:[],input:[],run:[]}; sb.__BASIS=()=>'all';
vm.runInContext(`payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};
 payRead=function(t){return (globalThis.__DB[t]||[]);};
 payEmpStoresMap=function(){return {};};
 var __c=payConfig; payConfig=function(st){var c=__c(st); c.attend_deduct_basis=globalThis.__BASIS(); return c;};`,sb);
const F=n=>vm.runInContext(n,sb);
let p=0,f=0; const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

// 6-6 病假第 1 天起
CLOCK.roster=[{emp_id:'E01',name:'測試一',active:true,key:'k'}]; CLOCK.events=[];
const ap=(d,st)=>({date:d,name:'測試一',emp_id:'E01',approved_hours:8,status_text:st,entered_at:'x',manager_name:'M'});
CLOCK.approved=[ap('2026-11-11','第一段下班無打卡'),ap('2026-11-12','遲到3分')];
CLOCK.leave=[{'日期':'2026-11-15','姓名':'測試一','假別':'病假','時數':8},{'日期':'2026-11-16','姓名':'測試一','假別':'病假','時數':4}];
let c=F('payCollect')('2026-11',6,'SSLGF',[])['E01'];
chk('光復 11 月：忘刷、遲到、兩天病假都扣',c.deduct_days,4);
chk('不再有 30 天內不扣的病假日',c.sick_dates,undefined);
c=F('payCollect')('2026-11',6,'MZTJS',[])['E01'];
chk('金山參數 all，11 月只算請假日',c.deduct_days,2);
chk('金山忘刷、遲到照算給門檻',[c.forget_day,c.late_min],[1,3]);
CLOCK.approved=CLOCK.approved.map(a=>Object.assign({},a,{date:a.date.replace('-11-','-10-')}));
CLOCK.leave=CLOCK.leave.map(a=>Object.assign({},a,{'日期':a['日期'].replace('-11-','-10-')}));
c=F('payCollect')('2026-10',6,'MZTJS',[])['E01'];
chk('金山 10 月照舊',c.deduct_days,4);
sb.__BASIS=()=>'leave'; c=F('payCollect')('2026-11',6,'CF',[])['E01']||{}; sb.__BASIS=()=>'all';

// 判斷函式
chk('小辛辣光復不算只有請假日',F('payPerfLeaveOnly_')('SSLGF','2026-11',{attend_deduct_basis:'all'}),false);
chk('小辛辣總部不算只有請假日',F('payPerfLeaveOnly_')('SSLHQ','2026-11',{attend_deduct_basis:'all'}),false);
chk('文心 11 月只算請假日',F('payPerfLeaveOnly_')('MZTWX','2026-11',{attend_deduct_basis:'all'}),true);
chk('文心 10 月照參數',F('payPerfLeaveOnly_')('MZTWX','2026-10',{attend_deduct_basis:'all'}),false);

// 2-3 忘刷、績效
const FT={emp_id:'A',is_full_time:'true',base:30000,attend_cap:3000,ot_rate:200,hire_date:'2020-01-15',store:'CF'};
const cfg=Object.assign({},F('payConfig')('CF'),{attend_deduct_per_day:100,attend_void_forget:3,attend_void_late_min:11,attend_forget_unit:'punch',pt_attend_plus:10,pt_tenure_plus:10,pt_tenure_months:6});
const bonus=(e,ym,att)=>{const r=F('payCalcOne')(e,ym,Object.assign({hours:184,deduct_days:0,forget_punch:0,forget_day:0,late_min:0,early_min:0,support:[]},att),cfg,0,[]);return r.earn.find(x=>x.item_key==='attend_bonus').amount;};
chk('11 月同一天漏多張：4 張 2 天不歸零',bonus(FT,'2026-11',{forget_punch:4,forget_day:2}),3000);
chk('11 月第 3 天歸零',bonus(FT,'2026-11',{forget_punch:3,forget_day:3}),0);
chk('10 月照舊 3 張歸零',bonus(FT,'2026-10',{forget_punch:3,forget_day:2}),0);
chk('病假 2 天扣 200',bonus(FT,'2026-11',{deduct_days:2}),2800);
cfg.attend_void_forget=0; chk('光復沒有門檻時，忘刷不歸零',bonus(Object.assign({},FT,{store:'SSLGF'}),'2026-11',{forget_punch:9,forget_day:9}),3000); cfg.attend_void_forget=3;

// 6-4 計時加給
const PT=(s)=>({emp_id:'B',is_full_time:'false',wage:200,hire_date:'2020-01-15',store:s});
const pt=(s,ym)=>{const r=F('payCalcOne')(PT(s),ym,{hours:120,deduct_days:0,full_attend:true,forget_punch:0,forget_day:0,late_min:0,early_min:0,support:[]},cfg,0,[]);return ['pt_attend_plus','pt_tenure_plus'].map(k=>(r.earn.find(x=>x.item_key===k)||{}).amount||0);};
chk('光復 11 月兩種加給都有',pt('SSLGF','2026-11'),[1200,1200]);
chk('小辛辣總部 11 月兩種加給都有',pt('SSLHQ','2026-11'),[1200,1200]);
chk('金山 11 月歸 0',pt('MZTJS','2026-11'),[0,0]);
chk('央廚 11 月歸 0',pt('CF','2026-11'),[0,0]);
chk('金山 10 月照舊',pt('MZTJS','2026-10'),[1200,1200]);

// 6-3 國定假日
const sum=(h)=>F('payOtDailySum')({dates:['2026-12-25'],sched:{'2026-12-25':{t:'W'}},day_h:{'2026-12-25':h},day_leave:{},hol:{'2026-12-25':true},until:'2026-12-31',comp_h:0,extra_ot:0});
const items=(S)=>{const a=[];F('payOtDailyItems')(S,true,24000,0,(k,l,q,r,amt)=>a.push([k,q,amt]));return a;};
chk('4H 只加發 4H × 100',items(sum(4)),[['ot_hol',4,400]]);
chk('8H 加發 800',items(sum(8)),[['ot_hol',8,800]]);
chk('10H：800＋平日加班 2H',items(sum(10)),[['ot_w43',2,268],['ot_hol',8,800]]);
chk('沒上班不發',items(sum(0)),[]);

// 6-10 離職當月
const me=(extra)=>Object.assign({emp_id:'F',name:'測試二',store:'SSLGF',is_full_time:'true',hire_date:'2024-03-20',active:'true',leave_date:''},extra);
CLOCK.leave=[{'日期':'2026-05-01','姓名':'測試二','假別':'特休','時數':8}];
const info=(e,ym)=>{sb.__DB.master=[e];return F('payAnnualInfo')(ym,'SSLGF')['F'];};
let a=info(me({leave_date:'2026-11-10'}),'2026-11');
chk('離職當月：折算月＝當月',a.payout_ym,'2026-11');
chk('2 年 10 天，已用 1 天，剩 72H',[a.days,a.left_h],[10,72]);
a=info(me({leave_date:''}),'2026-11');
chk('沒離職：折算月維持週年',a.payout_ym,'2027-03');
a=info(me({leave_date:'2026-12-05'}),'2026-11');
chk('下個月才離職：這個月不折算',a.payout_ym,'2027-03');
a=info(me({leave_date:'2026-10-05'}),'2026-10');
chk('10 月離職不套新規則',a.payout_ym,'2027-03');
// 週年日還沒到就離職：用上一個週年期
a=info(me({hire_date:'2024-11-20',leave_date:'2026-11-10'}),'2026-11');
chk('11/20 週年，11/10 離職：用上一期 7 天',[a.days,a.ps,a.payout_ym],[7,'2025-11-20','2026-11']);
a=info(me({hire_date:'2024-11-05',leave_date:'2026-11-10'}),'2026-11');
chk('11/5 週年，11/10 離職：用新一期 10 天',[a.days,a.ps],[10,'2026-11-05']);
a=info(me({hire_date:'2026-05-20',leave_date:'2026-11-10'}),'2026-11');
chk('未滿 6 個月離職：沒有特休',[a.days,a.left_h],[0,0]);
console.log(f?`\n❌ 失敗 ${f}`:`\n✅ 全部通過 (${p}/${p})`); process.exit(f?1:0);
