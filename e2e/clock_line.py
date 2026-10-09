#!/usr/bin/env python3
"""LINE 打卡畫面（clock-line.html）方案 C 端對端：畫面自己挑店、直接打那家店的後端。

用法：/usr/bin/python3 e2e/clock_line.py
會清掉本 worktree 的 mock/mock_data*.json、在 E2E_MOCK_PORT（預設 8947）起 mock，跑完關掉。
"""
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clickmap import ClickMap, KEY_JS  # noqa: E402
CM = ClickMap()   # 只用在班表頁（2026-10-10）

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('E2E_MOCK_PORT', '8947'))
BASE = f'http://localhost:{PORT}'
STORES = {s['code']: s for s in json.load(open(os.path.join(ROOT, 'tools', 'stores.json'), encoding='utf-8'))}
HQ, JS = STORES['hq'], STORES['mztjs']
SHOTS = os.path.join(ROOT, 'e2e', 'artifacts')

n = 0


def ok(name, cond, detail=''):
    global n
    if not cond:
        raise AssertionError(name + ('：' + str(detail) if detail else ''))
    n += 1
    print('✓ ' + name)


def start_mock():
    try:   # port 已被別的 mock 占用就停（不然會測到別的 worktree 的舊頁面）
        urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
        raise SystemExit(f'port {PORT} 已有伺服器在跑，請設 E2E_MOCK_PORT 換一個')
    except OSError:
        pass
    for f in glob.glob(os.path.join(ROOT, 'mock', 'mock_data*.json')):
        os.remove(f)
    env = dict(os.environ, MOCK_PORT=str(PORT))
    os.makedirs(SHOTS, exist_ok=True)
    log = open(os.path.join(SHOTS, 'mock_server.log'), 'w')   # mock 中途死掉時查得到原因（審查 P2#11）
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'mock', 'mock_server.py')], env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('mock 起不來')


# 頁面內記錄每個請求打到哪個網址、什麼 action（Apps Script 的 302 會讓 Playwright 讀不到 body，所以在頁內包 fetch）
LOG_JS = """
window.__geo = 0;   // 班表頁不該碰定位（審查 P2#3）
if (navigator.geolocation) ['getCurrentPosition', 'watchPosition'].forEach(function (f) {
  const o = navigator.geolocation[f].bind(navigator.geolocation);
  navigator.geolocation[f] = function () { window.__geo++; return o.apply(null, arguments); };
});
window.__calls = [];
window.__fake = {};   // action → 假回應（物件）或 'abort'
const _f = window.fetch;
window.fetch = function (url, o) {
  let a = ''; try { a = JSON.parse(o.body).action; } catch (e) {}
  window.__calls.push({ url: String(url), action: a, t: Date.now() });
  let fk = window.__fake[a];
  if (Array.isArray(fk)) fk = fk.length > 1 ? fk.shift() : fk[0];   // 陣列＝依序回，最後一個一直回
  if (fk === 'real') fk = null;
  if (fk === 'lost') return _f.apply(this, arguments).then(function () { throw new TypeError('Failed to fetch'); });   // 伺服器收到了、回應弄丟
  if (fk === 'abort') return Promise.reject(new TypeError('Failed to fetch'));
  if (fk === 'midnight') return _f.apply(this, arguments).then(function (r) { return r.json(); }).then(function (j) {   // 重讀時已跨午夜：今天清空、最後一張卡是剛才那筆
    j.today = []; if (j.guard) j.guard.last = { type: 'out', hm: '00:00', ts: '2099-01-01T00:00:05+08:00' };
    return new Response(JSON.stringify(j));
  });
  if (fk === 'hang') return new Promise(function (res, rej) {   // 永不回應，只在頁面自己的逾時 abort 時結束
    if (o.signal) o.signal.addEventListener('abort', function () { rej(new DOMException('aborted', 'AbortError')); });
  });
  if (fk) return Promise.resolve(new Response(JSON.stringify(fk)));
  return _f.apply(this, arguments);
};
"""


def url(loc, acc=10, uid='U1', in_client=False, extra=''):
    q = f'mock_uid={uid}&api=/api&loc={loc[0]},{loc[1]}&acc={acc}' + ('&in_client=1' if in_client else '') + extra
    return BASE + '/clock-line.html?' + q


def open_page(ctx, u, pre=None):
    p = ctx.new_page()
    p.add_init_script(LOG_JS)
    if pre:
        p.add_init_script(pre)   # 開頁前就設好假回應（第一次讀取在頁面載入時就發生）
    p.goto(u)
    return p


def msg(p):
    return p.inner_text('#msg') + '\n' + p.inner_text('#hint')


def wait_msg(p, needle, timeout=8000):
    p.wait_for_function('(s) => (document.getElementById("msg").textContent + document.getElementById("hint").textContent).indexOf(s) >= 0',
                        arg=needle, timeout=timeout)


def no_undefined(p, where):
    t = p.inner_text('body')
    ok(where + '：畫面沒有 undefined／null 字樣', 'undefined' not in t and 'null' not in t, t[:200])


def force_out(p):
    """模擬「畫面沒擋到」：鍵被畫面停用（10 分鐘鎖）時，同一個 tick 內解開並點下去，測後端擋下時畫面怎麼顯示。"""
    p.evaluate('() => { const b = document.getElementById("btnOut"); b.disabled = false; b.click(); }')


def calls(p):
    return p.evaluate('window.__calls')


