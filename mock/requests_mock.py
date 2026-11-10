"""加班請假／忘打卡申請＋主管 QR（2026-10-09）的本機模擬——與 apps-script/Requests.gs、Liff.gs、LineHub.gs 同一套合約。

mock_server.py 最後呼叫 register(globals()) 掛上：各店 req_*／mgr_req_*／mgr_qr_token，光復 line_hub_req_init／attach_put／attach_get，
並包住 liff_punch（QR 打卡、申請結果告知、漏卡日期）。邏輯照抄正式版，但只求本機能點得動，驗證規則以 Requests.gs 的測試為準。
"""
import base64
import math
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
REQ_STRICT_FROM = "2026-11-11"   # 同 Requests.gs REQ_STRICT_FROM_DEFAULT_：這天起的加班提示改用 15 分鐘刻度（2026-11-11 B16）


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
            return f"{md} 加班 {r['start']}–{r['end']}（{r['hours']:g} 小時）"
        if r["kind"] == "trip":
            place = trip_place(r.get("reason"))
            return (f"{md} 出差 " + (f"{r['start']}–{r['end']}" if r["start"] else "整天") + f" {r['hours']:g} 小時"
                    + (f"（地點：{place}）" if place else ""))
        if r["miss_type"] == "break":
            return f"{md} 忘打卡補登（中間休息：下班 {r['end']}、回來上班 {r['start']}）"
        parts = []
        if r["miss_type"] in ("in", "both"):
            parts.append("上班 " + r["start"])
        if r["miss_type"] in ("out", "both"):
            parts.append("下班 " + r["end"])
        return f"{md} 忘打卡補登（{'、'.join(parts)}）"

    # 要附證明的假別（同 Requests.gs REQ_PROOF_TYPES_，2026-10-10）
    PROOF = ["病假", "住院傷病假", "公傷病假", "婚假", "喪假（父母・配偶）", "喪假（祖父母・子女・配偶父母）", "喪假（曾祖父母・兄弟姊妹）", "喪假",
             "產假（分娩）", "產假", "流產假（妊娠3個月以上）", "流產假（妊娠2～未滿3個月）", "流產假（妊娠未滿2個月）",
             "產檢假", "陪產檢及陪產假", "安胎休養假"]

    # 病假今年累計滿 3 天才要附（同 Requests.gs reqSickDates_／reqSickNth_，2026-11-06）；其他 15 種一律要附
    SICK_PROOF_DAYS = 3
    CUR = {"rows": []}   # 最近一次 reqs(data) 讀到的申請（mock 不在資料檔裡多存欄位）

    def sick_dates(rows, emp_id, date, except_id=None):
        yr = str(date or "")[:4]
        return sorted({str(x.get("date") or "")[:10] for x in rows
                       if x.get("emp_id") == emp_id and x.get("kind") == "leave" and x.get("leave_type") == "病假"
                       and x.get("status") in ("pending", "approved") and x.get("id") != except_id
                       and str(x.get("date") or "")[:4] == yr})

    def sick_nth(rows, r):
        d = str(r.get("date") or "")[:10]
        return len([x for x in sick_dates(rows, r.get("emp_id"), d, r.get("id")) if x < d]) + 1

    def proof_type(r):
        if not (r.get("kind") == "leave" and r.get("leave_type", "") in PROOF):
            return False
        return r.get("leave_type") != "病假" or sick_nth(CUR["rows"], r) >= SICK_PROOF_DAYS

    def needs_proof(r):
        return proof_type(r) and not r.get("attach_id")

    def public(r):
        o = {k: r.get(k, "") for k in ("id", "created_at", "emp_id", "name", "kind", "date", "leave_type", "start", "end",
                                         "miss_type", "reason", "status", "decided_at", "decided_by", "reject_reason",
                                         "voided_at", "voided_by", "void_reason")}   # voided_*：同 Requests.gs reqPublic_（2026-11-03 補）
        o["hours"] = r.get("hours")
        o["has_attach"] = bool(r.get("attach_id"))
        o["proof_required"], o["need_proof"] = proof_type(r), needs_proof(r)
        o["sick_n"] = sick_nth(CUR["rows"], r) if (r.get("kind") == "leave" and r.get("leave_type") == "病假") else None
        return o

    def miss_virtual(rows, events, emp_id, d):
        """同 Requests.gs reqMissVirtual_（2026-11-11 B02）：已送出（審核中、已核准）的忘打卡申請當成已經補上的卡。"""
        lo = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        hi = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
        nxt = lambda x: (date.fromisoformat(x) + timedelta(days=1)).isoformat()
        out = []

        def card(day, hm, typ):
            out.append({"ts": f"{day}T{hm}:{'59' if typ == 'in' else '00'}+08:00", "emp_id": emp_id, "type": typ, "status": "ok", "__virtual": True})
        for r in rows or []:
            if r.get("emp_id") != emp_id or r.get("kind") != "miss" or r.get("status") not in ("pending", "approved"):
                continue
            rd = str(r.get("date") or "")[:10]
            if not (lo <= rd <= hi):
                continue
            st, en, mt = hm_ok(r.get("start")), hm_ok(r.get("end")), str(r.get("miss_type") or "")
            if mt == "in" and st:
                card(rd, st, "in")
            if mt == "out" and en:
                later_in = any(e["emp_id"] == emp_id and e["type"] == "in" and not str(e["status"]).startswith("rejected_")
                               and e["ts"][:10] == rd and e["ts"][11:16] >= en for e in events)
                card(nxt(rd) if (en <= "06:00" and later_in) else rd, en, "out")
            if mt == "both" and st and en:
                card(rd, st, "in")
                card(nxt(rd) if mins(en) < mins(st) else rd, en, "out")
            if mt == "break" and st and en:
                card(rd, en, "out")
                card(nxt(rd) if mins(st) < mins(en) else rd, st, "in")
        return out

    def day_info(data, emp_id, d, virtual=None):
        """同 Requests.gs reqDayInfo_：跨夜一起配對（16 小時），段落歸上班卡那天；沒配到的凌晨（≤06:00）下班卡歸前一天。
        virtual：miss_virtual 的虛擬卡，一起配對、不列在 punches。"""
        from datetime import datetime
        lo = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        hi = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
        allp = []
        for e in list(data["events"]) + list(virtual or []):
            if e["emp_id"] != emp_id or not (lo <= e["ts"][:10] <= hi):
                continue
            allp.append({"type": e["type"], "hm": e["ts"][11:16], "status": str(e["status"]), "date": e["ts"][:10],
                         "t": datetime.fromisoformat(e["ts"]).timestamp(), "distance_m": e.get("distance_m"), "accuracy_m": e.get("accuracy_m"),
                         "virtual": e.get("__virtual") is True})
        allp.sort(key=lambda p: (p["t"], 0 if p["type"] == "out" else 1))
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
        show = [p for p in allp if p["date"] == d and not p["virtual"]] + \
               [p for p in allp if p["date"] == hi and not p["virtual"] and (any(x[1] is p for x in mine_segs) or p in mine_outs)]
        punches = [{"type": p["type"], "hm": p["hm"] + ("(+1)" if p["date"] != d else ""), "status": p["status"],
                    "distance_m": p["distance_m"], "accuracy_m": p["accuracy_m"]} for p in show]
        if not mine_segs and not mine_ins and not mine_outs:
            opts = ["both"]
        else:
            opts = (["in"] if mine_outs else []) + (["out"] if mine_ins else [])
        # 中間休息（同 Requests.gs，2026-11-02）
        vmark = lambda sp, v: dict(sp, virtual=True) if v else sp   # 真的卡維持原本三個欄位
        spans = [vmark({"in": x[0]["hm"], "out": x[1]["hm"], "out_next": x[1]["date"] != d}, x[0]["virtual"] and x[1]["virtual"]) for x in mine_segs] + \
                [vmark({"in": p["hm"], "out": None, "out_next": False}, p["virtual"]) for p in mine_ins]
        if spans:
            opts = opts + ["break"]
        if mine_segs and not mine_ins and not mine_outs:   # 另一段班整段沒打（同 Requests.gs，2026-11-10）
            opts = opts + ["both"]
        lo1 = mine_outs[0] if mine_outs else None
        return punches, {"options": opts, "open_in": mine_ins[-1]["hm"] if mine_ins else None,
                         "lone_out": lo1["hm"] if lo1 else None, "lone_out_next": bool(lo1 and lo1["date"] != d), "spans": spans,
                         "open_ins": [p["hm"] for p in mine_ins],
                         "lone_outs": [{"hm": p["hm"], "next": p["date"] != d} for p in mine_outs]}

    def day_punches(data, emp_id, d):
        return day_info(data, emp_id, d)[0]

    def reqs(data):
        CUR["rows"] = data.setdefault("requests", [])
        return CUR["rows"]

    # ── 同仁 ──
    def req_info(data, body):
        uid, me, err = liff_me(data, body)
        if err:
            return err
        today = today_str()
        d = str(body.get("date") or "")
        day_only = body.get("day_only") is True and len(d) == 10   # 同 Requests.gs：只要那天的卡、不回申請清單
        mine = [] if day_only else sorted([public(r) for r in reqs(data) if r["emp_id"] == me["emp_id"]], key=lambda r: r["created_at"], reverse=True)
        out = {"ok": True, "name": me["name"], "emp_id": me["emp_id"], "today": today, "requests": mine,
               "miss_days": REQ_MISS_DAYS, "leave_types": [t for t in LEAVE_TYPES if t != "出差"], "proof_types": list(PROOF),
               "sick_proof_days": SICK_PROOF_DAYS, "sick_dates": sick_dates(reqs(data), me["emp_id"], today)}
        if day_only:
            out["day_only"] = True
        if len(d) == 10:
            # 同 Requests.gs（2026-11-11 B02）：day_only 要帶 apply_miss 才把已送出的忘打卡申請算進去；完整查詢一律算
            use = (not day_only) or body.get("apply_miss") is True
            p, m = day_info(data, me["emp_id"], d, miss_virtual(reqs(data), data["events"], me["emp_id"], d) if use else None)
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

        def span_check(start, end, what):
            """同 Requests.gs reqSpanCheck_（2026-11-03 對齊）：起訖一樣擋、超過 12 小時擋；跨夜照舊"""
            if start == end:
                return None, ("bad_time", what + "的開始和結束時間一樣，請確認")
            hrs = span(start, end)
            if hrs > 12:
                return None, ("bad_time", what + "時段超過 12 小時，請確認時間；一整天請選「整天」填時數")
            return hrs, None

        def day_hours(v, what):
            """同 Requests.gs：先取到 0.25 再檢查（0.1 小時原本會變 0）"""
            try:
                h = math.floor(float(v) * 4 + 0.5) / 4
            except (TypeError, ValueError):
                h = float("nan")
            if not (h == h) or h <= 0 or h > 24:
                return None, ("bad_hours", f"請填{what}時數（最少 0.25 小時）")
            return h, None

        if kind in ("leave", "ot", "trip") and (diff < -7 or diff > 90):   # 同 Requests.gs REQ_LEAVE_PAST_DAYS（2026-11-05 由 31 改 7）／REQ_FUTURE_DAYS
            return None, ("bad_date", f"{KIND[kind]}只能申請 7 天前到 90 天後")
        if kind == "leave":
            lt = str(b.get("leave_type") or "")
            if not lt or lt == "出差" or lt not in LEAVE_TYPES:
                return None, ("bad_leave_type", "請選假別")
            row["leave_type"] = lt
            if b.get("start") or b.get("end"):
                row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
                if not row["start"] or not row["end"]:
                    return None, ("bad_time", "請填完整的請假時段")
                row["hours"], e = span_check(row["start"], row["end"], "請假")
                if e:
                    return None, e
            else:
                row["hours"], e = day_hours(b.get("hours"), "請假")
                if e:
                    return None, e
        elif kind == "ot":
            row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
            if not row["start"] or not row["end"]:
                return None, ("bad_time", "請填加班時段")
            row["hours"] = span(row["start"], row["end"])
            if row["hours"] > 12:
                return None, ("bad_time", "加班時段超過 12 小時，請確認時間")
            if not reason:
                return None, ("need_reason", "加班要寫原因")
            # 補休（2026-11-01 改每月加減結算）：加班不再分加班費／換補休，comp 欄留空
        elif kind == "trip":
            row["leave_type"] = "出差"
            if b.get("start") or b.get("end"):
                row["start"], row["end"] = hm_ok(b.get("start")), hm_ok(b.get("end"))
                if not row["start"] or not row["end"]:
                    return None, ("bad_time", "請填完整的出差時段")
                row["hours"], e = span_check(row["start"], row["end"], "出差")
                if e:
                    return None, e
            else:
                row["hours"], e = day_hours(b.get("hours"), "出差")
                if e:
                    return None, e
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
                return None, ("too_old", f"超過 {REQ_MISS_DAYS} 天不能申請，請找打卡門市的店長直接核定")
            mt = str(b.get("miss_type") or "")
            # 同 Requests.gs（2026-11-11 B02）：已送出的忘打卡申請當成已經補上的卡
            virt = miss_virtual(reqs(data), data["events"], me["emp_id"], d)
            info0 = day_info(data, me["emp_id"], d)[1]
            info = day_info(data, me["emp_id"], d, virt)[1] if virt else info0
            dup_msg = "這天已經有忘打卡申請在補這張卡（審核中或已核准），不用再送；要改請先取消那一筆，已核准的請找你的主管作廢"
            if not info["options"]:
                if info0["options"]:
                    return None, ("duplicate", dup_msg)
                return None, ("not_missing", "這天的上班卡和下班卡都有打成功，不用補登；時間記錯請直接跟打卡門市的店長說")
            if mt not in info["options"]:
                if mt in info0["options"]:
                    return None, ("duplicate", dup_msg)
                return None, ("not_missing", "這天的上班卡有打成功，不用補登" if mt == "in" else "這天的下班卡有打成功，不用補登" if mt == "out" else "請選要補哪一張卡")
            row["miss_type"] = mt
            taken = False
            if mt == "break":
                # 同 Requests.gs reqValidate_（break）＋ reqBreakSpan_：字句與順序照正式版（2026-11-03 對齊）
                row["end"] = hm_ok(b.get("end"))
                if not row["end"]:
                    return None, ("bad_time", "請填休息開始（下班）時間")
                row["start"] = hm_ok(b.get("start"))
                if not row["start"]:
                    return None, ("bad_time", "請填回來上班時間")
                rel = lambda hm, base: (mins(hm) - mins(base) + 1440) % 1440

                def break_span(spans):
                    for sp in reversed(spans):
                        a, bb = rel(row["end"], sp["in"]), rel(row["start"], sp["in"])
                        ln = (rel(sp["out"], sp["in"]) or 1440) if sp["out"] else 960   # 還沒下班的段：上班後 16 小時內（同 Requests.gs，2026-11-11 B37）
                        if a > 0 and bb > a and bb < ln:
                            return {"span": sp, "next": mins(sp["in"]) + bb >= 1440}, None
                    if len(spans) == 1:
                        s0 = spans[0]
                        a0, b0 = rel(row["end"], s0["in"]), rel(row["start"], s0["in"])
                        l0 = (rel(s0["out"], s0["in"]) or 1440) if s0["out"] else 960
                        if a0 > 0 and a0 < l0 and b0 > 0 and b0 < l0:
                            return None, ("bad_time", "回來上班時間要比休息開始晚")
                        return None, ("bad_time", f"休息時間要在 {s0['in']}" + (f" 上班到 {s0['out']} 下班之間" if s0["out"] else " 上班之後"))
                    return None, ("bad_time", "休息時間要在當天其中一段班之內（上班卡之後、下班卡之前）")
                bk, bk_err = break_span(info["spans"])
                if bk is None:
                    # 真的卡配得上、只是那段時間被已送出的申請佔掉＝重複申請（下面的重複檢查給訊息）
                    bk0, _ = break_span(info0["spans"]) if virt else (None, None)
                    if bk0 is None:
                        return None, bk_err
                    bk, taken = bk0, True
                if diff == 0 and (bk["next"] or mins(row["start"]) > mins(iso_now()[11:16])):
                    return None, ("bad_time", "不能補登還沒到的時間")
                if not reason:
                    return None, ("need_reason", "請選原因")
            if mt in ("in", "both"):
                row["start"] = hm_ok(b.get("start"))
                if not row["start"]:
                    return None, ("bad_time", "請填實際上班時間")
            if mt in ("out", "both"):
                row["end"] = hm_ok(b.get("end"))
                if not row["end"]:
                    return None, ("bad_time", "請填實際下班時間")
            out_next = False
            # 一天有兩張以上沒配對的卡（2026-11-11 B02）：下班卡配「補的時間之前最近的上班卡」、上班卡配「之後最近的下班卡」
            pair_in, pair_out, pair_out_next = info["open_in"], info["lone_out"], info["lone_out_next"]
            if mt == "out":
                for hm in info.get("open_ins") or []:
                    if mins(hm) < mins(row["end"]):
                        pair_in = hm
            if mt == "in":
                los = info.get("lone_outs") or []
                po = next((x for x in los if x["next"] or mins(x["hm"]) > mins(row["start"])), None) or (los[-1] if los else None)
                if po:
                    pair_out, pair_out_next = po["hm"], po["next"]
            if mt == "out" and pair_in and mins(row["end"]) <= mins(pair_in):
                if row["end"] > "06:00":
                    return None, ("bad_time", f"補的下班時間 {row['end']} 比當天上班卡 {pair_in} 還早")
                out_next = True
            if mt == "in" and pair_out and not pair_out_next and mins(row["start"]) >= mins(pair_out[:5]):
                return None, ("bad_time", f"補的上班時間 {row['start']} 比當天下班卡 {pair_out} 還晚")
            if mt == "both":
                if row["start"] == row["end"]:
                    return None, ("bad_time", "上班和下班時間一樣，請確認")
                out_next = mins(row["end"]) < mins(row["start"])
                nb, ne = mins(row["start"]), mins(row["end"]) + (1440 if out_next else 0)
                for x in info.get("spans") or []:
                    if x["out"] and nb < mins(x["out"]) + (1440 if x["out_next"] else 0) and mins(x["in"]) < ne:
                        if x.get("virtual"):   # 重疊的是已送出的申請＝重複申請，訊息交給下面的重複檢查
                            taken = True
                            break
                        return None, ("bad_time", f"補的時間和當天已打的卡（{x['in']}–{x['out']}）重疊；中間休息沒打請選「中間休息沒打卡」")
            if diff == 0:
                now_m = mins(iso_now()[11:16])
                if out_next or (row["end"] and mins(row["end"]) > now_m) or (row["start"] and mins(row["start"]) > now_m):
                    return None, ("bad_time", "不能補登還沒到的時間")
            if not taken and mt in ("in", "out", "both"):
                # 補上去以後，沒配對的卡要剛好少一張（單張）或不變（整段），否則和當天其他的卡配不起來
                mine_row = {"emp_id": me["emp_id"], "kind": "miss", "status": "pending", "date": d, "miss_type": mt, "start": row["start"], "end": row["end"]}
                after = day_info(data, me["emp_id"], d, virt + miss_virtual([mine_row], data["events"], me["emp_id"], d))[1]
                loose = lambda x: len(x.get("open_ins") or []) + len(x.get("lone_outs") or [])
                if loose(after) != loose(info) - (0 if mt == "both" else 1):
                    return None, ("bad_time", "補的時間和當天其他的卡配不起來，請確認時間（一天漏好幾張時，請一張一張照時間補）")
            if not reason:
                return None, ("need_reason", "請選原因")

        def same_miss(r):
            # 同 Requests.gs reqSameThing_（忘打卡）：同一張卡才算——類型、時間都一樣；兩張整段時間重疊；補休息時段重疊
            if r["miss_type"] != row["miss_type"]:
                return False

            def ov(a1, a2, b1, b2):
                s1, e1, s2, e2 = mins(a1), mins(a2), mins(b1), mins(b2)
                if e1 <= s1:
                    e1 += 1440
                if e2 <= s2:
                    e2 += 1440
                return s1 < e2 and s2 < e1
            if row["miss_type"] == "break":
                return ov(r["end"], r["start"], row["end"], row["start"])
            if row["miss_type"] == "both":
                return ov(r["start"], r["end"], row["start"], row["end"])
            return str(r.get("start") or "") == str(row.get("start") or "") and str(r.get("end") or "") == str(row.get("end") or "")
        def same_other(r):
            # 同 Requests.gs（加班／請假／出差，2026-11-11 B29）：兩張都有時段而且不重疊才放行；任一筆沒有時段＝照舊擋，不分假別
            ts = [r.get("start"), r.get("end"), row.get("start"), row.get("end")]
            if not all(isinstance(x, str) and re.match(r"^\d{2}:\d{2}$", x) for x in ts):
                return True
            s1, e1, s2, e2 = [mins(x) for x in ts]
            if e1 <= s1:
                e1 += 1440
            if e2 <= s2:
                e2 += 1440
            return s1 < e2 and s2 < e1
        dup = [r for r in reqs(data) if r["emp_id"] == me["emp_id"] and r["status"] == "pending" and r["kind"] == kind and r["date"] == d
               and (same_miss(r) if kind == "miss" else same_other(r))]
        if dup:
            return None, ("duplicate", f"這天已經有一筆審核中的{KIND[kind]}申請，要改請先取消那一筆")
        if kind == "miss" and taken:
            return None, ("duplicate", "這段時間已經有忘打卡申請在補了（審核中或已核准），不用再送；要改請先取消那一筆，已核准的請找你的主管作廢")
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

    def req_attach(data, body):
        uid, me, err = liff_me(data, body)
        if err:
            return err
        aid = str(body.get("attach_id") or "")
        import re as _re
        if not _re.match(r"^[A-Za-z0-9_-]{10,80}$", aid):
            return {"ok": False, "error": "bad_attach", "message": "附件沒有上傳成功，請再試一次"}
        r = next((x for x in reqs(data) if x["id"] == body.get("id") and x["emp_id"] == me["emp_id"]), None)
        if not r:
            return {"ok": False, "error": "not_found", "message": "找不到這筆申請"}
        if r.get("kind") != "leave":
            return {"ok": False, "error": "not_leave", "message": "只有請假可以補附證明"}
        if r["status"] != "pending":
            return {"ok": False, "error": "not_pending", "message": "主管已經處理過這筆，不能再補附"}
        r["attach_id"] = aid
        save_data(data)
        return {"ok": True, "request": public(r)}

    # ── 值班主管本人的申請改由上層審（同 Requests.gs reqLocalDutyMgrs_／reqIsUpper_）──
    UPPER_MSG = "這是值班主管本人的申請，請由上層主管在管理系統（人資部門 → 考勤管理 → 申請審核）審核"

    def _t(v):
        return v is True or str(v).lower() == "true"

    def upper_emps(data):
        out = set(str(x) for x in data.get("req_upper_emps", []) if isinstance(x, str) and x)
        roster = [r for r in data.get("roster", []) if _t(r.get("active")) and str(r.get("emp_id", "")) != ""]
        for m in data.get("managers", []):
            if not _t(m.get("active")) or _t(m.get("allow_acting")):
                continue
            eid = str(m.get("emp_id") or "").strip()
            if eid:
                out.add(eid)
                continue
            nk = "".join(str(m.get("name", "")).split())
            for r in roster:
                if nk and "".join(str(r.get("name", "")).split()) == nk:
                    out.add(str(r["emp_id"]))
        return out

    def acting_pass(mgr, body):
        v = body.get("acting_name")
        return _t(mgr.get("allow_acting")) and isinstance(v, str) and v.strip() != "" and len(v.strip()) <= 40

    def blocked_upper(data, mgr, r, body):
        return data.get("req_upper_on") == "1" and (not acting_pass(mgr, body)) and str(r["emp_id"]) in upper_emps(data)

    # ── 主管 ──
    def mgr_pending(data, body):
        if not find_manager_by_key(data, body.get("mgr_key")):
            return {"ok": False, "error": "unauthorized"}
        items, ups = [], (upper_emps(data) if data.get("req_upper_on") == "1" else set())
        for r in sorted([x for x in reqs(data) if x["status"] == "pending"], key=lambda x: x["created_at"]):
            o = public(r)
            o["upper"] = str(r["emp_id"]) in ups
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
        if blocked_upper(data, mgr, r, body):
            return {"ok": False, "error": "upper_review", "message": UPPER_MSG}
        if dec == "approve" and needs_proof(r):
            return {"ok": False, "error": "need_proof", "message": r["leave_type"] + "要附證明，同仁補上後才能核准（退回不受影響）"}
        r.update({"status": "approved" if dec == "approve" else "rejected", "decided_at": iso_now(), "decided_by": mgr["name"],
                  "reject_reason": reason if dec == "reject" else ""})
        save_data(data)
        return {"ok": True, "id": r["id"], "status": r["status"]}

    def mgr_void(data, body):
        """同 Requests.gs handleMgrReqVoid_：只能作廢已核准的，理由必填，decided_* 保留。"""
        mgr = find_manager_by_key(data, body.get("mgr_key"))
        if not mgr:
            return {"ok": False, "error": "unauthorized"}
        reason = str(body.get("reason") or "").strip()[:100]
        if not reason:
            return {"ok": False, "error": "need_reason", "message": "作廢要寫理由"}
        r = next((x for x in reqs(data) if x["id"] == body.get("id")), None)
        if not r:
            return {"ok": False, "error": "not_found", "message": "找不到這筆申請"}
        if r["status"] != "approved":
            msg = "這筆已經作廢了" if r["status"] == "voided" else ("這筆還在審核中，請用退回" if r["status"] == "pending" else "只有已核准的申請可以作廢")
            return {"ok": False, "error": "not_approved", "message": msg}
        if blocked_upper(data, mgr, r, body):
            return {"ok": False, "error": "upper_review", "message": UPPER_MSG}
        r.update({"status": "voided", "voided_at": iso_now(), "voided_by": mgr["name"], "void_reason": reason})
        save_data(data)
        return {"ok": True, "id": r["id"], "status": "voided"}

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
            elif blocked_upper(data, mgr, r, body):
                skipped.append({"id": i, "reason": "值班主管本人的申請，送上層審核"})
            elif needs_proof(r):
                skipped.append({"id": i, "reason": r["leave_type"] + "還沒附證明"})
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
        grid = d >= REQ_STRICT_FROM   # 加嚴生效的日子：每段上班進位、下班捨去到 15 分鐘（同 Requests.gs reqGridMs_）
        grid_secs = lambda a, b: max(0, (int(b // 60) // 15) * 15 - (-(-int(a // 60) // 15)) * 15) * 60
        secs = sum((grid_secs(x[0][0], x[1][0]) if grid else x[1][0] - x[0][0]) for x in segs if x[0][2] == d)
        hours = round(secs / 3600, 2)
        if hours <= OT_HINT_H:
            return None
        if any(r["emp_id"] == emp_id and r["kind"] == "ot" and r["date"] == d and r["status"] in ("pending", "approved") for r in rows):
            return None
        end = out_ts[11:16]
        if grid:
            em = (mins(end) // 15) * 15
            end = f"{em // 60:02d}:{em % 60:02d}"
        sm = mins(end) - (secs - OT_HINT_H * 3600) / 60
        sm = int((sm // 15) * 15) % 1440
        return {"date": d, "hours": hours, "start": f"{sm // 60:02d}:{sm % 60:02d}", "end": end}

    def mgr_day(data, body):
        if not find_manager_by_key(data, body.get("mgr_key")):
            return {"ok": False, "error": "unauthorized"}
        by = {}
        mgr = find_manager_by_key(data, body.get("mgr_key"))
        ups = upper_emps(data) if (data.get("req_upper_on") == "1" and not acting_pass(mgr, body)) else set()
        for r in reqs(data):
            if r["date"] == body.get("date") and r["status"] == "approved":
                o = public(r)
                o["summary"] = summary(r)
                o["upper"] = str(r["emp_id"]) in ups
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
                return {"ok": False, "type": body.get("type"), "status": "qr_invalid", "reason": err, "hint": "請值班主管在管理系統「考勤管理 → 核定工時」按「打卡 QR」重新顯示"}
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
        # 預設店別（2026-10-29，同 LineHub.gs lineHubLastPunchStore_）：綁兩家以上 → 最近一張卡（被擋的不算）在哪家
        punch_store, best = None, ""
        if len(stores) > 1:
            for s in stores:
                with store_context(s["code"] or None):
                    for e in load_data().get("events", []):
                        if str(e.get("emp_id")) == str(s["emp_id"]) and not str(e.get("status", "")).startswith("rejected") and str(e.get("ts", "")) > best:
                            best, punch_store = str(e.get("ts", "")), s["code"]
        names = [t for t in LEAVE_TYPES if t not in ("出差", "補休")]
        # 補休（2026-11-01 改每月加減結算）：光復 mock 資料的 mock_comp 可改（e2e 用來切正職／計時）；
        # 預設正職本月加班 2、補休 4 → 欠 2 小時（負的照樣能請：先休後補）
        comp = data.get("mock_comp") or {"allowed": True, "known": True, "ot_h": 2, "used_h": 4, "balance_h": -2, "ym": date.today().strftime("%Y-%m")}
        # 2026-11-04 Eason：全部同仁的假別都先列「補休」（同 LineHub.gs）；計時＝known:true、allowed:false 由申請頁擋，主檔還沒建＝known:false 照樣能送
        common = [n for n in COMMON if n in names] + ["補休"]
        # 假別額度：光復 mock 資料的 mock_quota 可改（e2e 資料帶入用）；沒有就用固定樣本
        quota = data.get("mock_quota") or [{"name": "特休假", "cap_days": 7, "cap_h": 56, "remain_h": 40, "used_h": 16, "basis": "tenure"},
                                           {"name": "事假", "cap_days": 14, "cap_h": 112, "remain_h": 112, "used_h": 0, "basis": "calendar"}]
        if body.get("lite"):   # 2026-11-06 開頁加快（同 LineHub.gs）：lite 不算額度與補休帳，另打 line_hub_req_quota
            comp, quota = None, []
        if data.get("mock_old_hub"):   # e2e：模擬還沒換的舊後端（不認得 lite，一次全回）
            comp, quota = data.get("mock_comp") or {"allowed": True, "known": True, "ot_h": 2, "used_h": 4, "balance_h": -2, "ym": date.today().strftime("%Y-%m")}, hub_quota_rows(data)
            return {"ok": True, "stores": stores, "punch_store": punch_store, "comp": comp,
                    "leave_types": {"common": common, "special": [n for n in names if n not in COMMON]}, "quota": quota}
        return {"ok": True, "lite": bool(body.get("lite")), "stores": stores, "punch_store": punch_store, "comp": comp,
                "leave_types": {"common": common, "special": [n for n in names if n not in COMMON]},
                "quota": quota}

    def hub_quota_rows(data):
        return data.get("mock_quota") or [{"name": "特休假", "cap_days": 7, "cap_h": 56, "remain_h": 40, "used_h": 16, "basis": "tenure"},
                                          {"name": "事假", "cap_days": 14, "cap_h": 112, "remain_h": 112, "used_h": 0, "basis": "calendar"}]

    def hub_quota(data, body):
        if data.get("mock_old_hub"):
            return {"ok": False, "error": "unknown_action"}
        uid = verify(body.get("id_token"))
        if not uid:
            return {"ok": False, "error": "invalid_id_token"}
        comp = data.get("mock_comp") or {"allowed": True, "known": True, "ot_h": 2, "used_h": 4, "balance_h": -2, "ym": date.today().strftime("%Y-%m")}
        return {"ok": True, "quota": hub_quota_rows(data), "comp": comp}

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

    orig_pending = ns["ACTIONS"]["mgr_pending_approvals"]
    latest_approved_record = ns["latest_approved_record"]

    def pending_plus(data, body):
        """同 Requests.gs reqPendingApprovalsPlus_（2026-10-10）：已核准的申請（加班除外）那天還沒核定，也列入本月待核定。"""
        r = orig_pending(data, body)
        if not r.get("ok"):
            return r
        have = {(x["date"], x["emp_id"]) for x in r["items"]}
        for q in reqs(data):
            d, eid = str(q.get("date") or ""), str(q.get("emp_id") or "")
            if q.get("status") != "approved" or q.get("kind") == "ot" or not d or not eid:
                continue
            if d[:7] != r["ym"] or d >= r["today"] or (d, eid) in have or latest_approved_record(data, d, eid):
                continue
            have.add((d, eid))
            r["items"].append({"date": d, "emp_id": eid, "name": str(q.get("name") or eid), "from_request": True})
        r["items"].sort(key=lambda x: (x["date"], x["name"]))
        return r

    ns["ACTIONS"].update({"req_info": req_info, "req_submit": req_submit, "req_cancel": req_cancel, "req_attach": req_attach,
                          "mgr_req_pending": mgr_pending, "mgr_req_decide": mgr_decide, "mgr_req_day": mgr_day,
                          "mgr_req_decide_batch": mgr_decide_batch, "mgr_req_void": mgr_void,
                          "mgr_qr_token": mgr_qr, "liff_punch": liff_punch,
                          "mgr_pending_approvals": pending_plus})
    ns["LINE_HUB_ACTIONS"].update({"line_hub_req_init": hub_init, "line_hub_req_quota": hub_quota, "line_hub_attach_put": hub_attach_put,
                                   "line_hub_attach_get": hub_attach_get})
