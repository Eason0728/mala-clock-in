/* setup_triggers：建立月表的兩個時間觸發器（2026-08-24）
 *
 * 背景：時間觸發器只能由已授權的執行身分建立，原本要進 Apps Script 編輯器手動點。
 * 2026-08-22 新開的央廚／總部漏了這步 → 月表函式都在、卻沒被排程 → 那兩家從沒有 yyyy-MM 分頁。
 * 重點驗「冪等」：這支會被重複呼叫（每次新開店、或懷疑觸發器掉了就跑一次），
 * 沒有先刪同名觸發器的話，同一支函式會被排兩次、每 10 分鐘跑兩遍。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function makeCtx(existing) {
  let triggers = (existing || []).map(fn => ({ fn }));
  const built = [];
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => null, getActive: () => null },
    Utilities: { formatDate: () => '2026-08-24T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn, __t: t })),
      deleteTrigger: h => { triggers = triggers.filter(t => t !== h.__t); },
      newTrigger: fn => {
        const spec = { fn };
        const api = {
          timeBased: () => api, everyMinutes: n => { spec.every = n + 'min'; return api; },
          everyDays: n => { spec.every = n + 'day'; return api; },
          atHour: h => { spec.hour = h; return api; },
          create: () => { triggers.push({ fn }); built.push(spec); },
        };
        return api;
      },
    },
  };
  vm.createContext(sb);
  vm.runInContext(C, sb);
  vm.runInContext("checkAdmin = function(b){ return b.admin_key === 'RIGHT'; };", sb);
  return { call: (...a) => vm.runInContext('handleSetupTriggers', sb)(...a),
           list: () => triggers.map(t => t.fn).sort(), built };
}

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

console.log('══ 1) 全新專案（沒有任何觸發器）══');
{
  const c = makeCtx([]);
  const r = c.call({ admin_key: 'RIGHT' });
  chk('  成功', r.ok, true);
  chk('  建立兩支', c.list(), ['dailyMonthlyRebuild', 'refreshCurrentMonth']);
  chk('  月表刷新＝每 10 分鐘', c.built.find(b => b.fn === 'refreshCurrentMonth').every, '10min');
  chk('  每日重算＝每天 05:00', [c.built.find(b => b.fn === 'dailyMonthlyRebuild').every,
       c.built.find(b => b.fn === 'dailyMonthlyRebuild').hour], ['1day', 5]);
}

console.log('\n══ 2) 冪等：重複呼叫不可排出重複觸發器 ══');
{
  const c = makeCtx([]);
  c.call({ admin_key: 'RIGHT' });
  c.call({ admin_key: 'RIGHT' });
  c.call({ admin_key: 'RIGHT' });
  chk('  呼叫三次仍只有兩支', c.list(), ['dailyMonthlyRebuild', 'refreshCurrentMonth']);
}

console.log('\n══ 3) 已有一支時，補齊另一支且不重複 ══');
{
  const c = makeCtx(['refreshCurrentMonth']);   // 光復的狀況：只建過這支
  const r = c.call({ admin_key: 'RIGHT' });
  chk('  補齊成兩支', c.list(), ['dailyMonthlyRebuild', 'refreshCurrentMonth']);
  chk('  有回報執行前狀態', r.before, ['refreshCurrentMonth']);
}

console.log('\n══ 4) 不可動到其他無關的觸發器 ══');
{
  const c = makeCtx(['someOtherJob', 'refreshCurrentMonth']);
  c.call({ admin_key: 'RIGHT' });
  chk('  無關的觸發器保留', c.list(), ['dailyMonthlyRebuild', 'refreshCurrentMonth', 'someOtherJob']);
}

console.log('\n══ 5) 權限：錯誤金鑰不可建立任何東西 ══');
{
  const c = makeCtx([]);
  const r = c.call({ admin_key: 'WRONG' });
  chk('  回 unauthorized', [r.ok, r.error], [false, 'unauthorized']);
  chk('  沒有建立任何觸發器', c.list(), []);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 觸發器建立全部正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
