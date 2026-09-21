#!/usr/bin/env python3
"""把 repo 的 apps-script/*.gs 套進 ~/mala-gas 的四個 clasp 專案——保留各店 CONFIG。

為什麼需要這支（2026-09-21）：
repo 裡的 Code.gs 的 CONFIG 是 PASTE_SPREADSHEET_ID_HERE / PASTE_ADMIN_KEY_HERE 佔位符。
「整份複製過去」會把四家店的正式試算表 ID、ADMIN_KEY、店座標、PAYROLL_API 全部洗掉，
打卡會整個掛。所以每次改後端都得逐份手動套補丁——這支就是把那件事變成可重跑的動作。

做法：拿 repo 的新版 Code.gs，把**該店現有檔案裡的 CONFIG 區塊**原封不動接回去。
Payroll.gs 沒有店別專屬的值（查過：無 PASTE_／SPREADSHEET_ID／ADMIN_KEY），整份覆蓋。

安全設計：
  * **預設 dry-run**，要 --apply 才真的寫檔。
  * 寫之前先確認「該店現有檔案 ＝ 基準版(預設 origin/main) ＋ 該店 CONFIG」。
    對不起來＝那份檔案有沒進 git 的本機改動（或已是更新的版本），停下來印 diff，
    不覆蓋——沒有 --force 一律不動。這道就是 2026-08-23「補丁被誤判成已套用」的解藥。
  * 寫完檢查成品不含 PASTE_ 佔位符。
  * **不碰 clasp**：不 pull 也不 push。pull 請先自己跑，push 請看過 diff 再自己按
    （repo 守則：任何 clasp push 都要先問 Eason）。

用法：
    cd ~/mala-clock-in && git fetch origin main   # ⚠ 基準版要是新的，不然整批誤判成漂移
    cd ~/mala-gas/mala-clock-in && clasp pull     # 四個專案都先 pull
    python3 ~/mala-clock-in/tools/deploy-to-clasp.py            # 看會改什麼
    python3 ~/mala-clock-in/tools/deploy-to-clasp.py --apply    # 真的套進去
    python3 ~/mala-clock-in/tools/verify-store-backends.py      # 四家都要 ✓
    # 確認無誤後，各專案自己 clasp push

「對不起來，沒動」是正常會遇到的：代表那份 程式碼.js 跟基準版有差，可能是上次部署後
手動微調過、或基準版太舊。它會把差異印出來——看過確定那些差異可以丟掉，再加 --force；
如果那些差異該保留，先把它們補進 repo 再重跑。不要無腦 --force。
"""
import argparse, difflib, pathlib, re, subprocess, sys

STORES = ['mala-clock-in', 'cf-clock-in', 'hq-clock-in', 'mztjs-clock-in']
STORE_FILE = '程式碼.js'
CONFIG_RE = re.compile(r'^const CONFIG = \{.*?^\};', re.S | re.M)


def config_block(src, where):
    m = CONFIG_RE.search(src)
    if not m:
        raise SystemExit(f'✗ {where}：找不到 const CONFIG {{ ... }}; 區塊，不敢動這份檔案')
    return m.group(0)


def splice(new_src, cfg, where):
    if not CONFIG_RE.search(new_src):
        raise SystemExit(f'✗ {where}：repo 版找不到 CONFIG 區塊')
    return CONFIG_RE.sub(lambda _: cfg, new_src, count=1)


def git_show(repo, ref, path):
    r = subprocess.run(['git', '-C', str(repo), 'show', f'{ref}:{path}'],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def show_diff(old, new, name, full=False):
    d = list(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                  fromfile=name + '（現在）', tofile=name + '（套完）', n=2))
    if not d:
        print('    （無變化）')
        return 0
    body = [l for l in d if l.startswith(('+', '-')) and not l.startswith(('+++', '---'))]
    cap = len(d) if full else 40
    print(f'    {len(body)} 行變動；' + ('完整 diff：' if full else f'前 {cap} 行：'))
    for l in d[:cap]:
        print('      ' + l.rstrip('\n'))
    if len(d) > cap:
        print(f'      …（還有 {len(d) - cap} 行，加 --full 看完整內容）')
    return len(body)


