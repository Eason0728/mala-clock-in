// 打卡只讀 events 最底下夠用的那段（2026-10-12）：readEventsSince（Code.gs）＋ Liff.gs 三個打卡路徑。
// 守：讀到的列＝整張讀裡所有「時間在範圍內」的列（一筆不漏、順序相同、__rowIndex 正確），而且讀的列數遠少於整張。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
const liff = fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const NOW = Date.parse('2026-10-12T20:00:00+08:00');
const sb = { Date, String, Number, Math, JSON, isNaN, CONFIG: { ALTERNATION_LOOKBACK_HOURS: 12 },
  Utilities: { formatDate: (d) => new Date(d.getTime() + 8 * 3600000).toISOString().replace(/\.\d{3}Z$/, '+08:00') } };
vm.createContext(sb);
vm.runInContext(['readSheetAsObjects', 'readEventsSince', 'normCellTs', 'lastCountedEvent'].map(f => extract(code, f)).join('\n'), sb);
const H = ['ts', 'emp_id', 'type', 'lat', 'lng', 'distance_m', 'within_range', 'device_id', 'device_match', 'status', 'accuracy_m'];
const iso = (ms) => new Date(ms + 8 * 3600000).toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
function sheet(values, opts) {
  opts = opts || {}; let read = 0, calls = 0;
  return { stats: () => ({ read, calls }),
    getLastRow: () => values.length, getLastColumn: () => values[0].length,
    getDataRange: () => ({ getValues: () => { read += values.length - 1; calls++; return values.map(r => r.slice()); } }),
    getRange: (r, c, nr, nc) => ({ getValues: () => {
      if (opts.throwOnRange) throw new Error('試算表忙碌');
      calls++; if (r > 1) read += nr;
      return values.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)); } }) };
}
// 30 天、每天 100 筆（約 100 位同仁一天各一張），依時間排序
function data(days, perDay) {
  const rows = [H];
  for (let i = days * perDay - 1; i >= 0; i--) {
    const t = NOW - i * (86400000 / perDay);
    rows.push([iso(t), 'E' + (i % 37), i % 2 ? 'in' : 'out', 24.78, 121.01, 10, true, 'D', true, i % 11 === 0 ? 'rejected_duplicate' : 'ok', 12]);
  }
  return rows;
}
const strip = (rows) => Array.from(rows, r => JSON.stringify(r));   // 沙盒產生的陣列原型不同，轉回本地陣列再比
function check(values, since, label) {
  const full = sb.readSheetAsObjects(sheet(values)).rows.filter(r => { const t = Date.parse(String(sb.normCellTs(r.ts))); return isNaN(t) || t >= since; });
  const sh = sheet(values), tail = sb.readEventsSince(sh, since);
  const tailIn = tail.rows.filter(r => { const t = Date.parse(String(sb.normCellTs(r.ts))); return isNaN(t) || t >= since; });
  assert.deepStrictEqual(strip(tailIn), strip(full), label + '：範圍內的列要和整張讀一模一樣');
  assert.deepStrictEqual(JSON.stringify(tail.headers), JSON.stringify(values[0]));
  return { tail, stats: sh.stats() };
}

