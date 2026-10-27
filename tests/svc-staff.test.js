// SvcStaff.gs（管理系統呼叫的名冊服務端點）驗收：task.md A1–A6。測試資料一律假名。
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRC = path.join(__dirname, '..', 'apps-script');
const CODE = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8');
const SVC = fs.readFileSync(path.join(SRC, 'SvcStaff.gs'), 'utf8');
const REQ = fs.readFileSync(path.join(SRC, 'Requests.gs'), 'utf8');   // svc_roster 用到 reqLocalDutyMgrs_（部署時同專案全域）

// ── 假試算表 ─────────────────────────────────────────────
function FakeSheet(name, headers, rows) {
  this.name = name; this.data = [headers.slice()].concat((rows || []).map(r => r.slice()));
  this.formats = {};
}
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data.reduce((m, r) => Math.max(m, r.length), 0); };
FakeSheet.prototype.getDataRange = function () {
  const w = this.getLastColumn(); const self = this;
  return { getValues: () => self.data.map(r => { const c = r.slice(); while (c.length < w) c.push(''); return c; }) };
};
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const self = this; nr = nr || 1; nc = nc || 1;
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (self.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
      return out;
    },
    setValue(v) { this.setValues([[v]]); },
    setValues(vv) {
      for (let i = 0; i < vv.length; i++) {
        while (self.data.length < r + i) self.data.push([]);
        for (let j = 0; j < vv[i].length; j++) {
          const row = self.data[r - 1 + i]; while (row.length < c + j - 1) row.push('');
          row[c - 1 + j] = vv[i][j];
        }
      }
    },
    setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) self.formats[(r + i) + ',' + (c + j)] = f; return this; },
  };
};

const ROSTER_H = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out',
  'created_at', 'created_by', 'removed_at', 'removed_by', 'line_user_id', 'line_bound_at'];
const EVENT_H = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];

