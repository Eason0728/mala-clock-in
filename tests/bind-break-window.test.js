/* 綁單算缺卡：央廚休息帶隔開的兩段當同一段（2026-11-10）；夜間重算帶差異原因。用真函式跑。 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const req = fs.readFileSync(path.join(__dirname, '../apps-script/Requests.gs'), 'utf8');
const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
const pick = (src, name) => { const s = src.indexOf('function ' + name + '('); const e = src.indexOf('\n}\n', s); return src.slice(s, e + 3); };
const sb = {};
vm.createContext(sb);
vm.runInContext(['var REQ_BIND_NEAR_MS = 4 * 3600000;', code.match(/^const LONE_CARD_NEAR_MS = .*$/m)[0], pick(code, 'gapExplainedByBreak'), pick(code, 'loneCardsForPeriods_'), pick(req, 'reqBindMissCards_'), 'var __f = reqBindMissCards_;'].join('\n'), sb);
const ms = hm => { const [h, m] = hm.split(':').map(Number); return (h * 60 + m) * 60000; };
const per = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const seg = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
const BW = { startMs: ms('12:00'), endMs: ms('13:00') };
const P = [per('08:00', '12:00'), per('13:00', '17:00')];
let fail = 0;
const chk = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' got=' + got)); };
chk('央廚只漏下班卡 → 1 張', sb.__f(P, [seg('08:00', null)], BW), 1);
chk('央廚只漏上班卡 → 1 張', sb.__f(P, [seg(null, '17:00')], BW), 1);
chk('央廚整天沒打 → 2 張', sb.__f(P, [], BW), 2);
chk('央廚一長段打齊 → 0', sb.__f(P, [seg('08:00', '17:00')], BW), 0);
chk('沒有休息帶的店：中間休息沒打仍算 2 張', sb.__f([per('10:00', '14:00'), per('16:00', '20:00')], [seg('10:00', '20:00')], null), 2);
chk('沒有休息帶的店：只漏最後下班卡 → 1 張', sb.__f([per('10:00', '14:00'), per('16:00', '20:00')], [seg('10:00', '14:00'), seg('16:00', null)], null), 1);
const rc = code.slice(code.indexOf('function recheckPendingApprovalStatuses'), code.indexOf('function recheckPendingApprovalStatuses') + 4000);
chk('夜間重算帶差異原因', /dupIgnoreList_\(rec\.dup_ignore\), String\(rec\.diff_reason/.test(rc), true);
const bf = code.slice(code.indexOf('function backfillMissingPunchGroups'), code.indexOf('function backfillMissingPunchGroups') + 5000);
chk('回填帶差異原因', /dupIgnoreList_\(rec\.dup_ignore\), String\(rec\.diff_reason/.test(bf), true);
if (fail) { console.log(fail + ' 項失敗'); process.exit(1); }
console.log('全部通過');
