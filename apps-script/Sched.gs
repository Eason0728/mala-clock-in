/* ══ 出勤班表（2026-10-10，規格在 private repo mala-clock-schedule docs/spec.md）══
 * LINE 選單「出勤班表」→ LIFF clock-line.html?view=sched → line_hub_sched（這裡）。
 * 班表正本＝排班系統「月曆版」（eason0728.github.io/mala-schedule）的 GitHub Gist，公開 raw 網址免權杖。
 * 規則（Eason 2026-10-10 定）：只看光復、只看自己、本月＋上個月、排班系統「鎖定」的月份才算發布、離職就看不到。
 * ⚠ Gist 裡有薪資、電話、生日：這裡只取班表需要的欄位，回應只有這位同仁自己的日期／班別／時段／時數。
 * ⚠ 四週變形版（mala-schedule-4w）是另一顆 Gist，這裡不讀。 */
var SCHED_GIST_URL = 'https://gist.githubusercontent.com/Eason0728/1f7ecf0be418990e24d7b2351572e4aa/raw/mala-schedule.json';
var SCHED_CACHE_KEY = 'sched:v1';
var SCHED_CACHE_SEC = 120;
var SCHED_STORE_CODE = '';   // 只接光復（lineHubStores_ 裡光復的 code 是空字串）

/* 排班系統 index.html 的 DEFAULT_SHIFTS（2026-10-10 抄自 mala-schedule 第 435 行起，只留 name／time／hours）。
   getShifts() 是「預設 ＋ mala_shifts 覆蓋 − mala_hidden_shifts」，schedShifts_ 照同一套。 */
var SCHED_DEFAULT_SHIFTS = {
  A:  { name: 'A班', time: '15:00～23:30', hours: 8.5 },
  B:  { name: 'B班', time: '16:00～23:30', hours: 7.5 },
  C:  { name: 'C班', time: '17:00～22:30', hours: 5.5 },
  C2: { name: 'C2班', time: '17:30～23:30', hours: 6.0 },
  D:  { name: 'D班', time: '18:00～22:30', hours: 4.5 },
  D1: { name: 'D1班', time: '18:30～22:30', hours: 4.0 },
  E:  { name: 'E班', time: '09:00～17:30', hours: 8.5 },
  F:  { name: 'F班', time: '11:00～14:00\n17:30～22:30', hours: 8.0 },
  H1: { name: 'H1班', time: '11:00～14:00\n17:00～22:00', hours: 8.0 },
  '公休': { name: '公休', time: '－', hours: 0 },
  '休': { name: '休假', time: '－', hours: 0 },
  '特': { name: '特休', time: '特休假', hours: 0 },
  '指': { name: '指定休', time: '指定休假', hours: 0 },
  '國': { name: '國定假日', time: '國定假日', hours: 0 }
};

/** Gist 的值可能是物件，也可能是 JSON 字串（排班系統 buildSnapshot 存物件；保險起見兩種都接） */
function schedVal_(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}
function schedPad_(hm) {
  var p = String(hm).split(':');
  return ('0' + parseInt(p[0], 10)).slice(-2) + ':' + p[1];
}
/** 排班系統 hasClockTime：有沒有「時鐘時間」決定是上班班別還是休假類 */
function schedHasClock_(t) { return /\d{1,2}[:：]?\d{2}/.test(String(t || '')); }
/** 照排班系統 fmtShiftTime 解析：統一波浪號、去換行，抓 H:MM～H:MM；抓不到再抓 HMM～HMM 補冒號。
 *  回 [["HH:MM","HH:MM"], …]；兩段班連在一起沒分隔（"11:00～14:0017:30～22:30"）也抓得到。 */
