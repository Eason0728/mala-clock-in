/* 總部打卡鏡像（Mirror.gs，2026-10-09）
 *
 * 從真檔載入 Code.gs＋Mirror.gs（＋第 B 節的 Payroll.gs）進 vm，試算表用假的記憶體版本。
 * 一～七節測鏡像本身；八節是最重要的驗收：改線前後（總部讀央廚表 vs 總部讀自己的表＋鏡像列）
 * 用 Payroll.gs 的真函式 payCollect／payAttendanceBuild 算出來的 HQ-01 工時、請假、出勤天數必須完全相同。
 * 假資料全部虛構（測試甲～戊），不含任何真實姓名／ID。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = f => fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8');
const CODE = R('Code.gs'), MIRROR = R('Mirror.gs'), PAYROLL = R('Payroll.gs');

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want)}`);
};

/* ───────── 假試算表 ───────── */
function makeWorld() {
  const sb = { console, Logger: { log() {} } };
  vm.createContext(sb);
  const VmDate = vm.runInContext('Date', sb);
  const stats = { writes: 0, created: [] };

  function FakeSheet(name, headers, rows) {
    this.name = name; this.headers = headers.slice(); this.rows = rows.map(r => r.slice()); this.fmt = {};
  }
  const P = FakeSheet.prototype;
  P.getDataRange = function () { const all = [this.headers].concat(this.rows); return { getValues: () => all.map(r => r.slice()) }; };
  P.getLastRow = function () { return this.rows.length + 1; };
  P.getLastColumn = function () { return this.headers.length; };
  P.deleteRows = function (start, cnt) { stats.writes++; this.rows.splice(start - 2, cnt); };
  P.getRange = function (r, c, nr, nc) {
    const self = this; nr = nr || 1; nc = nc || 1;
    const api = {
      setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.fmt[(r + i) + ',' + (c + j)] = f; return api; },
      setValue(v) { stats.writes++; api._put([[v]]); return api; },
      setValues(vv) { stats.writes++; api._put(vv); return api; },
      _put(vv) {
        for (let i = 0; i < vv.length; i++) for (let j = 0; j < vv[i].length; j++) {
          let v = vv[i][j];
          const R0 = r + i, C0 = c + j;
          // Sheets 行為：沒鎖成純文字的儲存格，'yyyy-MM-dd' 字串會被自動轉成日期物件
          if (R0 > 1 && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && self.fmt[R0 + ',' + C0] !== '@') {
            v = new VmDate(v + 'T00:00:00+08:00');
          }
          if (R0 === 1) { while (self.headers.length < C0) self.headers.push(''); self.headers[C0 - 1] = v; }
          else {
            while (self.rows.length < R0 - 1) self.rows.push([]);
            const row = self.rows[R0 - 2];
            while (row.length < self.headers.length) row.push('');
            while (row.length < C0) row.push('');
            row[C0 - 1] = v;
          }
        }
      },
    };
    return api;
  };
  function FakeSS(id) { this.id = id; this.sheets = {}; }
  FakeSS.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
  FakeSS.prototype.insertSheet = function (n) { stats.created.push(n); return (this.sheets[n] = new FakeSheet(n, [], [])); };
  FakeSS.prototype.add = function (name, headers, rows) { this.sheets[name] = new FakeSheet(name, headers, rows || []); return this.sheets[name]; };

  const book = {};
  const mkSS = id => (book[id] = new FakeSS(id));
  let triggers = [];
  const pad = n => ('0' + n).slice(-2);
  sb.Utilities = { formatDate(d, tz, fmt) {
    const t = new Date(d.getTime() + 8 * 3600e3);
    const ymd = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
    if (fmt === 'yyyy-MM-dd') return ymd;
    if (fmt === 'yyyy-MM') return ymd.slice(0, 7);
    return ymd + 'T' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':' + pad(t.getUTCSeconds()) + '+08:00';
  } };
  sb.SpreadsheetApp = { openById: id => { if (!book[id]) throw new Error('no such sheet ' + id); return book[id]; } };
  const props = {};
  sb.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) };
  let lockBusy = false;
  sb.LockService = { getScriptLock: () => ({ tryLock: () => !lockBusy, releaseLock() {} }) };
  sb.ScriptApp = {
    getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn, __t: t })),
    deleteTrigger: h => { triggers = triggers.filter(t => t !== h.__t); },
    newTrigger: fn => { const spec = { fn }; const api = {
      timeBased: () => api, everyMinutes: n => { spec.every = n + 'min'; return api; }, everyDays: n => { spec.every = n + 'day'; return api; }, atHour: h => { spec.hour = h; return api; },
      create: () => { triggers.push(spec); } }; return api; },
  };
  vm.runInContext(CODE, sb);
  vm.runInContext(MIRROR, sb);
  vm.runInContext("spreadsheetId = function () { return 'HQ_SS'; }; checkAdmin = function (b) { return b.admin_key === 'RIGHT'; };", sb);
  const world = { sb, VmDate, book, stats, mkSS, props,
    triggers: () => triggers, setBusy: b => { lockBusy = b; },
    cfg(sources) { vm.runInContext('MIRROR_SOURCES = ' + JSON.stringify(sources) + ';', sb); },
    call: (fn, ...a) => vm.runInContext(fn, sb)(...a),
  };
  return world;
}

