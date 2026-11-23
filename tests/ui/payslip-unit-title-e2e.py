# 薪資單抬頭＝所屬計薪單位的名稱：假後端（mock/mock_server.py）＋Playwright（Chromium、WebKit）。
# 含：薪資單／匯出明細頁／Excel 三處標題都跟畫面上那份資料同一個單位（走真實載入流程：切單位、切月份、重新計算、讀取失敗、A→B→A 快速連切＋舊回應晚到），
#     以及很長的單位名稱版面。資料用攔截把每位同仁的名字尾巴加上「@單位代號」，這樣看得出資料是哪個單位的。
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
    p['run'] = [dict(r, status='draft') for r in sd['results']] + [dict(r, status='draft', ym='2026-10') for r in sd['results']]
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
            # ── 標題跟資料同一個單位（走真實載入流程）──
            WANT = dict((c, w) for c, _, w in UNITS)
            def fresh(store, long_name=None, width=1280):
                st = [{'code': c, 'name': n, 'active': True} for c, n, _ in UNITS]
                if long_name: st[0]['name'] = long_name
                seed(st)
                ctx = b.new_context(viewport={'width': width, 'height': 900})
                ctx.add_init_script("window.__blobs=[];const o=URL.createObjectURL;URL.createObjectURL=function(x){window.__blobs.push(x);return o.call(URL,x)}")
                pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
                S = {'hold': {}, 'fail': set(), 'held': {}}
                def tag(j, body):
                    st_ = body.get('store') or ''
                    rs = ((j.get('run') or {}).get('results') if body.get('action') == 'payroll_month' else j.get('results')) or []
                    for r in rs: r['name'] = r['name'].split('@')[0] + '@' + st_
                def proc(route, body):
                    if (body.get('action'), body.get('store')) in S['fail']:
                        return route.fulfill(status=200, headers={'content-type': 'application/json'}, body=json.dumps({'ok': False, 'error': 'boom', 'message': '讀取失敗(測試)'}))
                    resp = route.fetch(); j = resp.json()
                    if body.get('action') in ('payroll_month', 'payroll_calc') and j.get('ok'): tag(j, body)
                    route.fulfill(status=200, headers={'content-type': 'application/json'}, body=json.dumps(j))
                def handler(route):
                    if route.request.method != 'POST': return route.continue_()
                    body = json.loads(route.request.post_data or '{}'); k = (body.get('action'), body.get('store'))
                    if k in S['hold'] and S['hold'][k] and not S['held'].get(k):
                        S['held'][k] = (route, body); return
                    proc(route, body)
                pg.route('**/*', handler)
                def release(k):
                    route, body = S['held'].pop(k); S['hold'][k] = False; proc(route, body)
                pg.goto(BASE + '/payroll.html?k=test-admin&store=' + store, wait_until='networkidle'); time.sleep(1.5)
                return pg, S, release, errs
            def shot3(pg):
                """畫面上現在的三處標題與資料：薪資單、匯出明細頁（不重畫，看螢幕上現成的）、Excel（被擋＝None）"""
                return pg.evaluate("""async()=>{
                  const t=document.querySelector('#slipWrap .slip .sub'), ex=document.querySelector('#exportDetail .card > div'), nm=document.querySelector('#exportDetail .exp-person b'), op=document.querySelector('#slipSel option');
                  const n0=window.__blobs.length; exportExcel(); let xls=null;
                  if(window.__blobs.length>n0) xls=await window.__blobs[window.__blobs.length-1].text();
                  return {slip:t&&t.textContent.split(' ｜ ')[0], slipName:op&&op.textContent, exp:ex&&ex.textContent.replace(' 薪資明細',''), expName:nm&&nm.textContent,
                          xls:xls&&(/<h3>(.*?) 薪資明細/.exec(xls)||[])[1], xlsName:xls&&(/<td>(測試.@\w+)<\/td>/.exec(xls)||[])[1]};}""")
            def consistent(label, pg, unit, xls=True):
                r = shot3(pg); want = WANT[unit]
                good = r['slip'] == want and r['exp'] == want and (r['xls'] == want if xls is True else (r['xls'] in (None, want))) \
                       and all(str(r[k]).endswith('@' + unit) for k in ('slipName', 'expName') + (('xlsName',) if xls is True else ()))
                ok('%s %s：三處標題與資料都是 %s' % (bname, label, unit), good, r)
            def pick(pg, code): pg.select_option('#storeSel', code); time.sleep(0.8)
            # 1 切單位：資料還沒回來＝仍是 A；回來＝B
            pg, S, rel, errs = fresh('SSLGF')
            consistent('開頁載入完成', pg, 'SSLGF')
            S['hold'][('payroll_month', 'MZTJS')] = True
            pick(pg, 'MZTJS'); consistent('切到 B、B 資料還沒回來', pg, 'SSLGF')
            rel(('payroll_month', 'MZTJS')); time.sleep(1.5); consistent('B 資料回來', pg, 'MZTJS')
            # 2 切月份（B 單位內）
            pg.evaluate("$('ym').value='2026-10'; $('ym').dispatchEvent(new Event('change'))"); time.sleep(2.5)
            consistent('切月份後', pg, 'MZTJS')
            # 3 重新計算
            pg.evaluate("$('ym').value='2026-11'; $('ym').dispatchEvent(new Event('change'))"); time.sleep(2.5)
            pg.evaluate('doCalc()'); time.sleep(2.5); consistent('重新計算後', pg, 'MZTJS')
            # 4 讀取失敗後：切回 A 失敗，畫面還是 B 的資料 → 標題也要是 B；Excel 被擋
            S['fail'].add(('payroll_month', 'SSLGF'))
            pick(pg, 'SSLGF'); time.sleep(1.5); consistent('讀取失敗後（畫面仍是 B 的資料）', pg, 'MZTJS', xls='blocked-or-B')
            ok(bname + ' 流程 1–4 沒有 JS 錯誤', not errs, errs[:3]); (pg.unroute_all(behavior='ignoreErrors'), pg.context.close())
            # 5 A→B→A 快速連切、較早的回應晚到
            pg, S, rel, errs = fresh('SSLGF')
            S['hold'][('payroll_month', 'MZTJS')] = True; S['hold'][('payroll_month', 'SSLGF')] = True
            pick(pg, 'MZTJS'); pick(pg, 'SSLGF')
            consistent('A→B→A 連切、兩個回應都還沒回來', pg, 'SSLGF')
            rel(('payroll_month', 'MZTJS')); time.sleep(1.2)
            consistent('A→B→A：較早的 B 回應先到（不可蓋掉）', pg, 'SSLGF')
            rel(('payroll_month', 'SSLGF')); time.sleep(1.5)
            consistent('A→B→A：最後的 A 回應到了', pg, 'SSLGF')
            # 5b B 的回應最晚才到
            S['hold'][('payroll_month', 'MZTJS')] = True
            pick(pg, 'MZTJS'); pick(pg, 'SSLGF'); time.sleep(1.5)
            rel(('payroll_month', 'MZTJS')); time.sleep(1.5)
            consistent('A→B→A：A 先回來、B 晚到', pg, 'SSLGF')
            ok(bname + ' 流程 5 沒有 JS 錯誤', not errs, errs[:3]); (pg.unroute_all(behavior='ignoreErrors'), pg.context.close())
            # 6 很長的單位名稱：不破版、不被切（截圖）
            LONG_CJK = '麻的小辛辣 新竹光復店附設中央廚房暨營運支援總部辦公室第二分處臨時工作站'
            LONG_LATIN = 'Verylongbrandnamewithoutanyspaces' * 4 + ' 分店名稱也很長很長很長很長很長很長很長很長很長很長'
            for tag_, nm in (('cjk', LONG_CJK), ('latin', LONG_LATIN)):
                for width in (1280, 375):
                    pg, S, rel, errs = fresh('SSLGF', long_name=nm, width=width)
                    pg.click('button[data-p="slip"]'); time.sleep(0.4)
                    geo = lambda sel: pg.evaluate("(s)=>{const e=document.querySelector(s);const r=e.getBoundingClientRect();return {sw:e.scrollWidth,cw:e.clientWidth,l:Math.round(r.left),r:Math.round(r.right),vw:innerWidth}}", sel)
                    g1 = geo('#slipWrap .slip .sub')
                    ok('%s 長名稱(%s) %dpx 薪資單抬頭沒有被切、整段在畫面內' % (bname, tag_, width), g1['sw'] <= g1['cw'] + 1 and g1['l'] >= 0 and g1['r'] <= g1['vw'], g1)
                    if OUT and bname == 'chromium': pg.evaluate("document.getElementById('msg').style.display='none'"); pg.locator('#slipWrap').screenshot(path=os.path.join(OUT, 'long-slip-%s-%d.png' % (tag_, width)))
                    pg.click('button[data-p="export"]'); time.sleep(0.4)
                    g2 = geo('#exportDetail .card > div')
                    ok('%s 長名稱(%s) %dpx 匯出明細頁標題沒有被切、整段在畫面內' % (bname, tag_, width), g2['sw'] <= g2['cw'] + 1 and g2['l'] >= 0 and g2['r'] <= g2['vw'], g2)
                    if OUT and bname == 'chromium': pg.evaluate("document.getElementById('msg').style.display='none'"); pg.locator('#exportDetail > .card').first.screenshot(path=os.path.join(OUT, 'long-export-%s-%d.png' % (tag_, width)))
                    (pg.unroute_all(behavior='ignoreErrors'), pg.context.close())
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
