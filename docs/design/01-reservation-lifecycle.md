# 設計書 01: 予約ライフサイクルと在庫連動

SUP体験予約管理システム（GASベース）の予約イベント処理と複数OTA在庫連動の実装設計。

- 対象実装: `sup_reservation.gs` / `automation/reduce-jalan-slot.js` / `.github/workflows/reduce-slot.yml`
- 想定読者: 実装担当エンジニア
- 前提: 既存コードに接続する形で設計する。本書で「新規」と明記したもの以外は既存関数・既存列を流用する。

---

## 0. 用語と前提

| 用語 | 定義 |
|------|------|
| OTA | じゃらん遊び体験 / アクティビティジャパン / アソビュー / ウラカタ(GoRETREAT) / 直接予約 |
| 枠(スロット) | 「同一日付 × 午前/午後」または「同一日付 × 開始時刻」の予約受付単位 |
| 在庫連動 | あるOTAで予約が確定した際、同一枠を販売している他OTAの残数を調整する処理 |
| 即予約 | リクエスト承認不要で確定する予約（OTA上で在庫を持つ）|
| リクエスト予約 | 主催者の承認が必要な仮予約 |
| msgId | Gmailメッセージ固有ID（`message.getId()`）。べき等性の主キー |
| bookingNo | OTA発番の予約番号。同一予約の複数メールを束ねるキー |

手数料（参考・在庫の優先度判断に使用）: じゃらん16.5% / アクティビティジャパン16.5% / アソビュー16.5% / ウラカタ(satsuki経由)3% / 直接0%。

既存の `COLUMNS`（A〜W列）・`detectBookingType()`・`importEmails_()`・`handleCancellation()`・`updateRow()`・`appendToSheet()`・`notifySlotReduction_()` を前提とする。

---

## 1. 予約イベントの種類と判定

### 1.1 イベント分類

判定は既存 `detectBookingType(subject)`（件名キーワードのみで判定）が基点。優先順位は **キャンセル > 変更 > 確定 > 仮予約** （既存実装の評価順）。

| イベント | bookingType | 判定キーワード（既存定数） | 補足 |
|----------|-------------|---------------------------|------|
| 新規・即予約 | `確定` | `CONFIRMED_KEYWORDS`: 予約確定 / 即時確定 / 決済完了 / 予約が確定 / 予約を確定しました / 予約申込みが入りました | bookingNo未登録なら新規 |
| 新規・リクエスト予約 | `仮予約` | `TENTATIVE_KEYWORDS`: 仮予約 / 予約のリクエスト | 承認待ち |
| 予約確定（リクエスト→確定） | `確定` | 同上 | bookingNo既登録なら確定昇格 |
| 予約変更（日時/人数） | `変更` | `CHANGE_KEYWORDS`: 変更通知 / 変更されました / 内容が変更 | bookingNo既登録が前提 |
| キャンセル | `キャンセル` | `CANCEL_KEYWORDS`: キャンセル通知 / キャンセルされました / キャンセルのご連絡 / 予約取消 | |
| 不明 | `不明` | いずれも非該当 | 後述の例外処理へ |

### 1.2 新規 / 既存の判定

件名だけではイベント全体は決まらない。`bookingNo` の照合で新規か既存更新かを分岐する（既存 `importEmails_` ロジック）。

```
bookingType = detectBookingType(subject)
r           = parseEmail(message)              // サイト別パーサ
existingRow = r.bookingNo ? byBookingNo.get(r.bookingNo) : null

if bookingType == 'キャンセル':
    existingRow ? handleCancellation : 無視（取消対象が無い）
elif existingRow:
    updateRow（変更 / 確定昇格 / 再送の上書き）
else:
    appendToSheet（新規行）
```

### 1.3 イベント種別の精緻化（新規・推奨）

件名キーワードだけでは「日時変更」と「人数変更」を区別できない。`変更` の場合は本文パース結果 `r` と既存行を比較して差分種別を導出する（在庫差分調整で必要）。

