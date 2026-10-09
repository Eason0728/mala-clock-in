/**
 * 跨店打卡鏡像（只部署到「總部」；2026-10-09 Eason 定案）
 *
 * 背景：總部人員（例如工號 HQ-01）領總部薪水，但大多在央廚打卡，紀錄躺在央廚的試算表。
 * 定案：總部的打卡表每天自動讀取（抄寫）她們在央廚的打卡紀錄，薪酬的「總部」門市列之後只讀總部自己的試算表。
 *
 * 做法（每天 04:00，在 05:00 的 dailyMonthlyRebuild 之前）：
 *   對 MIRROR_SOURCES 的每個來源，把來源試算表 events／approved／leave 裡「屬於 emp_prefix 開頭的人」的列
 *   完整複製到本試算表同名分頁，最右邊加一欄 mirror_src 填來源代碼（如 'CF'）。
 *   - 來源會就地改狀態（裝置核准 pending→ok、手動刪列、請假 upsert、核定重送），所以不能只追加：
 *     每次都「刪掉 mirror_src＝該來源的舊列，再依來源現況整批重寫」。
 *   - 本店自己的列（mirror_src 空白）一列都不動。
 *   - 先算完全部（讀來源、讀目標、配欄位）才開始寫；寫入順序是「先追加新列、再刪舊列」，
 *     中途失敗最糟是暫時重複、不會缺資料，下次執行會整批清掉重寫。
 *
 * 誰屬於誰（先看清楚三張表各自用什麼對人）：
 *   events   只有 emp_id（沒有姓名欄）            → emp_id 以 emp_prefix 開頭
 *   approved 有 emp_id 也有 name                   → emp_id 以 emp_prefix 開頭；emp_id 空白時才退回用姓名
 *   leave    只有姓名（日期／姓名／假別／時數）    → 姓名 ∈ 來源名冊中 emp_prefix 開頭者的姓名集合
 *
 * 設定放 MirrorConfig.js（部署的人放在 ~/mala-gas/hq-clock-in/，不進公開 repo），形狀見 MirrorConfig.example.gs。
 * 掛載：Code.gs 的 doPost 不認 MIRROR_HANDLERS，需用 tools/patch_hq_mirror.py 對總部的 程式碼.js 加 4 行掛載。
 * 回退：刪 Mirror.js／MirrorConfig.js、刪觸發器 mirrorFromSources；已鏡像的列用 mirror_src 篩選即可整批刪除。
 */

var MIRROR_COL = 'mirror_src';

/** 要鏡像的三張表。idCol／nameCol＝來源表裡對人的欄；norm＝寫入前要正規化的欄（ts／date）。 */
var MIRROR_TABLES = [
  { sheet: 'events',   idCol: 'emp_id', nameCol: '',     norm: { ts: 'ts' },                      required: true },
  { sheet: 'approved', idCol: 'emp_id', nameCol: 'name', norm: { date: 'date', entered_at: 'ts' }, required: true },
  { sheet: 'leave',    idCol: '',       nameCol: '姓名', norm: { '日期': 'date' },               required: false },
];

/** 讀設定並驗證；回 {ok, sources} 或 {ok:false, error, detail}。 */
function mirrorSources_() {
  if (typeof MIRROR_SOURCES === 'undefined' || !MIRROR_SOURCES || !MIRROR_SOURCES.length) {
    return { ok: false, error: 'no_mirror_config', detail: 'MirrorConfig.js 沒有 MIRROR_SOURCES' };
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < MIRROR_SOURCES.length; i++) {
    var s = MIRROR_SOURCES[i] || {};
    var code = String(s.code || '').trim();
    var id = String(s.ss_id || '').trim();
    var prefix = String(s.emp_prefix || '');
    if (!code) return { ok: false, error: 'bad_mirror_config', detail: '第 ' + (i + 1) + ' 個來源沒有 code' };
    if (seen[code]) return { ok: false, error: 'bad_mirror_config', detail: '來源 code 重複：' + code };
    seen[code] = true;
    if (!id || id.indexOf('PASTE') === 0) return { ok: false, error: 'bad_mirror_config', detail: code + ' 的 ss_id 還是佔位' };
    // 空前綴＝「所有人」，會把整個來源店複製進來——一律擋掉
    if (!prefix.trim()) return { ok: false, error: 'bad_mirror_config', detail: code + ' 的 emp_prefix 不可為空' };
    try { if (typeof spreadsheetId === 'function' && id === spreadsheetId()) {
      return { ok: false, error: 'bad_mirror_config', detail: code + ' 的 ss_id 就是本試算表（不能自己抄自己）' };
    } } catch (e) { /* 取不到本店 ID 就略過這道檢查 */ }
    out.push({ code: code, ss_id: id, emp_prefix: prefix });
  }
  return { ok: true, sources: out };
}

