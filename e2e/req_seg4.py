#!/usr/bin/env python3
"""LINE 申請頁「加班一次最多四段」端對端（2026-11-21）：加班可以「＋ 加一段」到第四段、每段都能刪、前端擋（兩兩重疊／接在一起／合計超過 10 小時／沒填完整）、
手機窄螢幕 375px 不擠、我的申請標「第 N 段／共 M 段」、取消其中一段；請假、出差、舊後端（ot_segments_max 2）畫面不變。

用法：E2E_MOCK_PORT=8961 /usr/bin/python3 e2e/req_seg4.py     （手機寬 375px；截圖放 E2E_SHOTS 指的資料夾，沒設就不截）
後端用 page.route 在瀏覽器外假裝（api.md 的回應形狀），沿用 req_seg2.py 的 Fake，只改成回 ot_segments_max＝4、四段的 group／summary；
mock server 只拿來送 clock-line.html／req-line.js。"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402
import req_seg2 as R2  # noqa: E402

ok = CL.ok
HQ, JS = CL.HQ, CL.JS
SHOTS = os.environ.get('E2E_SHOTS', '')
TODAY = R2.TODAY
MD = R2.MD
W = 375
NUM = ['', '一', '兩', '三', '四']


class Fake4(R2.Fake):
    """同 req_seg2.Fake，但加班回 ot_segments_max 4；任何 2 段以上都標 group、summary 寫「加班四段」。"""

    def __init__(self, *a, ot_max=4, **kw):
        self.ot_max = ot_max
        R2.Fake.__init__(self, *a, **kw)

    def info(self, code, body):
        i = R2.Fake.info(self, code, body)
        if 'ot' in (self.seg2 or []):
            i['ot_segments_max'] = self.ot_max
        return i

    def submit(self, b):
        segs = b.get('segments')
        if not segs or len(segs) == 2:
            return R2.Fake.submit(self, b)
        self.n += 1
        grp = 'g%d' % self.n
        out = []
        for i, s in enumerate(segs):
            a = int(s['start'][:2]) * 60 + int(s['start'][3:])
            e = int(s['end'][:2]) * 60 + int(s['end'][3:])
            out.append({'id': 'r%d_%d' % (self.n, i + 1), 'created_at': '2026-11-21T10:00:00+08:00', 'emp_id': 'E1', 'name': R2.ME['name'], 'kind': b['kind'], 'date': b['date'],
                        'leave_type': '', 'start': s['start'], 'end': s['end'], 'hours': ((e - a) % 1440) / 60.0, 'miss_type': '', 'reason': b.get('reason', ''),
                        'has_attach': False, 'status': 'pending', 'decided_at': '', 'decided_by': '', 'reject_reason': '', 'proof_required': False, 'need_proof': False,
                        'sick_n': None, 'miss_n': None, 'warns': [], 'voided_at': '', 'voided_by': '', 'void_reason': '', 'proxy_by': '', 'group': grp, 'seg': i + 1})
        self.requests = out + self.requests
        tot = sum(x['hours'] for x in out)
        times = '、'.join('%s–%s' % (x['start'], x['end']) for x in out)
        return {'ok': True, 'request': out[0], 'requests': out, 'group': grp, 'summary': '%s 加班%s段 %s（共 %g 小時）' % (MD, NUM[len(out)], times, tot)}


def shot(p, name):
    if not SHOTS:
        return
    os.makedirs(SHOTS, exist_ok=True)
    p.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)


txt, submit, wait_mine, fill_ot = R2.txt, R2.submit, R2.wait_mine, R2.fill_ot


def open_ot(br, fake, tab='ot'):
    return R2.open_req(br, fake, tab, w=W, h=812)


def times(p, k):
    """第 k 段（0 起算）的開始、結束（畫面上的下拉現值）"""
    box = p.locator('#reqView .rq-time')
    f = lambda n: box.nth(n).locator('select.rq-hh').input_value() + ':' + box.nth(n).locator('select.rq-mm').input_value()
    return f(2 * k), f(2 * k + 1)


def fill_segs(p, segs):
    """依序填：第一段直接填，後面每段先按「＋」再填（按鈕是 .rq-seg-add）"""
    for k, (a, b) in enumerate(segs):
        if k and p.locator('#reqView .rq-seg-add').count():
            p.click('#reqView .rq-seg-add')
        CL.pick_time(p, 2 * k, a)
        CL.pick_time(p, 2 * k + 1, b)


S4 = [('09:00', '11:00'), ('12:00', '14:00'), ('15:00', '17:00'), ('18:00', '20:00')]


def main():
    os.makedirs(CL.SHOTS, exist_ok=True)
    proc = CL.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()

            # ── 1. 一段 → 加到第四段（那天 08:00–21:00 有打卡，所以不會跳「沒有打卡紀錄」的提醒，截圖乾淨） ──
            f = Fake4(days={'hq': [('08:00', '21:00')]})
            p = open_ot(br, f)
            ok('加班（新後端 ot_segments_max 4）：只一段時有「＋ 加一段…最多四段」、沒有刪除鈕', p.locator('#reqView .rq-seg-add').count() == 1 and '＋ 加一段（同一天另一段時間，最多四段）' in txt(p) and p.locator('#reqView .rq-seg-del').count() == 0, txt(p)[:200])
            shot(p, '00-加班-只一段')
            CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '11:00')
            p.click('#reqView .rq-seg-add')
            ok('加到第二段：兩列「第一段／第二段」、每段各有「刪除這段」、還有「＋ 再加一段（…還能加 2 段）」', p.locator('#reqView .rq-seg').count() == 2 and p.locator('#reqView .rq-seg-del').count() == 2 and '＋ 再加一段（最多四段，還能加 2 段）' in txt(p), txt(p)[:300])
            CL.pick_time(p, 2, '12:00'); CL.pick_time(p, 3, '14:00')
            ok('兩段時合計字句跟以前一樣「第一段 2 小時＋第二段 2 小時＝共 4 小時」', '第一段 2 小時＋第二段 2 小時＝共 4 小時' in txt(p), txt(p))
            p.click('#reqView .rq-seg-add'); CL.pick_time(p, 4, '15:00'); CL.pick_time(p, 5, '17:00')
            ok('加到第三段：三列、段名第一～第三段、合計「2＋2＋2＝共 6 小時」、按鈕變「還能加 1 段」', p.locator('#reqView .rq-seg').count() == 3 and '第三段' in txt(p) and '2＋2＋2＝共 6 小時' in txt(p) and '還能加 1 段' in txt(p), txt(p))
            p.click('#reqView .rq-seg-add'); CL.pick_time(p, 6, '18:00'); CL.pick_time(p, 7, '20:00')
            ok('加到第四段：四列、段名第一～第四段、加的按鈕消失（到上限）、4 個刪除鈕', p.locator('#reqView .rq-seg').count() == 4 and all(w in txt(p) for w in ('第一段', '第二段', '第三段', '第四段')) and p.locator('#reqView .rq-seg-add').count() == 0 and p.locator('#reqView .rq-seg-del').count() == 4, txt(p))
            ok('四段合計「2＋2＋2＋2＝共 8 小時」、底下說「送出後會變成 4 張加班單，主管可以一起核准。」', '2＋2＋2＋2＝共 8 小時' in txt(p) and '送出後會變成 4 張加班單，主管可以一起核准。' in txt(p))
            p.fill('#reqView input[type=text]', '午休前後、收班後都加班')
            # 手機 375px：沒有橫向捲動、每一列都在畫面內
            geo = p.evaluate("""() => { const vw = document.documentElement.clientWidth; const rows = Array.from(document.querySelectorAll('#reqView .rq-seg')).map(r => { const b = r.getBoundingClientRect(); const rr = r.querySelector('.rq-row').getBoundingClientRect(); const d = r.querySelector('.rq-seg-del').getBoundingClientRect(); return [Math.round(b.right), Math.round(rr.right), Math.round(d.right), Math.round(d.height)]; }); return { vw: vw, sw: document.documentElement.scrollWidth, rows: rows }; }""")
            ok('手機 375px：頁面沒有橫向捲動、四列的時間欄與「刪除這段」都在畫面內、刪除鈕高度 ≥ 24px', geo['vw'] == W and geo['sw'] <= W and all(max(r[:3]) <= W for r in geo['rows']) and all(r[3] >= 24 for r in geo['rows']), geo)
            shot(p, '01-LINE申請-加班四段填好-375px')
            if SHOTS:
                shot(p, 'LINE申請頁-加班四段-375px')
            submit(p); wait_mine(p)
            s = f.submits()
            ok('四段：只送一次 req_submit、segments 4 段（不帶 start／end／hours）', len(s) == 1 and s[0]['body'] == {'kind': 'ot', 'date': TODAY, 'segments': [{'start': a, 'end': b} for a, b in S4], 'reason': '午休前後、收班後都加班', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}, s)
            t = txt(p)
            ok('送出後切到「我的申請」：「已送出：…加班四段…（共 8 小時）／會變成 4 張加班單，等主管審核」', ('✓ 已送出：%s 加班四段 09:00–11:00、12:00–14:00、15:00–17:00、18:00–20:00（共 8 小時）' % MD) in t and '會變成 4 張加班單，等主管審核' in t, t[:300])
            ok('我的申請：四張各一列、標「同一次送出・第 1～4 段／共 4 段」、各有「取消這一段」、依時間排', all(('同一次送出・第 %d 段／共 4 段' % i) in t for i in (1, 2, 3, 4)) and t.count('取消這一段') == 4 and t.index('09:00–11:00') < t.index('12:00–14:00') < t.index('15:00–17:00') < t.index('18:00–20:00'), t)
            shot(p, '02-我的申請-四段')
            p.locator('#reqView .rq-link:has-text("取消這一段")').nth(2).click()
            p.wait_for_function("window.__calls.some(c => c.action === 'req_cancel')", timeout=5000)
            cc = [c for c in f.calls if c['action'] == 'req_cancel']
            ok('取消第 3 段：只對那一張呼叫一次 req_cancel', len(cc) == 1 and cc[0]['body']['id'].endswith('_3'), cc)
            p.wait_for_timeout(500)
            t = txt(p)
            ok('取消後剩三張仍成組、照剩下的重新數：第 1、2、3 段／共 3 段（不是「第 4 段／共 3 段」）、已取消的不算進組數', t.count('同一次送出・第') == 3 and all(('同一次送出・第 %d 段／共 3 段' % i) in t for i in (1, 2, 3)) and '第 4 段' not in t and '／共 4 段' not in t and '已取消' in t, t)
            p.context.close()

            # ── 2. 每段可刪：刪中間、刪第一、刪到剩一段 ──
            f = Fake4()
            p = open_ot(br, f)
            fill_segs(p, S4)
            p.locator('#reqView .rq-seg-del').nth(1).click()   # 刪第二段（12–14）
            ok('刪第二段：剩三段、後面往前補（第二段變 15–17、第三段變 18–20）、「加一段」鈕回來', p.locator('#reqView .rq-seg').count() == 3 and times(p, 0) == ('09:00', '11:00') and times(p, 1) == ('15:00', '17:00') and times(p, 2) == ('18:00', '20:00') and p.locator('#reqView .rq-seg-add').count() == 1, [times(p, k) for k in range(3)])
            p.locator('#reqView .rq-seg-del').nth(0).click()   # 刪第一段（09–11）
            ok('刪第一段：剩兩段、原本的第二段變成第一段（15–17）、第三段變第二段（18–20）', p.locator('#reqView .rq-seg').count() == 2 and times(p, 0) == ('15:00', '17:00') and times(p, 1) == ('18:00', '20:00'), [times(p, k) for k in range(2)])
            p.locator('#reqView .rq-seg-del').nth(1).click()
            ok('刪到剩一段：回到只有一列、有「＋ 加一段」、沒有刪除鈕、第一段還是 15–17', p.locator('#reqView .rq-seg').count() == 0 and p.locator('#reqView .rq-seg-add').count() == 1 and p.locator('#reqView .rq-seg-del').count() == 0 and times(p, 0) == ('15:00', '17:00'))
            p.fill('#reqView input[type=text]', '刪完剩一段'); submit(p); wait_mine(p)
            s = f.submits()
            ok('刪到一段後送出：照舊一張（start／end、沒有 segments）', len(s) == 1 and 'segments' not in s[0]['body'] and s[0]['body']['start'] == '15:00' and s[0]['body']['end'] == '17:00', s)
            p.context.close()

            # ── 3. 前端擋：兩兩重疊、接在一起、合計、沒填完整 ──
            f = Fake4()
            p = open_ot(br, f)
            fill_segs(p, [('11:00', '14:00'), ('16:00', '17:00'), ('13:00', '15:00')])
            ok('擋：第一、第三段重疊 → 立刻顯示「第一段和第三段時間重疊（11:00–14:00、13:00–15:00），請改時間」', '第一段和第三段時間重疊（11:00–14:00、13:00–15:00），請改時間' in txt(p), txt(p))
            p.fill('#reqView input[type=text]', '測試'); submit(p)
            p.wait_for_selector('#reqView .rq-box.err >> text=第一段和第三段時間重疊', timeout=3000)
            ok('擋：重疊 → 沒有送出 req_submit', len(f.submits()) == 0)
            CL.pick_time(p, 4, '17:00'); CL.pick_time(p, 5, '19:00')
            ok('擋：第二段 16–17 接第三段 17–19 → 「第二段和第三段接在一起，請直接填成一段 16:00–19:00」', '第二段和第三段接在一起，請直接填成一段 16:00–19:00' in txt(p), txt(p))
            submit(p); p.wait_for_timeout(400)
            ok('擋：接在一起 → 沒有送出', len(f.submits()) == 0)
            CL.pick_time(p, 0, '06:00'); CL.pick_time(p, 1, '10:00'); CL.pick_time(p, 2, '11:00'); CL.pick_time(p, 3, '15:00'); CL.pick_time(p, 4, '16:00'); CL.pick_time(p, 5, '19:00')
            ok('三段 4＋4＋3＝11 小時 → 「三段合計 11 小時，超過 10 小時，請確認時間」', '三段合計 11 小時，超過 10 小時，請確認時間' in txt(p), txt(p))
            p.click('#reqView .rq-seg-add'); CL.pick_time(p, 6, '20:00'); CL.pick_time(p, 7, '21:00')
            ok('四段 4＋4＋3＋1＝12 小時 → 「四段合計 12 小時，超過 10 小時，請確認時間」', '四段合計 12 小時，超過 10 小時，請確認時間' in txt(p), txt(p))
            shot(p, '03-擋下-四段合計超過10小時')
            submit(p); p.wait_for_timeout(400)
            ok('擋：超限 → 沒有送出', len(f.submits()) == 0)
            CL.pick_time(p, 0, '08:00'); CL.pick_time(p, 1, '11:00'); CL.pick_time(p, 2, '12:00'); CL.pick_time(p, 3, '15:00'); CL.pick_time(p, 4, '16:00'); CL.pick_time(p, 5, '18:00'); CL.pick_time(p, 6, '19:00'); CL.pick_time(p, 7, '21:00')
            ok('四段 3＋3＋2＋2＝10 小時剛好 → 沒有擋的訊息', p.locator('#reqView .rq-seg-bad-msg .rq-box').count() == 0, txt(p))
            CL.pick_time(p, 7, '')
            submit(p); p.wait_for_timeout(400)
            ok('擋：第四段沒填完整 → 「第四段：請填完整的加班時段」且只有第四段那列標紅、沒送出', '第四段：請填完整的加班時段' in txt(p) and p.locator('#reqView .rq-row.rq-seg-bad').count() == 1 and p.locator('#reqView .rq-seg[data-seg="4"] .rq-row.rq-seg-bad').count() == 1 and len(f.submits()) == 0, txt(p))
            p.context.close()

            # ── 4. 後端說第三段有問題 → 第三列標紅、表單內容還在 ──
            f = Fake4()
            p = open_ot(br, f)
            fill_segs(p, S4[:3]); p.fill('#reqView input[type=text]', '測試')
            f.fail = {'ok': False, 'error': 'duplicate', 'seg': 3, 'message': '第三段：這天已經有一筆審核中的加班申請，要改請先取消那一筆'}
            submit(p)
            p.wait_for_selector('#reqView .rq-box.err >> text=第三段：這天已經有一筆審核中', timeout=3000)
            ok('後端回 seg 3：訊息「第三段：…」、只有第三列標紅；表單內容（三段、原因）還在', p.locator('#reqView .rq-row.rq-seg-bad').count() == 1 and p.locator('#reqView .rq-seg[data-seg="3"] .rq-row.rq-seg-bad').count() == 1 and p.locator('#reqView .rq-seg').count() == 3 and p.input_value('#reqView input[type=text]') == '測試')
            p.context.close()
            f = Fake4()
            p = open_ot(br, f)
            fill_segs(p, S4); p.fill('#reqView input[type=text]', '測試')
            f.fail = {'ok': False, 'error': 'bad_segments', 'message': '加班一次最多填四段時間'}
            submit(p)
            p.wait_for_selector('#reqView .rq-box.err >> text=加班一次最多填四段時間', timeout=3000)
            ok('後端回「加班一次最多填四段時間」→ 照字顯示（白話）', '加班一次最多填四段時間' in txt(p))
            p.context.close()

            # ── 5. 舊後端（ot_segments_max 2）、開關沒開：畫面跟以前一樣 ──
            f = Fake4(ot_max=2)
            p = open_ot(br, f)
            ok('舊後端（ot_segments_max 2）：「＋ 加第二段（同一天另一段時間）」、字句沒變', '＋ 加第二段（同一天另一段時間）' in txt(p) and '最多四段' not in txt(p))
            CL.pick_time(p, 0, '11:00'); CL.pick_time(p, 1, '14:00'); p.click('#reqView .rq-seg-add')
            ok('舊後端：加了第二段後只有一顆「移除第二段」、不再有「加一段」、沒有「刪除這段」', p.locator('#reqView .rq-seg-del').count() == 1 and '移除第二段' in txt(p) and p.locator('#reqView .rq-seg-add').count() == 0 and '刪除這段' not in txt(p), txt(p))
            p.context.close()
            f = Fake4(seg2=[])
            p = open_ot(br, f)
            ok('開關沒開（seg2_kinds 空）：沒有「加一段」', p.locator('#reqView .rq-seg-add').count() == 0 and '加一段' not in txt(p) and '加第二段' not in txt(p))
            p.context.close()

            # ── 6. 請假、出差仍最多兩段（就算後端加班回 4） ──
            f = Fake4(seg2=['ot', 'leave', 'trip'])
            p = open_ot(br, f, 'leave')
            p.click('#reqView .rq-chip:has-text("事假")'); p.click('#reqView .rq-chip:has-text("只請一段")')
            ok('請假：只請一段出現「＋ 加第二段」（不是「加一段」）', p.locator('#reqView .rq-seg-add').count() == 1 and '＋ 加第二段（同一天另一段時間）' in txt(p) and '最多四段' not in txt(p))
            p.click('#reqView .rq-seg-add')
            ok('請假：加了第二段就到上限——沒有再加的鈕、沒有「刪除這段」、有「移除第二段」', p.locator('#reqView .rq-seg-add').count() == 0 and p.locator('#reqView .rq-seg-del').count() == 1 and '移除第二段' in txt(p) and '刪除這段' not in txt(p))
            p.context.close()
            p = open_ot(br, f, 'trip')
            p.click('#reqView .rq-chip:has-text("只一段")')
            p.click('#reqView .rq-seg-add')
            ok('出差：同樣最多兩段', p.locator('#reqView .rq-seg-add').count() == 0 and '移除第二段' in txt(p) and p.locator('#reqView .rq-seg').count() == 2)
            p.context.close()

            # ── 7. 綁兩家店、其中兩段在不同店打卡 → 要分開送 ──
            both = [{'code': 'hq', 'name': HQ['name'], 'emp_id': 'E1', 'emp_name': '林小美'}, {'code': 'mztjs', 'name': JS['name'], 'emp_id': 'E2', 'emp_name': '林小美'}]
            f = Fake4(stores=both, days={'hq': [('09:00', '13:00')], 'mztjs': [('17:00', '21:00')]})
            p = open_ot(br, f)
            fill_segs(p, [('09:30', '10:30'), ('11:00', '12:00'), ('17:30', '18:30'), ('19:00', '20:30')])
            p.wait_for_selector('#reqView .rq-auto-store.warn >> text=請分開送', timeout=6000)
            ok('兩家店：第一段在 A 店、第三段在 B 店 → 「第一段在…打卡、第三段在…打卡，這幾段要送到不同的店，請分開送」', '第一段在%s打卡、第三段在%s打卡，這幾段要送到不同的店，請分開送' % (HQ['name'], JS['name']) in txt(p), txt(p))
            p.fill('#reqView input[type=text]', '兩店'); submit(p); p.wait_for_timeout(800)
            ok('兩家店：按送出也擋下來、沒有送出 req_submit', len(f.submits()) == 0 and '請分開送' in txt(p))
            p.context.close()

            br.close()
        print('\n全部通過：%d 項' % CL.n)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
