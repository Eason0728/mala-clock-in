#!/usr/bin/env python3
"""LINE 申請頁「第一次開頁又快又穩」端對端（2026-11-18 Eason：第一次開申請頁向光復讀取要 13 到 14 秒）。

假後端（Playwright 路由，同 req_seg2.Fake）＋頁內假 mini（同 clock_line MINI_JS，多一個 slow 模式）；光復延遲用頁內 window.__delay（每支只延遲第一次）。
驗收：
  1. 光復開頁資料、額度都延遲 14 秒：手機記住過 → 1.5 秒內可操作；手機沒記但 mini 記住（重開後的存檔）→ 2.5 秒內可操作；
     兩邊都沒有 → 不空白（「讀取中…」，8 秒後寫「回應比較慢」），光復回來才可操作（量秒數，這段靠光復端對照表＋mini 預熱縮短）。
  2. 記住的跟最新的不一樣時，最後以最新的為準、不會送出錯的單：少一家店、多一家店、額度不同（兩個方向）、開關（第二段）不同。
  3. 光復讀取失敗（有「重新讀取」）、mini 掛掉、mini 和光復都慢、最新的一直等不到（12 秒後照送，店家後端照樣檢查）。
  4. 「改前」（E2E_BASE_JS 或 git show origin/main:req-line.js）同樣操作：印出改前會不會送出錯的單、可操作秒數。
用法：/usr/bin/python3 e2e/req_init_fast.py   （E2E_MOCK_PORT 換埠；E2E_SHOTS 指定截圖資料夾）"""
import json
import os
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402
import req_seg2 as RS  # noqa: E402

ok = CL.ok
HQ, JS = CL.HQ, CL.JS
ROOT = CL.ROOT
SHOTS = os.environ.get('E2E_SHOTS', '')
BASE_JS = os.environ.get('E2E_BASE_JS', '')
try:
    OLD_JS = open(BASE_JS, encoding='utf-8').read() if BASE_JS else subprocess.run(['git', '-C', ROOT, 'show', 'origin/main:req-line.js'], capture_output=True, text=True, check=True).stdout
except Exception:
    OLD_JS = None
S_HQ = {'code': 'hq', 'name': HQ['name'], 'emp_id': 'E1', 'emp_name': '林小美'}
S_JS = {'code': 'mztjs', 'name': JS['name'], 'emp_id': 'J1', 'emp_name': '林小美'}
LT = {'common': ['特休假', '事假', '病假', '生理假', '家庭照顧假'], 'special': []}
FAM = lambda remain: [{'name': '家庭照顧假', 'cap_days': 7, 'cap_h': 56, 'remain_h': remain, 'used_h': 56 - remain, 'basis': 'calendar'}]
MINI_URL = 'http://mini.test/store/api/line-req'
MINI_SLOW = CL.MINI_JS.replace("if (M.mode === 'off')", "if (M.mode === 'slow' && !M._slowed) { M._slowed = 0; } if (M.mode === 'slow') return new Promise(function (r) { setTimeout(r, 3000); }).then(function () { M.mode = 'slow_done'; return window.fetch(url, o); }); if (M.mode === 'slow_done') M.mode = ''; if (M.mode === 'off')")


