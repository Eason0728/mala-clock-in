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
STORE_LAT = 24.7838051
STORE_LNG = 121.015592
RADIUS_M = 50
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
        ],
        "events": [],
    }


def load_data():
    if not os.path.exists(DATA_FILE):
        data = seed_data()
        save_data(data)
        return data
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


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
                e["status"] = "ok"
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
