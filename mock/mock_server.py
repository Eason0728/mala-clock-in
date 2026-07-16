#!/usr/bin/env python3
"""
麻的小辛辣 員工打卡系統 - 本機模擬後端

用途：本機測試 clock.html，模擬 Google Apps Script 後端的行為。
啟動：python3 mock_server.py（預設 port 8899，只用 Python3 標準庫）
測試網址：http://localhost:8899/clock.html?k=testkey1&api=/api

資料存放於同層 mock_data.json（首次執行自動建立種子資料）。
admin_key 固定為 'test-admin'（僅供本機測試，正式環境見 apps-script/Code.gs 的 CONFIG.ADMIN_KEY）。

本檔與 apps-script/Code.gs 實作同一套 API 合約：clock / whoami /
sync_roster / get_roster / get_events / approve_device。
"""

import json
import math
import os
import random
import re
import string
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = 8899
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)
DATA_FILE = os.path.join(BASE_DIR, "mock_data.json")

ADMIN_KEY = "test-admin"
STORE_LAT = 24.7840945  # 2026-07-13 依店內實測校正
STORE_LNG = 121.0157448
RADIUS_M = 20  # 允許打卡半徑（公尺），與 Code.gs 的 CONFIG.RADIUS_M 同步（2026-07-14 Eason 指定收緊為 20）
# 上下班交替判斷的回看視窗（小時）：看得到跨夜班前一晚的上班卡，
# 但昨天忘打的下班卡（超過視窗）不會鎖死今天的上班卡。
ALTERNATION_LOOKBACK_HOURS = 12

TAIPEI_TZ = timezone(timedelta(hours=8))


def now_taipei():
    return datetime.now(TAIPEI_TZ)


def iso_now():
    return now_taipei().isoformat(timespec="seconds")


def today_str():
    return now_taipei().strftime("%Y-%m-%d")


def haversine_m(lat1, lng1, lat2, lng2):
    """兩點間距離（公尺）。與 Code.gs 的 haversineM 為同一公式。"""
    r = 6371000.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(d_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def gen_key(n=20):
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(n))


def seed_managers():
    # 值班主管核定（2026-07-13 新增）種子主管：測試主管 / testmgr1
    return [{"name": "測試主管", "key": "testmgr1", "active": True}]


def seed_data():
    return {
        "roster": [
            {
                "emp_id": "E01",
                "name": "測試一",
                "key": "testkey1",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
            },
            {
                "emp_id": "E02",
                "name": "測試二",
                "key": "testkey2",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
            },
            {
                "emp_id": "E03",
                "name": "測試三",
                "key": "testkey3",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
            },
            {
                "emp_id": "E04",
                "name": "測試四",
                "key": "testkey4",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
            },
        ],
        "events": [],
        "managers": seed_managers(),
        "approved": [],
    }


def load_data():
    if not os.path.exists(DATA_FILE):
        data = seed_data()
        save_data(data)
        return data
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    # 既有 mock_data.json（40 天假資料）補欄位，不清空既有內容（Eason 2026-07-13 正在用）
    changed = False
    if "managers" not in data:
        data["managers"] = seed_managers()
        changed = True
    if "approved" not in data:
        data["approved"] = []
        changed = True
    if "leave" not in data:
        data["leave"] = []
        changed = True
    if changed:
        save_data(data)
    return data


def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def find_roster_by_key(data, key):
    for r in data["roster"]:
        if r["key"] == key:
            return r
    return None


def find_roster_by_empid(data, emp_id):
    for r in data["roster"]:
        if r["emp_id"] == emp_id:
            return r
    return None


def last_counted_event(data, emp_id):
    """上下班交替判斷：取該員工「現在往前 ALTERNATION_LOOKBACK_HOURS 小時內」
    status 非 rejected_* 的最後一筆事件（跨日也算）。回傳 {ts, type} 或 None。
    pending_device_approval 也算數：核准後會翻成 ok，若不算數會造成核准後同型重複。"""
    cutoff = now_taipei() - timedelta(hours=ALTERNATION_LOOKBACK_HOURS)
    last = None
    for e in data["events"]:
        if e["emp_id"] != emp_id:
            continue
        if str(e["status"]).startswith("rejected_"):
            continue
        try:
            ts = datetime.fromisoformat(e["ts"])
        except ValueError:
            continue
        if ts >= cutoff:
            last = {"ts": e["ts"], "type": e["type"]}
    return last