/* ───────── 假資料 ───────── */
const EV_H = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const AP_H = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'];
const LV_H = ['日期', '姓名', '假別', '時數'];
const RO_H = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out'];
const ev = (ts, emp, type, status) => [ts, emp, type, 24.1, 120.7, 10, true, 'dev-' + emp, true, status || 'ok', 8];
const T = (d, hm) => `2026-09-${d}T${hm}:00+08:00`;

function buildSource(w) {
  const cf = w.mkSS('CF_SS');
  cf.add('roster', RO_H, [
    ['CF01', '測試一', 'k1', '', '', true, '', ''],
    ['CF02', '測試二', 'k2', '', '', true, '', ''],
    ['HQ-01', '測試甲', 'k3', '', '', true, '', ''],
  ]);
  cf.add('events', EV_H, [
    ev(T('01', '08:02'), 'CF01', 'in'), ev(T('01', '17:01'), 'CF01', 'out'),
    ev(T('01', '08:31'), 'HQ-01', 'in'), ev(T('01', '17:36'), 'HQ-01', 'out'),
    ev(T('02', '08:29'), 'HQ-01', 'in'), ev(T('02', '17:31'), 'HQ-01', 'out'),
    ev(T('02', '08:00'), 'CF02', 'in'), ev(T('02', '17:00'), 'CF02', 'out'),
    ev(T('03', '08:35'), 'HQ-01', 'in'),                                     // 忘打下班
    ev(T('04', '08:30'), 'HQ-01', 'in'), ev(T('04', '08:31'), 'HQ-01', 'in', 'rejected_duplicate'),
    ev(T('04', '12:30'), 'HQ-01', 'out'), ev(T('04', '13:30'), 'HQ-01', 'in'), ev(T('04', '17:30'), 'HQ-01', 'out'),
    ev(T('07', '08:40'), 'HQ-01', 'in', 'pending_device_approval'),
  ]);
  cf.add('approved', AP_H, [
    ['2026-09-01', 'CF01', '測試一', '08:00-17:00', 9, '正常', 'm', T('02', '09:00')],
    ['2026-09-01', 'HQ-01', '測試甲', '08:30-17:30', 9, '遲到1分', 'm', T('02', '09:00')],
    ['2026-09-01', 'HQ-01', '測試甲', '08:30-17:30', 8.5, '正常', 'm', T('03', '09:00')],   // 較新：覆蓋上一筆
    ['2026-09-02', 'HQ-01', '測試甲', '08:30-17:30', 9, '正常', 'm', T('03', '09:00')],
    ['2026-09-03', 'HQ-01', '測試甲', '08:30-17:30', 9, '該段無打卡', 'm', T('04', '09:00')],
    ['2026-09-04', 'HQ-01', '測試甲', '08:30-12:30,13:30-17:30', 8, '正常', 'm', T('05', '09:00')],
  ]);
  cf.add('leave', LV_H, [
    ['2026-09-15', '測試甲', '病假', 4],
    ['2026-09-16', '測試甲', '特休假', 8],
    ['2026-09-15', '測試一', '事假', 2],
  ]);
  return cf;
}

