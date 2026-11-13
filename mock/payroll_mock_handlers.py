# -*- coding: utf-8 -*-
"""薪酬模組的假後端（e2e 專用）。

為什麼要這支：mock_server.py 原本只做打卡與核定，22 個 payroll_* 動作一個都沒有，
薪酬頁一開就是空的、什麼都測不了。

⚠ 這裡的計算是**刻意簡化**的確定性公式（計時＝時薪×時數、正職＝月薪；
扣項＝勞健保），**不是真實薪資規則**。真實規則（年終、全勤、遲到扣款、假別上限、
成本分類…）由 tests/ 那 24 個單元測試守。這支的用途是讓 e2e 能驗
「輸入 → 後端 → 畫面」這條資料鏈與所有操作，不是驗算薪正確性。

例外：鎖定前檢查（h_finalize）不是簡化版——直接跑正式版 apps-script 的 handlePayrollFinalize（mock/payroll_lock_gate.js），
七道檢查與訊息和正式版一字不差（1113 紅燈 d4）。
"""
import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

LOCK_GATE_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'payroll_lock_gate.js')

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


def _results(data, ym, store=''):
    cfg = _cfg(data)
    inputs = {r['emp_id']: dict(r) for r in _pay(data, 'input') if r.get('ym') == ym}
    _xsup_merge(data, ym, (store or 'SSLGF'), inputs)   # 2026-11 起把打卡帶入併進支援時數（之前不動）
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
    inputs = {r['emp_id']: dict(r) for r in _pay(data, 'input') if r.get('ym') == ym}
    sa = _xsup_merge(data, ym, body.get('store') or 'SSLGF', inputs)
    out = {'ok': True, 'ym': ym, 'inputs': inputs}
    if sa is not None:
        sa['detail'] = {}
        out['support_auto'] = sa
    return out


def h_input_set(data, body):
    ym = str(body.get('ym', ''))
    incoming = body.get('inputs') or {}
    rows = [r for r in _pay(data, 'input') if r.get('ym') != ym]
    for emp_id, v in incoming.items():
        row = dict(v or {})
        row['ym'], row['emp_id'] = ym, emp_id
        if ym >= XSUP_FROM:   # 打卡帶入的 auto 列不落地（比照正式 handlePayrollInputSet）
            row['support'] = [x for x in (row.get('support') or []) if not (isinstance(x, dict) and x.get('auto'))]
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
    inputs = {r['emp_id']: dict(r) for r in _pay(data, 'input') if r.get('ym') == ym}
    sa = _xsup_merge(data, ym, body.get('store') or 'SSLGF', inputs)
    out = {'ok': True, 'ym': ym, 'store': body.get('store', ''), 'has_clock': True,
            'inputs': inputs,
            'run': run, 'annual': {'months': 12, 'total': 0},
            'master': _pay(data, 'master'), 'config': _cfg(data), 'config_src': {},
            'holidays': _holiday_list(data, body.get('store', '')), 'stores': _pay(data, 'store'),
            'bonuses': [b for b in _pay(data, 'bonus') if b.get('ym') == ym]}
    if sa is not None:
        out['support_auto'] = sa
    return out


def _node_bin():
    """找 node：MOCK_NODE（測試指定）→ PATH → ~/.local/node/bin/node（Mac mini 的 node 只在 login shell 的 PATH）。"""
    for c in (os.environ.get('MOCK_NODE'), shutil.which('node'), os.path.expanduser('~/.local/node/bin/node')):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _mock_today():
    return os.environ.get('MOCK_TODAY') or datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')


