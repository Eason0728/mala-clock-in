#!/usr/bin/env node
/* 班表寬限（2026-11-24）mini／Google 一致性實跑：真的快速通道程式（mala-clock-relay server，只 require、不改）＋假 Google
 * （tools/fake-google.js，跑本工作區的真 Apps Script），記憶體資料庫、隨機埠，不連任何真網址、不用金鑰（全是測試假值）。
 * 驗：①兩邊都有班表 → 開頁、掃描都不寫，本人按下班照舊 19:00 一張；②Google 有、mini 還沒拉到 → mini 開頁照舊寫，Google 不寫，
 *     抄回後 Google 一張；③mini 有、Google 讀不到 → Google 掃描照舊寫，mini 開頁不寫、拉回後鎖，一張；④兩邊都讀不到 → 兩邊各寫，抄回去重後一張。
 *   ⑥（2026-11-23 審查第一輪）跨店：光復開頁、那段在金山 → 用金山班表＋金山工號；金山沒發布 → 照舊鎖。⑦ 凌晨才刷進前一天的跨夜班 → 用前一天那段。
 * 用法：RELAY_DIR=~/dev/mala-clock-relay/server node tools/cap10-grace-mini.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const RELAY = process.env.RELAY_DIR || path.join(os.homedir(), 'dev/mala-clock-relay/server');
const { createApp } = require(path.join(RELAY, 'index'));
const { buildConfig } = require(path.join(RELAY, 'lib/config'));
const { makeFakeGoogle, buildGasRoot } = require(path.join(RELAY, 'tools/fake-google'));
const REPO = path.join(__dirname, '..');

const KEY_GF = 'k'.repeat(32), ADMIN = 'admin-key-for-tests-0001', SUB1 = 'U' + '1'.repeat(32);
const GF = { lat: 24.7840945, lng: 121.0157448 };
const D = '2026-11-20', T = (hms) => Date.parse(D + 'T' + hms + '+08:00');
const SCHED = { start: '2026-11-01', shifts: [{ id: 'A', name: '班', start: '09:00', end: '18:00' }],
  rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'A' } : { t: 'R' })) }] };
const SP_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];

async function setup(cap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap10-grace-mini-'));
  const stores = [{ code: '', dir: 'fake-gf', ss: 'SS_GF', lat: GF.lat, lng: GF.lng, radius_m: 20, relayKey: KEY_GF }];
  buildGasRoot(REPO, dir, stores);
  let now = T('08:00:00');
  const g = makeFakeGoogle({ gasRoot: dir, stores, now, tokens: { TOK1: SUB1 }, seed: {
    gf: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: SUB1 }],
          events: [{ ts: D + 'T08:55:00+08:00', emp_id: 'E01', type: 'in', lat: GF.lat, lng: GF.lng, distance_m: 0, within_range: true, device_id: 'D1', device_match: true, status: 'ok', accuracy_m: 5 }],
          props: { REQ_BIND_FROM: 'off', REST_CAP_ON: cap } } } });
  const port = await g.listen(0), base = 'http://127.0.0.1:' + port;
  const cfg = buildConfig({ STORE_GF_URL: base + '/s/gf', STORE_GF_RELAY_KEY: KEY_GF, LINE_CHANNEL_ID: '2011292256', ADMIN_KEY: ADMIN, G_ENABLED: '1', G_GAS_ROOT: dir },
    [{ code: '', name: '光復', lat: GF.lat, lng: GF.lng, radius_m: 20, gas_dir: 'fake-gf' }]);
  const app = createApp(cfg, { dbPath: ':memory:', gDbPath: ':memory:', gasRoot: dir, now: () => now, verifyUrl: base + '/line/verify', snapDir: path.join(dir, 'snap'),
    backupDir: path.join(dir, 'bak'), log: () => {}, remoteOpts: { tries: 1, timeoutMs: 5000, echoMs: 10, retryMs: 10 } });
  const p = app.primary, gsb = g.eng.sandbox('');
  const book = gsb.SpreadsheetApp.openById('SS_GF');
  const w = {
    p, g, gsb,
    at: (hms) => { now = hms.length > 8 ? Date.parse(hms) : T(hms); g.setNow(now); },   // 'HH:MM:SS'＝11/20；完整 ISO＝那個時刻
    gSched: (on) => book.setSheet('sched_pub', on ? [SP_HEAD, ['', 'T01', 1, JSON.stringify(SCHED), 'op', '']] : [SP_HEAD]),
    gSweep: () => gsb.capSweep(),
    gCaps: () => g.events('').filter((e) => String(e.source) === 'system_cap').map((e) => String(e.ts).slice(11, 16)),
    mCaps: () => p.gs.all('').filter((r) => String(r.data.source || '') === 'system_cap').map((r) => String(r.data.ts).slice(11, 16)),
    status: () => p.handleStatus({ store: 'gf', id_token: 'TOK1' }),
    punch: (type, n) => p.handlePunch({ id_token: 'TOK1', store: 'gf', lat: GF.lat, lng: GF.lng, accuracy: 8, type, req_id: 'r' + String(n).padStart(16, '0'), confirm_same: true }),
    close: async () => { await app.stop(); await g.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return w;
}
const out = [];
const ok = (id, label, got, want) => { const pass = JSON.stringify(got) === JSON.stringify(want); out.push(pass); console.log((pass ? '✓ ' : '✗ ') + id + ' ' + label + '\n    實際=' + JSON.stringify(got) + (pass ? '' : '\n    預期=' + JSON.stringify(want))); };

(async () => {
  // ① 兩邊都有班表
  {
    const w = await setup('2');
    w.gSched(true);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:04:00'); await w.p.pull('', { sheets: true });
    w.at('19:05:00');
    const s = await w.status();
    w.gSweep();
    ok('M1', '兩邊都有班表：mini 開頁不鎖（grace_hm 19:00）、Google 掃描不寫', [s.role, s.cap.locked, s.cap.grace_hm, w.mCaps(), w.gCaps()], ['primary', false, '19:00', [], []]);
    w.at('20:10:00'); await w.p.pull('');
    const r = await w.punch('out', 1);
    await w.p.pushAll(); await w.p.pull('', { full: true });
    w.gSweep();
    ok('M2', '本人在 mini 按下班 20:10 → cap_locked、系統卡 19:00；抄回 Google 後兩邊各一張', [r.status, w.mCaps(), w.gCaps()], ['cap_locked', ['19:00'], ['19:00']]);
    await w.close();
  }
  // ② Google 有班表、mini 還沒拉到
  {
    const w = await setup('2');
    w.gSched(false);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:04:00'); await w.p.pull('', { sheets: true });   // mini 拿到的是「沒有班表」
    w.gSched(true);                                             // 19:04:30 營運系統發布班表（mini 下次帶 sheets 前不知道）
    w.at('19:05:00'); await w.p.pull('');                       // 增量拉回（5 分鐘內不帶 sheets）
    const s = await w.status();
    ok('M3', 'mini 讀不到班表：開頁照舊寫 19:00、鎖', [s.cap.locked, s.cap.sys_hm, w.mCaps()], [true, '19:00', ['19:00']]);
    w.gSweep();
    ok('M4', 'Google 有班表：掃描不寫（抄回前 Google 0 張）', w.gCaps(), []);
    await w.p.pushAll(); w.gSweep(); await w.p.pull('', { full: true });
    ok('M5', '抄回後：Google 一張 19:00、mini 一張，再掃描也不多', [w.gCaps(), w.mCaps()], [['19:00'], ['19:00']]);
    await w.close();
  }
  // ③ mini 有班表、Google 讀不到（例：Google 端快取／發布被取消）
  {
    const w = await setup('2');
    w.gSched(true);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:04:00'); await w.p.pull('', { sheets: true });   // mini 拿到班表
    w.gSched(false);                                            // Google 那邊班表取消發布
    w.at('19:05:00'); await w.p.pull('');
    const s = await w.status();
    ok('M6', 'mini 有班表：開頁不寫、不鎖', [s.cap.locked, s.cap.grace_hm, w.mCaps()], [false, '19:00', []]);
    w.gSweep();
    ok('M7', 'Google 讀不到：掃描照舊寫 19:00', w.gCaps(), ['19:00']);
    w.at('19:06:00'); await w.p.pull('');
    const s2 = await w.status();
    ok('M8', 'mini 拉回後：看到 Google 那張、鎖住、正本一張', [s2.cap.locked, s2.cap.sys_hm, w.mCaps(), w.gCaps()], [true, '19:00', ['19:00'], ['19:00']]);
    await w.close();
  }
  // ④ 兩邊都讀不到 → 兩邊各寫，抄回去重
  {
    const w = await setup('2');
    w.gSched(false);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:05:00'); await w.p.pull('', { sheets: true });
    const s = await w.status();
    w.gSweep();
    ok('M9', '兩邊都讀不到：mini 開頁、Google 掃描各寫一張 19:00', [s.cap.sys_hm, w.mCaps(), w.gCaps()], ['19:00', ['19:00'], ['19:00']]);
    await w.p.pushAll(); await w.p.pull('', { full: true });
    ok('M10', '抄回去重後兩邊都只有一張', [w.gCaps(), w.mCaps()], [['19:00'], ['19:00']]);
    await w.close();
  }
  // ⑤ 開關 '1'（寬限關）：兩邊都有班表也照舊寫
  {
    const w = await setup('1');
    w.gSched(true);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:05:00'); await w.p.pull('', { sheets: true });
    const s = await w.status();
    ok('M11', "REST_CAP_ON='1'：mini 開頁照舊寫 19:00（引擎拉到的屬性是 '1'）", [s.cap.sys_hm, w.mCaps()], ['19:00', ['19:00']]);
    await w.close();
  }
  // ⑥ 跨店（2026-11-23 審查第一輪第 1 條）：同仁在金山（mztjs，工號 B07）09:00 上班、光復（E01）19:05 開頁；班表在光復 sched_pub 的 mztjs 列
  // M15（2026-11-23 第二輪驗收擋項 1）：金山名冊同名兩人 B07（09–18）、B08（10–20），B07 上班 → 光復（mini）用打卡列對到 B07，跟金山一樣不鎖
  for (const [id, withSched, want, twin] of [['M12', true, [false, '19:00', null, [], []]], ['M13', false, [true, null, '19:00', [], []]], ['M15', true, [false, '19:00', null, [], []], true]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap10-grace-mini-x-'));
    const JS = { lat: 25.2, lng: 121.6 }, KEY_JS = 'j'.repeat(32);
    const stores = [{ code: '', dir: 'fake-gf', ss: 'SS_GF', lat: GF.lat, lng: GF.lng, radius_m: 20, relayKey: KEY_GF },
      { code: 'mztjs', dir: 'fake-js', ss: 'SS_JS', lat: JS.lat, lng: JS.lng, radius_m: 20, relayKey: KEY_JS }];
    buildGasRoot(REPO, dir, stores);
    let now = T('08:00:00');
    const bSched = { start: '2026-11-01', shifts: SCHED.shifts.concat([{ id: 'C', name: '晚', start: '10:00', end: '20:00' }]), rows: [{ emp_id: 'B07', name: '測試一', cells: SCHED.rows[0].cells }] };
    if (twin) bSched.rows.push({ emp_id: 'B08', name: '測試一', cells: SCHED.rows[0].cells.map((c) => (c.t === 'W' ? { t: 'W', s: 'C' } : c)) });
    const g = makeFakeGoogle({ gasRoot: dir, stores, now, tokens: { TOK1: SUB1 }, seed: {
      gf: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: SUB1 }], events: [], props: { REQ_BIND_FROM: 'off', REST_CAP_ON: '2' } },
      mztjs: { roster: [{ emp_id: 'B07', name: '測試一', key: 'KB', device_id: 'DB', active: 'TRUE' }].concat(twin ? [{ emp_id: 'B08', name: '測試 一', key: 'KB8', device_id: 'DB8', active: 'TRUE' }] : []),
               events: [{ ts: D + 'T09:00:00+08:00', emp_id: 'B07', type: 'in', lat: JS.lat, lng: JS.lng, distance_m: 0, within_range: true, device_id: 'DB', device_match: true, status: 'ok', accuracy_m: 5 }],
               props: { REQ_BIND_FROM: 'off', REST_CAP_ON: '2' } } } });
    const port = await g.listen(0), base = 'http://127.0.0.1:' + port;
    const cfg = buildConfig({ STORE_GF_URL: base + '/s/gf', STORE_GF_RELAY_KEY: KEY_GF, STORE_MZTJS_URL: base + '/s/mztjs', STORE_MZTJS_RELAY_KEY: KEY_JS,
      LINE_CHANNEL_ID: '2011292256', ADMIN_KEY: ADMIN, G_ENABLED: '1', G_GAS_ROOT: dir },
      [{ code: '', name: '光復', lat: GF.lat, lng: GF.lng, radius_m: 20, gas_dir: 'fake-gf' }, { code: 'mztjs', name: '金山', lat: JS.lat, lng: JS.lng, radius_m: 20, gas_dir: 'fake-js' }]);
    const app = createApp(cfg, { dbPath: ':memory:', gDbPath: ':memory:', gasRoot: dir, now: () => now, verifyUrl: base + '/line/verify', snapDir: path.join(dir, 'snap'),
      backupDir: path.join(dir, 'bak'), log: () => {}, remoteOpts: { tries: 1, timeoutMs: 5000, echoMs: 10, retryMs: 10 } });
    const p = app.primary, book = g.eng.sandbox('').SpreadsheetApp.openById('SS_GF');
    book.setSheet('sched_pub', withSched ? [SP_HEAD, ['mztjs', 'T01', 1, JSON.stringify(bSched), 'op', '']] : [SP_HEAD]);
    await p.pull('', { full: true }); await p.pull('mztjs', { full: true }); await p.setPrimary(true, ['', 'mztjs']);
    now = T('19:05:00'); g.setNow(now); await p.pull('', { sheets: true }); await p.pull('mztjs', { sheets: true });
    const s = await p.handleStatus({ store: 'gf', id_token: 'TOK1' });
    const caps = (c) => g.events(c).filter((e) => String(e.source) === 'system_cap').length ? ['x'] : [];
    ok(id, twin ? '同名兩工號（金山 B07 09–18／B08 10–20、B07 上班）：光復（mini）開頁用打卡列對到 B07 → 不鎖、grace_hm 19:00' : withSched ? '跨店：金山班表 09–18 → 光復（mini）開頁不鎖、grace_hm 19:00、兩店 Google 都沒有系統卡' : '跨店：金山沒發布 → 光復（mini）開頁照舊鎖、sys_hm 19:00（本店只擋不寫）',
      [s.cap && s.cap.locked, s.cap && s.cap.grace_hm || null, s.cap && s.cap.sys_hm || null, caps(''), caps('mztjs')], want);
    await app.stop(); await g.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // ⑦ 凌晨才刷進跨夜班（審查第一輪第 2 條）：11/20 18:00–02:00、11/21 例假；11/21 00:05 上班，10:20 mini 開頁、Google 掃描
  {
    const w = await setup('2');
    const night = { start: '2026-11-01', shifts: [{ id: 'N', name: '夜', start: '18:00', end: '02:00' }], rows: [{ emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'N' } : { t: 'R' })) }] };
    const bk = w.gsb.SpreadsheetApp.openById('SS_GF');
    bk.setSheet('sched_pub', [SP_HEAD, ['', 'T01', 1, JSON.stringify(night), 'op', '']]);
    const ev = bk.getSheetByName('events');
    ev.values.length = 1;   // 換掉 setup 的 08:55 上班卡
    ev.appendRow(['2026-11-21T00:05:00+08:00', 'E01', 'in', GF.lat, GF.lng, 0, true, 'D1', true, 'ok', 5]);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('2026-11-21T10:20:00+08:00');
    await w.p.pull('', { sheets: true });
    const s = await w.p.handleStatus({ store: 'gf', id_token: 'TOK1' });
    w.gSweep();
    ok('M14', '凌晨跨夜班：mini 開頁不鎖（grace_hm 10:15）、Google 掃描不寫', [s.cap.locked, s.cap.grace_hm || null, w.mCaps(), w.gCaps()], [false, '10:15', [], []]);
    await w.close();
  }
  // ⑧ 快取內容壞（2026-11-23 第二輪驗收擋項 2）：mini 的快取是記憶體 Map、只有程式自己寫；仍驗同一套檢查——把資料塊改壞，mini 開頁重讀、照寬限
  {
    const w = await setup('2');
    w.gSched(true);
    await w.p.pull('', { full: true }); await w.p.setPrimary(true, ['']);
    w.at('19:04:00'); await w.p.pull('', { sheets: true });
    w.at('19:05:00');
    const s1 = await w.status();
    const snap = w.p.engine.cacheSnapshot(''), k = 'capgr1:d:|T01:0', had = snap.has(k);
    if (had) snap.set(k, Object.assign({}, snap.get(k), { v: '{壞' }));
    w.p.engine.cacheRestore('', snap);
    w.at('19:06:00');
    const s2 = await w.status();
    ok('M16', 'mini 快取資料塊改壞：開頁照寬限（不鎖、grace_hm 19:00）、沒有系統卡、快取已重寫', [had, s1.cap.grace_hm, s2.cap.locked, s2.cap.grace_hm, w.mCaps(),
      String((w.p.engine.cacheSnapshot('').get(k) || {}).v || '').startsWith('{"v":1')], [true, '19:00', false, '19:00', [], true]);
    await w.close();
  }
  const bad = out.filter((x) => !x).length;
  console.log('\n── 小計：相符 ' + (out.length - bad) + '、不符 ' + bad + ' ──');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
