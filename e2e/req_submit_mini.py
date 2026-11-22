#!/usr/bin/env python3
"""LINE 申請「送出／取消先送 Mac mini」（SUBMIT_MINI）瀏覽器端對端（2026-11-23）。

開關預設是 false，這裡用網址參數 ?submit_mini=1（只在 localhost 有效）打開，不改預設值。
重點：營運系統的回應一律包一層 { ok:true, data:<line-req 的回傳> }（mala-store-ops server/index.js:411、server/proxy/duty.js:2392–2458），
假 mini（page.route 攔 http://mini.test/store/api/line-req）照這個真形狀回；以前 sendReq 沒拆這一層，mini 收下了手機還是再送 Google 一次。
每個情境都數「mini 收到幾次送出／取消」與「Google（假後端 /api）收到幾次 req_submit／req_cancel」。

用法：E2E_MOCK_PORT=8967 /usr/bin/python3 e2e/req_submit_mini.py     （手機寬 390px；後端用 page.route 在瀏覽器外假裝，不碰正式、不打任何外部網址）
假 mini 的回法跟 phase_req_mini（clock_line.py）一樣放在頁面外，Google 一側沿用 req_seg2.py 的 Fake。"""
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402
import req_seg2 as R2  # noqa: E402

ok = CL.ok
HQ = CL.HQ
MINI_URL = 'http://mini.test/store/api/line-req'
CORS = {'access-control-allow-origin': '*'}
SYNC_MSG = '資料還在更新，請稍後再試一次'
RESULT_ROWS = []   # (情境, mini 送出/取消次數, Google 送出/取消次數)，最後印表


class Mini:
    """假 Mac mini：照營運系統真形狀回。mode：taken｜off｜shadow｜busy｜syncing｜timeout｜html｜abort｜err500｜disabled。
    收下時 data 用假 Google 後端同一份算法（Fake.submit／取消）算，所以畫面看到的摘要跟直送 Google 一樣。"""

    def __init__(self, fake, mode):
        self.fake = fake
        self.mode = mode
        self.hits = []        # 全部打到 mini 的內容（含計時、shadow_note）
        self.hold = []        # 逾時情境：故意不回的請求

    def ops(self, *names):
        return [h for h in self.hits if h.get('op') in names]

    def release_late(self):
        """逾時情境：mini 的收下回應「晚到」。手機等滿 3 秒就中止那筆請求，瀏覽器通常已不收；放行是盡量模擬，丟錯就算了。"""
        late = {'ok': True, 'data': {'ok': True, 'src': 'mini', 'data': {'ok': True, 'summary': '晚到的回應', 'request': {'id': 'LATE'}}}}
        for r in self.hold:
            try:
                r.fulfill(status=200, content_type='application/json', headers=CORS, body=json.dumps(late, ensure_ascii=False))
            except Exception:
                pass
        self.hold = []

    def handler(self, route):
        req = route.request
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=dict(CORS, **{'access-control-allow-headers': '*'}))
        try:
            b = json.loads(req.post_data or '{}')
        except Exception:
            b = {}
        self.hits.append(b)
        op = b.get('op')
        J = lambda x, status=200: route.fulfill(status=status, content_type='application/json', headers=CORS, body=json.dumps(x, ensure_ascii=False))
        if op not in ('submit', 'cancel'):
            return J({'ok': True, 'data': {'ok': True}})      # 開頁計時、shadow_note 之類：只記下來
        m = self.mode
        if m == 'timeout':
            self.hold.append(route)    # 不回：手機等滿 3 秒就放棄
            return
        if m == 'abort':
            return route.abort()
        if m == 'html':
            return route.fulfill(status=502, content_type='text/html', headers=CORS, body='<html>Bad Gateway</html>')
        if m == 'err500':
            return J({'ok': False, 'error': 'SERVER_ERROR', 'message': '系統發生錯誤，請稍後再試'}, 500)
        if m == 'off':
            return J({'ok': True, 'data': {'ok': False, 'error': 'mini_off'}})
        if m == 'shadow':
            return J({'ok': True, 'data': {'ok': False, 'error': 'mini_off', 'shadow': True}})
        if m == 'busy':
            return J({'ok': True, 'data': {'ok': False, 'error': 'mini_busy'}})
        if m == 'disabled':
            return J({'ok': True, 'data': {'ok': False, 'error': 'off'}})
        if m == 'syncing':
            return J({'ok': True, 'data': {'ok': True, 'src': 'mini', 'data': {'ok': False, 'error': 'mini_syncing', 'message': SYNC_MSG}}})
        if m == 'dup':    # 兩個同單號請求幾乎同時進來、第二個在交易裡才撞到：{ ok:true, dup:true }，沒有 summary／request（duty.js:2437）
            return J({'ok': True, 'data': {'ok': True, 'src': 'mini', 'data': {'ok': True, 'dup': True}}})
        # taken：mini 收下，內容是「同 Google 回應」
        if op == 'submit':
            res = self.fake.submit(dict(b['body'], action='req_submit'))
        else:
            for r in self.fake.requests:
                if r['id'] == b['body'].get('id'):
                    r['status'] = 'cancelled'
            res = {'ok': True}
        return J({'ok': True, 'data': {'ok': True, 'src': 'mini', 'data': res}})


