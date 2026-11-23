# 班表寬限的打卡頁提示（2026-11-23 主管選短版）：clock-line.html 在開頁回應有 cap.grace_hm（且 cap.locked 不是 true）時，
# 訊息列逐字顯示「已滿 10 小時：按下班會記在 HH:MM，之後今天不能再打上班卡。早就下班了？請送忘打卡單補實際時間。」
# 用法（repo 根目錄）：python3 tests/ui/cap-grace-hint-e2e.py [截圖資料夾]
#   假後端＝mock/mock_server.py（沿用 e2e/clock_line.py 的開頁、綁定、頁內記錄），開在隨機埠，跑完用自己的程序代號收掉、刪掉 mock/mock_data*.json；
#   開頁回應在頁面路由改寫（cap 欄位），不連任何正式服務。名字、資料都是假的（測試一）。Chromium、WebKit 各跑一次。
#   A 有 grace_hm '19:00' → 整句逐字、時間 19:00；上班／下班鍵照常可按；手機寬（390、320）不破版、訊息不蓋到打卡鍵
#   B 沒有 grace_hm（cap 只有 locked:false、in_block:false＝現在後端的樣子）→ 不出現；訊息列、提示列、兩顆鍵與「原樣回應」完全相同
#   C locked:true＋grace_hm（不該同時出現，防呆）→ 不出現，照舊顯示鎖住的原因
#   D grace_hm 格式怪（'7點'）→ 不出現
import glob, json, os, socket, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = s.getsockname()[1]; s.close()
os.environ['E2E_MOCK_PORT'] = str(PORT)          # e2e/clock_line.py 在 import 時讀這個埠
sys.path.insert(0, os.path.join(ROOT, 'e2e'))
import clock_line as C  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'e2e', 'artifacts', 'cap-grace')
TEXT = '已滿 10 小時：按下班會記在 19:00，之後今天不能再打上班卡。早就下班了？請送忘打卡單補實際時間。'
LOCK_REASON = '今天出勤（含已核准請假、出差）已滿 10 小時，系統在 19:00 幫你記了下班卡'
results = []


def ok(name, cond, extra=''):
    results.append(bool(cond)); print(('✓ ' if cond else '✗ ') + name + ('' if cond else '  實際=' + repr(extra)[:400]))


def open_with(ctx, cap):
    """cap：None＝原樣（不改後端回應）；dict＝把開頁回應的 cap 換成這個。"""
    def h(route):
        try:
            b = json.loads(route.request.post_data or '{}')
        except ValueError:
            return route.continue_()
        if b.get('action') == 'liff_status' and cap is not None:
            j = route.fetch().json()
            if j.get('status') == 'ready':
                j['cap'] = cap
            return route.fulfill(status=200, body=json.dumps(j), content_type='text/plain')
        return route.continue_()
    p = ctx.new_page()
    p.add_init_script(C.LOG_JS)
    p.route('**/api/hq', h)
    p.goto(C.url((C.HQ['lat'], C.HQ['lng']), in_client=True))
    p.wait_for_function('document.getElementById("who").textContent === "測試一" && document.getElementById("btns").hidden === false', timeout=10000)
    p.wait_for_timeout(400)
    return p


def view(p):
    return {'msg': p.inner_text('#msg'), 'cls': p.get_attribute('#msg', 'class'), 'hint': p.inner_text('#hint'),
            'in': [p.inner_text('#btnIn'), p.is_disabled('#btnIn')], 'out': [p.inner_text('#btnOut'), p.is_disabled('#btnOut')]}


def layout(p, w):
    p.set_viewport_size({'width': w, 'height': 760})
    p.wait_for_timeout(300)
    return p.evaluate('''() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const m = r('msg'), i = r('btnIn'), o = r('btnOut');
      const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      return { scroll: document.documentElement.scrollWidth <= window.innerWidth, overlap: hit(m, i) || hit(m, o),
               msgInside: m.left >= 0 && m.right <= window.innerWidth };
    }''')


