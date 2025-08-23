#!/bin/bash
# AWS CLI 同步脚本

# B2 配置
export AWS_ACCESS_KEY_ID="005872bacee5ccb0000000007"
export AWS_SECRET_ACCESS_KEY="K005wIU3DtFaIrvcjQoqybpntnbawsc"
export AWS_DEFAULT_REGION="us-east-1"
ENDPOINT="https://s3.us-east-005.backblazeb2.com"
BUCKET="pictoria"
BASE_DIR="collections"

# 上传同步
upload() {
    local LOCAL_DIR="$1"
    echo "🔄 Syncing $LOCAL_DIR to s3://$BUCKET/$BASE_DIR/"
    aws s3 sync "$LOCAL_DIR" "s3://$BUCKET/$BASE_DIR/" \
        --endpoint-url "$ENDPOINT" \
        --delete \
        --exclude ".*" \
        --exclude "*.tmp"
}

# 下载同步
download() {
    local LOCAL_DIR="$1"
    echo "🔄 Syncing s3://$BUCKET/$BASE_DIR/ to $LOCAL_DIR"
    aws s3 sync "s3://$BUCKET/$BASE_DIR/" "$LOCAL_DIR" \
        --endpoint-url "$ENDPOINT" \
        --delete
}

# 列出文件
list() {
    echo "📋 Listing files in s3://$BUCKET/$BASE_DIR/"
    aws s3 ls "s3://$BUCKET/$BASE_DIR/" --recursive \
        --endpoint-url "$ENDPOINT"
}

case "$1" in
    "upload")
        upload "${2:-./server/illustration}"
        ;;
    "download") 
        download "${2:-./server/illustration}"
        ;;
    "list")
        list
        ;;
    *)
        echo "Usage: $0 {upload|download|list} [directory]"
        echo "Examples:"
        echo "  $0 upload ./server/illustration"
        echo "  $0 download ./backup"
        echo "  $0 list"
        ;;
esac