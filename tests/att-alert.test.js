/* 考勤異常候補提醒 Phase 4：apps-script/AttAlert.gs（寄放、綁定、帶出、09:30 保底、通知匣）＋ LineHub.gs webhook 掛勾
 * 全部用假的試算表（tests/helpers/sheets-like.js，會像真的 Sheets 一樣轉型）、假的指令碼屬性／鎖／UrlFetchApp。
 * 示範名只用王小明／陳小華／林小美／李大同／張小芬；不放任何真實 ID、金鑰。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const { createSpreadsheet, Sheet } = require('./helpers/sheets-like.js');
const ROOT = path.join(__dirname, '..');
const SRC = ['Code.gs', 'Liff.gs', 'LineHub.gs', 'AttAlert.gs'].map(f => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')).join('\n');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'att-alert-contract-v1.json'), 'utf8'));

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`);
};
const sha = (m) => crypto.createHash('sha256').update(m.join('\u0000')).digest('hex').slice(0, 16);
const shape = (m) => ({ count: m.length, lens: m.map(x => x.length), sha: sha(m) });

// 記錄所有被寫入的分頁名稱（驗「只寫 att_alert_queue」）
const written = new Set();
const origWrite = Sheet.prototype._write;
let seeding = false;
Sheet.prototype._write = function (r, c, v) { if (!seeding) written.add(this.name); return origWrite.call(this, r, c, v); };

const T0 = Date.parse('2026-12-10T09:00:00+08:00');
const KEY = 'test-svc-key';
const GROUP = 'Cgroup0001', OTHER_GROUP = 'Cgroup0002';

function make(opts) {
  opts = opts || {};
  const props = {};
  if (opts.key !== null) props.ATT_ALERT_SVC_KEY = opts.key || KEY;
  Object.assign(props, opts.props || {});
  const net = { replies: [], inbox: [], replyCodes: [], inboxResp: { ok: true, added: true }, throwReply: false, throwInbox: false };
  const lock = { calls: [], held: false, failOn: [], failNth: [] };
  const opens = { n: 0 };
  const logs = { errors: [], log: [], triggers: [], deleted: [] };
  let triggers = opts.triggers || [];
  const cache = {};
  const sb = {
    console: { log() {}, warn() {}, error: (...a) => logs.errors.push(a.join(' ')) },
    JSON, Math, String, Number, Object, Array, isNaN, isFinite, parseInt, RegExp, Boolean,
    LINE_HUB_BOT_TOKEN: 'BOT_TOKEN_FAKE',
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props),
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: (ms) => { lock.calls.push(ms); if (lock.failOn.indexOf(ms) >= 0 || lock.failNth.indexOf(lock.calls.length) >= 0) return false; lock.held = true; return true; },
      releaseLock: () => { lock.held = false; },
    }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; }, removeAll: ks => ks.forEach(k => { delete cache[k]; }) }) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Logger: { log: m => logs.log.push(String(m)) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { logs.deleted.push(t.getHandlerFunction()); triggers = triggers.filter(x => x !== t); },
      newTrigger: fn => { const rec = { fn }; const b = { timeBased() { return b; }, everyMinutes(n) { rec.every = n; return b; }, inTimezone(z) { rec.tz = z; return b; }, create() { logs.triggers.push(rec); return rec; } }; return b; },
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.indexOf('api.line.me/v2/bot/info') >= 0) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ userId: 'BOTU' }) };
        if (url.indexOf('/message/reply') >= 0) {
          const body = JSON.parse(o.payload);
          net.replies.push({ body, auth: o.headers.Authorization, queueAtReply: opts.peek ? opts.peek() : null, lockHeld: lock.held });
          if (net.throwReply) throw new Error('Timeout: fake');
          const code = net.replyCodes.length ? net.replyCodes.shift() : 200;
          return { getResponseCode: () => code, getContentText: () => '{}' };
        }
        if (url === 'https://inbox.example.test/exec') {
          net.inbox.push(JSON.parse(o.payload));
          if (net.throwInbox) throw new Error('boom');
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(net.inboxResp) };
        }
        throw new Error('unexpected fetch ' + url);
      },
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const t = new Date(d.getTime() + 8 * 3600000), p = n => ('0' + n).slice(-2);
        const ymd = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
        if (fmt === 'yyyy-MM-dd') return ymd;
        if (fmt === 'HH:mm') return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
        return `${ymd}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
      },
      getUuid: () => '1234abcd-0000-4000-8000-000000000000', sleep() {},
    },
  };
  sb.CONFIG = { LINE_CHANNEL_ID: '0000000000', ALTERNATION_LOOKBACK_HOURS: 12 };
  vm.createContext(sb);
  const VDate = vm.runInContext('Date', sb);
  const ss = createSpreadsheet({ DateCtor: VDate });
  seeding = true;
  ss.seed('roster', [['emp_id', 'name', 'key'], ['E01', '王小明', 'k1']]);
  ss.seed('events', [['ts', 'emp_id', 'type', 'status'], ['2026-12-09T09:00:00+08:00', 'E01', 'in', 'ok']]);
  seeding = false;
  sb.SpreadsheetApp = { openById: () => { opens.n++; return ss; } };
  vm.runInContext(SRC, sb);
  sb.__now = opts.now || T0;
  vm.runInContext('getSS = function () { return SpreadsheetApp.openById("x"); }; attAlertNow_ = function () { return new Date(__now); };', sb);
  vm.runInContext('LINE_HUB_STORES_CONFIG = [];', sb);
  const c = {
    sb, props, net, lock, logs, ss, cache, written, opens,
    setNow: ms => { sb.__now = ms; },
    advance: min => { sb.__now += min * 60000; },
    call: (fn, obj) => { sb.__arg = JSON.stringify(obj === undefined ? null : obj); return JSON.parse(vm.runInContext(`JSON.stringify(${fn}(JSON.parse(__arg)))`, sb) || 'null'); },
    run: (fn) => vm.runInContext(`${fn}()`, sb),
    start: o => c.call('handleAttAlertStart', Object.assign({ svcKey: KEY }, o)),
    enqueue: o => c.call('handleAttAlertEnqueue', Object.assign({ svcKey: KEY }, o)),
    onEvent: ev => c.call('attAlertOnEvent_', ev),
    queue: () => {
      const sh = ss.getSheetByName('att_alert_queue');
      if (!sh) return null;
      const v = sh.getDataRange().getValues();
      return v.slice(1).map(r => ({ id: r[0], run_date: r[1], batch_id: r[2], seq: r[3], section: r[4], store: r[5], line: r[6], status: r[7], created_at: r[8], inflight_at: r[9], delivered_at: r[10], webhook_event_id: r[11] }));
    },
    status: () => (c.queue() || []).map(r => `${r.section}:${r.status}`),
    inboxKeys: () => net.inbox.map(x => x.key),
  };
  return c;
}
const msgEv = (groupId, text, evId, extra) => Object.assign({ type: 'message', replyToken: 'RT-' + (evId || 'x'), webhookEventId: evId || 'EVT0', source: { type: 'group', groupId, userId: 'Uxxx' }, message: { type: 'text', text: text || '大家好' } }, extra || {});
const bound = (o) => make(Object.assign({ props: { ATT_GROUP_ID: GROUP } }, o));
const fxReq = () => { const r = JSON.parse(JSON.stringify(fixture.att_alert_enqueue_request)); delete r.action; delete r.svcKey; return r; };
const text = (c, i) => c.net.replies[i || 0].body.messages.map(m => m.text);

// ── mini renderMessage 的實際輸出（2026-11-07 用 node 執行 ~/mala-store-ops att-digest-rules.js renderMessage 取得，逐字貼入）──
const EXP_A = ['【考勤異常】12/10（四）\n\n▍小辛辣光復\n・陳小華 T02 照目前班表會到 202 小時\n\n▍墨竹亭金山\n・林小美 12/09（例假）出勤 6 小時\n\n▍班表\n・墨竹亭六張犁 T03 班表還沒鎖定（12/27 開始）\n\n⚠ 這些單位今天資料查不到：墨竹亭台中美村\n請各單位到「考勤管理」處理。'];
const EXP_B = ['【考勤異常】11/23（一）\n\n▍小辛辣光復\n・陳小華 T02 照目前班表會到 202 小時\n・11/19 工時還沒核定（已 4 天）：王小明、陳小華、林小美\n\n▍墨竹亭金山\n・林小美 11/22（例假）出勤 6 小時\n\n▍班表\n・墨竹亭六張犁 T03 班表還沒鎖定（11/29 開始）\n\n⚠ 這些單位今天資料查不到：央廚、墨竹亭台中美村（資料格式錯誤 2 筆）\n⚠ 跨店合併暫停（對照讀不到）\n⚠ 央廚 管理系統核定名單讀不到，標示可能不準\n請各單位到「考勤管理」處理。'];
const EXP_C = ['【考勤異常】11/19–11/23\n\n▍央廚\n・新狀態\n\n▍墨竹亭金山\n・丁 11/22（例假）出勤 6 小時\n\n▍11/22 墨竹亭金山\n・丙 11/21（例假）出勤 6 小時\n\n▍11/21 墨竹亭金山\n・乙 11/20（休息日）出勤 8 小時\n\n▍更早未帶出\n・墨竹亭金山 甲 11/18（例假）出勤 6 小時\n\n▍班表\n・總部 T03 還沒鎖定\n\n請各單位到「考勤管理」處理。'];
const EXP_D250 = { count: 3, lens: [4966, 4998, 2086], sha: 'b4fa97b4cf91d411' };
const EXP_D1000 = { count: 5, lens: [4966, 4998, 4998, 4998, 4986], sha: '440d34a610a36a93' };
const EXP_E = { count: 2, lens: [4999, 27], sha: 'a1953912f18e9cca' };
const longLines = n => Array.from({ length: n }, (_, i) => `同仁${String(i).padStart(4, '0')} 11/22（例假）出勤 6 小時，備註${'字'.repeat(20)}`);
const B_PAYLOAD = { run_date: '2026-11-23', batch_id: '2026-11-23-bbbbbbbbbbbb', seq: 5,
  daily: [{ store: '墨竹亭金山', lines: ['林小美 11/22（例假）出勤 6 小時'] }],
  state: [{ store: '小辛辣光復', lines: ['陳小華 T02 照目前班表會到 202 小時', '11/19 工時還沒核定（已 4 天）：王小明、陳小華、林小美'] }],
  sched: ['墨竹亭六張犁 T03 班表還沒鎖定（11/29 開始）'],
  failed_stores: [{ store: '央廚', reason: '資料查不到' }, { store: '墨竹亭台中美村', reason: '資料格式錯誤 2 筆' }],
  notes: ['跨店合併暫停（對照讀不到）', '央廚 管理系統核定名單讀不到，標示可能不準'] };
const cBatch = (rd, seq, line, st, sched) => ({ run_date: rd, batch_id: rd + '-c' + seq, seq, daily: [{ store: '墨竹亭金山', lines: [line] }], state: st ? [{ store: '央廚', lines: [st] }] : [], sched: sched || [], failed_stores: [] });
const C_BATCHES = [cBatch('2026-11-19', 1, '甲 11/18（例假）出勤 6 小時', '舊狀態'), cBatch('2026-11-21', 2, '乙 11/20（休息日）出勤 8 小時'),
  cBatch('2026-11-22', 3, '丙 11/21（例假）出勤 6 小時'), cBatch('2026-11-23', 4, '丁 11/22（例假）出勤 6 小時', '新狀態', ['總部 T03 還沒鎖定'])];

// ═══════════════ 1 金鑰與啟用 ═══════════════
console.log('══ 金鑰與啟用 ══');
{
  const c = make();
  chk('金鑰錯→unauthorized（enqueue）', c.enqueue({ svcKey: 'bad', run_date: '2026-12-10', batch_id: 'x1', empty: true }), { ok: false, error: 'unauthorized' });
  chk('沒帶金鑰→unauthorized（start）', c.call('handleAttAlertStart', { run_date: '2026-12-10' }), { ok: false, error: 'unauthorized' });
  chk('金鑰錯不寫分頁、不設狀態', [c.queue(), c.props['ATT_RUN_2026-12-10'], Object.keys(c.props).filter(k => /^ATT_(RUN|BATCH)_/.test(k))], [null, undefined, []]);
}
{
  const c = make({ key: null });   // 非光復店：沒設 ATT_ALERT_SVC_KEY
  chk('非光復 start→not_enabled', c.call('handleAttAlertStart', { svcKey: 'any', run_date: '2026-12-10' }), { ok: false, error: 'not_enabled' });
  chk('非光復 enqueue→not_enabled，沒建分頁', [c.call('handleAttAlertEnqueue', Object.assign(fxReq(), { svcKey: 'any' })), c.queue()], [{ ok: false, error: 'not_enabled' }, null]);
  chk('非光復：群組訊息與 join 都回 false、不記屬性', [c.onEvent(msgEv(GROUP, '綁定考勤提醒 123456')), c.onEvent({ type: 'join', source: { type: 'group', groupId: GROUP } }), c.props.ATT_JOIN_LAST, c.props.ATT_GROUP_ID], [false, false, undefined, undefined]);
  c.setNow(Date.parse('2026-12-10T10:00:00+08:00')); c.run('attAlertGuard');
  chk('非光復：保底函式不動', [c.queue(), c.props['ATT_RUN_2026-12-10']], [null, undefined]);
  chk('非光復：綁定碼函式不產生碼', [c.run('attAlertIssueBindCode'), c.props.ATT_BIND_CODE], [null, undefined]);
}

// ═══════════════ 2 att_alert_start ═══════════════
console.log('══ att_alert_start ══');
{
  const c = make();
  chk('start 設 running', [c.start({ run_date: '2026-12-10' }), c.props['ATT_RUN_2026-12-10']], [{ ok: true }, 'running']);
  chk('start 用了鎖', c.lock.calls.length >= 1 && !c.lock.held, true);
  for (const st of ['received', 'empty', 'guarded']) { c.props['ATT_RUN_2026-12-10'] = st; c.start({ run_date: '2026-12-10' }); chk(`已是 ${st} 不覆蓋`, c.props['ATT_RUN_2026-12-10'], st); }
  chk('壞日期→bad_input', c.start({ run_date: '2026-02-30' }), { ok: false, error: 'bad_input' });
}

// ═══════════════ 3 att_alert_enqueue ═══════════════
console.log('══ att_alert_enqueue ══');
{
  const c = make();
  chk('enqueue 契約範例 ok', c.enqueue(Object.assign(fxReq(), { seq: 100 })), { ok: true });
  const q = c.queue();
  chk('建了分頁、表頭正確', c.ss.getSheetByName('att_alert_queue').getRange(1, 1, 1, 12).getValues()[0], ['id', 'run_date', 'batch_id', 'seq', 'section', 'store', 'line', 'status', 'created_at', 'inflight_at', 'delivered_at', 'webhook_event_id']);
  chk('列數與 section', q.map(r => r.section), ['daily', 'state', 'sched', 'failed']);
  chk('全部 pending、run_date／batch_id 維持文字（不被轉成日期）', [q.every(r => r.status === 'pending'), q[0].run_date, q[0].batch_id, q[0].seq], [true, '2026-12-10', '2026-12-10-0123456789ab', 100]);
  chk('failed 列：店名＋原因', [q[3].store, q[3].line], ['墨竹亭台中美村', '資料查不到']);
  chk('狀態 received＋記批次', [c.props['ATT_RUN_2026-12-10'], !!c.props['ATT_BATCH_2026-12-10-0123456789ab']], ['received', true]);
  chk('冪等：同 batch 再送→dup、沒多寫', [c.enqueue(Object.assign(fxReq(), { seq: 101 })), c.queue().length], [{ ok: true, dup: true }, 4]);
  const c2 = make(); c2.enqueue(fxReq()); delete c2.props['ATT_BATCH_2026-12-10-0123456789ab'];
  chk('冪等保險：屬性不見但分頁已有該批→仍 dup', [c2.enqueue(fxReq()), c2.queue().length], [{ ok: true, dup: true }, 4]);
  chk('只寫 att_alert_queue（本檔至今的所有寫入）', [...written], ['att_alert_queue']);
  chk('寫入鎖＝10 秒', c.lock.calls[0], 10000);
}
{
  const c = make();
  c.enqueue({ run_date: '2026-12-09', batch_id: '2026-12-09-aaaaaaaaaaaa', seq: 1,
    daily: [{ store: '墨竹亭金山', lines: ['林小美 12/08（例假）出勤 6 小時'] }], state: [{ store: '央廚', lines: ['舊狀態'] }],
    sched: ['舊班表'], failed_stores: ['cf'], notes: ['舊註記'] });
  c.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-bbbbbbbbbbbb', seq: 2,
    daily: [{ store: '墨竹亭金山', lines: ['王小明 12/09（休息日）出勤 8 小時'] }], state: [{ store: '央廚', lines: ['新狀態'] }], sched: [], failed_stores: [] });
  chk('合併：舊 state／sched／failed／notes 全 superseded、daily 保留、新批 pending',
    c.queue().map(r => `${r.batch_id.slice(5, 10)}:${r.section}:${r.status}`),
    ['12-09:daily:pending', '12-09:state:superseded', '12-09:sched:superseded', '12-09:failed:superseded', '12-09:notes:superseded', '12-10:daily:pending', '12-10:state:pending']);
  c.setNow(T0 + 86400000);   // run_date 嚴格不晚於台北今天
  c.enqueue({ run_date: '2026-12-11', batch_id: '2026-12-11-cccccccccccc', empty: true });
  chk('empty 批：不寫列、只讓舊 state superseded、狀態 empty', [c.queue().length, c.status().slice(-2), c.props['ATT_RUN_2026-12-11']], [7, ['daily:pending', 'state:superseded'], 'empty']);
  chk('empty 批也進冪等', c.enqueue({ run_date: '2026-12-11', batch_id: '2026-12-11-cccccccccccc', empty: true }), { ok: true, dup: true });
  chk('壞輸入：batch_id 含怪字元／lines 不是陣列／日期錯', [
    c.enqueue({ run_date: '2026-12-11', batch_id: 'a b', empty: true }).error,
    c.enqueue({ run_date: '2026-12-11', batch_id: 'z1', daily: [{ store: 'x', lines: 'oops' }] }).error,
    c.enqueue({ run_date: '12/11', batch_id: 'z2', empty: true }).error], ['bad_input', 'bad_input', 'bad_input']);
  chk('壞輸入不留半套列', c.queue().length, 7);
}

// 過去的 run_date（mini 跨日重送，P3-13）
{
  const c = bound(); c.setNow(T0);
  const y = { run_date: '2026-12-09', batch_id: '2026-12-09-yyyyyyyyyyyy', seq: 1, daily: [{ store: '墨竹亭金山', lines: ['林小美 12/08（例假）出勤 6 小時'] }], state: [], sched: [], failed_stores: [] };
  chk('昨天 run_date 的 enqueue 被接受', c.enqueue(y), { ok: true });
  chk('ATT_RUN_<昨天>＝received，今天的狀態不受影響', [c.props['ATT_RUN_2026-12-09'], c.props['ATT_RUN_2026-12-10']], ['received', undefined]);
  chk('同 batch_id 重送→dup、沒多寫', [c.enqueue(y), c.queue().length], [{ ok: true, dup: true }, 1]);
  chk('昨天的 start 也接受', [c.start({ run_date: '2026-12-08' }), c.props['ATT_RUN_2026-12-08']], [{ ok: true }, 'running']);
  chk('今天可、明天不可（嚴格 ≤ 台北今天）', [c.start({ run_date: '2026-12-10' }).ok, c.start({ run_date: '2026-12-11' }).error, c.enqueue({ run_date: '2026-12-11', batch_id: 'f1', empty: true }).error], [true, 'bad_input', 'bad_input']);
  c.setNow(Date.parse('2026-12-10T09:30:00+08:00')); c.run('attAlertGuard');
  chk('昨天已 received 不影響今天保底：09:30 照寫今天的 guard', [c.props['ATT_RUN_2026-12-10'], c.queue().filter(r => r.section === 'guard').map(r => r.run_date)], ['guarded', ['2026-12-10']]);
}

// ═══════════════ 4 版面與 mini renderMessage 一致 ═══════════════
console.log('══ 版面（與 mini renderMessage 逐字一致）══');
{
  const c = make();
  const render = (b, o) => JSON.parse(vm.runInContext('(function(){return JSON.stringify(attAlertRenderMessage_(JSON.parse(__b), JSON.parse(__o)))})()', Object.assign(c.sb, { __b: JSON.stringify(b), __o: JSON.stringify(o || {}) })));
  const A = Object.assign(fxReq(), { seq: 100 });
  chk('A 契約範例（直接呼叫純函式）', render([A], { today: A.run_date }), EXP_A);
  chk('B failed 多原因＋notes', render([B_PAYLOAD], { today: '2026-11-23' }), EXP_B);
  chk('C 多批：區間標題、最近 3 天分段、更早未帶出、state 取最新', render(C_BATCHES, { today: '2026-11-23' }), EXP_C);
  const long = (n) => ({ run_date: '2026-11-23', batch_id: 'd', seq: 9, daily: [{ store: '墨竹亭金山', lines: longLines(n) }], state: [], sched: [], failed_stores: [] });
  chk('D250 切 3 則（長度＋雜湊同 mini）', shape(render([long(250)], { today: '2026-11-23' })), EXP_D250);
  chk('D1000 滿 5 則並截斷「還有 N 筆」', shape(render([long(1000)], { today: '2026-11-23' })), EXP_D1000);
  const e = render([Object.assign(long(0), { daily: [{ store: '墨竹亭金山', lines: ['字'.repeat(6000), 'B 短'] }] })], { today: '2026-11-23' });
  chk('E 單行 6000 字截斷加「…」，每則 ≤5000', [shape(e), e.every(x => x.length <= 5000)], [EXP_E, true]);
  chk('全空→沒有訊息', render([{ run_date: '2026-11-23', batch_id: 'z', seq: 1, daily: [], state: [], sched: [], failed_stores: [] }], { today: '2026-11-23' }), []);
  chk('壞日期→error', render([{ run_date: 'xx', daily: [] }], {}), { error: 'bad_date' });
  chk('多批依 seq 取最新，不依輸入順序', (() => {
    const g = { run_date: '2026-12-10', seq: 1, daily: [], state: [], sched: [], failed_stores: ['cf'] };
    const r = { run_date: '2026-12-10', seq: 2, daily: [], state: [{ store: '央廚', lines: ['陳小華 T02 照目前班表會到 202 小時'] }], sched: [], failed_stores: [] };
    const j1 = render([g, r], { today: '2026-12-10' }).join(''), j2 = render([r, g], { today: '2026-12-10' }).join('');
    return [j1 === j2, j1.includes('陳小華'), j1.includes('資料查不到')];
  })(), [true, true, false]);
}

// ═══════════════ 5 綁定 ═══════════════
console.log('══ 群組綁定 ══');
const join = (c, g) => c.onEvent({ type: 'join', replyToken: 'RTJ', source: { type: 'group', groupId: g || GROUP } });
{
  const c = make();
  const code = c.run('attAlertIssueBindCode');
  chk('產生 6 位數碼、存屬性、Logger 印出', [/^\d{6}$/.test(code), JSON.parse(c.props.ATT_BIND_CODE).code === code, c.logs.log.some(x => x.includes(code))], [true, true, true]);
  chk('join：記 ATT_JOIN_LAST、不回話', [join(c), JSON.parse(c.props.ATT_JOIN_LAST).groupId, c.net.replies.length], [true, GROUP, 0]);
  const wrong = code === '123456' ? '654321' : '123456';
  chk('碼錯：不綁、不回應（但這句算綁定口令，回 true）', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${wrong}`, 'b1')), c.props.ATT_GROUP_ID, c.net.replies.length], [true, undefined, 0]);
  chk('沒帶碼：不是綁定口令', [c.onEvent(msgEv(GROUP, '綁定考勤提醒', 'b2')), c.props.ATT_GROUP_ID, c.net.replies.length], [false, undefined, 0]);
  chk('私訊打綁定口令：不處理', [c.onEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: `綁定考勤提醒 ${code}` } }), c.props.ATT_GROUP_ID], [false, undefined]);
  chk('碼對＋發話群＝剛 join 的群：綁定、清碼、reply「已綁定」', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code}`, 'b3')), c.props.ATT_GROUP_ID, c.props.ATT_BIND_CODE, text(c)], [true, GROUP, undefined, ['已綁定，之後考勤異常會發在這裡']]);
  chk('回覆用同一支 LINE token 常數', c.net.replies[0].auth, 'Bearer BOT_TOKEN_FAKE');
  chk('綁定成功 → outbox 通知（只含群組 ID 末 6 碼）', [JSON.parse(c.props.ATT_OUTBOX).map(x => x.key), JSON.parse(c.props.ATT_OUTBOX)[0].text.includes('p0001'), JSON.parse(c.props.ATT_OUTBOX)[0].text.includes(GROUP)], [['bound:2026-12-10'], true, false]);
  const code2 = c.run('attAlertIssueBindCode');
  chk('已綁定：別群再綁不動、不回應', [c.onEvent(msgEv(OTHER_GROUP, `綁定考勤提醒 ${code2}`, 'b4')), c.props.ATT_GROUP_ID, c.net.replies.length], [false, GROUP, 1]);
  chk('已綁定：同群再綁也不回應', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code2}`, 'b5')), c.net.replies.length], [true, 1]);
}
{
  const c = make();
  const code = c.run('attAlertIssueBindCode'); join(c);
  c.advance(31);
  chk('過期（31 分鐘）：不綁、不回應', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code}`, 'e1')), c.props.ATT_GROUP_ID, c.net.replies.length], [true, undefined, 0]);
  const c2 = make();
  const code2 = c2.run('attAlertIssueBindCode'); join(c2); c2.advance(29);
  chk('29 分鐘內有效', [c2.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code2}`, 'e2')), c2.props.ATT_GROUP_ID], [true, GROUP]);
  const c3 = make();
  c3.props.ATT_BIND_CODE = JSON.stringify({ code: '246810', exp: T0 + 60000 }); join(c3);
  c3.lock.failOn = [3000];
  chk('綁定拿不到鎖：不綁、不回應', [c3.onEvent(msgEv(GROUP, '綁定考勤提醒 246810', 'e3')), c3.props.ATT_GROUP_ID], [true, undefined]);
}
{
  // C14：發話群必須是剛 join 的群、join 在 30 分鐘內；碼錯 5 次失效
  const c = make();
  const code = c.run('attAlertIssueBindCode');
  chk('沒有 join 記錄：碼對也不綁', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code}`, 'j1')), c.props.ATT_GROUP_ID, c.net.replies.length], [true, undefined, 0]);
  join(c, OTHER_GROUP);
  chk('發話群≠ join 的群：碼對也不綁', [c.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code}`, 'j2')), c.props.ATT_GROUP_ID], [true, undefined]);
  chk('不成立的嘗試累計失敗次數', JSON.parse(c.props.ATT_BIND_CODE).fails, 2);
  const c2 = make();
  const code2 = c2.run('attAlertIssueBindCode'); join(c2); c2.advance(31); c2.advance(-29);   // join 在 2 分鐘前仍有效
  chk('join 2 分鐘前、碼在效期內：綁得上', [c2.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code2}`, 'j3')), c2.props.ATT_GROUP_ID], [true, GROUP]);
  const c3 = make();
  const code3 = c3.run('attAlertIssueBindCode');
  const bad = code3 === '111111' ? '222222' : '111111';
  join(c3);
  for (let i = 1; i <= 4; i++) c3.onEvent(msgEv(GROUP, `綁定考勤提醒 ${bad}`, 'k' + i));
  chk('碼錯 4 次碼還在', [!!c3.props.ATT_BIND_CODE, JSON.parse(c3.props.ATT_BIND_CODE).fails], [true, 4]);
  c3.onEvent(msgEv(GROUP, `綁定考勤提醒 ${bad}`, 'k5'));
  chk('碼錯滿 5 次 → 刪 ATT_BIND_CODE', c3.props.ATT_BIND_CODE, undefined);
  chk('碼被刪後正確碼也綁不上（要重新產生）', [c3.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code3}`, 'k6')), c3.props.ATT_GROUP_ID], [true, undefined]);
  const c4 = make();
  c4.enqueue(Object.assign(fxReq(), { seq: 1 }));
  const code4 = c4.run('attAlertIssueBindCode'); join(c4);
  c4.onEvent(msgEv(GROUP, `綁定考勤提醒 ${code4}`, 'p1'));
  chk('綁定前就寄放的內容：綁定後補 ATT_HAS_PENDING，下一句話就帶出', [c4.props.ATT_HAS_PENDING, (c4.onEvent(msgEv(GROUP, '早安', 'p2')), c4.net.replies.length)], ['1', 2]);
}

// ═══════════════ 6 帶出 ═══════════════
console.log('══ 帶出 ══');
{
  const c = bound({ peek: () => null });
  const seedFx = () => c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  seedFx();
  c.net.replies.length = 0;
  c.sb.__peek = 1;
  chk('綁定群的訊息帶出 → 回 true', c.onEvent(msgEv(GROUP, '早安', 'EV1')), true);
  chk('reply 內容＝mini 版面（A）、用該事件的 replyToken', [text(c), c.net.replies[0].body.replyToken], [EXP_A, 'RT-EV1']);
  chk('回 200 → delivered，記 delivered_at 與事件 id', [c.status(), !!c.queue()[0].delivered_at, c.queue()[0].webhook_event_id], [['daily:delivered', 'state:delivered', 'sched:delivered', 'failed:delivered'], true, 'EV1']);
  chk('呼叫 LINE 時沒握著鎖（鎖外 reply）', c.net.replies[0].lockHeld, false);
  chk('拿鎖用 500ms', c.lock.calls.includes(500), true);
  chk('再講話：沒有 pending → 不再回', [c.onEvent(msgEv(GROUP, '再一句', 'EV2')), c.net.replies.length], [true, 1]);
  chk('delivered 的列一直保留', c.queue().length, 4);
  chk('事件 id 記在 ATT_EVT_', !!c.props.ATT_EVT_EV1, true);
}
{
  // reply 當下佇列狀態應為 inflight
  let c;
  c = bound({ peek: () => c.status() });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.onEvent(msgEv(GROUP, '早安', 'EV1'));
  chk('reply 當下列狀態＝inflight', c.net.replies[0].queueAtReply, ['daily:inflight', 'state:inflight', 'sched:inflight', 'failed:inflight']);
}
{
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.net.replyCodes = [400];
  c.onEvent(msgEv(GROUP, '甲', 'F1'));
  chk('明確 4xx → 改回 pending（清掉 inflight_at 與事件 id）', [c.status(), c.queue()[0].inflight_at, c.queue()[0].webhook_event_id], [['daily:pending', 'state:pending', 'sched:pending', 'failed:pending'], '', '']);
  chk('4xx 不送通知匣', c.net.inbox.length, 0);
  c.onEvent(msgEv(GROUP, '乙', 'F2'));
  chk('下一句重新帶出成功', [c.net.replies.length, text(c, 1), c.status().every(s => s.endsWith('delivered'))], [2, EXP_A, true]);
}
{
  const c = bound({ props: { ATT_GROUP_ID: GROUP, NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' } });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.net.throwReply = true;
  c.onEvent(msgEv(GROUP, '甲', 'U1x'));
  chk('逾時（丟例外）→ unknown＋進 outbox（webhook 路徑不打通知匣）', [c.status().every(s => s.endsWith('unknown')), c.net.inbox.length, JSON.parse(c.props.ATT_OUTBOX).map(x => x.key)], [true, 0, ['unknown:2026-12-10']]);
  c.run('attAlertGuard');
  chk('保底觸發器送出 outbox、成功就移除', [c.inboxKeys(), c.props.ATT_OUTBOX], [['att-alert:unknown:2026-12-10'], undefined]);
  c.net.throwReply = false;
  c.onEvent(msgEv(GROUP, '乙', 'U2x'));
  chk('unknown 不自動重發', [c.net.replies.length, c.status().every(s => s.endsWith('unknown'))], [1, true]);
  const c2 = bound();
  c2.enqueue(Object.assign(fxReq(), { seq: 100 })); c2.net.replyCodes = [503];
  c2.onEvent(msgEv(GROUP, '甲', 'U3x'));
  chk('5xx（結果不明）→ unknown', c2.status().every(s => s.endsWith('unknown')), true);
}
{
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.onEvent(msgEv(GROUP, '甲', 'DUP'));
  c.enqueue(Object.assign(B_PAYLOAD, {}));
  const n1 = c.net.replies.length;
  chk('同 webhookEventId 第二次不重做（LINE 重送）', [c.onEvent(msgEv(GROUP, '甲', 'DUP')), c.net.replies.length, c.status().slice(-5).every(s => s.endsWith('pending'))], [true, n1, true]);
  c.onEvent(msgEv(GROUP, '乙', 'NEW'));
  chk('新事件 id 可以帶出新批', [c.net.replies.length, text(c, 1)], [2, EXP_B]);
}
{
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.lock.failOn = [500];
  chk('拿不到鎖：直接 return、沒回、沒動列、沒記事件 id', [c.onEvent(msgEv(GROUP, '甲', 'L1')), c.net.replies.length, c.status().every(s => s.endsWith('pending')), c.props.ATT_EVT_L1], [true, 0, true, undefined]);
  c.lock.failOn = [];
  c.onEvent(msgEv(GROUP, '乙', 'L2'));
  chk('鎖恢復後帶出', c.net.replies.length, 1);
}
{
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  chk('非綁定群：完全不處理（回 false、沒 reply、列不動）', [c.onEvent(msgEv(OTHER_GROUP, '甲', 'O1')), c.net.replies.length, c.status().every(s => s.endsWith('pending')), c.props.ATT_EVT_O1], [false, 0, true, undefined]);
  chk('綁定群的其他非訊息事件（memberJoined）不處理', [c.onEvent({ type: 'memberJoined', source: { type: 'group', groupId: GROUP } }), c.net.replies.length], [false, 0]);
  chk('沒有 replyToken：不動列', [c.onEvent(msgEv(GROUP, '甲', 'N1', { replyToken: '' })), c.status().every(s => s.endsWith('pending'))], [true, true]);
  chk('私訊事件：不處理', [c.onEvent({ type: 'message', replyToken: 'r', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '打卡' } }), c.net.replies.length], [false, 0]);
  const e = make({ props: { ATT_GROUP_ID: GROUP } });
  chk('沒有佇列分頁：不建分頁、不回', [e.onEvent(msgEv(GROUP, '甲', 'Z1')), e.queue(), e.net.replies.length], [true, null, 0]);
  chk('圖片／貼圖等非文字訊息同樣可帶出', (() => { const g = bound(); g.enqueue(Object.assign(fxReq(), { seq: 1 })); g.onEvent(msgEv(GROUP, '', 'S1', { message: { type: 'sticker' } })); return g.net.replies.length; })(), 1);
}
{
  // 結果寫回拿不到鎖（500ms）→ 暫存 ATT_VERDICT_，保底觸發器補寫
  const c = bound({ props: { ATT_GROUP_ID: GROUP, NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' } });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.lock.failNth = [c.lock.calls.length + 2];   // 帶出時第 1 次鎖（認領）成功、第 2 次（寫回）失敗
  c.onEvent(msgEv(GROUP, '甲', 'V1'));
  chk('寫回拿不到鎖：列維持 inflight、結果暫存 ATT_VERDICT_（reply 已送）', [c.status().every(s => s.endsWith('inflight')), JSON.parse(c.props.ATT_VERDICT_V1).verdict, c.net.replies.length], [true, 'delivered', 1]);
  c.run('attAlertGuard');
  chk('保底觸發器補寫 delivered、清掉暫存', [c.status().every(s => s.endsWith('delivered')), c.props.ATT_VERDICT_V1], [true, undefined]);
  const d = bound();
  d.enqueue(Object.assign(fxReq(), { seq: 100 })); d.net.replyCodes = [400];
  d.lock.failNth = [d.lock.calls.length + 2];
  d.onEvent(msgEv(GROUP, '甲', 'V2'));
  chk('暫存的結果是 pending：補寫後回 pending、旗標補回，下一句可重新帶出', [d.status().every(s => s.endsWith('inflight')), (d.run('attAlertGuard'), d.status().every(s => s.endsWith('pending'))), d.props.ATT_HAS_PENDING], [true, true, '1']);
  d.onEvent(msgEv(GROUP, '乙', 'V3'));
  chk('補寫後下一句帶出', [d.net.replies.length, d.status().every(s => s.endsWith('delivered'))], [2, true]);
}
{
  // inflight 超過 10 分鐘 → unknown（由保底觸發器掃，不重發）；沒超過不動
  const c = bound({ props: { ATT_GROUP_ID: GROUP, NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' } });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.lock.failNth = [c.lock.calls.length + 2];
  c.onEvent(msgEv(GROUP, '甲', 'S1x'));
  delete c.props.ATT_VERDICT_S1x;   // 連暫存也沒留下（極端情況）
  c.advance(9); c.run('attAlertGuard');
  chk('inflight 9 分鐘：不動、不通知', [c.status().every(s => s.endsWith('inflight')), c.net.inbox.length], [true, 0]);
  c.advance(2); c.run('attAlertGuard');
  chk('inflight 11 分鐘：視為 unknown、送通知匣、不重發', [c.status().every(s => s.endsWith('unknown')), c.inboxKeys(), c.net.replies.length], [true, ['att-alert:unknown:2026-12-10'], 1]);
  c.onEvent(msgEv(GROUP, '丙', 'S3x'));
  chk('unknown 之後再講話也不重發', c.net.replies.length, 1);
}

// ═══════════════ 7 端到端：切則、列數、日期 ═══════════════
console.log('══ 佇列 → 訊息（走完整條）══');
{
  const c = bound(); B_PAYLOAD.seq = 5;
  c.enqueue(B_PAYLOAD); c.onEvent(msgEv(GROUP, '甲', 'P1'));
  chk('B（含 notes、多原因 failed）經佇列帶出＝mini 輸出', text(c), EXP_B);
  const d = bound();
  C_BATCHES.forEach(b => d.enqueue(b)); d.setNow(Date.parse('2026-11-23T08:55:00+08:00'));
  d.onEvent(msgEv(GROUP, '甲', 'P2'));
  chk('C 四批依序寄放（舊 state 被取代）經佇列帶出＝mini 輸出', text(d), EXP_C);
  const e = bound();
  e.enqueue({ run_date: '2026-11-23', batch_id: '2026-11-23-dddddddddddd', seq: 9, daily: [{ store: '墨竹亭金山', lines: longLines(250) }], state: [], sched: [], failed_stores: [] });
  e.onEvent(msgEv(GROUP, '甲', 'P3'));
  chk('D250 經佇列：3 則、長度＋雜湊同 mini', shape(text(e)), EXP_D250);
  const f = bound();
  f.enqueue({ run_date: '2026-11-23', batch_id: '2026-11-23-eeeeeeeeeeee', seq: 9, daily: [{ store: '墨竹亭金山', lines: longLines(1000) }], state: [], sched: [], failed_stores: [] });
  chk('1000 筆寫入超過預設 1000 列格線也不炸（自動長列）', f.queue().length, 1000);
  f.onEvent(msgEv(GROUP, '甲', 'P4'));
  chk('D1000 經佇列：LINE 一次 5 則、截斷同 mini、列全部 delivered', [shape(text(f)), f.status().every(s => /delivered$|truncated$/.test(s))], [EXP_D1000, true]);
}

// ═══════════════ 8 09:30 保底 ═══════════════
console.log('══ 09:30 保底 ══');
const at = (c, hm) => c.setNow(Date.parse(`2026-12-10T${hm}:00+08:00`));
{
  const c = bound({ props: { ATT_GROUP_ID: GROUP, NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' } });
  at(c, '09:29'); c.run('attAlertGuard');
  chk('09:29 不動', [c.queue(), c.props['ATT_RUN_2026-12-10']], [null, undefined]);
  at(c, '09:30'); c.run('attAlertGuard');
  chk('09:30 寫 guard 列、設 guarded、送通知匣', [c.queue().map(r => [r.section, r.status, r.line]), c.props['ATT_RUN_2026-12-10'], c.inboxKeys()], [[['guard', 'pending', '今天考勤資料查不到，請到考勤管理查看']], 'guarded', ['att-alert:guard:2026-12-10']]);
  at(c, '09:35'); c.run('attAlertGuard');
  chk('之後每 5 分鐘不重複寫', [c.queue().length, c.net.inbox.length], [1, 1]);
  c.onEvent(msgEv(GROUP, '早安', 'G1'));
  chk('群組說話帶出保底提醒', text(c), ['【考勤異常】12/10（四）\n\n⚠ 今天考勤資料查不到，請到考勤管理查看\n請各單位到「考勤管理」處理。']);
  chk('保底列 delivered', c.status(), ['guard:delivered']);
}
{
  const c = bound();
  for (const st of ['received', 'empty', 'guarded']) { c.props['ATT_RUN_2026-12-10'] = st; at(c, '10:00'); c.run('attAlertGuard'); }
  chk('已 received／empty／guarded 不動', c.queue(), null);
  c.props['ATT_RUN_2026-12-10'] = 'running'; c.run('attAlertGuard');
  chk('running 到 09:30 後仍保底', c.status(), ['guard:pending']);
}
{
  const c = bound();
  // 前一天還有沒帶出的 daily＋state；今天沒來資料 → 保底接在舊內容後面
  c.enqueue({ run_date: '2026-12-09', batch_id: '2026-12-09-aaaaaaaaaaaa', seq: 1, daily: [{ store: '墨竹亭金山', lines: ['林小美 12/08（例假）出勤 6 小時'] }], state: [{ store: '央廚', lines: ['陳小華 T02 照目前班表會到 202 小時'] }], sched: [], failed_stores: [] });
  at(c, '09:30'); c.run('attAlertGuard');
  c.onEvent(msgEv(GROUP, '早安', 'G2'));
  chk('保底接在舊內容後面（舊 state 仍在、標題含兩天）', text(c), ['【考勤異常】12/09–12/10\n\n▍央廚\n・陳小華 T02 照目前班表會到 202 小時\n\n▍墨竹亭金山\n・林小美 12/08（例假）出勤 6 小時\n\n⚠ 今天考勤資料查不到，請到考勤管理查看\n請各單位到「考勤管理」處理。']);
}
{
  const c = bound();
  at(c, '09:40'); c.run('attAlertGuard');
  c.enqueue(Object.assign(fxReq(), { seq: 200 }));
  chk('晚到 enqueue：guard 變 superseded、真資料 pending、狀態改 received', [c.status(), c.props['ATT_RUN_2026-12-10']], [['guard:superseded', 'daily:pending', 'state:pending', 'sched:pending', 'failed:pending'], 'received']);
  c.onEvent(msgEv(GROUP, '早安', 'G3'));
  chk('之後帶出的是真資料，不含「查不到」保底句', [text(c)[0].includes('今天考勤資料查不到，請到考勤管理查看'), text(c)[0].includes('陳小華 T02')], [false, true]);
  at(c, '09:45'); c.run('attAlertGuard');
  chk('received 後保底不再動', c.queue().filter(r => r.section === 'guard').length, 1);
}
{
  const c = make({ props: { ATT_EVT_old: String(T0 - 2 * 86400000), ATT_EVT_new: String(T0 - 3600000), 'ATT_RUN_2026-10-01': 'received', 'ATT_BATCH_2026-10-01-abc': 'x', 'ATT_RUN_2026-12-01': 'received' } });
  at(c, '09:30'); c.run('attAlertGuard');
  chk('保底順手清舊屬性：1 天前的事件 id、40 天前的批次／狀態', [c.props.ATT_EVT_old, !!c.props.ATT_EVT_new, c.props['ATT_RUN_2026-10-01'], c.props['ATT_BATCH_2026-10-01-abc'], c.props['ATT_RUN_2026-12-01']], [undefined, true, undefined, undefined, 'received']);
}
{
  const old = { getHandlerFunction: () => 'attAlertGuard' }, other = { getHandlerFunction: () => 'somethingElse' };
  const c = make({ triggers: [old, other] });
  c.run('attAlertInstallGuard');
  chk('建每 5 分鐘觸發器、台北時區；舊的同名先刪、別的不動', [c.logs.triggers, c.logs.deleted], [[{ fn: 'attAlertGuard', every: 5, tz: 'Asia/Taipei' }], ['attAlertGuard']]);
}

// ═══════════════ 9 通知匣 ═══════════════
console.log('══ 通知匣 ══');
{
  const inbox = (c, t, x, k) => { c.sb.__a = [t, x, k]; return vm.runInContext('attAlertInbox_(__a[0], __a[1], __a[2])', c.sb); };
  const c0 = make();
  chk('沒設 token／網址 → false、不打網路', [inbox(c0, 't', 'x', 'guard:2026-12-10'), c0.net.inbox.length], [false, 0]);
  const c = make({ props: { NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' } });
  chk('ok===true && added===true → true', inbox(c, '標題', '內文', 'guard:2026-12-10'), true);
  const p = c.net.inbox[0];
  chk('payload：action／from／level／key', [p.action, p.token, p.from, p.level, p.key, p.title, p.text], ['add', 'tok-fake', 'att-alert', 'normal', 'att-alert:guard:2026-12-10', '標題', '內文']);
  c.net.inboxResp = { ok: true, added: false };
  chk('added 不是 true（例如 POST 被轉成 GET 的 health 回應）→ false', inbox(c, 't', 'x', 'unknown:2026-12-10'), false);
  c.net.inboxResp = { ok: true };
  chk('只有 ok:true 沒有 added → false', inbox(c, 't', 'x', 'unknown:2026-12-10'), false);
  c.net.throwInbox = true;
  chk('網路例外不外拋、回 false', inbox(c, 't', 'x', 'unknown:2026-12-10'), false);
  c.net.throwInbox = false; c.net.inboxResp = { ok: true, added: true };
  inbox(c, 't', 'x', 'Un Known!:2026-12-10');
  chk('key 每段只留小寫英數與連字號', c.net.inbox[c.net.inbox.length - 1].key, 'att-alert:unknown:2026-12-10');
}

// ═══════════════ 10 Code.gs 分派與 LineHub webhook 掛勾 ═══════════════
console.log('══ doPost 分派／webhook 掛勾 ══');
{
  const c = make();
  const post = (o) => { c.sb.__p = JSON.stringify(o); return JSON.parse(vm.runInContext('doPost({postData:{contents:__p}}).s', c.sb)); };
  chk('doPost att_alert_start', [post({ action: 'att_alert_start', svcKey: KEY, run_date: '2026-12-10' }), c.props['ATT_RUN_2026-12-10']], [{ ok: true }, 'running']);
  chk('doPost att_alert_enqueue', post(Object.assign(fxReq(), { action: 'att_alert_enqueue', svcKey: KEY })), { ok: true });
  chk('doPost 金鑰錯→unauthorized', post(Object.assign(fxReq(), { action: 'att_alert_enqueue', svcKey: 'no' })), { ok: false, error: 'unauthorized' });
  chk('其他動作不受影響：未知動作照舊', post({ action: 'no_such_action' }), { ok: false, error: 'unknown_action' });
}
{
  const hook = (c, events) => { c.sb.__w = JSON.stringify({ destination: 'BOTU', events }); return vm.runInContext('handleLineWebhook_(JSON.parse(__w))', c.sb); };
  const priv = { type: 'message', replyToken: 'RTP', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '加班請假' } };
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  hook(c, [msgEv(GROUP, '早安', 'H1')]);
  chk('webhook 走掛勾：綁定群說話 → 帶出，且沒進打卡流程（只有一則 reply）', [c.net.replies.length, text(c)], [1, EXP_A]);
  hook(c, [msgEv(OTHER_GROUP, '早安', 'H2')]);
  chk('webhook：別的群組維持完全不處理', c.net.replies.length, 1);
  hook(c, [{ type: 'join', replyToken: 'RTJ', source: { type: 'group', groupId: OTHER_GROUP } }]);
  chk('webhook：join 事件交給掛勾（記 ATT_JOIN_LAST）', JSON.parse(c.props.ATT_JOIN_LAST).groupId, OTHER_GROUP);
  hook(c, [priv]);
  chk('私訊打卡流程照舊（加班請假回申請頁卡片）', [c.net.replies.length, /view=req/.test(JSON.stringify(c.net.replies[1] && c.net.replies[1].body))], [2, true]);
  // 故意讓 attAlertOnEvent_ 丟錯
  const d = bound();
  vm.runInContext('attAlertOnEvent_ = function () { throw new Error("boom-hook"); };', d.sb);
  hook(d, [msgEv(GROUP, '早安', 'H3'), priv, { type: 'join', source: { type: 'group', groupId: GROUP } }]);
  chk('掛勾丟錯：只記 log，私訊打卡照回，其餘事件不中斷', [d.net.replies.length, /view=req/.test(JSON.stringify(d.net.replies[0] && d.net.replies[0].body)), d.logs.errors.filter(x => x.includes('boom-hook')).length], [1, true, 2]);
  const e = bound();
  vm.runInContext('delete globalThis.attAlertOnEvent_; attAlertOnEvent_ = undefined;', e.sb);
  hook(e, [priv]);
  chk('掛勾不存在（AttAlert.gs 沒部署）：私訊照回', e.net.replies.length, 1);
}

// ═══════════════ 12 雙審修正（P4-1～P4-9／GPT）═══════════════
console.log('══ 雙審修正 ══');
const INBOX_PROPS = { ATT_GROUP_ID: GROUP, NOTIFY_INBOX_TOKEN: 'tok-fake', NOTIFY_INBOX_URL: 'https://inbox.example.test/exec' };
{
  // A1 兩段處理：群組事件排在私訊前面，私訊仍先處理、結果不變
  const hook = (c, events) => { c.sb.__w = JSON.stringify({ destination: 'BOTU', events }); return vm.runInContext('handleLineWebhook_(JSON.parse(__w))', c.sb); };
  const priv = { type: 'message', replyToken: 'RTP', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '加班請假' } };
  const solo = bound(); hook(solo, [priv]);
  const c = bound(); c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  hook(c, [msgEv(GROUP, '早安', 'A1'), priv, { type: 'join', source: { type: 'group', groupId: OTHER_GROUP } }]);
  chk('群組事件在前、私訊在後：私訊先被處理（第一則 reply 是私訊的）', [c.net.replies[0].body.replyToken, c.net.replies[1].body.replyToken], ['RTP', 'RT-A1']);
  chk('私訊結果與單獨處理時完全相同', JSON.stringify(c.net.replies[0].body), JSON.stringify(solo.net.replies[0].body));
  chk('群組事件仍被處理（帶出＋join 記錄）', [text(c, 1), JSON.parse(c.props.ATT_JOIN_LAST).groupId], [EXP_A, OTHER_GROUP]);
  // 私訊處理期間，群組事件尚未開始：在私訊 reply 當下檢查佇列還是 pending
  let d; d = bound({ peek: () => d.status() });
  d.enqueue(Object.assign(fxReq(), { seq: 100 }));
  hook(d, [msgEv(GROUP, '早安', 'A2'), priv]);
  chk('私訊 reply 當下，群組事件還沒動佇列（pending）', d.net.replies[0].queueAtReply, ['daily:pending', 'state:pending', 'sched:pending', 'failed:pending']);
}
{
  // A2 ATT_HAS_PENDING 旗標
  const c = bound();
  c.sb.__x = 0;
  const o0 = c.opens.n;
  c.onEvent(msgEv(GROUP, '早安', 'F0'));
  chk('旗標沒設：綁定群的訊息完全不讀試算表', [c.opens.n - o0, c.net.replies.length], [0, 0]);
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  chk('enqueue 寫入 pending → 旗標設 1', c.props.ATT_HAS_PENDING, '1');
  c.onEvent(msgEv(GROUP, '甲', 'F1'));
  chk('帶出（沒有 pending 剩下）→ 旗標清掉', [c.props.ATT_HAS_PENDING, c.net.replies.length], [undefined, 1]);
  const o1 = c.opens.n;
  c.onEvent(msgEv(GROUP, '乙', 'F2'));
  chk('之後的訊息又不讀試算表', c.opens.n - o1, 0);
  const d = bound(); d.enqueue(Object.assign(fxReq(), { seq: 100 })); d.net.replyCodes = [400];
  d.onEvent(msgEv(GROUP, '甲', 'F3'));
  chk('4xx 改回 pending → 旗標補回', d.props.ATT_HAS_PENDING, '1');
  const e = bound(); e.enqueue({ run_date: '2026-12-10', batch_id: 'em1', empty: true });
  chk('empty 批沒有 pending → 不設旗標', e.props.ATT_HAS_PENDING, undefined);
}
{
  // A4 outbox：去重、上限 20、送不成留著、成功才移除
  const c = make({ props: INBOX_PROPS });
  const note = (t, k) => { c.sb.__a = [t, k]; vm.runInContext('attAlertNotify_(__a[0], "內文".repeat(300), __a[1])', c.sb); };
  note('甲', 'k1'); note('甲重複', 'k1');
  chk('同 key 只留一筆；文字截 200 字', [JSON.parse(c.props.ATT_OUTBOX).length, JSON.parse(c.props.ATT_OUTBOX)[0].text.length], [1, 200]);
  for (let i = 0; i < 25; i++) note('t' + i, 'n' + i);
  chk('上限 20 筆（丟最舊的）', [JSON.parse(c.props.ATT_OUTBOX).length, JSON.parse(c.props.ATT_OUTBOX)[0].key, c.props.ATT_OUTBOX.length < 9000], [20, 'n5', true]);
  c.net.inboxResp = { ok: true, added: false };
  c.run('attAlertGuard');
  chk('通知匣回 added:false → 全部留在 outbox', JSON.parse(c.props.ATT_OUTBOX).length, 20);
  c.net.inboxResp = { ok: true, added: true }; c.net.inbox.length = 0;
  c.run('attAlertGuard');
  chk('ok&&added → 全部送出並移除', [c.net.inbox.length, c.props.ATT_OUTBOX], [20, undefined]);
  const d = make({ props: INBOX_PROPS });
  d.sb.__a = ['t', 'x1']; vm.runInContext('attAlertNotify_(__a[0], "x", __a[1])', d.sb);
  d.net.throwInbox = true; d.run('attAlertGuard');
  chk('通知匣例外不外拋、通知留著', JSON.parse(d.props.ATT_OUTBOX).map(x => x.key), ['x1']);
  const e = bound(INBOX_PROPS && { props: INBOX_PROPS });
  e.enqueue(Object.assign(fxReq(), { seq: 1 })); e.net.throwReply = true; e.onEvent(msgEv(GROUP, '甲', 'O9'));
  chk('webhook 路徑從頭到尾沒打通知匣', e.net.inbox.length, 0);
}
{
  // A5 封存：終態且超過 7 天的列刪除；非終態不動；一天一次
  const c = bound();
  const old = Date.parse('2026-12-01T09:00:00+08:00');
  c.setNow(old);
  c.enqueue({ run_date: '2026-12-01', batch_id: '2026-12-01-aaaaaaaaaaaa', seq: 1, daily: [{ store: '墨竹亭金山', lines: ['林小美 11/30（例假）出勤 6 小時'] }], state: [{ store: '央廚', lines: ['舊狀態'] }], sched: [], failed_stores: [] });
  c.onEvent(msgEv(GROUP, '早安', 'R1'));      // 舊批全部 delivered
  c.setNow(Date.parse('2026-12-02T09:00:00+08:00'));
  c.enqueue({ run_date: '2026-12-02', batch_id: '2026-12-02-bbbbbbbbbbbb', seq: 2, daily: [{ store: '墨竹亭金山', lines: ['王小明 12/01（休息日）出勤 8 小時'] }], state: [], sched: [], failed_stores: [] });   // 仍 pending
  c.setNow(Date.parse('2026-12-10T09:00:00+08:00'));
  chk('封存前：2 列 delivered、1 列 pending', c.status(), ['daily:delivered', 'state:delivered', 'daily:pending']);
  c.run('attAlertGuard');
  chk('超過 7 天的終態列刪除、pending 保留', c.status(), ['daily:pending']);
  chk('一天只做一次', c.props.ATT_ARCHIVE_LAST, '2026-12-10');
  c.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-cccccccccccc', empty: true });   // 讓今天不被保底
  const before = c.queue().length; c.advance(5); c.run('attAlertGuard');
  chk('同一天再跑不動', c.queue().length, before);
  const d = bound(); d.setNow(old);
  d.enqueue({ run_date: '2026-12-01', batch_id: '2026-12-01-dddddddddddd', seq: 1, daily: [{ store: '墨竹亭金山', lines: ['x'] }], state: [{ store: '央廚', lines: ['y'] }], sched: ['z'], failed_stores: ['cf'] });
  d.enqueue({ run_date: '2026-12-02', batch_id: '2026-12-02-eeeeeeeeeeee', seq: 2, daily: [], state: [], sched: [], failed_stores: ['mztmc'] });
  d.setNow(Date.parse('2026-12-02T12:00:00+08:00'));
  d.run('attAlertGuard');
  chk('不到 7 天的 superseded 不刪', d.queue().length, 5);
}
{
  // B6 舊日重送不得取代今天的 guard 或較新的批次
  const c = bound();
  at(c, '09:30'); c.run('attAlertGuard');
  c.enqueue({ run_date: '2026-12-09', batch_id: '2026-12-09-yyyyyyyyyyyy', seq: 5, daily: [{ store: '墨竹亭金山', lines: ['林小美 12/08（例假）出勤 6 小時'] }], state: [{ store: '央廚', lines: ['昨天的狀態'] }], sched: [], failed_stores: [] });
  chk('今天 guard 存在時重送昨天批次 → guard 保留（pending）', c.status().filter(x => x.startsWith('guard')), ['guard:pending']);
  chk('昨天的 ATT_RUN 照設、今天仍是 guarded', [c.props['ATT_RUN_2026-12-09'], c.props['ATT_RUN_2026-12-10']], ['received', 'guarded']);
  const d = bound();
  d.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-nnnnnnnnnnnn', seq: 50, daily: [], state: [{ store: '央廚', lines: ['今天的狀態'] }], sched: [], failed_stores: [] });
  d.enqueue({ run_date: '2026-12-09', batch_id: '2026-12-09-oooooooooooo', seq: 99, daily: [], state: [{ store: '央廚', lines: ['昨天的狀態'] }], sched: [], failed_stores: [] });
  chk('舊日重送不取代今天較新批次的 state', d.status(), ['state:pending', 'state:pending']);
  const e = bound();
  e.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-p1p1p1p1p1p1', seq: 50, daily: [], state: [{ store: '央廚', lines: ['先到'] }], sched: [], failed_stores: [] });
  e.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-p2p2p2p2p2p2', seq: 40, daily: [], state: [{ store: '央廚', lines: ['seq 較小的後到者'] }], sched: [], failed_stores: [] });
  chk('同日 seq 較小的批次不取代 seq 較大的', e.status(), ['state:pending', 'state:pending']);
}
{
  // B7 寫入順序與 dup 補寫
  const c = bound();
  vm.runInContext('globalThis.__origSup = attAlertSupersede_; attAlertSupersede_ = function () { throw new Error("crash-mid-write"); };', c.sb);
  let threw = false; try { c.enqueue(Object.assign(fxReq(), { seq: 100 })); } catch (e) { threw = /crash-mid-write/.test(String(e)); }
  chk('中途失敗：新批列已寫（pending）、ATT_RUN／ATT_BATCH 還沒寫', [threw, c.status().length, c.props['ATT_RUN_2026-12-10'], c.props['ATT_BATCH_2026-12-10-0123456789ab']], [true, 4, undefined, undefined]);
  vm.runInContext('attAlertSupersede_ = __origSup;', c.sb);
  chk('重送同 batch → 補寫後回 dup、沒多寫列', [c.enqueue(Object.assign(fxReq(), { seq: 100 })), c.queue().length], [{ ok: true, dup: true }, 4]);
  chk('補寫了 ATT_RUN／ATT_BATCH／旗標', [c.props['ATT_RUN_2026-12-10'], !!c.props['ATT_BATCH_2026-12-10-0123456789ab'], c.props.ATT_HAS_PENDING], ['received', true, '1']);
  const d = bound();
  d.enqueue(Object.assign(fxReq(), { seq: 100 }));
  at(d, '09:40'); d.props['ATT_RUN_2026-12-10'] = 'running'; d.run('attAlertGuard');   // 假裝 ATT_RUN 沒寫成、保底插進來
  chk('（前置）保底寫了 guard', d.status().includes('guard:pending'), true);
  d.enqueue(Object.assign(fxReq(), { seq: 100 }));
  chk('dup 補寫順便把 guard 取代、狀態 received', [d.status().filter(x => x.startsWith('guard')), d.props['ATT_RUN_2026-12-10']], [['guard:superseded'], 'received']);
}
{
  // B8 保底觸發器：任何提早 return 之前先做維護
  const c = bound({ props: INBOX_PROPS });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  c.lock.failNth = [c.lock.calls.length + 2];
  c.onEvent(msgEv(GROUP, '甲', 'M1')); delete c.props.ATT_VERDICT_M1;
  c.props.ATT_EVT_old = String(T0 - 2 * 86400000); c.props['ATT_RUN_2026-09-01'] = 'received';
  c.advance(11);   // 09:11：未到 09:30，但 inflight 已超過 10 分鐘
  c.run('attAlertGuard');
  chk('09:11（未到 09:30）：逾時 inflight 照樣轉 unknown、清屬性、送 outbox，但不寫 guard', [c.status().every(s => s.endsWith('unknown')), c.props.ATT_EVT_old, c.props['ATT_RUN_2026-09-01'], c.inboxKeys(), c.props['ATT_RUN_2026-12-10']], [true, undefined, undefined, ['att-alert:unknown:2026-12-10'], 'received']);
}
{
  // B9 guard 固定 batch_id；已存在只補 ATT_RUN
  const c = bound();
  at(c, '09:30'); c.run('attAlertGuard');
  delete c.props['ATT_RUN_2026-12-10']; at(c, '09:35'); c.run('attAlertGuard');
  chk('guard 列只有一筆（batch_id＝guard-<日期>）、ATT_RUN 補回 guarded', [c.queue().map(r => r.batch_id), c.props['ATT_RUN_2026-12-10']], [['guard-2026-12-10'], 'guarded']);
}
{
  // B11 compose 的 today＝max(佇列最大 run_date, 台北今天)
  const c = bound();
  c.setNow(Date.parse('2026-12-07T09:00:00+08:00'));
  c.enqueue({ run_date: '2026-12-07', batch_id: '2026-12-07-aaaaaaaaaaaa', seq: 1, daily: [{ store: '墨竹亭金山', lines: ['甲 12/06（例假）出勤 6 小時'] }], state: [], sched: [], failed_stores: [] });
  c.setNow(Date.parse('2026-12-08T09:00:00+08:00'));
  c.enqueue({ run_date: '2026-12-08', batch_id: '2026-12-08-bbbbbbbbbbbb', seq: 2, daily: [{ store: '墨竹亭金山', lines: ['乙 12/07（例假）出勤 6 小時'] }], state: [], sched: [], failed_stores: [] });
  c.setNow(Date.parse('2026-12-10T09:05:00+08:00'));
  c.onEvent(msgEv(GROUP, '早安', 'T1'));
  chk('台北今天 12/10：12/07 的 daily 早於最近 3 天（12/08 起）→「更早未帶出」', text(c), ['【考勤異常】12/07–12/08\n\n▍墨竹亭金山\n・乙 12/07（例假）出勤 6 小時\n\n▍更早未帶出\n・墨竹亭金山 甲 12/06（例假）出勤 6 小時\n\n請各單位到「考勤管理」處理。']);
}
{
  // B12 截斷沒印出的列 → truncated（終態，不再重發）
  const c = bound();
  c.enqueue({ run_date: '2026-12-10', batch_id: '2026-12-10-ttttttttttt0', seq: 9, daily: [{ store: '墨竹亭金山', lines: longLines(1000) }], state: [], sched: [], failed_stores: [] });
  c.onEvent(msgEv(GROUP, '甲', 'X1'));
  const shown = text(c).join('\n').split('\n').filter(l => l.startsWith('・同仁')).length;
  const st = c.queue().reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
  chk('1000 筆：印出的 delivered、沒印出的 truncated，沒有殘留 pending／inflight', [st.delivered, st.truncated, Object.keys(st).sort()], [shown, 1000 - shown, ['delivered', 'truncated']]);
  chk('truncated 是終態：之後不重發、旗標已清', [(c.onEvent(msgEv(GROUP, '乙', 'X2')), c.net.replies.length), c.props.ATT_HAS_PENDING], [1, undefined]);
  chk('被截斷的是排在後面的列', [c.queue()[0].status, c.queue()[999].status], ['delivered', 'truncated']);
}
{
  // B13 leave：機器人被踢出綁定群
  const c = bound(INBOX_PROPS && { props: INBOX_PROPS });
  c.enqueue(Object.assign(fxReq(), { seq: 100 }));
  chk('別的群 leave 不理', [c.onEvent({ type: 'leave', source: { type: 'group', groupId: OTHER_GROUP } }), c.props.ATT_GROUP_ID], [false, GROUP]);
  chk('綁定群 leave → 清 ATT_GROUP_ID 與旗標，佇列不動', [c.onEvent({ type: 'leave', source: { type: 'group', groupId: GROUP } }), c.props.ATT_GROUP_ID, c.props.ATT_HAS_PENDING, c.status().every(s => s.endsWith('pending'))], [true, undefined, undefined, true]);
  chk('outbox 通知「需重新綁定」、webhook 不打通知匣', [JSON.parse(c.props.ATT_OUTBOX).map(x => x.key), /重新綁定/.test(JSON.parse(c.props.ATT_OUTBOX)[0].text), c.net.inbox.length], [['left:2026-12-10'], true, 0]);
  c.onEvent(msgEv(GROUP, '早安', 'LV1'));
  chk('解除綁定後群組說話不帶出', c.net.replies.length, 0);
  c.run('attAlertGuard');
  chk('保底觸發器把 leave 通知送出', c.inboxKeys().includes('att-alert:left:2026-12-10'), true);
}

// ═══════════════ 11 只寫 att_alert_queue ═══════════════
console.log('══ 只寫新分頁 ══');
chk('整個測試檔所有寫入的分頁名稱', [...written], ['att_alert_queue']);
{
  const c = bound();
  c.enqueue(Object.assign(fxReq(), { seq: 100 })); c.onEvent(msgEv(GROUP, '早安', 'W1')); at(c, '09:30'); c.run('attAlertGuard');
  chk('其他分頁內容原封不動', [c.ss.getSheetByName('roster').getDataRange().getValues(), c.ss.getSheetByName('events').getDataRange().getValues().length], [[['emp_id', 'name', 'key'], ['E01', '王小明', 'k1']], 2]);
}

console.log(`\n${fail ? '❌' : '✅'} att-alert：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
