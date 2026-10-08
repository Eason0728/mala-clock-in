// 值班主管看 LINE 綁定紀錄、解除綁定（Liff.gs mgr_line_binds／mgr_line_unbind）
const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const SRC = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const NOW = Date.parse('2026-10-08T10:00:00+08:00');
function make() {
  const cells = [], log = [];
  const roster = [{ __rowIndex: 2, emp_id: 'E1', name: '甲', line_user_id: 'U1', active: 'true' },
                  { __rowIndex: 3, emp_id: 'E2', name: '乙', line_user_id: '', active: 'true' }];
  const logRows = [{ ts: '2026-10-07T09:00:00+08:00', emp_id: 'E1', name: '甲', line_user_id: 'U1', type: 'bind_name' },
                   { ts: '2026-10-07T09:30:00+08:00', emp_id: 'E2', name: '乙', line_user_id: 'U2', type: 'bind_name' },
                   { ts: '2026-06-01T09:00:00+08:00', emp_id: 'E9', name: '丁', line_user_id: 'U9', type: 'bind' }];
  const sheets = { managers: [{ name: '主管A', key: 'mk', active: 'true' }], roster, liff_bind_log: logRows };
  class D extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const sb = { console, Date: D, getSS: () => ({ getSheetByName: (n) => sheets[n] ? { n, appendRow: (r) => log.push(r) } : null }),
    readSheetAsObjects: (sh) => ({ rows: sheets[sh.n].map(r => Object.assign({}, r)) }),
    findManagerByKey: (rows, k) => rows.filter(r => r.key === k && r.active === 'true')[0],
    normCellTs: (v) => v, ensureRosterHeaders: () => {}, nowTaipeiIso: () => '2026-10-08T10:00:00+08:00',
    setRosterCell: (sh, row, h, v) => cells.push([row, h, v]) };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  return { sb, cells, log };
}
ok('mgr_line_binds：金鑰錯 → unauthorized', () => assert.strictEqual(make().sb.handleMgrLineBinds_({ mgr_key: 'x' }).error, 'unauthorized'));
ok('mgr_line_binds：只列 30 天內、新的在前、標出是否仍綁著、不回 LINE userId', () => {
  const r = make().sb.handleMgrLineBinds_({ mgr_key: 'mk' });
  assert.deepStrictEqual(Array.from(r.items.map(i => i.emp_id + ':' + i.still_bound)), ['E2:false', 'E1:true']);
  assert(!/U1|U2/.test(JSON.stringify(r)));
});
ok('mgr_line_unbind：清空兩欄並記一筆 unbind_by:主管名；沒綁的回 already', () => {
  const { sb, cells, log } = make();
  assert.strictEqual(sb.handleMgrLineUnbind_({ mgr_key: 'mk', emp_id: 'E1' }).ok, true);
  assert.deepStrictEqual(cells.map(c => c.join('|')), ['2|line_user_id|', '2|line_bound_at|']);
  assert.strictEqual(log[0][4], 'unbind_by:主管A');
  assert.strictEqual(sb.handleMgrLineUnbind_({ mgr_key: 'mk', emp_id: 'E2' }).already, true);
  assert.strictEqual(sb.handleMgrLineUnbind_({ mgr_key: 'bad', emp_id: 'E1' }).error, 'unauthorized');
});
console.log(`\n${n} 項全部通過`);
