/**
 * 「核定已包含這張單」打卡端（Requests.gs reqDayCovers_）與營運系統舊案工具（mala-store-ops server/tools/late-slip-scan.js covers）同一口徑的交叉比對（2026-11-26 獨立審查第 1 項）。
 * 共用案例檔 fixtures/reopen-covers-cases-v1.json：兩個 repo 各放一份、必須逐字相同（下面釘 sha256）；這裡用打卡端真函式驗每一案的 expect，
 * mala-store-ops test/server/late-slip-scan.test.js 用同一份驗掃描工具。案例＝手寫 12 案＋固定種子亂數 400 案（expect 由打卡端算出後凍結）。
 * 重產：REOPEN_COVERS_GEN=1 node tests/reopen-covers-cases.test.js（會覆寫案例檔；之後要同步到 mala-store-ops 並改兩邊的 sha256）。
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const H = require('./helpers/gs-sandbox');
const { make, T, check, done } = H;
const FILE = path.join(__dirname, 'fixtures', 'reopen-covers-cases-v1.json');
const SHA = 'd4007980d9a722be17630d5f551201ec378cccdb1edb76a1cb2525a01fee934e';
const AH = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'dup_ignore', 'diff_reason', 'mirror_src'];
const D = '2026-11-20', EMP = 'E07', NAME = '示意甲';

/** 一案在打卡端判：'covered'／'reopen' */
function judge(c) {
  const m = make({ now: T('2026-11-28T10:00:00'), props: { REQ_BIND_FROM: 'off', REQ_REOPEN_ON: '1' }, self: { roster: [{ emp_id: EMP, name: NAME, key: 'K', active: 'true' }], events: [], approved: [], leave: [] } });
  const ap = m.self.sh.approved.values; ap[0] = AH.slice();
  ap.push([D, EMP, NAME, c.approved.periods, c.approved.approved_hours, '正常', '店長', D + 'T21:00:00+08:00', '', '', '']);
  const lv = m.self.sh.leave.values; lv[0] = ['日期', '姓名', '假別', '時數', 'mirror_src'];
  c.leaves.forEach((l) => lv.push([D, NAME, l.type, l.hours, l.mirror || '']));
  const sh = m.sb.reqSheet_(m.sb.getSS(), true), HD = m.run('REQ_HEADERS_');
  c.slips.forEach((q) => { const r = Object.assign({ created_at: '2026-11-27T09:00:00+08:00', emp_id: EMP, name: NAME, date: D }, q); sh.appendRow(HD.map((k) => (r[k] === undefined ? '' : r[k]))); });
  const r = m.sb.reqRows_(m.sb.getSS()).find((x) => String(x.id) === c.target);
  return m.sb.reqReopenJudge_(m.sb.getSS(), r, {}).act;
}
const S = (id, kind, x) => Object.assign({ id, kind, status: 'approved', leave_type: kind === 'trip' ? '出差' : '', start: '', end: '', hours: '' }, x || {});
const HAND = [
  { note: '出差 8＝登記 8', approved: { periods: '', approved_hours: 8 }, slips: [S('t', 'trip', { hours: 8, status: 'pending' })], target: 't', leaves: [{ type: '出差', hours: 8 }] },
  { note: '第二張出差 2：合計 4≠登記 2（審查重現）', approved: { periods: '12:00-18:00', approved_hours: 6 }, slips: [S('a', 'trip', { start: '09:00', end: '11:00', hours: 2 }), S('t', 'trip', { start: '14:00', end: '16:00', hours: 2, status: 'pending' })], target: 't', leaves: [{ type: '出差', hours: 2 }] },
  { note: '兩張出差合計 4＝登記 4', approved: { periods: '', approved_hours: 4 }, slips: [S('a', 'trip', { hours: 2 }), S('t', 'trip', { hours: 2, status: 'pending' })], target: 't', leaves: [{ type: '出差', hours: 4 }] },
  { note: '鏡像登記不算', approved: { periods: '', approved_hours: 2 }, slips: [S('t', 'trip', { hours: 2, status: 'pending' })], target: 't', leaves: [{ type: '出差', hours: 2, mirror: 'CF' }] },
  { note: '事假 4＝登記事假 4', approved: { periods: '09:00-13:00', approved_hours: 4 }, slips: [S('t', 'leave', { leave_type: '事假', hours: 4, status: 'pending' })], target: 't', leaves: [{ type: '事假', hours: 4 }] },
  { note: '事假時數空白（算 0）≠登記 4', approved: { periods: '09:00-13:00', approved_hours: 4 }, slips: [S('t', 'leave', { leave_type: '事假', status: 'pending' })], target: 't', leaves: [{ type: '事假', hours: 4 }] },
  { note: '加班 2＝應有 2、在時段內', approved: { periods: '12:00-22:00', approved_hours: 10 }, slips: [S('t', 'ot', { start: '20:00', end: '22:00', hours: 2, status: 'pending' })], target: 't', leaves: [] },
  { note: '兩張加班合計 2', approved: { periods: '12:00-22:00', approved_hours: 10 }, slips: [S('a', 'ot', { start: '20:00', end: '21:00', hours: 1 }), S('t', 'ot', { start: '21:00', end: '22:00', hours: 1, status: 'pending' })], target: 't', leaves: [] },
  { note: '加班合計 4 比應有 2 多', approved: { periods: '12:00-22:00', approved_hours: 10 }, slips: [S('a', 'ot', { start: '20:00', end: '22:00', hours: 2 }), S('t', 'ot', { start: '18:00', end: '20:00', hours: 2, status: 'pending' })], target: 't', leaves: [] },
  { note: '加班超出時段 16 分', approved: { periods: '12:00-22:00', approved_hours: 10 }, slips: [S('t', 'ot', { start: '20:00', end: '22:16', hours: 2.27, status: 'pending' })], target: 't', leaves: [] },
  { note: '核定 8 小時有加班單', approved: { periods: '10:00-18:00', approved_hours: 8 }, slips: [S('t', 'ot', { start: '17:00', end: '18:00', hours: 1, status: 'pending' })], target: 't', leaves: [] },
  { note: '跨夜加班在時段內', approved: { periods: '16:00-02:00', approved_hours: 10 }, slips: [S('t', 'ot', { start: '00:00', end: '02:00', hours: 2, status: 'pending' })], target: 't', leaves: [] },
];
function gen() {
  let seed = 20261126; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = [];
  for (let i = 0; i < 400; i++) {
    const per = pick([['12:00-22:00', 10], ['10:00-18:00', 8], ['09:00-13:00,14:00-20:00', 10], ['', 8], ['16:00-02:00', 10], ['12:00-21:00', 9]]);
    const slips = [], n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const kind = pick(['ot', 'trip', 'leave']), last = k === n - 1;
      const x = { status: last ? 'pending' : pick(['approved', 'approved', 'pending', 'rejected']) };
      if (kind === 'ot') Object.assign(x, pick([{ start: '20:00', end: '22:00', hours: 2 }, { start: '21:00', end: '22:00', hours: 1 }, { start: '20:00', end: '21:00', hours: 1 }, { start: '18:00', end: '20:00', hours: 2 }, { start: '00:00', end: '02:00', hours: 2 }, { start: '20:00', end: '22:15', hours: 2.25 }]));
      if (kind === 'trip') Object.assign(x, { hours: pick([2, 4, 8, '']) });
      if (kind === 'leave') Object.assign(x, { leave_type: pick(['事假', '特休假']), hours: pick([2, 4, '']) });
      slips.push(S('s' + k, kind, x));
    }
    const leaves = [], nl = Math.floor(rnd() * 3);
    for (let k = 0; k < nl; k++) leaves.push({ type: pick(['出差', '事假', '特休假']), hours: pick([2, 4, 8, '']), mirror: rnd() < 0.2 ? 'CF' : '' });
    out.push({ note: 'rand' + i, approved: { periods: per[0], approved_hours: per[1] }, slips, target: 's' + (n - 1), leaves });
  }
  return out;
}

