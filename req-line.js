/* 加班請假／忘打卡申請頁（2026-10-09，規格 mala-clock-liff docs/requests-spec.md）
 * 由 clock-line.html 載入：同一個 LIFF，網址帶 ?view=req&tab=leave|ot|trip|miss|mine 就顯示這頁，不顯示打卡。
 * 2026-10-09 加「出差」分頁；下班打卡超過 8 小時的「申請加班」按鈕會帶 tab=ot＋date／start／end 預填。
 * 開頁資料：光復 line_hub_req_init（綁了哪些店、假別、額度）＋那家店 req_info（我的申請、某天缺哪張卡）。
 * 送出：那家店 req_submit；附件先傳光復 line_hub_attach_put 拿 ID。結果不推播，回「我的申請」看。
 * 2026-10-28 忘打卡自動選店：綁兩家以上的同仁選好日期後，同時問每家店那天有沒有卡（req_info day_only）；
 * 剛好只有一家有卡（含被擋的卡）就幫他切到那家並寫一行說明，兩家以上都有卡提醒確認，都沒有或有店問不到就不動。
 * 2026-10-29 預設店別＝打卡的那家：opts.store（打卡畫面剛打卡的店）→ line_hub_req_init 的 punch_store（最近一張卡）→ 第一家。 */