def process(name, cur_path, new_src, base_src, apply_, force, full):
    """回 (狀態, 變動行數)。狀態：'updated' / 'uptodate' / 'drift' / 'missing'"""
    print(f'\n▶ {name}')
    if not cur_path.exists():
        print(f'    ✗ 找不到 {cur_path}')
        return 'missing', 0
    cur = cur_path.read_text(encoding='utf-8')

    if new_src is None:
        return 'missing', 0
    if cur == new_src:
        print('    ✓ 已經是最新版，不用動')
        return 'uptodate', 0

    if base_src is not None and cur != base_src:
        print('    ⚠ 這份檔案跟基準版對不起來——有沒進 git 的本機改動，或已是更新的版本。')
        print('      不覆蓋（要強制請加 --force，但先弄清楚差在哪）：')
        show_diff(base_src, cur, name + ' vs 基準版', full)
        if not force:
            return 'drift', 0
        print('    ⚠ --force：照樣覆蓋')

    if 'PASTE_' in new_src:
        raise SystemExit(f'✗ {name}：套完的內容仍含 PASTE_ 佔位符，推上去會洗掉正式金鑰。中止。')

    n = show_diff(cur, new_src, name, full)
    if apply_:
        cur_path.write_text(new_src, encoding='utf-8')
        print('    ✓ 已寫入')
    else:
        print('    （dry-run，沒有寫入）')
    return 'updated', n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真的寫檔（預設只 dry-run）')
    ap.add_argument('--force', action='store_true', help='目標檔與基準版對不起來時照樣覆蓋')
    ap.add_argument('--full', action='store_true', help='印完整 diff')
    ap.add_argument('--gas-root', default=str(pathlib.Path.home() / 'mala-gas'))
    ap.add_argument('--base', default='origin/main', help='比對用的基準 ref（預設 origin/main）')
    a = ap.parse_args()

    repo = pathlib.Path(__file__).resolve().parent.parent
    gas = pathlib.Path(a.gas_root)
    if not gas.is_dir():
        raise SystemExit(f'✗ 找不到 {gas}——這支要在有 clasp 專案的那台機器上跑')

    code_new = (repo / 'apps-script' / 'Code.gs').read_text(encoding='utf-8')
    pay_new = (repo / 'apps-script' / 'Payroll.gs').read_text(encoding='utf-8')
    code_base = git_show(repo, a.base, 'apps-script/Code.gs')
    pay_base = git_show(repo, a.base, 'apps-script/Payroll.gs')
    if code_base is None:
        print(f'⚠ 取不到基準版 {a.base}:apps-script/Code.gs，跳過「本機改動」檢查')

    print(f'repo：{repo}\nclasp 專案：{gas}\n基準版：{a.base}'
          + ('\n模式：套用（會寫檔）' if a.apply else '\n模式：dry-run（不寫檔）'))

    res = {}
    for st in STORES:
        p = gas / st / STORE_FILE
        if not p.exists():
            print(f'\n▶ {st}\n    ✗ 找不到 {p}')
            res[st] = 'missing'
            continue
        cfg = config_block(p.read_text(encoding='utf-8'), f'{st}/{STORE_FILE}')
        base = splice(code_base, cfg, a.base) if code_base else None
        res[st], _ = process(f'{st}/{STORE_FILE}', p, splice(code_new, cfg, 'repo Code.gs'),
                             base, a.apply, a.force, a.full)

    # Payroll.gs：只在「掛著 PAYROLL_HANDLERS」的那個專案，不用猜是哪一家
    pay_files = [f for st in STORES if (gas / st).is_dir()
                 for f in sorted((gas / st).glob('*.js'))
                 if 'const PAYROLL_HANDLERS' in f.read_text(encoding='utf-8', errors='ignore')]
    if not pay_files:
        print('\n▶ Payroll\n    ⚠ 四個專案裡都找不到 const PAYROLL_HANDLERS，Payroll.gs 沒有套。')
        res['Payroll'] = 'missing'
    elif len(pay_files) > 1:
        print('\n▶ Payroll\n    ✗ 找到多個含 PAYROLL_HANDLERS 的檔案，不敢自己選：')
        for f in pay_files:
            print('      ' + str(f))
        res['Payroll'] = 'drift'
    else:
        f = pay_files[0]
        res['Payroll'], _ = process(f'Payroll（{f.relative_to(gas)}）', f, pay_new,
                                    pay_base, a.apply, a.force, a.full)

    print('\n' + '─' * 60)
    bad = [k for k, v in res.items() if v in ('drift', 'missing')]
    for k, v in res.items():
        print(f'  {"✓" if v in ("updated", "uptodate") else "✗"} {k}：'
              + {'updated': '已套用' if a.apply else '待套用', 'uptodate': '已是最新',
                 'drift': '對不起來，沒動', 'missing': '找不到檔案'}[v])
    if bad:
        print(f'\n❌ {len(bad)} 項要先處理：{"、".join(bad)}')
        return 1
    if not a.apply:
        print('\n這是 dry-run。確認沒問題後加 --apply 再跑一次。')
        return 0
    print('\n✅ 都套好了。接著跑：'
          f'\n   python3 {repo}/tools/verify-store-backends.py'
          '\n   四家都 ✓ 之後，各專案看過 diff 再自己 clasp push。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
