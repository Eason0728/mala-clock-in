# 薪資頁後續小修（2026-11-23，fix/payroll-html-followups）：假後端＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/pay-html-followups-e2e.py [A,B,C,D,E]
#   同 tests/ui/elec-unsaved-recalc-e2e.py 的假資料（虛構同仁「測試甲～丁」）與假後端（mock/mock_server.py，隨機埠、只綁 127.0.0.1），不碰正式試算表。
#   跑完用自己的程序代號收掉假後端，並刪掉 mock/mock_data.json。
#   E2E_ROOT＝拿別的版本的 payroll.html 跑（例：改版前 origin/main 的解壓目錄）——A、B、C、E 在改版前應該紅（D 是補的守門測試，改版前後都綠）。
#   ⚠ 假後端的 payroll_calc 會把送來的 inputs 存進工時表（正式 handlePayrollCalc 不會存，只拿來算）：這裡送給假後端前拿掉 inputs，只記下前端送了什麼。
#   ⚠ 假後端的 payroll_input_set 不落地：D 自己記一份「正本」（存檔送出的內容），重新載入時用它換掉 payroll_month 回的 inputs。
# 規則：
#   A  ①讀取失敗後存到錯月份：切月份讀取失敗 → 出勤表單收起來＋提示；「儲存工時」、差異逐筆決定都不送；重新計算不送上個月的表單（送 {}）；
#      開頁第一次就讀取失敗也不能存（改版前會送空白表單＝清掉這個月的手動工時）；重新載入成功 → 表單回來、是這個月的資料、可以存
#   B  ②工時存檔失敗 → 「儲存工時 ●」回來、再編輯也還在；存好後 1.8 秒內又編輯 → 按鈕放開時有 ●
#   C  ③待辦 17（5A）：鎖定被擋 → 要按「知道了」才關的視窗（按外圍、Esc 不關），字句照後端；衝突、對不上、還沒回報三種後面加「請把這個畫面截圖傳給資訊部。」
#   D  ④補測試：存檔成功後正本與草稿一致（重算用的工時＝存進去的工時、重新載入讀回同一份）；存檔成功但重算失敗；存檔、重算成功但重新載入失敗
#   E  ⑤鎖定結果不明、狀態查詢回 mixed 之後：重新載入成功但 payroll_status 仍是 mixed → 照擋；查不到 → 照擋；草稿／舊後端 → 解開
#   F  同一類的其他資料（驗收補）：獎金（切月份讀取失敗／開頁就失敗）收起來＋不送；切門市讀取失敗 → 主檔、參數、假別設定、事件日、獎金、工時都不送（後端都是整份取代）
import json, os, shutil, socket, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.environ.get('E2E_ROOT') or os.path.join(os.path.dirname(__file__), '..', '..'))
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
EMP = str([m for m in sd['master'] if str(m.get('active', 'true')).lower() == 'true'][0]['emp_id'])
H_A, H_B = 111, 77   # 已存工時：11 月 111 小時、10 月 77 小時——看得出表單是哪個月的

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
    p['store'] = [{'code': 'SSLGF', 'name': '測試店', 'active': True}, {'code': 'TESTB', 'name': '測試二店', 'active': True}]
    p['input'] = [{'ym': '2026-11', 'emp_id': EMP, 'hours': H_A, 'support': []}, {'ym': '2026-10', 'emp_id': EMP, 'hours': H_B, 'support': []}]
    json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))
def act(route):
    try: return json.loads(route.request.post_data or '{}')
    except Exception: return {}
