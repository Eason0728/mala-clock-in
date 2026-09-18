# -*- coding: utf-8 -*-
"""薪酬模組的假後端（e2e 專用）。

為什麼要這支：mock_server.py 原本只做打卡與核定，22 個 payroll_* 動作一個都沒有，
薪酬頁一開就是空的、什麼都測不了。

⚠ 這裡的計算是**刻意簡化**的確定性公式（計時＝時薪×時數、正職＝月薪；
扣項＝勞健保），**不是真實薪資規則**。真實規則（年終、全勤、遲到扣款、假別上限、
成本分類…）由 tests/ 那 24 個單元測試守。這支的用途是讓 e2e 能驗
「輸入 → 後端 → 畫面」這條資料鏈與所有操作，不是驗算薪正確性。
"""

DEFAULT_CONFIG = {
    'base_hours': '174', 'ot_rate_1': '1.34', 'ot_rate_2': '1.67',
    'yearend_months': '1', 'attend_bonus': '2000', 'meal_allow': '2400',
}


def _pay(data, key, default=None):
    return data.setdefault('payroll', {}).setdefault(key, default if default is not None else [])


def _cfg(data):
    c = data.setdefault('payroll', {}).setdefault('config', {})
    for k, v in DEFAULT_CONFIG.items():
        c.setdefault(k, v)
    return c


def _num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def calc_one(m, inp, cfg):
    """簡化但確定的計算——e2e 端會用同一個公式獨立驗算。

    回傳形狀必須與後端 payCalcOne 一致（前端只認這一種）：
    earn／ded 是明細陣列，gross／deduction 由明細加總而來。
    """
    full = str(m.get('is_full_time', '')).lower() in ('true', '1', 'y', 'yes')
    hours = _num(inp.get('hours'))
    extra_ot = _num(inp.get('extra_ot'))
    sup_rows = inp.get('support') or []
    if isinstance(sup_rows, (int, float, str)):      # 容錯：舊格式的單一數字
        support = _num(sup_rows)
        sup_rows = []
    else:
        support = sum(_num(x.get('hours')) for x in sup_rows)
    base_hours = _num(cfg.get('base_hours'), 174)
    wage = _num(m.get('wage'))

    earn = []
    if full:
        earn.append({'item_key': 'base', 'item_label': '本薪', 'qty': None,
                     'rate': None, 'amount': _num(m.get('base'))})
    else:
        earn.append({'item_key': 'wage', 'item_label': '時薪工資', 'qty': hours,
                     'rate': wage, 'amount': round(wage * hours)})
    if extra_ot:
        rate = _num(m.get('ot_rate'), wage * 1.34)
        earn.append({'item_key': 'ot', 'item_label': '加班費', 'qty': extra_ot,
                     'rate': rate, 'amount': round(extra_ot * rate)})
    if support:
        earn.append({'item_key': 'support', 'item_label': '跨店支援', 'qty': support,
                     'rate': wage, 'amount': round(support * wage)})
    for key, label in (('skill_allow', '技術加給'), ('night_allow', '夜班津貼'),
                       ('mgr_allow', '主管加給'), ('meal_allow', '伙食津貼')):
        amt = _num(m.get(key))
        if amt:
            earn.append({'item_key': key, 'item_label': label, 'qty': None,
                         'rate': None, 'amount': amt})

    ded = []
    for key, label in (('labor_ins', '勞保費'), ('health_ins', '健保費'), ('dormitory', '宿舍費')):
        amt = _num(m.get(key))
        if amt:
            ded.append({'item_key': key, 'item_label': label, 'qty': None,
                        'rate': None, 'amount': amt})

    gross = round(sum(x['amount'] for x in earn))
    deduct = round(sum(x['amount'] for x in ded))
    return {
        'emp_id': m.get('emp_id'), 'name': m.get('name'),
        'is_full_time': 'TRUE' if full else 'FALSE',
        'ratio': round(hours / base_hours, 4) if (full and base_hours) else 1,
        'total_hours': hours, 'base_hours': base_hours,
        'surplus_hours': max(0, hours - base_hours) if full else 0,
        'ot_paid_hours': extra_ot, 'support_hours': support,
        'earn': earn, 'ded': ded,
        'gross': gross, 'deduction': deduct, 'net': gross - deduct,
        'leave_rate': 1, 'pt_attend': None,
        'status': 'draft', 'store': m.get('store', ''),
    }


