// 加班請假／忘打卡申請＋主管 QR（2026-10-09，Requests.gs）：驗證規則、撤銷、主管審核、預填資料、QR 簽章、打卡後告知結果。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const codeSrc = fs.readFileSync(ROOT + '/apps-script/Code.gs', 'utf8');
function extract(src, name) {
  const i = src.indexOf('function ' + name + '('); if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) { j++; break; } }
  return src.slice(i, j);
}
function extractConst(src, name) {
  const i = src.indexOf('const ' + name + ' = ['); const j = src.indexOf('];', i);
  return src.slice(i, j + 2).replace('const ', 'var ');
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

/* ── 假試算表 ── */
function sheet(name, rows) {
  const data = rows ? rows.map((r) => r.slice()) : [];
  return {
    name, data,
    getRange(r, c, nr, nc) {
      return {
        setValues(v) { v.forEach((row, i) => row.forEach((x, k) => { (data[r - 1 + i] = data[r - 1 + i] || [])[c - 1 + k] = x; })); },
        setValue(x) { (data[r - 1] = data[r - 1] || [])[c - 1] = x; },
        getValues() { return [data[r - 1].slice(c - 1, c - 1 + (nc || 1))]; },
        setNumberFormat() {},
      };
    },
    getRange_A1() {},
    appendRow(row) { data.push(row.slice()); },
    getLastColumn() { return data[0] ? data[0].length : 0; },
  };
}
function makeEnv(opts) {
  const sheets = {
    managers: sheet('managers', [['name', 'key', 'active'], ['測試主管', 'MK', 'true'], ['已停用', 'OLD', 'false']]),
  };
  const props = {};
  let nowIso = opts.now || '2026-10-09T16:00:00+08:00';
  const events = opts.events || [];
  const sb = {
    console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt, Object, Array, RegExp,
    CONFIG: { STORE_LAT: 24.78, STORE_LNG: 121.01 },
    getSS: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = sheet(n)) }),
    readSheetAsObjects: (sh) => {
      const h = sh.data[0] || [];
      return { headers: h, rows: sh.data.slice(1).map((r, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; }); return o; }) };
    },
    normCellDate: (v) => String(v), normCellTs: (v) => String(v),
    nowTaipeiIso: () => nowIso, todayTaipeiStr: () => nowIso.slice(0, 10),
    verifyLineIdToken_: (t) => (t ? String(t).replace('TOK_', '') : null),
    liffRosterByLine_: (uid) => uid === 'U1' ? { roster: { emp_id: 'E01', name: '測試一', key: 'k1' }, ss: sb.getSS() }
                         : uid === 'U2' ? { roster: { emp_id: 'E02', name: '測試二', key: 'k2' }, ss: sb.getSS() } : { error: 'not_bound' },
    liffThrottled_: () => false, liffSiteThrottled_: () => false,
    liffEvents_: () => events,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      formatDate: () => '00:00',
    },
  };
  vm.createContext(sb);
  vm.runInContext([extractConst(codeSrc, 'LEAVE_TYPES'), extract(codeSrc, 'findManagerByKey'),
                   fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8')].join('\n'), sb);
  sb.__sheets = sheets; sb.__setNow = (v) => { nowIso = v; }; sb.__props = props;
  return sb;
}
const ev = (ts, type, status) => ({ ts, emp_id: 'E01', type, status: status || 'ok', distance_m: 3, accuracy_m: 10 });
const submit = (sb, b, tok) => sb.handleReqSubmit_(Object.assign({ id_token: tok || 'TOK_U1' }, b));

ok('請假：整天填時數、時段自動算時數；假別要在清單內、不能選出差', () => {
  const sb = makeEnv({});
  let r = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8, reason: '家裡有事' });
  assert(r.ok, JSON.stringify(r)); assert.strictEqual(r.request.hours, 8); assert.strictEqual(r.request.status, 'pending');
  r = submit(sb, { kind: 'leave', date: '2026-10-16', leave_type: '事假', start: '14:00', end: '18:00' });
  assert(r.ok); assert.strictEqual(r.request.hours, 4);
  assert.strictEqual(submit(sb, { kind: 'leave', date: '2026-10-17', leave_type: '出差', hours: 8 }).error, 'bad_leave_type');
  assert.strictEqual(submit(sb, { kind: 'leave', date: '2026-10-17', leave_type: '亂打', hours: 8 }).error, 'bad_leave_type');
  assert.strictEqual(submit(sb, { kind: 'leave', date: '2026-10-17', leave_type: '病假' }).error, 'bad_hours');
});
ok('同一天同一類有審核中的就擋（避免重複），取消後可以重送', () => {
  const sb = makeEnv({});
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  assert.strictEqual(submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '事假', hours: 4 }).error, 'duplicate');
  assert(sb.handleReqCancel_({ id_token: 'TOK_U1', id: a.request.id }).ok);
  assert(submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '事假', hours: 4 }).ok);
});
ok('加班：不分事前事後，原因必填、跨夜算對、超過 12 小時擋', () => {
  const sb = makeEnv({});
  assert.strictEqual(submit(sb, { kind: 'ot', date: '2026-10-11', start: '21:00', end: '22:30' }).error, 'need_reason');
  let r = submit(sb, { kind: 'ot', date: '2026-10-11', start: '21:00', end: '22:30', reason: '外送多' });
  assert.strictEqual(r.request.hours, 1.5);
  r = submit(sb, { kind: 'ot', date: '2026-10-05', start: '22:00', end: '01:00', reason: '盤點' });   // 事後、跨夜
  assert(r.ok); assert.strictEqual(r.request.hours, 3);
  assert.strictEqual(submit(sb, { kind: 'ot', date: '2026-10-12', start: '06:00', end: '20:00', reason: 'x' }).error, 'bad_time');
});
ok('忘打卡：只能 7 天內、不能未來；那天卡都有打成功就擋；只能補真的缺的那張', () => {
  const sb = makeEnv({ events: [ev('2026-10-08T17:02:00+08:00', 'in'), ev('2026-10-06T10:58:00+08:00', 'in'), ev('2026-10-06T19:03:00+08:00', 'out')] });
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-01', miss_type: 'out', end: '22:00', reason: '忘記按' }).error, 'too_old');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-10', miss_type: 'out', end: '22:00', reason: '忘記按' }).error, 'bad_date');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-06', miss_type: 'out', end: '22:00', reason: '忘記按' }).error, 'not_missing');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-08', miss_type: 'in', start: '17:00', reason: '忘記按' }).error, 'not_missing');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-08', miss_type: 'out', end: '16:30', reason: '忘記按' }).error, 'bad_time');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-08', miss_type: 'out', end: '22:00' }).error, 'need_reason');
  const r = submit(sb, { kind: 'miss', date: '2026-10-08', miss_type: 'out', end: '22:00', reason: '忘記按' });
  assert(r.ok, JSON.stringify(r)); assert.strictEqual(r.summary, '10/8 忘打卡補登（下班 22:00）');
});
ok('忘打卡：被擋的卡不算有打（定位失準被擋的下班卡＝還是缺下班卡）；整天沒卡可補兩張', () => {
  const sb = makeEnv({ events: [ev('2026-10-07T16:55:00+08:00', 'in'), ev('2026-10-07T21:17:00+08:00', 'out', 'rejected_out_of_range')] });
  assert(submit(sb, { kind: 'miss', date: '2026-10-07', miss_type: 'out', end: '21:30', reason: '定位抓不到被擋' }).ok);
  const info = sb.handleReqInfo_({ id_token: 'TOK_U1', date: '2026-10-05' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(info.day.missing.options)), ['both']);
  assert(submit(sb, { kind: 'miss', date: '2026-10-05', miss_type: 'both', start: '09:00', end: '18:00', reason: '手機沒電' }).ok);
});
ok('撤銷：只能撤自己的、審核中的；別人撤不了', () => {
  const sb = makeEnv({});
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  assert.strictEqual(sb.handleReqCancel_({ id_token: 'TOK_U2', id: a.request.id }).error, 'not_found');
  assert(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' }).ok);
  assert.strictEqual(sb.handleReqCancel_({ id_token: 'TOK_U1', id: a.request.id }).error, 'not_pending');
});
ok('主管：停用的主管金鑰擋；退回要寫理由；處理過的不能再處理；取消的不能核准', () => {
  const sb = makeEnv({});
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  const b = submit(sb, { kind: 'ot', date: '2026-10-11', start: '21:00', end: '22:30', reason: '外送多' });
  assert.strictEqual(sb.handleMgrReqPending_({ mgr_key: 'OLD' }).error, 'unauthorized');
  const pend = sb.handleMgrReqPending_({ mgr_key: 'MK' });
  assert.strictEqual(pend.items.length, 2); assert.strictEqual(pend.items[0].id, a.request.id);   // 最舊的在前
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request.id, decision: 'reject' }).error, 'need_reason');
  assert(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request.id, decision: 'reject', reason: '人力已足' }).ok);
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request.id, decision: 'approve' }).error, 'not_pending');
  const c = submit(sb, { kind: 'leave', date: '2026-10-20', leave_type: '事假', hours: 4 });
  sb.handleReqCancel_({ id_token: 'TOK_U1', id: c.request.id });
  assert(/取消/.test(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: c.request.id, decision: 'approve' }).message));
});
ok('核定頁預填：mgr_req_day 只回那天「已核准」的，依工號分組', () => {
  const sb = makeEnv({});
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  submit(sb, { kind: 'ot', date: '2026-10-15', start: '21:00', end: '22:00', reason: 'x' });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  const d = sb.handleMgrReqDay_({ mgr_key: 'MK', date: '2026-10-15' });
  assert.strictEqual(d.by_emp.E01.length, 1); assert.strictEqual(d.by_emp.E01[0].leave_type, '特休假');
});
ok('打卡後告知：核准／退回各告知一次，看過就不再出現', () => {
  const sb = makeEnv({});
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  const b = submit(sb, { kind: 'ot', date: '2026-10-11', start: '21:00', end: '22:30', reason: '外送多' });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: b.request.id, decision: 'reject', reason: '人力已足' });
  const notes = sb.reqUnseenNotes_(sb.getSS(), 'E01');
  assert.strictEqual(notes.length, 2);
  assert(notes.some((x) => /^✓ 主管已核准：10\/15 特休假 整天 8 小時$/.test(x)), notes);
  assert(notes.some((x) => /^✕ 申請被退回：.*（人力已足）$/.test(x)), notes);
  assert.strictEqual(sb.reqUnseenNotes_(sb.getSS(), 'E01').length, 0);
});
ok('QR：同店、90 秒內、簽章對、主管在職才過；過期／別店／竄改／停用都擋', () => {
  const sb = makeEnv({});
  const t = sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'mztjs' });
  assert(t.ok && /^mztjs~\d+~2~[A-Za-z0-9_-]{16}$/.test(t.token), t.token);
  const win = +t.token.split('~')[1], at = (w) => w * 30000 + 1000;
  assert(sb.reqQrVerify_(t.token, at(win)).ok);
  assert(sb.reqQrVerify_(t.token, at(win + 2)).ok);
  assert(!sb.reqQrVerify_(t.token, at(win + 3)).ok);
  assert(!sb.reqQrVerify_(t.token, at(win - 1)).ok);   // 未來的窗
  const parts = t.token.split('~'); parts[2] = '3';
  assert(!sb.reqQrVerify_(parts.join('~'), at(win)).ok);   // 改主管序＝簽章不符
  sb.__props.QR_STORE = 'cf';
  assert(/不是這家店/.test(sb.reqQrVerify_(t.token, at(win)).reason));
  sb.__props.QR_STORE = 'mztjs';
  sb.__sheets.managers.data[1][2] = 'false';
  assert(/停用/.test(sb.reqQrVerify_(t.token, at(win)).reason));
  assert.strictEqual(sb.handleMgrQrToken_({ mgr_key: 'MK' }).error, 'unauthorized');
});
ok('requests 分頁第一次送出才建立，表頭固定', () => {
  const sb = makeEnv({});
  assert(!sb.__sheets.requests);
  submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  assert.strictEqual(sb.__sheets.requests.data[0].join(','), 'id,created_at,emp_id,name,kind,date,leave_type,start,end,hours,miss_type,reason,attach_id,status,decided_at,decided_by,reject_reason,seen_at');
});
ok('liff_punch 帶 QR：驗過才用店家座標打卡（距離 0）、記 qr_punch；QR 錯就不打卡；打卡成功回申請結果告知', () => {
  const sb = makeEnv({});
  const keep = ['verifyLineIdToken_', 'liffRosterByLine_', 'liffThrottled_', 'liffSiteThrottled_', 'liffEvents_'].map((k) => [k, sb[k]]);
  vm.runInContext(fs.readFileSync(ROOT + '/apps-script/Liff.gs', 'utf8') + '\n' + extract(codeSrc, 'lastCountedEvent'), sb);
  keep.forEach(([k, v]) => { sb[k] = v; });   // Liff.gs 會蓋掉這幾支假的，蓋回來
  // Liff.gs 會重新定義 liffThrottled_ 等；這裡只測 liffPunchFor_，打卡本身用假的 handleClock 接住參數
  const calls = []; sb.handleClock = (b) => { calls.push(b); return { ok: true, status: 'ok', ts: '2026-10-09T16:00:05+08:00' }; };
  sb.CacheService = { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) };
  const t = sb.handleMgrQrToken_({ mgr_key: 'MK', store: 'gk' });
  const me = { emp_id: 'E01', name: '測試一', key: 'k1', device_id: 'D1' };
  const a = submit(sb, { kind: 'leave', date: '2026-10-15', leave_type: '特休假', hours: 8 });
  sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' });
  let r = sb.liffPunchFor_('U1', me, sb.getSS(), 'in', { qr: t.token, lat: 0, lng: 0, accuracy: 3000 });
  assert(r.ok && r.via_qr, JSON.stringify(r));
  assert.strictEqual(calls[0].lat, 24.78); assert.strictEqual(calls[0].lng, 121.01); assert.strictEqual(calls[0].accuracy, 0);
  assert.strictEqual(sb.__sheets.qr_punch.data[1].join('|'), '2026-10-09T16:00:05+08:00|E01|in|測試主管');
  assert.strictEqual(r.req_notes.length, 1);
  r = sb.liffPunchFor_('U1', me, sb.getSS(), 'out', { qr: t.token.slice(0, -1) + (t.token.slice(-1) === 'A' ? 'B' : 'A') });
  assert(!r.ok && r.status === 'qr_invalid'); assert.strictEqual(calls.length, 1);
  r = sb.liffPunchFor_('U1', me, sb.getSS(), 'out', { lat: 24.7, lng: 121, accuracy: 10 });   // 沒帶 QR＝照舊用手機定位
  assert.strictEqual(calls[1].lat, 24.7); assert(!r.via_qr);
});
ok('審查 #2 跨夜班：D 晚上上班、D+1 凌晨下班＝D 不缺卡；D+1 只缺下班卡，不會多報上班卡', () => {
  const sb = makeEnv({ events: [ev('2026-10-06T18:00:00+08:00', 'in'), ev('2026-10-07T01:00:00+08:00', 'out'), ev('2026-10-07T18:00:00+08:00', 'in')] });
  const d6 = sb.handleReqInfo_({ id_token: 'TOK_U1', date: '2026-10-06' }).day;
  assert.strictEqual(d6.missing.options.length, 0, JSON.stringify(d6.missing));
  assert(d6.punches.some((p) => p.hm === '01:00(+1)'), JSON.stringify(d6.punches));
  const d7 = sb.handleReqInfo_({ id_token: 'TOK_U1', date: '2026-10-07' }).day;
  assert.strictEqual(d7.missing.options.join(), 'out', JSON.stringify(d7.missing));
  assert(submit(sb, { kind: 'miss', date: '2026-10-07', miss_type: 'out', end: '01:30', reason: '忘記按' }).ok);   // 補隔天凌晨下班
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-07', miss_type: 'out', end: '02:00', reason: '忘記按' }).error, 'duplicate');
});
ok('審查 #2 跨夜班：忘了上班卡、只有隔天凌晨下班卡 → 歸前一天，缺的是上班卡（不是整天兩張）', () => {
  const sb = makeEnv({ events: [ev('2026-10-07T01:00:00+08:00', 'out')] });
  const d6 = sb.handleReqInfo_({ id_token: 'TOK_U1', date: '2026-10-06' }).day;
  assert.strictEqual(d6.missing.options.join(), 'in'); assert(d6.missing.lone_out_next);
  assert(submit(sb, { kind: 'miss', date: '2026-10-06', miss_type: 'in', start: '18:00', reason: '忘記按' }).ok);
});
ok('審查 #3 今天：跨夜的下班時間（＝明天）或還沒到的時間都不能補', () => {
  const sb = makeEnv({ now: '2026-10-09T16:00:00+08:00' });
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-09', miss_type: 'both', start: '10:00', end: '02:00', reason: '忘記按' }).error, 'bad_time');
  assert.strictEqual(submit(sb, { kind: 'miss', date: '2026-10-09', miss_type: 'both', start: '10:00', end: '17:00', reason: '忘記按' }).error, 'bad_time');
  assert(submit(sb, { kind: 'miss', date: '2026-10-09', miss_type: 'both', start: '10:00', end: '15:00', reason: '忘記按' }).ok);
});
if (require.main === module) console.log(`\n${n} 項全部通過`);