def _stale_list(data, ym):
    """同正式版 payLockStale_：草稿有列才比；現在算出來的人草稿沒有＝is_new；應發／扣款／實付差 0.5 以上＝money。
    mock 的簡化算薪不產生 ot_info，所以 ot_info 那半邊不比（草稿 ot_info 交給後面 comp_over／ot_form_missing 兩道照正式版擋）。"""
    runs = [r for r in _pay(data, 'run') if r.get('ym') == ym]
    if not runs:
        return []
    by_id = {str(r.get('emp_id')): r for r in runs}
    out = []
    for r in _results(data, ym):
        old = by_id.get(str(r.get('emp_id')))
        if old is None:
            out.append({'name': r.get('name'), 'is_new': True, 'new_net': r.get('net')})
            continue
        if any(abs(_num(old.get(k)) - _num(r.get(k))) >= 0.5 for k in ('gross', 'deduction', 'net')):
            out.append({'name': r.get('name'), 'old_net': _num(old.get('net')), 'new_net': _num(r.get('net')), 'money': True})
    return out


def _lock_gate(data, body, ym):
    """正式版七道鎖定前檢查；回錯誤 dict（不能鎖）或 None（可以鎖）。跑不了就回 recheck_failed（同正式版「檢查失敗就不鎖」）。"""
    leave = [{'日期': l.get('date', ''), '姓名': l.get('name', ''), '假別': l.get('type', ''), '時數': l.get('hours', '')}
             for l in data.get('leave', [])]
    pay = data.get('payroll', {})
    payload = {
        'body': {'ym': ym, 'store': body.get('store', ''), 'lock': True, 'inputs': body.get('inputs') or {}},
        'today': _mock_today(),
        'payroll': {k: v for k, v in pay.items() if isinstance(v, list)},
        'clock': {'events': data.get('events', []), 'approved': data.get('approved', []), 'requests': data.get('requests', []),
                  'leave': leave, 'roster': data.get('roster', []), 'managers': data.get('managers', [])},
        'sched_pub': pay.get('sched_pub') or data.get('sched_pub') or {},
        'stale': _stale_list(data, ym),
    }
    node = _node_bin()
    fail = {'ok': False, 'error': 'recheck_failed', 'message': '鎖定前重算比對失敗，這次沒有鎖定，請再按一次：'}
    if not node:
        return dict(fail, message=fail['message'] + '本機找不到 node，跑不了鎖定前檢查')
    try:
        p = subprocess.run([node, LOCK_GATE_JS], input=json.dumps(payload, ensure_ascii=False), capture_output=True,
                           text=True, timeout=60)
        res = json.loads(p.stdout or '{}')
    except Exception as e:  # noqa: BLE001 — 本機假後端：任何失敗都當檢查沒過
        return dict(fail, message=fail['message'] + str(e))
    if 'error' in res and 'gate' not in res:
        return dict(fail, message=fail['message'] + str(res['error']))
    return res.get('gate')


def h_finalize(data, body):
    ym = str(body.get('ym', ''))
    lock = bool(body.get('lock'))
    if not lock and not body.get('reason'):   # 同正式版：解鎖要寫原因
        return {'ok': False, 'error': 'reason_required', 'message': '解鎖必須填原因'}
    if lock:   # 鎖定前檢查照正式版（1113 紅燈 d4）；解鎖不擋
        g = _lock_gate(data, body, ym)
        if g:
            return g
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


def _double_plan(days, extra_comp=()):
    """照抄正式 payHolidayDoublePlan：節日在平日＝當天；在週末且有補假＝改算補假日（前後 7 天內最近、未被配走）。"""
    import re as _re
    from datetime import date
    dn = lambda s: date(*map(int, s.split('-'))).toordinal()
    weekend = lambda s: date(*map(int, s.split('-'))).weekday() >= 5
    comp = [d['date'] for d in days if _re.search('補假', d.get('note') or '')]
    pool, used, moved, dates = comp + list(extra_comp), set(), {}, list(comp)
    for h in sorted((d for d in days if d.get('note') and not _re.search('補假|調整放假', d['note'])), key=lambda d: d['date']):
        if not weekend(h['date']):
            dates.append(h['date']); continue
        best = None
        for c in pool:
            if c in used:
                continue
            g = abs(dn(c) - dn(h['date']))
            if g <= 7 and (best is None or g < best[1]):
                best = (c, g)
        if best:
            used.add(best[0]); moved[h['date']] = best[0]
        else:
            dates.append(h['date'])
    return sorted(set(dates)), moved


