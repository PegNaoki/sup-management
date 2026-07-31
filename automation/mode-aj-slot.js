// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 枠モード切替スクリプト（バッチ対応）
// ------------------------------------------------------------
// 枠を「即予約 ⇄ リクエスト」に切り替える。
//   status: 1=即予約(在庫あり) / 3=リクエスト / 4=開催なし
//   リクエスト化：日セルを選択 → 「リクエスト にする」ボタン（即反映）
//   即予約化　　：日セルを選択 → 在庫数を入力 → 「設定」ボタン
//
// 複数枠を1回のログインでまとめて処理できる（GASからの一括同期用）。
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD
//   ▼ 一括指定（優先）:
//     SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30","mode":"request","stock":0}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / MODE(request|immediate) / STOCK
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-aj-mode.jsonl',
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
function ymdCompact(d) { return d.replace(/-/g, ''); }
function statusMeaning(s) { return { 1: '即予約', 3: 'リクエスト', 4: '開催なし' }[s] || `不明(${s})`; }

// 処理対象の枠リストを組み立てる（SLOTS優先、無ければ単一env）
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
    if (!['request', 'immediate', 'closed'].includes(mode)) throw new Error(`slots[${i}]: mode は request|immediate|closed`);
    if (mode === 'immediate' && !stock) throw new Error(`slots[${i}]: 即予約化には stock が必要`);
    return { date, time, mode, stock, compact: ymdCompact(date) };
  });
}

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
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
    // ---------- ログイン（1回だけ） ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) throw new SlotSyncError('ログインに失敗しました（ID/パスワードを確認）');
    log('login_ok', { url: page.url() });

    // ---------- カレンダー管理・在庫管理へ（1回だけ） ----------
    await openCalendarMenu(page);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
    log('calendar_opened');

    // ---------- 各枠を順に処理 ----------
    for (const task of tasks) {
      try {
        const r = await switchOneSlot(page, task);
        results.push({ ...task, ...r });
      } catch (e) {
        // 枠がAJに存在しない/月に届かない等のデータ不整合は「スキップ」（全体は失敗にしない）。
        // 保存検証NGなど運用上の異常だけを「error」として失敗＋通知対象にする。
        const skip = /見つかりません|移動できません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) { process.exitCode = 1; } // 本当の異常時のみ失敗（🚨通知が飛ぶ）
    await page.screenshot({ path: 'result-aj-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'error-aj-mode.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠のモードを切り替える。page はログイン済み・カレンダー表示済み。
async function switchOneSlot(page, task) {
  const { date, time, mode, stock, compact } = task;
  await ensureMonthShown(page, compact);

  const ids = await page.evaluate((t) => {
    const rows = [...document.querySelectorAll('tr.plan-stock')];
    for (const row of rows) {
      const el = row.querySelector('.plan-time span');
      if (el && (el.textContent || '').trim() === t) {
        return { plan: (row.querySelector('.plan_id') || {}).textContent?.trim() || '',
                 course: (row.querySelector('.plan_course_id') || {}).textContent?.trim() || '' };
      }
    }
    return null;
  }, time);
  if (!ids) throw new SlotSyncError(`時間 ${time} の行が見つかりません`);

  const statusId = `${ids.plan}_${ids.course}_${compact}_status`;
  const beforeStatus = await readStatus(page, statusId);
  // 満席のstatus値はサイト仕様が未確認のため、closed は「即予約(1)でも
  // リクエスト(3)でもない状態」になったことで検証する（実値はログに残す）。
  const targetStatus = mode === 'request' ? 3 : (mode === 'closed' ? null : 1);
  log('slot_before', { date, time, mode, statusId, beforeStatus, meaning: statusMeaning(beforeStatus) });

  if (targetStatus !== null && beforeStatus === targetStatus) {
    log('slot_already', { date, time, note: `既に${statusMeaning(targetStatus)}` });
    return { result: 'already' };
  }
  // closed 希望で、既に即予約でもリクエストでもない＝受付停止済みなら何もしない
  if (mode === 'closed' && beforeStatus !== 1 && beforeStatus !== 3) {
    log('slot_already', { date, time, note: `既に受付停止(status=${beforeStatus})` });
    return { result: 'already' };
  }
  // 「開催なし(4)」は運営が意図的に閉じた枠。自動では開けない（即予約化しない）。
  // ALLOW_REOPEN_CLOSED=true のときだけ、手動復旧のために変更を許可する。
  if (beforeStatus === 4 && process.env.ALLOW_REOPEN_CLOSED !== 'true') {
    log('slot_skip', { date, time, note: '開催なしのため自動変更しない（閉じたまま）' });
    return { result: 'skipped' };
  }
  if (CONFIG.dryRun) {
    log('slot_dry_run', { date, time, note: `${statusMeaning(beforeStatus)} → ${statusMeaning(targetStatus)}（変更せず）` });
    return { result: 'dry_run' };
  }

  // 対象行の日セルを選択
  const rowCellBtn = page.locator(`tr.plan-stock:has(.plan_course_id:text-is("${ids.course}")) .day_${compact} button`).first();
  await rowCellBtn.click();
  await page.waitForTimeout(500);

  // 実際に出ているボタンを記録する（アクセシブル名でのクリックが
  // 意図と違う要素に当たる事例があったため、押す前の状態を残す）。
  const panelButtons = await page.locator('button:visible')
    .evaluateAll(els => els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30))
    .catch(() => []);
  log('panel_buttons', { buttons: panelButtons });

  if (mode === 'request') {
    await clickButtonByText(page, 'リクエスト にする');
  } else if (mode === 'closed') {
    await clickButtonByText(page, '満席 にする');
  } else {
    const spin = page.getByRole('spinbutton').first();
    await spin.waitFor({ state: 'visible', timeout: 8000 });
    await spin.fill(String(stock));
    await page.getByRole('button', { name: '設定' }).click();
  }
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle').catch(() => {});

  // リロードして検証
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
  await ensureMonthShown(page, compact);
  const afterStatus = await readStatus(page, statusId);
  if (mode === 'closed') {
    log('closed_status_observed', { date, time, afterStatus, meaning: statusMeaning(afterStatus) });
    if (afterStatus === 1 || afterStatus === 3) {
      throw new SlotSyncError(`満席化検証NG：リロード後も受付可能(${statusMeaning(afterStatus)})`);
    }
  } else if (afterStatus !== targetStatus) {
    throw new SlotSyncError(`切替検証NG：想定(${targetStatus})だがリロード後は(${afterStatus})`);
  }
  log('slot_switched', { date, time, from: statusMeaning(beforeStatus), to: statusMeaning(afterStatus) });
  return { result: 'switched', from: beforeStatus, to: afterStatus };
}

// 「カレンダー管理・在庫管理」へ（hrefポーリング＋メニュー展開フォールバック）
async function openCalendarMenu(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  let href = null;
  for (let i = 0; i < 20; i++) {
    href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').replace(/\s+/g, '').includes('カレンダー管理・在庫管理'));
      return a ? a.getAttribute('href') : null;
    });
    if (href) break;
    await page.waitForTimeout(1000);
  }
  if (href && href !== '#' && !href.startsWith('javascript')) {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'networkidle' });
    return;
  }
  const parent = page.locator('a, li, span', { hasText: 'カレンダー管理' }).first();
  if (await parent.count() > 0) { await parent.click().catch(() => {}); await page.waitForTimeout(1500); }
  const link = page.getByRole('link', { name: 'カレンダー管理・在庫管理' }).first();
  if (await link.count() > 0) { await link.click({ force: true }).catch(() => {}); await page.waitForLoadState('networkidle').catch(() => {}); return; }
  throw new SlotSyncError('カレンダー管理・在庫管理メニューを開けませんでした');
}

