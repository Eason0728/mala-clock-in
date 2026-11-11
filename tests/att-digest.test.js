/* 考勤異常候補提醒 Phase 2：att_digest_data（apps-script/AttDigest.gs，2026-11-07）
 * 唯讀、一輪讀 events／approved／requests／roster、punch_hours 與 mgr_day reference 同一套算法。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const R = f => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'att-alert-contract-v1.json'), 'utf8'));

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`);
};

const writes = { n: 0 };
function FakeSheet(headers, rows) { this.headers = headers.slice(); this.rows = (rows || []).map(r => r.slice()); }
FakeSheet.prototype.getDataRange = function () { const all = [this.headers].concat(this.rows); return { getValues: () => all.map(r => r.slice()) }; };
FakeSheet.prototype.getLastColumn = function () { return this.headers.length; };
['setValue', 'setValues', 'appendRow', 'insertSheet', 'deleteRow', 'clear', 'setNumberFormat'].forEach(k => {
  FakeSheet.prototype[k] = function () { writes.n++; };
});
FakeSheet.prototype.getRange = function () {
  const s = { setValue() { writes.n++; }, setValues() { writes.n++; }, setNumberFormat() { writes.n++; }, getValues: () => [] };
  return s;
};

const E = (d, hm, emp, type, status) => [`${d}T${hm}:00+08:00`, emp, type, status || 'ok'];
const REQ_H = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp'];
const reqRow = (o) => REQ_H.map(h => o[h] === undefined ? '' : o[h]);

function makeCtx(over) {
  over = over || {};
  const sheets = {
    managers: new FakeSheet(['name', 'key', 'active'], [['主管', 'mk', true]]),
    roster: new FakeSheet(['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'],
      [['E01', 'Amy', 'k1', '', '', true], ['E02', 'Bob', 'k2', '', '', true], ['E03', 'Cara', 'k3', '', '', false]]),
    events: new FakeSheet(['ts', 'emp_id', 'type', 'status'], over.events || [
      E('2026-10-30', '09:00', 'E01', 'in'), E('2026-10-30', '18:10', 'E01', 'out'),   // 跨月，未核定
      E('2026-11-02', '09:00', 'E01', 'in'), E('2026-11-02', '17:50', 'E01', 'out'),   // 已核定(兩筆)
      E('2026-11-03', '09:00', 'E02', 'in'), E('2026-11-03', '18:00', 'E02', 'out'),   // 已核定
      E('2026-11-04', '09:00', 'E02', 'in'),                                            // 忘刷下班：reference null、未核定
      E('2026-11-05', '09:00', 'E03', 'in'), E('2026-11-05', '13:00', 'E03', 'out'),   // 離職者，未核定
      E('2026-11-06', '09:00', 'E01', 'in'), E('2026-11-06', '18:00', 'E01', 'out'),   // 昨天，未核定
      E('2026-11-07', '09:00', 'E01', 'in'),                                            // 今天，不算未核定
      E('2026-09-01', '09:00', 'E02', 'in'), E('2026-09-01', '18:00', 'E02', 'out'),   // 更早（> 56 天前）
    ]),
    approved: new FakeSheet(['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore'], over.approved || [
      ['2026-11-02', 'E01', 'Amy', '09:00-17:00', 7, '正常', '主管', '2026-11-02T20:00:00+08:00'],
      ['2026-11-02', 'E01', 'Amy', '09:00-17:30', 8, '正常', '主管', '2026-11-06T10:00:00+08:00'],  // 重新核定，較新
      ['2026-11-03', 'E02', 'Bob', '09:00-18:00', 8, '正常', '主管', '2026-11-03T20:00:00+08:00'],
    ]),
    requests: new FakeSheet(REQ_H, over.requests || [
      reqRow({ id: 'R1', created_at: '2026-11-05T21:03:00+08:00', emp_id: 'E02', name: 'Bob', kind: 'leave', date: '2026-11-08', status: 'pending' }),
      reqRow({ id: 'R2', created_at: '2026-11-05T21:04:00+08:00', emp_id: 'E01', name: 'Amy', kind: 'miss', date: '2026-11-04', status: 'approved' }),
      reqRow({ id: 'R3', created_at: '2026-11-06T08:00:00+08:00', emp_id: 'E01', name: 'Amy', kind: 'ot', date: '2026-11-06', status: 'pending' }),
    ]),
  };
  if (over.leave) sheets.leave = new FakeSheet(['日期', '姓名', '假別', '時數'], over.leave);
  if (over.xmap) sheets.payroll_xmap = new FakeSheet(['emp_no', 'pay_store', 'acct_store', 'emp_id', 'not_support', 'synced_at', 'state', 'acct_only'], over.xmap);
  if (over.dropSheets) over.dropSheets.forEach(k => delete sheets[k]);
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet() { writes.n++; } };
  const sb = {
    console,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const t = new Date(d.getTime() + 8 * 3600000), p = n => ('0' + n).slice(-2);
        const ymd = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
        if (fmt === 'yyyy-MM') return ymd.slice(0, 7);
        if (fmt === 'yyyy-MM-dd') return ymd;
        return `${ymd}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
      },
    },
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: n => (over.props || {})[n] || null, setProperty() { writes.n++; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  };
  vm.createContext(sb);
  // 儲存格 {__d: ms} → 該 vm realm 的 Date 物件（模擬 Sheets 把日期／時間字串轉成 Date）
  Object.keys(sheets).forEach(k => sheets[k].rows.forEach(r => r.forEach((v, i) => {
    if (v && typeof v === 'object' && v.__d !== undefined) r[i] = vm.runInContext('new Date(' + v.__d + ')', sb);
  })));
  vm.runInContext(R('Code.gs'), sb);
  vm.runInContext(R('Requests.gs'), sb);
  if (!over.noPayroll) vm.runInContext(R('Payroll.gs'), sb);
  vm.runInContext(R('AttDigest.gs'), sb);
  vm.runInContext("todayTaipeiStr = function(){ return '2026-11-07'; };", sb);
  vm.runInContext("nowTaipeiIso = function(){ return '2026-11-07T08:50:12+08:00'; };", sb);
  vm.runInContext("currentYmTaipei = function(){ return '2026-11'; };", sb);
  return {
    digest: b => vm.runInContext('handleAttDigestData', sb)(b),
    mgrDay: b => vm.runInContext('handleMgrDay', sb)(b),
    sb,
  };
}

const base = { action: 'att_digest_data', mgr_key: 'mk', store: 'mztjs', from: '2026-11-01', to: '2026-11-06',
  since: '2026-11-05T00:00:00+08:00', until: '2026-11-07T08:50:00+08:00' };

console.log('══ att_digest_data ══');

// 1 認證
{ const c = makeCtx(); chk('mgr_key 錯→unauthorized', c.digest(Object.assign({}, base, { mgr_key: 'bad' })), { ok: false, error: 'unauthorized' }); }

// 2 35 天上限
{
  const c = makeCtx();
  const r35 = c.digest(Object.assign({}, base, { from: '2026-10-03', to: '2026-11-06' }));   // 剛好 35 天(含頭尾)
  const r36 = c.digest(Object.assign({}, base, { from: '2026-10-02', to: '2026-11-06' }));
  chk('35 天可過', r35.ok, true);
  chk('36 天回錯', [r36.ok, r36.error], [false, 'range_too_long']);
  chk('from>to 回錯', c.digest(Object.assign({}, base, { from: '2026-11-06', to: '2026-11-01' })).ok, false);
  chk('日期格式錯回錯', c.digest(Object.assign({}, base, { from: '11/01' })).error, 'bad_date');
}

// 3 days：punch_hours / approved 最新 / null
{
  const c = makeCtx(), r = c.digest(base);
  chk('ok／complete／store', [r.ok, r.complete, r.store], [true, true, 'mztjs']);
  const d = (date, emp) => r.days.filter(x => x.date === date && x.emp_id === emp)[0];
  chk('同日多筆核定取最新(8)', [d('2026-11-02', 'E01').approved_hours, d('2026-11-02', 'E01').approved_at], [8, '2026-11-06T10:00:00+08:00']);
  chk('punch_hours 同 mgr_day reference', d('2026-11-02', 'E01').punch_hours, c.mgrDay({ mgr_key: 'mk', date: '2026-11-02' }).employees.filter(e => e.emp_id === 'E01')[0].reference);
  chk('沒核定＝null', [d('2026-11-06', 'E01').approved_hours, d('2026-11-06', 'E01').approved_at], [null, null]);
  chk('忘刷下班 punch_hours null', d('2026-11-04', 'E02').punch_hours, null);
  chk('每列帶 store', r.days.every(x => x.store === 'mztjs'), true);
  chk('欄位集合', Object.keys(r.days[0]).sort(), ['approved_at', 'approved_hours', 'date', 'emp_id', 'home_hidden', 'leave_hours', 'name', 'punch_blocked', 'punch_hours', 'store']);
  chk('範圍外(今天 11/07)不在 days', r.days.some(x => x.date === '2026-11-07'), false);
  chk('離職者姓名仍帶出', d('2026-11-05', 'E03').name, 'Cara');
}

// 4 punch_hours === mgr_day reference，逐人逐天
{
  const c = makeCtx(), r = c.digest(Object.assign({}, base, { from: '2026-10-30', to: '2026-11-06' }));
  let same = true, cnt = 0;
  r.days.forEach(x => {
    const e = c.mgrDay({ mgr_key: 'mk', date: x.date }).employees.filter(y => y.emp_id === x.emp_id)[0];
    if (!e) return;   // mgr_day 只列 active＋當日有事件者；離職者當天有事件也會補列
    cnt++;
    if (e.reference !== x.punch_hours) { same = false; console.log('  差異', x.date, x.emp_id, e.reference, x.punch_hours); }
  });
  chk('punch_hours 與 mgr_day reference 全部相同', [same, cnt > 5], [true, true]);
}

// 5 dup_ignore：mgr_day 拿掉的重複卡，digest 也要拿掉
{
  const ev = [E('2026-11-03', '09:00', 'E02', 'in'), E('2026-11-03', '09:05', 'E02', 'in'), E('2026-11-03', '18:00', 'E02', 'out')];
  const ap = [['2026-11-03', 'E02', 'Bob', '09:00-18:00', 8, '正常', '主管', '2026-11-03T20:00:00+08:00', JSON.stringify(['2026-11-03T09:05:00+08:00'])]];
  const c = makeCtx({ events: ev, approved: ap });
  c.sb.__x = 0;
  const a = c.digest(base).days[0].punch_hours;
  const b = c.mgrDay({ mgr_key: 'mk', date: '2026-11-03' }).employees.filter(e => e.emp_id === 'E02')[0].reference;
  chk('有 approved 時 days 仍與 mgr_day 一致(含 dup_ignore 欄缺失情形)', a, b);
}

// 6 newly_approved (since, until]
{
  const c = makeCtx({ approved: [
    ['2026-10-01', 'E01', 'Amy', 'x', 5, '正常', '主管', '2026-11-05T00:00:00+08:00'],   // = since → 不含
    ['2026-10-02', 'E01', 'Amy', 'x', 6, '正常', '主管', '2026-11-05T00:00:01+08:00'],   // 含（工作日在範圍外也要）
    ['2026-11-01', 'E02', 'Bob', 'x', 7, '正常', '主管', '2026-11-07T08:50:00+08:00'],   // = until → 含
    ['2026-11-01', 'E02', 'Bob', 'x', 4, '正常', '主管', '2026-11-07T08:50:01+08:00'],   // 超過 until → 不含
  ] });
  const r = c.digest(base);
  chk('newly_approved 開閉區間＋不受工作日限制', r.newly_approved.map(x => x.date + ':' + x.approved_hours), ['2026-10-02:6', '2026-11-01:7']);
  chk('newly_approved 欄位', Object.keys(r.newly_approved[0]).sort(), ['approved_hours', 'date', 'emp_id', 'entered_at', 'home_hidden', 'leave_hours', 'manager_name', 'name', 'status_text', 'store']);
  chk('newly_approved 帶 store＋+08:00', [r.newly_approved[0].store, /\+08:00$/.test(r.newly_approved[0].entered_at)], ['mztjs', true]);
  // 主管手動填遲到（2026-11-08）：狀態欄與核定人原樣帶出
  const cl = makeCtx({ approved: [['2026-11-02', 'E01', 'Amy', 'x', 8, '早退5分、主管認定不計遲到', '李大同（DZY0001）', '2026-11-06T10:00:00+08:00']] });
  const nl = cl.digest(base).newly_approved[0];
  chk('newly_approved 帶 status_text、manager_name', [nl.status_text, nl.manager_name], ['早退5分、主管認定不計遲到', '李大同（DZY0001）']);
  // 同日重新核定：兩筆都在區間，兩筆都列（去重鍵含 entered_at）
  const c2 = makeCtx({ approved: [
    ['2026-11-02', 'E01', 'Amy', 'x', 7, '正常', '主管', '2026-11-05T10:00:00+08:00'],
    ['2026-11-02', 'E01', 'Amy', 'x', 8, '正常', '主管', '2026-11-06T10:00:00+08:00'],
  ] });
  chk('同日兩次核定都在區間→兩列', c2.digest(base).newly_approved.map(x => x.approved_hours), [7, 8]);
  // since_by_store 型輸入（契約 fixture）
  const c3 = makeCtx();
  const req = JSON.parse(JSON.stringify(fixture.att_digest_data_request)); req.mgr_key = 'mk'; req.from = '2026-11-01'; req.to = '2026-11-06';
  req.until = '2026-11-07T08:50:00+08:00'; req.since_by_store = { mztjs: '2026-11-05T00:00:00+08:00' };
  const r3 = c3.digest(req);
  chk('since_by_store 輸入：store 取唯一 key', [r3.ok, r3.store, r3.newly_approved.length], [true, 'mztjs', 1]);
  chk('缺 since → 回錯', c3.digest(Object.assign({}, base, { since: undefined })).error, 'bad_since');
}

// 7 unapproved 跨月 + older_count
{
  const c = makeCtx(), r = c.digest(Object.assign({}, base, { unapproved_from: '2026-10-01' }));
  chk('unapproved 跨月(10/30 在內)、不含今天、不含已核定', r.unapproved.map(x => x.date + ':' + x.emp_id),
    ['2026-10-30:E01', '2026-11-04:E02', '2026-11-05:E03', '2026-11-06:E01']);
  chk('unapproved 欄位', Object.keys(r.unapproved[0]).sort(), ['date', 'emp_id', 'home_hidden', 'name', 'store']);
  chk('older_count 只算 unapproved_from 之前(9/1 一天)', r.unapproved_older_count, 1);
  const r2 = c.digest(Object.assign({}, base, { unapproved_from: '2026-11-01' }));
  chk('縮小 unapproved_from→10/30 變成 older', [r2.unapproved.length, r2.unapproved_older_count], [3, 2]);
  const r3 = c.digest(Object.assign({}, base, { unapproved_from: '2025-01-01' }));
  chk('unapproved_from 最多 56 天前(9/12)→9/1 算 older', [r3.unapproved.some(x => x.date === '2026-09-01'), r3.unapproved_older_count], [false, 1]);
  const r4 = c.digest(base);
  chk('未給 unapproved_from＝56 天前', r4.unapproved_older_count, 1);
}

// 8 requests_pending
{
  const c = makeCtx(), r = c.digest(base);
  chk('requests_pending 只取 pending、欄位對齊', r.requests_pending, [
    { id: 'R1', emp_id: 'E02', name: 'Bob', kind: 'leave', created_at: '2026-11-05T21:03:00+08:00' },
    { id: 'R3', emp_id: 'E01', name: 'Amy', kind: 'ot', created_at: '2026-11-06T08:00:00+08:00' },
  ]);
}

// 9 時間 +08:00
{
  const c = makeCtx(), r = c.digest(base);
  chk('asOf 帶 +08:00', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/.test(r.asOf), true);
  chk('days.approved_at 帶 +08:00', r.days.filter(x => x.approved_at).every(x => /\+08:00$/.test(x.approved_at)), true);
  chk('created_at 帶 +08:00', r.requests_pending.every(x => /\+08:00$/.test(x.created_at)), true);
}

// 10 讀取失敗 → complete=false
{
  const c = makeCtx({ dropSheets: ['events'] }), r = c.digest(base);
  chk('events 分頁缺→ok 但 complete=false', [r.ok, r.complete], [true, false]);
  const c2 = makeCtx({ dropSheets: ['approved', 'requests'] }), r2 = c2.digest(base);
  chk('approved／requests 分頁不存在視為空、complete 仍 true', [r2.ok, r2.complete, r2.newly_approved.length, r2.requests_pending.length], [true, true, 0, 0]);
}

// 11 回應形狀對齊契約 fixture
{
  const c = makeCtx(), r = c.digest(base), f = fixture.att_digest_data_response;
  chk('頂層 key 對齊契約（xmap 為選用）', Object.keys(r).sort(), Object.keys(f).concat('complete').filter(k => k !== 'xmap').sort());
}

// 12 唯讀
{
  writes.n = 0;
  const c = makeCtx(); c.digest(base); c.digest(Object.assign({}, base, { mgr_key: 'bad' }));
  chk('不呼叫任何寫入 API', writes.n, 0);
}

// 13 不改既有動作：handlers 登記
{
  const src = R('Code.gs');
  chk('Code.gs handlers 登記 att_digest_data', /handlers.att_digest_data = handleAttDigestData/.test(src), true);
}

// 14 xmap（include_xmap）
{
  const XM = [
    ['0012', 'SSLGF', 'MZTJS', '007', '', '2026-11-01', 'confirmed', ''],
    ['0013', 'SSLGF', 'MZTJS', 8, '', '2026-11-01', 'confirmed', 'true'],     // acct_only → 不回
    ['0014', 'SSLGF', 'MZTJS', 'E09', '', '2026-11-01', 'pending', ''],        // 非 confirmed → 不回
    ['0015', 'SSLGF', 'MZTJS', ' E10 ', '', '2026-11-01', 'confirmed', false], // 去空白
  ];
  const c = makeCtx({ xmap: XM });
  const r = c.digest(Object.assign({}, base, { include_xmap: true }));
  chk('xmap 只回 confirmed 且非 acct_only，emp_id 前導零／空白正規化、不含姓名', r.xmap,
    [{ emp_no: '0012', acct_store: 'MZTJS', emp_id: '7' }, { emp_no: '0015', acct_store: 'MZTJS', emp_id: 'E10' }]);
  chk('有分頁但沒帶 include_xmap → 無 xmap 欄位', 'xmap' in c.digest(base), false);
  const c2 = makeCtx();
  const r2 = c2.digest(Object.assign({}, base, { include_xmap: true }));
  chk('沒分頁 → 無 xmap 欄位也無 xmap_error、ok', [r2.ok, 'xmap' in r2, 'xmap_error' in r2], [true, false, false]);
  chk('帶 include_xmap 且沒分頁：未建立分頁（寫入 0）', writes.n, 0);
  const c3 = makeCtx({ xmap: XM });
  c3.sb.payRead = () => { throw new Error('boom'); };
  const r3 = c3.digest(Object.assign({}, base, { include_xmap: true }));
  chk('讀 xmap 失敗：其他欄位照常、complete 仍 true、帶 xmap_error', [r3.ok, r3.complete, r3.days.length > 0, r3.xmap_error, 'xmap' in r3], [true, true, true, 'boom', false]);
}

// 15 P2-3 日期往返檢查
{
  const c = makeCtx();
  chk('2026-02-30 → bad_date', c.digest(Object.assign({}, base, { from: '2026-02-30', to: '2026-03-02' })).error, 'bad_date');
  chk('2026-13-01 → bad_date', c.digest(Object.assign({}, base, { to: '2026-13-01' })).error, 'bad_date');
  chk('閏日 2024-02-29 合法', c.digest(Object.assign({}, base, { from: '2024-02-29', to: '2024-03-01' })).ok, true);
}

// 16 P2-4 entered_at 空白 → approved_at null
{
  const c = makeCtx({ approved: [['2026-11-02', 'E01', 'Amy', 'x', 7, '正常', '主管', '', '']] });
  const r = c.digest(base), d = r.days.filter(x => x.date === '2026-11-02' && x.emp_id === 'E01')[0];
  chk('entered_at 空白 → approved_at null（approved_hours 照回）', [d.approved_at, d.approved_hours], [null, 7]);
  chk('entered_at 空白不進 newly_approved', r.newly_approved.length, 0);
}

// 17 P2-5 punch_blocked
{
  const c = makeCtx({ events: [
    E('2026-11-03', '09:00', 'E02', 'in', 'rejected_out_of_range'), E('2026-11-03', '18:00', 'E02', 'out', 'rejected_out_of_range'),
    E('2026-11-04', '09:00', 'E01', 'in'), E('2026-11-04', '18:00', 'E01', 'out'),
  ], approved: [] });
  const r = c.digest(base), d = (dt, e) => r.days.filter(x => x.date === dt && x.emp_id === e)[0];
  chk('全部打卡被擋：punch_hours 0＋punch_blocked true（與 mgr_day 一致）', [d('2026-11-03', 'E02').punch_hours, d('2026-11-03', 'E02').punch_blocked],
    [c.mgrDay({ mgr_key: 'mk', date: '2026-11-03' }).employees.filter(e => e.emp_id === 'E02')[0].reference, true]);
  chk('正常日 punch_blocked false', [d('2026-11-04', 'E01').punch_hours, d('2026-11-04', 'E01').punch_blocked], [9, false]);
}

// 18 P2-2 home_hidden
{
  const c = makeCtx({ props: { REQ_HOME_EMPS: JSON.stringify(['E03', 'E01']) } });
  const r = c.digest(Object.assign({}, base, { unapproved_from: '2026-10-01' }));
  chk('days 仍列所有人，home_hidden 標在 E01／E03', r.days.map(x => x.emp_id + ':' + x.home_hidden).filter((v, i, a) => a.indexOf(v) === i).sort(),
    ['E01:true', 'E02:false', 'E03:true']);
  chk('unapproved 同樣帶 home_hidden', r.unapproved.map(x => x.emp_id + ':' + x.home_hidden).filter((v, i, a) => a.indexOf(v) === i).sort(), ['E01:true', 'E02:false', 'E03:true']);
  const md = c.mgrDay({ mgr_key: 'mk', date: '2026-11-06' });
  const viaLiff = vm.runInContext('reqMgrDayHome_', c.sb)({ mgr_key: 'mk', date: '2026-11-06' });
  chk('與 mgr_day（Liff 覆寫）看不到的人一致', [md.employees.some(e => e.emp_id === 'E01'), viaLiff.employees.some(e => e.emp_id === 'E01')], [true, false]);
  const c0 = makeCtx();
  chk('沒設 REQ_HOME_EMPS → 全 false', c0.digest(base).days.every(x => x.home_hidden === false), true);
}

// 19 P2-7 沒有 Payroll.gs 但帶 include_xmap
{
  const c = makeCtx({ noPayroll: true, xmap: [['0012', 'SSLGF', 'MZTJS', '007', '', '', 'confirmed', '']] });
  let r, threw = false;
  try { r = c.digest(Object.assign({}, base, { include_xmap: true })); } catch (e) { threw = true; }
  chk('沒 Payroll.gs＋include_xmap：不 throw、ok、無 xmap、無 xmap_error', [threw, r && r.ok, r && 'xmap' in r, r && 'xmap_error' in r], [false, true, false, false]);
}

// 20 P2-7 approved 的 entered_at／date 是 Date 物件
{
  const T = s => Date.parse(s);
  const c = makeCtx({ approved: [
    ['2026-11-01', 'E01', 'Amy', 'x', 5, '正常', '主管', { __d: T('2026-11-05T00:00:00+08:00') }, ''],   // = since → 不含
    [{ __d: T('2026-10-02T00:00:00+08:00') }, 'E01', 'Amy', 'x', 6, '正常', '主管', { __d: T('2026-11-05T00:00:01+08:00') }, ''],   // 含；date 也是 Date
  ] });
  const r = c.digest(base);
  chk('Date 物件 entered_at：00:00:00 不含、00:00:01 含；date 正規化回字串，entered_at 帶 +08:00',
    r.newly_approved.map(x => [x.date, x.approved_hours, x.entered_at]), [['2026-10-02', 6, '2026-11-05T00:00:01+08:00']]);
  const d = r.days.filter(x => x.date === '2026-11-01' && x.emp_id === 'E01')[0];
  chk('Date 物件 entered_at → days.approved_at 為字串', d && d.approved_at, '2026-11-05T00:00:00+08:00');
}

// 21 P2-7 殘：events.ts／requests.created_at 是 Date 物件
{
  const T = x => ({ __d: Date.parse(x) });
  const evD = (d, hm, emp, type) => [T(`${d}T${hm}:00+08:00`), emp, type, 'ok'];
  const cs = makeCtx({ approved: [], events: [evD('2026-11-04', '09:00', 'E01', 'in'), evD('2026-11-04', '18:00', 'E01', 'out')],
    requests: [reqRow({ id: 'R9', created_at: T('2026-11-05T21:03:00+08:00'), emp_id: 'E01', name: 'Amy', kind: 'leave', status: 'pending' })] });
  const r = cs.digest(Object.assign({}, base, { unapproved_from: '2026-11-01' }));
  chk('events.ts 為 Date：punch_hours 9、未核定列出', [r.days[0].punch_hours, r.unapproved.map(x => x.date)], [9, ['2026-11-04']]);
  chk('requests.created_at 為 Date：回字串帶 +08:00', r.requests_pending.map(x => x.created_at), ['2026-11-05T21:03:00+08:00']);
}

// 22 P2-9 跨夜班：只有下班落在隔天的那天不出列，總時數與 mgr_day 一致
{
  const c = makeCtx({ approved: [], events: [E('2026-11-03', '22:00', 'E01', 'in'), E('2026-11-04', '06:00', 'E01', 'out')] });
  const r = c.digest(base);
  chk('跨夜班：只列 in 日 11/03，11/04 不出列', r.days.map(x => x.date), ['2026-11-03']);
  const sum = ['2026-11-03', '2026-11-04'].reduce((t, d) => t + (c.mgrDay({ mgr_key: 'mk', date: d }).employees.filter(e => e.emp_id === 'E01')[0].reference || 0), 0);
  chk('days 總時數＝mgr_day reference 總和', r.days.reduce((t, x) => t + x.punch_hours, 0), sum);
  const c2 = makeCtx({ approved: [['2026-11-04', 'E01', 'Amy', 'x', 1, '正常', '主管', '2026-11-05T08:00:00+08:00', '']], events: [E('2026-11-03', '22:00', 'E01', 'in'), E('2026-11-04', '06:00', 'E01', 'out')] });
  chk('隔天若有核定就出列', c2.digest(base).days.map(x => x.date), ['2026-11-03', '2026-11-04']);
}

// 23 P2-10 REQ_HOME_EMPS 壞掉：不全員隱藏
{
  const c = makeCtx({ props: { REQ_HOME_EMPS: '{bad' } });
  const r = c.digest(base);
  chk('名單格式錯：全員 home_hidden=false＋home_list_error', [r.days.length > 0 && r.days.every(x => x.home_hidden === false), typeof r.home_list_error, r.ok], [true, 'string', true]);
  chk('名單正常：無 home_list_error', 'home_list_error' in makeCtx().digest(base), false);
}

// 24 P2-11 unapproved_from 格式錯／entered_at 只有空白
{
  const c = makeCtx();
  chk('unapproved_from 格式錯 → bad_date', c.digest(Object.assign({}, base, { unapproved_from: '2026/10/01' })).error, 'bad_date');
  chk('unapproved_from 2026-02-30 → bad_date', c.digest(Object.assign({}, base, { unapproved_from: '2026-02-30' })).error, 'bad_date');
  const c2 = makeCtx({ approved: [['2026-11-02', 'E01', 'Amy', 'x', 7, '正常', '主管', '  \t ', '']] });
  const d = c2.digest(base).days.filter(x => x.date === '2026-11-02' && x.emp_id === 'E01')[0];
  chk('entered_at 只有空白 → approved_at null', d.approved_at, null);
}

// 25 P2-12 前晚跨夜 out(ok)＋當天 in 全被擋 → 當天出列且 punch_blocked
{
  const c = makeCtx({ approved: [], events: [
    E('2026-11-02', '22:00', 'E01', 'in'), E('2026-11-03', '06:00', 'E01', 'out'),
    E('2026-11-03', '09:00', 'E01', 'in', 'rejected_gps'),
  ] });
  const r = c.digest(base), d = r.days.filter(x => x.date === '2026-11-03')[0];
  chk('前晚跨夜 out ok＋當天 in 全 rejected → 11/03 出列且 punch_blocked true', [!!d, d && d.punch_blocked], [true, true]);
  const sum = ['2026-11-02', '2026-11-03'].reduce((t, dt) => t + (c.mgrDay({ mgr_key: 'mk', date: dt }).employees.filter(e => e.emp_id === 'E01')[0].reference || 0), 0);
  chk('days 總時數仍＝mgr_day reference 總和', r.days.reduce((t, x) => t + (x.punch_hours || 0), 0), sum);
}

// 26 leave_hours：已核准請假時數（leave 分頁，同 mgr_day leaves）
{
  const L = [
    ['2026-11-02', 'Amy', '特休假', 4],
    ['2026-11-03', 'Bob', '事假', 2], ['2026-11-03', 'Bob', '病假', 1.5],   // 同日兩張相加
    ['2026-11-03', 'Bob', '出差', 8],                                         // 出差不算
    ['2026-11-04', 'Bob', '特休假', ''],                                      // 時數空白＝0
    ['2026-11-05', 'Cara ', '補休', 3],                                       // 姓名尾端空白
    ['2026-11-06', 'Amy', '特休假', 8], ['2026-11-07', 'Amy', '特休假', 8],   // 11/06 在範圍；11/07 另一天
  ];
  const c = makeCtx({ leave: L });
  writes.n = 0;
  const r = c.digest(Object.assign({}, base, { since: '2026-11-01T00:00:00+08:00' }));
  const d = (date, emp) => r.days.filter(x => x.date === date && x.emp_id === emp)[0];
  chk('特休 4 小時 → leave_hours 4', d('2026-11-02', 'E01').leave_hours, 4);
  chk('同日兩張假相加、出差不算 → 3.5', d('2026-11-03', 'E02').leave_hours, 3.5);
  chk('時數空白 → 0', d('2026-11-04', 'E02').leave_hours, 0);
  chk('姓名尾端空白仍對得上', d('2026-11-05', 'E03').leave_hours, 3);
  chk('沒有假 → 0（不是 null）', [d('2026-11-06', 'E01').leave_hours, typeof d('2026-11-06', 'E01').leave_hours], [8, 'number']);
  chk('newly_approved 也帶 leave_hours（依該列日期＋人）', r.newly_approved.map(x => x.date + ':' + x.leave_hours), ['2026-11-02:4', '2026-11-03:3.5', '2026-11-02:4']);
  chk('寫入 API 呼叫 0 次', writes.n, 0);
  // 與 mgr_day 回傳的 leaves 對同一份假資料一致（排除出差後相加）
  let same = true;
  r.days.forEach(x => {
    const e = c.mgrDay({ mgr_key: 'mk', date: x.date }).employees.filter(y => y.emp_id === x.emp_id)[0];
    if (!e) return;
    const sum = e.leaves.reduce((t, l) => t + (l.type === '出差' ? 0 : (Number(l.hours) || 0)), 0);
    if (sum !== x.leave_hours) { same = false; console.log('  差異', x.date, x.emp_id, sum, x.leave_hours); }
  });
  chk('leave_hours 與 mgr_day leaves 逐人逐天一致', same, true);
  // 待審／退回的假、加班單：只在 requests 分頁、沒進 leave 分頁 → 不算
  const cr = makeCtx({ leave: [], requests: [
    reqRow({ id: 'R1', created_at: '2026-11-01T09:00:00+08:00', emp_id: 'E01', name: 'Amy', kind: 'leave', date: '2026-11-02', leave_type: '特休假', hours: 4, status: 'pending' }),
    reqRow({ id: 'R2', created_at: '2026-11-01T09:00:00+08:00', emp_id: 'E01', name: 'Amy', kind: 'leave', date: '2026-11-02', leave_type: '事假', hours: 4, status: 'rejected' }),
    reqRow({ id: 'R3', created_at: '2026-11-01T09:00:00+08:00', emp_id: 'E01', name: 'Amy', kind: 'ot', date: '2026-11-02', hours: 2, status: 'approved' }),
  ] });
  const rr = cr.digest(base);
  chk('待審／退回的假、加班單不算 → 0', rr.days.filter(x => x.date === '2026-11-02').map(x => x.leave_hours), [0]);
  // 沒有 leave 分頁 → 全 0、complete 仍 true
  const cn = makeCtx();
  const rn = cn.digest(base);
  chk('沒有 leave 分頁 → 全 0、complete true', [rn.days.every(x => x.leave_hours === 0), rn.complete], [true, true]);
  // 跨日請假：leave 分頁一天一列（核定時逐日寫入），同 mgr_day 依日期各算各的
  const c2 = makeCtx({ leave: [['2026-11-02', 'Amy', '事假', 8], ['2026-11-03', 'Amy', '事假', 8]] });
  const r2 = c2.digest(base);
  chk('跨日請假各日各自的時數', r2.days.filter(x => x.emp_id === 'E01' && ['2026-11-02', '2026-11-03'].includes(x.date)).map(x => x.date + ':' + x.leave_hours), ['2026-11-02:8']);
  // 讀 leave 失敗 → complete false
  const c3 = makeCtx({ leave: [] });
  c3.sb.leaveByDateName_ = () => { throw new Error('boom'); };
  chk('讀 leave 失敗 → complete false', c3.digest(base).complete, false);
}


console.log(`\n${fail ? '❌' : '✅'} pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