def h_holiday_sync(data, body):
    """照抄正式 payHolidaySync（規則說明見 Payroll.gs）：本月與未來跟著行事曆、過去已存在的月份不動、
    節日逢週末改算補假日、2026-08 前不寫日期、只動集團共用列。"""
    import re as _re
    from datetime import datetime, timedelta, timezone
    SYNC_FROM, DOUBLE_FROM = '2026-05', '2026-08'
    now_ym = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime('%Y-%m')
    years = body.get('years') if isinstance(body.get('years'), list) else [body.get('year')]
    status, names, want, moved_all = [], {}, {}, {}
    for y in dict.fromkeys(int(x) for x in years if str(x).isdigit()):
        cal = h_gov_holidays(data, {'year': y})
        if not cal.get('ok'):
            status.append({'year': y, 'ok': False, 'error': cal.get('error'), 'message': cal.get('message')})
            continue
        status.append({'year': y, 'ok': True, 'title': cal['title']})
        for d in cal['days']:
            if d['note']:
                names[d['date']] = d['note']
        extra = []
        if any(d['note'] and not _re.search('補假|調整放假', d['note']) and d['date'][5:] <= '01-07' for d in cal['days']):
            prev = h_gov_holidays(data, {'year': y - 1})
            if prev.get('ok'):
                extra = [d['date'] for d in prev['days'] if '補假' in (d['note'] or '') and d['date'][5:] >= '12-25']
        dates, moved = _double_plan(cal['days'], extra)
        moved_all.update(moved)
        by = {f'{y}-{m:02d}': {'red_days': 0, 'dates': [], 'note': '依人事行政總處' + cal['title']} for m in range(1, 13)}
        for d in cal['days']:
            if d['date'][:7] in by:
                by[d['date'][:7]]['red_days'] += 1
        for d in dates:
            if d[:7] in by and d[:7] >= DOUBLE_FROM:
                by[d[:7]]['dates'].append(d)
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
    return {'ok': True, 'changed': changed, 'status': status, 'names': names, 'moved': moved_all,
            'sync_from': SYNC_FROM, 'double_from': DOUBLE_FROM,
            'holidays': _holiday_list(data, body.get('store', ''))}

def h_dzy_staff(data, body):
    """管理系統同仁名單（正式由平台後端 payrollStaffRoster 回，嵌入時管理系統改道；這裡只給本機 mock 用）。
    由主檔在職的人推出一份假名單，刻意做出四種差異讓畫面每一類都看得到：
    第 1 位已停用、第 2 位姓名不同、第 3 位對不到編號、另加兩位假新人（一位沒有打卡編號，帶入鈕會鎖住）。"""
    store = str(body.get('store') or 'SSLGF').upper()
    act = [m for m in _pay(data, 'master') if str(m.get('active')).lower() == 'true']
    staff, ids = [], {}
    for i, m in enumerate(act):
        eid = str(m.get('emp_id') or '').strip()
        name = str(m.get('name') or '')
        state = 'disabled' if i == 0 else 'active'
        if i == 1:
            name = name + '二'
        if i == 2 or not eid:
            continue
        ids[eid] = {'emp_no': 'DZY9%02d' % i, 'name': name, 'state': state, 'unit_name': '測試門市',
                    'pay_store': store, 'store_code': 'gf', 'here': True}
        staff.append({'emp_no': 'DZY9%02d' % i, 'name': name, 'state': state, 'last_day': '', 'hire_date': '',
                      'unit': 'test', 'unit_name': '測試門市', 'title': 'pt', 'title_name': '計時', 'emp_id': eid})
    have = {str(m.get('emp_id') or '').strip() for m in _pay(data, 'master')}
    for j, (nm, eid, title) in enumerate([('測試新人甲', 'T901', 'ft'), ('測試新人乙', '', 'pt')]):
        staff.append({'emp_no': 'DZY99%d' % j, 'name': nm, 'state': 'active', 'last_day': '', 'hire_date': '2026-10-20',
                      'unit': 'test', 'unit_name': '測試門市', 'title': title, 'title_name': '正職' if title == 'ft' else '計時', 'emp_id': eid})
        if eid:
            ids[eid] = {'emp_no': 'DZY99%d' % j, 'name': nm, 'state': 'active', 'unit_name': '測試門市',
                        'pay_store': store, 'store_code': 'gf', 'here': True}
    return {'ok': True, 'store': store, 'clock_store': 'gf', 'clock_store_name': '測試門市', 'staff': staff, 'ids': ids, 'unit_none': ['yiwu-hq']}


