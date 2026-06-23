// ============================================================
// SUP予約メール自動処理スクリプト
// ============================================================

const CONFIG = {
  SPREADSHEET_ID:     '1zaAb-6KRCoK4ACZWOlHZ3LnzKkDoVAs_In7aDOS9Vqo',
  SHEET_NAME:         '予約一覧',
  CALENDAR_ID:        '525a17f19df6b579e2ba94ea40b12c31a8b1fb21e1ae5610481c74314aab74e7@group.calendar.google.com',
  EVENT_DURATION_HOURS: 2,
  PROCESSED_LABEL:    'SUP予約/処理済',

  SEARCH_QUERY: 'in:anywhere (SUP OR サップ) ('
    + 'from:reservation@activityboard.jp'
    + ' OR from:reservation_request@activityboard.jp'
    + ' OR from:mailsender@asoview.com'
    + ' OR from:reserve-system@activityjapan.com'
    + ')',
};

const CONFIRMED_KEYWORDS = ['予約確定', '即時確定', '決済完了', '予約が確定'];
const TENTATIVE_KEYWORDS = ['仮予約', '予約のリクエスト'];

const COLUMNS = {
  TIMESTAMP:       1,  // A: 処理日時
  SUBJECT:         2,  // B: メール件名
  BOOKING_SITE:    3,  // C: 予約サイト
  BOOKING_TYPE:    4,  // D: 予約タイプ
  BOOKING_NO:      5,  // E: 予約番号
  NAME:            6,  // F: 予約者名
  KANA:            7,  // G: フリガナ
  DATE:            8,  // H: 予約日
  TIME:            9,  // I: 予約時間
  PEOPLE:          10, // J: 人数（合計）
  PEOPLE_DETAIL:   11, // K: 人数内訳
  AMOUNT:          12, // L: 金額
  PAYMENT:         13, // M: 支払方法
  EMAIL:           14, // N: メールアドレス
  PHONE:           15, // O: 電話番号
  NOTES:           16, // P: 備考
  STATUS:          17, // Q: ステータス
  CALENDAR_ID_COL: 18, // R: カレンダーイベントID
  MESSAGE_ID:      19, // S: メッセージID（重複防止）
};

// ============================================================
// メイン処理：メール取込（トリガー用・直近50件）
// ============================================================
function importReservationEmails() {
  importEmails_(50);
}

// 過去メール全件一括取込（手動実行用）
function importAllHistoricalEmails() {
  importEmails_(500);
}

function importEmails_(limit) {
  const ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet   = getOrCreateSheet(ss);
  const label   = getOrCreateLabel(CONFIG.PROCESSED_LABEL);
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, limit);
  const existing = loadExistingReservations(sheet);

  let newCount = 0, updateCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (existing.byMsgId.has(msgId)) return;

      const r = parseEmail(message);
      if (!r) return;

      const existingRow = r.bookingNo ? existing.byBookingNo.get(r.bookingNo) : null;
      if (existingRow) {
        updateRow(sheet, existingRow, r, msgId, message.getSubject());
        updateCount++;
      } else {
        appendToSheet(sheet, r, msgId, message.getSubject());
        newCount++;
      }
    });
    thread.addLabel(label);
  });

  if (newCount > 0 || updateCount > 0) SpreadsheetApp.flush();
  Logger.log(`取込完了：新規${newCount}件・更新${updateCount}件（対象${threads.length}スレッド）`);
}

