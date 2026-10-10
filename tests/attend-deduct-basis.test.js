/* 每日倒扣只算請假日（2026-10-10 Eason：央廚／總部全勤全有全無，病假一天扣 100、事假整月沒全勤，
 * 忘刷／遲到只看門檻歸零、當天不倒扣）。
 * attend_deduct_basis='leave'：deduct_days 只算假別表 attend_effect 為 deduct／void 的請假日；
 * 'all'（預設）＝改版前行為，光復不受影響。 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');
const C = fs.readFileSync(__ROOT + '/apps-script/Code.gs', 'utf8');
const CLOCK = {};
const sb = { console, SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d) => { const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb); vm.runInContext(C + '\n' + P, sb);
vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};', sb);
sb.__CLOCK = CLOCK;
let BASIS = 'all';
vm.runInContext('payRead=function(){return [];};', sb);
vm.runInContext('var __origCfg=payConfig; payConfig=function(st){var c=__origCfg(st); c.attend_deduct_basis=globalThis.__BASIS(); return c;};', sb);
sb.__BASIS = () => BASIS;
const call = (fn, ...a) => vm.runInContext(fn, sb)(...a);
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

CLOCK.roster = [{ emp_id: 'E01', name: '測試一', active: true, key: 'k' }];
CLOCK.events = [];
const ap = (d, st) => ({ date: d, name: '測試一', emp_id: 'E01', approved_hours: 8, status_text: st, entered_at: 'x', manager_name: 'M' });
// 9/11 忘刷（少一張卡）、9/12 遲到 3 分、9/15 病假一天、9/16 病假＋同天忘刷
CLOCK.approved = [ap('2026-09-11', '第一段下班無打卡'), ap('2026-09-12', '遲到3分'), ap('2026-09-16', '第一段下班無打卡')];
CLOCK.leave = [{ '日期': '2026-09-15', '姓名': '測試一', '假別': '病假', '時數': 8 },
               { '日期': '2026-09-16', '姓名': '測試一', '假別': '病假', '時數': 4 }];

BASIS = 'all';
let c = call('payCollect', '2026-09', 6, 'SSLGF', [])['E01'];
chk('all：忘刷／遲到／病假日都算（9/11、9/12、9/15、9/16）', c.deduct_days, 4);
BASIS = 'leave';
c = call('payCollect', '2026-09', 6, 'CF', [])['E01'];
chk('leave：只算病假日（9/15、9/16）', c.deduct_days, 2);
chk('leave：忘刷次數照算（給門檻用）', c.forget_punch, 2);
chk('leave：遲到分鐘照算（給門檻用）', c.late_min, 3);

// 只有忘刷一天（陳建樺 2026-09 案例）→ 0
CLOCK.approved = [ap('2026-09-11', '第一段下班無打卡')]; CLOCK.leave = [];
c = call('payCollect', '2026-09', 6, 'CF', [])['E01'];
chk('leave：只有忘刷 1 天 → 缺勤 0', c.deduct_days, 0);
chk('leave：忘刷 1 次仍記錄', c.forget_punch, 1);
BASIS = 'all';
c = call('payCollect', '2026-09', 6, 'SSLGF', [])['E01'];
chk('all：同樣資料 → 缺勤 1（光復行為不變）', c.deduct_days, 1);

// 引擎：全勤 3000、每日倒扣 100
const emp = { emp_id: 'E01', is_full_time: true, base: 30000, attend_cap: 3000, ot_rate: 200 };
const cfgBase = Object.assign({}, call('payConfig', 'CF'), { attend_deduct_per_day: 100, attend_void_forget: 3, attend_void_late_min: 11 });
const bonus = (att) => { const r = call('payCalcOne', emp, '2026-09', Object.assign({ hours: 184, deduct_days: 0, forget_punch: 0, late_min: 0, early_min: 0 }, att), cfgBase, 0, call('payLeaveTypes', 'CF'));
  const it = r.earn.find(e => e.item_key === 'attend_bonus'); return it ? it.amount : null; };
chk('引擎：缺勤 0 → 全勤 3000', bonus({ deduct_days: 0, forget_punch: 1 }), 3000);
chk('引擎：病假 2 天 → 2800', bonus({ deduct_days: 2 }), 2800);
chk('引擎：忘刷 3 次 → 歸零', bonus({ deduct_days: 0, forget_punch: 3 }), 0);

// 手動列（按過「儲存工時」）的舊快照 deduct_days 不可蓋掉新口徑（陳建樺 2026-09：手動列 1、應為 0）
vm.runInContext("paySavedInputs=function(){return {E01:{hours:169,deduct_days:1,meal_on:true,work_days:16}, E99:{hours:100,deduct_days:2}};}; payHolidayRow=function(){return null;};", sb);
CLOCK.approved = [ap('2026-09-11', '第一段下班無打卡')]; CLOCK.leave = [];
BASIS = 'leave';
let ib = call('payInputsBase', '2026-09', 'CF');
chk('leave＋手動列：有打卡的人取歸集值 0', ib.E01.deduct_days, 0);
chk('leave＋手動列：其他手動欄位保留（餐費勾選）', ib.E01.meal_on, true);
chk('leave＋手動列：沒打卡資料的人照用手填 2', ib.E99.deduct_days, 2);
BASIS = 'all';
ib = call('payInputsBase', '2026-09', 'SSLGF');
chk('all＋手動列：維持手動優先 1（光復行為不變）', ib.E01.deduct_days, 1);

console.log(`\nattend-deduct-basis: ${p} 通過, ${f} 失敗`);
process.exit(f ? 1 : 0);