/** 整張表讀成 {headers, rows:[{__row, cells:[...]}]}；全空白列略過。 */
function mirrorRead_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(function (h) { return String(h == null ? '' : h); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var blank = values[i].every(function (c) { return c === '' || c == null; });
    if (!blank) rows.push({ row: i + 1, cells: values[i] });   // row＝試算表實際列號（1-based，含表頭）
  }
  return { headers: headers, rows: rows };
}

/** 日期／時間欄過 normCellTs／normCellDate，避免 Sheets 自動轉型造成讀回對不上。 */
function mirrorNorm_(kind, v) {
  if (kind === 'ts') return normCellTs(v);
  if (kind === 'date') return normCellDate(v);
  return v;
}

/** 來源一張表 → 屬於這位來源的列（以來源表頭為鍵的物件陣列，日期時間欄已正規化）。 */
function mirrorSelect_(table, data, prefix, names) {
  var H = data.headers;
  var iId = table.idCol ? H.indexOf(table.idCol) : -1;
  var iName = table.nameCol ? H.indexOf(table.nameCol) : -1;
  if (table.idCol && iId === -1 && !table.nameCol) throw new Error(table.sheet + ' 缺 ' + table.idCol + ' 欄');
  if (!table.idCol && iName === -1) throw new Error(table.sheet + ' 缺 ' + table.nameCol + ' 欄');
  var picked = [];
  data.rows.forEach(function (r) {
    var id = iId === -1 ? '' : String(r.cells[iId] == null ? '' : r.cells[iId]).trim();
    var nm = iName === -1 ? '' : String(r.cells[iName] == null ? '' : r.cells[iName]).trim();
    var hit;
    if (table.idCol) hit = id ? id.indexOf(prefix) === 0 : (nm !== '' && names[nm] === true);
    else hit = nm !== '' && names[nm] === true;
    if (!hit) return;
    var o = {};
    H.forEach(function (h, i) {
      if (!h) return;
      o[h] = table.norm[h] ? mirrorNorm_(table.norm[h], r.cells[i]) : r.cells[i];
    });
    picked.push(o);
  });
  return picked;
}

/**
 * 全部算好、先不寫。回 {ok, plan} 或 {ok:false, error, detail}。
 * plan.tables[sheet] = { exists, headers(最終表頭), needHeader, curCols, remove:{code:[列號]}, add:{code:[[...]]}, warnings }
 */
