/* 期間補休帳 payroll_comp_period（2026-11-14 Eason：班表截止前 15／10／5 天，行政群列各單位正職本期加班、補休）。
 * 口徑同月補休帳：加班＝核准加班單（休息日同日合計只算前 2 小時、例假／國定假日不算）；
 * 補休＝leave 分頁補休與審核中／已核准補休申請，同一天取大的；只算 from～to（跨月）。期望值手算寫死。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const C = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(ROOT, 'apps-script', 'Payroll.gs'), 'utf8');

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want)));
};

const FT = (o) => Object.assign({ is_full_time: 'true', active: 'true', store: 'SSLGF' }, o);
const DB = {
  master: [FT({ emp_id: 'E01', name: '甲君' }),
           FT({ emp_id: 'E02', name: '乙君' }),
           FT({ emp_id: 'E03', name: '丙君', is_full_time: 'false' }),          // 計時：不列
           FT({ emp_id: 'E04', name: '丁君' }),                                  // 期間內都沒有：不列
           FT({ emp_id: 'E05', name: '戊君', active: 'false' }),                 // 停用：不列
           FT({ emp_id: 'M01', name: '己君', store: 'MZTJS' }),                  // 墨竹亭也算（Eason 2026-11-14 開放補休）
           FT({ emp_id: 'C01', name: '庚君', store: 'CF' })],
  store: [{ code: 'SSLGF', name: '小辛辣 光復店' }, { code: 'CF', name: '央廚' }, { code: 'MZTJS', name: '墨竹亭 金山店' }],
};
let rid = 0;
const RQ = (o) => Object.assign({ id: 'r' + (++rid), name: '甲君', kind: 'ot', date: '2026-11-03', hours: 2, status: 'approved' }, o);
const LV = (d, n, t, h) => ({ '日期': d, '姓名': n, '假別': t, '時數': h });
const CLOCK = {
  SSLGF: {
    requests: [
      RQ({}),                                                   // 甲 11/03 平日 2
      RQ({ date: '2026-11-08', hours: 5 }),                     // 甲 11/08 休息日 5 → 只算 2
      RQ({ date: '2026-11-08', hours: 1 }),                     //        同日合計 6 → 仍只算 2
      RQ({ date: '2026-11-09', hours: 3 }),                     // 甲 11/09 例假 → 0
      RQ({ date: '2026-11-25', hours: 1.5, status: 'pending' }),// 審核中加班 → 不算
      RQ({ date: '2026-10-31', hours: 9 }),                     // 期間前 → 不算
      RQ({ date: '2026-11-29', hours: 9 }),                     // 期間後（下一期）→ 不算
      RQ({ kind: 'leave', leave_type: '補休', date: '2026-11-20', hours: 4, status: 'pending' }),   // 甲 審核中補休（未來日）4
      RQ({ kind: 'leave', leave_type: '補休', date: '2026-11-21', hours: 8, status: 'rejected' }),  // 退回 → 不算
      RQ({ kind: 'leave', leave_type: '特休', date: '2026-11-22', hours: 8, status: 'approved' }),  // 不是補休
      RQ({ name: '乙君', kind: 'leave', leave_type: '補休', date: '2026-11-05', hours: 8, status: 'approved' }),
      RQ({ name: '丙君', date: '2026-11-04', hours: 6 }),
    ],
    leave: [LV('2026-11-05', '乙君', '補休', 8),                // 同日申請 8 → 取大 8 不重算
            LV('2026-11-06', '乙君', '補休', 4),                // 只有主管登記 → 4
            LV('2026-11-28', '甲君', '補休', 1),                // 期間最後一天 → 算
            LV('2026-11-29', '甲君', '補休', 8)],               // 下一期 → 不算
  },
  CF: { requests: [RQ({ name: '庚君', date: '2026-11-30', hours: 3 })], leave: [] },   // 庚：跨月期間 T02 才有
  MZTJS: { requests: [RQ({ name: '己君', date: '2026-11-12', hours: 2.5 })], leave: [LV('2026-11-13', '己君', '補休', 4)] },
};
const SCHED = { E01: { '2026-11-03': { t: 'W' }, '2026-11-08': { t: 'H' }, '2026-11-09': { t: 'R' } } };

function ctx(props) {
  const sb = {
    console, Logger: { log() {} },
    SpreadsheetApp: { flush: () => {}, getActive: () => null, openById: () => null },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props || {})[k] || null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.__C = CLOCK; sb.__DB = DB; sb.__S = SCHED;
  vm.runInContext(`
    payClockRead = function(store, sheet){ return ((globalThis.__C[payStore(store)] || {})[sheet] || []).slice(); };
    payRead      = function(kind){ return (globalThis.__DB[kind] || []).slice(); };
    payStoreList = function(){ return globalThis.__DB.store.slice(); };
    payEmpStoresMap = function(){ return {}; };
    checkAdmin = function(b){ return b.admin_key === 'ADM'; };
    paySchedIndex_ = function(){ return {}; };
    paySchedMonth_ = function(ym, st, emps){ var o = {}; emps.forEach(function(e){ o[e.emp_id] = globalThis.__S[e.emp_id] || {}; }); return o; };
    payHolidayRow = function(){ return null; };
    payHolMoved_ = function(){ return {}; };
  `, sb);
  return sb;
}

const sb = ctx({ ATT_ALERT_SVC_KEY: 'SVC' });
const call = (b) => vm.runInContext('handlePayrollCompPeriod', sb)(b);

console.log('══ 1) 驗證身分與參數 ══');
chk('沒金鑰擋', call({ from: '2026-11-01', to: '2026-11-28' }).error, 'unauthorized');
chk('錯的 svcKey 擋', call({ svcKey: 'X', from: '2026-11-01', to: '2026-11-28' }).error, 'unauthorized');
chk('沒設 ATT_ALERT_SVC_KEY 的部署：svcKey 一律擋', vm.runInContext('handlePayrollCompPeriod', ctx({}))({ svcKey: '', from: '2026-11-01', to: '2026-11-28' }).error, 'unauthorized');
chk('日期格式錯', call({ svcKey: 'SVC', from: '2026/11/01', to: '2026-11-28' }).error, 'bad_input');
chk('from 晚於 to', call({ svcKey: 'SVC', from: '2026-11-28', to: '2026-11-01' }).error, 'bad_input');
chk('超過 40 天', call({ svcKey: 'SVC', from: '2026-11-01', to: '2026-12-26' }).error, 'bad_input');
chk('管理金鑰也可以', call({ admin_key: 'ADM', from: '2026-11-01', to: '2026-11-28' }).ok, true);

console.log('\n══ 2) T01 11/01～11/28 ══');
const r = call({ svcKey: 'SVC', from: '2026-11-01', to: '2026-11-28' });
const by = {}; r.stores.forEach((s) => s.list.forEach((x) => { by[x.name] = [s.store, x.ot_h, x.used_h, x.balance_h]; }));
// 甲：加班 2（平日）＋2（休息日 6 只算前 2）＋0（例假）＝4；補休 4（審核中）＋1（11/28）＝5 → 欠 1
chk('甲君：加班 4、補休 5、欠 1', by['甲君'], ['SSLGF', 4, 5, -1]);
// 乙：補休 11/05 取大 8 ＋ 11/06 4 ＝ 12，加班 0 → 欠 12
chk('乙君：加班 0、補休 12、欠 12', by['乙君'], ['SSLGF', 0, 12, -12]);
chk('墨竹亭己君：加班 2.5、補休 4、欠 1.5（班表查不到＝全算）', by['己君'], ['MZTJS', 2.5, 4, -1.5]);
chk('計時丙君、沒動靜丁君、停用戊君、期間外庚君都不列', ['丙君', '丁君', '戊君', '庚君'].map((n) => n in by), [false, false, false, false]);
chk('門市依門市表順序、沒人的店不出現', r.stores.map((s) => s.store), ['SSLGF', 'MZTJS']);
chk('回傳門市名稱', r.stores[0].name, '小辛辣 光復店');

console.log('\n══ 3) T02 11/29～12/26（跨月）══');
const r2 = call({ svcKey: 'SVC', from: '2026-11-29', to: '2026-12-26' });
const by2 = {}; r2.stores.forEach((s) => s.list.forEach((x) => { by2[x.name] = [x.ot_h, x.used_h, x.balance_h]; }));
chk('甲君：11/29 加班 9（班表查不到全算）、補休 8 → 剩 1', by2['甲君'], [9, 8, 1]);
chk('央廚庚君：11/30 加班 3 → 剩 3', by2['庚君'], [3, 0, 3]);

console.log('\n══ 3b) roster:true 另回全部在職正職 ══');
chk('沒帶 roster 不回 ft', 'ft' in r, false);
chk('roster:true：在職正職（不含計時、停用）', call({ svcKey: 'SVC', from: '2026-11-01', to: '2026-11-28', roster: true }).ft.map((x) => x.store + ':' + x.name),
  ['SSLGF:甲君', 'SSLGF:乙君', 'SSLGF:丁君', 'MZTJS:己君', 'CF:庚君']);

console.log('\n══ 4) 月補休帳那支沒動 ══');
chk('payCompMonthBook 仍在、11 月甲君照月算（含 11/29 的 9 與 11/29 補休 8）', (() => {
  const c = vm.runInContext('payCompMonthBook', sb)('2026-11').forEmp(DB.master[0], 'SSLGF');
  return [c.ot_h, c.used_h];
})(), [13, 13]);

console.log(`\n${pass} 過、${fail} 失敗`);
if (fail) process.exit(1);