MONTHLY_PAIR_WINDOW_HOURS = 12  # in 配「12 小時內的下一筆 out」，與 Code.gs 的 MONTHLY_PAIR_WINDOW_HOURS 同步
REJECTED_IN_BREAK_MIN = 60  # 被拒的重複上班卡（rejected_duplicate 的 in）距開著的 in 達此分鐘數 → 視為忘打下班的斷點（與 Code.gs 同步）


def approved_hours_of_shift(in_ts, out_ts):
    """核定工時：打卡時間各自取整到 15 分鐘刻度再相減（與 Code.gs approvedHoursOfShift 同一套規則）。
    上班先捨秒、往後進位到刻度；下班先捨秒、往前捨去到刻度。"""
    in_min = int(datetime.fromisoformat(in_ts).timestamp() // 60)
    out_min = int(datetime.fromisoformat(out_ts).timestamp() // 60)
    in_grid = math.ceil(in_min / 15) * 15
    out_grid = math.floor(out_min / 15) * 15
    return max(0.0, (out_grid - in_grid) / 60.0)


def pair_shifts(events):
    """事件配對成班段（與 Code.gs pairShifts 同一套邏輯，供 whoami 今日時數與
    my_recent 回查用）。取 status='ok' 的 in/out 配對，另把 status='rejected_duplicate'
    的 in 當「新一段的實際起點」：同仁忘打下班、隔一段又打上班被擋，這筆雖被拒但系統有記到
    時間，代表前一段結束、新一段從這裡開始——收前段為「下班忘刷卡」＋以它當新 open 起點，
    讓後面的 out 配成完整段（不冤枉同仁標上班忘刷卡，也不會前後兩段被誤併成一長段）。
    距開著的 in ≥ REJECTED_IN_BREAK_MIN 分鐘才視為換段（低於＝手滑連按，忽略）。
    in 配「MONTHLY_PAIR_WINDOW_HOURS 小時內的下一筆 out」，途中遇到另一筆 in 就斷掉。
    回傳 (shifts, unmatched_ins, unmatched_outs)。"""
    evs = sorted(
        [
            e for e in events
            if (e.get("status") == "ok" and e.get("type") in ("in", "out"))
            or (e.get("status") == "rejected_duplicate" and e.get("type") == "in")
        ],
        key=lambda e: e["ts"],
    )
    shifts = []
    unmatched_ins = []
    unmatched_outs = []
    open_in = None
    window = timedelta(hours=MONTHLY_PAIR_WINDOW_HOURS)
    break_gap = timedelta(minutes=REJECTED_IN_BREAK_MIN)
    for e in evs:
        if e.get("status") == "rejected_duplicate":
            # 被擋的重複上班卡：距開著的 in ≥ 門檻 → 前段忘打下班（收未配對），以本卡當新段起點；
            # 未達門檻＝手滑連按，忽略（open 不變）；沒有開著的 in → 也以本卡當新段起點（防禦）。
            if open_in is None:
                open_in = e
            elif (datetime.fromisoformat(e["ts"]) - datetime.fromisoformat(open_in["ts"])) >= break_gap:
                unmatched_ins.append(open_in)
                open_in = e
            continue
        if e["type"] == "in":
            if open_in:
                unmatched_ins.append(open_in)
            open_in = e
        elif open_in and (datetime.fromisoformat(e["ts"]) - datetime.fromisoformat(open_in["ts"])) <= window:
            shifts.append({"in_ts": open_in["ts"], "out_ts": e["ts"]})
            open_in = None
        else:
            if open_in:  # out 超過視窗 → in 也配不到（與 Code.gs 同）
                unmatched_ins.append(open_in)
                open_in = None
            unmatched_outs.append(e)
    if open_in:
        unmatched_ins.append(open_in)
    return shifts, unmatched_ins, unmatched_outs


def today_hours_summary(data, emp_id, today):
    """今日出勤時數（whoami 用，與 Code.gs todayHoursSummary 同步邏輯）：
    reference＝已完成時段原始相減加總，approved＝已完成時段 approvedHoursOfShift 加總；
    今日最後一筆 ok 事件若是尚未配對的 in（上班中）→ working_since 為該筆原始 HH:mm，
    reference/approved 只計入已完成時段；今日無完成時段則兩者為 0。"""
    today_ok_events = [
        e for e in data["events"]
        if e["emp_id"] == emp_id and e["ts"][:10] == today
        and (e.get("status") == "ok" or (e.get("status") == "rejected_duplicate" and e.get("type") == "in"))
    ]
    shifts, unmatched_ins, _unmatched_outs = pair_shifts(today_ok_events)

    reference = 0.0
    approved = 0.0
    for s in shifts:
        reference += (
            datetime.fromisoformat(s["out_ts"]) - datetime.fromisoformat(s["in_ts"])
        ).total_seconds() / 3600.0
        approved += approved_hours_of_shift(s["in_ts"], s["out_ts"])

    result = {
        "reference": round(reference, 2),
        "approved": round(approved, 2),
        "working_since": None,
    }
    if unmatched_ins:
        open_in = unmatched_ins[-1]
        # 這筆未配對 in 之後若已有 ok 下班卡 → 當天已下班（中間漏刷），不算上班中
        later_out = any(
            e.get("status") == "ok" and e.get("type") == "out" and e["ts"] > open_in["ts"]
            for e in today_ok_events
        )
        if not later_out:
            result["working_since"] = open_in["ts"][11:16]
    return result


RECENT_DAYS_WINDOW = 40  # my_recent 回查視窗（天，含今天），與 Code.gs 的 RECENT_DAYS_WINDOW 同步（2026-07-13 Eason 指定 40）


def build_recent_days(data, emp_id, today):
    """最近 N 天出勤明細（my_recent 用，與 Code.gs buildRecentDays 同步邏輯）。
    慣例照月表 buildMonthlySheet：班段歸 in 那一天（跨夜段 cross=True，前端顯示 (+1)）、
    未配對 in→「下班忘刷卡」、未配對 out→「上班忘刷卡」；事件往前多抓 1 天供跨夜配對。
    例外：未配對 in 落在「今天」→ 不算忘刷卡（上班中）。無事件的日子省略不回。
    reference＝已完成班段原始相減加總。approved＝值班主管在 approved 的核定時數
    （有紀錄→數字、無紀錄→None＝待核定），不是 approved_hours_of_shift 的 15 分鐘取整
    ——那是 2026-07-13 前的舊定義，核定已改主管手動輸入實際時段（2026-07-15 改）。"""
    today_d = datetime.strptime(today, "%Y-%m-%d").date()
    start = (today_d - timedelta(days=RECENT_DAYS_WINDOW - 1)).isoformat()
    fetch_start = (today_d - timedelta(days=RECENT_DAYS_WINDOW)).isoformat()

    evs = [
        e for e in data["events"]
        if e["emp_id"] == emp_id and fetch_start <= e["ts"][:10] <= today
    ]
    shifts, unmatched_ins, unmatched_outs = pair_shifts(evs)  # pair_shifts 內部只取 status='ok'

    day_map = {}

    def day(d):
        if d not in day_map:
            day_map[d] = {"date": d, "segments": [], "reference": 0.0, "notes": []}
        return day_map[d]

    for s in shifts:
        d = s["in_ts"][:10]  # 班段歸 in 的那一天（月表慣例）
        if not (start <= d <= today):
            continue
        c = day(d)
        c["segments"].append({
            "_sort": s["in_ts"],
            "in": s["in_ts"][11:16],
            "out": s["out_ts"][11:16],
            "cross": s["out_ts"][:10] != d,
        })
        c["reference"] += (
            datetime.fromisoformat(s["out_ts"]) - datetime.fromisoformat(s["in_ts"])
        ).total_seconds() / 3600.0

    for e in unmatched_ins:
        d = e["ts"][:10]
        if not (start <= d <= today):
            continue
        c = day(d)
        c["segments"].append({"_sort": e["ts"], "in": e["ts"][11:16], "out": None, "cross": False})
        c["notes"].append("上班中" if d == today else "下班忘刷卡")

    for e in unmatched_outs:
        d = e["ts"][:10]
        if not (start <= d <= today):
            continue
        c = day(d)
        c["segments"].append({"_sort": e["ts"], "in": None, "out": e["ts"][11:16], "cross": False})
        c["notes"].append("上班忘刷卡")

    days = []
    for d in sorted(day_map):
        c = day_map[d]
        c["segments"].sort(key=lambda s: s["_sort"])
        for s in c["segments"]:
            del s["_sort"]
        c["reference"] = round(c["reference"], 2)
        # 核定＝主管在 approved 的最新核定（與 Code.gs buildRecentDays／月表同一套慣例）：
        # 無紀錄→None＝待核定；有紀錄但 0 小時＝全天請假，要與 None 區分，故看 rec 是否存在。
        rec = latest_approved_record(data, d, emp_id)
        c["approved"] = round(float(rec["approved_hours"]), 2) if rec else None
        days.append(c)
    return days


def handle_my_recent(data, body):
    """{action:'my_recent', key, device_id} → 最近 RECENT_DAYS_WINDOW 天出勤明細。
    驗證與 whoami 相同：key 無效（或離職）→ invalid_key；裝置只回 device_state 不拒回。"""
    key = body.get("key")
    device_id = body.get("device_id") or ""

    roster = find_roster_by_key(data, key)
    if not roster or not roster.get("active", False):
        return {"ok": False, "error": "invalid_key"}

    if not roster.get("device_id"):
        device_state = "unbound"
    elif roster["device_id"] == device_id:
        device_state = "match"
    else:
        device_state = "mismatch"

    return {
        "ok": True,
        "emp_id": roster["emp_id"],
        "name": roster["name"],
        "device_state": device_state,
        "days": build_recent_days(data, roster["emp_id"], today_str()),
    }


def find_manager_by_key(data, key):
    for m in data.get("managers", []):
        if m["key"] == key and m.get("active", False):
            return m
    return None


def add_days_str(date_str, n):
    d = datetime.strptime(date_str, "%Y-%m-%d").date() + timedelta(days=n)
    return d.isoformat()


def day_punch_segments(data, emp_id, date_str):
    """單一員工單一天的打卡段（給 mgr_day/mgr_approve 用，與 Code.gs dayPunchSegments 同步）。
    事件往前後各多抓 1 天供跨夜配對，只回傳歸屬 date_str 這天的班段。"""
    lo = add_days_str(date_str, -1)
    hi = add_days_str(date_str, 1)
    evs = [e for e in data["events"] if e["emp_id"] == emp_id and lo <= e["ts"][:10] <= hi]
    shifts, unmatched_ins, unmatched_outs = pair_shifts(evs)

    segments = []
    reference = 0.0
    for s in shifts:
        d = s["in_ts"][:10]
        if d != date_str:
            continue
        segments.append({
            "_sort": s["in_ts"],
            "in": s["in_ts"][11:16],
            "out": s["out_ts"][11:16],
            "cross": s["out_ts"][:10] != d,
        })
        reference += (
            datetime.fromisoformat(s["out_ts"]) - datetime.fromisoformat(s["in_ts"])
        ).total_seconds() / 3600.0
    for e in unmatched_ins:
        if e["ts"][:10] != date_str:
            continue
        segments.append({"_sort": e["ts"], "in": e["ts"][11:16], "out": None, "cross": False})
    for e in unmatched_outs:
        if e["ts"][:10] != date_str:
            continue
        segments.append({"_sort": e["ts"], "in": None, "out": e["ts"][11:16], "cross": False})

    segments.sort(key=lambda s: s["_sort"])
    for s in segments:
        del s["_sort"]
    return {"segments": segments, "reference": round(reference, 2)}


def parse_periods_str(s):
    """'HH:mm-HH:mm,HH:mm-HH:mm' → [{"start","end"}]"""
    if not s:
        return []
    out = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        start, end = part.split("-")
        out.append({"start": start, "end": end})
    return out


TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# 主管核定頁「請假註記」可選假別（與 Code.gs LEAVE_TYPES 同步）
LEAVE_TYPES = ["病假", "事假", "特休假", "生理假", "家庭照顧假", "喪假", "婚假"]


def hm_to_ms(date_str, hm):
    """'yyyy-MM-dd' + 'HH:mm' → 該台北時刻的 epoch ms（明寫 +08:00）。"""
    h, m = hm.split(":")
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=int(h), minute=int(m), tzinfo=TAIPEI_TZ)
    return dt.timestamp() * 1000.0


def compute_approval_status(periods, punch_segments):
    """比對主管輸入時段 vs 打卡段，回傳狀態字串（與 Code.gs computeApprovalStatus 同步）。
    periods: [{"start_ms","end_ms"}]；punch_segments: [{"in_ms","out_ms"}]（未配對為 None）。"""
    full_segs = [s for s in punch_segments if s["in_ms"] is not None and s["out_ms"] is not None]
    notes = []
    used = set()

    for p in periods:
        best_i, best_overlap = -1, 0
        for i, seg in enumerate(full_segs):
            overlap = min(p["end_ms"], seg["out_ms"]) - max(p["start_ms"], seg["in_ms"])
            if overlap > best_overlap:
                best_overlap, best_i = overlap, i
        if best_i == -1:
            if "該段無打卡" not in notes:
                notes.append("該段無打卡")
            continue
        used.add(best_i)
        seg = full_segs[best_i]
        if seg["in_ms"] > p["start_ms"]:
            notes.append("遲到{}分".format(round((seg["in_ms"] - p["start_ms"]) / 60000)))
        if seg["out_ms"] < p["end_ms"]:
            notes.append("早退{}分".format(round((p["end_ms"] - seg["out_ms"]) / 60000)))

    if len(full_segs) > len(used):
        notes.append("有多出的打卡段")
    return "、".join(notes) if notes else "正常"


def latest_approved_record(data, date_str, emp_id):
    matches = [r for r in data["approved"] if r["date"] == date_str and r["emp_id"] == emp_id]
    if not matches:
        return None
    matches.sort(key=lambda r: r["entered_at"])
    return matches[-1]


def handle_mgr_day(data, body):
    """{action:'mgr_day', mgr_key, date?}（date 缺省＝今天）→ roster 全部 active 同仁
    （2026-07-13 Eason 實測回饋改版：當天沒打卡的也要出現——segments 空、reference=None，
    主管照樣可輸入時段核定，整天忘刷卡的人才核得到）。有打卡的照舊顯示打卡段＋參考時數＋
    既有核定紀錄（最新一筆）。排序：有打卡的在前（依當日第一筆打卡時間），沒打卡的在後
    （依名冊順序）；名冊外但當天有事件的 emp_id 補最後（防禦）。與 Code.gs handleMgrDay 同步。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}

    date = body.get("date") or today_str()

    # 該日每位員工最早一筆事件時間（任何 status 都算「有打卡」，排序用）
    first_ts = {}
    for e in data["events"]:
        if e["ts"][:10] != date:
            continue
        emp = e["emp_id"]
        if emp not in first_ts or e["ts"] < first_ts[emp]:
            first_ts[emp] = e["ts"]

    listed = []
    seen = set()
    for r in data["roster"]:
        if not r.get("active", False):
            continue
        listed.append({"emp_id": r["emp_id"], "name": r["name"]})
        seen.add(r["emp_id"])
    for emp in sorted(first_ts):
        if emp not in seen:
            roster = find_roster_by_empid(data, emp)
            listed.append({"emp_id": emp, "name": roster["name"] if roster else emp})

    # 有打卡的在前（依第一筆打卡時間），沒打卡的在後（維持名冊順序）
    listed = (
        sorted(
            [x for x in listed if x["emp_id"] in first_ts],
            key=lambda x: first_ts[x["emp_id"]],
        )
        + [x for x in listed if x["emp_id"] not in first_ts]
    )

    # 該日 leave 的假別＋時數（姓名→值；同日同人多筆時最後一筆為準，與 upsert_leave 保留邏輯一致）
    leave_by_name = {}
    leave_hours_by_name = {}
    for l in data.get("leave", []):
        if str(l.get("date", ""))[:10] == date:
            nm = str(l.get("name", "")).strip()
            leave_by_name[nm] = str(l.get("type", "")).strip()
            h = l.get("hours", "")
            leave_hours_by_name[nm] = "" if h == "" or h is None else h

    employees = []
    for item in listed:
        emp_id = item["emp_id"]
        has_punch = emp_id in first_ts
        punch = day_punch_segments(data, emp_id, date) if has_punch else None
        rec = latest_approved_record(data, date, emp_id)
        out = {
            "emp_id": emp_id,
            "name": item["name"],
            "segments": punch["segments"] if has_punch else [],
            "reference": punch["reference"] if has_punch else None,  # 沒打卡＝參考空白
            "leave_type": leave_by_name.get(item["name"], ""),
            "leave_hours": leave_hours_by_name.get(item["name"], ""),
        }
        if rec:
            out["approved"] = {
                "periods": parse_periods_str(rec["periods"]),
                "approved_hours": rec["approved_hours"],
                "status_text": rec["status_text"],
                "manager_name": rec["manager_name"],
            }
        employees.append(out)

    return {"ok": True, "date": date, "employees": employees}


def handle_mgr_approve(data, body):
    """{action:'mgr_approve', mgr_key, date, emp_id, periods:[{start,end}]} → 驗證格式、
    計算核定時數與遲到早退判定，append 到 approved（只追加不覆蓋），回傳計算結果。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}

    date = str(body.get("date") or "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return {"ok": False, "error": "bad_date"}

    emp_id = body.get("emp_id")
    roster = find_roster_by_empid(data, emp_id)
    if not roster:
        return {"ok": False, "error": "invalid_emp_id"}

    leave_type = str(body.get("leave_type") or "").strip()
    if leave_type and leave_type not in LEAVE_TYPES:
        return {"ok": False, "error": "bad_leave_type"}
    # 請假時數：可留空；有填要是 0 以上的數字，四捨五入到 2 位（與 Code.gs 同步）
    leave_hours = ""
    lh_raw = body.get("leave_hours")
    if leave_type and lh_raw not in ("", None):
        try:
            h = float(lh_raw)
        except (TypeError, ValueError):
            return {"ok": False, "error": "bad_leave_hours"}
        if h < 0:
            return {"ok": False, "error": "bad_leave_hours"}
        leave_hours = round(h, 2)

    raw_periods = body.get("periods") or []
    if not isinstance(raw_periods, list):
        return {"ok": False, "error": "bad_periods"}

    if len(raw_periods) == 0:
        # 整天請假：沒時段但要有假別；核定 0 小時、狀態「全天請假」（與 Code.gs 同步）
        if not leave_type:
            return {"ok": False, "error": "bad_periods"}
        approved_hours = 0.0
        periods_str = ""
        status_text = "全天請假"
    else:
        for p in raw_periods:
            if (
                not isinstance(p, dict)
                or not TIME_RE.match(str(p.get("start", "")))
                or not TIME_RE.match(str(p.get("end", "")))
            ):
                return {"ok": False, "error": "bad_periods"}

        periods = []
        approved_hours = 0.0
        for p in raw_periods:
            start_ms = hm_to_ms(date, p["start"])
            end_ms = hm_to_ms(date, p["end"])
            if end_ms <= start_ms:
                end_ms += 24 * 3600 * 1000  # 跨夜段：end<=start 視為+1天
            periods.append({"start_ms": start_ms, "end_ms": end_ms})
            approved_hours += (end_ms - start_ms) / 3600000.0
        approved_hours = round(approved_hours, 2)

        punch = day_punch_segments(data, emp_id, date)
        punch_segments = []
        for s in punch["segments"]:
            in_ms = hm_to_ms(date, s["in"]) if s["in"] else None
            out_date = add_days_str(date, 1) if s["cross"] else date
            out_ms = hm_to_ms(out_date, s["out"]) if s["out"] else None
            punch_segments.append({"in_ms": in_ms, "out_ms": out_ms})

        status_text = compute_approval_status(periods, punch_segments)
        periods_str = ",".join("{}-{}".format(p["start"], p["end"]) for p in raw_periods)
    entered_at = iso_now()

    data["approved"].append(
        {
            "date": date,
            "emp_id": emp_id,
            "name": roster["name"],
            "periods": periods_str,
            "approved_hours": approved_hours,
            "status_text": status_text,
            "manager_name": mgr["name"],
            "entered_at": entered_at,
        }
    )
    # 請假註記 upsert：同日同人最多一筆；空字串＝清掉（與 Code.gs upsertLeaveRow 同步）
    data["leave"] = [
        l for l in data.get("leave", [])
        if not (str(l.get("date", ""))[:10] == date and str(l.get("name", "")).strip() == roster["name"])
    ]
    if leave_type:
        data["leave"].append({"date": date, "name": roster["name"], "type": leave_type, "hours": leave_hours})
    save_data(data)

    return {
        "ok": True,
        "date": date,
        "emp_id": emp_id,
        "name": roster["name"],
        "periods": raw_periods,
        "approved_hours": approved_hours,
        "leave_type": leave_type,
        "leave_hours": leave_hours,
        "status_text": status_text,
        "manager_name": mgr["name"],
        "entered_at": entered_at,
    }


def handle_clock(data, body):
    key = body.get("key")
    type_ = body.get("type")
    device_id = body.get("device_id") or ""

    roster = find_roster_by_key(data, key)
    if not roster or not roster.get("active", False):
        return {"ok": False, "error": "invalid_key"}

    lat = float(body.get("lat"))
    lng = float(body.get("lng"))

    distance_m = round(haversine_m(STORE_LAT, STORE_LNG, lat, lng), 1)
    within_range = distance_m <= RADIUS_M
    ts = iso_now()

    # 檢查順序：重複檢查 → 裝置檢查 → 範圍檢查
    last_counted = last_counted_event(data, roster["emp_id"])
    is_duplicate = last_counted is not None and last_counted["type"] == type_

    if not roster.get("device_id"):
        roster["device_id"] = device_id
        roster["device_bound_at"] = ts
        device_match = True
    elif roster["device_id"] == device_id:
        device_match = True
    else:
        device_match = False

    # status 優先序：重複 > 裝置不符 > 超出範圍 > ok
    if is_duplicate:
        status = "rejected_duplicate"
    elif not device_match:
        status = "pending_device_approval"
    elif not within_range:
        status = "rejected_out_of_range"
    else:
        status = "ok"

    event = {
        "ts": ts,
        "emp_id": roster["emp_id"],
        "type": type_,
        "lat": lat,
        "lng": lng,
        "distance_m": distance_m,
        "within_range": within_range,
        "device_id": device_id,
        "device_match": device_match,
        "status": status,
    }
    data["events"].append(event)
    save_data(data)

    result = {
        "ok": True,
        "status": status,
        "name": roster["name"],
        "ts": ts,
        "distance_m": distance_m,
        "within_range": within_range,
    }
    if status == "rejected_duplicate":
        result["last_type"] = last_counted["type"]
    return result


def handle_whoami(data, body):
    key = body.get("key")
    device_id = body.get("device_id") or ""

    roster = find_roster_by_key(data, key)
    if not roster or not roster.get("active", False):
        return {"ok": False, "error": "invalid_key"}

    if not roster.get("device_id"):
        device_state = "unbound"
    elif roster["device_id"] == device_id:
        device_state = "match"
    else:
        device_state = "mismatch"

    today = today_str()
    today_events = [
        {"ts": e["ts"], "type": e["type"], "status": e["status"]}
        for e in data["events"]
        if e["emp_id"] == roster["emp_id"] and e["ts"][:10] == today
    ]

    return {
        "ok": True,
        "emp_id": roster["emp_id"],
        "name": roster["name"],
        "device_state": device_state,
        "today_events": today_events,
        # 前端按鈕灰階/擋卡提醒用這個判斷（12 小時回看視窗，跨日也算），
        # 不要自己從 today_events 算，避免跨日時兩邊算法不一致。
        "last_counted": last_counted_event(data, roster["emp_id"]),
        "today_hours": today_hours_summary(data, roster["emp_id"], today),
    }


def check_admin(body):
    return body.get("admin_key") == ADMIN_KEY


def handle_sync_roster(data, body):
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}

    employees = body.get("employees", [])
    for emp in employees:
        emp_id = emp.get("emp_id")
        name = emp.get("name")
        active = bool(emp.get("active", True))
        existing = find_roster_by_empid(data, emp_id)
        if existing:
            # 只更新 name/active，絕不覆蓋 key/device_id/device_bound_at
            existing["name"] = name
            existing["active"] = active
        else:
            data["roster"].append(
                {
                    "emp_id": emp_id,
                    "name": name,
                    "key": gen_key(),
                    "device_id": "",
                    "device_bound_at": "",
                    "active": active,
                }
            )
    save_data(data)
    return {"ok": True, "roster": data["roster"]}


