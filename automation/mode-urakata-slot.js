// ============================================================
// ウラカタ (the-retreat-place.urkt.in ＝ アソビュー共通在庫) 枠モード切替【調査用スケルトン】
// ------------------------------------------------------------
// ※現時点では「切替の仕組み」が未確定のため、まずは対象セル/行のDOMをダンプして
//   即予約⇄リクエストの表現方法・操作方法を調べるための土台。
//   ログイン〜予約枠〜対象日ジャンプ〜セル特定 は reduce-urakata-slot.js から流用。
//
// 想定される2パターン（明日どちらか確認する）：
//   A) 「即時販売在庫」の数値で制御（>0=即予約 / 0=リクエスト）→ 既存の在庫連動で代替可、専用アダプタ不要
//   B) 専用の予約タイプ切替UIがある → じゃらん/AJ同様に select/ボタンで切替
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD
//   SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / COURSE_KEYWORD (既定 'SUP')
//   DUMP_DOM=true でセル/行のHTMLをダンプ / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  date:     normalizeYmd(process.env.SLOT_DATE),
  time:     normalizeHm(process.env.SLOT_TIME),
  course:   process.env.COURSE_KEYWORD || 'SUP',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-urakata-mode.jsonl',
};

const RUN_LOG = [];
function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  RUN_LOG.push(rec);
  console.log(`${rec.ts} [${event}] ${JSON.stringify(data)}`);
}
function flushLog(extra = {}) {
  try {
    RUN_LOG.push({ ts: new Date().toISOString(), event: 'summary', date: CONFIG.date, time: CONFIG.time, ...extra });
    fs.writeFileSync(CONFIG.logPath, RUN_LOG.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) { console.error('ログ書き出し失敗:', e.message); }
}
class SlotSyncError extends Error {}

function normalizeHm(t) {
  if (!t) return '';
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t).trim();
}
function normalizeYmd(d) {
  if (!d) return '';
  const m = String(d).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return String(d).trim();
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function assertConfig() {
  const miss = [];
  ['id', 'password', 'date', 'time'].forEach(k => { if (!CONFIG[k]) miss.push(k.toUpperCase()); });
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

async function main() {
  assertConfig();
  log('start', { date: CONFIG.date, time: CONFIG.time });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP', viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ログインID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 予約枠ページ ----------
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    // ---------- 3. 対象日へジャンプ ----------
    await jumpToDate(page, CONFIG.date);

    // ---------- 4. 対象セルを特定 ----------
    const found = await locateCell(page);
    if (!found.ok) {
      await shot(page);
      throw new SlotSyncError(`対象枠が見つかりません: ${found.reason}`);
    }
    log('cell_located', { row: found.rowIdx, col: found.colIdx, header: found.header });

    const cell = page.locator('[data-urkt-target="1"]');

    // ---------- 5. DOMダンプ（切替の仕組み調査用） ----------
    const cellHtml = await cell.evaluate(el => el.outerHTML).catch(() => '');
    log('dump_cell_html', { html: cellHtml.slice(0, 2000) });
    // 行（コース×時間）のラベル側も見る
    const rowLabelHtml = await page.evaluate((idx) => {
      const labels = [...document.querySelectorAll('[data-test=courseName]')];
      return labels[idx] ? labels[idx].closest('tr').outerHTML.slice(0, 2000) : '';
    }, found.rowIdx).catch(() => '');
    log('dump_row_label_html', { html: rowLabelHtml });
    // セルをクリックして編集UIが出るか（即予約/リクエストの選択肢が現れるか）を確認
    await cell.click().catch(() => {});
    await page.waitForTimeout(800);
    const afterClickHtml = await cell.evaluate(el => el.outerHTML).catch(() => '');
    log('dump_cell_after_click', { html: afterClickHtml.slice(0, 2500) });

    await page.screenshot({ path: 'result-urakata-mode.png', fullPage: true }).catch(() => {});
    log('done', { note: 'DOMダンプ完了。ログの dump_* を確認して切替方式を決める' });
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await shot(page);
    process.exitCode = 1;
  } finally {
    flushLog();
    await browser.close();
  }
}

// ---- reduce-urakata-slot.js から流用（日付ジャンプ／セル特定） ----
async function jumpToDate(page, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const boxes = page.getByRole('textbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    try { await boxes.nth(i).click({ timeout: 1500 }); } catch (e) { continue; }
    const nextBtn = page.getByRole('button', { name: 'Next Month' });
    if (await nextBtn.count() === 0) continue;
    if (!(await nextBtn.first().isVisible().catch(() => false))) continue;
    for (let hop = 0; hop < 18; hop++) {
      const opt = page.getByRole('option', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(1200);
        log('date_jumped', { ymd });
        return;
      }
      await nextBtn.first().click();
      await page.waitForTimeout(400);
    }
    throw new SlotSyncError(`datepickerで ${ymd} に到達できませんでした`);
  }
  throw new SlotSyncError('datepicker（カレンダー入力欄）が見つかりませんでした');
}

async function locateCell(page) {
  const [y, m, d] = CONFIG.date.split('-').map(Number);
  const youbi = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return await page.evaluate(({ dd, youbi, time, course }) => {
    document.querySelectorAll('[data-urkt-target]').forEach(el => el.removeAttribute('data-urkt-target'));
    const labels = [...document.querySelectorAll('[data-test=courseName]')];
    const rows = labels.map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
    const rowIdx = labels.findIndex(td => {
      const txt = td.textContent || '';
      return txt.includes(time) && (course ? txt.includes(course) : true);
    });
    if (rowIdx < 0) return { ok: false, reason: `時間 ${time} の行が見つからない`, rows };
    const headerDivs = [...document.querySelectorAll('[data-test=calendarDayHeader]')];
    const headerDiv = headerDivs.find(h => (h.textContent || '').replace(/\s+/g, '') === `${dd}${youbi}`);
    if (!headerDiv) return { ok: false, reason: `日付 ${dd}(${youbi}) のヘッダが見つからない` };
    const headerCell = headerDiv.closest('th, td');
    const headerRowCells = [...headerCell.parentElement.children];
    const colIdx = headerRowCells.indexOf(headerCell);
    const probe = document.querySelector('[data-test=calendarSeatCount]');
    if (!probe) return { ok: false, reason: 'カレンダーセルが見つからない' };
    const grid = probe.closest('table');
    const gridRows = [...grid.querySelectorAll('tbody tr')];
    if (rowIdx >= gridRows.length) return { ok: false, reason: `グリッド行数不足` };
    const rowCells = [...gridRows[rowIdx].cells];
    if (colIdx >= rowCells.length) return { ok: false, reason: `グリッド列数不足` };
    rowCells[colIdx].setAttribute('data-urkt-target', '1');
    return { ok: true, rowIdx, colIdx, header: `${dd}(${youbi})` };
  }, { dd: d, youbi, time: CONFIG.time, course: CONFIG.course });
}

async function shot(p) { await p.screenshot({ path: 'error-urakata-mode.png', fullPage: true }).catch(() => {}); }

main();
