/**
 * ============================================================
 * オーバーブッキング防止 絶対値同期（GAS 制御ロジック）
 * ------------------------------------------------------------
 * 【役割】スプレッドシートを唯一の真実源として、枠ごとに
 *   R = 定員C − 予約総数B（全OTA合算）
 * を計算し、状態機械に従って各OTAの「予約方式（即予約/リクエスト）」と
 * 「即予約在庫」を GitHub Actions（reduce_* / mode_*）へ絶対値で指示する。
 *
 * 【状態機械】※安全マージン R≤1 でリクエスト化（要件確定値）
 *   R >= 2 : 即予約(immediate) ／ 即予約在庫 = R
 *   R == 1 : リクエスト(request)（最後の1席は承認制）／即予約在庫 0
 *   R <= 0 : リクエスト(request) ＋ 在庫0（自動確定を完全停止）
 *
 * 【差分連動をやめて絶対値同期にする理由】
 *   「他サイトを−N」ではなく毎回「全チャネル = 目標状態」に上書きするため、
 *   初期割当ズレ・取りこぼしイベントがあっても次回同期で必ず正しい R に収束する。
 *
 * 【共通在庫】ウラカタ＝アソビュー＝Web は共通在庫なので urakata 1チャネルで代表。
 *
 * 【貼り付け手順】
 *   1) この関数群を Apps Script プロジェクトに追加。
 *   2) スクリプトプロパティに GITHUB_TOKEN（repo dispatch 可能なPAT）を設定
 *      （既存のディスパッチで使っているものがあれば流用）。
 *   3) 下の CONFIG のシート名・列マッピングを実際のシートに合わせる。
 *   4) まず syncAllSlots(true)（DRY_RUN）を実行し、ログの目標状態が妥当か確認。
 *   5) 問題なければ syncAllSlots(false) を予約検知トリガー & 2時間ごとに呼ぶ。
 * ============================================================
 */

var OB_CONFIG = {
  // --- GitHub ---
  owner: 'PegNaoki',
  repo:  'sup-management',
  tokenProp: 'GITHUB_TOKEN',        // PropertiesService に入れたPATのキー名

  // --- シート ---
  sheetName: '枠管理',              // TODO: 実シート名に合わせる
  headerRow: 1,                     // ヘッダ行
  // 列名（ヘッダ文字列で解決。実シートに合わせて変更）
  col: {
    date:     '日付',              // YYYY-MM-DD もしくは Date セル
    time:     '時間',              // HH:MM
    capacity: '定員',              // 実キャパ C（手入力）
    booked:   '予約総数',          // 予約総数 B（Reconcile集計の書き込み先）
    // 任意の手動オーバーライド（'request'/'immediate'/'auto' 空=auto）
    override: 'モード上書き',
    // 同期結果の書き戻し先（任意）
    result:   '同期結果',
  },

  // --- 状態機械のしきい値 ---
  requestAtOrBelow: 1,              // R がこの値以下なら request（=R≤1で承認制）

  // --- 対象チャネル（共通在庫の urakata を代表に）---
  sites: ['urakata', 'jalan', 'aj'],
  dispatchType: {
    reduce: { urakata: 'reduce_urakata', jalan: 'reduce_slot', aj: 'reduce_aj' },
    mode:   { urakata: 'mode_urakata',   jalan: 'mode_jalan',  aj: 'mode_aj'  },
  },
};

/** 状態機械：C, B から目標状態 {R, mode, stock} を返す */
function obComputeTarget(capacity, booked) {
  var C = Number(capacity) || 0;
  var B = Number(booked) || 0;
  var R = C - B;
  if (R <= OB_CONFIG.requestAtOrBelow) {
    // R<=1 → リクエスト化（自動確定停止）。在庫は0に。
    return { R: R, mode: 'request', stock: 0 };
  }
  // R>=2 → 即予約。即予約在庫 = R（各チャネルをこの値に揃える）
  return { R: R, mode: 'immediate', stock: R };
}

/** メイン：全枠を同期。dryRun=true なら dispatch せずログのみ（無操作差分レポート） */
function syncAllSlots(dryRun) {
  if (dryRun === undefined) dryRun = true;
  var rows = obReadSlots_();
  var report = [];
  rows.forEach(function (s) {
    // 手動オーバーライド（auto以外なら状態機械を上書き）
    var t;
    if (s.override === 'request') {
      t = { R: s.capacity - s.booked, mode: 'request', stock: 0 };
    } else if (s.override === 'immediate') {
      var r = s.capacity - s.booked;
      t = { R: r, mode: 'immediate', stock: Math.max(0, r) };
    } else {
      t = obComputeTarget(s.capacity, s.booked);
    }
    report.push({ date: s.date, time: s.time, C: s.capacity, B: s.booked, R: t.R, mode: t.mode, stock: t.stock });
    obSyncOneSlot_(s, t, dryRun);
  });

  // ログ & シート書き戻し
  Logger.log('=== オーバーブッキング同期 %s ===', dryRun ? '[DRY_RUN 無操作]' : '[本番]');
  report.forEach(function (r) {
    Logger.log('%s %s | C=%s B=%s R=%s → %s (在庫%s)%s',
      r.date, r.time, r.C, r.B, r.R, r.mode, r.stock, r.R < 0 ? '  ⚠️定員超過!' : '');
  });
  obWriteResults_(report, dryRun);
  return report;
}

