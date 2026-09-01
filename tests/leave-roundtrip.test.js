/* 假別表存檔往返：set 之後 get 回來必須每一欄都一樣。
 * 這支的存在理由：2026-08-23 我加了 min_unit／期限三欄／attend_effect／count_meal_day，
 * 改了 schema、讀取、前端卻漏改寫入 handler，存一次檔就把那六欄清成預設值——
 * 實際寫壞過央廚與總部的設定。只測「讀」測不到，一定要測往返。 */
const fs=require('fs'), vm=require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P=fs.readFileSync(__ROOT + '/apps-script/Payroll.gs','utf8');

// 用一張假的試算表：payRead/payReplaceAll 都接到記憶體
const SHEETS={};
const sb={console,SpreadsheetApp:{},Utilities:{},Logger:{log(){}},PropertiesService:{},LockService:{}};
vm.createContext(sb); vm.runInContext(P,sb);
vm.runInContext(`
  payRead = function(k){ return (globalThis.__S[k]||[]).map(function(r){var c={};for(var i in r)c[i]=r[i];return c;}); };
  payReplaceAll = function(k, rows){ globalThis.__S[k] = rows; };
  payAppend = function(){}; checkAdmin = function(){ return true; }; nowTaipeiIso = function(){ return 'T'; };
`, sb);
sb.__S=SHEETS;
const call=(f,...a)=>vm.runInContext(f,sb)(...a);

let p=0,f=0;
const chk=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?p++:f++;
  console.log((ok?'✓ ':'✗ ')+n+': '+JSON.stringify(g)+(ok?'':' ← 應為 '+JSON.stringify(w)));};

// 拿內建預設當輸入，改兩個欄位後存檔，再讀回來比對
const before = call('payLeaveTypes','CF');
before.find(x=>x.code==='personal').attend_effect='void';
const res = call('handlePayrollLeaveTypeSet', {admin_key:'x', store:'CF', types: before});
chk('存檔筆數', res.saved, before.length);

const after = call('payLeaveTypes','CF');
const FIELDS=['code','name','pay_ratio','count_absent','offset_shortfall','cap_days','cap_basis',
  'over_ratio','merge_into','cap_per_month','tenure_months','under_ratio',
  'min_unit','window_before','window_days','window_max','attend_effect','count_meal_day'];
let diffs=[];
before.forEach(b=>{
  const a=after.find(x=>x.code===b.code);
  if(!a){diffs.push(b.code+' 整列不見');return}
  FIELDS.forEach(k=>{ if(JSON.stringify(a[k])!==JSON.stringify(b[k])) diffs.push(`${b.name}.${k}: 存${JSON.stringify(b[k])} → 回${JSON.stringify(a[k])}`); });
});
chk('往返後每一欄都相同', diffs.slice(0,5), []);

// 重點欄位單獨確認（這幾個就是被漏掉的）
const g=c=>after.find(x=>x.code===c);
chk('  事假 attend_effect 留住',   g('personal').attend_effect, 'void');
chk('  婚假 期限規則留住',         [g('marriage').window_before,g('marriage').window_days,g('marriage').window_max], [10,90,365]);
chk('  陪產假 期限留住',           [g('paternity').window_before,g('paternity').window_days], [7,14]);
chk('  出差 不算餐費日留住',       g('trip').count_meal_day, false);
chk('  產檢假 最小單位留住',       g('prenatal').min_unit, 'half');
chk('  產假 年資門檻留住',         [g('maternity').tenure_months,g('maternity').under_ratio], [6,0.5]);

console.log(`\n${f?'❌ 有失敗':'✅ 存檔往返全部正確'} (${p}/${p+f})`);
process.exit(f?1:0);
