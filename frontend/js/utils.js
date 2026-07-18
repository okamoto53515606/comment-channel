// ===== ユーティリティ =====

// DOM要素取得のショートカット
function $(id) { return document.getElementById(id); }

// 表示/非表示
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ローディング状態表示
function showStatus(id, message, type) {
  const el = $(id);
  el.textContent = message;
  el.className = `status-box ${type}`;
  show(id);
}
function hideStatus(id) { hide(id); }

// 文字数カウント
function setupCharCount(inputId, countId, max) {
  const input = $(inputId);
  const count = $(countId);
  input.addEventListener('input', () => {
    count.textContent = input.value.length;
    if (input.value.length > max * 0.9) {
      count.style.color = '#ef4444';
    } else {
      count.style.color = '';
    }
  });
}

// スリープ
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Base64エンコード（URLセーフ）
function base64UrlEncode(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// HMAC-SHA256 署名生成（ブラウザ Web Crypto API）
async function generateHMAC(key, data) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const dataBytes = encoder.encode(data);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// UUID v4 生成
function generateUUID() {
  return crypto.randomUUID();
}

// 現在のUTCタイムスタンプ（ISO形式）
function utcNow() { return new Date().toISOString(); }

// 記事本文をトリム（先頭N文字）
function trimArticleText(text, maxLen) {
  return text.substring(0, maxLen);
}

// API Gatewayのエンドポイント（ビルド時に置換）
const API_BASE = window.CC_API_BASE || 'https://api.example.com';
const SIGNING_SECRET = window.CC_SIGNING_SECRET || 'dev-secret-change-in-production';

// 記事取得プロキシ呼び出し
async function fetchArticleViaProxy(url) {
  const resp = await fetch(`${API_BASE}/fetch-article`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || `記事の取得に失敗しました (HTTP ${resp.status})`);
  }
  return resp.json();
}
