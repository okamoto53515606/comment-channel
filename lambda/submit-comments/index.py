"""
コメント投稿受付 Lambda
- HMAC-SHA256 署名検証
- DynamoDB への保存
- S3 にコメントページHTMLを生成
"""
import json
import os
import hashlib
import hmac
import time
import base64
import html
from datetime import datetime, timezone, timedelta

import boto3

# 設定
JST = timezone(timedelta(hours=9))
SIGNING_SECRET = os.environ.get('SIGNING_SECRET', 'dev-secret-change-in-production')
S3_BUCKET = os.environ.get('S3_BUCKET', 'comment-channel-pages')
DYNAMODB_TABLE = os.environ.get('DYNAMODB_TABLE', 'CommentChannelComments')
CLOUDFRONT_DOMAIN = os.environ.get('CLOUDFRONT_DOMAIN', 'd123.cloudfront.net')
MAX_BODY_SIZE = 5 * 1024 * 1024  # 5MB

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(DYNAMODB_TABLE)


def verify_signature(payload: str, signature: str) -> bool:
    """HMAC-SHA256署名検証（base64エンコード）"""
    expected = base64.b64encode(
        hmac.new(
            SIGNING_SECRET.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256,
        ).digest()
    ).decode('utf-8')

    # 比較（タイミング攻撃対策）
    return hmac.compare_digest(expected, signature)


def generate_comment_html(payload: dict) -> str:
    """コメントページのHTMLを生成"""
    data = payload
    article_url = html.escape(data.get('articleUrl', ''))
    article_preview = html.escape(data.get('articlePreview', ''))
    user_comment = html.escape(data.get('userComment', ''))
    comments = data.get('comments', [])
    generated_at = data.get('generatedAt', '')
    model_id = html.escape(data.get('modelId', ''))
    persona_count = data.get('personaCount', 0)
    usage = data.get('usage', {})
    summary = data.get('summary', '')

    # 日付整形
    try:
        dt = datetime.fromisoformat(generated_at.replace('Z', '+00:00'))
        jst_dt = dt.astimezone(JST)
        date_str = jst_dt.strftime('%Y/%m/%d %H:%M')
    except Exception:
        date_str = generated_at

    # コメントHTML生成
    comments_html = ''
    for i, c in enumerate(comments):
        p = c.get('persona', {})
        nickname = html.escape(p.get('nickname', '匿名'))
        flag = html.escape(p.get('countryFlag', ''))
        country = html.escape(p.get('countryName', ''))
        occupation = html.escape(p.get('occupation', ''))
        stance = html.escape(p.get('stance', ''))
        comment_text = html.escape(c.get('comment', ''))

        # スタンス表示
        stance_labels = {
            'agree': '👍 賛成', 'disagree': '👎 反対', 'neutral': '🤔 中立',
            'emotional': '😤 感情的', 'humorous': '😄 ユーモア',
            'academic': '📚 学術的', 'provocative': '🔥 挑発的', 'supportive': '🤝 共感的',
        }
        stance_label = stance_labels.get(stance, '')

        replies_html = ''
        replies = c.get('replies', [])
        if replies:
            replies_html = '<div class="replies">'
            for r in replies:
                rp = r.get('persona', {})
                r_nick = html.escape(rp.get('nickname', ''))
                r_flag = html.escape(rp.get('countryFlag', ''))
                r_comment = html.escape(r.get('comment', ''))
                r_to = html.escape(r.get('replyToNickname', ''))
                replies_html += f'''
                <div class="reply">
                    <div class="reply-header">
                        <span class="reply-nickname">{r_flag} {r_nick}</span>
                        <span class="reply-to">↪ {r_to} に返信</span>
                    </div>
                    <div class="reply-text">{r_comment}</div>
                </div>'''
            replies_html += '</div>'

        comments_html += f'''
        <div class="comment" id="comment-{i + 1}">
            <div class="comment-header">
                <span class="comment-icon">🤖</span>
                <span class="comment-nickname">{flag} {nickname}</span>
                <span class="comment-country">{country}</span>
                <span class="comment-occupation">{occupation}</span>
                <span class="comment-stance">{stance_label}</span>
                <span class="comment-number">#{i + 1}</span>
            </div>
            <div class="comment-body">{comment_text}</div>
            {replies_html}
        </div>'''

    html_content = f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>comment-channel — AI多様性コメント</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;background:#f8f9fa;color:#1a1a2e;line-height:1.7}}