# ── 跨店支援自動帶入（2026-11-05；正式規則在 Payroll.gs paySupportAutoCore_／payMergeSupport_）──
# 這裡是**刻意簡化**的假版本：別家門市的「主管核定」用固定假日子產生（每月 3／10／17 號），
# 只為了讓畫面看得到 auto 列、逐日明細、差異兩顆鈕、各種提醒。真正的規則由 tests/support-auto.test.js 守。
XSUP_FROM = '2026-11'
MOCK_XSUP_STORES = {
    'SSLGF': ('麻的小辛辣 新竹光復店', 'sxl'), 'CF': ('中央廚房', '*'), 'HQ': ('鼎兆元總部', '*'),
    'MZTJS': ('墨竹亭 金山店', 'mzt'), 'MZTGF': ('墨竹亭 光復店', 'mzt'),
}
MOCK_ALIAS = {'小辛辣光復': 'SSLGF', '墨竹亭金山': 'MZTJS', '墨金': 'MZTJS', '墨竹亭光復': 'MZTGF', '墨復': 'MZTGF',
              '墨竹亭六張犁': 'MZTLZL', '央廚': 'CF'}
MOCK_DAYS = [(3, 8, '10:00-18:00'), (10, 6.5, '11:00-17:30'), (17, 4, '14:00-18:00')]


def _xsup_stores(data):
    out = {k: {'code': k, 'name': v[0], 'support_group': v[1]} for k, v in MOCK_XSUP_STORES.items()}
    for s in _pay(data, 'store'):
        c = str(s.get('code') or '').strip().upper()
        if c:
            out[c] = dict(out.get(c, {}), **s)
    return out


def _same_group(a, b):
    a, b = str(a or '').strip(), str(b or '').strip()
    return a == '*' or b == '*' or (bool(a) and a == b)


def _sup_code(row, stores):
    c = str(row.get('code') or '').strip().upper()
    if c and c in stores:
        return c
    raw = ''.join(str(row.get('store') or '').split())
    if not raw:
        return ''
    if raw in MOCK_ALIAS:
        return MOCK_ALIAS[raw]
    if raw.upper() in stores:
        return raw.upper()
    for k, v in stores.items():
        if ''.join(str(v.get('name') or '').split()) == raw:
            return k
    return ''


