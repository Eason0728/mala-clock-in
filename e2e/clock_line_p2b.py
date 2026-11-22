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


def open_two(ctx, mini_st, g_st, st_only, extra='', punch_fake=None, g_delay=0):
    """兩邊都用假的（2026-11-23）：mini_st＝mini 回的開頁狀態、g_st＝Google liff_status 回的（物件）；正本名單空＝按打卡直送 Google liff_punch（可用 punch_fake 假回應）。"""
    on = {'ok': True, 'v': 1, 'primary': [], 'wait_ms': 3000}
    hits = []

    def st_h(route):
        hits.append(time.time())
        route.fulfill(status=200, body=json.dumps(mini_st), content_type='text/plain')
    p = ctx.new_page()
    p.add_init_script(C.LOG_JS)
    pre = 'window.__fake.liff_status = %s;' % json.dumps(g_st)
    if punch_fake is not None:
        pre += 'window.__fake.liff_punch = %s;' % json.dumps(punch_fake)
    if g_delay:
        pre += 'window.__delay = {liff_status: %d};' % g_delay   # 只延後開頁那一次（用過就歸零）
    p.add_init_script(pre)
    p.route(C.G_URL + '/config', lambda r: r.fulfill(status=200, body=json.dumps(on), content_type='application/json'))
    p.route(C.G_URL + '/status', st_h)
    p.goto(C.url((C.HQ['lat'], C.HQ['lng']), extra='&retry_ms=50&g_conf_ms=600&g_api=' + C.G_URL + '&st_only=' + st_only + extra))
    p.wait_for_function('document.getElementById("who").textContent === "測試一" && document.getElementById("btns").hidden === false', timeout=10000)
    return p, hits


def two_states(real):
    """新（Google 有、mini 還沒拉到）：最後一張下班卡、上班鍵亮；舊：最後一張上班卡（較早）、下班鍵亮。鎖都過期。"""
    new = json.loads(json.dumps(real)); new.setdefault('guard', {})['lock'] = {}
    new['guard']['blocked'] = 'out'; new['guard']['last'] = {'type': 'out', 'hm': '18:00', 'ts': '2099-01-01T18:00:00+08:00'}
    new['today'] = [{'type': 'in', 'hm': '09:00', 'status': 'ok'}, {'type': 'out', 'hm': '18:00', 'status': 'ok'}]
    old = json.loads(json.dumps(new)); old['guard']['blocked'] = 'in'; old['guard']['last'] = {'type': 'in', 'hm': '09:00', 'ts': '2099-01-01T09:00:00+08:00'}
    old['today'] = [{'type': 'in', 'hm': '09:00', 'status': 'ok'}]
    mk = lambda s: dict(s, role='primary', notices_ok=True)
    return new, old, mk(new), mk(old)


