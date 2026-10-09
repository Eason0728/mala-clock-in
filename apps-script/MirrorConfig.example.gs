/**
 * 跨店打卡鏡像設定（範本）。只放在「總部」的 GAS 專案。
 * 正式檔叫 MirrorConfig.js，放在部署目錄 ~/mala-gas/hq-clock-in/，**不進公開 repo**（含試算表 ID）。
 *
 * code       來源代碼，會寫進目標表的 mirror_src 欄（如 'CF'）。不可重複。
 * ss_id      來源（央廚）打卡試算表 ID。真值＝薪酬門市表 CF 那列的 clock_ss_id（目前總部列指向的也是它）。
 * emp_prefix 來源名冊中「屬於總部」的工號前綴（央廚名冊裡總部的人是 'HQ-'）。**不可為空**（空＝整間店都抄進來）。
 */
var MIRROR_SOURCES = [
  { code: 'CF', ss_id: 'PASTE_央廚打卡試算表ID', emp_prefix: 'HQ-' },
];
