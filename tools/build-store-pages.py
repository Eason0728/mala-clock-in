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

# mgr_bg／clock_bg：頁面底色。墨竹亭品牌用深綠（logo 主色 #86CBBF 的深色調），
# 留空＝沿用母版的小辛辣紅。光復不在這份清單裡，所以永遠不受影響。
MZT_BG = 'radial-gradient(120% 90% at 50% 16%, #3d8f7f 0%, #2a6b5e 55%, #1c4a41 100%) fixed'
STORES = {
    'cf': {'name': '中央廚房',   'clock_icon': 'icon-180-mzt.png', 'mgr_icon': 'icon-180-mzt-manager.png',
           'clock_home': '央廚打卡', 'mgr_home': '央廚值班',
           'favicon': 'favicon-32-mzt.png',
           'mgr_bg': MZT_BG, 'clock_bg': MZT_BG,
           # 央廚每天 12:00–13:00 吃飯休息、不打卡（2026-08-28 Eason 指定）。
           # 只影響核定頁的預填與標示，不做任何自動扣除——理由見 manager.html 的 BREAK_START 註解。
           'mgr_break': ('12:00', '13:00')},
    'hq': {'name': '鼎兆元 總部', 'clock_icon': 'icon-180-mzt.png', 'mgr_icon': 'icon-180-mzt-manager.png',
           'clock_home': '總部打卡', 'mgr_home': '總部值班',
           'favicon': 'favicon-32-mzt.png',
           'mgr_bg': MZT_BG, 'clock_bg': MZT_BG},
}
PAGES = [
    ('clock.html',   'clock',   '員工打卡',     'clock_icon', 'clock_home', 'clock_bg'),
    ('manager.html', 'manager', '值班主管核定', 'mgr_icon',   'mgr_home',   'mgr_bg'),
]
# 母版（麻的小辛辣紅）的底色宣告，要被換掉的就是這一行
RED_BG = ('background: radial-gradient(120% 90% at 50% 16%, '
          '#c9290b 0%, #a81f08 55%, #8a1906 100%) fixed;')

def build(src_name, prefix, page_title, icon_key, home_key, bg_key):
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
        # 3) 瀏覽器分頁小圖示。母版是小辛辣，墨竹亭品牌換成竹葉版；
        #    找不到母版宣告就報錯，理由同下方底色那段。
        fav = st.get('favicon')
        if fav:
            fav_pat = r'(<link rel="icon" type="image/png" sizes="32x32" href=")[^"]+(">)'
            if not re.search(fav_pat, out):
                raise SystemExit(f'✗ {src_name} 找不到 favicon 宣告，請同步更新 build-store-pages.py')
            out = re.sub(fav_pat, rf'\1assets/{fav}\2', out, count=1)
        # 4) 門市代碼寫死，不再依賴網址參數（同仁少複製一段也不會壞）
        out = re.sub(r"var STORE_CODE = \(function \(\) \{.*?\}\)\(\);",
                     f"var STORE_CODE = '{code}';   // 由 tools/build-store-pages.py 產生，勿手改",
                     out, count=1, flags=re.S)
        # 5) 底色（墨竹亭品牌換深綠）。找不到母版那行就報錯——母版改了樣式卻沒同步這裡，
        #    靜靜產出紅底頁面比直接失敗更難發現。
        bg = st.get(bg_key)
        if bg:
            if RED_BG not in out:
                raise SystemExit(f'✗ {src_name} 找不到母版底色宣告，請同步更新 build-store-pages.py 的 RED_BG')
            out = out.replace(RED_BG, f'background: {bg};', 1)
        # 6) 休息時間（不打卡）：只有核定頁有這兩個常數，母版留空＝光復不套用。
        br = st.get('mgr_break')
        if br and prefix == 'manager':
            for var, val in (('BREAK_START', br[0]), ('BREAK_END', br[1])):
                needle = f"var {var} = '';"
                if needle not in out:
                    raise SystemExit(f'✗ {src_name} 找不到 {var} 宣告，請同步更新 build-store-pages.py')
                out = out.replace(needle, f"var {var} = '{val}';", 1)
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
