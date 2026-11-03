/**
 * 仿 Google 試算表的假 Sheet（只給本機 vm 測試用，2026-11-03）
 * ─────────────────────────────────────────────────────────────────────────────
 * 既有測試（tests/*.test.js 的 sheet()、mock/mock_server.py）把儲存格當純字串，
 * 但真的 Google 試算表在 appendRow／setValue／setValues 寫入「字串」時，會像使用者在格子裡打字一樣
 * 自動判斷型別；讀回（getValue／getValues）拿到的就是轉過型的值。本檔模擬那套規則。
 * 試算表時區固定 Asia/Taipei（台灣沒有夏令時間，固定 +08:00）。
 *
 * ▌寫入字串時的轉型規則（格子不是純文字格式 '@' 才轉；每條標 [已查證] 或 [推定]）
 *  1. [已查證] 整體原則：setValue／setValues／appendRow 的字串「照使用者在畫面上打字的規則」解析
 *     （Apps Script Range 文件只明寫 '=' 開頭當公式；Sheets API ValueInputOption=USER_ENTERED 文件明寫
 *      「字串可能被轉成數字、日期等，規則同畫面輸入」，例：'Mar 1 2016'→日期、'$100.15'→數字＋貨幣格式）。
 *     https://developers.google.com/apps-script/reference/spreadsheet/range
 *     https://developers.google.com/sheets/api/reference/rest/v4/ValueInputOption
 *  2. [已查證] 'yyyy-MM-dd'、'yyyy/M/d'、'yyyy-M-d' → 日期格：getValue 回 Date＝該日「試算表時區」的 00:00
 *     （DATEVALUE 官方例 '1969-7-20'；本 repo 2026-07-15 正式環境踩過：approved.date 讀回 Date）。
 *     Asia/Taipei 的 '2026-07-14' ＝ Date(2026-07-13T16:00:00Z)。
 *  3. [已查證] 'H:mm'、'HH:mm'、'H:mm:ss'、'h:mm AM/PM' → 時間格：getValue 回 Date＝1899-12-30 當天該時刻（試算表時區）
 *     （序號日期原點 1899-12-30：https://developers.google.com/sheets/api/guides/formats ；
 *      本 repo 2026-08-23 正式環境踩過：roster.shift_in '11:00' 讀回 "Sat Dec 30 1899 11:00:00"）。
 *     '09:00' 一樣轉成時間（前導零只是顯示），H>23（如 '25:00'）當「時間長度」[推定]。
 *  4. [已查證（社群實測，無官方文件）] ISO 8601 含 'T' 的字串（'2026-07-14T09:00:00+08:00'、'…Z'、'…T09:00:00'）
 *     Sheets 不認得 → 維持文字（DATEVALUE 對 ISO T 字串失敗、要先把 T 換成空白）。
 *     https://alanrezende.com/convert-iso-8601-to-date-in-google-sheets
 *  5. [已查證] 'yyyy-MM-dd HH:mm'、'yyyy/MM/dd HH:mm:ss'（空白分隔）→ 日期時間格，getValue 回 Date。
 *  6. [正式環境觀察] 'yyyy-MM'（如 '2026-08'）→ 日期格（該月 1 日）；依本 repo Payroll.gs payForceTextCols 註解
 *     「Sheets 會把 '2026-08'、'2020-01-01' 這種字串自動轉成日期儲存格」（ym 對不到 → no_holiday）。網路來源未證實。
 *  7. [已查證] 純數字字串 → 數字：'8'→8、'0.5'→0.5、'-5'→-5；前導零會掉：'00123'→123、'0912345678'→912345678；
 *     '1e3'→1000（科學記號）。'1,000'→1000、'50%'→0.5（百分比格式）、'$5'→5（貨幣）、' 12 '→12、'.5'、'3.' [推定]。
 *  8. [已查證] 'TRUE'／'true'／'False'（不分大小寫）→ 布林；本 repo 2026-08-23 踩過：'false' 存成 FALSE，
 *     `String(r.x || '')` 把 false 吃成空字串。前後有空白的 'FALSE ' 維持文字 [推定]。
 *  9. [已查證] '=' 開頭 → 公式（本檔無法求值：記在 sheet.formulas、getValue 回原字串 [推定]）。
 *     '   =SUM(1,2)'（前面有空白）存成字串（官方 trimWhitespace 範例）。'+A1' 當公式、'-A1'／'@x' 當文字 [推定]。
 * 10. [已查證] 開頭單引號 "'2026-07-14" → 單引號被拿掉、存成文字 '2026-07-14'（quote prefix）。
 * 11. [已查證] 字串前後空白不會被去掉（官方 trimWhitespace 範例）；對不上任何規則的字串原樣存成文字。
 * 12. [已查證] 空字串／null → 空格（getValue 回 ''）。數字／布林／Date 物件照型別存；
 *     Date 物件寫進去讀回仍是 Date（本檔用「vm 那個 realm 的 Date」重建，跨 realm 的 instanceof 才會成立）。
 * 13. 'M/d'（如 '12/25'、'1/2'）→ 當年該日的日期 [推定，美式與 zh_TW 皆如此]；'M/d/yyyy' → 日期 [推定]。
 *
 * ▌純文字格式 '@'（setNumberFormat('@')）
 * 14. [已查證（多個專案實測）] 寫入「之前」先把格子或整欄設成 '@' → 字串原樣保存（日期、時間、前導零都保得住）。
 * 15. [推定] 寫入「之後」才設 '@'：值已經被轉成序號，getValue 回那個數字
 *     （'11:00' → 0.4583333…、'2026-07-14' → 46217），不會變回原字串，也不再是 Date。
 *     畫面上看到的是 0.458333333（Google 試算表把日期格改成純文字就是顯示序號）。
 * 16. [推定] 數字／布林／Date 物件寫進 '@' 格：數字與布林維持原型別；Date 物件讀回變序號數字。
 *
 * ▌其他
 * 17. [已查證] 格線範圍外（列 > getMaxRows 或欄 > getMaxColumns）getRange 會丟例外；appendRow 自動長列。
 *     本 repo Liff.gs liffMarkLineOk_ 就是為此先 insertColumnAfter 再寫表頭。
 * 18. [已查證] appendRow 加在「有內容的最後一列」之後；getLastRow／getLastColumn 只算有內容的格。
 * 19. 公式、合併格、資料驗證、格式顯示（getDisplayValues 只做最簡單的字串化）不在模擬範圍。
 */