function buildTarget(w, opts) {
  opts = opts || {};
  const hq = w.mkSS('HQ_SS');
  hq.add('roster', RO_H, [
    ['HQ-01', '測試甲', 'kk1', '', '', false, '', ''],   // 總部名冊裡 HQ-01 停用
    ['HQ-02', '測試乙', 'kk2', '', '', true, '', ''],
    ['HQ-03', '測試丙', 'kk3', '', '', true, '', ''],
    ['HQ-04', '測試丁', 'kk4', '', '', true, '', ''],
    ['HQ-05', '測試戊', 'kk5', '', '', true, '', ''],
  ]);
  const own = [
    ev(T('01', '09:00'), 'HQ-02', 'in'), ev(T('01', '18:00'), 'HQ-02', 'out'),
    ev(T('02', '09:00'), 'HQ-03', 'in'), ev(T('02', '17:00'), 'HQ-03', 'out'),
    ev(T('02', '09:05'), 'HQ-04', 'in'), ev(T('02', '17:05'), 'HQ-04', 'out'),
    ev(T('03', '09:10'), 'HQ-05', 'in'), ev(T('03', '17:10'), 'HQ-05', 'out'),
  ];
  const hasCol = opts.withMirrorCol !== false;
  const addCol = (h, rows) => hasCol ? [h.concat(['mirror_src']), rows.map(r => r.concat(['']))] : [h, rows];
  let [h, r] = addCol(EV_H, own); hq.add('events', h, r);
  [h, r] = addCol(AP_H, [
    ['2026-09-01', 'HQ-02', '測試乙', '09:00-18:00', 9, '正常', 'm2', T('02', '09:00')],
    ['2026-09-02', 'HQ-03', '測試丙', '09:00-17:00', 8, '正常', 'm2', T('03', '09:00')],
    ['2026-09-02', 'HQ-04', '測試丁', '09:00-17:00', 8, '正常', 'm2', T('03', '09:00')],
    ['2026-09-03', 'HQ-05', '測試戊', '09:00-17:00', 8, '正常', 'm2', T('04', '09:00')],
  ]); hq.add('approved', h, r);
  [h, r] = addCol(LV_H, [['2026-09-20', '測試乙', '事假', 2]]); hq.add('leave', h, r);
  return hq;
}
const snap = ss => JSON.stringify(Object.keys(ss.sheets).sort().map(k => [k, ss.sheets[k].headers, ss.sheets[k].rows]));
const ownRows = (sh, mi) => sh.rows.filter(r => !String(r[mi] == null ? '' : r[mi]).trim());
const CFG = [{ code: 'CF', ss_id: 'CF_SS', emp_prefix: 'HQ-' }];
function fresh(opts) { const w = makeWorld(); buildSource(w); const hq = buildTarget(w, opts); w.cfg(CFG); return { w, hq }; }
const idx = (sh, h) => sh.headers.indexOf(h);
const cnt = (sh, mi, code) => sh.rows.filter(r => r[mi] === code).length;

