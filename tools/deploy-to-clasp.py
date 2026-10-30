#!/usr/bin/env python3
"""把 repo 的 apps-script/*.gs 套進 ~/mala-gas 的四個 clasp 專案——保留各店 CONFIG。

為什麼需要這支（2026-09-21）：
repo 裡的 Code.gs 的 CONFIG 是 PASTE_SPREADSHEET_ID_HERE / PASTE_ADMIN_KEY_HERE 佔位符。
「整份複製過去」會把四家店的正式試算表 ID、ADMIN_KEY、店座標、PAYROLL_API 全部洗掉，
打卡會整個掛。所以每次改後端都得逐份手動套補丁——這支就是把那件事變成可重跑的動作。

做法：拿 repo 的新版 Code.gs，把**該店現有檔案裡的 CONFIG 區塊**原封不動接回去。
Payroll.gs 沒有店別專屬的值（查過：無 PASTE_／SPREADSHEET_ID／ADMIN_KEY），整份覆蓋。
2026-10-29 補：Requests／Liff／LineHub／Sched／SchedPub／SvcStaff／Mirror 也是整份覆蓋（WHOLE_FILES），
原本這支只套 Code.gs、Payroll.gs，這幾份改了都要自己手貼，容易漏（10-25 的 LineHub「重設密碼」就沒上線）。
只更新專案裡**已經有**的同名 .js（LineHub 只在光復、Mirror 只在總部），不會替哪家店新增檔案。
Sched.gs 的 SCHED_GIST_URL 已改成線上用的那顆（10-13 換的 47c876cc…），repo 與光復一致才放進清單。

安全設計：
  * **預設 dry-run**，要 --apply 才真的寫檔。
  * 寫之前先確認「該店現有檔案 ＝ git 歷史裡某一版 ＋ 該店 CONFIG」（2026-10-30 起自動找：
    沿著 HEAD 往回最多 300 個改過該檔的 commit，找到一模一樣的就印「線上是 xxx 那版」）。
    找不到＝那份檔案有沒進 git 的本機改動，停下來印 diff（對最新一版），
    不覆蓋——沒有 --force 一律不動。這道就是 2026-08-23「補丁被誤判成已套用」的解藥。
    要指定單一基準版仍可用 --base <commit>（舊行為）。
  * 寫完檢查成品不含 PASTE_ 佔位符。
  * **不碰 clasp**：不 pull 也不 push。pull 請先自己跑，push 請看過 diff 再自己按
    （repo 守則：任何 clasp push 都要先問 Eason）。

用法：
    cd ~/mala-clock-in && git checkout main && git pull origin main    # 新版程式碼從工作目錄讀，要先 pull
    cd ~/mala-gas/mala-clock-in && clasp pull     # 四個專案都先 pull
    python3 ~/mala-clock-in/tools/deploy-to-clasp.py            # 看會改什麼
    python3 ~/mala-clock-in/tools/deploy-to-clasp.py --apply    # 真的套進去
    python3 ~/mala-clock-in/tools/verify-store-backends.py      # 四家都要 ✓
    # 確認無誤後，各專案自己 clasp push

「對不起來，沒動」是正常會遇到的：代表那份 程式碼.js 跟基準版有差，可能是上次部署後
手動微調過、或基準版太舊。它會把差異印出來——看過確定那些差異可以丟掉，再加 --force；
如果那些差異該保留，先把它們補進 repo 再重跑。不要無腦 --force。
"""
import argparse, difflib, functools, pathlib, re, subprocess, sys

STORES = ['mala-clock-in', 'cf-clock-in', 'hq-clock-in', 'mztjs-clock-in', 'mztgf-clock-in', 'mztlzl-clock-in', 'mztmc-clock-in']   # 2026-10-29 補六張犁（verify-store-backends.py 早就有）
# 沒有店別專屬值、整份覆蓋的檔案：repo 檔名 → clasp 專案裡的檔名
WHOLE_FILES = [('Requests.gs', 'Requests.js'), ('Liff.gs', 'Liff.js'), ('LineHub.gs', 'LineHub.js'),
               ('SvcStaff.gs', 'SvcStaff.js'), ('Sched.gs', 'Sched.js'), ('SchedPub.gs', 'SchedPub.js'), ('Mirror.gs', 'Mirror.js')]
STORE_FILE = '程式碼.js'
CODE_SCAN = 120   # 只比程式時，往回看幾個版本
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


