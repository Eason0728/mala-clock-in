/* 第 2 階段 P2-B（2026-11-21）：relay_pull 帶 sheets 時多一張公告副本（notices），讓 Mac mini 開頁狀態自己帶公告、打卡頁不用再問 Google。
 * 驗：只給白名單欄（不給 created_by）、分頁不存在回表頭、沒帶 sheets 不讀；mini 拿副本跑同一支 activeNotices 結果跟 Google 一樣。名字假的。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';

function world() {
  const m = make({ now: T('2026-11-21T09:00:00'), props: { REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, self: { roster: [], events: [] } });
  m.run(R('apps-script/RelayG.gs'));
  return m;
}
let SBD = Date;   // 用沙盒那邊的 Date（Apps Script 讀出來的日期格是它自己的 Date；跨 realm 的 instanceof 會不認）
const d = (s) => new SBD(Date.parse(s + 'T00:00:00+08:00'));

{
  const m = world();
  SBD = require('vm').runInContext('Date', m.sb);
  const nv = m.self.sh.notices.values;
  nv.push(['n1', '本週六盤點', true, '', '2026-11-20T10:00:00+08:00', '值班主管甲']);
  nv.push(['n2', '已過期的', 'TRUE', d('2026-11-01'), '2026-10-20T10:00:00+08:00', '值班主管乙']);
  nv.push(['n3', '下架的', false, '', '2026-11-19T10:00:00+08:00', '值班主管甲']);
  nv.push(['n4', '有下架日、還沒到', 'true', d('2026-11-30'), d('2026-11-21'), '值班主管丙']);
  const r = m.sb.handleRelayPull_({ relay_key: KEY, with: { sheets: true } });
  const ns = r.sheets.notices;
  check('N1', '帶 sheets：多一張 notices，表頭只有白名單欄', ns[0], ['id', 'text', 'active', 'ends_on', 'created_at']);
  check('N2', '不給 created_by（主管名字）', JSON.stringify(ns).indexOf('值班主管') < 0, true);
  check('N3', '列數照抄（含過期、下架的；篩選交給同一支 activeNotices）', ns.length, 5);
  check('N4', '日期格轉台北時間字串', ns[2][3], '2026-11-01T00:00:00+08:00');
  check('N5', '原本的 ot_month／sched_pub 照舊（分頁不存在就不帶）', Object.keys(r.sheets).sort(), ['notices']);
  // mini 拿副本跑同一支 activeNotices（engine 把副本放進同名分頁）
  const g = m.sb.activeNotices(m.self, '2026-11-21');
  const m2 = world();
  m2.self.sh.notices.values.length = 0; ns.forEach((row) => m2.self.sh.notices.values.push(row.slice()));
  check('N6', 'mini 用副本算出的公告＝Google 算的', m2.sb.activeNotices(m2.self, '2026-11-21'), g);
  check('N7', '　（Google 算的是 n4、n1 兩則）', g.map((x) => x.id), ['n4', 'n1']);
  check('N8', '沒帶 sheets：不讀公告、回應沒有 sheets', 'sheets' in m.sb.handleRelayPull_({ relay_key: KEY }), false);
}
{
  const m = world();
  delete m.self.sh.notices;
  const r = m.sb.handleRelayPull_({ relay_key: KEY, with: { sheets: true } });
  check('N9', '分頁不存在：回表頭（mini 知道「沒有公告」，不用再問 Google）', r.sheets.notices, [['id', 'text', 'active', 'ends_on', 'created_at']]);
}
{
  const m = world();
  m.self.sh.notices.values[0] = ['text', 'id', 'created_by', 'active'];   // 欄位順序不同、少欄
  m.self.sh.notices.values.push(['亂序的', 'n9', '甲', true]);
  const ns = m.sb.handleRelayPull_({ relay_key: KEY, with: { sheets: true } }).sheets.notices;
  check('N10', '欄位順序不同、少欄：照欄名對、少的給空白', ns[1], ['n9', '亂序的', true, '', '']);
}
done();
