// ============================================================
// じゃらん遊び・体験 (ACTIVITY BOARD) 枠の予約タイプ切替スクリプト（バッチ対応）
// ------------------------------------------------------------
// 枠を「即時予約 ⇄ リクエスト予約」に切り替える。
//   カレンダー(時間×日付)で対象セルを特定 → セル内の「(N人)」リンクを開く
//   → select[name="reservationType"] を選択 → 「一括変更する」
//   reservationType: KeyCONFIRMED=即時予約 / KeyUNCONFIRMED=リクエスト予約 / KeyCOMBINATION=併用
//   （「一括」はその1枠の中の複数プランをまとめて、の意味。日付×時間の1枠単位）
//
// 環境変数：
//   JALAN_ID / JALAN_PASSWORD / SHOP_NAME
//   ▼ 一括指定（優先）:
//     SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30","mode":"request"}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / MODE(request|immediate)
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://activityboard.jp/',
  id:       process.env.JALAN_ID,
  password: process.env.JALAN_PASSWORD,
  shopName: process.env.SHOP_NAME || 'のみくい処 七ツ家',
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-jalan-mode.jsonl',
  maxWindowAdvance: 30,
};

// mode ⇄ reservationType の対応
const MODE_TO_RT = { request: 'KeyUNCONFIRMED', immediate: 'KeyCONFIRMED', combination: 'KeyCOMBINATION' };
const RT_TO_MODE = { KeyUNCONFIRMED: 'request', KeyCONFIRMED: 'immediate', KeyCOMBINATION: 'combination' };
function rtMeaning(rt) {
  return { KeyCONFIRMED: '即時予約', KeyUNCONFIRMED: 'リクエスト予約', KeyCOMBINATION: '併用' }[rt] || `不明(${rt})`;
}

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