async function ensureMonthShown(page, compact) {
  if (await page.locator(`.day_${compact}`).count() > 0) return;
  const year = Number(compact.slice(0, 4)), month = Number(compact.slice(4, 6));
  const monthRe = new RegExp(`${year}\\s*年\\s*${month}\\s*月`);

  // まず対象月ボタンが直接あれば押す
  const monthBtn = page.getByRole('button', { name: monthRe }).first();
  if (await monthBtn.count() > 0) {
    await monthBtn.click(); await page.waitForTimeout(1200); await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator(`.day_${compact}`).count() > 0) return;
  }

  // 直接ボタンが無ければ「次月」送りを繰り返して対象月まで進める（best-effort）
  for (let i = 0; i < 8; i++) {
    const next = page.locator(
      'a[aria-label*="次"], button[aria-label*="次"], .fc-next-button, a:has-text("次の月"), button:has-text("次の月"), a:has-text("›"), button:has-text("›")'
    ).first();
    if (await next.count() === 0) break;
    await next.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000); await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator(`.day_${compact}`).count() > 0) return;
    const mb = page.getByRole('button', { name: monthRe }).first();
    if (await mb.count() > 0) {
      await mb.click(); await page.waitForTimeout(1000); await page.waitForLoadState('networkidle').catch(() => {});
      if (await page.locator(`.day_${compact}`).count() > 0) return;
    }
  }
  throw new SlotSyncError(`対象月に移動できません（${compact}）`);
}

// ボタンを「表示テキストの完全一致」で押す。getByRole の accessible name は
// AJ の画面で意図しない要素に当たることがあったため、テキストで厳密に選ぶ。
async function clickButtonByText(page, label) {
  const want = label.replace(/\s+/g, '');
  const clicked = await page.evaluate((w) => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => (e.textContent || '').replace(/\s+/g, '') === w
                             && !!(e.offsetParent));   // 表示中のものだけ
    if (el) { el.click(); return true; }
    return false;
  }, want);
  if (!clicked) throw new SlotSyncError(`ボタン「${label}」が見つかりません`);
  log('button_clicked', { label });
}

async function readStatus(page, statusId) {
  const v = await page.locator(`input[id="${statusId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

main();
