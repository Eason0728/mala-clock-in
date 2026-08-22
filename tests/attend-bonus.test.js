const fs=require('fs');
function load(p){const GS=fs.readFileSync(p,'utf8');
  const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
  const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
   +'\nexports.payCalcOne=payCalcOne;exports.payAttendVoid=payAttendVoid;')(e);return e;}
const E=load('/Users/guoeason/mala-clock-in/apps-script/Payroll.gs');

const emp={emp_id:'A',name:'正職',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2021-01-01',leave_date:'',meal_allow:0,active:'true'};
// 光復：三個門檻參數都沒設（＝改版前的樣子）
const cfgGF={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
// 央廚／總部：忘刷3次、遲到累計10分 → 歸零
const cfgCF=Object.assign({},cfgGF,{attend_void_forget:3,attend_forget_unit:'punch',attend_void_late_min:10});

function bonus(cfg,att){const r=E.payCalcOne(emp,'2026-07',Object.assign(
  {hours:184,extra_ot:0,deduct_days:0,support:[],forget_punch:0,forget_day:0,late_min:0,early_min:0,attend_void:false},att),cfg,4);
  const x=(r.earn||[]).find(i=>i.item_key==='attend_bonus');return x?x.amount:null;}
function label(cfg,att){const r=E.payCalcOne(emp,'2026-07',Object.assign(
  {hours:184,extra_ot:0,deduct_days:0,support:[],forget_punch:0,forget_day:0,late_min:0,early_min:0,attend_void:false},att),cfg,4);
  const x=(r.earn||[]).find(i=>i.item_key==='attend_bonus');return x?x.item_label:'';}

let p=0,f=0;const chk=(n,g,w)=>{const ok=g===w;ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+g+(ok?'':' ← 應為 '+w));};

console.log('══ 光復（沒設門檻）：必須與改版前一模一樣 ══');
chk('全勤滿分',                 bonus(cfgGF,{}), 3000);
chk('缺勤2天 → 3000−200',       bonus(cfgGF,{deduct_days:2}), 2800);
chk('忘刷5次也只按天扣',        bonus(cfgGF,{deduct_days:3,forget_punch:5}), 2700);
chk('遲到累計30分也只按天扣',   bonus(cfgGF,{deduct_days:1,late_min:30}), 2900);
chk('缺勤40天不會變負數',       bonus(cfgGF,{deduct_days:40}), 0);

console.log('\n══ 央廚／總部（忘刷≥3次、遲到累計≥10分 → 歸零）══');
chk('乾淨的月份 → 全額',        bonus(cfgCF,{}), 3000);
chk('忘刷2次 → 還有（按天扣）', bonus(cfgCF,{deduct_days:2,forget_punch:2}), 2800);
chk('忘刷3次 → 歸零',           bonus(cfgCF,{deduct_days:2,forget_punch:3}), 0);
chk('忘刷5次 → 歸零',           bonus(cfgCF,{deduct_days:3,forget_punch:5}), 0);
chk('遲到9分 → 還有',           bonus(cfgCF,{deduct_days:1,late_min:9}), 2900);
chk('遲到10分 → 歸零',          bonus(cfgCF,{deduct_days:1,late_min:10}), 0);
chk('遲到3+7=10分 → 歸零',      bonus(cfgCF,{deduct_days:2,late_min:10}), 0);
chk('有事假(void) → 歸零',      bonus(cfgCF,{deduct_days:1,attend_void:true}), 0);
chk('病假只按天遞減，不歸零',   bonus(cfgCF,{deduct_days:2}), 2800);

console.log('\n══ 歸零原因會標在項目名上 ══');
console.log('  忘刷3次 →', label(cfgCF,{forget_punch:3}));
console.log('  遲到10分 →', label(cfgCF,{late_min:10}));
console.log('  有事假 →', label(cfgCF,{attend_void:true}));
console.log('  正常 →', label(cfgCF,{}));

console.log('\n══ 計數單位可切換（day）══');
const cfgDay=Object.assign({},cfgCF,{attend_forget_unit:'day'});
chk('同一天漏2張卡＝1天，未達3天門檻', bonus(cfgDay,{forget_punch:4,forget_day:2}), 3000);
chk('3天各漏1張 → 歸零',               bonus(cfgDay,{forget_punch:3,forget_day:3}), 0);

console.log(`\n${f?'❌ 有失敗':'✅ 全部通過'} (${p}/${p+f})`);
process.exit(f?1:0);
