/* 選舉假名單：日期不是投票日時要多按一次確認才能存（2026-11-22 Eason 選項 7B）
 * 規則（白話）：
 *   1. 投票日清單＝Payroll.gs 的 PAY_ELEC_VOTE_DAYS（目前只有 2026-11-28）。清單內的日期照原本直接存。
 *   2. 清單外的日期：要帶 confirm_off_list，而且一定要是布林 true 才存；字串 "true"、數字 1、"yes"、false、null、缺少……一律當沒確認 → 擋，
 *      回 error 'elec_date_unconfirmed'＋說明文字（舊版畫面也看得懂）。
 *   3. 帶確認存成功：照原本寫一筆操作紀錄（action 仍是 hol_emp_set），說明多記「（不在投票日清單）」，只記店、月、日期、人數，不記姓名。
 *   4. 既有檢查（金鑰、門市範圍、月份格式、2026-10 以前、編號、日期要在該月、主檔、已鎖定）全部先做，先擋的照舊。
 *   5. 清除名單（沒勾人）不看日期、不用確認。
 *   6. payroll_month（名單能用的月份）回 elec_vote_days＝該月投票日（可能是空陣列），前端說明行與確認框只讀這一份。
 * 不碰任何金額：名單一樣的情況下，計算結果跟改版前一樣（engine-diff、election-day-emp 另外驗）。
 * 用法：node tests/elec-date-confirm.test.js；PAYROLL_GS=<舊版 Payroll.gs> 可拿舊版跑（應該紅：證明測試抓得到）。 */
'use strict';
const fs = require('fs'), path = require('path');
const T = fs.readFileSync(path.join(__dirname, 'election-day-emp.test.js'), 'utf8');
const cut = T.indexOf('const BASE_REF');
const mod = { exports: {} };
new Function('require', 'module', '__dirname', T.slice(0, cut).replace("'use strict';", '') + '\nmodule.exports = { world };')(require, mod, __dirname);
const GS = process.env.PAYROLL_GS ? fs.readFileSync(process.env.PAYROLL_GS, 'utf8') : undefined;
const world = (o) => mod.exports.world(Object.assign({}, o, GS ? { gs: GS } : {}));

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(got) + (ok ? '' : ' ← 應為 ' + JSON.stringify(want))); };
const safe = (f) => { try { return f(); } catch (e) { return 'THROW ' + String(e && e.message || e).slice(0, 80); } };

const E = '2026-11-28', OFF = '2026-11-29';
const MSG_OFF = '2026-11-29 不在投票日清單（本月投票日是 2026-11-28）。選錯日期會讓名單上的人選舉日加發算錯。';
const mk = (o) => {
  const w = world(Object.assign({ elec: [], only: ['a', 'g', 'c'] }, o || {}));
  const S = (b) => w.F('handlePayrollHolEmpSet')(Object.assign({ admin_key: 'x', store: 'SSLGF', ym: '2026-11' }, b));
  return { w, S, snap: () => JSON.stringify([w.DB.hol_emp, w.DB.audit]) };
};

console.log('══ 1) 清單內日期：照原本直接存 ══');
{
  const { w, S } = mk();
  const r = S({ date: E, emp_ids: ['E1', 'E2'] });
  chk('  2026-11-28 不帶旗標 → 存成功，回應形狀跟改版前一樣（沒有 off_list）', [r.ok, r.count, r.date, 'off_list' in r], [true, 2, E, false]);
  chk('  名單寫入', w.DB.hol_emp.map((x) => [x.date, x.emp_id]), [[E, 'E1'], [E, 'E2']]);
  chk('  操作紀錄說明照舊（沒有多字）', w.DB.audit.slice(-1)[0].reason, 'SSLGF 選舉假名單 2026-11-28 共 2 人');
  const r2 = S({ date: E, emp_ids: ['E1'], confirm_off_list: true });
  chk('  清單內日期多帶旗標也照存、說明照舊', [r2.ok, 'off_list' in r2, w.DB.audit.slice(-1)[0].reason], [true, false, 'SSLGF 選舉假名單 2026-11-28 共 1 人']);
}

console.log('\n══ 2) 清單外日期沒確認 → 擋（代碼＋說明），名單與操作紀錄都不動 ══');
{
  const { w, S, snap } = mk();
  S({ date: E, emp_ids: ['E1'] });
  const before = snap();
  const r = S({ date: OFF, emp_ids: ['E1', 'E2', 'E3'] });
  chk('  回 elec_date_unconfirmed', [r.ok, r.error], [false, 'elec_date_unconfirmed']);
  chk('  說明文字（逐字）', r.message, MSG_OFF);
  chk('  回應帶日期與本月投票日', [r.date, r.vote_days], [OFF, [E]]);
  chk('  名單、操作紀錄都沒變', snap() === before, true);
}

