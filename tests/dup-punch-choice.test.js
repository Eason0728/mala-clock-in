// 主管認定的重複打卡（2026-11-06 Eason）：真的 Code.gs＋Payroll.gs 跑在假試算表上。
// 例子：上午 09:02–13:38，晚上 17:26 上班、17:55 又按上班、21:00 下班（兩張上班卡相隔 29 分）。
// 釘住：①重複卡組怎麼抓（同型相鄰、60 分內、下班卡跨夜歸前一天）②mgr_approve 存選擇、擋亂送
// ③選了之後打卡段、遲到、忘刷、狀態欄都照選的那張 ④不選＝照舊算忘刷 ⑤舊呼叫端沒送 dup_ignore 不洗掉
// ⑥每日重算保留認定 ⑦薪資忘刷次數排除被認定的那張
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const P = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Payroll.gs'), 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function sheet(rows) {
  const data = rows.map((r) => r.slice());
  return {
    data,
    getDataRange() { return { getValues: () => data.map((r) => r.slice()) }; },
    appendRow(r) { data.push(r.slice()); },
    deleteRow(i) { data.splice(i - 1, 1); },
    getLastRow() { return data.length; },
    getLastColumn() { return data.reduce((m, r) => Math.max(m, r.length), 0); },
    getMaxRows() { return 1000; },
    getSheetId() { return 1; },
    getRange(r, c, nr, nc) {
      return {
        getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = data[r - 1 + i] || []; const o = []; for (let j = 0; j < (nc || 1); j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
        setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
        setValues() {}, setNumberFormat() {},
      };
    },
  };
}
const D = '2026-11-05';
const T = (hm, d) => (d || D) + 'T' + hm + ':00+08:00';
const ev = (hm, type, d) => [T(hm, d), 'E01', type, 'ok'];
const BASE = [ev('09:02', 'in'), ev('13:38', 'out'), ev('17:26', 'in'), ev('17:55', 'in'), ev('21:00', 'out')];
function env(events, approvedRows) {
  const sheets = {
    managers: sheet([['name', 'key', 'active'], ['測試主管', 'MK', 'true']]),
    roster: sheet([['emp_id', 'name', 'key', 'active'], ['E01', '測試一', 'k1', 'true']]),
    events: sheet([['ts', 'emp_id', 'type', 'status']].concat(events || BASE)),
    approved: sheet([['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at']].concat(approvedRows || [])),
    leave: sheet([['日期', '姓名', '假別', '時數']]),
  };
  const sb = { console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array, RegExp, Error,
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) }, Logger: { log() {} } };
  vm.createContext(sb);
  vm.runInContext(C + '\n' + P, sb);
  sb.getSS = () => ({ getSheetByName: (k) => sheets[k] || null });
  let clock = 0;
  sb.nowTaipeiIso = () => '2026-11-06T09:00:' + String(10 + (clock++)).padStart(2, '0') + '+08:00';
  sb.todayTaipeiStr = () => '2026-11-06';
  sb.isTripDay = () => false;
  sb.__s = sheets;
  return sb;
}
const P2 = [{ start: '09:00', end: '13:30' }, { start: '17:30', end: '21:00' }];
const last = (sb) => sb.__s.approved.data[sb.__s.approved.data.length - 1];
const plain = (x) => JSON.parse(JSON.stringify(x));
const segText = (segs) => segs.map((s) => (s.in || '？') + '–' + (s.out || '？')).join('、');

