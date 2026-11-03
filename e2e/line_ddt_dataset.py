# -*- coding: utf-8 -*-
"""LINE 打卡資料帶入測試（e2e/line_ddt.py）的隨機資料與獨立算式。

規矩（data-drive-test skill）：
  1. 每次執行全部重抽（店、人數、人名、班別、每張卡的時間、申請內容、班表），E2E_SEED 可重現。
     分層：每個人先抽一個「情境中心」（fresh／lock／missed_out／missed_in／overtime／rest_gap／rest_cap／two_shift／cross_store），
     數值在中心附近浮動，讓每條規則的分支都出現。
  2. 預期值照規格自己算一次，不 import 系統（apps-script／mock）任何程式。
     規格正本：~/.claude/skills/mala-clock-in/SKILL.md、apps-script/Liff.gs／Rest.gs／Requests.gs 註解、clock-line-core.js 註解。
  3. 測試姓名一律「測試○○」（repo 是 public，不放真名）。
"""
import math
import random
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
WK = ['日', '一', '二', '三', '四', '五', '六']
STEMS = '甲乙丙丁戊己庚辛壬癸'
BRANCHES = '子丑寅卯辰巳午未申酉戌亥'

# ── 規格常數（照規格寫死，不從系統讀）──
ACCURACY_CREDIT_CAP_M = 100     # 定位誤差最多折抵 100 公尺（clock-line-core.js／各店 CONFIG）
SAME_TYPE_LOCK_MIN = 10          # 打完任一張 10 分鐘內兩顆都鎖（2026-11-02）
ALTERNATION_LOOKBACK_H = 12      # 最後一張算數的卡往回看 12 小時
MISSED_DAYS = 7                  # 忘打卡提醒：打上班往前 7 天
MISSED_PAIR_H = 16               # 打下班往前 16 小時內要有上班卡
REST_DAY_MAX_H = 10
REST_GAP_H = 11
REST_PAIR_H = 16
REST_LOOKBACK_H = 40
OT_HINT_H = 8
REQ_MISS_DAYS = 7
REQ_PAIR_H = 16
REQ_EARLY_OUT_HM = '06:00'
# 問候語字句（規格正本 clock.html CLOCK_GREETINGS＝Liff.gs LIFF_GREETINGS，2026-10-08 Eason 指定）
GREETINGS = {
    'in': {
        'morning': ['早安！今天也謝謝你來，有你在真好 ☀️', '早安！有你一起努力，今天一定很順 💪', '早安！新的一天，祝你一切順利 🌱'],
        'afternoon': ['午安！謝謝你來接力，下午一起加油 💪', '午安！有你在就安心，下午也順順利利 ☀️', '午安！吃飽了嗎？下午也要元氣滿滿 😊'],
        'evening': ['晚上好！謝謝你今晚的付出，有你超放心 🌙', '晚上好！今晚也一起加油，辛苦你了 💪', '晚上好！謝謝有你，今晚一切順利 ✨'],
    },
    'out': {
        'morning': ['早安！忙完這一段辛苦了，好好休息 ☀️', '辛苦了！謝謝你一早的付出，接下來好好照顧自己 ❤️', '收工了！今天的你超棒，記得補充體力 💪'],
        'afternoon': ['午安！辛苦了，謝謝你今天的用心 ❤️', '辛苦了！接下來的時間留給自己，好好放鬆 ☀️', '今天的努力大家都看得到，辛苦了，好好休息 ✨'],
        'evening': ['辛苦了！今天的你超棒，好好休息，明天見 ❤️', '晚安！謝謝你今天的用心，回家好好犒賞自己 🌙', '今天也辛苦了，路上小心，好好睡一覺 🌙'],
    },
}
# 假別白名單（Code.gs LEAVE_TYPES，規格；申請頁「特殊假別」下拉＝白名單去掉常用五種、出差、補休）
LEAVE_TYPES = ['特休假', '事假', '病假', '住院傷病假', '安胎休養假', '生理假', '家庭照顧假', '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）',
               '喪假（曾祖父母・兄弟姊妹）', '婚假', '天災假', '公傷病假', '產假（分娩）', '流產假（妊娠3個月以上）', '流產假（妊娠2～未滿3個月）',
               '流產假（妊娠未滿2個月）', '產檢假', '陪產檢及陪產假', '公假', '謀職假', '育嬰假', '喪假', '產假']
COMMON_LEAVES = ['特休假', '事假', '病假', '生理假', '家庭照顧假']
PROOF_TYPES = ['病假', '住院傷病假', '公傷病假', '婚假', '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）', '喪假（曾祖父母・兄弟姊妹）', '喪假',
               '產假（分娩）', '產假', '流產假（妊娠3個月以上）', '流產假（妊娠2～未滿3個月）', '流產假（妊娠未滿2個月）', '產檢假', '陪產檢及陪產假', '安胎休養假']
MISS_REASONS = ['忘記按', '手機沒電', '定位抓不到被擋', '按錯上下班', '其他']


# ══ 小工具 ══════════════════════════════════════════════════
def js_num(v):
    """JS 數字轉字串：8 → '8'、8.5 → '8.5'、0.25 → '0.25'。"""
    v = float(v)
    if v == int(v):
        return str(int(v))
    return repr(v)


def js_round(v, digits=0):
    """JS Math.round（.5 進位，不是銀行家捨入）。"""
    k = 10 ** digits
    return math.floor(v * k + 0.5) / k


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S+08:00')


def parse_iso(s):
    return datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=TZ)


def hm_of(dt):
    return dt.strftime('%H:%M')


def md_of(d):
    """'2026-11-03' → '11/3'"""
    return '%d/%d' % (int(d[5:7]), int(d[8:10]))


def md_wk(d):
    """req-line.js md()：'11/3（一）'"""
    dt = datetime.strptime(d, '%Y-%m-%d')
    return '%d/%d（%s）' % (dt.month, dt.day, WK[(dt.weekday() + 1) % 7])


