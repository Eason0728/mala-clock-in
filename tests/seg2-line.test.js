/* 一次填兩段（LINE 申請頁前端，2026-11-18 Eason）的純函式測試。
 * 載入真的 req-line.js（檔尾多掛一個測試用出口），測：
 *  ① segCheck：重疊、接在一起（含跨夜）、合計超過上限、沒填完整，訊息與確認頁一致
 *  ② seg2Open／seg2Ok／segsOf／otMaxH：req_info 的 seg2_kinds 沒給或沒開＝一律不出現「加第二段」；生理假不出現；單張上限 10
 *  ③ N4：事假不再出現「本月第 N 次」、「本月事假合計」照舊
 *  ④ otAbsorb（防呆）：兩家合計超過 8 小時時，該吸收加班的是被支援那家；判斷不出來一律回 null
 * 畫面、送出內容、我的申請的標記在 e2e/req_seg2.py（要瀏覽器）。 */
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const FILE = path.join(__dirname, '..', 'req-line.js');
const src = fs.readFileSync(FILE, 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const hooked = src.replace(TAIL, TAIL + ' window.__t = { st: st, segCheck: segCheck, segOverlap: segOverlap, segTouch: segTouch, seg2Open: seg2Open, seg2Ok: seg2Ok, segsOf: segsOf,' +
  ' segMax: segMax, otMaxH: otMaxH, segHours: segHours, preWarns: preWarns, otAbsorb: otAbsorb, unitOf: unitOf, sameUnit: sameUnit, dayWork: dayWork,' +
  ' segStoreSplit: segStoreSplit, storeByDay: storeByDay, groupKey: groupKey };');
const sb = { window: {}, document: {}, console, Promise, setTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
vm.createContext(sb);
vm.runInContext(hooked, sb, { filename: 'req-line.js' });
const T = sb.window.__t;
const J = (x) => JSON.parse(JSON.stringify(x));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const S = (a, b) => ({ start: a, end: b });

// ── ① 兩段檢查 ──
ok('兩段不重疊、合計 7 小時 → 過', () => assert.strictEqual(T.segCheck('ot', [S('11:00', '14:00'), S('17:00', '21:00')], 10), null));
ok('重疊：訊息照確認頁「兩段時間重疊（11:00–14:00、13:00–15:00），請改時間」', () => {
  const r = J(T.segCheck('ot', [S('11:00', '14:00'), S('13:00', '15:00')], 10));
  assert.strictEqual(r.error, 'seg_overlap'); assert.strictEqual(r.message, '兩段時間重疊（11:00–14:00、13:00–15:00），請改時間');
});
ok('接在一起（14:00 結束、14:00 開始）→ 請直接填成一段 11:00–17:00；順序顛倒也一樣', () => {
  assert.strictEqual(J(T.segCheck('ot', [S('11:00', '14:00'), S('14:00', '17:00')], 10)).message, '兩段接在一起，請直接填成一段 11:00–17:00');
  assert.strictEqual(J(T.segCheck('ot', [S('14:00', '17:00'), S('11:00', '14:00')], 10)).message, '兩段接在一起，請直接填成一段 11:00–17:00');
  assert.strictEqual(J(T.segCheck('ot', [S('11:00', '14:00'), S('14:00', '17:00')], 10)).error, 'seg_touch');
});
ok('合計超過上限：兩段合計 11 小時，超過 10 小時，請確認時間（請假、出差上限 8）', () => {
  assert.strictEqual(J(T.segCheck('ot', [S('08:00', '13:00'), S('14:00', '20:00')], 10)).message, '兩段合計 11 小時，超過 10 小時，請確認時間');
  assert.strictEqual(J(T.segCheck('leave', [S('08:00', '12:00'), S('13:00', '18:00')], 8)).message, '兩段合計 9 小時，超過 8 小時，請確認時間');
  assert.strictEqual(T.segCheck('trip', [S('09:00', '12:00'), S('13:00', '16:00')], 8), null, '3＋3＝6 ≤ 8');
  assert.strictEqual(T.segCheck('ot', [S('08:00', '13:00'), S('14:00', '19:00')], 10), null, '剛好 10 小時可以');
});
ok('沒填完整／起訖一樣：標第幾段（seg）、字句同後端', () => {
  assert.deepStrictEqual(J(T.segCheck('ot', [S('11:00', '14:00'), S('', '')], 10)), { error: 'bad_time', seg: 2, message: '第二段：請填完整的加班時段' });
  assert.deepStrictEqual(J(T.segCheck('leave', [S('', '14:00'), S('15:00', '16:00')], 8)), { error: 'bad_time', seg: 1, message: '第一段：請填完整的請假時段' });
  assert.deepStrictEqual(J(T.segCheck('trip', [S('09:00', '10:00'), S('11:00', '11:00')], 8)), { error: 'bad_time', seg: 2, message: '第二段：開始和結束時間一樣，請確認' });
});
ok('跨夜照現有算法：22:00–01:00 與 00:00–02:00 重疊、22:00–00:00 與 00:00–02:00 接在一起（22:00–02:00）、20:00–23:00 與 00:30–01:30 不衝突', () => {
  assert.strictEqual(J(T.segCheck('ot', [S('22:00', '01:00'), S('00:00', '02:00')], 10)).error, 'seg_overlap');
  const t = J(T.segCheck('ot', [S('22:00', '00:00'), S('00:00', '02:00')], 10));
  assert.strictEqual(t.error, 'seg_touch'); assert.strictEqual(t.message, '兩段接在一起，請直接填成一段 22:00–02:00');
  assert.strictEqual(T.segCheck('ot', [S('20:00', '23:00'), S('00:30', '01:30')], 10), null);
});
ok('segOverlap／segTouch 跟後端 reqOverlap_／reqSegTouch_ 同一套：隨機 3000 組結果一致', () => {
  // 後端兩個函式原文抄進沙盒當裁判
  const gs = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Requests.gs'), 'utf8');
  const ex = (name) => { const i = gs.indexOf('function ' + name + '('); let d = 0, j = gs.indexOf('{', i); for (; j < gs.length; j++) { if (gs[j] === '{') d++; else if (gs[j] === '}' && --d === 0) { j++; break; } } return gs.slice(i, j); };
  const ref = {}; vm.createContext(ref);
  vm.runInContext(['reqMin_', 'reqOverlap_', 'reqSegTouch_'].map(ex).join('\n'), ref);
  let seed = 7; const rnd = (m) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % m; };
  const hm = () => ('0' + rnd(24)).slice(-2) + ':' + ['00', '15', '30', '45'][rnd(4)];
  for (let i = 0; i < 3000; i++) {
    const a = hm(), b = hm(), c = hm(), d = hm();
    assert.strictEqual(T.segOverlap(a, b, c, d), ref.reqOverlap_(a, b, c, d), 'overlap ' + [a, b, c, d]);
    assert.strictEqual(T.segTouch(a, b, c, d), ref.reqSegTouch_(a, b, c, d), 'touch ' + [a, b, c, d]);
  }
});

// ── ② 開關：req_info 沒給／沒開＝不出現 ──
const info = (o) => { T.st.info = o; };
ok('舊後端（req_info 沒有 seg2_kinds）、空陣列、沒開這種單 → 三種單都不出現「加第二段」', () => {
  [null, {}, { seg2_kinds: [] }, { seg2_kinds: 'ot' }].forEach((i) => { info(i); ['ot', 'leave', 'trip'].forEach((k) => { assert.strictEqual(T.seg2Open(k), false); assert.strictEqual(T.seg2Ok(k, '病假'), false); }); });
  info({ seg2_kinds: ['ot'] }); assert.strictEqual(T.seg2Ok('ot', ''), true); assert.strictEqual(T.seg2Ok('leave', '病假'), false); assert.strictEqual(T.seg2Ok('trip', ''), false);
});
ok('開了 leave：生理假不出現、其他假別出現；seg2_no_types 有給就照給的', () => {
  info({ seg2_kinds: ['ot', 'leave', 'trip'], seg2_no_types: ['生理假'] });
  assert.strictEqual(T.seg2Ok('leave', '生理假'), false); assert.strictEqual(T.seg2Ok('leave', '病假'), true); assert.strictEqual(T.seg2Ok('leave', ''), true);
  info({ seg2_kinds: ['leave'] }); assert.strictEqual(T.seg2Ok('leave', '生理假'), false, '沒給 seg2_no_types 也預設擋生理假');
  info({ seg2_kinds: ['leave'], seg2_no_types: ['生理假', '事假'] }); assert.strictEqual(T.seg2Ok('leave', '事假'), false);
});
ok('ot_segments_max 是 1（開關關掉的後端）→ 加班不出現', () => { info({ seg2_kinds: ['ot'], ot_segments_max: 1 }); assert.strictEqual(T.seg2Open('ot'), false); });
ok('segsOf：沒加第二段或這張不能加 → null；加了 → 兩段；整天模式由呼叫端不傳', () => {
  info({ seg2_kinds: ['ot', 'leave'] });
  assert.strictEqual(T.segsOf({ start: '09:00', end: '10:00', seg2: null }, 'ot', ''), null);
  assert.deepStrictEqual(J(T.segsOf({ start: '09:00', end: '10:00', seg2: { start: '11:00', end: '12:00' } }, 'ot', '')), [S('09:00', '10:00'), S('11:00', '12:00')]);
  assert.strictEqual(T.segsOf({ start: '09:00', end: '10:00', seg2: { start: '11:00', end: '12:00' } }, 'leave', '生理假'), null, '資料留著但這張不能送兩段');
  info({ seg2_kinds: [] }); assert.strictEqual(T.segsOf({ start: '09:00', end: '10:00', seg2: { start: '11:00', end: '12:00' } }, 'ot', ''), null);
});
ok('N1：單張加班上限 10 小時（沒給 ot_max_h＝10；後端有給就照給的）、兩段合計上限預設 10／8／8', () => {
  info({}); assert.strictEqual(T.otMaxH(), 10);
  info({ ot_max_h: 10 }); assert.strictEqual(T.otMaxH(), 10);
  info({ ot_max_h: 8 }); assert.strictEqual(T.otMaxH(), 8);
  info({}); assert.deepStrictEqual([T.segMax('ot'), T.segMax('leave'), T.segMax('trip')], [10, 8, 8]);
  info({ seg2_max_h: { ot: 10, leave: 6, trip: 8 } }); assert.strictEqual(T.segMax('leave'), 6);
});

// ── ③ N4：事假提醒 ──
ok('N4：事假不再出現「本月第 N 次」；「本月事假合計」照舊；事後才請的提醒照舊', () => {
  const ym = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
  const mk = (d, h) => ({ kind: 'leave', leave_type: '事假', status: 'pending', date: ym + '-' + d, hours: h });
  info({ requests: [mk('02', 8), mk('03', 8), mk('04', 8), mk('05', 8)] });   // 本月已經 4 次、32 小時
  const w = T.preWarns('leave', '事假', ym + '-28', 8);
  assert.ok(!w.some((x) => /第 \d+ 次/.test(x)), '還有「第 N 次」：' + w);
  assert.ok(w.some((x) => /本月事假合計 5 天，超過 3 天/.test(x)), '合計提醒不見了：' + w);
  info({ requests: [mk('02', 8), mk('03', 8)] });
  assert.deepStrictEqual(J(T.preWarns('leave', '事假', ym + '-28', 4)).filter((x) => /本月/.test(x)), [], '第 3 次、合計 20 小時：什麼都不提醒');
  assert.ok(!/本月第/.test(src), 'req-line.js 還有「本月第」');
});

// ── ④ 防呆：該吸收加班的那家 ──
const sp = (a, b) => ({ in: a, out: b, out_next: false });
const D = (...spans) => ({ date: '2026-11-17', punches: [], missing: { options: [], spans } });
const R = (code, name, day) => ({ code, name, day });
const HQ = { code: 'hq', name: '鼎兆元 總部' }, JS = { code: 'mztjs', name: '墨竹亭 新竹金山' }, GF = { code: 'mztgf', name: '墨竹亭 新竹光復' }, SSL = { code: '', name: '小辛辣 新竹光復' }, CF = { code: 'cf', name: '鼎兆元 中央廚房' };
const stores = (...a) => a.map(([c, sup]) => (sup === undefined ? { code: c } : { code: c, support: sup }));
ok('張淳 11/17：總部（原單位）6.75＋金山（支援）2＝8.75 → 該開在金山', () => {
  const r = J(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '14:45'))), R('mztjs', JS.name, D(sp('15:00', '17:00')))], stores(['hq', false], ['mztjs', true]), null));
  assert.strictEqual(r.code, 'mztjs'); assert.strictEqual(r.total, 8.75); assert.strictEqual(r.over, 0.75); assert.strictEqual(r.home.code, 'hq');
});
ok('合計剛好 8 小時（張淳 11/16：5＋3）→ 不提示', () => {
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '13:00'))), R('mztjs', JS.name, D(sp('14:00', '17:00')))], stores(['hq', false], ['mztjs', true]), null), null);
});
ok('只有一家有打卡、或原單位沒打卡 → 不提示', () => {
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '19:00'))), R('mztjs', JS.name, D())], stores(['hq', false], ['mztjs', true]), null), null);
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D()), R('mztjs', JS.name, D(sp('08:00', '19:00')))], stores(['hq', false], ['mztjs', true]), null), null);
});
ok('後端沒帶 support（舊後端）／有店缺 support／原單位不是剛好一家／有店問不到 → 判斷不出來，不提示', () => {
  const res = [R('hq', HQ.name, D(sp('08:00', '14:45'))), R('mztjs', JS.name, D(sp('15:00', '17:00')))];
  assert.strictEqual(T.otAbsorb(res, stores(['hq'], ['mztjs']), null), null);
  assert.strictEqual(T.otAbsorb(res, stores(['hq', false], ['mztjs']), null), null);
  assert.strictEqual(T.otAbsorb(res, stores(['hq', true], ['mztjs', true]), null), null, '沒有原單位');
  assert.strictEqual(T.otAbsorb(res, stores(['hq', false], ['mztjs', false]), null), null, '兩家都是原單位');
  assert.strictEqual(T.otAbsorb([res[0], R('mztjs', JS.name, null)], stores(['hq', false], ['mztjs', true]), null), null);
  assert.strictEqual(T.otAbsorb(null, stores(['hq', false], ['mztjs', true]), null), null);
});
ok('不同單位不相加：小辛辣光復（代碼空字串）原單位＋墨竹亭金山支援 → 不提示；總部原單位＋小辛辣光復支援 → 該開在光復（空字串）', () => {
  assert.strictEqual(T.otAbsorb([R('', SSL.name, D(sp('08:00', '14:00'))), R('mztjs', JS.name, D(sp('15:00', '19:00')))], stores(['', false], ['mztjs', true]), null), null);
  const r = J(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '14:00'))), R('', SSL.name, D(sp('15:00', '19:00')))], stores(['hq', false], ['', true]), null));
  assert.strictEqual(r.code, ''); assert.strictEqual(r.total, 10); assert.strictEqual(r.over, 2);
});
ok('支援兩家以上：時數長的吸收、一樣長算後上班那家；吸收量不超過它自己的時數', () => {
  const st3 = stores(['hq', false], ['mztjs', true], ['mztgf', true]);
  let r = J(T.otAbsorb([R('hq', HQ.name, D(sp('06:00', '10:00'))), R('mztjs', JS.name, D(sp('10:00', '13:00'))), R('mztgf', GF.name, D(sp('14:00', '19:00')))], st3, null));
  assert.strictEqual(r.code, 'mztgf'); assert.strictEqual(r.total, 12); assert.strictEqual(r.over, 4, '超過 8 的有 4，光復自己 5 小時吸得下');
  r = J(T.otAbsorb([R('hq', HQ.name, D(sp('06:00', '10:00'))), R('mztjs', JS.name, D(sp('10:00', '13:00'))), R('mztgf', GF.name, D(sp('14:00', '17:00')))], st3, null));
  assert.strictEqual(r.code, 'mztgf', '一樣長：最早一張卡較晚的（光復 14:00）吸收');
  r = J(T.otAbsorb([R('hq', HQ.name, D(sp('06:00', '14:00'))), R('mztjs', JS.name, D(sp('14:00', '15:00')))], stores(['hq', false], ['mztjs', true]), null));
  assert.strictEqual(r.over, 1, '合計 9，金山自己只有 1 小時，吸收 1');
});
ok('跨夜段與還沒下班：out_next 加一天；今天還沒下班用現在、不是今天（nowMin 沒給）算不出來 → 不提示', () => {
  const night = { in: '20:00', out: '02:00', out_next: true };   // 6 小時
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '10:00'))), R('mztjs', JS.name, D(night))], stores(['hq', false], ['mztjs', true]), null), null, '2＋6＝8 不超過');
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('08:00', '11:00'))), R('mztjs', JS.name, D(night))], stores(['hq', false], ['mztjs', true]), null).total, 9);
  const open = { in: '15:00', out: null, out_next: false };
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('06:00', '14:00'))), R('mztjs', JS.name, D(open))], stores(['hq', false], ['mztjs', true]), null), null);
  assert.strictEqual(T.otAbsorb([R('hq', HQ.name, D(sp('06:00', '14:00'))), R('mztjs', JS.name, D(open))], stores(['hq', false], ['mztjs', true]), 17 * 60).total, 10);
});
ok('unitOf／sameUnit 同後端 reqUnitOf_（光復代碼空字串＝小辛辣）', () => {
  assert.deepStrictEqual(['', 'gf', 'hq', 'cf', 'mztjs', 'mztgf', 'abc'].map(T.unitOf), ['sxl', '*', '*', '*', 'mzt', 'mzt', '*']);
  assert.strictEqual(T.sameUnit('', 'mztjs'), false); assert.strictEqual(T.sameUnit('hq', ''), true); assert.strictEqual(T.sameUnit('hq', 'mztjs'), true); assert.strictEqual(T.sameUnit('mztgf', 'mztjs'), true);
});