def _results(data, ym):
    cfg = _cfg(data)
    inputs = {r['emp_id']: r for r in _pay(data, 'input') if r.get('ym') == ym}
    out = []
    for m in _pay(data, 'master'):
        if str(m.get('active', 'TRUE')).lower() == 'false':
            continue
        r = calc_one(m, inputs.get(m.get('emp_id'), {}), cfg)
        r['ym'] = ym
        out.append(r)
    return out


def _locked(data, ym):
    return any(r.get('ym') == ym and r.get('status') == 'final' for r in _pay(data, 'run'))


# ── 各動作 ───────────────────────────────────────────────
def h_master_get(data, body):
    return {'ok': True, 'store': body.get('store', ''),
            'master': _pay(data, 'master'), 'config': _cfg(data),
            'config_src': {}, 'stores': _pay(data, 'store'),
            'holidays': _holiday_list(data, body.get('store', ''))}


def h_master_set(data, body):
    data.setdefault('payroll', {})['master'] = body.get('master') or []
    return {'ok': True, 'saved': len(body.get('master') or [])}


def h_config_set(data, body):
    _cfg(data).update(body.get('config') or {})
    return {'ok': True, 'config': _cfg(data)}


def _holiday_list(data, store):
    """照抄正式 payHolidayList：每月一筆、該店專屬（own）優先於集團共用（global），附 _src。"""
    st, by = str(store or ''), {}
    for h in _pay(data, 'holiday'):
        ym, rs = str(h.get('ym')), str(h.get('store') or '')
        if rs == '':
            if ym not in by or by[ym].get('_src') != 'own':
                by[ym] = dict(h, _src='global')
        elif st and rs == st:
            by[ym] = dict(h, _src='own')
    return [by[k] for k in sorted(by)]


def h_holiday_set(data, body):
    """照抄正式 handlePayrollHolidaySet：收整批陣列，只換 body.store 那一層（空白＝集團共用）。
    ⚠ 2026-09-18 前這裡收的是單筆 {ym, red_days}，跟正式合約不同——前端送陣列進來會寫出 ym 空白的壞列。"""
    if not isinstance(body.get('holidays'), list):
        return {'ok': False, 'error': 'holidays_required'}
    st = str(body.get('store') or '')
    mine = [{'ym': str(h.get('ym', '')), 'red_days': h.get('red_days'), 'note': h.get('note', ''),
             'dates': h.get('dates', ''), 'store': st} for h in body['holidays']]
    others = [h for h in _pay(data, 'holiday') if str(h.get('store') or '') != st]
    data['payroll']['holiday'] = others + mine
    return {'ok': True, 'count': len(mine), 'store': st}


def h_inputs(data, body):
    ym = str(body.get('ym', ''))
    return {'ok': True, 'ym': ym,
            'inputs': {r['emp_id']: r for r in _pay(data, 'input') if r.get('ym') == ym}}


def h_input_set(data, body):
    ym = str(body.get('ym', ''))
    incoming = body.get('inputs') or {}
    rows = [r for r in _pay(data, 'input') if r.get('ym') != ym]
    for emp_id, v in incoming.items():
        row = dict(v or {})
        row['ym'], row['emp_id'] = ym, emp_id
        rows.append(row)
    data['payroll']['input'] = rows
    return {'ok': True, 'saved': len(incoming)}


def h_calc(data, body):
    ym = str(body.get('ym', ''))
    if not _pay(data, 'holiday'):
        return {'ok': False, 'error': 'no_holiday', 'message': ym + ' 尚未設定紅字天數'}
    if _locked(data, ym):
        return {'ok': False, 'error': 'locked', 'message': ym + ' 已鎖定'}
    over = body.get('inputs') or {}
    if over:
        h_input_set(data, {'ym': ym, 'inputs': over})
    return {'ok': True, 'ym': ym, 'results': _results(data, ym),
            'config': _cfg(data), 'status': 'draft'}


def h_get(data, body):
    ym = str(body.get('ym', ''))
    saved = [r for r in _pay(data, 'run') if r.get('ym') == ym]
    return {'ok': True, 'ym': ym, 'config': _cfg(data),
            'results': saved, 'status': 'final' if _locked(data, ym) else ('draft' if saved else '')}


