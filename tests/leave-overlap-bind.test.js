// 核定上班時段不能跟已核准、有時段的假單／出差單重疊（2026-11-18 Eason 第 6 題：任何重疊都擋、容許 0 分鐘；有時段的出差單一併納入）。
// 起因：營運系統卡片把「班表開頭請假、晚到」的人預填成從班表開頭上班，再填假別 → 同一段既算上班又算請假（班表 09–18、事假 09–11、11:20 打卡 → 上班 8＋事假 2、遲到 140 分）。
// leave 分頁沒有時段，只能比 requests 列的 start／end。用真函式（Requests.gs reqBindCheck_）跑；名字一律假名。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function extractConst(src, name) { const i = src.indexOf('const ' + name + ' = ['); const j = src.indexOf('];', i); return src.slice(i, j + 2).replace('const ', 'var '); }
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
function sheet(name, rows) {
  const data = rows ? rows.map((r) => r.slice()) : [];
  return { name, data,
    getRange(r, c, nr, nc) { return { setValues(v) { v.forEach((row, i) => row.forEach((x, k) => { (data[r - 1 + i] = data[r - 1 + i] || [])[c - 1 + k] = x; })); }, setValue(x) { (data[r - 1] = data[r - 1] || [])[c - 1] = x; }, getValues() { return [data[r - 1].slice(c - 1, c - 1 + (nc || 1))]; }, setNumberFormat() {} }; },
    appendRow(row) { data.push(row.slice()); }, getLastColumn() { return data[0] ? data[0].length : 0; } };
}
function makeEnv(props0) {
  const sheets = { managers: sheet('managers', [['name', 'key', 'active'], ['測試主管', 'MK', 'true']]), roster: sheet('roster', [['emp_id', 'name', 'active', 'line_user_id'], ['E01', '測試一', 'true', 'U1']]) };
  const props = Object.assign({ REQ_STRICT_FROM: '2026-11-01' }, props0 || {});
  const sb = { console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, Object, Array, RegExp, CONFIG: {},
    getSS: () => ({ getSheetByName: (nm) => sheets[nm] || null, insertSheet: (nm) => (sheets[nm] = sheet(nm)) }),
    readSheetAsObjects: (sh) => { const h = sh.data[0] || []; return { headers: h, rows: sh.data.slice(1).map((r, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; }); return o; }) }; },
    normCellDate: (v) => String(v), normCellTs: (v) => String(v), nowTaipeiIso: () => '2026-11-20T16:00:00+08:00', todayTaipeiStr: () => '2026-11-20', liffEvents_: () => [],
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) } };
  vm.createContext(sb);
  vm.runInContext([extractConst(codeSrc, 'LEAVE_TYPES'), extract(codeSrc, 'findManagerByKey'), extract(codeSrc, 'actingName_'), extract(codeSrc, 'sheetSafeText_'),
    extract(codeSrc, 'findRosterByEmpId'), extract(codeSrc, 'gapExplainedByBreak'), fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8')].join('\n'), sb);
  return sb;
}
const D = '2026-11-20', D1 = '2026-11-21';
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const P = (a, b, d1, d2) => ({ startMs: ms(a, d1), endMs: ms(b, d2 || d1) });
const S = (a, b, d1, d2) => ({ inMs: a ? ms(a, d1) : null, outMs: b ? ms(b, d2 || d1) : null });
const BRK = { startMs: ms('12:00'), endMs: ms('13:00') };
function addReq(sb, r) {
  const sh = sb.reqSheet_(sb.getSS(), true);
  const row = Object.assign({ id: 'x' + Math.random(), created_at: '2026-11-20T08:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
  sh.appendRow(sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
}
const chk = (sb, h, ps, ss, opt, date) => sb.reqBindCheck_(sb.getSS(), 'E01', date || D, h, ps, ss, BRK, opt || {});
const rules = (r) => (r && r.probs ? JSON.parse(JSON.stringify(r.probs.map((p) => p.rule))) : []);
const lv = (type, a, b, h, o) => Object.assign({ kind: 'leave', leave_type: type, start: a, end: b, hours: h }, o || {});

ok('O1 例 A：核定 09–12、13–18＋已核准事假 09–11 → 擋 leave_overlap（重疊 120 分）、ok false、不算缺單', () => {
  const sb = makeEnv(); addReq(sb, lv('事假', '09:00', '11:00', 2));
  const r = chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('11:20', '18:00')], { leaves: [{ type: '事假', hours: 2 }] });
  assert.strictEqual(r && r.ok, false); assert.strictEqual(r.error, 'need_request');
  assert.deepStrictEqual(rules(r), ['leave_overlap'], JSON.stringify(r.probs));
  assert.strictEqual(r.probs[0].text, '核定上班 09:00–12:00 跟已核准的事假 09:00–11:00 重疊 120 分鐘，同一段不能同時算上班和請假，請把上班時段改到假單以外（要算上班就先作廢那張單）');
  assert.strictEqual(r.need_doc, false, '不是缺單：hint 叫主管調時段');
  assert.ok(/請照上面調整核定時段/.test(r.hint), r.hint);
});
ok('O2 例 A 修好後：核定 11–12、13–18＋事假 2 → 放行（null）', () => {
  const sb = makeEnv(); addReq(sb, lv('事假', '09:00', '11:00', 2));
  assert.strictEqual(chk(sb, 6, [P('11:00', '12:00'), P('13:00', '18:00')], [S('11:20', '18:00')], { leaves: [{ type: '事假', hours: 2 }] }), null);
});
ok('O3 有時段的出差單重疊同樣擋；字句寫出差', () => {
  const sb = makeEnv(); addReq(sb, { kind: 'trip', leave_type: '出差', start: '13:00', end: '15:00', hours: 2 });
  const r = chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('08:58', '12:01'), S('14:59', '18:03')], { leaves: [{ type: '出差', hours: 2 }], trip_hours: 2 });
  assert.ok(rules(r).includes('leave_overlap'), JSON.stringify(r && r.probs));
  const t = r.probs.find((p) => p.rule === 'leave_overlap').text;
  assert.ok(/核定上班 13:00–18:00 跟已核准的出差 13:00–15:00 重疊 120 分鐘，同一段不能同時算上班和出差，請把上班時段改到出差單以外/.test(t), t);
  assert.strictEqual(chk(sb, 6, [P('09:00', '12:00'), P('15:00', '18:00')], [S('08:58', '12:01'), S('14:59', '18:03')], { leaves: [{ type: '出差', hours: 2 }], trip_hours: 2 }), null, '扣掉出差時段 → 放行（Q2(4)）');
});
ok('O4 假單沒填時段 → 不比時段（只比時數，照舊）', () => {
  const sb = makeEnv(); addReq(sb, lv('事假', '', '', 2));
  assert.strictEqual(chk(sb, 6, [P('09:00', '12:00'), P('13:00', '16:00')], [S('09:00', '16:00')], { leaves: [{ type: '事假', hours: 2 }] }), null);
});
ok('O5 跨午夜：核定 22:00–06:00、事假 05:00–06:00（隔天早上）→ 擋 60 分；事假 22:00–23:00 → 擋', () => {
  let sb = makeEnv(); addReq(sb, lv('事假', '05:00', '06:00', 1));
  let r = chk(sb, 8, [P('22:00', '06:00', D, D1)], [S('22:00', '06:00', D, D1)], { leaves: [{ type: '事假', hours: 1 }] });
  assert.ok(rules(r).includes('leave_overlap'), JSON.stringify(r && r.probs));
  assert.ok(/核定上班 22:00–06:00 跟已核准的事假 05:00–06:00 重疊 60 分鐘/.test(r.probs.find((p) => p.rule === 'leave_overlap').text));
  assert.ok(!rules(chk(sb, 7, [P('22:00', '05:00', D, D1)], [S('22:00', '05:00', D, D1)], { leaves: [{ type: '事假', hours: 1 }] })).includes('leave_overlap'), '扣掉隔天早上那段 → 不比到');
  sb = makeEnv(); addReq(sb, lv('事假', '22:00', '23:00', 1));
  r = chk(sb, 8, [P('22:00', '06:00', D, D1)], [S('23:10', '06:00', D, D1)], { leaves: [{ type: '事假', hours: 1 }] });
  assert.ok(rules(r).includes('leave_overlap'));
  r = chk(sb, 7, [P('23:00', '06:00', D, D1)], [S('23:10', '06:00', D, D1)], { leaves: [{ type: '事假', hours: 1 }] });
  assert.ok(!rules(r).includes('leave_overlap'), 'L10 修好後 23:00 起 → 不擋：' + JSON.stringify(r && r.probs));
  sb = makeEnv(); addReq(sb, lv('事假', '23:00', '01:00', 2));
  r = chk(sb, 8, [P('20:00', '00:30', D, D1)], [S('20:00', '00:30', D, D1)], { leaves: [{ type: '事假', hours: 2 }] });
  assert.ok(/重疊 90 分鐘/.test((r.probs.find((p) => p.rule === 'leave_overlap') || {}).text || ''), '假單本身跨夜 23:00–01:00');
});
ok('O6 剛好相接（假 09–11、上班 11:00 起；假 16–18、上班到 16:00）→ 不擋；差 1 分鐘就擋（容許 0 分）', () => {
  let sb = makeEnv(); addReq(sb, lv('事假', '09:00', '11:00', 2)); addReq(sb, lv('特休假', '16:00', '18:00', 2));
  const L = { leaves: [{ type: '事假', hours: 2 }, { type: '特休假', hours: 2 }] };
  assert.strictEqual(chk(sb, 4, [P('11:00', '12:00'), P('13:00', '16:00')], [S('10:58', '16:01')], L), null);
  const r = chk(sb, 4.02, [P('11:00', '12:00'), P('13:00', '16:01')], [S('10:58', '16:01')], L);
  assert.ok(/核定上班 13:00–16:01 跟已核准的特休假 16:00–18:00 重疊 1 分鐘/.test((r.probs.find((p) => p.rule === 'leave_overlap') || {}).text || ''), JSON.stringify(r && r.probs));
});
ok('O7 加嚴沒開（REQ_STRICT_FROM=off 或晚於那天）→ 不比', () => {
  for (const v of ['off', '2026-12-01']) {
    const sb = makeEnv({ REQ_STRICT_FROM: v }); addReq(sb, lv('事假', '09:00', '11:00', 2));
    assert.ok(!rules(chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('11:20', '18:00')], { leaves: [{ type: '事假', hours: 2 }] })).includes('leave_overlap'), v);
  }
});
ok('O8 請假時段裡有打卡（L7 特休 14–16、打卡 09–18）：核定 09–18 擋；扣掉 14–16 放行', () => {
  const sb = makeEnv(); addReq(sb, lv('特休假', '14:00', '16:00', 2));
  const L = { leaves: [{ type: '特休假', hours: 2 }] };
  assert.ok(rules(chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('09:00', '18:00')], L)).includes('leave_overlap'));
  const r = chk(sb, 6, [P('09:00', '12:00'), P('13:00', '14:00'), P('16:00', '18:00')], [S('09:00', '18:00')], L);
  assert.ok(!rules(r).includes('leave_overlap'), JSON.stringify(r && r.probs));
});
ok('O9 待審、退回、作廢的假單不比（只比已核准）；兩張假各自列', () => {
  let sb = makeEnv();
  for (const st of ['rejected', 'void']) addReq(sb, lv('事假', '09:00', '11:00', 2, { status: st }));
  assert.ok(!rules(chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('09:00', '18:00')], {})).includes('leave_overlap'));
  sb = makeEnv(); addReq(sb, lv('事假', '09:00', '11:00', 2, { status: 'pending' }));
  assert.ok(!rules(chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('09:00', '18:00')], {})).includes('leave_overlap'), '待審不比（第 9 題：打卡端先不擋待審單）');
  sb = makeEnv(); addReq(sb, lv('補休', '09:00', '10:00', 1)); addReq(sb, lv('事假', '17:00', '18:00', 1));
  const r = chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('10:05', '17:00')], { leaves: [{ type: '補休', hours: 1 }, { type: '事假', hours: 1 }] });
  assert.strictEqual(r.probs.filter((p) => p.rule === 'leave_overlap').length, 2, JSON.stringify(r.probs));
});
ok('O10 預覽（preview）也帶這條；整天請假（核定沒有時段）不比', () => {
  const sb = makeEnv(); addReq(sb, lv('事假', '09:00', '11:00', 2));
  const pv = chk(sb, 8, [P('09:00', '12:00'), P('13:00', '18:00')], [S('11:20', '18:00')], { leaves: [{ type: '事假', hours: 2 }], preview: true });
  assert.ok(pv.probs.some((p) => p.rule === 'leave_overlap'));
  const sb2 = makeEnv(); addReq(sb2, lv('特休假', '09:00', '18:00', 8));
  assert.strictEqual(chk(sb2, 0, [], [], { leaves: [{ type: '特休假', hours: 8 }] }), null);
});
ok('O11 兩張已核准單時段互相重疊（事假 14–16＋補休 15–17）→ 擋 leave_overlap「同一段不能請兩次」（2026-11-18 驗收：前端聯集、登記時數加總會重複算）；剛好相接不擋', () => {
  let sb = makeEnv(); addReq(sb, lv('事假', '14:00', '16:00', 2)); addReq(sb, lv('補休', '15:00', '17:00', 2));
  const L = { leaves: [{ type: '事假', hours: 2 }, { type: '補休', hours: 2 }] };
  const r = chk(sb, 5, [P('09:00', '12:00'), P('13:00', '14:00'), P('17:00', '18:00')], [S('09:00', '14:00'), S('17:00', '18:00')], L);
  const t = (r && r.probs || []).map((p) => p.text).join('|');
  assert.ok(/已核准的事假 14:00–16:00 跟補休 15:00–17:00 時段重疊 60 分鐘，同一段不能請兩次/.test(t), t);
  sb = makeEnv(); addReq(sb, lv('事假', '14:00', '15:00', 1)); addReq(sb, lv('補休', '15:00', '17:00', 2));
  const r2 = chk(sb, 5, [P('09:00', '12:00'), P('13:00', '14:00'), P('17:00', '18:00')], [S('09:00', '14:00'), S('17:00', '18:00')], { leaves: [{ type: '事假', hours: 1 }, { type: '補休', hours: 2 }] });
  assert.ok(!rules(r2).includes('leave_overlap'), JSON.stringify(r2 && r2.probs));
});
console.log('leave-overlap-bind: ' + n + ' 項全過');