// ============================================================
// カレンダー登録
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

    const site         = row[COLUMNS.BOOKING_SITE - 1];
    const name         = row[COLUMNS.NAME - 1];
    const kana         = row[COLUMNS.KANA - 1];
    const dateStr      = row[COLUMNS.DATE - 1];
    const timeStr      = row[COLUMNS.TIME - 1];
    const people       = row[COLUMNS.PEOPLE - 1];
    const peopleDetail = row[COLUMNS.PEOPLE_DETAIL - 1];
    const amount       = row[COLUMNS.AMOUNT - 1];
    const payment      = row[COLUMNS.PAYMENT - 1];
    const email        = row[COLUMNS.EMAIL - 1];
    const phone        = row[COLUMNS.PHONE - 1];
    const notes        = row[COLUMNS.NOTES - 1];

    const startDate = parseDateTime(dateStr, timeStr);
    if (!startDate) {
      Logger.log(`行${i + 1}: 日時パース失敗 - "${dateStr}" "${timeStr}"`);
      continue;
    }

    const endDate = new Date(startDate.getTime() + CONFIG.EVENT_DURATION_HOURS * 3600 * 1000);

    // タイトル例：【じゃらんnet】ナカヤマ カナコ｜2名｜7,000円｜カード決済
    const displayName   = kana || name;
    const peopleStr     = peopleDetail || `${people}名`;
    const amountStr     = amount ? `${amount}` : '';
    const paymentStr    = payment || '';
    const titleParts    = [`【${site}】${displayName}`, peopleStr, amountStr, paymentStr]
                            .filter(Boolean);
    const title = titleParts.join('｜');

    // 説明文
    const description = [
      `予約者: ${name}`,
      kana         ? `フリガナ: ${kana}`           : '',
      phone        ? `電話番号: ${phone}`           : '',
      email        ? `メール: ${email}`             : '',
      peopleDetail ? `人数内訳: ${peopleDetail}`    : `人数: ${people}名`,
      amount       ? `金額: ${amount}`              : '',
      payment      ? `支払方法: ${payment}`         : '',
      notes        ? `備考: ${notes}`               : '',
    ].filter(Boolean).join('\n');

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
// メール解析
// ============================================================
function parseEmail(message) {
  const from = message.getFrom();
  const body = message.getPlainBody();
  const subject = message.getSubject();

  if (from.includes('activityboard.jp'))              return parseJalan(subject, body);
  if (from.includes('mailsender@asoview'))            return parseAsoview(subject, body);
  if (from.includes('reserve-system@activityjapan')) return parseActivityJapan(subject, body);
  return null;
}

