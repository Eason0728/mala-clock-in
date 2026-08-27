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

console.log('\n✅ liff-identity 全部通過');
