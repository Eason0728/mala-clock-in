// 忘打卡自動選店（2026-10-28）：綁兩家以上的同仁，選好日期後依「那天哪家有卡」決定申請送哪家。
// 起因：一位跨店支援同仁在金山上班，忘打卡申請沒改店別就送到排第一的光復，光復主管看到「當天沒有任何打卡」。
// 前端 req-line.js decideStore（純函式）＋後端 Requests.gs req_info 的 day_only／events 只讀尾端。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

/* ── 前端：decideStore ── */
const fe = {};
vm.createContext(fe);
vm.runInContext(extract(fs.readFileSync(ROOT + '/req-line.js', 'utf8'), 'decideStore'), fe);
const P = (type, status) => ({ type, hm: '10:00', status: status || 'ok' });
const day = (...p) => ({ date: '2026-10-27', punches: p, missing: { options: ['both'] } });
const R = (code, name, d) => ({ code, name, day: d });
const D = '2026-10-27';
const J = (x) => JSON.parse(JSON.stringify(x));

ok('只有金山有卡、目前選光復 → 換到金山，說明寫店名與日期', () => {
  const r = J(fe.decideStore([R('', '小辛辣 新竹光復', day()), R('mztjs', '墨竹亭 金山', day(P('in'), P('out')))], '', D));
  assert.deepStrictEqual(r, { pick: 'mztjs', note: { kind: 'switched', date: D, code: 'mztjs', name: '墨竹亭 金山' } });
});
ok('只有被擋下的卡也算「那天在那家」（定位被擋的人最需要補登）', () => {
  const r = fe.decideStore([R('', '光復', day()), R('mztjs', '金山', day(P('out', 'rejected_out_of_range')))], '', D);
  assert.strictEqual(r.pick, 'mztjs');
});
ok('有卡的那家就是目前選的 → 不換、不寫說明', () => {
  assert.deepStrictEqual(J(fe.decideStore([R('', '光復', day(P('in'))), R('mztjs', '金山', day())], '', D)), { pick: null, note: null });
});
ok('兩家都有卡 → 不猜，提醒確認（列出兩家店名）', () => {
  const r = J(fe.decideStore([R('', '光復', day(P('in'))), R('mztjs', '金山', day(P('out')))], '', D));
  assert.deepStrictEqual(r, { pick: null, note: { kind: 'multi', date: D, names: ['光復', '金山'] } });
});
ok('都沒有卡 → 維持原本的店、不說明', () => {
  assert.deepStrictEqual(J(fe.decideStore([R('', '光復', day()), R('mztjs', '金山', day())], '', D)), { pick: null, note: null });
});
ok('有一家問不到（舊後端、斷線）→ 不能確定只有一家，不換', () => {
  assert.deepStrictEqual(J(fe.decideStore([R('', '光復', null), R('mztjs', '金山', day(P('in')))], '', D)), { pick: null, note: null });
  assert.deepStrictEqual(J(fe.decideStore([R('', '光復', day()), R('mztjs', '金山', day(P('in'))), R('hq', '總部', null)], '', D)), { pick: null, note: null });
});
ok('問不到的店不影響「兩家以上有卡」的提醒', () => {
  const r = fe.decideStore([R('', '光復', day(P('in'))), R('mztjs', '金山', day(P('in'))), R('hq', '總部', null)], 'hq', D);
  assert.strictEqual(r.pick, null); assert.strictEqual(r.note.kind, 'multi');
});