'use strict';

const SERIAL_EPOCH_UTC = Date.UTC(1899, 11, 30);   // 序號 0 ＝ 1899-12-30 00:00（試算表時區）
const DAY_MS = 86400000;
const TZ_MS = 8 * 3600000;                           // Asia/Taipei
const RANGE_ERR = 'The coordinates or dimensions of the range are invalid.';
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_MAX_COLS = 26;

function isDateObj(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
/** 試算表時區的 y-m-d H:M:S → epoch ms */
function tpeMs(y, mo, d, H, M, S) { return Date.UTC(y, mo - 1, d, H || 0, M || 0, S || 0) - TZ_MS; }
function validYmd(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function msToSerial(ms) { return (ms + TZ_MS - SERIAL_EPOCH_UTC) / DAY_MS; }
function serialToMs(serial) { return SERIAL_EPOCH_UTC + serial * DAY_MS - TZ_MS; }
function pad2(n) { return ('0' + n).slice(-2); }

/** 規則 2～13：把「使用者打進去的字串」解析成格子內容。回 {k, v?, ms?, sub?, note?} */
function parseTyped(raw, opts) {
  opts = opts || {};
  if (raw === '') return { k: 'empty', v: '' };
  if (raw.charAt(0) === "'") return { k: 'text', v: raw.slice(1) };                       // 規則 10
  if (raw.charAt(0) === '=') return { k: 'formula', v: raw };                              // 規則 9
  const s = raw.trim();
  if (!s) return { k: 'text', v: raw };                                                     // 規則 11
  if (raw.charAt(0) === '+' && !/^\+\s*[\d.,]/.test(raw)) return { k: 'formula', v: '=' + raw, note: '推定' };   // 規則 9
  if (s === 'TRUE' || s === 'FALSE' || /^(true|false)$/i.test(raw)) {                       // 規則 8（前後空白→維持文字，推定）
    if (raw !== s) return { k: 'text', v: raw };
    return { k: 'bool', v: /^true$/i.test(s) };
  }
  let m;
  if ((m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d*)?%$/.exec(s)) || (m = /^([+-]?)(\.\d+)%$/.exec(s))) {   // 規則 7 百分比（推定）
    const n = Number((m[1] || '') + String(m[2]).replace(/,/g, '') + (m[3] || ''));
    if (isFinite(n)) return { k: 'number', v: n / 100, auto: '0.00%', note: '推定' };
  }
  if ((m = /^([+-]?)(?:NT\$|\$)(\d{1,3}(?:,\d{3})+|\d+)(\.\d*)?$/.exec(s))) {               // 規則 7 貨幣
    const n = Number((m[1] || '') + m[2].replace(/,/g, '') + (m[3] || ''));
    if (isFinite(n)) return { k: 'number', v: n, auto: '"$"#,##0.00' };
  }
  if (/^[+-]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d*)?([eE][+-]?\d+)?$/.test(s) || /^[+-]?\.\d+([eE][+-]?\d+)?$/.test(s)) {   // 規則 7
    const n = Number(s.replace(/,/g, '').replace(/\.$/, '').replace(/\.([eE])/, '$1'));
    if (isFinite(n)) return { k: 'number', v: n };
  }
  // 規則 5：日期＋時間（空白分隔）
  if ((m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/.exec(s))) {
    const y = +m[1], mo = +m[2], d = +m[3]; let H = +m[4]; const M = +m[5], S = +(m[6] || 0);
    if (m[7]) { if (H > 12) return { k: 'text', v: raw }; H = (H % 12) + (/p/i.test(m[7]) ? 12 : 0); }
    if (validYmd(y, mo, d) && H <= 23 && M <= 59 && S <= 59) return { k: 'date', ms: tpeMs(y, mo, d, H, M, S), sub: 'datetime' };
    return { k: 'text', v: raw };
  }
  if ((m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s))) {                              // 規則 2
    const y = +m[1], mo = +m[2], d = +m[3];
    return validYmd(y, mo, d) ? { k: 'date', ms: tpeMs(y, mo, d), sub: 'date' } : { k: 'text', v: raw };
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {                                     // 規則 13 M/d/yyyy（推定）
    const mo = +m[1], d = +m[2], y = +m[3];
    return validYmd(y, mo, d) ? { k: 'date', ms: tpeMs(y, mo, d), sub: 'date', note: '推定' } : { k: 'text', v: raw };
  }
  if ((m = /^(\d{4})[-\/](\d{1,2})$/.exec(s))) {                                             // 規則 6 yyyy-MM（正式環境觀察）
    const y = +m[1], mo = +m[2];
    return (mo >= 1 && mo <= 12) ? { k: 'date', ms: tpeMs(y, mo, 1), sub: 'month', note: '正式環境觀察' } : { k: 'text', v: raw };
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) {                                              // 規則 13 M/d（推定）
    const mo = +m[1], d = +m[2];
    const y = new Date((opts.now ? opts.now() : Date.now()) + TZ_MS).getUTCFullYear();
    return validYmd(y, mo, d) ? { k: 'date', ms: tpeMs(y, mo, d), sub: 'date', note: '推定' } : { k: 'text', v: raw };
  }
  if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?$/.exec(s))) {                // 規則 3
    let H = +m[1]; const M = +m[2], S = +(m[3] || 0);
    if (M > 59 || S > 59) return { k: 'text', v: raw };
    if (m[4]) { if (H > 12) return { k: 'text', v: raw }; H = (H % 12) + (/p/i.test(m[4]) ? 12 : 0); }
    if (H <= 23) return { k: 'date', ms: tpeMs(1899, 12, 30, H, M, S), sub: 'time' };
    return { k: 'date', ms: tpeMs(1899, 12, 30) + H * 3600000 + M * 60000 + S * 1000, sub: 'duration', note: '推定' };
  }
  return { k: 'text', v: raw };                                                               // 規則 11
}

