/* ══ 出勤班表（2026-10-10，規格在 private repo mala-clock-schedule docs/spec.md）══
 * LINE 選單「出勤班表」→ LIFF clock-line.html?view=sched → line_hub_sched（這裡）。
 * 班表來源＝營運系統自動排班發布的班表（SchedPub.gs、sched_pub 分頁），SCHED_STORE_FROM（預設 2026-11-01）當天起。
 * 2026-11-10 Eason：排班月曆版下架、它的班表 Gist 已刪 → 接手日之前的日子不再讀任何班表：
 *   整個月都在接手日之前 → status 'archived'（前端顯示「已不提供查詢」）；同一個月接手日之前的日子留白。
 *   月曆版資料備份在 Eason 本機私密資料夾，不在這裡。 */
var SCHED_STORE_CODE = '';   // 光復（lineHubStores_ 裡光復的 code 是空字串）；訂貨小幫手 sched_day_roster 只回這家

function schedYm_(y, m) { return y + '-' + ('0' + m).slice(-2); }
function schedPrev_(y, m) { return m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 }; }
function schedNow_() {
  var d = new Date();
  return { date: Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd'), hm: Utilities.formatDate(d, 'Asia/Taipei', 'HH:mm') };
}
/** 自動排班接手日（指令碼屬性 SCHED_STORE_FROM，預設 2026-11-01）：從它開始讀營運系統發布的班表（SchedPub.gs）；比它早的日子沒有班表 */
function schedStoreFrom_() {
  var v = '';
  try { v = String(PropertiesService.getScriptProperties().getProperty('SCHED_STORE_FROM') || ''); } catch (e) { v = ''; }
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '2026-11-01';
}
function schedNext_(y, m) { return m === 12 ? { y: y + 1, m: 1 } : { y: y, m: m + 1 }; }
/** 摘要與下一個班（與 schedMonth_ 同一套規則，給「營運系統發布」的月份用） */
function schedSummarize_(days, ym, today) {
  var wd = 0, od = 0, hrs = 0;
  days.forEach(function (x) { if (x.work) { wd++; hrs += x.hours; } if (x.rest) od++; });
  var next = null;
  if (today && String(today.date).slice(0, 7) === ym) {
    var td = parseInt(String(today.date).slice(8, 10), 10);
    for (var i = td - 1; i < days.length && !next; i++) {
      var day = days[i];
      if (!day.work || !day.segs.length) continue;
      if (day.d === td) {
        var lastSeg = day.segs[day.segs.length - 1];
        if (!(lastSeg[1] <= lastSeg[0]) && lastSeg[1] <= today.hm) continue;
      }
      next = { date: ym + '-' + ('0' + day.d).slice(-2), label: day.label, segs: day.segs, hours: day.hours };
      if (day.station) next.station = day.station;
    }
  }
  return { summary: { work_days: wd, off_days: od, hours: Math.round(hrs * 100) / 100 }, next: next };
}

/**
 * {action:'line_hub_sched', id_token, ym?} → 規格 §3.1（2026-10-11 起月份＝上個月、本月、下個月）
 *   ok:true＋status ready／not_locked／not_bound／not_matched／no_schedule；
 *   ok:false＋error invalid_id_token／too_many／bad_month／sched_unreadable
 *   月份整個在 SCHED_STORE_FROM 之前 → status 'archived'（月曆版 2026-11-10 下架）；
 *   月份碰到 SCHED_STORE_FROM 之後 → 那些日子讀營運系統發布的班表（每家有 LINE 打卡的店都接，用 emp_id 對人）。
 */
function handleLineHubSched_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('sch', userId, 20, 60)) return { ok: false, error: 'too_many' };
  var today = schedNow_();
  var cy = parseInt(today.date.slice(0, 4), 10), cm = parseInt(today.date.slice(5, 7), 10), pv = schedPrev_(cy, cm), nx = schedNext_(cy, cm);
  var months = [schedYm_(pv.y, pv.m), schedYm_(cy, cm), schedYm_(nx.y, nx.m)];
  var ym = body.ym ? String(body.ym) : months[1];
  if (months.indexOf(ym) < 0) return { ok: false, error: 'bad_month' };
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  var base = { ok: true, ym: ym, months: months, today: today.date };
  var from = schedStoreFrom_();
  var last = new Date(y, m, 0).getDate();
  var monthEnd = ym + '-' + ('0' + last).slice(-2);
  var info = {};
  var all = lineHubMine_(userId, info, false);
  if (!all.length && info.unreadable) return { ok: false, error: 'sched_unreadable' };   // 名冊讀不到≠沒綁（審查 P1#4）
  var me = all.filter(function (x) { return String(x.st.code) === SCHED_STORE_CODE; })[0];

  if (monthEnd < from) { base.status = 'archived'; return base; }   // 月曆版已下架（2026-11-10）

  // ── 月份碰到接手日之後：接手日以後讀營運系統發布的班表；同一個月接手日之前的日子留白 ──
  if (!all.length) { base.status = 'not_bound'; return base; }
  base.name = String((me || all[0]).row.name);
  var dates = [];
  for (var d = 1; d <= last; d++) dates.push(ym + '-' + ('0' + d).slice(-2));
  var pubDays;
  try { pubDays = schedPubDaysFor_(schedPubLoad_(), all, dates.filter(function (x) { return x >= from; })); }
  catch (e) { return { ok: false, error: 'sched_unreadable' }; }
  var any = false;
  var days = dates.map(function (date, i) {
    var x = date < from ? null : pubDays[date];
    if (x && (x.code || x.label)) any = true;
    // 接手日以後、那一期還沒發布：明講「尚未發布」，不要留白讓人誤以為是休假（2026-10-11 Fable 審查）
    x = x ? JSON.parse(JSON.stringify(x)) : (date >= from ? { code: '', label: '尚未發布', segs: [], hours: 0, work: false, rest: false, pending: true }
                                                          : { code: '', label: '', segs: [], hours: 0, work: false, rest: false });
    x.d = i + 1;
    return x;
  });
  if (!any) {
    // （2026-11-04 夜間 QA）那一期營運系統已發布、但本人不在 rows（新進／沒排班）或 28 格全空 → no_schedule「沒有你的班」，
    //  不要回 not_locked「還在排」誤導同仁一直等；真的還沒發布才是 not_locked。
    var published = false;
    try {
      var pubAll = schedPubLoad_();
      published = dates.some(function (dt) {
        var pp = (from <= dt) ? schedPubPeriodOf_(dt) : null;
        return !!pp && all.some(function (x) { return !!pubAll[String(x.st.code) + '|' + pp]; });
      });
    } catch (e2) { published = false; }
    base.status = published ? 'no_schedule' : 'not_locked';
    return base;
  }
  var s = schedSummarize_(days, ym, today);
  base.status = 'ready'; base.days = days; base.summary = s.summary; base.next = s.next;
  return base;
}

