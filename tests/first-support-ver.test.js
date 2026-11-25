/* 首次支援的人在 Mac mini 核定一直回 stale_ver（2026-11-24 修）。
 *
 * 起因：mgr_day 的 first_support（Code.gs：名冊 created_by＝FIRST_SUPPORT_CREATED_BY 且從沒核定過）會進版本號（DutyFeed.gs dutyVerOf_ 的 fs）。
 *   mini 核定引擎跑同一份程式，但讀的是 relay_pull 給的名冊副本；舊版 RelayG.gs 的名冊白名單沒有 created_by →
 *   mini 一律算 fs=false、Google 算 fs=true → 主管畫面拿到的（Google）版本跟 mini 重算的永遠不同 → mini 回 stale_ver，怎麼按都核不過。
 * 修法：relay_pull 的名冊只在「建立人剛好是首次支援記號」那幾列帶 created_by（＝記號原字串）；其他建立人照審查 D1 不帶。
 *
 * 這支測：用真函式組兩邊——「Google」＝試算表本身；「mini 副本」＝名冊換成 relay_pull 給的那份（JSON 來回一次、表頭照 mini to2d 的鍵順序），
 *   其他分頁原樣複製（只隔離名冊這一條路；其餘分頁的同步另有 relay-g、P3-1 測試與 mini 端測試）。
 *   ① 舊 RelayG.gs（PR 前的主線 64c9b52，固定基準；取不到就失敗、不跳過）重現問題：首次支援那位兩邊版本不同、核定回 stale_ver；
 *   ② 新 RelayG.gs：每一位兩邊版本相同、核定通過；核定後 first_support 消失、兩邊仍相同；
 *   ③ 一般帳號：版本與名冊回應跟舊版逐位元組相同（新回應拿掉 created_by 那格＝舊回應）；其他建立人（主管姓名、管理系統帳號）完全不出現。
 * 名字一律假名、金鑰假的。 */
'use strict';
const cp = require('child_process');
const vm = require('vm');
const { make, T, check, done, R, ROOT } = require('./helpers/gs-sandbox');

const KEY = 'relay-key-for-tests-0123456789';
const MARK = 'LINE 自動（首次支援）';
const DAY = '2026-11-20';
const BASE_SHORT = '64c9b52', BASE_SHA1 = '5a254d45bef2';              // PR 前主線的 RelayG.gs（九店服務中那份，sha1 前 12 碼）

