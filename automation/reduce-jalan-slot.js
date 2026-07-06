// ============================================================
// じゃらん遊び・体験 (ACTIVITY BOARD) 在庫枠 自動減算スクリプト
// ------------------------------------------------------------
// 他サイトで予約が入ったとき、じゃらん側の該当日時の在庫枠を減らす。
// ログインは AirID 認証。枠は「マイナス」ボタンのクリックで即反映（保存不要）。
//
// 画面構造（重要）：
//   - 「時間(行) × 日付(列)」のマトリクス
//   - 各行は .time（"10:00 ～ 12:00"）で時間が分かる
//   - 各行の .calendar ol > li（14日分）が日付の列
//   - 各セルに .stock-cnt（残数）と .stepper-button-minus がある
//   - セル自体に日付・時間の属性は無いため、行=時間・列=日付 で特定する
//
// 安全装置：
//   1. DRY_RUN 既定ON（実クリックしない）
//   2. 減算前に「行の時間」「列の日付」が予約と一致するか照合し、不一致なら中止
//   3. 減算上限（MAX_DECREMENT）で暴走防止
//   4. 操作の前後で残数を読み、想定通り減ったか検証
//   5. 終了時にスクリーンショットを保存
//
// 環境変数：
//   JALAN_ID / JALAN_PASSWORD / SHOP_NAME
//   SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / SLOT_DECREMENT
//   DRY_RUN (既定 true) / HEADLESS (既定 true) / MAX_DECREMENT (既定 10)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:    'https://activityboard.jp/',
  id:        process.env.JALAN_ID,
  password:  process.env.JALAN_PASSWORD,
  shopName:  process.env.SHOP_NAME || 'のみくい処 七ツ家',
  date:      normalizeYmd(process.env.SLOT_DATE),
  time:      normalizeHm(process.env.SLOT_TIME),
  // SLOT_DELTA（符号付き）優先。無ければ従来の SLOT_DECREMENT を減算(-)として扱う。
  delta:     parseInt(process.env.SLOT_DELTA || `-${process.env.SLOT_DECREMENT || '0'}`, 10),
  dryRun:    process.env.DRY_RUN !== 'false',
  headless:  process.env.HEADLESS !== 'false',
  maxDec:    parseInt(process.env.MAX_DECREMENT || '10', 10),
  dedupKey:  process.env.DEDUP_KEY || '',   // {source_site}:{bookingNo} 二重減算防止用
  logPath:   process.env.LOG_PATH || 'run-log.jsonl',
  maxWindowAdvance: 30, // 14日窓を最大何回送るか（無限ループ防止）
};

// ------------------------------------------------------------
// 構造化ログ（JSON Lines）。成功・失敗にかかわらず1行ずつ追記し、
// GitHub Actions の artifact で監査・障害解析できるようにする。
// ------------------------------------------------------------
const RUN_LOG = [];
function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  RUN_LOG.push(rec);
  console.log(`${rec.ts} [${event}] ${JSON.stringify(data)}`);
}
function flushLog(extra = {}) {
  try {
    const summary = { ts: new Date().toISOString(), event: 'summary', dedupKey: CONFIG.dedupKey,
      date: CONFIG.date, time: CONFIG.time, decrement: CONFIG.decrement, dryRun: CONFIG.dryRun, ...extra };
    RUN_LOG.push(summary);
    fs.writeFileSync(CONFIG.logPath, RUN_LOG.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) {
    console.error('ログ書き出し失敗:', e.message);
  }
}

// セレクタ不在・対象未検出など「成功扱いで終わってはいけない」失敗を表す。
// これを投げると catch で exitCode=1 となり、Actions が赤くなる（サイレント失敗の排除）。
class SlotSyncError extends Error {}

function normalizeHm(t) {
  if (!t) return '';
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t).trim();
}

