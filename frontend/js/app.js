// ===== メインアプリケーションロジック =====

// アプリケーション状態
const state = {
  articleUrl: '',
  articleText: '',
  articleTitle: '',
  articleSource: '',
  apiKey: '',
  personaCount: 10,
  tendency: 'heated',
  regions: ['east_asia', 'southeast_asia', 'europe', 'north_america'],
  includeJapan: true,
  personas: [],
  currentStep: 'input',
  backgroundContext: null,  // Google Search Groundingの結果
};

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  // 文字数カウンター
  setupCharCount('article-text', 'article-char-count', 4000);

  // ペルソナ人数スライダー
  const slider = $('persona-count');
  const display = $('persona-count-display');
  slider.addEventListener('input', () => {
    state.personaCount = parseInt(slider.value);
    display.textContent = state.personaCount;
    updateCostEstimate();
  });
  state.personaCount = parseInt(slider.value);

  // 傾向選択
  document.querySelectorAll('input[name="tendency"]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.tendency = radio.value;
    });
  });

  // 地域選択
  document.querySelectorAll('input[name="region"]').forEach(cb => {
    cb.addEventListener('change', updateRegions);
  });

  // 日本を含める
  $('include-japan').addEventListener('change', () => {
    state.includeJapan = $('include-japan').checked;
  });

  // APIキー入力追跡
  $('api-key').addEventListener('input', () => {
    state.apiKey = $('api-key').value.trim();
  });

  // 記事テキスト手動編集追跡
  $('article-text').addEventListener('input', () => {
    state.articleText = $('article-text').value;
    updateCostEstimate();
  });

  // ボタンイベント
  $('btn-fetch-article').addEventListener('click', handleFetchArticle);
  $('btn-next-article').addEventListener('click', () => showStep('step-model'));
  $('btn-next-model').addEventListener('click', handleNextModel);
  $('btn-next-persona').addEventListener('click', handleNextPersona);
  $('btn-generate').addEventListener('click', handleGenerate);
  $('btn-retry').addEventListener('click', resetApp);
  const btnView = $('btn-view-page');
  if (btnView) {
    btnView.addEventListener('click', () => {
      if (state.publishedUrl) {
        window.open(state.publishedUrl, '_blank');
      }
    });
  }

  updateRegions();
}

function updateRegions() {
  state.regions = [];
  document.querySelectorAll('input[name="region"]:checked').forEach(cb => {
    state.regions.push(cb.value);
  });
}

// コスト見積もり更新
function updateCostEstimate() {
  const cost = estimateCost(state.personaCount, state.articleText?.length || 4000);
  const el = $('cost-estimate');
  if (el) {
    el.textContent = `約 $${cost.total.toFixed(2)} USD (${state.personaCount}人分)`;
  }
}

