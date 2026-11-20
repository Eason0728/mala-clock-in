/* 第 5 階段 P5-1 標示（2026-11-21）：relay_pull 帶 with.mark 時，在 events／approved／leave／requests 第一格加「請勿手改」註記。
 * 不改分頁名、不改表頭文字；原本有別的註記照留；沒帶 mark＝完全不碰。假資料。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';

function world() {
  const m = make({ now: T('2026-11-21T09:00:00'), props: { REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, self: { roster: [], events: [] } });
  m.run(R('apps-script/RelayG.gs'));
  // 假試算表沒有「註記」：補上第一格的 getNote／setNote（記錄寫了幾次）
  const notes = {}, writes = [];
  Object.keys(m.self.sh).forEach((nm) => {
    const sh = m.self.sh[nm], orig = sh.getRange;
    sh.getRange = function (a, c, nr, nc) {
      if (a === 1 && c === 1 && nr === undefined) return { getNote: () => notes[nm] || '', setNote: (v) => { writes.push(nm); notes[nm] = String(v); } };
      return orig.apply(this, arguments);
    };
  });
  return { m, notes, writes, pull: (mark) => m.sb.handleRelayPull_({ relay_key: KEY, with: mark === undefined ? {} : { mark } }) };
}

{
  const w = world();
  const heads0 = w.m.self.sh.approved.values[0].slice();
  const r0 = w.pull();
  check('M1', '沒帶 mark：回應沒有 mark、一格都沒寫', ['mark' in r0, w.writes.length], [false, 0]);
  const r = w.pull('on');
  check('M2', 'on：四張表都加註記（requests 這份假表沒有＝no_sheet）', r.mark, { events: 'set', approved: 'set', leave: 'set', requests: 'no_sheet' });
  check('M3', '註記內容', /^系統產生（Mac mini 寫回），請勿手改/.test(w.notes.approved), true);
  check('M4', '表頭文字、分頁名都沒動', [w.m.self.sh.approved.values[0], Object.keys(w.m.self.sh).includes('approved')], [heads0, true]);
  const n = w.writes.length;
  check('M5', '再 on 一次：已經是對的就不寫', [w.pull('on').mark.approved, w.writes.length], ['same', n]);
  const off = w.pull('off');
  check('M6', 'off：拿掉註記', [off.mark.approved, w.notes.approved], ['cleared', '']);
  check('M7', '本來就沒有：off 不寫', [w.pull('off').mark.leave, w.writes.length], ['none', n + 3]);
  check('M8', 'mark 其他值：當沒帶', 'mark' in w.pull('yes'), false);
}
{
  const w = world();
  w.notes.events = '會計備註：11 月起改版';
  w.pull('on');
  check('K1', '原本有別的註記：放在後面、不蓋掉', w.notes.events.split('\n')[1], '會計備註：11 月起改版');
  w.pull('off');
  check('K2', 'off：只拿掉我們那句，別的註記照留', w.notes.events, '會計備註：11 月起改版');
}
{
  const w = world();
  w.m.self.sh.leave.getRange = () => { throw new Error('沒權限'); };
  const r = w.pull('on');
  check('E1', '寫註記出錯：回 mark.error、拉回本身照常', [typeof r.mark.error, r.ok, Array.isArray(r.events)], ['string', true, true]);
}
done();