_CODE_CACHE = {}
def code_lines(src):
    """只留程式：拿掉 // 與 /* */ 註解、CONFIG 區塊、空行，連續空白壓成一個（2026-10-30）。
    各店 程式碼.js 以前手貼過補丁，註解跟 git 版對不上（檔名寫 .js／.gs、說明重貼兩次），
    但註解不影響運作——只差註解就可以放心覆蓋；有程式差異才要停下來。
    字串（'…' \"…\" `…`）與正規表示式裡的 // 不當註解。"""
    key = hash(src)
    if key in _CODE_CACHE:
        return _CODE_CACHE[key]
    src = CONFIG_RE.sub('', src)
    out, i, n, prev = [], 0, len(src), ''
    while i < n:
        c = src[i]
        if c in '"\'`':
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == '\\':
                    j += 2
                    continue
                if c != '`' and src[j] == '\n':
                    break
                j += 1
            out.append(src[i:j + 1]); i = j + 1; prev = c
            continue
        if c == '/' and src[i + 1:i + 2] == '/':
            j = src.find('\n', i); i = n if j < 0 else j
            continue
        if c == '/' and src[i + 1:i + 2] == '*':
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; out.append(' ')
            continue
        if c == '/' and (prev == '' or prev in '(,=:[!&|?{};+-*%<>~^'):   # 正規表示式
            j, cls = i + 1, False
            while j < n and src[j] != '\n':
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    cls = True
                elif src[j] == ']':
                    cls = False
                elif src[j] == '/' and not cls:
                    break
                j += 1
            out.append(src[i:j + 1]); i = j + 1; prev = '/'
            continue
        out.append(c)
        if not c.isspace():
            prev = c
        i += 1
    lines = [re.sub(r'\s+', ' ', l).strip() for l in ''.join(out).split('\n')]
    _CODE_CACHE[key] = [l for l in lines if l]
    return _CODE_CACHE[key]


