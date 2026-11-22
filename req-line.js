/* 加班請假／忘打卡申請頁（2026-10-09，規格 mala-clock-liff docs/requests-spec.md）
 * 由 clock-line.html 載入：同一個 LIFF，網址帶 ?view=req&tab=leave|ot|trip|miss|mine 就顯示這頁，不顯示打卡。
 * 2026-10-09 加「出差」分頁；下班打卡超過 8 小時的「申請加班」按鈕會帶 tab=ot＋date／start／end 預填。
 * 開頁資料：光復 line_hub_req_init（綁了哪些店、假別、額度）＋那家店 req_info（我的申請、某天缺哪張卡）。
 * 送出：那家店 req_submit；附件先傳光復 line_hub_attach_put 拿 ID。結果不推播，回「我的申請」看。
 * 2026-10-28 忘打卡自動選店：綁兩家以上的同仁選好日期後，同時問每家店那天有沒有卡（req_info day_only）；
 * 剛好只有一家有卡（含被擋的卡）就幫他切到那家並寫一行說明，兩家以上都有卡提醒確認，都沒有或有店問不到就不動。
 * 2026-10-29 預設店別＝打卡的那家：opts.store（打卡畫面剛打卡的店）→ line_hub_req_init 的 punch_store（最近一張卡）→ 第一家。
 * 2026-11-06 開頁加快（Eason：開申請頁要等 10 秒以上）：①手機記住上次的店別與假別（localStorage，綁 LINE 帳號、最多 30 天），
 *   有記住就先畫表單，背景再拿最新的換上；額度、補休帳的數字不記。②光復、那家店、額度三支同時問，不再排隊。
 *   ③光復開頁資料帶 lite（不算額度與補休帳），額度另打 line_hub_req_quota 晚一點補上；舊後端不認得 lite／quota 照舊一次全回。
 * 2026-11-14 先讀 Mac mini（Eason 開工「全照推薦」；營運系統 docs/line-req-mirror/）：開頁同時①問 Mac mini「上次記住的」額度、我的申請、
 *   開頁資料（peek，馬上回，畫面最下面小字「資料更新於 HH:MM」）②請 Mac mini 代問 Google（read，回來就換上、mini 也記住）。
 *   Mac mini 連不上、關掉（off）、代問失敗 → 這次開頁一律直接問 Google（跟以前一樣）。送出、附件、查某天的卡照舊直接問 Google。
 *   E.REQ_MIRROR＝false 時只回報計時（每次開頁表單、剩幾天、我的申請各幾秒出來）。
 * 2026-11-18 一次填兩段（Eason 開工確認；後端 Requests.gs reqSegsOf_，req_info 的 seg2_kinds 有這種單才出現「＋ 加第二段」）：
 *   加班、請假（只請一段）、出差（只一段）可以在同一天再加一段，送出帶 segments，後端拆成兩張普通的單；「我的申請」同一次送出的標「第 N 段／共 2 段」，
 *   取消只取消那一段；證明附一次兩段共用。前端先擋重疊、接在一起、合計超過上限；兩段在不同店打卡要分開送。沒開放的店畫面與送出內容跟以前完全一樣。
 *   N1 加班單張上限 10 小時（req_info ot_max_h）；N4 拿掉事假「第 N 次」提醒；加班防呆：兩家合計超過 8 小時的加班要開在被支援那家（otAbsorb）。
 * 2026-11-18 第一次開頁加快（Eason：「第一次開申請頁向光復讀取要 13 到 14 秒」；光復 LineHub.gs 共用對照表＋mini 預熱，見營運系統 server/line-req.js）：
 *   ①送出前確認（gateWait）：畫面上的店別、假別、額度、我的申請還是手機記住的／Mac mini 記住的（不是光復剛給的）→ 按送出時先等最新的（最多 GATE_MS），
 *     最新的跟畫面上不一樣（少一家、多一家店、額度不同、開關不同）→ 不送，換成最新畫面並寫「請確認後再按一次送出」；一樣就照送。最新的讀不到 → 照送（店家後端照樣檢查）。
 *   ②讀不到不空白：開頁失敗有「重新讀取」；等光復超過 8 秒寫「還在讀取」；額度還沒到寫「額度讀取中…」、讀不到寫「送出時系統會再檢查」。
 * 2026-11-21 加班一次最多四段（Eason：門市加班常被切成三、四段，以前要拆兩張單送）：只有加班；請假、出差仍最多兩段。
 *   req_info 的 ot_segments_max（4）決定加班能「＋ 加一段」到第幾段（舊後端回 2＝只能加到第二段，沒這欄也當 2）；多段時每一段都有「刪除這段」；
 *   前端兩兩檢查重疊、接在一起、合計 10 小時（後端照樣全部再檢查一次）；送出後「我的申請」同一次送出的標「第 N 段／共 M 段」。資料欄位不變。 */
