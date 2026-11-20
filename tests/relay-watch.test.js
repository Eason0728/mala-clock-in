/* 第 2 階段 P2-A（編輯器一鍵關正本）＋P2-D（Google 端停機通知），RelayG.gs（2026-11-21）。
 * 用真函式跑（Code／Liff／Rest／Requests／DutyFeed＋RelayG）。名字一律假名、金鑰與網址假的。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');
const KEY = 'relay-key-for-tests-0123456789';
const HOOK = 'https://hook.example.test/notify';
const MIN = 60000;

function world(opt) {
  opt = opt || {};
  const sent = [];
  const m = make({ now: T('2026-11-21T09:00:00'), props: Object.assign({ REQ_BIND_FROM: 'off', RELAY_KEY: KEY }, opt.props || {}),
    self: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE' }], events: [] },
    fetch: (url, o) => { if (url !== HOOK) return undefined; if (opt.hookDown) throw new Error('連不上'); sent.push(JSON.parse(o.payload)); return { ok: true }; } });
  m.run(R('apps-script/RelayG.gs'));
  const triggers = [];
  m.sb.ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => { const t = { fn, n, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }) }),
  };
  const pull = () => m.sb.handleRelayPull_({ relay_key: KEY });
  const tick = () => m.sb.relayGWatchTick();
  const adv = (ms) => { m.sb.__now += ms; };
  const prop = (k) => m.sb.PropertiesService.getScriptProperties().getProperty(k);
  return { m, sent, triggers, pull, tick, adv, prop };
}
const ON = { G_WATCH_ON: '1', G_WATCH_HOOK_URL: HOOK, G_WATCH_TO: 'someone@example.test', G_WATCH_HOOK_TOKEN: 'hook-token-0001' };

// ── P2-A 編輯器一鍵關正本 ──
{
  const w = world();
  const sb = w.m.sb;
  sb.handleRelayMode_({ relay_key: KEY, on: true, stores: ['SS1'] });
  sb.handleRelayMode_({ relay_key: KEY, recon: { SS1: { '2026-11': { ok: true, mini: 5, g: 5, at: sb.__now } } } });
  check('A1', '切換中、對帳新鮮 → 鎖月放行', sb.payGReconBlock_('2026-11', 'SS1'), null);
  w.adv(31 * MIN);
  check('A2', 'mini 不在 31 分鐘 → 鎖月被擋（對帳太舊）', (sb.payGReconBlock_('2026-11', 'SS1') || {}).error, 'g_recon_stale');
  const r = sb.relayGEditorPrimaryOff();
  check('A3', '編輯器執行 relayGEditorPrimaryOff（不用參數）', [r.ok, r.was_on, r.on], [true, true, false]);
  check('A4', '之後鎖月放行（改回只看 Google）', sb.payGReconBlock_('2026-11', 'SS1'), null);
  check('A5', 'G_PRIMARY 記號：關、記是編輯器關的', [JSON.parse(w.prop('G_PRIMARY')).on, JSON.parse(w.prop('G_PRIMARY')).by], [false, 'editor']);
  check('A6', '對帳結果照留（之後 g-switch 打開時還在）', !!JSON.parse(w.prop('G_RECON')).SS1, true);
  check('A7', '再執行一次也沒事（本來就關）', sb.relayGEditorPrimaryOff().was_on, false);
  sb.handleRelayMode_({ relay_key: KEY, on: true, stores: ['SS1'] });
  check('A8', 'g-switch 照常能再打開', (sb.payGReconBlock_('2026-11', 'SS1') || {}).error, 'g_recon_stale');
  const s = sb.relayGEditorStatus();
  check('A9', '現況函式只讀、不帶收件人與金鑰', [s.primary.on, JSON.stringify(s).indexOf('example.test') < 0, JSON.stringify(s).indexOf(KEY) < 0], [true, true, true]);
}

// ── P2-D 停機通知 ──
{
  const w = world({ props: ON });
  w.pull();
  check('D1', 'relay_pull 記「mini 剛來過」（快取＋屬性）', [Number(w.m.cache.g_watch_seen.v) === w.m.sb.__now, w.prop('G_WATCH_SEEN') === String(w.m.sb.__now)], [true, true]);
  w.adv(60000); w.pull();
  check('D2', '5 分鐘內再拉：只更新快取、不再寫屬性', [Number(w.m.cache.g_watch_seen.v) === w.m.sb.__now, Number(w.prop('G_WATCH_SEEN')) < w.m.sb.__now], [true, true]);
  w.adv(10 * MIN); check('D3', '10 分鐘沒來：還不算停', [w.tick().state, w.sent.length], ['up', 0]);
  w.adv(5 * MIN); check('D3b', '剛好 15 分鐘：還不算停', w.tick().state, 'up');
  w.adv(MIN); const t = w.tick();
  check('D4', '16 分鐘沒來 → 停了、送 1 封', [t.state, t.sent, w.sent.length], ['down', true, 1]);
  check('D5', '通知內容：收件人從屬性讀、帶金鑰、等級高、不帶工號姓名', [w.sent[0].to, w.sent[0].token, w.sent[0].level, w.sent[0].key, /E01|測試一/.test(JSON.stringify(w.sent[0]))], ['someone@example.test', 'hook-token-0001', 'high', 'clock:mini-down', false]);
  check('D6', '通知寫了處理方法（編輯器一鍵關）', w.sent[0].text.indexOf('relayGEditorPrimaryOff') >= 0, true);
  w.adv(10 * MIN); w.tick(); w.adv(10 * MIN); w.tick();
  check('D7', '同一次停機不再送', w.sent.length, 1);
  w.adv(MIN); w.pull(); const u = w.tick();
  check('D8', 'mini 回來 → 恢復、送第 2 封', [u.state, u.recovered, u.sent, w.sent.length, w.sent[1].key], ['up', true, true, 2, 'clock:mini-up']);
  w.adv(10 * MIN); w.pull(); w.tick();
  check('D9', '恢復後正常：不再送', w.sent.length, 2);
  check('D10', '紀錄上一次停機（不存個資）', JSON.parse(w.prop('G_WATCH_STATE')).last_down.up_sent, true);
}
{
  const w = world({ props: ON });
  w.pull(); w.adv(16 * MIN);
  w.m.cache.g_watch_seen = undefined; delete w.m.cache.g_watch_seen;   // 快取被清掉：靠屬性
  check('D11', '快取被清掉也看得出停了（屬性備援）', w.tick().state, 'down');
}
{
  const w = world({ props: Object.assign({}, ON, { G_WATCH_ON: '' }) });
  w.pull(); w.adv(30 * MIN);
  check('D12', 'G_WATCH_ON 沒設 → 關：不看、不送', [w.tick().state, w.sent.length], ['off', 0]);
  const w2 = world({ props: Object.assign({}, ON, { G_WATCH_ON: 'yes' }) });
  w2.pull(); w2.adv(30 * MIN);
  check('D13', 'G_WATCH_ON 填錯 → 維持關', [w2.tick().state, w2.sent.length], ['off', 0]);
}
{
  const w = world({ props: Object.assign({}, ON, { G_WATCH_HOOK_URL: '' }) });
  w.pull(); w.adv(16 * MIN);
  const t = w.tick();
  check('D14', '沒設通知網址：標停了、記 no_hook、不丟錯', [t.state, t.sent, t.error], ['down', false, 'no_hook']);
  w.m.sb.PropertiesService.getScriptProperties().setProperty('G_WATCH_HOOK_URL', HOOK);
  w.adv(10 * MIN); const t2 = w.tick();
  check('D15', '補設網址後下一輪補送「停了」那封', [t2.sent, w.sent.length], [true, 1]);
}
{
  const w = world({ props: ON, hookDown: true });
  w.pull(); w.adv(16 * MIN);
  check('D16', '通知那端連不上：不丟錯、下一輪再試', [w.tick().error, JSON.parse(w.prop('G_WATCH_STATE')).down_sent], ['fetch', false]);
  w.adv(MIN); w.pull(); const u = w.tick();
  check('D17', '停的那封沒送出去 → 恢復也不送（不會只收到「恢復了」）', [u.state, u.sent, w.sent.length], ['up', false, 0]);
}
{
  const w = world({ props: ON });
  check('D18', '從來沒來過：不猜', w.tick().state, 'never');
  const r = w.m.sb.relayGWatchInstall();
  check('D19', '裝觸發器：每 10 分鐘一個、先記一次時間', [r.ok, w.triggers.length, w.triggers[0].fn, w.triggers[0].n, !!w.prop('G_WATCH_SEEN')], [true, 1, 'relayGWatchTick', 10, true]);
  w.m.sb.relayGWatchInstall();
  check('D20', '重裝不會變兩個', w.triggers.length, 1);
  check('D21', '拆掉', [w.m.sb.relayGWatchUninstall().removed, w.triggers.length], [1, 0]);
  check('D22', '現況函式看得到觸發器狀態、不印收件人', [w.m.sb.relayGEditorStatus().watch.trigger, w.m.sb.relayGEditorStatus().watch.to], [false, true]);
}
// relay_pull 回應不變（只多記號，不多欄位）
{
  const w = world();
  const r = w.pull();
  check('D23', 'relay_pull 回應沒有新欄位', Object.keys(r).sort().join(','), 'config,events,from_row,headers,now,ok,total,v');   // 跟 main 一樣的欄位
}
done();
