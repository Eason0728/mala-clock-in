// node tests/staff-sync.test.js —— 同仁名單 ↔ 薪資主檔差異清單（payroll.html staffDiff／syncAdd／syncStop，2026-10-28）
// 從 payroll.html 抽出真的程式來跑（不在測試裡另寫一份判斷邏輯）。全部假資料。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'payroll.html'), 'utf8');
const a = html.indexOf('let SYNC_ROSTER=null');
const b = html.indexOf('/* ═════ 參數 ═════ */');
if (a < 0 || b < 0 || b < a) { console.error('FAIL: 抽不到差異清單那段'); process.exit(1); }
const src = html.slice(a, b);

let passed = 0, failed = 0;
function ok(c, label, extra) {
  if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); }
}

function sandbox(over) {
  const calls = [];
  const sb = Object.assign({
    console, STORE: 'MZTJS', MASTER: [], EMBED: true, LOCAL_HOST: false,
    $: () => null, esc: (s) => String(s), toast: (m, bad) => calls.push(['toast', m, !!bad]),
    renderEmp() {}, renderAtt() {}, vClear() {}, confirm: () => true,
    post: async () => ({ ok: false })
  }, over || {});
  vm.createContext(sb);
  vm.runInContext(src + '\n;this.staffDiff=staffDiff;this.syncAdd=syncAdd;this.syncStop=syncStop;'
    + 'this._set=(k,v)=>{ if(k==="items") SYNC_ITEMS=v; if(k==="roster") SYNC_ROSTER=v; };', sb);
  sb._calls = calls;
  return sb;
}

const roster = {
  staff: [
    { emp_no: 'DZY001', name: '甲一', state: 'active', emp_id: 'MZTJS05', title: 'ft', hire_date: '2025-01-02', unit_name: '金山', title_name: '正職' },
    { emp_no: 'DZY002', name: '乙二', state: 'active', emp_id: 'MZTJS08', title: 'pt', hire_date: '', unit_name: '金山', title_name: '計時' },   // 新人
    { emp_no: 'DZY003', name: '丙三', state: 'disabled', emp_id: 'MZTJS09', title: 'pt' },
    { emp_no: 'DZY011', name: '子十一', state: 'active', emp_id: '', title: 'pt' },                                                          // 沒打卡帳號
    { emp_no: 'DZY012', name: '丑十二', state: 'active', emp_id: 'MZTJS20', title: 'pt' },                                                   // 主檔裡是停用
    { emp_no: 'DZY013', name: '寅十三', state: 'active', emp_id: 'MZTJS21', title: 'pt' }                                                    // 主檔同名不同編號
  ],
  ids: {
    MZTJS05: { name: '甲一', state: 'active', pay_store: 'MZTJS', unit_name: '金山' },
    MZTJS08: { name: '乙二', state: 'active', pay_store: 'MZTJS' },
    MZTJS09: { name: '丙三', state: 'disabled', pay_store: 'MZTJS' },
    MZTJS12: { name: '戊五', state: 'active', pay_store: 'SSLGF', unit_name: '新竹光復' },   // 光復來支援
    MZTJS13: { name: '卯 十三', state: 'active', pay_store: 'MZTJS' },
    MZTJS20: { name: '丑十二', state: 'active', pay_store: 'MZTJS' },
    MZTJS21: { name: '寅十三', state: 'active', pay_store: 'MZTJS' }
  }
};
const master = [
  { emp_id: 'MZTJS05', name: '甲一', active: 'true' },
  { emp_id: 'MZTJS09', name: '丙三', active: 'true' },       // 名單已停用 → 該停用
  { emp_id: 'MZTJS12', name: '戊五', active: 'true' },       // 支援的人被誤建 → 該停用（薪資歸光復）
  { emp_id: 'MZTJS13', name: '卯十三X', active: 'true' },    // 姓名不一致
  { emp_id: 'MZTJS77', name: '辰七七', active: 'true' },     // 對不到
  { emp_id: 'MZTJS20', name: '丑十二', active: 'false' },    // 停用中、名單在職 → 重新啟用
  { emp_id: 'MZTJS30', name: '寅十三', active: true },        // 布林 true 也算在職；同名不同編號
  { emp_id: 'MZTJS31', name: '已離職', active: 'false' }       // 停用的不比
];
const sb = sandbox();
const d = sb.staffDiff(master, roster, 'MZTJS');
const by = (k) => d.items.filter((x) => x.kind === k);
ok(d.n === 5 && d.m === 6, '1a: 同仁名單在職 5 人（未認領等都算）、主檔在職 6 人', { n: d.n, m: d.m });
ok(by('new').map((x) => x.p.emp_no).join() === 'DZY002,DZY011,DZY013', '1b: 新人＝名單在職、主檔沒有這個編號', by('new').map((x) => x.p.emp_no));
ok(by('new').find((x) => x.p.emp_no === 'DZY011').block.indexOf('打卡帳號') >= 0, '1c: 沒有打卡編號 → 帶入鎖住並說原因');
ok(by('new').find((x) => x.p.emp_no === 'DZY013').block.indexOf('同名') >= 0, '1d: 主檔已有同名不同編號 → 鎖住（避免一人兩份主檔）');
ok(!by('new').find((x) => x.p.emp_no === 'DZY002').block, '1e: 一般新人可以帶入');
ok(by('reactivate').map((x) => x.p.emp_no).join() === 'DZY012', '1f: 主檔停用中、名單在職 → 重新啟用');
const stop = by('stop').map((x) => x.row.emp_id + ':' + x.why);
ok(stop.length === 4 && /MZTJS30:.*對不到/.test(stop[3]) && /MZTJS09:同仁名單已停用/.test(stop[0]) && /MZTJS12:.*薪資應歸 SSLGF/.test(stop[1]) && /MZTJS77:.*對不到/.test(stop[2]), '1g: 該停用＝名單停用／屬別店／對不到', stop);
ok(by('name').map((x) => x.row.emp_id).join() === 'MZTJS13', '1h: 姓名不一致（空白不算差異）');
ok(!d.items.some((x) => x.row && x.row.emp_id === 'MZTJS31'), '1i: 主檔已停用的人不列');
ok(!d.items.some((x) => x.p && x.p.emp_no === 'DZY003'), '1j: 名單已停用的人不當新人');
const clean = sb.staffDiff([{ emp_id: 'MZTJS05', name: '甲一', active: 'true' }], { staff: [roster.staff[0]], ids: { MZTJS05: roster.ids.MZTJS05 } }, 'MZTJS');
ok(clean.items.length === 0 && clean.n === 1 && clean.m === 1, '1k: 對得上時沒有任何差異');

