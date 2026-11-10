/* B37（2026-11-10 挑錯）：申請動作的輸入檢查（要自己組請求才碰得到）。這次修三項，用真函式跑、名字一律假名。
 *  ① 申請類別只收 ot／leave／miss 這幾種；其他字一律退回。
 *  ③ 補「中間休息」：只有上班卡（還沒下班）的那一段，休息時間要在上班卡之後的 16 小時內——比上班卡還早、繞到隔天的不收。
 *  ④ 店長代開補休：本人送會被擋的（計時同仁），代開也擋。
 * 沒修的一項（附件編號只檢查格式）寫在 PR 說明。 */
'use strict';
const { make, T, check, done } = require('./helpers/gs-sandbox');
const ME = { emp_id: 'E01', name: '測試一', key: 'K1', device_id: 'D1', active: 'TRUE', line_user_id: 'U1' };
const E3 = { emp_id: 'E03', name: '測試三', key: 'K3', device_id: 'D3', active: 'TRUE', line_user_id: '' };
const res = (r) => (r.ok ? 'ok' : r.error);
const D = '2026-11-09';
function world(events) { return make({ now: T('2026-11-10T10:00:00'), self: { roster: [ME, E3], events: events || [] } }); }
function submit(m, body) { m.advance(1000); return m.sb.handleReqSubmit_(Object.assign({ id_token: 'TOK_U1' }, body)); }

console.log('════ ① 申請類別 ════');
{
  const got = {};
  ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'MISS', ''].forEach((k) => {
    const m = world();
    got[k || '（空白）'] = res(submit(m, { kind: k, date: D, miss_type: 'both', start: '09:00', end: '17:00', reason: '忘記按' })) + '／表裡 ' + m.sb.reqRows_(m.self).length + ' 列';
  });
  check('B37-01', '類別填怪字 → 一律 bad_kind、表裡沒有多一列', got,
    { constructor: 'bad_kind／表裡 0 列', toString: 'bad_kind／表裡 0 列', hasOwnProperty: 'bad_kind／表裡 0 列', valueOf: 'bad_kind／表裡 0 列', MISS: 'bad_kind／表裡 0 列', '（空白）': 'bad_kind／表裡 0 列' });
  const m = world();
  check('B37-02', '對照：正常的三種類別照收', [
    res(submit(m, { kind: 'miss', date: D, miss_type: 'both', start: '09:00', end: '17:00', reason: '忘記按' })),
    res(submit(m, { kind: 'leave', date: '2026-11-20', leave_type: '事假', hours: 8, reason: '家裡有事' })),
    res(submit(world([[D + 'T09:00:00', 'E01', 'in'], [D + 'T19:00:00', 'E01', 'out']]), { kind: 'ot', date: D, start: '17:00', end: '19:00', reason: '結帳' }))], ['ok', 'ok', 'ok']);
}

console.log('\n════ ③ 補中間休息：只有上班卡的那一段 ════');
{
  const open = [[D + 'T10:00:00', 'E01', 'in']];
  const brk = (a, b) => res(submit(world(open), { kind: 'miss', date: D, miss_type: 'break', end: a, start: b, reason: '忘記按' }));
  check('B37-10', '只有 10:00 上班卡：補「休息 09:00、09:30 回來」（比上班卡還早）→ 不收', brk('09:00', '09:30'), 'bad_time');
  check('B37-11', '補「休息 23:00、隔天 09:59 回來」（繞到隔天）→ 不收', brk('23:00', '09:59'), 'bad_time');
  check('B37-12', '對照：補「休息 14:00、15:00 回來」→ 收', brk('14:00', '15:00'), 'ok');
  check('B37-13', '對照：跨夜也可以——補「休息 23:30、00:30 回來」（上班後 14.5 小時內）→ 收', brk('23:30', '00:30'), 'ok');
  check('B37-14', '上班後超過 16 小時才回來（休息 01:00、02:30 回來）→ 不收', brk('01:00', '02:30'), 'bad_time');
  const full = [[D + 'T10:00:00', 'E01', 'in'], [D + 'T20:00:00', 'E01', 'out']];
  check('B37-15', '對照：完整一段 10:00–20:00，補「休息 14:00、15:00」→ 收；「09:00、09:30」→ 不收',
    [res(submit(world(full), { kind: 'miss', date: D, miss_type: 'break', end: '14:00', start: '15:00', reason: '忘記按' })),
     res(submit(world(full), { kind: 'miss', date: D, miss_type: 'break', end: '09:00', start: '09:30', reason: '忘記按' }))], ['ok', 'bad_time']);
}

console.log('\n════ ④ 店長代開補休 ════');
{
  const px = (allowed, type) => {
    const m = world();
    m.sb.reqCompAllowed_ = () => allowed;   // 薪資主檔的判斷（true 正職／false 計時／null 查不到）——這裡只測代開有沒有照它擋
    m.advance(1000);
    const r = m.sb.handleMgrReqProxy_({ mgr_key: 'AK', acting_name: '店長甲', emp_id: 'E03', kind: 'leave', date: '2026-11-07', leave_type: type || '補休', hours: 8, reason: '代開' });
    return [res(r), r.message || '', m.sb.reqRows_(m.self).length];
  };
  check('B37-20', '計時同仁（薪資主檔說不能請補休）→ 代開補休也擋', px(false), ['comp_not_allowed', '補休只有正職可以請', 0]);
  check('B37-21', '對照：正職 → 代開補休收', px(true).filter((x, i) => i !== 1), ['ok', 1]);
  check('B37-22', '對照：查不到薪資主檔（別家店）→ 照舊收', px(null).filter((x, i) => i !== 1), ['ok', 1]);
  check('B37-23', '對照：計時同仁代開事假 → 收', px(false, '事假').filter((x, i) => i !== 1), ['ok', 1]);
}
done();
