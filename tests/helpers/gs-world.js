// 測試用「九店世界」（2026-11-10 挑錯時寫的，2026-11-11 搬進 repo）：每家店一個獨立沙盒（＝各自的 Apps Script 專案），
// 光復另外加載 LineHub.gs／SvcStaff.gs（可選 Payroll.gs）。全部走真函式：
//   畫面→店家：進那家店沙盒真的 doPost；光復→店家（lineHubCallStore_ 的 UrlFetchApp.fetch）：轉給那家店沙盒的 doPost；
//   光復直接開別店試算表（SpreadsheetApp.openById）：拿到那家店沙盒「同一份」記憶體試算表。
// 不在這個 repo 的只有管理系統那一端（首次跨店把關）：用 miniApprove（一律放行並呼叫那家店真的 svc_add）或 'deny' 假裝。
// 店家清單讀 tools/stores.json（只取代碼、店名、座標、半徑；後端網址不讀）。金鑰、網址、LINE 帳號全部是假的。
// 用法：const { buildWorld, R } = require('./helpers/gs-world');
//   const w = buildWorld({ rosters: { '': [R({ emp_id: 'E01', name: '測試一', key: 'K1', line_user_id: 'U1' })] } });
//   w.openPage('TOK_U1', w.fixAt('mztjs', 5));  w.bind('TOK_U1', fix, '測試一');  w.punch('TOK_U1', fix, 'in');
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const H = require('./gs-sandbox');
const Core = require(path.join(H.ROOT, 'clock-line-core.js'));   // 前端真的挑店函式

// 只取代碼、店名、座標、半徑；api 網址不讀進來
const STORES = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'tools/stores.json'), 'utf8'))
  .map((s) => ({ code: s.code, name: s.name, lat: s.lat, lng: s.lng, radius_m: s.radius_m }));
const SS = (code) => (code === '' ? 'SELF' : 'SS_' + code);
const API = (code) => 'http://store.test/' + (code || 'gf') + '/exec';
const HUB_URL = 'http://mini.test/platform/svc/auto-support', HUB_KEY = 'TEST-HUB-KEY-0123456789';
const SVC_KEY = (code) => 'SVC-KEY-' + (code || 'gf');
const STAFF_CODE = { '': 'gf', mztjs: 'mztjs', mztgf: 'mztgf', mztlzl: 'mztlzl', mztmc: 'mztmc', mztrg: 'mztrg', mztwx: 'mztwx', hq: 'hq', cf: 'cf' };
const CODE_OF = {}; Object.keys(STAFF_CODE).forEach((k) => { CODE_OF[STAFF_CODE[k]] = k; });
const storeOf = (code) => STORES.filter((s) => s.code === code)[0];
const USERS = {}; ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'UX', 'UY', 'UZ'].forEach((u) => { USERS['TOK_' + u] = { sub: u }; USERS['MOCK_ID_TOKEN_' + u] = { sub: u }; });   // MOCK_ID_TOKEN_＝clock-line.html 本機 ?mock_uid= 產生的權杖

const objs = (sheet) => { const v = sheet.values, h = v[0]; return v.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };

/** opts: now, rosters:{code:[row…]}, events:{code:[…]}, payroll(bool), payStores([{code,name,clock_ss_id,brand,active,sort}]),
 *        hubProps({…}｜null＝不設 7A), storeProps({code:{…}}), mini: 'approve'｜'deny'｜fn(body, world), config:{code:{…}} */