// ============================================================
// じゃらんnet
// 体験者氏名：中山 加奈子(ナカヤマ　カナコ)様
// 利用日時：2026/07/18(土) 09:30～11:30
// 人数：2名
// 合計料金(税込)：7,000円
// 支払方法：オンラインカード決済
// ============================================================
function parseJalan(subject, body) {
  const dtMatch   = body.match(/利用日時[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})[^0-9]*(\d{1,2}:\d{2})/);
  const nameMatch = body.match(/体験者氏名[：:]\s*(.+?)(?:（|\()([^）)]+)(?:）|\))\s*様/);

  // 人数内訳（例：大人×2名、子供×1名）
  const peopleRows   = [...body.matchAll(/([^：\n]+)[：:]\s*(\d+)\s*名/g)]
                         .filter(m => ['大人', '小人', '子供', 'お一人'].some(k => m[1].includes(k)));
  const peopleDetail = peopleRows.length
    ? peopleRows.map(m => `${m[1].trim()}${m[2]}名`).join('・')
    : '';

  return {
    site:         'じゃらんnet',
    bookingNo:    extract(body, [/予約番号[：:]\s*([A-Z0-9]+)/]),
    name:         nameMatch ? nameMatch[1].trim() : extract(body, [/体験者氏名[：:]\s*(.+?)(?:様|\()/]),
    kana:         nameMatch ? nameMatch[2].trim() : '',
    date:         dtMatch ? `${dtMatch[1]}/${dtMatch[2]}/${dtMatch[3]}` : extract(body, [/(\d{4}\/\d{1,2}\/\d{1,2})/]),
    time:         dtMatch ? dtMatch[4] : extract(body, [/(\d{1,2}:\d{2})/]),
    people:       extract(body, [/人数[：:]\s*(\d+)\s*名/]),
    peopleDetail: peopleDetail,
    amount:       extract(body, [/合計料金[（(]税込[）)][：:]\s*([0-9,]+円)/]),
    payment:      extract(body, [/支払方法[：:]\s*(.+)/]),
    email:        extract(body, [/メールアドレス[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:        extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// アソビュー／satsuki
// 予約代表者氏名 | 八角 亮 様
// 予約代表者氏名カナ | ヤスミ リョウ サマ
// ◆催行日 | 2026 年 07 月 15 日
// ◆コース | 10:00
// 大人 13〜70歳 | 8500円 × 6名
// ◆提示金額 | 48000円（税込）
// ◆支払い方法 | 現地払い
// ============================================================
function parseAsoview(subject, body) {
  const dateMatch    = body.match(/◆催行日\s*\|\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const dateStr      = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '';

  // 人数内訳と合計
  const peopleLines  = [...body.matchAll(/^(.+?)\s*\|\s*\d+円\s*[×x]\s*(\d+)\s*名/gm)];
  const totalPeople  = peopleLines.reduce((s, m) => s + parseInt(m[2], 10), 0);
  const peopleDetail = peopleLines.length
    ? peopleLines.map(m => `${m[1].trim()}×${m[2]}名`).join('・')
    : '';

  return {
    site:         'アソビュー/satsuki',
    bookingNo:    extract(body, [/reserveNo(\d+)/, /予約番号[：:]\s*(\d+)/]),
    name:         extract(body, [/予約代表者氏名\s*\|\s*(.+?)\s*様/]),
    kana:         extract(body, [/予約代表者氏名カナ\s*\|\s*(.+?)\s*サマ/]),
    date:         dateStr,
    time:         extract(body, [/◆コース\s*\|\s*(\d{1,2}:\d{2})/]),
    people:       totalPeople || extract(body, [/(\d+)\s*名/]),
    peopleDetail: peopleDetail,
    amount:       extract(body, [/◆提示金額\s*\|\s*([0-9,]+円)/]),
    payment:      extract(body, [/◆支払い方法\s*\|\s*(.+)/]),
    email:        extract(body, [/メールアドレス\s*\|\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号\s*\|\s*([\d\-\+]+)/]),
    notes:        extract(body, [/ご質問・ご要望等.*?[\r\n]+＜内容＞[\r\n]+([^\r\n]+)/s]),
  };
}

// ============================================================
// アクティビティジャパン
// 氏名：重松　純平(シゲマツ　ジュンペイ)
// 日時：2026年02月21日
// プラン名（コース名）：...（14:00 ）
// 大人(中学生以上)×2 人
// 合計料金　　：14,000円
// 支払方法：PayPay（ペイペイ）
// ============================================================
function parseActivityJapan(subject, body) {
  const timeMatch    = body.match(/（(\d{1,2}:\d{2})\s*）/);
  const nameMatch    = body.match(/氏名[：:]\s*([^\(（\r\n]+?)(?:\s*[\(（]([^\)）]+)[\)）])?[\r\n]/);
  const peopleLines  = [...body.matchAll(/([^\n×x]+)[×x]\s*(\d+)\s*人/g)];
  const totalPeople  = peopleLines.reduce((s, m) => s + parseInt(m[2], 10), 0);
  const peopleDetail = peopleLines.length
    ? peopleLines.map(m => `${m[1].trim()}×${m[2]}名`).join('・')
    : '';

  return {
    site:         'アクティビティジャパン',
    bookingNo:    extract(body, [/予約番号[：:]\s*(\d+)/]),
    name:         nameMatch ? nameMatch[1].trim() : '',
    kana:         nameMatch && nameMatch[2] ? nameMatch[2].trim() : '',
    date:         extract(body, [/日時[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/]),
    time:         timeMatch ? timeMatch[1] : '',
    people:       totalPeople || '',
    peopleDetail: peopleDetail,
    amount:       extract(body, [/合計料金[\s　]*[：:]\s*([0-9,]+円)/]),
    payment:      extract(body, [/支払方法[：:]\s*(.+)/]),
    email:        extract(body, [/メール[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:        extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// ユーティリティ
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

    if (timeStr instanceof Date) {
      hour   = timeStr.getHours();
      minute = timeStr.getMinutes();
    } else {
      const timeNorm = String(timeStr).replace(/時/, ':').replace(/分/, '').trim();
      if (timeNorm.includes(':')) [hour, minute] = timeNorm.split(':').map(Number);
    }

    const date = new Date(year, month - 1, day, hour, minute);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) { return null; }
}

function loadExistingReservations(sheet) {
  const data        = sheet.getDataRange().getValues();
  const byBookingNo = new Map();
  const byMsgId     = new Set();

  for (let i = 1; i < data.length; i++) {
    const bookingNo = String(data[i][COLUMNS.BOOKING_NO - 1]).trim();
    const msgId     = String(data[i][COLUMNS.MESSAGE_ID - 1]).trim();
    if (bookingNo) byBookingNo.set(bookingNo, i + 1);
    if (msgId)     byMsgId.add(msgId);
  }
  return { byBookingNo, byMsgId };
}

function appendToSheet(sheet, r, msgId, subject) {
  const bookingType   = detectBookingType(subject);
  const initialStatus = bookingType === '確定' ? '承認済' : '未確認';

  sheet.appendRow([
    new Date(),
    subject,
    r.site         || '',
    bookingType,
    r.bookingNo    || '',
    r.name         || '',
    r.kana         || '',
    r.date         || '',
    r.time         || '',
    r.people       || '',
    r.peopleDetail || '',
    r.amount       || '',
    r.payment      || '',
    r.email        || '',
    r.phone        || '',
    r.notes        || '',
    initialStatus,
    '',
    msgId,
  ]);
}

function updateRow(sheet, rowNum, r, msgId, subject) {
  const bookingType   = detectBookingType(subject);
  const currentStatus = sheet.getRange(rowNum, COLUMNS.STATUS).getValue();
  const newStatus     = bookingType === '確定' && currentStatus !== 'カレンダー登録済'
    ? '承認済' : currentStatus;

  const updates = {
    [COLUMNS.TIMESTAMP]:     new Date(),
    [COLUMNS.SUBJECT]:       subject,
    [COLUMNS.BOOKING_TYPE]:  bookingType,
    [COLUMNS.STATUS]:        newStatus,
    [COLUMNS.MESSAGE_ID]:    msgId,
  };
  if (r.name)         updates[COLUMNS.NAME]          = r.name;
  if (r.kana)         updates[COLUMNS.KANA]          = r.kana;
  if (r.date)         updates[COLUMNS.DATE]          = r.date;
  if (r.time)         updates[COLUMNS.TIME]          = r.time;
  if (r.people)       updates[COLUMNS.PEOPLE]        = r.people;
  if (r.peopleDetail) updates[COLUMNS.PEOPLE_DETAIL] = r.peopleDetail;
  if (r.amount)       updates[COLUMNS.AMOUNT]        = r.amount;
  if (r.payment)      updates[COLUMNS.PAYMENT]       = r.payment;
  if (r.email)        updates[COLUMNS.EMAIL]         = r.email;
  if (r.phone)        updates[COLUMNS.PHONE]         = r.phone;

  Object.entries(updates).forEach(([col, val]) => {
    sheet.getRange(rowNum, Number(col)).setValue(val);
  });
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  const headers = [
    '処理日時', 'メール件名', '予約サイト', '予約タイプ', '予約番号',
    '予約者名', 'フリガナ', '予約日', '予約時間', '人数',
    '人数内訳', '金額', '支払方法', 'メールアドレス', '電話番号',
    '備考', 'ステータス', 'カレンダーイベントID', 'メッセージID',
  ];

  if (sheet.getRange(1, 1).getValue() !== '処理日時') {
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
// 手動テスト用
// ============================================================
function testParseLatestEmail() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (!threads.length) { Logger.log('対象メールが見つかりませんでした'); return; }
  const msg = threads[0].getMessages()[0];
  Logger.log('件名: '   + msg.getSubject());
  Logger.log('差出人: ' + msg.getFrom());
  Logger.log(JSON.stringify(parseEmail(msg), null, 2));
}