def btns(p):
    return (p.is_disabled('#btnIn'), p.is_disabled('#btnOut'))


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

            # ── 8–11（2026-11-23 驗收補）：Google 較新的校正、量法、被拒後訊息 ──
            G_NEW, G_OLD, M_NEW, M_OLD = two_states(real_status())
            REJ = {'ok': False, 'type': 'out', 'status': 'guard', 'reason': '（測試）後端擋下', 'hint': '（測試）怎麼辦'}
            # 8. cmp：mini 舊、Google 新 → 約 0.8 秒後改用 Google 的（上班亮、下班灰）；比對記 diff_mold
            p, _ = open_two(ctx, M_OLD, G_NEW, 'cmp', extra='&st_cmp_ms=800')
            p.on('pageerror', lambda e: errs.append(str(e)))
            b0 = btns(p)
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            o = opens(p)[0]
            C.ok('8 cmp mini 舊 Google 新：先照 mini（上班灰、下班亮）', b0 == (True, False), b0)
            C.ok('8 cmp mini 舊 Google 新：之後改用 Google 的（上班亮、下班灰）', btns(p) == (False, True), btns(p))
            C.ok('8 cmp mini 舊 Google 新：比對 diff、status 標 mini 較舊', [o.get('st_match'), o.get('status')] == ['diff', 'diff_mold_mi_go'], o)
            p.close()
            # 9. cmp：mini 新、Google 舊 → 一直用 mini 的；比對記 diff_gold
            p, _ = open_two(ctx, M_NEW, G_OLD, 'cmp', extra='&st_cmp_ms=800')
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            p.wait_for_timeout(500)
            o = opens(p)[0]
            C.ok('9 cmp mini 新 Google 舊：用 mini 的（上班亮、下班灰）', btns(p) == (False, True), btns(p))
            C.ok('9 cmp mini 新 Google 舊：比對 diff、status 標 Google 較舊', [o.get('st_match'), o.get('status')] == ['diff', 'diff_gold_mo_gi'], o)
            p.close()
            # 10. 量法：同仁在 Google 回來之前就按了打卡 → 不記 same／diff，status 標 cmp_late（三種模式一致；這裡用 cmp 與 0）
            for mode in ('cmp', '0'):
                p, _ = open_two(ctx, M_OLD, G_NEW, mode, extra='&st_cmp_ms=1500', punch_fake=REJ, g_delay=(2500 if mode == '0' else 0))   # 開關關：開頁那次 Google 晚回來
                p.on('pageerror', lambda e: errs.append(str(e)))
                C.force_out(p)
                p.wait_for_function('(window.__open || []).length >= 1', timeout=10000)
                o = opens(p)[0]
                C.ok('10 量法（%s）：按了打卡之後才回來的比對不記 same／diff、標 cmp_late' % mode, [o.get('st_match'), o.get('status')] == ['', 'cmp_late'], o)
                p.close()
            # 11. cmp：開頁照 mini（舊）、按下班被後端擋 → 重讀後 Google 較新把畫面校正，失敗原因要留著（跟開關關一樣）
            for mode in ('cmp', '0'):
                p, _ = open_two(ctx, M_OLD, G_NEW, mode, extra='&st_cmp_ms=1500', punch_fake=REJ, g_delay=(1500 if mode == '0' else 0))   # 開關關：開頁那次 mini 先回
                p.on('pageerror', lambda e: errs.append(str(e)))
                C.force_out(p)
                C.wait_msg(p, '（測試）後端擋下', timeout=8000)
                p.wait_for_timeout(3500)
                C.ok('11 被擋後重讀（%s）：失敗原因還在' % mode, '（測試）後端擋下' in C.msg(p) and '（測試）怎麼辦' in C.msg(p), C.msg(p))
                C.ok('11 被擋後重讀（%s）：按鍵照 Google 較新的（上班亮、下班灰）' % mode, btns(p) == (False, True), btns(p))
                p.close()

            # 12. 開關關：mini 先回、Google 慢回、Google 較新 → 先照 mini、Google 回來後改用 Google 的（瑞光、文心走這條，原本沒有測試保護）
            p, _ = open_two(ctx, M_OLD, G_NEW, '0', g_delay=1500)   # g_delay：開頁那次 Google 晚 1.5 秒回來（mini 先回）
            p.on('pageerror', lambda e: errs.append(str(e)))
            b0 = btns(p)
            C.ok('12 開關關 mini 先 Google 慢且較新：先照 mini（上班灰、下班亮）', b0 == (True, False), b0)
            p.wait_for_function('(window.__open || []).length >= 1', timeout=10000)
            o = opens(p)[0]
            C.ok('12 開關關：開頁狀態先用的是 mini', o.get('st_src') == 'mini', o)
            C.ok('12 開關關 Google 較新：畫面最後以 Google 為準（上班亮、下班灰）', btns(p) == (False, True), btns(p))
            C.ok('12 開關關 Google 較新：比對 diff、status 標 mini 較舊', [o.get('st_match'), o.get('status')] == ['diff', 'diff_mold_mi_go'], o)
            p.close()

            # 13–15. diff_g_reject（Google 明確說「這個人現在不能在這家店打卡」）只在「開頁第一次、同仁還沒動手、沒重讀」時才記成開頁樣本
            G_REJ = {'ok': False, 'error': 'not_bound'}
            # 13. 開頁第一次：照記 diff_g_reject，按鍵照舊收回
            p, _ = open_two(ctx, M_OLD, G_REJ, 'cmp', extra='&st_cmp_ms=800')
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
            o = opens(p)[0]
            C.ok('13 Google 說不能打卡（開頁第一次）：比對 diff、status＝diff_g_reject', [o.get('st_match'), o.get('status')] == ['diff', 'diff_g_reject'], o)
            p.wait_for_timeout(500)
            C.ok('13 Google 說不能打卡（開頁第一次）：兩顆鍵都收回', btns(p) == (True, True), btns(p))
            p.close()
            # 14. 同仁按了打卡（卡住不回）之後 Google 才說不能打卡：不記成開頁樣本、標 cmp_late
            p, _ = open_two(ctx, M_OLD, G_REJ, 'cmp', extra='&st_cmp_ms=1500', punch_fake='hang')
            p.on('pageerror', lambda e: errs.append(str(e)))
            C.force_out(p)
            p.wait_for_function('(window.__open || []).length >= 1', timeout=10000)
            o = opens(p)[0]
            C.ok('14 按了打卡之後 Google 才說不能打卡：不記 diff_g_reject、標 cmp_late', [o.get('st_match'), o.get('status')] == ['', 'cmp_late'], o)
            p.close()
            # 15. 按打卡被擋、重讀之後 Google 才說不能打卡：重讀那次不記成開頁樣本、標 cmp_late
            #     （開頁那次的 Google 不回；重讀那次的 Google 說不能打卡，它的回報先送出）
            p, _ = open_two(ctx, M_OLD, ['hang', G_REJ], 'cmp', extra='&st_cmp_ms=800', punch_fake=REJ)
            p.on('pageerror', lambda e: errs.append(str(e)))
            C.force_out(p)
            p.wait_for_function('(window.__open || []).length >= 1', timeout=12000)
            o = opens(p)[0]
            C.ok('15 重讀之後 Google 才說不能打卡：不記 diff_g_reject、標 cmp_late', [o.get('st_match'), o.get('status')] == ['', 'cmp_late'], o)
            p.close()

            C.ok('P2-B：以上各情境頁面沒有程式錯誤', errs == [], errs)
            br.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print('\nP2-B：%d 項通過' % C.n)


if __name__ == '__main__':
    main()