function buildWorld(opts) {
  opts = opts || {};
  const now = opts.now || H.T('2026-11-10T09:00:00');
  const w = { stores: {}, miniCalls: [], storeCalls: [], STORES, Core };
  const mini = opts.mini === undefined ? 'approve' : opts.mini;
  STORES.forEach((s) => {
    if (s.code === '') return;
    const m = H.make({ now, lineUsers: USERS,
      self: { roster: (opts.rosters || {})[s.code] || [], events: (opts.events || {})[s.code] || [] },
      props: Object.assign({ STAFF_SVC_KEY: SVC_KEY(s.code) }, (opts.storeProps || {})[s.code] || {}),
      config: Object.assign({ STORE_LAT: s.lat, STORE_LNG: s.lng, RADIUS_M: s.radius_m }, (opts.config || {})[s.code] || {}) });
    vm.runInContext(H.R('apps-script/SvcStaff.gs'), m.sb, { filename: 'apps-script/SvcStaff.gs' });
    w.stores[s.code] = m;
  });
  const hubProps = opts.hubProps === null ? {} : Object.assign({ STAFF_HUB_URL: HUB_URL, STAFF_HUB_KEY: HUB_KEY }, opts.hubProps || {});
  const gf = storeOf('');
  const hub = H.make({ now, lineUsers: USERS, hub: true, payroll: !!opts.payroll,
    self: { roster: (opts.rosters || {})[''] || [], events: (opts.events || {})[''] || [] },
    props: Object.assign({ STAFF_SVC_KEY: SVC_KEY('') }, hubProps, (opts.storeProps || {})[''] || {}),
    config: Object.assign({ STORE_LAT: gf.lat, STORE_LNG: gf.lng, RADIUS_M: gf.radius_m }, (opts.config || {})[''] || {}),
    hubStores: STORES.map((s) => ({ code: s.code, name: s.name, ss_id: SS(s.code), api: API(s.code), lat: s.lat, lng: s.lng, radius_m: s.radius_m })),
    fetch: (url, o) => {
      const st = STORES.filter((s) => s.code !== '' && API(s.code) === url)[0];
      if (st) {   // 光復→別店：伺服器對伺服器，進那家店真的 doPost
        const body = JSON.parse(o.payload);
        w.storeCalls.push({ store: st.code, action: body.action, via: body.via });
        return w.post(st.code, body);
      }
      if (url === HUB_URL) {
        const body = JSON.parse(o.payload);
        w.miniCalls.push(body);
        if (typeof mini === 'function') return mini(body, w);
        return mini === 'approve' ? miniApprove(body, w) : { ok: false, error: 'denied' };
      }
      if (/^https:\/\/api\.line\.me\/v2\/bot\//.test(url)) return {};   // 機器人回覆／輸入中動畫：只記錄（sb.__fetches），不真的送
      return undefined;   // LINE 驗證走 harness 預設
    } });
  vm.runInContext(H.R('apps-script/SvcStaff.gs'), hub.sb, { filename: 'apps-script/SvcStaff.gs' });
  w.stores[''] = hub; w.hub = hub;
  // 光復開別店試算表＝那家店沙盒的同一份
  STORES.forEach((s) => {
    if (s.code === '') return;
    const bk = w.stores[s.code].self;
    hub.peers[SS(s.code)] = { sh: bk.sh, getId: () => SS(s.code), getSheetByName: bk.getSheetByName, insertSheet: bk.insertSheet };
  });
  if (opts.payroll && opts.payStores) {
    const head = ['code', 'name', 'clock_ss_id', 'dzy_node', 'emp_prefix', 'active', 'sort', 'brand', 'support_group'];
    const sh = hub.self.insertSheet('payroll_store');
    sh.values.push(head);
    opts.payStores.forEach((r) => sh.values.push(head.map((h) => (r[h] === undefined ? '' : r[h]))));
  }
  const RESET = 'if (typeof PAY_READ_CACHE !== "undefined") { PAY_READ_CACHE = {}; PAY_SS_CACHE = {}; PAY_CLOCK_CACHE = {}; } EMPID_TEXT_DONE_ = {}; LIFF_STEPS_ = null;';
  /** 一次 HTTP 請求（真的 doPost 分派表）；每次請求前清掉「每次執行都是新的」那幾個全域變數 */
  w.post = (code, body) => {
    const m = w.stores[code];
    m.run(RESET);
    return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  };
  w.hubPost = (body) => w.post('', body);
  w.setNow = (t) => { Object.keys(w.stores).forEach((c) => w.stores[c].setNow(t)); };
  w.advance = (ms) => { Object.keys(w.stores).forEach((c) => w.stores[c].advance(ms)); };
  w.roster = (code) => objs(w.stores[code].self.sh.roster);
  w.events = (code) => objs(w.stores[code].self.sh.events);
  w.bindLog = (code) => { const sh = w.stores[code].self.sh.liff_bind_log; return sh ? objs(sh) : []; };
  /** 在某家店的試算表加一張分頁（rows[0]＝表頭） */
  w.addSheet = (code, name, rows) => { const sh = w.stores[code].self.insertSheet(name); rows.forEach((r) => sh.values.push(r.slice())); return sh; };
  w.fixAt = (code, meters, accuracy) => { const s = storeOf(code); return { lat: s.lat + (meters || 0) / H.M_PER_DEG_LAT, lng: s.lng, accuracy: accuracy === undefined ? 10 : accuracy }; };

  /* ── 照 clock-line.html 的順序打（不是瀏覽器；只重現「打哪支、帶什麼」）──
     loadStatus 479–486、loadStatusFor 487–501、loadViaHub 503–514、sendBind 783–804、sendPunch 608–629 */
  w.openPage = (tok, fix) => {
    const pick = Core.pickStore({ lat: fix.lat, lng: fix.lng, accuracy_m: isFinite(fix.accuracy) ? fix.accuracy : undefined }, STORES);
    if (pick.status !== 'ok') return { screen: 'pick_fail', pick: pick.status, nearest: pick.nearest && pick.nearest.name };
    const st = pick.store, r = w.post(st.code, { action: 'liff_status', id_token: tok });
    if (r && r.ok && r.status === 'ready') return { screen: 'ready', store: st.name, name: r.name, guard: r.guard };
    if (r && r.error === 'not_bound') {
      const h = w.hubPost(Object.assign({ action: 'line_hub_status', id_token: tok }, fix));
      if (!h || !h.ok) return { screen: 'hub_error', error: h && h.error };
      if (h.status === 'ready') return { screen: 'mismatch', page_store: st.name, hub_store: h.store && h.store.name };
      const x = h.result || {};
      if (x.code === 'not_bound') return { screen: 'bind', page_store: st.name, store_name: x.store_name, suggest_name: x.suggest_name, support_from: x.support_from };
      return { screen: 'fail', page_store: st.name, code: x.code, reason: x.reason, hint: x.hint };
    }
    return { screen: 'store_error', store: st.name, error: r && r.error };
  };
  /** 綁定框按「綁定／是我」；confirm_home 的確認框一律按「確定」（autoConfirm=false 就停在確認框） */
  w.bind = (tok, fix, name, autoConfirm) => {
    const base = Object.assign({ action: 'line_bind_name', id_token: tok, name: name, confirm_home: '', bind_code: '' }, fix);
    const r1 = w.hubPost(base);
    if (r1 && r1.error === 'confirm_home' && autoConfirm !== false) {
      const r2 = w.hubPost(Object.assign({}, base, { confirm_home: r1.confirm }));
      return { first: r1, second: r2 };
    }
    return { first: r1 };
  };
  w.punch = (tok, fix, type, extra) => {
    const pick = Core.pickStore({ lat: fix.lat, lng: fix.lng, accuracy_m: isFinite(fix.accuracy) ? fix.accuracy : undefined }, STORES);
    if (pick.status !== 'ok') return { screen: 'pick_fail', pick: pick.status };
    const r = w.post(pick.store.code, Object.assign({ action: 'liff_punch', id_token: tok, type: type }, extra || {}, fix));
    return Object.assign({ store: pick.store.name }, r ? { ok: r.ok, error: r.error, status: r.status, ts: r.ts, reason: r.reason, hint: r.hint } : { ok: false, error: 'no_reply' });
  };
  /** 聊天室打字（webhook）；回機器人送出的訊息（抓 LINE reply API 的 payload） */
  w.chat = (uid, text) => {
    const m = w.hub; m.sb.LINE_HUB_BOT_TOKEN = 'BOT'; m.sb.LINE_HUB_BOT_USER_ID = 'BOTU';
    const before = m.sb.__fetches.length;
    const r = w.hubPost({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'user', userId: uid }, message: { type: 'text', text: text } }] });
    const sent = m.sb.__fetches.slice(before).filter((f) => /\/v2\/bot\/message\/reply$/.test(f.url)).map((f) => JSON.parse(f.o.payload).messages);
    return { r, messages: [].concat.apply([], sent) };
  };
  return w;
}