function schedParseTime_(t) {
  if (!t) return [];
  var s = String(t).replace(/[~～]/g, '～').replace(/\n/g, '');
  var ranges = s.match(/\d{1,2}:\d{2}～\d{1,2}:\d{2}/g);
  if (!ranges) {
    var raw = s.match(/\d{3,4}～\d{3,4}/g);
    if (raw) ranges = raw.map(function (r) { return r.replace(/(\d{1,2})(\d{2})(?=$|～)/g, '$1:$2'); });
  }
  return (ranges || []).map(function (r) {
    var ab = r.split('～');
    return [schedPad_(ab[0]), schedPad_(ab[1])];
  });
}
/** 班別表＝預設 ＋ mala_shifts 覆蓋 − mala_hidden_shifts（與排班系統 getShifts 相同） */
function schedShifts_(snap) {
  var out = {}, k;
  for (k in SCHED_DEFAULT_SHIFTS) out[k] = SCHED_DEFAULT_SHIFTS[k];
  var custom = schedVal_(snap.mala_shifts) || {};
  for (k in custom) {
    var c = custom[k] || {};
    out[k] = { name: String(c.name || k), time: c.time === undefined ? '' : String(c.time), hours: Number(c.hours) || 0 };
  }
  (schedVal_(snap.mala_hidden_shifts) || []).forEach(function (c) { delete out[c]; });
  return out;
}
function schedYm_(y, m) { return y + '-' + ('0' + m).slice(-2); }
function schedPrev_(y, m) { return m === 1 ? { y: y - 1, m: 12 } : { y: y, m: m - 1 }; }
/** 只留班表要用的欄位（薪資、電話、生日一律不帶出這支函式）。months＝[{y,m}, …] */
function schedSubset_(snap, months) {
  var emps = {};
  (schedVal_(snap.mala_employees) || []).forEach(function (e) { if (e && e.id) emps[String(e.id)] = String(e.name || ''); });
  var sch = {};
  months.forEach(function (x) {
    var v = schedVal_(snap['mala_sch_' + x.y + '_' + x.m]);
    if (v && typeof v === 'object') sch[x.y + '_' + x.m] = v;
  });
  var locks = schedVal_(snap.mala_locks);
  return { locks: Array.isArray(locks) ? locks.map(String) : [], emps: emps, shifts: schedShifts_(snap), sch: sch };
}
function schedDayOf_(sub, code) {
  code = String(code || '');
  if (!code) return { code: '', label: '', segs: [], hours: 0, work: false };
  var sh = sub.shifts[code];
  if (!sh) return { code: code, label: code, segs: [], hours: 0, work: false };
  var segs = schedParseTime_(sh.time), work = schedHasClock_(sh.time);
  var d = { code: code, label: String(sh.name || code), segs: segs, hours: work ? (Number(sh.hours) || 0) : 0, work: work };
  if (work && !segs.length) d.time_unknown = true;
  return d;
}
/** 某人某月的月曆＋摘要＋下一個班。today＝{date:'yyyy-MM-dd', hm:'HH:mm'}；看的不是本月時 next 一律 null */
function schedMonth_(sub, schedId, y, m, today) {
  var row = (sub.sch[y + '_' + m] || {})[schedId] || {};
  var last = new Date(y, m, 0).getDate(), days = [], wd = 0, od = 0, hrs = 0;
  for (var d = 1; d <= last; d++) {
    var x = schedDayOf_(sub, row[String(d)]);
    x.d = d; days.push(x);
    if (x.work) { wd++; hrs += x.hours; } else if (x.code) od++;
  }
  var next = null, ym = schedYm_(y, m);
  if (today && String(today.date).slice(0, 7) === ym) {
    var td = parseInt(String(today.date).slice(8, 10), 10);
    for (var i = td - 1; i < days.length && !next; i++) {
      var day = days[i];
      if (!day.work) continue;
      if (day.d === td && day.segs.length) {
        var lastSeg = day.segs[day.segs.length - 1];
        var overnight = lastSeg[1] <= lastSeg[0];
        if (!overnight && lastSeg[1] <= today.hm) continue;   // 今天這班已經下班了
      }
      next = { date: ym + '-' + ('0' + day.d).slice(-2), label: day.label, segs: day.segs, hours: day.hours };
      if (day.time_unknown) next.time_unknown = true;
    }
  }
  return { days: days, summary: { work_days: wd, off_days: od, hours: Math.round(hrs * 100) / 100 }, next: next };
}
/** 打卡同仁 → 排班系統的人。對照表（指令碼屬性 SCHED_NAME_MAP，{emp_id: 排班id}）優先，否則同名且剛好一人 */
function schedMatch_(sub, empId, name, map) {
  var id = map && map[String(empId)];
  if (id && sub.emps[String(id)] !== undefined) return String(id);
  var want = lineHubNormName_(name), hit = [];
  Object.keys(sub.emps).forEach(function (k) { if (want && lineHubNormName_(sub.emps[k]) === want) hit.push(k); });
  return hit.length === 1 ? hit[0] : null;
}
function schedNow_() {
  var d = new Date();
  return { date: Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd'), hm: Utilities.formatDate(d, 'Asia/Taipei', 'HH:mm') };
}
/** 讀 Gist → 子集（本月＋上個月），快取 SCHED_CACHE_SEC 秒。讀不到丟例外 */
function schedLoad_(today) {
  var cache = CacheService.getScriptCache(), hit = cache.get(SCHED_CACHE_KEY);
  var y = parseInt(today.date.slice(0, 4), 10), m = parseInt(today.date.slice(5, 7), 10), p = schedPrev_(y, m);
  if (hit) {
    try { var c = JSON.parse(hit); if (c && c.for === schedYm_(y, m)) return c; } catch (e) { /* 壞掉就重讀 */ }
  }
  var snap = null, err = null;
  for (var t = 0; t < 2 && !snap; t++) {
    try {
      var r = UrlFetchApp.fetch(SCHED_GIST_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) { err = 'http_' + r.getResponseCode(); continue; }
      var j = JSON.parse(r.getContentText());
      if (j && typeof j === 'object' && j.mala_employees !== undefined) snap = j; else err = 'bad_json';
    } catch (e) { err = String(e); }
  }
  if (!snap) throw new Error('sched_unreadable:' + err);
  var sub = schedSubset_(snap, [p, { y: y, m: m }]);
  sub.for = schedYm_(y, m);
  var s = JSON.stringify(sub);
  if (s.length < 90000) { try { cache.put(SCHED_CACHE_KEY, s, SCHED_CACHE_SEC); } catch (e) { /* 快取失敗照樣回應 */ } }
  return sub;
}
function schedNameMap_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('SCHED_NAME_MAP') || '{}') || {}; }
  catch (e) { return {}; }
}

