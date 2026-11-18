/* 考勤異常提醒的動態狀態不再每天新增指令碼屬性（2026-11-18）：
 * 光復屬性超過 50 個讓編輯器變唯讀，元兇是 ATT_RUN_<日期>／ATT_BATCH_<批次>／ATT_EVT_<事件>。
 * 新版只寫 ATT_STATE_RUN／ATT_STATE_BATCH／ATT_STATE_EVT 三個 JSON 屬性（鎖內讀改寫、寫入時自己修剪）。
 * 驗：冪等不變弱、併發、讀不到退安全側、承接舊屬性、清理只刪過期、遷移（dry-run／Go）、模擬 60 天屬性數不成長。
 * 用真函式跑，名稱與值都是假的（光復實際屬性「名稱」取自 2026-11-18 Eason 列出的清單，值全部是假字串）。 */
'use strict';
const { make, T, check, done, R } = require('./helpers/gs-sandbox');

const FIXED = ['ATT_ALERT_SVC_KEY', 'ATT_ARCHIVE_LAST', 'ATT_GROUP_ID', 'ATT_JOIN_LAST', 'BULLETIN_PUSH_KEY', 'DZY_LINE_LIFF_URL', 'G_PRIMARY', 'G_RECON',
  'LINE_MAP_KEY', 'LINE_MAP_KID', 'NOTIFY_INBOX_TOKEN', 'NOTIFY_INBOX_URL', 'PNL_KEY', 'QR_SECRET', 'QR_STORE', 'REFRESH_CURRENT_MONTH_LAST_APPROVED_ROW',
  'REFRESH_CURRENT_MONTH_LAST_LEAVE_ROW', 'REFRESH_CURRENT_MONTH_LAST_ROW', 'RELAY_KEY', 'REQ_ATTACH_FOLDER', 'REQ_UPPER_EMPS', 'REQ_UPPER_ON', 'REST_CAP_ON',
  'REST_RULE_ON', 'SCHED_READ_KEY', 'SCHED_SVC_KEY', 'STAFF_HUB_KEY', 'STAFF_HUB_URL', 'STAFF_SVC_KEY', 'REQ_SEG2_KINDS'];
const GROUP = 'Cgroup0001';
const INBOX = 'https://inbox.example.test/exec';

function fixedProps() {
  const o = {};
  FIXED.forEach((k) => { o[k] = 'fake-' + k.toLowerCase(); });
  o.ATT_ALERT_SVC_KEY = 'SVC'; o.ATT_GROUP_ID = GROUP; o.ATT_JOIN_LAST = '[]'; o.ATT_ARCHIVE_LAST = '2026-11-18'; o.NOTIFY_INBOX_URL = INBOX;
  return o;
}
/** 光復 2026-11-18 的 26 個舊式屬性（名稱照清單；值是舊程式會寫的格式，內容假的） */
function legacyGf() {
  const o = {};
  for (let d = 7; d <= 18; d++) o['ATT_RUN_2026-11-' + String(d).padStart(2, '0')] = 'received';
  [7, 11, 12, 13, 14, 15, 16, 17, 18].forEach((d) => { const dd = String(d).padStart(2, '0'); o[`ATT_BATCH_2026-11-${dd}-${('ab' + dd).repeat(3)}`] = `2026-11-${dd}T08:5${d % 10}:00+08:00`; });
  o['ATT_BATCH_comp-2026-11-18'] = '2026-11-18T08:51:00+08:00';
  o['ATT_BATCH_notice-cap10-20261114'] = '2026-11-14T17:54:00+08:00';
  o['ATT_BATCH_notice-cap10-20261114b'] = '2026-11-14T17:59:00+08:00';
  o['ATT_BATCH_notice-cap10-20261114c'] = '2026-11-14T23:38:00+08:00';
  o.ATT_EVT_01M7PMJG00SDF79DKDY9YH4Q82 = String(T('2026-11-18T20:00:00'));
  return o;
}

