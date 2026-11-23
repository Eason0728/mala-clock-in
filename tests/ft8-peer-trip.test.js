// 正職上班日滿 8 小時：別家還沒核定時，算它已核准的出差單（2026-11-23 Eason 定案）。
// 實例（2026-11-06，人名與工號不進公開 repo）：總部原單位有已核准出差單 3.25 小時、沒核定；金山支援帳號打卡 15:23–17:01、17:50–21:19，要核 4.75 被擋。
// 規則：別家還沒核定 → 它已核准的出差單加進合計（同已核准假單）；別家已核定 → 用核定時數（已含登記的出差），不再加出差單。
// 待審、退回、作廢、本人取消的出差單不算；讀不到別家照舊放行。
// 別家沒核定、沒打卡、只有出差單＝當成那家已核定出差那麼多小時（同日複審後大腦裁示）：超過 8 要加班單、跨店加班歸屬、ot_void 都跟那家已核定時一樣，
// 不隨哪家先核而變；也不走「別家有卡還沒核定＝先放行」。
// 舊版對照：預設拿 473c6cb（這次改動前的 origin/main）的 Requests.gs，可用 FT8TRIP_BASE 換。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.FT8TRIP_BASE || '473c6cb';
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const newSrc = fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8');
let oldSrc = null;
try { oldSrc = cp.execFileSync('git', ['-C', ROOT, 'show', BASE + ':apps-script/Requests.gs'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { console.error('讀不到舊版 ' + BASE + ' 的 Requests.gs（淺複製？）：' + e.message); process.exit(1); }
assert.ok(!/out\.trip|tnames/.test(oldSrc), '舊版不應該已經有出差單合計（FT8TRIP_BASE 指錯版本）');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function extractConst(src, name) {
  const i = src.indexOf('const ' + name + ' = ['); const j = src.indexOf('];', i);
  return src.slice(i, j + 2).replace('const ', 'var ');
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

const D = '2026-11-06';
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const P = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const S = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
function sheet(rows) { return { data: rows.map((r) => r.slice()) }; }
const EV_H = ['ts', 'emp_id', 'type', 'status', 'mirror_src'];
const AP_H = ['date', 'emp_id', 'name', 'approved_hours', 'periods', 'entered_at', 'mirror_src'];

/** 一個沙盒（新版或舊版 Requests.gs）＋假的多家店。books：{店代碼: {roster:[[id,名,active]], events:[[ts,id,type,status,mirror]], approved:[[date,id,名,h,periods,at,mirror]], requests:[{...}]}} */
function makeEnv(src, books, self) {
  const props = {};
  const opened = [];
  const sb = {
    console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, parseFloat, Object, Array, RegExp, Error,
    CONFIG: {},
    Logger: { log() {} },
    readSheetAsObjects: (sh) => {
      if (!sh) throw new Error('no sheet');
      const h = sh.data[0] || [];
      return { headers: h, rows: sh.data.slice(1).map((r, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; }); return o; }) };
    },
    normCellDate: (v) => String(v), normCellTs: (v) => String(v),
    nowTaipeiIso: () => '2026-11-23T20:00:00+08:00', todayTaipeiStr: () => '2026-11-23',
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  };
  vm.createContext(sb);
  vm.runInContext([extractConst(codeSrc, 'LEAVE_TYPES'), extract(codeSrc, 'findManagerByKey'), extract(codeSrc, 'actingName_'), extract(codeSrc, 'sheetSafeText_'),
                   extract(codeSrc, 'findRosterByEmpId'), extract(codeSrc, 'gapExplainedByBreak'), src].join('\n'), sb);
  const mk = (code) => {
    const b = books[code];
    return {
      id: code,
      getId: () => 'ss-' + code,
      getSheetByName: (nm) => {
        if (!b) return null;
        if (nm === 'roster') return sheet([['emp_id', 'name', 'active']].concat(b.roster || []));
        if (nm === 'events') return sheet([EV_H].concat(b.events || []));
        if (nm === 'approved') return sheet([AP_H].concat(b.approved || []));
        return null;
      },
    };
  };
  sb.REST_PEERS_ = Object.keys(books).concat(self && !books[self] ? [self] : []).map((c) => ({ code: c, ss: 'ss-' + c }));
  sb.restName_ = (x) => String(x || '').replace(/\s+/g, '');
  sb.getSS = () => mk(self);
  sb.SpreadsheetApp = { openById: (id) => { const c = id.slice(3); opened.push(c); if (books[c] && books[c].broken) throw new Error('打不開'); return mk(c); } };
  sb.readEventsSince = (sh) => sb.readSheetAsObjects(sh);
  sb.buildLatestApprovedMap = (rows) => { const m = {}; rows.forEach((r) => { (m[r.date] = m[r.date] || {})[r.emp_id] = r; }); return m; };
  sb.reqRows_ = (ss) => ((books[ss.id] || {}).requests || []).map((r) => Object.assign({}, r));
  sb.__opened = opened;
  return sb;
}
const NEW = (books, self) => makeEnv(newSrc, books, self);
const OLD = (books, self) => makeEnv(oldSrc, books, self);

// ── 11/06 原始互卡的兩家（固定的假設資料，照原始情境；人名工號是假的）──
const NM = '測試同仁';
const tripReq = (o) => Object.assign({ id: 't1', emp_id: 'HQ-T4', name: NM, kind: 'trip', date: D, leave_type: '出差', start: '09:00', end: '12:15', hours: 3.25, status: 'approved' }, o);
const jsPunch = [[D + 'T15:23:00+08:00', 'MZTJST15', 'in', 'ok', ''], [D + 'T17:01:00+08:00', 'MZTJST15', 'out', 'ok', ''],
                 [D + 'T17:50:00+08:00', 'MZTJST15', 'in', 'ok', ''], [D + 'T21:19:00+08:00', 'MZTJST15', 'out', 'ok', '']];
function chenBooks(o) {
  o = o || {};
  return {
    hq: { roster: [['HQ-T4', NM, 'true'], ['HQ-T9', '別人', 'true']], events: o.hqEvents || [], approved: o.hqApproved || [], requests: o.hqReqs || [tripReq()] },
    mztjs: { roster: [['MZTJST15', NM, 'true']], events: o.jsEvents || jsPunch, approved: o.jsApproved || [], requests: o.jsReqs || [] },
  };
}
// 金山這次送出：核定時段 15:30–17:00、18:00–（依時數）
function jsCheck(sb, hours, extra) {
  const h2 = hours - 1.5, endMin = 18 * 60 + Math.round(h2 * 60);
  const end = String(Math.floor(endMin / 60)).padStart(2, '0') + ':' + String(endMin % 60).padStart(2, '0');
  const periods = h2 > 0 ? [P('15:30', '17:00'), P('18:00', end)] : [P('15:30', '17:00')];
  const segs = [S('15:23', '17:01'), S('17:50', '21:19')];
  return sb.reqBindCheck_(sb.getSS(), 'MZTJST15', D, hours, periods, segs, null,
    Object.assign({ sched_ft: true, sched_day: 'W', sched_support: true, sched_home: 'hq', name: NM, rows: sb.reqRows_(sb.getSS()), leaves: [], trip_hours: 0, acting: true, own_fs: 930,
      diff_reason: '提早結束' }, extra || {}));   // 核定比打卡短時「卡差 30 分要原因」那條（滿 8 小時之後才看）先給原因，這裡只看滿 8 小時
}
// 總部這次送出：整段出差（沒有上班時段），核定 = 出差時數
function hqCheck(sb, tripH, extra) {
  return sb.reqBindCheck_(sb.getSS(), 'HQ-T4', D, tripH, [], [], null,
    Object.assign({ sched_ft: true, sched_day: 'W', sched_support: false, name: NM, rows: sb.reqRows_(sb.getSS()), leaves: [{ type: '出差', hours: tripH }], trip_hours: tripH, acting: true }, extra || {}));
}
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));   // vm 裡的陣列／物件換成這邊的，deepStrictEqual 才比得了
const ft8Text = (r) => (r && r.probs ? J(r.probs.filter((p) => /^ft8/.test(p.rule)).map((p) => p.text)) : []);
const rules = (r) => (r && r.probs ? J(r.probs.map((p) => p.rule)) : []);
const MSG = (s) => '正職上班日要滿 8 小時' + s + '，要有已核准的假單或補休單';

