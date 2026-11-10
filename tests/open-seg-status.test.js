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
  constOf('MISSING_GROUP_PREFIX'), constOf('SEG_FORGOT_OUT'), constOf('SEG_FORGOT_IN'), constOf('SEG_NUM_ZH'), code.match(/^function segMissNote.*$/m)[0],
  'function gapExplainedByBreak(a,b,w){return !!w&&a<w.endMs&&b>w.startMs;}',
  pick(code, 'loneCardsForPeriods_'), pick(code, 'breakBlocksFor_'), pick(code, 'computeApprovalStatus'), pick(payroll, 'payMissingCards'),
  'var __c=computeApprovalStatus,__m=payMissingCards;'].join('\n'), sb);

const ms = hm => { const [h, m] = hm.split(':').map(Number); return (h * 60 + m) * 60000; };
const per = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const seg = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
let fail = 0;
const chk = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got=' + JSON.stringify(got))); };
const P = [per('10:00', '14:00'), per('16:00', '20:30')];

chk('截圖情境：只漏最後下班卡 → 第二段下班忘刷卡', sb.__c(P, [seg('09:56', '14:03'), seg('15:58', null)], false, false, null), '第二段下班忘刷卡');
chk('這天不再多算兩張卡', sb.__m(sb.__c(P, [seg('09:56', '14:03'), seg('15:58', null)], false, false, null)), 0);
chk('下班卡有打 → 正常', sb.__c(P, [seg('09:56', '14:03'), seg('15:58', '20:31')], false, false, null), '正常');
chk('只漏第二段上班卡 → 第二段上班忘刷卡', sb.__c(P, [seg('09:56', '14:03'), seg(null, '20:31')], false, false, null), '第二段上班忘刷卡');
chk('一段班只打上班卡 → 下班忘刷卡', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], false, false, null), '下班忘刷卡');
chk('第二段整段沒卡 → 標第二段上下班（2026-11-10）', sb.__c(P, [seg('09:56', '14:03')], false, false, null), '第二段上班無打卡、第二段下班無打卡');
chk('只有一張上班卡對兩段 → 第一段漏下班、第二段整段沒打', sb.__c(P, [seg('10:00', null)], false, false, null), '第一段下班忘刷卡、第二段上班無打卡、第二段下班無打卡');
chk('整天沒卡 → 維持原本標示', sb.__c([per('10:00', '18:00')], [], false, false, null), '該段無打卡');
chk('單張卡離時段超過 4 小時 → 不採用', sb.__c([per('16:00', '20:00')], [seg('09:00', null)], false, false, null), '該段無打卡');
chk('兩段都漏下班卡 → 分別列出', sb.__c(P, [seg('09:56', null), seg('15:58', null)], false, false, null), '第一段下班忘刷卡、第二段下班忘刷卡');
chk('單張卡用整天最佳配法（不先到先配）', sb.__c(P, [seg(null, '14:05'), seg('15:58', null)], false, false, null), '第一段上班忘刷卡、第二段下班忘刷卡');
chk('只打上班卡也算遲到', sb.__c([per('10:00', '18:00')], [seg('10:20', null)], false, false, null), '遲到20分、下班忘刷卡');
chk('只打下班卡也算早退', sb.__c([per('10:00', '18:00')], [seg(null, '17:30')], false, false, null), '早退30分、上班忘刷卡');
chk('中間休息沒打（同一長段）仍標兩張', sb.__c(P, [seg('09:56', '20:31')], false, false, null), '第一段下班無打卡、第二段上班無打卡');
chk('有未入帳嘗試 → 維持原本字句', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], true, false, null), '打卡未入帳，主管補登');
chk('出差 → 維持出差', sb.__c([per('10:00', '18:00')], [seg('10:00', null)], false, true, null), '出差');
const BW = { startMs: ms('12:00'), endMs: ms('13:00') };
chk('央廚休息帶：只漏下班卡 → 下班忘刷卡（不寫成三張）', sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('08:00', null)], false, false, BW), '下班忘刷卡');
chk('央廚休息帶：一長段打齊 → 正常', sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('07:58', '17:02')], false, false, BW), '正常');
chk('央廚休息帶：上班晚 10 分 → 遲到10分', sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('08:10', '17:02')], false, false, BW), '遲到10分');
chk('央廚休息帶：午休照樣打卡、四張準時 → 正常（B01）', sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('08:00', '12:00'), seg('13:00', '17:00')], false, false, BW), '正常');
chk('央廚休息帶：午休有打卡、忘打最後下班 → 第二段下班忘刷卡（B01）', sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('08:00', '12:00'), seg('13:00', null)], false, false, BW), '第二段下班忘刷卡');
chk('央廚休息帶：午休有打卡、這天少算的卡是 0 張（B01）', sb.__m(sb.__c([per('08:00', '12:00'), per('13:00', '17:00')], [seg('08:00', '12:00'), seg('13:00', null)], false, false, BW)), 0);
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
