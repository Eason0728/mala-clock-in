// LINE 薪資明細／假別額度只開放小辛辣光復（SSLGF）與央廚（CF）（2026-10-10 Eason）
// 擋在 lineHubPayPick_：薪資卡、假別額度卡、打卡回覆的到期提醒、申請頁的額度與補休都一起擋。判斷用主檔的店，沒有主檔才用名冊那家。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = ['Liff.gs', 'LineHub.gs'].map((f) => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function make(rosters, master) {
  const cache = {};
  const sb = { console, Date, JSON, Math, String, Number, isNaN, isFinite, parseInt,
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; }, removeAll() {} }) },
    normCellTs: (v) => v };
  vm.createContext(sb); vm.runInContext(SRC, sb);
  Object.assign(sb, {
    payStoreList: () => ['SSLGF', 'CF', 'HQ', 'MZTJS', 'MZTLZL'].map((code) => ({ code })),
    payClockRead: (code) => rosters[code] || [],
    payRead: (t) => (t === 'master' ? master : []),
    payStore: (v) => String(v || 'SSLGF'),
    payMyPayslipFor_: () => ({ ok: true, ready: false, ym: '2026-10', leave_quota: [{ name: '特休假', cap_days: 7 }] }),
    lineHubMine_: () => [{ st: { code: 'x' }, row: {} }],
  });
  return { sb, cache };
}
const r = (emp_id, uid) => ({ emp_id, name: '測試', active: 'true', line_user_id: uid || 'U1' });

ok('開放名單＝小辛辣光復＋央廚', () => {
  const { sb } = make({}, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vm.runInContext('LINE_HUB_PAY_STORES', sb))), ['SSLGF', 'CF']);
});
ok('小辛辣光復、央廚同仁 → 找得到人', () => {
  assert.strictEqual(make({ SSLGF: [r('E01')] }, [{ emp_id: 'E01', store: 'SSLGF' }]).sb.lineHubPayPick_('U1').store, 'SSLGF');
  assert.strictEqual(make({ CF: [r('CF01')] }, [{ emp_id: 'CF01', store: 'CF' }]).sb.lineHubPayPick_('U1').store, 'CF');
});
ok('總部、金山、六張犁同仁（主檔在那家）→ null', () => {
  assert.strictEqual(make({ HQ: [r('HQ-02')] }, [{ emp_id: 'HQ-02', store: 'HQ' }]).sb.lineHubPayPick_('U1'), null);
  assert.strictEqual(make({ MZTJS: [r('MZTJS05')] }, [{ emp_id: 'MZTJS05', store: 'MZTJS' }]).sb.lineHubPayPick_('U1'), null);
  assert.strictEqual(make({ MZTLZL: [r('MZTLZL01')] }, []).sb.lineHubPayPick_('U1'), null);
});
ok('墨竹亭光復同仁掛在金山名冊、沒有主檔 → null', () => {
  assert.strictEqual(make({ MZTJS: [r('MZTJS01')] }, []).sb.lineHubPayPick_('U1'), null);
});
ok('跨店支援（光復＋金山都綁、主檔在光復）→ 光復', () => {
  const x = make({ SSLGF: [r('E05')], MZTJS: [r('MZTJS12')] }, [{ emp_id: 'E05', store: 'SSLGF' }]).sb.lineHubPayPick_('U1');
  assert.strictEqual(x.store, 'SSLGF');
});
ok('名冊在光復但主檔在金山 → null（看的是主檔那家的薪資）', () => {
  assert.strictEqual(make({ SSLGF: [r('E09')] }, [{ emp_id: 'E09', store: 'MZTJS' }]).sb.lineHubPayPick_('U1'), null);
});
ok('被擋的人：薪資明細、假別額度回同一句說明；打卡到期提醒空白；快取不記', () => {
  const { sb, cache } = make({ HQ: [r('HQ-02')] }, [{ emp_id: 'HQ-02', store: 'HQ' }]);
  const txt = (m) => JSON.stringify(m);
  assert.ok(/沒有開放在 LINE 查薪資與假別額度/.test(txt(sb.lineHubPayCard_('U1'))));
  assert.ok(/沒有開放在 LINE 查薪資與假別額度/.test(txt(sb.lineHubLeaveCard_('U1'))));
  assert.strictEqual(sb.lineHubAnnualNote_('U1', '2026-10-10T09:00:00+08:00'), '');
  assert.ok(!Object.keys(cache).some((k) => k.indexOf('lhp2:') === 0));
});
ok('快取鍵換成 lhp2（上線前 5 分鐘內的舊快取不沿用）', () => {
  assert.ok(SRC.indexOf("'lhp2:' + userId") > 0 && SRC.indexOf("'lhp:' + userId") < 0);
});
console.log('\n' + n + ' 項全過');
