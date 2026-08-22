#!/usr/bin/env python3
"""從 clock.html / manager.html 產生各門市的靜態頁面。

為什麼要產生檔案而不是用 ?s= 參數：
  LINE 等 App 的「連結預覽卡」與 iOS「加入主畫面」都是讀**原始 HTML**、不執行 JavaScript，
  所以標題與圖示必須寫死在檔案裡，動態切換對它們無效。

⚠ 改完 clock.html / manager.html 後一定要重跑這支，否則各門市頁面會停在舊版：
      python3 tools/build-store-pages.py
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

STORES = {
    'cf': {'name': '中央廚房',   'clock_icon': 'icon-180-mzt.png', 'mgr_icon': 'icon-180-mzt-manager.png',
           'clock_home': '央廚打卡', 'mgr_home': '央廚值班'},
    'hq': {'name': '鼎兆元 總部', 'clock_icon': 'icon-180-mzt.png', 'mgr_icon': 'icon-180-mzt-manager.png',
           'clock_home': '總部打卡', 'mgr_home': '總部值班'},
}
PAGES = [
    ('clock.html',   'clock',   '員工打卡',     'clock_icon', 'clock_home'),
    ('manager.html', 'manager', '值班主管核定', 'mgr_icon',   'mgr_home'),
]

def build(src_name, prefix, page_title, icon_key, home_key):
    src = (ROOT / src_name).read_text(encoding='utf-8')
    for code, st in STORES.items():
        out = src
        # 1) 標題（連結預覽卡讀這個）
        out = re.sub(r'<title>[^<]*</title>', f'<title>{st["name"]} {page_title}</title>', out, count=1)
        # 2) 主畫面圖示與名稱（iOS 加入主畫面讀這兩個）
        out = re.sub(r'(<link rel="apple-touch-icon" href=")[^"]+(">)',
                     rf'\1assets/{st[icon_key]}\2', out, count=1)
        out = re.sub(r'(<meta name="apple-mobile-web-app-title" content=")[^"]+(">)',
                     rf'\g<1>{st[home_key]}\2', out, count=1)
        # 3) 門市代碼寫死，不再依賴網址參數（同仁少複製一段也不會壞）
        out = re.sub(r"var STORE_CODE = \(function \(\) \{.*?\}\)\(\);",
                     f"var STORE_CODE = '{code}';   // 由 tools/build-store-pages.py 產生，勿手改",
                     out, count=1, flags=re.S)
        out = out.replace('<!DOCTYPE html>',
                          f'<!-- 本檔由 tools/build-store-pages.py 從 {src_name} 產生，請勿手改 -->\n<!DOCTYPE html>', 1)
        dst = ROOT / f'{prefix}-{code}.html'
        dst.write_text(out, encoding='utf-8')
        print(f'  產生 {dst.name}  ← {src_name}（{st["name"]}）')

if __name__ == '__main__':
    print('產生各門市靜態頁面：')
    for a in PAGES:
        build(*a)
    print('完成。')
