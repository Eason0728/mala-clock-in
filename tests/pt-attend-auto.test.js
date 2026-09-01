/* 計時全勤津貼：勾選＝資格、實際給不給自動偵測（Eason 2026-08-23 改，比照餐費補助）
 * 兩個條件都成立才 +10：①時數 ≥ 門檻（預設100H）②缺勤天數 = 0 */
const fs=require('fs');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const GS=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
 +'\nexports.payCalcOne=payCalcOne;exports.payPtAttendCheck=payPtAttendCheck;')(e);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5,
 pt_attend_min_hours:100,pt_attend_plus:10,late_deduct:'false'};
// 到職 2026-08-01 → 未滿半年，沒有年資加給，方便單獨驗全勤津貼
const PT={emp_id:'B',name:'計時',is_full_time:'false',base:0,skill_allow:0,night_allow:0,mgr_allow:0,
 attend_cap:0,ot_rate:0,wage:200,labor_ins:0,health_ins:0,group_ins:0,pension:0,dormitory:0,
 hire_date:'2026-08-01',leave_date:'',meal_allow:0,active:'true'};
const run=att=>e.payCalcOne(PT,'2026-09',Object.assign(
 {hours:120,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,leave_usage:{},late_min:0},att),cfg,4);
const wage=r=>{const x=(r.earn||[]).find(i=>i.item_key==='hourly_wage');return x?x.rate:null;};
let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
 console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

console.log('══ 四種組合 ══');
chk('沒勾＋符合條件 → 200（沒資格）',      wage(run({full_attend:false,hours:120,deduct_days:0})), 200);
chk('勾了＋符合條件 → 210',                wage(run({full_attend:true, hours:120,deduct_days:0})), 210);
chk('勾了＋時數不足 → 200（自動擋下）',    wage(run({full_attend:true, hours:99, deduct_days:0})), 200);
chk('勾了＋有缺勤 → 200（自動擋下）',      wage(run({full_attend:true, hours:120,deduct_days:1})), 200);

console.log('\n══ 邊界 ══');
chk('剛好 100H → 給',                      wage(run({full_attend:true,hours:100,deduct_days:0})), 210);
chk('99.9H → 不給',                        wage(run({full_attend:true,hours:99.9,deduct_days:0})), 200);

console.log('\n══ 判定結果有回傳（前端要顯示原因）══');
const r1=run({full_attend:true,hours:80,deduct_days:2});
chk('  勾了但不符合',    [r1.pt_attend.on, r1.pt_attend.qualified, r1.pt_attend.plus], [true,false,0]);
chk('  帶出原因用的數字', [r1.pt_attend.hours, r1.pt_attend.deduct_days, r1.pt_attend.min_hours], [80,2,100]);
const r2=run({full_attend:true,hours:120,deduct_days:0});
chk('  勾了且符合',      [r2.pt_attend.on, r2.pt_attend.qualified, r2.pt_attend.plus], [true,true,10]);

console.log('\n══ 門檻可依門市調整 ══');
const r3=e.payCalcOne(PT,'2026-09',{hours:80,extra_ot:0,deduct_days:0,support:[],bonuses:[],
 annual:null,leave_usage:{},late_min:0,full_attend:true},Object.assign({},cfg,{pt_attend_min_hours:60}),4);
chk('門檻改 60H → 80H 就給', wage(r3), 210);

console.log('\n══ 正職不受影響 ══');
const FT=Object.assign({},PT,{is_full_time:'true',base:30000,wage:0,attend_cap:3000,ot_rate:240});
const r4=e.payCalcOne(FT,'2026-09',{hours:120,extra_ot:0,deduct_days:0,support:[],bonuses:[],
 annual:null,leave_usage:{},late_min:0,full_attend:true},cfg,4);
chk('正職沒有 pt_attend', r4.pt_attend, null);

console.log(`\n${f?'❌ 有失敗':'✅ 全勤津貼自動偵測全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