(function () {
  'use strict';
  /* 送出／取消先走 Mac mini 的開關（2026-11-21，Eason 決定：mini 停機時同仁照樣送得出去）。
     放寬性開關：只有 true 才走新路徑（先送 Mac mini、3 秒沒回改送 Google）；false 時送出、取消跟以前逐字相同（sendReq 第一行直接 E.post）。
     改成 true＝合併到 main 就是 GitHub Pages 上線，由大腦決定時間。本機測試：只在 localhost／127.0.0.1，網址加 ?submit_mini=1 才打開。
     另外 E.MINI_REQ_API 要有值才算開。 */
  var SUBMIT_MINI = false;
  var E, $root, st = { init: null, store: null, info: null, tab: 'leave', busy: false,
                      quotaReady: false, quota: null, infoErr: false, touched: false, storeManual: false,
                      src: {}, peekAt: {}, infoReal: false, tm: null,
                      infoSeq: 0, syncing: false, cancelling: {}, cancelErr: null, flash: null, syncNote: '',
                      initWait: null, quotaWait: null, infoWait: null, initFailed: false, quotaErr: false, gateWait: false, gateNote: null, gateSkip: false, openSeq: 0 };   // 送出前確認（2026-11-18）   // 送出／取消後「先畫結果、背景重讀」用（2026-11-18）
  var TABS = [['leave', '請假'], ['ot', '加班'], ['trip', '出差'], ['miss', '忘打卡'], ['mine', '我的申請']];
  var MISS_REASONS = ['忘記按', '手機沒電', '定位抓不到被擋', '按錯上下班', '其他'];
  var STATUS = { pending: ['審核中', 'wait'], approved: ['已核准', 'ok'], rejected: ['已退回', 'no'], cancelled: ['已取消', 'off'], voided: ['已作廢', 'off'] };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { el.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  /** 台北的今天（可加減天數）。2026-11-11：直接用台北時間算，不經過手機自己的時區——
   *  手機時區有夏令時間時，加減天數剛好跨過換時間的那天，原本的算法會差一天。 */
  function taipeiToday(offsetDays) {
    var d = new Date(Date.now() + 8 * 3600000 + (offsetDays || 0) * 86400000);
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  }
  var WK = ['日', '一', '二', '三', '四', '五', '六'];
  function md(date) {
    var d = new Date(date + 'T00:00:00');
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WK[d.getDay()] + '）';
  }
  function spanHours(a, b) {
    var m1 = /^(\d{2}):(\d{2})$/.exec(a || ''), m2 = /^(\d{2}):(\d{2})$/.exec(b || '');
    if (!m1 || !m2) return null;
    var s = +m1[1] * 60 + +m1[2], e = +m2[1] * 60 + +m2[2];
    if (e <= s) e += 1440;
    return Math.round((e - s) / 60 * 100) / 100;
  }
  function field(label, input, extra) { return h('div', { class: 'rq-fld' }, [h('label', { text: label }), input].concat(extra || [])); }
  /** 時間欄（2026-10-29）：「時」「分」兩個下拉選單，取代 <input type="time">。
   *  部分 Android 的 LINE 一叫出內建時間轉盤就閃退（下拉選單是一般清單，不會）。
   *  step＝分鐘間隔：加班／請假／出差 15（後台時數也是取到 0.25 小時），忘打卡 1（填實際時間）。
   *  預填的時間不在間隔上（例如下班卡 17:43）照樣留在選項裡，不偷改。回傳值一樣是 'HH:MM' 或 ''。 */
  /** 日期欄（2026-10-31）：「月」「日」兩個下拉，取代 <input type="date">（跟時間欄同一個原因：LINE Android 叫內建轉盤可能閃退）。
   *  範圍＝後端規則：4 天前到 90 天後（Requests.gs REQ_LEAVE_PAST_DAYS／reqPastLimit_／REQ_FUTURE_DAYS，請假／加班／出差都一樣；
   *  2026-11-05 由 31 天改 7 天，2026-11-14 改 4 天；11/28 以前 11 月的日子都選得到〔T01 不限〕），
   *  以前的轉盤選得到範圍外、送出才被擋，現在選不到。預填的日期在範圍外（不太會發生）照樣留著不偷改。
   *  「日」附星期、今天標「今天」；換月時盡量留同一天，那個月沒有就取最近的一天。回傳 'YYYY-MM-DD'。 */
  var DATE_PAST = 4, DATE_FUT = 90, DATE_OPEN_FROM = '2026-11-01', DATE_OPEN_TO = '2026-11-28';   // 同 Requests.gs reqPastLimit_
  function datePick(value, onChange) {
    var today = taipeiToday(0), days = [];
    var endMs = Date.parse(taipeiToday(DATE_FUT) + 'T00:00:00Z');
    var startMs = Date.parse(taipeiToday(-DATE_PAST) + 'T00:00:00Z');
    if (today <= DATE_OPEN_TO) startMs = Math.min(startMs, Date.parse(DATE_OPEN_FROM + 'T00:00:00Z'));
    for (var t = startMs; t <= endMs; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    if (/^\d{4}-\d{2}-\d{2}$/.test(value || '') && days.indexOf(value) < 0) { days.push(value); days.sort(); }
    var cur = days.indexOf(value) >= 0 ? value : today;
    var months = [];
    days.forEach(function (x) { if (months.indexOf(x.slice(0, 7)) < 0) months.push(x.slice(0, 7)); });
    var mSel = h('select', { class: 'rq-dm', 'aria-label': '月' }, months.map(function (ym) {
      return h('option', { value: ym, selected: ym === cur.slice(0, 7),
                           text: (ym.slice(0, 4) !== today.slice(0, 4) ? +ym.slice(0, 4) + '/' : '') + (+ym.slice(5, 7)) + ' 月' });
    }));
    var dSel = h('select', { class: 'rq-dd', 'aria-label': '日' });
    function fill(ym) {
      var list = days.filter(function (x) { return x.slice(0, 7) === ym; });
      var pick = list.filter(function (x) { return x.slice(8) === cur.slice(8); })[0]
              || (ym > cur.slice(0, 7) ? list[0] : list[list.length - 1]);
      dSel.innerHTML = '';
      list.forEach(function (x) {
        dSel.appendChild(h('option', { value: x, selected: x === pick,
          text: (+x.slice(8)) + '（' + WK[new Date(x + 'T00:00:00Z').getUTCDay()] + '）' + (x === today ? ' 今天' : '') }));
      });
      cur = pick;
    }
    fill(cur.slice(0, 7));
    mSel.addEventListener('change', function () { fill(mSel.value); onChange(cur); });
    dSel.addEventListener('change', function () { cur = dSel.value; onChange(cur); });
    return h('span', { class: 'rq-dpick' }, [mSel, ' ', dSel]);
  }
  function timePick(value, step, onChange) {
    var m0 = /^(\d{2}):(\d{2})$/.exec(value || '');
    var pad = function (n) { return ('0' + n).slice(-2); };
    var hs = [], ms = [];
    for (var i = 0; i < 24; i++) hs.push(pad(i));
    for (var j = 0; j < 60; j += step) ms.push(pad(j));
    if (m0 && ms.indexOf(m0[2]) < 0) { ms.push(m0[2]); ms.sort(); }
    var opt = function (v, t, cur) { return h('option', { value: v, text: t, selected: v === cur }); };
    var hh = h('select', { class: 'rq-hh', 'aria-label': '時' }, [opt('', '--', m0 ? m0[1] : '')].concat(hs.map(function (v) { return opt(v, v, m0 && m0[1]); })));
    var mm = h('select', { class: 'rq-mm', 'aria-label': '分' }, [opt('', '--', m0 ? m0[2] : '')].concat(ms.map(function (v) { return opt(v, v, m0 && m0[2]); })));
    var fire = function () {
      if (hh.value && !mm.value) mm.value = '00';   // 只選了「時」就當整點，少點一次
      onChange(hh.value && mm.value ? hh.value + ':' + mm.value : '');
    };
    hh.addEventListener('change', fire); mm.addEventListener('change', fire);
    return h('span', { class: 'rq-time' }, [hh, ' : ', mm]);
  }
  function msgBox(text, cls) { return h('div', { class: 'rq-box ' + (cls || ''), text: text }); }

  /* ── 先讀 Mac mini（2026-11-14）── */
  var mini = { down: false };
  function miniOn() { return !!(E.REQ_MIRROR && E.MINI_REQ_API && !mini.down); }
  /** 上次記住的：回 {at, data} 或 null（沒有、過期、mini 不在）。2.5 秒沒回就當 mini 不在，這次開頁全部直接問 Google。 */
  function miniPeek(kind, url) {
    if (!miniOn()) return Promise.resolve(null);
    return E.post(E.MINI_REQ_API, { op: 'peek', kind: kind, url: url, id_token: liff.getIDToken() }, 2500).then(function (r) {
      var d = r && r.ok && r.data;
      if (d && d.ok === false && d.error === 'off') mini.down = true;
      return d && d.ok && d.hit && d.data && d.data.ok ? { at: +d.at || 0, data: d.data } : null;
    }, function () { mini.down = true; return null; });
  }
  /** 讀最新的：先請 Mac mini 代問（它也順便記住），mini 不在或代問失敗就直接問 Google（readRetry 照舊重試）。 */
  function viaMini(kind, url, body) {
    if (!miniOn()) return E.readRetry(url, body);
    return E.post(E.MINI_REQ_API, { op: 'read', kind: kind, url: url, id_token: body.id_token }, 30000).then(function (r) {
      var d = r && r.ok && r.data, g = d && d.ok && d.src === 'mini' ? d.data : null;
      if (d && d.ok === false && d.error === 'off') mini.down = true;
      if (g && typeof g === 'object' && (g.ok === true || (g.error && g.error !== 'server_error'))) return g;
      return E.readRetry(url, body);
    }, function () { mini.down = true; return E.readRetry(url, body); });
  }
  /** 開頁計時（REQ_MIRROR 開不開都記）：表單、剩幾天、我的申請第一次出來的毫秒數與來源（cache 手機記住／mini／google），送 Mac mini。 */
  function tmMark(what, src) {
    var t = st.tm;
    if (!t || t.sent || t.ms[what] !== undefined) return;
    t.ms[what] = Date.now() - t.t0; t.src[what] = src || 'google';
    if (t.ms.form !== undefined && t.ms.quota !== undefined && t.ms.mine !== undefined) tmSend();
  }
  function tmSend() {
    var t = st.tm;
    if (!t || t.sent || !E.MINI_REQ_API || t.ms.form === undefined) return;
    t.sent = true;
    var body = JSON.stringify({ op: 'timing', store: st.store ? String(st.store.code) : '', ms: t.ms, src: t.src });
    try { if (navigator.sendBeacon && navigator.sendBeacon(E.MINI_REQ_API, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
    try { fetch(E.MINI_REQ_API, { method: 'POST', body: body, mode: 'no-cors', keepalive: true }).catch(function () {}); } catch (e) {}
  }
  function hhmm(ms) { var d = new Date(ms + 8 * 3600000); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }

  /* ── 送出／取消走 Mac mini（2026-11-21；SUBMIT_MINI 關＝完全照舊）── */
  var SUBMIT_MINI_MS = 3000;
  function submitMiniOn() {
    if (!E || !E.MINI_REQ_API) return false;
    if (SUBMIT_MINI) return true;
    try {
      return ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1 && new URLSearchParams(location.search).get('submit_mini') === '1';
    } catch (e) { return false; }
  }
  /** 單號：'r' + 16 碼小寫十六進位（G 線契約 g-line.md 4.1，同打卡單號格式；Google 直接拿來當申請單 id、同單號只寫一次）。 */
  function newReqId() {
    var s = 'r', b = null;
    try { b = new Uint8Array(8); window.crypto.getRandomValues(b); } catch (e) { b = null; }
    for (var i = 0; i < 8; i++) s += ('0' + ((b ? b[i] : Math.floor(Math.random() * 256)) & 255).toString(16)).slice(-2);
    return s;
  }
  /** 影子回報（Google 回來後告訴 mini 結果，fire-and-forget）。 */
  function shadowNote(url, idToken, reqId, r) {
    try {
      var g = { ok: !!(r && r.ok), error: (r && r.error) || '', message: (r && r.message) || '' };
      var body = JSON.stringify({ op: 'shadow_note', url: url, id_token: idToken, req_id: reqId, g: g });
      try { if (navigator.sendBeacon && navigator.sendBeacon(E.MINI_REQ_API, new Blob([body], { type: 'text/plain' }))) return; } catch (e) {}
      try { fetch(E.MINI_REQ_API, { method: 'POST', body: body, mode: 'no-cors', keepalive: true }).catch(function () {}); } catch (e) {}
    } catch (e) {}
  }
  /** 送申請（op＝submit／cancel）。開關關：就是 E.post(url, body)。開關開：先 mini（3 秒），
   *  回 src:'mini' 就用它的 data；mini_off＋shadow、其他失敗、逾時、非 JSON 都改送 Google（同一個 req_id）。 */
  function sendReq(op, url, body) {
    if (!submitMiniOn()) return E.post(url, body);
    var reqId = newReqId(), mb = {};
    Object.keys(body).forEach(function (k) { if (k !== 'action' && k !== 'id_token') mb[k] = body[k]; });
    var toG = function (shadow) {
      var gb = op === 'submit' ? Object.assign({}, body, { req_id: reqId }) : body;   // 只有送出帶單號給 Google（取消用申請單 id，g-line.md 只定義 req_submit 的 req_id）
      return E.post(url, gb).then(function (r) { if (shadow) shadowNote(url, body.id_token, reqId, r); return r; });
    };
    var capT, cap = new Promise(function (res, rej) { capT = setTimeout(function () { rej(new Error('mini_timeout')); }, SUBMIT_MINI_MS); });   // 舊手機沒有 AbortController 也最多等這麼久
    var mp;
    try { mp = E.post(E.MINI_REQ_API, { op: op, url: url, id_token: body.id_token, req_id: reqId, body: mb }, SUBMIT_MINI_MS); } catch (e) { mp = Promise.reject(e); }
    return Promise.race([mp, cap]).then(function (r) {
      clearTimeout(capT);
      var d = miniReply(r);
      if (d && d.ok === true && d.src === 'mini' && d.data && typeof d.data === 'object') return d.data;
      return toG(!!(d && d.ok === false && d.error === 'mini_off' && d.shadow === true));
    }, function () { clearTimeout(capT); return toG(false); });
  }
  /** 營運系統的回應一律包一層 { ok:true, data:<line-req 的回傳> }（mala-store-ops server/index.js 路由收尾；讀取那條 miniPeek／viaMini 也是拆 r.data）。
   *  拆出裡面那層：外層不是 ok:true 或裡面不是物件（伺服器錯誤、被擋、回應怪）→ null＝當 mini 沒收，由呼叫端改送 Google。 */
  function miniReply(r) { return r && r.ok === true && r.data && typeof r.data === 'object' ? r.data : null; }
  /** 送出成功訊息「：摘要」那一段。回應沒有 summary（mini 的同單號重送 { ok:true, dup:true }）就不接，畫面與聊天只留「已送出」，不出現 undefined；有 summary 時字串與以前逐字相同（Google 的成功回應一定有，Requests.gs:841、866、868、1049）。 */
  function sumTail(r) { return r && r.summary ? '：' + r.summary : ''; }

  /* ── 開頁 ── */
  /* 手機記住的開頁資料（2026-11-06）：只記店別清單、上次用的店、假別清單；額度與補休帳會變，不記。
     綁 LINE 帳號（id token 的 sub），換人用同一支手機不會看到別人的；超過 30 天當沒記。localStorage 讀寫失敗一律當沒記。 */
  var CACHE_KEY = 'mala_req_init_v1', CACHE_MS = 30 * 86400000;
  function lineSub() { try { var d = liff.getDecodedIDToken && liff.getDecodedIDToken(); return (d && d.sub) ? String(d.sub) : ''; } catch (e) { return ''; } }
  function cacheGet() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'), sub = lineSub();
      if (!c || !sub || c.sub !== sub || !(Date.now() - c.at < CACHE_MS) || !c.stores || !c.stores.length || !c.leave_types) return null;
      return c;
    } catch (e) { return null; }
  }
  function cachePut() {
    try {
      var sub = lineSub();
      if (!sub || !st.init || !st.init.fresh) return;   // 只存伺服器剛給的，不把記住的再存一次（存的時間會被延長）
      localStorage.setItem(CACHE_KEY, JSON.stringify({ sub: sub, at: st.init.fresh, stores: st.init.stores, punch_store: st.init.punch_store,
                                                        leave_types: st.init.leave_types, last_store: st.store ? st.store.code : null }));
    } catch (e) { /* 存不了就下次再慢一次 */ }
  }
  function cacheDrop() { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }
  /** 新資料到了要重畫：同仁正在打字（焦點在輸入框）就等他離開那格再畫，免得鍵盤收起來、游標跳走。 */
  var refreshWait = false;
  function refresh() {
    var a = document.activeElement;
    if (a && $root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      if (refreshWait) return;
      refreshWait = true;
      a.addEventListener('blur', function () { refreshWait = false; setTimeout(refresh, 0); }, { once: true });
      return;
    }
    render();
  }
  function applyQuota() {
    if (!st.init || !st.quota) return;
    st.init.quota = st.quota.quota || []; st.init.comp = st.quota.comp || null; st.quotaReady = true;
    if (st.quota.ft === true || st.quota.ft === false) st.init.ft = st.quota.ft;   // 生理假：計時人員不適用（舊後端沒這欄＝不知道）
  }
  function infoFor(code) {
    var url = E.storeApi(storeDef(code));
    return viaMini('info', url, { action: 'req_info', id_token: liff.getIDToken() }).then(function (r) {
      if (r && r.ok) return r;
      throw new Error((r && r.error) || 'failed');
    });
  }
  var touchHooked = false, tmHooked = false;
  function open(opts) {
    E = window.ClockLineEnv;
    $root = document.getElementById('reqView');
    st.tab = TABS.some(function (t) { return t[0] === opts.tab; }) ? opts.tab : 'leave';
    st.missDate = opts.date || ''; st.missType = opts.miss || '';
    // 下班打卡提示加班（opts.start／end）：預填加班分頁，原因留給同仁寫
    if (st.tab === 'ot' && opts.date && opts.start && opts.end) ot = { date: opts.date, start: opts.start, end: opts.end, reason: '', seg2: null, seg3: null, seg4: null };
    if (!touchHooked) {   // 同仁動過表單就不再自動換店（背景拿到最新的「最近一張卡在哪家店」時用）
      touchHooked = true;
      ['input', 'change', 'click'].forEach(function (ev) { $root.addEventListener(ev, function () { if (st.init) st.touched = true; }, true); });
    }
    st.init = null; st.info = null; st.infoErr = false; st.quota = null; st.quotaReady = false; st.touched = false; st.storeManual = false;
    st.src = {}; st.peekAt = {}; st.infoReal = false; st.tm = { t0: Date.now(), ms: {}, src: {}, sent: false };
    st.syncing = false; st.cancelling = {}; st.cancelErr = null; st.flash = null; st.syncNote = '';
    st.initWait = null; st.quotaWait = null; st.infoWait = null; st.initFailed = false; st.quotaErr = false; st.gateWait = false; st.gateNote = null; st.gateSkip = false;
    var seq = ++st.openSeq; st.openOpts = opts;
    if (!tmHooked) { tmHooked = true; window.addEventListener('pagehide', function () { tmSend(); }); }   // 沒等到三樣都出來就關掉：送已經量到的
    $root.hidden = false;
    var token = liff.getIDToken(), cached = cacheGet(), hasOpt = opts.store !== undefined && opts.store !== null, drawn = !!cached;
    // 三支同時問：光復基本資料（lite）、額度補休帳、那家店的「我的申請」（店別先用記住的／打卡畫面帶來的猜）；先經 Mac mini（viaMini）
    var initP = viaMini('init', E.HUB_API, { action: 'line_hub_req_init', id_token: token, lite: true });
    st.quotaWait = viaMini('quota', E.HUB_API, { action: 'line_hub_req_quota', id_token: token }).then(function (q) {
      if (seq !== st.openSeq) return;
      if (!q || !q.ok) { if (!(q && q.error === 'unknown_action')) { st.quotaErr = true; if (st.init && st.store) refresh(); } return; }   // 舊後端 unknown_action：額度跟著開頁資料一起回（見下面 r.lite）
      st.quota = q; st.src.quota = 'google'; st.peekAt.quota = 0; st.quotaErr = false; applyQuota(); if (st.init && st.store) refresh();
    }, function () { if (seq === st.openSeq) { st.quotaErr = true; if (st.init && st.store) refresh(); } });
    var guess = cached ? pickStore(cached.stores, [opts.store, cached.last_store, cached.punch_store]).code : (hasOpt ? opts.store : undefined);
    var infoP = guess !== undefined && storeDef(guess) ? { code: guess, p: infoFor(guess) } : null;
    if (infoP) infoP.p.catch(function () {});
    function loadInfoNow() {
      var code = st.store.code;
      var p = infoP && infoP.code === code ? infoP.p : infoFor(code);
      st.infoWait = { code: code, p: p.then(function () {}, function () {}) };
      return p.then(function (r) { if (st.store && st.store.code === code) { st.info = r; st.infoErr = false; st.infoReal = true; st.src.info = 'google'; st.peekAt.info = 0; } },
                    function () { if (st.store && st.store.code === code && !st.info) st.infoErr = true; });   // 已經先顯示 Mac mini 記住的：讀不到最新的就先留著
    }
    // Mac mini 上次記住的（2026-11-14）：比 Google 先到才用；Google 的到了就換掉（小字跟著消失）
    function peekInfo(code) {
      if (code === undefined || !storeDef(code)) return;
      miniPeek('info', E.storeApi(storeDef(code))).then(function (pk) {
        if (!pk || st.infoReal || st.info || !st.store || st.store.code !== code) return;
        st.info = pk.data; st.infoErr = false; st.src.info = 'mini'; st.peekAt.info = pk.at; refresh();
      });
    }
    miniPeek('quota', E.HUB_API).then(function (pk) {
      if (!pk || st.quota) return;
      st.quota = pk.data; st.src.quota = 'mini'; st.peekAt.quota = pk.at; applyQuota(); if (st.init && st.store) refresh();
    });
    peekInfo(guess);
    if (!cached) miniPeek('init', E.HUB_API).then(function (pk) {   // 這支手機沒記住（第一次、換手機）：Mac mini 記住的開頁資料先畫
      if (!pk || st.init || !pk.data.stores || !pk.data.stores.length) return;
      var d = pk.data;
      st.init = { stores: d.stores, punch_store: d.punch_store, leave_types: d.leave_types, quota: [], comp: null, fresh: 0 };
      st.src.init = 'mini'; drawn = true;
      st.store = pickStore(st.init.stores, [opts.store, d.punch_store]);
      applyQuota(); render();
      if (guess === undefined || st.store.code !== guess) peekInfo(st.store.code);
      loadInfoNow().then(refresh);
    });
    $root.innerHTML = '';
    if (cached) {   // 有記住：表單馬上出來
      st.src.init = 'cache';
      st.init = { stores: cached.stores, punch_store: cached.punch_store, leave_types: cached.leave_types, quota: [], comp: null, fresh: 0 };
      st.store = pickStore(st.init.stores, [opts.store, cached.last_store, cached.punch_store]);
      applyQuota();
      render();
      loadInfoNow().then(refresh);
    } else {
      $root.appendChild(h('div', { class: 'rq-loading', text: '讀取中…' }));
      setTimeout(function () {   // 等光復超過 8 秒：不要只留「讀取中…」（2026-11-18）
        var ld = seq === st.openSeq && $root.querySelector('.rq-loading');
        if (ld) ld.textContent = '讀取中…光復系統這次回應比較慢，請再等一下（第一次打開比較久）';
      }, 8000);
    }
    st.initWait = initP.then(function (r) {
      if (seq !== st.openSeq) return;
      if (r && r.error === 'invalid_id_token') {   // 開頁就逾時：還沒填東西，直接重整（2026-10-30）
        $root.innerHTML = '';
        $root.appendChild(msgBox(E.relogin() === 'stuck' ? 'LINE 登入逾時。請關掉這頁，再從選單按「申請」重新打開。' : 'LINE 登入逾時，正在重新連線…', 'err'));
        return;
      }
      if (!r || !r.ok) {
        st.initFailed = true;
        if (r && r.error === 'not_bound') cacheDrop();
        if (drawn && !(r && r.error === 'not_bound')) { refresh(); return; }   // 已經用記住的畫好了，背景更新失敗就先用記住的（送出時伺服器照樣檢查）
        $root.innerHTML = '';
        if (r && r.error === 'not_bound') $root.appendChild(msgBox('你還沒綁定打卡。請先到店裡按選單「打卡」完成綁定，再來申請。', 'err'));
        else retryBox('讀不到資料（光復系統暫時沒有回應）。');
        return;
      }
      var prev = st.store ? st.store.code : null;
      if (!st.src.init) st.src.init = 'google';
      st.init = { stores: r.stores, punch_store: r.punch_store, leave_types: r.leave_types, fresh: Date.now(),
                  quota: r.lite ? [] : (r.quota || []), comp: r.lite ? null : (r.comp || null),
                  ft: !r.lite && (r.ft === true || r.ft === false) ? r.ft : null };
      if (!r.lite) st.quotaReady = true;   // 舊後端：額度已經一起回了
      applyQuota();
      // 預設店別＝打卡的那家（2026-10-29）：從打卡畫面按進來用剛打卡的店，從選單開用後台查到最近一張卡的店；都沒有才用第一家。
      // 已經用記住的店畫好：同仁還沒動過表單才換成後台查到的那家；那家已經不在名單（解除綁定）一定換。
      var keep = prev !== null && (st.storeManual || st.touched) ? prev : null;
      st.store = pickStore(r.stores, keep !== null ? [keep] : [opts.store, r.punch_store, prev]);
      cachePut();
      if (prev === null || st.store.code !== prev) { st.info = null; st.infoErr = false; st.infoReal = false; render(); loadInfoNow().then(refresh); }
      else refresh();
    }, function () {
      if (seq !== st.openSeq) return;
      st.initFailed = true;
      if (drawn) { refresh(); return; }
      $root.innerHTML = ''; retryBox('連線失敗，請檢查網路。');
    });
  }
  /** 開頁讀不到：說明＋「重新讀取」（不用關掉重開；2026-11-18） */
  function retryBox(text) {
    $root.appendChild(msgBox(text, 'err'));
    $root.appendChild(h('button', { type: 'button', class: 'primary rq-retry', text: '重新讀取', on: { click: function () { open(st.openOpts || {}); } } }));
  }
  /** 依序找第一個對得上的店代碼（光復的代碼是空字串，所以不能用 truthy 判斷）；都沒有回第一家。 */
  function pickStore(stores, codes) {
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (c === undefined || c === null) continue;
      var hit = stores.filter(function (s) { return String(s.code) === String(c); })[0];
      if (hit) return hit;
    }
    return stores[0];
  }
  function storeDef(code) { if (code === undefined) code = st.store.code; return E.STORES.filter(function (s) { return s.code === code; })[0]; }
  function loadInfo() {
    var code = st.store.code;
    return infoFor(code).then(function (r) {
      if (st.store && st.store.code === code) { st.info = r; st.infoReal = true; st.src.info = 'google'; st.peekAt.info = 0; }
      return r;
    });
  }
  /* 送出、取消成功後（2026-11-18）：先用回應把畫面畫好，再背景重讀伺服器的最新清單（req_info 約 3.5 秒），回來後以伺服器為準重畫。
   *  以前是同步等重讀才換畫面，同仁按完要空等好幾秒。
   *  - infoSeq：同時有好幾次重讀時只認最新發出的那一次（舊的晚到不蓋掉新的）。
   *  - syncing：重讀期間送出鈕不可按（避免重複送出）；最多鎖 SYNC_GUARD_MS，重讀卡住也不會一直鎖。
   *  - 重讀失敗：保留先畫的列，只在「我的申請」寫一句 failNote，不顯示錯誤。 */
  var SYNC_GUARD_MS = 15000;
  function syncBtns(on) {
    Array.prototype.forEach.call($root.querySelectorAll('button.primary'), function (b) {
      if (!b._rqSubmit || st.busy) return;
      b.disabled = on || !!b._rqPreBlock; b.textContent = on ? '更新清單中…' : '送出申請';   // 選假別就先擋的（病假用完、生理假）同步完也維持不可按
    });
  }
  function endSync(my) {
    if (my !== st.infoSeq || !st.syncing) return;
    st.syncing = false; syncBtns(false);
  }
  function reloadBg(failNote) {
    var code = st.store.code, my = ++st.infoSeq;
    st.syncing = true;
    var guard = setTimeout(function () { endSync(my); }, SYNC_GUARD_MS);
    return infoFor(code).then(function (r) {
      clearTimeout(guard);
      if (my !== st.infoSeq) return;
      if (st.store && st.store.code === code) { st.info = r; st.infoErr = false; st.infoReal = true; st.src.info = 'google'; st.peekAt.info = 0; st.syncNote = ''; }
      endSync(my);
      if (st.tab === 'mine') render();
    }, function () {
      clearTimeout(guard);
      if (my !== st.infoSeq) return;
      if (st.store && st.store.code === code) st.syncNote = failNote;
      endSync(my);
      if (st.tab === 'mine') render();
    });
  }
  /** 把剛送出的列放到「我的申請」最前面（伺服器回的列跟 req_info 的 requests 同一個形狀，reqPublic_）；id 已經有了就不重複放。 */
  function adoptRows(rows) {
    rows = (rows || []).filter(function (q) { return q && q.id; });
    if (!rows.length) return;
    if (!st.info) st.info = { ok: true, requests: [] };
    var have = {};
    (st.info.requests || []).forEach(function (q) { have[q.id] = true; });
    st.info.requests = rows.filter(function (q) { return !have[q.id]; }).concat(st.info.requests || []);
  }
  /** 那家店那天的卡（忘打卡用）。day_only：新後端只讀尾端、不讀申請表；舊後端不認得就照舊整包回，一樣有 day。 */
  /*  apply_miss（2026-11-11）：把已送出的忘打卡申請當成已經補上的卡，兩段班一天漏好幾張時，補完一張才看得到還缺哪一張；舊後端不認得就照舊。 */
  function loadDay(code, date) {
    var def = storeDef(code);
    if (!def) return Promise.reject(new Error('no_store'));
    return E.readRetry(E.storeApi(def), { action: 'req_info', id_token: liff.getIDToken(), date: date, day_only: true, apply_miss: true }).then(function (r) {
      if (r && r.ok && r.day && r.day.date === date) return r.day;
      throw new Error((r && r.error) || 'failed');
    });
  }
  function shortMd(date) { return (+date.slice(5, 7)) + '/' + (+date.slice(8, 10)); }
  /** 依各店那天的卡決定店別（純函式，tests/req-auto-store.test.js 測）。
   *  results：[{code, name, day|null}]（null＝那家問不到）。回 {pick:code|null, note:{kind, date, code?, names?}|null}
   *  - 每家都問到、剛好一家有卡（含被擋的卡）→ pick 那家；跟目前同一家就不寫說明
   *  - 兩家以上有卡 → 不換，提醒確認
   *  - 都沒卡、或有店問不到（不能確定只有一家）→ 不換、不說明 */
  function decideStore(results, curCode, date) {
    var hit = results.filter(function (x) { return x.day && x.day.punches && x.day.punches.length; });
    if (hit.length >= 2) return { pick: null, note: { kind: 'multi', date: date, names: hit.map(function (x) { return x.name; }) } };
    if (hit.length === 1 && results.every(function (x) { return !!x.day; })) {
      var c = hit[0].code;
      return c === curCode ? { pick: null, note: null } : { pick: c, note: { kind: 'switched', date: date, code: c, name: hit[0].name } };
    }
    return { pick: null, note: null };
  }

  /** 加班／請假／出差依「申請那天、那個時段」各店的卡決定店別（2026-11-15 Eason，純函式，tests/req-store-by-day.test.js 測）。
   *  results：[{code, name, day|null}]；range：[start, end]（'HH:MM'）或 null（整天）。被擋的卡（rejected_*）不算。
   *  回 {pick, expect:[code], must, note}：
   *  - 有店問不到 → 什麼都不判斷（pick null、expect 空）
   *  - 只有一家有卡 → 那家（跟目前不同就 pick）
   *  - 兩家以上有卡：有時段而且只對到一家（時段跟那家當天第一張到最後一張卡重疊）→ 那家；對不到或整天 → must（要同仁自己選）
   *  - 都沒卡 → 不換 */
  function storeByDay(results, curCode, date, range) {
    if (!results.length || results.some(function (x) { return !x.day; })) return { pick: null, expect: [], must: false, note: null };
    var m = function (t) { var x = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return x ? +x[1] * 60 + +x[2] : null; };
    var spans = results.map(function (x) {
      var ts = (x.day.punches || []).filter(function (p) { return String(p.status || '').indexOf('rejected_') !== 0; }).map(function (p) { return m(p.hm); }).filter(function (v) { return v !== null; });
      return { code: x.code, name: x.name, a: ts.length ? Math.min.apply(null, ts) : null, b: ts.length ? Math.max.apply(null, ts) : null };
    }).filter(function (x) { return x.a !== null; });
    if (!spans.length) return { pick: null, expect: [], must: false, note: null };
    var fmt = function (v) { return ('0' + Math.floor(v / 60)).slice(-2) + ':' + ('0' + v % 60).slice(-2); };
    var all = spans.map(function (x) { return x.name + ' ' + fmt(x.a) + '–' + fmt(x.b); });
    var cand = spans;
    if (spans.length > 1) {
      var r0 = range ? m(range[0]) : null, r1 = range ? m(range[1]) : null;
      if (r0 === null || r1 === null || r1 === r0) return { pick: null, expect: spans.map(function (x) { return x.code; }), must: true, note: { kind: 'multi', date: date, all: all } };
      if (r1 < r0) r1 += 1440;
      cand = spans.filter(function (x) { return Math.min(r1, Math.max(x.b, x.a + 1)) > Math.max(r0, x.a); });
      if (cand.length !== 1) return { pick: null, expect: spans.map(function (x) { return x.code; }), must: true, note: { kind: 'multi', date: date, all: all } };
    }
    var c = cand[0];
    return { pick: c.code === curCode ? null : c.code, expect: [c.code], must: false, note: { kind: spans.length > 1 ? 'range' : 'switched', date: date, code: c.code, name: c.name, all: all } };
  }
  /** 各家已綁定的店那天的卡（同一天問過就共用；只綁一家不問） */
  function daysFor(date) {
    if (!date || st.init.stores.length < 2) return Promise.resolve(null);
    st.dayCache = st.dayCache || {};
    if (!st.dayCache[date]) st.dayCache[date] = Promise.all(st.init.stores.map(function (s) {
      return loadDay(s.code, date).then(function (d) { return { code: s.code, name: s.name, day: d }; }, function () { return { code: s.code, name: s.name, day: null }; });
    })).then(function (res) { if (res.some(function (x) { return !x.day; })) delete st.dayCache[date]; return res; });
    return st.dayCache[date];
  }
  /** 這一天同仁有沒有手動選過店（選的是光復時存的是空字串，所以看有沒有這一筆、不看值） */
  function pickedOn(date) { return Object.prototype.hasOwnProperty.call(st.picked || {}, date); }
  function switchStore(code) {
    var s = st.init.stores.filter(function (x) { return x.code === code; })[0];
    if (!s || s === st.store) return;
    st.store = s; st.info = null; st.infoErr = false; st.infoReal = false; st.peekAt.info = 0; cachePut();
    loadInfo().then(function () { if (st.tab === 'mine' || seg2Open('ot') || seg2Open('leave') || seg2Open('trip')) refresh(); }, function () {});
  }
  /** 加班／請假／出差：日期或時段變了 → 查各店那天的卡，自動選店；在 box 寫說明（只綁一家什麼都不做）。
   *  同仁在這一天手動選過店就不再自動換（st.picked[date]） */
  function storeHint(box, date, range) {
    if (st.init.stores.length < 2 || !date) return;
    var key = date + '|' + (range ? range.join('-') : '');
    box.dataset.key = key;
    box.textContent = '查這天在哪家打卡…'; box.className = 'rq-muted';
    daysFor(date).then(function (res) {
      if (!res || !box.isConnected || box.dataset.key !== key) return;
      if (st.tab === 'ot' && otAbsorb(res, st.init.stores, date === taipeiToday(0) ? nowMinTaipei() : null)) { box.textContent = ''; box.className = ''; return; }   // 兩家合計超過 8 小時：以防呆（otAbsorbHint）為準，不再自動換店、不寫「送到這家」
      var dc = storeByDay(res, st.store.code, date, range), picked = pickedOn(date);
      if (dc.pick !== null && !picked) { switchStore(dc.pick); render(); return; }      // 光復的店代碼是空字串，不能用 truthy 判斷（2026-11-16）
      box.textContent = ''; box.className = '';
      if (!dc.note) return;
      if (dc.note.kind === 'multi') {
        box.className = 'rq-auto-store warn';
        box.appendChild(document.createTextNode(shortMd(date) + ' 你在 ' + dc.note.all.join('、') + ' 都有打卡，' + (picked ? '確認上面選的「' + st.store.name + '」是對的' : '請選這張要送到哪一家：')));
        if (!picked) box.appendChild(chips(res.filter(function (x) { return dc.expect.indexOf(x.code) !== -1; }).map(function (x) { return x.name; }), '', function (name) {
          var c = res.filter(function (x) { return x.name === name; })[0];
          st.picked = st.picked || {}; st.picked[date] = c.code; switchStore(c.code); render();
        }));
      } else if (dc.expect.indexOf(st.store.code) !== -1) {
        box.className = 'rq-auto-store';
        box.textContent = shortMd(date) + (dc.note.kind === 'range' ? ' 這段時間你在' : ' 你在') + st.store.name + '打卡，送到這家（不對可以在上面改）';
      } else {
        box.className = 'rq-auto-store warn';
        box.textContent = shortMd(date) + ' 你是在' + dc.note.name + '打卡，上面選的是「' + st.store.name + '」，確認要送到這家嗎？';
      }
    });
  }
  /** 送出前核對（加班、請假、出差）：要自己選卻還沒選 → 擋；選的店那天（那段時間）沒打卡、別家有 → 確認。
   *  兩段（body.segments，2026-11-18）：兩段在不同家店打卡 → 擋，請分開送（兩張單會送到同一家店）；否則兩段合起來照同一套看。 */
  function storeGuard(body) {
    if (!body || body.kind === 'miss' || st.init.stores.length < 2) return Promise.resolve(body);
    var two = body.segments && body.segments.length >= 2;
    var ranges = two ? body.segments.map(function (g) { return [g.start, g.end]; }) : [body.start && body.end ? [body.start, body.end] : null];
    return daysFor(body.date).then(function (res) {
      if (!res) return body;
      if (two) { var sp = segStoreSplit(res, body.date, body.segments); if (sp) throw new Error(sp.message); }
      var picked = pickedOn(body.date), expect = [], must = null;
      ranges.forEach(function (rg) {
        var dc = storeByDay(res, st.store.code, body.date, rg);
        if (dc.must && !must) must = dc;
        dc.expect.forEach(function (c) { if (expect.indexOf(c) < 0) expect.push(c); });
      });
      if (must && !picked) throw new Error(shortMd(body.date) + ' 你在 ' + must.note.all.join('、') + ' 都有打卡，請先在上面選這張要送到哪一家');
      if (expect.length && expect.indexOf(st.store.code) === -1) {
        var names = res.filter(function (x) { return expect.indexOf(x.code) !== -1; }).map(function (x) { return x.name; }).join('、');
        if (!window.confirm((ranges[0] ? '這段時間' : shortMd(body.date) + ' ') + '你是在' + names + '打卡，確定要送到「' + st.store.name + '」嗎？')) throw new Error('沒有送出：請在上面改成要送的店');
      }
      return body;
    });
  }

  /* ── 一次填兩段（2026-11-18 Eason）──
     同一天兩段加班／請假（只請一段）／出差（只一段）一次送出，後端（Requests.gs reqSegsOf_）拆成兩張普通的單。
     這裡的檢查是「先講」：後端照樣全部檢查一次、以後端為準；任一段沒過一列都不會寫。 */
  var SEG_LABEL = ['第一段', '第二段', '第三段', '第四段'], SEG_NUM = ['', '一', '兩', '三', '四'], SEG_WORD = { ot: '加班', leave: '請假', trip: '出差' };
  var SEG_KEYS = ['seg2', 'seg3', 'seg4'];   // 表單狀態裡「第二～第四段」的欄位（第一段就是 start／end）
  var SEG_MAX_N = { ot: 4, leave: 2, trip: 2 };   // 同 Requests.gs REQ_SEG_MAX_N_；加班實際能加到第幾段看 req_info 的 ot_segments_max
  var SEG_MAX_DEFAULT = { ot: 10, leave: 8, trip: 8 };   // 同 Requests.gs REQ_OT_MAX_H／REQ_SEG2_TOTAL_MAX_H_；req_info 的 seg2_max_h、ot_max_h 有給就用給的
  function segMin(t) { var m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }
  /** 兩段有沒有重疊（含其中一段跨夜到隔天凌晨），同 Requests.gs reqOverlap_；任一邊沒填完整回 null */
  function segOverlap(s1, e1, s2, e2) {
    var a = segMin(s1), b = segMin(e1), c = segMin(s2), d = segMin(e2);
    if (a === null || b === null || c === null || d === null) return null;
    if (b <= a) b += 1440;
    if (d <= c) d += 1440;
    return (a < d && c < b) || (a < d + 1440 && c + 1440 < b) || (a + 1440 < d && c < b + 1440);
  }
  /** 兩段是不是接在一起（一段的結束＝另一段的開始，含跨夜），同 Requests.gs reqSegTouch_ */
  function segTouch(s1, e1, s2, e2) {
    var a = segMin(s1), b = segMin(e1), c = segMin(s2), d = segMin(e2);
    if (a === null || b === null || c === null || d === null) return false;
    if (b <= a) b += 1440;
    if (d <= c) d += 1440;
    return [0, 1440, -1440].some(function (k) { return b === c + k || d + k === a; });
  }
  /** 多段檢查（純函式，tests/seg2-line.test.js、seg4-line.test.js 測）：segs＝[{start,end}…]（2～4 段，照畫面順序），maxH＝合計上限。
   *  回 null（過）或 {error, message, seg?}；順序同後端：沒填完整 → 各段兩兩比（重疊、接在一起）→ 合計超過。
   *  兩段時字句跟以前一樣；三、四段時講「第幾段和第幾段」。 */
  function segCheck(kind, segs, maxH) {
    var what = SEG_WORD[kind] || '', hrs = [], n = segs.length, i, j;
    for (i = 0; i < n; i++) {
      var a = segMin(segs[i].start), b = segMin(segs[i].end);
      if (a === null || b === null) return { error: 'bad_time', seg: i + 1, message: SEG_LABEL[i] + '：請填完整的' + what + '時段' };
      if (a === b) return { error: 'bad_time', seg: i + 1, message: SEG_LABEL[i] + '：開始和結束時間一樣，請確認' };
      hrs.push(spanHours(segs[i].start, segs[i].end));
    }
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var A = segs[i], B = segs[j], who = n === 2 ? '兩段' : SEG_LABEL[i] + '和' + SEG_LABEL[j];
      if (segOverlap(A.start, A.end, B.start, B.end) === true)
        return { error: 'seg_overlap', message: who + '時間重疊（' + A.start + '–' + A.end + '、' + B.start + '–' + B.end + '），請改時間' };
      if (segTouch(A.start, A.end, B.start, B.end)) {
        var ab = segMin(A.end) === segMin(B.start);   // A 接 B（否則是 B 接 A）
        return { error: 'seg_touch', message: (n === 2 ? '兩段' : who) + '接在一起，請直接填成一段 ' + (ab ? A.start + '–' + B.end : B.start + '–' + A.end) };
      }
    }
    var total = Math.round(hrs.reduce(function (t, v) { return t + v; }, 0) * 100) / 100;
    if (total > maxH + 0.001) return { error: 'seg_total', message: SEG_NUM[n] + '段合計 ' + total + ' 小時，超過 ' + maxH + ' 小時，請確認時間' };
    return null;
  }
  /** 這家店有沒有開這種單的「加一段」（req_info 的 seg2_kinds；舊後端沒這欄＝沒開，畫面跟以前一樣） */
  function seg2Open(kind) {
    var i = st.info;
    if (!i || !Array.isArray(i.seg2_kinds) || i.seg2_kinds.indexOf(kind) < 0) return false;
    return !(kind === 'ot' && i.ot_segments_max !== undefined && Number(i.ot_segments_max) < 2);
  }
  /** 這張表單現在能不能加一段：開了＋請假的話假別不在 seg2_no_types（生理假） */
  function seg2Ok(kind, type) {
    if (!seg2Open(kind)) return false;
    if (kind === 'leave' && type) {
      var no = Array.isArray(st.info.seg2_no_types) ? st.info.seg2_no_types : ['生理假'];
      if (no.indexOf(type) >= 0) return false;
    }
    return true;
  }
  /** 這種單最多能填幾段：加班看 req_info 的 ot_segments_max（2026-11-21 新後端回 4；舊後端回 2、沒這欄也當 2），請假、出差 2 */
  function segMaxN(kind) {
    if (kind !== 'ot') return SEG_MAX_N[kind] || 2;
    var n = st.info && Number(st.info.ot_segments_max);
    return n >= 2 ? Math.min(Math.floor(n), SEG_MAX_N.ot) : 2;
  }
  /** 表單狀態 x 目前加了哪幾段（第二～第四段，到第一個空的為止）；不看開關 */
  function segExtras(x) {
    var out = [];
    for (var i = 0; i < SEG_KEYS.length; i++) { if (x[SEG_KEYS[i]]) out.push(x[SEG_KEYS[i]]); else break; }
    return out;
  }
  function segSetExtras(x, arr) { for (var i = 0; i < SEG_KEYS.length; i++) x[SEG_KEYS[i]] = arr[i] || null; }
  /** 目前要送的各段（x＝{start,end,seg2,seg3,seg4}）；沒加第二段、或這張不能加 → null */
  function segsOf(x, kind, type) {
    if (!x.seg2 || !seg2Ok(kind, type)) return null;
    return [{ start: x.start, end: x.end }].concat(segExtras(x).map(function (g) { return { start: g.start, end: g.end }; }));
  }
  function segMax(kind) {
    var m = st.info && st.info.seg2_max_h && Number(st.info.seg2_max_h[kind]);
    return m > 0 ? m : SEG_MAX_DEFAULT[kind];
  }
  function otMaxH() { var m = st.info && Number(st.info.ot_max_h); return m > 0 ? m : SEG_MAX_DEFAULT.ot; }   // 單張加班上限（N1：12 → 10）
  function segHours(segs) { return Math.round(segs.reduce(function (t, g) { return t + (spanHours(g.start, g.end) || 0); }, 0) * 100) / 100; }
  /** 一列時段（兩個時間欄＋時數）；seg＝{start,end}，label 有值＝兩段時的「第一段／第二段」 */
  function segRow(seg, label, onChange, onDel) {
    var tot = h('span', { class: 'rq-muted' });
    var upd = function () { var v = spanHours(seg.start, seg.end); tot.textContent = v ? (label ? v + ' 小時' : '共 ' + v + ' 小時') : ''; };
    var s1 = timePick(seg.start, 15, function (v) { seg.start = v; upd(); onChange(); });
    var e1 = timePick(seg.end, 15, function (v) { seg.end = v; upd(); onChange(); });
    upd();
    var row = h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot]);
    var head = onDel ? h('div', { class: 'rq-seg-k rq-seg-k-del' }, [h('span', { text: label }), h('button', { type: 'button', class: 'rq-link rq-seg-del', text: '刪除這段', 'aria-label': '刪除' + label, on: { click: onDel } })]) : h('div', { class: 'rq-seg-k', text: label });
    return label ? h('div', { class: 'rq-seg' }, [head, row]) : row;   // 只一段＝跟以前同一列；多段＝上面多一行「第一段／第二段…」（加班可加到四段時，每段右上角有「刪除這段」）
  }
  /** 時段欄（加班、請假只請一段、出差只一段共用）。onChange：任何一段時間改了叫一次（呼叫端更新選店、打卡提醒）。
   *  沒開放（或這張不能加）＝跟以前同一列；開放＝多一顆「＋ 加一段」；加了＝多列＋合計＋檢查訊息。
   *  最多兩段（請假、出差、舊後端的加班）＝跟 2026-11-18 一樣：「＋ 加第二段」「移除第二段」；
   *  最多四段（加班，新後端）＝「＋ 再加一段」加到第四段，每段都有「刪除這段」（刪第一段＝後面的往前補）。 */
  function segBlock(x, kind, type, onChange) {
    if (!seg2Ok(kind, type)) return segRow(x, null, onChange);
    var maxN = segMaxN(kind), many = maxN > 2, extras = segExtras(x);
    if (!extras.length) {
      return h('div', {}, [segRow(x, null, onChange),
        h('button', { type: 'button', class: 'rq-link rq-seg-add', text: many ? '＋ 加一段（同一天另一段時間，最多' + SEG_NUM[maxN] + '段）' : '＋ 加第二段（同一天另一段時間）', on: { click: function () { x.seg2 = { start: '', end: '' }; render(); } } })]);
    }
    var sum = h('div', { class: 'rq-seg-sum rq-muted' }), bad = h('div', { class: 'rq-seg-bad-msg' });
    var cur = function () { return [{ start: x.start, end: x.end }].concat(segExtras(x).map(function (g) { return { start: g.start, end: g.end }; })); };
    var live = function () {
      var list = cur(), vs = list.map(function (g) { return spanHours(g.start, g.end); }), all = vs.every(function (v) { return !!v; });
      sum.textContent = !all ? '' : list.length === 2 ? '第一段 ' + vs[0] + ' 小時＋第二段 ' + vs[1] + ' 小時＝共 ' + segHours(list) + ' 小時'
                                                      : vs.join('＋') + '＝共 ' + segHours(list) + ' 小時';
      bad.innerHTML = '';
      var c = list.length > maxN ? { message: (kind === 'ot' ? '加班' : '請假、出差') + '一次最多填' + SEG_NUM[maxN] + '段時間' }   // 後端最新說的上限比畫面上填的少（例如退回舊版）：先講、送出也會擋
            : all ? segCheck(kind, list, kind === 'ot' ? Math.min(segMax('ot'), otMaxH()) : segMax(kind)) : null;
      if (c) bad.appendChild(msgBox(c.message, 'err'));
    };
    var chg = function () { live(); onChange(); };
    var rows = [];
    // 刪第 k 段（0＝第一段）：後面的往前補；刪完剩一段＝回到沒加段的樣子
    var del = function (k) { return function () {
      var list = [{ start: x.start, end: x.end }].concat(segExtras(x).map(function (g) { return { start: g.start, end: g.end }; }));
      list.splice(k, 1);
      x.start = list[0].start; x.end = list[0].end; segSetExtras(x, list.slice(1));
      render();
    }; };
    var segObjs = [x].concat(extras);
    segObjs.forEach(function (g, k) {
      var r = segRow(g, SEG_LABEL[k], chg, many ? del(k) : null);
      r.setAttribute('data-seg', String(k + 1));
      if (k >= 1) r.classList.add('rq-seg2');
      rows.push(r);
    });
    live();
    var kids = rows.slice();
    if (many) {
      if (extras.length + 1 < maxN) kids.push(h('button', { type: 'button', class: 'rq-link rq-seg-add', text: '＋ 再加一段（最多' + SEG_NUM[maxN] + '段，還能加 ' + (maxN - extras.length - 1) + ' 段）', on: { click: function () { x[SEG_KEYS[extras.length]] = { start: '', end: '' }; render(); } } }));
    } else {
      kids.push(h('button', { type: 'button', class: 'rq-link rq-seg-del', text: '移除第二段', on: { click: function () { segSetExtras(x, []); render(); } } }));   // 連第三、四段一起收起來
    }
    return h('div', { class: 'rq-segs' }, kids.concat([sum, bad]));
  }
  function segErr(c) { var e = new Error(c.message); e.seg = c.seg || 0; return e; }   // 前端自己擋下來的錯誤：帶 seg 讓那一列標紅
  /** 送出失敗、後端說是哪一段（seg 1／2）→ 那一列標紅 */
  function markSegBad(seg) {
    var rows = $root.querySelectorAll('.rq-seg .rq-row');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('rq-seg-bad', i === seg - 1);
  }
  /** 各段各自在哪家店打卡（storeByDay 的 expect）；有兩段各對到一家而且不同家 → {message}，要分開送；判斷不出來（有店問不到、沒卡、對不到）的段不算，都判斷不出來回 null。
   *  兩段時字句跟 2026-11-18 一樣；三、四段時講第幾段（照畫面順序）。 */
  function segStoreSplit(results, date, segs) {
    var dcs = segs.map(function (g) { return storeByDay(results, '', date, [g.start, g.end]); });
    var known = [];
    dcs.forEach(function (dc, i) { if (dc.expect.length === 1 && !dc.must) known.push({ i: i, code: dc.expect[0] }); });
    var first = known[0], other = first && known.filter(function (k) { return k.code !== first.code; })[0];
    if (!first || !other) return null;
    var nm = function (code) { return results.filter(function (x) { return x.code === code; })[0].name; };
    return { codes: [first.code, other.code],
             message: shortMd(date) + ' ' + SEG_LABEL[first.i] + '在' + nm(first.code) + '打卡、' + SEG_LABEL[other.i] + '在' + nm(other.code) + '打卡，' + (segs.length === 2 ? '兩段' : '這幾段') + '要送到不同的店，請分開送（先送一段，再回來送另一段）' };
  }
  /** 兩段時：在表單上先講「兩段在不同家店打卡」（送出時 storeGuard 也會擋） */
  function segSplitNote(box, date, segs) {
    box.textContent = ''; box.className = '';
    if (!segs || st.init.stores.length < 2 || !date) return;
    var key = date + '|' + JSON.stringify(segs);
    box.dataset.key = key;
    daysFor(date).then(function (res) {
      if (!res || !box.isConnected || box.dataset.key !== key) return;
      var sp = segStoreSplit(res, date, segs);
      if (sp) { box.className = 'rq-auto-store warn'; box.textContent = sp.message; }
    });
  }

  /* 防呆（2026-11-18 Eason）：同一天在原單位和支援單位都上班，合計超過 8 小時的加班要開在被支援那家（跨店加班歸屬，Requests.gs reqFt8Split_）。
     自動選店預設選最近打卡那家，常常選到原單位，核定時才被擋。這裡只提示、可一鍵切到那家，不擋送出。 */
  function unitOf(code) {   // 同 Requests.gs reqUnitOf_（光復的代碼在 LINE 頁是空字串）
    var c = String(code === undefined || code === null ? '' : code).toLowerCase();
    if (c === '') return 'sxl';
    if (c === 'hq' || c === 'cf') return '*';
    return /^mzt/.test(c) ? 'mzt' : '*';
  }
  function sameUnit(a, b) { var x = unitOf(a), y = unitOf(b); return x === '*' || y === '*' || x === y; }
  /** 那家店那天的上班時數（打卡段加總；還沒下班的用現在，nowMin 沒給或不是今天＝算不出來）→ {h, fs} 或 null */
  function dayWork(day, nowMin) {
    var spans = (day && day.missing && day.missing.spans) || [], tot = 0, fs = null;
    for (var i = 0; i < spans.length; i++) {
      var a = segMin(spans[i].in), b = spans[i].out ? segMin(spans[i].out) : (typeof nowMin === 'number' ? nowMin : null);
      if (a === null || b === null) return null;
      if (spans[i].out_next || b < a) b += 1440;
      tot += b - a; fs = fs === null ? a : Math.min(fs, a);
    }
    return { h: Math.round(tot / 60 * 100) / 100, fs: fs };
  }
  /** 該吸收加班的那家（純函式，tests/seg2-line.test.js 測）。results：daysFor 的結果 [{code,name,day|null}]；
   *  stores：st.init.stores，每家要有 support（true＝支援帳號、false＝原單位，後端 line_hub_req_init 帶）；少一家沒有、原單位不是剛好一家 → 判斷不出來。
   *  規則同後端：原單位和同一單位的支援單位合計超過 8 小時，超過的加班算支援單位（最多吸收它自己那天的時數）；
   *  支援兩家以上時長的吸收、一樣長算後上班（最早一張卡較晚）那家。回 {code, name, total, over, home:{code,name,h}} 或 null。 */
  function otAbsorb(results, stores, nowMin) {
    if (!results || results.length < 2 || results.some(function (x) { return !x.day; })) return null;
    if (!stores.length || stores.some(function (s) { return typeof s.support !== 'boolean'; })) return null;
    var homes = stores.filter(function (s) { return s.support === false; });
    if (homes.length !== 1) return null;
    var wk = {};
    for (var i = 0; i < results.length; i++) { var w = dayWork(results[i].day, nowMin); if (!w) return null; wk[String(results[i].code)] = w; }
    var hc = String(homes[0].code), hw = wk[hc];
    if (!hw || !(hw.h > 0)) return null;
    var sups = results.filter(function (x) {
      var s = stores.filter(function (y) { return String(y.code) === String(x.code); })[0];
      return s && s.support === true && sameUnit(hc, x.code) && wk[String(x.code)] && wk[String(x.code)].h > 0;
    });
    if (!sups.length) return null;
    var total = hw.h + sups.reduce(function (a, x) { return a + wk[String(x.code)].h; }, 0);
    total = Math.round(total * 100) / 100;
    if (total <= 8 + 0.001) return null;
    var best = sups.reduce(function (b, x) {
      var p = wk[String(x.code)], q = wk[String(b.code)];
      return p.h > q.h || (p.h === q.h && p.fs > q.fs) ? x : b;
    });
    var hr = results.filter(function (x) { return String(x.code) === hc; })[0];
    return { code: best.code, name: best.name, total: total, over: Math.round(Math.min(total - 8, wk[String(best.code)].h) * 100) / 100,
             home: { code: hr.code, name: hr.name, h: hw.h }, here: wk[String(best.code)].h };
  }
  function nowMinTaipei() { var d = new Date(Date.now() + 8 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  /** 這一天的防呆結果（沒有、判斷不出來都是 null）；同一天各店的卡 daysFor 共用 */
  function absorbFor(date) {
    return daysFor(date).then(function (res) { return res ? otAbsorb(res, st.init.stores, date === taipeiToday(0) ? nowMinTaipei() : null) : null; });
  }
  /** 加班表單：目前選的店不是該吸收加班那家 → 寫一句提示＋一顆鈕切過去（不擋送出） */
  function otAbsorbHint(box, anchor, date) {   // box 平常不在畫面上（沒有提示＝畫面跟以前一樣），有提示才插到 anchor 後面
    box.textContent = ''; box.className = '';
    if (box.parentNode) box.parentNode.removeChild(box);
    if (st.init.stores.length < 2 || !date) return;
    box.dataset.key = date;
    absorbFor(date).then(function (ab) {
      if (!ab || !anchor.isConnected || box.dataset.key !== date || String(ab.code) === String(st.store.code)) return;
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
      var r2 = function (v) { return String(Math.round(v * 100) / 100); };
      box.className = 'rq-auto-store warn rq-absorb';
      box.appendChild(document.createTextNode(shortMd(date) + ' 你在' + ab.home.name + '上班 ' + r2(ab.home.h) + ' 小時、' + ab.name + ' ' + r2(ab.here) + ' 小時，合計約 ' + r2(ab.total)
        + ' 小時，超過 8 小時的加班單要開在被支援的「' + ab.name + '」，不是目前選的「' + st.store.name + '」。'));
      box.appendChild(h('div', { class: 'rq-chips' }, [h('button', { type: 'button', class: 'rq-chip rq-absorb-switch', text: '改送到「' + ab.name + '」', on: { click: function () {
        st.picked = st.picked || {}; st.picked[date] = ab.code; st.storeManual = true; switchStore(ab.code); render();
      } } })]));
    });
  }

  /* ── 畫面 ── */
  function render() {
    $root.innerHTML = '';
    var head = h('div', { class: 'rq-head' }, [h('b', { text: st.store.emp_name || '' }), ' ']);
    if (st.init.stores.length > 1) {
      var sel = h('select', { class: 'rq-store', on: { change: function () {
        st.store = st.init.stores[+sel.value]; st.info = null; st.infoErr = false; st.infoReal = false; st.peekAt.info = 0; st.storeManual = true; cachePut();
        var dNow = ({ leave: lv.date, ot: ot.date, trip: tp.date })[st.tab]; if (dNow) { st.picked = st.picked || {}; st.picked[dNow] = st.store.code; }      // 這一天手動選過店：不再自動換（2026-11-15）
        if (st.tab === 'miss') render();   // 忘打卡：各店那天的卡已經一起查好了，先換畫面
        loadInfo().then(render, function () { alert('讀不到這家店的資料'); });
      } } }, st.init.stores.map(function (s, i) { return h('option', { value: i, text: s.name, selected: s === st.store }); }));
      head.appendChild(sel);
    } else head.appendChild(h('span', { class: 'rq-muted', text: st.store.name }));
    $root.appendChild(head);
    $root.appendChild(h('div', { class: 'rq-tabs' }, TABS.map(function (t) {
      return h('button', { type: 'button', class: t[0] === st.tab ? 'on' : '', 'data-tab': t[0], text: t[1],
                           on: { click: function () { st.tab = t[0]; st.flash = null; st.syncNote = ''; st.cancelErr = null; st.gateNote = null; render(); } } });
    })));
    if (st.tab === 'mine' && st.flash) $root.appendChild(msgBox(st.flash.text, st.flash.cls));   // 送出後的「✓ 已送出」：背景重讀完重畫也留著，離開分頁才收
    if (st.tab === 'mine' && st.syncNote) $root.appendChild(h('div', { class: 'rq-muted rq-sync-note', text: st.syncNote }));
    if (st.gateNote && st.gateNote.tab === st.tab) $root.appendChild(msgBox(st.gateNote.text, 'err rq-gate-note'));   // 送出前確認：最新資料跟畫面不一樣（2026-11-18）
    var panel = h('div', { class: 'rq-panel' });
    $root.appendChild(panel);
    ({ leave: renderLeave, ot: renderOt, trip: renderTrip, miss: renderMiss, mine: renderMine })[st.tab](panel);
    var pa = [st.peekAt.quota, st.peekAt.info].filter(function (x) { return x > 0; });   // 畫面上有 Mac mini 記住的資料：最下面小字標時間
    if (pa.length) $root.appendChild(h('div', { class: 'rq-muted rq-fresh', text: '資料更新於 ' + hhmm(Math.min.apply(null, pa)) + ((st.peekAt.quota > 0 && st.quotaErr) ? '，最新的暫時讀不到（送出時系統會再檢查）' : '，正在更新…') }));
    tmMark('form', st.src.init);
    if (st.quotaReady) tmMark('quota', st.src.quota || 'google');
    if (st.info) tmMark('mine', st.src.info || 'google');
  }

  function chips(list, value, onPick) {
    var wrap = h('div', { class: 'rq-chips' });
    list.forEach(function (v) {
      wrap.appendChild(h('button', { type: 'button', class: 'rq-chip' + (v === value ? ' on' : ''), text: v,
                                     on: { click: function () { onPick(v); } } }));
    });
    return wrap;
  }
  /* 補休（2026-11-01 改每月加減結算、開放全部門市）：光復 line_hub_req_init 回 comp {allowed（正職）, ot_h, used_h, balance_h, ym}。
     本月補休帳＝本月核准加班 − 本月補休（含審核中），可以是負的（先休後補），不擋送出；月底剩的照加班費發。 */
  function comp() { return (st.init && st.init.comp) || { allowed: false, ot_h: 0, used_h: 0, balance_h: 0 }; }
  // 確定是計時（薪資主檔查得到、沒勾正職）才擋補休；主檔還沒建（known:false）或舊後端沒給 known 都放行（2026-11-04 Eason：全部同仁先看得到補休）
  function compBlocked() { var c = comp(); return c.known === true && !c.allowed; }
  function compText() {
    var c = comp(), r2 = function (v) { return Math.round((Number(v) || 0) * 100) / 100; }, b = r2(c.balance_h);
    var m = /^\d{4}-\d{2}$/.test(String(c.ym || '')) ? (+String(c.ym).slice(5, 7)) + ' 月' : '本月';
    return m + '加班 ' + r2(c.ot_h) + ' − 補休 ' + r2(c.used_h) + ' ＝ ' + (b < 0 ? '欠 ' + (-b) : '剩 ' + b) + ' 小時';
  }
  /** 時數取到小數一位（額度、餘額的顯示用）。2026-11-11：原本只宣告在 quotaText 裡面，capLocked 也用到它，
   *  家庭照顧假超過剩餘額度時當場出錯（r1 is not defined）、畫面停在「送出中…」。 */
  function r1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
  /* 生理假一年 3 次、家庭照顧假一年 7 天，用完就不能再申請（2026-11-10 Eason）；額度還沒讀到就不擋，主管核准與核定時會再擋一次 */
  function capLocked(type, hours, date) {
    if (type !== '生理假' && type !== '家庭照顧假') return '';
    if (type === '生理假' && mensRulesOn()) return mensLocked(hours, date);
    var q = ((st.init && st.init.quota) || []).filter(function (x) { return x.name === type; })[0];
    if (!q || q.remain_h == null) return '';
    if (type === '生理假' && Number(q.remain_h) <= 0.001) return '生理假今年 3 次已經用完，不能再申請';
    if (type === '家庭照顧假' && Number(hours) > Number(q.remain_h) + 0.001) return '家庭照顧假今年 7 天只剩 ' + r1(Math.max(0, q.remain_h)) + ' 小時，這次超過了，不能送出';
    return '';
  }
  /* 2026-11-11：這裡原本有第二個 spanHours（2026-11-10 加的，不取整、時間沒填回 0），同名的函式後面的會蓋掉前面的，
     結果整頁的時數都變成沒取整的那一個——加班 17:00–17:20 顯示成 0.3333333333333333 小時。拿掉，一律用檔案前面那個（取到小數兩位）。 */
  /* 生理假新規則（2026-11-18 Eason）：一天算一次、一年 3 次（第 4 次擋，請改辦理病假）、每月一次、一天最多 8 小時、計時人員不適用。
     這裡只是送出前先提醒，後端（Requests.gs reqMensBlock_）才是正本：已核准單那天有沒有核定成別的假，這裡看不到，所以只算額度表的日期＋審核中的單。
     後端關掉新規則（REQ_MENS_RULES=off）時 req_info 的 seg2_no_types 會帶「生理假」→ 這裡也回到舊的「剩 0 小時就擋」。 */
  function mensRulesOn() {
    if (st.info && typeof st.info.mens_rules === 'boolean') return st.info.mens_rules;   // 新後端直接給開關狀態
    var no = st.info && Array.isArray(st.info.seg2_no_types) ? st.info.seg2_no_types : null;
    return !(no && no.indexOf('生理假') >= 0);
  }
  function mensQuota() { return ((st.init && st.init.quota) || []).filter(function (x) { return x.name === '生理假'; })[0] || null; }
  function mensMd(d) { return (+String(d).slice(5, 7)) + '/' + (+String(d).slice(8, 10)); }
  function mensLocked(hours, date) {
    if (st.init && st.init.ft === false) return '計時人員不適用生理假，請改請病假或事假';
    if (Number(hours) > 8.001) return '生理假一天最多 8 小時，這次 ' + r1(hours) + ' 小時超過了';
    var q = mensQuota(), d = String(date || '');
    if (!d) return '';
    if (q && !Array.isArray(q.dates)) return q.remain_h != null && Number(q.remain_h) <= 0.001 ? '生理假今年已請 3 次，已超過年度三次上限，請改辦理病假' : '';
    var days = {};
    ((q && q.dates) || []).forEach(function (k) { days[String(k)] = true; });   // 額度查不到（沒有薪資主檔的店）：只看本店的單
    ((st.info && st.info.requests) || []).forEach(function (r) {
      if (r && r.kind === 'leave' && r.leave_type === '生理假' && r.status === 'pending') days[String(r.date).slice(0, 10)] = true;
    });
    ((st.info && st.info.leave_live && st.info.leave_live.mens_ok_dates) || []).forEach(function (k) { days[String(k)] = true; });   // 已核准、那天還沒核定
    if (days[d]) return '';   // 同一天：不加次數（一天 8 小時由後端合計檢查）
    var yr = d.slice(0, 4), ym = d.slice(0, 7), keys = Object.keys(days).sort();
    var inYr = keys.filter(function (k) { return k.slice(0, 4) === yr; });
    var thisYr = taipeiToday(0).slice(0, 4);
    if (inYr.length >= 3) return '生理假' + (yr === thisYr ? '今年' : ' ' + yr + ' 年') + '已請 ' + inYr.length + ' 次，已超過年度三次上限，請改辦理病假';
    var inMon = keys.filter(function (k) { return k.slice(0, 7) === ym; });
    if (inMon.length) return '生理假每月一次，這個月已請過（' + inMon.map(function (k) { return k.indexOf('#') > 0 ? (+k.slice(5, 7)) + ' 月' : mensMd(k); }).join('、') + '）';
    return '';
  }
  /* 病假年度用完（2026-11-18 Eason 選 A）：今年病假額度剩 0（含審核中、已核准還沒核定的病假單）＝請改請事假。
     後端開關（req_info.sick_used_up）是 true 才提示；額度查不到、不是今年＝不提示（後端也不擋）。 */
  function sickUsedUp(date) {
    if (!st.info || st.info.sick_used_up !== true) return '';
    var q = ((st.init && st.init.quota) || []).filter(function (x) { return x.name === '病假'; })[0];
    var d = String(date || ''), yr = taipeiToday(0).slice(0, 4);
    if (!q || q.remain_h == null || q.remain_h === '' || !isFinite(Number(q.remain_h)) || d.slice(0, 4) !== yr) return '';
    var live = Number((st.info.leave_live || {}).sick_ok_h) || 0;
    ((st.info.requests) || []).forEach(function (r) {
      if (r && r.kind === 'leave' && r.leave_type === '病假' && r.status === 'pending' && String(r.date).slice(0, 4) === yr) live += Number(r.hours) || 0;
    });
    if (Number(q.remain_h) - live > 0.001) return '';
    var capD = q.cap_days != null && q.cap_days !== '' ? Number(q.cap_days) : 30;
    return '今年病假額度已用完（' + capD + ' 天' + (live > 0.001 ? '，含審核中或已核准還沒核定的病假單' : '') + '），請改請事假';
  }
  /** 選假別時就先擋（送出鈕不可按）：病假用完；生理假的計時、第 4 次、每月一次（一天 8 小時要看時數，留到送出時） */
  function leavePreBlock(type, date) {
    if (type === '病假') return sickUsedUp(date);
    if (type === '生理假' && mensRulesOn()) return mensLocked(0, date);
    return '';
  }
  function quotaText(name) {
    if (name === '補休') return '';   // 補休的餘額另外一行一直顯示（見 renderLeave）
    var q = (st.init.quota || []).filter(function (x) { return x.name === name; })[0];
    if (!q || q.cap_days == null) return '';
    if (name === '生理假') {   // 用「次」（2026-11-18）；舊後端沒有 used_n 就用時數換算（一次＝8 小時）
      var cap = Number(q.cap_days) || 3;
      var used = q.used_n != null ? Number(q.used_n) : Math.round((Number(q.cap_h) - Number(q.remain_h)) / 8);
      var left = Math.max(0, cap - (Number(used) || 0));
      return (left > 0 ? '剩 ' + left + ' 次' : cap + ' 次已用完') + '（每年 ' + cap + ' 次、每月一次，一天不管請幾小時都算一次，最多 8 小時）';
    }
    if (q.basis === 'event') return '每次上限 ' + r1(q.cap_h) + ' 小時';
    return q.remain_h < 0 ? '已超出 ' + r1(-q.remain_h) + ' 小時' : '剩 ' + r1(q.remain_h) + ' 小時（上限 ' + r1(q.cap_h) + '）';
  }

  /* 請假 */
  function lvBlank() { return { date: '', type: '', mode: 'day', hours: '8', start: '', end: '', reason: '', file: null, seg2: null, seg3: null, seg4: null }; }
  var lv = lvBlank();
  function renderLeave(p) {
    if (!lv.date) lv.date = taipeiToday(0);
    var lt = st.init.leave_types || { common: [], special: [] };
    var lvHint = h('div', {});      // 依那天、那段時間在哪家打卡選店（2026-11-15）
    var lvRange = function () { return lv.mode !== 'day' && lv.start && lv.end ? [lv.start, lv.end] : null; };
    p.appendChild(field('日期', datePick(lv.date, function (v) { lv.date = v; if (lv.type === '病假' || lv.type === '事假' || lv.type === '生理假') render(); else storeHint(lvHint, lv.date, lvRange()); }), [lvHint]));
    storeHint(lvHint, lv.date, lvRange());
    var typeBox = h('div', {});
    typeBox.appendChild(chips(lt.common, lv.type, function (v) { lv.type = v; render(); }));
    if (lt.special.length) {
      var sp = h('select', { class: 'rq-special', on: { change: function () { if (sp.value) { lv.type = sp.value; render(); } } } },
        [h('option', { value: '', text: '特殊假別（婚假、喪假、產假…）' })].concat(lt.special.map(function (n) { return h('option', { value: n, text: n, selected: n === lv.type }); })));
      typeBox.appendChild(sp);
    }
    var q = lv.type ? quotaText(lv.type) : '';
    var qx = q ? [h('div', { class: 'rq-quota', text: lv.type + '：' + q })] : [];
    if (lv.type && lv.type !== '補休' && !st.quotaReady) qx.push(h('div', { class: 'rq-muted rq-quota-wait', text: st.quotaErr ? '額度暫時讀不到（送出時系統會再檢查）' : '額度讀取中…' }));   // 2026-11-18：不要空白
    // 本月補休帳：薪資主檔查得到的正職才有，一直顯示、選之前就看得到；主檔還沒建的人只在選了補休時提示
    if (lt.common.indexOf('補休') >= 0 && comp().allowed) {
      qx.push(h('div', { class: 'rq-quota rq-comp-bal' + (Number(comp().balance_h) < 0 ? ' rq-comp-neg' : ''), text: '補休：' + compText() }));
      if (lv.type === '補休') qx.push(h('div', { class: 'rq-muted', text: '可以先休、之後再用加班補回來；當月要補平，剩的照加班費發。' }));
    } else if (lv.type === '補休') {
      qx.push(h('div', { class: 'rq-muted', text: compBlocked() ? '補休只有正職可以請。' : '可以先休、之後再用加班補回來，由主管審核。本月補休帳要等薪資資料建好才看得到。' }));
    }
    var lvSegs = function () { return lv.mode === 'day' ? null : segsOf(lv, 'leave', lv.type); };   // 兩段（只請一段模式、這種假別能加第二段才有）
    var lw = preWarns('leave', lv.type, lv.date, lv.mode === 'day' ? lv.hours : lvSegs() ? segHours(lvSegs()) : spanHours(lv.start, lv.end));
    if (lw.length) qx.push(warnBox(lw));
    var pre = lv.type ? leavePreBlock(lv.type, lv.date) : '';   // 選到就先講、送出鈕不可按（2026-11-18）
    if (pre) qx.push(h('div', { class: 'rq-proof-note rq-pre-block', text: '⛔ ' + pre }));
    p.appendChild(field('假別', typeBox, qx));
    var modeBox = h('div', {}, [chips(['整天', '只請一段'], lv.mode === 'day' ? '整天' : '只請一段', function (v) { lv.mode = v === '整天' ? 'day' : 'span'; render(); })]);
    if (lv.mode === 'day') {
      var hr = h('input', { type: 'number', min: '0.5', max: '24', step: '0.5', value: lv.hours, class: 'rq-hours', on: { input: function () { lv.hours = hr.value; } } });
      modeBox.appendChild(h('div', { class: 'rq-row' }, ['共 ', hr, ' 小時']));
    } else {
      var lvSplit = h('div', {});
      var lvUpd = function () { if (lv.start && lv.end) storeHint(lvHint, lv.date, lvRange()); segSplitNote(lvSplit, lv.date, lvSegs()); };
      modeBox.appendChild(segBlock(lv, 'leave', lv.type, lvUpd));
      if (lvSegs()) modeBox.appendChild(lvSplit);
      lvUpd();
    }
    p.appendChild(field('時段', modeBox));
    var rs = h('input', { type: 'text', maxlength: '100', value: lv.reason, placeholder: '例如：家裡有事', on: { input: function () { lv.reason = rs.value; } } });
    p.appendChild(field('原因（選填）', rs));
    var fi = h('input', { type: 'file', accept: 'image/*,application/pdf', on: { change: function () { lv.file = fi.files[0] || null; } } });
    var mustProof = proofType(lv.type, lv.date);
    var sickN = lv.type === '病假' && st.info && st.info.sick_proof_days ? sickNth(lv.date) : 0;
    p.appendChild(field(mustProof ? '證明文件（' + (sickN ? '今年第 ' + sickN + ' 天病假，' : lv.type) + '一定要附）' : '附件（選填，病假證明、訃聞等）', fi,
      [h('div', { class: mustProof ? 'rq-proof-note' : 'rq-muted', id: 'rqProofNote',
                  text: mustProof ? '可以拍照或選照片／PDF。手上還沒有證明也能先送出，但主管要等你在「我的申請」補上才能核准。'
                                  : sickN ? '今年第 ' + sickN + ' 天病假：累計滿 ' + st.info.sick_proof_days + ' 天才要附證明，這次可以不附'
                                  : '照片或 PDF，只有審核的主管看得到' })].concat(lvSegs() ? [h('div', { class: 'rq-muted rq-seg-proof', text: '這張證明兩段共用，不用附兩次。' })] : [])));
    var out = h('div', {});
    var lvBtn = submitBtn(out, function () {
      if (!lv.type) return Promise.reject(new Error('請選假別'));
      if (proofType(lv.type, lv.date) && !lv.file && !confirm(lv.type + '要附證明。\n\n沒附也可以先送出，但主管要等你在「我的申請」補上證明才能核准。\n\n確定先送出？'))
        return Promise.reject(new Error('還沒送出：請先選證明照片或 PDF'));
      var body = { kind: 'leave', date: lv.date, leave_type: lv.type, reason: lv.reason };
      var two = lvSegs();
      if (two) { var ck = segCheck('leave', two, segMax('leave')); if (ck) return Promise.reject(segErr(ck)); body.segments = two; }   // 兩段：不帶 start／end／hours（api.md）
      else if (lv.mode === 'day') body.hours = lv.hours; else { body.start = lv.start; body.end = lv.end; }
      if (lv.type === '補休' && compBlocked()) return Promise.reject(new Error('補休只有正職可以請'));
      var preNow = leavePreBlock(lv.type, lv.date);
      if (preNow) return Promise.reject(new Error(preNow));
      var lkH = lv.mode === 'day' ? Number(lv.hours) : two ? segHours(two) : spanHours(lv.start, lv.end);
      if (lv.mode !== 'day' && !two && (!lv.start || !lv.end || lv.start === lv.end || lkH > 12)) lkH = 0;   // 時段本身不對：交給後端回原本的字句（起訖一樣、超過 12 小時），生理假 8 小時先不判
      var lock = capLocked(lv.type, lkH, lv.date);
      if (lock) return Promise.reject(new Error(lock));   // 不看餘額：可以先休後補；主檔還沒建的人照樣可以送
      return withAttach(lv.file).then(function (aid) { if (aid) body.attach_id = aid; return body; });
    }, function () { lv = lvBlank(); });
    if (pre) { lvBtn.disabled = true; lvBtn._rqPreBlock = true; }
    p.appendChild(lvBtn);
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '送出後由你的主管審核（門市同仁是本店店長），結果在「我的申請」，下次打卡時也會告訴你。' }));
    if (lvSegs()) p.appendChild(h('div', { class: 'rq-note', text: '送出後會變成 2 張假單，主管可以一起核准。' }));
  }

  /* 加班（不分事前事後） */
  function otBlank() { return { date: '', start: '', end: '', reason: '', seg2: null, seg3: null, seg4: null }; }
  var ot = otBlank();
  /* 加班單要有打卡佐證（2026-11-14 Eason）：主管核定時會檢查加班時段在不在當天的打卡段裡（前後 15 分），
     沒有就核不過。這裡送單前先看那天的卡，不在裡面就黃字提醒——只提醒、照樣可以送（常常先送加班、隔天才補忘打卡）。
     判斷與後端 Requests.gs reqOtPunchProbs_ 同一套（spans 已含送出的忘打卡單；別家店的卡這裡看不到，所以只講「這家店」）。 */
  var otDay = { key: '', spans: null };
  function otPunchCovered(date, start, end, spans) {
    var m = function (hm) { var a = String(hm || '').split(':'); return a.length === 2 ? (+a[0]) * 60 + (+a[1]) : NaN; };
    var nowMin = date === taipeiToday(0) ? m(new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16)) : NaN;
    var ivs = [];
    spans.forEach(function (sp) {
      var a = m(sp.in), b = sp.out ? m(sp.out) : nowMin;
      if (isNaN(a) || isNaN(b)) return;
      if (sp.out_next || b < a) b += 1440;
      ivs.push([a, b]);
    });
    ivs.sort(function (x, y) { return x[0] - y[0]; });
    var mg = [];
    ivs.forEach(function (x) { var l = mg[mg.length - 1]; if (l && x[0] <= l[1] + 15) l[1] = Math.max(l[1], x[1]); else mg.push([x[0], x[1]]); });
    var s = m(start), e = m(end);
    if (isNaN(s) || isNaN(e)) return true;
    if (e <= s) e += 1440;
    var fit = function (x, y) { return mg.some(function (v) { return x >= v[0] - 15 && y <= v[1] + 15; }); };
    return fit(s, e) || fit(s + 1440, e + 1440);
  }
  function otPunchWarn(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!ot.date || !st.store) return;
    var list = (segsOf(ot, 'ot', '') || [{ start: ot.start, end: ot.end }]).filter(function (g) { return g.start && g.end; });   // 兩段時每段各看
    if (!list.length) return;
    var key = st.store.code + '|' + ot.date;
    if (otDay.key !== key) {
      otDay = { key: key, spans: null };
      loadDay(st.store.code, ot.date).then(function (day) {
        if (otDay.key !== key) return;
        otDay.spans = (day.missing && day.missing.spans) || [];
        otPunchWarn(box);
      }, function () {});   // 讀不到就不提醒（核定時後端照樣會檢查）
      return;
    }
    if (!otDay.spans) return;
    var bad = list.filter(function (g) { return !otPunchCovered(ot.date, g.start, g.end, otDay.spans); });
    if (!bad.length) return;
    box.appendChild(h('div', { class: 'rq-proof-note rq-warns', text: '⚠ ' + bad.map(function (g) { return g.start + '–' + g.end; }).join('、') + ' 這段時間在「' + st.store.name + '」沒有完整的打卡紀錄，主管會核不過。請先到「忘打卡」補卡。\n（只是提醒，照樣可以送出）' }));
  }
  function renderOt(p) {
    if (!ot.date) ot.date = taipeiToday(0);
    var otWarn = h('div', {});
    var otHint = h('div', {});      // 依那天、那段時間在哪家打卡選店（2026-11-15）
    var otAbs = h('div', {});       // 兩家合計超過 8 小時：加班要開在被支援那家（2026-11-18 防呆）
    var otRange = function () { return ot.start && ot.end ? [ot.start, ot.end] : null; };
    p.appendChild(field('日期', datePick(ot.date, function (v) { ot.date = v; otPunchWarn(otWarn); storeHint(otHint, ot.date, otRange()); otAbsorbHint(otAbs, otHint, ot.date); }), [otHint]));
    storeHint(otHint, ot.date, otRange());
    otAbsorbHint(otAbs, otHint, ot.date);
    var otSegs = function () { return segsOf(ot, 'ot', ''); };
    var otSplit = h('div', {});
    var otUpd = function () { otPunchWarn(otWarn); if (ot.start && ot.end) storeHint(otHint, ot.date, otRange()); segSplitNote(otSplit, ot.date, otSegs()); };
    var otBox = segBlock(ot, 'ot', '', otUpd); otUpd();
    p.appendChild(field('加班時段', otBox, otSegs() ? [otWarn, otSplit] : [otWarn]));
    var rs = h('input', { type: 'text', maxlength: '100', value: ot.reason, placeholder: '例如：週六晚上外送訂單多', on: { input: function () { ot.reason = rs.value; } } });
    p.appendChild(field('原因（必填）', rs));
    // 補休（2026-11-01）：不再分加班費／換補休——核准的加班都先抵當月補休，剩的照加班費發
    if (comp().allowed) p.appendChild(h('div', { class: 'rq-muted', text: '核准後先抵當月請的補休，剩下的照加班費發。補休：' + compText() }));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      var two = otSegs();
      if (two && two.length > segMaxN('ot')) return Promise.reject(new Error('加班一次最多填' + SEG_NUM[segMaxN('ot')] + '段時間'));
      if (two) { var ck = segCheck('ot', two, Math.min(segMax('ot'), otMaxH())); if (ck) return Promise.reject(segErr(ck)); return Promise.resolve({ kind: 'ot', date: ot.date, segments: two, reason: ot.reason }); }
      var oh = spanHours(ot.start, ot.end);   // N1：單張上限 10 小時（原 12），req_info 的 ot_max_h 有給就用給的
      if (oh !== null && oh > otMaxH() + 0.001) return Promise.reject(new Error('加班時段超過 ' + otMaxH() + ' 小時，請確認時間'));
      return Promise.resolve({ kind: 'ot', date: ot.date, start: ot.start, end: ot.end, reason: ot.reason });
    }, function () { ot = otBlank(); }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: otSegs() ? '送出後會變成 ' + otSegs().length + ' 張加班單，主管可以一起核准。' : '已經加過班或還沒加班都可以申請。實際時數以主管當天核定為準。' }));
  }

  /* 出差（2026-10-09）：日期 7 天前（2026-11-05 由 31 改 7）到 90 天後；整天填時數或只一段填起訖；地點、事由必填。
     存成 leave_type＝出差、reason＝'地點：…；事由：…'；核准後核定頁預填「出差」＋時數（與上班時段相加）。
     2026-11-07 Eason：地點改下拉選單（TRIP_PLACES）＋「其他」自己打；後端照舊收文字，送出的是選到的名稱或自填內容。 */
  var TRIP_PLACES = ['總部辦公室', '新竹光復', '新竹金山', '台北六張犁', '台北瑞光', '台中美村'];
  var TRIP_OTHER = '其他';
  function tpBlank() { return { date: '', mode: 'day', hours: '8', start: '', end: '', pick: '', place: '', why: '', seg2: null, seg3: null, seg4: null }; }
  var tp = tpBlank();
  function tripPlace() { return tp.pick === TRIP_OTHER ? tp.place.trim() : tp.pick; }
  function renderTrip(p) {
    if (!tp.date) tp.date = taipeiToday(0);
    var tw = preWarns('trip', '', tp.date);
    var tpHint = h('div', {});      // 依那天、那段時間在哪家打卡選店（2026-11-15）
    var tpRange = function () { return tp.mode !== 'day' && tp.start && tp.end ? [tp.start, tp.end] : null; };
    var tpSegs = function () { return tp.mode === 'day' ? null : segsOf(tp, 'trip', ''); };
    p.appendChild(field('日期', datePick(tp.date, function (v) { tp.date = v; render(); }), (tw.length ? [warnBox(tw)] : []).concat([tpHint])));
    storeHint(tpHint, tp.date, tpRange());
    var modeBox = h('div', {}, [chips(['整天', '只一段'], tp.mode === 'day' ? '整天' : '只一段', function (v) { tp.mode = v === '整天' ? 'day' : 'span'; render(); })]);
    if (tp.mode === 'day') {
      var hr = h('input', { type: 'number', min: '0.5', max: '24', step: '0.5', value: tp.hours, class: 'rq-hours', on: { input: function () { tp.hours = hr.value; } } });
      modeBox.appendChild(h('div', { class: 'rq-row' }, ['共 ', hr, ' 小時']));
    } else {
      var tpSplit = h('div', {});
      var tpUpd = function () { if (tp.start && tp.end) storeHint(tpHint, tp.date, tpRange()); segSplitNote(tpSplit, tp.date, tpSegs()); };
      modeBox.appendChild(segBlock(tp, 'trip', '', tpUpd));
      if (tpSegs()) modeBox.appendChild(tpSplit);
      tpUpd();
    }
    p.appendChild(field('時段', modeBox));
    var opt = function (v, t) { return h('option', { value: v, text: t, selected: v === tp.pick }); };
    var ps = h('select', { class: 'rq-place-pick', 'aria-label': '出差地點', on: { change: function () { tp.pick = ps.value; render(); } } },
      [opt('', '請選擇')].concat(TRIP_PLACES.map(function (v) { return opt(v, v); }), [opt(TRIP_OTHER, '其他（自己填）')]));
    var plBox = h('div', {}, [ps]);
    if (tp.pick === TRIP_OTHER) {
      var pl = h('input', { type: 'text', maxlength: '40', value: tp.place, placeholder: '例如：廠商、銀行', class: 'rq-place', on: { input: function () { tp.place = pl.value; } } });
      plBox.appendChild(h('div', { class: 'rq-row' }, [pl]));
    }
    p.appendChild(field(tpSegs() ? '地點（必填，兩段相同）' : '地點（必填）', plBox));
    var wy = h('input', { type: 'text', maxlength: '100', value: tp.why, placeholder: '例如：支援月初盤點', class: 'rq-why', on: { input: function () { tp.why = wy.value; } } });
    p.appendChild(field('事由（必填）', wy));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      if (!tp.pick) return Promise.reject(new Error('請選出差地點'));
      if (!tripPlace()) return Promise.reject(new Error('請填出差地點'));
      if (!tp.why.trim()) return Promise.reject(new Error('請填出差事由'));
      var body = { kind: 'trip', date: tp.date, place: tripPlace(), why: tp.why.trim() };
      var two = tpSegs();
      if (two) { var ck = segCheck('trip', two, segMax('trip')); if (ck) return Promise.reject(segErr(ck)); body.segments = two; }
      else if (tp.mode === 'day') body.hours = tp.hours; else { body.start = tp.start; body.end = tp.end; }
      return Promise.resolve(body);
    }, function () { tp = tpBlank(); }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '出差時數會算進當天工時，由你的主管審核。' }));
    if (tpSegs()) p.appendChild(h('div', { class: 'rq-note', text: '兩段在不同地點，請分開送。' }));
  }

  /* 忘打卡 */
  function renderMiss(p) {
    // 2026-11-14 Eason：7 天改 4 天（同 Requests.gs REQ_MISS_DAYS）；11/28 以前 11 月的日子都選得到（同 reqPastLimit_）
    var days = [], today0 = taipeiToday(0), back = DATE_PAST, open = today0 <= DATE_OPEN_TO;
    if (open) back = Math.max(back, Math.round((Date.parse(today0 + 'T00:00:00Z') - Date.parse(DATE_OPEN_FROM + 'T00:00:00Z')) / 86400000));
    for (var i = 0; i <= back; i++) days.push(taipeiToday(-i));
    if (days.indexOf(st.missDate) < 0) st.missDate = '';
    var sel = h('select', { class: 'rq-date', on: { change: function () { st.missDate = sel.value; st.missType = ''; st.days = null; render(); } } },
      [h('option', { value: '', text: open ? '選日期（11/28 以前，11 月都能選）' : '選日期（只能選 ' + DATE_PAST + ' 天內）' })].concat(days.map(function (d) { return h('option', { value: d, text: md(d), selected: d === st.missDate }); })));
    p.appendChild(field('日期', sel));
    if (!st.missDate) return;
    // st.days＝{date, by:{店代碼: day|null}, note}：選日期後一次問完每家已綁定的店（只綁一家就只問那家）
    if (!st.days || st.days.date !== st.missDate) {
      var wait = h('div', { class: 'rq-muted', text: '查這天的打卡紀錄…' });
      p.appendChild(wait);
      var date = st.missDate, list = st.init.stores.length > 1 ? st.init.stores : [st.store];
      st.days = { date: date, by: null, note: null };
      Promise.all(list.map(function (s) {
        return loadDay(s.code, date).then(function (d) { return { code: s.code, name: s.name, day: d }; },
                                          function () { return { code: s.code, name: s.name, day: null }; });
      })).then(function (res) {
        if (!st.days || st.days.date !== date || st.missDate !== date) return;   // 等的時候改了日期
        var by = {}; res.forEach(function (x) { by[x.code] = x.day; });
        var dc = list.length > 1 ? decideStore(res, st.store.code, date) : { pick: null, note: null };
        st.days = { date: date, by: by, note: dc.note };
        if (dc.pick !== null) {
          st.store = st.init.stores.filter(function (s) { return s.code === dc.pick; })[0];
          st.info = null; st.missType = '';
          loadInfo().then(function () { if (st.tab !== 'miss') render(); }, function () {});   // 「我的申請」、證明清單跟著換店
        }
        render();
      });
      return;
    }
    if (!st.days.by) { p.appendChild(h('div', { class: 'rq-muted', text: '查這天的打卡紀錄…' })); return; }
    var note = st.days.note;
    if (note && note.kind === 'switched' && note.code === st.store.code)
      p.appendChild(h('div', { class: 'rq-auto-store', text: shortMd(note.date) + ' 你在' + note.name + '有打卡，已幫你選這家（不對可以在上面改）' }));
    if (note && note.kind === 'multi')
      p.appendChild(h('div', { class: 'rq-auto-store warn', text: shortMd(note.date) + ' 你在' + note.names.join('、') + '都有打卡，請確認上面選的店是你要補登的那家' }));
    var day = st.days.by[st.store.code];
    if (!day) { p.appendChild(msgBox('查不到這天的紀錄，請稍後再試', 'err')); return; }
    var rec = day.punches.length ? day.punches.map(function (x) {
      return x.hm + ' ' + (x.type === 'in' ? '上班' : '下班') + (x.status.indexOf('rejected_') === 0 ? '（沒有打成功）' : ' ✓');
    }).join('、') : '沒有任何打卡';
    p.appendChild(h('div', { class: 'rq-rec', text: '當天紀錄：' + rec }));
    // 已送出的忘打卡申請（2026-11-11）：這些算已經補上的卡，下面「缺哪張卡」只列還沒補的；一天漏好幾張就一張一張補
    var sent = ((st.info && st.info.requests) || []).filter(function (r) {
      return r.kind === 'miss' && r.date === st.missDate && (r.status === 'pending' || r.status === 'approved');
    });
    if (sent.length) p.appendChild(h('div', { class: 'rq-rec', text: '已送出的忘打卡申請：' + sent.map(function (r) {
      return (r.miss_type === 'both' ? '整段 ' + r.start + '–' + r.end : r.miss_type === 'in' ? '上班卡 ' + r.start
            : r.miss_type === 'out' ? '下班卡 ' + r.end : '中間休息 ' + r.end + '–' + r.start) + (r.status === 'approved' ? '（已核准）' : '（審核中）');
    }).join('、') }));
    var opts = day.missing.options;
    if (!opts.length) { p.appendChild(msgBox('這天的上班卡和下班卡都有打成功，不用補登。時間記錯請直接跟打卡門市的店長說。', 'err')); return; }
    var LBL = { in: '上班卡', out: '下班卡', both: (day.punches.length || sent.length) ? '另一段班整段沒打' : '上班和下班都沒打', break: '中間休息沒打卡' };
    if (opts.indexOf(st.missType) < 0) st.missType = opts[0];
    if (opts.length > 1) p.appendChild(field('缺哪張卡', chips(opts.map(function (o) { return LBL[o]; }), LBL[st.missType], function (v) {
      st.missType = Object.keys(LBL).filter(function (k) { return LBL[k] === v; })[0]; render(); })));
    else p.appendChild(field('缺哪張卡', h('div', { class: 'rq-fixed', text: LBL[st.missType] + '（系統查到的）' })));
    var mv = st.mv = st.mv && st.mv.k === st.missDate + st.missType ? st.mv : { k: st.missDate + st.missType, start: '', end: '', reason: '', other: '' };
    if (st.missType === 'break') {   // 中間休息（2026-11-02）：一次補「休息開始的下班卡＋回來的上班卡」；end＝下班、start＝回來上班
      p.appendChild(h('div', { class: 'rq-muted', text: '例如中午 12:00 下班去休息、18:00 回來上班，兩張都忘了打。' }));
      p.appendChild(field('休息開始（下班）', timePick(mv.end, 1, function (v) { mv.end = v; })));
      p.appendChild(field('回來上班', timePick(mv.start, 1, function (v) { mv.start = v; })));
    } else {
      if (st.missType === 'both' && day.punches.length) p.appendChild(h('div', { class: 'rq-muted', text: '例如白天 10:00–14:00 有打，晚上 17:00–21:00 整段都忘了打。' }));
      if (st.missType !== 'out') { var a = timePick(mv.start, 1, function (v) { mv.start = v; }); p.appendChild(field('實際上班時間', a)); }
      if (st.missType !== 'in') { var b = timePick(mv.end, 1, function (v) { mv.end = v; }); p.appendChild(field('實際下班時間', b)); }
    }
    var rbox = h('div', {}, [chips(MISS_REASONS, mv.reason, function (v) { mv.reason = v; render(); })]);
    if (mv.reason === '其他') {
      var oth = h('input', { type: 'text', maxlength: '80', value: mv.other, placeholder: '說明一下', on: { input: function () { mv.other = oth.value; } } });
      rbox.appendChild(oth);
    }
    p.appendChild(field('原因', rbox));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      if (!mv.reason) return Promise.reject(new Error('請選原因'));
      return Promise.resolve({ kind: 'miss', date: st.missDate, miss_type: st.missType, start: mv.start, end: mv.end,
                               reason: mv.reason === '其他' ? ('其他：' + (mv.other || '')).slice(0, 100) : mv.reason });
    }, function () { st.mv = null; st.days = null; st.missDate = ''; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '補登後當天仍算一次忘刷卡（全勤規則不變）' + (st.missType === 'break' ? '；中間休息兩張一起補，算一次。' : '。') }));
  }

  /* 我的申請 */
  function renderMine(p) {
    if (!st.info) { p.appendChild(h('div', { class: 'rq-empty', text: st.infoErr ? '讀不到你的申請，請稍後再打開一次。' : '讀取中…' })); return; }
    var list = (st.info && st.info.requests) || [];
    p.appendChild(h('div', { class: 'rq-muted', text: '最近 60 天' }));
    if (!list.length) { p.appendChild(h('div', { class: 'rq-empty', text: '還沒有任何申請' })); return; }
    // 同一次送出的兩張（2026-11-18）：店＋group＋emp_id＋date 都一樣才算一組，剩一張不成組；兩張排在一起、第 1 段在前
    var gcount = {}, shownProof = {};
    gcount = groupCounts(list);   // 只算還有效（審核中、已核准）的；取消／退回／作廢的不算進組數
    var grank = groupRanks(list);   // 第 N 段：在還有效的幾張裡排第幾（三、四段取消中間一張後不會變成「第 4 段／共 3 段」）
    if (Object.keys(gcount).length) list = list.slice().sort(function (a, b) {
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.group && a.group === b.group ? (a.seg || 0) - (b.seg || 0) : 0;
    });
    list.forEach(function (r) {
      var gk = groupKey(r), grouped = segLive(r) && !!gk && gcount[gk] >= 2 && !!r.seg;
      var s = STATUS[r.status] || [r.status, 'off'];
      if (st.cancelling[r.id]) s = ['取消中…', 'wait'];
      var title = r.kind === 'leave' ? r.leave_type + ' ' + r.hours + ' 小時'
                : r.kind === 'ot' ? '加班 ' + r.hours + ' 小時'
                : r.kind === 'trip' ? '出差 ' + r.hours + ' 小時'
                : r.miss_type === 'break' ? '忘打卡・補休息 ' + r.end + '–' + r.start
                : '忘打卡・補' + (r.miss_type === 'both' ? '上下班卡' : r.miss_type === 'in' ? '上班卡 ' + r.start : '下班卡 ' + r.end);
      var sub = md(r.date) + (r.start && r.kind !== 'miss' ? ' ' + r.start + '–' + r.end : (r.kind === 'leave' || r.kind === 'trip') ? ' 整天' : '')
        + (r.reason ? '・' + r.reason : '') + (grouped && r.kind === 'leave' && r.has_attach ? '・📎 已附證明' : '');
      var item = h('div', { class: 'rq-item' }, [
        h('div', { class: 'rq-t' }, [h('span', { text: title }), h('span', { class: 'rq-pill ' + s[1], text: s[0] })]),
        h('div', { class: 'rq-s', text: sub }),
      ]);
      if (grouped) item.appendChild(h('div', { class: 'rq-s' }, [h('span', { class: 'rq-grp', text: '同一次送出・第 ' + (grank[r.id] || r.seg) + ' 段／共 ' + gcount[gk] + ' 段' })]));
      if (r.status === 'rejected' && r.reject_reason) item.appendChild(h('div', { class: 'rq-s', text: '主管：' + r.reject_reason }));
      if (r.status === 'approved') item.appendChild(h('div', { class: 'rq-s', text: r.decided_by + ' 核准' }));
      if (r.status === 'voided') item.appendChild(h('div', { class: 'rq-s', text: r.voided_by + ' 作廢' + (r.void_reason ? '：' + r.void_reason : '') }));
      if ((r.status === 'pending' || r.status === 'approved') && r.warns && r.warns.length)
        item.appendChild(h('div', { class: 'rq-proof-note rq-warns', text: r.warns.map(function (w) { return '⚠ ' + w; }).join('\n') }));
      if (r.status === 'pending' && r.kind === 'leave' && (r.need_proof || r.proof_required) && !(grouped && shownProof[gk])) {
        if (grouped) shownProof[gk] = true;   // 同一次送出的兩張只出一個補附證明（一次補兩段）
        item.appendChild(proofBox(r));
      }
      if (r.status === 'pending') {
        // 按下確認立刻換成「取消中…」（不等後端）；成功就在本地把這列改成已取消，背景再重讀（2026-11-18）。取消失敗：還原按鈕，錯誤寫在這列底下。
        var cing = !!st.cancelling[r.id];
        var c = h('button', { type: 'button', class: 'rq-link', disabled: cing, text: cing ? '取消中…' : grouped ? '取消這一段' : '取消這筆申請', on: { click: function () {
          if (st.cancelling[r.id]) return;
          if (!confirm(grouped ? '確定要取消這一段？（同一次送出的另一段不受影響）' : '確定要取消這筆申請？')) return;
          st.cancelling[r.id] = true; st.cancelErr = null; st.flash = null; st.syncNote = '';
          render();
          var code = st.store.code, done = function (msg) {
            delete st.cancelling[r.id];
            if (msg) st.cancelErr = { id: r.id, text: msg };
            else {
              if (st.store && st.store.code === code) ((st.info && st.info.requests) || []).forEach(function (q) { if (q.id === r.id) { q.status = 'cancelled'; q.decided_by = '本人取消'; } });
              reloadBg('已取消，清單稍後更新');
            }
            if (st.tab === 'mine') render();
          };
          sendReq('cancel', E.storeApi(storeDef()), { action: 'req_cancel', id_token: liff.getIDToken(), id: r.id }).then(function (x) {
            done(x && x.ok ? '' : (x && x.message) || '取消沒有成功，請再試一次');
          }, function () { done('連線失敗，不確定有沒有取消成功，請先看清單再決定要不要再按一次'); });
        } } });
        item.appendChild(c);
        if (st.cancelErr && st.cancelErr.id === r.id) item.appendChild(msgBox(st.cancelErr.text, 'err'));
      }
      p.appendChild(item);
    });
  }

  /* 證明文件（2026-10-10 Eason：病假、婚假、喪假、產假相關一定要附；可先送出、核准前補附）。清單由各店 req_info 的 proof_types 給。 */
  function proofType(t, date) {
    if (!t || ((st.info && st.info.proof_types) || []).indexOf(t) < 0) return false;
    return t !== '病假' ? true : sickNth(date) >= ((st.info && st.info.sick_proof_days) || 0);   // 舊後端沒給 sick_proof_days＝照舊一定要附
  }
  /* 病假今年第幾天（2026-11-06：滿 3 天才要附證明）：後端給今年審核中＋已核准的病假日期，算選的那天前面有幾天＋1。
     伺服器送出時會再算一次（以它為準），這裡只是先講。 */
  /* 只提醒不擋（2026-11-06 Eason）：事假應前一天請、出差應前一週填、本月事假合計超過 3 天（事假「第 N 次」提醒 2026-11-18 Eason 拿掉，N4）。
     送出前在表單上先講（用「我的申請」的資料算）；送出後以伺服器算的 warns 為準（我的申請、主管頁都看那份）。 */
  function dDiff(a, b) {   // 日期字串 a − b 的天數
    var u = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); };
    return Math.round((u(a) - u(b)) / 86400000);
  }
  function preWarns(kind, type, date, hours) {
    var out = [], today = taipeiToday(0), d = String(date || '');
    if (!d) return out;
    if (kind === 'leave' && type === '事假') {
      if (d <= today) out.push('事假應在前一天請（這張是' + (d === today ? '當天' : '事後') + '才送）');
      var mine = ((st.info && st.info.requests) || []).filter(function (r) {
        return r.kind === 'leave' && r.leave_type === '事假' && (r.status === 'pending' || r.status === 'approved') && String(r.date).slice(0, 7) === d.slice(0, 7);
      });
      var hrs = mine.reduce(function (a, r) { return a + (Number(r.hours) || 0); }, Number(hours) || 0);
      if (hrs > 24) out.push('本月事假合計 ' + Math.round(hrs / 8 * 10) / 10 + ' 天，超過 3 天');
    }
    if (kind === 'trip') {
      var ahead = dDiff(d, today);
      if (ahead < 7) out.push('出差應在一週前填（' + (ahead > 0 ? '只提前 ' + ahead + ' 天' : ahead === 0 ? '當天才填' : '事後才填') + '）');
    }
    return out;
  }
  function warnBox(list) { return h('div', { class: 'rq-proof-note rq-warns', text: list.map(function (w) { return '⚠ ' + w; }).join('\n') + '\n（只是提醒，照樣可以送出，主管會看到）' }); }
  function sickNth(date) {
    var d = String(date || ''), list = (st.info && st.info.sick_dates) || [];
    if (!d) return 1;
    return list.filter(function (x) { return x.slice(0, 4) === d.slice(0, 4) && x < d; }).length + 1;
  }
  /** 同一次送出（店＋group＋emp_id＋date 都一樣）的 key；沒有 group ＝ ''。同一店的申請清單裡 group 只會在同一店內重複，所以不用再放店。 */
  function groupKey(r) { return r && r.group ? r.group + '|' + r.emp_id + '|' + r.date : ''; }
  /** 這張還算不算「有效的一段」：審核中、已核准才算（跟考勤管理一樣：剩一張有效就不框） */
  function segLive(r) { return !!r && (r.status === 'pending' || r.status === 'approved'); }
  /** 每個 group key 目前有效的張數（取消、退回、作廢的不算）；剩一張＝不成組 */
  function groupCounts(list) {
    var c = {};
    (list || []).forEach(function (r) { var k = segLive(r) ? groupKey(r) : ''; if (k) c[k] = (c[k] || 0) + 1; });
    return c;
  }
  /** 每張還有效的單在它那組裡排第幾（照 seg）：{id: 1…}。原本直接寫後端給的 seg，兩段時一張取消就不成組所以沒事；
   *  加班可到四段後，取消中間一張剩三張仍成組，要照剩下的重新數（2026-11-21）。 */
  function groupRanks(list) {
    var by = {}, out = {};
    (list || []).forEach(function (r) { var k = segLive(r) ? groupKey(r) : ''; if (k) (by[k] = by[k] || []).push(r); });
    Object.keys(by).forEach(function (k) {
      by[k].slice().sort(function (a, b) { return (a.seg || 0) - (b.seg || 0); }).forEach(function (r, i) { out[r.id] = i + 1; });
    });
    return out;
  }
  function proofBox(r) {
    var gk = groupKey(r);
    var members = gk ? ((st.info && st.info.requests) || []).filter(function (x) { return groupKey(x) === gk && x.kind === 'leave' && x.status === 'pending'; }) : [];
    if (members.length < 2) members = [r];   // 剩一張不成組
    var wrap = h('div', { class: 'rq-proof' });
    if (r.need_proof) wrap.appendChild(h('div', { class: 'rq-proof-note', text: '⚠ 還沒附證明：主管要等你補上才能核准' }));
    else wrap.appendChild(h('div', { class: 'rq-s', text: '已附證明（要換一張可以重新上傳）' }));
    var fi = h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true });
    var btn = h('button', { type: 'button', class: 'ghost rq-proof-btn', 'data-id': r.id, text: r.need_proof ? '📎 補附證明（拍照或選檔）' : '重新上傳證明',
      on: { click: function () { fi.click(); } } });
    var msg = h('div', {});
    fi.addEventListener('change', function () {
      var f = fi.files[0]; if (!f || st.busy) return;
      st.busy = true; btn.disabled = true; msg.innerHTML = ''; msg.appendChild(h('div', { class: 'rq-muted', text: '上傳中…' }));
      withAttach(f).then(function (aid) {
        // 同一次送出的兩段：上傳一次，兩張各呼叫一次 req_attach（後端不改）；一張就跟以前一樣
        return members.reduce(function (pr, m) {
          return pr.then(function (acc) {
            if (acc && acc.ok === false) return acc;
            return E.post(E.storeApi(storeDef()), { action: 'req_attach', id_token: liff.getIDToken(), id: m.id, attach_id: aid });
          });
        }, Promise.resolve({ ok: true }));
      }).then(function (x) {
        st.busy = false; btn.disabled = false;
        if (x && x.ok) return loadInfo().then(function () { render(); $root.insertBefore(msgBox('✓ 證明已補上，等主管審核', 'ok'), $root.children[2]); });
        msg.innerHTML = ''; msg.appendChild(msgBox((x && x.message) || '補附沒有成功，請再試一次', 'err'));
      }, function (e) {
        st.busy = false; btn.disabled = false; msg.innerHTML = '';
        msg.appendChild(msgBox(e && e.message && !/fetch|network|abort/i.test(e.message) ? e.message : '連線失敗，請再試一次', 'err'));
      });
    });
    wrap.appendChild(btn); wrap.appendChild(fi); wrap.appendChild(msg);
    return wrap;
  }

  /* ── 送出 ── */
  function submitBtn(out, build, reset) {
    var btn = h('button', { type: 'button', class: 'primary', text: st.gateWait ? '確認最新資料中…' : st.syncing ? '更新清單中…' : '送出申請', disabled: st.syncing || st.gateWait });
    btn._rqSubmit = true;
    btn.addEventListener('click', function () {
      if (st.busy || st.syncing) return;
      // 送出前確認（2026-11-18）：畫面上還有記住的資料 → 先等最新的，一樣才送
      if (!st.gateSkip && gateNeeded()) { gateThen(btn, out); return; }
      st.gateSkip = false; st.gateNote = null;
      st.busy = true; btn.disabled = true; out.innerHTML = ''; out.appendChild(h('div', { class: 'rq-muted', text: '送出中…' }));
      var sentCode = st.store ? st.store.code : null;
      // 組資料那一步就算當場出錯（不是回被拒絕的 Promise），也要走到下面的錯誤處理、把忙碌旗標放掉（2026-11-11）；
      // 原本錯誤直接丟出去，畫面停在「送出中…」、按鈕一直是灰的。
      var built;
      try { built = build(); } catch (err) { built = Promise.reject(err); }
      Promise.resolve(built).then(storeGuard).then(function (body) {
        body.action = 'req_submit'; body.id_token = liff.getIDToken();
        return sendReq('submit', E.storeApi(storeDef()), body);
      }).then(function (r) {
        st.busy = false; btn.disabled = false; out.innerHTML = '';
        if (r && r.error === 'invalid_id_token') {   // 送出時逾時：不自動重整（填的內容會不見），讓同仁自己按（2026-10-30）
          out.appendChild(msgBox('LINE 登入逾時，這張還沒送出。\n按「重新連線」後要再填一次。', 'err'));
          var rb = h('button', { type: 'button', class: 'rq-link', text: '重新連線', on: { click: function () {
            if (E.relogin() === 'stuck') { out.innerHTML = ''; out.appendChild(msgBox('請關掉這頁，再從選單按「申請」重新打開；一直這樣請告知主管。', 'err')); }
          } } });
          out.appendChild(rb);
          return;
        }
        if (!r || !r.ok) { out.appendChild(msgBox((r && r.message) || '送出沒有成功，請再試一次', 'err')); if (r && r.seg) markSegBad(r.seg); return; }
        reset();
        tellChat('申請已送出' + sumTail(r));
        var two = r.requests && r.requests.length >= 2;   // 一次填多段：變成好幾張單（2026-11-18 兩段；2026-11-21 加班最多四段）
        var warns = [];
        (two ? r.requests : [r.request]).forEach(function (q) { ((q && q.warns) || []).forEach(function (w) { if (warns.indexOf(w) < 0) warns.push(w); }); });
        // 先把剛送出的列畫出來、立刻切到「我的申請」，伺服器最新清單在背景重讀（2026-11-18；以前同步等 req_info 約 3.5 秒才換畫面）
        if (st.store && sentCode !== null && st.store.code === sentCode) adoptRows(two ? r.requests : [r.request]);
        st.flash = { cls: 'ok', text: '✓ 已送出' + sumTail(r)
          + (two ? '\n會變成 ' + r.requests.length + ' 張' + ({ ot: '加班單', leave: '假單', trip: '出差單' }[r.request && r.request.kind] || '單') + '，等主管審核'
                 : r.request && r.request.kind === 'miss' ? '\n等打卡門市的店長審核' : '\n等主管審核')
          + (warns.length ? '\n' + warns.map(function (w) { return '⚠ ' + w; }).join('\n') : '') };
        st.syncNote = ''; st.cancelErr = null; st.tab = 'mine';
        reloadBg('已送出，清單稍後更新');
        render();
      }, function (e) {
        st.busy = false; btn.disabled = false; out.innerHTML = '';
        if (e && e.seg) markSegBad(e.seg);
        out.appendChild(msgBox(e && e.message && !/fetch|network|abort/i.test(e.message) ? e.message : '連線失敗：不確定有沒有送出，請先看「我的申請」再決定要不要重送', 'err'));
      });
    });
    return btn;
  }
  /* ── 送出前確認（2026-11-18）──
   * 手機記住的（localStorage）／Mac mini 記住的資料只拿來先畫（mini 存檔的店別清單沒有姓名、工號：標題先不顯示姓名，最新的到了才顯示）；會影響這張單的（店別清單、假別、額度、我的申請裡的開關與上限）
   * 送出前要以光復／那家店剛給的為準：還沒到就等（最多 GATE_MS），到了跟畫面上不一樣就不送、換成最新畫面請同仁再確認；
   * 等不到或讀不到就照送（店家後端照樣用名冊、額度檢查，不會因為等不到而送錯）。 */
  var GATE_MS = 12000;
  function gateNeeded() {
    if (!st.init) return false;
    if (!st.init.fresh && !st.initFailed && st.initWait) return true;
    if (st.tab === 'leave' && st.src.quota !== 'google' && !st.quotaErr && st.quotaWait) return true;
    if (st.store && !st.infoReal && st.infoWait && st.infoWait.code === st.store.code) return true;
    return false;
  }
  /** ids＝比對店別時連工號一起比（畫面上的店別清單有工號才比；Mac mini 存檔先畫的清單沒有姓名、工號，只比店代碼，免得多跳一次「剛更新」）。 */
  function gateHasIds() { return ((st.init && st.init.stores) || []).every(function (x) { return x.emp_id !== undefined && x.emp_id !== null && x.emp_id !== ''; }); }
  function gateFp(withQuota, ids) {
    var o = { s: st.store ? String(st.store.code) : null,
              ss: ((st.init && st.init.stores) || []).map(function (x) { return String(x.code) + (ids ? ':' + String(x.emp_id) : ''); }).join(',') };
    var x = ({ leave: lv, ot: ot, trip: tp })[st.tab];
    if (st.tab === 'leave' && lv.type) {
      var lt = (st.init && st.init.leave_types) || {};
      o.lt = (lt.common || []).concat(lt.special || []).indexOf(lv.type) >= 0;
      if (withQuota) {
        var q = ((st.init && st.init.quota) || []).filter(function (y) { return y.name === lv.type; })[0];
        o.q = q ? [q.remain_h, q.cap_h, q.used_n === undefined ? null : q.used_n, Array.isArray(q.dates) ? q.dates.map(String).sort() : null] : null;   // dates＝生理假已請過哪幾天（2026-11-18 驗收補）
        o.cb = compBlocked();
      }
    }
    if (x && x.seg2 && st.info) { o.sg = seg2Ok(st.tab, st.tab === 'leave' ? lv.type : ''); o.sn = segMaxN(st.tab); }   // 後端最新說「最多幾段」跟畫面上不一樣也要請同仁再確認（2026-11-21）
    if (st.tab === 'ot' && st.info) o.om = otMaxH();
    return JSON.stringify(o);
  }
  function gateThen(btn, out) {
    var ids = gateHasIds(), before = gateFp(st.quotaReady, ids), names = {}, stores0 = (st.init.stores || []).slice();
    stores0.forEach(function (s) { names[String(s.code)] = s.name; });
    st.busy = true; st.gateWait = true; st.gateNote = null; btn.disabled = true; btn.textContent = '確認最新資料中…';
    out.innerHTML = ''; out.appendChild(h('div', { class: 'rq-muted rq-gate-wait', text: '確認最新的店別與額度…' }));
    var waits = [st.initWait, st.tab === 'leave' ? st.quotaWait : null, st.infoWait && st.store && st.infoWait.code === st.store.code ? st.infoWait.p : null].filter(Boolean);
    var timer, timeout = new Promise(function (res) { timer = setTimeout(res, GATE_MS); });
    var tab = st.tab;
    Promise.race([Promise.all(waits.map(function (p) { return Promise.resolve(p).then(null, function () {}); })), timeout]).then(function () {
      clearTimeout(timer);
      // 換成最新的店之後「我的申請」還在讀（店別換了）：等一下那家店（不另外計時，也在上限內）
      return st.store && !st.infoReal && st.infoWait && st.infoWait.code === st.store.code
        ? Promise.race([st.infoWait.p, new Promise(function (res) { setTimeout(res, 4000); })]) : null;
    }).then(function () {
      st.busy = false; st.gateWait = false;
      if (st.tab !== tab) { render(); return; }
      var after = gateFp(st.quotaReady && before.indexOf('"q"') >= 0, ids), stores1 = st.init.stores || [];
      if (after !== before) {
        var gone = stores0.filter(function (s) { return !stores1.some(function (y) { return String(y.code) === String(s.code); }); }).map(function (s) { return s.name; });
        var added = stores1.filter(function (s) { return !names.hasOwnProperty(String(s.code)); }).map(function (s) { return s.name; });
        var txt = gone.length ? '你綁定的店有變動（「' + gone.join('、') + '」已經不在名單），店別已換成「' + st.store.name + '」。請確認後再按一次送出。'
                : added.length ? '你綁定的店剛更新（多了「' + added.join('、') + '」）。請確認上面選的店別對不對，再按一次送出。'
                : '假別、額度或這家店的規則剛更新，畫面已換成最新的。請確認後再按一次送出。';
        st.gateNote = { tab: tab, text: txt };
        render(); return;
      }
      if (document.body.contains(btn)) { btn.disabled = false; st.gateSkip = true; btn.click(); return; }
      var nb = Array.prototype.filter.call($root.querySelectorAll('button.primary'), function (b) { return b._rqSubmit; })[0];   // 等的時候畫面重畫過：按新的那顆
      if (nb) { nb.disabled = false; st.gateSkip = true; nb.click(); } else render();
    });
  }
  /** 讓機器人回一張「已送出」卡片（回覆免費）；不在 LINE 裡就算了，畫面上已經看得到。 */
  function tellChat(text) {
    if (!liff.isInClient || !liff.isInClient() || !liff.sendMessages) return;
    liff.sendMessages([{ type: 'text', text: text.slice(0, 200) }]).then(function () {}, function () {});
  }
  /** 附件：照片先縮成 1600px JPEG 再傳光復；PDF 原檔（上限 3MB）。回 attach_id 或 ''。 */
  function withAttach(file) {
    if (!file) return Promise.resolve('');
    var toDataUrl = /^image\//.test(file.type) ? shrinkImage(file) : new Promise(function (res, rej) {
      if (file.type !== 'application/pdf') { rej(new Error('只能上傳照片或 PDF')); return; }
      if (file.size > 3 * 1024 * 1024) { rej(new Error('PDF 太大（上限 3MB）')); return; }
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(new Error('讀不到這個檔案')); }; fr.readAsDataURL(file);
    });
    return toDataUrl.then(function (url) {
      return E.post(E.HUB_API, { action: 'line_hub_attach_put', id_token: liff.getIDToken(), data_url: url }, 60000);
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('附件上傳失敗：' + ((r && r.message) || '請再試一次，或先不附附件送出'));
      return r.attach_id;
    });
  }
  function shrinkImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('讀不到這張照片')); };
      img.src = url;
    });
  }

  window.ReqLine = { open: open };
})();
