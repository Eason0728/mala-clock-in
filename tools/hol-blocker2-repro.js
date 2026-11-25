#!/usr/bin/env node
/**
 * 獨立審查第 1 輪「擋項 2」重現（節日表推送 #236，2026-11-25）。
 *
 * 審查的情境（照 Codex 報告步驟）：今天 2027-04、只收推送（PAY_HOL_SOURCE=mini），薪資分頁缺 2027-03（已經過去）。
 *   人事行政總處原檔有 3/15 投票日，人資主管確認的正本（推送內容）沒有。
 *   照舊的補列流程（已刪）：切 gov → 算 2027-03 讓舊同步補列（補進 3/1、3/15）→ 切回 mini → 同版 reapply：
 *   reapply 回 ok:true、只把 2027-03 列在 skipped_past，薪資留著沒確認過的 3/15。
 *
 * 主管 2026-11-25 11:13 定案（方案乙）：「過去的月份整月沒有節日資料時，不補上。」
 *   ＝過去月份一律不寫（補缺也不行）、刪掉切 gov 補列的那節附錄、缺列的過去月份只能系統外處理。
 *
 * 這支在乙的規則下要全部成立（綠）：
 *   1 正式推送遇到過去月份缺列：不寫，回明確拒絕碼 past_code='hol_past_frozen'＋past_refused 月份＋白話 past_message
 *   2 同版 reapply（過去月份被別的管道改過、跟確認版不同）：不寫，同樣回拒絕碼與月份，不是單純成功
 *   3 算薪擋下的白話：系統不會補、要人工到 payroll_holiday 分頁補（系統外處理）
 *   4 文件與程式沒有那個附錄、沒有「切回 gov 補過去月份」的步驟
 *   5 不論哪一步，推送／reapply 對過去月份零寫入
 * 第 2 輪（Codex 擋項，主管 2026-11-25「甲，也套用」）：現行做法（gov）開頁同步、算薪也不補過去缺列，算薪同一句擋下、分頁零寫入。
 *   例：node tools/hol-blocker2-repro.js d26637a   → 第 3 節紅
 * 用法：node tools/hol-blocker2-repro.js [git 版本，預設工作目錄的檔案]
 *   例：node tools/hol-blocker2-repro.js dedbcaf   → 應該紅（舊版沒有拒絕碼、文件還有那個附錄）
 * 全部虛構資料、不連網（人事行政總處原檔用 tests/fixtures/holidays 夾具，由假 UrlFetchApp 回）。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const { load } = require(path.join(ROOT, 'tests', 'helpers', 'payroll-vm'));

const rev = process.argv[2] || '';
const src = (rel) => rev ? cp.execFileSync('git', ['-C', ROOT, 'show', rev + ':' + rel], { encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAY = src('apps-script/Payroll.gs'), DOC = src('docs/holiday-publish/README.md');

let pass = 0, fail = 0;
const chk = (c, m, got) => { if (c) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m + (got !== undefined ? '\n   實際 ' + JSON.stringify(got).slice(0, 400) : '')); } };
const J = (x) => JSON.parse(JSON.stringify(x));
const KEY = 'test-admin-key', SVC = 'test-hol-svc-key';
const FIX = path.join(ROOT, 'tests', 'fixtures');
const PUSH = JSON.parse(fs.readFileSync(path.join(FIX, 'hol-publish-v1.json'), 'utf8')); delete PUSH._note;
const push = (o) => Object.assign(J(PUSH), { svcKey: SVC, confirmed_by: '人資主管' }, o || {});
const DATASET = fs.readFileSync(path.join(FIX, 'holidays', 'dataset-14718.json'), 'utf8');
const CSV_BY_URL = { '202506/a52331bd': '115-202506.csv', '202607/f538b1ff': '116-202607.csv', '202510/b84cb88a': '114-202510.csv' };

// 薪資分頁：2026-05～2027-12 跟正本相同，只缺 2027-03（已經過去）
const rows0 = Object.keys(PUSH.rows).filter((k) => k >= '2026-05' && k !== '2027-03').map((k) => Object.assign({}, PUSH.rows[k], { store: '' }));
const s = load({ data: { holiday: J(rows0), run: [], audit: [], master: [], store: [], config: [], item: [], input: [], bonus: [] }, today: '2027-04-15', payrollSrc: PAY });
s.__PROPS = { PAY_HOL_SVC_KEY: SVC, PAY_HOL_SOURCE: 'mini' }; s.__NOWYM = '2027-04'; s.__W = 0; s.__FETCH = 0;
s.PropertiesService = { getScriptProperties: () => ({
  getProperty: (k) => (Object.prototype.hasOwnProperty.call(s.__PROPS, k) ? s.__PROPS[k] : null),
  setProperty: (k, v) => { s.__PROPS[k] = String(v); } }) };
s.UrlFetchApp = { fetch: (url) => {
  s.__FETCH++;
  if (url === 'https://data.gov.tw/api/v2/rest/dataset/14718') return { getContentText: () => DATASET };
  const k = Object.keys(CSV_BY_URL).find((x) => url.indexOf('dgpa/files/' + x) >= 0);
  if (!k) throw new Error('夾具沒有這個檔：' + url);
  let txt = new TextDecoder(/114/.test(CSV_BY_URL[k]) ? 'big5' : 'utf-8').decode(fs.readFileSync(path.join(FIX, 'holidays', CSV_BY_URL[k])));
  if (/116/.test(CSV_BY_URL[k])) txt = txt.replace('20270315,一,0,', '20270315,一,2,投票日');   // 原檔有 3/15 投票日（確認版排除）
  return { getBlob: () => ({ getDataAsString: () => txt }) };
} };
vm.runInContext(`CONFIG.ADMIN_KEY = ${JSON.stringify(KEY)};
  currentYmTaipei = function () { return __NOWYM; };
  var __ra = payReplaceAll; payReplaceAll = function (k, rows) { if (k === 'holiday') __W++; return __ra(k, rows); };
  payReadNoCreate_ = function (kind) { return (__DATA[kind] || []).map(function (r) { return Object.assign({}, r); }); };
  paySchedMissingAll_ = function () { return []; }; payUnapprovedAll_ = function () { return []; };
  payCompNegatives = function () { return []; }; payLeaveMismatch_ = function () { return []; };`, s);
const H = vm.runInContext('PAYROLL_HANDLERS', s);
const pub = (b) => J(H.payroll_holiday_publish(b));
const row = (ym) => J(s.__DATA.holiday).find((r) => String(r.ym) === ym && String(r.store || '') === '');
const pastRefusal = (r, ym, m) => {
  chk(r.ok === true && r.past_code === 'hol_past_frozen' && Array.isArray(r.past_refused) && r.past_refused.indexOf(ym) >= 0,
    m + '：回明確拒絕碼 past_code=hol_past_frozen、past_refused 含 ' + ym, { ok: r.ok, past_code: r.past_code, past_refused: r.past_refused, skipped_past: r.skipped_past, past_missing: r.past_missing });
  chk(typeof r.past_message === 'string' && r.past_message.indexOf(ym) >= 0 && /系統外/.test(r.past_message) && !/附錄/.test(r.past_message),
    m + '：past_message 白話寫出月份與「系統外處理」、不指向附錄', r.past_message);
};

console.log('── 1 正式推送：2027-04 收第一版，分頁缺 2027-03（已經過去、整月沒有資料）──');
const w0 = s.__W;
const r1 = pub(push());
chk(r1.ok && JSON.stringify(r1.past_missing) === '["2027-03"]', '推送成功、past_missing=[2027-03]', r1);
chk(!row('2027-03'), '2027-03 沒有被補上（零寫入）');
pastRefusal(r1, '2027-03', '正式推送');
chk(s.__W === w0, '分頁沒有整張重寫（其他月份都相同，這次沒有任何月份要改）', s.__W - w0);

console.log('\n── 2 算 2027-03：擋下 ──');
const c1 = J(H.payroll_calc({ admin_key: KEY, ym: '2027-03', store: 'SSLGF', inputs: {} }));
chk(c1.error === 'no_holiday' && c1.hol_past === true && s.__FETCH === 0, '只收推送：擋下（no_holiday、hol_past）、不連外', c1);
chk(/系統不會補上/.test(c1.message) && /人工/.test(c1.message) && /系統外/.test(c1.message) && !/附錄/.test(c1.message), '擋下的白話：系統不會補、要人工補（系統外處理）、不指向附錄', c1.message);

console.log('\n── 3 Codex 第 2 輪：現行做法（gov）也不補過去月份（主管 2026-11-25「甲，也套用」）──');
s.__PROPS.PAY_HOL_SOURCE = 'gov';
const hb = JSON.stringify(s.__DATA.holiday), w2 = s.__W, f2 = s.__FETCH, a2 = s.__DATA.audit.length;
const y3 = J(H.payroll_holiday_sync({ admin_key: KEY, years: [2027], store: 'SSLGF', operator: 'auto (薪資頁開啟)' }));
chk(!row('2027-03') && JSON.stringify(y3.past_missing) === '["2027-03"]', 'gov 開頁同步：已經過去的 2027-03 缺列不補、回 past_missing', { changed: y3.changed, past_missing: y3.past_missing, row: row('2027-03') });
const c2 = J(H.payroll_calc({ admin_key: KEY, ym: '2027-03', store: 'SSLGF', inputs: {} }));
chk(c2.error === 'no_holiday' && c2.hol_past === true && c2.message === c1.message, 'gov 算 2027-03：不同步、直接擋下，跟只收推送同一句', { error: c2.error, hol_past: c2.hol_past, ok: c2.ok });
chk(JSON.stringify(s.__DATA.holiday) === hb && s.__W === w2 && s.__DATA.audit.length === a2, 'gov 開頁＋算薪：節日分頁前後逐字相同、沒有重寫、沒有稽核', { rewrites: s.__W - w2 });
console.log('   gov 連外次數（開頁同步照舊抓行事曆、算薪不抓）：' + (s.__FETCH - f2));
s.__PROPS.PAY_HOL_SOURCE = 'mini';

console.log('\n── 3b 過去月份有列、跟確認版不同（2027-03 當月 gov 同步時補進原檔的 3/15，到 4 月才切 mini）→ 同版 reapply ──');
s.__NOWYM = '2027-03'; s.__PROPS.PAY_HOL_SOURCE = 'gov';
J(H.payroll_holiday_sync({ admin_key: KEY, years: [2027], store: 'SSLGF', operator: 'auto (薪資頁開啟)' }));
const filled = row('2027-03');
chk(!!filled && /2027-03-15/.test(filled.dates), '（前提）2027-03 還是本月時 gov 同步補了原檔的 3/15＝跟確認版不同', filled);
s.__NOWYM = '2027-04'; s.__PROPS.PAY_HOL_SOURCE = 'mini';
const before = JSON.stringify(row('2027-03')), w1 = s.__W;
const r2 = pub(push({ reapply: true }));
chk(r2.ok && JSON.stringify(r2.skipped_past) === '["2027-03"]', '同版 reapply：2027-03 列在 skipped_past', r2);
chk(JSON.stringify(row('2027-03')) === before && s.__W === w1, '過去月份 2027-03 零寫入（reapply 也不改）');
pastRefusal(r2, '2027-03', '同版 reapply');

console.log('\n── 4 文件與程式：沒有那個附錄、沒有切 gov 補過去月份的步驟 ──');
chk(!/附錄 ?B/.test(DOC) && !/附錄 ?B/.test(PAY), 'docs/holiday-publish/README.md 與 Payroll.gs 沒有那個附錄（字樣 0 筆）', (DOC.match(/附錄 ?B/g) || []).length + (PAY.match(/附錄 ?B/g) || []).length);
chk(!/暫時切回現行做法/.test(DOC), '文件沒有「暫時切回現行做法」補列的步驟');
chk(/切回[^。]{0,20}gov[^。]{0,10}也不會補/.test(DOC), '文件明講切回 gov 也不會補過去月份');

console.log('\n' + (fail ? '✗ 擋項重現：' + fail + ' 項不符定案（' + pass + ' 項符合）' : '✓ 擋項重現：' + pass + ' 項全部符合定案'));
process.exit(fail ? 1 : 0);
