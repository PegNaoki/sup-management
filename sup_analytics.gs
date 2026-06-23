// ============================================================
// SUP予実管理・顧客分析システム
// ============================================================

const ANALYTICS_CONFIG = {
  SPREADSHEET_ID: '18rnnxbGmwsF9aKUBUdUJpPqABwJpVSwfoJwitkb7Q0M',

  SHEETS: {
    TARGET:       '【目標】',
    AJ_CSV:       '【AJ_CSV】',
    JALAN_CSV:    '【じゃらん_CSV】',
    ASOVIEW_CSV:  '【アソビュー_CSV】',
    DIRECT_CSV:   '【直接_CSV】',
    UNIFIED_DB:   '【統合DB】',
    ANNUAL_DASH:  '【年間ダッシュボード】',
    MONTHLY_DASH: '【月次ダッシュボード】',
    DAILY_DASH:   '【日次ダッシュボード】',
    CUSTOMER:     '【顧客分析】',
    WEEKLY_REPORT: '【週次レポート】',
  },

  // チャネル別手数料率（初期値 / 【目標】タブで上書き可）
  COMMISSION_RATES: {
    'AJ':        0.165,
    'じゃらん':   0.165,
    'アソビュー':  0.165,
    'satsuki':    0.03,
    'Web予約':    0.03,
    '直接':       0.00,
    'ライン':     0.00,
    'インスタ':   0.00,
    'その他':     0.00,
    'GO OUT':    0.00,
  },

  // 料金マスター
  PRICE_TIERS: { A: 7500, B: 6500, C: 5500 },
  PET_PRICE: 4500,

  // 地域設定
  HOME_PREF:     '福島県',
  TOHOKU_PREFS:  ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
};

// ============================================================
// 統合DBの列定義
// ============================================================
const DB = {
  UNIFIED_ID:        1,  // A
  CHANNEL:           2,  // B
  BOOKING_NO:        3,  // C
  GUEST_NAME:        4,  // D
  GUEST_KANA:        5,  // E
  ACTIVITY_DATE:     6,  // F
  ACTIVITY_TIME:     7,  // G
  BOOKING_DATE:      8,  // H
  STATUS:            9,  // I
  PAX_TOTAL:         10, // J
  PAX_ADULT:         11, // K
  PAX_CHILD:         12, // L
  PAX_PET:           13, // M
  REVENUE_GROSS:     14, // N 税込料金（お客様支払額）
  COMMISSION_RATE:   15, // O 手数料率
  COMMISSION_AMT:    16, // P 手数料額
  REVENUE_NET:       17, // Q 売上計上額
  PRICE_PER_PAX:     18, // R 1人あたり単価
  PRICE_TIER:        19, // S 単価ランク（A/B/C）
  LEAD_DAYS:         20, // T リードタイム（日）
  PREFECTURE:        21, // U 都道府県
  REGION_SEGMENT:    22, // V 地域区分
  GROUP_TYPE:        23, // W グループ属性
  HAS_PET:           24, // X 犬同伴
  PAYMENT_METHOD:    25, // Y 支払方法
  AGE:               26, // Z 年齢（取得できる場合のみ）
  GENDER:            27, // AA 性別（AJのみ）
  SURVEY_TRANSPORT:  28, // AB 交通手段（じゃらんのみ）
  SURVEY_REPEAT:     29, // AC リピート回数（じゃらんのみ）
  IMPORTED_AT:       30, // AD 取込日時
};

const DB_HEADERS = [
  '統合ID', 'チャネル', '予約番号', '予約者名', 'フリガナ',
  '参加日', '参加時間', '予約日', 'ステータス',
  '合計人数', '大人人数', '子供人数', 'ペット数',
  '税込料金', '手数料率', '手数料額', '売上計上額',
  '1人あたり単価', '単価ランク', 'リードタイム(日)',
  '都道府県', '地域区分', 'グループ属性', '犬同伴',
  '支払方法', '年齢', '性別', '交通手段', 'リピート回数(アンケート)',
  '取込日時',
];

// ============================================================
// メイン処理
// ============================================================
function normalizeAllCSV() {
  const ss = getAnalyticsSS();
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const commRates = loadCommissionRates(ss);
  const existing  = loadExistingUnifiedIds(dbSheet);

  const records = [
    ...parseAJ_CSV(ss),
    ...parseJalan_CSV(ss),
    ...parseAsoview_CSV(ss),
    ...parseDirect_CSV(ss),
  ];

  let addCount = 0, skipCount = 0;
  records.forEach(r => {
    if (existing.has(r.unifiedId)) { skipCount++; return; }
    enrichRecord(r, commRates);
    appendToUnifiedDB(dbSheet, r);
    existing.add(r.unifiedId);
    addCount++;
  });

  SpreadsheetApp.flush();
  Logger.log(`統合DB更新：追加${addCount}件、スキップ${skipCount}件`);

  updateAnnualDashboard(ss);
  updateMonthlyDashboard(ss);
  updateDailyDashboard(ss);
  updateCustomerAnalysis(ss);
}

// 手動再集計（全件洗い替え）
function rebuildAll() {
  const ss = getAnalyticsSS();
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);

  // ヘッダー行を残してデータをクリア
  const lastRow = dbSheet.getLastRow();
  if (lastRow > 1) dbSheet.getRange(2, 1, lastRow - 1, DB_HEADERS.length).clearContent();

  // 手数料率を再読込してフル再取込
  const commRates = loadCommissionRates(ss);
  const records = [
    ...parseAJ_CSV(ss),
    ...parseJalan_CSV(ss),
    ...parseAsoview_CSV(ss),
    ...parseDirect_CSV(ss),
  ];

  records.forEach(r => {
    enrichRecord(r, commRates);
    appendToUnifiedDB(dbSheet, r);
  });

  SpreadsheetApp.flush();
  Logger.log(`全件再構築：${records.length}件`);
  updateAnnualDashboard(ss);
  updateMonthlyDashboard(ss);
  updateDailyDashboard(ss);
  updateCustomerAnalysis(ss);
}

// ============================================================
// CSVパーサー：アクティビティジャパン（AJ）
// ============================================================
function parseAJ_CSV(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.AJ_CSV);
  if (!sheet) return [];

  const headerRow = findHeaderRow(sheet, '予約番号');
  if (!headerRow) return [];

  const data = sheet.getRange(headerRow + 1, 1, sheet.getLastRow() - headerRow, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = buildColMap(headers);

  return data
    .filter(row => row[col['予約番号']] && String(row[col['予約番号']]).trim())
    .map(row => {
      const bookingNo   = String(row[col['予約番号']]).trim();
      const activityDate = toDateOnly(row[col['実施日']]);
      const bookingDate  = toDateOnly(row[col['予約日時']]);
      const timeStr      = formatTime(row[col['コース名']]);
      const paxTotal     = toInt(row[col['人数']]);
      const paxPet       = detectPetFromPlanName(String(row[col['プラン名']] || ''));
      const paxAdult     = paxTotal - paxPet;
      const prefecture   = extractPrefecture(String(row[col['住所']] || row[col['都道府県']] || ''));

      return {
        unifiedId:       `AJ_${bookingNo}`,
        channel:         'AJ',
        bookingNo,
        guestName:       String(row[col['予約者名']] || '').trim(),
        guestKana:       String(row[col['予約者名(カナ)']] || '').trim(),
        activityDate,
        activityTime:    timeStr,
        bookingDate,
        status:          normalizeStatus(String(row[col['予約ステータス']] || ''), 'AJ'),
        paxTotal,
        paxAdult:        Math.max(0, paxAdult),
        paxChild:        0,
        paxPet,
        revenueGross:    toFloat(row[col['合計料金']]),
        paymentMethod:   String(row[col['支払い方法']] || '').trim(),
        prefecture,
        age:             toInt(row[col['催行日当日の年齢']]),
        gender:          String(row[col['性別']] || '').trim(),
        surveyTransport: '',
        surveyRepeat:    '',
      };
    });
}

// ============================================================
// CSVパーサー：じゃらんnet
// ============================================================
function parseJalan_CSV(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.JALAN_CSV);
  if (!sheet) return [];

  const headerRow = findHeaderRow(sheet, '予約番号');
  if (!headerRow) return [];

  const data    = sheet.getRange(headerRow + 1, 1, sheet.getLastRow() - headerRow, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);

  return data
    .filter(row => row[col['予約番号']] && String(row[col['予約番号']]).trim())
    .map(row => {
      const bookingNo    = String(row[col['予約番号']]).trim();
      const activityDate = toDateOnly(row[col['体験開始日']]);
      const bookingDate  = toDateOnly(row[col['予約受付日']]);
      const timeStr      = formatTime(row[col['体験開始時間']]);
      const statusRaw    = String(row[col['予約ステータス']] || '');

      // 人数：料金区分1〜10から集計
      let paxAdult = 0, paxChild = 0, paxPet = 0;
      for (let i = 1; i <= 10; i++) {
        const kubun  = String(row[col[`料金区分${i}`]] || '');
        const people = toInt(row[col[`参加人数${i}`]]);
        if (!kubun || !people) continue;
        if (/ペット|犬|ワン/i.test(kubun))          paxPet   += people;
        else if (/小人|子供|子ども|キッズ/i.test(kubun)) paxChild += people;
        else                                         paxAdult += people;
      }
      const paxTotal = paxAdult + paxChild + paxPet;

      // アンケート回答の解析
      const answer   = String(row[col['回答']] || '');
      const transport = extractTransport(answer);
      const repeat    = extractRepeat(answer);

      const prefecture = extractPrefecture(String(row[col['都道府県']] || row[col['住所']] || ''));

      return {
        unifiedId:       `じゃらん_${bookingNo}`,
        channel:         'じゃらん',
        bookingNo,
        guestName:       String(row[col['体験代表者（名前）']] || '').trim(),
        guestKana:       String(row[col['体験代表者（カナ）']] || '').trim(),
        activityDate,
        activityTime:    timeStr,
        bookingDate,
        status:          normalizeStatus(statusRaw, 'じゃらん'),
        paxTotal:        paxTotal || 1,
        paxAdult,
        paxChild,
        paxPet,
        revenueGross:    toFloat(row[col['税込料金合計']]),
        paymentMethod:   String(row[col['支払方法']] || '').trim(),
        prefecture,
        age:             0,
        gender:          '',
        surveyTransport: transport,
        surveyRepeat:    repeat,
      };
    });
}

// ============================================================
// CSVパーサー：アソビュー／Web予約（ウラカタ）
// ============================================================
function parseAsoview_CSV(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.ASOVIEW_CSV);
  if (!sheet) return [];

  const headerRow = findHeaderRow(sheet, '予約グループID');
  if (!headerRow) return [];

  const data    = sheet.getRange(headerRow + 1, 1, sheet.getLastRow() - headerRow, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);

  return data
    .filter(row => row[col['予約グループID']] && String(row[col['予約グループID']]).trim())
    .map(row => {
      const bookingNo    = String(row[col['予約ID']] || row[col['予約グループID']]).trim();
      const rawChannel   = String(row[col['媒体']] || 'Web予約').trim();
      const channel      = rawChannel === 'アソビュー' ? 'アソビュー' : 'Web予約';
      const activityDate = toDateOnly(row[col['参加日']]);
      const activityTime = extractTimeFromDateStr(String(row[col['参加日']] || ''));
      const bookingDate  = toDateOnly(row[col['申込日時']]);
      const statusRaw    = String(row[col['ステータス']] || '');

      // 人数・内訳を解析
      const paxTotal = toInt(row[col['合計']]) || toInt(row[col['合計人数']]);
      const detail   = String(row[col['内訳']] || '');
      const { paxAdult, paxChild, paxPet } = parsePaxDetail(detail, paxTotal);

      const prefecture = extractPrefecture(String(row[col['住所']] || ''));

      return {
        unifiedId:       `${channel}_${bookingNo}`,
        channel,
        bookingNo,
        guestName:       String(row[col['予約者名']] || '').trim(),
        guestKana:       String(row[col['予約者名カナ']] || '').trim(),
        activityDate,
        activityTime,
        bookingDate,
        status:          normalizeStatus(statusRaw, 'アソビュー'),
        paxTotal:        paxTotal || 1,
        paxAdult,
        paxChild,
        paxPet,
        revenueGross:    toFloat(row[col['合計金額']]),
        paymentMethod:   String(row[col['支払い方法']] || '').trim(),
        prefecture,
        age:             0,
        gender:          '',
        surveyTransport: '',
        surveyRepeat:    '',
      };
    });
}

