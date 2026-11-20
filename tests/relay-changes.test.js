/* 第 5 階段 P5-1 手改提醒的「正常寫入證據」（2026-11-21）：relay_pull 帶 with.changes 時回 DutyFeed 暫存區的變動紀錄（時間、動作、日期；不回工號）。
 * 用真的 DutyFeed.gs dutyFeedNote_ 記一筆，再用 relay_pull 拿回來。假資料。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';
const m = make({ now: T('2026-11-21T09:00:00'), props: { REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, self: { roster: [], events: [] } });
m.run(R('apps-script/RelayG.gs'));
const sb = m.sb, t0 = sb.__now;
check('C0', 'DutyFeed 有載入（測試前提）', typeof sb.dutyFeedNote_, 'function');
sb.dutyFeedNote_({ action: 'mgr_approve', emp_id: 'E01', date: '2026-11-20' }, { ok: true });
sb.__now += 60000;
sb.dutyFeedNote_({ action: 'mgr_notices', mgr_key: 'x' }, { ok: true });               // 唯讀動作：不記
sb.dutyFeedNote_({ action: 'mgr_approve', emp_id: 'E02', date: '2026-11-19' }, { ok: false });   // 失敗：不記
sb.__now += 60000;
const r = sb.handleRelayPull_({ relay_key: KEY, with: { changes: t0 - 1000 } });
check('C1', '帶 changes：回那之後成功寫入的紀錄', r.changes.list.map((x) => [x.a, x.d]), [['mgr_approve', ['2026-11-20']]]);
check('C2', '不回工號', JSON.stringify(r.changes).indexOf('E01') < 0, true);
check('C3', '起點照給、不是 partial', [r.changes.from, r.changes.partial], [t0 - 1000, false]);
check('C4', 'since 之後才算', sb.handleRelayPull_({ relay_key: KEY, with: { changes: t0 + 1 } }).changes.list.length, 0);
check('C5', 'since 超過 6 小時或不是數字：partial（mini 不拿來判）', [sb.handleRelayPull_({ relay_key: KEY, with: { changes: t0 - 7 * 3600000 } }).changes.partial, sb.handleRelayPull_({ relay_key: KEY, with: { changes: 'x' } }).changes.partial], [true, true]);
check('C6', '沒帶 changes：回應沒有 changes', 'changes' in sb.handleRelayPull_({ relay_key: KEY }), false);
check('C7', 'relay_pull 仍是唯讀（不記變動、不按門鈴）', sb.dutyFeedIsRead_('relay_pull'), true);
done();