function makeEnv(opts) {
  opts = opts || {};
  const sheets = {};
  const add = (n, h, rows) => (sheets[n] = new FakeSheet(n, h, rows));
  const props = { STAFF_SVC_KEY: 'TESTSVCKEY-abc123' };
  if (opts.noKey) delete props.STAFF_SVC_KEY;
  const lockLog = { waits: [], obj: null, failWait: false, released: 0 };
  const lock = { waitLock(ms) { lockLog.waits.push(ms); if (lockLog.failWait) throw new Error('timeout'); }, tryLock() { return true; }, releaseLock() { lockLog.released++; } };
  lockLog.obj = lock;
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => add(n, [], []) };
  const flushHook = { fn: null };
  const sb = {
    console, Logger: { log() {} }, Date, Math, JSON, String, Number, Object, Array, isNaN, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, flush() { if (flushHook.fn) flushHook.fn(); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty(k, v) { props[k] = v; } }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({ get() { return null; }, put() {}, remove() {} }) },
    Utilities: { formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString();
      return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19).replace(/^(.{10})T/, f.indexOf("'T'") >= 0 ? '$1T' : '$1 ') + (f.indexOf('XXX') >= 0 ? '+08:00' : ''); } },
    ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
  };
  vm.createContext(sb);
  vm.runInContext(CODE, sb);
  if (!opts.noSvc) { vm.runInContext(REQ, sb); vm.runInContext(SVC, sb); }
  const call = (action, body) => vm.runInContext('(function(a,b){return (typeof SVC_STAFF_HANDLERS!=="undefined"?SVC_STAFF_HANDLERS:{})[a](b);})', sb)(action, body);
  const svc = (action, extra) => { const r = call(action, Object.assign({ action, v: 1, svc_key: props.STAFF_SVC_KEY || 'x' }, extra || {})); return JSON.parse(JSON.stringify(r)); };
  const post = body => JSON.parse(vm.runInContext('doPost', sb)({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { sb, sheets, add, props, lockLog, flushHook, svc, call, post, KEY: props.STAFF_SVC_KEY };
}

function rosterEnv(rows, headers) {
  const e = makeEnv(); e.add('roster', headers || ROSTER_H, rows || []); e.add('events', EVENT_H, []); return e;
}
const rowOf = (e, id) => { const d = e.sheets.roster.data, h = d[0]; const r = d.slice(1).find(x => x[h.indexOf('emp_id')] === id); if (!r) return null; const o = {}; h.forEach((k, i) => (o[k] = r[i])); return o; };
const people = () => [
  ['E01', '測試甲', 'KEYJIA0000000000AAAA', 'DEV-JIA', '2026-09-01T09:00:00+08:00', true, '', '', '2026-08-01T09:00:00+08:00', '主管', '', '', 'Uline-jia-secret', '2026-09-02T09:00:00+08:00'],
  ['E02', '測試乙', 'KEYYI00000000000BBBB', '', '', false, '', '', '2026-08-02T09:00:00+08:00', '主管', '2026-09-30T10:00:00+08:00', '主管', '', ''],
];

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const ACTIONS = ['svc_roster', 'svc_add', 'svc_set_active', 'svc_link', 'svc_payroll_names'];
const goodArgs = { svc_roster: {}, svc_add: { name: '測試丙', op_id: 'dzy:J1', created_by: '管理系統:DZY001' },
  svc_set_active: { emp_id: 'E01', active: false, op_id: 'dzy:J2', by: '管理系統:DZY001' }, svc_link: { emp_id: 'E01' }, svc_payroll_names: {} };

// ══ A1 骨架＋驗證 ══
ok('A1 未設 STAFF_SVC_KEY：五個 action 全回 unauthorized', () => {
  const e = makeEnv({ noKey: true }); e.add('roster', ROSTER_H, people());
  ACTIONS.forEach(a => { const r = e.call(a, Object.assign({ action: a, v: 1, svc_key: 'anything' }, goodArgs[a])); assert.strictEqual(r.error, 'unauthorized', a); assert.strictEqual(r.ok, false); });
  ACTIONS.forEach(a => assert.strictEqual(e.call(a, Object.assign({ action: a, v: 1 }, goodArgs[a])).error, 'unauthorized', a + ' 無 svc_key'));
  assert.strictEqual(e.sheets.roster.data.length, 3, '被拒不能動名冊');
});
ok('A1 錯金鑰／缺金鑰／非字串金鑰 → unauthorized', () => {
  const e = rosterEnv(people());
  ACTIONS.forEach(a => {
    [{ svc_key: 'wrong' }, { svc_key: '' }, { svc_key: 123 }, { svc_key: e.KEY + 'x' }, { svc_key: e.KEY.slice(0, -1) }].forEach(k =>
      assert.strictEqual(e.call(a, Object.assign({ action: a, v: 1 }, goodArgs[a], k)).error, 'unauthorized', a));
  });
});
ok('A1 v≠1 或缺 v → bad_version（金鑰對）', () => {
  const e = rosterEnv(people());
  ACTIONS.forEach(a => {
    [2, 0, '1', undefined].forEach(v => assert.strictEqual(e.call(a, Object.assign({ action: a, svc_key: e.KEY, v }, goodArgs[a])).error, 'bad_version', a));
  });
  assert.strictEqual(e.svc('svc_roster').ok, true);
});
ok('A1 比對是固定時間（逐字元 XOR 累加，不提前 return）', () => {
  const e = makeEnv();
  const eq = e.sb.svcEq_;
  assert.strictEqual(eq('abc', 'abc'), true); assert.strictEqual(eq('abc', 'abd'), false);
  assert.strictEqual(eq('abc', 'abcd'), false); assert.strictEqual(eq('', 'a'), false);
  const body = SVC.slice(SVC.indexOf('function svcEq_'), SVC.indexOf('function svcAuth_'));
  assert.ok(/\^/.test(body) && /\|=/.test(body), '要有 XOR 累加');
  assert.ok(!/===\s*svc_key|svc_key\s*===|body\.svc_key\s*!==\s*key/.test(SVC), '不得用 === 直接比金鑰');
});

// ══ A2 svc_roster ══
ok('A2 只回規格欄位；布林；不含 key／device_id／line_user_id', () => {
  const e = rosterEnv(people());
  const r = e.svc('svc_roster');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rows.length, 2);
  const want = ['emp_id', 'name', 'active', 'created_at', 'removed_at', 'line_bound', 'line_h', 'line_kid', 'line_bound_at', 'line_ok_at', 'last_punch', 'duty_mgr', 'src_store', 'src_emp_id'].sort();
  r.rows.forEach(x => assert.deepStrictEqual(Object.keys(x).sort(), want));
  const [a, b] = r.rows;
  assert.strictEqual(a.active, true); assert.strictEqual(b.active, false);
  assert.strictEqual(a.line_bound, true); assert.strictEqual(b.line_bound, false);
  assert.strictEqual(a.created_at, '2026-08-01 09:00:00'); assert.strictEqual(b.removed_at, '2026-09-30 10:00:00'); assert.strictEqual(a.removed_at, '');
  const s = JSON.stringify(r);
  ['KEYJIA', 'KEYYI', 'DEV-JIA', 'Uline-jia-secret', '"key"', 'device_id', 'line_user_id'].forEach(t => assert.ok(!s.includes(t), '洩漏 ' + t));
});
ok('A2 last_punch 取 events 該人最大日期；無紀錄／只有被拒的卡為空字串', () => {
  const e = rosterEnv(people());
  const ev = e.sheets.events;
  const t = (d) => d + 'T09:00:00+08:00';
  const now = Date.now(); const day = k => new Date(now + 8 * 3600000 - k * 86400000).toISOString().slice(0, 10);
  [[t(day(9)), 'E01', 'in', 'ok'], [t(day(3)), 'E01', 'out', 'ok'], [t(day(1)), 'E01', 'in', 'rejected_duplicate'], [t(day(5)), 'E02', 'in', 'rejected_device']]
    .forEach(x => ev.data.push([x[0], x[1], x[2], 0, 0, 0, true, '', true, x[3], 5]));
  const r = e.svc('svc_roster');
  assert.strictEqual(r.rows[0].last_punch, day(3)); assert.strictEqual(r.rows[1].last_punch, '');
});
ok('A2 空名冊回 []；沒有 roster 分頁也回 []', () => {
  assert.deepStrictEqual(rosterEnv([]).svc('svc_roster'), { ok: true, line_probe: '', line_kid: '', mgr_warn: [], rows: [] });
  const e = makeEnv(); assert.deepStrictEqual(e.svc('svc_roster'), { ok: true, rows: [] });
});
ok('A2 Date 物件的儲存格也正規化成 yyyy-MM-dd HH:mm:ss', () => {
  const rows = people(); rows[0][8] = new Date('2026-08-01T01:00:00Z');
  const e = rosterEnv(rows); assert.strictEqual(e.svc('svc_roster').rows[0].created_at, '2026-08-01 09:00:00');
});

// ══ A3 svc_add ══
const addArgs = (o) => Object.assign({ name: '測試丙', op_id: 'dzy:J20261014093015-a3f0', created_by: '管理系統:DZY014', src_store: 'mztjs', src_emp_id: 'S-007' }, o || {});
ok('A3 新增：取號沿用 nextEmpId、寫齊欄位、回 emp_id 且不回 key', () => {
  const e = rosterEnv(people());
  const r = e.svc('svc_add', addArgs());
  assert.deepStrictEqual(r, { ok: true, emp_id: 'E03', active: true });
  const row = rowOf(e, 'E03');
  assert.strictEqual(row.name, '測試丙'); assert.strictEqual(row.active, true); assert.strictEqual(row.created_by, '管理系統:DZY014');
  assert.ok(/^[A-Za-z0-9]{20}$/.test(row.key), 'key 用 genKey 的 20 碼');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.created_at));
  assert.strictEqual(row.src_store, 'mztjs'); assert.strictEqual(row.src_emp_id, 'S-007'); assert.strictEqual(row.origin_op, 'dzy:J20261014093015-a3f0');
  assert.ok(!JSON.stringify(r).includes(row.key));
});
ok('A3 ensure 表頭：只在右側補 src_store, src_emp_id, origin_op, last_op，原欄不動', () => {
  const e = rosterEnv(people());
  e.svc('svc_add', addArgs());
  assert.deepStrictEqual(e.sheets.roster.data[0], ROSTER_H.concat(['src_store', 'src_emp_id', 'origin_op', 'last_op']));
  const before = JSON.stringify(e.sheets.roster.data[0]); e.svc('svc_add', addArgs({ op_id: 'dzy:J9', name: '測試丁' }));
  assert.strictEqual(JSON.stringify(e.sheets.roster.data[0]), before, '第二次不再補');
  const e2 = rosterEnv(people()); e2.svc('svc_roster'); e2.svc('svc_link', { emp_id: 'E01' });
  assert.deepStrictEqual(e2.sheets.roster.data[0], ROSTER_H, '唯讀端點不改表頭');
});
ok('A3 冪等：同 op_id 第二次回同一 emp_id，名冊只多一列', () => {
  const e = rosterEnv(people());
  const a = e.svc('svc_add', addArgs()), b = e.svc('svc_add', addArgs());
  assert.strictEqual(a.emp_id, b.emp_id); assert.strictEqual(e.sheets.roster.data.length, 4);
  // 同 op_id 即使此刻同名在職也走冪等（先於 duplicate_name 檢查）
  assert.strictEqual(e.svc('svc_add', addArgs()).ok, true);
});
ok('A3 寫名冊後、回應前丟例外，重送仍回同一 emp_id 且名冊只一列', () => {
  const e = rosterEnv(people());
  e.flushHook.fn = () => { e.flushHook.fn = null; throw new Error('寫入後崩潰'); };
  assert.throws(() => e.svc('svc_add', addArgs()), /寫入後崩潰/);
  assert.strictEqual(e.sheets.roster.data.length, 4, '例外前已落地');
  assert.ok(e.lockLog.released >= 1, '例外也要放鎖');
  const r = e.svc('svc_add', addArgs());
  assert.deepStrictEqual(r, { ok: true, emp_id: 'E03', active: true }); assert.strictEqual(e.sheets.roster.data.length, 4);
});
ok('A3 回應與任何非名冊分頁都找不到 key 字串；root 名冊也只有該人自己那格', () => {
  const e = rosterEnv(people()); e.add('payroll_master', ['emp_id', 'name', 'wage', 'store'], [['E01', '測試甲', 40000, 'SSLGF']]);
  const outs = [e.svc('svc_add', addArgs()), e.svc('svc_add', addArgs()), e.svc('svc_roster'), e.svc('svc_set_active', goodArgs.svc_set_active), e.svc('svc_payroll_names')];
  const keys = e.sheets.roster.data.slice(1).map(r => r[2]);
  const blob = JSON.stringify(outs) + JSON.stringify(e.sheets.events.data) + JSON.stringify(e.sheets.payroll_master.data);
  keys.forEach(k => assert.ok(!blob.includes(k), '洩漏 key ' + k));
  const roster = e.sheets.roster.data; const kc = roster[0].indexOf('key');
  roster.forEach((r, i) => r.forEach((v, c) => { if (i > 0 && c !== kc) keys.forEach(k => assert.ok(String(v) !== k && !String(v).includes(k), '名冊其他欄出現 key')); }));
  assert.deepStrictEqual(Object.keys(e.sheets).sort(), ['events', 'payroll_master', 'roster'], '不得新增存結果的分頁');
});
ok('A3 在職同名（去頭尾空白）→ duplicate_name；離職同名可建', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '  測試甲 ', op_id: 'x1' })).error, 'duplicate_name');
  assert.strictEqual(e.sheets.roster.data.length, 3);
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '測試乙', op_id: 'x2' })).ok, true);
});
ok('A3 name 去頭尾空白、空白／超過 20 字 → bad_input', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '   ', op_id: 'a' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '', op_id: 'b' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '甲'.repeat(21), op_id: 'c' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ name: undefined, op_id: 'd' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ op_id: '' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ created_by: '' , op_id: 'e'})).error, 'bad_input');
  assert.strictEqual(e.sheets.roster.data.length, 3);
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '  測試戊  ', op_id: 'f' })).ok, true);
  assert.strictEqual(rowOf(e, 'E03').name, '測試戊');
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '甲'.repeat(20), op_id: 'g' })).ok, true);
});
ok('A3 與 mgr_add_employee 同一把 ScriptLock（waitLock 15 秒）；拿不到回 busy', () => {
  const e = rosterEnv(people());
  e.svc('svc_add', addArgs());
  assert.deepStrictEqual(e.lockLog.waits, [15000]);
  const src = CODE.slice(CODE.indexOf('function handleMgrAddEmployee(body)'), CODE.indexOf('function handleMgrAddEmployeeUnlocked_'));
  assert.ok(/LockService\.getScriptLock\(\)/.test(src) && /waitLock\(15000\)/.test(src));
  assert.ok(/LockService\.getScriptLock\(\)/.test(SVC) && /waitLock\(15000\)/.test(SVC));
  assert.ok(!/getDocumentLock|getUserLock/.test(SVC));
  e.lockLog.failWait = true;
  const r = e.svc('svc_add', addArgs({ op_id: 'zz' }));
  assert.strictEqual(r.error, 'busy'); assert.strictEqual(e.sheets.roster.data.length, 4);
});
ok('A3 依實際表頭定位：欄序打亂（含新欄在中間）仍寫對欄', () => {
  const shuffled = ['origin_op', 'name', 'created_by', 'active', 'emp_id', 'line_user_id', 'key', 'src_emp_id', 'created_at', 'device_id', 'removed_at', 'src_store'];
  const rows = [['', '測試甲', '主管', true, 'HQ-05', '', 'K1', '', '2026-08-01T09:00:00+08:00', '', '', ''],
                ['', '測試乙', '主管', false, 'HQ-06', '', 'K2', '', '2026-08-01T09:00:00+08:00', '', '', '']];
  const e = rosterEnv(rows, shuffled);
  const r = e.svc('svc_add', addArgs());
  assert.deepStrictEqual(r, { ok: true, emp_id: 'HQ-07', active: true });
  const o = rowOf(e, 'HQ-07');
  assert.strictEqual(o.name, '測試丙'); assert.strictEqual(o.active, true); assert.strictEqual(o.created_by, '管理系統:DZY014');
  assert.strictEqual(o.origin_op, 'dzy:J20261014093015-a3f0'); assert.strictEqual(o.src_store, 'mztjs'); assert.strictEqual(o.src_emp_id, 'S-007');
  assert.ok(/^[A-Za-z0-9]{20}$/.test(o.key)); assert.strictEqual(o.line_user_id, ''); assert.strictEqual(o.device_id, '');
  assert.deepStrictEqual(e.sheets.roster.data[0].slice(0, shuffled.length), shuffled, '原欄序不動');
  assert.strictEqual(e.svc('svc_add', addArgs()).emp_id, 'HQ-07'); assert.strictEqual(e.sheets.roster.data.length, 4);
});
ok('A3 不用 appendRow 組位置列', () => { const code = SVC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''); assert.ok(!/appendRow/.test(code)); });