/* ── 前端：其他分頁不受影響、單店不多打 ── */
const reqJs = fs.readFileSync(ROOT + '/req-line.js', 'utf8');
ok('開頁預設仍是第一家（請假、加班、出差、我的申請照舊）', () => {
  assert(/st\.store = r\.stores\[0\];/.test(reqJs));
  assert.strictEqual((reqJs.match(/decideStore\(/g) || []).length, 2, '只在忘打卡分頁呼叫（定義＋一處呼叫）');
});
ok('只綁一家時只問那一家（不多打後端）', () => {
  assert(/st\.init\.stores\.length > 1 \? st\.init\.stores : \[st\.store\]/.test(reqJs));
});
ok('查各店那天的卡帶 day_only', () => { assert(/date: date, day_only: true/.test(reqJs)); });

/* ── 後端：Requests.gs handleReqInfo_ ── */
function makeBackend(events) {
  const reads = { requests: 0, since: [] };
  const sb = {
    console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, Object, Array, RegExp,
    LEAVE_TYPES: ['病假', '事假', '出差'],
    todayTaipeiStr: () => '2026-10-28',
    verifyLineIdToken_: (t) => (t ? 'U1' : null),
    liffRosterByLine_: () => ({ roster: { emp_id: 'E01', name: '測試一' }, ss: {} }),
    liffThrottled_: () => false, liffSiteThrottled_: () => false,
    liffEvents_: (ss, since) => { reads.since.push(since); return events.filter((e) => !since || new Date(e.ts).getTime() >= since); },
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8'), sb);
  sb.reqRows_ = () => { reads.requests++; return [{ id: 'r1', emp_id: 'E01', kind: 'leave', date: '2026-10-20', created_at: '2026-10-20T10:00:00+08:00', status: 'pending' }]; };
  sb.reqPublic_ = (r) => ({ id: r.id });
  return { sb, reads };
}
const evs = [
  { ts: '2026-10-20T10:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' },
  { ts: '2026-10-26T23:30:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' },     // 前一天晚上上班、10/27 凌晨下班
  { ts: '2026-10-27T01:10:00+08:00', emp_id: 'E01', type: 'out', status: 'ok' },
  { ts: '2026-10-27T17:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' },
];
ok('day_only：不讀申請表、回 requests 空、day 照算', () => {
  const { sb, reads } = makeBackend(evs);
  const r = J(sb.handleReqInfo_({ id_token: 't', date: '2026-10-27', day_only: true }));
  assert.strictEqual(reads.requests, 0); assert.deepStrictEqual(r.requests, []); assert.strictEqual(r.day_only, true);
  assert.deepStrictEqual(r.day.punches.map((x) => x.hm), ['01:10', '17:00']);   // 畫面列出當天日期的每張卡（01:10 配給前一天的班）
  assert.deepStrictEqual(r.day.missing.options, ['out']);
});
ok('有 date 時 events 只讀尾端：從前一天台北 00:00 再早 1 小時起', () => {
  const { sb, reads } = makeBackend(evs);
  sb.handleReqInfo_({ id_token: 't', date: '2026-10-27', day_only: true });
  assert.strictEqual(reads.since[0], new Date('2026-10-25T23:00:00+08:00').getTime());
});
ok('只讀尾端跟整張讀，算出來的那天一模一樣（跨夜班歸前一天也對）', () => {
  for (const d of ['2026-10-26', '2026-10-27', '2026-10-20']) {
    const { sb } = makeBackend(evs);
    const tail = J(sb.reqDayInfo_(sb.liffEvents_({}, sb.reqDaySince_(d)), 'E01', d));
    const full = J(sb.reqDayInfo_(evs, 'E01', d));
    assert.deepStrictEqual(tail, full, d);
  }
});
ok('沒帶 day_only（開頁、舊前端）→ 照舊回申請清單', () => {
  const { sb, reads } = makeBackend(evs);
  const r = J(sb.handleReqInfo_({ id_token: 't', date: '2026-10-27' }));
  assert.strictEqual(reads.requests, 1); assert.strictEqual(r.requests.length, 1); assert.strictEqual(r.day_only, undefined);
  const r2 = J(sb.handleReqInfo_({ id_token: 't' }));
  assert.strictEqual(r2.day, undefined); assert.strictEqual(r2.requests.length, 1);
});
ok('day_only 但日期不合法 → 不算 day_only（照舊整包、沒有 day）', () => {
  const { sb, reads } = makeBackend(evs);
  const r = J(sb.handleReqInfo_({ id_token: 't', date: '2026-11-31', day_only: true }));
  assert.strictEqual(reads.requests, 1); assert.strictEqual(r.day, undefined);
});
console.log(`\n${n} 項全部通過`);