function isDateFmt(fmt) { return !!fmt && fmt !== '@' && /[yMdHhmsE]/.test(fmt) && !/[#0]/.test(fmt); }

/** 把任意寫入值（含 '@' 格）變成儲存格內容。 */
function toCell(value, fmt, opts) {
  if (value === null || value === undefined) return { k: 'empty', v: '' };
  if (typeof value === 'string') {
    if (fmt === '@') {                                                                        // 規則 14
      if (value === '') return { k: 'empty', v: '' };
      return { k: 'text', v: value, formulaInText: value.charAt(0) === '=' };                // '=' 在 '@' 格仍會跑公式（推定）
    }
    return parseTyped(value, opts);
  }
  if (typeof value === 'number') return isFinite(value) ? { k: 'number', v: value } : { k: 'text', v: '#NUM!', err: true };
  if (typeof value === 'boolean') return { k: 'bool', v: value };
  if (isDateObj(value)) {
    const ms = value.getTime();
    return isNaN(ms) ? { k: 'text', v: '#NUM!', err: true } : { k: 'date', ms: ms, sub: 'datetime' };
  }
  return { k: 'text', v: String(value), note: '推定' };
}

function colLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}
function indexToColLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

class Range {
  constructor(sheet, r, c, nr, nc, wholeCols) {
    this.sheet = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; this.wholeCols = !!wholeCols;
  }
  getRow() { return this.r; }
  getColumn() { return this.c; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getLastRow() { return this.r + this.nr - 1; }
  getLastColumn() { return this.c + this.nc - 1; }
  getA1Notation() { return indexToColLetter(this.c) + this.r + (this.nr > 1 || this.nc > 1 ? ':' + indexToColLetter(this.c + this.nc - 1) + (this.r + this.nr - 1) : ''); }
  getSheet() { return this.sheet; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet._read(this.r + i, this.c + j)); out.push(row); }
    return out;
  }
  getValue() { return this.sheet._read(this.r, this.c); }
  getDisplayValues() { return this.getValues().map((row) => row.map((v) => this.sheet._display(v))); }
  getDisplayValue() { return this.sheet._display(this.getValue()); }
  setValues(vals) {
    if (!Array.isArray(vals) || vals.length !== this.nr) throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' + (vals && vals.length) + ' but the range has ' + this.nr + '.');
    for (let i = 0; i < this.nr; i++) {
      if (!Array.isArray(vals[i]) || vals[i].length !== this.nc) throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' + (vals[i] && vals[i].length) + ' but the range has ' + this.nc + '.');
      for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, vals[i][j]);
    }
    return this;
  }
  setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, v); return this; }
  setNumberFormat(fmt) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._setFmt(this.r + i, this.c + j, fmt);
    if (this.wholeCols) for (let j = 0; j < this.nc; j++) this.sheet.colFmt[this.c + j] = fmt;   // 整欄：之後新長出來的列也套用
    return this;
  }
  setNumberFormats(m) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._setFmt(this.r + i, this.c + j, m[i][j]); return this; }
  getNumberFormat() { return this.sheet._fmtOf(this.r, this.c) || this.sheet._autoFmt(this.r, this.c); }
  getNumberFormats() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet._fmtOf(this.r + i, this.c + j) || this.sheet._autoFmt(this.r + i, this.c + j)); out.push(row); } return out; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._write(this.r + i, this.c + j, null); return this; }
  clear() { this.clearContent(); for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet._setFmt(this.r + i, this.c + j, null); return this; }
  getFormula() { const cell = this.sheet._cell(this.r, this.c); return cell && cell.k === 'formula' ? cell.v : ''; }
  // 外觀設定一律 no-op（月表會用）
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; } setWrap() { return this; }
  setFontSize() { return this; } setHorizontalAlignment() { return this; } setVerticalAlignment() { return this; } setBorder() { return this; }
}

