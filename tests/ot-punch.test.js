/* 加班單要有打卡佐證（2026-11-14 Eason：「加班單要綁定打卡紀錄，沒有打卡紀錄則無法核定當天出勤」）
   每張已核准加班單要整段落在當天打卡段裡（前後 15 分）；已核准忘打卡單補的卡算、審核中不算；出差日不看；別家店打卡也算。 */
const fs = require('fs'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const read = (f) => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8');
const props = {};
const sb = { console, Utilities: { formatDate: (d) => d.toISOString() }, Logger: { log() {} }, SpreadsheetApp: {}, PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) }, LockService: {} };
vm.createContext(sb); vm.runInContext(read('Code.gs') + '\n' + read('Requests.gs'), sb);
sb.nowTaipeiIso = () => '2026-11-20T12:00:00+08:00';
let p = 0, f = 0; const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };
const D = '2026-11-16', ms = (hm, d) => Date.parse(`${d || D}T${hm}:00+08:00`);
const seg = (a, b, bd) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b, bd) : null });
const per = (a, b, bd) => ({ startMs: ms(a), endMs: ms(b, bd) });
const ot = (s, e, h, extra) => Object.assign({ emp_id: 'E', name: '測試一', date: D, kind: 'ot', status: 'approved', start: s, end: e, hours: h }, extra || {});
const miss = (mt, s, e, st) => ({ emp_id: 'E', name: '測試一', date: D, kind: 'miss', status: st || 'approved', miss_type: mt, start: s || '', end: e || '' });
const F = vm.runInContext('reqBindCheck_', sb);
// 預設情境：核定 09:00–13:00、14:00–20:00＝10 小時，加班單 18:00–20:00
const P = [per('09:00', '13:00'), per('14:00', '20:00')];
const run = (segs, rows, opt, date, periods, hours) => {
  const r = F({}, 'E', date || D, hours == null ? 10 : hours, periods || P, segs, null,
    Object.assign({ rows: rows, sched_day: 'W', preview: true, leaves: [], trip_hours: 0, peer_cards: [] }, opt || {}));
  return r ? r.probs.filter((x) => x.rule === 'ot_punch').map((x) => x.text) : [];
};
const n = (segs, rows, opt, date, periods, hours) => run(segs, rows, opt, date, periods, hours).length;
const OT = [ot('18:00', '20:00', 2)];

chk('打卡蓋到加班時段：過', n([seg('08:55', '13:02'), seg('13:58', '20:05')], OT), 0);
chk('打卡只到 19:44（差 16 分）：擋', n([seg('08:55', '13:02'), seg('13:58', '19:44')], OT), 1);
chk('打卡到 19:46（差 14 分）：過', n([seg('08:55', '13:02'), seg('13:58', '19:46')], OT), 0);
chk('第二段沒上班卡（？–20:05）：擋', n([seg('08:55', '13:02'), seg(null, '20:05')], OT), 1);
chk('訊息講出加班單與當天打卡', run([seg('08:55', '13:02'), seg(null, '20:05')], OT)[0],
  '加班單 18:00–20:00 沒有打卡紀錄（當天打卡：08:55–13:02、？–20:05），請先補忘打卡單、店長核准後再核定，或把加班單改成有打卡的時段');
