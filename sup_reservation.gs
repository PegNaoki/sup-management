// ============================================================
// SUP予約メール自動処理スクリプト
// ============================================================
// 設定: 以下の定数をご自身の環境に合わせて変更してください
// ============================================================

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',   // スプレッドシートID（URLの /d/XXXX/edit の部分）
  SHEET_NAME: '予約一覧',
  CALENDAR_ID: 'YOUR_CALENDAR_ID',          // カレンダーID（カレンダー設定の「カレンダーID」）
  SEARCH_QUERY: 'subject:(じゃらんnet遊び・体験予約) OR subject:(アクティビティジャパン) OR subject:(アソビュー)',
  PROCESSED_LABEL: 'SUP予約/処理済',
  EVENT_DURATION_HOURS: 2,                  // カレンダーイベントの所要時間（時間）
};

// スプレッドシートの列定義
const COLUMNS = {
  TIMESTAMP:    1,  // A: 処理日時
  SUBJECT:      2,  // B: メール件名
  BOOKING_SITE: 3,  // C: 予約サイト
  NAME:         4,  // D: 予約者名
  DATE:         5,  // E: 予約日
  TIME:         6,  // F: 予約時間
  PEOPLE:       7,  // G: 人数
  EMAIL:        8,  // H: メールアドレス
  PHONE:        9,  // I: 電話番号
  NOTES:        10, // J: 備考
  STATUS:       11, // K: ステータス
  CALENDAR_ID_COL: 12, // L: カレンダーイベントID
  MESSAGE_ID:   13, // M: メッセージID（重複防止）
};

// ============================================================
// メイン処理：メール取込（トリガーで定期実行）
// ============================================================
function importReservationEmails() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const processedIds = getProcessedMessageIds(sheet);

  // 処理済みラベルを取得または作成
  const label = getOrCreateLabel(CONFIG.PROCESSED_LABEL);

  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 50);

  let newCount = 0;
  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (processedIds.has(msgId)) return;

      const reservation = parseEmail(message);
      if (!reservation) return;

      appendToSheet(sheet, reservation, msgId, message.getSubject());
      newCount++;
    });

    // スレッドに処理済みラベルを付与
    thread.addLabel(label);
  });

  if (newCount > 0) {
    SpreadsheetApp.flush();
    Logger.log(`${newCount}件の予約メールを取込みました`);
  }
}

