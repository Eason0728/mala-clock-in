/* 主管核定頁「本月待核定提醒」（2026-09-18 新增）
 *
 * 判斷規則刻意跟同仁打卡頁「尚有 N 天待核定」共用同一套純函式，這裡驗證兩件事：
 *  A. monthPendingApprovalDays 重構成 monthPendingApprovalDates 後，行為完全不變
 *     （純函式，直接餵事件陣列，不需要試算表）。
 *  B. 新 handler handleMgrPendingApprovals 把純函式的結果組成 {date,emp_id,name} 清單、
 *     正確分組排序、正確認證主管金鑰、正確把已停用同仁也列進去。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`);
};

/* ============================================================
 * A. 純函式：monthWorkedDays / monthPendingApprovalDates / monthPendingApprovalDays
 *    不需要試算表，只要一個乾淨的 vm context 把 Code.gs 灌進去即可。
 * ============================================================ */
function makePureCtx() {
  const sb = {
    console,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
    Utilities: { formatDate: () => '' },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C, sb);
  return {
    monthWorkedDays: vm.runInContext('monthWorkedDays', sb),
    monthPendingApprovalDates: vm.runInContext('monthPendingApprovalDates', sb),
    monthPendingApprovalDays: vm.runInContext('monthPendingApprovalDays', sb),
  };
}

function ev(empId, date, hm, type, status) {
  return { ts: `${date}T${hm}:00+08:00`, emp_id: empId, type, status: status || 'ok' };
}

(function () {
  const F = makePureCtx();
  console.log('══ A. monthPendingApprovalDates／monthWorkedDays（純函式） ══');

  // ① 有打卡沒核定 → 列入
  {
    const events = [ev('E01', '2026-09-10', '09:00', 'in'), ev('E01', '2026-09-10', '18:00', 'out')];
    chk('①有打卡沒核定→列入', F.monthPendingApprovalDates(events, {}, 'E01', '2026-09', '2026-09-18'), ['2026-09-10']);
  }

  // ② 已核定 → 不列（見下方 B 段 handler 測試，這裡先用純函式版覆蓋一次）
  {
    const events = [ev('E01', '2026-09-10', '09:00', 'in'), ev('E01', '2026-09-10', '18:00', 'out')];
    const approvedMap = { '2026-09-10': { E01: { approved_hours: 8, entered_at: 'x' } } };
    chk('②已核定→不列', F.monthPendingApprovalDates(events, approvedMap, 'E01', '2026-09', '2026-09-18'), []);
  }

  // ③ 核定 0 小時（全天請假）→ 不列——判斷用「紀錄存不存在」不看數值
  {
    const events = [ev('E01', '2026-09-11', '09:00', 'in'), ev('E01', '2026-09-11', '18:00', 'out')];
    const approvedMap = { '2026-09-11': { E01: { approved_hours: 0, entered_at: 'x' } } };
    chk('③核定0小時(全天請假)→不列', F.monthPendingApprovalDates(events, approvedMap, 'E01', '2026-09', '2026-09-18'), []);
  }

  // ④ 今天 → 不列
  {
    const events = [ev('E01', '2026-09-18', '09:00', 'in'), ev('E01', '2026-09-18', '13:00', 'out')];
    chk('④今天→不列', F.monthPendingApprovalDates(events, {}, 'E01', '2026-09', '2026-09-18'), []);
  }

  // ⑤ 上個月的日子 → 不列（八月底的班不會混進九月）
  {
    const events = [ev('E01', '2026-08-31', '09:00', 'in'), ev('E01', '2026-08-31', '18:00', 'out')];
    chk('⑤上個月的日子→不列', F.monthPendingApprovalDates(events, {}, 'E01', '2026-09', '2026-09-18'), []);
  }

  // ⑥ 只打上班卡（忘刷下班）那天 → 列入
  {
    const events = [ev('E01', '2026-09-12', '09:00', 'in')];
    chk('⑥只打上班卡(忘刷下班)→列入', F.monthPendingApprovalDates(events, {}, 'E01', '2026-09', '2026-09-18'), ['2026-09-12']);
  }

  // ⑦ 跨夜班只算上班那天
  {
    const events = [ev('E01', '2026-09-13', '23:30', 'in'), ev('E01', '2026-09-14', '07:00', 'out')];
    const r = F.monthPendingApprovalDates(events, {}, 'E01', '2026-09', '2026-09-18');
    chk('⑦跨夜班只算上班那天(09-13)', r, ['2026-09-13']);
    chk('⑦跨夜班不會多算09-14', r.indexOf('2026-09-14'), -1);
  }

  // ⑨ monthPendingApprovalDays 重構後結果與 dates.length 一致（多筆混合情境）
  {
    const events = [
      ev('E01', '2026-09-10', '09:00', 'in'), ev('E01', '2026-09-10', '18:00', 'out'), // 待核定
      ev('E01', '2026-09-11', '09:00', 'in'), ev('E01', '2026-09-11', '18:00', 'out'), // 已核定
      ev('E01', '2026-09-12', '09:00', 'in'),                                          // 忘刷下班，待核定
      ev('E01', '2026-09-18', '09:00', 'in'), ev('E01', '2026-09-18', '13:00', 'out'), // 今天，不算
    ];
    const approvedMap = { '2026-09-11': { E01: { approved_hours: 8, entered_at: 'x' } } };
    const dates = F.monthPendingApprovalDates(events, approvedMap, 'E01', '2026-09', '2026-09-18');
    const n = F.monthPendingApprovalDays(events, approvedMap, 'E01', '2026-09', '2026-09-18');
    chk('⑨dates 內容', dates, ['2026-09-10', '2026-09-12']);
    chk('⑨monthPendingApprovalDays === dates.length', n, dates.length);
  }
})();

