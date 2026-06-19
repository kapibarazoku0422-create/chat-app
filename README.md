# 💬 Realtime Chat App

Node.js + Express + Socket.IO によるリアルタイムチャットアプリです。

## 機能

- 🏠 複数ルーム対応（ルーム名を入力して参加）
- 👤 ユーザーカラー自動割り当て
- ⌨️ タイピングインジケーター
- 👥 オンラインメンバー表示
- 📱 レスポンシブデザイン

## ローカル起動

```bash
npm install
npm start
# http://localhost:3000 を開く
```

開発時（ホットリロード）:
```bash
npm run dev
```

## Render へのデプロイ手順

1. このリポジトリを GitHub に push する

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

2. [Render](https://render.com) にログイン

3. **New → Web Service** をクリック

4. GitHub リポジトリを選択

5. 設定はそのままで **Create Web Service** をクリック
   - `render.yaml` が自動的に読み込まれます

6. デプロイ完了後、表示された URL にアクセス 🎉

## 技術スタック

| 役割 | ライブラリ |
|------|----------|
| サーバー | Express 4 |
| リアルタイム通信 | Socket.IO 4 |
| フロントエンド | Vanilla HTML/CSS/JS |

## 注意

Render の無料プランはサーバーが**15分間アクセスなしでスリープ**します。  
本番利用では有料プラン（$7/月〜）を推奨します。