console.log('══ 抓重複卡組 ══');
ok('17:26／17:55 兩張上班卡 → 一組', () => {
  const sb = env();
  const g = plain(sb.dupPunchGroups_(BASE.map(([ts, emp_id, type, status]) => ({ ts, emp_id, type, status })), 'E01', D));
  assert.deepStrictEqual(g, [{ type: 'in', cards: [{ ts: T('17:26'), hm: '17:26' }, { ts: T('17:55'), hm: '17:55' }] }]);
});
const groupsOf = (events, d) => plain(env(events).dupPunchGroups_(events.map(([ts, emp_id, type, status]) => ({ ts, emp_id, type, status })), 'E01', d || D));
ok('相隔超過 60 分（09:00 上班、17:30 又上班）→ 沒有選項，照算忘刷', () => {
  assert.deepStrictEqual(groupsOf([ev('09:00', 'in'), ev('17:30', 'in'), ev('21:00', 'out')]), []);
});
ok('剛好 60 分 → 算一組', () => {
  assert.strictEqual(groupsOf([ev('17:00', 'in'), ev('18:00', 'in'), ev('21:00', 'out')]).length, 1);
});
ok('中間夾一張下班卡（上、下、上）→ 不是重複', () => {
  assert.deepStrictEqual(groupsOf([ev('17:00', 'in'), ev('17:20', 'out'), ev('17:40', 'in'), ev('21:00', 'out')]), []);
});
ok('被擋下的卡不算（只看成功的卡）', () => {
  assert.deepStrictEqual(groupsOf([ev('17:26', 'in'), [T('17:30'), 'E01', 'in', 'rejected_duplicate'], ev('21:00', 'out')]), []);
});
ok('下班卡重複（21:00、21:20）→ 一組 out', () => {
  const g = groupsOf([ev('17:00', 'in'), ev('21:00', 'out'), ev('21:20', 'out')]);
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].type, 'out');
});
ok('跨夜班凌晨重複下班卡（00:05、00:30）→ 歸前一天、不歸當天', () => {
  const evs = [ev('18:00', 'in'), ev('00:05', 'out', '2026-11-06'), ev('00:30', 'out', '2026-11-06')];
  assert.strictEqual(groupsOf(evs, D).length, 1);
  assert.strictEqual(groupsOf(evs, '2026-11-06').length, 0);
});
ok('三張連打（17:26、17:40、17:55）→ 同一組三張', () => {
  const g = groupsOf([ev('17:26', 'in'), ev('17:40', 'in'), ev('17:55', 'in'), ev('21:00', 'out')]);
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].cards.length, 3);
});

console.log('\n══ 核定送出 ══');
ok('不選（照現在規則）→ 遲到 2＋25、狀態沒有認定字樣、沒寫 dup_ignore', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [] });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.status_text, '遲到2分、遲到25分');
  assert.strictEqual(r.approved_hours, 8);
  assert.strictEqual(last(sb).length, 8);
});
ok('以 17:26 為準（認定 17:55 重複）→ 只剩遲到 2、狀態標認定、存 dup_ignore', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:55')] });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.status_text, '遲到2分、主管認定重複打卡（17:55）');
  assert.strictEqual(r.approved_hours, 8);
  assert.strictEqual(sb.__s.approved.data[0][8], 'dup_ignore');
  assert.strictEqual(last(sb)[8], JSON.stringify([T('17:55')]));
});
ok('以 17:55 為準（認定 17:26 重複）→ 遲到 2＋25（照 17:55 比）', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:26')] });
  assert.strictEqual(r.status_text, '遲到2分、遲到25分、主管認定重複打卡（17:26）');
});
ok('主管手動填遲到分鐘仍優先', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], late_min: '0', dup_ignore: [T('17:26')] });
  assert(r.status_text.indexOf('主管認定不計遲到') !== -1 && r.status_text.indexOf('主管認定重複打卡（17:26）') !== -1, r.status_text);
});
ok('兩張都勾掉 → 擋下、不寫入', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:26'), T('17:55')] });
  assert.strictEqual(r.error, 'bad_dup_ignore'); assert.strictEqual(sb.__s.approved.data.length, 1);
});
ok('送一張不屬於重複組的卡（09:02）→ 擋下', () => {
  const sb = env();
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('09:02')] });
  assert.strictEqual(r.error, 'bad_dup_ignore');
});
ok('格式不是陣列 → 擋下', () => {
  const sb = env();
  assert.strictEqual(sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: 'x' }).error, 'bad_dup_ignore');
});
ok('舊呼叫端重送（沒帶 dup_ignore）→ 沿用上一筆認定，不洗掉', () => {
  const sb = env();
  sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:55')] });
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [] });
  assert.strictEqual(r.status_text, '遲到2分、主管認定重複打卡（17:55）');
  assert.strictEqual(last(sb)[8], JSON.stringify([T('17:55')]));
});
ok('改選「不處理」（送空陣列）→ 取消認定', () => {
  const sb = env();
  sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:55')] });
  const r = sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [] });
  assert.strictEqual(r.status_text, '遲到2分、遲到25分');
  assert.strictEqual(last(sb)[8] || '', '');
});

