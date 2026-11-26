#!/usr/bin/env node
/* 補缺卡分塊快取（#238 審查第 1 輪擋項）的時序在快速通道（mini，記憶體快取）與 Google 實跑：真的快速通道程式（mala-clock-relay server，只 require、不改）
 * ＋假 Google（tools/fake-google.js），記憶體資料庫、隨機埠，不連任何真網址、不用金鑰（全是測試假值）。
 * 時序（REST_CAP_ON='2'、整張班表很小）：甲 09:00 上班、14:00 下班、20:00 下班（缺上班卡），班表 14:00–20:00；乙 08:00 上班還在上班、班表 08:00–12:00
 *   （18:00 滿 10 比班表下班晚超過 30 分＝寬限真的生效，grace_hm 18:00）。
 *   20:15 乙開頁（mini）／Google 掃描（處理乙）→ 寬限把兩邊的 capgr1: 暖起來（輸出 mini_warm／google_warm＝重新發布前快取裡已有 capgr1:i，前提沒成立就標出來）；20:16 班表正式改成甲 18:00–20:00（mini 帶 sheets 拉回）；
 *   20:17 看甲：Google 端 capCheck_（按上班）、mini 開頁 in_block、mini 按上班。
 *   預期（＝0bf30bd）：補缺卡第一次讀到新班 → 20:00 下班卡補回 18:00 → 5＋2＝7 小時 → 不擋、上班卡收下。
 * 用法：RELAY_DIR=~/dev/mala-clock-relay/server [CAP_REPO=<放 apps-script 的資料夾，預設本 repo>] node tools/cap10-fill-chunk-mini.js
 *   CAP_REPO 指到別的版本（例 git worktree add --detach <路徑> 0bf30bd／ad022fc）就是跑那一版。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const RELAY = process.env.RELAY_DIR || path.join(os.homedir(), 'dev/mala-clock-relay/server');
const { createApp } = require(path.join(RELAY, 'index'));
const { buildConfig } = require(path.join(RELAY, 'lib/config'));
const { makeFakeGoogle, buildGasRoot } = require(path.join(RELAY, 'tools/fake-google'));
const REPO = process.env.CAP_REPO || path.join(__dirname, '..');

const KEY_GF = 'k'.repeat(32), ADMIN = 'admin-key-for-tests-0001', SUB1 = 'U' + '1'.repeat(32), SUB2 = 'U' + '2'.repeat(32);
const GF = { lat: 24.7840945, lng: 121.0157448 };
const D = '2026-11-20', T = (hms) => Date.parse(D + 'T' + hms + '+08:00');
const SP_HEAD = ['store', 'period', 'seq', 'data', 'last_op', 'updated_at'];
const SHIFTS = [{ id: 'E', name: '早早', start: '08:00', end: '12:00' }, { id: 'A', name: '早', start: '09:00', end: '18:00' }, { id: 'P', name: '午', start: '14:00', end: '20:00' }, { id: 'Q', name: '晚', start: '18:00', end: '20:00' }];
const sched = (sid) => ({ start: '2026-11-01', shifts: SHIFTS, rows: [
  { emp_id: 'E01', name: '測試一', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: sid } : { t: 'R' })) },
  { emp_id: 'E02', name: '測試二', cells: Array.from({ length: 28 }, (_, i) => (i === 19 ? { t: 'W', s: 'E' } : { t: 'R' })) }] });
const ev = (ts, emp, type) => ({ ts: D + 'T' + ts + '+08:00', emp_id: emp, type, lat: GF.lat, lng: GF.lng, distance_m: 0, within_range: true, device_id: emp === 'E01' ? 'D1' : 'D2', device_match: true, status: 'ok', accuracy_m: 5 });

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap10-fill-mini-'));
  const stores = [{ code: '', dir: 'fake-gf', ss: 'SS_GF', lat: GF.lat, lng: GF.lng, radius_m: 20, relayKey: KEY_GF }];
  buildGasRoot(REPO, dir, stores);
  const f = path.join(dir, 'fake-gf', 'Cap10.js'), src = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, src.replace('var CAP_SINGLE_STORES = 9;', 'var CAP_SINGLE_STORES = 1;'));   // 只有一家店：寬限的「至少 9 家」門檻換成 1（mini 與假 Google 載同一份）
  let now = T('19:30:00');
  const g = makeFakeGoogle({ gasRoot: dir, stores, now, tokens: { TOK1: SUB1, TOK2: SUB2 }, seed: {
    gf: { roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: SUB1 },
                   { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: SUB2 }],
          events: [ev('08:00:00', 'E02', 'in'), ev('09:00:00', 'E01', 'in'), ev('14:00:00', 'E01', 'out'), ev('20:00:00', 'E01', 'out')],
          props: { REQ_BIND_FROM: 'off', REST_CAP_ON: '2' } } } });
  const port = await g.listen(0), base = 'http://127.0.0.1:' + port;
  const cfg = buildConfig({ STORE_GF_URL: base + '/s/gf', STORE_GF_RELAY_KEY: KEY_GF, LINE_CHANNEL_ID: '2011292256', ADMIN_KEY: ADMIN, G_ENABLED: '1', G_GAS_ROOT: dir },
    [{ code: '', name: '光復', lat: GF.lat, lng: GF.lng, radius_m: 20, gas_dir: 'fake-gf' }]);
  const app = createApp(cfg, { dbPath: ':memory:', gDbPath: ':memory:', gasRoot: dir, now: () => now, verifyUrl: base + '/line/verify', snapDir: path.join(dir, 'snap'),
    backupDir: path.join(dir, 'bak'), log: () => {}, remoteOpts: { tries: 1, timeoutMs: 5000, echoMs: 10, retryMs: 10 } });
  const p = app.primary, gsb = g.eng.sandbox(''), book = gsb.SpreadsheetApp.openById('SS_GF');
  const at = (hms) => { now = T(hms); g.setNow(now); };
  const setSched = (sid) => book.setSheet('sched_pub', [SP_HEAD, ['', 'T01', 1, JSON.stringify(sched(sid)), 'op' + sid, '']]);
  try {
    setSched('P');
    await p.pull('', { full: true }); await p.setPrimary(true, ['']);
    at('20:15:00'); await p.pull('', { sheets: true });
    const hasGr = (m) => Array.from(m.keys()).some((k) => k === 'capgr1:i');
    const miniBefore = hasGr(p.engine.cacheSnapshot(''));
    const s2 = await p.handleStatus({ store: 'gf', id_token: 'TOK2' });      // mini：乙開頁（寬限暖起 mini 的 capgr1:）
    const miniWarm = !miniBefore && hasGr(p.engine.cacheSnapshot(''));
    const gBefore = !!gsb.CacheService.getScriptCache().get('capgr1:i');
    gsb.capSweep();                                                          // Google：掃描處理乙（寬限暖起 Google 的 capgr1:）
    const gWarm = !gBefore && !!gsb.CacheService.getScriptCache().get('capgr1:i');
    at('20:16:00'); setSched('Q'); await p.pull('', { sheets: true });       // 甲改成 18:00–20:00，mini 帶 sheets 拉回
    at('20:17:00');
    const me = gsb.readSheetAsObjects(gsb.getSS().getSheetByName('roster')).rows.filter((r) => r.emp_id === 'E01')[0];
    const gst = gsb.capCheck_(gsb.getSS(), me, now, null, 'in');            // Google 端：甲按上班時的判斷
    const s1 = await p.handleStatus({ store: 'gf', id_token: 'TOK1' });      // mini：甲開頁
    const r = await p.handlePunch({ id_token: 'TOK1', store: 'gf', lat: GF.lat, lng: GF.lng, accuracy: 8, type: 'in', req_id: 'r' + '1'.padStart(16, '0'), confirm_same: true });
    return { grace_b: (s2.cap && s2.cap.grace_hm) || null, mini_warm: miniWarm, google_warm: gWarm, google: { in_block: !!(gst && (gst.in_block || gst.locked)), today_h: gst && gst.today_h },
      mini: { in_block: !!(s1.cap && (s1.cap.in_block || s1.cap.locked)), today_h: s1.cap && s1.cap.today_h, punch: r.status || (r.ok ? 'ok' : r.error || r.reason) } };
  } finally { await app.stop(); await g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  const r = await run();
  console.log('REPO=' + REPO + '\n' + JSON.stringify(r));
  const want = { google: { in_block: false }, mini: { in_block: false, punch: 'ok' } };
  const pre = r.mini_warm && r.google_warm && r.grace_b === '18:00';
  if (!pre) console.log('✗ 前提沒成立：重新發布前 mini／Google 的寬限快取沒有都被乙暖起來（mini_warm／google_warm／grace_b），這次結果不算數');
  const pass = pre && r.google.in_block === want.google.in_block && r.mini.in_block === want.mini.in_block && r.mini.punch === want.mini.punch;
  console.log((pass ? '✓' : '✗') + ' 乙開頁（mini）／掃描（Google）先暖寬限 → 重新發布 → 甲按上班：Google 不擋、mini 不擋、上班卡收下（mini 與 Google 一致）');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