function world(now, props, opt) {
  opt = opt || {};
  const m = make({ now: T(now), props, fetch: (url) => {
    if (url.indexOf('/message/reply') >= 0) { m2.replies++; return {}; }
    if (url === INBOX) return { ok: true, added: true };
    return undefined;
  } });
  const m2 = m; m2.replies = 0; m2.logs = [];
  m.run(R('apps-script/AttAlert.gs'));
  m.run('var LINE_HUB_BOT_TOKEN = "BOT_FAKE";');
  const qs = m.sb.attAlertSheet_();   // 共用假表沒有 deleteRows（封存會用）：補上
  if (!qs.deleteRows) qs.deleteRows = (r, n) => { qs.values.splice(r - 1, n); };
  m.sb.Logger = { log: (x) => m2.logs.push(String(x)) };
  // 真正互斥的鎖（同一時間只有一個執行持有）；opt.busy() 回 true 時模擬「別人正拿著」
  const lock = { held: false };
  m.sb.LockService = { getScriptLock: () => ({
    tryLock: () => { if (lock.held || (opt.busy && opt.busy())) return false; lock.held = true; return true; },
    waitLock: () => { if (lock.held) throw new Error('timeout'); lock.held = true; },
    releaseLock: () => { lock.held = false; },
  }) };
  m.lock = lock;
  return m;
}
const S = (m) => m.sb;
const enq = (m, o) => S(m).handleAttAlertEnqueue(Object.assign({ svcKey: 'SVC' }, o));
const rows = (m) => S(m).attAlertReadRows_(S(m).attAlertSheet_());
const st = (m, n) => JSON.parse(m.props[n] || '{}');
const msg = (id) => ({ type: 'message', replyToken: 'RT-' + id, webhookEventId: id, source: { type: 'group', groupId: GROUP, userId: 'Ux' }, message: { type: 'text', text: '早安' } });
const say = (m, id) => S(m).attAlertOnEvent_(msg(id));
const legacyKeys = (m) => Object.keys(m.props).filter((k) => /^ATT_(RUN|BATCH|EVT)_/.test(k)).sort();
const dailyBatch = (d, h) => ({ run_date: d, batch_id: d + '-' + (h || 'aaaaaaaaaaaa'), seq: 1, daily: [{ store: '小辛辣光復', lines: ['王小明 ' + d.slice(5) + ' 出勤 11 小時（超過 10）'] }], state: [], sched: [], failed_stores: [] });

// ── 1. 同一批次重送只成立一次（佇列列已封存後也一樣）──
{
  const m = world('2026-11-19T08:55:00', fixedProps());
  const b = dailyBatch('2026-11-19');
  check('ST01', '第一次寄放成立、只寫在 ATT_STATE_*（不新增 ATT_RUN_／ATT_BATCH_）', [enq(m, b), legacyKeys(m), st(m, 'ATT_STATE_RUN')['2026-11-19'], typeof st(m, 'ATT_STATE_BATCH')[b.batch_id]],
    [{ ok: true }, [], 'received', 'number']);
  check('ST02', '同一批再送 → dup、不多寫列', [enq(m, b), rows(m).length], [{ ok: true, dup: true }, 1]);
  say(m, 'E1');
  m.setNow('2026-11-27T10:00:00'); m.props.ATT_ARCHIVE_LAST = 'x'; S(m).attAlertGuard();
  check('ST03', '8 天後已帶出的列被封存刪掉', rows(m).filter((r) => r.batch_id === b.batch_id).length, 0);
  check('ST04', '同一批第三次送（列已不在）→ 靠 ATT_STATE_BATCH 仍回 dup、不重寫', [enq(m, b), rows(m).filter((r) => r.batch_id === b.batch_id).length], [{ ok: true, dup: true }, 0]);
  const e = { run_date: '2026-11-27', batch_id: '2026-11-27-eeeeeeeeeeee', seq: 1, empty: true };
  check('ST05', 'empty 批（不寫列）重送也只成立一次', [enq(m, e), enq(m, e), st(m, 'ATT_STATE_RUN')['2026-11-27']], [{ ok: true }, { ok: true, dup: true }, 'empty']);
  const c = { run_date: '2026-11-27', batch_id: 'comp-2026-11-27', seq: 5, comp: ['【加班補休】甲'] };
  check('ST06', 'comp 批重送只成立一次', [enq(m, c), enq(m, c), rows(m).filter((r) => r.section === 'comp').length], [{ ok: true }, { ok: true, dup: true }, 1]);
}

