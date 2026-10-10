/* 參數設定「單項儲存」（2026-10-10 Eason：只套用到目前門市要一次單獨儲存一項，不要全部項目連動）
   ①後端 keys:true 只換送來的鍵、同 scope 其他鍵與他店原樣保留；不帶 keys 維持整批覆寫
   ②前端 saveCfg（從 payroll.html 抽出實跑）只送「該卡改過的欄位」、範圍看該卡自己的勾選
   ③四張卡的勾選不再互相同步 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('✗ ' + m); } };

/* ① 後端 */
const gs = fs.readFileSync(path.join(root, 'apps-script/Payroll.gs'), 'utf8');
const m = gs.match(/function handlePayrollConfigSet\(body\) \{[\s\S]*?\n\}\n/);
ok(m, '找得到 handlePayrollConfigSet');
function runSet(table, body) {
  const ctx = { TABLE: table.map(r => Object.assign({}, r)),
    checkAdmin: () => true,
    payRead: () => ctx.TABLE.map(r => Object.assign({}, r)),
    payReplaceAll: (n, rows) => { ctx.TABLE = rows; } };
  vm.createContext(ctx); vm.runInContext(m[0] + ';OUT=handlePayrollConfigSet(BODY)', Object.assign(ctx, { BODY: body }));
  return ctx;
}
const base = [
  { key: 'daily_hours', value: '8', store: '' }, { key: 'co_group', value: '1170', store: '' },
  { key: 'co_group', value: '900', store: 'CF' }, { key: 'attend_void_forget', value: '3', store: 'CF' },
  { key: 'co_group', value: '500', store: 'HQ' }];
const find = (t, k, s) => t.filter(r => r.key === k && String(r.store || '') === s);
let c = runSet(base, { config: { co_group: 1234 }, store: 'CF', keys: true });
ok(c.OUT.ok, 'keys 模式成功');
ok(find(c.TABLE, 'co_group', 'CF').length === 1 && find(c.TABLE, 'co_group', 'CF')[0].value === '1234', 'CF 團險換成 1234（只一列）');
ok(find(c.TABLE, 'attend_void_forget', 'CF')[0] && find(c.TABLE, 'attend_void_forget', 'CF')[0].value === '3', 'CF 其他參數保留');
ok(find(c.TABLE, 'daily_hours', 'CF').length === 0, '沒有把別的鍵順帶寫成 CF 專屬');
ok(find(c.TABLE, 'co_group', '')[0].value === '1170' && find(c.TABLE, 'co_group', 'HQ')[0].value === '500', '集團與他店不動');
ok(c.TABLE.length === 5, '總列數不變');
c = runSet(base, { config: { attend_void_forget: 5 }, store: 'HQ', keys: true });
ok(find(c.TABLE, 'attend_void_forget', 'HQ')[0].value === '5' && c.TABLE.length === 6, '新店鍵：新增一列');
c = runSet(base, { config: { daily_hours: 7.5 }, store: '', keys: true });
ok(find(c.TABLE, 'daily_hours', '')[0].value === '7.5' && find(c.TABLE, 'co_group', '')[0].value === '1170', '集團單項：其他集團鍵保留');
c = runSet(base, { config: { co_group: 1 }, store: 'CF' });
ok(find(c.TABLE, 'attend_void_forget', 'CF').length === 0, '不帶 keys＝舊行為整批覆寫（相容）');

/* ②③ 前端 */
const html = fs.readFileSync(path.join(root, 'payroll.html'), 'utf8');
ok(!/\$\('cfgOwn'\)\.checked=this\.checked/.test(html), '勾選不再同步到 cfgOwn');
ok(!/\$\('(att|pt|co)Own'\)\.checked=own/.test(html), 'renderCfg 不再把勾選同步到其他卡');
['cfg', 'att', 'pt', 'co'].forEach(k => ok(html.indexOf(`,'${k}')"`) > 0, `${k} 卡儲存按鈕帶卡別`));
const a = html.indexOf('let CFG_DIRTY='), b = html.indexOf('\n/* ═════ 紅字天數');
const cfgDecl = html.slice(html.indexOf('const CF=['), html.indexOf('const CFG_OBSOLETE'));
const co = html.match(/const CO_MANUAL=\[[^\n]*\n/)[0];
const front = html.slice(a, b).replace(/function renderCfg\(\)\{[\s\S]*?\n\}\n/, '');
function mkEl(checked) { return { checked, textContent: '' }; }
const ctx = { POSTS: [], toasts: [], STORE: 'CF', CFGSRC: { co_group: 'global', daily_hours: 'global', attend_void_forget: 'own' },
  CFG: { co_group: 1170, daily_hours: 8, attend_void_forget: 3, attend_forget_unit: 'punch', pt_attend_plus: 0, co_owner: 1405 },
  CFG_OBSOLETE: ['shortfall_deduct'], els: { cfgOwn: mkEl(false), attOwn: mkEl(false), ptOwn: mkEl(false), coOwn: mkEl(true) },
  $: id => ctx.els[id] || null, renderCfg: () => {}, toast: (t) => ctx.toasts.push(t),
  post: async (act, body) => { ctx.POSTS.push({ act, body }); return { ok: true }; },
  saveFX: async (btn, l, fn) => fn() };
vm.createContext(ctx);
vm.runInContext(co + front, ctx);
(async () => {
  vm.runInContext("cfgEdit('co_group',2000);cfgEdit('daily_hours',7)", ctx);
  await vm.runInContext("saveCfg(null,'儲存公司負擔','co')", ctx);
  let p = ctx.POSTS[0];
  ok(p && p.body.keys === true, '送出 keys:true');
  ok(p && JSON.stringify(p.body.config) === '{"co_group":2000}', '公司負擔卡只送團險（不帶基本參數改過的每日工時）：' + JSON.stringify(p && p.body.config));
  ok(p && p.body.store === 'CF', '範圍看公司負擔卡自己的勾選＝本店');
  ok(ctx.CFGSRC.co_group === 'own', '來源標示更新為本店');
  await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
  p = ctx.POSTS[1];
  ok(p && JSON.stringify(p.body.config) === '{"daily_hours":7}' && p.body.store === '', '基本參數卡未勾＝存集團、只送每日工時');
  const n = ctx.POSTS.length;
  await vm.runInContext("saveCfg(null,'儲存參數','cfg')", ctx);
  ok(ctx.POSTS.length === n, '沒有改過的欄位不送出');
  // 存成集團預設，但本店有專屬值 → 畫面還原成本店值
  vm.runInContext("cfgEdit('attend_void_forget',9)", ctx);
  await vm.runInContext("saveCfg(null,'儲存全勤參數','att')", ctx);
  ok(ctx.CFG.attend_void_forget === 3 && ctx.CFGSRC.attend_void_forget === 'own', '集團存檔不蓋掉畫面上本店專屬值');
  console.log(`config-single-save: ${pass} 通過, ${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();
