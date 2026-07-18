"""
管理用コメント削除 Lambda
- 指定された comment ID を DynamoDB から削除
- S3 上の HTML ファイルも削除
- インデックス再生成をトリガー
- CLI からの手動実行用（API Gateway 非公開）
"""
import json
import os
import boto3

S3_BUCKET = os.environ.get('S3_BUCKET', 'comment-channel-pages')
DYNAMODB_TABLE = os.environ.get('DYNAMODB_TABLE', 'CommentChannelComments')
INDEX_FUNCTION = os.environ.get('INDEX_FUNCTION', 'comment-channel-generate-index')
CLOUDFRONT_DISTRIBUTION_ID = os.environ.get('CLOUDFRONT_DISTRIBUTION_ID', '')

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
_lambda = boto3.client('lambda')
cloudfront = boto3.client('cloudfront')
table = dynamodb.Table(DYNAMODB_TABLE)


def delete_comment(comment_id: str) -> dict:
    """コメントを削除（DynamoDB + S3 + インデックス再生成）"""
    result = {'id': comment_id, 'deleted': []}

    # 1. DynamoDB から削除
    pk = f'COMMENT#{comment_id}'
    try:
        table.delete_item(Key={'pk': pk, 'sk': 'META'})
        result['deleted'].append('DynamoDB')
    except Exception as e:
        result['errors'] = result.get('errors', []) + [f'DynamoDB: {e}']

    # 2. S3 から HTML 削除
    page_key = f'pages/{comment_id}.html'
    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=page_key)
        result['deleted'].append(f'S3:{page_key}')
    except Exception as e:
        result['errors'] = result.get('errors', []) + [f'S3: {e}']

    # 3. CloudFront キャッシュ無効化
    if CLOUDFRONT_DISTRIBUTION_ID:
        try:
            cloudfront.create_invalidation(
                DistributionId=CLOUDFRONT_DISTRIBUTION_ID,
                InvalidationBatch={
                    'Paths': {'Quantity': 1, 'Items': [f'/{page_key}']},
                    'CallerReference': f'delete-{comment_id}',
                },
            )
            result['deleted'].append('CloudFrontCache')
        except Exception as e:
            result['errors'] = result.get('errors', []) + [f'CloudFront: {e}']

    # 4. インデックス再生成
    try:
        _lambda.invoke(FunctionName=INDEX_FUNCTION, InvocationType='Event')
        result['deleted'].append('IndexRegenerationTriggered')
    except Exception as e:
        result['errors'] = result.get('errors', []) + [f'IndexRegen: {e}']

    return result


def lambda_handler(event, context):
    """CLIまたは手動テストからの呼び出しのみ"""
    comment_id = None

    # event から comment_id を抽出（CLI invoke, test event 両対応）
    if isinstance(event, dict):
        comment_id = event.get('commentId') or event.get('comment_id') or event.get('id')

    if not comment_id:
        return {
            'statusCode': 400,
            'body': json.dumps({'message': 'commentId を指定してください', 'usage': 'aws lambda invoke ... --payload \'{"commentId":"xxx"}\' ...'}, ensure_ascii=False),
        }

    result = delete_comment(comment_id)
    return {
        'statusCode': 200,
        'body': json.dumps(result, ensure_ascii=False),
    }
