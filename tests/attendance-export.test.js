/* 出勤紀錄匯出（2026-10-09）：Payroll.gs payAttendanceBuild／handlePayrollAttendanceExport
 * 用 vm 載入真檔（Code.gs＋Payroll.gs），不重寫一份邏輯。涵蓋：整月每天都列、跨夜班歸上班那天、
 * 忘刷卡、被擋卡不當有效卡、整天請假（核定 0）、Sheets 的 Date 物件日期、核定取最新、離職者、唯讀。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = ['Code.gs', 'Payroll.gs'].map(f => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')).join('\n');

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`);
};

function fmt(d, tz, pat) {   // 台北時區格式化（Apps Script Utilities.formatDate 的替身）
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return pat === 'yyyy-MM-dd' ? date : `${date}T${p.hour}:${p.minute}:${p.second}+08:00`;
}
const sb = { console, Utilities: { formatDate: fmt }, Logger: { log() {} },
  SpreadsheetApp: { openById: () => { throw new Error('唯讀測試不該開試算表'); }, getActive: () => ({ getSheetByName: () => null }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb); vm.runInContext(SRC, sb);
const VmDate = vm.runInContext('Date', sb);
const build = sb.payAttendanceBuild;
const ev = (emp, date, hm, type, status) => ({ ts: `${date}T${hm}:00+08:00`, emp_id: emp, type, status: status || 'ok' });
const roster = [
  { emp_id: 'E1', name: '測試一', active: 'true' },
  { emp_id: 'E2', name: '測試二', active: 'true' },
  { emp_id: 'E3', name: '測試三', active: 'false' },   // 離職、當月有紀錄
  { emp_id: 'E4', name: '測試四', active: 'false' },   // 離職、當月無紀錄
];
const day = (r, emp, d) => r.employees.find(x => x.emp_id === emp).days.find(x => x.date === d);

const events = [
  ev('E1', '2026-09-01', '08:00', 'in'), ev('E1', '2026-09-01', '17:03', 'out'),
  ev('E1', '2026-09-10', '22:00', 'in'), ev('E1', '2026-09-11', '06:05', 'out'),     // 跨夜
  ev('E1', '2026-09-12', '09:00', 'in'),                                              // 只有上班卡
  ev('E1', '2026-09-13', '18:00', 'out'),                                             // 只有下班卡
  ev('E1', '2026-09-14', '08:10', 'in', 'rejected_out_of_range'),                     // 被擋
  ev('E1', '2026-09-15', '08:00', 'in', 'pending_device_approval'),                   // 待核准
  ev('E1', '2026-09-16', '08:30', 'in'), ev('E1', '2026-09-16', '12:00', 'out'),
  ev('E1', '2026-09-16', '13:00', 'in'), ev('E1', '2026-09-16', '17:30', 'out'),     // 兩段
  ev('E3', '2026-09-02', '09:00', 'in'), ev('E3', '2026-09-02', '18:00', 'out'),
  ev('E1', '2026-08-31', '09:00', 'in'), ev('E1', '2026-08-31', '18:00', 'out'),     // 上個月不該出現
];
const approved = [
  { date: '2026-09-01', emp_id: 'E1', periods: '08:00-17:00', approved_hours: 9, status_text: '正常', manager_name: '主管甲', entered_at: '2026-09-02T09:00:00+08:00' },
  { date: '2026-09-01', emp_id: 'E1', periods: '08:00-17:30', approved_hours: 9.5, status_text: '正常', manager_name: '主管乙', entered_at: '2026-09-03T09:00:00+08:00' },  // 較新
  { date: new VmDate(Date.UTC(2026, 8, 3) - 8 * 3600000), emp_id: 'E1', periods: '', approved_hours: 0, status_text: '全天請假', manager_name: '主管甲', entered_at: new VmDate('2026-09-04T01:00:00Z') },
  { date: '2026-09-10', emp_id: 'E1', periods: '22:00-06:00', approved_hours: 8, status_text: '正常', manager_name: '主管甲', entered_at: '2026-09-11T09:00:00+08:00' },
  { date: '2026-09-02', emp_id: 'E3', periods: '09:00-18:00', approved_hours: 9, status_text: '遲到5分', manager_name: '主管甲', entered_at: '2026-09-03T09:00:00+08:00' },
];
const leave = [
  { '日期': new VmDate(Date.UTC(2026, 8, 3) - 8 * 3600000), '姓名': '測試一', '假別': '病假', '時數': 8 },   // Date 物件
  { '日期': '2026-09-20', '姓名': '測試一', '假別': '特休假', '時數': 4 },
  { '日期': '2026-08-20', '姓名': '測試一', '假別': '事假', '時數': 8 },                                    // 別的月份
];

const r = build('2026-09', roster, events, approved, leave, '');
chk('同仁＝在職兩人＋當月有紀錄的離職者；離職且無紀錄者不列', r.employees.map(x => x.emp_id), ['E1', 'E2', 'E3']);
chk('整月每天都列（9 月 30 天，沒上班的日子也在）', r.employees.map(x => x.days.length), [30, 30, 30]);
chk('日期連續 01…30', r.employees[1].days.map(x => x.date.slice(8)).join(','), Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0')).join(','));
chk('2026-09-01 是星期二', day(r, 'E1', '2026-09-01').weekday, '二');
chk('沒上班的日子：空白（沒段、沒核定、沒請假）', (d => [d.segments.length, d.invalid.length, d.approved, d.leave.length])(day(r, 'E2', '2026-09-05')), [0, 0, false, 0]);
chk('上個月（8/31）的卡不出現在 9 月', r.employees[0].days.every(d => d.date.startsWith('2026-09')), true);

const d1 = day(r, 'E1', '2026-09-01');
chk('核定取最新一筆（9.5 小時、主管乙）', [d1.approved_hours, d1.manager, d1.periods], [9.5, '主管乙', '08:00-17:30']);
chk('正常一段：08:00–17:03，非跨夜', d1.segments, [{ in: '08:00', out: '17:03', cross: false }]);

chk('跨夜班歸上班那天（9/10 22:00–06:05 跨夜）', day(r, 'E1', '2026-09-10').segments, [{ in: '22:00', out: '06:05', cross: true }]);
chk('跨夜班隔天（9/11）不重複出現', day(r, 'E1', '2026-09-11').segments, []);

chk('忘刷卡（只有上班卡）：下班為 null', day(r, 'E1', '2026-09-12').segments, [{ in: '09:00', out: null, cross: false }]);
chk('忘刷卡（只有下班卡）：上班為 null', day(r, 'E1', '2026-09-13').segments, [{ in: null, out: '18:00', cross: false }]);

const d14 = day(r, 'E1', '2026-09-14');
chk('被擋的卡不當有效卡（無段），但列出並標註狀態', [d14.segments.length, d14.invalid.map(x => [x.time, x.type, x.label])], [0, [['08:10', 'in', '超出範圍，未入帳']]]);
chk('待核准裝置的卡同樣標註', day(r, 'E1', '2026-09-15').invalid[0].label, '新裝置待核准，未入帳');

chk('同一天兩段', day(r, 'E1', '2026-09-16').segments.map(s => s.in + '-' + s.out), ['08:30-12:00', '13:00-17:30']);

const d3 = day(r, 'E1', '2026-09-03');
chk('整天請假：核定 0、已核定、請假（Date 物件日期）病假 8H', [d3.approved, d3.approved_hours, d3.status_text, d3.leave, d3.leave_hours],
  [true, 0, '全天請假', [{ type: '病假', hours: 8 }], 8]);
chk('Date 物件的 leave 日期（9/20）也對得上', day(r, 'E1', '2026-09-20').leave, [{ type: '特休假', hours: 4 }]);
chk('別的月份的請假不進來', r.employees[0].days.reduce((a, d) => a + d.leave_hours, 0), 12);

chk('E1 合計：核定 9.5+0+8=17.5；請假 12；出勤天數 2（核定 0 的請假日不算）',
  r.employees[0].totals, { approved_hours: 17.5, leave_hours: 12, work_days: 2, pending_days: 3 });
chk('pending_days＝有有效打卡卻尚未核定的天數（9/12、9/13、9/16）', r.employees[0].totals.pending_days, 3);
chk('離職者 E3 合計與標記', [r.employees[2].active, r.employees[2].totals.approved_hours, r.employees[2].totals.work_days], [false, 9, 1]);
chk('E3 狀態字樣沿用核定', day(r, 'E3', '2026-09-02').status_text, '遲到5分');

const only = build('2026-09', roster, events, approved, leave, 'E2');
chk('指定單一同仁只回他', only.employees.map(x => x.emp_id), ['E2']);
chk('二月 28 天（非閏年）', build('2026-02', roster, [], [], [], 'E1').employees[0].days.length, 28);
chk('閏年二月 29 天', build('2028-02', roster, [], [], [], 'E1').employees[0].days.length, 29);

// ── handler：認證、參數、唯讀 ──
chk('沒有管理金鑰 → unauthorized', sb.handlePayrollAttendanceExport({ ym: '2026-09' }).error, 'unauthorized');
const src = SRC.slice(SRC.indexOf('function handlePayrollAttendanceExport'));
const body = src.slice(0, src.indexOf('\n}\n') + 2);
chk('handler 與 builder 全程唯讀（沒有任何寫入呼叫）', /appendRow|setValue|payReplaceAll|payAppend|deleteRow|clear\(/.test(body + SRC.slice(SRC.indexOf('function payAttendanceBuild'), SRC.indexOf('function handlePayrollAttendanceExport'))), false);
chk('已註冊進 PAYROLL_HANDLERS', /payroll_attendance_export:\s*handlePayrollAttendanceExport/.test(SRC), true);

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通過／${fail} 失敗`);
process.exit(fail ? 1 : 0);
