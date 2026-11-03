#!/usr/bin/env python3
"""值班核定頁 manager.html 與舊連結打卡頁 clock.html 的前端對抗性檢查（2026-11-03，分支 adv/modules2）：Playwright＋mock 實跑。

用法：E2E_MOCK_PORT=8981 /usr/bin/python3 tests/adversarial/front_modules.py
會清掉本 worktree 的 mock/mock_data*.json、在 E2E_MOCK_PORT（預設 8981）起 mock，跑完關掉；起之前先確認埠沒人用。
⚠ 不能和 e2e/run.py、e2e/clock_line.py、tests/adversarial/front_line.py 在同一個 worktree 同時跑（共用 mock_data*.json）。

後端回應一律用 window.fetch 攔截後灌假資料（同 front_line.py 的做法），只測畫面怎麼畫「人打的文字」：
  M1（ok）    核定頁開頁：同仁姓名／核定狀態／核定人／假別／待核定姓名／待核准裝置的姓名與裝置碼／待審申請的姓名、原因、摘要、假別／
              同仁異動名單（含離職者與操作人）／LINE 綁定紀錄（含解除者）／公告（含 id、下架日、發布者）／薪資假別名稱
              → 不能長出標籤、onerror 不能跑、屬性不能被 " 關掉（data-emp／data-id）。
  M1e（KNOWN）離職名單「恢復在職」按鈕的 data-emp 直接拼 r.emp_id 沒過 escHtml（manager.html 2634）：名冊 emp_id 帶 " 就能塞 on* 屬性
              （emp_id 只有管理金鑰 sync_roster／手動改表寫得進去，低）。
  M2（KNOWN） 新增同仁成功的回顯「✓ 已建立 <b>名字</b>」沒過 escHtml（manager.html 2568）：主管自己打的名字會被當 HTML。
  M3（KNOWN） 恢復在職成功的回顯「✓ <b>名字</b> 已恢復在職」沒過 escHtml（manager.html 2673）：名冊上的名字（別的主管／管理系統建的）會被當 HTML。
  M4（ok）    時段起訖相同（09:00–09:00）：送出前確認框會明講「會算成跨夜到隔天（24 小時）」（後端照收，見 adversarial-modules.test.js KNOWN #3）。
  M5（ok）    批次核准勾 31 筆：前端擋下、不送 mgr_req_decide_batch。
  C1（ok）    打卡頁：姓名／公告／今日紀錄狀態／最近 40 天的備註與核定狀態 → 全部 textContent。
KNOWN＝已確認的問題，只印出不讓程序失敗；設 ADV_STRICT=1 才算失敗。
"""
import glob
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(os.environ.get('E2E_MOCK_PORT', '8981'))
BASE = f'http://localhost:{PORT}'
MGR_KEY = 'testmgr1'       # mock 種子主管（mock_server.py seed_managers）
EMP_KEY = 'testkey1'       # mock 種子同仁 E01
XSS = '<img src=x onerror="window.__xss=1">'
BOLD = '<b>粗體</b>'
ATTR = '" onmouseover="window.__xss=1'   # 屬性逃脫：塞進 data-emp／data-id 這種 value="…" 的位置

