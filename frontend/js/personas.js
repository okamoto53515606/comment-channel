// ===== ペルソナ動的生成 =====

// 傾向プリセット
const TENDENCY_PRESETS = {
  balanced: {
    name: 'バランス型',
    description: '賛成・反対・中立が均等。多様な年齢・職業・立場のペルソナを生成。冷静な議論を重視。',
    stanceDistribution: { agree: 30, disagree: 30, neutral: 25, emotional: 10, humorous: 5 },
  },
  intellectual: {
    name: '論客重視',
    description: '専門家・知識人ペルソナ多め。データや歴史的事例、学術的引用を含む深い議論。',
    stanceDistribution: { agree: 25, disagree: 35, neutral: 15, emotional: 10, humorous: 5, academic: 10 },
  },
  casual: {
    name: 'カジュアル',
    description: '感情・ユーモア・日常感覚重視のコメント。SNSのゆるいノリ。軽快で親しみやすい。',
    stanceDistribution: { agree: 25, disagree: 20, neutral: 15, emotional: 20, humorous: 20 },
  },
  heated: {
    name: '炎上寄り',
    description: '賛否が極端で論争が活発。強い口調や挑発的なコメントも含む。ドラマチックな議論。',
    stanceDistribution: { agree: 20, disagree: 30, neutral: 10, emotional: 30, humorous: 5, provocative: 5 },
  },
  empathetic: {
    name: '共感重視',
    description: '他者のコメントに寄り添い、返信を積極的に行う。建設的で思いやりのある議論。',
    stanceDistribution: { agree: 35, disagree: 15, neutral: 20, emotional: 15, humorous: 5, supportive: 10 },
  },
};

// すべての国を含むプールからランダムに選択（日本を優先的に含める）
function selectCountries(regionKeys, includeJapan, count) {
  let pool = [];
  if (regionKeys && regionKeys.length > 0) {
    pool = getCountriesForRegions(regionKeys);
  } else {
    pool = getAllCountries();
  }

  // 日本が選択された地域に含まれているか確認し、含まれていなければ追加
  if (includeJapan) {
    const japan = COUNTRY_REGIONS.east_asia.find(c => c.code === 'JP');
    const hasJapan = pool.some(c => c.code === 'JP');
    if (!hasJapan) {
      pool.push(japan);
    }
  }

  // 重複を許して国を選択（人数分）
  const result = [];
  for (let i = 0; i < count; i++) {
    if (includeJapan && i === 0) {
      // 最初の一人は日本人を優先
      result.push(COUNTRY_REGIONS.east_asia.find(c => c.code === 'JP'));
    } else {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool[idx]);
    }
  }
  return result;
}

// ペルソナ一覧をLLMで生成
async function generatePersonas(apiKey, count, tendency, countries, articleContext, backgroundContext = null) {
  const preset = TENDENCY_PRESETS[tendency] || TENDENCY_PRESETS.balanced;

  // 背景情報がある場合はプロンプトに追加
  let bgSection = '';
  if (backgroundContext) {
    bgSection = `\n## この記事に関する背景情報（Google検索による補足）\n- 背景: ${backgroundContext.background || 'なし'}\n- 論点: ${backgroundContext.publicOpinion || 'なし'}\n- 最近の動向: ${backgroundContext.recentDevelopments || 'なし'}\n${(backgroundContext.relatedFacts || []).map((f, i) => `- 関連事実${i + 1}: ${f}`).join('\n')}`;
  }

  const systemPrompt = `あなたは多様なペルソナを生成する専門家です。
以下の条件に従って、${count}人分のペルソナ（人格）をJSON配列で生成してください。

## 議論の傾向
- 傾向: ${preset.name}
- 説明: ${preset.description}

## 各国の割り当て（各ペルソナに割り当てる国）
${countries.map((c, i) => `${i + 1}. ${c.flag} ${c.name} (${c.nameEn})`).join('\n')}

${bgSection}

## 出力形式（厳守）
以下のJSON配列のみを返してください。説明文は不要です。
[
  {
    "nickname": "カタカナまたはアルファベットのニックネーム（10文字以内）",
    "countryCode": "国コード（JP, US, GBなど）",
    "countryName": "日本語の国名",
    "countryFlag": "国旗emoji",
    "age": 年齢（数値、18-80の範囲）,
    "gender": "male/female/other",
    "occupation": "職業（日本語、10文字以内）",
    "personality": "性格の簡潔な説明（日本語、20文字以内）",
    "stance": "agree/disagree/neutral/emotional/humorous/academic/provocative/supportive のいずれか",
    "viewpoint": "この記事に対して持ちそうな視点・関心（日本語、30文字以内）"
  }
]`;

  const userPrompt = `以下の記事を読んだ上で、${count}人分の多様なペルソナを生成してください。

## 記事内容（先頭部分）
${articleContext.substring(0, 3000)}

## 注意
- ニックネームは創造的で現実的なものにしてください
- 国籍と人格に一貫性を持たせてください
- 様々な年齢層、職業を含めてください
- stanceは割り当てられた国の文化的背景を考慮してください`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 1.0,
    maxOutputTokens: Math.max(count * 150 + 1000, 8192),
  });

  // JSONパース（途中で切れた場合もリカバリ）
  let personas;
  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    let jsonStr = jsonMatch ? jsonMatch[0] : result.text;

    // MAX_TOKENSで切れた場合、不完全なJSONを修復
    if (!jsonStr.endsWith(']')) {
      // 最後の完全なオブジェクトまで切り詰める
      const lastComplete = jsonStr.lastIndexOf('},');
      if (lastComplete > 0) {
        jsonStr = jsonStr.substring(0, lastComplete + 1) + ']';
      } else {
        // 最悪のケース：最初のオブジェクトすら不完全
        const firstComplete = jsonStr.indexOf('}');
        if (firstComplete > 0) {
          jsonStr = jsonStr.substring(0, firstComplete + 1) + ']';
        }
      }
    }

    personas = JSON.parse(jsonStr);
    console.log(`Generated ${personas.length}/${count} personas before truncation`);
  } catch (e) {
    console.error('ペルソナJSONパースエラー:', e, result.text.substring(0, 200));
    throw new Error('ペルソナの生成に失敗しました。もう一度お試しください。');
  }

  // バリデーションと補完
  return personas.slice(0, count).map((p, i) => ({
    id: `persona-${i + 1}`,
    nickname: p.nickname || `ユーザー${i + 1}`,
    countryCode: p.countryCode || countries[i]?.code || 'XX',
    countryName: p.countryName || countries[i]?.name || '不明',
    countryFlag: p.countryFlag || countries[i]?.flag || '🌐',
    age: p.age || 30,
    gender: p.gender || 'other',
    occupation: p.occupation || '会社員',
    personality: p.personality || '普通',
    stance: p.stance || 'neutral',
    viewpoint: p.viewpoint || '記事の内容に関心がある',
  }));
}
