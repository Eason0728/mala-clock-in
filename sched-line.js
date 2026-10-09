/* 出勤班表頁（2026-10-10，規格在 private repo mala-clock-schedule docs/spec.md）
 * 由 clock-line.html 載入：網址帶 ?view=sched 就顯示這頁，不定位、不顯示打卡。
 * 資料：光復 line_hub_sched {id_token, ym}（只回這位同仁自己的班；班表來自排班系統月曆版，鎖定的月份才看得到）。
 * 兩個分頁：月曆（點某天看各段時間與合計）／本月摘要（排班天數、休假天數、排班時數、下一個班）。
 * 所有文字一律 textContent（班別名稱是店長手打的）。 */
(function () {
  'use strict';
  var E, $root, st = { ym: '', months: [], data: {}, tab: 'cal', sel: 0, busy: false };
  var WK = ['日', '一', '二', '三', '四', '五', '六'];
  var CN = ['一', '二', '三', '四', '五', '六'];
  var STATUS_TEXT = {
    not_locked: function (ym) { return mLabel(ym) + '的班表還在排，排好後就看得到。'; },
    not_bound: function () { return '你目前沒有光復店的班表。'; },
    not_matched: function () { return '你的班表還沒對上，請找店長確認。'; },
    no_schedule: function (ym) { return mLabel(ym) + '的班表沒有你的班。'; }
  };

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
  function mLabel(ym) { return parseInt(String(ym).slice(5, 7), 10) + ' 月'; }
  function yLabel(ym) { return String(ym).slice(0, 4) + ' 年 ' + mLabel(ym); }
  function dateOf(ym, d) { return ym + '-' + ('0' + d).slice(-2); }
  function wk(date) { return WK[new Date(date + 'T00:00:00').getDay()]; }
  function md(date) { return parseInt(date.slice(5, 7), 10) + '/' + parseInt(date.slice(8, 10), 10) + '（' + wk(date) + '）'; }
  function hrs(n) { return (Math.round(Number(n) * 100) / 100) + ' 小時'; }
  function segText(segs) { return segs.map(function (s) { return s[0] + '–' + s[1]; }).join('、'); }
  function box(text, cls) { return h('div', { class: 'sc-box ' + (cls || ''), text: text }); }

  /* ── 開頁 ── */
  function open() {
    E = window.ClockLineEnv;
    $root = document.getElementById('schedView');
    $root.hidden = false;
    load('');
  }
  function load(ym) {
    if (st.busy) return;
    if (ym && st.data[ym]) { st.ym = ym; st.sel = defaultSel(st.data[ym]); render(); return; }
    st.busy = true;
    $root.innerHTML = '';
    $root.appendChild(h('div', { class: 'sc-loading', text: '讀取中…' }));
    var body = { action: 'line_hub_sched', id_token: liff.getIDToken() };
    if (ym) body.ym = ym;
    E.readRetry(E.HUB_API, body).then(function (r) {
      st.busy = false;
      if (r && r.error === 'invalid_id_token') { liff.login(); return; }
      if (!r || !r.ok) { fail(r && r.error === 'too_many' ? '查太多次了，請過一分鐘再試。' : '班表暫時讀不到，請稍後再試。'); return; }
      st.months = r.months || [];
      st.ym = r.ym; st.data[r.ym] = r; st.sel = defaultSel(r);
      render();
    }, function () { st.busy = false; fail('連線不穩，班表沒有讀到。'); });
  }
  /** 看本月時預設選今天（下方直接顯示今天的班）；看上個月不預選 */
  function defaultSel(r) { return r && r.status === 'ready' && String(r.today).slice(0, 7) === r.ym ? parseInt(String(r.today).slice(8, 10), 10) : 0; }
  function fail(text) {
    $root.innerHTML = '';
    $root.appendChild(box(text, 'err'));
    $root.appendChild(h('button', { class: 'ghost', type: 'button', id: 'scReload', text: '重新整理',
      on: { click: function () { st.data = {}; load(st.ym); } } }));
  }

  /* ── 畫面 ── */
  function render() {
    var r = st.data[st.ym];
    $root.innerHTML = '';
    $root.appendChild(h('div', { class: 'sc-title' }, [h('b', { text: '📅 出勤班表' }), r.name ? h('span', { class: 'sc-who', text: r.name }) : null]));
    $root.appendChild(h('div', { class: 'rq-tabs' }, [['cal', '月曆'], ['sum', '本月摘要']].map(function (t) {
      return h('button', { type: 'button', class: st.tab === t[0] ? 'on' : '', 'data-tab': t[0], text: t[1],
        on: { click: function () { st.tab = t[0]; render(); } } });
    })));
    if (st.tab === 'sum') { renderSum(); return; }
    var i = st.months.indexOf(st.ym);
    $root.appendChild(h('div', { class: 'sc-mon' }, [
      h('button', { type: 'button', class: 'sc-nav', id: 'scPrev', 'aria-label': '上個月', text: '‹', disabled: i <= 0,
        on: { click: function () { load(st.months[i - 1]); } } }),
      h('b', { text: yLabel(st.ym) }),
      h('button', { type: 'button', class: 'sc-nav', id: 'scNext', 'aria-label': '下個月', text: '›', disabled: i < 0 || i >= st.months.length - 1,
        on: { click: function () { load(st.months[i + 1]); } } })
    ]));
    if (r.status !== 'ready') { $root.appendChild(box(STATUS_TEXT[r.status] ? STATUS_TEXT[r.status](r.ym) : '目前看不到班表。', 'info')); return; }
    $root.appendChild(calendar(r));
    $root.appendChild(detail(r));
  }
  function calendar(r) {
    var grid = h('div', { class: 'sc-cal' }, WK.map(function (w) { return h('div', { class: 'sc-wk', text: w }); }));
    var first = new Date(dateOf(r.ym, 1) + 'T00:00:00').getDay();
    for (var k = 0; k < first; k++) grid.appendChild(h('div', { class: 'sc-pad' }));
    r.days.forEach(function (d) {
      var date = dateOf(r.ym, d.d), wd = new Date(date + 'T00:00:00').getDay();
      var cls = 'sc-day' + (d.work ? ' work' : d.code ? ' off' : ' none') + (date === r.today ? ' today' : '') + (st.sel === d.d ? ' sel' : '')
        + (wd === 0 || wd === 6 ? ' wkend' : '');
      var kids = [h('span', { class: 'sc-d', text: String(d.d) })];
      if (d.work && d.segs.length) {
        kids.push(h('span', { class: 'sc-t', text: d.segs[0][0] }));
        kids.push(h('span', { class: 'sc-t', text: d.segs[d.segs.length - 1][1] }));
      } else if (d.work) kids.push(h('span', { class: 'sc-t', text: d.code }));
      else if (d.code) kids.push(h('span', { class: 'sc-o', text: d.code }));
      grid.appendChild(h('button', { type: 'button', class: cls, 'data-d': d.d,
        on: { click: function () { st.sel = d.d; render(); } } }, kids));
    });
    return grid;
  }
  function detail(r) {
    var d = st.sel ? r.days[st.sel - 1] : null;
    if (!d) return h('div', { class: 'sc-det sc-muted', id: 'scDet', text: '點某一天看當天的班。' });
    var date = dateOf(r.ym, d.d), rows = [h('b', { text: md(date) })];
    if (!d.code) rows.push(h('div', { class: 'sc-row' }, [h('span', { text: '這天沒有排班' })]));
    else if (!d.work) rows.push(h('div', { class: 'sc-row' }, [h('span', { text: d.label })]));
    else {
      rows.push(h('div', { class: 'sc-row' }, [h('span', { text: '班別' }), h('span', { text: d.label })]));
      if (!d.segs.length) rows.push(h('div', { class: 'sc-row' }, [h('span', { text: '時間' }), h('span', { text: '時間未設定，請問店長' })]));
      d.segs.forEach(function (s, i) {
        rows.push(h('div', { class: 'sc-row' }, [h('span', { text: d.segs.length > 1 ? '第' + CN[i] + '段' : '上班時間' }), h('span', { text: s[0] + '–' + s[1] })]));
      });
      rows.push(h('div', { class: 'sc-row sc-total' }, [h('span', { text: '合計' }), h('span', { text: hrs(d.hours) })]));
    }
    return h('div', { class: 'sc-det', id: 'scDet' }, rows);
  }
  function renderSum() {
    var r = st.data[st.ym];
    if (r.status !== 'ready') { $root.appendChild(box(STATUS_TEXT[r.status] ? STATUS_TEXT[r.status](r.ym) : '目前看不到班表。', 'info')); return; }
    var s = r.summary;
    $root.appendChild(h('div', { class: 'sc-sumt', text: mLabel(r.ym) }));
    $root.appendChild(h('div', { class: 'sc-sum' }, [
      [s.work_days, '排班天數'], [s.off_days, '休假天數'], [Math.round(s.hours * 100) / 100, '排班時數']
    ].map(function (x) { return h('div', {}, [h('b', { text: String(x[0]) }), h('small', { text: x[1] })]); })));
    var isCur = r.ym === st.months[st.months.length - 1];
    var nx = h('div', { class: 'sc-next', id: 'scNextShift' }, [h('b', { class: 'sc-nh', text: '下一個班' })]);
    if (!isCur) nx.appendChild(h('div', { class: 'sc-muted', text: '「下一個班」只看本月。' }));
    else if (!r.next) nx.appendChild(h('div', { class: 'sc-muted', text: '本月沒有接下來的班。' }));
    else {
      var rel = r.next.date === r.today ? '今天 ' : '';
      nx.appendChild(h('div', { class: 'sc-nd', text: rel + md(r.next.date) }));
      nx.appendChild(h('div', { class: 'sc-ns', text: r.next.label + '　' + (r.next.segs.length ? segText(r.next.segs) : '時間未設定') }));
    }
    $root.appendChild(nx);
    $root.appendChild(h('div', { class: 'rq-note', text: '班表由店長在排班系統排好、鎖定後才會顯示；有異動以店長通知為準。' }));
  }

  window.SchedLine = { open: open };
})();
