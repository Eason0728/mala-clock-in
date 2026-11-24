# 班表排了「國定假日假」、薪資國定假日清單沒有那天 → 薪資頁提醒區黃字（2026-11-23，feat/pay-hol-sched-hint）：假後端＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/hol-sched-gap-e2e.py
#   同 tests/ui/pay-html-followups-e2e.py 的假資料（虛構同仁「測試甲～丁」）與假後端（mock/mock_server.py，隨機埠、只綁 127.0.0.1），不碰正式試算表。
#   後端的 hol_sched_gap 由攔截器塞進假後端的回應（假後端跑的是畫面測試用的 11 月資料；偵測規則本身在 tests/hol-sched-gap.test.js 驗）。
#   跑完用自己的程序代號收掉假後端，並刪掉 mock/mock_data.json。
#   E2E_ROOT＝拿別的版本的 payroll.html 跑（例：改版前 473c6cb 的解壓目錄）——H1、H3、H4 改版前應該紅。
# 規則：
#   H1 payroll_month 帶 hol_sched_gap → 提醒區出現「國定假日清單可能漏了日子」，日期、人數、姓名照回應；超過 5 人只列 5 個加「等」；姓名有 HTML 照字面顯示
#   H2 沒帶 hol_sched_gap → 不出現（提醒區其他內容照舊）
#   H3 跟「跨帳號重複」提醒同時存在：兩行都在、跨帳號那行文字不變
#   H4 重新計算（payroll_calc）帶 → 出現；再算一次不帶 → 消失（不殘留上一份）
#   H5 不影響鎖定：有提示時按「鎖定本月」照樣送出 payroll_finalize（跟沒有提示時一樣），對話框沒有多出國定假日的字
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.environ.get('E2E_ROOT') or os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))   # 種子資料一律用本版的測試檔
MOCK = os.path.join(ROOT, 'mock'); DATA = os.path.join(MOCK, 'mock_data.json')
NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')

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
sd = json.loads(subprocess.run([NODE, '-e', SEEDJS, SRC], capture_output=True, text=True, check=True).stdout)

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
_wd = threading.Timer(int(os.environ.get('E2E_WATCHDOG', '600')), _watchdog); _wd.daemon = True; _wd.start()
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

TITLE = '國定假日清單可能漏了日子'
GAP = [{'date': '2026-11-24', 'n': 2, 'names': ['測試乙', '測試丙']},
       {'date': '2026-11-27', 'n': 7, 'names': ['甲一', '乙二', '丙三', '丁四', '戊五', '己六', '<i>庚七</i>']}]