// ══ A4 svc_set_active＋svc_link ══
ok('A4 不存在 → not_found（set_active／link 都是）', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E99', active: false, op_id: 'o', by: 'b' }).error, 'not_found');
  assert.strictEqual(e.svc('svc_link', { emp_id: 'E99' }).error, 'not_found');
});
ok('A4 svc_link 對已停用的人回 disabled，不給金鑰', () => {
  const e = rosterEnv(people());
  const r = e.svc('svc_link', { emp_id: 'E02' });
  assert.strictEqual(r.error, 'disabled'); assert.strictEqual(r.key, undefined);
});
ok('A4 停用寫 active／removed_at／removed_by；回 {ok,emp_id,active}', () => {
  const e = rosterEnv(people());
  const r = e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'o1', by: '管理系統:DZY014' });
  assert.deepStrictEqual(r, { ok: true, emp_id: 'E01', active: false });
  const o = rowOf(e, 'E01');
  assert.strictEqual(o.active, false); assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(o.removed_at)); assert.strictEqual(o.removed_by, '管理系統:DZY014');
  assert.strictEqual(e.sheets.roster.formats['2,' + (ROSTER_H.indexOf('removed_at') + 1)], '@');
});
ok('A4 恢復：清 removed_*；同名在職 → duplicate_name', () => {
  const e = rosterEnv(people());
  assert.deepStrictEqual(e.svc('svc_set_active', { emp_id: 'E02', active: true, op_id: 'o2', by: 'b' }), { ok: true, emp_id: 'E02', active: true });
  const o = rowOf(e, 'E02'); assert.strictEqual(o.active, true); assert.strictEqual(o.removed_at, ''); assert.strictEqual(o.removed_by, '');
  const e2 = rosterEnv(people());
  e2.svc('svc_add', addArgs({ name: '測試乙', op_id: 'n1' }));   // 乙已離職，所以可新建同名在職
  const r = e2.svc('svc_set_active', { emp_id: 'E02', active: true, op_id: 'o3', by: 'b' });
  assert.strictEqual(r.error, 'duplicate_name'); assert.strictEqual(rowOf(e2, 'E02').active, false);
});
ok('A4 op_id 冪等：已是目標狀態直接回 ok，不改 removed_at', () => {
  const e = rosterEnv(people());
  e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'o1', by: 'b1' });
  const first = rowOf(e, 'E01').removed_at;
  const again = e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'o1', by: 'b2' });
  assert.deepStrictEqual(again, { ok: true, emp_id: 'E01', active: false });
  assert.strictEqual(rowOf(e, 'E01').removed_at, first); assert.strictEqual(rowOf(e, 'E01').removed_by, 'b1');
  assert.deepStrictEqual(e.svc('svc_set_active', { emp_id: 'E02', active: false, op_id: 'o9', by: 'b' }), { ok: true, emp_id: 'E02', active: false });
  assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E01', active: 'maybe', op_id: 'o', by: 'b' }).error, 'bad_input');
  assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E01', active: false, by: 'b' }).error, 'bad_input');
});
ok('審查#8 同 op_id 重送回同結果（即使狀態已被別的 op 改過）；不同 op_id 照常執行', () => {
  const e = rosterEnv(people());
  const A = { emp_id: 'E01', active: false, op_id: 'opA', by: 'b' };
  assert.deepStrictEqual(e.svc('svc_set_active', A), { ok: true, emp_id: 'E01', active: false });
  assert.strictEqual(rowOf(e, 'E01').last_op, 'opA');
  // 別的管道（舊的 mgr_set_active 手動恢復）改回在職，last_op 仍是 opA
  const h = e.sheets.roster.data[0]; e.sheets.roster.data[1][h.indexOf('active')] = true;
  // opA 重送但現況（被別的管道恢復）與目標不同 → conflict，不得回成功、不得再翻
  const cf = e.svc('svc_set_active', A);
  assert.deepStrictEqual(cf.ok, false); assert.strictEqual(cf.error, 'conflict'); assert.strictEqual(cf.active, true);
  assert.strictEqual(rowOf(e, 'E01').active, true, '重送不得再翻一次');
  // 現況與目標一致時重送 → ok 且帶 active
  e.sheets.roster.data[1][h.indexOf('active')] = false;
  assert.deepStrictEqual(e.svc('svc_set_active', A), { ok: true, emp_id: 'E01', active: false });
  // 不同 op_id 照常執行
  e.sheets.roster.data[1][h.indexOf('active')] = true;
  e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'opC', by: 'b' });
  assert.strictEqual(rowOf(e, 'E01').active, false); assert.strictEqual(rowOf(e, 'E01').last_op, 'opC');
});
ok('審查#9 created_by／by 超過 40 字 → bad_input（40 字可過）', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_add', addArgs({ created_by: 'x'.repeat(41), op_id: 'l1' })).error, 'bad_input');
  assert.strictEqual(e.sheets.roster.data.length, 3);
  assert.strictEqual(e.svc('svc_add', addArgs({ created_by: 'x'.repeat(40), op_id: 'l2' })).ok, true);
  assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'l3', by: 'y'.repeat(41) }).error, 'bad_input');
  assert.strictEqual(rowOf(e, 'E01').active, true, '被拒不得改名冊');
  assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'l4', by: 'y'.repeat(40) }).ok, true);
});
ok('審查#2 姓名上限維持 20（21 字 bad_input）', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '甲'.repeat(21), op_id: 'm1' })).error, 'bad_input');
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '甲'.repeat(20), op_id: 'm2' })).ok, true);
});
ok('F2 name／created_by／by 以 = + - @ 開頭（含前導空白）→ bad_input，名冊不動', () => {
  const e = rosterEnv(people());
  ['=1+1', '+1', '-B', '@x', '  =cmd', '\t@x'].forEach((v, i) => {
    assert.strictEqual(e.svc('svc_add', addArgs({ name: v, op_id: 'f' + i })).error, 'bad_input', 'name ' + v);
    assert.strictEqual(e.svc('svc_add', addArgs({ created_by: v, op_id: 'g' + i })).error, 'bad_input', 'created_by ' + v);
    assert.strictEqual(e.svc('svc_set_active', { emp_id: 'E01', active: false, op_id: 'h' + i, by: v }).error, 'bad_input', 'by ' + v);
  });
  assert.strictEqual(e.sheets.roster.data.length, 3); assert.strictEqual(rowOf(e, 'E01').active, true);
  assert.strictEqual(e.svc('svc_add', addArgs({ name: '測試-B', op_id: 'ok1' })).ok, true, '中間有減號可以');
});
ok('F2 svc_add 寫列前文字欄設純文字格式 @', () => {
  const e = rosterEnv(people()); e.svc('svc_add', addArgs());
  const h = e.sheets.roster.data[0];
  ['emp_id', 'name', 'key', 'created_at', 'created_by', 'src_store', 'src_emp_id', 'origin_op'].forEach(c =>
    assert.strictEqual(e.sheets.roster.formats['4,' + (h.indexOf(c) + 1)], '@', c));
});
ok('F6 svc_add 回應帶 active 布林（新增＝true；冪等命中帶該列現況）', () => {
  const e = rosterEnv(people());
  assert.strictEqual(e.svc('svc_add', addArgs()).active, true);
  e.svc('svc_set_active', { emp_id: 'E03', active: false, op_id: 'z1', by: 'b' });
  const r = e.svc('svc_add', addArgs());
  assert.deepStrictEqual(r, { ok: true, emp_id: 'E03', active: false });
  assert.strictEqual(e.sheets.roster.data.length, 4);
});
ok('A4 svc_link 只回該人 key、不寫任何東西', () => {
  const e = rosterEnv(people());
  const snap = JSON.stringify(e.sheets);
  const r = e.svc('svc_link', { emp_id: 'E01' });
  assert.ok(r.ok && typeof r.key === 'string' && r.key.length >= 10, '在職者拿得到金鑰');
  assert.strictEqual(r.key, rowOf(e, 'E01').key);
  assert.strictEqual(JSON.stringify(e.sheets), snap, '不得改動任何分頁（含表頭）');
  assert.deepStrictEqual(Object.keys(e.sheets).sort(), ['events', 'roster']);
});