function buildTasks() {
  let raw = [];
  if (process.env.SLOTS) {
    try { raw = JSON.parse(process.env.SLOTS); }
    catch (e) { throw new Error(`SLOTS のJSON解析に失敗: ${e.message}`); }
    if (!Array.isArray(raw)) throw new Error('SLOTS はJSON配列である必要があります');
  } else if (process.env.SLOT_DATE) {
    raw = [{ date: process.env.SLOT_DATE, time: process.env.SLOT_TIME, mode: process.env.MODE }];
  } else {
    throw new Error('SLOTS または SLOT_DATE が未設定です');
  }
  return raw.map((s, i) => {
    const date = normalizeYmd(s.date);
    const time = normalizeHm(s.time);
    const mode = String(s.mode || '').toLowerCase();
    if (!date || !time) throw new Error(`slots[${i}]: date/time が不正 (${JSON.stringify(s)})`);
    if (!MODE_TO_RT[mode]) throw new Error(`slots[${i}]: mode は request|immediate`);
    return { date, time, mode };
  });
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
  });
  const page = await browser.newPage();
  let mng = null;
  const results = [];

  try {
    // ---------- ログイン（AirID） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 店舗選択 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    log('shop_selected', { shop: CONFIG.shopName });

    // ---------- 予約・販売管理（別ウィンドウ or 同一タブ） ----------
    const mngLink = page.getByRole('link', { name: '予約・販売管理', exact: true });
    await mngLink.waitFor({ state: 'visible', timeout: 30000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await mngLink.click();
    const popup = await popupPromise;
    mng = popup || page;
    await mng.waitForLoadState('networkidle');
    log('management_opened', { popup: !!popup });

    // ---------- 各枠を順に処理 ----------
    for (const task of tasks) {
      try {
        const r = await switchOneSlot(mng, task);
        results.push({ ...task, ...r });
      } catch (e) {
        const skip = /特定できません|見つかりません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) process.exitCode = 1;
    await mng.screenshot({ path: 'result-jalan-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await dumpAndShot(mng || page);
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠の予約タイプを切り替える。mng はログイン済み・予約販売管理を開いた状態。
async function switchOneSlot(mng, task) {
  const { date, time, mode } = task;
  const targetRt = MODE_TO_RT[mode];

  // 1. 対象セルを開いて現在の reservationType を読む
  let sel = await openSlotPanel(mng, date, time);
  const beforeRt = await sel.inputValue().catch(() => null);
  log('slot_before', { date, time, mode, beforeRt, meaning: rtMeaning(beforeRt) });

  if (beforeRt === targetRt) {
    log('slot_already', { date, time, note: `既に${rtMeaning(targetRt)}` });
    await backToCalendar(mng);
    return { result: 'already' };
  }
  if (CONFIG.dryRun) {
    log('slot_dry_run', { date, time, note: `${rtMeaning(beforeRt)} → ${rtMeaning(targetRt)}（変更せず）` });
    await backToCalendar(mng);
    return { result: 'dry_run' };
  }

  // 2. reservationType を変更 → 一括変更する
  await sel.selectOption(targetRt);
  await mng.getByRole('button', { name: '一括変更する' }).click();
  await mng.waitForLoadState('networkidle').catch(() => {});
  await mng.waitForTimeout(1500);

  // 3. 再オープンして検証
  sel = await openSlotPanel(mng, date, time);
  const afterRt = await sel.inputValue().catch(() => null);
  await backToCalendar(mng);
  if (afterRt !== targetRt) {
    throw new SlotSyncError(`切替検証NG：想定(${rtMeaning(targetRt)})だが実際は(${rtMeaning(afterRt)})`);
  }
  log('slot_switched', { date, time, from: rtMeaning(beforeRt), to: rtMeaning(afterRt) });
  return { result: 'switched', from: beforeRt, to: afterRt };
}

// 対象日時のセルの「(N人)」リンクを開き、reservationType の select を返す。
async function openSlotPanel(mng, date, time) {
  const col = await locateDateColumn(mng, date);
  if (col.index < 0) throw new SlotSyncError(`対象日 ${date} をカレンダーで特定できません`);
  const cell = await locateSlotCell(mng, time, col.index);
  if (!cell) throw new SlotSyncError(`時間 ${time} の枠を特定できません`);

  // セル内の枠リンク（"(6人)" 等）をクリックして編集パネルを開く
  const link = cell.locator('a').first();
  if (await link.count() === 0) throw new SlotSyncError(`枠リンクが見つかりません（${date} ${time}）`);
  await link.click();
  const sel = mng.locator('select[name="reservationType"]').first();
  await sel.waitFor({ state: 'visible', timeout: 10000 });
  return sel;
}

// 編集パネルからカレンダーに戻る（リロードで確実に一覧へ）
async function backToCalendar(mng) {
  await mng.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await mng.waitForTimeout(500);
}

// ------- 以下は reduce-jalan-slot.js と同じカレンダー特定ロジック -------
const DATE_HEADER_SELECTOR = process.env.DATE_HEADER_SELECTOR || 'span.day';
const NEXT_BUTTON_SELECTOR = process.env.NEXT_BUTTON_SELECTOR || '.calendar > div:nth-child(3) > .action-link';

async function locateDateColumn(mng, targetDate) {
  const [, tm, td] = targetDate.split('-').map(Number);
  let prevFirst = '';
  for (let advance = 0; advance <= CONFIG.maxWindowAdvance; advance++) {
    const days = await mng.locator(DATE_HEADER_SELECTOR).allInnerTexts().catch(() => []);
    for (let i = 0; i < days.length; i++) {
      const m = days[i].match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (m && Number(m[1]) === tm && Number(m[2]) === td) return { index: i, label: days[i].trim() };
    }
    const first = days[0] || '';
    if (advance > 0 && first === prevFirst) break;
    prevFirst = first;
    const next = mng.locator(NEXT_BUTTON_SELECTOR).first();
    if (await next.count() === 0) break;
    await next.click();
    await mng.waitForTimeout(900);
  }
  return { index: -1, label: '' };
}

async function locateSlotCell(mng, time, colIndex) {
  const rows = mng.locator('.calendar-wrap, .slot-row, tr').filter({ has: mng.locator('.time') });
  const rowCount = await rows.count();
  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);
    const timeText = (await row.locator('.time').first().innerText().catch(() => '')).trim();
    if (normalizeHm(timeText) === time) {
      const cells = row.locator('.calendar ol > li');
      if (await cells.count() > colIndex) return cells.nth(colIndex);
    }
  }
  const times = mng.locator('.time');
  const n = await times.count();
  for (let i = 0; i < n; i++) {
    const t = normalizeHm((await times.nth(i).innerText().catch(() => '')).trim());
    if (t === time) {
      const ol = times.nth(i).locator('xpath=ancestor::*[.//ol][1]').locator('.calendar ol > li');
      if (await ol.count() > colIndex) return ol.nth(colIndex);
    }
  }
  return null;
}

async function dumpAndShot(p) {
  if (!p) return;
  await p.screenshot({ path: 'error-jalan-mode.png', fullPage: true }).catch(() => {});
}

main();
