// 核定紀錄：mgr_req_month 回 log（2026-11-04，Requests.gs reqAuditLog_）。測試姓名一律假名。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'apps-script');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

function FakeSheet(name, headers, rows) { this.name = name; this.data = [headers.slice()].concat((rows || []).map(r => r.slice())); }
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data.reduce((m, r) => Math.max(m, r.length), 0); };
FakeSheet.prototype.getDataRange = function () {
  const w = this.getLastColumn(), self = this;
  return { getValues: () => self.data.map(r => { const c = r.slice(); while (c.length < w) c.push(''); return c; }) };
};
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const self = this; nr = nr || 1; nc = nc || 1;
  return {
    getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (self.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); } return out; },
    setValue(v) { this.setValues([[v]]); },
    setValues(vv) { for (let i = 0; i < vv.length; i++) { while (self.data.length < r + i) self.data.push([]); for (let j = 0; j < vv[i].length; j++) { const row = self.data[r - 1 + i]; while (row.length < c + j - 1) row.push(''); row[c - 1 + j] = vv[i][j]; } } },
    setNumberFormat() { return this; },
  };
};

const ROSTER_H = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at'];
const EVENT_H = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const REQ_H = ['id', 'created_at', 'emp_id', 'name', 'kind', 'date', 'leave_type', 'start', 'end', 'hours', 'miss_type', 'reason', 'attach_id', 'status', 'decided_at', 'decided_by', 'reject_reason', 'seen_at', 'comp', 'voided_at', 'voided_by', 'void_reason'];
const ros = (id, name, active) => [id, name, 'k' + id, '', '', active === undefined ? true : active, '', '', '', '', '', '', '', ''];

function makeEnv(o) {
  o = o || {};
  const sheets = {};
  const add = (n, h, rows) => (sheets[n] = new FakeSheet(n, h, rows));
  const props = { STAFF_SVC_KEY: 'TESTSVCKEY-abc123' };
  if (!o.off) props.REQ_UPPER_ON = '1';   // 總開關：既有測試都在開著的狀態下跑
  const lock = { waitLock() {}, tryLock() { return true; }, releaseLock() {} };
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => add(n, [], []) };
  const sb = {
    console, Logger: { log() {} }, Date, Math, JSON, String, Number, Object, Array, isNaN, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty(k, v) { props[k] = v; }, deleteProperty(k) { delete props[k]; } }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({ get() { return null; }, put() {}, remove() {} }) },
    Utilities: { getUuid: () => 'u', formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString();
      return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19).replace(/^(.{10})T/, f.indexOf("'T'") >= 0 ? '$1T' : '$1 ') + (f.indexOf('XXX') >= 0 ? '+08:00' : ''); } },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  };
  vm.createContext(sb);
  vm.runInContext(read('Code.gs'), sb);
  vm.runInContext(read('Requests.gs'), sb);
  vm.runInContext(read('SvcStaff.gs'), sb);
  vm.runInContext('liffEvents_ = function () { return []; };', sb);
  add('roster', ROSTER_H, o.roster || []);
  add('events', EVENT_H, []);
  add('managers', o.mgrHeaders || ['name', 'key', 'active', 'allow_acting'], o.managers || []);
  add('requests', REQ_H, o.reqs || []);
  if (o.props) Object.assign(props, o.props);
  add('leave', ['日期', '姓名', '假別', '時數'], o.leaves || []);
  const J = x => JSON.parse(JSON.stringify(x));
  const fn = (name, body) => J(vm.runInContext('(function(b){return ' + name + '(b);})', sb)(body));
  const raw = (name, body) => vm.runInContext('(function(b){return ' + name + '(b);})', sb)(body);
  return { sb, sheets, props, fn, raw };
}
// id, created_at, emp, name, kind, date, leave_type, start, end, hours, miss_type, reason, attach_id, status, voided...
const rq = (id, emp, name, date, st, o) => { o = o || {};
  return [id, o.created || '2026-10-01T09:00:00+08:00', emp, name, o.kind || 'leave', date, o.type === undefined ? '事假' : o.type,
    o.start || '', o.end || '', o.hours === undefined ? 8 : o.hours, o.miss || '', o.reason || '', o.attach || '', st || 'approved',
    '', '', '', '', o.comp || '', '', '', '']; };