// ── 2. 同一事件重送只處理一次 ──
{
  const m = world('2026-11-19T09:00:00', fixedProps());
  enq(m, dailyBatch('2026-11-19'));
  say(m, 'EVA');
  check('ST07', '第一次事件帶出、記進 ATT_STATE_EVT（不新增 ATT_EVT_）', [m.replies, typeof st(m, 'ATT_STATE_EVT').EVA, legacyKeys(m)], [1, 'number', []]);
  enq(m, dailyBatch('2026-11-19', 'bbbbbbbbbbbb'));
  say(m, 'EVA');
  check('ST08', '同一事件重送（LINE redelivery）→ 不再帶出，新寄放的列留著 pending', [m.replies, rows(m).filter((r) => r.status === 'pending').length > 0], [1, true]);
  say(m, 'EVB');
  check('ST09', '下一個不同事件才帶出', m.replies, 2);
  m.setNow('2026-11-20T09:01:00'); enq(m, dailyBatch('2026-11-20')); say(m, 'EVA');
  check('ST10', '24 小時內同一事件 id 一律不處理', m.replies, 2);
}

// ── 3. 併發：鎖內讀改寫，別人拿著鎖時不寫、不帶出，之後重試不遺失 ──
{
  const m = world('2026-11-19T09:00:00', fixedProps());
  const sb = S(m);
  const origAppend = sb.attAlertAppend_;
  let nested = null;
  sb.attAlertAppend_ = function (sh, matrix) {   // enqueue 寫分頁的當下，另一個執行（webhook／另一批 enqueue／保底）同時進來
    if (!nested) {
      nested = {
        evt: (say(m, 'EVX'), m.replies),
        enq2: enq(m, dailyBatch('2026-11-19', 'cccccccccccc')),
      };
      m.setNow('2026-11-19T09:31:00'); sb.attAlertGuardWindow_(new sb.Date()); m.setNow('2026-11-19T09:00:00');
      nested.guardRows = rows(m).filter((r) => r.section === 'guard').length;
    }
    return origAppend(sh, matrix);
  };
  m.props.ATT_HAS_PENDING = '1';   // 讓 webhook 真的走到搶鎖那一步
  enq(m, dailyBatch('2026-11-19'));
  sb.attAlertAppend_ = origAppend;
  check('ST11', '同時進來的 webhook 拿不到鎖：不帶出、不記事件', [nested.evt, st(m, 'ATT_STATE_EVT').EVX], [0, undefined]);
  check('ST12', '同時進來的另一批 enqueue 回 busy、什麼都沒寫', [nested.enq2, st(m, 'ATT_STATE_BATCH')['2026-11-19-cccccccccccc']], [{ ok: false, error: 'busy' }, undefined]);
  check('ST13', '同時進來的 09:30 保底拿不到鎖：不寫 guard', nested.guardRows, 0);
  check('ST14', '原本那批完整寫入（狀態＋批次記錄）', [st(m, 'ATT_STATE_RUN')['2026-11-19'], typeof st(m, 'ATT_STATE_BATCH')['2026-11-19-aaaaaaaaaaaa']], ['received', 'number']);
  check('ST15', 'mini 重試被 busy 的那批 → 成立，兩批記錄都在（沒有互相蓋掉）', [enq(m, dailyBatch('2026-11-19', 'cccccccccccc')), Object.keys(st(m, 'ATT_STATE_BATCH')).sort()],
    [{ ok: true }, ['2026-11-19-aaaaaaaaaaaa', '2026-11-19-cccccccccccc']]);
  say(m, 'EVX');
  check('ST16', 'webhook 之後再來（同一事件 id 先前沒記）→ 正常帶出一次', [m.replies, typeof st(m, 'ATT_STATE_EVT').EVX], [1, 'number']);
  const m2 = world('2026-11-19T09:40:00', fixedProps(), { busy: () => true });
  S(m2).attAlertGuardWindow_(new (S(m2).Date)());
  check('ST17', '鎖一直被佔：保底不寫 guard、不改狀態（下個 5 分鐘再來）', [rows(m2).length, m2.props.ATT_STATE_RUN], [0, undefined]);
}

