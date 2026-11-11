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

LIFF 身分層（liff_bind / liff_whoami / liff_clock / liff_my_recent）與
apps-script/Liff.gs 實作同一套合約，用假 token（MOCK_ID_TOKEN_<userId>）
模擬 LINE 登入，不打真的 LINE API。
"""

import json
import math
import os
import sys
import random
import re
import string
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# 埠可用環境變數覆寫：8899 常被別的 session 留下的伺服器佔著（實踩過連到舊的 http.server，
# POST 全回 501），這時用 MOCK_PORT=8912 python3 mock/mock_server.py 換一個埠即可。
PORT = int(os.environ.get('MOCK_PORT') or 8899)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE_DIR)
DATA_FILE = os.path.join(BASE_DIR, "mock_data.json")
sys.path.insert(0, BASE_DIR)   # 讓薪酬假後端 import 得到

ADMIN_KEY = "test-admin"
STORE_LAT = 24.7840945  # 2026-07-13 依店內實測校正
STORE_LNG = 121.0157448
RADIUS_M = 20  # 允許打卡半徑（公尺），與 Code.gs 的 CONFIG.RADIUS_M 同步（2026-07-14 Eason 指定收緊為 20）
# 定位精確度超過這個值＝這次定位不可信（公尺），與 Code.gs 的 LOW_ACCURACY_M 同步
LOW_ACCURACY_M = 50
# 判定在不在店裡時，定位誤差最多可折抵多少距離（公尺），與 Code.gs 的 ACCURACY_CREDIT_CAP_M 同步
ACCURACY_CREDIT_CAP_M = 100
# 上下班交替判斷的回看視窗（小時）：看得到跨夜班前一晚的上班卡，
# 但昨天忘打的下班卡（超過視窗）不會鎖死今天的上班卡。
ALTERNATION_LOOKBACK_HOURS = 12
SAME_TYPE_LOCK_MIN = 10  # 同型（上班後又上班）只在這幾分鐘內擋（與 Code.gs 同步，2026-11-02）

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
                "line_user_id": "",
                "line_bound_at": "",
            },
            {
                "emp_id": "E02",
                "name": "測試二",
                "key": "testkey2",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
                "line_user_id": "",
                "line_bound_at": "",
            },
            {
                "emp_id": "E03",
                "name": "測試三",
                "key": "testkey3",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
                "line_user_id": "",
                "line_bound_at": "",
            },
            {
                "emp_id": "E04",
                "name": "測試四",
                "key": "testkey4",
                "device_id": "",
                "device_bound_at": "",
                "active": True,
                "line_user_id": "",
                "line_bound_at": "",
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
    # LIFF 身分層欄位（2026-08-27）：舊的 mock_data.json 沒有這兩欄，補空字串，
    # 不補的話 line_user_id 查詢也不會壞（.get 對缺欄回 None，一樣視為未綁定），
    # 但補上能讓 mgr_roster 等既有畫面顯示欄位一致。
    for r in data.get("roster", []):
        if "line_user_id" not in r:
            r["line_user_id"] = ""
            changed = True
        if "line_bound_at" not in r:
            r["line_bound_at"] = ""
            changed = True
    if "notices" not in data:
        data["notices"] = []
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


MONTHLY_PAIR_WINDOW_HOURS = 16  # in 配「16 小時內的下一筆 out」，與 Code.gs 的 MONTHLY_PAIR_WINDOW_HOURS 同步（2026-09-02 12→16）
REJECTED_IN_BREAK_MIN = 60  # 被拒的重複上班卡（rejected_duplicate 的 in）距開著的 in 達此分鐘數 → 視為忘打下班的斷點（與 Code.gs 同步）
REJECTED_IN_MISTAP_SEC = 120  # 被擋的上班卡若在此秒數內就打了成功的下班卡 → 視為按錯鍵，忽略這張（與 Code.gs 同步）


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
    return pair_shifts_open(events)[:3]


def pair_shifts_open(events):
    """pair_shifts 的本體，多回第四項 open_in＝「最後還開著」的那張上班卡（後面沒有任何算數的卡；沒有就 None），
    對應 Code.gs pairShifts 的 openIns（B34：判斷是不是還在上班用）。"""
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
    mistap = timedelta(seconds=REJECTED_IN_MISTAP_SEC)
    for i, e in enumerate(evs):
        if e.get("status") == "rejected_duplicate":
            # 按錯鍵：要下班卻按到上班，被擋下後很快就改按了下班（中間可能還連按了幾次）。
            # 忽略這張，讓那張下班卡跟原本開著的上班卡配成完整一段（與 Code.gs 同步）。
            nx = next((x for x in evs[i + 1:] if x.get("status") != "rejected_duplicate"), None)
            if (open_in and nx and nx["type"] == "out" and nx.get("status") == "ok"
                    and (datetime.fromisoformat(nx["ts"]) - datetime.fromisoformat(e["ts"])) <= mistap):
                continue
            # 被擋的重複上班卡：距開著的 in ≥ 門檻 → 前段忘打下班（收未配對），以本卡當新段起點；
            # 未達門檻＝手滑連按，忽略（open 不變）；沒有開著的 in → 忽略（2026-11-11 B09，同 Code.gs）。
            if open_in is None:
                continue
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
    return shifts, unmatched_ins, unmatched_outs, open_in


WORKING_NOTE = "上班中"


def in_still_working(in_ts, now=None):
    """上班中（B34，2026-11-11 Eason 定；與 Code.gs inStillWorking_ 同步）：最後還開著的上班卡，
    距離現在還在打卡配對上限（MONTHLY_PAIR_WINDOW_HOURS，16 小時）以內 → 不論日期都算上班中，
    超過才標「下班忘刷卡」。"""
    now = now or now_taipei()
    t = datetime.fromisoformat(in_ts)
    if t.tzinfo is None:
        t = t.replace(tzinfo=TAIPEI_TZ)
    age = now - t
    return timedelta(0) <= age <= timedelta(hours=MONTHLY_PAIR_WINDOW_HOURS)


def today_hours_summary(data, emp_id, today):
    """今日出勤時數（whoami 用，與 Code.gs todayHoursSummary 同步邏輯）：
    reference＝已完成時段 15 分鐘取整加總（approved_hours_of_shift，2026-07-15 起），approved＝已完成時段 approvedHoursOfShift 加總；
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
        reference += approved_hours_of_shift(s["in_ts"], s["out_ts"])
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
    # 跨夜班（B34，同 Code.gs）：今天沒有進行中的班段，但昨天的上班卡還開著、而且還在 16 小時內 → 上班中
    if not result["working_since"]:
        lo = add_days_str(today, -1)
        wide = [e for e in data["events"] if e["emp_id"] == emp_id and lo <= e["ts"][:10] <= today]
        o = pair_shifts_open(wide)[3]
        if o and o["ts"][:10] != today and in_still_working(o["ts"]):
            result["working_since"] = o["ts"][11:16]
    return result


RECENT_DAYS_WINDOW = 40  # my_recent 回查視窗（天，含今天），與 Code.gs 的 RECENT_DAYS_WINDOW 同步（2026-07-13 Eason 指定 40）


def build_recent_days(data, emp_id, today):
    """最近 N 天出勤明細（my_recent 用，與 Code.gs buildRecentDays 同步邏輯）。
    慣例照月表 buildMonthlySheet：班段歸 in 那一天（跨夜段 cross=True，前端顯示 (+1)）、
    未配對 in→「下班忘刷卡」、未配對 out→「上班忘刷卡」；事件往前多抓 1 天供跨夜配對。
    例外：未配對 in 落在「今天」→ 不算忘刷卡（上班中）。無事件的日子省略不回。
    reference＝已完成班段 15 分鐘取整加總（approved_hours_of_shift，2026-07-15 起）；當天有忘刷卡
    （見上例外）→ 整天回 None，不是部分加總（A3，與月表同一規則，見 day_reference_incomplete，
    勿各自重寫判斷）。approved＝值班主管在 approved 的核定時數
    （有紀錄→數字、無紀錄→None＝待核定），不是 approved_hours_of_shift 的 15 分鐘取整
    ——那是 2026-07-13 前的舊定義，核定已改主管手動輸入實際時段（2026-07-15 改）。"""
    today_d = datetime.strptime(today, "%Y-%m-%d").date()
    start = (today_d - timedelta(days=RECENT_DAYS_WINDOW - 1)).isoformat()
    fetch_start = (today_d - timedelta(days=RECENT_DAYS_WINDOW)).isoformat()

    evs = [
        e for e in data["events"]
        if e["emp_id"] == emp_id and fetch_start <= e["ts"][:10] <= today
    ]
    shifts, unmatched_ins, unmatched_outs, open_in = pair_shifts_open(evs)  # 內部只取 status='ok'

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
        c["reference"] += approved_hours_of_shift(s["in_ts"], s["out_ts"])

    for e in unmatched_ins:
        d = e["ts"][:10]
        if not (start <= d <= today):
            continue
        c = day(d)
        c["segments"].append({"_sort": e["ts"], "in": e["ts"][11:16], "out": None, "cross": False})
        # B34（同 Code.gs）：最後還開著的上班卡在 16 小時內 → 不論日期都算上班中
        working = e is open_in and in_still_working(e["ts"])
        if working:
            c["_working_hm"] = e["ts"][11:16]
        c["notes"].append(WORKING_NOTE if (d == today or working) else "下班忘刷卡")

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
        # 參考時數：忘刷卡整天留白（None），與出勤月表同一規則（A3，見 day_reference_incomplete）
        c["reference"] = None if day_reference_incomplete(c["segments"], d, today, c.pop("_working_hm", None)) else round(c["reference"], 2)
        # 核定＝主管在 approved 的最新核定（與 Code.gs buildRecentDays／月表同一套慣例）：
        # 無紀錄→None＝待核定；有紀錄但 0 小時＝全天請假，要與 None 區分，故看 rec 是否存在。
        rec = latest_approved_record(data, d, emp_id)
        c["approved"] = round(float(rec["approved_hours"]), 2) if rec else None
        # 核定狀態（遲到/早退等，compute_approval_status 於核定當下算好，月表狀態欄同源）。
        # 原樣帶回，「正常」由前端決定不顯示（與 Code.gs buildRecentDays 同步）。
        c["approved_status"] = str(rec.get("status_text") or "") if rec else None
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
        # 本月／上月核定時數合計（與 Code.gs monthTotalsFor 同步）
        "month_totals": month_totals_for(data, roster["emp_id"]),
    }


def monthly_approved_total(data, emp_id, ym):
    """某員工某月（ym='yyyy-MM'）的核定時數合計（與 Code.gs monthlyApprovedTotal 同步）。
    直接掃 approved 全部紀錄，不是把 build_recent_days 的結果加總——40 天視窗蓋不滿整個上月。
    同日多筆取 entered_at 最新一筆（沿用 latest_approved_record 的取法，勿另寫一套）。"""
    dates = sorted({r["date"] for r in data["approved"] if str(r["date"])[:7] == ym})
    total = 0.0
    for d in dates:
        rec = latest_approved_record(data, d, emp_id)
        if not rec:
            continue
        h = rec.get("approved_hours")
        if h is None or not math.isfinite(float(h)):
            continue
        total += float(h)
    return round(total, 2)


def month_worked_days(data, emp_id, ym):
    """某員工某月「有上班紀錄」的日期清單（與 Code.gs monthWorkedDays 同步）。
    日期歸屬比照月表：完整班段歸 in 那天（跨夜不會多算一天）、未配對的 in／out 各歸自己那天。"""
    shifts, unmatched_ins, unmatched_outs = pair_shifts(
        [e for e in data["events"] if e["emp_id"] == emp_id]
    )
    days = set()

    def mark(d):
        if str(d)[:7] == ym:
            days.add(d)

    for s in shifts:
        mark(s["in_ts"][:10])
    for e in unmatched_ins:
        mark(e["ts"][:10])
    for e in unmatched_outs:
        mark(e["ts"][:10])
    return sorted(days)


def month_pending_approval_dates(data, emp_id, ym, today):
    """某月「有上班但主管還沒核定」的日期清單，由舊到新（與 Code.gs monthPendingApprovalDates 同步，
    2026-09-18 從 month_pending_approval_days 抽出）。今天（與未來）不算：當天班還沒結束，
    主管本來就還不會核。"""
    out = []
    for d in month_worked_days(data, emp_id, ym):
        if d >= today:
            continue
        if not latest_approved_record(data, d, emp_id):
            out.append(d)
    return sorted(out)


def month_pending_approval_days(data, emp_id, ym, today):
    """某月「有上班但主管還沒核定」的天數（與 Code.gs monthPendingApprovalDays 同步）。"""
    return len(month_pending_approval_dates(data, emp_id, ym, today))


