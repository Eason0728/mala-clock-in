/* 出勤紀錄匯出（payroll.html）前端：從真檔的 ATTX-PURE 區抽出純函式實跑。
 * 涵蓋：跨夜(+1)、忘刷卡字樣、未入帳的卡標註、整天請假(核定 0 要顯示 0 不是空白)、
 * 待核定字樣、工作表名稱過濾與去重、畫面渲染的自由文字一律 esc()。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const H = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const a = H.indexOf('/* ATTX-PURE-BEGIN */'), b = H.indexOf('/* ATTX-PURE-END */');
if (a < 0 || b < 0) throw new Error('找不到 ATTX-PURE 區');
const sb = {}; vm.createContext(sb); vm.runInContext(H.slice(a, b), sb);

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`); };

chk('一般段', sb.attSegText({ in: '08:00', out: '17:03', cross: false }), '08:00–17:03');
chk('跨夜段標 (+1)', sb.attSegText({ in: '22:00', out: '06:05', cross: true }), '22:00–06:05(+1)');
chk('只有上班卡', sb.attSegText({ in: '09:00', out: null, cross: false }), '09:00–（未打下班卡）');
chk('只有下班卡', sb.attSegText({ in: null, out: '18:00', cross: false }), '（未打上班卡）–18:00');
chk('未入帳的卡文字', sb.attInvalidText({ time: '08:10', type: 'in', label: '超出範圍，未入帳' }), '08:10 上班（超出範圍，未入帳）');

const base = { date: '2026-09-03', weekday: '四', segments: [], invalid: [], approved: false, periods: '', approved_hours: null, status_text: '', leave: [] };
chk('空白日：各欄皆空', sb.attDayCells(base), { date: '2026-09-03', weekday: '四', punch: '', invalid: '', periods: '', hours: '', leave: '', status: '' });
chk('整天請假：核定 0 顯示 0（不是空白）＋假別時數',
  (c => [c.hours, c.leave, c.status])(sb.attDayCells(Object.assign({}, base, { approved: true, approved_hours: 0, status_text: '全天請假', leave: [{ type: '病假', hours: 8 }] }))), [0, '病假 8H', '全天請假']);
chk('有打卡沒核定 → 待主管核定', sb.attDayCells(Object.assign({}, base, { segments: [{ in: '08:00', out: '17:00', cross: false }] })).status, '待主管核定');
chk('兩段 → 換行分隔', sb.attDayCells(Object.assign({}, base, { segments: [{ in: '08:30', out: '12:00', cross: false }, { in: '13:00', out: '17:30', cross: false }] })).punch, '08:30–12:00\n13:00–17:30');
chk('核定時段（畫面）換行分隔', sb.attPeriodsText({ periods: '08:30-12:00,13:00-17:30' }), '08:30-12:00\n13:00-17:30');
chk('核定時段（Excel）用「、」', sb.attPeriodsText({ periods: '08:30-12:00,13:00-17:30' }, '、'), '08:30-12:00、13:00-17:30');
chk('Excel 版整天格：兩段打卡用「、」不含換行', sb.attDayCells(Object.assign({}, base, { segments: [{ in: '08:30', out: '12:00', cross: false }, { in: '13:00', out: '17:30', cross: false }] }), '、').punch, '08:30–12:00、13:00–17:30');
chk('請假無時數', sb.attLeaveText({ leave: [{ type: '事假', hours: null }] }), '事假');

const used = {};
chk('工作表名稱去掉非法字元', sb.attSheetName({ emp_id: 'E1', name: 'a/b:c' }, used), 'E1 a_b_c');
chk('同名工作表去重', sb.attSheetName({ emp_id: 'E1', name: 'a/b:c' }, used), 'E1 a_b_c_2');
chk('工作表名稱 ≤31 字', sb.attSheetName({ emp_id: 'E2', name: 'x'.repeat(50) }, {}).length <= 31, true);

// 渲染層：自由文字（姓名、假別、狀態）一律 esc()
const render = H.slice(H.indexOf('function attSheetHtml'), H.indexOf('function renderAttExp'));
chk('attSheetHtml 內自由文字皆過 esc()', /esc\(e\.name\)/.test(render) && /esc\(c\.status\)/.test(render) && /esc\(c\.leave\)/.test(render) && /esc\(d\.store_name\)/.test(render), true);
const sb2 = { esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  ATTX: { data: { store_name: '<b>店</b>', ym: '2026-09', generated_at: '2026-10-09T10:00:00+08:00' } } };
vm.createContext(sb2); vm.runInContext(H.slice(a, b) + render, sb2);
const html = sb2.attSheetHtml({ name: '<img src=x onerror=1>', emp_id: 'E1', active: true,
  totals: { approved_hours: 1, leave_hours: 0, work_days: 1, pending_days: 0 },
  days: [Object.assign({}, base, { status_text: '<script>x</script>', leave: [{ type: '"><svg onload=1>', hours: 1 }] })] });
chk('酬載姓名／狀態／假別／門市名全被轉義', /<img|<script|<svg|<b>店/.test(html), false);
chk('轉義後仍看得到文字', html.includes('&lt;img src=x onerror=1&gt;'), true);
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通過／${fail} 失敗`); process.exit(fail ? 1 : 0);
