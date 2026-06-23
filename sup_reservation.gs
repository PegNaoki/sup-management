// ============================================================
// SUP予約メール自動処理スクリプト
// ============================================================
// 設定: 以下の定数をご自身の環境に合わせて変更してください
// ============================================================

const CONFIG = {
  SPREADSHEET_ID: '1zaAb-6KRCoK4ACZWOlHZ3LnzKkDoVAs_In7aDOS9Vqo',
  SHEET_NAME: '予約一覧',
  CALENDAR_ID: '525a17f19df6b579e2ba94ea40b12c31a8b1fb21e1ae5610481c74314aab74e7@group.calendar.google.com',
  EVENT_DURATION_HOURS: 2,
  PROCESSED_LABEL: 'SUP予約/処理済',

  // 差出人アドレスで絞り込み（件名より確実）
  SEARCH_QUERY: 'in:anywhere ('
    + 'from:reservation@activityboard.jp'
    + ' OR from:reservation_request@activityboard.jp'
    + ' OR from:mailsender@asoview.com'
    + ' OR (from:activity-japan@activityjapan.com subject:(予約通知 OR 決済完了))'
    + ')',
};

// 予約タイプ判定（件名キーワード）
const CONFIRMED_KEYWORDS  = ['予約確定', '即時確定', '決済完了', '予約が確定'];
const TENTATIVE_KEYWORDS  = ['仮予約', '予約のリクエスト'];

// スプレッドシートの列定義
const COLUMNS = {
  TIMESTAMP:       1,  // A: 処理日時
  SUBJECT:         2,  // B: メール件名
  BOOKING_SITE:    3,  // C: 予約サイト
  BOOKING_TYPE:    4,  // D: 予約タイプ
  NAME:            5,  // E: 予約者名
  DATE:            6,  // F: 予約日
  TIME:            7,  // G: 予約時間
  PEOPLE:          8,  // H: 人数
  EMAIL:           9,  // I: メールアドレス
  PHONE:           10, // J: 電話番号
  NOTES:           11, // K: 備考
  STATUS:          12, // L: ステータス
  CALENDAR_ID_COL: 13, // M: カレンダーイベントID
  MESSAGE_ID:      14, // N: メッセージID（重複防止）
};

// ============================================================
// メイン処理：メール取込（バッチ処理・1回20件ずつ）
// ============================================================
function importReservationEmails() {
  const props   = PropertiesService.getScriptProperties();
  const ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet   = getOrCreateSheet(ss);
  const done    = getProcessedMessageIds(sheet);
  const label   = getOrCreateLabel(CONFIG.PROCESSED_LABEL);

  // 前回の続きオフセットを取得
  const offset   = parseInt(props.getProperty('IMPORT_OFFSET') || '0', 10);
  const BATCH    = 20;
  const threads  = GmailApp.search(CONFIG.SEARCH_QUERY, offset, BATCH);

  let newCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (done.has(msgId)) return;

      const reservation = parseEmail(message);
      if (!reservation) return;

      appendToSheet(sheet, reservation, msgId, message.getSubject());
      newCount++;
    });
    thread.addLabel(label);
  });

  if (newCount > 0) SpreadsheetApp.flush();

  if (threads.length === BATCH) {
    // まだ続きがある → 次回実行用にオフセットを保存
    props.setProperty('IMPORT_OFFSET', String(offset + BATCH));
    Logger.log(`${newCount}件取込。次回は${offset + BATCH}件目から再開します`);
  } else {
    // 全件処理完了 → オフセットをリセット
    props.deleteProperty('IMPORT_OFFSET');
    Logger.log(`取込完了（今回${newCount}件）。次回は最新メールのみチェックします`);
  }
}

// 過去メールを一括取込（手動実行用）
function importAllHistoricalEmails() {
  PropertiesService.getScriptProperties().deleteProperty('IMPORT_OFFSET');
  importReservationEmails();
}

// ============================================================
// メイン処理：カレンダー登録（トリガーで定期実行）
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
      Logger.log(`行${i + 1}: 日時のパース失敗 - "${dateStr}" "${timeStr}"`);
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
// メール解析ディスパッチャー
// ============================================================
function parseEmail(message) {
  const from    = message.getFrom();
  const subject = message.getSubject();
  const body    = message.getPlainBody();

  if (from.includes('activityboard.jp'))     return parseJalan(subject, body);
  if (from.includes('mailsender@asoview'))   return parseAsoview(subject, body);
  if (from.includes('activity-japan@activityjapan')) return parseActivityJapan(subject, body);

  return null;
}