if (process.env.REOPEN_COVERS_GEN === '1') {
  const cases = HAND.concat(gen()).map((c) => Object.assign({}, c, { expect: judge(c) === 'covered' }));
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, date: D, emp_id: EMP, name: NAME, cases }, null, 1) + '\n');
  console.log('寫好 ' + cases.length + ' 案；sha256＝' + crypto.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex'));
  process.exit(0);
}
const raw = fs.readFileSync(FILE);
check('cv-sha', '案例檔跟 mala-store-ops 那份逐字相同（sha256 釘住）', crypto.createHash('sha256').update(raw).digest('hex'), SHA);
const F = JSON.parse(raw);
const bad = F.cases.filter((c) => (judge(c) === 'covered') !== c.expect).map((c) => c.note);
check('cv-all', '打卡端 reqDayCovers_ 對 ' + F.cases.length + ' 案的結論全部等於案例檔', bad.slice(0, 5), []);
const hand = F.cases.slice(0, HAND.length).map((c) => c.expect);
check('cv-hand', '手寫 12 案的手算結論', hand, [true, false, true, false, true, false, true, true, false, false, false, true]);
check('cv-mix', '亂數案例有涵蓋兩種結論', [F.cases.some((c) => c.expect), F.cases.some((c) => !c.expect)], [true, true]);
done();
