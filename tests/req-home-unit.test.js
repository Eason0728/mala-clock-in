/* LINE 申請頁：主要單位（2026-11-27 Eason 3A）的純函式與送出前流程測試。
 * 載入真的 req-line.js（檔尾多掛一個測試用出口），測：
 *  ① homeOf：只有「兩家以上、每家都有 support 布林、原單位剛好一家」才認得主要單位；其他一律 null（＝畫面跟以前一模一樣）
 *  ② storeLabel／文字原文
 *  ③ tripHomeAsk：只在出差單、選的不是主要單位時問一次；確定後同一張單不再問；取消擋下並說清楚
 *  ④ storeGuard 整段（假的各店打卡紀錄）：出差單選主要單位＝不再問「你是在別家打卡」；選支援單位＝只問主要單位那句一次；請假、加班、沒有 support 欄位＝跟以前一樣
 * 畫面（下拉字、出差分頁預設、日期下方灰字）要瀏覽器，這裡不測。 */
'use strict';
const assert = require('assert');
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'req-line.js'), 'utf8');
const TAIL = 'window.ReqLine = { open: open };';
if (src.indexOf(TAIL) < 0) throw new Error('req-line.js 檔尾的寫法變了，請更新這支測試的出口');
const hooked = src.replace(TAIL, TAIL + ' window.__t = { st: st, homeOf: homeOf, storeLabel: storeLabel, tripHomeNote: tripHomeNote, tripAskText: tripAskText,' +
  ' tripAskCancelText: tripAskCancelText, tripHomeAsk: tripHomeAsk, storeGuard: storeGuard, setE: function (x) { E = x; } };');
const confirms = [];
let confirmAnswer = true;
const sb = { window: { confirm: (m) => { confirms.push(m); return confirmAnswer; } }, document: {}, console, Promise, setTimeout, Date, Math, JSON, String, Number, Object, Array, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
  liff: { getIDToken: () => 'tok' } };
vm.createContext(sb);
vm.runInContext(hooked, sb, { filename: 'req-line.js' });
const T = sb.window.__t;
let n = 0; const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('✓ ' + name); });

const HQ = { code: 'hq', name: '總部', emp_id: 'A1', emp_name: '王小明', support: false };
const CF = { code: 'cf', name: '央廚', emp_id: 'A2', emp_name: '王小明', support: true };
const JS = { code: 'js', name: '新竹金山', emp_id: 'A3', emp_name: '王小明', support: true };
const mk = (...x) => x.map((s) => Object.assign({}, s));
const reset = () => { confirms.length = 0; confirmAnswer = true; T.st.homeAck = null; T.st.picked = {}; };
// 各店那天的打卡紀錄：punchAt＝有卡的店代碼（一家）
const setup = (stores, cur, punchAt) => {
  T.st.init = { stores }; T.st.store = stores.filter((s) => s.code === cur)[0]; reset();
  T.setE({ STORES: stores.map((s) => ({ code: s.code })), storeApi: (d) => 'api:' + d.code,
    readRetry: (url, body) => Promise.resolve({ ok: true, day: { date: body.date, punches: url === 'api:' + punchAt ? [{ hm: '09:00', status: 'ok' }, { hm: '18:00', status: 'ok' }] : [] } }) });
};
const trip = { kind: 'trip', date: '2026-12-02', place: '總部辦公室', why: '支援', hours: '8' };

