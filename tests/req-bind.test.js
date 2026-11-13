// 核定工時綁定申請單（2026-11-06 Eason）：超過 8 小時要有加班單、少卡要有忘打卡單，沒有就整天送不出；
// 超過 7 天同仁補不了 → 店長在管理系統代開（mgr_req_proxy），代開的單只有總監層級（營運系統代轉時帶 director_ok）能審。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
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
    appendRow(row) { data.push(row.slice()); },
    getLastColumn() { return data[0] ? data[0].length : 0; },
  };
}
function makeEnv(now) {
  const sheets = {
    managers: sheet('managers', [['name', 'key', 'active', 'allow_acting'], ['測試主管', 'MK', 'true', ''], ['門市營運系統', 'SYS', 'true', 'TRUE']]),
    roster: sheet('roster', [['emp_id', 'name', 'active', 'line_user_id'], ['E01', '測試一', 'true', 'U1'], ['E02', '測試二', 'true', '']]),
  };
  const props = {};
  let nowIso = now || '2026-11-20T16:00:00+08:00';
  let rnd = 0;
  const seqMath = Object.assign(Object.create(Math), { random: () => (rnd++ % 1296) / 1296 });
  const sb = {
    console, Date, JSON, Math: seqMath, String, Number, isNaN, isFinite, parseInt, Object, Array, RegExp,
    CONFIG: {},
    getSS: () => ({ getSheetByName: (nm) => sheets[nm] || null, insertSheet: (nm) => (sheets[nm] = sheet(nm)) }),
    readSheetAsObjects: (sh) => {
      const h = sh.data[0] || [];
      return { headers: h, rows: sh.data.slice(1).map((r, i) => { const o = { __rowIndex: i + 2 }; h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; }); return o; }) };
    },
    normCellDate: (v) => String(v), normCellTs: (v) => String(v),
    nowTaipeiIso: () => nowIso, todayTaipeiStr: () => nowIso.slice(0, 10),
    liffEvents_: () => sb.__events,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  };
  sb.__events = [];
  vm.createContext(sb);
  vm.runInContext([extractConst(codeSrc, 'LEAVE_TYPES'), extract(codeSrc, 'findManagerByKey'), extract(codeSrc, 'actingName_'), extract(codeSrc, 'sheetSafeText_'),
                   extract(codeSrc, 'findRosterByEmpId'), extract(codeSrc, 'gapExplainedByBreak'),
                   fs.readFileSync(ROOT + '/apps-script/Requests.gs', 'utf8')].join('\n'), sb);
  // 這支測代開與綁單，測試的「今天」在 11/20：先把 T01 不限期限（11/28 以前 11 月的日子同仁能自己補）關掉，照 4 天規則測（T01 那段見 req-past-4d.test.js）
  vm.runInContext("REQ_PAST_OPEN_TO_ = '2026-10-31';", sb);
  sb.__sheets = sheets; sb.__props = props;
  return sb;
}
const D = '2026-11-10';
const ms = (hm, d) => Date.parse((d || D) + 'T' + hm + ':00+08:00');
const P = (a, b) => ({ startMs: ms(a), endMs: ms(b) });
const S = (a, b) => ({ inMs: a ? ms(a) : null, outMs: b ? ms(b) : null });
const BRK = { startMs: ms('12:00'), endMs: ms('13:00') };
// 直接往 requests 分頁塞已核准／審核中的單
function addReq(sb, r) {
  const ss = sb.getSS();
  const sh = sb.reqSheet_(ss, true);
  const row = Object.assign({ id: 'x' + Math.random(), created_at: '2026-11-10T20:00:00+08:00', emp_id: 'E01', name: '測試一', date: D, status: 'approved' }, r);
  sh.appendRow(sb.reqHeads_(sh).map((h) => (row[h] === undefined ? '' : row[h])));
}