ok('11/06 原始互卡：舊版金山 4.75 被擋（上班 4.75＋出差 0＋假單 0）；新版算進總部出差單 3.25＝8 → 過', () => {
  const o = jsCheck(OLD(chenBooks(), 'mztjs'), 4.75);
  assert.deepStrictEqual(ft8Text(o), [MSG('（上班 4.75＋出差 0＋假單 0＝4.75 小時），還差 3.25 小時')]);
  assert.strictEqual(jsCheck(NEW(chenBooks(), 'mztjs'), 4.75), null);
});
ok('順序一：金山先核 4.75 過 → 之後總部核 3.25（金山已核定 4.75）＝8 過', () => {
  const b = chenBooks({ jsApproved: [[D, 'MZTJST15', NM, 4.75, '15:30-17:00,18:00-21:15', 'x', '']] });
  assert.strictEqual(hqCheck(NEW(b, 'hq'), 3.25), null);
  assert.strictEqual(hqCheck(OLD(b, 'hq'), 3.25), null, '這邊舊版本來就過（金山已核定時數照算）');
});
ok('金山 3.75：總部還沒核定 → 擋「這家 3.75＋總部出差單 3.25＝7 小時，還差 1 小時」；總部（金山有卡沒核定）照舊先放行；總部核定後金山仍擋（改用核定時數，不再寫出差單）', () => {
  assert.deepStrictEqual(ft8Text(jsCheck(NEW(chenBooks(), 'mztjs'), 3.75)), [MSG('：這家 3.75＋總部出差單 3.25＝7 小時，還差 1 小時')]);
  assert.strictEqual(hqCheck(NEW(chenBooks(), 'hq'), 3.25), null, '金山有打卡、還沒核定＝先放行（現況規則）');
  const b = chenBooks({ hqApproved: [[D, 'HQ-T4', NM, 3.25, '', 'x', '']] });
  assert.deepStrictEqual(ft8Text(jsCheck(NEW(b, 'mztjs'), 3.75)), [MSG('：這家 3.75＋總部 3.25＝7 小時，還差 1 小時')]);
  assert.deepStrictEqual(ft8Text(jsCheck(OLD(b, 'mztjs'), 3.75)), ft8Text(jsCheck(NEW(b, 'mztjs'), 3.75)), '總部已核定時新舊一樣');
});
ok('順序二：總部先核定 3.25 → 金山 4.75 用核定時數＝8 過（不重複加成 11.25）；金山 4.5 擋 7.75', () => {
  const b = chenBooks({ hqApproved: [[D, 'HQ-T4', NM, 3.25, '', 'x', '']] });
  const sb = NEW(b, 'mztjs');
  const pr = sb.reqPeerDay_(NM, D);
  assert.strictEqual(pr.work, 3.25); assert.strictEqual(pr.trip, undefined); assert.strictEqual(pr.tnames, undefined);
  assert.strictEqual(jsCheck(sb, 4.75), null);
  assert.deepStrictEqual(ft8Text(jsCheck(NEW(b, 'mztjs'), 4.5)), [MSG('：這家 4.5＋總部 3.25＝7.75 小時，還差 0.25 小時')]);
});
ok('別家已核定且登記出差（總部核定 3.5＝出差 3.25＋上班 0.25）：不再另加出差單，金山 4.5 合計剛好 8 過、4.25 擋', () => {
  const b = chenBooks({ hqApproved: [[D, 'HQ-T4', NM, 3.5, '13:00-13:15', 'x', '']], hqEvents: [[D + 'T12:58:00+08:00', 'HQ-T4', 'in', 'ok', ''], [D + 'T13:16:00+08:00', 'HQ-T4', 'out', 'ok', '']] });
  assert.strictEqual(jsCheck(NEW(b, 'mztjs'), 4.5), null);
  assert.deepStrictEqual(ft8Text(jsCheck(NEW(b, 'mztjs'), 4.25)), [MSG('：這家 4.25＋總部 3.5＝7.75 小時，還差 0.25 小時')]);
  assert.deepStrictEqual(JSON.stringify(NEW(b, 'mztjs').reqPeerDay_(NM, D)), JSON.stringify(OLD(b, 'mztjs').reqPeerDay_(NM, D)), '別家已核定：讀到的東西跟舊版逐字相同');
});
ok('另一家同時有已核准假單＋出差單（都還沒核定）：「這家 3.5＋總部 1＋總部出差單 3.25＝7.75」擋；3.75 剛好 8 過', () => {
  const b = chenBooks({ hqReqs: [tripReq(), tripReq({ id: 'l1', kind: 'leave', leave_type: '事假', start: '13:00', end: '14:00', hours: 1 })] });
  assert.deepStrictEqual(ft8Text(jsCheck(NEW(b, 'mztjs'), 3.5)), [MSG('：這家 3.5＋總部 1＋總部出差單 3.25＝7.75 小時，還差 0.25 小時')]);
  assert.strictEqual(jsCheck(NEW(b, 'mztjs'), 3.75), null);
  assert.deepStrictEqual(ft8Text(jsCheck(OLD(b, 'mztjs'), 3.5)), [MSG('：這家 3.5＋總部 1＝4.5 小時，還差 3.5 小時')], '舊版只算假單');
});
ok('出差單待審、退回、作廢、本人取消都不算：新版跟舊版一樣擋、字也一樣', () => {
  ['pending', 'rejected', 'voided', 'cancelled'].forEach((st) => {
    const b = chenBooks({ hqReqs: [tripReq({ status: st })] });
    const nw = jsCheck(NEW(b, 'mztjs'), 4.75), od = jsCheck(OLD(b, 'mztjs'), 4.75);
    assert.deepStrictEqual(ft8Text(nw), [MSG('（上班 4.75＋出差 0＋假單 0＝4.75 小時），還差 3.25 小時')], st);
    assert.strictEqual(JSON.stringify(nw), JSON.stringify(od), st + '：整個回應跟舊版逐字相同');
  });
});
ok('兩邊都只有單、沒打卡（金山也是整段出差 4.75）：兩邊都看得到對方的出差單，合計 8 過；金山只有 4 → 擋 7.25', () => {
  const b = chenBooks({ jsEvents: [], jsReqs: [{ id: 'j1', emp_id: 'MZTJST15', name: NM, kind: 'trip', date: D, leave_type: '出差', start: '14:00', end: '18:45', hours: 4.75, status: 'approved' }] });
  const jsTrip = (sb, h) => sb.reqBindCheck_(sb.getSS(), 'MZTJST15', D, h, [], [], null,
    { sched_ft: true, sched_day: 'W', sched_support: true, sched_home: 'hq', name: NM, rows: sb.reqRows_(sb.getSS()), leaves: [{ type: '出差', hours: h }], trip_hours: h, acting: true });
  assert.strictEqual(jsTrip(NEW(b, 'mztjs'), 4.75), null);
  assert.strictEqual(hqCheck(NEW(b, 'hq'), 3.25), null);
  const b2 = chenBooks({ jsEvents: [], jsReqs: [{ id: 'j1', emp_id: 'MZTJST15', name: NM, kind: 'trip', date: D, leave_type: '出差', start: '14:00', end: '18:00', hours: 4, status: 'approved' }] });
  const r = jsTrip(NEW(b2, 'mztjs'), 4);
  assert.deepStrictEqual(ft8Text(r), [MSG('：這家 4＋總部出差單 3.25＝7.25 小時，還差 0.75 小時')]);
  assert.strictEqual(r.need.leave_hours, 0.75);
});
ok('不相加的單位（小辛辣光復 × 墨竹亭光復）：別家出差單不算，新舊逐字相同', () => {
  const b = { gf: { roster: [['GF07', '林同仁', 'true']], events: [], approved: [], requests: [] },
              mztgf: { roster: [['MZTGF3', '林同仁', 'true']], events: [], approved: [], requests: [{ id: 'g', emp_id: 'MZTGF3', kind: 'trip', date: D, start: '09:00', end: '12:15', hours: 3.25, status: 'approved' }] } };
  const run = (sb) => sb.reqBindCheck_(sb.getSS(), 'GF07', D, 4.75, [P('15:30', '17:00'), P('18:00', '21:15')], [S('15:23', '17:01'), S('17:50', '21:19')], null,
    { sched_ft: true, sched_day: 'W', name: '林同仁', rows: [], leaves: [], trip_hours: 0, acting: true });
  const nw = run(NEW(b, 'gf')), od = run(OLD(b, 'gf'));
  assert.deepStrictEqual(ft8Text(nw), [MSG('（上班 4.75＋出差 0＋假單 0＝4.75 小時），還差 3.25 小時')]);
  assert.strictEqual(JSON.stringify(nw), JSON.stringify(od));
});
ok('同名兩位（分不出是誰）不算；總部鏡像列（mirror_src）的出差單不算：新舊逐字相同', () => {
  const dup = chenBooks(); dup.hq.roster.push(['HQ-T11', NM, 'true']);
  const mir = chenBooks({ hqReqs: [tripReq({ mirror_src: 'CF' })] });
  [dup, mir].forEach((b, i) => {
    const nw = jsCheck(NEW(b, 'mztjs'), 4.75), od = jsCheck(OLD(b, 'mztjs'), 4.75);
    assert.deepStrictEqual(ft8Text(nw), [MSG('（上班 4.75＋出差 0＋假單 0＝4.75 小時），還差 3.25 小時')], i ? '鏡像' : '同名');
    assert.strictEqual(JSON.stringify(nw), JSON.stringify(od));
  });
});
ok('讀不到另一家＝放行（現況不變）：別家打不開時新舊都過', () => {
  const b = chenBooks(); b.hq.broken = true;
  assert.strictEqual(jsCheck(NEW(b, 'mztjs'), 3), null);
  assert.strictEqual(jsCheck(OLD(b, 'mztjs'), 3), null);
  const sb = NEW(b, 'mztjs'); assert.strictEqual(sb.reqPeerDay_(NM, D).failed, true);
});
// ── 複審擋項（2026-11-23）：出差單也要算進「超過 8 要加班單」，兩種核定順序下兩家被要求的單要完全一樣 ──
const T4 = tripReq({ start: '09:00', end: '13:00', hours: 4 });
const JS_AP = (h, p) => [[D, 'MZTJST15', NM, h, p || '15:30-17:00,18:00-21:15', 'x', '']];
const HQ_AP = (h) => [[D, 'HQ-T4', NM, h, '', 'x', '']];
const OT = (emp, a, b, h) => ({ id: 'o' + emp + a, emp_id: emp, name: NM, kind: 'ot', date: D, start: a, end: b, hours: h, status: 'approved' });
const need = (r) => (r ? J({ rules: rules(r).sort(), ot: r.need.ot_hours, lv: r.need.leave_hours }) : null);
ok('總部出差單 4（沒核定）＋金山 4.75＝8.75：金山先核就要在金山開 0.75 小時加班單（跟總部先核時一模一樣），字多「（含總部出差單 4 小時）」', () => {
  const tripOnly = jsCheck(NEW(chenBooks({ hqReqs: [T4] }), 'mztjs'), 4.75);
  const hqFirst = jsCheck(NEW(chenBooks({ hqReqs: [T4], hqApproved: HQ_AP(4) }), 'mztjs'), 4.75);
  const oldHqFirst = jsCheck(OLD(chenBooks({ hqReqs: [T4], hqApproved: HQ_AP(4) }), 'mztjs'), 4.75);
  assert.deepStrictEqual(need(tripOnly), { rules: ['ot_hours'], ot: 0.75, lv: 0 });
  assert.deepStrictEqual(need(tripOnly), need(hqFirst));
  assert.strictEqual(JSON.stringify(hqFirst), JSON.stringify(oldHqFirst), '總部已核定時新舊逐字相同');
  assert.deepStrictEqual(J(tripOnly.probs.map((p) => p.text)), ['兩家上班合計 8.75 小時（含總部出差單 4 小時），超過 8 的部分要在這家（被支援）開 0.75 小時加班單（已核准 0 小時）']);
  // 之後總部核 4（金山已核定 4.75、沒加班單）：照現有規則擋 ot_peer，跟舊版逐字相同
  const b = chenBooks({ hqReqs: [T4], jsApproved: JS_AP(4.75) });
  assert.deepStrictEqual(rules(hqCheck(NEW(b, 'hq'), 4)), ['ot_peer']);
  assert.strictEqual(JSON.stringify(hqCheck(NEW(b, 'hq'), 4)), JSON.stringify(hqCheck(OLD(b, 'hq'), 4)));
});
ok('先在金山開好 0.75 小時加班單：金山先核過（不再誤說「請先把加班單作廢」）、之後總部核 4 也過；總部先核的順序結果一樣', () => {
  const ot = OT('MZTJST15', '20:30', '21:15', 0.75);
  assert.strictEqual(jsCheck(NEW(chenBooks({ hqReqs: [T4], jsReqs: [ot] }), 'mztjs'), 4.75), null);
  assert.strictEqual(hqCheck(NEW(chenBooks({ hqReqs: [T4], jsReqs: [ot], jsApproved: JS_AP(4.75) }), 'hq'), 4), null);
  assert.strictEqual(hqCheck(NEW(chenBooks({ hqReqs: [T4], jsReqs: [ot] }), 'hq'), 4), null, '總部先核（金山有卡沒核）照舊先放行');
  assert.strictEqual(jsCheck(NEW(chenBooks({ hqReqs: [T4], jsReqs: [ot], hqApproved: HQ_AP(4) }), 'mztjs'), 4.75), null);
  assert.ok(rules(jsCheck(OLD(chenBooks({ hqReqs: [T4], jsReqs: [ot] }), 'mztjs'), 4.75)).includes('ot_void'), '舊版金山先核會誤判 ot_void');
});
ok('合計剛好 8（3.25＋4.75）不要求加班單；開了加班單反而要作廢（跟總部已核定時一樣）', () => {
  assert.strictEqual(jsCheck(NEW(chenBooks(), 'mztjs'), 4.75), null);
  const ot = OT('MZTJST15', '20:30', '21:15', 0.75);
  const a = jsCheck(NEW(chenBooks({ jsReqs: [ot] }), 'mztjs'), 4.75), b = jsCheck(NEW(chenBooks({ jsReqs: [ot], hqApproved: HQ_AP(3.25) }), 'mztjs'), 4.75);
  assert.deepStrictEqual(need(a), need(b)); assert.ok(rules(a).includes('ot_hours'), JSON.stringify(a));
});
ok('加班單開在錯的那家（開在總部、該開在金山）：兩種順序要求一樣——金山要 0.75；總部後核被說加班單太多＋金山要開', () => {
  const otHq = OT('HQ-T4', '12:15', '13:00', 0.75);
  const a = jsCheck(NEW(chenBooks({ hqReqs: [T4, otHq] }), 'mztjs'), 4.75), b = jsCheck(NEW(chenBooks({ hqReqs: [T4, otHq], hqApproved: HQ_AP(4) }), 'mztjs'), 4.75);
  assert.deepStrictEqual(need(a), { rules: ['ot_hours'], ot: 0.75, lv: 0 }); assert.deepStrictEqual(need(a), need(b));
  const h = hqCheck(NEW(chenBooks({ hqReqs: [T4, otHq], jsApproved: JS_AP(4.75) }), 'hq'), 4);
  assert.strictEqual(JSON.stringify(h), JSON.stringify(hqCheck(OLD(chenBooks({ hqReqs: [T4, otHq], jsApproved: JS_AP(4.75) }), 'hq'), 4)));
  assert.ok(rules(h).includes('ot_peer') && rules(h).includes('ot_hours'), JSON.stringify(h));
});
ok('不走「先放行」：金山 9 小時沒加班單＋總部只有出差單 3.25 → 照「總部已核定 3.25」要 4.25 小時加班單，不是放行', () => {
  const b = chenBooks({ jsEvents: [[D + 'T11:55:00+08:00', 'MZTJST15', 'in', 'ok', ''], [D + 'T21:20:00+08:00', 'MZTJST15', 'out', 'ok', '']] });
  const run = (sb) => sb.reqBindCheck_(sb.getSS(), 'MZTJST15', D, 9, [P('12:00', '21:00')], [S('11:55', '21:20')], null,
    { sched_ft: true, sched_day: 'W', sched_support: true, sched_home: 'hq', name: NM, rows: [], leaves: [], trip_hours: 0, acting: true, own_fs: 720 });
  const nw = run(NEW(b, 'mztjs'));
  const b2 = chenBooks({ jsEvents: b.mztjs.events, hqApproved: HQ_AP(3.25) });
  assert.deepStrictEqual(need(nw), { rules: ['ot_hours'], ot: 4.25, lv: 0 });
  assert.deepStrictEqual(need(nw), need(run(NEW(b2, 'mztjs'))));
  const pr = NEW(b, 'mztjs').reqPeerDay_(NM, D);
  assert.strictEqual(pr.worked, true); assert.strictEqual(pr.pending, false, '只有出差單的那家不是 pending');
  assert.deepStrictEqual(J(pr.names), []); assert.deepStrictEqual(J(pr.by), { hq: { work: 3.25, ot: 0, pending: false, fs: null, trip: 3.25 } });
  assert.strictEqual(pr.work, 3.25); assert.strictEqual(pr.trip, 3.25); assert.deepStrictEqual(J(pr.tnames), ['hq']);
});
ok('原單位那邊也一樣：總部（原單位）核、金山（支援）只有出差單 2 沒核定 → 跟金山已核定 2 時要求相同', () => {
  const b = chenBooks({ jsEvents: [], jsReqs: [{ id: 'j1', emp_id: 'MZTJST15', name: NM, kind: 'trip', date: D, leave_type: '出差', start: '18:00', end: '20:00', hours: 2, status: 'approved' }],
    hqEvents: [[D + 'T08:55:00+08:00', 'HQ-T4', 'in', 'ok', ''], [D + 'T16:05:00+08:00', 'HQ-T4', 'out', 'ok', '']], hqReqs: [] });
  const run = (sb, h) => sb.reqBindCheck_(sb.getSS(), 'HQ-T4', D, h, [P('09:00', '16:00')], [S('08:55', '16:05')], null,
    { sched_ft: true, sched_day: 'W', sched_support: false, name: NM, rows: [], leaves: [], trip_hours: 0, acting: true, own_fs: 540 });
  const b2 = chenBooks({ jsEvents: [], jsReqs: b.mztjs.requests, jsApproved: JS_AP(2, ''), hqEvents: b.hq.events, hqReqs: [] });
  const a = run(NEW(b, 'hq'), 7), c = run(NEW(b2, 'hq'), 7);
  assert.deepStrictEqual(need(a), need(c)); assert.ok(rules(a).includes('ot_peer'), JSON.stringify(a));
});
ok('重找別家：第三家當天剛加的支援帳號（名冊快取裡還沒有）有打卡，別家有出差單時照樣重找 → 先放行（跟舊版一樣）', () => {
  const books = () => { const b = chenBooks({ hqReqs: [tripReq({ hours: 2 })] });
    b.mztgf = { roster: [['MZTGFT88', NM, 'true']], events: [[D + 'T10:00:00+08:00', 'MZTGFT88', 'in', 'ok', ''], [D + 'T12:00:00+08:00', 'MZTGFT88', 'out', 'ok', '']], approved: [], requests: [] }; return b; };
  const stale = (sb) => { sb.CacheService = { getScriptCache: () => ({ get: (k) => (k === 'rpr:ss-mztgf' ? JSON.stringify([['別人', 'X1']]) : null), put() {} }) }; return sb; };
  assert.strictEqual(jsCheck(stale(OLD(books(), 'mztjs')), 4.75), null);
  assert.strictEqual(jsCheck(stale(NEW(books(), 'mztjs')), 4.75), null);
  // 沒有第三家時：重找後仍只有總部出差單 2 → 照算 6.75 擋
  const b = chenBooks({ hqReqs: [tripReq({ hours: 2 })] });
  assert.deepStrictEqual(ft8Text(jsCheck(stale(NEW(b, 'mztjs')), 4.75)), [MSG('：這家 4.75＋總部出差單 2＝6.75 小時，還差 1.25 小時')]);
});
ok('隨機 1500 組：別家「只有出差單、沒核定」vs「已核定那麼多小時出差」，這家被要求的單（規則、加班時數、還差幾小時、過或擋）完全相同', () => {
  const R = rnd(1123);
  const pick = (a) => a[Math.floor(R() * a.length)];
  let n2 = 0, blocked = 0;
  for (let i = 0; i < 1500; i++) {
    const tp = pick([0.5, 1, 2, 3.25, 4, 6, 8]), h = pick([2, 3.75, 4.75, 5, 6, 8, 9]), otH = pick([0, 0, 0.75, 1, 2]);
    const sup = pick([true, false, null]), home = pick(['hq', '']), lvH = pick([0, 0, 1]);
    const reqs = [tripReq({ hours: tp })].concat(lvH ? [{ id: 'l', emp_id: 'HQ-T4', name: NM, kind: 'leave', leave_type: '事假', date: D, start: '', end: '', hours: lvH, status: 'approved' }] : []);
    const jsReqs = otH ? [OT('MZTJST15', '21:15', '23:59', otH)] : [];
    const mk = (ap) => chenBooks({ hqReqs: reqs, jsReqs, hqApproved: ap });
    const end = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const run = (sb) => sb.reqBindCheck_(sb.getSS(), 'MZTJST15', D, h, [P('12:00', end(720 + h * 60))], [S('11:58', end(720 + h * 60 + 2))], null,
      { sched_ft: true, sched_day: 'W', sched_support: sup, sched_home: home, name: NM, rows: sb.reqRows_(sb.getSS()), leaves: [], trip_hours: 0, acting: true, own_fs: 720, diff_reason: 'x', force_ot_punch: false });
    const a = run(NEW(mk([]), 'mztjs')), b = run(NEW(mk(HQ_AP(tp)), 'mztjs'));
    assert.deepStrictEqual(need(a), need(b), JSON.stringify({ tp, h, otH, sup, home, lvH, a: a && a.message, b: b && b.message }));
    n2++; if (a) blocked++;
  }
  assert.ok(blocked > 200 && blocked < n2, '過、擋都要有（擋 ' + blocked + '／' + n2 + '）');
  console.log('   （擋 ' + blocked + '／' + n2 + '）');
});
ok('總部那邊（原單位）：金山已核定 6、總部出差 3.25 → 合計 9.25 照現有跨店加班規則要金山開 1.25 小時加班單（新舊逐字相同）', () => {
  const b = chenBooks({ jsApproved: [[D, 'MZTJST15', NM, 6, '15:30-21:30', 'x', '']] });
  const nw = hqCheck(NEW(b, 'hq'), 3.25), od = hqCheck(OLD(b, 'hq'), 3.25);
  assert.ok(rules(nw).includes('ot_peer'), JSON.stringify(nw));
  assert.strictEqual(JSON.stringify(nw), JSON.stringify(od));
});
ok('Mac mini 帶來的別家摘要（peer_given）：新版摘要多帶 tp、收的那邊留著 tp，結果跟自己開別家逐字相同而且沒開別家', () => {
  const b = chenBooks();
  const sbD = NEW(b, 'hq');
  const dig = sbD.reqPeerDigest_(sbD.SpreadsheetApp.openById('ss-hq'), D);
  assert.strictEqual(JSON.stringify(dig[NM]), JSON.stringify({ w: false, r: 0, work: 0, lv: 0, ot: 0, fs: null, tp: 3.25 }));
  const base = NEW(b, 'mztjs').reqPeerDay_(NM, D);
  const sb = NEW(b, 'mztjs');
  sb.READ_MEMO_ = {}; sb.REQ_PEER_GIVEN_ = sb.reqPeerGivenParse_({ hq: { date: D, people: JSON.parse(JSON.stringify(dig)) } }, D);
  sb.__opened.length = 0;
  const r = sb.reqPeerDay_(NM, D);
  assert.strictEqual(JSON.stringify(r), JSON.stringify(base));
  assert.deepStrictEqual(J(sb.__opened), []);
  assert.strictEqual(jsCheck(sb, 4.75), null);
  // 摘要格式：tp 不是正數、不是有限數字就不收
  const g = sb.reqPeerGivenParse_({ hq: { date: D, people: { a: { r: 0, tp: -1 }, b: { r: 0, tp: 'x' }, c: { r: 0, tp: 'Infinity' }, d: { r: 0, tp: '2.5' } } } }, D);
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((k) => g.by.hq[k].tp), [undefined, undefined, undefined, 2.5]);
  assert.deepStrictEqual(J(Object.keys(g.by.hq.a)), ['w', 'r', 'work', 'lv', 'ot', 'fs']);
});
ok('上線途中混著新舊版（滿 8 小時這條）：別家還是舊版（摘要沒有 tp）或收的那邊還是舊版（不認 tp），結果等於舊版的「擋」', () => {
  const b = chenBooks();
  const oldDig = OLD(b, 'hq'); const d0 = oldDig.reqPeerDigest_(oldDig.SpreadsheetApp.openById('ss-hq'), D);
  assert.strictEqual(d0[NM], undefined, '舊版摘要不放只有出差單的人');
  const s1 = NEW(b, 'mztjs'); s1.READ_MEMO_ = {}; s1.REQ_PEER_GIVEN_ = s1.reqPeerGivenParse_({ hq: { date: D, people: d0 } }, D);
  assert.deepStrictEqual(ft8Text(jsCheck(s1, 4.75)), [MSG('（上班 4.75＋出差 0＋假單 0＝4.75 小時），還差 3.25 小時')]);
  const newDig = NEW(b, 'hq'); const d1 = newDig.reqPeerDigest_(newDig.SpreadsheetApp.openById('ss-hq'), D);
  const s2 = OLD(b, 'mztjs'); s2.READ_MEMO_ = {}; s2.REQ_PEER_GIVEN_ = s2.reqPeerGivenParse_({ hq: { date: D, people: JSON.parse(JSON.stringify(d1)) } }, D);
  assert.deepStrictEqual(rules(jsCheck(s2, 4.75)), ['ft8'], '舊版收的那邊照舊擋');
});
ok('別家有卡還沒核定（pending）又有出差單：照現況先放行，不因出差單改變', () => {
  const b = chenBooks({ hqEvents: [[D + 'T08:00:00+08:00', 'HQ-T4', 'in', 'ok', '']] });
  assert.strictEqual(jsCheck(NEW(b, 'mztjs'), 2), null);
  assert.strictEqual(jsCheck(OLD(b, 'mztjs'), 2), null);
});
ok('兩家以上：金山已核定 2＋總部出差單 3.25（總部未核定），在光復墨竹亭核 2 → 「這家 2＋金山 2＋總部出差單 3.25＝7.25」擋', () => {
  const b = chenBooks({ jsApproved: [[D, 'MZTJST15', NM, 2, '15:30-17:30', 'x', '']] });
  b.mztgf = { roster: [['MZTGF9', NM, 'true']], events: [], approved: [], requests: [] };
  const sb = NEW(b, 'mztgf');
  const r = sb.reqBindCheck_(sb.getSS(), 'MZTGF9', D, 2, [P('09:00', '11:00')], [S('08:58', '11:01')], null,
    { sched_ft: true, sched_day: 'W', sched_support: true, sched_home: 'hq', name: NM, rows: [], leaves: [], trip_hours: 0, acting: true, own_fs: 540 });
  assert.deepStrictEqual(ft8Text(r), [MSG('：這家 2＋墨竹亭新竹金山 2＋總部出差單 3.25＝7.25 小時，還差 0.75 小時')]);
});