def hm_min(hm):
    return int(hm[:2]) * 60 + int(hm[3:5])


def min_hm(m):
    m %= 1440
    return '%02d:%02d' % (m // 60, m % 60)


def span_hours(a, b):
    """req-line.js spanHours／Requests.gs reqSpanHours_：end ≤ start 視為跨夜；兩位小數。"""
    s, e = hm_min(a), hm_min(b)
    if e <= s:
        e += 1440
    return js_round((e - s) / 60, 2)


# ══ 挑店（clock-line-core.js §3 規格）══════════════════════
def distance_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    to = math.pi / 180
    dlat, dlng = (lat2 - lat1) * to, (lng2 - lng1) * to
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1 * to) * math.cos(lat2 * to) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def effective_distance(d, acc):
    r1 = lambda v: js_round(v, 1)
    a = r1(acc) if isinstance(acc, (int, float)) and math.isfinite(acc) and acc >= 0 else 0
    return max(0, r1(d) - min(a, ACCURACY_CREDIT_CAP_M))


def pick_store(lat, lng, acc, stores):
    """回 ('ok', store, distance_m) / ('ambiguous', [codes], None) / ('none', nearest, round(distance))"""
    hits, nearest, nd = [], None, float('inf')
    for s in stores:
        d = distance_m(lat, lng, s['lat'], s['lng'])
        if d < nd:
            nd, nearest = d, s
        if effective_distance(d, acc) <= s['radius_m']:
            hits.append((s, d))
    if len(hits) == 1:
        return 'ok', hits[0][0], js_round(hits[0][1], 1)
    if len(hits) > 1:
        return 'ambiguous', [h[0]['code'] for h in hits], None
    return 'none', nearest, int(js_round(nd))


