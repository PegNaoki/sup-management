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
// CSVパーサー：直接（LINE/インスタ等）
// ============================================================
function parseDirect_CSV(ss) {
  const sheet = ss.getSheetByName(ANALYTICS_CONFIG.SHEETS.DIRECT_CSV);
  if (!sheet) return [];

  const headerRow = findHeaderRow(sheet, '参加');
  if (!headerRow) return [];

  const data    = sheet.getRange(headerRow + 1, 1, sheet.getLastRow() - headerRow, sheet.getLastColumn()).getValues();
  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);

  return data
    .filter(row => row[col['代表者名(姓名)']] && String(row[col['代表者名(姓名)']]).trim())
    .map((row, idx) => {
      const guestName  = String(row[col['代表者名(姓名)']] || '').trim();
      const channel    = String(row[col['媒体']] || '直接').trim();
      const actDate    = buildDateFromCols(row[col['年']], row[col['月']], row[col['日']]);
      const actTime    = formatTime(row[col['時間']]);
      const bookYear   = row[col['年_予約']] || row[headers.lastIndexOf('年') + 1];
      const bookDate   = toDateOnly(row[col['予約日']]) || actDate;

      const paxTotal   = toInt(row[col['合計人数']]);
      const paxAdult   = toInt(row[col['大人人数']]);
      const paxChild   = toInt(row[col['子人人数']]) || toInt(row[col['子供人数']]);
      const paxPet     = toInt(row[col['ペット']]);
      const prefecture = String(row[col['都道府県']] || '').trim();

      const uniqueKey = `direct_${guestName}_${actDate ? actDate.toISOString().slice(0, 10) : idx}`;

      return {
        unifiedId:       uniqueKey,
        channel:         channel || '直接',
        bookingNo:       '',
        guestName,
        guestKana:       String(row[col['代表者名\n(セイメイ)']] || row[col['代表者名(セイメイ)']] || '').trim(),
        activityDate:    actDate,
        activityTime:    actTime,
        bookingDate:     bookDate,
        status:          normalizeStatus(String(row[col['参加']] || ''), '直接'),
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
  r.pricePerPax        = r.paxTotal > 0 ? Math.round(r.revenueNet / r.paxTotal) : 0;
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

    const gross = Number(row[DB.REVENUE_GROSS - 1])    || 0;
    const com   = Number(row[DB.COMMISSION_AMT - 1])   || 0;
    const net   = Number(row[DB.REVENUE_NET - 1])      || 0;
    const pax   = Number(row[DB.PAX_TOTAL - 1])        || 0;

    if (!annual[year]) annual[year] = { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    annual[year].bookings++;
    annual[year].pax        += pax;
    annual[year].gross      += gross;
    annual[year].commission += com;
    annual[year].net        += net;

    if (!monthly[ym]) monthly[ym] = { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    monthly[ym].bookings++;
    monthly[ym].pax        += pax;
    monthly[ym].gross      += gross;
    monthly[ym].commission += com;
    monthly[ym].net        += net;
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
    { label: '① 予約数（組）',            fmt: '#,##0',    get: a => a.bookings },
    { label: '② 1予約あたり人数（人）',    fmt: '0.00',     get: a => a.bookings > 0 ? a.pax / a.bookings : 0 },
    { label: '③ 1予約あたり売上（円）',    fmt: '¥#,##0',  get: a => a.bookings > 0 ? Math.round(a.net / a.bookings) : 0 },
    { label: '④ 1人あたり単価（円）',      fmt: '¥#,##0',  get: a => a.pax > 0 ? Math.round(a.net / a.pax) : 0 },
    { label: '⑤ 売上（円）',              fmt: '¥#,##0',  get: a => a.net },
    { label: '⑥ 平均手数料率（％）',       fmt: '0.00%',   get: a => a.gross > 0 ? a.commission / a.gross : 0 },
    { label: '⑦ 粗利率（％）',            fmt: '0.00%',   get: a => a.gross > 0 ? a.net / a.gross : 0 },
  ];

  const tgtCurr = annualTargets[currentYear] || {};
  const actCurr = annual[currentYear] || { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };

  kpiDef.forEach((kpi, ki) => {
    const vals = sortedYears.map(y => kpi.get(annual[y]));
    let tgtVal = '';
    let achRate = '';
    if (ki === 0) { tgtVal = tgtCurr.bookings || ''; }
    else if (ki === 4) { tgtVal = tgtCurr.revenue  || ''; }

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

  const monthHeaders = ['月', '予約数', '人数', '売上(net)', '1予約あたり人数', '1人あたり単価', '平均手数料率', '粗利率', '目標_予約数', '目標_人数', '目標_売上', '達成率_売上'];
  writeHeader(monthHeaders, '#6aa84f');

  const monthlyChartStartRow = row;
  for (let m = 1; m <= 12; m++) {
    const ym  = `${currentYear}-${String(m).padStart(2, '0')}`;
    const md  = monthly[ym] || { bookings: 0, pax: 0, gross: 0, commission: 0, net: 0 };
    const tgt = targets[ym] || {};

    const pap  = md.bookings > 0 ? (md.pax  / md.bookings).toFixed(2) : '';
    const upp  = md.pax      > 0 ? Math.round(md.net / md.pax)        : '';
    const comR = md.gross    > 0 ? md.commission / md.gross            : '';
    const grR  = md.gross    > 0 ? md.net / md.gross                  : '';
    const achR = (tgt.revenue && tgt.revenue > 0) ? md.net / tgt.revenue : '';

    const rowVals = [
      `${m}月`,
      md.bookings || '', md.pax || '', md.net || '',
      pap, upp, comR, grR,
      tgt.bookings || '', tgt.pax || '', tgt.revenue || '', achR,
    ];
    dashSheet.getRange(row, 1, 1, rowVals.length).setValues([rowVals]);

    // 書式
    dashSheet.getRange(row, 4).setNumberFormat('#,##0');
    dashSheet.getRange(row, 6).setNumberFormat('#,##0');
    dashSheet.getRange(row, 11).setNumberFormat('#,##0');
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
  const totalAchR = (tgtCurrTotal.revenue > 0) ? annCurr.net / tgtCurrTotal.revenue : '';
  const totalRow = [
    '合計/平均',
    annCurr.bookings || '', annCurr.pax || '', annCurr.net || '',
    annCurr.bookings > 0 ? (annCurr.pax / annCurr.bookings).toFixed(2) : '',
    annCurr.pax > 0 ? Math.round(annCurr.net / annCurr.pax) : '',
    annCurr.gross > 0 ? annCurr.commission / annCurr.gross : '',
    annCurr.gross > 0 ? annCurr.net / annCurr.gross : '',
    tgtCurrTotal.bookings || '', tgtCurrTotal.pax || '', tgtCurrTotal.revenue || '',
    totalAchR,
  ];
  dashSheet.getRange(row, 1, 1, totalRow.length).setValues([totalRow])
    .setFontWeight('bold').setBackground('#e8f0fe');
  dashSheet.getRange(row, 4).setNumberFormat('#,##0');
  dashSheet.getRange(row, 6).setNumberFormat('#,##0');
  dashSheet.getRange(row, 11).setNumberFormat('#,##0');
  dashSheet.getRange(row, 7).setNumberFormat('0.0%');
  dashSheet.getRange(row, 8).setNumberFormat('0.0%');
  if (totalAchR !== '') dashSheet.getRange(row, 12).setNumberFormat('0.0%');
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
        .setOption('series', { 0: { color: '#4285f4' }, 1: { color: '#ea4335', lineDashType: 'dash' } })
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
    if (!monthly[ym]) monthly[ym] = { bookings: 0, pax: 0, revenue: 0, commissionAmt: 0, channels: {} };

    monthly[ym].bookings++;
    monthly[ym].pax     += Number(row[DB.PAX_TOTAL - 1])    || 0;
    monthly[ym].revenue += Number(row[DB.REVENUE_NET - 1])  || 0;
    monthly[ym].commissionAmt += Number(row[DB.COMMISSION_AMT - 1]) || 0;
    if (!monthly[ym].channels[ch]) monthly[ym].channels[ch] = { bookings: 0, revenue: 0 };
    monthly[ym].channels[ch].bookings++;
    monthly[ym].channels[ch].revenue += Number(row[DB.REVENUE_NET - 1]) || 0;
  }

  // ダッシュボードシートに書き出し
  const rows = [
    [
      '年月',
      '実績_予約数', '実績_人数', '実績_売上(net)',
      '目標_予約数', '目標_人数', '目標_売上',
      '達成率_予約数', '達成率_人数', '達成率_売上',
      '1予約あたり人数', '1人あたり単価',
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

    const paxPerBooking  = m.bookings > 0 ? (m.pax / m.bookings).toFixed(2) : '';
    const pricePerPax    = m.pax     > 0 ? Math.round(m.revenue / m.pax)   : '';
    const commRate       = m.revenue > 0 ? (m.commissionAmt / (m.revenue + m.commissionAmt)) : '';

    rows.push([
      ym,
      m.bookings, m.pax, m.revenue,
      tgt.bookings || '', tgt.pax || '', tgt.revenue || '',
      tgt.bookings ? (m.bookings / tgt.bookings) : '',
      tgt.pax      ? (m.pax      / tgt.pax     ) : '',
      tgt.revenue  ? (m.revenue  / tgt.revenue ) : '',
      paxPerBooking, pricePerPax,
      m.commissionAmt, commRate,
      (ch['AJ']        || {}).bookings || 0, (ch['AJ']        || {}).revenue || 0,
      (ch['じゃらん']   || {}).bookings || 0, (ch['じゃらん']   || {}).revenue || 0,
      (ch['アソビュー'] || {}).bookings || 0, (ch['アソビュー'] || {}).revenue || 0,
      (ch['Web予約']    || {}).bookings || 0, (ch['Web予約']    || {}).revenue || 0,
      ((ch['直接'] || {}).bookings || 0) + ((ch['ライン'] || {}).bookings || 0) + ((ch['インスタ'] || {}).bookings || 0),
      ((ch['直接'] || {}).revenue  || 0) + ((ch['ライン'] || {}).revenue  || 0) + ((ch['インスタ'] || {}).revenue  || 0),
    ]);
  });

  dashSheet.clearContents();
  dashSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  dashSheet.getRange(1, 1, 1, rows[0].length)
    .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
  dashSheet.setFrozenRows(1);

  // 達成率列（H,I,J = 8,9,10）をパーセント書式に設定
  if (rows.length > 1) {
    const dataRows = rows.length - 1;
    dashSheet.getRange(2, 8, dataRows, 3).setNumberFormat('0.0%');
    // 手数料率列（N=14）もパーセント
    dashSheet.getRange(2, 14, dataRows, 1).setNumberFormat('0.0%');
    // 売上系列は整数カンマ区切り
    const revCols = [4, 6, 13, 16, 18, 20, 22, 24];
    revCols.forEach(c => dashSheet.getRange(2, c, dataRows, 1).setNumberFormat('#,##0'));
    // 達成率に色付け（100%以上=緑、80%未満=赤）
    for (let r = 2; r <= rows.length; r++) {
      [8, 9, 10].forEach(c => {
        const cell = dashSheet.getRange(r, c);
        const v = cell.getValue();
        if (typeof v !== 'number' || v === 0) return;
        if (v >= 1.0)   cell.setBackground('#b6d7a8');
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

  // CSVタブの案内文
  [
    [ANALYTICS_CONFIG.SHEETS.AJ_CSV,      'アクティビティジャパン管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
    [ANALYTICS_CONFIG.SHEETS.JALAN_CSV,   'じゃらんnet管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
    [ANALYTICS_CONFIG.SHEETS.ASOVIEW_CSV, 'アソビュー/ウラカタ管理画面からダウンロードしたCSVを3行目以降に貼り付けてください'],
    [ANALYTICS_CONFIG.SHEETS.DIRECT_CSV,  'LINE/インスタ等の直接予約を手入力してください（書式は既存の直接入力タブに合わせてください）'],
  ].forEach(([sheetName, note]) => {
    const s = ss.getSheetByName(sheetName);
    if (s && !s.getRange(1, 1).getValue()) {
      s.getRange(1, 1).setValue(note).setFontStyle('italic').setFontColor('#888888');
    }
  });

  Logger.log('セットアップ完了。SPREADSHEET_IDを設定してnormalizeAllCSV()を実行してください。');
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
