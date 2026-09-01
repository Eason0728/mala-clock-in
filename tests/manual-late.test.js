/* 主管手動認定遲到分鐘（2026-09-01）
 * 情境：打卡被擋／未入帳時系統沒有進場時間可比，算不出遲到 → 由主管填。
 * 寫進 status_text 的「遲到N分(認定)」，payCollect 既有的解析器直接吃得到。 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const CLOCK={};
const sb={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:d=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sb);vm.runInContext(C+'\n'+P,sb);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__C[sh]||[]);};',sb);
sb.__C=CLOCK;
const call=(f,...a)=>vm.runInContext(f,sb)(...a);
const aml=vm.runInContext('applyManualLate',sb);   // call() 是「取出並呼叫」，要函式本身得直接取
let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
 console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

console.log('══ 狀態字串怎麼被改寫 ══');
chk('未入帳＋認定3分',        aml('打卡未入帳，主管補登',3), '打卡未入帳，主管補登、遲到3分(認定)');
chk('正常＋認定5分（正常要拿掉）', aml('正常',5), '遲到5分(認定)');
chk('覆蓋系統判的遲到',        aml('遲到1分',8), '遲到8分(認定)');
chk('早退保留、只換遲到',      aml('遲到1分、早退4分',8), '早退4分、遲到8分(認定)');
chk('留空 → 不覆蓋',          aml('正常',''), '正常');

console.log('\n══ 填 0 ＝ 主管認定不算遲到（2026-09-01 加）══');
chk('系統判遲到5分 → 認定不算', aml('遲到5分',0), '主管認定不計遲到');
chk('遲到＋早退 → 只免遲到',    aml('遲到5分、早退2分',0), '早退2分、主管認定不計遲到');
chk('本來就正常 → 加註記',      aml('正常',0), '主管認定不計遲到');

console.log('\n══ 端對端：認定的遲到會流進薪資 ══');
CLOCK.roster=[{emp_id:'E01',name:'測試',active:true,key:'k'}];CLOCK.leave=[];
CLOCK.events=[
 {emp_id:'E01',ts:'2026-07-11T17:33:00+08:00',type:'in', status:'rejected_out_of_range',within_range:false,distance_m:80.8},
 {emp_id:'E01',ts:'2026-07-11T23:12:00+08:00',type:'out',status:'ok',within_range:true,distance_m:5.3}];
CLOCK.approved=[{date:'2026-07-11',name:'測試',emp_id:'E01',approved_hours:5,
  status_text:aml('打卡未入帳，主管補登',3),entered_at:'x',manager_name:'M',periods:'17:30-22:30'}];
const c=call('payCollect','2026-07',6,'SSLGF',[])['E01'];
chk('  遲到累計 3 分（系統本來抓不到）', c.late_min, 3);
chk('  缺勤仍是 1 天（同一天不重複計）', c.deduct_days, 1);

const emp={emp_id:'E01',name:'測試',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
 mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
 dormitory:0,hire_date:'2019-01-01',leave_date:'',meal_allow:0,active:'true'};
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5,
 late_deduct:'true',late_div_days:30,late_div_hours:8,pt_attend_min_hours:100,pt_attend_plus:10};
const r=call('payCalcOne',emp,'2026-07',Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,leave_usage:{}},c),cfg,4,call('payLeaveTypes',''));
const gg=k=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x||{};};
chk('  遲到不計薪 = 36000/30/8/60×3', gg('late_deduct').amount, Math.round(36000/30/8/60*3));
chk('  全勤只扣一天 100',             gg('attend_bonus').amount, 2900);

console.log('\n══ ⚠「主管認定不計遲到」含「遲到」二字，不可被誤判 ══');
const hasLE=vm.runInContext('payHasLateEarly',sb);
chk('  不計遲到 → 不算遲到日',   hasLE('主管認定不計遲到').any, false);
chk('  遲到3分(認定) → 算',      hasLE('遲到3分(認定)').late, true);
chk('  早退2分、不計遲到 → 早退算、遲到不算',
    [hasLE('早退2分、主管認定不計遲到').late, hasLE('早退2分、主管認定不計遲到').early], [false,true]);

CLOCK.approved=[{date:'2026-07-11',name:'測試',emp_id:'E01',approved_hours:8,
  status_text:'主管認定不計遲到',entered_at:'x',manager_name:'M',periods:'17:30-22:30'}];
CLOCK.events=[];
const c2=call('payCollect','2026-07',6,'SSLGF',[])['E01'];
chk('  歸集：遲到 0 分',        c2.late_min, 0);
chk('  歸集：缺勤 0 天（不扣全勤）', c2.deduct_days, 0);

console.log(`\n${f?'❌ 有失敗':'✅ 手動認定遲到全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