// ── 兩段在不同家店打卡 → 要分開送 ──
ok('兩段各對到不同家店 → 擋（message 講哪段在哪家）；對到同一家、對不到、有店問不到 → 不擋', () => {
  const res = [R('hq', HQ.name, { punches: [{ hm: '09:00', type: 'in', status: 'ok' }, { hm: '13:00', type: 'out', status: 'ok' }] }),
               R('mztjs', JS.name, { punches: [{ hm: '17:00', type: 'in', status: 'ok' }, { hm: '21:00', type: 'out', status: 'ok' }] })];
  const sp2 = J(T.segStoreSplit(res, '2026-11-17', [S('09:30', '12:30'), S('17:30', '20:30')]));
  assert.deepStrictEqual(sp2.codes, ['hq', 'mztjs']);
  assert.strictEqual(sp2.message, '11/17 第一段在鼎兆元 總部打卡、第二段在墨竹亭 新竹金山打卡，兩段要送到不同的店，請分開送（先送一段，再回來送另一段）');
  assert.strictEqual(T.segStoreSplit(res, '2026-11-17', [S('09:30', '10:30'), S('11:00', '12:30')]), null, '兩段都在總部的時間');
  assert.strictEqual(T.segStoreSplit(res, '2026-11-17', [S('14:00', '15:00'), S('15:30', '16:30')]), null, '對不到卡（要自己選）→ 不判斷');
  assert.strictEqual(T.segStoreSplit([res[0], R('mztjs', JS.name, null)], '2026-11-17', [S('09:30', '12:30'), S('17:30', '20:30')]), null);
});
ok('groupKey：店內的 group＋emp_id＋date；沒有 group ＝ 空字串', () => {
  assert.strictEqual(T.groupKey({ group: 'g1', emp_id: 'E1', date: '2026-11-15' }), 'g1|E1|2026-11-15');
  assert.strictEqual(T.groupKey({ group: '', emp_id: 'E1', date: '2026-11-15' }), ''); assert.strictEqual(T.groupKey({ emp_id: 'E1', date: 'x' }), '');
});

console.log('\n' + n + ' 過、0 失敗');
