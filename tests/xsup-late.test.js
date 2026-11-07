/* 支援門市的遲到／早退也按分鐘扣（Eason 2026-11-07）
 * 跟著跨店支援自動帶入（2026-11 起）：同組支援門市核定狀態裡的「遲到N分／早退N分」加進本店扣款，用本店費率；
 * 全勤只看本店（支援門市出勤不列入全勤，Eason 2026-11-05）；跨品牌、dup_pay 不帶入就不扣。
 * 全部虛構門市與同仁。 */
const fs=require('fs');
const ROOT=require('path').join(__dirname,'..');
const GS=fs.readFileSync(ROOT+'/apps-script/Payroll.gs','utf8');
const a=GS.indexOf('function payR0'),b=GS.indexOf('/* ═══════════════════ Handlers');
const e={};new Function('exports','function pad2(n){return ("0"+n).slice(-2)}\n'+GS.slice(a,b)
 +'\nexports.payCalcOne=payCalcOne;exports.core=paySupportAutoCore_;exports.le=payXsupLateEarly_;exports.min=payLateEarlyMin_;')(e);
let p=0,f=0;
const chk=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(got)+(ok?'':' ← 應為 '+JSON.stringify(want)));};

chk('狀態字串兩項都解析', e.min('遲到5分、早退12分'), {late:5,early:12});
chk('正常＝0', e.min('正常'), {late:0,early:0});

const STORES=[{code:'SSLGF',clock_ss_id:'',support_group:'sxl'},{code:'CF',clock_ss_id:'ck-cf',support_group:'*'},
  {code:'MZTJS',clock_ss_id:'ck-js',support_group:'mzt'}];
const M=(id,st)=>({emp_id:id,store:st,active:'true'});
const X=(no,acct,id)=>({emp_no:no,pay_store:'SSLGF',acct_store:acct,emp_id:id,state:'confirmed',not_support:'false',synced_at:'2026-11-05'});
const AP=(h,st)=>({approved_hours:h,status_text:st,periods:'',manager_name:''});
const APPROVED={
  SSLGF:{},
  CF:{'2026-11-03':{C1:AP(8,'遲到6分'),C2:AP(8,'遲到9分')},'2026-11-04':{C1:AP(8,'遲到4分、早退10分')},'2026-10-20':{C1:AP(8,'遲到30分')}},
  MZTJS:{'2026-11-03':{J1:AP(6,'遲到20分')}},
};
const d={stores:STORES,master:[M('A','SSLGF'),M('B','SSLGF'),M('C','SSLGF'),M('C2','CF')],
  xmap:[X('1','SSLGF','A'),X('1','CF','C1'),X('1','MZTJS','J1'),X('2','SSLGF','B'),X('2','CF','C2')],
  approvedMap:c=>APPROVED[c]||{},events:()=>[],tsDate:s=>String(s).slice(0,10),today:'2026-11-30',days:false};
const auto=e.core('2026-11','SSLGF',d);
chk('A 君：CF 遲到 6＋4、早退 10；跨品牌金山的 20 分不算、10 月的不算', e.le(auto.byEmp.A), {late:10,early:10});
chk('B 君：CF 也有他的主檔（dup_pay）→ 不帶入也不扣', e.le(auto.byEmp.B), {late:0,early:0});
chk('2026-10 沒有自動帶入（core 回 null）', e.core('2026-10','SSLGF',d), null);

const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5,
  late_deduct:'true',late_div_days:30,late_div_hours:8};
const FT={emp_id:'A',name:'正職',is_full_time:'true',base:33000,skill_allow:0,night_allow:3000,mgr_allow:0,attend_cap:3000,
  ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:0,active:'true'};
const calc=att=>e.payCalcOne(FT,'2026-11',Object.assign({hours:184,extra_ot:0,deduct_days:0,support:[],bonuses:[],annual:null,
  leave_usage:{},late_min:0,early_min:0},att),cfg,4);
const g=(r,k)=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x||{amount:0,qty:0};};
// 39,000÷30÷8÷60 每分鐘 2.708
const r=calc({late_min:6,xsup_late_min:10,xsup_early_min:10});
chk('本店 6＋支援 10＝16 分 → 43 元', [g(r,'late_deduct').qty,g(r,'late_deduct').amount], [16,Math.round(39000/30/8/60*16)]);
chk('支援門市早退 10 分 → 27 元', g(r,'early_deduct').amount, Math.round(39000/30/8/60*10));
chk('全勤不受支援門市影響（本店無缺勤＝3000）', g(calc({xsup_late_min:10}),'attend_bonus').amount, 3000);
chk('沒有支援欄位＝跟改版前一樣', g(calc({late_min:6}),'late_deduct').amount, 16);

console.log(`\n${p} 過、${f} 失敗`);
if(f) process.exit(1);