def handle_get_roster(data, body):
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}
    return {"ok": True, "roster": data["roster"]}


def handle_get_events(data, body):
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}

    to_str = body.get("to")
    from_str = body.get("from")
    to_dt = datetime.strptime(to_str, "%Y-%m-%d").date() if to_str else now_taipei().date()
    from_dt = (
        datetime.strptime(from_str, "%Y-%m-%d").date()
        if from_str
        else to_dt - timedelta(days=31)
    )

    events = [
        e
        for e in data["events"]
        if from_dt <= datetime.strptime(e["ts"][:10], "%Y-%m-%d").date() <= to_dt
    ]
    return {"ok": True, "events": events}


def handle_approve_device(data, body):
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}

    emp_id = body.get("emp_id")
    device_id = body.get("device_id")
    approve = bool(body.get("approve"))

    roster = find_roster_by_empid(data, emp_id)
    if not roster:
        return {"ok": False, "error": "invalid_emp_id"}

    if approve:
        roster["device_id"] = device_id
        roster["device_bound_at"] = iso_now()

    for e in data["events"]:
        if (
            e["emp_id"] == emp_id
            and e["device_id"] == device_id
            and e["status"] == "pending_device_approval"
        ):
            if approve:
                # 核准只解「裝置」這一關：超出範圍的卡不得因核准而入帳（與 Code.gs 同步）
                e["status"] = "ok" if e.get("within_range") else "rejected_out_of_range"
                e["device_match"] = True
            else:
                e["status"] = "rejected_device"

    save_data(data)
    return {"ok": True, "roster": roster}


