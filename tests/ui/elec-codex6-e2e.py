# 選舉假 Codex 第六次 SHOULD-FIX（待辦 13a／13b／13c）＋鎖定逾時改用唯讀 payroll_status（待辦 10）：假後端＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/elec-codex6-e2e.py
#   跟 tests/ui/elec-ui-e2e.py 同一套假資料（tests/election-day-emp.test.js 的 world()，虛構同仁「測試甲～己」）與假後端（mock/mock_server.py），不碰正式試算表。
#   假後端開在隨機埠、只綁 127.0.0.1，跑完用自己的程序代號收掉，並刪掉 mock/mock_data.json。
# 每一段都用「攔住請求、控制回應先後」重現 Codex 說的順序：
#   A 13a  存名單後的重算在途 → 切走再切回 → 切回的月資料先讀到舊草稿、卻比重算晚到：不可蓋掉重算結果，要重讀；重讀前匯出、鎖定先擋
#   B 13b  鎖定成功、之後重讀失敗：匯出與鎖定鈕先擋、紅字提示；重新載入成功才放行
#   C 13b  名單存檔途中丟例外：待確認一定解除（序號清理在 finally）
#   D 13b  直連（?k=）請求一直不回：逾時回 timeout、畫面不卡在載入中
#   E 13c  開頁的趨勢預抓在存名單（清快取）之後才被取用：版本不符不採用、重抓；沒清過快取照常用預抓（不多打一次）
#   F 10   鎖定逾時：先問唯讀 payroll_status，草稿時不打會自動重算的 payroll_month
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MOCK = os.path.join(ROOT, 'mock'); DATA = os.path.join(MOCK, 'mock_data.json')
NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')
ONLY = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None   # 只跑某幾段，例：A,F

SEEDJS = r'''
const path = require('path'), fs = require('fs');
const T = fs.readFileSync(path.join(process.argv[1], 'tests/election-day-emp.test.js'), 'utf8');
const cut = T.indexOf("const BASE_REF");
const mod = { exports: {} };
new Function('require', 'module', '__dirname', T.slice(0, cut).replace("'use strict';", '') + '\nmodule.exports = { world };')(require, mod, path.join(process.argv[1], 'tests'));
const w = mod.exports.world({ elec: ['a', 'b', 'g'], only: ['a', 'b', 'e', 'g'] });
const res = w.F('handlePayrollCalc')({ admin_key: 'x', ym: '2026-11', store: 'SSLGF' });
const names = ['測試甲', '測試乙', '測試丙', '測試丁'];
const master = w.DB.master.map((m, i) => Object.assign({}, m, { name: names[i] }));
const results = res.results.map((r, i) => Object.assign({}, r, { name: names[i], ym: '2026-11', status: 'draft' }));
process.stdout.write(JSON.stringify({ master, results }));
'''
sd = json.loads(subprocess.run([NODE, '-e', SEEDJS, ROOT], capture_output=True, text=True, check=True).stdout)

s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
proc = subprocess.Popen([sys.executable, 'mock_server.py'], cwd=MOCK, env=dict(os.environ, MOCK_PORT=str(PORT), MOCK_NODE=NODE),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = 'http://localhost:%d' % PORT
# 看門狗：卡住超過 E2E_WATCHDOG 秒（預設 900）就印出卡在哪、收掉自己起的假後端再結束（不留孤兒程序）
import faulthandler, threading
def _watchdog():
    print('⚠ 超過時間，卡住的位置：', flush=True); faulthandler.dump_traceback(all_threads=True)
    try: proc.terminate()
    except Exception: pass
    try: os.remove(DATA)
    except Exception: pass
    os._exit(3)
_wd = threading.Timer(int(os.environ.get('E2E_WATCHDOG', '900')), _watchdog); _wd.daemon = True; _wd.start()
def api(action, **b):
    req = urllib.request.Request(BASE + '/api', data=json.dumps(dict(action=action, admin_key='test-admin', **b)).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())
def seed():
    d = json.load(open(DATA, encoding='utf-8'))
    p = d.setdefault('payroll', {})
    p['master'] = sd['master']; p['hol_emp'] = []
    p['run'] = [dict(r, status='draft') for r in sd['results']]
    p['holiday'] = [{'ym': '2026-11', 'red_days': 9, 'note': '', 'dates': '', 'store': ''}]
    p['store'] = [{'code': 'SSLGF', 'name': '測試店', 'active': True}]
    json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))
