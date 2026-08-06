# Sakana Namazu 実装レポート

**日付**: 2026-08-06  
**対象**: comment-channel への Sakana Namazu (sakana-namazu-v1.0) 対応

---

## 1. Sakana Namazu 概要

[Sakana Namazu](https://console.sakana.ai/models?model=sakana-namazu) は、Sakana AI が提供する日本語特化 LLM。2026年8月3日に API 提供が開始された。

- **モデルID**: `sakana-namazu-v1.0` (エイリアス: `sakana-namazu`)
- **ベースモデル**: Moonshot AI のオープンモデル「Kimi K2.6」に独自の事後学習を適用
- **コンテキストウィンドウ**: 256K tokens
- **API**: Chat Completions / Responses / Anthropic Messages 互換
- **特徴**: Web検索・コード実行のビルトインツール、画像入力対応
- **[料金](https://console.sakana.ai/pricing)**:
  | トークン種別 | 価格 (1M tokens) |
  |---|---|
  | 入力 | $0.95（約 ¥152） |
  | 出力 | $4.00（約 ¥640） |
  | Web検索 | $7.00 / 1,000回 |

---

## 2. 実装のポイント

### 2.1 アーキテクチャ

```
[ブラウザ] → [Lambda Function URL] → [Sakana API (api.sakana.ai)]
                ↑ CORS対応 + 暗号化コンテンツ除去
```

GPT/Gemini はブラウザから直接 API を呼び出せるが、Sakana Namazu は **CORS 非対応** のため、AWS Lambda (Function URL) による中継が必要だった。

### 2.2 コード実装

`llm.js` に以下の関数を追加:

- `callSakana()` — Responses API (`/v1/responses`) を使ったコメント生成
- `searchSakanaWeb()` — ビルトイン `web_search` ツールによる背景検索
- `callSakanaProxy()` — Lambda プロキシ経由の共通呼び出し
- `extractSakanaResponse()` — Responses API の output からテキスト抽出

### 2.3 インフラ

- `lambda/llm-proxy/index.py` — Sakana API 中継 Lambda
- `template.yaml` — Function URL (CORS + AuthType: NONE) で公開
- タイムアウト: 180秒（Web検索の複数 reasoning に対応）

---

## 3. はまったポイント（GPTはすぐ動いたのに、なぜ Sakana は苦戦したのか）

### 3.1 CORS → API Gateway → Function URL への移行

**問題**: Sakana API はブラウザからの CORS リクエストに非対応（`OPTIONS` に 405）。

当初 API Gateway で中継したが、API Gateway の統合タイムアウト上限（29秒）に阻まれ、Web検索が完了しなかった。Lambda Function URL に切り替えることでこの制限を回避した。

しかし Function URL は API Gateway と異なり、Lambda の戻り値 `{ statusCode, body }` を **ラップせずに `body` をそのまま HTTP レスポンスとして返す**。API Gateway 時代のアンラップ処理 (`JSON.parse(wrapper.body)`) が逆効果となり、全レスポンスが `undefined` になるバグが発生。この仕様差に気づくまでに時間を要した。

### 3.2 CORS ヘッダー競合

Function URL の `Cors` 設定と Lambda ハンドラ内の `Access-Control-Allow-Origin: *` が競合し、`'*, https://comment-channel.okamomedia.tokyo'` という不正なヘッダー値が生成された。Lambda 側の CORS ヘッダーを全削除し、Function URL の Cors 設定に一元化して解決。

### 3.3 レスポンスの巨大化

Sakana Namazu の Responses API レスポンスには `namazu_encrypted_content` という巨大な暗号化フィールドが含まれ、ブラウザへの転送中にコネクションが破綻。Lambda で再帰的にこのフィールドを除去する `_strip_encrypted_content()` を実装した。

### 3.4 マークダウンコードフェンス

Sakana Namazu は JSON 出力を ` ```json\n{...}\n``` ` とマークダウンコードフェンスで包んで返す。`JSON.parse()` 前にコードフェンスを除去する正規表現処理を追加。

### 3.5 reasoning トークンの暴食（最大の課題）

**これが GPT との最大の差**。GPT-5.6-luna も reasoning を使うが、OpenAI は `reasoning.effort` パラメータで制御可能であり、かつ `output_text` と `reasoning` が明確に分離されている。

Sakana Namazu は:
1. `reasoning.effort` のような制御パラメータがない
2. 出力トークンの**全量を reasoning に消費**し、`status: "incomplete"` (reason: `max_output_tokens`) で打ち切られる
3. 最終回答の `message.output_text` が生成されず、空レスポンスになる

**解決策**: `callSakana()` 内で `max_output_tokens` を `元の値 + 8192`（最低 4096）に自動増強。Web検索にも同様のヘッドルームを適用。

| 呼び出し | 元の値 | 増強後 |
|---|---|---|
| 返信 | 256 | 8,448 |
| コメント | 512 | 8,704 |
| 要約 | 512 | 8,704 |
| Web検索 | 2,048 | 10,240 |
| ペルソナ生成 | 16,384 | 24,576 |

根本的には、Sakana Namazu の reasoning が過剰に冗長であることが原因。50文字の返信を生成するのに 700+ tokens の思考を展開している。

### 3.6 思考過程のリーク

`extractSakanaResponse()` に reasoning フォールバックを入れたところ、コメント本文に「ユーザは○○というペルソナで…」という思考過程がそのまま表示される問題が発生。コメント生成時は reasoning を無視し `output_text` のみを使用するよう修正した。

### 3.7 中国語由来の文字混入

Sakana Namazu はベースモデルに中国発の Kimi K2.6 を使用しているため、まれに中国語の文字がコメント本文に混入する。

**実例**:
> 愛国おやじさん、基盤モデルから作る**才叫**国産とおっしゃいますが…

「才叫」（〜して初めて〜と呼べる）は中国語由来で、日本語として不自然。

GPT-5.6 Luna や Gemini ではこの種の文字単位ノイズは見られない。日本語事後学習の限界を示唆しており、Sakana AI のモデルアップデートに期待。

---

## 4. 3モデル比較

**対象記事**: [Sakana AI、日本に特化したAIモデル「Sakana Namazu」提供開始](https://news.yahoo.co.jp/articles/9312e8ea05c4ab7d3fc89a0a34caed5c8c35df71)  
**条件**: 10人、Yahooコメント風、同一地域設定

### 4.1 コスト・トークン数

| モデル | 入力 tokens | 出力 tokens | コスト | 体感速度 |
|---|---|---|---|---|
| **Gemini 3.1 Flash-Lite** | 26,480 | 1,448 | **$0.009** | ⚡ 最速 |
| **GPT-5.6 Luna** | 30,566 | 2,287 | **$0.009** | 🐢 やや遅い |
| **Sakana Namazu** | 37,443 | 51,590 | **$0.242** | 🐢🐢 最も遅い |

**Sakana Namazu のコストが約27倍**なのは、出力トークンの大半（約95%）が reasoning に消費されているため。実際のコメントテキスト部分だけを見れば数百トークンだが、思考過程を含めた `output_tokens` が 51K に達している。

> 2026-08-07 再計測（返信 10件含む）: 入力 37,443 / 出力 51,590 tokens → $0.242。
> reasoning ヘッドルーム +8192 tokens 増強により全件正常生成。

### 4.2 コメント品質

各モデルの生成結果 HTML:
- [Gemini](https://okamoto53515606.github.io/comment-channel/20260806_gemini-3.1-flash-lite.html)
- [GPT-5.6 Luna](https://okamoto53515606.github.io/comment-channel/20260806_gpt-5.6-luna.html)
- [Sakana Namazu](https://okamoto53515606.github.io/comment-channel/20260806_sakana-namazu-v1.0.html)

| | Gemini | GPT-5.6 Luna | Sakana Namazu |
|---|---|---|---|
| 日本語の自然さ | ✅ Yahoo感のある感情表現 | △ 分析的・ビジネスライク | ✅ 自然な日本語、豊かな語彙（まれに中国語文字混入） |
| ペルソナの反映 | ✅ 多様性あり | △ やや画一的 | ✅ 職業・国籍の反映が豊か |
| 議論の白熱度 | ✅ 喧嘩腰で盛り上がる | △ 冷静すぎる | ✅ 批判・反論が自然 |
| コスト効率 | ✅ 最良 | ✅ 良好 | ❌ reasoning 過剰で割高 |
| 速度 | ✅ 最速 | △ | ❌ 最も遅い |

### 4.3 総評

| モデル | 適した用途 |
|---|---|
| **Gemini 3.1 Flash-Lite** | コスパ・速度重視。このユースケースの第一選択 |
| **GPT-5.6 Luna** | OpenAI エコシステムとの統合。Web検索は深いが速度難 |
| **Sakana Namazu** | 日本語品質は最高。ただし reasoning 過剰のため、現状はコスト高。reasoning 制御が可能になれば化ける可能性あり |

---

## 5. 技術的教訓

1. **Function URL vs API Gateway**: レスポンスのラップ形式が異なる。切り替え時は全コールパスを確認すること。
2. **CORS 設定の一元化**: 複数レイヤー（インフラ + アプリ）での CORS 設定は競合の元。
3. **reasoning モデルの出力バジェット**: `max_output_tokens` には reasoning + answer の合計が必要。reasoning の消費量を見積もって 2〜5 倍のマージンを取るべき。
4. **API レスポンスのサイズ**: 暗号化コンテンツなど、フロントエンドに不要なフィールドはプロキシで除去する。
