/* 新舊引擎對拆：node tests/engine-diff.js <舊版 Payroll.gs> <新版 Payroll.gs> [--strict]
 *   （根目錄的 diff_engines.js 只是轉呼叫這支，參數原樣傳）
 * 第一區：2026-06／07／08／02 四個月 2160 組——金額必須完全相同，否則結束碼 1（跟以前一樣）。
 * 第二區：2026-09／10／11、2027-02（2026-11 另帶逐日資料 att.daily）——只列出不同的組合，不影響結束碼；
 *         加 --strict 時這一區有差異也回結束碼 1。
 * 舊版引擎少函式／算到一半丟例外：那一組記成「執行錯誤」並算成不同，整支照樣跑完。
 * 全部虛構同仁（代號），不含任何真實姓名與薪資。 */
const fs=require('fs');
const MARK_A='function payR0', MARK_B='/* ═══════════════════ Handlers';
function load(p){
  let fn=null, why='';
  try{
    const GS=fs.readFileSync(p,'utf8');
    const a=GS.indexOf(MARK_A), b=GS.indexOf(MARK_B);
    if(a<0||b<0) why='找不到引擎區段標記（function payR0 … Handlers）';
    else{
      const e={}; new Function('exports',"function pad2(n){return ('0'+n).slice(-2)}\n"+GS.slice(a,b)
        +"\nexports.payCalcOne=(typeof payCalcOne==='function')?payCalcOne:null;")(e);
      fn=e.payCalcOne; if(!fn) why='這一版沒有 payCalcOne';
    }
  }catch(x){ why='載入失敗：'+String((x&&x.message)||x); }
  if(!fn){ console.log('⚠ '+p+'：'+why+'（每一組都會記成執行錯誤）'); return function(){ throw new Error(why); }; }
  return fn;
}
const ARGS=process.argv.slice(2), STRICT=ARGS.indexOf('--strict')>=0, FILES=ARGS.filter(x=>!/^--/.test(x));
if(FILES.length<2){
  console.log('用法：node tests/engine-diff.js <舊版 Payroll.gs> <新版 Payroll.gs> [--strict]');
  process.exit(2);
}
const OLD=load(FILES[0]), NEW=load(FILES[1]);
// 單次呼叫包起來：丟例外不讓整支掛掉，回 {__err}
function call(F,e,ym,att,c,red){
  try{ return F(e,ym,JSON.parse(JSON.stringify(att)),c,red); }
  catch(x){ return {__err:String((x&&x.message)||x)}; }
}
const lines=r=>[].concat(r.earn||[],r.ded||[]);
// ⚠ payCalcOne 回的是 earn／ded 兩個陣列，沒有 items——寫錯欄位名會讓「逐項比對」變成空陣列比空陣列
// 分兩級：①「錢」必須完全一樣（金額/總額/項目/時數）②「單價顯示」允許不同並單獨統計
const money=r=>r.__err?JSON.stringify({err:r.__err}):JSON.stringify({g:r.gross,d:r.deduction,n:r.net,
  i:lines(r).map(x=>[x.item_key,x.qty,x.amount]).sort()});
const rates=r=>r.__err?'':JSON.stringify(lines(r).map(x=>[x.item_key,x.rate]).sort());

const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};

