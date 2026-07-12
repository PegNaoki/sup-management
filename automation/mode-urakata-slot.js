// ============================================================
// ウラカタ (the-retreat-place.urkt.in ＝ アソビュー共通在庫) 枠モード切替（バッチ対応）
// ------------------------------------------------------------
// ウラカタには「即予約/リクエスト」の切替UIは無く、即時販売在庫 calendarRealtimeLimit
// 「( n )」の数字だけで決まる（数字あり=即予約 / 0=即時販売停止＝リクエスト受付は継続）。
//   → mode を「( ) の数字」に翻訳して設定する：
//       request   → 0
//       immediate → stock（残り枠）
//
// ログイン〜予約枠〜対象日ジャンプ〜セル特定〜入力保存 は reduce-urakata-slot.js から流用。
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD / COURSE_KEYWORD (既定 'SUP')
//   ▼ 一括指定（優先）:
//     SLOTS: '[{"date":"2026-08-08","time":"10:00","mode":"immediate","stock":6}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE / SLOT_TIME / MODE(request|immediate) / STOCK
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  course:   process.env.COURSE_KEYWORD || 'SUP',
  dryRun:   process.env.DRY_RUN !== 'false',
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
    RUN_LOG.push({ ts: new Date().toISOString(), event: 'summary', dryRun: CONFIG.dryRun, ...extra });
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

// mode → 目標の即時販売在庫（( ) の数字）
function targetLimitFor(mode, stock) {
  return mode === 'request' ? 0 : stock;
}

