/* 出勤規範第 2 批（2026-11-08）：加班倍率小數、補休依日期先後、休息日只抵前 2H、例假國定不能抵、墨竹亭不適用補休 */
const fs=require('fs'), vm=require('vm');
const ROOT=require('path').join(__dirname,'..');
const P=fs.readFileSync(ROOT+'/apps-script/Payroll.gs','utf8'), C=fs.readFileSync(ROOT+'/apps-script/Code.gs','utf8');
const sandbox={console,SpreadsheetApp:{getActive:()=>({getSheetByName:()=>null}),openById:()=>({getSheetByName:()=>null})},
 Utilities:{formatDate:(d)=>{const p=n=>('0'+n).slice(-2);return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());}},
 Logger:{log(){}},PropertiesService:{getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
vm.createContext(sandbox); vm.runInContext(C+'\n'+P,sandbox);
const fn=n=>vm.runInContext(n,sandbox);
let p=0,f=0; const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};
const sum=(cells,dayH,comp,hol)=>{const dates=Object.keys(cells).sort();const sched={};dates.forEach(d=>sched[d]={t:cells[d]});return fn('payOtDailySum')({dates,sched,day_h:dayH,day_leave:{},hol:hol||{},until:'2026-11-30',comp_h:comp,extra_ot:0});};
const keys=S=>['w43','w53','r43','r53','r83'].map(k=>S[k]);

// 4-7 依日期先後：11/1 休息日的前 2H 比 11/3 平日先扣
let S=sum({'2026-11-01':'H','2026-11-03':'W'},{'2026-11-01':2,'2026-11-03':10},2);
chk('先發生的休息日先扣，平日原封',keys(S),[2,0,0,0,0]);
S=sum({'2026-11-02':'W','2026-11-03':'W'},{'2026-11-02':10.5,'2026-11-03':10},2);
chk('同月依日期：先扣 11/2 的 1.34 段',keys(S),[2,0.5,0,0,0]);
S=sum({'2026-11-02':'W'},{'2026-11-02':12},3);
chk('同一天先 1.34 後 1.67',keys(S),[0,1,0,0,0]);
// 4-6 休息日只抵前 2H
S=sum({'2026-11-01':'H'},{'2026-11-01':5},5);
chk('休息日 5H 補休 5H：只抵前 2H',keys(S),[0,0,0,3,0]);
chk('抵不掉 3H',S.comp_over_h,3);
chk('實際抵 2H',S.comp_used_h,2);
// 4-10 例假、國定假日不能抵
S=sum({'2026-11-01':'R'},{'2026-11-01':10},2);
chk('例假超過 8H 的 2H 不能抵',keys(S),[2,0,0,0,0]);
chk('例假：補休 2H 全部抵不掉',S.comp_over_h,2);
S=sum({'2026-11-02':'W'},{'2026-11-02':10},2,{'2026-11-02':true});
chk('國定假日不能抵',keys(S),[2,0,0,0,0]);
// 抵得完沒有 comp_over
S=sum({'2026-11-02':'W'},{'2026-11-02':12},4);
chk('平日全部可抵',[S.comp_over_h,S.comp_used_h],[0,4]);
// 倍率
const items=(ft,S2,M,w)=>{const a=[];fn('payOtDailyItems')(S2,ft,M,w,(k,l,q,r,amt,m)=>a.push([k,l,q,amt,m]));return a;};
S=sum({'2026-11-02':'W'},{'2026-11-02':12},0);
let it=items(true,S,24000,0);
chk('正職 R＝100：1.34×2＝268',it[0].slice(0,4),['ot_w43','平日加班（1.34）',2,268]);
chk('正職 1.67×2＝334',it[1].slice(0,4),['ot_w53','平日加班（1.67）',2,334]);
S=sum({'2026-11-01':'H'},{'2026-11-01':9},0);
it=items(true,S,24000,0);
chk('休息日 9H：(2.68＋10.02＋2.67)×100',it[0][3],1537);
it=items(false,S,0,200);
chk('計時休息日 9H：(0.68＋4.02＋1.67)×200',it[0][3],1274);
// 墨竹亭
chk('墨竹亭金山不適用',fn('payCompStoreOn_')('MZTJS'),false);
chk('墨竹亭總部不適用',fn('payCompStoreOn_')('MZTHQ'),false);
chk('光復適用',fn('payCompStoreOn_')('SSLGF'),true);
chk('央廚適用',fn('payCompStoreOn_')('CF'),true);
chk('總部適用',fn('payCompStoreOn_')('HQ'),true);
console.log(f?`\n❌ 失敗 ${f}`:`\n✅ 全部通過 (${p}/${p})`); process.exit(f?1:0);