// ============================================================
// CSVパーサー：直接（その他/ライン/インスタ/GO OUT/ベルトラ等）
// ※【直接_CSV】は専用ヘッダー付きの手入力フォーマット
//   列: ステータス, 担当者, 媒体, 参加年, 参加月, 参加日, 時間,
//       予約年, 予約月, 予約日, 代表者名(姓名), 代表者名(セイメイ),
//       合計人数, 大人人数, 子供人数, ペット数, 料金, 都道府県, 住所, 年齢, 電話番号
// ============================================================
function parseDirect_CSV(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.DIRECT_CSV);
  if (!sheet) return [];

  const headerRow = findHeaderRow(sheet, 'ステータス');
  if (!headerRow) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow <= headerRow) return [];

  const data    = sheet.getRange(headerRow + 1, 1, lastRow - headerRow, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);

  return data
    .filter(row => {
      // 名前・料金・参加年のいずれかがあれば有効行とみなす（団体予約で名前空欄でも拾う）
      const name = String(row[col['代表者名(姓名)']] || '').trim();
      const fee  = row[col['料金']];
      const y    = row[col['参加年']];
      return name || (fee !== '' && fee != null) || (y !== '' && y != null);
    })
    .map((row, idx) => {
      const guestName  = String(row[col['代表者名(姓名)']] || '').trim();
      const channel    = String(row[col['媒体']] || '直接').trim() || '直接';
      const actDate    = buildDateFromCols(row[col['参加年']], row[col['参加月']], row[col['参加日']]);
      const actTime    = formatTime(row[col['時間']]);
      const bookDate   = buildDateFromCols(row[col['予約年']], row[col['予約月']], row[col['予約日']]) || actDate;

      const paxTotal   = toInt(row[col['合計人数']]);
      const paxAdult   = toInt(row[col['大人人数']]);
      const paxChild   = toInt(row[col['子供人数']]);
      const paxPet     = toInt(row[col['ペット数']]);
      const prefecture = String(row[col['都道府県']] || '').trim();

      // 行番号(idx)を含めて一意化：同名・同日・同媒体の複数予約も別レコードとして保持
      const dateKey   = actDate ? actDate.toISOString().slice(0, 10) : 'nodate';
      const uniqueKey = `direct_${channel}_${guestName || 'noname'}_${dateKey}_${idx}`;

      return {
        unifiedId:       uniqueKey,
        channel,
        bookingNo:       '',
        guestName,
        guestKana:       String(row[col['代表者名(セイメイ)']] || '').trim(),
        activityDate:    actDate,
        activityTime:    actTime,
        bookingDate:     bookDate,
        status:          normalizeStatus(String(row[col['ステータス']] || ''), '直接'),
        paxTotal:        paxTotal || (paxAdult + paxChild + paxPet) || 1,
        paxAdult:        paxAdult || 0,
        paxChild:        paxChild || 0,
        paxPet:          paxPet || 0,
        revenueGross:    toFloat(row[col['料金']]),
        paymentMethod:   '直接',
        prefecture,
        age:             toInt(row[col['年齢']]),
        gender:          '',
        surveyTransport: '',
        surveyRepeat:    '',
      };
    });
}

// ============================================================
// レコードの派生項目を付与
// ============================================================
function enrichRecord(r, commRates) {
  const rate           = commRates[r.channel] ?? ANALYTICS_CONFIG.COMMISSION_RATES[r.channel] ?? 0;
  r.commissionRate     = rate;
  r.commissionAmt      = Math.round(r.revenueGross * rate);
  r.revenueNet         = r.revenueGross - r.commissionAmt;
  r.pricePerPax        = r.paxTotal > 0 ? Math.round(r.revenueGross / r.paxTotal) : 0;
  r.priceTier          = calcPriceTier(r.activityDate);
  r.leadDays           = calcLeadDays(r.bookingDate, r.activityDate);
  r.regionSegment      = classifyRegion(r.prefecture);
  r.groupType          = classifyGroup(r.paxTotal, r.paxChild, r.paxPet);
  r.hasPet             = r.paxPet > 0;
}

// ============================================================
// 統合DBへの書き込み
// ============================================================
function appendToUnifiedDB(sheet, r) {
  sheet.appendRow([
    r.unifiedId,
    r.channel,
    r.bookingNo,
    r.guestName,
    r.guestKana,
    r.activityDate    || '',
    r.activityTime    || '',
    r.bookingDate     || '',
    r.status,
    r.paxTotal,
    r.paxAdult,
    r.paxChild,
    r.paxPet,
    r.revenueGross,
    r.commissionRate,
    r.commissionAmt,
    r.revenueNet,
    r.pricePerPax,
    r.priceTier,
    r.leadDays,
    r.prefecture,
    r.regionSegment,
    r.groupType,
    r.hasPet ? '◯' : '',
    r.paymentMethod,
    r.age  || '',
    r.gender || '',
    r.surveyTransport || '',
    r.surveyRepeat    || '',
    new Date(),
  ]);
}