function buildTasks() {
  let raw = [];
  if (process.env.SLOTS) {
    try { raw = JSON.parse(process.env.SLOTS); }
    catch (e) { throw new Error(`SLOTS のJSON解析に失敗: ${e.message}`); }
    if (!Array.isArray(raw)) throw new Error('SLOTS はJSON配列である必要があります');
  } else if (process.env.SLOT_DATE) {
    raw = [{ date: process.env.SLOT_DATE, time: process.env.SLOT_TIME, mode: process.env.MODE, stock: process.env.STOCK }];
  } else {
    throw new Error('SLOTS または SLOT_DATE が未設定です');
  }
  return raw.map((s, i) => {
    const date = normalizeYmd(s.date);
    const time = normalizeHm(s.time);
    const mode = String(s.mode || '').toLowerCase();
    const stock = parseInt(s.stock || 0, 10);
    if (!date || !time) throw new Error(`slots[${i}]: date/time が不正 (${JSON.stringify(s)})`);
    if (!['request', 'immediate'].includes(mode)) throw new Error(`slots[${i}]: mode は request|immediate`);
    if (mode === 'immediate' && !stock) throw new Error(`slots[${i}]: 即予約には stock(残り枠) が必要`);
    return { date, time, mode, stock };
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function assertConfig() {
  const miss = [];
  ['id', 'password'].forEach(k => { if (!CONFIG[k]) miss.push(k.toUpperCase()); });
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

async function main() {
  assertConfig();
  const tasks = buildTasks();
  log('start', { count: tasks.length, dryRun: CONFIG.dryRun });

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
  const results = [];

  try {
    // ---------- ログイン（1回） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ログインID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 予約枠ページ（1回） ----------
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    for (const task of tasks) {
      try {
        const r = await switchOneSlot(page, task);
        results.push({ ...task, ...r });
      } catch (e) {
        const skip = /見つかり|特定できません|到達できません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) process.exitCode = 1;
    await page.screenshot({ path: 'result-urakata-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await shot(page);
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠のモード（＝即時販売在庫の数字）を設定する
async function switchOneSlot(page, task) {
  const { date, time, mode, stock } = task;
  const target = targetLimitFor(mode, stock);

  await jumpToDate(page, date);
  let found = await locateCell(page, date, time);
  if (!found.ok) throw new SlotSyncError(`対象枠が見つかりません: ${found.reason}`);
  let cell = page.locator('[data-urkt-target="1"]');
  const before = await readLimit(cell);
  log('slot_before', { date, time, mode, before, target });
  if (before === null) throw new SlotSyncError('即時販売在庫(calendarRealtimeLimit)を読み取れませんでした');

  if (before === target) {
    log('slot_already', { date, time, note: `既に(${target}) ＝ ${mode}` });
    return { result: 'already' };
  }
  if (CONFIG.dryRun) {
    log('slot_dry_run', { date, time, note: `( ${before} ) → ( ${target} )（変更せず）` });
    return { result: 'dry_run' };
  }

  // 編集：( n ) をクリック→入力→フォーカス外し→保存
  await cell.locator('[data-test=calendarRealtimeLimit]').first().click();
  await page.waitForTimeout(600);
  let input = cell.locator('input:visible').first();
  if (await input.count() === 0) input = page.locator('.ui.transparent.input input:visible').first();
  if (!(await input.isVisible().catch(() => false))) {
    await cell.click();
    await page.waitForTimeout(600);
    input = cell.locator('input:visible').first();
    if (await input.count() === 0) input = page.locator('.ui.transparent.input input:visible').first();
    if (!(await input.isVisible().catch(() => false))) throw new SlotSyncError('編集用の入力欄が開きませんでした');
  }
  await input.fill(String(target));
  await input.press('Tab').catch(() => {});
  await input.blur().catch(() => {});
  await page.locator('[data-test=courseName]').first().click({ position: { x: 5, y: 5 } }).catch(() => {});

  const saveBtn = page.locator('[data-test="saveBtn"]');
  await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
  for (let w = 0; w < 20; w++) {
    if (await saveBtn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  if (!(await saveBtn.isEnabled().catch(() => false))) throw new SlotSyncError('保存ボタンが有効になりませんでした');
  const saveResp = page.waitForResponse(res => res.request().method() !== 'GET', { timeout: 15000 }).catch(() => null);
  await saveBtn.click();
  await saveResp;
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle').catch(() => {});

  // リロードして検証
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
  await jumpToDate(page, date);
  found = await locateCell(page, date, time);
  if (!found.ok) throw new SlotSyncError('保存後の再特定に失敗（要手動確認）');
  const after = await readLimit(page.locator('[data-urkt-target="1"]'));
  if (after !== target) throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${after})`);
  log('slot_switched', { date, time, from: before, to: after, mode });
  return { result: 'switched', from: before, to: after };
}

// ---- reduce-urakata-slot.js から流用 ----
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
        return;
      }
      await nextBtn.first().click();
      await page.waitForTimeout(400);
    }
    throw new SlotSyncError(`datepickerで ${ymd} に到達できませんでした`);
  }
  throw new SlotSyncError('datepicker（カレンダー入力欄）が見つかりませんでした');
}

async function locateCell(page, date, time) {
  return await page.evaluate(({ dateStr, time, course }) => {
    const [yy, mm, dd] = dateStr.split('-').map(Number);
    const youbi = ['日', '月', '火', '水', '木', '金', '土'][new Date(yy, mm - 1, dd).getDay()];
    document.querySelectorAll('[data-urkt-target]').forEach(el => el.removeAttribute('data-urkt-target'));
    const labels = [...document.querySelectorAll('[data-test=courseName]')];
    const rowIdx = labels.findIndex(td => {
      const txt = td.textContent || '';
      return txt.includes(time) && (course ? txt.includes(course) : true);
    });
    if (rowIdx < 0) return { ok: false, reason: `時間 ${time} の行が見つからない` };
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
    if (rowIdx >= gridRows.length) return { ok: false, reason: 'グリッド行数不足' };
    const rowCells = [...gridRows[rowIdx].cells];
    if (colIdx >= rowCells.length) return { ok: false, reason: 'グリッド列数不足' };
    rowCells[colIdx].setAttribute('data-urkt-target', '1');
    return { ok: true, rowIdx, colIdx, header: `${dd}(${youbi})` };
  }, { dateStr: date, time: time, course: CONFIG.course });
}

async function readLimit(cell) {
  const txt = await cell.locator('[data-test=calendarRealtimeLimit]').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

async function shot(p) { await p.screenshot({ path: 'error-urakata-mode.png', fullPage: true }).catch(() => {}); }

main();
