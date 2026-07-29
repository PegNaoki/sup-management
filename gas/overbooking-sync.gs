/**
 * ============================================================
 * オーバーブッキング防止 絶対値同期（GAS 制御ロジック）
 * ------------------------------------------------------------
 * 【入力＝「定員マスター」タブ（マトリクス形式）】
 *   A列 : 時間ラベル（10:00 / 13:30 ...）  A1は「時間\日付」
 *   B列 : 既定（その時間のデフォルト総枠数）  ヘッダ「既定」
 *   C列〜: 日付カラム（ヘッダ "7/8(水)" 等）
 *   セルの意味：
 *     数字  → その日時の総枠数（定員C。既定を上書き）
 *     △    → リクエスト強制（Rに関わらず必ずリクエスト）
 *     x/✕  → 受付停止（在庫0・リクエスト）
 *     空    → 既定(B列)を定員として使用（通常の状態機械）
 *
 * 【状態機械】※安全マージン R≤1 でリクエスト化（要件確定値）
 *   R = 定員C − 予約総数B
 *   R >= 2 : 即予約 ／ 即予約在庫 = R
 *   R <= 1 : リクエスト ＋ 在庫0（自動確定を停止）
 *   （△=常にリクエスト / x=リクエスト＋0 は上記より優先）
 *
 * 差分連動をやめ、毎回「全チャネル = 目標状態」に絶対値で上書きするため、
 * 初期割当ズレ・取りこぼしがあっても次回同期で必ず正しいRに収束する。
 * 共通在庫（ウラカタ＝アソビュー＝Web）は urakata 1チャネルで代表。
 *
 * 【予約総数B】この定員マスターには入っていないので、予約シートから集計する。
 *   → obBookingCount_(date, time) を実シートに合わせて実装（下部にTODO）。
 *
 * 【貼り付け手順】既存GASプロジェクトに .gs を1枚追加してこの内容を貼る。
 *   スクリプトプロパティに GITHUB_TOKEN（repo dispatch可能なPAT）を設定。
 *   まず syncAllSlots(true)（DRY_RUN・無操作）でログの目標状態を確認。
 * ============================================================
 */

var OB_CONFIG = {
  owner: 'PegNaoki',
  repo:  'sup-management',
  tokenProp: 'GITHUB_TOKEN',

  // 定員マスター
  masterSheet: '定員マスター',
  headerRow: 1,        // 日付カラムのヘッダ行
  timeColLabelRow: 1,  // A1 が「時間\日付」
  defaultCol: 2,       // B列＝既定（1始まり）
  firstDateCol: 3,     // C列から日付
  // 予約シート（B集計用）※実シートに合わせて調整（obBookingCount_内で使用）
  bookingSheet: '予約一覧',   // TODO: 実際の予約シート名
  onlyFutureFromToday: true,   // 今日以降のみ同期

  requestAtOrBelow: 1, // R≤1 でリクエスト化

  sites: ['urakata', 'jalan', 'aj'],
  dispatchType: {
    reduce: { urakata: 'reduce_urakata', jalan: 'reduce_slot', aj: 'reduce_aj' },
    mode:   { urakata: 'mode_urakata',   jalan: 'mode_jalan',  aj: 'mode_aj'  },
  },
};

var OB_WD = ['日', '月', '火', '水', '木', '金', '土'];

/** 状態機械：C, B（＋override）から目標状態 {R, mode, stock} */
function obComputeTarget(capacity, booked, override) {
  var C = Number(capacity) || 0;
  var B = Number(booked) || 0;
  var R = C - B;
  if (override === 'stop')    return { R: R, mode: 'request', stock: 0 };   // x=受付停止
  if (override === 'request') return { R: R, mode: 'request', stock: 0 };   // △=リクエスト強制
  if (R <= OB_CONFIG.requestAtOrBelow) return { R: R, mode: 'request', stock: 0 };
  return { R: R, mode: 'immediate', stock: R };
}

/** メイン：定員マスター全枠を同期。dryRun=true は dispatch せずログのみ */
function syncAllSlots(dryRun) {
  if (dryRun === undefined) dryRun = true;
  var slots = obReadMaster_();
  var today = obTodayStr_();
  var report = [];

  slots.forEach(function (s) {
    if (OB_CONFIG.onlyFutureFromToday && s.date < today) return;
    var booked = obBookingCount_(s.date, s.time);
    var t = obComputeTarget(s.capacity, booked, s.override);
    report.push({ date: s.date, time: s.time, C: s.capacity, B: booked,
                  R: t.R, mode: t.mode, stock: t.stock, override: s.override || '' });
    obSyncOneSlot_(s, t, dryRun);
  });

  Logger.log('=== オーバーブッキング同期 %s ===', dryRun ? '[DRY_RUN 無操作]' : '[本番]');
  report.forEach(function (r) {
    Logger.log('%s %s | C=%s B=%s R=%s → %s(在庫%s)%s%s',
      r.date, r.time, r.C, r.B, r.R, r.mode, r.stock,
      r.override ? ' [' + r.override + ']' : '',
      r.R < 0 ? '  ⚠️定員超過!' : '');
  });
  return report;
}

/** 1枠を各チャネルへ絶対値同期 */
function obSyncOneSlot_(slot, target, dryRun) {
  var base = { slot_date: slot.date, slot_time: slot.time };
  OB_CONFIG.sites.forEach(function (site) {
    if (target.mode === 'request') {
      obDispatch_(OB_CONFIG.dispatchType.mode[site],
        Object.assign({}, base, { mode: 'request', stock: '0', dry_run: String(!!dryRun) }), dryRun);
    } else {
      // 即予約：モードを即予約に戻し＋在庫を絶対値Rにセット
      obDispatch_(OB_CONFIG.dispatchType.mode[site],
        Object.assign({}, base, { mode: 'immediate', stock: String(target.stock), dry_run: String(!!dryRun) }), dryRun);
      obDispatch_(OB_CONFIG.dispatchType.reduce[site],
        Object.assign({}, base, { slot_target_stock: String(target.stock), dry_run: String(!!dryRun) }), dryRun);
    }
  });
}