```
function classifyChange_(prevRow, r):
    changes = []
    if normalizeSlotDate_(r.date) != normalizeSlotDate_(prevRow.date): changes += 'DATE'
    if slotLabel(r.time)         != slotLabel(prevRow.time):          changes += 'TIME'
    if int(r.people)             != int(prevRow.people):             changes += 'PEOPLE'
    return changes   // [] なら実質変更なし（通知の文面調整のみ）
```

`不明` は件名がどのキーワードにも一致しないケース。新規としては扱わず（誤登録防止）、ログ＋（任意で）LINEに「要確認」通知を出すに留める。**判定: 現状は `appendToSheet` に進むと `bookingType='不明'` のまま新規登録される。これは要修正候補（§7参照）。**

---

## 2. 各イベント発生時の処理フロー

各イベントで実行する4ステップ（◯=実行 / −=スキップ / △=条件付き）。

| イベント | ①シート | ②カレンダー | ③在庫連動 | ④LINE通知 |
|----------|---------|------------|-----------|-----------|
| 新規・即予約(確定) | ◯ append | △ 別バッチで作成 | ◯ 他OTA減算 | ◯ 確認通知/要対応 |
| 新規・リクエスト(仮予約) | ◯ append | − | △ 即予約枠の引当（§3.4）| ◯ 仮予約通知 |
| 確定昇格(仮→確定) | ◯ update | △ 別バッチ | ◯ 他OTA減算（未実施なら）| ◯ 確認通知 |
| 変更(日時) | ◯ update | △ 要再作成 | ◯ 旧枠+戻し / 新枠−減算 | ◯ 変更通知 |
| 変更(人数) | ◯ update | △ 説明更新 | ◯ 差分のみ調整 | ◯ 変更通知 |
| キャンセル | ◯ update(STATUS=キャンセル) | ◯ event.delete | ◯ 他OTA加算(戻し) | ◯ キャンセル(強制再送) |

> カレンダー作成は `importEmails_` 内では行わず、`registerApprovedToCalendar()`（毎時トリガー、STATUS='承認済' かつ U列空 のみ）が担う。確定は `initialStatus()` で `承認済` になるため自動でカレンダー化される。

### 2.1 新規・即予約（確定）

```
appendToSheet(sheet, r, msgId, subject, '確定')
    └ STATUS = resolveStatus('確定', r)        // 日時/人数欠落なら'要確認'
    └ INSTRUCTOR_NEEDED = resolveInstructor(r.people)   // >=6名で'必要'
    └ sendLineNotification(確認通知 or 要対応)
notifySlotReduction_(r)                          // ③ 他OTA減算（じゃらん発は除外）
--- 別トリガー（registerApprovedToCalendar）---
STATUS=='承認済' かつ U列空 → calendar.createEvent → STATUS='カレンダー登録済', U=eventId
```

### 2.2 新規・リクエスト予約（仮予約）

```
appendToSheet(... '仮予約')
    └ STATUS = '未対応'（resolveStatus→initialStatus）
    └ LINE: '仮予約' 通知（承認操作の喚起）
※ 既存実装では importEmails_ が仮予約でも notifySlotReduction_ を呼ぶ。
   → 仮予約段階で他OTAを減らすかは運用判断（§7 未決）。
   本設計の推奨: 仮予約では減算せず、確定昇格時に減算する（過剰減算防止）。
```

### 2.3 変更（日時 / 人数）

```
updateRow(sheet, existingRow, r, msgId, subject, '変更')
    └ STATUS は 'カレンダー登録済'/'キャンセル' なら維持、それ以外は再評価
    └ 各フィールドを上書き（空値は上書きしない＝既存実装の挙動）
changes = classifyChange_(prevSnapshot, r)       // ※updateRow前にprevを退避
if 'DATE' in changes or 'TIME' in changes:
    adjustSlotInventory_(old={prevDate,prevTime,prevPeople}, new={r.date,r.time,r.people})
    if U列(カレンダーID)あり: カレンダーイベントの日時更新 or 一旦削除→再登録
elif 'PEOPLE' in changes:
    delta = newPeople - prevPeople
    adjustSlotInventory_(sameSlot, delta)         // +なら他OTA減算 / −なら戻し
sendLineNotification('変更')
```