class Sheet {
  constructor(ss, name, opts) {
    this.ss = ss; this.name = name; this.opts = opts || {};
    this.cells = [];        // cells[r-1][c-1] = {k, v|ms, ...}
    this.fmts = [];         // fmts[r-1][c-1] = '@' | 'yyyy-MM-dd' | null
    this.colFmt = {};       // 整欄格式（A:A 這種 range 設的）
    this.maxRows = this.opts.maxRows || ss.defaultMaxRows || DEFAULT_MAX_ROWS;
    this.maxCols = this.opts.maxCols || ss.defaultMaxCols || DEFAULT_MAX_COLS;
    this.frozenRows = 0;
    this.formulas = [];     // 寫進去的公式（本檔不求值，只記錄）
    this.sheetId = Math.floor(Math.random() * 1e9);
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getSheetId() { return this.sheetId; }
  getParent() { return this.ss; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getFrozenRows() { return this.frozenRows; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth() { return this; } setColumnWidths() { return this; } setRowHeight() { return this; } hideSheet() { return this; } showSheet() { return this; }
  autoResizeColumn() { return this; } setTabColor() { return this; }
  _cell(r, c) { const row = this.cells[r - 1]; return row ? row[c - 1] : undefined; }
  _fmtOf(r, c) { const row = this.fmts[r - 1]; const f = row ? row[c - 1] : undefined; return f || this.colFmt[c] || null; }
  _setFmt(r, c, fmt) { (this.fmts[r - 1] = this.fmts[r - 1] || [])[c - 1] = fmt || null; }
  _autoFmt(r, c) {
    const cell = this._cell(r, c);
    if (!cell) return 'General';
    if (cell.auto) return cell.auto;
    if (cell.k === 'date') return { date: 'yyyy/M/d', time: 'H:mm:ss', datetime: 'yyyy/M/d H:mm:ss', month: 'yyyy/M', duration: '[h]:mm:ss' }[cell.sub] || 'yyyy/M/d H:mm:ss';
    return 'General';
  }
  _ensureRow(r) {
    if (r > this.maxRows) throw new Error(RANGE_ERR);
    while (this.cells.length < r) this.cells.push([]);
  }
  _write(r, c, value) {
    if (r < 1 || c < 1 || r > this.maxRows || c > this.maxCols) throw new Error(RANGE_ERR);
    this._ensureRow(r);
    const fmt = this._fmtOf(r, c);
    const cell = toCell(value, fmt, { now: this.ss.now });
    if (cell.k === 'formula' || cell.formulaInText) this.formulas.push({ r: r, c: c, text: cell.v });
    if (cell.k === 'empty') { this.cells[r - 1][c - 1] = undefined; return; }
    this.cells[r - 1][c - 1] = cell;
  }
  _read(r, c) {
    const cell = this._cell(r, c);
    if (!cell) return '';
    const fmt = this._fmtOf(r, c);
    switch (cell.k) {
      case 'text': return cell.v;
      case 'bool': return cell.v;
      case 'number': return isDateFmt(fmt) ? new this.ss.DateCtor(serialToMs(cell.v)) : cell.v;   // 規則 16 的反向（數字套日期格式→Date，推定）
      case 'date': return fmt === '@' ? msToSerial(cell.ms) : new this.ss.DateCtor(cell.ms);        // 規則 15／16
      case 'formula': return cell.v;                                                                  // 規則 9：無法求值
      default: return '';
    }
  }
  _display(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (isDateObj(v)) {
      const x = new Date(v.getTime() + TZ_MS);
      if (x.getUTCFullYear() === 1899) return x.getUTCHours() + ':' + pad2(x.getUTCMinutes()) + ':' + pad2(x.getUTCSeconds());
      return x.getUTCFullYear() + '/' + (x.getUTCMonth() + 1) + '/' + x.getUTCDate() + (x.getUTCHours() + x.getUTCMinutes() + x.getUTCSeconds() ? ' ' + x.getUTCHours() + ':' + pad2(x.getUTCMinutes()) + ':' + pad2(x.getUTCSeconds()) : '');
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  getLastRow() {
    for (let r = this.cells.length; r >= 1; r--) { const row = this.cells[r - 1]; if (row && row.some((x) => x !== undefined)) return r; }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.cells.forEach((row) => { if (!row) return; for (let c = row.length; c >= 1; c--) { if (row[c - 1] !== undefined) { if (c > max) max = c; break; } } });
    return max;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return this._rangeA1(a);
    const r = a, col = b, nr = c === undefined ? 1 : c, nc = d === undefined ? 1 : d;
    if (!(r >= 1) || !(col >= 1) || !(nr >= 1) || !(nc >= 1) || r + nr - 1 > this.maxRows || col + nc - 1 > this.maxCols) throw new Error(RANGE_ERR);
    return new Range(this, r, col, nr, nc, false);
  }
  _rangeA1(a1) {
    const m = /^([A-Z]+)?(\d+)?(?::([A-Z]+)?(\d+)?)?$/.exec(a1.toUpperCase().replace(/\$/g, ''));
    if (!m || (!m[1] && !m[2])) throw new Error('Range not found: ' + a1);
    const c1 = m[1] ? colLetterToIndex(m[1]) : 1, r1 = m[2] ? +m[2] : 1;
    let c2, r2, wholeCols = false;
    if (m[3] === undefined && m[4] === undefined && a1.indexOf(':') < 0) { c2 = c1; r2 = r1; }
    else { c2 = m[3] ? colLetterToIndex(m[3]) : this.maxCols; r2 = m[4] ? +m[4] : this.maxRows; }
    if (!m[2] && !m[4]) wholeCols = true;   // 'A:V'、'S:S'
    if (c2 > this.maxCols || r2 > this.maxRows) throw new Error(RANGE_ERR);
    return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1, wholeCols);
  }
  getDataRange() {
    const lr = Math.max(1, this.getLastRow()), lc = Math.max(1, this.getLastColumn());
    return new Range(this, 1, 1, lr, lc, false);
  }
  getSheetValues(r, c, nr, nc) { return this.getRange(r, c, nr, nc).getValues(); }
  appendRow(values) {
    if (!Array.isArray(values)) throw new Error('appendRow 要給陣列');
    const r = this.getLastRow() + 1;
    if (r > this.maxRows) this.maxRows = r;                        // 規則 17：appendRow 會自動長列
    if (values.length > this.maxCols) this.maxCols = values.length;
    values.forEach((v, j) => this._write(r, j + 1, v));
    return this;
  }
  deleteRow(r) { return this.deleteRows(r, 1); }
  deleteRows(r, n) {
    if (r < 1 || r + n - 1 > this.maxRows) throw new Error(RANGE_ERR);
    this.cells.splice(r - 1, n); this.fmts.splice(r - 1, n); this.maxRows -= n;
    return this;
  }
  insertRowAfter(r) { return this.insertRowsAfter(r, 1); }
  insertRowsAfter(r, n) { for (let i = 0; i < n; i++) { if (this.cells.length >= r) this.cells.splice(r, 0, []); if (this.fmts.length >= r) this.fmts.splice(r, 0, []); } this.maxRows += n; return this; }
  insertRows(r, n) { return this.insertRowsAfter(r - 1, n || 1); }
  insertColumnAfter() { this.maxCols += 1; return this; }
  insertColumnsAfter(c, n) { this.maxCols += n; return this; }
  clear() { this.cells = []; this.fmts = []; this.colFmt = {}; this.formulas = []; return this; }
  clearContents() { this.cells = []; this.formulas = []; return this; }
  /** 偵錯用：某格的原始儲存內容（型別＋格式） */
  describe(r, c) { const cell = this._cell(r, c); return { raw: cell || null, fmt: this._fmtOf(r, c), value: this._read(r, c) }; }
  /** 偵錯用：整張表的「型別矩陣」（t=文字 n=數字 b=布林 d=日期 f=公式 .=空） */
  typeMap() {
    const lr = this.getLastRow(), lc = this.getLastColumn(), out = [];
    for (let r = 1; r <= lr; r++) { let s = ''; for (let c = 1; c <= lc; c++) { const x = this._cell(r, c); s += x ? { text: 't', number: 'n', bool: 'b', date: 'd', formula: 'f' }[x.k] : '.'; } out.push(s); }
    return out;
  }
}

class Spreadsheet {
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id || 'FAKE_SS';
    this.name = opts.name || '假試算表';
    this.DateCtor = opts.DateCtor || Date;   // vm 的 Date：讀回的 Date 要在那個 realm 建，instanceof 才成立
    this.now = opts.now || (() => Date.now());
    // 新分頁的格線大小。真的 Sheets 新分頁是 1000 列 × 26 欄（規則 17）；本 repo 的 payroll_master 有 27 欄，
    // 正式試算表顯然已經有足夠欄數，要測「型別」而不是「格線」時可以放寬 defaultMaxCols。
    this.defaultMaxRows = opts.defaultMaxRows || DEFAULT_MAX_ROWS;
    this.defaultMaxCols = opts.defaultMaxCols || DEFAULT_MAX_COLS;
    this.sheets = [];
  }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getName() { return this.name; }
  getSpreadsheetTimeZone() { return 'Asia/Taipei'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.filter((s) => s.name === n)[0] || null; }
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error('A sheet with the name "' + n + '" already exists. Please enter another name.');
    const sh = new Sheet(this, n); this.sheets.push(sh); return sh;
  }
  deleteSheet(sh) { this.sheets = this.sheets.filter((s) => s !== sh); }
  /** 便利：建分頁＋像人打字那樣塞整批值（values[0] 通常是表頭）。asText=true 時整張先鎖 '@'。 */
  seed(name, values, asText) {
    const sh = this.getSheetByName(name) || this.insertSheet(name);
    if (asText) sh.getRange(1, 1, Math.max(values.length, 1), Math.max.apply(null, values.map((r) => r.length).concat([1]))).setNumberFormat('@');
    values.forEach((row) => sh.appendRow(row));
    return sh;
  }
}

function createSpreadsheet(opts) { return new Spreadsheet(opts); }

module.exports = { createSpreadsheet, Spreadsheet, Sheet, Range, parseTyped, toCell, msToSerial, serialToMs, tpeMs, isDateFmt,
                   SERIAL_EPOCH_UTC, TZ_MS, DAY_MS, RANGE_ERR, colLetterToIndex, indexToColLetter };
