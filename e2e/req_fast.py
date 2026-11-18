#!/usr/bin/env python3
"""LINE 申請頁「送出、取消立即回饋」端對端（2026-11-18）：送出／取消成功後先畫結果、背景重讀 req_info。

重點驗收（假後端可設定每種請求的延遲，page 端包一層 fetch 延遲；延遲算在「請求送到假後端之前」，req_info 回的是延遲結束那刻的伺服器資料）：
  - req_info 延遲 4 秒：送出成功後 1 秒內畫面已切到「我的申請」、有新列與「✓ 已送出」；延遲期間送出鈕不可按；背景重讀完成後以伺服器資料為準。
  - 取消：按下確認 0.5 秒內出現「取消中…」；成功後該列立刻變已取消（不等 req_info），兩段同組時另一張立刻變回一般樣子。
  - 一段、兩段各測；重讀失敗、送出失敗、取消失敗各一例；連點送出只送一次。
  - 另外量「改前」（E2E_BASE_JS 或 git show origin/main:req-line.js）同樣操作的毫秒數，印在最後。

用法：/usr/bin/python3 e2e/req_fast.py     （手機寬 390px；E2E_SHOTS 指定截圖資料夾，沒設就不截）
E2E_BASE_JS=<檔>：「改前」req-line.js；沒給就略過改前量測。"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402
import req_seg2 as RS  # noqa: E402

ok = CL.ok
HQ = CL.HQ
SHOTS = os.environ.get('E2E_SHOTS', '')
BASE_JS = os.environ.get('E2E_BASE_JS', '')
OLD_JS = open(BASE_JS, encoding='utf-8').read() if BASE_JS else None
TODAY = RS.TODAY

class Fake2(RS.Fake):
    """多兩個開關：req_info 失敗、req_cancel 失敗。"""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.fail_info = False
        self.cancel_fail = None

    def info(self, code, body):
        if self.fail_info and not body.get('date'):
            return {'ok': False, 'error': 'boom'}
        return super().info(code, body)

    def handler(self, route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except Exception:
            b = {}
        if b.get('action') == 'req_cancel' and self.cancel_fail:
            self.calls.append({'action': 'req_cancel', 'code': '', 'body': b, 'raw': route.request.post_data})
            msg, self.cancel_fail = self.cancel_fail, None
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'not_pending', 'message': msg}, ensure_ascii=False))
        return super().handler(route)

    def infos(self):
        return [c for c in self.calls if c['action'] == 'req_info' and not c['body'].get('date')]


def seed_row(i, status='pending'):
    return {'id': 'seed%d' % i, 'created_at': '2026-11-10T09:00:0%d+08:00' % i, 'emp_id': 'E1', 'name': '林小美', 'kind': 'ot', 'date': TODAY,
            'leave_type': '', 'start': '18:00', 'end': '20:00', 'hours': 2.0, 'miss_type': '', 'reason': '舊的一筆', 'has_attach': False, 'status': status,
            'decided_at': '', 'decided_by': '', 'reject_reason': '', 'proof_required': False, 'need_proof': False, 'sick_n': None, 'miss_n': None, 'warns': [],
            'voided_at': '', 'voided_by': '', 'void_reason': '', 'proxy_by': '', 'group': '', 'seg': None}


def open2(br, fake, tab, js=None, delay=None):
    ctx = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    p = ctx.new_page()
    p.add_init_script(CL.LOG_JS)
    p.route('**/api', fake.handler)
    p.route('**/api/*', fake.handler)
    if js is not None:
        p.route('**/req-line.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=js))
    p.add_init_script("window.confirm = function () { return true; };")
    p.goto(CL.url((HQ['lat'], HQ['lng']), in_client=True, extra='&view=req&tab=' + tab))
    p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
    p.wait_for_function("window.__calls.some(c => c.action === 'req_info')", timeout=10000)
    p.wait_for_timeout(600)
    set_delay(p, **(delay or {}))   # 開頁讀完才開延遲（開頁那次 req_info 不要慢）
    return p


def set_delay(p, **kw):
    for k, v in kw.items():
        p.evaluate('([k, v]) => { window.__delay = window.__delay || {}; window.__delay[k] = v; }', [k, v])


def shot(p, name):
    RS.shot(p, name)


def txt(p):
    return p.inner_text('#reqView')


def wait_txt(p, needle, timeout=15000):
    p.wait_for_function("(s) => document.getElementById('reqView').innerText.indexOf(s) >= 0", arg=needle, timeout=timeout)


def fill_one(p, a='13:00', b='15:00', reason='中午人手不足'):
    CL.pick_time(p, 0, a)
    CL.pick_time(p, 1, b)
    p.fill('#reqView input[type=text]', reason)


def fill_two(p):
    CL.pick_time(p, 0, '11:00'); CL.pick_time(p, 1, '14:00')
    p.click('#reqView .rq-seg-add')
    CL.pick_time(p, 2, '17:00'); CL.pick_time(p, 3, '21:00')
    p.fill('#reqView input[type=text]', '假日來客多，中午和晚上都留下來')


def timed_submit(p, needle):
    """按送出到畫面出現 needle 的毫秒數"""
    t0 = time.time()
    p.click('#reqView button.primary')
    wait_txt(p, needle)
    return int((time.time() - t0) * 1000)


def timed_cancel(p, needle, nth=0, label='取消'):
    t0 = time.time()
    p.locator('#reqView .rq-link:has-text("%s")' % label).nth(nth).click()
    wait_txt(p, needle)
    return int((time.time() - t0) * 1000)


def run_measure(br, js):
    """同一組操作量毫秒數（req_info 延遲 4 秒、req_cancel 延遲 0）：送出到「已送出」、取消到「已取消」。"""
    out = {}
    f = Fake2(requests=[seed_row(1)])
    p = open2(br, f, 'ot', js=js)
    fill_one(p)
    set_delay(p, req_info=4000)
    out['submit'] = timed_submit(p, '✓ 已送出')
    p.wait_for_timeout(300)
    set_delay(p, req_info=4000)
    out['cancel'] = timed_cancel(p, '已取消', nth=0, label='取消這筆申請')
    p.context.close()
    return out


def main():
    os.makedirs(CL.SHOTS, exist_ok=True)
    proc = CL.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()

            # ── 1. 一段送出：req_info 延遲 4 秒，1 秒內先看到新列與「✓ 已送出」 ──
            f = Fake2(requests=[seed_row(1)])
            p = open2(br, f, 'ot')
            fill_one(p)
            set_delay(p, req_info=4000)
            n0 = len(f.infos())
            t0 = time.time()
            p.click('#reqView button.primary')
            wait_txt(p, '✓ 已送出')
            ms = int((time.time() - t0) * 1000)
            ok('一段送出：延遲 4 秒的 req_info 不擋畫面，%d ms 內就出現「✓ 已送出」' % ms, ms < 1000, ms)
            t = txt(p)
            ok('一段送出：已經切到「我的申請」', p.locator('#reqView .rq-tabs button.on[data-tab=mine]').count() == 1)
            ok('一段送出：新列「加班 2 小時」（13:00–15:00・中午人手不足）與舊的一筆都在、新的在最前面',
               '13:00–15:00・中午人手不足' in t and '18:00–20:00・舊的一筆' in t and t.index('13:00–15:00') < t.index('18:00–20:00'), t)
            ok('一段送出：這時背景重讀還沒回來（req_info 還沒有新的一次）', len(f.infos()) == n0, (n0, len(f.infos())))
            ok('一段送出：訊息含「等主管審核」、新列有「審核中」「取消這筆申請」', '等主管審核' in t and '取消這筆申請' in t and '審核中' in t)
            shot(p, '01-送出後立即（req_info 還在讀）')
            # 延遲期間送出鈕不可按
            p.click('#reqView .rq-tabs button[data-tab=ot]')
            b = p.locator('#reqView button.primary')
            ok('背景重讀期間：回到加班分頁，送出鈕不可按、寫「更新清單中…」', b.is_disabled() and b.inner_text() == '更新清單中…', b.inner_text())
            ns = len(f.submits())
            p.evaluate("() => { document.querySelector('#reqView button.primary').click(); }")
            p.wait_for_timeout(300)
            ok('背景重讀期間：硬點送出鈕也沒有多送一次 req_submit', len(f.submits()) == ns == 1, (ns, len(f.submits())))
            # 伺服器上另外多了一筆（別處送的）→ 重讀回來以伺服器為準
            f.requests.append(dict(seed_row(2), id='server_extra', reason='伺服器多的一筆'))
            p.wait_for_function("() => !document.querySelector('#reqView button.primary').disabled", timeout=9000)
            ok('背景重讀完成：送出鈕恢復「送出申請」', p.locator('#reqView button.primary').inner_text() == '送出申請')
            ok('背景重讀完成：req_info 多了一次', len(f.infos()) == n0 + 1, (n0, len(f.infos())))
            p.click('#reqView .rq-tabs button[data-tab=mine]')
            t = txt(p)
            srv = [r['id'] for r in f.requests]
            ok('背景重讀完成：「我的申請」與伺服器一致（新送的、舊的、伺服器多的都在，沒有重複）',
               '13:00–15:00' in t and '18:00–20:00・舊的一筆' in t and '伺服器多的一筆' in t and t.count('13:00–15:00') == 1 and len(srv) == 3 and t.count('審核中') == 3, t)
            p.context.close()

            # ── 2. 一段：沒開兩段的店（舊後端沒有 seg2 欄），送出內容與畫面照舊，只是更快 ──
            f = Fake2(seg2=False)
            p = open2(br, f, 'ot')
            fill_one(p, '19:00', '21:00')
            set_delay(p, req_info=4000)
            ms = timed_submit(p, '✓ 已送出')
            ok('沒開兩段的店：送出後 %d ms 內「✓ 已送出」、有新列' % ms, ms < 1000 and '19:00–21:00・中午人手不足' in txt(p), ms)
            ok('沒開兩段的店：送出內容 payload 與以前一致（start／end／reason，沒有 segments）',
               f.submits()[0]['body'] == {'kind': 'ot', 'date': TODAY, 'start': '19:00', 'end': '21:00', 'reason': '中午人手不足', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}, f.submits()[0]['body'])
            p.context.close()

            # ── 3. 兩段送出：兩張新列、標同一次送出；背景重讀後仍一致 ──
            f = Fake2()
            p = open2(br, f, 'ot')
            fill_two(p)
            set_delay(p, req_info=4000)
            n0 = len(f.infos())
            t0 = time.time()
            p.click('#reqView button.primary')
            wait_txt(p, '✓ 已送出')
            ms = int((time.time() - t0) * 1000)
            t = txt(p)
            ok('兩段送出：%d ms 內「✓ 已送出」、會變成 2 張加班單' % ms, ms < 1000 and '會變成 2 張加班單，等主管審核' in t, ms)
            ok('兩段送出：兩張新列、標「同一次送出・第 1 段／共 2 段」「第 2 段／共 2 段」、第 1 段在前',
               '同一次送出・第 1 段／共 2 段' in t and '同一次送出・第 2 段／共 2 段' in t and t.index('11:00–14:00') < t.index('17:00–21:00') and t.count('取消這一段') == 2, t)
            ok('兩段送出：重讀還沒回來', len(f.infos()) == n0)
            shot(p, '02-兩段送出後立即')
            p.wait_for_timeout(5000)
            t2 = txt(p)
            ok('兩段送出：背景重讀回來後畫面與重讀前一致（兩張、同一次送出、訊息仍在）', len(f.infos()) == n0 + 1 and '同一次送出・第 2 段／共 2 段' in t2 and '✓ 已送出' in t2 and t2.count('審核中') == 2, t2)
            p.context.close()

            # ── 4. 連點送出：只送一次 ──
            f = Fake2()
            p = open2(br, f, 'ot')
            fill_one(p)
            set_delay(p, req_submit=800)
            p.evaluate("() => { var b = document.querySelector('#reqView button.primary'); b.click(); b.click(); b.click(); }")
            p.wait_for_timeout(300)
            p.evaluate("() => { var b = document.querySelector('#reqView button.primary'); if (b) b.click(); }")
            wait_txt(p, '✓ 已送出')
            ok('連點送出（同一刻三下、過一會兒再一下）：只送出一次 req_submit', len(f.submits()) == 1, len(f.submits()))
            p.context.close()

            # ── 5. 送出失敗：留在表單、顯示後端訊息、不切分頁、不重讀、鈕可再按 ──
            f = Fake2()
            f.fail = {'ok': False, 'error': 'duplicate', 'message': '這天已經有一筆審核中的加班申請，要改請先取消那一筆'}
            p = open2(br, f, 'ot')
            fill_one(p)
            set_delay(p, req_info=4000)
            n0 = len(f.infos())
            p.click('#reqView button.primary')
            p.wait_for_selector('#reqView .rq-box.err >> text=這天已經有一筆審核中的加班申請', timeout=3000)
            b = p.locator('#reqView button.primary')
            ok('送出失敗：留在加班表單、顯示後端訊息、送出鈕恢復可按、沒有「✓ 已送出」、沒有背景重讀',
               p.locator('#reqView .rq-tabs button.on[data-tab=ot]').count() == 1 and b.is_enabled() and b.inner_text() == '送出申請' and '✓ 已送出' not in txt(p) and len(f.infos()) == n0, txt(p))
            shot(p, '03-送出失敗')
            p.context.close()

            # ── 6. 重讀失敗：保留先畫的列、顯示一句白話提示、不顯示錯誤 ──
            f = Fake2(requests=[seed_row(1)])
            p = open2(br, f, 'ot')
            f.fail_info = True
            fill_one(p)
            p.click('#reqView button.primary')
            wait_txt(p, '✓ 已送出')
            wait_txt(p, '已送出，清單稍後更新', timeout=5000)
            t = txt(p)
            ok('重讀失敗：先畫的新列與舊列都還在、有「已送出，清單稍後更新」、沒有錯誤字樣、不是空白',
               '13:00–15:00・中午人手不足' in t and '18:00–20:00・舊的一筆' in t and '✓ 已送出' in t and '讀不到' not in t and '連線失敗' not in t and '失敗' not in t and p.locator('#reqView .rq-box.err').count() == 0, t)
            shot(p, '04-重讀失敗的提示')
            p.click('#reqView .rq-tabs button[data-tab=ot]')
            ok('重讀失敗：送出鈕恢復可按（不會一直鎖著）', p.locator('#reqView button.primary').is_enabled())
            p.context.close()

            # ── 7. 取消（一段）：0.5 秒內「取消中…」；成功後立刻變已取消，不等 req_info ──
            f = Fake2(requests=[seed_row(1)])
            p = open2(br, f, 'mine')
            set_delay(p, req_cancel=1500, req_info=4000)
            n0 = len(f.infos())
            t0 = time.time()
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').click()
            wait_txt(p, '取消中…', timeout=500)
            ms = int((time.time() - t0) * 1000)
            t = txt(p)
            b = p.locator('#reqView button.rq-link')
            ok('取消（一段）：按下確認 %d ms 內出現「取消中…」（按鈕與狀態標籤都換）、按鈕不可按' % ms, ms < 500 and t.count('取消中…') == 2 and b.is_disabled() and '審核中' not in t, (ms, t))
            shot(p, '05-取消中')
            t1 = time.time()
            wait_txt(p, '已取消', timeout=5000)
            ms2 = int((time.time() - t0) * 1000)
            ok('取消（一段）：成功後該列變「已取消」，總共 %d ms（req_cancel 1.5 秒＋畫面，不等 4 秒的 req_info）' % ms2, ms2 < 2600 and p.locator('#reqView button.rq-link').count() == 0, ms2)
            ok('取消（一段）：背景重讀還沒回來時畫面已更新', len(f.infos()) == n0)
            cc = [c for c in f.calls if c['action'] == 'req_cancel']
            ok('取消（一段）：只送一次 req_cancel、id 是那一筆', len(cc) == 1 and cc[0]['body']['id'] == 'seed1', cc)
            p.wait_for_timeout(4500)
            ok('取消（一段）：背景重讀回來後仍是已取消', len(f.infos()) == n0 + 1 and '已取消' in txt(p) and '取消這筆申請' not in txt(p), txt(p))
            p.context.close()

            # ── 8. 取消（兩段同組）：取消一段後，另一張立刻變回一般樣子 ──
            f = Fake2()
            p = open2(br, f, 'ot')
            fill_two(p)
            p.click('#reqView button.primary')
            wait_txt(p, '同一次送出・第 2 段／共 2 段')
            p.wait_for_timeout(600)
            set_delay(p, req_cancel=1200, req_info=4000)
            n0 = len(f.infos())
            t0 = time.time()
            p.locator('#reqView .rq-link:has-text("取消這一段")').nth(1).click()
            wait_txt(p, '取消中…', timeout=500)
            ms = int((time.time() - t0) * 1000)
            t = txt(p)
            ok('取消（兩段）：%d ms 內「取消中…」、另一段不受影響（還是審核中、仍標第 1 段）' % ms, ms < 500 and '取消中…' in t and '審核中' in t and '同一次送出・第 1 段' in t, t)
            shot(p, '06-取消中（兩段）')
            wait_txt(p, '已取消', timeout=5000)
            t = txt(p)
            ok('取消（兩段）：成功後另一張立刻不再標「同一次送出」、按鈕變「取消這筆申請」、已取消那張照舊顯示（不等重讀）',
               '同一次送出' not in t and '取消這一段' not in t and t.count('取消這筆申請') == 1 and '已取消' in t and len(f.infos()) == n0, t)
            p.wait_for_timeout(4500)
            t = txt(p)
            ok('取消（兩段）：背景重讀回來後仍一致', len(f.infos()) == n0 + 1 and '同一次送出' not in t and '已取消' in t and t.count('取消這筆申請') == 1, t)
            p.context.close()

            # ── 9. 取消失敗：還原按鈕、顯示後端訊息、狀態不變、不重讀 ──
            f = Fake2(requests=[seed_row(1)])
            f.cancel_fail = '主管已經處理過這筆，不能取消；要改請找主管'
            p = open2(br, f, 'mine')
            set_delay(p, req_cancel=700)
            n0 = len(f.infos())
            p.locator('#reqView .rq-link:has-text("取消這筆申請")').click()
            wait_txt(p, '取消中…', timeout=500)
            wait_txt(p, '主管已經處理過這筆，不能取消', timeout=4000)
            b = p.locator('#reqView button.rq-link')
            ok('取消失敗：按鈕還原成「取消這筆申請」可再按、顯示後端訊息、狀態仍「審核中」、沒有背景重讀',
               b.count() == 1 and b.is_enabled() and b.inner_text() == '取消這筆申請' and '審核中' in txt(p) and '取消中…' not in txt(p) and len(f.infos()) == n0, txt(p))
            shot(p, '07-取消失敗')
            p.context.close()

            # ── 10. 其他種類：請假（整天）、出差、忘打卡也走同一個送出鈕，同樣受惠（各送一筆驗證） ──
            f = Fake2(seg2=False)
            p = open2(br, f, 'leave')
            p.click('#reqView .rq-chip:has-text("事假")')   # 整天、不用填原因
            set_delay(p, req_info=4000)
            t0 = time.time()
            p.click('#reqView button.primary')
            wait_txt(p, '✓ 已送出', timeout=6000)
            ms = int((time.time() - t0) * 1000)
            ok('請假（事假、整天）：送出後 %d ms 內「✓ 已送出」、新列在「我的申請」（延遲 4 秒的 req_info 不擋）' % ms, ms < 1000 and '事假' in txt(p), (ms, txt(p)[:200]))
            p.context.close()

            # ── 11. 改前改後毫秒數（同樣的假後端：req_info 延遲 4 秒） ──
            new = run_measure(br, None)
            print('改後：送出→「✓ 已送出」%d ms；取消→「已取消」%d ms' % (new['submit'], new['cancel']))
            if OLD_JS is not None:
                old = run_measure(br, OLD_JS)
                print('改前：送出→「✓ 已送出」%d ms；取消→「已取消」%d ms' % (old['submit'], old['cancel']))
                ok('改後比改前快（送出、取消各省下 req_info 的等待）', new['submit'] < old['submit'] - 2000 and new['cancel'] < old['cancel'] - 2000, (old, new))
            br.close()
        print('\n全部通過：%d 項' % CL.n)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
