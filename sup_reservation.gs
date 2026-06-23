// ============================================================
// SUP予約メール自動処理スクリプト
// ============================================================

const CONFIG = {
  SPREADSHEET_ID:     '1zaAb-6KRCoK4ACZWOlHZ3LnzKkDoVAs_In7aDOS9Vqo',
  SHEET_NAME:         '予約一覧',
  CALENDAR_ID:        '525a17f19df6b579e2ba94ea40b12c31a8b1fb21e1ae5610481c74314aab74e7@group.calendar.google.com',
  EVENT_DURATION_HOURS: 2,
  PROCESSED_LABEL:    'SUP予約/処理済',

  // 差出人アドレス＋SUPキーワードで絞り込み（Gmail側で件数を減らしタイムアウト防止）
  SEARCH_QUERY: 'in:anywhere (SUP OR サップ) ('
    + 'from:reservation@activityboard.jp'
    + ' OR from:reservation_request@activityboard.jp'
    + ' OR from:mailsender@asoview.com'
    + ' OR from:reserve-system@activityjapan.com'
    + ')',
};

// 予約タイプ判定キーワード
const CONFIRMED_KEYWORDS = ['予約確定', '即時確定', '決済完了', '予約が確定'];
const TENTATIVE_KEYWORDS = ['仮予約', '予約のリクエスト'];

// スプレッドシートの列定義
const COLUMNS = {
  TIMESTAMP:       1,  // A: 処理日時
  SUBJECT:         2,  // B: メール件名
  BOOKING_SITE:    3,  // C: 予約サイト
  BOOKING_TYPE:    4,  // D: 予約タイプ
  BOOKING_NO:      5,  // E: 予約番号
  NAME:            6,  // F: 予約者名
  DATE:            7,  // G: 予約日
  TIME:            8,  // H: 予約時間
  PEOPLE:          9,  // I: 人数
  EMAIL:           10, // J: メールアドレス
  PHONE:           11, // K: 電話番号
  NOTES:           12, // L: 備考
  STATUS:          13, // M: ステータス
  CALENDAR_ID_COL: 14, // N: カレンダーイベントID
  MESSAGE_ID:      15, // O: メッセージID（重複防止）
};

// ============================================================
// メイン処理：メール取込（通常トリガー用・直近50件）
// ============================================================
function importReservationEmails() {
  importEmails_(50);
}

// ============================================================
// 過去メール全件一括取込（手動実行用・最大500件）
// ============================================================
function importAllHistoricalEmails() {
  PropertiesService.getScriptProperties().deleteProperty('IMPORT_OFFSET');
  importEmails_(500);
}

// ============================================================
// 共通取込処理
// ============================================================
function importEmails_(limit) {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const label = getOrCreateLabel(CONFIG.PROCESSED_LABEL);

  const threads  = GmailApp.search(CONFIG.SEARCH_QUERY, 0, limit);
  const existing = loadExistingReservations(sheet);

  let newCount = 0, updateCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (existing.byMsgId.has(msgId)) return;

      const reservation = parseEmail(message);
      if (!reservation) return;

      const bookingNo   = reservation.bookingNo;
      const existingRow = bookingNo ? existing.byBookingNo.get(bookingNo) : null;

      if (existingRow) {
        updateRow(sheet, existingRow, reservation, msgId, message.getSubject());
        updateCount++;
      } else {
        appendToSheet(sheet, reservation, msgId, message.getSubject());
        newCount++;
      }
    });
    thread.addLabel(label);
  });

  if (newCount > 0 || updateCount > 0) SpreadsheetApp.flush();
  Logger.log(`取込完了：新規${newCount}件・更新${updateCount}件（対象スレッド${threads.length}件）`);
}

