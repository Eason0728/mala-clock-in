/**
 * LINE 單一打卡入口：各店設定（範本）。
 * 正式檔叫 LineHubConfig.js，只放在部署目錄 ~/mala-gas/mala-clock-in，**不進公開 repo**（含試算表 ID）。
 * code 與 tools/stores.json 相同；光復 code 為空字串、ss_id 留空（用本機試算表）。
 * api＝各店打卡後端網址（與 clock.html 的 STORE_APIS 相同）；ss_id＝各店打卡試算表 ID。
 * lat／lng／radius_m 必填、與 tools/stores.json 相同（沒有座標的店 lineHubPickStore_ 會跳過，等於永遠挑不到）。
 * ⚠ 正式檔由 ~/mala-clock-liff/deploy/patch_line_hub.py 從 tools/stores.json 產生，不要照本範本手填；
 *   與 stores.json 是否一致用 tools/verify-store-backends.py 檢查（打卡畫面也用 stores.json 挑店，兩邊不一致會綁錯店）。
 */
var LINE_HUB_STORES_CONFIG = [
  { code: '',      name: '小辛辣 新竹光復', ss_id: '',                        api: 'PASTE_光復後端網址',       lat: 0, lng: 0, radius_m: 20 },
  { code: 'mztjs', name: '墨竹亭 新竹金山', ss_id: 'PASTE_金山打卡試算表ID', api: 'PASTE_金山後端網址',       lat: 0, lng: 0, radius_m: 50 },
  { code: 'mztgf', name: '墨竹亭 新竹光復', ss_id: 'PASTE_墨竹亭光復試算表ID', api: 'PASTE_墨竹亭光復後端網址', lat: 0, lng: 0, radius_m: 50 },
  { code: 'mztlzl', name: '墨竹亭 台北六張犁', ss_id: 'PASTE_墨竹亭六張犁試算表ID', api: 'PASTE_墨竹亭六張犁後端網址', lat: 0, lng: 0, radius_m: 50 },
  { code: 'hq',    name: '鼎兆元 總部',     ss_id: 'PASTE_總部試算表ID',     api: 'PASTE_總部後端網址',       lat: 0, lng: 0, radius_m: 50 },
  { code: 'cf',    name: '鼎兆元 中央廚房', ss_id: 'PASTE_央廚試算表ID',     api: 'PASTE_央廚後端網址',       lat: 0, lng: 0, radius_m: 50 },
];
