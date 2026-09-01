const fs=require('fs');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const GS=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={}; new Function('exports',"function pad2(n){return ('0'+n).slice(-2)}\n"+GS.slice(a,b)
  +'\nexports.payCalcOne=payCalcOne;exports.payAnnualQuota=payAnnualQuota;exports.payDayBefore=payDayBefore;')(e);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const emp={emp_id:'A',name:'正職',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,mgr_allow:0,
 attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,dormitory:0,
 hire_date:'2021-10-01',leave_date:'',meal_allow:0,active:'true'};
const rate=Math.round((30000+3000+3000+0+3000)/30/8);
const q=e.payAnnualQuota('2021-10-01','2026-09');
console.log('到職 2021-10-01 → 週年期',q.ps,'~',q.pe,' 額度',q.days,'天');
console.log('屆滿前一日 =',e.payDayBefore(q.pe),'→ 折算月份',e.payDayBefore(q.pe).slice(0,7));
function run(ym,annual){const r=e.payCalcOne(emp,ym,{hours:184,extra_ot:0,deduct_days:0,support:[],annual:annual},cfg,4);
  const x=(r.earn||[]).find(i=>i.item_key==='annual_payout'); return x?x.amount:0;}
const ann={days:14,quota_h:112,used_h:40,left_h:72,ps:q.ps,pe:q.pe,payout_ym:e.payDayBefore(q.pe).slice(0,7)};
let pass=0,fail=0;
const chk=(n,g,w)=>{const ok=g===w;ok?pass++:fail++;console.log(`${ok?'✓':'✗'} ${n}: ${g}${ok?'':' ← 應為 '+w}`);};
console.log('\n剩餘 72H × 費率',rate);
chk('屆滿當月（2026-09）折算',        run('2026-09',ann), 72*rate);
chk('非屆滿月（2026-08）不折算',      run('2026-08',ann), 0);
chk('非屆滿月（2026-10）不折算',      run('2026-10',ann), 0);
chk('休完了（left_h=0）不折算',       run('2026-09',Object.assign({},ann,{left_h:0})), 0);
chk('計時同仁（annual=null）不折算',  run('2026-09',null), 0);
console.log(`\n${fail?'❌ 有失敗':'✅ 全部通過'} (${pass}/${pass+fail})`);
process.exit(fail?1:0);