// 涵蓋：正職/計時 × 有無各種請假 × 支援 × 自訂加扣 × 獎金 × 月中到職
const emps=[
 {emp_id:'A',name:'正職',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,mgr_allow:0,
  attend_cap:3000,ot_rate:240,wage:0,labor_ins:758,health_ins:470,group_ins:0,pension:0,dormitory:2000,
  hire_date:'2021-10-01',leave_date:'',meal_allow:80,active:'true'},
 {emp_id:'B',name:'計時',is_full_time:'false',base:0,skill_allow:0,night_allow:0,mgr_allow:0,
  attend_cap:0,ot_rate:0,wage:200,labor_ins:300,health_ins:0,group_ins:0,pension:0,dormitory:0,
  hire_date:'2025-01-15',leave_date:'',meal_allow:0,active:'true'},
 {emp_id:'C',name:'月中到職',is_full_time:'true',base:32000,skill_allow:0,night_allow:0,mgr_allow:3000,
  attend_cap:2000,ot_rate:250,wage:0,labor_ins:758,health_ins:470,group_ins:200,pension:1800,dormitory:3500,
  hire_date:'2026-07-16',leave_date:'',meal_allow:100,active:'true'},
];
const atts=[];
const H=[0,120,184,200,240];
const LV=[{},{personal_h:8},{sick_h:16},{menstrual_h:8},{annual_h:24},{disaster_h:8},
          {personal_h:8,sick_h:8,annual_h:8},{sick_h:240},{personal_h:120}];
for(const h of H) for(const lv of LV) for(const sup of [[],[{store:'央廚',hours:16,rate:210,amount:''}]])
  for(const extra of [{},{extra_ot:10,custom_add_label:'獎勵',custom_add_amt:500,custom_ded_label:'借支',custom_ded_amt:300,meal_on:true,work_days:22,full_attend:true,holiday_h:16,bonuses:[{bonus_type:'sales',label:'業績',amount:3000}]}])
    atts.push(Object.assign({hours:h,extra_ot:0,deduct_days:2,support:sup,work_days:0,
      wage_override:0,dorm_override:'',meal_on:false,holiday_h:0,bonuses:[],
      custom_add_amt:0,custom_ded_amt:0},lv,extra));

/* ═════ 第一區：舊四個月 2160 組，必須完全相同 ═════ */
let n=0,bad=0,rateOnly=0;
const yms=['2026-06','2026-07','2026-08','2026-02'];
for(const e of emps) for(const ym of yms) for(const att of atts){
  const A=call(OLD,e,ym,att,cfg,8);
  const B=call(NEW,e,ym,att,cfg,8);
  n++;
  if(A.__err||B.__err){ bad++; if(bad<=3) console.log('✗ 執行錯誤：',e.name,ym,'｜舊：'+(A.__err||'正常')+'｜新：'+(B.__err||'正常')); }
  else if(money(A)!==money(B)){ bad++; if(bad<=3){console.log('✗ 金額不一致：',e.name,ym,JSON.stringify(att).slice(0,120));
    console.log('  舊',money(A).slice(0,300));console.log('  新',money(B).slice(0,300));} }
  else if(rates(A)!==rates(B)){ rateOnly++; if(rateOnly<=2){
    const ra=JSON.parse(rates(A)),rb=JSON.parse(rates(B));
    const d=ra.map((x,k)=>[x[0],x[1],rb[k][1]]).filter(x=>x[1]!==x[2]);
    console.log('· 只有單價顯示不同：',e.name,ym,JSON.stringify(d)); } }
}
console.log(`\n比對 ${n} 組情境（3 種員工 × 4 個月份 × ${atts.length} 種工時假別組合）`);
console.log(bad===0
  ? `✅ 金額逐項完全相同（項目／時數／金額／總額全對）—— 既有薪資數字不會有任何變動\n   其中 ${rateOnly} 組「單價顯示」不同：逾上限的假別會混兩種費率，單價欄改留空並在項目名標註`
  : `❌ ${bad} 組金額不一致`);

