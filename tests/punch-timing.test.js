// 打卡等待秒數（2026-10-12）：光復 line_punch_timing 收打卡畫面背景送來的秒數，寫 punch_timing 分頁。
// 守：只寫光復、不寫各店；欄位白名單與毫秒範圍；身分驗證與節流；工號從 lineHubMine_ 取、查不到留白不擋。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const STORES = require(ROOT + '/tools/stores.json');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function make(opts) {
  opts = opts || {};
  const sheets = {}, cache = {}, opened = [];
  const sheet = (name) => ({ name, rows: [], getLastColumn: function () { return this.header ? this.header.length : (this.oldCols || 0); }, getRange: function () { const self = this; return { setValues: (v) => { self.header = v[0]; } }; },
                             appendRow: function (r) { this.rows.push(r); } });
  const sb = {
    console, JSON, Math, String, Number, isNaN, isFinite, parseInt, Date,
    LINE_HUB_STORES_CONFIG: STORES.map(s => ({ code: s.code, name: s.name, ss_id: 'SS_' + s.code })),
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    getSS: () => ({ getSheetByName: (nm) => sheets[nm] || null, insertSheet: (nm) => (sheets[nm] = sheet(nm)) }),
    SpreadsheetApp: { openById: (id) => { opened.push(id); throw new Error('不該開各店試算表'); } },
    nowTaipeiIso: () => '2026-10-12T21:30:00+08:00',
    verifyLineIdToken_: (t) => (t === 'GOOD' ? 'U1' : t === 'GOOD2' ? 'U2' : null),
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/LineHub.gs', 'utf8'), sb);
  sb.lineHubMine_ = opts.mine || ((uid) => uid === 'U1' ? [{ st: { code: 'mztjs' }, row: { emp_id: 'MZTJS05', name: '某同仁' } },
                                                         { st: { code: '' }, row: { emp_id: 'E03', name: '某同仁' } }] : []);
  return { sb, sheets, opened, call: (b) => sb.handleLinePunchTiming_(Object.assign({ id_token: 'GOOD', store: 'mztjs', type: 'out', outcome: 'ok', status: 'ok',
                                                                                   total_ms: 2345.6, geo_ms: 0, server_ms: 2100, refix: false, qr: false, accuracy_m: 12.4 }, b)) };
}

