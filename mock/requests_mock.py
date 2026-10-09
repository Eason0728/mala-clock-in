"""加班請假／忘打卡申請＋主管 QR（2026-10-09）的本機模擬——與 apps-script/Requests.gs、Liff.gs、LineHub.gs 同一套合約。

mock_server.py 最後呼叫 register(globals()) 掛上：各店 req_*／mgr_req_*／mgr_qr_token，光復 line_hub_req_init／attach_put／attach_get，
並包住 liff_punch（QR 打卡、申請結果告知、漏卡日期）。邏輯照抄正式版，但只求本機能點得動，驗證規則以 Requests.gs 的測試為準。
"""
import base64
import hashlib
import hmac
import random
import time
import uuid
from datetime import date, timedelta

REQ_MISS_DAYS = 7
QR_SECRET = "mock-qr-secret"
QR_WINDOW_MS = 30000
COMMON = ["特休假", "事假", "病假", "生理假", "家庭照顧假"]
ATTACH = {}   # attach_id → (mime, base64)；重啟 mock 就清掉
KIND = {"leave": "請假", "ot": "加班", "trip": "出差", "miss": "忘打卡"}
TRIP_PLACE_MAX = 40
BATCH_MAX = 30
OT_HINT_H = 8


def register(ns):
    store_context, load_data, save_data = ns["store_context"], ns["load_data"], ns["save_data"]
    iso_now, today_str, LEAVE_TYPES = ns["iso_now"], ns["today_str"], ns["LEAVE_TYPES"]
    find_manager_by_key, liff_me, STORE_TABLE = ns["find_manager_by_key"], ns["_liff_me"], ns["STORE_TABLE"]
    verify = ns["mock_verify_id_token"]

    def hm_ok(v):
        v = str(v or "")
        if len(v) != 5 or v[2] != ":" or not (v[:2] + v[3:]).isdigit():
            return ""
        return v if int(v[:2]) <= 23 and int(v[3:]) <= 59 else ""

    def mins(v):
        return int(v[:2]) * 60 + int(v[3:]) if v else None

    def span(a, b):
        s, e = mins(a), mins(b)
        if s is None or e is None:
            return None
        if e <= s:
            e += 1440
        return round((e - s) / 60, 2)

    def ddiff(a, b):
        return (date.fromisoformat(a) - date.fromisoformat(b)).days

    def trip_place(reason):
        """同 Requests.gs reqTripPlace_：reason＝'地點：<地點>；事由：<事由>'"""
        s = str(reason or "")
        if s.startswith("地點：") and "；事由：" in s:
            return s[3:s.index("；事由：")]
        return ""

    def summary(r):
        md = f"{int(r['date'][5:7])}/{int(r['date'][8:10])}"
        if r["kind"] == "leave":
            return f"{md} {r['leave_type']} " + (f"{r['start']}–{r['end']}" if r["start"] else "整天") + f" {r['hours']:g} 小時"
        if r["kind"] == "ot":
            return f"{md} 加班 {r['start']}–{r['end']}（{r['hours']:g} 小時）" + ("（換補休）" if r.get("comp") == "comp" else "")
        if r["kind"] == "trip":
            place = trip_place(r.get("reason"))
            return (f"{md} 出差 " + (f"{r['start']}–{r['end']}" if r["start"] else "整天") + f" {r['hours']:g} 小時"
                    + (f"（地點：{place}）" if place else ""))
        parts = []
        if r["miss_type"] in ("in", "both"):
            parts.append("上班 " + r["start"])
        if r["miss_type"] in ("out", "both"):
            parts.append("下班 " + r["end"])
        return f"{md} 忘打卡補登（{'、'.join(parts)}）"

    def public(r):
        o = {k: r.get(k, "") for k in ("id", "created_at", "emp_id", "name", "kind", "date", "leave_type", "start", "end",
                                         "miss_type", "reason", "status", "decided_at", "decided_by", "reject_reason")}
        o["hours"] = r.get("hours")
        o["has_attach"] = bool(r.get("attach_id"))
        o["comp"] = ("comp" if r.get("comp") == "comp" else "pay") if r.get("kind") == "ot" else ""
        return o

    def day_info(data, emp_id, d):
        """同 Requests.gs reqDayInfo_：跨夜一起配對（16 小時），段落歸上班卡那天；沒配到的凌晨（≤06:00）下班卡歸前一天。"""
        from datetime import datetime
        lo = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        hi = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
        allp = []
        for e in data["events"]:
            if e["emp_id"] != emp_id or not (lo <= e["ts"][:10] <= hi):
                continue
            allp.append({"type": e["type"], "hm": e["ts"][11:16], "status": str(e["status"]), "date": e["ts"][:10],
                         "t": datetime.fromisoformat(e["ts"]).timestamp(), "distance_m": e.get("distance_m"), "accuracy_m": e.get("accuracy_m")})
        allp.sort(key=lambda p: p["t"])
        segs, open_ins, lone_outs, open_ = [], [], [], None
        for p in allp:
            if p["status"].startswith("rejected_"):
                continue
            if p["type"] == "in":
                if open_:
                    open_ins.append(open_)
                open_ = p
            elif open_ and p["t"] - open_["t"] <= 16 * 3600:
                segs.append((open_, p))
                open_ = None
            else:
                if open_:
                    open_ins.append(open_)
                    open_ = None
                lone_outs.append(p)
        if open_:
            open_ins.append(open_)

        def day_of(p):
            return (date.fromisoformat(p["date"]) - timedelta(days=1)).isoformat() if p["type"] == "out" and p["hm"] <= "06:00" else p["date"]
        mine_ins = [p for p in open_ins if p["date"] == d]
        mine_outs = [p for p in lone_outs if day_of(p) == d]
        mine_segs = [x for x in segs if x[0]["date"] == d]
        show = [p for p in allp if p["date"] == d] + [p for p in allp if p["date"] == hi and (any(x[1] is p for x in mine_segs) or p in mine_outs)]
        punches = [{"type": p["type"], "hm": p["hm"] + ("(+1)" if p["date"] != d else ""), "status": p["status"],
                    "distance_m": p["distance_m"], "accuracy_m": p["accuracy_m"]} for p in show]
        if not mine_segs and not mine_ins and not mine_outs:
            opts = ["both"]
        else:
            opts = (["in"] if mine_outs else []) + (["out"] if mine_ins else [])
        lo1 = mine_outs[0] if mine_outs else None
        return punches, {"options": opts, "open_in": mine_ins[-1]["hm"] if mine_ins else None,
                         "lone_out": lo1["hm"] if lo1 else None, "lone_out_next": bool(lo1 and lo1["date"] != d)}

    def day_punches(data, emp_id, d):
        return day_info(data, emp_id, d)[0]

    def reqs(data):
        return data.setdefault("requests", [])

    # ── 同仁 ──
    def req_info(data, body):
        uid, me, err = liff_me(data, body)
        if err:
            return err
        today = today_str()
        mine = sorted([public(r) for r in reqs(data) if r["emp_id"] == me["emp_id"]], key=lambda r: r["created_at"], reverse=True)
        out = {"ok": True, "name": me["name"], "emp_id": me["emp_id"], "today": today, "requests": mine,
               "miss_days": REQ_MISS_DAYS, "leave_types": [t for t in LEAVE_TYPES if t != "出差"]}
        d = str(body.get("date") or "")
        if len(d) == 10:
            p, m = day_info(data, me["emp_id"], d)
            out["day"] = {"date": d, "punches": p, "missing": m}
        return out

    def validate(b, data, me):
        kind, d = str(b.get("kind") or ""), str(b.get("date") or "")
        if kind not in KIND:
            return None, ("bad_kind", "申請類別不對")
        if len(d) != 10:
            return None, ("bad_date", "請選日期")
        diff = ddiff(d, today_str())
        reason = str(b.get("reason") or "").strip()[:100]
        row = {"kind": kind, "date": d, "leave_type": "", "start": "", "end": "", "hours": "", "miss_type": "", "reason": reason, "comp": ""}
        if kind == "leave":
            lt = str(b.get("leave_type") or "")
            if not lt or lt == "出差" or lt not in LEAVE_TYPES:
                return None, ("bad_leave_type", "請選假別")
            row["leave_type"] = lt
            if b.get("start") or b.get("end"):
                row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
                if not row["start"] or not row["end"]:
                    return None, ("bad_time", "請填完整的請假時段")
                row["hours"] = span(row["start"], row["end"])
            else:
                try:
                    h = float(b.get("hours"))
                except (TypeError, ValueError):
                    h = 0
                if not (0 < h <= 24):
                    return None, ("bad_hours", "請填請假時數")
                row["hours"] = round(h * 4) / 4
        elif kind == "ot":
            row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
            if not row["start"] or not row["end"]:
                return None, ("bad_time", "請填加班時段")
            row["hours"] = span(row["start"], row["end"])
            if row["hours"] > 12:
                return None, ("bad_time", "加班時段超過 12 小時，請確認時間")
            if not reason:
                return None, ("need_reason", "加班要寫原因")
            row["comp"] = "comp" if b.get("comp") == "comp" else "pay"   # 補休（2026-10-09）
        elif kind == "trip":
            if diff < -31 or diff > 90:
                return None, ("bad_date", "出差只能申請 31 天前到 90 天後")
            row["leave_type"] = "出差"
            if b.get("start") or b.get("end"):
                row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
                if not row["start"] or not row["end"]:
                    return None, ("bad_time", "請填完整的出差時段")
                row["hours"] = span(row["start"], row["end"])
            else:
                try:
                    h = float(b.get("hours"))
                except (TypeError, ValueError):
                    h = 0
                if not (0 < h <= 24):
                    return None, ("bad_hours", "請填出差時數")
                row["hours"] = round(h * 4) / 4
            place = str(b.get("place") or "").strip().replace("；", "，")
            if not place:
                return None, ("need_place", "請填出差地點")
            if len(place) > TRIP_PLACE_MAX:
                return None, ("bad_place", f"地點最多 {TRIP_PLACE_MAX} 個字")
            why = str(b.get("why") or "").strip()[:100]
            if not why:
                return None, ("need_reason", "請填出差事由")
            row["reason"] = f"地點：{place}；事由：{why}"
        else:
            if diff > 0:
                return None, ("bad_date", "不能補登還沒到的日期")
            if diff < -REQ_MISS_DAYS:
                return None, ("too_old", f"超過 {REQ_MISS_DAYS} 天不能申請，請找值班主管直接核定")
            mt = str(b.get("miss_type") or "")
            info = day_info(data, me["emp_id"], d)[1]
            if not info["options"]:
                return None, ("not_missing", "這天的上班卡和下班卡都有打成功，不用補登；時間記錯請直接跟值班主管說")
            if mt not in info["options"]:
                return None, ("not_missing", "這天的上班卡有打成功，不用補登" if mt == "in" else "這天的下班卡有打成功，不用補登" if mt == "out" else "請選要補哪一張卡")
            row["miss_type"] = mt
            if mt in ("in", "both"):
                row["start"] = hm_ok(b.get("start"))
                if not row["start"]:
                    return None, ("bad_time", "請填實際上班時間")
            if mt in ("out", "both"):
                row["end"] = hm_ok(b.get("end"))
                if not row["end"]:
                    return None, ("bad_time", "請填實際下班時間")
            out_next = False
            if mt == "out" and info["open_in"] and mins(row["end"]) <= mins(info["open_in"]):
                if row["end"] > "06:00":
                    return None, ("bad_time", f"補的下班時間 {row['end']} 比當天上班卡 {info['open_in']} 還早")
                out_next = True
            if mt == "in" and info["lone_out"] and not info["lone_out_next"] and mins(row["start"]) >= mins(info["lone_out"][:5]):
                return None, ("bad_time", f"補的上班時間 {row['start']} 比當天下班卡 {info['lone_out']} 還晚")
            if mt == "both":
                if row["start"] == row["end"]:
                    return None, ("bad_time", "上班和下班時間一樣，請確認")
                out_next = mins(row["end"]) < mins(row["start"])
            if diff == 0:
                now_m = mins(iso_now()[11:16])
                if out_next or (row["end"] and mins(row["end"]) > now_m) or (row["start"] and mins(row["start"]) > now_m):
                    return None, ("bad_time", "不能補登還沒到的時間")
            if not reason:
                return None, ("need_reason", "請選原因")
        dup = [r for r in reqs(data) if r["emp_id"] == me["emp_id"] and r["status"] == "pending" and r["kind"] == kind and r["date"] == d
               and (kind != "miss" or r["miss_type"] == row["miss_type"] or "both" in (r["miss_type"], row["miss_type"]))]
        if dup:
            return None, ("duplicate", f"這天已經有一筆審核中的{KIND[kind]}申請，要改請先取消那一筆")
        return row, None

    def req_submit(data, body):
        uid, me, err = liff_me(data, body)
        if err:
            return err
        row, e = validate(body, data, me)
        if e:
            return {"ok": False, "error": e[0], "message": e[1]}
        row.update({"id": "r%x%x" % (int(time.time() * 1000), random.randint(0, 999)), "created_at": iso_now(),
                    "emp_id": me["emp_id"], "name": me["name"], "attach_id": str(body.get("attach_id") or ""),
                    "status": "pending", "decided_at": "", "decided_by": "", "reject_reason": "", "seen_at": ""})
        reqs(data).append(row)
        save_data(data)
        return {"ok": True, "request": public(row), "summary": summary(row)}

    def req_cancel(data, body):
        uid, me, err = liff_me(data, body)
        if err:
            return err
        r = next((x for x in reqs(data) if x["id"] == body.get("id") and x["emp_id"] == me["emp_id"]), None)
        if not r:
            return {"ok": False, "error": "not_found", "message": "找不到這筆申請"}
        if r["status"] != "pending":
            return {"ok": False, "error": "not_pending", "message": "主管已經處理過這筆，不能取消；要改請找主管"}
        r.update({"status": "cancelled", "decided_at": iso_now(), "decided_by": "本人取消"})
        save_data(data)
        return {"ok": True}

    # ── 主管 ──
    def mgr_pending(data, body):
        if not find_manager_by_key(data, body.get("mgr_key")):
            return {"ok": False, "error": "unauthorized"}
        items = []
        for r in sorted([x for x in reqs(data) if x["status"] == "pending"], key=lambda x: x["created_at"]):
            o = public(r)
            o["summary"], o["attach_id"] = summary(r), r.get("attach_id", "")
            if ddiff(r["date"], today_str()) <= 0:
                o["punches"] = day_punches(data, r["emp_id"], r["date"])
            items.append(o)
        return {"ok": True, "items": items}

    def mgr_decide(data, body):
        mgr = find_manager_by_key(data, body.get("mgr_key"))
        if not mgr:
            return {"ok": False, "error": "unauthorized"}
        dec, reason = body.get("decision"), str(body.get("reason") or "").strip()[:100]
        if dec not in ("approve", "reject"):
            return {"ok": False, "error": "bad_decision"}
        if dec == "reject" and not reason:
            return {"ok": False, "error": "need_reason", "message": "退回要寫理由"}
        r = next((x for x in reqs(data) if x["id"] == body.get("id")), None)
        if not r:
            return {"ok": False, "error": "not_found", "message": "找不到這筆申請"}
        if r["status"] != "pending":
            return {"ok": False, "error": "not_pending", "message": "同仁已經取消這筆申請" if r["status"] == "cancelled" else "這筆已經處理過了"}
        r.update({"status": "approved" if dec == "approve" else "rejected", "decided_at": iso_now(), "decided_by": mgr["name"],
                  "reject_reason": reason if dec == "reject" else ""})
        save_data(data)
        return {"ok": True, "id": r["id"], "status": r["status"]}

    def mgr_decide_batch(data, body):
        """同 Requests.gs handleMgrReqDecideBatch_：只能核准、最多 30 筆，不是審核中的略過並說明。"""
        mgr = find_manager_by_key(data, body.get("mgr_key"))
        if not mgr:
            return {"ok": False, "error": "unauthorized"}
        if body.get("decision") != "approve":
            return {"ok": False, "error": "bad_decision", "message": "批次只能核准；退回請一筆一筆處理"}
        ids = []
        for x in body.get("ids") or []:
            x = str(x)
            if x and x not in ids:
                ids.append(x)
        if not ids:
            return {"ok": False, "error": "no_ids", "message": "請先勾選要核准的申請"}
        if len(ids) > BATCH_MAX:
            return {"ok": False, "error": "too_many_ids", "message": f"一次最多核准 {BATCH_MAX} 筆"}
        done, skipped, now = [], [], iso_now()
        for i in ids:
            r = next((x for x in reqs(data) if x["id"] == i), None)
            if not r:
                skipped.append({"id": i, "reason": "找不到這筆申請"})
            elif r["status"] != "pending":
                skipped.append({"id": i, "reason": "同仁已經取消這筆申請" if r["status"] == "cancelled" else "這筆已經處理過了"})
            else:
                r.update({"status": "approved", "decided_at": now, "decided_by": mgr["name"], "reject_reason": ""})
                done.append(i)
        save_data(data)
        return {"ok": True, "done": done, "skipped": skipped}

    def ot_hint(events, emp_id, out_ts, rows):
        """同 Requests.gs reqOtHint_：那天（這張下班卡配到的上班卡那天）完整段加總 > 8 小時、沒有審核中／已核准的加班申請才提示。"""
        from datetime import datetime
        out_t = datetime.fromisoformat(out_ts).timestamp()
        ps = []
        for e in events:
            if e["emp_id"] != emp_id or str(e["status"]).startswith("rejected_"):
                continue
            t = datetime.fromisoformat(e["ts"]).timestamp()
            if out_t - 3 * 16 * 3600 <= t <= out_t:
                ps.append((t, e["type"], e["ts"][:10]))
        ps.sort(key=lambda x: x[0])
        segs, open_ = [], None
        for p in ps:
            if p[1] == "in":
                open_ = p
                continue
            if open_ and p[0] - open_[0] <= 16 * 3600:
                segs.append((open_, p))
            open_ = None
        mine = next((x for x in segs if x[1][0] == out_t), None)
        if not mine:
            return None
        d = mine[0][2]
        secs = sum(x[1][0] - x[0][0] for x in segs if x[0][2] == d)
        hours = round(secs / 3600, 2)
        if hours <= OT_HINT_H:
            return None
        if any(r["emp_id"] == emp_id and r["kind"] == "ot" and r["date"] == d and r["status"] in ("pending", "approved") for r in rows):
            return None
        end = out_ts[11:16]
        sm = mins(end) - (secs - OT_HINT_H * 3600) / 60
        sm = int((sm // 15) * 15) % 1440
        return {"date": d, "hours": hours, "start": f"{sm // 60:02d}:{sm % 60:02d}", "end": end}

    def mgr_day(data, body):
        if not find_manager_by_key(data, body.get("mgr_key")):
            return {"ok": False, "error": "unauthorized"}
        by = {}
        for r in reqs(data):
            if r["date"] == body.get("date") and r["status"] == "approved":
                o = public(r)
                o["summary"] = summary(r)
                by.setdefault(r["emp_id"], []).append(o)
        return {"ok": True, "date": body.get("date"), "by_emp": by}

    def qr_sig(tag, win, idx):
        raw = hmac.new(QR_SECRET.encode(), f"{tag}|{win}|{idx}".encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")[:16]

    def mgr_qr(data, body):
        mgrs = data.get("managers", [])
        idx = next((i for i, m in enumerate(mgrs) if m["key"] == body.get("mgr_key") and m.get("active")), None)
        if idx is None:
            return {"ok": False, "error": "unauthorized"}
        tag = str(body.get("store") or "gk")
        data["qr_store"] = tag
        save_data(data)
        now = int(time.time() * 1000)
        win = now // QR_WINDOW_MS
        return {"ok": True, "token": f"{tag}~{win}~{idx + 2}~{qr_sig(tag, win, idx + 2)}", "expires_in": QR_WINDOW_MS - now % QR_WINDOW_MS,
                "manager": mgrs[idx]["name"]}

    def qr_verify(data, tok):
        p = str(tok or "").split("~")
        if len(p) != 4 or not p[1].isdigit() or not p[2].isdigit():
            return None, "QR 碼看不懂，請主管重新顯示"
        if p[0] != data.get("qr_store", "gk"):
            return None, "這不是這家店的 QR 碼"
        cur, win = int(time.time() * 1000) // QR_WINDOW_MS, int(p[1])
        if win > cur or cur - win >= 3:
            return None, "QR 碼已過期，請主管重新顯示後再掃一次"
        if qr_sig(p[0], win, int(p[2])) != p[3]:
            return None, "QR 碼不正確，請主管重新顯示"
        mgrs = data.get("managers", [])
        i = int(p[2]) - 2
        if not (0 <= i < len(mgrs)) or not mgrs[i].get("active"):
            return None, "出示 QR 的主管帳號已停用"
        return mgrs[i]["name"], None

    # liff_punch：包一層（QR、漏卡日期、申請結果告知）
    orig_punch = ns["ACTIONS"]["liff_punch"]

    def liff_punch(data, body):
        mgr_name = None
        if body.get("qr"):
            mgr_name, err = qr_verify(data, body.get("qr"))
            if err:
                return {"ok": False, "type": body.get("type"), "status": "qr_invalid", "reason": err, "hint": "請值班主管在核定頁按「打卡 QR」重新顯示"}
            body = dict(body, lat=ns["STORE_LAT"], lng=ns["STORE_LNG"], accuracy=0)
        before = list(data["events"])
        r = orig_punch(data, body)
        if r.get("ok"):
            uid, me, _ = liff_me(data, body)
            r["via_qr"] = bool(mgr_name)
            if mgr_name:
                data.setdefault("qr_punch", []).append({"ts": r["ts"], "emp_id": me["emp_id"], "type": body["type"], "qr_manager": mgr_name})
            if r.get("missed"):
                if body["type"] == "in":
                    prev = [e for e in before if e["emp_id"] == me["emp_id"] and not str(e["status"]).startswith("rejected_")]
                    r["missed_date"], r["missed_type"] = (prev[-1]["ts"][:10] if prev else ""), "out"
                else:
                    r["missed_date"], r["missed_type"] = r["ts"][:10], "in"
            notes = []
            for x in reqs(data):
                if x["emp_id"] == me["emp_id"] and not x.get("seen_at") and x["status"] in ("approved", "rejected"):
                    notes.append(("✓ 主管已核准：" + summary(x)) if x["status"] == "approved"
                                 else ("✕ 申請被退回：" + summary(x) + (f"（{x['reject_reason']}）" if x["reject_reason"] else "")))
                    x["seen_at"] = iso_now()
            r["req_notes"] = notes
            if body["type"] == "out":
                h = ot_hint(data["events"], me["emp_id"], r["ts"], reqs(data))
                if h:
                    r["ot_hint"] = h
            save_data(data)
        return r

    # ── 光復集中服務 ──
    def hub_init(data, body):
        uid = verify(body.get("id_token"))
        if not uid:
            return {"ok": False, "error": "invalid_id_token"}
        stores = []
        for code in [""] + list(STORE_TABLE.keys()):
            with store_context(code or None):
                sd = load_data()
                me = next((r for r in sd["roster"] if str(r.get("active")).lower() == "true" and r.get("line_user_id") == uid), None)
                if me:
                    stores.append({"code": code, "name": "小辛辣 新竹光復" if code == "" else STORE_TABLE[code]["name"],
                                   "emp_id": me["emp_id"], "emp_name": me["name"]})
        if not stores:
            return {"ok": False, "error": "not_bound"}
        names = [t for t in LEAVE_TYPES if t not in ("出差", "補休")]
        # 補休（2026-10-09）：光復 mock 資料的 mock_comp 可改（e2e 用來切正職／計時、有無餘額）；預設正職剩 6 小時、20 天後到期
        comp = data.get("mock_comp") or {"allowed": True, "balance_h": 6,
                                         "earliest_expiry": (date.today() + timedelta(days=20)).isoformat()}
        common = [n for n in COMMON if n in names] + (["補休"] if comp.get("allowed") and comp.get("balance_h", 0) > 0 else [])
        return {"ok": True, "stores": stores, "comp": comp,
                "leave_types": {"common": common, "special": [n for n in names if n not in COMMON]},
                "quota": [{"name": "特休假", "cap_days": 7, "cap_h": 56, "remain_h": 40, "used_h": 16, "basis": "tenure"},
                          {"name": "事假", "cap_days": 14, "cap_h": 112, "remain_h": 112, "used_h": 0, "basis": "calendar"}]}

    def hub_attach_put(data, body):
        if not verify(body.get("id_token")):
            return {"ok": False, "error": "invalid_id_token"}
        url = str(body.get("data_url") or "")
        for mime in ("image/jpeg", "image/png", "application/pdf"):
            pre = f"data:{mime};base64,"
            if url.startswith(pre):
                aid = uuid.uuid4().hex[:24]
                ATTACH[aid] = (mime, url[len(pre):])
                return {"ok": True, "attach_id": aid}
        return {"ok": False, "error": "bad_file", "message": "只能上傳照片或 PDF"}

    def hub_attach_get(data, body):
        code = str(body.get("store") or "")
        if code and code not in STORE_TABLE:
            return {"ok": False, "error": "bad_store"}
        with store_context(code or None):
            sd = load_data()
            if not find_manager_by_key(sd, body.get("mgr_key")):
                return {"ok": False, "error": "unauthorized"}
            aid = str(body.get("attach_id") or "")
            if not aid or not any(r.get("attach_id") == aid for r in sd.get("requests", [])) or aid not in ATTACH:
                return {"ok": False, "error": "not_found"}
        mime, b64 = ATTACH[aid]
        return {"ok": True, "mime": mime, "data": b64}

    ns["ACTIONS"].update({"req_info": req_info, "req_submit": req_submit, "req_cancel": req_cancel,
                          "mgr_req_pending": mgr_pending, "mgr_req_decide": mgr_decide, "mgr_req_day": mgr_day,
                          "mgr_req_decide_batch": mgr_decide_batch,
                          "mgr_qr_token": mgr_qr, "liff_punch": liff_punch})
    ns["LINE_HUB_ACTIONS"].update({"line_hub_req_init": hub_init, "line_hub_attach_put": hub_attach_put,
                                   "line_hub_attach_get": hub_attach_get})
