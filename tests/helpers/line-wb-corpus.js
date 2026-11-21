// line-wb-same.test.js 用（不是測試）：在 GS_ROOT 那一版程式上跑一組「沒帶簽名」的 LINE 申請請求（非光復店設定），
// 印出全部回應、試算表最後內容、暫存區鍵、屬性讀取次數、連外請求內容（JSON），用來證明方案 A 改版後沒帶簽名＝逐字同改版前。
'use strict';
const { make, T } = require('./gs-sandbox');
const HUB = 'https://hub.test/exec';
const ROSTER = [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' },
  { emp_id: 'E03', name: '測試三', key: 'K3', active: 'FALSE', line_user_id: 'U3' }];
const props = JSON.parse(process.env.CORPUS_PROPS || '{}');
const fetches = [];
const m = make({ now: T('2026-11-17T10:00:00'), props: Object.assign({ REQ_SEG2_KINDS: 'ot,leave,trip' }, props), config: { PAYROLL_API: HUB, PAYROLL_STORE: 'MZTJS' },
  self: { roster: ROSTER, events: [['2026-11-16T09:00:00', 'E01', 'in'], ['2026-11-16T18:00:00', 'E01', 'out']] },
  fetch: (url, opt) => {
    let b = null; try { b = JSON.parse(opt.payload); } catch (e) { fetches.push({ url, verify: opt.payload && opt.payload.id_token }); return undefined; }
    fetches.push({ url, b });
    if (b.action === 'line_hub_pay_lock') return b.ym === '2026-10' ? { ok: true, store: 'MZTJS', ym: b.ym, locked: true } : { ok: true, store: 'MZTJS', ym: b.ym, locked: false };
    if (b.action === 'line_hub_req_quota') return { ok: true, quota: [{ name: '家庭照顧假', cap_h: 56, remain_h: 4 }, { name: '生理假', cap_h: 24, remain_h: 24, cap_days: 3 }], annual_from: '2027-01-01', ft: true };
    return { ok: false, error: 'unknown' };
  } });
m.sb.console = { log: () => {}, warn: () => {}, info: () => {}, error: () => {} };
let propReads = 0;
const ps0 = m.sb.PropertiesService.getScriptProperties;
m.sb.PropertiesService = { getScriptProperties: () => { const p = ps0(); return { getProperty: (k) => { propReads++; return p.getProperty(k); }, getProperties: () => { propReads++; return p.getProperties(); }, setProperty: p.setProperty, deleteProperty: p.deleteProperty }; } };
const post = (b) => { m.advance(1000); m.run('READ_MEMO_ = null;'); return JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text); };
const out = [], reads = [];
const rec = (label, b) => { const n0 = propReads; out.push([label, post(b)]); reads.push([label, propReads - n0]); };
const S = (x) => Object.assign({ action: 'req_submit', id_token: 'TOK_U1' }, x);
rec('leave', S({ kind: 'leave', leave_type: '事假', hours: 8, reason: '家裡有事', date: '2026-11-16' }));
rec('leave_reqid', S({ kind: 'leave', leave_type: '事假', hours: 8, reason: '家裡有事', date: '2026-11-15', req_id: 'r00000000000000a1' }));
rec('leave_reqid_dup', S({ kind: 'leave', leave_type: '事假', hours: 8, reason: '家裡有事', date: '2026-11-15', req_id: 'r00000000000000a1' }));
rec('reqid_taken', S({ id_token: 'TOK_U2', kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-11-15', req_id: 'r00000000000000a1' }));
rec('bad_reqid', S({ kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-11-14', req_id: 'nope' }));
rec('locked_month', S({ kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-10-30' }));
rec('family_over', S({ kind: 'leave', leave_type: '家庭照顧假', hours: 8, reason: 'x', date: '2026-11-14' }));
rec('family_ok', S({ kind: 'leave', leave_type: '家庭照顧假', hours: 4, reason: 'x', date: '2026-11-13' }));
rec('mens', S({ kind: 'leave', leave_type: '生理假', hours: 8, reason: '', date: '2026-11-12' }));
rec('sick', S({ kind: 'leave', leave_type: '病假', hours: 8, reason: '感冒', date: '2026-11-11' }));
rec('annual_early', S({ kind: 'leave', leave_type: '特休假', hours: 8, reason: 'x', date: '2026-11-18' }));
rec('segs', S({ kind: 'leave', leave_type: '事假', reason: '看醫生', date: '2026-11-19', req_id: 'r00000000000000a2', segments: [{ start: '14:00', end: '16:00' }, { start: '10:00', end: '12:00' }] }));
rec('bad_token', S({ id_token: 'NOPE', kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-11-20' }));
rec('no_token', { action: 'req_submit', kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-11-20', emp_id: 'E02', mgr_key: 'AK' });
rec('gone_emp', S({ id_token: 'TOK_U3', kind: 'leave', leave_type: '事假', hours: 8, reason: 'x', date: '2026-11-20' }));
const first = (out[0][1].request || {}).id;
rec('cancel_mine', { action: 'req_cancel', id_token: 'TOK_U1', id: first });
rec('cancel_again', { action: 'req_cancel', id_token: 'TOK_U1', id: first });
rec('cancel_other', { action: 'req_cancel', id_token: 'TOK_U2', id: 'r00000000000000a1' });
rec('cancel_bad_token', { action: 'req_cancel', id_token: 'NOPE', id: 'r00000000000000a1' });
rec('cancel_no_token', { action: 'req_cancel', id: 'r00000000000000a1', emp_id: 'E01', mgr_key: 'AK' });
rec('info', { action: 'req_info', id_token: 'TOK_U1' });
const bk = m.self.sh;
const sheets = {}; Object.keys(bk).sort().forEach((k) => { sheets[k] = bk[k].values; });
const cacheKeys = Object.keys(m.cache).filter((k) => !/^dfeed_/.test(k)).sort();
process.stdout.write(JSON.stringify({ out, sheets, cacheKeys, reads, fetches }));