def act(route):
    try: return json.loads(route.request.post_data or '{}')
    except Exception: return {}
OLD = '舊資料X'
UNSURE_TXT = '這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出'
ST_TXT = {'draft': '連線中斷：重新讀取後這個月仍是草稿，沒有鎖定成功，請再按一次「鎖定本月」',
          'mixed': '這個月有一部分已鎖定、一部分還是草稿，請重新整理頁面看狀態；重新整理後還是這樣請找資訊部',
          'none': '這個月還沒有計算結果，沒有鎖定成功；請重新整理頁面看狀態'}
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/payroll.html', timeout=1); break
        except Exception: time.sleep(0.2)
    api('payroll_master_get')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        for bname in ('chromium', 'webkit'):
            b = getattr(pw, bname).launch()
            pg = b.new_page(viewport={'width': 1280, 'height': 900})
            pg.on('pageerror', lambda e: None)
            def fresh():
                seed()
                pg.unroute('**/*')
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
                pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200)
            def setym(v, wait=2500): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(wait)
            def until(cond, n=80):
                for _ in range(n):
                    if cond(): return True
                    pg.wait_for_timeout(100)
                return False
            def pick_elec():
                pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(400)
                pg.fill('#elecDate', '2026-11-28'); pg.locator('#elecList .elec-ck').nth(0).check()
            msg = lambda: pg.inner_text('#msg')
            res_has_old = lambda: pg.evaluate("RESULTS.some(r=>String(r.name)===%s)" % json.dumps(OLD))
            blocked = lambda: pg.evaluate("typeof monBlocked==='function'?monBlocked():elecPending()")

            # ── A（13a）──
            if not ONLY or 'A' in ONLY:
                fresh(); pick_elec()
                hA, seenA = {}, []
                def routeA(route):
                    bd = act(route); a = bd.get('action'); seenA.append((a, bd.get('ym')))
                    if a == 'payroll_calc' and bd.get('ym') == '2026-11' and 'c' not in hA: hA['c'] = route; return
                    if a == 'payroll_month' and bd.get('ym') == '2026-11' and 'c' in hA and 'm' not in hA:
                        j = route.fetch().json()   # 重算還沒寫進去：這份是舊草稿
                        if j.get('run') and j['run'].get('results'): j['run']['results'][0]['name'] = OLD
                        hA['m'] = (route, j); return
                    route.continue_()
                pg.route('**/*', routeA)
                pg.click('#elecSave')
                until(lambda: 'c' in hA)
                setym('2026-10'); setym('2026-11', 600)
                until(lambda: 'm' in hA)
                hA['c'].continue_(); pg.wait_for_timeout(1500)
                ok(bname + ' A 重算先回來、切回的月資料還在路上：匯出與鎖定先擋', 'm' in hA and blocked() and pg.is_disabled('#lockBtn'), (list(hA), blocked()))
                k = len(seenA)
                if 'm' in hA: hA['m'][0].fulfill(status=200, content_type='application/json', body=json.dumps(hA['m'][1]))
                pg.wait_for_timeout(3000)
                again = ('payroll_month', '2026-11') in seenA[k:]
                ok(bname + ' A 晚到的舊月資料沒有蓋掉重算結果（畫面沒有舊資料）', pg.evaluate('RESULTS.length') > 0 and not res_has_old(), (pg.evaluate('RESULTS.length'), res_has_old()))
                ok(bname + ' A 丟掉舊月資料後重讀一次（payroll_month 11 月），重讀成功才放行匯出與鎖定', again and not blocked() and not pg.is_disabled('#lockBtn'), (seenA[k:], blocked()))
                pg.unroute('**/*')

            # ── B（13b 鎖定成功、重讀失敗）──
            if not ONLY or 'B' in ONLY:
                fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                stB = {}
                def routeB(route):
                    bd = act(route); a = bd.get('action')
                    if a == 'payroll_finalize':
                        stB['f'] = 1; route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'ym': '2026-11', 'status': 'final', 'count': 4})); return
                    if a == 'payroll_month' and 'f' in stB:
                        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'})); return
                    route.continue_()
                pg.route('**/*', routeB)
                n0 = pg.evaluate('RESULTS.length')
                pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                m1 = msg()
                ok(bname + ' B 鎖定成功但重讀失敗：紅字提示要重新整理確認', '重新讀取這個月失敗' in m1, m1)
                pg.evaluate('exportExcel()'); pg.wait_for_timeout(200); m2 = msg()
                pg.evaluate('exportCSV()'); pg.wait_for_timeout(200); m3 = msg()
                pg.evaluate('exportPDF()'); pg.wait_for_timeout(200); m4 = msg()
                ok(bname + ' B 重讀失敗後：匯出 Excel／CSV／PDF 擋，提示「剛才沒有讀取成功」（不是「請先計算」）、鎖定鈕停用',
                   n0 > 0 and m2 == UNSURE_TXT and m3 == UNSURE_TXT and m4 == UNSURE_TXT and pg.is_disabled('#lockBtn'), (n0, m2, m3, m4, pg.is_disabled('#lockBtn')))
                pg.unroute('**/*')
                setym('2026-10'); setym('2026-11')
                ok(bname + ' B 重新載入成功 → 解除（匯出、鎖定鈕恢復）', not blocked() and not pg.is_disabled('#lockBtn') and pg.evaluate('RESULTS.length') > 0, (blocked(),))
                pg.evaluate('RESULTS=[]; 0')   # 真的沒算過：維持原本兩句
                pg.evaluate('exportCSV()'); pg.wait_for_timeout(200); n1 = msg()
                pg.evaluate('exportExcel()'); pg.wait_for_timeout(200); n2 = msg()
                ok(bname + ' B 沒讀取失敗、只是沒有結果：仍是原本的「請先計算」／「此月份尚無資料，請先計算」', n1 == '請先計算' and n2 == '此月份尚無資料，請先計算', (n1, n2))

            # ── C（13b 存檔途中丟例外 → finally 解除待確認）──
            if not ONLY or 'C' in ONLY:
                fresh(); pick_elec()
                pg.evaluate("window.__RE=renderElec; renderElec=function(){ throw new Error('測試例外'); }; 0")
                pg.click('#elecSave'); pg.wait_for_timeout(2500)
                pend = pg.evaluate('Object.keys(ELEC_PEND).length')
                pg.evaluate("renderElec=window.__RE; 0")
                ok(bname + ' C 存檔回來後丟例外：待確認仍解除（ELEC_PEND 清空、重新計算鈕可按）', pend == 0 and not pg.is_disabled('#calcBtn'), (pend, pg.is_disabled('#calcBtn')))

            # ── D（13b 直連逾時）──
            if not ONLY or 'D' in ONLY:
                fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                hD = {}
                def routeD(route):
                    if act(route).get('action') == 'payroll_calc' and 'r' not in hD: hD['r'] = route; return   # 一直不回
                    route.continue_()
                pg.route('**/*', routeD)
                pg.evaluate("DIRECT_TIMEOUT_MS=1500; window.__dc=null; doCalc().then(v=>{ window.__dc=String(v); }); 0")   # 結尾 0：不讓 evaluate 等這個 promise
                pg.wait_for_timeout(4000)
                dc, ld = pg.evaluate('window.__dc'), pg.evaluate("document.body.classList.contains('loading')")
                ok(bname + ' D 直連請求一直不回：逾時回 false、提示等候逾時、畫面不卡在載入中', dc == 'false' and '等候逾時' in msg() and not ld, (dc, msg(), ld))
                if 'r' in hD:
                    try: hD['r'].abort()
                    except Exception: pass
                pg.unroute('**/*')

            # ── E（13c 趨勢預抓版本）──
            if not ONLY or 'E' in ONLY:
                fresh()   # 先記住門市（pay_store）：開頁預抓的店月鍵要跟載入後一樣，才是「沒清過快取」的正常情況
                seenE0 = []
                def routeE0(route):
                    a0 = act(route).get('action'); seenE0.append(a0)
                    if a0 == 'payroll_xmap_get':   # 開頁背景的打卡對照同步會再重讀一次月資料（另一條既有路徑），這裡先讓它不動作，只看預抓有沒有被採用
                        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'test_skip'})); return
                    route.continue_()
                pg.route('**/*', routeE0)
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1500)
                ok(bname + ' E 沒清過快取：開頁趨勢只打一次（預抓照常採用）', seenE0.count('payroll_trend') == 1 and pg.evaluate('DASH.length') > 0, (seenE0,))
                pg.unroute('**/*')
                hE, seenE = {}, []
                def routeE(route):
                    a = act(route).get('action'); seenE.append(a)
                    if a in ('payroll_master_get', 'payroll_trend') and a not in hE: hE[a] = route; return
                    route.continue_()
                pg.route('**/*', routeE)
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='domcontentloaded')
                until(lambda: len(hE) == 2)
                pg.click('button[data-p="run"]')
                if 'payroll_master_get' in hE: hE['payroll_master_get'].continue_()
                pg.wait_for_timeout(2500)
                pick_elec(); pg.click('#elecSave')
                pg.wait_for_function("document.getElementById('msg').textContent.indexOf('已儲存選舉假名單')>=0", timeout=8000)
                k = len(seenE)
                if 'payroll_trend' in hE:
                    r0 = hE['payroll_trend']; j = r0.fetch().json()
                    for m in (j.get('months') or []): m['__stale'] = 1
                    r0.fulfill(status=200, content_type='application/json', body=json.dumps(j))
                pg.wait_for_timeout(500)
                pg.click('button[data-p="dash"]'); pg.wait_for_timeout(2500)
                st = pg.evaluate('DASH.some(d=>d.__stale)')
                ok(bname + ' E 預抓在存名單（清快取）之後才取用：不採用、重抓趨勢（畫面不是舊的那份）', len(hE) == 2 and not st and 'payroll_trend' in seenE[k:] and pg.evaluate('DASH.length') > 0, (list(hE), st, seenE[k:]))
                pg.unroute('**/*')

            # ── F（待辦 10：鎖定逾時用唯讀 payroll_status）──
            if not ONLY or 'F' in ONLY:
                for want in ('draft', 'final', 'mixed', 'none'):
                    fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                    seenF, wantF = [], {'v': want}
                    def routeF(route):   # ⚠ 不可用預設參數帶值：Playwright 會把 request 當第二個參數傳進來
                        a = act(route).get('action'); seenF.append(a)
                        if a == 'payroll_finalize':
                            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'timeout', 'message': '等候逾時，請稍後再試'})); return
                        if a == 'payroll_status' and wantF['v'] != 'draft':
                            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'ym': '2026-11', 'store': 'SSLGF', 'status': wantF['v'], 'rows': 4, 'run_at': '', 'elec_stale': False})); return
                        route.continue_()
                    pg.route('**/*', routeF)
                    pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                    after = seenF[seenF.index('payroll_finalize') + 1:] if 'payroll_finalize' in seenF else []
                    if want in ST_TXT:
                        ok(bname + ' F 鎖定逾時、payroll_status 回 ' + want + '：只問唯讀 payroll_status、不打 payroll_month；提示「' + ST_TXT[want][:12] + '…」',
                           after[:1] == ['payroll_status'] and 'payroll_month' not in after and msg() == ST_TXT[want], (after, msg()))
                    else:
                        ok(bname + ' F 鎖定逾時、後端已鎖：payroll_status 回 final → 重新載入這個月、提示已鎖定',
                           after[:1] == ['payroll_status'] and 'payroll_month' in after and '重新讀取後確認這個月已經鎖定' in msg(), (after, msg()))
                    pg.unroute('**/*')
            b.close()
finally:
    proc.terminate()
    try: proc.wait(timeout=5)
    except Exception: proc.kill()
    try: os.remove(DATA)
    except Exception: pass
print('假後端埠', PORT, '程序', proc.pid, '結束碼', proc.returncode)
print('結果：%d 過、%d 失敗' % (sum(1 for _, c in results if c), sum(1 for _, c in results if not c)))
sys.exit(1 if any(not c for _, c in results) else 0)
