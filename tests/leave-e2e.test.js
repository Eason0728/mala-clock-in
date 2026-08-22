/* 端對端：值班核定寫進 leave 分頁 → payCollect 歸集 → payCalcOne 計薪
 * 這條鏈之前完全沒有測試覆蓋（payCollect 落在 payroll_mock.js 的切片之外）。*/
const fs=require('fs'), vm=require('vm');
const P=fs.readFileSync('/Users/guoeason/mala-clock-in/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync('/Users/guoeason/mala-clock-in/apps-script/Code.gs','utf8');

const CLOCK={};                       // 假的打卡試算表分頁
const sandbox={console,
  SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
  Utilities:{formatDate:(d,tz,f)=>{const p=n=>('0'+n).slice(-2);
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
  Logger:{log(){}}, PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
};
vm.createContext(sandbox);
vm.runInContext(C+'\n'+P, sandbox);
// 攔截讀打卡表：改回傳我們自己造的資料
vm.runInContext('payClockRead = function(store, sheet){ return (globalThis.__CLOCK[sheet]||[]); };', sandbox);
sandbox.__CLOCK=CLOCK;
const VmDate=vm.runInContext('Date',sandbox);   // ⚠ 跨 realm 的 instanceof Date 會判 false
const call=(fn,...a)=>vm.runInContext(fn,sandbox)(...a);

const YM='2026-07';
function reset(){ CLOCK.roster=[{emp_id:'E01',name:'張三',active:true,key:'k1'}];
  CLOCK.approved=[]; CLOCK.events=[]; CLOCK.leave=[]; }
/** 模擬值班主管核定：寫 approved 一列 ＋（有選假別的話）leave 一列。欄位名與正式試算表一致。 */
function approve(date,hours,status,leaveType,leaveHours,dateAsObject){
  CLOCK.approved.push({date:date,name:'張三',emp_id:'E01',approved_hours:hours,
    status_text:status||'正常',entered_at:date+'T20:00:00+08:00',manager_name:'主管'});
  if(leaveType) CLOCK.leave.push({'日期':dateAsObject?new VmDate(date+'T00:00:00'):date,
    '姓名':'張三','假別':leaveType,'時數':leaveHours});
}
const cfg={daily_hours:8,leave_div_days:30,leave_div_hours:8,attend_deduct_per_day:100,sick_ratio:0.5};
const emp={emp_id:'E01',name:'張三',is_full_time:'true',base:30000,skill_allow:3000,night_allow:3000,
  mgr_allow:0,attend_cap:3000,ot_rate:240,wage:0,labor_ins:0,health_ins:0,group_ins:0,pension:0,
  dormitory:0,hire_date:'2021-01-01',leave_date:'',meal_allow:0,active:'true'};
const rate=Math.round((30000+3000+3000+0+3000)/30/8);

function collect(){ return call('payCollect',YM,6,'SSLGF',[])['E01']||{}; }
function calc(c,extraCfg){
  const T=call('payLeaveTypes','');
  const att=Object.assign({extra_ot:0,support:[],bonuses:[],annual:null,leave_usage:{}},c);
  const r=call('payCalcOne',emp,YM,att,Object.assign({},cfg,extraCfg||{}),4,T);
  const g=k=>{const x=[].concat(r.earn,r.ded).find(i=>i.item_key===k);return x?x.amount:0;};
  return {r,g};
}
let p=0,f=0;
const chk=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(got)+(ok?'':' ← 應為 '+JSON.stringify(want)));};

console.log('══ 1) 核定「病假」2H → 歸集 → 扣半薪 ══');
reset(); approve('2026-07-05',6,'正常','病假',2);
let c=collect();
chk('  歸集到 sick 2H',      [c.leaves.sick, c.sick_h], [2,2]);
chk('  缺勤天數 1',           c.deduct_days, 1);
chk('  扣款＝2H×半薪',        calc(c).g('sick_leave'), 2*Math.round(rate*0.5));

console.log('\n══ 2) 新假別「喪假（父母・配偶）」全形括號能不能對到 ══');
reset(); approve('2026-07-08',0,'正常','喪假（父母・配偶）',8);
c=collect();
chk('  歸集到 funeral8 8H',   c.leaves.funeral8, 8);
chk('  全薪不扣款',           calc(c).g('funeral8_leave'), 0);
chk('  仍計缺勤（沿用舊行為）', c.deduct_days, 1);

console.log('\n══ 3) 家庭照顧假：改版前算全薪，現在應該全扣 ══');
reset(); approve('2026-07-09',0,'正常','家庭照顧假',8);
c=collect();
chk('  歸集到 family 8H',     c.leaves.family, 8);
chk('  全額扣款',             calc(c).g('family_leave'), 8*rate);

console.log('\n══ 4) Sheets 日期陷阱：日期存成 Date 物件 ══');
reset(); approve('2026-07-10',0,'正常','事假',8,true);
c=collect();
chk('  照樣歸集到 personal',  c.leaves.personal, 8);
chk('  扣款正確',             calc(c).g('personal_leave'), 8*rate);

console.log('\n══ 5) 遲到分鐘從核定狀態累計（多項用「、」串）══');
reset();
approve('2026-07-01',7.5,'遲到5分'); approve('2026-07-02',7,'遲到3分、早退2分');
c=collect();
chk('  遲到累計 8 分',        c.late_min, 8);
chk('  早退累計 2 分',        c.early_min, 2);
chk('  未達 10 分門檻→全勤照給', calc(c,{attend_void_late_min:10}).g('attend_bonus'), 3000-2*100);
approve('2026-07-03',7,'遲到2分'); c=collect();
chk('  再遲到2分＝10分→歸零',  calc(c,{attend_void_late_min:10}).g('attend_bonus'), 0);

console.log('\n══ 6) 忘刷次數（未配對的打卡）══');
reset();
CLOCK.events=[{emp_id:'E01',ts:'2026-07-11T09:00:00+08:00',type:'in',status:'ok'},
              {emp_id:'E01',ts:'2026-07-12T09:00:00+08:00',type:'in',status:'ok'},
              {emp_id:'E01',ts:'2026-07-13T09:00:00+08:00',type:'in',status:'ok'}];
c=collect();
chk('  忘刷 3 次',            c.forget_punch, 3);
chk('  忘刷 3 天',            c.forget_day, 3);
chk('  未啟用門檻→只按天扣',  calc(c).g('attend_bonus'), 3000-3*100);
chk('  門檻3次→歸零',         calc(c,{attend_void_forget:3}).g('attend_bonus'), 0);

console.log('\n══ 7) 事假設成 void → 全勤整筆歸零 ══');
reset(); approve('2026-07-15',0,'正常','事假',8);
c=collect();
chk('  未設 void 時只遞減',    calc(c).g('attend_bonus'), 3000-100);
// 模擬央廚：事假 attend_effect='void'
vm.runInContext(`payLeaveTypes = (function(orig){ return function(st){
  return orig(st).map(function(t){ return t.code==='personal' ? Object.assign({},t,{attend_effect:'void'}) : t; });
};})(payLeaveTypes);`, sandbox);
c=collect();
chk('  設 void 後 attend_void', c.attend_void, true);
chk('  全勤歸零',              calc(c).g('attend_bonus'), 0);

console.log(`\n${f?'❌ 有失敗':'✅ 端對端全部通過'} (${p}/${p+f})`);
process.exit(f?1:0);