DUP_LINE = '提醒：11/10 測試二店帳號（T20）登記了出差 整天 8 小時，跟測試店帳號（E01）的出差時段重疊，請確認是不是重複申請。'
STOP = {'ok': False, 'error': 'test_stop', 'message': '測試攔下（沒有真的鎖定）'}

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
            dialogs = []
            def on_dialog(d):
                dialogs.append(d.message); d.accept()
            pg.on('dialog', on_dialog)
            seen, cfg = [], {}
            def patch(j):   # 照 cfg 改假後端的回應
                if not isinstance(j, dict) or not j.get('ok'): return j
                j.pop('asof', None)   # 假後端照真實今天把 11 月當「本月」→ 拿掉月中說明，鎖定鈕才會真的送（H5）
                if cfg.get('gap') is not None: j['hol_sched_gap'] = cfg['gap']
                if cfg.get('dup'):
                    j['dup_xacct_on'] = True
                    rs = j.get('results') or ((j.get('run') or {}).get('results')) or []
                    for r in rs[:1]:
                        o = r.get('ot_info')
                        if isinstance(o, str): o = json.loads(o or '{}')
                        o = o or {}; o.setdefault('ot_h', 0); o['dup_xacct'] = [{'pay': False, 'line': DUP_LINE}]; r['ot_info'] = o
                return j
            def router(route):
                bd = act(route); a = bd.get('action'); seen.append(bd)
                if a == 'payroll_finalize': fulfill(route, STOP); return
                if a in ('payroll_month', 'payroll_calc'):
                    bd2 = dict(bd)
                    if a == 'payroll_calc': bd2['inputs'] = {}   # 正式後端只拿 inputs 來算、不存（假後端會存）
                    resp = route.fetch(post_data=json.dumps(bd2)); fulfill(route, patch(resp.json())); return
                route.continue_()
            def fresh(**c):
                seed(); cfg.clear(); cfg.update(c); del seen[:]; del dialogs[:]
                pg.unroute('**/*')
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
                pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
                pg.route('**/*', router)
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1500)
                pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
            info = lambda: pg.evaluate("(()=>{const b=document.getElementById('otInfo'); return b?b.innerText:''})()")
            sent = lambda a, k=0: [x for x in seen[k:] if x.get('action') == a]

            # H1
            fresh(gap=GAP)
            t = info()
            line = [l for l in t.split('\n') if TITLE in l]
            ok(bname + ' H1 payroll_month 帶 hol_sched_gap → 提醒區出現這一行、看得到', bool(line) and pg.is_visible('#otInfo'), t[:200])
            L = line[0] if line else ''
            ok(bname + ' H1 日期、人數、姓名照回應：11/24（2 人：測試乙、測試丙）', '11/24（2 人：測試乙、測試丙）' in L, L)
            ok(bname + ' H1 超過 5 人只列 5 個加「等」：11/27（7 人：甲一、乙二、丙三、丁四、戊五 等）', '11/27（7 人：甲一、乙二、丙三、丁四、戊五 等）' in L and '己六' not in L, L)
            ok(bname + ' H1 整句逐字＝2026-11-23 主管同意修正後的長版（影響兩種、下一步、不擋鎖定）',
               L.strip() == '國定假日清單可能漏了日子：班表有同仁排了「國定假日假」，但「2 參數設定」的國定假日雙薪日沒有這幾天：11/24（2 人：測試乙、測試丙）、11/27（7 人：甲一、乙二、丙三、丁四、戊五 等）。影響有兩種：①那天有上班的同仁，不會算國定假日加給。②排了這天國定假日假的正職，系統會當成他把國定假日調到這天休，他本人在同一期（28 天）其他國定假日上班時就不再加給。請先核對雙薪日：清單漏了，請找資訊部同步後再重新計算；如果同仁本來就是把國定假日調到這天休，照現況即可。這個提醒不會擋鎖定。', L)
            fresh(gap=[{'date': '2026-11-24', 'n': 1, 'names': ['<img src=x onerror=window.__x=1>']}])
            ok(bname + ' H1 姓名有 HTML 照字面顯示、不執行', '<img src=x onerror=window.__x=1>' in info() and not pg.evaluate('!!window.__x'), info()[:200])

            # H2
            fresh()
            t = info()
            ok(bname + ' H2 沒帶 hol_sched_gap → 不出現', TITLE not in t, t[:200])

            # H3
            fresh(gap=GAP, dup=True)
            t = info()
            ok(bname + ' H3 跟跨帳號重複提醒同時存在：兩行都在、跨帳號那行文字不變', TITLE in t and DUP_LINE in t, t[:300])
            fresh(dup=True)
            t2 = info()
            ok(bname + ' H3 對照：只有跨帳號重複時，那行照舊、沒有國定假日那行', DUP_LINE in t2 and TITLE not in t2, t2[:300])

            # H4
            fresh()
            cfg['gap'] = GAP; k = len(seen)
            pg.click('#calcBtn'); pg.wait_for_timeout(3000)
            ok(bname + ' H4 重新計算回應帶 → 出現', sent('payroll_calc', k) and TITLE in info(), info()[:200])
            cfg['gap'] = None; k = len(seen)
            pg.click('#calcBtn'); pg.wait_for_timeout(3000)
            ok(bname + ' H4 再算一次不帶 → 消失（不殘留上一份）', sent('payroll_calc', k) and TITLE not in info(), info()[:200])

            # H5
            for lab, c in (('有提示', {'gap': GAP}), ('沒提示（對照）', {})):
                fresh(**c)
                shown = TITLE in info()
                del dialogs[:]; k = len(seen)
                pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                fz = sent('payroll_finalize', k)
                ok(bname + ' H5 ' + lab + '：按鎖定本月 → 照樣送出 payroll_finalize（lock=true），對話框沒有國定假日的字',
                   shown == bool(c) and len(fz) == 1 and fz[0].get('lock') is True and not any('國定假日' in d for d in dialogs), (shown, [x.get('lock') for x in fz], dialogs))
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
