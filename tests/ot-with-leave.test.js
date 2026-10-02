/* 正職加班改口徑（Eason 2026-10-02 定案）
 * 舊：加班＝max(0, 上班＋支援 − 基本工時)；請假只拿來抵「不足倒扣」，抵完多出來的被 max(0,…) 吃掉
 *     → 當月有請假的正職，零星超時（例：某天 8.5H）永遠拿不到加班費。
 * 新：淨時數＝上班＋支援＋可抵扣的假（假別表 offset_shortfall）− 基本工時
 *     加班＝max(0, 淨時數)＋逐日加班；不足倒扣＝max(0, −淨時數)（與舊算法數學上相同）。
 * 實例：A 君 2026-09 上班 119.75＋事假 24.5＋病假 16.25 ＝ 160.5，基本 160 → 加班 0.5H。 */
const fs=require('fs');
const __ROOT = require('path').join(__dirname, '..');
const GS=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
 +'\nexports.payCalcOne=payCalcOne;')(e);
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const FT={emp_id:'A',name:'正職',is_full_time:true,base:29000,skill_allow:3000,night_allow:0,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:0,active:'true'};
// 2026-09：30 天、紅字 10 天 → 基本 160H
const run=(att)=>e.payCalcOne(FT,'2026-09',Object.assign(
 {hours:0,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,leave_usage:{},late_min:0,
  personal_h:0,sick_h:0,annual_h:0,menstrual_h:0,disaster_h:0},att),cfg,10);
const it=(r,k)=>[].concat(r.earn,r.ded).find(i=>i.item_key===k);
let p=0,f=0;
const chk=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(got)+(ok?'':' ← 應為 '+JSON.stringify(want)));};

let r=run({hours:119.75,personal_h:24.5,sick_h:16.25});
chk('實例：上班119.75＋假40.75 → 加班 0.5H', r.ot_paid_hours, 0.5);
chk('實例：加班費 0.5×240＝120', (it(r,'overtime')||{}).amount, 120);
chk('實例：沒有不足倒扣', it(r,'shortfall_hours'), undefined);
chk('surplus_hours 仍是純上班−基本（顯示用，不含假）', r.surplus_hours, -40.25);

r=run({hours:119.75,personal_h:24.5,sick_h:15.25});
chk('假少 1H → 不足倒扣 0.5H、沒有加班', [r.ot_paid_hours,(it(r,'shortfall_hours')||{}).qty], [0,0.5]);

r=run({hours:160});
chk('沒請假剛好 160 → 無加班無倒扣', [r.ot_paid_hours,it(r,'overtime'),it(r,'shortfall_hours')], [0,undefined,undefined]);
r=run({hours:165});
chk('沒請假 165 → 加班 5（與舊口徑相同）', r.ot_paid_hours, 5);
r=run({hours:150});
chk('沒請假 150 → 倒扣 10（與舊口徑相同）', (it(r,'shortfall_hours')||{}).qty, 10);

r=run({hours:155,annual_h:8});
chk('特休也算可抵扣：155＋8＝163 → 加班 3', r.ot_paid_hours, 3);
r=run({hours:119.75,personal_h:24.5,sick_h:16.25,extra_ot:2});
chk('逐日加班照樣另加：0.5＋2＝2.5', r.ot_paid_hours, 2.5);
r=run({hours:110,personal_h:24.5,sick_h:16.25,support:[{store:'MZTJS',hours:10,rate:200}]});
chk('支援併入：110＋10＋40.75＝160.75 → 加班 0.75', r.ot_paid_hours, 0.75);

// 生效月份 2026-09：07 以前是手動工時（考勤機），加班已另填在 extra_ot，套新口徑會把假重複算成加班；
// 08 已發薪，Eason 2026-10-02 決定不補回、維持舊算法
const runYm=(ym,att,red)=>e.payCalcOne(FT,ym,Object.assign(
 {hours:0,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,leave_usage:{},late_min:0,
  personal_h:0,sick_h:0,annual_h:0,menstrual_h:0,disaster_h:0},att),cfg,red==null?8:red);
r=runYm('2026-07',{hours:184,annual_h:16,extra_ot:45.5});
chk('2026-07 沿用舊口徑：184＋特休16、逐日加班45.5 → 加班仍是 45.5', r.ot_paid_hours, 45.5);
r=runYm('2026-08',{hours:126.25,sick_h:38.5,menstrual_h:4},10);   // 31−10＝21 天×8＝168
chk('2026-08 沿用舊口徑（不補回）：126.25＋42.5−168 → 加班 0', r.ot_paid_hours, 0);
r=runYm('2026-09',{hours:119.75,personal_h:24.5,sick_h:16.25},10);
chk('2026-09 起新口徑：119.75＋40.75−160 → 加班 0.5', r.ot_paid_hours, 0.5);
r=runYm('2026-07',{hours:150,sick_h:20});
chk('2026-07 不足倒扣照舊（150＋20 vs 184 → 倒扣 14）', (it(r,'shortfall_hours')||{}).qty, 14);

console.log(f?`\n❌ 正職加班含假 ${f} 項失敗 (${p}/${p+f})`:`\n✅ 正職加班含假全部正確 (${p}/${p+f})`);
process.exit(f?1:0);
