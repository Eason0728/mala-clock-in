/* 2026-10-10 Eason 三條：
 * ①出差日餐費：當天有打卡時數＋出差時數，以打卡時數（核定−出差）判斷滿 6H
 * ②自訂加薪可多筆（custom_add_more），存→讀逐欄一致、引擎每筆一列
 * ③遲到按分鐘扣可指定起始月份（late_deduct_from），之前的月份不扣 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');
const C = fs.readFileSync(__ROOT + '/apps-script/Code.gs', 'utf8');
const sb = { console, SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => { const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
sb.__CLOCK = {}; sb.__TAB = {};
vm.runInContext(`payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};
  payRead=function(n){return (globalThis.__TAB[n]||[]).map(function(r){return Object.assign({},r);});};
  payReplaceAll=function(n,rows){globalThis.__TAB[n]=rows.map(function(r){return Object.assign({},r);});};
  checkAdmin=function(){return true;}; nowTaipeiIso=function(){return 'T';};`, sb);
const call = (fn, ...a) => vm.runInContext(fn, sb)(...a);
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

// ① 出差日餐費
const CL = sb.__CLOCK;
CL.roster = [{ emp_id: 'E01', name: '測試一', active: true, key: 'k' }];
CL.events = [];
const ap = (d, h, st) => ({ date: d, name: '測試一', emp_id: 'E01', approved_hours: h, status_text: st || '正常', entered_at: 'x', manager_name: 'M' });
CL.approved = [ap('2026-09-01', 8, '出差'), ap('2026-09-02', 8), ap('2026-09-18', 10), ap('2026-09-19', 7), ap('2026-09-09', 5.5)];
CL.leave = [{ '日期': '2026-09-01', '姓名': '測試一', '假別': '出差', '時數': 8 },
            { '日期': '2026-09-18', '姓名': '測試一', '假別': '出差', '時數': 1.5 },
            { '日期': '2026-09-19', '姓名': '測試一', '假別': '出差', '時數': 2 },
            { '日期': '2026-09-09', '姓名': '測試一', '假別': '特休', '時數': 2.5 },
            { '日期': '2026-09-02', '姓名': '測試一', '假別': '出差', '時數': '' }];
const c = call('payCollect', '2026-09', 6, 'CF', [])['E01'];
// 9/1 整天出差 8−8=0 ✗；9/2 出差時數留白＝整天 ✗；9/18 10−1.5=8.5 ✓；9/19 7−2=5 ✗；9/9 5.5 ✗（滿 6H 才算）
chk('出差日以打卡時數判斷：只算 9/18', c.work_days, 1);
chk('暫存欄位不外露', [c._dh, c._trip], [undefined, undefined]);

// ② 多筆自訂加薪：存→讀
sb.__TAB.input = [{ ym: '2026-09', emp_id: 'X', store: 'SSLGF', hours: 1 }];   // 他店資料不可被動到
call('handlePayrollInputSet', { store: 'CF', ym: '2026-09', inputs: { E01: { hours: 160, custom_add_label: '8月分紅', custom_add_amt: 6565,
  custom_add_more: [{ label: 'AI種子計畫補助', amt: 600 }, { label: '', amt: 0 }] } } });
let saved = call('paySavedInputs', '2026-09', 'CF').E01;
chk('第一筆照舊', [saved.custom_add_label, saved.custom_add_amt], ['8月分紅', 6565]);
chk('第二筆存得回來（空白列丟掉）', saved.custom_add_more, [{ label: 'AI種子計畫補助', amt: 600 }]);
chk('他店資料不動', sb.__TAB.input.filter(r => r.store === 'SSLGF').length, 1);
sb.__TAB.input.find(r => r.emp_id === 'E01').custom_add_more = '[{"label":壞掉';
saved = call('paySavedInputs', '2026-09', 'CF').E01;
chk('壞掉的 JSON 要回報、不可靜默歸零', [saved.custom_add_more, saved.custom_add_more_error], [[], '無法解析']);
const oldRow = { ym: '2026-08', emp_id: 'E01', store: 'CF', hours: 1, custom_add_label: 'a', custom_add_amt: 1 };
sb.__TAB.input.push(oldRow);
chk('舊月份沒有這欄＝空陣列', call('paySavedInputs', '2026-08', 'CF').E01.custom_add_more, []);

// ②③ 引擎
const emp = { emp_id: 'E01', is_full_time: true, base: 30000, attend_cap: 0, ot_rate: 200 };
const cfg = Object.assign({}, vm.runInContext('(function(){var o={};PAY_CONFIG_DEFAULT.forEach(function(d){o[d[0]]=d[1]});return o})()', sb));
const run = (ym, att, cf) => call('payCalcOne', emp, ym, Object.assign({ hours: 160, deduct_days: 0, late_min: 0 }, att), Object.assign({}, cfg, cf || {}), 0, []);
let r = run('2026-09', { custom_add_label: '8月分紅', custom_add_amt: 6565, custom_add_more: [{ label: 'AI種子計畫補助', amt: 600 }] });
chk('引擎：兩筆各一列', r.earn.filter(x => x.item_key === 'custom_add').map(x => [x.item_label, x.amount]), [['8月分紅', 6565], ['AI種子計畫補助', 600]]);
const late = (ym, from) => (run(ym, { late_min: 5 }, { late_deduct_from: from }).ded.find(x => x.item_key === 'late_deduct') || {}).amount || 0;
chk('遲到：起始 2026-10，九月不扣', late('2026-09', '2026-10'), 0);
chk('遲到：起始 2026-10，十月照扣', late('2026-10', '2026-10') > 0, true);
chk('遲到：空白＝一直都扣（光復不變）', late('2026-09', '') > 0, true);

console.log(`\nmeal-trip-customadd-latefrom: ${p} 通過, ${f} 失敗`);
process.exit(f ? 1 : 0);