/* ═════ 第二區：2026-09／10／11、2027-02，只列差異 ═════ */
const NEW_YMS=['2026-09','2026-10','2026-11','2027-02'];
const RED={'2026-09':8,'2026-10':10,'2026-11':9,'2027-02':8};   // 紅字天數（對拆兩邊用同一個數字，只要一致）
const cfg2=Object.assign({},cfg,{late_deduct:true,late_div_days:30,late_div_hours:8});
const pad=x=>('0'+x).slice(-2);
const daysIn=ym=>new Date(Date.UTC(+ym.slice(0,4),+ym.slice(5,7),0)).getUTCDate();
// 這一區多四位：月中到職／離職要跟著月份走（每個月都是「當月」16 日到職、15 日離職）
function emps2(ym){
  return emps.concat([
   {emp_id:'D',name:'月中到職D',is_full_time:'true',base:32000,skill_allow:2000,night_allow:0,mgr_allow:0,
    attend_cap:3000,ot_rate:250,wage:0,labor_ins:758,health_ins:470,group_ins:0,pension:0,dormitory:3000,
    hire_date:ym+'-16',leave_date:'',meal_allow:80,active:'true',store:'SSLGF'},
   {emp_id:'E',name:'月中離職E',is_full_time:'true',base:30000,skill_allow:0,night_allow:3000,mgr_allow:0,
    attend_cap:3000,ot_rate:240,wage:0,labor_ins:758,health_ins:470,group_ins:0,pension:0,dormitory:0,
    hire_date:'2022-03-01',leave_date:ym+'-15',meal_allow:0,active:'true',store:'SSLGF'},
   {emp_id:'F',name:'計時月中到職F',is_full_time:'false',base:0,skill_allow:0,night_allow:0,mgr_allow:0,
    attend_cap:0,ot_rate:0,wage:195,labor_ins:300,health_ins:0,group_ins:0,pension:0,dormitory:1500,
    hire_date:ym+'-16',leave_date:'',meal_allow:0,active:'true',store:'SSLGF'},
   {emp_id:'G',name:'墨竹亭正職G',is_full_time:'true',base:31000,skill_allow:1000,night_allow:0,mgr_allow:2000,
    attend_cap:2000,ot_rate:245,wage:0,labor_ins:758,health_ins:470,group_ins:0,pension:0,dormitory:0,
    hire_date:'2023-05-08',leave_date:'',meal_allow:0,active:'true',store:'MZTJS'},
  ]);
}
// 第一區的 180 種之外，再加幾種 2026-09 以後才有的欄位（遲到早退、補休、特休折算、生理假次數、多筆自訂加薪）
function atts2(ym){
  const base=o=>Object.assign({hours:184,extra_ot:0,deduct_days:0,support:[],work_days:0,wage_override:0,dorm_override:'',
    meal_on:false,holiday_h:0,bonuses:[],custom_add_amt:0,custom_ded_amt:0},o);
  return atts.concat([
    base({late_min:12,early_min:7}),
    base({hours:176,leaves:{comp:4}}),
    base({hours:160,annual:{payout_ym:ym,left_h:16}}),
    base({menstrual_h:8,menstrual_times:[4,4],leave_usage:{menstrual:{used_before_days:2.5}}}),
    base({hours:150,sick_h:17,personal_h:5}),
    base({custom_add_label:'分紅',custom_add_amt:800,custom_add_more:[{label:'補助',amt:1200}],forget_punch:3,forget_day:2}),
  ]);
}
/* 逐日資料（att.daily）：週日＝例假 R、週六＝休息日 H、其餘＝上班日 W；在職的上班日預設 8 小時。
 * spec＝{h:{日:時數}, hol:[日], guo:[日]（班表填「國」）, leave:{日:時數}}；不在職的日子自動略過。 */
