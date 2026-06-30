# ローカル環境セットアップ（Mac）

じゃらん(ACTIVITY BOARD)の操作をPlaywrightで録画するための準備手順。
ターミナル（アプリ → ユーティリティ → ターミナル）で上から順にコピペ実行。

## 1. Homebrew（未導入なら）

```bash
which brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

## 2. Node.js を入れる

```bash
brew install node
node --version   # v20以上ならOK
```

## 3. リポジトリを取得

```bash
cd ~/Desktop
git clone https://github.com/PegNaoki/sup-management.git
cd sup-management/automation
```

> 既に clone 済みなら `cd ~/Desktop/sup-management && git pull` で最新化。

## 4. 依存パッケージとブラウザを入れる

```bash
npm install
npx playwright install chromium
```

## 5. 録画開始（ここが本番）

```bash
npx playwright codegen https://activityboard.jp/
```

- ブラウザが2つ開く（操作用ウィンドウ＋コード表示ウィンドウ）
- **操作用ウィンドウで実際に手で操作する：**
  1. ログイン（ID・パスワード入力 → ログイン）
  2. 在庫管理／カレンダー画面を開く
  3. 適当な日付の枠を1つ選び、人数を1減らして保存
- 操作するたびに**右側にコードが自動生成される**

## 6. 生成されたコードを共有

右側のコード表示ウィンドウの内容を**全部コピーして、そのまま貼ってください。**
こちらで「日付・人数を変数で受け取る本番用スクリプト」に整形します。

> ⚠️ 録画中に入力したID・パスワードがコードに含まれます。
> 共有する前に、ログインID・パスワードの部分は伏せ字（xxxxx）に置き換えてください。
