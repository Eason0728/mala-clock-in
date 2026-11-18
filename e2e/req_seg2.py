#!/usr/bin/env python3
"""LINE 申請頁「一次填兩段」端對端（2026-11-18）：加班、請假、出差各一組兩段成功、前端擋、開關沒開時畫面與送出內容跟以前一樣、
生理假（2026-11-18 起新後端開放兩段；後端開關 off 時沒有「加第二段」）、事假不再出現「本月第 N 次」、加班防呆提示、兩段在不同店要分開送、我的申請標記與取消這一段、證明共用一次上傳。

用法：/usr/bin/python3 e2e/req_seg2.py            （手機寬 390px；截圖放 E2E_SHOTS 指的資料夾，沒設就不截）
後端用 page.route 在瀏覽器外假裝（api.md 的回應形狀），不碰 mock 資料；mock server 只拿來送 clock-line.html／req-line.js。
E2E_BASE_JS=<檔>：比對用的「改前」req-line.js（git show feat/seg2-backend:req-line.js 存出來的）；沒給就略過「改前改後逐欄相同」那幾項。"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clock_line as CL  # noqa: E402

ok = CL.ok
HQ, JS = CL.HQ, CL.JS
SHOTS = os.environ.get('E2E_SHOTS', '')
BASE_JS = os.environ.get('E2E_BASE_JS', '')
TODAY = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600))
MD = '%d/%d' % (int(TODAY[5:7]), int(TODAY[8:10]))
ME = {'emp_id': 'E1', 'name': '林小美'}
OLD_JS = open(BASE_JS, encoding='utf-8').read() if BASE_JS else None


class Fake:
    """假後端：記下每個請求，回 api.md 的形狀。"""

    def __init__(self, stores=None, seg2=None, days=None, extra_info=None, requests=None, no_types=None, quota=None):
        self.stores = stores or [{'code': 'hq', 'name': HQ['name'], 'emp_id': 'E1', 'emp_name': '林小美'}]
        self.seg2 = ['ot'] if seg2 is None else seg2
        self.no_types = [] if no_types is None else no_types
        self.quota = quota or []   # 新後端（生理假新規則開著）回 []；REQ_MENS_RULES=off 回 ['生理假']
        self.days = days or {}          # 店代碼 → [(上班, 下班)]
        self.extra = extra_info or {}   # 店代碼 → 要蓋掉的 req_info 欄位
        self.requests = requests or []
        self.calls = []
        self.fail = None                # 下一次 req_submit 要回的失敗
        self.n = 0

    def info(self, code, body):
        i = {'ok': True, 'name': ME['name'], 'emp_id': ME['emp_id'], 'today': TODAY, 'requests': list(self.requests), 'miss_days': 4,
             'leave_types': ['特休假', '事假', '病假', '生理假', '家庭照顧假'], 'proof_types': ['病假', '婚假', '喪假', '產假'],
             'sick_proof_days': 3, 'sick_dates': []}
        if self.seg2 is not False:
            i.update({'seg2_kinds': self.seg2, 'seg2_max_h': {'ot': 10, 'leave': 8, 'trip': 8}, 'seg2_no_types': list(self.no_types),
                      'ot_max_h': 10, 'ot_segments_max': 2 if 'ot' in self.seg2 else 1})
        i.update(self.extra.get(code, {}))
        d = body.get('date')
        if d:
            spans = self.days.get(code, [])
            i['day'] = {'date': d, 'punches': [x for a, b in spans for x in ({'type': 'in', 'hm': a, 'status': 'ok'}, {'type': 'out', 'hm': b, 'status': 'ok'})],
                        'missing': {'options': ['both'] if not spans else ['break'], 'open_in': None, 'lone_out': None, 'lone_out_next': False,
                                    'spans': [{'in': a, 'out': b, 'out_next': False} for a, b in spans], 'open_ins': [], 'lone_outs': []}}
            if body.get('day_only'):
                i['requests'] = []
                i['day_only'] = True
        return i

    def submit(self, b):
        kind = b['kind']
        segs = b.get('segments')
        rows = [{'start': s['start'], 'end': s['end']} for s in segs] if segs else [{'start': b.get('start', ''), 'end': b.get('end', '')}]
        self.n += 1
        grp = 'g%d' % self.n if len(rows) == 2 else ''
        out = []
        for i, r in enumerate(rows):
            h = None
            if r['start'] and r['end']:
                a = int(r['start'][:2]) * 60 + int(r['start'][3:])
                e = int(r['end'][:2]) * 60 + int(r['end'][3:])
                h = ((e - a) % 1440) / 60.0
            else:
                h = float(b.get('hours') or 0)
            out.append({'id': 'r%d_%d' % (self.n, i + 1), 'created_at': '2026-11-18T10:00:0%d+08:00' % 0, 'emp_id': 'E1', 'name': ME['name'], 'kind': kind, 'date': b['date'],
                        'leave_type': b.get('leave_type', '出差' if kind == 'trip' else ''), 'start': r['start'], 'end': r['end'], 'hours': h, 'miss_type': '',
                        'reason': b.get('reason') or ('地點：%s；事由：%s' % (b.get('place'), b.get('why')) if kind == 'trip' else ''), 'has_attach': bool(b.get('attach_id')),
                        'status': 'pending', 'decided_at': '', 'decided_by': '', 'reject_reason': '', 'proof_required': kind == 'leave' and b.get('leave_type') in ('病假',),
                        'need_proof': False, 'sick_n': None, 'miss_n': None, 'warns': [], 'voided_at': '', 'voided_by': '', 'void_reason': '', 'proxy_by': '',
                        'group': grp, 'seg': (i + 1) if grp else None})
        self.requests = out + self.requests
        word = {'ot': '加班', 'leave': b.get('leave_type', '請假'), 'trip': '出差'}[kind]
        tot = sum(x['hours'] for x in out)
        fmt = lambda v: ('%g' % v)
        if len(out) == 2:
            summ = '%s %s兩段 %s–%s、%s–%s（共 %s 小時）' % (MD, word, out[0]['start'], out[0]['end'], out[1]['start'], out[1]['end'], fmt(tot))
            return {'ok': True, 'request': out[0], 'requests': out, 'summary': summ, 'group': grp}
        return {'ok': True, 'request': out[0], 'summary': '%s %s %s–%s（共 %s 小時）' % (MD, word, out[0]['start'], out[0]['end'], fmt(tot))}

    def handler(self, route):
        req = route.request
        try:
            b = json.loads(req.post_data or '{}')
        except Exception:
            return route.continue_()
        a = b.get('action')
        u = req.url
        code = u.split('/api/', 1)[1].split('?')[0] if '/api/' in u else ''
        self.calls.append({'action': a, 'code': code, 'body': b, 'raw': req.post_data})
        J = lambda x: route.fulfill(status=200, content_type='application/json', body=json.dumps(x, ensure_ascii=False))
        if a == 'line_hub_req_init':
            return J({'ok': True, 'lite': bool(b.get('lite')), 'stores': self.stores, 'punch_store': self.stores[0]['code'], 'comp': None,
                      'leave_types': {'common': ['特休假', '事假', '病假', '生理假', '家庭照顧假'], 'special': []}, 'quota': []})
        if a == 'line_hub_req_quota':
            return J({'ok': True, 'quota': self.quota, 'comp': {'allowed': False, 'known': True, 'ot_h': 0, 'used_h': 0, 'balance_h': 0}})
        if a == 'req_info':
            return J(self.info(code, b))
        if a == 'req_submit':
            if self.fail:
                f, self.fail = self.fail, None
                return J(f)
            return J(self.submit(b))
        if a == 'line_hub_attach_put':
            return J({'ok': True, 'attach_id': 'ATT1'})
        if a == 'req_attach':
            return J({'ok': True})
        if a == 'req_cancel':
            for r in self.requests:
                if r['id'] == b.get('id'):
                    r['status'] = 'cancelled'
            return J({'ok': True})
        return route.continue_()

    def submits(self):
        return [c for c in self.calls if c['action'] == 'req_submit']


def open_req(br, fake, tab, js=None, w=390, h=844):
    ctx = br.new_context(viewport={'width': w, 'height': h}, is_mobile=True, has_touch=True)
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
    p.wait_for_timeout(500)
    return p


def shot(p, name):
    if not SHOTS:
        return
    os.makedirs(SHOTS, exist_ok=True)
    p.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)


def txt(p):
    return p.inner_text('#reqView')


def fill_ot(p, a, b, reason='假日來客多，中午和晚上都留下來'):
    CL.pick_time(p, 0, a)
    CL.pick_time(p, 1, b)
    p.fill('#reqView input[type=text]', reason)


def submit(p):
    p.click('#reqView button.primary')


def wait_mine(p):
    p.wait_for_selector('#reqView .rq-tabs button.on[data-tab=mine]', timeout=8000)


def norm(html):
    return html.replace('\n', '')


def main():
    os.makedirs(CL.SHOTS, exist_ok=True)
    proc = CL.start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()

            # ── 1. 加班兩段成功 ──
            f = Fake()
            p = open_req(br, f, 'ot')
            ok('加班：開了 ot 的店出現「＋ 加第二段」', p.locator('#reqView .rq-seg-add').count() == 1 and '＋ 加第二段（同一天另一段時間）' in txt(p))
            shot(p, '01-加班-只一段（有加第二段鈕）')
            CL.pick_time(p, 0, '11:00'); CL.pick_time(p, 1, '14:00')
            p.click('#reqView .rq-seg-add')
            ok('加班：按了之後變兩列「第一段／第二段」、有「移除第二段」', p.locator('#reqView .rq-seg').count() == 2 and '第一段' in txt(p) and '第二段' in txt(p) and p.locator('#reqView .rq-seg-del').count() == 1)
            CL.pick_time(p, 2, '17:00'); CL.pick_time(p, 3, '21:00')
            ok('加班：合計「第一段 3 小時＋第二段 4 小時＝共 7 小時」', '第一段 3 小時＋第二段 4 小時＝共 7 小時' in txt(p), txt(p))
            ok('加班：兩段時底下說「送出後會變成 2 張加班單，主管可以一起核准。」', '送出後會變成 2 張加班單，主管可以一起核准。' in txt(p))
            p.fill('#reqView input[type=text]', '假日來客多，中午和晚上都留下來')
            shot(p, '02-加班-兩段填好')
            submit(p); wait_mine(p)
            s = f.submits()
            ok('加班兩段：只送一次 req_submit', len(s) == 1, len(s))
            want = {'kind': 'ot', 'date': TODAY, 'segments': [{'start': '11:00', 'end': '14:00'}, {'start': '17:00', 'end': '21:00'}], 'reason': '假日來客多，中午和晚上都留下來',
                    'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}
            ok('加班兩段：送出內容與 api.md 一致（segments、不帶 start／end／hours）', s[0]['body'] == want, s[0]['body'])
            t = txt(p)
            ok('加班兩段：自動切到「我的申請」、成功訊息「已送出：…兩段…（共 7 小時）／會變成 2 張加班單，等主管審核」',
               ('✓ 已送出：%s 加班兩段 11:00–14:00、17:00–21:00（共 7 小時）' % MD) in t and '會變成 2 張加班單，等主管審核' in t, t[:300])
            ok('我的申請：兩張各一列、標「同一次送出・第 1 段／共 2 段」「第 2 段／共 2 段」、各有「取消這一段」',
               '同一次送出・第 1 段／共 2 段' in t and '同一次送出・第 2 段／共 2 段' in t and t.count('取消這一段') == 2 and '取消這筆申請' not in t, t)
            ok('我的申請：第 1 段排在第 2 段前面', t.index('11:00–14:00') < t.index('17:00–21:00'))
            shot(p, '03-送出成功與我的申請')
            p.locator('#reqView .rq-link:has-text("取消這一段")').nth(1).click()
            p.wait_for_function("window.__calls.some(c => c.action === 'req_cancel')", timeout=5000)
            cc = [c for c in f.calls if c['action'] == 'req_cancel']
            ok('取消這一段：只對那一張呼叫一次 req_cancel（第 2 段）', len(cc) == 1 and cc[0]['body']['id'].endswith('_2'), cc)
            p.wait_for_timeout(500)
            t = txt(p)
            ok('取消後剩下那張變回一般樣子：不再標「同一次送出・第 N 段／共 2 段」、按鈕回到「取消這筆申請」（已取消的不算進組數）',
               '同一次送出' not in t and '已取消' in t and '取消這一段' not in t and t.count('取消這筆申請') == 1 and '審核中' in t, t)
            p.context.close()

            # ── 2. 前端擋：重疊、相接、超限、沒填完整、單張超過 10 小時 ──
            f = Fake()
            p = open_req(br, f, 'ot')
            def two(a, b, c, d):
                CL.pick_time(p, 0, a); CL.pick_time(p, 1, b)
                if p.locator('#reqView .rq-seg-add').count():
                    p.click('#reqView .rq-seg-add')
                CL.pick_time(p, 2, c); CL.pick_time(p, 3, d)
            two('11:00', '14:00', '13:00', '15:00')
            ok('擋：重疊 → 表單上立刻顯示「兩段時間重疊（11:00–14:00、13:00–15:00），請改時間」', '兩段時間重疊（11:00–14:00、13:00–15:00），請改時間' in txt(p), txt(p))
            p.fill('#reqView input[type=text]', '測試'); submit(p)
            p.wait_for_selector('#reqView .rq-box.err >> text=兩段時間重疊', timeout=3000)
            ok('擋：重疊 → 沒有送出 req_submit', len(f.submits()) == 0)
            shot(p, '04-擋下-重疊')
            CL.pick_time(p, 2, '14:00'); CL.pick_time(p, 3, '17:00')
            ok('擋：接在一起 → 「兩段接在一起，請直接填成一段 11:00–17:00」', '兩段接在一起，請直接填成一段 11:00–17:00' in txt(p), txt(p))
            submit(p); p.wait_for_timeout(400)
            ok('擋：接在一起 → 沒有送出', len(f.submits()) == 0)
            CL.pick_time(p, 0, '08:00'); CL.pick_time(p, 1, '13:00'); CL.pick_time(p, 2, '14:00'); CL.pick_time(p, 3, '20:00')
            ok('擋：合計 11 小時 → 「兩段合計 11 小時，超過 10 小時，請確認時間」', '兩段合計 11 小時，超過 10 小時，請確認時間' in txt(p), txt(p))
            submit(p); p.wait_for_timeout(400)
            ok('擋：超限 → 沒有送出', len(f.submits()) == 0)
            shot(p, '05-擋下-合計超過10小時')
            CL.pick_time(p, 0, '08:00'); CL.pick_time(p, 1, '13:00'); CL.pick_time(p, 2, '14:00'); CL.pick_time(p, 3, '19:00')
            ok('剛好 10 小時 → 沒有擋的訊息', p.locator('#reqView .rq-seg-bad-msg .rq-box').count() == 0)
            CL.pick_time(p, 2, '18:00'); CL.pick_time(p, 3, '')
            submit(p); p.wait_for_timeout(400)
            ok('擋：第二段沒填完整 → 「第二段：請填完整的加班時段」且第二段那列標紅、沒送出',
               '第二段：請填完整的加班時段' in txt(p) and p.locator('#reqView .rq-seg:nth-of-type(2) .rq-row.rq-seg-bad, #reqView .rq-seg2 .rq-row.rq-seg-bad').count() == 1 and len(f.submits()) == 0, txt(p))
            p.context.close()
            f = Fake()
            p = open_req(br, f, 'ot')
            fill_ot(p, '08:00', '19:30', '加很久')
            submit(p); p.wait_for_timeout(400)
            ok('N1：只填一段超過 10 小時 → 「加班時段超過 10 小時，請確認時間」、沒送出', '加班時段超過 10 小時，請確認時間' in txt(p) and len(f.submits()) == 0, txt(p))
            p.context.close()

            # ── 2b. 後端說哪一段有問題 → 那一列標紅、訊息帶「第二段：」 ──
            f = Fake()
            p = open_req(br, f, 'ot')
            CL.pick_time(p, 0, '11:00'); CL.pick_time(p, 1, '14:00'); p.click('#reqView .rq-seg-add'); CL.pick_time(p, 2, '17:00'); CL.pick_time(p, 3, '21:00')
            p.fill('#reqView input[type=text]', '測試')
            f.fail = {'ok': False, 'error': 'duplicate', 'seg': 2, 'message': '第二段：這天已經有一筆審核中的加班申請，要改請先取消那一筆'}
            submit(p)
            p.wait_for_selector('#reqView .rq-box.err >> text=第二段：這天已經有一筆審核中', timeout=3000)
            ok('後端回 seg 2：訊息「第二段：…」顯示、第二段那列標紅、第一段不標', p.locator('#reqView .rq-row.rq-seg-bad').count() == 1 and p.locator('#reqView .rq-seg2 .rq-row.rq-seg-bad').count() == 1)
            ok('後端擋下後表單內容還在（沒清掉）', p.locator('#reqView .rq-seg').count() == 2 and p.input_value('#reqView input[type=text]') == '測試')
            p.context.close()

            # ── 3. 開關沒開：沒有「加第二段」、畫面與送出內容跟改前逐欄相同 ──
            def dom(fake, tab, js, actions=None):
                pp = open_req(br, fake, tab, js)
                if actions:
                    actions(pp)
                h = norm(pp.inner_html('#reqView'))
                pp.context.close()
                return h
            for label, seg2 in (('舊後端（req_info 沒有 seg2 欄位）', False), ('開關全關（seg2_kinds 空）', []), ('只開請假、加班沒開', ['leave'])):
                f = Fake(seg2=seg2)
                p = open_req(br, f, 'ot')
                ok('開關沒開／舊後端：加班沒有「加第二段」——' + label, p.locator('#reqView .rq-seg-add').count() == 0 and '加第二段' not in txt(p))
                fill_ot(p, '19:00', '21:00', '外送多')
                submit(p); wait_mine(p)
                s = f.submits()
                ok('開關沒開：只一段的送出內容是 kind、date、start、end、reason（逐欄同以前）——' + label,
                   s[0]['raw'] == json.dumps({'kind': 'ot', 'date': TODAY, 'start': '19:00', 'end': '21:00', 'reason': '外送多', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}, ensure_ascii=False, separators=(',', ':')), s[0]['raw'])
                p.context.close()
            f = Fake(seg2=['ot'])
            p = open_req(br, f, 'ot')
            fill_ot(p, '19:00', '21:00', '外送多')
            submit(p); wait_mine(p)
            ok('開了但只填一段：送出內容跟沒開的一模一樣（沒有 segments）', f.submits()[0]['raw'] == json.dumps({'kind': 'ot', 'date': TODAY, 'start': '19:00', 'end': '21:00', 'reason': '外送多', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}, ensure_ascii=False, separators=(',', ':')))
            p.context.close()
            if OLD_JS:
                for tab, act in (('ot', None), ('leave', None), ('trip', None)):
                    a = dom(Fake(seg2=False), tab, OLD_JS, act)
                    b = dom(Fake(seg2=False), tab, None, act)
                    c = dom(Fake(seg2=[]), tab, None, act)
                    ok('開關沒開：%s 分頁畫面（整段 HTML）與改前逐字相同（舊後端、開關全關各一次）' % tab, a == b == c, (len(a), len(b), len(c)))
                def span_mode(pp):
                    pp.click('#reqView .rq-chip:has-text("只請一段")')
                    pp.click('#reqView .rq-chip:has-text("病假")')
                a = dom(Fake(seg2=False), 'leave', OLD_JS, span_mode); b = dom(Fake(seg2=[]), 'leave', None, span_mode)
                ok('開關沒開：請假（病假、只請一段）畫面與改前逐字相同', a == b, (len(a), len(b)))
                def trip_span(pp):
                    pp.click('#reqView .rq-chip:has-text("只一段")')
                a = dom(Fake(seg2=False), 'trip', OLD_JS, trip_span); b = dom(Fake(seg2=[]), 'trip', None, trip_span)
                ok('開關沒開：出差（只一段）畫面與改前逐字相同', a == b, (len(a), len(b)))
                reqs = [{'id': 'x1', 'created_at': '2026-11-17T09:00:00+08:00', 'emp_id': 'E1', 'name': '林小美', 'kind': 'ot', 'date': TODAY, 'start': '18:00', 'end': '20:00', 'hours': 2, 'reason': '外送', 'status': 'pending',
                         'has_attach': False, 'warns': [], 'group': '', 'seg': None, 'proof_required': False, 'need_proof': False}]
                a = dom(Fake(seg2=False, requests=reqs), 'mine', OLD_JS); b = dom(Fake(seg2=['ot', 'leave', 'trip'], requests=reqs), 'mine', None)
                ok('我的申請：沒有 group 的單（舊單、一段）畫面與改前逐字相同（取消鈕還是「取消這筆申請」）', a == b and '取消這筆申請' in a, (len(a), len(b)))
                # 改前改後送出內容逐欄相同：請假、出差
                for tab in ('leave', 'trip'):
                    got = []
                    for js in (OLD_JS, None):
                        f = Fake(seg2=False if js else ['ot', 'leave', 'trip'])
                        p = open_req(br, f, tab, js)
                        if tab == 'leave':
                            p.click('#reqView .rq-chip:has-text("病假")'); p.click('#reqView .rq-chip:has-text("只請一段")')
                            CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '11:00'); p.fill('#reqView input[type=text]', '回診')
                        else:
                            p.click('#reqView .rq-chip:has-text("只一段")'); CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '12:00')
                            p.select_option('#reqView .rq-place-pick', '總部辦公室'); p.fill('#reqView .rq-why', '盤點')
                        submit(p); wait_mine(p)
                        got.append(f.submits()[0]['raw'])
                        p.context.close()
                    ok('改前改後：%s 只一段的送出內容逐欄相同' % ('請假' if tab == 'leave' else '出差'), got[0] == got[1] and 'segments' not in got[1], got)

            # ── 4. 請假兩段（病假、證明一次附兩段）；生理假沒有鈕（後端生理假新規則開關 off＝seg2_no_types 帶生理假） ──
            f = Fake(seg2=['ot', 'leave', 'trip'], no_types=['生理假'])
            p = open_req(br, f, 'leave')
            ok('請假：整天模式沒有「加第二段」', p.locator('#reqView .rq-seg-add').count() == 0)
            p.click('#reqView .rq-chip:has-text("病假")')
            p.click('#reqView .rq-chip:has-text("只請一段")')
            ok('請假：只請一段模式出現「＋ 加第二段」', p.locator('#reqView .rq-seg-add').count() == 1)
            p.click('#reqView .rq-chip:has-text("生理假")')
            ok('後端開關 off：生理假沒有「加第二段」', p.locator('#reqView .rq-seg-add').count() == 0 and '加第二段' not in txt(p))
            p.click('#reqView .rq-chip:has-text("病假")')
            CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '11:00')
            p.click('#reqView .rq-seg-add')
            CL.pick_time(p, 2, '15:00'); CL.pick_time(p, 3, '17:00')
            p.click('#reqView .rq-chip:has-text("生理假")')
            ok('後端開關 off：已經加了第二段再改選生理假 → 第二段收起來、不會送兩段', p.locator('#reqView .rq-seg').count() == 0 and p.locator('#reqView .rq-seg-add').count() == 0)
            p.click('#reqView .rq-chip:has-text("病假")')
            ok('改回病假：第二段原本填的還在', p.locator('#reqView .rq-seg').count() == 2)
            ok('請假兩段：合計「第一段 2 小時＋第二段 2 小時＝共 4 小時」＋「這張證明兩段共用，不用附兩次」', '第一段 2 小時＋第二段 2 小時＝共 4 小時' in txt(p) and '這張證明兩段共用，不用附兩次。' in txt(p))
            p.fill('#reqView input[type=text]', '早上、下午回診')
            p.set_input_files('#reqView input[type=file]', {'name': 'proof.jpg', 'mimeType': 'image/jpeg', 'buffer': bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00d2cf20ffd9')})
            shot(p, '06-請假兩段填好')
            submit(p); wait_mine(p)
            s = f.submits()
            up = [c for c in f.calls if c['action'] == 'line_hub_attach_put']
            ok('請假兩段：證明只上傳一次', len(up) == 1, len(up))
            want = {'kind': 'leave', 'date': TODAY, 'leave_type': '病假', 'reason': '早上、下午回診', 'segments': [{'start': '09:00', 'end': '11:00'}, {'start': '15:00', 'end': '17:00'}],
                    'attach_id': 'ATT1', 'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}
            ok('請假兩段：送出內容 kind／date／leave_type／reason／segments／attach_id（一個），沒有 start／end／hours', s[0]['body'] == want, s[0]['body'])
            t = txt(p)
            ok('請假兩段：成功訊息「會變成 2 張假單」、我的申請兩列都標「📎 已附證明」與「同一次送出」', '會變成 2 張假單，等主管審核' in t and t.count('📎 已附證明') == 2 and t.count('同一次送出・第') == 2, t)
            shot(p, '07-請假兩段送出成功')
            p.context.close()
            # ── 4b. 生理假兩段（2026-11-18 新後端：seg2_no_types＝[]）：有「加第二段」、送出帶 segments、同一天兩張 ──
            f = Fake(seg2=['leave'])
            p = open_req(br, f, 'leave')
            p.click('#reqView .rq-chip:has-text("生理假")'); p.click('#reqView .rq-chip:has-text("只請一段")')
            ok('生理假（新後端）：出現「＋ 加第二段」', p.locator('#reqView .rq-seg-add').count() == 1)
            ok('生理假（新後端）：額度沒讀到時不顯示「剩幾小時」（只用「次」）', '小時（上限' not in txt(p))
            CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '11:00')
            p.click('#reqView .rq-seg-add')
            CL.pick_time(p, 2, '15:00'); CL.pick_time(p, 3, '17:00')
            submit(p); wait_mine(p)
            s = f.submits()
            ok('生理假兩段：送出 leave_type 生理假＋segments 兩段，沒有 start／end／hours',
               len(s) == 1 and s[0]['body'].get('leave_type') == '生理假' and s[0]['body'].get('segments') == [{'start': '09:00', 'end': '11:00'}, {'start': '15:00', 'end': '17:00'}]
               and not any(k in s[0]['body'] for k in ('start', 'end', 'hours')), s[0]['body'] if s else None)
            t = txt(p)
            ok('生理假兩段：成功訊息「會變成 2 張假單」、我的申請標「同一次送出」兩列', '會變成 2 張假單，等主管審核' in t and t.count('同一次送出・第') == 2, t)
            shot(p, '07b-生理假兩段送出成功')
            p.context.close()
            # ── 4c. 選假別就先擋（2026-11-18）：病假今年用完、生理假本月已請 → 送出鈕不可按 ──
            sick0 = {'name': '病假', 'cap_days': 30, 'cap_h': 240, 'remain_h': 0, 'used_h': 240, 'basis': 'calendar'}
            mens = {'name': '生理假', 'cap_days': 3, 'cap_h': 24, 'remain_h': 16, 'used_h': 8, 'basis': 'calendar', 'used_n': 1, 'dates': [TODAY[:8] + '01' if TODAY[8:] != '01' else TODAY[:8] + '02'], 'unit': 'times'}
            f = Fake(seg2=['leave'], quota=[sick0, mens], extra_info={'hq': {'sick_used_up': True, 'mens_rules': True}})
            p = open_req(br, f, 'leave')
            p.wait_for_timeout(800)
            p.click('#reqView .rq-chip:has-text("病假")')
            ok('病假用完：選了就顯示「今年病假額度已用完（30 天），請改請事假」、送出鈕不可按',
               '今年病假額度已用完（30 天），請改請事假' in txt(p) and p.locator('#reqView button.primary').first.is_disabled(), txt(p)[:300])
            p.click('#reqView .rq-chip:has-text("生理假")')
            ok('生理假本月已請：選了就顯示「生理假每月一次，這個月已請過」、送出鈕不可按；額度顯示「剩 2 次」',
               '生理假每月一次，這個月已請過' in txt(p) and p.locator('#reqView button.primary').first.is_disabled() and '剩 2 次' in txt(p), txt(p)[:300])
            p.click('#reqView .rq-chip:has-text("事假")')
            ok('改選事假：沒有事前擋、送出鈕可以按', '請改請事假' not in txt(p) and not p.locator('#reqView button.primary').first.is_disabled())
            ok('事前擋沒有送出任何 req_submit', len(f.submits()) == 0)
            p.context.close()
            # 請假兩段超過 8 小時
            f = Fake(seg2=['leave'])
            p = open_req(br, f, 'leave')
            p.click('#reqView .rq-chip:has-text("事假")'); p.click('#reqView .rq-chip:has-text("只請一段")')
            CL.pick_time(p, 0, '08:00'); CL.pick_time(p, 1, '12:00'); p.click('#reqView .rq-seg-add'); CL.pick_time(p, 2, '13:00'); CL.pick_time(p, 3, '18:00')
            ok('請假兩段：合計 9 小時 → 「兩段合計 9 小時，超過 8 小時，請確認時間」', '兩段合計 9 小時，超過 8 小時，請確認時間' in txt(p), txt(p))
            submit(p); p.wait_for_timeout(400)
            ok('請假兩段超過 8 小時：沒送出', len(f.submits()) == 0)
            p.context.close()

            # ── 5. 出差兩段 ──
            f = Fake(seg2=['ot', 'leave', 'trip'])
            p = open_req(br, f, 'trip')
            ok('出差：整天模式沒有「加第二段」', p.locator('#reqView .rq-seg-add').count() == 0)
            p.click('#reqView .rq-chip:has-text("只一段")')
            ok('出差：只一段模式出現「＋ 加第二段」', p.locator('#reqView .rq-seg-add').count() == 1)
            CL.pick_time(p, 0, '09:00'); CL.pick_time(p, 1, '12:00'); p.click('#reqView .rq-seg-add'); CL.pick_time(p, 2, '14:00'); CL.pick_time(p, 3, '17:00')
            p.select_option('#reqView .rq-place-pick', '台北瑞光'); p.fill('#reqView .rq-why', '支援月初盤點，中午回總部開會')
            ok('出差兩段：合計 6 小時、地點欄寫「必填，兩段相同」、「兩段在不同地點，請分開送」', '第一段 3 小時＋第二段 3 小時＝共 6 小時' in txt(p) and '地點（必填，兩段相同）' in txt(p) and '兩段在不同地點，請分開送。' in txt(p))
            shot(p, '08-出差兩段填好')
            submit(p); wait_mine(p)
            want = {'kind': 'trip', 'date': TODAY, 'place': '台北瑞光', 'why': '支援月初盤點，中午回總部開會', 'segments': [{'start': '09:00', 'end': '12:00'}, {'start': '14:00', 'end': '17:00'}],
                    'action': 'req_submit', 'id_token': 'MOCK_ID_TOKEN_U1'}
            ok('出差兩段：送出內容 kind／date／place／why／segments', f.submits()[0]['body'] == want, f.submits()[0]['body'])
            t = txt(p)
            ok('出差兩段：成功訊息「會變成 2 張出差單」、我的申請標「第 1 段／共 2 段」', '會變成 2 張出差單，等主管審核' in t and '同一次送出・第 1 段／共 2 段' in t and '同一次送出・第 2 段／共 2 段' in t, t)
            shot(p, '09-出差兩段送出成功')
            p.context.close()

            # ── 6. N4：事假不再出現「本月第 N 次」 ──
            ym = TODAY[:7]
            old = [{'id': 'o%d' % i, 'created_at': '2026-11-0%dT09:00:00+08:00' % (i + 1), 'emp_id': 'E1', 'name': '林小美', 'kind': 'leave', 'leave_type': '事假', 'date': '%s-%02d' % (ym, i + 1), 'start': '', 'end': '', 'hours': 8,
                    'reason': '', 'status': 'approved', 'has_attach': False, 'warns': [], 'group': '', 'seg': None} for i in range(3)]
            f = Fake(seg2=False, requests=old)
            p = open_req(br, f, 'leave')
            p.click('#reqView .rq-chip:has-text("事假")')
            t = txt(p)
            ok('N4：本月已請 3 次事假、再選事假 → 沒有「本月第 N 次事假」', '本月第' not in t and '次事假' not in t, t)
            ok('N4：「事假應在前一天請」與「本月事假合計超過 3 天」照舊', '事假應在前一天請' in t and '本月事假合計' in t, t)
            p.context.close()
            f = Fake(seg2=False, requests=old[:1])
            p = open_req(br, f, 'leave'); p.click('#reqView .rq-chip:has-text("事假")')
            ok('N4：事假沒超過 3 天 → 只剩「應在前一天請」', '本月事假合計' not in txt(p) and '次事假' not in txt(p))
            p.context.close()

            # ── 7. 防呆：兩家合計超過 8 小時，加班要開在被支援那家 ──
            two_stores = [{'code': 'hq', 'name': HQ['name'], 'emp_id': 'HQ-02', 'emp_name': '張淳', 'support': False},
                          {'code': 'mztjs', 'name': JS['name'], 'emp_id': 'MZTJS16', 'emp_name': '張淳', 'support': True}]
            days = {'hq': [('08:00', '14:45')], 'mztjs': [('15:00', '17:00')]}
            f = Fake(stores=two_stores, days=days)
            p = open_req(br, f, 'ot')
            p.wait_for_selector('#reqView .rq-absorb', timeout=6000)
            t = txt(p)
            ok('防呆：總部 6.75＋金山 2＝8.75、目前選總部 → 提示「要開在被支援的「墨竹亭 新竹金山」」', '超過 8 小時的加班單要開在被支援的「%s」' % JS['name'] in t and '合計約 8.75 小時' in t, t)
            ok('防呆：有一顆鈕「改送到「墨竹亭 新竹金山」」', p.locator('#reqView .rq-absorb-switch').count() == 1)
            shot(p, '10-防呆提示')
            p.click('#reqView .rq-absorb-switch')
            p.wait_for_function("document.querySelector('#reqView select.rq-store').selectedOptions[0].textContent.indexOf('金山') >= 0", timeout=5000)
            p.wait_for_timeout(600)
            ok('防呆：按鈕一鍵切到金山、提示消失', p.locator('#reqView .rq-absorb').count() == 0 and '金山' in p.inner_text('#reqView .rq-head'))
            fill_ot(p, '15:00', '15:45', '金山加班')
            p.wait_for_timeout(500)
            ok('防呆：切到金山後，自動選店不會把人換回總部（提示欄沒有「送到這家」之類的字）', p.locator('#reqView .rq-absorb').count() == 0 and '金山' in p.inner_text('#reqView .rq-head'))
            submit(p); p.wait_for_timeout(800)
            ok('防呆只提示不擋：送出走到金山那家（/api/mztjs）', len([c for c in f.submits()]) == 1 and f.submits()[0]['code'] == 'mztjs', [(c['code']) for c in f.submits()])
            p.context.close()
            # 不出現：沒超過 8、沒帶 support、已經是被支援那家
            for label, kw, cond in (
                ('合計剛好 8 小時', dict(stores=two_stores, days={'hq': [('08:00', '13:00')], 'mztjs': [('14:00', '17:00')]}), None),
                ('後端沒帶 support（判斷不出來）', dict(stores=[{k: v for k, v in s.items() if k != 'support'} for s in two_stores], days=days), None),
                ('只有一家有打卡', dict(stores=two_stores, days={'hq': [('08:00', '19:00')], 'mztjs': []}), None),
            ):
                f = Fake(**kw)
                p = open_req(br, f, 'ot'); p.wait_for_timeout(1200)
                ok('防呆不出現：' + label, p.locator('#reqView .rq-absorb').count() == 0 and '要開在被支援' not in txt(p), txt(p)[:200])
                p.context.close()
            f = Fake(stores=[two_stores[1], two_stores[0]], days=days)   # 預設就選到被支援那家（金山排第一）
            p = open_req(br, f, 'ot'); p.wait_for_timeout(1200)
            ok('防呆不出現：目前選的就是被支援那家', p.locator('#reqView .rq-absorb').count() == 0 and '金山' in p.inner_text('#reqView .rq-head'))
            p.context.close()
            # 只綁一家：店別下拉照舊（沒有下拉、只有店名文字）、也沒有任何提示
            f = Fake(days=days)
            p = open_req(br, f, 'ot'); p.wait_for_timeout(800)
            ok('只綁一家：沒有店別下拉、只有店名文字，也沒有防呆提示', p.locator('#reqView select.rq-store').count() == 0 and HQ['name'] in p.inner_text('#reqView .rq-head') and p.locator('#reqView .rq-absorb').count() == 0)
            ok('只綁一家：不會去問別家的打卡（沒有 day_only 請求）', len([c for c in f.calls if c['body'].get('day_only')]) == 0)
            p.context.close()
            # 綁兩家：下拉照舊有兩個選項
            f = Fake(stores=two_stores, days={})
            p = open_req(br, f, 'ot'); p.wait_for_timeout(800)
            ok('綁兩家：店別下拉有兩家、選項照舊', p.locator('#reqView select.rq-store option').count() == 2)
            p.context.close()

            # ── 8. 綁兩家店、兩段在不同店打卡 → 要分開送 ──
            both = [{'code': 'hq', 'name': HQ['name'], 'emp_id': 'E1', 'emp_name': '林小美'}, {'code': 'mztjs', 'name': JS['name'], 'emp_id': 'E2', 'emp_name': '林小美'}]
            f = Fake(stores=both, days={'hq': [('09:00', '13:00')], 'mztjs': [('17:00', '21:00')]})
            p = open_req(br, f, 'ot')
            CL.pick_time(p, 0, '09:30'); CL.pick_time(p, 1, '12:30'); p.click('#reqView .rq-seg-add'); CL.pick_time(p, 2, '17:30'); CL.pick_time(p, 3, '20:30')
            p.wait_for_selector('#reqView .rq-auto-store.warn >> text=請分開送', timeout=6000)
            ok('兩家店：兩段在不同店打卡 → 表單上先提醒「第一段在…打卡、第二段在…打卡，兩段要送到不同的店，請分開送」', '第一段在%s打卡、第二段在%s打卡，兩段要送到不同的店，請分開送' % (HQ['name'], JS['name']) in txt(p), txt(p))
            p.fill('#reqView input[type=text]', '兩店'); submit(p); p.wait_for_timeout(800)
            ok('兩家店：按送出也擋下來、沒有送出 req_submit', len(f.submits()) == 0 and '請分開送' in txt(p))
            shot(p, '11-兩段在不同店-要分開送')
            p.context.close()

            br.close()
        print('\n全部通過：%d 項' % CL.n)
    finally:
        proc.terminate()


if __name__ == '__main__':
    main()
