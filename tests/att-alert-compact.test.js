/* 考勤異常提醒「精簡版面」（2026-11-25）：apps-script/AttAlert.gs 認 payload.fmt==='compact'（寄放時寫在佇列第 13 欄 fmt）
 *  ①不加結尾句「請各單位到「考勤管理」處理。」②店序認簡稱（跟 mini 簡稱表同一份、順序與全名相同）③標題日期去前導 0；
 *  每一批各照自己的 fmt 排：有內容的批次「全部」精簡才用精簡（標題日期、結尾句）；older 段落標題的日期看「那一天的批」；沒有 fmt 或其他值＝逐字同現行。
 * 對照：tests/fixtures/att-alert-compact-v1.json（mala-store-ops test/fixtures 同名檔逐字相同；mini renderMessage 與這裡的 attAlertRenderMessage_ 都要渲染出同樣的 messages）。
 * 全部假名（甲乙丙…）。 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { createSpreadsheet } = require('./helpers/sheets-like.js');
const ROOT = path.join(__dirname, '..');
const SRC = ['Code.gs', 'Liff.gs', 'LineHub.gs', 'AttAlert.gs'].map(f => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')).join('\n');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'att-alert-compact-v1.json'), 'utf8'));

let pass = 0, fail = 0;
const chk = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}${ok ? '' : ': ' + JSON.stringify(got) + ' ← 應為 ' + JSON.stringify(want)}`);
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-svc-key', GROUP = 'Cgroup0001';
const T0 = Date.parse('2026-11-25T09:00:00+08:00');

function make(opts) {
  opts = opts || {};
  const props = { ATT_SERVICE_PLACEHOLDER: '', ATT_ALERT_SVC_KEY: KEY, ATT_GROUP_ID: GROUP };
  const net = { replies: [] };
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, String, Number, Object, Array, isNaN, isFinite, parseInt, RegExp, Boolean,
    LINE_HUB_BOT_TOKEN: 'BOT_TOKEN_FAKE',
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {}, removeAll() {} }) },
    ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Logger: { log() {} },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => { const b = { timeBased() { return b; }, everyMinutes() { return b; }, inTimezone() { return b; }, create() { return {}; } }; return b; } },
    UrlFetchApp: { fetch: (url, o) => {
      if (url.indexOf('api.line.me/v2/bot/info') >= 0) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ userId: 'BOTU' }) };
      if (url.indexOf('/message/reply') >= 0) { net.replies.push(JSON.parse(o.payload)); return { getResponseCode: () => 200, getContentText: () => '{}' }; }
      throw new Error('unexpected fetch ' + url);
    } },
    Utilities: { formatDate: (d, tz, fmt) => {
      const t = new Date(d.getTime() + 8 * 3600000), p = n => ('0' + n).slice(-2);
      const ymd = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
      if (fmt === 'yyyy-MM-dd') return ymd;
      if (fmt === 'HH:mm') return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
      return `${ymd}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
    }, getUuid: () => '1234abcd-0000-4000-8000-000000000000', sleep() {} },
  };
  sb.CONFIG = { LINE_CHANNEL_ID: '0000000000', ALTERNATION_LOOKBACK_HOURS: 12 };
  vm.createContext(sb);
  const VDate = vm.runInContext('Date', sb);
  const ss = createSpreadsheet({ DateCtor: VDate });
  ss.seed('roster', [['emp_id', 'name', 'key'], ['E01', '王小明', 'k1']]);
  sb.SpreadsheetApp = { openById: () => ss };
  vm.runInContext(SRC, sb);
  sb.__now = opts.now || T0;
  vm.runInContext('getSS = function () { return SpreadsheetApp.openById("x"); }; attAlertNow_ = function () { return new Date(__now); };', sb);
  vm.runInContext('LINE_HUB_STORES_CONFIG = [];', sb);
  const call = (fn, obj) => { sb.__arg = JSON.stringify(obj === undefined ? null : obj); return JSON.parse(vm.runInContext(`JSON.stringify(${fn}(JSON.parse(__arg)))`, sb) || 'null'); };
  return {
    sb, ss, net, props,
    enqueue: o => call('handleAttAlertEnqueue', Object.assign({ svcKey: KEY }, o)),
    say: (id) => call('attAlertOnEvent_', { type: 'message', replyToken: 'RT-' + id, webhookEventId: id, source: { type: 'group', groupId: GROUP, userId: 'Uxxx' }, message: { type: 'text', text: '早' } }),
    render: (batches, o) => JSON.parse(vm.runInContext(`JSON.stringify(attAlertRenderMessage_(JSON.parse(${JSON.stringify(JSON.stringify(batches))}), ${JSON.stringify(o || {})}))`, sb)),
    ev: (code) => vm.runInContext(code, sb),
    queue: () => { const sh = ss.getSheetByName('att_alert_queue'); return sh ? sh.getDataRange().getValues() : null; },
  };
}
const enq = (b) => { const r = clone(b); r.batch_id = r.batch_id || `${r.run_date}-${String(r.seq).padStart(12, '0')}`; return r; };
const reqOf = (payload) => { const r = clone(payload); if (!r.batch_id) r.batch_id = 'x'; return r; };
const caseOf = (name) => FX.cases.find(c => c.name === name);

// ═══════════════ 1 簡稱表與店序 ═══════════════
console.log('══ 簡稱表與店序 ══');
{
  const c = make();
  const g = (n) => JSON.parse(c.ev(`JSON.stringify(${n})`));
  chk('九單位順序（＝mini STORE_ORDER）', g('ATT_ALERT_ORDER9'), ['小辛辣光復', '央廚', '總部', '墨竹亭金山', '墨竹亭光復', '墨竹亭六張犁', '墨竹亭台中美村', '墨竹亭內湖瑞光', '墨竹亭台中文心']);
  chk('簡稱表逐一寫死（小辛辣光復、央廚、總部保留全名）', g('ATT_ALERT_SHORT_FULL'), { '金山': '墨竹亭金山', '光復': '墨竹亭光復', '六張犁': '墨竹亭六張犁', '台中美村': '墨竹亭台中美村', '內湖瑞光': '墨竹亭內湖瑞光', '台中文心': '墨竹亭台中文心' });
  const full = g('ATT_ALERT_ORDER9'), shortFull = g('ATT_ALERT_SHORT_FULL');
  const shorts = full.map(f => Object.keys(shortFull).find(k => shortFull[k] === f) || f);
  chk('九個簡稱互不相同、也不跟任何單位全名相同（小辛辣光復≠光復）', [new Set(shorts).size, shorts.filter((s, i) => full.some((f, j) => f === s && i !== j))], [9, []]);
  const order = (list) => JSON.parse(c.ev(`JSON.stringify(${JSON.stringify(list)}.slice().sort(attAlertStoreOrder_))`));
  chk('簡稱照全名位置排：台中文心、金山、央廚、小辛辣光復、六張犁、總部 → 小辛辣光復、央廚、總部、金山、六張犁、台中文心',
    order(['台中文心', '金山', '央廚', '小辛辣光復', '六張犁', '總部']), ['小辛辣光復', '央廚', '總部', '金山', '六張犁', '台中文心']);
  chk('標題段落（不認得的名字）排在所有單位後面、彼此維持原順序', order(['排班沒出勤也沒單', '金山', '跨帳號重複申請', '央廚']), ['央廚', '金山', '排班沒出勤也沒單', '跨帳號重複申請']);
  chk('舊版全名排序跟現行一樣（七店；瑞光、文心全名維持 99）', order(['墨竹亭台中美村', '墨竹亭金山', '央廚', '小辛辣光復', '墨竹亭內湖瑞光', '總部', '墨竹亭光復', '墨竹亭六張犁']),
    ['小辛辣光復', '央廚', '總部', '墨竹亭金山', '墨竹亭光復', '墨竹亭六張犁', '墨竹亭台中美村', '墨竹亭內湖瑞光']);
}

// ═══════════════ 2 fixture：與 mini renderMessage 逐字一致 ═══════════════
console.log('══ fixture 對照（mini renderMessage 的輸出寫死在 fixture）══');
{
  const c = make();
  for (const cs of FX.cases) chk(`render：${cs.name}`, c.render(cs.batches, { today: cs.today }), cs.messages);
  chk('fixture 有精簡、舊版、混合各種情境', FX.cases.map(x => x.name), ['classic_1125', 'compact_1125', 'compact_failed_notes', 'compact_two_days', 'mixed_classic_old_compact_new', 'compact_old_with_empty_latest', 'compact_long_dates', 'mixed_dates_per_day', 'compact_nosched', 'classic_empty_batch_only']);
}

// ═══════════════ 3 放行條件：沒有 fmt 或其他值＝舊版逐字 ═══════════════
console.log('══ 沒有 fmt／其他值 ══');
{
  const base = caseOf('classic_1125').batches[0];
  const want = caseOf('classic_1125').messages;
  const c = make();
  for (const v of [undefined, '', 'Compact', 'compat', 'classic', 'COMPACT', 1, true, null]) {
    const b = clone(base); if (v !== undefined) b.fmt = v;
    chk(`render fmt=${JSON.stringify(v)} ＝舊版逐字`, c.render([b], { today: '2026-11-25' }), want);
  }
  // 整條路徑：enqueue 帶其他值 → 佇列只有 12 欄、帶出的字＝舊版
  for (const v of ['Compact', 'classic', '']) {
    const c2 = make();
    const p = clone(base); p.fmt = v; p.batch_id = '2026-11-25-aaaaaaaaaaaa';
    chk(`enqueue fmt=${JSON.stringify(v)} ok、列寬 12`, [c2.enqueue(p), c2.queue()[1].length, c2.queue()[0].length], [{ ok: true }, 12, 12]);
    c2.say('E' + v);
    chk(`  帶出的字＝舊版逐字（fmt=${JSON.stringify(v)}）`, c2.net.replies[0] && c2.net.replies[0].messages.map(m => m.text), want);
  }
  chk('舊版 payload 的佇列列寬仍是 12、分頁欄名列沒多東西', (() => { const c3 = make(); c3.enqueue(Object.assign(clone(base), { batch_id: '2026-11-25-bbbbbbbbbbbb' })); const q = c3.queue(); return [q[0].length, q[1].length, c3.ss.getSheetByName('att_alert_queue').getMaxColumns() >= 12]; })(), [12, 12, true]);
}

// ═══════════════ 4 整條路徑：enqueue → 佇列 → 群組有人說話 → 帶出 ═══════════════
console.log('══ 整條路徑（精簡版）══');
{
  const cs = caseOf('compact_1125');
  const c = make();
  const p = clone(cs.batches[0]); p.batch_id = '2026-11-25-cccccccccccc';
  chk('enqueue 精簡批 ok', c.enqueue(p), { ok: true });
  const q = c.queue();
  chk('佇列第 13 欄＝fmt：欄名 fmt、每列 compact', [q[0].length, q[0][12], q.slice(1).every(r => r.length === 13 && r[12] === 'compact')], [13, 'fmt', true]);
  c.say('EV1');
  chk('群組有人說話：帶出的字＝主管看過的預覽（逐字，同 fixture）', c.net.replies[0] && c.net.replies[0].messages.map(m => m.text), cs.messages);
  chk('列全部 delivered（沒有被截斷）', c.queue().slice(1).map(r => r[7]).filter((v, i, a) => a.indexOf(v) === i), ['delivered']);
  chk('結尾沒有「請各單位到…」', c.net.replies[0].messages.every(m => m.text.indexOf('請各單位到') < 0), true);
}
{
  // 切換當天：一批舊版（還沒帶出）＋一批精簡版 → 整則照舊；各批行內文字原樣
  const cs = caseOf('mixed_classic_old_compact_new');
  const c = make();
  const [oldB, newB] = clone(cs.batches);
  oldB.batch_id = '2026-11-24-dddddddddddd'; newB.batch_id = '2026-11-25-eeeeeeeeeeee';
  chk('先寄放舊版批、再寄放精簡批', [c.enqueue(oldB), c.enqueue(newB)], [{ ok: true }, { ok: true }]);
  chk('佇列：舊批 fmt 欄空白、新批 compact（同一張表混著）', c.queue().slice(1).map(r => [r[2].slice(0, 10), r[4], r[12] || '']), [['2026-11-24', 'daily', ''], ['2026-11-25', 'state', 'compact']]);
  c.say('EV2');
  chk('帶出的字＝fixture 的 mixed（標題補 0、加結尾句、舊批行內文字原樣）', c.net.replies[0].messages.map(m => m.text), cs.messages);
}
{
  const cs = caseOf('mixed_dates_per_day');
  const c = make({ now: Date.parse('2026-12-05T09:00:00+08:00') });
  const bs = clone(cs.batches); bs.forEach((b, i) => { b.batch_id = `${b.run_date}-${'abcdef'[i].repeat(12)}`; });
  chk('三天各一批依序寄放', bs.map(b => c.enqueue(b)), [{ ok: true }, { ok: true }, { ok: true }]);
  c.say('EV3');
  chk('每天各照自己的版面：12/3（精簡）、12/04（舊版）；整則因有舊版批照舊（標題 12/03–12/05、有結尾句）', c.net.replies[0].messages.map(m => m.text), cs.messages);
}
{
  // 昨天精簡版 daily 還沒帶出、今天 mini 送 empty 批：全部有內容的批都是精簡 → 不加結尾句
  const cs = caseOf('compact_old_with_empty_latest');
  const c = make({ now: Date.parse('2026-12-05T09:00:00+08:00') });
  const b = clone(cs.batches[0]); b.batch_id = '2026-12-04-ffffffffffff';
  c.enqueue(b);
  chk('今天 empty 批：ok', c.enqueue({ run_date: '2026-12-05', empty: true, batch_id: '2026-12-05-000000000000', seq: 20 }), { ok: true });
  c.say('EV4');
  chk('帶出的字＝fixture（12/4–12/5、不加結尾句）', c.net.replies[0] && c.net.replies[0].messages.map(m => m.text), cs.messages);
}

// ═══════════════ 5 舊分頁（只有 12 欄）與補欄失敗 ═══════════════
console.log('══ 舊分頁／補欄失敗 ══');
{
  const c = make();
  const sh = c.ss.insertSheet('att_alert_queue');
  sh.getRange(1, 1, 1, 12).setValues([['id', 'run_date', 'batch_id', 'seq', 'section', 'store', 'line', 'status', 'created_at', 'inflight_at', 'delivered_at', 'webhook_event_id']]);
  sh.maxCols = 12;   // 舊分頁剛好 12 欄
  const old = clone(caseOf('classic_1125').batches[0]); old.batch_id = '2026-11-24-111111111111'; old.run_date = '2026-11-24'; old.seq = 1;
  chk('12 欄的舊分頁：舊版批照常寄放、讀得回', [c.enqueue(old), sh.getMaxColumns(), c.queue().length > 1], [{ ok: true }, 12, true]);
  const cs = caseOf('compact_1125');
  const p = clone(cs.batches[0]); p.batch_id = '2026-11-25-222222222222';
  chk('精簡批寄放時補欄（12→13）與欄名', [c.enqueue(p), sh.getMaxColumns(), c.queue()[0][12]], [{ ok: true }, 13, 'fmt']);
  c.say('EV5');
  const oldRows = c.queue().slice(1).filter(r => r[12] !== 'compact');
  chk('補欄後讀得回、帶出成功（精簡批的列全部 delivered；舊批：daily 帶出、state／sched 被新批取代）', [c.net.replies.length, c.queue().slice(1).filter(r => r[12] === 'compact').every(r => r[7] === 'delivered'),
    oldRows.filter(r => r[4] === 'daily').every(r => r[7] === 'delivered'), oldRows.filter(r => r[4] !== 'daily').every(r => r[7] === 'superseded')], [1, true, true, true]);
}
{
  const c = make();
  c.ev('attAlertEnsureFmtCol_ = function () { return false; };');   // 模擬補欄失敗
  const cs = caseOf('compact_1125');
  const p = clone(cs.batches[0]); p.batch_id = '2026-11-25-333333333333';
  chk('補欄失敗：這批照舊版面寄放（不讓整批失敗）：ok、列寬 12', [c.enqueue(p), c.queue()[1].length], [{ ok: true }, 12]);
  c.say('EV6');
  const t = c.net.replies[0].messages.map(m => m.text).join('\n');
  chk('照舊版面帶出：行內仍是精簡寫法、但有結尾句與補 0 的日期（降級、不漏項）', [t.indexOf('請各單位到「考勤管理」處理。') > 0, t.indexOf('未核定：11/21 甲、乙（4 天）') > 0, t.indexOf('▍金山') > 0], [true, true, true]);
}

console.log(`\n${fail ? '❌' : '✅'} att-alert-compact：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
