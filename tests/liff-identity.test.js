const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 載入 Liff.gs 到 sandbox，並注入假的 UrlFetchApp
function loadLiff(fetchImpl) {
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: fetchImpl },
    CONFIG: { LINE_CHANNEL_ID: '2011292256' },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

// 1. 驗證成功時回傳 sub
{
  const s = loadLiff(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sub: 'U1234567890abcdef', aud: '2011292256' }),
  }));
  assert.strictEqual(s.verifyLineIdToken_('good-token'), 'U1234567890abcdef');
  console.log('✓ 有效 token 回傳 userId');
}

// 2. 非 200 回傳 null
{
  const s = loadLiff(() => ({ getResponseCode: () => 400, getContentText: () => '{"error":"invalid"}' }));
  assert.strictEqual(s.verifyLineIdToken_('bad-token'), null);
  console.log('✓ 無效 token 回傳 null');
}

// 3. aud 不符必須拒絕（防別的 channel 的 token 冒用）
{
  const s = loadLiff(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ sub: 'Uxxxx', aud: '9999999999' }),
  }));
  assert.strictEqual(s.verifyLineIdToken_('other-channel-token'), null);
  console.log('✓ aud 不符的 token 被拒絕');
}

// 4. 空 token 不打 API 直接回 null
{
  let called = false;
  const s = loadLiff(() => { called = true; return null; });
  assert.strictEqual(s.verifyLineIdToken_(''), null);
  assert.strictEqual(called, false, '空 token 不應該打外部 API');
  console.log('✓ 空 token 短路');
}

// 5. findRosterByLineUser_
{
  const s = loadLiff(() => null);
  const rows = [
    { emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Uaaa' },
    { emp_id: 'E02', key: 'k2', active: 'true', line_user_id: '' },
    { emp_id: 'E03', key: 'k3', active: 'false', line_user_id: 'Uccc' },
  ];
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uaaa').emp_id, 'E01');
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uzzz'), undefined);
  assert.strictEqual(s.findRosterByLineUser_(rows, ''), undefined, '空 userId 不可比對到空欄位');
  assert.strictEqual(s.findRosterByLineUser_(rows, 'Uccc'), undefined, '離職者不可查得');
  console.log('✓ findRosterByLineUser_ 正確');
}

// 6. HTTP 200 但 body 不是有效 JSON（gateway 異常、API 改版等）→ 回 null 而非 throw
{
  const s = loadLiff(() => ({
    getResponseCode: () => 200,
    getContentText: () => '<html>oops</html>',
  }));
  assert.strictEqual(s.verifyLineIdToken_('malformed-response'), null);
  console.log('✓ 無效 JSON 的 200 回應回傳 null 而非 throw');
}

// ── 綁定 handler ──
// bindLog：模擬 liff_bind_log 分頁的 appendRow 目的地（2026-08-27 審查 Important 6）。
// 傳 undefined 時用一次性的空陣列，呼叫端不關心稽核紀錄的測試不用動。
function loadLiffWithSheet(fetchImpl, rows, writes, bindLog) {
  bindLog = bindLog || [];
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const fakeSheet = { __name: 'roster' };
  // 稽核紀錄分頁直接假設已存在（getSheetByName 命中），專門測「分頁不存在時會自動建立」
  // 的情境另外用獨立的 sandbox（見下面「稽核紀錄分頁不存在」測試），這裡不重複繞這條路。
  const bindLogSheet = {
    __name: 'liff_bind_log',
    getRange: () => ({ setValues: () => {} }),
    appendRow: (row) => { bindLog.push(row); },
  };
  const sandbox = {
    UrlFetchApp: { fetch: fetchImpl },
    getSS: () => ({
      getSheetByName: (n) => (n === 'roster' ? fakeSheet : (n === 'liff_bind_log' ? bindLogSheet : null)),
      insertSheet: () => bindLogSheet,
    }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: (sheet) => { writes.push(['__ensure', sheet === fakeSheet]); },
    setRosterCell: (sheet, rowIndex, header, val, asText) => {
      writes.push([rowIndex, header, val, !!asText]); return true;
    },
    nowTaipeiIso: () => '2026-08-27T12:00:00+08:00',
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  sandbox.__bindLog = bindLog;
  return sandbox;
}
const okFetch = (sub) => () => ({
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({ sub: sub, aud: '2011292256' }),
});

// 7. 成功綁定：先確保欄位存在，再寫入兩欄（line_bound_at 需鎖成文字）
{
  const writes = [];
  const rows = [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  const r = s.handleLiffBind_({ id_token: 't', key: 'k1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.emp_id, 'E01');
  assert.deepStrictEqual(writes[0], ['__ensure', true], '寫入前必須先呼叫 ensureRosterHeaders');
  assert.deepStrictEqual(writes[1], [5, 'line_user_id', 'Unew', false]);
  assert.deepStrictEqual(writes[2], [5, 'line_bound_at', '2026-08-27T12:00:00+08:00', true]);
  assert.strictEqual(s.__bindLog.length, 1, '成功綁定必須留一筆稽核紀錄（Important 6）');
  // Array.from：logLiffBind_ 是在 vm sandbox（另一個 realm）裡執行的 Liff.gs 本體程式碼，
  // 它 new 出來的陣列跟這裡（host realm）的陣列字面量即使內容相同，deepStrictEqual 也會
  // 因為不同 realm 判定「同構但不 reference-equal」而失敗——先攤平成 host realm 的陣列再比對。
  assert.deepStrictEqual(Array.from(s.__bindLog[0]), ['2026-08-27T12:00:00+08:00', 'E01', '測試一', 'Unew', 'bind']);
  console.log('✓ 綁定成功：先補欄位，再寫回兩欄，時間戳鎖文字，並留一筆稽核紀錄');
}

// 8. 啟用碼錯誤
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'WRONG' }).error, 'invalid_key');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0, '失敗時不可寫入任何一格');
  console.log('✓ 錯誤啟用碼被拒絕且未寫入');
}

// 9. 該員工已綁別的 LINE 帳號 → 需店長解綁
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Uold', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Unew'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'k1' }).error, 'already_bound_other_user');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0);
  console.log('✓ 已綁他人帳號時拒絕');
}