/* ── 少幾張卡 ── */
const sb0 = makeEnv();
ok('打卡完整一段＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [S('08:55', '17:05')], null), 0));
ok('央廚中午休息帶：兩段核定、一段打卡＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('08:00', '12:00'), P('13:00', '17:00')], [S('07:58', '17:02')], BRK), 0));
ok('沒有休息帶的店中間休息沒打＝2 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '21:00')], null), 2));
ok('拆段核定（間隔 0）＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00'), P('17:00', '19:00')], [S('09:00', '19:00')], null), 0));
ok('只有上班卡＝1 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [S('08:55', null)], null), 1));
ok('完全沒打卡＝2 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('09:00', '17:00')], [], null), 2));
ok('兩段各自打卡＝0 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '14:00'), S('17:00', '21:00')], null), 0));
ok('第二段只有下班卡＝1 張', () => assert.strictEqual(sb0.reqBindMissCards_([P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '14:00'), S(null, '21:00')], null), 1));

/* ── 核定檢查 ── */
ok('8 小時整、打卡完整＝放行', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [S('09:00', '17:00')], null), null);
});
ok('9.5 小時沒加班單＝擋，訊息講缺 1.5 小時', () => {
  const sb = makeEnv();
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.strictEqual(r.error, 'need_request');
  assert.ok(/1\.5 小時要有加班單/.test(r.message), r.message);
  assert.strictEqual(r.need.ot_hours, 1.5);
});
ok('加班單 1 小時不夠蓋 1.5 小時＝擋；再一張 0.5 小時就放行', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', start: '17:00', end: '18:00', hours: 1 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null).error, 'need_request');
  addReq(sb, { kind: 'ot', start: '18:00', end: '18:30', hours: 0.5 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null), null);
});
ok('審核中的加班單不算，訊息提醒先去審核', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', start: '17:00', end: '18:30', hours: 1.5, status: 'pending' });
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(/1 張申請還在審核中/.test(r.message), r.message);
});
ok('沒綁 LINE：第一張還在審核，訊息帶沒綁 LINE，可繼續代開第二張；有綁 LINE 不帶', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'miss', emp_id: 'E02', miss_type: 'out', end: '18:30', status: 'pending' });
  const r = sb.reqBindCheck_(sb.getSS(), 'E02', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(/1 張申請還在審核中/.test(r.message) && /沒綁 LINE/.test(r.message), r.message);
  addReq(sb, { kind: 'miss', emp_id: 'E01', miss_type: 'out', end: '18:30', status: 'pending' });
  const r2 = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(!/沒綁 LINE/.test(r2.message), r2.message);
});
ok('別人的單、別天的單不算', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'ot', hours: 2, emp_id: 'E02' });
  addReq(sb, { kind: 'ot', hours: 2, date: '2026-11-11' });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null).error, 'need_request');
});
ok('少下班卡：有已核准的忘打卡（補下班）就放行', () => {
  const sb = makeEnv();
  const args = [sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [S('09:00', null)], null];
  assert.ok(/少了 1 張打卡/.test(sb.reqBindCheck_(...args).message));
  addReq(sb, { kind: 'miss', miss_type: 'out', end: '17:00' });
  assert.strictEqual(sb.reqBindCheck_(...args), null);
});
ok('中間休息沒打 2 張：補休息單（算 2 張）就放行', () => {
  const sb = makeEnv();
  const args = [sb.getSS(), 'E01', D, 7, [P('11:00', '14:00'), P('17:00', '21:00')], [S('11:00', '21:00')], null];
  assert.strictEqual(sb.reqBindCheck_(...args).need.miss_cards, 2);
  addReq(sb, { kind: 'miss', miss_type: 'break', start: '17:00', end: '14:00' });
  assert.strictEqual(sb.reqBindCheck_(...args), null);
});
ok('那天有已核准的出差單：整天沒打卡不擋；有打卡湊不成完整一段照樣要忘打卡單（2026-11-10 Eason；超時仍要加班單）', () => {
  const sb = makeEnv();
  addReq(sb, { kind: 'trip', leave_type: '出差', hours: 4 });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [], null), null);
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '17:00')], [S('09:00', null)], null).error, 'need_request');
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 8, [P('09:00', '13:00'), P('14:00', '18:00')], [S('09:00', '13:00')], null), null, '出差半天：另一段打卡完整 → 不用忘打卡單');
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9, [P('09:00', '18:00')], [], null).error, 'need_request');
});
ok('超時＋缺卡兩個問題一起講', () => {
  const sb = makeEnv();
  const r = sb.reqBindCheck_(sb.getSS(), 'E01', D, 10, [P('09:00', '19:00')], [S('09:00', null)], null);
  assert.ok(/加班單/.test(r.message) && /忘打卡單/.test(r.message), r.message);
});
ok('整天請假（沒有時段）不看', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 0, [], [], null), null);
});
ok('上線日以前的日子不擋；REQ_BIND_FROM 可改、off 整個關掉', () => {
  const sb = makeEnv();
  const a = (d) => sb.reqBindCheck_(sb.getSS(), 'E01', d, 9, [P('09:00', '18:00')], [], null);
  assert.strictEqual(a('2026-10-31'), null);
  assert.strictEqual(a('2026-11-01').error, 'need_request');   // 2026-11-13 起算日改 11/1
  assert.strictEqual(a('2026-11-05').error, 'need_request');
  sb.__props.REQ_BIND_FROM = '2026-12-01';
  assert.strictEqual(a('2026-11-10'), null);
  sb.__props.REQ_BIND_FROM = 'off';
  assert.strictEqual(a('2026-12-10'), null);
});

