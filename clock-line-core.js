/* LINE 打卡頁的挑店規則（2026-10-08，規格 mala-clock-liff/docs/spec.md §3）。
 * 瀏覽器載入後掛在 window.ClockLineCore；node 測試用 require。
 * 有效距離公式必須與各店後端 handleClock 相同：max(0, 距離 − min(誤差, 100))，沒回報誤差＝折抵 0。
 * 兩家以上同時符合＝定位不夠準、分不出來 → 一律擋（ambiguous），不取最近、不猜。 */
(function (root) {
  var ACCURACY_CREDIT_CAP_M = 100;   // 與各店後端 CONFIG 同值；改這裡要一起改後端
  var R = 6371000;

  function distanceM(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function effectiveDistance(d, accuracy) {
    var acc = (typeof accuracy === 'number' && isFinite(accuracy) && accuracy > 0) ? accuracy : 0;
    return Math.max(0, d - Math.min(acc, ACCURACY_CREDIT_CAP_M));
  }

  function pickStore(fix, stores) {
    if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number' ||
        !isFinite(fix.lat) || !isFinite(fix.lng)) return { status: 'no_fix' };
    var hits = [], nearest = null, nearestD = Infinity;
    (stores || []).forEach(function (s) {
      var d = distanceM(fix.lat, fix.lng, s.lat, s.lng);
      if (d < nearestD) { nearestD = d; nearest = s; }
      if (effectiveDistance(d, fix.accuracy_m) <= s.radius_m) hits.push({ store: s, d: d });
    });
    if (hits.length === 1) return { status: 'ok', store: hits[0].store, distance_m: Math.round(hits[0].d * 10) / 10 };
    if (hits.length > 1) return { status: 'ambiguous', candidates: hits.map(function (h) { return h.store.code; }) };
    return { status: 'none', nearest: nearest, distance_m: nearest ? Math.round(nearestD) : null };
  }

  var api = { pickStore: pickStore, distanceM: distanceM, effectiveDistance: effectiveDistance,
              ACCURACY_CREDIT_CAP_M: ACCURACY_CREDIT_CAP_M };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClockLineCore = api;
})(this);
