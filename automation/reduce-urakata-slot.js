// ============================================================
// ウラカタ (urkt.in) 在庫枠 自動調整スクリプト
// ------------------------------------------------------------
// ウラカタ＝アソビューの在庫は共通のため、ここを調整すれば両方に反映される。
//
// 画面構造（実DOM確認済み）：
//   - 予約枠ページ：左表=行ラベル（td[data-test=courseName] に コース名/時間）、
//     右グリッド=日付ごとのセル（行順は左表と対応）
//   - セル内: [data-test=calendarSeatCount]="0/20"（予約数/定員）
//             [data-test=calendarRealtimeLimit]="( 6 )"（即時販売の在庫数）
//   - セルをクリック → 入力欄が出る → 絶対値を入力 → [data-test=saveBtn] で保存
//   - 日付ジャンプ：datepicker（Next Monthボタン + "Choose YYYY年M月D日..."オプション）
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD
//   SLOT_DATE (YYYY-MM-DD or YYYY/MM/DD) / SLOT_TIME (HH:MM)
//   SLOT_DELTA  : 符号付き増減（例 "-2"=2減らす / "+2"=2戻す）
//   DRY_RUN (既定 true) / HEADLESS (既定 true) / MAX_ABS_DELTA (既定 10)
//   COURSE_KEYWORD : 行の絞り込み用コース名キーワード（既定 "SUP"）
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  date:     normalizeYmd(process.env.SLOT_DATE),
  time:     normalizeHm(process.env.SLOT_TIME),
  delta:    parseInt(process.env.SLOT_DELTA || '0', 10),
  course:   process.env.COURSE_KEYWORD || 'SUP',
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  maxAbs:   parseInt(process.env.MAX_ABS_DELTA || '10', 10),
  logPath:  process.env.LOG_PATH || 'run-log-urakata.jsonl',
};

