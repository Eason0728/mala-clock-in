// 核定時段照「打卡＋單」算（2026-11-14 Eason 定案「打卡＋單＝核定時數」，docs/punch-plus-req/）。純函式，不碰畫面，伺服器測試直接載入。
// 原則（Eason 確認的 12 個例子）：
//   1. 打卡（含已核准忘打卡單補的卡）＋已核准的單，就是核定時數；班表只拿來交叉比對與設上限。
//   2. 時段取「打卡」和「班表＋已核准加班單」的交集；班表以外的打卡（早到、晚走、班表空檔來上班）照打卡算，
//      當天加起來超過 8 小時的部分才要加班單、沒單不算（2026-11-16 Eason：「只要當天出勤滿八小時以上才需要加班單，不是依照班表的時間」，取代 11/14 的「比班表多 30 分鐘就要加班單」）。
//   3. 遲到：開頭留班表（打卡端照標遲到 N 分、薪資照扣）；早退、中途離開照打卡算（正職不足 8 小時要假單，由打卡端檢查）。
//      2026-11-20 Eason：二段班中途離開又回來比照遲到（核定蓋過空檔、空檔記遲到），開關 GAP_LATE_FROM（上線日，跟打卡端同一天），見 corePeriods 1b、1c。
//   4. 忘打卡單補的時間超出班表的部分不算；加班單要有打卡涵蓋（打卡端檢查）。
//   5. 打卡跟班表（或加班單）邊界差 15 分鐘內算對得上；其他只往少的方向取整到 15 分（上班往後、下班往前）。
//      2026-11-21 Eason 選 A'：上班卡只跟「開始類」邊界對、下班卡只跟「結束類」邊界對，取最近的（見 snapIn／snapOut）。
// 沒班表也沒加班單（例：排休卻來上班）：照打卡算，讓打卡端回「要有加班單」。沒打卡又有班表：照班表，讓打卡端回「要有忘打卡單」。

const TOL = 15;
/** 超過當天 8 小時、又沒有加班單的打卡合計達這麼多分鐘：不給一鍵核定，要補加班單或主管「自己調」確認（2026-11-14 Eason 選 B；2026-11-16 起只算超過 8 小時的部分） */
export const OVER_BLOCK_MIN = 30;
/** 一天不用加班單的上限（分鐘）：班表內＋班表外加起來到這裡為止都照打卡算 */
export const DAY_FREE_MIN = 480;
/** 每張卡跟核定時間差（2026-11-16 Eason：「每一次打卡時間跟核定時間相差超過 30 分鐘以上，都需要填寫原因」；剛好 30 分不用）。
 *  跟打卡端 Requests.gs reqCardDiffs_ 同一套：一段打卡對到重疊的核定時段，上班卡比最早那段的開始、下班卡比最晚那段的結束；
 *  整段沒被核定就比最近的開始／結束；只有單邊的卡只比有的那邊。CARD_REASON_FROM 起的日子才要（打卡端 REQ_CARD_REASON_FROM）。 */
export const CARD_DIFF_MIN = 30;
export const CARD_REASON_FROM = '2026-11-01';      // 2026-11-18 Eason「卡差 30 分起算日維持 11/1」（原本 11/17；同打卡端 REQ_CARD_REASON_FROM_DEFAULT_）
/** 二段班中途離開又回來比照遲到（2026-11-20 Eason 第 11 題 B、第 1～4 題，見 corePeriods 1b、1c）。
 *  GAP_LATE_FROM＝上線日（YYYY-MM-DD）；null＝關（跟改之前完全一樣）。只有這天（plan.date，伺服器 attachPlan 只在個人登入時帶；門市登入不帶＝照舊，因為打卡端只收個人帳號的班表）在上線日以後才套；
 *  不知道日期＝不套（照舊）。**要跟打卡端 Requests.gs 的 REQ_GAP_LATE_FROM_DEFAULT_ 設成同一天**：上線日之前的日子補核定，兩邊都照舊。
 *  GAP_LATE_SCOPE：'multi'＝只有當天班表兩段以上（Eason 第 1 題 A）；'all'＝單段班也算（沒採用，留著對照打卡端 REQ_GAP_LATE_SCOPE）。 */
export const GAP_LATE_FROM = null;        // 2026-11-21 延後生效（Codex 交叉驗證 4 個已重現問題）：關（原本 '2026-11-22'）。打卡端同時改成沒設屬性＝關，兩邊要一起開
/** 上午整段沒到改算遲到（2026-11-26 主管「央廚這類『休息前整段沒到』改判遲到。都照推薦」；設計 _brain_out/late-first-block/design.md）。
 *  LATE_LEAD_FROM＝生效日（寫死、沒有開關；**要跟打卡端 Requests.gs REQ_LATE_LEAD_FROM_ 同一天**）。用在三處：
 *   ① 班表寫兩段、中間空檔整個在不打卡休息帶裡（央廚 08–12／13–17），前一段整段沒打卡、第一張卡是休息帶當中或之後的上班卡 → 兩段當一段班算遲到（第 1 題 A，見 mergeLeadSL）。
 *      只有知道這天日期（o.date 或 o.plan.date，同 GAP_LATE_FROM）而且在生效日以後才套；不知道日期＝照舊（只預填後面那段，打卡端照樣收）。
 *   ② 核定卡片那一句灰字（lateLeadNote）。
 *   ③ 遲到分鐘不把不打卡休息帶算進去（步驟 3；287 → 240）、班表比對「晚到」與一頁核定橘色標籤（compare.js lateMinusBrk）同一條。
 *  三條都只在知道日期、而且在生效日以後才套；生效日前、拿不到日期（門市登入、背景先檢查）＝跟主線逐字相同（2026-11-26 驗收第 1 項）。
 *  生效日的正本值也寫在共用案例檔 test/fixtures/late-lead-cases-v1.json 的 effective_from，兩邊測試釘住。
 *  測試用：o.lateLeadFrom 覆寫生效日（null＝關）、o.lateBrkOff＝true 遲到照改之前（含休息帶）——只給拿舊凍結副本比對的測試用，畫面、伺服器都不會帶。 */
export const LATE_LEAD_FROM = '2026-11-01';      // 2026-11-26 主管改：原定 2026-12-01，改成 11/1 起（「上午整段沒到要算遲到，要從11/1開始」）
function lateLeadOn(o) {
  const from = o.lateLeadFrom !== undefined ? o.lateLeadFrom : LATE_LEAD_FROM;
  const d = String(o.date || (o.plan && o.plan.date) || '');
  return !!from && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from;
}
/** ① 班表兩段當一段（見 LATE_LEAD_FROM）：SL＝遲到用的班表段（分鐘）；fc＝當天第一張真的卡 {t, isIn}；Wraw＝打卡（含忘打卡單補的卡）。
 *  前一段有任何打卡（含忘打卡單補的）＝不適用（打卡端照忘打卡單）。只併一組、回新的陣列；不適用回原陣列 */
function mergeLeadSL(SL, BRKs, fc, Wraw) {
  if (!fc || !fc.isIn || SL.length < 2 || !BRKs.length) return SL;
  for (let k = 0; k + 1 < SL.length; k++) {
    const a = SL[k], b = SL[k + 1];
    if (!(a[1] < b[0] && BRKs.some((x) => a[1] >= x[0] && b[0] <= x[1]))) continue;
    if (!(fc.t >= a[1] && fc.t < b[1])) continue;
    if (Wraw.some((w) => Math.min(w[1], a[1]) > Math.max(w[0], a[0]))) continue;
    const m = [a[0], b[1]]; m.moved = a.moved; m.parts = [a, b];
    return SL.slice(0, k).concat([m], SL.slice(k + 2));
  }
  return SL;
}
/** 打卡端會不會套新規則（2026-11-26 第四輪、Codex 第二輪擋項 1、2 的根因）：逐項照抄打卡端的判斷——
 *   Requests.gs reqLateLeadOn_（生效日 reqLateLeadDay_、休息帶設定 lateLeadBreakOk_、Code.gs lateLeadOf_、前導段已核准忘打卡單 reqLeadMissForm_）
 *   ＋Code.gs handleMgrApprove 的「出差（核定登記的假別有出差）不套」。輸入跟打卡端一樣：這次要送的核定時段、真的打卡段（不含忘打卡單補的）、已核准申請、休息帶、日期。
 *   打卡端另外還看「打卡未入帳（待核准裝置的卡）」：營運系統拿不到，見 progress.md 第四輪輸入對照表。
 *   periods＝[{start,end}]；segs＝[{in,out,cross}]；reqs＝已核准申請（pending:true 的不算）；回 { ps, lead, fc, bs, be } 或 null（不套） */
export function lateLeadClock(periods, segs, brk, reqs, date, from) {
  const f = from !== undefined ? from : LATE_LEAD_FROM;
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || String(date) < f) return null;           // reqLateLeadDay_
  const bs = toMin(brk && brk.start), be = toMin(brk && brk.end);
  if (bs == null || be == null || be <= bs) return null;                                                 // lateLeadBreakOk_
  const ps = (periods || []).map((p) => span(toMin(p.start), toMin(p.end))).filter(Boolean).sort((x, y) => x[0] - y[0]);
  if (ps.length < 2) return null;
  let fc = null;      // 當天第一張卡（真的卡）；同一分鐘有下班卡＝當成下班卡
  for (const x of segs || []) {
    if (!x) continue;
    const i = toMin(x.in), o = toMin(x.out), isIn = i != null, t = isIn ? i : (o == null ? null : o + (x.cross ? 1440 : 0));
    if (t == null) continue;
    if (fc === null || t < fc.t) fc = { t, isIn }; else if (t === fc.t && !isIn) fc.isIn = false;
  }
  if (!fc || !fc.isIn) return null;
  let n = 0;
  while (n < ps.length && ps[n][1] <= fc.t) n++;
  if (n === 0 || n === ps.length) return null;
  const last = ps[n - 1], next = ps[n];
  if (!(last[1] < next[0] && last[1] >= bs && next[0] <= be) || !(fc.t < next[1])) return null;
  const lead = ps.slice(0, n);
  const ok = (reqs || []).filter((r) => r && r.pending !== true);
  if (ok.some((r) => r.kind === 'trip')) return null;                                                   // 出差：handleMgrApprove hasTrip
  const miss = ok.some((r) => {                                                                          // reqLeadMissForm_
    if (r.kind !== 'miss') return false;
    const a = toMin(r.start), b = toMin(r.end), ts = [a, b].filter((x) => x != null);
    return lead.some((p) => ts.some((t) => t >= p[0] && t <= p[1]) || (r.miss_type === 'both' && a != null && b != null && (() => { const sp = span(a, b); return sp[0] < p[1] && sp[1] > p[0]; })()));
  });
  if (miss) return null;
  return { ps, lead, fc, bs, be };
}
/** ② 核定卡片灰字（第 10 題逐句表第 1 句）。periods＝這次要送的核定時段 [{start,end}]；segs＝打卡段；brk＝不打卡休息帶；reqs＝已核准申請；date＝核定的日子。
 *  條件＝lateLeadClock（跟打卡端同一套）；不適用回 ''。
 *  「{08:00–12:00} 整段沒有打卡、{12:47} 才到：算遲到 {240} 分（休息 {12:00–13:00} 不算），薪資照扣。」——分鐘＝核定時段裡、第一張上班卡之前的分鐘數 */