/**
 * {action:'line_hub_sched', id_token, ym?} → 規格 §3.1
 *   ok:true＋status ready／not_locked／not_bound／not_matched／no_schedule；
 *   ok:false＋error invalid_id_token／too_many／bad_month／sched_unreadable
 */
function handleLineHubSched_(body) {
  var userId = verifyLineIdToken_(body.id_token);
  if (!userId) return { ok: false, error: 'invalid_id_token' };
  if (lineHubThrottled_('sch', userId, 20, 60)) return { ok: false, error: 'too_many' };
  var today = schedNow_();
  var cy = parseInt(today.date.slice(0, 4), 10), cm = parseInt(today.date.slice(5, 7), 10), pv = schedPrev_(cy, cm);
  var months = [schedYm_(pv.y, pv.m), schedYm_(cy, cm)];
  var ym = body.ym ? String(body.ym) : months[1];
  if (months.indexOf(ym) < 0) return { ok: false, error: 'bad_month' };
  var y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10);
  var base = { ok: true, ym: ym, months: months, today: today.date };
  var me = lineHubMine_(userId, null, false).filter(function (x) { return String(x.st.code) === SCHED_STORE_CODE; })[0];
  if (!me) { base.status = 'not_bound'; return base; }
  base.name = String(me.row.name);
  var sub;
  try { sub = schedLoad_(today); } catch (e) { return { ok: false, error: 'sched_unreadable' }; }
  if (sub.locks.indexOf(y + '_' + m) < 0) { base.status = 'not_locked'; return base; }
  var sid = schedMatch_(sub, me.row.emp_id, me.row.name, schedNameMap_());
  if (!sid) { base.status = 'not_matched'; return base; }
  var row = (sub.sch[y + '_' + m] || {})[sid];
  if (!row || !Object.keys(row).length) { base.status = 'no_schedule'; return base; }
  var r = schedMonth_(sub, sid, y, m, today);
  base.status = 'ready'; base.days = r.days; base.summary = r.summary; base.next = r.next;
  return base;
}