// ============================================================
// 年間ダッシュボード更新
// ============================================================
function updateAnnualDashboard(ss) {
  const dbSheet   = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const dashSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.ANNUAL_DASH);
  const tgtSheet  = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (!dashSheet) return;

  const dbData  = dbSheet.getDataRange().getValues();
  const targets = loadTargets(tgtSheet);

  // 年別・月別集計
  const annual  = {};  // { year: { bookings, pax, gross, commission, net } }
  const monthly = {};  // { 'YYYY-MM': { bookings, pax, gross, commission, net } }

  for (let i = 1; i < dbData.length; i++) {
    const row    = dbData[i];
    const status = row[DB.STATUS - 1];
    if (status === 'cancelled') continue;

    const dateVal = row[DB.ACTIVITY_DATE - 1];
    if (!dateVal) continue;
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) continue;

    const year = d.getFullYear();
    const ym   = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    const grossVal = Number(row[DB.REVENUE_GROSS - 1])   || 0;
    const comVal   = Number(row[DB.COMMISSION_AMT - 1])  || 0;
    const netVal   = Number(row[DB.REVENUE_NET - 1])     || 0;
    const paxVal   = Number(row[DB.PAX_TOTAL - 1])       || 0;

    if (!annual[year]) annual[year] = { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    annual[year].bookings++;
    annual[year].pax        += paxVal;
    annual[year].gross      += grossVal;
    annual[year].commission += comVal;
    annual[year].net        += netVal;

    if (!monthly[ym]) monthly[ym] = { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    monthly[ym].bookings++;
    monthly[ym].pax        += paxVal;
    monthly[ym].gross      += grossVal;
    monthly[ym].commission += comVal;
    monthly[ym].net        += netVal;
  }

  // 年間目標（月別目標を合算）
  const annualTargets = {};
  Object.entries(targets).forEach(([ym, t]) => {
    const year = ym.slice(0, 4);
    if (!annualTargets[year]) annualTargets[year] = { bookings: 0, pax: 0, revenue: 0 };
    annualTargets[year].bookings += t.bookings || 0;
    annualTargets[year].pax      += t.pax      || 0;
    annualTargets[year].revenue  += t.revenue  || 0;
  });

  dashSheet.clearContents();
  dashSheet.getCharts().forEach(c => dashSheet.removeChart(c));
  let row = 1;

  // ── セクション1：年度別KPI一覧 ──────────────────────────
  const secHeader = (title) => {
    dashSheet.getRange(row, 1, 1, 10).merge()
      .setValue(title).setFontWeight('bold').setFontSize(12)
      .setBackground('#434343').setFontColor('#ffffff');
    row++;
  };

  const writeHeader = (cols, bg) => {
    dashSheet.getRange(row, 1, 1, cols.length).setValues([cols])
      .setBackground(bg || '#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
    row++;
  };

  const sortedYears = Object.keys(annual).sort();
  const currentYear = String(new Date().getFullYear());

  secHeader('■ 年度別KPI');
  const kpiLabels = [
    'KPI', ...sortedYears.map(y => y + '年 実績'),
    currentYear + '年 目標', currentYear + '年 達成率'
  ];
  writeHeader(kpiLabels, '#4a86e8');

  const kpiDef = [
    { label: '① 予約数（組）',                  fmt: '#,##0',   get: a => a.bookings,   tgtKey: 'bookings' },
    { label: '② 1予約あたり人数（人）',          fmt: '0.00',    get: a => a.bookings > 0 ? a.pax / a.bookings : 0, tgtKey: null },
    { label: '③ 1予約あたり売上【税込】（円）',  fmt: '¥#,##0', get: a => a.bookings > 0 ? Math.round(a.gross / a.bookings) : 0, tgtKey: null },
    { label: '④ 1人あたり単価【税込】（円）',    fmt: '¥#,##0', get: a => a.pax > 0 ? Math.round(a.gross / a.pax) : 0, tgtKey: null },
    { label: '⑤ 売上【税込】（円）',            fmt: '¥#,##0', get: a => a.gross,      tgtKey: 'revenue' },
    { label: '⑤b 手取り・売上（手数料控除後）', fmt: '¥#,##0', get: a => a.net,        tgtKey: null },
    { label: '⑥ 平均手数料率（％）',            fmt: '0.00%',  get: a => a.gross > 0 ? a.commission / a.gross : 0, tgtKey: null },
    { label: '⑦ 粗利率（％）',                  fmt: '0.00%',  get: a => a.gross > 0 ? a.net / a.gross : 0, tgtKey: null },
  ];

  const tgtCurr = annualTargets[currentYear] || {};
  const actCurr = annual[currentYear] || { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };

  kpiDef.forEach((kpi, ki) => {
    const vals = sortedYears.map(y => kpi.get(annual[y]));
    let tgtVal = '';
    let achRate = '';
    if (kpi.tgtKey === 'bookings') tgtVal = tgtCurr.bookings || '';
    else if (kpi.tgtKey === 'revenue') tgtVal = tgtCurr.revenue || '';

    if (tgtVal && tgtVal > 0) {
      const actVal = kpi.get(actCurr);
      achRate = actVal / tgtVal;
    }

    const rowVals = [kpi.label, ...vals, tgtVal, achRate];
    const r = dashSheet.getRange(row, 1, 1, rowVals.length);
    r.setValues([rowVals]);

    // 各年の数値に書式適用
    sortedYears.forEach((_, ci) => {
      dashSheet.getRange(row, ci + 2).setNumberFormat(kpi.fmt);
    });
    if (tgtVal !== '') dashSheet.getRange(row, sortedYears.length + 2).setNumberFormat(kpi.fmt);
    if (achRate !== '') {
      const achCell = dashSheet.getRange(row, sortedYears.length + 3);
      achCell.setNumberFormat('0.0%');
      if (typeof achRate === 'number') {
        if (achRate >= 1.0)    achCell.setBackground('#b6d7a8');
        else if (achRate < 0.8) achCell.setBackground('#f4cccc');
        else                    achCell.setBackground('#fff2cc');
      }
    }
    // 交互行色
    if (ki % 2 === 1) dashSheet.getRange(row, 1, 1, rowVals.length).setBackground('#f8f9fa');
    row++;
  });
  row += 2;

  // ── セクション2：月別推移（当年） ────────────────────────
  secHeader(`■ ${currentYear}年 月別KPI推移`);

  const monthHeaders = ['月', '予約数', '人数', '売上【税込】', '手取り', '1予約あたり人数', '1人あたり単価【税込】', '平均手数料率', '粗利率', '目標_予約数', '目標_人数', '目標_売上', '達成率_売上'];
  writeHeader(monthHeaders, '#6aa84f');

  const monthlyChartStartRow = row;
  for (let m = 1; m <= 12; m++) {
    const ym  = `${currentYear}-${String(m).padStart(2, '0')}`;
    const md  = monthly[ym] || { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    const tgt = targets[ym] || {};

    const pap  = md.bookings > 0 ? (md.pax  / md.bookings).toFixed(2) : '';
    const upp  = md.pax      > 0 ? Math.round(md.gross / md.pax)      : '';
    const comR = md.gross    > 0 ? md.commission / md.gross            : '';
    const grR  = md.gross    > 0 ? md.net / md.gross                  : '';
    const achR = (tgt.revenue && tgt.revenue > 0) ? md.gross / tgt.revenue : '';

    const rowVals = [
      `${m}月`,
      md.bookings || '', md.pax || '', md.gross || '', md.net || '',
      pap, upp, comR, grR,
      tgt.bookings || '', tgt.pax || '', tgt.revenue || '', achR,
    ];
    dashSheet.getRange(row, 1, 1, rowVals.length).setValues([rowVals]);

    // 書式
    dashSheet.getRange(row, 4).setNumberFormat('#,##0'); // 売上税込
    dashSheet.getRange(row, 5).setNumberFormat('#,##0'); // 手取り
    dashSheet.getRange(row, 7).setNumberFormat('#,##0'); // 1人あたり単価
    dashSheet.getRange(row, 12).setNumberFormat('#,##0'); // 目標_売上
    dashSheet.getRange(row, 7).setNumberFormat('0.0%');
    dashSheet.getRange(row, 8).setNumberFormat('0.0%');
    if (achR !== '') {
      const achCell = dashSheet.getRange(row, 12);
      achCell.setNumberFormat('0.0%');
      if (typeof achR === 'number') {
        if (achR >= 1.0)    achCell.setBackground('#b6d7a8');
        else if (achR < 0.8) achCell.setBackground('#f4cccc');
        else                  achCell.setBackground('#fff2cc');
      }
    }
    row++;
  }

  // 合計行
  const annCurr = annual[currentYear] || { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
  const tgtCurrTotal = annualTargets[currentYear] || {};
  const totalAchR = (tgtCurrTotal.revenue > 0) ? annCurr.gross / tgtCurrTotal.revenue : '';
  const totalRow = [
    '合計/平均',
    annCurr.bookings || '', annCurr.pax || '', annCurr.gross || '', annCurr.net || '',
    annCurr.bookings > 0 ? (annCurr.pax / annCurr.bookings).toFixed(2) : '',
    annCurr.pax > 0 ? Math.round(annCurr.gross / annCurr.pax) : '',
    annCurr.gross > 0 ? annCurr.commission / annCurr.gross : '',
    annCurr.gross > 0 ? annCurr.net / annCurr.gross : '',
    tgtCurrTotal.bookings || '', tgtCurrTotal.pax || '', tgtCurrTotal.revenue || '',
    totalAchR,
  ];
  dashSheet.getRange(row, 1, 1, totalRow.length).setValues([totalRow])
    .setFontWeight('bold').setBackground('#e8f0fe');
  dashSheet.getRange(row, 4).setNumberFormat('#,##0');
  dashSheet.getRange(row, 5).setNumberFormat('#,##0');
  dashSheet.getRange(row, 7).setNumberFormat('#,##0');
  dashSheet.getRange(row, 12).setNumberFormat('#,##0');
  dashSheet.getRange(row, 8).setNumberFormat('0.0%');
  dashSheet.getRange(row, 9).setNumberFormat('0.0%');
  if (totalAchR !== '') dashSheet.getRange(row, 13).setNumberFormat('0.0%');
  row += 2;

  // ── セクション3：年度別推移グラフ ────────────────────────
  // 売上推移グラフ用データを右側の列（N列以降）に書き出し
  const chartCol = 14;
  const chartStartRow = row;
  secHeader('■ 年度別 売上・予約数推移（グラフ用）');
  dashSheet.getRange(row, chartCol, 1, 3)
    .setValues([['年', '売上(net)', '予約数']]).setFontWeight('bold').setBackground('#4a86e8').setFontColor('#ffffff');
  row++;
  const chartDataStart = row;
  sortedYears.forEach(y => {
    const a = annual[y];
    dashSheet.getRange(row, chartCol, 1, 3).setValues([[y + '年', a.net, a.bookings]]);
    dashSheet.getRange(row, chartCol + 1).setNumberFormat('#,##0');
    row++;
  });
  const chartDataEnd = row - 1;

  SpreadsheetApp.flush();

  // 年別売上グラフ
  if (chartDataEnd >= chartDataStart) {
    try {
      const chart = dashSheet.newChart()
        .setChartType(Charts.ChartType.COLUMN)
        .addRange(dashSheet.getRange(chartDataStart - 1, chartCol, chartDataEnd - chartDataStart + 2, 2))
        .setOption('title', '年度別 売上推移')
        .setOption('width', 480).setOption('height', 280)
        .setPosition(chartStartRow, 1, 0, 0).build();
      dashSheet.insertChart(chart);
    } catch(e) { Logger.log('年次売上グラフエラー: ' + e); }

    // 月別売上・目標グラフ（当年）
    try {
      const chart2 = dashSheet.newChart()
        .setChartType(Charts.ChartType.LINE)
        .addRange(dashSheet.getRange(monthlyChartStartRow, 1, 12, 1))
        .addRange(dashSheet.getRange(monthlyChartStartRow, 4, 12, 1))
        .addRange(dashSheet.getRange(monthlyChartStartRow, 11, 12, 1))
        .setOption('title', `${currentYear}年 月別売上 vs 目標`)
        .setOption('width', 480).setOption('height', 280)
        .setPosition(monthlyChartStartRow, 14, 0, 0).build();
      dashSheet.insertChart(chart2);
    } catch(e) { Logger.log('月次売上グラフエラー: ' + e); }
  }

  dashSheet.setFrozenRows(0);
  Logger.log('年間ダッシュボード更新完了');
}

// ============================================================
// 月次ダッシュボード更新
// ============================================================
function updateMonthlyDashboard(ss) {
  const dbSheet   = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const dashSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.MONTHLY_DASH);
  const tgtSheet  = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (!dashSheet) return;

  const dbData  = dbSheet.getDataRange().getValues();
  const targets = loadTargets(tgtSheet);

  // 年月ごとに集計
  const monthly = {};
  for (let i = 1; i < dbData.length; i++) {
    const row    = dbData[i];
    const status = row[DB.STATUS - 1];
    if (status === 'cancelled') continue;

    const dateVal = row[DB.ACTIVITY_DATE - 1];
    if (!dateVal) continue;
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) continue;

    const ym  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const ch  = row[DB.CHANNEL - 1];
    if (!monthly[ym]) monthly[ym] = { bookings: 0, pax: 0, gross: 0, commissionAmt: 0, net: 0, channels: {} };

    monthly[ym].bookings++;
    monthly[ym].pax          += Number(row[DB.PAX_TOTAL - 1])      || 0;
    monthly[ym].gross        += Number(row[DB.REVENUE_GROSS - 1])  || 0;
    monthly[ym].commissionAmt += Number(row[DB.COMMISSION_AMT - 1]) || 0;
    monthly[ym].net          += Number(row[DB.REVENUE_NET - 1])    || 0;
    if (!monthly[ym].channels[ch]) monthly[ym].channels[ch] = { bookings: 0, gross: 0 };
    monthly[ym].channels[ch].bookings++;
    monthly[ym].channels[ch].gross += Number(row[DB.REVENUE_GROSS - 1]) || 0;
  }

  // ダッシュボードシートに書き出し
  const rows = [
    [
      '年月',
      '実績_予約数', '実績_人数', '実績_売上【税込】', '実績_手取り',
      '目標_予約数', '目標_人数', '目標_売上',
      '達成率_予約数', '達成率_人数', '達成率_売上',
      '1予約あたり人数', '1人あたり単価【税込】',
      '手数料額', '手数料率',
      'AJ_件数', 'AJ_売上',
      'じゃらん_件数', 'じゃらん_売上',
      'アソビュー_件数', 'アソビュー_売上',
      'Web予約_件数', 'Web予約_売上',
      '直接_件数', '直接_売上',
    ],
  ];

  const sortedYMs = Object.keys(monthly).sort();
  sortedYMs.forEach(ym => {
    const m   = monthly[ym];
    const tgt = targets[ym] || {};
    const ch  = m.channels;

    const paxPerBooking = m.bookings > 0 ? (m.pax / m.bookings).toFixed(2) : '';
    const pricePerPax   = m.pax      > 0 ? Math.round(m.gross / m.pax)     : '';
    const commRate      = m.gross    > 0 ? (m.commissionAmt / m.gross)      : '';

    // 直接・その他系（主要OTA以外すべて：直接/ライン/インスタ/その他/GO OUT/ベルトラ等）
    const MAJOR = ['AJ', 'じゃらん', 'アソビュー', 'Web予約'];
    let directBookings = 0, directGross = 0;
    Object.entries(ch).forEach(([name, v]) => {
      if (MAJOR.includes(name)) return;
      directBookings += v.bookings;
      directGross    += v.gross;
    });

    rows.push([
      ym,
      m.bookings, m.pax, m.gross, m.net,
      tgt.bookings || '', tgt.pax || '', tgt.revenue || '',
      tgt.bookings ? (m.bookings / tgt.bookings) : '',
      tgt.pax      ? (m.pax      / tgt.pax     ) : '',
      tgt.revenue  ? (m.gross    / tgt.revenue ) : '',
      paxPerBooking, pricePerPax,
      m.commissionAmt, commRate,
      (ch['AJ']        || {}).bookings || 0, (ch['AJ']        || {}).gross || 0,
      (ch['じゃらん']   || {}).bookings || 0, (ch['じゃらん']   || {}).gross || 0,
      (ch['アソビュー'] || {}).bookings || 0, (ch['アソビュー'] || {}).gross || 0,
      (ch['Web予約']    || {}).bookings || 0, (ch['Web予約']    || {}).gross || 0,
      directBookings, directGross,
    ]);
  });

  dashSheet.clearContents();
  dashSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  dashSheet.getRange(1, 1, 1, rows[0].length)
    .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
  dashSheet.setFrozenRows(1);

  // 書式設定（列: A=1,B=2...）
  // ヘッダー: 年月(1),実績_予約数(2),実績_人数(3),実績_売上税込(4),実績_手取り(5),
  //           目標_予約数(6),目標_人数(7),目標_売上(8),
  //           達成率_予約数(9),達成率_人数(10),達成率_売上(11),
  //           1予約あたり人数(12),1人あたり単価(13),手数料額(14),手数料率(15),
  //           チャネル別(16〜25)
  if (rows.length > 1) {
    const dataRows = rows.length - 1;
    // 達成率列（I,J,K = 9,10,11）パーセント
    dashSheet.getRange(2, 9, dataRows, 3).setNumberFormat('0.0%');
    // 手数料率列（O=15）パーセント
    dashSheet.getRange(2, 15, dataRows, 1).setNumberFormat('0.0%');
    // 売上・手取り系列は整数カンマ区切り
    [4, 5, 8, 13, 14, 17, 19, 21, 23, 25].forEach(c =>
      dashSheet.getRange(2, c, dataRows, 1).setNumberFormat('#,##0')
    );
    // 手取り列（E=5）は薄いオレンジ背景で参考値であることを示す
    dashSheet.getRange(1, 5).setBackground('#fce5cd').setFontColor('#ffffff');
    dashSheet.getRange(2, 5, dataRows, 1).setBackground('#fff8f3');
    // 達成率に色付け（100%以上=緑、80〜99%=黄、80%未満=赤）
    for (let r = 2; r <= rows.length; r++) {
      [9, 10, 11].forEach(c => {
        const cell = dashSheet.getRange(r, c);
        const v = cell.getValue();
        if (typeof v !== 'number' || v === 0) return;
        if (v >= 1.0)    cell.setBackground('#b6d7a8');
        else if (v < 0.8) cell.setBackground('#f4cccc');
        else              cell.setBackground('#fff2cc');
      });
    }
  }

  Logger.log('月次ダッシュボード更新完了');
}

// ============================================================
// 日次ダッシュボード更新
// ============================================================
function updateDailyDashboard(ss) {
  const dbSheet   = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const dashSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.DAILY_DASH);
  if (!dashSheet) return;

  const dbData = dbSheet.getDataRange().getValues();

  // 日別集計
  const daily = {};
  for (let i = 1; i < dbData.length; i++) {
    const row    = dbData[i];
    const status = row[DB.STATUS - 1];
    if (status === 'cancelled') continue;

    const dateVal = row[DB.ACTIVITY_DATE - 1];
    if (!dateVal) continue;
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) continue;

    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dow     = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    const ch      = row[DB.CHANNEL - 1];

    if (!daily[dateKey]) {
      daily[dateKey] = { date: d, dow, bookings: 0, pax: 0, revenue: 0, pets: 0, channels: {} };
    }
    daily[dateKey].bookings++;
    daily[dateKey].pax     += Number(row[DB.PAX_TOTAL - 1])   || 0;
    daily[dateKey].revenue += Number(row[DB.REVENUE_NET - 1]) || 0;
    daily[dateKey].pets    += Number(row[DB.PAX_PET - 1])     || 0;
    if (!daily[dateKey].channels[ch]) daily[dateKey].channels[ch] = 0;
    daily[dateKey].channels[ch]++;
  }

  const headers = [
    '参加日', '曜日', '予約件数', '参加人数', '売上(net)',
    '1予約あたり人数', '1人あたり単価',
    'ペット同伴数',
    'AJ', 'じゃらん', 'アソビュー', 'Web予約', '直接・その他',
  ];

  const rows = [headers];
  Object.keys(daily).sort().forEach(dk => {
    const m   = daily[dk];
    const ch  = m.channels;
    const pap = m.bookings > 0 ? (m.pax / m.bookings).toFixed(1) : '';
    const upp = m.pax      > 0 ? Math.round(m.revenue / m.pax)   : '';
    const direct = (ch['直接'] || 0) + (ch['ライン'] || 0) + (ch['インスタ'] || 0) + (ch['GO OUT'] || 0);
    rows.push([
      m.date, m.dow,
      m.bookings, m.pax, m.revenue,
      pap, upp, m.pets,
      ch['AJ']        || 0,
      ch['じゃらん']   || 0,
      ch['アソビュー'] || 0,
      ch['Web予約']    || 0,
      direct,
    ]);
  });

  dashSheet.clearContents();
  dashSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  // 書式設定
  dashSheet.getRange(1, 1, 1, headers.length)
    .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
  dashSheet.setFrozenRows(1);
  if (rows.length > 1) {
    const dr = rows.length - 1;
    dashSheet.getRange(2, 1, dr, 1).setNumberFormat('yyyy/MM/dd');
    dashSheet.getRange(2, 5, dr, 1).setNumberFormat('#,##0');
    dashSheet.getRange(2, 7, dr, 1).setNumberFormat('#,##0');
    // 土日に色付け
    for (let r = 2; r <= rows.length; r++) {
      const dow = dashSheet.getRange(r, 2).getValue();
      if (dow === '土') dashSheet.getRange(r, 1, 1, headers.length).setBackground('#dae8fc');
      if (dow === '日') dashSheet.getRange(r, 1, 1, headers.length).setBackground('#ffe6e6');
    }
  }

  Logger.log('日次ダッシュボード更新完了');
}

