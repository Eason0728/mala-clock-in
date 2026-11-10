/* 正職月中到職／離職：金額改用固定 30 天折算（Eason 2026-11-10，2026-10 起）；基本工時照舊用實際天數。全部虛構同仁。 */
const fs=require('fs');
const ROOT=require('path').join(__dirname,'..');
const GS=fs.readFileSync(ROOT+'/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
 +'\nexports.payCalcOne=payCalcOne;exports.r30=payRatio30;')(e);
let p=0,f=0;
const chk=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(got)+(ok?'':' ← 應為 '+JSON.stringify(want)));};
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5,late_deduct:'true',late_div_days:30,late_div_hours:8};
const FT={emp_id:'N',name:'新人',is_full_time:'true',base:29500,skill_allow:0,night_allow:3000,mgr_allow:0,attend_cap:3000,
  ot_rate:200,wage:0,labor_ins:758,health_ins:470,group_ins:0,pension:0,dormitory:0,hire_date:'2026-10-12',leave_date:'',meal_allow:0,active:'true'};
const run=(emp,ym,att)=>e.payCalcOne(emp,ym,Object.assign({hours:88,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,leave_usage:{},late_min:0},att||{}),cfg,11);
const g=(r,k)=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x?x.amount:0;};
const r=run(FT,'2026-10');
chk('10/12 到職：比例 20/30', r.ratio, 20/30);
chk('底薪 29,500÷30×20＝19,667', g(r,'base_salary'), 19667);
chk('夜間 2,000', g(r,'night_allow'), 2000);
chk('全勤 2,000', g(r,'attend_bonus'), 2000);
chk('勞保 758÷30×20＝505', g(r,'labor_ins'), 505);
chk('健保整月 470', g(r,'health_ins'), 470);
chk('基本工時照實際天數 160×20/31＝103.23', r.base_hours, 103.23);
chk('2026-09 照舊用實際天數（30 天的月份 20/30）', run(Object.assign({},FT,{hire_date:'2026-09-11'}),'2026-09').ratio, 20/30);
chk('2026-08 照舊：31 天月份 21/31', run(Object.assign({},FT,{hire_date:'2026-08-11'}),'2026-08').ratio, 21/31);
chk('10/2 到職（30 天）＝整月', e.r30(Object.assign({},FT,{hire_date:'2026-10-02'}),'2026-10'), 1);
chk('2 月 15 日到職：14/30', e.r30(Object.assign({},FT,{hire_date:'2027-02-15'}),'2027-02'), 14/30);
chk('10/20 離職：20/30', run(Object.assign({},FT,{hire_date:'2020-01-01',leave_date:'2026-10-20'}),'2026-10').ratio, 20/30);
chk('整月在職不受影響', run(Object.assign({},FT,{hire_date:'2020-01-01'}),'2026-10',{hours:160}).ratio, 1);
const PT=Object.assign({},FT,{is_full_time:'false',base:0,night_allow:0,attend_cap:0,wage:200});
chk('計時照舊用實際天數 20/31', run(PT,'2026-10').ratio, 20/31);
console.log(`\n${p} 過、${f} 失敗`); if(f) process.exit(1);