/* ═════ 一、只抄前綴的人 ═════ */
console.log('══ 一、只抄 HQ- 前綴的人 ══');
{
  const { w, hq } = fresh();
  const r = w.call('mirrorCore_', true);
  chk('執行成功', r.ok, true);
  chk('events 抄 11 筆（HQ-01 全部，含被擋與 pending）', r.sources[0].tables.events, { removed: 0, added: 11 });
  chk('approved 抄 5 筆（含被覆蓋的舊版本，完整複製）', r.sources[0].tables.approved, { removed: 0, added: 5 });
  chk('leave 抄 2 筆（只有測試甲，不含測試一）', r.sources[0].tables.leave, { removed: 0, added: 2 });
  const ev2 = hq.sheets.events, mi = idx(ev2, 'mirror_src');
  chk('鏡像列的 emp_id 全是 HQ-01', [...new Set(ev2.rows.filter(x => x[mi] === 'CF').map(x => x[1]))], ['HQ-01']);
  chk('沒有 CF01／CF02 的列混進來', ev2.rows.some(x => /^CF/.test(x[1])), false);
  chk('leave 沒有測試一', hq.sheets.leave.rows.some(x => x[1] === '測試一'), false);
}

/* ═════ 二、本店自己的列不動 ═════ */
console.log('\n══ 二、總部自己的列（mirror_src 空白）一列都不動 ══');
{
  const { w, hq } = fresh();
  const before = {}; ['events', 'approved', 'leave'].forEach(n => { before[n] = JSON.stringify(hq.sheets[n].rows.map(r => r.slice())); });
  w.call('mirrorCore_', true);
  w.call('mirrorCore_', true);   // 跑兩次，刪除路徑也走過
  ['events', 'approved', 'leave'].forEach(n => {
    const sh = hq.sheets[n], mi = idx(sh, 'mirror_src');
    chk(n + ' 自己的列與順序完全不變', JSON.stringify(ownRows(sh, mi).map(r => r.slice(0, mi))), JSON.stringify(JSON.parse(before[n]).map(r => r.slice(0, mi))));
    chk(n + ' 自己的列的 mirror_src 仍是空白', ownRows(sh, mi).every(r => !r[mi]), true);
  });
}

/* ═════ 三、冪等 ═════ */
console.log('\n══ 三、重跑冪等 ══');
{
  const { w, hq } = fresh();
  const r1 = w.call('mirrorCore_', true);
  const s1 = snap(hq);
  const r2 = w.call('mirrorCore_', true);
  chk('第二次 removed＝第一次 added（events）', r2.sources[0].tables.events.removed, r1.sources[0].tables.events.added);
  chk('第二次 removed＝added（approved）', [r2.sources[0].tables.approved.removed, r2.sources[0].tables.approved.added], [r1.sources[0].tables.approved.added, r1.sources[0].tables.approved.added]);
  chk('第二次 removed＝added（leave）', [r2.sources[0].tables.leave.removed, r2.sources[0].tables.leave.added], [2, 2]);
  chk('兩次之後試算表內容逐格相同', snap(hq), s1);
  const r3 = w.call('mirrorCore_', true);
  chk('第三次還是穩定', [snap(hq) === s1, r3.sources[0].tables.events.removed], [true, 11]);
}

/* ═════ 四、來源變動跟著變 ═════ */
console.log('\n══ 四、來源刪列／改狀態／請假 upsert，目標跟著變 ══');
{
  const { w, hq } = fresh();
  w.call('mirrorCore_', true);
  const cf = w.book.CF_SS;
  // 裝置核准 pending→ok
  cf.sheets.events.rows.find(r => r[9] === 'pending_device_approval')[9] = 'ok';
  // 手動刪一筆
  const di = cf.sheets.events.rows.findIndex(r => r[1] === 'HQ-01' && r[0] === T('04', '08:31'));
  cf.sheets.events.rows.splice(di, 1);
  // 請假改時數、刪一筆
  cf.sheets.leave.rows.find(r => r[2] === '病假')[3] = 8;
  cf.sheets.leave.rows = cf.sheets.leave.rows.filter(r => r[2] !== '特休假');
  // 核定重送（新增一筆較新的）
  cf.sheets.approved.rows.push(['2026-09-02', 'HQ-01', '測試甲', '08:30-17:30', 8, '正常', 'm', T('06', '09:00')]);
  const r = w.call('mirrorCore_', true);
  chk('events 筆數 11→10', [r.sources[0].tables.events.removed, r.sources[0].tables.events.added], [11, 10]);
  const evs = hq.sheets.events, mi = idx(evs, 'mirror_src');
  chk('pending 已變 ok', evs.rows.filter(x => x[mi] === 'CF').some(x => x[9] === 'pending_device_approval'), false);
  chk('被刪的那筆不在了', evs.rows.some(x => x[1] === 'HQ-01' && x[0] === T('04', '08:31')), false);
  chk('請假：病假 8 小時、特休已消失', hq.sheets.leave.rows.filter(x => x[idx(hq.sheets.leave, 'mirror_src')] === 'CF').map(x => [x[2], x[3]]), [['病假', 8]]);
  chk('approved 多了重送那筆', r.sources[0].tables.approved.added, 6);
}

