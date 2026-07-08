# ウラカタ（アソビュー共通在庫）モード切替 — 明日の作業メモ

## いまの状態（準備済み）
- `automation/mode-urakata-slot.js` … **調査用スケルトン**。ログイン→予約枠→対象日→対象セル特定までは
  reduce-urakata-slot.js から流用済み。`DUMP_DOM` 相当で対象セル/行のHTMLをダンプする。
- `.github/workflows/mode-urakata.yml` … ワークフロー雛形（`mode_urakata` dispatch）。まだGASからは呼ばない。
- GAS `MODE_SITES` には **urakata 未追加**（アダプタ確定後に追加）。
- AJ・じゃらんのモード同期は本番稼働中（`MODE_SYNC_SITES=aj,jalan`）。ウラカタは影響なし。

## 最初にやること（調査）
ローカルで1回ダンプを取り、ウラカタの「即予約/リクエスト」の扱いを確認する：
```
cd automation && git pull
export URKT_ID='...'; export URKT_PASSWORD='...'
export SLOT_DATE='2026-08-08'; export SLOT_TIME='10:00'
export HEADLESS='false'
node mode-urakata-slot.js
```
ログの `dump_cell_html` / `dump_row_label_html` / `dump_cell_after_click` を見る。

## 見極めたい分岐
- **A) 即時販売在庫の数値で制御**（>0=即予約 / 0=リクエスト のような形）
  → 専用の予約タイプ切替UIは無い。**既存の在庫連動（reduce-urakata）で代替**でき、
    モード切替アダプタは不要かもしれない。この場合は「残1でリクエスト化＝在庫0にする」等の
    運用に落とし込めるか検討。
- **B) 専用の予約タイプ切替UIがある**（select/ボタン等）
  → じゃらん/AJ同様に `mode-urakata-slot.js` を本実装（読み取り＋切替＋検証）。

## ユーザーへの質問（明日確認）
1. **ウラカタ（アソビュー）に「即予約」と「リクエスト予約」の区別はある？** 管理画面のどこで設定する？
2. ある場合、それは **枠(日時)ごと**に変えられる？ それとも プラン全体？
3. **基本モード**は？（AJ/じゃらんに合わせるなら「金土日祝＝即予約系 / 平日＝リクエスト」だが、
   ウラカタはどうしている？ そもそも即予約固定？）
4. Secrets `URKT_ID` / `URKT_PASSWORD` は在庫連動で設定済みか（あればそのまま流用）。
5. アソビュー＝ウラカタ＝Web予約(satsuki) は在庫共通だが、**モードも共通**か（片方変えれば両方反映？）。

## 注意
- ウラカタは顧客向け。誤操作防止のため、必ず DRY_RUN／1枠テスト→往復（元に戻す）で検証してから本番。
- 本番投入時は `MODE_SYNC_SITES=aj,jalan,urakata` にし、GAS `MODE_SITES` に urakata を追加
  （weekendMode / stockKind を A/B の結論に合わせて設定）。
