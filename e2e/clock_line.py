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
// 既有測試＝手機沒記過上次那家店（第一次用的手機）；要測「趁定位先讀上次那家店」的頁面網址帶 keep_store=1（2026-11-16）
try { if (location.search.indexOf('keep_store=1') < 0) localStorage.removeItem('mala_clock_last_store_v1'); } catch (e) {}
window.__beacons = [];   // 打卡等待秒數（2026-10-12）：記下送出當下畫面上已經寫什麼，證明是「顯示結果之後」才送
if (navigator.sendBeacon) { const _b = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (u, d) { const m = document.getElementById('msg');
    // kind：這一筆是開頁秒數（頁面先把內容記進 window.__open 才送）還是打卡秒數（2026-11-16 多了開頁那一筆）
    const no = (window.__open || []).length, kind = no > (window.__beaconOpens || 0) ? 'open' : 'punch'; window.__beaconOpens = no;
    window.__beacons.push({ url: String(u), msg: m ? m.textContent : '', kind: kind }); return _b(u, d); }; }
window.__fake = {};   // action → 假回應（物件）或 'abort'
const _f = window.fetch;
window.fetch = function (url, o) {
  let a = '', ty = ''; try { const j = JSON.parse(o.body); a = j.action; ty = j.type || ''; } catch (e) {}
  window.__calls.push({ url: String(url), action: a, type: ty, t: Date.now() });
  const dl = (window.__delay || {})[a];   // 某支動作延遲幾毫秒才送（2026-11-06 開頁加快：模擬光復慢）
  if (dl) { const self = this, args = arguments; window.__delay[a] = 0;
    return new Promise(function (r) { setTimeout(r, dl); }).then(function () { return window.fetch.apply(self, args); }); }
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
    try:
        p.wait_for_function('(s) => (document.getElementById("msg").textContent + document.getElementById("hint").textContent).indexOf(s) >= 0',
                            arg=needle, timeout=timeout)
    except Exception:
        print('wait_msg 逾時：等「%s」，畫面實際是 %r' % (needle, msg(p)))   # 失敗時直接看到畫面上是什麼
        raise


def no_undefined(p, where):
    t = p.inner_text('body')
    ok(where + '：畫面沒有 undefined／null 字樣', 'undefined' not in t and 'null' not in t, t[:200])


def force_out(p):
    """模擬「畫面沒擋到」：鍵被畫面停用（10 分鐘鎖）時，同一個 tick 內解開並點下去，測後端擋下時畫面怎麼顯示。"""
    p.evaluate('() => { window.confirm = () => true; const sub = () => { const m = document.getElementById("pgMask"); if (m && !m.hidden) document.getElementById("pgSub").click(); }; const b = document.getElementById("btnOut"); b.disabled = false; b.click(); sub(); }')


def calls(p):
    return p.evaluate('window.__calls')


def pick_date(p, ymd, nth=0):
    """申請頁日期欄是「月」「日」兩個下拉（2026-10-31，取代 input[type=date]）"""
    box = p.locator('#reqView .rq-dpick').nth(nth)
    box.locator('select.rq-dm').select_option(ymd[:7])
    box.locator('select.rq-dd').select_option(ymd)


def pick_time(p, nth, hm):
    """申請頁時間欄是「時」「分」兩個下拉（2026-10-29，取代 input[type=time]，LINE Android 叫轉盤會閃退）"""
    box = p.locator('#reqView .rq-time').nth(nth)
    box.locator('select.rq-hh').select_option(hm[:2])
    box.locator('select.rq-mm').select_option(hm[3:])


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
            tmg = p.evaluate('window.__timing') or []
            ok('等待秒數：成功打卡記 1 筆（ok、總部、上班、有總秒數與等後端秒數）',
               len(tmg) == 1 and tmg[0]['outcome'] == 'ok' and tmg[0]['store'] == 'hq' and tmg[0]['type'] == 'in'
               and tmg[0]['total_ms'] > 0 and tmg[0]['server_ms'] is not None and tmg[0]['total_ms'] >= tmg[0]['server_ms'] and tmg[0]['refix'] is False, tmg)
            bc = p.evaluate("window.__beacons.filter(b => b.kind === 'punch')")   # 開頁秒數那一筆另外算（2026-11-16）
            ok('等待秒數：開頁秒數也送了一筆（按鍵亮起之後）', p.evaluate("window.__beacons.filter(b => b.kind === 'open').length") == 1, p.evaluate('window.__beacons'))
            ok('等待秒數：背景送出時畫面已經顯示「打卡成功」（同仁不用多等）', len(bc) == 1 and '上班打卡成功' in bc[0]['msg'] and bc[0]['url'].endswith('/api'), bc)
            ok('等待秒數：不走一般請求、不會被算成多打一次後端', not any(x['action'] == 'line_punch_timing' for x in calls(p)), calls(p))
            for _ in range(40):   # sendBeacon 是背景送，等 mock 寫進光復資料檔
                rows = json.load(open(os.path.join(ROOT, 'mock', 'mock_data.json'), encoding='utf-8')).get('punch_timing', [])
                if rows: break
                time.sleep(0.1)
            ok('等待秒數：光復收到並記下（總部的卡、記在光復）', len(rows) == 1 and rows[0]['store'] == 'hq' and rows[0]['outcome'] == 'ok' and isinstance(rows[0]['total_ms'], int), rows)
            ok('等待秒數：後端各步驟毫秒數跟著送、光復記下', tmg[0].get('steps', {}).get('write') == 900 and rows[0]['steps'] == {'verify': 120, 'roster': 300, 'read': 250, 'write': 900, 'extra': 400}, (tmg[0].get('steps'), rows[0].get('steps')))
            hq_rows = json.load(open(os.path.join(ROOT, 'mock', 'mock_data_hq.json'), encoding='utf-8')).get('punch_timing')
            ok('等待秒數：不寫進總部自己的打卡資料', hq_rows is None, hq_rows)
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
            p.evaluate('() => { window.confirm = () => true; const sub = () => { const m = document.getElementById("pgMask"); if (m && !m.hidden) document.getElementById("pgSub").click(); }; const b = document.getElementById("btnOut"); b.disabled = false; b.click(); sub(); }')
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
            tmg = p.evaluate('window.__timing') or []
            ok('等待秒數：回應弄丟、回頭確認已進去 → 記 unclear_ok，總秒數含確認時間', len(tmg) == 1 and tmg[0]['outcome'] == 'unclear_ok' and tmg[0]['total_ms'] > tmg[0]['server_ms'], tmg)
            p.close()
            p = gctx2.new_page(); p.add_init_script(LOG_JS)
            p.goto(url(mid_hq, uid='U2', extra='&retry_ms=50'))
            p.wait_for_function('document.getElementById("who").textContent === "測試二"', timeout=10000)
            p.evaluate("window.__fake.liff_punch = 'abort'")
            force_out(p)
            wait_msg(p, '這次下班卡沒有送出', timeout=15000)
            ok('打卡：根本沒送到 → 回頭確認說沒有送出、請再按', sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 1, msg(p))
            ok('等待秒數：沒送到 → 記 unclear_not', (p.evaluate('window.__timing') or [{}])[-1].get('outcome') == 'unclear_not', p.evaluate('window.__timing'))
            p.evaluate("window.__fake.liff_punch = 'abort'; window.__fake.liff_status = ['abort']")
            force_out(p)
            wait_msg(p, '連線不穩，不確定這筆有沒有進去', timeout=15000)
            ok('打卡：連確認也失敗 → 說不確定、請看出勤紀錄', True)
            ok('等待秒數：連確認也失敗 → 記 unclear_unknown、每次按只記 1 筆', [x['outcome'] for x in p.evaluate('window.__timing')] == ['unclear_not', 'unclear_unknown'], p.evaluate('window.__timing'))
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
                p.evaluate('() => { window.confirm = () => true; const sub = () => { const m = document.getElementById("pgMask"); if (m && !m.hidden) document.getElementById("pgSub").click(); }; for (const id of ["btnIn", "btnOut"]) { const b = document.getElementById(id); if (!b.disabled) { b.click(); sub(); return; } } const b = document.getElementById("btnOut"); b.disabled = false; b.click(); sub(); }')
                wait_msg(p, expect, timeout=15000)
                ok('舊位置：' + name, sum(1 for x in calls(p) if x['action'] == 'liff_punch') == 0 and p.evaluate('window.__geo.calls') >= 2, msg(p))
                tmg = p.evaluate('window.__timing') or []
                if mode == 'none':
                    ok('等待秒數：定位抓不到 → 記 geo_fail、有重新定位、定位秒數約等於上限', len(tmg) == 1 and tmg[0]['outcome'] == 'geo_fail' and tmg[0]['refix'] is True and tmg[0]['geo_ms'] >= 1400 and tmg[0]['server_ms'] is None, tmg)
                else:
                    ok('等待秒數：人已離店、沒有送出 → 不記', tmg == [], tmg)
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
            # 2026-11-11 起（核定加嚴生效，B16）提示改用參考時數的算法：上班進位、下班捨去到 15 分鐘，所以 9.5 小時前上班可能算成 9.25 或 9.5
            _eh, _em = int(end_hm[:2]), int(end_hm[3:])
            if t_in.strftime('%Y-%m-%d') >= '2026-11-11':
                _a = -(-(t_in.hour * 60 + t_in.minute) // 15) * 15
                _b = ((_eh * 60 + _em) // 15) * 15 + (1440 if (_eh * 60 + _em) < t_in.hour * 60 + t_in.minute else 0)
                exp_h = '%g' % ((_b - _a) / 60)
            else:
                exp_h = '9.5'
            ok('下班超時：顯示「今天出勤 X 小時，超過 8 小時。要申請加班嗎？」', hint.startswith('今天出勤 ' + exp_h + ' ') and hint.endswith('超過 8 小時。要申請加班嗎？'), (hint, exp_h))
            p.wait_for_timeout(2000)
            ok('下班超時：代送「打卡」但畫面不自動關（要讓同仁按得到）', p.evaluate('window.__sent') == [{'type': 'text', 'text': '打卡'}] and not p.evaluate('window.__closed === true'))
            p.screenshot(path=os.path.join(SHOTS, '加班提示_1.png'))
            p.click('#btnOtReq')
            p.wait_for_selector('#reqView .rq-tabs button.on', timeout=10000)
            hrs = float(re.search(r'今天出勤 ([\d.]+) 小時', hint).group(1))
            # 2026-11-11 起（B16）預填的下班時間也捨去到 15 分鐘
            exp_end = end_hm if t_in.strftime('%Y-%m-%d') < '2026-11-11' else '%02d:%02d' % divmod((int(end_hm[:2]) * 60 + int(end_hm[3:])) // 15 * 15, 60)
            exp_start_min = int(((int(exp_end[:2]) * 60 + int(exp_end[3:])) - (hrs - 8) * 60) // 15 * 15) % 1440
            vals = p.evaluate("() => [...document.querySelectorAll('#reqView .rq-dpick, #reqView .rq-time')].map(i => i.classList.contains('rq-dpick') ? i.querySelector('select.rq-dd').value : [...i.querySelectorAll('select')].map(s => s.value).join(':'))")   # 時間欄是「時」「分」下拉，下班卡不在 15 分格上也要原樣帶入
            ok('申請加班 → 開「加班」分頁', p.inner_text('#reqView .rq-tabs button.on') == '加班', p.inner_text('#reqView .rq-tabs button.on'))
            ok('加班分頁預填：日期＝上班那天、時段＝滿 8 小時（取整 15 分）到下班', vals[0] == t_in.strftime('%Y-%m-%d')
               and vals[1] == '%02d:%02d' % (exp_start_min // 60, exp_start_min % 60) and vals[2] == exp_end, [vals, exp_end, exp_start_min, hint])
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
            ok('出差：沒選地點 → 擋下「請選出差地點」', '請選出差地點' in p.inner_text('#reqView .rq-box.err'))
            ok('出差地點下拉：六個地點＋其他', p.evaluate("[...document.querySelectorAll('#reqView .rq-place-pick option')].map(o => o.value).join(',')")
               == ',總部辦公室,新竹光復,新竹金山,台北六張犁,台北瑞光,台中美村,其他')
            ok('出差地點：沒選其他時不顯示輸入框', p.locator('#reqView .rq-place').count() == 0)
            p.select_option('#reqView .rq-place-pick', '其他')
            p.wait_for_selector('#reqView .rq-place', timeout=3000)
            p.fill('#reqView .rq-place', '台中央廚')
            p.click('#reqView button.primary')
            p.wait_for_function('document.querySelector("#reqView .rq-box.err") && document.querySelector("#reqView .rq-box.err").textContent.indexOf("事由") >= 0', timeout=5000)
            ok('出差：沒填事由 → 擋下', True)
            p.click('#reqView .rq-chips .rq-chip:nth-child(2)')   # 只一段
            ok('出差只一段：時間欄是下拉選單、整頁沒有 input[type=time]（LINE Android 會閃退）', p.locator('#reqView input[type=time]').count() == 0 and p.locator('#reqView .rq-time').count() == 2)
            pick_time(p, 0, '13:00')
            pick_time(p, 1, '17:30')
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
            # 15. 補休（2026-11-01 改每月加減結算）：加班分頁不再分加班費／換補休，改一行說明＋本月補休帳；
            #     請假分頁正職就有「補休」、顯示本月帳（欠的紅字），不看餘額照常送出
            d3 = (datetime.now(tz) - timedelta(days=3)).strftime('%Y-%m-%d')
            mon = datetime.now(tz).month
            p.click('#reqView .rq-tabs button[data-tab=ot]')
            p.wait_for_selector('#reqView input[type=text]', timeout=5000)
            ok('補休：加班分頁沒有「加班費／換補休」選項', p.locator('#reqView input[name=rqComp]').count() == 0)
            tv = p.inner_text('#reqView')
            ok('補休：加班分頁說明「核准後先抵當月請的補休」＋本月補休帳', '核准後先抵當月請的補休，剩下的照加班費發。' in tv and ('%d 月加班 2 − 補休 4 ＝ 欠 2 小時' % mon) in tv, tv[:400])
            pick_date(p, d3)
            pick_time(p, 0, '18:00')
            pick_time(p, 1, '20:30')
            p.fill('#reqView input[type=text]', '月底盤點')
            # 加班單要有打卡佐證（2026-11-14）：3 天前沒打卡 → 黃字提醒，照樣送得出去
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("沒有完整的打卡紀錄") >= 0', timeout=8000)
            ok('加班沒打卡：黃字提醒「18:00–20:30 這段時間在「店」沒有完整的打卡紀錄，主管會核不過」', '18:00–20:30 這段時間在' in p.inner_text('#reqView') and '主管會核不過' in p.inner_text('#reqView'))
            p.screenshot(path=os.path.join(SHOTS, '補休_加班.jpg'), type='jpeg', quality=80)
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            t = p.inner_text('#reqView')
            ok('補休：加班送出摘要沒有「（換補休）」', '加班 18:00–20:30（2.5 小時）' in t and '換補休' not in t, t[:300])
            dd = json.load(open(f, encoding='utf-8'))
            last = [r for r in dd['requests'] if r['kind'] == 'ot'][-1]
            ok('補休：總部 requests 的 comp 欄留空', not last.get('comp') and last['date'] == d3, last)
            p.click('#reqView .rq-tabs button[data-tab=leave]')
            p.wait_for_selector('#reqView .rq-comp-bal', timeout=5000)
            bal = p.inner_text('#reqView .rq-comp-bal')
            ok('補休：請假分頁顯示本月補休帳「補休：M 月加班 2 − 補休 4 ＝ 欠 2 小時」、欠的紅字',
               bal == '補休：%d 月加班 2 − 補休 4 ＝ 欠 2 小時' % mon and p.locator('#reqView .rq-comp-bal.rq-comp-neg').count() == 1, bal)
            chips = p.evaluate("() => [...document.querySelectorAll('#reqView .rq-chips')[0].querySelectorAll('.rq-chip')].map(c => c.textContent)")
            ok('補休：常用假別多一個「補休」（欠的也有）', chips[-1] == '補休', chips)
            pick_date(p, (datetime.now(tz) + timedelta(days=5)).strftime('%Y-%m-%d'))
            p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("補休")')
            p.wait_for_selector('#reqView .rq-chip.on:has-text("補休")', timeout=3000)
            ok('補休：選了補休多一行「可以先休、之後再用加班補回來」', '可以先休、之後再用加班補回來' in p.inner_text('#reqView'))
            p.screenshot(path=os.path.join(SHOTS, '補休_請假.jpg'), type='jpeg', quality=80)
            p.click('#reqView button.primary')   # 預設整天 8 小時，本月已經欠 2 也照常送出
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            ok('補休：先休後補——欠的時候請 8 小時也送得出去', '補休 整天 8 小時' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
            p.close()
            # 計時同仁（光復 mock_comp known＝true、allowed＝false）：假別照樣列「補休」（2026-11-04），但選了會說只有正職、送出擋下；加班分頁沒有補休說明
            fg = os.path.join(ROOT, 'mock', 'mock_data.json')
            dg = json.load(open(fg, encoding='utf-8'))
            dg['mock_comp'] = {'allowed': False, 'known': True, 'ot_h': 0, 'used_h': 0, 'balance_h': 0}
            json.dump(dg, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
            p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=ot'))
            p.set_viewport_size({'width': 375, 'height': 812})
            p.wait_for_selector('#reqView .rq-tabs button.on', timeout=10000)
            ok('補休：計時同仁的加班分頁沒有補休說明', '先抵當月請的補休' not in p.inner_text('#reqView'))
            p.click('#reqView .rq-tabs button[data-tab=leave]')
            p.wait_for_selector('#reqView .rq-chip', timeout=5000)
            ok('補休：計時同仁也看得到「補休」假別、沒有本月補休帳', p.locator('#reqView .rq-chip:has-text("補休")').count() == 1 and p.locator('#reqView .rq-comp-bal').count() == 0)
            p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("補休")')
            p.wait_for_selector('#reqView .rq-chip.on:has-text("補休")', timeout=3000)
            ok('補休：計時同仁選了補休 → 說明「補休只有正職可以請」', '補休只有正職可以請。' in p.inner_text('#reqView'))
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("補休只有正職可以請") >= 0 && document.getElementById("reqView").textContent.indexOf("✓ 已送出") < 0', timeout=5000)
            ok('補休：計時同仁送出被擋（沒有送出）', '✓ 已送出' not in p.inner_text('#reqView'))
            p.close()
            # 薪資主檔還沒建的同仁（known＝false）：看得到補休、選了提示補休帳要等資料建好，照樣送得出去
            dg = json.load(open(fg, encoding='utf-8'))
            dg['mock_comp'] = {'allowed': False, 'known': False, 'ot_h': 0, 'used_h': 0, 'balance_h': 0}
            json.dump(dg, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
            p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=leave'))
            p.set_viewport_size({'width': 375, 'height': 812})
            p.wait_for_selector('#reqView .rq-chip', timeout=10000)
            pick_date(p, (datetime.now(tz) + timedelta(days=6)).strftime('%Y-%m-%d'))   # 別跟後面病假（今天）、前面補休（+5 天）撞同一天
            p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("補休")')
            p.wait_for_selector('#reqView .rq-chip.on:has-text("補休")', timeout=3000)
            ok('補休：主檔還沒建 → 看得到補休、提示「本月補休帳要等薪資資料建好才看得到」', '本月補休帳要等薪資資料建好才看得到' in p.inner_text('#reqView') and p.locator('#reqView .rq-comp-bal').count() == 0)
            p.click('#reqView button.primary')
            p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
            ok('補休：主檔還沒建也送得出去', '補休 整天 8 小時' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
            p.screenshot(path=os.path.join(SHOTS, '補休_主檔未建.jpg'), type='jpeg', quality=80)
            p.close()
            phase_req_fast(ctx, (HQ['lat'], HQ['lng']))
            phase_req_mini(ctx, (HQ['lat'], HQ['lng']))
            phase_sched(ctx)
            phase_leave_proof(ctx, (HQ['lat'], HQ['lng']))
            phase_miss_store(ctx)
            phase_miss_break(ctx)
            phase_relay(ctx, (HQ['lat'], HQ['lng']))
            phase_g(ctx, (HQ['lat'], HQ['lng']))
            phase_open(ctx, (HQ['lat'], HQ['lng']))
            phase_coarse(ctx)
            phase_relogin(ctx, (HQ['lat'], HQ['lng']))
            phase_rest(ctx, (HQ['lat'], HQ['lng']))
            phase_same_type(ctx, (HQ['lat'], HQ['lng']))
            rep = CM.report()
            ok('班表：可點元素零漏測（共 %d 個）' % rep['total'], not rep['missed'] and not rep['extra'], rep)
            br.close()
    finally:
        proc.kill()
    print(f'\n✅ LINE 打卡畫面（直打店家）全部通過 ({n}/{n})')


def phase_req_fast(ctx, hq):
    """申請頁開頁加快（2026-11-06 Eason：開申請頁要等 10 秒以上）：手機記住上次的店別與假別、三支同時問、額度晚點補上。"""
    c2 = ctx.browser.new_context()   # 乾淨的 localStorage
    fg = os.path.join(ROOT, 'mock', 'mock_data.json')
    def set_hub(**kw):
        dg = json.load(open(fg, encoding='utf-8'))
        for k, v in kw.items():
            if v is None: dg.pop(k, None)
            else: dg[k] = v
        json.dump(dg, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    set_hub(mock_comp=None, mock_old_hub=None)
    u = url(hq, in_client=True, extra='&view=req&tab=leave')
    slow = "window.__delay = {line_hub_req_init: %d, line_hub_req_quota: %d};"
    # 1. 第一次打開（手機沒記）：要等光復回來才有表單
    p = open_page(c2, u, slow % (2500, 0))
    p.wait_for_timeout(1200)
    ok('開頁加快：第一次打開（手機沒記）→ 等光復時顯示「讀取中」、還沒有表單',
       p.locator('#reqView .rq-tabs').count() == 0 and '讀取中' in p.inner_text('#reqView'), p.inner_text('#reqView')[:60])
    p.wait_for_selector('#reqView .rq-tabs', timeout=15000)
    cl = p.evaluate("window.__calls.filter(c => /line_hub_req|req_info/.test(c.action)).map(c => c.action)")
    ok('開頁加快：光復開頁資料、額度、那家店三支都有問', 'line_hub_req_init' in cl and 'line_hub_req_quota' in cl and 'req_info' in cl, cl)
    saved = p.evaluate("JSON.parse(localStorage.getItem('mala_req_init_v1') || 'null')")
    ok('開頁加快：記住的只有店別、上次的店、假別（沒有額度、補休帳）',
       saved and saved['sub'] == 'U1' and saved['stores'] and saved['leave_types'] and 'quota' not in saved and 'comp' not in saved,
       sorted(saved.keys()) if saved else saved)
    p.close()
    # 2. 第二次打開：光復慢 4 秒也馬上有表單；額度晚 2.5 秒補上
    p = open_page(c2, u, slow % (4000, 2500))
    p.wait_for_selector('#reqView .rq-tabs', timeout=1500)
    t0 = p.evaluate("Date.now()")
    ok('開頁加快：第二次打開 → 光復還沒回就有表單（店名、假別都在）',
       p.locator('#reqView .rq-chip').count() > 0 and p.inner_text('#reqView .rq-head').strip() != '', p.inner_text('#reqView')[:80])
    p.click('#reqView .rq-chip:has-text("特休假")')
    p.wait_for_selector('#reqView .rq-chip.on:has-text("特休假")', timeout=3000)
    ok('開頁加快：額度還沒回 → 不顯示舊數字', p.locator('#reqView .rq-quota').count() == 0, p.inner_text('#reqView')[:200])
    p.wait_for_selector('#reqView .rq-quota', timeout=10000)
    ok('開頁加快：額度晚一點補上「特休假：剩 40 小時（上限 56）」', '特休假：剩 40 小時（上限 56）' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
    p.click('#reqView .rq-tabs button[data-tab=mine]')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('最近 60 天') >= 0", timeout=10000)
    ok('開頁加快：「我的申請」照樣讀得到', '最近 60 天' in p.inner_text('#reqView'))
    lite = p.evaluate("window.__calls.filter(c => c.action === 'line_hub_req_init').length")
    ok('開頁加快：光復開頁資料只問一次', lite == 1, lite)
    p.close()
    # 3. 正在打字時新資料到了 → 不重畫（打的字、焦點都留著）
    p = open_page(c2, url(hq, in_client=True, extra='&view=req&tab=ot'), slow % (2500, 0))
    p.wait_for_selector('#reqView input[type=text]', timeout=1500)
    p.click('#reqView input[type=text]'); p.keyboard.type('外送很多')
    p.wait_for_timeout(3500)
    ok('開頁加快：打字時光復資料到了 → 打的字還在、游標還在那格',
       p.evaluate("document.activeElement && document.activeElement.tagName") == 'INPUT'
       and p.evaluate("document.querySelector('#reqView input[type=text]').value") == '外送很多')
    p.click('#reqView .rq-tabs button[data-tab=leave]')
    p.click('#reqView .rq-tabs button[data-tab=ot]')
    ok('開頁加快：離開那格後換到最新資料、打的字照樣留著', p.evaluate("document.querySelector('#reqView input[type=text]').value") == '外送很多')
    p.close()
    # 4. 換一個 LINE 帳號用同一支手機 → 不用前一個人記住的
    p = c2.new_page(); p.goto(BASE + '/clock-line.html')
    p.evaluate("""() => { const c = JSON.parse(localStorage.getItem('mala_req_init_v1')); c.sub = 'U_別人'; localStorage.setItem('mala_req_init_v1', JSON.stringify(c)); }""")
    p.close()
    p = open_page(c2, u, slow % (2500, 0))
    p.wait_for_timeout(1200)
    ok('開頁加快：記住的是別的 LINE 帳號 → 不拿來用（等光復）', p.locator('#reqView .rq-tabs').count() == 0, p.inner_text('#reqView')[:60])
    p.wait_for_selector('#reqView .rq-tabs', timeout=15000)
    p.close()
    # 5. 超過 30 天沒開 → 當沒記
    p = c2.new_page(); p.goto(BASE + '/clock-line.html')
    p.evaluate("""() => { const c = JSON.parse(localStorage.getItem('mala_req_init_v1')); c.at = Date.now() - 31 * 86400000; localStorage.setItem('mala_req_init_v1', JSON.stringify(c)); }""")
    p.close()
    p = open_page(c2, u, slow % (2500, 0))
    p.wait_for_timeout(1200)
    ok('開頁加快：記住超過 30 天 → 不拿來用', p.locator('#reqView .rq-tabs').count() == 0, p.inner_text('#reqView')[:60])
    p.wait_for_selector('#reqView .rq-tabs', timeout=15000)
    p.close()
    # 6. 光復還是舊版（不認得 lite、沒有 line_hub_req_quota）→ 照樣有額度
    set_hub(mock_old_hub=True)
    p = open_page(c2, u)
    p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
    p.click('#reqView .rq-chip:has-text("特休假")')
    p.wait_for_selector('#reqView .rq-quota', timeout=10000)
    ok('開頁加快：光復舊版 → 額度跟著開頁資料一起來，照樣顯示', '特休假：剩 40 小時（上限 56）' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
    p.close()
    set_hub(mock_old_hub=None)
    c2.close()


# LINE 申請頁先讀 Mac mini（2026-11-14，營運系統 docs/line-req-mirror/）：頁內假 mini（http://mini.test/），代問就轉給 mock 的 /api
MINI_URL = 'http://mini.test/store/api/line-req'
MINI_JS = """
window.__mini = { peek: {}, read: 'proxy', mode: '', hits: [], at: 0 };
const _mf = window.fetch;
window.fetch = function (url, o) {
  if (String(url).indexOf('http://mini.test/') !== 0) return _mf.apply(this, arguments);
  const M = window.__mini, b = JSON.parse(o.body); M.hits.push(b);
  const J = (x) => Promise.resolve(new Response(JSON.stringify({ ok: true, data: x })));
  if (M.mode === 'abort') return Promise.reject(new TypeError('Failed to fetch'));
  if (M.mode === 'off') return J({ ok: false, error: 'off' });
  if (b.op === 'timing') return J({ ok: true });
  if (b.op === 'peek') { const d = M.peek[b.kind]; return J(d ? { ok: true, hit: true, at: M.at || Date.now() - 600000, data: d } : { ok: true, hit: false }); }
  if (M.read === 'upstream') return J({ ok: false, error: 'upstream' });
  const ACT = { init: 'line_hub_req_init', quota: 'line_hub_req_quota', info: 'req_info' };
  const g = { action: ACT[b.kind], id_token: b.id_token }; if (b.kind === 'init') g.lite = true;
  return window.fetch(b.url, { method: 'POST', body: JSON.stringify(g) }).then(r => r.json())
    .then(j => new Response(JSON.stringify({ ok: true, data: { ok: true, src: 'mini', data: j } })));
};
"""


def phase_req_mini(ctx, hq):
    """先讀 Mac mini：mini 記住的先顯示（小字「資料更新於」），Google 回來就換掉；mini 連不上／關掉／代問失敗 → 照舊直接問 Google；只計時模式不問 mini。"""
    def gas(body):
        rq = urllib.request.Request(BASE + '/api', data=json.dumps(body).encode(), method='POST')
        return json.loads(urllib.request.urlopen(rq, timeout=10).read())
    tok = 'MOCK_ID_TOKEN_U1'
    init = gas({'action': 'line_hub_req_init', 'id_token': tok, 'lite': True})
    quota = gas({'action': 'line_hub_req_quota', 'id_token': tok})
    ok('先讀 mini：假後端額度有特休假', any(q.get('name') == '特休假' for q in quota.get('quota', [])), quota)
    old = json.loads(json.dumps(quota))
    for q in old['quota']:
        if q.get('name') == '特休假': q['remain_h'] = 99
    base = '&view=req&tab=leave&retry_ms=50&mini_req=' + MINI_URL
    def setup(peek, slow_ms, **kw):
        js = MINI_JS + "window.__mini.peek = %s;" % json.dumps(peek) + ''.join("window.__mini.%s = %s;" % (k, json.dumps(v)) for k, v in kw.items())
        js += "window.__delay = {line_hub_req_init: %d, line_hub_req_quota: %d};" % (slow_ms, slow_ms)
        return js
    # 1. 換手機（手機沒記住）＋ Google 慢 4 秒：mini 記住的開頁資料、額度先出來，小字標時間；Google 回來換成最新、小字消失
    c2 = ctx.browser.new_context()
    p = open_page(c2, url(hq, in_client=True, extra=base + '&req_mirror=1'), setup({'init': init, 'quota': old}, 4000))
    p.wait_for_selector('#reqView .rq-tabs', timeout=2000)
    p.click('#reqView .rq-chip:has-text("特休假")')
    p.wait_for_selector('#reqView .rq-quota', timeout=2000)
    t = p.inner_text('#reqView')
    ok('先讀 mini：Google 還沒回 → 表單與 mini 記住的額度「剩 99 小時」先出來', '特休假：剩 99 小時' in t, t[:200])
    ok('先讀 mini：最下面小字「資料更新於 HH:MM」', p.locator('#reqView .rq-fresh').count() == 1 and '資料更新於' in p.inner_text('#reqView .rq-fresh'), t[-80:])
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('剩 40 小時') >= 0", timeout=15000)
    ok('先讀 mini：Google 回來 → 換成最新「剩 40 小時」、小字消失', p.locator('#reqView .rq-fresh').count() == 0, p.inner_text('#reqView')[:200])
    hits = p.evaluate("window.__mini.hits.map(h => h.op + ':' + (h.kind || ''))")
    ok('先讀 mini：先讀與代問都有走 mini（開頁資料、額度、我的申請）',
       all(x in hits for x in ['peek:quota', 'peek:init', 'read:init', 'read:quota', 'read:info']), hits)
    rq = p.evaluate("window.__mini.hits.filter(h => h.op === 'read' && h.kind === 'quota').length")
    ok('先讀 mini：額度只請 mini 代問一次（沒有退回直接問）', rq == 1, rq)      # 頁內延遲（__delay）會讓同一支在 __calls 記兩次，所以看 mini 收到的
    p.click('#reqView .rq-tabs button[data-tab=mine]')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('最近 60 天') >= 0", timeout=10000)
    p.wait_for_timeout(300)
    bc = p.evaluate("window.__beacons.filter(b => b.url.indexOf('mini.test') >= 0).length")
    ok('先讀 mini：表單、剩幾天、我的申請都出來後回報計時給 mini 一次', bc == 1, p.evaluate("window.__beacons"))
    p.close(); c2.close()
    # 2. mini 連不上 → 照舊直接問 Google（額度照樣出來、沒有小字）
    p = open_page(ctx, url(hq, in_client=True, extra=base + '&req_mirror=1'), setup({}, 0, mode='abort'))
    p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
    p.click('#reqView .rq-chip:has-text("特休假")')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('剩 40 小時') >= 0", timeout=10000)
    ok('先讀 mini：mini 連不上 → 直接問 Google，照樣顯示額度、沒有小字', p.locator('#reqView .rq-fresh').count() == 0)
    p.close()
    # 3. mini 關掉（off）、代問失敗（upstream）→ 一樣直接問 Google
    for kw, name in (({'mode': 'off'}, '開關關掉'), ({'read': 'upstream'}, '代問 Google 失敗')):
        p = open_page(ctx, url(hq, in_client=True, extra=base + '&req_mirror=1'), setup({}, 0, **kw))
        p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
        p.click('#reqView .rq-chip:has-text("特休假")')
        p.wait_for_function("document.getElementById('reqView').textContent.indexOf('剩 40 小時') >= 0", timeout=10000)
        ok('先讀 mini：' + name + ' → 直接問 Google，照樣顯示額度', True)
        p.close()
    # 4. 只計時（沒開 REQ_MIRROR）：不問 mini，只回報計時
    p = open_page(ctx, url(hq, in_client=True, extra=base), setup({'quota': old}, 0))
    p.wait_for_selector('#reqView .rq-tabs', timeout=10000)
    p.click('#reqView .rq-chip:has-text("特休假")')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('剩 40 小時') >= 0", timeout=10000)
    p.click('#reqView .rq-tabs button[data-tab=mine]')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('最近 60 天') >= 0", timeout=10000)
    p.wait_for_timeout(300)
    ok('先讀 mini：只計時模式 → 沒有先讀、代問', p.evaluate("window.__mini.hits.length") == 0, p.evaluate("window.__mini.hits"))
    ok('先讀 mini：只計時模式 → 照樣回報計時', p.evaluate("window.__beacons.filter(b => b.url.indexOf('mini.test') >= 0).length") == 1)
    p.close()


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
    ok('班表：休假格寫中文名稱（不寫代碼）', ''.join(p.inner_text(f'#schedView .sc-day[data-d="{off["d"]}"]').split()[1:]) == (off['label'] or off['code']),
       (p.inner_text(f'#schedView .sc-day[data-d="{off["d"]}"]'), off))
    p.close()
    # 營運系統排班（11/1 起）：例假 R、休息日 H、請假、國定假日 → 格子與明細都寫中文（2026-11-02 Eason）
    fake = {'R': '例假', 'H': '休息日', '病': '病假', '國': '國定假日'}
    def sched_h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') != 'line_hub_sched':
            return route.continue_()
        j = route.fetch().json()
        n = 0
        for d in j.get('days') or []:
            if not d.get('work') and n < len(fake):
                k = list(fake)[n]; d.update({'code': k, 'label': fake[k], 'segs': [], 'work': False, 'rest': True}); n += 1
        route.fulfill(json=j)
    p = open_page(ctx, f'{BASE}/clock-line.html?mock_uid=U1&api=/api&view=sched')
    p.set_viewport_size({'width': 375, 'height': 812})
    p.route('**/api', sched_h)
    p.reload()
    p.wait_for_selector('#schedView .sc-cal', timeout=10000)
    want = {'R': '例假', 'H': '休假', '病': '病假', '國': '國定假日'}
    got = {}
    for d in p.evaluate("Array.from(document.querySelectorAll('#schedView .sc-day .sc-o')).map(e => e.textContent)"):
        got[d] = 1
    ok('班表：例假／休假／病假／國定假日寫中文、沒有 R／H', all(v in got for v in want.values()) and 'R' not in got and 'H' not in got, sorted(got))
    cells = [x for x in p.query_selector_all('#schedView .sc-day.off') if x.inner_text().split()[-1] == '休假']
    if cells:
        cells[0].click(); p.wait_for_timeout(200)
    ok('班表：點休假那天明細寫「休假」', bool(cells) and '休假' in p.inner_text('#schedView'), bool(cells))
    ok('班表：國定假日格子在 375 寬不超出格子', p.evaluate("""Array.from(document.querySelectorAll('#schedView .sc-day .sc-o')).every(e => e.scrollWidth <= e.parentElement.clientWidth + 1)"""))
    p.close()
    p = page('U1')
    td = int(r['today'][8:10])
    ok('班表：本月預設選今天、今天有外框', p.locator(f'#schedView .sc-day.sel.today[data-d="{td}"]').count() == 1)
    CM.scan(p, '班表月曆（本月）')
    wrong = []
    for x in r['days']:   # 每一格都點，明細日期要對（審查 P2#2）
        p.click(f'#scD{x["d"]}')
        det = p.inner_text('#scDet')
        bad = []
        if not det.split('\n')[0].startswith('%d/%d（' % (int(r['ym'][5:7]), x['d'])):
            bad.append('日期')
        if x['code'] and x['label'] not in det:
            bad.append('班別')
        if any(a + '–' + b not in det for a, b in x['segs']):
            bad.append('時段')
        if not x['code'] and '這天沒有排班' not in det:
            bad.append('空白')
        # 工作站別（2026-10-19）：有站才多一列「工作站／炒鍋」，且排在「班別」下一列；沒站、休假、空白都不能出現
        if x.get('station'):
            if '工作站\n' + x['station'] not in det or p.locator('#scStation').count() != 1:
                bad.append('工作站')
            elif det.split('\n').index('工作站') != det.split('\n').index('班別') + 2:
                bad.append('工作站位置')
        elif '工作站' in det or p.locator('#scStation').count():
            bad.append('不該有工作站')
        if bad:
            wrong.append((x['d'], bad))
        CM.mark(p.evaluate(KEY_JS, f'#scD{x["d"]}'), '明細日期／班別／時段正確')
    ok('班表：每一天都點過，明細日期、班別、時段都對', not wrong, wrong)
    p.click(f'#scD{first_work["d"]}')
    det = p.inner_text('#scDet')
    ok('班表：點兩段班看第一段、第二段、合計', '第一段' in det and '第二段' in det and ('合計\n%s 小時' % (int(first_work['hours']) if first_work['hours'] == int(first_work['hours']) else first_work['hours'])) in det, det)
    blank = next((x for x in r['days'] if not x['code']), None)
    if blank:
        p.click(f'#schedView .sc-day[data-d="{blank["d"]}"]')
        ok('班表：空白天寫「這天沒有排班」', '這天沒有排班' in p.inner_text('#scDet'))
    p.click(f'#schedView .sc-day[data-d="{off["d"]}"]')
    ok('班表：休假天明細寫班別名稱', off['label'] in p.inner_text('#scDet'))
    nt = next(x for x in r['days'] if x.get('no_time'))
    p.click(f'#scD{nt["d"]}')
    det = p.inner_text('#scDet')
    ok('班表：要上班但沒時段（公休）→ 格子寫代碼、明細只寫班別與合計', p.inner_text(f'#scD{nt["d"]}').split()[-1] == nt['code']
       and '公休' in det and '合計\n8 小時' in det and '上班時間' not in det and '第一段' not in det, det)
    ok('班表：本月時「›」不能按', p.locator('#scNext').is_disabled())
    no_undefined(p, '班表月曆')
    ok('班表：375px 沒有橫向捲動', p.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
    p.screenshot(path=os.path.join(SHOTS, '班表_月曆.jpg'), type='jpeg', quality=80)
    # 摘要
    p.click('#schedView .rq-tabs button[data-tab=sum]')
    CM.mark(p.evaluate(KEY_JS, '#schedView .rq-tabs button[data-tab=sum]'), '切到摘要')
    CM.scan(p, '班表摘要')
    nums = p.locator('#schedView .sc-sum b').all_inner_texts()
    sm = r['summary']
    ok('班表：摘要三個數字＝後端', nums == [str(sm['work_days']), str(sm['off_days']), ('%g' % sm['hours'])], (nums, sm))
    nx = p.inner_text('#scNextShift')
    want = '本月沒有接下來的班' if not r['next'] else '%d/%d' % (int(r['next']['date'][5:7]), int(r['next']['date'][8:10]))
    ok('班表：下一個班', want in nx, nx)
    if r['next']:
        ns = p.inner_text('#scNextShift .sc-ns')
        ok('班表：下一個班站別（有才加「　站：炒鍋」，沒有就不出現）',
           (ns.endswith('　站：' + r['next']['station']) if r['next'].get('station') else '站：' not in ns), (ns, r['next']))
    p.screenshot(path=os.path.join(SHOTS, '班表_摘要.jpg'), type='jpeg', quality=80)
    # 切上個月
    p.click('#schedView .rq-tabs button[data-tab=cal]')
    CM.mark(p.evaluate(KEY_JS, '#schedView .rq-tabs button[data-tab=cal]'), '切回月曆')
    n_calls = len(calls(p))
    p.click('#scPrev')
    p.wait_for_function('document.querySelector("#schedView .sc-mon b") && document.querySelector("#schedView .sc-mon b").textContent.indexOf(" %d 月") >= 0' % int(r['months'][0][5:7]), timeout=8000)
    CM.mark(p.evaluate(KEY_JS, '#scPrev'), '切上個月帶 ym（點完、畫好後登記）')
    c = calls(p)
    ok('班表：切上個月帶 ym', c[n_calls]['action'] == 'line_hub_sched' and len(c) == n_calls + 1, c[n_calls:])
    ok('班表：上個月不預選日期、「‹」不能按', p.locator('#schedView .sc-day.sel').count() == 0 and p.locator('#scPrev').is_disabled())
    CM.scan(p, '班表月曆（上個月）')
    for k in p.evaluate("() => [...document.querySelectorAll('#schedView .sc-day')].map(e => e.id)"):
        p.click('#' + k)
        CM.mark(p.evaluate(KEY_JS, '#' + k), '上個月明細')
    p.click('#scNext')
    CM.mark(p.evaluate(KEY_JS, '#scNext'), '切回本月（用已讀的）')
    ok('班表：切回本月不再打後端（用已讀的）', len(calls(p)) == n_calls + 1)
    p.close()
    # 各種看不到的狀態
    p = page('U6')
    ok('班表：計時同仁已排班後空白天寫「休假」', ''.join(p.inner_text('#scD1').split()[1:]) == '休假' and p.inner_text('#scD3').split()[1:] == ['09:00', '17:30'],
       (p.inner_text('#scD1'), p.inner_text('#scD3')))
    p.click('#scPrev')
    p.wait_for_selector('#schedView .sc-box.info', timeout=8000)
    pm = int(r['months'][0][5:7])
    ok('班表：上個月沒有他的班 → no_schedule 字句（逐字）', p.inner_text('#schedView .sc-box') == '%d 月的班表沒有你的班。' % pm, p.inner_text('#schedView .sc-box'))
    p.close()
    p = page('U7')
    ok('班表：同名兩位 → not_matched 字句（逐字）', p.inner_text('#schedView .sc-box') == '你的班表還沒對上，請找店長確認。')
    p.close()
    p = page('U8')
    nb = '找不到你在職的打卡門市，請找店長確認。'
    ok('班表：已離職（綁過光復）→ not_bound 字句（逐字）', p.inner_text('#schedView .sc-box') == nb, p.inner_text('#schedView .sc-box'))
    p.close()
    d = json.load(open(fg, encoding='utf-8'))
    cy, cm = int(r['months'][1][:4]), int(r['months'][1][5:7])
    d['mock_sched'] = {'unlock': ['%d_%d' % (cy, cm)]}
    json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    p = page('U1')
    ok('班表：沒鎖定 → 還在排（逐字）、不畫月曆', p.inner_text('#schedView .sc-box') == '%d 月的班表還在排，排好後就看得到。' % cm and p.locator('#schedView .sc-cal').count() == 0)
    p.click('#schedView .rq-tabs button[data-tab=sum]')
    ok('班表：沒鎖定時摘要頁也只顯示提示', p.locator('#schedView .sc-sum').count() == 0 and '還在排' in p.inner_text('#schedView'))
    p.close()
    d['mock_sched'] = {'fail': True}
    json.dump(d, open(fg, 'w', encoding='utf-8'), ensure_ascii=False)
    p = page('U1')
    ok('班表：Gist 讀不到 → 錯誤字句（逐字）＋重新整理、不畫空月曆', p.inner_text('#schedView .sc-box') == '班表暫時讀不到，請稍後再試。'
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
    ok('班表：上個月讀失敗後重新整理仍是上個月', ' %d 月' % int(r['months'][0][5:7]) in p.inner_text('#schedView .sc-mon b'), p.inner_text('#schedView .sc-mon b'))
    p.close()
    p = open_page(ctx, f'{BASE}/clock-line.html?mock_uid=U1&api=/api&view=sched', pre="window.__fake = { line_hub_sched: 'abort' };")
    p.wait_for_selector('#schedView .sc-box.err', timeout=40000)
    ok('班表：斷線重試三次後顯示連線不穩（逐字）', p.inner_text('#schedView .sc-box') == '連線不穩，班表沒有讀到。' and len([x for x in calls(p) if x['action'] == 'line_hub_sched']) == 3, calls(p))
    p.close()


def phase_miss_store(ctx):
    """忘打卡自動選店（2026-10-28）：綁光復＋金山的同仁，選好日期後依「那天哪家有卡」選店。
    只有金山有卡 → 換到金山＋一行說明，送出到金山；手動改回光復照樣可以；兩家都有卡 → 不換、提醒確認；
    都沒卡 → 維持光復、不說明；金山問不到（斷線、舊後端）→ 不換。"""
    from datetime import datetime, timedelta, timezone
    tz = timezone(timedelta(hours=8))
    dd = lambda k: (datetime.now(tz) - timedelta(days=k)).strftime('%Y-%m-%d')
    D1, D2, D3 = dd(1), dd(2), dd(3)
    md = lambda d: '%d/%d' % (int(d[5:7]), int(d[8:10]))
    files = {'': os.path.join(ROOT, 'mock', 'mock_data.json'), 'mztjs': os.path.join(ROOT, 'mock', 'mock_data_mztjs.json')}
    p = open_page(ctx, BASE + '/clock-line.html?mock_uid=U9&api=/api&view=sched')   # 只為了讓兩家 mock 資料檔先建好
    for api in ('/api', '/api/mztjs'):
        p.evaluate("u => fetch(u, {method:'POST', body: JSON.stringify({action:'req_info', id_token:'MOCK_ID_TOKEN_U9'})})", api)
    p.close()
    def ev(ts, t, status='ok'):
        return {'ts': ts, 'emp_id': 'E09', 'type': t, 'status': status, 'lat': 0, 'lng': 0, 'distance_m': 1, 'accuracy_m': 10,
                'device_id': 'line:U9', 'device_match': True, 'within_range': status == 'ok'}
    seed_ev = {'': [ev(D2 + 'T11:00:00+08:00', 'in'), ev(D2 + 'T15:00:00+08:00', 'out')],
               'mztjs': [ev(D1 + 'T17:00:00+08:00', 'in'), ev(D2 + 'T17:00:00+08:00', 'in'), ev(D2 + 'T21:30:00+08:00', 'out')]}
    for code, f in files.items():
        d = json.load(open(f, encoding='utf-8'))
        d['roster'] = [r for r in d['roster'] if r['emp_id'] != 'E09'] + [{'emp_id': 'E09', 'name': '測試九', 'key': 'testkey9', 'device_id': '',
                       'device_bound_at': '', 'active': True, 'line_user_id': 'U9'}]
        d['events'] = [e for e in d['events'] if e['emp_id'] != 'E09'] + seed_ev[code]
        d['requests'] = [r for r in d.get('requests', []) if r.get('emp_id') != 'E09']
        json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
    js_name = JS['name']
    store_of = lambda pg: pg.evaluate("() => { const s = document.querySelector('#reqView select.rq-store'); return s.options[s.selectedIndex].text; }")
    # 0. 預設店別＝打卡的店（2026-10-29）：最近一張卡在金山（昨天）→ 請假頁直接選好金山，不再固定光復
    p = open_page(ctx, BASE + '/clock-line.html?mock_uid=U9&api=/api&in_client=1&retry_ms=100&view=req&tab=leave')
    p.wait_for_selector('#reqView select.rq-store', timeout=10000)
    ok('預設店別：最近一張卡在金山 → 請假頁預設金山', store_of(p) == js_name, store_of(p))
    p.close()
    # 接下來的忘打卡選店測試要從「預設光復」開始 → 補一張今天在光復的卡（不影響 D1～D3 那幾天）
    d = json.load(open(files[''], encoding='utf-8'))
    d['events'].append(ev(dd(0) + 'T00:00:01+08:00', 'in'))
    json.dump(d, open(files[''], 'w', encoding='utf-8'), ensure_ascii=False)
    u = BASE + '/clock-line.html?mock_uid=U9&api=/api&in_client=1&retry_ms=100&view=req&tab=miss'
    p = open_page(ctx, u)
    p.set_viewport_size({'width': 375, 'height': 812})
    p.wait_for_selector('#reqView select.rq-date', timeout=10000)
    store_txt = lambda: store_of(p)
    ok('預設店別：今天在光復打過卡 → 預設光復', store_txt() == '小辛辣 新竹光復', store_txt())
    # 1. 只有金山有卡 → 自動換金山
    p.select_option('#reqView select.rq-date', D1)
    p.wait_for_selector('#reqView .rq-auto-store', timeout=10000)
    note = p.inner_text('#reqView .rq-auto-store')
    ok('忘打卡選店：只有金山有卡 → 換到金山', store_txt() == js_name, store_txt())
    ok('忘打卡選店：說明「M/D 你在金山有打卡，已幫你選這家」', note.startswith(md(D1) + ' 你在' + js_name + '有打卡，已幫你選這家'), note)
    ok('忘打卡選店：紀錄是金山那天的卡', '17:00 上班 ✓' in p.inner_text('#reqView .rq-rec'), p.inner_text('#reqView .rq-rec'))
    c = [x for x in calls(p) if x['action'] == 'req_info']
    ok('忘打卡選店：兩家店都問了（光復 /api、金山 /api/mztjs）', {x['url'].rsplit('/api', 1)[1] for x in c} >= {'', '/mztjs'}, c)
    p.screenshot(path=os.path.join(SHOTS, '忘打卡_自動選店.jpg'), type='jpeg', quality=80)
    pick_time(p, 0, '22:00')
    p.click('#reqView .rq-chip:has-text("忘記按")')
    p.click('#reqView button.primary')
    p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
    sent = [x for x in calls(p) if x['action'] == 'req_submit']
    ok('忘打卡選店：送到金山（/api/mztjs req_submit）', sent and sent[-1]['url'].endswith('/api/mztjs'), sent)
    dj = json.load(open(files['mztjs'], encoding='utf-8'))
    ok('忘打卡選店：金山 requests 多一筆、光復沒有', any(r['emp_id'] == 'E09' and r['date'] == D1 for r in dj['requests'])
       and not any(r.get('emp_id') == 'E09' for r in json.load(open(files[''], encoding='utf-8')).get('requests', [])))
    p.close()
    # 2. 手動改回光復：說明消失、顯示光復那天沒有卡
    p = open_page(ctx, u)
    p.wait_for_selector('#reqView select.rq-date', timeout=10000)
    p.select_option('#reqView select.rq-date', D1)
    p.wait_for_selector('#reqView .rq-auto-store', timeout=10000)
    p.select_option('#reqView select.rq-store', '0')
    p.wait_for_function("() => document.querySelector('#reqView .rq-rec') && !document.querySelector('#reqView .rq-auto-store')", timeout=10000)
    ok('忘打卡選店：同仁可以手動改回光復（說明消失、顯示光復那天的紀錄）', store_txt() == '小辛辣 新竹光復'
       and '沒有任何打卡' in p.inner_text('#reqView .rq-rec'), p.inner_text('#reqView .rq-rec'))
    # 3. 兩家都有卡 → 不換、提醒確認
    p.select_option('#reqView select.rq-date', D2)
    p.wait_for_selector('#reqView .rq-auto-store.warn', timeout=10000)
    w = p.inner_text('#reqView .rq-auto-store.warn')
    ok('忘打卡選店：兩家都有卡 → 店別不動、提醒確認', store_txt() == '小辛辣 新竹光復' and w.startswith(md(D2) + ' 你在小辛辣 新竹光復、' + js_name + '都有打卡'), w)
    # 4. 都沒卡 → 不動、不說明
    p.select_option('#reqView select.rq-date', D3)
    p.wait_for_selector('#reqView .rq-rec', timeout=10000)
    ok('忘打卡選店：都沒卡 → 維持光復、不說明', store_txt() == '小辛辣 新竹光復' and p.locator('#reqView .rq-auto-store').count() == 0)
    no_undefined(p, '忘打卡選店')
    p.close()
    # 5. 金山問不到（斷線或舊後端）→ 不換，照舊用第一家
    p = ctx.new_page(); p.add_init_script(LOG_JS)
    p.route('**/api/mztjs', lambda r: r.abort() if 'day_only' in (r.request.post_data or '') else r.continue_())
    p.goto(u)
    p.wait_for_selector('#reqView select.rq-date', timeout=10000)
    p.select_option('#reqView select.rq-date', D1)
    p.wait_for_selector('#reqView .rq-rec', timeout=15000)
    ok('忘打卡選店：金山問不到 → 不換店、照舊顯示光復那天', store_txt() == '小辛辣 新竹光復' and p.locator('#reqView .rq-auto-store').count() == 0
       and '沒有任何打卡' in p.inner_text('#reqView .rq-rec'), p.inner_text('#reqView')[:200])
    p.close()


def phase_miss_break(ctx):
    """忘打卡「中間休息沒打卡」（2026-11-02 Eason）：那天有整段班 → 只剩這個選項；填休息開始、回來上班兩個時間送出；
    回來早於休息開始被擋；送出後「我的申請」寫「忘打卡・補休息 12:00–18:00」。用 U9（phase_miss_store 建的）在光復。"""
    from datetime import datetime, timedelta, timezone
    D = (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=4)).strftime('%Y-%m-%d')
    f = os.path.join(ROOT, 'mock', 'mock_data.json')
    d = json.load(open(f, encoding='utf-8'))
    mk = lambda hm, t: {'ts': D + 'T' + hm + ':00+08:00', 'emp_id': 'E09', 'type': t, 'status': 'ok', 'lat': 0, 'lng': 0, 'distance_m': 1,
                        'accuracy_m': 10, 'device_id': 'line:U9', 'device_match': True, 'within_range': True}
    d['events'] = [e for e in d['events'] if not (e['emp_id'] == 'E09' and e['ts'][:10] == D)] + [mk('08:49', 'in'), mk('21:55', 'out')]
    json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
    p = open_page(ctx, BASE + '/clock-line.html?mock_uid=U9&api=/api&in_client=1&retry_ms=100&view=req&tab=miss')
    p.set_viewport_size({'width': 375, 'height': 812})
    p.wait_for_selector('#reqView select.rq-date', timeout=10000)
    p.select_option('#reqView select.rq-date', D)
    p.wait_for_function("() => document.getElementById('reqView').textContent.includes('中間休息沒打卡')", timeout=10000)
    t = p.inner_text('#reqView')
    ok('休息：整段班那天可選「中間休息沒打卡」或「另一段班整段沒打」，預設中間休息、有休息開始／回來上班兩格、說明算一次',
       p.locator('#reqView .rq-chip.on:text-is("中間休息沒打卡")').count() == 1 and p.locator('#reqView .rq-chip:text-is("另一段班整段沒打")').count() == 1 and '休息開始（下班）' in t and '回來上班' in t and '兩張一起補，算一次' in t, t[:300])
    times = p.locator('#reqView .rq-time')
    def put(i, hh, mm):
        times.nth(i).locator('select.rq-hh').select_option(hh); times.nth(i).locator('select.rq-mm').select_option(mm)
    put(0, '18', '00'); put(1, '12', '00')
    p.click('#reqView .rq-chip:has-text("忘記")') if p.locator('#reqView .rq-chip:has-text("忘記")').count() else p.locator('#reqView .rq-chips .rq-chip').first.click()
    p.click('#reqView button.primary')
    p.wait_for_selector('#reqView .rq-box.err', timeout=10000)
    ok('休息：回來早於休息開始 → 擋下、說明原因', '晚' in p.inner_text('#reqView .rq-box.err') or '之內' in p.inner_text('#reqView .rq-box.err'),
       p.inner_text('#reqView .rq-box.err'))
    put(0, '12', '00'); put(1, '18', '00')
    p.click('#reqView button.primary')
    p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
    d = json.load(open(f, encoding='utf-8'))
    r = [x for x in d.get('requests', []) if x.get('emp_id') == 'E09' and x.get('date') == D and x.get('miss_type') == 'break']
    ok('休息：送出存成 miss_type＝break、end＝12:00（下班）、start＝18:00（回來上班）', len(r) == 1 and r[0]['end'] == '12:00' and r[0]['start'] == '18:00', r)
    p.click('#reqView .rq-tabs button:has-text("我的申請")')
    p.wait_for_function("() => document.getElementById('reqView').textContent.includes('補休息')", timeout=10000)
    ok('休息：我的申請寫「忘打卡・補休息 12:00–18:00」', '忘打卡・補休息 12:00–18:00' in p.inner_text('#reqView'), p.inner_text('#reqView')[:200])
    p.close()


def phase_leave_proof(ctx, hq):
    """請假證明（2026-10-10 Eason）：病假選了要附證明 → 欄位標「一定要附」；沒附送出要確認（取消＝不送）；
    送出後「我的申請」顯示還沒附＋補附按鈕；補附＝先傳光復 line_hub_attach_put、再打那家店 req_attach。"""
    import base64
    p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=leave'))
    p.set_viewport_size({'width': 375, 'height': 812})
    p.wait_for_selector('#reqView .rq-chip', timeout=10000)
    p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("病假")')
    p.wait_for_selector('#reqView .rq-chip.on:has-text("病假")', timeout=3000)
    # 2026-11-06：病假今年累計滿 3 天才要附；前兩天寫「這次可以不附」（第 3 天起同其他假別）
    note = p.inner_text('#rqProofNote')
    ok('證明：選病假 → 寫今年第幾天、滿 3 天才要附', bool(re.search(r'今年第 [12] 天病假：累計滿 3 天才要附證明，這次可以不附', note))
       or ('一定要附' in p.inner_text('#reqView') and '今年第' in p.inner_text('#reqView')), note)
    p.select_option('#reqView select.rq-special', '婚假')
    p.wait_for_function('document.getElementById("reqView").textContent.indexOf("證明文件（婚假一定要附）") >= 0', timeout=3000)
    ok('證明：選婚假 → 欄位寫「婚假一定要附」＋可以先送出的說明', '證明文件（婚假一定要附）' in p.inner_text('#reqView')
       and '還沒有證明也能先送出' in p.inner_text('#rqProofNote'), p.inner_text('#reqView')[:300])
    n0 = len([x for x in calls(p) if x['action'] == 'req_submit'])
    msgs = []
    p.once('dialog', lambda d: (msgs.append(d.message), d.dismiss()))
    p.click('#reqView button.primary')
    p.wait_for_selector('#reqView .rq-box.err', timeout=5000)
    ok('證明：沒附按送出 → 跳確認；按取消就不送', msgs and '婚假要附證明' in msgs[0] and '還沒送出' in p.inner_text('#reqView .rq-box.err')
       and len([x for x in calls(p) if x['action'] == 'req_submit']) == n0, (msgs, p.inner_text('#reqView .rq-box.err')))
    p.once('dialog', lambda d: d.accept())
    p.click('#reqView button.primary')
    p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 已送出") >= 0', timeout=10000)
    item = p.locator('#reqView .rq-item').filter(has_text='婚假').first
    ok('證明：確定先送出 → 我的申請顯示「還沒附證明」＋補附按鈕', '還沒附證明' in item.inner_text() and item.locator('.rq-proof-btn').count() == 1,
       item.inner_text())
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    item.locator('input[type=file]').set_input_files(files=[{'name': 'proof.png', 'mimeType': 'image/png', 'buffer': png}])
    p.wait_for_function('document.getElementById("reqView").textContent.indexOf("✓ 證明已補上") >= 0', timeout=15000)
    c = calls(p)
    up = [x for x in c if x['action'] == 'line_hub_attach_put']
    at = [x for x in c if x['action'] == 'req_attach']
    sub = [x for x in c if x['action'] == 'req_submit']
    ok('證明：補附先傳光復 line_hub_attach_put、再打送出那家店的 req_attach', up and up[-1]['url'].endswith('/api') and at and sub
       and at[-1]['url'] == sub[-1]['url'] and up[-1]['t'] <= at[-1]['t'], c[-4:])
    item = p.locator('#reqView .rq-item').filter(has_text='婚假').first
    ok('證明：補附後顯示「已附證明」、不再警告', '已附證明' in item.inner_text() and '還沒附證明' not in item.inner_text(), item.inner_text())
    p.screenshot(path=os.path.join(SHOTS, '請假證明_補附.jpg'), type='jpeg', quality=80)
    p.click('#reqView .rq-tabs button[data-tab=leave]')
    p.click('#reqView .rq-chips >> nth=0 >> .rq-chip:has-text("事假")')
    ok('證明：事假不要求證明（欄位維持選填）', '附件（選填' in p.inner_text('#reqView'))
    # 只提醒不擋（2026-11-06）：今天請事假 → 黃字「事假應在前一天請（這張是當天才送）」＋照樣可以送出
    ok('請假提醒：今天請事假 → 黃字「事假應在前一天請」、註明照樣可以送出', '事假應在前一天請（這張是當天才送）' in p.inner_text('#reqView .rq-warns')
       and '照樣可以送出' in p.inner_text('#reqView .rq-warns'), p.inner_text('#reqView')[:300])
    p.click('#reqView .rq-tabs button[data-tab=trip]')
    p.wait_for_selector('#reqView .rq-warns', timeout=3000)
    ok('請假提醒：出差選今天 → 黃字「出差應在一週前填（當天才填）」', '出差應在一週前填（當天才填）' in p.inner_text('#reqView .rq-warns'), p.inner_text('#reqView')[:300])
    p.close()


# ───────── 快速通道（2026-10-16）：Google liff_punch（唯一寫入者）＋ mini /clock/predict（只預判）同時送 ─────────
import re  # noqa: E402

RELAY_URL = BASE + '/relay-mock'
MINI_OK = {'predict': 'ok', 'ts': '2026-10-16T09:01:02+08:00', 'greeting': '【mini 問候】今天也辛苦了'}
G_OK = {'ok': True, 'type': 'out', 'ts': '2026-10-16T09:02:09+08:00', 'greeting': '【Google 問候】另一句話', 'missed': ''}
# 在頁內包 fetch，把「回應」延後 ms 毫秒（請求照常立刻送出）；尊重 AbortSignal，逾時 abort 時立刻結束。不用 sync route handler 睡覺。
LAG_JS = """
(function () {
  const g = window.fetch; window.__lag = {}; window.__inits = [];
  window.fetch = function (url, o) {
    let a = ''; try { a = JSON.parse(o.body).action; } catch (e) {}
    window.__inits.push({ action: a, keepalive: o && o.keepalive });
    const key = String(url).indexOf('relay-mock') >= 0 ? 'relay' : a;
    const ms = window.__lag[key] || 0;
    const p = g.apply(this, arguments);
    if (!ms) return p;
    return new Promise(function (res, rej) {
      let done = false; const sig = o && o.signal;
      const fin = function (f, v) { setTimeout(function () { if (!done) { done = true; f(v); } }, ms); };
      p.then(function (v) { fin(res, v); }, function (e) { fin(rej, e); });
      if (sig) sig.addEventListener('abort', function () { if (!done) { done = true; rej(new DOMException('aborted', 'AbortError')); } });
    });
  };
})();
"""


def relay_open(ctx, hq, mini, g, mini_ms=0, g_ms=0, mode='true', gstatus=None, qr=None, guard='clear'):
    """開一頁、攔 mini 與 Google 兩條路。mini／g：dict＝回 JSON；(狀態碼, 文字)＝原樣回；'abort'＝連不上。
    gstatus：None＝liff_status 照舊；'abort'＝打不通；'found'＝回頭確認時今天多了一張卡。回傳 (page, S)，S 記錄兩邊收到的 body。"""
    S = {'mini': mini, 'g': g, 'gstatus': None, 'guard': guard, 'mini_hits': [], 'g_posts': []}
    extra = '&retry_ms=50&relay_api=' + RELAY_URL + ('&relay_mode=' + mode if mode else '')
    if qr:
        u = BASE + '/clock-line.html?mock_uid=U1&api=/api&qr=' + qr + extra
    else:
        u = url(hq, extra=extra)
    def mini_h(route):
        try:
            S['mini_hits'].append(json.loads(route.request.post_data or '{}'))
        except ValueError:
            S['mini_hits'].append({'_raw': route.request.post_data})
        m = S['mini']
        if m == 'abort':
            return route.abort()
        if isinstance(m, tuple):
            return route.fulfill(status=m[0], body=m[1], content_type='text/plain')
        route.fulfill(status=200, body=json.dumps(m), content_type='text/plain')

    def g_h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        a = b.get('action')
        if a == 'liff_punch':
            S['g_posts'].append(b)
            if S['g'] == 'abort':
                return route.abort()
            return route.fulfill(status=200, body=json.dumps(S['g']), content_type='text/plain')
        if a == 'liff_status' and S['gstatus'] == 'abort':
            return route.abort()
        if a == 'liff_status':
            resp = route.fetch()
            j = resp.json()
            if S['guard'] and j.get('guard') is not None:   # 固定防呆狀態，免得測試被前面 phase 留下的卡與時間影響
                nowms = int(time.time() * 1000)
                last = {'type': 'in', 'hm': '08:00', 'ts': '2026-10-16T08:00:00+08:00'}
                if S['guard'] == 'none':   # 還沒打過任何卡（QR 打上班用）
                    j['guard'] = {'blocked': None, 'lock': {}, 'last': None, 'now': nowms}
                elif S['guard'] == 'clear':
                    j['guard'] = {'blocked': 'in', 'lock': {}, 'last': last, 'now': nowms}
                else:   # locked：剛打過上班，10 分鐘內不能打下班
                    j['guard'] = {'blocked': 'in', 'lock': {'out': nowms + 600000}, 'last': last, 'now': nowms}
            if S['gstatus'] == 'found':
                j['today'] = (j.get('today') or []) + [{'type': 'out', 'hm': '18:00', 'status': 'ok'}]
            return route.fulfill(response=resp, body=json.dumps(j))
        route.continue_()

    p = ctx.new_page()
    p.add_init_script(LOG_JS)
    p.add_init_script(LAG_JS)
    p.route(RELAY_URL, mini_h)
    p.route(re.compile(r'/api(/\w+)?$'), g_h)
    p.goto(u)
    if qr:
        p.wait_for_function('!document.getElementById("btnIn").disabled', timeout=10000)
    else:
        p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)

    S['gstatus'] = gstatus
    p.evaluate('(l) => { window.__lag = l; }', {'relay': mini_ms, 'liff_punch': g_ms})
    return p, S


def relay_last(p, timeout=12000):
    p.wait_for_function('(window.__timing || []).length > 0', timeout=timeout)
    return p.evaluate('window.__timing')[-1]


def phase_relogin(ctx, hq):
    """LINE 登入逾時（2026-10-30 審查）：後端回 invalid_id_token。LINE 裡 liff.login() 不能用，原本畫面卡住。
    現在：LINE 裡自動重整一次；10 分鐘內重整過還是逾時 → 停在「請關掉這頁重開」，不再重整、鍵維持停用。
    申請單送出時逾時不自動重整（填的內容會不見），給「重新連線」鍵。"""
    INV = "{ok:false,error:'invalid_id_token'}"
    LOADS = "sessionStorage.setItem('__loads', String((+sessionStorage.getItem('__loads') || 0) + 1));"
    loads = lambda p: int(p.evaluate("+sessionStorage.getItem('__loads') || 0"))
    # 1. 開頁就逾時（每次重讀都逾時）：重整一次，第二次停在說明
    p = open_page(ctx, url(hq, in_client=True), pre=LOADS + "window.__fake.liff_status = " + INV + ";")
    p.wait_for_function("document.getElementById('hint').textContent.indexOf('請關掉這頁') >= 0", timeout=15000)
    p.wait_for_timeout(1500)
    ok('登入逾時：開頁逾時 → 自動重整 1 次，第 2 次停在說明（不會一直跳）', loads(p) == 2, loads(p))
    ok('登入逾時：停住時寫「LINE 登入逾時／請關掉這頁…重新打開」、兩個鍵停用',
       'LINE 登入逾時' in msg(p) and p.evaluate("document.getElementById('btnIn').disabled && document.getElementById('btnOut').disabled"), msg(p))
    no_undefined(p, '登入逾時（開頁）')
    p.close()
    # 2. 打卡時逾時：說「這次打卡沒有送出」並重整；重整後畫面正常可再按；10 分鐘內再逾時就停住
    p = open_page(ctx, url(hq, in_client=True), pre=LOADS + "window.__fake.liff_punch = " + INV + ";")
    who_ready = 'document.getElementById("who").textContent === "測試一"'
    p.wait_for_function(who_ready, timeout=10000)
    force_out(p)
    p.wait_for_function("+sessionStorage.getItem('__loads') === 2", timeout=10000)
    p.wait_for_function(who_ready + " && window.__calls.some(c => c.action === 'liff_status')", timeout=15000)
    ok('登入逾時：打卡時逾時 → 重整後畫面恢復（重新讀到狀態）', 'LINE 登入逾時' not in msg(p), msg(p))
    force_out(p)
    p.wait_for_function("document.getElementById('msg').textContent.indexOf('這次打卡沒有送出') >= 0", timeout=10000)
    p.wait_for_timeout(1500)
    ok('登入逾時：10 分鐘內再逾時 → 寫「這次打卡沒有送出」＋請關掉重開、不再重整、鍵停用',
       loads(p) == 2 and '請關掉這頁' in msg(p) and p.evaluate("document.getElementById('btnOut').disabled"), (loads(p), msg(p)))
    p.close()
    # 3. 班表：逾時重整一次，再逾時停在說明
    p = open_page(ctx, f'{BASE}/clock-line.html?mock_uid=U1&api=/api&in_client=1&view=sched', pre=LOADS + "window.__fake.line_hub_sched = " + INV + ";")
    p.wait_for_function("document.getElementById('schedView').textContent.indexOf('請關掉這頁') >= 0", timeout=15000)
    ok('登入逾時：班表逾時 → 重整 1 次後停在「請關掉這頁…出勤班表」', loads(p) == 2, loads(p))
    p.close()
    # 4. 申請單送出時逾時：不自動重整，顯示「這張還沒送出」＋重新連線鍵；按了才重整
    p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=ot'), pre=LOADS + "window.__fake.req_submit = " + INV + ";")
    p.wait_for_selector('#reqView .rq-time', timeout=10000)
    pick_time(p, 0, '18:00'); pick_time(p, 1, '19:00')
    p.fill('#reqView input[type=text]', 'e2e 逾時')
    p.click('#reqView button.primary')
    p.wait_for_function("document.getElementById('reqView').textContent.indexOf('這張還沒送出') >= 0", timeout=10000)
    p.wait_for_timeout(1000)
    ok('登入逾時：申請送出時逾時 → 不自動重整（填的內容還在）、有「重新連線」鍵',
       loads(p) == 1 and p.locator('#reqView button:has-text("重新連線")').count() == 1, loads(p))
    p.click('#reqView button:has-text("重新連線")')
    p.wait_for_function("+sessionStorage.getItem('__loads') === 2", timeout=10000)
    ok('登入逾時：按「重新連線」才重整', True)
    p.close()
    # 5. 日期欄（2026-10-31）：請假／加班／出差都是「月」「日」下拉、沒有 input[type=date]；範圍 4 天前到 90 天後（11/28 以前從 11/1 起）；附星期與今天
    from datetime import datetime, timedelta, timezone
    tz = timezone(timedelta(hours=8)); now = datetime.now(tz)
    d = lambda k: (now + timedelta(days=k)).strftime('%Y-%m-%d')
    p = open_page(ctx, url(hq, in_client=True, extra='&view=req&tab=leave'))
    p.wait_for_selector('#reqView .rq-dpick', timeout=10000)
    # 2026-11-14 三種都由 7 改 4 天前；11/28 以前 11 月的日子都選得到（同 req-line.js DATE_OPEN_*）
    earliest = min('2026-11-01', d(-4)) if d(0) <= '2026-11-28' else d(-4)
    for tab in ('leave', 'ot', 'trip'):
        p.click('#reqView .rq-tabs button[data-tab=%s]' % tab)
        p.wait_for_selector('#reqView .rq-dpick', timeout=5000)
        info = p.evaluate("""() => { const ms = [...document.querySelectorAll('#reqView .rq-dm option')].map(o => o.value);
            const dd = document.querySelector('#reqView .rq-dd'); return { dateInputs: document.querySelectorAll('#reqView input[type=date]').length,
            months: ms, sel: dd.value, selText: dd.options[dd.selectedIndex].text }; }""")
        ok('日期欄（%s）：月日下拉、沒有日期轉盤、預設今天且標「今天」' % tab, info['dateInputs'] == 0 and info['sel'] == d(0)
           and '今天' in info['selText'] and info['months'][0] == earliest[:7] and info['months'][-1] == d(90)[:7], info)
    pick_date(p, earliest); first = p.evaluate("[...document.querySelectorAll('#reqView .rq-dd option')].map(o => o.value)")
    pick_date(p, d(90)); last = p.evaluate("[...document.querySelectorAll('#reqView .rq-dd option')].map(o => o.value)")
    ok('日期欄（出差）：最早只到 4 天前（11/28 以前到 11/1）、最晚只到 90 天後', first[0] == earliest and last[-1] == d(90), (first[:2], last[-2:]))
    p.select_option('#reqView select.rq-dm', d(0)[:7])
    ok('日期欄：換回這個月 → 日留在同一號（有就留）', p.evaluate("document.querySelector('#reqView .rq-dd').value")[8:] == d(90)[8:]
       or p.evaluate("document.querySelector('#reqView .rq-dd').value")[:7] == d(0)[:7], p.evaluate("document.querySelector('#reqView .rq-dd').value"))
    p.close()


def phase_same_type(ctx, hq):
    """打卡後 10 分鐘兩顆都鎖、之後同一顆再按跳確認框（2026-11-02 Eason：六張犁同仁中午忘打下班卡，晚上上班卡按不了）。"""
    S = {'guard': None}
    def h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') == 'liff_status' and S['guard']:
            j = route.fetch().json()
            if j.get('guard') is not None:
                j['guard'] = dict(S['guard'], now=int(time.time() * 1000))
            return route.fulfill(status=200, body=json.dumps(j), content_type='text/plain')
        return route.continue_()
    now = int(time.time() * 1000)
    # 2026-11-11（B33）：後端也擋「打完卡 10 分鐘內的另一型」。這段只假造畫面的 guard，假後端的資料要跟著一致：
    # 前面幾段剛打的卡（例：加班提示那段的下班卡）往前挪到 11 分鐘以前，否則最後按確定送出的上班卡會被後端正確地擋下
    from datetime import datetime, timedelta, timezone
    f = os.path.join(ROOT, 'mock', 'mock_data_hq.json')

    def backdate(last_type=None):
        """把這位同仁 11 分鐘內的卡全部挪到 11 分鐘前（解除後端的 10 分鐘鎖）。
        last_type：同時把最後一筆改成這個型別。2026-11-20 起這段要這樣做：畫面上的 guard 是假的（上一筆＝上班），
        但「改按下班」會真的送到 mock 後端；前面加班提示那段留下的真資料最後一筆是「下班」，
        後端就會回 need_confirm（同型），畫面再跳一次提醒框、不會出現打卡成功——跟畫面上假的 guard 對不起來。
        所以要讓假後端的最後一筆跟畫面上假的 guard 說的一樣（上班）。"""
        if not os.path.exists(f):
            return
        d = json.load(open(f, encoding='utf-8'))
        emp = next((r['emp_id'] for r in d['roster'] if r.get('line_user_id') == 'U1'), None)
        cut = datetime.now(timezone(timedelta(hours=8))) - timedelta(minutes=11)
        mine = [e for e in d['events'] if e['emp_id'] == emp]
        for e in mine:
            if datetime.fromisoformat(e['ts']) > cut:
                e['ts'] = cut.replace(microsecond=0).isoformat()
        if last_type and mine:
            mine[-1]['type'] = last_type
        json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
    backdate('in')
    S['guard'] = {'blocked': 'in', 'lock': {'in': now + 6 * 60000, 'out': now + 6 * 60000},
                  'last': {'type': 'in', 'hm': '08:49', 'ts': '2026-11-02T08:49:00+08:00'}}
    p = open_page(ctx, url(hq, in_client=True))
    p.route('**/api/hq', h)
    p.reload()
    p.wait_for_function('document.getElementById("who").textContent.length > 0', timeout=10000)
    p.wait_for_timeout(300)
    ok('同型：打卡後 10 分鐘內兩顆都鎖、都寫幾分後', p.is_disabled('#btnIn') and p.is_disabled('#btnOut')
       and '分後' in p.inner_text('#btnIn') and '分後' in p.inner_text('#btnOut'), (p.inner_text('#btnIn'), p.inner_text('#btnOut')))
    S['guard'] = {'blocked': None, 'lock': {'in': now - 60000, 'out': now - 60000},
                  'last': {'type': 'in', 'hm': '08:49', 'ts': '2026-11-02T08:49:00+08:00'}}
    p.reload()
    p.wait_for_function('document.getElementById("who").textContent.length > 0', timeout=10000)
    p.wait_for_timeout(300)
    ok('同型：過了 10 分鐘，上班鍵也能按（中午忘打下班卡，晚上回來要打得了）', not p.is_disabled('#btnIn') and not p.is_disabled('#btnOut'),
       p.inner_text('#btnIn'))
    ok('B：前一筆是 11/2 的上班（超過 16 小時）→ 上班鍵加亮、下班鍵變淡但仍可按，鍵上方寫「上一筆：11/2 08:49 上班」',
       'pg-next' in p.get_attribute('#btnIn', 'class') and 'pg-dim' in p.get_attribute('#btnOut', 'class')
       and not p.is_disabled('#btnOut') and p.inner_text('#pgLast') == '上一筆：11/2 08:49 上班', (p.get_attribute('#btnIn', 'class'), p.inner_text('#pgLast')))
    n0 = len([x for x in calls(p) if x['action'] == 'liff_punch'])
    # 誤按防呆（2026-11-20）：同型再按改頁面內提醒框，講出上一筆日期時間，主按鈕＝改按下班（預設焦點）
    p.click('#btnIn')
    p.wait_for_selector('#pgMask:not([hidden])', timeout=3000)
    dm = p.inner_text('#pgMsg')
    ok('同型：再按上班 → 提醒框講「上一筆是 11/2 08:49 上班…請按改按下班」；主按鈕＝改按下班且預設焦點、次按鈕＝確定是上班',
       '你上一筆是 11/2 08:49 上班，現在又按「上班」。如果是要下班，請按「改按下班」。' in dm and '忘打卡' in dm
       and p.inner_text('#pgMain') == '改按下班' and p.inner_text('#pgSub') == '確定是上班'
       and p.evaluate('document.activeElement.id') == 'pgMain' and len([x for x in calls(p) if x['action'] == 'liff_punch']) == n0, dm)
    p.click('#pgCancel')
    p.wait_for_timeout(300)
    ok('同型：提醒框按「先不打卡」→ 不送', p.locator('#pgMask:not([hidden])').count() == 0
       and len([x for x in calls(p) if x['action'] == 'liff_punch']) == n0, calls(p)[-3:])
    # 主按鈕＝照下班送出（原本按的是上班）
    p.click('#btnIn')
    p.wait_for_selector('#pgMask:not([hidden])', timeout=3000)
    p.keyboard.press('Enter')   # 預設焦點在主按鈕：連 Enter 也只會是「改按下班」，不會變成再打一次上班
    p.wait_for_function('window.__calls.filter(c => c.action === "liff_punch").length > %d' % n0, timeout=10000)
    lp = [x for x in calls(p) if x['action'] == 'liff_punch']
    ok('同型：主按鈕（Enter）→ 改送下班，不是上班', lp[-1]['type'] == 'out', lp[-1])
    wait_msg(p, '下班打卡成功')   # 等具體結果：後端收了才會出現；need_confirm／被擋都不會寫這句
    ok('同型：改按下班 → 下班卡真的寫進去', '下班打卡成功' in msg(p) and '打卡失敗' not in msg(p) and p.locator('#pgMask:not([hidden])').count() == 0, msg(p))
    backdate()   # 剛打的下班卡讓後端鎖 10 分鐘（B33）：挪到 11 分鐘前，後面「確定是上班」才不會被正確地擋下
    p.reload()
    p.wait_for_function('document.getElementById("who").textContent.length > 0', timeout=10000)
    p.wait_for_timeout(300)
    n0 = len([x for x in calls(p) if x['action'] == 'liff_punch'])
    p.click('#btnIn')
    p.wait_for_selector('#pgMask:not([hidden])', timeout=3000)
    p.click('#pgSub')
    p.wait_for_function('window.__calls.filter(c => c.action === "liff_punch").length > %d' % n0, timeout=10000)
    lp = [x for x in calls(p) if x['action'] == 'liff_punch']
    ok('同型：次按鈕「確定是上班」→ 照上班送出', lp[-1]['type'] == 'in', lp[-1])
    wait_msg(p, '上班打卡成功')
    ok('同型：提醒框按確定是上班 → 送出上班卡', '上班打卡成功' in msg(p), msg(p))
    p.close()


def phase_rest(ctx, hq):
    """休息不足（2026-11-01，Rest.gs）：liff_status 回 rest.blocked → 上班鍵鎖住、按鈕寫幾點後、訊息講原因；
    時間到自動解開並拿掉那句；下班鍵不受影響。伺服器擋下的上班卡（rejected_rest）照後端字句顯示。"""
    S = {'until': 0, 'punch': None}
    reason = '你 11/1 22:40 下班，兩班要隔 11 小時，09:40 以後才能打上班卡'
    def h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') == 'liff_status':
            j = route.fetch().json()
            if j.get('guard') is not None:
                j['guard'] = {'blocked': 'out', 'lock': {}, 'last': {'type': 'out', 'hm': '22:40', 'ts': '2026-11-01T22:40:00+08:00'},
                              'now': int(time.time() * 1000)}
                j['rest'] = {'blocked': True, 'code': 'gap', 'reason': reason, 'hint': '有問題請找值班主管', 'until': S['until']}
            return route.fulfill(status=200, body=json.dumps(j), content_type='text/plain')
        if b.get('action') == 'liff_punch' and S['punch']:
            return route.fulfill(status=200, body=json.dumps(S['punch']), content_type='text/plain')
        return route.continue_()
    S['until'] = int(time.time() * 1000) + 4000
    p = open_page(ctx, url(hq, in_client=True))
    p.route('**/api/hq', h)
    p.reload()
    p.wait_for_function('document.getElementById("who").textContent.length > 0', timeout=10000)
    p.wait_for_timeout(300)
    ok('休息不足：上班鍵鎖住、寫幾點後', p.is_disabled('#btnIn') and '後）' in p.inner_text('#btnIn'), p.inner_text('#btnIn'))
    ok('休息不足：畫面講原因（幾點以後才能打）', reason in msg(p), msg(p))
    p.wait_for_function('!document.getElementById("btnIn").disabled', timeout=12000)
    ok('休息不足：時間到上班鍵自動解開、按鈕恢復「上班」、拿掉那句', p.inner_text('#btnIn') == '上班' and reason not in msg(p), (p.inner_text('#btnIn'), msg(p)))
    # 伺服器擋下（例如別家店剛打下班卡，開頁時還不知道）
    S['punch'] = {'ok': False, 'type': 'in', 'status': 'rejected_rest', 'reason': '你 11/5 23:30 下班，兩班要隔 11 小時，10:30 以後才能打上班卡', 'hint': '有問題請找值班主管'}
    p.click('#btnIn')
    wait_msg(p, '兩班要隔 11 小時')
    ok('休息不足：伺服器擋下的上班卡照後端字句顯示', '兩班要隔 11 小時' in msg(p) and '有問題請找值班主管' in msg(p), msg(p))
    p.close()
    # 單日滿 10 小時（2026-11-06 起只提醒不擋）：rest.blocked=false＋warn → 上班鍵可按、黃字提醒；打卡成功訊息多一句、畫面不自動關
    warn = {'code': 'cap', 'reason': '你今天已經上班 10.5 小時（一天最多 10 小時）', 'hint': '再上班會超過 10 小時，請先跟店長確認'}
    def h2(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') == 'liff_status':
            j = route.fetch().json()
            if j.get('guard') is not None:
                j['guard'] = {'blocked': 'out', 'lock': {}, 'last': {'type': 'out', 'hm': '19:00', 'ts': '2026-11-01T19:00:00+08:00'},
                              'now': int(time.time() * 1000)}
                j['rest'] = {'blocked': False, 'warn': warn}
            return route.fulfill(status=200, body=json.dumps(j), content_type='text/plain')
        if b.get('action') == 'liff_punch':   # 後端照收（ok）並帶 rest_warn（同 Liff.gs）；不寫 mock 資料檔，免得影響後面的段落
            ts = time.strftime('%Y-%m-%dT%H:%M:%S+08:00', time.localtime())
            j = {'ok': True, 'type': 'in', 'ts': ts, 'greeting': '辛苦了', 'missed': '', 'req_notes': [], 'via_qr': False,
                 'rest_warn': warn['reason'] + '。' + warn['hint']}
            return route.fulfill(status=200, body=json.dumps(j), content_type='text/plain')
        return route.continue_()
    p = open_page(ctx, url(hq, in_client=True))
    p.route('**/api/hq', h2)
    p.reload()
    p.wait_for_function('document.getElementById("who").textContent.length > 0', timeout=10000)
    p.wait_for_timeout(300)
    ok('單日 10 小時：只提醒——上班鍵可按、按鈕寫「上班」、黃字講原因', not p.is_disabled('#btnIn') and p.inner_text('#btnIn') == '上班'
       and warn['reason'] in msg(p) and warn['hint'] in p.inner_text('#hint'), (p.inner_text('#btnIn'), msg(p)))
    p.on('dialog', lambda d: d.accept())
    p.click('#btnIn')
    if p.locator('#pgMask:not([hidden])').count():   # 2026-11-20：同型提醒框改頁面內，按「確定是上班」
        p.click('#pgSub')
    wait_msg(p, '上班打卡成功')
    ok('單日 10 小時：打得進去，成功訊息多「⚠️ 你今天已經上班…請先跟店長確認」', '⚠️ ' + warn['reason'] + '。' + warn['hint'] in msg(p), msg(p))
    p.wait_for_timeout(2200)
    ok('單日 10 小時：畫面不自動關（要讓同仁看到提醒）', p.evaluate('window.__closed !== true'))
    p.close()



# ── G＋備援（2026-11-15）：mini 是正本的店先送 mini、等 3 秒沒回改送 Google（同單號）──
G_URL = BASE + '/relay-mock-g/clock'   # 網址含 relay-mock：LAG_JS 用 'relay' 這個鍵延後 mini 的回應
G_MINI_OK = {'ok': True, 'type': 'out', 'ts': '2026-10-16T09:01:05+08:00', 'greeting': '【mini 正本】辛苦了', 'missed': '', 'missed_date': '', 'missed_type': '', 'req_notes': [], 'via_qr': False, 'role': 'primary'}


def g_open(ctx, hq, conf, mini, after=None, mini_ms=0, g=None):
    S = {'conf': conf, 'mini': mini, 'after': after or {'ok': True, 'state': 'done', 'extras': {}}, 'g': g or G_OK, 'mini_hits': [], 'after_hits': [], 'g_posts': [], 'conf_hits': 0}
    u = url(hq, extra='&retry_ms=50&st_only=0&g_api=' + G_URL)   # st_only=0：正式檔 ST_ONLY_MINI 已開店，這裡測開關關的路徑

    def conf_h(route):
        S['conf_hits'] += 1
        if S['conf'] == 'abort':
            return route.abort()
        route.fulfill(status=200, body=json.dumps(S['conf']), content_type='application/json')

    def punch_h(route):
        S['mini_hits'].append(json.loads(route.request.post_data or '{}'))
        if S['mini'] == 'abort':
            return route.abort()
        route.fulfill(status=200, body=json.dumps(S['mini']), content_type='text/plain')

    def after_h(route):
        S['after_hits'].append(json.loads(route.request.post_data or '{}'))
        route.fulfill(status=200, body=json.dumps(S['after']), content_type='text/plain')

    def g_h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') == 'liff_punch':
            S['g_posts'].append(b)
            return route.fulfill(status=200, body=json.dumps(S['g']), content_type='text/plain')
        if b.get('action') == 'liff_status':
            resp = route.fetch(); j = resp.json()
            if j.get('guard') is not None:
                nowms = int(time.time() * 1000)
                j['guard'] = {'blocked': 'in', 'lock': {}, 'last': {'type': 'in', 'hm': '08:00', 'ts': '2026-10-16T08:00:00+08:00'}, 'now': nowms}
            return route.fulfill(response=resp, body=json.dumps(j))
        route.continue_()

    p = ctx.new_page()
    p.add_init_script(LOG_JS)
    p.add_init_script(LAG_JS)
    p.route(G_URL + '/config', conf_h)
    p.route(G_URL + '/punch', punch_h)
    p.route(G_URL + '/after', after_h)
    p.route(re.compile(r'/api(/\w+)?$'), g_h)
    p.goto(u)
    p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
    p.wait_for_timeout(300)
    p.evaluate('(l) => { window.__lag = l; }', {'relay': mini_ms})
    return p, S


# ── 開頁加快（2026-11-16，Eason「點開到成功 5 秒內」）：開頁狀態同時問 mini 與 Google、櫃台不通改直連、開頁秒數 ──
ALT_URL = BASE + '/relay-mock-alt/clock'


def open_fast(ctx, hq, mini_st, conf='gw', pre_js='', wait_who=True, extra=''):
    """mini_st：dict＝mini 回的開頁狀態；'abort'＝連不上。conf：'gw'＝櫃台回正本名單；'alt'＝櫃台不通、直連回。"""
    S = {'st_hits': [], 'punch_hits': [], 'alt_punch': [], 'conf_gw': 0, 'conf_alt': 0, 'after_gw': 0, 'after_alt': 0}
    on = {'ok': True, 'v': 1, 'primary': ['hq'], 'wait_ms': 3000}

    def st_h(route):
        S['st_hits'].append(json.loads(route.request.post_data or '{}'))
        if mini_st == 'abort':
            return route.abort()
        route.fulfill(status=200, body=json.dumps(mini_st), content_type='text/plain')

    def conf_gw(route):
        S['conf_gw'] += 1
        if conf == 'alt':
            return route.abort()
        route.fulfill(status=200, body=json.dumps(on), content_type='application/json')

    def conf_alt(route):
        S['conf_alt'] += 1
        route.fulfill(status=200, body=json.dumps(on), content_type='application/json')

    def punch_gw(route):
        S['punch_hits'].append(json.loads(route.request.post_data or '{}'))
        route.fulfill(status=200, body=json.dumps(G_MINI_OK), content_type='text/plain')

    def punch_alt(route):
        S['alt_punch'].append(json.loads(route.request.post_data or '{}'))
        route.fulfill(status=200, body=json.dumps(G_MINI_OK), content_type='text/plain')

    p = ctx.new_page()
    p.add_init_script(LOG_JS)
    if pre_js:
        p.add_init_script(pre_js)
    p.route(G_URL + '/config', conf_gw)
    p.route(ALT_URL + '/config', conf_alt)
    p.route(G_URL + '/status', st_h)
    p.route(G_URL + '/punch', punch_gw)
    p.route(ALT_URL + '/punch', punch_alt)
    def after_h(route):
        S['after_alt' if 'relay-mock-alt' in route.request.url else 'after_gw'] += 1
        route.fulfill(status=200, body=json.dumps({'ok': True, 'state': 'done', 'extras': {}}), content_type='text/plain')
    p.route(re.compile(r'relay-mock-(g|alt)/clock/after$'), after_h)
    S['t0'] = time.time()
    p.goto(url(hq, extra='&keep_store=1&retry_ms=50&g_conf_ms=600&st_only=0&g_api=' + G_URL + '&g_alt=' + ALT_URL + extra))   # st_only=0 同上
    if wait_who:
        p.wait_for_function('document.getElementById("who").textContent === "測試一" && document.getElementById("btns").hidden === false', timeout=10000)   # 開頁狀態畫出來了（鍵亮不亮照防呆）
        S['ready_s'] = time.time() - S['t0']
    return p, S


COARSE_GEO_JS = """
// liffAtFirst：第一次要位置時，LINE 登入（initLiff 把 window.liff 掛上去）有沒有已經做完；先後順序用事件判斷、不靠毫秒大小
window.__geo2 = { calls: 0, clears: 0, firstCallAt: null, liffAtFirst: null, ok: null };
Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
  watchPosition: function (ok) { var g = window.__geo2; g.calls++; if (g.firstCallAt === null) { g.firstCallAt = performance.now(); g.liffAtFirst = typeof window.liff !== 'undefined'; } g.ok = ok; return g.calls; },
  clearWatch: function () { window.__geo2.clears++; }, getCurrentPosition: function () {}
} });
window.__geoPush = function (lat, lng, acc) { window.__geo2.ok({ timestamp: Date.now(), coords: { latitude: lat, longitude: lng, accuracy: acc } }); };
window.__bodies = [];   // 送出去的請求內容（看打卡那筆帶的是哪個位置）
(function () { const f0 = window.fetch; window.fetch = function (u, o) { try { const b = JSON.parse(o.body); b.__t = Date.now(); window.__bodies.push(b); } catch (e) {} return f0.apply(this, arguments); }; })();
"""


def phase_coarse(ctx):
    """定位先粗後精（2026-11-17）：第一筆位置誤差 ≤100 公尺、扣掉誤差後落在唯一一家店 → 不等到 ≤40 公尺就先讀狀態、放行按鍵。
    用假的定位（一筆一筆推進去）測；按鍵亮不亮可能被前面測試留下的 10 分鐘鎖影響，所以看「開頁狀態有沒有畫出來」（店名出現、不再是定位中）。"""
    opens = lambda p: p.evaluate('window.__open || []')
    n_status = lambda p: sum(1 for c in calls(p) if c.get('action') == 'liff_status')
    HQ_AT, JS_AT = (HQ['lat'], HQ['lng']), (JS['lat'], JS['lng'])
    MID = ((HQ['lat'] + JS['lat']) / 2, (HQ['lng'] + JS['lng']) / 2)   # 總部與金山正中間（各約 100 公尺）
    AWAY = (HQ['lat'] + 0.0030, HQ['lng'])                              # 總部北邊約 330 公尺

    errs = []

    def open_geo(extra='', pre=''):
        p = ctx.new_page(); p.add_init_script(LOG_JS); p.add_init_script(COARSE_GEO_JS)
        if pre:
            p.add_init_script(pre)
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.goto(BASE + '/clock-line.html?mock_uid=U1&api=/api' + extra)
        wait_msg(p, '定位中')
        return p

    def push(p, at, acc):
        p.evaluate('([a, b, c]) => window.__geoPush(a, b, c)', [at[0], at[1], acc])

    def shown(p, name, timeout=4000):
        try:
            p.wait_for_function('(n) => document.getElementById("storeName").textContent === n && document.getElementById("msg").textContent.indexOf("定位中") < 0 && document.getElementById("msg").textContent.indexOf("讀取中") < 0', arg=name, timeout=timeout)
            return True
        except Exception:
            return False

    still_waiting = lambda p: '定位中' in msg(p) and p.is_disabled('#btnIn') and p.is_disabled('#btnOut')

    # 1. 粗略位置（誤差 65 公尺）落在總部 → 馬上讀狀態，不等更準的
    p = open_geo(); t0 = time.time(); push(p, HQ_AT, 65)
    ok('先粗後精 1：誤差 65 公尺、在總部 → 不等更準的位置就畫出開頁狀態', shown(p, HQ['name']) and time.time() - t0 < 3, (msg(p), p.inner_text('#storeName')))
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    o = opens(p)[0]
    ok('先粗後精 1：開頁秒數記「靠粗略位置放行」、第一筆位置的秒數與誤差', o.get('outcome') == 'ready' and o.get('coarse') is True and o.get('fix1_acc') == 65 and isinstance(o.get('fix1_ms'), (int, float)) and o['fix1_ms'] <= o['ready_ms'] and o.get('accuracy_m') == 65, o)
    n1 = n_status(p)
    # 1b. 之後更準的位置回來、還是總部 → 什麼都不動（不重讀、不閃畫面）
    push(p, HQ_AT, 12); p.wait_for_timeout(600)
    ok('先粗後精 1b：校正後還是同一家店 → 不重讀狀態、畫面不變', n_status(p) == n1 and p.inner_text('#storeName') == HQ['name'] and len(opens(p)) == 1, (n_status(p), n1, opens(p)))
    p.close()

    # 2. 開關關掉（?coarse=0）→ 同一筆粗略位置不放行，等到 ≤40 公尺才讀
    p = open_geo('&coarse=0'); push(p, HQ_AT, 65); p.wait_for_timeout(900)
    ok('先粗後精 2：開關關掉 → 粗略位置不放行（照舊等更準的）', still_waiting(p) and n_status(p) == 0, (msg(p), calls(p)))
    push(p, HQ_AT, 20)
    ok('先粗後精 2：開關關掉 → 誤差 20 公尺才畫出狀態', shown(p, HQ['name']), msg(p))
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('先粗後精 2：開頁秒數不記粗略放行；第一筆位置仍記 65 公尺', opens(p)[0].get('coarse') is False and opens(p)[0].get('fix1_acc') == 65 and opens(p)[0].get('accuracy_m') == 20, opens(p)[0])
    p.close()

    # 3. 太粗（誤差 150 公尺，超過後端最多抵的 100 公尺）→ 不放行
    p = open_geo(); push(p, HQ_AT, 150); p.wait_for_timeout(900)
    ok('先粗後精 3：誤差 150 公尺 → 不放行', still_waiting(p) and n_status(p) == 0, msg(p))
    push(p, HQ_AT, 100)
    ok('先粗後精 3：剛好 100 公尺、在總部 → 放行', shown(p, HQ['name']), msg(p))
    p.close()

    # 4. 粗略位置不在任何店內 → 不放行、也不急著說「不在範圍」；更準的位置回來確認不在才說
    p = open_geo(); push(p, AWAY, 65); p.wait_for_timeout(900)
    ok('先粗後精 4：粗略位置在店外 → 還在「定位中」，沒有急著判「不在範圍」', still_waiting(p) and '不在任何打卡地點' not in msg(p), msg(p))
    push(p, AWAY, 15)
    wait_msg(p, '不在任何打卡地點範圍內')
    ok('先粗後精 4：更準的位置確認在店外 → 才說不在範圍、鍵不亮、沒有問後端', p.is_disabled('#btnIn') and p.is_visible('#btnRetry') and n_status(p) == 0, (msg(p), calls(p)))
    p.close()

    # 5. 粗略位置同時落在兩家店（總部與金山正中間、誤差 100）→ 分不出來，不放行；更準的位置回來才決定
    p = open_geo(); push(p, MID, 100); p.wait_for_timeout(900)
    ok('先粗後精 5：粗略位置分不出總部還是金山 → 不放行', still_waiting(p) and n_status(p) == 0, msg(p))
    push(p, JS_AT, 15)
    ok('先粗後精 5：更準的位置在金山 → 讀金山', shown(p, JS['name']) or '金山' in p.inner_text('#storeName'), (p.inner_text('#storeName'), msg(p)))
    p.close()

    # 6. 靠粗略位置放行後，更準的位置其實在店外 → 收回按鍵、改成不在範圍，另記一列「先亮又收回」
    p = open_geo(); push(p, HQ_AT, 90)
    ok('先粗後精 6：先放行（誤差 90）', shown(p, HQ['name']), msg(p))
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    push(p, AWAY, 12)
    wait_msg(p, '不在任何打卡地點範圍內')
    ok('先粗後精 6：更準的位置在店外 → 兩顆鍵都收回、可重新定位', p.is_disabled('#btnIn') and p.is_disabled('#btnOut') and p.is_visible('#btnRetry'), msg(p))
    p.wait_for_function('(window.__open || []).length >= 2', timeout=4000)
    o2 = opens(p)
    ok('先粗後精 6：多記一列 fail／coarse_back（只記一次）', [o2[1].get('outcome'), o2[1].get('status')] == ['fail', 'coarse_back'] and len(o2) == 2, o2)
    push(p, AWAY, 10); p.wait_for_timeout(400)
    ok('先粗後精 6：之後再來位置不會重複記', len(opens(p)) == 2, opens(p))
    p.close()

    # 7. 靠粗略位置放行後，更準的位置是另一家店（金山）→ 改讀金山
    p = open_geo(); push(p, MID, 60)   # 正中間、誤差 60：扣掉後離兩家各 40 公尺 → 兩家都符合？總部半徑 50、金山 50 → 兩家都中，分不出來
    p.wait_for_timeout(600)
    ok('先粗後精 7 前提：正中間誤差 60 也分不出來 → 不放行', still_waiting(p), msg(p))
    p.close()
    NEAR_HQ = (HQ['lat'] + (JS['lat'] - HQ['lat']) * 0.15, HQ['lng'] + (JS['lng'] - HQ['lng']) * 0.15)   # 離總部約 30 公尺、離金山約 170 公尺
    p = open_geo(); push(p, NEAR_HQ, 60)
    ok('先粗後精 7：靠近總部、誤差 60 → 只中總部，先放行', shown(p, HQ['name']), (p.inner_text('#storeName'), msg(p)))
    push(p, JS_AT, 10)
    ok('先粗後精 7：更準的位置在金山 → 改讀金山', shown(p, JS['name']), (p.inner_text('#storeName'), msg(p)))
    p.close()

    # 8. 靠粗略位置放行後一直沒有更準的 → 滿等待上限也不動（照舊用手上那筆）
    p = open_geo('&geo_soft_ms=1200'); push(p, HQ_AT, 70)
    ok('先粗後精 8：先放行（誤差 70）', shown(p, HQ['name']), msg(p))
    n8 = n_status(p); p.wait_for_timeout(1800)
    ok('先粗後精 8：滿等待上限、沒有更準的 → 不重讀、畫面不變', n_status(p) == n8 and p.inner_text('#storeName') == HQ['name'], (n_status(p), n8, msg(p)))
    p.close()

    # 9. 定位提前：LINE 登入還沒好就開始抓位置；關掉開關就等登入完
    p = open_geo(); push(p, HQ_AT, 10); shown(p, HQ['name'])
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    g = p.evaluate('window.__geo2'); o = opens(p)[0]
    # 原意：開始抓位置要「不晚於」LINE 登入完成。兩個數字來自同一個 performance.now()，但 liff_ms 是頁面四捨五入成整數毫秒才回報的、
    # firstCallAt 是原始小數，直接比 < 會把「10.2 對 round(10.4)=10」誤判成晚了（本機 mock 的登入是立刻完成，兩者常差不到 1 毫秒）。
    # 所以：時間用同樣四捨五入後比「不晚於」（≤），先後順序另用事件證明（第一次抓位置時 window.liff 還沒掛上＝登入還沒做完），開關關掉時則相反。
    ok('定位提前 9：開始抓位置不晚於 LINE 登入完成（%.1f ≤ %d 毫秒，且抓位置時登入還沒完成），整個開頁只抓一輪' % (g['firstCallAt'], o['liff_ms']),
       round(g['firstCallAt']) <= o['liff_ms'] and g['liffAtFirst'] is False and g['calls'] == 1, (g, o))
    p.close()
    p = open_geo('&geo_early=0'); push(p, HQ_AT, 10); shown(p, HQ['name'])
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    g = p.evaluate('window.__geo2'); o = opens(p)[0]
    ok('定位提前 9：開關關掉 → 登入完才開始抓（%.1f ≥ %d 毫秒，且抓位置時登入已完成）' % (g['firstCallAt'], o['liff_ms']),
       round(g['firstCallAt']) >= o['liff_ms'] and g['liffAtFirst'] is True and g['calls'] == 1, (g, o))
    p.close()

    # 10. 不是從 LINE 打開（登入不成）→ 提前開的定位要停掉；申請頁、QR 不抓位置
    p = ctx.new_page(); p.add_init_script(LOG_JS); p.add_init_script(COARSE_GEO_JS)
    p.route('**/liff/edge/**', lambda r: r.abort())   # LINE 的元件載不到＝不是從 LINE 打開
    p.goto(BASE + '/clock-line.html?api=/api')
    wait_msg(p, '請從 LINE 官方帳號', timeout=10000)
    g = p.evaluate('window.__geo2')
    ok('定位提前 10：不是從 LINE 打開 → 提前開的定位已停掉', g['calls'] == 1 and g['clears'] >= 1, g)
    p.close()
    p = ctx.new_page(); p.add_init_script(LOG_JS); p.add_init_script(COARSE_GEO_JS)
    p.goto(BASE + '/clock-line.html?mock_uid=U1&api=/api&view=req')
    p.wait_for_selector('#reqView', state='visible', timeout=10000); p.wait_for_timeout(300)
    ok('定位提前 10：申請頁不抓位置', p.evaluate('window.__geo2.calls') == 0, p.evaluate('window.__geo2'))
    p.close()

    # ── 放行之後按打卡（Fable 審查 2026-11-17）：真的送出一張卡的時機要跟改之前一樣——有合格位置，或等滿原本的上限 ──
    punches = lambda p: [b for b in p.evaluate('window.__bodies') if b.get('action') == 'liff_punch']

    def press_out(p):   # 鍵可能被前面測試留下的 10 分鐘鎖停用：同一個 tick 解開並點下去（後端收不收不是這裡要看的，看送出的內容）
        p.evaluate('() => { window.confirm = () => true; const sub = () => { const m = document.getElementById("pgMask"); if (m && !m.hidden) document.getElementById("pgSub").click(); }; const b = document.getElementById("btnOut"); b.disabled = false; b.click(); sub(); }')

    # 11. 粗略放行後馬上按 → 先不送，等更準的位置回來才送，送的是準的那筆
    p = open_geo(); push(p, HQ_AT, 65); shown(p, HQ['name']); press_out(p)
    wait_msg(p, '確認目前位置中'); p.wait_for_timeout(500)
    ok('先粗後精 11：粗略放行後馬上按 → 還沒核對完，不送打卡', punches(p) == [] and p.is_disabled('#btnIn') and p.is_disabled('#btnOut'), (msg(p), punches(p)))
    push(p, HQ_AT, 12)
    p.wait_for_function('window.__bodies.some(b => b.action === "liff_punch")', timeout=5000)
    b = punches(p)[0]
    ok('先粗後精 11：更準的位置回來 → 才送，帶的是準的那筆（誤差 12）', b.get('accuracy') == 12 and abs(b.get('lat') - HQ['lat']) < 1e-9 and b.get('type') == 'out' and len(punches(p)) == 1, b)
    p.close()

    # 12. 粗略放行後按了，更準的位置其實在店外 → 不送
    p = open_geo(); push(p, HQ_AT, 90); shown(p, HQ['name']); press_out(p)
    wait_msg(p, '確認目前位置中'); push(p, AWAY, 12)
    wait_msg(p, '不在任何打卡地點範圍內')
    p.wait_for_timeout(500)
    ok('先粗後精 12：按了之後校正出來在店外 → 沒有送打卡、畫面說不在範圍、鍵不亮', punches(p) == [] and p.is_disabled('#btnIn') and p.is_disabled('#btnOut'), (msg(p), punches(p)))
    p.close()

    # 13. 粗略放行後按了，一直沒有更準的 → 等滿原本的上限才送（跟改之前「滿 8 秒就用手上那筆」一樣；測試把上限縮成 1.5 秒）
    p = open_geo('&geo_soft_ms=1500'); t_open = time.time(); push(p, HQ_AT, 65); shown(p, HQ['name']); press_out(p)
    p.wait_for_timeout(500)
    ok('先粗後精 13：上限還沒到 → 不送', punches(p) == [], punches(p))
    p.wait_for_function('window.__bodies.some(b => b.action === "liff_punch")', timeout=5000)
    ok('先粗後精 13：滿上限才送（開頁後 %.1f 秒），帶手上那筆（誤差 65）' % (time.time() - t_open), time.time() - t_open >= 1.4 and punches(p)[0].get('accuracy') == 65, punches(p))
    p.close()

    # 14. 已經有合格位置才按 → 不用等，直接送（沒有變慢）
    p = open_geo(); push(p, HQ_AT, 65); shown(p, HQ['name']); push(p, HQ_AT, 15); p.wait_for_timeout(200)
    t1 = time.time(); press_out(p)
    p.wait_for_function('window.__bodies.some(b => b.action === "liff_punch")', timeout=3000)
    ok('先粗後精 14：核對完才按 → 立刻送（%.2f 秒），帶誤差 15 那筆' % (time.time() - t1), time.time() - t1 < 1.0 and punches(p)[0].get('accuracy') == 15, punches(p))
    p.close()

    # 15. 狀態還在讀的時候就校正出來不在店內 → 晚回來的那份狀態不准把按鍵亮回來
    p = open_geo(pre='window.__delay = {liff_status: 1500};'); push(p, HQ_AT, 65); p.wait_for_timeout(150); push(p, AWAY, 12)
    wait_msg(p, '不在任何打卡地點範圍內')
    p.wait_for_timeout(2200)   # 總部那份狀態這時已經回來了
    ok('先粗後精 15：晚到的狀態沒有蓋掉「不在範圍」：鍵仍不亮、沒有顯示成可以打卡', p.is_disabled('#btnIn') and p.is_disabled('#btnOut') and '不在任何打卡地點範圍內' in msg(p), (msg(p), p.inner_text('#storeName')))
    p.close()
    # 15b. 校正出來是另一家店，舊店那份狀態晚到 → 畫面留在新的那家
    p = open_geo(pre='window.__delay = {liff_status: 1500};'); push(p, NEAR_HQ, 60); p.wait_for_timeout(150); push(p, JS_AT, 10)
    shown(p, JS['name'], timeout=6000); p.wait_for_timeout(2000)
    ok('先粗後精 15b：舊店的狀態晚到 → 畫面仍是金山', p.inner_text('#storeName') == JS['name'], (p.inner_text('#storeName'), msg(p)))
    p.close()

    # 16. 粗略放行後讀狀態失敗、按「重新定位」開第二輪 → 上一輪殘留的計時器不准闖進來（不多讀、不出錯）
    p = open_geo('&geo_soft_ms=1500&retry_ms=50', pre="window.__fake = {liff_status: 'abort'};"); push(p, HQ_AT, 65)
    p.wait_for_selector('#btnRetry', state='visible', timeout=8000)
    p.evaluate("window.__fake = {}"); n16 = n_status(p)
    p.click('#btnRetry'); wait_msg(p, '定位中'); p.wait_for_timeout(1900)   # 上一輪的上限（1.5 秒）這時已經過了
    ok('先粗後精 16：第二輪還沒有位置 → 仍在定位中、沒有多讀狀態', still_waiting(p) and n_status(p) == n16, (msg(p), n_status(p), n16))
    push(p, HQ_AT, 10)
    ok('先粗後精 16：第二輪位置回來 → 正常讀狀態', shown(p, HQ['name']), msg(p))
    p.close()

    # 17. 位置過了 30 秒才按（手機停止更新）→ 照舊先重新定位，不因為先粗後精被跳過
    p = open_geo('&refix_ms=1500'); push(p, HQ_AT, 12); shown(p, HQ['name'])
    p.evaluate('() => { const g = window.__geo2; const ok0 = g.ok; window.__geoPush = function (a, b, c) { g.ok({ timestamp: Date.now(), coords: { latitude: a, longitude: b, accuracy: c } }); }; }')
    calls0 = p.evaluate('window.__geo2.calls')
    p.evaluate('() => { const RealNow = Date.now; Date.now = () => RealNow() + 40000; }')   # 手上那筆變成 40 秒前的
    press_out(p); wait_msg(p, '確認目前位置中'); p.wait_for_timeout(300)
    ok('先粗後精 17：位置過時 → 按下先重新定位（多抓一輪）、還沒送', p.evaluate('window.__geo2.calls') == calls0 + 1 and punches(p) == [], (p.evaluate('window.__geo2'), punches(p)))
    p.close()

    ok('先粗後精：以上各情境頁面沒有程式錯誤', errs == [], errs)


def phase_open(ctx, hq):
    import urllib.request
    req = urllib.request.Request(BASE + '/api/hq', data=json.dumps({'action': 'liff_status', 'id_token': 'MOCK_ID_TOKEN_U1'}).encode(), headers={'Content-Type': 'text/plain'})
    real = json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    ok('開頁 0：假後端的開頁狀態是 ready（測試前提）', real.get('status') == 'ready', real)
    mini = dict(real, role='primary', notices=[])
    opens = lambda p: p.evaluate('window.__open || []')

    # 1. mini 馬上回、Google 慢 2.5 秒：按鍵 1.5 秒內亮；Google 回來後比對一樣、送一列開頁秒數
    p, S = open_fast(ctx, hq, mini, pre_js='window.__delay = {liff_status: 2500};')
    ok('開頁 1：Google 慢 2.5 秒，mini 先回 → 1.5 秒內畫出開頁狀態（%.2f 秒）' % S['ready_s'], S['ready_s'] < 1.5, S['ready_s'])
    ok('開頁 1：畫面沒有寫「重試中」「連線」', '重試' not in msg(p) and '連線' not in p.inner_text('#hint'), (msg(p), p.inner_text('#hint')))
    ok('開頁 1：問 mini 的內容：店碼＋身分', S['st_hits'] and S['st_hits'][0].get('store') == 'hq' and S['st_hits'][0].get('id_token') == 'MOCK_ID_TOKEN_U1', S['st_hits'])
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    o = opens(p)[0]
    ok('開頁 1：開頁秒數一列：ready、mini 先回、兩邊一樣、走櫃台', [o.get('kind'), o.get('outcome'), o.get('st_src'), o.get('st_match'), o.get('via')] == ['open', 'ready', 'mini', 'same', 'gw'], o)
    ok('開頁 1：各段毫秒數都有、順序合理', all(isinstance(o.get(k), (int, float)) for k in ('liff_ms', 'geo_ms', 'st_ms', 'ready_ms', 'g_ms', 'mini_ms')) and max(o['liff_ms'], o['geo_ms']) <= o['st_ms'] <= o['ready_ms'] and o['mini_ms'] < o['g_ms'], o)   # 2026-11-17 定位提前到與 LINE 登入同時：geo_ms 可以比 liff_ms 小，改成兩者都要在讀到狀態之前
    p.wait_for_timeout(300)
    ok('開頁 1：只送一列', len(opens(p)) == 1, opens(p))
    p.close()

    # 2. 同一支手機第二次開：上次那家店記住了，定位時就先讀（pre＝true）
    p, S = open_fast(ctx, hq, mini, pre_js='window.__delay = {liff_status: 800};')
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 2：第二次開頁趁定位先讀上次那家店', opens(p)[0].get('pre') is True, opens(p)[0])
    ok('開頁 2：開頁狀態只問 mini 一次', len(S['st_hits']) == 1, S['st_hits'])
    # 按下打卡：送櫃台那條的 mini；秒數列帶開頁秒數
    force_out(p)
    wait_msg(p, '下班打卡成功 09:01', timeout=3000)
    p.wait_for_function('(window.__timing || []).length >= 1', timeout=8000)
    t = p.evaluate('window.__timing[0]')
    ok('開頁 2：打卡走櫃台那條', len(S['punch_hits']) == 1 and len(S['alt_punch']) == 0, (S['punch_hits'], S['alt_punch']))
    ok('開頁 2：打卡秒數列帶 open_ready_ms、press_ms、st_src', isinstance(t.get('open_ready_ms'), (int, float)) and t.get('press_ms') >= t.get('open_ready_ms') and t.get('st_src') == 'mini', t)
    p.close()

    # 3. mini 說不是正本（role off）→ 用 Google 那份
    p, S = open_fast(ctx, hq, {'ok': False, 'role': 'off'})
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 3：mini 不是正本 → 用 Google 的', opens(p)[0].get('st_src') == 'google', opens(p)[0])
    p.close()

    # 4. mini 連不上 → 用 Google 那份，畫面照常
    p, S = open_fast(ctx, hq, 'abort')
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 4：mini 連不上 → 用 Google 的、按鍵照亮', opens(p)[0].get('st_src') == 'google' and opens(p)[0].get('outcome') == 'ready', opens(p)[0])
    p.close()

    # 5. mini 說沒綁定 → 不採用，等 Google（綁定流程照舊由 Google／光復處理）
    p, S = open_fast(ctx, hq, {'ok': False, 'error': 'not_bound', 'role': 'primary'})
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 5：mini 回沒綁定 → 不採用，照 Google 的', opens(p)[0].get('st_src') == 'google', opens(p)[0])
    p.close()

    # 6. Google 完全讀不到、mini 有回 → 照 mini 的亮鍵，不出現「連線失敗」
    p, S = open_fast(ctx, hq, mini, pre_js="window.__fake = window.__fake || {}; window.__fake.liff_status = 'abort';", extra='&read_timeout=300')
    p.wait_for_timeout(1200)
    ok('開頁 6：Google 讀不到、mini 有回 → 按鍵亮、沒有「連線失敗」', '連線失敗' not in msg(p) and not p.evaluate('document.getElementById("btnRetry").hidden === false'), msg(p))
    p.close()

    # 7. 兩邊都讀不到 → 連線失敗，送一列 fail
    p, S = open_fast(ctx, hq, 'abort', pre_js="window.__fake = window.__fake || {}; window.__fake.liff_status = 'abort';", wait_who=False, extra='&read_timeout=300')
    wait_msg(p, '連線失敗', timeout=8000)
    p.wait_for_function('(window.__open || []).length >= 1', timeout=4000)
    ok('開頁 7：兩邊都讀不到 → 連線失敗、開頁秒數記 fail／status_fail', [opens(p)[0].get('outcome'), opens(p)[0].get('status')] == ['fail', 'status_fail'], opens(p)[0])
    p.close()

    # 8. Google 有 mini 還沒有的卡（主管 QR、別支手機剛打）→ Google 回來後改照 Google 的鎖鍵
    stale = dict(mini, today=[], guard={'blocked': None, 'lock': {}, 'last': None, 'now': int(time.time() * 1000)})
    newer = {'blocked': 'out', 'lock': {}, 'last': {'type': 'out', 'hm': '08:00', 'ts': '2099-01-01T08:00:00+08:00'}, 'now': int(time.time() * 1000)}
    fake = dict(real, guard=newer)
    p, S = open_fast(ctx, hq, stale, pre_js='window.__delay = {liff_status: 1200}; window.__fake = window.__fake || {}; window.__fake.liff_status = ' + json.dumps(fake) + ';')
    ok('開頁 8：先照 mini 亮下班鍵', p.evaluate('!document.getElementById("btnOut").disabled'))
    p.wait_for_function('document.getElementById("btnOut").disabled', timeout=6000)
    p.wait_for_function('(window.__open || []).length >= 1', timeout=6000)
    ok('開頁 8：Google 有較新的卡 → 改照 Google 鎖下班鍵、記 diff', opens(p)[0].get('st_match') == 'diff', opens(p)[0])
    p.close()

    # 9. 櫃台不通 → 改走直連：正本名單從直連問到、打卡送直連
    p, S = open_fast(ctx, hq, 'abort', conf='alt')
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    p.wait_for_timeout(900)
    force_out(p)
    wait_msg(p, '下班打卡成功 09:01', timeout=3000)
    ok('開頁 9：櫃台不通 → 問了直連、打卡送直連那條', S['conf_gw'] >= 1 and S['conf_alt'] == 1 and len(S['alt_punch']) == 1 and len(S['punch_hits']) == 0, S)
    p.close()

    # 10.（Fable 審查 高 1）mini 先回 → 馬上打卡成功 → Google 的開頁狀態 3.5 秒後才回：不准把成功畫面、10 分鐘鎖蓋回開頁時的樣子
    fresh = dict(mini, today=[{'type': 'in', 'hm': '08:00', 'status': 'ok', 'sys': False}],
                 guard={'blocked': 'in', 'lock': {}, 'last': {'type': 'in', 'hm': '08:00', 'ts': '2026-10-16T08:00:00+08:00'}, 'now': int(time.time() * 1000)})
    gsame = dict(real, today=fresh['today'], guard=fresh['guard'])
    p, S = open_fast(ctx, hq, fresh, pre_js='window.__delay = {liff_status: 3500}; window.__fake = window.__fake || {}; window.__fake.liff_status = ' + json.dumps(gsame) + ';')
    p.evaluate('() => { window.confirm = () => true; const sub = () => { const m = document.getElementById("pgMask"); if (m && !m.hidden) document.getElementById("pgSub").click(); }; document.getElementById("btnOut").click(); sub(); }')
    wait_msg(p, '下班打卡成功 09:01', timeout=3000)
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)   # Google 那份回來了
    p.wait_for_timeout(400)
    ok('開頁 10：打完卡後 Google 的開頁狀態才回來 → 成功訊息還在、兩顆鍵仍鎖著、今天有這張下班卡',
       '下班打卡成功' in msg(p) and p.is_disabled('#btnOut') and p.is_disabled('#btnIn') and '下班 09:01' in p.inner_text('#today'), (msg(p), p.inner_text('#today')))
    ok('開頁 10：比對用的是開頁那一刻的內容（兩邊一樣記 same，不被打卡後的畫面影響）', opens(p)[0].get('st_match') == 'same', opens(p)[0])
    ok('開頁 10：補提示也走櫃台那條（/punch 與 /after 同一條路）', S['after_gw'] >= 1 and S['after_alt'] == 0, S)
    p.close()

    # 11.（審查 中 2）mini 先回 ready、Google 之後明確說沒綁定（剛被解除綁定，mini 還沒拉到）→ 收回按鍵
    p, S = open_fast(ctx, hq, stale, pre_js="window.__delay = {liff_status: 1000}; window.__fake = window.__fake || {}; window.__fake.liff_status = {ok: false, error: 'not_bound'};")
    ok('開頁 11：先照 mini 亮鍵', p.evaluate('!document.getElementById("btnOut").disabled'))
    p.wait_for_function('document.getElementById("btnOut").disabled && document.getElementById("btnIn").disabled', timeout=6000)
    ok('開頁 11：Google 說沒綁定 → 兩顆鍵收回', True)
    p.close()

    # 12.（審查 中 3）手機記的是別家店、人在總部 → 先讀的那份不用，畫面與打卡都是總部
    p, S = open_fast(ctx, hq, mini, pre_js="localStorage.setItem('mala_clock_last_store_v1', JSON.stringify({sub: 'U1', code: 'mztjs'})); window.__delay = {liff_status: 600};")
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 12：記的是金山、人在總部 → 畫面是總部、沒有用先讀的那份', HQ['name'] in p.inner_text('#storeName') and opens(p)[0].get('pre') is False, (p.inner_text('#storeName'), opens(p)[0]))
    ok('開頁 12：問 mini 兩次（先讀金山、定位後問總部），畫面採用的是總部那份', [h.get('store') for h in S['st_hits']] == ['mztjs', 'hq'], S['st_hits'])
    force_out(p)
    wait_msg(p, '下班打卡成功 09:01', timeout=3000)
    ok('開頁 12：打卡送的是總部', len(S['punch_hits']) == 1 and S['punch_hits'][0].get('store') == 'hq', S['punch_hits'])
    p.close()

    # 13.（審查 中 3）手機記的是別人的 LINE（換帳號、兩個人共用手機）→ 不先讀
    p, S = open_fast(ctx, hq, mini, pre_js="localStorage.setItem('mala_clock_last_store_v1', JSON.stringify({sub: 'SOMEONE_ELSE', code: 'hq'}));")
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    ok('開頁 13：記的是別人的 LINE → 不先讀（只在定位後問一次、pre＝false）', len(S['st_hits']) == 1 and opens(p)[0].get('pre') is False, (S['st_hits'], opens(p)[0]))
    p.close()

    # 14.（審查 低 5）不在任何一家店 → 開頁秒數記 fail，店碼送 "-"（不混進光復）
    p, S = open_fast(ctx, (hq[0] + 1.0, hq[1] + 1.0), mini, wait_who=False)
    p.wait_for_function('(window.__open || []).length >= 1', timeout=8000)
    o = opens(p)[0]
    ok('開頁 14：不在範圍 → 記 fail、店碼 "-"', o.get('outcome') == 'fail' and o.get('store') == '-' and str(o.get('status', '')).startswith('pick_'), o)
    p.close()


def phase_g(ctx, hq):
    """G＋備援：mini 正本的店。斷言畫面、送了哪幾份、單號、timing 的 route。"""
    RID = re.compile(r'^r[0-9a-f]{16}$')
    on = {'ok': True, 'v': 1, 'primary': ['hq'], 'wait_ms': 3000}
    # 1. mini 300ms 回成功：1 秒內顯示、不送 Google、抄完補提示再代送「打卡」
    p, S = g_open(ctx, hq, on, G_MINI_OK, mini_ms=300, after={'ok': True, 'state': 'done', 'extras': {'req_notes': ['你的加班申請已核准'], 'ot_hint': None}})
    t0 = time.time()
    force_out(p)
    wait_msg(p, '下班打卡成功 09:01', timeout=1500)
    dt = time.time() - t0
    ok('G 1：mini 300ms 回成功 → 1 秒內顯示（%.2f 秒）' % dt, dt < 1.3, dt)
    m = msg(p)
    ok('G 1：顯示 mini 的時間、地點、問候語', '地點：' + HQ['name'] in m and G_MINI_OK['greeting'] in m, m)
    p.wait_for_function('document.getElementById("msg").textContent.indexOf("你的加班申請已核准") >= 0', timeout=8000)
    ok('G 1：抄到 Google 後補上申請結果通知', '你的加班申請已核准' in msg(p), msg(p))
    ok('G 1：沒有送 Google liff_punch、mini 收到 1 份', len(S['g_posts']) == 0 and len(S['mini_hits']) == 1, (S['g_posts'], S['mini_hits']))
    mh = S['mini_hits'][0]
    ok('G 1：送 mini 的內容：店碼、類型、定位、單號', mh.get('store') == 'hq' and mh.get('type') == 'out' and 'lat' in mh and RID.match(mh.get('req_id', '')), mh)
    ok('G 1：補提示用同一張單號問', S['after_hits'] and S['after_hits'][0].get('req_id') == mh['req_id'], S['after_hits'])
    tm = relay_last(p)
    ok('G 1：timing route=mini、outcome=ok、req_id 一樣', tm['route'] == 'mini' and tm['outcome'] == 'ok' and tm['req_id'] == mh['req_id'], tm)
    ok('G 1：開頁有問 mini 正本名單', S['conf_hits'] >= 1, S['conf_hits'])
    p.close()

    # 2. mini 超過 3 秒沒回：改送 Google、帶同一張單號
    p, S = g_open(ctx, hq, on, G_MINI_OK, mini_ms=4500)
    force_out(p)
    m = None
    p.wait_for_timeout(2500)
    ok('G 2：3 秒內還沒改送 Google', len(S['g_posts']) == 0, S['g_posts'])
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    ok('G 2：改送 Google 1 份，單號跟送 mini 的一樣', len(S['g_posts']) == 1 and S['g_posts'][0].get('req_id') == S['mini_hits'][0].get('req_id'), (S['g_posts'], S['mini_hits']))
    tm = relay_last(p)
    ok('G 2：timing route=mini_fallback', tm['route'] == 'mini_fallback', tm)
    p.close()

    # 3. mini 說「改送 Google」（例如引擎判不了）：馬上送 Google
    p, S = g_open(ctx, hq, on, {'ok': False, 'role': 'fallback'})
    t0 = time.time()
    force_out(p)
    wait_msg(p, '下班打卡成功 09:02', timeout=4000)
    ok('G 3：mini 回改送 → 馬上送 Google（%.2f 秒）' % (time.time() - t0), len(S['g_posts']) == 1 and RID.match(S['g_posts'][0].get('req_id', '')), S['g_posts'])
    p.close()

    # 4. mini 連不上（開頁問不到名單）：跟今天一模一樣——直送 Google、不帶單號、不送 mini
    p, S = g_open(ctx, hq, 'abort', G_MINI_OK)
    force_out(p)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    ok('G 4：問不到 mini → 直送 Google、不帶單號、mini 沒收到', len(S['g_posts']) == 1 and 'req_id' not in S['g_posts'][0] and len(S['mini_hits']) == 0, (S['g_posts'], S['mini_hits']))
    p.close()

    # 5. mini 的名單沒有這家店：跟今天一樣
    p, S = g_open(ctx, hq, {'ok': True, 'v': 1, 'primary': ['gf'], 'wait_ms': 3000}, G_MINI_OK)
    force_out(p)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    ok('G 5：這家店不在名單 → 直送 Google、不帶單號', len(S['g_posts']) == 1 and 'req_id' not in S['g_posts'][0] and len(S['mini_hits']) == 0, S['g_posts'])
    p.close()

    # 6. mini 擋下（正本說不收）：顯示原因，不送 Google
    p, S = g_open(ctx, hq, on, {'ok': False, 'role': 'primary', 'type': 'out', 'status': 'rejected_out_of_range', 'reason': '店家判定你不在範圍內', 'hint': '請開啟「精確位置」與 Wi‑Fi 後再按一次'})
    force_out(p)
    wait_msg(p, '下班打卡失敗', timeout=4000)
    ok('G 6：mini 擋下 → 失敗原因照顯示、不送 Google', '原因：店家判定你不在範圍內' in msg(p) and len(S['g_posts']) == 0, (msg(p), S['g_posts']))
    p.close()

    # 7. 下班超時提示（抄到 Google 後才算得出）：顯示「申請加班」
    p, S = g_open(ctx, hq, on, G_MINI_OK, after={'ok': True, 'state': 'done', 'extras': {'req_notes': [], 'ot_hint': {'date': '2026-10-16', 'hours': 9.5, 'start': '17:00', 'end': '18:30'}}})
    force_out(p)
    p.wait_for_function('!document.getElementById("btnOtReq").hidden', timeout=8000)
    ok('G 7：補上超時提示與申請加班鍵', '超過 8 小時' in p.inner_text('#otHint'), p.inner_text('#otHint'))
    p.close()


def phase_relay(ctx, hq):
    """快速通道：mini 預判先顯示成功、Google 回來後採用或更正。每項斷言畫面文字與 window.__timing 最後一筆。"""
    RID = re.compile(r'^r[0-9a-f]{16}$')

    def msg_at(p, ms):
        p.wait_for_timeout(ms)
        return msg(p)

    # 1. mini 300ms 回 ok、Google 3 秒後成功
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, mini_ms=300, g_ms=3000)
    t0 = time.time()
    force_out(p)
    wait_msg(p, '下班打卡成功', timeout=1000)
    dt = time.time() - t0
    m = msg(p)
    ok('快速通道 1：mini 300ms 回 ok → 1 秒內先顯示成功（%.2f 秒）' % dt, dt < 1.3 and '下班打卡成功 09:01' in m, (dt, m))
    ok('快速通道 1：先顯示的是 mini 的時間、地點、問候語', '地點：' + HQ['name'] in m and MINI_OK['greeting'] in m and '正在寫入紀錄' in m, m)
    wait_msg(p, '09:02', timeout=6000)
    m = msg(p)
    ok('快速通道 1：Google 回來後畫面換成 Google 的時間', '下班打卡成功 09:02' in m and '09:01' not in m, m)
    ok('快速通道 1：Google 回來後問候語仍是 mini 那句、不換句', MINI_OK['greeting'] in m and G_OK['greeting'] not in m, m)
    tm = relay_last(p)
    ok('快速通道 1：timing route=predicted、predict=ok、outcome=ok', tm['route'] == 'predicted' and tm['predict'] == 'ok' and tm['outcome'] == 'ok', tm)
    ok('快速通道 1：total_ms 算到 Google 結果（≥ 2900）、server_ms 是 Google 那趟、predict_ms 有值',
       tm['total_ms'] >= 2900 and tm['server_ms'] >= 2500 and isinstance(tm['predict_ms'], int) and 250 <= tm['predict_ms'] < 1500, tm)
    ok('快速通道 1：req_id 格式 r＋16 位小寫 hex', RID.match(str(tm['req_id'])) is not None, tm['req_id'])
    ik = p.evaluate('window.__inits')
    ok('快速通道 1：liff_punch 那次 fetch 帶 keepalive:true（看到成功就關畫面也送得完）', [x for x in ik if x['action'] == 'liff_punch'] and all(x['keepalive'] is True for x in ik if x['action'] == 'liff_punch'), ik)
    ok('快速通道 1：只送 1 份 Google liff_punch、1 份 mini', len(S['g_posts']) == 1 and len(S['mini_hits']) == 1, (S['g_posts'], S['mini_hits']))
    # 2. 同時送出、同一個 req_id
    c = calls(p)
    cg = [x for x in c if x['action'] == 'liff_punch']
    cm = [x for x in c if x['url'].endswith('/relay-mock')]
    ok('快速通道 2：Google 與 mini 兩個請求送出時間差 < 250ms', len(cg) == 1 and len(cm) == 1 and abs(cg[0]['t'] - cm[0]['t']) < 250,
       (cg, cm))
    ok('快速通道 2：mini 的 body 帶的 req_id 就是 timing 回報的那個', S['mini_hits'][0].get('req_id') == tm['req_id'] and RID.match(S['mini_hits'][0].get('req_id', '')), S['mini_hits'])
    ok('快速通道 2：mini body 帶店碼、類型、定位，不帶 qr', S['mini_hits'][0].get('store') == 'hq' and S['mini_hits'][0].get('type') == 'out'
       and 'lat' in S['mini_hits'][0] and 'lng' in S['mini_hits'][0] and 'qr' not in S['mini_hits'][0], S['mini_hits'])
    ok('快速通道 2：Google 的 liff_punch 是唯一寫入者（action、type 照舊）', S['g_posts'][0]['action'] == 'liff_punch' and S['g_posts'][0]['type'] == 'out', S['g_posts'])
    p.close()

    # 3. Google 擋下
    gfail = {'ok': False, 'type': 'out', 'status': 'rejected_out_of_range', 'reason': '店家判定你不在範圍內', 'hint': '請開啟「精確位置」與 Wi‑Fi 後再按一次'}
    p, S = relay_open(ctx, hq, MINI_OK, gfail, mini_ms=300, g_ms=2000)
    force_out(p)
    wait_msg(p, '下班打卡成功 09:01', timeout=1500)
    wait_msg(p, '下班打卡失敗', timeout=6000)
    m = msg(p)
    ok('快速通道 3：Google 擋下 → 最後是失敗、有原因與怎麼辦、不殘留成功字樣', '打卡成功' not in m and '原因：店家判定你不在範圍內' in m and '怎麼辦：請開啟' in m, m)
    ok('快速通道 3：失敗訊息以「剛才顯示成功有誤。」開頭', m.startswith('剛才顯示成功有誤。'), m[:60])
    tm = relay_last(p)
    ok('快速通道 3：timing outcome=fail、route=predicted、predict=ok', tm['outcome'] == 'fail' and tm['route'] == 'predicted' and tm['predict'] == 'ok', tm)
    p.close()

    # 4. Google 連不上（route.abort）→ 回頭確認
    for label, gst, check in [
            ('查得到那張卡', 'found', lambda m: '下班打卡成功 18:00' in m and '剛才那筆已經進去了' in m and '有誤' not in m),
            ('查不到（今天筆數沒變）', None, lambda m: '剛才顯示成功有誤，這次下班卡沒有送出' in m),
            ('liff_status 也失敗', 'abort', lambda m: '下班打卡成功 09:01' in m and '出勤紀錄' in m and '告知主管補登' in m and '會用 LINE 通知你' not in m)]:
        p, S = relay_open(ctx, hq, MINI_OK, 'abort', mini_ms=300, g_ms=1200, gstatus=gst)
        force_out(p)
        wait_msg(p, '下班打卡成功 09:01', timeout=1000)
        tm = relay_last(p, timeout=15000)
        p.wait_for_timeout(200)
        m = msg(p)
        ok('快速通道 4（Google 連不上、回頭確認%s）：畫面文字' % label, check(m), m)
        want = {'found': 'unclear_ok', None: 'unclear_not', 'abort': 'unclear_unknown'}[gst]
        ok('快速通道 4（%s）：timing outcome=%s、route=predicted、predict=ok' % (label, want),
           tm['outcome'] == want and tm['route'] == 'predicted' and tm['predict'] == 'ok', tm)
        ok('快速通道 4（%s）：打卡只送 1 次、沒有自動重送' % label, len(S['g_posts']) == 1, S['g_posts'])
        p.close()

    # 5. mini 沒給出可採用的「ok」：不先顯示，照舊等 Google；route=plain
    cases = [('HTTP 500（網頁錯誤頁）', (500, '<html>Internal Server Error</html>'), 0, 'none'),
             ('HTTP 500 但回 JSON 錯誤訊息', (500, '{"error":"boom"}'), 0, 'unknown'),
             ('回非 JSON', (200, 'not json at all'), 0, 'none'),
             ('predict=ok 但 ts 格式錯', {'predict': 'ok', 'ts': '2026-10-16 09:01:02', 'greeting': 'x'}, 0, 'unknown'),
             ('predict=ok 但沒有 greeting', {'predict': 'ok', 'ts': '2026-10-16T09:01:02+08:00'}, 0, 'unknown'),
             ('超過 2.5 秒才回', MINI_OK, 3000, 'none')]   # 2026-10-19 等待上限 1.5→2.5 秒
    for label, mini, ms, want in cases:
        p, S = relay_open(ctx, hq, mini, G_OK, mini_ms=ms, g_ms=3600 if ms else 2600)
        force_out(p)
        m = msg_at(p, 2800 if ms else 900)
        ok('快速通道 5（mini %s）：Google 沒回前不先顯示成功' % label, '打卡成功' not in m and '打卡中' in m, m)
        wait_msg(p, '下班打卡成功 09:02', timeout=6000)
        tm = relay_last(p)
        ok('快速通道 5（mini %s）：route=plain、predict=%s、最後照 Google 顯示' % (label, want),
           tm['route'] == 'plain' and tm['predict'] == want and tm['outcome'] == 'ok' and '09:01' not in msg(p), tm)
        ok('快速通道 5（mini %s）：total_ms 算到 Google 回來（≥ 2500）' % label, tm['total_ms'] >= 2500, tm)
        p.close()

    # 5b. mini 2 秒才回（舊上限 1.5 秒會放棄，新上限 2.5 秒內）：要先顯示成功（2026-10-19）
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, mini_ms=2000, g_ms=3600)
    force_out(p)
    m = msg_at(p, 2700)
    ok('快速通道 5b：mini 2 秒才回 ok → 2.5 秒上限內仍先顯示成功', '下班打卡成功 09:01' in m, m)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    tm = relay_last(p)
    ok('快速通道 5b：timing route=predicted、predict=ok、predict_ms 約 2 秒', tm['route'] == 'predicted' and tm['predict'] == 'ok' and 1800 <= float(tm['predict_ms']) < 2500, tm)
    p.close()

    # 6. mini 說 blocked
    p, S = relay_open(ctx, hq, {'predict': 'blocked', 'reason': '10 分鐘內不能打'}, G_OK, mini_ms=0, g_ms=2000)
    force_out(p)
    m = msg_at(p, 900)
    ok('快速通道 6：mini 回 blocked → 不先顯示成功', '打卡成功' not in m and '打卡中' in m, m)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    tm = relay_last(p)
    ok('快速通道 6：route=plain、predict=blocked', tm['route'] == 'plain' and tm['predict'] == 'blocked' and isinstance(tm['predict_ms'], int), tm)
    p.close()

    # 7. shadow：只送去比對，畫面不採用
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, mini_ms=300, g_ms=2000, mode='shadow')
    force_out(p)
    m = msg_at(p, 1000)
    ok('快速通道 7：shadow → mini 即使回 ok 也不先顯示', '打卡成功' not in m and '打卡中' in m, m)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    tm = relay_last(p)
    ok('快速通道 7：shadow 有送 mini（1 份）、route=plain、predict=ok、predict_ms 有值', len(S['mini_hits']) == 1 and tm['route'] == 'plain'
       and tm['predict'] == 'ok' and isinstance(tm['predict_ms'], int) and tm['predict_ms'] >= 250, (tm, S['mini_hits']))
    ok('快速通道 7：shadow 的畫面問候語是 Google 的', G_OK['greeting'] in msg(p) and MINI_OK['greeting'] not in msg(p), msg(p))
    p.close()

    # 8. 開關關閉（relay_mode=off，等同 stores.json 該店 false）：根本不送 mini
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, g_ms=500, mode='off')
    force_out(p)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    tm = relay_last(p)
    p.wait_for_timeout(300)
    ok('快速通道 8：開關關閉 → 不送 mini（攔截計數 0、頁內也沒有該網址的請求）',
       len(S['mini_hits']) == 0 and not any(x['url'].endswith('/relay-mock') for x in calls(p)), (S['mini_hits'], calls(p)))
    ok('快速通道 8：route=off、predict=none、predict_ms 空、req_id 仍有', tm['route'] == 'off' and tm['predict'] == 'none' and tm['predict_ms'] is None
       and RID.match(str(tm['req_id'])) is not None, tm)
    ok('快速通道 8：stores.json 每家店 relay 只會是 false／"shadow"／true', all(s.get('relay') in (False, True, 'shadow') and s.get('relay') is not 1 for s in STORES.values()), {k: s.get('relay') for k, s in STORES.items()})
    p.close()

    # 3b. 先顯示成功後 Google 回 too_many／bad_reply／not_bound：訊息前面加「剛才顯示成功有誤。」
    for label, gr in [('too_many', {'ok': False, 'error': 'too_many'}), ('bad_reply', {'ok': False, 'error': 'server_error'}),
                      ('not_bound', {'ok': False, 'error': 'not_bound'})]:
        p, S = relay_open(ctx, hq, MINI_OK, gr, mini_ms=300, g_ms=1500)
        force_out(p)
        wait_msg(p, '下班打卡成功 09:01', timeout=1200)
        wait_msg(p, '剛才顯示成功有誤。', timeout=6000)
        m = msg(p)
        tm = relay_last(p, timeout=8000)
        ok('快速通道 3b：先顯示成功後 Google 回 %s → 訊息以「剛才顯示成功有誤。」開頭、沒有殘留成功字樣' % label, m.startswith('剛才顯示成功有誤。') and '打卡成功' not in m, m)
        ok('快速通道 3b：%s 的 timing outcome=error、route=predicted' % label, tm['outcome'] == 'error' and tm['route'] == 'predicted', tm)
        p.close()

    # 6b. 開頁時防呆已擋這型（10 分鐘鎖）：即使 mini 回 ok 也不先顯示（強制解鎖按鈕模擬畫面沒擋到）
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, mini_ms=100, g_ms=2000, guard='locked')
    force_out(p)
    m = msg_at(p, 900)
    ok('快速通道 6b：guard 已有 10 分鐘鎖 → mini 回 ok 也不先顯示', '打卡成功' not in m and '打卡中' in m, m)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    tm = relay_last(p)
    ok('快速通道 6b：route=plain、predict=ok、predict_ms 有值', tm['route'] == 'plain' and tm['predict'] == 'ok' and isinstance(tm['predict_ms'], int), tm)
    p.close()

    # 7b. shadow、mini 比 Google 慢 800ms：timing 仍記到 predict=ok 與 predict_ms（秒數等 mini 才送）
    p, S = relay_open(ctx, hq, MINI_OK, G_OK, mini_ms=2800, g_ms=2000, mode='shadow')
    force_out(p)
    wait_msg(p, '下班打卡成功 09:02', timeout=6000)
    ok('快速通道 7b：Google 先回時秒數還沒送（等 mini）', p.evaluate('(window.__timing || []).length') == 0)
    tm = relay_last(p, timeout=4000)
    ok('快速通道 7b：shadow、mini 慢 800ms → predict=ok、predict_ms ≥ 2800、route=plain', tm['predict'] == 'ok' and tm['route'] == 'plain'
       and isinstance(tm['predict_ms'], int) and tm['predict_ms'] >= 2800, tm)
    p.close()

    # 9. QR 打卡（主管出示動態 QR、不定位）
    p, S = relay_open(ctx, hq, MINI_OK, dict(G_OK, type='in', via_qr=True), mini_ms=300, g_ms=2000, qr='gk~testqrtoken', guard='none')
    p.click('#btnIn')
    wait_msg(p, '上班打卡成功 09:01', timeout=1500)
    wait_msg(p, '（主管 QR）', timeout=6000)
    tm = relay_last(p)
    b = S['mini_hits'][0] if S['mini_hits'] else {}
    ok('快速通道 9：QR 打卡送 mini 的 body 帶 qr、不帶 lat／lng', b.get('qr') == 'gk~testqrtoken' and 'lat' not in b and 'lng' not in b
       and 'accuracy' not in b and b.get('req_id') == tm['req_id'], b)
    ok('快速通道 9：QR 打卡 Google 的 liff_punch 也帶 qr、不帶定位', S['g_posts'] and S['g_posts'][0].get('qr') == 'gk~testqrtoken' and 'lat' not in S['g_posts'][0], S['g_posts'])
    ok('快速通道 9：QR 打卡 timing qr=true、route=predicted、predict=ok', tm['qr'] is True and tm['route'] == 'predicted' and tm['predict'] == 'ok', tm)
    p.close()


if __name__ == '__main__':
    main()
