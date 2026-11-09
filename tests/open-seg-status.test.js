/* 只打一張卡的段落不再誤判中間休息沒打卡（2026-11-10）。
 * 用 Code.gs 真函式跑：核定狀態、payMissingCards、同仁忘刷次數的口徑。 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const payroll = fs.readFileSync(path.join(__dirname, '../apps-script/Payroll.gs'), 'utf8');
const pick = (src, name) => { const s = src.indexOf('function ' + name + '('); if (s < 0) throw new Error(name); const e = src.indexOf('\n}\n', s); return src.slice(s, e + 3); };
const constOf = n => code.match(new RegExp('^const ' + n + ' = .*$', 'm'))[0];
const sb = {};
vm.createContext(sb);
vm.runInContext([constOf('LONE_CARD_NEAR_MS'), constOf('NO_PUNCH_NOTE'), constOf('NOT_RECORDED_NOTE'), constOf('TRIP_NOTE'), constOf('SEG_MISS_OUT'), constOf('SEG_MISS_IN'),
  constOf('MISSING_GROUP_PREFIX'), constOf('SEG_NUM_ZH'), code.match(/^function segMissNote.*$/m)[0],
  'function gapExplainedByBreak(a,b,w){return !!w&&a<w.endMs&&b>w.startMs;}',
  pick(code, 'loneCardsForPeriods_'), pick(code, 'computeApprovalStatus'), pick(payroll, 'payMissingCards'),
  'var __c=computeApprovalStatus,__m=payMissingCards;'].join('\n'), sb);

const ms = hm => { const [h, m] = hm.split(':').map(Number); return (h * 60 + m) * 60000; };
const per = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const seg = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got=' + JSON.stringify(got))); };
const P = [per('10:00', '14:00'), per('16:00', '20:30')];

chk('截圖情境：只漏最後下班卡 → 只標下班忘刷卡', sb.__c(P, [seg('09:56', '14:03'), seg('15:58', null)], false, false, null), '下班忘刷卡');
chk('這天不再多算兩張卡', sb.__m(sb.__c(P, [seg('09:56', '14:03'), seg('15:58', null)], false, false, null)), 0);
chk('下班卡有打 → 正常', sb.__c(P, [seg('09:56', '14:03'), seg('15:58', '20:31')], false, false, null), '正常');
chk('只漏第二段上班卡 → 只標上班忘刷卡', sb.__c(P, [seg('09:56', '14:03'), seg(null, '20:31')], false, false, null), '上班忘刷卡');
chk('一段班只打上班卡 → 下班忘刷卡', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], false, false, null), '下班忘刷卡');
chk('第二段完全沒卡 → 維持原本標示', sb.__c(P, [seg('09:56', '14:03')], false, false, null), '該段無打卡、第一段下班無打卡、第二段上班無打卡');
chk('只有一張上班卡對兩段 → 維持原本標示', sb.__c(P, [seg('10:00', null)], false, false, null), '該段無打卡、第一段下班無打卡、第二段上班無打卡');
chk('整天沒卡 → 維持原本標示', sb.__c([per('10:00', '18:00')], [], false, false, null), '該段無打卡');
chk('單張卡離時段超過 4 小時 → 不採用', sb.__c([per('16:00', '20:00')], [seg('09:00', null)], false, false, null), '該段無打卡');
chk('單張卡歸給最近的時段', sb.__c(P, [seg('09:56', null), seg('15:58', null)], false, false, null), '下班忘刷卡');
chk('有未入帳嘗試 → 維持原本字句', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], true, false, null), '打卡未入帳，主管補登');
chk('出差 → 維持出差', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], false, true, null), '出差');
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
