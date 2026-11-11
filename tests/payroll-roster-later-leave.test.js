/* 2026-11-11 第二輪複查：①已停用、離職日在「之後的月份」的人，較早月份重算不可整列消失；
 * ②事假、天災假（給薪 0）2026-11 起的金額照現行逐段算（只改半薪假的取整）。全部虛構同仁。 */
const H = require('./helpers/payroll-vm.js');
const S = H.load({ today: '2026-11-20' });
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };
const inR = (m, ym) => S.call('payInRosterYm_', m, ym);
const E = { emp_id: 'E20', active: 'false', leave_date: '2026-11-15' };
chk('11/15 離職、已停用：10 月還在名單', inR(E, '2026-10'), true);
chk('11/15 離職、已停用：11 月在名單', inR(E, '2026-11'), true);
chk('11/15 離職、已停用：12 月不在名單', inR(E, '2026-12'), false);
chk('已停用、沒填離職日：不在名單', inR({ active: 'false', leave_date: '' }, '2026-10'), false);
chk('在職：在名單', inR({ active: 'true', leave_date: '' }, '2026-10'), true);
const e = H.ftEmp({ base: 30000, skill_allow: 0, night_allow: 0, attend_cap: 3000 });   // 扣款時薪 (33000)/240＝137.5→138
const cfg = H.cfg;
const leave = (ym, k, h) => H.item(S.call('payCalcOne', e, ym, H.baseAtt({ hours: 160, [k]: h }), cfg, 10), k.replace('_h', '_leave'));
// 現行（10 月）事假 4.1H：4.1×138＝565.8 → 566；11 月必須相同
chk('事假 4.1H：11 月＝10 月（照現行）', leave('2026-11', 'personal_h', 4.1), leave('2026-10', 'personal_h', 4.1));
chk('天災假 4.1H：11 月＝10 月（照現行）', leave('2026-11', 'disaster_h', 4.1), leave('2026-10', 'disaster_h', 4.1));
const e2 = H.ftEmp({ base: 24600, skill_allow: 0, night_allow: 0, attend_cap: 3000 });   // 27600/240＝115
const lv2 = (ym) => H.item(S.call('payCalcOne', e2, ym, H.baseAtt({ hours: 160, personal_h: 4.1 }), cfg, 10), 'personal_leave');
chk('事假 4.1H×115（浮點 471.4999…）：11 月＝10 月＝471', [lv2('2026-10'), lv2('2026-11')], [471, 471]);
chk('病假 8H 時薪 163（11 月照新規則）：8×163×0.5＝652', H.item(S.call('payCalcOne', H.ftEmp(), '2026-11', H.baseAtt({ hours: 160, sick_h: 8 }), cfg, 10), 'sick_leave'), 652);
console.log(`\n${p} 過、${f} 失敗`); if (f) process.exit(1);
