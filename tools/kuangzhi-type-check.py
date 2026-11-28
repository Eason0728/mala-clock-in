# -*- coding: utf-8 -*-
"""曠職上線前檢查：各薪資單位的「曠職」假別列有沒有被改名、停用（全唯讀；2026-11-28 外部審查第一輪擋項 2，主管選 B）。

為什麼：開關打開後，打卡端存假別設定會擋改名／停用／刪除曠職列（Payroll.gs payKzTypeLockCheck_），但**開開關前就已經改名或停用**的店擋不到——
  那種店認定的曠職會漏扣（扣款歸集照假別名稱對），改名後的假別還能在一般核定直接選、手登就被扣全薪÷30。所以開開關前九店都要通過這支。
做法：只用既有的唯讀動作 payroll_leave_type_get（薪資頁「假別設定」開頁時就用這支；光復那套 Apps Script，帶光復的管理金鑰、逐一帶薪資單位代碼）。
  回應是「該單位生效的假別清單」（停用列不在裡面），本工具只看代碼 absent 或名稱「曠職」的列，只印：有沒有、名稱是不是「曠職」、是否啟用、對全勤欄位（attend_effect）的值。
  不印金額、給薪比例、其他假別的任何內容；不寫任何東西。
判定：
  ‧有「代碼 absent、名稱不是曠職」的列 → 不通過（被改名；一般核定選得到、會被當曠職扣）
  ‧名稱是「曠職」的生效列不只一列（名稱先全形半形統一、拿掉空白再比），或唯一那列代碼不是 absent → 不通過（歸集或全勤可能改由別列決定）
  ‧唯一那列的「併入」有填、勾了「可抵不足」、或「算餐費日」關掉 → 不通過（會讓曠職影響別的假別或金額；開關打開後計算端也會忽略，但要改回預設）
  ‧回應標 is_default（這家沒有任何自訂假別列）→ 未確認：分不出「真的沒有自訂列（用內建，OK）」和「讀假別表失敗、用內建組出來的回應」，請在光復試算表 payroll_leave_type 分頁確認
  ‧名稱「曠職」的生效列恰好一列、代碼 absent、上面三個欄位都是預設 → 通過
  ‧看不到曠職列：開關已開 → 不通過（表上有停用的曠職列把內建列蓋掉）；開關還沒開 → 未確認（沒有曠職列＝開開關後用內建＝OK；或有停用的曠職列＝不 OK）
    → 開關打開後、任何人認定之前立刻再跑一次（那時看不到＝確定不通過，要馬上把開關關回去或改好）。
管理金鑰：同 late-first-block/deploy/props_check.py，用 ~/dzy-mini-playbook/docs/clock-to-mini/p1s3/lib.py 的 load_admin_key（在這個行程裡讀、只進記憶體、不印、不落檔、不上命令列）。
用法：python3 tools/kuangzhi-type-check.py            （全部單位）
      python3 tools/kuangzhi-type-check.py --self-test  （不連網路，只跑判定的手算案例）
注意（不是完全唯讀的兩種情況）：payroll_leave_type_get 讀表時，若光復試算表沒有 payroll_leave_type 分頁，會照既有行為建一張只有表頭的空分頁（薪資頁開頁也一樣）；
  正式環境有在用假別設定、應已存在。讀表失敗時這支 GET 會用內建假別組出成功回應（is_default:true）——本工具把 is_default 一律判「未確認」。
  不建表、又分得出讀表失敗的現成讀法只有 payroll_shadow_export（w2，總管理金鑰、一次回整份薪資資料），本工具不用它（會把薪資內容讀進記憶體）。"""
import importlib.util
import pathlib
import re
import sys
import unicodedata

