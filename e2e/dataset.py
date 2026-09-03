# -*- coding: utf-8 -*-
"""打卡／值班核定 e2e 的隨機資料與預期值。

規矩（同 data-drive-test skill）：
  1. 每次執行全部重抽，不重用開發時那組（種子同仁「測試一～四」）。
  2. 預期值照規格自己算，不 import 後端任何程式。
"""
import math
import random
from datetime import date, timedelta

SURNAMES = '陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐簡鍾詹'
GIVEN = '志明淑芬家豪雅婷俊傑怡君建宏心怡宗翰佩君柏翰欣怡承翰詩涵冠廷之婷宜蓁彥廷'


# ── 規格重寫 ──────────────────────────────────────────────
def round_in(minutes):
    """上班時間往後進位到 15 分刻度（11:02 → 11:15）。"""
    return math.ceil(minutes / 15) * 15


def round_out(minutes):
    """下班時間往前捨去到 15 分刻度（14:31 → 14:30）。"""
    return math.floor(minutes / 15) * 15


def reference_hours(segments):
    """參考時數＝每段各自取整後相減再加總（負數歸零）。segments: [(in分, out分)]"""
    total = 0
    for a, b in segments:
        total += max(0, round_out(b) - round_in(a))
    return round(total / 60, 2)


def approved_hours(periods):
    """核定時數＝主管輸入的時段總長（不取整）。periods: [(起分, 迄分)]"""
    total = 0
    for a, b in periods:
        span = b - a
        if span <= 0:
            span += 24 * 60          # 跨夜
        total += span
    return round(total / 60, 2)


def late_early(periods, segments):
    """遲到＝第一段打卡晚於第一個時段起點；早退＝最後一段打卡早於最後時段終點。
    規格：只比第一段起點與最後一段終點，且無寬限。"""
    if not periods or not segments:
        return (0, 0)
    late = max(0, segments[0][0] - periods[0][0])
    early = max(0, periods[-1][1] - segments[-1][1])
    return (late, early)


def hhmm(minutes):
    return f'{minutes // 60:02d}:{minutes % 60:02d}'