function mirrorPlan_(sources, ss) {
  var plan = { sources: sources.map(function (s) { return s.code; }), tables: {}, warnings: [] };

  // 1) 讀每個來源、挑出屬於它的列
  var picked = {};   // code -> sheet -> {headers, rows}
  sources.forEach(function (src) {
    var sss;
    try { sss = SpreadsheetApp.openById(src.ss_id); }
    catch (e) { throw new Error(src.code + ' 的試算表開不起來：' + e.message); }
    var rosterSheet = sss.getSheetByName('roster');
    if (!rosterSheet) throw new Error(src.code + ' 缺 roster 分頁');
    var roster = mirrorRead_(rosterSheet);
    var iRid = roster.headers.indexOf('emp_id'), iRname = roster.headers.indexOf('name');
    if (iRid === -1 || iRname === -1) throw new Error(src.code + ' 名冊缺 emp_id／name 欄');
    var names = {};
    roster.rows.forEach(function (r) {
      var id = String(r.cells[iRid] == null ? '' : r.cells[iRid]).trim();
      var nm = String(r.cells[iRname] == null ? '' : r.cells[iRname]).trim();
      if (id.indexOf(src.emp_prefix) === 0 && nm) names[nm] = true;
    });
    picked[src.code] = {};
    MIRROR_TABLES.forEach(function (t) {
      var sh = sss.getSheetByName(t.sheet);
      if (!sh) {
        if (t.required) throw new Error(src.code + ' 缺 ' + t.sheet + ' 分頁');
        picked[src.code][t.sheet] = { headers: [], rows: [] };
        plan.warnings.push(src.code + ' 沒有 ' + t.sheet + ' 分頁，當作 0 筆');
        return;
      }
      var data = mirrorRead_(sh);
      picked[src.code][t.sheet] = { headers: data.headers, rows: mirrorSelect_(t, data, src.emp_prefix, names) };
    });
  });

  // 2) 讀目標、依「目標實際表頭」配欄
  MIRROR_TABLES.forEach(function (t) {
    var tsheet = ss.getSheetByName(t.sheet);
    var tp = { exists: !!tsheet, remove: {}, add: {}, warnings: [] };
    var headers, mirrorIdx, tdata = null;
    if (tsheet) {
      tdata = mirrorRead_(tsheet);
      headers = tdata.headers.slice();
      // 判斷欄位存在要看實際表頭，不能看程式常數
      mirrorIdx = headers.indexOf(MIRROR_COL);
      tp.curCols = headers.length;
      if (mirrorIdx === -1) { tp.needHeader = true; headers.push(MIRROR_COL); mirrorIdx = headers.length - 1; }
    } else {
      // 目標沒這張表（例如總部沒有 leave）：用第一個有表頭的來源的表頭建
      var base = [];
      sources.forEach(function (s) { if (!base.length) base = picked[s.code][t.sheet].headers.filter(function (h) { return h; }); });
      headers = base.slice(); headers.push(MIRROR_COL);
      mirrorIdx = headers.length - 1;
      tp.needHeader = true; tp.curCols = 0;
    }
    tp.headers = headers;

    sources.forEach(function (src) {
      // 要刪的舊列：目標表 mirror_src＝該來源（本店自己的列 mirror_src 空白，永遠不會命中）
      tp.remove[src.code] = [];
      if (tdata && !tp.needHeader) {
        tdata.rows.forEach(function (r) {
          if (String(r.cells[mirrorIdx] == null ? '' : r.cells[mirrorIdx]).trim() === src.code) tp.remove[src.code].push(r.row);
        });
      }
      // 要寫的新列：依目標表頭排欄位（來源沒有的欄＝空白；目標沒有的來源欄＝丟棄並警告）
      var sp = picked[src.code][t.sheet];
      var dropped = sp.headers.filter(function (h) { return h && headers.indexOf(h) === -1; });
      if (dropped.length) tp.warnings.push(src.code + '.' + t.sheet + ' 來源有、目標沒有的欄位（未複製）：' + dropped.join('、'));
      tp.add[src.code] = sp.rows.map(function (o) {
        return headers.map(function (h, i) {
          if (i === mirrorIdx) return src.code;
          return (h in o) ? o[h] : '';
        });
      });
    });
    plan.tables[t.sheet] = tp;
  });
  return plan;
}

function mirrorSummary_(plan, apply) {
  var out = { sources: [], warnings: plan.warnings.slice(), header_added: [], sheets_created: [] };
  plan.sources.forEach(function (code) {
    var o = { code: code, tables: {} };
    MIRROR_TABLES.forEach(function (t) {
      var tp = plan.tables[t.sheet];
      o.tables[t.sheet] = { removed: tp.remove[code].length, added: tp.add[code].length };
    });
    out.sources.push(o);
  });
  MIRROR_TABLES.forEach(function (t) {
    var tp = plan.tables[t.sheet];
    tp.warnings.forEach(function (w) { if (out.warnings.indexOf(w) === -1) out.warnings.push(w); });
    if (!tp.exists) out.sheets_created.push(t.sheet);
    else if (tp.needHeader) out.header_added.push(t.sheet);
  });
  return out;
}