sys.dont_write_bytecode = True
UNITS = ['SSLGF', 'CF', 'HQ', 'SSLHQ', 'MZTHQ', 'MZTJS', 'MZTGF', 'MZTLZL', 'MZTMC', 'MZTRG', 'MZTWX']   # 薪資單位代碼（營運系統 duty.js STORES.pay＋總部三個薪酬單位）
KZ_NAME, KZ_CODE = '曠職', 'absent'
P1S3 = pathlib.Path.home() / 'dzy-mini-playbook' / 'docs' / 'clock-to-mini' / 'p1s3' / 'lib.py'


def nm(v):
    """名稱正規化（同 Payroll.gs payKzNm_：NFKC、拿掉所有空白）"""
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(v if v is not None else '')))


def verdict(resp):
    """resp＝payroll_leave_type_get 的回應 dict。回 (判定, 說明列 list)；只用曠職相關欄位。"""
    if not isinstance(resp, dict) or resp.get('ok') is not True or not isinstance(resp.get('types'), list):
        return '未確認', ['讀不到（回應不是成功的假別清單）']
    on = resp.get('kz_on') is True
    types = [t for t in resp['types'] if isinstance(t, dict)]
    kz = [t for t in types if str(t.get('code', '')).strip() == KZ_CODE or nm(t.get('name', '')) == KZ_NAME]
    named = [t for t in types if nm(t.get('name', '')) == KZ_NAME]
    lines = []
    for t in kz:
        name0 = str(t.get('name', '')).strip()
        lines.append('曠職列：存在（代碼 %s）｜名稱是曠職：%s｜啟用：是｜對全勤欄位 attend_effect＝%s｜併入＝%s｜可抵不足＝%s｜算餐費日＝%s' % (
            str(t.get('code', '')).strip() or '（空）', '是' if name0 == KZ_NAME else '否', str(t.get('attend_effect', '')).strip() or '（空白＝照 count_absent）',
            str(t.get('merge_into', '') or '').strip() or '（空白）', '是' if t.get('offset_shortfall') is True else '否', '否' if t.get('count_meal_day') is False else '是'))
    lines.append('同名「曠職」生效列數：%d' % len(named))
    alias = [t for t in kz if str(t.get('code', '')).strip() == KZ_CODE and str(t.get('name', '')).strip() != KZ_NAME]
    if alias:
        return '不通過', lines + ['代碼 absent 的列被改了名字：認定的曠職歸集不到、這個名字在一般核定選得到又會被當曠職扣 → 改回「曠職」']
    if len(named) > 1:
        return '不通過', lines + ['不只一列叫「曠職」：扣款與全勤可能照別列算 → 只留代碼 absent 那列叫曠職，其他列改名']
    if len(named) == 1 and str(named[0].get('code', '')).strip() != KZ_CODE:
        return '不通過', lines + ['叫「曠職」的列代碼不是 absent → 改成 absent，或把它改名（改名後開關打開會用內建曠職列）']
    if len(named) == 1:
        t = named[0]
        if str(t.get('merge_into', '') or '').strip() or t.get('offset_shortfall') is True or t.get('count_meal_day') is False:
            return '不通過', lines + ['曠職列的「併入」「可抵不足」「算餐費日」要是預設（空白／不勾／算）→ 改回']
        if resp.get('is_default') is True:
            return '未確認', lines + ['這家沒有任何自訂假別列（is_default）：可能真的沒有（用內建，OK），也可能讀假別表失敗 → 到光復試算表 payroll_leave_type 分頁確認']
        return '通過', lines
    if resp.get('is_default') is True:
        return '未確認', ['這家沒有任何自訂假別列（is_default）：可能真的沒有（用內建），也可能讀假別表失敗 → 到光復試算表 payroll_leave_type 分頁確認']
    if on:
        return '不通過', ['曠職列：生效清單看不到（開關已開）＝表上有停用的曠職列蓋掉內建列 → 把它改回啟用']
    return '未確認', ['曠職列：生效清單看不到（開關還沒開）＝沒有曠職列（開開關後用內建，OK）或有停用的曠職列（不 OK）→ 開關打開後、認定前立刻再跑一次']


