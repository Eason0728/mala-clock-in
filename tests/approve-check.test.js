// 只檢查不寫入（2026-11-14 考勤管理好上手第 1 項；營運系統 docs/duty-easy/）
// 走真 doPost：mgr_approve_check 一次多人、跟 mgr_approve 同一套檢查、試算表一筆不多、不記變動；mgr_approve dry_run 同樣不寫。
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');

const m = make({ now: T('2026-11-10T10:00:00'), self: {
  roster: [{ emp_id: 'E01', name: '測試一', key: 'K1', active: 'TRUE', line_user_id: 'U1' }, { emp_id: 'E02', name: '測試二', key: 'K2', active: 'TRUE', line_user_id: 'U2' }],
  events: [['2026-11-09T09:00:00', 'E01', 'in'], ['2026-11-09T17:00:00', 'E01', 'out'], ['2026-11-09T10:00:00', 'E02', 'in'], ['2026-11-09T18:00:00', 'E02', 'out']],
} });
const post = (b) => JSON.parse(m.sb.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const ck = (items, extra) => post(Object.assign({ action: 'mgr_approve_check', mgr_key: 'AK', acting_name: '店長甲（DZY001）', date: '2026-11-09', items }, extra || {}));
const changes = () => post({ action: 'duty_changes', mgr_key: 'AK', since: 1 }).changes.length;
const n0 = m.approved().length, c0 = changes();

const r1 = ck([{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }, { emp_id: 'E02', periods: [{ start: '10:00', end: '18:00' }] }]);
check('C01', '兩人都會過：ok、各自時數', [r1.ok, r1.results.map((x) => [x.emp_id, x.ok, x.approved_hours])], [true, [['E01', true, 8], ['E02', true, 8]]]);
check('C02', '只檢查：approved 一筆不多', m.approved().length, n0);
check('C03', '只檢查：不記變動', changes(), c0);

const r2 = ck([{ emp_id: 'E01', periods: [{ start: '09:00', end: '09:00' }] }, { emp_id: 'NOPE', periods: [{ start: '10:00', end: '18:00' }] }]);
check('C04', '格式不對、找不到人：逐人回錯，不影響別人', r2.results.map((x) => [x.emp_id, x.ok, x.error]), [['E01', false, 'bad_periods'], ['NOPE', false, 'invalid_emp_id']]);

check('C05', '金鑰不對：unauthorized', ck([{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] }], { mgr_key: 'WRONG' }).error, 'unauthorized');
const many = []; for (let i = 0; i < 41; i++) many.push({ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
check('C06', '一次超過 40 人：too_many', ck(many).error, 'too_many');
check('C07', 'items 不是陣列：bad_items', post({ action: 'mgr_approve_check', mgr_key: 'AK', date: '2026-11-09' }).error, 'bad_items');

const d1 = post({ action: 'mgr_approve', mgr_key: 'AK', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], dry_run: true });
check('C08', 'mgr_approve 帶 dry_run：回 dry_run、不寫、不記變動', [d1.ok, d1.dry_run, m.approved().length, changes()], [true, true, n0, c0]);

const real = post({ action: 'mgr_approve', mgr_key: 'AK', date: '2026-11-09', emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }] });
check('C09', '真的送出：照常寫入一筆（只檢查沒有影響正式核定）', [real.ok, m.approved().length], [true, n0 + 1]);
const r3 = ck([{ emp_id: 'E01', periods: [{ start: '09:00', end: '17:00' }], base_ver: 'x', action: 'evil', mgr_key: 'WRONG' }]);
check('C10', '每人的 items 不能蓋掉金鑰、動作、日期（base_ver 也不吃）', [r3.ok, r3.results[0].ok], [true, true]);
// 11. 一批共用讀過的表、批次結束就關掉：下一批看得到新資料
check('C11', '批次結束後不再共用（READ_MEMO_ 關掉）', m.sb.READ_MEMO_, null);
const before12 = ck([{ emp_id: 'E09', periods: [{ start: '10:00', end: '18:00' }] }]).results[0];
const hdr = m.self.sh.roster.values[0], row = hdr.map((h) => ({ emp_id: 'E09', name: '新人', key: 'K9', active: 'TRUE', line_user_id: 'U9' })[h] || '');
m.self.sh.roster.values.push(row);
const after12 = ck([{ emp_id: 'E09', periods: [{ start: '10:00', end: '18:00' }] }]).results[0];
check('C12', '下一批照新資料算（剛加進名冊的同仁找得到）', [before12.error, after12.error || 'ok'], ['invalid_emp_id', after12.error === 'invalid_emp_id' ? 'x' : (after12.error || 'ok')]);
check('C13', '剛加進名冊的同仁：不再是找不到人', after12.error !== 'invalid_emp_id', true);
const r14 = ck([{ emp_id: 'E01', periods: [{ start: '09:00', end: '20:00' }] }]).results[0];
check('C14', '擋下時把原因清單、是否缺單一起回（營運系統逐條顯示）', [r14.ok, Array.isArray(r14.probs) && r14.probs.length > 0, typeof r14.need_doc], [false, true, 'boolean']);
done();
