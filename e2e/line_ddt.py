#!/usr/bin/env python3
"""LINE 打卡（clock-line.html＋req-line.js＋sched-line.js）資料帶入測試。

用法：E2E_MOCK_PORT=8961 /usr/bin/python3 e2e/line_ddt.py        （E2E_SEED=<種子> 可重現同一組資料）
每次執行：隨機挑兩家店、抽人與每個人的打卡情境、申請內容、班表 → 寫進 mock 資料檔 → Playwright 逐一操作畫面 →
預期值由 e2e/line_ddt_dataset.py 照規格獨立算（不 import 系統程式）→ 逐筆比對；clickmap 稽核每一顆按鈕。
mock 起在 E2E_MOCK_PORT（預設 8961），只打本機；會清掉本 worktree 的 mock/mock_data*.json。
"""
import base64
import glob
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import line_ddt_dataset as D  # noqa: E402
from clickmap import ClickMap, SKIP, _KEY_LOGIC  # noqa: E402
KEY_EL_JS = '(e) => { const keyOf = (e) => {%s}; return keyOf(e); }' % _KEY_LOGIC   # 從元素本身算 key（選擇器可能是 Playwright 語法，不能丟給 querySelector）

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('E2E_MOCK_PORT', '8961'))
BASE = f'http://localhost:{PORT}'
STORES = json.load(open(os.path.join(ROOT, 'tools', 'stores.json'), encoding='utf-8'))
BY_CODE = {s['code']: s for s in STORES}
SHOTS = os.path.join(ROOT, 'e2e', 'artifacts')
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10 ** 8))
RNG = random.Random(SEED ^ 0x5eed)
CM = ClickMap()
SKIP.update({'a「Leaflet」': '地圖套件版權連結（外部網站），不點', 'a「OpenStreetMap」': '地圖資料版權連結（外部網站），不點'})
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

n = 0
KNOWN = []   # 系統疑似 bug：標 KNOWN_FAIL、附種子，不改系統程式


def ok(name, cond, detail='', known=None):
    global n
    if not cond and known:
        KNOWN.append((name, known, detail))
        print('⚠ KNOWN_FAIL ' + name + '：' + known + '（種子 %d）' % SEED)
        return
    if not cond:
        raise AssertionError(name + ('：' + str(detail) if detail else ''))
    n += 1
    print('✓ ' + name)


# ── mock ──
def start_mock():
    try:
        urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
        raise SystemExit(f'port {PORT} 已有伺服器在跑，請設 E2E_MOCK_PORT 換一個')
    except OSError:
        pass
    for f in glob.glob(os.path.join(ROOT, 'mock', 'mock_data*.json')):
        os.remove(f)
    os.makedirs(SHOTS, exist_ok=True)
    log = open(os.path.join(SHOTS, 'mock_server_ddt.log'), 'w')
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'mock', 'mock_server.py')], env=dict(os.environ, MOCK_PORT=str(PORT)),
                            stdout=log, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('mock 起不來')


def dfile(code):
    return os.path.join(ROOT, 'mock', 'mock_data.json' if not code else 'mock_data_%s.json' % code)


def read_store(code):
    for i in range(40):   # mock 寫檔不是原子的：剛好寫到一半就等一下再讀
        try:
            return json.load(open(dfile(code), encoding='utf-8'))
        except (json.JSONDecodeError, FileNotFoundError):
            time.sleep(0.05)
    return json.load(open(dfile(code), encoding='utf-8'))


def write_store(code, d):
    json.dump(d, open(dfile(code), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def api(code, body):
    u = BASE + '/api' + ('/' + code if code else '')
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, data=json.dumps(body).encode()), timeout=10).read())


def tok(p):
    return 'MOCK_ID_TOKEN_' + p['line_user_id']


def events_of(code, emp_id):
    return [{'ts': e['ts'], 'type': e['type'], 'status': e['status']} for e in read_store(code)['events'] if e['emp_id'] == emp_id]


def file_events_raw(code, emp_id):
    return [e for e in read_store(code)['events'] if e['emp_id'] == emp_id]


def peer_events(gen, p):
    """同名（去空白）的人在別家店的卡（Rest.gs 跨店規則）。"""
    out = []
    for q in gen.people:
        if q['store'] != p['store'] and q['name'].replace(' ', '') == p['name'].replace(' ', ''):
            out += events_of(q['store'], q['emp_id'])
    return out


def now_tz():
    return datetime.now(D.TZ).replace(microsecond=0)


def shift_events(code, emp_id, minutes, only_last=False):
    """把這個人的卡全部（或最後一張）往前挪 N 分鐘＝假裝時間過去了。"""
    d = read_store(code)
    mine = [e for e in d['events'] if e['emp_id'] == emp_id]
    for e in (mine[-1:] if only_last else mine):
        e['ts'] = D.iso(D.parse_iso(e['ts']) - timedelta(minutes=minutes))
    write_store(code, d)


# ── 頁面 ──
LOG_JS = """
window.__geo = 0;
if (navigator.geolocation) ['getCurrentPosition', 'watchPosition'].forEach(function (f) {
  const o = navigator.geolocation[f].bind(navigator.geolocation);
  navigator.geolocation[f] = function () { window.__geo++; return o.apply(null, arguments); };
});
window.__calls = [];
window.__fake = {};
const _f = window.fetch;
window.fetch = function (url, o) {
  let a = ''; try { a = JSON.parse(o.body).action; } catch (e) {}
  window.__calls.push({ url: String(url), action: a, t: Date.now() });
  let fk = window.__fake[a];
  if (Array.isArray(fk)) fk = fk.length > 1 ? fk.shift() : fk[0];
  if (fk === 'real') fk = null;
  if (fk === 'lost') return _f.apply(this, arguments).then(function () { throw new TypeError('Failed to fetch'); });
  if (fk === 'abort') return Promise.reject(new TypeError('Failed to fetch'));
  if (fk === 'hang') return new Promise(function (res, rej) {
    if (o.signal) o.signal.addEventListener('abort', function () { rej(new DOMException('aborted', 'AbortError')); });
  });
  if (fk) return Promise.resolve(new Response(JSON.stringify(fk)));
  return _f.apply(this, arguments);
};
"""
DLG = {}


def spot(st):
    """店裡某個隨機點（半徑內、扣掉誤差後一定在範圍內）"""
    lat, lng = D.offset_point(st['lat'], st['lng'], RNG.uniform(0, max(0, st['radius_m'] - 12)), RNG.uniform(0, 360))
    return lat, lng, RNG.choice([5, 8, 10, 15])


def url(st, uid, extra='', loc=None, in_client=True):
    lat, lng, acc = loc or spot(st)
    q = f'mock_uid={uid}&api=/api&loc={lat},{lng}&acc={acc}&retry_ms=50' + ('&in_client=1' if in_client else '') + extra
    return BASE + '/clock-line.html?' + q, (lat, lng, acc)


def open_page(ctx, u, pre=None, accept=False):
    p = ctx.new_page()
    p.set_viewport_size({'width': 375, 'height': 812})
    p.add_init_script(LOG_JS)
    if pre:
        p.add_init_script(pre)
    DLG[id(p)] = {'accept': accept, 'msgs': []}

    def on_dialog(d):
        DLG[id(p)]['msgs'].append(d.message)
        d.accept() if DLG[id(p)]['accept'] else d.dismiss()
    p.on('dialog', on_dialog)
    p.goto(u)
    return p


def dlg(p, accept=None):
    if accept is not None:
        DLG[id(p)]['accept'] = accept
    return DLG[id(p)]['msgs']


def msg(p):
    return p.inner_text('#msg')


def hint(p):
    return p.inner_text('#hint')


def wait_msg(p, needle, timeout=10000):
    p.wait_for_function('(s) => (document.getElementById("msg").textContent + document.getElementById("hint").textContent).indexOf(s) >= 0', arg=needle, timeout=timeout)


def calls(p):
    return p.evaluate('window.__calls')


def wait_ready(p, name):
    p.wait_for_function('(s) => document.getElementById("who").textContent === s', arg=name, timeout=12000)
    p.wait_for_timeout(250)


def scan(p, screen):
    CM.scan(p, screen)


# 每次點／選之前都先掃一次畫面（比「每進一個畫面掃一次」更嚴：暫時出現的鍵也會被登記，之後沒點到就算漏測）
def key_of(p, sel):
    return p.locator(sel).first.evaluate(KEY_EL_JS)


def click(p, sel, note='點過'):
    scan(p, 'click:' + note)
    k = key_of(p, sel)   # 點之前算（點完畫面可能重畫、元素換掉）
    p.locator(sel).first.click()
    CM.mark(k, note)


def force_click(p, sel):
    """鍵被畫面停用（鎖）時解開並點下去，測後端擋下時畫面怎麼顯示；clickmap 一樣登記。"""
    scan(p, 'force:' + sel)
    k = key_of(p, sel)
    p.locator(sel).first.evaluate('(b) => { b.disabled = false; b.click(); }')
    CM.mark(k, '強制點（測後端擋）')


def select(p, sel, value, note='選過'):
    scan(p, 'select:' + note)
    k = key_of(p, sel)
    p.select_option(sel, value)
    CM.mark(k, note)


def pick_date(p, ymd, nth=0):
    scan(p, 'pick_date')
    box = p.locator('#reqView .rq-dpick').nth(nth)
    box.locator('select.rq-dm').select_option(ymd[:7])
    box.locator('select.rq-dd').select_option(ymd)
    CM.mark('select.rq-dm', '選月'); CM.mark('select.rq-dd', '選日')


def pick_time(p, nth, hm):
    scan(p, 'pick_time')
    box = p.locator('#reqView .rq-time').nth(nth)
    box.locator('select.rq-hh').select_option(hm[:2] if hm else '')
    box.locator('select.rq-mm').select_option(hm[3:] if hm else '')
    CM.mark('select.rq-hh', '選時'); CM.mark('select.rq-mm', '選分')


def stable_now(until):
    """倒數分鐘的無條件進位在整分邊界會變：離邊界 2 秒內就等一下再算，免得畫面與預期差 1。"""
    while True:
        now = now_tz()
        left = (until - now).total_seconds()
        frac = left % 60
        if left <= 0 or 2.0 < frac < 58.0:
            return now
        time.sleep(2.2)


def no_undefined(p, where):
    t = p.inner_text('body')
    ok(where + '：畫面沒有 undefined／null 字樣', 'undefined' not in t and 'null' not in t, t[:200])


def req_text(p):
    return p.inner_text('#reqView')


def wait_req(p, needle, timeout=10000):
    p.wait_for_function('(s) => document.getElementById("reqView").textContent.indexOf(s) >= 0', arg=needle, timeout=timeout)


def err_box(p):
    p.wait_for_selector('#reqView .rq-box.err', timeout=8000)
    return p.inner_text('#reqView .rq-box.err')


def submit(p):
    click(p, '#reqView button.primary', '送出申請')


# ═══════════════════════════════════════════════════════════════
def main():
    print(f'種子 E2E_SEED={SEED}')
    gen = D.Gen(SEED, STORES).build()
    A, B = gen.A, gen.B
    print(f'店：A={A["code"] or "光復"}（擋卡開） B={B["code"] or "光復"}（擋卡{"開" if gen.rest_on[B["code"]] else "關"}）；人數 {len(gen.people)}')
    proc = start_mock()
    try:
        for code in sorted({p['store'] for p in gen.people} | {''}):
            write_store(code, D.store_file_data(gen, code))
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context()
            phases = [('pick', phase_pick), ('bind', phase_notice_bind), ('punch', phase_punch), ('rest', phase_rest), ('qr', phase_qr),
                      ('failures', phase_failures), ('req', phase_req), ('miss', phase_miss), ('dual', phase_dual), ('sched', phase_sched)]
            only = [x for x in os.environ.get('E2E_PHASES', '').split(',') if x]   # 除錯用：只跑某幾段（clickmap 稽核只在跑全部時算數）
            for name, fn in phases:
                if not only or name in only:
                    fn(ctx, gen)
            rep = CM.report()
            if only:
                print('（E2E_PHASES 只跑 %s：clickmap 稽核略過；看過 %d、點過 %d）' % (','.join(only), rep['total'], rep['clicked']))
            else:
                ok('clickmap：可點元素零漏測（共 %d 個，點過 %d，刻意略過 %d）' % (rep['total'], rep['clicked'], len(rep['skipped'])),
                   not rep['missed'] and not rep['extra'], rep)
            br.close()
    except Exception:
        print(f'\n❌ 失敗，重現：E2E_SEED={SEED} E2E_MOCK_PORT={PORT} /usr/bin/python3 e2e/line_ddt.py')
        raise
    finally:
        proc.kill()
    print(f'\n✅ LINE 打卡資料帶入測試：共 {n + len(KNOWN)} 項，通過 {n}，失敗 0，KNOWN_FAIL {len(KNOWN)}（種子 {SEED}）')
    for name, why, detail in KNOWN:
        print('   KNOWN_FAIL：%s — %s' % (name, why))