function mkDaily(e,ym,spec){
  const D=daysIn(ym), dates=[], sched={}, day_h={}, day_leave={}, hol={};
  for(let d=1;d<=D;d++){
    const date=ym+'-'+pad(d);
    if(e.hire_date&&date<e.hire_date) continue;
    if(e.leave_date&&date>e.leave_date) continue;
    dates.push(date);
    const wd=new Date(date+'T00:00:00Z').getUTCDay();
    sched[date]={t: wd===0?'R':wd===6?'H':'W'};
    if(wd!==0&&wd!==6) day_h[date]=8;
  }
  const on=d=>dates.indexOf(ym+'-'+pad(d))>=0;
  (spec.hol||[]).forEach(d=>{ if(on(d)){ hol[ym+'-'+pad(d)]=true; delete day_h[ym+'-'+pad(d)]; } });
  (spec.guo||[]).forEach(d=>{ if(on(d)){ sched[ym+'-'+pad(d)]={t:'L',l:'國'}; delete day_h[ym+'-'+pad(d)]; } });
  Object.keys(spec.h||{}).forEach(d=>{ if(on(d)){ if(spec.h[d]>0) day_h[ym+'-'+pad(d)]=spec.h[d]; else delete day_h[ym+'-'+pad(d)]; } });
  Object.keys(spec.leave||{}).forEach(d=>{ if(on(d)) day_leave[ym+'-'+pad(d)]=spec.leave[d]; });
  const hours=Math.round(Object.keys(day_h).reduce((a,k)=>a+day_h[k],0)*100)/100;
  return {hours:hours, daily:{dates:dates,sched:sched,day_h:day_h,day_leave:day_leave,hol:hol,until:ym+'-'+pad(D),manual_sup_h:0}};
}
// 2026-11：1 日是週日；週六＝7、14、21、28，週日＝1、8、15、22、29。日子兩個半月各放一份，月中到職／離職的人也測得到。
const DAILY=[
  {tag:'平日超時',           spec:{h:{3:10,4:11.5,17:10,18:11.5}}},
  {tag:'休息日',             spec:{h:{7:9.5,14:3,21:9.5,28:3}}},
  {tag:'例假',               spec:{h:{8:6,22:6}}},
  {tag:'國定假日',           spec:{hol:[12,26],guo:[13,27],h:{12:8,13:4,26:8,27:4}}},
  {tag:'平日超時＋補休',     spec:{h:{3:10,4:11.5,5:5,17:10,18:11.5,19:5},leave:{5:3,19:3}}, att:{leaves:{comp:3}}},
  {tag:'沒來＋事假',         spec:{h:{10:0,11:0,24:0,25:0},leave:{11:8,25:8}}, att:{personal_h:8,deduct_days:1}},
  {tag:'全部（平日超時＋休息日＋例假＋國定假日＋補休＋遲到早退＋手填加班）',
   spec:{hol:[12,26],h:{3:10,4:11.5,5:6,7:9.5,8:6,12:8,17:10,18:11.5,19:6,21:9.5,22:6,26:8},leave:{5:2,19:2}},
   att:{leaves:{comp:2},late_min:9,early_min:4,extra_ot:1,holiday_h:8,support:[{store:'央廚',hours:4,rate:210,amount:''}]}},
];
function attsDaily(e,ym){
  return DAILY.map(s=>{
    const m=mkDaily(e,ym,s.spec);
    return Object.assign({extra_ot:0,deduct_days:0,support:[],work_days:0,wage_override:0,dorm_override:'',meal_on:false,
      holiday_h:0,bonuses:[],custom_add_amt:0,custom_ded_amt:0,__tag:s.tag},m,s.att||{});
  });
}
// 逐項差異：同一個 item_key 的（時數、金額）列表不同就列出來
function itemDiff(A,B){
  if(A.__err||B.__err) return [{k:'執行錯誤',text:'執行錯誤｜舊：'+(A.__err||'正常')+'｜新：'+(B.__err||'正常')}];
  const grp=r=>{const m={}; lines(r).forEach(x=>{(m[x.item_key]=m[x.item_key]||[]).push([x.qty==null?null:x.qty,x.amount]);}); return m;};
  const a=grp(A), b=grp(B), out=[];
  const show=v=>!v?'無':v.map(x=>String(x[1])+(x[0]==null?'':'（'+x[0]+'）')).join('＋');
  const showAmt=v=>!v?'無':v.map(x=>String(x[1])).join('＋');
  Object.keys(Object.assign({},a,b)).sort().forEach(k=>{
    if(JSON.stringify(a[k]||null)===JSON.stringify(b[k]||null)) return;
    // 時數相同只有金額不同 → 只印金額；時數也不同 → 金額後面括號帶時數
    const sameQty=a[k]&&b[k]&&JSON.stringify(a[k].map(x=>x[0]))===JSON.stringify(b[k].map(x=>x[0]));
    out.push({k:k,text:k+'：舊 '+(sameQty?showAmt(a[k]):show(a[k]))+' → 新 '+(sameQty?showAmt(b[k]):show(b[k]))});
  });
  ['gross','deduction','net'].forEach(k=>{ if(A[k]!==B[k]) out.push({k:'('+k+')',text:'('+k+')：舊 '+A[k]+' → 新 '+B[k]}); });
  return out;
}
const attBrief=att=>att.__tag?'逐日「'+att.__tag+'」 hours='+att.hours
  :JSON.stringify(att,(k,v)=>(v===0||v===''||v===false||(Array.isArray(v)&&!v.length))?undefined:v).slice(0,140);