// ============================================================
// じゃらんnet（差出人: reservation@activityboard.jp など）
// 本文例:
//   利用日時：2026/07/18(土) 09:30～11:30
//   人数：2名
//   体験者氏名：中山 加奈子(ナカヤマ　カナコ)様
//   メールアドレス：paniko_home@yahoo.co.jp
//   電話番号：08039716102
// ============================================================
function parseJalan(subject, body) {
  // 日付と時刻を「利用日時」から取る
  const dtMatch = body.match(/利用日時[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})[^0-9]*(\d{1,2}:\d{2})/);

  return {
    site:   'じゃらんnet',
    name:   extract(body, [/体験者氏名[：:]\s*(.+?)(?:様|\()/]),
    date:   dtMatch ? `${dtMatch[1]}/${dtMatch[2]}/${dtMatch[3]}` : extract(body, [/(\d{4}\/\d{1,2}\/\d{1,2})/]),
    time:   dtMatch ? dtMatch[4] : extract(body, [/(\d{1,2}:\d{2})/]),
    people: extract(body, [/人数[：:]\s*(\d+)\s*名/]),
    email:  extract(body, [/メールアドレス[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:  extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:  extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// アソビュー／satsuki（差出人: mailsender@asoview.com）
// 本文例:
//   予約代表者氏名 | 八角 亮 様
//   電話番号 | 080-1832-8930
//   ◆催行日 | 2026 年 07 月 15 日（水曜日）
//   ◆コース | 10:00
//   大人 13〜70歳 | 8500円 × 6名
//   小人 6〜12歳  | 5000円 × 1名
// ============================================================
function parseAsoview(subject, body) {
  // 日付：「2026 年 07 月 15 日」→ 2026/07/15
  const dateMatch = body.match(/◆催行日\s*\|\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const dateStr   = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '';

  // 人数：全参加者区分の合計（大人×N + 小人×M など）
  const peopleMatches = [...body.matchAll(/[×x]\s*(\d+)\s*名/g)];
  const totalPeople   = peopleMatches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

  return {
    site:   'アソビュー/satsuki',
    name:   extract(body, [/予約代表者氏名\s*\|\s*(.+?)\s*様/]),
    date:   dateStr,
    time:   extract(body, [/◆コース\s*\|\s*(\d{1,2}:\d{2})/]),
    people: totalPeople || extract(body, [/(\d+)\s*名/]),
    email:  extract(body, [/メールアドレス\s*\|\s*([\w.\-]+@[\w.\-]+)/]),
    phone:  extract(body, [/電話番号\s*\|\s*([\d\-\+]+)/]),
    notes:  extract(body, [/ご質問・ご要望等.*?[\r\n]+＜内容＞[\r\n]+([^\r\n]+)/s]),
  };
}

// ============================================================
// アクティビティジャパン（差出人: activity-japan@activityjapan.com）
// 本文例:
//   日時：2024年08月28日
//   氏名：　(ナカムラマサキ)
//   電話番号：+818034283239
//   体験者(6歳～65歳)×2 人
//   プラン名（コース名）：【...】（09:00 ）
// ============================================================
function parseActivityJapan(subject, body) {
  // 時刻はプラン名の末尾 (09:00 ) から取る
  const timeMatch = body.match(/（(\d{1,2}:\d{2})\s*）/);

  // 氏名：漢字があれば漢字、なければカナ
  const nameKanji = extract(body, [/氏名[：:]\s*([^\s\(（]+)/]);
  const nameKana  = extract(body, [/氏名[：:]\s*[\s　]*[\(（]([^\)）]+)[\)）]/]);
  const name      = nameKanji || nameKana;

  // 人数：「体験者…×2 人」「×2 人」など
  const peopleMatches = [...body.matchAll(/[×x]\s*(\d+)\s*人/g)];
  const totalPeople   = peopleMatches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

  return {
    site:   'アクティビティジャパン',
    name:   name,
    date:   extract(body, [/日時[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/]),
    time:   timeMatch ? timeMatch[1] : '',
    people: totalPeople || extract(body, [/(\d+)\s*人/]),
    email:  extract(body, [/メール[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:  extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:  extract(body, [/備考[：:]\s*(.+)/]),
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
  for (const kw of CONFIRMED_KEYWORDS)  if (subject.includes(kw)) return '確定';
  for (const kw of TENTATIVE_KEYWORDS)  if (subject.includes(kw)) return '仮予約';
  return '不明';
}

function parseDateTime(dateStr, timeStr) {
  try {
    const normalized = String(dateStr)
      .replace(/年/, '/').replace(/月/, '/').replace(/日/, '').replace(/-/g, '/').trim();
    const timeNorm = String(timeStr).replace(/時/, ':').replace(/分/, '').trim() || '09:00';

    const parts = normalized.split('/');
    if (parts.length !== 3) return null;
    const [y, mo, d] = parts.map(Number);
    const [h, mi]    = timeNorm.split(':').map(Number);

    const date = new Date(y, mo - 1, d, h, mi || 0);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) { return null; }
}

function appendToSheet(sheet, reservation, msgId, subject) {
  const bookingType   = detectBookingType(subject);
  const initialStatus = bookingType === '確定' ? '承認済' : '未確認';

  sheet.appendRow([
    new Date(),
    subject,
    reservation.site   || '',
    bookingType,
    reservation.name   || '',
    reservation.date   || '',
    reservation.time   || '',
    reservation.people || '',
    reservation.email  || '',
    reservation.phone  || '',
    reservation.notes  || '',
    initialStatus,
    '',
    msgId,
  ]);
}

function getProcessedMessageIds(sheet) {
  const data = sheet.getDataRange().getValues();
  const ids  = new Set();
  for (let i = 1; i < data.length; i++) {
    const id = data[i][COLUMNS.MESSAGE_ID - 1];
    if (id) ids.add(String(id));
  }
  return ids;
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    const headers = [
      '処理日時', 'メール件名', '予約サイト', '予約タイプ', '予約者名',
      '予約日', '予約時間', '人数', 'メールアドレス',
      '電話番号', '備考', 'ステータス', 'カレンダーイベントID', 'メッセージID',
    ];
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

  ScriptApp.newTrigger('importReservationEmails')
    .timeBased().everyMinutes(30).create();

  ScriptApp.newTrigger('registerApprovedToCalendar')
    .timeBased().everyHours(1).create();

  Logger.log('トリガーを設定しました');
}

// ============================================================
// 手動テスト用：最新1件をログに表示
// ============================================================
function testParseLatestEmail() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (!threads.length) { Logger.log('対象メールが見つかりませんでした'); return; }
  const msg = threads[0].getMessages()[0];
  Logger.log('件名: ' + msg.getSubject());
  Logger.log('差出人: ' + msg.getFrom());
  Logger.log(JSON.stringify(parseEmail(msg), null, 2));
}