const M = { mgr_key: 'MK', ym: '2026-10' };
const OPS = { mgr_key: 'OPS', ym: '2026-10', acting_name: '測試代理' };
let n = 0; const ok = (name, f) => { f(); n++; console.log('✓ ' + name); };
const base = (o) => makeEnv(Object.assign({
  off: true,
  roster: [ros('E01', '測試一'), ros('E02', '測試二'), ros('E03', '測試 三'), ros('E04', '同名'), ros('E05', '同名')],
  managers: [['測試店長', 'MK', 'true', ''], ['營運系統', 'OPS', 'true', 'TRUE']],
}, o || {}));
const APPR_H = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'];
const withApproved = (e, rows) => { e.sheets.approved = new FakeSheet('approved', APPR_H, rows); return e; };
const apr = (date, emp, name, hrs, by, at, st) => [date, emp, name, '09:00-17:00', hrs, st || '正常', by, at];

ok('工時核定：同一天重核＝第一筆 hours、之後 rehours；系統重算標 recheck 且去掉尾巴；他月不列', () => {
  const e = withApproved(base(), [
    apr('2026-10-05', 'E01', '測試一', 8, '店長甲（DZY001）', '2026-10-05T18:00:00+08:00'),
    apr('2026-10-05', 'E01', '測試一', 7.5, '店長乙（DZY002）', '2026-10-06T09:00:00+08:00', '早退15分'),
    apr('2026-10-05', 'E01', '測試一', 7.5, '店長乙（DZY002）（系統重算）', '2026-10-07T05:00:00+08:00'),
    apr('2026-09-30', 'E01', '測試一', 8, '店長甲（DZY001）', '2026-09-30T18:00:00+08:00')]);
  const r = e.fn('handleMgrReqMonth_', M);
  const h = r.log.filter(x => x.kind === 'hours');
  assert.deepStrictEqual(h.map(x => x.action), ['recheck', 'rehours', 'hours']);       // 新到舊
  assert.strictEqual(h[0].by, '店長乙（DZY002）'); assert.strictEqual(h[0].system, true);
  assert.strictEqual(h[1].by, '店長乙（DZY002）'); assert.strictEqual(h[2].by, '店長甲（DZY001）');
  assert.strictEqual(new Set(h.map(x => x.ref)).size, 1);
  assert.strictEqual(h[1].detail.hours, 7.5); assert.strictEqual(h[1].detail.status, '早退15分');
});
ok('申請：送出／核准／退回／取消／作廢各一列，by 與時間照申請列', () => {
  const row = (id, st, ex) => { const r = rq(id, 'E02', '測試二', '2026-10-09', st); r[14] = ex.decided_at || ''; r[15] = ex.decided_by || ''; r[16] = ex.reject || ''; r[19] = ex.v_at || ''; r[20] = ex.v_by || ''; r[21] = ex.v_reason || ''; return r; };
  const e = base({ reqs: [
    row('a', 'approved', { decided_at: '2026-10-02T10:00:00+08:00', decided_by: '店長甲（DZY001）' }),
    row('b', 'rejected', { decided_at: '2026-10-02T11:00:00+08:00', decided_by: '店長甲（DZY001）', reject: '證明不足' }),
    row('c', 'cancelled', { decided_at: '2026-10-02T12:00:00+08:00', decided_by: '本人取消' }),
    row('d', 'voided', { decided_at: '2026-10-02T13:00:00+08:00', decided_by: '店長甲（DZY001）', v_at: '2026-10-04T09:00:00+08:00', v_by: '人資丙（DZY003）', v_reason: '同仁改期' })] });
  const r = e.fn('handleMgrReqMonth_', M);
  const by = {}; r.log.filter(x => x.kind === 'req').forEach(x => { (by[x.ref] = by[x.ref] || []).push(x.action + ':' + x.by); });
  assert.deepStrictEqual(by['R|a'].sort(), ['approve:店長甲（DZY001）', 'submit:測試二']);
  assert.deepStrictEqual(by['R|b'].sort(), ['reject:店長甲（DZY001）', 'submit:測試二']);
  assert.deepStrictEqual(by['R|c'].sort(), ['cancel:本人取消', 'submit:測試二']);
  assert.deepStrictEqual(by['R|d'].sort(), ['approve:店長甲（DZY001）', 'submit:測試二', 'void:人資丙（DZY003）']);
  const rej = r.log.find(x => x.action === 'reject'); assert.strictEqual(rej.detail.reason, '證明不足');
  const vd = r.log.find(x => x.action === 'void'); assert.strictEqual(vd.detail.reason, '同仁改期');
  assert(r.log.every(x => x.emp_id === 'E02' && x.at));
});
ok('待審申請只有送出一列；沒有 approved／device_log 分頁也不壞', () => {
  const e = base({ reqs: [rq('p', 'E01', '測試一', '2026-10-03', 'pending')] });
  const r = e.fn('handleMgrReqMonth_', M);
  assert.deepStrictEqual(r.log.map(x => x.action), ['submit']);
});
ok('不算本店支援的人（home）：工時核定與申請都不進 log，營運系統代核（acting）才列', () => {
  const e = withApproved(base({ props: { REQ_HOME_EMPS: '["E02"]' }, reqs: [rq('h', 'E02', '測試二', '2026-10-06')] }),
    [apr('2026-10-06', 'E02', '測試二', 8, '店長甲', '2026-10-06T18:00:00+08:00')]);
  assert.strictEqual(e.fn('handleMgrReqMonth_', M).log.length, 0);
  assert(e.fn('handleMgrReqMonth_', OPS).log.length >= 2);
});
ok('裝置核准：Liff 掛載覆蓋、成功才記 device_log、拒絕也記；核定失敗不記', () => {
  assert(/mgr_device_decision: function \(b\) \{ return reqDeviceDecisionLogged_\(b\); \}/.test(read('Liff.gs')));
  const e = base({ roster: [ros('E01', '測試一')] });
  e.sb.applyDeviceDecision = function () { return { ok: true, changed: 1 }; };
  const call = (b) => e.fn('reqDeviceDecisionLogged_', Object.assign({ mgr_key: 'OPS', acting_name: '店長甲（DZY001）' }, b));
  assert.strictEqual(call({ emp_id: 'E01', device_id: 'd1', approve: true }).ok, true);
  assert.strictEqual(call({ emp_id: 'E01', device_id: 'd1', approve: false }).ok, true);
  e.sb.applyDeviceDecision = function () { return { ok: false, error: 'no_pending_device' }; };
  call({ emp_id: 'E01', device_id: 'd2', approve: true });
  call({ mgr_key: 'NOPE', emp_id: 'E01', device_id: 'd1', approve: true });
  const rows = e.sheets.device_log.data.slice(1);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => [r[1], r[2], r[3], r[4]]), [['E01', '測試一', 'TRUE', '店長甲（DZY001）'], ['E01', '測試一', 'FALSE', '店長甲（DZY001）']]);
  const nowYm = vm.runInContext('nowTaipeiIso()', e.sb).slice(0, 7);
  const r = e.fn('handleMgrReqMonth_', { mgr_key: 'MK', ym: nowYm });
  assert.deepStrictEqual(r.log.filter(x => x.kind === 'device').map(x => x.action).sort(), ['device_no', 'device_ok']);
});
ok('公式開頭的姓名寫進 device_log 會被轉成全形', () => {
  const e = base({ roster: [ros('E01', '=1+1')] });
  e.sb.applyDeviceDecision = function () { return { ok: true }; };
  e.fn('reqDeviceDecisionLogged_', { mgr_key: 'OPS', acting_name: '店長甲', emp_id: 'E01', device_id: 'd', approve: true });
  assert.strictEqual(e.sheets.device_log.data[1][2], '＝1+1');
});
console.log('\n' + n + ' 項通過');