function baseRelayG() {
  let src;
  try { src = cp.execFileSync('git', ['-C', ROOT, 'show', BASE_SHORT + ':apps-script/RelayG.gs'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { src = null; }
  const h = src ? require('crypto').createHash('sha1').update(src, 'utf8').digest('hex').slice(0, 12) : null;
  check('FS0', '取得改動前的 RelayG.gs（' + BASE_SHORT + '，sha1 ' + BASE_SHA1 + '；取不到就失敗、不跳過）', h, BASE_SHA1);
  if (!src) done();
  return src;
}

// 一般同仁（主管自助開的、管理系統開的、沒填的）＋首次支援（LINE 自動加入）＋記號前後多一個空白（不算記號）
const ROSTER = [
  { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1', created_by: '店長甲', created_at: '2026-10-01T09:00:00+08:00' },
  { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2', created_by: MARK, created_at: '2026-11-20T11:20:00+08:00' },
  { emp_id: 'E03', name: '測試三', key: 'K3', device_id: 'D3', active: 'TRUE', line_user_id: '', created_by: '管理系統:abc001' },
  { emp_id: 'E04', name: '測試四', key: 'K4', device_id: 'D4', active: 'TRUE', line_user_id: 'U4', created_by: ' ' + MARK },
  { emp_id: 'E05', name: '測試五', key: 'K5', device_id: 'D5', active: 'TRUE', line_user_id: 'U5' },
];
const EVENTS = [
  [DAY + 'T09:00:00', 'E01', 'in'], [DAY + 'T17:00:00', 'E01', 'out'],
  [DAY + 'T11:22:00', 'E02', 'in'], [DAY + 'T15:35:00', 'E02', 'out'], [DAY + 'T16:53:00', 'E02', 'in'], [DAY + 'T21:06:00', 'E02', 'out'],
  [DAY + 'T10:00:00', 'E03', 'in'], [DAY + 'T18:00:00', 'E03', 'out'],
  [DAY + 'T10:00:00', 'E04', 'in'], [DAY + 'T18:00:00', 'E04', 'out'],
  [DAY + 'T10:00:00', 'E05', 'in'], [DAY + 'T18:00:00', 'E05', 'out'],
];
const PROPS = { REQ_BIND_FROM: 'off', REQ_CARD_REASON_FROM: 'off', RELAY_KEY: KEY };

/** 「Google」：試算表本身＋指定那一版 RelayG.gs */
function google(relaySrc) {
  const m = make({ now: T('2026-11-21T10:00:00'), props: Object.assign({}, PROPS), self: { roster: ROSTER, events: EVENTS } });
  m.run(relaySrc);
  return m;
}
/** 「mini 副本」：名冊＝relay_pull 給的那份（表頭照 mini duty-worker to2d：鍵出現的順序、__row 拿掉、名冊值原樣），其他分頁原樣複製 */
function replica(g, pulledRoster) {
  const m = make({ now: T('2026-11-21T10:00:00'), props: Object.assign({}, PROPS), self: { roster: [], events: [] } });
  // 假試算表的函式抓的是原本那個陣列：就地換內容（不換掉陣列本身）
  const put = (nm, vals) => { const a = m.self.sh[nm].values; a.length = 0; vals.forEach((r) => a.push(r)); };
  ['events', 'approved', 'leave', 'managers'].forEach((nm) => put(nm, JSON.parse(JSON.stringify(g.self.sh[nm].values))));
  const rows = JSON.parse(JSON.stringify(pulledRoster)).map((r) => { delete r.__row; return r; });
  const heads = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (heads.indexOf(k) < 0) heads.push(k); }));
  put('roster', [heads].concat(rows.map((r) => heads.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h])))));
  return m;
}
const pull = (g) => g.sb.handleRelayPull_({ relay_key: KEY, with: { roster: true } });
const day = (m) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_day', mgr_key: 'AK', date: DAY, with_ver: true }) } }).text);
const vers = (m) => { const o = {}; day(m).employees.forEach((e) => { o[e.emp_id] = e.ver; }); return o; };
const fsOf = (m) => day(m).employees.filter((e) => e.first_support).map((e) => e.emp_id);
const approve = (m, emp, ver, periods) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_approve', mgr_key: 'MK', date: DAY, emp_id: emp,
  periods: periods, base_ver: ver }) } }).text);
const P2 = [{ start: '11:30', end: '15:30' }, { start: '17:00', end: '21:00' }];   // 首次支援那位：兩段各 4 小時
const sameKeys = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

const OLD = baseRelayG();
const NEW = R('apps-script/RelayG.gs');

// ── ① 舊版重現問題 ──
const gOld = google(OLD);
const vG = vers(gOld);
check('FS1', 'Google：只有 E02（LINE 自動加入、沒核定過）是首次支援；記號前多空白的 E04 不算', fsOf(gOld), ['E02']);
const rOld = replica(gOld, pull(gOld).roster);
check('FS2', '舊 RelayG：名冊副本沒有 created_by、mini 算不出首次支援', [pull(gOld).roster.some((x) => 'created_by' in x), fsOf(rOld)], [false, []]);
check('FS3', '舊 RelayG：只有 E02 兩邊版本不同（＝這次的問題）', sameKeys(vG, vers(rOld)), ['E02']);
const aOld = approve(rOld, 'E02', vG.E02, P2);
check('FS4', '舊 RelayG：拿畫面（Google）的版本在 mini 核定 → stale_ver、不寫入', [aOld.ok, aOld.error, rOld.approved().length], [false, 'stale_ver', 0]);

// ── ② 新版：兩邊一致、核定通過、核定後仍一致 ──
const gNew = google(NEW);
check('FS5', '新 RelayG 不改 Google 自己算的版本（每一位都跟舊版 Google 相同）', sameKeys(vG, vers(gNew)), []);
const pNew = pull(gNew);
const rNew = replica(gNew, pNew.roster);
check('FS6', '新 RelayG：名冊只有 E02 帶 created_by、值＝記號原字串', pNew.roster.filter((x) => 'created_by' in x).map((x) => [x.emp_id, x.created_by]), [['E02', MARK]]);
check('FS7', '新 RelayG：mini 副本算出的首次支援＝Google（只有 E02）', fsOf(rNew), ['E02']);
check('FS8', '新 RelayG：每一位兩邊版本都相同', sameKeys(vG, vers(rNew)), []);
const check1 = (m) => { const j = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_approve_check', mgr_key: 'MK', date: DAY,
  items: [{ emp_id: 'E02', periods: P2, base_ver: vG.E02 }] }) } }).text); const x = (j.results || [])[0] || {}; return [j.ok, x.ok, x.error, x.approved_hours]; };
