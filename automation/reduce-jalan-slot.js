// ============================================================
// じゃらん遊び・体験 (ACTIVITY BOARD) 在庫枠 自動減算スクリプト
// ------------------------------------------------------------
// 他サイトで予約が入ったとき、じゃらん側の該当日時の在庫枠を減らす。
//
// 環境変数で動作を制御する：
//   JALAN_ID        : ACTIVITY BOARD ログインID
//   JALAN_PASSWORD  : ACTIVITY BOARD ログインパスワード
//   SLOT_DATE       : 対象日 (YYYY-MM-DD)
//   SLOT_TIME       : 対象時間 (HH:MM)
//   SLOT_DECREMENT  : 減らす人数 (例: 6)
//   DRY_RUN         : "true" のとき実際の保存は行わず確認のみ（既定: true）
//   HEADLESS        : "false" でブラウザを表示（ローカルデバッグ用、既定: true）
//
// ⚠️ セレクタ（input[name=...] など）は ACTIVITY BOARD の実画面に合わせて
//    後で確定する必要がある。現状は TODO マーカー付きの仮値。
// ============================================================

import { chromium } from 'playwright';

const CONFIG = {
  loginUrl: 'https://activityboard.jp/',
  id:        process.env.JALAN_ID,
  password:  process.env.JALAN_PASSWORD,
  date:      process.env.SLOT_DATE,
  time:      process.env.SLOT_TIME,
  decrement: parseInt(process.env.SLOT_DECREMENT || '0', 10),
  dryRun:    process.env.DRY_RUN !== 'false',   // 既定は安全側(true)
  headless:  process.env.HEADLESS !== 'false',
};

function assertConfig() {
  const missing = [];
  if (!CONFIG.id)        missing.push('JALAN_ID');
  if (!CONFIG.password)  missing.push('JALAN_PASSWORD');
  if (!CONFIG.date)      missing.push('SLOT_DATE');
  if (!CONFIG.time)      missing.push('SLOT_TIME');
  if (!CONFIG.decrement) missing.push('SLOT_DECREMENT');
  if (missing.length) {
    throw new Error(`必須の環境変数が未設定です: ${missing.join(', ')}`);
  }
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
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    // TODO: 実際の入力欄セレクタに差し替える
    await page.fill('input[name="loginId"]', CONFIG.id);
    await page.fill('input[name="password"]', CONFIG.password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    console.log('[1/4] ログイン完了');

    // ---------- 2. 在庫カレンダー画面へ遷移 ----------
    // TODO: 在庫管理メニューのリンク/URLに差し替える
    // await page.click('text=在庫管理');
    // await page.waitForLoadState('networkidle');
    console.log('[2/4] 在庫管理画面へ遷移 (TODO: セレクタ確定)');

    // ---------- 3. 対象日時の枠を特定して現在値を取得 ----------
    // TODO: カレンダーで CONFIG.date を選択 → CONFIG.time の枠の input を取得
    // const slotInput = page.locator(`[data-date="${CONFIG.date}"][data-time="${CONFIG.time}"] input`);
    // const current = parseInt(await slotInput.inputValue(), 10);
    const current = null; // ← 実装後に取得
    console.log(`[3/4] 現在の枠数: ${current} (TODO: 取得処理)`);

    if (current === null) {
      console.log('⚠️ セレクタ未確定のため、ここで安全停止します。');
      console.log('   ACTIVITY BOARD の在庫画面の構造を確認後、TODO部分を実装してください。');
      return;
    }

    // ---------- 4. 減算して保存 ----------
    const next = Math.max(0, current - CONFIG.decrement);
    console.log(`[4/4] ${current} → ${next} に変更`);

    if (CONFIG.dryRun) {
      console.log('🟡 DRY_RUN のため保存しません（確認のみ）');
    } else {
      // TODO: 値を書き込んで保存ボタンを押す
      // await slotInput.fill(String(next));
      // await page.click('text=保存');
      // await page.waitForLoadState('networkidle');
      console.log('✅ 保存しました');
    }
  } catch (err) {
    console.error('❌ エラー:', err.message);
    // 失敗時のスクショを残す（GitHub Actions のアーティファクトで確認できる）
    await page.screenshot({ path: 'error-screenshot.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