/* ═════ 五、表頭自癒 ═════ */
console.log('\n══ 五、目標表沒有 mirror_src 欄時自動補在最右邊 ══');
{
  const { w, hq } = fresh({ withMirrorCol: false });
  chk('起始沒有 mirror_src', hq.sheets.events.headers.includes('mirror_src'), false);
  const r = w.call('mirrorCore_', true);
  chk('回報補了三張表', r.header_added, ['events', 'approved', 'leave']);
  ['events', 'approved', 'leave'].forEach(n => {
    const sh = hq.sheets[n];
    chk(n + ' mirror_src 補在最右邊', sh.headers[sh.headers.length - 1], 'mirror_src');
    chk(n + ' 自己的舊列 mirror_src 欄為空白', ownRows(sh, idx(sh, 'mirror_src')).length > 0 && ownRows(sh, idx(sh, 'mirror_src')).every(x => !x[idx(sh, 'mirror_src')]), true);
  });
  const r2 = w.call('mirrorCore_', true);
  chk('第二次不再補表頭、removed 等於上次 added', [r2.header_added, r2.sources[0].tables.events.removed], [[], 11]);
}
{
  // 表頭實際順序和常數不同：mirror_src 不在最後也要認得
  const { w, hq } = fresh();
  const sh = hq.sheets.events;                       // 把 mirror_src 搬到第 3 欄的位置，模擬人工調整
  const mi = sh.headers.indexOf('mirror_src');
  sh.headers.splice(2, 0, sh.headers.splice(mi, 1)[0]); sh.rows.forEach(r => r.splice(2, 0, r.splice(mi, 1)[0]));
  w.call('mirrorCore_', true);
  const m2 = sh.headers.indexOf('mirror_src');
  chk('依實際表頭定位 mirror_src 欄（不是常數位置）', [m2, cnt(sh, m2, 'CF'), sh.headers.length], [2, 11, 12]);
  chk('欄位依目標表頭排：emp_id 仍在 emp_id 欄', sh.rows.filter(r => r[m2] === 'CF').every(r => r[sh.headers.indexOf('emp_id')] === 'HQ-01'), true);
}
{
  // 目標沒有 leave 分頁：apply 才建，且 dry-run 不建
  const w = makeWorld(); buildSource(w); const hq = buildTarget(w); delete hq.sheets.leave; w.cfg(CFG);
  const d = w.call('mirrorCore_', false);
  chk('乾跑：回報會建 leave 但沒有真的建', [d.sheets_created, !!hq.sheets.leave, w.stats.created], [['leave'], false, []]);
  w.call('mirrorCore_', true);
  chk('apply 建出 leave 並帶表頭＋2 筆', [hq.sheets.leave.headers, hq.sheets.leave.rows.length], [['日期', '姓名', '假別', '時數', 'mirror_src'], 2]);
}