const MAX_EX=8, MAX_ITEMS=10;
console.log('\n── 新月份（只列出不同的組合，不影響結束碼'+(STRICT?'；--strict：有差異回結束碼 1':'；加 --strict 才會')+'）──');
console.log('每人 '+atts2('2026-09').length+' 種工時假別組合（第一區的 '+atts.length+' 種＋遲到早退／補休／特休折算／生理假次數等 '+(atts2('2026-09').length-atts.length)+' 種）× '+emps2('2026-09').length+' 位（多月中到職D、月中離職E、計時月中到職F、墨竹亭正職G）');
console.log('2026-11 另帶逐日資料 att.daily，逐日情境：'+DAILY.map(s=>s.tag).join('、'));
let newN=0,newBad=0;
for(const ym of NEW_YMS){
  let mn=0,mbad=0,mrate=0,merr=0; const byKey={}, ex=[], exSeen={};
  for(const e of emps2(ym)){
    const list=atts2(ym).concat(ym==='2026-11'?attsDaily(e,ym):[]);
    for(const att of list){
      const A=call(OLD,e,ym,att,cfg2,RED[ym]);
      const B=call(NEW,e,ym,att,cfg2,RED[ym]);
      mn++;
      if(money(A)!==money(B)||A.__err||B.__err){
        mbad++; if(A.__err||B.__err) merr++;
        const d=itemDiff(A,B);
        d.forEach(x=>{byKey[x.k]=(byKey[x.k]||0)+1;});
        // 例子：每位同仁先各留一筆，逐日情境也各留一筆（不然都被前面的人佔掉）
        const slot=e.name+(att.__tag?'｜逐日':'');
        if(!exSeen[slot]&&ex.length<MAX_EX){ exSeen[slot]=1; ex.push({e:e.name,att:attBrief(att),d:d}); }
      } else if(rates(A)!==rates(B)) mrate++;
    }
  }
  newN+=mn; newBad+=mbad;
  console.log('新月份 '+ym+'：比對 '+mn+' 組，金額不同 '+mbad+' 組'+(merr?'（其中執行錯誤 '+merr+' 組）':'')+(mrate?'；另有 '+mrate+' 組只有單價顯示不同':''));
  if(mbad){
    console.log('  依項目（不同的組數）：'+Object.keys(byKey).sort((x,y)=>byKey[y]-byKey[x]||(x<y?-1:1)).map(k=>k+' '+byKey[k]).join('、'));
    ex.forEach((x,i)=>{
      console.log('  例 '+(i+1)+'｜'+x.e+'｜'+x.att);
      x.d.slice(0,MAX_ITEMS).forEach(t=>console.log('     '+t.text));
      if(x.d.length>MAX_ITEMS) console.log('     …另有 '+(x.d.length-MAX_ITEMS)+' 項');
    });
  }
}
console.log('\n新月份合計：比對 '+newN+' 組，金額不同 '+newBad+' 組'+(newBad?(STRICT?' → --strict：結束碼 1':'（只列出，不影響結束碼）'):''));
process.exit(bad?1:(STRICT&&newBad?1:0));