// ══ A6 svc_payroll_names ══
ok('A6 只回 {store,emp_id,name}，無金額欄；沒有 payroll_master 回 []', () => {
  const e = rosterEnv(people());
  assert.deepStrictEqual(e.svc('svc_payroll_names'), { ok: true, rows: [] });
  e.add('payroll_master', ['emp_id', 'name', 'is_full_time', 'wage', 'base', 'gross', 'store', 'bonus_perf', 'total'],
    [['E01', '測試甲', true, 41000, 36000, 52000, 'SSLGF', 999, 777], ['E02', '測試乙', false, 190, 0, 0, '', 1, 2], ['', '', '', '', '', '', '', '', '']]);
  const r = e.svc('svc_payroll_names');
  assert.strictEqual(r.rows.length, 2);
  r.rows.forEach(x => assert.deepStrictEqual(Object.keys(x).sort(), ['emp_id', 'name', 'store']));
  assert.deepStrictEqual(r.rows[0], { store: 'SSLGF', emp_id: 'E01', name: '測試甲' });
  const s = JSON.stringify(r); ['41000', '36000', '52000', '999', '777', '190', 'wage', 'gross'].forEach(t => assert.ok(!s.includes(t), '含金額 ' + t));
});
ok('A6 未設金鑰全拒（含錯 v）', () => {
  const e = makeEnv({ noKey: true }); e.add('payroll_master', ['emp_id', 'name', 'wage'], [['E01', '測試甲', 1]]);
  assert.strictEqual(e.call('svc_payroll_names', { v: 1, svc_key: '' }).error, 'unauthorized');
});