// ── 沒有出差單（或出差單只在已核定的別家／自己這家）時，跟舊版逐位元組相同（隨機對照）──
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomWorld(R, tripMode) {
  const codes = ['hq', 'cf', 'mztjs', 'mztgf', 'gf', 'mztlzl'];
  const pick = (a) => a[Math.floor(R() * a.length)];
  const books = {};
  const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  codes.forEach((c, ci) => {
    if (R() < 0.15) return;          // 這家不在名單
    const id = c.toUpperCase() + '1', roster = [[id, '甲', R() < 0.92 ? 'true' : 'false']];
    if (R() < 0.08) roster.push([c.toUpperCase() + '2', '甲', 'true']);   // 同名兩位
    roster.push([c.toUpperCase() + '9', '乙', 'true']);
    const events = [], approved = [], requests = [];
    const mirror = c === 'hq' && R() < 0.3 ? 'CF' : '';
    if (R() < 0.6) {
      const st = 360 + Math.floor(R() * 14) * 60, len = 60 + Math.floor(R() * 9) * 45;
      events.push([D + 'T' + hhmm(st) + ':00+08:00', id, 'in', R() < 0.95 ? 'ok' : 'pending', mirror]);
      if (R() < 0.85) events.push([D + 'T' + hhmm(Math.min(st + len, 1439)) + ':00+08:00', id, 'out', 'ok', mirror]);
      if (R() < 0.55) approved.push([D, id, '甲', Math.round(len / 15) / 4, hhmm(st) + '-' + hhmm(Math.min(st + len, 1439)), 'x', R() < 0.1 ? 'CF' : '']);
    } else if (R() < 0.3) approved.push([D, id, '甲', pick([2, 3.25, 4, 8]), '', 'x', '']);
    if (R() < 0.25) events.push(['2026-11-05T23:00:00+08:00', id, 'in', 'ok', ''], [D + 'T02:00:00+08:00', id, 'out', 'ok', '']);   // 跨夜凌晨下班卡
    const kinds = ['leave', 'ot', 'miss'].concat(tripMode ? ['trip'] : []);
    const nreq = Math.floor(R() * 4);
    for (let k = 0; k < nreq; k++) {
      const kind = pick(kinds);
      requests.push({ id: c + k, emp_id: pick([id, id, c.toUpperCase() + '9']), name: '甲', kind, date: R() < 0.9 ? D : '2026-11-07', leave_type: kind === 'leave' ? pick(['事假', '病假', '補休']) : kind === 'trip' ? '出差' : '',
        start: '09:00', end: '10:00', hours: pick([0.5, 1, 2.25, 3.25, 4]), status: pick(['approved', 'approved', 'pending', 'rejected', 'voided', 'cancelled']), mirror_src: R() < 0.05 ? 'CF' : '', miss_type: kind === 'miss' ? 'in' : '' });
    }
    books[c] = { roster, events, approved, requests };
    if (R() < 0.03) books[c].broken = true;
  });
  return books;
}
const SELF_CODES = ['hq', 'cf', 'mztjs', 'mztgf', 'gf', 'mztlzl'];
function compareWorld(books, self, R) {
  const optBase = () => ({ sched_ft: R() < 0.9, sched_day: ['W', 'W', 'W', 'H', 'R', ''][Math.floor(R() * 6)], sched_support: [true, false, null][Math.floor(R() * 3)], sched_home: R() < 0.5 ? 'hq' : '',
    name: '甲', leaves: [], trip_hours: R() < 0.15 ? 1 : 0, acting: true, own_fs: 600 });
  const hours = [0, 1, 2, 3.25, 4, 4.75, 6, 7.75, 8, 9, 10][Math.floor(R() * 11)];
  const opt = optBase();
  const selfRows = [];
  if (R() < 0.4) selfRows.push({ id: 's1', emp_id: 'SELF1', kind: 'leave', leave_type: '事假', date: D, start: '08:00', end: '09:00', hours: 1, status: 'approved' });
  if (R() < 0.3) selfRows.push({ id: 's2', emp_id: 'SELF1', kind: 'ot', date: D, start: '20:00', end: '21:00', hours: 1, status: 'approved' });
  if (R() < 0.2) selfRows.push({ id: 's3', emp_id: 'SELF1', kind: 'trip', leave_type: '出差', date: D, start: '07:00', end: '08:00', hours: 1, status: 'approved' });   // 自己這家的出差單：本來就算在核定裡，跟這次改動無關
  const per = [P('10:00', '14:00')], seg = [S('09:58', '14:02')];
  const out = {};
  [['new', NEW], ['old', OLD]].forEach(([k, mkEnv]) => {
    const sb = mkEnv(books, self);
    const o = Object.assign({ rows: selfRows }, JSON.parse(JSON.stringify(opt)));
    let a, b, c, d;
    try { a = sb.reqPeerDay_('甲', D); } catch (e) { a = 'ERR ' + e.message; }
    try { b = sb.reqPeerDay_('甲', D, true); } catch (e) { b = 'ERR ' + e.message; }
    try { c = sb.reqBindCheck_(sb.getSS(), 'SELF1', D, hours, per, seg, null, o); } catch (e) { c = 'ERR ' + e.message; }
    try { d = sb.reqFt8_(D, hours, 0, Object.assign({}, o), selfRows.filter((r) => r.status === 'approved')); } catch (e) { d = 'ERR ' + e.message; }
    const digs = {};
    Object.keys(books).forEach((cc) => { if (books[cc].broken) return; try { digs[cc] = sb.reqPeerDigest_(sb.SpreadsheetApp.openById('ss-' + cc), D); } catch (e) { digs[cc] = 'ERR ' + e.message; } });
    out[k] = JSON.stringify({ a, b, c, d, digs });
  });
  return out;
}
ok('隨機 3000 組（別家沒有任何出差單）：reqPeerDay_／重找／reqBindCheck_／reqFt8_／每家摘要 跟舊版逐位元組相同', () => {
  const R = rnd(20261123);
  let diff = 0, blocked = 0, tripOwn = 0;
  for (let i = 0; i < 3000; i++) {
    const books = randomWorld(R, false);
    const self = SELF_CODES[Math.floor(R() * SELF_CODES.length)];
    if (books[self]) { books[self].roster.push(['SELF1', '甲', 'true']); } else books[self] = { roster: [['SELF1', '甲', 'true']], events: [], approved: [], requests: [] };
    books[self].broken = false;
    const o = compareWorld(books, self, R);
    if (o.new !== o.old) { diff++; if (diff <= 3) console.log('不同：', o.new.slice(0, 400), '\n舊：', o.old.slice(0, 400)); }
    if (/need_request/.test(o.new)) blocked++;
    if (/"s3"/.test(JSON.stringify(books))) tripOwn++;
  }
  assert.strictEqual(diff, 0);
  assert.ok(blocked > 300, '對照有效：要有足夠多被擋的組合（' + blocked + '）');
  console.log('   （被擋 ' + blocked + ' 組）');
});
ok('隨機 3000 組（出差單只在已核定的別家、或狀態不是已核准）：跟舊版逐位元組相同', () => {
  const R = rnd(777);
  let diff = 0, withTrip = 0;
  for (let i = 0; i < 3000; i++) {
    const books = randomWorld(R, true);
    Object.keys(books).forEach((c) => {
      const b = books[c], ids = b.roster.map((r) => r[0]);
      const approvedIds = new Set(b.approved.filter((r) => r[0] === D && !r[6]).map((r) => r[1]));
      b.requests.forEach((r) => {
        if (r.kind !== 'trip') return;
        withTrip++;
        if (r.status === 'approved' && r.date === D && !r.mirror_src && ids.includes(r.emp_id) && !approvedIds.has(r.emp_id)) r.status = 'pending';   // 只留「不該算」的出差單
      });
    });
    const self = SELF_CODES[Math.floor(R() * SELF_CODES.length)];
    if (books[self]) { books[self].roster.push(['SELF1', '甲', 'true']); } else books[self] = { roster: [['SELF1', '甲', 'true']], events: [], approved: [], requests: [] };
    books[self].broken = false;
    const o = compareWorld(books, self, R);
    if (o.new !== o.old) { diff++; if (diff <= 3) console.log('不同：', o.new.slice(0, 600), '\n舊：', o.old.slice(0, 600)); }
  }
  assert.strictEqual(diff, 0);
  assert.ok(withTrip > 500, '對照有效：要有足夠多的出差單（' + withTrip + '）');
});
ok('對照組（證明上面的比對抓得到差異）：別家有已核准、未核定的出差單時，隨機組合裡要出現新舊不同', () => {
  const R = rnd(4242);
  let diff = 0;
  for (let i = 0; i < 800; i++) {
    const books = randomWorld(R, true);
    const self = SELF_CODES[Math.floor(R() * SELF_CODES.length)];
    if (books[self]) { books[self].roster.push(['SELF1', '甲', 'true']); } else books[self] = { roster: [['SELF1', '甲', 'true']], events: [], approved: [], requests: [] };
    books[self].broken = false;
    const o = compareWorld(books, self, R);
    if (o.new !== o.old) diff++;
  }
  assert.ok(diff > 20, '差異組數 ' + diff);
  console.log('   （800 組裡 ' + diff + ' 組不同＝比對有效）');
});
console.log('全部 ' + n + ' 項通過');
