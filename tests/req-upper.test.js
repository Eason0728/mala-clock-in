// 值班主管本人的申請改由上層審（2026-10-28，Requests.gs／SvcStaff.gs）。測試姓名一律假名。
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
  const J = x => JSON.parse(JSON.stringify(x));
  const fn = (name, body) => J(vm.runInContext('(function(b){return ' + name + '(b);})', sb)(body));
  const svc = (action, extra) => J(vm.runInContext('SVC_STAFF_HANDLERS', sb)[action](Object.assign({ action, v: 1, svc_key: props.STAFF_SVC_KEY }, extra || {})));
  const status = id => { const h = sheets.requests.data[0], row = sheets.requests.data.find((r, i) => i > 0 && r[0] === id); return row[h.indexOf('status')]; };
  const local = () => J(vm.runInContext('reqLocalDutyMgrs_(getSS())', sb));
  return { sb, sheets, props, fn, svc, status, J, local };
}
const rq = (id, emp, name, st, kind) => [id, '2026-10-20T09:00:00+08:00', emp, name, kind || 'leave', '2026-10-21', '事假', '', '', 8, '', '', '', st || 'pending', '', '', '', '', '', '', '', ''];
const MGR = { mgr_key: 'MK' };
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

// 基本場景：測試主管＝E01（姓名比對）、E02 一般同仁、營運系統列（allow_acting）、已停用列
function base(extra) {
  return makeEnv(Object.assign({
    roster: [ros('E01', '測試一'), ros('E02', '測試二'), ros('E03', '測試三')],
    managers: [['測試一', 'MK', 'true', ''], ['營運系統', 'OPS', 'true', 'TRUE'], ['舊主管', 'OLD', 'false', '']],
    reqs: [rq('r1', 'E01', '測試一'), rq('r2', 'E02', '測試二'), rq('r3', 'E01', '測試一'), rq('r4', 'E01', '測試一', 'approved')],
  }, extra || {}));
}
const UP = 'upper_review';