.container{{max-width:720px;margin:0 auto;padding:1rem}}
header{{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:1.5rem 1rem;text-align:center}}
header h1{{font-size:1.3rem}}
.ai-notice{{background:#fef3c7;border:1px solid #fde68a;padding:.6rem 1rem;text-align:center;font-size:.8rem;font-weight:600;color:#92400e}}
.ai-notice-bottom{{background:#fef2f2;border:1px solid #fecaca;padding:.6rem 1rem;text-align:center;font-size:.8rem;color:#991b1b;margin-top:1.5rem}}
.article-info{{background:#fff;border-radius:12px;padding:1.2rem;margin:1rem 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.article-info h2{{font-size:1rem;margin-bottom:.5rem}}
.article-url{{font-size:.8rem;color:#6c757d;word-break:break-all}}
.article-preview{{font-size:.85rem;color:#4b5563;margin-top:.5rem;padding:.5rem;background:#f3f4f6;border-radius:6px}}
.summary-box{{background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:1rem;margin:1rem 0}}
.summary-box h3{{font-size:.9rem;color:#3730a3;margin-bottom:.4rem}}
.summary-box p{{font-size:.85rem;color:#1e1b4b}}
.comment-count{{text-align:center;font-size:.9rem;color:#6c757d;margin:1rem 0}}
.comment{{background:#fff;border-radius:12px;padding:1rem;margin-bottom:.8rem;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.comment-header{{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;margin-bottom:.5rem;font-size:.8rem}}
.comment-icon{{font-size:1rem}}
.comment-nickname{{font-weight:700;color:#4f46e5}}
.comment-country{{color:#6c757d}}
.comment-occupation{{color:#9ca3af;font-size:.75rem}}
.comment-stance{{background:#f3f4f6;padding:.1rem .4rem;border-radius:4px;font-size:.7rem}}
.comment-number{{margin-left:auto;color:#d1d5db;font-size:.75rem}}
.comment-body{{font-size:.9rem;line-height:1.6}}
.replies{{margin-top:.5rem;margin-left:1.2rem;padding-left:.8rem;border-left:2px solid #e5e7eb}}
.reply{{background:#f9fafb;border-radius:8px;padding:.6rem;margin-bottom:.4rem}}
.reply-header{{display:flex;gap:.4rem;font-size:.75rem;margin-bottom:.2rem}}
.reply-nickname{{font-weight:600;color:#4f46e5}}
.reply-to{{color:#9ca3af}}
.reply-text{{font-size:.8rem}}
footer{{text-align:center;padding:1.5rem;font-size:.78rem;color:#9ca3af;border-top:1px solid #e5e7eb;margin-top:2rem}}
.meta-info{{font-size:.75rem;color:#9ca3af;text-align:center;margin-top:.5rem}}
</style>
</head>
<body>
<header>
<h1>💬 comment-channel</h1>
<p style="font-size:.8rem;opacity:.9;margin-top:.25rem">AI多様性コメント — {persona_count}の視点</p>
</header>
<div class="ai-notice">
⚠️ このページのすべてのコメントは <strong>AI（{model_id}）によって生成</strong>されたものです。
実際の個人の意見ではありません。
</div>
<div class="container">
<div class="article-info">
<h2>📰 記事</h2>
<div class="article-url"><a href="{article_url}" target="_blank" rel="noopener">{article_url}</a></div>
<div class="article-preview">{article_preview}...</div>
<p class="meta-info">生成日時: {date_str} | モデル: {model_id}</p>
</div>
<div class="summary-box">
<h3>🤖 AIコメント要約</h3>
<p>{html.escape(summary) if summary else '要約の正確性や品質を保証するものではないため、コメント全文と併せてご確認ください。'}</p>
</div>
<div class="comment-count">💬 コメント <strong>{len(comments)}件</strong> | 返信 {sum(len(c.get('replies', [])) for c in comments)}件</div>
{comments_html}
<div class="ai-notice-bottom">
🤖 以上のコメントはすべてAIによって生成されたものであり、実在の人物・団体の意見を代表するものではありません。
</div>
</div>
<footer>
<p>comment-channel — AI-generated diverse perspectives</p>
<p style="margin-top:.25rem">All comments are AI-generated.</p>
</footer>
</body>
</html>'''

    return html_content


def lambda_handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': 'https://comment-channel.okamomedia.tokyo',
        'Access-Control-Allow-Headers': 'Content-Type,X-Signature,X-Payload-Id',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Content-Type': 'application/json',
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}

    try:
        body = event.get('body', '')

        # サイズチェック
        if len(body) > MAX_BODY_SIZE:
            return {
                'statusCode': 413,
                'headers': headers,
                'body': json.dumps({'message': 'データが大きすぎます'}, ensure_ascii=False),
            }

        # 署名検証
        signature = event.get('headers', {}).get('X-Signature', '')
        if not signature:
            # API Gateway がヘッダーを小文字に変換する場合あり
            signature = event.get('headers', {}).get('x-signature', '')

        if not verify_signature(body, signature):
            return {
                'statusCode': 403,
                'headers': headers,
                'body': json.dumps({'message': '署名が無効です'}, ensure_ascii=False),
            }

        payload = json.loads(body)
        payload_id = payload.get('id', '')

        if not payload_id:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'message': 'IDがありません'}, ensure_ascii=False),
            }

        # DynamoDB に保存（IPアドレスも記録）
        now = datetime.now(JST).isoformat()
        client_ip = (
            event.get('requestContext', {}).get('identity', {}).get('sourceIp', '')
            or event.get('headers', {}).get('X-Forwarded-For', 'unknown').split(',')[0].strip()
        )
        table.put_item(Item={
            'pk': f'COMMENT#{payload_id}',
            'sk': 'META',
            'payload': payload,
            'articleUrl': payload.get('articleUrl', ''),
            'clientIp': client_ip,
            'createdAt': now,
            'ttl': int((datetime.now(JST) + timedelta(days=365)).timestamp()),
        })

        # S3 にHTMLを生成
        html_content = generate_comment_html(payload)
        page_key = f'pages/{payload_id}.html'
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=page_key,
            Body=html_content.encode('utf-8'),
            ContentType='text/html; charset=utf-8',
            CacheControl='public, max-age=3600',
        )

        page_url = f'https://{CLOUDFRONT_DOMAIN}/{page_key}'

        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'status': 'ok',
                'id': payload_id,
                'pageUrl': page_url,
            }, ensure_ascii=False),
        }

    except json.JSONDecodeError:
        return {
            'statusCode': 400,
            'headers': headers,
            'body': json.dumps({'message': 'JSONの解析に失敗しました'}, ensure_ascii=False),
        }
    except Exception as e:
        print(f'Error: {e}')
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'message': str(e)}, ensure_ascii=False),
        }
