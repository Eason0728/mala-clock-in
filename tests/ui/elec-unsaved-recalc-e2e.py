# Codex 複審 2026-11-22 BLOCKER（#214 第 5 點「讀取失敗後重算成功自動重新載入」會丟掉尚未儲存的工時調整）＋殘餘（鎖定回應遺失後狀態查詢回 mixed）
# 假後端＋Playwright，Chromium、WebKit 各跑一次。用法（repo 根目錄）：python3 tests/ui/elec-unsaved-recalc-e2e.py [J,K,L]
#   同 tests/ui/elec-status-followup-e2e.py 的假資料（虛構同仁「測試甲～丁」）與假後端（mock/mock_server.py，隨機埠、只綁 127.0.0.1），不碰正式試算表。
#   E2E_ROOT＝拿別的版本的 payroll.html 跑（例：線上版對照）；E2E_OBSERVE=1＝只印觀察到的現象、不判紅綠（線上版沒有讀取失敗旗標，擋不擋本來就不適用）。
#   ⚠ 假後端的 payroll_calc 會把送來的 inputs 存進工時表（正式 handlePayrollCalc 不會存，只拿來算）；這裡把送給假後端的 inputs 拿掉，
#     只記下前端送了什麼，才跟正式後端一致（不然「重新載入」會把未存的調整讀回來，看不出問題）。
#   ⚠ 假後端的 payroll_input_set 不落地（mock_server.py 沒有包 _persist），所以「存好」只驗送出的內容含 500，不驗重新載入後讀回 500。
# 規則：
#   J  這個月讀取失敗（旗標在）時，出勤表單有尚未儲存的編輯 → 按「重新計算」成功後不自動重新載入：未存編輯與「儲存工時 ●」都還在，
#      匯出（Excel／CSV／PDF）、薪資單列印、鎖定照擋（提示同一句）；按「儲存工時」→ 存好、重算、重新載入成功 → 才解開
#   K  沒有未存編輯：#214 第 5 點照舊（重算成功 → 自動重新載入 → 成功才解開）
#   L  鎖定的回應斷掉、狀態查詢回 mixed（一部分已鎖定）→ 提示照舊，並設讀取失敗旗標（匯出、列印、鎖定擋）；重新載入成功才解開
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.environ.get('E2E_ROOT') or os.path.join(os.path.dirname(__file__), '..', '..'))
MOCK = os.path.join(ROOT, 'mock'); DATA = os.path.join(MOCK, 'mock_data.json')
NODE = shutil.which('node') or os.path.expanduser('~/.local/node/bin/node')
ONLY = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None
OBSERVE = os.environ.get('E2E_OBSERVE') == '1'

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
EMP = str([m for m in sd['master'] if str(m.get('active', 'true')).lower() == 'true'][0]['emp_id'])
H_A, H_B = 111, 77   # 已存工時：11 月（月份 A）111 小時、10 月（月份 B）77 小時——看得出畫面上是哪個月的表單

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
    p['input'] = [{'ym': '2026-11', 'emp_id': EMP, 'hours': H_A, 'support': []}, {'ym': '2026-10', 'emp_id': EMP, 'hours': H_B, 'support': []}]
    json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
results = []
def ok(name, cond, extra=''):
    if OBSERVE: print('· ' + name + '：' + ('符合' if cond else '不符合') + ' ' + str(extra)); return
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))
def act(route):
    try: return json.loads(route.request.post_data or '{}')
    except Exception: return {}
