/* 出勤規範第 4 批（2026-11-08）：週年特休折算月份、月加班 36／46、加班單鎖月、平日出差不得報加班、曠職提醒、事假績效、病假每張附、出差上限 */
const fs = require('fs'), vm = require('vm');
const ROOT = require('path').join(__dirname, '..');
const read = (f) => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8');
const CLOCK = {}, CACHE = {};
const sb = { console,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }) },
  Utilities: { formatDate: (d, tz, f) => { const t = new Date(d.getTime() + 8 * 3600000), p = (n) => ('0' + n).slice(-2);
    const day = t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate());
    return f === 'HH:mm' ? p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) : day; } },
  Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  CacheService: { getScriptCache: () => ({ get: (k) => CACHE[k] || null, put: (k, v) => { CACHE[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
vm.createContext(sb);
vm.runInContext(read('Code.gs') + '\n' + read('Payroll.gs') + '\n' + read('Rest.gs') + '\n' + read('Requests.gs'), sb);
sb.__CLOCK = CLOCK; sb.__DB = { master: [], input: [], run: [] };
vm.runInContext(`payClockRead=function(s,sh){return (globalThis.__CLOCK[sh]||[]);};
 payRead=function(t){return (globalThis.__DB[t]||[]);};
 payEmpStoresMap=function(){return {};};`, sb);
const F = (n) => vm.runInContext(n, sb);
let p = 0, f = 0;
const chk = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? '✓ ' : '✗ ') + n + ': ' + JSON.stringify(g) + (ok ? '' : ' ← 應為 ' + JSON.stringify(w))); };

// 週年特休：到期日前一天落在哪個月，就算在哪個月
const me = (hire) => ({ emp_id: 'F', name: '測試二', store: 'SSLGF', is_full_time: 'true', hire_date: hire, active: 'true', leave_date: '' });
const info = (hire, ym) => { sb.__DB.master = [me(hire)]; return F('payAnnualInfo')(ym, 'SSLGF')['F']; };
CLOCK.leave = [];
chk('10/1 到職：9 月結算', info('2024-10-01', '2026-09').payout_ym, '2026-09');
chk('10/1 到職：10 月不結算', info('2024-10-01', '2026-10').payout_ym === '2026-10', false);
let a = info('2024-10-15', '2026-10');
chk('10/15 到職：10 月結算', a.payout_ym, '2026-10');
chk('10/15 到職：結算上一年度 7 天', a.payout_h, 56);
chk('10/15 到職：畫面顯示新年度 10 天', [a.days, a.ps], [10, '2026-10-15']);
chk('10/15 到職：9 月不結算', info('2024-10-15', '2026-09').payout_ym === '2026-09', false);
chk('10/15 到職：11 月不結算', info('2024-10-15', '2026-11').payout_ym === '2026-11', false);
CLOCK.leave = [{ '日期': '2026-05-01', '姓名': '測試二', '假別': '特休', '時數': 8 }, { '日期': '2026-10-20', '姓名': '測試二', '假別': '特休', '時數': 8 }];
a = info('2024-10-15', '2026-10');
chk('只扣上一年度內休掉的（10/20 算新年度）', [a.payout_h, a.used_h], [48, 8]);
CLOCK.leave = [];
a = info('2026-04-15', '2027-04');
chk('第一年 3 天那期也會結算', [a.payout_ym, a.payout_h], ['2027-04', 24]);
const cfg0 = { daily_hours: 8, leave_div_days: 30, leave_div_hours: 8, attend_deduct_per_day: 100, sick_ratio: 0.5 };
const FT = { emp_id: 'A', is_full_time: 'true', base: 24000, hire_date: '2024-10-15', store: 'SSLGF' };
const pay = (annual) => { const r = F('payCalcOne')(FT, '2026-10', { hours: 184, deduct_days: 0, support: [], annual }, cfg0, 0, []); const x = r.earn.find((e) => e.item_key === 'annual_payout'); return x ? x.qty : 0; };
chk('薪資用結算時數，不用畫面的剩餘', pay({ payout_ym: '2026-10', payout_h: 56, left_h: 80 }), 56);
chk('結算時數 0 不發', pay({ payout_ym: '2026-10', payout_h: 0, left_h: 80 }), 0);

// 4-15 判斷
const NOW = Date.parse('2026-11-20T12:00:00+08:00');
const seg = (h) => [{ in: NOW - (h + 0.5) * 3600000, out: NOW - 0.5 * 3600000 }];
const J = F('restOtJudge_');
chk('36H 整不提醒', J({ h: 36, rest: true }, [], NOW), null);
chk('36.25H 提醒不擋', [J({ h: 36.25, rest: true }, [], NOW).code, J({ h: 36.25, rest: true }, [], NOW).warn], ['ot36', true]);
chk('滿 46H 休息日擋', [J({ h: 46, rest: true }, [], NOW).code, J({ h: 46, rest: true }, [], NOW).warn], ['ot46', undefined]);
chk('滿 46H 正常班只提醒', J({ h: 46, rest: false }, [], NOW).warn, true);
chk('滿 46H 今天還沒滿 8H（二段班回來）只提醒', J({ h: 46, rest: false }, seg(4), NOW).warn, true);
chk('滿 46H 今天已滿 8H 擋', J({ h: 46, rest: false }, seg(8), NOW).warn, undefined);
chk('沒有資料不擋', J(null, seg(9), NOW), null);
const sheet = (rows) => ({ getSheetByName: (n) => (n === 'ot_month' ? { getDataRange: () => ({ getValues: () => rows }), getLastRow: () => rows.length, getLastColumn: () => rows[0].length, getRange: () => ({ getValues: () => rows }) } : null) });
vm.runInContext('readSheetAsObjects=function(s){var v=s.getDataRange().getValues();var h=v[0];return {rows:v.slice(1).map(function(r){var o={};h.forEach(function(k,i){o[k]=r[i]});return o})}};', sb);
const R = F('restOtRow_');
const H = ['name', 'ot_h', 'rest', 'date', 'updated_at'];
chk('讀今天的列，姓名去空白', R(sheet([H, ['王小明', '47', 'TRUE', '2026-11-20', 'x']]), '王 小明', NOW), { h: 47, rest: true });
Object.keys(CACHE).forEach((k) => delete CACHE[k]);
chk('昨天的列不算', R(sheet([H, ['王小明', '47', 'TRUE', '2026-11-19', 'x']]), '王小明', NOW), null);
Object.keys(CACHE).forEach((k) => delete CACHE[k]);
chk('沒有分頁不擋', R({ getSheetByName: () => null }, '王小明', NOW), null);

// 4-2、5-1
const C = F('payOtFormCheck_');
const daily = { sched: { '2026-11-12': { t: 'W' }, '2026-11-13': { t: 'H' }, '2026-11-14': { t: 'W' } }, hol: {} };
chk('11/10 不算（11/11 起算）', C({ ot_own_h: { '2026-11-10': 12 }, ot_forms: { ot: {}, trip: {} }, daily }).missing, []);
chk('11/12 超過 2H 沒單', C({ ot_own_h: { '2026-11-12': 10 }, ot_forms: { ot: {}, trip: {} }, daily }).missing, [{ date: '2026-11-12', need: 2, have: 0 }]);
chk('15 分鐘內算有', C({ ot_own_h: { '2026-11-12': 10 }, ot_forms: { ot: { '2026-11-12': 1.75 }, trip: {} }, daily }).missing, []);
chk('超過 15 分鐘算不足', C({ ot_own_h: { '2026-11-12': 10 }, ot_forms: { ot: { '2026-11-12': 1.5 }, trip: {} }, daily }).missing.length, 1);
chk('沒超過 8H 不用單', C({ ot_own_h: { '2026-11-12': 8 }, ot_forms: { ot: {}, trip: {} }, daily }).missing, []);
chk('沒帶資料不檢查', C({ daily }).missing, []);
chk('平日出差有加班單列出', C({ ot_own_h: {}, ot_forms: { ot: { '2026-11-12': 2 }, trip: { '2026-11-12': true } }, daily }).trip_ot, ['2026-11-12']);
chk('休息日出差可報加班', C({ ot_own_h: {}, ot_forms: { ot: { '2026-11-13': 2 }, trip: { '2026-11-13': true } }, daily }).trip_ot, []);

// 2-8 曠職
const sum = (cells, dayH, until) => { const dates = Object.keys(cells).sort(), sched = {}; dates.forEach((d) => { sched[d] = { t: cells[d] }; }); return F('payOtDailySum')({ dates, sched, day_h: dayH, day_leave: {}, hol: {}, until: until || '2026-11-30', comp_h: 0, extra_ot: 0 }); };
let S = sum({ '2026-11-02': 'W', '2026-11-03': 'H', '2026-11-04': 'W', '2026-11-05': 'W' }, {});
chk('中間夾休息日仍算連續 3 個應出勤日', [S.no_show.length, S.no_show_streak], [3, 3]);
S = sum({ '2026-11-02': 'W', '2026-11-03': 'W', '2026-11-04': 'W', '2026-11-05': 'W' }, { '2026-11-03': 8 });
chk('中間有上班就斷', S.no_show_streak, 2);

// 3-3 事假
CLOCK.roster = [{ emp_id: 'E01', name: '測試一', active: true, key: 'k' }]; CLOCK.events = []; CLOCK.approved = [];
CLOCK.leave = [{ '日期': '2026-11-15', '姓名': '測試一', '假別': '事假', '時數': 8 }];
chk('文心 11 月事假歸零', F('payCollect')('2026-11', 6, 'MZTWX', [])['E01'].attend_void, true);
chk('小辛辣事假不歸零', F('payCollect')('2026-11', 6, 'SSLGF', [])['E01'].attend_void, false);
CLOCK.leave[0]['日期'] = '2026-10-15';
chk('文心 10 月照舊', F('payCollect')('2026-10', 6, 'MZTWX', [])['E01'].attend_void, false);
CLOCK.leave = [{ '日期': '2026-11-15', '姓名': '測試一', '假別': '家庭照顧假', '時數': 8 }];
chk('家庭照顧假不歸零', F('payCollect')('2026-11', 6, 'MZTWX', [])['E01'].attend_void, false);
const O = F('payPersonalOverDays_');
const lt = [{ code: 'personal', cap_days: 14 }, { code: 'family', cap_days: 7 }];
chk('事假 10＋家照 3＋本月事假 2 天＝超 1 天', O({ leave_usage: { personal: { used_before_days: 10 }, family: { used_before_days: 3 } }, personal_h: 16 }, { daily_hours: 8 }, lt), 1);
chk('家照逾 7 天併入的不重算', O({ leave_usage: { personal: { used_before_days: 11 }, family: { used_before_days: 8 } }, leaves: {} }, { daily_hours: 8 }, lt), 4);
chk('14 天內 0', O({ leave_usage: { personal: { used_before_days: 14 } }, leaves: {} }, { daily_hours: 8 }, lt), 0);

// 3-6、5-1 申請
chk('病假每張都要附', F('reqNeedsProof_')({ kind: 'leave', leave_type: '病假', __sick_n: 1, attach_id: '' }), true);
chk('出差上限 8 小時', F('REQ_TRIP_MAX_H'), 8);

console.log(f ? `\n❌ 失敗 ${f}` : `\n✅ 全部通過 (${p}/${p})`); process.exit(f ? 1 : 0);