// ===== ステップ表示切り替え =====
function showStep(stepName) {
  const steps = ['step-input', 'step-model', 'step-persona', 'step-generate',
                 'step-progress', 'step-complete', 'step-error'];
  for (const s of steps) {
    if (s === stepName) show(s); else hide(s);
  }
  state.currentStep = stepName;

  // 該当ステップへスクロール
  if (stepName !== 'step-input') {
    $(stepName).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ===== 記事取得 =====
async function handleFetchArticle() {
  const url = $('article-url').value.trim();
  if (!url) {
    showStatus('article-fetch-status', 'URLを入力してください', 'error');
    return;
  }

  state.articleUrl = url;

  // 簡易URLバリデーション
  const blockedPatterns = [
    /porn/i, /adult/i, /xxx/i, /sex/i, /hentai/i, /erotic/i,
    /gambl/i, /casino/i, /bet/i, /crime/i, /darkweb/i,
  ];
  for (const pattern of blockedPatterns) {
    if (pattern.test(url)) {
      showStatus('article-fetch-status', 'このURLはブロックされています。', 'error');
      return;
    }
  }

  showStatus('article-fetch-status', '記事を取得中...', 'loading');
  $('btn-fetch-article').disabled = true;

  try {
    const result = await fetchArticleViaProxy(url);
    state.articleText = result.text || '';
    state.articleTitle = result.title || '';
    state.articleSource = result.source || '';

    // 取得成功：本文をテキストエリアに入力
    $('article-text').value = state.articleText;
    $('article-char-count').textContent = state.articleText.length;
    $('article-text-label').innerHTML = '📄 取得された記事本文 <span class="hint">（必要に応じて編集できます）</span>';
    $('article-text').placeholder = '';

    hideStatus('article-fetch-status');
    showStatus('article-fetch-status',
      `✅ 記事を取得しました: ${state.articleTitle || '無題'} (${state.articleText.length}文字)`, 'success');

    // テキストエリア＋次へボタンを表示
    show('article-text-area');
    $('btn-next-article').scrollIntoView({ behavior: 'smooth', block: 'center' });

  } catch (err) {
    console.error('記事取得エラー:', err);
    // 取得失敗：手動入力を促す
    $('article-text').value = '';
    $('article-text-label').innerHTML = '📄 記事本文 <span class="hint" style="color:#ef4444;">（自動取得に失敗しました。本文をコピー＆ペーストしてください）</span>';
    $('article-text').placeholder = 'ここに記事本文を貼り付けてください（最大4000文字）';

    showStatus('article-fetch-status',
      '⚠️ 記事の自動取得に失敗しました。下の欄に記事本文を貼り付けてください。', 'error');
  } finally {
    $('btn-fetch-article').disabled = false;
    // テキストエリア＋次へボタンを常に表示
    show('article-text-area');
    $('btn-next-article').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Google Search Grounding: 記事の背景情報をWEB検索で取得
// handleNextModel() から呼ばれる（APIキー確定後、Step 2→3 の遷移時）
async function fetchBackgroundContext() {
  if (!state.apiKey || !state.articleText) return;

  // 背景情報コンテナ（step-persona 内）にローディング表示
  const bgContainer = $('background-context');
  if (!bgContainer) return;

  bgContainer.innerHTML = '<div class="bg-loading">🔍 Google検索で記事の背景情報を調査中...（Gemini 2.5 Flash-Lite）<span class="loading-dot"></span></div>';
  show('background-context');

  try {
    const bg = await searchGoogleGrounding(state.apiKey, state.articleTitle, state.articleText);
    state.backgroundContext = bg;

    // 結果表示
    const sourcesHtml = bg.sources && bg.sources.length > 0
      ? bg.sources.slice(0, 5).map(s =>
          `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" class="bg-source-link">🔗 ${escapeHtml(s.title || s.url)}</a>`
        ).join('')
      : '';

    bgContainer.innerHTML = `
      <div class="bg-result">
        <div class="bg-header">🔍 Google検索による背景情報 <span class="hint">(Gemini 2.5 Flash-Lite)</span></div>
        ${bg.background ? `<div class="bg-section"><span class="bg-label">📖 背景</span><p>${escapeHtml(bg.background)}</p></div>` : ''}
        ${bg.publicOpinion ? `<div class="bg-section"><span class="bg-label">💬 論点</span><p>${escapeHtml(bg.publicOpinion)}</p></div>` : ''}
        ${bg.recentDevelopments ? `<div class="bg-section"><span class="bg-label">📰 最近の動向</span><p>${escapeHtml(bg.recentDevelopments)}</p></div>` : ''}
        ${bg.relatedFacts && bg.relatedFacts.length > 0 ? `<div class="bg-section"><span class="bg-label">📌 関連事実</span><ul>${bg.relatedFacts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
        ${sourcesHtml ? `<div class="bg-sources">${sourcesHtml}</div>` : ''}
        <div class="bg-tokens">🔎 検索トークン: 入${bg.tokens.input.toLocaleString()} / 出${bg.tokens.output.toLocaleString()}</div>
      </div>
    `;

  } catch (err) {
    console.warn('背景情報の取得に失敗（スキップします）:', err);
    state.backgroundContext = null;
    bgContainer.innerHTML = '<div class="bg-loading bg-failed">⚠️ 背景情報の取得に失敗しました。このままコメント生成を続行できます。</div>';
  }
}

// ===== ステップ遷移ハンドラ =====
function handleNextModel() {
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    alert('APIキーを入力してください。');
    return;
  }
  state.apiKey = apiKey;
  showStep('step-persona');
  updateCostEstimate();

  // Google Search Grounding: 背景情報を非同期で取得（APIキーが確定したタイミング）
  fetchBackgroundContext();
}

function handleNextPersona() {
  showStep('step-generate');
  updateCostEstimate();
}

// ===== コメント生成 =====
async function handleGenerate() {

  if (!state.articleText) {
    showError('記事本文がありません。URLを入力するか、本文を貼り付けてください。');
    return;
  }
  if (!state.apiKey) {
    showError('APIキーを入力してください。');
    return;
  }

  // プログレス画面に切り替え
  showStep('step-progress');
  $('live-comments').innerHTML = '';
  updateProgress(0, 0, 'ペルソナを生成中...');

  try {
    // Step 1: ペルソナ生成
    const countries = selectCountries(state.regions, state.includeJapan, state.personaCount);
    state.personas = await generatePersonas(
      state.apiKey, state.personaCount, state.tendency, countries, state.articleText,
      state.backgroundContext
    );

    updateProgress(0, state.personaCount, `${state.personas.length}人のペルソナを生成しました。コメント生成を開始...`);

    // Step 2: コメント生成（プログレスコールバック付き）
    const result = await generateAllComments(
      state.apiKey, state.personas, state.articleText,
      onCommentProgress, state.backgroundContext
    );

    updateProgress(state.personaCount, state.personaCount,
      `全${result.comments.length}件のコメント、${result.comments.reduce((s, c) => s + c.replies.length, 0)}件の返信を生成しました`);

    // Step 3: AI要約生成
    updateProgress(state.personaCount, state.personaCount, 'AI要約を生成中...');
    const summary = await generateSummary(state.apiKey, result.comments, state.articleText);
    result.summary = summary;

    // 完了表示（ブラウザ内で結果を表示）
    const actualCost = calcActualCost(result.usage.inputTokens, result.usage.outputTokens);
    showComplete(result, actualCost);

    // APIキーをメモリからクリア
    state.apiKey = '';
    $('api-key').value = '';

  } catch (err) {
    console.error('生成エラー:', err);
    showError(err.message || '予期せぬエラーが発生しました。');
  }
}

// プログレス更新
function updateProgress(current, total, message) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  $('progress-bar').style.width = `${percent}%`;
  $('progress-text').textContent = `${message} (${current}/${total})`;
}

// コメントごとのプログレスコールバック
async function onCommentProgress(progress) {
  updateProgress(progress.current, progress.total,
    `コメント生成中... ${progress.totalComments}コメント / ${progress.totalReplies}返信`);

  // 最新コメントをライブ表示に追加
  const liveEl = $('live-comments');
  const commentEl = document.createElement('div');
  commentEl.className = 'live-comment';

  const p = progress.latestComment;
  commentEl.innerHTML = `
    <div class="lc-header">
      <span class="lc-nickname">${escapeHtml(p.persona.nickname)}</span>
      <span class="lc-country">${p.persona.countryFlag} ${p.persona.countryName}</span>
      <span style="font-size:.7rem;color:#9ca3af;">${p.persona.occupation}</span>
    </div>
    <div class="lc-text">${escapeHtml(p.comment)}</div>
  `;

  // 返信があれば表示
  if (p.replies && p.replies.length > 0) {
    for (const reply of p.replies) {
      const replyEl = document.createElement('div');
      replyEl.className = 'lc-reply';
      replyEl.innerHTML = `
        <div class="lc-reply-to">↪ ${escapeHtml(reply.persona.nickname)} より返信:</div>
        ${escapeHtml(reply.comment)}
      `;
      commentEl.appendChild(replyEl);
    }
  }

  liveEl.insertBefore(commentEl, liveEl.firstChild);

  // 多すぎる場合は古いものを削除
  while (liveEl.children.length > 50) {
    liveEl.removeChild(liveEl.lastChild);
  }

  // 少し待ってUI更新
  await sleep(50);
}

// HTMLエスケープ
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// エラー表示
function showError(message) {
  $('error-message').textContent = message;
  showStep('step-error');
}

// 完了表示（ブラウザ内に結果表示 + HTMLコピー）
function showComplete(commentsResult, cost) {
  showStep('step-complete');
  const comments = commentsResult.comments;

  // コメントHTML生成
  let commentsHtml = '';
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const p = c.persona;
    const stanceLabels = {agree:'👍',disagree:'👎',neutral:'🤔',emotional:'😤',humorous:'😄',academic:'📚',provocative:'🔥',supportive:'🤝'};
    const stanceLabel = stanceLabels[p.stance] || '';

    let repliesHtml = '';
    if (c.replies && c.replies.length > 0) {
      repliesHtml = '<div class="replies">';
      for (const r of c.replies) {
        repliesHtml += `<div class="reply"><span class="reply-nick">${escapeHtml(r.persona.countryFlag||'')} ${escapeHtml(r.persona.nickname)}</span> ↪ ${escapeHtml(r.replyToNickname||'')}: ${escapeHtml(r.comment)}</div>`;
      }
      repliesHtml += '</div>';
    }

    commentsHtml += `
    <div class="result-comment">
      <div class="result-header">
        <span class="result-icon">🤖</span>
        <strong>${escapeHtml(p.countryFlag||'')} ${escapeHtml(p.nickname)}</strong>
        <span class="result-country">${escapeHtml(p.countryName||'')}</span>
        <span class="result-occ">${escapeHtml(p.occupation||'')}</span>
        <span class="result-stance">${stanceLabel}</span>
        <span class="result-num">#${i+1}</span>
      </div>
      <div class="result-body">${escapeHtml(c.comment)}</div>
      ${repliesHtml}
    </div>`;
  }

  const summary = commentsResult.summary || '';
  const summarySection = summary ? `<div class="result-summary"><h3>🤖 AI要約</h3><p>${escapeHtml(summary)}</p></div>` : '';

  // 完成HTML生成（コピー用）
  state.generatedHtml = buildFullHtml(comments, summary, commentsResult.usage);

  const info = $('complete-info');
  info.innerHTML = `
    <p>🎉 <strong>${comments.length}件</strong>のコメントが生成されました（返信 ${comments.reduce((s, c) => s + (c.replies||[]).length, 0)}件）</p>
    <p>💰 API利用料金（概算）: <strong>$${cost.total.toFixed(3)} USD</strong>
       (入${cost.totalInputTokens.toLocaleString()} / 出${cost.totalOutputTokens.toLocaleString()} tokens)</p>
    ${summarySection}
    <div class="result-comments-container">${commentsHtml}</div>
    <div style="margin-top:1rem;display:flex;justify-content:center;gap:.5rem;flex-wrap:nowrap;">
      <button id="btn-copy-html" class="btn btn-primary">📋 HTMLをコピー</button>
      <button id="btn-download-html" class="btn btn-secondary">💾 HTMLをダウンロード</button>
    </div>
  `;

  // コピーボタン
  $('btn-copy-html').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.generatedHtml);
      $('btn-copy-html').textContent = '✅ コピーしました！';
      setTimeout(() => { $('btn-copy-html').textContent = '📋 HTMLをコピー'; }, 2000);
    } catch {
      alert('コピーに失敗しました。ダウンロードをお試しください。');
    }
  });

  // ダウンロードボタン
  $('btn-download-html').addEventListener('click', () => {
    const blob = new Blob([state.generatedHtml], {type:'text/html;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'comment-channel.html'; a.click();
    URL.revokeObjectURL(url);
  });
}

function buildFullHtml(comments, summary, usage) {
  const commentsHtml = comments.map((c,i) => {
    const p = c.persona;
    let r = '';
    (c.replies||[]).forEach(rp => {
      r += `<div class="reply"><span class="reply-nickname">${escapeHtml(rp.persona.countryFlag||'')} ${escapeHtml(rp.persona.nickname)}</span> ↪ ${escapeHtml(rp.replyToNickname||'')}<br>${escapeHtml(rp.comment)}</div>`;
    });
    return `<div class="comment"><div class="comment-header">🤖 <strong>${escapeHtml(p.countryFlag||'')} ${escapeHtml(p.nickname)}</strong> (${escapeHtml(p.countryName||'')}, ${escapeHtml(p.occupation||'')}) #${i+1}</div><div class="comment-body">${escapeHtml(c.comment)}</div>${r}</div>`;
  }).join('');

  const summaryHtml = summary ? `<div class="summary-box"><h3>🤖 AI要約</h3><p>${escapeHtml(summary)}</p></div>` : '';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>comment-channel</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;background:#f8f9fa;color:#1a1a2e;line-height:1.7;padding:1rem;max-width:720px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:.5rem}.ai-notice{background:#fef3c7;padding:.5rem;text-align:center;font-size:.8rem;margin-bottom:1rem}
.summary-box{background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:.8rem;margin:1rem 0}
.comment{background:#fff;border-radius:8px;padding:.8rem;margin-bottom:.6rem;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.comment-header{margin-bottom:.3rem;font-size:.8rem;color:#4f46e5}.comment-body{font-size:.9rem}
.reply{margin-left:1rem;padding:.4rem;border-left:2px solid #e5e7eb;font-size:.8rem;margin-top:.3rem}.reply-nickname{color:#4f46e5;font-weight:600}
footer{text-align:center;font-size:.7rem;color:#9ca3af;margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e7eb}</style></head>
<body><h1>💬 comment-channel</h1><div class="ai-notice">⚠️ すべてのコメントはAIによって生成されたものです。</div>
${summaryHtml}<p style="color:#6c757d;text-align:center">💬 ${comments.length}件 | 返信 ${comments.reduce((s,c)=>s+(c.replies||[]).length,0)}件</p>
${commentsHtml}<div class="ai-notice" style="background:#fef2f2;border:1px solid #fecaca;margin-top:1rem">🤖 以上のコメントはすべてAI生成です。</div>
<footer>comment-channel — AI-generated diverse perspectives</footer></body></html>`;
}

// リセット
function resetApp() {
  state.articleUrl = '';
  state.articleText = '';
  state.articleTitle = '';
  state.apiKey = '';
  state.personas = [];
  state.generatedHtml = null;
  state.backgroundContext = null;

  $('article-url').value = '';
  $('article-text').value = '';
  $('article-text').placeholder = '「記事を取得する」ボタンを押すと、ここに本文が自動入力されます';
  $('article-text-label').innerHTML = '📄 記事本文';
  $('api-key').value = '';
  $('live-comments').innerHTML = '';
  $('progress-bar').style.width = '0%';

  hide('article-text-area');
  hideStatus('article-fetch-status');
  hide('background-context');

  showStep('step-input');
  $('article-url').focus();
}
