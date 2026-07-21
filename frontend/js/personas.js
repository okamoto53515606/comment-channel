// ===== ペルソナ動的生成 =====

// 傾向プリセット
const TENDENCY_PRESETS = {
  reddit: {
    name: 'Reddit風',
    description: '知的×カジュアルなReddit住人のノリ。皮肉・ミーム・ソース要求。冷静な分析派と熱狂的なオピニオンリーダーが混在し、upvote争いで対立が激化。口調はcasualで知的ながらも時に辛辣。',
    stanceDistribution: { agree: 15, disagree: 25, neutral: 10, emotional: 20, humorous: 15, academic: 10, provocative: 5 },
    toneGuide: 'Redditのサブレディット（r/newsやr/worldnews）のコメント欄のような口調。くだけた英語由来の表現（OP、TL;DR、this、sauceなど）を自然に交えつつ、日本語で書く。冷静にデータを出す人と、熱く持論をぶつける人が共存。',
  },
  '2ch': {
    name: '2ちゃんねる風',
    description: '匿名掲示板の無法地帯。荒らし・煽り・祭り・コピペ。スラング（ワロタ・草・それな・は？など）満載。だが時折、異常に詳しい住人が鋭い考察をぶち込む。感情的な喧嘩と冷静なツッコミが入り乱れる。',
    stanceDistribution: { agree: 10, disagree: 25, neutral: 5, emotional: 30, humorous: 20, provocative: 10 },
    toneGuide: '2ちゃんねる（5ちゃんねる）のニュース速報板のような口調。ため口・タメ語が基本。名無しさんのような匿名感。煽り・嘲笑・便乗が飛び交うが、たまにガチ勢が長文で解説をぶち込む。AA（アスキーアート）やコピペのノリも可。',
  },
  yahoo: {
    name: 'Yahooコメント風',
    description: 'Yahoo!ニュースのコメント欄そのもの。説教・上から目線・ご意見番・人生語り。感情的ブチギレおじさんと、冷静に正論を述べる常識人が激突。AI要約つき。',
    stanceDistribution: { agree: 15, disagree: 25, neutral: 10, emotional: 25, humorous: 5, provocative: 15, academic: 5 },
    toneGuide: 'Yahoo!ニュースのコメント欄のような口調。「〜だと思う」「〜すべき」「苦笑」「呆れ」などが頻出。ですます調とため口が混在。説教くさい常識人、感情的すぎる人、やたらと体験談を語る人など。高評価を集める「そう思う」ボタンを意識したコメント。',
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

  // stanceの分布から割り当てを生成（感情的な人と冷静な人の両方を確保）
  const stancePool = [];
  for (const [stance, ratio] of Object.entries(preset.stanceDistribution)) {
    const n = Math.round(count * ratio / 100);
    for (let i = 0; i < n; i++) stancePool.push(stance);
  }
  // 不足分をランダム補完
  while (stancePool.length < count) {
    const stances = Object.keys(preset.stanceDistribution);
    stancePool.push(stances[Math.floor(Math.random() * stances.length)]);
  }
  // シャッフル
  for (let i = stancePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [stancePool[i], stancePool[j]] = [stancePool[j], stancePool[i]];
  }
  // 少なくとも20%は冷静系（academic/neutral/agreeの一部）を確保
  const calmStances = ['academic', 'neutral'];
  const minCalm = Math.max(2, Math.floor(count * 0.2));
  for (let i = 0; i < Math.min(minCalm, count); i++) {
    stancePool[i] = calmStances[Math.floor(Math.random() * calmStances.length)];
  }
  // 再度シャッフル
  for (let i = stancePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [stancePool[i], stancePool[j]] = [stancePool[j], stancePool[i]];
  }

  const systemPrompt = `あなたは多様なペルソナを生成する専門家です。
以下の条件に従って、${count}人分のペルソナ（人格）をJSON配列で生成してください。

## 議論の傾向
- 傾向: ${preset.name}
- 説明: ${preset.description}
- 口調ガイド: ${preset.toneGuide}

## 各国の割り当て（各ペルソナに割り当てる国）
${countries.map((c, i) => `${i + 1}. ${c.flag} ${c.name} (${c.nameEn})`).join('\n')}

${bgSection}

## stance割り当て（この順に従うこと）
${stancePool.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## 重要な指示
- 感情的なペルソナと冷静なペルソナをバランスよく混ぜてください。どちらかに偏らないこと。
- 感情的なペルソナ同士、または感情的なペルソナと冷静なペルソナが対立する構図を作りやすい人格設定にしてください。
- 喧嘩腰の議論が生まれるように、互いに反発しそうな性格・立場のペルソナを意識的に含めてください。
- ニックネームは掲示板の雰囲気に合ったものにしてください。

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

## 口調の指示
${preset.toneGuide}

## 注意
- ニックネームは掲示板の雰囲気に合った創造的なものにしてください
- 感情的なペルソナと冷静なペルソナの両方を必ず含めてください（どちらかに偏らないこと）
- 互いに対立しそうな性格のペルソナを入れて、喧嘩腰の議論を生みやすくしてください
- stanceは指定された順に従ってください`;

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