// 10. 同一 LINE 帳號想綁第二位員工 → 拒絕
{
  const writes = [];
  const rows = [
    { emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Udup', __rowIndex: 5 },
    { emp_id: 'E02', key: 'k2', active: 'true', line_user_id: '', __rowIndex: 6 },
  ];
  const s = loadLiffWithSheet(okFetch('Udup'), rows, writes);
  assert.strictEqual(s.handleLiffBind_({ id_token: 't', key: 'k2' }).error, 'line_account_in_use');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0);
  console.log('✓ 一個 LINE 帳號不可綁兩位員工');
}

// 11. 重綁自己（同一 userId 同一員工）視為成功，且不重複寫入
{
  const writes = [];
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: 'Usame', __rowIndex: 5 }];
  const s = loadLiffWithSheet(okFetch('Usame'), rows, writes);
  const r = s.handleLiffBind_({ id_token: 't', key: 'k1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0, '已是同一組時不該重寫');
  console.log('✓ 重複綁定自己不報錯也不重寫');
}

// 12. 取不到 roster 分頁 → no_roster，不可 throw
{
  const writes = [];
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Unew') },
    getSS: () => ({ getSheetByName: () => null }),
    readSheetAsObjects: () => { throw new Error('不該被呼叫'); },
    ensureRosterHeaders: () => { throw new Error('不該被呼叫'); },
    setRosterCell: () => { throw new Error('不該被呼叫'); },
    nowTaipeiIso: () => '', console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.strictEqual(sandbox.handleLiffBind_({ id_token: 't', key: 'k1' }).error, 'no_roster');
  console.log('✓ 沒有 roster 分頁時乾淨回錯，不 throw');
}

// 11. liff_clock 應轉呼叫 handleClock，且帶入該員工的 key
{
  const rows = [{ emp_id: 'E01', name: '測試一', key: 'SECRET_KEY_1', active: 'true', line_user_id: 'Ume' }];
  let received = null;
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Ume') },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? { __name: 'roster' } : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: () => {},
    setRosterCell: () => true,
    nowTaipeiIso: () => '2026-08-27T12:00:00+08:00',
    handleClock: (b) => { received = b; return { ok: true, status: 'ok' }; },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const r = sandbox.LIFF_HANDLERS.liff_clock({
    id_token: 't', type: 'in', lat: 24.784, lng: 121.015, accuracy: 12, device_id: 'D1',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(received.key, 'SECRET_KEY_1', '必須帶入該員工的 key');
  assert.strictEqual(received.type, 'in', '原本的參數必須原封傳遞');
  assert.strictEqual(received.accuracy, 12);
  assert.strictEqual(received.id_token, undefined, 'id_token 不應傳進既有 handler');
  console.log('✓ liff_clock 正確轉接');
}

// 12. 未綁定者打卡 → not_bound，且不可呼叫 handleClock
{
  const rows = [{ emp_id: 'E01', key: 'k1', active: 'true', line_user_id: '' }];
  let called = false;
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Ustranger') },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? { __name: 'roster' } : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: () => {}, setRosterCell: () => true, nowTaipeiIso: () => '',
    handleClock: () => { called = true; return { ok: true }; },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const r = sandbox.LIFF_HANDLERS.liff_clock({ id_token: 't', type: 'in' });
  assert.strictEqual(r.error, 'not_bound');
  assert.strictEqual(called, false, '未綁定不可進入既有打卡邏輯');
  console.log('✓ 未綁定者被擋在轉接層之外');
}

// ══════ 2026-08-27 審查 Important 4：一帳號一員工的不變量，離職列不能是漏洞 ══════

// 13. 離職列上殘留的 userId 之後被復職，仍要擋下綁定到別的員工
//     舊 bug：衝突檢查用 findRosterByLineUser_，只看 active==='true'，離職列查不到、
//     於是「這個 LINE 帳號沒被用過」的假象讓綁定放行。
{
  const writes = []; const bindLog = [];
  const rows = [
    { emp_id: 'E01', key: 'k1', active: 'false', line_user_id: 'Uold', __rowIndex: 5 },  // 已離職，但 userId 還留著
    { emp_id: 'E02', key: 'k2', active: 'true', line_user_id: '', __rowIndex: 6 },
  ];
  const s = loadLiffWithSheet(okFetch('Uold'), rows, writes, bindLog);
  const r = s.handleLiffBind_({ id_token: 't', key: 'k2' });
  assert.strictEqual(r.error, 'line_account_in_use', '離職列的 userId 也要擋下，不能只看在職列');
  assert.strictEqual(writes.filter(w => w[0] !== '__ensure').length, 0, '被擋下時不可寫入');
  assert.strictEqual(bindLog.length, 0, '被擋下時不可留稽核紀錄');
  console.log('✓ 離職列殘留的 LINE 帳號仍會擋下綁定到別的員工');
}

// 14. withLineIdentity_ fail closed：一個 userId 若同時命中兩個在職列
//     （代表「一帳號一員工」的不變量已經被破壞——理論上會被第 13 項的檢查擋住，
//     這裡測的是「萬一資料還是壞了」那一層保險），必須明確回錯，不可悄悄取 [0] 繼續執行。
{
  const rows = [
    { emp_id: 'E01', key: 'SECRET_KEY_1', active: 'true', line_user_id: 'Udup' },
    { emp_id: 'E02', key: 'SECRET_KEY_2', active: 'true', line_user_id: 'Udup' },
  ];
  let called = false;
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Udup') },
    getSS: () => ({ getSheetByName: (n) => (n === 'roster' ? { __name: 'roster' } : null) }),
    readSheetAsObjects: () => ({ rows: rows }),
    handleClock: () => { called = true; return { ok: true, status: 'ok' }; },
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const r = sandbox.LIFF_HANDLERS.liff_clock({ id_token: 't', type: 'in' });
  assert.strictEqual(r.error, 'line_identity_conflict');
  assert.strictEqual(called, false, '不變量被破壞時不可以悄悄取第一筆繼續往下執行');
  console.log('✓ 一個 LINE 帳號命中兩個在職列時 withLineIdentity_ fail closed，不悄悄取 [0]');
}

// ══════ 2026-08-27 審查 Important 6：綁定稽核紀錄 ══════

// 15. 稽核紀錄：失敗路徑與「重綁自己」的 idempotent 成功都不該留一筆
//     （已在 7 驗證過「真的新綁定」會留一筆；這裡驗證的是反面——不該記的絕對不能記）
{
  const cases = [
    {
      name: '啟用碼錯誤（invalid_key）', sub: 'Unew', body: { id_token: 't', key: 'WRONG' },
      rows: [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }],
    },
    {
      name: '該員工已綁別的 LINE 帳號（already_bound_other_user）', sub: 'Unew', body: { id_token: 't', key: 'k1' },
      rows: [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: 'Uold', __rowIndex: 5 }],
    },
    {
      name: '這個 LINE 帳號已綁別人（line_account_in_use）', sub: 'Udup', body: { id_token: 't', key: 'k2' },
      rows: [
        { emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: 'Udup', __rowIndex: 5 },
        { emp_id: 'E02', name: '測試二', key: 'k2', active: 'true', line_user_id: '', __rowIndex: 6 },
      ],
    },
    {
      name: '重綁自己（already：不是新的綁定事件）', sub: 'Usame', body: { id_token: 't', key: 'k1' },
      rows: [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: 'Usame', __rowIndex: 5 }],
    },
  ];
  cases.forEach(function (c) {
    const bindLog = [];
    const s = loadLiffWithSheet(okFetch(c.sub), c.rows, [], bindLog);
    s.handleLiffBind_(c.body);
    assert.strictEqual(bindLog.length, 0, c.name + '：不該寫入稽核紀錄');
  });
  console.log('✓ 失敗路徑與重綁自己都不會寫入稽核紀錄');
}