def main():
    os.makedirs(SHOTS, exist_ok=True)
    proc = start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context()
            hq = (HQ['lat'], HQ['lng'])

            # 1. 第一次使用：總部回沒綁定 → 改問光復 → 顯示綁定框 → 輸入全名綁定 → 直接問總部變 ready
            p = open_page(ctx, url(hq))
            p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
            c = calls(p)
            ok('開頁先直接問挑到的店（總部 /api/hq liff_status）', c[0]['url'].endswith('/api/hq') and c[0]['action'] == 'liff_status', c)
            ok('那家店說沒綁定 → 改問光復 line_hub_status', c[1]['url'].endswith('/api') and c[1]['action'] == 'line_hub_status', c)
            p.fill('#bindName', '測試一')
            p.click('#btnBind')
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            c = calls(p)
            ok('綁定走光復 line_bind_name', any(x['action'] == 'line_bind_name' and x['url'].endswith('/api') for x in c), c)
            ok('綁定後重讀直接問總部', c[-1]['action'] == 'liff_status' and c[-1]['url'].endswith('/api/hq'), c[-1])

            # 1b. 店內公告（2026-10-09）：主管在核定頁發的公告，LINE 打卡頁最上方也看得到；沒公告整塊不顯示；HTML 一律當純文字；多則輪播
            ok('店內公告：沒有公告時整塊不顯示', p.locator('#noticeBox').is_hidden())
            for t in ['第一則：<b>花椒粉</b>用完換辣椒粉', '第二則：今晚盤點']:
                r = p.evaluate("t => fetch('/api/hq', {method:'POST', body: JSON.stringify({action:'mgr_add_notice', mgr_key:'testmgr1', text:t, ends_on:''})}).then(r => r.json())", t)
                ok('店內公告：主管發布「%s」' % t[:6], r.get('ok') is True, r)
            p.reload(); p.wait_for_selector('#noticeBox:not([hidden])', timeout=10000)
            first = p.inner_text('#noticeMsg')
            ok('店內公告：LINE 打卡頁最上方顯示', first in ('第二則：今晚盤點', '第一則：<b>花椒粉</b>用完換辣椒粉'), first)
            ok('店內公告：兩則有輪播點', p.locator('#noticeDots i').count() == 2)
            p.wait_for_function("t => document.getElementById('noticeMsg').textContent !== t", arg=first, timeout=8000)
            second = p.inner_text('#noticeMsg')
            ok('店內公告：5 秒換下一則、兩則都輪得到', {first, second} == {'第二則：今晚盤點', '第一則：<b>花椒粉</b>用完換辣椒粉'}, (first, second))
            ok('店內公告：HTML 當純文字顯示（不會變成粗體標籤）', p.locator('#noticeMsg b').count() == 0)
            ok('店內公告：在日期上方', p.evaluate("() => !!(document.getElementById('noticeBox').compareDocumentPosition(document.getElementById('date')) & Node.DOCUMENT_POSITION_FOLLOWING)"))
            ok('店名顯示總部', p.inner_text('#storeName') == HQ['name'], p.inner_text('#storeName'))
            no_undefined(p, '綁定後')
            p.close()

            # 2. 已綁定：開頁只打 1 次後端；按上班只打 1 次後端；結果、問候語、代送「打卡」、關閉
            p = open_page(ctx, url(hq, in_client=True))
            p.wait_for_function('!document.getElementById("btnIn").disabled', timeout=10000)
            ok('開畫面只打 1 次後端（店家 liff_status）', [x['action'] for x in calls(p)] == ['liff_status'], calls(p))
            p.click('#btnIn')
            wait_msg(p, '上班打卡成功')
            c = [x for x in calls(p) if x['action'] != 'liff_status']
            ok('按上班只打 1 次後端（店家 liff_punch）', len(c) == 1 and c[0]['action'] == 'liff_punch' and c[0]['url'].endswith('/api/hq'), c)
            m = msg(p)
            ok('成功訊息含時間、地點、問候語', '地點：' + HQ['name'] in m and any(w in m for w in ('早安', '午安', '晚上好')), m)
            ok('第一次打卡沒有漏卡：不顯示忘打卡提醒', '⚠️' not in m, m)
            ok('畫面即將關閉：兩顆鍵都停用', p.is_disabled('#btnIn') and p.is_disabled('#btnOut'))
            p.wait_for_function('window.__closed === true', timeout=4000)
            ok('代同仁送出「打卡」給機器人並關閉', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡'}])
            p.close()

            # 3. 重開：伺服器 guard 擋上班、下班倒數；今天的卡顯示出來
            p = open_page(ctx, url(hq))
            p.wait_for_function('document.getElementById("today").textContent.indexOf("上班") >= 0', timeout=10000)
            ok('重開：今天有上班卡、上班鍵停用、下班鍵倒數', p.is_disabled('#btnIn') and '分後' in p.inner_text('#btnOut'), p.inner_text('#btnOut'))
            p.close()

            # 4. 伺服器端防呆（模擬畫面沒擋到、後端擋下）：顯示原因與怎麼辦、重讀狀態
            p = open_page(ctx, url(hq))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = {ok:false, type:'out', reason:'你 10:00 剛打過上班卡，7 分鐘內不能打下班卡（避免連按誤打）', hint:'真的要下班請告知主管補登'}")
            force_out(p)
            wait_msg(p, '下班打卡失敗')
            no_undefined(p, '後端擋下')
            ok('後端擋下：顯示原因與怎麼辦', '7 分鐘內不能打下班卡' in msg(p) and '怎麼辦：真的要下班請告知主管補登' in msg(p), msg(p))

            # 4b. 忘打卡提醒（2026-10-09）：成功回應帶 missed → 畫面在問候語前多一段 ⚠️
            q = open_page(ctx, url(hq))
            q.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            q.evaluate("window.__fake.liff_punch = {ok:true, type:'out', ts:'2026-10-08T17:00:00+08:00', greeting:'辛苦了', missed:'你這次沒有打上班卡，請跟主管說實際上班時間'}")
            force_out(q)
            wait_msg(q, '下班打卡成功')
            m = msg(q)
            ok('忘打卡提醒：顯示在問候語之前', '⚠️ 你這次沒有打上班卡' in m and m.index('⚠️') < m.index('辛苦了'), m)
            q.close()

            # 5. 處理中、無回應、連線中斷：每按一次只送一次 liff_punch（不自動重送）
            for fake, needle in [({'ok': False, 'type': 'out', 'reason': '上一筆還在處理中', 'hint': '請等幾秒'}, '上一筆還在處理中'),
                                 ({'ok': False, 'error': 'server_error'}, '系統沒有正常回應'),
                                 ('abort', '卡沒有送出')]:   # 斷線 → 回頭確認（2026-10-09）
                p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
                before = sum(1 for x in calls(p) if x['action'] == 'liff_punch')
                p.evaluate('(f) => { window.__fake.liff_punch = f; }', fake)
                force_out(p)
                wait_msg(p, needle)
                p.wait_for_timeout(300)
                sent = sum(1 for x in calls(p) if x['action'] == 'liff_punch') - before
                ok('失敗路徑：' + needle + '（只送 1 次）', sent == 1, sent)
            # 太頻繁：鍵不亮、出現「重新定位」（審查 #4）
            p.evaluate("window.__fake.liff_punch = {ok:false, error:'too_many'}")
            force_out(p)
            wait_msg(p, '按太多次了')
            p.wait_for_timeout(300)
            ok('太頻繁：兩顆鍵停用、可按重新定位', p.is_disabled('#btnIn') and p.is_disabled('#btnOut') and p.is_visible('#btnRetry'))
            p.close()

            # 5b. 25 秒逾時（本機用 post_timeout 縮短）：只送 1 次、說不確定有沒有進去
            p = open_page(ctx, url(hq, extra='&post_timeout=1500'))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = 'hang'")
            force_out(p)
            wait_msg(p, '卡沒有送出', timeout=15000)
            ok('逾時：只送 1 次、不重送，回頭確認說沒有送出', sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 1)
            p.close()

            # 5c. 打卡時店家說沒綁定（開頁時明明綁著＝資料對不上）→ 不轉光復、不亮鍵、請找主管（審查 #2）
            p = open_page(ctx, url(hq))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = {ok:false, error:'not_bound'}")
            force_out(p)
            wait_msg(p, '沒有認得你的 LINE 帳號')
            ok('資料對不上：鍵停用、不轉光復', p.is_disabled('#btnIn') and p.is_disabled('#btnOut')
               and not any(x['action'] == 'line_hub_status' for x in calls(p)))
            p.close()

            # 5d. 店家 liff_status 說沒綁、光復卻說綁著 → 一樣不亮鍵
            p = open_page(ctx, url(hq, extra=''))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_status = {ok:false, error:'not_bound'}")
            p.evaluate("() => { document.getElementById('btnRetry').hidden = false; document.getElementById('btnRetry').click(); }")
            wait_msg(p, '沒有認得你的 LINE 帳號')
            ok('開頁兩邊對不上：鍵停用', p.is_disabled('#btnIn') and p.is_disabled('#btnOut'))
            p.close()

            # 5e. LINE 登入逾時：不停在「送出中」（審查 #5）
            p = open_page(ctx, url(hq))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = {ok:false, error:'invalid_id_token'}")
            force_out(p)
            wait_msg(p, 'LINE 登入逾時')
            ok('登入逾時：訊息改掉、不停在送出中', '打卡中' not in msg(p), msg(p))
            p.close()

            # 6. 不在任何店範圍：不打任何後端
            p = open_page(ctx, url((24.70, 121.10)))
            wait_msg(p, '不在任何打卡地點範圍內')
            ok('超出範圍：畫面自己判斷，不打後端', calls(p) == [], calls(p))
            p.close()

            # 7. 總部與金山中間、誤差大 → 分不出來，擋
            mid = ((HQ['lat'] + JS['lat']) / 2, (HQ['lng'] + JS['lng']) / 2)
            p = open_page(ctx, url(mid, acc=100))
            wait_msg(p, '分不出你在哪一家店')
            ok('兩家都可能：擋下、不打後端', calls(p) == [] and p.is_disabled('#btnIn'), calls(p))
            p.close()

            # 8. 金山：同一個 LINE 還沒綁金山 → 光復帶出跨店同名建議
            p = open_page(ctx, url((JS['lat'], JS['lng'])))
            p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
            c = calls(p)
            ok('金山沒綁 → 先問金山、再問光復', c[0]['url'].endswith('/api/mztjs') and c[1]['action'] == 'line_hub_status', c)
            p.close()

            # 9. 開頁時在總部，按下前人移到金山（還沒綁金山）→ 不打卡、重讀，改顯示金山的綁定
            gctx = br.new_context(geolocation={'latitude': HQ['lat'], 'longitude': HQ['lng'], 'accuracy': 10}, permissions=['geolocation'])
            p = gctx.new_page()
            p.add_init_script(LOG_JS)
            p.goto(BASE + '/clock-line.html?mock_uid=U1&api=/api')
            p.wait_for_function('document.getElementById("storeName").textContent === %s' % json.dumps(HQ['name']), timeout=20000)
            gctx.set_geolocation({'latitude': JS['lat'], 'longitude': JS['lng'], 'accuracy': 10})
            p.wait_for_timeout(1500)
            p.evaluate('() => { const b = document.getElementById("btnOut"); b.disabled = false; b.click(); }')
            p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
            c = calls(p)
            ok('位置變了：沒有送出打卡，改問新那家店（金山）', not any(x['action'] == 'liff_punch' for x in c) and any(x['url'].endswith('/api/mztjs') for x in c), c)
            gctx.close()
            # 10. 讀取自動重試（2026-10-09 央廚同仁開頁「連線失敗」）
            p = open_page(ctx, url(hq, extra='&retry_ms=50'), "window.__fake.liff_status = ['abort', {ok:false, error:'server_error'}, 'real']")
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=15000)
            ok('讀取：斷線、server_error 各一次後第 3 次成功', sum(1 for x in calls(p) if x['action'] == 'liff_status') == 3, calls(p))
            p.close()
            p = open_page(ctx, url(hq, extra='&retry_ms=50'), "window.__fake.liff_status = ['abort']")
            wait_msg(p, '連線失敗', timeout=15000)
            n_status = sum(1 for x in calls(p) if x['action'] == 'liff_status')
            ok('讀取：三次都失敗 → 才說連線失敗（共送 3 次）', n_status == 3, calls(p))
            p.close()
            p = open_page(ctx, url(hq, extra='&retry_ms=50'), "window.__fake.liff_status = [{ok:false, error:'not_bound'}, 'real']")
            wait_msg(p, '沒有認得你的 LINE 帳號', timeout=10000)   # U1 在光復眼中綁著總部 → 兩邊對不上
            c = calls(p)
            ok('讀取：店家明確回沒綁定 → 不重試，直接轉光復', sum(1 for x in c if x['action'] == 'liff_status') == 1 and any(x['action'] == 'line_hub_status' for x in c), c)
            p.close()

            # 11. 打卡結果不明時回頭確認（絕不重送打卡）
            mid_hq = (HQ['lat'], HQ['lng'])
            gctx2 = br.new_context()
            p = gctx2.new_page(); p.add_init_script(LOG_JS)
            p.goto(url(mid_hq, uid='U2', extra='&retry_ms=50'))
            p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
            p.fill('#bindName', '測試二'); p.click('#btnBind')
            p.wait_for_function('document.getElementById("who").textContent === "測試二"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = 'lost'")
            p.click('#btnIn')
            wait_msg(p, '剛才那筆已經進去了', timeout=15000)
            ok('打卡：伺服器收到但回應弄丟 → 回頭確認說已經進去、只送 1 次打卡', sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 1 and p.is_disabled('#btnIn'), msg(p))
            p.close()
            p = gctx2.new_page(); p.add_init_script(LOG_JS)
            p.goto(url(mid_hq, uid='U2', extra='&retry_ms=50'))
            p.wait_for_function('document.getElementById("who").textContent === "測試二"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = 'abort'")
            force_out(p)
            wait_msg(p, '這次下班卡沒有送出', timeout=15000)
            ok('打卡：根本沒送到 → 回頭確認說沒有送出、請再按', sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 1, msg(p))
            p.evaluate("window.__fake.liff_punch = 'abort'; window.__fake.liff_status = ['abort']")
            force_out(p)
            wait_msg(p, '連線不穩，不確定這筆有沒有進去', timeout=15000)
            ok('打卡：連確認也失敗 → 說不確定、請看出勤紀錄', True)
            # Codex#14（2026-10-10）：23:59 送出、回頭確認時已跨午夜（今天的紀錄清空）→ 靠「最後一張卡變了」判定已進去
            p.evaluate("window.__fake.liff_punch = 'abort'; window.__fake.liff_status = ['midnight', 'real']")
            force_out(p)
            wait_msg(p, '剛才那筆已經進去了', timeout=15000)
            ok('打卡：確認時已跨午夜 → 看最後一張卡，說已經進去（不誤報沒有送出）', '00:00' in msg(p), msg(p))
            p.close(); gctx2.close()
            # 11b. Codex#4（2026-10-10）：手上那筆位置已過時（>30 秒）→ 按打卡先重新定位；抓不到不送、人已離店不送
            GEO_JS = """
window.__geo = { mode: 'store', calls: 0 };
Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
  watchPosition: function (ok) {
    window.__geo.calls++;
    var m = window.__geo.mode;
    if (m === 'none') return 1;   // 定位被關、什麼都不回
    var at = m === 'away' ? [24.70, 121.10] : [%s, %s];
    var ts = m === 'store' ? Date.now() - 27000 : Date.now();   // 開頁那筆：還在 30 秒內，幾秒後就過時
    setTimeout(function () { ok({ timestamp: ts, coords: { latitude: at[0], longitude: at[1], accuracy: 5 } }); }, 50);
    return 1;
  },
  clearWatch: function () {}, getCurrentPosition: function () {}
} });
""" % (HQ['lat'], HQ['lng'])
            for mode, expect, name in [('none', '抓不到目前位置', '定位被關 → 說抓不到、不送打卡'),
                                       ('away', '不在任何打卡地點範圍內', '已走出店外 → 重新定位後判定不在範圍、不送打卡')]:
                gctx3 = br.new_context()
                p = gctx3.new_page(); p.add_init_script(LOG_JS); p.add_init_script(GEO_JS)
                p.goto(BASE + '/clock-line.html?mock_uid=U1&api=/api&refix_ms=1500')
                p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
                p.wait_for_timeout(4000)   # 開頁那筆變成過時
                p.evaluate("m => { window.__geo.mode = m; }", mode)
                p.evaluate('() => { for (const id of ["btnIn", "btnOut"]) { const b = document.getElementById(id); if (!b.disabled) { b.click(); return; } } const b = document.getElementById("btnOut"); b.disabled = false; b.click(); }')
                wait_msg(p, expect, timeout=15000)
                ok('舊位置：' + name, sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 0 and p.evaluate('window.__geo.calls') >= 2, msg(p))
                p.close(); gctx3.close()
            # 對照：位置還新（30 秒內）→ 不重新定位、照常送出
            gctx3 = br.new_context()
            p = gctx3.new_page(); p.add_init_script(LOG_JS); p.add_init_script(GEO_JS.replace('Date.now() - 27000', 'Date.now()'))
            p.goto(BASE + '/clock-line.html?mock_uid=U1&api=/api&refix_ms=1500')
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = {ok: false, type: 'in', reason: '測試假回應', hint: ''}")
            p.evaluate('() => { const b = document.getElementById("btnIn").disabled ? document.getElementById("btnOut") : document.getElementById("btnIn"); b.disabled = false; b.click(); }')
            p.wait_for_function('window.__calls.some(c => c.action === "liff_punch")', timeout=10000)
            ok('舊位置對照：位置還新 → 不重新定位、直接送出', p.evaluate('window.__geo.calls') == 1)
            p.close(); gctx3.close()
            # 12. 打卡求助（2026-10-09）：失敗時「看排除步驟」→ 代送「打卡求助：類別」並關閉；成功時不出現
            p = open_page(ctx, url((24.70, 121.10), in_client=True))
            wait_msg(p, '不在任何打卡地點範圍內')
            ok('超出範圍 → 出現「看排除步驟」', p.is_visible('#btnHelp'))
            p.click('#btnHelp')
            p.wait_for_function('window.__closed === true', timeout=4000)
            ok('按下 → 代送「打卡求助：不在範圍」並關閉', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：不在範圍'}], p.evaluate('window.__sent'))
            p.close()
            p = open_page(ctx, url(hq, in_client=True, extra='&retry_ms=50'), "window.__fake.liff_status = ['abort']")
            wait_msg(p, '連線失敗', timeout=15000)
            p.click('#btnHelp')
            p.wait_for_function('window.__closed === true', timeout=4000)
            ok('連線失敗 → 求助類別「網路不穩」', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：網路不穩'}], p.evaluate('window.__sent'))
            p.close()
            p = open_page(ctx, url(hq, in_client=True))
            p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
            ok('正常狀態 → 沒有「看排除步驟」', not p.is_visible('#btnHelp'))
            p.evaluate("window.__fake.liff_punch = {ok:false, type:'out', status:'rejected_out_of_range', reason:'店家判定你不在範圍內', hint:'請開啟「精確位置」與 Wi‑Fi 後再按一次'}")
            force_out(p)
            wait_msg(p, '店家判定你不在範圍內')
            p.wait_for_timeout(300)
            p.click('#btnHelp')
            p.wait_for_function('window.__closed === true', timeout=4000)
            ok('店家判定超出範圍 → 求助類別「定位不準」', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡求助：定位不準'}], p.evaluate('window.__sent'))
            p.close()
            # 13. 下班超時提示加班（2026-10-09）：把測試一今天的上班卡改成 9.5 小時前 → 按下班（真的 mock）→
            #     提示「今天出勤 9.5 小時」＋「申請加班」，畫面不自動關；按下去開加班分頁、日期／時段預填；送出成功
            from datetime import datetime, timedelta, timezone
            tz = timezone(timedelta(hours=8))
            f = os.path.join(ROOT, 'mock', 'mock_data_hq.json')
            d = json.load(open(f, encoding='utf-8'))
            emp = next(r['emp_id'] for r in d['roster'] if r.get('line_user_id') == 'U1')
            d['events'] = [e for e in d['events'] if e['emp_id'] != emp]
            t_in = (datetime.now(tz) - timedelta(hours=9, minutes=30)).replace(second=0, microsecond=0)
            d['events'].append({'ts': t_in.isoformat(), 'emp_id': emp, 'type': 'in', 'status': 'ok', 'lat': HQ['lat'], 'lng': HQ['lng'],
                                'distance_m': 1, 'accuracy_m': 10, 'device_id': 'line:U1', 'device_match': True, 'within_range': True})
            d['requests'] = [r for r in d.get('requests', []) if r.get('emp_id') != emp]
            json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
            p = open_page(ctx, url(hq, in_client=True))
            p.set_viewport_size({'width': 375, 'height': 812})
            p.wait_for_function('!document.getElementById("btnOut").disabled', timeout=10000)
            p.click('#btnOut')
            wait_msg(p, '下班打卡成功')
            r = [x for x in calls(p) if x['action'] == 'liff_punch']
            ok('下班超時：只送 1 次 liff_punch', len(r) == 1, r)
            p.wait_for_selector('#btnOtReq:not([hidden])', timeout=5000)
            hint = p.inner_text('#otHint')
            import re
            end_hm = re.search(r'下班打卡成功 (\d\d:\d\d)', msg(p)).group(1)   # 伺服器記下的下班時間
            ok('下班超時：顯示「今天出勤 X 小時，超過 8 小時。要申請加班嗎？」', hint.startswith('今天出勤 9.5') and hint.endswith('超過 8 小時。要申請加班嗎？'), hint)
            p.wait_for_timeout(2000)
            ok('下班超時：代送「打卡」但畫面不自動關（要讓同仁按得到）', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡'}] and not p.evaluate('window.__closed === true'))
            p.screenshot(path=os.path.join(SHOTS, '加班提示_1.png'))
            p.click('#btnOtReq')
            p.wait_for_selector('#reqView .rq-tabs button.on', timeout=10000)
            hrs = float(re.search(r'今天出勤 ([\d.]+) 小時', hint).group(1))
            exp_start_min = int(((int(end_hm[:2]) * 60 + int(end_hm[3:])) - (hrs - 8) * 60) // 15 * 15) % 1440
            vals = p.evaluate("() => [...document.querySelectorAll('#reqView input')].map(i => i.value)")
            ok('申請加班 → 開「加班」分頁', p.inner_text('#reqView .rq-tabs button.on') == '加班', p.inner_text('#reqView .rq-tabs button.on'))
            ok('加班分頁預填：日期＝上班那天、時段＝滿 8 小時（取整 15 分）到下班', vals[0] == t_in.strftime('%Y-%m-%d')
               and vals[1] == '%02d:%02d' % (exp_start_min // 60, exp_start_min % 60) and vals[2] == end_hm, vals)
            p.fill('#reqView input[type=text]', 'e2e 外送訂單多')
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            ok('加班申請送出成功、跳到我的申請', '加班 ' in p.inner_text('#reqView') and '審核中' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
            # 14. 出差分頁（2026-10-09）：五個分頁在 375 寬放得下；地點、事由必填；送出後「我的申請」看得到
            tabs = p.evaluate("""() => [...document.querySelectorAll('#reqView .rq-tabs button')].map(b => ({ t: b.textContent,
                  fit: b.scrollWidth <= b.clientWidth + 1 }))""")
            ok('申請頁分頁：請假｜加班｜出差｜忘打卡｜我的申請，375 寬每個字都放得下', [x['t'] for x in tabs] == ['請假', '加班', '出差', '忘打卡', '我的申請'] and all(x['fit'] for x in tabs), tabs)
            ok('申請頁：375 寬沒有橫向捲動', p.evaluate('document.documentElement.scrollWidth <= 375'), p.evaluate('document.documentElement.scrollWidth'))
            p.click('#reqView .rq-tabs button[data-tab=trip]')
            p.click('#reqView button.primary')
            p.wait_for_selector('#reqView .rq-box.err', timeout=5000)
            ok('出差：沒填地點 → 擋下「請填出差地點」', '請填出差地點' in p.inner_text('#reqView .rq-box.err'))
            p.fill('#reqView .rq-place', '台中央廚')
            p.click('#reqView button.primary')
            p.wait_for_function('document.querySelector("#reqView .rq-box.err") && document.querySelector("#reqView .rq-box.err").textContent.indexOf("事由") >= 0', timeout=5000)
            ok('出差：沒填事由 → 擋下', True)
            p.click('#reqView .rq-chips .rq-chip:nth-child(2)')   # 只一段
            p.fill('#reqView input[type=time] >> nth=0', '13:00')
            p.fill('#reqView input[type=time] >> nth=1', '17:30')
            p.fill('#reqView .rq-place', '台中央廚')
            p.fill('#reqView .rq-why', '支援盤點')
            p.wait_for_timeout(200)
            ok('出差只一段：即時顯示共 4.5 小時', '共 4.5 小時' in p.inner_text('#reqView'), p.inner_text('#reqView')[:300])
            p.screenshot(path=os.path.join(SHOTS, '出差單_2.png'))
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            t = p.inner_text('#reqView')
            ok('出差送出：摘要「出差 13:00–17:30 4.5 小時（地點：台中央廚）」、我的申請列出', '出差 13:00–17:30 4.5 小時（地點：台中央廚）' in t and '出差 4.5 小時' in t, t[:300])
            sent = [x for x in calls(p) if x['action'] == 'req_submit']
            ok('出差：送到挑到的那家店（總部 /api/hq req_submit）', sent and sent[-1]['url'].endswith('/api/hq'), sent)
            # 15. 補休（2026-10-09）：正職的加班分頁多「加班費／換補休」（預設加班費）；選換補休送出 → 摘要標（換補休）、店家存 comp
            d3 = (datetime.now(tz) - timedelta(days=3)).strftime('%Y-%m-%d')
            p.click('#reqView .rq-tabs button[data-tab=ot]')
            p.wait_for_selector('#reqView input[name=rqComp]', timeout=5000)
            radios = p.evaluate("() => [...document.querySelectorAll('#reqView input[name=rqComp]')].map(r => [r.value, r.checked])")
            ok('補休：正職的加班分頁有「加班費／換補休」、預設加班費', radios == [['pay', True], ['comp', False]], radios)
            p.fill('#reqView input[type=date]', d3)
            p.fill('#reqView input[type=time] >> nth=0', '18:00')
            p.fill('#reqView input[type=time] >> nth=1', '20:30')
            p.fill('#reqView input[type=text]', '月底盤點')
            p.check('#reqView input[name=rqComp][value=comp]')
            ok('補休：選換補休 → 說明改成 1:1、6 個月到期', '6 個月內要休完' in p.inner_text('#reqView'), p.inner_text('#reqView')[:400])
            p.screenshot(path=os.path.join(SHOTS, '補休_加班選項.jpg'), type='jpeg', quality=80)
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            t = p.inner_text('#reqView')
            ok('補休：送出摘要與我的申請都標（換補休）', '加班 18:00–20:30（2.5 小時）（換補休）' in t and '加班 2.5 小時（換補休）' in t, t[:300])
            dd = json.load(open(f, encoding='utf-8'))
            last = [r for r in dd['requests'] if r['kind'] == 'ot'][-1]
            ok('補休：總部 requests 存 comp＝comp', last.get('comp') == 'comp' and last['date'] == d3, last)
            sent = [x for x in calls(p) if x['action'] == 'req_submit']
            # 請假分頁：有餘額才有「補休」、一直顯示剩幾小時與最早到期日；超過餘額擋下
            p.click('#reqView .rq-tabs button[data-tab=leave]')
            p.wait_for_selector('#reqView .rq-comp-bal', timeout=5000)
            exp = (datetime.now(tz) + timedelta(days=20))
            bal = p.inner_text('#reqView .rq-comp-bal')
            ok('補休：請假分頁顯示「補休：剩 6 小時・最早 M/D 到期」', bal == '補休：剩 6 小時・最早 %d/%d 到期' % (exp.month, exp.day), bal)
            chips = p.evaluate("() => [...document.querySelectorAll('#reqView .rq-chips')[0].querySelectorAll('.rq-chip')].map(c => c.textContent)")
            ok('補休：常用假別多一個「補休」', chips[-1] == '補休', chips)
            p.fill('#reqView input[type=date]', (datetime.now(tz) + timedelta(days=5)).strftime('%Y-%m-%d'))
            p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("補休")')
            p.wait_for_selector('#reqView .rq-chip.on:has-text("補休")', timeout=3000)
            p.click('#reqView button.primary')   # 預設整天 8 小時 > 餘額 6
            p.wait_for_selector('#reqView .rq-box.err', timeout=5000)
            ok('補休：超過餘額擋下（不送出）', '補休餘額只剩 6 小時，不夠請 8 小時' in p.inner_text('#reqView .rq-box.err')
               and len([x for x in calls(p) if x['action'] == 'req_submit']) == len(sent), p.inner_text('#reqView .rq-box.err'))
            p.fill('#reqView .rq-hours', '4')
            p.evaluate("document.querySelector('#reqView .rq-box.err').remove()")
            p.screenshot(path=os.path.join(SHOTS, '補休_請假.jpg'), type='jpeg', quality=80)
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            ok('補休：4 小時送出成功', '補休 整天 4 小時' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
            p.close()
            # 計時同仁（光復 mock_comp allowed＝false）：看不到換補休、沒有補休假別
            fg = os.path.join(ROOT, 'mock', 'mock_data.json')
            dg = json.load(open(fg, encoding='utf-8'))
            dg['mock_comp'] = {'allowed': False, 'balance_h': 0, 'earliest_expiry': ''}
            json.dump(dg, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
            p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=ot'))
            p.set_viewport_size({'width': 375, 'height': 812})
            p.wait_for_selector('#reqView .rq-tabs button.on', timeout=10000)
            ok('補休：計時同仁的加班分頁沒有「換補休」', p.locator('#reqView input[name=rqComp]').count() == 0)
            p.click('#reqView .rq-tabs button[data-tab=leave]')
            p.wait_for_selector('#reqView .rq-chip', timeout=5000)
            ok('補休：計時同仁沒有「補休」假別', p.locator('#reqView .rq-chip:has-text("補休")').count() == 0 and p.locator('#reqView .rq-comp-bal').count() == 0)
            p.close()
            phase_sched(ctx)
            rep = CM.report()
            ok('班表：可點元素零漏測（共 %d 個）' % rep['total'], not rep['missed'] and not rep['extra'], rep)
            br.close()
    finally:
        proc.kill()
    print(f'\n✅ LINE 打卡畫面（直打店家）全部通過 ({n}/{n})')


def phase_sched(ctx):
    """出勤班表（2026-10-10）：?view=sched 讀光復 line_hub_sched（mock/sched_mock.py），月曆、明細、切上月、摘要、各種狀態。"""
    fg = os.path.join(ROOT, 'mock', 'mock_data.json')
    d = json.load(open(fg, encoding='utf-8'))
    bind = {'測試一': 'U1', '測試二': 'U6', '測試三': 'U7', '測試四': 'U8'}
    for r in d['roster']:
        if r['name'] in bind:
            r['line_user_id'] = bind[r['name']]
        if r['name'] == '測試四':
            r['active'] = False   # 已離職＝綁過也看不到（審查 P2#10）
    d.pop('mock_sched', None)
    json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)

    def api(uid, ym=''):
        b = {'action': 'line_hub_sched', 'id_token': 'MOCK_ID_TOKEN_' + uid}
        if ym:
            b['ym'] = ym
        return json.loads(urllib.request.urlopen(urllib.request.Request(BASE + '/api', data=json.dumps(b).encode()), timeout=5).read())

    def page(uid):
        p = open_page(ctx, f'{BASE}/clock-line.html?mock_uid={uid}&api=/api&view=sched')
        p.set_viewport_size({'width': 375, 'height': 812})
        p.wait_for_selector('#schedView .sc-cal, #schedView .sc-box', timeout=10000)
        return p

    r = api('U1')
    p = page('U1')
    ok('班表：不定位、只打光復 line_hub_sched', [x['action'] for x in calls(p)] == ['line_hub_sched'] and calls(p)[0]['url'].endswith('/api'), calls(p))
    ok('班表：打卡卡片隱藏', p.locator('#punchCard').is_hidden())
    ok('班表：沒有呼叫定位', p.evaluate('window.__geo') == 0, p.evaluate('window.__geo'))
    ok('班表：月曆每一天都有格子', p.locator('#schedView .sc-day').count() == len(r['days']), p.locator('#schedView .sc-day').count())
    first_work = next(x for x in r['days'] if x['work'] and len(x['segs']) == 2)
    cell = p.inner_text(f'#schedView .sc-day[data-d="{first_work["d"]}"]').split()
    ok('班表：兩段班格子寫第一段上班～最後一段下班', cell == [str(first_work['d']), first_work['segs'][0][0], first_work['segs'][-1][1]], cell)
    off = next(x for x in r['days'] if x['code'] and not x['work'])
    ok('班表：休假格寫班別代碼', p.inner_text(f'#schedView .sc-day[data-d="{off["d"]}"]').split()[-1] == off['code'])
    td = int(r['today'][8:10])
    ok('班表：本月預設選今天、今天有外框', p.locator(f'#schedView .sc-day.sel.today[data-d="{td}"]').count() == 1)
    CM.scan(p, '班表月曆（本月）')
    for x in r['days']:   # 每一格都點，明細日期要對（審查 P2#2）
        p.click(f'#scD{x["d"]}')
        dt = p.inner_text('#scDet').split('\n')[0]
        if not dt.startswith('%d/%d（' % (int(r['ym'][5:7]), x['d'])):
            raise AssertionError('點 %d 號明細日期不對：%s' % (x['d'], dt))
        CM.mark(p.evaluate(KEY_JS, f'#scD{x["d"]}'), '明細日期正確')
    ok('班表：每一天都點過、明細日期都對', True)
    p.click(f'#scD{first_work["d"]}')
    det = p.inner_text('#scDet')
    ok('班表：點兩段班看第一段、第二段、合計', '第一段' in det and '第二段' in det and ('合計\n%s 小時' % (int(first_work['hours']) if first_work['hours'] == int(first_work['hours']) else first_work['hours'])) in det, det)
    blank = next((x for x in r['days'] if not x['code']), None)
    if blank:
        p.click(f'#schedView .sc-day[data-d="{blank["d"]}"]')
        ok('班表：空白天寫「這天沒有排班」', '這天沒有排班' in p.inner_text('#scDet'))
    p.click(f'#schedView .sc-day[data-d="{off["d"]}"]')
    ok('班表：休假天明細寫班別名稱', off['label'] in p.inner_text('#scDet'))
    ok('班表：本月時「›」不能按', p.locator('#scNext').is_disabled())
    no_undefined(p, '班表月曆')
    ok('班表：375px 沒有橫向捲動', p.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
    p.screenshot(path=os.path.join(SHOTS, '班表_月曆.jpg'), type='jpeg', quality=80)
    # 摘要
    CM.mark(p.evaluate(KEY_JS, '#scNext'), '本月時停用（已驗）')
    p.click('#schedView .rq-tabs button[data-tab=sum]')
    CM.mark(p.evaluate(KEY_JS, '#schedView .rq-tabs button[data-tab=sum]'), '切到摘要')
    CM.scan(p, '班表摘要')
    nums = p.locator('#schedView .sc-sum b').all_inner_texts()
    sm = r['summary']
    ok('班表：摘要三個數字＝後端', nums == [str(sm['work_days']), str(sm['off_days']), ('%g' % sm['hours'])], (nums, sm))
    nx = p.inner_text('#scNextShift')
    want = '本月沒有接下來的班' if not r['next'] else '%d/%d' % (int(r['next']['date'][5:7]), int(r['next']['date'][8:10]))
    ok('班表：下一個班', want in nx, nx)
    p.screenshot(path=os.path.join(SHOTS, '班表_摘要.jpg'), type='jpeg', quality=80)
    # 切上個月
    p.click('#schedView .rq-tabs button[data-tab=cal]')
    CM.mark(p.evaluate(KEY_JS, '#schedView .rq-tabs button[data-tab=cal]'), '切回月曆')
    n_calls = len(calls(p))
    CM.mark(p.evaluate(KEY_JS, '#scPrev'), '切上個月帶 ym')
    p.click('#scPrev')
    p.wait_for_function('document.querySelector("#schedView .sc-mon b") && document.querySelector("#schedView .sc-mon b").textContent.indexOf(" %d 月") >= 0' % int(r['months'][0][5:7]), timeout=8000)
    c = calls(p)
    ok('班表：切上個月帶 ym', c[n_calls]['action'] == 'line_hub_sched' and len(c) == n_calls + 1, c[n_calls:])
    ok('班表：上個月不預選日期、「‹」不能按', p.locator('#schedView .sc-day.sel').count() == 0 and p.locator('#scPrev').is_disabled())
    CM.scan(p, '班表月曆（上個月）')
    for k in p.evaluate("() => [...document.querySelectorAll('#schedView .sc-day')].map(e => e.id)"):
        p.click('#' + k)
        CM.mark(p.evaluate(KEY_JS, '#' + k), '上個月明細')
    p.click('#scNext')
    ok('班表：切回本月不再打後端（用已讀的）', len(calls(p)) == n_calls + 1)
    p.close()
    # 各種看不到的狀態
    p = page('U6'); p.click('#scPrev')
    p.wait_for_selector('#schedView .sc-box.info', timeout=8000)
    ok('班表：上個月沒有他的班 → no_schedule 字句', '的班表沒有你的班' in p.inner_text('#schedView'))
    p.close()
    p = page('U7')
    ok('班表：同名兩位 → not_matched 字句', '你的班表還沒對上，請找店長確認' in p.inner_text('#schedView'))
    p.close()
    p = page('U8')
    ok('班表：已離職（綁過光復）→ not_bound 字句', '你目前沒有光復店的班表' in p.inner_text('#schedView'))
    p.close()
    d = json.load(open(fg, encoding='utf-8'))
    cy, cm = int(r['months'][1][:4]), int(r['months'][1][5:7])
    d['mock_sched'] = {'unlock': ['%d_%d' % (cy, cm)]}
    json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    p = page('U1')
    ok('班表：沒鎖定 → 還在排、不畫月曆', '的班表還在排' in p.inner_text('#schedView') and p.locator('#schedView .sc-cal').count() == 0)
    p.click('#schedView .rq-tabs button[data-tab=sum]')
    ok('班表：沒鎖定時摘要頁也只顯示提示', p.locator('#schedView .sc-sum').count() == 0 and '還在排' in p.inner_text('#schedView'))
    p.close()
    d['mock_sched'] = {'fail': True}
    json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    p = page('U1')
    ok('班表：Gist 讀不到 → 錯誤字句＋重新整理、不畫空月曆', '班表暫時讀不到' in p.inner_text('#schedView')
       and p.locator('#scReload').count() == 1 and p.locator('#schedView .sc-cal').count() == 0)
    d.pop('mock_sched'); json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    CM.scan(p, '班表讀取失敗')
    CM.mark(p.evaluate(KEY_JS, '#scReload'), '重讀成功')
    p.click('#scReload')
    p.wait_for_selector('#schedView .sc-cal', timeout=8000)
    ok('班表：按重新整理後讀得到', p.locator('#schedView .sc-day').count() > 27)
    # 上個月讀失敗 → 重新整理要重讀上個月，不是本月（審查 P2#1）
    p.evaluate("window.__fake = { line_hub_sched: [{ ok: false, error: 'sched_unreadable' }, 'real'] }")
    p.click('#scPrev')
    p.wait_for_selector('#scReload', timeout=8000)
    p.click('#scReload')
    p.wait_for_selector('#schedView .sc-cal', timeout=8000)
    c = [x for x in calls(p) if x['action'] == 'line_hub_sched']
    ok('班表：上個月讀失敗後重新整理仍是上個月', ' %d 月' % int(r['months'][0][5:7]) in p.inner_text('#schedView .sc-mon b'), p.inner_text('#schedView .sc-mon b'))
    p.close()
    p = open_page(ctx, f'{BASE}/clock-line.html?mock_uid=U1&api=/api&view=sched', pre="window.__fake = { line_hub_sched: 'abort' };")
    p.wait_for_selector('#schedView .sc-box.err', timeout=40000)
    ok('班表：斷線重試三次後顯示連線不穩', '連線不穩' in p.inner_text('#schedView') and len([x for x in calls(p) if x['action'] == 'line_hub_sched']) == 3, calls(p))
    p.close()


if __name__ == '__main__':
    main()
