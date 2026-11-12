/**
 * 薪酬挑錯第 13 項補洞：主檔日期在試算表是 Date 物件時，讀出來再原樣存回去會被 bad_date 擋下。
 *  現況：試算表把純日期存成 Date 物件；payroll_master_get／payroll_month 回給前端時 JSON 會把它變成
 *        "2023-07-02T16:00:00.000Z"（台北 2023-07-03 00:00 的 UTC 寫法）。前端原樣送回，第 13 項的檢查只收
 *        YYYY-MM-DD，整家店的主檔存不進去。
 *  規則（2026-11-11 補洞）：存檔時，「Date 物件」與「JSON 的 ISO 時間字串（YYYY-MM-DDTHH:MM:SS(.sss)Z）」
 *        先換成台北時區（UTC+8）的 YYYY-MM-DD 再檢查，存進去的是換算後的字串。
 *        斜線、民國年、沒有時區的時間字串、不存在的日期等其他寫法照舊擋（bad_date、整批不存）。
 *  時區：這支把行程時區設成洛杉磯，證明換算不靠機器時區。
 *  全部虛構同仁（代號 E01～E03），期望值照規則手算寫死。
 */
'use strict';
process.env.TZ = 'America/Los_Angeles';   // ⚠ 要在任何 Date 使用之前
const vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const row = (id, hire, leave) => ({ emp_id: id, name: '測試' + id, store: ST, active: 'true', hire_date: hire, leave_date: leave });
function env(master) {
  const s = load({ data: { master: master, input: [] } });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  return s;
}
const OLD = () => [row('E01', '2021-01-01', '')];
const OLD_STORED = [['E01', '2021-01-01', '']];
const stored = s => s.__DATA.master.map(m => [String(m.emp_id), m.hire_date, m.leave_date]);
function save(rows, s) {
  s = s || env(OLD());
  let r; try { r = s.call('handlePayrollMasterSet', { admin_key: KEY, store: ST, master: rows }); } catch (e) { r = { threw: String(e.message) }; }
  return { r: JSON.parse(JSON.stringify(r)), stored: stored(s) };
}
const MSG = '到職日、離職日只能留空，或填 YYYY-MM-DD 而且是真實存在的日期（例：2026-10-12），這次沒有儲存：';

/* ══ 一、整條路：試算表是 Date 物件 → 讀出來（JSON）→ 原樣存回去 ══ */
{
  const s0 = load({ data: {} });
  const D = s0.VmDate;
  // 台北 2023-07-03 00:00 ＝ UTC 2023-07-02 16:00；台北 2026-10-31 00:00 ＝ UTC 2026-10-30 16:00
  const s = env([{ emp_id: 'E01', name: '測試E01', store: ST, active: 'true', hire_date: new D(Date.UTC(2023, 6, 2, 16)), leave_date: new D(Date.UTC(2026, 9, 30, 16)) },
                 row('E02', '2024-03-01', '')]);
  const got = JSON.parse(JSON.stringify(s.call('handlePayrollMasterGet', { admin_key: KEY, store: ST })));
  eq(got.master.map(m => [m.emp_id, m.hire_date, m.leave_date]),
    [['E01', '2023-07-02T16:00:00.000Z', '2026-10-30T16:00:00.000Z'], ['E02', '2024-03-01', '']],
    'A0 前提：payroll_master_get 經 JSON 後，Date 物件變成 ISO 時間字串');
  const a = save(got.master, s);
  eq([a.r.ok, a.r.count, a.r.error || ''], [true, 2, ''], 'A1 讀出來的主檔原樣存回去：可存（不是 bad_date）');
  eq(a.stored, [['E01', '2023-07-03', '2026-10-31'], ['E02', '2024-03-01', '']], 'A1 存進去的是台北日期 2023-07-03／2026-10-31');
}

