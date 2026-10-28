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
    console, STORE: 'MZTJS', MASTER: [], EMBED: true, LOCAL_HOST: false, SCOPE: '*', scopeLimited: () => false,
    $: () => null, esc: (s) => String(s), toast: (m, bad) => calls.push(['toast', m, !!bad]),
    renderEmp() {}, renderAtt() {}, vClear() {}, confirm: () => true,
    post: async () => ({ ok: false })
  }, over || {});
  vm.createContext(sb);
  vm.runInContext(src + '\n;this.staffDiff=staffDiff;this.syncAdd=syncAdd;this.syncStop=syncStop;'
    + 'this._set=(k,v)=>{ if(k==="items") SYNC_ITEMS=v; if(k==="roster"){ SYNC_ROSTER=v; SYNC_KEY=v.store; } if(k==="open") SYNC_OPEN=v; };'
    + 'this.renderStaffSync=renderStaffSync;this._getItems=()=>SYNC_ITEMS;this.loadStaffSync=loadStaffSync;', sb);
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
ok(stop.length === 2 && /MZTJS09:同仁名單已停用/.test(stop[0]) && /MZTJS12:.*薪資應歸 SSLGF/.test(stop[1]), '1g: 該停用＝只剩有正面證據的（名單停用／屬別店）', stop);
const chk = by('check').map((x) => x.row.emp_id + ':' + x.why);
ok(chk.length === 2 && /MZTJS77:.*對不到/.test(chk[0]) && /MZTJS30:.*對不到/.test(chk[1]), '1g2: 對不到打卡編號 → 待確認，不是該停用', chk);
ok(by('name').map((x) => x.row.emp_id).join() === 'MZTJS13', '1h: 姓名不一致（空白不算差異）');
ok(!d.items.some((x) => x.row && x.row.emp_id === 'MZTJS31'), '1i: 主檔已停用的人不列');
ok(!d.items.some((x) => x.p && x.p.emp_no === 'DZY003'), '1j: 名單已停用的人不當新人');
const yw = sb.staffDiff([{ emp_id: 'HQ-09', name: '壬九', active: 'true' }], { staff: [], ids: { 'HQ-09': { name: '壬九', state: 'active', pay_store: '', pay_none: true, unit_name: '一悟燒肉品牌辦公室' } } }, 'HQ');
ok(yw.n === 0 && yw.items.length === 1 && /一悟品牌辦公室尚未設薪資門市/.test(yw.items[0].why), '1l: 一悟品牌辦公室的人不算新人；若被誤建在別家主檔，標「尚未設薪資門市」');
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
  const its2 = [{ kind: 'stop', store: 'MZTJS', row: { emp_id: 'MZTJS05', name: '甲一' }, why: '同仁名單已停用' }];
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

  // ── 3. 切換門市的競態（mala-clock-in#11 審查必修）：A 店清單不可寫進 B 店 ──
  // 假 post 照正式 post 的行為：body 沒帶 store 就用「當下」的 STORE（Object.assign({store:STORE}, body)）
  function storeSb(over) {
    const log = [];
    const db = { MZTJS: [{ emp_id: 'MZTJS05', name: '甲一', active: 'true', store: 'MZTJS' }], CF: [{ emp_id: 'CF01', name: '央一', active: 'true', store: 'CF' }] };
    const box = { style: {}, innerHTML: '' };
    let x;
    x = sandbox(Object.assign({
      $: (id) => (id === 'staffSync' ? box : null),
      post: async (action, body) => {
        const st = Object.assign({ store: x.STORE }, body || {}).store;
        log.push([action, st]);
        if (action === 'payroll_master_get') return { ok: true, master: JSON.parse(JSON.stringify(db[st] || [])) };
        if (action === 'payroll_master_set') { db[st] = JSON.parse(JSON.stringify(body.master)); return { ok: true }; }
        return { ok: false };
      }
    }, over || {}));
    x._log = log; x._db = db; x._box = box;
    return x;
  }
  const rosterJs = { store: 'MZTJS', staff: [{ emp_no: 'DZY002', name: '乙二', state: 'active', emp_id: 'MZTJS08', title: 'pt', hire_date: '' }], ids: {} };
  // 3a：按下「帶入」後、確認框還開著時切到 CF
  const s3 = storeSb();
  s3.STORE = 'MZTJS'; s3._set('roster', rosterJs);
  const it3 = s3.staffDiff(s3._db.MZTJS, rosterJs, 'MZTJS').items;
  s3._set('items', it3);
  s3.confirm = () => { s3.STORE = 'CF'; return true; };
  await s3.syncAdd(0, null);
  ok(s3._db.CF.length === 1 && s3._db.CF[0].emp_id === 'CF01', '3a: 確認框開著時切門市 → B 店主檔不被寫入', s3._db.CF);
  ok(!s3._log.some((l) => l[0] === 'payroll_master_set'), '3b: 確認框開著時切門市 → 完全沒有 master_set', s3._log);
  ok(s3._calls.some((c) => c[0] === 'toast' && /門市已切換/.test(c[1])), '3c: 提示「門市已切換，沒有寫入」');
  // 3d：STORE 已換成 CF、畫面上還是 MZTJS 的清單（名單還在讀）就按下
  const s4 = storeSb();
  s4.STORE = 'MZTJS'; s4._set('roster', rosterJs);
  s4._set('items', s4.staffDiff(s4._db.MZTJS, rosterJs, 'MZTJS').items);
  try { s4._tag && s4._tag('MZTJS'); } catch (e) {}
  s4.STORE = 'CF';
  await s4.syncAdd(0, null);
  ok(s4._db.CF.length === 1 && !s4._log.some((l) => l[0] === 'payroll_master_set'), '3d: 清單屬 A 店、目前是 B 店 → 不寫', s4._log);
  // 3e：停用同樣守住
  const s5 = storeSb();
  s5.STORE = 'MZTJS';
  s5._set('items', [{ kind: 'stop', store: 'MZTJS', row: { emp_id: 'MZTJS05', name: '甲一' }, why: 'x' }]);
  s5.confirm = () => { s5.STORE = 'CF'; return true; };
  await s5.syncStop(0, null);
  ok(s5._db.MZTJS[0].active === 'true' && !s5._log.some((l) => l[0] === 'payroll_master_set'), '3e: 停用時切門市 → 不寫', s5._log);
  // 3f：正常情況，get／set 都明確帶清單所屬門市，新列 store 也是它
  const s6 = storeSb();
  s6.STORE = 'MZTJS'; s6._set('roster', rosterJs);
  s6._set('items', s6.staffDiff(s6._db.MZTJS, rosterJs, 'MZTJS').items);
  await s6.syncAdd(0, null);
  ok(s6._log.filter((l) => /master/.test(l[0])).every((l) => l[1] === 'MZTJS') && s6._db.MZTJS.length === 2 && s6._db.MZTJS[1].store === 'MZTJS', '3f: 正常帶入寫在清單所屬門市', s6._log);
  // 3g：切門市後重新讀名單的期間，舊清單要先清掉
  let release;
  const s7 = storeSb({ });
  s7.STORE = 'MZTJS'; s7._set('roster', rosterJs);
  s7._set('items', s7.staffDiff(s7._db.MZTJS, rosterJs, 'MZTJS').items);
  s7._box.innerHTML = '<button>帶入</button>';
  s7.post = (action) => new Promise((res) => { release = () => res({ ok: true, store: 'CF', staff: [], ids: {} }); });
  s7.STORE = 'CF';
  const pend = s7.loadStaffSync();
  ok(s7._getItems().length === 0 && s7._box.innerHTML.indexOf('帶入') === -1, '3g: 讀取新門市名單期間，舊門市的按鈕與清單已清掉', s7._box.innerHTML);
  release(); await pend;
  // 3h：職稱空白不給帶入
  const d8 = s7.staffDiff([], { store: 'CF', staff: [{ emp_no: 'DZY050', name: '未知', state: 'active', emp_id: 'CF50', title: '' }], ids: {} }, 'CF');
  const m9 = /function empPayBlank\(e\)\{[^\n]*\}/.exec(html);
  const ctx9 = { n: (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; } }; vm.createContext(ctx9); vm.runInContext(m9[0] + ';this.f=empPayBlank;', ctx9);
  ok(ctx9.f({ active: 'true', base: '', wage: '' }) && !ctx9.f({ active: 'true', base: 30000, wage: '' }) && !ctx9.f({ active: 'false', base: '', wage: '' }) && /empPayBlank\(e\)\?/.test(html), '3i: 在職且底薪時薪都空白 → 員工設定標紅');
  ok(d8.items.length === 1 && /職稱/.test(d8.items[0].block), '3h: 職稱空白 → 帶入鎖住（不猜正職／計時）');

  // ── 4. 資料不完整不等於該停用：只有正面證據才進「該停用」，其餘進「待確認」（無按鈕）──
  const r4 = { store: 'MZTJS', staff: [], ids: {
    A1: { name: '假甲', state: 'active', pay_store: '', unit_name: '' },
    A2: { name: '假乙', state: 'active', pay_store: '', unit_name: '某未對應單位' },
    A3: { name: '假丙', state: 'missing' },
    A4: { name: '假丁', state: 'disabled', pay_store: 'MZTJS' },
    A5: { name: '假戊', state: 'left', pay_store: 'MZTJS' },
    A6: { name: '假己', state: 'active', pay_store: 'SSLGF', unit_name: '他店' },
    A7: { name: '假庚', state: 'active', pay_store: '', pay_none: true, unit_name: '一悟品牌辦公室' },
    A8: { name: '假辛', state: 'active', pay_store: 'MZTJS' }
  } };
  const m4 = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map((id) => ({ emp_id: id, name: id === 'A0' ? '假無' : (r4.ids[id].name), active: 'true' }));
  const d4 = sb.staffDiff(m4, r4, 'MZTJS');
  const k4 = {}; d4.items.forEach((x) => { k4[x.row.emp_id] = x.kind; });
  ok(k4.A0 === 'check' && k4.A1 === 'check' && k4.A2 === 'check' && k4.A3 === 'check', '4a: 對不到／單位空白／單位未對應／查無此人 → check', k4);
  ok(k4.A4 === 'stop' && k4.A5 === 'stop' && k4.A6 === 'stop' && k4.A7 === 'stop', '4b: 已停用／已離職／別家店／一悟品牌辦公室 → 仍是 stop', k4);
  ok(k4.A8 === undefined, '4c: 正常在職且屬本店 → 不列');
  const w = (id) => d4.items.find((x) => x.row.emp_id === id).why;
  ok(/未填/.test(w('A1')) && /某未對應單位/.test(w('A2')) && /補/.test(w('A1')), '4d: check 說明有單位名稱或「未填」，並叫人去補同仁名單', [w('A1'), w('A2')]);
  // 渲染：check 區塊沒有按鈕／onclick；stop 仍有停用鈕；摘要有「待確認」
  const box4 = { style: {}, innerHTML: '' };
  const s8 = sandbox({ $: (id) => (id === 'staffSync' ? box4 : null), MASTER: m4 });
  s8._set('roster', r4); s8._set('open', true);
  s8.renderStaffSync();
  const h = box4.innerHTML;
  const secCheck = h.slice(h.indexOf('④ 待確認'));
  ok(h.indexOf('④ 待確認') >= 0 && h.indexOf('這裡不能停用') >= 0 && /待確認 <b>4<\/b>/.test(h) && /該停用 <b>4<\/b>/.test(h), '4e: 摘要與「④ 待確認」區塊文字', h.slice(0, 400));
  ok(secCheck.indexOf('onclick') === -1 && secCheck.indexOf('<button') === -1 && secCheck.indexOf('A1') >= 0, '4f: 待確認列沒有按鈕、沒有 onclick');
  ok((h.match(/syncStop\(/g) || []).length === 4, '4g: 停用鈕只有 4 個（stop 項）', (h.match(/syncStop\(/g) || []).length);
  // syncStop 拒絕 check（直接用 check 的 index 呼叫）
  const sent4 = [];
  const s9 = sandbox({ MASTER: m4, post: async (a, b) => { sent4.push(a); return { ok: true, master: m4 }; } });
  s9._set('items', d4.items);
  const iChk = d4.items.findIndex((x) => x.kind === 'check');
  await s9.syncStop(iChk, null);
  ok(sent4.length === 0, '4h: syncStop 對 check 項目什麼都不做（不呼叫後端）', sent4);


  // ── 5. 負責門市（payroll-scope fix2-2）：平台對範圍外的編號只回 {state, pay_store, pay_none}（沒有姓名、單位、here）──
  {
    const thin = { staff: [], ids: {
      CF01: { name: '央一', emp_no: 'DZY101', state: 'active', pay_store: 'CF', pay_none: false, unit_name: '央廚', store_code: 'cf', here: true },
      'HQ-10': { state: 'active', pay_store: 'HQ', pay_none: false },     // 別家薪資門市來支援：只剩三欄
      'HQ-09': { state: 'active', pay_store: '', pay_none: true },        // 一悟
      'HQ-11': { state: 'active', pay_store: '', pay_none: false },       // 單位沒對應薪酬門市
      'HQ-12': { state: 'left', pay_store: 'HQ', pay_none: false } } };
    const m4 = [{ emp_id: 'CF01', name: '央一', active: 'true' }, { emp_id: 'HQ-10', name: '誤建甲', active: 'true' },
      { emp_id: 'HQ-09', name: '誤建乙', active: 'true' }, { emp_id: 'HQ-11', name: '誤建丙', active: 'true' }, { emp_id: 'HQ-12', name: '誤建丁', active: 'true' }];
    const d4 = sb.staffDiff(m4, thin, 'CF');
    const why = Object.fromEntries(d4.items.map((x) => [x.row.emp_id, x.why || '']));
    ok(/薪資應歸 HQ/.test(why['HQ-10']) && !/undefined|所屬單位/.test(why['HQ-10']), '5a: 範圍外編號沒有 unit_name → 只寫「薪資應歸 HQ」，不印 undefined／空單位', why['HQ-10']);
    ok(/一悟品牌辦公室尚未設薪資門市/.test(why['HQ-09']) && !/undefined|（—）/.test(why['HQ-09']), '5b: 一悟（沒有 unit_name）不印空括號', why['HQ-09']);
    ok(!!why['HQ-11'] && !/undefined/.test(why['HQ-11']), '5c: 沒有對應薪酬門市也不印 undefined', why['HQ-11']);
    ok(/已離職/.test(why['HQ-12']) && !/undefined/.test(why['HQ-12']), '5d: 狀態欄照常判斷（沒有姓名就不加括號）', why['HQ-12']);
    ok(!d4.items.some((x) => x.row.emp_id === 'CF01'), '5e: 本店完整的編號照常比對（對得上不列）');
    ok(!d4.items.some((x) => x.kind === 'name'), '5f: 範圍外沒有姓名 → 不會被當成「姓名不一致」');
    // 畫出來也沒有 undefined
    const box = { style: {}, innerHTML: '' };
    const s9 = sandbox({ $: (id) => (id === 'staffSync' ? box : null), STORE: 'CF', MASTER: m4 });
    s9._set('roster', Object.assign({ store: 'CF' }, thin));
    vm.runInContext('SYNC_OPEN=true; renderStaffSync();', s9);
    ok(box.innerHTML.length > 0 && box.innerHTML.indexOf('undefined') === -1 && /薪資應歸 HQ/.test(box.innerHTML), '5g: renderStaffSync 畫面不出現 undefined', box.innerHTML.match(/.{0,40}undefined.{0,40}/g));
    // loadStaffSync 帶本店主檔的 emp_ids（平台只回這些編號的對照）
    const sentBody = [];
    const box2 = { style: {}, innerHTML: '' };
    const s10 = sandbox({ $: (id) => (id === 'staffSync' ? box2 : null), STORE: 'CF',
      MASTER: [{ emp_id: ' CF01 ' }, { emp_id: 'CF02' }, { emp_id: '' }, { emp_id: 7 }, { emp_id: 'CF02' }],
      post: async (a, b) => { sentBody.push([a, b]); return { ok: true, store: 'CF', staff: [], ids: {} }; } });
    await s10.loadStaffSync(true);
    const ds = sentBody.find((x) => x[0] === 'payroll_dzy_staff');
    ok(ds && ds[1].store === 'CF' && JSON.stringify(ds[1].emp_ids) === JSON.stringify(['CF01', 'CF02', '7']), '5h: payroll_dzy_staff 帶 store＋本店主檔 emp_ids（trim、去空白、去重、轉字串）', ds && ds[1]);
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
run();
