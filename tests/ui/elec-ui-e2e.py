# 選舉假名單卡片＋薪資計算頁：假後端（mock/mock_server.py）＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/elec-ui-e2e.py [截圖資料夾]
#   需要：python 的 playwright（含 chromium、webkit 瀏覽器）、node（找不到時用 ~/.local/node/bin/node）。
#   假資料由 tests/election-day-emp.test.js 的 world() 算出（虛構同仁「測試甲～己」），不碰任何正式試算表。
#   假後端開在隨機埠、只綁 127.0.0.1，跑完用自己的程序代號收掉，並刪掉 mock/mock_data.json。
# 2026-11-22 Codex 第三次補：存名單後重算失敗再重新整理（後端回 elec_stale）→ 仍顯示要重算、不能匯出舊結果；
#   已停用但當月離職的同仁勾得到；開頁預抓的月資料在切月後才回來 → 不套用。
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else None
if OUT: os.makedirs(OUT, exist_ok=True)
MOCK = os.path.join(ROOT, 'mock'); DATA = os.path.join(MOCK, 'mock_data.json')
NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')

# ── 假資料：world({elec:[a,b,g], only:[a,b,e,g]}) 算出的 11 月草稿（含選舉日出勤），外加兩位停用者 ──
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
// 停用者：E5 11/29 離職（當月要結算，名單要勾得到）、E6 10/15 離職（不在 11 月計薪名冊，不出現）
master.push(Object.assign({}, master[0], { emp_id: 'E5', name: '測試戊', active: 'false', leave_date: '2026-11-29' }));
master.push(Object.assign({}, master[0], { emp_id: 'E6', name: '測試己', active: 'false', leave_date: '2026-10-15' }));
const results = res.results.map((r, i) => Object.assign({}, r, { name: names[i], ym: '2026-11', status: 'draft' }));
process.stdout.write(JSON.stringify({ master, results }));
'''
sd = json.loads(subprocess.run([NODE, '-e', SEEDJS, ROOT], capture_output=True, text=True, check=True).stdout)

s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
proc = subprocess.Popen([sys.executable, 'mock_server.py'], cwd=MOCK, env=dict(os.environ, MOCK_PORT=str(PORT), MOCK_NODE=NODE),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = 'http://localhost:%d' % PORT
def api(action, **b):
    req = urllib.request.Request(BASE + '/api', data=json.dumps(dict(action=action, admin_key='test-admin', **b)).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())
def seed(final=False):
    d = json.load(open(DATA, encoding='utf-8'))
    p = d.setdefault('payroll', {})
    p['master'] = sd['master']; p['hol_emp'] = []
    p['run'] = [dict(r, status='final' if final else 'draft') for r in sd['results']]
    p['holiday'] = [{'ym': '2026-11', 'red_days': 9, 'note': '', 'dates': '', 'store': ''}]
    p['store'] = [{'code': 'SSLGF', 'name': '測試店', 'active': True}]
    json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))
def shot(pg, bname, fn, el=None):
    if OUT and bname == 'chromium': (el or pg).screenshot(path=os.path.join(OUT, fn))
STALE_TXT = '名單已儲存，但重新計算沒有完成，請再按一次「重新計算」'
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/payroll.html', timeout=1); break
        except Exception: time.sleep(0.2)
    api('payroll_master_get')   # 讓假後端建出 mock_data.json
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        for bname in ('chromium', 'webkit'):
            seed(False)
            b = getattr(pw, bname).launch()
            pg = b.new_page(viewport={'width': 1280, 'height': 900})
            errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
            pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
            pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); time.sleep(1.2)
            pg.click('button[data-p="cfg"]'); time.sleep(0.5)
            card = pg.locator('#elecCard'); card.scroll_into_view_if_needed()
            T = lambda: pg.inner_text('#elecCount')
            ck = pg.locator('#elecList .elec-ck')
            vals = [ck.nth(i).get_attribute('value') for i in range(ck.count())]
            ok(bname + ' 卡片出現、5 人（含 11/29 離職已停用的 E5、不含 10 月離職的 E6）、月份 2026-11', vals == ['E1', 'E2', 'E3', 'E4', 'E5'] and pg.inner_text('#elecYm') == '2026-11', (vals, pg.inner_text('#elecYm')))
            pg.fill('#elecDate', '2026-11-28'); ok(bname + ' 選日期', pg.input_value('#elecDate') == '2026-11-28')
            ck.nth(0).check(); ck.nth(2).check(); ok(bname + ' 勾兩人', T() == '已勾選 2 人', T())
            pg.click('#elecCard button:has-text("全選")'); ok(bname + ' 全選', T() == '已勾選 5 人', T())
            pg.click('#elecCard button:has-text("清除")'); ok(bname + ' 清除', T() == '已勾選 0 人', T())
            ck.nth(0).check(); ck.nth(4).check()   # E1 ＋ 停用離職的 E5（第一次建名單就勾得到，Codex 第三次 B2）
            shot(pg, bname, 'ui-1-checked.png', card)
            pg.click('#elecSave'); pg.wait_for_function("document.getElementById('msg').textContent.indexOf('已儲存選舉假名單')>=0", timeout=8000); time.sleep(0.3)
            msg = pg.inner_text('#msg')
            saved = api('payroll_master_get', store='SSLGF').get('hol_emp') or []
            ok(bname + ' 儲存成功（提示＋假後端存到 E1、停用離職的 E5）', '已儲存選舉假名單（2026-11-28，2 人）' in msg and sorted(x['emp_id'] for x in saved) == ['E1', 'E5'], (msg, saved))
            shot(pg, bname, 'ui-2-saved.png')
            # 儲存送出後、回應回來前：舊結果不能匯出、鎖定停用（Codex 第四次 B1）
            time.sleep(3)
            hs = {}
            def holdsave(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_hol_emp_set' and 'r' not in hs: hs['r'] = route; return
                route.continue_()
            pg.route('**/*', holdsave)
            pg.click('#elecSave')
            for _ in range(50):
                if 'r' in hs: break
                pg.wait_for_timeout(100)
            pg.evaluate('exportExcel()'); pg.wait_for_timeout(200)
            m1 = pg.inner_text('#msg')
            pg.evaluate('exportCSV()'); pg.wait_for_timeout(200)
            m2 = pg.inner_text('#msg')
            ok(bname + ' 儲存回應前：RESULTS 已作廢、匯出 Excel／CSV 都擋（請先計算）、鎖定鈕停用',
               'r' in hs and pg.evaluate('RESULTS.length') == 0 and '請先計算' in m1 and '請先計算' in m2 and pg.is_disabled('#lockBtn'), (list(hs), pg.evaluate('RESULTS.length'), m1, m2))
            if 'r' in hs: hs['r'].continue_()
            pg.wait_for_function("document.getElementById('msg').textContent.indexOf('已儲存選舉假名單')>=0", timeout=8000); time.sleep(0.5)
            ok(bname + ' 回應回來、重算成功 → 結果回來、鎖定鈕恢復', pg.evaluate('RESULTS.length') > 0 and not pg.is_disabled('#lockBtn'), pg.evaluate('RESULTS.length'))
            pg.unroute('**/*')
            # 儲存途中切到別個月：剛存的那個店月照樣重算（Codex 第四次 B3）
            time.sleep(3)
            hs2, calcs = {}, []
            def holdsave2(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_calc': calcs.append(body.get('ym'))
                if body.get('action') == 'payroll_hol_emp_set' and 'r' not in hs2: hs2['r'] = route; return
                route.continue_()
            pg.route('**/*', holdsave2)
            pg.click('#elecSave')
            for _ in range(50):
                if 'r' in hs2: break
                pg.wait_for_timeout(100)
            pg.evaluate("$('ym').value='2026-10'; $('ym').dispatchEvent(new Event('change'))"); pg.wait_for_timeout(2500)
            if 'r' in hs2: hs2['r'].continue_()
            pg.wait_for_function("document.getElementById('msg').textContent.indexOf('已儲存選舉假名單')>=0", timeout=8000); time.sleep(0.5)
            yv, mv = pg.input_value('#ym'), pg.inner_text('#msg')
            ok(bname + ' 儲存途中切到 10 月：11 月照樣重算（送出 payroll_calc ym=2026-11）、畫面仍是 10 月', '2026-11' in calcs and yv == '2026-10' and '已重新計算' in mv, (calcs, yv, mv))
            pg.unroute('**/*')
            pg.evaluate("$('ym').value='2026-11'; $('ym').dispatchEvent(new Event('change'))"); time.sleep(2.5)
            pg.click('button[data-p="cfg"]'); time.sleep(0.5)
            # 後端回提醒（模擬 warn_message）
            W = '已儲存。其中 1 人選舉日的加班先前已拿去抵補休；選舉假那天的加班不能抵補休，這 1 人的補休帳會變成負的，本月會鎖不了。請把多請的補休改成其他假別，或補核准加班申請。'
            def warn(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_hol_emp_set':
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'count': 2, 'warn_comp_negative': 1, 'warn_message': W}))
                else: route.continue_()
            time.sleep(3); pg.route('**/*', warn); pg.click('#elecSave'); pg.wait_for_function("document.getElementById('msg').textContent.indexOf('其中 1 人')>=0", timeout=8000)
            ok(bname + ' 儲存回 warn_message → 紅底提示', pg.inner_text('#msg') == W, pg.inner_text('#msg'))
            shot(pg, bname, 'ui-3-warn.png')
            pg.unroute('**/*')
            # 舊後端：unknown_action、沒有 message
            def old(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_hol_emp_set':
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'unknown_action'}))
                else: route.continue_()
            time.sleep(3); pg.route('**/*', old); pg.click('#elecSave'); time.sleep(1.2)
            ok(bname + ' 舊後端 unknown_action → 「儲存失敗：unknown_action」', pg.inner_text('#msg') == '儲存失敗：unknown_action', pg.inner_text('#msg'))
            shot(pg, bname, 'ui-4-oldbackend.png')
            pg.unroute('**/*')
            # 讀寫互斥版的「A 存檔在途時切到 10 月（沒有名單的月份）」：10 月的讀取等 A 的寫入結束才發；讀完後鎖定、重新計算鈕狀態正確
            def setym0(v): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(2500)
            time.sleep(3)
            h4, seen4 = {}, []
            def hold4(route):
                body = json.loads(route.request.post_data or '{}')
                seen4.append((body.get('action'), body.get('ym')))
                if body.get('action') == 'payroll_hol_emp_set' and body.get('ym') == '2026-11' and 'a' not in h4: h4['a'] = route; return
                route.continue_()
            pg.route('**/*', hold4)
            pg.click('#elecSave')
            for _ in range(50):
                if 'a' in h4: break
                pg.wait_for_timeout(100)
            k4 = len(seen4)
            setym0('2026-10')
            ok(bname + ' A（11 月）存檔在途時切到 10 月：10 月的讀取排隊、沒有發出（A 結束後才發）', 'a' in h4 and ('payroll_month', '2026-10') not in seen4[k4:] and pg.evaluate('!!LOAD_INFLIGHT'), (list(h4), seen4[k4:]))
            if 'a' in h4: h4['a'].continue_()
            pg.wait_for_timeout(4000)
            ok(bname + ' A 結束後 10 月讀取發出、讀完：鎖定、重新計算鈕不受影響（10 月沒有名單、沒有待確認）', ('payroll_month', '2026-10') in seen4[k4:] and not pg.evaluate('!!LOAD_INFLIGHT') and not pg.is_disabled('#lockBtn') and not pg.is_disabled('#calcBtn') and not pg.evaluate('monBlocked()'), (seen4[k4:], pg.is_disabled('#lockBtn'), pg.is_disabled('#calcBtn')))
            pg.unroute('**/*')
            setym0('2026-11'); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(400)
            pg.fill('#elecDate', '2026-11-28'); pg.locator('#elecList .elec-ck').nth(0).check()
            # 第四輪（讀寫互斥）取代原本的 Codex 第五次 B1：A 店月（11 月）存檔在途 → 切到 B（12 月）：B 的月資料讀取排隊、B 不能存；A 回來後 A 自己重算成功才放行
            def setym(v): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(2500)
            time.sleep(3)
            h5, seen5 = {}, []
            def hold5(route):
                body = json.loads(route.request.post_data or '{}')
                seen5.append((body.get('action'), body.get('ym')))
                if body.get('action') == 'payroll_hol_emp_set' and body.get('ym') == '2026-11' and 'a' not in h5: h5['a'] = route; return
                route.continue_()
            pg.route('**/*', hold5)
            pg.click('#elecSave')
            for _ in range(50):
                if 'a' in h5: break
                pg.wait_for_timeout(100)
            k5 = len(seen5)
            setym('2026-12')
            ok(bname + ' A（11 月）存檔在途：切到 12 月的月資料讀取排隊、沒有發出（讀寫互斥），畫面是讀取中',
               'a' in h5 and ('payroll_month', '2026-12') not in seen5[k5:] and pg.evaluate('!!LOAD_INFLIGHT'), (list(h5), seen5[k5:]))
            pg.evaluate("$('msg').textContent=''; exportExcel(); 0"); pg.wait_for_timeout(300)
            ok(bname + ' A 存檔在途（結果已作廢）時按匯出 Excel：擋下（請先計算），沒有匯出舊結果', '請先計算' in pg.inner_text('#msg') and pg.evaluate('RESULTS.length') == 0, (pg.inner_text('#msg'), pg.evaluate('RESULTS.length')))
            pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300)
            pg.evaluate("$('msg').textContent=''; saveElec(null); 0"); pg.wait_for_timeout(500)
            ok(bname + ' 讀取中按「儲存選舉假名單」：不送 payroll_hol_emp_set（12 月）、提示「讀取中…」', ('payroll_hol_emp_set', '2026-12') not in seen5[k5:] and pg.inner_text('#msg') == '讀取中…', (seen5[k5:], pg.inner_text('#msg')))
            if 'a' in h5: h5['a'].continue_()
            pg.wait_for_function("document.getElementById('msg').textContent.indexOf('已儲存選舉假名單（2026-11-28')>=0", timeout=10000); pg.wait_for_timeout(3000)
            ok(bname + ' A 的存檔回來後：12 月讀取在 A 的寫入結束後才發出、讀取結束', ('payroll_month', '2026-12') in seen5[k5:] and not pg.evaluate('!!LOAD_INFLIGHT'), (seen5[k5:], pg.evaluate('!!LOAD_INFLIGHT')))
            setym('2026-11'); pg.click('button[data-p="run"]'); pg.wait_for_timeout(400)
            n5, d5, c5 = pg.evaluate('RESULTS.length'), pg.is_disabled('#lockBtn'), pg.is_disabled('#calcBtn')
            ok(bname + ' 切回 A（11 月）：A 的重算已完成、結果回來、鎖定與重新計算鈕可用', n5 > 0 and not d5 and not c5 and not pg.evaluate('monBlocked()'), (n5, d5, c5))
            pg.unroute('**/*')
            # Codex 第五次 B2：A 存檔回來時人在 B → A 背景重算在途時切回 A：A 先擋；背景重算完成後重讀 A 才放行
            time.sleep(3)
            h6, seen6 = {}, []
            def hold6(route):
                body = json.loads(route.request.post_data or '{}')
                a6 = body.get('action'); seen6.append((a6, body.get('ym')))
                if a6 == 'payroll_hol_emp_set' and 's' not in h6: h6['s'] = route; return
                if a6 == 'payroll_calc' and body.get('ym') == '2026-11' and 's' in h6 and 'c' not in h6: h6['c'] = route; return
                route.continue_()
            pg.route('**/*', hold6)
            pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300); pg.click('#elecSave')
            for _ in range(50):
                if 's' in h6: break
                pg.wait_for_timeout(100)
            setym('2026-10')
            if 's' in h6: h6['s'].continue_()
            for _ in range(60):
                if 'c' in h6: break
                pg.wait_for_timeout(100)
            setym('2026-11'); pg.click('button[data-p="run"]'); pg.wait_for_timeout(400)
            n6, d6 = pg.evaluate('RESULTS.length'), pg.is_disabled('#lockBtn')
            ok(bname + ' A 背景重算在途時切回 A：不顯示舊數字、鎖定鈕停用', 'c' in h6 and n6 == 0 and d6, (list(h6), n6, d6))
            k6 = len(seen6)
            if 'c' in h6: h6['c'].continue_()
            pg.wait_for_timeout(3000)
            after = seen6[k6:]
            ok(bname + ' 背景重算完成 → 重讀 A（payroll_month 11 月）後才放行', ('payroll_month', '2026-11') in after and pg.evaluate('RESULTS.length') > 0 and not pg.is_disabled('#lockBtn'), (after, pg.evaluate('RESULTS.length')))
            pg.unroute('**/*')
            # Codex 第五次 B2(b)：鎖定成功後一律重讀這個月（畫面就是鎖進去的那份）
            seen7 = []
            def lock7(route):
                body = json.loads(route.request.post_data or '{}')
                seen7.append(body.get('action'))
                if body.get('action') == 'payroll_finalize':
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'ym': '2026-11', 'status': 'final', 'count': 4})); return
                route.continue_()
            pg.route('**/*', lock7); pg.click('#lockBtn'); pg.wait_for_timeout(3000)
            ok(bname + ' 鎖定成功後重讀這個月（finalize 之後有 payroll_month）', 'payroll_finalize' in seen7 and 'payroll_month' in seen7[seen7.index('payroll_finalize'):], seen7)
            pg.unroute('**/*')
            seed(False); setym('2026-10'); setym('2026-11'); pg.click('button[data-p="cfg"]'); time.sleep(0.5)
            # 存檔成功但自動重算失敗（後端回 hol_emp_changed）→ 舊結果作廢、提示失敗（Codex 複審 K3）
            def calcfail(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_calc':
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'hol_emp_changed', 'message': '計算途中選舉假名單有改過，這次重算沒有寫入，請再按一次重新計算'}))
                else: route.continue_()
            time.sleep(3); pg.route('**/*', calcfail); pg.click('#elecSave')
            pg.wait_for_function("document.getElementById('msg').textContent.indexOf('名單已儲存，但重新計算沒有完成')>=0", timeout=8000)
            ok(bname + ' 存檔後重算失敗 → 提示失敗、RESULTS 清空（薪資單／匯出要先計算）', pg.evaluate('RESULTS.length') == 0 and '已重新計算' not in pg.inner_text('#msg'), (pg.inner_text('#msg'), pg.evaluate('RESULTS.length')))
            shot(pg, bname, 'ui-6-calcfail.png')
            pg.unroute('**/*')
            # 重算失敗之後重新整理頁面：後端（正式版）會回 elec_stale（草稿存的名單指紋不同、自動重算也沒成功）→ 仍顯示要重算、不能匯出舊結果（Codex 第三次 B1）
            def stale(route):
                body = json.loads(route.request.post_data or '{}')
                if body.get('action') == 'payroll_month' and body.get('ym') == '2026-11':
                    r = route.fetch(); j = r.json(); j['elec_stale'] = True
                    route.fulfill(status=200, content_type='application/json', body=json.dumps(j))
                else: route.continue_()
            time.sleep(1); pg.route('**/*', stale); pg.reload(wait_until='networkidle'); time.sleep(1.5)
            pg.click('button[data-p="run"]'); time.sleep(0.5)
            ok(bname + ' 重新整理後 elec_stale → 不顯示舊草稿（RESULTS 0）、計算表顯示要再按重新計算', pg.evaluate('RESULTS.length') == 0 and STALE_TXT in pg.inner_text('#runTbl'), (pg.evaluate('RESULTS.length'), pg.inner_text('#runTbl')[:80]))
            shot(pg, bname, 'ui-7-stale-reload.png')
            pg.evaluate('exportExcel()'); time.sleep(0.3)
            ok(bname + ' 這時按匯出 Excel → 擋下（請先計算），沒有匯出舊結果', '請先計算' in pg.inner_text('#msg'), pg.inner_text('#msg'))
            pg.evaluate('exportCSV()'); time.sleep(0.3)
            ok(bname + ' 匯出 CSV 也擋', '請先計算' in pg.inner_text('#msg'), pg.inner_text('#msg'))
            pg.unroute('**/*')
            pg.evaluate('doCalc()'); time.sleep(2.5)
            ok(bname + ' 再按重新計算成功 → 結果回來、過期狀態解除', pg.evaluate('RESULTS.length') > 0 and pg.evaluate('ELEC_STALE') is False and STALE_TXT not in pg.inner_text('#runTbl'), (pg.evaluate('RESULTS.length'), pg.evaluate('ELEC_STALE')))
            # 開頁預抓的 payroll_month（11 月）卡住，使用者先切到 10 月；之後預抓才回來 → 不可蓋掉 10 月畫面（Codex 第三次 S5）
            seed(False)
            held = {}
            def hold(route):
                body = json.loads(route.request.post_data or '{}')
                a = body.get('action')
                if a in ('payroll_master_get', 'payroll_month') and a not in held and len(held) < 2 and (a != 'payroll_month' or body.get('ym') == '2026-11'):
                    held[a] = route; return
                route.continue_()
            pg.route('**/*', hold)
            pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='domcontentloaded')
            for _ in range(60):
                if len(held) == 2: break
                pg.wait_for_timeout(100)
            ok(bname + ' 預抓（主檔＋11 月）都卡住', len(held) == 2, list(held))
            pg.evaluate("$('ym').value='2026-10'; $('ym').dispatchEvent(new Event('change'))"); pg.wait_for_timeout(2500)
            if 'payroll_master_get' in held: held['payroll_master_get'].continue_()
            pg.wait_for_timeout(1500)
            if 'payroll_month' in held: held['payroll_month'].continue_()
            pg.wait_for_timeout(2500)
            el = pg.evaluate("RESULTS.some(r=>(r.earn||[]).some(x=>String(x.item_label).indexOf('選舉日出勤')===0))")
            ok(bname + ' 切到 10 月後晚到的 11 月預抓不套用（畫面月份 10 月、沒有 11 月的選舉日出勤列、名單卡片綁 10 月）',
               pg.input_value('#ym') == '2026-10' and not el and pg.evaluate('ELEC_KEY') == pg.evaluate("STORE+'|2026-10'"), (pg.input_value('#ym'), el, pg.evaluate('ELEC_KEY')))
            pg.unroute('**/*')
            # 舊月份：卡片直接停用（Codex 複審 S1）
            pg.click('button[data-p="cfg"]'); time.sleep(0.5)
            ok(bname + ' 2026-10：卡片停用＋說明', pg.is_disabled('#elecSave') and '2026-11 起才能用' in pg.inner_text('#elecLock'), pg.inner_text('#elecLock'))
            pg.evaluate("$('ym').value='2026-11'; $('ym').dispatchEvent(new Event('change'))"); time.sleep(2.5)
            # 已鎖定月份
            seed(True); pg.reload(wait_until='networkidle'); time.sleep(1.2)
            pg.click('button[data-p="cfg"]'); time.sleep(0.5)
            ck = pg.locator('#elecList .elec-ck')
            dis = all(ck.nth(i).is_disabled() for i in range(ck.count()))
            ok(bname + ' 已鎖定：勾選、日期、儲存都停用＋紅字說明', dis and pg.is_disabled('#elecSave') and pg.is_disabled('#elecDate') and '已鎖定' in pg.inner_text('#elecLock'), (dis, pg.inner_text('#elecLock')))
            shot(pg, bname, 'ui-5-locked.png', pg.locator('#elecCard'))
            ok(bname + ' 沒有 JS 錯誤', not errs, errs[:3])
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
