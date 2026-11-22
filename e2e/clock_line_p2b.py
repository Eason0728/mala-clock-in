#!/usr/bin/env python3
"""第 2 階段 P2-B「開頁只問 mini」（2026-11-21）：clock-line.html 每店開關 ST_ONLY_MINI（false／"cmp"／true）。

用法：E2E_MOCK_PORT=8813 /usr/bin/python3 e2e/clock_line_p2b.py [截圖資料夾]
沿用 e2e/clock_line.py 的假後端（mock/mock_server.py）與頁內記錄；本機測試用 ?st_only=0|cmp|1 套到每一家店。
假 mini 是頁面路由攔下來的（不連任何正式服務）。名字、資料都是假的。
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as C  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(C.SHOTS, 'p2b')
NOTICE = [{'id': 'n1', 'text': '（測試公告）本週六晚上盤點，請準時打下班卡'}]


def real_status():
    req = urllib.request.Request(C.BASE + '/api/hq', data=json.dumps({'action': 'liff_status', 'id_token': 'MOCK_ID_TOKEN_U1'}).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read().decode())


def open_p2b(ctx, mini_st, st_only, g_delay=0, extra='', wait=True):
    """mini_st：dict＝mini 回的開頁狀態；'abort'＝連不上；'hang'＝一直不回（等到頁面自己的上限）。"""
    S = {'st_hits': [], 't0': time.time()}
    on = {'ok': True, 'v': 1, 'primary': ['hq'], 'wait_ms': 3000}

    def st_h(route):
        S['st_hits'].append(time.time())
        if mini_st == 'abort':
            return route.abort()
        if mini_st == 'hang':
            return   # 不回：頁面 4 秒上限到了自己放棄
        route.fulfill(status=200, body=json.dumps(mini_st), content_type='text/plain')

    p = ctx.new_page()
    p.add_init_script(C.LOG_JS)
    if g_delay:
        p.add_init_script('window.__delay = {liff_status: %d};' % g_delay)
    p.route(C.G_URL + '/config', lambda r: r.fulfill(status=200, body=json.dumps(on), content_type='application/json'))
    p.route(C.G_URL + '/status', st_h)
    q = '&retry_ms=50&g_conf_ms=600&g_api=' + C.G_URL + ('&st_only=' + st_only if st_only is not None else '') + extra
    p.goto(C.url((C.HQ['lat'], C.HQ['lng']), extra=q))
    if wait:
        p.wait_for_function('document.getElementById("who").textContent === "測試一" && document.getElementById("btns").hidden === false', timeout=10000)
        S['ready_s'] = time.time() - S['t0']
    return p, S


def g_status_calls(p):
    return [x for x in C.calls(p) if x['action'] == 'liff_status']


def opens(p):
    return p.evaluate('window.__open || []')


def shot(p, name):
    os.makedirs(OUT, exist_ok=True)
    p.set_viewport_size({'width': 390, 'height': 760})
    p.wait_for_timeout(400)
    f = os.path.join(OUT, name)
    p.screenshot(path=f, full_page=False)
    print('  截圖：' + f)


def main():
    proc = C.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context(viewport={'width': 390, 'height': 760}, device_scale_factor=2)
            errs = []
            # 前提：先在假後端綁定（同 clock_line.py 第 1 步）
            p = C.open_page(ctx, C.url((C.HQ['lat'], C.HQ['lng'])))
            p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
            p.fill('#bindName', '測試一'); p.click('#btnBind')
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            # 假後端（＝Google）發一則公告；假 mini 帶同一則（mini 副本跟 Google 同一份）
            r = p.evaluate("t => fetch('/api/hq', {method:'POST', body: JSON.stringify({action:'mgr_add_notice', mgr_key:'testmgr1', text:t, ends_on:''})}).then(r => r.json())", NOTICE[0]['text'])
            C.ok('P2-B 0：假後端發一則店內公告', r.get('ok') is True, r)
            p.close()
            real = real_status()
            C.ok('P2-B 0：假後端開頁狀態 ready、有那則公告（測試前提）', real.get('status') == 'ready' and [n['text'] for n in real.get('notices', [])] == [NOTICE[0]['text']], real)
            mini_ok = dict(real, role='primary', notices_ok=True)
            mini_old = dict(real, role='primary', notices=[])   # 快速通道還沒換版：沒有 notices_ok

            # ── 1. 開關關（沒設）：跟現在一樣，開頁同時問 mini 與 Google ──
            p, S = open_p2b(ctx, mini_ok, '0', g_delay=2500)   # 正式檔已有店開 cmp：本機用 ?st_only=0 明確測「開關關」（＝瑞光、文心現在的做法）
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            g = g_status_calls(p)
            C.ok('1 開關關：開頁就問了 Google（跟現在一樣）', len(g) >= 1 and g[0]['t'] / 1000 - S['t0'] < 2.0, g)   # 頁內延遲包裝會記兩筆
            o = opens(p)[0]
            C.ok('1 開關關：mini 先回、背景 Google 比對 same、st_only 空', [o.get('st_src'), o.get('st_match'), o.get('st_only')] == ['mini', 'same', ''], o)
            C.ok('1 開關關：公告照常顯示', p.locator('#noticeBox').is_visible(), p.inner_text('#noticeBox'))
            shot(p, '1-開關關-跟現在一樣.png')
            p.close()

            # ── 2. 開關開（true）：mini 回了、公告也帶 → 完全不問 Google；公告照常顯示 ──
            p, S = open_p2b(ctx, mini_ok, '1')
            p.on('pageerror', lambda e: errs.append(str(e)))
            C.ok('2 只問 mini：1.5 秒內畫出開頁狀態（%.2f 秒）' % S['ready_s'], S['ready_s'] < 1.5, S['ready_s'])
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            p.wait_for_timeout(2500)
            C.ok('2 只問 mini：等 2.5 秒也沒有問 Google', len(g_status_calls(p)) == 0, C.calls(p))
            C.ok('2 只問 mini：店內公告由 mini 帶、照常顯示', p.locator('#noticeBox').is_visible() and NOTICE[0]['text'] in p.inner_text('#noticeMsg'), p.inner_text('#noticeBox'))
            o = opens(p)[0]
            C.ok('2 只問 mini：開頁秒數一列 st_src=mini、st_only=1、st_match 空', [o.get('outcome'), o.get('st_src'), o.get('st_only'), o.get('st_match')] == ['ready', 'mini', '1', ''], o)
            C.ok('2 只問 mini：按鍵照防呆（跟 Google 那份一樣的狀態）', p.is_disabled('#btnIn') == (real.get('guard', {}).get('blocked') == 'in'), (p.is_disabled('#btnIn'), real.get('guard')))
            shot(p, '2-開關開-只問mini.png')
            # 按打卡照舊走 mini（不受影響）
            C.force_out(p)
            C.wait_msg(p, '下班打卡成功', timeout=6000)
            C.ok('2 只問 mini：打卡照舊可以打（沒為了開頁多問 Google）', len(g_status_calls(p)) == 0, C.calls(p))
            p.close()

            real = real_status()   # 第 2 步打了一張下班卡：假 mini 也換成最新那份（不然比對會是 diff——那是對的）
            mini_ok = dict(real, role='primary', notices_ok=True)
            mini_old = dict(real, role='primary', notices=[])

            # ── 3. 試跑（"cmp"）：先只問 mini，按鍵亮了之後才在背景問 Google 比對 ──
            p, S = open_p2b(ctx, mini_ok, 'cmp', extra='&st_cmp_ms=800')
            p.on('pageerror', lambda e: errs.append(str(e)))
            t_ready = time.time()
            C.ok('3 試跑：按鍵亮起時還沒問 Google', len(g_status_calls(p)) == 0, C.calls(p))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            g = g_status_calls(p)
            o = opens(p)[0]
            C.ok('3 試跑：之後在背景問了 Google 一次', len(g) == 1, g)
            C.ok('3 試跑：比對結果 same、st_only=cmp', [o.get('st_src'), o.get('st_match'), o.get('st_only')] == ['mini', 'same', 'cmp'], o)
            p.close()

            # ── 4. mini 連不上（開關開）：馬上問 Google，畫面跟現在一樣 ──
            p, S = open_p2b(ctx, 'abort', '1')
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            o = opens(p)[0]
            C.ok('4 mini 連不上：改用 Google 的、按鍵照亮（%.2f 秒）' % S['ready_s'], o.get('st_src') == 'google' and o.get('outcome') == 'ready', o)
            C.ok('4 mini 連不上：沒有等到 mini 先跑的 1.2 秒（連不上就馬上問）', 'h' not in str(o.get('st_only')), o)
            C.ok('4 mini 連不上：畫面沒有錯誤字樣', '連線失敗' not in C.msg(p) and '沒有正常回應' not in C.msg(p), C.msg(p))
            C.ok('4 mini 連不上：公告照常（Google 帶）', p.locator('#noticeBox').is_visible(), p.inner_text('#noticeBox'))
            shot(p, '3-mini問不到-跟現在一樣.png')
            p.close()

            # ── 5. mini 一直不回（開關開）：先跑 1.2 秒後就問 Google（不會等到 4 秒）──
            p, S = open_p2b(ctx, 'hang', '1', extra='&st_hedge_ms=1200')
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            o = opens(p)[0]
            g = g_status_calls(p)
            gdt = (g[0]['t'] / 1000 - S['t0']) if g else None
            C.ok('5 mini 不回：1.2 秒後改問 Google、用 Google 的（st_only=1+h）', o.get('st_src') == 'google' and o.get('st_only') == '1+h', o)
            C.ok('5 mini 不回：開頁 4 秒內畫出（%.2f 秒）' % S['ready_s'], S['ready_s'] < 4, S['ready_s'])
            p.close()

            # ── 6. 快速通道還沒換版（沒帶 notices_ok）：開關開也照現在問 Google 補公告 ──
            p, S = open_p2b(ctx, mini_old, '1', g_delay=600)
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            o = opens(p)[0]
            C.ok('6 mini 沒帶公告：照現在問 Google（比對 same）', len(g_status_calls(p)) >= 1 and o.get('st_src') == 'mini' and o.get('st_match') == 'same', (o, C.calls(p)))
            p.close()

            # ── 7. mini 說沒綁定（開關開）：不採用、照 Google（綁定流程不變）──
            p, S = open_p2b(ctx, {'ok': False, 'error': 'not_bound', 'role': 'primary'}, '1')
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            C.ok('7 mini 沒綁定：照 Google 的', opens(p)[0].get('st_src') == 'google', opens(p)[0])
            p.close()

            C.ok('P2-B：以上各情境頁面沒有程式錯誤', errs == [], errs)
            br.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print('\nP2-B：%d 項通過' % C.n)


if __name__ == '__main__':
    main()