def make_dataset(rng, workday=None):
    used = set()

    def name():
        while True:
            n = rng.choice(SURNAMES) + rng.choice(GIVEN) + rng.choice(GIVEN)
            if n not in used:
                used.add(n)
                return n

    n_people = rng.randint(4, 7)
    people = []
    for i in range(n_people):
        shift_in = rng.choice([8 * 60, 8 * 60 + 30, 9 * 60, 11 * 60])
        shift_len = rng.choice([8 * 60, 8 * 60 + 30, 9 * 60])
        people.append({
            'emp_id': f'E{i + 1:02d}',
            'name': name(),
            'key': f'k{rng.randrange(10**8, 10**9)}',
            'device_id': '',
            'device_bound_at': '',
            'active': True,
            'line_user_id': '',
            'line_bound_at': '',
            'shift_in': hhmm(shift_in),
            'shift_out': hhmm((shift_in + shift_len) % (24 * 60)),
        })

    # 昨天當作「已有打卡紀錄的那一天」——今天要留給真打卡流程用
    day = workday or (date.today() - timedelta(days=1))

    # 每人隨機一組打卡（有人準時、有人遲到、有人早退、有人分兩段、有人忘刷下班卡）
    patterns = ['準時', '遲到', '早退', '兩段', '忘刷下班']
    for i, p in enumerate(people):
        p['pattern'] = patterns[i % len(patterns)] if i < len(patterns) else rng.choice(patterns)
        sin = int(p['shift_in'][:2]) * 60 + int(p['shift_in'][3:])
        sout = int(p['shift_out'][:2]) * 60 + int(p['shift_out'][3:])
        if sout <= sin:
            sout += 8 * 60
        if p['pattern'] == '準時':
            segs = [(sin - rng.randint(0, 8), sout + rng.randint(0, 8))]
        elif p['pattern'] == '遲到':
            segs = [(sin + rng.randint(5, 25), sout + rng.randint(0, 5))]
        elif p['pattern'] == '早退':
            segs = [(sin - rng.randint(0, 5), sout - rng.randint(10, 40))]
        elif p['pattern'] == '兩段':
            mid = (sin + sout) // 2
            segs = [(sin - rng.randint(0, 5), mid - rng.randint(5, 20)),
                    (mid + rng.randint(5, 20), sout + rng.randint(0, 5))]
        else:                                  # 忘刷下班卡：只有上班那張
            segs = [(sin + rng.randint(0, 10), None)]
        p['segments'] = segs
        # 主管核定的時段：照班別（＝最常見的實務做法）
        p['periods'] = [(sin, sout)] if p['pattern'] != '兩段' else [
            (sin, (sin + sout) // 2), ((sin + sout) // 2, sout)]

    return {'people': people, 'workday': day.isoformat(),
            'manager': {'name': name(), 'key': f'm{rng.randrange(10**8, 10**9)}', 'active': True}}


def expectations(data):
    """每個人的預期值：參考時數、核定時數、遲到/早退分鐘、狀態字樣。"""
    out = {}
    for p in data['people']:
        segs = [(a, b) for a, b in p['segments'] if b is not None]
        incomplete = any(b is None for _, b in p['segments'])
        ref = None if incomplete else reference_hours(segs)      # 忘刷卡當天參考留白
        app = approved_hours(p['periods'])
        late, early = late_early(p['periods'], segs) if segs else (0, 0)
        notes = []
        if incomplete:
            notes.append('下班忘刷卡')
        if late:
            notes.append(f'遲到{late}分')
        if early:
            notes.append(f'早退{early}分')
        out[p['name']] = {
            'emp_id': p['emp_id'], 'pattern': p['pattern'],
            'reference': ref, 'approved': app,
            'late': late, 'early': early, 'notes': notes,
        }
    return out


# ══ 薪酬模組 ══════════════════════════════════════════════
def make_payroll(rng, data):
    """薪資主檔與當月工時，全部隨機。金額刻意用整百，方便人工核對。"""
    master, inputs = [], {}
    for p in data['people']:
        full = rng.random() < 0.4
        wage = rng.choice([190, 200, 210, 230, 250])
        m = {
            'emp_id': p['emp_id'], 'name': p['name'],
            'is_full_time': 'TRUE' if full else 'FALSE',
            'wage': wage,
            'base': rng.choice([30000, 32000, 35000, 38000]) if full else 0,
            'ot_rate': round(wage * 1.34),
            'skill_allow': rng.choice([0, 1000, 2000]),
            'night_allow': rng.choice([0, 500]),
            'mgr_allow': rng.choice([0, 3000]) if full else 0,
            'meal_allow': rng.choice([0, 2400]),
            'labor_ins': rng.choice([500, 800, 1000]),
            'health_ins': rng.choice([400, 600, 900]),
            'dormitory': rng.choice([0, 2000]),
            'active': 'TRUE', 'store': '',
        }
        master.append(m)
        # support 是「跨店支援」的明細陣列，不是單一數字（前端會 .filter）
        sup = []
        if rng.random() < 0.4:
            sup.append({'store': rng.choice(['CF', 'HQ']),
                        'hours': rng.choice([4, 6, 10]), 'amount': ''})
        inputs[p['emp_id']] = {
            'hours': rng.choice([120, 150, 168, 174, 180, 190]),
            'extra_ot': rng.choice([0, 4, 8, 12]),
            'support': sup,
        }
    ym = data['workday'][:7]
    return {'ym': ym, 'master': master, 'inputs': inputs,
            'holiday': [{'ym': ym, 'red_days': rng.randint(8, 11), 'dates': '', 'store': ''}],
            'stores': [{'code': '', 'name': '本店', 'active': 'TRUE', 'sort': 1}],
            'config': {'base_hours': '174', 'ot_rate_1': '1.34', 'ot_rate_2': '1.67',
                       'yearend_months': '1', 'attend_bonus': '2000', 'meal_allow': '2400'}}


def payroll_expect(pay):
    """獨立驗算——與假後端同一個簡化公式，但這裡自己寫一次（不 import 它）。

    ⚠ 驗的是「輸入→後端→畫面」這條鏈，不是真實薪資規則
    （真實規則由 tests/ 的 24 個單元測試守）。
    """
    out = {}
    base_hours = float(pay['config']['base_hours'])
    for m in pay['master']:
        i = pay['inputs'][m['emp_id']]
        full = m['is_full_time'] == 'TRUE'
        hours, ot = float(i['hours']), float(i['extra_ot'])
        sup = sum(float(x['hours']) for x in (i.get('support') or []))
        gross = float(m['base']) if full else float(m['wage']) * hours
        gross += ot * float(m['ot_rate'])
        gross += float(m['skill_allow']) + float(m['night_allow']) + float(m['mgr_allow']) + float(m['meal_allow'])
        gross += sup * float(m['wage'])
        gross = round(gross)
        ded = round(float(m['labor_ins']) + float(m['health_ins']) + float(m['dormitory']))
        out[m['name']] = {
            'emp_id': m['emp_id'], 'full': full, 'hours': hours,
            'gross': gross, 'deduction': ded, 'net': gross - ded,
            'ratio': round(hours / base_hours, 4) if full and base_hours else 1,
        }
    return out
