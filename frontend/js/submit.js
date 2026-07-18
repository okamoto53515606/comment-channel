// ===== サーバー提出（署名付きPOST） =====

// コメントデータをサーバーにPOST（HMAC署名付き）
async function submitComments(commentsData, articleUrl, articleText, personas) {
  const payload = {
    id: generateUUID(),
    articleUrl,
    articlePreview: trimArticleText(articleText, 200),
    personaCount: personas.length,
    modelId: MODEL_ID,
    generatedAt: utcNow(),
    comments: commentsData.comments.map(c => ({
      id: c.id,
      persona: {
        nickname: c.persona.nickname,
        countryCode: c.persona.countryCode,
        countryName: c.persona.countryName,
        countryFlag: c.persona.countryFlag,
        occupation: c.persona.occupation,
        stance: c.persona.stance,
      },
      comment: c.comment,
      timestamp: c.timestamp,
      replies: (c.replies || []).map(r => ({
        id: r.id,
        persona: {
          nickname: r.persona.nickname,
          countryFlag: r.persona.countryFlag,
        },
        comment: r.comment,
        replyToId: r.replyToId,
        replyToNickname: r.replyToNickname,
        timestamp: r.timestamp,
      })),
    })),
    usage: commentsData.usage,
    summary: commentsData.summary || '',
  };

  // 署名生成
  const payloadStr = JSON.stringify(payload);
  const signature = await generateHMAC(SIGNING_SECRET, payloadStr);

  const resp = await fetch(`${API_BASE}/submit-comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      'X-Payload-Id': payload.id,
    },
    body: payloadStr,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || `投稿に失敗しました (HTTP ${resp.status})`);
  }

  const result = await resp.json();
  return { ...result, payloadId: payload.id };
}