def _xsup(data, ym, home):
    """回 (byEmp, support_auto 骨架)。byEmp[emp] = [{code,name,hours,days}]"""
    stores = _xsup_stores(data)
    home = str(home or 'SSLGF').upper()
    hg = (stores.get(home) or {}).get('support_group', '')
    xmap = _pay(data, 'xmap')
    sa = {'synced_at': max([str(r.get('synced_at') or '') for r in xmap] or ['']), 'empty': not xmap, 'diffs': [],
          'pending_days': [], 'unmapped': [], 'detail': {},
          'warn': {'manual_unresolved': [], 'cross_manual': [], 'dup_pay': [], 'cross_no_master': []}}
    groups = {}
    for r in xmap:
        if str(r.get('pay_store')).upper() != home:
            continue
        if r.get('state') == 'suggested':
            sa['unmapped'].append({'emp_no': r.get('emp_no'), 'acct_store': r.get('acct_store'), 'emp_id': r.get('emp_id')})
            continue
        groups.setdefault(r.get('emp_no'), []).append(r)
    master_ids = {str(m.get('emp_id')) for m in _pay(data, 'master')}
    by = {}
    for no, accts in groups.items():
        mine = next((a for a in accts if str(a.get('acct_store')).upper() == home and str(a.get('emp_id')) in master_ids), None)
        if not mine:
            continue
        emp = str(mine.get('emp_id'))
        for a in accts:
            S = str(a.get('acct_store')).upper()
            if S == home or str(a.get('not_support')).lower() == 'true':
                continue
            days = [{'date': '%s-%02d' % (ym, d), 'periods': p, 'hours': h, 'manager_name': '值班主管'} for d, h, p in MOCK_DAYS]
            row = {'code': S, 'name': (stores.get(S) or {}).get('name', S), 'hours': round(sum(x['hours'] for x in days), 2), 'days': days}
            sa['detail'].setdefault(emp, {})[S] = {'name': row['name'], 'hours': row['hours'], 'days': days}
            if _same_group(hg, (stores.get(S) or {}).get('support_group')):
                by.setdefault(emp, []).append(row)
        if emp in by:
            sa['pending_days'].append({'emp_id': emp, 'code': by[emp][0]['code'], 'days': 1})
    return by, sa, stores


def _xsup_merge(data, ym, home, inputs):
    """就地把 auto 列合進 inputs（只在 2026-11 以後），回 support_auto；之前回 None。"""
    if str(ym) < XSUP_FROM:
        return None
    by, sa, stores = _xsup(data, ym, home)
    home = str(home or 'SSLGF').upper()
    hg = (stores.get(home) or {}).get('support_group', '')
    mby = {str(m.get('emp_id')): m for m in _pay(data, 'master')}
    for emp in set(list(inputs.keys()) + [e for e in by if e in mby]):
        A = inputs.setdefault(emp, {'emp_id': emp, 'ym': ym, 'support': []})
        manual = [x for x in (A.get('support') or []) if not x.get('auto')]
        codes = [_sup_code(x, stores) if (x.get('store') or x.get('code') or _num(x.get('hours'))) else '' for x in manual]
        for c in codes:
            g = (stores.get(c) or {}).get('support_group', '')
            if c and c != home and hg and g and not _same_group(hg, g):
                sa['warn']['cross_manual'].append({'emp_id': emp, 'code': c})
        if any(c == '' and (x.get('store') or _num(x.get('hours'))) for c, x in zip(codes, manual)):
            sa['warn']['manual_unresolved'].append(emp)
            A['support'] = manual
            continue
        m = mby.get(emp) or {}
        full = str(m.get('is_full_time', '')).lower() in ('true', '1')
        rate = _num(m.get('ot_rate')) if full else _num(m.get('wage'))
        out = list(manual)
        for a in by.get(emp, []):
            idx = [i for i, c in enumerate(codes) if c == a['code']]
            if not idx:
                out.append({'code': a['code'], 'store': a['name'], 'hours': a['hours'], 'rate': rate, 'amount': '', 'auto': True})
                continue
            mh = round(sum(_num(manual[i].get('hours')) for i in idx), 2)
            if mh == a['hours']:
                continue
            if all(manual[i].get('keep') and _num(manual[i].get('auto_h')) == a['hours'] for i in idx):
                continue
            sa['diffs'].append({'emp_id': emp, 'code': a['code'], 'name': a['name'], 'manual': mh, 'auto': a['hours']})
        A['support'] = out
    return sa


