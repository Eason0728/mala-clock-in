/* 同仁端假別額度（payMyLeaveQuota ＋ handleMyPayslip）。
 *
 * 這支的存在理由：同仁看到的剩餘天數若跟主管看到的對不上，比不顯示更糟——會變成
 * 「同仁以為還有假、店長說沒有」的爭議。所以規則必須同源（payLeaveUsage），
 * 而且三個回傳路徑（未結算／結算中／已定案）都要帶，否則同仁在月中就查不到。 */
const fs = require('fs'), vm = require('vm');
const __ROOT = require('path').join(__dirname, '..');   // CI 上 checkout 路徑不同，不可寫死
const P = fs.readFileSync(__ROOT + '/apps-script/Payroll.gs', 'utf8');

const sb = { console, SpreadsheetApp: {}, Utilities: {}, Logger: { log() {} },
             PropertiesService: {}, LockService: {} };
vm.createContext(sb); vm.runInContext(P, sb);

// 假資料：小美今年請過病假 20 日、婚假 8 日；事假一天都沒請
const LEAVE = [
  { '日期':'2026-03-02', '姓名':'小美', '假別':'病假', '時數':80 },
  { '日期':'2026-06-09', '姓名':'小美', '假別':'病假', '時數':80 },
  { '日期':'2026-04-01', '姓名':'小美', '假別':'婚假', '時數':64 },
  { '日期':'2026-05-05', '姓名':'別人', '假別':'事假', '時數':40 },   // 不可算到小美頭上
];
vm.runInContext(`
  __STATUS = 'final';
  payRead = function(k){
    if (k === 'master') return [{ emp_id:'E01', name:'小美', store:'SSLGF', active:'true',
                                  is_full_time:'true', hire_date:'' }];
    if (k === 'run')    return [{ ym:'2026-08', emp_id:'E01', store:'SSLGF', status:globalThis.__STATUS,
                                  total_hours:160, gross:1, deduction:0, net:1 }];
    return [];
  };
  payClockRead = function(st, sheet){
    if (sheet === 'leave')  return globalThis.__LEAVE;
    if (sheet === 'roster') return [{ emp_id:'E01', name:'小美', key:'EMPKEY', active:'true' }];
    return [];
  };
  // normCellDate／findRosterByKey 住在 Code.gs（正式環境同一個 GAS 專案，所以呼叫得到）；
  // 本測只載 Payroll.gs，要自己補。行為對齊 Code.gs：日期一律正規化成 yyyy-MM-dd 字串。
  normCellDate = function(v){ return String(v).slice(0, 10); };
  findRosterByKey = function(rows, key){
    return rows.filter(function(r){ return String(r.key) === String(key)
      && String(r.active).toLowerCase() === 'true'; })[0] || null;
  };
  payStoreList = function(){ return [{ code:'SSLGF' }]; };
  payConfig    = function(){ return { daily_hours:8, payday:10 }; };
  payAnnualInfo= function(){ return {}; };
  currentYmTaipei = function(){ return '2026-08'; };
`, sb);
sb.__LEAVE = LEAVE;
const call = (f, ...a) => vm.runInContext(f, sb)(...a);
const setStatus = s => { sb.__STATUS = s; vm.runInContext('__STATUS=' + JSON.stringify(s), sb); };

let p = 0, f = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? p++ : f++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };

console.log('══ 顯示範圍：事假病假一律列，其他只在請過時出現 ══');
const q = call('payMyLeaveQuota', 'E01', '小美', '2026-08', 'SSLGF');
const byCode = {}; q.forEach(x => byCode[x.code] = x);
chk('列出的假別', q.map(x => x.code).sort(), ['marriage', 'personal', 'sick']);
chk('沒請過的育嬰假不出現', byCode.parental === undefined, true);
chk('沒請過的安胎假不出現', byCode.prenatal_rest === undefined, true);

console.log('\n══ 數字正確且與主管端同源 ══');
chk('病假已用 20 日', byCode.sick.used_days, 20);
chk('病假已用 160 H', byCode.sick.used_h, 160);
chk('病假剩 10 日', byCode.sick.remain_days, 10);
chk('病假剩 80 H', byCode.sick.remain_h, 80);
chk('事假沒請過＝0 日', byCode.personal.used_days, 0);
chk('事假剩滿額 14 日', byCode.personal.remain_days, 14);
// 畫面統一用時數呈現，所以上限也必須有時數版本，否則前端得自己乘 8（規則會漂移）
chk('病假上限有時數版 240 H', byCode.sick.cap_h, 240);
chk('事假上限有時數版 112 H', byCode.personal.cap_h, 112);
chk('婚假上限有時數版 64 H', byCode.marriage.cap_h, 64);
chk('別人的事假沒被算進來', byCode.personal.used_days, 0);
chk('婚假是每次事件制', byCode.marriage.basis, 'event');
// 主管端（payroll_leave_options 走的 payLeaveUsage）算出來必須一模一樣
const admin = call('payLeaveUsage', 'E01', '2026-08',
  call('payLeaveTypes', 'SSLGF'), { daily_hours: 8 }, null,
  LEAVE.filter(l => l['姓名'] === '小美').map(l => ({
    emp_id: 'E01', date: l['日期'], hours: l['時數'],
    code: call('payLeaveCode', l['假別'], call('payLeaveTypes', 'SSLGF')) })), []);