class Fake(RS.Fake):
    """開頁資料、額度回什麼可以換；可以讓開頁資料先失敗。"""

    def __init__(self, init_stores=None, punch=None, quota=None, init_fail=0, **k):
        super().__init__(**k)
        self.init_stores = init_stores or [S_HQ]
        self.punch = punch
        self.quota = quota if quota is not None else FAM(56)
        self.init_fail = init_fail

    def handler(self, route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except Exception:
            b = {}
        J = lambda x: route.fulfill(status=200, content_type='application/json', body=json.dumps(x, ensure_ascii=False))
        a = b.get('action')
        if a == 'line_hub_req_init':
            self.calls.append({'action': a, 'code': '', 'body': b, 'raw': route.request.post_data})
            if self.init_fail:
                self.init_fail -= 1
                return J({'ok': False, 'error': 'server_error'})
            return J({'ok': True, 'lite': True, 'stores': self.init_stores, 'punch_store': self.punch if self.punch is not None else self.init_stores[0]['code'],
                      'comp': None, 'leave_types': LT, 'quota': []})
        if a == 'line_hub_req_quota':
            self.calls.append({'action': a, 'code': '', 'body': b, 'raw': route.request.post_data})
            return J({'ok': True, 'quota': self.quota, 'comp': {'allowed': False, 'known': True, 'ot_h': 0, 'used_h': 0, 'balance_h': 0}})
        return super().handler(route)


def cache_js(stores, last=None, punch=None):
    c = {'sub': 'U1', 'stores': stores, 'punch_store': punch if punch is not None else stores[0]['code'], 'leave_types': LT, 'last_store': last}
    return "try { localStorage.setItem('mala_req_init_v1', JSON.stringify(Object.assign(%s, { at: Date.now() - 3600000 }))); } catch (e) {}" % json.dumps(c, ensure_ascii=False)


def open_p(br, fake, tab, delay=None, cache=None, mini=None, js=None, wait=None):
    """wait＝等到可操作的選擇器（None＝不等）；回 (page, 可操作毫秒或 None)。"""
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    p = ctx.new_page()
    p.add_init_script(CL.LOG_JS)
    if mini is not None:
        js_m = MINI_SLOW + "window.__mini.peek = %s;" % json.dumps(mini.get('peek', {}), ensure_ascii=False) + "window.__mini.mode = %s;" % json.dumps(mini.get('mode', ''))
        p.add_init_script(js_m)
    p.add_init_script("window.confirm = function () { return true; }; window.__delay = %s;" % json.dumps(delay or {}))
    p.add_init_script(cache or "try { localStorage.removeItem('mala_req_init_v1'); } catch (e) {}")
    p.route('**/api', fake.handler)
    p.route('**/api/*', fake.handler)
    if js is not None:
        p.route('**/req-line.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=js))
    extra = '&view=req&tab=' + tab + ('&retry_ms=50&mini_req=' + MINI_URL + '&req_mirror=1' if mini is not None else '')
    t0 = time.time()
    p.goto(CL.url((HQ['lat'], HQ['lng']), in_client=True, extra=extra))
    ms = None
    if wait:
        p.wait_for_selector(wait, timeout=30000)
        ms = int((time.time() - t0) * 1000)
    return p, ms


def txt(p):
    return p.inner_text('#reqView')


def wait_txt(p, needle, timeout=20000):
    p.wait_for_function("(s) => document.getElementById('reqView').innerText.indexOf(s) >= 0", arg=needle, timeout=timeout)


def shot(p, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        p.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)


def fill_ot(p, a='18:00', b='20:00'):
    CL.pick_time(p, 0, a)
    CL.pick_time(p, 1, b)
    p.fill('#reqView input[type=text]', '晚上人手不足')


def submits(f):
    return f.submits()


FORM = '#reqView button.primary'


def main():
    os.makedirs(CL.SHOTS, exist_ok=True)
    proc = CL.start_mock()
    timing = {}
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            slow = {'line_hub_req_init': 14000, 'line_hub_req_quota': 14000}

            # ── 1. 光復慢 14 秒：可操作時間 ──
            f = Fake()
            p, ms = open_p(br, f, 'leave', delay=slow, cache=cache_js([S_HQ]), wait=FORM)
            timing['手機記住過'] = ms
            ok('光復慢 14 秒＋手機記住過：%d 毫秒可操作（目標 ≤1500）' % ms, ms <= 1500, ms)
            p.click('#reqView .rq-chip:has-text("家庭照顧假")')
            ok('額度還沒到 → 寫「額度讀取中…」（不空白、不顯示舊數字）', p.locator('#reqView .rq-quota-wait').count() == 1 and '額度讀取中' in txt(p)
               and p.locator('#reqView .rq-quota').count() == 0, txt(p)[:300])
            shot(p, '01-光復慢-手機記住-額度讀取中')
            wait_txt(p, '剩 56 小時')
            ok('光復回來 → 額度補上、「讀取中」消失', p.locator('#reqView .rq-quota-wait').count() == 0)
            p.context.close()

            f = Fake()
            init_peek = {'ok': True, 'lite': True, 'stores': [S_HQ], 'punch_store': 'hq', 'leave_types': LT}
            p, ms = open_p(br, f, 'leave', delay=slow, mini={'peek': {'init': init_peek}}, wait=FORM)
            timing['手機沒記、mini 存檔有'] = ms
            ok('光復慢 14 秒＋手機沒記、mini 存檔有：%d 毫秒可操作（目標 ≤2500）' % ms, ms <= 2500, ms)
            p.context.close()

            f = Fake()
            p, _ = open_p(br, f, 'leave', delay=slow)
            p.wait_for_timeout(1500)
            ok('兩邊都沒有：先顯示「讀取中…」（不空白）', '讀取中' in txt(p) and p.locator(FORM).count() == 0, txt(p)[:80])
            p.wait_for_timeout(8000)
            ok('等超過 8 秒：寫「光復系統這次回應比較慢」', '回應比較慢' in txt(p), txt(p)[:120])
            shot(p, '02-兩邊都沒有-回應比較慢')
            t0 = time.time(); p.wait_for_selector(FORM, timeout=20000)
            timing['兩邊都沒有（光復 14 秒）'] = int(9500 + (time.time() - t0) * 1000)
            ok('光復回來就可以操作', p.locator('#reqView .rq-chip').count() > 0)
            p.context.close()

            # ── 2. 記住的跟最新的不一樣 ──
            def scenario_more_store(js=None):
                f = Fake(init_stores=[S_HQ, S_JS], punch='mztjs')
                p, _ = open_p(br, f, 'ot', delay={'line_hub_req_init': 5000}, cache=cache_js([S_HQ]), js=js, wait=FORM)
                fill_ot(p)
                p.click(FORM)
                p.wait_for_timeout(300)
                early = len(submits(f))
                p.wait_for_timeout(6000)
                return f, p, early

            f, p, early = scenario_more_store()
            ok('少一家店（手機記住只有總部，最新多了金山）：最新的還沒到就按送出 → 沒有送出，畫面寫「確認最新資料中」', early == 0, early)
            ok('最新的到了 → 不送、寫「多了「%s」，請確認」' % JS['name'], len(submits(f)) == 0 and '多了「' + JS['name'] + '」' in txt(p) and p.locator('#reqView .rq-gate-note').count() == 1, txt(p)[:300])
            ok('店別選單現在有兩家', p.locator('#reqView select.rq-store option').count() == 2)
            shot(p, '03-少一家店-請確認')
            p.select_option('#reqView select.rq-store', '1')
            p.wait_for_timeout(800)
            fill_ot(p)
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            s = submits(f)
            ok('同仁改選金山再送 → 只送一次、送到金山', len(s) == 1 and s[0]['code'] == 'mztjs', [(x['code'], x['body'].get('kind')) for x in s])
            p.context.close()
            if OLD_JS:
                f0, p0, early0 = scenario_more_store(OLD_JS)
                timing['改前：少一家店時按送出'] = '送出 %d 張到 %s' % (len(submits(f0)), ','.join(x['code'] for x in submits(f0)) or '-')
                ok('（改前對照）同樣操作改前會直接送到總部（記住的那家）', early0 == 1 and submits(f0)[0]['code'] == 'hq', [x['code'] for x in submits(f0)])
                p0.context.close()

            f = Fake(init_stores=[S_HQ])
            p, _ = open_p(br, f, 'ot', delay={'line_hub_req_init': 4000}, cache=cache_js([S_HQ, S_JS], last='mztjs'), wait=FORM)
            ok('多一家店（手機記住總部＋金山、上次用金山）：先畫成金山', '金山' in p.inner_text('#reqView .rq-head'), p.inner_text('#reqView .rq-head'))
            fill_ot(p)
            p.click(FORM)
            p.wait_for_timeout(5500)
            ok('最新的只剩總部 → 不送、寫「已經不在名單」、店別換成總部', len(submits(f)) == 0 and '已經不在名單' in txt(p) and HQ['name'] in p.inner_text('#reqView .rq-head'), txt(p)[:300])
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('再按一次 → 送到總部（不是金山）', [x['code'] for x in submits(f)] == ['hq'], [x['code'] for x in submits(f)])
            p.context.close()

            # 額度不同：mini 記住「剩 56 小時」，最新是 0 小時（用完）→ 不會送出
            f = Fake(quota=FAM(0))
            p, _ = open_p(br, f, 'leave', delay={'line_hub_req_quota': 4000}, cache=cache_js([S_HQ]), mini={'peek': {'quota': {'ok': True, 'quota': FAM(56), 'comp': None}}}, wait=FORM)
            p.click('#reqView .rq-chip:has-text("家庭照顧假")')
            wait_txt(p, '剩 56 小時', 5000)
            ok('額度不同：先畫 mini 記住的「剩 56 小時」、最下面小字「資料更新於」', p.locator('#reqView .rq-fresh').count() == 1)
            p.click(FORM)
            p.wait_for_timeout(300)
            early = len(submits(f))
            p.wait_for_timeout(5000)
            ok('按送出時額度還是記住的 → 先等最新的，最新是 0 小時 → 不送、寫「額度…剛更新」', early == 0 and len(submits(f)) == 0 and '剛更新' in txt(p) and '剩 0 小時' in txt(p), txt(p)[:300])
            shot(p, '04-額度不同-請確認')
            p.click(FORM)
            p.wait_for_timeout(1500)
            ok('再按一次 → 用最新額度擋下（只剩 0 小時，不能送出），一張都沒送', len(submits(f)) == 0 and '不能送出' in txt(p), txt(p)[:300])
            p.context.close()
            if OLD_JS:
                f0 = Fake(quota=FAM(0))
                p0, _ = open_p(br, f0, 'leave', delay={'line_hub_req_quota': 4000}, cache=cache_js([S_HQ]), mini={'peek': {'quota': {'ok': True, 'quota': FAM(56), 'comp': None}}}, js=OLD_JS, wait=FORM)
                p0.click('#reqView .rq-chip:has-text("家庭照顧假")'); p0.wait_for_timeout(500)
                p0.click(FORM); p0.wait_for_timeout(1500)
                timing['改前：額度記住的是舊的時按送出'] = '送出 %d 張' % len(submits(f0))
                ok('（改前對照）改前照記住的額度直接送出（靠店家後端擋）', len(submits(f0)) == 1, len(submits(f0)))
                p0.context.close()

            # 反方向：記住的說用完（會擋），最新的還有 → 等最新的、請確認後可以送
            f = Fake(quota=FAM(56))
            p, _ = open_p(br, f, 'leave', delay={'line_hub_req_quota': 3000}, cache=cache_js([S_HQ]), mini={'peek': {'quota': {'ok': True, 'quota': FAM(0), 'comp': None}}}, wait=FORM)
            p.click('#reqView .rq-chip:has-text("家庭照顧假")')
            wait_txt(p, '剩 0 小時', 5000)
            p.click(FORM)
            p.wait_for_timeout(4000)
            ok('記住的說用完、最新的還剩 56 小時 → 沒有用舊數字擋人：換成最新、請確認', len(submits(f)) == 0 and '剩 56 小時' in txt(p) and '剛更新' in txt(p), txt(p)[:300])
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('再按一次 → 送出 1 張家庭照顧假', len(submits(f)) == 1 and submits(f)[0]['body'].get('leave_type') == '家庭照顧假')
            p.context.close()

            # 開關不同：mini 記住這家店開放第二段，最新的沒開 → 不會送出兩段
            f = Fake(seg2=[])
            peek_info = RS.Fake(seg2=['ot']).info('hq', {})
            p, _ = open_p(br, f, 'ot', delay={'req_info': 4000}, cache=cache_js([S_HQ]), mini={'peek': {'info': peek_info}}, wait='#reqView .rq-seg-add')
            CL.pick_time(p, 0, '11:00'); CL.pick_time(p, 1, '14:00')
            p.click('#reqView .rq-seg-add')
            CL.pick_time(p, 2, '17:00'); CL.pick_time(p, 3, '21:00')
            p.fill('#reqView input[type=text]', '兩段')
            p.click(FORM)
            p.wait_for_timeout(5500)
            ok('開關不同（記住的有第二段、最新的沒開）→ 不送、第二段消失、請確認', len(submits(f)) == 0 and p.locator('#reqView .rq-seg-del').count() == 0 and '剛更新' in txt(p), txt(p)[:300])
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            s = submits(f)
            ok('再按一次 → 送一段（沒有 segments）', len(s) == 1 and 'segments' not in s[0]['body'], s[0]['body'] if s else s)
            p.context.close()

            # 生理假「已請過哪幾天」（dates）也要比對：記住的沒有、最新的有 → 不直接送，換成最新、請確認（額度數字都一樣）
            COMP0 = {'allowed': False, 'known': True, 'ot_h': 0, 'used_h': 0, 'balance_h': 0}   # 同 Fake 額度回的補休帳：這一段只想比「已請日期」
            MENS = lambda dates: [{'name': '生理假', 'cap_days': 36, 'cap_h': 288, 'remain_h': 288, 'used_h': 0, 'used_n': 1, 'dates': dates, 'basis': 'calendar'}]
            f = Fake(quota=MENS(['2020-01-05']))
            p, _ = open_p(br, f, 'leave', delay={'line_hub_req_quota': 4000}, cache=cache_js([S_HQ]), mini={'peek': {'quota': {'ok': True, 'quota': MENS(['2020-02-07']), 'comp': COMP0}}}, wait=FORM)
            p.click('#reqView .rq-chip:has-text("生理假")')
            p.click(FORM)
            p.wait_for_timeout(300)
            early = len(submits(f))
            p.wait_for_timeout(5000)
            ok('生理假已請日期不同（記住的是 2/7、最新的是 1/5，次數與其他額度欄位相同）→ 不送、寫「剛更新」、請確認', early == 0 and len(submits(f)) == 0 and '剛更新' in txt(p) and p.locator('#reqView .rq-gate-note').count() == 1, txt(p)[:300])
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('再按一次 → 送出 1 張生理假', len(submits(f)) == 1 and submits(f)[0]['body'].get('leave_type') == '生理假', [x['body'].get('leave_type') for x in submits(f)])
            p.context.close()
            f = Fake(quota=MENS(['2020-01-05']))
            p, _ = open_p(br, f, 'leave', delay={'line_hub_req_quota': 4000}, cache=cache_js([S_HQ]), mini={'peek': {'quota': {'ok': True, 'quota': MENS(['2020-01-05']), 'comp': COMP0}}}, wait=FORM)
            p.click('#reqView .rq-chip:has-text("生理假")')
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('生理假已請日期相同 → 等到最新的一樣就照送（不多問）', len(submits(f)) == 1 and p.locator('#reqView .rq-gate-note').count() == 0, len(submits(f)))
            p.context.close()

            # mini 存檔先畫的開頁資料不帶姓名、工號（2026-11-18 驗收補）：先畫時不顯示姓名（也不能顯示 undefined 或別人），光復最新的到了才顯示；
            # 送出前確認比對店別時不因「存檔沒有工號」多跳一次「剛更新」
            kept_peek = {'ok': True, 'lite': True, 'stores': [{'code': 'hq', 'name': HQ['name'], 'support': False}], 'punch_store': 'hq', 'leave_types': LT}
            f = Fake()
            p, ms = open_p(br, f, 'ot', delay={'line_hub_req_init': 5000}, mini={'peek': {'init': kept_peek}}, wait=FORM)
            head = p.inner_text('#reqView .rq-head')
            ok('mini 存檔（沒有姓名工號）先畫：%d 毫秒可操作、標題只有店名、不顯示 undefined／別人的名字' % ms, ms <= 2500 and 'undefined' not in head and '林小美' not in head and HQ['name'] in head, head)
            fill_ot(p)
            p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('按送出：等光復最新的、店別一樣就照送 1 張（不會因為存檔沒有工號就多問一次）', len(submits(f)) == 1 and p.locator('#reqView .rq-gate-note').count() == 0, [len(submits(f)), txt(p)[:200]])
            ok('光復最新的到了 → 標題顯示姓名', '林小美' in p.inner_text('#reqView .rq-head'), p.inner_text('#reqView .rq-head'))
            p.context.close()
            # 存檔先畫、光復最新的把「這家店的工號」換成別人的（同一支 LINE 改綁）：仍然偵測得到（有工號可比的時候照比）
            S_HQ2 = dict(S_HQ, emp_id='E9', emp_name='王大明')
            f = Fake(init_stores=[S_HQ2])
            p, _ = open_p(br, f, 'ot', delay={'line_hub_req_init': 4000}, cache=cache_js([S_HQ]), wait=FORM)
            fill_ot(p)
            p.click(FORM)
            p.wait_for_timeout(5500)
            ok('手機記住有工號、最新的工號不同 → 不送、請確認', len(submits(f)) == 0 and p.locator('#reqView .rq-gate-note').count() == 1, txt(p)[:200])
            p.context.close()

            # ── 3. 失敗與慢 ──
            f = Fake(init_fail=99)   # 一直失敗（頁面自己的重試也用完）
            p, _ = open_p(br, f, 'leave', mini={'mode': ''}, )
            p.wait_for_selector('#reqView .rq-retry', timeout=20000)
            f.init_fail = 0
            ok('光復讀取失敗（手機沒記）→ 說明＋「重新讀取」，不空白', ('讀不到資料' in txt(p) or '連線失敗' in txt(p)) and p.locator('#reqView .rq-retry').count() == 1, txt(p)[:120])
            shot(p, '05-光復失敗-重新讀取')
            p.click('#reqView .rq-retry')
            p.wait_for_selector(FORM, timeout=10000)
            ok('按「重新讀取」→ 表單出來', p.locator('#reqView .rq-chip').count() > 0)
            p.context.close()

            f = Fake()
            p, ms = open_p(br, f, 'ot', delay={'line_hub_req_init': 14000}, cache=cache_js([S_HQ]), mini={'mode': 'abort'}, wait=FORM)
            ok('mini 掛掉＋光復慢：手機記住的照樣 %d 毫秒可操作' % ms, ms <= 1500, ms)
            p.context.close()
            f = Fake()
            p, _ = open_p(br, f, 'ot', mini={'mode': 'abort'}, wait=FORM)
            fill_ot(p); p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=15000)
            ok('mini 掛掉：直接問光復，照常送出 1 張', len(submits(f)) == 1)
            p.context.close()

            f = Fake()
            p, ms = open_p(br, f, 'leave', delay=slow, cache=cache_js([S_HQ]), mini={'mode': 'slow'}, wait=FORM)
            ok('mini 和光復都慢：手機記住的照樣 %d 毫秒可操作' % ms, ms <= 1500, ms)
            p.context.close()
            f = Fake()
            p, _ = open_p(br, f, 'leave', delay={'line_hub_req_init': 9000}, mini={'mode': 'slow'})
            p.wait_for_timeout(8600)
            ok('mini 和光復都慢、手機沒記：不空白（讀取中→回應比較慢）', '回應比較慢' in txt(p), txt(p)[:120])
            p.wait_for_selector(FORM, timeout=20000)
            ok('光復回來就能操作', True)
            p.context.close()

            # 最新的一直等不到（光復 20 秒）：最多等 12 秒就照送（店家後端照樣檢查名冊與額度）
            f = Fake()
            p, _ = open_p(br, f, 'ot', delay={'line_hub_req_init': 20000}, cache=cache_js([S_HQ]), wait=FORM)
            fill_ot(p)
            t0 = time.time(); p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=20000)
            waited = int((time.time() - t0) * 1000)
            ok('最新的等不到：%d 毫秒後照送 1 張（上限 12 秒＋送出）' % waited, len(submits(f)) == 1 and 11000 <= waited <= 15000, waited)
            p.context.close()

            # 最新的已經到了：按送出不用等（跟改版前一樣快）
            f = Fake()
            p, _ = open_p(br, f, 'ot', cache=cache_js([S_HQ]), wait=FORM)
            p.wait_for_function("window.__calls.filter(c => c.action === 'req_info').length >= 1", timeout=10000)
            p.wait_for_timeout(800)
            fill_ot(p)
            t0 = time.time(); p.click(FORM)
            p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=10000)
            ms = int((time.time() - t0) * 1000)
            timing['最新的已到時按送出到切到我的申請'] = ms
            ok('最新的已經到了：按送出 %d 毫秒就送完（不多等）' % ms, ms < 1500 and len(submits(f)) == 1, ms)
            p.context.close()
            br.close()
    finally:
        proc.terminate()
    print('\n量測（毫秒）：' + json.dumps(timing, ensure_ascii=False))
    print('\n全部通過：%d 項' % CL.n)


if __name__ == '__main__':
    main()
