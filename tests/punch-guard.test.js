// 誤按防呆（2026-11-20）：網頁打卡 clock.html 與 LINE 打卡 clock-line.html 共用同一段 PUNCH_GUARD 純函式。
// A：同型再按 → 提醒文字含上一筆日期時間，主按鈕改送另一型；B：依前一筆判斷「該按的那顆」。
// 同時釘住：兩頁／九份門市頁的函式區塊一字不差、原生 confirm 不再用在同型／第一張下班、不動任何門檻。
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '（得到 ' + JSON.stringify(a) + '，應為 ' + JSON.stringify(b) + '）'); }

function block(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const a = src.indexOf('  /* PUNCH_GUARD:BEGIN'), e = src.indexOf('  /* PUNCH_GUARD:END */');
  if (a < 0 || e < 0) return null;
  return src.slice(a, e + '  /* PUNCH_GUARD:END */'.length);
}
const web = block('clock.html'), line = block('clock-line.html');
ok(web && line, '兩頁都有 PUNCH_GUARD 區塊');
eq(web, line, 'clock.html 與 clock-line.html 的 PUNCH_GUARD 區塊一致');
for (const f of fs.readdirSync(root).filter(f => /^clock-(cf|hq|mzt\w+)\.html$/.test(f))) {
  eq(block(f), web, f + ' 的 PUNCH_GUARD 區塊與母版一致（改母版後要重跑 tools/build-store-pages.py）');
}

const sb = {};
vm.createContext(sb);
vm.runInContext(web + '\nthis.api = { pgWhen, pgLastLabel, pgNextType, pgSameAlert, pgFirstOutAlert, PUNCH_PAIR_H };', sb);
const A = sb.api;

// 與後端 Cap10.gs 同口徑：配對視窗 16 小時（不准自己改門檻）
const cap = fs.readFileSync(path.join(root, 'apps-script/Cap10.gs'), 'utf8');
eq(+/var CAP_PAIR_H\s*=\s*(\d+)/.exec(cap)[1], A.PUNCH_PAIR_H, 'PUNCH_PAIR_H 與 Cap10.gs CAP_PAIR_H 同值');

const T = (md, hm) => '2026-' + md + 'T' + hm + ':00+08:00';
const ms = (md, hm) => new Date(T(md, hm)).getTime();

// 時間格式
eq(A.pgWhen(T('11-19', '10:02')), '11/19 10:02', 'pgWhen 11/19 10:02');
eq(A.pgWhen(T('01-05', '09:07')), '1/5 09:07', 'pgWhen 月日去前導零');
eq(A.pgWhen('2026-11-19 10:02:00'), '11/19 10:02', 'pgWhen 空白分隔也行');
eq(A.pgWhen(''), '', 'pgWhen 空字串');
eq(A.pgWhen('亂碼'), '', 'pgWhen 亂碼');
eq(A.pgLastLabel({ type: 'in', ts: T('11-19', '10:02') }), '11/19 10:02 上班', 'pgLastLabel 上班');
eq(A.pgLastLabel({ type: 'out', ts: T('11-19', '21:30') }), '11/19 21:30 下班', 'pgLastLabel 下班');
eq(A.pgLastLabel(null), '', 'pgLastLabel null');
eq(A.pgLastLabel({ type: 'x', ts: T('11-19', '10:02') }), '', 'pgLastLabel 型別不認得');

// A：上一筆上班又按上班
let a = A.pgSameAlert({ type: 'in', ts: T('11-19', '10:02') }, 'in');
ok(a, '上班後再按上班有提醒');
eq(a.msg, '你上一筆是 11/19 10:02 上班，現在又按「上班」。如果是要下班，請按「改按下班」。', '上班→上班 提醒文字');
eq(a.main, '改按下班', '主按鈕＝改按下班');
eq(a.sub, '確定是上班', '次按鈕＝確定是上班');
eq(a.switchTo, 'out', '主按鈕改送下班');
eq(a.missType, '下班', '補登提示講下班卡');
// 反過來
a = A.pgSameAlert({ type: 'out', ts: T('11-19', '21:30') }, 'out');
ok(a, '下班後再按下班有提醒');
eq(a.msg, '你上一筆是 11/19 21:30 下班，現在又按「下班」。如果是要上班，請按「改按上班」。', '下班→下班 提醒文字');
eq(a.main, '改按上班', '主按鈕＝改按上班');
eq(a.sub, '確定是下班', '次按鈕＝確定是下班');
eq(a.switchTo, 'in', '主按鈕改送上班');
// 不同型不提醒
eq(A.pgSameAlert({ type: 'in', ts: T('11-19', '10:02') }, 'out'), null, '上班後按下班不提醒');
eq(A.pgSameAlert({ type: 'out', ts: T('11-19', '21:30') }, 'in'), null, '下班後按上班不提醒');
eq(A.pgSameAlert(null, 'in'), null, '沒有前一筆不走同型提醒');
// 時間看不懂仍要提醒（只是少了時間）
a = A.pgSameAlert({ type: 'in', ts: 'abc' }, 'in');
ok(a && a.msg.indexOf('你上一筆是 上班，') === 0, '時間看不懂仍提醒');
// 今天第一張就按下班（既有確認，套同樣主次按鈕）
a = A.pgFirstOutAlert('out');
ok(a && a.msg.indexOf('你今天還沒打上班卡') === 0, '第一張就下班提醒保留原句');
eq(a.main, '改按上班', '第一張下班：主按鈕改按上班');
eq(a.sub, '確定是下班', '第一張下班：次按鈕確定是下班');
eq(a.switchTo, 'in', '第一張下班：主按鈕改送上班');
eq(A.pgFirstOutAlert('in'), null, '第一張按上班不提醒');