// ── 4. 儲存讀不到 → 安全側（不寄放、不帶出、不寫保底），並通知 ──
{
  const m = world('2026-11-19T09:00:00', fixedProps());
  enq(m, dailyBatch('2026-11-19'));
  m.props.ATT_STATE_EVT = '{壞掉';
  say(m, 'EVQ');
  check('ST18', 'ATT_STATE_EVT 壞掉：不帶出、列維持 pending、記一則通知', [m.replies, rows(m).every((r) => r.status === 'pending'), JSON.parse(m.props.ATT_OUTBOX || '[]').map((x) => x.key)],
    [0, true, ['state-bad:2026-11-19']]);
  m.props.ATT_STATE_EVT = '[1,2]';
  say(m, 'EVQ2');
  check('ST19', 'ATT_STATE_EVT 是陣列（不是物件）也當壞掉：不帶出', m.replies, 0);
  m.props.ATT_STATE_BATCH = 'oops';
  const n0 = rows(m).length;
  check('ST20', 'ATT_STATE_BATCH 壞掉：enqueue 回 state_unreadable、不寫列（mini 會重試，不會重複寄放）', [enq(m, dailyBatch('2026-11-19', 'dddddddddddd')), rows(m).length], [{ ok: false, error: 'state_unreadable' }, n0]);
  const g = world('2026-11-19T09:35:00', fixedProps());
  g.props.ATT_STATE_RUN = 'oops';
  S(g).attAlertGuard();
  check('ST21', 'ATT_STATE_RUN 壞掉：09:30 保底不寫 guard、start 回錯', [rows(g).length, S(g).handleAttAlertStart({ svcKey: 'SVC', run_date: '2026-11-19' })], [0, { ok: false, error: 'state_unreadable' }]);
  const t = world('2026-11-19T09:00:00', fixedProps());
  enq(t, dailyBatch('2026-11-19'));
  const pp = S(t).PropertiesService.getScriptProperties();
  S(t).PropertiesService = { getScriptProperties: () => Object.assign({}, pp, { getProperty: (k) => { if (k === 'ATT_STATE_EVT') throw new Error('服務暫時無法使用'); return pp.getProperty(k); } }) };
  let threw = false; try { say(t, 'EVT9'); } catch (e) { threw = true; }
  check('ST22', '讀屬性丟例外：丟給呼叫端（LineHub 各事件 try/catch）、沒有帶出', [threw, t.replies, rows(t).every((r) => r.status === 'pending')], [true, 0, true]);
}

// ── 5. 承接舊屬性（上線當天光復還留著 ATT_RUN_／ATT_BATCH_／ATT_EVT_）──
{
  const props = Object.assign(fixedProps(), legacyGf());
  const m = world('2026-11-18T21:00:00', props);
  const old = { run_date: '2026-11-18', batch_id: '2026-11-18-ab18ab18ab18', seq: 1, daily: [{ store: '小辛辣光復', lines: ['x'] }], state: [], sched: [], failed_stores: [] };
  check('ST23', '舊屬性記過的批次重送 → dup、不寫列', [enq(m, old), rows(m).length], [{ ok: true, dup: true }, 0]);
  check('ST24', '舊屬性記過的 comp-／notice- 批次重送 → dup', [enq(m, { run_date: '2026-11-18', batch_id: 'comp-2026-11-18', comp: ['甲'] }), enq(m, { run_date: '2026-11-14', batch_id: 'notice-cap10-20261114c', notice: ['甲'] })],
    [{ ok: true, dup: true }, { ok: true, dup: true }]);
  check('ST25', '舊屬性當天已 received：start 不改回 running、保底不寫 guard', [S(m).handleAttAlertStart({ svcKey: 'SVC', run_date: '2026-11-18' }), (S(m).attAlertGuard(), rows(m).length), st(m, 'ATT_STATE_RUN')['2026-11-18']],
    [{ ok: true }, 0, undefined]);
  enq(m, dailyBatch('2026-11-18', 'ffffffffffff'));
  say(m, '01M7PMJG00SDF79DKDY9YH4Q82');
  check('ST26', '舊屬性記過的事件重送 → 不帶出', m.replies, 0);
  say(m, 'NEWEVENT');
  check('ST27', '新事件照常帶出', m.replies, 1);
  const e = world('2026-11-19T09:00:00', Object.assign(fixedProps(), { 'ATT_RUN_2026-11-19': 'empty' }));
  enq(e, { run_date: '2026-11-18', batch_id: '2026-11-18-zzzzzzzzzzzz', seq: 1, daily: [{ store: '小辛辣光復', lines: ['甲 11/17 出勤 11 小時（超過 10）'] }], state: [], sched: [], failed_stores: [] });
  check('ST28', '組字承接舊屬性的 empty 日（標題區間含那天，版面不變）', S(e).attAlertCompose_(rows(e), {})[0].split('\n')[0], '【考勤異常】11/18–11/19');
}

