"""
Sakana Namazu API プロキシ Lambda
- Sakana API がブラウザからの CORS をサポートしていないため、サーバーサイドで中継
- APIキーはこのLambdaを通過するが、保存・ログ出力は一切しない
- エンドポイントホワイトリスト + IP ベースレート制限あり
"""
import json
import os
import time

import boto3
import requests

SAKANA_API_BASE = 'https://api.sakana.ai'
REQUEST_TIMEOUT = 180  # Sakana Namazu の Web検索は複数回の reasoning + search で時間がかかる

# 許可するエンドポイント（ホワイトリスト）
ALLOWED_ENDPOINTS = {'/v1/responses'}

# DynamoDB（レート制限用）
dynamodb = boto3.resource('dynamodb')
RATE_LIMIT_TABLE = os.environ.get('RATE_LIMIT_TABLE', 'CommentChannelRateLimit')


def check_rate_limit(client_ip: str) -> bool:
    """レート制限チェック: 同IPから1時間に500回まで"""
    table = dynamodb.Table(RATE_LIMIT_TABLE)
    hour_key = f"llm-proxy:{client_ip}:{int(time.time() / 3600)}"

    try:
        resp = table.update_item(
            Key={'pk': hour_key},
            UpdateExpression='ADD request_count :inc',
            ExpressionAttributeValues={':inc': 1},
            ReturnValues='UPDATED_NEW',
        )
        count = resp.get('Attributes', {}).get('request_count', 1)
        return count <= 500
    except Exception:
        # DynamoDBが使えない場合も通す（フェイルオープン）
        return True


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
        return _response(429, {'error': 'Rate limit exceeded. Please try again later.'})
    payload = body.get('payload', {})

    # Sakana API を呼び出し（502/503 は1回だけリトライ）
    url = f'{SAKANA_API_BASE}{endpoint}'
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    }

    last_error = None
    for attempt in range(2):
        try:
            resp = requests.post(
                url,
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT,
            )
            # 502/503 はリトライ
            if resp.status_code in (502, 503) and attempt == 0:
                time.sleep(2)
                continue

            # Sakana がエラーレスポンスを返した場合、その内容をそのまま返す
            if not resp.ok:
                try:
                    sakana_error = resp.json()
                except Exception:
                    sakana_error = {'raw': resp.text[:1000]}
                return {
                    'statusCode': resp.status_code,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({
                        'error': f'Sakana API error ({resp.status_code})',
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
