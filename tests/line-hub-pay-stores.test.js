// LINE 薪資明細／假別額度：2026-11-05 Eason 開放全部門市（原本只開小辛辣光復、央廚）。
// lineHubPayPick_ 不再看店別：薪資有接的店找得到人就回；有主檔的那家優先；找不到人＝「查不到你的薪資資料」。
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = ['Liff.gs', 'LineHub.gs'].map((f) => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n')
  + '\n' + /function payMineMaster_[\s\S]*?\n}\n/.exec(fs.readFileSync(__dirname + '/../apps-script/Payroll.gs', 'utf8'))[0];
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

ok('開放名單已拿掉', () => {
  assert.ok(SRC.indexOf('LINE_HUB_PAY_STORES') < 0);
});
ok('小辛辣光復、央廚同仁 → 找得到人（不變）', () => {
  assert.strictEqual(make({ SSLGF: [r('E01')] }, [{ emp_id: 'E01', store: 'SSLGF' }]).sb.lineHubPayPick_('U1').store, 'SSLGF');
  assert.strictEqual(make({ CF: [r('CF01')] }, [{ emp_id: 'CF01', store: 'CF' }]).sb.lineHubPayPick_('U1').store, 'CF');
});
ok('總部、金山、六張犁同仁 → 現在也找得到', () => {
  assert.strictEqual(make({ HQ: [r('HQ-02')] }, [{ emp_id: 'HQ-02', store: 'HQ' }]).sb.lineHubPayPick_('U1').store, 'HQ');
  assert.strictEqual(make({ MZTJS: [r('MZTJS05')] }, [{ emp_id: 'MZTJS05', store: 'MZTJS' }]).sb.lineHubPayPick_('U1').store, 'MZTJS');
  assert.strictEqual(make({ MZTLZL: [r('MZTLZL01')] }, []).sb.lineHubPayPick_('U1').store, 'MZTLZL');
});
ok('跨店支援（光復＋金山都綁、主檔在光復）→ 光復；主檔在金山 → 金山', () => {
  assert.strictEqual(make({ SSLGF: [r('E05')], MZTJS: [r('MZTJS12')] }, [{ emp_id: 'E05', store: 'SSLGF' }]).sb.lineHubPayPick_('U1').store, 'SSLGF');
  assert.strictEqual(make({ SSLGF: [r('E05')], MZTJS: [r('MZTJS12')] }, [{ emp_id: 'MZTJS12', store: 'MZTJS' }]).sb.lineHubPayPick_('U1').store, 'MZTJS');
});
ok('薪資有接的店都找不到這個人 → 薪資明細、假別額度回「查不到你的薪資資料」；快取不記', () => {
  const { sb, cache } = make({ HQ: [r('HQ-02', 'U-other')] }, []);
  const txt = (m) => JSON.stringify(m);
  assert.ok(/查不到你的薪資資料/.test(txt(sb.lineHubPayCard_('U1'))));
  assert.ok(/查不到你的薪資資料/.test(txt(sb.lineHubLeaveCard_('U1'))));
  assert.ok(!Object.keys(cache).some((k) => k.indexOf('lhp2:') === 0));
});
ok('金山同仁還沒有已定案薪資單 → 薪資卡說明結算定案後會顯示（不是「沒有開放」）', () => {
  const { sb } = make({ MZTJS: [r('MZTJS05')] }, [{ emp_id: 'MZTJS05', store: 'MZTJS' }]);
  sb.currentYmTaipei = () => '2026-11';
  const t = JSON.stringify(sb.lineHubPayCard_('U1'));
  assert.ok(/結算定案後這裡就會顯示明細/.test(t) && !/沒有開放/.test(t));
});
console.log('\n' + n + ' 項全過');
