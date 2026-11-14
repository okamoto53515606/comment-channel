"""
Sakana Namazu API プロキシ Lambda
- Sakana API がブラウザからの CORS をサポートしていないため、サーバーサイドで中継
- APIキーはこのLambdaを通過するが、保存・ログ出力は一切しない
- エンドポイントホワイトリスト + IP ベースレート制限あり
- Sakana 側の 429（レート制限）は待機してリトライする
"""
import json
import os
import time

import boto3
import requests

SAKANA_API_BASE = 'https://api.sakana.ai'
REQUEST_TIMEOUT = 180  # Sakana Namazu の Web検索は複数回の reasoning + search で時間がかかる

# リトライ設定
MAX_ATTEMPTS = 3
TRANSIENT_RETRY_DELAY = 2   # 502/503 時の待機秒数
MAX_RETRY_WAIT = 30         # 429 時に待ってよい上限秒数

# 許可するエンドポイント（ホワイトリスト）
ALLOWED_ENDPOINTS = {'/v1/responses'}

# DynamoDB（レート制限用）
dynamodb = boto3.resource('dynamodb')
RATE_LIMIT_TABLE = os.environ.get('RATE_LIMIT_TABLE', 'CommentChannelRateLimit')
RATE_LIMIT_PER_HOUR = int(os.environ.get('RATE_LIMIT_PER_HOUR', '1000'))
RATE_LIMIT_TTL_SECONDS = 2 * 3600


def check_rate_limit(client_ip: str) -> bool:
    """レート制限チェック: 同IPから1時間に RATE_LIMIT_PER_HOUR 回まで"""
    table = dynamodb.Table(RATE_LIMIT_TABLE)
    hour_key = f"llm-proxy:{client_ip}:{int(time.time() / 3600)}"

    try:
        resp = table.update_item(
            Key={'pk': hour_key},
            UpdateExpression='ADD request_count :inc SET #ttl = :ttl',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={
                ':inc': 1,
                ':ttl': int(time.time()) + RATE_LIMIT_TTL_SECONDS,
            },
            ReturnValues='UPDATED_NEW',
        )
        count = resp.get('Attributes', {}).get('request_count', 1)
        return count <= RATE_LIMIT_PER_HOUR
    except Exception:
        # DynamoDBが使えない場合も通す（フェイルオープン）
        return True


def _retry_after_seconds(value):
    """Retry-After ヘッダー（秒数）を解釈する"""
    if not value:
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def lambda_handler(event, context):
    """Function URL → Sakana API へ中継"""
    # CORS プリフライト (OPTIONS) — 実際の CORS ヘッダーは Function URL の Cors 設定が付与する
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'text/plain'},
            'body': '',
        }

    try:
        body = json.loads(event.get('body', '{}'))
    except json.JSONDecodeError:
        return _response(400, {'error': 'Invalid JSON body'})

    # 必須パラメータ
    api_key = body.get('apiKey', '').strip()
    if not api_key:
        return _response(400, {'error': 'apiKey is required'})

    endpoint = body.get('endpoint', '/v1/responses')

    # エンドポイントのホワイトリストチェック
    if endpoint not in ALLOWED_ENDPOINTS:
        return _response(403, {'error': f'Endpoint not allowed: {endpoint}'})

    # クライアントIPを取得してレート制限チェック
    client_ip = (
        event.get('requestContext', {}).get('http', {}).get('sourceIp', '')
        or event.get('headers', {}).get('x-forwarded-for', 'unknown').split(',')[0].strip()
    )
    if not check_rate_limit(client_ip):
        wait = max(60, 3600 - int(time.time()) % 3600)
        minutes = max(1, (wait + 59) // 60)
        return _response(429, {
            'error': 'Rate limit exceeded',
            'message': f'このサイト経由の1時間あたりのリクエスト上限（{RATE_LIMIT_PER_HOUR}回）に達しました。約{minutes}分後に再試行してください。',
            'retryAfter': wait,
        })
    payload = body.get('payload', {})

    # Sakana API を呼び出し（429 は待機してリトライ、502/503 は短い待機でリトライ）
    url = f'{SAKANA_API_BASE}{endpoint}'
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    }

    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            resp = requests.post(
                url,
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT,
            )

            # 429: Sakana 側のレート制限。待機してリトライする
            if resp.status_code == 429 and attempt < MAX_ATTEMPTS - 1:
                wait = _retry_after_seconds(resp.headers.get('Retry-After'))
                if wait is None:
                    wait = TRANSIENT_RETRY_DELAY * (attempt + 1)
                if wait <= MAX_RETRY_WAIT:
                    print(f'[llm-proxy] Sakana rate limited (429). retry in {wait}s')
                    time.sleep(wait)
                    continue

            # 502/503 は一時障害としてリトライ
            if resp.status_code in (502, 503) and attempt < MAX_ATTEMPTS - 1:
                time.sleep(TRANSIENT_RETRY_DELAY)
                continue

            # Sakana がエラーレスポンスを返した場合、内容とヒントを返す
            if not resp.ok:
                try:
                    sakana_error = resp.json()
                except Exception:
                    sakana_error = {'raw': resp.text[:1000]}

                # APIキーは含まれないため、原因究明用にステータスと本文のみ記録する
                print(f'[llm-proxy] Sakana error {resp.status_code}: '
                      f'{json.dumps(sakana_error, ensure_ascii=False)[:500]}')

                message = 'Sakana API がエラーを返しました。時間をおいて再試行してください。'
                if resp.status_code == 429:
                    message = ('Sakana API のレート制限に達しました。時間をおいて再試行するか、'
                               'ペルソナ人数を減らしてお試しください。')
                elif resp.status_code in (401, 403):
                    message = 'Sakana API の認証に失敗しました。APIキーをご確認ください。'

                return {
                    'statusCode': resp.status_code,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({
                        'error': f'Sakana API error ({resp.status_code})',
                        'message': message,
                        'sakana_response': sakana_error,
                    }, ensure_ascii=False),
                }

            # 正常レスポンス: 巨大な暗号化コンテンツを除去（ブラウザ転送量削減）
            sakana_response = resp.json()
            _strip_encrypted_content(sakana_response)
            return {
                'statusCode': resp.status_code,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(sakana_response, ensure_ascii=False),
            }
        except requests.exceptions.Timeout:
            last_error = _response(504, {'error': 'Sakana API request timed out'})
        except requests.exceptions.RequestException as e:
            last_error = _response(502, {'error': f'Sakana API connection error: {str(e)}'})
        except json.JSONDecodeError as e:
            last_error = _response(502, {'error': f'Sakana API returned invalid JSON: {str(e)}'})

    return last_error


def _strip_encrypted_content(obj):
    """再帰的に namazu_encrypted_content フィールドを除去（ブラウザ転送量削減のため）"""
    if isinstance(obj, dict):
        obj.pop('namazu_encrypted_content', None)
        for v in obj.values():
            _strip_encrypted_content(v)
    elif isinstance(obj, list):
        for item in obj:
            _strip_encrypted_content(item)


def _response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, ensure_ascii=False),
    }
