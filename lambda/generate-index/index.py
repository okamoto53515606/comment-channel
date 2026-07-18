"""
インデックスページ定期生成 Lambda
- DynamoDBから全コメントページをスキャン
- 月別インデックスページをS3に生成
- EventBridge Scheduler で定期実行（例: 1時間ごと）
"""
import json
import os
import html
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import boto3

JST = timezone(timedelta(hours=9))
S3_BUCKET = os.environ.get('S3_BUCKET', 'comment-channel-pages')
DYNAMODB_TABLE = os.environ.get('DYNAMODB_TABLE', 'CommentChannelComments')
CLOUDFRONT_DOMAIN = os.environ.get('CLOUDFRONT_DOMAIN', 'd123.cloudfront.net')

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(DYNAMODB_TABLE)
cloudfront = boto3.client('cloudfront')
DISTRIBUTION_ID = os.environ.get('CLOUDFRONT_DISTRIBUTION_ID', '')


def scan_all_pages():
    """DynamoDBから全ページをスキャン"""
    items = []
    last_key = None

    while True:
        kwargs = {}
        if last_key:
            kwargs['ExclusiveStartKey'] = last_key

        resp = table.scan(
            FilterExpression='sk = :sk',
            ExpressionAttributeValues={':sk': 'META'},
            **kwargs,
        )
        items.extend(resp.get('Items', []))
        last_key = resp.get('LastEvaluatedKey')
        if not last_key:
            break

    return items


def generate_index_html(pages: list, year_month: str = None) -> str:
    """インデックスページHTML生成"""
    # 月別にグループ化
    monthly = defaultdict(list)

    for item in pages:
        payload = item.get('payload', {})
        created = item.get('createdAt', '')
        page_id = item.get('pk', '').replace('COMMENT#', '')

        try:
            dt = datetime.fromisoformat(created.replace('Z', '+00:00'))
            ym = dt.strftime('%Y%m')
        except Exception:
            ym = 'unknown'

        article_url = payload.get('articleUrl', '')
        article_preview = payload.get('articlePreview', '')
        persona_count = payload.get('personaCount', 0)
        comment_count = len(payload.get('comments', []))

        monthly[ym].append({
            'id': page_id,
            'articleUrl': article_url,
            'articlePreview': article_preview,
            'personaCount': persona_count,
            'commentCount': comment_count,
            'createdAt': created,
        })

    # 降順ソート
    for ym in monthly:
        monthly[ym].sort(key=lambda x: x.get('createdAt', ''), reverse=True)

    # 全ページのHTML
    all_entries_html = ''
    for ym in sorted(monthly.keys(), reverse=True):
        entries = monthly[ym]
        entries_html = ''
        for entry in entries[:50]:  # 月あたり最大50件
            preview = html.escape(entry.get('articlePreview', '')[:100])
            article_url = html.escape(entry.get('articleUrl', ''))
            entries_html += f'''
            <li>
                <a href="/pages/{entry['id']}.html" class="entry-link">
                    <span class="entry-preview">{preview}...</span>
                    <span class="entry-meta">
                        💬 {entry['commentCount']}コメント ({entry['personaCount']}ペルソナ)
                    </span>
                </a>
            </li>'''

        all_entries_html += f'''
        <section class="month-section">
            <h2>📅 {ym[:4]}年{ym[4:]}月</h2>
            <ul class="entry-list">{entries_html}</ul>
        </section>'''

    total_pages = len(pages)
    total_comments = sum(
        len(item.get('payload', {}).get('comments', [])) for item in pages
    )

    html_content = f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>comment-channel — AI多様性コメント インデックス</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;background:#f8f9fa;color:#1a1a2e;line-height:1.7}}