export function lateLeadNote(periods, segs, brk, reqs, date, from) {
  const c = lateLeadClock(periods, segs, brk, reqs, date, from);
  if (!c || !clockKeep(c, periods, segs, reqs, brk, date)) return '';      // 第六輪：打卡端因不變式照主線的那份也不寫（同 corePeriods）；第九輪：還沒下班也不寫（clockOpen，不看現在時間）
  const min = total(intersect(c.ps, [[0, c.fc.t]]));
  return c.lead.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + ' 整段沒有打卡、' + toHm(c.fc.t) + ' 才到：算遲到 ' + min + ' 分（休息 ' + toHm(c.bs) + '–' + toHm(c.be) + ' 不算），薪資照扣。';
}
export const GAP_LATE_SCOPE = 'multi';
/** 這一天套哪個範圍：o.gapLate（測試直接指定 'off'｜'multi'｜'all'，不看日期）優先；否則看上線日（o.gapFrom 可覆寫）與這天日期（o.date 或 o.plan.date） */
function gapScopeOf(o) {
  if (o.gapLate !== undefined) return o.gapLate;
  const from = o.gapFrom !== undefined ? o.gapFrom : GAP_LATE_FROM;
  const d = String(o.date || (o.plan && o.plan.date) || '');
  return from && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from ? GAP_LATE_SCOPE : 'off';
}
// 2026-11-18 Eason 拿掉「遲到超過 30 分要選原因」（同打卡端 reqCardDiffs_）：上班卡晚於對到的核定開始＝記成遲到、下班卡早於對到的核定結束＝記成早退，不算卡差；
// lateGiven＝主管填的遲到分鐘（沒填 null）：只有他認的分鐘算已涵蓋。仍要原因：早到很多、晚走很多、整段沒被核定。
export function cardDiffs(segs, periods, lateGiven) {
  const ps0 = (periods || []).map((p) => span(toMin(p.start), toMin(p.end))).filter(Boolean);
  if (!ps0.length) return [];
  // 核定時段只有時鐘時間：跨夜的核定被拆成兩段（22:00–01:00、01:30–06:00）時，午夜後那段其實是隔天 → 多放一份「加一天」的再比（2026-11-17；原本誤報下班卡差 300 分）
  const ps = ps0.concat(ps0.filter((p) => p[1] <= 1440).map((p) => [p[0] + 1440, p[1] + 1440]));
  const near = (t, i) => ps.reduce((a, p) => (a == null || Math.abs(p[i] - t) < Math.abs(a - t) ? p[i] : a), null);
  const out = [];
  let lateLeft = lateGiven == null || lateGiven === '' ? null : Math.max(0, Number(lateGiven) || 0);
  for (const g of segs || []) {
    if (!g) continue;
    let a = toMin(g.in), b = toMin(g.out);
    if (a != null && b != null && (g.cross || b < a)) b += 1440;
    let st = null, en = null;
    if (a != null && b != null) {
      const ov = ps.filter((p) => Math.min(b, p[1]) > Math.max(a, p[0]));
      if (ov.length) { st = Math.min(...ov.map((p) => p[0])); en = Math.max(...ov.map((p) => p[1])); }
    }
    if (a != null) {
      const c = st != null ? st : near(a, 0), d = Math.abs(a - c);
      let left = d;
      if (st != null && a > c) { const cov = lateLeft == null ? d : Math.min(d, lateLeft); if (lateLeft != null) lateLeft -= cov; left = d - cov; }
      if (left > CARD_DIFF_MIN) out.push({ side: 'in', card: toHm(a), core: toHm(c), min: d });
    }
    if (b != null) { const c = en != null ? en : near(b, 1), d = Math.abs(b - c); if (!(en != null && b < c) && d > CARD_DIFF_MIN) out.push({ side: 'out', card: toHm(b), core: toHm(c), min: d }); }
  }
  return out;
}
/** 「上班卡 08:20（核定 09:00，早 40 分）」 */
export function cardLabel(c) {
  // 兩個時鐘時間的差取最近的那個方向（[-720, 720)）：下班卡 00:10、核定 23:30＝晚 40 分，不是早（2026-11-17）
  const early = ((toMin(c.card) - toMin(c.core) + 720) % 1440 + 1440) % 1440 - 720 < 0;
  return (c.side === 'in' ? '上班卡 ' : '下班卡 ') + c.card + '（核定 ' + c.core + '，' + (early ? '早 ' : '晚 ') + c.min + ' 分）';
}
/** 每張卡的原因合成一句存進 diff_reason：「上班卡 08:20：臨時調班；下班卡 17:45：主管同意」 */
export const cardReasonText = (cards, picks) => cards.map((c, i) => (c.side === 'in' ? '上班卡 ' : '下班卡 ') + c.card + '：' + picks[i]).join('；');
/** 建議補的加班單時段（2026-11-16 Eason：15 分鐘內不計、以整數建議）：每段開始往後、結束往前取到 15 分，取完不到 15 分的整段不列。
 *  例 08:57–09:00、13:00–14:34、16:57–18:00、22:00–22:03 → 13:00–14:30、17:00–18:00（2.5 小時）。全部都不到 15 分時回原本的時段（照實寫，不讓建議變空白） */
