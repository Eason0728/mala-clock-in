/* 遲到分鐘不計薪（Eason 2026-08-23 定案）
 * 正職：(底薪＋職能＋夜間＋店長) ÷30 ÷8 ÷60 × 遲到分鐘　⚠ 基數不含全勤上限
 * 計時：有效時薪 ÷60 × 遲到分鐘
 * 遲到「照舊也扣全勤」——兩個都扣，不是二擇一 */
const fs=require('fs');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const GS=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
 +'\nexports.payCalcOne=payCalcOne;')(e);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5,
           late_deduct:'true',late_div_days:30,late_div_hours:8};
const FT={emp_id:'A',name:'正職',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:0,active:'true'};
const PT=Object.assign({},FT,{is_full_time:'false',base:0,skill_allow:0,night_allow:0,attend_cap:0,wage:200});
const base=(emp,att,c)=>e.payCalcOne(emp,'2026-07',Object.assign(
 {hours:184,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,leave_usage:{},late_min:0},att),
 Object.assign({},cfg,c||{}),4);
const g=(r,k)=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x?x.amount:0;};
let p=0,f=0;
const chk=(n,got,want)=>{const ok=got===want;ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+got+(ok?'':' ← 應為 '+want));};

// 正職基數＝30000+3000+3000+0 = 36000（不含全勤 3000）
const perMin=36000/30/8/60;   // = 2.5
console.log(`正職每分鐘 ${perMin} 元（36,000 ÷30 ÷8 ÷60）`);
chk('遲到 0 分 → 不產生扣款列', g(base(FT,{}),'late_deduct'), 0);
chk('遲到 30 分 → 75 元',       g(base(FT,{late_min:30}),'late_deduct'), Math.round(perMin*30));
chk('遲到 1 分 → 3 元',         g(base(FT,{late_min:1}),'late_deduct'),  Math.round(perMin*1));
chk('基數不含全勤（否則會是 %d）'.replace('%d',Math.round(39000/30/8/60*30)),
    g(base(FT,{late_min:30}),'late_deduct'), 75);

// ⚠ 有效時薪＝基本 200 ＋年資加給 10（到職 2019 早就滿半年）＝210；再勾滿勤 +10 ＝220。
//    寫測試時漏算年資加給會誤判引擎有錯（實際踩過）。
console.log('\n計時：有效時薪＝基本200＋年資10＝210');
chk('遲到 30 分 → 210/60×30',        g(base(PT,{late_min:30,hours:100}),'late_deduct'), Math.round(210/60*30));
chk('再勾滿勤 → 有效時薪 220',        g(base(PT,{late_min:60,hours:100,full_attend:true}),'late_deduct'), Math.round(220/60*60));
// 用實際領到的時薪反推，確認遲到費率與計薪時薪是同一個
const rPT=base(PT,{late_min:60,hours:100});
const wageLine=rPT.earn.find(x=>x.item_key==='hourly_wage');
chk('遲到費率＝計薪用的同一個時薪', Math.round(wageLine.rate/60*60), g(rPT,'late_deduct'));

console.log('\n兩個都扣（遲到金＋全勤）');
const r=base(FT,{late_min:30,deduct_days:1});
chk('  遲到不計薪 75',  g(r,'late_deduct'), 75);
chk('  全勤仍被扣 100', g(r,'attend_bonus'), 2900);

console.log('\n關閉時完全不扣');
chk('late_deduct=false', g(base(FT,{late_min:30},{late_deduct:'false'}),'late_deduct'), 0);

console.log(`\n${f?'❌ 有失敗':'✅ 遲到不計薪全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