def h_dzy_xmap(data, body):
    """管理系統「同仁名單 → 打卡對照」（正式由平台 payrollXmap 回、bridge 改道；這裡用假資料）。
    第 1 位：央廚帳號（同組 → 打卡帶入）；第 2 位：央廚帳號（配合手填做差異）；第 3 位：金山帳號（跨品牌，不帶入）；
    第 4 位：央廚帳號只有 suggested（對照未確認）。"""
    store = str(body.get('store') or 'SSLGF').upper()
    act = [m for m in _pay(data, 'master') if str(m.get('active')).lower() == 'true']
    rows = []
    plan = [('CF', 'confirmed'), ('CF', 'confirmed'), ('MZTJS', 'confirmed'), ('CF', 'suggested')]
    for i, m in enumerate(act[:4]):
        eid, no = str(m.get('emp_id')), 'DZY8%02d' % i
        rows.append({'emp_no': no, 'pay_store': store, 'acct_store': store, 'emp_id': eid, 'state': 'confirmed', 'not_support': False})
        acct, state = plan[i]
        rows.append({'emp_no': no, 'pay_store': store, 'acct_store': acct, 'emp_id': '%s9%02d' % (acct, i), 'state': state, 'not_support': False})
    return {'ok': True, 'rows': rows, 'generated_at': '2026-11-05T09:00:00+08:00'}


def h_xmap_set(data, body):
    if not isinstance(body.get('rows'), list):
        return {'ok': False, 'error': 'rows_required'}
    stores = _xsup_stores(data)
    synced = str(body.get('synced_at') or '')
    clean, dropped = [], 0
    for r in body['rows']:
        ps, as_ = str(r.get('pay_store') or '').strip().upper(), str(r.get('acct_store') or '').strip().upper()
        if ps not in stores or as_ not in stores or not str(r.get('emp_id') or '').strip():
            dropped += 1
            continue
        clean.append({'emp_no': str(r.get('emp_no')), 'pay_store': ps, 'acct_store': as_, 'emp_id': str(r.get('emp_id')).strip(),
                      'not_support': 'true' if r.get('not_support') in (True, 'true') else 'false',
                      'synced_at': synced, 'state': str(r.get('state') or 'confirmed')})
    data.setdefault('payroll', {})['xmap'] = clean
    return {'ok': True, 'count': len(clean), 'dropped': dropped, 'synced_at': synced}


def h_audit_get(data, body):
    """操作紀錄（假資料一筆，讓分頁的篩選與匯出有東西可驗）。"""
    ym = str(body.get('ym') or '2026-11')
    return {'ok': True, 'items': [{'ts': ym + '-05T09:00:00+08:00', 'ym': ym, 'store': 'SSLGF', 'action': 'lock',
                                   'operator': '測試主管', 'reason': 'e2e', 'detail': ''}]}


def h_xmap_get(data, body):
    rows = _pay(data, 'xmap')
    return {'ok': True, 'rows': rows, 'synced_at': max([str(r.get('synced_at') or '') for r in rows] or [''])}


def h_support_decide(data, body):
    ym, emp, code, choice = str(body.get('ym', '')), str(body.get('emp_id', '')), str(body.get('code', '')).upper(), body.get('choice')
    if ym < XSUP_FROM:
        return {'ok': False, 'error': 'xsup_off', 'message': XSUP_FROM + ' 以前的月份沒有打卡帶入'}
    if choice not in ('auto', 'keep'):
        return {'ok': False, 'error': 'bad_choice'}
    stores = _xsup_stores(data)
    row = next((r for r in _pay(data, 'input') if r.get('ym') == ym and str(r.get('emp_id')) == emp), None)
    if not row:
        return {'ok': True, 'result': 'no_row'}
    sup = [x for x in (row.get('support') or []) if not x.get('auto')]
    hit = lambda x: _sup_code(x, stores) == code
    if choice == 'auto':
        sup = [x for x in sup if not hit(x)]
    else:
        sup = [dict(x, code=code, keep=True, auto_h=_num(body.get('auto_h'))) if hit(x) else x for x in sup]
    row['support'] = sup
    return {'ok': True, 'result': 'ok', 'choice': choice}


PAYROLL_ACTIONS = {
    'payroll_dzy_staff': h_dzy_staff,
    'payroll_dzy_xmap': h_dzy_xmap,
    'payroll_xmap_set': h_xmap_set,
    'payroll_xmap_get': h_xmap_get,
    'payroll_audit_get': h_audit_get,
    'payroll_support_decide': h_support_decide,
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
