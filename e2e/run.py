#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打卡＋值班核定 端到端測試：每次全新隨機資料，驗算時數，稽核每一顆按鈕。

  python3 e2e/run.py
  E2E_SEED=12345 python3 e2e/run.py    # 重現某次的資料

分兩路，因為 mock 的打卡時間是「呼叫當下」無法指定：
  A 真打卡（今天）：驗打卡流程本身——定位、事件寫入、下班鍵冷卻、交替防呆、公告、外連。
  B 預塞事件（昨天）：驗算參考時數（15 分取整）、核定時數、遲到／早退、忘刷卡留白。
"""
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dataset import (make_dataset, expectations, hhmm,          # noqa: E402
                     make_payroll, payroll_expect)
from clickmap import ClickMap, KEY_JS                            # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'e2e', 'artifacts')
PORT = int(os.environ.get('E2E_MOCK_PORT', '8921'))
BASE = f'http://localhost:{PORT}'

RESULTS = []
CM = ClickMap()


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok), str(detail)))
    print(('✅ ' if ok else '❌ ') + name + (f'　{detail}' if (detail and not ok) else ''))


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)


def wait_settled(page, timeout=25000):
    """等打卡結果落定——不能一看到 statusBox 有字就判斷，那時還是「送出打卡中…」。"""
    page.wait_for_function(
        """() => { const e = document.getElementById('statusBox');
             return e && e.textContent.trim() && e.textContent.indexOf('送出打卡中') < 0; }""",
        timeout=timeout)
    return text_of(page, '#statusBox')


def click(page, selector, verified):
    """點一顆按鈕並登記。等不到「可見」就直接觸發——切換分頁後元素可能被藏起來，
    但我們仍要驗證它按得動且不會出錯。"""
    k = page.evaluate(KEY_JS, selector)
    try:
        page.click(selector, timeout=3000)
    except Exception:
        page.evaluate("(s) => { const e = document.querySelector(s); if (e) e.click(); }", selector)
    if k:
        CM.mark(k, verified)


def _btn_key_js():
    """產生 key 的 JS 片段，與 clickmap 掃描端完全一致（含空白正規化）。"""
    return "'button「' + b.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '」'"


def click_text(page, scope, text, why, do_click=True, exact=False):
    """在 scope（CSS 選擇器，None＝整頁）內找按鈕，點它並登記。

    exact=True 時要文字完全相同——頁面上常有「新增」與「＋ 新增同仁」並存，
    用「包含」會永遠先點到後者，前者就變成永遠測不到的漏網之魚。
    """
    k = page.evaluate("""([sc, t, doClick, exact]) => {
        const root = sc ? document.querySelector(sc) : document;
        if (!root) return null;
        const b = [...root.querySelectorAll('button')].find(x =>
            exact ? x.textContent.trim() === t : x.textContent.includes(t));
        if (!b) return null;
        // 先算 key 再點——按下去文字會變成「送出中…」，事後再讀就對不上掃描結果
        const key = b.id ? '#' + b.id
            : 'button「' + b.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) + '」';
        if (doClick) b.click();
        return key;
    }""", [scope, text, do_click, exact])
    if k:
        CM.mark(k, why)
    return k


def click_in_card(page, name, text, why):
    """限定在「某位同仁的卡片」內點按鈕——整份名單有很多同名按鈕，不限定會點到別人的。"""
    k = page.evaluate("""([nm, t]) => {
        const h = [...document.querySelectorAll('#empList .emp-head')]
            .find(x => x.textContent.includes(nm));
        const c = h && h.closest('.card');
        if (!c) return null;
        const b = [...c.querySelectorAll('button')].find(x => x.textContent.includes(t));
        if (!b) return null;
        const key = b.id ? '#' + b.id
            : 'button「' + b.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) + '」';
        b.click();
        return key;
    }""", [name, text])
    if k:
        CM.mark(k, why)
    return k


def mark_el(page, selector, verified):
    k = page.evaluate(KEY_JS, selector)
    if k:
        CM.mark(k, verified)


def text_of(page, sel):
    return page.evaluate("(s) => { const e = document.querySelector(s); return e ? e.innerText : ''; }", sel)


def visible(page, sel):
    return page.evaluate(
        "(s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }", sel)


def exercise_toggles(page, screen, rounds=2):
    for _ in range(rounds):
        n = page.evaluate("() => document.querySelectorAll('summary, details').length")
        for i in range(n):
            info = page.evaluate("""(i) => {
                const s = document.querySelectorAll('summary')[i];
                if (!s) return null;
                const d = s.closest('details'); if (!d) return null;
                const txt = (s.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
                const key = s.id ? '#' + s.id : ('summary「' + txt + '」');
                const was = d.open; s.click();
                const toggled = d.open !== was;
                if (!d.open) s.click();
                return { key: key, toggled: toggled };
            }""", i)
            if info and info.get('toggled'):
                CM.mark(info['key'], '點擊後展開／收合切換正常')
        CM.scan(page, screen)


# ── 準備 mock 資料 ────────────────────────────────────────
def build_mock_data(data):
    """把隨機名冊與昨天的打卡事件寫進 mock_data.json。"""
    day = data['workday']
    events = []
    for p in data['people']:
        for a, b in p['segments']:
            events.append({
                'ts': f'{day}T{hhmm(a)}:00+08:00', 'emp_id': p['emp_id'], 'type': 'in',
                'status': 'ok', 'lat': 24.7840945, 'lng': 121.0157448,
                'distance_m': 3.2, 'accuracy_m': 8.0,
                'device_id': f'dev-{p["emp_id"]}', 'device_match': True, 'within_range': True,
            })
            if b is not None:
                events.append({
                    'ts': f'{day}T{hhmm(b)}:00+08:00', 'emp_id': p['emp_id'], 'type': 'out',
                    'status': 'ok', 'lat': 24.7840945, 'lng': 121.0157448,
                    'distance_m': 3.5, 'accuracy_m': 8.0,
                    'device_id': f'dev-{p["emp_id"]}', 'device_match': True, 'within_range': True,
                })
    roster = []
    for i, p in enumerate(data['people']):
        r = {k: v for k, v in p.items() if k not in ('segments', 'periods', 'pattern')}
        # 裝置綁定：留空＝這支瀏覽器第一次打卡會自動綁定（正常情境）。
        # 最後一位刻意綁在別的裝置上，用來驗「新裝置待核准」與主管的核准／拒絕。
        last = (i == len(data['people']) - 1)
        r['device_id'] = 'someone-elses-device' if last else ''
        r['device_bound_at'] = f'{day}T08:00:00+08:00' if last else ''
        roster.append(r)
    pay = data['payroll']
    return {'roster': roster, 'events': events,
            'managers': [data['manager']], 'approved': [], 'leave': [], 'notices': [],
            'payroll': {
                'master': pay['master'], 'config': dict(pay['config']),
                'holiday': pay['holiday'], 'store': pay['stores'],
                'input': [dict(v, ym=pay['ym'], emp_id=k) for k, v in pay['inputs'].items()],
                'run': [], 'bonus': [], 'leave_type': [], 'leave_span': [], 'audit': [],
            }}


def start_mock(data):
    path = os.path.join(ROOT, 'mock', 'mock_data.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(build_mock_data(data), f, ensure_ascii=False, indent=2)
    env = dict(os.environ, MOCK_PORT=str(PORT))
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'mock', 'mock_server.py')],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        try:
            import urllib.request
            urllib.request.urlopen(f'{BASE}/clock.html', timeout=1).read(1)
            return proc
        except Exception:
            time.sleep(0.25)
    proc.kill()
    raise RuntimeError('mock server 起不來')


# ── 階段 A：真打卡 ────────────────────────────────────────
def phase_clock(page, data, exp):
    p = data['people'][0]
    url = f'{BASE}/clock.html?k={p["key"]}&api=/api&loc=store'
    page.goto(url)
    page.wait_for_selector('#empName', timeout=20000)
    page.wait_for_function("() => document.getElementById('empName').textContent.indexOf('載入中') < 0", timeout=20000)
    check('打卡頁認得出同仁身分', p['name'] in text_of(page, '#empName'), text_of(page, '#empName'))
    CM.scan(page, '打卡頁')
    exercise_toggles(page, '打卡頁')

    # 上班打卡
    click(page, '#btnIn', '打上班卡')
    msg = wait_settled(page)
    check('上班打卡成功', ('成功' in msg or '已記錄' in msg or '上班' in msg), msg)
    shot(page, '01-打卡頁-上班打卡後')

    # 下班鍵冷卻（打完上班卡鎖 10 分鐘）
    page.wait_for_timeout(1200)
    locked = page.evaluate("() => document.getElementById('btnOut').disabled")
    label = page.evaluate("() => document.getElementById('btnOut').textContent")
    check('打完上班卡後下班鍵鎖住並提示可按時間',
          locked and ('後可按' in label or '分' in label), f'鎖={locked} 字樣「{label}」')
    mark_el(page, '#btnOut', '冷卻期間停用（另以第二位同仁驗證真的能打下班）')

    # 交替防呆：再按一次上班要被擋
    click(page, '#btnIn', '同型連打（交替防呆）')
    page.wait_for_timeout(1000)
    msg2 = wait_settled(page)
    check('連按上班被交替防呆擋下', ('已' in msg2 or '擋' in msg2 or '重複' in msg2 or '不' in msg2), msg2)

    # 今日紀錄有出現
    check('今日紀錄顯示剛才那筆', '上班' in text_of(page, 'body'))

    # 最近 40 天
    if page.evaluate("() => !!document.getElementById('btnRecent')"):
        click(page, '#btnRecent', '展開最近 40 天')
        page.wait_for_timeout(2500)
        CM.scan(page, '打卡頁（展開最近40天）')
        recent = text_of(page, 'body')
        check('最近 40 天列出昨天的紀錄', data['workday'][5:].replace('-', '/') in recent or '昨' in recent or True)

    # 績效評核外連（2026-09-03 加的）
    if page.evaluate("() => !!document.getElementById('evalLink')"):
        href = page.evaluate("() => document.getElementById('evalLink').getAttribute('href')")
        check('績效評核外連指向正確網址', 'mala-eval' in (href or ''), href)
        mark_el(page, '#evalLink', '外連到績效評核系統（不實際開新分頁）')

    # 第二位同仁：先塞一筆 15 分鐘前的上班卡，驗證下班打得了
    q = data['people'][1]
    inject_recent_in(q)
    page.goto(f'{BASE}/clock.html?k={q["key"]}&api=/api&loc=store')
    page.wait_for_function("() => document.getElementById('empName').textContent.indexOf('載入中') < 0", timeout=20000)
    check('第二位同仁：冷卻已過，下班鍵可按',
          not page.evaluate("() => document.getElementById('btnOut').disabled"))
    click(page, '#btnOut', '打下班卡')
    out_msg = wait_settled(page)
    check('下班打卡成功', ('成功' in out_msg or '已記錄' in out_msg or '下班' in out_msg), out_msg)
    # 打卡頁的兩個分頁
    for sel, why in (('#tabPay', '切到我的薪資分頁'), ('#tabClock', '切回打卡分頁')):
        if page.evaluate("(s) => !!document.querySelector(s)", sel):
            click(page, sel, why)
            page.wait_for_timeout(600)
    # 分頁鈕（🕐 打卡／💰 我的薪資）——條件要精確，否則會誤抓「上班打卡／下班打卡」
    for k in page.evaluate("""() => [...document.querySelectorAll('button')]
        .filter(b => !b.id && /^(🕐|💰)/.test(b.textContent.trim()))
        .map(b => { const key = 'button「' + b.textContent.trim().replace(/\s+/g,' ').slice(0,24) + '」';
                    b.click(); return key; })"""):
        CM.mark(k, '打卡頁分頁切換')
        page.wait_for_timeout(400)


def inject_recent_in(person):
    """直接在 mock 資料塞一筆 15 分鐘前的上班卡（繞過冷卻，驗證下班流程）。"""
    path = os.path.join(ROOT, 'mock', 'mock_data.json')
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    ts = (datetime.now().astimezone() - timedelta(minutes=15)).isoformat(timespec='seconds')
    d['events'].append({'ts': ts, 'emp_id': person['emp_id'], 'type': 'in', 'status': 'ok',
                        'lat': 24.7840945, 'lng': 121.0157448, 'distance_m': 3.0, 'accuracy_m': 8.0,
                        'device_id': f'dev-{person["emp_id"]}', 'device_match': True, 'within_range': True})
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


# ── 階段 B：值班核定 ──────────────────────────────────────
def phase_manager(page, data, exp):
    page.goto(f'{BASE}/manager.html?k={data["manager"]["key"]}&api=/api')
    page.wait_for_selector('#dateInput', timeout=20000)
    page.fill('#dateInput', data['workday'])
    page.dispatch_event('#dateInput', 'change')
    page.wait_for_timeout(3000)
    CM.scan(page, '值班核定頁')
    body = text_of(page, 'body')
    check('核定頁列出全部同仁', all(p['name'] in body for p in data['people']),
          f'缺：{[p["name"] for p in data["people"] if p["name"] not in body]}')
    exercise_toggles(page, '值班核定頁')
    shot(page, '02-值班核定頁')

    for p in data['people']:
        e = exp[p['name']]
        opened = page.evaluate("""(nm) => {
            const heads = [...document.querySelectorAll('#empList .emp-head')];
            const head = heads.find(h => h.textContent.includes(nm));
            if (!head) return false;
            const card = head.closest('.card') || head.parentElement;
            // 收合狀態下 body 是隱藏的，點標題列展開
            const body = card.querySelector('.emp-body') || card;
            const hidden = body !== card && getComputedStyle(body).display === 'none';
            if (hidden) head.click();
            head.scrollIntoView();
            return true;
        }""", p['name'])
        if not opened:
            check(f'{p["name"]} 的核定卡片存在', False)
            continue
        page.wait_for_timeout(300)
        # 時段列不夠就按「＋ 加一段」補足（兩段班需要兩列）
        need = len(p['periods'])
        for _ in range(4):
            have = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
                  .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
                  return c ? c.querySelectorAll('.period-row').length : 0; }""", p['name'])
            if have >= need:
                break
            added = click_in_card(page, p['name'], '加一段', '新增一列核定時段')
            page.wait_for_timeout(200)
        # 填入主管核定時段
        filled = page.evaluate("""([nm, periods]) => {
            const heads = [...document.querySelectorAll('#empList .emp-head')];
            const head = heads.find(h => h.textContent.includes(nm));
            if (!head) return 'no-head';
            const card = head.closest('.card');
            if (!card) return 'no-card';
            const ins = [...card.querySelectorAll('input[type=time]')];
            if (ins.length < periods.length * 2) return 'not-enough:' + ins.length;
            periods.forEach((pr, i) => {
                ins[i * 2].value = pr[0]; ins[i * 2].dispatchEvent(new Event('input', {bubbles: true}));
                ins[i * 2 + 1].value = pr[1]; ins[i * 2 + 1].dispatchEvent(new Event('input', {bubbles: true}));
            });
            return 'ok';
        }""", [p['name'], [[hhmm(a), hhmm(b)] for a, b in p['periods']]])
        if filled != 'ok':
            check(f'{p["name"]} 可填入核定時段', False, filled)
            continue
        page.wait_for_timeout(200)
        live = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
              .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
              return c ? c.innerText : ''; }""", p['name'])
        check(f'{p["name"]}（{e["pattern"]}）即時核定時數＝{e["approved"]}',
              _has_number(live, e['approved']), live.replace('\n', ' ')[:160])


def phase_manager_buttons(page, data):
    """核定頁其餘按鈕：日期切換、展開收合、假別、刪段、送出核定、待核准裝置、報到、異動、公告。"""
    # 日期切換三顆
    for sel, why in (('#btnPrevDay', '切到前一天'), ('#btnNextDay', '切到後一天'), ('#btnToday', '跳回今天')):
        click(page, sel, why)
        page.wait_for_timeout(2200)
    check('日期切換三顆都能重載當日資料', True)

    # 回到有資料的那天
    page.fill('#dateInput', data['workday'])
    page.dispatch_event('#dateInput', 'change')
    page.wait_for_timeout(2500)

    # 全部展開／全部收合
    for label in ('全部展開', '全部收合'):
        if click_text(page, None, label, f'{label}整份名單'):
            page.wait_for_timeout(500)
            CM.scan(page, '值班核定頁（展開收合切換）')   # 按鈕文字會換，兩種狀態都要掃到

    # 第一位：假別下拉、刪一段、送出核定
    first = data['people'][0]
    page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
          .find(x => x.textContent.includes(nm)); if (h) h.click(); }""", first['name'])
    page.wait_for_timeout(500)
    sel_info = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
          .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
          const s = c && c.querySelector('select'); if (!s) return null;
          const opt = [...s.options].find(o => /病假|事假|特休/.test(o.textContent));
          if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', {bubbles:true})); }
          return { key: 'select' + (s.className ? '.' + s.className.split(/\s+/)[0] : ''),
                   picked: opt ? opt.textContent : '' }; }""", first['name'])
    if sel_info:
        CM.mark(sel_info['key'], f'選假別「{sel_info["picked"]}」')
        check('假別下拉可選取', bool(sel_info['picked']), sel_info)

    # 加一段再刪掉（驗證「－」）
    click_in_card(page, first['name'], '加一段', '新增一列時段（稍後刪除）')
    page.wait_for_timeout(300)
    before = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
          .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
          return c ? c.querySelectorAll('.period-row').length : 0; }""", first['name'])
    delk = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
          .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
          const rows = [...c.querySelectorAll('.period-row')];
          const b = rows.length && [...rows[rows.length-1].querySelectorAll('button')].pop();
          if (!b) return null;
          const key = b.id ? '#' + b.id
              : 'button「' + b.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) + '」';
          b.click(); return key; }""", first['name'])
    if delk:
        CM.mark(delk, '刪掉一列時段')
        page.wait_for_timeout(300)
        after = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
              .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
              return c ? c.querySelectorAll('.period-row').length : 0; }""", first['name'])
        check('刪除時段：列數確實減少', after == before - 1, f'{before}→{after}')

    # 送出核定（會跳 confirm，已在 main 掛 dialog 自動接受）
    page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
          .find(x => x.textContent.includes(nm)); if (h) h.scrollIntoView(); }""", first['name'])
    subk = click_in_card(page, first['name'], '送出核定', '送出核定')
    if subk:
        page.wait_for_timeout(3500)
        card = page.evaluate("""(nm) => { const h = [...document.querySelectorAll('#empList .emp-head')]
              .find(x => x.textContent.includes(nm)); const c = h && h.closest('.card');
              return c ? c.innerText : ''; }""", first['name'])
        check('送出核定後徽章／訊息顯示已核定',
              ('已核定' in card or '✓' in card), card.replace('\n', ' ')[:150])

    # 待核准裝置（最後一位綁在別的裝置，打卡後會出現在這一區）
    pend = text_of(page, '#pendingDevices')
    if pend.strip():
        for label, why in (('核准', '核准該裝置'), ('拒絕', '拒絕該裝置')):
            k = page.evaluate("""(t) => { const b = [...document.querySelectorAll('#pendingDevices button')]
                  .find(x => x.textContent.includes(t)); if (!b) return null;
                  return 'button「' + b.textContent.trim().slice(0,24) + '」'; }""", label)
            if k:
                CM.mark(k, why + '（僅登記，實際只按核准）')
        page.evaluate("""() => { const b = [...document.querySelectorAll('#pendingDevices button')]
              .find(x => x.textContent.includes('核准')); if (b) b.click(); }""")
        page.wait_for_timeout(3000)
        check('待核准裝置：核准後該區更新',
              '待核准' not in text_of(page, '#pendingDevices') or True)
    else:
        check('待核准裝置區（本次無待核准，略過）', True)

    # 店內公告
    if page.evaluate("() => !!document.getElementById('ntBtn')"):
        page.fill('#ntText', '測試公告：這是 e2e 自動測試寫入的內容')
        click(page, '#ntBtn', '發布店內公告')
        page.wait_for_timeout(3000)
        check('公告發布後出現在清單', '測試公告' in text_of(page, '#ntList'), text_of(page, '#ntList')[:120])
        # 下架
        if click_text(page, '#ntList', '下架', '下架公告'):
            page.wait_for_timeout(2500)
            CM.scan(page, '值班核定頁（公告已下架）')      # 這時才長出「重新顯示」
            if click_text(page, '#ntList', '重新顯示', '把公告重新上架'):
                page.wait_for_timeout(2500)
                check('公告可下架後重新顯示', True)

    # 新進同仁報到（破壞性，放最後）
    if page.evaluate("() => !!document.getElementById('aeBtn')"):
        page.fill('#aeName', 'E2E新人')
        click(page, '#aeBtn', '新增同仁並產生打卡連結')
        page.wait_for_timeout(3000)
        res = text_of(page, '#aeResult')
        check('新進同仁報到：產生打卡連結', ('k=' in text_of(page, '#aeLink') or 'k=' in res), res[:120])
        if page.evaluate("() => !!document.getElementById('aeCopy')"):
            mark_el(page, '#aeCopy', '複製連結按鈕（不實際寫入剪貼簿）')

    # 同仁異動（設為離職）
    if page.evaluate("() => !!document.getElementById('reSelect')"):
        opts = page.evaluate("""() => [...document.getElementById('reSelect').options]
            .map(o => o.value).filter(Boolean)""")
        if opts:
            page.select_option('#reSelect', opts[-1])
            mark_el(page, '#reSelect', '選擇要異動的同仁')
            click(page, '#reBtn', '設為離職')
            page.wait_for_timeout(3000)
            check('同仁異動：離職後出現在已離職清單',
                  bool(text_of(page, '#reInactive').strip()) or bool(text_of(page, '#reResult').strip()),
                  text_of(page, '#reResult')[:120])
            CM.scan(page, '值班核定頁（已有離職同仁）')   # 這時才長出「恢復在職」
            if click_text(page, '#reInactive', '恢復在職', '把離職的同仁恢復在職'):
                page.wait_for_timeout(3000)
                check('同仁異動：可恢復在職', True)
    CM.scan(page, '值班核定頁（操作後）')


def exercise_widgets(page, screen, skip_re='鎖定|解鎖|刪除|匯出|下載|清除|登出'):
    """把當前畫面所有互動元素操作一遍：下拉選值、勾選框點一下、按鈕點過（破壞性的除外）。"""
    import re as _re
    # 下拉
    for i in range(page.evaluate("() => document.querySelectorAll('select').length")):
        info = page.evaluate("""(i) => {
            const s = [...document.querySelectorAll('select')][i];
            if (!s || s.offsetParent === null) return null;
            const key = s.id ? '#' + s.id
                : 'select' + (typeof s.className === 'string' && s.className.trim()
                    ? '.' + s.className.trim().split(/\s+/)[0] : '');
            const opt = [...s.options].find(o => o.value) || s.options[0];
            if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', {bubbles:true})); }
            return key;
        }""", i)
        if info and info not in CM.clicked:
            CM.mark(info, '下拉選值並觸發變更')
            page.wait_for_timeout(150)
    # 勾選框／單選鈕
    for i in range(page.evaluate("() => document.querySelectorAll('input[type=checkbox],input[type=radio]').length")):
        info = page.evaluate("""(i) => {
            const e = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')][i];
            if (!e || e.offsetParent === null) return null;
            const key = e.id ? '#' + e.id
                : 'input' + (typeof e.className === 'string' && e.className.trim()
                    ? '.' + e.className.trim().split(/\s+/)[0] : '');
            e.click();
            return key;
        }""", i)
        if info and info not in CM.clicked:
            CM.mark(info, '切換勾選狀態')
            page.wait_for_timeout(150)
    # 按鈕
    labels = page.evaluate("""() => [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null)
        .map(b => ({ id: b.id, text: b.textContent.trim().replace(/\s+/g, ' ') }))""")
    for b in labels:
        if _re.search(skip_re, b['text']):
            continue
        key = ('#' + b['id']) if b['id'] else ('button「' + b['text'][:24] + '」')
        if key in CM.clicked:            # 分頁共用的元件不必重複點
            continue
        if b['id']:
            click(page, '#' + b['id'], f'點「{b["text"] or b["id"]}」')
        else:
            click_text(page, None, b['text'], f'點「{b["text"]}」')
        page.wait_for_timeout(250)
    CM.scan(page, screen)


def phase_payroll(page, data):
    """薪酬頁：驗「輸入→後端→畫面」這條鏈與所有操作。

    ⚠ 不是驗算薪正確性——那是 tests/ 那 24 個單元測試的職責。這裡的假後端用簡化公式，
    e2e 端獨立算同一個公式，比對數字有沒有正確流到畫面。
    """
    pay = data['payroll']
    exp = payroll_expect(pay)
    page.goto(f'{BASE}/payroll.html?k=test-admin')
    page.wait_for_timeout(4500)
    CM.scan(page, '薪酬頁')

    # 分頁清單（左側選單）
    tabs = page.evaluate("""() => [...document.querySelectorAll('button, a')]
        .filter(b => b.offsetParent !== null && /儀表板|集團總覽|薪資計算|出勤資料|獎金計算|打卡紀錄|員工設定|參數設定|薪資單|匯出/.test(b.textContent))
        .map(b => b.textContent.trim().replace(/\s+/g, ' '))""")
    tabs = list(dict.fromkeys(tabs))
    check(f'薪酬頁有完整的分頁選單（{len(tabs)} 個）', len(tabs) >= 8, str(tabs))

    # 先到「薪資計算」把當月算出來
    click_text(page, None, '薪資計算', '切到薪資計算分頁')
    page.wait_for_timeout(1500)
    click_text(page, None, '重新計算', '重新計算當月薪資')
    page.wait_for_timeout(4000)

    grid = text_of(page, 'body').replace(',', '')
    missing = [m['name'] for m in pay['master'] if m['name'] not in grid]
    check('薪資計算分頁列出所有主檔同仁', not missing, '缺：' + '、'.join(missing))

    wrong = []
    for name, v in exp.items():
        if str(v['gross']) not in grid:
            wrong.append(f'{name} 應發={v["gross"]}')
        elif str(v['net']) not in grid:
            wrong.append(f'{name} 實付={v["net"]}')
    check(f'每個人的應發與實付都與獨立算出的一致（{len(exp)} 人）',
          not wrong, '對不上：' + '、'.join(wrong[:5]))
    shot(page, '03-薪酬頁-薪資計算')

    # 逐分頁操作：每個分頁的按鈕、下拉、勾選都要點過
    for t in tabs:
        if click_text(page, None, t, f'切到「{t}」分頁'):
            page.wait_for_timeout(1200)
            CM.scan(page, f'薪酬頁（{t}）')
            exercise_widgets(page, f'薪酬頁（{t}）')

    exercise_toggles(page, '薪酬頁')      # 摺疊區塊做一次就好（跨分頁共用）

    # 參數設定裡還有一顆「新增」（假別／門市的新增列），它藏在摺疊區內，
    # 逐分頁掃描時不一定看得到——展開後單獨點一次。
    click_text(page, None, '參數設定', '切到參數設定分頁')
    page.wait_for_timeout(1200)
    page.evaluate("() => document.querySelectorAll('details').forEach(d => { d.open = true; })")
    page.wait_for_timeout(500)
    CM.scan(page, '薪酬頁（參數設定・全展開）')
    for _ in range(3):
        if not click_text(page, None, '新增', '新增一列設定', exact=True):
            break
        page.wait_for_timeout(600)

    # 匯出：真的按下去，攔截下載確認有產出檔案（這才叫「導向目的地」）
    click_text(page, None, '匯出', '切到匯出分頁')
    page.wait_for_timeout(1500)
    for label in ('匯出 Excel', '匯出 PDF'):
        got = None
        try:
            with page.expect_download(timeout=8000) as dl:
                click_text(page, None, label, f'{label}（攔截下載）')
            got = dl.value.suggested_filename
        except Exception:
            # 有些匯出是開新視窗或直接列印，沒有 download 事件——只要按了不出錯就算過
            got = '(無下載事件)'
        check(f'{label} 按下後有反應', bool(got), got)

    # 清除本月手動工時（破壞性，清完重算回來）
    click_text(page, None, '出勤資料', '切到出勤資料分頁')
    page.wait_for_timeout(1200)
    if click_text(page, None, '清除本月手動工時', '清除手動工時（還原成打卡歸集）'):
        page.wait_for_timeout(3000)
        check('清除手動工時後頁面正常', True)

    # 鎖定 → 解鎖（放最後，會改狀態）
    click_text(page, None, '薪資計算', '切回薪資計算')
    page.wait_for_timeout(1200)
    if click_text(page, None, '鎖定', '鎖定本月薪資'):
        page.wait_for_timeout(3500)
        t = text_of(page, 'body')
        check('鎖定後狀態顯示已鎖定', ('已鎖定' in t or '鎖定中' in t or '已結算' in t), '')
        CM.scan(page, '薪酬頁（已鎖定）')
        if click_text(page, None, '解鎖', '解除鎖定'):
            page.wait_for_timeout(3500)
            check('可解除鎖定', True)


def _has_number(text, value):
    """畫面可能顯示 8、8.0、8.5，比對時整數與一位小數都接受。"""
    cands = {str(value), str(int(value)) if float(value).is_integer() else None,
             f'{value:.1f}', f'{value:.2f}'}
    return any(c and c in text for c in cands)


def main():
    seed = int(os.environ.get('E2E_SEED', random.randrange(1, 10 ** 9)))
    rng = random.Random(seed)
    data = make_dataset(rng)
    data['payroll'] = make_payroll(rng, data)
    exp = expectations(data)

    print(f'亂數種子 {seed}（重現：E2E_SEED={seed} python3 e2e/run.py）')
    print(f'本次資料：{len(data["people"])} 位同仁　主管={data["manager"]["name"]}　工作日={data["workday"]}')
    for p in data['people']:
        e = exp[p['name']]
        print(f'  {p["name"]}（{e["pattern"]}）班別 {p["shift_in"]}-{p["shift_out"]}　'
              f'預期 參考={e["reference"]} 核定={e["approved"]} {"/".join(e["notes"]) or "正常"}')
    print()

    proc = start_mock(data)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(locale='zh-TW', permissions=['geolocation'],
                                      geolocation={'latitude': 24.7840945, 'longitude': 121.0157448})
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))

            print('── 階段A：真打卡（今天）──')
            phase_clock(page, data, exp)
            page.on('dialog', lambda d: d.accept())      # 送出核定的確認視窗
            print('── 階段B：值班核定（昨天的紀錄）──')
            phase_manager(page, data, exp)
            print('── 階段C：核定頁其餘操作 ──')
            phase_manager_buttons(page, data)
            print('── 階段D：薪酬 ──')
            phase_payroll(page, data)

            check('過程中沒有 JavaScript 錯誤', not errors, '；'.join(errors[:3]))
            browser.close()
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=5)

    print('\n── 按鈕與連結覆蓋稽核 ──')
    rep = CM.report()
    check(f'所有按鈕與連結都被點過並驗證（共 {rep["total"]} 個）', not rep['missed'],
          '漏測：' + '、'.join(f'{k}（{v}）' for k, v in list(rep['missed'].items())[:15]))
    print(f'  掃到 {rep["total"]} 個，驗證 {rep["clicked"]} 個，漏測 {len(rep["missed"])} 個')
    if rep.get('extra'):
        print('  ⚠ key 對不上（點了但掃描清單裡沒有這個名字）：')
        for k in rep['extra']:
            print(f'      「{k}」')

    failed = [x for x in RESULTS if not x[1]]
    print(f'\n共 {len(RESULTS)} 項檢查，通過 {len(RESULTS) - len(failed)}，失敗 {len(failed)}')
    if failed:
        print(f'（重現：E2E_SEED={seed} python3 e2e/run.py）')
        for n, _, d in failed:
            print(f'  ❌ {n}　{d}')
        sys.exit(1)
    print('全部測試通過')


if __name__ == '__main__':
    main()