ok('已掛進 LINE_HUB_HANDLERS', () => {
  const t = make(); assert.strictEqual(typeof t.sb.LINE_HUB_HANDLERS.line_punch_timing, 'function');
});
ok('成功：寫光復 punch_timing 一列（第一次自動建分頁＋表頭）、工號取那家店的', () => {
  const t = make(); const r = t.call({});
  assert.strictEqual(JSON.stringify(r), JSON.stringify({ ok: true }));
  const sh = t.sheets.punch_timing;
  assert.strictEqual(JSON.stringify(sh.header), JSON.stringify(['ts', 'store', 'emp_id', 'type', 'outcome', 'status', 'total_ms', 'geo_ms', 'server_ms', 'refix', 'qr', 'accuracy_m', 'srv_verify_ms', 'srv_roster_ms', 'srv_read_ms', 'srv_write_ms', 'srv_extra_ms']));
  assert.strictEqual(JSON.stringify(sh.rows[0]), JSON.stringify(['2026-10-12T21:30:00+08:00', 'mztjs', 'MZTJS05', 'out', 'ok', 'ok', 2346, 0, 2100, false, false, 12, '', '', '', '', '']));
  assert.deepStrictEqual(t.opened, []);   // 沒有開任何一家店的試算表
});
ok('後端各步驟毫秒數記在最後五欄（不合理的留白）', () => {
  const t = make(); t.call({ steps: { verify: 150.4, roster: 320, read: 210, write: 1800, extra: -3 } });
  assert.strictEqual(JSON.stringify(t.sheets.punch_timing.rows[0].slice(12)), JSON.stringify([150, 320, 210, 1800, '']));
});
ok('舊分頁只有 12 欄 → 補齊表頭到 17 欄', () => {
  const t = make(); const old = t.sb.getSS().insertSheet('punch_timing'); old.oldCols = 12;
  t.call({}); assert.strictEqual(old.header.length, 17);
});
ok('光復店代碼是空字串也收、工號取光復那筆', () => {
  const t = make(); t.call({ store: '' }); assert.strictEqual(t.sheets.punch_timing.rows[0][2], 'E03');
});
ok('身分驗不過 → invalid_id_token、不寫', () => {
  const t = make(); assert.strictEqual(t.call({ id_token: 'BAD' }).error, 'invalid_id_token'); assert.ok(!t.sheets.punch_timing);
});
ok('不認識的店、不在白名單的結果 → 擋下不寫', () => {
  const t = make();
  assert.strictEqual(t.call({ store: 'xx' }).error, 'bad_store');
  assert.strictEqual(t.call({ outcome: '<b>hack' }).error, 'bad_outcome');
  assert.ok(!t.sheets.punch_timing);
});
ok('毫秒超出 0～10 分鐘或不是數字 → 留白；狀態碼不合格式 → 留白；type 只收 in／out', () => {
  const t = make(); t.call({ total_ms: -5, geo_ms: 9e9, server_ms: 'abc', status: '=HYPERLINK("x")', type: 'zz', accuracy_m: 'x' });
  const r = t.sheets.punch_timing.rows[0];
  assert.strictEqual(JSON.stringify([r[3], r[5], r[6], r[7], r[8], r[11]]), JSON.stringify(['', '', '', '', '', '']));
});
ok('server_ms 為 null（定位失敗沒送出）→ 留白不當 0', () => {
  const t = make(); t.call({ outcome: 'geo_fail', server_ms: null, refix: true });
  const r = t.sheets.punch_timing.rows[0]; assert.strictEqual(r[8], ''); assert.strictEqual(r[9], true);
});
ok('refix／qr 只有真的 true 才記 true（字串 "true" 不算）', () => {
  const t = make(); t.call({ refix: 'true', qr: 1 }); const r = t.sheets.punch_timing.rows[0]; assert.strictEqual(r[9], false); assert.strictEqual(r[10], false);
});
ok('查工號出錯 → 工號留白，照樣記秒數', () => {
  const t = make({ mine: () => { throw new Error('名冊讀不到'); } }); assert.strictEqual(t.call({}).ok, true);
  assert.strictEqual(t.sheets.punch_timing.rows[0][2], '');
});
ok('同一人一分鐘超過 20 次 → too_many', () => {
  const t = make(); for (let i = 0; i < 20; i++) assert.strictEqual(t.call({}).ok, true);
  assert.strictEqual(t.call({}).error, 'too_many'); assert.strictEqual(t.sheets.punch_timing.rows.length, 20);
  assert.strictEqual(t.call({ id_token: 'GOOD2' }).ok, true);   // 別人不受影響
});
ok('全站一分鐘超過 300 次 → too_many（擋在驗身分之前，不燒 LINE 驗證額度）', () => {
  const t = make(); let calls = 0; const v = t.sb.verifyLineIdToken_; t.sb.verifyLineIdToken_ = (x) => { calls++; return v(x); };
  for (let i = 0; i < 300; i++) t.call({ id_token: 'BAD' });
  assert.strictEqual(t.call({ id_token: 'BAD' }).error, 'too_many'); assert.strictEqual(calls, 300);
});
// 指揮台讀取（punch_timing_get，唯讀、管理金鑰）
function makeGet(rows) {
  const t = make();
  t.sb.checkAdmin = (b) => b.admin_key === 'ADMIN';
  t.sb.normCellTs = (v) => String(v);
  t.sb.readSheetAsObjects = (sh) => ({ rows: sh.objs });
  if (rows) t.sheets.punch_timing = { objs: rows };
  return t;
}
ok('讀取：管理金鑰錯 → unauthorized', () => {
  assert.strictEqual(makeGet([]).sb.handlePunchTimingGet_({ admin_key: 'x', from: '2026-10-12', to: '2026-10-12' }).error, 'unauthorized');
});
ok('讀取：日期格式不對 → bad_range', () => {
  assert.strictEqual(makeGet([]).sb.handlePunchTimingGet_({ admin_key: 'ADMIN', from: '10/12', to: '2026-10-12' }).error, 'bad_range');
});
ok('讀取：還沒有分頁 → 空陣列不報錯', () => {
  const r = makeGet(null).sb.handlePunchTimingGet_({ admin_key: 'ADMIN', from: '2026-10-12', to: '2026-10-12' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.rows.length, 0);
});
ok('讀取：只回日期範圍內（含頭含尾）、只回固定欄位', () => {
  const rows = [{ ts: '2026-10-11T23:59:00+08:00', store: 'hq', total_ms: 1 },
                { ts: '2026-10-12T00:00:01+08:00', store: '', total_ms: 2, name: '不該出現' },
                { ts: '2026-10-13T08:00:00+08:00', store: 'cf', total_ms: 3 },
                { ts: '2026-10-14T08:00:00+08:00', store: 'cf', total_ms: 4 }];
  const r = makeGet(rows).sb.handlePunchTimingGet_({ admin_key: 'ADMIN', from: '2026-10-12', to: '2026-10-13' });
  assert.strictEqual(JSON.stringify(r.rows.map(x => x.total_ms)), '[2,3]');
  assert.ok(!('name' in r.rows[0])); assert.strictEqual(Object.keys(r.rows[0]).length, 17);
});
ok('讀取：已掛進 LINE_HUB_HANDLERS', () => { assert.strictEqual(typeof make().sb.LINE_HUB_HANDLERS.punch_timing_get, 'function'); });
// 前端：結果顯示之後才送、每條結束路徑都有記
const html = fs.readFileSync(ROOT + '/clock-line.html', 'utf8');
ok('前端：成功時先 say(shown) 再送秒數、再代送「打卡」', () => {
  const i = html.indexOf("render(status); say(shown, 'ok');"), j = html.indexOf("tmReport('ok', 'ok')"), k = html.indexOf('return sendToChat(!!(r.missed_date');
  assert.ok(i > 0 && j > i && k > j);
});
ok('前端：用 sendBeacon 背景送、打光復 HUB_API、出錯一律吞掉', () => {
  const f = html.slice(html.indexOf('function tmReport('), html.indexOf('/* ── 打卡 ── */'));
  assert.ok(/navigator\.sendBeacon\(HUB_API/.test(f) && /keepalive: true/.test(f) && /catch \(e\)/.test(f));
});
ok('前端：七種結果都有記錄點', () => {
  ['ok', 'fail', 'error', 'geo_fail', 'unclear_ok', 'unclear_not', 'unclear_unknown'].forEach(o => assert.ok(html.indexOf("tmReport('" + o + "'") > 0, o));
});
console.log('\n✅ 打卡等待秒數 ' + n + ' 項通過');