> 実装注意: 既存 `updateRow` は先に行を上書きしてしまうため、`prevDate/prevTime/prevPeople` は **更新前に** `sheet.getRange(...).getValues()` でスナップショットを取得すること。

### 2.4 キャンセル（既存 `handleCancellation` 拡張）

```
handleCancellation(sheet, rowNum, msgId, subject):
    STATUS = 'キャンセル', TIMESTAMP/SUBJECT/MESSAGE_ID 更新
    if U列(calEventId): calendar.getEventById().deleteEvent(); U=''
    ─ 新規追加 ─
    restoreSlotInventory_(canceledRow)            // ③ 他OTAの枠を戻す(プラス)
    sendLineNotification('キャンセル', forceResend=true)   // 既通知でも再送
```

---

## 3. 在庫連動ロジック

### 3.1 基本原則

- **販売元サイトの在庫は触らない。** 予約はそのサイト自身が既に減算済みのため。
  - 既存 `notifySlotReduction_` は `r.site.includes('じゃらん')` を除外。→ 一般化が必要（§3.3）。
- **減算対象は「他OTAのうち、ブラウザ自動操作が可能なサイト」。** 現状の自動操作実装はじゃらん(`reduce-jalan-slot.js`)のみ。他OTAは手動またはLINE通知での運用補完。
- 在庫操作の実体は GAS → `repository_dispatch(event_type='reduce_slot')` → GitHub Actions → Playwright。

### 3.2 減算フロー（予約確定時）

```
GAS: notifySlotReduction_(r)
  ├ SLOT_SYNC_ENABLED != 'true' → 何もしない（既定OFF・安全側）
  ├ slot_date = normalizeSlotDate_(r.date)   // YYYY-MM-DD
  ├ slot_time = r.time                        // HH:MM
  ├ slot_decrement = int(r.people)
  ├ 販売元サイト判定で除外（§3.3）
  └ POST /repos/{repo}/dispatches
       client_payload = {slot_date, slot_time, slot_decrement, dry_run, source_site}

GitHub Actions (reduce-slot.yml) → node automation/reduce-jalan-slot.js
  ├ assertConfig（必須env・MAX_DECREMENT上限チェック）
  ├ ログイン→店舗選択→予約販売管理
  ├ locateDateColumn(date) / locateSlotCell(time, col)
  ├ before = readStock(cell)
  ├ target = max(0, before - decrement)
  └ dryRun ? 確認のみ : minusボタンを decrement 回クリック → after検証
```

### 3.3 販売元除外の一般化（新規）

現状はじゃらんのみハードコード除外。減算自動操作の対象サイトを定義し、「予約元 == 操作対象サイト」のときだけスキップする形へ拡張する。

```
// 自動減算が可能なサイト（操作実装があるもの）
const SYNC_TARGETS = ['じゃらん'];   // 将来 'アソビュー' 等を追加

function siteSyncKey_(site):
    if site.includes('じゃらん')   return 'じゃらん'
    // 他サイト追加時にここへ
    return null

function targetsToReduce_(sourceSite):
    return SYNC_TARGETS.filter(t => t != siteSyncKey_(sourceSite))
// → reduce_slot dispatch を対象サイトごとに発火（現状は1件）
```

### 3.4 キャンセル・変更時の調整（新規）

`reduce-jalan-slot.js` は減算専用。**枠を戻す（プラス）** には `.stepper-button-plus` を押すモードが必要。`client_payload` に操作方向を追加する。

