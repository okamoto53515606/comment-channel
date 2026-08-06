// ===== LLM API 呼び出し (ブラウザ内で直接APIを呼ぶ) =====

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const SAKANA_API_BASE = 'https://api.sakana.ai';

// ===== モデルレジストリ =====
const MODELS = {
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    provider: 'gemini',
    name: 'Gemini 3.1 Flash-Lite',
    pricing: { input: 0.25, output: 1.50 },
    supportsWebSearch: false, // Gemini Grounding を別モデルで使用
    groundingModel: 'gemini-2.5-flash-lite',
  },
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    name: 'GPT-5.6 Luna',
    pricing: { input: 0.20, output: 1.20 }, // 2026-07-30より80%OFF
    supportsWebSearch: true, // Responses API ビルトイン web_search ツール
  },
  'sakana-namazu': {
    id: 'sakana-namazu',
    provider: 'sakana',
    name: 'Sakana Namazu',
    pricing: { input: 0.95, output: 4.00 }, // $0.95/$4.00 per 1M tokens
    supportsWebSearch: true, // Responses API ビルトイン web_search ツール ($7/1K queries)
  },
};

// デフォルト選択モデル
let SELECTED_MODEL_ID = 'gemini-3.1-flash-lite';

function setSelectedModel(modelId) {
  if (MODELS[modelId]) {
    SELECTED_MODEL_ID = modelId;
  }
}

function getSelectedModel() {
  return MODELS[SELECTED_MODEL_ID];
}

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
    `${GEMINI_API_BASE}/models/${SELECTED_MODEL_ID}:generateContent?key=${encodeURIComponent(apiKey)}`,
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

// ===== OpenAI Responses API 呼び出し =====
async function callOpenAI(apiKey, systemPrompt, userPrompt, options = {}) {
  const { maxOutputTokens = 1024, useWebSearch = false } = options;

  const input = [];
  if (systemPrompt) {
    input.push({ role: 'system', content: systemPrompt });
  }
  input.push({ role: 'user', content: userPrompt });

  const body = {
    model: 'gpt-5.6-luna',
    input,
    max_output_tokens: maxOutputTokens,
    reasoning: { effort: 'low' },
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search' }];
  }

  const resp = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let errMsg;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson?.error?.message || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`OpenAI API エラー: ${errMsg}`);
  }

  const data = await resp.json();

  // 最後のメッセージからテキストを抽出（output_text を全探索）
  const messages = (data.output || []).filter(item => item.type === 'message');
  const lastMessage = messages[messages.length - 1];

  // content 配列から output_text タイプのテキストを探す（[0]決め打ちを避ける）
  let text = '';
  let annotations = [];
  if (lastMessage?.content) {
    for (const part of lastMessage.content) {
      if (part.type === 'output_text' && part.text) {
        text = part.text;
        annotations = part.annotations || [];
        break;
      }
    }
  }

  // URL引用（annotations）からソースを抽出
  const sources = annotations
    .filter(a => a.type === 'url_citation')
    .map(a => ({ url: a.url, title: a.title || '' }));

  const usage = data.usage || {};
  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    sources,
  };
}

// ===== Sakana Namazu（Lambda プロキシ経由。Sakana API がブラウザ CORS 非対応のため） =====

// Sakana API プロキシ呼び出しの共通ヘルパー
async function callSakanaProxy(apiKey, endpoint, payload) {
  const proxyBody = {
    apiKey,
    endpoint,
    payload,
  };

  const resp = await fetch(LLM_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proxyBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let errMsg;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson?.error?.message || errJson?.error || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`Sakana API エラー: ${errMsg}`);
  }

  // Function URL は Lambda の戻り値 { statusCode, body } の body を
  // そのまま HTTP レスポンスボディとして返す（API Gateway と違ってラップしない）
  return resp.json();
}

// プロキシ経由の Responses API レスポンスからテキストとソースを抽出
function extractSakanaResponse(data, options = {}) {
  const messages = (data.output || []).filter(item => item.type === 'message');
  const lastMessage = messages[messages.length - 1];

  // 1. Responses API 形式: output[].message.content[].output_text
  let text = '';
  let annotations = [];
  if (lastMessage?.content) {
    for (const part of lastMessage.content) {
      if (part.type === 'output_text' && part.text) {
        text = part.text;
        annotations = part.annotations || [];
        break;
      }
    }
  }

  // 2. Chat Completions 形式（Sakana がたまにこの形式で返す）: choices[0].message.content
  if (!text && data.choices) {
    text = data.choices?.[0]?.message?.content || '';
  }

  // 3. フォールバック: reasoning.summary（Web検索時のみ最終回答がここに入ることがある）
  if (!text && options._allowReasoningFallback) {
    const reasoningItems = (data.output || []).filter(item => item.type === 'reasoning');
    for (const ri of reasoningItems.reverse()) {
      for (const s of (ri.summary || [])) {
        if (s.type === 'summary_text' && s.text) {
          text = s.text;
          break;
        }
      }
      if (text) break;
    }
  }

  const sources = annotations
    .filter(a => a.type === 'url_citation')
    .map(a => ({ url: a.url, title: a.title || '' }));

  const usage = data.usage || {};
  return {
    text,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    sources,
  };
}

