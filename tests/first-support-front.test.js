// 值班核定頁：7A「首次支援」標記＋移除鈕（task F2）、4.7「新增同仁」導向管理系統。測試資料一律假名。
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function FakeSheet(headers, rows) { this.data = [headers].concat(rows); }
FakeSheet.prototype.getDataRange = function () { const d = this.data; return { getValues: () => d.map(r => r.slice()) }; };
FakeSheet.prototype.getLastRow = function () { return this.data.length; };
FakeSheet.prototype.getLastColumn = function () { return this.data[0].length; };
FakeSheet.prototype.appendRow = function (row) { this.data.push(row.slice()); };
FakeSheet.prototype.getRange = function (r, c, nr, nc) { const d = this.data; return { getValues: () => d.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)), setNumberFormat() { return this; }, setValue() {} }; };
function env(opts) {
  const SUP = 'LINE 自動（首次支援）';
  const sheets = {
    managers: new FakeSheet(['name', 'key', 'active'], [['測試主管', 'MK', true]]),
    roster: new FakeSheet(['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'shift_in', 'shift_out', 'created_at', 'created_by', 'removed_at', 'removed_by'],
      [['E01', '測試甲', 'k1', '', '', true, '', '', '2026-10-01T09:00:00+08:00', '主管', '', ''],
       ['E02', '測試乙', 'k2', '', '', true, '', '', '2026-10-08T09:00:00+08:00', SUP, '', ''],
       ['E03', '測試丙', 'k3', '', '', true, '', '', '2026-10-07T09:00:00+08:00', SUP, '', ''],
       ['E04', '測試丁', 'k4', '', '', false, '', '', '2026-10-07T09:00:00+08:00', SUP, '2026-10-08', '主管']]),
    events: new FakeSheet(['ts', 'emp_id', 'type', 'status'], []),
    approved: new FakeSheet(['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at'],
      [['2026-10-07', 'E03', '測試丙', '09:00-17:00', 8, '正常', '測試主管', '2026-10-07T18:00:00+08:00']]),
  };
  const props = Object.assign({}, opts && opts.props);
  const ss = { getSheetByName: n => sheets[n] || null };
  const sb = { console, Logger: { log() {} }, Date, Math, JSON, String, Number, Object, Array, isNaN, RegExp, Error,
    SpreadsheetApp: { openById: () => ss, getActive: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { formatDate: (d, tz, f) => { const s = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyy-MM-dd' ? s.slice(0, 10) : s.slice(0, 19) + '+08:00'; } } };
  vm.createContext(sb); vm.runInContext(CODE, sb);
  if (opts && opts.config) vm.runInContext('CONFIG.STAFF_MASTER_ADD_REDIRECT = ' + JSON.stringify(opts.config), sb);
  const call = (fn, b) => JSON.parse(JSON.stringify(vm.runInContext(fn, sb)(b)));
  return { call };
}

ok('mgr_day：LINE 自動加入且從沒有核定紀錄的在職者才帶 first_support；有核定過／一般新增／已離職都不帶', () => {
  const r = env().call('handleMgrDay', { mgr_key: 'MK', date: '2026-10-08' });
  assert.strictEqual(r.ok, true);
  const by = {}; r.employees.forEach(e => (by[e.emp_id] = e));
  assert.strictEqual(by.E02.first_support, true);
  assert.strictEqual(by.E03.first_support, undefined, '已有核定紀錄 → 標記消失');
  assert.strictEqual(by.E01.first_support, undefined);
  assert.strictEqual(by.E04, undefined, '離職者本來就不列');
});
ok('add_redirect：未設＝false；屬性 STAFF_MASTER_ADD_REDIRECT＝1 或 CONFIG＝1 → true；其他值 false（mgr_day／mgr_roster 都帶）', () => {
  const chk = (opts, want) => { const e = env(opts);
    assert.strictEqual(e.call('handleMgrRoster', { mgr_key: 'MK' }).add_redirect, want, JSON.stringify(opts));
    assert.strictEqual(e.call('handleMgrDay', { mgr_key: 'MK' }).add_redirect, want); };
  chk({}, false); chk({ props: { STAFF_MASTER_ADD_REDIRECT: '1' } }, true); chk({ config: '1' }, true);
  chk({ props: { STAFF_MASTER_ADD_REDIRECT: '0' } }, false); chk({ props: { STAFF_MASTER_ADD_REDIRECT: 'true' } }, false);
});
ok('mgr_add_employee 後端沒被動到（導向開著也照舊能新增）', () => {
  const e = env({ props: { STAFF_MASTER_ADD_REDIRECT: '1' } });
  const r = e.call('handleMgrAddEmployee', { mgr_key: 'MK', name: '測試戊' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.emp_id, 'E05');
});

const PAGES = ['manager.html', 'manager-cf.html', 'manager-hq.html', 'manager-mztgf.html', 'manager-mztjs.html', 'manager-mztlzl.html'];
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
ok('六張核定頁：首次支援標記、移除鈕（確認後呼叫 mgr_set_active active:false）都在', () => {
  PAGES.forEach(f => {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const card = extractFn(h, 'buildEmployeeCard');
    assert(/emp\.first_support/.test(card) && card.includes("'首次支援'"), f + ' 標記');
    assert(card.includes('不是本店支援，移除'), f + ' 按鈕');
    const click = card.slice(card.indexOf('rmBtn.addEventListener'));
    assert(/window\.confirm\(/.test(click) && /action: 'mgr_set_active'[^}]*active: false/.test(click), f + ' 二次確認＋設離職');
    assert(click.indexOf('window.confirm(') < click.indexOf('apiPost('), f + ' 先確認再送');
  });
});
ok('applyAddRedirect：on＝說明＋管理系統網址並拿掉建立帳號鈕；off＝完全不動', () => {
  PAGES.forEach(f => {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(/var MGMT_SYSTEM_URL = '/.test(h), f);
    const mk = () => { const el = { innerHTML: '<button id="aeBtn">建立帳號</button>' };
      const sb = { document: { getElementById: id => (id === 'addEmpCard' ? el : null) } };
      vm.createContext(sb); vm.runInContext(h.match(/var MGMT_SYSTEM_URL = [^\n]*/)[0] + '\n' + extractFn(h, 'applyAddRedirect'), sb);
      return { el, fn: sb.applyAddRedirect }; };
    const off = mk(); const before = off.el.innerHTML;
    assert.strictEqual(off.fn(false), false); assert.strictEqual(off.fn(undefined), false); assert.strictEqual(off.el.innerHTML, before);
    const on = mk(); assert.strictEqual(on.fn(true), true);
    assert(on.el.innerHTML.includes('請到管理系統 → 我的資料 → 我的單位 新增，當天就能打卡'), f);
    assert(on.el.innerHTML.includes('https://'), f); assert(!on.el.innerHTML.includes('aeBtn'), f);
  });
  const h = fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
  assert(/applyAddRedirect\(!!res\.add_redirect\)/.test(h), '載入名冊後要套用旗標');
});
console.log(`\n✅ ${n} 項通過`);