const big = data(30, 100);   // 3000 列
ok('打卡（往前 7 天＋1 小時）：範圍內一筆不漏、順序與 __rowIndex 相同，只讀 900 列（整張 3000）', () => {
  const r = check(big, NOW - 7 * 86400000 - 3600000, '打卡');
  assert.strictEqual(r.stats.read, 900);
  r.tail.rows.forEach(x => assert.strictEqual(x.ts, big[x.__rowIndex - 1][0]));
});
ok('開頁（今天＋前 12 小時）：只讀 300 列', () => { assert.strictEqual(check(big, NOW - 21 * 3600000, '開頁').stats.read, 300); });
ok('寫入前防呆（13 小時）：同一人的「最後一張算數的卡」和整張讀結果相同（37 位都比）', () => {
  const full = sb.readSheetAsObjects(sheet(big)).rows, tail = sb.readEventsSince(sheet(big), NOW - 13 * 3600000).rows;
  const RealDate = sb.Date; sb.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  try { for (let e = 0; e < 37; e++) assert.deepStrictEqual(JSON.stringify(sb.lastCountedEvent(tail, 'E' + e)), JSON.stringify(sb.lastCountedEvent(full, 'E' + e))); }
  finally { sb.Date = RealDate; }
});
ok('一年份（36500 列）打卡也只讀 900 列', () => { assert.strictEqual(check(data(365, 100), NOW - 7 * 86400000 - 3600000, '一年').stats.read, 900); });
ok('人少的店（50 列）：一次讀完、全部回來', () => {
  const small = data(5, 10); const r = check(small, NOW - 7 * 86400000, '小表'); assert.strictEqual(r.tail.rows.length, 50);
});
ok('只有表頭：回空陣列', () => { const r = sb.readEventsSince(sheet([H]), NOW - 3600000); assert.strictEqual(r.rows.length, 0); assert.strictEqual(r.headers.length, 11); });
ok('段落第一列時間是空白：不提早停、繼續往上讀', () => {
  const v = big.map(r => r.slice()); v[v.length - 300][0] = '';   // 第一段（最後 300 列）的第一列
  const r = check(v, NOW - 2 * 86400000, '空白時間'); assert.ok(r.stats.read > 300);
});
ok('時間被試算表轉成日期物件也認得', () => {
  const v = big.map((r, i) => i === 0 ? r : [new Date(Date.parse(r[0]))].concat(r.slice(1)));
  assert.strictEqual(check(v, NOW - 7 * 86400000 - 3600000, '日期物件').stats.read, 900);
});
ok('沒有 ts 欄 → 退回整張讀', () => {
  const v = big.map((r, i) => i === 0 ? ['time'].concat(r.slice(1)) : r);
  const sh = sheet(v); sb.readEventsSince(sh, NOW - 3600000); assert.strictEqual(sh.stats().read, 3000);
});
ok('讀的過程出錯 → 退回整張讀（寧可慢，不能少讀）', () => {
  const sh = sheet(big, { throwOnRange: true }); const r = sb.readEventsSince(sh, NOW - 3600000);
  assert.strictEqual(r.rows.length, 3000);
});
ok('sinceMs 不合理（0、空）→ 整張讀', () => { const sh = sheet(big); sb.readEventsSince(sh, 0); assert.strictEqual(sh.stats().read, 3000); });

// 呼叫端：打卡三條路徑都帶範圍；申請頁等非打卡路徑照舊整張
ok('handleClock 改用 readEventsSince（交替防呆 12＋1 小時）', () => {
  assert.ok(extract(code, 'handleClock').indexOf('readEventsSince(eventsSheet, Date.now() - (CONFIG.ALTERNATION_LOOKBACK_HOURS + 1) * 3600000)') > 0);
});
ok('Liff：開頁、舊 liff_clock 帶範圍；打卡用 liffPunchRead_ 讀一次、交給 handleClock 共用', () => {
  assert.ok(extract(liff, 'handleLiffStatus_').indexOf('liffEvents_(found.ss, liffStatusSince_())') > 0);
  const g = extract(liff, 'handleLiffClockGuarded_');
  assert.ok(g.indexOf('liffReadEvents_(found.ss, liffStatusSince_())') > 0 && g.indexOf('handleClock(inner, read)') > 0);
  const p = extract(liff, 'liffPunchFor_');
  assert.ok(p.indexOf('liffPunchRead_(ss, me.emp_id, type)') > 0 && /handleClock\(\{[\s\S]*?\}, read\)/.test(p));
  assert.ok(/function handleClock\(body, preRead\)/.test(code) && extract(code, 'handleClock').indexOf('preRead && preRead.headers && preRead.headers.length') > 0);
});
ok('開頁範圍涵蓋今天 00:00 與前 12 小時', () => {
  const s2 = { Date: { now: () => NOW }, Math, Number, CONFIG: { ALTERNATION_LOOKBACK_HOURS: 12 } };
  vm.createContext(s2); vm.runInContext(['liffLookbackH_', 'liffStatusSince_'].map(f => extract(liff, f)).join('\n'), s2);
  assert.ok(s2.liffStatusSince_() <= Date.parse('2026-10-12T00:00:00+08:00') - 3600000 && s2.liffStatusSince_() <= NOW - 13 * 3600000);
});

