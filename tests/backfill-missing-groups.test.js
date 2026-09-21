/* 一次性回填「少刷N組卡」（2026-09-21）
 *
 * 反向檢查（computeApprovalStatus）只在主管按下核定的當下跑，所以新規則只對**之後**的核定
 * 生效。已經核定完的日子（許正昊 9/21 停在「遲到2分、早退1分」）不會自己變，
 * recheckPendingApprovalStatuses 的前置篩選也篩不到它。這支把歷史補回來。
 *
 * 這個測試驗三件事：抓得到該補的、不亂改不該動的、dry-run 真的不寫。 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const C=fs.readFileSync(__ROOT + '/apps-script/Code.gs','utf8');
const sb={console,
 SpreadsheetApp:{getActive:()=>null,openById:()=>null},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sb); vm.runInContext(C,sb);

let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

const D='2026-09-21';
/* 假試算表：只要 getSS／readSheetAsObjects／nowTaipeiIso 三個接口，其餘都跑真的程式。 */
let appended=[];
function install(sheets){
  appended=[];
  sb.__SHEETS={};
  Object.keys(sheets).forEach(function(k){
    sb.__SHEETS[k]={__rows:sheets[k],appendRow:function(r){appended.push(r);}};
  });
  vm.runInContext(`
    getSS=function(){return {getSheetByName:function(n){return globalThis.__SHEETS[n]||null;}};};
    readSheetAsObjects=function(sh){return {rows:(sh&&sh.__rows)||[]};};
    nowTaipeiIso=function(){return '2026-09-21T23:30:00+08:00';};
  `,sb);
}
const run=(from,to,apply)=>vm.runInContext('backfillMissingPunchGroups',sb)(from,to,apply);
// 許正昊：只刷了第一段的上班卡與第二段的下班卡
const HSU_EVENTS=[
  {emp_id:'E01',type:'in', status:'ok',ts:D+'T11:02:00+08:00'},
  {emp_id:'E01',type:'out',status:'ok',ts:D+'T21:44:00+08:00'}];
const ROSTER=[{emp_id:'E01',name:'許正昊',active:'true'}];
const rec=(over)=>Object.assign({date:D,emp_id:'E01',name:'許正昊',
  periods:'11:00-14:30,17:00-21:45',approved_hours:8.25,
  status_text:'遲到2分、早退1分',manager_name:'店長',entered_at:'2026-09-21T22:00:00+08:00'},over||{});

console.log('══ dry-run：抓得到、但一列都不寫 ══');
install({approved:[rec()],events:HSU_EVENTS,roster:ROSTER,leave:[]});
let r=run(D,D,false);
chk('  掃到 1 筆',        r.scanned, 1);
chk('  該補 1 筆',        r.fixed, 1);
chk('  applied=false',    r.applied, false);
chk('  舊狀態',           r.hits[0].from, '遲到2分、早退1分');
chk('  新狀態',           r.hits[0].to,   '遲到2分、早退1分、少刷1組卡');
chk('  姓名帶得出來',     r.hits[0].name, '許正昊');
chk('  dry-run 沒寫入',   appended.length, 0);

console.log('\n══ apply:true：才真的寫，且只換 status_text ══');
install({approved:[rec()],events:HSU_EVENTS,roster:ROSTER,leave:[]});
r=run(D,D,true);
chk('  applied=true',     r.applied, true);
chk('  寫了 1 列',        appended.length, 1);
chk('  日期／工號／姓名', appended[0].slice(0,3), [D,'E01','許正昊']);
chk('  periods 原封不動', appended[0][3], '11:00-14:30,17:00-21:45');
chk('  時數原封不動',     appended[0][4], 8.25);
chk('  狀態換成新的',     appended[0][5], '遲到2分、早退1分、少刷1組卡');
chk('  主管欄加系統重算', appended[0][6], '店長（系統重算）');

console.log('\n══ 不亂改不該動的 ══');
install({approved:[rec({periods:'11:00-21:45'})],events:HSU_EVENTS,roster:ROSTER,leave:[]});
chk('  單段班：不掃',      run(D,D,true).scanned, 0);
install({approved:[rec({status_text:'少刷1組卡'})],events:HSU_EVENTS,roster:ROSTER,leave:[]});
chk('  已標過：不掃',      run(D,D,true).scanned, 0);
install({approved:[rec({status_text:'正常'})],events:[
  {emp_id:'E01',type:'in', status:'ok',ts:D+'T11:00:00+08:00'},
  {emp_id:'E01',type:'out',status:'ok',ts:D+'T14:30:00+08:00'},
  {emp_id:'E01',type:'in', status:'ok',ts:D+'T17:00:00+08:00'},
  {emp_id:'E01',type:'out',status:'ok',ts:D+'T21:45:00+08:00'}],roster:ROSTER,leave:[]});
r=run(D,D,true);
chk('  老實刷四張：掃到但不補', [r.scanned,r.fixed,appended.length], [1,0,0]);
install({approved:[rec({status_text:'遲到5分(認定)'})],events:HSU_EVENTS,roster:ROSTER,leave:[]});
r=run(D,D,true);
chk('  主管手動認定：不動', [r.fixed,appended.length], [0,0]);
chk('  但列進 skipped 看得到', r.skipped[0].reason, '主管手動認定，不自動改');
// 重算後連遲到分鐘都變了 → 不是單純少刷，不自動寫
install({approved:[rec({status_text:'遲到99分'})],events:HSU_EVENTS,roster:ROSTER,leave:[]});
r=run(D,D,true);
chk('  不只少刷有變：不寫', [r.fixed,appended.length], [0,0]);
chk('  列進 skipped',        r.skipped[0].reason, '不只少刷有變，請人工確認');

console.log('\n══ 安全閘：statusDiffIsOnlyMissingGroup ══');
const only=vm.runInContext('statusDiffIsOnlyMissingGroup',sb);
chk('  正常 → 少刷1組卡',          only('正常','少刷1組卡'), true);
chk('  保留遲到早退只多少刷',      only('遲到2分、早退1分','遲到2分、早退1分、少刷1組卡'), true);
chk('  遲到分鐘也變了 → 擋',       only('遲到2分','遲到5分、少刷1組卡'), false);
chk('  多了別的註記 → 擋',         only('遲到2分','遲到2分、有多出的打卡段、少刷1組卡'), false);
chk('  沒有少刷 → 擋',             only('遲到2分','遲到2分、早退1分'), false);
chk('  掉了原本的註記 → 擋',       only('遲到2分、早退1分','遲到2分、少刷1組卡'), false);

console.log('\n══ 日期區間防呆 ══');
install({approved:[],events:[],roster:[],leave:[]});
chk('  格式錯',     run('2026-9-1',D,false).error, 'bad_date');
chk('  頭尾顛倒',   run('2026-09-30','2026-09-01',false).error, 'bad_range');
chk('  區間太寬',   run('2020-01-01','2026-09-21',false).error, 'range_too_wide');
chk('  合法區間',   run('2026-09-01','2026-09-30',false).ok, true);

console.log(`\n${f?'❌ 有失敗':'✅ 回填全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
