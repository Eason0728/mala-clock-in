/**
 * 薪酬挑錯第 13 項：到職日／離職日格式防呆（Eason 2026-11-11 確認）。
 *  規則：handlePayrollMasterSet 的 hire_date、leave_date 只收「空白」或「YYYY-MM-DD 而且是真實存在的日期」。
 *        有任何一列不合 → 整批不存，回 {ok:false,error:'bad_date',message:…}（比照 bad_emp_id）。
 *        試算表把純日期轉成的 Date 物件，先正規化成 YYYY-MM-DD 再檢查，存進去的也是正規化後的字串。
 *  為什麼要擋：payRatio 遇到 '2026/10/12'、'115/10/12' 這種寫法認不得，會當成整月在職、發整月薪水。
 *  全部虛構同仁（代號 E01～E03），期望值照規則寫死。
 */
'use strict';
const vm = require('vm');
const { load } = require('./helpers/payroll-vm');

let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + '｜實際 ' + g + '｜規則要 ' + w); }
};
const KEY = 'test-admin-key', ST = 'SSLGF';
const OLD = [{ emp_id: 'E01', name: '測試甲', store: ST, active: 'true', hire_date: '2021-01-01', leave_date: '' }];
function env() {
  const s = load({ data: { master: OLD.map(r => Object.assign({}, r)), input: [] } });
  vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};`, s);
  return s;
}
const row = (id, hire, leave) => ({ emp_id: id, name: '測試' + id, store: ST, active: 'true', hire_date: hire, leave_date: leave });
function save(rows) {
  const s = env();
  let r; try { r = s.call('handlePayrollMasterSet', { admin_key: KEY, store: ST, master: rows }); } catch (e) { r = { threw: String(e.message) }; }
  r = JSON.parse(JSON.stringify(r));
  const stored = s.__DATA.master.map(m => [String(m.emp_id), m.hire_date, m.leave_date]);
  return { r, stored, s };
}
const OLD_STORED = [['E01', '2021-01-01', '']];
const MSG = '到職日、離職日只能留空，或填 YYYY-MM-DD 而且是真實存在的日期（例：2026-10-12），這次沒有儲存：';

/* ══ 一、合格的照存 ══ */
{
  const a = save([row('E01', '2026-10-12', ''), row('E02', '', ''), row('E03', '2024-02-29', '2026-10-31')]);
  eq([a.r.ok, a.r.count], [true, 3], 'A1 YYYY-MM-DD、空白、閏年 2/29 都合格：存 3 列');
  eq(a.stored, [['E01', '2026-10-12', ''], ['E02', '', ''], ['E03', '2024-02-29', '2026-10-31']], 'A1 存進去的日期原樣');
  // 沒有這兩個欄位（null／undefined）＝空白
  const b = save([{ emp_id: 'E02', name: '測試乙', store: ST, active: 'true' }, row('E03', null, undefined)]);
  eq(b.r.ok, true, 'A2 沒帶欄位、null、undefined 都算空白：可存');
  // 頭尾空白：去掉空白後合格，存去掉空白的值
  const c = save([row('E02', ' 2026-10-12 ', '2026-10-31 ')]);
  eq([c.r.ok, c.stored], [true, [['E02', '2026-10-12', '2026-10-31']]], 'A3 頭尾有空白：去掉空白後合格，存 2026-10-12／2026-10-31');
  // 只有空白字元＝空白
  const d = save([row('E02', '   ', '')]);
  eq([d.r.ok, d.stored], [true, [['E02', '', '']]], 'A4 只有空白字元＝空白：可存，存成空字串');
}

/* ══ 二、試算表轉成的 Date 物件：先正規化再檢查 ══ */
{
  const s0 = env();
  const D = s0.VmDate;
  const rows = [row('E02', new D(2026, 9, 12), new D(2026, 9, 31))];   // 2026-10-12、2026-10-31
  let r; try { r = s0.call('handlePayrollMasterSet', { admin_key: KEY, store: ST, master: rows }); } catch (e) { r = { threw: String(e.message) }; }
  eq(JSON.parse(JSON.stringify(r)).ok, true, 'B1 Date 物件（2026-10-12）正規化後合格：可存');
  eq(s0.__DATA.master.map(m => [m.emp_id, m.hire_date, m.leave_date]), [['E02', '2026-10-12', '2026-10-31']], 'B1 存進去的是字串 2026-10-12／2026-10-31');
  // 壞掉的 Date 物件
  const s1 = env();
  let r1; try { r1 = s1.call('handlePayrollMasterSet', { admin_key: KEY, store: ST, master: [row('E02', new s1.VmDate('x'), '')] }); } catch (e) { r1 = { threw: String(e.message) }; }
  r1 = JSON.parse(JSON.stringify(r1));
  eq([r1.ok, r1.error], [false, 'bad_date'], 'B2 壞掉的 Date 物件（Invalid Date）→ bad_date');
  eq(s1.__DATA.master.map(m => [m.emp_id, m.hire_date, m.leave_date]), OLD_STORED, 'B2 主檔沒有被改');
}

/* ══ 三、不合格 → 整批不存 ══ */
const BAD = [
  ['斜線 2026/10/12', '2026/10/12'], ['民國 115/10/12', '115/10/12'], ['少一位 2026-10-1', '2026-10-1'], ['沒有連字號 20261012', '20261012'],
  ['不存在的 2026-02-30', '2026-02-30'], ['非閏年 2026-02-29', '2026-02-29'], ['13 月 2026-13-01', '2026-13-01'], ['0 月 2026-00-10', '2026-00-10'],
  ['0 日 2026-10-00', '2026-10-00'], ['4 月 31 日 2026-04-31', '2026-04-31'], ['帶時間 2026-10-12T00:00:00', '2026-10-12T00:00:00'],
  ['文字 abc', 'abc'], ['數字 20261012', 20261012], ['數字 0', 0],
];
BAD.forEach(([nm, v]) => {
  const h = save([row('E01', '2021-01-01', ''), row('E02', v, '')]);
  eq([h.r.ok, h.r.error, h.r.message], [false, 'bad_date', MSG + 'E02 到職日'], `C1 到職日＝${nm} → bad_date，訊息指出 E02 到職日`);
  eq(h.stored, OLD_STORED, `C1 到職日＝${nm}：整批不存，主檔維持原樣`);
  const l = save([row('E02', '2021-01-01', v), row('E03', '2022-03-01', '')]);
  eq([l.r.ok, l.r.error, l.r.message], [false, 'bad_date', MSG + 'E02 離職日'], `C2 離職日＝${nm} → bad_date，訊息指出 E02 離職日`);
  eq(l.stored, OLD_STORED, `C2 離職日＝${nm}：整批不存，主檔維持原樣`);
});
{
  // 多列多欄不合格：全部列出來，照送來的順序
  const m = save([row('E01', '2026/1/1', '115/10/12'), row('E02', '2026-10-12', ''), row('E03', '', '2026-02-30')]);
  eq([m.r.ok, m.r.error, m.r.message], [false, 'bad_date', MSG + 'E01 到職日、E01 離職日、E03 離職日'], 'C3 三格不合格：訊息列出 E01 到職日、E01 離職日、E03 離職日');
  eq(m.stored, OLD_STORED, 'C3 整批不存');
  // 訊息不帶使用者填的內容（避免把標籤、引號原樣回給畫面）
  const x = save([row('E02', '<img src=x onerror=1>', '')]);
  eq([x.r.error, /[<>"']/.test(String(x.r.message))], ['bad_date', false], 'C4 訊息裡沒有使用者填的原文');
}

/* ══ 四、原有的檢查順序不變 ══ */
{
  const s = env();
  const r = JSON.parse(JSON.stringify(s.call('handlePayrollMasterSet', { admin_key: 'wrong', store: ST, master: [row('E02', '2026/10/12', '')] })));
  eq(r.error, 'unauthorized', 'D1 沒有管理金鑰：先回 unauthorized');
  const b = save([row('a b', '2026/10/12', '')]);
  eq(b.r.error, 'bad_emp_id', 'D2 員工編號不合格：先回 bad_emp_id');
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 全部通過'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