```
// dispatch payload 拡張
client_payload = {
  slot_date, slot_time,
  slot_delta: "+3" | "-3",      // 符号付き。＋=戻し / −=減算
  dry_run, source_site
}

// reduce-jalan-slot.js（拡張）
const delta = parseInt(process.env.SLOT_DELTA, 10);     // 符号付き
const dir   = delta < 0 ? 'minus' : 'plus';
const count = Math.abs(delta);
const button = cell.locator(dir == 'minus' ? '.stepper-button-minus' : '.stepper-button-plus');
for i in 0..count: button.click()
// 戻しは上限チェック不要だが、max(0, ...)ガードは減算側のみ適用
```

| イベント | 旧枠 | 新枠 | 操作 |
|----------|------|------|------|
| 確定 | − | 当該枠 −people | minus × people |
| キャンセル | 当該枠 +people | − | plus × people |
| 人数変更(増) | − | 当該枠 −delta | minus × delta |
| 人数変更(減) | 当該枠 +delta | − | plus × delta |
| 日時変更 | 旧枠 +oldPeople | 新枠 −newPeople | plus(旧) + minus(新) を2回dispatch |

実装ヘルパ:

```
function adjustSlotInventory_(old, neu):
    if old.slotKey == neu.slotKey:               // 同一枠＝人数のみ変動
        delta = old.people - neu.people          // 減ったぶん＝戻し(+)
        if delta != 0: dispatchSlot_(neu, +delta? minus/plus)
    else:                                          // 日時変更
        dispatchSlot_(old, +old.people)           // 旧枠を戻す
        dispatchSlot_(neu, -neu.people)           // 新枠を減らす

function restoreSlotInventory_(row):
    dispatchSlot_(row, +row.people)
```

### 3.5 即予約 → リクエスト予約への切替運用（残数僅少時）

残数が僅少になった枠で、ダブルブッキングを避けるため即予約販売を停止しリクエスト承認制に切り替える運用。在庫を「0」または「非常に少なく」見せることで、OTA上は即時確定させず主催者承認を挟む。

判定基準（容量ベース・既存 `getSlotCapacity` / `checkCapacityWarnings` を流用）:

```
slotInfo = getSlotCapacity(sheet, date, time)   // {total, limit}
remaining = slotInfo.limit - slotInfo.total

if remaining <= SWITCH_THRESHOLD (例:2):
    → その枠を「リクエスト予約モード」へ切替（新規フラグ列で管理）
    対応1（自動）: 全自動操作対象OTAの該当枠 在庫を 0 に減算（即予約不可化）
    対応2（手動）: OTA管理画面で「リクエスト受付」設定へ（自動操作未対応サイト）
    LINE通知: 「{date}{slot} 残{remaining}名・リクエスト制へ切替推奨」
```

- 切替状態の保持: シートに新規列 `SLOT_MODE`（即予約 / リクエスト）を持つ、または専用の枠管理シート（§7）。最小実装としては LINE通知＋手動操作で開始し、自動化は後続フェーズ。
- 切替後にキャンセルで残数が回復したら、`remaining > SWITCH_THRESHOLD` で即予約モードへ戻す（在庫を戻す plus 操作）。

---

## 4. べき等性・重複防止

### 4.1 メール単位の重複防止（既存）

- `loadExistingReservations` が `byMsgId: Set` を構築。`importEmails_` は処理冒頭で `if (existing.byMsgId.has(msgId)) return;` → **同一メールは二度処理しない**。
- 処理済みスレッドには `PROCESSED_LABEL`（'SUP予約/処理済'）を付与。ただしラベルはスレッド単位・msgIdは行記録単位の二段構え。

> 注意: msgId は `appendToSheet`/`updateRow`/`handleCancellation` で V列に記録される。新規でも更新でも必ず最新の msgId が書かれるため、`byMsgId` は「最後に処理したメール」を保持する。**同一予約の複数メール（仮→確定→変更）はそれぞれ別 msgId なので個別に処理される（正しい）。**

### 4.2 在庫の二重減算防止（要強化・新規）

現状、在庫減算の冪等性は GAS 側に無い（dispatch を投げるだけ）。以下を追加する。

