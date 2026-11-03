#!/usr/bin/env python3
"""LINE 打卡前端對抗性檢查（2026-11-03）：clock-line.html／req-line.js／sched-line.js 用 Playwright＋mock 實跑。

用法：E2E_MOCK_PORT=8971 /usr/bin/python3 tests/adversarial/front_line.py
會清掉本 worktree 的 mock/mock_data*.json、在 E2E_MOCK_PORT（預設 8971）起 mock，跑完關掉；起之前先確認埠沒人用。
⚠ 不能和 e2e/run.py、e2e/clock_line.py 在同一個 worktree 同時跑（共用 mock_data*.json）。

T1–T4：把 HTML 灌進後端回應的每一個「人打的文字」欄位（姓名、公告、問候語、忘打卡提醒、申請結果、休息原因、店名、
       建議姓名、申請的假別／原因／退回理由／核准人／作廢人、班別名稱／工作站／備註）→ 畫面不能長出標籤、onerror 不能跑。
T5（KNOWN）：打卡頁開著不動、中間別的路徑打了上班卡（超過 10 分鐘）→ 這頁再按上班沒有「已經打過上班卡」確認框、後端收下第二張 ok 上班卡。
       KNOWN＝已確認的問題，只印出不讓程序失敗；設 ADV_STRICT=1 才算失敗。判斷依據是 apps-script 真函式（tests/adversarial-line.test.js 第 1 項），
       mock 只是讓畫面動起來。
"""
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get('E2E_MOCK_PORT', '8971'))
BASE = f'http://localhost:{PORT}'
STORES = {s['code']: s for s in json.load(open(os.path.join(ROOT, 'tools', 'stores.json'), encoding='utf-8'))}
HQ = STORES['hq']
XSS = '<img src=x onerror="window.__xss=1">'
BOLD = '<b>粗體</b>'   # 畫面本來就有 <b>（姓名、標題），只數內容是「粗體」的那種

FAKE_JS = """
window.__fake = {};
const _f = window.fetch;
window.fetch = function (url, o) {
  let a = ''; try { a = JSON.parse(o.body).action; } catch (e) {}
  let fk = window.__fake[a];
  if (Array.isArray(fk)) fk = fk.length > 1 ? fk.shift() : fk[0];
  if (fk) return Promise.resolve(new Response(JSON.stringify(fk)));
  return _f.apply(this, arguments);
};
"""

results = []


def rec(name, cond, detail='', known=False):
    results.append((name, bool(cond), known))
    tag = '✓ ' if cond else ('✗ [KNOWN 待修] ' if known else '✗ ')
    print(tag + name + ('' if cond else '  ← ' + str(detail)[:300]))


def start_mock():
    try:
        urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
        raise SystemExit(f'port {PORT} 已有伺服器在跑，請設 E2E_MOCK_PORT 換一個')
    except OSError:
        pass
    for f in glob.glob(os.path.join(ROOT, 'mock', 'mock_data*.json')):
        os.remove(f)
    env = dict(os.environ, MOCK_PORT=str(PORT))
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'mock', 'mock_server.py')], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + '/clock-line.html', timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('mock 起不來')


def url(uid='U1', extra=''):
    return f"{BASE}/clock-line.html?mock_uid={uid}&api=/api&loc={HQ['lat']},{HQ['lng']}&acc=10{extra}"


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())


def count_injected(p, sel):
    return p.evaluate(f"document.querySelectorAll('{sel} img').length + Array.from(document.querySelectorAll('{sel} b')).filter(b => b.textContent === '粗體').length")


def no_html(p, sel, label):
    n = count_injected(p, sel)
    xss = p.evaluate('window.__xss')
    txt = p.inner_text(sel)
    rec(label + '：沒有長出 img／b 標籤、onerror 沒跑、原字串當純文字顯示', n == 0 and xss is None and ('<img' in txt or '<b>' in txt),
        {'injected': n, 'xss': xss, 'txt': txt[:160]})


def status_ready(name, notices, rest=None):
    return {'ok': True, 'status': 'ready', 'name': name, 'notices': notices, 'shift_in': '', 'shift_out': '', 'today': [],
            'guard': {'blocked': None, 'lock': {}, 'last': None, 'now': 0}, 'rest': rest or {'blocked': False}}


