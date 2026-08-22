const fs=require('fs');
function load(p){
  const GS=fs.readFileSync(p,'utf8');
  const a=GS.indexOf('function payR0'), b=GS.indexOf('/* ═══════════════════ Handlers');
  const e={}; new Function('exports',"function pad2(n){return ('0'+n).slice(-2)}\n"+GS.slice(a,b)+'\nexports.payCalcOne=payCalcOne;')(e);
  return e.payCalcOne;
}
const OLD=load(process.argv[2]), NEW=load(process.argv[3]);
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

let n=0,bad=0,rateOnly=0;
const yms=['2026-06','2026-07','2026-08','2026-02'];
for(const e of emps) for(const ym of yms) for(const att of atts){
  const A=OLD(e,ym,JSON.parse(JSON.stringify(att)),cfg,8);
  const B=NEW(e,ym,JSON.parse(JSON.stringify(att)),cfg,8);
  n++;
  // ⚠ payCalcOne 回的是 earn／ded 兩個陣列，沒有 items——寫錯欄位名會讓「逐項比對」變成空陣列比空陣列
  const flat=r=>[].concat(r.earn||[],r.ded||[]).map(x=>[x.item_key,x.qty,x.rate,x.amount]).sort();
  // 分兩級：①「錢」必須完全一樣（金額/總額/項目/時數）②「單價顯示」允許不同並單獨統計
  const money=r=>JSON.stringify({g:r.gross,d:r.deduction,n:r.net,
    i:[].concat(r.earn||[],r.ded||[]).map(x=>[x.item_key,x.qty,x.amount]).sort()});
  const rates=r=>JSON.stringify([].concat(r.earn||[],r.ded||[]).map(x=>[x.item_key,x.rate]).sort());
  if(money(A)!==money(B)){ bad++; if(bad<=3){console.log('✗ 金額不一致：',e.name,ym,JSON.stringify(att).slice(0,120));
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
process.exit(bad?1:0);