def offset_point(lat, lng, meters, bearing_deg):
    """從 (lat,lng) 往 bearing 走 meters 公尺（平面近似，幾十公尺內誤差 < 1%）。"""
    dlat = meters * math.cos(math.radians(bearing_deg)) / 111320.0
    dlng = meters * math.sin(math.radians(bearing_deg)) / (111320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lng + dlng


# ══ 打卡防呆（Liff.gs liffGuard_ 規格）══════════════════════
def counted(evs):
    return [e for e in evs if not str(e['status']).startswith('rejected_')]


def last_counted(evs, now):
    """往回 12 小時內最後一張算數的卡（依 ts 排序）。"""
    cutoff = now - timedelta(hours=ALTERNATION_LOOKBACK_H)
    last = None
    for e in sorted(counted(evs), key=lambda e: e['ts']):
        if parse_iso(e['ts']) >= cutoff:
            last = e
    return last


def guard(evs, now):
    last = last_counted(evs, now)
    if not last:
        return {'last': None, 'blocked': None, 'until': None}
    until = parse_iso(last['ts']) + timedelta(minutes=SAME_TYPE_LOCK_MIN)
    return {'last': last, 'blocked': last['type'] if until > now else None, 'until': until}


def lock_label(type_, until, now):
    """refreshButtons：鎖著寫「上班（N 分後）」，N＝無條件進位的分鐘數。"""
    label = '上班' if type_ == 'in' else '下班'
    left = (until - now).total_seconds() * 1000
    if left <= 0:
        return label
    return '%s（%d 分後）' % (label, math.ceil(left / 60000))


def guard_reject(g, type_, now):
    """liffGuardReject_：鎖內按 → 原因＋怎麼辦。"""
    label = '上班' if type_ == 'in' else '下班'
    if g['until'] and g['until'] > now:
        left = math.ceil((g['until'] - now).total_seconds() * 1000 / 60000)
        return ('你 %s 剛打過%s卡，%d 分鐘內不能打%s卡（避免連按誤打）' % (g['last']['ts'][11:16], '上班' if g['last']['type'] == 'in' else '下班', left, label),
                '真的要%s請告知主管補登' % label)
    return None


def same_type_msg(hm, type_):
    a, b = ('上班', '下班') if type_ == 'in' else ('下班', '上班')
    return '你 %s 已經打過%s卡，中間沒有%s卡。確定要再打%s嗎？\n漏打的%s卡請到「加班請假 → 忘打卡」補。' % (hm, a, b, a, b)


# ══ 問候語（規格：05–11 早安／12–17 午安／18–04 晚上；句子由 ts 字元碼總和 % 3 決定）══
def greeting(type_, ts):
    h = int(ts[11:13])
    bucket = 'morning' if 5 <= h < 12 else 'afternoon' if 12 <= h < 18 else 'evening'
    lst = GREETINGS[type_][bucket]
    return lst[sum(ord(c) for c in ts) % len(lst)]


# ══ 忘打卡提醒（Liff.gs liffMissedDetail_ 規格）══════════════
def missed_detail(evs, type_, ts):
    now = parse_iso(ts)
    span = timedelta(days=MISSED_DAYS) if type_ == 'in' else timedelta(hours=MISSED_PAIR_H)
    mine = sorted([e for e in evs if now - span <= parse_iso(e['ts']) < now], key=lambda e: e['ts'])
    prev = None
    for e in mine:
        if not str(e['status']).startswith('rejected_'):
            prev = e
    other = 'out' if type_ == 'in' else 'in'
    failed = any(e['type'] == other and e['status'] == 'rejected_out_of_range' and (prev is None or e['ts'] > prev['ts']) for e in mine)
    if type_ == 'in':
        if not prev or prev['type'] != 'in':
            return {'text': '', 'date': '', 'miss_type': ''}
        head = '你 %s %s 上班後' % (md_of(prev['ts']), prev['ts'][11:16])
        return {'date': prev['ts'][:10], 'miss_type': 'out',
                'text': head + ('的下班卡沒有打成功（不在範圍內），請跟主管說實際下班時間' if failed else '沒有打下班卡，請跟主管說實際下班時間')}
    if prev and prev['type'] == 'in':
        return {'text': '', 'date': '', 'miss_type': ''}
    return {'date': ts[:10], 'miss_type': 'in',
            'text': '你這次的上班卡沒有打成功（不在範圍內），請跟主管說實際上班時間' if failed else '你這次沒有打上班卡，請跟主管說實際上班時間'}


# ══ 休息規則（Rest.gs 規格：單日 10 小時、班距 11 小時、只擋上班卡、跨店同名一起算）══
def rest_segments(evs):
    lst = sorted([(parse_iso(e['ts']), e['type']) for e in counted(evs) if e['type'] in ('in', 'out')], key=lambda x: x[0])
    segs, open_ = [], None
    for t, typ in lst:
        if typ == 'in':
            open_ = t
            continue
        if open_ is not None and t - open_ <= timedelta(hours=REST_PAIR_H):
            segs.append((open_, t))
        open_ = None
    return segs


def rest_judge(segs, now):
    today = now.strftime('%Y-%m-%d')
    done = [s for s in segs if s[1] <= now]
    if not done:
        return None
    todays = [s for s in done if s[0].strftime('%Y-%m-%d') == today]
    if todays:
        h = sum((b - a).total_seconds() for a, b in todays) / 3600
        if h >= REST_DAY_MAX_H:
            return {'code': 'cap', 'until': None, 'hint': '有問題請找值班主管',
                    'reason': '你今天已經上班 %s 小時（一天最多 %d 小時），不能再打上班卡' % (js_num(js_round(h, 1)), REST_DAY_MAX_H)}
        return None
    last_out = done[-1][1]
    until = last_out + timedelta(hours=REST_GAP_H)
    if now >= until:
        return None
    same_day = until.strftime('%Y-%m-%d') == today
    when = '今天 ' if last_out.strftime('%Y-%m-%d') == today else ' %d/%d ' % (last_out.month, last_out.day)
    return {'code': 'gap', 'until': until, 'hint': '有問題請找值班主管',
            'reason': '你%s%s 下班，兩班要隔 %d 小時，%s%s 以後才能打上班卡' % (
                when, hm_of(last_out), REST_GAP_H, '' if same_day else '%d/%d ' % (until.month, until.day), hm_of(until))}


def rest_expect(my_evs, peer_evs, now, rule_on):
    """liff_status.rest／打上班卡會不會被擋：回 None 或 {code, reason, hint, until}。"""
    if not rule_on:
        return None
    since = now - timedelta(hours=REST_LOOKBACK_H)
    evs = [e for e in my_evs + peer_evs if parse_iso(e['ts']) >= since]
    return rest_judge(rest_segments(evs), now)


# ══ 超時提示（Requests.gs reqOtHint_ 規格）═══════════════════
def ot_hint(evs, out_ts, requests):
    out_t = parse_iso(out_ts)
    ps = sorted([(parse_iso(e['ts']), e['type'], e['ts'][:10]) for e in counted(evs)
                 if out_t - timedelta(hours=3 * REQ_PAIR_H) <= parse_iso(e['ts']) <= out_t], key=lambda x: x[0])
    segs, open_ = [], None
    for p in ps:
        if p[1] == 'in':
            open_ = p
            continue
        if open_ and p[0] - open_[0] <= timedelta(hours=REQ_PAIR_H):
            segs.append((open_, p))
        open_ = None
    mine = next((s for s in segs if s[1][0] == out_t), None)
    if not mine:
        return None
    date = mine[0][2]
    ms = sum((s[1][0] - s[0][0]).total_seconds() * 1000 for s in segs if s[0][2] == date)
    hours = js_round(ms / 36000) / 100
    if hours <= OT_HINT_H:
        return None
    if any(r['kind'] == 'ot' and r['date'] == date and r['status'] in ('pending', 'approved') for r in requests):
        return None
    end = out_ts[11:16]
    start_min = hm_min(end) - (ms - OT_HINT_H * 3600000) / 60000
    start_min = (math.floor(start_min / 15) * 15) % 1440
    return {'date': date, 'hours': hours, 'start': min_hm(int(start_min)), 'end': end}


# ══ 那一天缺哪張卡（Requests.gs reqDayInfo_ 規格）═══════════
def day_info(evs, date):
    lo = (datetime.strptime(date, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')
    hi = (datetime.strptime(date, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
    allp = sorted([{'type': e['type'], 'hm': e['ts'][11:16], 'status': str(e['status']), 'date': e['ts'][:10], 't': parse_iso(e['ts'])}
                   for e in evs if lo <= e['ts'][:10] <= hi], key=lambda p: p['t'])
    segs, open_ins, lone_outs, open_ = [], [], [], None
    for p in allp:
        if p['status'].startswith('rejected_'):
            continue
        if p['type'] == 'in':
            if open_:
                open_ins.append(open_)
            open_ = p
        elif open_ and p['t'] - open_['t'] <= timedelta(hours=REQ_PAIR_H):
            segs.append((open_, p))
            open_ = None
        else:
            if open_:
                open_ins.append(open_)
                open_ = None
            lone_outs.append(p)
    if open_:
        open_ins.append(open_)
    day_of = lambda p: (datetime.strptime(p['date'], '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d') if p['type'] == 'out' and p['hm'] <= REQ_EARLY_OUT_HM else p['date']
    mine_ins = [p for p in open_ins if p['date'] == date]
    mine_outs = [p for p in lone_outs if day_of(p) == date]
    mine_segs = [s for s in segs if s[0]['date'] == date]
    show = [p for p in allp if p['date'] == date] + [p for p in allp if p['date'] == hi and (any(s[1] is p for s in mine_segs) or p in mine_outs)]
    punches = [{'type': p['type'], 'hm': p['hm'] + ('(+1)' if p['date'] != date else ''), 'status': p['status']} for p in show]
    if not mine_segs and not mine_ins and not mine_outs:
        opts = ['both']
    else:
        opts = (['in'] if mine_outs else []) + (['out'] if mine_ins else [])
    spans = [{'in': s[0]['hm'], 'out': s[1]['hm'], 'out_next': s[1]['date'] != date} for s in mine_segs] + \
            [{'in': p['hm'], 'out': None, 'out_next': False} for p in mine_ins]
    if spans:
        opts.append('break')
    lo1 = mine_outs[0] if mine_outs else None
    return {'punches': punches, 'options': opts, 'open_in': mine_ins[-1]['hm'] if mine_ins else None,
            'lone_out': lo1['hm'] if lo1 else None, 'lone_out_next': bool(lo1 and lo1['date'] != date), 'spans': spans}


def rec_text(punches):
    """req-line.js：'當天紀錄：HH:MM 上班 ✓、HH:MM 下班（沒有打成功）' 或 '當天紀錄：沒有任何打卡'"""
    if not punches:
        return '當天紀錄：沒有任何打卡'
    return '當天紀錄：' + '、'.join(x['hm'] + ' ' + ('上班' if x['type'] == 'in' else '下班') + ('（沒有打成功）' if x['status'].startswith('rejected_') else ' ✓') for x in punches)


MISS_LABEL = {'in': '上班卡', 'out': '下班卡', 'both': '上班和下班都沒打', 'break': '中間休息沒打卡'}


def req_summary(r):
    """Requests.gs reqSummary_"""
    md = md_of(r['date'])
    if r['kind'] == 'leave':
        return '%s %s %s %s 小時' % (md, r['leave_type'], ('%s–%s' % (r['start'], r['end'])) if r.get('start') else '整天', js_num(r['hours']))
    if r['kind'] == 'ot':
        return '%s 加班 %s–%s（%s 小時）' % (md, r['start'], r['end'], js_num(r['hours']))
    if r['kind'] == 'trip':
        return '%s 出差 %s %s 小時（地點：%s）' % (md, ('%s–%s' % (r['start'], r['end'])) if r.get('start') else '整天', js_num(r['hours']), r['place'])
    if r['miss_type'] == 'break':
        return '%s 忘打卡補登（中間休息：下班 %s、回來上班 %s）' % (md, r['end'], r['start'])
    parts = []
    if r['miss_type'] in ('in', 'both'):
        parts.append('上班 ' + r['start'])
    if r['miss_type'] in ('out', 'both'):
        parts.append('下班 ' + r['end'])
    return '%s 忘打卡補登（%s）' % (md, '、'.join(parts))


def mine_title(r):
    """req-line.js renderMine 的標題列"""
    if r['kind'] == 'leave':
        return '%s %s 小時' % (r['leave_type'], js_num(r['hours']))
    if r['kind'] == 'ot':
        return '加班 %s 小時' % js_num(r['hours'])
    if r['kind'] == 'trip':
        return '出差 %s 小時' % js_num(r['hours'])
    if r['miss_type'] == 'break':
        return '忘打卡・補休息 %s–%s' % (r['end'], r['start'])
    return '忘打卡・補' + ('上下班卡' if r['miss_type'] == 'both' else ('上班卡 ' + r['start']) if r['miss_type'] == 'in' else ('下班卡 ' + r['end']))


def mine_sub(r):
    """req-line.js renderMine 的副標：日期（週）＋時段／整天＋・原因"""
    reason = r.get('reason_stored') if r.get('reason_stored') is not None else r.get('reason', '')
    s = md_wk(r['date'])
    if r.get('start') and r['kind'] != 'miss':
        s += ' %s–%s' % (r['start'], r['end'])
    elif r['kind'] in ('leave', 'trip'):
        s += ' 整天'
    if reason:
        s += '・' + reason
    return s


def quota_text(q):
    """req-line.js quotaText"""
    r1 = lambda v: js_num(js_round(float(v or 0), 1))
    if q.get('cap_days') is None:
        return ''
    if q.get('basis') == 'event':
        return '每次上限 %s 小時' % r1(q['cap_h'])
    return ('已超出 %s 小時' % r1(-q['remain_h'])) if q['remain_h'] < 0 else '剩 %s 小時（上限 %s）' % (r1(q['remain_h']), r1(q['cap_h']))


def comp_text(c):
    """req-line.js compText：'M 月加班 X − 補休 Y ＝ 剩／欠 N 小時'"""
    r2 = lambda v: js_num(js_round(float(v or 0), 2))
    b = js_round(float(c['balance_h']), 2)
    m = '%d 月' % int(c['ym'][5:7])
    return '%s加班 %s − 補休 %s ＝ %s 小時' % (m, r2(c['ot_h']), r2(c['used_h']), ('欠 ' + js_num(-b)) if b < 0 else ('剩 ' + js_num(b)))


# ══ 班表（Sched.gs／sched-line.js 規格）═══════════════════════
OFF_TEXT = {'R': '例假', 'H': '休假'}


def parse_time(t):
    import re
    if not t:
        return []
    s = str(t).replace('~', '～').replace('\n', '')
    rs = re.findall(r'\d{1,2}:\d{2}～\d{1,2}:\d{2}', s)
    pad = lambda hm: '%02d:%s' % (int(hm.split(':')[0]), hm.split(':')[1])
    return [[pad(a), pad(b)] for a, b in (r.split('～') for r in rs)]


def sched_day(code, shifts, station):
    """上班＝!isOff 且不是國；休假＝isOff 或國；時數＝hours−breakH；有站別才帶 station。"""
    if not code:
        return {'code': '', 'label': '', 'segs': [], 'hours': 0, 'work': False, 'rest': False}
    sh = shifts[code]
    work = not sh['isOff'] and code != '國'
    d = {'code': code, 'label': sh['name'], 'segs': parse_time(sh['time']) if work else [],
         'hours': max(sh['hours'] - sh['breakH'], 0) if work else 0, 'work': work, 'rest': sh['isOff'] or code == '國'}
    if work and code in station:
        d['station'] = station[code]
    return d


def off_text(d):
    """sched-line.js offText：R→例假、H→休假，其餘用後端 label（沒有 label 就代碼）"""
    return OFF_TEXT.get(d['code'], d['label'] or d['code'])


def sched_expect(custom, person, ym, today, now_hm):
    """一個人一個月的預期：每天格子文字、明細、摘要、下一個班。"""
    y, m = int(ym[:4]), int(ym[5:7])
    nxt = datetime(y + (m == 12), 1 if m == 12 else m + 1, 1)
    last = (nxt - timedelta(days=1)).day
    row = person['months'].get(ym) or {}
    blank_rest = (not person['full_time']) and bool(row)
    days, wd, od, hrs = [], 0, 0, 0.0
    notes = (custom.get('notes') or {}).get(ym) or {}
    for d in range(1, last + 1):
        code = row.get(str(d), '') or ('休' if blank_rest else '')
        x = sched_day(code, custom['shifts'], custom.get('station') or {})
        x['d'] = d
        if notes.get(str(d)):
            x['note'] = notes[str(d)]
        days.append(x)
        if x['work']:
            wd += 1
            hrs += x['hours']
        if x['rest']:
            od += 1
    nx = None
    if today[:7] == ym:
        for x in days[int(today[8:10]) - 1:]:
            if not x['work'] or not x['segs']:
                continue
            if x['d'] == int(today[8:10]):
                a, b = x['segs'][-1]
                if b > a and b <= now_hm:
                    continue
            nx = x
            break
    return {'days': days, 'summary': {'work_days': wd, 'off_days': od, 'hours': js_round(hrs, 2)}, 'next': nx}


def sched_cell(x):
    """月曆格子的字（split 後）：上班＝[日, 第一段上班, 最後一段下班]；上班沒時段＝[日, 代碼]；休假＝[日, 中文]；空白＝[日]"""
    if x['work'] and x['segs']:
        return [str(x['d']), x['segs'][0][0], x['segs'][-1][1]]
    if x['work']:
        return [str(x['d']), x['code']]
    if x['code']:
        return [str(x['d']), off_text(x)]
    return [str(x['d'])]


def sched_detail(x, ym):
    """明細各列（不含備註列）"""
    date = '%s-%02d' % (ym, x['d'])
    rows = [md_wk(date)]
    if not x['code']:
        rows.append('這天沒有排班')
    elif not x['work']:
        rows.append(off_text(x))
    else:
        rows.append('班別\n' + x['label'])
        if x.get('station'):
            rows.append('工作站\n' + x['station'])
        CN = ['一', '二', '三', '四', '五', '六']
        for i, s in enumerate(x['segs']):
            rows.append(('第%s段' % CN[i] if len(x['segs']) > 1 else '上班時間') + '\n' + s[0] + '–' + s[1])
        rows.append('合計\n%s 小時' % js_num(js_round(x['hours'], 2)))
    for k, lbl in (('lunch', '午餐備註'), ('dinner', '晚餐備註')):
        if x.get('note', {}).get(k):
            rows.append(lbl + '\n' + x['note'][k])
    return '\n'.join(rows)


# ══ 隨機資料 ════════════════════════════════════════════════
class Gen:
    def __init__(self, seed, stores, now=None):
        self.rng = random.Random(seed)
        self.seed = seed
        self.stores = stores
        self.now = (now or datetime.now(TZ)).replace(microsecond=0)
        self.used_names = set()
        self.uid_n = 0

    # ── 基本抽樣 ──
    def name(self):
        while True:
            n = '測試' + self.rng.choice(STEMS) + self.rng.choice(BRANCHES)
            if n not in self.used_names:
                self.used_names.add(n)
                return n

    def uid(self):
        self.uid_n += 1
        return 'U%03d%s' % (self.uid_n, ''.join(self.rng.choice('abcdef0123456789') for _ in range(6)))

    def key(self):
        return 'k' + ''.join(self.rng.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(12))

    def shift(self):
        a = self.rng.choice([8 * 60, 9 * 60, 10 * 60, 11 * 60, 15 * 60, 17 * 60])
        b = (a + self.rng.choice([8 * 60, 8 * 60 + 30, 9 * 60])) % 1440
        return min_hm(a), min_hm(b)

    def at(self, **kw):
        """now 往前推 kw（hours／minutes／days）的時刻"""
        return self.now - timedelta(**kw)

    def person(self, store, scenario, bound=True, name=None):
        return {'store': store, 'emp_id': None, 'name': name or self.name(), 'key': self.key(), 'device_id': '', 'device_bound_at': '',
                'active': True, 'line_user_id': self.uid() if bound else '', 'line_bound_at': '', 'shift_in': self.shift()[0], 'shift_out': self.shift()[1],
                'scenario': scenario, 'events': [], 'requests': []}

    def ev(self, dt, typ, status='ok'):
        return {'ts': iso(dt), 'type': typ, 'status': status}

    def gap_segment(self, left_min=20, left_max=600, out_t=None, dur_range=(4, 9)):
        """「上一段班」給班距規則用：下班卡在 11 小時內（還剩 left 分鐘才滿 11 小時），而且上班卡在今天 00:00 之前——
        段落歸上班卡那天，同一天的段落照規格不看間隔，所以要擋就一定是前一天（或跨夜）的班。配對上限 16 小時，段長最多 15.5 小時。"""
        r = self.rng
        midnight = self.now.replace(hour=0, minute=0, second=0)
        base = self.now - timedelta(hours=REST_GAP_H)
        if out_t is None:
            cap = int((midnight + timedelta(hours=14.5) - base).total_seconds() // 60)   # 下班卡最晚 14:30，段長才塞得進 15.5 小時
            hi = max(20, min(left_max, cap, REST_GAP_H * 60 - 20))
            left = r.randint(min(left_min, hi), hi)
            out_t = base + timedelta(minutes=left)
        dur_lo = timedelta(hours=dur_range[0])
        if out_t > midnight:
            dur_lo = max(dur_lo, out_t - midnight + timedelta(minutes=r.randint(30, 90)))
        dur_hi = max(dur_lo, timedelta(hours=dur_range[1]))
        dur = min(dur_lo + timedelta(minutes=r.randint(0, int((dur_hi - dur_lo).total_seconds() // 60))), timedelta(hours=15.5))
        return out_t - dur, out_t

    # ── 情境（每個人一個中心，數值在中心附近浮動）──
    def seed_scenario(self, p):
        r, s = self.rng, p['scenario']
        if s == 'fresh':
            return
        if s == 'lock':   # 5 分 30 秒前打了一張（上班或下班）：兩顆都鎖、強按另一顆被伺服器擋
            p['lock_type'] = r.choice(['in', 'out'])
            p['events'] = [self.ev(self.at(minutes=5, seconds=30), p['lock_type'])]
            if p['lock_type'] == 'out':   # 下班卡前面要有上班卡才合理
                p['events'].insert(0, self.ev(self.at(hours=r.randint(4, 8), minutes=r.randint(0, 59)), 'in'))
            return
        if s == 'missed_out':   # 1～6 天前上班、沒打下班 → 今天打上班要提醒
            d = r.randint(1, 6)
            t = self.at(days=d).replace(hour=r.randint(8, 18), minute=r.randint(0, 59), second=r.randint(0, 59))
            p['events'] = [self.ev(t, 'in')]
            return
        if s == 'missed_in':   # 16 小時內沒有上班卡（有也是 20 小時前的）→ 今天打下班要提醒；一半的人有「被擋的上班卡」
            if r.random() < 0.5:
                p['events'].append(self.ev(self.at(hours=20, minutes=r.randint(0, 59)), 'in'))
                p['events'].append(self.ev(self.at(hours=19), 'out'))
            p['rejected_in'] = r.random() < 0.5
            if p['rejected_in']:
                p['events'].append(self.ev(self.at(minutes=r.randint(30, 90)), 'in', 'rejected_out_of_range'))
            return
        if s == 'overtime':   # 今天上班 8.25～11.75 小時後打下班 → 超時提示；有些人前面還有一段
            h = r.choice([8.25, 8.5, 9, 9.5, 10, 10.75, 11.5]) + r.randint(0, 14) / 60
            if r.random() < 0.4:   # 前一段 1～2 小時，中間休息 30 分
                a = self.at(hours=h, minutes=r.randint(90, 150))
                p['events'] += [self.ev(a, 'in'), self.ev(a + timedelta(minutes=r.randint(60, 110)), 'out')]
            p['events'].append(self.ev(self.at(hours=h), 'in'))
            return
        if s == 'rest_gap':   # 前一天（或跨夜）那段班的下班離現在不到 11 小時（還剩 20 分～10 小時），今天沒有別的段 → 上班鍵鎖到幾點
            in_t, out_t = self.gap_segment()
            p['events'] = [self.ev(in_t, 'in'), self.ev(out_t, 'out')]
            return
        if s == 'rest_gap_soon':   # 再幾秒就滿 11 小時：畫面自動解鎖（測試開頁前會照這個形狀重放一次時間）
            in_t, out_t = self.gap_segment(out_t=self.at(hours=REST_GAP_H) + timedelta(seconds=4))
            p['events'] = [self.ev(in_t, 'in'), self.ev(out_t, 'out')]
            return
        if s == 'rest_cap':   # 今天已打滿 10 小時以上（可能分兩段），最後一段 15～40 分前結束
            total = r.choice([10, 10.25, 10.5, 11]) * 60 + r.randint(0, 9)
            end = self.at(minutes=r.randint(15, 40))
            if r.random() < 0.5:
                first = r.randint(120, 300)
                b_in = end - timedelta(minutes=total - first)
                a_out = b_in - timedelta(minutes=r.randint(30, 60))
                p['events'] = [self.ev(a_out - timedelta(minutes=first), 'in'), self.ev(a_out, 'out'), self.ev(b_in, 'in'), self.ev(end, 'out')]
            else:
                p['events'] = [self.ev(end - timedelta(minutes=total), 'in'), self.ev(end, 'out')]
            return
        if s == 'two_shift':   # 今天一段 3～5 小時、30～90 分前結束 → 同一天第二段不看間隔，可以打上班
            end = self.at(minutes=r.randint(30, 90))
            p['events'] = [self.ev(end - timedelta(hours=r.randint(3, 5), minutes=r.randint(0, 59)), 'in'), self.ev(end, 'out')]
            return
        if s == 'cross_store':   # 自己這家店沒卡；同名的人在別家店前一天那段班 2～8 小時前才下班 → 這家店打上班也被擋（peer 由 build 另外放）
            p['peer_seg'] = self.gap_segment(left_min=180, left_max=540)
            return

    def build(self):
        r = self.rng
        codes = [s['code'] for s in self.stores]
        a, b = r.sample(codes, 2)
        A, B = next(s for s in self.stores if s['code'] == a), next(s for s in self.stores if s['code'] == b)
        rest_on = {a: True, b: r.random() < 0.5}   # A 一定開擋卡；B 隨機（測總開關）
        scen = ['fresh', 'lock', 'missed_out', 'missed_in', 'overtime', 'rest_gap', 'rest_gap_soon', 'rest_cap', 'two_shift', 'cross_store']
        people = []
        # A 店：每個情境至少一人，再隨機補 0～2 人
        for s in scen + [r.choice(scen) for _ in range(r.randint(0, 2))]:
            people.append(self.person(a, s))
        # B 店：一位 fresh（失敗路徑那一段要用）＋ 2～3 人隨機情境（擋卡開關隨機，驗「關著就不擋」）
        for s in ['fresh'] + r.sample(['rest_gap', 'two_shift', 'overtime', 'missed_out'], r.randint(2, 3)):
            people.append(self.person(b, s))
        for p in people:
            self.seed_scenario(p)
        # 跨店同名：cross_store 那位在 B 店也有一個同名的人（綁別的 LINE），B 店那邊剛打下班
        for p in [x for x in people if x['scenario'] == 'cross_store']:
            peer = self.person(b, 'peer', name=p['name'])
            peer['events'] = [self.ev(p['peer_seg'][0], 'in'), self.ev(p['peer_seg'][1], 'out')]
            people.append(peer)
        # 綁定流程：A 店一位還沒綁（輸入全名）、一位名字被別的 LINE 綁走；跨店建議：A 店已綁的人在 B 店有同名未綁的列
        unbound = self.person(a, 'bind_new', bound=False)
        people.append(unbound)
        taken = self.person(a, 'bind_taken')
        people.append(taken)
        cross = self.person(a, 'bind_cross')
        people.append(cross)
        cross_b = self.person(b, 'bind_cross_target', bound=False, name=cross['name'])
        people.append(cross_b)
        # QR 打卡：A 店一位沒有任何卡
        people.append(self.person(a, 'qr'))
        # 申請頁：A 店兩位（一位只綁 A、一位綁 A＋B）＋ 忘打卡各種日子的人
        req1 = self.person(a, 'req_single')
        people.append(req1)
        req2 = self.person(a, 'req_dual')
        people.append(req2)
        req2_b = self.person(b, 'req_dual_b', name=req2['name'])
        req2_b['line_user_id'] = req2['line_user_id']
        people.append(req2_b)
        miss = self.person(a, 'req_miss')
        people.append(miss)
        self.seed_miss_days(miss)
        self.seed_dual_days(req2, req2_b)
        # 班表：光復名冊兩位（正職／計時）＋一位排班系統有兩個同名
        sched_people = [self.person('', 'sched_full'), self.person('', 'sched_part'), self.person('', 'sched_dup')]
        people += sched_people
        # 編號：每家店自己排
        for code in set(x['store'] for x in people):
            for i, p in enumerate([x for x in people if x['store'] == code]):
                p['emp_id'] = 'E%02d' % (i + 1)
        self.people = people
        self.A, self.B, self.rest_on = A, B, rest_on
        self.managers = {code: {'name': '測試主管' + r.choice(STEMS), 'key': 'm' + ''.join(r.choice('abcdefghjkmnpqrstuvwxyz23456789') for _ in range(10)), 'active': True}
                         for code in [a, b, '']}
        self.comp = {'allowed': True, 'ot_h': r.choice([0, 2, 4.5, 8]), 'used_h': r.choice([0, 1, 4, 6.5]), 'ym': self.now.strftime('%Y-%m')}
        self.comp['balance_h'] = js_round(self.comp['ot_h'] - self.comp['used_h'], 2)
        self.quota = [{'name': '特休假', 'cap_days': 7, 'cap_h': 56, 'remain_h': r.choice([-8, 0, 12.5, 40, 56]), 'used_h': 16, 'basis': 'tenure'},
                      {'name': '事假', 'cap_days': 14, 'cap_h': 112, 'remain_h': r.choice([3.5, 100]), 'used_h': 12, 'basis': 'calendar'},
                      {'name': '生理假', 'cap_days': 1, 'cap_h': 8, 'remain_h': 8, 'used_h': 0, 'basis': 'event'}]
        self.sched = self.build_sched(sched_people)
        # 公告文字要各不相同：兩則一樣的話畫面輪播了也看不出來（輪播只能靠文字變化驗）
        self.notices = [{'text': '測試公告：' + t} for t in r.sample(['花椒粉用完換辣椒粉', '今晚盤點', '<b>不是粗體</b>', '週五早班提早 30 分'], r.randint(1, 3))]
        return self

    def seed_miss_days(self, p):
        """忘打卡：7 天內各種日子——沒卡／只有上班卡／只有下班卡／整段／三種都有／跨夜；今天開著的上班卡。"""
        r = self.rng
        t = lambda d, hm: iso(self.at(days=d).replace(hour=int(hm[:2]), minute=int(hm[3:]), second=0))
        ev = lambda d, hm, typ, st='ok': {'ts': t(d, hm), 'type': typ, 'status': st}
        days = {'none': 1, 'in_only': 2, 'out_only': 3, 'full': 4, 'three': 5, 'night': 6}
        p['miss_days'] = {k: self.at(days=v).strftime('%Y-%m-%d') for k, v in days.items()}
        p['events'] += [ev(2, '%02d:%02d' % (r.randint(8, 11), r.randint(0, 59)), 'in'),
                        ev(2, '13:00', 'in', 'rejected_out_of_range'),   # 被擋的卡要顯示「沒有打成功」
                        ev(3, '%02d:%02d' % (r.randint(16, 21), r.randint(0, 59)), 'out'),
                        ev(4, '09:%02d' % r.randint(0, 59), 'in'), ev(4, '18:%02d' % r.randint(0, 59), 'out'),
                        ev(5, '08:05', 'out'), ev(5, '09:10', 'in'), ev(5, '13:20', 'out'), ev(5, '18:00', 'in'),
                        ev(6, '17:30', 'in'), ev(5, '01:30', 'out')]   # 跨夜：6 天前晚上上班、5 天前凌晨下班 → 歸 6 天前，5 天前的凌晨卡標 (+1)
        p['events'].append(self.ev(self.at(hours=3, minutes=r.randint(0, 30)), 'in'))   # 今天上班中（補休息要擋還沒到的時間）

    def seed_dual_days(self, pa, pb):
        """綁兩家店的人：D1 只有 B 店有卡（自動換店）、D2 兩家都有、D3 都沒有；最近一張卡在 B（預設店別＝B）。"""
        r = self.rng
        t = lambda d, hm: self.at(days=d).replace(hour=int(hm[:2]), minute=int(hm[3:]), second=0)
        pa['dual_days'] = {'b_only': self.at(days=1).strftime('%Y-%m-%d'), 'both': self.at(days=2).strftime('%Y-%m-%d'), 'none': self.at(days=3).strftime('%Y-%m-%d')}
        pb['events'] += [self.ev(t(1, '17:%02d' % r.randint(0, 59)), 'in'), self.ev(t(2, '17:00'), 'in'), self.ev(t(2, '21:30'), 'out')]
        # 最近一張卡在 A（1 小時前）→ 申請頁預設店別＝A；自動選店才看得出「換到 B」
        pa['events'] += [self.ev(t(2, '11:00'), 'in'), self.ev(t(2, '15:00'), 'out'), self.ev(self.at(hours=1), 'in')]

    def build_sched(self, sched_people):
        r = self.rng
        def seg(a, n):
            return '%s～%s' % (min_hm(a), min_hm(a + n))
        shifts = {}
        for code in ['A', 'B', 'C']:
            a = r.choice([9, 10, 11, 15, 17]) * 60
            n = r.choice([240, 300, 480, 510])
            if r.random() < 0.4:   # 兩段班（真資料常見的寫法：兩段相連）
                m = r.choice([180, 210])
                time = seg(a, m) + seg(a + m + r.choice([180, 210]), n - m)
            else:
                time = seg(a, n)
            shifts[code] = {'name': code + '班', 'time': time, 'hours': n / 60, 'breakH': r.choice([0, 0.5]), 'isOff': False}
        shifts.update({'R': {'name': '例假', 'time': '', 'hours': 0, 'breakH': 0, 'isOff': True},
                       'H': {'name': '休息日', 'time': '', 'hours': 0, 'breakH': 0, 'isOff': True},
                       '特': {'name': '特休', 'time': '特休假', 'hours': 0, 'breakH': 0, 'isOff': True},
                       '病': {'name': '病假', 'time': '', 'hours': 0, 'breakH': 0, 'isOff': True},
                       '國': {'name': '國定假日', 'time': '國定假日', 'hours': 0, 'breakH': 0, 'isOff': False},
                       '公休': {'name': '公休', 'time': '－', 'hours': 8, 'breakH': 0, 'isOff': False},
                       '休': {'name': '休假', 'time': '－', 'hours': 0, 'breakH': 0, 'isOff': True}})
        station = {c: r.choice(['炒鍋', '外場', '吧台']) for c in r.sample(['A', 'B', 'C'], 2)}
        y, m = self.now.year, self.now.month
        py, pm = (y - 1, 12) if m == 1 else (y, m - 1)
        cur, prev = '%d-%02d' % (y, m), '%d-%02d' % (py, pm)
        pool = ['A', 'B', 'C', 'A', 'B', 'R', 'H', '特', '病', '國', '公休', '']
        def month(ym, full):
            yy, mm = int(ym[:4]), int(ym[5:7])
            nxt = datetime(yy + (mm == 12), 1 if mm == 12 else mm + 1, 1)
            last = (nxt - timedelta(days=1)).day
            row = {}
            for d in range(1, last + 1):
                c = r.choice(pool if full else ['A', 'C', '', '', 'R'])
                if c:
                    row[str(d)] = c
            for c in ['A', 'B', 'R', 'H', '國', '公休', '病']:   # 每種都至少出現一次
                if full and c not in row.values():
                    row[str(r.randint(1, last))] = c
            return row
        full, part, dup = sched_people
        people = [{'name': full['name'], 'full_time': True, 'months': {prev: month(prev, True), cur: month(cur, True)}},
                  {'name': part['name'], 'full_time': False, 'months': {cur: month(cur, False)}},
                  {'name': dup['name'], 'full_time': True, 'months': {cur: {'1': 'A'}}},
                  {'name': dup['name'], 'full_time': True, 'months': {cur: {'2': 'A'}}}]
        notes = {cur: {str(d): {'lunch': r.choice(['12:00 有 30 人團體訂位', '午餐只開內場']), 'dinner': r.choice(['提早 30 分鐘盤點', ''])}
                       for d in r.sample(range(1, 28), 2)}}
        return {'shifts': shifts, 'station': station, 'people': people, 'notes': notes, 'months': [prev, cur]}


# ══ 給 mock 的資料檔 ══════════════════════════════════════════
def store_file_data(gen, code):
    """那家店的 mock 資料檔內容（名冊、打卡、主管、申請、公告、擋卡開關）。"""
    people = [p for p in gen.people if p['store'] == code]
    roster = [{k: p[k] for k in ('emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active', 'line_user_id', 'line_bound_at', 'shift_in', 'shift_out')} for p in people]
    events = []
    for p in people:
        for e in sorted(p['events'], key=lambda e: e['ts']):
            ok = e['status'] == 'ok'
            events.append({'ts': e['ts'], 'emp_id': p['emp_id'], 'type': e['type'], 'status': e['status'], 'lat': 0, 'lng': 0,
                           'distance_m': 1 if ok else 300, 'accuracy_m': 10, 'device_id': 'line:' + (p['line_user_id'] or 'x'),
                           'device_match': True, 'within_range': ok})
    events.sort(key=lambda e: e['ts'])
    d = {'roster': roster, 'events': events, 'managers': [gen.managers.get(code) or {'name': '測試主管', 'key': 'mgr' + code, 'active': True}],
         'approved': [], 'leave': [], 'notices': [], 'requests': []}
    if gen.rest_on.get(code):
        d['rest_rule_on'] = '1'
    if code == '':
        d['mock_comp'] = gen.comp
        d['mock_quota'] = gen.quota
        d['mock_sched'] = {'custom': {k: gen.sched[k] for k in ('shifts', 'station', 'people', 'notes')}}
    return d
