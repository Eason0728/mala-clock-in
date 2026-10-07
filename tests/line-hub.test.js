// LINE 單一打卡入口集中服務（apps-script/LineHub.gs）：line_my_stores／line_bind_all／line_my_payslip。
// 載入真的 Liff.gs＋LineHub.gs，只把試算表、外部連線換成假的。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const SRC = ['Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8')).join('\n');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

function make(opts) {
  const fetched = [], localBinds = [];
  const ROSTERS = opts.rosters;           // {code: rows}，code 不在裡面＝讀不到
  const sandbox = {
    console,
    CONFIG: { LINE_CHANNEL_ID: '2011292256' },
    LINE_HUB_STORES_CONFIG: opts.config,
    UrlFetchApp: {
      // LINE token 驗證：token 'TOK_<uid>' → sub=<uid>
      fetch: (url, o) => {
        const t = o.payload.id_token || '';
        const ok = t.indexOf('TOK_') === 0;
        return { getResponseCode: () => ok ? 200 : 400,
                 getContentText: () => JSON.stringify(ok ? { sub: t.slice(4), aud: '2011292256' } : { error: 'x' }) };
      },
      fetchAll: (reqs) => reqs.map(r => { fetched.push(r); const b = JSON.parse(r.payload);
        return { getContentText: () => (opts.remoteReply ? opts.remoteReply(r.url, b) : JSON.stringify({ ok: true, name: 'x' })) }; }),
    },
    getSS: () => ({ getSheetByName: () => (ROSTERS[''] ? { rows: ROSTERS[''] } : null) }),
    SpreadsheetApp: { openById: (id) => { const code = id.replace('SS_', ''); if (!(code in ROSTERS)) throw new Error('no access');
      return { getSheetByName: () => ({ rows: ROSTERS[code] }) }; } },
    readSheetAsObjects: (sh) => ({ rows: sh.rows }),
    payStoreList: () => opts.payStores || [],
    payClockRead: (code, name) => { if (!(opts.payRosters || {})[code]) throw new Error('no'); return opts.payRosters[code]; },
    payRead: (k) => (k === 'master' ? (opts.master || []) : []),
    payMyPayslipFor_: (me, store, ym) => ({ ok: true, picked: me.emp_id, store, ym }),
    currentYmTaipei: () => '2026-10',
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // 光復本機綁定：換成記錄呼叫，不碰試算表
  sandbox.handleLiffBind_ = (b) => { localBinds.push(b); return { ok: true }; };
  return { s: sandbox, fetched, localBinds };
}

const CONFIG = [
  { code: '', name: '小辛辣 新竹光復', ss_id: '', api: '' },
  { code: 'mztjs', name: '墨竹亭 新竹金山', ss_id: 'SS_mztjs', api: 'https://js/exec' },
  { code: 'hq', name: '鼎兆元 總部', ss_id: 'SS_hq', api: 'https://hq/exec' },
  { code: 'cf', name: '鼎兆元 中央廚房', ss_id: 'SS_cf', api: 'https://cf/exec' },   // 讀不到
];
const R = (emp_id, name, key, extra) => Object.assign({ emp_id, name, key, active: 'true', line_user_id: '' }, extra || {});

ok('line_my_stores：回綁定這個 LINE 的店、不回 key、讀不到的店列 unreadable', () => {
  const { s } = make({ config: CONFIG, rosters: {
    '': [R('E01', '甲', 'kA', { line_user_id: 'U1' }), R('E02', '乙', 'kB', { line_user_id: 'U2' })],
    mztjs: [R('J01', '甲', 'kJ', { line_user_id: 'U1' }), R('J02', '甲二', 'kJ2', { line_user_id: 'U1', active: 'false' })],
    hq: [R('H01', '甲', 'kH')] } });
  const r = s.handleLineMyStores_({ id_token: 'TOK_U1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.stores.map(x => x.code + ':' + x.emp_id)), [':E01', 'mztjs:J01']);
  assert.deepStrictEqual(Array.from(r.unreadable), ['cf']);
  assert(!/kA|kJ|kH/.test(JSON.stringify(r)), '不可回 key');
});
ok('line_my_stores：token 無效 → invalid_id_token', () => {
  const { s } = make({ config: CONFIG, rosters: { '': [] } });
  assert.strictEqual(s.handleLineMyStores_({ id_token: 'bad' }).error, 'invalid_id_token');
});

const rosters = () => ({
  '': [R('E01', '甲', 'kA')],
  mztjs: [R('J01', '甲', 'kJ', { line_user_id: 'U1' }), R('J09', '丙', 'kC')],
  hq: [R('H01', '甲', 'kH', { line_user_id: 'U9' })],
});
ok('line_bind_all 不帶 confirm：只列清單、不寫入，狀態 free／bound_self／bound_other', () => {
  const { s, fetched, localBinds } = make({ config: CONFIG, rosters: rosters() });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kJ' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.name, '甲');
  assert.deepStrictEqual(Array.from(r.stores.map(x => x.code + ':' + x.state)), [':free', 'mztjs:bound_self', 'hq:bound_other']);
  assert.strictEqual(fetched.length, 0); assert.strictEqual(localBinds.length, 0);
  assert(!/kA|kJ|kH/.test(JSON.stringify(r)), '不可回 key');
});
ok('line_bind_all confirm：只綁 free 的店；光復走本機，其他店走 fetchAll，帶該店自己的 key', () => {
  const rs = rosters(); rs.hq = [R('H01', '甲', 'kH')];   // hq 改成 free
  const { s, fetched, localBinds } = make({ config: CONFIG, rosters: rs });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA', confirm: true });
  assert.strictEqual(localBinds.length, 1); assert.strictEqual(localBinds[0].key, 'kA');
  assert.strictEqual(fetched.length, 1); assert.strictEqual(fetched[0].url, 'https://hq/exec');
  assert.deepStrictEqual(Object.assign({}, JSON.parse(fetched[0].payload)), { action: 'liff_bind', id_token: 'TOK_U1', key: 'kH' });
  assert.deepStrictEqual(Array.from(r.results.map(x => x.code + ':' + x.ok)), [':true', 'mztjs:true', 'hq:true']);
  assert(!/kA|kJ|kH/.test(JSON.stringify(r)), '回應不可含 key');
});
ok('line_bind_all confirm：遠端回錯誤或不是 JSON → 列出哪家失敗，其他照綁', () => {
  const rs = rosters(); rs.hq = [R('H01', '甲', 'kH')];
  const { s } = make({ config: CONFIG, rosters: rs, remoteReply: () => '<html>Google error</html>' });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA', confirm: true });
  const hq = r.results.find(x => x.code === 'hq');
  assert.strictEqual(hq.ok, false); assert.strictEqual(hq.error, 'unreachable');
  assert.strictEqual(r.results.find(x => x.code === '').ok, true);
});
ok('line_bind_all：已綁別人的店不會被綁（bound_other 原樣回報）', () => {
  const { s, fetched } = make({ config: CONFIG, rosters: rosters() });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA', confirm: true });
  assert.strictEqual(fetched.length, 0);
  assert.strictEqual(r.results.find(x => x.code === 'hq').error, 'bound_other');
});
ok('line_bind_all：confirm 必須是 true 本身，字串 "true" 不算', () => {
  const { s, localBinds } = make({ config: CONFIG, rosters: rosters() });
  s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA', confirm: 'true' });
  assert.strictEqual(localBinds.length, 0);
});
ok('line_bind_all：金鑰錯／離職者的金鑰／空金鑰 → invalid_key', () => {
  const rs = rosters(); rs[''].push(R('E05', '丁', 'kOld', { active: 'false' }));
  const { s } = make({ config: CONFIG, rosters: rs });
  assert.strictEqual(s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'nope' }).error, 'invalid_key');
  assert.strictEqual(s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kOld' }).error, 'invalid_key');
  assert.strictEqual(s.handleLineBindAll_({ id_token: 'TOK_U1', key: '  ' }).error, 'invalid_key');
});
ok('line_bind_all：同店兩位在職同名 → name_conflict，不自動綁', () => {
  const rs = rosters(); rs.hq = [R('H01', '甲', 'kH'), R('H02', '甲', 'kH2')];
  const { s, fetched } = make({ config: CONFIG, rosters: rs });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA', confirm: true });
  assert.strictEqual(r.results.find(x => x.code === 'hq').error, 'name_conflict');
  assert.strictEqual(fetched.length, 0);
});
ok('line_bind_all：同店同名但另一位已停用 → 只算在職那位', () => {
  const rs = rosters(); rs.hq = [R('H01', '甲', 'kH'), R('H00', '甲', 'kOld', { active: 'false' })];
  const { s } = make({ config: CONFIG, rosters: rs });
  const r = s.handleLineBindAll_({ id_token: 'TOK_U1', key: 'kA' });
  assert.strictEqual(r.stores.find(x => x.code === 'hq').emp_id, 'H01');
});
ok('沒有設定檔時只認光復', () => {
  const { s } = make({ config: undefined, rosters: { '': [R('E01', '甲', 'kA', { line_user_id: 'U1' })] } });
  delete s.LINE_HUB_STORES_CONFIG;
  assert.deepStrictEqual(Array.from(s.handleLineMyStores_({ id_token: 'TOK_U1' }).stores.map(x => x.code)), ['']);
});
ok('line_my_payslip：多店時優先取薪資主檔有的那個 emp_id', () => {
  const { s } = make({ config: CONFIG, rosters: {}, payStores: [{ code: 'SSLGF' }, { code: 'MZTJS' }],
    payRosters: { SSLGF: [R('E01', '甲', 'kA', { line_user_id: 'U1' })], MZTJS: [R('MZTJS12', '甲', 'kJ', { line_user_id: 'U1' })] },
    master: [{ emp_id: 'MZTJS12' }] });
  const r = s.handleLineMyPayslip_({ id_token: 'TOK_U1', ym: '2026-09' });
  assert.strictEqual(r.picked, 'MZTJS12'); assert.strictEqual(r.store, 'MZTJS'); assert.strictEqual(r.ym, '2026-09');
});
ok('line_my_payslip：沒綁 → not_bound；token 無效 → invalid_id_token', () => {
  const { s } = make({ config: CONFIG, rosters: {}, payStores: [{ code: 'SSLGF' }], payRosters: { SSLGF: [R('E01', '甲', 'kA')] } });
  assert.strictEqual(s.handleLineMyPayslip_({ id_token: 'TOK_U1' }).error, 'not_bound');
  assert.strictEqual(s.handleLineMyPayslip_({ id_token: 'x' }).error, 'invalid_id_token');
});
console.log(`\n${n} 項全部通過`);
