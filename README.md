# 💬 comment-channel

**AI多様性コメントジェネレーター** — ニュース記事や技術記事に対して、複数のAIペルソナが多様な視点でコメントを生成するブラウザ完結型ツール。

> ⚠️ すべてのコメントはAIによって生成されています。実在の人物・団体の意見ではありません。
> 🔒 生成結果はブラウザ内でのみ表示され、サーバーには一切保存・公開されません。

---

## 🏗 アーキテクチャ

```
[ブラウザ (SPA)]
  ├── 記事URL入力 → API Gateway → Lambda (記事プロキシ) → 記事取得
  ├── APIキー入力（ブラウザ内のみ保持、サーバー非送信）
  ├── ペルソナ生成（Gemini API @ ブラウザ）
  ├── コメント生成（Gemini API @ ブラウザ、逐次処理＋ライブ表示）
  └── 結果表示 → 📋 HTMLコピー / 💾 HTMLダウンロード

[AWS サーバーレス]
  ├── S3 + CloudFront: フロントエンド静的ホスティング
  ├── API Gateway: REST API (fetch-article のみ)
  ├── Lambda: article-proxy（記事URL取得、CORS回避）
  └── DynamoDB: レート制限
```

---

## 🔒 セキュリティ

| 対策 | 内容 |
|---|---|
| **APIキー非送信** | APIキーはブラウザのメモリ内のみ、サーバーに一切送信しない |
| **データ非保存** | 生成結果はすべてブラウザ内で完結、サーバー保存なし |
| **レート制限** | 同一IPから1時間に10回まで（記事取得API） |
| **ドメインブロック** | アダルト・犯罪関連ドメインをブロック |
| **CORS制御** | API Gatewayで `comment-channel.okamomedia.tokyo` のみ許可 |
| **CloudFront OAC** | S3への直接アクセス禁止、CloudFront経由のみ |

---

## 📁 プロジェクト構造

```
comment-channel/
├── frontend/                    # SPA (S3 + CloudFront 静的ホスティング)
│   ├── index.html               # メイン入力画面
│   ├── css/style.css            # スタイル
│   ├── js/
│   │   ├── config.js            # ★デプロイ時に自動生成（API URL）
│   │   ├── utils.js             # ユーティリティ + APIプロキシ呼び出し
│   │   ├── llm.js               # Gemini API 呼び出し
│   │   ├── personas.js          # ペルソナ動的生成
│   │   ├── comments.js          # コメント生成エンジン
│   │   └── app.js               # メインアプリロジック
│   └── personas/
│       └── country-data.js      # 国・地域データ (9地域47カ国)
├── lambda/
│   └── article-proxy/           # 記事取得プロキシ (Python)
├── template.yaml                # AWS SAM テンプレート
├── scripts/deploy.sh            # デプロイスクリプト
└── README.md
```

---

## 🚀 デプロイ

### 前提条件
- AWS CLI 設定済み (`aws configure`)
- AWS SAM CLI インストール済み
- Python 3.12+

### デプロイ手順

```bash
cd comment-channel

# SAMビルド＆デプロイ
sam build --region ap-northeast-1
sam deploy \
    --stack-name comment-channel \
    --region ap-northeast-1 \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
    --parameter-overrides "CloudFrontDomain=comment-channel.okamomedia.tokyo AcmCertificateArn=arn:aws:acm:us-east-1:..." \
    --resolve-s3

# フロントエンドアップロード（--delete なし。生成データはLambdaで管理されないため不要）
aws s3 sync frontend/ s3://comment-channel-pages-<ACCOUNT_ID>/ \
  --region ap-northeast-1 \
  --cache-control "public, max-age=3600" \
  --exclude "pages/*" --exclude "202*/*"
```

---

## 🎮 使い方

1. **記事URLを入力** → 「記事を取得する」ボタン
2. **APIキーを入力**（Gemini APIキー、ブラウザ内のみで使用）
3. **ペルソナ設定**:
   - 人数 (1〜100人、デフォルト10)
   - 議論の傾向（論客重視 / カジュアル / 炎上寄り）
   - 対象地域（複数選択可、9地域から）
4. **免責事項確認 → 生成開始**
5. 生成中のコメントを**ライブ表示**で確認
6. 完了後、**📋 HTMLをコピー** または **💾 HTMLをダウンロード**

---

## 💰 コスト目安

| 項目 | 概算 |
|---|---|
| Gemini 3.1 Flash-Lite (10人) | 約 $0.01 〜 $0.03 USD |
| AWS Lambda (記事プロキシ) | ほぼ無料枠内 |
| S3 + CloudFront | 月数ドル程度 |

---

## 📝 モデル

| モデル | 状態 |
|---|---|
| Gemini 3.1 Flash-Lite | ✅ 利用可能 |
| Claude Haiku 4.5 | 🔜 準備中 |
| GPT-5.6 Luna | 🔜 準備中 |

---

## ⚠️ 注意事項

- すべてのコメント・返信はAIが生成したものです
- アダルト・犯罪関連のURLはブロックされます
- APIキーはブラウザ内でのみ使用され、サーバーには一切送信されません
- 生成結果はブラウザ内でのみ表示され、サーバーには保存されません
- コメントの正確性・品質は保証されません