check('FS9', '新 RelayG：mini 副本的核定前檢查＝Google 的（通過、8 小時）', [check1(rNew), check1(gNew)], [[true, true, undefined, 8], [true, true, undefined, 8]]);
const aNew = approve(rNew, 'E02', vG.E02, P2);
check('FS10', '新 RelayG：拿畫面（Google）的版本在 mini 核定 → 通過、8 小時', [aNew.ok, aNew.error, aNew.approved_hours], [true, undefined, 8]);
// mini 核定後寫回 Google（同一筆、同一個 base_ver）：Google 也通過；之後重新同步名冊
const aG = approve(gNew, 'E02', vG.E02, P2);
check('FS11', 'Google 收到同一筆（同一個版本）也通過', [aG.ok, aG.error, aG.approved_hours], [true, undefined, 8]);
const rAfter = replica(gNew, pull(gNew).roster);
check('FS12', '核定後：兩邊的首次支援都消失', [fsOf(gNew), fsOf(rAfter)], [[], []]);
check('FS13', '核定後：每一位兩邊版本仍相同（E02 的版本換了）', [sameKeys(vers(gNew), vers(rAfter)), vers(gNew).E02 !== vG.E02], [[], true]);
const again = approve(rAfter, 'E02', vG.E02, P2);
check('FS14', '核定後拿舊版本再核 → 照樣 stale_ver（版本檢查沒被放寬）', [again.ok, again.error], [false, 'stale_ver']);

// ── ③ 一般帳號逐位元組不變、其他建立人不出現 ──
const strip = (r) => { const o = JSON.parse(JSON.stringify(r)); o.roster.forEach((x) => { delete x.created_by; }); return JSON.stringify(o); };
check('FS15', '新回應拿掉 created_by 那格＝舊回應（逐位元組）', strip(pNew) === JSON.stringify(pull(gOld)), true);
check('FS16', '一般帳號（E01、E03、E04、E05）的版本：新舊副本逐位元組相同', ['E01', 'E03', 'E04', 'E05'].map((e) => vers(rNew)[e] === vers(rOld)[e]), [true, true, true, true]);
const txt = JSON.stringify(pNew);
check('FS17', '主管姓名、管理系統帳號、建立時間不出現在回應', ['店長甲', '管理系統:abc001', 'created_at', 'removed_by'].map((s) => txt.indexOf(s) >= 0), [false, false, false, false]);

// ── ④ 這家店的 程式碼.js 沒有記號常數：跟改之前一樣不帶 ──
const fn = gNew.sb.relayGFirstSupportMark_.toString();
const bare = vm.createContext({ String });
vm.runInContext(fn, bare);
check('FS18', '沒有 FIRST_SUPPORT_CREATED_BY 常數：一律不帶（null）', [vm.runInContext('relayGFirstSupportMark_(' + JSON.stringify(MARK) + ')', bare), vm.runInContext('relayGFirstSupportMark_("x")', bare)], [null, null]);
check('FS19', '有常數：只認完全相同的字串（前後空白、其他值、空白、undefined 都不算）',
  [MARK, ' ' + MARK, MARK + ' ', '店長甲', '', undefined, null].map((v) => gNew.sb.relayGFirstSupportMark_(v)), [MARK, null, null, null, null, null, null]);

// ── ⑤ 打卡不受影響：新舊 RelayG 下同一張 LINE 打卡（liff_punch）結果相同 ──
const punch = (g) => JSON.parse(g.sb.doPost({ postData: { contents: JSON.stringify({ action: 'liff_punch', id_token: 'TOK_U2', type: 'in', lat: 24.7840945, lng: 121.0157448, accuracy: 10 }) } }).text);
const g1 = google(OLD), g2 = google(NEW);
g1.setNow(T('2026-11-21T11:00:00')); g2.setNow(T('2026-11-21T11:00:00'));
const p1 = punch(g1), p2 = punch(g2);
check('FS20', 'LINE 打卡：新舊 RelayG 回應與寫入的打卡列相同（打卡成功）', [JSON.stringify(p1) === JSON.stringify(p2), JSON.stringify(g1.events()) === JSON.stringify(g2.events()), p1.ok, g2.events().length], [true, true, true, EVENTS.length + 1]);
done();
