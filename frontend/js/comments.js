// ===== コメント生成エンジン =====

// コメントデータのグローバルストア
let allComments = [];
let totalUsage = { inputTokens: 0, outputTokens: 0 };

// 1ペルソナのコメント生成
async function generateCommentForPersona(apiKey, persona, articleText, allPreviousComments, backgroundContext = null, tendency = 'yahoo') {
  // 他の全コメントをコンテキストとして整形
  const contextComments = allPreviousComments.slice(-30); // 最新30件のみ（トークン節約）

  let contextText = '';
  if (contextComments.length > 0) {
    contextText = '\n## 他の人のコメント・返信（読んで参考にしてください。議論を盛り上げるため、あえて反論したくなるコメントを探してください）\n';
    for (const c of contextComments) {
      contextText += `- [${c.persona.nickname} (${c.persona.countryFlag} ${c.persona.countryName})]：「${c.comment}」\n`;
      if (c.replies && c.replies.length > 0) {
        for (const r of c.replies) {
          contextText += `  ↪ [${r.persona.nickname}] からの返信：「${r.comment}」\n`;
        }
      }
    }
  }

  // 傾向別の口調ガイド
  const toneGuides = {
    reddit: `あなたはRedditのサブレディット（r/news, r/worldnews）のコメント欄に書き込む住人です。
- 口調はカジュアルで知的なReddit風。日本語で書くが、OP, TL;DR, this, sauce, edit: などの英語表現を自然に混ぜる
- 感情的に熱くなる人もいれば、冷静にデータで反論する人もいる
- 他のコメントに容赦なくツッコミを入れたり、upvoteを稼ごうとする意識を持つ
- 皮肉・ミーム・ウィットに富んだ表現を好む`,
    '2ch': `あなたは2ちゃんねる（5ちゃんねる）のニュース速報板の住人です。
- 口調はタメ語・ため口が基本。ですます調は使わない
- スラングを多用：ワロタ、草、それな、は？、～だろ、～じゃね？、うせろ、情弱、ニート、ガイジ etc.
- 感情的で喧嘩腰。煽り・嘲笑・便乗が飛び交う。名無しさんのような匿名感
- でもたまに、やたら詳しい住人が冷静に長文で解説することもある`,
    yahoo: `あなたはYahoo!ニュースのコメント欄に書き込む住人です。
- ですます調とため口が混在。説教・上から目線・ご意見番・人生語り
- 「～だと思います」「～すべきです」「苦笑」「呆れ」「常識的に考えて」が頻出
- 感情的にブチギレる人もいれば、冷静に正論を述べて「そう思う」を集める人もいる
- 「高評価を得たい」という意識が根底にある`,
  };

  const toneGuide = toneGuides[tendency] || toneGuides.yahoo;

  const systemPrompt = `あなたは「${persona.nickname}」というペルソナです。
以下のプロフィールに基づいて、自然なコメントを書いてください。

## あなたのプロフィール
- ニックネーム: ${persona.nickname}
- 国籍: ${persona.countryFlag} ${persona.countryName}
- 年齢: ${persona.age}歳
- 性別: ${persona.gender === 'male' ? '男性' : persona.gender === 'female' ? '女性' : 'その他'}
- 職業: ${persona.occupation}
- 性格: ${persona.personality}
- 立場: ${persona.stance}
- 関心: ${persona.viewpoint}

## コメントの書き方
${toneGuide}
- 日本語で自然に書いてください（日本在住の${persona.countryName}人として）
- あなたの文化的背景や職業観を自然に反映させてください
- 他のコメントに対して積極的に噛みついたり、喧嘩を売ってください。対立を明確に！
- 感情的なペルソナは熱く、冷静なペルソナは冷静に。あなたの stance（${persona.stance}）を反映してください
- ヘイトスピーチや露骨な個人攻撃は避けつつ、議論を白熱させてください
- 文字数は最大200文字です`;

  const userPrompt = `以下のニュース記事を読んで、あなたの意見をコメントとして書いてください。

## 記事
${articleText.substring(0, 4000)}
${backgroundContext ? `\n## 参考：背景情報（Google検索による補足）\n- 背景: ${backgroundContext.background || 'なし'}\n- 論点: ${backgroundContext.publicOpinion || 'なし'}\n${(backgroundContext.relatedFacts || []).map(f => `- 関連事実: ${f}`).join('\n')}` : ''}
${contextText}
## 指示
あなたのペルソナとして、この記事に対するコメントを書いてください。
${persona.stance === 'emotional' || persona.stance === 'provocative' ? '感情的・挑発的に、他の意見に噛みつくようなコメントを書いてください。喧嘩腰で！' : ''}
${persona.stance === 'academic' || persona.stance === 'neutral' ? '冷静に、データや論理に基づいたコメントを書いてください。ただし他の感情的コメントに冷ややかにツッコミを入れてください。' : ''}
コメントのみを返してください。説明や前置きは不要です。
文字数は最大200文字でお願いします。`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.85,
    maxOutputTokens: 300,
  });

  // 使用量を集計
  totalUsage.inputTokens += result.inputTokens;
  totalUsage.outputTokens += result.outputTokens;

  // 200文字にトリム
  let comment = result.text.trim();
  if (comment.length > 200) {
    comment = comment.substring(0, 200);
  }

  return {
    persona,
    comment,
    timestamp: utcNow(),
    tokens: { input: result.inputTokens, output: result.outputTokens },
  };
}

// 返信生成（特定のコメントに対して）
async function generateReply(apiKey, replyPersona, targetComment, articleText, allComments, tendency = 'yahoo') {
  // 傾向別の返信口調ガイド（短縮版）
  const replyGuides = {
    reddit: 'Reddit風のカジュアルで知的な口調。皮肉やツッコミ多め。英語表現を自然に混ぜる。',
    '2ch': '2ちゃんねる風のタメ語・煽り口調。スラング多め。遠慮なく噛みつく。',
    yahoo: 'Yahooコメント風。説教・上から目線・正論。ですます調とため口混在。',
  };
  const replyGuide = replyGuides[tendency] || replyGuides.yahoo;

  const systemPrompt = `あなたは「${replyPersona.nickname}」というペルソナです。

## あなたのプロフィール
- 国籍: ${replyPersona.countryFlag} ${replyPersona.countryName}
- 年齢: ${replyPersona.age}歳
- 職業: ${replyPersona.occupation}
- 性格: ${replyPersona.personality}
- 立場: ${replyPersona.stance}

## 返信の書き方
- 「${targetComment.persona.nickname}」さんの以下のコメントに対する返信を書いてください
- ${replyGuide}
- 日本語で自然に、最大50文字で
- 積極的に反論・ツッコミを入れて、対立を明確にしてください
- 喧嘩腰で！`;

  const userPrompt = `以下のコメントに対する返信を書いてください。

## 返信対象のコメント
[${targetComment.persona.nickname}]：「${targetComment.comment}」

## 記事の内容（参考）
${articleText.substring(0, 2000)}

あなたの返信（最大50文字、喧嘩腰で）:`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.9,
    maxOutputTokens: 120,
  });

  totalUsage.inputTokens += result.inputTokens;
  totalUsage.outputTokens += result.outputTokens;

  let reply = result.text.trim();
  if (reply.length > 50) {
    reply = reply.substring(0, 50);
  }

  return {
    persona: replyPersona,
    comment: reply,
    replyToId: targetComment.id,
    replyToNickname: targetComment.persona.nickname,
    timestamp: utcNow(),
  };
}

// 全ペルソナのコメント生成を順次実行（ライブプログレス付き）
async function generateAllComments(apiKey, personas, articleText, progressCallback, backgroundContext = null, tendency = 'yahoo') {
  allComments = [];
  totalUsage = { inputTokens: 0, outputTokens: 0 };
  const totalPersonas = personas.length;

  for (let i = 0; i < totalPersonas; i++) {
    const persona = personas[i];
    const isLastFew = i >= totalPersonas - Math.ceil(totalPersonas * 0.3);

    // コメント生成
    const commentData = await generateCommentForPersona(
      apiKey, persona, articleText, allComments, backgroundContext, tendency
    );

    const commentEntry = {
      id: generateUUID(),
      persona,
      comment: commentData.comment,
      replies: [],
      timestamp: commentData.timestamp,
      tokens: commentData.tokens,
    };

    // 返信生成（後半30%のペルソナのみ、またはランダムで確率40%）
    const shouldReply = isLastFew || Math.random() < 0.4;
    if (shouldReply && allComments.length > 0) {
      // 返信先をランダムに選択（最大3件、ただし重複しない）
      const replyTargets = [];
      const availableTargets = [...allComments]; // シャローコピー
      const replyCount = Math.min(4, 1 + Math.floor(Math.random() * 3), availableTargets.length);

      for (let r = 0; r < replyCount; r++) {
        if (availableTargets.length === 0) break;
        const idx = Math.floor(Math.random() * availableTargets.length);
        replyTargets.push(availableTargets.splice(idx, 1)[0]);
      }

      for (const target of replyTargets) {
        const replyData = await generateReply(apiKey, persona, target, articleText, allComments, tendency);
        // 返信を対象コメントに追加
        const targetEntry = allComments.find(c => c.id === target.id);
        if (targetEntry && targetEntry.replies.length < 4) {
          targetEntry.replies.push({
            id: generateUUID(),
            ...replyData,
          });
        }
      }
    }

    allComments.push(commentEntry);

    // プログレス報告
    const progress = {
      current: i + 1,
      total: totalPersonas,
      percent: Math.round(((i + 1) / totalPersonas) * 100),
      latestComment: commentEntry,
      totalComments: allComments.length,
      totalReplies: allComments.reduce((sum, c) => sum + c.replies.length, 0),
      usage: { ...totalUsage },
    };

    if (progressCallback) {
      await progressCallback(progress);
    }
  }

  return {
    comments: allComments,
    usage: totalUsage,
  };
}

// AI要約の生成
async function generateSummary(apiKey, comments, articleText) {
  const commentTexts = comments.slice(0, 20).map(c =>
    `[${c.persona.nickname}]「${c.comment}」`
  ).join('\n');

  const systemPrompt = `あなたは討論の要約者です。以下のAI生成コメント群の要約を日本語で作成してください。`;

  const userPrompt = `以下のコメント群（${comments.length}件中、代表的な20件）と記事をもとに、議論の要約を3〜5文で作成してください。

## 記事
${articleText.substring(0, 1500)}

## コメント
${commentTexts}

## 出力形式
1. 議論全体の傾向を1文で
2. 主な論点を2〜3文で
3. 特に注目すべき視点を1〜2文で

合計で150文字以内に収めてください。`;

  const result = await callGemini(apiKey, systemPrompt, userPrompt, {
    temperature: 0.5,
    maxOutputTokens: 300,
  });

  return result.text.trim();
}
