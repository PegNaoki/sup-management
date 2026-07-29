// ============================================================
// アクティビティジャパン 枠モード「監査（読み取り専用）」スクリプト
// ------------------------------------------------------------
// 各枠が現在「即予約 / リクエスト / 開催なし」のどれかを読み取るだけ。
// 一切の変更は行わない（切替UIは触らない）。mode-aj-slot.js の読み取り部を流用。
//   status: 1=即予約 / 3=リクエスト / 4=開催なし
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD
//   SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30"}, ...]'（対象枠）
//   OUT_PATH (既定 audit-aj-mode.json) / HEADLESS (既定 true)
// 出力：OUT_PATH に [{site,date,time,mode,raw,plan,course}] を書き出す。
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'audit-aj-mode.json',
};

function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}
class AuditError extends Error {}

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
// status(1/3/4) → 共通モード語彙
function statusToMode(s) {
  return { 1: 'immediate', 3: 'request', 4: 'closed' }[s] || 'unknown';
}

function buildTargets() {
  if (!process.env.SLOTS) throw new Error('SLOTS が未設定です');
  let raw;
  try { raw = JSON.parse(process.env.SLOTS); }
  catch (e) { throw new Error(`SLOTS のJSON解析に失敗: ${e.message}`); }
  if (!Array.isArray(raw)) throw new Error('SLOTS はJSON配列である必要があります');
  return raw.map((s, i) => {
    const date = normalizeYmd(s.date);
    const time = normalizeHm(s.time);
    if (!date || !time) throw new Error(`slots[${i}]: date/time が不正 (${JSON.stringify(s)})`);
    return { date, time, compact: ymdCompact(date) };
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
  const targets = buildTargets();
  log('start', { count: targets.length });

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
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) throw new AuditError('ログインに失敗しました（ID/パスワードを確認）');
    log('login_ok', { url: page.url() });

    await openCalendarMenu(page);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
    log('calendar_opened');

    for (const t of targets) {
      try {
        const r = await auditOneSlot(page, t);
        results.push({ site: 'aj', date: t.date, time: t.time, ...r });
        log('slot', { date: t.date, time: t.time, mode: r.mode, raw: r.raw, remainImmediate: r.remainImmediate });
      } catch (e) {
        results.push({ site: 'aj', date: t.date, time: t.time, mode: 'not_found', raw: null, message: e.message });
        log('slot_skip', { date: t.date, time: t.time, message: e.message });
      }
    }
    log('done', { total: results.length });
    await page.screenshot({ path: 'audit-aj-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'audit-aj-mode-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(results, null, 2));
    await browser.close();
  }
}

async function auditOneSlot(page, task) {
  const { time, compact } = task;
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
  if (!ids) throw new AuditError(`時間 ${time} の行が見つかりません`);

  const statusId = `${ids.plan}_${ids.course}_${compact}_status`;
  const valId = `${ids.plan}_${ids.course}_${compact}_val`;
  const raw = await readStatus(page, statusId);
  const remainImmediate = await readVal(page, valId); // 在庫（残り即予約可能数）
  return { mode: statusToMode(raw), raw, remainImmediate, plan: ids.plan, course: ids.course };
}

// ---- 以下 mode-aj-slot.js から流用（ナビゲーション・読み取り） ----
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
  throw new AuditError('カレンダー管理・在庫管理メニューを開けませんでした');
}

async function ensureMonthShown(page, compact) {
  if (await page.locator(`.day_${compact}`).count() > 0) return;
  const year = Number(compact.slice(0, 4)), month = Number(compact.slice(4, 6));
  const monthRe = new RegExp(`${year}\\s*年\\s*${month}\\s*月`);
  const monthBtn = page.getByRole('button', { name: monthRe }).first();
  if (await monthBtn.count() > 0) {
    await monthBtn.click(); await page.waitForTimeout(1200); await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator(`.day_${compact}`).count() > 0) return;
  }
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
  throw new AuditError(`対象月に移動できません（${compact}）`);
}

async function readStatus(page, statusId) {
  const v = await page.locator(`input[id="${statusId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// hidden input の在庫値（残り即予約可能数）を読む
async function readVal(page, valId) {
  const v = await page.locator(`input[id="${valId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

main();