@functools.lru_cache(maxsize=None)
def git_show(repo, ref, path):
    r = subprocess.run(['git', '-C', str(repo), 'show', f'{ref}:{path}'],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def show_diff(old, new, name, full=False, labels=('（現在）', '（套完）')):
    if isinstance(old, list):   # 已經是「只剩程式」的行
        old, new = [l + '\n' for l in old], [l + '\n' for l in new]
    else:
        old, new = old.splitlines(True), new.splitlines(True)
    d = list(difflib.unified_diff(old, new, fromfile=name + labels[0], tofile=name + labels[1], n=2))
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


def history(repo, ref, path, xf=lambda t: t, n=300):
    """git 歷史裡改過 path 的各版（新→舊），[(標籤, 取內容的函式)]；內容用到才讀，找到就停。"""
    r = subprocess.run(['git', '-C', str(repo), 'log', f'-n{n}', '--format=%h %cs', ref, '--', path],
                       capture_output=True, text=True)
    out = []
    for line in r.stdout.split('\n'):
        if not line.strip():
            continue
        h = line.split()[0]
        out.append((line.strip(), (lambda h=h: (lambda t: xf(t) if t is not None else None)(git_show(repo, h, path)))))
    return out


def process(name, cur_path, new_src, base_src, apply_, force, full):
    """回 (狀態, 變動行數)。狀態：'updated' / 'uptodate' / 'drift' / 'missing'
    base_src：字串（單一基準版）、[(標籤, 取內容的函式)]（自動找線上是哪一版）或 None（不檢查）。"""
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

    cand_list = base_src if isinstance(base_src, list) else None
    if isinstance(base_src, list):
        hit = next((lab for lab, get in base_src if get() == cur), None)
        if hit:
            print(f'    線上是 {hit} 那版')
            base_src = None
        else:
            base_src = base_src[0][1]() if base_src else None
            if base_src is None:
                print('    ⚠ git 歷史裡沒有這個檔，跳過「本機改動」檢查')
    if base_src is not None and cur != base_src:
        # 逐字對不上 → 只比程式（拿掉註解）：跟 git 某一版程式一樣＝只差註解，照樣覆蓋
        cands = cand_list if cand_list is not None else [('指定的基準版', lambda b=base_src: b)]
        cur_code = code_lines(cur)
        hit = next((lab for lab, get in cands[:CODE_SCAN] if get() is not None and code_lines(get()) == cur_code), None)
        if hit:
            print(f'    只差註解：程式跟 {hit} 那版一樣（註解不影響運作）→ 照樣覆蓋')
            base_src = None
        else:
            # 找程式最接近的一版，只列程式行的差異（註解不列）
            best, best_r = None, -1.0
            for lab, get in cands[:CODE_SCAN]:
                t = get()
                if t is None:
                    continue
                r = difflib.SequenceMatcher(None, code_lines(t), cur_code, autojunk=False).quick_ratio()
                if r > best_r:
                    best, best_r = (lab, code_lines(t)), r
            print('    ⚠ 線上這份有「程式」跟 git 裡每一版都不一樣（不只是註解）——可能有人在線上手改過程式。')
            print('      不覆蓋（要強制請加 --force，但先弄清楚差在哪）。下面只列程式行，- 是 git 有線上沒有，+ 是線上才有：')
            if best:
                print(f'      最接近的是 {best[0]} 那版')
                show_diff(best[1], cur_code, name, True, ('（git）', '（線上）'))
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


def hq_mirror_patch(src):
    """套 tools/patch_hq_mirror.py 的補丁（掛 MIRROR_HANDLERS＋兩處跳過鏡像列），冪等。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location('patch_hq_mirror', pathlib.Path(__file__).resolve().parent / 'patch_hq_mirror.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.patch(src, True)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真的寫檔（預設只 dry-run）')
    ap.add_argument('--force', action='store_true', help='目標檔與基準版對不起來時照樣覆蓋（全部）')
    ap.add_argument('--force-only', action='append', default=[], metavar='店/檔名',
                    help='只對這一份強制覆蓋，例：--force-only mala-clock-in/Sched.js（可重複；其他檔照樣擋）')
    ap.add_argument('--full', action='store_true', help='印完整 diff')
    ap.add_argument('--gas-root', default=str(pathlib.Path.home() / 'mala-gas'))
    ap.add_argument('--base', default=None, help='指定單一基準版 commit（預設：自動在 git 歷史裡找線上是哪一版）')
    a = ap.parse_args()

    repo = pathlib.Path(__file__).resolve().parent.parent
    gas = pathlib.Path(a.gas_root)
    if not gas.is_dir():
        raise SystemExit(f'✗ 找不到 {gas}——這支要在有 clasp 專案的那台機器上跑')

    code_new = (repo / 'apps-script' / 'Code.gs').read_text(encoding='utf-8')
    pay_new = (repo / 'apps-script' / 'Payroll.gs').read_text(encoding='utf-8')
    def bases(path, xf=lambda t: t):
        if a.base:
            t = git_show(repo, a.base, path)
            return xf(t) if t is not None else None
        return history(repo, 'HEAD', path, xf)
    pay_base = bases('apps-script/Payroll.gs')

    print(f'repo：{repo}\nclasp 專案：{gas}\n基準版：{a.base or "自動（git 歷史裡找線上是哪一版）"}'
          + ('\n模式：套用（會寫檔）' if a.apply else '\n模式：dry-run（不寫檔）'))

    res = {}
    for st in STORES:
        p = gas / st / STORE_FILE
        if not p.exists():
            print(f'\n▶ {st}\n    ✗ 找不到 {p}')
            res[st] = 'missing'
            continue
        cfg = config_block(p.read_text(encoding='utf-8'), f'{st}/{STORE_FILE}')
        # 總部（專案裡有 Mirror.js）的 程式碼.js 另外掛了鏡像補丁（tools/patch_hq_mirror.py）：
        # 新版與歷史版都先套同一個補丁再比、再寫，不然部署會把鏡像掛載洗掉（2026-10-30）
        mirror = (gas / st / 'Mirror.js').exists()
        def xf(t, cfg=cfg, mirror=mirror):
            if not CONFIG_RE.search(t):
                return None
            t = splice(t, cfg, 'Code.gs')
            if mirror:
                try:
                    t = hq_mirror_patch(t)
                except AssertionError:
                    return None   # 太舊的版本套不上補丁，就不拿來比
            return t
        if mirror:
            print(f'\n（{st} 有 Mirror.js → 程式碼.js 會套 patch_hq_mirror 補丁）')
        base = bases('apps-script/Code.gs', xf)
        res[st], _ = process(f'{st}/{STORE_FILE}', p, xf(code_new),
                             base, a.apply, a.force or f'{st}/{STORE_FILE}' in a.force_only, a.full)

    # 整份覆蓋的檔案：哪家專案有這個檔就更新哪家，沒有就跳過（不新增）
    for src_name, dst_name in WHOLE_FILES:
        new = (repo / 'apps-script' / src_name).read_text(encoding='utf-8')
        base = bases('apps-script/' + src_name)
        targets = [st for st in STORES if (gas / st / dst_name).exists()]
        if not targets:
            print(f'\n▶ {dst_name}\n    ⚠ 每家專案都沒有 {dst_name}，沒有套')
            res[dst_name] = 'missing'
            continue
        for st in targets:
            res[f'{st}/{dst_name}'], _ = process(f'{st}/{dst_name}', gas / st / dst_name, new,
                                                 base, a.apply, a.force or f'{st}/{dst_name}' in a.force_only, a.full)

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
                                    pay_base, a.apply, a.force or str(f.relative_to(gas)) in a.force_only, a.full)

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
