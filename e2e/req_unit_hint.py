#!/usr/bin/env python3
"""LINE 申請頁頁首「申請單位」下拉提示（2026-11-27）端對端，WebKit、手機寬 390px。

驗收：
  - 綁兩家以上：下拉前有「申請單位：」；下拉是 appearance:none＋背景箭頭、框線 2px；
  - 名單含 hq 且目前選的不是 hq：下方一行「點上方單位可切換到 <hq 的店名>」；選了 hq 之後這行消失；
  - 兩家不含 hq：沒有那一行，但仍有「申請單位：」；
  - 只有一家：整個 #reqView 的 HTML 與改前（E2E_BASE_JS＝origin/main 的 req-line.js）逐字相同。

用法：E2E_BASE_JS=<改前 req-line.js> E2E_MOCK_PORT=8971 E2E_SHOTS=<截圖資料夾> /usr/bin/python3 e2e/req_unit_hint.py
後端用 page.route 假裝（沿用 req_seg2.Fake），截圖只用假名「林小美」。"""
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402
import req_seg2 as RS  # noqa: E402

ok = CL.ok
HQ, JS = CL.HQ, CL.JS
SHOTS = os.environ.get('E2E_SHOTS', '')
BASE_JS = os.environ.get('E2E_BASE_JS', '')
OLD_JS = open(BASE_JS, encoding='utf-8').read() if BASE_JS else None
GF = {'code': '', 'name': '小辛辣 新竹光復', 'emp_id': 'E1', 'emp_name': '林小美'}
S_JS = {'code': 'mztjs', 'name': JS['name'], 'emp_id': 'E1', 'emp_name': '林小美'}
S_HQ = {'code': 'hq', 'name': HQ['name'], 'emp_id': 'E1', 'emp_name': '林小美'}
HINT = '點上方單位可切換到 ' + HQ['name']


def shot(p, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        p.screenshot(path=os.path.join(SHOTS, name + '.png'), clip={'x': 0, 'y': 0, 'width': 390, 'height': 230})


def open_wk(br, stores, js=None):
    return RS.open_req(br, RS.Fake(stores=stores), 'ot', js=js)


def main():
    proc = CL.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.webkit.launch()

            # 1. 兩家含 hq（預設選第一家＝非 hq）
            p = open_wk(br, [GF, S_HQ])
            t = RS.txt(p)
            ok('兩家含 hq：下拉前有「申請單位：」', p.locator('#reqView .rq-head .rq-store-lbl').inner_text() == '申請單位：')
            ok('兩家含 hq：下拉下方有提示（用名單裡 hq 的店名）', p.locator('#reqView .rq-store-hint').count() == 1 and p.locator('#reqView .rq-store-hint').inner_text() == HINT, t[:80])
            ok('提示在頁首之後、分頁鈕之前', p.evaluate("() => { const h = document.querySelector('#reqView .rq-store-hint'); return h.previousElementSibling.classList.contains('rq-head') && h.nextElementSibling.classList.contains('rq-tabs'); }"))
            cs = p.evaluate("() => { const s = getComputedStyle(document.querySelector('#reqView select.rq-store')); return [s.webkitAppearance || s.appearance, s.borderTopWidth, s.backgroundImage.slice(0, 20)]; }")
            ok('下拉：appearance:none、框線 2px、有背景箭頭', cs[0] == 'none' and cs[1] == '2px' and cs[2].startswith('url('), cs)
            ok('頁首沒有橫向溢出', p.evaluate("() => document.documentElement.scrollWidth <= 390"))
            shot(p, '1-兩家含總部（預設光復）')
            p.select_option('#reqView select.rq-store', '1')
            p.wait_for_selector('#reqView .rq-store-hint', state='detached', timeout=8000)
            ok('選了 hq 之後提示消失、仍有「申請單位：」', p.locator('#reqView .rq-store-hint').count() == 0 and p.locator('#reqView .rq-store-lbl').count() == 1)
            shot(p, '1b-兩家含總部（已選總部）')

            # 2. 兩家不含 hq
            p = open_wk(br, [GF, S_JS])
            ok('兩家不含 hq：沒有提示、有「申請單位：」', p.locator('#reqView .rq-store-hint').count() == 0 and p.locator('#reqView .rq-store-lbl').count() == 1)
            shot(p, '2-兩家不含總部')

            # 3. 只有一家：與改前逐字相同
            p = open_wk(br, [S_HQ])
            new_html = p.inner_html('#reqView')
            ok('只有一家：沒有標籤、沒有提示、沒有下拉', p.locator('#reqView .rq-store-lbl, #reqView .rq-store-hint, #reqView select.rq-store').count() == 0)
            shot(p, '3-只有一家')
            if OLD_JS is not None:
                po = open_wk(br, [S_HQ], js=OLD_JS)
                ok('只有一家：整個 #reqView 的 HTML 與改前（origin/main）逐字相同', po.inner_html('#reqView') == new_html)
                ok('只有一家：頁首 .rq-head 與改前相同', po.inner_html('#reqView .rq-head') == p.inner_html('#reqView .rq-head'))
            br.close()
    finally:
        proc.terminate()
    print('PASS', CL.n)


if __name__ == '__main__':
    main()