// ============================================================
// 顧客分析シート更新
// ============================================================
function updateCustomerAnalysis(ss) {
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const sheet   = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.CUSTOMER);
  if (!sheet) return;

  const dbData = dbSheet.getDataRange().getValues();

  // キャンセル除外
  const active = dbData.slice(1).filter(r => r[DB.STATUS - 1] !== 'cancelled');

  sheet.clearContents();
  let writeRow = 1;

  // --- 1. 月別×都道府県 ---
  const sectionTitle1 = [['■ 月別×都道府県 来客数']];
  sheet.getRange(writeRow, 1, 1, 1).setValues(sectionTitle1)
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const prefByMonth = {};
  active.forEach(r => {
    const dateVal = r[DB.ACTIVITY_DATE - 1];
    if (!dateVal) return;
    const d  = dateVal instanceof Date ? dateVal : new Date(dateVal);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const pf = r[DB.PREFECTURE - 1] || '不明';
    if (!prefByMonth[ym]) prefByMonth[ym] = {};
    prefByMonth[ym][pf] = (prefByMonth[ym][pf] || 0) + 1;
  });

  const allPrefs  = [...new Set(active.map(r => r[DB.PREFECTURE - 1] || '不明'))].sort();
  const allYMs    = Object.keys(prefByMonth).sort();
  sheet.getRange(writeRow, 1, 1, allPrefs.length + 1)
    .setValues([['年月', ...allPrefs]])
    .setFontWeight('bold');
  writeRow++;
  allYMs.forEach(ym => {
    const row = [ym, ...allPrefs.map(pf => prefByMonth[ym][pf] || 0)];
    sheet.getRange(writeRow, 1, 1, row.length).setValues([row]);
    writeRow++;
  });
  writeRow += 2;

  // --- 2. リードタイム分布 ---
  sheet.getRange(writeRow, 1, 1, 1).setValues([['■ リードタイム分布（予約〜参加日数）']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const leadBuckets = { '当日〜3日': 0, '4〜7日': 0, '8〜14日': 0, '15〜30日': 0, '31〜60日': 0, '61日〜': 0 };
  active.forEach(r => {
    const lead = Number(r[DB.LEAD_DAYS - 1]);
    if (isNaN(lead) || lead < 0) return;
    if      (lead <= 3)  leadBuckets['当日〜3日']++;
    else if (lead <= 7)  leadBuckets['4〜7日']++;
    else if (lead <= 14) leadBuckets['8〜14日']++;
    else if (lead <= 30) leadBuckets['15〜30日']++;
    else if (lead <= 60) leadBuckets['31〜60日']++;
    else                 leadBuckets['61日〜']++;
  });

  sheet.getRange(writeRow, 1, 1, 2).setValues([['区分', '件数']]).setFontWeight('bold');
  writeRow++;
  Object.entries(leadBuckets).forEach(([k, v]) => {
    sheet.getRange(writeRow, 1, 1, 2).setValues([[k, v]]);
    writeRow++;
  });
  writeRow += 2;

  // --- 3. グループ属性別 ---
  sheet.getRange(writeRow, 1, 1, 1).setValues([['■ グループ属性別 集計']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const groupStats = {};
  active.forEach(r => {
    const g   = r[DB.GROUP_TYPE - 1] || '不明';
    const rev = Number(r[DB.REVENUE_NET - 1]) || 0;
    const pax = Number(r[DB.PAX_TOTAL - 1])   || 0;
    if (!groupStats[g]) groupStats[g] = { count: 0, revenue: 0, pax: 0 };
    groupStats[g].count++;
    groupStats[g].revenue += rev;
    groupStats[g].pax     += pax;
  });

  sheet.getRange(writeRow, 1, 1, 4).setValues([['グループ属性', '件数', '売上合計', '平均人数']]).setFontWeight('bold');
  writeRow++;
  Object.entries(groupStats).sort((a, b) => b[1].count - a[1].count).forEach(([k, v]) => {
    sheet.getRange(writeRow, 1, 1, 4).setValues([[k, v.count, v.revenue, v.count > 0 ? (v.pax / v.count).toFixed(1) : 0]]);
    writeRow++;
  });
  writeRow += 2;

  // --- 4. チャネル別KPI ---
  sheet.getRange(writeRow, 1, 1, 1).setValues([['■ チャネル別KPI']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const channelStats = {};
  active.forEach(r => {
    const ch  = r[DB.CHANNEL - 1] || '不明';
    const rev = Number(r[DB.REVENUE_NET - 1])   || 0;
    const pax = Number(r[DB.PAX_TOTAL - 1])     || 0;
    const com = Number(r[DB.COMMISSION_AMT - 1]) || 0;
    if (!channelStats[ch]) channelStats[ch] = { count: 0, revenue: 0, pax: 0, commission: 0 };
    channelStats[ch].count++;
    channelStats[ch].revenue    += rev;
    channelStats[ch].pax        += pax;
    channelStats[ch].commission += com;
  });

  sheet.getRange(writeRow, 1, 1, 6)
    .setValues([['チャネル', '件数', '売上合計', '1予約あたり売上', '1人あたり単価', '手数料率']])
    .setFontWeight('bold');
  writeRow++;
  Object.entries(channelStats).sort((a, b) => b[1].revenue - a[1].revenue).forEach(([ch, v]) => {
    const gross = v.revenue + v.commission;
    sheet.getRange(writeRow, 1, 1, 6).setValues([[
      ch, v.count, v.revenue,
      v.count > 0 ? Math.round(v.revenue / v.count) : 0,
      v.pax   > 0 ? Math.round(v.revenue / v.pax)   : 0,
      gross   > 0 ? (v.commission / gross) : 0,
    ]]);
    writeRow++;
  });
  writeRow += 2;

  // --- 5. 地域区分別 月別推移 ---
  sheet.getRange(writeRow, 1, 1, 1).setValues([['■ 地域区分別 月別来客数']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const regions   = ['地元', '近隣', '遠方', '不明'];
  const regionYMs = {};
  active.forEach(r => {
    const dateVal = r[DB.ACTIVITY_DATE - 1];
    if (!dateVal) return;
    const d  = dateVal instanceof Date ? dateVal : new Date(dateVal);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const rg = r[DB.REGION_SEGMENT - 1] || '不明';
    if (!regionYMs[ym]) regionYMs[ym] = {};
    regionYMs[ym][rg] = (regionYMs[ym][rg] || 0) + 1;
  });

  sheet.getRange(writeRow, 1, 1, regions.length + 1)
    .setValues([['年月', ...regions]]).setFontWeight('bold');
  writeRow++;
  Object.keys(regionYMs).sort().forEach(ym => {
    sheet.getRange(writeRow, 1, 1, regions.length + 1)
      .setValues([[ym, ...regions.map(rg => regionYMs[ym][rg] || 0)]]);
    writeRow++;
  });
  writeRow += 2;

  // --- 6. 年齢分布（AJ・直接のみ）---
  sheet.getRange(writeRow, 1, 1, 1).setValues([['■ 年齢分布（AJ・直接のみ）']])
    .setFontWeight('bold').setBackground('#cfe2f3');
  writeRow++;

  const ageBuckets = { '〜19歳': 0, '20代': 0, '30代': 0, '40代': 0, '50代': 0, '60代〜': 0 };
  active.forEach(r => {
    const age = Number(r[DB.AGE - 1]);
    if (!age || isNaN(age)) return;
    if      (age < 20) ageBuckets['〜19歳']++;
    else if (age < 30) ageBuckets['20代']++;
    else if (age < 40) ageBuckets['30代']++;
    else if (age < 50) ageBuckets['40代']++;
    else if (age < 60) ageBuckets['50代']++;
    else               ageBuckets['60代〜']++;
  });

  sheet.getRange(writeRow, 1, 1, 2).setValues([['年代', '件数']]).setFontWeight('bold');
  writeRow++;
  Object.entries(ageBuckets).forEach(([k, v]) => {
    sheet.getRange(writeRow, 1, 1, 2).setValues([[k, v]]);
    writeRow++;
  });

  // グラフを追加（既存グラフを一旦削除）
  sheet.getCharts().forEach(c => sheet.removeChart(c));
  addCustomerCharts_(sheet, writeRow);

  Logger.log('顧客分析シート更新完了');
}

// 顧客分析シートにグラフを追加
function addCustomerCharts_(sheet, lastDataRow) {
  // データの位置を再スキャンしてグラフ用の範囲を特定
  const data = sheet.getRange(1, 1, lastDataRow, 6).getValues();

  let leadStart = -1, leadEnd = -1;
  let groupStart = -1, groupEnd = -1;
  let channelStart = -1, channelEnd = -1;

  for (let i = 0; i < data.length; i++) {
    const v = String(data[i][0]);
    if (v === '■ リードタイム分布（予約〜参加日数）') leadStart = i + 2; // ヘッダー行の次
    if (v === '■ グループ属性別 集計')               groupStart = i + 2;
    if (v === '■ チャネル別KPI')                     channelStart = i + 2;
    // 各セクションの終端（次のセクションタイトル or 空行2つ）
    if (leadStart > 0 && leadEnd < 0 && i > leadStart && (v.startsWith('■') || (v === '' && String(data[i+1] ? data[i+1][0] : '') === '')))
      leadEnd = i;
    if (groupStart > 0 && groupEnd < 0 && i > groupStart && (v.startsWith('■') || (v === '' && String(data[i+1] ? data[i+1][0] : '') === '')))
      groupEnd = i;
    if (channelStart > 0 && channelEnd < 0 && i > channelStart && (v.startsWith('■') || (v === '' && String(data[i+1] ? data[i+1][0] : '') === '')))
      channelEnd = i;
  }
  if (leadEnd < 0)    leadEnd    = lastDataRow;
  if (groupEnd < 0)   groupEnd   = lastDataRow;
  if (channelEnd < 0) channelEnd = lastDataRow;

  const addChart = (dataRange, type, title, anchorRow, anchorCol) => {
    try {
      const chart = sheet.newChart()
        .setChartType(type)
        .addRange(dataRange)
        .setOption('title', title)
        .setOption('legend', { position: 'right' })
        .setOption('width', 480)
        .setOption('height', 300)
        .setPosition(anchorRow, anchorCol, 0, 0)
        .build();
      sheet.insertChart(chart);
    } catch(e) {
      Logger.log('グラフ追加エラー: ' + e.message);
    }
  };

  // リードタイム分布：棒グラフ（列E付近に配置）
  if (leadStart > 0 && leadEnd > leadStart) {
    addChart(
      sheet.getRange(leadStart, 1, leadEnd - leadStart, 2),
      Charts.ChartType.BAR,
      'リードタイム分布',
      leadStart, 4
    );
  }

  // グループ属性別：円グラフ
  if (groupStart > 0 && groupEnd > groupStart) {
    addChart(
      sheet.getRange(groupStart, 1, groupEnd - groupStart, 2),
      Charts.ChartType.PIE,
      'グループ属性別 件数',
      groupStart, 4
    );
  }

  // チャネル別KPI：棒グラフ（件数と売上）
  if (channelStart > 0 && channelEnd > channelStart) {
    addChart(
      sheet.getRange(channelStart, 1, channelEnd - channelStart, 3),
      Charts.ChartType.COLUMN,
      'チャネル別 件数・売上',
      channelStart, 4
    );
  }
}

// ============================================================
// セットアップ：全シートを作成
// ============================================================
function setupAnalyticsSheets() {
  const ss = getAnalyticsSS();

  // 各シートを作成（なければ）
  Object.values(ANALYTICS_CONFIG.SHEETS).forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  // 【目標】シートのヘッダー
  const tgtSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (tgtSheet.getRange(1, 1).getValue() !== '年月') {
    const tgtHeaders = [
      '年月', '目標_予約数', '目標_人数', '目標_売上',
      '手数料率_AJ', '手数料率_じゃらん', '手数料率_アソビュー', '手数料率_satsuki', '手数料率_Web予約',
      '手数料率_直接', '手数料率_ライン', '手数料率_インスタ',
    ];
    tgtSheet.getRange(1, 1, 1, tgtHeaders.length).setValues([tgtHeaders])
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
    tgtSheet.setFrozenRows(1);

    // 手数料率の初期値を入力
    const rateNote = [
      ['（例）2025-05', '', '', '',
       ANALYTICS_CONFIG.COMMISSION_RATES['AJ'],
       ANALYTICS_CONFIG.COMMISSION_RATES['じゃらん'],
       ANALYTICS_CONFIG.COMMISSION_RATES['アソビュー'],
       ANALYTICS_CONFIG.COMMISSION_RATES['satsuki'],
       ANALYTICS_CONFIG.COMMISSION_RATES['Web予約'],
       ANALYTICS_CONFIG.COMMISSION_RATES['直接'],
       ANALYTICS_CONFIG.COMMISSION_RATES['ライン'],
       ANALYTICS_CONFIG.COMMISSION_RATES['インスタ'],
      ],
    ];
    tgtSheet.getRange(2, 1, 1, rateNote[0].length).setValues(rateNote);
  }

  // 【統合DB】シートのヘッダー
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  if (dbSheet.getRange(1, 1).getValue() !== '統合ID') {
    dbSheet.getRange(1, 1, 1, DB_HEADERS.length).setValues([DB_HEADERS])
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
    dbSheet.setFrozenRows(1);
    dbSheet.setFrozenColumns(3);
  }

  // CSVタブの案内文（OTAは管理画面DLのCSVを貼る）
  [
    [ANALYTICS_CONFIG.SHEETS.AJ_CSV,      'アクティビティジャパン管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
    [ANALYTICS_CONFIG.SHEETS.JALAN_CSV,   'じゃらんnet管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
    [ANALYTICS_CONFIG.SHEETS.ASOVIEW_CSV, 'アソビュー/ウラカタ管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
  ].forEach(([sheetName, note]) => {
    const s = ss.getSheetByName(sheetName);
    if (s && !s.getRange(1, 1).getValue()) {
      s.getRange(1, 1).setValue(note).setFontStyle('italic').setFontColor('#888888');
    }
  });

  // 【直接_CSV】はヘッダー付き・入力規則ありの手入力フォーマットを整備
  setupDirectInputSheet();

  // 過去目標値を自動シード
  seedHistoricalTargets();

  Logger.log('セットアップ完了。SPREADSHEET_IDを設定してnormalizeAllCSV()を実行してください。');
}

// ============================================================
// 【直接_CSV】タブを手入力フォーマット（ヘッダー＋入力規則）に整備
// ============================================================
const DIRECT_HEADERS = [
  'ステータス', '担当者', '媒体',
  '参加年', '参加月', '参加日', '時間',
  '予約年', '予約月', '予約日',
  '代表者名(姓名)', '代表者名(セイメイ)',
  '合計人数', '大人人数', '子供人数', 'ペット数',
  '料金', '都道府県', '住所', '年齢', '電話番号',
];

function setupDirectInputSheet() {
  const ss = getAnalyticsSS();
  let sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.DIRECT_CSV);
  if (!sheet) sheet = ss.insertSheet(ANALYTICS_CONFIG.SHEETS.DIRECT_CSV);

  const first = String(sheet.getRange(1, 1).getValue()).trim();

  // 1行目が既にヘッダーでなければヘッダーを設置
  if (first !== 'ステータス') {
    // 既存にデータ・案内文がある場合は上に1行挿入して保護
    if (first !== '') sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, DIRECT_HEADERS.length).setValues([DIRECT_HEADERS])
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
  }
  sheet.setFrozenRows(1);

  // 入力規則（プルダウン）を設定
  const maxRows = Math.max(sheet.getMaxRows() - 1, 500);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['参加済', '予約確定', 'キャンセル'], true)
    .setAllowInvalid(false).build();
  sheet.getRange(2, 1, maxRows, 1).setDataValidation(statusRule); // A列 ステータス

  const staffRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['石山', '小川', '熊田'], true)
    .setAllowInvalid(true).build();
  sheet.getRange(2, 2, maxRows, 1).setDataValidation(staffRule);  // B列 担当者

  const mediaRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['その他', 'ライン', 'インスタ', 'GO OUT', 'ベルトラ', '直接'], true)
    .setAllowInvalid(true).build();
  sheet.getRange(2, 3, maxRows, 1).setDataValidation(mediaRule);  // C列 媒体

  // 数値列のチェック（参加年〜料金、年齢）
  const numberRule = SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0)
    .setAllowInvalid(true).build();
  [4, 5, 6, 8, 9, 10, 13, 14, 15, 16, 17, 20].forEach(c =>
    sheet.getRange(2, c, maxRows, 1).setDataValidation(numberRule)
  );

  Logger.log('【直接_CSV】整備完了（ヘッダー＋入力規則）');
}

// ============================================================
// Step 2: 週次スナップショット
//   毎週の実績を構造化データ(JSON)にまとめる。
//   これがClaude APIに渡す分析材料になる。
// ============================================================
function buildWeeklySnapshot(refDate) {
  const ss      = getAnalyticsSS();
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const tgtSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  const dbData  = dbSheet.getDataRange().getValues();
  const targets = loadTargets(tgtSheet);

  const today = refDate ? new Date(refDate) : new Date();

  // 集計対象週：先週の月曜〜日曜（レポートは週明けに先週分を振り返る想定）
  const thisMonday = getMonday(today);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1);
  const prevMonday = new Date(lastMonday); prevMonday.setDate(lastMonday.getDate() - 7);
  const prevSunday = new Date(lastMonday); prevSunday.setDate(lastMonday.getDate() - 1);

  const year      = today.getFullYear();
  const month     = today.getMonth() + 1;
  const curYM     = `${year}-${String(month).padStart(2, '0')}`;

  // 集計バケツ
  const blank = () => ({ bookings: 0, pax: 0, gross: 0, net: 0, commission: 0, channels: {} });
  const acc = (b, row) => {
    const g = Number(row[DB.REVENUE_GROSS - 1]) || 0;
    const n = Number(row[DB.REVENUE_NET - 1])   || 0;
    const c = Number(row[DB.COMMISSION_AMT - 1])|| 0;
    const p = Number(row[DB.PAX_TOTAL - 1])     || 0;
    const ch = row[DB.CHANNEL - 1] || '不明';
    b.bookings++; b.pax += p; b.gross += g; b.net += n; b.commission += c;
    if (!b.channels[ch]) b.channels[ch] = { bookings: 0, gross: 0 };
    b.channels[ch].bookings++; b.channels[ch].gross += g;
  };

  const lastWeek = blank();   // 先週実施分
  const prevWeek = blank();   // 前々週実施分（前週比用）
  const monthTD  = blank();   // 今月累計（今月実施分）
  const yearTD   = blank();   // 今年累計（今年実施分）
  const lastYearTD = blank(); // 前年同月までの累計（同月比較用）
  let upcomingBookings = 0, upcomingPax = 0, upcomingGross = 0; // 今後の予約（先の参加日でキャンセル以外）

  for (let i = 1; i < dbData.length; i++) {
    const row = dbData[i];
    if (row[DB.STATUS - 1] === 'cancelled') continue;
    const dv = row[DB.ACTIVITY_DATE - 1];
    if (!dv) continue;
    const d = dv instanceof Date ? dv : new Date(dv);
    if (isNaN(d.getTime())) continue;

    if (d >= lastMonday && d <= lastSunday) acc(lastWeek, row);
    if (d >= prevMonday && d <= prevSunday) acc(prevWeek, row);
    if (d.getFullYear() === year && d.getMonth() + 1 === month) acc(monthTD, row);
    if (d.getFullYear() === year) acc(yearTD, row);
    if (d.getFullYear() === year - 1 && (d.getMonth() + 1) <= month) acc(lastYearTD, row);
    if (d > today) { upcomingBookings++; upcomingPax += Number(row[DB.PAX_TOTAL-1])||0; upcomingGross += Number(row[DB.REVENUE_GROSS-1])||0; }
  }

  // 月目標・年目標
  const monthTgt = targets[curYM] || { bookings: 0, pax: 0, revenue: 0 };
  let yearTgt = { bookings: 0, pax: 0, revenue: 0 };
  Object.entries(targets).forEach(([ym, t]) => {
    if (ym.slice(0, 4) === String(year)) {
      yearTgt.bookings += t.bookings || 0;
      yearTgt.pax      += t.pax      || 0;
      yearTgt.revenue  += t.revenue  || 0;
    }
  });
  // 当月までの累計目標（年内・当月以前の月のみ）
  let ytdTgt = { bookings: 0, pax: 0, revenue: 0 };
  Object.entries(targets).forEach(([ym, t]) => {
    if (ym.slice(0, 4) === String(year) && Number(ym.slice(5, 7)) <= month) {
      ytdTgt.bookings += t.bookings || 0;
      ytdTgt.pax      += t.pax      || 0;
      ytdTgt.revenue  += t.revenue  || 0;
    }
  });

  const pct = (a, b) => (b > 0 ? a / b : null);
  const wow = (a, b) => (b > 0 ? (a - b) / b : null);

  const fmtChannels = (b) => Object.entries(b.channels)
    .sort((x, y) => y[1].gross - x[1].gross)
    .map(([name, v]) => ({ channel: name, bookings: v.bookings, gross: v.gross }));

  // 自動アラート検知
  const alerts = [];
  const ytdRevRate = pct(yearTD.gross, ytdTgt.revenue);
  if (ytdRevRate !== null && ytdRevRate < 0.8)
    alerts.push(`年累計売上が当月累計目標の${Math.round(ytdRevRate*100)}%（80%未満）`);
  const monthRevRate = pct(monthTD.gross, monthTgt.revenue);
  if (monthRevRate !== null && monthRevRate < 0.8)
    alerts.push(`今月売上が月目標の${Math.round(monthRevRate*100)}%（80%未満）`);
  const wowGross = wow(lastWeek.gross, prevWeek.gross);
  if (wowGross !== null && wowGross < -0.2)
    alerts.push(`先週売上が前週比${Math.round(wowGross*100)}%（2割超の減少）`);
  if (lastWeek.bookings === 0)
    alerts.push('先週の参加実績が0件');

  // 曜日構成：今月と前年同月の土日日数（天候・集客力の文脈分析用）
  const countWeekends = (y, m) => {
    let cnt = 0;
    const days = new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) cnt++;
    }
    return cnt;
  };
  const daysInMonth = new Date(year, month, 0).getDate();
  const weekendThisMonth  = countWeekends(year,     month);
  const weekendLastYear   = countWeekends(year - 1, month);

  const snapshot = {
    generatedAt: today.toISOString(),
    period: {
      reportWeek: `${fmtDate(lastMonday)}〜${fmtDate(lastSunday)}`,
      year, month, currentYM: curYM,
    },
    lastWeek: {
      bookings: lastWeek.bookings, pax: lastWeek.pax,
      gross: lastWeek.gross, net: lastWeek.net,
      unitGross: lastWeek.bookings > 0 ? Math.round(lastWeek.gross / lastWeek.bookings) : null,
      channels: fmtChannels(lastWeek),
    },
    weekOverWeek: {
      prevWeekGross: prevWeek.gross,
      grossChangePct: wowGross,
      bookingsChange: lastWeek.bookings - prevWeek.bookings,
    },
    monthToDate: {
      bookings: monthTD.bookings, pax: monthTD.pax, gross: monthTD.gross, net: monthTD.net,
      unitGross: monthTD.bookings > 0 ? Math.round(monthTD.gross / monthTD.bookings) : null,
      unitPax:   monthTD.bookings > 0 ? Math.round(monthTD.pax   / monthTD.bookings * 10) / 10 : null,
      target: monthTgt,
      achievement: {
        bookings: pct(monthTD.bookings, monthTgt.bookings),
        pax:      pct(monthTD.pax,      monthTgt.pax),
        revenue:  pct(monthTD.gross,    monthTgt.revenue),
      },
      channels: fmtChannels(monthTD),
    },
    yearToDate: {
      bookings: yearTD.bookings, pax: yearTD.pax, gross: yearTD.gross, net: yearTD.net,
      unitGross: yearTD.bookings > 0 ? Math.round(yearTD.gross / yearTD.bookings) : null,
      commissionRate: yearTD.gross > 0 ? yearTD.commission / yearTD.gross : null,
      grossMarginRate: yearTD.gross > 0 ? yearTD.net / yearTD.gross : null,
      ytdTarget: ytdTgt,
      annualTarget: yearTgt,
      ytdAchievement: {
        bookings: pct(yearTD.bookings, ytdTgt.bookings),
        pax:      pct(yearTD.pax,      ytdTgt.pax),
        revenue:  pct(yearTD.gross,    ytdTgt.revenue),
      },
      annualAchievement: {
        bookings: pct(yearTD.bookings, yearTgt.bookings),
        revenue:  pct(yearTD.gross,    yearTgt.revenue),
      },
    },
    lastYearComparison: {
      lastYearYtdGross: lastYearTD.gross,
      lastYearYtdBookings: lastYearTD.bookings,
      lastYearUnitGross: lastYearTD.bookings > 0 ? Math.round(lastYearTD.gross / lastYearTD.bookings) : null,
      yoyGrossChangePct: wow(yearTD.gross, lastYearTD.gross),
      yoyBookingsChangePct: wow(yearTD.bookings, lastYearTD.bookings),
      yoyUnitGrossChangePct: (yearTD.bookings > 0 && lastYearTD.bookings > 0)
        ? wow(yearTD.gross / yearTD.bookings, lastYearTD.gross / lastYearTD.bookings) : null,
    },
    upcoming: {
      bookings: upcomingBookings, pax: upcomingPax, gross: upcomingGross,
    },
    weekdayProfile: {
      month: { totalDays: daysInMonth, weekendDays: weekendThisMonth, weekdays: daysInMonth - weekendThisMonth },
      lastYearSameMonth: { weekendDays: weekendLastYear, weekdays: new Date(year-1, month, 0).getDate() - weekendLastYear },
      weekendDaysDiff: weekendThisMonth - weekendLastYear,
    },
    alerts,
  };

  return snapshot;
}

// 週次スナップショットをログに整形出力（動作確認用）
function debugWeeklySnapshot() {
  const snap = buildWeeklySnapshot();
  Logger.log(JSON.stringify(snap, null, 2));
}

// 指定日(月曜)を返す
function getMonday(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay(); // 0=日
  const diff = (day === 0 ? -6 : 1 - day);
  date.setDate(date.getDate() + diff);
  return date;
}

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ============================================================
// Step 3: Claude APIによる週次レポート自動生成
// ============================================================

// メイン：週次レポートを生成して記録＆通知
function generateWeeklyReport() {
  const snapshot   = buildWeeklySnapshot();
  const prompt     = buildAnalysisPrompt(snapshot);
  const analysis   = callClaudeAPI(prompt);
  const docUrl     = createWeeklyReportDoc(snapshot, analysis);

  writeWeeklyReport(snapshot, analysis, docUrl);

  // LINEにサマリー通知
  try {
    const ytd = snapshot.yearToDate;
    const ach = ytd.ytdAchievement.revenue;
    const achStr = ach !== null ? `${Math.round(ach * 100)}%` : '-';
    const lineMsg = [
      `📊【SUP週次レポート】${snapshot.period.reportWeek}`,
      `年累計売上: ¥${ytd.gross.toLocaleString()} (目標比 ${achStr})`,
      `先行予約: ${snapshot.upcoming.bookings}件 / ¥${snapshot.upcoming.gross.toLocaleString()}`,
      '',
      '📄 詳細レポート:',
      docUrl,
    ].join('\n');
    sendLineMessage_(lineMsg);
  } catch (e) {
    Logger.log('LINE通知スキップ: ' + e);
  }

  Logger.log(`週次レポート生成完了: ${docUrl}`);
  return docUrl;
}

// Claude API呼び出し
function callClaudeAPI(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY が未設定です（スクリプトプロパティに登録してください）');

  const requestOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  };

  const maxRetries = 4;
  const retryDelays = [2000, 4000, 8000, 16000];
  const retryableCodes = [429, 529];

  let lastCode, lastBody;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', requestOptions);
    lastCode = res.getResponseCode();
    lastBody = res.getContentText();

    if (lastCode === 200) {
      return JSON.parse(lastBody).content[0].text;
    }

    if (retryableCodes.indexOf(lastCode) !== -1 && attempt < maxRetries) {
      Logger.log(`Claude API ${lastCode} — ${attempt + 1}回目リトライ (${retryDelays[attempt] / 1000}秒後)`);
      Utilities.sleep(retryDelays[attempt]);
      continue;
    }

    break;
  }

  throw new Error(`Claude APIエラー (${lastCode}): ${lastBody}`);
}

