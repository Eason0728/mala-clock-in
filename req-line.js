/* 加班請假／忘打卡申請頁（2026-10-09，規格 mala-clock-liff docs/requests-spec.md）
 * 由 clock-line.html 載入：同一個 LIFF，網址帶 ?view=req&tab=leave|ot|miss|mine 就顯示這頁，不顯示打卡。
 * 開頁資料：光復 line_hub_req_init（綁了哪些店、假別、額度）＋那家店 req_info（我的申請、某天缺哪張卡）。
 * 送出：那家店 req_submit；附件先傳光復 line_hub_attach_put 拿 ID。結果不推播，回「我的申請」看。 */
(function () {
  'use strict';
  var E, $root, st = { init: null, store: null, info: null, tab: 'leave', busy: false };
  var TABS = [['leave', '請假'], ['ot', '加班'], ['miss', '忘打卡'], ['mine', '我的申請']];
  var MISS_REASONS = ['忘記按', '手機沒電', '定位抓不到被擋', '按錯上下班', '其他'];
  var STATUS = { pending: ['審核中', 'wait'], approved: ['已核准', 'ok'], rejected: ['已退回', 'no'], cancelled: ['已取消', 'off'] };

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
  function msgBox(text, cls) { return h('div', { class: 'rq-box ' + (cls || ''), text: text }); }

  /* ── 開頁 ── */
  function open(opts) {
    E = window.ClockLineEnv;
    $root = document.getElementById('reqView');
    st.tab = TABS.some(function (t) { return t[0] === opts.tab; }) ? opts.tab : 'leave';
    st.missDate = opts.date || ''; st.missType = opts.miss || '';
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
      st.store = r.stores[0];
      return loadInfo().then(render);
    }, function () { $root.innerHTML = ''; $root.appendChild(msgBox('連線失敗，請檢查網路後重新打開。', 'err')); });
  }
  function storeDef() { return E.STORES.filter(function (s) { return s.code === st.store.code; })[0]; }
  function loadInfo(date) {
    var body = { action: 'req_info', id_token: liff.getIDToken() };
    if (date) body.date = date;
    return E.readRetry(E.storeApi(storeDef()), body).then(function (r) {
      if (r && r.ok) { if (!date) st.info = r; return r; }
      throw new Error((r && r.error) || 'failed');
    });
  }

  /* ── 畫面 ── */
  function render() {
    $root.innerHTML = '';
    var head = h('div', { class: 'rq-head' }, [h('b', { text: st.store.emp_name }), ' ']);
    if (st.init.stores.length > 1) {
      var sel = h('select', { class: 'rq-store', on: { change: function () {
        st.store = st.init.stores[+sel.value]; st.info = null;
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
    ({ leave: renderLeave, ot: renderOt, miss: renderMiss, mine: renderMine })[st.tab](panel);
  }

  function chips(list, value, onPick) {
    var wrap = h('div', { class: 'rq-chips' });
    list.forEach(function (v) {
      wrap.appendChild(h('button', { type: 'button', class: 'rq-chip' + (v === value ? ' on' : ''), text: v,
                                     on: { click: function () { onPick(v); } } }));
    });
    return wrap;
  }
  function quotaText(name) {
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
    p.appendChild(field('假別', typeBox, q ? [h('div', { class: 'rq-quota', text: lv.type + '：' + q })] : []));
    var modeBox = h('div', {}, [chips(['整天', '只請一段'], lv.mode === 'day' ? '整天' : '只請一段', function (v) { lv.mode = v === '整天' ? 'day' : 'span'; render(); })]);
    if (lv.mode === 'day') {
      var hr = h('input', { type: 'number', min: '0.5', max: '24', step: '0.5', value: lv.hours, class: 'rq-hours', on: { input: function () { lv.hours = hr.value; } } });
      modeBox.appendChild(h('div', { class: 'rq-row' }, ['共 ', hr, ' 小時']));
    } else {
      var s1 = h('input', { type: 'time', value: lv.start, on: { change: function () { lv.start = s1.value; upd(); } } });
      var e1 = h('input', { type: 'time', value: lv.end, on: { change: function () { lv.end = e1.value; upd(); } } });
      var tot = h('span', { class: 'rq-muted' });
      var upd = function () { var x = spanHours(lv.start, lv.end); tot.textContent = x ? '共 ' + x + ' 小時' : ''; };
      modeBox.appendChild(h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot])); upd();
    }
    p.appendChild(field('時段', modeBox));
    var rs = h('input', { type: 'text', maxlength: '100', value: lv.reason, placeholder: '例如：家裡有事', on: { input: function () { lv.reason = rs.value; } } });
    p.appendChild(field('原因（選填）', rs));
    var fi = h('input', { type: 'file', accept: 'image/*,application/pdf', on: { change: function () { lv.file = fi.files[0] || null; } } });
    p.appendChild(field('附件（選填，病假證明、訃聞等）', fi, [h('div', { class: 'rq-muted', text: '照片或 PDF，只有值班主管看得到' })]));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      if (!lv.type) return Promise.reject(new Error('請選假別'));
      var body = { kind: 'leave', date: lv.date, leave_type: lv.type, reason: lv.reason };
      if (lv.mode === 'day') body.hours = lv.hours; else { body.start = lv.start; body.end = lv.end; }
      return withAttach(lv.file).then(function (aid) { if (aid) body.attach_id = aid; return body; });
    }, function () { lv = { date: '', type: '', mode: 'day', hours: '8', start: '', end: '', reason: '', file: null }; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '送出後由值班主管審核，結果在「我的申請」，下次打卡時也會告訴你。' }));
  }

  /* 加班（不分事前事後） */
  var ot = { date: '', start: '', end: '', reason: '' };
  function renderOt(p) {
    if (!ot.date) ot.date = taipeiToday(0);
    var dateIn = h('input', { type: 'date', value: ot.date, on: { change: function () { ot.date = dateIn.value; } } });
    p.appendChild(field('日期', dateIn));
    var s1 = h('input', { type: 'time', value: ot.start, on: { change: function () { ot.start = s1.value; upd(); } } });
    var e1 = h('input', { type: 'time', value: ot.end, on: { change: function () { ot.end = e1.value; upd(); } } });
    var tot = h('span', { class: 'rq-muted' });
    var upd = function () { var x = spanHours(ot.start, ot.end); tot.textContent = x ? '共 ' + x + ' 小時' : ''; }; upd();
    p.appendChild(field('加班時段', h('div', { class: 'rq-row' }, [s1, ' – ', e1, ' ', tot])));
    var rs = h('input', { type: 'text', maxlength: '100', value: ot.reason, placeholder: '例如：週六晚上外送訂單多', on: { input: function () { ot.reason = rs.value; } } });
    p.appendChild(field('原因（必填）', rs));
    var out = h('div', {});
    p.appendChild(submitBtn(out, function () {
      return Promise.resolve({ kind: 'ot', date: ot.date, start: ot.start, end: ot.end, reason: ot.reason });
    }, function () { ot = { date: '', start: '', end: '', reason: '' }; }));
    p.appendChild(out);
    p.appendChild(h('div', { class: 'rq-note', text: '已經加過班或還沒加班都可以申請。實際時數以主管當天核定為準。' }));
  }

  /* 忘打卡 */
  function renderMiss(p) {
    var days = [];
    for (var i = 0; i <= 7; i++) days.push(taipeiToday(-i));
    if (days.indexOf(st.missDate) < 0) st.missDate = '';
    var sel = h('select', { class: 'rq-date', on: { change: function () { st.missDate = sel.value; st.missType = ''; st.day = null; render(); } } },
      [h('option', { value: '', text: '選日期（只能選 7 天內）' })].concat(days.map(function (d) { return h('option', { value: d, text: md(d), selected: d === st.missDate }); })));
    p.appendChild(field('日期', sel));
    if (!st.missDate) return;
    if (!st.day || st.day.date !== st.missDate) {
      var wait = h('div', { class: 'rq-muted', text: '查這天的打卡紀錄…' });
      p.appendChild(wait);
      loadInfo(st.missDate).then(function (r) { st.day = r.day; render(); }, function () { wait.textContent = '查不到這天的紀錄，請稍後再試'; });
      return;
    }
    var day = st.day, rec = day.punches.length ? day.punches.map(function (x) {
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
    if (st.missType !== 'out') { var a = h('input', { type: 'time', value: mv.start, on: { change: function () { mv.start = a.value; } } }); p.appendChild(field('實際上班時間', a)); }
    if (st.missType !== 'in') { var b = h('input', { type: 'time', value: mv.end, on: { change: function () { mv.end = b.value; } } }); p.appendChild(field('實際下班時間', b)); }
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
    }, function () { st.mv = null; st.day = null; st.missDate = ''; }));
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
                : r.kind === 'ot' ? '加班 ' + r.hours + ' 小時'
                : '忘打卡・補' + (r.miss_type === 'both' ? '上下班卡' : r.miss_type === 'in' ? '上班卡 ' + r.start : '下班卡 ' + r.end);
      var sub = md(r.date) + (r.start && r.kind !== 'miss' ? ' ' + r.start + '–' + r.end : r.kind === 'leave' ? ' 整天' : '')
        + (r.reason ? '・' + r.reason : '');
      var item = h('div', { class: 'rq-item' }, [
        h('div', { class: 'rq-t' }, [h('span', { text: title }), h('span', { class: 'rq-pill ' + s[1], text: s[0] })]),
        h('div', { class: 'rq-s', text: sub }),
      ]);
      if (r.status === 'rejected' && r.reject_reason) item.appendChild(h('div', { class: 'rq-s', text: '主管：' + r.reject_reason }));
      if (r.status === 'approved') item.appendChild(h('div', { class: 'rq-s', text: r.decided_by + ' 核准' }));
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