/* ── Code.gs 掛鉤位置 ── */
ok('handleMgrApprove 在寫入核定前呼叫 reqBindCheck_，舊 Requests 沒有就跳過', () => {
  const fn = extract(codeSrc, 'handleMgrApprove');
  const i = fn.indexOf("typeof reqBindCheck_ === 'function'"), j = fn.indexOf('appendApprovedRow_(');
  assert.ok(i > 0 && j > i, '掛鉤要在 appendApprovedRow_ 之前');
  assert.ok(/reqBindCheck_\(ss, String\(body\.emp_id\), date, approvedHours, periodsMs, punchMs, noPunchBreakWindow\(date\),/.test(fn));
});

/* ── 主管代開 ── */
const ACT = { mgr_key: 'SYS', acting_name: '林店長（S1）' };
const proxyBody = (o) => Object.assign({ action: 'mgr_req_proxy', emp_id: 'E01', kind: 'ot', date: '2026-11-10', start: '18:00', end: '19:30', reason: '盤點' }, ACT, o);
ok('代開只能用營運系統個人帳號（本店主管鑰匙不行）', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ mgr_key: 'MK', acting_name: undefined })).error, 'acting_only');
});
ok('4 天內不能代開（2026-11-14 由 7 改 4）；超過 90 天也不行', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ date: '2026-11-16' })).error, 'not_old');
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ date: '2026-08-01' })).error, 'too_old');
});
ok('沒綁 LINE：今天和 7 天內可代開，一樣送總監審；未來日期不行；有綁 LINE 照舊不行', () => {
  const sb = makeEnv();
  const r = sb.handleMgrReqProxy_(proxyBody({ emp_id: 'E02', date: '2026-11-13' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.request.proxy_by, '林店長（S1）');
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ emp_id: 'E02', kind: 'leave', leave_type: '事假', hours: 4, reason: '家裡有事', date: sb.todayTaipeiStr() })).ok, true);
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ emp_id: 'E02', date: '2026-12-31' })).error, 'not_old');
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ emp_id: 'E01', date: '2026-11-16' })).error, 'not_old');
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ emp_id: 'E02', date: '2026-08-01' })).error, 'too_old');
});
ok('核定被擋：沒綁 LINE 叫店長代開，有綁 LINE 照舊叫同仁補', () => {
  const sb = makeEnv();
  const a = sb.reqBindCheck_(sb.getSS(), 'E02', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(/沒綁 LINE/.test(a.message) && /代開申請/.test(a.message), a.message);
  const b = sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null);
  assert.ok(!/沒綁 LINE/.test(b.message) && /在 LINE/.test(b.message), b.message);
});
ok('只限加班、忘打卡', () => {
  const sb = makeEnv();
  assert.strictEqual(sb.handleMgrReqProxy_(proxyBody({ kind: 'xx' })).error, 'bad_kind');
});
ok('代開成功：審核中、記代開人、摘要標主管代開', () => {
  const sb = makeEnv();
  const r = sb.handleMgrReqProxy_(proxyBody());
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.request.status, 'pending');
  assert.strictEqual(r.request.proxy_by, '林店長（S1）');
  assert.ok(/（主管代開）$/.test(r.summary), r.summary);
});
ok('忘打卡代開照樣檢查那天真的缺卡', () => {
  const sb = makeEnv();
  sb.__events = [{ ts: '2026-11-10T09:00:00+08:00', emp_id: 'E01', type: 'in', status: 'ok' }];
  const bad = sb.handleMgrReqProxy_(proxyBody({ kind: 'miss', miss_type: 'in', start: '09:00', end: '' }));
  assert.strictEqual(bad.error, 'not_missing');
  const good = sb.handleMgrReqProxy_(proxyBody({ kind: 'miss', miss_type: 'out', start: '', end: '17:00' }));
  assert.ok(good.ok, JSON.stringify(good));
});
ok('代開的單：本店主管、沒有 director_ok、代開人自己都不能審；總監層級可以', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody()).request.id;
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id, decision: 'approve' }).error, 'director_review');
  assert.strictEqual(sb.handleMgrReqDecide_(Object.assign({ id, decision: 'approve' }, ACT)).error, 'director_review');
  assert.strictEqual(sb.handleMgrReqDecide_(Object.assign({ id, decision: 'approve', director_ok: true }, ACT)).error, 'self_proxy');
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: 'true' }).error, 'director_review', '字串 true 不算');
  const r = sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.ok(r.ok && r.status === 'approved', JSON.stringify(r));
});
ok('待審清單：代開的單標 upper／director', () => {
  const sb = makeEnv();
  sb.handleMgrReqProxy_(proxyBody());
  const it = sb.handleMgrReqPending_({ mgr_key: 'MK' }).items[0];
  assert.strictEqual(it.upper, true);
  assert.strictEqual(it.upper_kind, 'director');
});
ok('批次核准跳過代開的單；作廢也要總監層級', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody()).request.id;
  const b = sb.handleMgrReqDecideBatch_({ mgr_key: 'MK', ids: [id], decision: 'approve' });
  assert.strictEqual(b.done.length, 0);
  assert.ok(/總監層級/.test(b.skipped[0].reason));
  sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.strictEqual(sb.handleMgrReqVoid_({ mgr_key: 'MK', id, reason: '錯' }).error, 'director_review');
  assert.ok(sb.handleMgrReqVoid_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, reason: '錯', director_ok: true }).ok);
});
ok('代開核准後，那天核定就過得了加班那關', () => {
  const sb = makeEnv();
  const id = sb.handleMgrReqProxy_(proxyBody({ start: '17:00', end: '18:30' })).request.id;
  sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id, decision: 'approve', director_ok: true });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D, 9.5, [P('09:00', '18:30')], [S('09:00', '18:30')], null), null);
});
ok('同仁自己送的單不受影響（照舊本店主管審）', () => {
  const sb = makeEnv();
  addReq(sb, { id: 'own1', kind: 'ot', hours: 1, status: 'pending' });
  assert.ok(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: 'own1', decision: 'approve' }).ok);
});