def main():
    proc = C.start_mock()
    try:
        with sync_playwright() as pw:
            for bname in ('chromium', 'webkit'):
                br = getattr(pw, bname).launch()
                ctx = br.new_context(viewport={'width': 390, 'height': 760}, device_scale_factor=2)
                errs = []
                if bname == 'chromium':   # 前提：先在假後端綁定（同 e2e/clock_line.py 第 1 步；假後端資料兩個瀏覽器共用）
                    p = C.open_page(ctx, C.url((C.HQ['lat'], C.HQ['lng'])))
                    p.wait_for_selector('#bindBox:not([hidden])', timeout=10000)
                    p.fill('#bindName', '測試一'); p.click('#btnBind')
                    p.wait_for_function('document.getElementById("who").textContent === "測試一"', timeout=10000)
                    p.close()
                tag = '[' + bname + '] '
                # 原樣（後端現在的回應：沒有 grace_hm）
                p = open_with(ctx, None); base = view(p); p.close()
                # B 沒有 grace_hm、cap 是現在後端的樣子
                p = open_with(ctx, {'locked': False, 'in_block': False}); p.on('pageerror', lambda e: errs.append(str(e)))
                vb = view(p)
                ok(tag + 'B 沒有 grace_hm：不出現提示', '已滿 10 小時：按下班' not in vb['msg'] + vb['hint'], vb)
                ok(tag + 'B 沒有 grace_hm：訊息、提示、兩顆鍵跟原樣回應完全相同', vb == base, (vb, base))
                p.close()
                # A 有 grace_hm
                p = open_with(ctx, {'locked': False, 'in_block': False, 'grace_hm': '19:00'}); p.on('pageerror', lambda e: errs.append(str(e)))
                va = view(p)
                ok(tag + 'A 有 grace_hm：整句逐字出現、時間 19:00', va['msg'] == TEXT, va)
                ok(tag + 'A 樣式比照既有滿 10 小時提示（msg warn、提示列空白）', va['cls'] == 'msg warn' and va['hint'] == '', va)
                ok(tag + 'A 兩顆鍵跟原樣回應一樣（提示不鎖鍵）', [va['in'], va['out']] == [base['in'], base['out']], (va, base))
                for w in (390, 320):
                    lay = layout(p, w)
                    ok(tag + 'A 寬 %d：沒有橫向捲動、訊息不蓋到打卡鍵、整句在畫面內' % w, lay == {'scroll': True, 'overlap': False, 'msgInside': True}, lay)
                    os.makedirs(OUT, exist_ok=True)
                    p.screenshot(path=os.path.join(OUT, '%s-A-grace-%d.png' % (bname, w)), full_page=True)
                p.close()
                # C locked:true＋grace_hm → 不出現
                p = open_with(ctx, {'locked': True, 'in_block': False, 'reason': LOCK_REASON, 'hint': '11/21 06:00 以後才能再打卡',
                                    'until': int(time.time() * 1000) + 3600000, 'sys_hm': '19:00', 'grace_hm': '19:00'})
                vc = view(p)
                ok(tag + 'C locked:true：不出現寬限提示、照舊顯示鎖住原因', '按下班會記在' not in vc['msg'] + vc['hint'] and vc['msg'] == LOCK_REASON, vc)
                p.close()
                # D 格式怪
                p = open_with(ctx, {'locked': False, 'in_block': False, 'grace_hm': '7點'})
                vd = view(p)
                ok(tag + 'D grace_hm 格式怪：不出現、跟原樣相同', vd == base, (vd, base))
                p.close()
                ok(tag + '頁面沒有錯誤', not errs, errs)
                br.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill(); proc.wait(timeout=5)
        for f in glob.glob(os.path.join(ROOT, 'mock', 'mock_data*.json')):   # 假後端的資料檔（start_mock 開頭也會清）
            os.remove(f)
    gone = proc.poll() is not None
    try:
        socket.create_connection(('127.0.0.1', PORT), timeout=1).close(); closed = False
    except OSError:
        closed = True
    ok('假後端程序已結束（pid %d）、埠 %d 已關' % (proc.pid, PORT), gone and closed, (proc.poll(), closed))
    bad = results.count(False)
    print('\n── 小計：通過 %d、不符 %d ──' % (len(results) - bad, bad))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