def fulfill(route, obj): route.fulfill(status=200, content_type='application/json', body=json.dumps(obj))
UNSURE_TXT = '這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出'
MIXED_TXT = '這個月有一部分已鎖定、一部分還是草稿，請重新整理頁面看狀態；重新整理後還是這樣請找資訊部'
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
            pg.on('dialog', lambda d: d.accept())
            def fresh():
                seed()
                pg.unroute('**/*')
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
                pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200)
                pg.evaluate("window.__pr=0; window.print=function(){ window.__pr++; }; window.open=function(){ window.__pr++; return null; }; 0")
            def setym(v, wait=2500): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(wait)
            msg = lambda: pg.inner_text('#msg')
            clear_msg = lambda: pg.evaluate("$('msg').textContent=''; 0")
            blocked = lambda: pg.evaluate("typeof monBlocked==='function'?monBlocked():null")
            dirty = lambda: pg.evaluate('ATT_DIRTY')
            dot = lambda: '●' in pg.inner_text('#saveAttBtn')
            prints = lambda: pg.evaluate('window.__pr')
            att = lambda k: pg.evaluate("(ATT[%s]||{})[%s]" % (json.dumps(EMP), json.dumps(k)))
            def exp_msgs():
                out = []
                for f in ('exportExcel()', 'exportCSV()', 'exportPDF()'):
                    clear_msg(); pg.evaluate(f); pg.wait_for_timeout(200); out.append(msg())
                pg.click('button[data-p="slip"]'); pg.wait_for_timeout(400)
                clear_msg(); pg.locator('#p-slip button', has_text='列印').click(); pg.wait_for_timeout(300); out.append(msg())
                return out
            def set_custom_add(v):
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                return pg.evaluate("""(v)=>{ const id=%s;
                  const el=[...document.querySelectorAll('#p-att input[type=number]')].find(x=>{const o=x.getAttribute('onchange')||''; return o.indexOf('.custom_add_amt=')>=0&&o.indexOf('ATT['+JSON.stringify(id)+']')>=0;});
                  if(!el) return false; el.value=String(v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }""" % json.dumps(EMP), v)
            form_hours = lambda: pg.evaluate("""()=>{ const id=%s;
                  const el=[...document.querySelectorAll('#p-att input')].find(x=>{const o=x.getAttribute('onchange')||''; return o.indexOf("['hours']=")>=0&&o.indexOf('ATT['+JSON.stringify(id)+']')>=0;});
                  return el?el.value:null; }""" % json.dumps(EMP))

            # ── J（BLOCKER：讀取失敗＋未存編輯 → 重算）／K（沒有未存編輯，#214 第 5 點照舊）──
            for case in ('J', 'K'):
                if ONLY and case not in ONLY: continue
                edit = case == 'J'
                fresh()
                seen, calls, cfg = [], [], {'fail': True}
                def routeJ(route):
                    bd = act(route); a = bd.get('action'); seen.append(a)
                    if a == 'payroll_month' and bd.get('ym') == '2026-10' and cfg['fail']:
                        fulfill(route, {'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'}); return
                    if a == 'payroll_calc':   # 正式後端只拿 inputs 來算、不存：記下前端送了什麼，送給假後端時拿掉
                        calls.append(bd); bd2 = dict(bd); bd2['inputs'] = {}
                        resp = route.fetch(post_data=json.dumps(bd2)); route.fulfill(response=resp); return
                    if a in ('payroll_input_set',): calls.append(bd)
                    route.continue_()
                pg.route('**/*', routeJ)
                ha0 = att('hours')
                setym('2026-10')
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                hb_att, hb_form = att('hours'), form_hours()
                print('  [%s %s 觀察] 月份 A（11 月）載入後 ATT 工時=%s；切到月份 B（10 月）讀取失敗後：ATT 工時=%s、表單顯示=%s（10 月已存=%s）→ %s'
                      % (bname, case, ha0, hb_att, hb_form, H_B, '仍是月份 A 的表單' if str(hb_att) == str(H_A) else '不是月份 A 的表單'))
                ok(bname + ' ' + case + ' 前提：切到 10 月讀取失敗 → 讀取失敗旗標在', blocked() in (True, None), blocked())
                if edit:
                    put = set_custom_add(500)
                    ok(bname + ' J 前提：在出勤表單填自訂加薪 500（不按儲存）→ 未存標記「儲存工時 ●」', put and dirty() and dot() and att('custom_add_amt') == 500, (put, dirty(), dot(), att('custom_add_amt')))
                cfg['fail'] = False   # 之後重新載入 10 月會成功
                pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                k = len(seen); kc = len(calls)
                pg.click('#calcBtn'); pg.wait_for_timeout(3500)
                aft = seen[k:]
                reloaded = 'payroll_calc' in aft and 'payroll_month' in aft[aft.index('payroll_calc') + 1:]
                cb = (calls[kc:kc + 1] or [{}])[0]
                sent = (cb.get('inputs') or {}).get(EMP) or {}
                print('  [%s %s 觀察] 重新計算送出 ym=%s、該同仁 inputs：工時=%s、自訂加薪=%s；之後%s自動重新載入；ATT 自訂加薪=%s、ATT_DIRTY=%s、●=%s、擋=%s'
                      % (bname, case, cb.get('ym'), sent.get('hours'), sent.get('custom_add_amt'), '有' if reloaded else '沒有', att('custom_add_amt'), dirty(), dot(), blocked()))
                if edit:
                    ok(bname + ' J 重算有用到未存的 500（payroll_calc 送出含 500）', sent.get('custom_add_amt') == 500, sent)
                    ok(bname + ' J 重算成功後：未存的 500 與「儲存工時 ●」都還在（不自動重新載入）',
                       not reloaded and att('custom_add_amt') == 500 and dirty() and dot(), (aft, att('custom_add_amt'), dirty(), dot()))
                    ms = exp_msgs(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                    ok(bname + ' J 重算成功後：Excel／CSV／PDF／薪資單列印都擋（同一句）、鎖定鈕停用、toggleLock 也不送',
                       blocked() is True and all(m == UNSURE_TXT for m in ms) and prints() == 0 and pg.is_disabled('#lockBtn'), (blocked(), ms, prints(), pg.is_disabled('#lockBtn')))
                    k2 = len(seen); pg.evaluate('toggleLock()'); pg.wait_for_timeout(500)
                    ok(bname + ' J toggleLock() 直接呼叫也不送 payroll_finalize', 'payroll_finalize' not in seen[k2:], seen[k2:])
                    # 按「儲存工時」→ 存檔 → 重算 → 重新載入成功 → 解開
                    pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                    k3 = len(seen); kc3 = len(calls)
                    pg.click('#saveAttBtn'); pg.wait_for_timeout(4500)
                    aft3 = seen[k3:]
                    sv = [c for c in calls[kc3:] if c.get('action') == 'payroll_input_set']
                    sv_emp = ((sv[0].get('inputs') if sv else {}) or {}).get(EMP) or {}
                    print('  [%s J 觀察] 儲存工時送出 ym=%s、該同仁工時=%s、自訂加薪=%s（10 月已存=%s，月份 A＝%s）'
                          % (bname, sv[0].get('ym') if sv else None, sv_emp.get('hours'), sv_emp.get('custom_add_amt'), H_B, H_A))
                    re3 = 'payroll_input_set' in aft3 and 'payroll_month' in aft3[aft3.index('payroll_input_set') + 1:]
                    ok(bname + ' J 按「儲存工時」→ 送出含 500 的存檔、重算、重新載入成功 → 解開（擋解除、鎖定鈕可按、● 清掉）',
                       re3 and sv_emp.get('custom_add_amt') == 500 and blocked() is False and not dirty() and not dot() and not pg.is_disabled('#lockBtn'),
                       (aft3, sv_emp, blocked(), dirty(), dot()))
                    clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200)
                    ok(bname + ' J 解開後匯出不再被擋', msg() != UNSURE_TXT, msg())
                else:
                    clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200)
                    ok(bname + ' K 沒有未存編輯：重算成功 → 自動重新載入 → 成功才解開（#214 第 5 點照舊）',
                       reloaded and blocked() is False and not pg.is_disabled('#lockBtn') and msg() != UNSURE_TXT, (aft, blocked(), msg()))
                pg.unroute('**/*')

            # ── L（殘餘：鎖定回應遺失、狀態查詢回 mixed）──
            if (not ONLY or 'L' in ONLY) and pg.evaluate("typeof monBlocked==='function'"):
                fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                seenL = []
                def routeL(route):
                    a = act(route).get('action'); seenL.append(a)
                    if a == 'payroll_finalize': fulfill(route, {'ok': False, 'error': 'timeout', 'message': '等候逾時，請稍後再試'}); return
                    if a == 'payroll_status': fulfill(route, {'ok': True, 'ym': '2026-11', 'store': 'SSLGF', 'status': 'mixed', 'rows': 4}); return
                    route.continue_()
                pg.route('**/*', routeL)
                pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                m1 = msg()
                ms = exp_msgs(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                after = seenL[seenL.index('payroll_finalize') + 1:] if 'payroll_finalize' in seenL else []
                ok(bname + ' L 狀態查詢回 mixed：提示照舊、設讀取失敗旗標（Excel／CSV／PDF／薪資單擋、鎖定鈕停用）、不打 payroll_month',
                   m1 == MIXED_TXT and blocked() is True and all(m == UNSURE_TXT for m in ms) and prints() == 0 and pg.is_disabled('#lockBtn') and 'payroll_month' not in after,
                   (m1, blocked(), ms, prints(), after))
                pg.unroute('**/*')
                setym('2026-10'); setym('2026-11')
                ok(bname + ' L 重新載入成功 → 解開', blocked() is False and not pg.is_disabled('#lockBtn'), blocked())
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