// "2026-08-14" でも "2026/08/14" でも受け付けて YYYY-MM-DD に正規化
function normalizeYmd(d) {
  if (!d) return '';
  const m = String(d).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return String(d).trim();
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function assertConfig() {
  const miss = [];
  ['id', 'password', 'date', 'time'].forEach(k => { if (!CONFIG[k]) miss.push(k); });
  if (!CONFIG.delta) miss.push('delta(SLOT_DELTA/SLOT_DECREMENT)');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
  if (Math.abs(CONFIG.delta) > CONFIG.maxDec) {
    throw new Error(`増減 ${CONFIG.delta} が上限 ±${CONFIG.maxDec} を超えています（安全停止）`);
  }
}

async function main() {
  assertConfig();
  log('start', { date: CONFIG.date, time: CONFIG.time, delta: CONFIG.delta, dryRun: CONFIG.dryRun, dedupKey: CONFIG.dedupKey });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  let mng = null;
  let result = 'unknown';

  try {
    // ---------- 1. ログイン（AirID） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 店舗選択 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    log('shop_selected', { shop: CONFIG.shopName });

    // ---------- 3. 予約・販売管理（別ウィンドウ or 同一タブ） ----------
    const mngLink = page.getByRole('link', { name: '予約・販売管理', exact: true });
    await mngLink.waitFor({ state: 'visible', timeout: 30000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await mngLink.click();
    const popup = await popupPromise;
    mng = popup || page;                 // 別ウィンドウ or 同一タブ
    await mng.waitForLoadState('networkidle');
    log('management_opened', { popup: !!popup });

    // ---------- 4. 対象日付が14日窓に入るまでカレンダーを送る ----------
    const col = await locateDateColumn(mng, CONFIG.date);
    if (col.index < 0) {
      await dumpAndShot(mng);
      // サイレント失敗の排除：見つからない＝異常終了させる
      throw new SlotSyncError(`対象日 ${CONFIG.date} をカレンダーで特定できませんでした（日付ヘッダのセレクタ要確認）`);
    }
    log('date_located', { index: col.index, label: col.label });

    // ---------- 5. 対象時間の行を特定 → セルのマイナスを減算 ----------
    const cell = await locateSlotCell(mng, CONFIG.time, col.index);
    if (!cell) {
      await dumpAndShot(mng);
      throw new SlotSyncError(`時間 ${CONFIG.time} の枠（行）を特定できませんでした（時間行のセレクタ要確認）`);
    }

    const before = await readStock(cell);
    log('stock_before', { before });
    if (before === null) {
      await dumpAndShot(mng);
      throw new SlotSyncError(`対象枠の残数を読み取れませんでした（受付制限/在庫操作対象外、またはセレクタ要確認）`);
    }

    const steps = Math.abs(CONFIG.delta);
    const dir   = CONFIG.delta < 0 ? 'minus' : 'plus';
    const target = Math.max(0, before + CONFIG.delta);
    log('plan', { before, target, dir });

    if (CONFIG.dryRun) {
      result = 'dry_run';
      log('dry_run', { note: 'クリックせず確認のみ' });
    } else {
      const btn = cell.locator(dir === 'minus' ? '.stepper-button-minus' : '.stepper-button-plus');
      let clicks = 0;
      for (let i = 0; i < steps; i++) {
        const cur = await readStock(cell);
        if (dir === 'minus' && cur !== null && cur <= 0) { log('stop_zero', { at: i }); break; }
        // 保存通信(saveSlotCnt)の完了を待ってから次へ。
        const saveResp = mng.waitForResponse(
          res => /slot|stock|save|reserve|inventory/i.test(res.url()) && res.request().method() !== 'GET',
          { timeout: 8000 },
        ).catch(() => null);
        await btn.click();
        const resp = await saveResp;
        log('save_request', { matched: !!resp, url: resp ? resp.url() : null, status: resp ? resp.status() : null });
        clicks++;
        await mng.waitForTimeout(800);
      }
      await mng.waitForLoadState('networkidle').catch(() => {});

      // 画面の見た目ではなく「保存後のサーバー値」で検証する。
      // 管理画面をリロードして読み直し、本当に減ったかを確認する。
      const afterReload = await reReadStockAfterReload(mng);
      log('stock_after', { afterReload, clicks });
      if (afterReload === null) {
        result = 'unverified';
        await dumpAndShot(mng);
        throw new SlotSyncError('減算後の残数をリロード後に確認できませんでした（要手動確認）');
      }
      if (afterReload !== target) {
        result = 'not_persisted';
        await dumpAndShot(mng);
        // リロード後に想定値でない＝サーバーに保存されていない可能性。異常終了で通知。
        throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${afterReload})。サーバーに反映されていません`);
      }
      result = 'reduced';
      log('reduced', { before, after: afterReload });
    }
    await mng.screenshot({ path: 'result-screenshot.png', fullPage: true }).catch(() => {});
  } catch (err) {
    result = result === 'unknown' ? 'error' : result;
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await dumpAndShot(mng || page);
    process.exitCode = 1;
  } finally {
    flushLog({ result });
    await browser.close();
  }
}

// ------------------------------------------------------------
// 日付ヘッダ(.day = "6/30" 形式)を読み、対象日の列インデックスを返す。
// 14日窓に入っていなければ「次へ」を押して送る。
//   - 日付ヘッダ : span.day （例 "6/30"）
//   - 次へ送り   : 録画で確認した .action-link（ナビ部）。環境変数で上書き可。
// ------------------------------------------------------------
const DATE_HEADER_SELECTOR = process.env.DATE_HEADER_SELECTOR || 'span.day';
const NEXT_BUTTON_SELECTOR = process.env.NEXT_BUTTON_SELECTOR || '.calendar > div:nth-child(3) > .action-link';

async function locateDateColumn(mng, targetDate) {
  const [, tm, td] = targetDate.split('-').map(Number);
  let prevFirst = '';
  for (let advance = 0; advance <= CONFIG.maxWindowAdvance; advance++) {
    const days = await mng.locator(DATE_HEADER_SELECTOR).allInnerTexts().catch(() => []);
    console.log(`   日付ヘッダ(${days.length}): ${JSON.stringify(days.slice(0, 14))}`);
    for (let i = 0; i < days.length; i++) {
      const m = days[i].match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (m && Number(m[1]) === tm && Number(m[2]) === td) {
        return { index: i, label: days[i].trim() };
      }
    }
    // 窓が動かなくなったら終了（同じ先頭日付が続く）
    const first = days[0] || '';
    if (advance > 0 && first === prevFirst) {
      console.log('   これ以上カレンダーを送れませんでした。');
      break;
    }
    prevFirst = first;

    const next = mng.locator(NEXT_BUTTON_SELECTOR).first();
    if (await next.count() === 0) { console.log('   「次へ」ボタンが見つかりません。'); break; }
    await next.click();
    await mng.waitForTimeout(900);
  }
  return { index: -1, label: '' };
}

// ------------------------------------------------------------
// 対象時間の行を .time テキストで特定し、その行の col 番目のセル(li)を返す。
// ------------------------------------------------------------
async function locateSlotCell(mng, time, colIndex) {
  const rows = mng.locator('.calendar-wrap, .slot-row, tr').filter({ has: mng.locator('.time') });
  const rowCount = await rows.count();
  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);
    const timeText = (await row.locator('.time').first().innerText().catch(() => '')).trim();
    const start = normalizeHm(timeText);
    if (start && start === time) {
      const cells = row.locator('.calendar ol > li');
      if (await cells.count() > colIndex) return cells.nth(colIndex);
    }
  }
  // フォールバック：.time を全走査
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

// 管理画面をリロードし、対象日時の枠の残数をサーバー値として読み直す。
// 見た目（楽観的更新）ではなく、保存された本当の値で検証するために使う。
async function reReadStockAfterReload(mng) {
  try {
    await mng.reload({ waitUntil: 'networkidle' });
  } catch (e) {
    await mng.waitForTimeout(1500);
  }
  const col = await locateDateColumn(mng, CONFIG.date);
  if (col.index < 0) return null;
  const cell = await locateSlotCell(mng, CONFIG.time, col.index);
  if (!cell) return null;
  return await readStock(cell);
}

async function readStock(cell) {
  const txt = await cell.locator('.stock-cnt').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

async function dumpAndShot(p) {
  if (!p) return;
  await p.screenshot({ path: 'error-screenshot.png', fullPage: true }).catch(() => {});
}

main();