def fulfill(route, obj): route.fulfill(status=200, content_type='application/json', body=json.dumps(obj))
FAIL = {'ok': False, 'error': 'server_error', 'message': '讀取失敗（測試）'}
TIMEOUT = {'ok': False, 'error': 'timeout', 'message': '等候逾時，請稍後再試'}
UNSURE_TXT = '這個月的資料剛才沒有讀取成功，請重新整理頁面、確認金額後再匯出'
MIXED_TXT = '這個月有一部分已鎖定、一部分還是草稿，請重新整理頁面看狀態；重新整理後還是這樣請找資訊部'
FOREIGN_TXT = '這個月的出勤資料沒有讀取成功，為了避免存錯月份，先不能修改或儲存工時。請重新整理頁面後再操作。'
SHOT = '請把這個畫面截圖傳給資訊部。'
LOCK_MSGS = [   # Payroll.gs／RelayG.gs relayGLockRowsBlock_ 的字句（筆數是示意）
    ('g_rows_unwb', 'Mac mini 還有 3 筆核定、審單還沒寫回 Google，請過幾分鐘再按一次鎖定；一直這樣請找資訊部。', False),
    ('g_rows_conflict', '還有 2 筆核定衝突待處理（Mac mini 和 Google 結果不同），要資訊部處理完才能鎖定。', True),
    ('g_rows_fp', '這個月的核定、請假或申請，Mac mini 和 Google 對不上，這次沒有鎖定。請找資訊部處理。', True),
    ('g_rows_missing', 'Mac mini 還沒回報這個月核定、請假、申請和 Google 是否一致，這次沒有鎖定。請找資訊部處理。', True),
    ('g_rows_stale', 'Mac mini 回報的核定、請假、申請對帳結果超過 30 分鐘沒有更新，這次沒有鎖定。請找資訊部處理。', False),
]
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
            # 一個攔截器、每個情境改 cfg：fail_month＝這些月份的 payroll_month 回失敗；其他鍵＝那個動作直接回這份（None＝照常給假後端）
            seen, cfg, canon = [], {}, {}
            def router(route):
                bd = act(route); a = bd.get('action'); seen.append(bd)
                if a == 'payroll_month' and bd.get('ym') in cfg.get('fail_month', ()): fulfill(route, FAIL); return
                if a == 'payroll_month' and bd.get('store') in cfg.get('fail_store', ()): fulfill(route, FAIL); return
                if a in cfg and cfg[a] is not None: fulfill(route, cfg[a]); return
                if a == 'payroll_input_set' and cfg.get('canon'):   # D：自己記正本
                    canon[bd.get('ym')] = json.loads(json.dumps(bd.get('inputs') or {})); fulfill(route, {'ok': True, 'saved': len(canon[bd.get('ym')]), 'count': len(canon[bd.get('ym')])}); return
                if a == 'payroll_calc':   # 正式後端只拿 inputs 來算、不存
                    bd2 = dict(bd); bd2['inputs'] = {}
                    resp = route.fetch(post_data=json.dumps(bd2)); route.fulfill(response=resp); return
                if a == 'payroll_month' and cfg.get('canon') and bd.get('ym') in canon:
                    resp = route.fetch(); j = resp.json(); j['inputs'] = canon[bd.get('ym')]; fulfill(route, j); return
                route.continue_()
            def fresh(boot_fail=False):
                seed(); cfg.clear(); canon.clear(); del seen[:]
                pg.unroute('**/*')
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
                pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
                if boot_fail: cfg['fail_month'] = ('2026-11',)
                pg.route('**/*', router)
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200)
                pg.evaluate("window.__pr=0; window.print=function(){ window.__pr++; }; window.open=function(){ window.__pr++; return null; }; 0")
            def setym(v, wait=2500): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(wait)
            msg = lambda: pg.inner_text('#msg')
            clear_msg = lambda: pg.evaluate("$('msg').textContent=''; 0")
            blocked = lambda: pg.evaluate("monBlocked()")
            dirty = lambda: pg.evaluate('ATT_DIRTY')
            btn = lambda: pg.inner_text('#saveAttBtn')
            att = lambda k: pg.evaluate("(ATT[%s]||{})[%s]" % (json.dumps(EMP), json.dumps(k)))
            sent = lambda a, k=0: [x for x in seen[k:] if x.get('action') == a]
            foreign_ui = lambda: pg.evaluate("""()=>{ const p=$('p-att'), n=$('attForeign'), c=p.querySelector('.card');
                  return { cls: p.classList.contains('pay-foreign'), note: n&&getComputedStyle(n).display!=='none'?n.textContent:'', card: c?getComputedStyle(c).display:'' }; }""")
            def set_custom_add(v):   # 程式直接改值並發事件（表單收起來時人按不到，這裡仍可模擬「有未存編輯」）
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                return pg.evaluate("""(v)=>{ const id=%s;
                  const el=[...document.querySelectorAll('#p-att input[type=number]')].find(x=>{const o=x.getAttribute('onchange')||''; return o.indexOf('.custom_add_amt=')>=0&&o.indexOf('ATT['+JSON.stringify(id)+']')>=0;});
                  if(!el) return false; el.value=String(v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }""" % json.dumps(EMP), v)
            form_hours = lambda: pg.evaluate("""()=>{ const id=%s;
                  const el=[...document.querySelectorAll('#p-att input')].find(x=>{const o=x.getAttribute('onchange')||''; return o.indexOf("['hours']=")>=0&&o.indexOf('ATT['+JSON.stringify(id)+']')>=0;});
                  return el?el.value:null; }""" % json.dumps(EMP))
            def lock_unsure(status_resp):   # 鎖定的回應斷掉、狀態查詢回 status_resp → 讀取失敗旗標（同一個店月，表單仍是這個月的）
                cfg['payroll_finalize'] = TIMEOUT; cfg['payroll_status'] = status_resp
                pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                pg.click('#lockBtn'); pg.wait_for_timeout(2500)
                cfg['payroll_finalize'] = None; cfg['payroll_status'] = None

            # ── A ①讀取失敗後存到錯月份 ──
            if not ONLY or 'A' in ONLY:
                fresh()
                ok(bname + ' A 前提：11 月載入成功、表單工時＝11 月的 111', str(att('hours')) == str(H_A) and not foreign_ui()['cls'], att('hours'))
                cfg['fail_month'] = ('2026-10',)
                setym('2026-10')
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                ui = foreign_ui()
                print('  [%s A 觀察] 切到 10 月讀取失敗：ATT 工時=%s（11 月＝%s、10 月＝%s）、表單=%s' % (bname, att('hours'), H_A, H_B, ui))
                ok(bname + ' A 切到 10 月讀取失敗 → 出勤表單收起來、顯示提示（逐字）', ui['cls'] and ui['note'] == FOREIGN_TXT and ui['card'] == 'none', ui)
                k = len(seen); clear_msg(); pg.evaluate('saveAtt()'); pg.wait_for_timeout(1500)
                ok(bname + ' A 直接呼叫 saveAtt() → 不送 payroll_input_set（不會把 11 月的表單存進 10 月）、提示同一句',
                   not sent('payroll_input_set', k) and msg() == FOREIGN_TXT, ([x.get('ym') for x in sent('payroll_input_set', k)], msg()))
                k = len(seen); pg.evaluate("supDecide(%s,'SSLGF','auto',1,null)" % json.dumps(EMP)); pg.wait_for_timeout(800)
                ok(bname + ' A 差異逐筆決定（supDecide）也不送', not sent('payroll_support_decide', k), sent('payroll_support_decide', k))
                put = set_custom_add(500)
                k = len(seen); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                pg.click('#calcBtn'); pg.wait_for_timeout(3000)
                pc = sent('payroll_calc', k)
                ok(bname + ' A 有未存編輯也一樣：按重新計算 → payroll_calc（10 月）不送上個月的表單（inputs＝{}）',
                   put and dirty() and pc and pc[0].get('ym') == '2026-10' and (pc[0].get('inputs') or {}) == {}, (put, dirty(), [(x.get('ym'), x.get('inputs')) for x in pc]))
                cfg['fail_month'] = ()
                setym('2026-11'); setym('2026-10')
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                ui = foreign_ui()
                ok(bname + ' A 10 月重新載入成功 → 表單回來（提示收掉）、工時是 10 月的 77', not ui['cls'] and ui['note'] == '' and ui['card'] != 'none' and str(att('hours')) == str(H_B) and str(form_hours()) == str(H_B), (ui, att('hours'), form_hours()))
                k = len(seen); pg.click('#saveAttBtn'); pg.wait_for_timeout(2500)
                sv = sent('payroll_input_set', k)
                ok(bname + ' A 讀取成功後照常存：送 10 月、工時 77', sv and sv[0].get('ym') == '2026-10' and str(((sv[0].get('inputs') or {}).get(EMP) or {}).get('hours')) == str(H_B), [(x.get('ym'), (x.get('inputs') or {}).get(EMP)) for x in sv])
                # 開頁第一次就讀取失敗
                fresh(boot_fail=True)
                pg.click('button[data-p="att"]'); pg.wait_for_timeout(300)
                k = len(seen); clear_msg(); pg.evaluate('saveAtt()'); pg.wait_for_timeout(1500)
                sv = sent('payroll_input_set', k)
                ok(bname + ' A 開頁第一次就讀取失敗 → 表單收起來、saveAtt() 不送（改版前會送空白表單＝清掉這個月的手動工時）',
                   foreign_ui()['cls'] and not sv and msg() == FOREIGN_TXT, ([(x.get('ym'), x.get('inputs')) for x in sv], msg()))

            # ── F 同一類的其他資料 ──
            if not ONLY or 'F' in ONLY:
                WRITES = ('payroll_bonus_set', 'payroll_master_set', 'payroll_config_set', 'payroll_leave_type_set', 'payroll_leave_event_set', 'payroll_input_set', 'payroll_store_set')
                bonus_ui = lambda: pg.evaluate("""()=>{ const p=$('p-bonus'), n=$('bonusForeign'), c=p.querySelector('.card');
                      return { cls: p.classList.contains('pay-foreign'), note: n&&getComputedStyle(n).display!=='none'?n.textContent:'', card: c?getComputedStyle(c).display:'' }; }""")
                fresh()
                pg.evaluate("BONUS.push({emp_id:%s,bonus_type:'project',label:'十一月',amount:1234,memo:''}); renderBonus(); 0" % json.dumps(EMP))
                cfg['fail_month'] = ('2026-10',)
                setym('2026-10')
                pg.click('button[data-p="bonus"]'); pg.wait_for_timeout(300)
                ui = bonus_ui()
                k = len(seen); clear_msg(); pg.evaluate('saveBonus(null)'); pg.wait_for_timeout(1500)
                bs = sent('payroll_bonus_set', k)
                ok(bname + ' F 切到 10 月讀取失敗 → 獎金分頁收起來、提示沿用「剛才沒有讀取成功」那句；saveBonus 不送（改版前會把 11 月的獎金整份寫進 10 月）',
                   ui['cls'] and ui['note'] == UNSURE_TXT and ui['card'] == 'none' and not bs and msg() == UNSURE_TXT, (ui, [(x.get('ym'), len(x.get('bonuses') or [])) for x in bs], msg()))
                cfg['fail_month'] = ()
                setym('2026-11'); setym('2026-10')
                pg.click('button[data-p="bonus"]'); pg.wait_for_timeout(300)
                k = len(seen); pg.evaluate('saveBonus(null)'); pg.wait_for_timeout(2000)
                bs = sent('payroll_bonus_set', k)
                ok(bname + ' F 10 月重新讀取成功 → 獎金分頁打開、照常存（送 10 月）', not bonus_ui()['cls'] and bs and bs[0].get('ym') == '2026-10', (bonus_ui(), [x.get('ym') for x in bs]))
                fresh(boot_fail=True)
                k = len(seen); pg.evaluate('saveBonus(null)'); pg.wait_for_timeout(1500)
                bs = sent('payroll_bonus_set', k)
                ok(bname + ' F 開頁就讀取失敗 → saveBonus 不送（改版前送空陣列＝清光這個月的獎金）', not bs and bonus_ui()['cls'], [(x.get('ym'), x.get('bonuses')) for x in bs])
                # 切門市讀取失敗：主檔、參數、假別設定、事件日、獎金、工時都還是 SSLGF 的
                fresh(); pg.wait_for_timeout(800)
                cfg['fail_store'] = ('TESTB',)
                pg.evaluate("switchStore('TESTB')"); pg.wait_for_timeout(2500)
                k = len(seen); clear_msg()
                for f in ('saveMaster(null)', "setMode('daily_hours',8)", 'saveLeaveTypes(null)', 'saveLeaveEvents(null)', 'saveBonus(null)', 'saveAtt()'):
                    pg.evaluate(f); pg.wait_for_timeout(700)
                pg.evaluate("CFG_DIRTY={daily_hours:8}; 0"); pg.evaluate("saveCfg(null,'儲存','cfg')"); pg.wait_for_timeout(700)
                w = [(x.get('action'), x.get('store')) for x in seen[k:] if x.get('action') in WRITES]
                ok(bname + ' F 切到別家門市讀取失敗 → 主檔、參數（兩種存法）、假別設定、事件日、獎金、工時都不送（改版前會把原門市的資料整份寫進新門市）',
                   pg.evaluate('STORE') == 'TESTB' and not w, (pg.evaluate('STORE'), w))
                cfg['fail_store'] = ()
                pg.evaluate("switchStore('TESTB')"); pg.wait_for_timeout(3000)
                k = len(seen); pg.evaluate('saveMaster(null)'); pg.wait_for_timeout(1500)
                ms = [x.get('store') for x in seen[k:] if x.get('action') == 'payroll_master_set']
                ok(bname + ' F 新門市讀取成功 → 照常存主檔（送 TESTB）', ms == ['TESTB'], ms)

            # ── B ②存檔失敗後「●」 ──
            if not ONLY or 'B' in ONLY:
                fresh()
                put = set_custom_add(500)
                ok(bname + ' B 前提：編輯 → 「儲存工時 ●」', put and dirty() and '●' in btn(), (put, btn()))
                cfg['payroll_input_set'] = {'ok': False, 'error': 'server_error', 'message': '寫入失敗（測試）'}
                pg.click('#saveAttBtn'); pg.wait_for_timeout(2000)
                ok(bname + ' B 存檔失敗 → 按鈕可按、「儲存工時 ●」回來（編輯還沒存）', not pg.is_disabled('#saveAttBtn') and btn() == '儲存工時 ●' and dirty(), (btn(), dirty()))
                set_custom_add(600)
                ok(bname + ' B 存檔失敗後再編輯 → 圓點還在', btn() == '儲存工時 ●' and dirty(), btn())
                cfg['payroll_input_set'] = None
                pg.click('#saveAttBtn')
                pg.wait_for_function("$('saveAttBtn').textContent.indexOf('存檔完成')>=0", timeout=8000)
                set_custom_add(700)   # 存好後 1.8 秒內又編輯（按鈕還停在「✓ 存檔完成」）
                pg.wait_for_timeout(2600)
                ok(bname + ' B 存好後 1.8 秒內又編輯 → 按鈕放開時是「儲存工時 ●」', btn() == '儲存工時 ●' and dirty(), (btn(), dirty()))
                pg.click('#saveAttBtn'); pg.wait_for_timeout(2600)
                ok(bname + ' B 對照：存好、沒再編輯 → 「儲存工時」沒有圓點', btn() == '儲存工時' and not dirty(), (btn(), dirty()))

            # ── C ③待辦 17（5A）鎖定被擋的視窗 ──
            if not ONLY or 'C' in ONLY:
                fresh(); pg.click('button[data-p="run"]'); pg.wait_for_timeout(300)
                for err, m, add in LOCK_MSGS:
                    cfg['payroll_finalize'] = {'ok': False, 'error': err, 'message': m}
                    clear_msg(); pg.click('#lockBtn'); pg.wait_for_timeout(1500)
                    box = pg.locator('#lockBlocked')
                    shown = box.count() == 1 and box.is_visible()
                    txt = pg.inner_text('#lockBlockedTxt') if shown else ''
                    if shown:
                        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
                        pg.mouse.click(5, 5); pg.wait_for_timeout(200)   # 遮罩外圍（視窗在正中間）
                    still = pg.locator('#lockBlocked').count() == 1
                    ok(bname + ' C ' + err + '：視窗顯示後端字句' + ('＋「請把這個畫面截圖傳給資訊部。」' if add else '（不加句）') + '；按 Esc、按外圍都不關',
                       shown and txt == m + (SHOT if add else '') and still and pg.inner_text('#lockBlockedOk') == '知道了', (shown, txt, still))
                    if still: pg.click('#lockBlockedOk'); pg.wait_for_timeout(200)
                    ok(bname + ' C ' + err + '：按「知道了」才關、鎖定鈕恢復「鎖定本月」', pg.locator('#lockBlocked').count() == 0 and pg.inner_text('#lockBtn') == '鎖定本月' and not pg.is_disabled('#lockBtn'),
                       (pg.locator('#lockBlocked').count(), pg.inner_text('#lockBtn')))
                cfg['payroll_finalize'] = None

            # ── D ④補測試：存檔→重算→重新載入 ──
            if not ONLY or 'D' in ONLY:
                # D1 存檔成功後正本與草稿一致
                fresh(); cfg['canon'] = True
                set_custom_add(500)
                k = len(seen); pg.click('#saveAttBtn'); pg.wait_for_timeout(3000)
                sv, pc = sent('payroll_input_set', k), sent('payroll_calc', k)
                saved = (sv[0].get('inputs') if sv else None) or {}
                used = (pc[0].get('inputs') if pc else None) or {}
                same = bool(saved) and all(json.dumps(used.get(e), sort_keys=True) == json.dumps(v, sort_keys=True) for e, v in saved.items())
                ok(bname + ' D1 存檔成功：存進去的（正本）與重算用的（草稿）是同一個月、每個存進去的人工時逐欄相同、含 500',
                   sv and pc and sv[0].get('ym') == pc[0].get('ym') == '2026-11' and same and (saved.get(EMP) or {}).get('custom_add_amt') == 500,
                   ([x.get('ym') for x in sv], [x.get('ym') for x in pc], same, saved.get(EMP)))
                ok(bname + ' D1 存好後：未存標記清掉、按鈕放開是「儲存工時」', not dirty() and btn() == '儲存工時', (dirty(), btn()))
                setym('2026-10'); setym('2026-11')
                cs = (canon.get('2026-11') or {}).get(EMP) or {}
                ok(bname + ' D1 重新載入讀回正本：表單自訂加薪＝500、工時＝正本（跟草稿用的同一份）', att('custom_add_amt') == 500 and str(att('hours')) == str(cs.get('hours')) and str(form_hours()) == str(cs.get('hours')), (att('custom_add_amt'), att('hours'), cs.get('hours')))
                # D2 存檔成功、重算失敗（一般狀態，與讀取失敗旗標在的狀態）
                for unsure in (False, True):
                    fresh()
                    if unsure: lock_unsure(TIMEOUT)
                    b0 = blocked(); r0 = pg.evaluate('JSON.stringify(RESULTS)')
                    set_custom_add(500)
                    cfg['payroll_calc'] = {'ok': False, 'error': 'server_error', 'message': '計算失敗（測試）'}
                    k = len(seen); pg.click('#saveAttBtn'); pg.wait_for_timeout(3000)
                    aft = [x.get('action') for x in seen[k:]]
                    lab = '（讀取失敗旗標在）' if unsure else '（一般）'
                    ok(bname + ' D2 存檔成功、重算失敗' + lab + '：有送存檔與重算、不重新載入、畫面數字不變、未存標記清掉（已存）',
                       'payroll_input_set' in aft and 'payroll_calc' in aft and 'payroll_month' not in aft and pg.evaluate('JSON.stringify(RESULTS)') == r0 and not dirty(), (aft, dirty()))
                    if unsure:
                        clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200)
                        k2 = len(seen); pg.evaluate('toggleLock()'); pg.wait_for_timeout(500)
                        ok(bname + ' D2 重算失敗' + lab + '：仍然擋（匯出同一句、鎖定不送）', b0 and blocked() and msg() == UNSURE_TXT and not sent('payroll_finalize', k2), (b0, blocked(), msg()))
                    else:
                        ok(bname + ' D2 重算失敗' + lab + '：沒有讀取失敗旗標（不會因此擋匯出）', not b0 and not blocked(), (b0, blocked()))
                # D3 存檔、重算成功，重新載入失敗（讀取失敗旗標在）→ 仍擋；之後重新載入成功 → 解開
                fresh(); lock_unsure(TIMEOUT)
                set_custom_add(500)
                cfg['fail_month'] = ('2026-11',)
                k = len(seen); pg.click('#saveAttBtn'); pg.wait_for_timeout(3500)
                aft = [x.get('action') for x in seen[k:]]
                re = 'payroll_calc' in aft and 'payroll_month' in aft[aft.index('payroll_calc') + 1:]
                clear_msg(); pg.evaluate('exportExcel()'); pg.wait_for_timeout(200)
                ok(bname + ' D3 存檔、重算成功、重新載入失敗：有重新載入、仍然擋（匯出同一句、鎖定鈕停用）、未存標記清掉',
                   re and blocked() and msg() == UNSURE_TXT and pg.is_disabled('#lockBtn') and not dirty(), (aft, blocked(), msg(), dirty()))
                cfg['fail_month'] = ()
                setym('2026-10'); setym('2026-11')
                ok(bname + ' D3 之後重新載入成功 → 解開', not blocked() and not pg.is_disabled('#lockBtn'), blocked())

            # ── E ⑤ mixed ──
            if not ONLY or 'E' in ONLY:
                MIXED = {'ok': True, 'ym': '2026-11', 'store': 'SSLGF', 'status': 'mixed', 'rows': 4}
                for lab, st2, expect_block, expect_msg in (
                        ('重新載入成功、狀態仍是 mixed', MIXED, True, MIXED_TXT),
                        ('重新載入成功、狀態查不到（逾時）', TIMEOUT, True, UNSURE_TXT),
                        ('重新載入成功、狀態查不到（status_read_failed）', {'ok': False, 'error': 'status_read_failed'}, True, UNSURE_TXT),
                        ('對照：重新載入成功、狀態是草稿', None, False, None),
                        ('對照：舊後端不認得 payroll_status', {'ok': False, 'error': 'unknown_action'}, False, None)):
                    fresh(); lock_unsure(MIXED)
                    ok(bname + ' E 前提（' + lab + '）：鎖定結果不明、狀態回 mixed → 擋', blocked() is True, blocked())
                    cfg['payroll_status'] = st2
                    k = len(seen); setym('2026-10'); clear_msg(); setym('2026-11', 3000)
                    m1 = msg()
                    asked = [x.get('action') for x in seen[k:]]
                    if expect_block:
                        clear_msg(); pg.evaluate('exportCSV()'); pg.wait_for_timeout(200)
                        ok(bname + ' E ' + lab + ' → 照擋（匯出同一句、鎖定鈕停用），提示「' + expect_msg[:12] + '…」',
                           'payroll_status' in asked and blocked() is True and pg.is_disabled('#lockBtn') and m1 == expect_msg and msg() == UNSURE_TXT, (asked, blocked(), m1, msg()))
                    else:
                        ok(bname + ' E ' + lab + ' → 解開', 'payroll_status' in asked and blocked() is False and not pg.is_disabled('#lockBtn'), (asked, blocked(), m1))
                    cfg['payroll_status'] = None
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
