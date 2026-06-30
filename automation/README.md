# OTA在庫枠 自動連携

他サイトで予約が入ったとき、じゃらん(ACTIVITY BOARD)の該当日時の在庫枠を自動で減らす仕組み。

## 全体の流れ

```
予約メール着信
  ↓ GAS が検知（既存の importReservationEmails）
  ↓ notifySlotReduction_() が GitHub API を叩く（repository_dispatch）
GitHub Actions 起動（.github/workflows/reduce-slot.yml）
  ↓ Playwright で ACTIVITY BOARD にログイン
  ↓ 該当日時の枠を人数分だけ減らす
```

## セットアップ

### 1. GitHub Secrets（リポジトリ設定 → Secrets and variables → Actions）
- `JALAN_ID` … ACTIVITY BOARD ログインID
- `JALAN_PASSWORD` … ACTIVITY BOARD パスワード

### 2. GAS スクリプトプロパティ
- `GITHUB_TOKEN` … repo権限のPersonal Access Token
- `GITHUB_REPO` … 例 `PegNaoki/sup-management`
- `SLOT_SYNC_ENABLED` … `true` で連携ON（既定OFF）
- `SLOT_SYNC_DRY_RUN` … `true` の間は枠を実際に減らさず確認のみ（推奨：最初はtrue）

## テスト手順

1. **ローカルでブラウザ確認**（セレクタ確定用）
   ```bash
   cd automation && npm install && npx playwright install chromium
   JALAN_ID=xxx JALAN_PASSWORD=xxx SLOT_DATE=2026-08-14 SLOT_TIME=13:30 \
   SLOT_DECREMENT=2 DRY_RUN=true HEADLESS=false node reduce-jalan-slot.js
   ```
2. **GitHub Actions 手動実行** … Actionsタブ → Reduce OTA Slot → Run workflow
3. 問題なければ GAS の `SLOT_SYNC_DRY_RUN` を外して本番化

## ⚠️ 未完成部分（要セレクタ確定）

`reduce-jalan-slot.js` 内の `TODO:` 箇所は、ACTIVITY BOARD の実際の
管理画面のHTML構造に合わせて入力欄・ボタンのセレクタを確定する必要がある。
ローカルで `HEADLESS=false` 実行して画面を見ながら詰めるのが確実。
