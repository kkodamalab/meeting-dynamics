# Meeting Dynamics

対面会議で各参加者のスマートフォンのマイクから**音量・VAD（発話状態）の特徴量だけ**を扱い、発話量を見える化する React + TypeScript アプリです。音声の録音・送信・保存は行いません。

公開 URL: https://kkodamalab.github.io/meeting-dynamics/

## 使い方

1. ホストがトップ画面で話者数、部屋レイアウト、集計オプションを選び「セッションを作成」します。
2. 参加者ごとに表示名を設定し、参加リンク（QR 化して共有可能）をスマートフォンへ渡します。
3. 参加者はリンクを開き、名前を入力して「マイクを許可」を選びます。マイク許可には HTTPS または localhost が必要です。
4. ホストが座席をドラッグ配置し、計測を開始します。終了後、概要と CSV/JSON を確認できます。

## 技術と制約

- Vite / React / TypeScript。GitHub Actions で GitHub Pages へデプロイします。
- GitHub Pages の静的画面から、別途デプロイする Cloudflare Workers + Durable Objects 中継へ接続します。
- 本番で端末間同期を使うには、下記の中継デプロイと接続先URLの設定が必要です。
- 将来候補: 端末キャリブレーション、WebRTC DataChannel、曖昧話者検出、感情推定モデル、認証付きセッション。

## リアルタイム中継と公開設定

この版は Cloudflare Workers + SQLite Durable Objects の WebSocket 中継を使います。
GitHub Pages は画面を配信し、参加者の音量/VAD・登録状態だけを中継します。
ランダムな発話デモは集計に使いません。全端末で同じ中継URLを使用します。

### ローカル開発・テスト

Node.js 22.18 以降または 24 が必要です。

```sh
npm ci
npm run relay:dev  # ターミナル1: 127.0.0.1:8787
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort  # ターミナル2
npm test           # ターミナル3: 起動済み中継に対する認証・同期・集計テスト
npm run build
```

トップ画面の中継URLに `http://127.0.0.1:8787` を入力します。
Python Playwright と Chromium がある環境では `python tests/browser_smoke.py` で
別ブラウザコンテキスト2台と実際の WebSocket 中継を使った画面連携テストを実行できます。
このテストのマイクは生成した波形です。スマートフォンの実機確認には代わりません。

### Cloudflare の本番中継

1. Cloudflare ダッシュボードでアカウントを選び、**Workers & Pages** を開きます。
   初回は Workers の `workers.dev` サブドメインを設定します。
2. **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** を選択し、
   対象アカウントの **Account / Workers Scripts / Edit** と **Account / Account Settings / Read**
   があることを確認します。トークンはチャット・Git・公開フロントエンドに置かないでください。
3. 実行環境の安全な設定に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録します。
   Account ID はアカウントの **Workers & Pages** 画面からコピーできます。
4. このリポジトリで `npm run relay:deploy` を実行します。
   `relay/wrangler.jsonc` が SQLite Durable Object の migration と `ROOMS` バインディングを作成します。
   有料プランの購入はこの手順に含みません。利用枠・プランの可否はアカウントで確認してください。
5. 出力された `https://meeting-dynamics-relay.<subdomain>.workers.dev` の `/health` にアクセスし、
   `{"ok":true}` を確認します。
6. GitHub リポジトリの **Settings → Secrets and variables → Actions → Variables → New repository variable**
   で **Name: `VITE_RELAY_URL`**、**Value: 上記の HTTPS URL（末尾の /health は除く）** を保存します。
   これは公開してよい接続先であり、認証トークンではありません。
7. **Actions → Deploy GitHub Pages → Run workflow → Branch: main → Run workflow** を実行します。
   **Settings → Pages → Build and deployment → Source** は **GitHub Actions** にします。
   完了後、公開URLで読み込まれた中継URLと通信を確認します。
   ビルド変数が未設定でも画面から実在するHTTPS中継URLを入力できます。

### 実機の確認手順

ホストでセッションを作成し、一括登録の座席上QRを別々のスマートフォン2台以上で開きます。
各スマホで表示名・マイク許可・参加登録を完了し、ホスト側の名前・登録済み・マイクOKを確認します。
「座席配置へ進む」で座席ドラッグ、テーブル移動・右下ハンドルによる変形・配置保存を確認し、計測画面へ進みます。
計測開始後、1台ずつ発話し、ホスト側の音量・VAD・発話時間が該当座席に反映されるか確認します。
停止・再開・終了・CSV/JSONを確認します。1台を閉じて切断表示、同じリンクで再接続を確認します。
スマホのバックグラウンド動作・省電力・マイク権限はOS/ブラウザに依存します。

座席配置はホストブラウザのローカルストレージへ人数・図形別に保存します。
セッションと座席リンクは推測困難な固有トークンを含みます。参加者だけに共有してください。
セッションの有効期限は12時間。中継は音声データを受け取らず、音量/VADと集計・表示名を保持します。
VAD は既存の RMS 閾値方式を維持しています（機械学習による音声識別ではありません）。
同時発話時は最大音量の1名を集計します。