/* ═════ 六、乾跑零寫入 ═════ */
console.log('\n══ 六、mirror_run apply:false 零副作用 ══');
{
  const { w, hq } = fresh({ withMirrorCol: false });
  const before = snap(hq), srcBefore = snap(w.book.CF_SS);
  const d = w.call('handleMirrorRun', { admin_key: 'RIGHT', apply: false });
  chk('乾跑成功並回預計筆數', [d.ok, d.apply, d.sources[0].tables.events.added, d.sources[0].tables.leave.added], [true, false, 11, 2]);
  chk('寫入次數 0', w.stats.writes, 0);
  chk('目標逐格未變（連 mirror_src 表頭都沒補）', snap(hq), before);
  chk('來源逐格未變', snap(w.book.CF_SS), srcBefore);
  chk('Script Properties 沒被寫', w.props.mirror_last_ok, undefined);
  const d2 = w.call('handleMirrorRun', { admin_key: 'RIGHT' });
  chk('沒帶 apply 一律當乾跑', [d2.apply, w.stats.writes], [false, 0]);
  const d3 = w.call('handleMirrorRun', { admin_key: 'WRONG', apply: true });
  chk('金鑰錯→unauthorized 且零寫入', [d3.error, w.stats.writes], ['unauthorized', 0]);
  const a = w.call('handleMirrorRun', { admin_key: 'RIGHT', apply: true });
  chk('apply:true 才寫', [a.apply, w.stats.writes > 0, w.props.mirror_last_ok ? 'set' : 'unset'], [true, true, 'set']);
}