/* ══ 二、ISO 時間字串：換成台北日期 ══ */
[
  ['2023-07-02T16:00:00.000Z', '2023-07-03', '台北 07-03 00:00'],
  ['2023-07-02T16:00:00Z', '2023-07-03', '沒有毫秒'],
  ['2023-07-02T15:59:59.999Z', '2023-07-02', '台北 07-02 23:59:59.999（差 1 毫秒不跨日）'],
  ['2023-07-03T00:00:00.000Z', '2023-07-03', '台北 07-03 08:00'],
  ['2023-12-31T16:00:00.000Z', '2024-01-01', '跨年'],
  ['2024-02-28T16:00:00.000Z', '2024-02-29', '閏年 2/29'],
  [' 2023-07-02T16:00:00.000Z ', '2023-07-03', '頭尾有空白'],
].forEach(([v, want, nm]) => {
  const h = save([row('E02', v, '')]);
  eq([h.r.ok, h.stored], [true, [['E02', want, '']]], `B1 到職日＝${v.trim()}（${nm}）→ 存 ${want}`);
  const l = save([row('E02', '2021-01-01', v)]);
  eq([l.r.ok, l.stored], [true, [['E02', '2021-01-01', want]]], `B2 離職日＝${v.trim()}（${nm}）→ 存 ${want}`);
});

/* ══ 三、Date 物件：換成台北日期，不靠機器時區 ══ */
{
  const s = env(OLD());
  const D = s.VmDate;
  const a = save([row('E02', new D(Date.UTC(2023, 6, 2, 16)), new D(Date.UTC(2026, 9, 30, 16)))], s);
  eq([a.r.ok, a.stored], [true, [['E02', '2023-07-03', '2026-10-31']]], 'C1 Date 物件（UTC 07-02 16:00／10-30 16:00）→ 存 2023-07-03／2026-10-31（機器時區是洛杉磯也一樣）');
  const s1 = env(OLD());
  const b = save([row('E02', new s1.VmDate('x'), '')], s1);
  eq([b.r.ok, b.r.error, b.stored], [false, 'bad_date', OLD_STORED], 'C2 壞掉的 Date 物件 → bad_date、主檔沒有被改');
}

/* ══ 四、其他寫法照舊擋 ══ */
[
  ['斜線 2026/10/12', '2026/10/12'], ['民國 115/10/12', '115/10/12'],
  ['沒有時區 2026-10-12T00:00:00', '2026-10-12T00:00:00'], ['只到分 2026-10-12T00:00', '2026-10-12T00:00'],
  ['帶位移 2026-10-12T00:00:00+08:00', '2026-10-12T00:00:00+08:00'],
  ['不存在的日期 2026-02-30T16:00:00.000Z', '2026-02-30T16:00:00.000Z'], ['13 月 2026-13-01T16:00:00.000Z', '2026-13-01T16:00:00.000Z'],
  ['25 時 2026-10-12T25:00:00.000Z', '2026-10-12T25:00:00.000Z'], ['60 分 2026-10-12T16:60:00.000Z', '2026-10-12T16:60:00.000Z'],
  ['後面多字 2023-07-02T16:00:00.000Zx', '2023-07-02T16:00:00.000Zx'], ['空格分隔 2023-07-02 16:00:00Z', '2023-07-02 16:00:00Z'],
].forEach(([nm, v]) => {
  const h = save([row('E01', '2021-01-01', ''), row('E02', v, '')]);
  eq([h.r.ok, h.r.error, h.r.message, h.stored], [false, 'bad_date', MSG + 'E02 到職日', OLD_STORED], `D1 到職日＝${nm} → bad_date，整批不存`);
});
{
  // 一格 ISO 合格、另一格斜線不合格 → 整批不存，ISO 那格也不會被換成新值存進去
  const m = save([row('E01', '2023-07-02T16:00:00.000Z', ''), row('E02', '2026/10/12', '')]);
  eq([m.r.ok, m.r.error, m.r.message, m.stored], [false, 'bad_date', MSG + 'E02 到職日', OLD_STORED], 'D2 一格 ISO 合格＋一格斜線：整批不存');
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
