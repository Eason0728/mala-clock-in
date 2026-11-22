# 選舉假名單：日期不是投票日時要多按一次確認（2026-11-22 Eason 選項 7B）：假後端＋Playwright，Chromium、WebKit 各跑一次。
# 用法（repo 根目錄）：python3 tests/ui/elec-date-confirm-e2e.py [只跑某幾段，例：A,C]
#   跟 tests/ui/elec-ui-e2e.py 同一套假資料（tests/election-day-emp.test.js 的 world()，虛構同仁「測試甲～丁」）與假後端（mock/mock_server.py），不碰正式試算表。
#   假後端開在隨機埠、只綁 127.0.0.1，跑完用自己的程序代號收掉，並刪掉 mock/mock_data.json。
#   E2E_OLD_FRONT=<舊版 payroll.html>：D 段拿它當「舊畫面」（預設用 git 的 49dc85e 版）。
#   E2E_FRONT=<payroll.html>：A～C 段改載入這一份（拿修正前的版本跑應該紅）。
# 段落：
#   A 說明行「本月投票日：2026-11-28」；12 月（清單沒有日期）不顯示
#   B 清單外 11/29：跳確認框（逐字）→ 取消不送出、畫面不變；Esc 也是取消 → 確定才送出且帶 confirm_off_list:true → 成功提示（逐字）
#   C 清單內 11/28：不跳確認框、不帶旗標、提示照舊；12 月清單空白：一樣要確認（「本月沒有投票日」）
#   E 日期欄初始值：沒存過＝該月最早投票日、存過＝存過的日期（清單外也照顯示）、12 月＝空白；帶入不存檔不重算、直接存不跳框、改成清單外要確認
#   D 前後端相依：新畫面＋舊後端（沒帶 elec_vote_days）→ 不跳框、照舊直接送；舊畫面＋新後端 → 顯示後端說明、名單不變
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
OLD_FRONT = (open(os.environ['E2E_OLD_FRONT'], encoding='utf-8').read() if os.environ.get('E2E_OLD_FRONT')
             else subprocess.run(['git', 'show', '49dc85e:payroll.html'], cwd=ROOT, capture_output=True, text=True, check=True).stdout)

FRONT_OVERRIDE = open(os.environ['E2E_FRONT'], encoding='utf-8').read() if os.environ.get('E2E_FRONT') else None   # 例：拿修正前的 payroll.html 跑 A,B,C 應該紅
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
def saved(): return [(r['date'], r['emp_id']) for r in json.load(open(DATA, encoding='utf-8')).get('payroll', {}).get('hol_emp', [])]
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓ ' if cond else '✗ ') + name + (' ' + str(extra) if extra and not cond else ''))

