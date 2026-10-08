#!/usr/bin/env python3
"""把 tools/stores.json 的店家表寫進 clock-line.html（/* STORES:BEGIN */ … /* STORES:END */ 之間）。
打卡畫面用這張表自己挑店、直接打那家店的後端（方案 C，2026-10-08）。
只放代碼、名稱、座標、半徑、後端網址——網址本來就公開在各店打卡連結裡；試算表 ID、金鑰一律不放。
用法：python3 tools/build-line-page.py        # 寫入
      python3 tools/build-line-page.py --check  # 只比對，不一致就失敗（測試用）"""
import json, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIELDS = ("code", "name", "lat", "lng", "radius_m", "api")


def block():
    stores = json.load(open(os.path.join(ROOT, "tools", "stores.json"), encoding="utf-8"))
    rows = [{k: s[k] for k in FIELDS} for s in stores]
    body = ",\n".join("    " + json.dumps(r, ensure_ascii=False) for r in rows)
    return "/* STORES:BEGIN（tools/build-line-page.py 產生，勿手改）*/\n  var STORES = [\n" + body + "\n  ];\n  /* STORES:END */"


def main():
    path = os.path.join(ROOT, "clock-line.html")
    html = open(path, encoding="utf-8").read()
    pat = re.compile(r"/\* STORES:BEGIN.*?/\* STORES:END \*/", re.S)
    if not pat.search(html):
        sys.exit("clock-line.html 找不到 STORES:BEGIN／END 標記")
    new = pat.sub(lambda m: block(), html)
    if "--check" in sys.argv:
        if new != html:
            sys.exit("clock-line.html 的店家表與 tools/stores.json 不一致，請跑 python3 tools/build-line-page.py")
        print("店家表一致")
        return
    open(path, "w", encoding="utf-8").write(new)
    print("已寫入 %d 家店" % len(json.load(open(os.path.join(ROOT, "tools", "stores.json"), encoding="utf-8"))))


if __name__ == "__main__":
    main()
