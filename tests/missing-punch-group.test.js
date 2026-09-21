/* 少刷一組卡（2026-09-21，許正昊 9/21 案例）
 *
 * 情境：一天上兩段班（11:00–14:30、17:00–21:45），但他只刷了第一段的上班卡（11:02）
 * 和第二段的下班卡（21:44）——中間那張下班卡、那張上班卡都沒刷。
 * pairShifts 看到的是「一張 in 配 16 小時內的下一張 out」＝完整的一長段，
 * unmatchedIns/unmatchedOuts 都是空的 → 整天一個忘刷卡都標不出來，
 * 全勤的忘刷計數也是 0，比老實刷四張只漏一張的人還少被扣。
 *
 * 這支驗兩件事：
 *   1) 核定比對要標出「少刷N組卡」（computeApprovalStatus 的反向檢查）
 *   2) 那個字樣要流進全勤的忘刷計數（payCollect／出勤總表）
 * 並且驗它不會冤枉人：連續班被拆成兩段核定（中間沒間隔）不算少刷。 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const CLOCK={};
const sb={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sb); vm.runInContext(C+'\n'+P,sb);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};',sb);
sb.__CLOCK=CLOCK;
const call=(fn,...a)=>vm.runInContext(fn,sb)(...a);

let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

const D='2026-07-15';
const ms=hm=>new Date(D+'T'+hm+':00+08:00').getTime();
const per=(a,b)=>({startMs:ms(a),endMs:ms(b)});
const seg=(a,b)=>({inMs:a?ms(a):null,outMs:b?ms(b):null});
const cas=(periods,segs)=>call('computeApprovalStatus',periods,segs,false,false);
// 帶「不打卡休息帶」的版本（央廚那種店）。第五參數由呼叫端用 noPunchBreakWindow(date) 算好傳進來。
const bw=(a,b)=>({startMs:ms(a),endMs:ms(b)});
const casB=(periods,segs,win)=>call('computeApprovalStatus',periods,segs,false,false,win);

console.log('══ 核定比對：少刷一組卡抓不抓得到 ══');
// 許正昊案例本尊
chk('  一長段吃掉兩段核定 → 少刷1組卡',
  cas([per('11:00','14:30'),per('17:00','21:45')],[seg('11:02','21:44')]),
  '遲到2分、早退1分、少刷1組卡');
// 老老實實刷四張：兩段打卡對兩段核定
chk('  兩段打卡對兩段核定 → 正常',
  cas([per('11:00','14:30'),per('17:00','21:45')],[seg('11:00','14:30'),seg('17:00','21:45')]),
  '正常');
// 中間沒間隔＝主管把一段連續班拆兩段核定（例：分開算加班），同仁本來就不必刷卡
chk('  連續班拆兩段核定（無間隔）→ 不算少刷',
  cas([per('11:00','14:30'),per('14:30','21:45')],[seg('11:00','21:45')]),
  '正常');
// 三段班只刷頭尾
chk('  一長段吃掉三段核定 → 少刷2組卡',
  cas([per('09:00','11:00'),per('13:00','15:00'),per('18:00','21:00')],[seg('09:00','21:00')]),
  '少刷2組卡');
// 舊行為不可回歸
chk('  完全沒打卡 → 還是該段無打卡',
  cas([per('11:00','14:30'),per('17:00','21:45')],[]),
  '該段無打卡');
chk('  單段核定單段打卡 → 正常',
  cas([per('11:00','21:45')],[seg('11:00','21:45')]),
  '正常');
chk('  打卡段比核定段多 → 還是有多出的打卡段',
  cas([per('11:00','14:30')],[seg('11:00','14:30'),seg('17:00','21:45')]),
  '有多出的打卡段');
chk('  未配對的半段不參與比對（已是忘刷卡）',
  cas([per('11:00','14:30'),per('17:00','21:45')],[seg('11:02',null)]),
  '該段無打卡');

console.log('\n══ 異常分類：少刷卡要算異常、要標紅 ══');
const abn=call('abnormalCategoriesOf',['遲到2分、早退1分、少刷1組卡'],vm.runInContext('ABNORMAL_CATEGORIES',sb));
chk('  命中遲到早退＋少刷卡', abn.sort(), ['少刷卡','遲到早退']);
chk('  「有多出的打卡段」照舊不算異常',
  call('abnormalCategoriesOf',['有多出的打卡段'],vm.runInContext('ABNORMAL_CATEGORIES',sb)), []);

console.log('\n══ 字樣解析：payMissingGroups ══');
chk('  少刷1組卡 → 1',            call('payMissingGroups','少刷1組卡'), 1);
chk('  串在中間也讀得到',          call('payMissingGroups','遲到2分、少刷1組卡、早退1分'), 1);
chk('  少刷2組卡 → 2',            call('payMissingGroups','少刷2組卡'), 2);
chk('  正常 → 0',                 call('payMissingGroups','正常'), 0);
chk('  空的 → 0',                 call('payMissingGroups',''), 0);
chk('  不是開頭就不算（防誤判）',  call('payMissingGroups','主管說他少刷1組卡'), 0);

console.log('\n══ 全勤：少刷的卡要算進忘刷次數 ══');
function collect(status){
  CLOCK.roster=[{emp_id:'E01',name:'許正昊',active:true,key:'k'}];
  CLOCK.events=[];   // 事件留空＝pairShifts 抓不到任何忘刷，正是這個案例的重點
  CLOCK.leave=[];
  CLOCK.approved=[{date:D,name:'許正昊',emp_id:'E01',approved_hours:8.25,
    status_text:status,entered_at:'x',manager_name:'M'}];
  return call('payCollect','2026-07',6,'SSLGF',[])['E01']||{};
}
let c=collect('遲到2分、早退1分、少刷1組卡');
chk('  忘刷次數 2（一組＝上下班兩張卡）', c.forget_punch, 2);
chk('  忘刷天數 1',                      c.forget_day, 1);
chk('  核定時數照算不受影響',            c.hours, 8.25);
c=collect('少刷2組卡');
chk('  少刷2組 → 忘刷4次',               c.forget_punch, 4);
chk('  還是同一天 → 忘刷1天',            c.forget_day, 1);
c=collect('正常');
chk('  對照：正常 → 忘刷0次',            c.forget_punch, 0);
chk('  對照：正常 → 忘刷0天',            c.forget_day, 0);

console.log('\n══ 不打卡休息帶：央廚不可以被冤枉（2026-09-22 補）══');
/* 央廚規定 12:00–13:00 休息不打卡，而核定頁的預填本來就把休息帶挖成缺口＝每天都是兩段。
 * 沒有這個排除，央廚每一位同仁、每一個上班日都會被標少刷1組卡，全勤直接歸零。
 * ⚠ 不能改用「空檔短於 N 分鐘不算」來閃：央廚休息 60 分、許正昊漏刷那格也是 60 分，
 *   長度上完全分不開，只有「這家店規定要不要刷」分得開——所以判準一定要是門市設定。*/