console.log('\n══ 3) 旗標只認布林 true，其他值一律當沒確認 ══');
{
  const vals = [['字串 "true"', 'true'], ['數字 1', 1], ['"yes"', 'yes'], ['false', false], ['null', null], ['字串 "1"', '1'], ['物件 {}', {}], ['陣列 [true]', [true]], ['缺少', undefined]];
  vals.forEach(([lab, v]) => {
    const { S, snap } = mk(); const before = snap();
    const b = { date: OFF, emp_ids: ['E1'] }; if (v !== undefined) b.confirm_off_list = v;
    const r = S(b);
    chk('  ' + lab + ' → 擋、沒寫入', [r.ok, r.error, snap() === before], [false, 'elec_date_unconfirmed', true]);
  });
  const { S } = mk();
  chk('  別的欄位名（confirm:true）不算', S({ date: OFF, emp_ids: ['E1'], confirm: true }).error, 'elec_date_unconfirmed');
}

console.log('\n══ 4) 帶 confirm_off_list:true → 存成功＋寫一筆操作紀錄 ══');
{
  const { w, S } = mk();
  const n0 = w.DB.audit.length;
  const r = S({ date: OFF, emp_ids: ['E1', 'E2', 'E3'], confirm_off_list: true, operator: '測試會計' });
  chk('  存成功、回 off_list:true', [r.ok, r.count, r.date, r.off_list], [true, 3, OFF, true]);
  chk('  名單寫入 11/29（照勾選）', w.DB.hol_emp.map((x) => [x.ym, x.date, x.store, x.emp_id]), [['2026-11', OFF, 'SSLGF', 'E1'], ['2026-11', OFF, 'SSLGF', 'E2'], ['2026-11', OFF, 'SSLGF', 'E3']]);
  chk('  操作紀錄剛好多一筆', w.DB.audit.length - n0, 1);
  const a = w.DB.audit.slice(-1)[0];
  chk('  紀錄：月份、動作、誰、哪家店、說明（日期＋不在清單＋人數）', [a.ym, a.action, a.operator, a.store, a.reason],
    ['2026-11', 'hol_emp_set', '測試會計', 'SSLGF', 'SSLGF 選舉假名單 2026-11-29（不在投票日清單） 共 3 人']);
  chk('  紀錄有時間（＝名單列的 updated_at，同一次存檔）', [!!String(a.ts), a.ts === w.DB.hol_emp[0].updated_at], [true, true]);
  chk('  紀錄不含姓名', w.DB.master.some((m) => String(a.reason).indexOf(m.name) >= 0), false);
  chk('  紀錄欄位只有既有那幾欄', Object.keys(a).sort(), ['action', 'operator', 'reason', 'store', 'ts', 'ym']);
}

console.log('\n══ 5) 既有檢查仍先擋（清單外日期、沒帶旗標也一樣先回既有錯誤）══');
{
  const { S } = mk();
  chk('  日期不在該月（12/01）→ bad_date', S({ date: '2026-12-01', emp_ids: ['E1'] }).error, 'bad_date');
  chk('  日期不存在（11/31）→ bad_date', S({ date: '2026-11-31', emp_ids: ['E1'] }).error, 'bad_date');
  chk('  月份格式錯 → bad_ym', S({ ym: '2026/11', date: OFF, emp_ids: ['E1'] }).error, 'bad_ym');
  chk('  2026-10 → elec_not_open', S({ ym: '2026-10', date: '2026-10-28', emp_ids: ['E1'] }).error, 'elec_not_open');
  chk('  編號怪字 → bad_emp_id', S({ date: OFF, emp_ids: ['E1"><b>'] }).error, 'bad_emp_id');
  chk('  不在主檔 → not_in_master', S({ date: OFF, emp_ids: ['NOPE'] }).error, 'not_in_master');
  const L = mk(); L.w.DB.run.push({ ym: '2026-11', store: 'SSLGF', emp_id: 'E1', status: 'final' });
  chk('  已鎖定 → locked（帶旗標也一樣）', [L.S({ date: OFF, emp_ids: ['E1'] }).error, L.S({ date: OFF, emp_ids: ['E1'], confirm_off_list: true }).error], ['locked', 'locked']);
  const U = mk(); U.w.F('(function(){ checkAdmin = function(){ return false; }; })')();
  chk('  沒有管理金鑰 → unauthorized（帶旗標也一樣）', [U.S({ date: OFF, emp_ids: ['E1'] }).error, U.S({ date: OFF, emp_ids: ['E1'], confirm_off_list: true }).error], ['unauthorized', 'unauthorized']);
  const G = mk(); const g = G.w.F('payScopeGuard_');
  chk('  門市範圍外 → scope_forbidden（門市守門在 handler 之前）', g('payroll_hol_emp_set', { scope: ['CF'], store: 'SSLGF', date: OFF, emp_ids: ['E1'], confirm_off_list: true }).error, 'scope_forbidden');
}