def month_totals_for(data, emp_id):
    """打卡頁「本月／上月合計」成組回傳（與 Code.gs monthTotalsFor 同步）。"""
    ym = now_taipei().strftime("%Y-%m")
    y, m = int(ym[:4]), int(ym[5:7])
    prev = "%04d-%02d" % ((y - 1, 12) if m == 1 else (y, m - 1))
    today = today_str()

    def box(y_m):
        return {
            "ym": y_m,
            "hours": monthly_approved_total(data, emp_id, y_m),
            "pending_days": month_pending_approval_days(data, emp_id, y_m, today),
        }

    return {"current": box(ym), "previous": box(prev)}


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
    shifts, unmatched_ins, unmatched_outs, open_in = pair_shifts_open(evs)

    segments = []
    reference = 0.0
    open_in_ts = None   # 這天「最後還開著」的那張上班卡（B34，同 Code.gs dayPunchSegments 的 open_in_ts）
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
        reference += approved_hours_of_shift(s["in_ts"], s["out_ts"])
    for e in unmatched_ins:
        if e["ts"][:10] != date_str:
            continue
        segments.append({"_sort": e["ts"], "in": e["ts"][11:16], "out": None, "cross": False})
        if e is open_in:
            open_in_ts = e["ts"]
    for e in unmatched_outs:
        if e["ts"][:10] != date_str:
            continue
        segments.append({"_sort": e["ts"], "in": None, "out": e["ts"][11:16], "cross": False})

    segments.sort(key=lambda s: s["_sort"])
    for s in segments:
        del s["_sort"]
    return {"segments": segments, "reference": round(reference, 2), "open_in_ts": open_in_ts}


def working_in_hm(punch):
    """這天還在上班的那張上班卡的 HH:mm（16 小時內），沒有就 None（同 Code.gs workingInHm_）。"""
    ts = (punch or {}).get("open_in_ts")
    return ts[11:16] if ts and in_still_working(ts) else None


def day_reference_incomplete(segments, date_str, today_str, working_hm=None):
    """判斷某天參考時數是否該留白（A3：與 Code.gs dayReferenceIncomplete 同步，月表／my_recent／
    mgr_day 共用同一判斷，勿各自重寫）。只吃已算好的 segments（{in,out,cross}，未配對一端為 None）：
    有任一筆未配對 out（in 為 None，即「上班忘刷卡」）→ 恆不完整；有任一筆未配對 in（out 為 None，
    即「下班忘刷卡」）且 date_str 不是今天 → 不完整；今天的未配對 in＝上班中，不算不完整（a872de4 規則）。
    working_hm（B34）＝這天還在上班的那張上班卡的 HH:mm（16 小時內）→ 那一張不算忘刷，不論日期。"""
    has_forgot_out = any(s["in"] is None for s in segments)
    has_forgot_in = any(s["out"] is None and not (working_hm and s["in"] == working_hm) for s in segments)
    return has_forgot_out or (has_forgot_in and date_str != today_str)


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
# ⚠ 2026-08-22 起正式環境的下拉改由薪酬系統的 payroll_leave_type 表決定（payroll_leave_options），
#    這份清單只剩兩個用途：①mgr_approve 的合法性檢查 ②薪酬後端連不上時前端的 fallback。
#    新增假別請改 Payroll.gs 的 PAY_LEAVE_DEFAULTS 或那張表，並記得同步這一行。
LEAVE_TYPES = [
    "特休假", "事假", "病假",
    "住院傷病假", "安胎休養假", "生理假",
    "家庭照顧假", "喪假（父母・配偶）", "喪假（祖父母・子女・配偶父母）",
    "喪假（曾祖父母・兄弟姊妹）", "婚假", "天災假",
    "公傷病假", "產假（分娩）", "流產假（妊娠3個月以上）",
    "流產假（妊娠2～未滿3個月）", "流產假（妊娠未滿2個月）", "產檢假",
    "陪產檢及陪產假", "公假", "謀職假",
    "育嬰假", "喪假", "產假",
    "出差",
    # 補休（2026-10-09）：正式環境 Code.gs 白名單沒有它，是 mgr_approve 查薪酬假別表放行；mock 直接列進白名單
    "補休",
]


# ── payroll_leave_options（2026-08-22）：值班核定頁的假別下拉＋額度 ──
# 正式環境這支在 Payroll.gs，資料來自 payroll_leave_type 表；mock 給固定樣本，
# 目的是測「剩 N 日」與「額度用完反灰」兩種呈現，數字不必與正式一致。
MOCK_LEAVE_TYPES = [
    {"code": "annual",       "name": "特休假",         "cap_days": None, "cap_basis": "tenure"},
    {"code": "personal",     "name": "事假",           "cap_days": 14,   "cap_basis": "calendar"},
    {"code": "sick",         "name": "病假",           "cap_days": 30,   "cap_basis": "calendar"},
    {"code": "menstrual",    "name": "生理假",         "cap_days": 3,    "cap_basis": "calendar"},
    {"code": "family",       "name": "家庭照顧假",     "cap_days": 7,    "cap_basis": "calendar"},
    {"code": "funeral",      "name": "喪假",           "cap_days": 8,    "cap_basis": "event"},
    {"code": "marriage",     "name": "婚假",           "cap_days": 8,    "cap_basis": "event"},
    {"code": "disaster",     "name": "天災假",         "cap_days": None, "cap_basis": ""},
    {"code": "occupational", "name": "公傷病假",       "cap_days": None, "cap_basis": ""},
    {"code": "maternity",    "name": "產假",           "cap_days": 56,   "cap_basis": "event"},
    {"code": "prenatal",     "name": "產檢假",         "cap_days": 7,    "cap_basis": "event"},
    {"code": "paternity",    "name": "陪產檢及陪產假", "cap_days": 7,    "cap_basis": "event"},
    {"code": "official",     "name": "公假",           "cap_days": None, "cap_basis": ""},
    {"code": "parental",     "name": "育嬰假",         "cap_days": 720,  "cap_basis": "child"},
    # 正式假別表（Payroll.gs）有出差；mock 原本漏了，核定頁下拉因此選不到出差（2026-10-02 補）
    {"code": "trip",         "name": "出差",           "cap_days": None, "cap_basis": ""},
    # 補休（2026-10-09）：正式環境是 Payroll.gs 內建補上的那列；額度另外回 quotas[emp].comp
    {"code": "comp",         "name": "補休",           "cap_days": None, "cap_basis": ""},
]


def handle_payroll_leave_options(data, body):
    # ⚠ mock 的 handler 簽名一律是 (data, body)，別只收 body（踩過：body 收到的其實是 db）
    # 身分二擇一（與正式環境一致）：管理金鑰（薪資頁「假別額度」）或值班主管金鑰（核定頁下拉）
    if not check_admin(body) and not find_manager_by_key(data, body.get("mgr_key", "")):
        return {"ok": False, "error": "unauthorized"}
    quotas = {}
    for i, emp in enumerate(data.get("roster", [])):
        q = {}
        for t in MOCK_LEAVE_TYPES:
            cap = t["cap_days"]
            if cap is None or t["cap_basis"] == "tenure":
                continue
            # 測試情境：第一位同仁病假只剩 2 日、家庭照顧假已用完，其餘正常
            used = 0
            if i == 0 and t["code"] == "sick":
                used = 28
            if i == 0 and t["code"] == "family":
                used = 7
            blocked = t["cap_basis"] in ("calendar", "child") and used >= cap
            q[t["code"]] = {"used_days": used, "cap_days": cap,
                            "remain_days": cap - used, "basis": t["cap_basis"],
                            "blocked": blocked}
        # 補休帳（2026-11-01 改每月加減結算）：第一位本月加班 8、補休 2 → 剩 6；其餘加班 0、補休 4 → 欠 4（負的也能選）
        ot, used = (8, 2) if i == 0 else (0, 4)
        q["comp"] = {"comp": True, "monthly": True, "allowed": True, "ot_h": ot, "used_h": used, "balance_h": ot - used,
                     "cap_days": None, "blocked": False}
        quotas[str(emp.get("emp_id"))] = q
    return {"ok": True, "store": "SSLGF", "types": MOCK_LEAVE_TYPES,
            "quotas": quotas, "day_hours": 8}


ATT_STATUS_LABEL = {
    "rejected_out_of_range": "超出範圍，未入帳",
    "pending_device_approval": "新裝置待核准，未入帳",
    "rejected_duplicate": "重複打卡，被系統擋下",
    "rejected_device": "裝置不符，被系統擋下",
}   # rejected_too_soon（2026-11-11 B33）沒有對照：Payroll.gs payAttStatusLabel 也沒有，兩邊都走「未入帳（狀態碼）」


def handle_payroll_attendance_export(data, body):
    """{action:'payroll_attendance_export', admin_key, store, ym, emp_id?}（唯讀）。
    與 Payroll.gs payAttendanceBuild 同步：整月每天都列、跨夜歸上班那天（沿用 day_punch_segments）、
    被擋／待核准的卡不當有效卡但列出並標註、核定取最新、請假依姓名對應。"""
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}
    ym = str(body.get("ym", ""))
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", ym):
        return {"ok": False, "error": "bad_ym"}
    only = str(body.get("emp_id") or "")
    y, m = int(ym[:4]), int(ym[5:7])
    nxt = datetime(y + (m == 12), m % 12 + 1, 1)
    dim = (nxt - datetime(y, m, 1)).days
    dates = ["%s-%02d" % (ym, d) for d in range(1, dim + 1)]
    wk = ["日", "一", "二", "三", "四", "五", "六"]
    roster = data.get("roster", [])
    name_to_emp = {str(r.get("name", "")).strip(): str(r["emp_id"]) for r in roster}
    has = set()
    for e in data["events"]:
        if e["ts"][:7] == ym:
            has.add(e["emp_id"])
    for a in data["approved"]:
        if str(a["date"])[:7] == ym:
            has.add(a["emp_id"])
    leave_by = {}
    for l in data.get("leave", []):
        emp = name_to_emp.get(str(l.get("name", "")).strip())
        dt = str(l.get("date", ""))[:10]
        if not emp or dt[:7] != ym:
            continue
        has.add(emp)
        h = l.get("hours", "")
        h = None if h == "" or h is None else float(h)
        leave_by.setdefault(emp, {}).setdefault(dt, []).append({"type": str(l.get("type", "")), "hours": h})
    people = [r for r in roster
              if (not only or str(r["emp_id"]) == only)
              and (str(r.get("active", True)).lower() == "true" or str(r["emp_id"]) in has)]
    people.sort(key=lambda r: str(r["emp_id"]))
    employees = []
    for r in people:
        emp = str(r["emp_id"])
        appr_h = leave_h = 0.0
        work_days = pending_days = 0
        days = []
        for dt in dates:
            seg = day_punch_segments(data, emp, dt)["segments"]
            invalid = [{"time": e["ts"][11:16], "type": e["type"], "status": e["status"],
                        "label": ATT_STATUS_LABEL.get(e["status"], "未入帳（%s）" % e["status"])}
                       for e in sorted(data["events"], key=lambda x: x["ts"])
                       if e["emp_id"] == emp and e["ts"][:10] == dt and e["status"] != "ok"]
            rec = latest_approved_record(data, dt, emp)
            lv = leave_by.get(emp, {}).get(dt, [])
            lv_h = sum((x["hours"] or 0) for x in lv)
            ah = None
            if rec and rec.get("approved_hours") not in ("", None):
                ah = float(rec["approved_hours"])
            row = {"date": dt, "weekday": wk[(datetime.strptime(dt, "%Y-%m-%d").weekday() + 1) % 7],
                   "segments": seg, "invalid": invalid, "approved": bool(rec),
                   "periods": str(rec.get("periods", "")) if rec else "",
                   "approved_hours": ah, "status_text": str(rec.get("status_text", "")) if rec else "",
                   "manager": str(rec.get("manager_name", "")) if rec else "",
                   "leave": lv, "leave_hours": round(lv_h, 2)}
            if ah is not None:
                appr_h += ah
                if ah > 0:
                    work_days += 1
            elif seg:
                pending_days += 1
            leave_h += lv_h
            days.append(row)
        employees.append({"emp_id": emp, "name": str(r.get("name", "")),
                          "active": str(r.get("active", True)).lower() == "true", "days": days,
                          "totals": {"approved_hours": round(appr_h, 2), "leave_hours": round(leave_h, 2),
                                     "work_days": work_days, "pending_days": pending_days}})
    st = str(body.get("store") or "SSLGF")
    name = next((s.get("name") for s in data.get("payroll", {}).get("store", []) if str(s.get("code")) == st), None)
    return {"ok": True, "store": st, "store_name": name or ("麻的小辛辣 新竹光復店" if st == "SSLGF" else st),
            "ym": ym, "generated_at": iso_now(), "employees": employees}


def hm_to_ms(date_str, hm):
    """'yyyy-MM-dd' + 'HH:mm' → 該台北時刻的 epoch ms（明寫 +08:00）。"""
    h, m = hm.split(":")
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=int(h), minute=int(m), tzinfo=TAIPEI_TZ)
    return dt.timestamp() * 1000.0


# 「核定時段對不到打卡段」有兩種成因，措辭要分開（與 Code.gs 同步，2026-08-19）
NO_PUNCH_NOTE = "該段無打卡"
NOT_RECORDED_NOTE = "打卡未入帳，主管補登"
MISSING_GROUP_PREFIX = "第"   # 「第N段下班無打卡／第N段上班無打卡」的字首（2026-09-29 取代「少刷N組卡」）
SEG_MISS_OUT = "段下班無打卡"
SEG_MISS_IN = "段上班無打卡"
SEG_NUM_ZH = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def seg_miss_note(no, tail):
    """與 Code.gs segMissNote 同步。"""
    return MISSING_GROUP_PREFIX + (SEG_NUM_ZH[no] if no < len(SEG_NUM_ZH) else str(no)) + tail
