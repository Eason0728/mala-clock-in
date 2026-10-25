// roster.line_ok_at（LINE 打卡成功過的時間）：liff_punch／liff_clock 成功才寫，bind／unbind 清空，寫失敗不影響打卡。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
const SRC = [fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8'),
  extract(codeSrc, 'lastCountedEvent'), extract(codeSrc, 'normShiftTime'), extract(codeSrc, 'todayTaipeiStr'),
  extract(codeSrc, 'setRosterCell')].join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const ISO = '2026-10-25T09:30:00+08:00';
const iso = (minAgo) => new Date(NOW - minAgo * 60000 + 8 * 3600000).toISOString().replace(/\.\d+Z$/, '+08:00');

// 有格子的假工作表（roster 要看得到表頭與格子；events 只提供 rows）
function Grid(data) { this.data = data.map(r => r.slice()); this.formats = {}; this.setCalls = 0; }
Grid.prototype.getLastRow = function () { return this.data.length; };
Grid.prototype.getLastColumn = function () { return this.data.reduce((m, r) => Math.max(m, r.length), 0); };
Grid.prototype.getRange = function (r, c, nr, nc) {
  const g = this; nr = nr || 1; nc = nc || 1;
  return {
    getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (g.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; },
    setValue(v) { g.setCalls++; while (g.data.length < r) g.data.push([]); const row = g.data[r - 1]; while (row.length < c - 1) row.push(''); row[c - 1] = v; },
    setNumberFormat(f) { g.formats[r + ',' + c] = f; return this; },
  };
};
Grid.prototype.objs = function () {
  const h = this.data[0]; return this.data.slice(1).map((row, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = row[j] === undefined ? '' : row[j]; }); return o; });
};
const col = (g, name, row) => { const j = g.data[0].indexOf(name); return j < 0 ? undefined : g.data[row - 1][j]; };

const RH = ['emp_id', 'name', 'key', 'device_id', 'active', 'line_user_id', 'line_bound_at'];
const rosterRows = (withOk) => {
  const h = withOk ? RH.concat('line_ok_at') : RH;
  const mk = (a) => withOk ? a.concat('2026-10-01T08:00:00+08:00') : a;
  return [h, mk(['E1', '甲', 'k1', 'DEV', 'true', 'U1', '2026-10-01T07:00:00+08:00']), mk(['E2', '乙', 'k2', 'DEV2', 'true', 'U2', '2026-10-01T07:00:00+08:00'])];
};

function make(opts) {
  opts = opts || {};
  const roster = new Grid(opts.roster || rosterRows(false));
  const bindLog = [];
  const logSheet = { getRange: () => ({ setValues() {} }), appendRow: (r) => bindLog.push(r) };
  const eventsRows = opts.events || [];
  const ss = { getSheetByName: (nm) => nm === 'roster' ? roster : nm === 'events' ? { rows: eventsRows } : nm === 'liff_bind_log' ? logSheet : null, insertSheet: () => logSheet };
  const cache = {};
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = {
    console, Date: FakeDate, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array,
    CONFIG: { LINE_CHANNEL_ID: '2011292256', ALTERNATION_LOOKBACK_HOURS: 12 },
    UrlFetchApp: { fetch: (url, o) => { const t = o.payload.id_token; const good = String(t).indexOf('TOK_') === 0;
      return { getResponseCode: () => good ? 200 : 400, getContentText: () => JSON.stringify(good ? { sub: t.slice(4), aud: '2011292256' } : {}) }; } },
    CacheService: { getScriptCache: () => ({ put: (k, v) => { cache[k] = v; }, get: (k) => cache[k] || null, remove: (k) => { delete cache[k]; } }) },
    getSS: () => ss,
    readSheetAsObjects: (sh) => sh === roster ? { rows: roster.objs() } : { rows: sh.rows.map((r, i) => Object.assign({ __rowIndex: i + 2 }, r)) },
    ensureRosterHeaders: () => {},
    normCellTs: (v) => v,
    nowTaipeiIso: () => ISO,
    handleClock: (b) => opts.clockReply ? opts.clockReply(b) : { ok: true, status: 'ok', ts: iso(0) },
    checkAdmin: () => true,
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, computeDigest: (a, t) => [...require('crypto').createHash('md5').update(t).digest()], base64Encode: (b) => Buffer.from(b).toString('base64'),
      formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19) + '+08:00'; } },
  };
  if (opts.mgr) { sb.liffMgr_ = () => ({ name: '主管' }); sb.actingName_ = () => '主管'; }
  vm.createContext(sb); vm.runInContext(SRC, sb);
  if (opts.mgr) { vm.runInContext("liffMgr_ = function(){return {name:'主管'};}; actingName_ = function(){return '主管';};", sb); }
  return { sb, roster, H: sb.LIFF_HANDLERS, bindLog };
}
const J = (x) => JSON.parse(JSON.stringify(x));
const punch = (H, type) => J(H.liff_punch({ id_token: 'TOK_U1', type: type || 'in', lat: 1, lng: 2, accuracy: 5 }));
const clock = (H, type) => J(H.liff_clock({ id_token: 'TOK_U1', type: type || 'in', lat: 1, lng: 2, accuracy: 5 }));

