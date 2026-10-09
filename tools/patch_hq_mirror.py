#!/usr/bin/env python3
"""
總部打卡鏡像：對「總部」的 程式碼.js 套兩個小補丁（冪等、每處 assert、失敗不寫檔）。

用法（先對暫存目錄的複本跑，不要直接改 ~/mala-gas）：
  python3 tools/patch_hq_mirror.py /path/to/程式碼.js            # 乾跑：只檢查、不寫
  python3 tools/patch_hq_mirror.py /path/to/程式碼.js --write    # 寫檔

補丁 A（必要）：doPost 掛載 MIRROR_HANDLERS（mirror_run、mirror_setup_trigger）。
  不掛的話 Mirror.js 的每日觸發器仍會跑，但 mirror_run 探針會回 unknown_action。
補丁 B（建議）：recheck_approvals／backfill_missing_groups 跳過 mirror_src 非空的核定列。
  原因：總部沒有央廚的「中午休息不打卡」設定，若讓總部的 05:00 recheck 重算鏡像進來的核定，
  可能把央廚已判定的狀態改寫成另一種（並以「無 mirror_src 的本店列」形式覆蓋鏡像列）。
  鏡像列的狀態以央廚為準（央廚自己的 recheck 會更新，隔天 04:00 鏡像帶進來）。
  --no-skip 可只套補丁 A。
"""
import re
import sys

MOUNT_BLOCK = (
    "\n  // 跨店打卡鏡像（Mirror.js，只有總部部署）；Mirror.js 不存在時完全不影響其他功能。\n"
    "  if (typeof MIRROR_HANDLERS !== 'undefined') {\n"
    "    Object.keys(MIRROR_HANDLERS).forEach(function (k) { handlers[k] = MIRROR_HANDLERS[k]; });\n"
    "  }\n"
)
SKIP_LINE = "if (String(rec.mirror_src || '').trim()) return;   // 鏡像進來的核定列：狀態以來源店為準，不在這裡重算"


def patch(src, with_skip=True):
    out = src
    notes = []

    # ── 補丁 A：掛載 ──
    if 'MIRROR_HANDLERS' in out:
        notes.append('A 已套用，略過')
    else:
        m = re.search(r"(  if \(typeof LIFF_HANDLERS !== 'undefined'\) \{\n.*?\n  \}\n)", out, re.S)
        assert m, '找不到 LIFF_HANDLERS 掛載區塊（錨點）'
        assert out.count("typeof LIFF_HANDLERS !== 'undefined'") == 1, 'LIFF 掛載區塊不只一處'
        out = out[:m.end()] + MOUNT_BLOCK + out[m.end():]
        assert out.count('MIRROR_HANDLERS') == 3
        notes.append('A 已加掛載（+4 行）')

    # ── 補丁 B：兩處 forEach 開頭跳過鏡像列 ──
    if with_skip:
        if SKIP_LINE in out:
            assert out.count(SKIP_LINE) == 2, '跳過行出現次數不是 2'
            notes.append('B 已套用，略過')
        else:
            pat = re.compile(r"^([ \t]*)(const rec = dayMap\[empId\];\n)", re.M)
            hits = pat.findall(out)
            assert len(hits) == 2, '`const rec = dayMap[empId];` 應恰好 2 處（recheck＋backfill），實際 %d' % len(hits)
            out = pat.sub(lambda mm: mm.group(1) + mm.group(2) + mm.group(1) + SKIP_LINE + "\n", out)
            assert out.count(SKIP_LINE) == 2
            notes.append('B 已加兩處跳過行（+2 行）')
    return out, notes


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 1:
        print(__doc__)
        sys.exit(2)
    path = args[0]
    write = '--write' in sys.argv
    with_skip = '--no-skip' not in sys.argv
    src = open(path, encoding='utf-8').read()
    out, notes = patch(src, with_skip)
    # 設定值（試算表 ID／金鑰）一行都不可變：比對含 KEY／SPREADSHEET_ID 的行
    keep = lambda s: [l for l in s.split('\n') if re.search(r'KEY|SPREADSHEET_ID', l)]
    assert keep(src) == keep(out), '機敏設定行被動到了'
    delta = out.count('\n') - src.count('\n')
    print('；'.join(notes), '｜行數 %+d' % delta)
    if write and out != src:
        open(path, 'w', encoding='utf-8').write(out)
        print('已寫入', path)
    elif not write:
        print('乾跑：未寫檔（加 --write 才寫）')


if __name__ == '__main__':
    main()
