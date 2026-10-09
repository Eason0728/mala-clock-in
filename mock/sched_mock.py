"""出勤班表本機模擬（2026-10-10，與 apps-script/Sched.gs 的 line_hub_sched 同合約）。
mock_server.py 最後呼叫 register(globals()) 掛到光復（/api）的 LINE_HUB_ACTIONS。
假班表依今天日期產生（本月＋上個月），測試一～四對應 mock 名冊：
  測試一＝有班（含兩段班、沒冒號的班別、休假類、空白天）／測試二＝本月有班、上個月沒有（no_schedule）
  測試三＝排班系統有兩位同名（not_matched）／測試四＝排班系統沒有這個人（not_matched）
光復 mock 資料可加 "mock_sched": {"unlock": ["2026_10"], "fail": true} 控制鎖定與讀取失敗（e2e 用）。"""
import re
from datetime import date, datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
SHIFTS = {
    "A": {"name": "A班", "time": "15:00～23:30", "hours": 8.5},
    "C": {"name": "C班", "time": "17:00～22:30", "hours": 5.5},
    "E": {"name": "E班", "time": "09:00～17:30", "hours": 8.5},
    "F": {"name": "F班", "time": "11:00～14:0017:30～22:30", "hours": 8.0},   # 真資料的怪寫法：兩段相連
    "C1": {"name": "C1班", "time": "1700~2100", "hours": 4.0},              # 真資料的怪寫法：沒冒號
    "休": {"name": "休假", "time": "－", "hours": 0}, "特": {"name": "特休", "time": "特休假", "hours": 0},
    "國": {"name": "國定假日", "time": "國定假日", "hours": 0}, "事": {"name": "事假", "time": "", "hours": 0},
}
PATTERN = ["F", "C1", "休", "A", "E", "休", "C", "F", "特", "A", "", "E", "國", "事"]


def _prev(y, m):
    return (y - 1, 12) if m == 1 else (y, m - 1)


def _last_day(y, m):
    nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return (nxt - timedelta(days=1)).day


def _parse(t):
    if not t:
        return []
    s = re.sub(r"[~～]", "～", str(t)).replace("\n", "")
    rs = re.findall(r"\d{1,2}:\d{2}～\d{1,2}:\d{2}", s)
    if not rs:
        raw = re.findall(r"\d{3,4}～\d{3,4}", s)
        rs = [re.sub(r"(\d{1,2})(\d{2})(?=$|～)", r"\1:\2", r) for r in raw]
    pad = lambda hm: "%02d:%s" % (int(hm.split(":")[0]), hm.split(":")[1])
    return [[pad(a), pad(b)] for a, b in (r.split("～") for r in rs)]


def _day(code):
    if not code:
        return {"code": "", "label": "", "segs": [], "hours": 0, "work": False}
    sh = SHIFTS.get(code)
    if not sh:
        return {"code": code, "label": code, "segs": [], "hours": 0, "work": False}
    work = bool(re.search(r"\d{1,2}[:：]?\d{2}", sh["time"]))
    d = {"code": code, "label": sh["name"], "segs": _parse(sh["time"]), "hours": sh["hours"] if work else 0, "work": work}
    if work and not d["segs"]:
        d["time_unknown"] = True
    return d


def _schedule(y, m, cur):
    """排班系統的人 id → {日: 代碼}"""
    n = _last_day(y, m)
    row = {str(d): PATTERN[(d - 1) % len(PATTERN)] for d in range(1, n + 1) if PATTERN[(d - 1) % len(PATTERN)]}
    out = {"s1": row, "s3a": {"1": "A"}, "s3b": {"2": "A"}}
    if cur:
        out["s2"] = {"3": "E", "4": "休"}
    return out


EMPS = {"s1": "測試一", "s2": "測試 二", "s3a": "測試三", "s3b": "測試三"}


def register(ns):
    verify = ns["mock_verify_id_token"]
    load_data = ns["load_data"]
    norm = lambda s: re.sub(r"[\s　]", "", str(s or ""))

    def hub_sched(data, body):
        uid = verify(body.get("id_token"))
        if not uid:
            return {"ok": False, "error": "invalid_id_token"}
        now = datetime.now(TZ)
        today, hm = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
        cy, cm = now.year, now.month
        py, pm = _prev(cy, cm)
        months = ["%d-%02d" % (py, pm), "%d-%02d" % (cy, cm)]
        ym = str(body.get("ym") or months[1])
        if ym not in months:
            return {"ok": False, "error": "bad_month"}
        y, m = int(ym[:4]), int(ym[5:7])
        base = {"ok": True, "ym": ym, "months": months, "today": today}
        me = next((r for r in load_data()["roster"]
                   if str(r.get("active")).lower() == "true" and r.get("line_user_id") and r.get("line_user_id") == uid), None)
        if not me:
            base["status"] = "not_bound"
            return base
        base["name"] = me["name"]
        ctl = data.get("mock_sched") or {}
        if ctl.get("fail"):
            return {"ok": False, "error": "sched_unreadable"}
        if "%d_%d" % (y, m) in (ctl.get("unlock") or []):
            base["status"] = "not_locked"
            return base
        hits = [k for k, v in EMPS.items() if norm(v) == norm(me["name"])]
        if len(hits) != 1:
            base["status"] = "not_matched"
            return base
        row = _schedule(y, m, ym == months[1]).get(hits[0])
        if not row:
            base["status"] = "no_schedule"
            return base
        days, wd, od, hrs = [], 0, 0, 0.0
        for d in range(1, _last_day(y, m) + 1):
            x = _day(row.get(str(d), ""))
            x["d"] = d
            days.append(x)
            if x["work"]:
                wd += 1
                hrs += x["hours"]
            elif x["code"]:
                od += 1
        nxt = None
        if today[:7] == ym:
            for x in days[int(today[8:10]) - 1:]:
                if not x["work"]:
                    continue
                if x["d"] == int(today[8:10]) and x["segs"]:
                    a, b = x["segs"][-1]
                    if b > a and b <= hm:
                        continue
                nxt = {"date": "%s-%02d" % (ym, x["d"]), "label": x["label"], "segs": x["segs"], "hours": x["hours"]}
                break
        base.update({"status": "ready", "days": days, "summary": {"work_days": wd, "off_days": od, "hours": round(hrs, 2)}, "next": nxt})
        return base

    ns["LINE_HUB_ACTIONS"]["line_hub_sched"] = hub_sched
