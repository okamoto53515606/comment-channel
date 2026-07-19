// ===== LLM API 呼び出し (ブラウザ内でGemini APIを直接呼ぶ) =====

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 選択モデル
const MODEL_ID = 'gemini-3.1-flash-lite';

// モデル情報: {modelId, inputPricePerM, outputPricePerM}
const MODEL_PRICING = {
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
  'claude-haiku-4-5':      { input: 1.00, output: 5.00 },
  'gpt-5.6-luna':          { input: 1.00, output: 6.00 },
};

// Gemini API呼び出し（非ストリーミング）
async function callGemini(apiKey, systemPrompt, userPrompt, options = {}) {
  const { temperature = 0.9, maxOutputTokens = 1024 } = options;

  const contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: '了解しました。' }] });
  }
  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens,
      topP: 0.95,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const resp = await fetch(
    `${GEMINI_API_BASE}/models/${MODEL_ID}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    let errMsg;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson?.error?.message || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`Gemini API エラー: ${errMsg}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // 使用量メタデータ
  const usage = data?.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;

  return { text, inputTokens, outputTokens };
}

// Google Search Grounding: 記事の背景情報をWEB検索で取得
// Gemini 2.5 Flash-Lite ($0.1/$0.4 per 1M tokens) + Google Search ($14/1K queries, 5K free/month)
const GROUNDING_MODEL_ID = 'gemini-2.5-flash-lite';

async function searchGoogleGrounding(apiKey, articleTitle, articleText) {
  const systemPrompt = `あなたは調査アシスタントです。与えられた記事について、Google検索を使って最新の関連情報や背景を調査してください。`;

  const userPrompt = `以下のニュース記事について、Google検索で関連情報を調査し、以下の項目を日本語でまとめてください。

## 記事タイトル
${articleTitle || '（不明）'}

## 記事本文（先頭部分）
${articleText.substring(0, 3000)}

## 出力形式（厳守）
以下のJSON形式のみを返してください。

{
  "background": "この記事のトピックに関する背景情報・時系列（100〜200文字）",
  "relatedFacts": ["関連する重要な事実1", "関連する重要な事実2", "関連する重要な事実3"],
  "publicOpinion": "このトピックに関する世論の主な分かれ目・論点（100〜200文字）",
  "recentDevelopments": "直近の関連ニュース・展開（100〜200文字）"
}`;

  const body = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: '了解しました。Google検索で関連情報を調査します。' }] },
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      topP: 0.95,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const resp = await fetch(
    `${GEMINI_API_BASE}/models/${GROUNDING_MODEL_ID}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    let errMsg;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson?.error?.message || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`Google検索連携エラー (${GROUNDING_MODEL_ID}): ${errMsg}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // 検索結果の参照URLを抽出
  const groundingMetadata = data?.candidates?.[0]?.groundingMetadata || {};
  const searchEntryPoint = groundingMetadata?.searchEntryPoint?.renderedContent || '';
  const groundingSupports = groundingMetadata?.groundingSupports || [];
  const sources = groundingSupports.map(s => ({
    url: s?.segment?.endInfo?.uri || '',
    title: s?.segment?.endInfo?.title || '',
  })).filter(s => s.url);

  // JSONパースを試みる
  let result;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    // JSONパース失敗時はテキストをそのままbackgroundとして扱う
    result = {
      background: text.substring(0, 300),
      relatedFacts: [],
      publicOpinion: '',
      recentDevelopments: '',
    };
  }

  const usage = data?.usageMetadata || {};
  return {
    background: result.background || '',
    relatedFacts: result.relatedFacts || [],
    publicOpinion: result.publicOpinion || '',
    recentDevelopments: result.recentDevelopments || '',
    sources,
    searchEntryPoint,
    tokens: {
      input: usage.promptTokenCount || 0,
      output: usage.candidatesTokenCount || 0,
    },
  };
}

// コスト計算（概算、トークン数ベース）
function estimateCost(personaCount, articleLength) {
  const pricing = MODEL_PRICING[MODEL_ID];
  // 記事 + 全コメント文脈 ≈ 総入力トークン ≈ personaCount * 1000 + articleLength/2
  const estimatedInputTokens = personaCount * 1200 + (articleLength || 4000) / 2;
  // 出力 ≈ personaCount * 300 (コメント + 返信)
  const estimatedOutputTokens = personaCount * 350;
  const costInput = (estimatedInputTokens / 1_000_000) * pricing.input;
  const costOutput = (estimatedOutputTokens / 1_000_000) * pricing.output;
  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
    costInput,
    costOutput,
    total: costInput + costOutput,
    currency: 'USD',
  };
}

// 実際の合計使用量を計算
function calcActualCost(totalInputTokens, totalOutputTokens) {
  const pricing = MODEL_PRICING[MODEL_ID];
  const costInput = (totalInputTokens / 1_000_000) * pricing.input;
  const costOutput = (totalOutputTokens / 1_000_000) * pricing.output;
  return {
    totalInputTokens,
    totalOutputTokens,
    costInput,
    costOutput,
    total: costInput + costOutput,
    currency: 'USD',
  };
}