```
新規列 SLOT_SYNCED (X列想定): 在庫連動の実行記録
  値例: "REDUCE:じゃらん:-3@2026-06-30T10:00"（複数はカンマ区切り）

dispatchSlot_(row, delta, targetSite) 実行前:
  key = `${op}:${targetSite}:${delta}@${slotKey}`
  if SLOT_SYNCED に同一 key が含まれる: skip（二重実行防止）
  dispatch 成功(204) 後に key を追記
```

- 失敗時（204以外）は key を記録しない → 次回トリガーで再試行される。
- GitHub Actions 側は単発操作（before→target検証あり）なので、同一 dispatch が二度走ると二重減算する。**よって冪等性は GAS の `SLOT_SYNCED` 記録で担保するのが必須。**
- LINE通知の重複防止は既存 `LINE_NOTIFIED`(W列) + `sendLineNotification` の種別チェックで担保済み（`forceResend` でキャンセルのみ再送）。

### 4.3 bookingNo の役割

- 同一予約の追跡キー。仮予約→確定→変更が同 bookingNo で来れば `updateRow` で同一行を更新（行が増殖しない）。
- bookingNo が空のメール（パース失敗）は `existingRow=null` となり常に新規追加される → 重複行リスク。§7 で対処。

---

## 5. 競合・例外処理

### 5.1 ダブルブッキング（同一枠の超過）

複数OTAが同時に最後の枠を売ると物理キャパを超える。

- 検知: `getSlotCapacity` / `checkCapacityWarnings` が `total >= limit` で警告。`buildLineMessage` は `超過N名` と表示。
- 対応:
  1. 取込時に超過を検知したら LINE で `要対応` 通知（既存の容量警告を即時通知化）。
  2. 残数僅少で §3.5 のリクエスト制切替を先行発動し、そもそも超過を起こさせない（予防）。
  3. 既に超過した場合は主催者がいずれかの予約を手動でキャンセル/別枠調整。システムは自動キャンセルしない（誤判定リスク回避）。

### 5.2 在庫操作失敗時のリトライ / ロールバック

| 失敗箇所 | 検知 | 対応 |
|----------|------|------|
| dispatch POST 失敗 (非204) | `notifySlotReduction_` の戻りコード | `SLOT_SYNCED` に記録しない → 次トリガーで再試行（最大N回、`SLOT_SYNC_RETRY` カウント列） |
| Playwright で対象日/枠が見つからない | スクリプトが return + screenshot | 在庫未変更。Actions失敗を Webhook/メールで主催者へ通知（要追加）。手動対応 |
| 減算後 after != target | スクリプトが警告ログ | 自動ロールバックはしない（誤操作助長を避ける）。LINE/Slackへ手動確認依頼 |
| 並行 dispatch の競合 | 同一枠を同時操作 | GitHub Actions の `concurrency: group=slot-{date}-{time}` で直列化（§7・要設定） |

ロールバック方針: **在庫操作の自動ロールバックは行わない。** ブラウザ自動操作の失敗を自動操作で打ち消すと状態が読めなくなるため、失敗は「人へエスカレーション」を基本とする。`dry_run` 既定ON + `MAX_DECREMENT` 上限 + before/after検証で被害を限定する。

### 5.3 人数が枠を超える場合

- 単一予約の人数 > 枠上限（例: 1件で10名、上限8名）:
  - `resolveInstructor`（>=6名で追加インストラクター必要）とは別に、`people > limit` で LINE `要対応（枠超過）` 通知。
  - 在庫減算は `target = max(0, before - decrement)` で残数0で停止（負にしない・既存実装）。実残数とのズレは after検証ログで顕在化。
- パース失敗で people 欠落: `resolveStatus` が `要確認` を返し、`resolveLineNotifyType` が `要確認（情報不足）` を通知。在庫連動は `notifySlotReduction_` が `!people` でスキップ（既存）。

### 5.4 不明イベント・パース失敗

- `bookingType='不明'`: 件名がキーワード非該当。新規登録は避け、`要確認` 行として記録 or ログのみ（§7 で確定）。
- サイト判定不能（`parseEmail` が null）: `importEmails_` で `if (!r) return;`（既存）。スレッドにはラベルが付くため、取りこぼし防止に未ラベルの不明メールを定期レポート（任意）。