/* ── 核定加嚴（2026-11-11 起）── */
const D2 = '2026-11-20';
const P2 = (a, b) => ({ startMs: ms(a, D2), endMs: ms(b, D2) });
const S2 = (a, b) => ({ inMs: a ? ms(a, D2) : null, outMs: b ? ms(b, D2) : null });
const R2 = (o) => Object.assign({ date: D2 }, o);
const chk = (sb, h, ps, ss, opt) => sb.reqBindCheck_(sb.getSS(), 'E01', D2, h, ps, ss, null, opt);
const full95 = [P2('09:00', '18:30')], seg95 = [S2('09:00', '18:30')];
ok('11/10 以前只跑舊規則：時段不對不擋', () => {
  const sb = makeEnv();
  addReq(sb, { date: '2026-11-10', kind: 'ot', start: '06:00', end: '07:30', hours: 1.5 });
  const P15 = (a, b) => ({ startMs: ms(a, '2026-11-10'), endMs: ms(b, '2026-11-10') });
  const S15 = (a, b) => ({ inMs: ms(a, '2026-11-10'), outMs: ms(b, '2026-11-10') });
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', '2026-11-10', 9.5, [P15('09:00', '18:30')], [S15('09:00', '18:30')], null, {}), null);
});
ok('規則 1：時段在核定內放行；前後 15 分鐘內放行；超過擋', () => {
  let sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:00', end: '18:30', hours: 1.5 }));
  assert.strictEqual(chk(sb, 9.5, full95, seg95, {}), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:15', end: '18:45', hours: 1.5 }));
  assert.strictEqual(chk(sb, 9.5, full95, seg95, {}), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:30', end: '19:00', hours: 1.5 }));
  const r = chk(sb, 9.5, full95, seg95, {});
  assert.strictEqual(r.error, 'need_request'); assert.ok(/不在核定時段內/.test(r.message), r.message);
});
ok('規則 1：跨夜班凌晨的加班單算得進去；當天有出差時數不比時段', () => {
  let sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '00:00', end: '01:30', hours: 1.5 }));
  const night = [{ startMs: ms('16:00', D2), endMs: ms('01:30', '2026-11-21') }];
  assert.strictEqual(chk(sb, 9.5, night, [{ inMs: night[0].startMs, outMs: night[0].endMs }], {}), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '06:00', end: '07:30', hours: 1.5 })); addReq(sb, R2({ kind: 'trip', leave_type: '出差', hours: 2 }));
  assert.strictEqual(chk(sb, 9.5, [P2('09:00', '16:30')], [S2('09:00', '16:30')], { trip_hours: 2, leaves: [{ type: '出差', hours: 2 }] }), null);
});
ok('規則 2：單少擋、多 15 分鐘內放行、多更多擋', () => {
  let sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:00', end: '18:15', hours: 1.25 }));
  assert.ok(/1\.5 小時要有加班單/.test(chk(sb, 9.5, full95, seg95, {}).message));
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:00', end: '18:45', hours: 1.75 }));
  assert.strictEqual(chk(sb, 9.5, full95, seg95, {}), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '17:00', end: '18:45', hours: 2 }));
  assert.ok(/多超過 15 分鐘/.test(chk(sb, 9.5, full95, seg95, {}).message));
});
ok('規則 2：休息日／例假整天都算加班；班表查不到或上班日照一般日', () => {
  const ps = [P2('10:00', '14:00')], ss = [S2('10:00', '14:00')];
  let sb = makeEnv();
  assert.ok(/都算加班/.test(chk(sb, 4, ps, ss, { sched_day: 'H' }).message));
  assert.ok(/都算加班/.test(chk(sb, 4, ps, ss, { sched_day: 'R' }).message));
  assert.strictEqual(chk(sb, 4, ps, ss, { sched_day: 'W' }), null);
  assert.strictEqual(chk(sb, 4, ps, ss, {}), null);
  sb = makeEnv(); addReq(sb, R2({ kind: 'ot', start: '10:00', end: '14:00', hours: 4 }));
  assert.strictEqual(chk(sb, 4, ps, ss, { sched_day: 'H' }), null);
  assert.ok(/請先把加班單作廢/.test(chk(sb, 4, ps, ss, {}).message), '查不到班表＝一般日，未滿 8 小時有單要作廢');
  assert.strictEqual(chk(sb, 4, ps, ss, { acting: false }), null, '舊值班頁不知道班表，休息日的加班單不能被判成要作廢');
});
ok('規則 3：沒單擋、假別不同擋、時數不同擋、有單沒登記擋、相符放行', () => {
  const ps = [P2('09:00', '13:00')], ss = [S2('09:00', '13:00')];
  let sb = makeEnv();
  assert.ok(/沒有已核准的假單/.test(chk(sb, 4, ps, ss, { leaves: [{ type: '病假', hours: 4 }] }).message));
  sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '事假', hours: 4 }));
  const m = chk(sb, 4, ps, ss, { leaves: [{ type: '病假', hours: 4 }] }).message;
  assert.ok(/病假/.test(m) && /有已核准的事假/.test(m), m);
  sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '病假', hours: 4 }));
  assert.ok(/已核准的單是 4 小時/.test(chk(sb, 4, ps, ss, { leaves: [{ type: '病假', hours: 3 }] }).message));
  assert.ok(/核定沒有登記/.test(chk(sb, 4, ps, ss, { leaves: [] }).message));
  assert.strictEqual(chk(sb, 4, ps, ss, { leaves: [{ type: '病假', hours: 4 }] }), null);
});
ok('規則 3：整天請假（沒有時段）也看；審核中的假單不算', () => {
  let sb = makeEnv();
  assert.strictEqual(chk(sb, 0, [], [], { leaves: [{ type: '特休', hours: 8 }] }).error, 'need_request');
  addReq(sb, R2({ kind: 'leave', leave_type: '特休', hours: 8, status: 'pending' }));
  assert.ok(/審核中/.test(chk(sb, 0, [], [], { leaves: [{ type: '特休', hours: 8 }] }).message));
  sb = makeEnv(); addReq(sb, R2({ kind: 'leave', leave_type: '特休', hours: 8 }));
  assert.strictEqual(chk(sb, 0, [], [], { leaves: [{ type: '特休', hours: 8 }] }), null);
});
ok('規則 4：差 30 分鐘要原因、29 分鐘不用、有原因放行、缺卡不比、休息帶扣掉', () => {
  const sb = makeEnv();
  const r = chk(sb, 7.5, [P2('09:00', '16:30')], [S2('09:00', '17:00')], {});
  assert.strictEqual(r.error, 'need_diff_reason'); assert.strictEqual(r.diff_min, 30);
  assert.strictEqual(chk(sb, 7.5, [P2('09:00', '16:30')], [{ inMs: ms('09:00', D2), outMs: ms('16:59', D2) }], {}), null);
  assert.strictEqual(chk(sb, 7.5, [P2('09:00', '16:30')], [S2('09:00', '17:00')], { diff_reason: '  提早離開，店長同意 ' }), null);
  assert.strictEqual(chk(sb, 7.5, [P2('09:00', '16:30')], [S2('09:00', '17:00')], { diff_reason: '   ' }).error, 'need_diff_reason');
  const brk = { startMs: ms('12:00', D2), endMs: ms('13:00', D2) };
  assert.strictEqual(sb.reqBindCheck_(sb.getSS(), 'E01', D2, 8, [P2('08:00', '12:00'), P2('13:00', '17:00')], [S2('08:00', '17:00')], brk, {}), null);
  assert.ok(/舊的值班核定頁/.test(chk(sb, 7.5, [P2('09:00', '16:30')], [S2('09:00', '17:00')], { acting: false }).message));
});
ok('開關：REQ_STRICT_FROM off 只關加嚴；REQ_BIND_FROM off 全關', () => {
  let sb = makeEnv(); sb.__props.REQ_STRICT_FROM = 'off'; addReq(sb, R2({ kind: 'ot', start: '06:00', end: '07:30', hours: 1.5 }));
  assert.strictEqual(chk(sb, 9.5, full95, seg95, {}), null);
  assert.strictEqual(chk(sb, 10, [P2('09:00', '19:00')], [S2('09:00', '19:00')], {}).error, 'need_request');
  sb = makeEnv(); sb.__props.REQ_BIND_FROM = 'off';
  assert.strictEqual(chk(sb, 10, [P2('09:00', '19:00')], [S2('09:00', '19:00')], {}), null);
});
ok('代開假單與出差單：超過 7 天可開、7 天內不行、核准後核定過得了', () => {
  const sb = makeEnv();
  const base = { mgr_key: 'SYS', acting_name: '王店長（S1）', emp_id: 'E01', date: D, reason: '補單' };
  assert.strictEqual(sb.handleMgrReqProxy_(Object.assign({}, base, { kind: 'leave', leave_type: '事假', hours: 4, date: '2026-11-18' })).error, 'not_old');
  assert.strictEqual(sb.handleMgrReqProxy_(Object.assign({}, base, { kind: 'leave', leave_type: '事假', hours: 4, reason: '' })).error, 'need_reason');
  const a = sb.handleMgrReqProxy_(Object.assign({}, base, { kind: 'leave', leave_type: '事假', hours: 4 }));
  assert.ok(a.ok, JSON.stringify(a));
  assert.strictEqual(sb.handleMgrReqDecide_({ mgr_key: 'MK', id: a.request.id, decision: 'approve' }).error, 'director_review');
  assert.ok(sb.handleMgrReqDecide_({ mgr_key: 'SYS', acting_name: '王總監（S9）', id: a.request.id, decision: 'approve', director_ok: true }).ok);
  const t = sb.handleMgrReqProxy_(Object.assign({}, base, { kind: 'trip', hours: 3, place: '總部辦公室', why: '會議', date: '2026-11-09' }));
  assert.ok(t.ok, JSON.stringify(t));
});
ok('核定紀錄：有原因才補 diff_reason 欄，沒有就照舊 8 欄', () => {
  const sb = makeEnv();
  vm.runInContext(extractConst(codeSrc, 'APPROVED_HEADERS') + extract(codeSrc, 'appendApprovedRow_'), sb);
  const sh = sheet('approved', [['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at']]);
  const row8 = [D2, 'E01', '測試一', '09:00-16:30', 7.5, '正常', '主管', 'x'];
  sb.appendApprovedRow_(sh, row8, [], '');
  assert.strictEqual(sh.data[0].length, 8); assert.strictEqual(sh.data[1].length, 8);
  sb.appendApprovedRow_(sh, row8, [], '提早離開');
  assert.deepStrictEqual(sh.data[0].slice(8), ['dup_ignore', 'diff_reason']);
  assert.strictEqual(sh.data[2][9], '提早離開'); assert.strictEqual(sh.data[2][8], '');
  sb.appendApprovedRow_(sh, row8, ['t1'], '');
  assert.strictEqual(sh.data[3][8], '["t1"]');
});
ok('只讀試算：列出問題、不寫入', () => {
  const sb = makeEnv();
  addReq(sb, R2({ kind: 'ot', start: '06:00', end: '07:30', hours: 1.5 }));
  const sheets = sb.__sheets;
  sheets.approved = sheet('approved', [['date', 'emp_id', 'name', 'periods', 'approved_hours'], [D2, 'E01', '測試一', '09:00-18:30', 9.5], [D2, 'E02', '測試二', '09:00-17:00', 8]]);
  sheets.events = sheet('events', [['ts']]); sheets.leave = sheet('leave', [['日期', '姓名', '假別', '時數'], [D2, '測試二', '病假', 1]]);
  Object.assign(sb, {
    checkAdmin: (b) => b.admin_key === 'AK',
    buildLatestApprovedMap: (rows) => { const m = {}; rows.forEach((r) => { (m[r.date] = m[r.date] || {})[r.emp_id] = r; }); return m; },
    dupIgnoreSet_: () => ({}), dropDupIgnored_: (e) => e, noPunchBreakWindow: () => null, addDaysStr: (d) => d,
    parsePeriodsStr: (x) => String(x).split(',').map((y) => ({ start: y.split('-')[0], end: y.split('-')[1] })),
    dayPunchSegments: (e, emp) => ({ segments: [emp === 'E01' ? { in: '09:00', out: '18:30' } : { in: '09:00', out: '17:00' }] }),
  });
  const before = JSON.stringify(sheets);
  assert.strictEqual(sb.handleApproveStrictPreview_({ admin_key: 'x', from: D2, to: D2 }).error, 'unauthorized');
  const r = sb.handleApproveStrictPreview_({ admin_key: 'AK', from: D2, to: D2 });
  assert.strictEqual(r.scanned, 2); assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].probs[0].rule, 'ot_slot');
  assert.strictEqual(r.items[1].probs[0].rule, 'leave');
  assert.strictEqual(JSON.stringify(sheets), before);
});
/* ── 已核定但缺單的日子打回待核定（2026-11-13，bind_revoke）── */
ok('bind_revoke：試算只讀；apply 把缺加班單、缺忘打卡單那幾天的核定列搬到 approved_revoked，有單的不動', () => {
  const sb = makeEnv('2026-11-13T10:00:00+08:00');
  const DA = '2026-11-03', DB = '2026-11-04';
  addReq(sb, { emp_id: 'E02', name: '測試二', date: DA, kind: 'ot', start: '17:00', end: '18:00', hours: 1 });
  const sheets = sb.__sheets;
  const H = ['date', 'emp_id', 'name', 'periods', 'approved_hours', 'status_text', 'manager_name', 'entered_at', 'mirror_src'];
  sheets.approved = sheet('approved', [H,
    [DA, 'E01', '測試一', '09:00-18:00', 9, '正常', '店長', '2026-11-03T22:00:00+08:00'],      // 舊的一筆
    [DA, 'E01', '測試一', '09:00-18:30', 9.5, '正常', '店長', '2026-11-03T23:00:00+08:00'],    // 最新：缺 1.5 小時加班單
    [DA, 'E02', '測試二', '09:00-18:00', 9, '正常', '店長', '2026-11-03T22:00:00+08:00'],      // 有 1 小時加班單：不動
    [DB, 'E01', '測試一', '09:00-17:00', 8, '下班忘刷卡', '店長', '2026-11-04T22:00:00+08:00'], // 少 1 張卡沒有忘打卡單
    ['2026-10-31', 'E01', '測試一', '09:00-19:00', 10, '正常', '店長', '2026-10-31T22:00:00+08:00'],
    [DB, 'HQ-01', '鏡像', '09:00-19:00', 10, '正常', '店長', '2026-11-04T22:00:00+08:00', 'CF']]);   // 鏡像列：不看、不搬
  const sh = sheets.approved;
  sh.getDataRange = () => ({ getValues: () => sh.data.map((r) => r.slice()) });
  sh.deleteRow = (r) => { sh.data.splice(r - 1, 1); };
  sheets.events = sheet('events', [['ts']]); sheets.leave = sheet('leave', [['日期', '姓名', '假別', '時數']]);
  Object.assign(sb, {
    checkAdmin: (b) => b.admin_key === 'AK',
    buildLatestApprovedMap: (rows) => { const m = {}; rows.forEach((r) => { const c = (m[r.date] = m[r.date] || {}); if (!c[r.emp_id] || r.entered_at >= c[r.emp_id].entered_at) c[r.emp_id] = r; }); return m; },
    dupIgnoreSet_: () => ({}), dropDupIgnored_: (e) => e, noPunchBreakWindow: () => null, addDaysStr: (d) => d,
    parsePeriodsStr: (x) => String(x).split(',').map((y) => ({ start: y.split('-')[0], end: y.split('-')[1] })),
    dayPunchSegments: (e, emp, d) => ({ segments: [d === DB ? { in: '09:00', out: null } : emp === 'E01' ? { in: '09:00', out: '18:30' } : { in: '09:00', out: '18:00' }] }),
    SpreadsheetApp: { flush() {} },
  });
  assert.strictEqual(sb.handleBindRevoke_({ admin_key: 'x', from: DA, to: DB }).error, 'unauthorized');
  assert.strictEqual(sb.handleBindRevoke_({ admin_key: 'AK', from: '2026-10-31', to: DB }).error, 'before_bind');
  assert.strictEqual(sb.handleBindRevoke_({ admin_key: 'AK', from: DA, to: '2026-11-11' }).error, 'strict_range');
  const before = JSON.stringify(sh.data);
  const pv = sb.handleBindRevoke_({ admin_key: 'AK', from: '2026-11-01', to: '2026-11-05' });
  assert.strictEqual(pv.apply, false); assert.strictEqual(pv.scanned, 3);
  assert.strictEqual(JSON.stringify(pv.items.map((x) => x.date + ' ' + x.emp_id)), JSON.stringify([DA + ' E01', DB + ' E01']));
  assert.ok(/加班單/.test(pv.items[0].probs[0]), pv.items[0].probs[0]);
  assert.ok(/忘打卡單/.test(pv.items[1].probs[0]), pv.items[1].probs[0]);
  assert.strictEqual(JSON.stringify(sh.data), before);   // 試算不寫
  assert.ok(!sheets.approved_revoked);
  const ap = sb.handleBindRevoke_({ admin_key: 'AK', from: '2026-11-01', to: '2026-11-05', apply: true });
  assert.strictEqual(ap.moved, 3);   // E01 11/3 兩筆（含舊的）＋ E01 11/4 一筆
  assert.strictEqual(JSON.stringify(sh.data.slice(1).map((r) => r[0] + ' ' + r[1])), JSON.stringify([DA + ' E02', '2026-10-31 E01', DB + ' HQ-01']));
  const bak = sheets.approved_revoked.data;
  assert.strictEqual(JSON.stringify(bak[0]), JSON.stringify(H.concat(['revoked_at', 'revoke_reason'])));
  assert.strictEqual(bak.length, 4);
  assert.deepStrictEqual(bak.slice(1).map((r) => r[4]), [9, 9.5, 8]);   // 原順序留底、數字原樣
  assert.ok(bak.slice(1).every((r) => r[9] === '2026-11-13T10:00:00+08:00' && r[10]));
  const again = sb.handleBindRevoke_({ admin_key: 'AK', from: '2026-11-01', to: '2026-11-05', apply: true });
  assert.strictEqual(again.moved, 0);   // 再跑一次不會多搬
});
console.log('req-bind: ' + n + ' 項全過');