/** repository_dispatch（dryRun時は投げずログ） */
function obDispatch_(eventType, clientPayload, dryRun) {
  if (dryRun) { Logger.log('  (dry) %s %s', eventType, JSON.stringify(clientPayload)); return; }
  var token = PropertiesService.getScriptProperties().getProperty(OB_CONFIG.tokenProp);
  if (!token) throw new Error('GITHUB_TOKEN が未設定です（スクリプトプロパティ）');
  var url = 'https://api.github.com/repos/' + OB_CONFIG.owner + '/' + OB_CONFIG.repo + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('dispatch失敗 ' + eventType + ' code=' + code + ' ' + res.getContentText());
  Logger.log('  dispatched %s (%s)', eventType, code);
}

/**
 * 定員マスター（マトリクス）を読み、{date,time,capacity,override} の配列にする。
 * override: 'request'(△) / 'stop'(x) / ''（数字 or 空＝既定）
 */
function obReadMaster_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(OB_CONFIG.masterSheet);
  if (!sh) throw new Error('シートが見つかりません: ' + OB_CONFIG.masterSheet);
  var values = sh.getDataRange().getValues();
  var header = values[OB_CONFIG.headerRow - 1];

  // 日付カラム（C列〜）をパース："7/8(水)" → {col, date:'YYYY-MM-DD'}
  var dateCols = [];
  for (var c = OB_CONFIG.firstDateCol - 1; c < header.length; c++) {
    var d = obParseDateHeader_(header[c]);
    if (d) dateCols.push({ col: c, date: d });
  }

  var out = [];
  for (var r = OB_CONFIG.headerRow; r < values.length; r++) {
    var row = values[r];
    var time = obNormTime_(row[0]);           // A列＝時間
    if (!time) continue;
    var def = Number(row[OB_CONFIG.defaultCol - 1]) || 0;  // B列＝既定
    dateCols.forEach(function (dc) {
      var raw = row[dc.col];
      var cell = String(raw == null ? '' : raw).trim();
      var override = '', capacity = def;
      if (cell === '△' || cell === '▲') { override = 'request'; }
      else if (/^[x×✕✖XＸ]$/.test(cell)) { override = 'stop'; capacity = 0; }
      else if (cell !== '' && !isNaN(Number(cell))) { capacity = Number(cell); }
      // 空 → 既定を使用（capacity=def, override='')
      out.push({ date: dc.date, time: time, capacity: capacity, override: override });
    });
  }
  return out;
}

/** "7/8(水)" → 'YYYY-MM-DD'（曜日ラベルから年を推定） */
function obParseDateHeader_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return '';
  var mo = Number(m[1]), da = Number(m[2]);
  var wdM = s.match(/[(（]([日月火水木金土])[)）]/);
  var wd = wdM ? OB_WD.indexOf(wdM[1]) : -1;
  var nowY = new Date().getFullYear();
  var cands = [nowY, nowY + 1, nowY - 1];
  // 曜日が分かればそれで年を確定、無ければ「今日以降で最も近い年」を選ぶ
  for (var i = 0; i < cands.length; i++) {
    var dt = new Date(cands[i], mo - 1, da);
    if (wd >= 0 && dt.getDay() === wd) return obFmt_(dt);
  }
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var best = null;
  for (var j = 0; j < cands.length; j++) {
    var d2 = new Date(cands[j], mo - 1, da);
    if (d2 >= today && (!best || d2 < best)) best = d2;
  }
  return obFmt_(best || new Date(nowY, mo - 1, da));
}
function obFmt_(dt) { return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function obTodayStr_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function obNormTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  var m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

/**
 * ★要実装：予約総数B（全OTA合算・キャンセル除外）を返す。
 * 予約シートの構造に合わせて実装してください。日付は 'YYYY-MM-DD'、時間は 'HH:MM'。
 * 例）予約一覧シートに [日付, 時間, 人数, ステータス] があるなら、
 *    date/time 一致かつ status!=キャンセル の 人数 を合計する。
 */
function obBookingCount_(date, time) {
  var sh = SpreadsheetApp.getActive().getSheetByName(OB_CONFIG.bookingSheet);
  if (!sh) return 0; // 予約シート未設定なら 0（DRY_RUN確認用）
  // ------- TODO: 実カラムに合わせて調整 -------
  var COL = { date: '日付', time: '時間', count: '人数', status: 'ステータス' };
  var CANCEL = /キャンセル|取消|cancel/i;
  var values = sh.getDataRange().getValues();
  var h = values[0];
  var iD = h.indexOf(COL.date), iT = h.indexOf(COL.time),
      iC = h.indexOf(COL.count), iS = h.indexOf(COL.status);
  if (iD < 0 || iT < 0 || iC < 0) return 0;
  var sum = 0;
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var d = obFmtCell_(row[iD]), t = obNormTime_(row[iT]);
    if (d !== date || t !== time) continue;
    if (iS >= 0 && CANCEL.test(String(row[iS]))) continue;
    sum += Number(row[iC]) || 0;
  }
  return sum;
}
function obFmtCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var m = String(v == null ? '' : v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : String(v);
}

/** ショートカット */
function syncAllSlots_DryRun() { return syncAllSlots(true); }
function syncAllSlots_Live()   { return syncAllSlots(false); }