// B：該按哪顆
const now = ms('11-19', '20:00');
eq(A.pgNextType({ type: 'in', ts: T('11-19', '10:02') }, now), 'out', '上班 10 小時內 → 下班醒目');
eq(A.pgNextType({ type: 'in', ts: T('11-19', '04:00') }, now), 'out', '上班剛好 16 小時 → 仍是下班（<=16）');
eq(A.pgNextType({ type: 'in', ts: T('11-19', '03:59') }, now), 'in', '上班超過 16 小時 → 上班醒目');
eq(A.pgNextType({ type: 'in', ts: T('11-19', '19:59') }, now), 'out', '剛上班一分鐘 → 下班醒目');
eq(A.pgNextType({ type: 'in', ts: T('11-19', '20:05') }, now), 'out', '手機時鐘慢（上一筆在「未來」）→ 下班醒目');
eq(A.pgNextType({ type: 'out', ts: T('11-19', '19:00') }, now), 'in', '前一筆下班 → 上班醒目');
eq(A.pgNextType({ type: 'out', ts: T('11-10', '19:00') }, now), 'in', '前一筆下班很久以前 → 上班醒目');
eq(A.pgNextType(null, now), null, '無資料 → 原樣');
eq(A.pgNextType(undefined, now), null, 'undefined → 原樣');
eq(A.pgNextType({ type: 'in', ts: '' }, now), null, '時間空 → 原樣');
eq(A.pgNextType({ type: 'in', ts: 'abc' }, now), null, '時間亂碼 → 原樣');

// 靜態檢查：兩頁不再用原生 confirm 處理同型／第一張下班；提醒框、小字、加亮 class 都在
const wsrc = fs.readFileSync(path.join(root, 'clock.html'), 'utf8'), lsrc = fs.readFileSync(path.join(root, 'clock-line.html'), 'utf8');
ok(!/window\.confirm\(\s*'你今天還沒打上班卡/.test(wsrc + lsrc), '第一張下班不再用原生 confirm');
ok(!/window\.confirm\(\s*sameTypeMsg/.test(lsrc) && !/已經打過' \+ a \+ '卡/.test(wsrc), '同型再按不再用原生 confirm');
for (const [n, src] of [['clock.html', wsrc], ['clock-line.html', lsrc]]) {
  ok(/id="pgMask"/.test(src) && /id="pgMain"/.test(src) && /id="pgSub"/.test(src), n + ' 有頁面內提醒框');
  ok(/document\.getElementById\('pgMain'\)\.focus\(\)/.test(src), n + ' 主按鈕預設焦點');
  ok(/id="pgLast"/.test(src) && /pg-next/.test(src) && /pg-dim/.test(src), n + ' 有上一筆小字與加亮／變淡');
  ok(!/btn(In|Out)[^;]*\.disabled\s*=\s*[^;]*pg-/.test(src), n + ' 變淡不等於停用');
  ok(/pgSameAlert\(/.test(src) && /pgFirstOutAlert\(/.test(src) && /switchTo/.test(src), n + ' 兩種提醒都接上、主按鈕改送另一型');
}
ok(/applyPunchHint\(\);\s*\n\s*blockedType = null/.test(wsrc), 'clock.html：updateButtonStates 會更新提示');
ok(/applyPunchHint\(\);\s*\n\s*var r = status && status\.rest/.test(lsrc), 'clock-line.html：refreshButtons 會更新提示');

console.log(`punch-guard：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