(function () {
  'use strict';
  var E, $root, st = { init: null, store: null, info: null, tab: 'leave', busy: false };
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
  function taipeiToday(offsetDays) {
    var d = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000 + (offsetDays || 0) * 86400000);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
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

  /* ── 開頁 ── */
  function open(opts) {
    E = window.ClockLineEnv;
    $root = document.getElementById('reqView');
    st.tab = TABS.some(function (t) { return t[0] === opts.tab; }) ? opts.tab : 'leave';
    st.missDate = opts.date || ''; st.missType = opts.miss || '';
    // 下班打卡提示加班（opts.start／end）：預填加班分頁，原因留給同仁寫
    if (st.tab === 'ot' && opts.date && opts.start && opts.end) ot = { date: opts.date, start: opts.start, end: opts.end, reason: '', comp: 'pay' };
    $root.hidden = false;
    $root.innerHTML = '';
    $root.appendChild(h('div', { class: 'rq-loading', text: '讀取中…' }));
    E.readRetry(E.HUB_API, { action: 'line_hub_req_init', id_token: liff.getIDToken() }).then(function (r) {
      if (r && r.error === 'invalid_id_token') { liff.login(); return; }
      if (!r || !r.ok) {
        $root.innerHTML = '';
        $root.appendChild(msgBox(r && r.error === 'not_bound' ? '你還沒綁定打卡。請先到店裡按選單「打卡」完成綁定，再來申請。' : '讀不到資料，請稍後再試。', 'err'));
        return;
      }
      st.init = r;
      // 預設店別＝打卡的那家（2026-10-29）：從打卡畫面按進來用剛打卡的店，從選單開用後台查到最近一張卡的店；都沒有才用第一家
      st.store = pickStore(r.stores, [opts.store, r.punch_store]);
      return loadInfo().then(render);
    }, function () { $root.innerHTML = ''; $root.appendChild(msgBox('連線失敗，請檢查網路後重新打開。', 'err')); });
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
    return E.readRetry(E.storeApi(storeDef()), { action: 'req_info', id_token: liff.getIDToken() }).then(function (r) {
      if (r && r.ok) { st.info = r; return r; }
      throw new Error((r && r.error) || 'failed');
    });
  }
  /** 那家店那天的卡（忘打卡用）。day_only：新後端只讀尾端、不讀申請表；舊後端不認得就照舊整包回，一樣有 day。 */
  function loadDay(code, date) {
    var def = storeDef(code);
    if (!def) return Promise.reject(new Error('no_store'));
    return E.readRetry(E.storeApi(def), { action: 'req_info', id_token: liff.getIDToken(), date: date, day_only: true }).then(function (r) {
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

  /* ── 畫面 ── */
  function render() {
    $root.innerHTML = '';
    var head = h('div', { class: 'rq-head' }, [h('b', { text: st.store.emp_name }), ' ']);
    if (st.init.stores.length > 1) {
      var sel = h('select', { class: 'rq-store', on: { change: function () {
        st.store = st.init.stores[+sel.value]; st.info = null;
        if (st.tab === 'miss') render();   // 忘打卡：各店那天的卡已經一起查好了，先換畫面
        loadInfo().then(render, function () { alert('讀不到這家店的資料'); });
      } } }, st.init.stores.map(function (s, i) { return h('option', { value: i, text: s.name, selected: s === st.store }); }));
      head.appendChild(sel);
    } else head.appendChild(h('span', { class: 'rq-muted', text: st.store.name }));
    $root.appendChild(head);
    $root.appendChild(h('div', { class: 'rq-tabs' }, TABS.map(function (t) {
      return h('button', { type: 'button', class: t[0] === st.tab ? 'on' : '', 'data-tab': t[0], text: t[1],
                           on: { click: function () { st.tab = t[0]; render(); } } });
    })));
    var panel = h('div', { class: 'rq-panel' });
    $root.appendChild(panel);
    ({ leave: renderLeave, ot: renderOt, trip: renderTrip, miss: renderMiss, mine: renderMine })[st.tab](panel);
  }

  function chips(list, value, onPick) {
    var wrap = h('div', { class: 'rq-chips' });
    list.forEach(function (v) {
      wrap.appendChild(h('button', { type: 'button', class: 'rq-chip' + (v === value ? ' on' : ''), text: v,
                                     on: { click: function () { onPick(v); } } }));
    });
    return wrap;
  }
  /* 補休（2026-10-09）：光復 line_hub_req_init 回 comp {allowed（正職）, balance_h, earliest_expiry}。 */
  function comp() { return (st.init && st.init.comp) || { allowed: false, balance_h: 0, earliest_expiry: '' }; }
  /** 可用＝餘額扣掉審核中／已核准還沒入帳的補休（2026-10-30；舊後端沒有 available_h 就用餘額） */
  function compAvail() { var c = comp(); return c.available_h !== undefined ? Number(c.available_h) || 0 : Number(c.balance_h) || 0; }
  function compText() {
    var c = comp(), e = c.earliest_expiry, held = Number(c.reserved_h) || 0;
    return (held > 0 ? '可用 ' + compAvail() + ' 小時（另有 ' + held + ' 小時已申請、還沒入帳）'
                     : '剩 ' + (Math.round((Number(c.balance_h) || 0) * 100) / 100) + ' 小時')
      + (e ? '・最早 ' + (+e.slice(5, 7)) + '/' + (+e.slice(8, 10)) + ' 到期' : '');
  }
  function quotaText(name) {
    if (name === '補休') return '';   // 補休的餘額另外一行一直顯示（見 renderLeave）
    var q = (st.init.quota || []).filter(function (x) { return x.name === name; })[0];
    if (!q || q.cap_days == null) return '';
    var r1 = function (v) { return Math.round((Number(v) || 0) * 10) / 10; };
    if (q.basis === 'event') return '每次上限 ' + r1(q.cap_h) + ' 小時';
    return q.remain_h < 0 ? '已超出 ' + r1(-q.remain_h) + ' 小時' : '剩 ' + r1(q.remain_h) + ' 小時（上限 ' + r1(q.cap_h) + '）';
  }

  /* 請假 */
  var lv = { date: '', type: '', mode: 'day', hours: '8', start: '', end: '', reason: '', file: null };
  function renderLeave(p) {
    if (!lv.date) lv.date = taipeiToday(0);
    var lt = st.init.leave_types || { common: [], special: [] };
    var dateIn = h('input', { type: 'date', value: lv.date, on: { change: function () { lv.date = dateIn.value; } } });
    p.appendChild(field('日期', dateIn));
    var typeBox = h('div', {});
    typeBox.appendChild(chips(lt.common, lv.type, function (v) { lv.type = v; render(); }));
    if (lt.special.length) {
      var sp = h('select', { class: 'rq-special', on: { change: function () { if (sp.value) { lv.type = sp.value; render(); } } } },
        [h('option', { value: '', text: '特殊假別（婚假、喪假、產假…）' })].concat(lt.special.map(function (n) { return h('option', { value: n, text: n, selected: n === lv.type }); })));
      typeBox.appendChild(sp);
    }
    var q = lv.type ? quotaText(lv.type) : '';
    var qx = q ? [h('div', { class: 'rq-quota', text: lv.type + '：' + q })] : [];
    // 補休有餘額才會出現在假別裡；餘額與最早到期日一直顯示，選之前就看得到
    if (lt.common.indexOf('補休') >= 0) qx.push(h('div', { class: 'rq-quota rq-comp-bal', text: '補休：' + compText() }));
    p.appendChild(field('假別', typeBox, qx));
    var modeBox = h('div', {}, [chips(['整天', '只請一段'], lv.mode === 'day' ? '整天' : '只請一段', function (v) { lv.mode = v === '整天' ? 'day' : 'span'; render(); })]);
    if (lv.mode === 'day') {
      var hr = h('input', { type: 'number', min: '0.5', max: '24', step: '0.5', value: lv.hours, class: 'rq-hours', on: { input: function () { lv.hours = hr.value; } } });
      modeBox.appendChild(h('div', { class: 'rq-row' }, ['共 ', hr, ' 小時']));
    } else {
      var s1 = timePick(lv.start, 15, function (v) { lv.start = v; upd(); });
      var e1 = timePick(lv.end, 15, function (v) { lv.end = v; upd(); });
      var tot = h('span', { class: 'rq-muted' });
      var upd = function () { var x = spanHours(lv.start, lv.end); tot.textContent = x ? '共 ' + x + ' 小時' : ''; };
      modeBox.appendChild(h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot])); upd();
    }
    p.appendChild(field('時段', modeBox));
    var rs = h('input', { type: 'text', maxlength: '100', value: lv.reason, placeholder: '例如：家裡有事', on: { input: function () { lv.reason = rs.value; } } });
    p.appendChild(field('原因（選填）', rs));
    var fi = h('input', { type: 'file', accept: 'image/*,application/pdf', on: { change: function () { lv.file = fi.files[0] || null; } } });
    var mustProof = proofType(lv.type);
    p.appendChild(field(mustProof ? '證明文件（' + lv.type + '一定要附）' : '附件（選填，病假證明、訃聞等）', fi,
      [h('div', { class: mustProof ? 'rq-proof-note' : 'rq-muted', id: 'rqProofNote',
                  text: mustProof ? '可以拍照或選照片／PDF。手上還沒有證明也能先送出，但主管要等你在「我的申請」補上才能核准。'
                                  : '照片或 PDF，只有值班主管看得到' })]));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      if (!lv.type) return Promise.reject(new Error('請選假別'));
      if (proofType(lv.type) && !lv.file && !confirm(lv.type + '要附證明。\n\n沒附也可以先送出，但主管要等你在「我的申請」補上證明才能核准。\n\n確定先送出？'))
        return Promise.reject(new Error('還沒送出：請先選證明照片或 PDF'));
      var body = { kind: 'leave', date: lv.date, leave_type: lv.type, reason: lv.reason };
      if (lv.mode === 'day') body.hours = lv.hours; else { body.start = lv.start; body.end = lv.end; }
      // 補休不能超過餘額（只能用已定案月份換到的時數）
      if (lv.type === '補休') {
        var need = lv.mode === 'day' ? Number(lv.hours) : spanHours(lv.start, lv.end);
        var bal = compAvail();
        if (!comp().allowed) return Promise.reject(new Error('補休只有正職可以請'));
        if (need > bal) return Promise.reject(new Error('補休可用只剩 ' + bal + ' 小時' + ((Number(comp().reserved_h) || 0) > 0 ? '（有 ' + comp().reserved_h + ' 小時已申請、還沒入帳）' : '') + '，不夠請 ' + need + ' 小時'));
      }
      return withAttach(lv.file).then(function (aid) { if (aid) body.attach_id = aid; return body; });
    }, function () { lv = { date: '', type: '', mode: 'day', hours: '8', start: '', end: '', reason: '', file: null }; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '送出後由值班主管審核，結果在「我的申請」，下次打卡時也會告訴你。' }));
  }

  /* 加班（不分事前事後） */
  var ot = { date: '', start: '', end: '', reason: '', comp: 'pay' };
  function renderOt(p) {
    if (!ot.date) ot.date = taipeiToday(0);
    var dateIn = h('input', { type: 'date', value: ot.date, on: { change: function () { ot.date = dateIn.value; } } });
    p.appendChild(field('日期', dateIn));
    var s1 = timePick(ot.start, 15, function (v) { ot.start = v; upd(); });
    var e1 = timePick(ot.end, 15, function (v) { ot.end = v; upd(); });
    var tot = h('span', { class: 'rq-muted' });
    var upd = function () { var x = spanHours(ot.start, ot.end); tot.textContent = x ? '共 ' + x + ' 小時' : ''; }; upd();
    p.appendChild(field('加班時段', h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot])));
    var rs = h('input', { type: 'text', maxlength: '100', value: ot.reason, placeholder: '例如：週六晚上外送訂單多', on: { input: function () { ot.reason = rs.value; } } });
    p.appendChild(field('原因（必填）', rs));
    // 加班費／換補休（2026-10-09）：只有正職看得到；計時同仁不顯示、一律加班費
    if (comp().allowed) {
      var cw = h('div', { class: 'rq-comp' });
      [['pay', '加班費'], ['comp', '換補休']].forEach(function (o) {
        var rb = h('input', { type: 'radio', name: 'rqComp', value: o[0], checked: (ot.comp || 'pay') === o[0],
                              on: { change: function () { if (rb.checked) { ot.comp = o[0]; cnote.textContent = noteOf(); } } } });
        cw.appendChild(h('label', { class: 'rq-radio' }, [rb, ' ' + o[1]]));
      });
      var noteOf = function () { return ot.comp === 'comp'
        ? '1 小時換 1 小時補休，薪資定案後入帳，6 個月內要休完（沒休完照加班費折算）；最多換到當月實際加班時數'
        : '照加班費率發給'; };
      var cnote = h('div', { class: 'rq-muted', text: noteOf() });
      p.appendChild(field('要加班費還是換補休', cw, [cnote]));
    }
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      return Promise.resolve({ kind: 'ot', date: ot.date, start: ot.start, end: ot.end, reason: ot.reason,
                               comp: comp().allowed && ot.comp === 'comp' ? 'comp' : 'pay' });
    }, function () { ot = { date: '', start: '', end: '', reason: '', comp: 'pay' }; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '已經加過班或還沒加班都可以申請。實際時數以主管當天核定為準。' }));
  }

  /* 出差（2026-10-09）：日期 31 天前到 90 天後；整天填時數或只一段填起訖；地點、事由必填。
     存成 leave_type＝出差、reason＝'地點：…；事由：…'；核准後核定頁預填「出差」＋時數（與上班時段相加）。 */
  var tp = { date: '', mode: 'day', hours: '8', start: '', end: '', place: '', why: '' };
  function renderTrip(p) {
    if (!tp.date) tp.date = taipeiToday(0);
    var dateIn = h('input', { type: 'date', value: tp.date, min: taipeiToday(-31), max: taipeiToday(90), on: { change: function () { tp.date = dateIn.value; } } });
    p.appendChild(field('日期', dateIn));
    var modeBox = h('div', {}, [chips(['整天', '只一段'], tp.mode === 'day' ? '整天' : '只一段', function (v) { tp.mode = v === '整天' ? 'day' : 'span'; render(); })]);
    if (tp.mode === 'day') {
      var hr = h('input', { type: 'number', min: '0.5', max: '24', step: '0.5', value: tp.hours, class: 'rq-hours', on: { input: function () { tp.hours = hr.value; } } });
      modeBox.appendChild(h('div', { class: 'rq-row' }, ['共 ', hr, ' 小時']));
    } else {
      var s1 = timePick(tp.start, 15, function (v) { tp.start = v; upd(); });
      var e1 = timePick(tp.end, 15, function (v) { tp.end = v; upd(); });
      var tot = h('span', { class: 'rq-muted' });
      var upd = function () { var x = spanHours(tp.start, tp.end); tot.textContent = x ? '共 ' + x + ' 小時' : ''; };
      modeBox.appendChild(h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot])); upd();
    }
    p.appendChild(field('時段', modeBox));
    var pl = h('input', { type: 'text', maxlength: '40', value: tp.place, placeholder: '例如：台中央廚', class: 'rq-place', on: { input: function () { tp.place = pl.value; } } });
    p.appendChild(field('地點（必填）', pl));
    var wy = h('input', { type: 'text', maxlength: '100', value: tp.why, placeholder: '例如：支援月初盤點', class: 'rq-why', on: { input: function () { tp.why = wy.value; } } });
    p.appendChild(field('事由（必填）', wy));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      if (!tp.place.trim()) return Promise.reject(new Error('請填出差地點'));
      if (!tp.why.trim()) return Promise.reject(new Error('請填出差事由'));
      var body = { kind: 'trip', date: tp.date, place: tp.place.trim(), why: tp.why.trim() };
      if (tp.mode === 'day') body.hours = tp.hours; else { body.start = tp.start; body.end = tp.end; }
      return Promise.resolve(body);
    }, function () { tp = { date: '', mode: 'day', hours: '8', start: '', end: '', place: '', why: '' }; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '出差時數會算進當天工時，由值班主管核定。' }));
  }

  /* 忘打卡 */
  function renderMiss(p) {
    var days = [];
    for (var i = 0; i <= 7; i++) days.push(taipeiToday(-i));
    if (days.indexOf(st.missDate) < 0) st.missDate = '';
    var sel = h('select', { class: 'rq-date', on: { change: function () { st.missDate = sel.value; st.missType = ''; st.days = null; render(); } } },
      [h('option', { value: '', text: '選日期（只能選 7 天內）' })].concat(days.map(function (d) { return h('option', { value: d, text: md(d), selected: d === st.missDate }); })));
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
    var opts = day.missing.options;
    if (!opts.length) { p.appendChild(msgBox('這天的上班卡和下班卡都有打成功，不用補登。時間記錯請直接跟值班主管說。', 'err')); return; }
    var LBL = { in: '上班卡', out: '下班卡', both: '上班和下班都沒打' };
    if (opts.indexOf(st.missType) < 0) st.missType = opts[0];
    if (opts.length > 1) p.appendChild(field('缺哪張卡', chips(opts.map(function (o) { return LBL[o]; }), LBL[st.missType], function (v) {
      st.missType = Object.keys(LBL).filter(function (k) { return LBL[k] === v; })[0]; render(); })));
    else p.appendChild(field('缺哪張卡', h('div', { class: 'rq-fixed', text: LBL[st.missType] + '（系統查到的）' })));
    var mv = st.mv = st.mv && st.mv.k === st.missDate + st.missType ? st.mv : { k: st.missDate + st.missType, start: '', end: '', reason: '', other: '' };
    if (st.missType !== 'out') { var a = timePick(mv.start, 1, function (v) { mv.start = v; }); p.appendChild(field('實際上班時間', a)); }
    if (st.missType !== 'in') { var b = timePick(mv.end, 1, function (v) { mv.end = v; }); p.appendChild(field('實際下班時間', b)); }
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
    p.appendChild(h('div', { class: 'rq-note', text: '補登後當天仍算一次忘刷卡（全勤規則不變）。' }));
  }

  /* 我的申請 */
  function renderMine(p) {
    var list = (st.info && st.info.requests) || [];
    p.appendChild(h('div', { class: 'rq-muted', text: '最近 60 天' }));
    if (!list.length) { p.appendChild(h('div', { class: 'rq-empty', text: '還沒有任何申請' })); return; }
    list.forEach(function (r) {
      var s = STATUS[r.status] || [r.status, 'off'];
      var title = r.kind === 'leave' ? r.leave_type + ' ' + r.hours + ' 小時'
                : r.kind === 'ot' ? '加班 ' + r.hours + ' 小時' + (r.comp === 'comp' ? '（換補休）' : '')
                : r.kind === 'trip' ? '出差 ' + r.hours + ' 小時'
                : '忘打卡・補' + (r.miss_type === 'both' ? '上下班卡' : r.miss_type === 'in' ? '上班卡 ' + r.start : '下班卡 ' + r.end);
      var sub = md(r.date) + (r.start && r.kind !== 'miss' ? ' ' + r.start + '–' + r.end : (r.kind === 'leave' || r.kind === 'trip') ? ' 整天' : '')
        + (r.reason ? '・' + r.reason : '');
      var item = h('div', { class: 'rq-item' }, [
        h('div', { class: 'rq-t' }, [h('span', { text: title }), h('span', { class: 'rq-pill ' + s[1], text: s[0] })]),
        h('div', { class: 'rq-s', text: sub }),
      ]);
      if (r.status === 'rejected' && r.reject_reason) item.appendChild(h('div', { class: 'rq-s', text: '主管：' + r.reject_reason }));
      if (r.status === 'approved') item.appendChild(h('div', { class: 'rq-s', text: r.decided_by + ' 核准' }));
      if (r.status === 'voided') item.appendChild(h('div', { class: 'rq-s', text: r.voided_by + ' 作廢' + (r.void_reason ? '：' + r.void_reason : '') }));
      if (r.status === 'pending' && r.kind === 'leave' && (r.need_proof || r.proof_required)) item.appendChild(proofBox(r));
      if (r.status === 'pending') {
        var c = h('button', { type: 'button', class: 'rq-link', text: '取消這筆申請', on: { click: function () {
          if (!confirm('確定要取消這筆申請？')) return;
          c.disabled = true;
          E.post(E.storeApi(storeDef()), { action: 'req_cancel', id_token: liff.getIDToken(), id: r.id }).then(function (x) {
            if (x && x.ok) return loadInfo().then(render);
            c.disabled = false; alert((x && x.message) || '取消沒有成功，請再試一次');
          }, function () { c.disabled = false; alert('連線失敗，請再試一次'); });
        } } });
        item.appendChild(c);
      }
      p.appendChild(item);
    });
  }

  /* 證明文件（2026-10-10 Eason：病假、婚假、喪假、產假相關一定要附；可先送出、核准前補附）。清單由各店 req_info 的 proof_types 給。 */
  function proofType(t) { return !!t && ((st.info && st.info.proof_types) || []).indexOf(t) >= 0; }
  function proofBox(r) {
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
        return E.post(E.storeApi(storeDef()), { action: 'req_attach', id_token: liff.getIDToken(), id: r.id, attach_id: aid });
      }).then(function (x) {
        st.busy = false; btn.disabled = false;
        if (x && x.ok) return loadInfo().then(function () { render(); $root.insertBefore(msgBox('✓ 證明已補上，等值班主管審核', 'ok'), $root.children[2]); });
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
    var btn = h('button', { type: 'button', class: 'primary', text: '送出申請' });
    btn.addEventListener('click', function () {
      if (st.busy) return;
      st.busy = true; btn.disabled = true; out.innerHTML = ''; out.appendChild(h('div', { class: 'rq-muted', text: '送出中…' }));
      build().then(function (body) {
        body.action = 'req_submit'; body.id_token = liff.getIDToken();
        return E.post(E.storeApi(storeDef()), body);
      }).then(function (r) {
        st.busy = false; btn.disabled = false; out.innerHTML = '';
        if (r && r.error === 'invalid_id_token') { liff.login(); return; }
        if (!r || !r.ok) { out.appendChild(msgBox((r && r.message) || '送出沒有成功，請再試一次', 'err')); return; }
        reset();
        tellChat('申請已送出：' + r.summary);
        return loadInfo().then(function () { st.tab = 'mine'; render(); $root.insertBefore(msgBox('✓ 已送出：' + r.summary + '\n等值班主管審核', 'ok'), $root.children[2]); });
      }, function (e) {
        st.busy = false; btn.disabled = false; out.innerHTML = '';
        out.appendChild(msgBox(e && e.message && !/fetch|network|abort/i.test(e.message) ? e.message : '連線失敗：不確定有沒有送出，請先看「我的申請」再決定要不要重送', 'err'));
      });
    });
    return btn;
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
