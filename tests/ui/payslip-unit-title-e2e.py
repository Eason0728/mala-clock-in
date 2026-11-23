# 薪資單抬頭＝所屬計薪單位的名稱：假後端（mock/mock_server.py）＋Playwright（Chromium、WebKit）。
# 用法（repo 根目錄）：python3 tests/ui/payslip-unit-title-e2e.py [截圖資料夾]
#   需要 python 的 playwright（含 chromium、webkit）、node。假資料由 tests/election-day-emp.test.js 的 world() 算出（虛構同仁「測試甲～丁」），
#   單位名稱是門市表樣式的假資料；假後端開在隨機埠、只綁 127.0.0.1，跑完用自己的程序代號收掉並刪掉 mock/mock_data.json。不碰任何正式試算表。
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else None
if OUT: os.makedirs(OUT, exist_ok=True)
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
sd = json.loads(subprocess.run([NODE, '-e', SEEDJS, ROOT], capture_output=True, text=True, check=True).stdout)
UNITS = [('SSLGF', '麻的小辛辣 新竹光復店', '麻的小辛辣 · 新竹光復店'), ('MZTJS', '墨竹亭 新竹金山店', '墨竹亭 · 新竹金山店'),
         ('CF', '央廚', '央廚'), ('HQ', '鼎兆元 總部', '鼎兆元 · 總部')]

s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
proc = subprocess.Popen([sys.executable, 'mock_server.py'], cwd=MOCK, env=dict(os.environ, MOCK_PORT=str(PORT), MOCK_NODE=NODE),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
BASE = 'http://localhost:%d' % PORT
def api(action, **b):
    req = urllib.request.Request(BASE + '/api', data=json.dumps(dict(action=action, admin_key='test-admin', **b)).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())
def seed(stores):
    d = json.load(open(DATA, encoding='utf-8'))
    p = d.setdefault('payroll', {})
    p['master'] = sd['master']; p['hol_emp'] = []
    p['run'] = [dict(r, status='final') for r in sd['results']]
    p['holiday'] = [{'ym': '2026-11', 'red_days': 9, 'note': '', 'dates': '', 'store': ''}]
    p['store'] = stores
    p.setdefault('config', {})['payday'] = 10   # 假後端沒有預設參數列時薪資單會印 undefined；正式後端 payConfig 一定帶預設 10
    json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/payroll.html', timeout=1); break
        except Exception: time.sleep(0.2)
    api('payroll_master_get')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        for bname in ('chromium', 'webkit'):
            b = getattr(pw, bname).launch()
            for i, (code, name, want) in enumerate(UNITS):
                seed([{'code': c, 'name': n, 'active': True} for c, n, _ in UNITS])
                pg = b.new_page(viewport={'width': 1280, 'height': 900})
                errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
                pg.goto(BASE + '/payroll.html?k=test-admin&store=' + code, wait_until='networkidle'); time.sleep(1.5)
                pg.click('button[data-p="slip"]'); time.sleep(0.4)
                sub = pg.inner_text('#slipWrap .slip .sub')
                ok('%s %s 薪資單抬頭「%s」' % (bname, code, want), sub.startswith(want + ' ｜ 2026年11月 ｜ 發薪日 每月 10 日'), sub)
                if OUT and bname == 'chromium': pg.evaluate("document.getElementById('msg').style.display='none'"); pg.locator('#slipWrap').screenshot(path=os.path.join(OUT, 'slip-%s.png' % code))
                ok('%s %s 沒有 JS 錯誤' % (bname, code), not errs, errs[:3])
                pg.close()
            # 用門市下拉切換：抬頭跟著換
            seed([{'code': c, 'name': n, 'active': True} for c, n, _ in UNITS])
            pg = b.new_page(viewport={'width': 1280, 'height': 900})
            pg.goto(BASE + '/payroll.html?k=test-admin&store=SSLGF', wait_until='networkidle'); time.sleep(1.5)
            pg.select_option('#storeSel', 'MZTJS'); time.sleep(2.5)
            pg.click('button[data-p="slip"]'); time.sleep(0.4)
            sub = pg.inner_text('#slipWrap .slip .sub')
            ok(bname + ' 用門市下拉切到墨竹亭金山後，薪資單抬頭是墨竹亭 · 新竹金山店', sub.startswith('墨竹亭 · 新竹金山店 ｜ '), sub)
            pg.close()
            # 門市表沒有名稱 → 印代號，不印光復店
            seed([{'code': 'CF', 'name': '', 'active': True}, {'code': 'SSLGF', 'name': '麻的小辛辣 新竹光復店', 'active': True}])
            pg = b.new_page(viewport={'width': 1280, 'height': 900})
            pg.goto(BASE + '/payroll.html?k=test-admin&store=CF', wait_until='networkidle'); time.sleep(1.5)
            pg.click('button[data-p="slip"]'); time.sleep(0.4)
            sub = pg.inner_text('#slipWrap .slip .sub')
            ok(bname + ' 門市表該列名稱空白 → 抬頭印代號 CF', sub.startswith('CF ｜ ') and '光復' not in sub, sub)
            if OUT and bname == 'chromium': pg.evaluate("document.getElementById('msg').style.display='none'"); pg.locator('#slipWrap').screenshot(path=os.path.join(OUT, 'slip-fallback-CF.png'))
            pg.close()
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