# ── 1. GPS 挑店（clock-line-core.js，畫面自己判斷、不打後端）──
def phase_pick(ctx, gen):
    uid = next(p for p in gen.people if p['scenario'] == 'fresh' and p['store'] == gen.A['code'])['line_user_id']
    for st in [gen.A, gen.B] + RNG.sample([s for s in STORES if s['code'] not in (gen.A['code'], gen.B['code'])], 2):
        # 範圍內：直接問那家店；範圍外：最近的店與距離都要對；誤差折抵：同一點給大誤差就進範圍、小誤差就不在
        far = D.offset_point(st['lat'], st['lng'], st['radius_m'] + RNG.randint(60, 900), RNG.uniform(0, 360))
        edge = D.offset_point(st['lat'], st['lng'], st['radius_m'] + 40, RNG.uniform(0, 360))
        for lat, lng, acc, label in [(far[0], far[1], RNG.choice([5, 20]), '店外'), (edge[0], edge[1], 70, '邊緣＋大誤差折抵'), (edge[0], edge[1], 20, '邊緣＋小誤差')]:
            status, who, dist = D.pick_store(lat, lng, acc, STORES)
            u, _ = url(st, uid, loc=(lat, lng, acc))
            p = open_page(ctx, u)
            if status == 'ok':
                p.wait_for_function('document.getElementById("storeName").textContent !== "定位中…" && document.getElementById("storeName").textContent !== "讀取中…"', timeout=12000)
                p.wait_for_timeout(300)
                ok(f'挑店（{st["name"]}／{label}）：扣掉誤差後在範圍內 → 畫面直接問這家店', p.inner_text('#storeName') == who['name']
                   and calls(p)[0]['url'].endswith('/api' + ('/' + who['code'] if who['code'] else '')), (p.inner_text('#storeName'), calls(p)[:1]))
            elif status == 'none':
                wait_msg(p, '不在任何打卡地點範圍內')
                want = f'你不在任何打卡地點範圍內（最近的是{who["name"]}，約 {dist} 公尺）'
                ok(f'挑店（{st["name"]}／{label}）：不在範圍 → 寫最近的店與距離（逐字）、不打後端、可重新定位', msg(p) == want and calls(p) == []
                   and p.is_visible('#btnRetry') and p.is_disabled('#btnIn') and p.inner_text('#storeName') == '不在打卡範圍', (msg(p), want, calls(p)))
            p.close()
    # 兩家都符合＝分不出來：挑距離最近的兩家店的中點、誤差 100
    pairs = sorted(((D.distance_m(a['lat'], a['lng'], b['lat'], b['lng']), a, b) for i, a in enumerate(STORES) for b in STORES[i + 1:]), key=lambda x: x[0])
    _, s1, s2 = pairs[0]
    mid = ((s1['lat'] + s2['lat']) / 2, (s1['lng'] + s2['lng']) / 2)
    status, who, _ = D.pick_store(mid[0], mid[1], 100, STORES)
    ok('挑店：資料檢查——最近兩家店的中點、誤差 100 公尺應判定分不出來', status == 'ambiguous' and set(who) == {s1['code'], s2['code']}, (status, who))
    u, _ = url(s1, uid, loc=(mid[0], mid[1], 100))
    p = open_page(ctx, u)
    wait_msg(p, '分不出你在哪一家店')
    ok('挑店：兩家都可能 → 擋下（逐字）、不打後端、求助類別「定位不準」', msg(p) == '定位不夠準，分不出你在哪一家店' and hint(p) == '請開啟手機的「精確位置」與 Wi‑Fi 後再試一次'
       and calls(p) == [] and p.is_disabled('#btnIn') and p.inner_text('#storeName') == '分不出在哪一家店', (msg(p), hint(p), calls(p)))
    scan(p, '挑店失敗畫面')
    click(p, '#btnHelp', '求助')
    p.wait_for_function('window.__closed === true', timeout=5000)
    ok('挑店：按「看排除步驟」代送「打卡求助：定位不準」並關閉', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：定位不準'}], p.evaluate('window.__sent'))
    p.close()


# ── 2. 店內公告＋綁定（輸入全名／名字被綁走／跨店同名建議）──
def phase_notice_bind(ctx, gen):
    A, B = gen.A, gen.B
    mgr = gen.managers[A['code']]
    for nt in gen.notices:
        r = api(A['code'], {'action': 'mgr_add_notice', 'mgr_key': mgr['key'], 'text': nt['text'], 'ends_on': ''})
        ok('公告：主管在 A 店發布「%s」' % nt['text'][:8], r.get('ok') is True, r)
    # 2a. 還沒綁：店家回 not_bound → 問光復 → 綁定框
    nb = next(p for p in gen.people if p['scenario'] == 'bind_new')
    nb['line_user_id'] = 'U' + ''.join(RNG.choice('0123456789abcdef') for _ in range(10))
    u, fix = url(A, nb['line_user_id'])
    p = open_page(ctx, u)
    p.wait_for_selector('#bindBox:not([hidden])', timeout=12000)
    c = calls(p)
    ok('綁定：開頁先問挑到的店、它說沒綁 → 改問光復 line_hub_status', [x['action'] for x in c] == ['liff_status', 'line_hub_status']
       and c[0]['url'].endswith('/api' + ('/' + A['code'] if A['code'] else '')) and c[1]['url'].endswith('/api'), c)
    ok('綁定：第一次使用的標題與說明（逐字）', p.inner_text('#bindTitle') == '第一次使用，請輸入你的全名'
       and p.inner_text('#bindHint') == f'綁定「{A["name"]}」：要人在店裡，名字要和店裡名冊一樣' and p.inner_text('#btnBind') == '綁定', (p.inner_text('#bindTitle'), p.inner_text('#bindHint')))
    scan(p, '綁定框')
    click(p, '#btnBind', '空白名字')
    ok('綁定：沒輸入名字 → 「請輸入你的全名」、不打後端', p.inner_text('#bindError') == '請輸入你的全名' and not any(x['action'] == 'line_bind_name' for x in calls(p)), p.inner_text('#bindError'))
    wrong = nb['name'] + '錯'
    p.fill('#bindName', wrong); click(p, '#btnBind', '錯名字')
    p.wait_for_function('document.getElementById("bindError").textContent.length > 0', timeout=8000)
    want = f'「{A["name"]}」的名冊上沒有「{wrong}」。請確認是全名、沒有錯字；名冊上沒有你請主管把你加進去。'
    ok('綁定：名冊上沒有這個名字 → 後端字句（逐字）', p.inner_text('#bindError') == want, (p.inner_text('#bindError'), want))
    taken = next(q for q in gen.people if q['scenario'] == 'bind_taken')
    p.fill('#bindName', ' ' + taken['name'] + ' '); click(p, '#btnBind', '別人的名字')
    p.wait_for_function('document.getElementById("bindError").textContent.indexOf("已經綁定") >= 0', timeout=8000)
    ok('綁定：名字已被別的 LINE 綁走 → 擋下（逐字；名字前後空白會被去掉）',
       p.inner_text('#bindError') == f'「{taken["name"]}」已經綁定別的 LINE 帳號。如果那不是你，請立刻告知主管在值班核定頁解除。', p.inner_text('#bindError'))
    p.fill('#bindName', nb['name']); click(p, '#btnBind', '正確全名')
    wait_ready(p, nb['name'])
    row = next(r for r in read_store(A['code'])['roster'] if r['emp_id'] == nb['emp_id'])
    lg = read_store(A['code']).get('liff_bind_log', [])
    ok('綁定：正確全名 → 名冊寫入這個 LINE、綁定紀錄 bind_name、畫面直接問店家變 ready', row['line_user_id'] == nb['line_user_id'] and row['line_bound_at']
       and lg and lg[-1]['emp_id'] == nb['emp_id'] and lg[-1]['type'] == 'bind_name' and calls(p)[-1]['action'] == 'liff_status', (row, lg[-1:]))
    ok('綁定後：店名、姓名、班別時間都對', p.inner_text('#storeName') == A['name'] and p.inner_text('#who') == nb['name']
       and p.inner_text('#shift') == f'上班時間 {nb["shift_in"]} / 下班時間 {nb["shift_out"]}', (p.inner_text('#shift'), nb['shift_in'], nb['shift_out']))
    ok('綁定後：沒有任何卡 → 「今天還沒有打卡紀錄」、兩顆鍵都能按', p.inner_text('#today') == '今天還沒有打卡紀錄' and not p.is_disabled('#btnIn') and not p.is_disabled('#btnOut'), p.inner_text('#today'))
    # 店內公告：多則輪播、HTML 當純文字
    texts = [x['text'] for x in gen.notices]
    p.wait_for_selector('#noticeBox:not([hidden])', timeout=5000)
    first = p.inner_text('#noticeMsg')
    ok('公告：打卡頁最上方顯示 A 店公告（%d 則、輪播點 %d）' % (len(texts), len(texts) if len(texts) > 1 else 0), first in texts
       and p.locator('#noticeDots i').count() == (len(texts) if len(texts) > 1 else 0) and p.locator('#noticeMsg b').count() == 0, (first, texts))
    if len(texts) > 1:
        p.wait_for_function('t => document.getElementById("noticeMsg").textContent !== t', arg=first, timeout=8000)
        ok('公告：5 秒換下一則', p.inner_text('#noticeMsg') in texts and p.inner_text('#noticeMsg') != first, p.inner_text('#noticeMsg'))
    no_undefined(p, '綁定後')
    p.screenshot(path=os.path.join(SHOTS, 'ddt_綁定後.jpg'), type='jpeg', quality=70)
    p.close()
    # 2b. 跨店同名建議：A 店已綁的人到 B 店，B 名冊有同名未綁 → 帶出名字請本人確認
    cr = next(q for q in gen.people if q['scenario'] == 'bind_cross')
    u, _ = url(B, cr['line_user_id'])
    p = open_page(ctx, u)
    p.wait_for_selector('#bindBox:not([hidden])', timeout=12000)
    ok('跨店綁定：B 店沒綁 → 光復帶出「你在別家店已綁定為「名字」」、名字預填、按鈕「是我，綁定」（逐字）',
       p.inner_text('#bindTitle') == f'你在別家店已綁定為「{cr["name"]}」' and p.inner_text('#bindHint') == f'「{B["name"]}」的名冊上也有這個名字，是你本人就按下面的按鈕。'
       and p.input_value('#bindName') == cr['name'] and p.inner_text('#btnBind') == '是我，綁定', (p.inner_text('#bindTitle'), p.inner_text('#bindHint'), p.inner_text('#btnBind')))
    click(p, '#btnBind', '是我，綁定')
    wait_ready(p, cr['name'])
    tb = next(q for q in gen.people if q['scenario'] == 'bind_cross_target')
    row = next(r for r in read_store(B['code'])['roster'] if r['emp_id'] == tb['emp_id'])
    lg = read_store(B['code']).get('liff_bind_log', [])
    ok('跨店綁定：B 店名冊綁上同一個 LINE、綁定紀錄標 bind_auto（伺服器自己判斷）', row['line_user_id'] == cr['line_user_id'] and lg and lg[-1]['type'] == 'bind_auto', (row, lg[-1:]))
    ok('跨店綁定後：店名是 B 店', p.inner_text('#storeName') == B['name'], p.inner_text('#storeName'))
    tb['line_user_id'] = cr['line_user_id']
    p.close()


# ── 3. 打卡：每個人照自己的情境 ──
def expect_open(gen, p, now):
    evs = events_of(p['store'], p['emp_id'])
    g = D.guard(evs, now)
    rest = D.rest_expect(evs, peer_events(gen, p), now, gen.rest_on[p['store']]) if g['blocked'] != 'in' else None
    today = now.strftime('%Y-%m-%d')
    tl = [e for e in evs if e['ts'][:10] == today and e['status'] in ('ok', 'pending_device_approval')]
    today_txt = ('今天：' + '、'.join(('上班 ' if e['type'] == 'in' else '下班 ') + e['ts'][11:16] + ('（待核准）' if e['status'] == 'pending_device_approval' else '') for e in tl)) if tl else '今天還沒有打卡紀錄'
    locked = g['until'] is not None and g['until'] > now
    rest_blocked = bool(rest) and (rest['until'] is None or now < rest['until'])
    in_label = D.lock_label('in', g['until'], now) if locked else ('上班（%s 後）' % D.hm_of(rest['until']) if rest_blocked and rest['until'] else '上班')
    out_label = D.lock_label('out', g['until'], now) if locked else '下班'
    return {'evs': evs, 'guard': g, 'rest': rest, 'today': today_txt, 'in_disabled': locked or rest_blocked, 'out_disabled': locked,
            'in_label': in_label, 'out_label': out_label, 'msg': rest['reason'] if rest_blocked else '', 'hint': rest['hint'] if rest_blocked else ''}


def check_open(gen, p, page, label):
    """開頁：今天的卡、兩顆鍵狀態與文字、休息不足的原因都照規格。回預期（含開頁時的 now）。"""
    wait_ready(page, p['name'])
    until = D.guard(events_of(p['store'], p['emp_id']), now_tz())['until']
    now = stable_now(until) if until else now_tz()
    ex = expect_open(gen, p, now)
    got = {'today': page.inner_text('#today'), 'in_disabled': page.is_disabled('#btnIn'), 'out_disabled': page.is_disabled('#btnOut'),
           'in_label': page.inner_text('#btnIn'), 'out_label': page.inner_text('#btnOut'), 'msg': msg(page), 'hint': hint(page)}
    want = {k: ex[k] for k in got}
    ok(f'{label}：開頁狀態（今天的卡／鍵狀態與文字／休息不足原因）逐項＝規格', got == want, (got, want))
    ex['now'] = now
    return ex


def after_punch_ok(gen, p, page, typ, label, extra_msg='', stay_open=False, n_before=None):
    """打卡成功後：訊息逐字、資料檔那張卡、兩顆鍵鎖 10 分、代送「打卡」、秒數紀錄。"""
    code = p['store']
    lab = '上班' if typ == 'in' else '下班'
    wait_msg(page, lab + '打卡成功')
    raw = file_events_raw(code, p['emp_id'])
    e = raw[-1]
    ok(f'{label}：資料檔多一張 {lab} 卡、狀態 ok、裝置碼 line:<LINE 帳號>', e['type'] == typ and e['status'] == 'ok' and e['device_id'] == 'line:' + p['line_user_id']
       and (n_before is None or len(raw) == n_before + 1), e)
    hm = e['ts'][11:16]
    want = f'{lab}打卡成功 {hm}\n地點：{BY_CODE[code]["name"]}' + extra_msg + '\n\n' + D.greeting(typ, e['ts'])
    ok(f'{label}：成功訊息逐字（時間、地點、提醒、問候語由打卡時間決定）', msg(page) == want, (msg(page), want))
    ok(f'{label}：打完兩顆鍵立刻停用', page.is_disabled('#btnIn') and page.is_disabled('#btnOut'))
    if stay_open:   # 畫面留著（有東西要同仁看）：送完「打卡」後解除忙碌，倒數字樣才畫得出來；要關閉的畫面維持忙碌、不必畫
        page.wait_for_function('document.getElementById("btnIn").textContent.indexOf("分後") >= 0', timeout=5000)
        ok(f'{label}：畫面留著時兩顆都寫「（10 分後）」、仍停用', page.is_disabled('#btnIn') and page.is_disabled('#btnOut')
           and page.inner_text('#btnIn') == '上班（10 分後）' and page.inner_text('#btnOut') == '下班（10 分後）', (page.inner_text('#btnIn'), page.inner_text('#btnOut')))
    tl = [x for x in file_events_raw(code, p['emp_id']) if x['ts'][:10] == e['ts'][:10] and x['status'] == 'ok']
    ok(f'{label}：今天的卡列表立刻加上這張', page.inner_text('#today') == '今天：' + '、'.join(('上班 ' if x['type'] == 'in' else '下班 ') + x['ts'][11:16] for x in tl), page.inner_text('#today'))
    scan(page, label + ' 打卡成功後')
    page.wait_for_timeout(2200)
    sent = page.evaluate('window.__sent')
    closed = page.evaluate('window.__closed === true')
    ok(f'{label}：代送「打卡」給機器人、{"畫面不自動關（有要同仁看的東西）" if stay_open else "1.5 秒後關閉"}', sent == [{'type': 'text', 'text': '打卡'}] and closed == (not stay_open), (sent, closed))
    for _ in range(40):
        rows = read_store('').get('punch_timing', [])
        if rows and rows[-1]['uid'] == p['line_user_id']:
            break
        time.sleep(0.1)
    ok(f'{label}：等待秒數記在光復（店碼、類型、ok、有後端各步驟毫秒數）', rows and rows[-1]['store'] == code and rows[-1]['type'] == typ and rows[-1]['outcome'] == 'ok'
       and rows[-1]['steps'].get('write') == 900, rows[-1:])
    return e


def phase_punch(ctx, gen):
    A, B = gen.A, gen.B
    punchers = [p for p in gen.people if p['scenario'] in ('fresh', 'lock', 'missed_out', 'missed_in', 'overtime', 'two_shift')]
    for p in punchers:
        st = BY_CODE[p['store']]
        label = f'{p["scenario"]}@{st["code"] or "光復"}（{p["name"]}）'
        if p['scenario'] == 'lock':   # 時間敏感：開頁前才把那張卡放到 5 分 30 秒前
            d = read_store(p['store'])
            for e in [x for x in d['events'] if x['emp_id'] == p['emp_id']][-1:]:
                e['ts'] = D.iso(now_tz() - timedelta(minutes=5, seconds=30))
            write_store(p['store'], d)
        if p['scenario'] == 'two_shift' and p['store'] == A['code']:   # 順便測「申請結果告知」：先讓主管核准一筆、退回一筆
            mgr = gen.managers[A['code']]
            d1 = (now_tz() + timedelta(days=3)).strftime('%Y-%m-%d'); d2 = (now_tz() - timedelta(days=1)).strftime('%Y-%m-%d')
            r1 = api(A['code'], {'action': 'req_submit', 'id_token': tok(p), 'kind': 'leave', 'date': d1, 'leave_type': '事假', 'hours': '4', 'reason': '家裡有事'})
            r2 = api(A['code'], {'action': 'req_submit', 'id_token': tok(p), 'kind': 'ot', 'date': d2, 'start': '18:00', 'end': '20:30', 'reason': '盤點'})
            ok(f'{label}：先用 API 送兩筆申請（請假、加班）', r1.get('ok') and r2.get('ok'), (r1, r2))
            a1 = api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': r1['request']['id'], 'decision': 'approve'})
            a2 = api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': r2['request']['id'], 'decision': 'reject', 'reason': '那天沒有加班'})
            ok(f'{label}：主管核准請假、退回加班（退回要理由）', a1.get('status') == 'approved' and a2.get('status') == 'rejected', (a1, a2))
            p['notes'] = ['✓ 主管已核准：' + D.req_summary({'kind': 'leave', 'date': d1, 'leave_type': '事假', 'hours': 4}),
                          '✕ 申請被退回：' + D.req_summary({'kind': 'ot', 'date': d2, 'start': '18:00', 'end': '20:30', 'hours': 2.5}) + '（那天沒有加班）']
        u, fix = url(st, p['line_user_id'])
        page = open_page(ctx, u)
        ex = check_open(gen, p, page, label)
        scan(page, '打卡畫面 ' + label)
        n0 = len(file_events_raw(p['store'], p['emp_id']))
        if p['scenario'] in ('fresh', 'two_shift', 'missed_out'):
            dlg(page, accept=True)
            click(page, '#btnIn', '上班')
            md = D.missed_detail(ex['evs'], 'in', D.iso(now_tz() + timedelta(seconds=5)))   # 這次之前的卡決定提醒（打卡時間只差幾秒，7 天窗不受影響）
            extra = ('\n\n⚠️ ' + md['text'] if md['text'] else '') + ('\n\n' + '\n'.join(p['notes']) if p.get('notes') else '')
            e = after_punch_ok(gen, p, page, 'in', label, extra_msg=extra, stay_open=bool(md['text'] or p.get('notes')), n_before=n0)
            ok(f'{label}：資料檢查——情境 {p["scenario"]} 的忘打卡提醒{"有" if p["scenario"] == "missed_out" else "沒有"}出現', bool(md['text']) == (p['scenario'] == 'missed_out'), md)
            ok(f'{label}：距離＝扣誤差前的原始距離（0.1 公尺）、座標照送出的', abs(e['lat'] - fix[0]) < 1e-9 and abs(e['lng'] - fix[1]) < 1e-9
               and e['distance_m'] == D.js_round(D.distance_m(st['lat'], st['lng'], fix[0], fix[1]), 1) and e['accuracy_m'] == fix[2], (e, fix))
            if p.get('notes'):
                d = read_store(p['store'])
                ok(f'{label}：告知過的申請標 seen_at（只告知一次）', all(x.get('seen_at') for x in d['requests'] if x['emp_id'] == p['emp_id'] and x['status'] in ('approved', 'rejected')), d['requests'])
            if md['text']:
                ok(f'{label}：有漏卡 → 出現「申請補登」', page.is_visible('#btnMissReq'))
                click(page, '#btnMissReq', '申請補登')
                page.wait_for_selector('#reqView select.rq-date', timeout=10000)
                page.wait_for_selector('#reqView .rq-rec', timeout=10000)
                page.wait_for_timeout(200)
                di = D.day_info(events_of(p['store'], p['emp_id']), md['date'])
                on = page.locator('#reqView .rq-chip.on').all_inner_texts()
                fixed = page.locator('#reqView .rq-fixed').all_inner_texts()
                ok(f'{label}：申請補登 → 忘打卡分頁、日期＝漏卡那天、預選「下班卡」、當天紀錄逐字', page.input_value('#reqView select.rq-date') == md['date']
                   and page.inner_text('#reqView .rq-tabs button.on') == '忘打卡' and page.inner_text('#reqView .rq-rec') == D.rec_text(di['punches'])
                   and (('下班卡' in on) if len(di['options']) > 1 else fixed == ['下班卡（系統查到的）']), (on, fixed, di, page.inner_text('#reqView .rq-rec')))
                ok(f'{label}：忘打卡只給實際下班時間欄', '實際下班時間' in req_text(page) and '實際上班時間' not in req_text(page))
            else:
                ok(f'{label}：沒漏卡 → 沒有「申請補登」', not page.is_visible('#btnMissReq'))
            if p['scenario'] == 'fresh':
                page.screenshot(path=os.path.join(SHOTS, f'ddt_打卡成功_{st["code"] or "gf"}.jpg'), type='jpeg', quality=70)
                page.close()
                # 過了 10 分鐘（把那張卡往前挪 11 分）：兩顆都能按；再按上班跳確認框（逐字）；取消不送、確定送出且成功
                shift_events(p['store'], p['emp_id'], 11, only_last=True)
                u, fix = url(st, p['line_user_id'])
                page = open_page(ctx, u)
                ex2 = check_open(gen, p, page, label + '／過 10 分鐘後')
                ok(f'{label}：過了 10 分鐘兩顆都能按（中午忘打下班卡，晚上回來也打得了）', not page.is_disabled('#btnIn') and not page.is_disabled('#btnOut'))
                last = ex2['guard']['last']
                dlg(page, accept=False)
                click(page, '#btnIn', '同型再按（取消）')
                page.wait_for_timeout(400)
                ms = dlg(page)
                ok(f'{label}：再按上班 → 確認框講「HH:MM 已打過上班卡…忘打卡補」（逐字）；取消＝不送', ms == [D.same_type_msg(last['ts'][11:16], 'in')]
                   and not any(x['action'] == 'liff_punch' for x in calls(page)), (ms, D.same_type_msg(last['ts'][11:16], 'in')))
                dlg(page, accept=True)
                n0 = len(file_events_raw(p['store'], p['emp_id']))
                md2 = D.missed_detail(events_of(p['store'], p['emp_id']), 'in', D.iso(now_tz() + timedelta(seconds=5)))   # 用按下前的卡算（提醒只看這次之前）
                click(page, '#btnIn', '同型再按（確定）')
                after_punch_ok(gen, p, page, 'in', label + '／同型第二張', extra_msg='\n\n⚠️ ' + md2['text'], stay_open=True, n_before=n0)
                ok(f'{label}：同型第二張：伺服器照收（超過 10 分鐘）、提醒上一張上班卡沒有下班卡', md2['miss_type'] == 'out' and md2['date'] == last['ts'][:10], md2)
            page.close()
        elif p['scenario'] == 'lock':
            other = 'out' if p['lock_type'] == 'in' else 'in'
            g = ex['guard']
            now = stable_now(g['until'])
            reason, hnt = D.guard_reject(D.guard(ex['evs'], now), other, now)
            dlg(page, accept=True)
            force_click(page, '#btnOut' if other == 'out' else '#btnIn')
            wait_msg(page, '打卡失敗')
            lab = '上班' if other == 'in' else '下班'
            ok(f'{label}：畫面沒擋到也會被伺服器擋（10 分鐘鎖）：原因與怎麼辦逐字', msg(page) == f'{lab}打卡失敗\n原因：{reason}\n怎麼辦：{hnt}', (msg(page), reason, hnt))
            ok(f'{label}：被擋的卡不寫進資料檔、重讀後鍵仍鎖', len(file_events_raw(p['store'], p['emp_id'])) == n0 and page.is_disabled('#btnIn') and page.is_disabled('#btnOut'))
            page.close()
        elif p['scenario'] == 'missed_in':
            dlg(page, accept=True)
            click(page, '#btnOut', '下班（今天沒上班卡）')
            page.wait_for_timeout(300)
            ms = dlg(page)
            md = D.missed_detail(ex['evs'], 'out', D.iso(now_tz() + timedelta(seconds=5)))
            e = after_punch_ok(gen, p, page, 'out', label, extra_msg='\n\n⚠️ ' + md['text'], stay_open=True, n_before=n0)
            # 確認框規格：上一張算數的卡（12 小時內）沒有、今天也沒有打成功的上班卡才問（20 小時前那段班若落在今天就不問）
            has_in_today = any(x['type'] == 'in' and x['status'] in ('ok', 'pending_device_approval') and x['ts'][:10] == ex['now'].strftime('%Y-%m-%d') for x in ex['evs'])
            want_dlg = ['你今天還沒打上班卡，確定要打下班嗎？'] if (not ex['guard']['last'] and not has_in_today) else []
            ok(f'{label}：{"今天沒上班卡 → 先跳「你今天還沒打上班卡，確定要打下班嗎？」" if want_dlg else "今天有打成功的上班卡 → 不問「還沒打上班卡」"}', ms == want_dlg, (ms, want_dlg))
            ok(f'{label}：提醒{"寫「沒有打成功（不在範圍內）」" if p["rejected_in"] else "寫「沒有打上班卡」"}（被擋的上班卡要分開講）',
               ('不在範圍內' in md['text']) == p['rejected_in'] and md['miss_type'] == 'in' and md['date'] == e['ts'][:10], md)
            click(page, '#btnMissReq', '申請補登')
            page.wait_for_selector('#reqView .rq-rec', timeout=10000)
            page.wait_for_timeout(200)
            di = D.day_info(events_of(p['store'], p['emp_id']), e['ts'][:10])
            fixed = page.locator('#reqView .rq-fixed').all_inner_texts()
            want_fixed = [D.MISS_LABEL[di['options'][0]] + '（系統查到的）'] if len(di['options']) == 1 else []
            ok(f'{label}：申請補登 → 日期＝今天、缺哪張卡＝規格 {di["options"]}、當天紀錄含剛打的下班卡', page.input_value('#reqView select.rq-date') == e['ts'][:10]
               and fixed == want_fixed and page.inner_text('#reqView .rq-rec') == D.rec_text(di['punches']), (fixed, want_fixed, page.inner_text('#reqView .rq-rec'), di))
            page.close()
        elif p['scenario'] == 'overtime':
            dlg(page, accept=True)
            click(page, '#btnOut', '下班（超時）')
            wait_msg(page, '下班打卡成功')
            e = file_events_raw(p['store'], p['emp_id'])[-1]
            evs = events_of(p['store'], p['emp_id'])
            oh = D.ot_hint(evs, e['ts'], [])
            ok(f'{label}：資料檢查——這段班 > 8 小時應提示加班', oh is not None and oh['hours'] > 8, oh)
            after_punch_ok(gen, p, page, 'out', label, stay_open=True, n_before=n0)
            page.wait_for_selector('#btnOtReq:not([hidden])', timeout=5000)
            ok(f'{label}：超時提示「今天出勤 X 小時，超過 8 小時。要申請加班嗎？」（X 兩位小數、照規格加總當天各段）',
               page.inner_text('#otHint') == f'今天出勤 {D.js_num(oh["hours"])} 小時，超過 8 小時。要申請加班嗎？', (page.inner_text('#otHint'), oh))
            page.screenshot(path=os.path.join(SHOTS, f'ddt_超時提示_{st["code"] or "gf"}.jpg'), type='jpeg', quality=70)
            click(page, '#btnOtReq', '申請加班')
            page.wait_for_selector('#reqView .rq-tabs button.on', timeout=10000)
            vals = page.evaluate("() => [...document.querySelectorAll('#reqView .rq-dpick, #reqView .rq-time')].map(i => i.classList.contains('rq-dpick') ? i.querySelector('select.rq-dd').value : [...i.querySelectorAll('select')].map(s => s.value).join(':'))")
            ok(f'{label}：加班分頁預填 日期＝上班那天、起＝滿 8 小時那一刻（往前取整 15 分）、迄＝下班時間', page.inner_text('#reqView .rq-tabs button.on') == '加班'
               and vals == [oh['date'], oh['start'], oh['end']], (vals, oh))
            reason = RNG.choice(['外送訂單多', '包場收尾', '月底盤點'])
            page.fill('#reqView input[type=text]', reason)
            submit(page)
            wait_req(page, '✓ 已送出')
            row = {'kind': 'ot', 'date': oh['date'], 'start': oh['start'], 'end': oh['end'], 'hours': D.span_hours(oh['start'], oh['end']), 'reason': reason}
            ok(f'{label}：加班申請送出 → 摘要逐字、跳到我的申請、第一筆標題與副標逐字',
               page.inner_text('#reqView .rq-box.ok') == '✓ 已送出：' + D.req_summary(row) + '\n等主管審核'
               and page.inner_text('#reqView .rq-tabs button.on') == '我的申請'
               and page.locator('#reqView .rq-item').first.locator('.rq-t span').first.inner_text() == D.mine_title(row)
               and page.locator('#reqView .rq-item').first.locator('.rq-s').first.inner_text() == D.mine_sub(row)
               and page.locator('#reqView .rq-item').first.locator('.rq-pill').inner_text() == '審核中', (page.inner_text('#reqView')[:300], D.req_summary(row)))
            sent = page.evaluate('window.__sent')
            ok(f'{label}：送出後代送「申請已送出：摘要」給機器人', sent[-1] == {'type': 'text', 'text': '申請已送出：' + D.req_summary(row)}, sent)
            dd = read_store(p['store'])
            last = [r for r in dd['requests'] if r['emp_id'] == p['emp_id']][-1]
            ok(f'{label}：資料檔那筆加班：日期、時段、時數、狀態 pending、comp 留空', last['date'] == oh['date'] and last['start'] == oh['start'] and last['end'] == oh['end']
               and float(last['hours']) == row['hours'] and last['status'] == 'pending' and not last.get('comp'), last)
            page.close()


# ── 4. 休息規則（Rest.gs）：班距、單日上限、跨店、同一天第二段、總開關 ──
def phase_rest(ctx, gen):
    A, B = gen.A, gen.B
    for p in [x for x in gen.people if x['scenario'] in ('rest_gap', 'rest_cap', 'cross_store', 'rest_gap_soon')]:
        st = BY_CODE[p['store']]
        on = gen.rest_on[p['store']]
        label = f'{p["scenario"]}@{st["code"] or "光復"}（擋卡{"開" if on else "關"}，{p["name"]}）'
        if p['scenario'] == 'rest_gap_soon':   # 時間敏感：開頁前才放卡（再 7 秒就滿 11 小時；上班卡在今天之前，同一天的段落不看間隔）
            d = read_store(p['store'])
            mine = [x for x in d['events'] if x['emp_id'] == p['emp_id']]
            gen.now = now_tz()
            in_t, out_t = gen.gap_segment(out_t=now_tz() - timedelta(hours=D.REST_GAP_H) + timedelta(seconds=7))
            mine[0]['ts'] = D.iso(in_t); mine[1]['ts'] = D.iso(out_t)
            write_store(p['store'], d)
        u, fix = url(st, p['line_user_id'])
        page = open_page(ctx, u)
        ex = check_open(gen, p, page, label)
        rest = ex['rest']
        n0 = len(file_events_raw(p['store'], p['emp_id']))
        if p['scenario'] == 'rest_gap_soon':
            ok(f'{label}：資料檢查——開頁時應還鎖著', rest and rest['code'] == 'gap' and ex['in_disabled'], ex)
            page.wait_for_function('!document.getElementById("btnIn").disabled', timeout=15000)
            ok(f'{label}：時間到上班鍵自動解開、恢復「上班」、拿掉那句', page.inner_text('#btnIn') == '上班' and msg(page) == '' and hint(page) == '', (page.inner_text('#btnIn'), msg(page)))
            click(page, '#btnIn', '解鎖後上班')
            after_punch_ok(gen, p, page, 'in', label, n_before=n0, extra_msg='')
            page.close()
            continue
        if not on:
            ok(f'{label}：總開關關著 → 雖然班距不足也不鎖（資料檢查：若開著會鎖）', rest is None and not ex['in_disabled']
               and D.rest_expect(ex['evs'], peer_events(gen, p), ex['now'], True) is not None, ex)
            dlg(page, accept=True)
            click(page, '#btnIn', '上班（關著不擋）')
            after_punch_ok(gen, p, page, 'in', label, n_before=n0, extra_msg='')
            page.close()
            continue
        # rest_cap 要「今天」的段落才算單日上限：測試在上午 10:30 前跑，段落會跨到昨天，照規格就不是 cap（跨夜那段歸昨天→看班距；
        # 今天那段不到 10 小時→不擋）。這時開頁狀態已照規格比對過，單日上限那幾項略過並註明。
        if p['scenario'] == 'rest_cap' and not all(e['ts'][:10] == ex['now'].strftime('%Y-%m-%d') for e in ex['evs']):
            print(f'（{label}：段落跨到昨天（現在 {ex["now"].strftime("%H:%M")}），照規格不算單日上限；10:30 後跑才測得到 cap 分支）')
            page.close()
            continue
        want_code = 'cap' if p['scenario'] == 'rest_cap' else 'gap'
        ok(f'{label}：資料檢查——應被擋（{want_code}）', rest is not None and ex['in_disabled'] and rest['code'] == want_code, (rest, ex))
        if p['scenario'] == 'cross_store':
            peer = next(q for q in gen.people if q['scenario'] == 'peer' and q['name'] == p['name'])
            ok(f'{label}：跨店——自己這家店沒卡，原因講的是同名同仁在 {BY_CODE[peer["store"]]["name"]} 的下班時間',
               ex['evs'] == [] and peer['events'][-1]['ts'][11:16] in rest['reason'], (rest, peer['events']))
        if want_code == 'cap':
            ok(f'{label}：單日上限——按鈕只寫「上班」（今天都不解）、原因含「一天最多 10 小時」', page.inner_text('#btnIn') == '上班' and '一天最多 10 小時' in msg(page), msg(page))
        page.screenshot(path=os.path.join(SHOTS, f'ddt_休息不足_{p["scenario"]}.jpg'), type='jpeg', quality=70)
        # 畫面沒擋到也會被伺服器擋：rejected_rest 寫進資料檔、原因同一句
        dlg(page, accept=True)
        force_click(page, '#btnIn')
        wait_msg(page, '上班打卡失敗')
        raw = file_events_raw(p['store'], p['emp_id'])
        ok(f'{label}：強按上班 → 伺服器擋下（原因、怎麼辦逐字＝開頁那句）、資料檔記一張 rejected_rest',
           msg(page) == f'上班打卡失敗\n原因：{rest["reason"]}\n怎麼辦：{rest["hint"]}' and len(raw) == n0 + 1 and raw[-1]['status'] == 'rejected_rest' and raw[-1]['type'] == 'in', (msg(page), raw[-1:]))
        ok(f'{label}：下班卡不受休息規則影響（鍵可按）', not page.is_disabled('#btnOut'))
        if p['scenario'] == 'rest_gap' and p['store'] == A['code']:
            # 下班鍵：上一張算數的卡是下班（12 小時內）→ 同型確認框；確定後伺服器照收（超過 10 分鐘），提醒「這次沒有打上班卡」
            g = ex['guard']
            dlg(page, accept=True)
            md = D.missed_detail(events_of(p['store'], p['emp_id']), 'out', D.iso(now_tz() + timedelta(seconds=5)))   # 按下前的卡
            click(page, '#btnOut', '同型下班')
            after_punch_ok(gen, p, page, 'out', label + '／下班', extra_msg='\n\n⚠️ ' + md['text'], stay_open=True)
            ms = dlg(page)
            want = [D.same_type_msg(g['last']['ts'][11:16], 'out')] if g['last'] and g['last']['type'] == 'out' else []
            ok(f'{label}：下班前的確認框＝規格（上一張是 12 小時內的下班卡才問）', ms == want, (ms, want))
        page.close()
    # 總開關 API（rest_rule_set）：關掉 A 店再開頁，原本被擋的人就不鎖；再開回來
    victim = next(x for x in gen.people if x['scenario'] == 'rest_cap')
    r = api(A['code'], {'action': 'rest_rule_set', 'admin_key': 'test-admin', 'on': False, 'probe': True})
    ok('休息規則總開關：rest_rule_set 關掉 A 店、probe 回其他店都讀得到', r.get('ok') and r.get('on') is False and r.get('peer_bad') == [] and r.get('peers') == len(STORES) - 1, r)
    bad = api(A['code'], {'action': 'rest_rule_set', 'admin_key': '', 'on': True})
    ok('休息規則總開關：空的管理金鑰一律擋', bad == {'ok': False, 'error': 'unauthorized'}, bad)
    u, _ = url(BY_CODE[victim['store']], victim['line_user_id'])
    page = open_page(ctx, u)
    gen.rest_on[A['code']] = False
    check_open(gen, victim, page, '關掉總開關後 rest_cap')
    ok('休息規則總開關：關掉後今天滿 10 小時的人上班鍵也能按', not page.is_disabled('#btnIn') and msg(page) == '')
    page.close()
    r = api(A['code'], {'action': 'rest_rule_set', 'admin_key': 'test-admin', 'on': True})
    gen.rest_on[A['code']] = True
    ok('休息規則總開關：開回來', r.get('on') is True, r)


# ── 5. 主管 QR 打卡（不定位）──
def phase_qr(ctx, gen):
    A = gen.A
    p = next(x for x in gen.people if x['scenario'] == 'qr')
    mgr = gen.managers[A['code']]
    tag = A['code'] or 'gk'
    r = api(A['code'], {'action': 'mgr_qr_token', 'mgr_key': mgr['key'], 'store': tag})
    ok('QR：主管取得動態 QR（店碼～時間窗～主管列～簽章、30 秒內到期）', r.get('ok') and r['token'].startswith(tag + '~') and 0 < r['expires_in'] <= 30000 and r['manager'] == mgr['name'], r)
    def qr_page(token):
        pg = open_page(ctx, f'{BASE}/clock-line.html?mock_uid={p["line_user_id"]}&api=/api&qr={token}&in_client=1&retry_ms=50')
        return pg
    page = qr_page(r['token'])
    wait_ready(page, p['name'])
    ok('QR：不定位、直接問店家、橫幅「用值班主管出示的 QR 打卡（不需要定位）」', page.evaluate('window.__geo') == 0 and page.inner_text('#storeName') == A['name']
       and page.is_visible('#qrBanner') and page.inner_text('#qrBanner') == '用值班主管出示的 QR 打卡（不需要定位）' and [x['action'] for x in calls(page)] == ['liff_status'], calls(page))
    scan(page, 'QR 打卡畫面')
    n0 = len(file_events_raw(A['code'], p['emp_id']))
    dlg(page, accept=True)
    click(page, '#btnIn', 'QR 上班')
    e = after_punch_ok(gen, p, page, 'in', 'QR 上班', extra_msg='（主管 QR）', n_before=n0)
    body = [x for x in calls(page) if x['action'] == 'liff_punch']
    qp = read_store(A['code']).get('qr_punch', [])
    ok('QR：用店家座標打卡（距離 0）、另記 qr_punch 是哪位主管出示的', e['distance_m'] == 0 and e['lat'] == A['lat'] and e['lng'] == A['lng'] and len(body) == 1
       and qp and qp[-1]['emp_id'] == p['emp_id'] and qp[-1]['qr_manager'] == mgr['name'] and qp[-1]['type'] == 'in', (e, qp[-1:]))
    page.close()
    shift_events(A['code'], p['emp_id'], 11, only_last=True)   # 過了 10 分鐘鎖，接下來的錯誤 QR 才會走到 QR 檢查（正式版先看防呆再驗 QR）
    # 過期（往前 3 個時間窗）、簽章不對、不是這家店、看不懂
    tag_, win, idx, sig = r['token'].split('~')
    cases = [('過期', f'{tag_}~{int(win) - 3}~{idx}~{sig}', 'QR 碼已過期，請主管重新顯示後再掃一次'),
             ('簽章不對', f'{tag_}~{win}~{idx}~{("A" if sig[0] != "A" else "B") + sig[1:]}', 'QR 碼不正確，請主管重新顯示')]
    for name, token, reason in cases:
        page = qr_page(token)
        wait_ready(page, p['name'])
        dlg(page, accept=True)
        click(page, '#btnOut', 'QR 下班（壞的 QR）')
        wait_msg(page, '下班打卡失敗')
        ok(f'QR：{name} → 伺服器擋下、原因逐字、請主管重新顯示、不重讀狀態、不寫卡',
           msg(page) == f'下班打卡失敗\n原因：{reason}\n怎麼辦：請值班主管在核定頁按「打卡 QR」重新顯示' and [x['action'] for x in calls(page)] == ['liff_status', 'liff_punch']
           and len(file_events_raw(A['code'], p['emp_id'])) == n0 + 1, (msg(page), calls(page)))
        page.close()
    d = read_store(A['code']); d['qr_store'] = 'zz'; write_store(A['code'], d)
    page = qr_page(r['token'])
    wait_ready(page, p['name'])
    click(page, '#btnOut', 'QR 下班（別店的 QR）')
    wait_msg(page, '下班打卡失敗')
    ok('QR：店碼對不上這家店 → 「這不是這家店的 QR 碼」', '原因：這不是這家店的 QR 碼' in msg(page), msg(page))
    page.close()
    d['qr_store'] = tag; write_store(A['code'], d)
    page = qr_page('zz~1~2~abcdefghijklmnop')
    wait_msg(page, '看不懂這個 QR 碼')
    ok('QR：不認得的店碼 → 畫面自己說「看不懂這個 QR 碼」、不打後端', msg(page) == '看不懂這個 QR 碼' and calls(page) == [], (msg(page), calls(page)))
    page.close()


# ── 6. 讀取重試／結果不明回頭確認／各種失敗字句（假回應）──
def phase_failures(ctx, gen):
    B = gen.B
    p = next(x for x in gen.people if x['scenario'] == 'fresh' and x['store'] == B['code'])
    uid, st = p['line_user_id'], B
    shift_events(st['code'], p['emp_id'], 11)   # 前面剛打過卡：往前挪 11 分鐘，鎖才不會擋住這裡要測的路徑
    u, _ = url(st, uid, extra='&post_timeout=1500')
    pre = "window.__fake.liff_status = ['abort', {ok:false, error:'server_error'}, 'real'];"
    page = open_page(ctx, u, pre=pre)
    wait_ready(page, p['name'])
    ok('讀取重試：斷線、系統沒回應各一次後第 3 次成功（共送 3 次）', sum(1 for x in calls(page) if x['action'] == 'liff_status') == 3, calls(page))
    # 結果不明：伺服器收到但回應弄丟 → 回頭確認說已經進去、只送 1 次
    n0 = len(file_events_raw(st['code'], p['emp_id']))
    page.evaluate("window.__fake.liff_punch = 'lost'")
    dlg(page, accept=True)
    click(page, '#btnIn', '上班（回應弄丟）')
    wait_msg(page, '剛才那筆已經進去了', timeout=15000)
    e = file_events_raw(st['code'], p['emp_id'])[-1]
    ok('結果不明：回應弄丟 → 重讀今天的卡比張數，說「已經進去了，不用再按」、只送 1 次、不重送', sum(1 for x in calls(page) if x['action'] == 'liff_punch') == 1
       and msg(page) == f'上班打卡成功 {e["ts"][11:16]}（剛才那筆已經進去了，不用再按）\n地點：{st["name"]}' and len(file_events_raw(st['code'], p['emp_id'])) == n0 + 1, msg(page))
    tm = page.evaluate('window.__timing')[-1]
    ok('結果不明：等待秒數記 unclear_ok', tm['outcome'] == 'unclear_ok' and tm['store'] == st['code'] and tm['type'] == 'in', tm)
    page.close()
    page = open_page(ctx, u)
    wait_ready(page, p['name'])
    page.evaluate("window.__fake.liff_punch = 'abort'")
    force_click(page, '#btnOut')
    wait_msg(page, '這次下班卡沒有送出', timeout=15000)
    ok('結果不明：根本沒送到 → 回頭確認說沒有送出、請再按一次', msg(page) == '這次下班卡沒有送出' and hint(page) == '請再按一次「下班」。' and sum(1 for x in calls(page) if x['action'] == 'liff_punch') == 1, (msg(page), hint(page)))
    page.evaluate("window.__fake.liff_punch = 'abort'; window.__fake.liff_status = ['abort']")
    force_click(page, '#btnOut')
    wait_msg(page, '不確定這筆有沒有進去', timeout=15000)
    ok('結果不明：連確認也失敗 → 說不確定、請看出勤紀錄、不要連按；求助類別「網路不穩」', msg(page) == '連線不穩，不確定這筆有沒有進去' and '不要連按' in hint(page) and page.is_visible('#btnHelp'), (msg(page), hint(page)))
    ok('結果不明：每次按只記 1 筆秒數（unclear_not、unclear_unknown）', [x['outcome'] for x in page.evaluate('window.__timing')] == ['unclear_not', 'unclear_unknown'], page.evaluate('window.__timing'))
    page.evaluate("window.__fake.liff_punch = 'hang'; window.__fake.liff_status = ['real']")
    force_click(page, '#btnOut')
    wait_msg(page, '卡沒有送出', timeout=15000)
    ok('逾時：等 25 秒（本機縮短）沒回應 → 只送 1 次、回頭確認', sum(1 for x in calls(page) if x['action'] == 'liff_punch') == 3, calls(page))
    page.close()
    for fake, needle, extra in [({'ok': False, 'type': 'out', 'reason': '上一筆還在處理中', 'hint': '請等幾秒，看出勤紀錄有沒有這筆再決定要不要重按'}, '原因：上一筆還在處理中', '雙擊防護'),
                                ({'ok': False, 'error': 'server_error'}, '系統沒有正常回應', '後端壞掉'),
                                ({'ok': False, 'type': 'out', 'status': 'rejected_out_of_range', 'reason': '店家判定你不在範圍內', 'hint': '請開啟「精確位置」與 Wi‑Fi 後再按一次'}, '店家判定你不在範圍內', '店家判定超出範圍'),
                                ({'ok': False, 'type': 'out', 'status': 'pending_device_approval', 'reason': '這支手機還沒被核准', 'hint': '已送出待核准，請主管在值班核定頁核准'}, '這支手機還沒被核准', '新手機')]:
        page = open_page(ctx, u)
        wait_ready(page, p['name'])
        page.evaluate('(f) => { window.__fake.liff_punch = f; }', fake)
        force_click(page, '#btnOut')
        wait_msg(page, needle)
        page.wait_for_timeout(300)
        ok(f'失敗字句（{extra}）：顯示後端的原因與怎麼辦、只送 1 次', needle in msg(page) and (not fake.get('hint') or '怎麼辦：' + fake['hint'] in msg(page))
           and sum(1 for x in calls(page) if x['action'] == 'liff_punch') == 1, msg(page))
        if fake.get('status') in ('rejected_out_of_range', 'pending_device_approval'):
            want = {'rejected_out_of_range': '定位不準', 'pending_device_approval': '新手機'}[fake['status']]
            click(page, '#btnHelp', '求助')
            page.wait_for_function('window.__closed === true', timeout=5000)
            ok(f'失敗字句（{extra}）：求助類別「{want}」', page.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：' + want}], page.evaluate('window.__sent'))
        page.close()
    shift_events(st['code'], p['emp_id'], 11)
    page = open_page(ctx, u)
    wait_ready(page, p['name'])
    page.evaluate("window.__fake.liff_punch = {ok:false, error:'too_many'}")
    force_click(page, '#btnOut')
    wait_msg(page, '按太多次了')
    page.wait_for_timeout(300)
    ok('太頻繁：兩顆鍵停用、提示等一分鐘、可按重新定位', page.is_disabled('#btnIn') and page.is_disabled('#btnOut') and p and page.is_visible('#btnRetry')
       and hint(page) == '請等一分鐘後再試；先按選單「出勤紀錄」確認有沒有打到。', hint(page))
    page.evaluate("window.__fake.liff_punch = 'real'")
    click(page, '#btnRetry', '重新定位')
    wait_ready(page, p['name'])
    ok('重新定位：重新讀狀態、鍵恢復', [x['action'] for x in calls(page)].count('liff_status') >= 2 and not page.is_disabled('#btnIn'), calls(page))
    page.evaluate("window.__fake.liff_punch = {ok:false, error:'not_bound'}")
    force_click(page, '#btnOut')
    wait_msg(page, '沒有認得你的 LINE 帳號')
    ok('資料對不上：打卡時店家說沒綁 → 不轉光復、鍵停用、請找主管', page.is_disabled('#btnIn') and not any(x['action'] == 'line_hub_status' for x in calls(page))
       and msg(page) == '這家店的系統沒有認得你的 LINE 帳號', msg(page))
    page.close()
    page = open_page(ctx, u, pre="window.__fake.liff_status = ['abort'];")
    wait_msg(page, '連線失敗', timeout=15000)
    ok('讀取：三次都失敗才說連線失敗（共送 3 次）、求助類別「網路不穩」', sum(1 for x in calls(page) if x['action'] == 'liff_status') == 3 and msg(page) == '連線失敗', calls(page))
    click(page, '#btnHelp', '求助')
    page.wait_for_function('window.__closed === true', timeout=5000)
    ok('連線失敗 → 求助「網路不穩」', page.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：網路不穩'}], page.evaluate('window.__sent'))
    page.close()
    # LINE 登入逾時：自動重整一次，第二次停在說明
    LOADS = "sessionStorage.setItem('__loads', String((+sessionStorage.getItem('__loads') || 0) + 1));"
    page = open_page(ctx, u, pre=LOADS + "window.__fake.liff_status = {ok:false, error:'invalid_id_token'};")
    page.wait_for_function("document.getElementById('hint').textContent.indexOf('請關掉這頁') >= 0", timeout=15000)
    page.wait_for_timeout(1000)
    ok('登入逾時：開頁逾時 → 自動重整 1 次，第 2 次停在「LINE 登入逾時／請關掉這頁」、鍵停用',
       page.evaluate("+sessionStorage.getItem('__loads')") == 2 and msg(page) == 'LINE 登入逾時' and page.is_disabled('#btnIn'), (msg(page), hint(page)))
    page.close()


# ── 7. 申請頁（請假／加班／出差／我的申請／撤銷／補附證明）──
def open_req(ctx, st, p, tab):
    u, _ = url(st, p['line_user_id'], extra='&view=req&tab=' + tab)
    page = open_page(ctx, u)
    page.wait_for_selector('#reqView .rq-tabs button.on', timeout=12000)
    return page


def first_item(page):
    it = page.locator('#reqView .rq-item').first
    return {'title': it.locator('.rq-t span').first.inner_text(), 'pill': it.locator('.rq-pill').inner_text(), 'sub': it.locator('.rq-s').first.inner_text()}


def submit_ok(page, row, label):
    time.sleep(1.1)   # created_at 只到秒：同一秒送兩筆，「我的申請」的排序（新的在前）就分不出先後（真人不會一秒送兩筆）
    submit(page)
    try:
        wait_req(page, '✓ 已送出')
    except Exception:   # 沒送成：把畫面上的錯誤框印出來，比逾時好查
        err = page.inner_text('#reqView .rq-box.err') if page.locator('#reqView .rq-box.err').count() else '（沒有錯誤框）'
        raise AssertionError(f'{label}：送出沒有成功：{err}')
    got = first_item(page)
    ok(f'{label}：送出 → 「✓ 已送出：摘要」逐字、我的申請第一筆標題／副標／審核中', page.inner_text('#reqView .rq-box.ok') == '✓ 已送出：' + D.req_summary(row) + ('\n等打卡門市的店長審核' if row.get('kind') == 'miss' else '\n等主管審核')
       and got == {'title': D.mine_title(row), 'pill': '審核中', 'sub': D.mine_sub(row)}, (got, D.mine_title(row), D.mine_sub(row), page.inner_text('#reqView .rq-box.ok')))


def phase_req(ctx, gen):
    A = gen.A
    p = next(x for x in gen.people if x['scenario'] == 'req_single')
    comp, quota = gen.comp, {q['name']: q for q in gen.quota}
    page = open_req(ctx, A, p, 'leave')
    scan(page, '申請頁・請假')
    ok('申請頁：只綁一家 → 標題寫姓名與店名、五個分頁', page.inner_text('#reqView .rq-head b') == p['name'] and page.inner_text('#reqView .rq-head .rq-muted') == A['name']
       and page.locator('#reqView .rq-tabs button').all_inner_texts() == ['請假', '加班', '出差', '忘打卡', '我的申請'], page.inner_text('#reqView .rq-head'))
    chips = page.locator('#reqView .rq-chips').first.locator('.rq-chip').all_inner_texts()
    ok('請假：常用假別＝五種＋正職多「補休」', chips == D.COMMON_LEAVES + ['補休'], chips)
    opts = page.locator('#reqView select.rq-special option').all_inner_texts()
    ok('請假：特殊假別下拉＝白名單去掉常用五種（逐項、順序）', opts == ['特殊假別（婚假、喪假、產假…）'] + [t for t in D.LEAVE_TYPES if t not in D.COMMON_LEAVES], opts)
    ok('請假：本月補休帳逐字、欠的紅字', page.inner_text('#reqView .rq-comp-bal') == '補休：' + D.comp_text(comp)
       and page.locator('#reqView .rq-comp-bal.rq-comp-neg').count() == (1 if comp['balance_h'] < 0 else 0), (page.inner_text('#reqView .rq-comp-bal'), comp))
    submit(page)
    ok('請假：沒選假別 → 「請選假別」', err_box(page) == '請選假別')
    for name in chips:   # 每個假別都點：額度字句照規格
        click(page, f'#reqView .rq-chips >> nth=0 >> .rq-chip:text-is("{name}")', '假別 ' + name)
        page.wait_for_selector(f'#reqView .rq-chip.on:text-is("{name}")', timeout=3000)
        q = quota.get(name)
        want = [f'{name}：{D.quota_text(q)}'] if q and D.quota_text(q) and name != '補休' else []
        got = page.locator('#reqView .rq-quota:not(.rq-comp-bal)').all_inner_texts()
        ok(f'請假：選「{name}」→ 額度字句逐字（{want[0] if want else "沒有額度行"}）', got == want, (got, want))
        if name == '補休':
            ok('請假：選補休多一行「可以先休、之後再用加班補回來…」', '可以先休、之後再用加班補回來；當月要補平（20、25 號會檢查），剩的照加班費發。' in req_text(page))
    # 整天：隨機時數、日期、原因
    name = RNG.choice(['特休假', '事假', '家庭照顧假', '生理假'])
    click(page, f'#reqView .rq-chips >> nth=0 >> .rq-chip:text-is("{name}")', '假別')
    page.wait_for_selector(f'#reqView .rq-chip.on:text-is("{name}")', timeout=3000)
    d0 = (now_tz() + timedelta(days=RNG.choice([-3, -2, -1, 0, 1, 2, 3, 4, 6, 7, 8, 9, 10]))).strftime('%Y-%m-%d')   # 避開 +5（補休那筆用），同一天兩筆請假會被當重複
    pick_date(page, d0)
    hrs = RNG.choice([0.5, 1, 2, 3.5, 8])
    page.fill('#reqView .rq-hours', str(hrs))
    reason = RNG.choice(['', '家裡有事', '回診'])
    page.fill('#reqView input[type=text][maxlength="100"]', reason)
    submit_ok(page, {'kind': 'leave', 'date': d0, 'leave_type': name, 'hours': hrs, 'reason': reason}, f'請假整天（{name} {hrs} 小時）')
    sent = page.evaluate('window.__sent')
    ok('請假：代送「申請已送出：摘要」', sent[-1]['text'] == '申請已送出：' + D.req_summary({'kind': 'leave', 'date': d0, 'leave_type': name, 'hours': hrs}), sent)
    # 同一天同類再送 → 擋
    click(page, '#reqView .rq-tabs button[data-tab=leave]', '請假分頁')
    click(page, f'#reqView .rq-chips >> nth=0 >> .rq-chip:text-is("{name}")', '假別')
    pick_date(page, d0)
    submit(page)
    ok('請假：同一天已有審核中的請假 → 擋（逐字）', err_box(page) == '這天已經有一筆審核中的請假申請，要改請先取消那一筆', err_box(page))
    # 只請一段：時數即時顯示；起訖一樣、超過 12 小時都擋
    d1 = (now_tz() + timedelta(days=RNG.randint(11, 20))).strftime('%Y-%m-%d')
    pick_date(page, d1)
    click(page, '#reqView .rq-chip:text-is("只請一段")', '只請一段')
    page.wait_for_selector('#reqView .rq-time', timeout=3000)
    pick_time(page, 0, '09:00'); pick_time(page, 1, '09:00')
    submit(page)
    ok('請假只一段：起訖一樣 → 擋（逐字）', err_box(page) == '請假的開始和結束時間一樣，請確認', err_box(page))
    pick_time(page, 0, '08:00'); pick_time(page, 1, '21:00')
    ok('請假只一段：即時顯示共 13 小時', '共 13 小時' in req_text(page))
    submit(page)
    ok('請假只一段：超過 12 小時 → 擋（逐字）', err_box(page) == '請假時段超過 12 小時，請確認時間；一整天請選「整天」填時數', err_box(page))
    s = RNG.choice(['09:00', '10:15', '13:30', '18:45']); e = D.min_hm(D.hm_min(s) + RNG.choice([60, 90, 150, 240]))
    pick_time(page, 0, s); pick_time(page, 1, e)
    ok(f'請假只一段：即時顯示共 {D.js_num(D.span_hours(s, e))} 小時', f'共 {D.js_num(D.span_hours(s, e))} 小時' in req_text(page), req_text(page)[:300])
    submit_ok(page, {'kind': 'leave', 'date': d1, 'leave_type': name, 'start': s, 'end': e, 'hours': D.span_hours(s, e), 'reason': ''}, '請假只一段')
    # 整天 0 小時 → 後端擋
    click(page, '#reqView .rq-tabs button[data-tab=leave]', '請假分頁')
    click(page, '#reqView .rq-chip:text-is("整天")', '整天')
    page.wait_for_selector('#reqView .rq-hours', timeout=3000)
    page.fill('#reqView .rq-hours', '0')
    click(page, f'#reqView .rq-chips >> nth=0 >> .rq-chip:text-is("{name}")', '假別')
    pick_date(page, (now_tz() + timedelta(days=25)).strftime('%Y-%m-%d'))
    submit(page)
    ok('請假整天：0 小時 → 「請填請假時數（最少 0.25 小時）」', err_box(page) == '請填請假時數（最少 0.25 小時）', err_box(page))
    # 特殊假別（下拉）
    sp = RNG.choice(['公假', '謀職假', '天災假', '育嬰假'])
    select(page, '#reqView select.rq-special', sp, '特殊假別')
    page.wait_for_function('(s) => !document.querySelectorAll("#reqView .rq-chips")[0].querySelector(".rq-chip.on") && document.querySelector("#reqView select.rq-special").value === s', arg=sp, timeout=3000)   # 假別那一組沒有亮的籌碼（整天／只請一段那組永遠有一顆亮著）
    page.fill('#reqView .rq-hours', '8')
    d2 = (now_tz() + timedelta(days=30)).strftime('%Y-%m-%d')
    pick_date(page, d2)
    submit_ok(page, {'kind': 'leave', 'date': d2, 'leave_type': sp, 'hours': 8, 'reason': ''}, f'特殊假別（{sp}）')
    # 補休：欠的也送得出去
    click(page, '#reqView .rq-tabs button[data-tab=leave]', '請假分頁')
    click(page, '#reqView .rq-chip:text-is("補休")', '補休')
    page.wait_for_selector('#reqView .rq-chip.on:text-is("補休")', timeout=3000)
    d3 = (now_tz() + timedelta(days=5)).strftime('%Y-%m-%d')
    pick_date(page, d3)
    submit_ok(page, {'kind': 'leave', 'date': d3, 'leave_type': '補休', 'hours': 8, 'reason': ''}, '補休（不看餘額）')
    # 證明：病假一定要附
    click(page, '#reqView .rq-tabs button[data-tab=leave]', '請假分頁')
    proof = RNG.choice(['病假'] * 3 + ['婚假'])
    if proof == '病假':
        click(page, '#reqView .rq-chip:text-is("病假")', '病假')
    else:
        select(page, '#reqView select.rq-special', proof, '特殊假別（婚假）')
    page.wait_for_function('(t) => document.getElementById("reqView").textContent.indexOf("證明文件（" + t + "一定要附）") >= 0', arg=proof, timeout=3000)
    ok(f'證明：選{proof} → 欄位「證明文件（{proof}一定要附）」＋說明逐字', page.inner_text('#rqProofNote') == '可以拍照或選照片／PDF。手上還沒有證明也能先送出，但主管要等你在「我的申請」補上才能核准。', page.inner_text('#rqProofNote'))
    d4 = (now_tz() + timedelta(days=40)).strftime('%Y-%m-%d')
    pick_date(page, d4)
    page.fill('#reqView .rq-hours', '8')
    dlg(page, accept=False)
    n_sub = sum(1 for x in calls(page) if x['action'] == 'req_submit')
    submit(page)
    ok('證明：沒附就送 → 確認框逐字；取消＝不送', dlg(page)[-1] == f'{proof}要附證明。\n\n沒附也可以先送出，但主管要等你在「我的申請」補上證明才能核准。\n\n確定先送出？'
       and err_box(page) == '還沒送出：請先選證明照片或 PDF' and sum(1 for x in calls(page) if x['action'] == 'req_submit') == n_sub, (dlg(page)[-1:], err_box(page)))
    dlg(page, accept=True)
    submit_ok(page, {'kind': 'leave', 'date': d4, 'leave_type': proof, 'hours': 8, 'reason': ''}, f'證明（{proof} 先送出）')
    item = page.locator('#reqView .rq-item').first
    ok('證明：我的申請顯示「⚠ 還沒附證明：主管要等你補上才能核准」＋補附按鈕', item.locator('.rq-proof-note').inner_text() == '⚠ 還沒附證明：主管要等你補上才能核准'
       and item.locator('.rq-proof-btn').inner_text() == '📎 補附證明（拍照或選檔）', item.inner_text())
    rid = item.locator('.rq-proof-btn').get_attribute('data-id')
    mgr = gen.managers[A['code']]
    r = api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': rid, 'decision': 'approve'})
    ok('證明：還沒附主管就不能核准（逐字）', r == {'ok': False, 'error': 'need_proof', 'message': f'{proof}要附證明，同仁補上後才能核准（退回不受影響）'}, r)
    with page.expect_file_chooser() as fc:
        click(page, '#reqView .rq-proof-btn', '補附證明')
    fc.value.set_files(files=[{'name': 'proof.png', 'mimeType': 'image/png', 'buffer': PNG}])
    wait_req(page, '✓ 證明已補上')
    c = calls(page)
    up = [x for x in c if x['action'] == 'line_hub_attach_put']; at = [x for x in c if x['action'] == 'req_attach']
    ok('證明：補附先傳光復 line_hub_attach_put、再打那家店 req_attach；畫面「✓ 證明已補上，等主管審核」', up and up[-1]['url'].endswith('/api')
       and at and at[-1]['url'].endswith('/api' + ('/' + A['code'] if A['code'] else '')) and up[-1]['t'] <= at[-1]['t']
       and page.inner_text('#reqView .rq-box.ok') == '✓ 證明已補上，等主管審核', c[-3:])
    item = page.locator('#reqView .rq-item').filter(has_text=proof).first
    ok('證明：補附後「已附證明（要換一張可以重新上傳）」＋「重新上傳證明」', '已附證明（要換一張可以重新上傳）' in item.inner_text() and item.locator('.rq-proof-btn').inner_text() == '重新上傳證明', item.inner_text())
    a1 = next(x for x in read_store(A['code'])['requests'] if x['id'] == rid)
    with page.expect_file_chooser() as fc:
        click(page, '#reqView .rq-proof-btn:text-is("重新上傳證明")', '重新上傳證明')
    fc.value.set_files(files=[{'name': 'proof2.png', 'mimeType': 'image/png', 'buffer': PNG}])
    page.wait_for_function("window.__calls.filter(c => c.action === 'req_attach').length === 2", timeout=15000)
    page.wait_for_timeout(500)
    wait_req(page, '✓ 證明已補上')
    a2 = next(x for x in read_store(A['code'])['requests'] if x['id'] == rid)
    ok('證明：重新上傳後附件 ID 換新', a1['attach_id'] != a2['attach_id'], (a1['attach_id'], a2['attach_id']))
    ok('證明：重新上傳換掉附件 ID', a2['attach_id'] and a2['attach_id'] != '' and len([x for x in calls(page) if x['action'] == 'req_attach']) == 2, a2)
    r = api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': rid, 'decision': 'approve'})
    ok('證明：附上後主管可以核准', r.get('status') == 'approved', r)
    page.screenshot(path=os.path.join(SHOTS, 'ddt_我的申請.jpg'), type='jpeg', quality=70)
    # 加班
    click(page, '#reqView .rq-tabs button[data-tab=ot]', '加班分頁')
    page.wait_for_selector('#reqView .rq-time', timeout=3000)
    ok('加班：正職看得到「核准後先抵當月請的補休…」＋本月補休帳', f'核准後先抵當月請的補休，剩下的照加班費發。補休：{D.comp_text(comp)}' in req_text(page), req_text(page)[:300])
    ok('加班：沒有「加班費／換補休」選項、沒有日期與時間轉盤', page.locator('#reqView input[name=rqComp]').count() == 0 and page.locator('#reqView input[type=time], #reqView input[type=date]').count() == 0)
    submit(page)
    ok('加班：沒填時段 → 「請填加班時段」', err_box(page) == '請填加班時段', err_box(page))
    pick_time(page, 0, '18:00'); pick_time(page, 1, '20:00')
    submit(page)
    ok('加班：沒寫原因 → 「加班要寫原因」', err_box(page) == '加班要寫原因', err_box(page))
    page.fill('#reqView input[type=text]', '月底盤點')
    pick_time(page, 0, '08:00'); pick_time(page, 1, '21:00')
    submit(page)
    ok('加班：超過 12 小時 → 擋（逐字）', err_box(page) == '加班時段超過 12 小時，請確認時間', err_box(page))
    s = RNG.choice(['17:00', '18:15', '21:30']); e = D.min_hm(D.hm_min(s) + RNG.choice([90, 150, 240]))
    d5 = (now_tz() - timedelta(days=RNG.randint(0, 6))).strftime('%Y-%m-%d')
    pick_date(page, d5); pick_time(page, 0, s); pick_time(page, 1, e)
    ok(f'加班：即時顯示共 {D.js_num(D.span_hours(s, e))} 小時', f'共 {D.js_num(D.span_hours(s, e))} 小時' in req_text(page))
    submit_ok(page, {'kind': 'ot', 'date': d5, 'start': s, 'end': e, 'hours': D.span_hours(s, e), 'reason': '月底盤點'}, '加班')
    click(page, '#reqView .rq-tabs button[data-tab=ot]', '加班分頁')
    pick_date(page, d5); pick_time(page, 0, s); pick_time(page, 1, e); page.fill('#reqView input[type=text]', '再送一次')
    submit(page)
    ok('加班：同一天已有審核中的加班 → 擋（逐字）', err_box(page) == '這天已經有一筆審核中的加班申請，要改請先取消那一筆', err_box(page))
    # 出差
    click(page, '#reqView .rq-tabs button[data-tab=trip]', '出差分頁')
    page.wait_for_selector('#reqView .rq-place', timeout=3000)
    submit(page)
    ok('出差：沒填地點 → 「請填出差地點」', err_box(page) == '請填出差地點')
    page.fill('#reqView .rq-place', '台中央廚')
    submit(page)
    ok('出差：沒填事由 → 「請填出差事由」', err_box(page) == '請填出差事由')
    page.fill('#reqView .rq-why', '支援盤點')
    click(page, '#reqView .rq-chip:text-is("只一段")', '只一段')
    page.wait_for_selector('#reqView .rq-time', timeout=3000)
    pick_time(page, 0, '13:00'); pick_time(page, 1, '13:00')
    page.fill('#reqView .rq-place', '台中央廚'); page.fill('#reqView .rq-why', '支援盤點')
    submit(page)
    ok('出差只一段：起訖一樣 → 擋（逐字）', err_box(page) == '出差的開始和結束時間一樣，請確認', err_box(page))
    s = '13:00'; e = RNG.choice(['17:30', '18:00', '20:15'])
    pick_time(page, 0, s); pick_time(page, 1, e)
    d6 = (now_tz() + timedelta(days=RNG.randint(1, 15))).strftime('%Y-%m-%d')
    pick_date(page, d6)
    page.fill('#reqView .rq-place', '台中央廚'); page.fill('#reqView .rq-why', '支援盤點')
    submit_ok(page, {'kind': 'trip', 'date': d6, 'start': s, 'end': e, 'hours': D.span_hours(s, e), 'place': '台中央廚', 'reason': '地點：台中央廚；事由：支援盤點'}, '出差只一段')
    click(page, '#reqView .rq-tabs button[data-tab=trip]', '出差分頁')
    click(page, '#reqView .rq-chip:text-is("整天")', '整天')
    page.wait_for_selector('#reqView .rq-hours', timeout=3000)
    page.fill('#reqView .rq-hours', '6')
    d7 = (now_tz() + timedelta(days=RNG.randint(16, 30))).strftime('%Y-%m-%d')
    pick_date(page, d7)
    page.fill('#reqView .rq-place', '員林南昌'); page.fill('#reqView .rq-why', '新品教學；試菜')
    submit_ok(page, {'kind': 'trip', 'date': d7, 'hours': 6, 'place': '員林南昌', 'reason': '地點：員林南昌；事由：新品教學；試菜'}, '出差整天（事由裡的全形分號不影響地點）')
    # 我的申請：撤銷、核准、退回、作廢
    page.wait_for_selector('#reqView .rq-item', timeout=3000)
    items = page.locator('#reqView .rq-item')
    ok('我的申請：標題「最近 60 天」、筆數＝送出的筆數、最新在最前', '最近 60 天' in req_text(page) and items.count() == 8 and first_item(page)['title'] == '出差 6 小時', items.count())
    dlg(page, accept=False)
    click(page, '#reqView .rq-item >> nth=0 >> button.rq-link', '取消（取消）')
    page.wait_for_timeout(300)
    ok('撤銷：按「取消這筆申請」先問「確定要取消這筆申請？」；取消＝不送', dlg(page)[-1] == '確定要取消這筆申請？' and not any(x['action'] == 'req_cancel' for x in calls(page)), dlg(page)[-1:])
    dlg(page, accept=True)
    click(page, '#reqView .rq-item >> nth=0 >> button.rq-link', '取消（確定）')
    page.wait_for_function("document.querySelector('#reqView .rq-item .rq-pill').textContent === '已取消'", timeout=8000)
    it = page.locator('#reqView .rq-item').first
    rr = [x for x in read_store(A['code'])['requests'] if x['emp_id'] == p['emp_id']]   # 只看這位同仁的（同一家店的檔案裡還有別人用 API 送的單）
    cancelled = [x for x in rr if x['status'] == 'cancelled']
    ok('撤銷：狀態「已取消」、沒有取消鍵；資料檔 decided_by「本人取消」', it.locator('.rq-pill').inner_text() == '已取消' and it.locator('button.rq-link').count() == 0
       and len(cancelled) == 1 and cancelled[0]['decided_by'] == '本人取消' and cancelled[0]['kind'] == 'trip', cancelled)
    r = api(A['code'], {'action': 'req_cancel', 'id_token': tok(p), 'id': cancelled[0]['id']})
    ok('撤銷：已處理過的不能再取消（逐字）', r == {'ok': False, 'error': 'not_pending', 'message': '主管已經處理過這筆，不能取消；要改請找主管'}, r)
    pend = [x for x in rr if x['status'] == 'pending']
    rej = pend[0]; vd = pend[1]
    r1 = api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': rej['id'], 'decision': 'reject', 'reason': ''})
    ok('主管：退回沒寫理由 → 擋', r1 == {'ok': False, 'error': 'need_reason', 'message': '退回要寫理由'}, r1)
    api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': rej['id'], 'decision': 'reject', 'reason': '人力夠'})
    api(A['code'], {'action': 'mgr_req_decide', 'mgr_key': mgr['key'], 'id': vd['id'], 'decision': 'approve'})
    r2 = api(A['code'], {'action': 'mgr_req_void', 'mgr_key': mgr['key'], 'id': vd['id'], 'reason': '同仁改單'})
    ok('主管：作廢已核准的申請', r2.get('status') == 'voided', r2)
    r3 = api(A['code'], {'action': 'mgr_req_void', 'mgr_key': mgr['key'], 'id': rej['id'], 'reason': 'x'})
    ok('主管：退回的不能作廢（逐字）', r3 == {'ok': False, 'error': 'not_approved', 'message': '只有已核准的申請可以作廢'}, r3)
    page.close()
    page = open_req(ctx, A, p, 'leave')   # 「我的申請」在開頁、送出、取消時重讀；主管的處理結果要重開才看得到
    click(page, '#reqView .rq-tabs button[data-tab=mine]', '我的申請')
    page.wait_for_selector('#reqView .rq-item', timeout=3000)
    page.wait_for_timeout(300)
    texts = page.locator('#reqView .rq-item').all_inner_texts()
    ok('我的申請：退回 → 「已退回」＋「主管：理由」', any('已退回' in t and '主管：人力夠' in t and '取消這筆申請' not in t for t in texts), texts)
    ok('我的申請：作廢 → 「已作廢」＋「<主管> 作廢：理由」', any('已作廢' in t and f'{mgr["name"]} 作廢：同仁改單' in t for t in texts), texts)
    ok('我的申請：核准 → 「已核准」＋「<主管> 核准」', any('已核准' in t and f'{mgr["name"]} 核准' in t for t in texts), texts)
    no_undefined(page, '我的申請')
    # 送出時登入逾時：不自動重整，給「重新連線」
    page.evaluate("window.__fake.req_submit = {ok:false, error:'invalid_id_token'}")
    click(page, '#reqView .rq-tabs button[data-tab=ot]', '加班分頁')
    pick_time(page, 0, '18:00'); pick_time(page, 1, '19:00'); page.fill('#reqView input[type=text]', '逾時測試')
    submit(page)
    wait_req(page, '這張還沒送出')
    ok('登入逾時（送出）：「LINE 登入逾時，這張還沒送出。按「重新連線」後要再填一次。」＋重新連線鍵', err_box(page) == 'LINE 登入逾時，這張還沒送出。\n按「重新連線」後要再填一次。'
       and page.locator('#reqView button:text-is("重新連線")').count() == 1, err_box(page))
    click(page, '#reqView button:text-is("重新連線")', '重新連線')
    page.wait_for_function("document.getElementById('reqView').textContent.indexOf('讀取中') >= 0 || document.querySelector('#reqView .rq-tabs')", timeout=8000)
    ok('登入逾時（送出）：按「重新連線」才重整', True)
    page.close()
    # 計時同仁（補休不開放；2026-11-04 起假別照樣列補休，選了會說只有正職）：加班分頁沒補休說明、沒有補休帳
    d = read_store(''); d['mock_comp'] = {'allowed': False, 'known': True, 'ot_h': 0, 'used_h': 0, 'balance_h': 0, 'ym': comp['ym']}; write_store('', d)
    page = open_req(ctx, A, p, 'ot')
    ok('補休：計時同仁的加班分頁沒有補休說明', '先抵當月請的補休' not in req_text(page))
    click(page, '#reqView .rq-tabs button[data-tab=leave]', '請假分頁')
    page.wait_for_selector('#reqView .rq-chip', timeout=3000)
    ok('補休：計時同仁也看得到「補休」假別、沒有補休帳（2026-11-04）', page.locator('#reqView .rq-chip:text-is("補休")').count() == 1 and page.locator('#reqView .rq-comp-bal').count() == 0)
    page.close()
    d['mock_comp'] = comp; write_store('', d)


# ── 8. 忘打卡：各種日子（沒卡／只上班／只下班／整段／三種都有／跨夜／今天）＋ break ──
def phase_miss(ctx, gen):
    A = gen.A
    p = next(x for x in gen.people if x['scenario'] == 'req_miss')
    evs = events_of(A['code'], p['emp_id'])
    today = now_tz().strftime('%Y-%m-%d')
    page = open_req(ctx, A, p, 'miss')
    page.wait_for_selector('#reqView select.rq-date', timeout=10000)
    scan(page, '忘打卡')
    opts = page.locator('#reqView select.rq-date option').all_inner_texts()
    want = ['選日期（只能選 7 天內）'] + [D.md_wk((now_tz() - timedelta(days=i)).strftime('%Y-%m-%d')) for i in range(0, 8)]
    ok('忘打卡：日期下拉＝今天往前 7 天（逐項、附星期）', opts == want, (opts, want))
    LBL = D.MISS_LABEL

    def choose(date):
        select(page, '#reqView select.rq-date', date, '選日期')
        page.wait_for_selector('#reqView .rq-rec', timeout=10000)
        page.wait_for_timeout(150)
        di = D.day_info(evs, date)
        got_rec = page.inner_text('#reqView .rq-rec')
        on = page.locator('#reqView .rq-chip.on').all_inner_texts()
        fixed = page.locator('#reqView .rq-fixed').all_inner_texts()
        chips = [c for c in page.locator('#reqView .rq-chip').all_inner_texts() if c in LBL.values()]
        if len(di['options']) > 1:
            okc = chips == [LBL[o] for o in di['options']] and on[:1] == [LBL[di['options'][0]]]
        else:
            okc = chips == [] and fixed == [LBL[di['options'][0]] + '（系統查到的）']
        ok(f'忘打卡 {D.md_of(date)}：當天紀錄逐字、缺哪張卡選項＝規格 {di["options"]}', got_rec == D.rec_text(di['punches']) and okc, (got_rec, D.rec_text(di['punches']), chips, on, fixed))
        return di

    def pick_type(t):
        if page.locator(f'#reqView .rq-chip:text-is("{LBL[t]}")').count():
            click(page, f'#reqView .rq-chip:text-is("{LBL[t]}")', '缺哪張卡 ' + LBL[t])
            page.wait_for_selector(f'#reqView .rq-chip.on:text-is("{LBL[t]}")', timeout=3000)

    def reason(r='忘記按', other=''):
        click(page, f'#reqView .rq-chip:text-is("{r}")', '原因 ' + r)
        page.wait_for_selector(f'#reqView .rq-chip.on:text-is("{r}")', timeout=3000)
        if r == '其他':
            page.fill('#reqView input[maxlength="80"]', other)

    def set_times(start=None, end=None):
        """依欄位標籤填時間：start→「實際上班時間」或「回來上班」；end→「實際下班時間」或「休息開始（下班）」"""
        labs = page.locator('#reqView .rq-fld:has(.rq-time) > label').all_inner_texts()
        if start is not None:
            pick_time(page, next(i for i, l in enumerate(labs) if l in ('實際上班時間', '回來上班')), start)
        if end is not None:
            pick_time(page, next(i for i, l in enumerate(labs) if l in ('實際下班時間', '休息開始（下班）')), end)

    def back_to_miss():
        click(page, '#reqView .rq-tabs button[data-tab=miss]', '忘打卡分頁')
        page.wait_for_selector('#reqView select.rq-date', timeout=5000)

    md = p['miss_days']
    # 沒卡 → 上班和下班都沒打（畫面先擋沒選原因，再由後端擋時間）
    di = choose(md['none'])
    set_times('10:00', '18:30')
    submit(page)
    ok('忘打卡（沒卡）：沒選原因 → 「請選原因」（畫面先擋、不送後端）', err_box(page) == '請選原因' and not any(x['action'] == 'req_submit' for x in calls(page)), err_box(page))
    reason('其他', '出差忘了')
    set_times('', '')
    submit(page)
    ok('忘打卡（沒卡）：沒填上班時間 → 「請填實際上班時間」', err_box(page) == '請填實際上班時間', err_box(page))
    set_times('10:00', '10:00')
    submit(page)
    ok('忘打卡（沒卡）：上下班一樣 → 擋（逐字）', err_box(page) == '上班和下班時間一樣，請確認', err_box(page))
    set_times('10:00', '18:30')
    submit_ok(page, {'kind': 'miss', 'date': md['none'], 'miss_type': 'both', 'start': '10:00', 'end': '18:30', 'reason': '其他：出差忘了'}, '忘打卡（上下班都補）')
    back_to_miss()
    # 只有上班卡 → 下班卡／中間休息
    di = choose(md['in_only'])
    ok('忘打卡：說明「補登後當天仍算一次忘刷卡（全勤規則不變）。」', '補登後當天仍算一次忘刷卡（全勤規則不變）。' in req_text(page))
    pick_type('out')
    reason('手機沒電')
    earlier = D.min_hm(D.hm_min(di['open_in']) - 30)
    set_times(end=earlier)
    submit(page)
    ok('忘打卡（只上班）：補的下班比上班卡早 → 擋（逐字）', err_box(page) == f'補的下班時間 {earlier} 比當天上班卡 {di["open_in"]} 還早', err_box(page))
    later = D.min_hm(D.hm_min(di['open_in']) + RNG.choice([300, 420, 545]))
    set_times(end=later)
    submit_ok(page, {'kind': 'miss', 'date': md['in_only'], 'miss_type': 'out', 'end': later, 'reason': '手機沒電'}, '忘打卡（補下班）')
    back_to_miss()
    choose(md['in_only'])
    pick_type('break')
    ok('忘打卡（中間休息）：例子說明＋兩格「休息開始（下班）」「回來上班」＋說明「兩張一起補，算一次」',
       '例如中午 12:00 下班去休息、18:00 回來上班，兩張都忘了打。' in req_text(page) and '休息開始（下班）' in req_text(page) and '回來上班' in req_text(page)
       and '補登後當天仍算一次忘刷卡（全勤規則不變）；中間休息兩張一起補，算一次。' in req_text(page), req_text(page)[:400])
    reason('按錯上下班')
    b_out = D.min_hm(D.hm_min(di['open_in']) + 180)
    set_times(start=D.min_hm(D.hm_min(di['open_in']) + 120), end=b_out)
    submit(page)
    ok('忘打卡（中間休息，上班中那段）：回來比休息開始早 → 「回來上班時間要比休息開始晚」', err_box(page) == '回來上班時間要比休息開始晚', err_box(page))
    set_times(start=D.min_hm(D.hm_min(di['open_in']) + 240), end=di['open_in'])
    submit(page)
    ok('忘打卡（中間休息）：休息開始＝上班卡那一刻 → 「休息時間要在 HH:MM 上班之後」', err_box(page) == f'休息時間要在 {di["open_in"]} 上班之後', err_box(page))
    b_in2 = D.min_hm(D.hm_min(di['open_in']) + 240)
    set_times(start=b_in2, end=b_out)
    submit_ok(page, {'kind': 'miss', 'date': md['in_only'], 'miss_type': 'break', 'start': b_in2, 'end': b_out, 'reason': '按錯上下班'}, '忘打卡（中間休息，同一天已有補下班的單不算重複）')
    back_to_miss()
    # 只有下班卡 → 上班卡
    di = choose(md['out_only'])
    reason('定位抓不到被擋')
    late = D.min_hm(D.hm_min(di['lone_out']) + 15)
    set_times(start=late)
    submit(page)
    ok('忘打卡（只下班）：補的上班比下班卡晚 → 擋（逐字）', err_box(page) == f'補的上班時間 {late} 比當天下班卡 {di["lone_out"]} 還晚', err_box(page))
    early = D.min_hm(D.hm_min(di['lone_out']) - RNG.choice([240, 300, 480]))
    set_times(start=early)
    submit_ok(page, {'kind': 'miss', 'date': md['out_only'], 'miss_type': 'in', 'start': early, 'reason': '定位抓不到被擋'}, '忘打卡（補上班）')
    back_to_miss()
    # 整段 → 只剩中間休息
    di = choose(md['full'])
    sp = di['spans'][0]
    ok('忘打卡（整段）：卡都齊了 → 只剩「中間休息沒打卡（系統查到的）」', di['options'] == ['break'] and page.locator('#reqView .rq-fixed').all_inner_texts() == ['中間休息沒打卡（系統查到的）'])
    reason('忘記按')
    set_times(start=D.min_hm(D.hm_min(sp['in']) - 60), end=D.min_hm(D.hm_min(sp['in']) - 30))
    submit(page)
    ok('忘打卡（整段）：休息不在那段班裡 → 「休息時間要在 X 上班到 Y 下班之間」', err_box(page) == f'休息時間要在 {sp["in"]} 上班到 {sp["out"]} 下班之間', err_box(page))
    r_out = D.min_hm(D.hm_min(sp['in']) + 180); r_in = D.min_hm(D.hm_min(sp['in']) + 240)
    set_times(start=r_in, end=r_out)
    submit_ok(page, {'kind': 'miss', 'date': md['full'], 'miss_type': 'break', 'start': r_in, 'end': r_out, 'reason': '忘記按'}, '忘打卡（整段補休息）')
    back_to_miss()
    # 三種都有：上班卡／下班卡／中間休息三顆籌碼
    di = choose(md['three'])
    ok('忘打卡（三種）：孤的下班、開著的上班、整段 → 三個選項', di['options'] == ['in', 'out', 'break'])
    pick_type('out'); pick_type('break'); pick_type('in')
    reason('忘記按')
    set_times(start='07:30')
    submit_ok(page, {'kind': 'miss', 'date': md['three'], 'miss_type': 'in', 'start': '07:30', 'reason': '忘記按'}, '忘打卡（三種之一：補上班）')
    back_to_miss()
    # 跨夜：6 天前晚上上班、5 天前凌晨下班 → 歸 6 天前；凌晨那張標 (+1)
    di = choose(md['night'])
    ok('忘打卡（跨夜）：凌晨下班卡歸前一天、顯示 (+1)、只剩中間休息', any('(+1)' in x['hm'] for x in di['punches']) and di['options'] == ['break'] and '(+1)' in page.inner_text('#reqView .rq-rec'))
    # 今天：開著的上班卡 → 不能補還沒到的時間
    di = choose(today)
    pick_type('out')
    reason('忘記按')
    future = D.min_hm(D.hm_min(now_tz().strftime('%H:%M')) + 30)
    if D.hm_min(future) > D.hm_min(now_tz().strftime('%H:%M')):
        set_times(end=future)
        submit(page)
        ok('忘打卡（今天）：補還沒到的時間 → 擋（逐字）', err_box(page) == '不能補登還沒到的時間', err_box(page))
    page.close()
    # 後端規則（只能從 API 打到的）：超過 7 天、未來日期、卡其實有打成功、沒選卡
    def sub(body):
        return api(A['code'], dict({'action': 'req_submit', 'id_token': tok(p), 'kind': 'miss', 'reason': '忘記按'}, **body))
    r = sub({'date': (now_tz() - timedelta(days=8)).strftime('%Y-%m-%d'), 'miss_type': 'both', 'start': '09:00', 'end': '18:00'})
    ok('忘打卡（後端）：超過 7 天 → too_old（逐字）', r == {'ok': False, 'error': 'too_old', 'message': '超過 7 天不能申請，請找值班主管直接核定'}, r)
    r = sub({'date': (now_tz() + timedelta(days=1)).strftime('%Y-%m-%d'), 'miss_type': 'both', 'start': '09:00', 'end': '18:00'})
    ok('忘打卡（後端）：明天 → 「不能補登還沒到的日期」', r.get('error') == 'bad_date' and r.get('message') == '不能補登還沒到的日期', r)
    r = sub({'date': md['in_only'], 'miss_type': 'in', 'start': '08:00'})
    ok('忘打卡（後端）：上班卡其實有打成功 → not_missing（逐字）', r.get('error') == 'not_missing' and r.get('message') == '這天的上班卡有打成功，不用補登', r)
    r = sub({'date': md['out_only'], 'miss_type': 'out', 'end': '18:00'})
    ok('忘打卡（後端）：下班卡其實有打成功 → not_missing（逐字）', r.get('message') == '這天的下班卡有打成功，不用補登', r)
    r = sub({'date': md['none'], 'miss_type': 'break', 'start': '13:00', 'end': '12:00'})
    ok('忘打卡（後端）：沒卡的日子不能補中間休息 → 「請選要補哪一張卡」', r.get('message') == '請選要補哪一張卡', r)
    r = sub({'date': md['none'], 'miss_type': 'both', 'start': '09:00', 'end': '18:00'})
    ok('忘打卡（後端）：同一天已有審核中的忘打卡 → duplicate（逐字）', r.get('error') == 'duplicate' and r.get('message') == '這天已經有一筆審核中的忘打卡申請，要改請先取消那一筆', r)
    rr = [x for x in read_store(A['code'])['requests'] if x['emp_id'] == p['emp_id']]
    ok('忘打卡：資料檔 6 筆、break 那兩筆 end＝休息開始、start＝回來上班', len(rr) == 6 and all(x['status'] == 'pending' for x in rr)
       and [x for x in rr if x['miss_type'] == 'break'][0]['end'] == b_out and [x for x in rr if x['miss_type'] == 'break'][0]['start'] == b_in2, [(x['miss_type'], x['start'], x['end']) for x in rr])


# ── 9. 綁兩家店：預設店別＝最近打卡的店；忘打卡自動選店 ──
def phase_dual(ctx, gen):
    A, B = gen.A, gen.B
    pa = next(x for x in gen.people if x['scenario'] == 'req_dual')
    pb = next(x for x in gen.people if x['scenario'] == 'req_dual_b')
    order = [s for s in STORES if s['code'] in (A['code'], B['code'])]   # 綁的店照 stores.json 順序
    names = [s['name'] for s in order]
    best = max([(e['ts'], A['name']) for e in events_of(A['code'], pa['emp_id']) if not e['status'].startswith('rejected')]
               + [(e['ts'], B['name']) for e in events_of(B['code'], pb['emp_id']) if not e['status'].startswith('rejected')])[1]
    page = open_req(ctx, A, pa, 'leave')
    page.wait_for_selector('#reqView select.rq-store', timeout=10000)
    store_of = lambda: page.evaluate("() => { const s = document.querySelector('#reqView select.rq-store'); return s.options[s.selectedIndex].text; }")
    ok('綁兩家：店別下拉＝兩家（照店家表順序）、預設＝最近一張卡那家', page.locator('#reqView select.rq-store option').all_inner_texts() == names and store_of() == best, (store_of(), best, names))
    ok('資料檢查：最近一張卡在 A（才看得出自動換店）', best == A['name'], best)
    click(page, '#reqView .rq-tabs button[data-tab=miss]', '忘打卡分頁')
    page.wait_for_selector('#reqView select.rq-date', timeout=10000)
    dd = pa['dual_days']
    select(page, '#reqView select.rq-date', dd['b_only'], '選日期')
    page.wait_for_selector('#reqView .rq-auto-store', timeout=10000)
    note = page.inner_text('#reqView .rq-auto-store')
    di_b = D.day_info(events_of(B['code'], pb['emp_id']), dd['b_only'])
    ok('自動選店：只有 B 店有卡 → 換到 B、說明逐字、紀錄是 B 那天的卡', store_of() == B['name'] and note == f'{D.md_of(dd["b_only"])} 你在{B["name"]}有打卡，已幫你選這家（不對可以在上面改）'
       and page.inner_text('#reqView .rq-rec') == D.rec_text(di_b['punches']), (store_of(), note, page.inner_text('#reqView .rq-rec')))
    c = [x for x in calls(page) if x['action'] == 'req_info']
    ok('自動選店：兩家店都問了（day_only）', {x['url'].rsplit('/api', 1)[1] for x in c} >= {('/' + A['code']) if A['code'] else '', ('/' + B['code']) if B['code'] else ''}, c)
    page.screenshot(path=os.path.join(SHOTS, 'ddt_忘打卡_自動選店.jpg'), type='jpeg', quality=70)
    pick_time(page, 0, '22:00')
    click(page, '#reqView .rq-chip:text-is("忘記按")', '原因')
    submit_ok(page, {'kind': 'miss', 'date': dd['b_only'], 'miss_type': 'out', 'end': '22:00', 'reason': '忘記按'}, '自動選店：送到 B')
    sent = [x for x in calls(page) if x['action'] == 'req_submit']
    ok('自動選店：req_submit 打到 B 店、B 的資料檔多一筆、A 沒有', sent[-1]['url'].endswith('/api' + ('/' + B['code'] if B['code'] else ''))
       and any(r['emp_id'] == pb['emp_id'] and r['date'] == dd['b_only'] for r in read_store(B['code'])['requests'])
       and not any(r['emp_id'] == pa['emp_id'] for r in read_store(A['code'])['requests']), sent[-1:])
    # 手動改回 A：說明消失、顯示 A 那天沒有卡（重開：預設店別才會回到 A）
    page.close()
    page = open_req(ctx, A, pa, 'miss')
    page.wait_for_selector('#reqView select.rq-date', timeout=10000)
    select(page, '#reqView select.rq-date', dd['b_only'], '選日期')
    page.wait_for_selector('#reqView .rq-auto-store', timeout=10000)
    select(page, '#reqView select.rq-store', str(names.index(A['name'])), '手動換店')
    page.wait_for_function("() => document.querySelector('#reqView .rq-rec') && !document.querySelector('#reqView .rq-auto-store')", timeout=10000)
    ok('自動選店：手動改回 A → 說明消失、顯示 A 那天「沒有任何打卡」', store_of() == A['name'] and page.inner_text('#reqView .rq-rec') == '當天紀錄：沒有任何打卡', page.inner_text('#reqView .rq-rec'))
    select(page, '#reqView select.rq-date', dd['both'], '選日期')
    page.wait_for_selector('#reqView .rq-auto-store.warn', timeout=10000)
    ok('自動選店：兩家都有卡 → 店別不動、橘字提醒逐字（店名照店家表順序）', store_of() == A['name']
       and page.inner_text('#reqView .rq-auto-store.warn') == f'{D.md_of(dd["both"])} 你在{"、".join(names)}都有打卡，請確認上面選的店是你要補登的那家', page.inner_text('#reqView .rq-auto-store.warn'))
    select(page, '#reqView select.rq-date', dd['none'], '選日期')
    page.wait_for_selector('#reqView .rq-rec', timeout=10000)
    page.wait_for_timeout(200)
    ok('自動選店：都沒卡 → 不換、不說明', store_of() == A['name'] and page.locator('#reqView .rq-auto-store').count() == 0)
    page.close()
    # B 店問不到 → 不換店
    u, _ = url(A, pa['line_user_id'], extra='&view=req&tab=miss')
    page = ctx.new_page(); page.add_init_script(LOG_JS)
    page.route('**/api' + ('/' + B['code'] if B['code'] else ''), lambda r: r.abort() if 'day_only' in (r.request.post_data or '') else r.continue_())
    page.goto(u)
    page.wait_for_selector('#reqView select.rq-date', timeout=10000)
    page.select_option('#reqView select.rq-date', dd['b_only'])
    page.wait_for_selector('#reqView .rq-rec', timeout=15000)
    ok('自動選店：B 店問不到 → 不換店、照舊顯示 A 那天', page.evaluate("() => { const s = document.querySelector('#reqView select.rq-store'); return s.options[s.selectedIndex].text; }") == A['name']
       and page.locator('#reqView .rq-auto-store').count() == 0 and page.inner_text('#reqView .rq-rec') == '當天紀錄：沒有任何打卡', page.inner_text('#reqView')[:200])
    page.close()


# ── 10. 出勤班表（sched-line.js）──
def phase_sched(ctx, gen):
    sc = gen.sched
    full = next(x for x in gen.people if x['scenario'] == 'sched_full')
    part = next(x for x in gen.people if x['scenario'] == 'sched_part')
    dup = next(x for x in gen.people if x['scenario'] == 'sched_dup')
    prev, cur = sc['months']
    today = now_tz().strftime('%Y-%m-%d')

    def page_of(uid, pre=None):
        pg = open_page(ctx, f'{BASE}/clock-line.html?mock_uid={uid}&api=/api&view=sched&retry_ms=50', pre=pre)
        pg.wait_for_selector('#schedView .sc-cal, #schedView .sc-box', timeout=12000)
        return pg

    def person_spec(p):
        return next(x for x in sc['people'] if x['name'] == p['name'])

    page = page_of(full['line_user_id'])
    ok('班表：不定位、只打光復 line_hub_sched、打卡卡片隱藏', [x['action'] for x in calls(page)] == ['line_hub_sched'] and calls(page)[0]['url'].endswith('/api')
       and page.evaluate('window.__geo') == 0 and page.locator('#punchCard').is_hidden(), calls(page))
    ex = D.sched_expect(sc, person_spec(full), cur, today, now_tz().strftime('%H:%M'))
    ok('班表：標題有姓名、月份、月曆格子數＝當月天數', page.inner_text('#schedView .sc-who') == full['name'] and page.inner_text('#schedView .sc-mon b') == f'{cur[:4]} 年 {int(cur[5:7])} 月'
       and page.locator('#schedView .sc-day').count() == len(ex['days']), page.inner_text('#schedView .sc-mon'))
    td = int(today[8:10])
    ok('班表：本月預設選今天、今天有外框', page.locator(f'#schedView .sc-day.sel.today[data-d="{td}"]').count() == 1)
    scan(page, '班表月曆（本月）')
    wrong = []
    for x in ex['days']:
        cell = page.inner_text(f'#scD{x["d"]}').split()
        cls = page.get_attribute(f'#scD{x["d"]}', 'class')
        want_cls = 'work' if x['work'] else 'off' if x['code'] else 'none'
        if cell != D.sched_cell(x) or want_cls not in cls.split():
            wrong.append((x['d'], cell, D.sched_cell(x), cls))
        click(page, f'#scD{x["d"]}', '看當天明細')
        det = page.inner_text('#scDet')
        if det != D.sched_detail(x, cur):
            wrong.append((x['d'], det, D.sched_detail(x, cur)))
    ok('班表：每一格的字（上班＝起訖、休假＝中文、公休＝代碼）、顏色類別、點進去的明細（班別／站別／各段／合計／午晚餐備註）全部＝規格', not wrong, wrong[:3])
    offs = {x['code'] for x in ex['days'] if x['code'] and not x['work']}
    ok('班表：資料檢查——R／H／國定假日／病假都出現且格子寫中文（例假／休假／國定假日／病假）', {'R', 'H', '國', '病'} <= offs
       and {'例假', '休假', '國定假日', '病假'} <= set(page.locator('#schedView .sc-day .sc-o').all_inner_texts()), (offs, set(page.locator('#schedView .sc-day .sc-o').all_inner_texts())))
    ok('班表：格子的字在 375 寬不超出', page.evaluate("Array.from(document.querySelectorAll('#schedView .sc-day .sc-o, #schedView .sc-day .sc-t')).every(e => e.scrollWidth <= e.parentElement.clientWidth + 1)")
       and page.evaluate('document.documentElement.scrollWidth <= 375'))
    no_undefined(page, '班表月曆')
    page.screenshot(path=os.path.join(SHOTS, 'ddt_班表_月曆.jpg'), type='jpeg', quality=70)
    click(page, '#schedView .rq-tabs button[data-tab=sum]', '摘要')
    scan(page, '班表摘要')
    sm = ex['summary']
    nums = page.locator('#schedView .sc-sum b').all_inner_texts()
    ok('班表摘要：排班天數／休假天數／排班時數＝規格（上班＝非休假且非國定；時數＝班別時數−休息）', nums == [str(sm['work_days']), str(sm['off_days']), D.js_num(sm['hours'])], (nums, sm))
    nx = ex['next']
    want = '下一個班\n' + (('本月沒有接下來的班。') if not nx else
                        ('今天 ' if '%s-%02d' % (cur, nx['d']) == today else '') + D.md_wk('%s-%02d' % (cur, nx['d'])) + '\n' + nx['label'] + '　' + '、'.join(a + '–' + b for a, b in nx['segs'])
                        + ('　站：' + nx['station'] if nx.get('station') else ''))
    ok('班表摘要：下一個班（日期、班別、各段、站別）逐字', page.inner_text('#scNextShift') == want, (page.inner_text('#scNextShift'), want))
    click(page, '#schedView .rq-tabs button[data-tab=cal]', '月曆')
    n_calls = len(calls(page))
    click(page, '#scPrev', '上個月')
    page.wait_for_function('document.querySelector("#schedView .sc-mon b") && document.querySelector("#schedView .sc-mon b").textContent.indexOf(" %d 月") >= 0' % int(prev[5:7]), timeout=8000)
    exp = D.sched_expect(sc, person_spec(full), prev, today, now_tz().strftime('%H:%M'))
    wrong = []
    for x in exp['days']:
        if page.inner_text(f'#scD{x["d"]}').split() != D.sched_cell(x):
            wrong.append((x['d'], page.inner_text(f'#scD{x["d"]}').split(), D.sched_cell(x)))
        click(page, f'#scD{x["d"]}', '上個月明細')
        if page.inner_text('#scDet') != D.sched_detail(x, prev):
            wrong.append((x['d'], page.inner_text('#scDet')[:80]))
    ok('班表：上個月每一格與明細＝規格、切月帶 ym 只打 1 次、不預選日期、「‹」不能按', not wrong and len(calls(page)) == n_calls + 1 and page.locator('#scPrev').is_disabled(), wrong[:3])
    click(page, '#schedView .rq-tabs button[data-tab=sum]', '摘要')
    ok('班表：上個月的摘要「「下一個班」只看本月。」', '「下一個班」只看本月。' in page.inner_text('#scNextShift'))
    click(page, '#schedView .rq-tabs button[data-tab=cal]', '月曆')
    click(page, '#scNext', '回本月')
    ok('班表：切回本月不再打後端、「›」不能按', len(calls(page)) == n_calls + 1 and page.locator('#scNext').is_disabled())
    page.close()
    # 計時同仁：已排班後的空白天＝休假；上個月沒排 → no_schedule
    page = page_of(part['line_user_id'])
    exp = D.sched_expect(sc, person_spec(part), cur, today, now_tz().strftime('%H:%M'))
    blanks = [x for x in exp['days'] if x['code'] == '休']
    ok('班表（計時）：排班後的空白天寫「休假」、摘要休假天數含這些天', blanks and all(page.inner_text(f'#scD{x["d"]}').split() == [str(x['d']), '休假'] for x in blanks), [(x['d'], page.inner_text(f'#scD{x["d"]}')) for x in blanks[:2]])
    click(page, '#scPrev', '上個月')
    page.wait_for_selector('#schedView .sc-box.info', timeout=8000)
    ok('班表（計時）：上個月沒有他的班 → 「M 月的班表沒有你的班。」（逐字）', page.inner_text('#schedView .sc-box') == f'{int(prev[5:7])} 月的班表沒有你的班。', page.inner_text('#schedView .sc-box'))
    page.close()
    page = page_of(dup['line_user_id'])
    ok('班表：排班系統兩位同名 → 「你的班表還沒對上，請找店長確認。」（逐字）', page.inner_text('#schedView .sc-box') == '你的班表還沒對上，請找店長確認。', page.inner_text('#schedView .sc-box'))
    page.close()
    page = page_of('Unobody')
    ok('班表：沒綁定的 LINE → 「找不到你在職的打卡門市，請找店長確認。」（逐字）', page.inner_text('#schedView .sc-box') == '找不到你在職的打卡門市，請找店長確認。', page.inner_text('#schedView .sc-box'))
    page.close()
    d = read_store(''); d['mock_sched']['unlock'] = ['%d_%d' % (int(cur[:4]), int(cur[5:7]))]; write_store('', d)
    page = page_of(full['line_user_id'])
    ok('班表：月份還沒鎖定 → 「M 月的班表還在排，排好後就看得到。」、不畫月曆', page.inner_text('#schedView .sc-box') == f'{int(cur[5:7])} 月的班表還在排，排好後就看得到。' and page.locator('#schedView .sc-cal').count() == 0)
    page.close()
    d['mock_sched'].pop('unlock'); d['mock_sched']['fail'] = True; write_store('', d)
    page = page_of(full['line_user_id'])
    ok('班表：讀不到 → 「班表暫時讀不到，請稍後再試。」＋重新整理', page.inner_text('#schedView .sc-box') == '班表暫時讀不到，請稍後再試。' and page.locator('#scReload').count() == 1)
    d['mock_sched'].pop('fail'); write_store('', d)
    scan(page, '班表讀取失敗')
    click(page, '#scReload', '重新整理')
    page.wait_for_selector('#schedView .sc-cal', timeout=8000)
    ok('班表：重新整理後讀得到', page.locator('#schedView .sc-day').count() == len(ex['days']))
    page.close()
    page = page_of(full['line_user_id'], pre="window.__fake = { line_hub_sched: 'abort' };")
    page.wait_for_selector('#schedView .sc-box.err', timeout=40000)
    ok('班表：斷線重試三次後「連線不穩，班表沒有讀到。」（逐字）', page.inner_text('#schedView .sc-box') == '連線不穩，班表沒有讀到。' and len([x for x in calls(page) if x['action'] == 'line_hub_sched']) == 3, calls(page))
    page.close()


if __name__ == '__main__':
    main()