// ============================================================
// メイン処理：カレンダー登録
// ============================================================
function registerApprovedToCalendar() {
  const ss       = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet    = getOrCreateSheet(ss);
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);

  if (!calendar) {
    Logger.log('カレンダーが見つかりません。CALENDAR_IDを確認してください。');
    return;
  }

  const data = sheet.getDataRange().getValues();
  let updatedCount = 0;

  for (let i = 1; i < data.length; i++) {
    const row        = data[i];
    const status     = row[COLUMNS.STATUS - 1];
    const calEventId = row[COLUMNS.CALENDAR_ID_COL - 1];

    if (status !== '承認済' || calEventId) continue;

    const name    = row[COLUMNS.NAME - 1];
    const people  = row[COLUMNS.PEOPLE - 1];
    const site    = row[COLUMNS.BOOKING_SITE - 1];
    const notes   = row[COLUMNS.NOTES - 1];
    const dateStr = row[COLUMNS.DATE - 1];
    const timeStr = row[COLUMNS.TIME - 1];

    const startDate = parseDateTime(dateStr, timeStr);
    if (!startDate) {
      Logger.log(`行${i + 1}: 日時パース失敗 - "${dateStr}" "${timeStr}"`);
      continue;
    }

    const endDate     = new Date(startDate.getTime() + CONFIG.EVENT_DURATION_HOURS * 3600 * 1000);
    const title       = `【SUP予約】${name} ${people}名 (${site})`;
    const description = [`予約者: ${name}`, `人数: ${people}名`, `予約サイト: ${site}`, notes ? `備考: ${notes}` : '']
                          .filter(Boolean).join('\n');

    try {
      const event = calendar.createEvent(title, startDate, endDate, { description });
      sheet.getRange(i + 1, COLUMNS.STATUS).setValue('カレンダー登録済');
      sheet.getRange(i + 1, COLUMNS.CALENDAR_ID_COL).setValue(event.getId());
      updatedCount++;
    } catch (e) {
      Logger.log(`行${i + 1} カレンダー登録エラー: ${e.message}`);
    }
  }

  if (updatedCount > 0) {
    SpreadsheetApp.flush();
    Logger.log(`${updatedCount}件をカレンダーに登録しました`);
  }
}

// ============================================================
// SUP判定：本文にSUPが含まれるか
// ============================================================
function isSUP(reservation, body) {
  return body.includes('SUP') || body.includes('サップ') || body.includes('サップ体験');
}

// ============================================================
// メール解析ディスパッチャー
// ============================================================
function parseEmail(message) {
  const from = message.getFrom();
  const body = message.getPlainBody();
  const subject = message.getSubject();

  if (from.includes('activityboard.jp'))          return parseJalan(subject, body);
  if (from.includes('mailsender@asoview'))         return parseAsoview(subject, body);
  if (from.includes('reserve-system@activityjapan')) return parseActivityJapan(subject, body);

  return null;
}

