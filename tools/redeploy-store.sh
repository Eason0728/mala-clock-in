#!/usr/bin/env bash
# 把 ~/mala-gas 裡已經套好的門市後端推上 Google 並切換正式部署（2026-10-30）。
# 先跑 deploy-to-clasp.py --apply 與 verify-store-backends.py，全部 ✓ 才用這支。
#
# 用法：
#   tools/redeploy-store.sh mala-clock-in                 # 一家（光復先做、測過再做其他家）
#   tools/redeploy-store.sh cf-clock-in hq-clock-in ...   # 多家，依序做，任一家失敗就停
#   tools/redeploy-store.sh --others                      # 光復以外的全部
#   tools/redeploy-store.sh --check                       # 只檢查：每家後台回不回應（不部署）
#   環境變數 MSG＝版本說明（預設「部署 日期」）
#
# 每家做的事：印出目前部署（舊版本號，出事時退回用）→ clasp push → clasp version → clasp redeploy 原本的部署 ID。
# 部署 ID 讀 tools/stores.json 的 api 網址；絕不用 clasp deploy（會產生沒人連的新網址）。
# 退回：cd ~/mala-gas/<資料夾> && clasp redeploy <部署ID> -V <舊版本號>
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAS="${GAS_ROOT:-$HOME/mala-gas}"
MSG="${MSG:-部署 $(date +%F)}"

ids() {   # 每行：資料夾 部署ID 店名
  python3 - "$ROOT/tools/stores.json" <<'EOF'
import json, sys
for s in json.load(open(sys.argv[1], encoding='utf-8')):
    print(s['gas_dir'], s['api'].split('/s/')[1].split('/')[0], s['name'].replace(' ', ''))
EOF
}
id_of() { ids | awk -v d="$1" '$1 == d { print $2 }'; }

check() {
  local bad=0
  while read -r dir id name; do
    out=$(curl -sL -d '{"action":"whoami","key":"test-not-a-real-key"}' "https://script.google.com/macros/s/$id/exec" | head -c 120)
    if [ "$out" = '{"ok":false,"error":"invalid_key"}' ]; then echo "✓ $name（$dir）"; else echo "✗ $name（$dir）：$out"; bad=1; fi
  done < <(ids)
  [ $bad = 0 ] && echo "✅ 每家後台都有回應" || echo "❌ 有店沒正常回應：用那家記下的舊版本號 clasp redeploy 退回"
  return $bad
}

one() {
  local dir="$1" id
  id="$(id_of "$dir")"
  [ -n "$id" ] || { echo "❌ tools/stores.json 沒有 $dir"; return 1; }
  [ -d "$GAS/$dir" ] || { echo "❌ 找不到 $GAS/$dir"; return 1; }
  cd "$GAS/$dir" || return 1
  echo "===== $dir 目前的部署（記下 ${id:0:16}… 這行的版本號，出事時退回用）"
  clasp list-deployments | grep -E "$id|HEAD"
  clasp push || { echo "❌ $dir：push 失敗，停"; return 1; }
  local vout v
  vout="$(clasp version "$MSG")" || { echo "❌ $dir：clasp version 失敗，停"; return 1; }
  echo "$vout"
  v="$(printf '%s' "$vout" | grep -oE '[0-9]+' | tail -1)"
  [ -n "$v" ] || { echo "❌ $dir：抓不到新版本號，停"; return 1; }
  echo "===== $dir 新版本 $v（請對一下上面 clasp version 印的號碼一樣），切換部署"
  clasp redeploy "$id" -V "$v" || { echo "❌ $dir：redeploy 失敗，停"; return 1; }
}

[ $# -gt 0 ] || { sed -n '2,16p' "$0"; exit 2; }
case "$1" in
  --check) check; exit $? ;;
  --others) set -- $(ids | awk '$1 != "mala-clock-in" { print $1 }') ;;
esac
for d in "$@"; do one "$d" || exit 1; done
echo "✅ 部署完成：$*"
echo "   等 30 秒後跑：$ROOT/tools/redeploy-store.sh --check"