// 16. 稽核紀錄分頁不存在時：先建立分頁並寫入表頭，再 append 這一筆
{
  const headerWrites = []; const bindLog = [];
  const rows = [{ emp_id: 'E01', name: '測試一', key: 'k1', active: 'true', line_user_id: '', __rowIndex: 5 }];
  const fakeRoster = { __name: 'roster' };
  let insertedSheetName = null;
  const bindLogSheet = {
    getRange: () => ({ setValues: (vv) => { headerWrites.push(vv[0]); } }),
    appendRow: (row) => { bindLog.push(row); },
  };
  const src = fs.readFileSync(__dirname + '/../apps-script/Liff.gs', 'utf8');
  const sandbox = {
    UrlFetchApp: { fetch: okFetch('Unew') },
    getSS: () => ({
      getSheetByName: (n) => (n === 'roster' ? fakeRoster : null),   // liff_bind_log 還不存在
      insertSheet: (n) => { insertedSheetName = n; return bindLogSheet; },
    }),
    readSheetAsObjects: () => ({ rows: rows }),
    ensureRosterHeaders: () => {},
    setRosterCell: () => true,
    nowTaipeiIso: () => '2026-08-27T12:00:00+08:00',
    console: console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const r = sandbox.handleLiffBind_({ id_token: 't', key: 'k1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(insertedSheetName, 'liff_bind_log', '分頁不存在時要自動建立');
  assert.deepStrictEqual(Array.from(headerWrites[0]), ['ts', 'emp_id', 'name', 'line_user_id', 'type'], '建立分頁時要先寫表頭');
  assert.strictEqual(bindLog.length, 1);
  assert.deepStrictEqual(Array.from(bindLog[0]), ['2026-08-27T12:00:00+08:00', 'E01', '測試一', 'Unew', 'bind']);
  console.log('✓ 稽核紀錄分頁不存在時會自動建立、寫入表頭，再寫入這一筆');
}

console.log('\n✅ liff-identity 全部通過');