// ============================================================
// じゃらんnet（reservation@activityboard.jp）
// 本文例:
//   予約番号：30A1UP0VW
//   利用日時：2026/07/18(土) 09:30～11:30
//   人数：2名
//   体験者氏名：中山 加奈子(ナカヤマ　カナコ)様
//   メールアドレス：paniko_home@yahoo.co.jp
//   電話番号：08039716102
// ============================================================
function parseJalan(subject, body) {
  const dtMatch = body.match(/利用日時[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})[^0-9]*(\d{1,2}:\d{2})/);

  return {
    site:      'じゃらんnet',
    bookingNo: extract(body, [/予約番号[：:]\s*([A-Z0-9]+)/]),
    name:      extract(body, [/体験者氏名[：:]\s*(.+?)(?:様|\()/]),
    date:      dtMatch ? `${dtMatch[1]}/${dtMatch[2]}/${dtMatch[3]}` : extract(body, [/(\d{4}\/\d{1,2}\/\d{1,2})/]),
    time:      dtMatch ? dtMatch[4] : extract(body, [/(\d{1,2}:\d{2})/]),
    people:    extract(body, [/人数[：:]\s*(\d+)\s*名/]),
    email:     extract(body, [/メールアドレス[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:     extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:     extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// アソビュー／satsuki（mailsender@asoview.com）
// 本文例:
//   予約代表者氏名 | 八角 亮 様
//   電話番号 | 080-1832-8930
//   ◆催行日 | 2026 年 07 月 15 日（水曜日）
//   ◆コース | 10:00
//   大人 13〜70歳 | 8500円 × 6名
// ============================================================
function parseAsoview(subject, body) {
  const dateMatch   = body.match(/◆催行日\s*\|\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const dateStr     = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '';
  const peopleMatch = [...body.matchAll(/[×x]\s*(\d+)\s*名/g)];
  const totalPeople = peopleMatch.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

  // satsuki URLから予約番号を取得
  const bookingNo = extract(body, [/reserveNo(\d+)/, /予約番号[：:]\s*(\d+)/]);

  return {
    site:      'アソビュー/satsuki',
    bookingNo: bookingNo,
    name:      extract(body, [/予約代表者氏名\s*\|\s*(.+?)\s*様/]),
    date:      dateStr,
    time:      extract(body, [/◆コース\s*\|\s*(\d{1,2}:\d{2})/]),
    people:    totalPeople || extract(body, [/(\d+)\s*名/]),
    email:     extract(body, [/メールアドレス\s*\|\s*([\w.\-]+@[\w.\-]+)/]),
    phone:     extract(body, [/電話番号\s*\|\s*([\d\-\+]+)/]),
    notes:     extract(body, [/ご質問・ご要望等.*?[\r\n]+＜内容＞[\r\n]+([^\r\n]+)/s]),
  };
}

// ============================================================
// アクティビティジャパン（reserve-system@activityjapan.com）
// 本文例:
//   予約番号：2602197139378
//   日時：2026年02月21日
//   氏名：重松　純平(シゲマツ　ジュンペイ)
//   電話番号：08041934538
//   プラン名（コース名）：【...】（14:00 ）
//   大人(中学生以上)×2 人
// ============================================================
function parseActivityJapan(subject, body) {
  const timeMatch   = body.match(/（(\d{1,2}:\d{2})\s*）/);
  const nameKanji   = extract(body, [/氏名[：:]\s*([^\s\(（\t]+)/]);
  const nameKana    = extract(body, [/氏名[：:]\s*[\s　]*[\(（]([^\)）]+)[\)）]/]);
  const peopleMatch = [...body.matchAll(/[×x]\s*(\d+)\s*人/g)];
  const totalPeople = peopleMatch.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

  return {
    site:      'アクティビティジャパン',
    bookingNo: extract(body, [/予約番号[：:]\s*(\d+)/]),
    name:      nameKanji || nameKana,
    date:      extract(body, [/日時[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/]),
    time:      timeMatch ? timeMatch[1] : '',
    people:    totalPeople || extract(body, [/(\d+)\s*人/]),
    email:     extract(body, [/メール[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:     extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:     extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// ユーティリティ関数
// ============================================================

function extract(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function detectBookingType(subject) {
  for (const kw of CONFIRMED_KEYWORDS) if (subject.includes(kw)) return '確定';
  for (const kw of TENTATIVE_KEYWORDS) if (subject.includes(kw)) return '仮予約';
  return '不明';
}

function parseDateTime(dateStr, timeStr) {
  try {
    let year, month, day, hour = 9, minute = 0;

    // 日付がDateオブジェクトの場合（スプレッドシートから読み込んだ場合）
    if (dateStr instanceof Date) {
      year  = dateStr.getFullYear();
      month = dateStr.getMonth() + 1;
      day   = dateStr.getDate();
    } else {
      const normalized = String(dateStr)
        .replace(/年/, '/').replace(/月/, '/').replace(/日/, '').replace(/-/g, '/').trim();
      const parts = normalized.split('/');
      if (parts.length !== 3) return null;
      [year, month, day] = parts.map(Number);
    }

    // 時刻がDateオブジェクトの場合
    if (timeStr instanceof Date) {
      hour   = timeStr.getHours();
      minute = timeStr.getMinutes();
    } else {
      const timeNorm = String(timeStr).replace(/時/, ':').replace(/分/, '').trim();
      if (timeNorm.includes(':')) {
        [hour, minute] = timeNorm.split(':').map(Number);
      }
    }

    const date = new Date(year, month - 1, day, hour, minute);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) { return null; }
}

// 既存データを読み込み（予約番号→行番号 と メッセージID のマップ）
function loadExistingReservations(sheet) {
  const data      = sheet.getDataRange().getValues();
  const byBookingNo = new Map();
  const byMsgId   = new Set();

  for (let i = 1; i < data.length; i++) {
    const row       = data[i];
    const bookingNo = String(row[COLUMNS.BOOKING_NO - 1]).trim();
    const msgId     = String(row[COLUMNS.MESSAGE_ID - 1]).trim();

    if (bookingNo) byBookingNo.set(bookingNo, i + 1); // 1始まりの行番号
    if (msgId)     byMsgId.add(msgId);
  }
  return { byBookingNo, byMsgId };
}

// 新規行を追加
function appendToSheet(sheet, reservation, msgId, subject) {
  const bookingType   = detectBookingType(subject);
  const initialStatus = bookingType === '確定' ? '承認済' : '未確認';

  sheet.appendRow([
    new Date(),
    subject,
    reservation.site      || '',
    bookingType,
    reservation.bookingNo || '',
    reservation.name      || '',
    reservation.date      || '',
    reservation.time      || '',
    reservation.people    || '',
    reservation.email     || '',
    reservation.phone     || '',
    reservation.notes     || '',
    initialStatus,
    '',
    msgId,
  ]);
}

// 既存行を更新（仮予約→確定 など）
function updateRow(sheet, rowNum, reservation, msgId, subject) {
  const bookingType = detectBookingType(subject);

  // 確定メールなら件名・タイプ・ステータスを上書き
  // カレンダー登録済の場合はステータスを変えない
  const currentStatus = sheet.getRange(rowNum, COLUMNS.STATUS).getValue();
  const newStatus = bookingType === '確定' && currentStatus !== 'カレンダー登録済'
    ? '承認済' : currentStatus;

  sheet.getRange(rowNum, COLUMNS.TIMESTAMP).setValue(new Date());
  sheet.getRange(rowNum, COLUMNS.SUBJECT).setValue(subject);
  sheet.getRange(rowNum, COLUMNS.BOOKING_TYPE).setValue(bookingType);
  if (reservation.name)   sheet.getRange(rowNum, COLUMNS.NAME).setValue(reservation.name);
  if (reservation.date)   sheet.getRange(rowNum, COLUMNS.DATE).setValue(reservation.date);
  if (reservation.time)   sheet.getRange(rowNum, COLUMNS.TIME).setValue(reservation.time);
  if (reservation.people) sheet.getRange(rowNum, COLUMNS.PEOPLE).setValue(reservation.people);
  if (reservation.email)  sheet.getRange(rowNum, COLUMNS.EMAIL).setValue(reservation.email);
  if (reservation.phone)  sheet.getRange(rowNum, COLUMNS.PHONE).setValue(reservation.phone);
  sheet.getRange(rowNum, COLUMNS.STATUS).setValue(newStatus);
  sheet.getRange(rowNum, COLUMNS.MESSAGE_ID).setValue(msgId);
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }

  // ヘッダーが正しく入っていない場合は常に上書き
  const headers = [
    '処理日時', 'メール件名', '予約サイト', '予約タイプ', '予約番号', '予約者名',
    '予約日', '予約時間', '人数', 'メールアドレス',
    '電話番号', '備考', 'ステータス', 'カレンダーイベントID', 'メッセージID',
  ];
  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell !== '処理日時') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未確認', '承認済', '却下', 'キャンセル', 'カレンダー登録済'])
      .build();
    sheet.getRange(2, COLUMNS.STATUS, 1000, 1).setDataValidation(rule);
    sheet.hideColumns(COLUMNS.MESSAGE_ID);
  }
  return sheet;
}

function getOrCreateLabel(labelName) {
  const parts = labelName.split('/');
  let label = null, path = '';
  for (const part of parts) {
    path  = path ? `${path}/${part}` : part;
    label = GmailApp.getUserLabelByName(path) || GmailApp.createLabel(path);
  }
  return label;
}

// ============================================================
// セットアップ：トリガー登録
// ============================================================
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('importReservationEmails').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('registerApprovedToCalendar').timeBased().everyHours(1).create();
  Logger.log('トリガーを設定しました');
}

// ============================================================
// 手動テスト用：最新1件をログに表示
// ============================================================
function testParseLatestEmail() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (!threads.length) { Logger.log('対象メールが見つかりませんでした'); return; }
  const msg  = threads[0].getMessages()[0];
  const body = msg.getPlainBody();
  Logger.log('件名: '    + msg.getSubject());
  Logger.log('差出人: '  + msg.getFrom());
  Logger.log('SUP判定: ' + isSUP({}, body));
  Logger.log(JSON.stringify(parseEmail(msg), null, 2));
}