def h_month(data, body):
    ym = str(body.get('ym', ''))
    saved = [r for r in _pay(data, 'run') if r.get('ym') == ym]
    run = {'results': saved, 'status': 'final' if _locked(data, ym) else 'draft'} if saved else None
    if run is None and _pay(data, 'holiday'):
        run = {'results': _results(data, ym), 'status': 'draft'}
    return {'ok': True, 'ym': ym, 'store': body.get('store', ''), 'has_clock': True,
            'inputs': {r['emp_id']: r for r in _pay(data, 'input') if r.get('ym') == ym},
            'run': run, 'annual': {'months': 12, 'total': 0},
            'master': _pay(data, 'master'), 'config': _cfg(data), 'config_src': {},
            'holidays': _holiday_list(data, body.get('store', '')), 'stores': _pay(data, 'store'),
            'bonuses': [b for b in _pay(data, 'bonus') if b.get('ym') == ym]}


def h_finalize(data, body):
    ym = str(body.get('ym', ''))
    lock = bool(body.get('lock'))
    rows = [r for r in _pay(data, 'run') if r.get('ym') != ym]
    for r in _results(data, ym):
        r['status'] = 'final' if lock else 'draft'
        rows.append(r)
    data['payroll']['run'] = rows
    _pay(data, 'audit').append({'ym': ym, 'action': 'lock' if lock else 'unlock',
                                'operator': body.get('operator', ''), 'reason': body.get('reason', '')})
    return {'ok': True, 'ym': ym, 'status': 'final' if lock else 'draft'}


def h_punch(data, body):
    """某人的當月打卡明細——直接從打卡系統那邊的 approved/events 拼出來。"""
    ym, emp = str(body.get('ym', '')), str(body.get('emp_id', ''))
    days = []
    for a in data.get('approved', []):
        if str(a.get('date', '')).startswith(ym):
            days.append({'date': a.get('date'), 'hours': a.get('approved_hours'),
                         'status': a.get('status_text', '')})
    return {'ok': True, 'ym': ym, 'emp_id': emp, 'days': days,
            'total': round(sum(_num(d['hours']) for d in days), 2)}


def h_store_get(data, body):
    return {'ok': True, 'stores': _pay(data, 'store')}


def h_store_set(data, body):
    data.setdefault('payroll', {})['store'] = body.get('stores') or []
    return {'ok': True, 'saved': len(body.get('stores') or [])}


def h_bonus_get(data, body):
    ym = str(body.get('ym', ''))
    return {'ok': True, 'bonuses': [b for b in _pay(data, 'bonus') if b.get('ym') == ym]}


def h_bonus_set(data, body):
    ym = str(body.get('ym', ''))
    rows = [b for b in _pay(data, 'bonus') if b.get('ym') != ym]
    for b in body.get('bonuses') or []:
        b = dict(b)
        b['ym'] = ym
        rows.append(b)
    data['payroll']['bonus'] = rows
    return {'ok': True, 'saved': len(body.get('bonuses') or [])}


def h_trend(data, body):
    ym = str(body.get('ym', ''))
    y, m = int(ym[:4]), int(ym[5:7])
    months = []
    for i in range(int(body.get('months') or 12)):
        mm = m - i
        yy = y
        while mm <= 0:
            mm += 12
            yy -= 1
            
        months.append({'ym': f'{yy}-{mm:02d}', 'gross': 0, 'net': 0, 'headcount': 0})
    cur = _results(data, ym)
    if months:
        months[0].update({'gross': sum(r['gross'] for r in cur),
                          'net': sum(r['net'] for r in cur), 'headcount': len(cur)})
    return {'ok': True, 'months': list(reversed(months))}


def h_group(data, body):
    ym = str(body.get('ym', ''))
    res = _results(data, ym)
    return {'ok': True, 'ym': ym, 'rows': [{
        'store': s.get('code', ''), 'name': s.get('name', ''),
        'headcount': len(res), 'gross': sum(r['gross'] for r in res),
        'net': sum(r['net'] for r in res)} for s in (_pay(data, 'store') or [{'code': '', 'name': '本店'}])]}


