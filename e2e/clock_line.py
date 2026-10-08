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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('E2E_MOCK_PORT', '8947'))
BASE = f'http://localhost:{PORT}'
STORES = {s['code']: s for s in json.load(open(os.path.join(ROOT, 'tools', 'stores.json'), encoding='utf-8'))}
HQ, JS = STORES['hq'], STORES['mztjs']

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
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'mock', 'mock_server.py')], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            p.close(); gctx2.close()
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
            br.close()
    finally:
        proc.kill()
    print(f'\n✅ LINE 打卡畫面（直打店家）全部通過 ({n}/{n})')


if __name__ == '__main__':
    main()