const RUN_LOG = [];
function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  RUN_LOG.push(rec);
  console.log(`${rec.ts} [${event}] ${JSON.stringify(data)}`);
}
function flushLog(extra = {}) {
  try {
    RUN_LOG.push({ ts: new Date().toISOString(), event: 'summary',
      date: CONFIG.date, time: CONFIG.time, delta: CONFIG.delta, dryRun: CONFIG.dryRun, ...extra });
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
  if (!CONFIG.id)       miss.push('URKT_ID');
  if (!CONFIG.password) miss.push('URKT_PASSWORD');
  if (!CONFIG.date)     miss.push('SLOT_DATE');
  if (!CONFIG.time)     miss.push('SLOT_TIME');
  if (!CONFIG.delta)    miss.push('SLOT_DELTA');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
  if (Math.abs(CONFIG.delta) > CONFIG.maxAbs) {
    throw new Error(`増減 ${CONFIG.delta} が上限 ±${CONFIG.maxAbs} を超えています（安全停止）`);
  }
}

async function main() {
  assertConfig();
  log('start', { date: CONFIG.date, time: CONFIG.time, delta: CONFIG.delta, dryRun: CONFIG.dryRun });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  let result = 'unknown';

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ログインID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 予約枠ページへ ----------
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    // ---------- 3. 対象日へジャンプ（datepicker） ----------
    await jumpToDate(page, CONFIG.date);

    // ---------- 4. 対象セルを特定 ----------
    const found = await locateCell(page);
    if (!found.ok) {
      await shot(page);
      throw new SlotSyncError(`対象枠が見つかりません: ${found.reason}（headers=${JSON.stringify(found.headers || [])} rows=${JSON.stringify(found.rows || [])}）`);
    }
    log('cell_located', { row: found.rowIdx, col: found.colIdx, header: found.header });

    const cell = page.locator('[data-urkt-target="1"]');
    const before = await readLimit(cell);
    log('limit_before', { before });
    if (before === null) {
      await shot(page);
      throw new SlotSyncError('即時販売在庫（calendarRealtimeLimit）を読み取れませんでした');
    }

    const target = Math.max(0, before + CONFIG.delta);
    log('plan', { before, target });

    if (CONFIG.dryRun) {
      result = 'dry_run';
      log('dry_run', { note: '変更せず確認のみ' });
    } else {
      // ---------- 5. セルをクリック→入力→保存 ----------
      await cell.click();
      const input = page.locator('.ui.transparent.input input:visible').first();
      await input.waitFor({ state: 'visible', timeout: 8000 });
      await input.fill(String(target));
      const saveResp = page.waitForResponse(
        res => res.request().method() !== 'GET',
        { timeout: 8000 },
      ).catch(() => null);
      await page.locator('[data-test="saveBtn"]').click();
      const resp = await saveResp;
      log('save_request', { matched: !!resp, url: resp ? resp.url() : null, status: resp ? resp.status() : null });
      await page.waitForLoadState('networkidle').catch(() => {});

      // ---------- 6. リロードしてサーバー値で検証 ----------
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
      await jumpToDate(page, CONFIG.date);
      const found2 = await locateCell(page);
      if (!found2.ok) throw new SlotSyncError('保存後の再特定に失敗（要手動確認）');
      const after = await readLimit(page.locator('[data-urkt-target="1"]'));
      log('limit_after', { after });
      if (after !== target) {
        result = 'not_persisted';
        await shot(page);
        throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${after})`);
      }
      result = 'adjusted';
      log('adjusted', { before, after });
    }
    await page.screenshot({ path: 'result-urakata.png', fullPage: true }).catch(() => {});
  } catch (err) {
    result = result === 'unknown' ? 'error' : result;
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await shot(page);
    process.exitCode = 1;
  } finally {
    flushLog({ result });
    await browser.close();
  }
}

// datepickerで対象日に移動する。
// テキストボックスを順に試し、カレンダー（Next Monthボタン）が開いたものを使う。
async function jumpToDate(page, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const boxes = page.getByRole('textbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    try {
      await boxes.nth(i).click({ timeout: 1500 });
    } catch (e) { continue; }
    const nextBtn = page.getByRole('button', { name: 'Next Month' });
    if (await nextBtn.count() === 0) continue;
    if (!(await nextBtn.first().isVisible().catch(() => false))) continue;

    // カレンダーが開いた。対象月まで送って日付を選ぶ
    for (let hop = 0; hop < 18; hop++) {
      const opt = page.getByRole('option', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(1200);
        log('date_jumped', { ymd, viaTextbox: i });
        return;
      }
      await nextBtn.first().click();
      await page.waitForTimeout(400);
    }
    throw new SlotSyncError(`datepickerで ${ymd} に到達できませんでした`);
  }
  throw new SlotSyncError('datepicker（カレンダー入力欄）が見つかりませんでした');
}

// 対象の「行（コース×時間）×列（日付）」のセルを特定し、data-urkt-target="1" を付与する
async function locateCell(page) {
  const [, m, d] = CONFIG.date.split('-').map(Number);
  return await page.evaluate(({ mm, dd, time, course }) => {
    const dateLabel = `${mm}/${dd}(`;
    // 既存マーカーを掃除
    document.querySelectorAll('[data-urkt-target]').forEach(el => el.removeAttribute('data-urkt-target'));

    // --- 行の特定（左表の courseName） ---
    const labels = [...document.querySelectorAll('[data-test=courseName]')];
    const rows = labels.map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
    const rowIdx = labels.findIndex(td => {
      const txt = td.textContent || '';
      return txt.includes(time) && (course ? txt.includes(course) : true);
    });
    if (rowIdx < 0) return { ok: false, reason: `時間 ${time} の行が見つからない`, rows };

    // --- 列の特定（日付ヘッダ "M/D(" を含むセル） ---
    const probe = document.querySelector('[data-test=calendarSeatCount]');
    if (!probe) return { ok: false, reason: 'カレンダーセルが見つからない', rows };
    const grid = probe.closest('table');

    // 日付ラベルはグリッド近辺のth/tdにある想定。ドキュメント全体から探しcellIndexを取る
    const all = [...document.querySelectorAll('th, td')];
    const headerCell = all.find(el => {
      const t = (el.textContent || '').replace(/\s+/g, '');
      return t.startsWith(`${mm}/${dd}(`) && t.length <= 12;
    });
    const headers = all.map(el => (el.textContent || '').replace(/\s+/g, ''))
      .filter(t => /^\d{1,2}\/\d{1,2}\(/.test(t)).slice(0, 20);
    if (!headerCell) return { ok: false, reason: `日付 ${dateLabel} のヘッダが見つからない`, headers, rows };
    const colIdx = headerCell.cellIndex;

    // --- セルの特定 ---
    const gridRows = [...grid.querySelectorAll('tbody tr')];
    if (rowIdx >= gridRows.length) return { ok: false, reason: `グリッド行数不足 (${gridRows.length})`, rows };
    const rowCells = gridRows[rowIdx].cells;
    if (colIdx >= rowCells.length) return { ok: false, reason: `グリッド列数不足 (${rowCells.length}, col=${colIdx})`, headers };
    rowCells[colIdx].setAttribute('data-urkt-target', '1');
    return { ok: true, rowIdx, colIdx, header: headerCell.textContent.trim() };
  }, { mm: m, dd: d, time: CONFIG.time, course: CONFIG.course });
}

// セル内の即時販売在庫 "( 6 )" を読む
async function readLimit(cell) {
  const txt = await cell.locator('[data-test=calendarRealtimeLimit]').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

async function shot(p) {
  await p.screenshot({ path: 'error-urakata.png', fullPage: true }).catch(() => {});
}

main();