(async () => {
  await ok('homeOf：兩家、原單位剛好一家 → 認得', () => { const s = mk(HQ, CF); assert.strictEqual(T.homeOf(s), s[0]); });
  await ok('homeOf：三家（一家原單位、兩家支援）→ 認得', () => { const s = mk(CF, HQ, JS); assert.strictEqual(T.homeOf(s), s[1]); });
  await ok('homeOf：只有一家、沒有清單 → null（沒有下拉就沒有要標的）', () => { assert.strictEqual(T.homeOf(mk(HQ)), null); assert.strictEqual(T.homeOf([]), null); assert.strictEqual(T.homeOf(null), null); });
  await ok('homeOf：任何一家沒有 support（舊的記住資料、Mac mini 存檔）→ null', () => {
    const s = mk(HQ, CF); delete s[1].support; assert.strictEqual(T.homeOf(s), null);
    const u = mk(HQ, CF); u[0].support = 1; assert.strictEqual(T.homeOf(u), null, '不是布林也不認');
  });
  await ok('homeOf：兩家都是原單位（店長手動建的支援帳號）、或兩家都是支援 → null（不亂標）', () => {
    assert.strictEqual(T.homeOf(mk(HQ, Object.assign({}, CF, { support: false }))), null);
    assert.strictEqual(T.homeOf(mk(CF, JS)), null);
  });
  await ok('文字原文', () => {
    const s = mk(HQ, CF);
    assert.strictEqual(T.storeLabel(s[0], s[0]), '總部（主要單位）');
    assert.strictEqual(T.storeLabel(s[1], s[0]), '央廚');
    assert.strictEqual(T.storeLabel(s[0], null), '總部', '沒有主要單位＝跟以前一樣');
    assert.strictEqual(T.tripHomeNote(s[0]), '這張出差單會開在你的主要單位「總部」。要改開在別的單位，請在上面選。');
    assert.strictEqual(T.tripAskText(s[1], s[0]), '這張出差單會開在「央廚」，不是你的主要單位「總部」。\n\n開在別的單位，核定和薪資歸屬會對不上，之後要作廢重開。\n\n確定要開在「央廚」嗎？');
    assert.strictEqual(T.tripAskCancelText(s[0]), '沒有送出：出差單請在上面改選「總部」（你的主要單位）');
  });
  await ok('tripHomeAsk：選主要單位 → 不問', () => { setup(mk(HQ, CF), 'hq', 'hq'); assert.strictEqual(T.tripHomeAsk(trip), trip); assert.strictEqual(confirms.length, 0); });
  await ok('tripHomeAsk：選支援單位 → 問一次、確定後同一張單不再問', () => {
    setup(mk(HQ, CF), 'cf', 'cf');
    assert.strictEqual(T.tripHomeAsk(trip), trip); assert.strictEqual(confirms.length, 1);
    assert.strictEqual(confirms[0], '這張出差單會開在「央廚」，不是你的主要單位「總部」。\n\n開在別的單位，核定和薪資歸屬會對不上，之後要作廢重開。\n\n確定要開在「央廚」嗎？');
    T.tripHomeAsk(trip); T.tripHomeAsk(trip); assert.strictEqual(confirms.length, 1, '送出失敗重送不再問');
  });
  await ok('tripHomeAsk：取消 → 擋下並說清楚，下一次再按送出會再問', () => {
    setup(mk(HQ, CF), 'cf', 'cf'); confirmAnswer = false;
    assert.throws(() => T.tripHomeAsk(trip), /沒有送出：出差單請在上面改選「總部」（你的主要單位）/);
    assert.throws(() => T.tripHomeAsk(trip), /沒有送出/); assert.strictEqual(confirms.length, 2);
  });
  await ok('tripHomeAsk：請假、加班、忘打卡不問；沒有 support 欄位不問', () => {
    setup(mk(HQ, CF), 'cf', 'cf');
    ['leave', 'ot', 'miss'].forEach((k) => T.tripHomeAsk({ kind: k, date: '2026-12-02' })); assert.strictEqual(confirms.length, 0);
    const s = mk(HQ, CF); delete s[0].support; setup(s, 'cf', 'cf'); T.tripHomeAsk(trip); assert.strictEqual(confirms.length, 0);
  });
  await ok('storeGuard 出差、選主要單位、卡只在支援店：不再問「你是在別家打卡」（以前會問）', async () => {
    setup(mk(HQ, CF), 'hq', 'cf'); assert.strictEqual(await T.storeGuard(trip), trip); assert.strictEqual(confirms.length, 0);
  });
  await ok('storeGuard 出差、選支援單位、卡在那家：只問主要單位那一句（共一次）', async () => {
    setup(mk(HQ, CF), 'cf', 'cf'); await T.storeGuard(trip); assert.strictEqual(confirms.length, 1); assert.ok(/不是你的主要單位「總部」/.test(confirms[0]));
  });
  await ok('storeGuard 出差、選支援單位、卡在主要單位：也只問一次（不疊兩個框）', async () => {
    setup(mk(HQ, CF), 'cf', 'hq'); await T.storeGuard(trip); assert.strictEqual(confirms.length, 1); assert.ok(/不是你的主要單位/.test(confirms[0]));
  });
  await ok('storeGuard 出差、取消 → 沒送出（丟出訊息）', async () => {
    setup(mk(HQ, CF), 'cf', 'cf'); confirmAnswer = false;
    await assert.rejects(() => T.storeGuard(trip), /沒有送出：出差單請在上面改選「總部」/);
  });
  await ok('storeGuard 請假：跟以前一樣（選的店沒卡、別家有卡 → 問「你是在…打卡」）', async () => {
    setup(mk(HQ, CF), 'hq', 'cf'); await T.storeGuard({ kind: 'leave', date: '2026-12-02', hours: '8' });
    assert.strictEqual(confirms.length, 1); assert.strictEqual(confirms[0], '12/2 你是在央廚打卡，確定要送到「總部」嗎？');
  });
  await ok('storeGuard 出差、沒有 support 欄位（舊資料）：跟以前一樣（問「你是在…打卡」、不問主要單位）', async () => {
    const s = mk(HQ, CF); s.forEach((x) => delete x.support); setup(s, 'hq', 'cf'); await T.storeGuard(trip);
    assert.strictEqual(confirms.length, 1); assert.strictEqual(confirms[0], '12/2 你是在央廚打卡，確定要送到「總部」嗎？');
  });
  await ok('storeGuard 只綁一家：直接放行', async () => { setup(mk(HQ), 'hq', 'hq'); assert.strictEqual(await T.storeGuard(trip), trip); assert.strictEqual(confirms.length, 0); });
  console.log('\n' + n + ' 過、0 失敗');
})().catch((e) => { console.error(e); process.exit(1); });