// ── 2. 帶入／停用：先 get 原樣送回、只改那一列；送出前要確認 ──
async function run() {
  const store = [{ emp_id: 'MZTJS05', name: '甲一', active: 'true', base: 30000, store: 'MZTJS' },
    { emp_id: 'MZTJS20', name: '丑十二', active: 'false', wage: 200, store: 'MZTJS' }];
  const sent = [];
  const sb2 = sandbox({
    post: async (action, body) => {
      if (action === 'payroll_master_get') return { ok: true, master: JSON.parse(JSON.stringify(store)) };
      if (action === 'payroll_master_set') { sent.push(JSON.parse(JSON.stringify(body.master))); store.splice(0, store.length, ...body.master); return { ok: true }; }
      return { ok: false };
    }
  });
  sb2._set('roster', roster);
  const items = sb2.staffDiff(store, roster, 'MZTJS').items;
  sb2._set('items', items);
  const iNew = items.findIndex((x) => x.kind === 'new' && x.p.emp_no === 'DZY002');
  await sb2.syncAdd(iNew, null);
  ok(sent.length === 1 && sent[0].length === 3, '2a: 帶入＝原本 2 列原樣送回＋1 列');
  ok(JSON.stringify(sent[0][0]) === JSON.stringify({ emp_id: 'MZTJS05', name: '甲一', active: 'true', base: 30000, store: 'MZTJS' }), '2b: 既有列一字不改');
  const add = sent[0][2];
  ok(add.emp_id === 'MZTJS08' && add.name === '乙二' && add.active === 'true' && add.is_full_time === 'false' && add.store === 'MZTJS', '2c: 新列帶編號、姓名、計時、門市', add);
  ok(add.base === '' && add.wage === '' && add.ot_rate === '' && add.labor_ins === '' && add.co_labor === '', '2d: 薪資欄位留空');
  // 重新啟用
  const iRe = items.findIndex((x) => x.kind === 'reactivate');
  await sb2.syncAdd(iRe, null);
  ok(sent.length === 2 && sent[1].find((e) => e.emp_id === 'MZTJS20').active === 'true' && sent[1].find((e) => e.emp_id === 'MZTJS20').wage === 200, '2e: 重新啟用只改 active、金額保留');
  // 有人搶先帶入了 → 不重複寫
  await sb2.syncAdd(iNew, null);
  ok(sent.length === 2 && sb2._calls.some((c) => c[0] === 'toast' && c[2] && /已經有這個編號/.test(c[1])), '2f: 主檔已有這個編號就不寫（不會建出兩列）');
  // 停用
  const its2 = [{ kind: 'stop', row: { emp_id: 'MZTJS05', name: '甲一' }, why: '同仁名單已停用' }];
  sb2._set('items', its2);
  await sb2.syncStop(0, null);
  ok(sent.length === 3 && sent[2].length === 3 && sent[2].find((e) => e.emp_id === 'MZTJS05').active === 'false' && sent[2].find((e) => e.emp_id === 'MZTJS05').base === 30000, '2g: 停用只改 active、列數不變');
  // 取消確認 → 不寫
  const sb3 = sandbox({ confirm: () => false, post: async (a) => { sent.push(a); return { ok: true, master: [] }; } });
  sb3._set('items', its2);
  const before = sent.length;
  await sb3.syncStop(0, null);
  const iN3 = items.findIndex((x) => x.kind === 'new' && !x.block);
  sb3._set('items', items);
  await sb3.syncAdd(iN3, null);
  ok(sent.length === before, '2h: 確認框按取消就完全不呼叫後端');
  // 鎖住的新人按不下去
  const sb4 = sandbox({ post: async (a) => { sent.push(a); return { ok: true, master: [] }; } });
  sb4._set('items', items);
  const iBlock = items.findIndex((x) => x.block);
  const b4 = sent.length;
  await sb4.syncAdd(iBlock, null);
  ok(sent.length === b4, '2i: 帶入鎖住的人直接呼叫也不寫');
  // 從不呼叫 bootstrap
  ok(src.indexOf('payroll_bootstrap') === -1, '2j: 差異清單這段沒有呼叫「從打卡名冊建立」');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
run();