chk('與主管端病假已用天數一致', byCode.sick.used_days, admin.sick.used_days);
chk('與主管端病假剩餘天數一致', byCode.sick.remain_days, admin.sick.remain_days);

console.log('\n══ 三個回傳路徑都要帶 leave_quota ══');
setStatus('final');
chk('已定案', (call('handleMyPayslip', { key:'EMPKEY', ym:'2026-08' }).leave_quota || []).length, 3);
setStatus('draft');
chk('結算中', (call('handleMyPayslip', { key:'EMPKEY', ym:'2026-08' }).leave_quota || []).length, 3);
chk('尚未結算（查沒有 run 的月份）',
    (call('handleMyPayslip', { key:'EMPKEY', ym:'2026-09' }).leave_quota || []).length, 3);

console.log('\n══ 只看得到自己 ══');
chk('金鑰不對 → unauthorized', call('handleMyPayslip', { key:'亂打的' }).error, 'unauthorized');

/* 打卡上線前的月份，請假是填在薪資「手動工時」的事假H／病假H 欄位，不在 leave 分頁。
   2026-08-27 實際踩到：B 君 5–7 月共 101.25H 病假完全沒被算進額度。 */
console.log('\n══ 手動工時的請假也要算進額度 ══');
vm.runInContext(`
  payRead = function(k){
    if (k === 'master') return [{ emp_id:'E01', name:'小美', store:'SSLGF', active:'true',
                                  is_full_time:'true', hire_date:'' }];
    if (k === 'run')    return [];
    if (k === 'input')  return globalThis.__INPUT;
    return [];
  };
`, sb);
// 6 月手動：病假 50H；7 月手動：事假 10H。
// ⚠ 期望值 130 不是 210：leave 分頁的 6/09 那筆 80H 被 6 月的手動列蓋掉（同月以手動為準），
//   所以是「3 月 leave 80H ＋ 6 月手動 50H」。第一版我寫 210 是自己算錯，不是程式錯。
vm.runInContext(`__INPUT = [
  { ym:'2026-06', emp_id:'E01', store:'SSLGF', sick_h:50, personal_h:0 },
  { ym:'2026-07', emp_id:'E01', store:'SSLGF', sick_h:0,  personal_h:10 }
];`, sb);
let q2 = call('payMyLeaveQuota', 'E01', '小美', '2026-08', 'SSLGF');
let m2 = {}; q2.forEach(x => m2[x.code] = x);
chk('病假＝3月leave 80H＋6月手動50H', m2.sick.used_h, 130);
chk('事假＝手動10H', m2.personal.used_h, 10);

console.log('\n══ 同月兩邊都有 → 以手動為準，不重複計 ══');
// 3 月同時有 leave 分頁 80H 與手動 8H → 只認手動的 8H
vm.runInContext(`__INPUT = [{ ym:'2026-03', emp_id:'E01', store:'SSLGF', sick_h:8 }];`, sb);
q2 = call('payMyLeaveQuota', 'E01', '小美', '2026-08', 'SSLGF');
m2 = {}; q2.forEach(x => m2[x.code] = x);
chk('3月只算手動8H，6月leave 80H照算', m2.sick.used_h, 88);

console.log('\n══ 別店的手動工時不可算進來 ══');
vm.runInContext(`__INPUT = [{ ym:'2026-06', emp_id:'E01', store:'CF', sick_h:999 }];`, sb);
q2 = call('payMyLeaveQuota', 'E01', '小美', '2026-08', 'SSLGF');
m2 = {}; q2.forEach(x => m2[x.code] = x);
chk('央廚的列不影響光復', m2.sick.used_h, 160);

console.log('\n══ 特休不列在這張表（週年制另算）══');
vm.runInContext(`__INPUT = [{ ym:'2026-06', emp_id:'E01', store:'SSLGF', annual_h:24 }];`, sb);
q2 = call('payMyLeaveQuota', 'E01', '小美', '2026-08', 'SSLGF');
chk('沒有特休列', q2.filter(x => x.code === 'annual').length, 0);

console.log(f ? `\n❌ ${f} 項失敗（通過 ${p}）` : `\n✅ 同仁端假別額度全部正確 (${p}/${p})`);
process.exit(f ? 1 : 0);