// 分析プロンプトの組み立て
function buildAnalysisPrompt(snapshot) {
  const wp = snapshot.weekdayProfile;
  const weekendNote = wp
    ? `今月の土日日数: ${wp.month.weekendDays}日（前年同月: ${wp.lastYearSameMonth.weekendDays}日、差: ${wp.weekendDaysDiff > 0 ? '+' : ''}${wp.weekendDaysDiff}日）`
    : '';

  return [
    'あなたはSUP（スタンドアップパドルボード）体験事業の経営アナリストです。',
    '以下の週次データを分析し、経営者向けの日本語レポートを作成してください。',
    '',
    '# 事業概要',
    '- 福島県の屋外SUP体験事業（裏磐梯）',
    '- 営業期間：5〜10月のみ（冬季はオフシーズン）',
    '- 予約経路：OTA（じゃらん／AJ／アソビュー、手数料16.5%）、自社HP予約satsuki（手数料3%）、直接予約（LINE／インスタ／その他、手数料0%）',
    '- 「売上」は税込（お客様支払額）、「手取り」は手数料控除後',
    weekendNote,
    '',
    '# 今週時点のデータ（JSON）',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
    '',
    '# 注意事項（必ず守ること）',
    '- 数値の引用はJSONの値をそのまま使い、自分で計算しないこと（計算誤りを防ぐため）',
    '- 客単価はunitGrossフィールドの値を使うこと',
    '- 前年比はyoyGrossChangePct・yoyBookingsChangePct・yoyUnitGrossChangePctフィールドを使うこと',
    '- シーズンの段階（初期5-6月／最盛期7-8月／終盤9-10月）を踏まえた評価をすること',
    '- upcoming（今後の確定予約）も踏まえて先行きを評価すること',
    '',
    '# 出力フォーマット（Markdown、このセクション2つだけ出力）',
    '## 🔍 差異の原因仮説',
    '（目標・前年との差が生じている要因を、曜日構成・チャネル変化・単価・人数の観点から2〜3点。数値を具体的に引用）',
    '',
    '## ✅ 具体的アクション提案',
    '優先順位をつけて以下の2グループに分けて記述：',
    '### 来週中に実行できること',
    '（価格変更、SNS投稿、OTA露出強化など、今すぐできる施策を2〜3つ。なぜ効くかも一言）',
    '### 今月残りで挽回できる施策',
    '（残り期間での売上回復・チャネル改善策を1〜2つ）',
  ].join('\n');
}