# 「不打卡休息帶」（與 Code.gs 的 CONFIG.NO_PUNCH_BREAK_* 同一件事）。mock 模擬的是光復＝沒有，
# 所以是 None；要測央廚那種店，在測試裡自己傳 break_window 進 compute_approval_status。
NO_PUNCH_BREAK = None


def unrecorded_attempt_count(data, emp_id, date_str):
    """某人某天送出了但沒入帳的打卡筆數（status!='ok'，與 Code.gs unrecordedAttemptCount 同步）。"""
    return sum(1 for e in data["events"]
               if e["emp_id"] == emp_id and e["ts"][:10] == date_str and e.get("status") != "ok")


def lone_cards_for_periods(periods, full_segs, punch_segments, near_ms=4 * 3600000):
    """與 Code.gs loneCardsForPeriods_ 同步（2026-11-10：整天找配到最多、總距離最小的配法）。"""
    open_p = [pi for pi, p in enumerate(periods)
              if not any(min(p["end_ms"], s["out_ms"]) - max(p["start_ms"], s["in_ms"]) > 0 for s in full_segs)]
    cards = [s for s in punch_segments if (s["in_ms"] is None) != (s["out_ms"] is None)]
    if not open_p or not cards or len(cards) > 8:
        return {}
    def dist(c, pi):
        d = abs(c["in_ms"] - periods[pi]["start_ms"]) if c["in_ms"] is not None else abs(c["out_ms"] - periods[pi]["end_ms"])
        return d if d <= near_ms else None
    best = [{}, 0, float("inf")]
    def walk(ci, pick, n, total):
        if ci == len(cards):
            if n > best[1] or (n == best[1] and n > 0 and total < best[2]):
                best[0], best[1], best[2] = dict(pick), n, total
            return
        walk(ci + 1, pick, n, total)
        for pi in open_p:
            if pi in pick:
                continue
            d = dist(cards[ci], pi)
            if d is None:
                continue
            pick[pi] = cards[ci]
            walk(ci + 1, pick, n + 1, total + d)
            del pick[pi]
    walk(0, {}, 0, 0)
    return best[0]


def break_blocks_for(periods, punch_segments, break_window):
    """與 Code.gs breakBlocksFor_ 同步（2026-11-11 B01）：休息帶隔開的兩段併成一塊，但只在併了才講得通時併。
    ① 那一塊裡有一段配得到完整打卡段 → 拆回各段自己比；② 整塊只有單張卡或沒卡 → 不併配得到比較多張才拆。"""
    sorted_p = sorted(periods, key=lambda q: q["start_ms"])
    mk = lambda q, k: {"start_ms": q["start_ms"], "end_ms": q["end_ms"], "first": k + 1, "last": k + 1}
    plain = [mk(q, k) for k, q in enumerate(sorted_p)]
    if not break_window:
        return plain
    merged = []
    for k, q in enumerate(sorted_p):
        last = merged[-1] if merged else None
        if (last and q["start_ms"] > last["end_ms"]
                and last["end_ms"] < break_window["end_ms"] and q["start_ms"] > break_window["start_ms"]):
            last["end_ms"] = max(last["end_ms"], q["end_ms"])
            last["last"] = k + 1
        else:
            merged.append(mk(q, k))
    if len(merged) == len(plain):
        return plain
    full_segs = [s for s in punch_segments if s["in_ms"] is not None and s["out_ms"] is not None]
    has_full = lambda b: any(min(b["end_ms"], s["out_ms"]) - max(b["start_ms"], s["in_ms"]) > 0 for s in full_segs)
    blocks = []
    for b in merged:
        parts = [mk(q, b["first"] - 1 + i) for i, q in enumerate(sorted_p[b["first"] - 1:b["last"]])]
        if len(parts) > 1 and any(has_full(x) for x in parts):
            blocks.extend(parts)
        else:
            blocks.append(b)
    if len(blocks) == len(plain):
        return plain
    lone_used = lambda bs: len(lone_cards_for_periods(bs, full_segs, punch_segments))
    return plain if lone_used(plain) > lone_used(blocks) else blocks