// ── 6. 清理只刪過期的（保底觸發器，每 5 分鐘）──
{
  const now = '2026-12-10T10:00:00';
  const props = Object.assign(fixedProps(), {
    ATT_EVT_old: String(T('2026-12-08T09:00:00')), ATT_EVT_new: String(T('2026-12-10T08:00:00')),
    'ATT_RUN_2026-11-20': 'received', 'ATT_RUN_2026-11-30': 'received',
    'ATT_BATCH_2026-11-20-aaaaaaaaaaaa': '2026-11-20T08:50:00+08:00', 'ATT_BATCH_2026-12-05-aaaaaaaaaaaa': '2026-12-05T08:50:00+08:00',
    'ATT_BATCH_comp-2026-11-20': '2026-11-20T08:51:00+08:00', 'ATT_BATCH_comp-2026-12-01': '2026-12-01T08:51:00+08:00',
    'ATT_BATCH_notice-cap10-20261114': '2026-11-14T17:54:00+08:00', 'ATT_BATCH_notice-x-20261120': '壞值', 'ATT_BATCH_notice-nodate': '壞值',
    ATT_VERDICT_E5: JSON.stringify({ eventId: 'E5', verdict: 'delivered', at: T('2026-12-10T09:59:00') }),
  });
  const m = world(now, props);
  m.lock.held = true;   // 讓補寫結果拿不到鎖，只看清理
  S(m).attAlertCleanProps_(new (S(m).Date)());
  m.lock.held = false;
  check('ST29', '過期的舊屬性刪掉（事件 1 天；狀態／批次 14 天，含 comp-、notice-；值壞掉看名稱日期）', legacyKeys(m),
    ['ATT_BATCH_2026-12-05-aaaaaaaaaaaa', 'ATT_BATCH_comp-2026-12-01', 'ATT_BATCH_notice-nodate', 'ATT_EVT_new', 'ATT_RUN_2026-11-30']);
  check('ST30', '固定設定一個都沒動、ATT_VERDICT_ 不歸清理管', [FIXED.every((k) => m.props[k] === props[k]), !!m.props.ATT_VERDICT_E5], [true, true]);
  const w = world('2026-11-19T09:00:00', Object.assign(fixedProps(), { ATT_STATE_RUN: JSON.stringify({ '2026-10-01': 'received', '2026-11-05': 'received', '2026-11-04': 'empty' }),
    ATT_STATE_BATCH: JSON.stringify({ old: T('2026-11-04T08:00:00'), keep: T('2026-11-06T08:00:00') }) }));
  enq(w, dailyBatch('2026-11-19'));
  check('ST31', '新格式寫入時自己修剪：14 天前的日期／批次丟掉，14 天內的留著', [Object.keys(st(w, 'ATT_STATE_RUN')).sort(), Object.keys(st(w, 'ATT_STATE_BATCH')).sort()],
    [['2026-11-05', '2026-11-19'], ['2026-11-19-aaaaaaaaaaaa', 'keep']]);
  const big = {}; for (let i = 0; i < 300; i++) big['E' + String(i).padStart(30, '0')] = T('2026-11-19T08:00:00') + i;
  const x = world('2026-11-19T09:00:00', Object.assign(fixedProps(), { ATT_STATE_EVT: JSON.stringify(big) }));
  enq(x, dailyBatch('2026-11-19')); say(x, 'LAST');
  const ev = st(x, 'ATT_STATE_EVT');
  check('ST32', 'ATT_STATE_EVT 最多 100 筆、丟最舊的、不超過 8000 字', [Object.keys(ev).length, 'LAST' in ev, 'E' + '0'.repeat(30) in ev, x.props.ATT_STATE_EVT.length <= 8000], [100, true, false, true]);
}

