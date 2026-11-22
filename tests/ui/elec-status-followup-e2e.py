# #212 後續小修正（Codex 複審 2026-11-22：SHOULD-FIX 1、殘餘 1，以及 SHOULD-FIX 2 的前端那一半）：假後端＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/elec-status-followup-e2e.py [G,H,I]
#   跟 tests/ui/elec-codex6-e2e.py 同一套假資料（tests/election-day-emp.test.js 的 world()，虛構同仁「測試甲～丁」）與假後端（mock/mock_server.py），不碰正式試算表。
#   假後端開在隨機埠、只綁 127.0.0.1，跑完用自己的程序代號收掉，並刪掉 mock/mock_data.json。
# 規則（主管同意）：這個月任何一次讀取失敗 → 擋匯出（Excel、CSV、薪資單）與鎖定，重新載入成功才解開；被擋的提示只用這一句：
#   「這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出」
#   G  SHOULD-FIX 1：薪資單頁「列印 / 存成 PDF」——成功載入 11 月、開薪資單 → 切到 10 月讀取失敗 → 按列印：要擋（不可印出 11 月的舊薪資單）；
#      對照：讀取成功時照常列印；切回 11 月重新載入成功後恢復列印
#   H  殘餘 1＋SHOULD-FIX 2 前端：鎖定的回應斷掉、接著「狀態查詢」也失敗（逾時／後端回 status_read_failed／舊後端退回 payroll_month 也失敗）
#      → 設讀取失敗旗標：匯出與鎖定擋、提示沿用既有「連不上伺服器，無法確認有沒有鎖定成功…」；status_read_failed 不可退回會自動重算的 payroll_month；
#      重新載入成功才解開。對照：狀態查得到（仍是草稿）時不擋
#      驗收員第 5 點：只有舊後端（unknown_action）或管理系統代轉未放行（FORBIDDEN／沒有權限）才退回 payroll_month；系統忙碌、嵌入逾時等一律當查不到
#   I  驗收員第 3 點：讀取失敗後「重新計算」仍可按；重算成功後重新載入這個月，載入成功才解開（重新載入又失敗＝仍擋）
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MOCK = os.path.join(ROOT, 'mock'); DATA = os.path.join(MOCK, 'mock_data.json')
NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')
ONLY = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None

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
def fulfill(route, obj): route.fulfill(status=200, content_type='application/json', body=json.dumps(obj))
UNSURE_TXT = '這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出'
NOCONF_TXT = '連不上伺服器，無法確認有沒有鎖定成功，請稍後重新整理頁面看狀態'
DRAFT_TXT = '連線中斷：重新讀取後這個月仍是草稿，沒有鎖定成功，請再按一次「鎖定本月」'
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
                pg.evaluate("window.__pr=0; window.print=function(){ window.__pr++; }; 0")   # 不真的開列印對話框，只數有沒有叫到
            def setym(v, wait=2500): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(wait)
            msg = lambda: pg.inner_text('#msg')
            clear_msg = lambda: pg.evaluate("$('msg').textContent=''; 0")
            blocked = lambda: pg.evaluate('monBlocked()')
            prints = lambda: pg.evaluate('window.__pr')
            def slip_print():
                pg.click('button[data-p="slip"]'); pg.wait_for_timeout(400)
                clear_msg()
                pg.locator('#p-slip button', has_text='列印').click(); pg.wait_for_timeout(300)

            # ── G（SHOULD-FIX 1：薪資單列印）──
            if not ONLY or 'G' in ONLY:
                fresh()
                pg.click('button[data-p="slip"]'); pg.wait_for_timeout(400)
                slip0 = pg.inner_text('#slipWrap')
                slip_print()
                ok(bname + ' G 對照：11 月讀取成功、薪資單有內容 → 按列印照常列印', '測試' in slip0 and prints() == 1, (slip0[:30], prints()))
                def routeG(route):
                    bd = act(route)
                    if bd.get('action') == 'payroll_month' and bd.get('ym') == '2026-10':
                        fulfill(route, {'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'}); return
                    route.continue_()
                pg.route('**/*', routeG)
                setym('2026-10')
                stale = pg.inner_text('#slipWrap')
                slip_print()
                ok(bname + ' G 切到 10 月讀取失敗（畫面還留著 11 月的薪資單）→ 按列印：不列印、提示「剛才沒有讀取成功」那一句',
                   '測試' in stale and prints() == 1 and msg() == UNSURE_TXT, (stale[:30], prints(), msg()))
                pg.unroute('**/*')
                setym('2026-11')
                slip_print()
                ok(bname + ' G 切回 11 月重新載入成功 → 解開、照常列印', not blocked() and prints() == 2 and msg() != UNSURE_TXT, (blocked(), prints(), msg()))

            # ── H（殘餘 1＋SHOULD-FIX 2 前端＋驗收員第 5 點：鎖定結果不明、狀態查詢失敗）──
            # expect：block＝設旗標、不退回 payroll_month；fallback_block＝舊後端／未放行 → 退回 payroll_month、它也失敗 → 設旗標；
            #         fallback_draft＝退回 payroll_month 讀得到（仍是草稿）→ 不擋；draft＝payroll_status 讀得到 → 不擋
            if not ONLY or 'H' in ONLY:
                BUSY = '系統忙碌，請稍後再試'
                cases = [
                    ('狀態查詢逾時', {'ok': False, 'error': 'timeout', 'message': '等候逾時，請稍後再試'}, None, 'block'),
                    ('後端回 status_read_failed（預查失敗）', {'ok': False, 'error': 'status_read_failed'}, None, 'block'),
                    ('代轉回「系統忙碌」（503）', {'ok': False, 'error': BUSY, 'message': BUSY}, None, 'block'),
                    ('嵌入模式逾時（代轉回「請求逾時」）', {'ok': False, 'error': '請求逾時，請稍後再試', 'message': '請求逾時，請稍後再試'}, None, 'block'),
                    ('舊後端不認得 payroll_status、退回 payroll_month 也失敗', {'ok': False, 'error': 'unknown_action'}, {'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'}, 'fallback_block'),
                    ('舊後端不認得 payroll_status、退回 payroll_month 讀得到草稿', {'ok': False, 'error': 'unknown_action'}, None, 'fallback_draft'),
                    ('管理系統代轉未放行（沒有權限，dzy#157 未上線）', {'ok': False, 'error': '沒有權限', 'message': '沒有權限'}, None, 'fallback_draft'),
                    ('管理系統代轉未放行（FORBIDDEN）', {'ok': False, 'error': 'FORBIDDEN', 'message': '沒有權限'}, None, 'fallback_draft'),
                    ('對照：狀態查得到、仍是草稿', None, None, 'draft'),
                ]
                for lab, stResp, monResp, expect in cases:
                    fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                    seen, cfg = [], {'st': stResp, 'mon': monResp}
                    def routeH(route):   # ⚠ 不可用預設參數帶值：Playwright 會把 request 當第二個參數傳進來
                        a = act(route).get('action'); seen.append(a)
                        if a == 'payroll_finalize':
                            fulfill(route, {'ok': False, 'error': 'timeout', 'message': '等候逾時，請稍後再試'}); return
                        if a == 'payroll_status' and cfg['st'] is not None: fulfill(route, cfg['st']); return
                        if a == 'payroll_month' and cfg['mon'] is not None: fulfill(route, cfg['mon']); return
                        route.continue_()
                    pg.route('**/*', routeH)
                    n0 = pg.evaluate('RESULTS.length')
                    pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                    m1 = msg()
                    after = seen[seen.index('payroll_finalize') + 1:] if 'payroll_finalize' in seen else []
                    fell = 'payroll_month' in after
                    if expect in ('block', 'fallback_block'):
                        clear_msg(); pg.evaluate('exportExcel()'); pg.wait_for_timeout(200); m2 = msg()
                        clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200); m3 = msg()
                        slip_print(); m4 = msg()
                        pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                        ok(bname + ' H ' + lab + '：提示沿用「連不上伺服器，無法確認…」、設讀取失敗旗標（鎖定鈕停用；Excel／CSV／薪資單都擋、同一句）',
                           n0 > 0 and m1 == NOCONF_TXT and blocked() and pg.is_disabled('#lockBtn') and m2 == UNSURE_TXT and m3 == UNSURE_TXT and m4 == UNSURE_TXT and prints() == 0,
                           (n0, m1, blocked(), pg.is_disabled('#lockBtn'), m2, m3, m4, prints()))
                        ok(bname + ' H ' + lab + '：' + ('退回 payroll_month（舊後端／未放行才退回）' if expect == 'fallback_block' else '不退回會自動重算的 payroll_month'),
                           after[:1] == ['payroll_status'] and fell == (expect == 'fallback_block'), after)
                        pg.unroute('**/*')
                        setym('2026-10'); setym('2026-11')
                        ok(bname + ' H ' + lab + '：重新載入成功 → 解開（匯出、鎖定鈕恢復）', not blocked() and not pg.is_disabled('#lockBtn') and pg.evaluate('RESULTS.length') > 0, (blocked(),))
                    else:
                        ok(bname + ' H ' + lab + '：提示「仍是草稿」、不擋（鎖定鈕可按）' + ('；有退回 payroll_month' if expect == 'fallback_draft' else '；沒打 payroll_month'),
                           m1 == DRAFT_TXT and not blocked() and not pg.is_disabled('#lockBtn') and fell == (expect == 'fallback_draft'), (m1, blocked(), after))
                        pg.unroute('**/*')

            # ── I（驗收員第 3 點：讀取失敗後「重新計算」仍可按；重算成功後重新載入，載入成功才解開）──
            if not ONLY or 'I' in ONLY:
                for lab, reload_ok in (('重算後重新載入成功', True), ('重算成功但重新載入又失敗', False)):
                    fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                    seenI, cfgI = [], {'fail_month': True}
                    def routeI(route):
                        bd = act(route); a = bd.get('action'); seenI.append(a)
                        if a == 'payroll_month' and bd.get('ym') == '2026-11' and cfgI['fail_month']:
                            fulfill(route, {'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'}); return
                        route.continue_()
                    pg.route('**/*', routeI)
                    setym('2026-10'); setym('2026-11')
                    b0 = blocked(); calc_en = not pg.is_disabled('#calcBtn')
                    clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200); mb = msg()
                    ok(bname + ' I ' + lab + '：讀取失敗 → 匯出擋（同一句）、鎖定鈕停用，但「重新計算」鈕可按', b0 and mb == UNSURE_TXT and pg.is_disabled('#lockBtn') and calc_en, (b0, mb, calc_en))
                    cfgI['fail_month'] = not reload_ok
                    k = len(seenI)
                    pg.click('#calcBtn'); pg.wait_for_timeout(3500)
                    aft = seenI[k:]
                    calc_then_month = 'payroll_calc' in aft and 'payroll_month' in aft[aft.index('payroll_calc') + 1:] if 'payroll_calc' in aft else False
                    if reload_ok:
                        clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200); me = msg()
                        ok(bname + ' I ' + lab + '：按重新計算 → payroll_calc 成功、接著重新載入這個月 → 解開（鎖定鈕可按、匯出不再被擋）',
                           calc_then_month and not blocked() and not pg.is_disabled('#lockBtn') and me != UNSURE_TXT and pg.evaluate('RESULTS.length') > 0, (aft, blocked(), me))
                    else:
                        clear_msg(); pg.evaluate('exportExcel()'); pg.wait_for_timeout(200); me = msg()
                        ok(bname + ' I ' + lab + '：重算成功但重新載入失敗 → 仍然擋（匯出同一句、鎖定鈕停用；重新計算鈕仍可按）',
                           calc_then_month and blocked() and pg.is_disabled('#lockBtn') and me == UNSURE_TXT and not pg.is_disabled('#calcBtn'), (aft, blocked(), me))
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
