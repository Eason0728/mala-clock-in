/* 名冊表頭自癒（2026-08-26 事故）
 *
 * 舊試算表的 roster 只有 6 欄（emp_id…active），沒有 shift_in／shift_out。
 * handleSetShifts 原本用「程式常數 ROSTER_HEADERS」判斷欄位存在（那一定有），
 * 檢查永遠通過 → 值寫進沒有表頭的欄位 → readSheetAsObjects 依表頭取值就永遠讀不回來，
 * 而且回應是 {ok:true, updated:1} 看起來完全成功。
 * 實際後果：總部設班別回查是 undefined；光復也缺那兩欄，核定頁「預填班別」從沒生效過。
 */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const C = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

function FakeSheet(headers, rows) {
  this.headers = headers.slice();
  this.rows = (rows || []).map(r => r.slice());
}
FakeSheet.prototype.getDataRange = function () {
  const all = [this.headers].concat(this.rows);
  return { getValues: () => all.map(r => r.slice()) };
};
FakeSheet.prototype.getLastRow = function () { return this.rows.length + 1; };
FakeSheet.prototype.getRange = function (r, c, nr, nc) {
  const self = this;
  return {
    setValue: v => {
      while (self.rows[r - 2].length < c) self.rows[r - 2].push('');
      self.rows[r - 2][c - 1] = v;
    },
    setValues: vv => {
      for (let i = 0; i < vv.length; i++) for (let j = 0; j < vv[i].length; j++) {
        if (r + i === 1) { while (self.headers.length < c + j) self.headers.push(''); self.headers[c - 1 + j] = vv[i][j]; }
        else { while (self.rows[r + i - 2].length < c + j) self.rows[r + i - 2].push(''); self.rows[r + i - 2][c - 1 + j] = vv[i][j]; }
      }
    },
    setNumberFormat: () => {},
  };
};

function makeCtx(headers, rows) {
  const roster = new FakeSheet(headers, rows);
  const ss = { getSheetByName: n => (n === 'roster' ? roster : null) };
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { openById: () => ss, getActive: () => ss },
    Utilities: { formatDate: () => '2026-08-26T12:00:00+08:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) } };
  vm.createContext(sb);
  vm.runInContext(C, sb);
  vm.runInContext("checkAdmin = function(){ return true; };", sb);
  return { roster, call: (...a) => vm.runInContext('handleSetShifts', sb)(...a),
           read: () => vm.runInContext('readSheetAsObjects', sb)(roster).rows };
}

let pass = 0, fail = 0;
const chk = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${n}: ${JSON.stringify(got)}${ok ? '' : ' ← 應為 ' + JSON.stringify(want)}`); };

const OLD6 = ['emp_id', 'name', 'key', 'device_id', 'device_bound_at', 'active'];

console.log('══ 1) 舊的 6 欄名冊：寫入前要自動補表頭 ══');
{
  const c = makeCtx(OLD6, [['HQ-01', '吳佳宜', 'k1', 'd1', '', 'true']]);
  const r = c.call({ admin_key: 'x', shifts: [{ name: '吳佳宜', shift_in: '09:00', shift_out: '17:30' }] });
  chk('  回報成功', [r.ok, r.updated], [true, 1]);
  chk('  表頭已補上 shift 兩欄',
      [c.roster.headers.indexOf('shift_in') >= 0, c.roster.headers.indexOf('shift_out') >= 0], [true, true]);
  const row = c.read()[0];
  chk('  ⚠ 讀得回來（事故的核心：原本是 undefined）', [row.shift_in, row.shift_out], ['09:00', '17:30']);
  chk('  既有欄位沒被動到', [row.emp_id, row.name, row.key], ['HQ-01', '吳佳宜', 'k1']);
}

console.log('\n══ 2) 已有 shift 欄的名冊（央廚）：行為不變、不重複補 ══');
{
  const full = OLD6.concat(['shift_in', 'shift_out']);
  const c = makeCtx(full, [['CF01', '陳建樺', 'k', 'd', '', 'true', '08:30', '17:00']]);
  const r = c.call({ admin_key: 'x', shifts: [{ name: '陳建樺', shift_in: '09:00', shift_out: '17:30' }] });
  chk('  更新成功', r.updated, 1);
  chk('  欄數沒有暴增', c.roster.headers.filter(h => h === 'shift_in').length, 1);
  chk('  值已更新', [c.read()[0].shift_in, c.read()[0].shift_out], ['09:00', '17:30']);
}

console.log('\n══ 3) 找不到的人要回報，不可靜默 ══');
{
  const c = makeCtx(OLD6, [['HQ-01', '吳佳宜', 'k1', 'd1', '', 'true']]);
  const r = c.call({ admin_key: 'x', shifts: [{ name: '不存在的人', shift_in: '09:00', shift_out: '17:30' }] });
  chk('  not_found 有列出', r.not_found, ['不存在的人']);
  chk('  updated 為 0', r.updated, 0);
}

console.log(`\n${fail ? '❌ 有失敗' : '✅ 名冊表頭自癒正確'}（${pass}/${pass + fail}）`);
process.exit(fail ? 1 : 0);