def self_test():
    T = lambda **k: dict({'code': 'personal', 'name': '事假', 'attend_effect': ''}, **k)
    K = lambda **k: dict({'code': 'absent', 'name': '曠職', 'attend_effect': 'void'}, **k)
    cases = [
        ({'ok': True, 'types': [T(), K()]}, '通過'),
        ({'ok': True, 'types': [T(), K()], 'kz_on': True}, '通過'),
        ({'ok': True, 'types': [T(), K(name='無故缺勤')]}, '不通過'),
        ({'ok': True, 'types': [T(), K(code='kz1'), K(name='缺勤')]}, '不通過'),
        ({'ok': True, 'types': [T(), K(code='kz1')]}, '不通過'),
        ({'ok': True, 'types': [T(), K(merge_into='xpaid')]}, '不通過'),
        ({'ok': True, 'types': [T(), K(offset_shortfall=True)]}, '不通過'),
        ({'ok': True, 'types': [T(), K(count_meal_day=False)]}, '不通過'),
        ({'ok': True, 'types': [T(), K()], 'kz_on': True, 'is_default': True}, '未確認'),
        ({'ok': True, 'types': [T()], 'is_default': True}, '未確認'),
        ({'ok': True, 'types': [T(name='曠職'), K()]}, '不通過'),
        ({'ok': True, 'types': [T(), K(), K(code='k2', name='曠　職')]}, '不通過'),
        ({'ok': True, 'types': [T()]}, '未確認'),
        ({'ok': True, 'types': [T()], 'kz_on': True}, '不通過'),
        ({'ok': False, 'error': 'unauthorized'}, '未確認'),
        (None, '未確認'),
    ]
    bad = 0
    for resp, want in cases:
        got, lines = verdict(resp)
        ok = got == want
        bad += 0 if ok else 1
        print(('✓' if ok else '✗') + ' ' + want + '：' + (str(resp)[:90] if resp else 'None') + ('' if ok else '  實際＝' + got))
        for ln in lines:
            if '給薪' in ln or 'pay_ratio' in ln:
                bad += 1
                print('✗ 印出了不該印的欄位：' + ln)
    print(('✅' if not bad else '❌') + ' 判定手算 %d 例、錯 %d' % (len(cases), bad))
    return 1 if bad else 0


def main():
    if '--self-test' in sys.argv[1:]:
        return self_test()
    if not P1S3.exists():
        sys.exit('找不到 %s（共用它讀管理金鑰與打 Apps Script）' % P1S3)
    spec = importlib.util.spec_from_file_location('p1s3lib', str(P1S3))
    p1 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p1)
    for fn in ('load_admin_key', 'post_json', 'STORES'):
        if not hasattr(p1, fn):
            sys.exit('p1s3 lib.py 少了 %s（被改過？）；先停' % fn)
    dep = p1.STORES['gf'][2]
    k = p1.load_admin_key('gf')
    if not k:
        sys.exit('未確認：讀不到光復的管理金鑰')
    print('曠職上線前檢查（唯讀；只看曠職列）')
    res = {}
    for u in UNITS:
        try:
            j, _ms, _n = p1.post_json(dep, {'action': 'payroll_leave_type_get', 'admin_key': k, 'store': u}, secrets=(k,))
        except Exception as e:   # 回應裡出現金鑰等：停下，不印內容
            j = None
            print('%s：未確認（%s）' % (u, type(e).__name__))
        v, lines = verdict(j)
        res[u] = v
        print('%s：%s%s' % (u, v, '（開關已開）' if isinstance(j, dict) and j.get('kz_on') is True else ''))
        for ln in lines:
            print('    ' + ln)
    n_ok = sum(1 for v in res.values() if v == '通過')
    print('合計：通過 %d／%d；不通過 %d；未確認 %d' % (n_ok, len(UNITS), sum(1 for v in res.values() if v == '不通過'), sum(1 for v in res.values() if v == '未確認')))
    return 0 if n_ok == len(UNITS) else 1


if __name__ == '__main__':
    sys.exit(main())