def compute_approval_status(periods, punch_segments, had_unrecorded_attempts=False, break_window=None):
    """與 Code.gs computeApprovalStatus 同步（2026-11-10 口徑統一）。"""
    rnd = lambda x: int(math.floor(x / 60000 + 0.5))
    full_segs = [s for s in punch_segments if s["in_ms"] is not None and s["out_ms"] is not None]
    legacy = bool(had_unrecorded_attempts)
    sorted_p = sorted(periods, key=lambda q: q["start_ms"])
    multi_orig = len(sorted_p) > 1
    blocks = break_blocks_for(sorted_p, punch_segments, None if legacy else break_window)
    if not legacy and break_window:
        periods = blocks
    lone = {} if legacy else lone_cards_for_periods(periods, full_segs, punch_segments)
    multi = len(periods) > 1 and multi_orig
    any_card = len(punch_segments) > 0
    order = sorted(range(len(periods)), key=lambda i: periods[i]["start_ms"])
    in_no, out_no = {}, {}
    for pi, q in enumerate(periods):
        hit = [x for x in blocks if x["start_ms"] <= q["start_ms"] and x["end_ms"] >= q["end_ms"]]
        in_no[pi], out_no[pi] = (hit[0]["first"], hit[0]["last"]) if hit else (pi + 1, pi + 1)
    notes, used, matched = [], set(), {}
    def add(n):
        if n not in notes:
            notes.append(n)
    for pi, p in enumerate(periods):
        best_i, best_ov = -1, 0
        for i, seg in enumerate(full_segs):
            ov = min(p["end_ms"], seg["out_ms"]) - max(p["start_ms"], seg["in_ms"])
            if ov > best_ov:
                best_ov, best_i = ov, i
        matched[pi] = best_i
        if best_i == -1 and pi in lone:
            matched[pi] = len(full_segs) + pi
            c = lone[pi]
            if c["out_ms"] is None:
                if c["in_ms"] > p["start_ms"]:
                    notes.append("遲到{}分".format(rnd(c["in_ms"] - p["start_ms"])))
                # 還在上班（B34：最後一張上班卡、16 小時內）→ 標「上班中」不標忘刷（同 Code.gs）
                add(WORKING_NOTE if c.get("working") else (seg_miss_note(out_no[pi], "段下班忘刷卡") if multi else "下班忘刷卡"))
            else:
                if c["out_ms"] < p["end_ms"]:
                    notes.append("早退{}分".format(rnd(p["end_ms"] - c["out_ms"])))
                add(seg_miss_note(in_no[pi], "段上班忘刷卡") if multi else "上班忘刷卡")
            continue
        if best_i == -1 and not legacy and multi and any_card:
            matched[pi] = -2 - pi
            add(seg_miss_note(in_no[pi], SEG_MISS_IN))
            add(seg_miss_note(out_no[pi], SEG_MISS_OUT))
            continue
        if best_i == -1:
            add(NOT_RECORDED_NOTE if had_unrecorded_attempts else NO_PUNCH_NOTE)
            continue
        used.add(best_i)
        seg = full_segs[best_i]
        if seg["in_ms"] > p["start_ms"]:
            notes.append("遲到{}分".format(rnd(seg["in_ms"] - p["start_ms"])))
        if seg["out_ms"] < p["end_ms"]:
            notes.append("早退{}分".format(rnd(p["end_ms"] - seg["out_ms"])))
    max_end, prev_idx, prev_no = None, -1, 0
    for pi in order:
        p, idx = periods[pi], matched[pi]
        if max_end is not None and p["start_ms"] > max_end:
            explained = bool(break_window) and max_end < break_window["end_ms"] and p["start_ms"] > break_window["start_ms"]
            if not explained and prev_idx >= 0 and idx >= 0 and idx == prev_idx:
                add(seg_miss_note(prev_no, SEG_MISS_OUT))
                add(seg_miss_note(in_no[pi], SEG_MISS_IN))
        if max_end is None or p["end_ms"] > max_end:
            max_end = p["end_ms"]
        prev_idx, prev_no = idx, out_no[pi]
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
    既有核定紀錄（最新一筆）。reference 忘刷卡整天也回 None（A3，與月表／my_recent 同一規則，
    不是沒打卡才 None）。attempts＝該日該員工 status != 'ok' 的事件筆數（A4，rejected 開頭或
    pending 都算，供主管頁揭露透明度）。排序：有打卡的在前（依當日第一筆打卡時間），沒打卡的在後
    （依名冊順序）；名冊外但當天有事件的 emp_id 補最後（防禦）。與 Code.gs handleMgrDay 同步。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}

    today = today_str()  # 與 date 分開：判斷「今天」的未配對上班卡是否算上班中（A3）
    date = body.get("date") or today

    # 該日每位員工最早一筆事件時間（任何 status 都算「有打卡」，排序用）＋未入帳嘗試次數
    # （A4：status != 'ok' 的事件筆數，rejected_*/pending 都算，供主管頁揭露透明度用）
    first_ts = {}
    attempts_count = {}
    for e in data["events"]:
        if e["ts"][:10] != date:
            continue
        emp = e["emp_id"]
        if emp not in first_ts or e["ts"] < first_ts[emp]:
            first_ts[emp] = e["ts"]
        if e.get("status") != "ok":
            attempts_count[emp] = attempts_count.get(emp, 0) + 1

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

    # 該日 leave 的假別＋時數（姓名→[{type,hours}]；2026-10-26 起一天可多種，與 Code.gs handleMgrDay 同步）
    leaves_by_name = {}
    for l in data.get("leave", []):
        if str(l.get("date", ""))[:10] == date:
            nm = str(l.get("name", "")).strip()
            t = str(l.get("type", "")).strip()
            if not t:
                continue
            h = l.get("hours", "")
            leaves_by_name.setdefault(nm, []).append({"type": t, "hours": "" if h == "" or h is None else h})

    employees = []
    for item in listed:
        emp_id = item["emp_id"]
        has_punch = emp_id in first_ts
        punch = day_punch_segments(data, emp_id, date) if has_punch else None
        # 參考時數：忘刷卡整天留白，與月表／my_recent 同一規則（A3，見 day_reference_incomplete，禁止重寫判斷）
        incomplete = has_punch and day_reference_incomplete(punch["segments"], date, today, working_in_hm(punch))
        rec = latest_approved_record(data, date, emp_id)
        out = {
            "emp_id": emp_id,
            "name": item["name"],
            "segments": punch["segments"] if has_punch else [],
            "reference": punch["reference"] if (has_punch and not incomplete) else None,  # 沒打卡或忘刷卡整天＝參考空白
            "attempts": attempts_count.get(emp_id, 0),  # A4：未入帳嘗試次數（status!='ok'，供主管頁透明化）
            "leaves": leaves_by_name.get(item["name"], []),
            "leave_type": (leaves_by_name.get(item["name"]) or [{}])[0].get("type", ""),
            "leave_hours": (leaves_by_name.get(item["name"]) or [{}])[0].get("hours", ""),
            # 預設上下班時間（2026-08-23）：名冊的 shift_in／shift_out（與 Code.gs handleMgrDay 同步）
            # ⚠ 一定要用 emp_id 重查名冊——直接用 r 會拿到上一個迴圈殘留的那一筆，全部人變同一個班別
            "shift_in": (find_roster_by_empid(data, emp_id) or {}).get("shift_in", ""),
            "shift_out": (find_roster_by_empid(data, emp_id) or {}).get("shift_out", ""),
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

    # 請假註記（2026-10-26 起一天可多種，與 Code.gs handleMgrApprove 同步）：新版送 leaves，舊呼叫端送 leave_type
    multi_leave = isinstance(body.get("leaves"), list)
    raw_leaves = body.get("leaves") if multi_leave else [{"type": body.get("leave_type"), "hours": body.get("leave_hours")}]
    if len(raw_leaves) > 4:
        return {"ok": False, "error": "too_many_leaves", "message": "一天最多記 4 種假別"}
    leaves = []
    for x in raw_leaves:
        x = x or {}
        t = str(x.get("type") or "").strip()
        if not t:
            continue
        # 白名單外的假別再查一次薪酬假別表（mock 用 MOCK_LEAVE_TYPES 代替）才擋
        if t not in LEAVE_TYPES and t not in [m["name"] for m in MOCK_LEAVE_TYPES]:
            return {"ok": False, "error": "bad_leave_type"}
        if any(y["type"] == t for y in leaves):
            return {"ok": False, "error": "dup_leave_type", "message": "同一個假別選了兩次：" + t}
        hv = ""
        if x.get("hours") not in ("", None):
            try:
                hv = float(x.get("hours"))
            except (TypeError, ValueError):
                return {"ok": False, "error": "bad_leave_hours"}
            # B2：float() 對 "nan"/"inf" 字串不會丟例外，要另外擋
            if not math.isfinite(hv) or hv < 0:
                return {"ok": False, "error": "bad_leave_hours"}
            hv = round(hv, 2)
        leaves.append({"type": t, "hours": hv})
    same_day = [l for l in data.get("leave", [])
                if str(l.get("date", ""))[:10] == date and str(l.get("name", "")).strip() == roster["name"]]
    if not multi_leave and len(same_day) > 1:
        return {"ok": False, "error": "multi_leave_day", "message": "這天記了多種假別，請到打卡系統的值班核定頁修改"}
    has_trip = any(x["type"] == "出差" for x in leaves)

    raw_periods = body.get("periods") or []
    if not isinstance(raw_periods, list):
        return {"ok": False, "error": "bad_periods"}

    # 出差時數（2026-10-02，與 Code.gs 同步）：填幾小時認定幾小時，與上班時段相加
    trip_hours = sum(x["hours"] for x in leaves if x["type"] == "出差" and x["hours"] != "")

    if len(raw_periods) == 0:
        # 整天請假：沒時段但要有假別；核定 0 小時、狀態「全天請假」（與 Code.gs 同步）
        if not leaves:
            return {"ok": False, "error": "bad_periods"}
        if has_trip:
            # 整天出差：核定＝出差時數；沒填時數硬擋（與 Code.gs trip_needs_hours 同步）
            if not trip_hours > 0:
                return {"ok": False, "error": "trip_needs_hours"}
            approved_hours = round(trip_hours, 2)
            periods_str = ""
            status_text = "出差"
        else:
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
        approved_hours = float(trip_hours)
        for p in raw_periods:
            start_ms = hm_to_ms(date, p["start"])
            end_ms = hm_to_ms(date, p["end"])
            if end_ms <= start_ms:
                end_ms += 24 * 3600 * 1000  # 跨夜段：end<=start 視為+1天
            periods.append({"start_ms": start_ms, "end_ms": end_ms, "start": p["start"], "end": p["end"]})
            approved_hours += (end_ms - start_ms) / 3600000.0
        # 時段彼此重疊就擋下（與 Code.gs 同步，2026-11-11 Eason 定，B24）；剛好相接不算重疊
        for a in range(len(periods)):
            for b in range(a + 1, len(periods)):
                if periods[a]["start_ms"] < periods[b]["end_ms"] and periods[b]["start_ms"] < periods[a]["end_ms"]:
                    return {"ok": False, "error": "bad_periods",
                            "message": f"核定時段有重疊：{periods[a]['start']}-{periods[a]['end']} 和 "
                                       f"{periods[b]['start']}-{periods[b]['end']}，請改成不重疊的時段"}
        approved_hours = round(approved_hours, 2)

        punch = day_punch_segments(data, emp_id, date)
        punch_segments = []
        for s in punch["segments"]:
            in_ms = hm_to_ms(date, s["in"]) if s["in"] else None
            out_date = add_days_str(date, 1) if s["cross"] else date
            out_ms = hm_to_ms(out_date, s["out"]) if s["out"] else None
            punch_segments.append({"in_ms": in_ms, "out_ms": out_ms})
        # B34（同 Code.gs markWorkingSeg_）：還在上班的那張上班卡（16 小時內）標 working
        w_hm = working_in_hm(punch)
        if w_hm:
            for x in punch_segments:
                if x["out_ms"] is None and x["in_ms"] == hm_to_ms(date, w_hm):
                    x["working"] = True

        status_text = compute_approval_status(
            periods, punch_segments,
            # 剛打完卡 10 分鐘內按到另一顆被擋的（rejected_too_soon，2026-11-11 B33）不算「打卡未入帳」，同 Code.gs unresolvedAttemptCount_
            any(e["emp_id"] == emp_id and e["ts"][:10] == date and e.get("status") not in ("ok", "rejected_too_soon")
                for e in data["events"]))
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
    for x in leaves:
        data["leave"].append({"date": date, "name": roster["name"], "type": x["type"], "hours": x["hours"]})
    save_data(data)

    return {
        "ok": True,
        "date": date,
        "emp_id": emp_id,
        "name": roster["name"],
        "periods": raw_periods,
        "approved_hours": approved_hours,
        "leaves": leaves,
        "leave_type": leaves[0]["type"] if leaves else "",
        "leave_hours": leaves[0]["hours"] if leaves else "",
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

    distance_m = math.floor(haversine_m(STORE_LAT, STORE_LNG, lat, lng) * 10 + 0.5) / 10   # 同 Code.gs Math.round(x*10)/10（.5 進位，不是 Python 的銀行家捨入）
    ts = iso_now()
    # 手機沒給或給了怪值就存 None（舊版前端不帶這欄，不能因此讓打卡失敗）
    try:
        raw_acc = float(body.get("accuracy"))
        accuracy_m = round(raw_acc, 1) if math.isfinite(raw_acc) and raw_acc >= 0 else None
    except (TypeError, ValueError):
        accuracy_m = None
    # 距離扣掉定位誤差後才判定（與 Code.gs 同步）；distance_m 仍存原始距離
    accuracy_credit = 0 if accuracy_m is None else min(accuracy_m, ACCURACY_CREDIT_CAP_M)
    effective_distance_m = max(0, round(distance_m - accuracy_credit, 1))   # 相減後再取到 0.1（同 Code.gs，2026-11-11 B20）
    within_range = effective_distance_m <= RADIUS_M

    # 檢查順序：重複檢查 → 裝置檢查 → 範圍檢查
    last_counted = last_counted_event(data, roster["emp_id"])
    # 同型只擋 10 分鐘（與 Code.gs SAME_TYPE_LOCK_MIN 同步，2026-11-02）
    # 2026-11-11 Eason 定（B33，與 Code.gs 同步）：10 分鐘內另一型也不收（rejected_too_soon）；剛好滿 10 分鐘就收
    lock_left_s = (0 if last_counted is None else
                   SAME_TYPE_LOCK_MIN * 60 - (now_taipei() - datetime.fromisoformat(last_counted["ts"])).total_seconds())
    in_lock = lock_left_s > 0
    is_duplicate = in_lock and last_counted["type"] == type_
    is_too_soon = in_lock and not is_duplicate
    # 單日 10 小時／兩班間隔 11 小時（Rest.gs，與 Code.gs handleClock 的 restBlock 同位置）：只擋上班卡；總開關關著＝None
    rest_block = rest_check_in(data, roster) if (type_ == "in" and not in_lock) else None

    if not roster.get("device_id"):
        roster["device_id"] = device_id
        roster["device_bound_at"] = ts
        device_match = True
    elif roster["device_id"] == device_id:
        device_match = True
    else:
        device_match = False

    # status 優先序：重複 > 剛打完另一型 > 休息不足（rejected_rest，Rest.gs）> 裝置不符 > 超出範圍 > ok（與 Code.gs 同步）
    if is_duplicate:
        status = "rejected_duplicate"
    elif is_too_soon:
        status = "rejected_too_soon"
    elif rest_block:
        status = "rejected_rest"
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
        "accuracy_m": accuracy_m,
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
        "accuracy_m": accuracy_m,
        # 前端用這個決定要不要多給一句「定位可能不準」，門檻不寫死在前端
        "low_accuracy": accuracy_m is not None and accuracy_m > LOW_ACCURACY_M,
    }
    if status == "rejected_duplicate":
        result["last_type"] = last_counted["type"]
    if status == "rejected_too_soon":   # 同 Code.gs：畫面照 message 顯示
        result["last_type"] = last_counted["type"]
        result["wait_min"] = math.ceil(lock_left_s / 60)
        result["message"] = f"剛打完{'上班' if last_counted['type'] == 'in' else '下班'}卡，{result['wait_min']} 分鐘後才能再打卡"
    if rest_block:
        result["rest"] = rest_block   # 同 Code.gs：回 {code:gap|cap, reason, hint, until}
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
        {
            "ts": e["ts"],
            "type": e["type"],
            "status": e["status"],
            "accuracy_m": e.get("accuracy_m"),
            "low_accuracy": e.get("accuracy_m") is not None and e["accuracy_m"] > LOW_ACCURACY_M,
        }
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
        # 店內公告：沒有公告時回空陣列，前端整塊不顯示（與 Code.gs 的 activeNotices 同步）
        "notices": active_notices(data, today),
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


def apply_device_decision(data, emp_id, device_id, approve):
    """裝置核准/拒絕的共用邏輯（與 Code.gs applyDeviceDecision 同步）。"""
    roster = find_roster_by_empid(data, emp_id)
    if not roster:
        return {"ok": False, "error": "invalid_emp_id"}

    # 防呆（2026-08-03，與 Code.gs 同步）：至少要有一筆待核准事件才准動。
    # 否則傳一個不存在的 device_id 會把名冊改綁成假 ID，回應卻是無害的 changed:0。
    matches = [
        e for e in data["events"]
        if e["emp_id"] == emp_id
        and e["device_id"] == device_id
        and e["status"] == "pending_device_approval"
    ]
    if not matches:
        return {"ok": False, "error": "no_pending_device"}

    if approve:
        roster["device_id"] = device_id
        roster["device_bound_at"] = iso_now()

    changed = 0
    for e in matches:
        if approve:
            # 核准只解「裝置」這一關：超出範圍的卡不得因核准而入帳（與 Code.gs 同步）
            e["status"] = "ok" if e.get("within_range") else "rejected_out_of_range"
            e["device_match"] = True
        else:
            e["status"] = "rejected_device"
        changed += 1

    save_data(data)
    return {"ok": True, "changed": changed, "roster": roster}


def handle_approve_device(data, body):
    if not check_admin(body):
        return {"ok": False, "error": "unauthorized"}
    return apply_device_decision(data, body.get("emp_id"), body.get("device_id"), bool(body.get("approve")))


def collect_pending_devices(data):
    """待核准裝置依 員工＋裝置碼 分組（與 Code.gs collectPendingDevices 同步）。"""
    groups = {}
    for e in data["events"]:
        if e["status"] != "pending_device_approval":
            continue
        gk = (e["emp_id"], e["device_id"])
        if gk not in groups:
            roster = find_roster_by_empid(data, e["emp_id"])
            groups[gk] = {
                "emp_id": e["emp_id"],
                "name": roster["name"] if roster else "(不在名冊)",
                "device_id": e["device_id"],
                "first_ts": e["ts"],
                "last_ts": e["ts"],
                "count": 0,
                "all_within_range": True,
                "max_distance_m": 0,
            }
        g = groups[gk]
        g["count"] += 1
        g["first_ts"] = min(g["first_ts"], e["ts"])
        g["last_ts"] = max(g["last_ts"], e["ts"])
        if not e.get("within_range"):
            g["all_within_range"] = False
        d = e.get("distance_m")
        if d is not None and math.isfinite(float(d)) and float(d) > g["max_distance_m"]:
            g["max_distance_m"] = round(float(d), 1)
    return sorted(groups.values(), key=lambda g: g["first_ts"])


def next_emp_id(data):
    """與 Code.gs nextEmpId 同步：抓最常見的「前綴＋數字」格式，取最大值 +1、維持位數。"""
    import re as _re
    pat = {}
    for r in data.get("roster", []):
        m = _re.match(r"^(.*?)(\d+)$", str(r.get("emp_id", "")))
        if not m:
            continue
        k = (m.group(1), len(m.group(2)))
        g = pat.setdefault(k, {"max": 0, "n": 0})
        g["max"] = max(g["max"], int(m.group(2)))
        g["n"] += 1
    if not pat:
        return "E01"
    (prefix, width), g = sorted(pat.items(), key=lambda kv: -kv[1]["n"])[0]
    return prefix + str(g["max"] + 1).zfill(width)


def handle_mgr_add_employee(data, body):
    """{action:'mgr_add_employee', mgr_key, name}（與 Code.gs 同步）。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    name = str(body.get("name", "")).strip()
    if not name:
        return {"ok": False, "error": "name_required", "message": "請輸入同仁姓名"}
    if name == str(mgr["name"]).strip():
        return {"ok": False, "error": "self_add", "message": "不能新增與自己同名的同仁"}
    dup = next((r for r in data["roster"]
                if str(r.get("name", "")).strip() == name and r.get("active")), None)
    if dup:
        return {"ok": False, "error": "duplicate_name",
                "message": f"名冊已經有在職的「{name}」（編號 {dup['emp_id']}）。"
                           "薪資是用姓名對應請假與工時，同名會算錯——"
                           "如果真的是不同人，請改用可區分的名字。"}
    emp_id = next_emp_id(data)
    key = gen_key()
    now = iso_now()
    data["roster"].append({"emp_id": emp_id, "name": name, "key": key, "device_id": "",
                           "device_bound_at": "", "active": True, "shift_in": "", "shift_out": "",
                           "created_at": now, "created_by": mgr["name"]})
    save_data(data)
    return {"ok": True, "emp_id": emp_id, "name": name, "key": key,
            "created_by": mgr["name"], "created_at": now}


def handle_mgr_roster(data, body):
    """{action:'mgr_roster', mgr_key} → 名冊清單（不含 key／device_id，與 Code.gs 同步）。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    roster = [{"emp_id": str(r.get("emp_id")), "name": str(r.get("name")),
               "active": bool(r.get("active")),
               "created_by": str(r.get("created_by") or ""),
               "removed_at": str(r.get("removed_at") or ""),
               "removed_by": str(r.get("removed_by") or "")}
              for r in data["roster"]]
    return {"ok": True, "roster": roster, "manager_name": mgr["name"]}


def handle_mgr_set_active(data, body):
    """{action:'mgr_set_active', mgr_key, emp_id, active} → 設為離職／恢復在職（與 Code.gs 同步）。

    停用不是真刪：打卡事件與核定紀錄都用 emp_id／姓名對應，移除名冊列會讓歷史對不到人。
    """
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    emp_id = str(body.get("emp_id", "")).strip()
    if not emp_id:
        return {"ok": False, "error": "emp_id_required", "message": "請先選擇同仁"}
    row = next((r for r in data["roster"] if str(r.get("emp_id")) == emp_id), None)
    if not row:
        return {"ok": False, "error": "not_found", "message": "名冊裡找不到這位同仁"}
    active = body.get("active") is True or str(body.get("active")).lower() == "true"
    was_active = bool(row.get("active"))
    name = str(row.get("name", "")).strip()
    if not active and name == str(mgr["name"]).strip():
        return {"ok": False, "error": "self_remove", "message": "不能把自己設為離職"}
    if active == was_active:
        return {"ok": True, "unchanged": True, "emp_id": emp_id, "name": name, "active": active}
    if active:
        dup = next((r for r in data["roster"]
                    if str(r.get("emp_id")) != emp_id
                    and str(r.get("name", "")).strip() == name and r.get("active")), None)
        if dup:
            return {"ok": False, "error": "duplicate_name",
                    "message": f"名冊已經有在職的「{name}」（編號 {dup['emp_id']}），"
                               "不能同時有兩位同名在職。"}
    now = iso_now()
    row["active"] = active
    row["removed_at"] = "" if active else now
    row["removed_by"] = "" if active else mgr["name"]
    save_data(data)
    res = {"ok": True, "emp_id": emp_id, "name": name, "active": active,
           "removed_at": row["removed_at"], "removed_by": row["removed_by"]}
    # 2026-11-11 Eason 定（B13，與 Code.gs leftCascadeAfter_／LineHub.gs lineHubLeftCascade_ 同步）：
    # 設離職時，同一支 LINE 在其他店名冊上還在職的列一併設成離職；只認 LINE 完全相同，沒綁 LINE 不做。恢復在職不連帶。
    uid = str(row.get("line_user_id") or "").strip()
    # 支援列（src_store 有值）收掉不連帶停用原單位與其他店（同 Code.gs leftCascadeRun_，獨立審查補）
    if not active and uid and not str(row.get("src_store") or "").strip():
        res["cascade"] = _left_cascade(emp_id, uid, mgr["name"], now)
    return res


def _cur_store_code():
    base = os.path.basename(DATA_FILE)
    return "" if base == "mock_data.json" else base[len("mock_data_"):-len(".json")]


def _left_cascade(src_emp_id, uid, by, now):
    """把其他店名冊上「同一支 LINE、還在職」的列設成離職（B13）。還沒建立資料檔的店＝沒有人，不去碰。"""
    src = _cur_store_code()
    note = "連帶停用：%s 設離職（%s／%s）" % (_hub_store_name(src), src_emp_id, by)
    out = {"ok": True, "stopped": [], "failed": []}
    for code in _hub_store_codes():
        if code == src:
            continue
        path = HUB_STORE_[0] if code == "" else os.path.join(BASE_DIR, "mock_data_%s.json" % code)
        if not os.path.exists(path):
            continue
        with store_context(code):
            sd = load_data()
            hit = [r for r in sd.get("roster", [])
                   if str(r.get("active")).lower() == "true" and str(r.get("line_user_id") or "").strip() == uid]
            for r in hit:
                r["active"] = False
                r["removed_at"] = now
                r["removed_by"] = note
                out["stopped"].append({"store_name": _hub_store_name(code), "emp_id": str(r["emp_id"]), "name": str(r["name"])})
            if hit:
                save_data(sd)
    return out


# ── 店內公告（2026-08-28，與 Code.gs 的 activeNotices／handleMgrNotices… 同步）──
NOTICE_MAX_SHOW = 5
NOTICE_MAX_LEN = 120


def active_notices(data, today=None):
    """同仁端要顯示的公告：啟用中、未過下架日，新的排前面，最多 NOTICE_MAX_SHOW 則。"""
    t = today or today_str()
    rows = [
        n for n in data.get("notices", [])
        if n.get("active") and str(n.get("text", "")).strip()
        and (not n.get("ends_on") or str(n["ends_on"]) >= t)
    ]
    rows.sort(key=lambda n: str(n.get("created_at", "")), reverse=True)
    return [{"id": n["id"], "text": str(n["text"]).strip()} for n in rows[:NOTICE_MAX_SHOW]]


def _notice_auth(data, body):
    return find_manager_by_key(data, body.get("mgr_key"))


def handle_mgr_notices(data, body):
    mgr = _notice_auth(data, body)
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    today = today_str()
    rows = []
    for n in data.get("notices", []):
        ends = str(n.get("ends_on") or "")
        rows.append({
            "id": n["id"],
            "text": str(n.get("text", "")).strip(),
            "active": bool(n.get("active")),
            "ends_on": ends,
            "expired": bool(ends and ends < today),
            "created_at": n.get("created_at", ""),
            "created_by": n.get("created_by", ""),
        })
    rows.sort(key=lambda n: str(n.get("created_at", "")), reverse=True)
    return {"ok": True, "notices": rows, "max_len": NOTICE_MAX_LEN, "max_show": NOTICE_MAX_SHOW}


def handle_mgr_add_notice(data, body):
    mgr = _notice_auth(data, body)
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    text = str(body.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "text_required", "message": "請先輸入公告內容"}
    if len(text) > NOTICE_MAX_LEN:
        return {"ok": False, "error": "text_too_long",
                "message": f"公告最多 {NOTICE_MAX_LEN} 個字（目前 {len(text)} 個字）"}
    ends_on = str(body.get("ends_on") or "").strip()
    if ends_on and not re.match(r"^\d{4}-\d{2}-\d{2}$", ends_on):
        return {"ok": False, "error": "bad_ends_on", "message": "下架日期格式不對"}
    today = today_str()
    if ends_on and ends_on < today:
        return {"ok": False, "error": "ends_on_past", "message": "下架日期已經過了，這則公告發出來不會顯示"}

    nid = "N" + str(int(time.time() * 1000))
    created_at = iso_now()
    data.setdefault("notices", []).append({
        "id": nid, "text": text, "active": True, "ends_on": ends_on,
        "created_at": created_at, "created_by": mgr.get("name", ""),
    })
    save_data(data)
    return {"ok": True, "id": nid, "text": text, "ends_on": ends_on,
            "created_at": created_at, "created_by": mgr.get("name", "")}


def handle_mgr_set_notice_active(data, body):
    mgr = _notice_auth(data, body)
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    nid = str(body.get("id") or "").strip()
    if not nid:
        return {"ok": False, "error": "id_required"}
    for n in data.get("notices", []):
        if str(n["id"]) == nid:
            n["active"] = body.get("active") is True or str(body.get("active")).lower() == "true"
            save_data(data)
            return {"ok": True, "id": nid, "active": n["active"]}
    return {"ok": False, "error": "not_found", "message": "找不到這則公告"}


def handle_mgr_pending_devices(data, body):
    """{action:'mgr_pending_devices', mgr_key} → 待核准裝置清單（與 Code.gs 同步）。"""
    if not find_manager_by_key(data, body.get("mgr_key")):
        return {"ok": False, "error": "unauthorized"}
    return {"ok": True, "pending": collect_pending_devices(data)}


def handle_mgr_pending_approvals(data, body):
    """{action:'mgr_pending_approvals', mgr_key} → 本月「有上班但主管還沒核定」清單，依日期分組
    （與 Code.gs handleMgrPendingApprovals 同步，2026-09-18 新增）。對象：本月 events 出現過的
    所有 emp_id（含停用／離職）；姓名一律從 roster 對（不論 active），對不到就用 emp_id 頂替。"""
    if not find_manager_by_key(data, body.get("mgr_key")):
        return {"ok": False, "error": "unauthorized"}

    ym = now_taipei().strftime("%Y-%m")
    today = today_str()

    emp_ids = sorted({e["emp_id"] for e in data["events"] if e["ts"][:7] == ym})

    items = []
    for emp_id in emp_ids:
        roster = find_roster_by_empid(data, emp_id)
        name = roster["name"] if roster else emp_id
        for d in month_pending_approval_dates(data, emp_id, ym, today):
            items.append({"date": d, "emp_id": emp_id, "name": name})

    items.sort(key=lambda x: (x["date"], x["name"]))
    return {"ok": True, "ym": ym, "today": today, "items": items}


def handle_mgr_device_decision(data, body):
    """{action:'mgr_device_decision', mgr_key, emp_id, device_id, approve}（與 Code.gs 同步）。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    result = apply_device_decision(data, body.get("emp_id"), body.get("device_id"), bool(body.get("approve")))
    if result.get("ok"):
        result["manager_name"] = mgr["name"]
    return result


# ---------------------------------------------------------------------------
# LIFF 身分層（本機模擬）—— 與 apps-script/Liff.gs 實作同一套合約，行為與
# 錯誤碼須完全一致。正式環境驗 ID token 要打 LINE API，本機不打，改用假 token
# 直接解出 userId，其餘（找員工、雙向檢查、轉接既有 handler）邏輯照抄 Liff.gs。
# ---------------------------------------------------------------------------
MOCK_TOKEN_PREFIX = "MOCK_ID_TOKEN_"


def mock_verify_id_token(id_token):
    """本機測試用：不打 LINE API，直接從假 token 解出 userId。
    格式 MOCK_ID_TOKEN_<userId>，不符格式一律回 None（與 Liff.gs verifyLineIdToken_ 同一角色）。"""
    if not id_token or not id_token.startswith(MOCK_TOKEN_PREFIX):
        return None
    uid = id_token[len(MOCK_TOKEN_PREFIX):]
    return uid or None


def find_roster_by_line_user(data, user_id):
    """用 LINE userId 查在職員工（與 Liff.gs findRosterByLineUser_ 同步）。
    空 userId 一律查不到，否則會比對到未綁定者的空欄位。"""
    if not user_id:
        return None
    for r in data.get("roster") or []:
        if str(r.get("line_user_id")) == str(user_id) and r.get("active", False):
            return r
    return None


def log_liff_bind(data, emp_id, name, user_id):
    """綁定稽核紀錄（2026-08-27 審查 Important 6，與 Liff.gs logLiffBind_ 同步）。
    刻意獨立於 events 之外，不塞進去——理由同 Liff.gs 的註解：events 是 pair_shifts／
    今日時數／今日紀錄的資料來源，混進非打卡列會被那些既有邏輯一起讀到；而且獨立分頁
    才不會讓「刪除 Liff.gs 即回到原狀」的回退承諾被殘留資料破壞。"""
    data.setdefault("liff_bind_log", []).append({
        "ts": iso_now(),
        "emp_id": emp_id,
        "name": name,
        "line_user_id": user_id,
        "type": "bind",
    })


def handle_liff_bind(data, body):
    """{action:'liff_bind', id_token, key} → 把 LINE 帳號與員工對上
    （與 Liff.gs handleLiffBind_ 同步：驗 token → 用 key 找在職員工 → 雙向檢查 → 寫入）。
    任何失敗路徑都不可寫入，成功路徑才呼叫 save_data。"""
    user_id = mock_verify_id_token(body.get("id_token"))
    if not user_id:
        return {"ok": False, "error": "invalid_id_token"}

    if data.get("roster") is None:
        return {"ok": False, "error": "no_roster"}

    # 這個 LINE 帳號是否已經綁在別的員工身上？
    # ⚠ 2026-08-27 審查 Important 4：要看「所有列」，不能只看在職——與 Liff.gs 的
    # anyExisting 同步（原本的 find_roster_by_line_user 只比對 active，離職列上殘留的
    # userId 之後被復職會變成兩個在職列共用一個 userId，見 Liff.gs 註解的完整情境說明）。
    all_existing = [r for r in (data.get("roster") or [])
                    if r.get("line_user_id") and str(r["line_user_id"]) == str(user_id)]

    target = find_roster_by_key(data, body.get("key"))
    if not target or not target.get("active", False):
        return {"ok": False, "error": "invalid_key"}

    # 2026-11-11 Eason 定（B25，與 Liff.gs liffBindLocked_ 同步）：這支 LINE 還留在本人「同一家店、同名（去掉全部空白）、
    # 已離職」的舊列上 → 不擋，自動移到新列；只要還綁著任何一列在職或不同名的別人，照舊整個擋下。
    others = [r for r in all_existing if str(r["emp_id"]) != str(target["emp_id"])]
    _nn = lambda v: re.sub(r"[\s\u3000]", "", str(v or ""))
    want_name = _nn(target.get("name"))
    movable = bool(others) and want_name != "" and all(
        str(r.get("active")).lower() != "true" and _nn(r.get("name")) == want_name for r in others)
    if others and not movable:
        return {"ok": False, "error": "line_account_in_use"}

    # 該員工已綁了另一個 LINE 帳號 → 要店長先解綁，避免默默換人
    if target.get("line_user_id") and str(target["line_user_id"]) != str(user_id):
        return {"ok": False, "error": "already_bound_other_user"}

    # 已經是綁好的同一組，直接回成功（同仁重按不該報錯，也不該重寫，也不該記稽核紀錄）
    if str(target.get("line_user_id")) == str(user_id):
        return {"ok": True, "name": target["name"], "emp_id": target["emp_id"], "already": True}

    for old in others:   # B25：舊列的 LINE 清掉，記一筆「由舊列（工號）移來」
        old["line_user_id"] = ""
        old["line_bound_at"] = ""
        log_liff_bind(data, target["emp_id"], target["name"], user_id)
        data["liff_bind_log"][-1]["type"] = "moved_from:" + str(old["emp_id"])
    target["line_user_id"] = user_id
    target["line_bound_at"] = iso_now()
    log_liff_bind(data, target["emp_id"], target["name"], user_id)
    save_data(data)
    return {"ok": True, "name": target["name"], "emp_id": target["emp_id"]}


def with_line_identity(data, body, inner_handler):
    """轉接：把「LINE 身分」換成「既有的 key 身分」，再呼叫原本的 handler
    （與 Liff.gs withLineIdentity_ 同步）。id_token 與 action 不可流進既有邏輯。
    唯讀查身分，這條路徑不寫入。"""
    user_id = mock_verify_id_token(body.get("id_token"))
    if not user_id:
        return {"ok": False, "error": "invalid_id_token"}

    if data.get("roster") is None:
        return {"ok": False, "error": "no_roster"}

    # ⚠ 2026-08-27 審查 Important 4：fail closed，與 Liff.gs withLineIdentity_ 同步——
    # 一個 userId 命中兩個在職列違反不變量，理論上已被 handle_liff_bind 的 any_existing
    # 檢查擋住；萬一資料還是壞了，明確回錯，不要悄悄取第一筆。
    active_matches = [
        r for r in (data.get("roster") or [])
        if r.get("line_user_id") and str(r["line_user_id"]) == str(user_id)
        and r.get("active", False)
    ]
    if len(active_matches) > 1:
        return {"ok": False, "error": "line_identity_conflict"}
    roster = active_matches[0] if active_matches else None
    if not roster:
        return {"ok": False, "error": "not_bound"}

    inner = {k: v for k, v in body.items() if k not in ("id_token", "action")}
    inner["key"] = roster["key"]
    return inner_handler(data, inner)


def handle_liff_whoami(data, body):
    return with_line_identity(data, body, handle_whoami)


def handle_liff_clock(data, body):
    return with_line_identity(data, body, handle_clock)


def handle_liff_my_recent(data, body):
    return with_line_identity(data, body, handle_my_recent)


ACTIONS = {
    "clock": handle_clock,
    "whoami": handle_whoami,
    "sync_roster": handle_sync_roster,
    "get_roster": handle_get_roster,
    "get_events": handle_get_events,
    "approve_device": handle_approve_device,
    "my_recent": handle_my_recent,
    "mgr_day": handle_mgr_day,
    "mgr_add_employee": handle_mgr_add_employee,
    "mgr_roster": handle_mgr_roster,
    "mgr_set_active": handle_mgr_set_active,
    "payroll_leave_options": handle_payroll_leave_options,
    "mgr_approve": handle_mgr_approve,
    "mgr_pending_devices": handle_mgr_pending_devices,
    "mgr_pending_approvals": handle_mgr_pending_approvals,
    "mgr_device_decision": handle_mgr_device_decision,
    "liff_bind": handle_liff_bind,
    "liff_whoami": handle_liff_whoami,
    "liff_clock": handle_liff_clock,
    "liff_my_recent": handle_liff_my_recent,
    "mgr_notices": handle_mgr_notices,
    "mgr_add_notice": handle_mgr_add_notice,
    "mgr_set_notice_active": handle_mgr_set_notice_active,
}

# 薪酬模組的假後端（e2e 專用，見 mock/payroll_mock_handlers.py 的說明）。
# 找不到就略過，讓原本的打卡 mock 照常運作。
try:
    from payroll_mock_handlers import PAYROLL_ACTIONS
    ACTIONS.update(PAYROLL_ACTIONS)

    # ⚠ 薪酬假後端的寫入原本只改記憶體、不存檔（每個請求都重新 load_data），
    #   「存了、重新整理就不見」這類 bug 在本機永遠測不出來。紅字天數先補上存檔（2026-09-18）。
    def _persist(fn):
        def run(data, body):
            out = fn(data, body)
            if isinstance(out, dict) and out.get('ok'):
                save_data(data)
            return out
        return run
    ACTIONS['payroll_holiday_set'] = _persist(ACTIONS['payroll_holiday_set'])
    ACTIONS['payroll_holiday_sync'] = _persist(ACTIONS['payroll_holiday_sync'])
    # 差異清單「帶入／停用」要看得到寫入結果（2026-10-28）
    ACTIONS['payroll_master_set'] = _persist(ACTIONS['payroll_master_set'])
    # 跨店支援自動帶入（2026-11-05）：對照同步、差異決定要看得到寫入結果
    ACTIONS['payroll_xmap_set'] = _persist(ACTIONS['payroll_xmap_set'])
    ACTIONS['payroll_support_decide'] = _persist(ACTIONS['payroll_support_decide'])
except ImportError:
    pass
ACTIONS['payroll_attendance_export'] = handle_payroll_attendance_export

# ── LINE 單一打卡入口的集中服務（對應 apps-script/LineHub.gs，只掛在 /api＝光復）──
def _hub_store_codes():
    return [""] + list(STORE_TABLE.keys())


def _hub_store_name(code):
    return "小辛辣 新竹光復" if code == "" else STORE_TABLE[code]["name"]


def _hub_all_rosters():
    out = {}
    for code in _hub_store_codes():
        with store_context(code):   # '' 明確切到光復（在別家店的請求裡呼叫時才不會讀到那家店自己的檔）
            out[code] = load_data().get("roster", [])
    return out


def _hub_active(r):
    return str(r.get("active")).lower() == "true"


def _hub_pick(lat, lng, acc):
    """與 clock-line-core.js／LineHub.gs 同一套挑店規則。"""
    stores = [{"code": "", "name": _hub_store_name(""), "lat": STORE_LAT, "lng": STORE_LNG, "radius_m": RADIUS_M}] + \
             [dict(v, code=k) for k, v in STORE_TABLE.items()]
    r1 = lambda v: math.floor(v * 10 + 0.5) / 10
    a = r1(acc) if isinstance(acc, (int, float)) and acc >= 0 else 0
    hits, nearest, nd = [], None, float("inf")
    for st in stores:
        d = haversine_m(lat, lng, st["lat"], st["lng"])
        if d < nd:
            nd, nearest = d, st
        if max(0, r1(d) - min(a, ACCURACY_CREDIT_CAP_M)) <= st["radius_m"]:
            hits.append(st)
    if len(hits) == 1:
        return "ok", hits[0], nd
    if len(hits) > 1:
        return "ambiguous", None, nd
    return "none", nearest, nd


def _norm_name(s):
    return "".join(str(s or "").split()).replace("\u3000", "")


def handle_line_quick_clock(data, body):
    uid = mock_verify_id_token(body.get("id_token"))
    if not uid:
        return {"ok": False, "error": "invalid_id_token"}
    status, st, d = _hub_pick(float(body["lat"]), float(body["lng"]), body.get("accuracy"))
    if status == "ambiguous":
        res = {"ok": False, "reason": "定位不夠準，分不出你在哪一家店", "hint": "請開啟手機的「精確位置」與 Wi‑Fi 後再按一次"}
    elif status == "none":
        res = {"ok": False, "reason": f"你不在任何打卡地點範圍內（最近的是{st['name']}，約 {round(d)} 公尺）",
               "hint": "人在店裡的話，請開啟「精確位置」與 Wi‑Fi 後再按一次"}
    else:
        with store_context(st["code"] or None):
            sd = load_data()
            me = next((r for r in sd["roster"] if _hub_active(r) and r.get("line_user_id") == uid), None)
            if not me:
                res = {"ok": False, "code": "not_bound", "store_name": st["name"],
                       "reason": f"你的 LINE 帳號還沒有綁定「{st['name']}」", "hint": "請在打卡畫面輸入你的全名完成綁定"}
            else:
                last = last_counted_event(sd, me["emp_id"])
                typ = "out" if last and last["type"] == "in" else "in"
                if body.get("type") in ("in", "out"):
                    typ = body["type"]   # 同仁手選（與 LineHub.gs 同：打完任一張 10 分鐘內兩顆都鎖，2026-11-02）
                left = None
                if last:
                    lt = datetime.fromisoformat(last["ts"])
                    left = (lt + timedelta(minutes=10) - now_taipei()).total_seconds()
                if left is not None and left > 0:
                    res = {"ok": False, "type": typ, "store_name": st["name"],
                           "reason": f"你 {last['ts'][11:16]} 剛打過{'上班' if last['type'] == 'in' else '下班'}卡，{math.ceil(left / 60)} 分鐘內不能再打（避免連按誤打）",
                           "hint": "真的要" + ("下班" if typ == "out" else "上班") + "請告知主管補登"}
                else:
                    j = handle_liff_clock(sd, {"action": "liff_clock", "id_token": body["id_token"], "type": typ,
                                               "lat": body["lat"], "lng": body["lng"], "accuracy": body.get("accuracy"),
                                               "device_id": me.get("device_id") or ("line:" + uid)})
                    res = ({"ok": True, "type": typ, "ts": j.get("ts"), "store_name": st["name"]} if j.get("ok") and j.get("status") == "ok"
                           else {"ok": False, "type": typ, "store_name": st["name"], "reason": "系統回覆：" + str(j.get("status") or j.get("error")), "hint": "請告知主管"})
    label = {"in": "上班", "out": "下班"}.get(res.get("type"), "")
    text = (f"✅ {label}打卡成功 {str(res.get('ts'))[11:16]}\n地點：{res['store_name']}" if res["ok"]
            else f"❌ {label}打卡失敗\n原因：{res['reason']}" + (f"\n怎麼辦：{res['hint']}" if res.get("hint") else ""))
    return {"ok": True, "result": res, "text": text}


def handle_line_bind_name(data, body):
    uid = mock_verify_id_token(body.get("id_token"))
    if not uid:
        return {"ok": False, "error": "invalid_id_token"}
    want = _norm_name(body.get("name"))
    if not want:
        return {"ok": False, "error": "empty_name", "message": "請輸入你的全名"}
    status, st, _d = _hub_pick(float(body["lat"]), float(body["lng"]), body.get("accuracy"))
    if status != "ok":   # 字句同 LineHub.gs handleLineBindName_（2026-11-03 對齊）
        return {"ok": False, "error": "not_at_store", "message": "定位不夠準，分不出你在哪一家店。請開啟「精確位置」與 Wi‑Fi 後再試。" if status == "ambiguous"
                else "綁定要人在店裡：請到你上班的店再試一次（目前定位不在任何打卡地點範圍內）。"}
    with store_context(st["code"] or None):
        sd = load_data()
        hit = [r for r in sd["roster"] if _hub_active(r) and _norm_name(r["name"]) == want]
        if not hit:
            return {"ok": False, "error": "name_not_found", "store_name": st["name"],
                    "message": f"「{st['name']}」的名冊上沒有「{str(body.get('name') or '').strip()}」。請確認是全名、沒有錯字；名冊上沒有你請主管把你加進去。"}
        if len(hit) > 1:
            return {"ok": False, "error": "name_conflict", "message": f"「{st['name']}」有兩位同名同仁，請找主管協助綁定。"}
        row = hit[0]
        if row.get("line_user_id") and row["line_user_id"] != uid:
            return {"ok": False, "error": "name_taken", "message": f"「{row['name']}」已經綁定別的 LINE 帳號。如果那不是你，請立刻告知主管在值班核定頁解除。"}
        if row.get("line_user_id") == uid:
            return {"ok": True, "already": True, "store_name": st["name"], "name": row["name"]}
        j = handle_liff_bind(sd, {"action": "liff_bind", "id_token": body["id_token"], "key": row["key"]})
        if not j.get("ok"):
            return {"ok": False, "error": j.get("error"), "message": "綁定沒有成功：" + str(j.get("error"))}
        # 與 LineHub.gs handleLineBindName_ 同步：via 由伺服器自己判斷（不信前端）——這個 LINE 在別家店已綁定同名＝跨店（auto），否則＝輸入全名（name）
        same_elsewhere = any(_hub_active(r) and r.get("line_user_id") == uid and _norm_name(r["name"]) == want
                             for code, rows in _hub_all_rosters().items() if code != (st["code"] or "") for r in rows)
        sd2 = load_data()
        if sd2.get("liff_bind_log"):
            sd2["liff_bind_log"][-1]["type"] = "bind_auto" if same_elsewhere else "bind_name"
            save_data(sd2)
        return {"ok": True, "store_name": st["name"], "name": row["name"]}


def handle_mgr_line_binds(data, body):
    """與 Liff.gs handleMgrLineBinds_ 同步（mock 不篩 30 天）。"""
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    bound = {r["emp_id"]: r.get("line_user_id") for r in data["roster"] if r.get("line_user_id")}
    # from_store（2026-11-11 B12，同 Liff.gs liffBindTypeParts_）：類型 bind_name@店名＝在別家店輸入全名綁的，拆成 type＋from_store
    def _parts(t):
        t = str(t or "bind")
        return ("bind_name", t[10:]) if t.startswith("bind_name@") else (t, "")
    items = [{"ts": x["ts"], "emp_id": x["emp_id"], "name": x["name"], "type": _parts(x.get("type"))[0], "from_store": _parts(x.get("type"))[1],
              "still_bound": str(x.get("type", "bind")).startswith("bind") and bound.get(x["emp_id"]) == x.get("line_user_id")}
             for x in data.get("liff_bind_log", [])]
    return {"ok": True, "days": 30, "items": list(reversed(items))}


def handle_mgr_line_unbind(data, body):
    mgr = find_manager_by_key(data, body.get("mgr_key"))
    if not mgr:
        return {"ok": False, "error": "unauthorized"}
    row = find_roster_by_empid(data, body.get("emp_id"))
    if not row:
        return {"ok": False, "error": "not_found"}
    if not row.get("line_user_id"):
        return {"ok": True, "already": True}
    data.setdefault("liff_bind_log", []).append({"ts": iso_now(), "emp_id": row["emp_id"], "name": row["name"],
                                                 "line_user_id": row["line_user_id"], "type": "unbind_by:" + mgr["name"]})
    row["line_user_id"] = ""
    row["line_bound_at"] = ""
    save_data(data)
    return {"ok": True}


ACTIONS["mgr_line_binds"] = handle_mgr_line_binds
ACTIONS["mgr_line_unbind"] = handle_mgr_line_unbind


def handle_line_hub_status(data, body):
    uid = mock_verify_id_token(body.get("id_token"))
    if not uid:
        return {"ok": False, "error": "invalid_id_token"}
    status, st, d = _hub_pick(float(body["lat"]), float(body["lng"]), body.get("accuracy"))
    if status == "ambiguous":
        return {"ok": True, "status": "fail", "result": {"ok": False, "code": "ambiguous", "reason": "定位不夠準，分不出你在哪一家店", "hint": "請開啟精確位置"}}
    if status == "none":
        return {"ok": True, "status": "fail", "result": {"ok": False, "code": "out_of_range",
                "reason": f"你不在任何打卡地點範圍內（最近的是{st['name']}，約 {round(d)} 公尺）", "hint": "人在店裡的話請開啟精確位置",
                "nearest": {"name": st["name"], "lat": st["lat"], "lng": st["lng"], "radius_m": st["radius_m"]}}}
    with store_context(st["code"] or None):
        sd = load_data()
        me = next((r for r in sd["roster"] if _hub_active(r) and r.get("line_user_id") == uid), None)
        if not me:
            # 跨店同名建議（同 LineHub.gs lineHubResolve_）：這個 LINE 在別家店已綁定、名字唯一，這家店名冊有同名且還沒被綁的在職同仁 → 帶出名字請本人確認
            suggest = ""
            names = {}
            for code, rows in _hub_all_rosters().items():
                for r in rows:
                    if _hub_active(r) and r.get("line_user_id") == uid:
                        names[_norm_name(r["name"])] = r["name"]
            if len(names) == 1:
                key = next(iter(names))
                cand = [r for r in sd["roster"] if _hub_active(r) and _norm_name(r["name"]) == key]
                if len(cand) == 1 and not cand[0].get("line_user_id"):
                    suggest = names[key]
            return {"ok": True, "status": "fail", "result": {"ok": False, "code": "not_bound", "store_name": st["name"], "suggest_name": suggest,
                    "reason": f"你的 LINE 帳號還沒有綁定「{st['name']}」", "hint": "請在打卡畫面輸入你的全名完成綁定；名冊上沒有你請主管把你加進去"}}
        today = today_str()
        evs = [{"type": e["type"], "hm": e["ts"][11:16], "status": e["status"]} for e in sd["events"]
               if e["emp_id"] == me["emp_id"] and e["ts"][:10] == today]
        g = _liff_guard(sd, me["emp_id"])
        return {"ok": True, "status": "ready", "name": me["name"],
                "store": {"code": st["code"], "name": st["name"], "lat": st["lat"], "lng": st["lng"], "radius_m": st["radius_m"]},
                "shift_in": me.get("shift_in", ""), "shift_out": me.get("shift_out", ""), "today": evs,
                "guard": dict(g, now=time.time() * 1000)}



# ── 方案 C（2026-10-08）：打卡畫面直接打各店（與 Liff.gs liff_status／liff_punch／export_tables 同步）──
def _liff_greetings():
    """問候語字句直接從 Liff.gs 讀，避免 mock 自己抄一份而漂移。"""
    import re as _re
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps-script", "Liff.gs"), encoding="utf-8").read()
    blk = src[src.index("var LIFF_GREETINGS = {") + len("var LIFF_GREETINGS = "):]
    blk = blk[:blk.index("\n};") + 2]
    blk = _re.sub(r"(\b(?:in|out|morning|afternoon|evening)):", r'"\1":', blk)
    import ast
    return ast.literal_eval(blk)   # 字句含撇號也不會壞（審查 #6）


LIFF_GREETINGS = _liff_greetings()


def liff_greeting(typ, ts):
    s = str(ts or "")
    try:
        h = int(s[11:13])
    except ValueError:
        return ""
    st = LIFF_GREETINGS.get(typ)
    if not st:
        return ""
    lst = st["morning"] if 5 <= h < 12 else st["afternoon"] if 12 <= h < 18 else st["evening"]
    return lst[sum(ord(c) for c in s) % len(lst)]   # JS charCodeAt 對 BMP 內字元相同；ts 只有 ASCII


def _liff_me(data, body):
    uid = mock_verify_id_token(body.get("id_token"))
    if not uid:
        return None, None, {"ok": False, "error": "invalid_id_token"}
    hits = [r for r in (data.get("roster") or []) if r.get("line_user_id") == uid and r.get("active", False)]
    if len(hits) > 1:
        return None, None, {"ok": False, "error": "line_identity_conflict"}
    if not hits:
        return None, None, {"ok": False, "error": "not_bound"}
    return uid, hits[0], None


def _liff_guard(data, emp_id):
    last = last_counted_event(data, emp_id)
    lock, blocked = {}, None
    if last:
        until = datetime.fromisoformat(last["ts"]).timestamp() * 1000 + 600000
        lock = {"in": until, "out": until}   # 打完任一張，10 分鐘內兩顆都鎖（Liff.gs liffGuard_，2026-11-02）
        if until > time.time() * 1000:
            blocked = last["type"]
    return {"blocked": blocked, "lock": lock,
            "last": {"type": last["type"], "hm": last["ts"][11:16], "ts": last["ts"]} if last else None}


# ── 單日 10 小時／兩班間隔 11 小時擋上班卡（2026-11-03 補進 mock，對應 apps-script/Rest.gs）──
# 正式版：restSegments_／restJudge_／restPeerEvents_／restCheckIn_／restStatus_／handleRestRuleSet_。
# 總開關：正式版是各店指令碼屬性 REST_RULE_ON＝'1'；mock 用各店資料檔的 "rest_rule_on": "1"（rest_rule_set 動作可開關）。
# 跨店：正式版照姓名去空白讀 RestConfig 的各店試算表；mock 讀其他店的 mock_data*.json 名冊同名在職者的 events。
REST_DAY_MAX_H = 10
REST_GAP_H = 11
REST_PAIR_H = 16
REST_LOOKBACK_H = 40


def _rest_on(data):
    return str(data.get("rest_rule_on") or "") == "1"


def _rest_ms(ts):
    try:
        return datetime.fromisoformat(str(ts)).timestamp() * 1000
    except (TypeError, ValueError):
        return None


def _rest_day(ms):
    return datetime.fromtimestamp(ms / 1000, TAIPEI_TZ).strftime("%Y-%m-%d")


def _rest_hm(ms):
    return datetime.fromtimestamp(ms / 1000, TAIPEI_TZ).strftime("%H:%M")


def _rest_md(ms):
    d = datetime.fromtimestamp(ms / 1000, TAIPEI_TZ)
    return f"{d.month}/{d.day}"


def _js_round1(h):
    """JS Math.round(h*10)/10 再照 JS 數字顯示（整數不帶 .0）"""
    v = math.floor(h * 10 + 0.5) / 10
    return str(int(v)) if v == int(v) else str(v)


def rest_segments(evs):
    """同 Rest.gs restSegments_：算數＝非 rejected_*；上班接上班＝前一張沒下班（不成立）；16 小時內的下班卡才配成一段。
    前面沒有上班卡的下班卡（2026-11-11 B07）：當成只知道結束時間的一段（時數 0；凌晨 06:00 前的歸前一天）。"""
    lst = []
    for e in evs:
        if e.get("type") not in ("in", "out") or str(e.get("status") or "").startswith("rejected_"):
            continue
        ms = _rest_ms(e.get("ts"))
        if ms is None:
            continue
        lst.append((ms, e["type"]))
    lst.sort(key=lambda x: x[0])
    segs, open_ = [], None
    for ms, typ in lst:
        if typ == "in":
            open_ = ms
            continue
        if open_ is not None and ms - open_ <= REST_PAIR_H * 3600000:
            segs.append({"in": open_, "out": ms})
        elif open_ is None:   # 前面有上班卡但超過 16 小時配不成段的，照舊不算
            segs.append({"in": ms, "out": ms, "lone": True, "day": _rest_day(ms - 86400000) if _rest_hm(ms) <= "06:00" else _rest_day(ms)})
        open_ = None
    return segs


def rest_judge(segs, now_ms):
    """同 Rest.gs restJudge_：回 None（可以打）或 {code:'cap'|'gap', reason, hint, until}。"""
    today = _rest_day(now_ms)
    done = [s for s in segs if s["out"] <= now_ms]
    if not done:
        return None
    todays = [s for s in done if not s.get("lone") and _rest_day(s["in"]) == today]
    if todays:
        h = sum(s["out"] - s["in"] for s in todays) / 3600000
        if h >= REST_DAY_MAX_H:
            return {"code": "cap", "warn": True, "reason": f"你今天已經上班 {_js_round1(h)} 小時（一天最多 {REST_DAY_MAX_H} 小時）",
                    "hint": "再上班會超過 10 小時，請先跟店長確認", "until": None}   # 2026-11-06 起只提醒
        return None   # 同一天的第二段不看間隔
    ends = [s for s in done if not s.get("lone") or s["day"] < today]   # 今天的孤單下班卡不算上一段的結束
    if not ends:
        return None
    last = ends[-1]
    until = last["out"] + REST_GAP_H * 3600000
    if now_ms >= until:
        return None
    same_day = _rest_day(until) == today
    when = "今天 " if _rest_day(last["out"]) == today else " " + _rest_md(last["out"]) + " "
    return {"code": "gap", "reason": f"你{when}{_rest_hm(last['out'])} 下班，兩班要隔 {REST_GAP_H} 小時，"
                                     f"{'' if same_day else _rest_md(until) + ' '}{_rest_hm(until)} 以後才能打上班卡",
            "hint": "有問題請找值班主管", "until": until}


def _current_store_code():
    """store_context 目前切到哪家店（'' ＝光復）。"""
    base = os.path.basename(DATA_FILE)
    return base[len("mock_data_"):-len(".json")] if base.startswith("mock_data_") else ""


def rest_peer_events(name, since_ms):
    """同 Rest.gs restPeerEvents_：別家店同名（去空白）在職同仁近 40 小時的打卡；哪家讀不到就跳過。"""
    out, nm, me_code = [], _norm_name(name), _current_store_code()
    if not nm:
        return out
    for code in _hub_store_codes():
        if code == me_code:
            continue
        try:
            with store_context(code):
                sd = load_data()
                ids = [str(r["emp_id"]) for r in sd.get("roster", []) if _hub_active(r) and _norm_name(r.get("name")) == nm]
                if not ids:
                    continue
                for e in sd.get("events", []):
                    ms = _rest_ms(e.get("ts"))
                    if str(e.get("emp_id")) in ids and ms is not None and ms >= since_ms:
                        out.append({"ts": e["ts"], "type": e["type"], "status": e.get("status"), "store": code})
        except Exception:   # noqa: BLE001 - 讀不到的店跳過（同正式版）
            continue
    return out


REST_LAST_WARN = None   # 同 Rest.gs REST_LAST_WARN_：滿 10 小時只提醒，不從回傳值出去


def rest_check_in(data, roster, now_ms=None):
    """同 Rest.gs restCheckIn_：總開關關著、或任何錯誤都回 None（不擋）；滿 10 小時（cap）回 None、結果放 REST_LAST_WARN。"""
    global REST_LAST_WARN
    REST_LAST_WARN = None
    if not _rest_on(data):
        return None
    try:
        now = now_ms or time.time() * 1000
        since = now - REST_LOOKBACK_H * 3600000
        mine = [e for e in data.get("events", []) if str(e.get("emp_id")) == str(roster["emp_id"])
                and (_rest_ms(e.get("ts")) or 0) >= since]
        r = rest_judge(rest_segments(mine + rest_peer_events(roster.get("name"), since)), now)
        if r and r.get("warn"):
            REST_LAST_WARN = r
            return None
        return r
    except Exception:   # noqa: BLE001
        return None


def rest_status(data, roster):
    """同 Rest.gs restStatus_（liff_status 用）。"""
    r = rest_check_in(data, roster)
    if r:
        return {"blocked": True, "code": r["code"], "reason": r["reason"], "hint": r["hint"], "until": r["until"]}
    w = REST_LAST_WARN
    return {"blocked": False, "warn": {"code": w["code"], "reason": w["reason"], "hint": w["hint"]}} if w else {"blocked": False}


def handle_rest_rule_set(data, body):
    """同 Rest.gs handleRestRuleSet_：{admin_key, on?, probe?} → 開／關這家店的擋卡；probe 回 peer_ok／peer_bad。"""
    if not body.get("admin_key") or body.get("admin_key") != ADMIN_KEY:
        return {"ok": False, "error": "unauthorized"}
    if body.get("on") is True:
        data["rest_rule_on"] = "1"
    elif body.get("on") is False:
        data.pop("rest_rule_on", None)
    save_data(data)
    peers = [c for c in _hub_store_codes() if c != _current_store_code()]
    ok, bad = [], []
    if body.get("probe"):
        for c in peers:
            try:
                with store_context(c):
                    load_data()
                ok.append(c)
            except Exception:   # noqa: BLE001
                bad.append(c)
    return {"ok": True, "on": _rest_on(data), "peers": len(peers), "peer_ok": ok, "peer_bad": bad}


ACTIONS["rest_rule_set"] = handle_rest_rule_set


def handle_liff_status(data, body):
    uid, me, err = _liff_me(data, body)
    if err:
        return err
    today = today_str()
    evs = [{"type": e["type"], "hm": e["ts"][11:16], "status": e["status"]} for e in data["events"]
           if e["emp_id"] == me["emp_id"] and e["ts"][:10] == today]
    g = _liff_guard(data, me["emp_id"])
    g["now"] = time.time() * 1000
    # 休息不足（Rest.gs）：開頁就告訴同仁幾點以後才能打上班卡；正在上班中（上一張是上班卡、10 分鐘內）不用算（同 Liff.gs handleLiffStatus_）
    rest = rest_status(data, me) if g["blocked"] != "in" else {"blocked": False}
    return {"ok": True, "status": "ready", "name": me["name"], "shift_in": me.get("shift_in", ""),
            "shift_out": me.get("shift_out", ""), "today": evs, "guard": g, "notices": active_notices(data, today), "rest": rest}


def liff_missed_note(events, emp_id, typ, ts):
    """忘打卡提醒（與 Liff.gs liffMissedNote_ 同規則，2026-10-09）。events 只看 ts 之前的卡。"""
    try:
        now = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return ""
    if typ not in ("in", "out"):
        return ""
    span = timedelta(hours=7 * 24 if typ == "in" else 16)
    mine = []
    for e in events:
        if e["emp_id"] != emp_id:
            continue
        try:
            t = datetime.fromisoformat(e["ts"])
        except ValueError:
            continue
        if t >= now or t < now - span:
            continue
        mine.append((t, e["ts"], e["type"], str(e["status"])))
    mine.sort(key=lambda x: x[0])
    prev = None
    for m in mine:
        if not m[3].startswith("rejected_"):
            prev = m
    other = "out" if typ == "in" else "in"
    failed = any(m[2] == other and m[3] == "rejected_out_of_range" and (prev is None or m[0] > prev[0]) for m in mine)
    if typ == "in":
        if not prev or prev[2] != "in":
            return ""
        d = f"{int(prev[1][5:7])}/{int(prev[1][8:10])} {prev[1][11:16]}"
        return (f"你 {d} 上班後的下班卡沒有打成功（不在範圍內），請跟主管說實際下班時間" if failed
                else f"你 {d} 上班後沒有打下班卡，請跟主管說實際下班時間")
    if prev and prev[2] == "in":
        return ""
    return ("你這次的上班卡沒有打成功（不在範圍內），請跟主管說實際上班時間" if failed
            else "你這次沒有打上班卡，請跟主管說實際上班時間")


def handle_liff_punch(data, body):
    typ = body.get("type")
    if typ not in ("in", "out"):
        return {"ok": False, "error": "bad_type"}
    uid, me, err = _liff_me(data, body)
    if err:
        return err
    g = _liff_guard(data, me["emp_id"])
    label = "上班" if typ == "in" else "下班"
    until = g["lock"].get(typ)
    if until and until > time.time() * 1000:
        left = math.ceil((until - time.time() * 1000) / 60000)
        return {"ok": False, "type": typ, "reason": f"你 {g['last']['hm']} 剛打過{'上班' if g['last']['type'] == 'in' else '下班'}卡，{left} 分鐘內不能打{label}卡（避免連按誤打）",
                "hint": f"真的要{label}請告知主管補登"}
    # Liff.gs liffPunchFor_（2026-11-03）：同型過了 10 分鐘，畫面沒帶 confirm_same 就回 need_confirm
    if g.get("last") and g["last"]["type"] == typ and body.get("confirm_same") is not True:
        oth = "下班" if typ == "in" else "上班"
        return {"ok": False, "type": typ, "status": "need_confirm", "need_confirm": True,
                "last": {"type": g["last"]["type"], "hm": g["last"]["hm"]},
                "reason": f"你 {g['last']['hm']} 已經打過{label}卡，中間沒有{oth}卡",
                "hint": f"確定要再打{label}請重新整理打卡頁再按一次；漏打的{oth}卡請到「加班請假 → 忘打卡」補"}
    before = list(data["events"])
    j = handle_clock(data, {"key": me["key"], "type": typ, "lat": body.get("lat"), "lng": body.get("lng"),
                            "accuracy": body.get("accuracy"), "device_id": me.get("device_id") or ("line:" + uid)})
    if j.get("ok") and j.get("status") == "ok":
        res = {"ok": True, "type": typ, "ts": j.get("ts"), "greeting": liff_greeting(typ, j.get("ts")),
                "missed": liff_missed_note(before, me["emp_id"], typ, j.get("ts")),
                "steps": {"verify": 120, "roster": 300, "read": 250, "write": 900, "extra": 400}}   # 與 Liff.gs 同：後端各步驟毫秒數（mock 用固定值）
        if typ == "in" and REST_LAST_WARN:   # 同 Liff.gs：今天已滿 10 小時還打上班卡，只提醒
            res["rest_warn"] = REST_LAST_WARN["reason"] + "。" + REST_LAST_WARN["hint"]
        return res
    st = j.get("status") or j.get("error") or ""
    rr = {"pending_device_approval": ["這支手機還沒被核准", "已送出待核准，請主管到管理系統「考勤管理 → 裝置核准」核准"],
          "rejected_out_of_range": ["店家判定你不在範圍內", "請開啟「精確位置」與 Wi‑Fi 後再按一次"],
          "rejected_duplicate": ["這一筆和上一筆重複", "請按「出勤紀錄」確認今天的紀錄"]}.get(st, ["系統回覆：" + (st or "未知"), "請告知主管"])
    if st == "rejected_rest" and j.get("rest"):   # 同 Liff.gs liffPunchFor_：Rest.gs 講幾點以後才能打
        rr = [j["rest"]["reason"], j["rest"]["hint"]]
    if st == "rejected_too_soon":   # 同 Liff.gs liffPunchFor_（2026-11-11 B33）
        rr = [j.get("message") or "剛打完卡，10 分鐘內不能再打卡", f"真的要{label}請告知主管補登"]
    return {"ok": False, "type": typ, "status": st, "reason": rr[0], "hint": rr[1]}


def handle_export_tables(data, body):
    if not body.get("admin_key") or body.get("admin_key") != ADMIN_KEY:
        return {"ok": False, "error": "unauthorized"}
    drop = {"roster": ("key", "device_id", "line_user_id"), "events": ("device_id",)}
    out = {}
    for name in ("events", "approved", "leave", "roster"):
        rows = data.get(name) or []
        out[name] = [{k: v for k, v in r.items() if k not in drop.get(name, ())} for r in rows]
    return {"ok": True, "exported_at": iso_now(), "tables": out}


ACTIONS["liff_status"] = handle_liff_status
ACTIONS["liff_punch"] = handle_liff_punch
ACTIONS["export_tables"] = handle_export_tables

def handle_line_punch_timing(data, body):
    """打卡等待秒數（2026-10-12，與 LineHub.gs line_punch_timing 同合約；只記在光復資料檔 punch_timing）。"""
    uid = mock_verify_id_token(body.get("id_token"))
    if not uid:
        return {"ok": False, "error": "invalid_id_token"}
    code = str(body.get("store") or "")
    if code and code not in STORE_TABLE:
        return {"ok": False, "error": "bad_store"}
    if body.get("outcome") not in ("ok", "fail", "error", "geo_fail", "unclear_ok", "unclear_not", "unclear_unknown"):
        return {"ok": False, "error": "bad_outcome"}

    def ms(v):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return ""
        return round(n) if math.isfinite(n) and 0 <= n <= 600000 else ""
    data.setdefault("punch_timing", []).append({
        "ts": iso_now(), "store": code, "uid": uid, "type": body.get("type") if body.get("type") in ("in", "out") else "",
        "outcome": body["outcome"], "status": str(body.get("status") or "")[:40],
        "total_ms": ms(body.get("total_ms")), "geo_ms": ms(body.get("geo_ms")), "server_ms": ms(body.get("server_ms")),
        "refix": body.get("refix") is True, "qr": body.get("qr") is True,
        "steps": {k: ms((body.get("steps") or {}).get(k)) for k in ("verify", "roster", "read", "write", "extra")}})
    save_data(data)
    return {"ok": True}


LINE_HUB_ACTIONS = {
    "line_hub_status": handle_line_hub_status,
    "line_quick_clock": handle_line_quick_clock,
    "line_bind_name": handle_line_bind_name,
    "line_punch_timing": handle_line_punch_timing,
}


# ── 多店模擬 ──
import threading, contextlib
STORE_LOCK = threading.Lock()   # 切換全域座標／資料檔期間一次只處理一個請求（mock 用，正式後端各店本來就分開）
try:
    with open(os.path.join(REPO_ROOT, "tools", "stores.json"), encoding="utf-8") as _f:
        STORE_TABLE = {x["code"]: x for x in json.load(_f) if x["code"]}
except FileNotFoundError:
    STORE_TABLE = {}


HUB_STORE_ = (DATA_FILE, STORE_LAT, STORE_LNG, RADIUS_M)   # 光復（集中服務）自己的資料檔與座標


@contextlib.contextmanager
def store_context(code):
    """code 為 None＝什麼都不換（/api 進來本來就是光復）。'' ＝明確切到光復（在別家店的請求裡要讀光復名冊時用，2026-11-03）。
    其他店：資料檔 mock_data_<code>.json、座標半徑換成該店。

    各店資料檔第一次用到時從同一份種子建立（名冊 line_user_id 全空）。要重現「在 A 店綁、B 店不認得」：
      rm -f mock/mock_data_*.json
      POST /api/hq   {"action":"liff_bind","id_token":"MOCK_ID_TOKEN_U1","key":"testkey1"}   → ok
      POST /api/mztjs {"action":"liff_whoami","id_token":"MOCK_ID_TOKEN_U1","device_id":"D1"} → not_bound
    打卡頁：/clock-line.html?mock_uid=U1&api=/api&loc=<緯度>,<經度>&acc=12
    """
    global DATA_FILE, STORE_LAT, STORE_LNG, RADIUS_M
    if code is None:
        yield
        return
    saved = (DATA_FILE, STORE_LAT, STORE_LNG, RADIUS_M)
    if code == "":
        DATA_FILE, STORE_LAT, STORE_LNG, RADIUS_M = HUB_STORE_
    else:
        st = STORE_TABLE[code]
        DATA_FILE = os.path.join(BASE_DIR, "mock_data_%s.json" % code)
        STORE_LAT, STORE_LNG, RADIUS_M = st["lat"], st["lng"], st["radius_m"]
    try:
        yield
    finally:
        DATA_FILE, STORE_LAT, STORE_LNG, RADIUS_M = saved


# 加班請假／忘打卡申請＋主管 QR（2026-10-09）：本機模擬在 requests_mock.py，與 Requests.gs 同合約
sys.path.insert(0, BASE_DIR)
import requests_mock as _requests_mock  # noqa: E402
_requests_mock.register(globals())
# 出勤班表（2026-10-10）：與 Sched.gs line_hub_sched 同合約
import sched_mock as _sched_mock  # noqa: E402
_sched_mock.register(globals())


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
        # 打卡頁與核定頁用 ?api=/api；薪酬頁在 localhost 時 API 常數是空字串，
        # 會 POST 到目錄根（/）。兩種都收，否則薪酬頁在本機完全連不上。
        # 多店模擬（2026-10-08 LINE 單一打卡入口）：/api/<店代碼> 用該店自己的資料檔與座標
        # （座標取自 tools/stores.json），模擬「每家店一套後端」。/api 照舊＝光復，行為不變。
        store_code = None
        if parsed.path.startswith("/api/"):
            store_code = parsed.path[len("/api/"):].strip("/")
            if store_code not in STORE_TABLE:
                self._send_json({"ok": False, "error": "not_found"}, 404)
                return
        elif parsed.path not in ("/api", "/", ""):
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
        if not handler and store_code is None:
            handler = LINE_HUB_ACTIONS.get(action)   # 集中服務只在光復（/api）
        if not handler:
            self._send_json({"ok": False, "error": "unknown_action"})
            return

        try:
            with STORE_LOCK:
                with store_context(store_code):
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