// Google Docsに週次レポートを作成してURLを返す
function createWeeklyReportDoc(snapshot, analysisText) {
  const title = `SUP週次レポート ${snapshot.period.year}年${snapshot.period.month}月 (${snapshot.period.reportWeek})`;
  const doc  = DocumentApp.create(title);
  const body = doc.getBody();

  // ドライブで「リンクを知っている全員が閲覧可」に設定
  try {
    DriveApp.getFileById(doc.getId())
      .setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('Drive共有設定スキップ: ' + e);
  }

  const mtd  = snapshot.monthToDate;
  const ytd  = snapshot.yearToDate;
  const lyc  = snapshot.lastYearComparison;
  const up   = snapshot.upcoming;
  const tgt  = mtd.target;
  const ach  = mtd.achievement;
  const ytdA = ytd.ytdAchievement;

  const pctStr  = (v) => v !== null && v !== undefined ? `${Math.round(v * 100)}%` : '-';
  const yen     = (v) => v != null ? `¥${Math.round(v).toLocaleString()}` : '-';
  const num     = (v) => v != null ? String(v) : '-';

  // ===== タイトル =====
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`生成日: ${Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy年MM月dd日 HH:mm')}`);

  // ===== 現状把握 =====
  body.appendParagraph('📊 現状把握').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // 今月 目標 vs 実績
  body.appendParagraph(`今月実績 vs 目標 (${snapshot.period.year}年${snapshot.period.month}月)`)
    .setHeading(DocumentApp.ParagraphHeading.HEADING3);
  _styleTable(body.appendTable([
    ['指標', '目標', '実績', '達成率'],
    ['予約数', num(tgt.bookings) + '件', mtd.bookings + '件', pctStr(ach.bookings)],
    ['人数',   num(tgt.pax)      + '人', mtd.pax      + '人', pctStr(ach.pax)],
    ['売上',   yen(tgt.revenue),          yen(mtd.gross),      pctStr(ach.revenue)],
    ['手取り', '-',                        yen(mtd.net),        '-'],
    ['客単価', '-',                        yen(mtd.unitGross),  '-'],
  ]));

  // 前年同月比
  body.appendParagraph('前年同月比 (累計)').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  _styleTable(body.appendTable([
    ['指標', '前年同期', '今年同期', '増減率'],
    ['予約数', num(lyc.lastYearYtdBookings) + '件', num(ytd.bookings) + '件', pctStr(lyc.yoyBookingsChangePct)],
    ['売上',   yen(lyc.lastYearYtdGross),            yen(ytd.gross),            pctStr(lyc.yoyGrossChangePct)],
    ['客単価', yen(lyc.lastYearUnitGross),            yen(ytd.unitGross),        pctStr(lyc.yoyUnitGrossChangePct)],
  ]));

  // 年累計 目標達成率
  body.appendParagraph('年累計 目標達成率').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  _styleTable(body.appendTable([
    ['指標', '累計目標', '実績', '達成率', '年間目標', '年間達成率'],
    ['予約数', num(ytd.ytdTarget.bookings) + '件', num(ytd.bookings) + '件', pctStr(ytdA.bookings),
              num(ytd.annualTarget.bookings) + '件', pctStr(ytd.annualAchievement.bookings)],
    ['売上',   yen(ytd.ytdTarget.revenue),           yen(ytd.gross),           pctStr(ytdA.revenue),
              yen(ytd.annualTarget.revenue),           pctStr(ytd.annualAchievement.revenue)],
  ]));

  // チャネル別貢献度
  body.appendParagraph('チャネル別貢献度 (今月)').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  if (mtd.channels && mtd.channels.length > 0) {
    const chRows = [['チャネル', '件数', '売上', '構成比']];
    mtd.channels.forEach(ch => {
      const share = mtd.gross > 0 ? Math.round(ch.gross / mtd.gross * 100) : 0;
      chRows.push([ch.channel, ch.bookings + '件', yen(ch.gross), share + '%']);
    });
    _styleTable(body.appendTable(chRows));
  } else {
    body.appendParagraph('（今月実績なし）');
  }

  // 先行予約
  body.appendParagraph('先行予約（今後の確定済み）').setHeading(DocumentApp.ParagraphHeading.HEADING3);
  _styleTable(body.appendTable([
    ['予約件数', '人数', '売上見込み'],
    [up.bookings + '件', up.pax + '人', yen(up.gross)],
  ]));

  // アラート
  if (snapshot.alerts && snapshot.alerts.length > 0) {
    body.appendParagraph('⚠️ アラート').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    snapshot.alerts.forEach(a => body.appendListItem(a));
  }

  // ===== Claude分析テキスト =====
  // Markdownをパースしてドキュメントに挿入
  const lines = analysisText.split('\n');
  for (const line of lines) {
    if (line.startsWith('## ')) {
      body.appendParagraph(line.slice(3)).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    } else if (line.startsWith('### ')) {
      body.appendParagraph(line.slice(4)).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    } else if (/^(\d+\.|-)/.test(line.trim())) {
      body.appendListItem(line.replace(/^(\d+\.|-)[\s*]+/, '').replace(/\*\*/g, ''));
    } else if (line.trim() !== '') {
      body.appendParagraph(line.replace(/\*\*/g, ''));
    }
  }

  doc.saveAndClose();
  return `https://docs.google.com/document/d/${doc.getId()}/edit`;
}