/** 真正寫入。前提：plan 已全部算完。先補表頭／建表 → 追加新列 → 由下往上刪舊列。 */
function mirrorApply_(plan, ss) {
  MIRROR_TABLES.forEach(function (t) {
    var tp = plan.tables[t.sheet];
    var sheet = ss.getSheetByName(t.sheet);
    if (!sheet) {
      sheet = ss.insertSheet(t.sheet);
      sheet.getRange(1, 1, 1, tp.headers.length).setValues([tp.headers]);
    } else if (tp.needHeader) {
      sheet.getRange(1, tp.curCols + 1).setValue(MIRROR_COL);
    }

    // 追加新列（所有來源合併成一次寫入）
    var all = [];
    plan.sources.forEach(function (code) { tp.add[code].forEach(function (r) { all.push(r); }); });
    if (all.length) {
      var start = sheet.getLastRow() + 1;
      // 日期／時間欄先鎖成純文字，避免 Sheets 把 '2026-09-01' 自動轉成日期物件（讀回就對不上）
      tp.headers.forEach(function (h, i) {
        if (t.norm[h]) sheet.getRange(start, i + 1, all.length, 1).setNumberFormat('@');
      });
      sheet.getRange(start, 1, all.length, tp.headers.length).setValues(all);
    }

    // 刪舊列：先收集所有來源的列號，由下往上、連續的併成一段刪
    var del = [];
    plan.sources.forEach(function (code) { tp.remove[code].forEach(function (n) { del.push(n); }); });
    del.sort(function (a, b) { return b - a; });
    var i = 0;
    while (i < del.length) {
      var top = del[i], cnt = 1;
      while (i + cnt < del.length && del[i + cnt] === top - cnt) cnt++;
      sheet.deleteRows(top - cnt + 1, cnt);
      i += cnt;
    }
  });
}

/** 核心：apply=false 乾跑（零副作用：不補表頭、不建表、不寫入）。 */
function mirrorCore_(apply) {
  var cfg = mirrorSources_();
  if (!cfg.ok) return cfg;
  var lock = null;
  if (apply) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return { ok: false, error: 'busy', detail: '另一個鏡像或寫入正在進行，請稍後再試' };
  }
  try {
    var ss = getSS();
    var plan;
    try { plan = mirrorPlan_(cfg.sources, ss); }
    catch (e) { return { ok: false, error: 'mirror_plan_failed', detail: String(e && e.message || e) }; }   // 一步失敗＝完全沒寫
    var res = mirrorSummary_(plan, apply);
    if (apply) {
      mirrorApply_(plan, ss);
      try { PropertiesService.getScriptProperties().setProperty('mirror_last_ok', nowTaipeiIso()); } catch (e2) { /* 記號寫不進去不影響結果 */ }
    }
    res.ok = true; res.apply = !!apply;
    return res;
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** 時間觸發器呼叫（每天 04:00）。忽略觸發事件參數；失敗就丟錯，讓 Apps Script 的執行紀錄與失敗通知看得到。 */
function mirrorFromSources() {
  var r = mirrorCore_(true);
  if (!r.ok) throw new Error('mirrorFromSources 失敗：' + r.error + (r.detail ? '（' + r.detail + '）' : ''));
  Logger.log('mirrorFromSources 完成：' + JSON.stringify(r.sources));
  return r;
}

/** 建立每日 04:00 觸發器（冪等：先刪同名再建）。atHour(4)＝04:00–05:00 之間執行，早於 05:00 的 dailyMonthlyRebuild。 */
function setupMirrorTrigger() {
  var before = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'mirrorFromSources') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('mirrorFromSources').timeBased().everyDays(1).atHour(4).create();
  var after = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  return { ok: true, before: before, after: after };
}

/** API：{action:'mirror_run', admin_key, apply} — apply:true 才寫；其餘（含沒帶）一律乾跑。 */
function handleMirrorRun(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return mirrorCore_(body.apply === true);
}

/** API：{action:'mirror_setup_trigger', admin_key} — 建每日 04:00 觸發器（不必進編輯器）。 */
function handleMirrorSetupTrigger(body) {
  if (!checkAdmin(body)) return { ok: false, error: 'unauthorized' };
  return setupMirrorTrigger();
}

var MIRROR_HANDLERS = {
  mirror_run: handleMirrorRun,
  mirror_setup_trigger: handleMirrorSetupTrigger,
};