// ============================================================
// メイン処理：カレンダー登録（トリガーで定期実行）
// ============================================================
function registerApprovedToCalendar() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);

  if (!calendar) {
    Logger.log('カレンダーが見つかりません。CALENDAR_IDを確認してください。');
    return;
  }

  const data = sheet.getDataRange().getValues();
  let updatedCount = 0;

  // 2行目（ヘッダー除く）からループ
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[COLUMNS.STATUS - 1];
    const calEventId = row[COLUMNS.CALENDAR_ID_COL - 1];

    if (status !== '承認済' || calEventId) continue;

    const dateStr = row[COLUMNS.DATE - 1];
    const timeStr = row[COLUMNS.TIME - 1];
    const name = row[COLUMNS.NAME - 1];
    const people = row[COLUMNS.PEOPLE - 1];
    const site = row[COLUMNS.BOOKING_SITE - 1];
    const notes = row[COLUMNS.NOTES - 1];

    const startDate = parseDateTime(dateStr, timeStr);
    if (!startDate) {
      Logger.log(`行${i + 1}: 日時のパースに失敗 - ${dateStr} ${timeStr}`);
      continue;
    }

    const endDate = new Date(startDate.getTime() + CONFIG.EVENT_DURATION_HOURS * 60 * 60 * 1000);

    const title = `【SUP予約】${name} ${people}名 (${site})`;
    const description = [
      `予約者: ${name}`,
      `人数: ${people}名`,
      `予約サイト: ${site}`,
      notes ? `備考: ${notes}` : '',
    ].filter(Boolean).join('\n');

    try {
      const event = calendar.createEvent(title, startDate, endDate, {
        description: description,
      });

      // ステータスとイベントIDを更新
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
// メール解析：予約サイト別にパターンを適用
// ============================================================
function parseEmail(message) {
  const subject = message.getSubject();
  const body = message.getPlainBody();
  const from = message.getFrom();

  // 各サイトの解析を試みる（優先順に並べる）
  const parsers = [
    parseAsoview,
    parseJalanAct,
    parseActivityJapan,
    parsePeatix,
    parseGeneric,
  ];

  for (const parser of parsers) {
    const result = parser(subject, body, from);
    if (result && result.name) return result;
  }

  return null;
}

// ------------------------------------------------------------
// アソビュー
// ------------------------------------------------------------
function parseAsoview(subject, body, from) {
  if (!from.includes('asoview') && !body.includes('アソビュー')) return null;

  return {
    site: 'アソビュー',
    name: extract(body, [
      /お名前[：:]\s*(.+)/,
      /予約者名[：:]\s*(.+)/,
      /氏名[：:]\s*(.+)/,
    ]),
    date: extract(body, [
      /体験日[：:]\s*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2})/,
      /ご利用日[：:]\s*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2})/,
    ]),
    time: extract(body, [
      /開始時間[：:]\s*(\d{1,2}:\d{2})/,
      /集合時間[：:]\s*(\d{1,2}:\d{2})/,
      /時間[：:]\s*(\d{1,2}:\d{2})/,
    ]),
    people: extract(body, [
      /人数[：:]\s*(\d+)\s*名/,
      /参加人数[：:]\s*(\d+)\s*名/,
      /(\d+)\s*名/,
    ]),
    email: extract(body, [/メールアドレス[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone: extract(body, [/電話番号[：:]\s*([\d\-\+\(\) ]+)/]),
    notes: extract(body, [/備考[：:]\s*(.+)/, /ご要望[：:]\s*(.+)/]),
  };
}

// ------------------------------------------------------------
// じゃらんnet アクティビティ
// ------------------------------------------------------------
function parseJalanAct(subject, body, from) {
  if (!from.includes('jalan') && !body.includes('じゃらん')) return null;

  return {
    site: 'じゃらんnet',
    name: extract(body, [
      /代表者名[：:]\s*(.+)/,
      /お名前[：:]\s*(.+)/,
    ]),
    date: extract(body, [
      /体験日[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/,
      /利用日[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/,
    ]),
    time: extract(body, [
      /開始時刻[：:]\s*(\d{1,2}時\d{2}分)/,
      /集合時間[：:]\s*(\d{1,2}:\d{2})/,
    ]),
    people: extract(body, [
      /合計人数[：:]\s*(\d+)\s*名/,
      /大人[：:]\s*(\d+)\s*名/,
    ]),
    email: extract(body, [/E?-?mail[：:]\s*([\w.\-]+@[\w.\-]+)/i]),
    phone: extract(body, [/電話[：:]\s*([\d\-]+)/]),
    notes: extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ------------------------------------------------------------
// アクティビティジャパン
// ------------------------------------------------------------
function parseActivityJapan(subject, body, from) {
  if (!from.includes('activity') && !body.includes('アクティビティジャパン')) return null;

  return {
    site: 'アクティビティジャパン',
    name: extract(body, [
      /参加者代表[：:]\s*(.+)/,
      /お名前[：:]\s*(.+)/,
      /氏名[：:]\s*(.+)/,
    ]),
    date: extract(body, [
      /参加日[：:]\s*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2})/,
      /体験日[：:]\s*(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2})/,
    ]),
    time: extract(body, [
      /参加時間[：:]\s*(\d{1,2}:\d{2})/,
      /開始時間[：:]\s*(\d{1,2}:\d{2})/,
    ]),
    people: extract(body, [
      /人数[：:]\s*(\d+)\s*名/,
      /参加人数[：:]\s*(\d+)/,
    ]),
    email: extract(body, [/メール[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone: extract(body, [/TEL[：:]\s*([\d\-]+)/i]),
    notes: extract(body, [/メモ[：:]\s*(.+)/, /備考[：:]\s*(.+)/]),
  };
}

// ------------------------------------------------------------
// Peatix
// ------------------------------------------------------------
function parsePeatix(subject, body, from) {
  if (!from.includes('peatix') && !body.includes('Peatix')) return null;

  return {
    site: 'Peatix',
    name: extract(body, [
      /お名前[：:]\s*(.+)/,
      /Name[：:]\s*(.+)/i,
    ]),
    date: extract(body, [
      /日時[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/,
      /(\d{4}年\d{1,2}月\d{1,2}日)/,
    ]),
    time: extract(body, [
      /(\d{1,2}:\d{2})/,
    ]),
    people: extract(body, [
      /(\d+)\s*枚/,
      /チケット数[：:]\s*(\d+)/,
    ]),
    email: extract(body, [/([\w.\-]+@[\w.\-]+)/]),
    phone: null,
    notes: null,
  };
}

// ------------------------------------------------------------
// 汎用パーサー（どのサイトにも該当しない場合）
// ------------------------------------------------------------
function parseGeneric(subject, body, from) {
  const result = {
    site: detectSiteFromEmail(from, body),
    name: extract(body, [
      /お名前[：:]\s*(.+)/,
      /予約者[：:]\s*(.+)/,
      /氏名[：:]\s*(.+)/,
      /代表者[：:]\s*(.+)/,
    ]),
    date: extract(body, [
      /(\d{4}年\d{1,2}月\d{1,2}日)/,
      /(\d{4}\/\d{1,2}\/\d{1,2})/,
      /(\d{4}-\d{2}-\d{2})/,
    ]),
    time: extract(body, [
      /(\d{1,2}:\d{2})/,
      /(\d{1,2}時\d{2}分)/,
    ]),
    people: extract(body, [
      /(\d+)\s*名/,
      /人数[：:]\s*(\d+)/,
    ]),
    email: extract(body, [/([\w.\-]+@[\w.\-]+)/]),
    phone: extract(body, [/(\d{2,4}[-\s]?\d{2,4}[-\s]?\d{4})/]),
    notes: extract(body, [/備考[：:]\s*(.+)/]),
  };

  return result;
}

// ============================================================
// ユーティリティ関数
// ============================================================

// 正規表現リストから最初にマッチした値を返す
function extract(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

// 差出人アドレス・本文からサイト名を推定
function detectSiteFromEmail(from, body) {
  const sources = [
    { keyword: 'asoview',           name: 'アソビュー' },
    { keyword: 'jalan',             name: 'じゃらんnet' },
    { keyword: 'activity-japan',    name: 'アクティビティジャパン' },
    { keyword: 'peatix',            name: 'Peatix' },
    { keyword: 'reserve1',          name: 'リザーブ1' },
    { keyword: 'toreta',            name: 'トレタ' },
  ];

  for (const s of sources) {
    if (from.toLowerCase().includes(s.keyword) || body.toLowerCase().includes(s.keyword)) {
      return s.name;
    }
  }
  return '不明';
}

// 日付文字列と時刻文字列をDateオブジェクトに変換
function parseDateTime(dateStr, timeStr) {
  try {
    // 日本語形式 → 数字に変換
    let normalized = String(dateStr)
      .replace(/年/, '/')
      .replace(/月/, '/')
      .replace(/日/, '')
      .replace(/-/g, '/');

    let timeNormalized = String(timeStr)
      .replace(/時/, ':')
      .replace(/分/, '')
      .trim();

    if (!timeNormalized.includes(':')) timeNormalized = '09:00';

    const parts = normalized.split('/');
    if (parts.length !== 3) return null;

    const [year, month, day] = parts.map(Number);
    const [hour, minute] = timeNormalized.split(':').map(Number);

    const date = new Date(year, month - 1, day, hour, minute || 0);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch (e) {
    return null;
  }
}

// シートにデータを追記
function appendToSheet(sheet, reservation, msgId, subject) {
  const now = new Date();
  sheet.appendRow([
    now,                        // A: 処理日時
    subject,                    // B: メール件名
    reservation.site || '',     // C: 予約サイト
    reservation.name || '',     // D: 予約者名
    reservation.date || '',     // E: 予約日
    reservation.time || '',     // F: 予約時間
    reservation.people || '',   // G: 人数
    reservation.email || '',    // H: メールアドレス
    reservation.phone || '',    // I: 電話番号
    reservation.notes || '',    // J: 備考
    '未確認',                    // K: ステータス（初期値）
    '',                         // L: カレンダーイベントID
    msgId,                      // M: メッセージID
  ]);
}

// 処理済みメッセージIDをSetで返す
function getProcessedMessageIds(sheet) {
  const data = sheet.getDataRange().getValues();
  const ids = new Set();
  for (let i = 1; i < data.length; i++) {
    const id = data[i][COLUMNS.MESSAGE_ID - 1];
    if (id) ids.add(String(id));
  }
  return ids;
}

// シートを取得または作成し、ヘッダーを設定
function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    const headers = [
      '処理日時', 'メール件名', '予約サイト', '予約者名',
      '予約日', '予約時間', '人数', 'メールアドレス',
      '電話番号', '備考', 'ステータス', 'カレンダーイベントID', 'メッセージID',
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);

    // ヘッダー行の書式
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#4a86e8')
      .setFontColor('#ffffff')
      .setFontWeight('bold');

    // ステータス列に入力規則（プルダウン）
    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未確認', '承認済', '却下', 'キャンセル', 'カレンダー登録済'])
      .build();
    sheet.getRange(2, COLUMNS.STATUS, 1000, 1).setDataValidation(statusRule);

    // M列（メッセージID）を非表示に
    sheet.hideColumns(COLUMNS.MESSAGE_ID);
  }
  return sheet;
}

// Gmailラベルを取得または作成
function getOrCreateLabel(labelName) {
  const parts = labelName.split('/');
  let label = null;
  let currentPath = '';

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    label = GmailApp.getUserLabelByName(currentPath);
    if (!label) {
      label = GmailApp.createLabel(currentPath);
    }
  }
  return label;
}

// ============================================================
// セットアップ：時間ベーストリガーを登録
// ============================================================
function setupTriggers() {
  // 既存のトリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // メール取込：30分ごと
  ScriptApp.newTrigger('importReservationEmails')
    .timeBased()
    .everyMinutes(30)
    .create();

  // カレンダー登録：1時間ごと
  ScriptApp.newTrigger('registerApprovedToCalendar')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('トリガーを設定しました');
}

// ============================================================
// 手動テスト用：最新メール1件だけ解析してログに表示
// ============================================================
function testParseLatestEmail() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (threads.length === 0) {
    Logger.log('対象メールが見つかりませんでした');
    return;
  }

  const message = threads[0].getMessages()[0];
  const result = parseEmail(message);
  Logger.log(JSON.stringify(result, null, 2));
}