console.log('\n══ 6) 清除名單（沒勾人）不看日期、不用確認 ══');
{
  const { w, S } = mk();
  S({ date: E, emp_ids: ['E1'] });
  const r = S({ date: OFF, emp_ids: [] }), r2 = S({ date: '', emp_ids: [] });
  chk('  帶 11/29、空白日期清除都成功、不帶 off_list', [r.ok, 'off_list' in r, r2.ok, w.DB.hol_emp.length], [true, false, true, 0]);
  chk('  清除的操作紀錄照舊', w.DB.audit.slice(-1)[0].reason, 'SSLGF 選舉假名單 （清除） 共 0 人');
}

console.log('\n══ 7) 該月清單沒有日期（例：12 月）也要確認（字句 TODO：主管未定，暫省略括號）══');
{
  const { w, S } = mk();
  const r = S({ ym: '2026-12', date: '2026-12-05', emp_ids: ['E1'] });
  chk('  12/05 沒旗標 → 擋、vote_days 空', [r.error, r.vote_days], ['elec_date_unconfirmed', []]);
  chk('  說明暫用句（沒有括號那段）', r.message, '2026-12-05 不在投票日清單。選錯日期會讓名單上的人選舉日加發算錯。');
  const r2 = S({ ym: '2026-12', date: '2026-12-05', emp_ids: ['E1'], confirm_off_list: true });
  chk('  帶旗標 → 存成功、紀錄有標', [r2.ok, r2.off_list, w.DB.audit.slice(-1)[0].reason], [true, true, 'SSLGF 選舉假名單 2026-12-05（不在投票日清單） 共 1 人']);
}

console.log('\n══ 8) 清單可以有多個日期（之後補選、公投），邏輯不用改 ══');
{
  const { w, S } = mk();
  w.F('(function(){ PAY_ELEC_VOTE_DAYS = ["2026-11-28", "2026-11-15", "2026-12-20"]; })')();
  chk('  11 月投票日照清單順序', safe(() => w.F('payElecVoteDaysOf_')('2026-11')), ['2026-11-28', '2026-11-15']);
  chk('  11/15 直接存', [S({ date: '2026-11-15', emp_ids: ['E1'] }).ok, 'off_list' in S({ date: '2026-11-15', emp_ids: ['E1'] })], [true, false]);
  chk('  11/29 說明用「、」隔開', S({ date: OFF, emp_ids: ['E1'] }).message, '2026-11-29 不在投票日清單（本月投票日是 2026-11-28、2026-11-15）。選錯日期會讓名單上的人選舉日加發算錯。');
}

console.log('\n══ 9) payroll_month 帶 elec_vote_days（前端唯一來源）══');
{
  const pm = (ym) => { const w = world({ elec: [], only: ['a'] }); w.calc(); return safe(() => JSON.parse(JSON.stringify(w.F('handlePayrollMonth')({ admin_key: 'x', ym, store: 'SSLGF' })))); };
  const p11 = pm('2026-11'), p12 = pm('2026-12'), p10 = pm('2026-10');
  chk('  2026-11 → ["2026-11-28"]', p11 && p11.elec_vote_days, [E]);
  chk('  2026-12 → []（有欄位、空陣列）', p12 && p12.elec_vote_days, []);
  chk('  2026-10（名單不能用）→ 不帶欄位', p10 && typeof p10 === 'object' && 'elec_vote_days' in p10, false);
  chk('  只有那一個常數清單（前後端不各寫一份：payroll.html 沒有寫死 2026-11-28）',
    /2026-11-28/.test(fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => !/^\s*\/\//.test(l) && !/\/\*|\*\//.test(l)).join('\n').replace(/\/\/[^\n]*/g, '')), false);
}

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