ok('本人核准被擋：不寫任何東西', () => {
  const e = base();
  const before = JSON.stringify(e.sheets.requests.data);
  const r = e.fn('handleMgrReqDecide_', Object.assign({ id: 'r1', decision: 'approve' }, MGR));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error, UP); assert(/上層主管/.test(r.message));
  assert.strictEqual(JSON.stringify(e.sheets.requests.data), before);
});
ok('本人退回被擋', () => {
  const e = base();
  const r = e.fn('handleMgrReqDecide_', Object.assign({ id: 'r1', decision: 'reject', reason: '不行' }, MGR));
  assert.strictEqual(r.error, UP); assert.strictEqual(e.status('r1'), 'pending');
});
ok('作廢被擋', () => {
  const e = base();
  const r = e.fn('handleMgrReqVoid_', Object.assign({ id: 'r4', reason: '改單' }, MGR));
  assert.strictEqual(r.error, UP); assert.strictEqual(e.status('r4'), 'approved');
});
ok('批次略過本人的申請、一般同仁照核准', () => {
  const e = base();
  const r = e.fn('handleMgrReqDecideBatch_', Object.assign({ ids: ['r1', 'r2', 'r3'], decision: 'approve' }, MGR));
  assert.deepStrictEqual(r.done, ['r2']);
  assert.deepStrictEqual(r.skipped.map(x => x.id).sort(), ['r1', 'r3']);
  assert(r.skipped.every(x => x.reason === '值班主管本人的申請，送上層審核'));
  assert.strictEqual(e.status('r1'), 'pending'); assert.strictEqual(e.status('r2'), 'approved');
});
ok('一般同仁的申請不受影響（核准／退回／作廢）', () => {
  const e = base();
  assert(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r2', decision: 'approve' }, MGR)).ok);
  const e2 = base(); e2.sheets.requests.data.push(rq('r5', 'E02', '測試二', 'approved'));
  assert(e2.fn('handleMgrReqVoid_', Object.assign({ id: 'r5', reason: '改單' }, MGR)).ok);
  const e3 = base();
  assert(e3.fn('handleMgrReqDecide_', Object.assign({ id: 'r2', decision: 'reject', reason: '人力足' }, MGR)).ok);
});
ok('allow_acting 營運系統鑰匙放行（核准／作廢／批次）', () => {
  const e = base();
  assert(e.fn('handleMgrReqDecide_', { mgr_key: 'OPS', id: 'r1', decision: 'approve', acting_name: '測試代理' }).ok);
  assert(e.fn('handleMgrReqVoid_', { mgr_key: 'OPS', id: 'r4', reason: '改單', acting_name: '測試代理' }).ok);
  const b = e.fn('handleMgrReqDecideBatch_', { mgr_key: 'OPS', ids: ['r3'], decision: 'approve', acting_name: '測試代理' });
  assert.deepStrictEqual(b.done, ['r3']);
});
ok('allow_acting 寫成布林 true 也放行（Sheets 讀回型別）', () => {
  const e = base({ managers: [['測試一', 'MK', true, ''], ['營運系統', 'OPS', true, true]] });
  assert(e.fn('handleMgrReqDecide_', { mgr_key: 'OPS', id: 'r1', decision: 'approve', acting_name: '測試代理' }).ok);
  assert.strictEqual(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r3', decision: 'approve' }, MGR)).error, UP);
});
ok('pending 每筆帶 upper', () => {
  const e = base();
  const r = e.fn('handleMgrReqPending_', MGR);
  const by = {}; r.items.forEach(x => (by[x.id] = x.upper));
  assert.deepStrictEqual(by, { r1: true, r2: false, r3: true });
});
ok('emp_id 欄優先：managers 列帶 emp_id 就不看姓名', () => {
  const e = base({ mgrHeaders: ['name', 'key', 'active', 'allow_acting', 'emp_id'],
    managers: [['查無此名', 'MK', 'TRUE', '', 'E03']] });
  const d = e.local();
  assert.deepStrictEqual(Object.keys(d.emps), ['E03']); assert.deepStrictEqual(d.warn, []);
  const p = e.fn('handleMgrReqPending_', MGR).items;
  assert(p.every(x => x.upper === false));   // E01 不再算
});
ok('同名兩人都算＋warn same_name', () => {
  const e = base({ roster: [ros('E01', '測試 一'), ros('E02', '測試一'), ros('E03', '測試三')],
    managers: [['測試一', 'MK', 'true', '']] });
  const d = e.local();
  assert.deepStrictEqual(Object.keys(d.emps).sort(), ['E01', 'E02']);
  assert.deepStrictEqual(d.warn, [{ name: '測試一', reason: 'same_name' }]);
});
ok('停用的同名在職判斷：只算 active 的人', () => {
  const e = base({ roster: [ros('E01', '測試一', false), ros('E02', '測試一', 'TRUE')], managers: [['測試一', 'MK', 'true', '']] });
  assert.deepStrictEqual(Object.keys(e.local().emps), ['E02']);
});
ok('名冊對不到 warn no_match', () => {
  const e = base({ managers: [['沒有這人', 'MK', 'true', '']] });
  const d = e.local();
  assert.deepStrictEqual(d.emps, {}); assert.deepStrictEqual(d.warn, [{ name: '沒有這人', reason: 'no_match' }]);
});
ok('REQ_UPPER_EMPS 跨店名單：本店 managers 沒有他也算', () => {
  const e = base(); e.props.REQ_UPPER_EMPS = JSON.stringify(['E02']);
  assert.strictEqual(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r2', decision: 'approve' }, MGR)).error, UP);
  const p = e.fn('handleMgrReqPending_', MGR).items; assert.strictEqual(p.find(x => x.id === 'r2').upper, true);
});
ok('REQ_UPPER_EMPS 壞 JSON／非陣列／非字串元素 → 當空', () => {
  for (const bad of ['{不是json', '{"a":1}', 'null', '[1,2,{"x":1}]', '']) {
    const e = base(); e.props.REQ_UPPER_EMPS = bad;
    assert(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r2', decision: 'approve' }, MGR)).ok, bad);
  }
});
ok('need_proof 仍擋（一般同仁）且本人的申請先回 upper_review', () => {
  const e = base({ reqs: [rq('p1', 'E02', '測試二'), rq('p2', 'E01', '測試一')] });
  e.sheets.requests.data[1][6] = '病假'; e.sheets.requests.data[2][6] = '病假';
  assert.strictEqual(e.fn('handleMgrReqDecide_', Object.assign({ id: 'p1', decision: 'approve' }, MGR)).error, 'need_proof');
  assert.strictEqual(e.fn('handleMgrReqDecide_', Object.assign({ id: 'p2', decision: 'approve' }, MGR)).error, UP);
  const b = e.fn('handleMgrReqDecideBatch_', Object.assign({ ids: ['p1', 'p2'], decision: 'approve' }, MGR));
  assert.deepStrictEqual(b.done, []); assert.strictEqual(b.skipped.length, 2);
});
ok('need_proof 仍擋上層：營運系統鑰匙核准本人的病假單照樣被 need_proof 擋', () => {
  const e = base({ reqs: [rq('p2', 'E01', '測試一')] }); e.sheets.requests.data[1][6] = '病假';
  assert.strictEqual(e.fn('handleMgrReqDecide_', { mgr_key: 'OPS', id: 'p2', decision: 'approve', acting_name: '測試代理' }).error, 'need_proof');
  assert(e.fn('handleMgrReqDecide_', { mgr_key: 'OPS', id: 'p2', decision: 'reject', reason: '補件', acting_name: '測試代理' }).ok);
});
ok('金鑰錯仍是 unauthorized', () => {
  const e = base();
  assert.strictEqual(e.fn('handleMgrReqDecide_', { mgr_key: 'OLD', id: 'r1', decision: 'approve' }).error, 'unauthorized');
});

// ── svc_roster／svc_set_upper ──
ok('svc_roster：duty_mgr 正確、mgr_warn 不含姓名、跨店名單不影響 duty_mgr', () => {
  const e = base({ managers: [['測試一', 'MK', 'true', ''], ['沒有這人', 'M2', 'true', ''], ['營運系統', 'OPS', 'true', 'TRUE']] });
  e.props.REQ_UPPER_EMPS = JSON.stringify(['E02']);
  const r = e.svc('svc_roster');
  assert(r.ok);
  const d = {}; r.rows.forEach(x => (d[x.emp_id] = x.duty_mgr));
  assert.deepStrictEqual(d, { E01: true, E02: false, E03: false });
  assert.deepStrictEqual(r.mgr_warn, [{ name_len: 4, reason: 'no_match' }]);
  assert(!JSON.stringify(r.mgr_warn).includes('沒有這人'));
});
ok('svc_roster：沒有 managers 分頁也不炸', () => {
  const e = base(); delete e.sheets.managers;
  const r = e.svc('svc_roster'); assert(r.ok); assert(r.rows.every(x => x.duty_mgr === false)); assert.deepStrictEqual(r.mgr_warn, []);
});
ok('svc_set_upper：去重、只收非空字串、寫入屬性', () => {
  const e = base();
  const r = e.svc('svc_set_upper', { emp_ids: ['E02', 'E02', '', ' E03 ', 5, null, 'E04'] });
  assert.deepStrictEqual(r, { ok: true, n: 3, on: true });
  assert.deepStrictEqual(JSON.parse(e.props.REQ_UPPER_EMPS), ['E02', 'E03', 'E04']);
  assert.deepStrictEqual(e.svc('svc_set_upper', { emp_ids: [] }), { ok: true, n: 0, on: true });
});
ok('svc_set_upper：上限 500；501 個整筆拒絕、不改原值', () => {
  const e = base(); e.props.REQ_UPPER_EMPS = '["E01"]';
  const many = Array.from({ length: 500 }, (_, i) => 'X' + i);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: many }).n, 500);
  const r = e.svc('svc_set_upper', { emp_ids: many.concat(['X500']) });
  assert.strictEqual(r.ok, false); assert.strictEqual(JSON.parse(e.props.REQ_UPPER_EMPS).length, 500);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: 'E01' }).ok, false);
});
ok('svc_set_upper：金鑰錯回 unauthorized、不寫入', () => {
  const e = base();
  const r = e.J(vm.runInContext('SVC_STAFF_HANDLERS', e.sb).svc_set_upper({ action: 'svc_set_upper', v: 1, svc_key: 'WRONG', emp_ids: ['E01'] }));
  assert.strictEqual(r.error, 'unauthorized'); assert.strictEqual(e.props.REQ_UPPER_EMPS, undefined);
});
ok('總開關關著：本人申請照舊可核／退回／作廢／批次，pending upper 全 false', () => {
  for (const v of [undefined, '0', 'true', 'TRUE', 1]) {
    const e = base({ off: true }); if (v !== undefined) e.props.REQ_UPPER_ON = v;
    assert.strictEqual(e.fn('handleMgrReqPending_', MGR).items.every(x => x.upper === false), true, String(v));
    assert(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r1', decision: 'approve' }, MGR)).ok, String(v));
    assert(e.fn('handleMgrReqDecide_', Object.assign({ id: 'r3', decision: 'reject', reason: 'x' }, MGR)).ok);
    assert(e.fn('handleMgrReqVoid_', Object.assign({ id: 'r4', reason: 'x' }, MGR)).ok);
  }
  const e = base({ off: true });
  assert.deepStrictEqual(e.fn('handleMgrReqDecideBatch_', Object.assign({ ids: ['r1', 'r2'], decision: 'approve' }, MGR)).done, ['r1', 'r2']);
});
ok('總開關關著：svc_roster 的 duty_mgr／mgr_warn 照常回', () => {
  const e = base({ off: true, managers: [['測試一', 'MK', 'true', ''], ['沒有這人', 'M2', 'true', '']] });
  const r = e.svc('svc_roster');
  assert.strictEqual(r.rows.find(x => x.emp_id === 'E01').duty_mgr, true);
  assert.deepStrictEqual(r.mgr_warn, [{ name_len: 4, reason: 'no_match' }]);
});
ok('svc_set_upper on:true 開、on:false 關、沒帶 on 不動；回應帶 on', () => {
  const e = base({ off: true });
  const A = Object.assign({ id: 'r1', decision: 'approve' }, MGR);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: [] }).on, false); assert.strictEqual(e.props.REQ_UPPER_ON, undefined);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: [], on: true }).on, true); assert.strictEqual(e.props.REQ_UPPER_ON, '1');
  assert.strictEqual(e.fn('handleMgrReqDecide_', A).error, UP);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: ['E02'] }).on, true);   // 沒帶 on：維持開
  assert.strictEqual(e.fn('handleMgrReqDecide_', A).error, UP);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: [], on: false }).on, false); assert.strictEqual(e.props.REQ_UPPER_ON, undefined);
  assert(e.fn('handleMgrReqDecide_', A).ok);
  assert.strictEqual(e.svc('svc_set_upper', { emp_ids: [] }).on, false);   // 沒帶 on：維持關
});
ok('allow_acting 沒帶 acting_name（舊路）→ 擋；空白／超長／非字串也擋；帶了放行且 decided_by＝acting_name', () => {
  for (const bad of [undefined, '', '   ', 'x'.repeat(41), 123]) {
    const e = base(); const b = { mgr_key: 'OPS', id: 'r1', decision: 'approve' }; if (bad !== undefined) b.acting_name = bad;
    const fmtBad = bad === 123 || bad === 'x'.repeat(41) || bad === '   ';   // 格式不合：actingName_ 先整筆拒絕
    assert.strictEqual(e.fn('handleMgrReqDecide_', b).error, fmtBad ? 'bad_acting_name' : UP, String(bad));
    assert.strictEqual(e.fn('handleMgrReqVoid_', { mgr_key: 'OPS', id: 'r4', reason: 'x', acting_name: bad }).error, fmtBad ? 'bad_acting_name' : UP);
    const r = e.fn('handleMgrReqDecideBatch_', { mgr_key: 'OPS', ids: ['r1', 'r2'], decision: 'approve', acting_name: bad });
    if (fmtBad) assert.strictEqual(r.error, 'bad_acting_name');
    else { assert.deepStrictEqual(r.done, ['r2']); assert.deepStrictEqual(r.skipped.map(x => x.id), ['r1']); }
    assert.strictEqual(e.status('r1'), 'pending');
  }
  const e = base();
  assert(e.fn('handleMgrReqDecide_', { mgr_key: 'OPS', id: 'r1', decision: 'approve', acting_name: ' 測試代理 ' }).ok);
  const h = e.sheets.requests.data[0], row = e.sheets.requests.data.find(r => r[0] === 'r1');
  assert.strictEqual(row[h.indexOf('decided_by')], '測試代理');
});
ok('mgr_req_day 帶 upper（同開關）；allow_acting＋acting_name 時全 false', () => {
  const mk = () => base({ reqs: [rq('d1', 'E01', '測試一', 'approved'), rq('d2', 'E02', '測試二', 'approved')] });
  const up = r => { const o = {}; Object.keys(r.by_emp).forEach(k => r.by_emp[k].forEach(x => (o[x.id] = x.upper))); return o; };
  assert.deepStrictEqual(up(mk().fn('handleMgrReqDay_', Object.assign({ date: '2026-10-21' }, MGR))), { d1: true, d2: false });
  assert.deepStrictEqual(up(mk().fn('handleMgrReqDay_', { mgr_key: 'OPS', date: '2026-10-21', acting_name: '測試代理' })), { d1: false, d2: false });
  assert.deepStrictEqual(up(mk().fn('handleMgrReqDay_', { mgr_key: 'OPS', date: '2026-10-21' })), { d1: true, d2: false });
  const off = makeEnv({ off: true, roster: [ros('E01', '測試一')], managers: [['測試一', 'MK', 'true', '']], reqs: [rq('d1', 'E01', '測試一', 'approved')] });
  assert.deepStrictEqual(up(off.fn('handleMgrReqDay_', Object.assign({ date: '2026-10-21' }, MGR))), { d1: false });
});
console.log('\n' + n + ' 項通過');