/* ============================================================
 * B. handleMgrPendingApprovals：整合 roster／events／approved／managers，
 *    用 FakeSheet 模擬試算表（與 tests/audit-fixes.test.js、tests/roster-headers.test.js 同一套手法）。
 * ============================================================ */
function FakeSheet(headers, rows) {
  this.headers = headers.slice();
  this.rows = (rows || []).map(r => r.slice());
}
FakeSheet.prototype.getDataRange = function () {
  const all = [this.headers].concat(this.rows);
  return { getValues: () => all.map(r => r.slice()) };
};

function makeHandlerCtx() {
  const roster = new FakeSheet(
    ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'],
    [
      ['E01', 'Amy', 'k1', '', '', true],
      ['E02', 'Bob', 'k2', '', '', true],
      // E03 已停用（離職），本月仍有打卡紀錄 → 案例 ⑧
      ['E03', 'Cara', 'k3', '', '', false],
      ['E05', 'Dan', 'k5', '', '', true],
    ],
  );
  const events = new FakeSheet(
    ['ts', 'emp_id', 'type', 'status'],
    [
      // E01：09-10 有上班沒核定
      ['2026-09-10T09:00:00+08:00', 'E01', 'in', 'ok'],
      ['2026-09-10T18:00:00+08:00', 'E01', 'out', 'ok'],
      // E02：09-11 有上班，下面 approved 會核掉 → 不應出現
      ['2026-09-11T09:00:00+08:00', 'E02', 'in', 'ok'],
      ['2026-09-11T18:00:00+08:00', 'E02', 'out', 'ok'],
      // E03（已停用）：09-12 有上班沒核定 → 案例 ⑧，仍要列出且帶姓名
      ['2026-09-12T09:00:00+08:00', 'E03', 'in', 'ok'],
      ['2026-09-12T18:00:00+08:00', 'E03', 'out', 'ok'],
      // E05：跟 E01 同一天（09-10）都沒核定，倒著插入，驗證輸出還是照姓名排序
      ['2026-09-10T08:00:00+08:00', 'E05', 'in', 'ok'],
      ['2026-09-10T17:00:00+08:00', 'E05', 'out', 'ok'],
      // E01：8 月底的班，不該混進九月
      ['2026-08-30T09:00:00+08:00', 'E01', 'in', 'ok'],
      ['2026-08-30T18:00:00+08:00', 'E01', 'out', 'ok'],
    ],
  );
  const approved = new FakeSheet(
    ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'],
    [
      ['2026-09-11', 'E02', 'Bob', '09:00-18:00', 8, '正常', '測試主管', '2026-09-11T20:00:00+08:00'],
    ],
  );
  const managers = new FakeSheet(['name', 'key', 'active'], [['測試主管', 'mgrkey1', true]]);

  const ss = {
    sheets: { roster, events, approved, managers },
    getSheetByName(n) { return this.sheets[n] || null; },
  };

  const sb = {
    console,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss },
    // 只用得到 'yyyy-MM-dd'／'yyyy-MM'／"yyyy-MM-dd'T'HH:mm:ssXXX" 三種格式（Code.gs 用到的全部樣式）
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const p = n => ('0' + n).slice(-2);
        const y = d.getFullYear(), mo = p(d.getMonth() + 1), da = p(d.getDate());
        if (fmt === 'yyyy-MM') return `${y}-${mo}`;
        if (fmt === 'yyyy-MM-dd') return `${y}-${mo}-${da}`;
        return `${y}-${mo}-${da}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
      },
    },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext(C, sb);
  // 固定「今天」＝ 2026-09-18（與案例 ④／⑤ 的純函式測試同一天），不依賴跑測試當下的真實日期
  vm.runInContext("todayTaipeiStr = function(){ return '2026-09-18'; };", sb);
  vm.runInContext("currentYmTaipei = function(){ return '2026-09'; };", sb);
  return { call: (...a) => vm.runInContext('handleMgrPendingApprovals', sb)(...a) };
}

(function () {
  console.log('\n══ B. handleMgrPendingApprovals（整合，FakeSheet） ══');
  const ctx = makeHandlerCtx();

  // ⑩ 錯誤主管金鑰被擋
  const bad = ctx.call({ mgr_key: 'wrong-key' });
  chk('⑩錯誤主管金鑰被擋', bad, { ok: false, error: 'unauthorized' });

  const res = ctx.call({ mgr_key: 'mgrkey1' });
  chk('回傳 ok', res.ok, true);
  chk('回傳 ym', res.ym, '2026-09');
  chk('回傳 today', res.today, '2026-09-18');
  chk(
    '清單內容與排序：09-10(Amy,Dan)→09-12(Cara，⑧已停用仍列出)，02(Bob)已核定不列、08月的不列',
    res.items,
    [
      { date: '2026-09-10', emp_id: 'E01', name: 'Amy' },
      { date: '2026-09-10', emp_id: 'E05', name: 'Dan' },
      { date: '2026-09-12', emp_id: 'E03', name: 'Cara' },
    ],
  );
})();

console.log(`\n${fail ? '❌ 有失敗' : '✅ 本月待核定提醒全部正確'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