const CFBREAK=bw('12:00','13:00');
chk('  央廚 08:00-12:00＋13:00-17:00 一段打卡 → 正常',
  casB([per('08:00','12:00'),per('13:00','17:00')],[seg('08:00','17:00')],CFBREAK), '正常');
chk('  央廚 陳建樺 09:00-12:00＋13:00-17:30 → 正常',
  casB([per('09:00','12:00'),per('13:00','17:30')],[seg('08:58','17:31')],CFBREAK), '正常');
chk('  央廚 休息帶以外還有空檔 → 那個照抓',
  casB([per('08:00','12:00'),per('13:00','15:00'),per('17:00','20:00')],[seg('08:00','20:00')],CFBREAK), '少刷1組卡');
chk('  央廚 空檔比休息帶長（11:30-13:30）→ 重疊就當休息，不冤枉人',
  casB([per('08:00','11:30'),per('13:30','17:00')],[seg('08:00','17:00')],CFBREAK), '正常');
chk('  沒設休息帶的店（光復／金山）12-13 空檔照算',
  casB([per('08:00','12:00'),per('13:00','17:00')],[seg('08:00','17:00')],null), '少刷1組卡');
chk('  休息帶不影響遲到早退（數字仍來自真實頭尾卡）',
  casB([per('08:00','12:00'),per('13:00','17:00')],[seg('08:05','16:50')],CFBREAK), '遲到5分、早退10分');

console.log(`\n${f?'❌ 有失敗':'✅ 少刷一組卡全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