/** 假 mini（最寬鬆）：來源列在職就放行，呼叫 B 店真的 svc_add 建一列（created_by＝LINE 自動（首次支援）） */
function miniApprove(body, w) {
  if (body.hub_key !== HUB_KEY) return { ok: false, error: 'unauthorized' };
  const srcCode = CODE_OF[body.src_store], dstCode = CODE_OF[body.store_code];
  if (srcCode === undefined || dstCode === undefined) return { ok: false, error: 'bad_store' };
  const srcRow = w.roster(srcCode).filter((r) => String(r.emp_id) === String(body.src_emp_id))[0];
  if (!srcRow || String(srcRow.active).toLowerCase() !== 'true') return { ok: false, error: 'src_inactive' };
  const r = w.post(dstCode, { action: 'svc_add', v: 1, svc_key: SVC_KEY(dstCode), name: String(srcRow.name), op_id: body.op_id,
    created_by: 'LINE 自動（首次支援）', src_store: body.src_store, src_emp_id: String(body.src_emp_id) });
  return r && r.ok ? { ok: true, emp_id: r.emp_id } : { ok: false, error: (r && r.error) || 'svc_add_failed' };
}

/** 卡片 → 純文字（看機器人回了什麼） */
function cardText(msg) {
  if (!msg) return '';
  if (msg.type === 'text') return msg.text;
  const out = [];
  (function walk(n) { if (!n || typeof n !== 'object') return; if (n.type === 'text' && n.text) out.push(n.text); Object.keys(n).forEach((k) => { if (typeof n[k] === 'object') walk(n[k]); }); })(msg.contents);
  return out.join(' / ');
}

const R = (o) => Object.assign({ active: 'TRUE', device_id: '', line_user_id: '' }, o);
module.exports = { buildWorld, miniApprove, cardText, STORES, storeOf, SS, API, HUB_URL, HUB_KEY, SVC_KEY, H, R, objs };
