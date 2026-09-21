#!/usr/bin/env python3
"""驗證各門市的 Apps Script 後端都有同一套功能。

為什麼需要這支（2026-08-23 的教訓）：
央廚／總部各有一份自己的 `程式碼.js`，改後端時要逐份套補丁。補丁腳本判斷「是否已套用」
時我用了子字串 `'isTrip' in src`，而前一步剛加的 `isTripDay` 就含這個子字串
→ 三份檔案全被誤判成已套用而跳過 → 呼叫端傳了第四個參數但函式簽名沒收
→ 出差照樣扣全勤。而 `node --check` 完全過（JS 多傳參數合法）。
是部署完逐一 grep 簽名才發現的。**這支就是把那次的 grep 變成可重跑的檢查。**

用法：
    cd ~/mala-gas/mala-clock-in && clasp pull      # 每個專案都先 pull
    python3 ~/mala-clock-in/tools/verify-store-backends.py
"""
import pathlib, re, sys

GAS = pathlib.Path.home() / 'mala-gas'
STORES = ['mala-clock-in', 'cf-clock-in', 'hq-clock-in', 'mztjs-clock-in']

# 每家店都必須有的 action（doPost 路由）
ACTIONS = ['clock', 'whoami', 'sync_roster', 'get_roster', 'get_events', 'approve_device',
           'my_recent', 'mgr_day', 'mgr_approve', 'mgr_pending_devices', 'mgr_device_decision',
           'set_shifts', 'mgr_add_employee', 'recent_hires', 'backfill_missing_groups']
# 每家店都必須有的函式
FUNCS = ['handleClock', 'handleMgrDay', 'handleMgrApprove', 'normShiftTime', 'isTripDay',
         'nextEmpId', 'handleSetShifts', 'handleMgrAddEmployee', 'handleRecentHires',
         'computeApprovalStatus', 'pairShifts', 'buildLatestApprovedMap',
         'recomputeApprovalStatusOf', 'backfillMissingPunchGroups', 'statusDiffIsOnlyMissingGroup']
# 精確片段：只查函式名會被子字串誤判，這些要比對完整寫法
EXACT = {
    'computeApprovalStatus 有 isTrip＋休息帶參數': 'hadUnrecordedAttempts, isTrip, breakWindow)',
    '出差在假別白名單':                      "'出差'",
    '名冊有 shift_in／shift_out':            "'shift_in', 'shift_out'",
    '名冊有 created_at／created_by':         "'created_at', 'created_by'",
    'CONFIG 有 DEFAULT_SHIFT_IN':            'DEFAULT_SHIFT_IN',
    # 2026-08-23 審查修正批：出差空時段硬擋＋假別白名單外查薪酬表
    '出差空時段要擋':                        "error: 'trip_needs_periods'",
    '白名單外查薪酬假別表':                  'function leaveTypeAllowedByPayroll',
    'CONFIG 有 PAYROLL_API':                 'PAYROLL_API',
    # 2026-09-21 少刷一組卡（許正昊 9/21）：中間漏刷一組上下班卡，頭尾兩張被配成一長段，
    # pairShifts 標不出任何忘刷卡。三個片段缺任一個，那家店就是沒套到這批。
    '少刷：常數':                            "const MISSING_GROUP_PREFIX = '少刷'",
    '少刷：核定反向檢查':                    "notes.push(MISSING_GROUP_PREFIX + missingGroups + '組卡')",
    '少刷：列入異常分類':                    "{ key: '少刷卡', prefixes: [MISSING_GROUP_PREFIX] }",
    '少刷：回填預設 dry-run':                'body.apply === true',
    # 2026-09-22 不打卡休息帶：央廚每天預填就是兩段，沒有這個排除會被整店冤枉標少刷。
    '少刷：休息帶排除':                      'gapExplainedByBreak(maxEnd, ps[i].startMs, breakWindow)',
    '少刷：休息帶由呼叫端算好傳入':          'noPunchBreakWindow(date)',
}

# 各店專屬設定：CONFIG 的不打卡休息帶必須與 tools/build-store-pages.py 的 mgr_break 一致。
# 只改一邊＝核定頁照樣挖缺口、後端卻把那個缺口當漏刷（或反過來，真的漏刷抓不到）。
STORE_BREAK = {
    'mala-clock-in':  ('', ''),            # 光復：排班浮動，沒有固定不打卡休息
    'cf-clock-in':    ('12:00', '13:00'),  # 央廚：規定中午休息不打卡
    'hq-clock-in':    ('', ''),            # 總部
    'mztjs-clock-in': ('', ''),            # 金山：Eason 2026-09-08 指定不設
}

bad = 0
for st in STORES:
    f = GAS / st / '程式碼.js'
    if not f.exists():
        print(f'✗ {st}：找不到 {f}'); bad += 1; continue
    src = f.read_text(encoding='utf-8')
    miss_a = [a for a in ACTIONS if not re.search(rf'^\s*{a}:', src, re.M)]
    miss_f = [x for x in FUNCS if f'function {x}' not in src]
    miss_e = [k for k, v in EXACT.items() if v not in src]
    ok = not (miss_a or miss_f or miss_e)
    print(f'{"✓" if ok else "✗"} {st}')
    if miss_a: print(f'    缺 action：{"、".join(miss_a)}')
    if miss_f: print(f'    缺函式：{"、".join(miss_f)}')
    if miss_e: print(f'    缺片段：{"、".join(miss_e)}')
    want_bs, want_be = STORE_BREAK.get(st, ('', ''))
    for key, want in (('NO_PUNCH_BREAK_START', want_bs), ('NO_PUNCH_BREAK_END', want_be)):
        m = re.search(rf"^\s*{key}: '([^']*)'", src, re.M)
        got = m.group(1) if m else None
        if got != want:
            print(f'    ⚠ {key} ＝ {got!r}，應為 {want!r}'
                  f'（要與 build-store-pages.py 的 mgr_break 一致）'); ok = False

    # 機敏值必須是真值不是佔位符（覆蓋錯會把正式金鑰洗掉）
    if 'PASTE_' in src:
        print('    ⚠ 有 PASTE_ 佔位符——這份檔案不能推上去，會洗掉正式金鑰'); ok = False
    if not ok: bad += 1

print('\n' + ('✅ 各門市後端功能一致' if bad == 0 else f'❌ {bad} 家有問題'))
sys.exit(1 if bad else 0)