chk('整天沒打卡：擋，訊息寫當天沒有打卡', /當天沒有打卡/.test(run([], OT)[0] || ''), true);
chk('補了 14:00 上班卡的忘打卡單（已核准）：過', n([seg('08:55', '13:02'), seg(null, '20:05')], OT.concat([miss('in', '14:00', '')])), 0);
chk('忘打卡單還在審核中：不算，擋', n([seg('08:55', '13:02'), seg(null, '20:05')], OT.concat([miss('in', '14:00', '', 'pending')])), 1);
chk('補整段（both 14:00–20:00）：過', n([seg('08:55', '13:02')], OT.concat([miss('both', '14:00', '20:00')])), 0);
chk('補下班卡（out 20:00）接開著的上班卡：過', n([seg('08:55', '13:02'), seg('13:58', null)], OT.concat([miss('out', '', '20:00')])), 0);
chk('中間休息（break）切開：加班在休息時間裡擋', n([seg('08:55', '20:05')], [ot('18:00', '20:00', 2), miss('break', '19:00', '18:30')]), 1);
chk('兩段相隔 15 分內當一段（18:00–19:00／19:10–20:05）：過', n([seg('08:55', '13:02'), seg('13:58', '19:00'), seg('19:10', '20:05')], OT), 0);
chk('兩張加班單各自檢查，只擋沒打卡的那張', run([seg('07:55', '13:02'), seg('13:58', '19:00')], [ot('08:00', '09:00', 1), ot('19:00', '20:00', 1)]).length, 1);
// 跨夜：22:00 上班、隔天 03:05 下班，加班單 01:00–03:00（日期＝上班那天）
const PN = [per('22:00', '03:00', '2026-11-17')];
chk('跨夜班凌晨加班：過', n([seg('21:58', '03:05', '2026-11-17')], [ot('01:00', '03:00', 2)], null, D, PN, 5), 0);
chk('跨夜班只打到 02:00：擋', n([seg('21:58', '02:00', '2026-11-17')], [ot('01:00', '03:00', 2)], null, D, PN, 5), 1);
chk('跨夜補凌晨下班卡（out 03:05）：過', n([seg('21:58', null)], [ot('01:00', '03:00', 2), miss('out', '', '03:05')], null, D, PN, 5), 0);
// 出差日不看
chk('有已核准出差單：不看', n([], OT.concat([{ emp_id: 'E', date: D, kind: 'trip', status: 'approved', hours: 4 }])), 0);
chk('核定登記出差時數：不看', n([], OT, { trip_hours: 4 }), 0);
// 別家店支援
const peer = [{ ts: '2026-11-16T13:55:00+08:00', type: 'in', status: 'ok', store: 'mztjs' }, { ts: '2026-11-16T20:03:00+08:00', type: 'out', status: 'ok', store: 'mztjs' }];
chk('本店沒打、別家店打卡蓋到：過', n([seg('08:55', '13:02')], OT, { peer_cards: peer }), 0);
chk('別家店的卡被擋（rejected）不算：擋', n([seg('08:55', '13:02')], OT, { peer_cards: peer.map((x) => Object.assign({}, x, { status: 'rejected_out_of_range' })) }), 1);
chk('本店上班卡配別家下班卡不算（各店自己配）', n([seg('13:58', null)], OT, { peer_cards: [peer[1]] }), 1);
// 開關與日期
chk('11/14（上線日前）不看', n([], [ot('18:00', '20:00', 2, { date: '2026-11-14' })], null, '2026-11-14'), 0);
chk('試算（force_ot_punch）11/14 也看', n([], [ot('18:00', '20:00', 2, { date: '2026-11-14' })], { force_ot_punch: true }, '2026-11-14'), 1);
props.REQ_OT_PUNCH_FROM = 'off';
chk('REQ_OT_PUNCH_FROM off：不看', n([], OT), 0);
props.REQ_OT_PUNCH_FROM = '2026-11-20';
chk('REQ_OT_PUNCH_FROM 改 11/20：11/16 不看', n([], OT), 0);
delete props.REQ_OT_PUNCH_FROM; props.REQ_BIND_FROM = 'off';
chk('REQ_BIND_FROM off（全關）：不看', n([], OT), 0);
delete props.REQ_BIND_FROM;
chk('沒有加班單：不看', n([], [], null, D, P, 8), 0);
// 真的擋下（非試算）：整天送不出
const real = F({}, 'E', D, 10, P, [seg('08:55', '13:02'), seg(null, '20:05')], null, { rows: OT, sched_day: 'W', leaves: [], trip_hours: 0, peer_cards: [], acting: true });
chk('核定送出被擋：need_request', real && real.error, 'need_request');
console.log(f ? `\n❌ 失敗 ${f}` : `\n✅ 全部通過 (${p}/${p})`); process.exit(f ? 1 : 0);
