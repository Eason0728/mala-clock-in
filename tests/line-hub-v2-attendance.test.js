// v2 webhook「出勤紀錄」：載入整份真的 Code.gs（buildRecentDays／monthTotalsFor／buildLatestApprovedMap），
// 確認聊天室回覆跟網頁版用的是同一套算法。
const assert = require('assert');
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
  LINE_HUB_BOT_TOKEN: 'BOT',
  UrlFetchApp: { fetch: (u, o) => { if (u.indexOf('/reply') >= 0) replies.push(JSON.parse(o.payload)); return { getContentText: () => '{}', getResponseCode: () => 200 }; } },
  SpreadsheetApp: { openById: (id) => ssOf(id.replace('SS_', '')) },
  Utilities: { formatDate: (d, tz, f) => { const t = new Date(d.getTime() + 8 * 3600000).toISOString(); return f === 'yyyy-MM-dd' ? t.slice(0, 10) : t.slice(0, 7); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
};
vm.createContext(sb); vm.runInContext(SRC, sb);
sb.getSS = () => ssOf('');
sb.readSheetAsObjects = (sh) => ({ rows: sh.__rows.map(r => Object.assign({}, r)) });
sb.handleLineWebhook_({ events: [{ type: 'message', replyToken: 'RT', source: { userId: 'U1' }, message: { type: 'text', text: '出勤紀錄' } }] });
const t = replies[0] && replies[0].messages[0].text;
console.log(t);
assert(t, '要有回覆');
assert(/10\/7（三）鼎兆元 總部\n　09:00–13:00｜核定 4h/.test(t), '總部那天：時段＋核定 4 小時');
assert(/10\/7（三）墨竹亭 新竹金山\n　17:00–21:00｜待核定/.test(t), '金山那天：同一天另一家店分開列、待核定');
assert(/本月（10 月）核定合計 4 小時/.test(t), '本月合計跨店加總');
console.log('\n✓ 出勤紀錄回覆使用真的 Code.gs 算法，跨店分開列、合計正確');