/* ═════ 七、Date 物件、失敗不寫、鎖、設定檢查、觸發器 ═════ */
console.log('\n══ 七、Date 物件／失敗不寫／鎖／設定／觸發器 ══');
{
  const { w, hq } = fresh();
  const cf = w.book.CF_SS;
  // 來源的日期欄是 Date 物件（Sheets 自動轉型的樣子）
  const D = s => new w.VmDate(s + 'T00:00:00+08:00');
  cf.sheets.approved.rows.forEach(r => { r[0] = D(r[0]); });
  cf.sheets.leave.rows.forEach(r => { r[0] = D(r[0]); });
  cf.sheets.events.rows.forEach(r => { r[0] = new w.VmDate(r[0]); });
  w.call('mirrorCore_', true);
  const ap = hq.sheets.approved, leave = hq.sheets.leave, evs = hq.sheets.events;
  const m = sh => sh.headers.indexOf('mirror_src');
  chk('approved.date 讀回是純字串 yyyy-MM-dd（不是 Date、不差一天）', ap.rows.filter(r => r[m(ap)] === 'CF').map(r => r[0]).sort(), ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  chk('leave.日期 讀回是純字串', leave.rows.filter(r => r[m(leave)] === 'CF').map(r => typeof r[0] + ':' + r[0]).sort(), ['string:2026-09-15', 'string:2026-09-16']);
  chk('events.ts 讀回是台北 ISO 字串', evs.rows.filter(r => r[m(evs)] === 'CF').every(r => typeof r[0] === 'string' && /^2026-09-\d\dT\d\d:\d\d:\d\d\+08:00$/.test(r[0])), true);
  chk('Date→字串後 08:31 的 ts 值正確', evs.rows.some(r => r[0] === '2026-09-01T08:31:00+08:00' && r[1] === 'HQ-01'), true);
  // 讀回比對：再跑一次不應有變化
  const s1 = snap(hq); w.call('mirrorCore_', true);
  chk('Date 來源重跑仍冪等（讀回對得上）', snap(hq), s1);
}
{
  const { w, hq } = fresh();
  const before = snap(hq);
  delete w.book.CF_SS.sheets.approved;                       // 來源少一張必要的表
  const r = w.call('mirrorCore_', true);
  chk('來源缺必要分頁→失敗', [r.ok, r.error], [false, 'mirror_plan_failed']);
  chk('失敗＝完全沒寫（events 也沒寫）', [snap(hq), w.stats.writes], [before, 0]);
  w.cfg([{ code: 'CF', ss_id: 'NOPE', emp_prefix: 'HQ-' }]);
  const r2 = w.call('mirrorCore_', true);
  chk('來源試算表開不起來→失敗且不寫', [r2.ok, w.stats.writes], [false, 0]);
}
{
  const { w } = fresh();
  w.setBusy(true);
  chk('鎖被占用→busy，不寫', [w.call('mirrorCore_', true).error, w.stats.writes], ['busy', 0]);
  chk('乾跑不需要鎖', w.call('mirrorCore_', false).ok, true);
  w.setBusy(false);
  [[{ code: 'CF', ss_id: 'CF_SS', emp_prefix: '' }, '空前綴'], [{ code: 'CF', ss_id: 'PASTE_x', emp_prefix: 'HQ-' }, '佔位 ID'],
   [{ code: 'CF', ss_id: 'HQ_SS', emp_prefix: 'HQ-' }, '自己抄自己'], [{ code: '', ss_id: 'CF_SS', emp_prefix: 'HQ-' }, '沒有 code']].forEach(([c, label]) => {
    w.cfg([c]);
    chk('設定檢查擋住：' + label, w.call('mirrorCore_', true).error, 'bad_mirror_config');
  });
  w.cfg([]);
  chk('沒有設定→no_mirror_config', w.call('mirrorCore_', true).error, 'no_mirror_config');
}
{
  const { w } = fresh();
  w.call('setupMirrorTrigger');
  w.call('setupMirrorTrigger');
  chk('觸發器冪等：只有一支 mirrorFromSources、每天 04:00', JSON.stringify(w.triggers()), JSON.stringify([{ fn: 'mirrorFromSources', every: '1day', hour: 4 }]));
  w.call('handleSetupTriggers', { admin_key: 'RIGHT' });
  chk('setup_triggers 不會動到鏡像觸發器', w.triggers().filter(t => t.fn === 'mirrorFromSources').length, 1);
  chk('mirror_setup_trigger 要管理金鑰', w.call('handleMirrorSetupTrigger', { admin_key: 'x' }).error, 'unauthorized');
  chk('mirrorFromSources() 時間觸發器入口會寫入', [w.call('mirrorFromSources').ok, w.stats.writes > 0], [true, true]);
  chk('MIRROR_HANDLERS 有兩個 action', Object.keys(vm.runInContext('MIRROR_HANDLERS', w.sb)).sort(), ['mirror_run', 'mirror_setup_trigger']);
}

/* ═════ 八、最重要：改線前後薪資讀到的工時完全相同 ═════ */
console.log('\n══ 八、薪資驗收：A（總部讀央廚表，現況）vs B（總部讀自己的表＋鏡像列）══');
{
  const w = makeWorld(); buildSource(w); buildTarget(w); w.cfg(CFG);
  w.call('mirrorCore_', true);
  vm.runInContext(PAYROLL, w.sb);
  vm.runInContext("payRead = function () { return []; };", w.sb);   // 假別表／參數都走內建預設
  const ssFor = { CF: w.book.CF_SS, HQ_A: w.book.CF_SS, HQ_B: w.book.HQ_SS };
  vm.runInContext("payClockSS = function (store) { return __ssFor[store]; };", Object.assign(w.sb, { __ssFor: ssFor }));
  const collect = store => { vm.runInContext('PAY_CLOCK_CACHE = {};', w.sb); return w.call('payCollect', '2026-09', 6, store, [], undefined); };
  const A = collect('HQ_A'), B = collect('HQ_B'), CFr = collect('CF');
  const strip = o => JSON.parse(JSON.stringify(o));
  console.log('   HQ-01（A）:', JSON.stringify(A['HQ-01']));
  chk('A 的 HQ-01 工時有值（假資料有效）', A['HQ-01'].hours > 0, true);
  chk('payCollect：HQ-01 工時／請假／缺勤／遲到／忘刷 全欄位 A＝B', strip(B['HQ-01']), strip(A['HQ-01']));
  chk('  工時', [B['HQ-01'].hours, A['HQ-01'].hours], [A['HQ-01'].hours, A['HQ-01'].hours]);
  chk('  請假（病假 4H、特休 8H）', [B['HQ-01'].sick_h, B['HQ-01'].annual_h], [A['HQ-01'].sick_h, A['HQ-01'].annual_h]);
  chk('  出勤（餐費）天數 work_days', B['HQ-01'].work_days, A['HQ-01'].work_days);
  chk('  缺勤天數 deduct_days／忘刷', [B['HQ-01'].deduct_days, B['HQ-01'].forget_punch], [A['HQ-01'].deduct_days, A['HQ-01'].forget_punch]);
  chk('B 讀得到 HQ-02～05（主檔還沒建所以不算薪，但工時讀得到）', ['HQ-02', 'HQ-03', 'HQ-04', 'HQ-05'].map(k => B[k] ? B[k].hours : null), [9, 8, 8, 8]);
  chk('A 沒有 HQ-02～05（現況）', ['HQ-02', 'HQ-03', 'HQ-04', 'HQ-05'].map(k => A[k] ? 1 : 0), [0, 0, 0, 0]);
  chk('B 沒有 CF 的人（CF01／CF02 不會跑進總部）', ['CF01', 'CF02'].map(k => !!B[k]), [false, false]);
  // 央廚自己
  const cfBefore = strip(CFr);
  w.call('mirrorCore_', true);
  chk('央廚自己的薪資歸集（emp_prefix CF）不受影響：鏡像前後相同', strip(collect('CF')), cfBefore);

  // 出勤紀錄表匯出（payAttendanceBuild）：HQ-01 逐日完全相同
  const rd = (ss, n) => w.call('readSheetAsObjects', ss.sheets[n]).rows.map(r => { const o = {}; Object.keys(r).forEach(k => { o[k] = r[k]; }); return o; });
  const att = ss => strip(w.call('payAttendanceBuild', '2026-09', rd(ss, 'roster'), rd(ss, 'events'), rd(ss, 'approved'), rd(ss, 'leave'), 'HQ-01'));
  const aA = att(w.book.CF_SS), aB = att(w.book.HQ_SS);
  const hq01 = x => x.employees.find(e => e.emp_id === 'HQ-01');
  chk('出勤紀錄匯出：B 的 HQ-01 逐日資料與 A 相同', JSON.stringify(hq01(aB).days), JSON.stringify(hq01(aA).days));
  chk('  匯出的月彙總相同（active 欄是各店名冊自己的狀態，不比）', JSON.stringify(Object.assign({}, hq01(aB), { days: 0, active: 0 })), JSON.stringify(Object.assign({}, hq01(aA), { days: 0, active: 0 })));
  chk('  HQ-01 在總部名冊是停用，仍被匯出（有當月紀錄者一律列出）', !!hq01(aB), true);

  // 前提依賴：B 要靠總部名冊保留 HQ-01 的姓名才能把請假（只有姓名）對回工號
  const w2 = makeWorld(); buildSource(w2); const hq2 = buildTarget(w2); w2.cfg(CFG); w2.call('mirrorCore_', true);
  hq2.sheets.roster.rows = hq2.sheets.roster.rows.filter(r => r[0] !== 'HQ-01');
  vm.runInContext(PAYROLL, w2.sb); vm.runInContext("payRead = function () { return []; };", w2.sb);
  vm.runInContext("payClockSS = function () { return __h; };", Object.assign(w2.sb, { __h: hq2 }));
  vm.runInContext('PAY_CLOCK_CACHE = {};', w2.sb);
  const Bx = w2.call('payCollect', '2026-09', 6, 'HQ', [], undefined);
  chk('⚠ 前提：若總部名冊把 HQ-01 那列刪掉，請假會對不回工號（sick_h 變 0）→ 名冊停用可以、不可刪列', [Bx['HQ-01'].hours === A['HQ-01'].hours, Bx['HQ-01'].sick_h], [true, 0]);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
