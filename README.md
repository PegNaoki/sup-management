# 🏄 GoRETREAT AIZU｜SUP予約 統合管理

秋元湖SUPツアーの予約を、複数OTA（じゃらん / アクティビティジャパン / ウラカタ＝asoview・Web予約）
横断で一元管理する社内ツール。**各予約サイトの実データを「正」**として突合し、
スプレッドシート・Googleカレンダー・LINE通知・在庫（枠）連動を自動化する。

## 構成

| 要素 | 役割 |
|---|---|
| `sup_reservation.gs` | Google Apps Script 本体（突合Webアプリ `doPost` / カレンダー登録 / LINE通知 / 枠モード同期 / お客様リマインドメール） |
| `sup_analytics.gs` | 集計・分析用の GAS |
| `automation/` | Playwright(Node) による各OTAサイトの自動操作（予約一覧の読み取り＝reconcile、在庫減算＝reduce、枠モード切替＝mode） |
| `.github/workflows/` | GitHub Actions（定期突合・在庫連動などを実行し、GAS へ POST） |
| `docs/design/` | 設計ドキュメント（ライフサイクル / 通知・レポート / アーキテクチャ） |

## 運用の要点（サイト一本化）

- **メール取込は廃止**。予約の確定 / リクエスト / キャンセルは各OTAの実データを唯一の正とする。
- **2時間ごと**に3サイトの予約一覧を読み取り（`reconcile.yml`）、GAS でスプレッドシートと突合。
- **変更（新規 / キャンセル / 棚卸し）があった時だけ** LINE 通知。一致のみのときは無通知。
- サイトでキャンセル / 一覧から消滅した予約は、シートをキャンセル＋カレンダー予定を削除（幽霊予約の棚卸し。誤爆防止の上限つき）。

## 主なワークフロー

- `reconcile.yml` … 2時間ごとの定期突合（3サイト）
- `recount.yml` … 期間指定で各サイトの予約を読み取り集計（手動）
- `mode-*.yml` / `reduce-*.yml` … 枠モード切替・在庫減算の連動

## セットアップ / 認証

- 各OTAのログイン情報は GitHub Secrets（`JALAN_ID/PASSWORD`、`AJ_ID/PASSWORD`、`URKT_ID/PASSWORD` 等）。
- GAS 連携は `GAS_RECONCILE_URL` / `RECONCILE_TOKEN`、LINE は `LINE_CHANNEL_TOKEN` / `LINE_USER_ID`。
- GAS 側トリガーは `setupTriggers()` を1回実行して登録。詳細は `docs/design/` を参照。