def main():
    proc = start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context()
            ctx.set_default_timeout(15000)

            # T1 打卡頁
            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            st = status_ready(XSS, [{'text': XSS + BOLD}]); st['guard']['now'] = int(time.time() * 1000)
            p.add_init_script('window.__fake.liff_status = %s; window.__fake.liff_punch = %s;' % (json.dumps(st), json.dumps(
                {'ok': True, 'type': 'in', 'ts': '2026-11-03T09:00:00+08:00', 'greeting': XSS, 'missed': XSS, 'missed_date': '2026-11-02', 'missed_type': 'out',
                 'req_notes': ['✕ 申請被退回：' + XSS], 'via_qr': False})))
            p.goto(url())
            p.wait_for_function('!document.getElementById("btnIn").disabled')
            no_html(p, '#who', 'T1a 姓名')
            no_html(p, '#noticeMsg', 'T1b 店內公告')
            p.click('#btnIn')
            p.wait_for_function('document.getElementById("msg").textContent.indexOf("上班打卡成功") >= 0')
            no_html(p, '#msg', 'T1c 打卡結果（問候語／忘打卡提醒／申請結果）')
            p.close()

            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            st = status_ready('王', [], {'blocked': True, 'code': 'gap', 'reason': XSS, 'hint': BOLD, 'until': int(time.time() * 1000) + 3600000})
            st['guard']['now'] = int(time.time() * 1000)
            p.add_init_script('window.__fake.liff_status = %s;' % json.dumps(st))
            p.goto(url())
            p.wait_for_function('document.getElementById("msg").textContent.length > 0')
            no_html(p, '#msg', 'T1d 休息不足原因')
            rec('T1d 休息不足：上班鍵鎖住、下班鍵可按', p.is_disabled('#btnIn') and not p.is_disabled('#btnOut'))
            p.close()

            # T2 綁定框
            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            p.add_init_script('window.__fake.liff_status = %s; window.__fake.line_hub_status = %s;' % (
                json.dumps({'ok': False, 'error': 'not_bound'}),
                json.dumps({'ok': True, 'status': 'fail', 'result': {'ok': False, 'code': 'not_bound', 'store_name': XSS, 'suggest_name': XSS, 'reason': 'x', 'hint': 'y'}})))
            p.goto(url())
            p.wait_for_selector('#bindBox:not([hidden])')
            no_html(p, '#bindBox', 'T2a 綁定框（建議姓名）')
            no_html(p, '#storeName', 'T2b 店名')
            p.close()

            # T3 申請頁（我的申請＋請假分頁）
            def req(i, **kw):
                base = {'id': 'r%d' % i, 'created_at': '2026-11-01T1%d:00:00+08:00' % i, 'emp_id': 'E01', 'name': XSS, 'kind': 'leave', 'date': '2026-11-05',
                        'leave_type': XSS, 'start': '', 'end': '', 'hours': 8, 'miss_type': '', 'reason': XSS, 'has_attach': False, 'status': 'pending',
                        'decided_at': '', 'decided_by': XSS, 'reject_reason': '', 'proof_required': False, 'need_proof': False, 'voided_at': '', 'voided_by': '', 'void_reason': ''}
                base.update(kw)
                return base
            reqs = [req(0, status='rejected', reject_reason=XSS + BOLD),
                    req(1, kind='ot', start='18:00', end='20:00', hours=2, status='voided', voided_by=XSS, void_reason=XSS),
                    req(2, kind='miss', miss_type='in', start='09:00', hours=None, status='approved')]
            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            p.add_init_script('window.__fake.line_hub_req_init = %s; window.__fake.req_info = %s;' % (
                json.dumps({'ok': True, 'stores': [{'code': 'hq', 'name': XSS, 'emp_id': 'E01', 'emp_name': XSS}, {'code': '', 'name': '光復', 'emp_id': 'G1', 'emp_name': 'g'}],
                            'punch_store': 'hq', 'comp': {'allowed': True, 'ot_h': 2, 'used_h': 0, 'balance_h': 2, 'ym': '2026-11'},
                            'leave_types': {'common': ['特休假', XSS], 'special': [XSS]},
                            'quota': [{'name': XSS, 'cap_days': 3, 'cap_h': 24, 'remain_h': 8, 'used_h': 16, 'basis': 'year'}]}),
                json.dumps({'ok': True, 'name': XSS, 'emp_id': 'E01', 'today': '2026-11-03', 'requests': reqs, 'miss_days': 7, 'leave_types': ['特休假', '事假'], 'proof_types': ['病假']})))
            p.goto(url(extra='&view=req&tab=mine'))
            p.wait_for_selector('#reqView .rq-item')
            no_html(p, '#reqView', 'T3a 我的申請（店名／同仁名／假別／原因／退回理由／核准人／作廢人）')
            if p.locator('#reqView .rq-tab').count():
                p.click('#reqView .rq-tab >> nth=0'); time.sleep(0.3)
            rec('T3b 請假分頁：假別選項、額度文字沒有變成標籤', count_injected(p, '#reqView') == 0 and p.evaluate('window.__xss') is None)
            p.close()

            # T4 出勤班表
            days = [{'d': d, 'code': 'A', 'label': XSS, 'segs': [['10:00', '14:00'], ['17:00', '21:00']], 'hours': 8, 'work': True, 'rest': False,
                     'station': XSS, 'note': {'lunch': XSS, 'dinner': BOLD}} for d in range(1, 31)]
            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            p.add_init_script('window.__fake.line_hub_sched = %s;' % json.dumps(
                {'ok': True, 'ym': '2026-11', 'months': ['2026-10', '2026-11'], 'today': '2026-11-03', 'status': 'ready', 'name': XSS, 'days': days,
                 'summary': {'work_days': 30, 'off_days': 0, 'hours': 240}, 'next': {'date': '2026-11-04', 'label': XSS, 'segs': [['10:00', '14:00']], 'hours': 4, 'station': XSS}}))
            p.goto(url(extra='&view=sched'))
            p.wait_for_selector('#schedView .sc-day')
            no_html(p, '#schedView', 'T4a 班表月曆（姓名／班別／工作站／備註）')
            if p.locator('#schedView .sc-tab').count():
                p.click('#schedView .sc-tab >> nth=1'); time.sleep(0.3)
            rec('T4b 本月摘要（下一個班）沒有變成標籤', count_injected(p, '#schedView') == 0 and p.evaluate('window.__xss') is None)
            p.close()

            # T5（KNOWN）舊狀態頁面：同型確認框只看開頁時讀到的狀態
            post('/api/hq', {'action': 'liff_bind', 'id_token': 'MOCK_ID_TOKEN_U5', 'key': 'testkey1'})
            p = ctx.new_page(); p.add_init_script(FAKE_JS)
            dialogs = []
            p.on('dialog', lambda d: (dialogs.append(d.message), d.accept()))
            p.goto(url(uid='U5'))
            p.wait_for_function('!document.getElementById("btnIn").disabled')
            r = post('/api/hq', {'action': 'liff_punch', 'id_token': 'MOCK_ID_TOKEN_U5', 'type': 'in', 'lat': HQ['lat'], 'lng': HQ['lng'], 'accuracy': 5})
            rec('T5a 頁面開著時，另一條路（舊連結／另一個視窗）打上班卡成功', r.get('ok') is True, r)
            fp = os.path.join(ROOT, 'mock', 'mock_data_hq.json')
            data = json.load(open(fp, encoding='utf-8'))
            tz = timezone(timedelta(hours=8))
            for e in data['events']:
                if e['emp_id'] == 'E01' and e['type'] == 'in':
                    e['ts'] = (datetime.now(tz) - timedelta(minutes=20)).strftime('%Y-%m-%dT%H:%M:%S+08:00')   # 讓那張卡超過 10 分鐘鎖
            json.dump(data, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
            p.click('#btnIn')
            p.wait_for_function('(function(){var t=document.getElementById("msg").textContent; return t.indexOf("打卡") >= 0 && t.indexOf("送出") < 0;})()')
            m = p.inner_text('#msg')
            data = json.load(open(fp, encoding='utf-8'))
            ins = [e for e in data['events'] if e['emp_id'] == 'E01' and e['type'] == 'in' and e['status'] == 'ok']
            rec('T5b 舊狀態頁面按上班：應先跳「已經打過上班卡」確認框（目前沒跳，而且後端收下第二張 ok 上班卡）',
                len(dialogs) == 1 and len(ins) == 1, {'dialogs': dialogs, 'ok_ins': len(ins), 'msg': m[:80]}, known=True)
            p2 = ctx.new_page(); p2.add_init_script(FAKE_JS)
            d2 = []
            p2.on('dialog', lambda d: (d2.append(d.message), d.dismiss()))
            p2.goto(url(uid='U5'))
            p2.wait_for_function('!document.getElementById("btnIn").disabled || document.getElementById("btnIn").textContent.indexOf("分後") >= 0')
            if p2.is_disabled('#btnIn'):
                rec('T5c 對照：新開頁面讀到剛打的那張 → 10 分鐘內上班鍵鎖住', True)
            else:
                p2.click('#btnIn'); time.sleep(0.5)
                rec('T5c 對照：新開頁面按上班會先跳同型確認框', len(d2) == 1 and '已經打過上班卡' in d2[0], d2)
            p.close(); p2.close()
            br.close()
    finally:
        proc.kill()
        for f in glob.glob(os.path.join(ROOT, 'mock', 'mock_data*.json')):
            os.remove(f)
    bad = [r for r in results if not r[1] and not r[2]]
    known = [r for r in results if not r[1] and r[2]]
    print(f'\n通過 {len(results) - len(bad) - len(known)} 項；KNOWN 待修 {len(known)} 項' + (f'；失敗 {len(bad)} 項：' + '、'.join(r[0] for r in bad) if bad else ''))
    if bad or (os.environ.get('ADV_STRICT') == '1' and known):
        sys.exit(1)


if __name__ == '__main__':
    main()
