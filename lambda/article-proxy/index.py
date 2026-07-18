"""
記事取得プロキシ Lambda
- ブラウザからのCORS制約を回避するため、サーバーサイドで記事URLをfetch
- レート制限、ドメインブロック、User-Agent設定済み
"""
import json
import os
import re
import hashlib
import time
from urllib.parse import urlparse

import boto3
import requests
from bs4 import BeautifulSoup

# 設定
MAX_CONTENT_LENGTH = 4000
REQUEST_TIMEOUT = 15
USER_AGENT = (
    'Mozilla/5.0 (compatible; CommentChannel/1.0; +https://comment-channel.example.com) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
)

# DynamoDB（レート制限用）
dynamodb = boto3.resource('dynamodb')
RATE_LIMIT_TABLE = os.environ.get('RATE_LIMIT_TABLE', 'CommentChannelRateLimit')

# ブロックドメインリスト
BLOCKED_DOMAINS = [
    'pornhub.com', 'xvideos.com', 'redtube.com', 'youporn.com',
    'onlyfans.com', 'fanza.jp', 'dmm.co.jp',
    '賭博', 'casino',
]

# ブロックパターン
BLOCKED_PATTERNS = [
    re.compile(r'porn', re.I),
    re.compile(r'adult', re.I),
    re.compile(r'xxx', re.I),
    re.compile(r'sex', re.I),
    re.compile(r'hentai', re.I),
    re.compile(r'erotic', re.I),
    re.compile(r'gambl', re.I),
    re.compile(r'casino', re.I),
    re.compile(r'bet365', re.I),
    re.compile(r'dark\s*web', re.I),
    re.compile(r'crime', re.I),
    re.compile(r'違法', re.I),
    re.compile(r'闇サイト', re.I),
]


def check_rate_limit(client_ip: str) -> bool:
    """レート制限チェック: 同IPから1時間に10回まで"""
    table = dynamodb.Table(RATE_LIMIT_TABLE)
    hour_key = f"{client_ip}:{int(time.time() / 3600)}"

    try:
        resp = table.update_item(
            Key={'pk': hour_key},
            UpdateExpression='ADD request_count :inc',
            ExpressionAttributeValues={':inc': 1},
            ReturnValues='UPDATED_NEW',
        )
        count = resp.get('Attributes', {}).get('request_count', 1)
        return count <= 10
    except Exception:
        # DynamoDBが使えない場合も通す（フェイルオープン）
        return True


def is_blocked_url(url: str) -> bool:
    """URLがブロック対象かチェック"""
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(url):
            return True
    domain = urlparse(url).netloc.lower()
    for blocked in BLOCKED_DOMAINS:
        if blocked in domain:
            return True
    return False


def extract_text_from_html(html: str) -> str:
    """HTMLから本文テキストを抽出"""
    soup = BeautifulSoup(html, 'lxml')

    # 不要要素の削除
    for tag in soup.find_all(['script', 'style', 'nav', 'footer', 'header',
                               'aside', 'noscript', 'iframe', 'form']):
        tag.decompose()

    # メインコンテンツの抽出を試みる
    main_selectors = [
        'article', '[role="main"]', 'main', '.article-body',
        '.articleBody', '#article-body', '.article_content',
        '.article__body', '.post-content', '.entry-content',
        '.article-detail', '#content', '.article', '.news-body',
    ]

    main_content = None
    for selector in main_selectors:
        main_content = soup.select_one(selector)
        if main_content:
            break

    target = main_content if main_content else soup.body if soup.body else soup

    text = target.get_text(separator='\n', strip=True)

    # 連続改行の圧縮
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()

    return text


def fetch_article(url: str) -> dict:
    """記事URLからタイトルと本文を取得"""
    try:
        resp = requests.get(
            url,
            headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,*/*'},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or 'utf-8'
        html = resp.text
    except requests.RequestException as e:
        raise Exception(f'記事の取得に失敗しました: {str(e)}')

    soup = BeautifulSoup(html, 'lxml')

    # タイトル抽出
    title = ''
    for selector in ['meta[property="og:title"]', 'title', 'h1']:
        tag = soup.select_one(selector)
        if tag:
            title = tag.get('content', '') or tag.get_text(strip=True)
            if title:
                break

    # 本文抽出
    text = extract_text_from_html(html)

    # ソース抽出
    source = urlparse(url).netloc.replace('www.', '')

    # 文字数制限
    if len(text) > MAX_CONTENT_LENGTH:
        text = text[:MAX_CONTENT_LENGTH]

    return {
        'title': title[:200] if title else '',
        'text': text,
        'source': source,
        'length': len(text),
    }


def lambda_handler(event, context):
    try:
        # CORS対応
        headers = {
            'Access-Control-Allow-Origin': 'https://comment-channel.okamomedia.tokyo',
            'Access-Control-Allow-Headers': 'Content-Type,X-Signature,X-Payload-Id',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Content-Type': 'application/json',
        }

        if event.get('httpMethod') == 'OPTIONS':
            return {'statusCode': 200, 'headers': headers, 'body': ''}

        # クライアントIP取得
        client_ip = (
            event.get('requestContext', {}).get('identity', {}).get('sourceIp', '')
            or event.get('headers', {}).get('X-Forwarded-For', 'unknown').split(',')[0].strip()
        )

        # レート制限
        if not check_rate_limit(client_ip):
            return {
                'statusCode': 429,
                'headers': headers,
                'body': json.dumps({'message': 'リクエスト制限を超えました。しばらく待ってからお試しください。'}, ensure_ascii=False),
            }

        # リクエストボディ
        body = json.loads(event.get('body', '{}'))
        url = body.get('url', '').strip()

        if not url:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'message': 'URLを指定してください'}, ensure_ascii=False),
            }

        # URLブロックチェック
        if is_blocked_url(url):
            return {
                'statusCode': 403,
                'headers': headers,
                'body': json.dumps({'message': 'このURLはブロックされています。アダルト・犯罪関連のURLはご利用いただけません。'}, ensure_ascii=False),
            }

        # 記事取得
        result = fetch_article(url)

        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(result, ensure_ascii=False),
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'message': str(e)}, ensure_ascii=False),
        }
