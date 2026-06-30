// ============================================================
// じゃらん遊び・体験 (ACTIVITY BOARD) 在庫枠 自動減算スクリプト
// ------------------------------------------------------------
// 他サイトで予約が入ったとき、じゃらん側の該当日時の在庫枠を減らす。
// ログインは AirID 認証。枠は「マイナス」ボタンのクリックで即反映（保存不要）。
//
// 環境変数：
//   JALAN_ID        : AirID または メールアドレス
//   JALAN_PASSWORD  : パスワード
//   SHOP_NAME       : 店舗名（既定: のみくい処 七ツ家）
//   SLOT_DATE       : 対象日 (YYYY-MM-DD)
//   SLOT_TIME       : 対象時間 (HH:MM)
//   SLOT_DECREMENT  : 減らす人数 (例: 6)
//   DRY_RUN         : "true" のとき実際のクリックは行わず確認のみ（既定: true）
//   HEADLESS        : "false" でブラウザ表示（ローカルデバッグ用、既定: true）
//
// ⚠️ 日付・時間枠を特定する部分（findSlotMinusButton）は、2回目の録画
//    （特定日付・特定時間枠への遷移）を元に確定する必要がある。
// ============================================================

import { chromium } from 'playwright';

const CONFIG = {
  topUrl:    'https://activityboard.jp/',
  id:        process.env.JALAN_ID,
  password:  process.env.JALAN_PASSWORD,
  shopName:  process.env.SHOP_NAME || 'のみくい処 七ツ家',
  date:      process.env.SLOT_DATE,
  time:      process.env.SLOT_TIME,
  decrement: parseInt(process.env.SLOT_DECREMENT || '0', 10),
  dryRun:    process.env.DRY_RUN !== 'false',
  headless:  process.env.HEADLESS !== 'false',
};

function assertConfig() {
  const missing = [];
  if (!CONFIG.id)        missing.push('JALAN_ID');
  if (!CONFIG.password)  missing.push('JALAN_PASSWORD');
  if (!CONFIG.date)      missing.push('SLOT_DATE');
  if (!CONFIG.time)      missing.push('SLOT_TIME');
  if (!CONFIG.decrement) missing.push('SLOT_DECREMENT');
  if (missing.length) throw new Error(`必須の環境変数が未設定: ${missing.join(', ')}`);
}

async function main() {
  assertConfig();
  console.log(`[開始] ${CONFIG.date} ${CONFIG.time} の枠を ${CONFIG.decrement} 減算 (dryRun=${CONFIG.dryRun})`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // ---------- 1. ログイン（AirID） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    console.log('[1/4] ログイン完了');

    // ---------- 2. 店舗を選択 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    console.log(`[2/4] 店舗選択: ${CONFIG.shopName}`);

    // ---------- 3. 予約・販売管理（別ウィンドウ）を開く ----------
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: '予約・販売管理', exact: true }).click();
    const mng = await popupPromise;
    await mng.waitForLoadState('networkidle');
    console.log('[3/4] 予約・販売管理を開いた');

    // ---------- 4. 対象日時の枠を特定して減算 ----------
    const minusBtn = await findSlotMinusButton(mng, CONFIG.date, CONFIG.time);
    if (!minusBtn) {
      console.log('⚠️ 対象日時の枠が見つかりませんでした（日付・時間遷移の実装が未確定）。');
      console.log('   2回目の録画（特定日付→特定時間枠）を元に findSlotMinusButton を実装してください。');
      await mng.screenshot({ path: 'error-screenshot.png', fullPage: true }).catch(() => {});
      return;
    }

    console.log(`[4/4] マイナスを ${CONFIG.decrement} 回クリック`);
    if (CONFIG.dryRun) {
      console.log('🟡 DRY_RUN のためクリックしません（確認のみ）');
    } else {
      for (let i = 0; i < CONFIG.decrement; i++) {
        await minusBtn.click();
        await mng.waitForTimeout(400); // 連打しすぎないよう間隔
      }
      console.log('✅ 減算完了（即反映）');
    }
  } catch (err) {
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'error-screenshot.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------
// 対象日付・時間の枠の「マイナス」ボタンを返す
// TODO: 2回目の録画（特定日付への遷移＋特定時間枠の選択）を元に実装する。
//   - カレンダーで CONFIG.date の月へ移動 → 日付をクリック
//   - 時間枠 CONFIG.time の行を特定 → その行の「マイナス」ボタンを返す
// 現状は未確定のため null を返して安全停止する。
// ------------------------------------------------------------
async function findSlotMinusButton(mngPage, date, time) {
  return null;
}

main();
