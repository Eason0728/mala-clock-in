/* 加班一次最多四段（LINE 申請頁前端，2026-11-21 Eason）的純函式測試。
 * 載入真的 req-line.js（檔尾多掛一個測試用出口），測：
 *  ① segCheck 三、四段：兩兩重疊、接在一起（含跨夜、順序不相鄰）、合計超過上限、哪一段沒填完整；兩段的字句跟以前完全一樣
 *  ② segMaxN：加班看 req_info 的 ot_segments_max（4／舊後端 2／沒這欄也當 2／超過 4 也只收 4）；請假、出差永遠 2
 *  ③ segsOf／segExtras／segHours：第二～第四段、中間斷掉只算到斷的前一段、這張不能加就是 null
 *  ④ segStoreSplit：三、四段裡有兩段在不同店打卡 → 要分開送，講第幾段
 *  ⑤ 前端 segCheck 和後端 reqSegsOf_ 對同一批隨機的 2～4 段，結果（過／錯誤碼／哪一段）逐筆一致
 * 畫面、送出內容、我的申請的「第 N 段／共 M 段」在 e2e/req_seg4.py（要瀏覽器）。 */
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const FILE = path.join(__dirname, '..', 'req-line.js');
const src = fs.readFileSync(FILE, 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const hooked = src.replace(TAIL, TAIL + ' window.__t = { st: st, segCheck: segCheck, seg2Open: seg2Open, seg2Ok: seg2Ok, segsOf: segsOf, segExtras: segExtras, segMaxN: segMaxN,' +
  ' segHours: segHours, segStoreSplit: segStoreSplit, groupKey: groupKey, groupCounts: groupCounts, groupRanks: groupRanks };');
const sb = { window: {}, document: {}, console, Promise, setTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
vm.createContext(sb);
vm.runInContext(hooked, sb, { filename: 'req-line.js' });
const T = sb.window.__t;
const J = (x) => JSON.parse(JSON.stringify(x));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const S = (a, b) => ({ start: a, end: b });
const L = (list) => list.map((x) => S(x[0], x[1]));
const info = (o) => { T.st.info = o; };

// ── ① 三、四段檢查 ──
const A4 = [['09:00', '11:00'], ['12:00', '14:00'], ['15:00', '17:00'], ['18:00', '20:00']];
ok('四段不重疊、合計 8 小時 → 過；三段也過', () => { assert.strictEqual(T.segCheck('ot', L(A4), 10), null); assert.strictEqual(T.segCheck('ot', L(A4.slice(0, 3)), 10), null); });
ok('兩段的字句跟 2026-11-18 一模一樣（兩段時間重疊／兩段接在一起／兩段合計）', () => {
  assert.strictEqual(J(T.segCheck('ot', L([['11:00', '14:00'], ['13:00', '15:00']]), 10)).message, '兩段時間重疊（11:00–14:00、13:00–15:00），請改時間');
  assert.strictEqual(J(T.segCheck('ot', L([['11:00', '14:00'], ['14:00', '17:00']]), 10)).message, '兩段接在一起，請直接填成一段 11:00–17:00');
  assert.strictEqual(J(T.segCheck('ot', L([['08:00', '13:00'], ['14:00', '20:00']]), 10)).message, '兩段合計 11 小時，超過 10 小時，請確認時間');
});
ok('第一段和第三段重疊（第二段在旁邊）→ 「第一段和第三段時間重疊（…），請改時間」', () => {
  const r = J(T.segCheck('ot', L([['11:00', '14:00'], ['16:00', '17:00'], ['13:00', '15:00'], ['18:00', '19:00']]), 10));
  assert.deepStrictEqual(r, { error: 'seg_overlap', message: '第一段和第三段時間重疊（11:00–14:00、13:00–15:00），請改時間' });
});
ok('第二段和第四段重疊、第一段和第四段重疊都抓得到', () => {
  assert.strictEqual(J(T.segCheck('ot', L([['09:00', '10:00'], ['11:00', '14:00'], ['15:00', '16:00'], ['13:00', '15:00']]), 10)).message, '第二段和第四段時間重疊（11:00–14:00、13:00–15:00），請改時間');
  assert.strictEqual(J(T.segCheck('ot', L([['11:00', '12:00'], ['14:00', '15:00'], ['16:00', '17:00'], ['10:00', '13:00']]), 10)).message, '第一段和第四段時間重疊（11:00–12:00、10:00–13:00），請改時間');
});
ok('接在一起：第三、四段 15–17 接 17–19；第一、三段不相鄰也抓；順序顛倒講合併後的範圍', () => {
  assert.deepStrictEqual(J(T.segCheck('ot', L([['09:00', '10:00'], ['11:00', '12:00'], ['15:00', '17:00'], ['17:00', '19:00']]), 10)), { error: 'seg_touch', message: '第三段和第四段接在一起，請直接填成一段 15:00–19:00' });
  assert.strictEqual(J(T.segCheck('ot', L([['09:00', '11:00'], ['13:00', '14:00'], ['11:00', '12:00'], ['16:00', '17:00']]), 10)).message, '第一段和第三段接在一起，請直接填成一段 09:00–12:00');
  assert.strictEqual(J(T.segCheck('ot', L([['17:00', '19:00'], ['11:00', '12:00'], ['09:00', '10:00'], ['15:00', '17:00']]), 10)).message, '第一段和第四段接在一起，請直接填成一段 15:00–19:00');
});
ok('跨夜四段：22:00–01:00 接 01:00–03:00 擋、中間空 1 分鐘收', () => {
  assert.strictEqual(J(T.segCheck('ot', L([['09:00', '10:00'], ['22:00', '01:00'], ['12:00', '13:00'], ['01:00', '03:00']]), 10)).error, 'seg_touch');
  assert.strictEqual(T.segCheck('ot', L([['09:00', '10:00'], ['22:00', '01:00'], ['12:00', '13:00'], ['01:01', '03:00']]), 10), null);
});
ok('合計：四段 3＋3＋3＋2＝11 → 「四段合計 11 小時，超過 10 小時，請確認時間」；10 剛好過；三段字句講「三段合計」', () => {
  assert.strictEqual(J(T.segCheck('ot', L([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '19:00'], ['20:00', '22:00']]), 10)).message, '四段合計 11 小時，超過 10 小時，請確認時間');
  assert.strictEqual(T.segCheck('ot', L([['08:00', '11:00'], ['12:00', '15:00'], ['16:00', '18:00'], ['19:00', '21:00']]), 10), null);
  assert.strictEqual(J(T.segCheck('ot', L([['06:00', '10:00'], ['11:00', '15:00'], ['16:00', '19:00']]), 10)).message, '三段合計 11 小時，超過 10 小時，請確認時間');
});
ok('沒填完整／起訖一樣：標那一段（第三段、第四段）', () => {
  assert.deepStrictEqual(J(T.segCheck('ot', L([['09:00', '10:00'], ['11:00', '12:00'], ['', ''], ['15:00', '16:00']]), 10)), { error: 'bad_time', seg: 3, message: '第三段：請填完整的加班時段' });
  assert.deepStrictEqual(J(T.segCheck('ot', L([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00'], ['15:00', '15:00']]), 10)), { error: 'bad_time', seg: 4, message: '第四段：開始和結束時間一樣，請確認' });
});

// ── ② 最多幾段 ──
ok('segMaxN：加班 ot_segments_max 4 → 4；舊後端 2 → 2；沒這欄 → 2；超過 4 → 4；請假、出差永遠 2', () => {
  info({ seg2_kinds: ['ot', 'leave', 'trip'], ot_segments_max: 4 }); assert.deepStrictEqual([T.segMaxN('ot'), T.segMaxN('leave'), T.segMaxN('trip')], [4, 2, 2]);
  info({ seg2_kinds: ['ot'], ot_segments_max: 2 }); assert.strictEqual(T.segMaxN('ot'), 2);
  info({ seg2_kinds: ['ot'] }); assert.strictEqual(T.segMaxN('ot'), 2);
  info({ seg2_kinds: ['ot'], ot_segments_max: 9 }); assert.strictEqual(T.segMaxN('ot'), 4);
  info(null); assert.deepStrictEqual([T.segMaxN('ot'), T.segMaxN('leave')], [2, 2]);
  info({ seg2_kinds: ['ot'], ot_segments_max: 1 }); assert.strictEqual(T.seg2Open('ot'), false, '開關關掉的後端：加班不出現「加一段」');
});

// ── ③ 各段取出 ──
ok('segsOf：加到第四段 → 4 段（第一段是 start／end）；沒加第二段 → null；這張不能加（開關沒開、生理假）→ null', () => {
  info({ seg2_kinds: ['ot', 'leave'], ot_segments_max: 4, seg2_no_types: ['生理假'] });
  const x = { start: '09:00', end: '10:00', seg2: S('11:00', '12:00'), seg3: S('13:00', '14:00'), seg4: S('15:00', '16:00') };
  assert.deepStrictEqual(J(T.segsOf(x, 'ot', '')), L([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00'], ['15:00', '16:00']]));
  assert.strictEqual(T.segsOf({ start: '09:00', end: '10:00', seg2: null, seg3: null, seg4: null }, 'ot', ''), null);
  assert.strictEqual(T.segsOf(x, 'leave', '生理假'), null);
  assert.strictEqual(T.segsOf(x, 'trip', ''), null, '沒開 trip');
  info({ seg2_kinds: [] }); assert.strictEqual(T.segsOf(x, 'ot', ''), null);
});
ok('segExtras：第三段是空的、第四段有填 → 只算到第二段（斷掉的不送）', () => {
  assert.deepStrictEqual(J(T.segExtras({ seg2: S('1', '2'), seg3: null, seg4: S('3', '4') })), [S('1', '2')]);
  assert.deepStrictEqual(J(T.segExtras({ seg2: null, seg3: S('1', '2') })), []);
});
ok('segHours：四段加總（跨夜照算）；有一段沒填當 0', () => {
  assert.strictEqual(T.segHours(L(A4)), 8);
  assert.strictEqual(T.segHours(L([['17:00', '19:00'], ['19:30', '21:00'], ['21:30', '23:00'], ['23:30', '01:00']])), 6.5);
  assert.strictEqual(T.segHours(L([['09:00', '10:00'], ['', '']])), 1);
});

// ── ④ 不同店 ──
ok('segStoreSplit：三、四段裡兩段各在不同店打卡 → 擋，講第幾段；兩段時字句跟以前一樣；判斷不出來的段不算', () => {
  const day = (spans) => ({ punches: spans.reduce((a, [i, o]) => a.concat([{ type: 'in', hm: i, status: 'ok' }, { type: 'out', hm: o, status: 'ok' }]), []) });
  const res = [{ code: 'a', name: '甲店', day: day([['09:00', '12:00']]) }, { code: 'b', name: '乙店', day: day([['17:00', '21:00']]) }];
  const r2 = T.segStoreSplit(res, '2026-11-16', L([['09:00', '11:00'], ['17:00', '19:00']]));
  assert.strictEqual(r2.message, '11/16 第一段在甲店打卡、第二段在乙店打卡，兩段要送到不同的店，請分開送（先送一段，再回來送另一段）');
  const r4 = T.segStoreSplit(res, '2026-11-16', L([['09:00', '10:00'], ['10:30', '11:30'], ['17:00', '18:00'], ['18:30', '19:30']]));
  assert.strictEqual(r4.message, '11/16 第一段在甲店打卡、第三段在乙店打卡，這幾段要送到不同的店，請分開送（先送一段，再回來送另一段）');
  assert.strictEqual(T.segStoreSplit(res, '2026-11-16', L([['09:00', '10:00'], ['10:30', '11:30'], ['11:35', '11:50']])), null, '三段都在甲店 → 不擋');
});

// ── 我的申請「第 N 段／共 M 段」：取消中間一張後照剩下的重新數 ──
ok('groupRanks／groupCounts：四段取消第 3 段 → 剩 3 張仍成組，標第 1、2、3 段／共 3 段（不是「第 4 段／共 3 段」）；退回、作廢的也不算', () => {
  const r = (id, seg, status) => ({ id: id, group: 'g1', emp_id: 'E', date: '2026-11-16', seg: seg, status: status });
  const list = [r('a', 1, 'pending'), r('b', 2, 'pending'), r('c', 3, 'cancelled'), r('d', 4, 'approved')];
  assert.deepStrictEqual(J(T.groupRanks(list)), { a: 1, b: 2, d: 3 });
  assert.strictEqual(T.groupCounts(list)['g1|E|2026-11-16'], 3);
  assert.deepStrictEqual(J(T.groupRanks([r('a', 1, 'pending'), r('b', 2, 'rejected'), r('c', 3, 'voided'), r('d', 4, 'pending')])), { a: 1, d: 2 });
  assert.deepStrictEqual(J(T.groupRanks([r('d', 4, 'pending'), r('a', 1, 'pending'), r('b', 2, 'pending'), r('c', 3, 'pending')])), { a: 1, b: 2, c: 3, d: 4 }, '清單順序亂也照 seg');
  assert.deepStrictEqual(J(T.groupRanks([{ id: 'x', status: 'pending' }])), {}, '沒有 group 的不編號');
});

// ── ⑤ 跟後端 reqSegsOf_ 逐筆一致 ──
ok('前端 segCheck 與後端 reqSegsOf_：隨機 3000 組（2～4 段、包含跨夜、重疊、相接、超過 10 小時）過／錯誤碼／哪一段都一樣', () => {
  const { make, T: TT } = require('./helpers/gs-sandbox');
  const m = make({ now: TT('2026-11-17T10:00:00'), props: { REQ_SEG2_KINDS: 'ot,leave,trip' }, self: { roster: [], events: [] } });
  let seed = 11; const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  const fmt = (min) => { min = ((min % 1440) + 1440) % 1440; return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); };
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  let pass = 0, bad = 0;
  for (let i = 0; i < 3000; i++) {
    const k = 2 + rnd(3), segs = [];
    for (let j = 0; j < k; j++) {
      // 時段 15 分鐘～4 小時；三分之一機率直接接在前一段後面或跟前一段同時開始，讓相接、重疊常出現；偶爾故意不填完整或起訖一樣
      let st = rnd(1440 / 15) * 15;
      if (j && rnd(3) === 0) st = rnd(2) ? toMin(segs[j - 1].end) : toMin(segs[j - 1].start);
      const dur = (1 + rnd(16)) * 15;
      const g = S(fmt(st), fmt(st + dur));
      const odd = rnd(40);
      if (odd === 0) g.end = ''; else if (odd === 1) g.end = g.start;
      segs.push(g);
    }
    const front = T.segCheck('ot', segs, 10);
    const back = m.sb.reqSegsOf_({ kind: 'ot', segments: segs }, false);
    const bc = back.error ? { error: back.error, seg: back.seg || 0 } : null;
    const fc = front ? { error: front.error, seg: front.seg || 0 } : null;
    assert.deepStrictEqual(fc, bc, JSON.stringify(segs) + ' 前端 ' + JSON.stringify(fc) + ' 後端 ' + JSON.stringify(bc));
    if (fc) bad++; else pass++;
  }
  assert.ok(pass > 100 && bad > 100, '隨機資料要兩邊都有（過 ' + pass + '、擋 ' + bad + '）');
});

console.log('\n' + n + ' 過、0 失敗');