FAKE_JS = """
window.__fake = {}; window.__calls = [];
const _f = window.fetch;
window.fetch = function (url, o) {
  let a = ''; try { a = JSON.parse(o.body).action; } catch (e) {}
  window.__calls.push(a);
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
        urllib.request.urlopen(BASE + '/manager.html', timeout=1)
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
            urllib.request.urlopen(BASE + '/manager.html', timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('mock 起不來')


def count_injected(p, sel):
    return p.evaluate(f"document.querySelectorAll('{sel} img').length + Array.from(document.querySelectorAll('{sel} b')).filter(b => b.textContent === '粗體').length")


def on_attrs(p, sel):
    """sel 底下任何元素帶 on* 屬性的個數（屬性逃脫成功才會有）"""
    return p.evaluate(f"Array.from(document.querySelectorAll('{sel} *')).reduce((n, el) => n + Array.from(el.attributes).filter(a => /^on/i.test(a.name)).length, 0)")


def no_html(p, sel, label, expect_text=True):
    n = count_injected(p, sel)
    oa = on_attrs(p, sel)
    xss = p.evaluate('window.__xss')
    txt = p.inner_text(sel) if p.locator(sel).count() else ''
    cond = n == 0 and oa == 0 and xss is None and (not expect_text or ('<img' in txt or '<b>' in txt or 'onmouseover' in txt))
    rec(label + '：沒長出 img／b、沒有 on* 屬性、onerror 沒跑、原字串當純文字顯示', cond, {'injected': n, 'on_attrs': oa, 'xss': xss, 'txt': txt[:160]})


def req_item(i, **kw):
    base = {'id': 'r%d' % i, 'created_at': '2026-11-01T10:%02d:00+08:00' % (i % 60), 'emp_id': 'E01', 'name': XSS + BOLD, 'kind': 'leave', 'date': '2026-11-05',
            'leave_type': XSS, 'start': '', 'end': '', 'hours': 8, 'miss_type': '', 'reason': XSS + BOLD, 'has_attach': False, 'status': 'pending',
            'decided_at': '', 'decided_by': '', 'reject_reason': '', 'proof_required': False, 'need_proof': False, 'voided_at': '', 'voided_by': '', 'void_reason': '',
            'summary': '11/5 ' + XSS + BOLD, 'upper': False, 'attach_id': '',
            'punches': [{'hm': '09:00', 'type': 'in', 'status': 'rejected_out_of_range', 'distance_m': XSS, 'accuracy_m': 600}]}
    base.update(kw)
    return base


def manager_fakes(n_requests=1):
    emp1 = {'emp_id': 'E01', 'name': XSS + BOLD, 'segments': [{'in': '09:00', 'out': '13:00', 'cross': False}], 'reference': 4, 'attempts': 0,
            'leaves': [{'type': XSS, 'hours': 2}], 'leave_type': XSS, 'leave_hours': 2, 'shift_in': '09:00', 'shift_out': '18:00',
            'approved': {'periods': [{'start': '09:00', 'end': '13:00'}], 'approved_hours': 4, 'status_text': XSS + BOLD, 'manager_name': XSS + BOLD}}
    emp2 = {'emp_id': 'E02', 'name': '測試二', 'segments': [], 'reference': None, 'attempts': 0, 'leaves': [], 'leave_type': '', 'leave_hours': '',
            'shift_in': '09:00', 'shift_out': '09:00', 'first_support': True}
    ltype = {'code': 'x1', 'name': XSS + BOLD, 'pay_ratio': 1, 'count_absent': False, 'offset_shortfall': False, 'cap_days': None, 'cap_basis': '', 'over_ratio': 0,
             'merge_into': '', 'cap_per_month': None, 'tenure_months': None, 'under_ratio': 0, 'min_unit': 'hour', 'window_before': None, 'window_days': None,
             'window_max': None, 'attend_effect': '', 'count_meal_day': 'true', 'active': 'true', 'sort': 1, 'note': ''}
    return {
        'mgr_day': {'ok': True, 'date': '2026-11-03', 'employees': [emp1, emp2], 'add_redirect': False},
        'mgr_pending_approvals': {'ok': True, 'ym': '2026-11', 'today': '2026-11-03', 'items': [{'date': '2026-11-01', 'emp_id': 'E01', 'name': XSS + BOLD}]},
        'mgr_pending_devices': {'ok': True, 'pending': [{'emp_id': 'E01', 'name': XSS + BOLD, 'device_id': XSS + BOLD, 'first_ts': '2026-11-03T09:00:00+08:00',
                                                         'last_ts': '2026-11-03T09:00:00+08:00', 'count': 1, 'all_within_range': False, 'max_distance_m': 3}]},
        'mgr_req_pending': {'ok': True, 'items': [req_item(i) for i in range(n_requests)]},
        'mgr_roster': {'ok': True, 'roster': [{'emp_id': 'E01', 'name': XSS + BOLD, 'active': True, 'created_by': XSS, 'removed_at': '', 'removed_by': ''},
                                               {'emp_id': ATTR, 'name': XSS + BOLD, 'active': False, 'created_by': '', 'removed_at': '2026-10-01T10:00:00+08:00', 'removed_by': XSS + BOLD},
                                               {'emp_id': 'E05', 'name': '離職五', 'active': False, 'created_by': '', 'removed_at': '2026-10-01T10:00:00+08:00', 'removed_by': '測試主管'}],
                       'manager_name': '測試主管', 'add_redirect': False},
        'mgr_line_binds': {'ok': True, 'days': 30, 'items': [{'ts': '2026-11-01T10:00:00+08:00', 'emp_id': 'E01', 'name': XSS + BOLD, 'type': 'unbind_by:' + XSS + BOLD, 'still_bound': False},
                                                              {'ts': '2026-11-02T10:00:00+08:00', 'emp_id': ATTR, 'name': XSS, 'type': 'bind_name', 'still_bound': True}]},
        'mgr_notices': {'ok': True, 'notices': [{'id': ATTR, 'text': XSS + BOLD, 'active': True, 'ends_on': XSS, 'expired': False,
                                                 'created_at': '2026-11-01T10:00:00+08:00', 'created_by': XSS + BOLD}], 'max_len': 120, 'max_show': 5},
        'payroll_leave_options': {'ok': True, 'store': 'SSLGF', 'ym': '2026-11', 'types': [ltype], 'quotas': {}, 'day_hours': 8, 'rule_parental': {}, 'events': {}},
    }


def manager_page(ctx, fakes):
    p = ctx.new_page()
    p.add_init_script(FAKE_JS)
    p.add_init_script('Object.assign(window.__fake, %s);' % json.dumps(fakes))
    p.goto(f'{BASE}/manager.html?k={MGR_KEY}&api=/api')
    p.wait_for_selector('#empList .card')
    for sel in ('#pendingApprovals .pa-card', '#pendingDevices .pd-card', '#pendingRequests .rq-item', '#reInactive .re-item', '#lbList .re-item', '#ntList .nt-item'):
        p.wait_for_selector(sel)
    return p


def main():
    proc = start_mock()
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context()
            ctx.set_default_timeout(15000)

            # ── M1 核定頁開頁：每個「人打的文字」欄位灌 HTML ──
            p = manager_page(ctx, manager_fakes())
            no_html(p, '#empList', 'M1a 核定清單（姓名／核定狀態／核定人／假別）')
            rec('M1a 假別下拉的選項文字不是標籤', p.evaluate("Array.from(document.querySelectorAll('#empList select option')).some(o => o.textContent.indexOf('<img') >= 0)")
                and count_injected(p, '#empList') == 0)
            no_html(p, '#pendingApprovals', 'M1b 本月待核定提醒（姓名）')
            no_html(p, '#pendingDevices', 'M1c 待核准裝置（姓名／裝置碼）')
            no_html(p, '#pendingRequests', 'M1d 待審申請（姓名／摘要／原因／假別／打卡證據）')
            # 同仁異動：姓名／操作人有 escHtml；但恢復在職按鈕的 data-emp 直接拼 r.emp_id（manager.html 2634）——
            # emp_id 只有管理金鑰 sync_roster／手動改表能寫成帶引號的值，所以列 KNOWN（低）而不是守門。
            rec('M1e 同仁異動（下拉＋離職名單＋操作人）：姓名與操作人沒長出 img／b、onerror 沒跑',
                count_injected(p, '#rosterCard') == 0 and p.evaluate('window.__xss') is None and '<img' in p.inner_text('#rosterCard'))
            rec('M1e 離職名單的 data-emp 沒被 " 逃脫（manager.html 2634 的 r.emp_id 要過 escHtml）',
                on_attrs(p, '#reInactive') == 0 and p.evaluate("document.querySelector('#reInactive .re-restore').getAttribute('data-emp')") == ATTR,
                p.evaluate("document.querySelector('#reInactive .re-restore').outerHTML.slice(0, 160)"), known=True)
            restore_btn_attrs = on_attrs(p, '#reInactive')   # 上面那條 KNOWN 的那顆按鈕，整頁掃描時扣掉
            no_html(p, '#lbList', 'M1f LINE 綁定紀錄（姓名／解除者）')
            rec('M1f 綁定紀錄的 data-emp 沒被逃脫', on_attrs(p, '#lbList') == 0)
            no_html(p, '#ntList', 'M1g 公告列表（內容／發布者／下架日）')
            rec('M1g 公告按鈕的 data-id 沒被逃脫', on_attrs(p, '#ntList') == 0 and p.evaluate("document.querySelector('#ntList .nt-act').getAttribute('data-id')") == ATTR)
            rec('M1 整頁（扣掉上面 KNOWN 那顆按鈕）沒有任何元素帶 on* 屬性、onerror 沒跑', on_attrs(p, 'body') - restore_btn_attrs == 0 and p.evaluate('window.__xss') is None)

            # ── M4 時段 09:00–09:00：確認框要講 24 小時 ──
            dialogs = []
            p.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
            p.evaluate("document.querySelector('#empList .card[data-emp-id=\"E02\"] .submit-btn').click()")
            time.sleep(0.5)
            rec('M4 時段 09:00–09:00 送出前確認框明講「會算成跨夜到隔天（24 小時）」', len(dialogs) == 1 and '24 小時' in dialogs[0] and '跨夜' in dialogs[0], dialogs)
            rec('M4 取消後沒有送 mgr_approve', 'mgr_approve' not in p.evaluate('window.__calls'))
            p.close()

            # ── M2（KNOWN）新增同仁成功回顯 ──
            fk = manager_fakes()
            fk['mgr_add_employee'] = {'ok': True, 'emp_id': 'E09', 'name': XSS + BOLD, 'key': 'kkkkkkkk', 'created_by': '測試主管', 'created_at': '2026-11-03T10:00:00+08:00'}
            p = manager_page(ctx, fk)
            p.on('dialog', lambda d: d.accept())
            p.fill('#aeName', '新人')
            p.click('#aeBtn')
            p.wait_for_function("document.getElementById('aeResult').textContent.indexOf('已建立') >= 0")
            no_html(p, '#aeResult', 'M2 新增同仁成功回顯的名字', expect_text=False)
            results[-1] = (results[-1][0], results[-1][1], True)   # KNOWN：manager.html 2568 的 res.name 沒過 escHtml
            if not results[-1][1]:
                print('   ↑ 改成 [KNOWN 待修]（manager.html 2568：show(\'✓ 已建立 <b>\' + res.name …) 沒過 escHtml；主管自己打的名字當 HTML，self-XSS）')
            p.close()

            # ── M3（KNOWN）恢復在職成功回顯 ──
            fk = manager_fakes()
            fk['mgr_set_active'] = {'ok': True, 'emp_id': 'E05', 'name': XSS + BOLD, 'active': True}
            p = manager_page(ctx, fk)
            p.on('dialog', lambda d: d.accept())
            p.evaluate("Array.from(document.querySelectorAll('#reInactive .re-restore')).filter(b => b.getAttribute('data-emp') === 'E05')[0].click()")
            p.wait_for_function("document.getElementById('reResult').textContent.indexOf('恢復在職') >= 0")
            no_html(p, '#reResult', 'M3 恢復在職成功回顯的名字', expect_text=False)
            results[-1] = (results[-1][0], results[-1][1], True)   # KNOWN：manager.html 2673 的 res.name 沒過 escHtml
            if not results[-1][1]:
                print('   ↑ 改成 [KNOWN 待修]（manager.html 2673：show(\'✓ <b>\' + res.name + \'</b> 已恢復在職…\') 沒過 escHtml；名冊上別人建的名字當 HTML）')
            p.close()

            # ── M5 批次核准 31 筆：前端擋 ──
            p = manager_page(ctx, manager_fakes(n_requests=31))
            p.check('#rqAll')
            p.click('#btnReqBatch')
            time.sleep(0.3)
            msg = p.inner_text('#rqBatchMsg')
            rec('M5 批次核准勾 31 筆：擋下「一次最多核准 30 筆」且沒送 mgr_req_decide_batch', '30 筆' in msg and 'mgr_req_decide_batch' not in p.evaluate('window.__calls'), msg)
            p.close()

            # ── C1 舊連結打卡頁 ──
            p = ctx.new_page()
            p.add_init_script(FAKE_JS)
            whoami = {'ok': True, 'emp_id': 'E01', 'name': XSS + BOLD, 'device_state': 'match',
                      'today_events': [{'ts': '2026-11-03T09:00:00+08:00', 'type': 'in', 'status': XSS + BOLD, 'accuracy_m': 5, 'low_accuracy': False}],
                      'last_counted': None, 'today_hours': {'reference': 0, 'approved': 0, 'working_since': None}, 'notices': [{'id': 'n1', 'text': XSS + BOLD}]}
            recent = {'ok': True, 'emp_id': 'E01', 'name': 'x', 'device_state': 'match',
                      'days': [{'date': '2026-11-01', 'segments': [{'in': '09:00', 'out': '13:00', 'cross': False}], 'reference': 4, 'notes': [XSS + BOLD], 'approved': 4, 'approved_status': XSS + BOLD}],
                      'month_totals': {'current': {'ym': '2026-11', 'hours': 4, 'pending_days': 0}, 'previous': {'ym': '2026-10', 'hours': 0, 'pending_days': 0}}}
            p.add_init_script('window.__fake.whoami = %s; window.__fake.my_recent = %s;' % (json.dumps(whoami), json.dumps(recent)))
            p.goto(f'{BASE}/clock.html?k={EMP_KEY}&api=/api&loc=store')
            p.wait_for_function("document.getElementById('empName').textContent.indexOf('<img') >= 0")
            no_html(p, '#empName', 'C1a 打卡頁姓名')
            no_html(p, '#noticeMsg', 'C1b 店內公告')
            no_html(p, '#todayList', 'C1c 今日紀錄的狀態字')
            p.click('#btnRecent')
            p.wait_for_selector('#recentList li')
            no_html(p, '#recentList', 'C1d 最近 40 天（備註／核定狀態）')
            rec('C1 整頁沒有任何元素帶 on* 屬性', on_attrs(p, 'body') == 0)
            p.close()
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
