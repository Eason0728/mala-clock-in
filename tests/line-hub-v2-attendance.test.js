// v2 webhook「出勤紀錄」：載入整份真的 Code.gs（buildRecentDays／monthTotalsFor／buildLatestApprovedMap），
// 確認聊天室回覆跟網頁版用的是同一套算法。
const assert = require('assert');
// 回覆可能是文字或卡片（Flex）：把卡片裡所有 text 串起來比對
function msgText(m) { if (!m) return ''; if (m.type === 'text') return m.text; const out = []; (function w(x) { if (Array.isArray(x)) x.forEach(w); else if (x && typeof x === 'object') { if (x.type === 'text') out.push(x.text); Object.values(x).forEach(w); } })(m.contents); return out.join('\n'); }

const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = ['Code.gs', 'Liff.gs', 'LineHub.gs'].map(f => fs.readFileSync(ROOT + '/apps-script/' + f, 'utf8')).join('\n');
const STORES = require(ROOT + '/tools/stores.json');
const NOW = Date.parse('2026-10-08T10:00:00+08:00');
const replies = [];
const sheets = {
  hq:    { roster: [{ emp_id: 'H01', name: '甲', key: 'k', active: 'true', line_user_id: 'U1' }],
           events: [{ ts: '2026-10-07T09:00:00+08:00', emp_id: 'H01', type: 'in', status: 'ok' },
                    { ts: '2026-10-07T13:00:00+08:00', emp_id: 'H01', type: 'out', status: 'ok' }],
           approved: [{ date: '2026-10-07', emp_id: 'H01', name: '甲', periods: '09:00-13:00', approved_hours: 4, status_text: '正常', manager_name: 'x', entered_at: '2026-10-07T20:00:00+08:00' }] },
  mztjs: { roster: [{ emp_id: 'J01', name: '甲', key: 'k2', active: 'true', line_user_id: 'U1' }],
           events: [{ ts: '2026-10-07T17:00:00+08:00', emp_id: 'J01', type: 'in', status: 'ok' },
                    { ts: '2026-10-07T21:00:00+08:00', emp_id: 'J01', type: 'out', status: 'ok' }],
           approved: [] },
};
const ssOf = (code) => ({ getSheetByName: (n) => (sheets[code] && sheets[code][n]) ? { __rows: sheets[code][n] } : null });
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
const sb = {
  console, Date: FakeDate,
  LINE_HUB_STORES_CONFIG: STORES.map(s => ({ code: s.code, name: s.name, api: 'x', ss_id: 'SS_' + s.code, lat: s.lat, lng: s.lng, radius_m: s.radius_m })),
  LINE_HUB_BOT_TOKEN: 'BOT', LINE_HUB_BOT_USER_ID: 'BOTU',
  UrlFetchApp: { fetch: (u, o) => { if (u.indexOf('/reply') >= 0) replies.push(JSON.parse(o.payload)); return { getContentText: () => '{}', getResponseCode: () => 200 }; } },
  SpreadsheetApp: { openById: (id) => ssOf(id.replace('SS_', '')) },
  Utilities: { formatDate: (d, tz, f) => { const t = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyy-MM-dd' ? t.slice(0, 10) : t.slice(0, 7); } },
  CacheService: { getScriptCache: () => { const m = {}; return { get: k => m[k] || null, put: (k, v) => { m[k] = v; }, remove: k => { delete m[k]; } }; } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
};
vm.createContext(sb); vm.runInContext(SRC, sb);
sb.getSS = () => ssOf('');
sb.readSheetAsObjects = (sh) => ({ rows: sh.__rows.map(r => Object.assign({}, r)) });
sb.handleLineWebhook_({ destination: 'BOTU', events: [{ type: 'message', replyToken: 'RT', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '出勤紀錄' } }] });
const t = replies[0] && msgText(replies[0].messages[0]);
console.log(t);
assert(t, '要有回覆');
assert.strictEqual(replies[0].messages[0].type, 'flex', '出勤紀錄回卡片');
assert(/10\/7（三） 09:00–13:00\n鼎兆元 總部\n核定 4h/.test(t), '卡片：總部那天時段＋核定 4 小時');
assert(/10\/7（三） 17:00–21:00\n墨竹亭 新竹金山\n待核定/.test(t), '卡片：同一天另一家店分開列、待核定');
assert(/本月（10 月）\n尚有 1 天待核定\n4 小時/.test(t), '卡片：本月合計跨店加總');
assert(!/\d+ 小時/.test(replies[0].messages[0].altText), 'altText 不露時數');
// 文字版（小畫面以外的備用）照舊
const tx = sb.lineHubAttendanceText_('U1');
assert(/10\/7（三）鼎兆元 總部\n　09:00–13:00｜核定 4h/.test(tx) && /本月（10 月）核定合計 4 小時/.test(tx), tx);
console.log('\n✓ 出勤紀錄回覆使用真的 Code.gs 算法，跨店分開列、合計正確');