/** 1枠を各チャネルへ同期 */
function obSyncOneSlot_(slot, target, dryRun) {
  var slotObj = { slot_date: slot.date, slot_time: slot.time };
  OB_CONFIG.sites.forEach(function (site) {
    if (target.mode === 'request') {
      // リクエスト化：モードだけ切替（在庫はスクリプト側で0扱い）
      obDispatch_(OB_CONFIG.dispatchType.mode[site], Object.assign({}, slotObj, {
        mode: 'request', stock: '0', dry_run: String(!!dryRun),
      }), dryRun);
    } else {
      // 即予約：モードを即予約に（戻し）＋在庫を絶対値Rにセット
      obDispatch_(OB_CONFIG.dispatchType.mode[site], Object.assign({}, slotObj, {
        mode: 'immediate', stock: String(target.stock), dry_run: String(!!dryRun),
      }), dryRun);
      obDispatch_(OB_CONFIG.dispatchType.reduce[site], Object.assign({}, slotObj, {
        slot_target_stock: String(target.stock), dry_run: String(!!dryRun),
      }), dryRun);
    }
  });
}

/** repository_dispatch を投げる（dryRun 時は投げずにログ） */
function obDispatch_(eventType, clientPayload, dryRun) {
  if (dryRun) {
    Logger.log('  (dry) dispatch %s %s', eventType, JSON.stringify(clientPayload));
    return;
  }
  var token = PropertiesService.getScriptProperties().getProperty(OB_CONFIG.tokenProp);
  if (!token) throw new Error('GITHUB_TOKEN が未設定です（スクリプトプロパティ）');
  var url = 'https://api.github.com/repos/' + OB_CONFIG.owner + '/' + OB_CONFIG.repo + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('dispatch失敗 ' + eventType + ' code=' + code + ' ' + res.getContentText());
  Logger.log('  dispatched %s (%s)', eventType, code);
}

/** シートから枠一覧を読む（ヘッダ名→列インデックス解決） */
function obReadSlots_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(OB_CONFIG.sheetName);
  if (!sh) throw new Error('シートが見つかりません: ' + OB_CONFIG.sheetName);
  var values = sh.getDataRange().getValues();
  var header = values[OB_CONFIG.headerRow - 1];
  function idx(name) {
    var i = header.indexOf(name);
    if (i < 0) throw new Error('列が見つかりません: ' + name);
    return i;
  }
  var iDate = idx(OB_CONFIG.col.date), iTime = idx(OB_CONFIG.col.time),
      iCap = idx(OB_CONFIG.col.capacity), iBk = idx(OB_CONFIG.col.booked);
  var iOv = OB_CONFIG.col.override && header.indexOf(OB_CONFIG.col.override) >= 0
    ? header.indexOf(OB_CONFIG.col.override) : -1;

  var out = [];
  for (var r = OB_CONFIG.headerRow; r < values.length; r++) {
    var row = values[r];
    var date = obNormDate_(row[iDate]);
    var time = obNormTime_(row[iTime]);
    if (!date || !time) continue;                 // 空行スキップ
    if (row[iCap] === '' || row[iCap] === null) continue; // 定員未設定はスキップ
    out.push({
      rowIndex: r + 1,
      date: date, time: time,
      capacity: Number(row[iCap]) || 0,
      booked: Number(row[iBk]) || 0,
      override: iOv >= 0 ? String(row[iOv] || '').trim().toLowerCase() : '',
    });
  }
  return out;
}

/** 同期結果をシートに書き戻す（result列があれば） */
function obWriteResults_(report, dryRun) {
  var sh = SpreadsheetApp.getActive().getSheetByName(OB_CONFIG.sheetName);
  if (!sh) return;
  var header = sh.getRange(OB_CONFIG.headerRow, 1, 1, sh.getLastColumn()).getValues()[0];
  var iRes = header.indexOf(OB_CONFIG.col.result);
  if (iRes < 0) return;
  // date+time → report のマップ
  var map = {};
  report.forEach(function (r) { map[r.date + ' ' + r.time] = r; });
  var slots = obReadSlots_();
  slots.forEach(function (s) {
    var r = map[s.date + ' ' + s.time];
    if (!r) return;
    var note = (dryRun ? '[DRY]' : '') + r.mode + ' 在庫' + r.stock + ' (R=' + r.R + ')'
      + (r.R < 0 ? ' ⚠️超過' : '');
    sh.getRange(s.rowIndex, iRes + 1).setValue(note);
  });
}

// --- 日付/時刻の正規化 ---
function obNormDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}
function obNormTime_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  var m = String(v).match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return ('0' + m[1]).slice(-2) + ':' + m[2];
}

/** DRY_RUN ショートカット（メニュー/手動実行用） */
function syncAllSlots_DryRun() { return syncAllSlots(true); }
/** 本番同期（トリガー用） */
function syncAllSlots_Live()   { return syncAllSlots(false); }