/* ══ 訂貨小幫手讀光復班表（2026-10-13）══
 * 訂貨小幫手（line-oa-scheduler）的 {{今日班表}}／{{明日班表}} 要知道某一天光復誰上班。
 * {action:'sched_day_roster', key, date:'yyyy-MM-dd'}
 *   （2026-11-10 起接手日之前的日子也走這條：沒有發布＝published:false；月曆版 Gist 已刪）
 *   → {ok:true, date, from, source:'store', published, people:[{name, label, segs:[["HH:MM","HH:MM"]]}]}
 *          published:false＝那一期營運系統還沒鎖定發布。people 只列當天上班的人，照發布資料的順序。
 * 金鑰＝指令碼屬性 SCHED_READ_KEY（沒設就一律 unauthorized；跟發布用的 SCHED_SVC_KEY 分開，這把只能讀）。
 * 只回光復（SCHED_STORE_CODE）、只回姓名與時段，不回員工編號、工時、請假別。 */
function handleSchedDayRoster_(b) {
  // （2026-11-04 夜間 QA）全站節流改到驗完金鑰之後才計數：沒帶／帶錯金鑰的人狂打，不會把持有金鑰的訂貨小幫手擋成 too_many。
  //  驗不過金鑰的請求另用一個 60/分的節流（鍵 'sdr_bad'，跟正常的 'sdr' 分開）；正常請求全站上限 60 → 300。
  var key = PropertiesService.getScriptProperties().getProperty('SCHED_READ_KEY');
  if (!key || typeof b.key !== 'string' || b.key !== key) {
    if (lineHubThrottled_('sdr_bad', '*all*', 60, 60)) return { ok: false, error: 'too_many' };
    return { ok: false, error: 'unauthorized' };
  }
  if (lineHubThrottled_('sdr', '*all*', 300, 60)) return { ok: false, error: 'too_many' };
  var date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  var from = schedStoreFrom_();
  var p = schedPubPeriodOf_(date);
  var data = p ? schedPubLoad_()[SCHED_STORE_CODE + '|' + p] : null;
  if (!data) return { ok: true, date: date, from: from, source: 'store', published: false, people: [] };
  var idx = schedPubIndex_(date), people = [];
  (data.rows || []).forEach(function (r) {
    var day = schedPubDay_((r.cells || [])[idx], data.shifts || []);
    if (day && day.work) people.push({ name: String(r.name || ''), label: day.label, segs: day.segs });
  });
  return { ok: true, date: date, from: from, source: 'store', published: true, people: people };
}