// テーブルのヘッダー行をスタイリング
function _styleTable(table) {
  const header = table.getRow(0);
  for (let c = 0; c < header.getNumCells(); c++) {
    const cell = header.getCell(c);
    cell.setBackgroundColor('#4a86e8');
    cell.editAsText().setForegroundColor('#ffffff').setBold(true);
  }
  return table;
}

// 【週次レポート】シートに記録
function writeWeeklyReport(snapshot, analysisText, docUrl) {
  const ss = getAnalyticsSS();
  let sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.WEEKLY_REPORT);
  if (!sheet) sheet = ss.insertSheet(ANALYTICS_CONFIG.SHEETS.WEEKLY_REPORT);

  if (sheet.getRange(1, 1).getValue() !== '生成日時') {
    sheet.getRange(1, 1, 1, 6).setValues([['生成日時', '対象週', '年累計達成率', 'Docリンク', 'AI分析テキスト', 'スナップショットJSON']])
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(4, 250);
    sheet.setColumnWidth(5, 500);
  }

  const ytdRate = snapshot.yearToDate.ytdAchievement.revenue;
  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, 6).setValues([[
    new Date(),
    snapshot.period.reportWeek,
    ytdRate !== null ? `${Math.round(ytdRate * 100)}%` : '-',
    docUrl || '',
    analysisText,
    JSON.stringify(snapshot),
  ]]);
  sheet.getRange(2, 5).setWrap(true).setVerticalAlignment('top');

  // DocリンクをHYPERLINKで表示
  if (docUrl) {
    sheet.getRange(2, 4).setFormula(`=HYPERLINK("${docUrl}","📄 レポートを開く")`);
  }
}

// LINE Push通知（このプロジェクト内で完結）
function sendLineMessage_(message) {
  const token  = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN');
  const userId = PropertiesService.getScriptProperties().getProperty('LINE_USER_ID');
  if (!token || !userId) {
    Logger.log('LINE_CHANNEL_TOKEN または LINE_USER_ID が未設定');
    return;
  }
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ to: userId, messages: [{ type: 'text', text: message }] }),
    muteHttpExceptions: true,
  });
}

// 週次トリガーを設定（毎週月曜 8:00）
function setupWeeklyReportTrigger() {
  // 既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'generateWeeklyReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('generateWeeklyReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
  Logger.log('週次レポートトリガー設定完了（毎週月曜8:00）');
}

// ============================================================
// ユーティリティ
// ============================================================

function getAnalyticsSS() {
  return ANALYTICS_CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(ANALYTICS_CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

// ヘッダー行を探す（指定キーワードを含む行番号を返す）
function findHeaderRow(sheet, keyword) {
  const data = sheet.getRange(1, 1, Math.min(10, sheet.getLastRow()), sheet.getLastColumn()).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i].some(v => String(v).trim() === keyword)) return i + 1;
  }
  return null;
}

// 列名→インデックスのマップを作成
function buildColMap(headers) {
  const map = {};
  headers.forEach((h, i) => { if (h) map[String(h).trim()] = i; });
  return map;
}

// 統合DB上の既存IDセットを読み込む
function loadExistingUnifiedIds(dbSheet) {
  const lastRow = dbSheet.getLastRow();
  if (lastRow < 2) return new Set();
  const ids = dbSheet.getRange(2, DB.UNIFIED_ID, lastRow - 1, 1).getValues().flat();
  return new Set(ids.map(String).filter(Boolean));
}

// 【目標】シートから手数料率を読み込む
function loadCommissionRates(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (!sheet) return {};
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const col     = buildColMap(headers);
  const rates   = { ...ANALYTICS_CONFIG.COMMISSION_RATES };

  // 手数料率列が設定されていれば上書き（最初の非空行を使用）
  const channelKeys = ['AJ', 'じゃらん', 'アソビュー', 'satsuki', 'Web予約', '直接', 'ライン', 'インスタ'];
  channelKeys.forEach(ch => {
    const colKey = `手数料率_${ch}`;
    if (col[colKey] !== undefined) {
      for (let i = 1; i < data.length; i++) {
        const v = data[i][col[colKey]];
        if (v !== '' && v !== null && !isNaN(Number(v))) {
          rates[ch] = Number(v);
          break;
        }
      }
    }
  });
  return rates;
}

// 【目標】シートから月別目標を読み込む
function loadTargets(sheet) {
  if (!sheet) return {};
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const col     = buildColMap(headers);
  const targets = {};
  for (let i = 1; i < data.length; i++) {
    const raw = data[i][col['年月']];
    if (!raw) continue;

    // 日付オブジェクト・文字列どちらでも "YYYY-MM" 形式に統一
    let ym;
    if (raw instanceof Date) {
      ym = `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}`;
    } else {
      ym = String(raw).trim();
    }
    if (!ym || ym.startsWith('（')) continue;

    targets[ym] = {
      bookings: Number(data[i][col['目標_予約数']]) || 0,
      pax:      Number(data[i][col['目標_人数']])   || 0,
      revenue:  Number(data[i][col['目標_売上']])   || 0,
    };
  }
  return targets;
}

// 日付→Dateオブジェクト（時刻ゼロ）
function toDateOnly(val) {
  if (!val) return null;
  if (val instanceof Date) return new Date(val.getFullYear(), val.getMonth(), val.getDate());
  const s = String(val).replace(/年/, '/').replace(/月/, '/').replace(/日/, '').trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// 時刻表示文字列に変換
function formatTime(val) {
  if (!val) return '';
  if (val instanceof Date) return `${val.getHours()}:${String(val.getMinutes()).padStart(2, '0')}`;
  const s = String(val).trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : s;
}

// アソビューの参加日文字列から時刻を抽出（例: "2025/9/21（日） 09:00"）
function extractTimeFromDateStr(s) {
  const m = s.match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : '';
}

// 直接入力の年月日列からDateを生成
function buildDateFromCols(year, month, day) {
  const y = Number(year), mo = Number(month), d = Number(day);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}

function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? 0 : n;
}

