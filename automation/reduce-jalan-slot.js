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

const CONFIG = {
  topUrl:    'https://activityboard.jp/',
  id:        process.env.JALAN_ID,
  password:  process.env.JALAN_PASSWORD,
  shopName:  process.env.SHOP_NAME || 'のみくい処 七ツ家',
  date:      process.env.SLOT_DATE,
  time:      normalizeHm(process.env.SLOT_TIME),
  decrement: parseInt(process.env.SLOT_DECREMENT || '0', 10),
  dryRun:    process.env.DRY_RUN !== 'false',
  headless:  process.env.HEADLESS !== 'false',
  maxDec:    parseInt(process.env.MAX_DECREMENT || '10', 10),
  maxWindowAdvance: 30, // 14日窓を最大何回送るか（無限ループ防止）
};

function normalizeHm(t) {
  if (!t) return '';
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t).trim();
}

function assertConfig() {
  const miss = [];
  ['id', 'password', 'date', 'time', 'decrement'].forEach(k => { if (!CONFIG[k]) miss.push(k); });
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
  if (CONFIG.decrement > CONFIG.maxDec) {
    throw new Error(`減算数 ${CONFIG.decrement} が上限 ${CONFIG.maxDec} を超えています（安全停止）`);
  }
}

async function main() {
  assertConfig();
  console.log(`[開始] ${CONFIG.date} ${CONFIG.time} の枠を ${CONFIG.decrement} 減算 (dryRun=${CONFIG.dryRun})`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  let mng = null;

  try {
    // ---------- 1. ログイン（AirID） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    console.log('[1/5] ログイン完了');

    // ---------- 2. 店舗選択 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    console.log(`[2/5] 店舗選択: ${CONFIG.shopName}`);

    // ---------- 3. 予約・販売管理（別ウィンドウ or 同一タブ） ----------
    const mngLink = page.getByRole('link', { name: '予約・販売管理', exact: true });
    await mngLink.waitFor({ state: 'visible', timeout: 30000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await mngLink.click();
    const popup = await popupPromise;
    if (popup) {
      mng = popup;                       // 別ウィンドウで開いた場合
    } else {
      mng = page;                        // 同一タブで遷移した場合
    }
    await mng.waitForLoadState('networkidle');
    console.log('[3/5] 予約・販売管理を開いた' + (popup ? '（別ウィンドウ）' : '（同一タブ）'));

    // ---------- 4. 対象日付が14日窓に入るまでカレンダーを送る ----------
    const col = await locateDateColumn(mng, CONFIG.date);
    if (col.index < 0) {
      console.log(`⚠️ 対象日 ${CONFIG.date} をカレンダーで見つけられませんでした。`);
      console.log('   日付ヘッダのセレクタ（DATE_HEADER_SELECTOR）の確定が必要です。');
      await dumpAndShot(mng);
      return;
    }
    console.log(`[4/5] 対象日を列 ${col.index} で特定 (見出し: "${col.label}")`);

    // ---------- 5. 対象時間の行を特定 → セルのマイナスを減算 ----------
    const cell = await locateSlotCell(mng, CONFIG.time, col.index);
    if (!cell) {
      console.log(`⚠️ 時間 ${CONFIG.time} の枠（行）が見つかりませんでした。`);
      await dumpAndShot(mng);
      return;
    }

    const before = await readStock(cell);
    console.log(`[5/5] 対象枠の現在残数: ${before}`);
    if (before === null) {
      console.log('⚠️ この枠は在庫操作対象外（受付制限など）の可能性。安全のため中止。');
      await dumpAndShot(mng);
      return;
    }

    const target = Math.max(0, before - CONFIG.decrement);
    console.log(`    ${before} → ${target} に変更予定`);

    if (CONFIG.dryRun) {
      console.log('🟡 DRY_RUN のためクリックしません（確認のみ）');
    } else {
      const minus = cell.locator('.stepper-button-minus');
      for (let i = 0; i < CONFIG.decrement; i++) {
        const cur = await readStock(cell);
        if (cur !== null && cur <= 0) { console.log('    残数0のため停止'); break; }
        await minus.click();
        await mng.waitForTimeout(500);
      }
      const after = await readStock(cell);
      console.log(`✅ 減算完了：残数 ${after}`);
      if (after !== null && after !== target) {
        console.log(`⚠️ 想定(${target})と実際(${after})が不一致。手動確認してください。`);
      }
    }
    await mng.screenshot({ path: 'result-screenshot.png', fullPage: true }).catch(() => {});
  } catch (err) {
    console.error('❌ エラー:', err.message);
    await dumpAndShot(mng || page);
    process.exitCode = 1;
  } finally {
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
