#!/bin/bash
# ============================================
# comment-channel デプロイスクリプト
# ============================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_DIR/frontend"

STACK_NAME="comment-channel"
REGION="${AWS_REGION:-ap-northeast-1}"
SIGNING_SECRET="${CC_SIGNING_SECRET:-$(openssl rand -hex 32)}"

echo "============================================"
echo " comment-channel デプロイ"
echo " リージョン: $REGION"
echo " スタック名: $STACK_NAME"
echo "============================================"
echo ""

# ---- Step 1: SAMビルド ----
echo "[1/4] SAM ビルド..."
cd "$PROJECT_DIR"
sam build --region "$REGION"

# ---- Step 2: SAMデプロイ ----
echo "[2/4] SAM デプロイ..."
sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --parameter-overrides "SigningSecret=$SIGNING_SECRET" \
    --no-fail-on-empty-changeset

# ---- Step 3: 出力の取得 ----
echo "[3/4] CloudFormation 出力を取得..."
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
    --output text)

CLOUDFRONT_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" \
    --output text)

S3_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue" \
    --output text)

echo "  API Endpoint: $API_ENDPOINT"
echo "  CloudFront:   $CLOUDFRONT_URL"
echo "  S3 Bucket:    $S3_BUCKET"

# ---- Step 4: フロントエンドのアップロード ----
echo "[4/4] フロントエンドファイルをS3にアップロード..."

# APIエンドポイントを埋め込んだ設定ファイルを生成
CONFIG_JS="window.CC_API_BASE = '${API_ENDPOINT%/}';
window.CC_SIGNING_SECRET = '$SIGNING_SECRET';
window.CC_CLOUDFRONT_URL = 'https://${CLOUDFRONT_URL#https://}';"

echo "$CONFIG_JS" > "$FRONTEND_DIR/js/config.js"

# S3にアップロード
aws s3 sync "$FRONTEND_DIR" "s3://$S3_BUCKET/" \
    --region "$REGION" \
    --delete \
    --exclude "*.map" \
    --cache-control "public, max-age=3600"

echo ""
echo "============================================"
echo " ✅ デプロイ完了!"
echo ""
echo " 📄 入力ページ: https://${CLOUDFRONT_URL#https://}/index.html"
echo " 📊 インデックス: https://${CLOUDFRONT_URL#https://}/index.html"
echo ""
echo " 🔑 署名シークレット: $SIGNING_SECRET"
echo "    (config.js に埋め込み済み。フロントエンドのJSからは見えます)"
echo "============================================"