// ── 7. 一次性遷移（編輯器手動執行；預設只列出）──
{
  const props = Object.assign(fixedProps(), legacyGf());
  const m = world('2026-11-19T10:00:00', props);
  const before = JSON.stringify(m.props);
  const dry = S(m).attAlertMigrateState();
  check('ST33', 'dry-run：光復 56 個屬性，26 個舊式全部要搬、0 個刪；預估剩 33 個；沒改任何東西', [dry.before, dry.move, dry.drop, dry.keep, dry.expectAfter, JSON.stringify(m.props) === before],
    [56, 26, 0, 0, 33, true]);
  const logs = m.logs.join('\n');
  check('ST34', 'dry-run 只印名稱不印值（金鑰、時間戳、狀態值都不出現）', [logs.includes('ATT_RUN_2026-11-07'), logs.includes('ATT_BATCH_notice-cap10-20261114c'), logs.includes('fake-'), logs.includes('2026-11-18T08:51'), logs.includes('received'), logs.includes('SVC')],
    [true, true, false, false, false, false]);
  m.lock.held = true;
  check('ST35', 'Go 但鎖被佔：不動、回 null', [S(m).attAlertMigrateStateGo(), JSON.stringify(m.props) === before], [null, true]);
  m.lock.held = false;
  const pp = S(m).PropertiesService.getScriptProperties();
  S(m).PropertiesService = { getScriptProperties: () => Object.assign({}, pp, { setProperty: (k, v) => { if (k === 'ATT_STATE_BATCH') throw new Error('寫入失敗'); return pp.setProperty(k, v); } }) };
  let threw = false; try { S(m).attAlertMigrateStateGo(); } catch (e) { threw = true; }
  check('ST36', 'Go 寫新格式失敗：丟錯、舊屬性一個都沒刪', [threw, legacyKeys(m).length], [true, 26]);
  S(m).PropertiesService = { getScriptProperties: () => pp };
  const go = S(m).attAlertMigrateStateGo();
  check('ST37', 'Go：舊式 26 個搬完刪掉，剩 33 個（30 固定＋3 個 ATT_STATE_*），固定設定沒動', [go.after, go.notMoved, legacyKeys(m), FIXED.every((k) => m.props[k] === props[k]), Object.keys(m.props).length],
    [33, 0, [], true, 33]);
  check('ST38', '搬進來的內容正確（12 天狀態、13 個批次含 comp／notice、1 個事件）', [Object.keys(st(m, 'ATT_STATE_RUN')).length, Object.keys(st(m, 'ATT_STATE_BATCH')).length, Object.keys(st(m, 'ATT_STATE_EVT'))],
    [12, 13, ['01M7PMJG00SDF79DKDY9YH4Q82']]);
  check('ST39', '搬完後舊批次重送仍 dup、舊事件仍不處理', [enq(m, { run_date: '2026-11-18', batch_id: 'comp-2026-11-18', comp: ['甲'] }), (enq(m, dailyBatch('2026-11-19')), say(m, '01M7PMJG00SDF79DKDY9YH4Q82'), m.replies)],
    [{ ok: true, dup: true }, 0]);
  const again = S(m).attAlertMigrateStateGo();
  check('ST40', '再跑一次 Go：沒東西可搬、屬性數不變', [again.move, again.drop, again.after === again.before], [0, 0, true]);
  const b = world('2026-11-19T10:00:00', Object.assign(fixedProps(), { ATT_STATE_RUN: '壞', 'ATT_RUN_2026-11-18': 'received' }));
  const bd = S(b).attAlertMigrateState();
  S(b).attAlertMigrateStateGo();
  check('ST41', '新格式壞掉：dry-run 列出、Go 重設成只含舊屬性搬進來的內容', [bd.bad, st(b, 'ATT_STATE_RUN')], [['ATT_STATE_RUN'], { '2026-11-18': 'received' }]);
}