---

## 6. 処理シーケンス全体図（疑似コード）

```
importEmails_(limit):
  for thread in search(SEARCH_QUERY):
    for message in thread:
      msgId = message.getId()
      if byMsgId.has(msgId): continue                 # §4.1 冪等
      type = detectBookingType(subject)               # §1
      r    = parseEmail(message); if !r: continue
      row  = byBookingNo.get(r.bookingNo)

      switch type:
        キャンセル:
          if row: prev=snapshot(row); handleCancellation(row)
                  restoreSlotInventory_(prev)          # §3.4
        変更:
          if row:
            prev = snapshot(row)
            updateRow(row, r, type)
            changes = classifyChange_(prev, r)         # §1.3
            if DATE/TIME/PEOPLE in changes:
              adjustSlotInventory_(prev, r)            # §3.4
        確定 / 仮予約:
          if row:
            updateRow(row, r, type)                    # 仮→確定 昇格等
            if type=='確定' and not synced(row):
              dispatchReduce_(r)                       # §3.2 (推奨: 確定時のみ)
          else:
            appendToSheet(r, type)                     # 新規
            if type=='確定': dispatchReduce_(r)
        不明:
          logUnknown(message)                          # §5.4
    thread.addLabel(PROCESSED_LABEL)
  checkCapacityWarnings(sheet)                          # §5.1
```

---

## 7. 設計上の未決事項・要確認事項

- **仮予約段階で他OTA在庫を減らすか**: 既存 `importEmails_` は仮予約でも `notifySlotReduction_` を呼ぶ。本設計の推奨は「確定時のみ減算」。運用方針の最終決定が必要。
- **`bookingType='不明'` の扱い**: 現状そのまま新規登録される。`要確認`行として隔離するか、ログのみで無視するか確定が必要。
- **bookingNo 欠落メールの重複防止**: bookingNo が空だと毎回新規行になる。代替キー（氏名+日時+サイト）でのマッチング導入を検討。
- **在庫の戻し(plus)操作**: `reduce-jalan-slot.js` は減算専用。`.stepper-button-plus` のセレクタ確認と `SLOT_DELTA`（符号付き）対応の実装が必要。じゃらん画面に plus ボタンが存在するか要DOM確認。
- **`reduce-slot.yml` の payload**: 現状 `slot_decrement`（正の減算数）。`slot_delta`（符号付き）への移行に伴い workflow と GAS 双方の改修が必要。後方互換の扱いを決める。
- **自動操作対象OTAの拡大**: 現状じゃらんのみ。アソビュー/アクティビティジャパン/アクティビティボード以外の在庫操作を自動化するか、手動運用＋LINE通知に留めるか。
- **冪等性記録列（SLOT_SYNCED / SLOT_SYNC_RETRY / SLOT_MODE）の追加**: 新規列の採番（X列以降）と `getOrCreateSheet` のヘッダ・`COLUMNS` 定義更新が必要。
- **GitHub Actions の並行制御**: 同一枠への同時 dispatch を `concurrency` グループで直列化する設定が未定。
- **Actions 失敗の通知経路**: Playwright が枠を見つけられない/after不一致の際、主催者へ届く通知（LINE/メール/Slack）が未実装。
- **DATE_HEADER_SELECTOR / NEXT_BUTTON_SELECTOR の確定**: `reduce-jalan-slot.js` のセレクタは録画ベースで暫定。本番DOMでの確定が必要（コメントに明記済み）。
- **`registerApprovedToCalendar` と日時変更の整合**: 日時変更時、既存カレンダーイベントを update するか delete→再作成するか未確定（U列の再利用方針）。
- **午前/午後以外の枠粒度**: 在庫連動は開始時刻(HH:MM)単位、容量警告は午前/午後単位で粒度が異なる。整合させるか役割分担を明文化するか要確認。