async function callSakana(apiKey, systemPrompt, userPrompt, options = {}) {
  const { maxOutputTokens = 1024, useWebSearch = false, temperature } = options;

  const input = [];
  if (systemPrompt) {
    input.push({ role: 'system', content: systemPrompt });
  }
  input.push({ role: 'user', content: userPrompt });

  // Sakana Namazu は reasoning が出力上限を大量消費するため、十分な余裕を持たせる
  const sakanaMaxTokens = Math.max(maxOutputTokens + 2048, 2048);

  const payload = {
    model: 'sakana-namazu',
    input,
    max_output_tokens: sakanaMaxTokens,
  };

  // Sakana Namazu は temperature 対応（reasoning モデルではない）
  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  if (useWebSearch) {
    payload.tools = [{ type: 'web_search' }];
  }

  const data = await callSakanaProxy(apiKey, '/v1/responses', payload);
  return extractSakanaResponse(data);
}

// ===== 統合LLM呼び出し（モデル選択に応じて切り替え） =====
async function callLLM(apiKey, systemPrompt, userPrompt, options = {}) {
  const model = MODELS[SELECTED_MODEL_ID];
  if (model.provider === 'gemini') {
    return callGemini(apiKey, systemPrompt, userPrompt, options);
  } else if (model.provider === 'openai') {
    return callOpenAI(apiKey, systemPrompt, userPrompt, options);
  } else if (model.provider === 'sakana') {
    return callSakana(apiKey, systemPrompt, userPrompt, options);
  }
  throw new Error(`未対応のプロバイダー: ${model.provider}`);
}

// ===== Web検索（モデルに応じてGoogle Grounding / OpenAI web_search を切り替え） =====

// OpenAI Responses API ビルトイン web_search による背景検索
async function searchOpenAIWeb(apiKey, articleTitle, articleText) {
  const systemPrompt = `あなたは調査アシスタントです。与えられた記事について、Web検索を使って最新の関連情報や背景を調査してください。`;

  const userPrompt = `以下のニュース記事について、Web検索で関連情報を調査し、以下の項目を日本語でまとめてください。

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
    model: 'gpt-5.6-luna',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: [{ type: 'web_search' }],
    max_output_tokens: 2048,
  };

  const resp = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    let errMsg;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson?.error?.message || errText;
    } catch {
      errMsg = errText;
    }
    throw new Error(`OpenAI Web検索エラー: ${errMsg}`);
  }

  const data = await resp.json();

  // 最後のメッセージからテキストを抽出（output_text を全探索）
  const messages = (data.output || []).filter(item => item.type === 'message');
  const lastMessage = messages[messages.length - 1];

  let text = '';
  let annotations = [];
  if (lastMessage?.content) {
    for (const part of lastMessage.content) {
      if (part.type === 'output_text' && part.text) {
        text = part.text;
        annotations = part.annotations || [];
        break;
      }
    }
  }

  // URL引用からソースを抽出
  const sources = annotations
    .filter(a => a.type === 'url_citation')
    .map(a => ({ url: a.url, title: a.title || '' }));

  // JSONパースを試みる
  let result;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    result = {
      background: text.substring(0, 300),
      relatedFacts: [],
      publicOpinion: '',
      recentDevelopments: '',
    };
  }

  const usage = data.usage || {};
  return {
    background: result.background || '',
    relatedFacts: result.relatedFacts || [],
    publicOpinion: result.publicOpinion || '',
    recentDevelopments: result.recentDevelopments || '',
    sources,
    searchEntryPoint: '',
    tokens: {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
    },
  };
}

// Sakana Namazu Responses API ビルトイン web_search による背景検索（Lambdaプロキシ経由）
async function searchSakanaWeb(apiKey, articleTitle, articleText) {
  const systemPrompt = `あなたは調査アシスタントです。与えられた記事について、Web検索を使って最新の関連情報や背景を調査してください。`;

  const userPrompt = `以下のニュース記事について、Web検索で関連情報を調査し、以下の項目を日本語でまとめてください。

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

  const payload = {
    model: 'sakana-namazu',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: [{ type: 'web_search' }],
    max_output_tokens: 2048,
  };

  const data = await callSakanaProxy(apiKey, '/v1/responses', payload);
  const { text, sources, inputTokens, outputTokens } = extractSakanaResponse(data, { _allowReasoningFallback: true });

  // JSONパース（コードフェンス ```json ... ``` 除去対応）
  let result;
  try {
    let cleanText = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch ? jsonMatch[0] : cleanText);
  } catch (e) {
    console.warn('[searchSakanaWeb] JSON parse failed, text preview:', text.substring(0, 200));
    result = {
      background: text.substring(0, 300),
      relatedFacts: [],
      publicOpinion: '',
      recentDevelopments: '',
    };
  }

  return {
    background: result.background || '',
    relatedFacts: result.relatedFacts || [],
    publicOpinion: result.publicOpinion || '',
    recentDevelopments: result.recentDevelopments || '',
    sources,
    searchEntryPoint: '',
    tokens: { input: inputTokens, output: outputTokens },
  };
}

// 統合Web検索（モデルに応じて切り替え）
async function searchWeb(apiKey, articleTitle, articleText) {
  const model = MODELS[SELECTED_MODEL_ID];
  if (model.supportsWebSearch) {
    if (model.provider === 'sakana') {
      return searchSakanaWeb(apiKey, articleTitle, articleText);
    }
    if (model.provider === 'openai') {
      return searchOpenAIWeb(apiKey, articleTitle, articleText);
    }
  }
  // Gemini（またはその他）は従来のGoogle Search Grounding
  return searchGoogleGrounding(apiKey, articleTitle, articleText);
}

// Google Search Grounding: 記事の背景情報をWEB検索で取得（Gemini用）
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
  const pricing = MODELS[SELECTED_MODEL_ID].pricing;
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
  const pricing = MODELS[SELECTED_MODEL_ID].pricing;
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