def h_bootstrap(data, body):
    """從打卡名冊補進薪資主檔（只補沒有的，不覆蓋既有）。"""
    have = {m.get('emp_id') for m in _pay(data, 'master')}
    added = []
    for r in data.get('roster', []):
        if str(r.get('active', True)).lower() == 'false' or r.get('emp_id') in have:
            continue
        _pay(data, 'master').append({
            'emp_id': r.get('emp_id'), 'name': r.get('name'), 'is_full_time': 'FALSE',
            'wage': 0, 'base': 0, 'ot_rate': 0, 'active': 'TRUE', 'store': '',
        })
        added.append(r.get('name'))
    return {'ok': True, 'added': added, 'master': _pay(data, 'master')}


def h_leave_type_get(data, body):
    return {'ok': True, 'types': _pay(data, 'leave_type'), 'src': {}}


def h_leave_type_set(data, body):
    data.setdefault('payroll', {})['leave_type'] = body.get('types') or []
    return {'ok': True, 'saved': len(body.get('types') or [])}


def h_leave_event_get(data, body):
    return {'ok': True, 'events': _pay(data, 'leave_span')}


def h_leave_event_set(data, body):
    data.setdefault('payroll', {})['leave_span'] = body.get('events') or []
    return {'ok': True, 'saved': len(body.get('events') or [])}


_GOV_CACHE = {}


def h_gov_holidays(data, body):
    """照抄正式 handlePayrollGovHolidays：真的去政府資料開放平臺抓人事行政總處的辦公日曆表。
    本機測試要連網；抓不到就回 fetch_failed，跟正式環境同一個錯誤碼，好測失敗畫面。"""
    import json as _json, re as _re, urllib.request as _u
    try:
        year = int(body.get('year'))
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'bad_year'}
    if not 2017 <= year <= 2100:
        return {'ok': False, 'error': 'bad_year'}
    if year in _GOV_CACHE:
        return _GOV_CACHE[year]
    roc = year - 1911
    # ⚠ data.gov.tw 會擋 Python 預設的 User-Agent（回 403），正式環境的 Apps Script UA 不會被擋
    # ⚠ Python 3.13 起預設 X509 嚴格模式，政府憑證缺 Subject Key Identifier 會被拒；只關嚴格旗標，憑證鏈照驗
    import ssl as _ssl
    ctx = _ssl.create_default_context()
    ctx.verify_flags &= ~getattr(_ssl, 'VERIFY_X509_STRICT', 0)
    get = lambda url: _u.urlopen(_u.Request(url, headers={'User-Agent': 'Mozilla/5.0 (mala-payroll mock)'}),
                                 timeout=30, context=ctx)
    try:
        meta = _json.load(get('https://data.gov.tw/api/v2/rest/dataset/14718'))
        dist = [d for d in (meta.get('result', meta).get('distribution') or [])
                if str(d.get('resourceDescription', '')).startswith(f'{roc}年')
                and '辦公日曆表' in str(d.get('resourceDescription', ''))
                and 'Google' not in str(d.get('resourceDescription', ''))
                and str(d.get('resourceFormat', '')).upper() == 'CSV']
        if not dist:
            return {'ok': False, 'error': 'not_published',
                    'message': f'人事行政總處還沒公布 {year} 年（民國 {roc} 年）的辦公日曆表'}
        up = lambda d: (_re.search(r'files/(\d{6})/', d.get('resourceDownloadUrl', '')) or [None, ''])[1]
        pick = dist[0]
        for d in dist[1:]:
            if up(d) >= up(pick):
                pick = d
        raw = get(pick['resourceDownloadUrl']).read()
        txt = raw.decode('utf-8', 'replace')
        if '西元日期' not in txt:
            txt = raw.decode('big5', 'replace')
        days = []
        for line in txt.lstrip('\ufeff').splitlines():
            c = line.split(',')
            m = _re.match(r'^(\d{4})(\d{2})(\d{2})$', c[0].strip()) if c else None
            if not m or len(c) < 3 or c[2].strip() != '2':
                continue
            days.append({'date': f'{m[1]}-{m[2]}-{m[3]}', 'week': c[1].strip(),
                         'note': c[3].strip() if len(c) > 3 else ''})
        if not days:
            return {'ok': False, 'error': 'parse_failed', 'message': '人事行政總處的檔案讀不懂（格式可能改了）'}
        out = {'ok': True, 'year': year, 'title': pick.get('resourceDescription', ''),
               'source': pick['resourceDownloadUrl'], 'days': days}
        _GOV_CACHE[year] = out
        return out
    except Exception as e:  # noqa: BLE001 — 與正式環境一致：任何連線錯誤都回 fetch_failed
        return {'ok': False, 'error': 'fetch_failed', 'message': f'連不上人事行政總處的資料：{e}'}


