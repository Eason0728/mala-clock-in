// P3-3：LINE 送申請 req_submit 帶單號 req_id（契約 docs/contract-writeback.md 第 4 節）
// 同單號只寫一次（同一把鎖內查試算表）、申請編號＝單號（多段＝單號_n）、別人的單號不回、格式錯不寫；沒帶＝跟以前一樣。
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const YOU = { emp_id: 'E02', name: '測試二', key: 'K2', device_id: 'D2', active: 'TRUE', line_user_id: 'U2' };
const D = '2026-11-16';
const world = (props) => make({ now: T('2026-11-17T10:00:00'), props: Object.assign({ REQ_SEG2_KINDS: 'ot,leave,trip' }, props || {}), self: { roster: [ME, YOU], events: [] },
  fetch: (url, opt) => { let b = null; try { b = JSON.parse(opt.payload); } catch (e) { return undefined; } if (b && b.action === 'line_hub_req_quota') return { ok: true, quota: [], annual_from: '' }; return undefined; } });
const post = (m, b) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: 'req_submit', id_token: 'TOK_U1', date: D }, b)) } }).text); };
const rows = (m) => { const sh = m.self.sh.requests; if (!sh) return []; const h = sh.values[0]; return sh.values.slice(1).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] === undefined ? '' : r[i]; }); return o; }); };
const LV = { kind: 'leave', leave_type: '事假', hours: 8, reason: '家裡有事' };
const RID = 'r0123456789abcdef', RID2 = 'rfedcba9876543210';

{
  const m = world();
  const a = post(m, Object.assign({ req_id: RID }, LV));
  check('Q1', '帶單號：照常送出，申請編號＝單號', [a.ok, a.request && a.request.id, a.dup, rows(m).length, rows(m)[0].id], [true, RID, undefined, 1, RID]);
  const b = post(m, Object.assign({ req_id: RID }, LV));
  check('Q2', '同單號再送一次（mini 回來補送／手機改送）：不再寫，回原本那張＋dup', [b.ok, b.dup, b.request && b.request.id, b.summary === a.summary, rows(m).length], [true, true, RID, true, 1]);
  Object.keys(m.cache).forEach((k) => delete m.cache[k]);
  m.advance(26 * 3600000);
  const c = post(m, Object.assign({ req_id: RID }, LV));
  check('Q3', '暫存區全清、過了一天再送：仍只算一張（查的是試算表）', [c.ok, c.dup, rows(m).length], [true, true, 1]);
  m.run('READ_MEMO_ = null;');
  const dec = JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify({ action: 'mgr_req_decide', mgr_key: 'MK', id: RID, decision: 'approve' }) } }).text);
  const d = post(m, Object.assign({ req_id: RID }, LV));
  check('Q4', '主管核准後同號再送：回現在的狀態（approved）、不再寫', [dec.ok, d.dup, d.request && d.request.status, rows(m).length], [true, true, 'approved', 1]);
  const e = post(m, Object.assign({ req_id: RID, id_token: 'TOK_U2' }, LV));
  check('Q5', '別人拿同一個單號：req_id_taken、不寫、不回別人的單', [e.ok, e.error, e.request, rows(m).length], [false, 'req_id_taken', undefined, 1]);
  const f = post(m, Object.assign({ req_id: 'abc' }, LV));
  const g = post(m, Object.assign({ req_id: 'R0123456789ABCDEF' }, LV));
  check('Q6', '單號格式不對：bad_req_id、不寫', [f.error, g.error, rows(m).length], ['bad_req_id', 'bad_req_id', 1]);
  const h = post(m, Object.assign({ req_id: '', date: '2026-11-15' }, LV));
  check('Q7', '單號空字串＝沒帶：照以前自己編號', [h.ok, h.request && /^r[0-9a-z]+$/.test(h.request.id) && h.request.id !== RID, rows(m).length], [true, true, 2]);
}
{
  const m = world();
  const body = { req_id: RID2, kind: 'leave', leave_type: '事假', reason: '看醫生', segments: [{ start: '14:00', end: '16:00' }, { start: '10:00', end: '12:00' }] };
  const a = post(m, body);
  check('Q8', '一次兩段帶單號：兩列，編號＝單號_1、單號_2（照時間先後）', [a.ok, (a.requests || []).map((x) => x.id), rows(m).map((x) => x.id), rows(m).map((x) => x.start)],
    [true, [RID2 + '_1', RID2 + '_2'], [RID2 + '_1', RID2 + '_2'], ['10:00', '14:00']]);
  const b = post(m, body);
  check('Q9', '兩段同號再送：不再寫，回兩張＋dup', [b.ok, b.dup, (b.requests || []).map((x) => x.id), b.group === a.group, b.summary === a.summary, rows(m).length], [true, true, [RID2 + '_1', RID2 + '_2'], true, true, 2]);
  const c = post(m, Object.assign({ req_id: RID2 }, LV));
  check('Q10', '兩段的單號拿去送單張：也算寫過（回那兩張）', [c.dup, (c.requests || []).length, rows(m).length], [true, 2, 2]);
}
{
  const m = world();
  let flushed = 0; m.sb.SpreadsheetApp.flush = () => { flushed++; };
  post(m, Object.assign({ date: '2026-11-15' }, LV));
  const f0 = flushed;
  post(m, Object.assign({ req_id: RID }, LV));
  check('Q11', '有單號才在放鎖前 flush（沒單號的流程不多做事）', [f0, flushed - f0], [0, 1]);
}
done();