// ── 8. 模擬 60 天：屬性數不成長（遷移後、以及完全不遷移只靠保底慢慢清）──
function sixtyDays(migrate) {
  const m = world('2026-11-19T00:10:00', Object.assign(fixedProps(), legacyGf()));
  const sb = S(m);
  if (migrate) sb.attAlertMigrateStateGo();
  const counts = [], sizes = [];
  let ev = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(T('2026-11-19T12:00:00') + i * 86400000 - 8 * 3600000).toISOString().slice(0, 10);
    const at = (hm) => m.setNow(d + 'T' + hm + ':00');
    const guard = () => sb.attAlertGuard();
    at('08:50'); sb.handleAttAlertStart({ svcKey: 'SVC', run_date: d });
    at('08:52'); enq(m, dailyBatch(d, (i.toString(16) + 'a'.repeat(12)).slice(0, 12)));
    if (i % 3 === 0) { at('09:05'); enq(m, dailyBatch(d, (i.toString(16) + 'b'.repeat(12)).slice(0, 12))); }   // 內容有變又送一批
    if (i % 5 === 0) { at('09:10'); enq(m, { run_date: d, batch_id: 'comp-' + d, seq: T(d + 'T09:10:00'), comp: ['【加班補休】甲'] }); }
    if (i % 10 === 0) { at('17:00'); enq(m, { run_date: d, batch_id: 'notice-sim-' + d.replace(/-/g, ''), seq: T(d + 'T17:00:00'), notice: ['公告'] }); }
    ['09:30', '09:35', '12:00', '23:55'].forEach((hm) => { at(hm); guard(); });
    for (let k = 0; k < 4; k++) { at('1' + k + ':15'); say(m, 'EV' + (ev++)); }
    counts.push(Object.keys(m.props).length);
    sizes.push(Math.max(...['ATT_STATE_RUN', 'ATT_STATE_BATCH', 'ATT_STATE_EVT'].map((n) => (m.props[n] || '').length)));
  }
  return { m, counts, sizes };
}
{
  const a = sixtyDays(true);
  check('ST42', '遷移後跑 60 天：每天屬性數都 ≤ 34（30 固定＋3 個 ATT_STATE_*＋偶爾 ATT_HAS_PENDING），第 60 天＝第 15 天',
    [Math.max(...a.counts) <= 34, a.counts[59] === a.counts[14], legacyKeys(a.m)], [true, true, []]);
  check('ST43', '60 天內三個 JSON 屬性最大都在 8000 字內（約 9KB 上限）', Math.max(...a.sizes) <= 8000, true, '最大 ' + Math.max(...a.sizes) + ' 字');
  const bt = Object.values(st(a.m, 'ATT_STATE_BATCH'));
  check('ST44', '60 天下來批次記錄只留 14 天內的（最新與最舊相差 ≤ 14 天）', [Math.max(...bt) - Math.min(...bt) <= 14 * 86400000, bt.length < 40], [true, true], bt.length + ' 筆');
  const b = sixtyDays(false);
  check('ST45', '完全不遷移：舊式 26 個在 14 天內被保底清光，之後屬性數同樣封頂', [b.counts[0] >= 56, legacyKeys(b.m), Math.max(...b.counts.slice(15)) <= 34, b.counts[59] === b.counts[20]], [true, [], true, true],
    '每天屬性數：' + b.counts.join(','));
  check('ST46', '60 天內每天的提醒都帶出過（功能沒被改壞）', rows(a.m).filter((r) => r.section === 'daily' && r.status === 'pending').length, 0);
}
done();