HINT = '本月投票日：2026-11-28'
ASK = '2026-11-29 不在投票日清單（本月投票日是 2026-11-28）。選錯日期會讓名單上的人選舉日加發算錯。確定要用 2026-11-29 嗎？'
DONE = '已儲存選舉假名單（2026-11-29，3 人；不在投票日清單）'
ASK_DEC = '2026-12-05 不在投票日清單（本月沒有投票日）。選錯日期會讓名單上的人選舉日加發算錯。確定要用 2026-12-05 嗎？'   # Eason 2026-11-22 定案
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
            pg.on('pageerror', lambda e: print('  [pageerror]', e))
            sent = []   # 送出的 payroll_hol_emp_set 請求內容
            def rec(route):
                try: bd = json.loads(route.request.post_data or '{}')
                except Exception: bd = {}
                if bd.get('action') == 'payroll_hol_emp_set': sent.append(bd)
                route.continue_()
            def fresh(extra_route=None):
                seed(); sent.clear()
                pg.unroute('**/*')
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle')
                pg.evaluate("localStorage.setItem('pay_store','SSLGF')")
                pg.route('**/*', extra_route or rec)
                if FRONT_OVERRIDE is not None:   # 修正前紅燈確認用：A～C 段改載入指定的 payroll.html
                    pg.route('**/payroll.html*', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=FRONT_OVERRIDE))
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200)
                pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(400)
            def setym(v, wait=2500): pg.evaluate("$('ym').value='%s'; $('ym').dispatchEvent(new Event('change'))" % v); pg.wait_for_timeout(wait)
            def pick(date, n):
                pg.fill('#elecDate', date)
                cks = pg.locator('#elecList .elec-ck')
                for i in range(cks.count()):
                    (cks.nth(i).check if i < n else cks.nth(i).uncheck)()
            def checked(): return pg.evaluate("[...document.querySelectorAll('#elecList .elec-ck:checked')].map(c=>c.value)")
            ask_open = lambda: pg.locator('#elecAsk').count() > 0
            def wait_msg(sub, t=8000): pg.wait_for_function("document.getElementById('msg').textContent.indexOf(%s)>=0" % json.dumps(sub), timeout=t)

            # ── A 說明行 ──
            if not ONLY or 'A' in ONLY:
                fresh()
                ok(bname + ' A 11 月說明行逐字「' + HINT + '」', pg.inner_text('#elecVoteDays') == HINT, pg.inner_text('#elecVoteDays'))
                setym('2026-12'); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300)
                ok(bname + ' A 12 月（清單沒有日期）不顯示說明行', pg.inner_text('#elecVoteDays') == '', pg.inner_text('#elecVoteDays'))
                setym('2026-11'); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300)
                ok(bname + ' A 切回 11 月又顯示', pg.inner_text('#elecVoteDays') == HINT, pg.inner_text('#elecVoteDays'))

            # ── B 清單外 11/29 ──
            if not ONLY or 'B' in ONLY:
                fresh(); pick('2026-11-29', 3); ck0 = checked()
                pg.click('#elecSave'); pg.wait_for_selector('#elecAsk', timeout=4000)
                ok(bname + ' B 跳確認框、內文逐字', pg.inner_text('#elecAskTxt') == ASK, pg.inner_text('#elecAskTxt'))
                ok(bname + ' B 按鈕逐字「取消」「確定使用這個日期」', [pg.inner_text('#elecAskNo'), pg.inner_text('#elecAskYes')] == ['取消', '確定使用這個日期'],
                   [pg.inner_text('#elecAskNo'), pg.inner_text('#elecAskYes')])
                pg.click('#elecAskNo'); pg.wait_for_timeout(800)
                ok(bname + ' B 取消 → 框關掉、沒送出、名單沒存', not ask_open() and sent == [] and saved() == [], (ask_open(), sent, saved()))
                ok(bname + ' B 取消 → 畫面不變（日期、勾選照舊）', pg.input_value('#elecDate') == '2026-11-29' and checked() == ck0, (pg.input_value('#elecDate'), checked()))
                pg.click('#elecSave'); pg.wait_for_selector('#elecAsk', timeout=4000); pg.keyboard.press('Escape'); pg.wait_for_timeout(600)
                ok(bname + ' B Esc 也是取消、沒送出', not ask_open() and sent == [], (ask_open(), sent))
                pg.click('#elecSave'); pg.wait_for_selector('#elecAsk', timeout=4000); pg.click('#elecAskYes')
                wait_msg('已儲存選舉假名單'); pg.wait_for_timeout(300); m = pg.inner_text('#msg')
                ok(bname + ' B 確定 → 送出一次、帶 confirm_off_list:true（布林）', len(sent) == 1 and sent[0].get('confirm_off_list') is True and sent[0].get('date') == '2026-11-29', sent)
                ok(bname + ' B 成功提示逐字「' + DONE + '，已重新計算」（完整句）', m == DONE + '，已重新計算', m)
                ok(bname + ' B 假後端存到 3 人 11/29', sorted(saved()) == sorted([('2026-11-29', x) for x in ck0]), saved())

            # ── C 清單內 11/28；12 月清單空白 ──
            if not ONLY or 'C' in ONLY:
                fresh(); pick('2026-11-28', 2)
                pg.click('#elecSave'); wait_msg('已儲存選舉假名單'); pg.wait_for_timeout(300); m = pg.inner_text('#msg')
                ok(bname + ' C 11/28 不跳確認框、不帶旗標', len(sent) == 1 and 'confirm_off_list' not in sent[0] and not ask_open(), sent)
                ok(bname + ' C 11/28 提示照舊（沒有「不在投票日清單」）', m.startswith('已儲存選舉假名單（2026-11-28，2 人）') and '不在投票日清單' not in m, m)
                setym('2026-12'); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300); sent.clear()
                pick('2026-12-05', 1); pg.click('#elecSave'); pg.wait_for_selector('#elecAsk', timeout=4000)
                ok(bname + ' C 12 月清單空白：一樣要確認、內文逐字', pg.inner_text('#elecAskTxt') == ASK_DEC, pg.inner_text('#elecAskTxt'))
                pg.click('#elecAskYes'); wait_msg('2026-12-05'); pg.wait_for_timeout(300)
                ok(bname + ' C 12 月確定 → 帶旗標、提示有「不在投票日清單」', len(sent) == 1 and sent[0].get('confirm_off_list') is True and pg.inner_text('#msg').startswith('已儲存選舉假名單（2026-12-05，1 人；不在投票日清單）'),
                   (sent, pg.inner_text('#msg')))

            # ── E 日期欄初始值 ──
            if not ONLY or 'E' in ONLY:
                acts = []   # 開頁後送出的所有動作（確認預設帶入不會存檔、不會重算）
                def rec_all(route):
                    try: bd = json.loads(route.request.post_data or '{}')
                    except Exception: bd = {}
                    if bd.get('action'): acts.append(bd.get('action'))
                    rec(route)
                fresh(rec_all)
                ok(bname + ' E 沒存過名單 → 日期欄預設 2026-11-28', pg.input_value('#elecDate') == '2026-11-28', pg.input_value('#elecDate'))
                acts.clear(); pg.click('button[data-p="emp"]'); pg.wait_for_timeout(300); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(800)
                ok(bname + ' E 預設帶入不存檔、不重算（沒有 payroll_hol_emp_set／payroll_calc）', 'payroll_hol_emp_set' not in acts and 'payroll_calc' not in acts and sent == [], acts)
                pick('2026-11-28', 1); pg.locator('#elecList .elec-ck').nth(0).check()
                pg.fill('#elecDate', '2026-11-30'); pg.click('#elecSave'); pg.wait_for_selector('#elecAsk', timeout=4000)
                ok(bname + ' E 預設值改成清單外 11/30 → 照樣跳確認框', pg.inner_text('#elecAskTxt').startswith('2026-11-30 不在投票日清單（本月投票日是 2026-11-28）'), pg.inner_text('#elecAskTxt'))
                pg.click('#elecAskNo'); pg.wait_for_timeout(300)
                setym('2026-12'); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(300)
                ok(bname + ' E 12 月（沒有投票日）→ 日期欄空白（維持原本）', pg.input_value('#elecDate') == '', pg.input_value('#elecDate'))
                # 存過清單外日期 11/29 → 顯示 11/29，不被預設蓋掉
                seed(); d = json.load(open(DATA, encoding='utf-8')); d['payroll']['hol_emp'] = [{'ym': '2026-11', 'date': '2026-11-29', 'store': 'SSLGF', 'emp_id': 'E1', 'name': '', 'note': ''}]
                json.dump(d, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False)
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200); pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(400)
                ok(bname + ' E 存過 11/29（清單外）→ 顯示 11/29、不被預設蓋掉', pg.input_value('#elecDate') == '2026-11-29' and checked() == ['E1'], (pg.input_value('#elecDate'), checked()))
                # 清單有兩個日期 → 帶最早的；直接存不跳框、不帶旗標
                def two_days(route):
                    try: bd = json.loads(route.request.post_data or '{}')
                    except Exception: bd = {}
                    if bd.get('action') == 'payroll_month':
                        j = route.fetch().json()
                        if bd.get('ym') == '2026-11': j['elec_vote_days'] = ['2026-11-28', '2026-11-15']
                        route.fulfill(status=200, content_type='application/json', body=json.dumps(j)); return
                    if bd.get('action') == 'payroll_hol_emp_set':   # 假後端的清單只有 11/28：這段模擬清單也有 11/15 的後端（照存）
                        sent.append(bd)
                        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'count': len(bd.get('emp_ids') or []), 'ym': bd.get('ym'), 'date': bd.get('date'), 'store': 'SSLGF'})); return
                    rec(route)
                fresh(two_days)
                ok(bname + ' E 兩個投票日（11/28、11/15）→ 預設最早的 11/15', pg.input_value('#elecDate') == '2026-11-15', pg.input_value('#elecDate'))
                pg.locator('#elecList .elec-ck').nth(0).check(); pg.click('#elecSave'); wait_msg('已儲存選舉假名單（2026-11-15')
                ok(bname + ' E 用預設值直接存 → 不跳框、不帶旗標', not ask_open() and len(sent) == 1 and sent[0].get('date') == '2026-11-15' and 'confirm_off_list' not in sent[0], sent)

            # ── D 前後端相依 ──
            if not ONLY or 'D' in ONLY:
                def old_back(route):   # 舊後端：payroll_month 不帶 elec_vote_days、存名單不看旗標
                    try: bd = json.loads(route.request.post_data or '{}')
                    except Exception: bd = {}
                    if bd.get('action') == 'payroll_hol_emp_set':
                        sent.append(bd)
                        route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'count': len(bd.get('emp_ids') or []), 'ym': bd.get('ym'), 'date': bd.get('date'), 'store': 'SSLGF'})); return
                    if bd.get('action') == 'payroll_month':
                        j = route.fetch().json(); j.pop('elec_vote_days', None)
                        route.fulfill(status=200, content_type='application/json', body=json.dumps(j)); return
                    route.continue_()
                fresh(old_back)
                ok(bname + ' D 新畫面＋舊後端：沒有說明行', pg.inner_text('#elecVoteDays') == '', pg.inner_text('#elecVoteDays'))
                pick('2026-11-29', 2); pg.click('#elecSave'); pg.wait_for_timeout(500)
                ok(bname + ' D 新畫面＋舊後端：不跳框、照舊直接送（不帶旗標）', not ask_open() and len(sent) == 1 and 'confirm_off_list' not in sent[0], (ask_open(), sent))
                wait_msg('已儲存選舉假名單'); m = pg.inner_text('#msg')
                ok(bname + ' D 新畫面＋舊後端：提示照舊（沒有「不在投票日清單」）', m.startswith('已儲存選舉假名單（2026-11-29，2 人）'), m)
                # 舊畫面＋新後端
                seed(); sent.clear(); pg.unroute('**/*')
                pg.route('**/*', rec)
                pg.route('**/payroll.html*', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=OLD_FRONT))
                pg.goto(BASE + '/payroll.html?k=test-admin', wait_until='networkidle'); pg.wait_for_timeout(1200)
                pg.click('button[data-p="cfg"]'); pg.wait_for_timeout(400)
                ok(bname + ' D 舊畫面確實是舊版（沒有說明行元素）', pg.locator('#elecVoteDays').count() == 0)
                pick('2026-11-29', 2); pg.click('#elecSave'); wait_msg('不在投票日清單'); pg.wait_for_timeout(1500)
                m = pg.inner_text('#msg')
                ok(bname + ' D 舊畫面＋新後端：顯示後端說明、名單沒存', m == '2026-11-29 不在投票日清單（本月投票日是 2026-11-28）。選錯日期會讓名單上的人選舉日加發算錯。' and saved() == [], (m, saved()))
                pick('2026-11-28', 2); pg.click('#elecSave'); wait_msg('已儲存選舉假名單（2026-11-28')
                ok(bname + ' D 舊畫面＋新後端：投票日照常存', sorted(d for d, _ in saved()) == ['2026-11-28', '2026-11-28'], saved())
            b.close()
finally:
    try: proc.terminate(); proc.wait(timeout=5)
    except Exception: pass
    try: os.remove(DATA)
    except Exception: pass
n_ok = sum(1 for _, c in results if c)
print('\n%d 過、%d 失敗' % (n_ok, len(results) - n_ok))
sys.exit(0 if results and n_ok == len(results) else 1)
