// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 枠モード切替スクリプト
// ------------------------------------------------------------
// 枠を「即予約 ⇄ リクエスト」に切り替える。
//   status: 1=即予約(在庫あり) / 3=リクエスト / 4=開催なし
//   リクエスト化：日セルを選択 → 「リクエスト にする」ボタン（即反映）
//   即予約化　　：日セルを選択 → 在庫数を入力 → 「設定」ボタン
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD
//   SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM)
//   MODE: 'request'（リクエスト化） | 'immediate'（即予約化）
//   STOCK: MODE=immediate のとき設定する在庫数（必須）
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  date:     normalizeYmd(process.env.SLOT_DATE),
  time:     normalizeHm(process.env.SLOT_TIME),
  mode:     (process.env.MODE || '').toLowerCase(),   // request | immediate
  stock:    parseInt(process.env.STOCK || '0', 10),
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-aj-mode.jsonl',
  maxMonthNav: 14,
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
      date: CONFIG.date, time: CONFIG.time, mode: CONFIG.mode, dryRun: CONFIG.dryRun, ...extra });
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

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
  if (!CONFIG.date)     miss.push('SLOT_DATE');
  if (!CONFIG.time)     miss.push('SLOT_TIME');
  if (!['request', 'immediate'].includes(CONFIG.mode)) miss.push('MODE(request|immediate)');
  if (CONFIG.mode === 'immediate' && !CONFIG.stock) miss.push('STOCK(即予約化には在庫数が必要)');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

async function main() {
  assertConfig();
  log('start', { date: CONFIG.date, time: CONFIG.time, mode: CONFIG.mode, stock: CONFIG.stock, dryRun: CONFIG.dryRun });

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
  let result = 'unknown';

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) throw new SlotSyncError('ログインに失敗しました（ID/パスワードを確認）');
    log('login_ok', { url: page.url() });

    // ---------- 2. カレンダー管理・在庫管理へ ----------
    await openCalendarMenu(page);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
    log('calendar_opened');

    // ---------- 3. 対象月・行(時間)・plan/course ----------
    const compact = ymdCompact(CONFIG.date);
    await ensureMonthShown(page, compact);
    const ids = await page.evaluate((time) => {
      const rows = [...document.querySelectorAll('tr.plan-stock')];
      for (const row of rows) {
        const t = row.querySelector('.plan-time span');
        if (t && (t.textContent || '').trim() === time) {
          return { plan: (row.querySelector('.plan_id') || {}).textContent?.trim() || '',
                   course: (row.querySelector('.plan_course_id') || {}).textContent?.trim() || '' };
        }
      }
      return null;
    }, CONFIG.time);
    if (!ids) throw new SlotSyncError(`時間 ${CONFIG.time} の行が見つかりません`);
    log('row_located', ids);

    const statusId = `${ids.plan}_${ids.course}_${compact}_status`;
    const beforeStatus = await readStatus(page, statusId);
    log('status_before', { statusId, beforeStatus, meaning: statusMeaning(beforeStatus) });

    const targetStatus = CONFIG.mode === 'request' ? 3 : 1;
    if (beforeStatus === targetStatus) {
      result = 'already';
      log('already', { note: `既に${statusMeaning(targetStatus)}のため変更不要` });
      await page.screenshot({ path: 'result-aj-mode.png', fullPage: true }).catch(() => {});
      return;
    }

    if (CONFIG.dryRun) {
      result = 'dry_run';
      log('dry_run', { note: `${statusMeaning(beforeStatus)} → ${statusMeaning(targetStatus)} に切替予定（変更せず）` });
    } else {
      // ---------- 4. 日セルを選択 ----------
      // 対象行のセルだけを選ぶため、行スコープで day_ セルのボタンをクリック
      const rowCellBtn = page.locator(`tr.plan-stock:has(.plan_course_id:text-is("${ids.course}")) .day_${compact} button`).first();
      await rowCellBtn.click();
      await page.waitForTimeout(500);

      if (CONFIG.mode === 'request') {
        await page.getByRole('button', { name: 'リクエスト にする' }).click();
      } else {
        const spin = page.getByRole('spinbutton').first();
        await spin.waitFor({ state: 'visible', timeout: 8000 });
        await spin.fill(String(CONFIG.stock));
        await page.getByRole('button', { name: '設定' }).click();
      }
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});

      // ---------- 5. リロードして検証 ----------
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
      await ensureMonthShown(page, compact);
      const afterStatus = await readStatus(page, statusId);
      log('status_after', { afterStatus, meaning: statusMeaning(afterStatus) });
      if (afterStatus !== targetStatus) {
        result = 'not_persisted';
        await page.screenshot({ path: 'error-aj-mode.png', fullPage: true }).catch(() => {});
        throw new SlotSyncError(`切替検証NG：想定(${targetStatus})だがリロード後は(${afterStatus})`);
      }
      result = 'switched';
      log('switched', { from: statusMeaning(beforeStatus), to: statusMeaning(afterStatus) });
    }
    await page.screenshot({ path: 'result-aj-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    result = result === 'unknown' ? 'error' : result;
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'error-aj-mode.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    flushLog({ result });
    await browser.close();
  }
}

function statusMeaning(s) {
  return { 1: '即予約', 3: 'リクエスト', 4: '開催なし' }[s] || `不明(${s})`;
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
  if (await page.locator(`.day_${compact}`).count() > 0) { log('month_ok', { compact, nav: 0 }); return; }
  const year = Number(compact.slice(0, 4)), month = Number(compact.slice(4, 6));
  const monthBtn = page.getByRole('button', { name: new RegExp(`${year}\\s*年\\s*${month}\\s*月`) }).first();
  if (await monthBtn.count() > 0) {
    await monthBtn.click(); await page.waitForTimeout(1200); await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator(`.day_${compact}`).count() > 0) { log('month_ok', { compact, via: 'monthButton' }); return; }
  }
  throw new SlotSyncError(`対象月に移動できません（${compact}）`);
}

async function readStatus(page, statusId) {
  const v = await page.locator(`input[id="${statusId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

main();
