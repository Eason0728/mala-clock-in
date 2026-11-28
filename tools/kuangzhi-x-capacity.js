#!/usr/bin/env node
/* 曠職合約 v1.2：sched_pub 每格多帶排除代號 x 之後，一期班表離 SchedPub.gs 的 too_big 上限（SCHED_PUB_MAX_CHARS＝45,000 字）還有多遠。
 * 全部假資料：用 apps-script 裡真正的 schedPubClean_（＋Code.gs kzPubX_）把假的發布內容洗一次，量 JSON.stringify 後的字數（＝寫入前判 too_big 用的同一個數）。
 * 最壞情況：每位同仁 28 格全是 W、每格都帶最長的代號 hq_off（每格多 13 字：,"x":"hq_off"）。
 * 用法：node tools/kuangzhi-x-capacity.js            → 印 JSON（各種班別代號長度下，帶／不帶 x 一期最多幾人、某人數下的字數）
 *       require('./tools/kuangzhi-x-capacity.js').measure({...}) → 給測試用（tests/kuangzhi-x.test.js） */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const AS = path.join(__dirname, '..', 'apps-script');

function sandbox() {
  const sb = { console, Logger: { log() {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: () => null }), openById: () => ({ getSheetByName: () => null }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { formatDate: () => '2026-12-01' } };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(AS, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(AS, 'SchedPub.gs'), 'utf8'), sb, { filename: 'cap.gs' });
  return sb;
}
let SB = null;
/** o：people（人數）、sid（班別代號）、w（站別代號，'' 不帶）、nShifts（班別清單幾種）、withX（每個 W 格帶 hq_off）、work（28 格裡幾格 W，其餘 R） */
function payload(o) {
  const shifts = Array.from({ length: o.nShifts || 6 }, (_, i) => ({ id: i ? o.sid + i : o.sid, name: '總部班別名稱十字' + i, start: '09:00', end: '18:00', break_min: 60 }));
  const rows = Array.from({ length: o.people }, (_, k) => ({ emp_id: 'HQ' + String(1000 + k), name: '測試同仁' + k,
    cells: Array.from({ length: 28 }, (_, i) => {
      if (i >= (o.work == null ? 28 : o.work)) return { t: 'R' };
      const c = { t: 'W', s: o.sid };
      if (o.w) c.w = o.w;
      if (o.withX) c.x = 'hq_off';
      return c;
    }) }));
  return { v: 2, store: 'hq', period: 'T03', seq: 1, op_id: 'cap', start: '2026-12-27', days: 28, shifts, rows,
    stations: o.w ? [{ id: o.w, name: '站別名稱' }] : undefined };
}
function chars(o) {
  SB = SB || sandbox();
  return JSON.stringify(SB.schedPubClean_(payload(o))).length;
}
function maxPeople(o) {
  let n = 0;
  while (chars(Object.assign({}, o, { people: n + 1 })) <= 45000) n++;
  return n;
}
/** 回 { limit, shapes:[{label, per_person_no_x, per_person_x, x_per_person, max_no_x, max_x}] } */
function measure(shapes) {
  SB = SB || sandbox();
  const limit = SB.SCHED_PUB_MAX_CHARS;
  return { limit, shapes: shapes.map((s) => {
    const a1 = chars(Object.assign({}, s, { people: 1 })), a2 = chars(Object.assign({}, s, { people: 2 }));
    const b1 = chars(Object.assign({}, s, { people: 1, withX: true })), b2 = chars(Object.assign({}, s, { people: 2, withX: true }));
    return { label: s.label, per_person_no_x: a2 - a1, per_person_x: b2 - b1, x_per_person: (b2 - b1) - (a2 - a1),
      max_no_x: maxPeople(s), max_x: maxPeople(Object.assign({}, s, { withX: true })) };
  }) };
}
const SHAPES = [
  { label: '短代號（S3、無站別）', sid: 'S3', w: '' },
  { label: '總部支援門市班（HQ.MZTMC.S12、站別 8 字）', sid: 'HQ.MZTMC.S12', w: 'st-abcde' },
  { label: '最長情況（出差＋兩班 trip:HQ.MZTMC.S12+S3、站別 32 字）', sid: 'trip:HQ.MZTMC.S12+S3', w: 'x'.repeat(32) },
];
module.exports = { measure, chars, maxPeople, SHAPES };
if (require.main === module) process.stdout.write(JSON.stringify(measure(SHAPES), null, 1) + '\n');