.container{{max-width:720px;margin:0 auto;padding:1rem}}
header{{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:1.5rem 1rem;text-align:center}}
header h1{{font-size:1.5rem}}
.ai-notice{{background:#fef3c7;border:1px solid #fde68a;padding:.6rem 1rem;text-align:center;font-size:.8rem;font-weight:600;color:#92400e}}
.stats{{text-align:center;padding:1rem;font-size:.9rem;color:#6c757d}}
.month-section{{margin:1.5rem 0}}
.month-section h2{{font-size:1.1rem;color:#4f46e5;border-bottom:2px solid #e5e7eb;padding-bottom:.3rem;margin-bottom:.8rem}}
.entry-list{{list-style:none}}
.entry-list li{{margin-bottom:.5rem}}
.entry-link{{display:block;background:#fff;border-radius:8px;padding:.8rem 1rem;text-decoration:none;color:#1a1a2e;box-shadow:0 1px 3px rgba(0,0,0,.06);transition:box-shadow .15s}}
.entry-link:hover{{box-shadow:0 2px 8px rgba(0,0,0,.1)}}
.entry-preview{{display:block;font-size:.85rem;margin-bottom:.3rem}}
.entry-meta{{font-size:.75rem;color:#9ca3af}}
footer{{text-align:center;padding:1.5rem;font-size:.78rem;color:#9ca3af;border-top:1px solid #e5e7eb;margin-top:2rem}}
.no-entries{{text-align:center;padding:2rem;color:#9ca3af}}
</style>
</head>
<body>
<header>
<h1>💬 comment-channel</h1>
<p style="font-size:.85rem;opacity:.9;margin-top:.25rem">AI多様性コメント インデックス</p>
</header>
<div class="ai-notice">
⚠️ すべてのコメントは <strong>AIによって生成</strong>されたものです。実在の人物・団体の意見ではありません。
</div>
<div class="container">
<div class="stats">
📊 全 <strong>{total_pages}</strong> ページ | 💬 合計 <strong>{total_comments}</strong> 件のコメント
</div>
{all_entries_html if all_entries_html else '<div class="no-entries">まだコメントページがありません。</div>'}
</div>
<footer>
<p>comment-channel — AI-generated diverse perspectives</p>
</footer>
</body>
</html>'''

    return html_content


def invalidate_cloudfront(paths: list):
    """CloudFrontキャッシュ無効化"""
    if not DISTRIBUTION_ID:
        print('No CloudFront distribution ID, skipping invalidation')
        return

    try:
        cloudfront.create_invalidation(
            DistributionId=DISTRIBUTION_ID,
            InvalidationBatch={
                'Paths': {'Quantity': len(paths), 'Items': paths},
                'CallerReference': f'index-{datetime.now(JST).strftime("%Y%m%d%H%M%S")}',
            },
        )
    except Exception as e:
        print(f'CloudFront invalidation error: {e}')


def lambda_handler(event, context):
    try:
        # 全ページスキャン
        pages = scan_all_pages()
        print(f'Scanned {len(pages)} pages')

        # トップインデックス（アプリ本体のindex.htmlとは別パス）
        index_html = generate_index_html(pages)
        s3.put_object(
            Bucket=S3_BUCKET,
            Key='pages/index.html',
            Body=index_html.encode('utf-8'),
            ContentType='text/html; charset=utf-8',
            CacheControl='public, max-age=1800',
        )

        # 月別インデックス
        invalidate_paths = ['/pages/index.html']
        monthly_pages = defaultdict(list)
        for item in pages:
            try:
                dt = datetime.fromisoformat(
                    item.get('createdAt', '').replace('Z', '+00:00')
                )
                ym = dt.strftime('%Y%m')
            except Exception:
                continue
            monthly_pages[ym].append(item)

        for ym, ym_pages in monthly_pages.items():
            ym_html = generate_index_html(ym_pages)
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=f'{ym[:4]}/{ym[4:]}/index.html',
                Body=ym_html.encode('utf-8'),
                ContentType='text/html; charset=utf-8',
                CacheControl='public, max-age=1800',
            )
            invalidate_paths.append(f'/{ym[:4]}/{ym[4:]}/index.html')

        # CloudFrontキャッシュ無効化
        invalidate_cloudfront(invalidate_paths)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Generated index for {len(pages)} pages',
            }),
        }

    except Exception as e:
        print(f'Error: {e}')
        return {
            'statusCode': 500,
            'body': json.dumps({'message': str(e)}),
        }