// ══ A5 Code.gs 分派 ══
ok('A5 Code.gs 只多一段（≤5 行含註解與空行）、typeof 保護；SvcStaff 不存在不影響', () => {
  const m = CODE.match(/if \(typeof SVC_STAFF_HANDLERS !== 'undefined'\) \{\n[^\n]+\n  \}/);
  assert.ok(m, '分派表要有 typeof 保護的併入段'); assert.strictEqual(m[0].split('\n').length, 3, '併入本體三行');
  const e = makeEnv({ noSvc: true }); e.add('roster', ROSTER_H, people());
  assert.strictEqual(e.post({ action: 'svc_roster', v: 1, svc_key: 'x' }).error, 'unknown_action');
  assert.strictEqual(e.post({ action: 'nope' }).error, 'unknown_action');
  assert.strictEqual(e.post({ action: 'get_roster' }).error !== 'unknown_action', true, '舊 action 照舊可達');
});
ok('A5 doPost 分派到 svc_*；舊 action 照舊', () => {
  const e = rosterEnv(people());
  const r = e.post({ action: 'svc_roster', v: 1, svc_key: e.KEY });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(e.post({ action: 'svc_add', v: 1, svc_key: 'bad', name: 'x' }).error, 'unauthorized');
  assert.strictEqual(e.post({ action: 'svc_link', v: 1, svc_key: e.KEY, emp_id: 'E01' }).key, 'KEYJIA0000000000AAAA');
  ['get_roster', 'mgr_roster', 'mgr_add_employee', 'mgr_set_active', 'clock', 'whoami'].forEach(a =>
    assert.notStrictEqual(e.post({ action: a }).error, 'unknown_action', a));
});

console.log(`\n✅ ${n} 項通過`);