ACTIONS = {
    "clock": handle_clock,
    "whoami": handle_whoami,
    "sync_roster": handle_sync_roster,
    "get_roster": handle_get_roster,
    "get_events": handle_get_events,
    "approve_device": handle_approve_device,
    "my_recent": handle_my_recent,
    "mgr_day": handle_mgr_day,
    "mgr_approve": handle_mgr_approve,
}

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, code=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api":
            self._send_json({"ok": False, "error": "not_found"}, 404)
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "bad_json"}, 400)
            return

        action = body.get("action")
        handler = ACTIONS.get(action)
        if not handler:
            self._send_json({"ok": False, "error": "unknown_action"})
            return

        try:
            data = load_data()
            result = handler(data, body)
        except Exception as exc:  # noqa: BLE001 - 回傳錯誤給前端方便本機除錯
            self._send_json({"ok": False, "error": "server_error", "detail": str(exc)}, 500)
            return

        self._send_json(result)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            path = "/clock.html"

        file_path = os.path.normpath(os.path.join(REPO_ROOT, path.lstrip("/")))
        if not file_path.startswith(REPO_ROOT):
            self.send_response(403)
            self.end_headers()
            return

        if os.path.isfile(file_path):
            with open(file_path, "rb") as f:
                content = f.read()
            ext = os.path.splitext(file_path)[1]
            ctype = MIME_TYPES.get(ext, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    load_data()  # 確保種子資料存在
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Mock server running at http://localhost:{PORT}")
    print(f"clock.html 測試網址：http://localhost:{PORT}/clock.html?k=testkey1&api=/api")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