function toFloat(val) {
  const n = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// 住所・都道府県列から都道府県を抽出
function extractPrefecture(s) {
  if (!s) return '';
  const m = s.match(/([^\s〒\d]{2,4}[都道府県])/);
  return m ? m[1] : s.trim().slice(0, 4);
}

// プラン名からペット同伴を判定（AJ用）
function detectPetFromPlanName(planName) {
  return /犬|ペット|ワン|dog/i.test(planName) ? 0 : 0; // 人数内訳が取れないため0とし内訳列で補完
}

// アソビューの内訳文字列を解析
function parsePaxDetail(detail, totalFallback) {
  let paxAdult = 0, paxChild = 0, paxPet = 0;
  const matches = [...detail.matchAll(/([^\n×x]+)[×x]\s*(\d+)/g)];
  matches.forEach(m => {
    const label = m[1].trim();
    const count = parseInt(m[2], 10);
    if (/ペット|犬|ワン|dog/i.test(label))              paxPet   += count;
    else if (/小人|子供|子ども|キッズ|6〜12|小学/i.test(label)) paxChild += count;
    else                                                paxAdult += count;
  });
  if (paxAdult + paxChild + paxPet === 0) paxAdult = totalFallback || 1;
  return { paxAdult, paxChild, paxPet };
}

// じゃらんアンケート回答から交通手段を抽出
function extractTransport(answer) {
  const m = answer.match(/①([^\s②]+)/);
  return m ? m[1].trim() : '';
}

// じゃらんアンケート回答からリピート回数を抽出
function extractRepeat(answer) {
  const m = answer.match(/②([^\s③\n]+)/);
  return m ? m[1].trim() : '';
}

// ステータスを正規化
function normalizeStatus(raw, source) {
  const s = raw.trim();
  if (/キャンセル|取消/i.test(s))        return 'cancelled';
  if (/来店済み|参加済|入場済/i.test(s))  return 'completed';
  if (/予約確定|確認中/i.test(s))        return 'confirmed';
  if (/参加済/i.test(s))               return 'completed';
  if (source === '直接' && /参加済/.test(s)) return 'completed';
  return 'confirmed';
}

// 単価ランク判定（参加日の月・曜日から）
function calcPriceTier(dateVal) {
  if (!dateVal) return '';
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return '';
  const month = d.getMonth() + 1;
  const dow   = d.getDay(); // 0=日,6=土
  const isWeekend = (dow === 0 || dow === 6);
  if ([7, 8].includes(month))          return isWeekend ? 'A' : 'B';
  if ([5, 6, 9, 10].includes(month))   return isWeekend ? 'B' : 'C';
  return 'C';
}

// リードタイムを計算（日数）
function calcLeadDays(bookingDate, activityDate) {
  if (!bookingDate || !activityDate) return '';
  const bd = bookingDate instanceof Date  ? bookingDate  : new Date(bookingDate);
  const ad = activityDate instanceof Date ? activityDate : new Date(activityDate);
  const diff = Math.round((ad - bd) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff : '';
}

// 地域区分
function classifyRegion(prefecture) {
  if (!prefecture) return '不明';
  if (prefecture === ANALYTICS_CONFIG.HOME_PREF)                   return '地元';
  if (ANALYTICS_CONFIG.TOHOKU_PREFS.includes(prefecture))          return '近隣';
  return '遠方';
}

// グループ属性
function classifyGroup(paxTotal, paxChild, paxPet) {
  if (paxPet   > 0)  return 'ペット連れ';
  if (paxChild > 0)  return 'ファミリー';
  if (paxTotal >= 5) return '大グループ(5名以上)';
  if (paxTotal >= 3) return '小グループ(3〜4名)';
  if (paxTotal === 2) return 'カップル/ペア';
  if (paxTotal === 1) return 'ソロ';
  return 'その他';
}

// ============================================================
// onEdit：CSVタブへの貼り付けを検知して自動処理
// ============================================================
function onEdit_Analytics(e) {
  const sheetName = e.range.getSheet().getName();
  const csvSheets = Object.values(ANALYTICS_CONFIG.SHEETS).filter(n => n.includes('CSV'));
  if (!csvSheets.includes(sheetName)) return;
  if (e.range.getRow() < 3) return; // 案内文行は無視

  // 少し間隔を空けてから処理（大量貼付完了を待つ）
  normalizeAllCSV();
}

// ============================================================
// ダッシュボードのみ更新（目標値変更後に手動実行）
// ============================================================
function updateDashboardOnly() {
  const ss = getAnalyticsSS();
  updateAnnualDashboard(ss);
  updateMonthlyDashboard(ss);
  updateDailyDashboard(ss);
  updateCustomerAnalysis(ss);
  Logger.log('ダッシュボード更新完了');
}

// ============================================================
// 過去の目標値をシードデータとして【目標】タブに書き込む
// ============================================================
function seedHistoricalTargets() {
  const ss       = getAnalyticsSS();
  const tgtSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (!tgtSheet) {
    Logger.log('【目標】シートが見つかりません。先にsetupAnalyticsSheets()を実行してください。');
    return;
  }

  // Excelから抽出した月別目標値（税込売上ベース）
  // R6 = 2024年、R7 = 2025年（5〜10月のみ営業期間）
  const SEED_TARGETS = [
    // 2024年（R6）
    { ym: '2024-05', bookings:   8, pax:  35, revenue:   207500 },
    { ym: '2024-06', bookings:   5, pax:  10, revenue:    65000 },
    { ym: '2024-07', bookings:  17, pax:  50, revenue:   325000 },
    { ym: '2024-08', bookings: 113, pax: 380, revenue:  2650000 },
    { ym: '2024-09', bookings:  21, pax:  64, revenue:   416000 },
    { ym: '2024-10', bookings:   2, pax:   5, revenue:    32500 },
    // 2025年（R7）
    { ym: '2025-05', bookings:  18, pax:  71, revenue:   427500 },
    { ym: '2025-06', bookings:  19, pax:  44, revenue:   273000 },
    { ym: '2025-07', bookings:  38, pax:  93, revenue:   581500 },
    { ym: '2025-08', bookings: 149, pax: 384, revenue:  2715000 },
    { ym: '2025-09', bookings:  32, pax:  81, revenue:   507500 },
    { ym: '2025-10', bookings:  11, pax:  27, revenue:   169500 },
    // 2026年
    { ym: '2026-05', bookings:   6, pax:  24, revenue:   167400 },
    { ym: '2026-06', bookings:   4, pax:  16, revenue:   111600 },
    { ym: '2026-07', bookings:  32, pax: 128, revenue:   950400 },
    { ym: '2026-08', bookings:  54, pax: 216, revenue:  1603800 },
    { ym: '2026-09', bookings:  21, pax:  84, revenue:   623700 },
    { ym: '2026-10', bookings:   4, pax:  16, revenue:   111600 },
  ];

  // 既存データを読み込み、重複しないYMだけ追加
  const existing = new Set();
  const lastRow  = tgtSheet.getLastRow();
  if (lastRow > 1) {
    const ymCol = tgtSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    ymCol.forEach(v => {
      if (!v) return;
      if (v instanceof Date) {
        existing.add(`${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`);
      } else {
        existing.add(String(v).trim());
      }
    });
  }

  // ヘッダーから列マップを取得
  const headers = tgtSheet.getRange(1, 1, 1, tgtSheet.getLastColumn()).getValues()[0];
  const col = buildColMap(headers);

  let added = 0;
  SEED_TARGETS.forEach(t => {
    if (existing.has(t.ym)) return;
    const row = new Array(headers.length).fill('');
    row[col['年月']]     = t.ym;
    row[col['目標_予約数']] = t.bookings;
    row[col['目標_人数']]   = t.pax;
    row[col['目標_売上']]   = t.revenue;
    // 手数料率は共通デフォルト値をセット
    if (col['手数料率_AJ']      !== undefined) row[col['手数料率_AJ']]      = ANALYTICS_CONFIG.COMMISSION_RATES['AJ'];
    if (col['手数料率_じゃらん'] !== undefined) row[col['手数料率_じゃらん']] = ANALYTICS_CONFIG.COMMISSION_RATES['じゃらん'];
    if (col['手数料率_アソビュー']!== undefined) row[col['手数料率_アソビュー']]= ANALYTICS_CONFIG.COMMISSION_RATES['アソビュー'];
    if (col['手数料率_satsuki'] !== undefined) row[col['手数料率_satsuki']] = ANALYTICS_CONFIG.COMMISSION_RATES['satsuki'];
    if (col['手数料率_Web予約']  !== undefined) row[col['手数料率_Web予約']]  = ANALYTICS_CONFIG.COMMISSION_RATES['Web予約'];
    if (col['手数料率_直接']     !== undefined) row[col['手数料率_直接']]     = ANALYTICS_CONFIG.COMMISSION_RATES['直接'];
    if (col['手数料率_ライン']   !== undefined) row[col['手数料率_ライン']]   = ANALYTICS_CONFIG.COMMISSION_RATES['ライン'];
    if (col['手数料率_インスタ'] !== undefined) row[col['手数料率_インスタ']] = ANALYTICS_CONFIG.COMMISSION_RATES['インスタ'];
    tgtSheet.appendRow(row);
    existing.add(t.ym);
    added++;
  });

  // 年月列を昇順ソート（ヘッダー行除く）
  const allRows = tgtSheet.getRange(2, 1, tgtSheet.getLastRow() - 1, headers.length).getValues();
  allRows.sort((a, b) => {
    const ka = a[col['年月']] instanceof Date
      ? `${a[col['年月']].getFullYear()}-${String(a[col['年月']].getMonth()+1).padStart(2,'0')}`
      : String(a[col['年月']]);
    const kb = b[col['年月']] instanceof Date
      ? `${b[col['年月']].getFullYear()}-${String(b[col['年月']].getMonth()+1).padStart(2,'0')}`
      : String(b[col['年月']]);
    return ka.localeCompare(kb);
  });
  tgtSheet.getRange(2, 1, allRows.length, headers.length).setValues(allRows);

  SpreadsheetApp.flush();
  Logger.log(`目標値シード完了：${added}件追加`);
}

// ============================================================
// デバッグ：チャネル別の取込状況を確認
// ============================================================
function debugChannels() {
  const ss      = getAnalyticsSS();
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const dbData  = dbSheet.getDataRange().getValues();

  const stats = {};
  for (let i = 1; i < dbData.length; i++) {
    const row    = dbData[i];
    const status = row[DB.STATUS - 1];
    const ch     = row[DB.CHANNEL - 1] || '(空)';
    const gross  = Number(row[DB.REVENUE_GROSS - 1]) || 0;
    if (!stats[ch]) stats[ch] = { all: 0, allGross: 0, active: 0, activeGross: 0 };
    stats[ch].all++;
    stats[ch].allGross += gross;
    if (status !== 'cancelled') {
      stats[ch].active++;
      stats[ch].activeGross += gross;
    }
  }

  Logger.log('===== 統合DB チャネル別集計 =====');
  let totalActive = 0;
  Object.entries(stats).sort((a, b) => b[1].activeGross - a[1].activeGross).forEach(([ch, s]) => {
    Logger.log(`${ch}: 有効${s.active}件 ¥${s.activeGross.toLocaleString()} / 全${s.all}件 ¥${s.allGross.toLocaleString()}`);
    totalActive += s.activeGross;
  });
  Logger.log(`--- 有効売上(税込)合計: ¥${totalActive.toLocaleString()} ---`);

  // 各CSVタブの状況
  Logger.log('===== CSVタブの状況 =====');
  [
    [ANALYTICS_CONFIG.SHEETS.AJ_CSV,      '予約番号'],
    [ANALYTICS_CONFIG.SHEETS.JALAN_CSV,   '予約番号'],
    [ANALYTICS_CONFIG.SHEETS.ASOVIEW_CSV, '予約グループID'],
    [ANALYTICS_CONFIG.SHEETS.DIRECT_CSV,  'ステータス'],
  ].forEach(([name, keyword]) => {
    const s = ss.getSheetByName(name);
    if (!s) { Logger.log(`${name}: シートなし`); return; }
    const hr = findHeaderRow(s, keyword);
    const lastRow = s.getLastRow();
    Logger.log(`${name}: 最終行${lastRow}, ヘッダー行=${hr ? hr + ' ("' + keyword + '"検出)' : 'なし(キーワード未検出!)'}`);
    if (hr) {
      const headers = s.getRange(hr, 1, 1, s.getLastColumn()).getValues()[0].filter(String);
      Logger.log(`  → 列: ${headers.join(', ')}`);
    }
  });

  // アソビューCSV内の媒体列の値を集計
  Logger.log('===== アソビューCSV 媒体列の実値 =====');
  const asoSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.ASOVIEW_CSV);
  if (asoSheet) {
    const hr = findHeaderRow(asoSheet, '予約グループID');
    if (hr) {
      const headers = asoSheet.getRange(hr, 1, 1, asoSheet.getLastColumn()).getValues()[0];
      const col = buildColMap(headers);
      if (col['媒体'] !== undefined) {
        const data = asoSheet.getRange(hr + 1, 1, asoSheet.getLastRow() - hr, asoSheet.getLastColumn()).getValues();
        const mediaCount = {};
        data.forEach(r => {
          const m = String(r[col['媒体']] || '(空)').trim();
          mediaCount[m] = (mediaCount[m] || 0) + 1;
        });
        Object.entries(mediaCount).forEach(([m, c]) => Logger.log(`  媒体="${m}": ${c}件`));
      } else {
        Logger.log('  「媒体」列が見つかりません。列名: ' + headers.filter(String).join(', '));
      }
    }
  }
}

// ============================================================
// デバッグ：目標値の読み込み確認
// ============================================================
function debugTargets() {
  const ss       = getAnalyticsSS();
  const tgtSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.TARGET);
  if (!tgtSheet) {
    Logger.log('【目標】シートが見つかりません');
    return;
  }
  const data    = tgtSheet.getDataRange().getValues();
  Logger.log('ヘッダー行: ' + JSON.stringify(data[0]));
  Logger.log('データ行数: ' + (data.length - 1));
  const targets = loadTargets(tgtSheet);
  Logger.log('読み込んだ目標: ' + JSON.stringify(targets));

  // 統合DBの年月も確認
  const dbSheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.UNIFIED_DB);
  const dbData  = dbSheet.getDataRange().getValues();
  const yms     = new Set();
  for (let i = 1; i < dbData.length; i++) {
    const dateVal = dbData[i][DB.ACTIVITY_DATE - 1];
    if (!dateVal) continue;
    const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (!isNaN(d.getTime())) {
      yms.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
  }
  Logger.log('統合DBの年月一覧: ' + JSON.stringify([...yms].sort()));
}