def flag_source(value):
    """req-line.js 內容，把 SUBMIT_MINI 明確設成 true／false（開關關的情境不靠檔案裡的預設值，疊在別的 PR 上也要照樣跑）。"""
    code = open(os.path.join(CL.ROOT, 'req-line.js'), encoding='utf-8').read()
    new, n = re.subn(r'var SUBMIT_MINI = (true|false);', 'var SUBMIT_MINI = %s;' % ('true' if value else 'false'), code)
    assert n == 1, '找不到 var SUBMIT_MINI'
    return new


def open_page(br, fake, mini, tab, extra='&submit_mini=1', flag=None):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    p = ctx.new_page()
    p.add_init_script(CL.LOG_JS)
    p.route('**/api', fake.handler)
    p.route('**/api/*', fake.handler)
    p.route('http://mini.test/**', mini.handler)
    if flag is not None:
        js = flag_source(flag)
        p.route('**/req-line.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=js))
    p.add_init_script("window.confirm = function () { return true; };")
    p.goto(CL.url((HQ['lat'], HQ['lng']), in_client=True, extra='&view=req&tab=%s&mini_req=%s%s' % (tab, MINI_URL, extra)))
    p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
    p.wait_for_function("window.__calls.some(c => c.action === 'req_info')", timeout=10000)
    p.wait_for_timeout(500)
    return p


def gcount(fake, action):
    return len([c for c in fake.calls if c['action'] == action])


def seed_pending(fake):
    """先在假 Google 後端放一張審核中的加班單（取消情境用）；回它的 id。"""
    r = fake.submit({'kind': 'ot', 'date': R2.TODAY, 'segments': None, 'start': '18:00', 'end': '20:00', 'reason': '先放一張', 'action': 'req_submit'})
    return r['request']['id']


def do_submit(p):
    R2.fill_ot(p, '11:00', '14:00', '假日來客多')
    R2.submit(p)


def run_submit(br, mode, extra='&submit_mini=1', flag=None):
    f = R2.Fake()
    m = Mini(f, mode)
    p = open_page(br, f, m, 'ot', extra, flag)
    do_submit(p)
    return f, m, p


def settle(p, want_text, timeout=9000):
    p.wait_for_function("t => document.getElementById('reqView').textContent.indexOf(t) >= 0", arg=want_text, timeout=timeout)


def main():
    os.makedirs(CL.SHOTS, exist_ok=True)
    proc = CL.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()

            # ── 1. 送出：mini 收下 → Google 0 次 ──
            f, m, p = run_submit(br, 'taken')
            R2.wait_mine(p)
            t = R2.txt(p)
            ok('送出・mini 收下：畫面顯示「✓ 已送出」', '✓ 已送出：' in t and '加班 11:00–14:00' in t, t[:200])
            ok('送出・mini 收下：mini 收到 1 次 submit、Google 收到 0 次 req_submit', len(m.ops('submit')) == 1 and gcount(f, 'req_submit') == 0, (len(m.ops('submit')), gcount(f, 'req_submit')))
            ok('送出・mini 收下：送 mini 的內容是 { op, url, id_token, req_id, body }（body 沒有 action／id_token）',
               sorted(m.ops('submit')[0].keys()) == ['body', 'id_token', 'op', 'req_id', 'url'] and 'action' not in m.ops('submit')[0]['body'] and 'id_token' not in m.ops('submit')[0]['body'], m.ops('submit')[0])
            ok('送出・mini 收下：單號是 r＋16 碼十六進位', re.fullmatch(r'r[0-9a-f]{16}', m.ops('submit')[0]['req_id']) is not None)
            ok('送出・mini 收下：沒有送 shadow_note', len(m.ops('shadow_note')) == 0)
            RESULT_ROWS.append(('送出・mini 收下', len(m.ops('submit')), gcount(f, 'req_submit')))
            p.context.close()

            # ── 2. 送出：mini_off（該店不是 mini 模式）→ 改送 Google 1 次、同單號 ──
            f, m, p = run_submit(br, 'off')
            R2.wait_mine(p)
            t = R2.txt(p)
            gs = f.submits()
            ok('送出・mini_off：改送 Google 後畫面顯示「✓ 已送出」', '✓ 已送出：' in t and '加班 11:00–14:00' in t, t[:200])
            ok('送出・mini_off：mini 1 次、Google 1 次 req_submit', len(m.ops('submit')) == 1 and len(gs) == 1, (len(m.ops('submit')), len(gs)))
            ok('送出・mini_off：Google 的 body 帶同一個 req_id（同單號只寫一次）', gs[0]['body'].get('req_id') == m.ops('submit')[0]['req_id'], (gs[0]['body'], m.ops('submit')[0]['req_id']))
            ok('送出・mini_off：沒帶 shadow:true 就不送 shadow_note', len(m.ops('shadow_note')) == 0)
            RESULT_ROWS.append(('送出・mini_off', len(m.ops('submit')), len(gs)))
            p.context.close()

            # ── 3. 取消：mini 說資料還在更新 → 顯示那句話、Google 0 次 ──
            f = R2.Fake()
            seed_pending(f)
            m = Mini(f, 'syncing')
            p = open_page(br, f, m, 'mine')
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').first.click()
            settle(p, SYNC_MSG)
            ok('取消・資料還在更新：畫面顯示「資料還在更新，請稍後再試一次」', SYNC_MSG in R2.txt(p), R2.txt(p)[:200])
            p.wait_for_timeout(500)
            ok('取消・資料還在更新：mini 1 次 cancel、Google 0 次 req_cancel（不能搶在主管那筆前面）', len(m.ops('cancel')) == 1 and gcount(f, 'req_cancel') == 0, (len(m.ops('cancel')), gcount(f, 'req_cancel')))
            ok('取消・資料還在更新：單還是審核中（沒被取消）', f.requests[0]['status'] == 'pending')
            RESULT_ROWS.append(('取消・資料還在更新', len(m.ops('cancel')), gcount(f, 'req_cancel')))
            p.context.close()

            # ── 3b. 取消：mini 收下 → Google 0 次 ──
            f = R2.Fake()
            seed_pending(f)
            m = Mini(f, 'taken')
            p = open_page(br, f, m, 'mine')
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').first.click()
            p.wait_for_timeout(1200)
            ok('取消・mini 收下：mini 1 次 cancel、Google 0 次 req_cancel', len(m.ops('cancel')) == 1 and gcount(f, 'req_cancel') == 0, (len(m.ops('cancel')), gcount(f, 'req_cancel')))
            ok('取消・mini 收下：清單變成已取消', '已取消' in R2.txt(p), R2.txt(p)[:300])
            RESULT_ROWS.append(('取消・mini 收下', len(m.ops('cancel')), gcount(f, 'req_cancel')))
            p.context.close()

            # ── 4. 送出：mini 逾時（3 秒沒回）→ 改送 Google 1 次、同單號 ──
            t0 = time.time()
            f, m, p = run_submit(br, 'timeout')
            R2.wait_mine(p)
            dt = time.time() - t0
            gs = f.submits()
            ok('送出・mini 逾時：約 3 秒後改送 Google，畫面「✓ 已送出」（耗時 %.1f 秒）' % dt, '✓ 已送出：' in R2.txt(p) and 2.8 <= dt < 8, dt)
            ok('送出・mini 逾時：mini 1 次、Google 1 次 req_submit、同一個 req_id', len(m.ops('submit')) == 1 and len(gs) == 1 and gs[0]['body'].get('req_id') == m.ops('submit')[0]['req_id'], (len(m.ops('submit')), len(gs)))
            RESULT_ROWS.append(('送出・mini 逾時（%.1f 秒）' % dt, len(m.ops('submit')), len(gs)))
            # 改送 Google 之後才放行 mini 的收下回應：畫面不變、聊天不再多一則、不再多任何請求
            before = (R2.txt(p), p.evaluate('window.__sent || []'), len(f.calls), len(m.hits), len(f.requests))
            m.release_late()
            p.wait_for_timeout(1000)
            after = (R2.txt(p), p.evaluate('window.__sent || []'), len(f.calls), len(m.hits), len(f.requests))
            ok('送出・逾時後 mini 才回收下：畫面完全不變（沒有被「晚到的回應」改掉）', before[0] == after[0] and '晚到的回應' not in after[0], (before[0][:120], after[0][:120]))
            ok('送出・逾時後 mini 才回收下：LINE 聊天只有 1 則「申請已送出：…」（tellChat 只呼叫一次）', len(after[1]) == 1 and after[1][0]['text'].startswith('申請已送出：') and '晚到' not in after[1][0]['text'], after[1])
            ok('送出・逾時後 mini 才回收下：之後沒有任何新請求（Google 仍只 1 次 req_submit、mini 仍 1 次）', after[2] == before[2] and after[3] == before[3] and len(f.submits()) == 1 and after[4] == before[4], (before[2:], after[2:]))
            p.context.close()

            # ── 5. 其他：mini_busy、影子、功能關掉、伺服器錯誤 500、非 JSON、連不上 → 一律改送 Google 1 次 ──
            for mode, label in (('busy', 'mini_busy'), ('shadow', '影子店（mini_off＋shadow）'), ('disabled', 'LINE 申請功能關掉（off）'),
                                ('err500', '伺服器錯誤 500'), ('html', '回應不是 JSON（502）'), ('abort', '連不上')):
                f, m, p = run_submit(br, mode)
                R2.wait_mine(p)
                gs = f.submits()
                ok('送出・%s：改送 Google 1 次、同一個 req_id、畫面「✓ 已送出」' % label,
                   '✓ 已送出：' in R2.txt(p) and len(m.ops('submit')) == 1 and len(gs) == 1 and gs[0]['body'].get('req_id') == m.ops('submit')[0]['req_id'], (len(m.ops('submit')), len(gs)))
                if mode == 'shadow':
                    p.wait_for_timeout(500)
                    ok('送出・影子店：Google 回來後送 1 筆 shadow_note（g 只有 ok／error／message）',
                       len(m.ops('shadow_note')) == 1 and sorted(m.ops('shadow_note')[0]['g'].keys()) == ['error', 'message', 'ok'] and 'id_token' not in m.ops('shadow_note')[0] and sorted(m.ops('shadow_note')[0].keys()) == ['g', 'op', 'req_id', 'url'], m.ops('shadow_note'))
                else:
                    ok('送出・%s：沒有送 shadow_note' % label, len(m.ops('shadow_note')) == 0)
                RESULT_ROWS.append(('送出・' + label, len(m.ops('submit')), len(gs)))
                p.context.close()

            # ── 6. 開關關著（沒帶 ?submit_mini=1）：行為跟改動前一樣，完全不碰 mini 的送出，只送 Google 1 次、body 沒有 req_id ──
            f, m, p = run_submit(br, 'taken', extra='', flag=False)
            R2.wait_mine(p)
            gs = f.submits()
            ok('開關關（明確指定 false）・送出：mini 收到 0 次 submit、Google 1 次、body 沒有 req_id', len(m.ops('submit')) == 0 and len(gs) == 1 and 'req_id' not in gs[0]['body'], (len(m.ops('submit')), gs))
            want = {'kind': 'ot', 'date': R2.TODAY, 'start': '11:00', 'end': '14:00', 'reason': '假日來客多', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}
            ok('開關關（明確指定 false）・送出：給 Google 的內容只有原本那些欄位', gs[0]['body'] == want, gs[0]['body'])
            RESULT_ROWS.append(('開關關・送出', len(m.ops('submit')), len(gs)))
            p.context.close()
            f = R2.Fake()
            seed_pending(f)
            m = Mini(f, 'taken')
            p = open_page(br, f, m, 'mine', extra='', flag=False)
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').first.click()
            p.wait_for_function("document.getElementById('reqView').textContent.indexOf('已取消') >= 0", timeout=8000)
            cc = [c for c in f.calls if c['action'] == 'req_cancel']
            ok('開關關（明確指定 false）・取消：mini 收到 0 次 cancel、Google 1 次 req_cancel、body 沒有 req_id', len(m.ops('cancel')) == 0 and len(cc) == 1 and 'req_id' not in cc[0]['body'], (len(m.ops('cancel')), cc))
            RESULT_ROWS.append(('開關關・取消', len(m.ops('cancel')), len(cc)))
            p.context.close()

            # ── 7. mini 說同單號已收過（dup、沒有 summary）→ 當成功；畫面與 LINE 聊天都只有「已送出」、不出現 undefined；Google 0 次 ──
            f, m, p = run_submit(br, 'dup')
            R2.wait_mine(p)
            t = R2.txt(p)
            sent = p.evaluate('window.__sent || []')
            ok('送出・dup 沒有 summary：畫面「✓ 已送出」、沒有 undefined、沒有冒號後面那段', '✓ 已送出' in t and 'undefined' not in t and '✓ 已送出：' not in t, t[:200])
            ok('送出・dup 沒有 summary：LINE 聊天只送「申請已送出」、沒有 undefined', [x.get('text') for x in sent] == ['申請已送出'], sent)
            ok('送出・dup：mini 1 次、Google 0 次', len(m.ops('submit')) == 1 and gcount(f, 'req_submit') == 0, (len(m.ops('submit')), gcount(f, 'req_submit')))
            RESULT_ROWS.append(('送出・dup（沒有 summary）', len(m.ops('submit')), gcount(f, 'req_submit')))
            p.context.close()
            # 有 summary 的一般收下：聊天與畫面字串跟以前一樣（有冒號＋摘要）
            f, m, p = run_submit(br, 'taken')
            R2.wait_mine(p)
            sent = p.evaluate('window.__sent || []')
            ok('送出・一般收下（有 summary）：聊天「申請已送出：…」、畫面「✓ 已送出：…」跟以前一樣', len(sent) == 1 and sent[0]['text'].startswith('申請已送出：') and '✓ 已送出：' in R2.txt(p), sent)
            p.context.close()

            # ── 9. mini 等待期間連按送出：只送一次（mini 1 次；3 秒後 Google 1 次），成功只顯示一次 ──
            f, m, p = run_submit(br, 'timeout')
            for _ in range(3):
                p.wait_for_timeout(400)
                p.evaluate("document.querySelectorAll('#reqView button.primary').forEach(b => b.click())")
            p.evaluate("document.querySelectorAll('#reqView button.primary').forEach(b => { b.disabled = false; b.click(); })")   # 就算按鈕沒擋，程式裡的忙碌旗標也要擋下
            R2.wait_mine(p)
            p.wait_for_timeout(800)
            sent = p.evaluate('window.__sent || []')
            ok('送出・mini 等待中連按送出：mini 只收 1 次 submit、Google 只收 1 次 req_submit、同一個 req_id', len(m.ops('submit')) == 1 and len(f.submits()) == 1 and f.submits()[0]['body'].get('req_id') == m.ops('submit')[0]['req_id'], (len(m.ops('submit')), len(f.submits())))
            ok('送出・mini 等待中連按送出：成功只顯示一次、聊天只 1 則、我的申請只有 1 張新單', R2.txt(p).count('✓ 已送出') == 1 and len(sent) == 1 and len(f.requests) == 1, (R2.txt(p)[:200], sent, len(f.requests)))
            RESULT_ROWS.append(('送出・等待中連按', len(m.ops('submit')), len(f.submits())))
            m.release_late()
            p.context.close()

            # ── 10. 取消：mini 逾時改送 Google（只 1 次），等待中對同一筆連按取消都被擋 ──
            f = R2.Fake()
            seed_pending(f)
            m = Mini(f, 'timeout')
            p = open_page(br, f, m, 'mine')
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').first.click()
            p.wait_for_selector('#reqView .rq-link:has-text("取消中…")', timeout=3000)
            for _ in range(3):
                p.wait_for_timeout(400)
                p.evaluate("document.querySelectorAll('#reqView .rq-link').forEach(b => { b.disabled = false; b.click(); })")   # 取消中還去按：旗標要擋下
            p.wait_for_function("document.getElementById('reqView').textContent.indexOf('已取消') >= 0", timeout=9000)
            p.wait_for_timeout(500)
            cc = [c for c in f.calls if c['action'] == 'req_cancel']
            ok('取消・mini 逾時：約 3 秒後改送 Google，只 1 次 req_cancel（body 沒有 req_id）；mini 只收 1 次 cancel', len(cc) == 1 and 'req_id' not in cc[0]['body'] and len(m.ops('cancel')) == 1, (len(cc), len(m.ops('cancel'))))
            ok('取消・mini 逾時：清單變成已取消、單的狀態是 cancelled', '已取消' in R2.txt(p) and f.requests[0]['status'] == 'cancelled', R2.txt(p)[:200])
            RESULT_ROWS.append(('取消・逾時＋等待中連按', len(m.ops('cancel')), len(cc)))
            m.release_late()
            p.wait_for_timeout(600)
            ok('取消・逾時後 mini 才回：之後沒有新請求（Google 仍 1 次 req_cancel）', len([c for c in f.calls if c['action'] == 'req_cancel']) == 1 and len(m.ops('cancel')) == 1)
            p.context.close()

            # ── 11. 預設值是開（#220）：不帶 ?submit_mini、不換頁面來源，送出照樣先送 mini；收下 → Google 0 次 ──
            f, m, p = run_submit(br, 'taken', extra='')
            R2.wait_mine(p)
            ok('預設值是開・送出：不帶網址參數也先送 mini；mini 1 次、Google 0 次、畫面「✓ 已送出」', len(m.ops('submit')) == 1 and gcount(f, 'req_submit') == 0 and '✓ 已送出：' in R2.txt(p), (len(m.ops('submit')), gcount(f, 'req_submit')))
            RESULT_ROWS.append(('預設值是開・送出', len(m.ops('submit')), gcount(f, 'req_submit')))
            p.context.close()

            br.close()
        print('\n情境                            mini(送出/取消)  Google(req_submit/req_cancel)')
        for name, a, b in RESULT_ROWS:
            print('  %-28s %d                %d' % (name, a, b))
        print('\n全部通過：%d 項' % CL.n)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