export function otSuggest(over) {
  const out = [];
  for (const x of over || []) {
    const sp = span(toMin(x.start), toMin(x.end)); if (!sp) continue;
    const a = Math.ceil(sp[0] / TOL) * TOL, b = Math.floor(sp[1] / TOL) * TOL;
    if (b - a >= TOL) out.push({ start: toHm(a), end: toHm(b), min: b - a });
  }
  if (!out.length) return { list: (over || []).map((x) => ({ start: x.start, end: x.end })), text: (over || []).map((x) => x.start + '–' + x.end).join('、'), min: null, rounded: false };
  const min = out.reduce((t, x) => t + x.min, 0);
  return { list: out, text: out.map((x) => x.start + '–' + x.end).join('、'), min, rounded: true };
}
/** 「要補加班單 13:00–14:30、17:00–18:00（共 2.5 小時）」；取不到整數時段時照實寫分鐘 */
export function otSuggestText(over, overMin) {
  const g = otSuggest(over);
  return g.text + (g.rounded ? '（共 ' + Math.round(g.min / 60 * 100) / 100 + ' 小時）' : '（' + overMin + ' 分鐘）');
}
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHm = (n) => { const x = ((n % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const span = (a, b) => (a == null || b == null ? null : (b <= a ? [a, b + 1440] : [a, b]));
const merge = (list) => {
  const s = list.filter((x) => x && x[1] > x[0]).sort((a, b) => a[0] - b[0]), out = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
};
const intersect = (A, B) => { const out = []; for (const a of A) for (const b of B) { const s = Math.max(a[0], b[0]), e = Math.min(a[1], b[1]); if (e > s) out.push([s, e]); } return merge(out); };
const minus = (A, B) => {
  let cur = merge(A);
  for (const b of merge(B)) {
    const next = [];
    for (const a of cur) { if (b[1] <= a[0] || b[0] >= a[1]) next.push(a); else { if (b[0] > a[0]) next.push([a[0], b[0]]); if (b[1] < a[1]) next.push([b[1], a[1]]); } }
    cur = next;
  }
  return cur;
};
const total = (list) => list.reduce((a, x) => a + x[1] - x[0], 0);

/** 邊界對齊（2026-11-21 Eason 選 A'，mala-store-ops #335 舊問題 2）：上班卡只對齊「開始類」邊界（班表開始、加班單開始、休息帶結束、假單結束），
 *  下班卡只對齊「結束類」邊界（班表結束、加班單結束、休息帶開始、假單開始），差 15 分內取最近的那個。
 *  優先順序照改之前：先看班表，班表對不到才看加班單，再來休息帶、假單（同一類裡取最近）。不讓休息帶搶過自己的班表：
 *    例 班表 13:15–19:15、休息帶 12–13，13:06 上班卡 → 對 13:15（班表開始），不對比較近的 13:00（休息帶結束）——
 *    對到 13:00 會把 13:00–13:15 算成「班表外多做」，違反 2026-11-16 Eason「上班前 15 分鐘打卡不算」。
 *  都對不到：上班往後、下班往前取整到 15 分（同改之前）。
 *  改之前是不分上下班、取清單裡「第一個」差 15 分內的邊界：兩段班中間只隔幾分鐘（09–11、11:10–15）時，11:10 上班卡被對到 11:00（前一段的結束），兩段被接成一段。
 *  bounds＝{ st: [開始類，依優先順序分組], en: [結束類，同] }（corePeriods 裡組） */
const nearBound = (t, groups) => {
  for (const list of groups) { let best = null; for (const x of list) { const d = Math.abs(x - t); if (d <= TOL && (best == null || d < Math.abs(best - t))) best = x; } if (best != null) return best; }
  return null;
};
// 2026-11-21 碎段修正（複審第 8 項）：bounds.pin＝上一輪找到的「這張卡改對到這個邊界」（見 corePeriods 外層）；bounds.fb＝這一輪哪些卡是靠取整（沒對到邊界）、取整到哪
const noteFb = (bounds, side, t, g) => { if (!bounds.fb) return g; const m = bounds.fb[side]; if (!m.has(g)) m.set(g, new Set()); m.get(g).add(t); return g; };
function snapIn(t, bounds) {
  if (bounds.pin && bounds.pin.has('i' + t)) return bounds.pin.get('i' + t);
  const b = nearBound(t, bounds.st); return b != null ? b : noteFb(bounds, 'i', t, Math.ceil(t / 15) * 15);
}
function snapOut(t, bounds) {
  if (bounds.pin && bounds.pin.has('o' + t)) return bounds.pin.get('o' + t);
  const b = nearBound(t, bounds.en); return b != null ? b : noteFb(bounds, 'o', t, Math.floor(t / 15) * 15);
}

/**
 * @param {object} o
 *   segs：打卡段 [{in, out, cross}]（mgr_day 的 segments；缺卡＝null）
 *   plan：班表（mgr_day 的 plan：{work, segs:[{start,end}]}）；null／work:false＝沒班或排休
 *   reqs：那天已核准的申請 [{kind:'ot'|'miss'|'leave'|'trip', start, end, miss_type}]
 *   brk：不打卡休息帶 {start, end}（沒有就空字串）
 * @returns {null | {periods:[{start,end}], hours, notes:[string], late:number, over:[{start,end}], overMin:number}}（over＝打卡在班表＋加班單以外的時段）
 */
/** 新規則預填的總閘（2026-11-26 第五輪，驗收員加驗：休息帶內有打卡＋當天有單據的少見組合，前端算的跟打卡端仍會不一致）。
 *  純函式，只看輸入（打卡段、已核准申請、休息帶）。回 false＝這天照主線預填（照主線永遠不比主線糟；遲到幾分仍由打卡端決定，卡片照打卡端的算法顯示）。
 *  每一條的理由見下；閘開多寬由 mala-clock-in tests/late-lead-xcheck.test.js（5 個種子 × 1.5 萬組＋格點）以「(a)(b)(c) 全部 0」決定。 */
export function lateLeadShapeOk(segs, reqs, brk) {
  const bs = toMin(brk && brk.start), be = toMin(brk && brk.end);
  if (bs == null || be == null || be <= bs) return true;                       // 沒有休息帶：新規則本來就不會套，閘不用管
  const docs = (reqs || []).filter((r) => r && r.pending !== true && (r.kind === 'leave' || r.kind === 'trip' || r.kind === 'miss'));
  // ①（第五輪「休息帶裡有打卡又有單據＝照主線」）2026-11-26 第六輪拿掉：改成照抄打卡端的不變式判斷（clockKeep／clockKeepStrict，見 corePeriods），
  //   10 種子 × 1.5 萬組＋格點的對照拿掉後 (a)–(e) 仍全 0，新規則預填的日子多回來（亂數裡閘擋回主線的從約 9% 降到約 1%，只剩 ②）
  // ② 請假／出差單的時數換成分鐘不是整數（例 16:10–18:00 填 1.83 小時＝109.8 分）：前端「上班＋假滿 8 小時就不再多算」那段用時數算，
  //    新規則把上午補滿後常剛好碰到上限，會切出不到 1 分鐘的時段（18:45–18:45.2），打卡端回「時段格式不對」。主線遇到同樣情形也會這樣（既有），
  //    但新規則碰到的機會多很多，所以這種日子照主線（第五輪亂數對照 s20261127:1920、s33:14460）
  if (docs.some((r) => (r.kind === 'leave' || r.kind === 'trip') && r.hours != null && r.hours !== '' && Math.abs(Number(r.hours) * 60 - Math.round(Number(r.hours) * 60)) > 1e-6)) return false;
  return true;
}
export function corePeriods(o) {
  // 2026-11-26 第四輪（Codex 第二輪擋項 1、2 的根因）：「這天套不套新規則」以打卡端為準——算完預填後拿這組時段問 lateLeadClock（跟打卡端同一套條件）；
  //   打卡端不會套（例：上午有已核准的單張忘打卡單、出差、預填出來的時段沒有前導段）→ 整個照主線重算（lateLeadFrom: null＝跟改之前逐字相同）。
  // 2026-11-26 第五輪：再加總閘 lateLeadShapeOk（沒把握的形狀一律照主線）；不論新規則預填或照主線預填，只要這份預填送出去打卡端會套新規則，
  //   卡片顯示的遲到一律改成打卡端的算法（照主線預填時打卡端仍可能套，例 07–16 班、只打 12:42–13:13＋下午事假＝打卡端 300）。
  if (!lateLeadOn(o)) return corePeriodsRaw(o);
  const segs = Array.isArray(o.segs) ? o.segs : [], reqs = Array.isArray(o.reqs) ? o.reqs : [];
  // 2026-11-26 第七輪：總閘沒過就不跑新規則那條算法（例 0.98 小時假單，新規則那條會切出碎段、甚至丟例外）；新規則那條丟例外一律照主線（主線丟就照主線丟＝跟改之前一樣）
  const gateOk = o.lateLeadGate === false || lateLeadShapeOk(segs, reqs, o.brk);
  let r = null;
  if (gateOk) { try { r = corePeriodsRaw(o); } catch (e) { r = null; } }
  const date = String(o.date || (o.plan && o.plan.date) || '');
  const clock = (x) => (x && Array.isArray(x.periods) && x.periods.length ? lateLeadClock(x.periods, segs, o.brk, reqs, date, o.lateLeadFrom) : null);
  // 2026-11-26 第六輪（不變式；主管選維持範圍）：打卡端套不套＝lateLeadClock 成立、而且 clockKeep（照抄 Requests.gs reqLateLeadKeep_：
  //   新規則讓缺卡／核定比打卡多判不過、主線判得過＝這份照主線）。第四輪「休息帶裡打一段、休息後晚回來 ≥30 分」那條是這裡的一個特例，併進來
  // 2026-11-27 第九輪：「還沒下班」（clockOpen）不看現在時間，前端不再收 o.now（第七輪加的、第八輪縮小的都拿掉）
  const sends = (x) => { const k = clock(x); return k && clockKeep(k, x.periods, segs, reqs, o.brk, date) ? k : null; };
  // 新規則的預填只在「打卡端照新規則判得過那兩條」時才用（clockKeep 的 strict 版）；判不過就改給主線的預填——主線預填是不同的時段，常常核得了
  //   （第四輪變體 6：休息帶裡打一段、休息後晚回來 ≥30 分；第六輪對照又找到同類 16 組）
  const sendsNew = (x) => { const k = clock(x); return k && clockKeepStrict(k, x.periods, segs, reqs, o.brk, date) ? k : null; };
  let out = r, c = sendsNew(r);
  if (!gateOk || !c) out = null;      // o.lateLeadGate＝false：只給量測閘擋掉多少的測試用；總閘沒過、新版算不出時段或丟例外、打卡端不會套 → 照主線
  if (!out) { out = corePeriodsRaw(Object.assign({}, o, { lateLeadFrom: null })); c = sends(out); }
  if (!c) return out;
  // 卡片顯示的遲到＝這份預填送出去時打卡端狀態的遲到：前導段合計（核定時段裡、第一張卡之前）＋其餘段照打卡端 computeApprovalStatus 的比法
  const late = total(c.lead) + clockRestLate(c.ps.slice(c.lead.length), segs);
  if (late === out.late) return out;
  const fixed = Object.assign({}, out, { late });
  const at = out.notes.findIndex((x) => /^遲到 \d+ 分（薪資照扣）$/.test(x));
  fixed.notes = out.notes.filter((x, i) => i !== at);
  if (late > 0) fixed.notes.splice(at >= 0 ? at : 0, 0, '遲到 ' + late + ' 分（薪資照扣）');
  return fixed;
}
/* ── 打卡端「新規則會不會讓這份送出核定不了」的照抄（2026-11-26 第六輪，Requests.gs reqLateLeadCoreOk_／reqLateLeadKeep_）──
 * 打卡端只在綁單兩條（缺卡張數 reqBindMissCards_、核定比打卡多 reqOverCreditMin_）新規則判不過、主線判得過時，這份送出照主線。下面逐支照抄（分鐘為單位）：
 *   breakBlocksFor_／loneCardsForPeriods_（Code.gs）、reqBindMissCards_、reqSegsWithMiss_、reqOverCreditMin_、reqOverSegsKnown_、reqLeaveBackMs_／reqLeaveStartMs_（Requests.gs）。
 * 營運系統拿不到、照預設的：綁單／加嚴起算日（打卡端指令碼屬性 REQ_BIND_FROM／REQ_STRICT_FROM，預設都是 2026-11-01）、還在上班那張卡（working）、
 *   中途離開比照遲到（兩邊都關）、主管還沒填的遲到欄（預填當下一律空白）。見 progress.md 第六輪。 */
const CLOCK_BIND_FROM = '2026-11-01', CLOCK_STRICT_FROM = '2026-11-01', CLOCK_STRICT_DIFF_MIN = 30, CLOCK_NEAR = 240;
const gapByBrk = (a, b, bw) => !!bw && a < bw[1] && b > bw[0];      // Code.gs gapExplainedByBreak
function clockLone(ps, full, cards) {                                     // Code.gs loneCardsForPeriods_（ps：[{s,e}]）
  const open = ps.map((p, i) => i).filter((i) => !full.some((f) => Math.min(ps[i].e, f.out) - Math.max(ps[i].s, f.in) > 0));
  if (!open.length || !cards.length || cards.length > 8) return {};
  let best = {}, bestN = 0, bestD = Infinity;
  const dist = (c, i) => { const d = c.in != null ? Math.abs(c.in - ps[i].s) : Math.abs(c.out - ps[i].e); return d <= CLOCK_NEAR ? d : null; };
  const walk = (ci, pick, n, tot) => {
    if (ci === cards.length) { if (n > bestN || (n === bestN && n > 0 && tot < bestD)) { bestN = n; bestD = tot; best = Object.assign({}, pick); } return; }
    walk(ci + 1, pick, n, tot);
    for (const i of open) { if (pick[i]) continue; const d = dist(cards[ci], i); if (d === null) continue; pick[i] = cards[ci]; walk(ci + 1, pick, n + 1, tot + d); delete pick[i]; }
  };
  walk(0, {}, 0, 0);
  return best;
}
function clockBlocks(ps, segs, bw) {                                      // Code.gs breakBlocksFor_
  const sorted = ps.slice().sort((a, b) => a.s - b.s);
  if (!bw) return sorted;
  const merged = [];
  sorted.forEach((p, k) => { const l = merged[merged.length - 1]; if (l && p.s > l.e && gapByBrk(l.e, p.s, bw)) { l.e = Math.max(l.e, p.e); l.last = k; } else merged.push({ s: p.s, e: p.e, first: k, last: k }); });
  if (merged.length === sorted.length) return sorted;
  const full = segs.filter((x) => x.in != null && x.out != null), cards = segs.filter((x) => (x.in == null) !== (x.out == null));
  const hasFull = (b) => full.some((f) => Math.min(b.e, f.out) - Math.max(b.s, f.in) > 0);
  const blocks = [];
  merged.forEach((b) => { const parts = sorted.slice(b.first, b.last + 1); if (parts.length > 1 && parts.some(hasFull)) parts.forEach((x) => blocks.push(x)); else blocks.push({ s: b.s, e: b.e }); });
  if (blocks.length === sorted.length) return sorted;
  const used = (bs) => Object.keys(clockLone(bs, full, cards)).length;
  return used(sorted) > used(blocks) ? sorted : blocks;
}
function clockMissCards(ps, segs, bw) {                                   // Requests.gs reqBindMissCards_
  const bl = clockBlocks(ps, segs, bw);
  const full = segs.filter((x) => x.in != null && x.out != null), cards = segs.filter((x) => (x.in == null) !== (x.out == null));
  const ordered = bl.map((p) => { let best = -1, bo = 0; full.forEach((f, i) => { const ov = Math.min(p.e, f.out) - Math.max(p.s, f.in); if (ov > bo) { bo = ov; best = i; } }); return { p, idx: best }; });
  const lone = clockLone(bl, full, cards);
  let n = 0;
  ordered.forEach((x, i) => { if (x.idx === -1) n += lone[i] ? 1 : 2; });
  ordered.sort((a, b) => a.p.s - b.p.s);
  let maxEnd = null, prevIdx = -1;
  ordered.forEach((x) => { if (maxEnd !== null && x.p.s > maxEnd && x.idx !== -1 && x.idx === prevIdx && !gapByBrk(maxEnd, x.p.s, bw)) n += 2; if (maxEnd === null || x.p.e > maxEnd) maxEnd = x.p.e; prevIdx = x.idx; });
  return n;
}
function clockSegsWithMiss(segs, ok) {                                    // Requests.gs reqSegsWithMiss_
  const out = segs.map((x) => ({ in: x.in, out: x.out }));
  for (const r of ok) {
    if (r.kind !== 'miss') continue;
    const a = toMin(r.start), b = toMin(r.end), t = String(r.miss_type || '');
    if (t === 'both' && a != null && b != null) out.push({ in: a, out: b > a ? b : b + 1440 });
    else if (t === 'in' && a != null) { const x = out.find((y) => y.in == null); if (x) x.in = a; }
    else if (t === 'out' && b != null) { const x = out.find((y) => y.out == null); if (x) x.out = x.in != null && b <= x.in ? b + 1440 : b; }
    else if (t === 'break' && a != null && b != null) { const x = out.find((y) => y.in != null && y.out != null && y.in < b && y.out > a); if (x) { out.push({ in: a, out: x.out }); x.out = b; } }
  }
  return out;
}
function clockOverMin(ps0, segs, bw, lateGiven, backs, starts, leadMin) {      // Requests.gs reqOverCreditMin_（中途離開比照遲到關著＝0）
  if (!ps0.length || !segs.length || segs.some((x) => x.in == null || x.out == null)) return null;
  const ps = ps0.slice().sort((a, b) => a.s - b.s), ss = segs.slice().sort((a, b) => a.in - b.in);
  const inB = (a, b) => (bw ? Math.max(0, Math.min(b, bw[1]) - Math.max(a, bw[0])) : 0);
  let over = 0;
  ps.forEach((p) => {
    const cov = ss.reduce((acc, x) => acc + Math.max(0, Math.min(p.e, x.out) - Math.max(p.s, x.in)), 0);
    const covB = ss.reduce((acc, x) => { const a = Math.max(p.s, x.in), b = Math.min(p.e, x.out); return acc + (b > a ? inB(a, b) : 0); }, 0);
    over += (p.e - p.s - inB(p.s, p.e)) - (cov - covB);
  });
  let late = Math.max(0, Math.min(ss[0].in, ps[0].e) - ps[0].s);
  late -= inB(ps[0].s, ps[0].s + late);
  if (backs.length) ps.slice(1).forEach((p) => {
    if (!backs.some((e) => e <= p.s && (p.s - e) - inB(e, p.s) <= 0)) return;
    if (ss.some((x) => x.in <= p.s && x.out > p.s)) return;
    const ins = ss.filter((x) => x.in > p.s && x.in < p.e).map((x) => x.in);
    if (!ins.length) return;
    const first = Math.min(...ins); late += (first - p.s) - inB(p.s, first);
  });
  if (leadMin > 0) { over += leadMin; late += leadMin; }
  if (lateGiven != null) late = Math.min(late, Math.max(0, lateGiven));
  let early = 0;
  if (starts.length) ps.forEach((p) => {
    if (!starts.some((t) => t >= p.e && (t - p.e) - inB(p.e, t) <= 0)) return;
    if (ss.some((x) => x.in < p.e && x.out >= p.e)) return;
    const outs = ss.filter((x) => x.out > p.s && x.out < p.e).map((x) => x.out);
    if (!outs.length) return;
    const last = Math.max(...outs); early += (p.e - last) - inB(last, p.e);
  });
  return Math.max(0, Math.round(over - late - early));
}
function clockCoreOk(date, ps, segs, bw, ok, lead) {                   // Requests.gs reqLateLeadCoreOk_（主管遲到欄空白；還在上班的日子不會走到這裡＝第八輪方案 B，所以不照抄 reqWorkingSegs_）
  const bindOn = date >= CLOCK_BIND_FROM && ps.length > 0, strict = date >= CLOCK_STRICT_FROM;
  const bp = lead ? lead.rest : ps, leadMin = lead ? lead.leadMin : 0;
  const miss = bindOn ? clockMissCards(bp, segs, bw) : 0;
  const missHave = ok.reduce((a, r) => a + (r.kind !== 'miss' ? 0 : (r.miss_type === 'break' || r.miss_type === 'both') ? 2 : 1), 0);
  const tripOk = ok.some((r) => r.kind === 'trip'), loneCard = segs.some((x) => (x.in == null) !== (x.out == null));
  if (bindOn && !(tripOk && !loneCard) && miss > missHave) return false;
  if (!strict) return true;
  const sm = clockSegsWithMiss(segs, ok);
  const backs = [], starts = [];
  for (const r of ok) {
    if (r.kind !== 'leave' && r.kind !== 'trip') continue;
    const a = toMin(r.start), b = toMin(r.end);
    if (a == null || b == null || a === b) continue;
    const e = b <= a ? b + 1440 : b;
    backs.push(e, e - 1440, e + 1440); starts.push(a, a - 1440, a + 1440);
  }
  let over = clockOverMin(bp, sm, bw, null, backs, starts, leadMin);
  // 有沒配對的卡：完整打卡段＋已核准忘打卡單補的卡照算（Requests.gs reqOverSegsKnown_；還在上班那張當 16 小時的那條在方案 B 下走不到）
  if (over == null && !(bindOn && miss > missHave) && ps.length) {
    const known = sm.filter((x) => x.in != null && x.out != null);
    if (known.length) over = clockOverMin(bp, known, bw, null, backs, starts, leadMin);
  }
  return !(over != null && over >= CLOCK_STRICT_DIFF_MIN);
}
/** c＝lateLeadClock 的結果；這份送出打卡端最後會不會真的套新規則（Requests.gs reqLateLeadKeep_） */
function clockKeep(c, periods, segs0, reqs, brk, date) { return clockKeepAny(c, segs0, reqs, date, false); }
/** 同上、但只認「新規則那兩條判得過」（給新規則預填用；判不過就改給主線預填） */
function clockKeepStrict(c, periods, segs0, reqs, brk, date) { return clockKeepAny(c, segs0, reqs, date, true); }
function clockSegsMin(segs0) { return (segs0 || []).filter(Boolean).map((x) => { const a = toMin(x.in), b0 = toMin(x.out); return { in: a, out: b0 == null ? null : b0 + (x.cross || (a != null && b0 <= a) ? 1440 : 0) }; }); }
/** 還沒下班（clockOpen）的對外版本（2026-11-27 第十輪）：segs＝打卡段 [{in,out,cross}]（HH:MM）、reqs＝申請（pending:true 不算）。給共用案例檔 late-lead-open-cases-v1.json 對照用 */
export function lateLeadOpen(segs0, reqs) { return clockOpen(clockSegsMin(segs0), (reqs || []).filter((r) => r && r.pending !== true)); }
function clockKeepAny(c, segs0, reqs, date, strictNew) {
  const segs = clockSegsMin(segs0);
  const ok = (reqs || []).filter((r) => r && r.pending !== true);
  const ps = c.ps.map(([s, e]) => ({ s, e })), bw = [c.bs, c.be];
  const lead = { rest: c.ps.slice(c.lead.length).map(([s, e]) => ({ s, e })), leadMin: total(c.lead) };
  // 方案 B（主管「可以，照推薦」：同仁還沒打下班卡就核定的日子照現行算法、下班後重新核定才算遲到）：還沒下班（clockOpen）＝打卡端不套、整份照主線
  //   （Requests.gs reqLateLeadOpen_ 同一條）。2026-11-27 第九輪：不看現在時間、不看 16 小時——第八輪用「上班中 16 小時」，開卡與送出各看各的現在，界線前後卡片≠寫入。
  //   新規則那條路徑也不算「上班中那張卡打到現在／當 16 小時」（打卡端 reqLateLeadSegs_ 同樣拿掉 working），所以整條判斷跟現在幾點無關
  if (clockOpen(segs, ok)) return false;
  // 2026-11-27 第十輪：只看新規則那兩條判不判得過（Requests.gs reqLateLeadKeep_ 同步拿掉「兩邊都判不過也套新規則」；strictNew 現在跟一般版一樣）
  return clockCoreOk(date, ps, segs, bw, ok, lead);
}
/** 還沒下班（照抄 Requests.gs reqLateLeadOpen_，2026-11-27 第九輪）：這天最後一張卡（照時間）是沒配對的上班卡，而且已核准的忘打卡單補不上那張下班卡
 *  （clockSegsWithMiss 補完那一段仍沒有下班時間）。segs＝分鐘的打卡段；ok＝已核准申請。不看現在時間。 */
function clockOpen(segs, ok) {
  let k = -1, last = null;
  segs.forEach((x, i) => { const t = x.out != null ? x.out : x.in; if (t != null && (last === null || t >= last)) { last = t; k = i; } });
  if (k < 0 || segs[k].in == null || segs[k].out != null) return false;
  const filled = clockSegsWithMiss(segs, ok);
  return !filled[k] || filled[k].out == null;
}
/** 其餘段的遲到分鐘，照 Code.gs computeApprovalStatus（新規則那條用其餘段比、不併休息帶、沒有中途離開比照遲到）：
 *  每段拿重疊最多的完整打卡段，上班卡比那段開頭晚＝遲到；一段都沒配到完整打卡段時照 loneCardsForPeriods_ 配單張卡（4 小時內、配到最多張、距離最短），單張上班卡比開頭晚＝遲到 */
function clockRestLate(ps, segs) {
  const full = [], cards = [];
  for (const x of segs || []) {
    const a = toMin(x && x.in), b0 = toMin(x && x.out), b = b0 == null ? null : b0 + (x.cross || (a != null && b0 <= a) ? 1440 : 0);
    if (a != null && b != null) full.push([a, b]); else if (a != null || b != null) cards.push({ in: a, out: b });
  }
  const open = ps.map((p, i) => i).filter((i) => !full.some((f) => Math.min(ps[i][1], f[1]) - Math.max(ps[i][0], f[0]) > 0));
  let lone = {};
  if (open.length && cards.length && cards.length <= 8) {
    let bestN = 0, bestD = Infinity;
    const dist = (c, i) => { const d = c.in != null ? Math.abs(c.in - ps[i][0]) : Math.abs(c.out - ps[i][1]); return d <= 240 ? d : null; };
    const walk = (ci, pick, n, tot) => {
      if (ci === cards.length) { if (n > bestN || (n === bestN && n > 0 && tot < bestD)) { bestN = n; bestD = tot; lone = Object.assign({}, pick); } return; }
      walk(ci + 1, pick, n, tot);
      for (const i of open) { if (pick[i]) continue; const d = dist(cards[ci], i); if (d === null) continue; pick[i] = cards[ci]; walk(ci + 1, pick, n + 1, tot + d); delete pick[i]; }
    };
    walk(0, {}, 0, 0);
  }
  let late = 0;
  ps.forEach((p, i) => {
    let best = null, bo = 0;
    for (const f of full) { const ov = Math.min(p[1], f[1]) - Math.max(p[0], f[0]); if (ov > bo) { bo = ov; best = f; } }
    if (best) { if (best[0] > p[0]) late += best[0] - p[0]; return; }
    const c = lone[i];
    if (c && c.out == null && c.in > p[0]) late += c.in - p[0];
  });
  return late;
}
function corePeriodsRaw(o) {
  // 取整碎段（2026-11-21 複審第 8 項）：卡對不到邊界時取整到時鐘的 15 分格，但假單、休息帶、班表、加班單的起訖不一定在 15 分整點，
  //   取整後的點離這種邊界不到 15 分 → 切完剩一段不到 15 分的時段（例 班表 10:24–13:12、假單 10:48–12:44、下班卡 12:52 → 取整 12:45 → 多出 12:44–12:45）。
  //   「時段以 15 分鐘為一單位」：從邊界到取整點不到一單位＝這張卡就對到那個邊界（那一小段不算）。
  //   要不要對到邊界，只有算完才知道那一小段是不是孤立的（前後有沒有接著別的核定時段），所以先照原本算一輪；
  //   有這種碎段，就把造成它的那張卡改對到邊界、整個重算（加班單外的 8 小時額度照新的卡重算）。沒有碎段＝跟改之前一字不差。
  //   邊界都在 15 分整點（真實資料幾乎都是）時，取整點跟邊界的距離一定是 0 或 15 分以上，不會走到這裡。
  //   2026-11-22 Eason「遲到照記」：遲到、早退分鐘一律照原本那輪（例 請假到 13:07、13:10 回來待 10 分又走 → 回來那段拿掉，遲到 3 分照記）。
  //   重算的結果只有在「遲到、早退（含中途離開、休息超過）、要補加班單分鐘、假單超過提醒都跟原本一樣、總分鐘沒變多、還有時段、沒剩碎段」時才用；
  //   否則改用原本那輪、只把碎段那幾段拿掉（其他欄位都照原本那輪，遲到早退自然一樣）。
  //   拿掉之後整天一段都不剩（唯一的核定段就是碎段）→ 照原本那輪不動（保留碎段）：空時段在畫面上是「整天請假／上班時段全被假單蓋掉」的意思，
  //   回空的或 null 會讓主管看不到遲到早退，所以這類不修。
  const first = corePass(o, null);
  if (!first[1].length) return first[0];
  const pin = new Map();
  let out = first;
  for (let k = 0; k < 4 && out[1].length; k++) {
    const n0 = pin.size;
    for (const f of out[1]) if (!pin.has(f.key)) pin.set(f.key, f.to);
    if (pin.size === n0) break;
    out = corePass(o, pin);
  }
  const a = first[0], b = out[0];
  if (b && !out[1].length && b.periods.length && minsOf(b) <= minsOf(a) && ['late', 'early', 'gapLate', 'restLate', 'overMin', 'leaveOver'].every((k) => b[k] === a[k])) return b;
  return dropFrags(a, first[1]) || a;
}
const minsOf = (r) => (r ? total(r.periods.map((p) => span(toMin(p.start), toMin(p.end)))) : 0);
/** 原本那輪只拿掉碎段：時段、時數跟著改；遲到早退、說明、要補加班單照原本那輪（說明裡「班表外多做／比班表多 N 小時」與 leaveOver 是含碎段算的，最多差 14 分）。一段都不剩回 null（呼叫端照原本那輪） */
function dropFrags(r, frags) {
  const gone = new Set(frags.map((f) => toHm(f.p) + '–' + toHm(f.q)));
  const periods = r.periods.filter((p) => !gone.has(p.start + '–' + p.end));
  if (!periods.length) return null;
  return Object.assign({}, r, { periods, hours: Math.round(minsOf({ periods }) / 60 * 100) / 100 });
}

function corePass(o, pin) {
  const plan = o.plan && o.plan.work && Array.isArray(o.plan.segs) ? o.plan.segs : [];
  const S = merge(plan.map((x) => span(toMin(x.start), toMin(x.end))));
  // 沒有班表（這家店沒排他，例：到別店支援；或班表時段是空的）＋有已核准加班單（2026-11-18 Eason，張淳 11/17 金山）：照打卡算，加班單只標示哪段是加班、不截斷時段。
  // 排休（plan.work === false：休息日／例假整天算加班）不算這種，照舊只算加班單那段
  const noSched = !S.length && !(o.plan && o.plan.work === false);
  const reqs = Array.isArray(o.reqs) ? o.reqs : [];
  const otRaw = reqs.filter((r) => r.kind === 'ot' && r.pending !== true).map((r) => span(toMin(r.start), toMin(r.end)));      // 只算已核准（2026-11-19 防呆，同下面假單；待審單不算進核定，要先審單）
  const lvReqs = reqs.filter((r) => r && (r.kind === 'leave' || r.kind === 'trip') && r.pending !== true);      // 只算已核准（呼叫端本來就只給已核准的；防呆）
  const lvSpan = (r) => (toMin(r.start) != null && toMin(r.start) === toMin(r.end) ? null : span(toMin(r.start), toMin(r.end)));      // 起訖相同（11:00–11:00）＝沒有時段，忽略（同打卡端；原本被當成 24 小時）
  const LVraw = lvReqs.map(lvSpan).filter((x) => x && x[1] > x[0]);
  // 假單時數（分鐘）：有填時數照時數，只有時段沒時數照時段長度（第 4 題：上班＋假滿 8 小時就不再多算班表外的打卡）
  const leaveMin = lvReqs.reduce((a, r) => { const h = Number(r.hours); if (h > 0) return a + h * 60; const x = lvSpan(r); return a + (x ? x[1] - x[0] : 0); }, 0)
    - Math.max(0, LVraw.reduce((a, x) => a + x[1] - x[0], 0) - total(merge(LVraw)));      // 兩張假單時段重疊：重疊那段只算一次（2026-11-18 驗收）
  const untimedLeave = lvReqs.some((r) => !lvSpan(r) && Number(r.hours) > 0);
  const brkS = toMin(o.brk && o.brk.start), brkE = toMin(o.brk && o.brk.end);
  const BRK = brkS != null && brkE != null && brkE > brkS ? [[brkS, brkE]] : [];
  // 半天班（2026-11-17 Eason）：班表從第一段開始到最後一段結束沒有整段蓋過休息帶（例 央廚 09:00–12:30、總部 14:15–22:15）→ 班表裡的時間不扣休息帶。
  // 沒班表、或班表整段蓋過（含兩段班中間剛好空著休息帶）照舊扣。班表以外多出來的打卡仍照休息帶算（BRK）。
  const BRKcut = BRK.length && S.length && !(S[0][0] <= BRK[0][0] && S[S.length - 1][1] >= BRK[0][1]) ? [] : BRK;
  const notes = [];

  // 1. 打卡段（忘打卡單補上缺的那張；補的時間超出班表的部分不算，見下面交集）
  // 同一分鐘的上班＋下班卡（誤按）＝0 分鐘，當成沒這段；原本被當成跨夜 24 小時（2026-11-17）。真的跨夜（cross、或下班早於上班）不受影響
  const all = (Array.isArray(o.segs) ? o.segs : []).map((x) => ({ in: toMin(x.in), out: toMin(x.out), cross: !!x.cross, fromReq: {} }));
  const raw = all.filter((x) => !(x.in != null && x.in === x.out && !x.cross));
  const zeroOnly = all.length > 0 && !raw.some((x) => x.in != null || x.out != null);
  // 當天第一張真的卡（下面補忘打卡單、照班表猜缺卡會改到 raw，先記下來；上午整段沒到改算遲到用，2026-11-26）
  let firstCard = null;
  for (const x of raw) {
    const isIn = x.in != null, t = isIn ? x.in : (x.out == null ? null : x.out + (x.cross ? 1440 : 0));
    if (t == null) continue;
    if (firstCard === null || t < firstCard.t) firstCard = { t, isIn }; else if (t === firstCard.t && !isIn) firstCard.isIn = false;
  }
  // 忘打卡單補的那張卡接到哪一段（2026-11-17）：補上去之後上班早於下班、而且兩張卡最接近的那段；原本只找第一個缺卡的段、不看時間
  //   （打卡 12:48–16:01、?–17:23、?–21:30＋補上班 17:30 被接成 17:30→隔天 17:23）。下班在午夜後（跨夜）＝隔天，12 小時內才算接得上；都接不上就不接。
  const gapOf = (i, t, cross) => { const d = t + (cross ? 1440 : 0) - i; return d > 0 ? d : (d + 1440 < 720 ? d + 1440 : null); };
  const pick = (list, f) => list.map((x) => [x, f(x)]).filter((y) => y[1] != null).sort((x, y) => x[1] - y[1]).map((y) => y[0])[0];
  for (const r of reqs.filter((x) => x.kind === 'miss')) {
    const a = toMin(r.start), b = toMin(r.end);
    if (r.miss_type === 'both' && a != null && b != null) raw.push({ in: a, out: b, fromReq: { in: true, out: true } });
    else if (r.miss_type === 'in' && a != null) { const s = pick(raw.filter((x) => x.in == null && x.out != null), (x) => gapOf(a, x.out, x.cross)); if (s) { s.in = a; s.fromReq.in = true; } }
    else if (r.miss_type === 'out' && b != null) { const s = pick(raw.filter((x) => x.out == null && x.in != null), (x) => gapOf(x.in, b, false)); if (s) { s.out = b; s.fromReq.out = true; } }
    else if (r.miss_type === 'break' && a != null && b != null) {          // 中間休息沒打卡：end＝出去、start＝回來（同打卡端）
      const s = raw.find((x) => x.in != null && x.out != null && x.in < b && (x.cross ? x.out + 1440 : x.out) > a);
      if (s) { raw.push({ in: a, out: s.out, cross: s.cross, fromReq: { in: true } }); s.out = b; s.cross = false; s.fromReq.out = true; }
    }
  }
  // 還缺的卡：用班表邊界補上（打卡端會回「要有忘打卡單」）
  for (const x of raw) {
    // 這張卡要對得到那段班才猜（2026-11-17）：下班卡比那段班的開始還早（08:00 下班卡、班表 09–18）、上班卡比那段班的結束還晚 → 不猜，
    //   原本猜成 09:00→隔天 08:00，冒出「要補加班單 825 分」。過午夜的下班卡（cross）與跨夜班照舊算隔天；
    //   沒標 cross 的卡看它離哪一頭近：往後算到隔天比較近（班表 13:45–22:45、下班卡 00:45）＝過午夜才下班，照舊猜。
    if (x.in == null && x.out != null) { const s = S.find((y) => y[1] >= x.out - TOL) || S[0]; if (s && (x.cross || s[1] > 1440 || s[0] < x.out || x.out + 1440 - s[1] < s[0] - x.out)) x.in = s[0]; x.guess = true; }
    if (x.out == null && x.in != null) { const s = S.find((y) => y[0] <= x.in + TOL && y[1] > x.in) || S[S.length - 1]; if (s && (s[1] > x.in || s[0] + 1440 - x.in < x.in - s[1])) x.out = s[1]; x.guess = true; }
  }
  // 2026-11-26 第三輪（Codex 第一輪擋項 2）上午整段沒到：整段落在不打卡休息帶裡的打卡（例 12:16–12:27、13:00–17:00 的前一段）不算上班時間、也不當成班別休息的空檔。
  //   休息帶本來就不算時數；打卡端（Code.gs lateLeadOf_）照當天第一張卡判「上午整段沒到」、記遲到，這段只是「有多出的打卡段」。
  //   沒拿掉時同一筆打卡三種班表寫法三種預填：一段 08–17 休 60＝當成 12:27 出去休息 60 分、扣到 13:27（打卡端判不到、要 2 張忘打卡單）；一段沒填休息分鐘＝只預填 13–17；
  //   兩段 08–12／13–17＝8 小時遲到 240。確認頁第 1 題 A「不管班表寫成一段或兩段，結果一樣」＋逐句表第 3 句「上午整段沒來、休息時間或之後才打上班卡，算遲到」→ 三種都 8 小時、遲到 240。
  //   只在：知道日期而且生效日起（同 LATE_LEAD_FROM）、班表蓋過休息帶（BRKcut）而且休息帶前面有一段班（一段班蓋過休息帶，或兩段班中間空檔在休息帶裡）、
  //   當天第一張卡是上班卡而且在休息開始以後（前面整段沒有卡）、沒有任何卡（含忘打卡單補的、照班表猜的）落在休息開始以前、拿掉後休息結束以後還有卡、
  //   休息帶前面那段班沒有整段被已核准假單／出差單蓋掉（整段請假＝照請假，第 4 題「跟現在一樣」）。其他一律照舊。
  const llOn = lateLeadOn(o);
  if (llOn && BRKcut.length && firstCard && firstCard.isIn && firstCard.t >= BRKcut[0][0] && !untimedLeave) {
    const bS = BRKcut[0][0], bE = BRKcut[0][1];
    const lead = S.some((s, k) => s[0] < bS && (s[1] >= bE || (s[1] >= bS && S[k + 1] && S[k + 1][0] > s[1] && S[k + 1][0] <= bE)))
      && total(minus(intersect(S, [[0, bS]]), LVraw)) > 0;
    const before = raw.some((x) => (x.in != null && x.in < bS) || (x.out != null && !x.cross && x.out <= bS));
    const inBrk = (x) => x.in != null && x.out != null && !x.cross && !x.guess && !x.fromReq.in && !x.fromReq.out && x.in >= bS && x.out > x.in && x.out <= bE;
    const keep = raw.filter((x) => !inBrk(x));
    if (lead && !before && keep.length < raw.length && keep.some((x) => (x.in != null && x.in >= bE) || (x.out != null && (x.cross || x.out > bE)))) raw.splice(0, raw.length, ...keep);
  }
  let W = merge(raw.filter((x) => x.in != null && x.out != null).map((x) => span(x.in, x.out)));
  if (!W.length) {
    if (!S.length || zeroOnly) return [null, []];                     // 沒打卡也沒班：沒得算；只有同一分鐘的上下班卡＝有打卡但 0 分鐘，不照班表填（卡沒有缺，打卡端不會要忘打卡單）
    // 沒打卡、有已核准整天的假單／出差單（沒填時段，時數合計蓋滿班表或滿 8 小時）＝整天請假：不照班表填時段（2026-11-15 游家輝事假 8 小時被要求補 4 張忘打卡單）
    const noTime = reqs.filter((r) => (r.kind === 'leave' || r.kind === 'trip') && !r.start).reduce((a, r) => a + (Number(r.hours) || 0), 0);
    if (noTime > 0 && (noTime >= total(minus(S, BRKcut)) / 60 - 0.01 || noTime >= 8)) return [null, []];      // 班表時數要扣不打卡休息帶（央廚 09–17＝7 小時，事假 7 小時就是整天）
    W = S.map((x) => x.slice());                                 // 沒打卡但有班：照班表（打卡端回要忘打卡單）
  }
  const Wraw = W.map((x) => x.slice());
  // 跨夜班之後接續的加班單（例：班表 22:00–06:00、加班單 06:00–08:00）：單上只有時鐘時間，其實是隔天早上 → 換到跨日後的時間再比。
  // 只搬「當天那個時間沒有打卡對到、加一天後落在這天班表或打卡的範圍內（差 15 分內算接得上）」的單；其他照舊（2026-11-15 考勤驗收 C6-6）
  const dayEnd = Math.max(...Wraw.concat(S).map((x) => x[1]));
  const OT = merge(otRaw.map((x) => (x && dayEnd > 1440 && x[1] <= 1440 && x[0] + 1440 <= dayEnd + TOL && !total(intersect([x], Wraw)) ? [x[0] + 1440, x[1] + 1440] : x)));
  // 已核准、有填起訖的假單／出差單時段（2026-11-18 Eason 第 1、2 題，docs/decisions/0005-開頭請假與待審單核定-20261118.md）：
  //   假單時段一律不算上班（核定扣掉，請假時段裡有打卡也一樣；要算上班就作廢假單）；班表開頭請假 → 遲到從假單結束算。
  //   跨夜班凌晨的假單（班表 22:00–06:00、事假 05:00–06:00）同加班單：當天那個時間對不到班表／打卡、加一天落在這天範圍內 → 換到隔天。
  const LV = merge(LVraw.map((x) => (dayEnd > 1440 && x[1] <= 1440 && x[0] + 1440 < dayEnd && !total(intersect([x], S.concat(Wraw))) ? [x[0] + 1440, x[1] + 1440] : x)));
  // 遲到／早退用的班表（2026-11-18）：每段班開頭被假單蓋到的部分往後推到假單結束、結尾被蓋到的往前推到假單開始（只推頭尾；班表中間的假不改遲到規則）。
  //   推到的點落在不打卡休息帶裡（或剛好是休息開始）→ 再順延到休息結束（結尾：提前到休息開始）；跨夜班的休息帶也試加一天。
  //   例 班表 09–18、休 12–13、事假 09–12、13:10 回來 → 遲到從 13:00 算＝10 分（原本從 12:00 算＝70）。整段班都被假單蓋掉的那段不算。
  const BRKs = BRKcut.concat(BRKcut.map(([a, b]) => [a + 1440, b + 1440]));
  const pushIn = (a, end) => { for (let k = 0; k < 8; k++) { const l = LV.find((x) => x[0] <= a && x[1] > a), b = !l && BRKs.find((x) => x[0] <= a && x[1] > a); if (l) a = Math.min(l[1], end); else if (b) a = Math.min(b[1], end); else break; } return a; };
  const pullOut = (e, beg) => { for (let k = 0; k < 8; k++) { const l = LV.find((x) => x[0] < e && x[1] >= e), b = !l && BRKs.find((x) => x[0] < e && x[1] >= e); if (l) e = Math.max(l[0], beg); else if (b) e = Math.max(b[0], beg); else break; } return e; };
  const SL = S.map((s) => { const a = LV.some((x) => x[0] <= s[0] && x[1] > s[0]) ? pushIn(s[0], s[1]) : s[0]; const y = [a, s[1]]; y.moved = a !== s[0]; return y; }).filter((x) => x[1] > x[0]);
  const SE = S.map((s) => (LV.some((x) => x[0] < s[1] && x[1] >= s[1]) ? [s[0], pullOut(s[1], s[0])] : s.slice())).filter((x) => x[1] > x[0]);
  // 1b. 班別設定的休息（break_min）：同一段班中間出去休息有打卡 → 從出去那張卡起扣滿休息分鐘；休超過的照實扣到回來那張卡（2026-11-17 Eason「照班別休息分鐘扣，超過的照實扣」）。
  //     原本兩張卡各往內取整到 15 分，休 23 分會被扣成 45 分（陳盈如 11/2 E班 09:00–17:30 休 30：13:25 出、13:48 回 → 7.75 小時，主管手動核 13:25–13:55＝8 小時）。
  //     做法：出去、回來那兩張卡先接成一段（不取整），最後再把休息挖掉。每段班只認第一個空檔；空檔要整個在那段班裡。
  //     2026-11-20 Eason 第 3 題 B：二段班（當天班表兩段以上）、中途離開比照遲到開著時（GAP_LATE_SCOPE，見 1c）→ 休息只扣滿班別休息分鐘，
  //     超過的部分核定蓋過、記遲到（例：排休 30、17:00 出 17:50 回 → 休息 17:00–17:30，17:30–17:50 的 20 分記遲到）。單段班、沒開時照 11/17（超過的照實扣、不記遲到）。
  //     空檔碰到不打卡休息帶、已核准有時段的假單／出差單、「中間休息」忘打卡單 → 照 11/17。打卡端 Requests.gs reqGapLateMs_ 同一套。
  const gapScope = gapScopeOf(o);
  const gapOn = (gapScope === 'multi' && S.length >= 2) || (gapScope === 'all' && S.length >= 1);
  const MB = reqs.filter((r) => r && r.kind === 'miss' && r.miss_type === 'break' && r.pending !== true).map((r) => span(toMin(r.end), toMin(r.start))).filter(Boolean);      // end＝出去、start＝回來
  const gapSkip = BRK.concat(BRK.map(([a, b]) => [a + 1440, b + 1440]), LV, MB, MB.map(([a, b]) => [a + 1440, b + 1440]));      // 休息帶用整條（半天班 BRKcut 是空的，打卡端照樣看休息帶）
  const restOver = gapOn && S.length >= 2;      // 題 3 B 只限二段班（就算 GAP_LATE_SCOPE 開成 all，單段班的班別休息也照 11/17）
  let restLate = 0;
  const restLateSpans = [];
  const RESTS = [];
  for (const p of plan) {
    const bm = Math.round(Number(p.break_min) || 0), sp = span(toMin(p.start), toMin(p.end));
    if (!(bm > 0) || !sp) continue;
    for (let i = 1; i < W.length; i++) {
      const a = W[i - 1][1], b = W[i][0];
      if (!(a > sp[0] && b < sp[1] && b > a)) continue;
      const over = restOver && b - a > bm && !gapSkip.some((x) => x[0] < b && x[1] > a);
      RESTS.push(b - a <= bm || over ? [a, a + bm] : [a, b]);
      if (over) { restLate += b - a - bm; restLateSpans.push([a + bm, b]); }
      W = merge(W.slice(0, i - 1).concat([[W[i - 1][0], W[i][1]]], W.slice(i + 1)));
      break;
    }
  }
  if (RESTS.length) notes.push('休息 ' + RESTS.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + '（班別休息從出去那張卡起算' + (RESTS.some(([a, b]) => b - a > 0 && plan.some((p) => Number(p.break_min) > 0 && b - a > Number(p.break_min))) ? '，休超過的照實扣' : '') + '）');
  // 1c. 二段班中途離開又回來，比照遲到記（2026-11-20 Eason 第 11 題 B；例 班表 16:00–20:00，16:03 走、17:24 回 → 遲到 81 分）：
  //     同一段班裡兩段打卡中間的空檔，核定直接蓋過（跟開頭晚到「核定留班表」一樣），空檔分鐘照實記成遲到（打卡端 computeApprovalStatus 記「遲到N分」、薪資照扣；
  //     打卡端 reqGapLateMs_ 不把這段當「核定比打卡多」）。沒有寬限、不設最短分鐘，同開頭遲到。範圍 GAP_LATE_SCOPE（o.gapLate 可覆寫）：
  //     'off'＝改之前（中途離開照打卡算）；'multi'＝只有當天班表兩段以上（二段班）；'all'＝單段班也算。打卡端 REQ_GAP_LATE_FROM／REQ_GAP_LATE_SCOPE 要一起開、設成一樣。
  //     不算（照改之前）：空檔碰到不打卡休息帶、碰到已核准有時段的假單／出差單（走請假那幾條）、是「中間休息」忘打卡單補出來的休息、
  //     班別休息分鐘那段班的第一個空檔（上面 1b 已當休息）、空檔不在同一段班表裡（例：前一段班結尾早走到下一段班之間）。
  if (restLate > 0) notes.push('休息超過班別休息 ' + restLateSpans.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + '，' + restLate + ' 分記遲到（二段班比照遲到，薪資照扣）');
  let gapLate = 0;
  if (gapOn) {
    const skip = gapSkip;
    const fill = [];
    for (let i = 1; i < W.length; i++) {
      const a = W[i - 1][1], b = W[i][0];
      if (!(b > a) || !S.some((s) => a > s[0] && b < s[1]) || skip.some((x) => x[0] < b && x[1] > a)) continue;
      fill.push([a, b]); gapLate += b - a;
    }
    if (fill.length) {
      W = merge(W.concat(fill));
      notes.push('中途離開 ' + fill.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + '，' + gapLate + ' 分記遲到（中途離開比照遲到，薪資照扣）');
    }
  }
  // 已核准、有時段假單的起訖也當對齊點（2026-11-18 Eason 選 A：假 16–18、15:50 下班 → 算到 16:00；假 17–19、19:10 回 → 從 19:00 起）
  // 2026-11-21 A'：分成上班卡用的開始類（st）、下班卡用的結束類（en），見 snapIn／snapOut
  const head = (g) => g.map((x) => x[0]), tail = (g) => g.map((x) => x[1]);
  const bounds = { st: [head(S), head(OT), tail(BRK), tail(LV)], en: [tail(S), tail(OT), head(BRK), head(LV)], pin, fb: { i: new Map(), o: new Map() } };      // 休息帶、假單：結束＝該回來上班（開始類），開始＝該下班（結束類）
  W = merge(W.map(([a, b]) => [snapIn(a, bounds), snapOut(b, bounds)]));

  // 2. 班表＋已核准加班單裡的打卡照算；都沒有（排休、沒排班又沒加班單）就照打卡（打卡端回要加班單）
  const A = merge(S.concat(OT));
  const otOnly = noSched && OT.length > 0;      // 沒班表＋有加班單：照打卡（見上面 noSched）
  let core = A.length && !otOnly ? intersect(W, A) : W.map((x) => x.slice());
  // 3. 遲到：開頭留班表。
  //    當天第一張上班卡那段班：比班表開頭晚 → 核定從班表開頭起、標遲到（原本的規則）。
  //    後面的班段（兩段班的第二段）：只有「那段的打卡不完整、靠忘打卡單或班表邊界補上」時才照班表開頭填
  //    （2026-11-17 Eason：六張犁兩段班 09–13／18–22，打卡 09:05–?、19:52–?＋忘打卡單 →「照班表時段填入，有需要更改的話主管自行更改上下班時間」）。
  //    後面的班段打卡完整就照打卡算——11 月正式資料重放：每段都留班表開頭會讓 54 人天預填變動、14 筆離主管實核更遠（墨竹亭兩段班晚上常晚到，主管都照實核）。
  //    共同條件：只補「那張上班卡那段打卡」的開頭，那段取整後還在、而且就在這段班裡。打卡短到取整後消失（09:31–09:44）、或那張卡在這段班快結束才打（兩段班 13:51）→ 不補。
  //    2026-11-26 上午整段沒到改算遲到：遲到分鐘不把不打卡休息帶算進去（08:00 班 12:47 到＝240，原本 287；同打卡端「核定時段裡、第一張上班卡之前的分鐘數」）；
  //    班表寫兩段、中間空檔就是休息帶、前一段整段沒來 → 兩段當一段班（第 1 題 A，生效日起、知道日期才套，見 LATE_LEAD_FROM）。
  let late = 0;
  const SLx = llOn ? mergeLeadSL(SL, BRKs, firstCard, Wraw) : SL;
  if (SLx.length && core.length && Wraw.length) {
    const lateStep = (s0) => {      // 一段班的開頭晚到：補到班表開頭、記遲到；有補回 true（2026-11-26 從迴圈抽出來，內容沒改）
      const ins = Wraw.filter((w) => w[0] > s0[0] && w[0] < s0[1]).map((w) => w[0]);
      if (!ins.length) return false;
      const firstIn = Math.min(...ins);
      if (Wraw.some((w) => w[0] <= s0[0] && w[1] > s0[0])) return false;
      // 2026-11-18 Eason（取代上面 11/17「後面的班段打卡完整就照打卡算」）：每一段班的開頭晚到都記遲到、核定從那段班表開始（有假單蓋住開頭＝從假單結束），不論有沒有假單、是第幾段。
      //   原本只補「當天第一段」與「那段靠忘打卡單／班表邊界補上」的段。15 分內對齊照班表邊界現行做法（核定對齊、遲到分鐘由打卡端照實記）。
      const c = core.find((x) => (s0.moved ? x[0] >= s0[0] : x[0] > s0[0]) && x[0] < s0[1]);      // 推過的起點（假單結束／休息結束）不吃 15 分寬限：13:10 回來＝遲到 10
      if (!c || core.some((x) => x !== c && x[0] < c[0] && x[1] > s0[0])) return false;
      // 兩段當一段（驗收第 2 項）：第一張卡取整後落在兩段中間的休息帶（12:00–12:44 到 → 12:15、12:30…），比照寫成一段班時對到下一段開頭，結果才跟一段班一樣
      let sn = snapIn(firstIn, bounds);
      if (s0.parts && sn >= s0.parts[0][1] && sn < s0.parts[1][0]) sn = s0.parts[1][0];
      if (c[0] <= sn) { late += o.lateBrkOff === true || !llOn ? firstIn - s0[0] : total(minus([[s0[0], firstIn]], BRKs)); c[0] = s0[0]; return true; }      // lateBrkOff：只給比對舊凍結副本的測試用
      return false;
    };
    // 兩段併成一段的那組補不上（例：第一張卡是休息中打的短短一段，取整後消失）→ 照改之前兩段各自算
    for (const s0 of SLx) if (!lateStep(s0) && s0.parts) s0.parts.forEach(lateStep);
    core = merge(core);
  }
  // 早退（2026-11-18，給一頁核定名單的橘色標籤，跟遲到同一個來源）。
  //   請假前提早走（2026-11-18 Eason「請假前提早離開一律記早退」）：已核准、有時段的假單開始（落在休息帶就往前到休息開始）＝該下班的時間 stops；
  //   不論早走幾分鐘，核定算到那個時間、另記早退分鐘（下面 3'' 一起處理，班表結尾被假單蓋到的、班表中間的假單都算）。
  //   班表結尾沒有假單：照舊（核定照打卡＋對齊，早退分鐘只給名單標籤）。
  let early = 0;
  const stops = [];
  // 2026-11-18 Eason「二段班各段開頭晚到與結尾早走一律記遲到早退（含沒有假單）」：多段班中間那幾段的結尾（後面還有一段班）也是該下班的時間 sched。
  //   當天最後一段的結尾（＝單段班的下班）照舊：核定照打卡＋對齊、不補（正職不足 8 小時要假單，由打卡端檢查）。
  S.forEach((s, i) => { if (LV.some((x) => x[0] < s[1] && x[1] >= s[1])) { const d = pullOut(s[1], s[0]); if (d > s[0]) stops.push({ d, s }); } else if (i < S.length - 1) stops.push({ d: s[1], s, sched: true }); });
  if (SE.length && Wraw.length && !stops.some((x) => x.s === S[S.length - 1])) { const last = SE[SE.length - 1], lo = Math.max(...Wraw.map((w) => w[1])); if (lo > last[0] && lo < last[1] && snapOut(lo, bounds) >= last[1]) early = total(minus([[lo, last[1]]], BRKs)); }      // 只算打卡端會記的（差 15 分內對齊到下班時間；更早走＝核定照打卡取整、打卡端不記早退）
  // 3'. 班表中間請假（2026-11-18 Eason 選 B）：比照開頭請假——假單結束（落在休息帶再順延到休息結束）就是該回來的時間，晚回來＝遲到，核定從那個時間起（同開頭「留班表」）；
  //     假單開始（落在休息帶再提前到休息開始）前提早走＝早退（只算分鐘給名單標籤；核定時段照打卡＋對齊，同結尾早退）。休息帶不算進分鐘。
  //     例 班表 09–18、休 12–13、補休 14–15：15:20 回 → 核定 15:00 起、遲到 20；13:50 走 → 下班對齊 14:00、早退 10。回來時間有打卡蓋到（請假時段裡有打卡）→ 不算遲到。
  if (LV.length && core.length && Wraw.length) {
    for (const l of LV) {
      const sg = S.find((x) => l[0] > x[0] && l[1] < x[1]);      // 假單整個在這段班中間（開頭、結尾的上面已算）
      if (!sg) continue;
      const r = pushIn(l[1], sg[1]);
      const back = Wraw.filter((w) => w[0] > r && w[0] < sg[1]).map((w) => w[0]);
      if (r < sg[1] && back.length && !Wraw.some((w) => w[0] <= r && w[1] > r)) {
        const firstBack = Math.min(...back), cc = core.find((x) => x[0] >= r && x[0] < sg[1]);
        // 不設門檻（2026-11-18 Eason 選 B：晚回來達 30 分以上也一律從假單結束起算、記遲到）。打卡端 reqOverCreditMin_ 同日起把「假單結束到回來那張卡」當遲到、不當多核工時
        //（Requests.gs reqLeaveBackMs_；舊打卡端達 30 分會擋「核定比打卡多」，上線要打卡端先）
        const gap = total(minus([[r, firstBack]], BRKs));
        if (cc && cc[0] <= snapIn(firstBack, bounds) && !core.some((x) => x !== cc && x[0] < cc[0] && x[1] > r)) { late += gap; cc[0] = r; }
      }
      const d = pullOut(l[0], sg[0]);
      if (d > sg[0]) stops.push({ d, s: sg });
    }
    core = merge(core);
  }
  // 3''. 請假前提早走：核定補到該下班的時間（同晚回來補到假單結束），早退分鐘＝那個時間－最後一張下班卡（休息帶不算）。
  //      例 班表 09–18、休 12–13、事假 16–18：15:44 走 → 09–12、13–16＝6 小時、早退 16（原本 15:30、5.5 小時、不記）。
  //      那個時間有打卡蓋到（做到請假時段裡）、或那段班裡沒有下班卡 → 不適用。打卡端 reqOverCreditMin_ 同日起把這段當早退、不當多核工時。
  let stopEarly = 0;
  let schedEarly = 0;
  for (const { d, s, sched } of stops) {
    const before = Wraw.filter((w) => w[0] < d && w[1] > s[0]);
    if (!before.length || Wraw.some((w) => w[0] < d && w[1] >= d)) continue;
    const lo0 = Math.max(...before.map((w) => w[1]));
    // 2026-11-18 驗收：①中間隔著不打卡休息帶（午休前就走、沒回來）＝中途離開不回來，照 main 的單段班中途離開：照打卡算、不補、不記早退（正職不足 8 小時要假單）；
    //   ②多段班中間那段：走了之後、下一段班開始前又回來打卡（整天打卡型態跟班表錯開，例：班表 11:30–15:30／17:00–21:00、打卡 10:51–15:02、15:54–20:02）＝不是提早走，不補
    if (BRKs.some((b) => b[0] < d && b[1] >= lo0)) continue;      // 休息結束整點才走（13:00 整）也算午休前就走、下午沒上（2026-11-18 驗收 B）；13:01 走才算下午有上班
    if (sched) { const nx = S.find((x) => x[0] >= s[1]); if (nx && Wraw.some((w) => w[0] > lo0 && w[0] < nx[0])) continue; }
    //   ③多段班中間那段走了之後整天沒再回來（例：總部 09–14／15–18、12:30 走就沒回來）＝中途離開不回來，同①照打卡、不補（2026-11-18 驗收第 7 點）
    if (sched && !Wraw.some((w) => w[0] >= d)) continue;
    const lo = Math.max(...before.map((w) => w[1]));
    if (lo >= d) continue;
    const gone = total(minus([[lo, d]], BRKs));
    early += gone; if (sched) schedEarly += gone; else stopEarly += gone;
    const cc = core.filter((x) => x[1] <= d && x[1] <= lo + TOL && x[1] > s[0]).sort((a, b) => b[1] - a[1])[0];
    if (cc) cc[1] = d;
  }
  core = merge(core);
  // 3a. 假單時段不算上班（第 2 題）：請假時段裡有打卡也扣掉，說明寫出來
  let lvAll = false;
  if (LV.length) {
    const hit = intersect(core, LV);
    if (hit.length) notes.push('請假 ' + hit.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + ' 有打卡，照假單不算上班（要算上班請把假單作廢）');
    lvAll = core.length > 0 && !minus(core, LV).length;      // 上班時段全被已核准假單蓋掉（整天有時段假單、當天卻有打卡）
    core = minus(core, LV);
  }
  // 3b. 班表以外的打卡（S 有班表時）：當天不含加班單的時數還沒滿 8 小時，就照時間先後算進去，滿 8 小時為止；超過的部分要加班單（2026-11-16）。
  //     放在遲到補開頭之後算：遲到的那段照「開頭留班表」算在 8 小時裡（打卡端是看核定時數超過 8 小時就要加班單）
  let freeExtra = [];
  if (S.length) {
    let budget = Math.max(0, DAY_FREE_MIN - total(minus(minus(core, OT), BRKcut.concat(RESTS))) - leaveMin);      // 班別休息也不算      // 不打卡休息帶不算上班時間；已核准假單／出差時數算進 8 小時（2026-11-18 第 4 題）
    // 只算真的打卡（忘打卡單補的時間超出班表照舊不算，例 10），也不算照班表猜的缺卡
    const real = merge(raw.filter((x) => x.in != null && x.out != null && !x.guess && !x.fromReq.in && !x.fromReq.out).map((x) => span(x.in, x.out)).map(([a, b]) => [snapIn(a, bounds), snapOut(b, bounds)]));
    for (const [a, b] of minus(intersect(minus(W, A), real), BRK.concat(LV))) {
      if (budget <= 0) break;
      const take = Math.min(b - a, budget);
      // 額度不夠整段：這段後面緊接著核定時段、前面沒接 → 取靠核定那頭（2026-11-18 驗收 MZTMC01 11/01：取前頭會在同一段打卡中間留洞，打卡端判少打卡）
      const tail = take < b - a && core.some((x) => x[0] === b) && !core.some((x) => x[1] === a);
      freeExtra.push(tail ? [b - take, b] : [a, a + take]); budget -= take;
    }
    freeExtra = merge(freeExtra);
    core = merge(core.concat(freeExtra));
  }

  // 4. 不打卡休息帶：核定時段蓋過休息帶就拆開（同現在的預填）
  if (BRKcut.length) core = minus(core, BRKcut);
  else if (BRK.length) core = merge(intersect(core, S).concat(minus(minus(core, S), BRK)));      // 半天班：班表裡不扣，班表外多出來的照扣
  if (RESTS.length) core = minus(core, RESTS);
  core = merge(core);
  if (!core.length && lvAll) return [{ periods: [], hours: 0, notes, late: 0, early: 0, over: [], overMin: 0, leaveOver: 0 }, []];      // 照假單登記、上班時段空（2026-11-18 驗收：原本回 null 不預填）
  if (!core.length) return [null, []];

  // 5. 給主管看的說明
  const FREE = merge(A.concat(freeExtra));
  // 不打卡休息帶（央廚 12–13、總部 14–15）：中間沒打下班卡照樣是休息，不算多出來的時段（2026-11-16 Eason：吳佳宜 08:25–17:42 被要求補 12:15–12:45 加班單）
  const WnoBrk = minus(Wraw, BRK.concat(LV));      // 請假時段裡的打卡照假單算，不算「多出來要加班單」
  if (otOnly) notes.push('這天沒有班表：照打卡算，已核准加班單 ' + OT.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + ' 是其中的加班時段（跨店同一天合計超過 8 小時的部分照加班歸屬由這家吸收）');
  for (const x of (otOnly ? [] : minus(WnoBrk, FREE.length ? FREE : WnoBrk))) if (x[1] - x[0] > TOL) notes.push(toHm(x[0]) + '–' + toHm(x[1]) + ' 超過當天 8 小時、沒有加班單，不算');
  const freeMin = total(freeExtra);
  if (freeMin > 0) notes.push('班表外多做 ' + Math.round(freeMin / 6) / 10 + ' 小時（全天合計沒超過 8 小時，不用加班單）');
  for (const x of raw) if (x.fromReq.out && S.length && x.out != null && x.out > S[S.length - 1][1] + TOL && !OT.some((y) => x.out <= y[1] + TOL)) {
    const tail = '–' + toHm(x.out) + ' 超過當天 8 小時、沒有加班單，不算';
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].endsWith(tail)) notes.splice(i, 1);      // 同一段改用忘打卡單的說法，不重複
    notes.push('忘打卡單 ' + toHm(x.out) + ' 超過班表，只算到 ' + toHm(S[S.length - 1][1]));
  }
  const extra = total(minus(minus(core, S), freeExtra));
  if (S.length && extra > 0 && OT.length) notes.push('比班表多 ' + Math.round(extra / 6) / 10 + ' 小時（已核准加班單）');
  if (late > 0) notes.push('遲到 ' + late + ' 分（薪資照扣）');
  if (stopEarly > 0) notes.push('早退 ' + stopEarly + ' 分（請假前提早走，薪資照扣）');
  if (schedEarly > 0) notes.push('早退 ' + schedEarly + ' 分（這段班提早走，薪資照扣）');      // 多段班中間那段的結尾（2026-11-18）      // 2026-11-18：核定補到假單開始，打卡端照記早退 N 分

  // 超過當天 8 小時、又不在加班單裡的打卡時段；沒班表也沒加班單時不算（打卡端會要加班單）。
  // 2026-11-16 Eason：「時段的認定是以 15 分鐘為一單位，上班前 15 分鐘打卡跟下班後 15 分鐘打卡都不算在薪資內」
  //   → 緊接在班表或已核准加班單前後的那 15 分鐘先扣掉（「滿 8 小時」那個點不是上下班，不扣），剩下的再往內取整到 15 分，不到 15 分的整段不列。
  //   例 班表 12:00–16:00、18:00–22:15，打卡 11:58–16:19、17:54–22:20 → 0 分（原本照實際打卡算 32 分、被擋）。
  const outside = A.length && !otOnly ? overUnits(minus(WnoBrk, FREE), A.concat(BRK)) : [];
  const over = outside.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
  const overMin = total(outside);
  const periods = core.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
  // 假單沒填時段、上班＋假單比班表多（2026-11-18 第 5 題）：只提醒、不擋。班表＝扣不打卡休息帶與班別休息；加班單那段不算
  let leaveOver = 0;
  if (untimedLeave && S.length) leaveOver = Math.max(0, Math.round(total(minus(core, OT)) + leaveMin - total(minus(minus(S, BRKcut), RESTS))));
  return [{ periods, hours: Math.round(total(core) / 60 * 100) / 100, notes, late: late + gapLate + restLate, early, over, overMin, leaveOver, gapLate, restLate }, fragPins(core, bounds, BRK)];
}

/** 取整碎段（見 corePeriods）：最後的核定時段裡，不到 15 分、一頭是「卡取整出來的點」（不是任何邊界）的那段，
 *  從取整那頭往裡找最近的邊界（班表、加班單、假單、休息帶的起訖）→ 回 [{ key: 'o'+下班卡分鐘 | 'i'+上班卡分鐘, to: 改對到的邊界, p, q: 碎段起訖 }]。
 *  另一頭是班別休息（break_min）照實扣的卡、或 8 小時額度剛好用完的點，裡面又沒有邊界的，不在這裡處理（跟取整無關，改之前就有）。 */
function fragPins(core, bounds, BRK) {
  const B = new Set(bounds.st.concat(bounds.en).flat().concat(BRK.flat().map((x) => x + 1440)));
  const res = [];
  for (const [p, q] of core) {
    if (!(q - p > 0 && q - p < TOL)) continue;
    const inner = [...B].filter((x) => x >= p && x <= q);
    if (bounds.fb.o.has(q) && !B.has(q)) { const x = inner.filter((y) => y < q); if (x.length) for (const t of bounds.fb.o.get(q)) res.push({ key: 'o' + t, to: Math.max(...x), p, q }); }
    if (bounds.fb.i.has(p) && !B.has(p)) { const x = inner.filter((y) => y > p); if (x.length) for (const t of bounds.fb.i.get(p)) res.push({ key: 'i' + t, to: Math.min(...x), p, q }); }
  }
  return res;
}

/** 超出的打卡時段 → 要加班單的時段：接在班表／加班單（bounds）後面的開頭、前面的結尾各扣 15 分寬限，再往內取整到 15 分，不到 15 分不列 */
/** 第 5 題提醒字句：「上班＋假單比班表多 2 小時（假單沒填時段，請確認上班時段或假單時數）」；沒有回 '' */
export function leaveOverText(pr) {
  const m = pr && Number(pr.leaveOver);
  return m > 0 ? '上班＋假單比班表多 ' + Math.round(m / 60 * 100) / 100 + ' 小時（假單沒填時段，請確認上班時段或假單時數）' : '';
}
function overUnits(list, bounds) {
  const ends = new Set(bounds.map((x) => x[1])), starts = new Set(bounds.map((x) => x[0])), out = [];
  for (const [a0, b0] of list) {
    const a = Math.ceil((ends.has(a0) ? a0 + TOL : a0) / TOL) * TOL, b = Math.floor((starts.has(b0) ? b0 - TOL : b0) / TOL) * TOL;
    if (b - a >= TOL) out.push([a, b]);
  }
  return out;
}

export const _t = { toMin, toHm, merge, intersect, minus };