ok('liff_punch 成功：缺 line_ok_at 欄時自動補在表頭尾端並寫入該員工那一列（文字格式）', () => {
  const { H, roster } = make();
  const r = punch(H);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(roster.data[0][roster.data[0].length - 1], 'line_ok_at');
  assert.strictEqual(col(roster, 'line_ok_at', 2), ISO);
  assert.strictEqual(col(roster, 'line_ok_at', 3) || '', '', '別人那列不動');
  assert.strictEqual(roster.formats['2,' + roster.data[0].length], '@');
});
ok('liff_punch 成功：已有 line_ok_at 欄就覆蓋該格，不重複補欄', () => {
  const { H, roster } = make({ roster: rosterRows(true) });
  punch(H);
  assert.strictEqual(roster.data[0].filter(h => h === 'line_ok_at').length, 1);
  assert.strictEqual(col(roster, 'line_ok_at', 2), ISO);
  assert.strictEqual(col(roster, 'line_ok_at', 3), '2026-10-01T08:00:00+08:00');
});
ok('liff_clock（光復 line_quick_clock 伺服器對伺服器）成功也寫', () => {
  const { H, roster } = make();
  const r = clock(H);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(col(roster, 'line_ok_at', 2), ISO);
});
ok('被擋（rejected_*／pending_device_approval）：兩條路都不寫、不補欄', () => {
  ['rejected_out_of_range', 'rejected_duplicate', 'pending_device_approval'].forEach((st) => {
    const a = make({ clockReply: () => ({ ok: true, status: st, ts: iso(0) }) });
    punch(a.H); assert.strictEqual(a.roster.data[0].indexOf('line_ok_at'), -1, 'punch ' + st);
    const b = make({ clockReply: () => ({ ok: true, status: st, ts: iso(0) }) });
    clock(b.H); assert.strictEqual(b.roster.data[0].indexOf('line_ok_at'), -1, 'clock ' + st);
  });
  const c = make({ roster: rosterRows(true), clockReply: () => ({ ok: false, error: 'bad' }) });
  clock(c.H); punch(c.H);
  assert.strictEqual(col(c.roster, 'line_ok_at', 2), '2026-10-01T08:00:00+08:00');
});
ok('guard 擋下（上一張是上班又打上班）：不寫', () => {
  const { H, roster } = make({ events: [{ emp_id: 'E1', ts: iso(3), type: 'in', status: 'ok' }] });
  const r = punch(H, 'in');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(roster.data[0].indexOf('line_ok_at'), -1);
  const r2 = clock(H, 'in');
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(roster.data[0].indexOf('line_ok_at'), -1);
});
ok('liff_bind 新綁定：清空 line_ok_at；同一 LINE 重複綁定（already）不清', () => {
  const rows = rosterRows(true); rows[2][5] = ''; rows[2][6] = '';   // E2 未綁
  const { H, roster } = make({ roster: rows });
  const r = J(H.liff_bind({ id_token: 'TOK_U2new', key: 'k2' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(col(roster, 'line_user_id', 3), 'U2new');
  assert.strictEqual(col(roster, 'line_ok_at', 3), '');
  // E1 已綁 U1，同一人再綁 → already，line_ok_at 保留
  const r2 = J(H.liff_bind({ id_token: 'TOK_U1', key: 'k1' }));
  assert.strictEqual(r2.already, true);
  assert.strictEqual(col(roster, 'line_ok_at', 2), '2026-10-01T08:00:00+08:00');
});
ok('mgr_line_unbind：清空 line_user_id／line_bound_at／line_ok_at', () => {
  const { H, roster } = make({ roster: rosterRows(true), mgr: true });
  const r = J(H.mgr_line_unbind({ mgr_key: 'x', emp_id: 'E1' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(col(roster, 'line_user_id', 2), '');
  assert.strictEqual(col(roster, 'line_bound_at', 2), '');
  assert.strictEqual(col(roster, 'line_ok_at', 2), '');
  assert.strictEqual(col(roster, 'line_ok_at', 3), '2026-10-01T08:00:00+08:00', '別人不動');
});
ok('mgr_line_unbind／bind 在沒有 line_ok_at 欄的舊表也不報錯、不補欄', () => {
  const { H, roster } = make({ mgr: true });
  assert.strictEqual(J(H.mgr_line_unbind({ mgr_key: 'x', emp_id: 'E1' })).ok, true);
  assert.strictEqual(roster.data[0].indexOf('line_ok_at'), -1);
});
ok('helper 丟錯（寫入爆炸）：liff_punch／liff_clock 照常回成功', () => {
  ['punch', 'clock'].forEach((which) => {
    const { H, roster } = make({ roster: rosterRows(true) });
    roster.getRange = function (r, c) { if (r >= 2) throw new Error('試算表寫入失敗'); return Grid.prototype.getRange.apply(this, arguments); };
    const r = which === 'punch' ? punch(H) : clock(H);
    assert.strictEqual(r.ok, true, which);
    if (which === 'punch') assert.strictEqual(r.type, 'in');
  });
  // 直接呼叫 helper：回 false 不 throw
  const m = make(); m.roster.getRange = () => { throw new Error('boom'); };
  assert.strictEqual(m.sb.liffMarkLineOk_({ getSheetByName: () => m.roster }, 'E1'), false);
});
ok('helper 沒給 rowIndex：依 emp_id 找列；找不到回 false 且不寫', () => {
  const { sb, roster } = make({ roster: rosterRows(true) });
  const ss = { getSheetByName: () => roster };
  assert.strictEqual(sb.liffMarkLineOk_(ss, 'E2'), true);
  assert.strictEqual(col(roster, 'line_ok_at', 3), ISO);
  const before = roster.setCalls;
  assert.strictEqual(sb.liffMarkLineOk_(ss, 'NOPE'), false);
  assert.strictEqual(roster.setCalls, before);
});
ok('成功打卡只多寫一格（不拖慢）：已有欄時 setValue 只 1 次', () => {
  const { H, roster } = make({ roster: rosterRows(true) });
  punch(H);
  assert.strictEqual(roster.setCalls, 1);
});
console.log('\nline-ok-at: ' + n + ' 項通過');