def h_holiday_sync(data, body):
    """照抄正式 payHolidaySync（規則說明見 Payroll.gs）：本月與未來跟著行事曆、過去已存在的月份不動、
    補假不算國定假日、2026-08 前不寫日期、只動集團共用列。"""
    import re as _re
    from datetime import datetime, timedelta, timezone
    SYNC_FROM, DOUBLE_FROM = '2026-05', '2026-08'
    now_ym = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime('%Y-%m')
    years = body.get('years') if isinstance(body.get('years'), list) else [body.get('year')]
    status, names, want = [], {}, {}
    for y in dict.fromkeys(int(x) for x in years if str(x).isdigit()):
        cal = h_gov_holidays(data, {'year': y})
        if not cal.get('ok'):
            status.append({'year': y, 'ok': False, 'error': cal.get('error'), 'message': cal.get('message')})
            continue
        status.append({'year': y, 'ok': True, 'title': cal['title']})
        by = {f'{y}-{m:02d}': {'red_days': 0, 'dates': [], 'note': '依人事行政總處' + cal['title']} for m in range(1, 13)}
        for d in cal['days']:
            if d['note']:
                names[d['date']] = d['note']
            r = by.get(d['date'][:7])
            if r is None:
                continue
            r['red_days'] += 1
            if d['note'] and not _re.search('補假|調整放假', d['note']) and d['date'][:7] >= DOUBLE_FROM:
                r['dates'].append(d['date'])
        for k, r in by.items():
            if k >= SYNC_FROM:
                want[k] = dict(r, dates=', '.join(sorted(r['dates'])))
    rows, changed, out = _pay(data, 'holiday'), [], []
    for r in rows:
        k = str(r.get('ym'))
        if str(r.get('store') or '') != '' or k not in want:
            out.append(r); continue
        w = want.pop(k)
        if k < now_ym or (_num(r.get('red_days')) == w['red_days'] and str(r.get('dates') or '') == w['dates']):
            out.append(r); continue
        out.append({'ym': k, 'red_days': w['red_days'], 'note': w['note'], 'dates': w['dates'], 'store': ''})
        changed.append(k)
    for k in sorted(want):
        w = want[k]
        out.append({'ym': k, 'red_days': w['red_days'], 'note': w['note'], 'dates': w['dates'], 'store': ''})
        changed.append(k)
    data['payroll']['holiday'] = out
    return {'ok': True, 'changed': changed, 'status': status, 'names': names,
            'sync_from': SYNC_FROM, 'double_from': DOUBLE_FROM,
            'holidays': _holiday_list(data, body.get('store', ''))}

PAYROLL_ACTIONS = {
    'payroll_bootstrap': h_bootstrap,
    'payroll_master_get': h_master_get,
    'payroll_master_set': h_master_set,
    'payroll_config_set': h_config_set,
    'payroll_holiday_set': h_holiday_set,
    'payroll_gov_holidays': h_gov_holidays,
    'payroll_holiday_sync': h_holiday_sync,
    'payroll_inputs': h_inputs,
    'payroll_input_set': h_input_set,
    'payroll_calc': h_calc,
    'payroll_get': h_get,
    'payroll_month': h_month,
    'payroll_finalize': h_finalize,
    'payroll_punch': h_punch,
    'payroll_store_get': h_store_get,
    'payroll_store_set': h_store_set,
    'payroll_bonus_get': h_bonus_get,
    'payroll_bonus_set': h_bonus_set,
    'payroll_trend': h_trend,
    'payroll_group': h_group,
    'payroll_leave_type_get': h_leave_type_get,
    'payroll_leave_type_set': h_leave_type_set,
    'payroll_leave_event_get': h_leave_event_get,
    'payroll_leave_event_set': h_leave_event_set,
}
