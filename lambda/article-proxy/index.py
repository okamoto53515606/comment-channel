"""
記事取得プロキシ Lambda
- ブラウザからのCORS制約を回避するため、サーバーサイドで記事URLをfetch
- レート制限、ドメインブロック、User-Agent設定済み
- SSRF対策（内部アドレス拒否・リダイレクト再検証）、レスポンスサイズ上限あり
"""
import ipaddress
import json
import os
import re
import socket
import time
from urllib.parse import urljoin, urlparse

import boto3
import requests
from lxml import etree
from lxml import html as lxml_html

# 設定
MAX_CONTENT_LENGTH = 4000
MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 取得する HTML の上限（2MB）
MAX_REDIRECTS = 3
REQUEST_TIMEOUT = 15
ALLOWED_SCHEMES = ('http', 'https')
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
    """レート制限チェック: 同IPから1時間に50回まで"""
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
        return count <= 50
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


def _is_public_ip(ip_text: str) -> bool:
    """グローバル（外向き）IPアドレスかどうか"""
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return False
    return ip.is_global and not ip.is_multicast


def is_safe_url(url: str) -> bool:
    """SSRF対策: スキームと接続先ホスト（解決後IP）が安全かを確認"""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False

    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        return False

    host = (parsed.hostname or '').strip().strip('[]').lower()
    if not host:
        return False
    if (host == 'localhost' or host.endswith('.localhost')
            or host.endswith('.local') or host.endswith('.internal')):
        return False

    port = parsed.port or (443 if parsed.scheme.lower() == 'https' else 80)
    try:
        addr_info = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        return False

    if not addr_info:
        return False
    return all(_is_public_ip(info[4][0]) for info in addr_info)


def _fetch_html(url: str) -> bytes:
    """リダイレクトを自前で追跡し、各ホップでURLの安全性を再検証してHTMLを取得"""
    current = url

    for _ in range(MAX_REDIRECTS + 1):
        if not is_safe_url(current):
            raise ValueError('このURLは取得できません。内部ネットワークのアドレスは許可されていません。')

        with requests.get(
            current,
            headers={'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,*/*'},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=False,
            stream=True,
        ) as resp:
            if resp.is_redirect or 300 <= resp.status_code < 400:
                location = resp.headers.get('Location')
                if not location:
                    raise Exception(f'記事の取得に失敗しました: 不正なリダイレクト ({resp.status_code})')
                current = urljoin(current, location)
                continue

            resp.raise_for_status()

            content_length = resp.headers.get('Content-Length', '')
            if content_length.isdigit() and int(content_length) > MAX_RESPONSE_BYTES:
                raise ValueError('記事のサイズが大きすぎるため取得できません。')

            chunks = []
            total = 0
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ValueError('記事のサイズが大きすぎるため取得できません。')
                chunks.append(chunk)

            return b''.join(chunks)

    raise Exception('記事の取得に失敗しました: リダイレクトが多すぎます')


# 本文抽出時に除去するタグ
REMOVED_TAGS = ('script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe', 'form')
REMOVE_XPATH = '|'.join(f'//{tag}' for tag in REMOVED_TAGS)

# テキスト抽出時に改行を挿入するブロック要素
BLOCK_TAGS = {
    'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'br', 'dt', 'dd', 'figure', 'figcaption',
}


def _class_xpath(class_name: str) -> str:
    """class 名の完全一致で要素を探すXPath"""
    return ('//*[contains(concat(" ", normalize-space(@class), " "), " %s ")]' % class_name)


# 本文コンテナの候補（上から順に試す）
MAIN_XPATHS = [
    '//article',
    '//*[@role="main"]',
    '//main',
    _class_xpath('article-body'),
    _class_xpath('articleBody'),
    '//*[@id="article-body"]',
    _class_xpath('article_content'),
    _class_xpath('article__body'),
    _class_xpath('post-content'),
    _class_xpath('entry-content'),
    _class_xpath('article-detail'),
    '//*[@id="content"]',
    _class_xpath('article'),
    _class_xpath('news-body'),
]


def _extract_title(root) -> str:
    """ページタイトルを抽出"""
    for xpath in ('//meta[@property="og:title"]/@content', '//title//text()', '//h1//text()'):
        values = root.xpath(xpath)
        title = ''.join(v.strip() for v in values if v and v.strip()).strip()
        if title:
            return title
    return ''


def _extract_text(root) -> str:
    """要素ツリーから可視テキストを抽出（ブロック要素の境界で改行）"""
    parts = []

    def walk(el):
        # コメントノード等（tag が文字列でない）は本文に含めない
        tag = el.tag if isinstance(el.tag, str) else None
        if tag is not None and tag not in REMOVED_TAGS:
            if tag == 'br':
                parts.append('\n')
            if el.text:
                parts.append(el.text)
            for child in el:
                walk(child)
            if tag in BLOCK_TAGS:
                parts.append('\n')
        if el.tail:
            parts.append(el.tail)

    walk(root)

    lines = [line.strip() for line in ''.join(parts).splitlines()]
    text = '\n'.join(line for line in lines if line)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def extract_text_from_html(root) -> str:
    """HTML要素から本文テキストを抽出"""
    return _extract_text(root)


def fetch_article(url: str) -> dict:
    """記事URLからタイトルと本文を取得"""
    try:
        content = _fetch_html(url)
    except requests.RequestException as e:
        raise Exception(f'記事の取得に失敗しました: {str(e)}')

    try:
        root = lxml_html.fromstring(content)
    except (etree.ParserError, ValueError) as e:
        raise Exception(f'記事のHTMLを解析できませんでした: {str(e)}')

    # タイトル抽出
    title = _extract_title(root)

    # 不要要素の削除
    for el in root.xpath(REMOVE_XPATH):
        el.drop_tree()

    # メインコンテンツの抽出を試みる
    target = None
    for xpath in MAIN_XPATHS:
        found = root.xpath(xpath)
        if found:
            target = found[0]
            break

    if target is None:
        target = root.body if root.body is not None else root

    # 本文抽出
    text = extract_text_from_html(target)

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

        # SSRF・不正URLチェック（内部アドレスや非HTTPスキームを拒否）
        if not is_safe_url(url):
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'message': 'このURLは取得できません。http(s)の公開URLを指定してください。'}, ensure_ascii=False),
            }

        # 記事取得
        result = fetch_article(url)

        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(result, ensure_ascii=False),
        }

    except ValueError as e:
        return {
            'statusCode': 400,
            'headers': headers,
            'body': json.dumps({'message': str(e)}, ensure_ascii=False),
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'message': str(e)}, ensure_ascii=False),
        }