// ── 找到就停：拿真的忘打卡提醒、超時提示、防呆比「整張讀」和「找到就停」──
const req = fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8');
const constOf = (src, name) => { const m = src.match(new RegExp('^var ' + name + ' = [^;]+;', 'm')); if (!m) throw new Error('找不到 ' + name); return m[0]; };
function liffBox() {
  class FD extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  const b = { Date: FD, String, Number, Math, JSON, isNaN, parseInt, CONFIG: { ALTERNATION_LOOKBACK_HOURS: 12 },
    Utilities: sb.Utilities };
  vm.createContext(b);
  vm.runInContext([['readSheetAsObjects', 'readEventsSince', 'normCellTs', 'lastCountedEvent'].map(f => extract(code, f)).join('\n'),
    constOf(liff, 'LIFF_MISSED_DAYS'), constOf(liff, 'LIFF_LOCK_MIN'), constOf(liff, 'LIFF_MISSED_PAIR_HOURS'), constOf(req, 'REQ_PAIR_MS'), constOf(req, 'REQ_OT_HINT_H'),
    ['liffReadEvents_', 'liffEvents_', 'liffLookbackH_', 'liffPunchRead_', 'liffGuard_', 'liffHm_', 'liffMissedDetail_'].map(f => extract(liff, f)).join('\n'),
    ['reqOtHint_', 'reqPunchObj_', 'reqMin_'].map(f => extract(req, f)).join('\n')].join('\n'), b);
  return b;
}
// 30 位同仁 × 30 天：每天 10:00 上班、15:00 下班、16:00 上班、22:00 下班；E5 十天沒來；E6 三天前上班沒打下班；E7 前天只有被擋的下班卡
function shiftData() {
  const ev = [];
  for (let d = 29; d >= 0; d--) {
    const day = Date.parse('2026-10-12T00:00:00+08:00') - d * 86400000;
    for (let e = 0; e < 30; e++) {
      if (e === 5 && d < 10) continue;
      [[10, 'in'], [15, 'out'], [16, 'in'], [22, 'out']].forEach(([h, t], k) => {
        const ts = day + h * 3600000 + e * 60000;
        if (ts >= NOW - 5 * 60000) return;   // 今天還沒到的不算
        if (e === 6 && d === 3 && k >= 1) return;
        if (e === 6 && d < 3) return;
        let st = 'ok'; if (e === 7 && d === 2 && t === 'out') st = 'rejected_out_of_range';
        ev.push([ts, 'E' + e, t, st]);
      });
    }
  }
  ev.sort((x, y) => x[0] - y[0]);
  return [H].concat(ev.map(([ts, id, t, st]) => [iso(ts), id, t, 24.78, 121.01, 10, true, 'D', true, st, 12]));
}
const SD = shiftData();
function compare(emp, type) {
  const b = liffBox(), shFull = sheet(SD), shTail = sheet(SD);
  const full = b.readSheetAsObjects(shFull).rows; full.forEach(e => { e.ts = b.normCellTs(e.ts); });
  const fake = { getSheetByName: () => shTail };
  const read = b.liffPunchRead_(fake, emp, type);
  const ts = iso(NOW);
  const pick = (ev) => JSON.stringify({ guard: b.liffGuard_(ev, emp).last, last: b.lastCountedEvent(ev, emp),
    missed: b.liffMissedDetail_(ev, emp, type, ts),
    ot: type === 'out' ? b.reqOtHint_(ev.concat([{ ts, emp_id: emp, type: 'out', status: 'ok' }]), emp, ts, []) : null });
  assert.strictEqual(pick(read.rows), pick(full), emp + ' ' + type + '：結果要和整張讀一樣');
  return { read: shTail.stats().read, full: SD.length - 1, res: JSON.parse(pick(read.rows)) };
}
ok('按上班、今天稍早有打卡：找到上一張卡就停，只讀 300 列（整張 ' + (SD.length - 1) + ' 列），結果和整張讀一樣', () => {
  const r = compare('E1', 'in'); assert.strictEqual(r.read, 300); assert.strictEqual(r.res.missed.miss_type, 'out');   // 今天 16:01 上班還沒下班，再按上班＝提醒漏打下班
});
ok('按上班、十天沒來（E5）：讀滿 7 天才停，提醒結果一樣（沒有）', () => {
  const r = compare('E5', 'in'); assert.ok(r.read > 300 && r.read < r.full, r.read); assert.strictEqual(r.res.missed.text, '');
});
ok('按上班、三天前上班沒打下班（E6）：找到那張就停、照樣提醒漏打下班', () => {
  const r = compare('E6', 'in'); assert.ok(r.res.missed.miss_type === 'out' && r.res.missed.date === '2026-10-09', JSON.stringify(r.res.missed)); assert.ok(r.read < r.full);
});
ok('按上班、前天下班被擋（E7）：結果一樣', () => { compare('E7', 'in'); });
ok('按下班（E2）：讀 48 小時、超時提示與忘打卡結果和整張讀一樣', () => { const r = compare('E2', 'out'); assert.ok(r.read <= 600, r.read); });
ok('30 位同仁上下班都比過：全部和整張讀一樣', () => { for (let e = 0; e < 30; e++) { compare('E' + e, 'in'); compare('E' + e, 'out'); } });
ok('Liff：店家還沒有 readEventsSince（分批部署）→ 自動整張讀', () => { assert.ok(/typeof readEventsSince === 'function'/.test(extract(liff, 'liffReadEvents_'))); });
console.log('\n✅ 打卡只讀需要的列 ' + n + ' 項通過');