console.log('\n══ 考勤畫面（mgr_day）══');
ok('還沒核定：列原始三段＋重複卡組、參考留白', () => {
  const sb = env();
  const e = sb.handleMgrDay({ mgr_key: 'MK', date: D }).employees[0];
  assert.strictEqual(segText(e.segments), '09:02–13:38、17:26–？、17:55–21:00');
  assert.strictEqual(e.reference, null);
  assert.strictEqual(e.dup_groups.length, 1);
});
ok('認定 17:55 重複後：合併成 17:26–21:00、參考 7.75、仍回重複卡組與已選的卡', () => {
  const sb = env();
  sb.handleMgrApprove({ mgr_key: 'MK', date: D, emp_id: 'E01', periods: P2, leaves: [], dup_ignore: [T('17:55')] });
  const e = plain(sb.handleMgrDay({ mgr_key: 'MK', date: D }).employees[0]);
  assert.strictEqual(segText(e.segments), '09:02–13:38、17:26–21:00');
  assert.strictEqual(e.reference, 7.75);
  assert.strictEqual(e.dup_groups.length, 1);
  assert.deepStrictEqual(e.approved.dup_ignore, [T('17:55')]);
});
ok('沒有重複卡的人不帶 dup_groups 欄位', () => {
  const sb = env([ev('09:00', 'in'), ev('18:00', 'out')]);
  assert.strictEqual(sb.handleMgrDay({ mgr_key: 'MK', date: D }).employees[0].dup_groups, undefined);
});

console.log('\n══ 每日重算、月表、薪資 ══');
ok('每日重算：認定的那天被重算也保留認定註記與 dup_ignore', () => {
  // 造一筆「該段無打卡」＋認定 17:55 的舊紀錄（重算只看帶這類字樣的紀錄）
  const sb = env(null, [[D, 'E01', '測試一', '09:00-13:30,17:30-21:00', 8, '該段無打卡、主管認定重複打卡（17:55）', '測試主管', '2026-11-06T08:00:00+08:00', JSON.stringify([T('17:55')])]]);
  sb.__s.approved.data[0].push('dup_ignore');
  const r = sb.recheckPendingApprovalStatuses();
  assert.strictEqual(r.fixed, 1);
  assert.strictEqual(last(sb)[5], '遲到2分、主管認定重複打卡（17:55）');
  assert.strictEqual(last(sb)[8], JSON.stringify([T('17:55')]));
});
function pay(dup) {
  const sb = env();
  const appr = [{ date: D, emp_id: 'E01', name: '測試一', periods: '09:00-13:30,17:30-21:00', approved_hours: 8,
    status_text: dup ? '遲到2分、主管認定重複打卡（17:55）' : '遲到2分、遲到25分', manager_name: 'M', entered_at: 'x',
    dup_ignore: dup ? JSON.stringify([T('17:55')]) : '' }];
  const CL = { roster: [{ emp_id: 'E01', name: '測試一', active: true }], events: BASE.map(([ts, emp_id, type, status]) => ({ ts, emp_id, type, status })),
    leave: [], approved: appr, requests: [] };
  sb.__CL = CL;
  vm.runInContext('payClockRead=function(s,sh){return (globalThis.__CL[sh]||[]);};', sb);
  return sb.payCollect('2026-11', 6, 'SSLGF', [])['E01'] || {};
}
ok('薪資：不選 → 忘刷 1 次', () => { assert.strictEqual(pay(false).forget_punch, 1); });
ok('薪資：認定重複 → 忘刷 0 次、遲到只剩 2 分', () => { const c = pay(true); assert.strictEqual(c.forget_punch, 0); assert.strictEqual(c.late_min, 2); });
ok('月表：認定重複後那天不標「下班忘刷卡」', () => {
  const sb = env();
  const roster = [{ emp_id: 'E01', name: '測試一', active: 'true' }];
  const events = BASE.map(([ts, emp_id, type, status]) => ({ ts, emp_id, type, status }));
  const rec = (dup) => [{ date: D, emp_id: 'E01', name: '測試一', periods: '09:00-13:30,17:30-21:00', approved_hours: 8, status_text: 'x', manager_name: 'M', entered_at: 'x', dup_ignore: dup ? JSON.stringify([T('17:55')]) : '' }];
  const txt = (dup) => JSON.stringify(sb.buildMonthlySheet('2026-11', roster, events, [], '2026-11-06', rec(dup)).rows);
  assert(txt(false).indexOf('下班忘刷卡') !== -1);
  assert(txt(true).indexOf('下班忘刷卡') === -1);
});

console.log(`\n✅ 重複打卡認定 ${n} 項全部通過`);
